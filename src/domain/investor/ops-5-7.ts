/**
 * §5.7 ops — Delinquent loan status reporting (F-1-21 / D2-4-01; LL-2026-05 delinquency event rail).
 *
 * Owns the event vocabulary the 5.7 timer rows arm on and are satisfied by. Every function validates its input
 * (RangeError), appends the event(s) through the caller's `Emitter` and returns the projection; the bus tools in
 * src/app/tools/section5-7.ts are thin shells over these.
 *
 *   buildSnapshot          month-end snapshot → one `delinquency_report_lines.snapshot{periods_delinquent}` per loan in
 *                          the population (arms FNMA_LL202605_DQ_PMT_REMINDER_CD23 at 1 period delinquent) and
 *                          `delinquency_reports.snapshot_built` (satisfies FNMA_F121_DQ_SNAPSHOT_EOM; arms the D2-4-01 gate)
 *   transmitAmnFile        `delinquency_reports.submitted{ack, late}` + `delinquency_report_lines.submitted` per line
 *                          (FNMA_F121_DQ_REPORT_BD2; FNMA_F121_AW_ONE_MONTH per line)
 *   transmitCorrections    CD10 corrections with their B2B ack → `delinquency_reports.corrections_accepted`
 *                          (FNMA_F121_DQ_CORRECT_CD10)
 *   reconcileFinal         CD11 final report reconciled line by line → `delinquency_reports.final_reconciled{status}`
 *                          (FNMA_F121_DQ_FINAL_CD11 on `status=final`, i.e. zero critical exceptions)
 *   fileConsistency        rule 7 before submission → `delinquency_reports.consistency_checked{errors}`
 *                          (SM_DQ_SMDU_DRA_CONSISTENCY_BD1 on `errors=0`); blocked lines escalate before BD2
 *   recordDelinquencyAction a §11/12/13/14 action processed → `delinquency.action.processed{processed_at}`
 *                          (arms FNMA_LL202605_DQ_EVENT_NEXTBD_0300: next fannie_et BD 03:00 ET)
 *   submitDelinquencyEvent the Servicing Platform delinquency event (rule 6 fatal rules) → `delinquency_events.submitted`
 *   ingestEventResponse    the platform's response → `delinquency_events.accepted{servicer_action_type}` / `.rejected`
 *   ingestConnectReport    Fannie Mae Connect report availability (exception / final / eligible-for-deselection) →
 *                          `fnma.connect.report.available{report}` (arms FNMA_F125_RECLASS_DESELECT_CD15 for 5.4)
 *   recordReclassDeselection the deselection decision → `reclass.deselection.decided`
 *
 * Period-level events carry the report's aggregate `{kind: "period", id: "<servicer>:<period>"}` (the shape 5.1's
 * `period.month_end` uses) or `{kind: "period", id: "<period>"}` when no servicer number is given, so the period timers
 * armed by `period.month_end` and satisfied here share a subject. Loan-level events carry `loanId`.
 */
import { parts, ymd, type PlainDate } from "../../kernel/calendar/date.ts";
import { rollBack, fannieEt } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, toIso, wallClock } from "../../kernel/calendar/zoned.ts";
import type { EventStore, DomainEvent, Actor } from "../../kernel/events/index.ts";
import { ET, amnTransmission, reconcileFinalReport, lineReviewFlag, consistencyBlock, type DqException } from "./ops.ts";
import { statusLine, inPopulation, consistencyErrors, validateF121Layout, type LoanStatusFacts, type StatusLine } from "./delinquency-status.ts";
import { period as periodOf, nextMonth, bd2CloseMs, eventDeadlineMs } from "./period.ts";
import type { ChannelMode } from "./types.ts";

export interface Emitter { readonly events: EventStore; readonly actor: Actor; readonly now: string; }
export type Subject = { readonly kind: "period"; readonly id: string };
export const RULE_SET_VERSION = "fnma.f121.codes.2023-10+fnma.se.delinquency.v1";

const isPeriod = (p: string): boolean => /^\d{4}-\d{2}$/.test(p);
const need = (cond: boolean, what: string): void => { if (!cond) throw new RangeError(what); };
/** The report's aggregate: `{kind: "period", id: "<servicer>:<period>"}` (5.1's shape) or `{kind: "period", id: "<period>"}`. */
export function reportSubject(period: string, servicerNumber?: string | null): Subject {
  need(isPeriod(period), `period ${period} must be YYYY-MM`);
  if (servicerNumber) need(/^\d{9}$/.test(servicerNumber), "servicer_number must be the 9-digit Fannie Mae servicer number");
  return { kind: "period", id: servicerNumber ? `${servicerNumber}:${period}` : period };
}

// ───── month-end snapshot ─────
/** `fnma_delinquency_status` (LPI-based, MBA convention) → periods delinquent: the installment due on the 1st unpaid at month-end is one period. */
export const PERIODS_DELINQUENT: Record<LoanStatusFacts["fnma_delinquency_status"], number> = { current: 0, "30": 1, "60": 2, "90": 3, "120+": 4 };
export interface SnapshotLoan { readonly loan_id: string; readonly facts: LoanStatusFacts; readonly fnma_loan_number?: string | null; }
export interface SnapshotResult { readonly period: string; readonly subject: Subject; readonly population: string[]; readonly record_count: number; readonly loans_with_management_action: string[]; readonly lines: { loan_id: string; line: StatusLine | null; periods_delinquent: number }[]; }
/** Rule 1 population at month-end: 30+ days delinquent, plus every loan with a delinquency-management action in the month even if current (D2-4-01). */
export function buildSnapshot(em: Emitter, i: { readonly period: string; readonly loans: readonly SnapshotLoan[]; readonly servicer_number?: string | null; readonly as_of_ms?: number }): SnapshotResult {
  need(Array.isArray(i.loans) && i.loans.length > 0, "loans must be a non-empty array");
  const subject = reportSubject(i.period, i.servicer_number);
  const occurredAt = i.as_of_ms !== undefined ? toIso(i.as_of_ms) : em.now;
  const pop = i.loans.filter((l) => inPopulation(l.facts));
  const withAction = i.loans.filter((l) => l.facts.actions.length > 0).map((l) => l.loan_id);
  const lines = pop.map((l) => {
    need(typeof l.loan_id === "string" && l.loan_id !== "", "every snapshot loan needs a loan_id");
    const line = statusLine(l.facts); const periods = PERIODS_DELINQUENT[l.facts.fnma_delinquency_status];
    need(periods !== undefined, `fnma_delinquency_status ${String(l.facts.fnma_delinquency_status)} is not one of current/30/60/90/120+`);
    em.events.append({ type: "delinquency_report_lines.snapshot", loanId: l.loan_id, aggregate: subject, actor: em.actor, occurredAt,
      payload: { period: i.period, loan_id: l.loan_id, fnma_loan_number: l.fnma_loan_number ?? null, status_code: line?.status ?? null, reason_code: line?.reason ?? null, effective_date: line?.effective ?? null, completion_date: line?.completion ?? null,
        fnma_delinquency_status: l.facts.fnma_delinquency_status, periods_delinquent: periods, management_action: l.facts.actions.length > 0, evidence_event_ids: l.facts.actions.map((a) => a.evidence_event_id ?? null) } });
    return { loan_id: l.loan_id, line, periods_delinquent: periods };
  });
  em.events.append({ type: "delinquency_reports.snapshot_built", aggregate: subject, actor: em.actor, occurredAt,
    payload: { period: i.period, servicer_number: i.servicer_number ?? null, record_count: pop.length, loans_in_file: pop.map((l) => l.loan_id), loans_with_management_action: withAction, rule_set_version: RULE_SET_VERSION } });
  return { period: i.period, subject, population: pop.map((l) => l.loan_id), record_count: pop.length, loans_with_management_action: withAction, lines };
}

// ───── AMN file transmission and corrections ─────
export interface AmnLine { readonly loan_id: string; readonly status: string; readonly reason?: string | null; readonly effective?: string; readonly completion?: string; readonly confidence?: number; readonly fnma_loan_number?: string | null; readonly forbearance?: StatusLine["forbearance"]; }
export type Channel = "amn_b2b" | "amn_upload" | "se_api" | "se_csv";
const CHANNELS: readonly Channel[] = ["amn_b2b", "amn_upload", "se_api", "se_csv"];
const channelOf = (c: string | undefined | null): Channel => { const v = c || "amn_b2b"; need((CHANNELS as readonly string[]).includes(v), `channel ${v} is not one of ${CHANNELS.join("/")}`); return v as Channel; };
const amnLinesOf = (lines: unknown): AmnLine[] => { need(Array.isArray(lines), "lines must be an array"); return (lines as unknown[]).filter((l): l is AmnLine => !!l && typeof l === "object" && typeof (l as AmnLine).loan_id === "string" && typeof (l as AmnLine).status === "string"); };
export interface Transmission { readonly period: string; readonly subject: Subject; readonly due_ms: number; readonly late: boolean; readonly escalation: "officer" | null; readonly compfee_instance: ReturnType<typeof amnTransmission>["compfee_instance"]; readonly sentinel_line: string | null; readonly lines_submitted: number; readonly flagged_for_review: { loan_id: string; status: string; review_before_ms: number; correction_by_ms: number }[]; readonly event: DomainEvent; }
/** F-1-21: the file is due BD2 17:00 ET (`fannie_et`); the B2B ack (or the operator's upload confirmation) is the `ack` the BD2 timer needs; later than BD2 sets `late` for the `officer` compensatory-fee escalation. */
export function transmitAmnFile(em: Emitter, i: { readonly period_month: PlainDate; readonly lines: readonly AmnLine[]; readonly record_count?: number; readonly transmitted_at_ms: number; readonly ack: string; readonly channel?: string | null; readonly servicer_number?: string | null; readonly document_id?: string | null }): Transmission {
  need(typeof i.ack === "string" && i.ack.trim() !== "", "ack is required: the B2B acknowledgement (or the AMN upload confirmation) evidences the submission (F-1-21)");
  const lines = amnLinesOf(i.lines); const period = periodOf(i.period_month); const subject = reportSubject(period, i.servicer_number);
  const count = i.record_count ?? lines.length; need(Number.isInteger(count) && count > 0, "record_count must be a positive integer (an empty delinquency file is not a report)");
  const channel = channelOf(i.channel);
  const t = amnTransmission({ period_month: i.period_month, transmitted_at_ms: i.transmitted_at_ms, record_count: count });
  const transmitted_at = toIso(i.transmitted_at_ms);
  const event = em.events.append({ type: "delinquency_reports.submitted", aggregate: subject, actor: em.actor, occurredAt: transmitted_at,
    payload: { period, servicer_number: i.servicer_number ?? null, channel, late: t.late, record_count: count, transmitted_at, ack: i.ack, ack_status: "acknowledged", document_id: i.document_id ?? null, due_at: toIso(t.due_ms), status: "submitted" } });
  const flagged: Transmission["flagged_for_review"] = [];
  for (const l of lines) {
    em.events.append({ type: "delinquency_report_lines.submitted", loanId: l.loan_id, aggregate: subject, actor: em.actor, occurredAt: transmitted_at, payload: { period, status_code: l.status, reason_code: l.reason ?? null, effective_date: l.effective ?? null, completion_date: l.completion ?? null, correction: false } });
    if (typeof l.confidence === "number") { const r = lineReviewFlag({ confidence: l.confidence, period_month: i.period_month }); if (r.flagged) flagged.push({ loan_id: l.loan_id, status: l.status, review_before_ms: r.review_before_ms, correction_by_ms: r.correction_by_ms }); }
  }
  return { period, subject, due_ms: t.due_ms, late: t.late, escalation: t.escalation, compfee_instance: t.compfee_instance, sentinel_line: t.sentinel_line, lines_submitted: lines.length, flagged_for_review: flagged, event };
}
/** CD10 17:00 ET (the published calendar date rolled back to the preceding `fannie_et` BD) — the correction deadline of rule 8. */
export function correctionsDueMs(periodMonth: PlainDate, publishedCd10?: PlainDate | null): number {
  const { y, m } = parts(nextMonth(periodMonth));
  return zonedEpochMs(rollBack(publishedCd10 ?? ymd(y, m, 10), fannieEt), "17:00", ET);
}
/** Rule 8: critical exceptions corrected and retransmitted by CD10; "transmitted and accepted" = the correction file's ack. */
export function transmitCorrections(em: Emitter, i: { readonly period_month: PlainDate; readonly lines: readonly (AmnLine & { readonly exception_code?: string | null })[]; readonly ack: string; readonly transmitted_at_ms: number; readonly published_cd10?: PlainDate | null; readonly channel?: string | null; readonly servicer_number?: string | null }): { period: string; subject: Subject; due_ms: number; late: boolean; corrected: string[]; event: DomainEvent } {
  need(typeof i.ack === "string" && i.ack.trim() !== "", "ack is required: corrections count only once Fannie Mae has accepted the retransmission (F-1-21)");
  const lines = amnLinesOf(i.lines) as (AmnLine & { readonly exception_code?: string | null })[]; need(lines.length > 0, "corrections need at least one corrected line");
  const period = periodOf(i.period_month); const subject = reportSubject(period, i.servicer_number); const channel = channelOf(i.channel);
  for (const l of lines) {
    const errors = validateF121Layout({ status: l.status, reason: l.reason ?? "", effective: l.effective ?? "        ", completion: l.completion ?? "        ", ...(l.forbearance ? { forbearance: l.forbearance } : {}) });
    need(errors.length === 0, `corrected line for ${l.loan_id} still fails F-1-21 validation: ${errors.join("; ")}`);
  }
  const due = correctionsDueMs(i.period_month, i.published_cd10); const late = i.transmitted_at_ms > due; const transmitted_at = toIso(i.transmitted_at_ms);
  for (const l of lines) em.events.append({ type: "delinquency_report_lines.submitted", loanId: l.loan_id, aggregate: subject, actor: em.actor, occurredAt: transmitted_at, payload: { period, status_code: l.status, reason_code: l.reason ?? null, effective_date: l.effective ?? null, completion_date: l.completion ?? null, forbearance: l.forbearance ?? null, correction: true, exception_code: l.exception_code ?? null } });
  const event = em.events.append({ type: "delinquency_reports.corrections_accepted", aggregate: subject, actor: em.actor, occurredAt: transmitted_at,
    payload: { period, servicer_number: i.servicer_number ?? null, channel, ack: i.ack, record_count: lines.length, corrected_loans: lines.map((l) => l.loan_id), corrections_submitted_at: transmitted_at, due_at: toIso(due), late, status: "corrected" } });
  return { period, subject, due_ms: due, late, corrected: lines.map((l) => l.loan_id), event };
}
/** Rule 8: the CD11 final report is reconciled line by line to `delinquency_report_lines`; `final` only with zero critical exceptions and no mismatched line. */
export function reconcileFinal(em: Emitter, i: { readonly period_month: PlainDate; readonly lines: readonly { loan_id: string; status_code: string }[]; readonly final: readonly { loan_id: string; status_code: string; exception: string | null }[]; readonly document_id?: string | null; readonly received_at_ms?: number; readonly servicer_number?: string | null }): { period: string; subject: Subject; critical_remaining: number; mismatched: string[]; status: "final" | "exceptions_open"; event: DomainEvent } {
  need(Array.isArray(i.lines) && i.lines.length > 0, "lines (the submitted report lines) must be a non-empty array");
  need(Array.isArray(i.final), "final (the CD11 final report rows) must be an array");
  const period = periodOf(i.period_month); const subject = reportSubject(period, i.servicer_number);
  const r = reconcileFinalReport({ lines: i.lines, final: i.final });
  const event = em.events.append({ type: "delinquency_reports.final_reconciled", aggregate: subject, actor: em.actor, ...(i.received_at_ms !== undefined ? { occurredAt: toIso(i.received_at_ms) } : {}),
    payload: { period, servicer_number: i.servicer_number ?? null, final_report_document_id: i.document_id ?? null, critical_remaining: r.critical_remaining, mismatched: r.mismatched, lines_reconciled: i.lines.length, status: r.status } });
  return { period, subject, ...r, event };
}

// ───── rule 7 consistency checks ─────
const BK_CODES = new Set(["65", "66", "67", "59", "69", "3L", "3M"]);
const SMDU_CODES = new Set(["09", "12", "BF"]);
export interface ExternalStatus { readonly smdu_case_status?: string | null; readonly dra_sale_date?: PlainDate | null; readonly pacer_chapter?: string | null; }
/** Rule 7: SMDU case status for 09/12/BF; DRA/P360 sale date for 71; PACER chapter for bankruptcy codes; 43 requires `foreclosure.referral.sent` (E-1.2-02). */
export function lineConsistencyErrors(f: LoanStatusFacts, line: StatusLine, ext: ExternalStatus = {}): string[] {
  const errors = consistencyErrors(f, line);
  if (SMDU_CODES.has(line.status) && ext.smdu_case_status && ext.smdu_case_status !== "active") errors.push(`${line.status} but SMDU case status is ${ext.smdu_case_status}`);
  if (line.status === "71" && ext.dra_sale_date && ext.dra_sale_date.replaceAll("-", "") !== line.effective) errors.push(`71 effective ${line.effective} does not match the DRA/P360 scheduled sale date ${ext.dra_sale_date}`);
  if (BK_CODES.has(line.status) && ext.pacer_chapter) { const bk = f.actions.find((a) => a.kind === "bankruptcy"); if (bk?.chapter !== ext.pacer_chapter) errors.push(`${line.status} reported for chapter ${bk?.chapter ?? "none"} but PACER shows chapter ${ext.pacer_chapter}`); }
  return errors;
}
export interface ConsistencyInput { readonly loan_id: string; readonly facts: LoanStatusFacts; readonly smdu_case_status?: string | null; readonly dra_sale_date?: PlainDate | null; readonly pacer_chapter?: string | null; }
export interface ConsistencyResult { readonly period: string; readonly subject: Subject; readonly errors: number; readonly checked: number; readonly results: { loan_id: string; line: StatusLine | null; errors: string[]; blocked: boolean; escalation: ReturnType<typeof consistencyBlock>["escalation"] }[]; readonly blocked_loans: string[]; readonly event: DomainEvent; }
/** The pre-submission consistency check over the file: each failing line is blocked and escalated (sev-2) before BD2 17:00 ET; `errors=0` is what SM_DQ_SMDU_DRA_CONSISTENCY_BD1 needs. */
export function fileConsistency(em: Emitter, i: { readonly period_month: PlainDate; readonly lines: readonly ConsistencyInput[]; readonly servicer_number?: string | null }): ConsistencyResult {
  need(Array.isArray(i.lines) && i.lines.length > 0, "lines must be a non-empty array of {loan_id, facts}");
  const period = periodOf(i.period_month); const subject = reportSubject(period, i.servicer_number);
  const results = i.lines.map((l) => {
    need(typeof l.loan_id === "string" && l.loan_id !== "" && !!l.facts && Array.isArray(l.facts.actions), "every line needs loan_id and facts (LoanStatusFacts)");
    const line = statusLine(l.facts); const errors = line ? lineConsistencyErrors(l.facts, line, l) : [];
    const b = consistencyBlock({ loan_id: l.loan_id, period_month: i.period_month, errors });
    em.events.append({ type: "delinquency_report_lines.consistency_checked", loanId: l.loan_id, aggregate: subject, actor: em.actor, payload: { period, status_code: line?.status ?? null, errors: errors.length, detail: errors, blocked: b.blocked } });
    return { loan_id: l.loan_id, line, errors, blocked: b.blocked, escalation: b.escalation };
  });
  const total = results.reduce((n, r) => n + r.errors.length, 0); const blocked = results.filter((r) => r.blocked).map((r) => r.loan_id);
  const event = em.events.append({ type: "delinquency_reports.consistency_checked", aggregate: subject, actor: em.actor, payload: { period, servicer_number: i.servicer_number ?? null, checked: results.length, errors: total, blocked_loans: blocked, escalate_before: toIso(bd2CloseMs(nextMonth(i.period_month))) } });
  return { period, subject, errors: total, checked: results.length, results, blocked_loans: blocked, event };
}

// ───── LL-2026-05 delinquency event rail ─────
/** The nine Servicer Action Types of the Servicing Platform delinquency event (LL-2026-05 / Reference Guide v1.0) and the legacy AMN code the action alone maps to (F-1-21). */
export const SERVICER_ACTION_TYPES = {
  payment_reminder_notice: { type: "Payment Reminder Notice", amn_status: null, requires_reason: false },
  outbound_contact_attempted: { type: "Outbound Contact Attempted", amn_status: null, requires_reason: false },
  qrpc_achieved: { type: "Quality Right Party Contact", amn_status: "AW", requires_reason: true },
  borrower_solicitation_package: { type: "Borrower Solicitation Package", amn_status: null, requires_reason: false },
  breach_letter_sent: { type: "Breach Letter Sent", amn_status: "80", requires_reason: false },
  workout_option_solicitation: { type: "Workout Option Solicitation", amn_status: null, requires_reason: false },
  brp_received: { type: "Borrower Response Package Received", amn_status: "H5", requires_reason: false },
  referred_to_foreclosure: { type: "Referred to Foreclosure", amn_status: "43", requires_reason: false },
  modification_denial_under_appeal: { type: "Modification Denial Under Appeal", amn_status: null, requires_reason: true },
} as const;
export type DqAction = keyof typeof SERVICER_ACTION_TYPES;
export const isDqAction = (a: string): a is DqAction => Object.hasOwn(SERVICER_ACTION_TYPES, a);
const actionOf = (a: string): DqAction => { need(isDqAction(a), `action ${a || "(none)"} is not one of ${Object.keys(SERVICER_ACTION_TYPES).join("/")}`); return a as DqAction; };
const modeOf = (m: string | undefined | null): ChannelMode => { const v = m || "dual"; need(v === "legacy" || v === "dual" || v === "event", `mode ${v} is not legacy/dual/event`); return v as ChannelMode; };
export const eventEnv = (mode: ChannelMode): "api-clve" | "production" | null => (mode === "legacy" ? null : mode === "dual" ? "api-clve" : "production");
/** Delinquency Status Types (≤5) — the sets the fatal rules treat as conflicting. */
export const STATUS_TYPE_SETS = {
  transfer: ["Assumption Exempt", "Assumption Non-Exempt", "Refinance", "Assignment"],
  bankruptcy: ["Chapter 7 Bankruptcy", "Chapter 11 Bankruptcy", "Chapter 12 Bankruptcy", "Chapter 13 Bankruptcy"],
  foreclosure: ["Contested/Litigated Foreclosure", "Pre-file Mediation/Mediation", "Title Issue in Progress", "Partial Reinstatement"],
} as const;
/** Delinquency Reason Types (≤5) — the mutually exclusive property set and the reason that cannot pair. */
export const REASON_TYPE_RULES = { exclusive: ["Property Problem", "Disaster Impact – FEMA-declared IA area", "Casualty Loss"], alone: "Borrower Declined to Provide a Reason" } as const;
const strings = (v: unknown, what: string): string[] => { if (v === undefined || v === null) return []; need(Array.isArray(v) && v.every((x) => typeof x === "string"), `${what} must be an array of strings`); return v as string[]; };
/** Rule 6: status types carry the concurrent conditions; a foreclosure status alongside a bankruptcy status is a foreclosure-vs-bankruptcy conflict → only the bankruptcy status is reported. */
export function deriveEventStatusTypes(types: readonly string[]): { status_types: string[]; dropped: string[] } {
  const hasBk = types.some((t) => (STATUS_TYPE_SETS.bankruptcy as readonly string[]).includes(t));
  const dropped = hasBk ? types.filter((t) => (STATUS_TYPE_SETS.foreclosure as readonly string[]).includes(t)) : [];
  return { status_types: types.filter((t) => !dropped.includes(t)), dropped };
}
/** The fatal rules of the delinquency event (LL-2026-05): counts, reason conflicts, status conflicts, reason-required actions. */
export function validateDelinquencyEvent(i: { readonly action: DqAction; readonly status_types: readonly string[]; readonly reason_types: readonly string[]; readonly prior_reason_reported?: boolean }): string[] {
  const fatal: string[] = [];
  if (i.status_types.length > 5) fatal.push("more than five Delinquency Status Types");
  if (i.reason_types.length > 5) fatal.push("more than five Delinquency Reason Types");
  const excl = i.reason_types.filter((r) => (REASON_TYPE_RULES.exclusive as readonly string[]).includes(r)); if (excl.length > 1) fatal.push(`reason types ${excl.join(" + ")} are mutually exclusive`);
  if (i.reason_types.includes(REASON_TYPE_RULES.alone) && i.reason_types.length > 1) fatal.push(`"${REASON_TYPE_RULES.alone}" cannot pair with another reason type`);
  const transfer = i.status_types.filter((s) => (STATUS_TYPE_SETS.transfer as readonly string[]).includes(s)); if (transfer.length > 1) fatal.push(`status types ${transfer.join(" + ")} conflict (assumption/refinance/assignment)`);
  const bk = i.status_types.filter((s) => (STATUS_TYPE_SETS.bankruptcy as readonly string[]).includes(s)); if (bk.length > 1) fatal.push(`status types ${bk.join(" + ")} conflict (one bankruptcy chapter)`);
  if (bk.length && i.status_types.some((s) => (STATUS_TYPE_SETS.foreclosure as readonly string[]).includes(s))) fatal.push("foreclosure status alongside a bankruptcy status (foreclosure vs bankruptcy conflict)");
  if (SERVICER_ACTION_TYPES[i.action].requires_reason && i.reason_types.length === 0 && !i.prior_reason_reported) fatal.push(`${SERVICER_ACTION_TYPES[i.action].type} requires an existing Delinquency Reason Type`);
  return fatal;
}
export interface ActionRecord { readonly loan_id: string; readonly action: DqAction; readonly servicer_action_type: string; readonly processed_at_ms: number; readonly submit_by_ms: number; readonly mode: ChannelMode; readonly env: "api-clve" | "production" | null; readonly amn_line: { status: string; effective: string; completion: string } | null; readonly event: DomainEvent; }
/** A §11/12/13/14 servicing action processed (QRPC, breach letter, referral, BRP received, …) → `delinquency.action.processed`; reported the same day, no later than 03:00 ET on the next business day (LL-2026-05). */
export function recordDelinquencyAction(em: Emitter, i: { readonly loan_id: string; readonly action: string; readonly source_event_id: string; readonly processed_at_ms: number; readonly mode?: string | null }): ActionRecord {
  need(typeof i.loan_id === "string" && i.loan_id !== "", "loan_id is required");
  const action = actionOf(i.action); const mode = modeOf(i.mode);
  need(typeof i.source_event_id === "string" && i.source_event_id !== "", "source_event_id is required: a delinquency action is never reported without the evidence event id (5.7 guardrail)");
  need(Number.isFinite(i.processed_at_ms), "processed_at must be a timestamp");
  const a = SERVICER_ACTION_TYPES[action]; const processed_at = toIso(i.processed_at_ms); const submit_by_ms = eventDeadlineMs(i.processed_at_ms);
  const amn_line = a.amn_status ? { status: a.amn_status, effective: wallClock(i.processed_at_ms, ET).date.replaceAll("-", ""), completion: "        " } : null;
  const event = em.events.append({ type: "delinquency.action.processed", loanId: i.loan_id, actor: em.actor, occurredAt: processed_at,
    payload: { loan_id: i.loan_id, action, servicer_action_type: a.type, source_event_id: i.source_event_id, processed_at, submit_by: toIso(submit_by_ms), mode, env: eventEnv(mode), amn_status: a.amn_status, amn_effective_date: amn_line?.effective ?? null } });
  return { loan_id: i.loan_id, action, servicer_action_type: a.type, processed_at_ms: i.processed_at_ms, submit_by_ms, mode, env: eventEnv(mode), amn_line, event };
}
export interface DqEventSubmission { readonly loan_id: string; readonly action: DqAction; readonly servicer_action_type: string; readonly status_types: string[]; readonly dropped_status_types: string[]; readonly reason_types: string[]; readonly env: "api-clve" | "production"; readonly submit_by_ms: number; readonly submitted_at_ms: number; readonly on_time: boolean; readonly submission_id: string; readonly per_loan_sequence: number; readonly amn_line: { status: string; effective: string; completion: string } | null; readonly event: DomainEvent; }
/** The delinquency event itself (`fnma-servicing-events`): one Servicer Action Type, ≤5 status types, ≤5 reason types, fatal rules enforced locally → `delinquency_events.submitted`. */
export function submitDelinquencyEvent(em: Emitter, i: { readonly loan_id: string; readonly action: string; readonly processed_at_ms: number; readonly submitted_at_ms?: number; readonly mode?: string | null; readonly status_types?: unknown; readonly reason_types?: unknown; readonly prior_reason_reported?: boolean; readonly submission_id?: string | null; readonly per_loan_sequence?: number; readonly action_event_id?: string | null }): DqEventSubmission {
  need(typeof i.loan_id === "string" && i.loan_id !== "", "loan_id is required");
  const action = actionOf(i.action); const mode = modeOf(i.mode);
  need(mode !== "legacy", "delinquency events are submitted only in dual (CIT) or event mode; legacy is the AMN file alone (LL-2026-05, live Mar. 15, 2027)");
  need(Number.isFinite(i.processed_at_ms), "processed_at must be a timestamp");
  const derived = deriveEventStatusTypes(strings(i.status_types, "status_types")); const reason_types = strings(i.reason_types, "reason_types");
  const fatal = validateDelinquencyEvent({ action, status_types: derived.status_types, reason_types, ...(i.prior_reason_reported !== undefined ? { prior_reason_reported: i.prior_reason_reported } : {}) });
  need(fatal.length === 0, `delinquency event fails the platform's fatal rules: ${fatal.join("; ")}`);
  const a = SERVICER_ACTION_TYPES[action]; const submit_by_ms = eventDeadlineMs(i.processed_at_ms); const submitted_at_ms = i.submitted_at_ms ?? Date.parse(em.now);
  const submission_id = i.submission_id || `dq-${i.loan_id}-${wallClock(i.processed_at_ms, ET).date}-${action}`; const seq = i.per_loan_sequence ?? 1;
  need(Number.isInteger(seq) && seq >= 1, "per_loan_sequence must be a positive integer");
  const env = eventEnv(mode) as "api-clve" | "production"; const submitted_at = toIso(submitted_at_ms);
  const amn_line = a.amn_status ? { status: a.amn_status, effective: wallClock(i.processed_at_ms, ET).date.replaceAll("-", ""), completion: "        " } : null;
  const event = em.events.append({ type: "delinquency_events.submitted", loanId: i.loan_id, actor: em.actor, occurredAt: submitted_at, ...(i.action_event_id ? { causationId: i.action_event_id } : {}),
    payload: { action, servicer_action_type: a.type, status_types: derived.status_types, dropped_status_types: derived.dropped, reason_types, env, mode, processed_at: toIso(i.processed_at_ms), submit_by: toIso(submit_by_ms), submitted_at, on_time: submitted_at_ms <= submit_by_ms, submission_id, per_loan_sequence: seq, status: "submitted", amn_status: a.amn_status } });
  return { loan_id: i.loan_id, action, servicer_action_type: a.type, status_types: derived.status_types, dropped_status_types: derived.dropped, reason_types, env, submit_by_ms, submitted_at_ms, on_time: submitted_at_ms <= submit_by_ms, submission_id, per_loan_sequence: seq, amn_line, event };
}
export type ResponseStatus = "accepted" | "accepted_with_warnings" | "rejected";
const RESPONSE_STATUSES: readonly ResponseStatus[] = ["accepted", "accepted_with_warnings", "rejected"];
export interface ResponseRecord { readonly loan_id: string; readonly submission_id: string; readonly servicer_action_type: string; readonly status: ResponseStatus; readonly warnings: string[]; readonly exceptions: string[]; readonly event: DomainEvent; }
/** The Servicing Platform's response (API / CSV UI / B2B): the 5.1 event machine's `accepted` / `accepted_with_warnings` / `rejected` → `delinquency_events.accepted{servicer_action_type}` (warnings are non-blocking notifications) or `.rejected`. */
export function ingestEventResponse(em: Emitter, i: { readonly loan_id: string; readonly submission_id: string; readonly servicer_action_type: string; readonly status: string; readonly warnings?: unknown; readonly exceptions?: unknown; readonly received_at_ms?: number }): ResponseRecord {
  need(typeof i.loan_id === "string" && i.loan_id !== "", "loan_id is required");
  need(typeof i.submission_id === "string" && i.submission_id !== "", "submission_id is required: the response must reference the submitted event");
  const known = Object.values(SERVICER_ACTION_TYPES).some((a) => a.type === i.servicer_action_type);
  need(known, `servicer_action_type ${i.servicer_action_type || "(none)"} is not a Servicer Action Type of the delinquency event`);
  need((RESPONSE_STATUSES as readonly string[]).includes(i.status), `status ${i.status || "(none)"} is not accepted/accepted_with_warnings/rejected`);
  const status = i.status as ResponseStatus; const warnings = strings(i.warnings, "warnings"); const exceptions = strings(i.exceptions, "exceptions");
  if (status === "rejected") need(exceptions.length > 0, "a rejected response must carry at least one exception");
  if (status === "accepted_with_warnings") need(warnings.length > 0, "accepted_with_warnings must carry the warning notifications");
  const occurredAt = i.received_at_ms !== undefined ? toIso(i.received_at_ms) : em.now;
  const event = em.events.append({ type: status === "rejected" ? "delinquency_events.rejected" : "delinquency_events.accepted", loanId: i.loan_id, actor: em.actor, occurredAt,
    payload: { submission_id: i.submission_id, servicer_action_type: i.servicer_action_type, status, warnings, exceptions, received_at: occurredAt } });
  return { loan_id: i.loan_id, submission_id: i.submission_id, servicer_action_type: i.servicer_action_type, status, warnings, exceptions, event };
}

// ───── Fannie Mae Connect report availability; reclass deselection (5.4 window, CD11–CD15) ─────
export type ConnectReport = "delinquency_exception_summary" | "delinquency_exception_details" | "delinquency_final" | "eligible_for_deselection";
const CONNECT_REPORTS: readonly ConnectReport[] = ["delinquency_exception_summary", "delinquency_exception_details", "delinquency_final", "eligible_for_deselection"];
/** An inbound Fannie Mae Connect notice that a report is available (BD4–BD6 exception reports, CD11–CD13 final report, ~CD11 Eligible for Deselection) → `fnma.connect.report.available{report}`. */
export function ingestConnectReport(em: Emitter, i: { readonly report: string; readonly period: string; readonly document_id: string; readonly available_at_ms?: number; readonly servicer_number?: string | null; readonly loan_count?: number }): { report: ConnectReport; period: string; subject: Subject; event: DomainEvent } {
  need((CONNECT_REPORTS as readonly string[]).includes(i.report), `report ${i.report || "(none)"} is not one of ${CONNECT_REPORTS.join("/")}`);
  need(typeof i.document_id === "string" && i.document_id !== "", "document_id is required: the report is stored before it is acted on");
  const subject = reportSubject(i.period, i.servicer_number); const occurredAt = i.available_at_ms !== undefined ? toIso(i.available_at_ms) : em.now;
  const event = em.events.append({ type: "fnma.connect.report.available", aggregate: subject, actor: em.actor, occurredAt, payload: { report: i.report, period: i.period, document_id: i.document_id, servicer_number: i.servicer_number ?? null, loan_count: i.loan_count ?? null } });
  return { report: i.report as ConnectReport, period: i.period, subject, event };
}
/** The reclassification deselection decision (F-1-25, 5.4 window through CD15) recorded per loan → `reclass.deselection.decided`. */
export function recordReclassDeselection(em: Emitter, i: { readonly loan_id: string; readonly period: string; readonly decision: string; readonly rationale: string; readonly servicer_number?: string | null; readonly portal_task_id?: string | null }): { loan_id: string; decision: "deselect" | "retain"; subject: Subject; event: DomainEvent } {
  need(typeof i.loan_id === "string" && i.loan_id !== "", "loan_id is required");
  need(i.decision === "deselect" || i.decision === "retain", `decision ${i.decision || "(none)"} must be deselect or retain`);
  need(typeof i.rationale === "string" && i.rationale.trim() !== "", "rationale is required for a deselection decision");
  const subject = reportSubject(i.period, i.servicer_number);
  const event = em.events.append({ type: "reclass.deselection.decided", loanId: i.loan_id, aggregate: subject, actor: em.actor, payload: { period: i.period, decision: i.decision, rationale: i.rationale, portal_task_id: i.portal_task_id ?? null, servicer_number: i.servicer_number ?? null } });
  return { loan_id: i.loan_id, decision: i.decision as "deselect" | "retain", subject, event };
}

/** Exception report severity split for the tool (re-exported shape). */
export type { DqException };
