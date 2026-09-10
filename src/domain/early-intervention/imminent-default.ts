/**
 * §11.5 Imminent default evaluation — D2-1-01 base tests, hardship and credit
 * paths, notice deadlines, and the evaluation / SMDU / reviewer events the
 * 11.5 timers arm and satisfy on (`imminent_default.evaluating`, `.eligible`,
 * `.reviewer_pending`, `smdu.case.submitted`, `smdu.submission.acknowledged`,
 * `smdu.case.decided`, `smdu.case.declined`, `lossmit.decision.reviewed`,
 * `lossmit.offer.accepted`, `lossmit.evaluation_notice.sent`).
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";

export const RESERVES_LIMIT_CENTS = 2_500_000n, FICO_MAX = 620, FICO_AGE_MAX_DAYS = 90, DOC_AGE_MAX_DAYS = 90, HTI_THRESHOLD = Decimal.parse("0.40"), DELINQUENT_CEILING = 60;
export const HARDSHIP_PATHS: Record<string, "modification" | "liquidation"> = { death_of_borrower_or_wage_earner: "modification", disability_or_illness: "modification", divorce_or_legal_separation: "modification", separation_unmarried: "modification", step_rate_increase_last_12m: "modification", distant_transfer_or_pcs_gt_50mi: "liquidation" };

export function representativeScore(scores: readonly number[]): number { const s = [...scores].sort((a, b) => a - b); return s.length === 1 ? s[0]! : s.length === 2 ? s[0]! : s[Math.floor(s.length / 2)]!; }
export function hti(pitiaCents: Cents, grossMonthlyIncomeCents: Cents): { ratio: Decimal; pass: boolean; display: string } { const r = Decimal.ratio(pitiaCents, grossMonthlyIncomeCents); return { ratio: r, pass: r.cmp(HTI_THRESHOLD) > 0, display: r.toFixed(2) }; }

export interface Evaluation {
  readonly evaluation_date: PlainDate; readonly regx_days_delinquent: number; readonly principal_residence: boolean; readonly brp_complete: boolean; readonly oldest_doc_date: PlainDate;
  readonly cash_reserves_cents: Cents; readonly hardship_type: string | null; readonly hardship_documented: boolean; readonly pcs_distance_miles?: number;
  /** D2-1-01 PCS exception: the property "must have been or currently be the servicemember's principal residence" — a former principal residence passes the occupancy test on the liquidation track only. */
  readonly was_principal_residence?: boolean;
  readonly credit?: { scores: readonly number[]; fico_date: PlainDate; delinquencies_30_in_6m: number; pitia_cents: Cents; gross_income_cents: Cents } | null;
}
export type Result = { outcome: "rerouted_delinquent" } | { outcome: "ineligible"; failed: string[] } | { outcome: "eligible_hardship" | "eligible_credit"; path: "modification" | "liquidation"; tests: Record<string, boolean> };

export function evaluate(e: Evaluation): Result {
  if (e.regx_days_delinquent >= DELINQUENT_CEILING) return { outcome: "rerouted_delinquent" };
  const failed: string[] = []; const tests: Record<string, boolean> = {};
  const pcs = e.hardship_type === "distant_transfer_or_pcs_gt_50mi" && (e.pcs_distance_miles ?? 0) >= 50.0;
  // Occupancy: principal residence occupied by ≥1 borrower; the PCS exception accepts "was the principal residence" — never a property the servicemember never occupied (11.5-T6).
  tests.occupancy = e.principal_residence || (pcs && e.was_principal_residence === true); if (!tests.occupancy) failed.push("occupancy");
  tests.brp_complete = e.brp_complete; if (!e.brp_complete) failed.push("brp_complete");
  tests.doc_age = daysBetween(e.oldest_doc_date, e.evaluation_date) <= DOC_AGE_MAX_DAYS; if (!tests.doc_age) failed.push("doc_age_90");
  tests.cash_reserves = e.cash_reserves_cents < RESERVES_LIMIT_CENTS; if (!tests.cash_reserves && !pcs) failed.push("cash_reserves");
  if (failed.length) return { outcome: "ineligible", failed };
  if (e.hardship_type && e.hardship_type in HARDSHIP_PATHS && e.hardship_documented) {
    if (e.hardship_type === "distant_transfer_or_pcs_gt_50mi" && !pcs) return { outcome: "ineligible", failed: ["pcs_distance_lt_50"] };
    return { outcome: "eligible_hardship", path: HARDSHIP_PATHS[e.hardship_type]!, tests };
  }
  if (!e.credit) return { outcome: "ineligible", failed: ["no_hardship_path_no_credit"] };
  const rep = representativeScore(e.credit.scores);
  tests.fico = rep <= FICO_MAX; tests.fico_age = daysBetween(e.credit.fico_date, e.evaluation_date) <= FICO_AGE_MAX_DAYS;
  tests.delinquency = e.credit.delinquencies_30_in_6m >= 2; tests.hti = hti(e.credit.pitia_cents, e.credit.gross_income_cents).pass;
  if (!tests.fico_age) return { outcome: "ineligible", failed: ["FNMA_D2101_FICO_AGE_90"] };
  if (tests.fico && (tests.delinquency || tests.hti)) return { outcome: "eligible_credit", path: "modification", tests };
  return { outcome: "ineligible", failed: [!tests.fico ? "fico_gt_620" : "delinquency_and_hti"] };
}
/** Evaluation Notice due: earlier of decision + 5 days and complete BRP + 30 days; 14-day acceptance window. */
export function noticeDeadlines(decisionOn: PlainDate, brpCompleteOn: PlainDate): { evaluation_notice_due: PlainDate; response_window_days: 14 } { const a = addDays(decisionOn, 5), b = addDays(brpCompleteOn, 30); return { evaluation_notice_due: a < b ? a : b, response_window_days: 14 }; }
/** D2-1-01: no solicitation of a borrower < 30 days delinquent who has not asked for help. */
export function solicitationGate(regxDays: number, borrowerAskedForHelp: boolean): { ok: true } | { ok: false; gate: "FNMA_D2101_NO_SOLICIT_LT30" } { return regxDays >= 30 || borrowerAskedForHelp ? { ok: true } : { ok: false, gate: "FNMA_D2101_NO_SOLICIT_LT30" }; }

// ---- events -----------------------------------------------------------------------------

export interface IdEvent { readonly type: string; readonly payload: Record<string, unknown>; }
/** The evaluation's own events: `imminent_default.evaluating` (gates arm), then `.eligible{path}` (SM_ID_SMDU_SUBMIT_2BD), `.reviewer_pending{reason=ineligible}` (REGB / SLA) or `.rerouted_delinquent`. */
export function evaluationEvents(e: Evaluation, r: Result, o: { loan_id: string; state?: string; ai_influenced?: boolean; brp_complete_on?: PlainDate | null }): IdEvent[] {
  const base = { loan_id: o.loan_id, evaluation_date: e.evaluation_date, regx_days_delinquent: e.regx_days_delinquent, brp_complete_at: o.brp_complete_on ?? e.evaluation_date };
  const events: IdEvent[] = [{ type: "imminent_default.evaluating", payload: { ...base, state: o.state ?? null, ai_influenced: o.ai_influenced ?? true, path: e.credit ? "credit" : "hardship", cash_reserves_cents: e.cash_reserves_cents, ...(e.credit ? { fico_date: e.credit.fico_date } : {}) } }];
  if (r.outcome === "rerouted_delinquent") events.push({ type: "imminent_default.rerouted_delinquent", payload: { ...base, track: "12.8 delinquent" } });
  else if (r.outcome === "ineligible") events.push({ type: "imminent_default.reviewer_pending", payload: { ...base, reason: "ineligible", failed: r.failed, entry: e.evaluation_date } });
  else events.push({ type: "imminent_default.eligible", payload: { ...base, result: r.outcome, path: r.path, eligibility_date: e.evaluation_date, imminent_default_indicator: true, credit_pull: e.credit !== undefined && e.credit !== null } });
  return events;
}
/** SMDU submission with the B2B acknowledgment (`SM_ID_SMDU_SUBMIT_2BD` is satisfied by the ack, never by the send). */
export function smduSubmission(i: { loan_id: string; submitted_on: PlainDate; eligibility_date: PlainDate; ack: { case_id: string; acknowledged_on: PlainDate } | null }): { events: IdEvent[]; due: PlainDate; on_time: boolean } {
  const due = addDays(i.eligibility_date, 2);   // 2 servicer business days (policy) — the calendar shift is applied by the timer engine
  const events: IdEvent[] = [{ type: "smdu.case.submitted", payload: { loan_id: i.loan_id, submitted_on: i.submitted_on, imminent_default_indicator: true } }];
  if (i.ack) events.push({ type: "smdu.submission.acknowledged", payload: { loan_id: i.loan_id, case_id: i.ack.case_id, acknowledged_on: i.ack.acknowledged_on } });
  return { events, due, on_time: i.ack !== null && i.ack.acknowledged_on <= due };
}
/** `smdu.case.decided{approved | declined | counteroffer}`; a decline for a borrower current at evaluation opens the Form 182 clock and the reviewer step. */
export function smduDecision(i: { loan_id: string; decision: "approved" | "declined" | "counteroffer"; decided_on: PlainDate; current_at_evaluation: boolean; brp_complete_on: PlainDate; workout?: string | null }): IdEvent[] {
  const events: IdEvent[] = [{ type: "smdu.case.decided", payload: { loan_id: i.loan_id, decision: i.decision, decided_on: i.decided_on, workout: i.workout ?? null } }];
  if (i.decision === "declined") events.push({ type: "smdu.case.declined", payload: { loan_id: i.loan_id, declined_on: i.decided_on, current_at_evaluation: i.current_at_evaluation, brp_complete_at: i.brp_complete_on } },
    { type: "imminent_default.reviewer_pending", payload: { loan_id: i.loan_id, reason: "smdu_declined", declined_on: i.decided_on, current_at_evaluation: i.current_at_evaluation, brp_complete_at: i.brp_complete_on, entry: i.decided_on } });
  if (i.decision === "counteroffer") events.push({ type: "lossmit.offer.sent", payload: { loan_id: i.loan_id, kind: "counteroffer", sent: i.decided_on } });
  return events;
}
/** The `lossmit_reviewer` approves/corrects the adverse determination — no adverse notice issues without it. */
export function reviewerDecision(i: { loan_id: string; reviewer_id: string; on: PlainDate; action: "approved" | "corrected" }): IdEvent[] {
  return [{ type: "lossmit.decision.reviewed", payload: { loan_id: i.loan_id, approved_by: i.reviewer_id, reviewed_on: i.on, action: i.action } }];
}
/** Evaluation Notice / Form 182 sent — the satisfier for the 12.2-owned decision clocks and the 11.5 adverse-action clocks. */
export function evaluationNoticeSent(i: { loan_id: string; notice_id: string; template: string; sent_on: PlainDate }): IdEvent[] {
  return [{ type: "lossmit.evaluation_notice.sent", payload: { loan_id: i.loan_id, notice_id: i.notice_id, template: i.template, sent_on: i.sent_on } }];
}
/** A counteroffer accepted inside the 14-day window: `lossmit.offer.accepted` satisfies FNMA_D2205_ACCEPT_14 and cancels FNMA_D2101_FORM182_ADVERSE_30. */
export function offerAccepted(i: { loan_id: string; offer_sent_on: PlainDate; accepted_on: PlainDate; kind?: "offer" | "counteroffer" }): { within_window: boolean; events: IdEvent[]; cancel_timers: readonly string[] } {
  const within = i.accepted_on >= i.offer_sent_on && daysBetween(i.offer_sent_on, i.accepted_on) <= 14;
  const cancel = within && (i.kind ?? "counteroffer") === "counteroffer" ? ["FNMA_D2101_FORM182_ADVERSE_30"] : [];
  // `cancel_timers` rides on the event so the §11 cancellation reader (timers.ts) cancels the Form 182 clock (11.5-T8).
  return { within_window: within, events: [{ type: "lossmit.offer.accepted", payload: { loan_id: i.loan_id, kind: i.kind ?? "counteroffer", accepted_on: i.accepted_on, within_window: within, cancel_timers: cancel } }], cancel_timers: cancel };
}
