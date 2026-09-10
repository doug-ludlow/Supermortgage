/**
 * §5 mechanics the acceptance tests exercise beyond the calculators in
 * lar/remittance/liquidation/sda/repurchase/delinquency-status: the reject
 * loop and head-of-line sequencing (5.1), post-close finality (5.1/5.3),
 * escrow event routing, bulk-ack escalation, the toggle-off exception queue,
 * soft-reject routing to Master Servicing, corporate advance funding (5.2),
 * DRA reconciliation / REOgram confirmation / TPS proceeds / confidence holds
 * (5.3), SDA reimbursement matching, deselection window, Form 496 line 12 and
 * SDA payoffs (5.4), g-fee bill lines, relief prediction, recovery and bill
 * variance (5.5), LAR 65 approval gate and MBS Express drafts (5.6), and the
 * F-1-21 exception/correction cycle, event-rail derivation and late-file
 * handling (5.7). Every clock is `fannie_et`; money is bigint cents.
 */
import { addMonths, parts, ymd, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollBack, fannieEt, fannieEtObserved } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { monthInterest, gfeeCheckFigure, fundingDecision, compensatoryFee, crsAaRequest, CRS_AA_THRESHOLD_CENTS } from "./remittance.ts";
import { bd2CloseMs, eventDeadlineMs, larDeadlineMs, calendarDraftDate, fundingGateMs, fannieBusinessDay, nextMonth, firstOfMonth, iredSweepDate, iredSweepRunMs, iredDeadlineMs, periodEndOf, periodStart, surplusResolveDueOn, bulkCutoffMs, removalCorrectionCloseMs, nonRemovalCorrectionCloseMs } from "./period.ts";
import { validateF121Layout } from "./delinquency-status.ts";
export { validateF121Layout };
import { actionCode, type LiquidationKind, type InsuredFlag } from "./liquidation.ts";
import { predictSda, sdaApplies, consecutiveMonthsDelinquent, type SdaStatus, type AdvanceStatus } from "./sda.ts";
import { mmddyy, zoned, projectLar96, type Lar96 } from "./lar.ts";
import type { ChannelMode, RemittanceType, LarPayload, EventFamily } from "./types.ts";

export const ET = "America/New_York";
const HOUR = 3_600_000;
const rateMilli = (pct: string): bigint => BigInt(Math.round(Number(pct) * 1000));
/** Daily interest at an annual rate on a 365-day year, half-up to cents (5.2 rule 2 A/A payoff days ÷ 365). */
export function perDiemInterest(upb: Cents, ratePct: string): Cents { return divRound(upb * rateMilli(ratePct), 365n * 100_000n); }

// ---------------------------------------------------------------------------
// 5.1 — reject loop, head-of-line, finality, escrow routing, bulk ack, toggle-off, soft rejects
// ---------------------------------------------------------------------------
export interface QueuedEvent { readonly id: string; readonly loan_id: string; readonly sequence: number; readonly status: string; readonly supersedes_event_id?: string | null; /** The reject was waived with a reason (state machine: "until the reject is superseded or waived with reason"). */ readonly waived_reason?: string | null; }
const SENDABLE = new Set(["pending", "projected", "queued"]);
/**
 * 5.1 state machine, head-of-line rule: a loan with an open `rejected_hard`/`invalid` event blocks submission of
 * later-sequence events for that loan until the reject is superseded or waived with reason. The correcting event
 * (`supersedes_event_id` → the open reject) is what clears it, so it is always sendable; ordinary unresolved events
 * travel together in sequence order (5.1-T10: two events for one loan in the same file, rule 8's LAR 96 + LAR 97 pair).
 */
export function headOfLine(queue: readonly QueuedEvent[]): { sendable: QueuedEvent[]; blocked: QueuedEvent[] } {
  const byLoan = new Map<string, QueuedEvent[]>();
  for (const e of [...queue].sort((a, b) => a.sequence - b.sequence)) byLoan.set(e.loan_id, [...(byLoan.get(e.loan_id) ?? []), e]);
  const sendable: QueuedEvent[] = []; const blocked: QueuedEvent[] = [];
  for (const events of byLoan.values()) {
    const openRejects = events.filter((e) => (e.status === "rejected_hard" || e.status === "invalid") && !e.waived_reason);
    for (const e of events) {
      if (!SENDABLE.has(e.status)) continue;
      const blocker = openRejects.find((r) => r.sequence < e.sequence && r.id !== e.supersedes_event_id);
      if (blocker) blocked.push(e); else sendable.push(e);
    }
  }
  const order = (a: QueuedEvent, b: QueuedEvent) => a.loan_id.localeCompare(b.loan_id) || a.sequence - b.sequence;
  return { sendable: sendable.sort(order), blocked: blocked.sort(order) };
}
export type RootCause = "ledger_error" | "fnma_position_mismatch" | "sequence" | "inactive_loan" | "schema" | "unknown";
export interface HardRejectTriage {
  readonly triage_due_ms: number; readonly route: "section2_correction" | "ppa_package" | "readd_package" | "requeue" | "hold";
  readonly escalate_to: "fnma_portal_operator" | "officer" | null; readonly correction_command: string | null;
  readonly superseding_event: { sequence: number; supersedes_event_id: string; activity_period: string } | null;
  readonly resubmit_by_ms: number; readonly head_of_line: boolean;
}
/** 5.1 rule 9: hard/invalid/fatal rejects are triaged within 4 hours; a ledger error becomes a Section 2 correction and a superseding event with a new sequence in the same period, due BD1 20:00 ET of the following month. */
export function triageHardReject(f: { received_at_ms: number; root_cause: RootCause; confidence: number; event: { id: string; sequence: number; activity_period: string } }): HardRejectTriage {
  const [y, m] = f.event.activity_period.split("-").map(Number) as [number, number];
  const resubmitBy = zonedEpochMs(fannieBusinessDay(nextMonth(ymd(y, m, 1)), 1), "20:00", ET);
  const base = { triage_due_ms: f.received_at_ms + 4 * HOUR, resubmit_by_ms: resubmitBy, head_of_line: true };
  if (f.confidence < 0.8) return { ...base, route: "hold", escalate_to: "officer", correction_command: null, superseding_event: null };
  switch (f.root_cause) {
    case "ledger_error": return { ...base, route: "section2_correction", escalate_to: null, correction_command: "cashiering.correction.post", superseding_event: { sequence: f.event.sequence + 1, supersedes_event_id: f.event.id, activity_period: f.event.activity_period } };
    case "fnma_position_mismatch": return { ...base, route: "ppa_package", escalate_to: "fnma_portal_operator", correction_command: null, superseding_event: null };
    case "inactive_loan": return { ...base, route: "readd_package", escalate_to: "fnma_portal_operator", correction_command: null, superseding_event: null };
    case "sequence": return { ...base, route: "requeue", escalate_to: null, correction_command: null, superseding_event: null };
    default: return { ...base, route: "hold", escalate_to: "officer", correction_command: null, superseding_event: null };
  }
}
/** 5.1 rule 11 / 5.3 rule 6 (SVC-2026-03 finality): a removal discovered wrong after BD2 17:00 ET of the following month is never corrected — a `qc_finding` opens and the amount Fannie Mae is owed is computed. */
export function postCloseRemovalError(f: { accepted_period: string; discovered_at_ms: number; reported_principal_cents: Cents; reported_interest_cents: Cents }): { after_close: boolean; correction_projected: boolean; case: "qc_finding" | null; fnma_liquidated_in_error: boolean; amount_due_cents: Cents; escalation: "officer" | null; close_ms: number } {
  const [y, m] = f.accepted_period.split("-").map(Number) as [number, number];
  const close = bd2CloseMs(nextMonth(ymd(y, m, 1)));
  const after = f.discovered_at_ms > close;
  return { after_close: after, correction_projected: !after, case: after ? "qc_finding" : null, fnma_liquidated_in_error: after, amount_due_cents: after ? f.reported_principal_cents + f.reported_interest_cents : 0n, escalation: after ? "officer" : null, close_ms: close };
}
/** 5.1-T6: escrow deposits have no LAR; the JSON goes to `api-clve` under `dual` and to production (next BD 03:00 ET) under `event`. */
export function escrowDepositRouting(mode: ChannelMode, postedAtMs: number): { lar: null; json_env: "api-clve" | "production" | null; submit_by_ms: number | null } {
  if (mode === "legacy") return { lar: null, json_env: null, submit_by_ms: null };
  if (mode === "dual") return { lar: null, json_env: "api-clve", submit_by_ms: null };
  return { lar: null, json_env: "production", submit_by_ms: eventDeadlineMs(postedAtMs) };
}
/** 5.1-T7: bulk file unacknowledged at BD2 14:00 ET → one re-send; still unacknowledged at 14:30 → `human_portal_task` with the file, due 15:00 ET (the bulk cutoff). */
export function bulkAckWatch(f: { file_id: string; acked: boolean; resent: boolean; now_ms: number; bd2: PlainDate }): { action: "wait" | "resend" | "portal_task" | "done"; task: { kind: "human_portal_task"; file_id: string; due_ms: number } | null } {
  if (f.acked) return { action: "done", task: null };
  const t1400 = zonedEpochMs(f.bd2, "14:00", ET), t1430 = zonedEpochMs(f.bd2, "14:30", ET);
  if (f.now_ms >= t1430 && f.resent) return { action: "portal_task", task: { kind: "human_portal_task", file_id: f.file_id, due_ms: zonedEpochMs(f.bd2, "15:00", ET) } };
  if (f.now_ms >= t1400 && !f.resent) return { action: "resend", task: null };
  return { action: "wait", task: null };
}
export const LAR_DECISION_FIELDS = ["event_id", "exception_code", "root_cause", "evidence", "action", "deadline_at", "confidence", "model_version", "rule_set_version"] as const;
export type LarDecisionRecord = Record<(typeof LAR_DECISION_FIELDS)[number], unknown>;
/** 5.1 toggle-off path (T11): with the agent disabled a human works the same queue with the identical decision-record schema; timers are unaffected. */
export function workException(f: { agent_enabled: boolean; actor: { kind: "agent" | "human"; id: string }; event_id: string; exception_code: string; root_cause: RootCause; evidence: readonly string[]; action: string; deadline_at: string; confidence: number; rule_set_version: string; model_version?: string }): { record: LarDecisionRecord; worked_by: "agent" | "human"; timers_fire: true } {
  if (!f.agent_enabled && f.actor.kind === "agent") throw new RangeError("agents.investor_reporting.enabled=false: the exception queue is worked by a human");
  const record: LarDecisionRecord = { event_id: f.event_id, exception_code: f.exception_code, root_cause: f.root_cause, evidence: [...f.evidence], action: f.action, deadline_at: f.deadline_at, confidence: f.confidence, model_version: f.actor.kind === "human" ? `human:${f.actor.id}` : (f.model_version ?? "unversioned"), rule_set_version: f.rule_set_version };
  return { record, worked_by: f.actor.kind, timers_fire: true };
}
/** 5.1 rule 9 soft rejects: our figures wrong → correct; Fannie Mae's expected interest wrong (curtailment in period) → Master Servicing package with pay history, status stays `rejected_soft`. */
export function softRejectInterest(f: { our_interest_cents: Cents; fnma_expected_cents: Cents; curtailment_in_period: boolean; pay_history: readonly { date: PlainDate; amount_cents: Cents; kind: string }[] }): { variance_cents: Cents; route: "correct" | "master_servicing@fanniemae.com"; status: "rejected_soft" | "corrected"; package: { pay_history: readonly { date: PlainDate; amount_cents: Cents; kind: string }[]; explanation: string } | null } {
  const variance = f.our_interest_cents - f.fnma_expected_cents;
  if (!f.curtailment_in_period) return { variance_cents: variance, route: "correct", status: "corrected", package: null };
  return { variance_cents: variance, route: "master_servicing@fanniemae.com", status: "rejected_soft", package: { pay_history: f.pay_history, explanation: "Fannie Mae's expected interest ignores the mid-month curtailment; interest reported on the pre-curtailment balance for the days it was outstanding" } };
}
export function closeSoftRejectAtPeriodClose(f: { fnma_adjusted: boolean; decision_id: string }): { status: "accepted"; resolution: "fnma_adjusted" | "accepted_as_is"; audit_note: string; decision_id: string } {
  return { status: "accepted", resolution: f.fnma_adjusted ? "fnma_adjusted" : "accepted_as_is", audit_note: f.fnma_adjusted ? "Fannie Mae adjusted its expected interest before period close" : "period closed with the soft reject unadjusted; our figures stand (Master Servicing package on file)", decision_id: f.decision_id };
}

// ---------------------------------------------------------------------------
// 5.2 — corporate advance funding, S/A reinstatement, A/A split
// ---------------------------------------------------------------------------
export interface AdvanceTransfer { readonly command: "advance"; readonly amount_cents: Cents; readonly dual_control: boolean; readonly status: "funded" | "escalated"; readonly funded_at_ms: number | null; readonly funded_by_ms: number; readonly escalation: "officer" | null; readonly ledger: readonly { account: string; side: "Dr" | "Cr"; amount_cents: Cents }[] }
/** 5.2 rule 7 + guardrail: a T−1 16:00 ET shortfall issues the `advance` command (dual control above $250,000); an exhausted corporate facility escalates to `officer`. */
export function advanceTransfer(f: { expected_draft_cents: Cents; custodial_available_cents: Cents; facility_available_cents: Cents; at_ms: number; draft_date: PlainDate }): AdvanceTransfer {
  const d = fundingDecision(f.expected_draft_cents, f.custodial_available_cents);
  const fundedBy = zonedEpochMs(addBusinessDays(f.draft_date, -1, fannieEt), "17:00", ET);
  const ledger = [{ account: "servicer_advance_receivable", side: "Dr" as const, amount_cents: d.shortfall_cents }, { account: "custodial_pi_cash", side: "Cr" as const, amount_cents: d.shortfall_cents }];
  if (!d.advance) return { command: "advance", amount_cents: 0n, dual_control: false, status: "funded", funded_at_ms: f.at_ms, funded_by_ms: fundedBy, escalation: null, ledger: [] };
  if (f.facility_available_cents < d.shortfall_cents) return { command: "advance", amount_cents: d.shortfall_cents, dual_control: d.dual_control, status: "escalated", funded_at_ms: null, funded_by_ms: fundedBy, escalation: "officer", ledger };
  return { command: "advance", amount_cents: d.shortfall_cents, dual_control: d.dual_control, status: "funded", funded_at_ms: f.at_ms, funded_by_ms: fundedBy, escalation: null, ledger };
}
/** 5.2 worked example 4 (IRM 4-07): on reinstatement the engine reports prior UPB × PTR ÷ 12 × months from the prior LPI through period end. */
export function saReinstatementInterest(priorUpb: Cents, ptr: string, months: number): Cents { return monthInterest(priorUpb, ptr) * BigInt(months); }
/** 5.2 worked example 5: the A/A contractual payment split at note rate and PTR. */
export function aaPaymentSplit(upb: Cents, noteRate: string, ptr: string, piCents: Cents): { note_interest_cents: Cents; principal_cents: Cents; fnma_interest_cents: Cents; servicing_fee_cents: Cents; remittance_cents: Cents; crs_same_day: boolean } {
  const noteInterest = monthInterest(upb, noteRate), fnmaInterest = monthInterest(upb, ptr);
  const principal = piCents - noteInterest;
  return { note_interest_cents: noteInterest, principal_cents: principal, fnma_interest_cents: fnmaInterest, servicing_fee_cents: noteInterest - fnmaInterest, remittance_cents: fnmaInterest + principal, crs_same_day: fnmaInterest + principal > CRS_AA_THRESHOLD_CENTS };
}

// ---------------------------------------------------------------------------
// 5.3 — payoff clocks, DRA reconciliation, REOgram, P360 event, confidence hold, TPS proceeds
// ---------------------------------------------------------------------------
/** 5.2 rule 2 / edge "Payoff on BD1 reported by BD2 (S/S)": no full-month interest when processed on BD1 and reported by the BD2 17:00 ET clock. */
export function ssPayoffInterest(f: { scheduled_upb_cents: Cents; ptr: string; processed_at_ms: number; reported_at_ms: number }): { full_month_cents: Cents; waived: boolean; charged_cents: Cents; deadline_ms: number } {
  const processedOn = wallClock(f.processed_at_ms, ET).date;
  const onBd1 = fannieBusinessDay(processedOn, 1) === processedOn;
  const deadline = larDeadlineMs(f.processed_at_ms, true);
  const waived = onBd1 && f.reported_at_ms <= deadline;
  const full = monthInterest(f.scheduled_upb_cents, f.ptr);
  return { full_month_cents: full, waived, charged_cents: waived ? 0n : full, deadline_ms: deadline };
}
export interface DraMilestone { readonly type: string; readonly date: PlainDate; }
/** 5.3 rule 7: a DRA sale-held without our `foreclosure.sale.held` within 1 BD → sev-1 and the REOgram confirmation task pre-created (due 1 `fannie_et` BD); our sale events without a DRA entry within 2 BD → task to the firm. */
export function reconcileDra(f: { dra: readonly DraMilestone[]; ours: readonly DraMilestone[]; as_of: PlainDate }): { sev1: { milestone: DraMilestone; reogram_task_due: PlainDate }[]; firm_tasks: DraMilestone[]; matched: number } {
  const same = (a: DraMilestone, b: DraMilestone) => a.type === b.type && a.date === b.date;
  const sev1 = f.dra.filter((d) => d.type === "sale_held" && !f.ours.some((o) => same(o, d)) && f.as_of >= addBusinessDays(d.date, 1, fannieEt)).map((milestone) => ({ milestone, reogram_task_due: addBusinessDays(f.as_of, 1, fannieEt) }));
  const firm_tasks = f.ours.filter((o) => /sale/.test(o.type) && !f.dra.some((d) => same(o, d)) && f.as_of >= addBusinessDays(o.date, 2, fannieEt));
  return { sev1, firm_tasks, matched: f.dra.filter((d) => f.ours.some((o) => same(o, d))).length };
}
/** E-4.1-01: REOgram confirmation is due 1 `fannie_et` business day after receipt on Fannie Mae's observed calendar (§5.3-T8: "Fannie Mae holidays Nov 26–27"); a warning fires at 70% of the window. */
export function reogramConfirmation(receivedAtMs: number): { due_on: PlainDate; due_ms: number; warning_at_ms: number; role: "fnma_portal_operator" } {
  const dueOn = addBusinessDays(wallClock(receivedAtMs, ET).date, 1, fannieEtObserved);
  const dueMs = zonedEpochMs(dueOn, "17:00", ET);
  return { due_on: dueOn, due_ms: dueMs, warning_at_ms: receivedAtMs + Math.round((dueMs - receivedAtMs) * 0.7), role: "fnma_portal_operator" };
}
export interface LiquidationProjection { readonly lar: { action_code: string; action_date: string; principal: string; interest: string; upb: string }; readonly p360_event: Record<string, string> | null; readonly env: "production" | "api-clve" | null; readonly diff: string[] }
/** 5.3 rule 9 / T9: under `mode=event` the same `liquidation_facts` row also projects the Property 360 liquidation event JSON (to `api-clve` during CIT) and the two projections are diffed field by field. */
export function projectLiquidationEvent(f: { mode: ChannelMode; kind: LiquidationKind; insured: InsuredFlag; principal_cents: Cents; interest_cents: Cents; legal_date: PlainDate; fnma_loan_number: string; cit: boolean }): LiquidationProjection {
  const code = actionCode(f.kind, f.insured);
  const lar = { action_code: code, action_date: mmddyy(f.legal_date), principal: zoned(f.principal_cents), interest: zoned(f.interest_cents), upb: zoned(0n) };
  if (f.mode === "legacy") return { lar, p360_event: null, env: null, diff: [] };
  const eventType = f.kind === "third_party_sale" ? "Third-Party Sale" : code === "72" ? "Government Conveyance" : "REO";
  const p360 = { "Loan Identifier": f.fnma_loan_number, "Liquidation Event Type": eventType, "Liquidation Action Code": code, "Liquidation Effective Date": f.legal_date, "Principal Amount": (Number(f.principal_cents) / 100).toFixed(2), "Interest Amount": (Number(f.interest_cents) / 100).toFixed(2) };
  const diff: string[] = [];
  if (p360["Liquidation Action Code"] !== lar.action_code) diff.push("action_code");
  if (mmddyy(p360["Liquidation Effective Date"] as PlainDate) !== lar.action_date) diff.push("action_date");
  if (zoned(BigInt(Math.round(Number(p360["Principal Amount"]) * 100))) !== lar.principal) diff.push("principal");
  if (zoned(BigInt(Math.round(Number(p360["Interest Amount"]) * 100))) !== lar.interest) diff.push("interest");
  return { lar, p360_event: p360, env: f.cit ? "api-clve" : "production", diff };
}
/** 5.3 guardrail: confidence < 0.9 on 70 vs 71 vs 72 → hold, `human_agent` review requested at deadline − 4h; the timer still breaches if unresolved and the evidence is retained. */
export function removalConfidenceHold(f: { confidence: number; deadline_ms: number; candidates: readonly string[]; evidence: readonly string[] }): { held: boolean; review: { role: "human_agent"; request_at_ms: number; candidates: readonly string[] } | null; breaches_if_unresolved: true; evidence_retained: readonly string[] } {
  const held = f.confidence < 0.9;
  return { held, review: held ? { role: "human_agent", request_at_ms: f.deadline_ms - 4 * HOUR, candidates: f.candidates } : null, breaches_if_unresolved: true, evidence_retained: f.evidence };
}
/** 5.3 worked example: third-party sale proceeds go by CRS 311, instructed by 16:00 ET the BD after receipt and settling the next BD; proceeds below indebtedness go entirely to Fannie Mae and a TPS case is reconciled in P360. */
export function tpsProceeds(f: { bid_cents: Cents; received_on: PlainDate; scheduled_upb_cents: Cents; ptr: string; lpi_due: PlainDate; sale_on: PlainDate; settlement_on: PlainDate }): { crs_code: "311"; amount_cents: Cents; instruct_by_ms: number; settles_on: PlainDate; indebtedness_cents: Cents; to_fnma_cents: Cents; surplus_cents: Cents; tps_case: boolean } {
  const through = f.sale_on > f.settlement_on ? f.sale_on : f.settlement_on;
  let months = 0; let d = addMonths(f.lpi_due, 1); while (d <= through) { months++; d = addMonths(d, 1); }
  const indebtedness = f.scheduled_upb_cents + monthInterest(f.scheduled_upb_cents, f.ptr) * BigInt(months);
  const instructOn = addBusinessDays(f.received_on, 1, fannieEt);
  const toFnma = f.bid_cents < indebtedness ? f.bid_cents : indebtedness;
  return { crs_code: "311", amount_cents: toFnma, instruct_by_ms: zonedEpochMs(instructOn, "16:00", ET), settles_on: addBusinessDays(instructOn, 1, fannieEt), indebtedness_cents: indebtedness, to_fnma_cents: toFnma, surplus_cents: f.bid_cents - toFnma, tps_case: true };
}

// ---------------------------------------------------------------------------
// 5.4 — reimbursement matching, deselection window, status variance, Form 496, SDA payoff, fee component
// ---------------------------------------------------------------------------
export interface AdvanceRow { readonly period: string; readonly amount_cents: Cents; readonly status: AdvanceStatus; }
/** 5.4 rule 5(b)/(e): reimbursement credits are matched FIFO to `advances` rows; all rows must reach `reimbursed_by_fnma` within two draft cycles or the Investor Reporting Representative package escalates. */
export function matchReimbursements(f: { advances: readonly AdvanceRow[]; credits: readonly Cents[]; cycles_elapsed: number }): { advances: AdvanceRow[]; all_reimbursed: boolean; unmatched_credit_cents: Cents; escalation: "irr_package" | null } {
  let pool = f.credits.reduce((a, b) => a + b, 0n);
  const out: AdvanceRow[] = [];
  for (const a of [...f.advances].sort((x, y) => x.period.localeCompare(y.period))) {
    if (a.status !== "outstanding") { out.push(a); continue; }
    if (pool >= a.amount_cents) { pool -= a.amount_cents; out.push({ ...a, status: "reimbursed_by_fnma" }); } else out.push(a);
  }
  const all = out.every((a) => a.status !== "outstanding");
  return { advances: out, all_reimbursed: all, unmatched_credit_cents: pool, escalation: !all && f.cycles_elapsed >= 2 ? "irr_package" : null };
}
/** 5.4 rule 1 / F-1-25: regular servicing option S/S loans never enter SDA; at six consecutive months Fannie Mae's reclass selection is expected and the deselection decision task runs CD11 → CD15. */
export function regularOptionSixMonths(f: { lpi: PlainDate; period_end: PlainDate; type: RemittanceType; option: "special" | "regular" }): { months_delinquent: number; sda: SdaStatus; advances_continue: boolean; reclass_selection_expected: boolean; deselection_task: { created_on: PlainDate; due_on: PlainDate } | null } {
  const months = consecutiveMonthsDelinquent(f.lpi, f.period_end);
  const sda = predictSda(f.lpi, f.type, f.option, f.period_end).status;
  const six = f.option === "regular" && months >= 6;
  const next = nextMonth(f.period_end); const { y, m } = parts(next);
  return { months_delinquent: months, sda, advances_continue: !sdaApplies(f.type, f.option) || sda !== "active", reclass_selection_expected: six, deselection_task: six ? { created_on: ymd(y, m, 11), due_on: ymd(y, m, 15) } : null };
}
/** 5.4 T6: Fannie Mae's report shows Stop Advance where we predicted fewer months → sev-2 variance comparing LPI dates and the 5.1 reporting history. */
export function sdaStatusVariance(f: { predicted: SdaStatus; predicted_months: number; fnma_status: "stop_advance" | "advancing"; our_lpi: PlainDate; fnma_lpi: PlainDate | null; reporting_history: readonly { period: string; lpi: PlainDate; status: string }[] }): { variance: { severity: "sev2"; kind: "sda_status_mismatch"; our_lpi: PlainDate; fnma_lpi: PlainDate | null; predicted_months: number; reporting_history: readonly { period: string; lpi: PlainDate; status: string }[] } | null; authoritative: "fnma" } {
  const mismatch = (f.fnma_status === "stop_advance") !== (f.predicted === "active" || f.predicted === "predicted");
  return { variance: mismatch ? { severity: "sev2", kind: "sda_status_mismatch", our_lpi: f.our_lpi, fnma_lpi: f.fnma_lpi, predicted_months: f.predicted_months, reporting_history: f.reporting_history } : null, authoritative: "fnma" };
}
export const FORM_496_LINE_12_EXPLANATION = "Offsetting adjustment: Fannie Mae outstanding P&I receivable on Stop Delinquency Advance loans per the Remittance Detail – P&I report (LSDU Cash Position P&I Details)";
/** 5.4 rule 6: Section II line 12 = Σ Fannie Mae-reported `fm_pi_receivable` across SDA loans, sourced from the report, never from our prediction. */
export function form496Line12(rows: readonly { loan_id: string; sda_status: SdaStatus; fm_pi_receivable_reported_cents: Cents }[]): { amount_cents: Cents; loans: string[]; explanation: string; source: "remittance_detail_pi" } {
  const sda = rows.filter((r) => r.sda_status === "active");
  return { amount_cents: sda.reduce((a, r) => a + r.fm_pi_receivable_reported_cents, 0n), loans: sda.map((r) => r.loan_id), explanation: FORM_496_LINE_12_EXPLANATION, source: "remittance_detail_pi" };
}
/** 5.4 rule 5(d): a payoff of an SDA loan remits Fannie Mae's outstanding P&I receivable with the payoff; the servicer's advances are recovered from the proceeds/borrower per the payoff calculator (16.2). */
export function sdaPayoffRemittance(f: { payoff_upb_cents: Cents; payoff_interest_cents: Cents; fm_pi_receivable_cents: Cents; servicer_advances_outstanding_cents: Cents; proceeds_cents: Cents }): { remittance_cents: Cents; includes_fm_receivable: boolean; servicer_recovery_cents: Cents; recovery_source: "payoff_proceeds" | "borrower_balance"; shortfall_cents: Cents } {
  const remit = f.payoff_upb_cents + f.payoff_interest_cents + f.fm_pi_receivable_cents;
  const available = f.proceeds_cents - remit;
  const fromProceeds = available >= f.servicer_advances_outstanding_cents ? f.servicer_advances_outstanding_cents : (available > 0n ? available : 0n);
  return { remittance_cents: remit, includes_fm_receivable: f.fm_pi_receivable_cents > 0n, servicer_recovery_cents: f.servicer_advances_outstanding_cents, recovery_source: fromProceeds === f.servicer_advances_outstanding_cents ? "payoff_proceeds" : "borrower_balance", shortfall_cents: f.servicer_advances_outstanding_cents - fromProceeds };
}
/** 5.4 rule 4: the servicing-fee component of a contractual payment = interest at the note rate − PTR interest − g-fee. */
export function servicingFeeComponent(upb: Cents, noteRate: string, ptr: string, gfeePct: string): Cents { return monthInterest(upb, noteRate) - monthInterest(upb, ptr) - monthInterest(upb, gfeePct); }

// ---------------------------------------------------------------------------
// 5.5 — g-fee bill lines, drafts, relief prediction, recovery, bill variance
// ---------------------------------------------------------------------------
/** 5.5 rule 1: bill line = prior scheduled UPB × g-fee ÷ 12 ± buy-up/buy-down. */
export function gfeeBillLine(priorScheduledUpb: Cents, gfeePct: string, adjustmentCents = 0n): Cents { return gfeeCheckFigure(priorScheduledUpb, gfeePct) + adjustmentCents; }
/** 5.5 rule 2: the g-fee draft is CD7 (preceding `fannie_et` BD); the funding gate is −1 BD 16:00 ET. */
export function gfeeDraft(monthOf: PlainDate): { draft_on: PlainDate; funding_gate_ms: number } { const on = calendarDraftDate(firstOfMonth(monthOf), 7); return { draft_on: on, funding_gate_ms: fundingGateMs(on) }; }
/** 5.5 rule 3 (SVC-2026-02): relief is predicted at four consecutive months like SDA; special-servicing S/S loans must agree with `sda_status`, regular-option MBS loans diverge by design (relief without stopping P&I advances). */
export function gfeeReliefPrediction(f: { lpi: PlainDate; period_end: PlainDate; type: RemittanceType; option: "special" | "regular"; sda_status: SdaStatus; bill_line_cents: Cents }): { months_delinquent: number; gfee_relief_status: SdaStatus; bill_expected_cents: Cents; consistent: boolean; expected_divergence: boolean; alert: boolean; assertion: string } {
  const months = consecutiveMonthsDelinquent(f.lpi, f.period_end);
  const relief: SdaStatus = f.type !== "SS" ? "not_applicable" : months >= 4 ? "predicted" : "not_applicable";
  const inRelief = relief !== "not_applicable";
  const sdaIn = f.sda_status === "predicted" || f.sda_status === "active";
  const expectedDivergence = f.option === "regular" && inRelief;
  const consistent = expectedDivergence ? true : inRelief === sdaIn;
  return { months_delinquent: months, gfee_relief_status: relief, bill_expected_cents: inRelief ? 0n : f.bill_line_cents, consistent, expected_divergence: expectedDivergence, alert: !consistent, assertion: expectedDivergence ? "regular servicing option MBS loan: g-fee relief active while P&I advances continue until removal (documented expected divergence)" : inRelief ? "special servicing S/S loan: sda_status must also be predicted/active" : "not in relief" };
}
/** 5.5 rule 4: each contractual payment's g-fee is drafted first against `outstanding_fnma_gfee`; once that is zero the servicer retains later payments' g-fee against `servicer_gfee_advances`, FIFO per bill line. */
export function gfeeRecovery(f: { outstanding_fnma_gfee_cents: Cents; servicer_gfee_advances_cents: Cents; payment_gfees_cents: readonly Cents[] }): { bill_draft_cents: Cents; servicer_retention_cents: Cents; lines: { payment_gfee_cents: Cents; to_fnma_cents: Cents; retained_cents: Cents }[]; remaining_fnma_cents: Cents; remaining_servicer_advances_cents: Cents } {
  let fnma = f.outstanding_fnma_gfee_cents, adv = f.servicer_gfee_advances_cents;
  const lines = f.payment_gfees_cents.map((g) => {
    const toFnma = g <= fnma ? g : fnma; fnma -= toFnma;
    const rest = g - toFnma; const retained = rest <= adv ? rest : adv; adv -= retained;
    return { payment_gfee_cents: g, to_fnma_cents: toFnma, retained_cents: retained };
  });
  return { bill_draft_cents: lines.reduce((a, l) => a + l.to_fnma_cents, 0n), servicer_retention_cents: lines.reduce((a, l) => a + l.retained_cents, 0n), lines, remaining_fnma_cents: fnma, remaining_servicer_advances_cents: adv };
}
/** 5.5 guardrail: bill total vs check-figure total beyond the greater of $500 or 0.5% → `officer` with the per-loan variance list. */
export function gfeeBillVariance(f: { bill_total_cents: Cents; computed_total_cents: Cents; per_loan: readonly { loan_id: string; bill_cents: Cents; computed_cents: Cents }[] }): { variance_cents: Cents; threshold_cents: Cents; escalation: "officer" | null; per_loan_variances: { loan_id: string; variance_cents: Cents }[] } {
  const v = f.bill_total_cents - f.computed_total_cents; const abs = v < 0n ? -v : v;
  const half = divRound(f.computed_total_cents * 5n, 1000n); const threshold = half > 50_000n ? half : 50_000n;
  return { variance_cents: v, threshold_cents: threshold, escalation: abs > threshold ? "officer" : null, per_loan_variances: f.per_loan.map((l) => ({ loan_id: l.loan_id, variance_cents: l.bill_cents - l.computed_cents })).filter((l) => l.variance_cents !== 0n && (l.variance_cents > 1n || l.variance_cents < -1n)) };
}

// ---------------------------------------------------------------------------
// 5.6 — LAR 65 approval gate, MBS Express unscheduled draft
// ---------------------------------------------------------------------------
/** 5.6 guardrail: LAR 65/67 is projected only after the approval document is attached; the event keeps the original processed timestamp (the removal clock never moves). */
export function projectLar65(f: { approval_document_id: string | null; processed_at_ms: number; arm_modification_feature: boolean }): { blocked: boolean; escalation: "officer" | null; event: { action_code: "65" | "67"; processed_at_ms: number; due_ms: number } | null } {
  if (!f.approval_document_id) return { blocked: true, escalation: "officer", event: null };
  return { blocked: false, escalation: null, event: { action_code: f.arm_modification_feature ? "67" : "65", processed_at_ms: f.processed_at_ms, due_ms: larDeadlineMs(f.processed_at_ms, true) } };
}
/** 5.6 rule 4 / F-1-20: MBS Express unscheduled principal reported in a month is drafted BD4 of the following month. */
export function mbsExpressUnscheduledDraft(reportedInMonth: PlainDate): PlainDate { return fannieBusinessDay(nextMonth(reportedInMonth), 4); }

// ---------------------------------------------------------------------------
// 5.7 — exception/correction cycle, event-rail derivation, late transmission
// ---------------------------------------------------------------------------
export interface DqException { readonly loan_id: string; readonly code: string; readonly severity: "critical" | "noncritical"; }
/** 5.7 rule 8: BD4 exception report → critical corrections by CD10 (the published calendar date, or its preceding `fannie_et` BD); CD11 final report reconciles line by line. */
export function dqExceptionCycle(f: { file_month: PlainDate; exceptions: readonly DqException[]; published_cd10: PlainDate }): { critical: DqException[]; noncritical: DqException[]; corrections_due_on: PlainDate; corrections_due_ms: number; final_report_on: PlainDate; status: "exceptions_open" | "final" } {
  const critical = f.exceptions.filter((e) => e.severity === "critical"), noncritical = f.exceptions.filter((e) => e.severity !== "critical");
  const due = rollBack(f.published_cd10, fannieEt); const { y, m } = parts(f.file_month);
  return { critical, noncritical, corrections_due_on: due, corrections_due_ms: zonedEpochMs(due, "17:00", ET), final_report_on: ymd(y, m, 11), status: critical.length ? "exceptions_open" : "final" };
}
export function reconcileFinalReport(f: { lines: readonly { loan_id: string; status_code: string }[]; final: readonly { loan_id: string; status_code: string; exception: string | null }[] }): { critical_remaining: number; mismatched: string[]; status: "final" | "exceptions_open" } {
  const mismatched = f.lines.filter((l) => { const r = f.final.find((x) => x.loan_id === l.loan_id); return !r || r.status_code !== l.status_code; }).map((l) => l.loan_id);
  const critical = f.final.filter((x) => x.exception !== null).length;
  return { critical_remaining: critical, mismatched, status: critical === 0 && mismatched.length === 0 ? "final" : "exceptions_open" };
}
const ACTION_TYPES: Record<string, { servicer_action_type: string; amn_status: string }> = {
  breach_letter_sent: { servicer_action_type: "Breach Letter Sent", amn_status: "80" },
  payment_reminder_notice: { servicer_action_type: "Payment Reminder Notice", amn_status: "42" },
  outbound_contact_attempted: { servicer_action_type: "Outbound Contact Attempted", amn_status: "42" },
  qrpc_achieved: { servicer_action_type: "QRPC Achieved", amn_status: "AW" },
  referred_to_foreclosure: { servicer_action_type: "Referred to Foreclosure", amn_status: "43" },
};
/** 5.7 rule 6 / LL-2026-05: each delinquency action is one event with a Servicer Action Type, due next BD 03:00 ET (to `api-clve` under `dual`); the legacy AMN line carries the mapped code with the action date as effective date. */
export function dqEventForAction(f: { action: keyof typeof ACTION_TYPES | string; processed_at_ms: number; mode: ChannelMode }): { servicer_action_type: string; env: "api-clve" | "production" | null; submit_by_ms: number; amn_line: { status: string; effective: string; completion: string } } {
  const a = ACTION_TYPES[f.action]; if (!a) throw new RangeError(`no servicer action type for ${f.action}`);
  const d = wallClock(f.processed_at_ms, ET).date;
  return { servicer_action_type: a.servicer_action_type, env: f.mode === "legacy" ? null : f.mode === "dual" ? "api-clve" : "production", submit_by_ms: eventDeadlineMs(f.processed_at_ms), amn_line: { status: a.amn_status, effective: d.replaceAll("-", ""), completion: "        " } };
}
/** 5.7 timer F-1-21: the file is due BD2 17:00 ET; a later transmission sets `late`, opens an `officer` escalation recording a potential compensatory-fee instance, and lists on the Compliance Sentinel report. */
export function amnTransmission(f: { period_month: PlainDate; transmitted_at_ms: number; record_count: number }): { due_ms: number; late: boolean; escalation: "officer" | null; compfee_instance: { kind: "late_delinquency_file"; period: string; minutes_late: number } | null; sentinel_line: string | null } {
  const due = bd2CloseMs(nextMonth(f.period_month)); const late = f.transmitted_at_ms > due;
  const period = f.period_month.slice(0, 7);
  return { due_ms: due, late, escalation: late ? "officer" : null, compfee_instance: late ? { kind: "late_delinquency_file", period, minutes_late: Math.round((f.transmitted_at_ms - due) / 60_000) } : null, sentinel_line: late ? `F-1-21 delinquency file for ${period} transmitted ${Math.round((f.transmitted_at_ms - due) / 60_000)} minutes after BD2 17:00 ET (${f.record_count} records) — potential compensatory-fee instance` : null };
}
/** 5.7-T7 / rule 7: a line that fails a consistency check is blocked from the file and escalated before the BD2 17:00 ET transmission deadline. */
export function consistencyBlock(f: { loan_id: string; period_month: PlainDate; errors: readonly string[] }): { blocked: boolean; escalation: { role: "investor-reporting"; severity: "sev2"; loan_id: string; before_ms: number; errors: readonly string[] } | null } {
  if (!f.errors.length) return { blocked: false, escalation: null };
  return { blocked: true, escalation: { role: "investor-reporting", severity: "sev2", loan_id: f.loan_id, before_ms: bd2CloseMs(nextMonth(f.period_month)), errors: f.errors } };
}
/** 5.7 guardrail: confidence < 0.85 → the line is flagged for `human_agent` review before BD2; the file still transmits on time with the best code and a correction follows by CD10 if the review changes it. */
export function lineReviewFlag(f: { confidence: number; period_month: PlainDate; published_cd10?: PlainDate }): { flagged: boolean; role: "human_agent" | null; review_before_ms: number; transmits_on_time: true; correction_by_ms: number } {
  const next = nextMonth(f.period_month); const { y, m } = parts(next);
  const cd10 = rollBack(f.published_cd10 ?? ymd(y, m, 10), fannieEt);
  return { flagged: f.confidence < 0.85, role: f.confidence < 0.85 ? "human_agent" : null, review_before_ms: bd2CloseMs(next), transmits_on_time: true, correction_by_ms: zonedEpochMs(cd10, "17:00", ET) };
}

// ---------------------------------------------------------------------------
// 5.1 — IRED "no activity" projection, period-close checklist, exception events
// ---------------------------------------------------------------------------
export interface NoActivityProjection { readonly event_type: "payment.none"; readonly payload: LarPayload; readonly lar: Lar96 | null; readonly json_event: { "Loan Identifier": string; "Loan Actual UPB Amount": string; "Loan Last Paid Installment Due Date": string | null; "Loan Event Sequence Number": number } | null; readonly sweep_run_ms: number; readonly submit_by_ms: number }
/** 5.1 rule 4: on the IRED sweep every summary-reporting loan without an accepted `payment.*` event in the period gets `payment.none` — LAR 96 with unchanged LPI/UPB, zero interest/principal, action `00` (or the No Payment Event under `mode=event`). */
export function noActivityProjection(f: { month_of: PlainDate; mode: ChannelMode; servicer_number: string; fnma_loan_number: string; sequence: number; position: { lpi_date: PlainDate | null; upb_cents: Cents; nib_cents: Cents } }): NoActivityProjection {
  const sweepOn = iredSweepDate(f.month_of);
  const payload: LarPayload = { lpi_date: f.position.lpi_date, upb_cents: f.position.upb_cents, nib_cents: f.position.nib_cents, interest_cents: 0n, principal_cents: 0n, other_fees_cents: 0n, action_code: "00", action_date: sweepOn };
  const lar = f.mode === "event" ? null : projectLar96(f.servicer_number, f.fnma_loan_number, payload);
  const json = f.mode === "legacy" ? null : { "Loan Identifier": f.fnma_loan_number, "Loan Actual UPB Amount": (Number(f.position.upb_cents) / 100).toFixed(2), "Loan Last Paid Installment Due Date": f.position.lpi_date, "Loan Event Sequence Number": f.sequence };
  return { event_type: "payment.none", payload, lar, json_event: json, sweep_run_ms: iredSweepRunMs(f.month_of), submit_by_ms: iredDeadlineMs(f.month_of) };
}
/** The IRED sweep over a period: loans with an accepted payment event are left alone; the rest are projected `payment.none` between the 18:00 ET run and the 20:00 ET deadline. */
export function iredSweep(f: { month_of: PlainDate; loans: readonly { loan_id: string; accepted_payment_event: boolean }[] }): { sweep_on: PlainDate; run_ms: number; deadline_ms: number; project_none_for: string[] } {
  return { sweep_on: iredSweepDate(f.month_of), run_ms: iredSweepRunMs(f.month_of), deadline_ms: iredDeadlineMs(f.month_of), project_none_for: f.loans.filter((l) => !l.accepted_payment_event).map((l) => l.loan_id) };
}
export interface PeriodCloseFacts {
  readonly period: string; readonly active_loans: number; readonly loans_with_accepted_event_or_none: number; readonly open_hard_or_invalid_rejects: number;
  /** Removal events of the period: when they were processed and (if at all) submitted. */
  readonly removals: readonly { event_id: string; processed_at_ms: number; submitted_at_ms: number | null }[];
  readonly trial_balance_diff_loans: number; readonly soft_rejects_without_triage: number; readonly cash_position_variance_cents: Cents; readonly delinquency_file_accepted: boolean; readonly escrow_attestation_prepared: boolean | "not_required";
}
export interface PeriodCloseChecklist { readonly close_ms: number; readonly bulk_cutoff_ms: number; readonly items: readonly { id: "i" | "ii" | "iii" | "iv" | "v" | "vi" | "vii" | "viii"; ok: boolean; detail: string }[]; readonly complete: boolean; readonly status: "closed" | "open"; readonly escalation: "officer" | null }
/**
 * 5.1 rule 10 — the BD2 close checklist. Item (iii) is where the removal clock's "17:00 ET if that day is BD2" lives for the
 * engine: every removal processed on/before BD1 must be submitted by BD2 17:00 ET (bulk by 15:00), otherwise the period cannot
 * close clean and the `officer` escalation opens (the registry grammar can only express the general next-BD 20:00 rule).
 */
export function periodCloseChecklist(f: PeriodCloseFacts): PeriodCloseChecklist {
  const start = periodStart(f.period); const next = nextMonth(start);
  const closeMs = bd2CloseMs(next); const bulkMs = bulkCutoffMs(f.period);
  const bd1 = fannieBusinessDay(next, 1);
  const lateRemovals = f.removals.filter((r) => { const processedOn = wallClock(r.processed_at_ms, ET).date; if (processedOn > bd1) return false; const due = larDeadlineMs(r.processed_at_ms, true); return r.submitted_at_ms === null || r.submitted_at_ms > Math.min(due, closeMs); });
  const items: PeriodCloseChecklist["items"] = [
    { id: "i", ok: f.loans_with_accepted_event_or_none >= f.active_loans, detail: `${f.loans_with_accepted_event_or_none}/${f.active_loans} active loans have an accepted event or accepted payment.none` },
    { id: "ii", ok: f.open_hard_or_invalid_rejects === 0, detail: `${f.open_hard_or_invalid_rejects} open hard/invalid rejects` },
    { id: "iii", ok: lateRemovals.length === 0, detail: lateRemovals.length ? `removals processed on/before BD1 not reported by BD2 17:00 ET: ${lateRemovals.map((r) => r.event_id).join(", ")}` : "all removals processed on/before BD1 reported by the BD2 17:00 ET clock" },
    { id: "iv", ok: f.trial_balance_diff_loans === 0, detail: `LSDU trial balance diff = ${f.trial_balance_diff_loans} loans` },
    { id: "v", ok: f.soft_rejects_without_triage === 0, detail: `${f.soft_rejects_without_triage} soft rejects without a triage record` },
    { id: "vi", ok: f.cash_position_variance_cents === 0n, detail: `cash-position preview variance ${f.cash_position_variance_cents}¢ (tolerance $0.00 for S/S and S/A drafts)` },
    { id: "vii", ok: f.delinquency_file_accepted, detail: f.delinquency_file_accepted ? "delinquency file accepted (5.7)" : "delinquency file not accepted (5.7)" },
    { id: "viii", ok: f.escrow_attestation_prepared === true || f.escrow_attestation_prepared === "not_required", detail: f.escrow_attestation_prepared === "not_required" ? "escrow attestation not required before Dec. 2026" : f.escrow_attestation_prepared ? "escrow attestation package prepared" : "escrow attestation package missing" },
  ];
  const complete = items.every((i) => i.ok);
  return { close_ms: closeMs, bulk_cutoff_ms: bulkMs, items, complete, status: complete ? "closed" : "open", escalation: complete ? null : "officer" };
}
/** Builds the `investor_event_exceptions.detected` event the correction timers arm on: `family`, the activity period's `period_end` anchor and the domain-computed correction close. */
export function exceptionDetectedEvent(f: { event_id: string; loan_id: string; family: EventFamily; activity_period: string; severity: "hard" | "soft" | "invalid" | "missing" | "fatal" | "warning" | "notification"; code: string; detected_at_ms: number }): { type: "investor_event_exceptions.detected"; loanId: string; payload: { event_id: string; family: EventFamily; severity: string; code: string; activity_period: string; period_end: PlainDate; detected_at: string; correction_due_at: string; triage_due_at: string } } {
  const due = f.family === "removal" ? removalCorrectionCloseMs(f.activity_period) : nonRemovalCorrectionCloseMs(f.activity_period);
  return { type: "investor_event_exceptions.detected", loanId: f.loan_id, payload: { event_id: f.event_id, family: f.family, severity: f.severity, code: f.code, activity_period: f.activity_period, period_end: periodEndOf(periodStart(f.activity_period)), detected_at: new Date(f.detected_at_ms).toISOString(), correction_due_at: new Date(due).toISOString(), triage_due_at: new Date(f.detected_at_ms + 4 * HOUR).toISOString() } };
}

// ---------------------------------------------------------------------------
// 5.2 — A/A sweep batch, auto-draft clock, S/S payoff shortfall, draft-debit reconciliation, Form 472, comp-fee instances
// ---------------------------------------------------------------------------
/** F-1-20 / 5.2-T3: the 15:00 ET sweep prepares a CRS code-001 batch within 10 minutes when net collections exceed $2,500 (or on the last work day); the portal upload task is due 16:00 ET the same day and settlement defaults to the next Federal Reserve business day. */
export function aaSweepBatch(f: { sweep_at_ms: number; net_collected_cents: Cents; servicer_number: string; last_work_day_of_month: boolean }): { instruct: boolean; code: "001"; prepare_by_ms: number; portal_task_due_ms: number; settlement_date: PlainDate | null; line: { servicer_number: string; remittance_code: "001"; amount_cents: Cents; settlement_date: PlainDate } | null } {
  const on = wallClock(f.sweep_at_ms, ET).date;
  const r = crsAaRequest(f.net_collected_cents, on, f.last_work_day_of_month);
  return { instruct: r.instruct, code: "001", prepare_by_ms: f.sweep_at_ms + 10 * 60_000, portal_task_due_ms: zonedEpochMs(on, "16:00", ET), settlement_date: r.settlement_date, line: r.instruct && r.settlement_date ? { servicer_number: f.servicer_number, remittance_code: "001", amount_cents: f.net_collected_cents, settlement_date: r.settlement_date } : null };
}
/** LL-2026-05 A/A auto-draft (5.2 worked example 5 / T5): event by next BD 03:00 ET, pre-draft notification the next BD, draft two BDs after processing, custodial funding gate at draft −1 BD 16:00 ET. */
export function aaAutoDraftSchedule(processedAtMs: number): { event_by_ms: number; predraft_notice_on: PlainDate; draft_on: PlainDate; funding_gate_ms: number } {
  const on = wallClock(processedAtMs, ET).date;
  const draft = addBusinessDays(on, 2, fannieEt);
  return { event_by_ms: eventDeadlineMs(processedAtMs), predraft_notice_on: addBusinessDays(on, 1, fannieEt), draft_on: draft, funding_gate_ms: fundingGateMs(draft) };
}
/** 5.2 rule 2 / T6: for an S/S payoff the servicer funds the gap between a full month at PTR and the PTR-equivalent interest collected; it is booked to `servicer_advance_receivable` with reason `ss_payoff_interest`. */
export function ssPayoffShortfallEntries(f: { full_month_cents: Cents; collected_ptr_interest_cents: Cents; loan_id: string; custodial_account_id: string }): { shortfall_cents: Cents; reason: "ss_payoff_interest"; lines: { account: string; scope: "custodial" | "corporate"; amountCents: Cents; ruleRef: string; memo: string }[] } {
  const short = f.full_month_cents - f.collected_ptr_interest_cents;
  const amt = short > 0n ? short : 0n;
  const lines = amt > 0n ? [{ account: "servicer_advance_receivable", scope: "corporate" as const, amountCents: amt, ruleRef: "5.2 rule 2 ss_payoff_interest", memo: `ss_payoff_interest ${f.loan_id}` }, { account: "custodial_pi_cash", scope: "custodial" as const, amountCents: -amt, ruleRef: "5.2 rule 2 ss_payoff_interest", memo: `ss_payoff_interest ${f.loan_id} → ${f.custodial_account_id}` }] : [];
  return { shortfall_cents: amt, reason: "ss_payoff_interest", lines };
}
export interface DraftDebitReconciliation { readonly status: "matched" | "variance" | "unmatched"; readonly variance_cents: Cents; readonly entry_set: { effectiveDate: PlainDate; description: string; lines: { account: { scope: "custodial"; custodialAccountId: string; account: string }; amountCents: Cents; ruleRef: string }[] } | null; readonly decision: { action: "remittance.variance"; remittance_id: string; expected: string; drafted: string; variance: string; classification: "unknown"; confidence: number } | null; readonly alert: "sev1" | null }
/** 5.2 rule 8 / T9: a Fannie Mae-originated bank debit is matched to the remittance by amount/date/originator; the balanced set posts Dr `fnma_remittance_payable` / Cr `custodial_pi_cash`; any difference is `variance` with a decision record. */
export function reconcileDraftDebit(f: { remittance_id: string; expected_cents: Cents; draft_date: PlainDate; debit_cents: Cents; debit_date: PlainDate; originator: string; custodial_account_id: string }): DraftDebitReconciliation {
  const fannie = /fannie/i.test(f.originator);
  if (!fannie || f.debit_date !== f.draft_date) return { status: "unmatched", variance_cents: f.debit_cents - f.expected_cents, entry_set: null, decision: null, alert: "sev1" };
  const v = f.debit_cents - f.expected_cents;
  const entry_set = { effectiveDate: f.debit_date, description: `Fannie Mae draft ${f.remittance_id}`, lines: [{ account: { scope: "custodial" as const, custodialAccountId: f.custodial_account_id, account: "fnma_remittance_payable" }, amountCents: f.debit_cents, ruleRef: "5.2 rule 8 draft" }, { account: { scope: "custodial" as const, custodialAccountId: f.custodial_account_id, account: "custodial_pi_cash" }, amountCents: -f.debit_cents, ruleRef: "5.2 rule 8 draft" }] };
  if (v === 0n) return { status: "matched", variance_cents: 0n, entry_set, decision: null, alert: null };
  return { status: "variance", variance_cents: v, entry_set, decision: { action: "remittance.variance", remittance_id: f.remittance_id, expected: f.expected_cents.toString(), drafted: f.debit_cents.toString(), variance: v.toString(), classification: "unknown", confidence: 1 }, alert: null };
}
/** 5.2 rule 9 / T10: Schedule 3 (Form 472) — closing = opening + cash remitted − P&I reported, explained to zero; a surplus must be resolved within 90 calendar days of first appearing. */
export function form472Schedule3(f: { period: string; opening_cents: Cents; remitted_cents: Cents; reported_pi_cents: Cents; explained_items: readonly { kind: string; amount_cents: Cents; note: string }[]; surplus_first_seen: PlainDate | null }): { closing_cents: Cents; explained_cents: Cents; unexplained_cents: Cents; kind: "surplus" | "shortage" | "balanced"; surplus_resolve_due_on: PlainDate | null; explanation: string; artifact: { form: "472"; schedule: "3"; period: string; lines: { label: string; amount_cents: Cents }[] } } {
  const closing = f.opening_cents + f.remitted_cents - f.reported_pi_cents;
  const explained = f.explained_items.reduce((a, i) => a + i.amount_cents, 0n);
  const unexplained = closing - explained;
  const kind = unexplained > 0n ? "surplus" : unexplained < 0n ? "shortage" : "balanced";
  const due = kind === "surplus" && f.surplus_first_seen ? surplusResolveDueOn(f.surplus_first_seen) : null;
  const explanation = kind === "balanced" ? "cumulative cash remitted equals P&I reported after timing items" : `${kind} of ${unexplained}¢ after explained items: ${f.explained_items.map((i) => `${i.kind} ${i.amount_cents}¢ (${i.note})`).join("; ") || "none"}${due ? `; surplus first seen ${f.surplus_first_seen} — resolve by ${due} (FNMA_IRM_SURPLUS_RESOLVE_90)` : ""}`;
  return { closing_cents: closing, explained_cents: explained, unexplained_cents: unexplained, kind, surplus_resolve_due_on: due, explanation, artifact: { form: "472", schedule: "3", period: f.period, lines: [{ label: "opening shortage/surplus", amount_cents: f.opening_cents }, { label: "cash remitted", amount_cents: f.remitted_cents }, { label: "P&I reported (accepted LARs)", amount_cents: -f.reported_pi_cents }, ...f.explained_items.map((i) => ({ label: `explained: ${i.kind}`, amount_cents: i.amount_cents })), { label: "closing (unexplained)", amount_cents: unexplained }] } };
}
/** A1-4.2-01 ladder (5.2 rule 11 / T12): the minimum is $250 for the first instance, $500 for the second and $1,000 for each subsequent instance within a year; the instance is recorded in `compfee_instances`. */
export function compensatoryFeeInstance(f: { amount_cents: Cents; days_late: number; prime_pct: string; prior_instances_within_year: number; kind?: string }): { fee_cents: Cents; minimum_cents: Cents; formula_cents: Cents; instance_number: number; instance: { kind: string; amount_cents: Cents; days_late: number; fee_cents: Cents } } {
  const n = f.prior_instances_within_year + 1;
  const minimum = n === 1 ? 25_000n : n === 2 ? 50_000n : 100_000n;
  const formula = compensatoryFee(f.amount_cents, f.days_late, f.prime_pct, 0n);
  const fee = compensatoryFee(f.amount_cents, f.days_late, f.prime_pct, minimum);
  return { fee_cents: fee, minimum_cents: minimum, formula_cents: formula, instance_number: n, instance: { kind: f.kind ?? "late_remittance", amount_cents: f.amount_cents, days_late: f.days_late, fee_cents: fee } };
}
