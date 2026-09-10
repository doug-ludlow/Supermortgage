/**
 * §3.1/3.2/3.4 Escrow analysis — Reg X §1024.17 Appendix E aggregate
 * method: line projection, base payment, trial running balance, zeroing,
 * cushion (policy/instrument/state minimum, floor, 1/6 cap), target vs
 * projected actual, the (f) decision matrix, installment arithmetic and
 * the new payment. All cents.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addMonths, addDays, parts } from "../../kernel/calendar/date.ts";

export interface ProjectedItem { readonly line_type: string; readonly amount_cents: Cents; readonly disburse_on: PlainDate; readonly cycle_years?: number; readonly available_on?: PlainDate; readonly penalty_on?: PlainDate; readonly terminates_on?: PlainDate | null; }
export interface CushionInputs { readonly policy_months?: number; readonly instrument_months?: number | null; readonly instrument_dollars_cents?: Cents | null; readonly state_max_months?: number | null; }

const periodIndex = (start: PlainDate, d: PlainDate, periods: number): number => {
  if (periods === 12) { const a = parts(start), b = parts(d); return (b.y - a.y) * 12 + (b.m - a.m); }
  return Math.floor((Date.parse(d) - Date.parse(start)) / (14 * 86_400_000));
};

export interface Projection { readonly periods: number; readonly annual_cents: Cents; readonly annual_for_cushion_cents: Cents; readonly base_payment_cents: Cents; readonly step1: Cents[]; readonly required_start_cents: Cents; readonly cushion_cents: Cents; readonly cushion_source: "policy" | "instrument" | "state"; readonly targets: Cents[]; readonly target_at_start_cents: Cents; readonly cap_cents: Cents; readonly cap_ok: boolean; readonly items: ProjectedItem[]; readonly preaccrual_ok: boolean; readonly multi_year_low_point_flag: boolean; }

/** Effective cushion per 3.4 rules 1–2. */
export function cushion(annualForCushion: Cents, c: CushionInputs): { cents: Cents; months: number; source: Projection["cushion_source"]; cap_cents: Cents } {
  const cap = annualForCushion / 6n;
  if (c.instrument_dollars_cents != null) { const v = c.instrument_dollars_cents < cap ? c.instrument_dollars_cents : cap; return { cents: v, months: 0, source: "instrument", cap_cents: cap }; }
  const cands: [number, Projection["cushion_source"]][] = [[c.policy_months ?? 2, "policy"]];
  if (c.instrument_months != null) cands.push([c.instrument_months, "instrument"]);
  if (c.state_max_months != null) cands.push([c.state_max_months, "state"]);
  const [months, source] = cands.reduce((a, b) => (b[0] < a[0] ? b : a));
  const raw = (annualForCushion * BigInt(Math.round(months * 100))) / 1200n;   // floor
  return { cents: raw < cap ? raw : cap, months, source, cap_cents: cap };
}

/** Build the Appendix E projection for a computation year starting `yearStart` (12 monthly periods or 26 biweekly). */
export function project(items: readonly ProjectedItem[], yearStart: PlainDate, c: CushionInputs = {}, opts: { biweekly?: boolean } = {}): Projection {
  const periods = opts.biweekly ? 26 : 12;
  const yearEnd = opts.biweekly ? addDays(yearStart, 364) : addMonths(yearStart, 12);
  // Multi-year items contribute amount/(12N) per month; MI stops after terminates_on.
  const inYear = items.filter((i) => i.disburse_on >= yearStart && i.disburse_on < yearEnd && !(i.terminates_on && i.disburse_on >= i.terminates_on));
  const single = inYear.filter((i) => !i.cycle_years || i.cycle_years === 1);
  const multi = items.filter((i) => i.cycle_years && i.cycle_years > 1);
  const annual = single.reduce((s, i) => s + i.amount_cents, 0n) + multi.reduce((s, i) => s + i.amount_cents / BigInt(i.cycle_years!), 0n);
  const annualForCushion = annual;
  const base = divRound(annual, BigInt(periods), "HALF_UP");
  const disb = new Array<Cents>(periods).fill(0n);
  for (const i of single) { const k = periodIndex(yearStart, i.disburse_on, periods); if (k >= 0 && k < periods) disb[k] = disb[k]! + i.amount_cents; }
  let lowPointNotReached = false;
  for (const i of multi) { if (i.disburse_on >= yearStart && i.disburse_on < yearEnd) { const k = periodIndex(yearStart, i.disburse_on, periods); disb[k] = disb[k]! + i.amount_cents; } else lowPointNotReached = true; }
  const step1: Cents[] = []; let bal = 0n;
  for (let p = 0; p < periods; p++) { bal += base; bal -= disb[p]!; step1.push(bal); }
  const min = step1.reduce((a, b) => (b < a ? b : a), 0n);
  const required = min < 0n ? -min : 0n;
  const cu = cushion(annualForCushion, c);
  const targets = step1.map((b) => b + required + cu.cents);
  const targetMin = targets.reduce((a, b) => (b < a ? b : a));
  const preaccrual = inYear.every((i) => (!i.available_on || i.disburse_on >= i.available_on) && (!i.penalty_on || i.disburse_on <= i.penalty_on));
  return { periods, annual_cents: annual, annual_for_cushion_cents: annualForCushion, base_payment_cents: base, step1, required_start_cents: required, cushion_cents: cu.cents, cushion_source: cu.source, targets, target_at_start_cents: required + cu.cents, cap_cents: cu.cap_cents, cap_ok: targetMin <= cu.cap_cents, items: [...inYear], preaccrual_ok: preaccrual, multi_year_low_point_flag: lowPointNotReached };
}

export type Decision =
  | { kind: "refund"; surplus_cents: Cents; due_on: PlainDate }
  | { kind: "credit"; surplus_cents: Cents; credit_monthly_cents: Cents; first_month_extra_cents: Cents }
  | { kind: "retain"; surplus_cents: Cents }
  | { kind: "shortage"; shortage_cents: Cents; deficiency_cents: Cents; months: number; installment_cents: Cents; final_installment_cents: Cents; deficiency_installment_cents: Cents; deficiency_final_cents: Cents; lump_sum_option_offered: boolean }
  | { kind: "balanced" };

export interface AnalysisInputs { readonly projection: Projection; readonly projected_actual_cents: Cents; readonly as_of: PlainDate; readonly regx_days_delinquent: number; readonly workout?: boolean; readonly instrument_shortage_max_months?: number | null; readonly borrower_election_months?: number | null; readonly deficiency_installments?: number; }

/** 3.2 R6–R9 decision matrix with platform defaults. */
export function decide(i: AnalysisInputs): Decision {
  const target = i.projection.target_at_start_cents; const pa = i.projected_actual_cents; const current = i.regx_days_delinquent <= 30;
  const oneMonth = i.projection.base_payment_cents;
  if (pa >= target) {
    const surplus = pa - target; if (surplus === 0n) return { kind: "balanced" };
    if (!current) return { kind: "retain", surplus_cents: surplus };
    if (surplus >= 5_000n) return { kind: "refund", surplus_cents: surplus, due_on: addDays(i.as_of, 30) };
    const monthly = surplus / 12n; return { kind: "credit", surplus_cents: surplus, credit_monthly_cents: monthly, first_month_extra_cents: surplus - monthly * 12n };
  }
  const deficiency = pa < 0n ? -pa : 0n; const shortage = pa < 0n ? target : target - pa;
  let months = i.workout ? 60 : 12;
  if (i.workout && i.borrower_election_months != null) months = Math.max(12, i.borrower_election_months);
  if (!i.workout && i.instrument_shortage_max_months != null) months = Math.min(months, i.instrument_shortage_max_months);
  const inst = divRound(shortage, BigInt(months), "HALF_UP"); const final = shortage - inst * BigInt(months - 1);
  const dm = i.deficiency_installments ?? 12; const dinst = deficiency > 0n ? divRound(deficiency, BigInt(dm), "HALF_UP") : 0n; const dfinal = deficiency > 0n ? deficiency - dinst * BigInt(dm - 1) : 0n;
  return { kind: "shortage", shortage_cents: shortage, deficiency_cents: deficiency, months, installment_cents: inst, final_installment_cents: final, deficiency_installment_cents: dinst, deficiency_final_cents: dfinal, lump_sum_option_offered: current && shortage < oneMonth && !i.workout };
}

/** 3.2 R9 new payment (first month, and the final-month variant). */
export function newPayment(p: Projection, d: Decision): { payment_cents: Cents; final_month_cents: Cents; first_month_cents: Cents } {
  const b = p.base_payment_cents;
  if (d.kind === "shortage") return { payment_cents: b + d.installment_cents + d.deficiency_installment_cents, final_month_cents: b + d.final_installment_cents + d.deficiency_final_cents, first_month_cents: b + d.installment_cents + d.deficiency_installment_cents };
  if (d.kind === "credit") return { payment_cents: b - d.credit_monthly_cents, final_month_cents: b - d.credit_monthly_cents, first_month_cents: b - d.credit_monthly_cents - d.first_month_extra_cents };
  return { payment_cents: b, final_month_cents: b, first_month_cents: b };
}
export function effectiveDate(yearStart: PlainDate, statementSentOn: PlainDate, dueDay = 1): PlainDate {
  let d = yearStart; const min = addDays(statementSentOn, 30);
  while (d < min) d = addMonths(d, 1);
  return d;
}
/** 3.2 R10 anomaly review triggers. */
export function anomalies(oldPayment: Cents, newPay: Cents, d: Decision, flags: { missing_penalty_date?: boolean; pmi_without_termination?: boolean; bill_variance_gt_20?: boolean } = {}): string[] {
  const out: string[] = []; const delta = newPay - oldPayment; const abs = delta < 0n ? -delta : delta;
  if (oldPayment > 0n && abs * 100n > oldPayment * 25n) out.push("payment_change_gt_25pct"); if (abs > 15_000n) out.push("payment_change_gt_150");
  if (d.kind === "refund" && d.surplus_cents > 250_000n) out.push("surplus_gt_2500");
  if (flags.missing_penalty_date) out.push("missing_penalty_date"); if (flags.pmi_without_termination) out.push("pmi_without_termination"); if (flags.bill_variance_gt_20) out.push("bill_variance_gt_20pct");
  return out;
}
/** 3.1 rule 3 settlement deposit ceiling = required start + cushion. */
export function settlementDepositCeiling(p: Projection): Cents { return p.target_at_start_cents; }
