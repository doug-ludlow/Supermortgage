/** §12.6 Payment Deferral and §12.7 Disaster Payment Deferral. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addMonths, parts, ymd, endOfMonth, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";

/** D2-3.2-04 criterion 10 / D2-3.2-05: arrangements that bar a deferral while they stand. */
export type ConflictingArrangement = "recourse_or_indemnification" | "approved_liquidation" | "active_repayment_plan" | "current_retention_offer" | "active_trial_period_plan";
export interface DeferralFacts {
  readonly months_delinquent: number; readonly origination_date: PlainDate; readonly evaluation_date: PlainDate; readonly prior_deferral_effective?: PlainDate | null; readonly prior_deferral_was_disaster?: boolean;
  readonly cumulative_deferred_months: number; readonly months_to_maturity: number; readonly disaster?: { delinquency_months_at_disaster: number; same_event_deferred_before: boolean } | null;
  /** Criterion 10 (12.6) / "no conflicting arrangements" (12.7): active plans, offers, trials, liquidation approvals, recourse. */
  readonly active_arrangements?: readonly ConflictingArrangement[];
  /** Criterion 11 (12.6): a failed *non-disaster* modification trial, or a *non-disaster* modification, within 12 months of the evaluation date. */
  readonly last_failed_trial_on?: PlainDate | null; readonly last_modification_effective?: PlainDate | null;
}
export type Screen = { eligible: true; contractual_payment_required: boolean; months_deferred: number } | { eligible: false; reason: string; next: "flex_mod" | "fnma_prior_approval" };
/** D2-3.2-04 criteria 5–11 (standard) and D2-3.2-05 (disaster), tested in the Guide's order; the first failure names its reason code. */
export function screen(f: DeferralFacts): Screen {
  const conflicts = f.active_arrangements ?? [];
  if (f.disaster) {
    if (f.disaster.same_event_deferred_before) return { eligible: false, reason: "INV_FNMA_D23204_SAME_DISASTER_EVENT", next: "flex_mod" };
    if (f.disaster.delinquency_months_at_disaster >= 2) return { eligible: false, reason: "INV_FNMA_D23204_DELQ_AT_DISASTER", next: "fnma_prior_approval" };
    if (f.months_delinquent < 1 || f.months_delinquent > 12) return { eligible: false, reason: "INV_FNMA_D23204_DELQ_WINDOW", next: "flex_mod" };
    if (f.months_to_maturity < 36) return { eligible: false, reason: "INV_FNMA_D23205_MATURITY", next: "flex_mod" };   // D2-3.2-05: not within 36 months of maturity
    if (conflicts.length) return { eligible: false, reason: "INV_FNMA_D23205_CONFLICTING_ARRANGEMENT", next: "flex_mod" };   // recourse, approved liquidation, active repayment plan, pending trial, competing retention offer
    return { eligible: true, contractual_payment_required: f.months_delinquent === 12, months_deferred: f.months_delinquent };
  }
  if (addMonths(f.origination_date, 12) > f.evaluation_date) return { eligible: false, reason: "INV_FNMA_D23204_SEASONING_12M", next: "flex_mod" };   // criterion 5: originated ≥12 months before evaluation
  if (f.months_delinquent < 2 || f.months_delinquent > 6) return { eligible: false, reason: "INV_FNMA_D23204_DELQ_WINDOW", next: "flex_mod" };   // criterion 6
  if (f.prior_deferral_effective && !f.prior_deferral_was_disaster && addMonths(f.prior_deferral_effective, 12) > f.evaluation_date) return { eligible: false, reason: "INV_FNMA_D23204_PRIOR_DEFERRAL_12M", next: "flex_mod" };   // criterion 7
  if (f.months_to_maturity < 36) return { eligible: false, reason: "INV_FNMA_D23204_MATURITY", next: "flex_mod" };   // criterion 9
  if (conflicts.length) return { eligible: false, reason: "INV_FNMA_D23204_CONFLICTING_ARRANGEMENT", next: "flex_mod" };   // criterion 10
  const within12 = (d: PlainDate | null | undefined) => Boolean(d) && addMonths(d!, 12) > f.evaluation_date;
  if (within12(f.last_failed_trial_on) || within12(f.last_modification_effective)) return { eligible: false, reason: "INV_FNMA_D23204_TRIAL_OR_MOD_12M", next: "flex_mod" };   // criterion 11
  const after = f.cumulative_deferred_months + f.months_delinquent;   // criterion 8: cumulative cap 12 (disaster deferrals excluded)
  return { eligible: true, contractual_payment_required: f.months_delinquent === 6 || after > 12, months_deferred: after > 12 ? Math.max(0, 12 - f.cumulative_deferred_months) : f.months_delinquent };
}
export function nib(piCents: Cents, monthsDeferred: number, escrowAdvances: Cents, servicingAdvances: Cents): Cents { return BigInt(monthsDeferred) * piCents + escrowAdvances + servicingAdvances; }
export function newPayment(piCents: Cents, tiMonthly: Cents, escrowShortage: Cents): { shortage_monthly_cents: Cents; payment_cents: Cents } { const s = divRound(escrowShortage, 60n, "HALF_UP"); return { shortage_monthly_cents: s, payment_cents: piCents + tiMonthly + s }; }

export interface TimelineOptions {
  /** Date the case was completed in SMDU (drives the agreement-send clock). */
  readonly completion_on?: PlainDate | null;
  /** Partner's written equal-treatment election of a processing month (D2-3.2-04; 12.6 rule 5 / open question 2). */
  readonly processing_month_elected?: boolean;
}
export interface Timeline { processing_month: boolean; processing_month_permitted: boolean; entry_deadline: PlainDate; lar_deadline: PlainDate; effective: PlainDate; agreement_by: PlainDate | null; custodian_by: PlainDate; }
/**
 * D2-3.2-04 / 12.6 rules 3, 5 and 6: the case is entered by the last day of the evaluation month
 * (12.6-T1: evaluation 2026-09-20 → entry 2026-09-30, LAR 2026-09-29, effective 2026-10-01);
 * a processing month is an *election* under the partner's written policy, permitted only when
 * the case cannot be completed by the 15th of the evaluation month (12.6-T5). The custodian
 * clock (`FNMA_D23204_CUSTODIAN_25`) anchors on the effective date; the agreement goes ≤5
 * calendar days after completion (`FNMA_D23204_AGREEMENT_SEND_5`).
 */
export function timeline(evaluationOn: PlainDate, opts: TimelineOptions = {}): Timeline {
  const { y, m, d } = parts(evaluationOn);
  const fifteenth = ymd(y, m, 15);
  const completion = opts.completion_on ?? null;
  const permitted = d > 15 || (completion !== null && completion > fifteenth);
  const elected = opts.processing_month_elected === true;
  if (elected && !permitted) throw new RangeError(`processing month refused: evaluation ${evaluationOn} can be completed by the 15th of the evaluation month (D2-3.2-04)`);
  const processing = elected && permitted;
  const entryMonth = processing ? addMonths(ymd(y, m, 1), 1) : ymd(y, m, 1);
  const entryDeadline = endOfMonth(entryMonth);
  const eff = addMonths(entryMonth, 1);
  return { processing_month: processing, processing_month_permitted: permitted, entry_deadline: entryDeadline, lar_deadline: addBusinessDays(entryDeadline, -1, fannieEt), effective: eff, agreement_by: completion ? addDays(completion, 5) : null, custodian_by: addDays(eff, 25) };
}
