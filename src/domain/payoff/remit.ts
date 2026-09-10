/** §16.2 Remit payoff proceeds — variance tolerance, application order, Fannie Mae share, remittance clocks, housekeeping. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal, fannieEt, nextBusinessDay, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";
import { payoffInterest, monthInterest } from "../investor/remittance.ts";
import { interest } from "./quote.ts";

export const SHORT_TOLERANCE_CENTS = 5_000n, OVER_TOLERANCE_CENTS = 100n;
export function variance(amount: Cents, exact: Cents, relianceState: boolean, withinGoodThrough: boolean): { variance_cents: Cents; disposition: "paid_in_full" | "paid_in_full_tolerance_expense" | "paid_in_full_overage_refund_10bd" | "short_payoff_demand_1bd" | "reliance_absorbed" } {
  const v = amount - exact;
  if (v === 0n) return { variance_cents: v, disposition: "paid_in_full" };
  if (v > OVER_TOLERANCE_CENTS) return { variance_cents: v, disposition: "paid_in_full_overage_refund_10bd" };
  if (v >= -SHORT_TOLERANCE_CENTS) return { variance_cents: v, disposition: "paid_in_full_tolerance_expense" };
  return { variance_cents: v, disposition: relianceState && withinGoodThrough ? "reliance_absorbed" : "short_payoff_demand_1bd" };
}
export const APPLICATION_ORDER = ["accrued_interest", "principal", "nib_deferred", "nib_forborne", "escrow_advance", "late_charges", "nsf_other_fees", "corporate_advances", "recording_release_fee"] as const;
export function fnmaShare(f: { type: "AA" | "SA" | "SS"; upb_cents: Cents; nib_cents: Cents; note_rate_pct: string; ptr_pct: string; lpi_due: PlainDate; payoff_on: PlainDate; participation?: string; processed_bd1_reported_bd2?: boolean }): { principal_cents: Cents; interest_cents: Cents; collected_interest_cents: Cents; servicing_fee_cents: Cents; ss_interest_gap_cents: Cents; total_cents: Cents } {
  const collected = interest(f.upb_cents, f.note_rate_pct, f.lpi_due, f.payoff_on).total_cents;
  let fnmaInt = payoffInterest(f.type, f.upb_cents, f.ptr_pct, f.lpi_due, f.payoff_on);
  if (f.type === "SS" && f.processed_bd1_reported_bd2) fnmaInt = 0n;
  // S/S: Fannie Mae is owed a full month at PTR for the payoff month; the borrower paid only the partial days → servicer funds the gap (F-1-20).
  const ptrPartialCollected = interest(f.upb_cents, f.ptr_pct, f.lpi_due, f.payoff_on).partial_cents;
  const gap = f.type === "SS" && fnmaInt > 0n ? fnmaInt - ptrPartialCollected : 0n;
  return { principal_cents: f.upb_cents + f.nib_cents, interest_cents: fnmaInt, collected_interest_cents: collected, servicing_fee_cents: f.type === "AA" ? collected - fnmaInt : 0n, ss_interest_gap_cents: gap > 0n ? gap : 0n, total_cents: f.upb_cents + f.nib_cents + fnmaInt };
}
export function aaRemittanceClock(receivedAtMs: number): { crs_same_day: boolean; settlement_on: PlainDate; lar60_due_ms: number } {
  const d = wallClock(receivedAtMs, "America/New_York").date; const cutoff = zonedEpochMs(d, "16:00", "America/New_York");
  const instructOn = receivedAtMs <= cutoff ? d : nextBusinessDay(d, fannieEt);
  return { crs_same_day: receivedAtMs <= cutoff, settlement_on: nextBusinessDay(instructOn, federal), lar60_due_ms: zonedEpochMs(nextBusinessDay(d, fannieEt), "20:00", "America/New_York") };
}
export function housekeeping(payoffOn: PlainDate): { escrow_refund_by: PlainDate; short_year_statement_by: PlainDate; mi_notify_by: PlainDate; insurance_tax_by: PlainDate; overage_refund_by: PlainDate; short_demand_by: PlainDate; short_cure_by: PlainDate; fnma_advance_special_remit_by: PlainDate } {
  return { escrow_refund_by: addBusinessDays(payoffOn, 20, federal), short_year_statement_by: addDays(payoffOn, 60), mi_notify_by: addBusinessDays(payoffOn, 2, servicer), insurance_tax_by: addBusinessDays(payoffOn, 5, servicer), overage_refund_by: addBusinessDays(payoffOn, 10, servicer), short_demand_by: addBusinessDays(payoffOn, 1, servicer), short_cure_by: addDays(payoffOn, 30), fnma_advance_special_remit_by: addDays(payoffOn, 30) };
}
export function reversal(returnedOn: PlainDate, periodCloseOn: PlainDate): "correcting_removal_reopen" | "fnma_liquidated_in_error" { return returnedOn <= periodCloseOn ? "correcting_removal_reopen" : "fnma_liquidated_in_error"; }
export { monthInterest };
