/** §3.9 State interest-on-escrow — rate resolution, accrual, 1099-INT threshold. State parameters flagged where the spec marks them unverified. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, parts, ymd, endOfMonth } from "../../kernel/calendar/date.ts";

export interface LoanFacts {
  readonly state: string; readonly origination_date: PlainDate; readonly origination_ltv_pct?: string; readonly pmi_active?: boolean; readonly escrow_imposed_for_default?: boolean; readonly tax_annual_cents?: Cents; readonly total_annual_cents?: Cents;
  /** RI: the exemption ends when the loan is no longer PMI-insured (3.9 edge case, recomputed on `pmi.terminated`); accrual starts the day after. */
  readonly pmi_terminated_on?: PlainDate | null;
}
export type Exempt = "ltv_gt_80" | "pmi_active" | "escrow_imposed_for_default" | "origination_band_none" | "not_applicable_state";

export const STATES = new Set(["NY", "CT", "MN", "WI", "MA", "RI", "VT", "UT", "ME", "OR", "NH", "MD", "CA", "IA"]);
/**
 * Wisconsin §138.052(5) origination-date bands (3.9 state table, verified 2026-09-09): originated 2/1/1983–12/31/1993 → ≥ 5.25%;
 * 1/1/1994–4/17/2018 → DFI variable rate (0.17% for 2026); on/after 4/18/2018 → no statutory interest. Originations before
 * 2/1/1983 fall outside every band the table lists and are treated as no-band [UNVERIFIED — pre-1983 originations].
 */
export const WI_BANDS = { fixed_from: "1983-02-01" as PlainDate, variable_from: "1994-01-01" as PlainDate, none_from: "2018-04-18" as PlainDate } as const;
export type WiBand = "fixed_5_25" | "dfi_variable" | "none";
export function wiBand(originationDate: PlainDate): WiBand {
  if (originationDate < WI_BANDS.fixed_from || originationDate >= WI_BANDS.none_from) return "none";
  return originationDate < WI_BANDS.variable_from ? "fixed_5_25" : "dfi_variable";
}
export function exemption(f: LoanFacts): Exempt | null {
  if (!STATES.has(f.state)) return "not_applicable_state";
  if (f.state === "MN" && f.origination_ltv_pct && Decimal.parse(f.origination_ltv_pct).cmp(Decimal.parse("80")) > 0) return "ltv_gt_80";
  if (f.state === "RI" && f.pmi_active) return "pmi_active";
  if (f.state === "VT" && f.escrow_imposed_for_default) return "escrow_imposed_for_default";
  if (f.state === "WI" && wiBand(f.origination_date) === "none") return "origination_band_none";
  return null;
}
/** Eligibility on a given day: the RI PMI exemption holds through the termination date and ends the next day (3.9 edge case). */
export function exemptionOn(f: LoanFacts, asOf: PlainDate): Exempt | null {
  if (f.state === "RI" && f.pmi_active && f.pmi_terminated_on && asOf > f.pmi_terminated_on) return exemption({ ...f, pmi_active: false });
  return exemption(f);
}
/** `pmi.terminated` (Section 10) → recompute: exempt through the termination date; accrual starts the next day when nothing else exempts the loan. */
export function pmiTerminationRecompute(f: LoanFacts, terminatedOn: PlainDate): { exempt_through: PlainDate; accrual_starts_on: PlainDate; exemption_after: Exempt | null } {
  const g: LoanFacts = { ...f, pmi_active: true, pmi_terminated_on: terminatedOn };
  return { exempt_through: terminatedOn, accrual_starts_on: addDays(terminatedOn, 1), exemption_after: exemptionOn(g, addDays(terminatedOn, 1)) };
}
/** Daily accrual over a balance series, skipping the days the loan is exempt (negative balances accrue nothing — rule 3). */
export function accrueEligibleDays(f: LoanFacts, days: readonly { on: PlainDate; balance_cents: Cents }[], ratePct: string): { accrued_cents: Cents; days_accrued: number; first_accrual_on: PlainDate | null } {
  const eligible = days.filter((d) => exemptionOn(f, d.on) === null);
  return { accrued_cents: eligible.reduce((s, d) => s + accrue(d.balance_cents, ratePct, 1), 0n), days_accrued: eligible.length, first_accrual_on: eligible[0]?.on ?? null };
}
/** The floor the rate in effect may never fall below (3.9 guardrails: "the agent cannot lower a statutory minimum"): NY 2%, MN 3%, CT 1.5% (after rounding), WI 5.25% for the fixed band; policy-rate and no-band states have no statutory floor. */
export function statutoryMinimumPct(f: LoanFacts): string {
  switch (f.state) { case "NY": return "2"; case "MN": return "3"; case "CT": return "1.5"; case "WI": return wiBand(f.origination_date) === "fixed_5_25" ? "5.25" : "0"; default: return "0"; }
}
/** 3.9 rule 4 / timer table crediting calendar per state. */
export type CreditFrequency = "quarterly_end" | "quarterly_first_day" | "annual_dec31" | "annual_computation_year" | "annual_or_termination";
export function creditFrequency(state: string): CreditFrequency {
  switch (state) { case "NY": case "ME": case "OR": case "NH": return "quarterly_end"; case "VT": return "quarterly_first_day"; case "MA": return "annual_computation_year"; case "CA": return "annual_or_termination"; default: return "annual_dec31"; }
}
/** The crediting date for the period containing `asOf` (NY/ME/OR/NH quarter end; VT first day of the next quarter; CT/UT/RI/MN/MD/WI Dec 31; CA/MA computation-year end). */
export function nextCreditingDate(state: string, asOf: PlainDate, computationYearEnd?: PlainDate): PlainDate {
  const { y, m } = parts(asOf); const quarterEnd = endOfMonth(ymd(y, Math.ceil(m / 3) * 3, 1));
  switch (creditFrequency(state)) {
    case "quarterly_end": return quarterEnd;
    case "quarterly_first_day": return addDays(quarterEnd, 1);
    case "annual_dec31": return ymd(y, 12, 31);
    default: return computationYearEnd ?? ymd(y, 12, 31);
  }
}
/** Rate in percent for the accrual period. */
export function resolveRate(f: LoanFacts, obs: { index_pct?: string; published_pct?: string; policy_rate_pct?: string } = {}): string {
  switch (f.state) {
    case "NY": return "2";
    case "CT": { const idx = obs.index_pct ? Decimal.parse(obs.index_pct) : Decimal.ZERO; const rounded = Decimal.fromUnscaled(divRound(idx.unscaled, 10n ** 29n, "HALF_UP") * 10n ** 29n); return rounded.cmp(Decimal.parse("1.5")) < 0 ? "1.5" : rounded.toString(); }   // nearest 0.1%, floor 1.5%
    case "MN": return "3";
    case "WI": { const band = wiBand(f.origination_date); return band === "none" ? "0" : band === "fixed_5_25" ? "5.25" : (obs.published_pct ?? "0.17"); }   // §138.052(5) bands; DFI 2026 notice 0.17%
    case "MA": case "VT": case "RI": return obs.policy_rate_pct ?? "0.25";
    default: return obs.published_pct ?? obs.policy_rate_pct ?? "0";
  }
}
/** average_daily / daily: balance × rate × days / 365 (negative balances accrue nothing). */
export function accrue(avgDailyBalanceCents: Cents, ratePct: string, days: number): Cents {
  if (avgDailyBalanceCents <= 0n) return 0n;
  return divRound(avgDailyBalanceCents * Decimal.parse(ratePct).unscaled * BigInt(days), 100n * 365n * Decimal.ONE.unscaled, "HALF_UP");
}
/** MN: mean of first-of-month balances × 3% annually. */
export function accrueMn(firstOfMonthBalances: readonly Cents[]): Cents { const avg = firstOfMonthBalances.reduce((a, b) => a + b, 0n) / BigInt(firstOfMonthBalances.length); return divRound(avg * 3n, 100n, "HALF_UP"); }
/** MA: only the tax share of the balance accrues. */
export function maTaxShare(balance: Cents, f: LoanFacts): Cents { return f.tax_annual_cents && f.total_annual_cents ? divRound(balance * f.tax_annual_cents, f.total_annual_cents, "HALF_UP") : balance; }
export const FORM_1099_INT_THRESHOLD_CENTS = 1_000n;
export function needs1099Int(totalYearCents: Cents): boolean { return totalYearCents >= FORM_1099_INT_THRESHOLD_CENTS; }
