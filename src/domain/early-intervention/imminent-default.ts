/**
 * §11.5 Imminent default evaluation — D2-1-01 base tests, hardship and credit
 * paths, notice deadlines, and the evaluation / SMDU / reviewer events the
 * 11.5 timers arm and satisfy on (`imminent_default.evaluating`, `.eligible`,
 * `.reviewer_pending`, `smdu.case.submitted`, `smdu.submission.acknowledged`,
 * `smdu.case.decided`, `smdu.case.declined`, `lossmit.decision.reviewed`,
 * `lossmit.offer.accepted`, `lossmit.evaluation_notice.sent`).
 *
 * Credit path (11.5 rule 5, as amended against the Aug. 12, 2026 Guide):
 *  - the loan-level score is the lowest representative score across ALL
 *    borrowers (D2-1-01 Step 2 note — no income-contribution filter);
 *  - the two-delinquency test counts 30-day-or-worse delinquencies in the six
 *    calendar months immediately preceding the month of the evaluation (the
 *    evaluation month excluded), one per installment;
 *  - the ratio is the F-1-12 housing expense (MI excluded) over gross monthly
 *    income that, for a modification evaluation, excludes unemployment
 *    benefits, severance and other temporary employment-related income.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, addMonths, daysBetween, startOfMonth, endOfMonth } from "../../kernel/calendar/date.ts";

export const RESERVES_LIMIT_CENTS = 2_500_000n, FICO_MAX = 620, FICO_AGE_MAX_DAYS = 90, DOC_AGE_MAX_DAYS = 90, HTI_THRESHOLD = Decimal.parse("0.40"), DELINQUENT_CEILING = 60;
/** D2-1-01: "two or more 30-day delinquencies … in the six months immediately preceding the month of the evaluation." */
export const DELINQUENCY_WINDOW_MONTHS = 6, DELINQUENCY_MIN_DAYS = 30, DELINQUENCY_MIN_COUNT = 2, FORM182_DAYS = 30;
export const HARDSHIP_PATHS: Record<string, "modification" | "liquidation"> = { death_of_borrower_or_wage_earner: "modification", disability_or_illness: "modification", divorce_or_legal_separation: "modification", separation_unmarried: "modification", step_rate_increase_last_12m: "modification", distant_transfer_or_pcs_gt_50mi: "liquidation" };

/** D2-1-01 Step 2: a representative score per borrower — lower of two, middle of three, a single score as is. */
export function representativeScore(scores: readonly number[]): number {
  if (scores.length === 0) throw new RangeError("representativeScore: no scores");
  const s = [...scores].sort((a, b) => a - b); return s.length === 1 ? s[0]! : s.length === 2 ? s[0]! : s[Math.floor(s.length / 2)]!;
}
export interface BorrowerScores { readonly borrower_id?: string; readonly scores: readonly number[]; /** Informational only: the Guide applies no income-contribution filter (11.5-Q2 closed). */ readonly income_used?: boolean }
/**
 * D2-1-01 Step 2 note: "If there are multiple borrowers, the servicer must determine the representative score for each
 * borrower and use the lowest representative score as the credit score for the evaluation" — every borrower counts,
 * whether or not that borrower's income is used.
 */
export function loanLevelScore(borrowers: readonly BorrowerScores[]): { score: number; by_borrower: readonly { borrower_id: string | null; representative: number; income_used: boolean | null }[] } {
  if (borrowers.length === 0) throw new RangeError("loanLevelScore: no borrowers");
  const by = borrowers.map((b) => ({ borrower_id: b.borrower_id ?? null, representative: representativeScore(b.scores), income_used: b.income_used ?? null }));
  return { score: Math.min(...by.map((b) => b.representative)), by_borrower: by };
}

/** One installment from `loan_installments` history: its due date and the furthest it went past due (0 = paid on time). */
export interface InstallmentDelinquency { readonly due_date: PlainDate; readonly max_days_past_due: number }
/** The six calendar months immediately preceding the month of the evaluation date, the evaluation month excluded (D2-1-01). */
export function delinquencyWindow(evaluationDate: PlainDate): { start: PlainDate; end: PlainDate } {
  return { start: startOfMonth(addMonths(evaluationDate, -DELINQUENCY_WINDOW_MONTHS)), end: endOfMonth(addMonths(evaluationDate, -1)) };
}
/**
 * 30-day-or-worse delinquencies in the window, placed by the installment's due date, one per installment (a missed
 * payment that ages to 60+ days is one delinquency, not two — D2-1-01 Note); an installment due in the evaluation month
 * is outside the window.
 */
export function countDelinquencies30(installments: readonly InstallmentDelinquency[], evaluationDate: PlainDate): { count: number; window: { start: PlainDate; end: PlainDate }; counted: readonly PlainDate[] } {
  const w = delinquencyWindow(evaluationDate);
  const counted = installments.filter((i) => i.due_date >= w.start && i.due_date <= w.end && i.max_days_past_due >= DELINQUENCY_MIN_DAYS).map((i) => i.due_date).sort();
  return { count: new Set(counted).size, window: w, counted };
}

/** F-1-12 housing-expense components in monthly cents; a non-escrowed item may instead be given as its annual bill (1/12, rounded half-up at cents). */
export interface HousingExpenseComponents {
  readonly principal_and_interest_cents: Cents;
  readonly property_insurance_cents?: Cents; readonly property_insurance_annual_cents?: Cents;
  readonly flood_insurance_cents?: Cents; readonly flood_insurance_annual_cents?: Cents;
  readonly real_estate_taxes_cents?: Cents; readonly real_estate_taxes_annual_cents?: Cents;
  readonly ground_rent_cents?: Cents;
  /** Fees under a resale-restriction or shared-equity agreement. */
  readonly resale_restriction_fees_cents?: Cents;
  readonly special_assessments_cents?: Cents;
  /** HOA dues including common-area utility charges; `hoa_unit_utility_cents` is the individual-unit utility charge to exclude. */
  readonly hoa_dues_cents?: Cents; readonly hoa_unit_utility_cents?: Cents;
  /** Co-op corporation fee less the borrower's pro-rata share of master utility charges for individual units. */
  readonly coop_fee_cents?: Cents; readonly coop_master_utility_prorata_cents?: Cents;
  /** Any escrow shortage currently included in the full monthly contractual payment. */
  readonly escrow_shortage_cents?: Cents;
  /** Monthly mortgage insurance premium — recorded, never included (F-1-12 Note). */
  readonly mortgage_insurance_cents?: Cents;
}
const twelfth = (annual: Cents): Cents => (annual + 6n) / 12n;   // 1/12 of the annual bill, half-up at cents
const monthly = (m: Cents | undefined, annual: Cents | undefined): Cents => (m ?? 0n) + (annual === undefined ? 0n : twelfth(annual));
/** F-1-12 monthly housing expense (the Guide's term — not "PITIA": MI is excluded). Returns the included lines, the total and the excluded MI. */
export function housingExpense(c: HousingExpenseComponents): { cents: Cents; excluded_mi_cents: Cents; lines: Readonly<Record<string, Cents>> } {
  const lines: Record<string, Cents> = {
    principal_and_interest: c.principal_and_interest_cents,
    property_insurance: monthly(c.property_insurance_cents, c.property_insurance_annual_cents),
    flood_insurance: monthly(c.flood_insurance_cents, c.flood_insurance_annual_cents),
    real_estate_taxes: monthly(c.real_estate_taxes_cents, c.real_estate_taxes_annual_cents),
    ground_rent: c.ground_rent_cents ?? 0n,
    resale_restriction_fees: c.resale_restriction_fees_cents ?? 0n,
    special_assessments: c.special_assessments_cents ?? 0n,
    hoa_dues: (c.hoa_dues_cents ?? 0n) - (c.hoa_unit_utility_cents ?? 0n),
    coop_fee: (c.coop_fee_cents ?? 0n) - (c.coop_master_utility_prorata_cents ?? 0n),
    escrow_shortage: c.escrow_shortage_cents ?? 0n,
  };
  for (const [k, v] of Object.entries(lines)) if (v < 0n) throw new RangeError(`housingExpense: ${k} is negative`);
  return { cents: Object.values(lines).reduce((a, b) => a + b, 0n), excluded_mi_cents: c.mortgage_insurance_cents ?? 0n, lines };
}
/** Income sources F-1-12 leaves out of a modification evaluation's gross monthly income (unemployment insurance benefits and other temporary employment-related income such as severance). */
export const EXCLUDED_INCOME_KINDS_MODIFICATION: ReadonlySet<string> = new Set(["unemployment_insurance", "severance", "temporary_employment_related"]);
export interface IncomeSource { readonly kind: string; readonly cents: Cents; /** Non-taxable income is grossed up 25 % (D2-2-05 / 11.5 rule 5). */ readonly taxable?: boolean }
/** Gross monthly income (income before payroll deductions): the modification track excludes the F-1-12 temporary employment-related sources; non-taxable income +25 %. */
export function grossMonthlyIncome(sources: readonly IncomeSource[], track: "modification" | "liquidation" = "modification"): { cents: Cents; excluded: readonly { kind: string; cents: Cents }[] } {
  let total = 0n; const excluded: { kind: string; cents: Cents }[] = [];
  for (const s of sources) {
    if (s.cents < 0n) throw new RangeError(`grossMonthlyIncome: ${s.kind} is negative`);
    if (track === "modification" && EXCLUDED_INCOME_KINDS_MODIFICATION.has(s.kind)) { excluded.push({ kind: s.kind, cents: s.cents }); continue; }
    total += s.taxable === false ? (s.cents * 125n + 50n) / 100n : s.cents;
  }
  return { cents: total, excluded };
}
export function hti(housingExpenseCents: Cents, grossMonthlyIncomeCents: Cents): { ratio: Decimal; pass: boolean; display: string } { const r = Decimal.ratio(housingExpenseCents, grossMonthlyIncomeCents); return { ratio: r, pass: r.cmp(HTI_THRESHOLD) > 0, display: r.toFixed(2) }; }

export interface CreditInputs {
  /** A single borrower's scores (lower of two / middle of three); with several borrowers give `borrowers` instead. */
  readonly scores?: readonly number[];
  readonly borrowers?: readonly BorrowerScores[];
  readonly fico_date: PlainDate;
  /** Pre-counted 30-day-or-worse delinquencies in the six calendar months before the evaluation month; `delinquencies` (installment history) is counted here instead when given. */
  readonly delinquencies_30_in_6m?: number;
  readonly delinquencies?: readonly InstallmentDelinquency[];
  /** F-1-12 monthly housing expense (MI excluded) — `housingExpense(...)`. */
  readonly housing_expense_cents: Cents;
  /** Gross monthly income for the evaluation — `grossMonthlyIncome(...)`. */
  readonly gross_income_cents: Cents;
}
export interface Evaluation {
  readonly evaluation_date: PlainDate; readonly regx_days_delinquent: number; readonly principal_residence: boolean; readonly brp_complete: boolean; readonly oldest_doc_date: PlainDate;
  readonly cash_reserves_cents: Cents; readonly hardship_type: string | null; readonly hardship_documented: boolean; readonly pcs_distance_miles?: number;
  /** D2-1-01 PCS exception: the property "must have been or currently be the servicemember's principal residence" — a former principal residence passes the occupancy test on the liquidation track only. */
  readonly was_principal_residence?: boolean;
  readonly credit?: CreditInputs | null;
}
export type Result = { outcome: "rerouted_delinquent" } | { outcome: "ineligible"; failed: string[] } | { outcome: "eligible_hardship" | "eligible_credit"; path: "modification" | "liquidation"; tests: Record<string, boolean> };

/** The credit-path facts the evaluation records (decision record `path_tests.credit`). */
export function creditFacts(c: CreditInputs, evaluationDate: PlainDate): { representative: number | null; delinquencies_6m: number; window: { start: PlainDate; end: PlainDate } } {
  const representative = c.borrowers && c.borrowers.length ? loanLevelScore(c.borrowers).score : c.scores && c.scores.length ? representativeScore(c.scores) : null;
  const dq = c.delinquencies ? countDelinquencies30(c.delinquencies, evaluationDate) : { count: c.delinquencies_30_in_6m ?? 0, window: delinquencyWindow(evaluationDate) };
  return { representative, delinquencies_6m: dq.count, window: dq.window };
}

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
  const facts = creditFacts(e.credit, e.evaluation_date);
  // credit report unavailable / frozen file: no score obtainable → `ineligible_credit_unavailable` (reviewer; 11.5 edge case)
  if (facts.representative === null) return { outcome: "ineligible", failed: ["ineligible_credit_unavailable"] };
  tests.fico = facts.representative <= FICO_MAX; tests.fico_age = daysBetween(e.credit.fico_date, e.evaluation_date) <= FICO_AGE_MAX_DAYS;
  tests.delinquency = facts.delinquencies_6m >= DELINQUENCY_MIN_COUNT; tests.hti = hti(e.credit.housing_expense_cents, e.credit.gross_income_cents).pass;
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
/**
 * `smdu.case.decided{approved | declined | counteroffer}`; a decline for a borrower current at evaluation opens the Form 182
 * clock — anchored on receipt of Fannie Mae's decision (`decision_received_on`, D2-1-01: "within 30 days of receipt of
 * Fannie Mae's decision"; the SMDU decision date unless the decision reached the servicer later) — and the reviewer step.
 */
export function smduDecision(i: { loan_id: string; decision: "approved" | "declined" | "counteroffer"; decided_on: PlainDate; received_on?: PlainDate; current_at_evaluation: boolean; brp_complete_on: PlainDate; workout?: string | null }): IdEvent[] {
  const received = i.received_on ?? i.decided_on;
  if (received < i.decided_on) throw new RangeError("smduDecision: received_on precedes decided_on");
  const events: IdEvent[] = [{ type: "smdu.case.decided", payload: { loan_id: i.loan_id, decision: i.decision, decided_on: i.decided_on, decision_received_on: received, workout: i.workout ?? null } }];
  if (i.decision === "declined") events.push({ type: "smdu.case.declined", payload: { loan_id: i.loan_id, declined_on: i.decided_on, decision_received_on: received, form182_due: addDays(received, FORM182_DAYS), current_at_evaluation: i.current_at_evaluation, brp_complete_at: i.brp_complete_on } },
    { type: "imminent_default.reviewer_pending", payload: { loan_id: i.loan_id, reason: "smdu_declined", declined_on: i.decided_on, decision_received_on: received, current_at_evaluation: i.current_at_evaluation, brp_complete_at: i.brp_complete_on, entry: received } });
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
/**
 * A counteroffer accepted inside the 14-day window: `lossmit.offer.accepted` satisfies FNMA_D2205_ACCEPT_14. It cancels
 * FNMA_D2101_FORM182_ADVERSE_30 only when the acceptance also falls within 30 days of receipt of Fannie Mae's decision
 * (D2-1-01: "accepts the counteroffer within the 30-day period"): with `decision_received_on` known the bound is applied
 * here (`cancel_timers`); otherwise the §11 cancellation table (timers.ts) applies it against the armed clock's due date.
 */
export function offerAccepted(i: { loan_id: string; offer_sent_on: PlainDate; accepted_on: PlainDate; kind?: "offer" | "counteroffer"; decision_received_on?: PlainDate | null }): { within_window: boolean; within_30_of_decision: boolean | null; events: IdEvent[]; cancel_timers: readonly string[] } {
  const within = i.accepted_on >= i.offer_sent_on && daysBetween(i.offer_sent_on, i.accepted_on) <= 14;
  const within30 = i.decision_received_on ? i.accepted_on <= addDays(i.decision_received_on, FORM182_DAYS) : null;
  const cancel = within && (i.kind ?? "counteroffer") === "counteroffer" && within30 === true ? ["FNMA_D2101_FORM182_ADVERSE_30"] : [];
  // `cancel_timers` rides on the event so the §11 cancellation reader (timers.ts) cancels the Form 182 clock (11.5-T8).
  return { within_window: within, within_30_of_decision: within30, events: [{ type: "lossmit.offer.accepted", payload: { loan_id: i.loan_id, kind: i.kind ?? "counteroffer", accepted_on: i.accepted_on, within_window: within, within_30_of_decision: within30, cancel_timers: cancel } }], cancel_timers: cancel };
}
