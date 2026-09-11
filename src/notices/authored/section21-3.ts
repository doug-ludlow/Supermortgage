/**
 * §21.3 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * Companion early disclosures (21.3 "Outputs and artifacts" / business rules 3–11 and the state matrix). Every template
 * body is a set of short neutral sentences naming the checklist item the spec cites and interpolating payload fields;
 * organisation names, contact points, agency lists and score factors come from the payload (placeholders in the sample).
 *   NTC_REGX_1024_20_HCL                  — §1024.20(a)(1) list: exactly ten HUD-approved agencies with the eleven interpretive-rule
 *                                           fields, the accompanying-language points, 30-day freshness, zip source (rule 3).
 *   NTC_REGX_1024_6_TOOLKIT               — §1026.19(g) booklet cover record: 2026-08 edition, EN/ES, hash, (g)(2)-only changes (rule 5).
 *   NTC_REGX_1024_15_AFBA                 — §1024.15(b)(1) Appendix D format: relationship, charge range, no-required-use except the
 *                                           (b)(2) trio, acknowledgment, separate document, 5-year retention (rule 8).
 *   NTC_REGB_1002_14_APPRAISAL_NOTICE     — form C-9 text (also satisfies §1026.35(c)(5)); primary applicant (rule 4).
 *   NTC_FCRA_609G_CREDIT_SCORE            — §609(g)(1)(D) notice points + (f) score information, one borrower only (rule 6).
 *   NTC_REGV_1022_74_RBP_EXCEPTION        — model form H-3 elements (A)–(I), bar graph ≥ 6 bars or the statement alternative (rule 6).
 *   NTC_REGZ_1026_19B_ARM_PROGRAM         — §1026.19(b)(2)(i)–(xii) per Fannie Mae SOFR plan; (viii)(B) $10,000 illustration (rule 7).
 *   NTC_REGZ_1026_19B_CHARM               — §1026.19(b)(1) booklet cover record: 2020-06 edition, EN/ES, unaltered (rule 7).
 *   NTC_REGX_1024_33A_SDS                 — §1024.33(a) reverse-mortgage servicing disclosure; scope reverse_only, never issued (rule 11).
 *   State matrix (rule 10): NY 3 NYCRR 38.3, N.J.A.C. 3:1-16.3, M.G.L. c.184 §17B, 7 TAC §57.200, 21 CCR §7114, Cal. Civ. §1632.5,
 *   A.R.S. §6-946(C), Fla. R. 69B-124.013; NTC_TX_50A6_12DAY (26.1's §50(g) notice, carried in 21.3's package).
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const present = (...paths: string[]): Record<string, unknown> => ({ and: paths.map((p) => ({ present: p })) });
const eq = (path: string, value: unknown): Record<string, unknown> => ({ "==": [{ var: path }, value] });
const oneOf = (path: string, values: readonly string[]): Record<string, unknown> => ({ in: [{ var: path }, [...values]] });
const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}";
const MONEY = "\\$[\\d,]+\\.\\d{2}";
const PHONE = "\\d{3}-\\d{4}";
const PARTY = { lender_name: "Partner Lender", lender_nmlsr_id: "123456", lender_phone: "555-0100", applicant_name: "Alex Borrower", application_id: "APP-21-3-0001", property_address: "Property Address 1" };

// ------------------------------------------------------------------ NTC_REGX_1024_20_HCL (rule 3; 80 FR 22091)
const HCL_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Homeownership Counseling Organizations{{/block}}
{{#block "intro" page=1 y=0.09 pt=11}}Prepared {{date prepared_on}} for {{applicant_name}}, application {{application_id}}. This list was generated from HUD data obtained on {{date hud_snapshot_date}} for zip code {{zip_used}} ({{zip_source_label}}). It shows the {{agency_count}} HUD-approved housing counseling agencies closest to that zip code.{{/block}}
{{#block "agencies" page=1 y=0.16 pt=10}}{{#each agencies}}{{@index}}. Agency name: {{name}}. Phone: {{phone}}. Address: {{street}}{{#if street2}}, {{street2}}{{/if}}, {{city}}, {{state}} {{zip}}. Website: {{website}}. Email: {{email}}. Services: {{services}}. Languages: {{languages}}. {{/each}}{{/block}}
{{#block "language" page=2 y=0.05 pt=11}}The counseling agencies on this list are approved by the U.S. Department of Housing and Urban Development (HUD). They can offer independent advice about whether a particular set of mortgage loan terms is a good fit based on your objectives and circumstances, often at little or no cost to you. This list shows you several approved agencies in your area. You can find other approved counseling agencies through the Consumer Financial Protection Bureau (CFPB) website or by calling the CFPB at {{cfpb_phone}}. You can also access a list of nationwide HUD-approved counseling intermediaries from HUD.{{/block}}`;
const HCL_RULES: ContentRule[] = [
  R("heading", "12 CFR 1024.20(a)(1): clear and conspicuous written list", "layout", "heading", "titled list at the top of page 1", { layout: { page: 1, maxYFraction: 0.06, bold: true } }),
  R("ten-agencies", "80 FR 22091: a list of ten HUD-approved housing counseling agencies; 21.3 guardrail: never fewer than ten", "data_range", "agencies.length", "exactly ten agencies", { range: { min: 10, max: 10 } }),
  R("eleven-fields", "80 FR 22091: agency name, phone, street address, street address continued, city, state, zip, website, email, services, languages", "presence", "Agency name: .+\\. Phone: .+\\. Address: .+, [A-Z]{2} \\d{5}\\. Website: .+\\. Email: .+\\. Services: .+\\. Languages: .+\\.", "the eleven data fields per agency in the interpretive-rule order"),
  R("freshness-30d", "12 CFR 1024.20(a)(1): obtained no earlier than 30 days prior to the time the list is provided; 21.3 rule 3 (hud_snapshot_at)", "data_range", "snapshot_age_days", "HUD data obtained ≤ 30 calendar days before delivery", { range: { min: 0, max: 30 } }),
  R("zip-source", "80 FR 22091; 21.3 rule 3: current-address zip (mailing permitted; property zip only when the current address has no five-digit zip)", "data_equality", "zip_source", "zip source is one of the permitted markers", { predicate: oneOf("zip_source", ["current_address", "mailing_address", "property_address_overseas"]) }),
  R("zip-property-only-overseas", "21.3 guardrail: never generated from the property zip while a current-address zip exists", "conditional", "current_address_zip5", "property zip used only when no current-address zip exists", { when: eq("zip_source", "property_address_overseas"), predicate: { "!": { present: "current_address_zip5" } } }),
  R("zip-five-digit", "80 FR 22091: five-digit zip code", "data_equality", "zip_used", "five-digit zip used for the centroid", { predicate: { matches: ["zip_used", "^\\d{5}$"] } }),
  R("lang-hud-approved", "80 FR 22091 accompanying language: agencies approved by HUD", "presence", "approved by the U\\.S\\. Department of Housing and Urban Development \\(HUD\\)", "HUD approval statement"),
  R("lang-independent-advice", "80 FR 22091 accompanying language: independent advice, often at little or no cost", "presence", "independent advice about whether a particular set of mortgage loan terms is a good fit .* little or no cost to you", "independent-advice and cost statement"),
  R("lang-other-agencies", "80 FR 22091 accompanying language: other approved agencies via the CFPB website or telephone; HUD intermediaries", "presence", "other approved counseling agencies .* \\(CFPB\\) website or by calling the CFPB .* nationwide HUD-approved counseling intermediaries", "CFPB and HUD pointers"),
  R("snapshot-date", "21.3 rule 3: hud_snapshot_at is the 'obtained' time", "presence", `HUD data obtained on ${MONTH}`, "HUD snapshot date shown"),
];
const HCL_AGENCY = (i: number) => ({ name: `Agency ${i}`, phone: "555-0100", street: `Street Address ${i}`, street2: "", city: "Phoenix", state: "AZ", zip: "85018", website: `agency${i}.example`, email: `contact@agency${i}.example`, services: "Pre-purchase counseling; Mortgage delinquency counseling", languages: "English; Spanish" });
const HCL_SAMPLE = { ...PARTY, prepared_on: "2026-10-05", hud_snapshot_date: "2026-10-05", snapshot_age_days: 0, zip_used: "85018", zip_source: "current_address", zip_source_label: "your current address", current_address_zip5: "85018", agency_count: 10, agencies: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(HCL_AGENCY), cfpb_phone: "555-0101" };

// ------------------------------------------------------------------ NTC_REGX_1024_6_TOOLKIT (rule 5; §1026.19(g))
const TOOLKIT_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Your home loan toolkit{{/block}}
{{#block "cover" page=1 y=0.1 pt=11}}This special information booklet is provided by {{lender_name}} (NMLS ID {{lender_nmlsr_id}}, {{lender_phone}}) to {{applicant_name}} for the purchase of {{property_address}}, application {{application_id}}. Edition {{edition}} ({{language_label}}), delivered {{date delivered_on}}. The booklet is the CFPB publication delivered without change; only the cover contact details permitted by the rule differ. Document hash {{asset_sha256}}.{{/block}}`;
const TOOLKIT_RULES: ContentRule[] = [
  R("title", "12 CFR 1026.19(g)(2)(iv): the title is not changed", "presence", "Your home loan toolkit", "booklet title unchanged"),
  R("edition", "21.3 rule 5: edition = the registry's current asset (2026-08)", "data_equality", "edition", "August 2026 edition", { predicate: eq("edition", "2026-08") }),
  R("language", "21.3 rule 5: English always; Spanish courtesy copy when interview_language = es", "data_equality", "language_edition", "language edition en or es", { predicate: oneOf("language_edition", ["en", "es"]) }),
  R("purchase-only", "12 CFR 1026.19(g)(1)(iii): not required for refinances, subordinate liens or reverse mortgages", "data_equality", "transaction_type", "purchase of a 1–4 family residential property", { predicate: { and: [eq("transaction_type", "purchase"), eq("residential_1_4", true)] } }),
  R("unaltered", "12 CFR 1026.19(g)(2); 21.3 guardrail: never alter the Toolkit beyond (g)(2) changes", "data_equality", "altered_beyond_g2", "no changes beyond the four permitted", { predicate: eq("altered_beyond_g2", false) }),
  R("hash", "21.3 integrations: delivered as the CFPB PDF unchanged, hash-verified", "data_equality", "asset_sha256", "SHA-256 of the delivered asset", { predicate: { matches: ["asset_sha256", "^[0-9a-f]{64}$"] } }),
  R("delivered-date", "12 CFR 1026.19(g)(1)(i): delivered or placed in the mail within three business days", "presence", `delivered ${MONTH}`, "delivery date shown"),
];
const TOOLKIT_SAMPLE = { ...PARTY, property_address: "Property Address 2", application_id: "APP-21-3-0002", edition: "2026-08", language_edition: "en", language_label: "English", delivered_on: "2026-10-22", transaction_type: "purchase", residential_1_4: true, altered_beyond_g2: false, asset_sha256: "a".repeat(64) };

// ------------------------------------------------------------------ NTC_REGX_1024_15_AFBA (rule 8; Appendix D)
const AFBA_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Affiliated Business Arrangement Disclosure Statement{{/block}}
{{#block "parties" page=1 y=0.09 pt=11}}To: {{applicant_name}}. From: {{referring_party}}. Property: {{property_address}}. Date: {{date disclosure_date}}. Referral {{referral_id}} for {{service_label}}.{{/block}}
{{#block "relationship" page=1 y=0.16 pt=11}}This is to give you notice that {{referring_party}} has a business relationship with {{provider_name}}. {{relationship_statement}} Because of this relationship, this referral may provide {{referring_party}} a financial or other benefit.{{/block}}
{{#block "charges" page=1 y=0.26 pt=11}}Set forth below is the estimated charge or range of charges for the settlement services listed. You are NOT required to use the listed provider as a condition for settlement of your loan on, or purchase, sale, or refinance of, the subject property.{{#if required_use}} Exception: we require the use of this provider for {{service_label}}, which the rule permits only for an attorney, credit reporting agency or real estate appraiser.{{/if}} {{#each charges}}{{service}}: {{money low_cents}} to {{money high_cents}}. {{/each}}{{/block}}
{{#block "shop" page=1 y=0.4 pt=11}}There are frequently other settlement service providers available with similar services. You are free to shop around to determine that you are receiving the best services and the best rate for these services.{{/block}}
{{#block "ack" page=1 y=0.5 pt=11}}ACKNOWLEDGMENT: I/we have read this disclosure form and understand that {{referring_party}} is referring me/us to purchase the above-described settlement services and may receive a financial or other benefit as the result of this referral. Signature and date.{{/block}}`;
const AFBA_RULES: ContentRule[] = [
  R("heading", "12 CFR 1024.15(b)(1); Appendix D format", "presence", "Affiliated Business Arrangement Disclosure Statement", "Appendix D title"),
  R("relationship", "12 CFR 1024.15(b)(1): the nature of the relationship", "presence", "has a business relationship with .+ Because of this relationship, this referral may provide .+ a financial or other benefit", "nature of the relationship and the benefit statement"),
  R("relationship-kind", "12 U.S.C. 2602(7)–(8); 21.3 data model affiliate_relationships.relationship", "data_equality", "relationship", "affiliate, > 1% ownership or associate", { predicate: oneOf("relationship", ["affiliate", "ownership_gt_1pct", "associate"]) }),
  R("ownership-pct", "12 U.S.C. 2602(7)(A): ownership interest of more than 1 percent", "conditional", "ownership_pct", "ownership above 1% when the relationship is ownership", { when: eq("relationship", "ownership_gt_1pct"), predicate: { ">": [{ var: "ownership_pct" }, 1] } }),
  R("charge-range", "12 CFR 1024.15(b)(1): an estimated charge or range of charges", "presence", `: ${MONEY} to ${MONEY}\\.`, "estimated charge or range per service"),
  R("charges-listed", "12 CFR 1024.15(b)(1)", "data_range", "charges.length", "at least one settlement service with a charge range", { range: { min: 1 } }),
  R("not-required", "12 CFR 1024.15(b)(2); Appendix D: not required to use the provider", "presence", "You are NOT required to use the listed provider as a condition", "no-required-use statement"),
  R("required-use-trio", "12 CFR 1024.15(b)(2): required use only of an attorney, credit reporting agency or real estate appraiser; 21.3 guardrail", "conditional", "service", "required use limited to the three exceptions", { when: eq("required_use", true), predicate: oneOf("service", ["attorney", "credit_reporting_agency", "appraiser"]) }),
  R("shop-around", "Appendix D: free to shop around", "presence", "free to shop around", "shopping statement"),
  R("acknowledgment", "Appendix D acknowledgment block; §1024.15(d): retained 5 years", "presence", "ACKNOWLEDGMENT: .* Signature and date", "acknowledgment with signature"),
  R("timing", "12 CFR 1024.15(b)(1): no later than the time of each referral (or application for a required provider)", "data_equality", "delivered_no_later_than_referral", "delivered at or before the referral", { predicate: eq("delivered_no_later_than_referral", true) }),
];
const AFBA_SAMPLE = { ...PARTY, referring_party: "Partner Lender", provider_name: "Provider 1", referral_id: "REF-0001", service: "title", service_label: "title and settlement services", disclosure_date: "2026-10-05", relationship: "ownership_gt_1pct", ownership_pct: 25, relationship_statement: "Partner Lender owns 25 percent of Provider 1.", required_use: false, delivered_no_later_than_referral: true, charges: [{ service: "Lender's title policy", low_cents: 100_000n, high_cents: 130_000n }, { service: "Settlement agent fee", low_cents: 40_000n, high_cents: 55_000n }] };

// ------------------------------------------------------------------ NTC_REGB_1002_14_APPRAISAL_NOTICE (rule 4; form C-9)
const REGB_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Notice of the Right to Receive a Copy of Appraisals{{/block}}
{{#block "body" page=1 y=0.1 pt=11}}To {{applicant_name}} from {{lender_name}} ({{lender_phone}}), application {{application_id}} received {{date application_received_on}}, property {{property_address}}. We may order an appraisal to determine the property's value and charge you for this appraisal. We will promptly give you a copy of any appraisal, even if your loan does not close. You can pay for an additional appraisal for your own use at your own cost.{{/block}}
{{#block "issued" page=1 y=0.22 pt=11}}This notice is issued {{date issued_on}}{{#if standalone_reason}} because {{standalone_reason}}{{/if}}. It is addressed to the primary applicant and, by policy, to every applicant.{{/block}}`;
const REGB_RULES: ContentRule[] = [
  R("c9-order", "12 CFR 1002.14(a)(2); Appendix C form C-9 sentence 1", "presence", "We may order an appraisal to determine the property's value and charge you for this appraisal\\.", "C-9 sentence 1"),
  R("c9-copy", "12 CFR 1002.14(a)(2); form C-9 sentence 2 (also 12 CFR 1026.35(c)(5)(i))", "presence", "We will promptly give you a copy of any appraisal, even if your loan does not close\\.", "C-9 sentence 2 — satisfies the HPML statement too"),
  R("c9-additional", "form C-9 sentence 3", "presence", "You can pay for an additional appraisal for your own use at your own cost\\.", "C-9 sentence 3"),
  R("first-lien-dwelling", "12 CFR 1002.14(a)(2): credit to be secured by a first lien on a dwelling", "data_equality", "first_lien_dwelling", "first lien on a dwelling", { predicate: eq("first_lien_dwelling", true) }),
  R("primary-applicant", "comment 14(a)(1); 21.3 rule 4: primary applicant = borrower 1", "data_equality", "addressed_to_primary_applicant", "notice to the primary applicant", { predicate: eq("addressed_to_primary_applicant", true) }),
  R("standalone-only-when-le-late", "21.3 rule 4: standalone only when the LE cannot meet the window", "data_equality", "standalone_reason", "reason the LE did not satisfy the window", { predicate: { present: "standalone_reason" } }),
  R("received-date", "21.3 rule 2: anchored on application_received_at", "presence", `received ${MONTH}`, "Reg B application date shown"),
];
const REGB_SAMPLE = { ...PARTY, application_received_on: "2026-10-05", issued_on: "2026-10-08", first_lien_dwelling: true, addressed_to_primary_applicant: true, standalone_reason: "the Loan Estimate will not be delivered within the notice period" };

// ------------------------------------------------------------------ NTC_FCRA_609G_CREDIT_SCORE (rule 6; 15 U.S.C. 1681g(g))
const FCRA_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}NOTICE TO THE HOME LOAN APPLICANT{{/block}}
{{#block "notice" page=1 y=0.09 pt=11}}In connection with your application for a home loan, the lender must disclose to you the score that a consumer reporting agency distributed to users and the lender used in connection with your home loan, and the key factors affecting your credit scores. The credit score is a computer generated summary calculated at the time of the request and based on information that a consumer reporting agency or lender has on file. Scores can change over time as the information changes. Because the score is based on information in your credit history, it is very important that you review the credit-related information to make sure it is accurate. You may obtain a copy of your credit report and dispute any inaccurate information by contacting the consumer reporting agency at the address and telephone number shown below. If you have questions about the terms of the loan, contact the lender: {{lender_name}}, {{lender_phone}}.{{/block}}
{{#block "scores" page=1 y=0.4 pt=11}}Borrower: {{borrower_name}}. {{#each scores}}Score {{score}}{{#if representative}} (score used){{/if}} from {{cra}} ({{model}}), range {{range_low}} to {{range_high}}, dated {{date score_date}}. Key factors: {{#each key_factors}}{{this}}; {{/each}}{{#if inquiries_factor}}Number of inquiries is a key factor. {{/if}}Contact {{cra}} at {{cra_phone}}, {{cra_address}}. {{/each}}{{/block}}`;
const FCRA_RULES: ContentRule[] = [
  R("heading", "15 U.S.C. 1681g(g)(1)(D): 'Notice to the home loan applicant'", "presence", "NOTICE TO THE HOME LOAN APPLICANT", "statutory heading"),
  R("must-disclose", "15 U.S.C. 1681g(g)(1)(D): the lender must disclose the score and key factors", "presence", "the lender must disclose to you the score .* and the key factors affecting your credit scores", "disclosure statement"),
  R("computer-generated", "15 U.S.C. 1681g(g)(1)(D): computer generated summary at the time of the request", "presence", "computer generated summary calculated at the time of the request", "score-nature statement"),
  R("obtain-dispute", "15 U.S.C. 1681g(g)(1)(D): right to obtain the report and dispute inaccuracies through the CRA", "presence", "obtain a copy of your credit report and dispute any inaccurate information by contacting the consumer reporting agency", "obtain-and-dispute statement"),
  R("lender-contact", "15 U.S.C. 1681g(g)(1)(D): lender contact for questions about the loan", "presence", `contact the lender: .+, ${PHONE}`, "lender contact point"),
  R("score-info", "15 U.S.C. 1681g(f)/(g)(1)(B): score, range, date and CRA", "presence", `Score \\d{3}.* from .+ \\(.+\\), range \\d{3} to \\d{3}, dated ${MONTH}`, "score with range, date and CRA"),
  R("key-factors", "15 U.S.C. 1681g(f)(1)(C): up to four key factors, five when inquiries are a factor", "presence", "Key factors: (.+; ){1,5}", "key factors listed"),
  R("key-factor-cap", "15 U.S.C. 1681g(f)(1)(C)", "data_range", "max_key_factor_count", "no more than five key factors on any score", { range: { min: 1, max: 5 } }),
  R("key-factor-cap-no-inquiries", "15 U.S.C. 1681g(f)(1)(C): four unless inquiries are a factor", "conditional", "max_key_factor_count", "no more than four key factors when inquiries are not a factor", { when: eq("any_inquiries_factor", false), predicate: { "<=": [{ var: "max_key_factor_count" }, 4] } }),
  R("cra-contact", "15 U.S.C. 1681g(f)(1)(E); (g)(1)(D): CRA contact information", "presence", `Contact .+ at ${PHONE}, .+\\.`, "CRA telephone and address"),
  R("score-used-flag", "21.3 rule 6: the representative/applicable score flagged", "presence", "\\(score used\\)", "applicable score flagged"),
  R("at-least-one-score", "15 U.S.C. 1681g(g)(1)(A): a credit score was used", "data_range", "scores.length", "every score obtained for this borrower", { range: { min: 1 } }),
  R("one-borrower", "12 CFR 1022.75(c); 21.3 guardrail: never include another borrower's score", "data_equality", "other_borrower_data_included", "only this borrower's data", { predicate: eq("other_borrower_data_included", false) }),
];
const FCRA_SCORE = (cra: string, score: number, representative: boolean) => ({ cra, model: "Classic FICO", score, representative, range_low: 300, range_high: 850, score_date: "2026-10-05", key_factors: ["Factor 1", "Factor 2", "Factor 3", "Factor 4"], inquiries_factor: false, cra_phone: "555-0102", cra_address: "Agency Address 1" });
const FCRA_SAMPLE = { ...PARTY, borrower_name: "Alex Borrower", scores: [FCRA_SCORE("Agency 1", 742, false), FCRA_SCORE("Agency 2", 751, true), FCRA_SCORE("Agency 3", 760, false)], max_key_factor_count: 4, any_inquiries_factor: false, other_borrower_data_included: false };

// ------------------------------------------------------------------ NTC_REGV_1022_74_RBP_EXCEPTION (rule 6; model form H-3)
const REGV_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Your Credit Score and the Price You Pay for Credit{{/block}}
{{#block "score" page=1 y=0.09 pt=11}}Borrower: {{borrower_name}}. Your credit score: {{score}} from {{cra}} ({{model}}), range {{range_low}} to {{range_high}}, dated {{date score_date}}. Key factors that adversely affected your credit score: {{#each key_factors}}{{this}}; {{/each}}{{/block}}
{{#block "what" page=1 y=0.2 pt=11}}What you should know about credit scores. A consumer report (or credit report) is a record of your credit history. A credit score is a number that takes into account information in a consumer report. Your credit score can affect whether you can obtain credit and what the cost of that credit will be.{{/block}}
{{#block "compare" page=1 y=0.32 pt=11}}How your score compares to the scores of other consumers. {{#if has_distribution}}Bar graph of scores under the same model: {{#each distribution}}{{range}}: {{pct}} percent of consumers; {{/each}}{{else}}{{comparison_statement}}{{/if}}{{/block}}
{{#block "rights" page=1 y=0.5 pt=11}}Checking your credit report. You are encouraged to verify the accuracy of the information contained in your consumer report. Federal law gives you the right to obtain copies of your consumer reports directly from the consumer reporting agencies. You may obtain a free copy of your report once a year from each nationwide consumer reporting agency through the centralized source at {{centralized_source_phone}}. For more information about credit reports and your rights under Federal law, contact the Consumer Financial Protection Bureau.{{/block}}`;
const REGV_RULES: ContentRule[] = [
  R("a-record", "12 CFR 1022.74(d)(1)(ii)(A)", "presence", "A consumer report \\(or credit report\\) is a record of your credit history", "(A) consumer report statement"),
  R("b-number", "12 CFR 1022.74(d)(1)(ii)(B)", "presence", "A credit score is a number that takes into account information in a consumer report", "(B) credit score statement"),
  R("c-affect", "12 CFR 1022.74(d)(1)(ii)(C)", "presence", "can affect whether you can obtain credit and what the cost of that credit will be", "(C) effect statement"),
  R("d-609g-info", "12 CFR 1022.74(d)(1)(ii)(D): the §609(g) information", "presence", `Your credit score: \\d{3} from .+ \\(.+\\), range \\d{3} to \\d{3}, dated ${MONTH}\\. Key factors .*: (.+; )+`, "(D) score, range, date, CRA and key factors"),
  R("e-graph", "12 CFR 1022.74(d)(1)(ii)(E): bar graph with a minimum of six bars", "data_range", "distribution.length", "(E) at least six bars", { when: eq("has_distribution", true), range: { min: 6 } }),
  R("e-graph-text", "12 CFR 1022.74(d)(1)(ii)(E)", "presence", "Bar graph of scores under the same model: (.+: \\d+ percent of consumers; ){6,}", "(E) bars rendered", { when: eq("has_distribution", true) }),
  R("e-statement-alt", "12 CFR 1022.74(d)(1)(ii)(E): statement alternative when no distribution data", "conditional", "comparison_statement", "(E) comparison statement when the CRA supplies no distribution", { when: eq("has_distribution", false), predicate: { present: "comparison_statement" } }),
  R("f-verify", "12 CFR 1022.74(d)(1)(ii)(F)", "presence", "encouraged to verify the accuracy of the information contained in your consumer report", "(F) verify statement"),
  R("g-right", "12 CFR 1022.74(d)(1)(ii)(G)", "presence", "Federal law gives you the right to obtain copies of your consumer reports directly", "(G) right to copies"),
  R("h-centralized", "12 CFR 1022.74(d)(1)(ii)(H): centralized source for free annual reports", "presence", `free copy of your report once a year .* centralized source at ${PHONE}`, "(H) centralized source"),
  R("i-bureau", "12 CFR 1022.74(d)(1)(ii)(I)", "presence", "contact the Consumer Financial Protection Bureau", "(I) Bureau reference"),
  R("one-consumer", "12 CFR 1022.75(c); 1022.74(d)(4): one notice per consumer with only that consumer's score", "data_equality", "other_borrower_data_included", "only this consumer's score", { predicate: eq("other_borrower_data_included", false) }),
  R("with-609g", "12 CFR 1022.74(d)(3): provided at the time of the §609(g) disclosure and before consummation", "data_equality", "delivered_with_609g", "delivered with the §609(g) notice", { predicate: eq("delivered_with_609g", true) }),
];
const REGV_SAMPLE = { ...PARTY, borrower_name: "Alex Borrower", score: 751, cra: "Agency 2", model: "Classic FICO", range_low: 300, range_high: 850, score_date: "2026-10-05", key_factors: ["Factor 1", "Factor 2", "Factor 3", "Factor 4"], has_distribution: true, distribution: [{ range: "300-499", pct: 4 }, { range: "500-549", pct: 6 }, { range: "550-599", pct: 8 }, { range: "600-649", pct: 10 }, { range: "650-699", pct: 13 }, { range: "700-749", pct: 17 }, { range: "750-799", pct: 24 }, { range: "800-850", pct: 18 }], comparison_statement: "", centralized_source_phone: "555-0103", other_borrower_data_included: false, delivered_with_609g: true };

// ------------------------------------------------------------------ NTC_REGZ_1026_19B_ARM_PROGRAM (rule 7; §1026.19(b)(2)(i)–(xii))
const ARM_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Adjustable-Rate Mortgage Program Disclosure: {{plan_label}} (Plan {{fnma_plan_number}}){{/block}}
{{#block "i_change" page=1 y=0.09 pt=11}}This disclosure describes the features of the adjustable-rate mortgage program you are considering. The interest rate and the payment on this loan can change.{{/block}}
{{#block "ii_index" page=1 y=0.13 pt=11}}Index: {{index_name}}, as published by {{index_source}}. Information about the index is available from {{index_source}}.{{/block}}
{{#block "iii_how" page=1 y=0.18 pt=11}}How the rate and payment are determined: the new interest rate equals the index value available {{lookback_days}} days before the change date plus a margin, rounded to the nearest one-eighth of one percent, subject to the limits below. The payment is then recalculated to repay the remaining balance over the remaining term at the new rate.{{/block}}
{{#block "iv_ask" page=1 y=0.25 pt=11}}Ask us about the current margin value and the current interest rate.{{/block}}
{{#block "v_discount" page=1 y=0.28 pt=11}}{{#if discounted}}The initial interest rate is discounted and is not based on the index plus the margin. Ask us about the amount of the interest rate discount.{{else}}The initial interest rate may be discounted or may include a premium. Ask us whether the initial rate is discounted and about the amount of any discount.{{/if}}{{/block}}
{{#block "vi_frequency" page=1 y=0.33 pt=11}}Frequency of changes: the interest rate is fixed for the first {{initial_fixed_months}} months and can change every {{adjustment_period_months}} months after that. The payment can change at the same times.{{/block}}
{{#block "vii_limits" page=1 y=0.38 pt=11}}Limits: the rate cannot increase or decrease by more than {{cap_first_pct}} percentage points at the first change or {{cap_subsequent_pct}} percentage points at any later change, and cannot increase by more than {{cap_lifetime_pct}} percentage points over the initial rate during the life of the loan. The loan has no negative amortization and no interest rate carryover.{{/block}}
{{#block "viii_example" page=1 y=0.46 pt=11}}Example on a $10,000 loan at the initial rate of {{initial_rate_pct}} percent in effect as of {{illustration_as_of}}: the initial monthly principal and interest payment is {{money initial_payment_cents}}. The maximum interest rate is {{max_rate_pct}} percent, which could be reached at the earliest {{months_to_max}} months after origination, and the maximum monthly payment would be {{money max_payment_cents}}. The periodic payment may increase or decrease substantially depending on changes in the rate.{{/block}}
{{#block "ix_calc" page=1 y=0.56 pt=11}}To estimate the payments for the amount you plan to borrow, divide your loan amount by 10,000 and multiply the payments shown above by that number.{{/block}}
{{#block "x_demand" page=1 y=0.6 pt=11}}This loan program does not contain a demand feature.{{/block}}
{{#block "xi_notices" page=1 y=0.63 pt=11}}Notices of adjustments: you will receive a notice of the new rate, the new payment, the index value, the margin and the date of the change at least {{first_notice_days_min}} days before the first payment at a new rate and at least {{later_notice_days_min}} days before later payment changes.{{/block}}
{{#block "xii_other" page=1 y=0.68 pt=11}}Disclosure forms are available for our other variable-rate loan programs.{{/block}}`;
const ARM_RULES: ContentRule[] = [
  R("i", "12 CFR 1026.19(b)(2)(i)", "presence", "The interest rate and the payment on this loan can change", "(i) rate/payment can change"),
  R("ii", "12 CFR 1026.19(b)(2)(ii); comment 19(b)(2)(ii)-1", "presence", "Index: .+, as published by .+\\. Information about the index is available from", "(ii) index and source of information"),
  R("ii-sofr", "Fannie Mae B2-1.4-02; 21.3 arm_programs.index = sofr_30d_avg", "data_equality", "index_code", "30-day Average SOFR index", { predicate: { and: [eq("index_code", "sofr_30d_avg"), { present: "index_source" }] } }),
  R("iii", "12 CFR 1026.19(b)(2)(iii)", "presence", "index value available \\d+ days before the change date plus a margin, rounded to the nearest one-eighth", "(iii) how the rate is determined"),
  R("iii-lookback", "Fannie Mae B2-1.4-02: 45-day lookback; 21.3 arm_programs.lookback_days", "data_equality", "lookback_days", "45-day lookback", { predicate: eq("lookback_days", 45) }),
  R("iv", "12 CFR 1026.19(b)(2)(iv)", "presence", "Ask us about the current margin value and the current interest rate", "(iv) ask about margin and rate"),
  R("v", "12 CFR 1026.19(b)(2)(v)", "presence", "(Ask us about the amount of the interest rate discount|Ask us whether the initial rate is discounted)", "(v) discount statement"),
  R("vi", "12 CFR 1026.19(b)(2)(vi)", "presence", "fixed for the first \\d+ months and can change every \\d+ months", "(vi) frequency of changes"),
  R("vii", "12 CFR 1026.19(b)(2)(vii)", "presence", "cannot increase or decrease by more than .+ at the first change or .+ at any later change, and cannot increase by more than .+ over the initial rate", "(vii) rate limits, no negative amortization"),
  R("vii-caps", "Fannie Mae Standard ARM Plan Matrix caps", "data_equality", "cap_first_pct,cap_subsequent_pct,cap_lifetime_pct", "first / subsequent / lifetime caps present", { predicate: present("cap_first_pct", "cap_subsequent_pct", "cap_lifetime_pct") }),
  R("viii-b", "12 CFR 1026.19(b)(2)(viii)(B): maximum rate and payment for a $10,000 loan at the initial rate as of an identified month and year", "presence", `Example on a \\$10,000 loan at the initial rate of [\\d.]+ percent in effect as of [A-Z][a-z]+ \\d{4}: the initial monthly principal and interest payment is ${MONEY}\\. The maximum interest rate is [\\d.]+ percent, .* maximum monthly payment would be ${MONEY}`, "(viii)(B) illustration"),
  R("viii-b-substantially", "12 CFR 1026.19(b)(2)(viii)(B)", "presence", "periodic payment may increase or decrease substantially depending on changes in the rate", "(viii)(B) closing statement"),
  R("viii-b-worked", "21.3 rule 7 worked arithmetic: Plan 4927 at 5.875% → $59.15; maximum 10.875% at 78 months", "conditional", "initial_payment_cents", "worked figures for the 5/6 SOFR illustration", { when: { and: [eq("fnma_plan_number", "4927"), eq("initial_rate_pct", "5.875")] }, predicate: { and: [eq("initial_payment_cents", 5915), eq("max_rate_pct", "10.875"), eq("months_to_max", 78)] } }),
  R("ix", "12 CFR 1026.19(b)(2)(ix)", "presence", "divide your loan amount by 10,000 and multiply", "(ix) how to calculate payments"),
  R("x", "12 CFR 1026.19(b)(2)(x)", "presence", "does not contain a demand feature", "(x) demand feature statement"),
  R("xi", "12 CFR 1026.19(b)(2)(xi); §1026.20(c)/(d)", "presence", "notice of the new rate, the new payment, the index value, the margin and the date of the change at least \\d+ days before", "(xi) adjustment notice content and timing"),
  R("xii", "12 CFR 1026.19(b)(2)(xii)", "presence", "Disclosure forms are available for our other variable-rate loan programs", "(xii) other programs"),
  R("plan", "21.3 arm_programs.fnma_plan_number", "data_equality", "fnma_plan_number", "a Fannie Mae SOFR plan", { predicate: oneOf("fnma_plan_number", ["4926", "4927", "4928", "4929"]) }),
  R("no-consumer-rate", "SAFE Act App. A (b)(2)(i); 21.3 guardrail: never present consumer-specific ARM rates", "absence", "(your (interest )?rate (is|will be)|rate lock|locked at)", "general program information only"),
];
const ARM_SAMPLE = { plan_label: "5/6 SOFR ARM", fnma_plan_number: "4927", index_name: "30-day Average SOFR", index_code: "sofr_30d_avg", index_source: "the Federal Reserve Bank of New York", lookback_days: 45, discounted: false, initial_fixed_months: 60, adjustment_period_months: 6, cap_first_pct: "2", cap_subsequent_pct: "1", cap_lifetime_pct: "5", initial_rate_pct: "5.875", illustration_as_of: "October 2026", initial_payment_cents: 5_915n, max_rate_pct: "10.875", months_to_max: 78, max_payment_cents: 9_000n, first_notice_days_min: 210, later_notice_days_min: 60 };

// ------------------------------------------------------------------ NTC_REGZ_1026_19B_CHARM (rule 7; §1026.19(b)(1))
const CHARM_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Consumer Handbook on Adjustable-Rate Mortgages{{/block}}
{{#block "cover" page=1 y=0.1 pt=11}}This booklet is provided by {{lender_name}} ({{lender_phone}}) to {{applicant_name}}, application {{application_id}}, with the program disclosure for Plan {{fnma_plan_number}}. Edition {{edition}} ({{language_label}}), delivered {{date delivered_on}} by {{channel}}. The booklet is the CFPB publication delivered without change. Document hash {{asset_sha256}}.{{/block}}`;
const CHARM_RULES: ContentRule[] = [
  R("title", "12 CFR 1026.19(b)(1): the booklet titled Consumer Handbook on Adjustable Rate Mortgages", "presence", "Consumer Handbook on Adjustable-?Rate Mortgages", "booklet title"),
  R("edition", "21.3 rule 7: June 2020 edition", "data_equality", "edition", "2020-06 edition", { predicate: eq("edition", "2020-06") }),
  R("language", "CFPB publications: English and Spanish", "data_equality", "language_edition", "en or es", { predicate: oneOf("language_edition", ["en", "es"]) }),
  R("with-program", "12 CFR 1026.19(b)(2); 21.3 gate: CHARM and the program disclosure together", "data_equality", "fnma_plan_number", "delivered with the program disclosure for the plan of interest", { predicate: { and: [eq("delivered_with_program_disclosure", true), oneOf("fnma_plan_number", ["4926", "4927", "4928", "4929"])] } }),
  R("unaltered", "21.3 guardrail: never alter the CHARM booklet", "data_equality", "altered", "unaltered CFPB PDF", { predicate: { and: [eq("altered", false), { matches: ["asset_sha256", "^[0-9a-f]{64}$"] }] } }),
  R("channel", "12 CFR 1026.19(b)/(c): on/with the application, electronically or in person, or mailed within three business days for telephone applications", "data_equality", "channel", "delivery channel recorded", { predicate: oneOf("channel", ["electronic", "in_person", "mail"]) }),
];
const CHARM_SAMPLE = { ...PARTY, application_id: "APP-21-3-0002", fnma_plan_number: "4928", edition: "2020-06", language_edition: "en", language_label: "English", delivered_on: "2026-10-19", channel: "electronic", delivered_with_program_disclosure: true, altered: false, asset_sha256: "b".repeat(64) };

// ------------------------------------------------------------------ NTC_REGX_1024_33A_SDS (rule 11; reverse only, never issued)
const SDS_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Servicing Disclosure Statement{{/block}}
{{#block "body" page=1 y=0.1 pt=11}}To {{applicant_name}} from {{lender_name}} ({{lender_phone}}), reverse mortgage application {{application_id}} received {{date application_received_on}}. {{#if may_transfer}}We may assign, sell or transfer the servicing of your loan while the loan is outstanding.{{else}}We do not intend to assign, sell or transfer the servicing of your loan while the loan is outstanding.{{/if}} Servicing means collecting your payments and handling your account.{{/block}}`;
const SDS_RULES: ContentRule[] = [
  R("heading", "12 CFR 1024.33(a)", "presence", "Servicing Disclosure Statement", "titled statement"),
  R("transfer-statement", "12 CFR 1024.33(a): whether servicing may be assigned, sold or transferred", "presence", "(may|do not intend to) assign, sell or transfer the servicing of your loan", "servicing transfer statement"),
  R("reverse-only", "12 CFR 1024.33(a): reverse mortgage transactions; 21.3 rule 11 / guardrail: never issued on a forward loan", "data_equality", "product_type", "reverse mortgage only", { predicate: { and: [eq("product_type", "reverse_mortgage"), eq("scope", "reverse_only")] } }),
];
const SDS_SAMPLE = { ...PARTY, application_id: "APP-21-3-REV", application_received_on: "2026-10-05", may_transfer: true, product_type: "reverse_mortgage", scope: "reverse_only" };

// ------------------------------------------------------------------ NTC_NY_3NYCRR_38_3_PREAPP_DISCLOSURE (rule 10; worked example 3(a))
const NY_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}New York Pre-Application Disclosure{{/block}}
{{#block "intro" page=1 y=0.09 pt=11}}From {{lender_name}} (NMLS ID {{lender_nmlsr_id}}, {{lender_phone}}) to {{applicant_name}}, property {{property_address}}. This disclosure is given before we take your application and before any fee is collected.{{/block}}
{{#block "fees" page=1 y=0.16 pt=11}}Fees and refund terms: {{#each fees}}{{name}} {{money amount_cents}}, {{refund_terms}}. {{/each}}No fee other than an application fee, credit report fee and property appraisal fee will be collected before you accept a commitment.{{/block}}
{{#block "terms" page=1 y=0.3 pt=11}}Your loan may be assigned to a third party. Prepayment penalty: {{prepayment_penalty_statement}} Discount points: {{discount_points_statement}}{{/block}}
{{#block "confirm" page=1 y=0.4 pt=11}}Confirmation: {{#if electronic}}click the required confirm button or sign electronically to confirm receipt{{else}}sign and return a copy of this disclosure to confirm receipt{{/if}}.{{/block}}`;
const NY_RULES: ContentRule[] = [
  R("pre-application", "3 NYCRR 38.3: prior to taking an application or collecting any fee", "data_equality", "delivered_before_application", "given before the application and any fee", { predicate: eq("delivered_before_application", true) }),
  R("fee-amounts", "3 NYCRR 38.3: fee amounts and refund terms", "presence", `Fees and refund terms: (.+ ${MONEY}, .+\\. )+`, "each fee with amount and refund terms"),
  R("fees-listed", "3 NYCRR 38.3", "data_range", "fees.length", "at least one fee described", { range: { min: 1 } }),
  R("fee-limit", "3 NYCRR 38.3: no fee other than application, credit report and appraisal fees before commitment acceptance", "presence", "No fee other than an application fee, credit report fee and property appraisal fee", "fee limitation statement"),
  R("assignment", "3 NYCRR 38.3: the loan may be assigned to a third party", "presence", "may be assigned to a third party", "assignment statement"),
  R("prepayment", "3 NYCRR 38.3: prepayment penalties", "presence", "Prepayment penalty: .+", "prepayment penalty statement"),
  R("points", "3 NYCRR 38.3: discount points statement", "presence", "Discount points: .+", "discount points statement"),
  R("confirmation", "3 NYCRR 38.3: e-signature / required confirm button or a signed copy", "presence", "(confirm button|sign electronically|sign and return a copy)", "confirmation mechanism"),
  R("ack-method", "21.3 timers: NY gate opens on state_notice.acknowledged", "data_equality", "acknowledgment_method", "confirm button, e-signature or signed copy", { predicate: oneOf("acknowledgment_method", ["confirm_button", "e_signature", "signed_copy"]) }),
];
const NY_SAMPLE = { ...PARTY, property_address: "Property Address 3", delivered_before_application: true, electronic: true, acknowledgment_method: "confirm_button", fees: [{ name: "Credit report fee", amount_cents: 7_500n, refund_terms: "refundable if the loan does not close" }, { name: "Appraisal fee", amount_cents: 65_000n, refund_terms: "not refundable once the appraisal is ordered" }], prepayment_penalty_statement: "This loan has no prepayment penalty.", discount_points_statement: "Discount points, if any, are stated on your Loan Estimate and may be paid to lower the interest rate." };

// ------------------------------------------------------------------ NTC_NJ_3_1_16_3_APPLICATION_DISCLOSURE (rule 10; worked example 3(e))
const NJ_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}New Jersey Application Disclosure{{/block}}
{{#block "intro" page=1 y=0.09 pt=11}}From {{lender_name}} (NMLS ID {{lender_nmlsr_id}}) to {{applicant_name}}, property {{property_address}}. This disclosure is given before any application, credit report, appraisal or third-party reimbursement fee is accepted.{{/block}}
{{#block "fees" page=1 y=0.16 pt=11}}Fees: {{#each fees}}{{name}}: {{description}}; amount {{money amount_cents}}; {{#if refundable}}refundable {{refund_conditions}}{{else}}not refundable{{/if}}. {{/each}}{{/block}}
{{#block "commitment" page=1 y=0.28 pt=11}}Realistic estimate of the number of calendar days required to issue a commitment: {{commitment_days_estimate}} days. Contact person: {{contact_person}}, {{contact_phone}}.{{/block}}
{{#block "correspondent" page=1 y=0.34 pt=11}}{{#if correspondent_lender}}{{correspondent_statement}}{{else}}The lender is not a correspondent mortgage lender.{{/if}}{{/block}}
{{#block "ack" page=1 y=0.4 pt=11}}Acknowledgment: I acknowledge receipt of this disclosure in writing. Signature and date.{{/block}}`;
const NJ_RULES: ContentRule[] = [
  R("before-fees", "N.J.A.C. 3:1-16.3: before accepting application, credit report, appraisal or third-party reimbursement fees", "data_equality", "delivered_before_fees", "given before any fee", { predicate: eq("delivered_before_fees", true) }),
  R("fee-description", "N.J.A.C. 3:1-16.3: a description and the amount of each fee", "presence", `Fees: (.+: .+; amount ${MONEY}; (refundable .+|not refundable)\\. )+`, "description, amount and refundability per fee"),
  R("fees-listed", "N.J.A.C. 3:1-16.3", "data_range", "fees.length", "at least one fee", { range: { min: 1 } }),
  R("commitment-days", "N.J.A.C. 3:1-16.3: realistic estimate of calendar days to issue a commitment", "presence", "calendar days required to issue a commitment: \\d+ days", "commitment-days estimate"),
  R("commitment-days-data", "N.J.A.C. 3:1-16.3", "data_range", "commitment_days_estimate", "estimate is a positive day count", { range: { min: 1 } }),
  R("contact", "N.J.A.C. 3:1-16.3: a contact person", "presence", `Contact person: .+, ${PHONE}`, "contact person named"),
  R("correspondent", "N.J.A.C. 3:1-16.3: correspondent lenders state holding/servicing limits", "conditional", "correspondent_statement", "correspondent statement when applicable", { when: eq("correspondent_lender", true), predicate: { present: "correspondent_statement" } }),
  R("written-ack", "N.J.A.C. 3:1-16.3: acknowledged in writing by the borrower", "presence", "Acknowledgment: .* in writing\\. Signature and date", "written acknowledgment block"),
];
const NJ_SAMPLE = { ...PARTY, property_address: "Property Address 4", delivered_before_fees: true, fees: [{ name: "Credit report fee", description: "cost of obtaining your credit report", amount_cents: 7_500n, refundable: true, refund_conditions: "if the application is withdrawn before the report is ordered" }, { name: "Appraisal fee", description: "cost of the property appraisal", amount_cents: 65_000n, refundable: false, refund_conditions: "" }], commitment_days_estimate: 21, contact_person: "Contact Person 1", contact_phone: "555-0104", correspondent_lender: false, correspondent_statement: "" };

// ------------------------------------------------------------------ NTC_MA_MGL_184_17B_ATTORNEY_STATEMENT (rule 10; worked example 3(d))
const MA_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Massachusetts Attorney Statement{{/block}}
{{#block "intro" page=1 y=0.09 pt=11}}Printed copy of the statements contained in the mortgage application of {{applicant_name}} to {{lender_name}}, property {{property_address}}, given at the time of making the application on {{date application_date}}.{{/block}}
{{#block "statements" page=1 y=0.15 pt=13}}The responsibility of the attorney for the mortgagee is to protect the interest of the mortgagee. Mortgagors may, at their own expense, engage an attorney of their selection to represent their interests in the transaction.{{/block}}`;
const MA_RULES: ContentRule[] = [
  R("statement-1", "M.G.L. c. 184 §17B", "presence", "The responsibility of the attorney for the mortgagee is to protect the interest of the mortgagee\\.", "first statement"),
  R("statement-2", "M.G.L. c. 184 §17B", "presence", "Mortgagors may, at their own expense, engage an attorney of their selection to represent their interests in the transaction\\.", "second statement"),
  R("larger-type", "M.G.L. c. 184 §17B: type at least 2 points larger than the rest of the application", "layout", "statements", "statements in ≥ 13-point type against an 11-point body", { layout: { page: 1, minPt: 13 } }),
  R("larger-type-data", "M.G.L. c. 184 §17B", "data_range", "type_points_larger", "at least 2 points larger", { range: { min: 2 } }),
  R("at-application", "M.G.L. c. 184 §17B: a printed copy given at the time of making the application", "presence", `given at the time of making the application on ${MONTH}`, "copy given at application"),
  R("in-1003", "21.3 worked example 3(d): the 1003 rendered by 21.1 includes the statements", "data_equality", "included_in_application", "statements contained in the application", { predicate: eq("included_in_application", true) }),
];
const MA_SAMPLE = { ...PARTY, property_address: "Property Address 5", application_date: "2026-10-05", type_points_larger: 2, included_in_application: true };

// ------------------------------------------------------------------ NTC_TX_7TAC_57_200_SML_NOTICE (rule 10; worked example 3(c))
const TX_SML_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Texas Mortgage Banker Disclosure{{/block}}
{{#block "body" page=1 y=0.09 pt=11}}{{mortgage_banker_name}} (NMLS ID {{mortgage_banker_nmls_id}}) and its originator {{originator_name}} (NMLS ID {{originator_nmls_id}}) are regulated by the Texas Department of Savings and Mortgage Lending. Consumers wishing to file a complaint against a mortgage banker or a licensed residential mortgage loan originator should complete and send a complaint form to the Department at {{sml_address}}, telephone {{sml_phone}}. The Department maintains a recovery fund to make payments of certain actual out-of-pocket damages sustained by borrowers caused by acts of licensed residential mortgage loan originators; a written application for reimbursement must be filed with the Department. This notice uses the Department's prescribed form, version {{form_version}}, and was delivered to {{applicant_name}} on {{date delivered_on}} for application {{application_id}}.{{/block}}`;
const TX_SML_RULES: ContentRule[] = [
  R("oversight", "7 TAC §57.200: notice concerning SML's regulatory oversight", "presence", "regulated by the Texas Department of Savings and Mortgage Lending", "regulatory oversight statement"),
  R("complaint", "7 TAC §57.200 prescribed form: complaint process", "presence", `complaint form to the Department at .+, telephone ${PHONE}`, "complaint contact"),
  R("recovery-fund", "7 TAC §57.200 prescribed form: recovery fund", "presence", "recovery fund .* written application for reimbursement", "recovery fund statement"),
  R("nmls-ids", "7 TAC §57.200: name and NMLS ID on correspondence", "presence", "\\(NMLS ID \\d+\\) and its originator .+ \\(NMLS ID \\d+\\)", "banker and originator NMLS IDs"),
  R("form-version", "7 TAC §57.200: the current form prescribed by SML", "data_equality", "form_version", "prescribed form version recorded", { predicate: { present: "form_version" } }),
  R("evidence", "7 TAC §57.200: by any means allowing records reflecting timely delivery", "data_equality", "delivery_evidence_retained", "delivery evidence retained", { predicate: eq("delivery_evidence_retained", true) }),
  R("at-application", "7 TAC §57.200: at the time the initial application is received", "presence", `delivered to .+ on ${MONTH}`, "delivery date shown"),
];
const TX_SML_SAMPLE = { ...PARTY, mortgage_banker_name: "Partner Lender", mortgage_banker_nmls_id: "123456", originator_name: "Originator 1", originator_nmls_id: "987654", sml_address: "Agency Address 2", sml_phone: "555-0105", form_version: "2024-11", delivered_on: "2026-10-05", delivery_evidence_retained: true };

// ------------------------------------------------------------------ NTC_CA_21CCR_7114_FAIR_LENDING_NOTICE (rule 10; worked example 3(b))
const CA_FLN_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Fair Lending Notice{{/block}}
{{#block "body" page=1 y=0.09 pt=11}}Under the Housing Financial Discrimination Act of 1977, it is illegal to discriminate in the provision of or in the availability of financial assistance because of the consideration of the trends, characteristics or conditions in the neighborhood or geographic area surrounding a housing accommodation, unless the financial institution can demonstrate in the particular case that such consideration is required to avoid an unsafe and unsound business practice; or because of race, color, religion, sex, marital status, domestic partnership, national origin, ancestry, familial status, source of income, disability or genetic information. It is illegal to consider the racial, ethnic, religious or national origin composition of a neighborhood or geographic area surrounding a housing accommodation or whether or not such composition is undergoing change, or is expected to undergo change, in appraising a housing accommodation or in determining whether or not, or under what terms and conditions, to provide financial assistance. If you have questions about your rights, or if you wish to file a complaint, contact the management of this financial institution at {{lender_name}}, {{lender_phone}}, or the Department of Financial Protection and Innovation at {{dfpi_address}}, {{dfpi_phone}}.{{/block}}
{{#block "ack" page=1 y=0.5 pt=11}}Acknowledgment of receipt: I (we) received a copy of this notice. Applicant {{applicant_name}}, application {{application_id}} submitted in writing on {{date written_application_date}}. Signature and date.{{/block}}`;
const CA_FLN_RULES: ContentRule[] = [
  R("heading", "21 CCR §7114: the prescribed Fair Lending Notice", "presence", "Fair Lending Notice", "titled notice"),
  R("illegal-discriminate", "Health & Safety Code §35810–35811; 21 CCR §7114", "presence", "illegal to discriminate in the provision of or in the availability of financial assistance", "discrimination prohibition"),
  R("neighborhood", "Health & Safety Code §35810(a): neighborhood trends, characteristics or conditions", "presence", "trends, characteristics or conditions in the neighborhood or geographic area", "neighborhood-consideration prohibition"),
  R("protected-classes", "Health & Safety Code §35811", "presence", "race, color, religion, sex, marital status, domestic partnership, national origin, ancestry, familial status, source of income, disability or genetic information", "protected classes listed"),
  R("complaint-contact", "21 CCR §7114: institution and DFPI contact for complaints", "presence", `contact the management of this financial institution at .+, ${PHONE}, or the Department of Financial Protection and Innovation at .+, ${PHONE}`, "complaint contacts"),
  R("acknowledgment", "21 CCR §7114: acknowledgment of receipt with applicant signature and date", "presence", "Acknowledgment of receipt: .* Signature and date", "acknowledgment block"),
  R("written-application", "21 CCR §7114: upon submission of a written application", "presence", `submitted in writing on ${MONTH}`, "written application date"),
  R("ack-requested", "21.3 timers: acknowledgment requested, tracked, non-blocking", "data_equality", "acknowledgment_requested", "acknowledgment requested", { predicate: eq("acknowledgment_requested", true) }),
];
const CA_FLN_SAMPLE = { ...PARTY, property_address: "Property Address 6", dfpi_address: "Agency Address 3", dfpi_phone: "555-0106", written_application_date: "2026-10-05", acknowledgment_requested: true };

// ------------------------------------------------------------------ NTC_CA_CIV_1632_5_TRANSLATED_LE (rule 10; worked example 3(b))
const CA_TLE_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Translated Loan Estimate ({{language_label}}){{/block}}
{{#block "intro" page=1 y=0.09 pt=11}}This is the translation prescribed by the Department of Financial Protection and Innovation (form version {{dfpi_form_version}}) of the Loan Estimate version {{le_version}} issued {{date le_issued_on}} to {{applicant_name}} by {{lender_name}}, property {{property_address}}. Your loan was negotiated primarily in {{language_label}}. The English Loan Estimate is the controlling document; this translation is provided for your information.{{/block}}
{{#block "figures" page=1 y=0.2 pt=11}}Loan amount {{money loan_amount_cents}}. Interest rate {{interest_rate_pct}} percent. Monthly principal and interest {{money pi_cents}}. Estimated total closing costs {{money total_closing_costs_cents}}. Estimated cash to close {{money cash_to_close_cents}}.{{/block}}
{{#block "revision" page=1 y=0.3 pt=11}}{{#if revised}}This translation replaces the earlier translation because the Loan Estimate was revised.{{else}}This is the first translation for this application.{{/if}}{{/block}}`;
const CA_TLE_RULES: ContentRule[] = [
  R("language", "Cal. Civ. Code §1632.5: negotiated primarily in Spanish, Chinese, Tagalog, Vietnamese or Korean", "data_equality", "language_edition", "one of the five languages", { predicate: oneOf("language_edition", ["es", "zh", "tl", "vi", "ko"]) }),
  R("dfpi-form", "Cal. Civ. Code §1632.5: the DFPI-prescribed translated form", "presence", "prescribed by the Department of Financial Protection and Innovation \\(form version .+\\)", "DFPI form version"),
  R("mirrors-le", "21.3 worked example 3(b): mirrors LE v1 / the revised LE", "data_equality", "le_disclosure_id", "tied to a specific LE version", { predicate: { and: [{ present: "le_disclosure_id" }, { present: "le_version" }] } }),
  R("figures-match", "Cal. Civ. Code §1632.5: translation of the Loan Estimate delivered", "data_equality", "loan_amount_cents", "loan amount, closing costs and cash to close equal the English LE figures", { predicate: { and: [eq("loan_amount_cents", { var: "le_loan_amount_cents" }), eq("total_closing_costs_cents", { var: "le_total_closing_costs_cents" }), eq("cash_to_close_cents", { var: "le_cash_to_close_cents" })] } }),
  R("figures-shown", "12 CFR 1026.37 key figures", "presence", `Loan amount ${MONEY}\\. Interest rate [\\d.]+ percent\\. Monthly principal and interest ${MONEY}\\. Estimated total closing costs ${MONEY}\\. Estimated cash to close ${MONEY}\\.`, "key LE figures rendered"),
  R("controlling", "Cal. Civ. Code §1632.5: the English disclosure controls", "presence", "The English Loan Estimate is the controlling document", "controlling-document statement"),
  R("no-interpreter-exception", "Cal. Civ. Code §1632.5: not required where the borrower used an unaffiliated interpreter", "data_equality", "unaffiliated_interpreter_used", "no interpreter exception applies", { predicate: eq("unaffiliated_interpreter_used", false) }),
];
const CA_TLE_SAMPLE = { ...PARTY, property_address: "Property Address 6", language_edition: "es", language_label: "Spanish", dfpi_form_version: "2024-01", le_version: "1", le_disclosure_id: "LE-0001", le_issued_on: "2026-10-05", loan_amount_cents: 56_000_000n, le_loan_amount_cents: 56_000_000n, interest_rate_pct: "6.125", pi_cents: 340_262n, total_closing_costs_cents: 350_543n, le_total_closing_costs_cents: 350_543n, cash_to_close_cents: 350_543n, le_cash_to_close_cents: 350_543n, revised: false, unaffiliated_interpreter_used: false };

// ------------------------------------------------------------------ NTC_AZ_ARS_6_946C_FEE_AGREEMENT (rule 10; worked example 1)
const AZ_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Written Fee Agreement{{/block}}
{{#block "parties" page=1 y=0.09 pt=11}}This written agreement is between {{lender_name}} (NMLS ID {{lender_nmlsr_id}}) and {{applicant_name}} for application {{application_id}}, property {{property_address}}, dated {{date agreement_date}}.{{/block}}
{{#block "fees" page=1 y=0.16 pt=11}}Fees: {{#each fees}}{{name}} {{money amount_cents}}, payable {{when_paid}}; if the loan is consummated {{if_consummated}}; if the loan is not consummated {{if_not_consummated}}. {{/each}}These terms govern the payment of each fee and the disposition of each advance or fee whether or not the loan is finally consummated.{{/block}}
{{#block "compliance" page=1 y=0.3 pt=11}}We will provide every disclosure required by the Truth in Lending Act and the Real Estate Settlement Procedures Act.{{/block}}
{{#block "signatures" page=1 y=0.36 pt=11}}Signatures: borrower {{applicant_name}}, signature and date. Mortgage banker {{lender_name}}, signature and date.{{/block}}`;
const AZ_RULES: ContentRule[] = [
  R("written-agreement", "A.R.S. §6-946(C): a written agreement before an advance fee or fee is collected", "presence", "This written agreement is between .+ and .+", "written agreement between the parties"),
  R("fee-terms", "A.R.S. §6-946(C): terms pertaining to the payment of the fee", "presence", `Fees: (.+ ${MONEY}, payable .+; if the loan is consummated .+; if the loan is not consummated .+\\. )+`, "payment terms and disposition per fee"),
  R("fees-listed", "A.R.S. §6-946(C)", "data_range", "fees.length", "at least one fee", { range: { min: 1 } }),
  R("disposition", "A.R.S. §6-946(C): disposition whether the loan is finally consummated or not", "presence", "whether or not the loan is finally consummated", "disposition statement"),
  R("tila-respa", "A.R.S. §6-946(E): compliance with TILA/RESPA disclosures", "presence", "Truth in Lending Act and the Real Estate Settlement Procedures Act", "compliance statement"),
  R("both-sign", "A.R.S. §6-946(C): the parties shall sign; 21.3 gate opens when signed by the borrower(s) and the partner", "presence", "Signatures: borrower .+, signature and date\\. Mortgage banker .+, signature and date", "signature lines for both parties"),
  R("before-fee", "A.R.S. §6-946(C); 21.3 timers: AZ gate blocks impose_fee until signed", "data_equality", "signed_before_any_fee", "executed before any fee is collected", { predicate: eq("signed_before_any_fee", true) }),
];
const AZ_SAMPLE = { ...PARTY, agreement_date: "2026-10-05", signed_before_any_fee: true, fees: [{ name: "Credit report fee", amount_cents: 7_500n, when_paid: "after you indicate intent to proceed", if_consummated: "the fee is credited at closing", if_not_consummated: "the fee is refunded" }, { name: "Appraisal fee", amount_cents: 65_000n, when_paid: "after you indicate intent to proceed", if_consummated: "the fee is applied to the appraisal cost", if_not_consummated: "the fee is retained once the appraisal is ordered" }] };

// ------------------------------------------------------------------ NTC_FL_69B_124_013_ANTI_COERCION (rule 10; R. 69B-124.002/.013)
const FL_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Statement of Anti-Coercion{{/block}}
{{#block "body" page=1 y=0.09 pt=11}}The insurance laws of the State of Florida provide that the lender may not require the borrower to take insurance through any particular insurance agent or company to protect the mortgaged property. The borrower, subject to the rules adopted by the Insurance Commissioner, has the right to have the insurance placed with an insurance agent or company of his or her choice, provided the company meets the requirements of the lender. The lender has the right to designate reasonable financial requirements as to the company and the adequacy of the coverage.{{/block}}
{{#block "ack" page=1 y=0.24 pt=11}}I have read the foregoing statement, or the rules of the Insurance Commissioner relative thereto, and understand my rights and privileges and those of the lender relative to the placing of such insurance. Insurance choice: {{insurance_choice}}. Borrower {{applicant_name}}, property {{property_address}}, given {{date given_on}} by {{lender_name}} when negotiations began and before any formal application or fee. Signature and date; a signed copy is retained by the lender.{{/block}}`;
const FL_RULES: ContentRule[] = [
  R("heading", "Fla. Admin. Code R. 69B-124.013: Statement of Anti-Coercion", "presence", "Statement of Anti-Coercion", "titled statement"),
  R("may-not-require", "R. 69B-124.013; §626.9551", "presence", "may not require the borrower to take insurance through any particular insurance agent or company", "anti-coercion statement"),
  R("choice", "R. 69B-124.013: right to place insurance with an agent or company of choice", "presence", "right to have the insurance placed with an insurance agent or company of his or her choice", "borrower-choice statement"),
  R("acknowledgment", "R. 69B-124.013 acknowledgment block; R. 69B-124.002: signed copy retained by the lender", "presence", "I have read the foregoing statement.* Signature and date; a signed copy is retained by the lender", "acknowledgment and retention"),
  R("insurance-choice", "R. 69B-124.013 form: the borrower's election", "data_equality", "insurance_choice", "election recorded", { predicate: { present: "insurance_choice" } }),
  R("pre-application", "R. 69B-124.002: when negotiations begin, prior to any formal application or the payment of any fees", "data_equality", "delivered_before_application", "given before the formal application and any fee", { predicate: { and: [eq("delivered_before_application", true), eq("delivered_before_any_fee", true)] } }),
];
const FL_SAMPLE = { ...PARTY, property_address: "Property Address 7", given_on: "2026-10-05", insurance_choice: "I will obtain insurance from an agent or company of my choice", delivered_before_application: true, delivered_before_any_fee: true };

// ------------------------------------------------------------------ NTC_TX_50A6_12DAY (26.1's §50(g) notice; carried in 21.3's package)
const TX_50A6_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Notice Concerning Extensions of Credit Defined by Section 50(a)(6), Article XVI, Texas Constitution{{/block}}
{{#block "intro" page=1 y=0.1 pt=11}}To {{applicant_name}} from {{lender_name}} for application {{application_id}}, homestead {{property_address}}, delivered {{date delivered_on}} ({{language_label}}). Section 50(a)(6) of Article XVI of the Texas Constitution allows certain loans to be secured against the equity in your home. Such loans are commonly known as equity loans. If you do not repay the loan or if you fail to meet the terms of the loan, the lender may foreclose and sell your home. The Constitution provides that:{{/block}}
{{#block "conditions" page=1 y=0.2 pt=11}}{{#each conditions}}({{@index}}) {{this}} {{/each}}{{/block}}
{{#block "closing" page=2 y=0.05 pt=11}}The loan may not close before the 12th day after the later of the date you submit the loan application and the date you receive this notice. This notice is only a summary of your rights under the Texas Constitution; your rights are governed by Section 50, Article XVI, and not by this notice.{{/block}}`;
const TX_50A6_RULES: ContentRule[] = [
  R("heading", "Tex. Const. art. XVI §50(g)", "presence", "Notice Concerning Extensions of Credit Defined by Section 50\\(a\\)\\(6\\), Article XVI, Texas Constitution", "§50(g) heading"),
  R("equity-loan", "Tex. Const. art. XVI §50(g)", "presence", "loans to be secured against the equity in your home", "equity loan statement"),
  R("foreclose", "Tex. Const. art. XVI §50(g)", "presence", "the lender may foreclose and sell your home", "foreclosure consequence"),
  R("twelve-day", "Tex. Const. art. XVI §50(a)(6)(M)(i); §50(g); 26.1 TX_50A6 12-day timer", "presence", "may not close before the 12th day after the later of the date you submit the loan application and the date you receive this notice", "12-day closing rule"),
  R("conditions-listed", "Tex. Const. art. XVI §50(g): the constitutional conditions (A)–(Q) summarized", "data_range", "conditions.length", "the constitutional conditions listed", { range: { min: 8 } }),
  R("fmv-80", "Tex. Const. art. XVI §50(a)(6)(B)", "presence", "80 percent of the fair market value", "80% of fair market value condition"),
  R("fee-cap", "Tex. Const. art. XVI §50(a)(6)(E)", "presence", "2 percent of the loan amount", "fee cap condition"),
  R("summary-only", "Tex. Const. art. XVI §50(g)", "presence", "only a summary of your rights under the Texas Constitution", "summary statement"),
  R("is-50a6", "26.1 / 21.3: delivered only for a 50(a)(6) transaction", "data_equality", "is_50a6", "50(a)(6) home equity transaction", { predicate: eq("is_50a6", true) }),
  R("language", "Tex. Fin. Code §341.502: English and Spanish", "data_equality", "language_edition", "en or es", { predicate: oneOf("language_edition", ["en", "es"]) }),
];
const TX_50A6_SAMPLE = { ...PARTY, property_address: "Property Address 8", application_id: "APP-21-3-TX", delivered_on: "2026-10-05", language_edition: "en", language_label: "English", is_50a6: true, conditions: [
  "The loan must be voluntarily created with the consent of each owner of your home and each owner's spouse.",
  "The principal loan amount at the time the loan is made must not exceed an amount that, when added to the principal balances of all other liens against your home, is more than 80 percent of the fair market value of your home.",
  "The loan must be without recourse for personal liability against you and your spouse unless you or your spouse obtained the loan by actual fraud.",
  "The lien securing the loan may be foreclosed upon only with a court order.",
  "Fees and charges to make the loan may not exceed 2 percent of the loan amount, except for bona fide discount points, appraisal, survey and title charges.",
  "The loan may not be an open-end account that may be debited from time to time or under which credit may be extended from time to time unless it is a home equity line of credit.",
  "You may prepay the loan at any time without penalty.",
  "No additional collateral other than your home may be required to secure the loan.",
  "Only one loan described by Section 50(a)(6) may be secured against your home at any given time, and a new equity loan may not be closed within one year of a prior one.",
  "The loan must be closed at the office of the lender, an attorney at law or a title company.",
  "You may rescind the loan within three days after it is closed.",
  "The lender must provide you with a copy of all documents you sign at closing.",
] };

export const VERSIONS_21_3: VersionInput[] = [
  V("NTC_REGX_1024_20_HCL", HCL_SOURCE, HCL_RULES, HCL_SAMPLE, "regx.2013", "12 CFR 1024.20(a)(1); 80 FR 22091 (2015 interpretive rule); 21.3 worked example 1 (zip 85018, hud_snapshot_at Oct 5 15:31)"),
  V("NTC_REGX_1024_6_TOOLKIT", TOOLKIT_SOURCE, TOOLKIT_RULES, TOOLKIT_SAMPLE, "regx.2013", "12 CFR 1024.6; 1026.19(g); Your Home Loan Toolkit 2026-08; 21.3 worked example 2 (purchase, English)"),
  V("NTC_REGX_1024_15_AFBA", AFBA_SOURCE, AFBA_RULES, AFBA_SAMPLE, "regx.2013", "12 CFR 1024.15(b)(1); Appendix D to Part 1024; 21.3 rule 8"),
  V("NTC_REGB_1002_14_APPRAISAL_NOTICE", REGB_SOURCE, REGB_RULES, REGB_SAMPLE, "regb.2013", "12 CFR 1002.14(a)(2); Appendix C form C-9; 12 CFR 1026.35(c)(5); 21.3 rule 4"),
  V("NTC_FCRA_609G_CREDIT_SCORE", FCRA_SOURCE, FCRA_RULES, FCRA_SAMPLE, "regv.subpart_h", "15 U.S.C. 1681g(f)–(g); 21.3 worked example 1 (Borrower A scores 742/751/760, applicable 751)"),
  V("NTC_REGV_1022_74_RBP_EXCEPTION", REGV_SOURCE, REGV_RULES, REGV_SAMPLE, "regv.subpart_h", "12 CFR 1022.74(d); model form H-3; 21.3 worked example 1 (applicable score 751)"),
  V("NTC_REGZ_1026_19B_ARM_PROGRAM", ARM_SOURCE, ARM_RULES, ARM_SAMPLE, "regz.trid.2017", "12 CFR 1026.19(b)(2); Fannie Mae Plan 4927 5/6 SOFR; 21.3 rule 7 worked arithmetic (5.875% → $59.15; max 10.875% at 78 months)"),
  V("NTC_REGZ_1026_19B_CHARM", CHARM_SOURCE, CHARM_RULES, CHARM_SAMPLE, "regz.trid.2017", "12 CFR 1026.19(b)(1); CHARM booklet 2020-06; 21.3 worked example 2(c) (Plan 4928, electronic)"),
  V("NTC_REGX_1024_33A_SDS", SDS_SOURCE, SDS_RULES, SDS_SAMPLE, "regx.2013", "12 CFR 1024.33(a) — reverse mortgage only; 21.3 rule 11 (never issued on a forward loan)"),
  V("NTC_NY_3NYCRR_38_3_PREAPP_DISCLOSURE", NY_SOURCE, NY_RULES, NY_SAMPLE, "regx.2013", "3 NYCRR 38.3; 21.3 worked example 3(a)"),
  V("NTC_NJ_3_1_16_3_APPLICATION_DISCLOSURE", NJ_SOURCE, NJ_RULES, NJ_SAMPLE, "regx.2013", "N.J.A.C. 3:1-16.3; 21.3 worked example 3(e)"),
  V("NTC_MA_MGL_184_17B_ATTORNEY_STATEMENT", MA_SOURCE, MA_RULES, MA_SAMPLE, "regx.2013", "M.G.L. c. 184 §17B; 21.3 worked example 3(d)"),
  V("NTC_TX_7TAC_57_200_SML_NOTICE", TX_SML_SOURCE, TX_SML_RULES, TX_SML_SAMPLE, "regx.2013", "7 TAC §57.200 (SML prescribed form); 21.3 worked example 3(c)"),
  V("NTC_CA_21CCR_7114_FAIR_LENDING_NOTICE", CA_FLN_SOURCE, CA_FLN_RULES, CA_FLN_SAMPLE, "regx.2013", "21 CCR §7114; Health & Safety Code §35830; 21.3 worked example 3(b)"),
  V("NTC_CA_CIV_1632_5_TRANSLATED_LE", CA_TLE_SOURCE, CA_TLE_RULES, CA_TLE_SAMPLE, "regz.trid.2017", "Cal. Civ. Code §1632.5; DFPI translated LE; 21.3 worked example 3(b) (Spanish, LE v1 figures)"),
  V("NTC_AZ_ARS_6_946C_FEE_AGREEMENT", AZ_SOURCE, AZ_RULES, AZ_SAMPLE, "regx.2013", "A.R.S. §6-946(C), (E); 21.3 worked example 1 (e-signed Oct 5 17:44)"),
  V("NTC_FL_69B_124_013_ANTI_COERCION", FL_SOURCE, FL_RULES, FL_SAMPLE, "regx.2013", "Fla. Admin. Code R. 69B-124.002 and 69B-124.013; §626.9551"),
  V("NTC_TX_50A6_12DAY", TX_50A6_SOURCE, TX_50A6_RULES, TX_50A6_SAMPLE, "regx.2013", "Tex. Const. art. XVI §50(g); Tex. Fin. Code §341.502; 26.1 worked example 2 (delivered Oct 5)"),
];

const DISCLOSURE = { noticeClass: "disclosures", channelPolicy: "esign_or_mail" as const };
export const OVERRIDES_21_3: Record<string, Partial<NoticeTemplate>> = {
  NTC_REGX_1024_20_HCL: { ...DISCLOSURE, mayCombineWith: ["NTC_REGZ_1026_37_LE"], retention: "fnma_loan_file_life_plus_4y", citation: "12 CFR 1024.20(a)(1)–(2), (a)(4) (mail or deliver; electronic under E-SIGN); 80 FR 22091; may be combined with the Loan Estimate package" },
  NTC_REGX_1024_6_TOOLKIT: { ...DISCLOSURE, retention: "regz_general_2y", citation: "12 CFR 1026.19(g)(1)(i) (deliver or place in the mail within three business days; electronic under E-SIGN); 12 CFR 1024.6(a)(1)" },
  NTC_REGX_1024_15_AFBA: { ...DISCLOSURE, separateDocument: true, retention: "respa_afba_5y", citation: "12 CFR 1024.15(b)(1) (on a separate piece of paper no later than the referral); 1024.15(d) (retained 5 years)" },
  NTC_REGB_1002_14_APPRAISAL_NOTICE: { ...DISCLOSURE, retention: "regb_25m", citation: "12 CFR 1002.14(a)(2) (mail or deliver; electronic under 1002.14(a)(5)/E-SIGN); Appendix C form C-9; 12 CFR 1026.35(c)(5)" },
  NTC_FCRA_609G_CREDIT_SCORE: { ...DISCLOSURE, separateDocument: true, mayCombineWith: ["NTC_REGV_1022_74_RBP_EXCEPTION"], retention: "regb_25m", citation: "15 U.S.C. 1681g(g); one notice per borrower with only that borrower's scores (12 CFR 1022.75(c))" },
  NTC_REGV_1022_74_RBP_EXCEPTION: { ...DISCLOSURE, separateDocument: true, mayCombineWith: ["NTC_FCRA_609G_CREDIT_SCORE"], retention: "regb_25m", citation: "12 CFR 1022.74(d)(2) (segregated from other information except the §609(g) disclosure; retainable written form), (d)(3) (with the §609(g) notice, before consummation); model form H-3" },
  NTC_REGZ_1026_19B_ARM_PROGRAM: { ...DISCLOSURE, mayCombineWith: ["NTC_REGZ_1026_19B_CHARM"], retention: "regz_general_2y", citation: "12 CFR 1026.19(b)(2), 1026.19(c) (electronic on or with an electronic application); 21.3 rule 7 (telephone channel: deliver under E-SIGN consent or mail the same day)" },
  NTC_REGZ_1026_19B_CHARM: { ...DISCLOSURE, mayCombineWith: ["NTC_REGZ_1026_19B_ARM_PROGRAM"], retention: "regz_general_2y", citation: "12 CFR 1026.19(b)(1), 1026.19(c); CHARM booklet 2020-06 delivered unchanged" },
  NTC_REGX_1024_33A_SDS: { ...DISCLOSURE, retention: "regz_general_2y", citation: "12 CFR 1024.33(a) — reverse mortgage transactions only; scope reverse_only, never issued on a forward loan (21.3 rule 11; the LE §1026.37(m)(6) servicing block governs)" },
  NTC_NY_3NYCRR_38_3_PREAPP_DISCLOSURE: { ...DISCLOSURE, retention: "fnma_loan_file_life_plus_4y", citation: "3 NYCRR 38.3 — before the application interview and any fee; electronic only under E-SIGN consent with the required confirm button or e-signature, else a signed copy by mail" },
  NTC_NJ_3_1_16_3_APPLICATION_DISCLOSURE: { ...DISCLOSURE, retention: "fnma_loan_file_life_plus_4y", citation: "N.J.A.C. 3:1-16.3 — before any fee; written acknowledgment by the borrower (electronic under E-SIGN consent)" },
  NTC_MA_MGL_184_17B_ATTORNEY_STATEMENT: { ...DISCLOSURE, retention: "fnma_loan_file_life_plus_4y", citation: "M.G.L. c. 184 §17B — printed or electronic copy given at the time of making the application" },
  NTC_TX_7TAC_57_200_SML_NOTICE: { ...DISCLOSURE, retention: "fnma_loan_file_life_plus_4y", citation: "7 TAC §57.200 — at receipt of the initial application, by any means allowing records reflecting timely delivery (electronic under E-SIGN consent)" },
  NTC_CA_21CCR_7114_FAIR_LENDING_NOTICE: { ...DISCLOSURE, retention: "fnma_loan_file_life_plus_4y", citation: "21 CCR §7114 — at written application with an acknowledgment of receipt retained (electronic under E-SIGN consent)" },
  NTC_CA_CIV_1632_5_TRANSLATED_LE: { ...DISCLOSURE, mayCombineWith: ["NTC_REGZ_1026_37_LE"], retention: "regz_le_3y", citation: "Cal. Civ. Code §1632.5 — DFPI translated LE within three business days of the written application, delivered with the LE and re-issued on each revised LE" },
  NTC_AZ_ARS_6_946C_FEE_AGREEMENT: { ...DISCLOSURE, separateDocument: true, retention: "fnma_loan_file_life_plus_4y", citation: "A.R.S. §6-946(C) — signed written agreement (e-signature under E-SIGN consent) before any fee is collected" },
  NTC_FL_69B_124_013_ANTI_COERCION: { ...DISCLOSURE, retention: "fnma_loan_file_life_plus_4y", citation: "Fla. Admin. Code R. 69B-124.002, 69B-124.013 — when negotiations begin, before any formal application or fee; borrower-signed copy retained (e-signature under E-SIGN consent)" },
  NTC_TX_50A6_12DAY: { ...DISCLOSURE, separateDocument: true, retention: "fnma_loan_file_life_plus_4y", citation: "Tex. Const. art. XVI §50(g); 7 TAC §153.12 — delivered at application (electronic under E-SIGN consent or mailed with the 3-day presumption); 26.1 sets the 12-day timer, 21.3's package carries the notice" },
};
