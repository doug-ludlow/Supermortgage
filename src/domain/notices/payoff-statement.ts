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
export function perDiem(upb: Cents, ratePct: string): Cents { return divRound(upb * Decimal.parse(ratePct).unscaled, 100n * 365n * Decimal.ONE.unscaled, "HALF_UP"); }
export interface PayoffFigures { readonly upb_cents: Cents; readonly rate_pct: string; readonly paid_through: PlainDate; readonly good_through: PlainDate; readonly nib_cents?: Cents; readonly late_charges_cents?: Cents; readonly fees_advances_cents?: Cents; readonly recording_fee_cents?: Cents; readonly credits_cents?: Cents; }
export function payoff(f: PayoffFigures): { per_diem_cents: Cents; days: number; interest_cents: Cents; total_cents: Cents; escrow_treatment: "refund_separately_20bd" } {
  const days = daysBetween(f.paid_through, f.good_through);
  const pd = perDiem(f.upb_cents, f.rate_pct);
  const interest = divRound(f.upb_cents * Decimal.parse(f.rate_pct).unscaled * BigInt(days), 100n * 365n * Decimal.ONE.unscaled, "HALF_UP");   // exact daily accrual, rounded once
  const total = f.upb_cents + interest + (f.nib_cents ?? 0n) + (f.late_charges_cents ?? 0n) + (f.fees_advances_cents ?? 0n) + (f.recording_fee_cents ?? 0n) - (f.credits_cents ?? 0n);
  return { per_diem_cents: pd, days, interest_cents: interest, total_cents: total, escrow_treatment: "refund_separately_20bd" };
}
export function requesterAuthorization(kind: "borrower" | "confirmed_successor" | "attorney" | "counselor" | "lender_or_title" | "unknown", evidence: boolean): "consumer_request" | "authorized_agent" | "request_authorization_send_to_borrower" {
  if (kind === "borrower" || kind === "confirmed_successor") return "consumer_request";
  return evidence ? "authorized_agent" : "request_authorization_send_to_borrower";
}
