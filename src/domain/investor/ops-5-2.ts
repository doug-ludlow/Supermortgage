/**
 * §5.2 operating rules over the remittance calculators (./remittance.ts, ./period.ts, ./ops.ts) and the event vocabulary
 * every 5.2 timer row arms on and is satisfied by. The tools in src/app/tools/section5-2.ts are thin shells over these:
 *   - the remittance calendar ("Schedules on `fannie_et`"): `openRemittancePeriod` / `closeRemittancePeriod` (one
 *     `investor_reporting_periods.opened` per remittance cycle the servicer number carries, each scheduling its
 *     Fannie Mae-initiated draft → `remittance.draft.scheduled`), `aaSweep` (daily 15:00 ET `$2,500` sweep),
 *     `monthEnd` (BD1 prior-month catch-up), `computeRemittanceCalculation` (Inputs: every accepted 5.1 event creates a
 *     `remittance_calculations` row → `remittance_calculations.computed`);
 *   - the CRS batch codec and settlement-date rule (Integrations / CRS User Guide): `crsBatchLines`, `crsBatchText`,
 *     `crsSettlementDate`, `prepareCrsBatch` → `crs_batches.prepared`, `confirmCrsUpload` → `crs_batches.upload_confirmed`
 *     + `remittances.instructed` per accepted line, `crsInstructionNeeded` / `crsInstructionConfirmed`;
 *   - rule 7 funding: `fundDraft` → `custodial.funding.verified{covered}` and `remittances.funded` (the `advance` command
 *     with its ledger set, `officer` when the facility is exhausted);
 *   - rule 8 draft notifications (inbound Loan-Level Draft Notifications API / Connect pulls): `validateDraftNotification`,
 *     `ingestDraftNotification` → `fnma.draft_notification.received{kind}`, `reconcileDraftNotification` →
 *     `.reconciled` (+ `.reviewed` for a pre-draft notification);
 *   - the proceeds receipts the special remittances settle (Inputs: `shortsale.proceeds.received`, `settlement.received`)
 *     from the custodial bank feed: `recordProceedsReceipt`; `nextRemittanceDate` for a settlement;
 *   - rule 9 Schedule 3: `schedule3` → `fnma.shortage_surplus.shortage_confirmed{reconciled=false}` /
 *     `.surplus_identified{first_seen_on}`, `resolveShortageSurplus` → `.resolved{kind}`.
 *
 * Subjects (the engine keys satisfaction on the subject — src/kernel/timers/engine.ts `sameSubject`): a remittance cycle
 * `{kind: "remittance_cycle", id: "<period>:<type>:<cycle>"}` for period-level drafts and the A/A servicer-initiated
 * clocks; `{kind: "period", id}` for the period close and its draft notifications; `{kind: "crs_batch", id}`;
 * `{kind: "crs_instruction", id}`; `{kind: "shortage_surplus", id: "<servicer_number>"}` (the shortage/surplus is one
 * cumulative balance per servicer number, IRM Ch. 5); loan-level facts carry `loanId`.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addMonths, daysBetween, endOfMonth, min as minDate, plainDate, parts } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt, federal, nextBusinessDay } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import type { Actor, EventStore } from "../../kernel/events/index.ts";
import type { EntrySetInput } from "../../kernel/ledger/ledger.ts";
import type { RemittanceType } from "./types.ts";
import { aaRemittance, saInterest, scheduledMonth, classifyVariance, specialRemittanceDeadline, CRS_AA_THRESHOLD_CENTS, type VarianceClass } from "./remittance.ts";
import { periodAnchors, calendarDraftDate, fannieBusinessDay, fundingGateMs, firstOfMonth, nextMonth, period as periodOf, periodStart, bd1CatchUpMs, surplusResolveDueOn } from "./period.ts";
import { ET, advanceTransfer, aaAutoDraftSchedule, aaSweepBatch, form472Schedule3, type AdvanceTransfer } from "./ops.ts";

export const RULE_SET_VERSION = "5.2@ops.v1";
export type RemittanceTypeCode = "aa" | "sa" | "ss";
/** `remittance_calculations.cycle` (data model): the draft cycle a loan settles on. `rpm` carries its designated day separately. */
export type Cycle = "standard" | "rpm" | "mbs_express" | "sixth_day" | "mrs";
export type RemittanceKind = "pi_scheduled" | "pi_actual" | "payoff" | "curtailment" | "repurchase" | "gfee" | "special" | "tps_proceeds" | "short_sale" | "reo_proceeds" | "settlement";
export type Basis = "contractual" | "curtailment" | "payoff" | "repurchase" | "liquidation" | "none";
export interface Emitter { readonly events: EventStore; readonly actor: Actor; readonly now: string; }
export type Subject = { readonly kind: string; readonly id: string };

export const typeCode = (t: RemittanceType | RemittanceTypeCode | string): RemittanceTypeCode => {
  const k = t.toLowerCase();
  if (k !== "aa" && k !== "sa" && k !== "ss") throw new RangeError(`remittance_type ${t} is not one of AA/SA/SS`);
  return k;
};
export const cycleSubject = (period: string, type: RemittanceTypeCode, cycle: Cycle): Subject => ({ kind: "remittance_cycle", id: `${period}:${type}:${cycle}` });
export const periodSubject = (period: string): Subject => ({ kind: "period", id: period });
export const shortageSurplusSubject = (servicerNumber: string): Subject => ({ kind: "shortage_surplus", id: servicerNumber });
const isoDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const partOf = (c: Cents, participationPct: string): Cents => (participationPct === "100" ? c : divRound(c * Decimal.parse(participationPct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP"));
const etDate = (ms: number): PlainDate => wallClock(ms, ET).date;
const asPeriod = (s: string): string => { if (!/^\d{4}-\d{2}$/.test(s)) throw new RangeError(`activity_period ${s} is not YYYY-MM`); return s; };

// ───── CRS remittance codes (CRS Remittance Codes, Oct. 15, 2025) ─────
/** Fannie Mae-initiated draft codes by cycle; `null` where the codes list names none (the 18th standard cycle is drafted without a servicer request). */
export const DRAFT_CRS_CODE: Record<RemittanceTypeCode, Partial<Record<Cycle, string | null>>> = { aa: { standard: "001" }, sa: { standard: "002" }, ss: { standard: null, mrs: "003", rpm: "004", mbs_express: "005", sixth_day: null } };
export const LOAN_NUMBER_CODES = /^(028|029|3\d\d)$/;
export const CRS_MAX_DRAFT_CENTS = 9_999_999_999n;   // $99,999,999.99, positive only
export const CRS_MAX_LINES = 1000, CRS_MAX_BYTES = 100 * 1024;

// ───── the remittance calendar ─────
export interface CycleConfig { readonly remittance_type: RemittanceTypeCode; readonly cycle: Cycle; readonly rpm_day?: number | null; readonly expected_cents: Cents; readonly custodial_account_id?: string | null; }
export interface DraftSchedule { readonly period: string; readonly remittance_type: RemittanceTypeCode; readonly cycle: Cycle; readonly draft_date: PlainDate | null; readonly funding_gate_at: string | null; readonly expected_cents: Cents; readonly crs_code: string | null; readonly initiator: "fnma" | "servicer"; readonly subject: Subject; }
/** Rule 2: the draft date of the cycle that settles `monthOf`'s activity — CD18 / CD20 / RPM designated / BD4 / CD6 of the following month, each on the preceding `fannie_et` BD; A/A is servicer-initiated (no Fannie Mae draft). */
export function draftDateFor(monthOf: PlainDate, c: { remittance_type: RemittanceTypeCode; cycle: Cycle; rpm_day?: number | null }): PlainDate | null {
  const a = periodAnchors(monthOf);
  if (c.remittance_type === "aa") return null;
  if (c.remittance_type === "sa") return a.sa_draft_on;
  switch (c.cycle) {
    case "rpm": { if (!c.rpm_day || c.rpm_day < 1 || c.rpm_day > 28) throw new RangeError("an RPM cycle needs rpm_day (1–28)"); return calendarDraftDate(a.following_month_start, c.rpm_day); }
    case "mbs_express": return a.mbsx_bd4_on;
    case "sixth_day": return a.pool_draft_on;
    default: return a.ss_draft_on;
  }
}
export function draftSchedule(monthOf: PlainDate, c: CycleConfig): DraftSchedule {
  const period = periodOf(firstOfMonth(monthOf));
  const draft = draftDateFor(monthOf, c);
  return { period, remittance_type: c.remittance_type, cycle: c.cycle, draft_date: draft, funding_gate_at: draft ? toIso(fundingGateMs(draft)) : null, expected_cents: c.expected_cents, crs_code: DRAFT_CRS_CODE[c.remittance_type][c.cycle] ?? null, initiator: c.remittance_type === "aa" ? "servicer" : "fnma", subject: cycleSubject(period, c.remittance_type, c.cycle) };
}
/** Period open: one `investor_reporting_periods.opened{remittance_type, cycle}` per cycle (the §5 period anchors as payload) and, for each Fannie Mae-initiated draft, `remittance.draft.scheduled` — the trigger of the T−1 16:00 ET funding gate (rule 7). */
export function openRemittancePeriod(em: Emitter, i: { month_of: PlainDate; servicer_number: string; cycles: readonly CycleConfig[] }): DraftSchedule[] {
  if (!i.cycles.length) throw new RangeError("a period opens with at least one remittance cycle");
  const anchors = periodAnchors(i.month_of);
  const out: DraftSchedule[] = [];
  for (const c of i.cycles) {
    const s = draftSchedule(i.month_of, c);
    if (out.some((x) => x.subject.id === s.subject.id)) throw new RangeError(`cycle ${s.subject.id} listed twice`);
    em.events.append({ type: "investor_reporting_periods.opened", aggregate: s.subject, actor: em.actor, payload: { ...anchors, servicer_number: i.servicer_number, remittance_type: c.remittance_type, cycle: c.cycle, rpm_day: c.rpm_day ?? null, designated_draft_date: c.cycle === "rpm" ? s.draft_date : null, draft_date: s.draft_date, expected_cents: c.expected_cents, crs_code: s.crs_code, custodial_account_id: c.custodial_account_id ?? null } });
    if (s.draft_date) em.events.append({ type: "remittance.draft.scheduled", aggregate: s.subject, actor: em.actor, payload: { period: s.period, servicer_number: i.servicer_number, remittance_type: c.remittance_type, cycle: c.cycle, draft_date: s.draft_date, funding_gate_at: s.funding_gate_at, expected_cents: c.expected_cents, crs_code: s.crs_code, initiator: "fnma" } });
    out.push(s);
  }
  return out;
}
/** Period close (BD2): `investor_reporting_periods.closed` — the trigger of the BD3 12:00 ET draft-notification clock. */
export function closeRemittancePeriod(em: Emitter, i: { month_of: PlainDate; servicer_number: string; checklist_complete?: boolean }): { period: string; draft_notice_due_at: string } {
  const a = periodAnchors(i.month_of);
  const due = toIso(zonedEpochMs(fannieBusinessDay(a.following_month_start, 3), "12:00", ET));
  em.events.append({ type: "investor_reporting_periods.closed", aggregate: periodSubject(a.period), actor: em.actor, payload: { ...a, servicer_number: i.servicer_number, ...(i.checklist_complete !== undefined ? { checklist_complete: i.checklist_complete } : {}), draft_notice_due_at: due, closed_at: em.now } });
  return { period: a.period, draft_notice_due_at: due };
}

// ───── Inputs: accepted investor event → remittance_calculations row ─────
export interface AcceptedEventFacts {
  readonly loan_id: string; readonly activity_period: string; readonly remittance_type: RemittanceType | RemittanceTypeCode; readonly cycle?: Cycle; readonly rpm_day?: number | null;
  readonly basis: Basis; readonly prior_actual_upb_cents: Cents; readonly prior_scheduled_upb_cents: Cents; readonly note_rate: string; readonly ptr: string; readonly participation_pct?: string;
  readonly pi_cents: Cents; readonly principal_collected_cents: Cents; readonly interest_collected_cents?: Cents; readonly months_delinquent?: number; readonly sda_active?: boolean;
  readonly reporting?: "summary" | "detailed"; readonly phase?: "crs" | "autodraft"; readonly accepted_at: string; readonly processed_at?: string;
}
export interface RemittanceCalculation {
  readonly calculation_id: string; readonly loan_id: string; readonly activity_period: string; readonly remittance_type: RemittanceTypeCode; readonly cycle: Cycle; readonly basis: Basis; readonly reporting: "summary" | "detailed"; readonly phase: "crs" | "autodraft";
  readonly interest_due_cents: Cents; readonly principal_due_cents: Cents; readonly servicing_fee_cents: Cents; readonly advance_cents: Cents; readonly remittance_cents: Cents; readonly sda_flag: boolean;
  readonly draft_on: PlainDate | null; readonly funding_gate_at: string | null; readonly predraft_notice_on: PlainDate | null; readonly following_month_start: PlainDate; readonly mbsx_bd4_on: PlainDate; readonly accepted_at: string; readonly rule_set_version: string;
}
/** Rule 2 by type (all per activity period): A/A interest only when a contractual payment posts and principal as collected; S/A scheduled interest through month 3, −3 months in month 4; S/S scheduled P&I on the prior scheduled UPB (+ curtailments as reported); nothing due while Stop Advance is set (5.4). */
export function computeRemittanceCalculation(f: AcceptedEventFacts): RemittanceCalculation {
  const type = typeCode(f.remittance_type); const cycle = f.cycle ?? "standard"; const part = f.participation_pct ?? "100";
  if (f.basis === "payoff" || f.basis === "repurchase" || f.basis === "liquidation") throw new RangeError(`${f.basis} remittances are computed by 16.2 / 5.6 / 5.3, not the periodic calculator`);
  if (type !== "ss" && cycle !== "standard") throw new RangeError(`cycle ${cycle} is an S/S draft cycle`);
  if (!f.accepted_at || Number.isNaN(Date.parse(f.accepted_at))) throw new RangeError("accepted_at must be an ISO instant");
  const start = periodStart(asPeriod(f.activity_period)); const anchors = periodAnchors(start);
  let interest = 0n, principal = 0n, fee = 0n, advance = 0n;
  if (type === "aa") {
    const r = aaRemittance(f.prior_actual_upb_cents, f.note_rate, f.ptr, f.principal_collected_cents, part);
    if (f.basis === "contractual") { interest = r.fnma_interest_cents; fee = r.servicing_fee_cents; }
    principal = f.basis === "none" ? 0n : r.principal_cents;
  } else if (type === "sa") {
    const months = f.months_delinquent ?? 0;
    interest = f.sda_active ? 0n : saInterest(f.prior_actual_upb_cents, f.ptr, Math.max(1, months), part);
    principal = partOf(f.principal_collected_cents, part);
    advance = months >= 1 && months <= 3 ? interest : 0n;
  } else {
    const m = scheduledMonth(f.prior_scheduled_upb_cents, f.note_rate, f.ptr, f.pi_cents, part);
    if (!f.sda_active) { interest = m.fnma_interest_cents; principal = m.fnma_principal_cents; }
    if (f.basis === "curtailment") principal += partOf(f.principal_collected_cents, part);
    fee = m.servicing_fee_cents;
    const collected = (f.interest_collected_cents ?? 0n) + f.principal_collected_cents;
    advance = interest + principal > collected ? interest + principal - collected : 0n;
  }
  const remittance = interest + principal;
  let draft: PlainDate | null = null, predraft: PlainDate | null = null, gate: string | null = null;
  if (type === "aa" && (f.phase ?? "crs") === "autodraft") { const s = aaAutoDraftSchedule(Date.parse(f.processed_at ?? f.accepted_at)); draft = s.draft_on; predraft = s.predraft_notice_on; gate = toIso(s.funding_gate_ms); }
  else if (type !== "aa") { draft = draftDateFor(start, { remittance_type: type, cycle, rpm_day: f.rpm_day ?? null }); gate = draft ? toIso(fundingGateMs(draft)) : null; }
  return { calculation_id: `rc-${f.loan_id}-${f.activity_period}-${f.basis}`, loan_id: f.loan_id, activity_period: f.activity_period, remittance_type: type, cycle, basis: f.basis, reporting: f.reporting ?? "summary", phase: f.phase ?? "crs",
    interest_due_cents: interest, principal_due_cents: principal, servicing_fee_cents: fee, advance_cents: advance, remittance_cents: remittance, sda_flag: f.sda_active === true,
    draft_on: draft, funding_gate_at: gate, predraft_notice_on: predraft, following_month_start: anchors.following_month_start, mbsx_bd4_on: anchors.mbsx_bd4_on, accepted_at: f.accepted_at, rule_set_version: RULE_SET_VERSION };
}
/** Emits `remittance_calculations.computed` (the 5.2-native spelling of "detailed-reporting LAR accepted" / "payment event accepted (auto-draft phase)" / "unscheduled principal collected (MBS Express)") and, for an auto-draft, schedules its draft. */
export function recordRemittanceCalculation(em: Emitter, f: AcceptedEventFacts): RemittanceCalculation {
  const c = computeRemittanceCalculation(f);
  em.events.append({ type: "remittance_calculations.computed", loanId: c.loan_id, actor: em.actor, payload: { ...c, computed_at: em.now } });
  if (c.phase === "autodraft" && c.draft_on) em.events.append({ type: "remittance.draft.scheduled", loanId: c.loan_id, actor: em.actor, payload: { period: c.activity_period, remittance_type: c.remittance_type, cycle: c.cycle, draft_date: c.draft_on, funding_gate_at: c.funding_gate_at, expected_cents: c.remittance_cents, predraft_notice_on: c.predraft_notice_on, crs_code: null, initiator: "fnma" } });
  return c;
}

// ───── A/A servicer-initiated: the 15:00 ET sweep, month end, the BD1 catch-up ─────
/** CRS User Guide: a draft request before 16:00 ET settles the next Federal Reserve business day, after 16:00 ET in two. */
export function crsSettlementDate(requestAtMs: number): PlainDate {
  const on = wallClock(requestAtMs, ET);
  return addBusinessDays(on.date, on.hour < 16 ? 1 : 2, federal);
}
export function aaSweep(em: Emitter, i: { sweep_at_ms: number; net_collected_cents: Cents; servicer_number: string; last_work_day_of_month: boolean; activity_period?: string }): ReturnType<typeof aaSweepBatch> & { activity_period: string; subject: Subject } {
  if (i.net_collected_cents < 0n) throw new RangeError("net collections cannot be negative (a reversal nets against the next remittance)");
  const period = i.activity_period ? asPeriod(i.activity_period) : periodOf(etDate(i.sweep_at_ms));
  const b = aaSweepBatch(i);
  const subject = cycleSubject(period, "aa", "standard");
  em.events.append({ type: "custodial.aa_sweep", aggregate: subject, actor: em.actor, payload: { servicer_number: i.servicer_number, activity_period: period, sweep_at: toIso(i.sweep_at_ms), net_collections_cents: i.net_collected_cents, threshold_cents: CRS_AA_THRESHOLD_CENTS, last_work_day_of_month: i.last_work_day_of_month, instruct: b.instruct, settlement_date: b.settlement_date } });
  return { ...b, activity_period: period, subject };
}
/** F-1-20: A/A collected on the last work day and not remitted is instructed by BD1 16:00 ET — `period.month_end{aa_collections_unremitted}` arms that clock. */
export function monthEnd(em: Emitter, i: { period_end: PlainDate; servicer_number: string; unremitted_cents: Cents }): { period: string; aa_collections_unremitted: boolean; bd1_catch_up_at: string; subject: Subject } {
  if (i.period_end !== endOfMonth(i.period_end)) throw new RangeError(`${i.period_end} is not a month end`);
  if (i.unremitted_cents < 0n) throw new RangeError("unremitted collections cannot be negative");
  const period = periodOf(i.period_end); const subject = cycleSubject(period, "aa", "standard");
  const catchUp = toIso(bd1CatchUpMs(i.period_end));
  em.events.append({ type: "period.month_end", aggregate: subject, actor: em.actor, payload: { period, period_end: i.period_end, servicer_number: i.servicer_number, aa_collections_unremitted: i.unremitted_cents > 0n, unremitted_cents: i.unremitted_cents, bd1_catch_up_at: catchUp } });
  return { period, aa_collections_unremitted: i.unremitted_cents > 0n, bd1_catch_up_at: catchUp, subject };
}

// ───── CRS batch codec (positions 1–9 / 10–13 / 14–28 / 29–38 / 39–48) ─────
export interface CrsLineInput { readonly remittance_id: string; readonly servicer_number: string; readonly remittance_code: string; readonly amount_cents: Cents; readonly settlement_date: PlainDate; readonly fnma_loan_number?: string | null; readonly loan_id?: string | null; readonly remittance_type?: RemittanceTypeCode | null; readonly kind: RemittanceKind; readonly reason?: string | null; readonly activity_period?: string | null; }
const dollars = (c: Cents): string => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;
const mmddyyyy = (d: PlainDate): string => { const p = parts(d); return `${String(p.m).padStart(2, "0")}/${String(p.d).padStart(2, "0")}/${p.y}`; };
export function crsLineText(l: CrsLineInput): string {
  if (!/^\d{9}$/.test(l.servicer_number)) throw new RangeError(`servicer_number ${l.servicer_number} is not 9 digits (LenderID, positions 1–9)`);
  if (!/^\d{3}$/.test(l.remittance_code)) throw new RangeError(`remittance code ${l.remittance_code} is not a 3-digit CRS code`);
  if (l.amount_cents <= 0n || l.amount_cents > CRS_MAX_DRAFT_CENTS) throw new RangeError(`draft amount ${l.amount_cents}¢ must be positive and at most $99,999,999.99`);
  if (LOAN_NUMBER_CODES.test(l.remittance_code) && !(l.fnma_loan_number && /^\d{1,10}$/.test(l.fnma_loan_number))) throw new RangeError(`code ${l.remittance_code} requires the Fannie Mae loan number (positions 29–38)`);
  if (!isoDate(l.settlement_date)) throw new RangeError("settlement_date must be YYYY-MM-DD");
  return `${l.servicer_number}${l.remittance_code.padEnd(4)}${dollars(l.amount_cents).padStart(15)}${(l.fnma_loan_number ?? "").padEnd(10)}${mmddyyyy(l.settlement_date)}`;
}
export function crsBatchText(lines: readonly CrsLineInput[]): { text: string; line_count: number; total_cents: Cents; bytes: number } {
  if (!lines.length) throw new RangeError("a CRS batch needs at least one line");
  if (lines.length > CRS_MAX_LINES) throw new RangeError(`a CRS batch file holds at most ${CRS_MAX_LINES} lines (split by servicer number and settlement date)`);
  const text = lines.map(crsLineText).join("\r\n") + "\r\n";
  const bytes = Buffer.byteLength(text);
  if (bytes > CRS_MAX_BYTES) throw new RangeError(`CRS batch file ${bytes} bytes exceeds 100 KB`);
  return { text, line_count: lines.length, total_cents: lines.reduce((s, l) => s + l.amount_cents, 0n), bytes };
}
/** Edge case "Duplicate CRS request": a second 001 for the same servicer number/settlement date is blocked unless the first `failed`. */
export function duplicate001(existing: readonly { remittance_code: string; servicer_number: string; settlement_date: string; status: string }[], l: { servicer_number: string; settlement_date: PlainDate }): boolean {
  return existing.some((x) => x.remittance_code === "001" && x.servicer_number === l.servicer_number && x.settlement_date === l.settlement_date && x.status !== "failed");
}
export const uploadDueMs = (settlementDate: PlainDate): number => zonedEpochMs(addBusinessDays(settlementDate, -1, fannieEt), "16:00", ET);
/** `crs_batches.prepared` — the file, its manifest and the operator's 16:00 ET upload deadline (settlement −1 `fannie_et` BD). */
export function prepareCrsBatch(em: Emitter, i: { batch_id: string; lines: readonly CrsLineInput[]; prepared_at_ms?: number }): { batch_id: string; text: string; line_count: number; total_cents: Cents; settlement_date: PlainDate; upload_due_at: string; subject: Subject; manifest: { servicer_number: string; remittance_code: string; amount_cents: Cents; settlement_date: PlainDate; fnma_loan_number: string | null }[] } {
  const f = crsBatchText(i.lines);
  const servicers = new Set(i.lines.map((l) => l.servicer_number)), dates = new Set(i.lines.map((l) => l.settlement_date));
  if (servicers.size > 1 || dates.size > 1) throw new RangeError("one CRS batch file per servicer number and settlement date (split before preparing)");
  const settlement = i.lines[0]!.settlement_date; const subject = { kind: "crs_batch", id: i.batch_id };
  const preparedAt = i.prepared_at_ms !== undefined ? toIso(i.prepared_at_ms) : em.now;
  const due = toIso(uploadDueMs(settlement));
  em.events.append({ type: "crs_batches.prepared", aggregate: subject, actor: em.actor, payload: { batch_id: i.batch_id, servicer_number: i.lines[0]!.servicer_number, remittance_code: i.lines[0]!.remittance_code, line_count: f.line_count, total_cents: f.total_cents, amount_cents: f.total_cents, settlement_date: settlement, prepared_at: preparedAt, upload_due_at: due, activity_period: i.lines[0]!.activity_period ?? null, remittance_ids: i.lines.map((l) => l.remittance_id) } });
  return { batch_id: i.batch_id, text: f.text, line_count: f.line_count, total_cents: f.total_cents, settlement_date: settlement, upload_due_at: due, subject, manifest: i.lines.map((l) => ({ servicer_number: l.servicer_number, remittance_code: l.remittance_code, amount_cents: l.amount_cents, settlement_date: l.settlement_date, fnma_loan_number: l.fnma_loan_number ?? null })) };
}
export interface CrsResultLine { readonly remittance_id: string; readonly accepted: boolean; readonly reject_reason?: string | null; }
/** The operator's Draft Request Report detail export, parsed: `crs_batches.upload_confirmed` and one `remittances.instructed` per accepted line (failed lines are re-batched). Subject per line: the loan for loan-numbered codes, the shortage/surplus balance for a shortage 001, else the A/A cycle the line settles. */
export function confirmCrsUpload(em: Emitter, i: { batch_id: string; lines: readonly CrsLineInput[]; result: readonly CrsResultLine[]; uploaded_at?: string; confirmation_document_id?: string | null }): { accepted: string[]; failed: string[]; uploaded_at: string } {
  if (!i.lines.length) throw new RangeError("no lines in the batch");
  const uploadedAt = i.uploaded_at ?? em.now;
  const byId = new Map(i.result.map((r) => [r.remittance_id, r] as const));
  const missing = i.lines.filter((l) => !byId.has(l.remittance_id)).map((l) => l.remittance_id);
  if (missing.length) throw new RangeError(`the CRS confirmation carries no result for line(s) ${missing.join(", ")}`);
  const accepted: string[] = [], failed: string[] = [];
  em.events.append({ type: "crs_batches.upload_confirmed", aggregate: { kind: "crs_batch", id: i.batch_id }, actor: em.actor, payload: { batch_id: i.batch_id, uploaded_at: uploadedAt, accepted_count: i.result.filter((r) => r.accepted).length, rejected_count: i.result.filter((r) => !r.accepted).length, confirmation_document_id: i.confirmation_document_id ?? null } });
  for (const l of i.lines) {
    const r = byId.get(l.remittance_id)!;
    if (!r.accepted) { failed.push(l.remittance_id); em.events.append({ type: "remittances.failed", ...(l.loan_id ? { loanId: l.loan_id } : {}), aggregate: { kind: "crs_batch", id: i.batch_id }, actor: em.actor, payload: { remittance_id: l.remittance_id, batch_id: i.batch_id, crs_code: l.remittance_code, reason: r.reject_reason ?? "rejected line", action: "re-batch" } }); continue; }
    accepted.push(l.remittance_id);
    const type = l.remittance_type ?? (l.remittance_code === "001" ? "aa" : null);
    const subject = l.reason === "shortage" ? shortageSurplusSubject(l.servicer_number) : l.activity_period && type ? cycleSubject(l.activity_period, type, "standard") : { kind: "crs_batch", id: i.batch_id };
    em.events.append({ type: "remittances.instructed", ...(l.loan_id ? { loanId: l.loan_id } : {}), aggregate: subject, actor: em.actor, payload: { remittance_id: l.remittance_id, batch_id: i.batch_id, crs_code: l.remittance_code, remittance_type: type, kind: l.kind, reason: l.reason ?? null, amount_cents: l.amount_cents, settlement_date: l.settlement_date, activity_period: l.activity_period ?? null, fnma_loan_number: l.fnma_loan_number ?? null, instructed_at: uploadedAt } });
  }
  return { accepted, failed, uploaded_at: uploadedAt };
}

// ───── CRS drafting instructions (bank account per code; before 20:00 ET the BD prior) ─────
export function crsInstructionNeeded(em: Emitter, i: { instruction_id: string; servicer_number: string; remittance_code: string; bank_aba: string; bank_account: string; effective_date: PlainDate }): { enter_by_at: string; subject: Subject } {
  if (!/^\d{9}$/.test(i.bank_aba)) throw new RangeError("bank_aba must be 9 digits");
  if (!/^\d{4,17}$/.test(i.bank_account)) throw new RangeError("bank_account must be 4–17 digits");
  if (!/^\d{3}$/.test(i.remittance_code)) throw new RangeError("remittance_code must be a 3-digit CRS code");
  if (!isoDate(i.effective_date)) throw new RangeError("effective_date must be YYYY-MM-DD");
  const today = etDate(Date.parse(em.now));
  if (i.effective_date <= today) throw new RangeError("a drafting instruction takes effect no earlier than the next business day");
  if (i.effective_date > addMonths(today, 6)) throw new RangeError("CRS accepts drafting instructions up to six months ahead");
  const subject = { kind: "crs_instruction", id: i.instruction_id };
  const enterBy = toIso(zonedEpochMs(addBusinessDays(i.effective_date, -1, fannieEt), "20:00", ET));
  em.events.append({ type: "crs.instruction.needed", aggregate: subject, actor: em.actor, payload: { instruction_id: i.instruction_id, servicer_number: i.servicer_number, remittance_code: i.remittance_code, bank_aba: i.bank_aba, bank_account_last4: i.bank_account.slice(-4), effective_date: i.effective_date, enter_by_at: enterBy } });
  return { enter_by_at: enterBy, subject };
}
export function crsInstructionConfirmed(em: Emitter, i: { instruction_id: string; effective_date: PlainDate; confirmation_document_id?: string | null }): void {
  em.events.append({ type: "crs.instruction.confirmed", aggregate: { kind: "crs_instruction", id: i.instruction_id }, actor: em.actor, payload: { instruction_id: i.instruction_id, effective_date: i.effective_date, confirmed_at: em.now, confirmation_document_id: i.confirmation_document_id ?? null } });
}

// ───── rule 7: the T−1 16:00 ET funding check ─────
export interface FundDraftInput { readonly period: string; readonly remittance_type: RemittanceTypeCode; readonly cycle: Cycle; readonly draft_date: PlainDate; readonly expected_draft_cents: Cents; readonly custodial_available_cents: Cents; readonly facility_available_cents: Cents; readonly custodial_account_id: string; readonly loan_id?: string | null; readonly kind?: RemittanceKind; readonly at_ms: number; }
export interface FundDraftResult { readonly advance: AdvanceTransfer; readonly entry_set: EntrySetInput | null; readonly status: "funded" | "escalated"; readonly funded_at: string | null; readonly subject: Subject; }
/** Spec Outputs: advance → Dr `servicer_advance_receivable` Cr corporate cash / Dr `custodial_pi_cash` Cr transfer clearing (the kernel's `advance_receivable` / `clearing_cash`). */
export function advanceEntrySet(i: { amount_cents: Cents; custodial_account_id: string; effective_date: PlainDate; period: string; remittance_type: RemittanceTypeCode; cycle: Cycle }): EntrySetInput {
  const ref = "5.2 rule 7 advance"; const memo = `advance ${i.period}:${i.remittance_type}:${i.cycle}`;
  return { effectiveDate: i.effective_date, description: `corporate advance to ${i.custodial_account_id} for the ${i.remittance_type.toUpperCase()} ${i.cycle} draft`, lines: [
    { account: { scope: "corporate", account: "advance_receivable" }, amountCents: i.amount_cents, ruleRef: ref, memo: `servicer_advance_receivable: ${memo}` },
    { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -i.amount_cents, ruleRef: ref, memo },
    { account: { scope: "custodial", custodialAccountId: i.custodial_account_id, account: "custodial_pi_cash" }, amountCents: i.amount_cents, ruleRef: ref, memo },
    { account: { scope: "custodial", custodialAccountId: i.custodial_account_id, account: "clearing_cash" }, amountCents: -i.amount_cents, ruleRef: ref, memo: `transfer clearing: ${memo}` },
  ] };
}
export function fundDraft(em: Emitter, i: FundDraftInput): FundDraftResult {
  if (!isoDate(i.draft_date)) throw new RangeError("draft_date must be YYYY-MM-DD");
  if (i.expected_draft_cents < 0n) throw new RangeError("expected draft cannot be negative");
  const a = advanceTransfer({ expected_draft_cents: i.expected_draft_cents, custodial_available_cents: i.custodial_available_cents, facility_available_cents: i.facility_available_cents, at_ms: i.at_ms, draft_date: i.draft_date });
  const subject = cycleSubject(asPeriod(i.period), i.remittance_type, i.cycle);
  const loan = i.loan_id ? { loanId: i.loan_id } : {};
  const set = a.status === "funded" && a.amount_cents > 0n ? advanceEntrySet({ amount_cents: a.amount_cents, custodial_account_id: i.custodial_account_id, effective_date: etDate(i.at_ms), period: i.period, remittance_type: i.remittance_type, cycle: i.cycle }) : null;
  const fundedAt = a.funded_at_ms !== null ? toIso(a.funded_at_ms) : null;
  const base = { period: i.period, remittance_type: i.remittance_type, cycle: i.cycle, kind: i.kind ?? (i.remittance_type === "aa" ? "pi_actual" : "pi_scheduled"), draft_date: i.draft_date, expected_cents: i.expected_draft_cents, available_cents: i.custodial_available_cents, advance_cents: a.amount_cents, custodial_account_id: i.custodial_account_id, dual_control: a.dual_control };
  em.events.append({ type: "custodial.funding.verified", ...loan, aggregate: subject, actor: em.actor, payload: { ...base, covered: a.status === "funded", verified_at: toIso(i.at_ms), funded_by_at: toIso(a.funded_by_ms), escalation: a.escalation } });
  if (a.status === "funded") em.events.append({ type: "remittances.funded", ...loan, aggregate: subject, actor: em.actor, payload: { ...base, funded_at: fundedAt, initiator: "fnma" } });
  return { advance: a, entry_set: set, status: a.status, funded_at: fundedAt, subject };
}

// ───── rule 8: draft notifications (Loan-Level Draft Notifications API; Connect reports as fallback) ─────
export type NotificationKind = "predraft" | "bd3";
export interface DraftNotificationRow { readonly notification_id: string; readonly source: "api" | "connect_report"; readonly kind: NotificationKind; readonly filing_date: PlainDate; readonly servicer_number: string; readonly remittance_code: string; readonly draft_date: PlainDate; readonly amount_cents: Cents; readonly period: string; readonly loan_level: readonly { fnma_loan_number: string; loan_id?: string | null; amount_cents: Cents; sda_credit_cents?: Cents | null; adjustment_code?: string | null }[]; readonly document_id?: string | null; }
export function validateDraftNotification(r: Record<string, unknown>): DraftNotificationRow {
  const s = (k: string): string => { const v = r[k]; if (typeof v !== "string" || v === "") throw new RangeError(`draft notification: ${k} is required`); return v; };
  const c = (v: unknown, k: string): Cents => { try { return typeof v === "bigint" ? v : BigInt(String(v)); } catch { throw new RangeError(`draft notification: ${k} is not an amount in cents`); } };
  const source = s("source"); if (source !== "api" && source !== "connect_report") throw new RangeError("draft notification: source must be api or connect_report");
  const kind = s("kind"); if (kind !== "predraft" && kind !== "bd3") throw new RangeError("draft notification: kind must be predraft (LL-2026-05 pre-draft) or bd3");
  const filing = s("filing_date"), draft = s("draft_date"); if (!isoDate(filing) || !isoDate(draft)) throw new RangeError("draft notification: filing_date/draft_date must be YYYY-MM-DD");
  const servicer = s("servicer_number"); if (!/^\d{9}$/.test(servicer)) throw new RangeError("draft notification: servicer_number must be 9 digits");
  const amount = c(r.amount_cents, "amount_cents"); if (amount < 0n) throw new RangeError("draft notification: amount_cents cannot be negative");
  const rows = Array.isArray(r.loan_level) ? (r.loan_level as Record<string, unknown>[]) : [];
  const loanLevel = rows.map((x, n) => { const ln = x.fnma_loan_number; if (typeof ln !== "string" || !/^\d{1,10}$/.test(ln)) throw new RangeError(`draft notification: loan_level[${n}].fnma_loan_number`); return { fnma_loan_number: ln, loan_id: typeof x.loan_id === "string" ? x.loan_id : null, amount_cents: c(x.amount_cents, `loan_level[${n}].amount_cents`), sda_credit_cents: x.sda_credit_cents === undefined || x.sda_credit_cents === null ? null : c(x.sda_credit_cents, `loan_level[${n}].sda_credit_cents`), adjustment_code: typeof x.adjustment_code === "string" ? x.adjustment_code : null }; });
  if (loanLevel.length && loanLevel.reduce((a, x) => a + x.amount_cents, 0n) !== amount) throw new RangeError("draft notification: loan-level rows do not sum to amount_cents");
  const period = typeof r.period === "string" && /^\d{4}-\d{2}$/.test(r.period) ? r.period : periodOf(addMonths(plainDate(draft), -1));
  return { notification_id: typeof r.notification_id === "string" && r.notification_id !== "" ? r.notification_id : `dn-${servicer}-${s("remittance_code")}-${draft}-${kind}`, source, kind, filing_date: plainDate(filing), servicer_number: servicer, remittance_code: s("remittance_code"), draft_date: plainDate(draft), amount_cents: amount, period, loan_level: loanLevel, document_id: typeof r.document_id === "string" ? r.document_id : null };
}
/** `fnma.draft_notification.received{kind}` — a pre-draft notification (LL-2026-05) is reviewed the same BD by 15:00 ET; the BD3 notification is reconciled by BD3 12:00 ET. */
export function ingestDraftNotification(em: Emitter, row: DraftNotificationRow): { review_by_at: string | null; subject: Subject } {
  const receivedOn = etDate(Date.parse(em.now));
  const reviewBy = row.kind === "predraft" ? toIso(zonedEpochMs(receivedOn, "15:00", ET)) : null;
  const subject = periodSubject(row.period);
  em.events.append({ type: "fnma.draft_notification.received", aggregate: subject, actor: em.actor, payload: { notification_id: row.notification_id, kind: row.kind, source: row.source, filing_date: row.filing_date, servicer_number: row.servicer_number, remittance_code: row.remittance_code, draft_date: row.draft_date, amount_cents: row.amount_cents, period: row.period, loan_count: row.loan_level.length, received_at: em.now, review_by_at: reviewBy, document_id: row.document_id ?? null } });
  return { review_by_at: reviewBy, subject };
}
export interface ExpectedLoanDraft { readonly fnma_loan_number: string; readonly loan_id?: string | null; readonly expected_cents: Cents; readonly sda_active?: boolean; readonly recovery?: boolean; }
export interface LoanVariance { readonly fnma_loan_number: string; readonly loan_id: string | null; readonly expected_cents: Cents; readonly notified_cents: Cents; readonly variance_cents: Cents; readonly class: VarianceClass; readonly draft_expectation_cents: Cents; readonly officer: boolean; }
export const OFFICER_LOAN_VARIANCE_CENTS = 50_000n, OFFICER_CODE_VARIANCE_CENTS = 500_000n;   // Agents paragraph: > $500 per loan / > $5,000 per draft code with `unknown` classification → officer
/** Match Fannie Mae's loan-level rows to `remittance_calculations` by Fannie Mae loan number at $0.00 tolerance (S/S and S/A); classify each variance (rule 8); the draft expectation follows the notification for explained classes. */
export function reconcileDraftNotification(em: Emitter, i: { notification: DraftNotificationRow; expected: readonly ExpectedLoanDraft[] }): { variances: LoanVariance[]; expected_cents: Cents; notified_cents: Cents; variance_cents: Cents; draft_expectation_cents: Cents; officer: boolean; unexplained_loans: string[]; reviewed: boolean } {
  const n = i.notification;
  const byLoan = new Map(n.loan_level.map((r) => [r.fnma_loan_number, r] as const));
  const seen = new Set<string>();
  const variances: LoanVariance[] = [];
  for (const e of i.expected) {
    const r = byLoan.get(e.fnma_loan_number); seen.add(e.fnma_loan_number);
    const notified = r?.amount_cents ?? 0n;
    const v = classifyVariance(e.expected_cents, notified, { ...(e.sda_active ? { sda_active: true } : {}), ...(r?.sda_credit_cents != null ? { sda_credit_cents: r.sda_credit_cents } : {}), ...(e.recovery ? { recovery: true } : {}), ...(r?.adjustment_code ? { code: r.adjustment_code } : {}) });
    const officer = v.class === "unexplained" && (v.variance_cents > OFFICER_LOAN_VARIANCE_CENTS || v.variance_cents < -OFFICER_LOAN_VARIANCE_CENTS);
    variances.push({ fnma_loan_number: e.fnma_loan_number, loan_id: e.loan_id ?? r?.loan_id ?? null, expected_cents: e.expected_cents, notified_cents: notified, variance_cents: v.variance_cents, class: v.class, draft_expectation_cents: v.draft_expectation_cents, officer });
  }
  for (const r of n.loan_level) if (!seen.has(r.fnma_loan_number)) variances.push({ fnma_loan_number: r.fnma_loan_number, loan_id: r.loan_id ?? null, expected_cents: 0n, notified_cents: r.amount_cents, variance_cents: r.amount_cents, class: r.amount_cents === 0n ? "fnma_projection" : "unexplained", draft_expectation_cents: 0n, officer: r.amount_cents > OFFICER_LOAN_VARIANCE_CENTS || r.amount_cents < -OFFICER_LOAN_VARIANCE_CENTS });
  const expected = variances.reduce((s, v) => s + v.expected_cents, 0n), notified = n.amount_cents, draftExpectation = variances.reduce((s, v) => s + v.draft_expectation_cents, 0n);
  const unexplainedTotal = variances.filter((v) => v.class === "unexplained").reduce((s, v) => s + v.variance_cents, 0n);
  const officer = variances.some((v) => v.officer) || unexplainedTotal > OFFICER_CODE_VARIANCE_CENTS || unexplainedTotal < -OFFICER_CODE_VARIANCE_CENTS;
  const unexplained = variances.filter((v) => v.class === "unexplained").map((v) => v.fnma_loan_number);
  const subject = periodSubject(n.period);
  const payload = { notification_id: n.notification_id, kind: n.kind, period: n.period, remittance_code: n.remittance_code, draft_date: n.draft_date, expected_cents: expected, notified_cents: notified, variance_cents: notified - expected, draft_expectation_cents: draftExpectation, classes: variances.map((v) => v.class), unexplained_loans: unexplained, officer, reconciled_at: em.now };
  em.events.append({ type: "fnma.draft_notification.reconciled", aggregate: subject, actor: em.actor, payload });
  if (n.kind === "predraft") em.events.append({ type: "fnma.draft_notification.reviewed", aggregate: subject, actor: em.actor, payload: { ...payload, variance_filed: unexplained.length > 0, reviewed_at: em.now } });
  return { variances, expected_cents: expected, notified_cents: notified, variance_cents: notified - expected, draft_expectation_cents: draftExpectation, officer, unexplained_loans: unexplained, reviewed: n.kind === "predraft" };
}

// ───── proceeds receipts (Inputs: `shortsale.proceeds.received`, `settlement.received`) ─────
/** "Next month's remittance date" for a settlement (F-1-20): the loan's own draft cycle in the following month; A/A by BD1 of the following month (the F-1-20 monthly A/A deadline). */
export function nextRemittanceDate(receivedOn: PlainDate, c: { remittance_type: RemittanceTypeCode; cycle?: Cycle; rpm_day?: number | null }): PlainDate {
  if (c.remittance_type === "aa") return fannieBusinessDay(nextMonth(receivedOn), 1);
  return draftDateFor(receivedOn, { remittance_type: c.remittance_type, cycle: c.cycle ?? "standard", rpm_day: c.rpm_day ?? null })!;
}
export interface ProceedsReceipt { readonly loan_id: string; readonly kind: "short_sale" | "settlement"; readonly amount_cents: Cents; readonly received_on: PlainDate; readonly sale_closed_on?: PlainDate | null; readonly contribution_cents?: Cents | null; readonly remittance_type: RemittanceTypeCode; readonly cycle?: Cycle; readonly rpm_day?: number | null; readonly servicer_number: string; readonly fnma_loan_number: string; }
export interface ProceedsPlan { readonly remittance_id: string; readonly event: "shortsale.proceeds.received" | "settlement.received"; readonly instruct_by: PlainDate; readonly instruct_by_at: string; readonly lines: { remittance_code: string; amount_cents: Cents; kind: RemittanceKind }[]; }
/** Short-sale proceeds: CRS 357 (and 324 for a borrower contribution) within 2 `fannie_et` BDs of receipt, hard cap 3 BD after the sale (5.2-T11); settlement/make-whole proceeds: code 309 by next month's remittance date. */
export function proceedsPlan(r: ProceedsReceipt): ProceedsPlan {
  if (r.amount_cents <= 0n) throw new RangeError("proceeds must be positive");
  if (!isoDate(r.received_on)) throw new RangeError("received_on must be YYYY-MM-DD");
  if (!/^\d{1,10}$/.test(r.fnma_loan_number)) throw new RangeError("the 3xx codes require the Fannie Mae loan number");
  const id = `rem-${r.kind}-${r.loan_id}-${r.received_on}`;
  if (r.kind === "short_sale") {
    if (!r.sale_closed_on || !isoDate(r.sale_closed_on)) throw new RangeError("short-sale proceeds need sale_closed_on (the 3-BD hard cap counts from the sale)");
    if (r.sale_closed_on > r.received_on) throw new RangeError("sale_closed_on is after the receipt");
    const by = minDate(specialRemittanceDeadline(r.received_on), addBusinessDays(r.sale_closed_on, 3, fannieEt));
    const contribution = r.contribution_cents ?? 0n;
    if (contribution < 0n || contribution > r.amount_cents) throw new RangeError("contribution_cents must be between 0 and the proceeds");
    const lines = [{ remittance_code: "357", amount_cents: r.amount_cents - contribution, kind: "short_sale" as const }, ...(contribution > 0n ? [{ remittance_code: "324", amount_cents: contribution, kind: "short_sale" as const }] : [])];
    return { remittance_id: id, event: "shortsale.proceeds.received", instruct_by: by, instruct_by_at: toIso(zonedEpochMs(by, "16:00", ET)), lines };
  }
  const by = nextRemittanceDate(r.received_on, r);
  return { remittance_id: id, event: "settlement.received", instruct_by: by, instruct_by_at: toIso(zonedEpochMs(by, "16:00", ET)), lines: [{ remittance_code: "309", amount_cents: r.amount_cents, kind: "settlement" }] };
}
export function recordProceedsReceipt(em: Emitter, r: ProceedsReceipt): ProceedsPlan {
  const p = proceedsPlan(r);
  const common = { remittance_id: p.remittance_id, kind: r.kind, amount_cents: r.amount_cents, received_on: r.received_on, servicer_number: r.servicer_number, fnma_loan_number: r.fnma_loan_number, remittance_type: r.remittance_type, crs_codes: p.lines.map((l) => l.remittance_code), instruct_by: p.instruct_by, instruct_by_at: p.instruct_by_at };
  if (p.event === "shortsale.proceeds.received") em.events.append({ type: p.event, loanId: r.loan_id, actor: em.actor, payload: { ...common, sale_closed_on: r.sale_closed_on ?? null, contribution_cents: r.contribution_cents ?? 0n } });
  else em.events.append({ type: p.event, loanId: r.loan_id, actor: em.actor, payload: { ...common, next_remittance_date: p.instruct_by } });
  return p;
}

// ───── rule 9: shortage / surplus (portfolio A/A until auto-draft) ─────
export interface Schedule3Input { readonly servicer_number: string; readonly period: string; readonly opening_cents: Cents; readonly remitted_cents: Cents; readonly reported_pi_cents: Cents; readonly explained_items: readonly { kind: string; amount_cents: Cents; note: string }[]; readonly surplus_first_seen?: PlainDate | null; readonly prior_open_kind?: "surplus" | "shortage" | null; }
export type Schedule3 = ReturnType<typeof form472Schedule3> & { readonly period: string; readonly servicer_number: string; readonly first_seen_on: PlainDate | null; readonly shortage_instruct_by_at: string | null; readonly subject: Subject; readonly resolved_prior: "surplus" | "shortage" | null };
/** Schedule 3 (Form 472): an unexplained shortage is remitted immediately (CRS 001 within 1 BD); a surplus first seen on `first_seen_on` is resolved within 90 days (5.2-T10); a balanced schedule resolves the prior open item. */
export function schedule3(em: Emitter, i: Schedule3Input): Schedule3 {
  asPeriod(i.period);
  if (!/^\d{9}$/.test(i.servicer_number)) throw new RangeError("servicer_number must be 9 digits");
  const today = etDate(Date.parse(em.now));
  const f = form472Schedule3({ period: i.period, opening_cents: i.opening_cents, remitted_cents: i.remitted_cents, reported_pi_cents: i.reported_pi_cents, explained_items: i.explained_items, surplus_first_seen: i.surplus_first_seen ?? today });
  const subject = shortageSurplusSubject(i.servicer_number);
  const firstSeen = f.kind === "surplus" ? (i.surplus_first_seen ?? today) : null;
  const instructBy = f.kind === "shortage" ? toIso(zonedEpochMs(nextBusinessDay(today, fannieEt), "16:00", ET)) : null;
  const base = { servicer_number: i.servicer_number, period: i.period, closing_cents: f.closing_cents, explained_cents: f.explained_cents, amount_cents: f.unexplained_cents < 0n ? -f.unexplained_cents : f.unexplained_cents, explanation: f.explanation };
  if (f.kind === "shortage") em.events.append({ type: "fnma.shortage_surplus.shortage_confirmed", aggregate: subject, actor: em.actor, payload: { ...base, reconciled: false, detected_on: today, instruct_by_at: instructBy, crs_code: "001" } });
  else if (f.kind === "surplus") em.events.append({ type: "fnma.shortage_surplus.surplus_identified", aggregate: subject, actor: em.actor, payload: { ...base, first_seen_on: firstSeen, resolve_by: f.surplus_resolve_due_on } });
  let resolvedPrior: "surplus" | "shortage" | null = null;
  if (f.kind === "balanced" && i.prior_open_kind) { resolvedPrior = i.prior_open_kind; em.events.append({ type: "fnma.shortage_surplus.resolved", aggregate: subject, actor: em.actor, payload: { ...base, kind: i.prior_open_kind, resolved_on: today, form_472_period: i.period } }); }
  return { ...f, period: i.period, servicer_number: i.servicer_number, first_seen_on: firstSeen, shortage_instruct_by_at: instructBy, subject, resolved_prior: resolvedPrior };
}
export function resolveShortageSurplus(em: Emitter, i: { servicer_number: string; kind: "surplus" | "shortage"; period: string; form_472_document_id: string; explanation: string }): void {
  if (!i.form_472_document_id) throw new RangeError("the resolution carries the Form 472 artifact (form_472_document_id)");
  if (!i.explanation) throw new RangeError("the resolution carries its explanation");
  em.events.append({ type: "fnma.shortage_surplus.resolved", aggregate: shortageSurplusSubject(i.servicer_number), actor: em.actor, payload: { servicer_number: i.servicer_number, kind: i.kind, period: asPeriod(i.period), form_472_document_id: i.form_472_document_id, explanation: i.explanation, resolved_at: em.now } });
}

// ───── small clocks the tools and tests share ─────
export const surplusDueOn = surplusResolveDueOn;
export const lastDayOf = (period: string): PlainDate => endOfMonth(periodStart(asPeriod(period)));
export const isLastWorkDayOfMonth = (d: PlainDate): boolean => addBusinessDays(d, 1, fannieEt) > endOfMonth(d);
/** Rule 11: days a draft settled after its draft date (0 when on time). */
export const daysLate = (draftDate: PlainDate, debitDate: PlainDate): number => Math.max(0, daysBetween(draftDate, debitDate));
