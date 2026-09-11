/**
 * §21.1 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * `NTC_FNMA_1103_SCIF` — Fannie Mae/Freddie Mac Form 1103, Supplemental Consumer Information Form (5/2022; LL-2022-03;
 * Selling Guide B2-2-06): presented to every borrower (English + five translations — Spanish, traditional Chinese,
 * Vietnamese, Korean, Tagalog), optional to answer. The form's own statements are rendered verbatim: "Your loan
 * transaction is likely to be conducted in English.", the six language options plus Other, "Your answer will NOT
 * negatively affect your mortgage application", "Your answer does not mean the Lender or Other Loan Participants agree to
 * communicate or provide documents in your preferred language", the homeownership-education and housing-counseling
 * questions with their formats, the HUD agency ID and completion date. Referenced, not owned: `NTC_SM_AI_INTERACTION_DISCLOSURE`
 * (20.3) and `NTC_SM_ESIGN_CONSENT` (20.3's catalog owner; 21.1 re-presents it for the application document class).
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const present = (...paths: string[]): Record<string, unknown> => ({ and: paths.map((p) => ({ present: p })) });

export const SCIF_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Supplemental Consumer Information Form{{/block}}
{{#block "ref" page=1 y=0.08 pt=10}}Fannie Mae/Freddie Mac Form 1103 ({{form_version}}) — {{language_edition_label}} edition. Borrower: {{borrower_name}}. Lender: {{lender_name}} (NMLSR ID {{lender_nmlsr_id}}). Loan originator: {{originator_name}}, NMLSR ID {{originator_nmlsr_id}}. Presented {{date presented_on}}.{{/block}}
{{#block "purpose" page=1 y=0.13 pt=10}}The purpose of this form is to collect information about the borrower's language preference and any homeownership education or housing counseling the borrower has completed. Completing this form is optional. The information will not be used for credit decisions.{{/block}}
{{#block "language_statement" page=1 y=0.2 pt=11 bold}}Language Preference. Your loan transaction is likely to be conducted in English. This section asks whether you would prefer to communicate in a language other than English. Your answer will NOT negatively affect your mortgage application. Your answer does not mean the Lender or Other Loan Participants agree to communicate or provide documents in your preferred language. It does not require the Lender or Other Loan Participants to provide translated documents, an interpreter, or communication in a language other than English.{{/block}}
{{#block "language_options" page=1 y=0.32 pt=10}}Preferred language (select one): English · Chinese · Korean · Spanish · Tagalog · Vietnamese · Other: ______ · I do not wish to respond. {{#if language_preference_answer}}Borrower's selection: {{language_preference_answer}}.{{else}}Borrower's selection: not answered (the borrower is not required to select any of the language options and may leave this section blank).{{/if}}{{/block}}
{{#block "education" page=1 y=0.45 pt=10}}Homeownership Education. Has the Borrower(s) completed homeownership education (group or web-based classes) within the last 12 months? {{#if education.completed}}Yes — format: {{education.format_label}}; Housing Counseling Agency ID # {{education.agency_hud_id}}{{#if education.agency_name}} ({{education.agency_name}}){{/if}}; Date of Completion {{date education.completed_on}}.{{else}}No / not answered. Formats: Attended Workshop in Person · Completed Web-Based Workshop; Housing Counseling Agency ID # (HUD-approved) or agency name if the status is unknown; Date of Completion mm/dd/yyyy.{{/if}}{{/block}}
{{#block "counseling" page=1 y=0.6 pt=10}}Housing Counseling. Has the Borrower(s) completed housing counseling (customizer-to-client services) within the last 12 months? {{#if counseling.completed}}Yes — format: {{counseling.format_label}}; Housing Counseling Agency ID # {{counseling.agency_hud_id}}{{#if counseling.agency_name}} ({{counseling.agency_name}}){{/if}}; Date of Completion {{date counseling.completed_on}}.{{else}}No / not answered. Formats: Face-to-Face · Telephone · Internet · Hybrid; Housing Counseling Agency ID # (HUD-approved) or agency name if the status is unknown; Date of Completion mm/dd/yyyy.{{/if}}{{/block}}
{{#block "retention" page=1 y=0.75 pt=9}}A copy of this form is retained in the loan file; the information is reported to Fannie Mae through Desktop Underwriter (Lender Letter LL-2022-03). Application date {{date application_date}}.{{/block}}`;

const LANGUAGE_EDITIONS = ["english", "spanish", "chinese_traditional", "vietnamese", "korean", "tagalog"];
export const SCIF_RULES: ContentRule[] = [
  R("form-identity", "Form 1103 (5/2022); LL-2022-03", "presence", "Supplemental Consumer Information Form.*Form 1103 \\(5/2022\\)", "the form's title and revision"),
  R("form-version-data", "Form 1103 (5/2022)", "data_equality", "form_version", "form_version is the 5/2022 revision", { predicate: { "==": [{ var: "form_version" }, "5/2022"] } }),
  R("edition", "LL-2022-03: English + Spanish, traditional Chinese, Vietnamese, Korean, Tagalog", "data_equality", "language_edition", "one of the six published editions", { predicate: { in: [{ var: "language_edition" }, LANGUAGE_EDITIONS] } }),
  R("borrower-lender", "B1-1-01: copy in the loan file; §1026.36(g) originator", "data_equality", "borrower_name,lender_name,originator_name,originator_nmlsr_id", "borrower, lender and the MLO of record's name and NMLSR ID", { predicate: present("borrower_name", "lender_name", "originator_name", "originator_nmlsr_id") }),
  R("conducted-in-english", "Form 1103 language section", "presence", "Your loan transaction is likely to be conducted in English\\.", "the form's own statement precedes the language question"),
  R("not-negatively-affect", "Form 1103 language section", "presence", "Your answer will NOT negatively affect your mortgage application", "the no-adverse-effect statement"),
  R("no-agreement-to-translate", "Form 1103 language section", "presence", "Your answer does not mean the Lender or Other Loan Participants agree to communicate or provide documents in your preferred language", "the no-translation-obligation statement"),
  R("language-options", "Form 1103 language section", "presence", "English · Chinese · Korean · Spanish · Tagalog · Vietnamese · Other", "the six language options plus Other"),
  R("language-statement-prominent", "Form 1103; 21.1 rule 6 'the language question is preceded by the form's own statement'", "layout", "language_statement", "the language statement is bold, on page 1, above the options", { layout: { page: 1, bold: true, minPt: 11, maxYFraction: 0.3 } }),
  R("optional-answer", "Form 1103: 'may leave this section blank'; 21.1 rule 6 not_answered", "data_equality", "language_preference_answer", "a blank answer is recorded as not answered, never followed up as a condition", { predicate: { or: [{ "!": [{ present: "language_preference_answer" }] }, { in: [{ var: "language_preference_answer" }, ["English", "Chinese", "Korean", "Spanish", "Tagalog", "Vietnamese", "Other", "I do not wish to respond"]] }] } }),
  R("education-question", "Form 1103 homeownership education", "presence", "Has the Borrower\\(s\\) completed homeownership education \\(group or web-based classes\\) within the last 12 months\\?", "the education question verbatim"),
  R("counseling-question", "Form 1103 housing counseling", "presence", "Has the Borrower\\(s\\) completed housing counseling \\(customizer-to-client services\\) within the last 12 months\\?", "the counseling question verbatim"),
  R("education-formats", "Form 1103", "presence", "Attended Workshop in Person|Completed Web-Based Workshop", "education formats"),
  R("counseling-formats", "Form 1103", "presence", "Face-to-Face · Telephone · Internet · Hybrid|Face-to-Face|Telephone|Internet|Hybrid", "counseling formats"),
  R("agency-id-and-date", "Form 1103", "presence", "Housing Counseling Agency ID #.*Date of Completion", "HUD agency ID and completion date fields"),
  R("education-evidence", "B2-2-06: HUD-approved agency (ID or name) and completion date when education is completed", "conditional", "education.agency_hud_id,education.agency_name,education.completed_on", "a completed education answer carries the agency (ID or name) and the completion date", { when: { "==": [{ var: "education.completed" }, true] }, predicate: { and: [{ or: [{ present: "education.agency_hud_id" }, { present: "education.agency_name" }] }, { present: "education.completed_on" }] } }),
  R("counseling-evidence", "B2-2-06 / SFC 184: agency and completion date when counseling is completed", "conditional", "counseling.agency_hud_id,counseling.agency_name,counseling.completed_on", "a completed counseling answer carries the agency (ID or name) and the completion date", { when: { "==": [{ var: "counseling.completed" }, true] }, predicate: { and: [{ or: [{ present: "counseling.agency_hud_id" }, { present: "counseling.agency_name" }] }, { present: "counseling.completed_on" }] } }),
  R("application-date", "LL-2022-03: required for application dates on or after March 1, 2023", "data_equality", "application_date", "application date on or after 2023-03-01", { predicate: { matches: ["application_date", "^(2023-(0[3-9]|1[0-2])|202[4-9]-|20[3-9][0-9]-)"] } }),
  R("retained-and-du", "LL-2022-03: maintain a copy in the loan file; report through DU", "presence", "retained in the loan file.*Desktop Underwriter", "retention and DU delivery statement"),
];
/** Worked example 1: SCIF presented 10:52 MST Mon Oct 5, 2026 (English edition), refinance — no education/counseling, language not answered. */
export const SCIF_SAMPLE: Record<string, unknown> = {
  form_version: "5/2022", language_edition: "english", language_edition_label: "English", borrower_name: "R. Borrower", lender_name: "Partner Bank", lender_nmlsr_id: "123456", originator_name: "M. Originator", originator_nmlsr_id: "1234567",
  presented_on: "2026-10-05", application_date: "2026-10-05", language_preference_answer: null, education: { completed: false }, counseling: { completed: false },
};

export const VERSIONS_21_1: VersionInput[] = [
  V("NTC_FNMA_1103_SCIF", SCIF_SOURCE, SCIF_RULES, SCIF_SAMPLE, "fnma.form1103.2022-05.v1", "Fannie Mae/Freddie Mac Form 1103 (5/2022); LL-2022-03; Selling Guide B2-2-06"),
];
export const OVERRIDES_21_1: Record<string, Partial<NoticeTemplate>> = {
  // "channels e-delivery/print": an application document under the 20.3 E-SIGN consent (application_documents), else print; a separate form, retained with the loan file.
  NTC_FNMA_1103_SCIF: { citation: "Fannie Mae/Freddie Mac Form 1103 (5/2022); Lender Letter LL-2022-03; Selling Guide B2-2-06", noticeClass: "origination_disclosures", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: [], retention: "fnma_loan_file_life_plus_4y", piiLevel: "medium" },
};
