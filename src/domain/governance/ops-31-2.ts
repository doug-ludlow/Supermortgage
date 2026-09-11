/**
 * §31.2 AI governance, model risk and fair-lending controls — pure rule functions, one per rule / T-id
 * (spec/sections/31-cross-cutting-licensing-and-approvals-ai-governance-and-fair/31-2-….md "Business rules and
 * calculations"). Reuses the 19.4 statistics (`normalCdf`) and vocabulary (flags none | screen | significant | material |
 * suppressed; small-cell 10; pooling 30; materiality 5 pp / adjusted OR outside 0.80–1.25) and 19.3's Fannie Mae request
 * clock (`fnmaRequestDue`). Dates are PlainDate strings; business days are `business_days_creditor` (rule: 10 BD partner
 * notice, 2 BD drift review, 5 BD complaint triage / corrected statement of reasons). No money arithmetic in this process.
 */
import { type PlainDate, addDays, addYears, endOfMonth, parts, ymd } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor, rollForward } from "../../kernel/calendar/business.ts";
import { normalCdf } from "../data-security/fairlending.ts";
import { fnmaRequestDue } from "../data-security/ops-19-3.ts";

// ---------------------------------------------------------------- rule 1 — inventory and classification
export type AgentPackage = "intake" | "pricing" | "disclosure" | "verification" | "fraud-risk" | "underwriter" | "valuation" | "title-closing" | "compliance-tester" | "funder" | "warehouse" | "post-closing" | "secondary" | "hmda" | "boarding";
export type DecisionKind = "credit_decision" | "counteroffer" | "noia" | "pricing_quote" | "lock_terms" | "pricing_exception" | "valuation_review" | "rov" | "fraud_hold" | "identity_hold" | "condition_waiver" | "needs_list" | "mlo_terms_prep" | "disclosure_content" | "qc_selection" | "delivery_prep";
export type CoAdmtRole = "developer" | "deployer" | "both" | "n_a";
export type Sr117Class = "rules_deterministic" | "llm_agent" | "vendor_model_consumed" | "scoring_model";
export type BiasCadence = "pre_deploy_and_quarterly" | "pre_deploy_only" | "n_a";
export type SystemState = "registered" | "assessed" | "evaluated" | "bias_tested" | "partner_notified" | "deployed" | "monitored" | "restricted" | "retired";

/** The decision kinds each addendum §8 agent materially influences (rule 1); an empty list means "acts after a decision or on non-consumer counterparties". */
export const MATERIAL_INFLUENCE: Readonly<Record<AgentPackage, readonly DecisionKind[]>> = {
  underwriter: ["credit_decision", "counteroffer", "noia", "condition_waiver", "needs_list"],
  pricing: ["pricing_quote", "lock_terms", "pricing_exception"],
  valuation: ["valuation_review", "rov"],
  "fraud-risk": ["fraud_hold", "identity_hold"],
  "compliance-tester": ["disclosure_content"],
  intake: ["mlo_terms_prep"],
  disclosure: [], verification: [], "title-closing": [], funder: [], warehouse: [], "post-closing": [], secondary: [], hmda: ["qc_selection"], boarding: [],
};
/** Decision kinds whose outcome is a consequential / high-risk decision (restricted on a drift alert or a failed test). */
export const HIGH_RISK_DECISION_KINDS: readonly DecisionKind[] = ["credit_decision", "counteroffer", "noia", "pricing_quote", "lock_terms", "pricing_exception", "valuation_review", "rov", "fraud_hold", "identity_hold", "condition_waiver"];

export interface Classification {
  readonly agent_package: AgentPackage; readonly decision_kinds: readonly DecisionKind[];
  readonly materially_influences_consequential_decision: boolean; readonly co_admt_role: CoAdmtRole;
  readonly ca_admt_significant_decision: boolean; readonly ca_substantially_replaces_human: boolean;
  readonly sr11_7_model_class: Sr117Class; readonly bias_test_cadence: BiasCadence; readonly risk_tier: "high_consequential" | "T3_internal";
}
/** Rule 1: every origination agent version is an `ai_systems` row with the Colorado / California / SR 11-7 classification. */
export function classifySystem(i: { readonly agent_package: AgentPackage; readonly model_class?: Sr117Class; readonly decision_kinds?: readonly DecisionKind[]; readonly approvals_without_reviewer_action?: boolean }): Classification {
  const kinds = i.decision_kinds ?? MATERIAL_INFLUENCE[i.agent_package];
  // a change that gives a post-decision agent decision influence re-classifies it (rule 1)
  const material = kinds.some((k) => HIGH_RISK_DECISION_KINDS.includes(k) || k === "mlo_terms_prep" || k === "disclosure_content");
  const adverseKinds = kinds.some((k) => k === "credit_decision" || k === "counteroffer" || k === "noia");
  return {
    agent_package: i.agent_package, decision_kinds: kinds, materially_influences_consequential_decision: material,
    co_admt_role: material ? "developer" : "n_a",
    ca_admt_significant_decision: material,
    // false for denials/counteroffers/NOIAs — `underwriting_reviewer` meets the (A)–(C) test; true for approvals decided without reviewer action (open question 7: conservative)
    ca_substantially_replaces_human: material && !adverseKinds ? true : (i.approvals_without_reviewer_action ?? false),
    sr11_7_model_class: i.model_class ?? (i.agent_package === "compliance-tester" || i.agent_package === "hmda" ? "rules_deterministic" : "llm_agent"),
    bias_test_cadence: material ? "pre_deploy_and_quarterly" : "n_a",
    risk_tier: material ? "high_consequential" : "T3_internal",
  };
}

// ---------------------------------------------------------------- T1 — the origination deploy gate
export interface DeployGateFacts {
  readonly assessment_kind?: "pre_deployment" | "material_modification" | "annual" | null; readonly assessment_approved?: boolean;
  readonly eval_pass?: boolean; readonly bias_tests_pass?: boolean | null; readonly risk_tier?: string;
  readonly partner_notified_at?: string | null; readonly co_covered?: boolean; readonly co_docs_delivered_to_deployer_at?: string | null;
  readonly partner_officer_approved?: boolean; readonly restricted_decision_kinds?: readonly string[];
}
export interface GateVerdict { readonly open: boolean; readonly reasons: readonly string[]; readonly gate: string; }
/** `SM_O122_ORIGINATION_AI_DEPLOY_GATE`: assessment approved ∧ eval pass ∧ bias tests pass (high-risk) ∧ partner notified ∧ (CO covered → card delivered) ∧ (high-risk → partner officer approval). */
export function originationDeployGate(f: DeployGateFacts): GateVerdict {
  const reasons: string[] = [];
  const highRisk = f.risk_tier === "high_consequential";
  if (!(f.assessment_approved === true && (f.assessment_kind === "pre_deployment" || f.assessment_kind === "material_modification"))) reasons.push("no approved pre_deployment/material_modification assessment (ai_impact_assessments)");
  if (f.eval_pass !== true) reasons.push("SM_AI_SYSTEM_EVAL_BEFORE_DEPLOY open: no eval-suite pass for this version (19.3)");
  if (highRisk && f.bias_tests_pass !== true) reasons.push("SM_AI_BIAS_TEST_PRE_DEPLOY open: the four 19.4 bias tests have not passed for this version");
  if (!f.partner_notified_at) reasons.push("partner_notified_at not set (SM_O122_MODEL_CHANGE_NOTICE_TO_PARTNER_10BD)");
  if (f.co_covered && !f.co_docs_delivered_to_deployer_at) reasons.push("co_docs_delivered_to_deployer_at not set (CO_SB26_189_1702_MATERIAL_UPDATE_NOTICE / developer card)");
  if (highRisk && f.partner_officer_approved === false) reasons.push("partner officer approval record missing for a high_consequential system (open question 4)");
  return { open: reasons.length === 0, reasons, gate: "SM_O122_ORIGINATION_AI_DEPLOY_GATE" };
}
/** Rule / open question 5: the version-change notice to the partner is due 10 creditor business days after the change decision (emergency fixes: 1). */
export function partnerNoticeDue(changeDecisionOn: PlainDate, emergency = false): PlainDate { return addBusinessDays(changeDecisionOn, emergency ? 1 : 10, creditor); }
/** `SM_O122_AI_ASSESSMENT_ANNUAL_365`: the next assessment is due 365 calendar days after completion. */
export function assessmentNextDue(completedOn: PlainDate): PlainDate { return addDays(completedOn, 365); }
/** State machine (AI system, origination): registered → assessed → evaluated → bias_tested → partner_notified → deployed. */
export function systemState(f: DeployGateFacts & { readonly deployed?: boolean; readonly retired?: boolean; readonly restricted?: boolean; readonly deployed_at?: string | null; readonly retired_at?: string | null }): SystemState {
  if (f.retired || f.retired_at) return "retired";
  if (f.restricted || (f.restricted_decision_kinds?.length ?? 0) > 0) return "restricted";
  if (f.deployed || f.deployed_at) return "deployed";
  const assessed = f.assessment_approved === true && (f.assessment_kind === "pre_deployment" || f.assessment_kind === "material_modification");
  if (!assessed) return "registered";
  if (f.eval_pass !== true) return "assessed";
  if (f.risk_tier === "high_consequential" && f.bias_tests_pass !== true) return "evaluated";
  if (!f.partner_notified_at || (f.co_covered && !f.co_docs_delivered_to_deployer_at)) return "bias_tested";
  return "partner_notified";
}

// ---------------------------------------------------------------- rule 2 — pre-deployment assessment (proxy review; inputs attestation)
export type InputClass = "legitimate_credit_factor" | "proxy_risk" | "prohibited";
/** Rule 2(c) / rule 9: the proxy classification of a decision input (ZIP/census tract prohibited as a decision input; names, e-mail, street address and language preference never in decision prompts). */
export function classifyInput(name: string): { readonly input: string; readonly class: InputClass; readonly disposition: string } {
  const k = name.toLowerCase();
  if (RESTRICTED_INPUTS.some((r) => k === r || k.endsWith(`_${r}`) || k.startsWith(`${r}_`))) return { input: name, class: "prohibited", disposition: "restricted demographic field — never an input (§1002.5(b)/§1002.13; 19.4)" };
  if (PROXY_INPUTS.some((r) => k === r || k.endsWith(`_${r}`) || k.startsWith(`${r}_`))) return { input: name, class: "prohibited", disposition: k.includes("zip") || k.includes("tract") ? "geography: permitted only for deterministic AMI/loan-limit/flood lookups outside the model" : "tokenized in decision prompts; never a decision input" };
  if (k.includes("income") || k.includes("dti") || k.includes("ltv") || k.includes("score") || k.includes("reserves") || k.includes("credit")) return { input: name, class: "legitimate_credit_factor", disposition: "Selling Guide factor" };
  return { input: name, class: "proxy_risk", disposition: "screened; retained only with a documented business justification" };
}
export const RESTRICTED_INPUTS = ["race", "ethnicity", "sex", "age", "race_codes", "ethnicity_codes", "age_at_application", "religion", "national_origin", "marital_status", "receipt_of_public_assistance"] as const;
export const PROXY_INPUTS = ["language_preference", "preferred_language", "first_name", "last_name", "surname", "name", "street_address", "email", "census_tract", "zip", "zip_code"] as const;
/** Rule 2(b): the inputs attestation passes only when no restricted or proxy field is an input variable. */
export function inputsAttestation(inputs: readonly string[]): { readonly attested: boolean; readonly prohibited: readonly string[]; readonly proxy_review: readonly ReturnType<typeof classifyInput>[] } {
  const proxy_review = inputs.map(classifyInput);
  const prohibited = proxy_review.filter((p) => p.class === "prohibited").map((p) => p.input);
  return { attested: prohibited.length === 0, prohibited, proxy_review };
}

// ---------------------------------------------------------------- rules 5–7 — outcome monitoring statistics
export type Flag = "none" | "screen" | "significant" | "material" | "suppressed";
export interface DisparityInput { readonly n_group: number; readonly events_group: number; readonly n_comparison: number; readonly events_comparison: number; readonly adjusted_or?: number | null; readonly adjusted_or_ci?: readonly [number, number] | null; readonly adverse_direction?: "lower" | "higher"; }
export interface DisparityResult {
  readonly n_group: number; readonly n_comparison: number; readonly rate_group: number; readonly rate_comparison: number;
  readonly air: number; readonly diff_pp: number; readonly pooled_p: number; readonly se: number; readonly z: number; readonly p_value: number;
  readonly screen_fails: boolean; readonly significant: boolean; readonly material: boolean; readonly flag: Flag; readonly suppressed: boolean; readonly pooled_window_required: boolean;
  readonly adjusted_or: number | null; readonly review_clock: "SM_O122_FAIR_LENDING_REVIEW_30D" | null;
}
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
/**
 * Rule 5 (as 19.4 rule 7): AIR four-fifths screen, two-proportion z with the pooled proportion, two-sided p; `material` =
 * significant after controls **and** raw gap ≥ 5 pp or adjusted OR outside 0.80–1.25; small cells < 10 suppressed; groups
 * < 30 pooled over rolling windows. `adverse_direction` = "lower" for approval-type rates, "higher" for counteroffer /
 * denial / hold rates (the AIR is then reported in the adverse direction).
 */
export function disparityTest(i: DisparityInput): DisparityResult {
  const suppressed = i.n_group < 10 || i.n_comparison < 10;
  const pooled_window_required = !suppressed && (i.n_group < 30 || i.n_comparison < 30);
  const g = i.n_group ? i.events_group / i.n_group : 0, c = i.n_comparison ? i.events_comparison / i.n_comparison : 0;
  const air = c === 0 ? (g === 0 ? 1 : Infinity) : g / c;
  const pooled = (i.events_group + i.events_comparison) / Math.max(1, i.n_group + i.n_comparison);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(1, i.n_group) + 1 / Math.max(1, i.n_comparison)));
  const z = se === 0 ? 0 : (g - c) / se;
  const p_value = 2 * (1 - normalCdf(Math.abs(z)));
  const adverse = i.adverse_direction ?? "lower";
  const gapAdverse = adverse === "lower" ? g < c : g > c;
  const screen_fails = adverse === "lower" ? air < 0.8 : air > 1.25;
  const significant = !suppressed && !pooled_window_required && gapAdverse && p_value < 0.05;
  const or = i.adjusted_or ?? null;
  const orOutside = or !== null && (or < 0.8 || or > 1.25);
  const diff_pp = (g - c) * 100;
  // material requires significance after controls (an adjusted OR was estimated and lies outside 0.80–1.25) and a raw gap ≥ 5 pp
  const material = significant && Math.abs(diff_pp) >= 5 && orOutside;
  const flag: Flag = suppressed ? "suppressed" : material ? "material" : significant ? "significant" : gapAdverse ? "screen" : "none";
  return { n_group: i.n_group, n_comparison: i.n_comparison, rate_group: g, rate_comparison: c, air: r3(air), diff_pp: Math.round(diff_pp * 10) / 10, pooled_p: pooled, se, z: r3(z), p_value: r3(p_value),
    screen_fails, significant, material, flag, suppressed, pooled_window_required, adjusted_or: or, review_clock: material ? "SM_O122_FAIR_LENDING_REVIEW_30D" : null };
}
/** A finding flagged `material` opens a `fair_lending_reviews` row on the next creditor business day on/after the run and its 30-day clock (rule 7: Nov 15 run → opens Mon Nov 16 → due Wed Dec 16, 2026). */
export function reviewOpensOn(runOn: PlainDate): PlainDate { return rollForward(runOn, creditor); }
export function reviewDue(openedOn: PlainDate): PlainDate { return addDays(openedOn, 30); }
/** State machine (fair-lending run): a `material` finding cannot close without a corrective action or a documented legitimate justification, and never without an `officer` disposition. */
export function reviewMayClose(i: { readonly corrective_actions: readonly unknown[]; readonly legitimate_justification: string | null; readonly officer_disposition: boolean }): { readonly ok: boolean; readonly reason: string | null } {
  if (!i.officer_disposition) return { ok: false, reason: "a finding is never marked closed without an officer disposition (31.2 guardrails)" };
  if (i.corrective_actions.length === 0 && !(i.legitimate_justification ?? "").trim()) return { ok: false, reason: "closure requires a corrective action or a documented legitimate justification (rule 7; state machine)" };
  return { ok: true, reason: null };
}
/** Rule 6: every pricing exception must carry a documented, non-discretionary reason code — the review examines reason-code mix, never free text. */
export const PRICING_EXCEPTION_REASONS = ["competitor_match_documented", "error_correction", "cure", "relationship_policy", "tolerance_cure", "corrective_action", "program_rule", "rate_passthrough_recompute", "lock_policy", "documented_error_correction"] as const;
export function pricingExceptionReview(i: { readonly exceptions: readonly { readonly reason_code: string; readonly discretionary?: boolean }[]; readonly counts: DisparityInput }): { readonly result: DisparityResult; readonly all_coded: boolean; readonly uncoded: number; readonly reason_mix: Record<string, number>; readonly disposition: "screen_pooled_12m" | "review" | "none" } {
  const result = disparityTest({ ...i.counts, adverse_direction: "lower" });
  const mix: Record<string, number> = {}; let uncoded = 0;
  for (const e of i.exceptions) { const ok = (PRICING_EXCEPTION_REASONS as readonly string[]).includes(e.reason_code) && e.discretionary !== true; if (!ok) uncoded++; mix[e.reason_code] = (mix[e.reason_code] ?? 0) + 1; }
  return { result, all_coded: uncoded === 0, uncoded, reason_mix: mix, disposition: result.material ? "review" : result.screen_fails || result.flag === "significant" ? "screen_pooled_12m" : "none" };
}
/** Rule 6: `PR_RATE_SPREAD_BPS` / `PR_PRICE_TO_BORROWER_BPS` — adjusted mean difference > 10 bps with p < 0.05 → material (the platform prices deterministically, so the expectation is zero). */
export function pricingSpreadTest(i: { readonly adjusted_mean_diff_bps: number; readonly p_value: number }): Flag { return Math.abs(i.adjusted_mean_diff_bps) > 10 && i.p_value < 0.05 ? "material" : i.p_value < 0.05 ? "significant" : "screen"; }
/** Edge case: small partner volume → pooled 6/12-month windows, power limitations reported rather than false comfort. */
export function poolingWindow(monthlyGroupN: number): { readonly months: 1 | 3 | 6 | 12; readonly power_limited: boolean } {
  if (monthlyGroupN >= 30) return { months: 1, power_limited: false };
  if (monthlyGroupN * 3 >= 30) return { months: 3, power_limited: false };
  if (monthlyGroupN * 6 >= 30) return { months: 6, power_limited: true };
  return { months: 12, power_limited: true };
}
export const MONTHLY_SCOPES = ["underwriting_outcomes", "pricing_outcomes", "pricing_exceptions", "steering_product_mix", "valuation_review", "fraud_holds", "marketing_triggers"] as const;
export type Scope = (typeof MONTHLY_SCOPES)[number] | "complaint_mix" | "reason_accuracy";
/** The monthly run is due by the 15th for the prior month; the quarterly regression by quarter-end + 20; the governance pack by quarter-end + 30. */
export function monthlyRunDue(monthEnd: PlainDate): PlainDate { const { y, m } = parts(monthEnd); return m === 12 ? ymd(y + 1, 1, 15) : ymd(y, m + 1, 15); }
export function quarterlyRegressionDue(quarterEnd: PlainDate): PlainDate { return addDays(quarterEnd, 20); }
export function governancePackDue(quarterEnd: PlainDate): PlainDate { return addDays(quarterEnd, 30); }
export function reasonSampleDue(monthEnd: PlainDate): PlainDate { return addDays(monthEnd, 10); }
export function periodEnd(period: string): PlainDate { const [y, m] = period.split("-").map(Number); return endOfMonth(ymd(y!, m!, 1)); }

// ---------------------------------------------------------------- rule 4 / T4 — reason accuracy
export interface ReasonReplay { readonly adverse_action_id: string; readonly issued_reasons: readonly string[]; readonly replayed_reasons: readonly string[]; readonly application_id?: string; }
export interface ReasonAccuracy {
  readonly population: number; readonly sample: number; readonly matches: number; readonly mismatches: readonly ReasonReplay[]; readonly accuracy: number; readonly metric_code: "RA_REASON_ACCURACY";
  readonly pass: boolean; readonly corrective_action_required: boolean; readonly full_rereview_required: boolean; readonly severity: "sev1" | null; readonly next_month_sample_pct: 100 | null;
}
/** Sample ≥ 25 adverse actions, or 100 % when fewer. */
export function reasonSampleSize(population: number): number { return population <= 25 ? population : 25; }
/** Rule 4: accuracy = matches / sample; < 0.98 → corrective action and the next month at 100 %; < 0.95 → `underwriting_reviewer` 100 % re-review of the month's notices, sev 1. */
export function reasonAccuracy(i: { readonly population: number; readonly replays: readonly ReasonReplay[]; readonly sample_pct?: 100 | null }): ReasonAccuracy {
  const sample = i.replays.length;
  if (sample === 0) throw new RangeError("reason accuracy needs at least one replay");
  const required = i.sample_pct === 100 ? i.population : reasonSampleSize(i.population);   // the month after a miss is sampled at 100 %
  if (sample < required) throw new RangeError(`sample ${sample} is below the required ${required} for a population of ${i.population}${i.sample_pct === 100 ? " (100 % sample)" : ""}`);
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, k) => x === b[k]);
  const mismatches = i.replays.filter((r) => !same(r.issued_reasons, r.replayed_reasons));
  const matches = sample - mismatches.length;
  const accuracy = Math.round((matches / sample) * 1000) / 1000;
  const corrective = accuracy < 0.98, full = accuracy < 0.95;
  return { population: i.population, sample, matches, mismatches, accuracy, metric_code: "RA_REASON_ACCURACY", pass: !corrective, corrective_action_required: corrective, full_rereview_required: full, severity: full ? "sev1" : null, next_month_sample_pct: corrective ? 100 : null };
}
/** The mismatched borrower receives a corrected statement of reasons within 5 creditor business days (21.6 corrected-notice path). */
export function correctedStatementDue(foundOn: PlainDate): PlainDate { return addBusinessDays(foundOn, 5, creditor); }

// ---------------------------------------------------------------- rule 9 / T7 — attribute leakage on agent runs
export interface LeakageResult { readonly pass: boolean; readonly fields: readonly string[]; readonly quarantine: boolean; readonly restrict: { readonly ai_system_id: string; readonly decision_kinds: readonly DecisionKind[] } | null; readonly severity: "sev1" | null; }
/** Rule 9: decision agents receive de-identified packets — a manifest carrying a restricted or proxy field (names, address, e-mail, language preference, ZIP/tract) fails; the run is quarantined and the system is restricted for the decision kind until re-tested. */
export function leakageTest(i: { readonly run_id: string; readonly ai_system_id: string; readonly decision_kind: DecisionKind; readonly inputs_manifest: Record<string, unknown> | readonly string[] }): LeakageResult {
  const keys = Array.isArray(i.inputs_manifest) ? (i.inputs_manifest as readonly string[]) : Object.keys(i.inputs_manifest as Record<string, unknown>);
  const fields = keys.filter((k) => classifyInput(k).class === "prohibited");
  const pass = fields.length === 0;
  return { pass, fields, quarantine: !pass, restrict: pass ? null : { ai_system_id: i.ai_system_id, decision_kinds: [i.decision_kind] }, severity: pass ? null : "sev1" };
}
/** Rule 9(b): counterfactual perturbation on ≥ 500 synthetic cases — flip rate < 1 % with no directional shift. */
export function counterfactualTest(i: { readonly cases: number; readonly flips: number; readonly directional_shift: boolean }): { readonly pass: boolean; readonly flip_rate: number; readonly reason: string | null } {
  if (i.cases < 500) return { pass: false, flip_rate: i.cases ? i.flips / i.cases : 0, reason: "fewer than 500 synthetic cases" };
  const rate = i.flips / i.cases;
  return { pass: rate < 0.01 && !i.directional_shift, flip_rate: rate, reason: rate >= 0.01 ? "flip rate ≥ 1 %" : i.directional_shift ? "directional shift" : null };
}

// ---------------------------------------------------------------- T8 — golden-set drift
export interface DriftResult { readonly drift: boolean; readonly deltas: readonly { readonly metric: string; readonly baseline: number; readonly observed: number; readonly delta: number }[]; readonly restricted_decision_kinds: readonly DecisionKind[]; readonly review_due: PlainDate; readonly vendor_sla_breach: boolean; }
/** Edge case "model-provider silent update": golden-set deltas beyond tolerance → drift → high-risk decision kinds `restricted` within the 2-BD review window; an unnoticed provider version change is a 19.3 vendor-SLA breach. */
export function detectDrift(i: { readonly baseline: Record<string, number>; readonly observed: Record<string, number>; readonly tolerance?: number; readonly detected_on: PlainDate; readonly decision_kinds: readonly DecisionKind[]; readonly provider_version_changed_without_notice: boolean }): DriftResult {
  const tol = i.tolerance ?? 0.02;
  const deltas = Object.keys(i.baseline).map((metric) => { const baseline = i.baseline[metric]!, observed = i.observed[metric] ?? NaN; return { metric, baseline, observed, delta: observed - baseline }; });
  const drift = deltas.some((d) => Number.isNaN(d.observed) || Math.abs(d.delta) > tol);
  return { drift, deltas, restricted_decision_kinds: drift ? i.decision_kinds.filter((k) => HIGH_RISK_DECISION_KINDS.includes(k)) : [], review_due: driftReviewDue(i.detected_on), vendor_sla_breach: drift && i.provider_version_changed_without_notice };
}
/** `SM_O122_DRIFT_ALERT_REVIEW_2BD`: +2 creditor business days from detection (Wed Dec 2 → Fri Dec 4, 2026). */
export function driftReviewDue(detectedOn: PlainDate): PlainDate { return addBusinessDays(detectedOn, 2, creditor); }
/** Breach: auto-restrict on a second unreviewed alert. */
export function driftAutoRestrict(unreviewedAlerts: number): boolean { return unreviewedAlerts >= 2; }

// ---------------------------------------------------------------- rule 11 / T6 — Colorado developer duties
export const CO_ADMT_APPLIES_FROM = "2027-01-01" as PlainDate;
export interface CoGateFacts { readonly consumer_state: string; readonly on: PlainDate; readonly materially_influences_consequential_decision: boolean; readonly co_admt_role: CoAdmtRole | string; readonly co_docs_delivered_to_deployer_at: string | null; readonly co_docs_acknowledged_at: string | null; }
/** `CO_SB26_189_1702_DEVELOPER_DOCS_GATE`: a covered ADMT may be used for a Colorado consumer on/after 2027-01-01 only once the technical documentation is delivered to the deployer and acknowledged; otherwise the human path. */
export function coDeveloperDocsGate(f: CoGateFacts): GateVerdict & { readonly applies: boolean; readonly route: "admt" | "human_path" } {
  const applies = f.consumer_state === "CO" && f.on >= CO_ADMT_APPLIES_FROM && f.materially_influences_consequential_decision && (f.co_admt_role === "developer" || f.co_admt_role === "both");
  if (!applies) return { open: true, reasons: [], gate: "CO_SB26_189_1702_DEVELOPER_DOCS_GATE", applies, route: "admt" };
  const reasons: string[] = [];
  if (!f.co_docs_delivered_to_deployer_at) reasons.push("DOC_AI_SYSTEM_CARD not delivered to the deployer (6-1-1702)");
  else if (!f.co_docs_acknowledged_at) reasons.push("DOC_AI_SYSTEM_CARD delivered but not acknowledged by the deployer");
  return { open: reasons.length === 0, reasons, gate: "CO_SB26_189_1702_DEVELOPER_DOCS_GATE", applies, route: reasons.length ? "human_path" : "admt" };
}
export const CARD_SECTIONS = ["intended_uses", "training_data_categories", "known_limitations", "instructions_for_use_and_human_review"] as const;
/** Rule 11: a `DOC_AI_SYSTEM_CARD` carries the four 6-1-1702 elements; rule sets state "none — deterministic" for training data. */
export function systemCard(i: { readonly ai_system_id: string; readonly version: string; readonly model_class: Sr117Class; readonly intended_uses: readonly string[]; readonly training_data_categories?: readonly string[]; readonly known_limitations: readonly string[]; readonly instructions_for_use_and_human_review: readonly string[] }): { readonly document_code: string; readonly complete: boolean; readonly missing: readonly string[]; readonly training_data_categories: readonly string[] } {
  const training = i.model_class === "rules_deterministic" ? ["none — deterministic"] : [...(i.training_data_categories ?? [])];
  const missing: string[] = [];
  if (!i.intended_uses.length) missing.push("intended_uses");
  if (!training.length) missing.push("training_data_categories");
  if (!i.known_limitations.length) missing.push("known_limitations");
  if (!i.instructions_for_use_and_human_review.length) missing.push("instructions_for_use_and_human_review");
  return { document_code: `DOC_AI_SYSTEM_CARD_${i.ai_system_id}_${i.version}`, complete: missing.length === 0, missing, training_data_categories: training };
}
/** 6-1-1702 records: developer records anchor on their creation date + 3 years (deployer records: decided_at + 3, 21.6). */
export function developerRecordRetainUntil(createdOn: PlainDate): PlainDate { return addYears(createdOn, 3); }

// ---------------------------------------------------------------- T9 — California ADMT readiness
export type CaPosition = "applies" | "exempt_glba" | "unresolved";
export interface CaReadinessFacts { readonly applicability_position: CaPosition | string; readonly on: PlainDate; readonly consumer_state?: string; readonly preuse_notice_live: boolean; readonly optout_route_live: boolean; readonly access_procedure_live: boolean; }
export const CA_ADMT_APPLIES_FROM = "2027-01-01" as PlainDate;
export const CA_RISK_ASSESSMENT_DEADLINE = "2027-12-31" as PlainDate;
export const CA_ATTESTATION_DEADLINE = "2028-04-01" as PlainDate;
/** `CA_CPPA_7200_ADMT_READINESS_20270101`: while `applicability_position = applies`, from 2027-01-01 California applications go to the human path until the pre-use notice, opt-out/human-appeal route and access-request procedure are live. */
export function caAdmtReadinessGate(f: CaReadinessFacts): GateVerdict & { readonly applies: boolean; readonly route: "admt" | "human_path" } {
  const applies = f.applicability_position === "applies" && f.on >= CA_ADMT_APPLIES_FROM && (f.consumer_state === undefined || f.consumer_state === "CA");
  if (!applies) return { open: true, reasons: [], gate: "CA_CPPA_7200_ADMT_READINESS_20270101", applies, route: "admt" };
  const reasons: string[] = [];
  if (!f.preuse_notice_live) reasons.push("NTC_CA_CPPA_7220_ADMT_PRE_USE not live (§7220)");
  if (!f.optout_route_live) reasons.push("opt-out / human-appeal route not live (§7221(c)(1); human-appeal exception)");
  if (!f.access_procedure_live) reasons.push("access-request procedure (plain-language explanation) not live (§7222)");
  return { open: reasons.length === 0, reasons, gate: "CA_CPPA_7200_ADMT_READINESS_20270101", applies, route: reasons.length ? "human_path" : "admt" };
}

// ---------------------------------------------------------------- T10 — LL-2026-04 disclosure package from the pack
export const PACK_CONTENTS = ["inventory_export", "policy_and_review_minutes", "assessments", "evaluation_summaries", "bias_test_summaries", "monitoring_runs_and_findings", "reason_accuracy_results", "lda_searches", "decision_record_samples", "colorado_cards_notices_statistics", "california_artifacts", "vendor_attestations"] as const;
export interface Pack { readonly period: string; readonly issued_on: PlainDate; readonly contents: Readonly<Record<string, unknown>>; readonly exceptions: readonly string[]; }
/** Rule 12: the Fannie Mae request is answered from the latest pack — types, purposes, manner of use, safeguards and the inventory export; the officer task carries 19.3's due date (`FNMA_LL2026_04_DISCLOSURE_PROMPT_5BD`). */
export function fnmaDisclosurePackage(i: { readonly request_id: string; readonly received_on: PlainDate; readonly pack: Pack | null; readonly inventory: readonly { readonly id: string; readonly agent_package: string; readonly purpose?: string; readonly decision_kinds?: readonly string[]; readonly sr11_7_model_class?: string; readonly human_touchpoints?: readonly string[] }[] }): {
  readonly response: { readonly types: readonly string[]; readonly purposes: readonly string[]; readonly manner: readonly string[]; readonly safeguards: readonly string[]; readonly inventory_export: readonly unknown[]; readonly source_pack: string | null };
  readonly due: PlainDate; readonly timer: string; readonly officer_task: { readonly kind: "officer"; readonly reason: string; readonly due: PlainDate };
} {
  const d = fnmaRequestDue("ll2026_04_disclosure", i.received_on);
  const types = [...new Set(i.inventory.map((s) => s.sr11_7_model_class ?? "llm_agent"))];
  const purposes = [...new Set(i.inventory.map((s) => s.purpose ?? `${s.agent_package}: ${(s.decision_kinds ?? []).join(", ") || "no consequential decision"}`))];
  const manner = i.inventory.map((s) => `${s.agent_package}: recommendations to ${(s.human_touchpoints ?? ["underwriting_reviewer"]).join("/")}; human path available`);
  const safeguards = ["pre-deployment assessment and deploy gate (SM_O122_ORIGINATION_AI_DEPLOY_GATE)", "evaluation suites and 19.4 bias tests", "monthly/quarterly outcome monitoring by prohibited basis", "decision records with §1002.9(b)(2) principal factors and reviewer action", "kill-switch per decision kind; human review and reversal on request", "no restricted demographic field enters any decision input (inputs attestation)"];
  return { response: { types, purposes, manner, safeguards, inventory_export: i.inventory, source_pack: i.pack ? `PACK_AI_GOVERNANCE_${i.pack.period}` : null }, due: d.due, timer: d.timer, officer_task: { kind: "officer", reason: d.escalation.reason, due: d.due } };
}

// ---------------------------------------------------------------- T11 — reviewer rubber-stamping
export interface ReviewerMetrics { readonly reviewer_id: string; readonly recommendations: number; readonly approved: number; readonly median_review_seconds: number; }
/** Edge case "reviewer rubber-stamping": approval rate 100 % with median review time < 60 s → flagged; California human-involvement evidence at risk → `ca_substantially_replaces_human = true` until retraining is evidenced. */
export function reviewerOverrideTest(m: ReviewerMetrics): { readonly metric_code: "UW_REVIEWER_OVERRIDE_RATE"; readonly override_rate: number; readonly flagged: boolean; readonly ca_substantially_replaces_human: boolean; readonly actions: readonly string[] } {
  const override_rate = m.recommendations ? (m.recommendations - m.approved) / m.recommendations : 0;
  const flagged = m.recommendations >= 20 && override_rate === 0 && m.median_review_seconds < 60;
  return { metric_code: "UW_REVIEWER_OVERRIDE_RATE", override_rate, flagged, ca_substantially_replaces_human: flagged, actions: flagged ? ["reviewer procedure retraining", "ca_substantially_replaces_human=true on the affected system until retraining is evidenced", "partner notified in the pack"] : [] };
}

// ---------------------------------------------------------------- T12 / T13 — policy review anniversary; human path
/** `FNMA_LL2026_04_POLICY_REVIEW_365` (19.3): the annual review is due on the anniversary of the last review; past it → sev 2, carried as an exception in the next pack. */
export function policyReviewStatus(i: { readonly last_reviewed_on: PlainDate; readonly today: PlainDate; readonly reviewed_since: boolean }): { readonly due: PlainDate; readonly breached: boolean; readonly severity: 2 | null; readonly pack_exception: string | null } {
  const due = addYears(i.last_reviewed_on, 1);
  const breached = !i.reviewed_since && i.today > due;
  return { due, breached, severity: breached ? 2 : null, pack_exception: breached ? `FNMA_LL2026_04_POLICY_REVIEW_365 breached: annual review of POL-AI-01 due ${due} not completed` : null };
}
export type HumanInvolvement = "none" | "review_authority" | "decided_by_human";
/** Rule 3 / T13: the decision-record minimum — a decision on the human path carries `human_involvement_level = decided_by_human`; adverse kinds need a reviewer action. */
export function decisionRecord(i: { readonly ai_off: boolean; readonly decision_kind: DecisionKind; readonly principal_factors: readonly string[]; readonly reviewer_action: "approved" | "modified" | "rejected" | null; readonly inputs_manifest: readonly string[]; readonly rationale: string }): { readonly ok: boolean; readonly human_involvement_level: HumanInvolvement; readonly co_material_influence: boolean; readonly refusals: readonly string[]; readonly retention_classes: readonly string[] } {
  const refusals: string[] = [];
  if (!i.inputs_manifest.length) refusals.push("inputs_manifest required");
  if (!i.principal_factors.length) refusals.push("ranked principal_factors required (§1002.9(b)(2) source)");
  if (i.principal_factors.length > 4) refusals.push("more than four principal factors (comment 9(b)(2)-1)");
  const adverse = i.decision_kind === "credit_decision" || i.decision_kind === "counteroffer" || i.decision_kind === "noia";
  if (adverse && !i.reviewer_action) refusals.push("reviewer_action required on a denial/counteroffer/NOIA");
  if (rationaleGuard(i.rationale).violations.length) refusals.push("rationale_guard: rationale references a prohibited basis or proxy");
  const level: HumanInvolvement = i.ai_off ? "decided_by_human" : i.reviewer_action ? "review_authority" : "none";
  return { ok: refusals.length === 0, human_involvement_level: level, co_material_influence: !i.ai_off && HIGH_RISK_DECISION_KINDS.includes(i.decision_kind), refusals, retention_classes: ["co_admt_3y", "regb_25m", "fnma_loan_file_life_plus_4y"] };
}
/** Guardrail: consumer explanations and rationales never cite a prohibited basis or proxy (rationale guard). */
export function rationaleGuard(text: string): { readonly ok: boolean; readonly violations: readonly string[] } {
  const hits = ["race", "ethnicity", "national origin", "religion", "sex", "gender", "marital status", "age", "public assistance", "language preference", "surname", "zip code", "census tract", "neighborhood"].filter((w) => new RegExp(`\\b${w.replace(" ", "\\s+")}\\b`, "i").test(text));
  return { ok: hits.length === 0, violations: hits };
}
/** Rule 8: the LDA search selects the alternative that preserves the legitimate interest with the smallest disparity; recorded whether or not a change is made. */
export function ldaSelect(alternatives: readonly { readonly description: string; readonly performance_delta: number; readonly disparity_delta: number }[], maxPerformanceLoss = 0.01): { readonly selected: string | null; readonly rationale: string } {
  const viable = alternatives.filter((a) => a.performance_delta >= -maxPerformanceLoss);
  if (!viable.length) return { selected: null, rationale: "no alternative preserves the legitimate interest within the performance tolerance; current policy retained (business-necessity evidence)" };
  const best = [...viable].sort((a, b) => a.disparity_delta - b.disparity_delta)[0]!;
  return { selected: best.description, rationale: `smallest disparity (${best.disparity_delta}) among alternatives within ${maxPerformanceLoss} performance loss` };
}
/** Consumer AI-rights request due dates: Colorado explanation/human review 30 days (21.6 policy), California access 45 days (CCPA §1798.130), Utah/generic 10 business days. */
export function rightsRequestDue(kind: string, receivedOn: PlainDate): PlainDate {
  if (kind.startsWith("co_")) return addDays(receivedOn, 30);
  if (kind.startsWith("ca_")) return addDays(receivedOn, 45);
  return addBusinessDays(receivedOn, 10, creditor);
}
