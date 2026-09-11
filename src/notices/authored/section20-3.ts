/**
 * §20.3 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * NTC_SM_ESIGN_CONSENT — the E-SIGN 15 U.S.C. 7001(c)(1)(B)/(C) statement with the two record categories (origination
 *   disclosures; servicing communications), the paper option, withdrawal and paper-copy procedures and fees, the
 *   hardware/software statement and the demonstration test (link + PDF token); an oral "yes" is stated to be void ((c)(6)).
 *   21.1 re-presents it for the application document class.
 * NTC_SM_PREQUAL_LETTER — rule 4: based on unverified information and a soft credit inquiry, "not a commitment to lend and
 *   not a preapproval" (Reg C §1003.2(b)(2) preapproval program not offered), no validity period as a commitment, conditions
 *   in general terms, the MLO/partner attribution (§1026.36(g)); MAP §1014.3(q)/(r) checklist (no misrepresentation of the
 *   likelihood of approval, no "pre-approved"/"guaranteed").
 * NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER — the §1026.19(e)(2)(ii) statement verbatim at the top of the front of page 1 in
 *   ≥ 12-point type on every consumer-specific written estimate issued before the Loan Estimate (20.4's gate).
 * NTC_CO_SB26_189_ADMT_NOTICE — C.R.S. 6-1-1704: `pre_use` (the point-of-interaction line + public notice URL and how to get
 *   more information; 20.3 triggers it at the first Colorado interaction) and `adverse_outcome_explanation` (21.6 embeds it:
 *   the decision, the role the ADMT played, name/version/developer, data categories, human review and correction).
 * Every consumer-facing text names the partner; SM appears as "operating for [Partner]". Placeholder identities only.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const present = (...paths: string[]): Record<string, unknown> => ({ and: paths.map((p) => ({ present: p })) });

// ------------------------------------------------------------------ NTC_SM_ESIGN_CONSENT (rule 8; 15 U.S.C. 7001(c))
export const ESIGN_CONSENT_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}CONSENT TO ELECTRONIC RECORDS AND SIGNATURES{{/block}}
{{#block "intro" page=1 y=0.1 pt=11}}{{partner_name}} (NMLSR ID {{partner_nmlsr_id}}), with Supermortgage operating for {{partner_name}}, asks for your consent to provide the records described below electronically. You have the right to receive these records on paper instead; if you do not consent, we will send them on paper at no charge.{{/block}}
{{#block "categories" page=1 y=0.2 pt=11}}Your consent applies to the categories of records you select: {{#each categories}}{{label}} ({{description}}); {{/each}}You may consent to either category or both.{{/block}}
{{#block "withdrawal" page=1 y=0.35 pt=11}}You may withdraw your consent at any time by {{withdrawal_procedure}}. Withdrawal takes effect within one business day and does not affect records already provided to you electronically. There is no fee to withdraw.{{/block}}
{{#block "paper" page=1 y=0.45 pt=11}}You may request a paper copy of any electronic record by {{paper_copy_procedure}}. Paper copies are provided at no charge.{{/block}}
{{#block "hardware" page=1 y=0.55 pt=11}}To receive and keep electronic records you need: {{hardware_software_requirements}}. If these requirements change in a way that creates a material risk that you will not be able to access or keep the records, we will tell you and ask you to consent again.{{/block}}
{{#block "demonstration" page=1 y=0.7 pt=11}}To complete your consent you must open the link in the email we send you and enter the code shown in the PDF attached to that email within {{verification_window_days}} days. This shows that you can access records in the electronic form we will use. A spoken "yes" on a call or in chat is not an electronic consent and cannot complete this step.{{/block}}
{{#block "body" page=1 y=0.85 pt=11}}Consent statement version {{disclosure_version}}. {{#if consumer_email}}Records will be sent to {{consumer_email}} or posted to your secure portal.{{/if}} Nothing in this consent requires you to use or accept electronic records.{{/block}}`;
export const ESIGN_CONSENT_RULES: ContentRule[] = [
  R("c1A-affirmative", "15 U.S.C. 7001(c)(1)(A)", "presence", "asks for your consent to provide the records described below electronically", "affirmative consent is requested (not assumed)"),
  R("c1B-i-paper-option", "15 U.S.C. 7001(c)(1)(B)(i)", "presence", "right to receive these records on paper", "the option to receive the record on paper"),
  R("c1B-i-withdrawal", "15 U.S.C. 7001(c)(1)(B)(i)", "presence", "withdraw your consent at any time by .+\\. Withdrawal takes effect", "the right to withdraw and the procedure"),
  R("c1B-i-withdrawal-data", "15 U.S.C. 7001(c)(1)(B)(i)", "data_equality", "withdrawal_procedure", "withdrawal procedure carried on the payload", { predicate: present("withdrawal_procedure") }),
  R("c1B-ii-scope", "15 U.S.C. 7001(c)(1)(B)(ii): to identified categories of records", "data_equality", "categories", "the two record categories (origination disclosures; servicing communications) are identified", { predicate: { and: [{ present: "categories" }, { ">=": [{ var: "category_count" }, 2] }, { "==": [{ var: "has_origination_disclosures" }, true] }] } }),
  R("c1B-ii-scope-text", "15 U.S.C. 7001(c)(1)(B)(ii)", "presence", "Origination disclosures \\(.*\\); Servicing communications \\(", "both categories rendered"),
  R("c1B-iii-procedure", "15 U.S.C. 7001(c)(1)(B)(iii)", "presence", "may consent to either category or both", "the consumer may consent to identified categories"),
  R("c1B-iv-paper-copy", "15 U.S.C. 7001(c)(1)(B)(iv)", "presence", "request a paper copy of any electronic record by .+\\. Paper copies are provided at no charge", "paper-copy procedure and the fee (none)"),
  R("c1C-i-hardware", "15 U.S.C. 7001(c)(1)(C)(i)", "presence", "To receive and keep electronic records you need: .+\\.", "hardware and software requirements"),
  R("c1C-ii-demonstration", "15 U.S.C. 7001(c)(1)(C)(ii); 7.4 rule 2", "presence", "open the link in the email we send you and enter the code shown in the PDF .* within \\d+ days", "the demonstration test (link + PDF token)"),
  R("c1C-ii-window", "7.4 rule 2: SM_ESIGN_VERIFY_EXPIRY_7", "data_range", "verification_window_days", "the demonstration window is 7 days", { range: { min: 7, max: 7 } }),
  R("c1D-material-change", "15 U.S.C. 7001(c)(1)(D)", "presence", "material risk that you will not be able to access or keep the records, we will tell you and ask you to consent again", "re-disclosure on a material hardware/software change"),
  R("c6-oral-void", "15 U.S.C. 7001(c)(6); 20.3 rule 8", "presence", "spoken \"yes\" on a call or in chat is not an electronic consent", "an oral communication is not an electronic consent"),
  R("b-no-obligation", "15 U.S.C. 7001(b)(2)", "presence", "Nothing in this consent requires you to use or accept electronic records", "no person is required to accept electronic records"),
  R("partner-named", "20.3 capacity: every consumer-facing text names the partner; SM appears as operating for the partner", "presence", "Supermortgage operating for .+", "partner named; SM as operator"),
  R("version-logged", "15 U.S.C. 7001(d); 7.4: version and hash logged", "data_equality", "disclosure_version", "disclosure version on the payload", { predicate: { matches: ["disclosure_version", "^\\d+\\.\\d+$"] } }),
];
export const ESIGN_CONSENT_SAMPLE = { partner_name: "Partner Bank", partner_nmlsr_id: "000000", disclosure_version: "2.0", consumer_email: "consumer@example.test", verification_window_days: 7, category_count: 2, has_origination_disclosures: true,
  categories: [{ label: "Origination disclosures", description: "Loan Estimate, revised Loan Estimates, Closing Disclosure, corrected Closing Disclosures, the early notices that accompany them, Reg B and FCRA notices, appraisal copies and rescission notices" }, { label: "Servicing communications", description: "periodic statements, escrow statements, notices about your loan after closing" }],
  withdrawal_procedure: "writing to [Partner address], calling [Partner phone] or using the withdraw option in your portal", paper_copy_procedure: "the same contact channels or the request-paper option in your portal", hardware_software_requirements: "a device with a current web browser, a PDF reader, an email address you can access and the ability to save or print files" };

// ------------------------------------------------------------------ NTC_SM_PREQUAL_LETTER (rule 4; Reg C §1003.2(b)(2); MAP §1014.3(q)/(r))
export const PREQUAL_LETTER_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}PREQUALIFICATION LETTER{{/block}}
{{#block "intro" page=1 y=0.1 pt=11}}Prepared {{date prepared_on}} for {{consumer_name}} by {{partner_name}} (NMLSR ID {{partner_nmlsr_id}}), with Supermortgage operating for {{partner_name}}. Reference {{prequal_id}}.{{/block}}
{{#block "basis" page=1 y=0.18 pt=11}}This letter is based on the information you told us, which we have not verified{{#if soft_inquiry}}, and on a soft credit inquiry that does not affect your credit score{{/if}}. {{#if has_amount_range}}Based on that information, you may be able to qualify for a {{transaction_intent}} loan between {{money amount_low_cents}} and {{money amount_high_cents}}.{{else}}Based on that information, you appear to meet the general criteria of the program you asked about.{{/if}}{{/block}}
{{#block "not_commitment" page=1 y=0.32 pt=12 bold}}This letter is not a commitment to lend and not a preapproval. It does not guarantee that a loan will be approved, and it has no validity period as a commitment.{{/block}}
{{#block "conditions" page=1 y=0.42 pt=11}}A loan decision requires, in general terms: {{#each general_conditions}}{{this}}; {{/each}}and a written decision follows within 30 days of a completed application.{{/block}}
{{#block "originator" page=1 y=0.6 pt=11}}Questions about loan terms are answered by {{mlo_name}}, NMLSR ID {{mlo_nmlsr_id}}, on behalf of {{partner_name}}. Rates, payments and program terms change; any rate you are quoted before an application is an estimate.{{/block}}
{{#block "body" page=1 y=0.75 pt=11}}Keep this letter for your records. It may be shared with a seller or real estate agent, who should understand that it is not a loan approval.{{/block}}`;
export const PREQUAL_LETTER_RULES: ContentRule[] = [
  R("not-commitment-not-preapproval", "20.3 rule 4: \"not a commitment to lend and not a preapproval\"", "presence", "not a commitment to lend and not a preapproval", "the not-a-commitment / not-a-preapproval statement"),
  R("not-commitment-prominent", "20.3 rule 4; 12 CFR 1014.3(q)", "layout", "not_commitment", "the statement is on page 1 in bold at ≥ 12 pt", { layout: { page: 1, bold: true, minPt: 12 } }),
  R("unverified-basis", "20.3 rule 4: based on unverified information", "presence", "information you told us, which we have not verified", "unverified-information basis"),
  R("soft-inquiry-basis", "20.3 rule 4: and a soft credit inquiry", "conditional", "soft_inquiry", "the soft inquiry is disclosed when it was the basis", { when: { "==": [{ var: "soft_inquiry" }, true] }, predicate: { "==": [{ var: "basis" }, "soft_pull"] } }),
  R("no-validity-period", "20.3 rule 4: no validity period as a commitment", "presence", "no validity period as a commitment", "no validity period"),
  R("general-conditions", "20.3 rule 4: lists the conditions in general terms", "presence", "A loan decision requires, in general terms: .+; .+;", "conditions in general terms"),
  R("general-conditions-data", "20.3 rule 4", "data_equality", "general_conditions", "at least two general conditions", { predicate: { ">=": [{ var: "condition_count" }, 2] } }),
  R("not-a-preapproval-program", "12 CFR 1003.2(b)(2); 20.3 open question 2", "data_equality", "is_preapproval", "not a Reg C preapproval program (no written commitment after comprehensive analysis)", { predicate: { and: [{ "==": [{ var: "is_preapproval" }, false] }, { "==": [{ var: "is_commitment" }, false] }, { "==": [{ var: "hmda_preapproval_program" }, false] }] } }),
  R("map-q-no-misrepresentation", "12 CFR 1014.3(q): the consumer's likelihood of obtaining the loan", "absence", "(pre-?approved|guaranteed|you are approved|you have been approved|approval is certain)", "no misrepresentation of the likelihood of approval"),
  R("map-r-not-a-loan-approval", "12 CFR 1014.3(r)", "presence", "it is not a loan approval", "the letter is not a loan approval"),
  R("mlo-attribution", "12 CFR 1026.36(g); 20.3 rule 7", "presence", "answered by .+, NMLSR ID \\d+, on behalf of .+", "MLO of record with NMLSR ID on behalf of the partner"),
  R("partner-named", "20.3 capacity", "presence", "Supermortgage operating for .+", "partner named; SM as operator"),
  R("pre-le-estimate", "12 CFR 1026.19(e)(2)(ii); 20.4", "presence", "any rate you are quoted before an application is an estimate", "pre-LE rate language is an estimate"),
  R("amount-range-data", "20.3 data model: loan_amount_range_cents", "conditional", "amount_high_cents", "the range is ordered when shown", { when: { "==": [{ var: "has_amount_range" }, true] }, predicate: { ">=": [{ var: "amount_high_cents" }, { var: "amount_low_cents" }] } }),
  R("no-fee-demand", "12 CFR 1026.19(e)(2)(i)(A)", "absence", "(pay now|payment due today|charge your card)", "no fee demand before the LE"),
];
/** Worked example 2: the Columbus, OH purchase lead of Thu Oct 15, 2026 (soft pull, income volunteered, no property yet). */
export const PREQUAL_LETTER_SAMPLE = { prepared_on: "2026-10-15", consumer_name: "[Consumer name]", partner_name: "Partner Bank", partner_nmlsr_id: "000000", mlo_name: "[MLO of record]", mlo_nmlsr_id: "123456", prequal_id: "PQ-2026-10-15-001", basis: "soft_pull", soft_inquiry: true,
  transaction_intent: "purchase", has_amount_range: true, amount_low_cents: 38_000_000n, amount_high_cents: 41_200_000n, is_preapproval: false, is_commitment: false, hmda_preapproval_program: false, condition_count: 4,
  general_conditions: ["a full application and the documentation the lender regularly obtains", "verification of income, assets and credit", "an acceptable property, appraisal and title", "program eligibility at the time of application"] };

// ------------------------------------------------------------------ NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER (20.4 gate; the stand-alone statement)
export const QUOTE_DISCLAIMER_STATEMENT = "Your actual rate, payment, and costs could be higher. Get an official Loan Estimate before choosing a loan.";
export const QUOTE_DISCLAIMER_SOURCE = `{{#block "disclaimer" page=1 y=0.02 pt=12 bold}}${QUOTE_DISCLAIMER_STATEMENT}{{/block}}
{{#block "body" page=1 y=0.08 pt=11}}This written estimate (reference {{estimate_reference}}) was prepared {{date prepared_on}} by {{partner_name}}, with Supermortgage operating for {{partner_name}}. It is an estimate, not a Loan Estimate and not a commitment to lend.{{/block}}`;
export const QUOTE_DISCLAIMER_RULES: ContentRule[] = [
  R("e2ii-statement-verbatim", "12 CFR 1026.19(e)(2)(ii)", "presence", "Your actual rate, payment, and costs could be higher\\. Get an official Loan Estimate before choosing a loan\\.", "the statement verbatim"),
  R("e2ii-top-of-page-12pt", "12 CFR 1026.19(e)(2)(ii): at the top of the front of the first page in a font size no smaller than 12-point", "layout", "disclaimer", "top of page 1, ≥ 12 pt", { layout: { page: 1, maxYFraction: 0.05, minPt: 12 } }),
  R("estimate-not-le", "12 CFR 1026.19(e)(2)(ii); 1026.17(c)(2)(i)", "presence", "It is an estimate, not a Loan Estimate and not a commitment to lend", "estimate / not an LE / not a commitment"),
  R("no-h24-headings", "12 CFR 1026.19(e)(2)(ii): not substantially similar to form H-24", "absence", "(Projected Payments|Costs at Closing|Calculating Cash to Close|Services You Can(not)? Shop For)", "no H-24 section headings"),
  R("reference", "20.4 rule 7: every written quote carries the disclaimer notice id", "data_equality", "estimate_reference", "the estimate reference is carried", { predicate: present("estimate_reference", "prepared_on") }),
  R("partner-named", "20.3 capacity", "presence", "Supermortgage operating for .+", "partner named; SM as operator"),
];
export const QUOTE_DISCLAIMER_SAMPLE = { estimate_reference: "Q-2026-10-05-001", prepared_on: "2026-10-05", partner_name: "Partner Bank" };

// ------------------------------------------------------------------ NTC_CO_SB26_189_ADMT_NOTICE (C.R.S. 6-1-1704; 20.3 triggers pre_use, 21.6 embeds adverse_outcome_explanation)
export const CO_ADMT_SOURCE = `{{#block "heading" page=1 y=0.05 pt=13 bold}}COLORADO NOTICE ABOUT AUTOMATED DECISION-MAKING TECHNOLOGY{{/block}}
{{#block "pre_use" page=1 y=0.1 pt=11}}{{#if is_pre_use}}{{partner_name}} uses automated decision-making technology in decisions about your loan; here's how to get more information: {{public_notice_url}}. You may ask for the information described in the public notice, including the categories of data the technology uses and how a person can review a decision, by {{information_request_procedure}}.{{/if}}{{/block}}
{{#block "adverse" page=1 y=0.3 pt=11}}{{#if is_adverse_explanation}}Decision: {{decision_description}}. Role of the technology: {{admt_role_description}}. Technology: {{admt_name}}, version {{admt_version}}, developed by {{admt_developer}}. Categories of data used: {{#each data_categories}}{{this}}; {{/each}}{{/if}}{{/block}}
{{#block "rights" page=1 y=0.55 pt=11}}{{#if is_adverse_explanation}}You may request human review and reconsideration of this decision by a different reviewer, and you may ask to correct any inaccurate personal data the technology used: {{human_review_instructions}} {{correction_instructions}}{{/if}}{{/block}}
{{#block "body" page=1 y=0.8 pt=11}}Provided by {{partner_name}}, with Supermortgage operating for {{partner_name}}, under Colorado law (C.R.S. 6-1-1704). {{#if decided_on}}Decision date {{date decided_on}}.{{/if}}{{/block}}`;
export const CO_ADMT_RULES: ContentRule[] = [
  R("variant", "C.R.S. 6-1-1704(1) (pre-use) / 6-1-1704(3) (adverse outcome)", "data_equality", "variant", "variant is pre_use or adverse_outcome_explanation", { predicate: { in: [{ var: "variant" }, ["pre_use", "adverse_outcome_explanation"]] } }),
  R("pre-use-line", "C.R.S. 6-1-1704(1): a clear and conspicuous notice that the deployer used or will use a covered ADMT, and instructions on how to obtain the additional information", "conditional", "public_notice_url", "the point-of-interaction line with the public notice URL and the information-request instructions", { when: { "==": [{ var: "variant" }, "pre_use"] }, predicate: { and: [{ present: "public_notice_url" }, { present: "information_request_procedure" }, { "==": [{ var: "is_pre_use" }, true] }] } }),
  R("pre-use-text", "C.R.S. 6-1-1704(1); 20.3 worked example 4", "conditional", "is_pre_use", "the line names the partner, the technology and how to get more information", { when: { "==": [{ var: "variant" }, "pre_use"] }, predicate: { and: [{ matches: ["public_notice_url", "^https?://"] }, { present: "partner_name" }] } }),
  R("pre-use-rendered", "C.R.S. 6-1-1704(1)", "presence", "uses automated decision-making technology in decisions about your loan; here's how to get more information: \\S+", "the pre-use line rendered"),
  R("adverse-explanation", "C.R.S. 6-1-1704(3): plain-language description of the decision and the role the ADMT played; name, version, developer; data categories", "conditional", "decision_description", "adverse-outcome explanation elements", { when: { "==": [{ var: "variant" }, "adverse_outcome_explanation"] }, predicate: present("decision_description", "admt_role_description", "admt_name", "admt_version", "admt_developer", "data_categories", "human_review_instructions", "correction_instructions") }),
  R("adverse-within-30", "C.R.S. 6-1-1704(3): within thirty days after making the decision", "conditional", "days_since_decision", "sent within 30 days of the decision", { when: { "==": [{ var: "variant" }, "adverse_outcome_explanation"] }, predicate: { "<=": [{ var: "days_since_decision" }, 30] } }),
  R("human-review", "C.R.S. 6-1-1705(1)(a)", "conditional", "human_review_instructions", "human review and correction instructions", { when: { "==": [{ var: "variant" }, "adverse_outcome_explanation"] }, predicate: { and: [{ matches: ["human_review_instructions", "review"] }, { present: "correction_instructions" }] } }),
  R("partner-named", "20.3 capacity; SB 26-189 deployer", "presence", "Provided by .+, with Supermortgage operating for .+, under Colorado law", "partner (deployer) named; SM as operator"),
  R("retention", "C.R.S. 6-1-1703: three years after the consequential decision", "data_equality", "retention_class", "co_admt_3y retention", { predicate: { "==": [{ var: "retention_class" }, "co_admt_3y"] } }),
];
/** Worked example 4: the Denver voice session of Tue Jan 5, 2027 — the pre-use line before any eligibility or pricing output. */
export const CO_ADMT_SAMPLE = { variant: "pre_use", is_pre_use: true, is_adverse_explanation: false, partner_name: "Partner Bank", public_notice_url: "https://example.test/partner/admt-notice", information_request_procedure: "asking this assistant, using your portal, or writing to [Partner address]", retention_class: "co_admt_3y", decided_on: null,
  decision_description: null, admt_role_description: null, admt_name: null, admt_version: null, admt_developer: null, data_categories: [], human_review_instructions: null, correction_instructions: null, days_since_decision: null };

export const VERSIONS_20_3: VersionInput[] = [
  V("NTC_SM_ESIGN_CONSENT", ESIGN_CONSENT_SOURCE, ESIGN_CONSENT_RULES, ESIGN_CONSENT_SAMPLE, "sm.lead_intake.2026.v1", "15 U.S.C. 7001(c)(1)(A)–(D), (c)(6); 7.4 rule 2 demonstration test; 20.3 rule 8 (origination disclosures + servicing communications categories)"),
  V("NTC_SM_PREQUAL_LETTER", PREQUAL_LETTER_SOURCE, PREQUAL_LETTER_RULES, PREQUAL_LETTER_SAMPLE, "sm.lead_intake.2026.v1", "20.3 rule 4 and worked example 2 (Columbus, OH purchase lead, Oct 15, 2026); 12 CFR 1003.2(b)(2); 12 CFR 1014.3(q)/(r)"),
  V("NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER", QUOTE_DISCLAIMER_SOURCE, QUOTE_DISCLAIMER_RULES, QUOTE_DISCLAIMER_SAMPLE, "sm.pricing.2026.v1", "12 CFR 1026.19(e)(2)(ii) (statement at the top of the front of the first page, ≥ 12-point); 20.4 rule 7 (REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE)"),
  V("NTC_CO_SB26_189_ADMT_NOTICE", CO_ADMT_SOURCE, CO_ADMT_RULES, CO_ADMT_SAMPLE, "co.sb26_189.2027.v1", "C.R.S. 6-1-1704(1) pre-use notice (20.3 worked example 4, Jan 5, 2027) and 6-1-1704(3) adverse-outcome explanation (21.6); 6-1-1703 three-year records"),
];
export const OVERRIDES_20_3: Record<string, Partial<NoticeTemplate>> = {
  // Rule 8: the consent statement itself may be shown electronically (it is how consent is obtained); one per applicant.
  NTC_SM_ESIGN_CONSENT: { channelPolicy: "electronic_ok_without_esign", noticeClass: "origination_disclosures", separateDocument: true, mayCombineWith: [], retention: "regb_25m", piiLevel: "medium", citation: "15 U.S.C. 7001(c)(1)(B)–(D), (c)(6); 7.4 (consents, consent_disclosure_versions, ESIGN_7001C_CONSENT_GATE); 20.3 rule 8 — captured per applicant; a chat/voice 'yes' never counts" },
  // Outputs: e-delivery with an active esign consent covering origination_disclosures, else mail/portal download at the consumer's request — a prequal letter is not a required disclosure, so it may be emailed as a PDF on request without the E-SIGN choreography (logged as such).
  NTC_SM_PREQUAL_LETTER: { channelPolicy: "electronic_ok_without_esign", noticeClass: "origination_disclosures", separateDocument: true, mayCombineWith: ["NTC_SM_RATE_QUOTE", "NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER"], retention: "sm_lead_36m", piiLevel: "medium", citation: "20.3 rule 4; 12 CFR 1003.2(b)(2) (not a preapproval program — no HMDA record); 12 CFR 1014.3(q)/(r); retention regb_25m once an application follows, else sm_lead_36m" },
  // 20.4 rule 7: the statement rides on every consumer-specific written estimate before the LE (not an advertisement — comment 2(a)(2)-1.ii).
  NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER: { channelPolicy: "electronic_ok_without_esign", noticeClass: "disclosures", separateDocument: false, mayCombineWith: ["NTC_SM_RATE_QUOTE", "NTC_SM_PREQUAL_LETTER"], retention: "sm_lead_36m", piiLevel: "low", citation: "12 CFR 1026.19(e)(2)(ii) — top of the front of the first page, no smaller than 12-point; 20.4 REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE" },
  // 6-1-1704: the pre-use line is a point-of-interaction utterance/screen with the public notice URL; the adverse-outcome explanation is embedded in 21.6's notices or sent standalone; records kept three years (co_admt_3y).
  NTC_CO_SB26_189_ADMT_NOTICE: { channelPolicy: "electronic_ok_without_esign", noticeClass: "origination_decisions", separateDocument: false, mayCombineWith: ["NTC_REGB_1002_9_ADVERSE_ACTION", "NTC_REGB_1002_9_COUNTEROFFER"], retention: "co_admt_3y", piiLevel: "medium", citation: "C.R.S. 6-1-1704(1) pre-use notice (point-of-interaction line + public notice), 6-1-1704(3) adverse-outcome explanation within 30 days, 6-1-1705 human review/correction, 6-1-1703 records; 21.6 owns the Colorado gates" },
};
