/**
 * §3.1/3.2/3.4 Escrow analysis — Reg X §1024.17 Appendix E aggregate
 * method: line projection, base payment, trial running balance, zeroing,
 * cushion (policy/instrument/state minimum, floor, 1/6 cap), target vs
 * projected actual, the (f) decision matrix, installment arithmetic and
 * the new payment. All cents.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
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
  if (!i.workout && i.instrument_shortage_max_months != null) months = Math.max(12, Math.min(months, i.instrument_shortage_max_months));   // (c)(8): an instrument cap below Reg X's 12-month floor ((f)(3)) does not control
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

// ---- R1 line projection (§1024.17(c)(7); 3.2 R1) -------------------------------------------------------------------
export type EstimateBasis = "known_bill" | "prior_year" | "prior_year_cpi" | "comparable" | "quote" | "contract";
export interface EscrowLineInput {
  readonly line_type: string;
  readonly frequency: "annual" | "semiannual" | "quarterly" | "monthly" | "triennial" | "biennial";
  readonly estimate_basis: EstimateBasis;
  /** Prior computation-year charge (used for prior_year / prior_year_cpi). */
  readonly prior_year_annual_cents: Cents;
  /** Date the prior-year estimate was last confirmed by a bill (R10: older than 2 years → anomaly). */
  readonly prior_year_confirmed_on?: PlainDate | null;
  /** Next-cycle bills the payee/vendor has issued (3.7 escrow_bills), if any. */
  readonly known_bills?: readonly { amount_cents: Cents; due_on: PlainDate; penalty_on?: PlainDate | null; discount?: { by: PlainDate; amount_cents: Cents } | null; available_on?: PlainDate | null }[];
  /** Comparable property's assessment for new construction (basis "comparable"). */
  readonly comparable_annual_cents?: Cents | null;
  /** Contractual premium for MI (basis "contract"). */
  readonly contract_annual_cents?: Cents | null;
  readonly cycle_years?: number;
  readonly terminates_on?: PlainDate | null;
  /** Prior-year disbursement anniversaries used when no bill is known (month/day of last year's payments). */
  readonly prior_disbursed_on: readonly PlainDate[];
}
export interface LineProjectionOptions { readonly cpi_change_pct?: string; readonly cpi_line_types?: readonly string[]; readonly capture_discount?: boolean; readonly as_of?: PlainDate; }
export const CPI_DEFAULT_LINE_TYPES = ["tax_county", "tax_city", "tax_school", "tax_special", "tax_supplemental", "tax_personal_property_mh"] as const;   // 3.2 decision 5: on for taxes, off for insurance
const PERIODS: Record<EscrowLineInput["frequency"], number> = { annual: 1, semiannual: 2, quarterly: 4, monthly: 12, triennial: 1, biennial: 1 };

/** Rule R1 amount: known bill → prior year (× CPI only where enabled for the line type) → comparable (new construction) → contract (MI); multi-year items carry the full-cycle premium. */
export function lineAnnualEstimate(l: EscrowLineInput, o: LineProjectionOptions = {}): { annual_cents: Cents; basis_used: EstimateBasis; anomalies: string[] } {
  const anomalies: string[] = [];
  if (l.known_bills && l.known_bills.length) return { annual_cents: l.known_bills.reduce((s, b) => s + b.amount_cents, 0n), basis_used: "known_bill", anomalies };
  if (l.estimate_basis === "contract" && l.contract_annual_cents !== undefined && l.contract_annual_cents !== null) return { annual_cents: l.contract_annual_cents, basis_used: "contract", anomalies };
  if (l.estimate_basis === "comparable" && l.comparable_annual_cents !== undefined && l.comparable_annual_cents !== null) return { annual_cents: l.comparable_annual_cents, basis_used: "comparable", anomalies };
  const cpiEnabled = (o.cpi_line_types ?? CPI_DEFAULT_LINE_TYPES).includes(l.line_type);
  if (l.estimate_basis === "prior_year_cpi" && cpiEnabled && o.cpi_change_pct) {
    const factor = Decimal.parse("100").add(Decimal.parse(o.cpi_change_pct));
    return { annual_cents: divRound(l.prior_year_annual_cents * factor.unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP"), basis_used: "prior_year_cpi", anomalies };
  }
  if (l.prior_year_confirmed_on && o.as_of && l.prior_year_confirmed_on < addMonths(o.as_of, -24)) anomalies.push("estimate_basis_prior_year_gt_2y");   // R10: prior-year basis older than 2 years
  return { annual_cents: l.prior_year_annual_cents, basis_used: "prior_year", anomalies };
}

/** Rule R1 disbursement date: the 3.7 scheduled pay date — the discount deadline when captured, else the penalty-avoidance date, never before bill availability; estimates fall on the prior year's anniversaries in the projection year. */
export function lineDisbursementDates(l: EscrowLineInput, yearStart: PlainDate, o: LineProjectionOptions = {}): { on: PlainDate; amount_cents: Cents; available_on?: PlainDate; penalty_on?: PlainDate }[] {
  const yearEnd = addMonths(yearStart, 12);
  if (l.known_bills && l.known_bills.length) {
    return l.known_bills.map((b) => {
      let on = b.penalty_on ?? b.due_on; if (o.capture_discount !== false && b.discount && b.discount.by < on) on = b.discount.by;
      if (b.available_on && on < b.available_on) on = b.available_on;
      return { on, amount_cents: b.amount_cents, ...(b.available_on ? { available_on: b.available_on } : {}), ...(b.penalty_on ? { penalty_on: b.penalty_on } : {}) };
    });
  }
  const est = lineAnnualEstimate(l, o).annual_cents; const n = Math.max(1, PERIODS[l.frequency]); const per = divRound(est, BigInt(n), "HALF_UP");
  const anniversaries = l.prior_disbursed_on.map((d) => { const p = parts(d); let x = addMonths(d, 12); while (x < yearStart) x = addMonths(x, 12); while (x >= yearEnd) x = addMonths(x, -12); void p; return x; }).sort();
  const dates = anniversaries.length ? anniversaries : [yearStart];
  return dates.slice(0, n).map((on, k) => ({ on, amount_cents: k === n - 1 ? est - per * BigInt(n - 1) : per }));
}

/** R1 end to end: escrow lines → the ProjectedItem list `project()` consumes, with the basis used and R10 anomalies per line. */
export function projectLines(lines: readonly EscrowLineInput[], yearStart: PlainDate, o: LineProjectionOptions = {}): { items: ProjectedItem[]; bases: { line_type: string; basis_used: EstimateBasis; annual_cents: Cents }[]; anomalies: string[] } {
  const items: ProjectedItem[] = []; const bases: { line_type: string; basis_used: EstimateBasis; annual_cents: Cents }[] = []; const anomalies: string[] = [];
  for (const l of lines) {
    const est = lineAnnualEstimate(l, { ...o, as_of: o.as_of ?? yearStart }); bases.push({ line_type: l.line_type, basis_used: est.basis_used, annual_cents: est.annual_cents }); anomalies.push(...est.anomalies.map((a) => `${l.line_type}:${a}`));
    if (l.line_type === "mi_borrower_paid" && !l.terminates_on) anomalies.push(`${l.line_type}:pmi_without_termination`);
    for (const d of lineDisbursementDates(l, yearStart, o)) {
      if (l.terminates_on && d.on >= l.terminates_on) continue;   // MI: no installments after the §10 termination date
      items.push({ line_type: l.line_type, amount_cents: d.amount_cents, disburse_on: d.on, ...(l.cycle_years && l.cycle_years > 1 ? { cycle_years: l.cycle_years } : {}), ...(d.available_on ? { available_on: d.available_on } : {}), ...(d.penalty_on ? { penalty_on: d.penalty_on } : {}), ...(l.terminates_on !== undefined ? { terminates_on: l.terminates_on ?? null } : {}) });
    }
  }
  return { items, bases, anomalies };
}
