/**
 * §16.1 operating rules over the payoff calculators in ./quote.ts (F-1-09
 * accrual, state deadline matrix, validity, alternative figures): the
 * `payoff_quotes` row and its hash; the rate segments and post-statement
 * rate change of rule 4; the per-diem tolerance of rule 3 and the funds
 * reconciliation of example A (over/short events); the escrow paragraph and
 * 3.5 cut-off of rule 6; the accuracy gate, wire-verification gate and
 * verification token of the timer table; the good-through cap; the
 * statutory statement deadline anchor; the third-party authorization clock;
 * the FL corrected-estoppel cutoff, TX Finance Commission request and
 * reliance shortage disposition of rule 10; the oral quote of rule 11; the
 * CT floor and forfeiture finding; the A4-2.1-07 NIB maturity notices and
 * sweep; and the recompute chain (updated statement to every prior
 * recipient, original retained with `superseded_by`). Every figure comes
 * from `quote()`; nothing here does arithmetic the calculators do not.
 */
import { createHash } from "node:crypto";
import type { Cents } from "../../kernel/money/cents.ts";
import { formatCents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, addMonths, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, toIso, wallClock } from "../../kernel/calendar/zoned.ts";
import { longDate } from "../../notices/render.ts";
import { requesterAuthorization, businessDaysAfterRequest } from "../notices/payoff-statement.ts";
import { oralPayoffRequest, payoffClockStart } from "../notices/ops.ts";
import { perDiem, deemedPayoffDate, statementDeadlines, validUntil, RELIANCE_STATES, STATE_PAYOFF_RULES, type Components, type Accrual } from "./quote.ts";
import { variance as remitVariance } from "./remit.ts";

const money = (c: Cents): string => formatCents(c, { symbol: true, grouping: true });

// ============================================================ rules 2–3 — F-1-09 day count with one rounding per component
/**
 * Rule 2 day count with rule 3 rounding: the full-month block (`months_full` × UPB × rate ÷ 12) and the partial block
 * (UPB × rate ÷ 365 × `days_partial`) are each rounded half-up to cents **once**. The shared calculator in ./quote.ts
 * rounds every month and multiplies (`months × round(UPB × rate ÷ 12)`), which is a cent high whenever `months_full ≥ 2`
 * (example A over two full months: 24,831,055 × 6.500% × 2 ÷ 12 = 269,003.10 cents → $2,690.03, not 2 × $1,345.02 =
 * $2,690.04) — quote.ts is read-only to this process, so the corrected function lives here and every 16.1 figure uses it.
 * DSI loans (`daily_simple_365`) accrue daily on a 365-day year with no full-month block. Interest runs through `payoffOn − 1`
 * (funds deemed received on `payoffOn`).
 */
export function interestF109(upb: Cents, ratePct: string, accrualStartOn: PlainDate, payoffOn: PlainDate, method: Accrual = "monthly_30_360_partial_365"): { months_full: number; days_partial: number; full_cents: Cents; partial_cents: Cents; total_cents: Cents } {
  const rate = Decimal.parse(ratePct).unscaled; const den = 100n * Decimal.ONE.unscaled;
  if (method === "daily_simple_365") { const days = daysBetween(accrualStartOn, payoffOn); const t = days === 0 ? 0n : divRound(upb * rate * BigInt(days), den * 365n, "HALF_UP"); return { months_full: 0, days_partial: days, full_cents: 0n, partial_cents: t, total_cents: t }; }
  let months = 0; let cursor = accrualStartOn;
  while (addMonths(cursor, 1) <= payoffOn) { cursor = addMonths(cursor, 1); months++; }
  const days = daysBetween(cursor, payoffOn);
  const full = months === 0 ? 0n : divRound(upb * rate * BigInt(months), den * 12n, "HALF_UP");
  const partial = days === 0 ? 0n : divRound(upb * rate * BigInt(days), den * 365n, "HALF_UP");
  return { months_full: months, days_partial: days, full_cents: full, partial_cents: partial, total_cents: full + partial };
}
/** Rule 6 components over `interestF109`: the same shape as quote.ts `quote()` with the rule-3 rounding. */
export function quote16(c: Components): { interest: ReturnType<typeof interestF109>; per_diem_cents: Cents; total_cents: Cents; nib_line_cents: Cents; escrow_note: "refunded_separately_20bd" } {
  const i = interestF109(c.upb_cents, c.rate_pct, c.lpi_due, c.good_through, c.method);
  const nib = (c.nib_deferred_cents ?? 0n) + (c.nib_forborne_cents ?? 0n);
  const total = c.upb_cents + i.total_cents + nib + (c.late_charges_cents ?? 0n) + (c.fees_cents ?? 0n) + (c.corporate_advances_cents ?? 0n) + (c.escrow_advance_cents ?? 0n) + (c.recording_fee_cents ?? 0n) + (c.mi_premium_cents ?? 0n) - (c.buydown_credit_cents ?? 0n) - (c.suspense_credit_cents ?? 0n);
  return { interest: i, per_diem_cents: perDiem(c.upb_cents, c.rate_pct), total_cents: total, nib_line_cents: nib, escrow_note: "refunded_separately_20bd" };
}
/** Rule 7 alternative figures over `quote16` (quote.ts `alternativeFigures` uses the per-month rounding): (a) the figure if the scheduled installment/autodraft posts, (b) if it does not. */
export function alternativeFigures16(c: Components, f: { calc_at: PlainDate; installment_due: PlainDate; installment_principal_cents: Cents; autodraft?: boolean }): { applies: boolean; if_installment_posts: { total_cents: Cents; upb_cents: Cents; accrual_start: PlainDate; interest_cents: Cents } | null; if_installment_not_posted: { total_cents: Cents; interest_cents: Cents }; label: string | null; text: string | null } {
  const base = quote16(c);
  const applies = f.installment_due > f.calc_at && f.installment_due <= c.good_through;
  if (!applies) return { applies: false, if_installment_posts: null, if_installment_not_posted: { total_cents: base.total_cents, interest_cents: base.interest.total_cents }, label: null, text: null };
  const posted = quote16({ ...c, upb_cents: c.upb_cents - f.installment_principal_cents, lpi_due: f.installment_due });
  const what = f.autodraft ? "autodraft" : "installment";
  return { applies: true, if_installment_posts: { total_cents: posted.total_cents, upb_cents: c.upb_cents - f.installment_principal_cents, accrual_start: f.installment_due, interest_cents: posted.interest.total_cents }, if_installment_not_posted: { total_cents: base.total_cents, interest_cents: base.interest.total_cents }, label: `${what} due ${f.installment_due} falls before the good-through date`,
    text: `If the ${what} due ${longDate(f.installment_due)} posts as scheduled, the total to pay your loan in full as of ${longDate(c.good_through)} is ${money(posted.total_cents)} (unpaid principal balance ${money(c.upb_cents - f.installment_principal_cents)}, interest from ${longDate(f.installment_due)}); if it does not post, the total is ${money(base.total_cents)} as shown above.` };
}

// ============================================================ rule 4 — rate segments
export interface RateInForce { readonly effective_from: PlainDate; readonly rate_pct: string; readonly source?: "note" | "arm_7_2" | "scra_13_9"; }
export interface InterestSegment { readonly from: PlainDate; readonly to: PlainDate; readonly rate_pct: string; readonly months_full: number; readonly days_partial: number; readonly interest_cents: Cents; }
/**
 * Rule 4: an ARM (7.2) or SCRA (13.9) change effective inside the accrual window splits it; each segment uses its own
 * rate on the same UPB and is rounded once (rule 3). The statement prints every rate in force.
 */
export function segmentedInterest(upb: Cents, accrualStart: PlainDate, payoffOn: PlainDate, rates: readonly RateInForce[], method: Accrual = "monthly_30_360_partial_365"): { segments: readonly InterestSegment[]; total_cents: Cents; rates_printed: readonly string[]; per_diem_after_cents: Cents; split: boolean } {
  if (rates.length === 0) throw new RangeError("at least one rate in force is required");
  const sorted = [...rates].sort((a, b) => (a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : 0));
  const inForce = (on: PlainDate): RateInForce => { let r = sorted[0]!; for (const s of sorted) if (s.effective_from <= on) r = s; return r; };
  const cuts = [accrualStart, ...sorted.map((s) => s.effective_from).filter((d) => d > accrualStart && d < payoffOn), payoffOn];
  const segments: InterestSegment[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const from = cuts[k]!, to = cuts[k + 1]!; const rate = inForce(from).rate_pct; const i = interestF109(upb, rate, from, to, method);
    segments.push({ from, to, rate_pct: rate, months_full: i.months_full, days_partial: i.days_partial, interest_cents: i.total_cents });
  }
  return { segments, total_cents: segments.reduce((s, x) => s + x.interest_cents, 0n), rates_printed: [...new Set(segments.map((s) => `${Number(s.rate_pct).toFixed(3)}%`))], per_diem_after_cents: perDiem(upb, inForce(payoffOn).rate_pct), split: segments.length > 1 };
}

// ============================================================ the payoff_quotes row (T1) — figures, fee waiver, hash
/** 2.7 waiver policy applied to a quote: a waiver reduces unpaid late charges first, then other borrower-payable fees, never below zero; > $100 needs the officer (tool guardrail). */
export function applyFeeWaiver(c: Components, waiverCents: Cents): { components: Components; waived_cents: Cents; waived_late_charges_cents: Cents; waived_fees_cents: Cents } {
  if (waiverCents <= 0n) return { components: c, waived_cents: 0n, waived_late_charges_cents: 0n, waived_fees_cents: 0n };
  const late = c.late_charges_cents ?? 0n; const fees = c.fees_cents ?? 0n;
  const fromLate = waiverCents < late ? waiverCents : late; const fromFees = waiverCents - fromLate < fees ? waiverCents - fromLate : fees;
  return { components: { ...c, late_charges_cents: late - fromLate, fees_cents: fees - fromFees }, waived_cents: fromLate + fromFees, waived_late_charges_cents: fromLate, waived_fees_cents: fromFees };
}

/** `payoff_quotes.hash`: sha256 over the canonical figure set (bigint as decimal strings, keys sorted) — stable across runs on the same ledger snapshot. */
export function quoteHash(figures: Record<string, unknown>): string {
  const canon = (v: unknown): unknown => typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canon(figures))).digest("hex");
}

export const CALC_VERSION = "16.1@quote.v1";
export interface PayoffQuoteFigures {
  readonly upb_cents: Cents; readonly accrual_start: PlainDate; readonly good_through: PlainDate; readonly months_full: number; readonly days_partial: number;
  readonly rate_segments: readonly { from: PlainDate; to: PlainDate; rate_pct: string }[]; readonly interest_full_months_cents: Cents; readonly interest_partial_cents: Cents; readonly interest_cents: Cents; readonly per_diem_cents: Cents;
  readonly nib_deferred_cents: Cents; readonly nib_forborne_cents: Cents; readonly nib_line_cents: Cents; readonly late_charges_cents: Cents; readonly fees_cents: Cents; readonly corporate_advances_cents: Cents; readonly escrow_advance_cents: Cents;
  readonly recording_fee_cents: Cents; readonly mi_premium_cents: Cents; readonly buydown_credit_cents: Cents; readonly suspense_credit_cents: Cents; readonly prepayment_premium_cents: 0n; readonly fees_waived_cents: Cents;
  readonly total_cents: Cents; readonly ledger_snapshot_id: string | null; readonly calc_version: string;
}
/**
 * One immutable `payoff_quotes` row per computed figure (T1): the components from the ledger snapshot, the F-1-09 interest
 * (segmented when a rate change falls inside the window), the displayed per diem, the prepayment premium asserted 0, and a
 * sha256 over the canonical figures that is identical for two runs on the same ledger snapshot and differs for any other.
 */
export function payoffQuoteRow(i: { components: Components; rates?: readonly RateInForce[] | null; ledger_snapshot_id: string | null; fee_waiver_cents?: Cents }): { figures: PayoffQuoteFigures; hash: string; components: Components; segments: ReturnType<typeof segmentedInterest> | null; total_cents: Cents; per_diem_cents: Cents; interest_cents: Cents; waived_cents: Cents } {
  const waived = applyFeeWaiver(i.components, i.fee_waiver_cents ?? 0n); const c = waived.components;
  const base = quote16(c); const rates = i.rates ?? null;
  const seg = rates && rates.length ? segmentedInterest(c.upb_cents, c.lpi_due, c.good_through, rates, c.method ?? "monthly_30_360_partial_365") : null;
  const interestCents = seg ? seg.total_cents : base.interest.total_cents; const total = base.total_cents - base.interest.total_cents + interestCents;
  const figures: PayoffQuoteFigures = {
    upb_cents: c.upb_cents, accrual_start: c.lpi_due, good_through: c.good_through, months_full: base.interest.months_full, days_partial: base.interest.days_partial,
    rate_segments: seg ? seg.segments.map((s) => ({ from: s.from, to: s.to, rate_pct: s.rate_pct })) : [{ from: c.lpi_due, to: c.good_through, rate_pct: c.rate_pct }],
    interest_full_months_cents: base.interest.full_cents, interest_partial_cents: base.interest.partial_cents, interest_cents: interestCents, per_diem_cents: seg ? seg.per_diem_after_cents : base.per_diem_cents,
    nib_deferred_cents: c.nib_deferred_cents ?? 0n, nib_forborne_cents: c.nib_forborne_cents ?? 0n, nib_line_cents: base.nib_line_cents, late_charges_cents: c.late_charges_cents ?? 0n, fees_cents: c.fees_cents ?? 0n, corporate_advances_cents: c.corporate_advances_cents ?? 0n, escrow_advance_cents: c.escrow_advance_cents ?? 0n,
    recording_fee_cents: c.recording_fee_cents ?? 0n, mi_premium_cents: c.mi_premium_cents ?? 0n, buydown_credit_cents: c.buydown_credit_cents ?? 0n, suspense_credit_cents: c.suspense_credit_cents ?? 0n, prepayment_premium_cents: 0n, fees_waived_cents: waived.waived_cents,
    total_cents: total, ledger_snapshot_id: i.ledger_snapshot_id, calc_version: CALC_VERSION,
  };
  return { figures, hash: quoteHash(figures as unknown as Record<string, unknown>), components: c, segments: seg, total_cents: total, per_diem_cents: figures.per_diem_cents, interest_cents: interestCents, waived_cents: waived.waived_cents };
}

// ============================================================ rule 3 — per-diem tolerance and funds reconciliation (T2)
/** Rule 3: the borrower's `per_diem × days` arithmetic is full satisfaction when it differs from the exact recomputation by ≤ $0.01 × days; the difference is absorbed to `payoff_rounding_expense`. */
export function perDiemTolerance(i: { statement_interest_cents: Cents; exact_interest_cents: Cents; per_diem_cents: Cents; extra_days: number }): { per_diem_amount_cents: Cents; exact_extra_cents: Cents; difference_cents: Cents; tolerance_cents: Cents; accepted: boolean; absorbed_to: "payoff_rounding_expense" | null; absorbed_cents: Cents } {
  const perDiemAmount = i.per_diem_cents * BigInt(i.extra_days); const exactExtra = i.exact_interest_cents - i.statement_interest_cents;
  const diff = perDiemAmount - exactExtra; const abs = diff < 0n ? -diff : diff; const tol = 1n * BigInt(i.extra_days);
  const accepted = abs <= tol;
  return { per_diem_amount_cents: perDiemAmount, exact_extra_cents: exactExtra, difference_cents: diff, tolerance_cents: tol, accepted, absorbed_to: accepted && abs > 0n ? "payoff_rounding_expense" : null, absorbed_cents: accepted ? abs : 0n };
}

export type FundsEvent =
  | { type: "payoff.funds.over"; payload: { overage_cents: Cents; refund_by: PlainDate; timer: "SM_OVERPAYMENT_REFUND_10BD" } }
  | { type: "payoff.funds.short"; payload: { shortage_cents: Cents; exact_shortage_cents: Cents; demand_by: PlainDate | null; disposition: ReturnType<typeof shortageDisposition>["disposition"] } }
  | { type: "payoff.funds.matched"; payload: { rounding_expense_cents: Cents } };
/**
 * Example A at funds receipt: the exact figure is recomputed for the actual payoff date (funds deemed received on the
 * F-1-09 due date when they arrive the next business day). Funds on or before good-through: any excess is `payoff.funds.over`
 * (refund within 10 BD, 6.5) and the loan is paid in full that day. Funds after good-through: the statement's per-diem
 * instruction (`per_diem × days`) is what the payer owes — a payer who did not add it is short by that amount
 * (`payoff.funds.short{221.10}` in the spec, exact Δ $221.09; the cent is absorbed to `payoff_rounding_expense` when paid).
 */
export function fundsReceived(i: { components: Components; statement_total_cents: Cents; per_diem_cents: Cents; received_on: PlainDate; amount_received_cents: Cents; state: string; installment_due_on?: PlainDate | null }): {
  payoff_date: PlainDate; deemed_received_on_due_date: boolean; exact_interest: ReturnType<typeof interestF109>; exact_total_cents: Cents; variance_cents: Cents; outcome: "over" | "short" | "exact";
  days_after_good_through: number; per_diem_instruction_cents: Cents; instructed_total_cents: Cents; exact_extra_cents: Cents; tolerance: ReturnType<typeof perDiemTolerance> | null;
  overage_cents: Cents; shortage_cents: Cents; rounding_expense_cents: Cents; paid_in_full_on: PlainDate | null; disposition: ReturnType<typeof shortageDisposition>["disposition"] | "paid_in_full" | "paid_in_full_overage_refund_10bd"; event: FundsEvent;
} {
  const due = i.installment_due_on ?? null; const payoffDate = due ? deemedPayoffDate(i.received_on, due) : i.received_on;
  const exact = quote16({ ...i.components, good_through: payoffDate }); const v = i.amount_received_cents - exact.total_cents;
  const daysAfter = Math.max(0, daysBetween(i.components.good_through, payoffDate));
  const instruction = i.per_diem_cents * BigInt(daysAfter); const instructed = i.statement_total_cents + instruction; const exactExtra = exact.total_cents - i.statement_total_cents;
  const tol = daysAfter > 0 ? perDiemTolerance({ statement_interest_cents: 0n, exact_interest_cents: exactExtra, per_diem_cents: i.per_diem_cents, extra_days: daysAfter }) : null;
  const outcome = v > 0n ? "over" : v < 0n ? "short" : "exact";
  if (daysAfter > 0 && i.amount_received_cents < instructed) {
    // the payer did not follow the per-diem instruction: the shortage demanded is the instruction amount not paid
    const shortage = instructed - i.amount_received_cents; const d = shortageDisposition({ state: i.state, received_on: payoffDate, good_through: i.components.good_through, exact_total_cents: exact.total_cents, amount_received_cents: i.amount_received_cents });
    const demandBy = d.disposition === "short_payoff_demand_1bd" ? addBusinessDays(payoffDate, 5, servicer) : null;
    return { payoff_date: payoffDate, deemed_received_on_due_date: payoffDate !== i.received_on, exact_interest: exact.interest, exact_total_cents: exact.total_cents, variance_cents: v, outcome, days_after_good_through: daysAfter, per_diem_instruction_cents: instruction, instructed_total_cents: instructed, exact_extra_cents: exactExtra, tolerance: tol,
      overage_cents: 0n, shortage_cents: shortage, rounding_expense_cents: tol?.accepted ? tol.absorbed_cents : 0n, paid_in_full_on: null, disposition: d.disposition, event: { type: "payoff.funds.short", payload: { shortage_cents: shortage, exact_shortage_cents: -v, demand_by: demandBy, disposition: d.disposition } } };
  }
  if (daysAfter > 0) {
    // the payer followed the instruction: exact satisfaction within $0.01 × days; the rounding difference is absorbed
    const over = i.amount_received_cents - instructed; const rounding = tol?.accepted ? tol.absorbed_cents : 0n;
    if (over > 0n) return { payoff_date: payoffDate, deemed_received_on_due_date: payoffDate !== i.received_on, exact_interest: exact.interest, exact_total_cents: exact.total_cents, variance_cents: v, outcome, days_after_good_through: daysAfter, per_diem_instruction_cents: instruction, instructed_total_cents: instructed, exact_extra_cents: exactExtra, tolerance: tol, overage_cents: over, shortage_cents: 0n, rounding_expense_cents: rounding, paid_in_full_on: payoffDate, disposition: "paid_in_full_overage_refund_10bd", event: { type: "payoff.funds.over", payload: { overage_cents: over, refund_by: addBusinessDays(payoffDate, 10, servicer), timer: "SM_OVERPAYMENT_REFUND_10BD" } } };
    return { payoff_date: payoffDate, deemed_received_on_due_date: payoffDate !== i.received_on, exact_interest: exact.interest, exact_total_cents: exact.total_cents, variance_cents: v, outcome, days_after_good_through: daysAfter, per_diem_instruction_cents: instruction, instructed_total_cents: instructed, exact_extra_cents: exactExtra, tolerance: tol, overage_cents: 0n, shortage_cents: 0n, rounding_expense_cents: rounding, paid_in_full_on: payoffDate, disposition: "paid_in_full", event: { type: "payoff.funds.matched", payload: { rounding_expense_cents: rounding } } };
  }
  if (v > 0n) return { payoff_date: payoffDate, deemed_received_on_due_date: payoffDate !== i.received_on, exact_interest: exact.interest, exact_total_cents: exact.total_cents, variance_cents: v, outcome, days_after_good_through: 0, per_diem_instruction_cents: 0n, instructed_total_cents: i.statement_total_cents, exact_extra_cents: exactExtra, tolerance: null, overage_cents: v, shortage_cents: 0n, rounding_expense_cents: 0n, paid_in_full_on: payoffDate, disposition: "paid_in_full_overage_refund_10bd", event: { type: "payoff.funds.over", payload: { overage_cents: v, refund_by: addBusinessDays(payoffDate, 10, servicer), timer: "SM_OVERPAYMENT_REFUND_10BD" } } };
  if (v < 0n) { const d = shortageDisposition({ state: i.state, received_on: payoffDate, good_through: i.components.good_through, exact_total_cents: exact.total_cents, amount_received_cents: i.amount_received_cents }); return { payoff_date: payoffDate, deemed_received_on_due_date: payoffDate !== i.received_on, exact_interest: exact.interest, exact_total_cents: exact.total_cents, variance_cents: v, outcome, days_after_good_through: 0, per_diem_instruction_cents: 0n, instructed_total_cents: i.statement_total_cents, exact_extra_cents: exactExtra, tolerance: null, overage_cents: 0n, shortage_cents: -v, rounding_expense_cents: 0n, paid_in_full_on: d.disposition === "short_payoff_demand_1bd" ? null : payoffDate, disposition: d.disposition, event: { type: "payoff.funds.short", payload: { shortage_cents: -v, exact_shortage_cents: -v, demand_by: d.disposition === "short_payoff_demand_1bd" ? addBusinessDays(payoffDate, 5, servicer) : null, disposition: d.disposition } } }; }
  return { payoff_date: payoffDate, deemed_received_on_due_date: payoffDate !== i.received_on, exact_interest: exact.interest, exact_total_cents: exact.total_cents, variance_cents: 0n, outcome, days_after_good_through: 0, per_diem_instruction_cents: 0n, instructed_total_cents: i.statement_total_cents, exact_extra_cents: exactExtra, tolerance: null, overage_cents: 0n, shortage_cents: 0n, rounding_expense_cents: 0n, paid_in_full_on: payoffDate, disposition: "paid_in_full", event: { type: "payoff.funds.matched", payload: { rounding_expense_cents: 0n } } };
}

// ============================================================ rule 6 — escrow paragraph and the 3.5 cut-off
export interface ScheduledDisbursement { readonly kind: "tax" | "hazard" | "flood" | "mi" | "other"; readonly payee: string; readonly amount_cents: Cents; readonly due_on: PlainDate; }
/**
 * Rule 6: the escrow balance is not netted (3.5 default) and is refunded within 20 business days of payoff (§1024.34(b)(1));
 * a disbursement scheduled after the good-through date is not paid by the servicer after payoff (3.5 cut-off) and the
 * borrower is told to pay it.
 */
export function escrowParagraph(i: { escrow_balance_cents: Cents; good_through: PlainDate; scheduled_disbursements: readonly ScheduledDisbursement[]; net_against_shortfall?: boolean; new_loan_credit_elected?: boolean }): { treatment: "refund_separately" | "net_credit" | "new_loan_credit"; refund_cents: Cents; refund_within_business_days: 20; cutoff_on: PlainDate; not_paid_after_cutoff: readonly ScheduledDisbursement[]; borrower_to_pay: readonly ScheduledDisbursement[]; text: string } {
  const treatment = i.new_loan_credit_elected ? "new_loan_credit" : i.net_against_shortfall ? "net_credit" : "refund_separately";
  const late = i.scheduled_disbursements.filter((d) => d.due_on > i.good_through);
  const KIND: Record<ScheduledDisbursement["kind"], string> = { tax: "property tax", hazard: "hazard insurance", flood: "flood insurance", mi: "mortgage insurance", other: "escrow" };
  const head = treatment === "refund_separately" ? `Your escrow balance of ${money(i.escrow_balance_cents)} is not deducted from the payoff and will be refunded within 20 business days after payoff.`
    : treatment === "net_credit" ? `Your escrow balance of ${money(i.escrow_balance_cents)} has been credited against the payoff at your election.` : `Your escrow balance of ${money(i.escrow_balance_cents)} will be credited to your new loan at your election (3.5).`;
  const tail = late.map((d) => `The ${KIND[d.kind]} payment of ${money(d.amount_cents)} due ${longDate(d.due_on)} will not be paid by us after ${longDate(i.good_through)}; you are responsible for paying it directly to ${d.payee}.`);
  return { treatment, refund_cents: treatment === "refund_separately" ? i.escrow_balance_cents : 0n, refund_within_business_days: 20, cutoff_on: i.good_through, not_paid_after_cutoff: late, borrower_to_pay: late, text: [head, ...tail].join(" ") };
}

// ============================================================ timer table — accuracy gate, good-through cap, statutory deadline, third-party clock
/** `SM_PAYOFF_STMT_ACCURACY_GATE`: ledger clean, no pending reversal, rate segments final, firm/BK figures present; force with reason only at deadline − 1 BD (7.6 rule). */
export function accuracyGate(i: { ledger_clean: boolean; pending_reversal: boolean; rate_segments_final: boolean; in_foreclosure: boolean; firm_figures_present: boolean; in_bankruptcy: boolean; bk_figures_present: boolean; force?: { reason: string; today: PlainDate; deadline_on: PlainDate } | null }): { gate: "SM_PAYOFF_STMT_ACCURACY_GATE"; open: boolean; state: "computed" | "gated"; reasons: readonly string[]; forced: boolean; force_allowed_from: PlainDate | null; refusal: string | null } {
  const reasons: string[] = [];
  if (!i.ledger_clean) reasons.push("unposted items on the ledger"); if (i.pending_reversal) reasons.push("a reversal is pending"); if (!i.rate_segments_final) reasons.push("rate segments are not final (7.2 notice outstanding)");
  if (i.in_foreclosure && !i.firm_figures_present) reasons.push("foreclosure firm fees/costs missing (13.6)"); if (i.in_bankruptcy && !i.bk_figures_present) reasons.push("post-petition components missing (14.x)");
  if (reasons.length === 0) return { gate: "SM_PAYOFF_STMT_ACCURACY_GATE", open: true, state: "computed", reasons, forced: false, force_allowed_from: null, refusal: null };
  const f = i.force ?? null; const from = f ? addBusinessDays(f.deadline_on, -1, servicer) : null;
  const allowed = Boolean(f && f.reason && from && f.today >= from);
  return { gate: "SM_PAYOFF_STMT_ACCURACY_GATE", open: allowed, state: allowed ? "computed" : "gated", reasons, forced: allowed, force_allowed_from: from, refusal: allowed ? null : `hold: ${reasons.join("; ")}${f ? ` — force with reason allowed from ${from} (deadline − 1 BD)` : ""}` };
}

/** `SM_PAYOFF_GOOD_THROUGH_MAX_30` (decision 4): good-through ≤ 30 CD, else quote to 30 days with the per-diem instruction; MA validity ≥ issue + 30 CD (§54D).
 * The row says "receipt + 30 CD": read as the last day the statement's interest covers (receipt + 30), so the deemed funds-receipt date
 * `good_through` may be receipt + 31 (example A: received Mon 09/14, good-through Thu 10/15) — recorded in docs/AUDIT-NOTES.md. */
export function goodThroughPolicy(i: { state: string; received_on: PlainDate; issued_on: PlainDate; requested_good_through: PlainDate | null }): { good_through: PlainDate; capped: boolean; cap_on: PlainDate; per_diem_instruction: true; valid_until: PlainDate } {
  // `SM_PAYOFF_GOOD_THROUGH_MAX_30`: the statement covers at most 30 CD after receipt (interest through receipt + 30); funds are
  // deemed received on `good_through`, so the last permitted good-through is receipt + 31 (example A: Mon 09/14 → Thu 10/15).
  const cap = addDays(i.received_on, 30); const maxGt = addDays(cap, 1); const req = i.requested_good_through ?? maxGt; const capped = req > maxGt; const gt = capped ? maxGt : req;
  return { good_through: gt, capped, cap_on: cap, per_diem_instruction: true, valid_until: validUntil(i.state, i.issued_on, gt) };
}

/**
 * `STATE_PAYOFF_STMT_DEADLINE` anchor: the `jurisdiction_rules.payoff` deadline (CA 21 CD, FL 10 CD, NY 30 CD, NC 10 CD, MA 5 BD,
 * TX 7 BD, CT rule) that `payoffRequestIntake` writes into the `payoff.request.received{written}` payload as
 * `statutory_statement_due` (null where no state deadline was located — the state timer is then not armed); the earliest of
 * federal and state drives the 70% warning.
 */
export function statutoryStatementDue(state: string, receivedOn: PlainDate, requestedPayoffOn: PlainDate | null = null): { statutory_statement_due: PlainDate | null; federal_statement_due: PlainDate; governing: "federal" | "state"; governing_due: PlainDate; warning_on: PlainDate; timers: readonly string[]; state_cite: string | null; deadlines: ReturnType<typeof statementDeadlines> } {
  const d = statementDeadlines(state, receivedOn, requestedPayoffOn);
  return { statutory_statement_due: d.state_due, federal_statement_due: d.federal_due, governing: d.governing, governing_due: d.governing_due, warning_on: d.warning_on, timers: d.state_due ? ["REGZ_1026_36C3_PAYOFF_STMT_7BD", "STATE_PAYOFF_STMT_DEADLINE"] : ["REGZ_1026_36C3_PAYOFF_STMT_7BD"], state_cite: d.state_cite, deadlines: d };
}

/** `SM_PAYOFF_THIRD_PARTY_AUTH_1BD` (7.6 `SM_PAYOFF_REQUESTER_VERIFY_1BD`): a third-party request is verified or an authorization request is sent within +1 BD; the borrower of record gets a copy either way. */
export function thirdPartyRequest(i: { received_on: PlainDate; requester: Parameters<typeof requesterAuthorization>[0]; authorization_evidence: boolean }): { third_party: boolean; classification: ReturnType<typeof requesterAuthorization>; timer: "SM_PAYOFF_THIRD_PARTY_AUTH_1BD" | null; due_on: PlainDate | null; action: "verified" | "authorization_request_sent" | null; template: "NTC_PAYOFF_AUTHORIZATION_REQUEST" | null; borrower_of_record_copy: boolean; satisfied_by: string | null } {
  const cls = requesterAuthorization(i.requester, i.authorization_evidence); const third = cls !== "consumer_request";
  if (!third) return { third_party: false, classification: cls, timer: null, due_on: null, action: null, template: null, borrower_of_record_copy: false, satisfied_by: null };
  const action = cls === "authorized_agent" ? "verified" : "authorization_request_sent";
  return { third_party: true, classification: cls, timer: "SM_PAYOFF_THIRD_PARTY_AUTH_1BD", due_on: addBusinessDays(i.received_on, 1, servicer), action, template: action === "authorization_request_sent" ? "NTC_PAYOFF_AUTHORIZATION_REQUEST" : null, borrower_of_record_copy: true, satisfied_by: `payoff.request.third_party.resolved{outcome=${action}}` };
}

// ============================================================ inputs and triggers — the 7.6 intake as 16.1 records it
export const REQUESTER_TYPES = ["borrower", "confirmed_successor", "attorney", "counselor", "lender_or_title", "unknown"] as const;
export type RequesterType = (typeof REQUESTER_TYPES)[number];
/** Channels that produce a *written* request (comment 36(c)(3)-2): e-mail, fax, mail, the portal "Request payoff" flow, the API and the title-company verification portal. */
export const WRITTEN_CHANNELS = ["email", "fax", "mail", "portal", "api", "verification_portal"] as const;
export const QUOTE_MODES = ["oral", "portal", "api", "internal"] as const;
export type QuoteMode = (typeof QUOTE_MODES)[number];
export interface InboundPayoffRequest {
  readonly request_id: string; readonly loan_id: string; readonly channel: string; readonly written: boolean;
  /** ISO instant of receipt (electronic channels) — or `received_on`, the servicer-local business date, when only the date is known. */
  readonly received_at?: string | null; readonly received_on?: PlainDate | null; readonly postmark_on?: PlainDate | null; readonly vendor_receipt_on?: PlainDate | null;
  readonly state: string; readonly requester_type: string; readonly authorization_evidence: boolean;
  readonly requested_good_through: PlainDate | null; readonly requested_payoff_on?: PlainDate | null; readonly borrower_party_ids?: readonly string[]; readonly delivery_channel_requested?: string | null;
}
export interface PayoffRequestReceived {
  readonly type: "payoff.request.received";
  readonly payload: {
    readonly request_id: string; readonly channel: string; readonly written: true; readonly received_at: string; readonly received_on: PlainDate; readonly clock_basis: string;
    readonly state: string; readonly requester_type: RequesterType; readonly requester: "consumer" | "third_party"; readonly requester_classification: ReturnType<typeof requesterAuthorization>; readonly authorization_evidence: boolean;
    readonly requested_good_through: PlainDate | null; readonly good_through: PlainDate; readonly good_through_capped: boolean;
    readonly statutory_statement_due: PlainDate | null; readonly federal_statement_due: PlainDate; readonly governing: "federal" | "state"; readonly governing_due: PlainDate; readonly warning_on: PlainDate; readonly timers: readonly string[];
    readonly third_party_due_on: PlainDate | null; readonly borrower_party_ids: readonly string[];
  };
}
/**
 * The written-request intake (7.6 `payoff.request.received{channel, written}`) as the engine records it before its first run:
 * validates the inbound record (a written channel, a parseable receipt instant, a two-letter state, a known requester type),
 * starts the clock on the 7.6 receipt-date rule (electronic: same day; mail: the scanning vendor's receipt date), computes the
 * federal and `jurisdiction_rules.payoff` deadlines, the 30-day good-through cap and the third-party authorization clock, and
 * returns the `payoff_requests` row plus the event whose payload arms `REGZ_1026_36C3_PAYOFF_STMT_7BD`, `STATE_PAYOFF_STMT_DEADLINE`
 * (`statutory_statement_due`), `SM_PAYOFF_GOOD_THROUGH_MAX_30` and — for a third party — `SM_PAYOFF_THIRD_PARTY_AUTH_1BD`.
 * An oral request is not a written request: it is a `payoff.quote.requested{mode=oral}` (`quoteRequestIntake`).
 */
export function payoffRequestIntake(i: InboundPayoffRequest): { row: Record<string, unknown>; event: PayoffRequestReceived; third_party: ReturnType<typeof thirdPartyRequest> } {
  if (!i.request_id) throw new RangeError("request_id is required"); if (!i.loan_id) throw new RangeError("loan_id is required");
  if (i.written !== true) throw new RangeError(`request ${i.request_id} is not a written request (comment 36(c)(3)-2): an oral request is a payoff.quote.requested{mode=oral}, and the one-click written request starts the clock`);
  if (!(WRITTEN_CHANNELS as readonly string[]).includes(i.channel)) throw new RangeError(`channel ${i.channel || "(none)"} is not a written-request channel (${WRITTEN_CHANNELS.join(", ")})`);
  if (!/^[A-Z]{2}$/.test(i.state)) throw new RangeError(`state ${i.state || "(none)"} must be the property's two-letter state (jurisdiction_rules.payoff)`);
  if (!(REQUESTER_TYPES as readonly string[]).includes(i.requester_type)) throw new RangeError(`requester_type ${i.requester_type || "(none)"} is not one of ${REQUESTER_TYPES.join(", ")}`);
  const receivedAt = i.received_at ?? (i.received_on ? `${i.received_on}T09:00:00-04:00` : null);
  if (!receivedAt || Number.isNaN(Date.parse(receivedAt))) throw new RangeError("received_at (ISO instant) or received_on (date) is required");
  const receivedOn = i.received_on ?? wallClock(Date.parse(receivedAt), "America/New_York").date;
  const clock = payoffClockStart({ channel: i.channel === "mail" ? "mail" : i.channel === "fax" ? "fax" : i.channel === "email" ? "email" : "portal", received_on: receivedOn, postmark_on: i.postmark_on ?? null, vendor_receipt_on: i.vendor_receipt_on ?? null });
  const requester = i.requester_type as RequesterType;
  const tp = thirdPartyRequest({ received_on: clock.clock_start, requester, authorization_evidence: i.authorization_evidence });
  const due = statutoryStatementDue(i.state, clock.clock_start, i.requested_payoff_on ?? i.requested_good_through ?? null);
  const policy = goodThroughPolicy({ state: i.state, received_on: clock.clock_start, issued_on: clock.clock_start, requested_good_through: i.requested_good_through });
  const borrowers = i.borrower_party_ids ?? ["borrower"];
  const payload: PayoffRequestReceived["payload"] = { request_id: i.request_id, channel: i.channel, written: true, received_at: receivedAt, received_on: clock.clock_start, clock_basis: clock.basis,
    state: i.state, requester_type: requester, requester: tp.third_party ? "third_party" : "consumer", requester_classification: tp.classification, authorization_evidence: i.authorization_evidence,
    requested_good_through: i.requested_good_through, good_through: policy.good_through, good_through_capped: policy.capped,
    statutory_statement_due: due.statutory_statement_due, federal_statement_due: due.federal_statement_due, governing: due.governing, governing_due: due.governing_due, warning_on: due.warning_on, timers: tp.third_party ? [...due.timers, "SM_PAYOFF_THIRD_PARTY_AUTH_1BD", "SM_PAYOFF_GOOD_THROUGH_MAX_30"] : [...due.timers, "SM_PAYOFF_GOOD_THROUGH_MAX_30"],
    third_party_due_on: tp.due_on, borrower_party_ids: borrowers };
  const row = { id: i.request_id, loan_id: i.loan_id, received_at: receivedAt, received_on: clock.clock_start, received_channel: i.channel, written: true, requester_type: requester, requester: payload.requester, requester_classification: tp.classification, authorization_evidence: i.authorization_evidence,
    requester_verified: !tp.third_party || tp.action === "verified", requested_good_through: i.requested_good_through, good_through: policy.good_through, requested_payoff_on: i.requested_payoff_on ?? null, delivery_channel_requested: i.delivery_channel_requested ?? null, state: i.state,
    deadline_federal: due.federal_statement_due, deadline_state: due.statutory_statement_due, governing_deadline: due.governing, governing_due: due.governing_due, warning_on: due.warning_on, third_party_due_on: tp.due_on, reasonable_time_reason: "none", reasonable_time_evidence_document_id: null, status: "received", borrower_party_ids: borrowers, quote_id: null };
  return { row, event: { type: "payoff.request.received", payload }, third_party: tp };
}
export interface PayoffQuoteRequested { readonly type: "payoff.quote.requested"; readonly payload: { readonly request_id: string; readonly mode: QuoteMode; readonly channel: string | null; readonly requested_at: string; readonly identity_verified: boolean; readonly clock: "none"; readonly timer: "SM_PAYOFF_ORAL_QUOTE_SAME_SESSION" | "SM_PAYOFF_PORTAL_QUOTE_60S" | null }; }
/** `payoff.quote.requested{mode=oral|portal|api|internal}`: an oral/portal/API/internal quote request (no §1026.36(c)(3) clock); an oral one only after identity verification (rule 11). Arms `SM_PAYOFF_ORAL_QUOTE_SAME_SESSION` / `SM_PAYOFF_PORTAL_QUOTE_60S`. */
export function quoteRequestIntake(i: { request_id: string; mode: string; channel?: string | null; requested_at: string; identity_verified: boolean }): PayoffQuoteRequested {
  if (!i.request_id) throw new RangeError("request_id is required");
  if (!(QUOTE_MODES as readonly string[]).includes(i.mode)) throw new RangeError(`mode ${i.mode || "(none)"} is not one of ${QUOTE_MODES.join(", ")} (a written request is payoff.request.received)`);
  if (Number.isNaN(Date.parse(i.requested_at))) throw new RangeError("requested_at must be an ISO instant");
  if (i.mode === "oral" && !i.identity_verified) throw new RangeError("no oral figure before identity verification (16.1 guardrail; 4.x standards)");
  const mode = i.mode as QuoteMode;
  return { type: "payoff.quote.requested", payload: { request_id: i.request_id, mode, channel: i.channel ?? null, requested_at: i.requested_at, identity_verified: i.identity_verified, clock: "none", timer: mode === "oral" ? "SM_PAYOFF_ORAL_QUOTE_SAME_SESSION" : mode === "portal" ? "SM_PAYOFF_PORTAL_QUOTE_60S" : null } };
}
/** Guardrail (7.6): no statement to an unverified third party without a borrower-of-record copy — a third party is any requester other than the borrower or a confirmed successor. */
export function thirdPartyStatementGuard(i: { requester_type: string | null; requester_verified: boolean; recipients: readonly { party_id: string }[]; borrower_party_ids: readonly string[] }): { third_party: boolean; borrower_of_record_copy: boolean; allowed: boolean; reason: string | null } {
  const third = i.requester_type !== null && i.requester_type !== "" && i.requester_type !== "borrower" && i.requester_type !== "confirmed_successor";
  const copy = i.recipients.some((r) => i.borrower_party_ids.includes(r.party_id));
  const allowed = !third || i.requester_verified || copy;
  return { third_party: third, borrower_of_record_copy: copy, allowed, reason: allowed ? null : `requester ${i.requester_type} is an unverified third party and no borrower of record (${i.borrower_party_ids.join(", ")}) is among the recipients — verify the requester (SM_PAYOFF_THIRD_PARTY_AUTH_1BD) or add the borrower-of-record copy` };
}

/** `SM_PAYOFF_PORTAL_QUOTE_60S`: the portal quote is displayed within 60 seconds of the request, else the fallback message (sev-4). */
export function portalQuoteSla(i: { requested_at_ms: number; displayed_at_ms: number | null }): { timer: "SM_PAYOFF_PORTAL_QUOTE_60S"; within_sla: boolean; elapsed_ms: number | null; fallback_message: string | null; severity: "sev4" | null } {
  const elapsed = i.displayed_at_ms === null ? null : i.displayed_at_ms - i.requested_at_ms; const ok = elapsed !== null && elapsed <= 60_000;
  return { timer: "SM_PAYOFF_PORTAL_QUOTE_60S", within_sla: ok, elapsed_ms: elapsed, fallback_message: ok ? null : "We are preparing your payoff figure and will send it to your portal inbox shortly; you may also call us for a quote now.", severity: ok ? null : "sev4" };
}

// ============================================================ wire vault gate, verification token
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 32 symbols, no 0/O/1/I
export interface MintedToken { readonly token: string; readonly statement_hash: string; readonly wire_instruction_version_id: string; readonly issued_at: string; }
/** The opaque 12-character verification token printed on the statement, bound to the statement hash and the vault version (portal `GET /verify/{token}`). */
export function mintVerificationToken(i: { statement_hash: string; wire_instruction_version_id: string; issued_at: string }): { token: string; binds: { statement_hash: string; wire_instruction_version_id: string; issued_at: string }; verify_path: string } {
  const digest = createHash("sha256").update(`${i.statement_hash}|${i.wire_instruction_version_id}|${i.issued_at}`).digest();
  let token = ""; for (let k = 0; k < 12; k++) token += TOKEN_ALPHABET[digest[k]! % 32];
  return { token, binds: { statement_hash: i.statement_hash, wire_instruction_version_id: i.wire_instruction_version_id, issued_at: i.issued_at }, verify_path: `/verify/${token}` };
}

/**
 * `SM_PAYOFF_WIRE_VERIFY_GATE`: wire instruction version = active vault version and a verification token *minted for this
 * statement hash on that version* (its `mintVerificationToken` record re-derives to the same token); a non-vault source, a
 * stale version or a token nobody minted blocks the render and is a fraud signal to `security-records`.
 */
export function wireVerifyGate(i: { wire_instruction_version_id: string | null; active_vault_version_id: string; verification_token: string | null; source?: "vault" | "inline" | "email" | null; statement_hash?: string | null; minted?: MintedToken | null }): { gate: "SM_PAYOFF_WIRE_VERIFY_GATE"; open: boolean; reason: string | null; alert: { to: "security-records"; kind: "fraud_officer"; severity: "sev1"; signal: "non_vault_wire_instruction" | "stale_wire_instruction_version" | "unminted_verification_token"; never_approved: true } | null } {
  const src = i.source ?? "vault"; const alert = (signal: "non_vault_wire_instruction" | "stale_wire_instruction_version" | "unminted_verification_token") => ({ to: "security-records" as const, kind: "fraud_officer" as const, severity: "sev1" as const, signal, never_approved: true as const });
  if (src !== "vault") return { gate: "SM_PAYOFF_WIRE_VERIFY_GATE", open: false, reason: `wire instructions supplied by ${src}; only the vault's active version may be rendered`, alert: alert("non_vault_wire_instruction") };
  if (!i.wire_instruction_version_id || i.wire_instruction_version_id !== i.active_vault_version_id) return { gate: "SM_PAYOFF_WIRE_VERIFY_GATE", open: false, reason: `wire instruction version ${i.wire_instruction_version_id ?? "(none)"} is not the vault's active version ${i.active_vault_version_id}`, alert: alert("stale_wire_instruction_version") };
  if (!i.verification_token) return { gate: "SM_PAYOFF_WIRE_VERIFY_GATE", open: false, reason: "verification token not minted", alert: null };
  if (i.statement_hash !== undefined || i.minted !== undefined) {
    const m = i.minted ?? null; const expected = m ? mintVerificationToken({ statement_hash: m.statement_hash, wire_instruction_version_id: m.wire_instruction_version_id, issued_at: m.issued_at }).token : null;
    const bound = m !== null && m.token === i.verification_token && expected === i.verification_token && (i.statement_hash == null || m.statement_hash === i.statement_hash) && m.wire_instruction_version_id === i.active_vault_version_id;
    if (!bound) return { gate: "SM_PAYOFF_WIRE_VERIFY_GATE", open: false, reason: `verification token ${i.verification_token} was not minted for statement hash ${i.statement_hash ?? "(unknown)"} on vault version ${i.active_vault_version_id}`, alert: alert("unminted_verification_token") };
  }
  return { gate: "SM_PAYOFF_WIRE_VERIFY_GATE", open: true, reason: null, alert: null };
}

// ============================================================ rule 10 — reliance: FL cutoff, TX form, shortage disposition
/**
 * `FL_701_04_CORRECTED_ESTOPPEL_CUTOFF`: a corrected estoppel letter supersedes the prior one only if *received* by
 * 3 p.m. at least one business day before the payment date; otherwise the prior figure is honored and the servicer absorbs.
 */
export function flCorrectedEstoppel(i: { original: { id: string; total_cents: Cents }; corrected: { id: string; total_cents: Cents; received_on: PlainDate; received_hhmm: string }; payment_on: PlainDate; time_zone?: string }): { gate: "FL_701_04_CORRECTED_ESTOPPEL_CUTOFF"; cutoff_on: PlainDate; cutoff_iso: string; received_iso: string; supersedes: boolean; honored_statement_id: string; reliance_figure_cents: Cents; absorbed_cents: Cents; disposition: "corrected_governs" | "servicer_absorbed"; basis: string } {
  const tz = i.time_zone ?? "America/New_York"; const cutoffOn = addBusinessDays(i.payment_on, -1, servicer);
  const cutoff = zonedEpochMs(cutoffOn, "15:00", tz); const received = zonedEpochMs(i.corrected.received_on, i.corrected.received_hhmm, tz);
  const supersedes = received <= cutoff; const shortfall = i.corrected.total_cents - i.original.total_cents;
  return { gate: "FL_701_04_CORRECTED_ESTOPPEL_CUTOFF", cutoff_on: cutoffOn, cutoff_iso: toIso(cutoff), received_iso: toIso(received), supersedes, honored_statement_id: supersedes ? i.corrected.id : i.original.id, reliance_figure_cents: supersedes ? i.corrected.total_cents : i.original.total_cents, absorbed_cents: supersedes || shortfall <= 0n ? 0n : shortfall, disposition: supersedes ? "corrected_governs" : "servicer_absorbed", basis: "Fla. Stat. §701.04(1): a corrected estoppel letter supersedes all prior estoppel letters only if received by 3 p.m. at least one business day before payment; the mortgagee may not qualify, reserve the right to change, or condition or disclaim the reliance of others" };
}

/** The spec's state-variant codes of `NTC_REGZ_36C3_PAYOFF_STMT` (16.1 outputs): `_CA_2943`, `_FL_701_04`, `_NY_274A`, `_TX_343106`, `_CT_4910A`, `_NC_45367`, `_MA_54D`. */
export const STATE_VARIANT_SUFFIX: Record<string, string> = { CA: "_CA_2943", FL: "_FL_701_04", NY: "_NY_274A", TX: "_TX_343106", CT: "_CT_4910A", NC: "_NC_45367", MA: "_MA_54D" };
/** The FL/TX/CA/NY/NC/MA/CT state-variant text of `NTC_REGZ_36C3_PAYOFF_STMT` (7.6 rule 4 + 16.1 rule 10). FL text carries no reservation or disclaimer. */
export const FL_DISCLAIMER_PATTERN = /(reserve the right|subject to change|disclaim|without prejudice|may not be relied|not binding)/i;
/**
 * `good_through` is the date the figure was computed for (rule 2: as if funds were received on it); `valid_until` is the
 * statement's validity (= good_through, or issue + 30 CD in MA under §54D). MA's "amount certain, as of the payment date
 * specified" is therefore stated as of `good_through`, with the per-diem instruction for any later payment date through `valid_until`.
 */
export function stateVariant(state: string, f: { valid_until: PlainDate; good_through?: PlainDate | null; closing_date?: PlainDate | null; payment_cutoff_hhmm?: string | null; payment_place?: string | null; fee_cents?: Cents }): { variant: string; state_text: string | null; disclaimer_free: boolean; cite: string | null; as_of: PlainDate } {
  const r = STATE_PAYOFF_RULES[state] ?? null; const fee = f.fee_cents ?? 0n; const asOf = f.good_through ?? f.valid_until;
  const text: Record<string, string> = {
    FL: `This estoppel letter is issued under Florida Statutes section 701.04. You may rely on the figures above through ${longDate(f.valid_until)}; interest accrues after that date at the per-day amount shown. A corrected letter, if any, supersedes this letter only if you receive it by 3 p.m. at least one business day before the day you pay. Fee for this statement: ${money(fee)}.`,
    CA: `This statement is furnished under California Civil Code section 2943. You may rely on it through the close of escrow on or before ${longDate(f.valid_until)}. Fee for this statement: ${money(fee)} (not more than $30).`,
    NY: `This statement is furnished under New York Real Property Law section 274-a. The per diem rate for interest accruing after ${longDate(asOf)} is shown above. There is no charge for the first statement; each additional statement is ${money(fee)} (not more than $20).`,
    TX: `Texas Payoff Statement Form (Finance Commission). Proposed closing date: ${longDate(f.closing_date ?? f.valid_until)}. The payoff amount above is valid through that date; on or before that date we will not demand an amount in excess of it (Texas Finance Code section 343.106).`,
    CT: `This statement is furnished under Connecticut General Statutes section 49-10a on or before the date you requested. The first payoff statement in a calendar year is free of charge.`,
    NC: `This statement is furnished under North Carolina General Statutes section 45-36.7. Date prepared: as shown. Payment cutoff time: ${f.payment_cutoff_hhmm ?? "3:00 p.m. Eastern"}. Payments must be made by wire or certified funds to ${f.payment_place ?? "the address shown above"}. Fee for this statement: ${money(fee)}.`,
    MA: `This statement is furnished under Massachusetts General Laws chapter 183, section 54D. The amount above is an amount certain as of ${longDate(asOf)}, the payment date specified; for a later payment date add the per-diem amount shown for each day after ${longDate(asOf)}. This statement is valid for not less than 30 days from issuance, through ${longDate(f.valid_until)}.`,
  };
  const st = text[state] ?? null;
  return { variant: st ? `NTC_REGZ_36C3_PAYOFF_STMT${STATE_VARIANT_SUFFIX[state]}` : "NTC_REGZ_36C3_PAYOFF_STMT", state_text: st, disclaimer_free: !st || !FL_DISCLAIMER_PATTERN.test(st), cite: r?.cite ?? null, as_of: asOf };
}

/**
 * Tex. Fin. Code §343.106: a title-company request on the Finance Commission form states the proposed closing date; the figure
 * is valid through it and no larger amount may be demanded on or before it. Both flags follow `jurisdiction_rules.payoff.reliance_rule`
 * (TX = binding_through_good_through) and apply only to a request on the standard form.
 */
export function txTitleCompanyRequest(i: { received_on: PlainDate; closing_date: PlainDate; on_finance_commission_form: boolean; requester: "title_company" | "other" }): { required_form: string; form_ok: boolean; deadline: ReturnType<typeof statementDeadlines>; valid_through: PlainDate; binding_through_closing: boolean; demand_in_excess_blocked: boolean; reliance_rule: string; cite: string; refusal: string | null } {
  const rule = STATE_PAYOFF_RULES.TX!; const form_ok = i.requester !== "title_company" || i.on_finance_commission_form;
  const binding = rule.reliance_rule === "binding_through_good_through" && form_ok;
  return { required_form: rule.required_form!, form_ok, deadline: statementDeadlines("TX", i.received_on, i.closing_date), valid_through: validUntil("TX", i.received_on, i.closing_date), binding_through_closing: binding, demand_in_excess_blocked: binding, reliance_rule: rule.reliance_rule, cite: rule.cite, refusal: form_ok ? null : "a title-insurance-company request must be on the Finance Commission's standard form (Tex. Fin. Code §343.106)" };
}

/**
 * Rule 10 shortage disposition at funds receipt (16.2 variance tolerance): in FL/TX/CA a figure that was low is absorbed by
 * Supermortgage (`servicer_absorbed`) and never demanded from a party that relied on it through good-through/closing;
 * elsewhere the short-payoff demand path runs.
 */
export function shortageDisposition(i: { state: string; received_on: PlainDate; good_through: PlainDate; exact_total_cents: Cents; amount_received_cents: Cents }): { shortage_cents: Cents; within_good_through: boolean; reliance_state: boolean; disposition: "paid_in_full" | "paid_in_full_tolerance_expense" | "paid_in_full_overage_refund_10bd" | "short_payoff_demand_1bd" | "servicer_absorbed"; demand_blocked: boolean; basis: string } {
  const within = i.received_on <= i.good_through; const reliance = RELIANCE_STATES.has(i.state);
  const v = remitVariance(i.amount_received_cents, i.exact_total_cents, reliance, within);
  const disposition = v.disposition === "reliance_absorbed" ? "servicer_absorbed" : v.disposition;
  const basis = disposition === "servicer_absorbed" ? `${STATE_PAYOFF_RULES[i.state]?.cite ?? i.state}: the figure is binding as to the requester through the good-through/closing date; the shortage is absorbed (16.2 disposition servicer_absorbed)` : disposition === "short_payoff_demand_1bd" ? "no binding-through-date rule applies; 16.2 short-payoff demand within 1 BD" : "within 16.2 tolerance";
  return { shortage_cents: v.variance_cents < 0n ? -v.variance_cents : 0n, within_good_through: within, reliance_state: reliance, disposition, demand_blocked: disposition === "servicer_absorbed", basis };
}

// ============================================================ rule 11 — oral quote
export interface QuoteFiguresForOral { readonly total_cents: Cents; readonly per_diem_cents: Cents; readonly good_through: PlainDate; }
const ORAL_DISCLOSURES = { automation: /automated assistant/i, good_through: /good through (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}, is \$[\d,]+\.\d{2}/, per_diem: /add \$[\d,]+\.\d{2} for each additional day/, escrow_separate: /escrow balance .* refunded separately/i, written_offer: /Would you like the written statement\?/ } as const;
/**
 * Rule 11: the AI voice/chat agent speaks the figure of an existing `payoff_quotes` row (never its own arithmetic) only after
 * identity verification; the transcript states good-through, per diem and the escrow treatment, discloses automation and
 * offers the written statement. The disclosures are read back from the transcript, not asserted. Not binding until written.
 */
export function oralQuote(i: { channel: "ai_voice" | "chat" | "phone"; identity_verified: boolean; state: string; quote: QuoteFiguresForOral; clicked_written_at?: string | null }): { allowed: boolean; refusal: string | null; quote_type: "oral"; total_cents: Cents | null; good_through: PlainDate; per_diem_cents: Cents | null; transcript: readonly string[]; disclosures: { automation: boolean; good_through: boolean; per_diem: boolean; escrow_separate: boolean; written_offer: boolean }; binding: false; written_offer: "one_click_written_request"; timer_started: boolean; event: "payoff.quote.computed{oral}" | null } {
  const offer = oralPayoffRequest({ channel: i.channel, clicked_written_at: i.clicked_written_at ?? null });
  const disclosuresOf = (lines: readonly string[]) => { const t = lines.join(" "); return { automation: ORAL_DISCLOSURES.automation.test(t), good_through: ORAL_DISCLOSURES.good_through.test(t), per_diem: ORAL_DISCLOSURES.per_diem.test(t), escrow_separate: ORAL_DISCLOSURES.escrow_separate.test(t), written_offer: ORAL_DISCLOSURES.written_offer.test(t) }; };
  if (!i.identity_verified) { const transcript = ["This call is handled by an automated assistant.", "Before I can give you a payoff figure I need to verify your identity."]; return { allowed: false, refusal: "no oral figure before identity verification (16.1 guardrail; 4.x standards)", quote_type: "oral", total_cents: null, good_through: i.quote.good_through, per_diem_cents: null, transcript, disclosures: disclosuresOf(transcript), binding: false, written_offer: offer.written_offer, timer_started: false, event: null }; }
  const transcript = [
    "This call is handled by an automated assistant.",
    `Your payoff amount, good through ${longDate(i.quote.good_through)}, is ${money(i.quote.total_cents)}.`,
    `If your funds arrive after ${longDate(i.quote.good_through)}, add ${money(i.quote.per_diem_cents)} for each additional day.`,
    "Your escrow balance is not deducted from this figure and will be refunded separately within 20 business days after payoff.",
    `This spoken figure is not a written payoff statement${i.state === "FL" ? " (in Florida only the written estoppel letter is binding)" : ""}. Would you like the written statement? Say yes or press 1 and we will send it now.`,
  ];
  return { allowed: true, refusal: null, quote_type: "oral", total_cents: i.quote.total_cents, good_through: i.quote.good_through, per_diem_cents: i.quote.per_diem_cents, transcript, disclosures: disclosuresOf(transcript), binding: false, written_offer: offer.written_offer, timer_started: offer.timer_started, event: "payoff.quote.computed{oral}" };
}

// ============================================================ CT — floor and forfeiture
/** C.G.S. §49-10a: deliver on or before the requested date only when it is ≥ 7 BD after receipt; otherwise the 7-BD floor (= the federal clock) governs; a late statement forfeits interest accruing after the request date. */
export function ctStatementDeadline(i: { received_on: PlainDate; requested_payoff_on: PlainDate }): { requested_business_days_ahead: number; statutory_floor_on: PlainDate; deadline_on: PlainDate; governing: "federal" | "state"; federal_due: PlainDate; interest_forfeit_if_late: boolean; timers: readonly ["REGZ_1026_36C3_PAYOFF_STMT_7BD", "STATE_PAYOFF_STMT_DEADLINE"]; cite: string } {
  const d = statementDeadlines("CT", i.received_on, i.requested_payoff_on); let n = 0; let cur = i.received_on; while (cur < i.requested_payoff_on) { cur = addBusinessDays(cur, 1, servicer); n++; }
  return { requested_business_days_ahead: n, statutory_floor_on: addBusinessDays(i.received_on, 7, servicer), deadline_on: d.governing_due, governing: d.governing, federal_due: d.federal_due, interest_forfeit_if_late: d.interest_forfeit_if_late, timers: ["REGZ_1026_36C3_PAYOFF_STMT_7BD", "STATE_PAYOFF_STMT_DEADLINE"], cite: d.state_cite! };
}

/**
 * A breached statement deadline: the governing timer (the earlier of federal and state — federal when the state floor coincides
 * with the 7-BD clock, as in CT) breaches at sev-1 with the state exposure log; every timer whose due date has passed is
 * listed; where `interest_forfeit_if_late` (CT) a `qc_finding` case carries the interest forfeited from the request date.
 */
export function statementDeadlineBreach(i: { state: string; request_on: PlainDate; sent_on: PlainDate | null; today: PlainDate; upb_cents: Cents; rate_pct: string; requested_payoff_on?: PlainDate | null; due_on?: PlainDate | null }): { breached: boolean; severity: "sev1" | null; exposure: string | null; case: { case_type: "qc_finding"; reason: string; interest_forfeited_from: PlainDate; per_diem_cents: Cents } | null; timer: "STATE_PAYOFF_STMT_DEADLINE" | "REGZ_1026_36C3_PAYOFF_STMT_7BD"; governing: "federal" | "state"; due_on: PlainDate; timers_breached: readonly ("STATE_PAYOFF_STMT_DEADLINE" | "REGZ_1026_36C3_PAYOFF_STMT_7BD")[] } {
  const r = STATE_PAYOFF_RULES[i.state] ?? null; const d = statementDeadlines(i.state, i.request_on, i.requested_payoff_on ?? null);
  const due = i.due_on ?? d.governing_due; const asOf = i.sent_on ?? i.today; const breached = asOf > due;
  const timer = d.governing === "state" ? "STATE_PAYOFF_STMT_DEADLINE" : "REGZ_1026_36C3_PAYOFF_STMT_7BD";
  const timersBreached: ("STATE_PAYOFF_STMT_DEADLINE" | "REGZ_1026_36C3_PAYOFF_STMT_7BD")[] = [];
  if (asOf > d.federal_due) timersBreached.push("REGZ_1026_36C3_PAYOFF_STMT_7BD"); if (d.state_due && asOf > d.state_due) timersBreached.push("STATE_PAYOFF_STMT_DEADLINE");
  if (!breached) return { breached: false, severity: null, exposure: null, case: null, timer, governing: d.governing, due_on: due, timers_breached: timersBreached };
  const forfeit = r?.interest_forfeit_if_late ?? false;
  return { breached: true, severity: "sev1", exposure: r?.exposure ?? "§1024.35(b)(6) exposure", case: forfeit ? { case_type: "qc_finding", reason: `${r!.cite}: statement due ${due} sent ${i.sent_on ?? "not yet"} — interest accruing after the request date ${i.request_on} is forfeited`, interest_forfeited_from: i.request_on, per_diem_cents: perDiem(i.upb_cents, i.rate_pct) } : null, timer, governing: d.governing, due_on: due, timers_breached: timersBreached };
}

// ============================================================ A4-2.1-07 — NIB maturity notices and sweep
/**
 * A4-2.1-07: for a loan with a NIB balance, the balance notice goes 180→150 CD before the maturity date *or the projected
 * date of payoff* (whichever comes first); absent contact, a second 75→60 CD before maturity; an unaffordable balloon goes to SF CPM.
 */
export function nibMaturityNotices(i: { maturity_on: PlainDate; nib_cents: Cents; contact_established_on?: PlainDate | null; projected_payoff_on?: PlainDate | null }): { applies: boolean; anchor_on: PlainDate | null; anchor_kind: "maturity" | "projected_payoff" | null; first: { timer: "FNMA_A42107_NIB_MATURITY_NOTICE_180_150"; template: "NTC_FNMA_NIB_BALANCE_NOTICE"; sequence: "first"; anchor_on: PlainDate; window_open: PlainDate; window_close: PlainDate } | null; second: { timer: "FNMA_A42107_NIB_MATURITY_NOTICE_75_60"; template: "NTC_FNMA_NIB_BALANCE_NOTICE"; sequence: "second"; anchor_on: PlainDate; window_open: PlainDate; window_close: PlainDate; required: boolean; reason: string } | null; contact_attempt_required: boolean } {
  if (i.nib_cents <= 0n) return { applies: false, anchor_on: null, anchor_kind: null, first: null, second: null, contact_attempt_required: false };
  const projected = i.projected_payoff_on ?? null; const anchorKind = projected && projected < i.maturity_on ? "projected_payoff" : "maturity"; const anchor = anchorKind === "projected_payoff" ? projected! : i.maturity_on;
  const secondOpen = addDays(i.maturity_on, -75); const contact = i.contact_established_on ?? null; const required = !contact || contact > secondOpen;
  return { applies: true, anchor_on: anchor, anchor_kind: anchorKind, contact_attempt_required: true,
    first: { timer: "FNMA_A42107_NIB_MATURITY_NOTICE_180_150", template: "NTC_FNMA_NIB_BALANCE_NOTICE", sequence: "first", anchor_on: anchor, window_open: addDays(anchor, -180), window_close: addDays(anchor, -150) },
    second: { timer: "FNMA_A42107_NIB_MATURITY_NOTICE_75_60", template: "NTC_FNMA_NIB_BALANCE_NOTICE", sequence: "second", anchor_on: i.maturity_on, window_open: secondOpen, window_close: addDays(i.maturity_on, -60), required, reason: required ? `no contact established by maturity − 75 (${secondOpen})` : `contact established ${contact} — second notice not required` } };
}
/** Payload for `NTC_FNMA_NIB_BALANCE_NOTICE` from the loan terms; `days_before_anchor` (maturity or projected payoff) is what the first-window rule checks, `days_before_maturity` the second. */
export function nibNoticePayload(i: { notice_date: PlainDate; maturity_on: PlainDate; nib_cents: Cents; ib_upb_cents: Cents; sequence: "first" | "second"; nib_description?: string; projected_payoff_on?: PlainDate | null }): { notice_date: PlainDate; maturity_date: PlainDate; projected_payoff_date: PlainDate | null; anchor_date: PlainDate; anchor_kind: "maturity" | "projected_payoff"; anchor_description: string; nib_balance_cents: Cents; ib_upb_cents: Cents; total_due_at_maturity_cents: Cents; days_before_maturity: number; days_before_anchor: number; sequence: "first" | "second"; second_notice: boolean; nib_description: string } {
  const n = nibMaturityNotices({ maturity_on: i.maturity_on, nib_cents: i.nib_cents > 0n ? i.nib_cents : 1n, projected_payoff_on: i.projected_payoff_on ?? null });
  const anchorKind = i.sequence === "second" ? "maturity" : n.anchor_kind!; const anchor = i.sequence === "second" ? i.maturity_on : n.anchor_on!;
  return { notice_date: i.notice_date, maturity_date: i.maturity_on, projected_payoff_date: i.projected_payoff_on ?? null, anchor_date: anchor, anchor_kind: anchorKind, anchor_description: anchorKind === "maturity" ? "your maturity date" : `the projected date of payoff of your loan, ${longDate(anchor)}`, nib_balance_cents: i.nib_cents, ib_upb_cents: i.ib_upb_cents, total_due_at_maturity_cents: i.nib_cents + i.ib_upb_cents, days_before_maturity: daysBetween(i.notice_date, i.maturity_on), days_before_anchor: daysBetween(i.notice_date, anchor), sequence: i.sequence, second_notice: i.sequence === "second", nib_description: i.nib_description ?? "deferred principal from a payment deferral or modification" };
}
export interface NibLoan { readonly loan_id: string; readonly maturity_on: PlainDate; readonly nib_cents: Cents; readonly projected_payoff_on?: PlainDate | null; readonly contact_established_on?: PlainDate | null; }
export interface MaturityApproachingEvent { readonly type: "loan.maturity.approaching"; readonly loan_id: string; readonly payload: { days_before: 180 | 75; nib: true; contact: boolean; maturity_date: PlainDate; projected_payoff_date: PlainDate | null; anchor_date: PlainDate; anchor_kind: "maturity" | "projected_payoff"; nib_cents: Cents; timer: "FNMA_A42107_NIB_MATURITY_NOTICE_180_150" | "FNMA_A42107_NIB_MATURITY_NOTICE_75_60" }; }
/**
 * The nightly A4-2.1-07 maturity-notice sweep (16.1 schedules): on anchor − 180 every NIB loan emits
 * `loan.maturity.approaching{days_before=180, nib=true}` (arms the 180→150 window); on maturity − 75 a loan with no contact
 * established emits `{days_before=75, nib=true, contact=false}` (arms the 75→60 window). Loans without a NIB balance are skipped.
 */
export function nibMaturitySweep(i: { today: PlainDate; loans: readonly NibLoan[] }): readonly MaturityApproachingEvent[] {
  const out: MaturityApproachingEvent[] = [];
  for (const l of i.loans) {
    const n = nibMaturityNotices({ maturity_on: l.maturity_on, nib_cents: l.nib_cents, contact_established_on: l.contact_established_on ?? null, projected_payoff_on: l.projected_payoff_on ?? null });
    if (!n.applies) continue;
    const contact = Boolean(l.contact_established_on);
    if (i.today === n.first!.window_open) out.push({ type: "loan.maturity.approaching", loan_id: l.loan_id, payload: { days_before: 180, nib: true, contact, maturity_date: l.maturity_on, projected_payoff_date: l.projected_payoff_on ?? null, anchor_date: n.first!.anchor_on, anchor_kind: n.anchor_kind!, nib_cents: l.nib_cents, timer: "FNMA_A42107_NIB_MATURITY_NOTICE_180_150" } });
    if (i.today === n.second!.window_open && n.second!.required) out.push({ type: "loan.maturity.approaching", loan_id: l.loan_id, payload: { days_before: 75, nib: true, contact: false, maturity_date: l.maturity_on, projected_payoff_date: l.projected_payoff_on ?? null, anchor_date: l.maturity_on, anchor_kind: "maturity", nib_cents: l.nib_cents, timer: "FNMA_A42107_NIB_MATURITY_NOTICE_75_60" } });
  }
  return out;
}

// ============================================================ recompute chain — updated statement, superseded original
export interface ActiveStatement { readonly id: string; readonly sent_on: PlainDate; readonly good_through: PlainDate; readonly total_cents: Cents; readonly recipients: readonly { party_id: string; channel: string; email?: string; address?: string }[]; }
/**
 * `SM_PAYOFF_STMT_UPDATE_1BD` (comment 36(c)(3)-3): a recalculation trigger on a loan with an active statement (good_through ≥ today)
 * recomputes; a Δ ≠ 0 issues `NTC_PAYOFF_UPDATED_STMT` to every prior recipient within 1 BD with the Δ explained; the original
 * is retained with `superseded_by`.
 */
export function recomputeOnEvent(i: { statement: ActiveStatement; trigger: { event: "payment.posted" | "payment.reversed" | "fee.assessed" | "fee.waived" | "advance.posted" | "escrow.disbursement.posted" | "arm.rate_change.effective" | "lossmit.deferral.completed" | "scra.rate_cap.applied" | "scra.rate_cap.released" | "bankruptcy.case.opened" | "bankruptcy.case.closed"; occurred_on: PlainDate; description: string }; today: PlainDate; new_total_cents: Cents }): { active: boolean; recompute: boolean; event: "payoff.quote.recompute" | null; delta_cents: Cents; timer: "SM_PAYOFF_STMT_UPDATE_1BD" | null; updated: { id: string; template: "NTC_PAYOFF_UPDATED_STMT"; total_cents: Cents; previous_total_cents: Cents; explanation: string; send_to: readonly { party_id: string; channel: string }[]; due_by: PlainDate } | null; original: { id: string; status: "superseded" | "active"; superseded_by: string | null; retained: true } } {
  const active = i.statement.good_through >= i.today;
  if (!active) return { active, recompute: false, event: null, delta_cents: 0n, timer: null, updated: null, original: { id: i.statement.id, status: "active", superseded_by: null, retained: true } };
  const delta = i.new_total_cents - i.statement.total_cents;
  if (delta === 0n) return { active, recompute: true, event: "payoff.quote.recompute", delta_cents: 0n, timer: null, updated: null, original: { id: i.statement.id, status: "active", superseded_by: null, retained: true } };
  const id = `${i.statement.id}-u${daysBetween(i.statement.sent_on, i.trigger.occurred_on)}`;
  return { active, recompute: true, event: "payoff.quote.recompute", delta_cents: delta, timer: "SM_PAYOFF_STMT_UPDATE_1BD",
    updated: { id, template: "NTC_PAYOFF_UPDATED_STMT", total_cents: i.new_total_cents, previous_total_cents: i.statement.total_cents, explanation: `${i.trigger.description} on ${longDate(i.trigger.occurred_on)} (${i.trigger.event}); the total changed by ${money(delta)}`, send_to: i.statement.recipients, due_by: addBusinessDays(i.trigger.occurred_on, 1, servicer) },
    original: { id: i.statement.id, status: "superseded", superseded_by: id, retained: true } };
}

/** "To all prior recipients": every party/channel the original statement was delivered to must be among the updated statement's recipients. */
export function updatedStatementRecipients(i: { prior: readonly { party_id: string; channel: string }[]; proposed: readonly { party_id: string; channel: string }[] }): { all_prior_recipients: boolean; missing: readonly { party_id: string; channel: string }[]; prior_count: number } {
  const key = (r: { party_id: string; channel: string }) => `${r.party_id}|${r.channel}`; const have = new Set(i.proposed.map(key));
  const missing = i.prior.filter((p) => !have.has(key(p)));
  return { all_prior_recipients: i.prior.length > 0 && missing.length === 0, missing, prior_count: i.prior.length };
}

/** Rule 4 second half: a 7.2 rate-change notice received after the statement, effective before good-through, is applied as noticed and the Δ issues an updated statement within 1 BD. */
export function rateChangeAfterStatement(i: { statement: ActiveStatement; components: Components; rates: readonly RateInForce[]; noticed_on: PlainDate; today: PlainDate }): ReturnType<typeof recomputeOnEvent> & { interest: ReturnType<typeof segmentedInterest> } {
  const seg = segmentedInterest(i.components.upb_cents, i.components.lpi_due, i.components.good_through, i.rates, i.components.method ?? "monthly_30_360_partial_365");
  const base = quote16(i.components); const newTotal = base.total_cents - base.interest.total_cents + seg.total_cents;
  const change = [...i.rates].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0]!;
  return { ...recomputeOnEvent({ statement: i.statement, trigger: { event: "arm.rate_change.effective", occurred_on: i.noticed_on, description: `the interest rate changed to ${Number(change.rate_pct).toFixed(3)}% effective ${longDate(change.effective_from)} (7.2 notice)` }, today: i.today, new_total_cents: newTotal }), interest: seg };
}

// ============================================================ the rendered statement — figures only from payoff_quotes
/** Payload keys of `NTC_REGZ_36C3_PAYOFF_STMT` / `NTC_PAYOFF_UPDATED_STMT` that are figures or engine facts: the agent may never supply them inline — they come from the `payoff_quotes` / `payoff_statements` rows (guardrail). */
export const FIGURE_KEYS = ["total_cents", "upb_cents", "interest_cents", "per_diem_cents", "days", "nib_cents", "late_charges_cents", "fees_advances_cents", "recording_fee_cents", "credits_cents", "escrow_balance_cents", "mi_proration_cents", "good_through", "paid_through", "rate_pct", "previous_total_cents", "calc_source", "business_days_after_request", "alternative_text", "state_text", "verification_token", "statement_date", "state", "reasonable_time_reason", "reasonable_time_evidence_document_id", "change_date", "original_statement_date", "reason"] as const;
export interface QuoteRowFigures { readonly upb_cents: Cents; readonly accrual_start: PlainDate; readonly good_through: PlainDate; readonly interest_cents: Cents; readonly per_diem_cents: Cents; readonly nib_line_cents: Cents; readonly late_charges_cents: Cents; readonly fees_cents: Cents; readonly corporate_advances_cents: Cents; readonly escrow_advance_cents: Cents; readonly recording_fee_cents: Cents; readonly mi_premium_cents: Cents; readonly buydown_credit_cents: Cents; readonly suspense_credit_cents: Cents; readonly total_cents: Cents; readonly rate_segments: readonly { from: PlainDate; to: PlainDate; rate_pct: string }[]; readonly alt_figures?: ReturnType<typeof alternativeFigures16> | null; }
export interface StatementRowFacts { readonly state: string; readonly state_text: string | null; readonly escrow_balance_cents: Cents; readonly escrow_paragraph: string; readonly hsa_note: string | null; readonly verification_token: string | null; readonly verify_path: string | null; readonly rendered_on: PlainDate; readonly valid_until: PlainDate; }
export interface RequestRowFacts { readonly received_on: PlainDate; readonly reasonable_time_reason: string; readonly reasonable_time_evidence_document_id: string | null; }
/** The 16.1 additions to the 7.6 required-content checklist, rendered into the statement's free-text block: verification token + portal, the wire-fraud warning with the portal clause, the HSA language (rule 8), the buydown credit (C-1.2-03), every rate in force (rule 4). */
export function statementAdditions(i: { verification_token: string | null; verify_path: string | null; hsa_note: string | null; buydown_credit_cents: Cents; rates_printed: readonly string[] }): string {
  const parts: string[] = [];
  if (i.verification_token) parts.push(`Verification token ${i.verification_token}: confirm this statement and our wire instructions at the verification portal (payoff-verify${i.verify_path ?? ""}) or by calling the number on this statement. We will never change wire instructions by e-mail; verify at the portal or by calling the number on your statement before sending funds.`);
  if (i.buydown_credit_cents > 0n) parts.push(`Remaining interest rate buydown funds of ${money(i.buydown_credit_cents)} are credited against the payoff amount (they are not subtracted from the loan balance).`);
  if (i.rates_printed.length > 1) parts.push(`Interest was computed at the rates in force during the accrual period: ${i.rates_printed.join(" and ")}.`);
  if (i.hsa_note) parts.push(i.hsa_note);
  return parts.join(" ");
}
/**
 * The `NTC_REGZ_36C3_PAYOFF_STMT` payload from the rows: every figure from the `payoff_quotes` row the statement was rendered
 * from, the escrow/state/HSA/token facts from the `payoff_statements` row, the request facts from `payoff_requests`, and only
 * display fields (names, loan number, property, wire display, contact block) from the caller — never a figure (`FIGURE_KEYS`).
 */
export function statementPayload(i: { quote: QuoteRowFigures; statement: StatementRowFacts; request: RequestRowFacts | null; sent_on: PlainDate; display: Record<string, unknown> }): Record<string, unknown> {
  for (const k of FIGURE_KEYS) if (i.display[k] !== undefined) throw new RangeError(`payload.${k} is a figure: figures come only from payoff_quotes (16.1 guardrail)`);
  const q = i.quote; const days = daysBetween(q.accrual_start, q.good_through); const lastRate = q.rate_segments[q.rate_segments.length - 1]?.rate_pct ?? "0";
  const rates = [...new Set(q.rate_segments.map((s) => `${Number(s.rate_pct).toFixed(3)}%`))];
  const additions = statementAdditions({ verification_token: i.statement.verification_token, verify_path: i.statement.verify_path, hsa_note: i.statement.hsa_note, buydown_credit_cents: q.buydown_credit_cents, rates_printed: rates });
  const stateText = [i.statement.state_text, additions].filter((t) => t && t.length).join(" ");
  return { ...i.display,
    good_through: q.good_through, statement_date: i.sent_on, total_cents: q.total_cents, upb_cents: q.upb_cents, paid_through: addDays(q.accrual_start, -1), rate_pct: lastRate, days, per_diem_cents: q.per_diem_cents, interest_cents: q.interest_cents,
    nib_cents: q.nib_line_cents, late_charges_cents: q.late_charges_cents, fees_advances_cents: q.fees_cents + q.corporate_advances_cents + q.escrow_advance_cents, recording_fee_cents: q.recording_fee_cents, credits_cents: q.buydown_credit_cents + q.suspense_credit_cents,
    escrow_balance_cents: i.statement.escrow_balance_cents, mi_proration_cents: q.mi_premium_cents > 0n ? q.mi_premium_cents : null, alternative_text: q.alt_figures?.applies ? q.alt_figures.text : null,
    state: i.statement.state, state_text: stateText || null, verification_token: i.statement.verification_token, valid_until: i.statement.valid_until, escrow_paragraph: i.statement.escrow_paragraph,
    business_days_after_request: i.request ? businessDaysAfterRequest(i.request.received_on, i.sent_on) : 0, reasonable_time_reason: i.request?.reasonable_time_reason ?? "none", reasonable_time_evidence_document_id: i.request?.reasonable_time_evidence_document_id ?? null, calc_source: "16.1" };
}
/** The `NTC_PAYOFF_UPDATED_STMT` payload: the updated quote's figures, the original statement's date, the explained Δ. */
export function updatedStatementPayload(i: { updated_quote: { good_through: PlainDate; total_cents: Cents; per_diem_cents: Cents }; previous_total_cents: Cents; original_sent_on: PlainDate; change_date: PlainDate; explanation: string; display: Record<string, unknown> }): Record<string, unknown> {
  for (const k of FIGURE_KEYS) if (i.display[k] !== undefined) throw new RangeError(`payload.${k} is a figure: figures come only from payoff_quotes (16.1 guardrail)`);
  return { ...i.display, original_statement_date: i.original_sent_on, reason: i.explanation, change_date: i.change_date, good_through: i.updated_quote.good_through, total_cents: i.updated_quote.total_cents, previous_total_cents: i.previous_total_cents, per_diem_cents: i.updated_quote.per_diem_cents, calc_source: "16.1" };
}
/** The recompute (T15): the original quote's components with the post-event ledger facts applied — the calculator runs on these; no total is ever supplied. */
export function recomputedComponents(original: Components, changes: Partial<Components>): Components {
  const out: Record<string, unknown> = { ...original };
  for (const [k, v] of Object.entries(changes)) if (v !== undefined) out[k] = v;
  return out as unknown as Components;
}
