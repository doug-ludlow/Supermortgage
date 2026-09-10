/**
 * §13.5 Allowable timeframes / compensatory fees (E-3.2-15, A1-4.2-02, F-2-03)
 * over the Foreclosure Time Frames and Compensatory Fee Allowable Delays
 * exhibit dated 06.18.25 (effective for sales on/after July 1, 2025; verified
 * 2026-09-09 — spec 13.5). The exhibit figures are code, the delay credits are
 * rule-driven with per-category caps and scopes, and exposure is
 * UPB × PTR ÷ 365 × excess days rounded half-up once.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, plainDate, daysBetween } from "../../kernel/calendar/date.ts";

export type Method = "judicial" | "non_judicial";
export interface AllowableRow { readonly days: number; readonly method: Method; readonly nyc_days?: number }
/** `jurisdiction_rules.foreclosure.allowable_days` shape: one exhibit version, effective by sale date. */
export interface ExhibitVersion { readonly exhibit_version: string; readonly effective_sales_on_or_after: PlainDate; readonly allowable_days: Readonly<Record<string, AllowableRow>> }

/** Exhibit 06.18.25 — maximum allowable days by preferred method, exactly as quoted in spec 13.5. Jurisdictions the spec does not quote are loaded from the published exhibit at build; they are never defaulted. */
export const EXHIBIT_2025_06_18: ExhibitVersion = {
  exhibit_version: "2025-06-18", effective_sales_on_or_after: plainDate("2025-07-01"),
  allowable_days: {
    CA: { days: 600, method: "non_judicial" }, TX: { days: 480, method: "non_judicial" }, FL: { days: 720, method: "judicial" }, NY: { days: 1740, method: "judicial", nyc_days: 2190 },
    NJ: { days: 810, method: "judicial" }, IL: { days: 720, method: "judicial" }, PA: { days: 780, method: "judicial" }, MA: { days: 810, method: "judicial" }, GA: { days: 480, method: "non_judicial" },
    AZ: { days: 450, method: "non_judicial" }, CO: { days: 540, method: "non_judicial" }, OH: { days: 690, method: "judicial" }, WA: { days: 630, method: "non_judicial" }, MI: { days: 390, method: "non_judicial" },
    NV: { days: 750, method: "non_judicial" }, MD: { days: 780, method: "non_judicial" }, CT: { days: 780, method: "judicial" }, NC: { days: 690, method: "non_judicial" }, VA: { days: 450, method: "non_judicial" }, MN: { days: 420, method: "non_judicial" },
  },
};
export const EXHIBITS: readonly ExhibitVersion[] = [EXHIBIT_2025_06_18];
/** Rule 8: the five boroughs carry the NYC figure (2,190); the rest of New York 1,740. */
export const NYC_COUNTIES = new Set(["Bronx", "Kings", "New York", "Queens", "Richmond"]);

/** Rule "sale date on or after": the exhibit version in force on the sale date (latest version when no sale is scheduled yet). */
export function exhibitFor(saleOn?: PlainDate | null, exhibits: readonly ExhibitVersion[] = EXHIBITS): ExhibitVersion {
  const rows = exhibits.filter((e) => !saleOn || e.effective_sales_on_or_after <= saleOn).sort((a, b) => (a.effective_sales_on_or_after < b.effective_sales_on_or_after ? 1 : -1));
  if (!rows.length) throw new RangeError(`no allowable-timeframe exhibit is loaded for a sale on ${saleOn} (the prior exhibit version must be retained for sales before ${exhibits[0]?.effective_sales_on_or_after ?? "?"})`);
  return rows[0]!;
}
export function allowable(state: string, county?: string | null, saleOn?: PlainDate | null, exhibits: readonly ExhibitVersion[] = EXHIBITS): { days: number; method: Method; exhibit_version: string; nyc: boolean } {
  const ex = exhibitFor(saleOn, exhibits); const st = state.toUpperCase(); const row = ex.allowable_days[st];
  if (!row) throw new RangeError(`${st} is not in the loaded allowable-timeframe exhibit ${ex.exhibit_version} — load jurisdiction_rules.foreclosure.allowable_days before computing exposure (E-3.2-15); days are never defaulted`);
  const nyc = st === "NY" && !!county && NYC_COUNTIES.has(county);
  return { days: nyc && row.nyc_days ? row.nyc_days : row.days, method: row.method, exhibit_version: ex.exhibit_version, nyc };
}
export function allowableDays(state: string, county?: string | null, saleOn?: PlainDate | null): number { return allowable(state, county, saleOn).days; }

// ---- delay credits (comp_fee_delay_rules, exhibit 06.18.25) ----------------------------------------------
export type DelayCategory = "bk7" | "bk11" | "bk12" | "bk13" | "probate" | "military_indulgence" | "contested" | "workout_review_pre2012" | "tpp" | "nj_2010_2012" | "covid_moratorium" | "forbearance" | "forbearance_covid" | "legislative_judicial" | "other_reasonable";
export type CapScope = "per_filing" | "first_occurrence" | "per_workout" | "total";
export interface DelayRule { readonly cap_days: number | null; readonly cap_scope: CapScope; readonly status_codes: readonly string[]; readonly note?: string }
export const DELAY_RULES: Readonly<Record<DelayCategory, DelayRule>> = {
  bk7: { cap_days: 80, cap_scope: "per_filing", status_codes: ["3L", "65"] },
  bk11: { cap_days: 125, cap_scope: "per_filing", status_codes: ["66"] },
  bk12: { cap_days: 125, cap_scope: "per_filing", status_codes: ["59"] },
  bk13: { cap_days: 125, cap_scope: "per_filing", status_codes: ["67", "69"] },
  probate: { cap_days: 120, cap_scope: "first_occurrence", status_codes: ["31"] },
  military_indulgence: { cap_days: 455, cap_scope: "first_occurrence", status_codes: ["32"] },
  contested: { cap_days: 90, cap_scope: "first_occurrence", status_codes: ["33"] },
  workout_review_pre2012: { cap_days: 60, cap_scope: "per_workout", status_codes: ["H5"], note: "workout in review earns credit only for LPI before 06/01/12 — \"No credit will be given\" otherwise" },
  tpp: { cap_days: 120, cap_scope: "per_workout", status_codes: ["BF"] },
  nj_2010_2012: { cap_days: 180, cap_scope: "total", status_codes: ["43"] },
  covid_moratorium: { cap_days: 670, cap_scope: "total", status_codes: [] },
  forbearance: { cap_days: 360, cap_scope: "total", status_codes: ["09"] },
  forbearance_covid: { cap_days: 540, cap_scope: "total", status_codes: ["09"] },
  legislative_judicial: { cap_days: null, cap_scope: "total", status_codes: [], note: "no listed day credit in the exhibit — \"legislative/judicial changes\" is a reasonable-explanation avenue" },
  other_reasonable: { cap_days: null, cap_scope: "total", status_codes: [], note: "officer-added for the rebuttal file only; never affects Fannie Mae's calculation" },
};
export const DELAY_CATEGORIES = Object.keys(DELAY_RULES) as readonly DelayCategory[];
export const isDelayCategory = (s: unknown): s is DelayCategory => typeof s === "string" && Object.hasOwn(DELAY_RULES, s);
const WORKOUT_REVIEW_LPI_CUTOFF = plainDate("2012-06-01");
const COVID_MORATORIUM = { from: plainDate("2020-03-01"), to: plainDate("2021-12-31") };

export interface Delay { readonly category: DelayCategory; readonly from: PlainDate; readonly to: PlainDate; readonly reported_timely: boolean; readonly status_code_reported?: string; readonly id?: string }
export interface CreditRow { readonly category: DelayCategory; readonly from: PlainDate; readonly to: PlainDate; readonly actual: number; readonly cap: number | null; readonly scope: CapScope; readonly credited: number; readonly at_risk: boolean; readonly at_risk_days: number; readonly note: string | null }

/** Rule 2: credited days per category = min(actual, cap) subject to scope (per filing / first occurrence / per workout / total) and to `reported_timely`; an untimely code earns nothing and is flagged "credit at risk" with the days it would have earned. */
export function creditDelays(delays: readonly Delay[], ctx: { lpi_due?: PlainDate | null } = {}): { credited_days: number; at_risk_days: number; credits: CreditRow[]; notes: string[] } {
  const sorted = [...delays].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const seen = new Map<DelayCategory, number>(); const totals = new Map<DelayCategory, number>();
  const credits: CreditRow[] = []; const notes: string[] = []; let credited = 0; let atRisk = 0;
  for (const d of sorted) {
    if (!isDelayCategory(d.category)) throw new RangeError(`${String(d.category)} is not a comp_fee_delay_rules category (BE title and BG mediation carry no listed credit; disaster holds carry no listed credit)`);
    const rule = DELAY_RULES[d.category]; const n = (seen.get(d.category) ?? 0) + 1; seen.set(d.category, n);
    let from = d.from, to = d.to;
    if (d.category === "covid_moratorium") { from = from < COVID_MORATORIUM.from ? COVID_MORATORIUM.from : from; to = to > COVID_MORATORIUM.to ? COVID_MORATORIUM.to : to; }
    const actual = Math.max(0, daysBetween(from, to));
    let eligible = 0; let note: string | null = null;
    if (rule.cap_days === null) { note = `${d.category} ${d.from}..${d.to}: ${rule.note ?? "no listed credit"} — document a reasonable explanation (E-3.2-15)`; }
    else if (d.category === "workout_review_pre2012" && (!ctx.lpi_due || ctx.lpi_due >= WORKOUT_REVIEW_LPI_CUTOFF)) { note = `workout in review ${d.from}..${d.to}: no credit will be given for an LPI on/after 06/01/12 (exhibit 06.18.25)`; }
    else if (rule.cap_scope === "first_occurrence" && n > 1) { note = `second ${d.category} period ${d.from}..${d.to}: no additional credit — document a reasonable explanation (A1-4.2-02)`; }
    else if (rule.cap_scope === "total") { const used = totals.get(d.category) ?? 0; eligible = Math.max(0, Math.min(actual, rule.cap_days - used)); totals.set(d.category, used + eligible); if (eligible < actual) note = `${d.category} ${d.from}..${d.to}: capped at ${rule.cap_days} days in total`; }
    else { eligible = Math.min(actual, rule.cap_days); if (eligible < actual) note = `${d.category} ${d.from}..${d.to}: ${actual} actual days capped at ${rule.cap_days} (${rule.cap_scope.replace("_", " ")})`; }
    const timely = d.reported_timely === true;
    const row: CreditRow = { category: d.category, from: d.from, to: d.to, actual, cap: rule.cap_days, scope: rule.cap_scope, credited: timely ? eligible : 0, at_risk: !timely && eligible > 0, at_risk_days: timely ? 0 : eligible, note: !timely && eligible > 0 ? `${d.category} ${d.from}..${d.to}: credit at risk — status code ${rule.status_codes.join("/") || "n/a"} not accepted as timely (F-1-21); file a correction and document` : note };
    credits.push(row); credited += row.credited; atRisk += row.at_risk_days; if (row.note) notes.push(row.note);
  }
  return { credited_days: credited, at_risk_days: atRisk, credits, notes };
}
/** One delay scored on its own (no scope interaction). */
export function creditedDays(d: Delay, ctx: { lpi_due?: PlainDate | null } = {}): { actual: number; credited: number; at_risk: boolean; at_risk_days: number } { const r = creditDelays([d], ctx).credits[0]!; return { actual: r.actual, credited: r.credited, at_risk: r.at_risk, at_risk_days: r.at_risk_days }; }

// ---- exposure (A1-4.2-02, F-2-03) ----------------------------------------------------------------------
export type TrackingStatus = "tracking" | "at_risk_70pct" | "over_allowable" | "closed_within" | "closed_over" | "closed_other";
/** Rule 3: exposure = round_half_up(UPB × PTR ÷ 365 × excess, cents); a single rounding. */
export function exposureCents(upbCents: Cents, ptrPct: string, excessDays: number): Cents { return divRound(upbCents * Decimal.parse(ptrPct).unscaled * BigInt(excessDays), 100n * 365n * Decimal.ONE.unscaled, "HALF_UP"); }
export interface Exposure { readonly actual_days: number; readonly allowable_days: number; readonly credited_days: number; readonly at_risk_days: number; readonly excess_days: number; readonly exposure_cents: Cents; readonly excess_days_if_at_risk_credited: number; readonly exposure_if_at_risk_credited_cents: Cents; readonly credits: readonly CreditRow[]; readonly notes: readonly string[]; readonly status: TrackingStatus }
/** Rules 1–3: actual days = sale − LPI due (no +1); excess = max(0, actual − allowable − Σ credited). At-risk credits are excluded from `exposure_cents` (Fannie Mae relies on the reported status data) and shown the other way in `exposure_if_at_risk_credited_cents`. */
export function exposure(f: { lpi_due: PlainDate; sale_on: PlainDate; allowable: number; delays: readonly Delay[]; upb_cents: Cents; ptr_pct: string }): Exposure {
  const actual = daysBetween(f.lpi_due, f.sale_on);
  const c = creditDelays(f.delays, { lpi_due: f.lpi_due });
  const excess = Math.max(0, actual - f.allowable - c.credited_days);
  const excessOptimistic = Math.max(0, actual - f.allowable - c.credited_days - c.at_risk_days);
  return { actual_days: actual, allowable_days: f.allowable, credited_days: c.credited_days, at_risk_days: c.at_risk_days, excess_days: excess, exposure_cents: exposureCents(f.upb_cents, f.ptr_pct, excess), excess_days_if_at_risk_credited: excessOptimistic, exposure_if_at_risk_credited_cents: exposureCents(f.upb_cents, f.ptr_pct, excessOptimistic), credits: c.credits, notes: c.notes, status: excess > 0 ? "closed_over" : "closed_within" };
}
/** Rule 5: an open case's exposure projected on a provisional sale date (today or the firm's forecast). */
export function projectedExposure(f: { lpi_due: PlainDate; as_of: PlainDate; allowable: number; delays: readonly Delay[]; upb_cents: Cents; ptr_pct: string }): Exposure & { provisional_sale_on: PlainDate } {
  const e = exposure({ lpi_due: f.lpi_due, sale_on: f.as_of, allowable: f.allowable, delays: f.delays, upb_cents: f.upb_cents, ptr_pct: f.ptr_pct });
  return { ...e, status: trackingStatus(e.actual_days, f.allowable, e.credited_days), provisional_sale_on: f.as_of };
}
export function atRisk(elapsed: number, allowable: number, credited: number): boolean { return elapsed >= 0.7 * (allowable + credited); }
export function trackingStatus(elapsed: number, allowable: number, credited: number): "tracking" | "at_risk_70pct" | "over_allowable" { return elapsed > allowable + credited ? "over_allowable" : atRisk(elapsed, allowable, credited) ? "at_risk_70pct" : "tracking"; }
/** A1-4.2-02: $1,000 for internal administrative costs on a servicer-error rescission, plus third-party costs. */
export const RESCISSION_EXPOSURE_CENTS = 100_000n;
