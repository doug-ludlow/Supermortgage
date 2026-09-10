/** §12.6 Payment Deferral and §12.7 Disaster Payment Deferral. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addMonths, parts, ymd, endOfMonth, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";

export interface DeferralFacts { readonly months_delinquent: number; readonly origination_date: PlainDate; readonly evaluation_date: PlainDate; readonly prior_deferral_effective?: PlainDate | null; readonly prior_deferral_was_disaster?: boolean; readonly cumulative_deferred_months: number; readonly months_to_maturity: number; readonly disaster?: { delinquency_months_at_disaster: number; same_event_deferred_before: boolean } | null; }
export type Screen = { eligible: true; contractual_payment_required: boolean; months_deferred: number } | { eligible: false; reason: string; next: "flex_mod" | "fnma_prior_approval" };
export function screen(f: DeferralFacts): Screen {
  if (f.disaster) {
    if (f.disaster.same_event_deferred_before) return { eligible: false, reason: "INV_FNMA_D23204_SAME_DISASTER_EVENT", next: "flex_mod" };
    if (f.disaster.delinquency_months_at_disaster >= 2) return { eligible: false, reason: "INV_FNMA_D23204_DELQ_AT_DISASTER", next: "fnma_prior_approval" };
    if (f.months_delinquent < 1 || f.months_delinquent > 12) return { eligible: false, reason: "INV_FNMA_D23204_DELQ_WINDOW", next: "flex_mod" };
    return { eligible: true, contractual_payment_required: f.months_delinquent === 12, months_deferred: f.months_delinquent };
  }
  if (f.months_delinquent < 2 || f.months_delinquent > 6) return { eligible: false, reason: "INV_FNMA_D23204_DELQ_WINDOW", next: "flex_mod" };
  if (f.prior_deferral_effective && !f.prior_deferral_was_disaster && addMonths(f.prior_deferral_effective, 12) > f.evaluation_date) return { eligible: false, reason: "INV_FNMA_D23204_PRIOR_DEFERRAL_12M", next: "flex_mod" };
  if (f.months_to_maturity < 36) return { eligible: false, reason: "INV_FNMA_D23204_MATURITY", next: "flex_mod" };
  const after = f.cumulative_deferred_months + f.months_delinquent;
  return { eligible: true, contractual_payment_required: f.months_delinquent === 6 || after > 12, months_deferred: after > 12 ? Math.max(0, 12 - f.cumulative_deferred_months) : f.months_delinquent };
}
export function nib(piCents: Cents, monthsDeferred: number, escrowAdvances: Cents, servicingAdvances: Cents): Cents { return BigInt(monthsDeferred) * piCents + escrowAdvances + servicingAdvances; }
export function newPayment(piCents: Cents, tiMonthly: Cents, escrowShortage: Cents): { shortage_monthly_cents: Cents; payment_cents: Cents } { const s = divRound(escrowShortage, 60n, "HALF_UP"); return { shortage_monthly_cents: s, payment_cents: piCents + tiMonthly + s }; }
export function timeline(evaluationOn: PlainDate, completionOn?: PlainDate): { processing_month: boolean; entry_deadline: PlainDate; lar_deadline: PlainDate; effective: PlainDate; agreement_by: PlainDate | null; custodian_by: PlainDate | null } {
  const { y, m, d } = parts(evaluationOn); const processing = d > 15;
  const entryMonth = processing ? addMonths(ymd(y, m, 1), 1) : ymd(y, m, 1);
  const entryDeadline = endOfMonth(entryMonth);
  const eff = addMonths(entryMonth, 1);
  return { processing_month: processing, entry_deadline: entryDeadline, lar_deadline: addBusinessDays(entryDeadline, -1, fannieEt), effective: eff, agreement_by: completionOn ? addDays(completionOn, 5) : null, custodian_by: completionOn ? addDays(completionOn, 25) : null };
}
