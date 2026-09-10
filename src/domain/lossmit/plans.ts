/** §12.4 Forbearance and §12.5 Repayment plans. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addMonths, addDays, endOfMonth } from "../../kernel/calendar/date.ts";

export const FB_INCREMENT_MAX = 3, FB_CUMULATIVE_MAX = 12, FB_DELINQUENCY_MAX = 12, COMBINED_MAX = 36;
export function forbearanceTerm(f: { requested_months: number; cumulative_months: number; months_delinquent_at_start: number; mbs_months_to_maturity?: number | null; combined_months?: number }): { months: number; capped_by: string[]; exception_required: boolean } {
  const caps: [number, string][] = [[FB_INCREMENT_MAX, "increment_3"], [f.requested_months, "requested"], [FB_CUMULATIVE_MAX - f.cumulative_months, "cumulative_12"], [FB_DELINQUENCY_MAX - f.months_delinquent_at_start, "delinquency_12"]];
  if (f.mbs_months_to_maturity != null) caps.push([f.mbs_months_to_maturity, "mbs_maturity"]);
  if (f.combined_months != null) caps.push([COMBINED_MAX - f.combined_months, "combined_36"]);
  const months = Math.max(0, Math.min(...caps.map((c) => c[0])));
  return { months, capped_by: caps.filter((c) => c[0] === months && c[1] !== "requested").map((c) => c[1]), exception_required: f.requested_months > months };
}
export function forbearanceTermDates(startOn: PlainDate, months: number): { start: PlainDate; end: PlainDate } { return { start: startOn, end: endOfMonth(addMonths(startOn, months - 1)) }; }
/** Reg X short-term: ≤ 6 forborne payments in total. */
export function regxShortTermForbearance(totalForbornePayments: number): boolean { return totalForbornePayments <= 6; }
export function preExpiryOutreachStart(termEnd: PlainDate): PlainDate { return addDays(termEnd, -30); }

export interface RepaymentTerms { readonly months: number; readonly installment_cents: Cents; readonly final_installment_cents: Cents; readonly total_monthly_cents: Cents; readonly pct_of_contractual: string; }
export function repaymentTerms(arrears: Cents, contractual: Cents, months: number): RepaymentTerms & { allowed: boolean } {
  const inst = divRound(arrears, BigInt(months), "CEIL");
  const total = contractual + inst; const pct = (Number(total * 10000n / contractual) / 100).toFixed(2);
  return { months, installment_cents: inst, final_installment_cents: arrears - inst * BigInt(months - 1), total_monthly_cents: total, pct_of_contractual: pct, allowed: total * 2n <= contractual * 3n };
}
/** Smallest term ≤ 12 satisfying the 150% cap and the borrower's capacity; none → ineligible (→ deferral path). */
export function repaymentPlan(arrears: Cents, contractual: Cents, capacityCents?: Cents | null): { eligible: true; terms: RepaymentTerms; regx_short_term: boolean; months_of_arrears: number } | { eligible: false; reason: "cannot_afford_repayment_plan"; next: "payment_deferral" } {
  const monthsOfArrears = Number(arrears / contractual);
  for (let m = 1; m <= 12; m++) { const t = repaymentTerms(arrears, contractual, m); if (t.allowed && (capacityCents == null || t.total_monthly_cents <= capacityCents)) return { eligible: true, terms: t, regx_short_term: monthsOfArrears <= 3 && m <= 6, months_of_arrears: monthsOfArrears }; }
  return { eligible: false, reason: "cannot_afford_repayment_plan", next: "payment_deferral" };
}
export function solicitationDue(failureMonthEnd: PlainDate): PlainDate { return addDays(addMonths(failureMonthEnd, 0), 15); }
