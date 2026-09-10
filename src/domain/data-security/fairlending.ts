/** 19.4 Fair lending data elements — scope, age, statistics (AIR, z-test), flags, bias-test gates. */
import { type PlainDate, addDays, addMonths, parts } from "../../kernel/calendar/date.ts";

export const FL_SCOPE_START = "2023-03-01";
export function inScope(noteDate: PlainDate): boolean { return noteDate >= FL_SCOPE_START; }
export function ageAtApplication(dob: PlainDate, applicationOn: PlainDate): number {
  const a = parts(dob), b = parts(applicationOn);
  let years = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) years--;
  return years;
}
export type Language = "english" | "spanish" | "chinese" | "korean" | "vietnamese" | "tagalog" | "other" | "not_provided";
export function scifLanguage(value: string | null): Language {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return "not_provided";
  return (["english", "spanish", "chinese", "korean", "vietnamese", "tagalog"].includes(v) ? v : "other") as Language;
}

function erf(x: number): number { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
export function normalCdf(z: number): number { return 0.5 * (1 + erf(z / Math.SQRT2)); }

export interface RateTest { readonly group_n: number; readonly group_events: number; readonly comparison_n: number; readonly comparison_events: number; readonly adjusted_or?: number | null; }
export interface RateResult { readonly suppressed: boolean; readonly pooled: boolean; readonly group_rate: number; readonly comparison_rate: number; readonly air: number; readonly screen: boolean; readonly z: number; readonly p: number; readonly significant: boolean; readonly material: boolean; readonly review_due_days: 30 | null; }
/** Rule 7/8 — AIR four-fifths screen, two-proportion z-test, materiality (≥ 5 pp and adjusted OR outside 0.80–1.25). */
export function rateTest(t: RateTest): RateResult {
  if (t.group_n < 10 || t.comparison_n < 10) return { suppressed: true, pooled: false, group_rate: 0, comparison_rate: 0, air: 0, screen: false, z: 0, p: 1, significant: false, material: false, review_due_days: null };
  const pooledNeeded = t.group_n < 30 || t.comparison_n < 30;
  const g = t.group_events / t.group_n, c = t.comparison_events / t.comparison_n;
  const air = c === 0 ? 1 : Math.round((g / c) * 1000) / 1000;
  const p = (t.group_events + t.comparison_events) / (t.group_n + t.comparison_n);
  const se = Math.sqrt(p * (1 - p) * (1 / t.group_n + 1 / t.comparison_n));
  const z = se === 0 ? 0 : (g - c) / se;
  const pv = 2 * (1 - normalCdf(Math.abs(z)));
  const significant = !pooledNeeded && pv < 0.05;
  const orOutside = t.adjusted_or !== undefined && t.adjusted_or !== null && (t.adjusted_or < 0.8 || t.adjusted_or > 1.25);
  const material = significant && Math.abs(g - c) >= 0.05 && (t.adjusted_or === undefined || t.adjusted_or === null || orOutside);
  return { suppressed: false, pooled: pooledNeeded, group_rate: g, comparison_rate: c, air, screen: !pooledNeeded && (air < 0.8 || air > 1.25), z: Math.round(z * 100) / 100, p: Math.round(pv * 10000) / 10000, significant, material, review_due_days: material ? 30 : null };
}
export function materialReviewDue(foundOn: PlainDate): PlainDate { return addDays(foundOn, 30); }

export interface BiasTests { readonly leakage_clean: boolean; readonly counterfactual_flip_rate: number; readonly directional_shift: boolean; readonly outcome_parity_ok: boolean; readonly explanation_consistent: boolean; }
/** Rule 9 — all four tests must pass to deploy. */
export function biasGate(b: BiasTests): { pass: boolean; failures: string[] } {
  const f: string[] = [];
  if (!b.leakage_clean) f.push("attribute_leakage");
  if (b.counterfactual_flip_rate >= 0.01 || b.directional_shift) f.push("counterfactual_perturbation");
  if (!b.outcome_parity_ok) f.push("outcome_parity");
  if (!b.explanation_consistent) f.push("explanation_consistency");
  return { pass: f.length === 0, failures: f };
}
export const RESTRICTED_FIELDS = ["race_codes", "ethnicity_codes", "sex", "age_at_application", "race", "ethnicity"];
export function leakageScan(inputs: Record<string, unknown>): { clean: boolean; fields: string[]; action: "quarantine_sev1" | null } {
  const hits = Object.keys(inputs).filter((k) => RESTRICTED_FIELDS.includes(k));
  return { clean: hits.length === 0, fields: hits, action: hits.length > 0 ? "quarantine_sev1" : null };
}
export function transferOutExport(transferDate: PlainDate): { target: PlainDate; breach_if_no_ack_by: PlainDate } { return { target: addDays(transferDate, -7), breach_if_no_ack_by: transferDate }; }
export function impactAssessmentDue(modifiedOn: PlainDate): PlainDate { return addDays(modifiedOn, 90); }
export function assumptionVersion(lawfulMonitoringData: boolean): "new_version_assumption" | "unchanged_annotated" { return lawfulMonitoringData ? "new_version_assumption" : "unchanged_annotated"; }
export function ccpaDeletionResponse(): { deleted: false; basis: "GLBA_exemption" } { return { deleted: false, basis: "GLBA_exemption" }; }
export function boardingFollowupDue(boardedOn: PlainDate): PlainDate { return addDays(boardedOn, 30); }
export { addMonths };
