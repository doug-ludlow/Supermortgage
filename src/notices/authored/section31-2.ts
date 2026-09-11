/**
 * §31.2 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * Owned here (spec "Outputs and artifacts"): `NTC_CA_CPPA_7220_ADMT_PRE_USE` — the California pre-use notice variant
 * (§7220: purpose, opt-out and access rights, how the technology works, information affecting outputs, no retaliation;
 * delivered with the 21.3 companion notices for California applicants while `applicability_position = applies`) — and
 * `NTC_SM_AI_DECISION_EXPLANATION` — the generic plain-language explanation of the automated system's role (California
 * access requests, §7222; Colorado explanations where the ECOA/FCRA notice does not already satisfy 6-1-1704). Content is
 * placeholder-only pending counsel's California posture memo (open question 3); the rationale guard applies: no
 * prohibited basis or proxy may appear in the explanation text. Referenced, never re-authored: `NTC_CO_SB26_189_ADMT_NOTICE`
 * (21.6), `NTC_SM_AI_INTERACTION_DISCLOSURE` (20.3), `NTC_REGB_1002_9_ADVERSE_ACTION` (21.6), `NTC_FNMA_LL2026_04_DISCLOSURE` (19.3).
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const DATE_RULE = R("date", "notice date", "presence", "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "date of the notice");
const NO_PROHIBITED_BASIS = R("no-prohibited-basis", "31.2 guardrails (rationale guard); 12 CFR 1002.6(a), comment 6(a)-2", "absence", "\\b(race|ethnicity|national origin|religion|gender|marital status|public assistance|language preference|census tract|zip code)\\b", "the explanation never cites a prohibited basis or proxy");
const BASE = { notice_date: "2026-12-15", partner_name: "Partner Bank", partner_address: "100 Partner Plaza, Phoenix, AZ 85004", applicant_name: "A. Applicant", application_ref: "APP-1001", privacy_url: "partnerbank.example.com/privacy", contact_phone: "(800) 555-0100", contact_email: "privacy@partnerbank.example.com" };

// ------------------------------------------------------------------ NTC_CA_CPPA_7220_ADMT_PRE_USE (California pre-use notice variant)
const CA_PRE_USE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Notice of Automated Decisionmaking Technology (California){{/block}}
{{#block "ref" page=1 y=0.1 pt=11}}{{date notice_date}}. {{applicant_name}}, application {{application_ref}}. From {{partner_name}}, {{partner_address}}.{{/block}}
{{#block "purpose" page=1 y=0.18 pt=11}}Purpose: {{partner_name}} uses automated decisionmaking technology to help evaluate your application for a mortgage loan, a financial or lending service. It is used for: {{#each purposes}}{{this}}; {{/each}}{{/block}}
{{#block "how" page=1 y=0.32 pt=11}}How it works: the technology applies {{partner_name}}'s written credit standards to the information in your application, your credit report and the documents you provide, and produces a recommendation. Information that affects its output includes: {{#each information_affecting_outputs}}{{this}}; {{/each}}A trained reviewer with the authority to make or change the decision reviews every denial or counteroffer before it is issued.{{/block}}
{{#block "rights" page=1 y=0.5 pt=11}}Your rights: you may opt out of the use of this technology by asking for a human decision. If you do, a person will decide your application from the same evidence under the same credit standards, and you may appeal that decision to a different reviewer. You may also request access to information about how the technology was used for you, including a plain-language explanation of its logic and outcome. To exercise these rights, contact {{contact_phone}} or {{contact_email}}, or visit {{privacy_url}}.{{/block}}
{{#block "no-retaliation" page=1 y=0.72 pt=11}}{{partner_name}} will not retaliate against you for exercising these rights. Opting out or requesting access will not by itself change the terms available to you.{{/block}}
{{#block "reference" page=1 y=0.82 pt=9}}California Consumer Privacy Act regulations, 11 CCR §§7200, 7220–7222. This notice is provided in addition to the notices required by the Equal Credit Opportunity Act and the Fair Credit Reporting Act.{{/block}}`;
const CA_PRE_USE_RULES = [DATE_RULE,
  R("purpose", "11 CCR §7220(c)(1): the specific purpose for which the business uses the ADMT", "presence", "Purpose: .* to help evaluate your application", "purpose stated"),
  R("purposes-listed", "11 CCR §7220(c)(1)", "data_range", "purposes.length", "at least one purpose", { range: { min: 1 } }),
  R("how-it-works", "11 CCR §7220(c)(4): how the ADMT works, including the logic and the key parameters", "presence", "How it works: .* produces a recommendation", "how the technology works"),
  R("inputs-listed", "11 CCR §7220(c)(4): information affecting outputs", "data_range", "information_affecting_outputs.length", "at least one input class described", { range: { min: 1 } }),
  R("opt-out", "11 CCR §7221(c)(1); §7010(d): opt-out / human-appeal alternative", "presence", "opt out of the use of this technology by asking for a human decision", "opt-out right / human-appeal exception"),
  R("access", "11 CCR §7222: right to access information about the use of the ADMT", "presence", "request access to information about how the technology was used", "access right"),
  R("no-retaliation", "11 CCR §7220(c): no retaliation", "presence", "will not retaliate", "no-retaliation statement"),
  R("contact", "11 CCR §7220: how to exercise the rights", "presence", "contact \\(\\d{3}\\) \\d{3}-\\d{4}", "contact method"),
  R("human-review", "31.2 rule 1: ca_substantially_replaces_human = false for denials/counteroffers (reviewer meets the (A)–(C) test)", "presence", "reviewer with the authority to make or change the decision reviews every denial or counteroffer", "human involvement described"),
  R("applies-only-when-applicable", "31.2 open question 3: delivered only while jurisdiction_rules.ai_governance.ca_admt.applicability_position = applies", "data_equality", "applicability_position", "position = applies", { predicate: { "==": [{ var: "applicability_position" }, "applies"] } }),
  NO_PROHIBITED_BASIS,
  R("heading-layout", "11 CCR §7220: clear and conspicuous", "layout", "heading", "heading on page 1, bold, ≥ 12 pt", { layout: { page: 1, bold: true, minPt: 12, maxYFraction: 0.1 } })];
const CA_PRE_USE_SAMPLE = { ...BASE, applicability_position: "applies", purposes: ["evaluating credit eligibility under the lender's written standards", "preparing pricing recommendations for a licensed loan originator", "reviewing property valuations"], information_affecting_outputs: ["your income and debts as documented", "your credit history from the consumer reporting agencies you authorized", "the loan amount, property value and loan-to-value ratio", "the loan program's eligibility rules"] };

// ------------------------------------------------------------------ NTC_SM_AI_DECISION_EXPLANATION (generic plain-language explanation)
const EXPLANATION = `{{#block "heading" page=1 y=0.05 pt=14 bold}}How an automated system was used in your application{{/block}}
{{#block "ref" page=1 y=0.1 pt=11}}{{date notice_date}}. {{applicant_name}}, application {{application_ref}}. From {{partner_name}}, {{partner_address}}.{{/block}}
{{#block "role" page=1 y=0.18 pt=11}}Role of the system: {{partner_name}} used an automated system ({{system_description}}) to help {{decision_description}}. The system applied {{partner_name}}'s written credit standards to the information in your file and produced a recommendation. {{#if human_reviewed}}A person with the authority to make or change the decision reviewed the recommendation and made the decision on {{date decided_on}}.{{/if}}{{#if decided_by_human}}The decision was made by a person without the automated system's recommendation.{{/if}}{{/block}}
{{#block "factors" page=1 y=0.36 pt=11}}The principal factors the system considered, in order of importance: {{#each principal_factors}}{{this}}; {{/each}}{{/block}}
{{#block "outcome" page=1 y=0.5 pt=11}}Outcome: {{outcome_description}}.{{/block}}
{{#block "rights" page=1 y=0.6 pt=11}}You may ask a person to review and reconsider this decision; a different reviewer with the authority to change it will respond in writing{{#if review_days}} within {{review_days}} days{{/if}}. You may also ask to see the personal data the system used and to correct any of it that is factually incorrect. Contact {{contact_phone}} or {{contact_email}}.{{/block}}
{{#block "reference" page=1 y=0.8 pt=9}}Provided under {{legal_basis}}. Your statement of reasons under the Equal Credit Opportunity Act, if one was required, was sent separately and remains your notice of the specific reasons for the action taken.{{/block}}`;
const EXPLANATION_RULES = [DATE_RULE,
  R("role", "C.R.S. 6-1-1704 'plain language description of a covered ADMT's role'; 11 CCR §7222 plain-language explanation of logic and outcome", "presence", "Role of the system: .* to help", "role of the ADMT described"),
  R("factors", "31.2 rule 3: reasons derived from ranked principal_factors (≤ 4, comment 9(b)(2)-1)", "data_range", "principal_factors.length", "1–4 principal factors", { range: { min: 1, max: 4 } }),
  R("outcome", "11 CCR §7222: the outcome for the consumer", "presence", "Outcome: .+\\.", "outcome stated"),
  R("human-review", "C.R.S. 6-1-1705(1)(a)(ii): right to meaningful human review and reconsideration; 31.2 rule 10: different individual with authority to change the decision", "presence", "different reviewer with the authority to change it", "human review right"),
  R("correction", "C.R.S. 6-1-1705: personal data and correction of factually incorrect personal data", "presence", "correct any of it that is factually incorrect", "correction right"),
  R("one-decision-maker", "31.2 rule 3 / data model human_involvement_level", "data_equality", "human_reviewed", "human_reviewed xor decided_by_human", { predicate: { "!=": [{ var: "human_reviewed" }, { var: "decided_by_human" }] } }),
  R("ecoa-separate", "C.R.S. 6-1-1704(6)(a) deemed compliance; the ECOA statement of reasons is 21.6's notice", "presence", "Equal Credit Opportunity Act", "ECOA notice referenced, not replaced"),
  NO_PROHIBITED_BASIS,
  R("heading-layout", "plain-language explanation", "layout", "heading", "heading on page 1, bold, ≥ 12 pt", { layout: { page: 1, bold: true, minPt: 12, maxYFraction: 0.1 } })];
const EXPLANATION_SAMPLE = { ...BASE, notice_date: "2027-01-20", system_description: "an underwriting assistant that checks applications against the loan program's rules", decision_description: "evaluate your application for a home loan", human_reviewed: true, decided_by_human: false, decided_on: "2027-01-12", principal_factors: ["Excessive obligations in relation to income", "Delinquent past or present credit obligations"], outcome_description: "your application was not approved on the terms requested", review_days: 30, legal_basis: "Colorado Revised Statutes 6-1-1704 and 6-1-1705" };

export const VERSIONS_31_2: VersionInput[] = [
  V("NTC_CA_CPPA_7220_ADMT_PRE_USE", CA_PRE_USE, CA_PRE_USE_RULES, CA_PRE_USE_SAMPLE, "ca.cppa.admt.2027-01", "11 CCR §§7200, 7220–7222 (approved text Sept 2025; compliance date Jan 1, 2027) — PARTIALLY VERIFIED; 31.2 open question 3"),
  V("NTC_SM_AI_DECISION_EXPLANATION", EXPLANATION, EXPLANATION_RULES, EXPLANATION_SAMPLE, "sm.ai_governance.2026-09", "C.R.S. 6-1-1704/1705 explanation and human-review rights; 11 CCR §7222 access explanation; 31.2 rule 10"),
];
export const OVERRIDES_31_2: Record<string, Partial<NoticeTemplate>> = {
  // Delivered with the 21.3 companion notices for California applicants (e-delivery under E-SIGN consent else mail); may travel with the Colorado pre-use notice and the AI interaction disclosure; program record ai_governance_7y, consumer copy per 31.3 matrix.
  NTC_CA_CPPA_7220_ADMT_PRE_USE: { citation: "11 CCR §§7010(c)-(d), 7200, 7220, 7221(c)(1), 7222", noticeClass: "origination_disclosures", channelPolicy: "esign_or_mail", separateDocument: false, mayCombineWith: ["NTC_CO_SB26_189_ADMT_NOTICE", "NTC_SM_AI_INTERACTION_DISCLOSURE"], retention: "ai_governance_7y", piiLevel: "medium" },
  // A standalone explanation (never combined with the ECOA statement of reasons, which it references); consumer-level decision record retention co_admt_3y ∪ regb_25m.
  NTC_SM_AI_DECISION_EXPLANATION: { citation: "C.R.S. 6-1-1704(2), 6-1-1705(1); 11 CCR §7222; 12 CFR 1002.9(b)(2) (referenced)", noticeClass: "origination_decisions", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: [], retention: "co_admt_3y", piiLevel: "high" },
};
