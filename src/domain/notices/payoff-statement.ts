/** §7.6 Payoff statement — §1026.36(c)(3) clock, state overlays, reasonable-time path, per-diem arithmetic. */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

/** Day 1 = first servicer business day after receipt; due = day 7. */
export function federalDeadline(receivedOn: PlainDate): PlainDate { return addBusinessDays(receivedOn, 7, servicer); }
export function deadline(receivedOn: PlainDate, state: string, reasonableTime?: "bankruptcy" | "foreclosure" | "disaster" | "similar" | null): { due_on: PlainDate; state_due_on: PlainDate | null; ack_by: PlainDate | null; basis: string } {
  if (reasonableTime) return { due_on: addBusinessDays(receivedOn, 10, servicer), state_due_on: null, ack_by: addBusinessDays(receivedOn, 2, servicer), basis: `reasonable_time:${reasonableTime}` };
  const fed = federalDeadline(receivedOn);
  if (state === "FL") { const fl = addDays(receivedOn, 10); return { due_on: fl < fed ? fl : fed, state_due_on: fl, ack_by: null, basis: "earlier of federal 7 BD and FL §701.04 10 calendar days" }; }
  if (state === "CA") return { due_on: fed, state_due_on: addDays(receivedOn, 21), ack_by: null, basis: "federal 7 BD; CA §2943 21 days alongside" };
  return { due_on: fed, state_due_on: null, ack_by: null, basis: "federal 7 BD" };
}
/** Servicer business days from receipt to the send date (the checklist's `business_days_after_request`; day 1 = the first business day after receipt). */
export function businessDaysAfterRequest(receivedOn: PlainDate, sentOn: PlainDate): number {
  let n = 0; let d = receivedOn;
  while (d < sentOn) { d = addDays(d, 1); if (servicer.isBusinessDay(d)) n++; }
  return n;
}
export function perDiem(upb: Cents, ratePct: string): Cents { return divRound(upb * Decimal.parse(ratePct).unscaled, 100n * 365n * Decimal.ONE.unscaled, "HALF_UP"); }
export interface PayoffFigures { readonly upb_cents: Cents; readonly rate_pct: string; readonly paid_through: PlainDate; readonly good_through: PlainDate; readonly nib_cents?: Cents; readonly late_charges_cents?: Cents; readonly fees_advances_cents?: Cents; readonly recording_fee_cents?: Cents; readonly credits_cents?: Cents; readonly escrow_balance_cents?: Cents; }
/** Rule 4: escrow is never netted — the balance is refunded separately within 20 business days after payoff (§1024.34(b); 16.1 decision). */
export function payoff(f: PayoffFigures): { per_diem_cents: Cents; days: number; interest_cents: Cents; total_cents: Cents; escrow_treatment: "refund_separately_20bd"; escrow_refund_cents: Cents } {
  const days = daysBetween(f.paid_through, f.good_through);
  const pd = perDiem(f.upb_cents, f.rate_pct);
  const interest = divRound(f.upb_cents * Decimal.parse(f.rate_pct).unscaled * BigInt(days), 100n * 365n * Decimal.ONE.unscaled, "HALF_UP");   // exact daily accrual, rounded once
  const total = f.upb_cents + interest + (f.nib_cents ?? 0n) + (f.late_charges_cents ?? 0n) + (f.fees_advances_cents ?? 0n) + (f.recording_fee_cents ?? 0n) - (f.credits_cents ?? 0n);
  return { per_diem_cents: pd, days, interest_cents: interest, total_cents: total, escrow_treatment: "refund_separately_20bd", escrow_refund_cents: f.escrow_balance_cents ?? 0n };
}
/** The worked example's alternative figure: funds arriving before the scheduled payment is received — the pre-payment UPB with interest at the old rate through the change date and the noticed rate after it. */
export function payoffBeforeScheduledPayment(f: { upb_before_payment_cents: Cents; old_rate_pct: string; paid_through: PlainDate; change_date: PlainDate; new_rate_pct: string; good_through: PlainDate }): { upb_cents: Cents; segments: { from: PlainDate; through: PlainDate; rate_pct: string; days: number; per_diem_cents: Cents; interest_cents: Cents }[]; interest_cents: Cents; total_cents: Cents } {
  const seg = (from: PlainDate, through: PlainDate, rate: string) => { const days = daysBetween(from, through); const pd = perDiem(f.upb_before_payment_cents, rate); return { from, through, rate_pct: rate, days, per_diem_cents: pd, interest_cents: divRound(f.upb_before_payment_cents * Decimal.parse(rate).unscaled * BigInt(days), 100n * 365n * Decimal.ONE.unscaled, "HALF_UP") }; };
  const dayBeforeChange = addDays(f.change_date, -1);
  const segments = [seg(f.paid_through, dayBeforeChange, f.old_rate_pct), seg(dayBeforeChange, f.good_through, f.new_rate_pct)];
  const interest = segments.reduce((a, s) => a + s.interest_cents, 0n);
  return { upb_cents: f.upb_before_payment_cents, segments, interest_cents: interest, total_cents: f.upb_before_payment_cents + interest };
}
export function requesterAuthorization(kind: "borrower" | "confirmed_successor" | "attorney" | "counselor" | "lender_or_title" | "unknown", evidence: boolean): "consumer_request" | "authorized_agent" | "request_authorization_send_to_borrower" {
  if (kind === "borrower" || kind === "confirmed_successor") return "consumer_request";
  return evidence ? "authorized_agent" : "request_authorization_send_to_borrower";
}
