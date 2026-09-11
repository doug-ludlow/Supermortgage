/**
 * §24.2 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 *   NTC_REGB_1002_14_VALUATION_COPY        cover letter for the copy package (12 CFR 1002.14(a)(1)): creditor = partner, every
 *                                          undelivered `valuations` row enclosed (appraisal, revision, AVM report, BPO, staff value
 *                                          document), completion date, "no charge" (a)(3), the three-business-day statement and the
 *                                          waiver rule (comment 14(a)(1)-6), ROV disclosure enclosed with the first version, automation.
 *   NTC_FNMA_B4_1_3_12_ROV_DISCLOSURE      the ROV process disclosure delivered with the appraisal copy (B4-1.3-12; SEL-2025-07): how to
 *                                          request, required contents, ≤ 5 comparables with sources, one borrower ROV per appraisal,
 *                                          none after closing, the 5-business-day turn-time expectation, revised report with commentary,
 *                                          fair-lending complaint path.
 *   NTC_REGZ_1026_35C_HPML_APPRAISAL_COPY  HPML cover variant (12 CFR 1026.35(c)(6)): every written appraisal (incl. the flip second
 *                                          appraisal) no later than three business days before consummation, no waiver, no charge for
 *                                          the copy, one appraisal fee only (c)(4)(vi).
 *   NTC_REGB_1002_14_COPY_NOT_CONSUMMATED  copies within 30 days after the creditor determines consummation will not occur
 *                                          (§1002.14(a)(1); §1026.35(c)(6)(ii)(B) when HPML) — includes the AVM report.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const DATE_RULE = R("date", "notice date", "presence", "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "date of the notice");
const AUTOMATION = R("automation", "baseline §8.10 / 24.2 AI agent design: every borrower contact discloses automation", "presence", "prepared by an automated system", "automation disclosure");
const NO_CHARGE_ABSENCE = R("no-fee-line", "12 CFR 1002.14(a)(3) comment: no photocopy, postage or other costs", "absence", "(copy fee|photocopy charge|postage due)", "no fee line for the copy");
const FIXTURE = { partner_name: "Partner Bank, N.A.", borrower_names: ["Alex Fixture"], property_address: "4120 N 44th St, Phoenix AZ 85018", loan_number_last4: "0917", mlo_name: "Jordan Originator", mlo_nmlsr_id: "1234567", contact_phone: "1-800-555-0142" };
const VALUATION_LIST = `{{#each valuations}}{{kind_label}} developed {{date developed_at}} (version {{version_no}}); {{/each}}`;

// ------------------------------------------------------------------ NTC_REGB_1002_14_VALUATION_COPY
const VALUATION_COPY = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Copy of Your Appraisal and Other Written Valuations{{/block}}
{{#block "parties" page=1 y=0.1 pt=11}}{{date notice_date}}. From {{partner_name}}, the creditor on your application (loan number ending {{loan_number_last4}}). To: {{#each borrower_names}}{{this}}; {{/each}}Property: {{property_address}}.{{/block}}
{{#block "enclosed" page=1 y=0.18 pt=11 bold}}Enclosed are copies of all appraisals and other written valuations developed in connection with your application: ${VALUATION_LIST}{{/block}}
{{#block "timing" page=1 y=0.3 pt=11}}The latest version was completed on {{date completion_at}}. Federal law (Regulation B, 12 CFR 1002.14) requires us to provide these copies promptly upon completion, or at least three business days before consummation of your loan, whichever is earlier. Based on delivery today, the earliest date your loan may be consummated is {{date earliest_consummation}}.{{#if consummation_scheduled_on}} Your closing is currently scheduled for {{date consummation_scheduled_on}}.{{/if}}{{/block}}
{{#block "waiver" page=1 y=0.42 pt=10}}You may waive the three-business-day timing only by giving us an affirmative oral or written statement no later than three business days before consummation; even then we must give you the copies at or before consummation. You are not required to waive.{{/block}}
{{#block "nocharge" page=1 y=0.5 pt=11 bold}}There is no charge for these copies.{{/block}}
{{#if revision}}{{#block "revision" page=1 y=0.56 pt=10}}This package contains a revised version of an appraisal you received earlier. Because the creditor received a revision, we are providing the revised version too (comment 14(a)(1)-7).{{/block}}{{/if}}
{{#if includes_rov_disclosure}}{{#block "rov" page=1 y=0.64 pt=10}}Also enclosed: information about how to request a reconsideration of value if you believe the appraisal contains errors or unsupported conclusions.{{/block}}{{/if}}
{{#block "contact" page=1 y=0.8 pt=10}}Questions: {{partner_name}} at {{contact_phone}}, or your loan originator {{mlo_name}} (NMLSR ID {{mlo_nmlsr_id}}). This notice was prepared by an automated system on behalf of {{partner_name}}.{{/block}}`;
const VALUATION_COPY_RULES: ContentRule[] = [
  DATE_RULE, AUTOMATION, NO_CHARGE_ABSENCE,
  R("heading-layout", "12 CFR 1002.14(a)(1): a copy of all appraisals and other written valuations", "layout", "heading", "heading on page 1, ≥ 12 pt, bold", { layout: { page: 1, minPt: 12, bold: true } }),
  R("all-valuations", "12 CFR 1002.14(a)(1); (b)(3) valuation; comment 14(b)(3)-1", "presence", "copies of all appraisals and other written valuations developed in connection with your application: .+developed", "every enclosed valuation is listed with its developed date"),
  R("creditor-partner", "24.2 Capacity: partner = creditor under Reg B; SM delivers in the partner's name", "data_equality", "partner_name", "the partner is the named creditor", { predicate: { present: "partner_name" } }),
  R("completion", "comment 14(a)(1)-4: completion", "presence", "completed on (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "completion date"),
  R("three-business-days", "12 CFR 1002.14(a)(1): promptly upon completion, or three business days prior to consummation, whichever is earlier", "presence", "promptly upon completion, or at least three business days before consummation", "the (a)(1) timing statement"),
  R("earliest-consummation", "24.2 R4: copy day + 3 business_days_creditor → earliest consummation", "presence", "earliest date your loan may be consummated is", "earliest consummation date"),
  R("waiver", "12 CFR 1002.14(a)(1); comment 14(a)(1)-6: affirmative oral or written statement no later than three business days prior to consummation; copies at or prior to consummation", "presence", "no later than three business days before consummation; even then we must give you the copies at or before consummation", "waiver rule stated"),
  R("no-charge", "12 CFR 1002.14(a)(3): shall not charge an applicant for providing a copy", "presence", "There is no charge for these copies", "no-charge statement"),
  R("revision", "comment 14(a)(1)-7: a revision must also be provided", "presence", "revised version of an appraisal you received earlier", "revision statement when the package carries a revision", { when: { "==": [{ var: "revision" }, true] } }),
  R("rov-enclosed", "B4-1.3-12: the ROV disclosure is provided when the appraisal report is provided", "presence", "reconsideration of value", "ROV disclosure referenced with the first version", { when: { "==": [{ var: "includes_rov_disclosure" }, true] } }),
  R("valuations-nonempty", "24.2 R4: package = every undelivered valuation", "data_range", "valuation_count", "at least one valuation enclosed", { range: { min: 1 } }),
];
/** Worked example 1: v1 accepted Fri Oct 16, 2026 (completion), e-delivered Oct 16 10:45 MST → earliest consummation Wed Oct 21; closing Fri Nov 6. */
const VALUATION_COPY_SAMPLE = { ...FIXTURE, notice_date: "2026-10-16", completion_at: "2026-10-16", earliest_consummation: "2026-10-21", consummation_scheduled_on: "2026-11-06", revision: false, includes_rov_disclosure: true, valuation_count: 1,
  valuations: [{ kind_label: "Uniform Residential Appraisal Report (Form 1004, UAD 3.6)", developed_at: "2026-10-14", version_no: 1 }] };

// ------------------------------------------------------------------ NTC_FNMA_B4_1_3_12_ROV_DISCLOSURE
const ROV_DISCLOSURE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Reconsideration of Value — How to Ask Us to Look Again{{/block}}
{{#block "intro" page=1 y=0.1 pt=11}}{{date notice_date}}. {{partner_name}} provides this information with your appraisal copy. If you believe the appraisal of {{property_address}} contains factual errors, unsupported conclusions, or is deficient — including anything that suggests the value was influenced by prohibited discrimination — you may request a reconsideration of value (ROV).{{/block}}
{{#block "how" page=1 y=0.2 pt=11 bold}}How to request: use the ROV form in your borrower portal, call {{contact_phone}}, or write to us. Your request must include: your name(s); the property address; the effective date of the appraisal; the appraiser's name; the date of your request; a description of the unsupported, inaccurate, or deficient areas; and any additional data, information, or comparable properties (not to exceed five) with the source of each.{{/block}}
{{#block "limits" page=1 y=0.38 pt=11}}Only one borrower-initiated reconsideration of value is permitted per appraisal. After the loan has closed, a reconsideration of value can no longer be submitted.{{/block}}
{{#block "process" page=1 y=0.48 pt=11}}A designated appraisal subject-matter expert reviews every request within two business days and forwards it to the appraiser using a standardized communication that carries no opinion of value. Our turn-time expectation for the appraiser's response is five business days. Regardless of the outcome you will receive a revised appraisal report that includes the appraiser's commentary on the conclusions, and the outcome is retained in your loan file.{{/block}}
{{#block "fairlending" page=1 y=0.62 pt=11}}Appraisals must describe the property and market area in factual, unbiased, and specific terms. If you believe the valuation reflects discrimination on the basis of race, color, religion, national origin, sex, disability, or familial status, tell us; we will review it and you may also file a complaint with the U.S. Department of Housing and Urban Development or the Consumer Financial Protection Bureau.{{/block}}
{{#block "contact" page=1 y=0.85 pt=10}}Questions: {{partner_name}} at {{contact_phone}}. This disclosure was prepared by an automated system on behalf of {{partner_name}}.{{/block}}`;
const ROV_DISCLOSURE_RULES: ContentRule[] = [
  DATE_RULE, AUTOMATION,
  R("heading-layout", "B4-1.3-12: a disclosure to the borrower outlining the ROV process", "layout", "heading", "heading on page 1, ≥ 12 pt, bold", { layout: { page: 1, minPt: 12, bold: true } }),
  R("contents", "B4-1.3-12: borrower name, property address, effective date, appraiser name, date of the ROV request; deficient areas; additional data (not to exceed five)", "presence", "your name\\(s\\); the property address; the effective date of the appraisal; the appraiser's name; the date of your request; a description of the unsupported, inaccurate, or deficient areas; and any additional data, information, or comparable properties \\(not to exceed five\\) with the source of each", "required request contents"),
  R("one-per-appraisal", "B4-1.3-12: only one borrower-initiated ROV is permitted per appraisal", "presence", "Only one borrower-initiated reconsideration of value is permitted per appraisal", "one ROV per appraisal"),
  R("none-after-closing", "B4-1.3-12: after a loan has closed, an ROV request is no longer allowed", "presence", "After the loan has closed, a reconsideration of value can no longer be submitted", "no ROV after closing"),
  R("turn-time", "B4-1.3-12: standardized communication with a definition of turn-time expectations (24.2 policy: 5 business_days_creditor)", "presence", "turn-time expectation for the appraiser's response is five business days", "turn-time expectation stated"),
  R("revised-report", "B4-1.3-12: a revised appraisal report that includes commentary on conclusions regardless of the outcome", "presence", "revised appraisal report that includes the appraiser's commentary on the conclusions", "revised report with commentary"),
  R("no-value-language", "AIR / 24.2 AI agent design: appraiser-facing text carries no value", "absence", "(target value|desired value|value needed)", "no value target language"),
  R("fair-lending", "B4-1.1-02/-04; ECOA/FHA complaint path (89 FR 60549)", "presence", "factual, unbiased, and specific terms", "fair-lending statement"),
];
const ROV_DISCLOSURE_SAMPLE = { ...FIXTURE, notice_date: "2026-10-16" };

// ------------------------------------------------------------------ NTC_REGZ_1026_35C_HPML_APPRAISAL_COPY
const HPML_COPY = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Copy of Your Appraisal(s) — Higher-Priced Mortgage Loan{{/block}}
{{#block "parties" page=1 y=0.1 pt=11}}{{date notice_date}}. From {{partner_name}}, the creditor on your application (loan number ending {{loan_number_last4}}). To: {{#each borrower_names}}{{this}}; {{/each}}Property: {{property_address}}.{{/block}}
{{#block "enclosed" page=1 y=0.18 pt=11 bold}}Enclosed are copies of every written appraisal performed in connection with your loan{{#if second_appraisal}}, including the second appraisal by a different appraiser{{/if}}: ${VALUATION_LIST}{{/block}}
{{#block "timing" page=1 y=0.3 pt=11}}Because your loan is a higher-priced mortgage loan, federal law (12 CFR 1026.35(c)(6)) requires us to give you a copy of each written appraisal no later than three business days before consummation; this timing cannot be waived. Based on delivery today, the earliest date your loan may be consummated is {{date earliest_consummation}}.{{#if consummation_scheduled_on}} Your closing is currently scheduled for {{date consummation_scheduled_on}}; copies were due by {{date copies_due_on}}.{{/if}}{{/block}}
{{#block "nocharge" page=1 y=0.42 pt=11 bold}}We will not charge you for these copies.{{/block}}
{{#if second_appraisal}}{{#block "fee" page=1 y=0.48 pt=10}}Two appraisals were required because the seller acquired the property within {{flip_days}} days of your contract at a price {{flip_pct_display}} below your contract price. You may be charged for only one of the two appraisals.{{/block}}{{/if}}
{{#block "regb" page=1 y=0.58 pt=10}}These copies also satisfy Regulation B (12 CFR 1002.14); the enclosed reconsideration-of-value information explains how to question the appraisal.{{/block}}
{{#block "contact" page=1 y=0.85 pt=10}}Questions: {{partner_name}} at {{contact_phone}}. This notice was prepared by an automated system on behalf of {{partner_name}}.{{/block}}`;
const HPML_COPY_RULES: ContentRule[] = [
  DATE_RULE, AUTOMATION, NO_CHARGE_ABSENCE,
  R("heading-layout", "12 CFR 1026.35(c)(6)", "layout", "heading", "heading on page 1, ≥ 12 pt, bold", { layout: { page: 1, minPt: 12, bold: true } }),
  R("every-appraisal", "12 CFR 1026.35(c)(6)(i): a copy of any written appraisal performed in connection with an HPML", "presence", "copies of every written appraisal performed in connection with your loan", "every written appraisal enclosed"),
  R("three-business-days-no-waiver", "12 CFR 1026.35(c)(6)(ii)(A); no waiver provision in (c)(6)", "presence", "no later than three business days before consummation; this timing cannot be waived", "3-business-day statement with no waiver"),
  R("no-charge", "12 CFR 1026.35(c)(6)(iii): a creditor shall not charge the consumer for a copy", "presence", "We will not charge you for these copies", "no-charge statement"),
  R("second-appraisal", "12 CFR 1026.35(c)(4)(iii): the two appraisals may not be performed by the same appraiser", "presence", "including the second appraisal by a different appraiser", "second appraisal by a different appraiser", { when: { "==": [{ var: "second_appraisal" }, true] } }),
  R("one-fee", "12 CFR 1026.35(c)(4)(vi): the creditor may charge the consumer for only one of the appraisals", "presence", "You may be charged for only one of the two appraisals", "single-fee statement", { when: { "==": [{ var: "second_appraisal" }, true] } }),
  R("flip-days", "12 CFR 1026.35(c)(4)(i): 90 / 180-day acquisition windows", "data_range", "flip_days", "flip window ≤ 180 days when a second appraisal is disclosed", { range: { min: 0, max: 180 }, when: { "==": [{ var: "second_appraisal" }, true] } }),
  R("valuations-nonempty", "24.2 R7: both copies", "data_range", "valuation_count", "at least one appraisal enclosed", { range: { min: 1 } }),
];
/** Worked example 2 (purchase fixture, Columbus OH): flip 75 days / 21.18 %; consummation Wed Nov 18, 2026 → copies by Fri Nov 13; delivered Thu Nov 12 → earliest consummation Tue Nov 17. */
const HPML_COPY_SAMPLE = { ...FIXTURE, borrower_names: ["Casey Purchaser", "Riley Purchaser"], property_address: "1187 Oakwood Ave, Columbus OH 43206", loan_number_last4: "4120", notice_date: "2026-11-12", earliest_consummation: "2026-11-17", consummation_scheduled_on: "2026-11-18", copies_due_on: "2026-11-13", second_appraisal: true, flip_days: 75, flip_pct_display: "21.18%", valuation_count: 2,
  valuations: [{ kind_label: "Uniform Residential Appraisal Report (Form 1004, UAD 3.6) — first appraisal", developed_at: "2026-10-28", version_no: 1 }, { kind_label: "Uniform Residential Appraisal Report (Form 1004, UAD 3.6) — second appraisal (different appraiser)", developed_at: "2026-11-09", version_no: 1 }] };

// ------------------------------------------------------------------ NTC_REGB_1002_14_COPY_NOT_CONSUMMATED
const NOT_CONSUMMATED = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Copies of Valuations for Your Application That Did Not Close{{/block}}
{{#block "parties" page=1 y=0.1 pt=11}}{{date notice_date}}. From {{partner_name}}, the creditor on your application (loan number ending {{loan_number_last4}}). To: {{#each borrower_names}}{{this}}; {{/each}}Property: {{property_address}}.{{/block}}
{{#block "why" page=1 y=0.18 pt=11}}On {{date determination_at}} we determined that your loan will not be consummated ({{reason_label}}). Federal law (Regulation B, 12 CFR 1002.14(a)(1)) requires us to provide copies of all appraisals and other written valuations developed in connection with your application no later than 30 days after that determination, whether credit is extended or denied or the application is incomplete or withdrawn.{{/block}}
{{#block "enclosed" page=1 y=0.3 pt=11 bold}}Enclosed: ${VALUATION_LIST}{{/block}}
{{#if hpml}}{{#block "hpml" page=1 y=0.42 pt=10}}Because the loan would have been a higher-priced mortgage loan, this also satisfies 12 CFR 1026.35(c)(6)(ii)(B).{{/block}}{{/if}}
{{#block "nocharge" page=1 y=0.5 pt=11 bold}}There is no charge for these copies.{{/block}}
{{#block "contact" page=1 y=0.85 pt=10}}Questions: {{partner_name}} at {{contact_phone}}. This notice was prepared by an automated system on behalf of {{partner_name}}.{{/block}}`;
const NOT_CONSUMMATED_RULES: ContentRule[] = [
  DATE_RULE, AUTOMATION, NO_CHARGE_ABSENCE,
  R("heading-layout", "12 CFR 1002.14(a)(1)", "layout", "heading", "heading on page 1, ≥ 12 pt, bold", { layout: { page: 1, minPt: 12, bold: true } }),
  R("thirty-days", "12 CFR 1002.14(a)(1): no later than 30 days after the creditor determines consummation will not occur; (a)(4) whether credit is extended or denied or the application is incomplete or withdrawn", "presence", "no later than 30 days after that determination, whether credit is extended or denied or the application is incomplete or withdrawn", "30-day rule stated"),
  R("determination", "24.2 R8: determination_at anchors the 30 days", "presence", "On (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4} we determined", "determination date"),
  R("within-30", "24.2 R8: copy_required_by = determination_at + 30 calendar days (denial Fri Oct 30 → Sun Nov 29)", "data_range", "days_after_determination", "sent within 30 days of the determination", { range: { min: 0, max: 30 } }),
  R("enclosed", "12 CFR 1002.14(b)(3); comment 14(b)(3)-1: an AVM report is a valuation", "presence", "Enclosed: .+developed", "every undelivered valuation listed"),
  R("hpml", "12 CFR 1026.35(c)(6)(ii)(B)", "presence", "1026\\.35\\(c\\)\\(6\\)\\(ii\\)\\(B\\)", "HPML statement when the loan was an HPML", { when: { "==": [{ var: "hpml" }, true] } }),
  R("no-charge", "12 CFR 1002.14(a)(3)", "presence", "There is no charge for these copies", "no-charge statement"),
  R("valuations-nonempty", "24.2 R8: every undelivered valuation", "data_range", "valuation_count", "at least one valuation enclosed", { range: { min: 1 } }),
];
/** R8 example: denial issued Fri Oct 30, 2026 → copies by Sun Nov 29 (scheduled Fri Nov 27); the undelivered AVM report developed Oct 12 is included. */
const NOT_CONSUMMATED_SAMPLE = { ...FIXTURE, notice_date: "2026-11-27", determination_at: "2026-10-30", reason_label: "application denied", days_after_determination: 28, hpml: false, valuation_count: 2,
  valuations: [{ kind_label: "Uniform Residential Appraisal Report (Form 1004, UAD 3.6)", developed_at: "2026-10-14", version_no: 1 }, { kind_label: "Automated valuation model report", developed_at: "2026-10-12", version_no: 1 }] };

export const VERSIONS_24_2: VersionInput[] = [
  V("NTC_REGB_1002_14_VALUATION_COPY", VALUATION_COPY, VALUATION_COPY_RULES, VALUATION_COPY_SAMPLE, "regb.2013 / 12 CFR 1002.14(a)(1)–(a)(5); comments 14(a)(1)-4, -6, -7; 14(b)(3)-1", "24.2 R4 copy engine — worked example 1 (refinance fixture; completion Fri Oct 16, 2026)"),
  V("NTC_FNMA_B4_1_3_12_ROV_DISCLOSURE", ROV_DISCLOSURE, ROV_DISCLOSURE_RULES, ROV_DISCLOSURE_SAMPLE, "fnma.selling.2026-09-02 / B4-1.3-12 (09/03/2025; SEL-2025-07); 89 FR 60549", "24.2 R4/R6 — ROV disclosure delivered with the first appraisal copy"),
  V("NTC_REGZ_1026_35C_HPML_APPRAISAL_COPY", HPML_COPY, HPML_COPY_RULES, HPML_COPY_SAMPLE, "regz.hpml / 12 CFR 1026.35(c)(4), (c)(6) (eCFR 9/03/2026)", "24.2 R7 — worked example 2 (purchase fixture, flip 75 days / 21.18 %; consummation Wed Nov 18, 2026)"),
  V("NTC_REGB_1002_14_COPY_NOT_CONSUMMATED", NOT_CONSUMMATED, NOT_CONSUMMATED_RULES, NOT_CONSUMMATED_SAMPLE, "regb.2013 / 12 CFR 1002.14(a)(1), (a)(4); 1026.35(c)(6)(ii)(B)", "24.2 R8 — denial Fri Oct 30, 2026 → copies by Sun Nov 29 (scheduled Fri Nov 27)"),
];
export const OVERRIDES_24_2: Record<string, Partial<NoticeTemplate>> = {
  NTC_REGB_1002_14_VALUATION_COPY: { citation: "12 CFR 1002.14(a)(1), (a)(3), (a)(5); comments 14(a)(1)-4, -6, -7", noticeClass: "disclosures.origination", channelPolicy: "esign_or_mail", separateDocument: false, mayCombineWith: ["NTC_FNMA_B4_1_3_12_ROV_DISCLOSURE", "NTC_REGZ_1026_35C_HPML_APPRAISAL_COPY"], retention: "regb_25m + fnma_loan_file_life_plus_4y", piiLevel: "high" },
  NTC_FNMA_B4_1_3_12_ROV_DISCLOSURE: { citation: "Selling Guide B4-1.3-12 (09/03/2025; SEL-2025-07); 89 FR 60549", noticeClass: "disclosures.origination", channelPolicy: "esign_or_mail", separateDocument: false, mayCombineWith: ["NTC_REGB_1002_14_VALUATION_COPY", "NTC_REGZ_1026_35C_HPML_APPRAISAL_COPY"], retention: "fnma_loan_file_life_plus_4y", piiLevel: "medium" },
  NTC_REGZ_1026_35C_HPML_APPRAISAL_COPY: { citation: "12 CFR 1026.35(c)(4)(iii), (c)(4)(vi), (c)(6)", noticeClass: "disclosures.origination", channelPolicy: "esign_or_mail", separateDocument: false, mayCombineWith: ["NTC_REGB_1002_14_VALUATION_COPY", "NTC_FNMA_B4_1_3_12_ROV_DISCLOSURE"], retention: "regz_hpml_2y + fnma_loan_file_life_plus_4y", piiLevel: "high" },
  NTC_REGB_1002_14_COPY_NOT_CONSUMMATED: { citation: "12 CFR 1002.14(a)(1), (a)(4); 1026.35(c)(6)(ii)(B)", noticeClass: "disclosures.origination", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: [], retention: "regb_25m", piiLevel: "high" },
};
