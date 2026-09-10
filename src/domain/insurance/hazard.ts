/**
 * 9.1 Hazard insurance tracking — requirement derivation, the LL-2026-03
 * adequacy test, renewal shortcut and evidence acceptance.
 */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";

export type CoverageBasis = "replacement_cost" | "extended_rc" | "guaranteed_rc" | "acv" | "unknown";
export type CoverageForm = "special" | "named_perils";
export type ProjectType = "detached" | "condo" | "coop" | "attached_pud";

export interface CarrierRating { readonly agency: "am_best" | "demotech" | "sp" | "kroll"; readonly grade: string; }

export interface HazardPolicy {
  readonly coverage_dwelling_cents: Cents;
  readonly coverage_basis: CoverageBasis;
  readonly roof_basis?: CoverageBasis;                    // roof may be ACV
  readonly coverage_form: CoverageForm;
  readonly perils_present?: readonly string[];            // named-perils form: all eight required
  readonly deductible_cents: Cents;
  readonly per_peril_deductibles: readonly { readonly peril: string; readonly cents?: Cents; readonly pct?: string }[];
  readonly ratings: readonly CarrierRating[];
  readonly rating_exception?: "state_plan" | "cut_through" | "mortgage_impairment" | null;
  readonly mortgagee_clause: { readonly names_partner_isaoa: boolean; readonly co_servicer: boolean; readonly names_mers: boolean };
  readonly named_insureds: readonly string[];
  readonly excludes_wind: boolean;
  readonly unit_owner?: boolean;                          // HO-6 style unit policy
}

export const REQUIRED_PERILS: readonly string[] = ["fire", "lightning", "explosion", "windstorm", "hail", "smoke", "aircraft", "vehicles"];
export const MAX_DEDUCTIBLE_PCT = Decimal.parse("0.05");
export const UNIT_DEDUCTIBLE_FLOOR: Cents = 250_000n;    // $2,500 for unit-owner policies
export const MASTER_PER_UNIT_DEDUCTIBLE_MAX: Cents = 5_000_000n;

export type Deficiency =
  | "coverage_basis" | "coverage_form" | "deductible_excess" | "carrier_rating" | "mortgagee_clause" | "named_insured"
  | "coverage_decrease_unconfirmed" | "wind_gap" | "master_lapse" | "unit_policy_missing";

/** `deductible_pct = deductible ÷ coverage`, compared without rounding (rule 2). */
export function deductiblePct(deductible: Cents, coverage: Cents): Decimal { return Decimal.ratio(deductible, coverage); }

function ratingOk(r: CarrierRating): boolean {
  const g = r.grade.toUpperCase().replace(/\s/g, "");
  switch (r.agency) {
    case "am_best": return /^(A\+\+|A\+|A|A-|B\+\+|B\+|B)$/.test(g);
    case "demotech": return /^A/.test(g);
    case "sp": case "kroll": return /^(AAA|AA|A|BBB)[+-]?$/.test(g);
  }
}

export interface AdequacyResult { readonly pass: boolean; readonly deficiencies: readonly Deficiency[]; readonly deductible_pct: string; readonly lpi_curable: boolean; }

/** Rule 2 — every clause must hold; deficiencies list drives 9.2's LPI-trigger filter. */
export function evaluateAdequacy(p: HazardPolicy, titleHolders: readonly string[]): AdequacyResult {
  const defs: Deficiency[] = [];
  if (!["replacement_cost", "extended_rc", "guaranteed_rc"].includes(p.coverage_basis)) defs.push("coverage_basis");
  if (p.coverage_form !== "special" && !REQUIRED_PERILS.every((x) => (p.perils_present ?? []).includes(x))) defs.push("coverage_form");
  const pct = deductiblePct(p.deductible_cents, p.coverage_dwelling_cents);
  const unitFloor = p.unit_owner ? UNIT_DEDUCTIBLE_FLOOR : 0n;
  const maxDed = MAX_DEDUCTIBLE_PCT.mul(Decimal.fromBigInt(p.coverage_dwelling_cents)).toScaledInt(0, "DOWN");
  const limit = maxDed > unitFloor ? maxDed : unitFloor;
  if (p.deductible_cents > limit) defs.push("deductible_excess");
  for (const pp of p.per_peril_deductibles) {
    const ppPct = pp.pct !== undefined ? Decimal.parse(pp.pct).div(Decimal.fromInt(100)) : deductiblePct(pp.cents ?? 0n, p.coverage_dwelling_cents);
    if (ppPct.cmp(MAX_DEDUCTIBLE_PCT) > 0 && !defs.includes("deductible_excess")) defs.push("deductible_excess");
  }
  if (!p.ratings.some(ratingOk) && !p.rating_exception) defs.push("carrier_rating");
  if (!p.mortgagee_clause.names_partner_isaoa || !p.mortgagee_clause.co_servicer || p.mortgagee_clause.names_mers) defs.push("mortgagee_clause");
  const insureds = new Set(p.named_insureds.map((s) => s.trim().toLowerCase()));
  if (!titleHolders.every((t) => insureds.has(t.trim().toLowerCase()))) defs.push("named_insured");
  return { pass: defs.length === 0, deficiencies: defs, deductible_pct: pct.toFixed(6), lpi_curable: defs.some(isLpiCurable) };
}

/** 9.2 rule 1: only coverage amount/peril deficiencies can be cured by LPI. */
export function isLpiCurable(d: Deficiency): boolean {
  return d === "coverage_basis" || d === "coverage_form" || d === "wind_gap" || d === "master_lapse";
}

/** Rule 3 — renewal evidence silent on basis: compare to last known coverage. */
export function renewalShortcut(coverage: Cents, lastKnown: Cents | null, basisStated: boolean): "verified" | "coverage_decrease_unconfirmed" {
  if (basisStated) return "verified";
  if (lastKnown === null || coverage < lastKnown) return "coverage_decrease_unconfirmed";
  return "verified";
}

export const EXTRACTION_CONFIDENCE_MIN = 0.9;
export const CRITICAL_FIELDS = ["policy_number", "effective_date", "expiration_date", "coverage_amount", "deductible", "mortgagee_clause", "property_address"] as const;

/** Rule 4 — carrier/agent confirmation required when any critical field is below 0.90. */
export function confirmationRequired(confidence: Partial<Record<(typeof CRITICAL_FIELDS)[number], number>>): string[] {
  return CRITICAL_FIELDS.filter((f) => (confidence[f] ?? 0) < EXTRACTION_CONFIDENCE_MIN);
}

/** Rule 1 / 9.1-T7 — condo master policy with a per-unit deductible above $50,000 and no HO-6. */
export function masterPolicyDeficiencies(perUnitDeductible: Cents | null, hasUnitPolicy: boolean, interiorCovered: boolean): Deficiency[] {
  const out: Deficiency[] = [];
  if (perUnitDeductible !== null && perUnitDeductible > MASTER_PER_UNIT_DEDUCTIBLE_MAX) out.push("master_lapse");
  if ((perUnitDeductible !== null || !interiorCovered) && !hasUnitPolicy) out.push("unit_policy_missing");
  return out;
}

/** Deficiency notice within 5 servicer business days (9.1-T2). */
export function deficiencyNoticeDue(foundOn: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(foundOn, 5, cal); }

/** 9.1-T5 — lapse detected the day after expiration with no renewal evidence. */
export function lapseDetectedOn(expiration: PlainDate, renewalEvidence: boolean): PlainDate | null {
  return renewalEvidence ? null : addDays(expiration, 1);
}

/** Rule 7 — one annual reminder per loan per 12 months. */
export function annualReminderDue(lastSentOn: PlainDate | null, today: PlainDate): boolean {
  return lastSentOn === null || addDays(lastSentOn, 365) <= today;
}

/** 9.1-T9 — vendor feed silent for 3 business days → sev-2. */
export function vendorFeedSeverity(lastHeartbeat: PlainDate, today: PlainDate, cal: Calendar = servicer): "ok" | "sev2" {
  return addBusinessDays(lastHeartbeat, 3, cal) <= today ? "sev2" : "ok";
}
