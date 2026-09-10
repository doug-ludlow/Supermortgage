/** §16.1 Payoff statement figures — F-1-09 accrual (monthly 30/360 + partial 365 or DSI), rate segments, components, state overlays. */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, addMonths, daysBetween, parts, ymd } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, type Calendar } from "../../kernel/calendar/business.ts";

export type Accrual = "monthly_30_360_partial_365" | "daily_simple_365";
export function perDiem(upb: Cents, ratePct: string): Cents { return divRound(upb * Decimal.parse(ratePct).unscaled, 100n * 365n * Decimal.ONE.unscaled, "HALF_UP"); }
export function accrualStart(lpiDue: PlainDate): PlainDate { return lpiDue; }
/** Interest through payoff_date − 1 (funds deemed received on payoff_date). */
export function interest(upb: Cents, ratePct: string, accrualStartOn: PlainDate, payoffOn: PlainDate, method: Accrual = "monthly_30_360_partial_365"): { months_full: number; days_partial: number; full_cents: Cents; partial_cents: Cents; total_cents: Cents } {
  if (method === "daily_simple_365") { const days = daysBetween(accrualStartOn, payoffOn); const t = divRound(upb * Decimal.parse(ratePct).unscaled * BigInt(days), 100n * 365n * Decimal.ONE.unscaled, "HALF_UP"); return { months_full: 0, days_partial: days, full_cents: 0n, partial_cents: t, total_cents: t }; }
  let months = 0; let cursor = accrualStartOn;
  while (addMonths(cursor, 1) <= payoffOn) { cursor = addMonths(cursor, 1); months++; }
  const days = daysBetween(cursor, payoffOn);
  const full = BigInt(months) * monthlyInterest(upb, ratePercent(ratePct));
  const partial = divRound(upb * Decimal.parse(ratePct).unscaled * BigInt(days), 100n * 365n * Decimal.ONE.unscaled, "HALF_UP");
  return { months_full: months, days_partial: days, full_cents: full, partial_cents: partial, total_cents: full + partial };
}
/** F-1-09 non-business-day rule: funds arriving the next business day after a non-business due date are deemed received on the due date. */
export function deemedPayoffDate(receivedOn: PlainDate, dueOn: PlainDate, cal: Calendar = servicer): PlainDate { return !cal.isBusinessDay(dueOn) && receivedOn === addBusinessDays(dueOn, 1, cal) ? dueOn : receivedOn; }
export interface Components { readonly upb_cents: Cents; readonly rate_pct: string; readonly lpi_due: PlainDate; readonly good_through: PlainDate; readonly nib_deferred_cents?: Cents; readonly nib_forborne_cents?: Cents; readonly late_charges_cents?: Cents; readonly fees_cents?: Cents; readonly corporate_advances_cents?: Cents; readonly escrow_advance_cents?: Cents; readonly recording_fee_cents?: Cents; readonly mi_premium_cents?: Cents; readonly buydown_credit_cents?: Cents; readonly suspense_credit_cents?: Cents; readonly method?: Accrual; }
export function quote(c: Components): { interest: ReturnType<typeof interest>; per_diem_cents: Cents; total_cents: Cents; nib_line_cents: Cents; escrow_note: "refunded_separately_20bd" } {
  const i = interest(c.upb_cents, c.rate_pct, accrualStart(c.lpi_due), c.good_through, c.method);
  const nib = (c.nib_deferred_cents ?? 0n) + (c.nib_forborne_cents ?? 0n);
  const total = c.upb_cents + i.total_cents + nib + (c.late_charges_cents ?? 0n) + (c.fees_cents ?? 0n) + (c.corporate_advances_cents ?? 0n) + (c.escrow_advance_cents ?? 0n) + (c.recording_fee_cents ?? 0n) + (c.mi_premium_cents ?? 0n) - (c.buydown_credit_cents ?? 0n) - (c.suspense_credit_cents ?? 0n);
  return { interest: i, per_diem_cents: perDiem(c.upb_cents, c.rate_pct), total_cents: total, nib_line_cents: nib, escrow_note: "refunded_separately_20bd" };
}
/** Funds received on a different date than good-through: exact recompute vs statement. */
export function reconcile(c: Components, statementTotal: Cents, receivedOn: PlainDate, amountCents: Cents): { exact_total_cents: Cents; variance_cents: Cents; outcome: "over" | "short" | "exact" } {
  const exact = quote({ ...c, good_through: receivedOn }).total_cents; const v = amountCents - exact;
  void statementTotal; return { exact_total_cents: exact, variance_cents: v, outcome: v > 0n ? "over" : v < 0n ? "short" : "exact" };
}
export const RELIANCE_STATES = new Set(["FL", "TX", "CA"]);
export function stateStatementDeadline(state: string, requestOn: PlainDate): PlainDate | null { if (state === "MA") return addBusinessDays(requestOn, 5, servicer); if (state === "FL") return addDays(requestOn, 10); if (state === "CA") return addDays(requestOn, 21); return null; }
export function rateSegments(upb: Cents, segments: { from: PlainDate; to: PlainDate; rate_pct: string }[]): Cents { return segments.reduce((s, seg) => s + interest(upb, seg.rate_pct, seg.from, seg.to).total_cents, 0n); }
export function firstOfMonth(d: PlainDate): PlainDate { const { y, m } = parts(d); return ymd(y, m, 1); }
