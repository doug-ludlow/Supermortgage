/** §3.7 Tax/insurance disbursement — scheduling, discount capture, funds check and advances, hazard overlay. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export type Method = "tax_service_bulk" | "ach" | "check" | "wire";
export const LEAD_DAYS: Record<Method, number> = { tax_service_bulk: 5, ach: 2, check: 2, wire: 0 };

export interface Bill { readonly amount_cents: Cents; readonly due_on: PlainDate; readonly penalty_on?: PlainDate | null; readonly received_on: PlainDate; readonly discount?: { pct: string; by: PlainDate } | null; }
export interface Schedule { readonly release_on: PlainDate; readonly amount_cents: Cents; readonly must_pay_by: PlainDate; readonly discount_captured: boolean; readonly discount_lost_reason?: string; }

/** 3.7 rules 1–2. */
export function schedule(b: Bill, method: Method, escrowBalance: Cents, otherDueWithin30: Cents, capture = true): Schedule {
  const must = b.penalty_on ?? b.due_on;
  const discountAmt = b.discount ? divRound(b.amount_cents * Decimal.parse(b.discount.pct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP") : 0n;
  const canCapture = !!b.discount && capture && escrowBalance - otherDueWithin30 >= b.amount_cents - discountAmt && discountAmt > 0n;
  const target = canCapture ? b.discount!.by : must;
  let release = addBusinessDays(target, -LEAD_DAYS[method], servicer);
  if (release < b.received_on) release = b.received_on;
  if (!canCapture && release < addDays(must, -45)) release = addDays(must, -45);
  return { release_on: release, amount_cents: canCapture ? b.amount_cents - discountAmt : b.amount_cents, must_pay_by: must, discount_captured: canCapture, ...(b.discount && !canCapture ? { discount_lost_reason: "insufficient funds to capture without advance" } : {}) };
}
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
