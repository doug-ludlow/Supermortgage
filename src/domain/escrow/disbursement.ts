/** §3.7 Tax/insurance disbursement — scheduling, discount capture, funds check and advances, hazard overlay. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export type Method = "tax_service_bulk" | "ach" | "check" | "wire" | "vendor_epay";
/** 3.7 timer table `ESC_RELEASE_LEAD_<METHOD>`: −10 business_days_servicer (tax_service_bulk), −7 (check), −3 (ach), −2 (vendor_epay), −1 (wire) before `must_pay_by`. */
export const LEAD_DAYS: Record<Method, number> = { tax_service_bulk: 10, check: 7, ach: 3, vendor_epay: 2, wire: 1 };

export interface Bill { readonly amount_cents: Cents; readonly due_on: PlainDate; readonly penalty_on?: PlainDate | null; readonly received_on: PlainDate; readonly discount?: { pct: string; by: PlainDate } | null; }
export interface Schedule { readonly release_on: PlainDate; readonly amount_cents: Cents; readonly must_pay_by: PlainDate; readonly method: Method; readonly lead_business_days: number; readonly discount_captured: boolean; readonly discount_lost_reason?: string; readonly discount_release_warn_on?: PlainDate; }

/**
 * 3.7 rules 1–2. `release_on = must_pay_by − lead(method)` in servicer business days; when the discount is captured
 * (funds available, no advance) the release is pulled to the discount date if it would otherwise fall after it —
 * `FNMA_B101_DISCOUNT_CAPTURE_WARN` is satisfied by "`disbursement.released` by discount date when funds available",
 * and the worked example / 3.7-T1 release the $760 bill 10 BD before the 12/10 must-pay date (2027-11-26), before the
 * 11/30 discount date. (Rule 1's `min(discount_date, must_pay_by) − lead` formula would give 2027-11-15 — spec discrepancy.)
 * Never earlier than the bill's receipt and, without a discount, never earlier than must_pay_by − 45 calendar days.
 */
export function schedule(b: Bill, method: Method, escrowBalance: Cents, otherDueWithin30: Cents, capture = true): Schedule {
  const must = b.penalty_on ?? b.due_on;
  const lead = LEAD_DAYS[method];
  const discountAmt = b.discount ? divRound(b.amount_cents * Decimal.parse(b.discount.pct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP") : 0n;
  const canCapture = !!b.discount && capture && escrowBalance - otherDueWithin30 >= b.amount_cents - discountAmt && discountAmt > 0n;
  let release = addBusinessDays(must, -lead, servicer);
  if (canCapture && release > b.discount!.by) release = b.discount!.by;
  if (release < b.received_on) release = b.received_on;
  if (!canCapture && release < addDays(must, -45)) release = addDays(must, -45);
  return {
    release_on: release, amount_cents: canCapture ? b.amount_cents - discountAmt : b.amount_cents, must_pay_by: must, method, lead_business_days: lead, discount_captured: canCapture,
    ...(b.discount && !canCapture ? { discount_lost_reason: "insufficient funds to capture without advance" } : {}),
    ...(b.discount ? { discount_release_warn_on: addBusinessDays(b.discount.by, -lead, servicer) } : {}),
  };
}
/** The method lead is honored when the payment leaves at least `lead` servicer business days before `must_pay_by` (REGX_1024_17K_DISBURSE_BEFORE_PENALTY_0: "sent with method lead honored"). */
export function leadHonored(releaseOn: PlainDate, mustPayBy: PlainDate, method: Method): boolean { return releaseOn <= addBusinessDays(mustPayBy, -LEAD_DAYS[method], servicer); }
/** 3.7 rule 4: never delay for lack of funds — advance the gap. */
export function fundsCheck(amount: Cents, escrowBalance: Cents, reservedWithin5BD: Cents): { release: true; advance_cents: Cents; escrow_after_cents: Cents } {
  const available = escrowBalance - reservedWithin5BD; const adv = amount - (available > 0n ? available : 0n);
  return { release: true, advance_cents: adv > 0n ? adv : 0n, escrow_after_cents: escrowBalance - amount };
}
/** (k)(3)–(4) installment vs annual. */
export function installmentChoice(j: { annual_discount_pct?: string | null; installment_fee: boolean }, fundsAvailable: boolean, borrowerPreference?: "installments" | "annual"): "installments" | "annual" {
  if (borrowerPreference) return borrowerPreference;
  if (!j.annual_discount_pct && !j.installment_fee) return "installments";
  return j.annual_discount_pct && Decimal.parse(j.annual_discount_pct).cmp(Decimal.ONE) >= 0 && fundsAvailable ? "annual" : "installments";
}
/** (k)(5) hazard overlay for a borrower > 30 days overdue: pay unless a documented inability exists. */
export function hazardDecision(daysOverdue: number, cancellationReason: string | null, vacant: boolean): { pay: boolean; inability_to_disburse: boolean; lpi_gate_open: boolean } {
  const inability = daysOverdue > 30 && ((cancellationReason !== null && cancellationReason !== "non_payment") || vacant);
  return { pay: !inability, inability_to_disburse: inability, lpi_gate_open: inability };
}
/** Illinois 765 ILCS 910/15: tax-paid notice within 45 business days. */
export function ilTaxPaidNoticeDue(confirmedOn: PlainDate): PlainDate { return addBusinessDays(confirmedOn, 45, servicer); }
export function rejectReplanDue(rejectedOn: PlainDate): PlainDate { return addBusinessDays(rejectedOn, 2, servicer); }
