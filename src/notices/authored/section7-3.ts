/**
 * §7.3 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides; the section's original templates stay in ./section07.ts. Spread by
 * ../catalog.ts after the section files, so a version here supersedes one there for the same code and effective date.
 *
 * NTC_REGZ_20D_ARM_INITIAL 1.2.0 (H-4(D)(4) basis; "estimate and actual variants") builds on the 1.1.0 content:
 *   - the table shows "(estimated)" labels and the "actual notice between two and four months before" sentence only
 *     when `is_estimate` (§1026.20(d)(2): "an estimate shall be disclosed and labeled as such"; rule 3: an index date
 *     already passed at render → `actual`);
 *   - the late-boarding path (edge "Boarded after T−210 with no transferor evidence: send immediately; record breach
 *     attributable to the transferor") renders with `late_notice=true`: the 210–240 timing rule is not a content
 *     defect of the notice itself, the breach is recorded on the loan (ops-7-3 `sendInitialNotice`), so the rule is
 *     skipped and the breach attribution must be present instead;
 *   - a corrected (d) notice (rule 6 / T9) carries `corrected=true` and says which notice it replaces;
 *   - (xi) must name the state housing finance authority from `jurisdiction_rules.hfa_contact` (T8).
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { ARM_D_V11_SOURCE, ARM_D_V11_RULES, ARM_D_V11_SAMPLE } from "./section07.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });

const ESTIMATE_BLOCK_V11 = /\{\{#block "estimate"[\s\S]*?\{\{\/block\}\}\n/;
const FOLLOW_UP_BLOCK_V11 = /\{\{#block "body"[\s\S]*?\{\{\/block\}\}$/;
const ESTIMATE_BLOCK_V12 = `{{#block "estimate" page=1 y=0.25 pt=11}}{{#if is_estimate}}Estimated new rate {{pct estimated_rate_pct}} (estimated) based on the {{index_name}} published {{date index_date}} by {{index_source}} of {{index_value}} plus a margin of {{pct margin_pct}}; estimated new payment {{money estimated_payment_cents}} (estimated) versus your current payment {{money current_payment_cents}}.{{else}}New rate {{pct estimated_rate_pct}} based on the {{index_name}} published {{date index_date}} by {{index_source}} of {{index_value}} plus a margin of {{pct margin_pct}}; new payment {{money estimated_payment_cents}} versus your current payment {{money current_payment_cents}}.{{/if}}{{/block}}
`;
const FOLLOW_UP_BLOCK_V12 = `{{#block "body" page=1 y=0.9 pt=11}}{{#if is_estimate}}The actual rate and payment will be sent between two and four months before {{date first_new_payment_due}}.{{else}}The rate and payment above are the actual figures for {{date first_new_payment_due}}.{{/if}}{{#if corrected}} This notice corrects and replaces the notice dated {{date corrected_notice_date}}; the corrected term is {{corrected_field}}.{{/if}}{{/block}}`;
export const ARM_D_V12_SOURCE = ARM_D_V11_SOURCE.replace(ESTIMATE_BLOCK_V11, ESTIMATE_BLOCK_V12).replace(FOLLOW_UP_BLOCK_V11, FOLLOW_UP_BLOCK_V12);
if (ARM_D_V12_SOURCE === ARM_D_V11_SOURCE || !ARM_D_V12_SOURCE.includes("{{#if is_estimate}}")) throw new Error("NTC_REGZ_20D_ARM_INITIAL 1.2.0: the 1.1.0 estimate/follow-up blocks were not found");

export const ARM_D_V12_RULES: ContentRule[] = [
  ...ARM_D_V11_RULES.filter((r) => r.rule_id !== "iii-estimated" && r.rule_id !== "timing-window").map((r) => (r.rule_id === "follow-up" ? { ...r, when: { "==": [{ var: "is_estimate" }, true] } } : r)),
  R("iii-estimated", "§1026.20(d)(2)(iii); comment 20(d)(2)(iii)(A)-1", "presence", "\\(estimated\\).*\\(estimated\\)", "both the estimated rate and the estimated payment are labeled", { when: { "==": [{ var: "is_estimate" }, true] } }),
  R("iii-actual-unlabeled", "§1026.20(d)(2)(iii)", "absence", "\\(estimated\\)", "actual figures are not labeled as estimates", { when: { "==": [{ var: "is_estimate" }, false] } }),
  R("timing-window", "§1026.20(d)(1)", "data_range", "days_before_first_payment", "sent 210–240 days before the first new payment", { range: { min: 210, max: 240 }, when: { "!=": [{ var: "late_notice" }, true] } }),
  R("late-breach-recorded", "§1026.20(d)(1); 7.3 edge 'Boarded after T−210'", "data_equality", "breach_attributable_to", "a late (d) notice records who owns the breach", { predicate: { in: [{ var: "breach_attributable_to" }, ["transferor", "servicer"]] }, when: { "==": [{ var: "late_notice" }, true] } }),
  R("xi-state-hfa", "§1026.20(d)(2)(xi); jurisdiction_rules.hfa_contact", "data_equality", "state_hfa_contact", "the state housing finance authority (name and telephone) from jurisdiction_rules by property state", { predicate: { matches: ["state_hfa_contact", "^\\S.+ \\(\\d{3}\\) \\d{3}-\\d{4}$"] } }),
  R("corrected-reference", "7.3 rule 6", "presence", "corrects and replaces the notice dated", "a corrected notice names the notice it replaces", { when: { "==": [{ var: "corrected" }, true] } }),
];
export const ARM_D_V12_SAMPLE: Record<string, unknown> = { ...ARM_D_V11_SAMPLE, late_notice: false, breach_attributable_to: null, corrected: false, corrected_notice_date: null, corrected_field: null, basis: "estimate" };

export const VERSIONS_7_3: VersionInput[] = [
  { templateCode: "NTC_REGZ_20D_ARM_INITIAL", version: "1.2.0", effectiveFrom: D("2026-09-03"), source: ARM_D_V12_SOURCE, contentRules: ARM_D_V12_RULES.filter((r) => r.kind !== "layout"), layoutRules: ARM_D_V12_RULES.filter((r) => r.kind === "layout"), samplePayload: ARM_D_V12_SAMPLE, ruleSet: "regz.arm_notices.2013", sampleFormBasis: "H-4(D)(4); 7.3 worked example (estimate and actual variants; late-boarding and corrected paths)" },
];
export const OVERRIDES_7_3: Record<string, Partial<NoticeTemplate>> = {};
