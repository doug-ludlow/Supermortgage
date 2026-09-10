/** §13.5 Allowable timeframes / compensatory fees (A1-4.2-02, F-2-03). */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, daysBetween } from "../../kernel/calendar/date.ts";

export const ALLOWABLE_DAYS: Record<string, number> = { NJ: 810, NY: 1740, NYC: 2190, FL: 900, IL: 810, TX: 240, CA: 300, GA: 240, OH: 720, PA: 660, DEFAULT: 540 };   // [exhibit values UNVERIFIED — loaded from the Fannie Mae exhibit at runtime]
export const NYC_COUNTIES = new Set(["Bronx", "Kings", "New York", "Queens", "Richmond"]);
export function allowableDays(state: string, county?: string): number { if (state === "NY" && county && NYC_COUNTIES.has(county)) return ALLOWABLE_DAYS.NYC!; return ALLOWABLE_DAYS[state] ?? ALLOWABLE_DAYS.DEFAULT!; }
export const DELAY_CAPS: Record<string, number> = { bankruptcy: 125, contested: 90, scra: 455, mediation: 90, probate: 60, disaster: 90 };
export interface Delay { readonly category: keyof typeof DELAY_CAPS | string; readonly from: PlainDate; readonly to: PlainDate; readonly reported_timely: boolean; }
export function creditedDays(d: Delay): { actual: number; credited: number; at_risk: boolean } { const actual = daysBetween(d.from, d.to); const cap = DELAY_CAPS[d.category] ?? 0; return { actual, credited: d.reported_timely ? Math.min(actual, cap) : 0, at_risk: !d.reported_timely }; }
export function exposure(f: { lpi_due: PlainDate; sale_on: PlainDate; allowable: number; delays: readonly Delay[]; upb_cents: Cents; ptr_pct: string }): { actual_days: number; credited_days: number; excess_days: number; exposure_cents: Cents; status: "closed_within" | "closed_over" } {
  const actual = daysBetween(f.lpi_due, f.sale_on);
  const credited = f.delays.reduce((s, d) => s + creditedDays(d).credited, 0);
  const excess = Math.max(0, actual - f.allowable - credited);
  const exp = divRound(f.upb_cents * Decimal.parse(f.ptr_pct).unscaled * BigInt(excess), 100n * 365n * Decimal.ONE.unscaled, "HALF_UP");
  return { actual_days: actual, credited_days: credited, excess_days: excess, exposure_cents: exp, status: excess > 0 ? "closed_over" : "closed_within" };
}
export function atRisk(elapsed: number, allowable: number, credited: number): boolean { return elapsed >= 0.7 * (allowable + credited); }
export const RESCISSION_EXPOSURE_CENTS = 100_000n;
