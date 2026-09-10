/** §5.6 Repurchase reporting — pricing, appeal ladder, DPO indemnification. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { monthInterest, payoffInterest } from "./remittance.ts";

export function mbsRepurchasePrice(scheduledUpb: Cents, ptr: string): { principal_cents: Cents; interest_cents: Cents; price_cents: Cents; action_code: "65" } {
  const i = monthInterest(scheduledUpb, ptr); return { principal_cents: scheduledUpb, interest_cents: i, price_cents: scheduledUpb + i, action_code: "65" };
}
export function portfolioAaRepurchasePrice(actualUpb: Cents, purchasePricePct: string, ptr: string, lpi: PlainDate, effective: PlainDate, expensesCents = 0n): { principal_cents: Cents; interest_cents: Cents; price_cents: Cents } {
  const principal = divRound(actualUpb * Decimal.parse(purchasePricePct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP");
  const interest = payoffInterest("AA", actualUpb, ptr, lpi, effective);
  return { principal_cents: principal, interest_cents: interest, price_cents: principal + interest + expensesCents };
}
/** Demand ladder: pay-by and first appeal 60 days from receipt; second appeal 15 days after a denial. */
export function appealLadder(demandReceived: PlainDate, firstDenialReceived?: PlainDate): { pay_by: PlainDate; first_appeal_by: PlainDate; second_appeal_by: PlainDate | null } {
  return { pay_by: addDays(demandReceived, 60), first_appeal_by: addDays(demandReceived, 60), second_appeal_by: firstDenialReceived ? addDays(firstDenialReceived, 15) : null };
}
/** A1-3-02 DPO arithmetic: indemnification = denied claim × payout %; a later higher payout bills the increment. */
export function dpoIndemnification(deniedClaimCents: Cents, payoutPct: string, previouslyPaidCents = 0n): Cents {
  const total = divRound(deniedClaimCents * Decimal.parse(payoutPct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP");
  return total - previouslyPaidCents;
}
