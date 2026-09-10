/** §3.9 State interest-on-escrow — rate resolution, accrual, 1099-INT threshold. State parameters flagged where the spec marks them unverified. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";

export interface LoanFacts { readonly state: string; readonly origination_date: PlainDate; readonly origination_ltv_pct?: string; readonly pmi_active?: boolean; readonly escrow_imposed_for_default?: boolean; readonly tax_annual_cents?: Cents; readonly total_annual_cents?: Cents; }
export type Exempt = "ltv_gt_80" | "pmi_active" | "escrow_imposed_for_default" | "origination_band_none" | "not_applicable_state";

export const STATES = new Set(["NY", "CT", "MN", "WI", "MA", "RI", "VT", "UT", "ME", "OR", "NH", "MD", "CA", "IA"]);
export function exemption(f: LoanFacts): Exempt | null {
  if (!STATES.has(f.state)) return "not_applicable_state";
  if (f.state === "MN" && f.origination_ltv_pct && Decimal.parse(f.origination_ltv_pct).cmp(Decimal.parse("80")) > 0) return "ltv_gt_80";
  if (f.state === "RI" && f.pmi_active) return "pmi_active";
  if (f.state === "VT" && f.escrow_imposed_for_default) return "escrow_imposed_for_default";
  if (f.state === "WI" && f.origination_date >= "2019-01-01") return "origination_band_none";
  return null;
}
/** Rate in percent for the accrual period. */
export function resolveRate(f: LoanFacts, obs: { index_pct?: string; published_pct?: string; policy_rate_pct?: string } = {}): string {
  switch (f.state) {
    case "NY": return "2";
    case "CT": { const idx = obs.index_pct ? Decimal.parse(obs.index_pct) : Decimal.ZERO; const rounded = Decimal.fromUnscaled(divRound(idx.unscaled, 10n ** 29n, "HALF_UP") * 10n ** 29n); return rounded.cmp(Decimal.parse("1.5")) < 0 ? "1.5" : rounded.toString(); }   // nearest 0.1%, floor 1.5%
    case "MN": return "3";
    case "WI": return f.origination_date < "1994-01-01" ? "5.25" : (obs.published_pct ?? "0.17");   // [UNVERIFIED bands]
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
