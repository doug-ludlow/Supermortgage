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
/** `jurisdiction_rules.payoff` (16.1 prerequisites): the statutory statement-deadline matrix and the reliance/fee overlays the spec verified. */
export interface StatePayoffRule { readonly deadline_days: number; readonly deadline_calendar: "calendar" | "business_servicer"; readonly cite: string; readonly reliance_rule: "none" | "binding_through_good_through" | "no_disclaimer" | "corrected_statement_cutoff"; readonly interest_forfeit_if_late: boolean; readonly min_validity_days: number | null; readonly required_form: string | null; readonly fee_repeat_cents: Cents; readonly exposure: string | null; }
export const STATE_PAYOFF_RULES: Record<string, StatePayoffRule> = {
  CA: { deadline_days: 21, deadline_calendar: "calendar", cite: "Cal. Civ. Code §2943", reliance_rule: "binding_through_good_through", interest_forfeit_if_late: false, min_validity_days: null, required_form: null, fee_repeat_cents: 3_000n, exposure: "$300 forfeiture" },
  FL: { deadline_days: 10, deadline_calendar: "calendar", cite: "Fla. Stat. §701.04(1)", reliance_rule: "no_disclaimer", interest_forfeit_if_late: false, min_validity_days: null, required_form: null, fee_repeat_cents: 0n, exposure: "prevailing-party attorney fees" },
  NY: { deadline_days: 30, deadline_calendar: "calendar", cite: "N.Y. RPL §274-a", reliance_rule: "none", interest_forfeit_if_late: false, min_validity_days: null, required_form: null, fee_repeat_cents: 2_000n, exposure: "actual damages" },
  NC: { deadline_days: 10, deadline_calendar: "calendar", cite: "N.C.G.S. 45-36.7", reliance_rule: "none", interest_forfeit_if_late: false, min_validity_days: null, required_form: null, fee_repeat_cents: 2_500n, exposure: null },
  MA: { deadline_days: 5, deadline_calendar: "business_servicer", cite: "M.G.L. c.183 §54D", reliance_rule: "none", interest_forfeit_if_late: false, min_validity_days: 30, required_form: null, fee_repeat_cents: 0n, exposure: "greater of $500 or actual damages" },
  TX: { deadline_days: 7, deadline_calendar: "business_servicer", cite: "Tex. Fin. Code §343.106; 7 TAC §155.2 [PARTIALLY VERIFIED]", reliance_rule: "binding_through_good_through", interest_forfeit_if_late: false, min_validity_days: null, required_form: "Texas Payoff Statement Form (Finance Commission)", fee_repeat_cents: 0n, exposure: null },
  CT: { deadline_days: 7, deadline_calendar: "business_servicer", cite: "C.G.S. §49-10a", reliance_rule: "none", interest_forfeit_if_late: true, min_validity_days: null, required_form: null, fee_repeat_cents: 0n, exposure: "interest forfeiture after the request date" },
};
/** §1026.36(c)(3): 7 business days (calendar `servicer`) after receipt of the written request. */
export function federalStatementDeadline(requestOn: PlainDate): PlainDate { return addBusinessDays(requestOn, 7, servicer); }
/**
 * `STATE_PAYOFF_STMT_DEADLINE`: CA 21 CD, FL 10 CD, NY 30 CD, NC 10 CD, MA 5 BD, TX 7 BD; CT = the requested payoff date when it is
 * at least 7 BD after receipt, else 7 BD (the statutory floor). States without a located deadline return null (federal only).
 */
export function stateStatementDeadline(state: string, requestOn: PlainDate, requestedPayoffDate: PlainDate | null = null): PlainDate | null {
  const r = STATE_PAYOFF_RULES[state]; if (!r) return null;
  const floor = r.deadline_calendar === "calendar" ? addDays(requestOn, r.deadline_days) : addBusinessDays(requestOn, r.deadline_days, servicer);
  if (state === "CT") return requestedPayoffDate && requestedPayoffDate >= floor ? requestedPayoffDate : floor;
  return floor;
}
/** The earliest of the federal and state deadlines drives the 70% warning and the breach (16.1 timer table). */
export function statementDeadlines(state: string, requestOn: PlainDate, requestedPayoffDate: PlainDate | null = null): { federal_due: PlainDate; state_due: PlainDate | null; governing: "federal" | "state"; governing_due: PlainDate; warning_on: PlainDate; state_cite: string | null; interest_forfeit_if_late: boolean } {
  const federal = federalStatementDeadline(requestOn); const st = stateStatementDeadline(state, requestOn, requestedPayoffDate);
  const governing = st !== null && st < federal ? "state" : "federal"; const due = governing === "state" ? st! : federal;
  const warning = addDays(requestOn, Math.floor(daysBetween(requestOn, due) * 0.7));
  return { federal_due: federal, state_due: st, governing, governing_due: due, warning_on: warning, state_cite: STATE_PAYOFF_RULES[state]?.cite ?? null, interest_forfeit_if_late: STATE_PAYOFF_RULES[state]?.interest_forfeit_if_late ?? false };
}
/** Rule 10: `valid_until = good_through`, never earlier than issue + 30 CD in MA (§54D). */
export function validUntil(state: string, issuedOn: PlainDate, goodThrough: PlainDate): PlainDate { const min = STATE_PAYOFF_RULES[state]?.min_validity_days ?? null; const floor = min === null ? goodThrough : addDays(issuedOn, min); return floor > goodThrough ? floor : goodThrough; }
/**
 * Rule 7 alternative figures: a scheduled installment (or autodraft) between `calc_at` and `good_through` prints
 * (a) the figure if it posts as scheduled — UPB less its principal portion, interest paid through the day before
 * its due date — and (b) the figure if it does not (the ordinary quote). 16.2 reconciles the pair at receipt.
 */
export function alternativeFigures(c: Components, f: { calc_at: PlainDate; installment_due: PlainDate; installment_principal_cents: Cents; autodraft?: boolean }): { applies: boolean; if_installment_posts: { total_cents: Cents; upb_cents: Cents; accrual_start: PlainDate; interest_cents: Cents } | null; if_installment_not_posted: { total_cents: Cents; interest_cents: Cents }; label: string | null } {
  const base = quote(c);
  const applies = f.installment_due > f.calc_at && f.installment_due <= c.good_through;
  if (!applies) return { applies: false, if_installment_posts: null, if_installment_not_posted: { total_cents: base.total_cents, interest_cents: base.interest.total_cents }, label: null };
  const posted = quote({ ...c, upb_cents: c.upb_cents - f.installment_principal_cents, lpi_due: f.installment_due });
  return { applies: true, if_installment_posts: { total_cents: posted.total_cents, upb_cents: c.upb_cents - f.installment_principal_cents, accrual_start: f.installment_due, interest_cents: posted.interest.total_cents }, if_installment_not_posted: { total_cents: base.total_cents, interest_cents: base.interest.total_cents }, label: `${f.autodraft ? "autodraft" : "installment"} due ${f.installment_due} falls before the good-through date` };
}
export function rateSegments(upb: Cents, segments: { from: PlainDate; to: PlainDate; rate_pct: string }[]): Cents { return segments.reduce((s, seg) => s + interest(upb, seg.rate_pct, seg.from, seg.to).total_cents, 0n); }
export function firstOfMonth(d: PlainDate): PlainDate { const { y, m } = parts(d); return ymd(y, m, 1); }
