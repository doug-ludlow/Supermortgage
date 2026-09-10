/** §7.2/7.3 ARM adjustment notices — index selection, rate/caps, payment, windows, initial estimate, error correction. */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { levelPayment } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export interface IndexObs { readonly effective_date: PlainDate; readonly value: string; }
export function indexDate(changeDate: PlainDate, lookbackDays: number): PlainDate { return addDays(changeDate, -lookbackDays); }
export function selectIndex(obs: readonly IndexObs[], idxDate: PlainDate): IndexObs | null { return [...obs].filter((o) => o.effective_date <= idxDate).sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1))[0] ?? null; }
/** Round to the nearest 1/8 %; `half_down` (default) or `half_up` at exact midpoints, flagged for QC. */
export function roundToEighth(pct: Decimal, rule: "half_down" | "half_up" = "half_down"): { rate: Decimal; midpoint: boolean } {
  const eighth = Decimal.parse("0.125");
  const q = pct.div(eighth); const floor = Decimal.fromBigInt(q.toScaledInt(0, "FLOOR")); const frac = q.sub(floor);
  const mid = frac.cmp(Decimal.parse("0.5")) === 0;
  const up = frac.cmp(Decimal.parse("0.5")) > 0 || (mid && rule === "half_up");
  return { rate: (up ? floor.add(Decimal.ONE) : floor).mul(eighth), midpoint: mid };
}
export interface RateInputs { readonly index_pct: string; readonly margin_pct: string; readonly prior_rate_pct: string; readonly initial_note_rate_pct: string; readonly initial_cap_pct: string; readonly periodic_cap_pct: string; readonly lifetime_cap_pct: string; readonly first_change: boolean; readonly rounding?: "half_down" | "half_up"; }
export function newRate(i: RateInputs): { new_rate_pct: string; unrounded_pct: string; bound: "none" | "initial" | "periodic" | "lifetime" | "floor"; midpoint_flag: boolean } {
  const unrounded = Decimal.parse(i.index_pct).add(Decimal.parse(i.margin_pct));
  const { rate: rounded, midpoint } = roundToEighth(unrounded, i.rounding);
  const prior = Decimal.parse(i.prior_rate_pct); const cap = Decimal.parse(i.first_change ? i.initial_cap_pct : i.periodic_cap_pct);
  const lo = prior.sub(cap), hi = prior.add(cap); const life = Decimal.parse(i.initial_note_rate_pct).add(Decimal.parse(i.lifetime_cap_pct)); const floor = Decimal.parse(i.margin_pct);
  let r = rounded; let bound: "none" | "initial" | "periodic" | "lifetime" | "floor" = "none";
  if (r.cmp(hi) > 0) { r = hi; bound = i.first_change ? "initial" : "periodic"; } else if (r.cmp(lo) < 0) { r = lo; bound = i.first_change ? "initial" : "periodic"; }
  if (r.cmp(life) > 0) { r = life; bound = "lifetime"; } if (r.cmp(floor) < 0) { r = floor; bound = "floor"; }
  return { new_rate_pct: r.toFixed(3), unrounded_pct: unrounded.toFixed(5), bound, midpoint_flag: midpoint };
}
export function newPayment(expectedUpb: Cents, ratePct: string, remainingTerm: number, interestOnly = false): Cents {
  if (interestOnly) return divRound(expectedUpb * Decimal.parse(ratePct).unscaled, 1200n * Decimal.ONE.unscaled, "HALF_UP");
  return levelPayment(expectedUpb, Decimal.parse(ratePct).div(Decimal.fromInt(100)), remainingTerm);
}
/** §1026.20(c): notice between 60 and 120 days before the first new payment (25 for legacy short-lookback loans); index fixed at change − lookback. */
export function noticeWindow(firstNewPaymentDue: PlainDate, changeDate: PlainDate, lookbackDays: number, legacy25 = false): { not_before: PlainDate; deadline: PlainDate; sendable_from: PlainDate } {
  return { not_before: addDays(firstNewPaymentDue, -120), deadline: addDays(firstNewPaymentDue, legacy25 ? -25 : -60), sendable_from: addDays(changeDate, -lookbackDays) };
}
/** §1026.20(d) initial notice: 210–240 days before the first new payment; originator duty if ≤ 210 days from consummation. */
export function initialNoticeWindow(firstNewPaymentDue: PlainDate, consummation: PlainDate, termMonths: number): { status: "servicer" | "originator_duty" | "exempt_short_term"; not_before: PlainDate; deadline: PlainDate; send_target: PlainDate } {
  const w = { not_before: addDays(firstNewPaymentDue, -240), deadline: addDays(firstNewPaymentDue, -210), send_target: addDays(firstNewPaymentDue, -235) };
  if (termMonths <= 12) return { status: "exempt_short_term", ...w };
  if (daysBetween(consummation, firstNewPaymentDue) <= 210) return { status: "originator_duty", ...w };
  return { status: "servicer", ...w };
}
export function indexFreshForInitial(obs: IndexObs, disclosureDate: PlainDate): boolean { return obs.effective_date >= addBusinessDays(disclosureDate, -15, servicer) && obs.effective_date <= disclosureDate; }
/** 7.2 rule 8: re-amortized vs actual UPB; overcharge > $1.00 combined → cash refund. */
export function correction(reamortizedUpb: Cents, actualUpb: Cents, current: boolean, advances: boolean): { net_effect_cents: Cents; treatment: "cash_refund" | "credit_reallocation" | "absorbed" } {
  const net = reamortizedUpb - actualUpb;
  if (net > 100n) return { net_effect_cents: net, treatment: current && !advances ? "cash_refund" : "credit_reallocation" };
  return { net_effect_cents: net, treatment: net < 0n ? "absorbed" : "credit_reallocation" };
}
