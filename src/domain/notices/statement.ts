/** §7.1 Periodic statement — cycle anchor, amount due, (d)(8) delinquency box, variants, reminder panel, Form 1098. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, daysBetween, dayOfWeek } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";

export function cycle(priorDueDate: PlainDate, graceDays: number, loanTz = "America/New_York"): { courtesy_period_end: PlainDate; statement_due_by: PlainDate; vendor_file_by: PlainDate; snapshot_at_ms: number } {
  const courtesy = addDays(priorDueDate, graceDays); const due = addDays(courtesy, 4);
  let vendor = addDays(due, -1); while (dayOfWeek(vendor) === 0 || dayOfWeek(vendor) === 6) vendor = addDays(vendor, -1);   // no business-day roll: file goes out the preceding weekday
  return { courtesy_period_end: courtesy, statement_due_by: due, vendor_file_by: vendor, snapshot_at_ms: zonedEpochMs(addDays(courtesy, 1), "01:00", loanTz) };
}
export interface AmountDue { readonly current_payment_cents: Cents; readonly past_due_cents: Cents; readonly late_charges_cents: Cents; readonly fees_cents: Cents; readonly suspense_cents: Cents; readonly accelerated_reinstatement_cents?: Cents | null; readonly tpp_payment_cents?: Cents | null; }
export function amountDue(a: AmountDue): { amount_due_cents: Cents; shortfall_to_complete_cents: Cents | null; suspense_disclosed_cents: Cents } {
  if (a.accelerated_reinstatement_cents != null) return { amount_due_cents: a.accelerated_reinstatement_cents, shortfall_to_complete_cents: null, suspense_disclosed_cents: a.suspense_cents };
  if (a.tpp_payment_cents != null) return { amount_due_cents: a.tpp_payment_cents, shortfall_to_complete_cents: null, suspense_disclosed_cents: a.suspense_cents };
  const due = a.current_payment_cents + a.past_due_cents + a.late_charges_cents + a.fees_cents;   // suspense never netted
  return { amount_due_cents: due, shortfall_to_complete_cents: a.suspense_cents > 0n ? a.current_payment_cents - a.suspense_cents : null, suspense_disclosed_cents: a.suspense_cents };
}
export function lateFeeLine(piCents: Cents, pct: string, cap: Cents | null): Cents { const v = divRound(piCents * Decimal.parse(pct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP"); return cap !== null && v > cap ? cap : v; }
export function delinquencyBox(statementDate: PlainDate, earliestUnpaidDue: PlainDate | null): { include: boolean; regx_days: number; began_on: PlainDate | null } {
  const days = earliestUnpaidDue ? daysBetween(earliestUnpaidDue, statementDate) : 0;
  return { include: days > 45, regx_days: days, began_on: earliestUnpaidDue ? addDays(earliestUnpaidDue, 1) : null };
}
export type Variant = "charged_off" | "bk_exempt" | "bk_modified_7_11" | "bk_modified_12_13" | "successor_unacknowledged" | "tpp" | "accelerated" | "delinquent" | "standard";
export function variant(f: { charged_off: boolean; bk_chapter: "7" | "11" | "12" | "13" | null; bk_exempt: boolean; successor_unacknowledged: boolean; tpp_active: boolean; accelerated: boolean; regx_days: number }): Variant {
  if (f.charged_off) return "charged_off"; if (f.bk_exempt) return "bk_exempt";
  if (f.bk_chapter) return f.bk_chapter === "12" || f.bk_chapter === "13" ? "bk_modified_12_13" : "bk_modified_7_11";
  if (f.successor_unacknowledged) return "successor_unacknowledged"; if (f.tpp_active) return "tpp"; if (f.accelerated) return "accelerated"; if (f.regx_days > 45) return "delinquent"; return "standard";
}
/** D2-2-03 reminder panel on statements dated on/after the 17th when the month's payment is unpaid and no forbearance. */
export function reminderPanel(statementDate: PlainDate, monthPaymentUnpaid: boolean, forbearanceActive: boolean): { panel: boolean; standalone_by: PlainDate | null } {
  const day = Number(statementDate.slice(8, 10));
  const needs = monthPaymentUnpaid && !forbearanceActive;
  return { panel: needs && day >= 17, standalone_by: needs ? (statementDate.slice(0, 8) + "20") as PlainDate : null };
}
export function form1098(interestAppliedCents: Cents, pointsCents: Cents, govAssistanceInterestCents: Cents, upbJan1Cents: Cents): { box1_cents: Cents; box2_cents: Cents } { return { box1_cents: interestAppliedCents - pointsCents - govAssistanceInterestCents, box2_cents: upbJan1Cents }; }
export function chargeOffNoticeDue(approvedOn: PlainDate): PlainDate { return addDays(approvedOn, 30); }
