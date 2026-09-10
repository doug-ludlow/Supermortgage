/**
 * §8.2 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides; the section's original templates stay in ./section08.ts. Spread by
 * ../catalog.ts after the section files, so a version here supersedes one there for the same code and effective date.
 *
 * NTC_FCRA_1022_43E_RESULTS 1.1.0: the section's 1.0.0 checks "sent by day 30" as a fixed range, which would hold a
 * results letter mailed on day 31–45 of an extended clock (§1022.43(e)(3) → §1681i(a)(1)(B): "may be extended for not
 * more than 15 additional days if the consumer reporting agency receives information from the consumer during that
 * 30-day period"; 8.2 rule 1: supplementation within the 30 days → `extended_to` = receipt + 45). This version checks
 * the letter against the period actually in force (`results_period_days` = 30, or 45 when extended) and tells the
 * consumer that the period was extended and why. The ops layer (src/domain/credit-reporting/ops-8-2.ts
 * `sendResultsNotice`) supplies `results_period_days`, `extended_to` and `supplemented_on` from the case record.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const CONTACT = `{{#block "contact" page=1 y=0.9 pt=10}}Supermortgage · {{servicer_phone}} (toll-free) · {{servicer_address}}{{/block}}`;

const RESULTS_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Results of our investigation of your credit reporting dispute{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}We received your dispute on {{date received_on}}. {{#if extended_to}}Because you sent us additional information on {{date supplemented_on}}, the period for our investigation was extended to {{date extended_to}}. {{/if}}{{#each items}}Item: {{item}}. Determination: {{determination}}. Reason: {{reason}}. {{/each}}{{#if corrections}}What we corrected: {{#each corrections}}{{this}}; {{/each}}The corrected information will appear in our next monthly report to the credit bureaus and we have sent an update to each bureau.{{else}}No changes were made to the information we furnished.{{/if}} You may also dispute this information directly with the credit bureaus and you may add a statement of dispute to your credit file. {{#if adverse_ai}}This determination was generated with automated tools; you may request review by a person by calling {{servicer_phone}}.{{/if}} Send further disputes to {{dispute_address}}.{{/block}}
${CONTACT}`;
const RESULTS_RULES: ContentRule[] = [
  R("items", "12 CFR 1022.43(e)(3)", "presence", "Item: .* Determination: .* Reason: ", "each item, determination and reason"),
  R("corrections", "§1022.43(e)(3)", "presence", "(What we corrected: .* next monthly report|No changes were made)", "corrections and when they appear"),
  R("cra-rights", "§1022.43(e); §1681i", "presence", "dispute this information directly with the credit bureaus and you may add a statement of dispute", "CRA dispute rights"),
  R("address", "§1022.43(c)(2)", "presence", "Send further disputes to PO Box", "direct-dispute address"),
  R("human-review", "8.2 rule 8 (Colorado AI Act posture)", "conditional", "adverse_ai", "human-review path on adverse AI determinations", { when: { "==": [{ var: "adverse_ai" }, true] }, predicate: { "==": [{ var: "human_review_offered" }, true] } }),
  R("extension-explained", "§1681i(a)(1)(B); 8.2 rule 1 (`extended_to` = receipt + 45)", "conditional", "extended_to", "an extended period is explained to the consumer", { when: { present: "extended_to" }, predicate: { and: [{ present: "supplemented_on" }, { "==": [{ var: "results_period_days" }, 45] }] } }),
  R("within-period", "§1022.43(e)(3) (before the §1681i(a)(1) period expires: 30 days, 45 when the consumer supplements within the 30 days)", "data_equality", "days_after_receipt", "sent before the results period in force (30 days; 45 if extended) expires", { predicate: { and: [{ in: [{ var: "results_period_days" }, [30, 45]] }, { "<=": [{ var: "days_after_receipt" }, { var: "results_period_days" }] }] } }),
];
/** Sample: the rule-1 worked example — received Fri 2027-09-03, supplemented 2027-09-20 → extended to 2027-10-18, mailed day 40. */
const RESULTS_SAMPLE = {
  received_on: "2027-09-03", supplemented_on: "2027-09-20", extended_to: "2027-10-18", results_period_days: 45, days_after_receipt: 40,
  items: [{ item: "February 2027 payment reported late", determination: "verified as reported", reason: "our records show the February 1 installment was not received until the deferral in August" }],
  corrections: [], adverse_ai: true, human_review_offered: true, dispute_address: "PO Box 2, Testville TX 75001", servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001",
};

export const VERSIONS_8_2: VersionInput[] = [
  { ...V("NTC_FCRA_1022_43E_RESULTS", RESULTS_SOURCE, RESULTS_RULES, RESULTS_SAMPLE, "fcra.regv.2026-09", "12 CFR 1022.43(e)(3); 15 U.S.C. §1681i(a)(1)(A)–(B)"), version: "1.1.0", effectiveFrom: D("2026-09-02") },
];
export const OVERRIDES_8_2: Record<string, Partial<NoticeTemplate>> = {};
