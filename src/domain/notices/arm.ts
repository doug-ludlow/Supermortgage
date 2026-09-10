/**
 * §7.2/7.3 ARM adjustment notices — index selection, rate/caps, payment,
 * windows, initial estimate, error correction. This module is engine A
 * (`computeArmAdjustment`, fixed-scale Decimal); engine B lives in
 * arm-verify.ts and shares only the input/output types declared here.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { levelPayment } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export interface IndexObs { readonly effective_date: PlainDate; readonly value: string; /** 7.2 capture provenance (index_captures row / feed source), when known. */ readonly capture_id?: string; readonly source?: string; }
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
export type RateBound = "none" | "initial" | "periodic" | "lifetime" | "floor";
export function newRate(i: RateInputs): { new_rate_pct: string; unrounded_pct: string; bound: RateBound; midpoint_flag: boolean } {
  const unrounded = Decimal.parse(i.index_pct).add(Decimal.parse(i.margin_pct));
  const { rate: rounded, midpoint } = roundToEighth(unrounded, i.rounding);
  const prior = Decimal.parse(i.prior_rate_pct); const cap = Decimal.parse(i.first_change ? i.initial_cap_pct : i.periodic_cap_pct);
  const lo = prior.sub(cap), hi = prior.add(cap); const life = Decimal.parse(i.initial_note_rate_pct).add(Decimal.parse(i.lifetime_cap_pct)); const floor = Decimal.parse(i.margin_pct);
  let r = rounded; let bound: RateBound = "none";
  if (r.cmp(hi) > 0) { r = hi; bound = i.first_change ? "initial" : "periodic"; } else if (r.cmp(lo) < 0) { r = lo; bound = i.first_change ? "initial" : "periodic"; }
  if (r.cmp(life) > 0) { r = life; bound = "lifetime"; } if (r.cmp(floor) < 0) { r = floor; bound = "floor"; }
  return { new_rate_pct: r.toFixed(3), unrounded_pct: unrounded.toFixed(5), bound, midpoint_flag: midpoint };
}
export function newPayment(expectedUpb: Cents, ratePct: string, remainingTerm: number, interestOnly = false): Cents {
  if (interestOnly) return divRound(expectedUpb * Decimal.parse(ratePct).unscaled, 1200n * Decimal.ONE.unscaled, "HALF_UP");
  return levelPayment(expectedUpb, Decimal.parse(ratePct).div(Decimal.fromInt(100)), remainingTerm);
}

// ---- the two engines' shared contract (7.2 agent design: A and B must agree to the cent) ----
export interface ArmAdjustmentInput extends RateInputs { readonly expected_upb_cents: Cents; readonly remaining_term_months: number; readonly interest_only?: boolean; }
export interface ArmAdjustmentResult { readonly new_rate_pct: string; readonly unrounded_pct: string; readonly bound: RateBound; readonly new_pi_cents: Cents; readonly engine: "A" | "B"; }
/** Engine A (7.2 tool `computeArmAdjustment`): the Decimal engine above. */
export function computeArmAdjustment(i: ArmAdjustmentInput): ArmAdjustmentResult {
  const r = newRate(i);
  return { new_rate_pct: r.new_rate_pct, unrounded_pct: r.unrounded_pct, bound: r.bound, new_pi_cents: newPayment(i.expected_upb_cents, r.new_rate_pct, i.remaining_term_months, i.interest_only ?? false), engine: "A" };
}
/** Amortize `months` scheduled payments at one note rate (interest half-up to cents each month); the F-1-01 "expected UPB". */
export function scheduledUpbAfter(upb: Cents, ratePct: string, paymentCents: Cents, months: number): Cents {
  let bal = upb; const r = Decimal.parse(ratePct).unscaled;
  for (let i = 0; i < months; i++) { const interest = divRound(bal * r, 1200n * Decimal.ONE.unscaled, "HALF_UP"); bal -= paymentCents - interest; }
  return bal;
}
/** 7.2 rule 5 / decision 3: P&I sits inside the mandated table; escrow and the total are adjacent additional information. */
export function armNoticeFigures(f: { current_pi_cents: Cents; new_pi_cents: Cents; escrow_cents: Cents }): { current_total_cents: Cents; total_payment_cents: Cents } {
  return { current_total_cents: f.current_pi_cents + f.escrow_cents, total_payment_cents: f.new_pi_cents + f.escrow_cents };
}

// ---- windows and gates ----
export interface WindowOpenedEvent { readonly type: "arm.adjustment.notice_window_opened" | "arm.initial_notice.window_opened"; readonly payload: { readonly kind: "c" | "d"; readonly opens_on: PlainDate; readonly deadline: PlainDate; readonly first_new_payment_due: PlainDate }; }
/** §1026.20(c): notice between 60 and 120 days before the first new payment (25 for legacy short-lookback loans); index fixed at change − lookback. The not-before gate is satisfied by the window-opened event the schedule emits at −120. */
export function noticeWindow(firstNewPaymentDue: PlainDate, changeDate: PlainDate, lookbackDays: number, legacy25 = false): { not_before: PlainDate; deadline: PlainDate; sendable_from: PlainDate; window_opened_event: WindowOpenedEvent } {
  const not_before = addDays(firstNewPaymentDue, -120), deadline = addDays(firstNewPaymentDue, legacy25 ? -25 : -60);
  return { not_before, deadline, sendable_from: addDays(changeDate, -lookbackDays), window_opened_event: { type: "arm.adjustment.notice_window_opened", payload: { kind: "c", opens_on: not_before, deadline, first_new_payment_due: firstNewPaymentDue } } };
}
/** §1026.20(d) initial notice: 210–240 days before the first new payment; originator duty if ≤ 210 days from consummation. `arm.initial_notice.window_opened` (7.3 inputs) is the −240 gate's satisfying event. */
export function initialNoticeWindow(firstNewPaymentDue: PlainDate, consummation: PlainDate, termMonths: number): { status: "servicer" | "originator_duty" | "exempt_short_term"; not_before: PlainDate; deadline: PlainDate; send_target: PlainDate; window_opened_event: WindowOpenedEvent } {
  const not_before = addDays(firstNewPaymentDue, -240), deadline = addDays(firstNewPaymentDue, -210);
  const w = { not_before, deadline, send_target: addDays(firstNewPaymentDue, -235), window_opened_event: { type: "arm.initial_notice.window_opened" as const, payload: { kind: "d" as const, opens_on: not_before, deadline, first_new_payment_due: firstNewPaymentDue } } };
  if (termMonths <= 12) return { status: "exempt_short_term", ...w };
  if (daysBetween(consummation, firstNewPaymentDue) <= 210) return { status: "originator_duty", ...w };
  return { status: "servicer", ...w };
}
/** A send date against its window: before the not-before gate → blocked ("send blocked before"); after the deadline → breach (sev-1 on both the (c) and (d) rows). */
export function sendCheck(sendOn: PlainDate, w: { not_before: PlainDate; deadline: PlainDate }, timers: { gate: string; deadline: string }): { allowed: boolean; blocked_by: string | null; breach: { timer: string; severity: 1; days_late: number } | null } {
  if (sendOn < w.not_before) return { allowed: false, blocked_by: timers.gate, breach: null };
  if (sendOn > w.deadline) return { allowed: true, blocked_by: null, breach: { timer: timers.deadline, severity: 1, days_late: daysBetween(w.deadline, sendOn) } };
  return { allowed: true, blocked_by: null, breach: null };
}
export function indexFreshForInitial(obs: IndexObs, disclosureDate: PlainDate): boolean { return obs.effective_date >= addBusinessDays(disclosureDate, -15, servicer) && obs.effective_date <= disclosureDate; }
/**
 * 7.2 rule 8 / C-2.2-01: net effect of an adjustment error, positive = overcharge; > $1.00 combined → cash refund.
 * The spec writes `net_effect = reamortized_UPB − actual_UPB (positive = overcharge)`; that sign is inverted — an
 * overcharge (booked rate too high) leaves the booked (actual) UPB above the re-amortized one — so the engine
 * computes actual − reamortized and the discrepancy is reported for the audit.
 */
export function correction(reamortizedUpb: Cents, actualUpb: Cents, current: boolean, advances: boolean): { net_effect_cents: Cents; treatment: "cash_refund" | "credit_reallocation" | "absorbed" } {
  const net = actualUpb - reamortizedUpb;
  if (net > 100n) return { net_effect_cents: net, treatment: current && !advances ? "cash_refund" : "credit_reallocation" };
  return { net_effect_cents: net, treatment: net < 0n ? "absorbed" : "credit_reallocation" };
}
