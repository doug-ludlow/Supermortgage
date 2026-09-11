/**
 * §28.3 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * None of these goes to a borrower: they are the partner-office public notices 12 CFR 1003.5 requires, produced for the
 * home office and each branch office physically located in an MSA/MD (rule 16; T13).
 * `NTC_HMDA_1003_5B_DISCLOSURE_STMT_NOTICE` — §1003.5(b)(2): within three business days of the FFIEC's availability
 * notice, a written notice that the disclosure statement "may be obtained on the Bureau's Web site at
 * www.consumerfinance.gov/hmda"; available for five years (§1003.5(d)).
 * `NTC_HMDA_1003_5C_MODIFIED_LAR_NOTICE` — §1003.5(c)(1)–(2): a written notice that the loan/application register, as
 * modified by the Bureau to protect applicant and borrower privacy, may be obtained on the Bureau's Web site; made
 * available following the calendar year for which the data are collected; three years (§1003.5(d)).
 * `NTC_HMDA_1003_5E_LOBBY_NOTICE` — §1003.5(e): the general notice about the availability of HMDA data posted in the lobby
 * of the home office and each MSA/MD branch (the Bureau's suggested text); permanent.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const present = (...paths: string[]): Record<string, unknown> => ({ and: paths.map((p) => ({ present: p })) });
export const HMDA_BUREAU_URL = "www.consumerfinance.gov/hmda";
const RULE_SET = "regc.hmda.2026";
const LOCATIONS_BLOCK = `{{#block "locations" page=1 y=0.62 pt=10}}This notice is available upon request at: {{#each locations}}{{this}}; {{/each}}during the hours the office is normally open to the public for business.{{/block}}`;
const OFFICE_RULES = (which: string, years: number, untilField: string): ContentRule[] => [
  R("institution-named", "12 CFR 1003.5(b)(2)/(c): the financial institution's notice", "data_equality", "institution_name", "the partner (the financial institution) is named", { predicate: present("institution_name") }),
  R("bureau-website", `12 CFR 1003.5${which}: "may be obtained on the Bureau's Web site at www.consumerfinance.gov/hmda"`, "presence", "may be obtained on the Bureau'?s Web ?site at www\\.consumerfinance\\.gov/hmda", "the Bureau's website statement in the regulation's words"),
  R("data-year", "12 CFR 1003.5(b)(2)/(c): the notice identifies the calendar year of the data", "data_range", "year", "a plausible HMDA data year", { range: { min: 2018, max: 2100 } }),
  R("locations", "12 CFR 1003.5(b)(2)/(c)(2): at the home office and each branch office physically located in each MSA and each MD", "data_equality", "locations", "the home office and the MSA/MD branch offices are listed", { predicate: { and: [{ present: "locations" }, { matches: ["locations.0", "[Hh]ome [Oo]ffice"] }] } }),
  R("availability-period", `12 CFR 1003.5(d): available for a period of ${years} years`, "presence", `for (a period of )?${years === 5 ? "five" : "three"} years`, `the ${years}-year availability period is stated`),
  R("available-until", "12 CFR 1003.5(d); 28.3 data model available_until", "data_equality", untilField, "the notice carries the date through which it stays available", { predicate: present(untilField) }),
  R("no-borrower-pii", "28.3 guardrails: public notices carry no applicant or borrower data", "absence", "\\b\\d{3}-\\d{2}-\\d{4}\\b|ULI|census tract [0-9]{11}", "no SSN, ULI or record-level data on a public notice"),
  R("heading-prominent", "28.3 rule 16: a written notice the public can find", "layout", "heading", "the heading is bold on page 1", { layout: { page: 1, bold: true, minPt: 12, maxYFraction: 0.1 } }),
];

// ------------------------------------------------------------------ §1003.5(b)(2) disclosure-statement availability notice
export const DISCLOSURE_STMT_NOTICE_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}HOME MORTGAGE DISCLOSURE ACT NOTICE — DISCLOSURE STATEMENT AVAILABILITY{{/block}}
{{#block "body" page=1 y=0.14 pt=11}}The Home Mortgage Disclosure Act (HMDA) disclosure statement of {{institution_name}} for calendar year {{year}} may be obtained on the Bureau's Web site at ${HMDA_BUREAU_URL}. The disclosure statement was prepared by the Federal Financial Institutions Examination Council (FFIEC) from the loan/application register {{institution_name}} submitted for {{year}} and became available on {{date ffiec_notice_received_on}}.{{/block}}
{{#block "period" page=1 y=0.34 pt=11}}This written notice is made available to the public upon request at the offices listed below for a period of five years, from {{date made_available_on}} through {{date available_until}}, as required by 12 CFR 1003.5(b)(2) and (d).{{/block}}
{{#block "help" page=1 y=0.46 pt=10}}For assistance obtaining the disclosure statement, contact {{contact_name}} at {{contact_phone}} or {{contact_email}}. HMDA data for many other financial institutions are also available at ${HMDA_BUREAU_URL}.{{/block}}
${LOCATIONS_BLOCK}`;
export const DISCLOSURE_STMT_NOTICE_RULES: ContentRule[] = [
  ...OFFICE_RULES("(b)(2)", 5, "available_until"),
  R("disclosure-statement", "12 CFR 1003.5(b)(2): the notice conveys that the disclosure statement may be obtained", "presence", "disclosure statement .*may be obtained on the Bureau", "the disclosure statement is the subject of the notice"),
  R("within-3bd", "12 CFR 1003.5(b)(2): no later than three business days after receiving notice from the FFIEC", "data_equality", "made_available_within_3bd", "made available on or before the 3-business-day due date (ops-28-3 disclosureNoticeDue)", { predicate: { and: [{ present: "due_on" }, { "==": [{ var: "made_available_within_3bd" }, true] }] } }),
];
/** T13: FFIEC notice received Wed Jun 16, 2027 → available at the home office and MSA branches Mon Jun 21, 2027 (the creditor calendar's due date is Tue Jun 22 — Juneteenth observed Fri Jun 18); available_until 2032-06-21. */
export const DISCLOSURE_STMT_NOTICE_SAMPLE: Record<string, unknown> = {
  institution_name: "Partner Bank", year: 2026, ffiec_notice_received_on: "2027-06-16", due_on: "2027-06-22", made_available_on: "2027-06-21", made_available_within_3bd: true, available_until: "2032-06-21",
  locations: ["Home office — 100 Partner Plaza, Phoenix, AZ 85004 (Phoenix-Mesa-Chandler MSA)", "Branch — 200 High Street, Columbus, OH 43215 (Columbus MSA)"],
  contact_name: "HMDA Compliance Officer", contact_phone: "1-800-555-0100", contact_email: "hmda@partnerbank.example",
};

// ------------------------------------------------------------------ §1003.5(c) modified loan/application register notice
export const MODIFIED_LAR_NOTICE_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}HOME MORTGAGE DISCLOSURE ACT NOTICE — MODIFIED LOAN/APPLICATION REGISTER{{/block}}
{{#block "body" page=1 y=0.14 pt=11}}The loan/application register of {{institution_name}} for calendar year {{year}}, as modified by the Bureau of Consumer Financial Protection to protect applicant and borrower privacy, may be obtained on the Bureau's Web site at ${HMDA_BUREAU_URL}. The modified register is available following the calendar year for which the data are collected.{{/block}}
{{#block "period" page=1 y=0.34 pt=11}}This written notice is made available to the public upon request at the offices listed below for a period of three years, from {{date made_available_on}} through {{date available_until}}, as required by 12 CFR 1003.5(c) and (d).{{/block}}
{{#block "help" page=1 y=0.46 pt=10}}For assistance obtaining the modified loan/application register, contact {{contact_name}} at {{contact_phone}} or {{contact_email}}.{{/block}}
${LOCATIONS_BLOCK}`;
export const MODIFIED_LAR_NOTICE_RULES: ContentRule[] = [
  ...OFFICE_RULES("(c)(1)", 3, "available_until"),
  R("modified-lar", "12 CFR 1003.5(c)(1): the register as modified by the Bureau to protect applicant and borrower privacy", "presence", "as modified by the Bureau .*to protect applicant and borrower privacy", "the modified register is the subject of the notice"),
  R("following-year", "12 CFR 1003.5(c)(2): made available following the calendar year for which the data are collected", "data_equality", "following_data_year", "made available in the year after the data year", { predicate: { "==": [{ var: "following_data_year" }, true] } }),
];
/** 2026 data: the notice available Mon Mar 1, 2027 (policy: by Mar 31 following the data year — 28.3-Q6) through 2030-03-01. */
export const MODIFIED_LAR_NOTICE_SAMPLE: Record<string, unknown> = {
  institution_name: "Partner Bank", year: 2026, data_year_end: "2026-12-31", made_available_on: "2027-03-01", following_data_year: true, available_until: "2030-03-01",
  locations: ["Home office — 100 Partner Plaza, Phoenix, AZ 85004 (Phoenix-Mesa-Chandler MSA)", "Branch — 200 High Street, Columbus, OH 43215 (Columbus MSA)"],
  contact_name: "HMDA Compliance Officer", contact_phone: "1-800-555-0100", contact_email: "hmda@partnerbank.example",
};

// ------------------------------------------------------------------ §1003.5(e) lobby notice (the Bureau's suggested general notice)
export const LOBBY_NOTICE_SOURCE = `{{#block "heading" page=1 y=0.05 pt=16 bold}}HOME MORTGAGE DISCLOSURE ACT NOTICE{{/block}}
{{#block "body" page=1 y=0.14 pt=12}}The HMDA data about our residential mortgage lending are available online for review. The data show geographic distribution of loans and applications; ethnicity, race, sex, age, and income of applicants and borrowers; and information about loan approvals and denials. HMDA data for many other financial institutions are also available online. For more information, visit the Consumer Financial Protection Bureau's Web site (${HMDA_BUREAU_URL}).{{/block}}
{{#block "institution" page=1 y=0.4 pt=11}}{{institution_name}} — posted in the lobby of the home office and of each branch office physically located in a metropolitan statistical area or metropolitan division, as required by 12 CFR 1003.5(e).{{/block}}
{{#block "locations" page=1 y=0.5 pt=10}}Posted at: {{#each locations}}{{this}}; {{/each}}{{/block}}`;
export const LOBBY_NOTICE_RULES: ContentRule[] = [
  R("institution-named", "12 CFR 1003.5(e): the financial institution's general notice", "data_equality", "institution_name", "the partner (the financial institution) is named", { predicate: present("institution_name") }),
  R("availability-statement", "12 CFR 1003.5(e): a general notice about the availability of its HMDA data", "presence", "HMDA data about our residential mortgage lending are available online", "the availability statement in the Bureau's suggested words"),
  R("data-described", "12 CFR 1003.5(e); the Bureau's suggested lobby notice", "presence", "geographic distribution of loans and applications; ethnicity, race, sex, age, and income", "the data are described"),
  R("bureau-website", "12 CFR 1003.5(e): the Bureau's Web site", "presence", "www\\.consumerfinance\\.gov/hmda", "the Bureau's website is named"),
  R("lobby-locations", "12 CFR 1003.5(e): in the lobby of its home office and of each branch office physically located in each MSA and each MD", "data_equality", "locations", "the home office and the MSA/MD branches are listed", { predicate: { and: [{ present: "locations" }, { matches: ["locations.0", "[Hh]ome [Oo]ffice"] }] } }),
  R("no-borrower-pii", "28.3 guardrails: public notices carry no applicant or borrower data", "absence", "\\b\\d{3}-\\d{2}-\\d{4}\\b|ULI", "no SSN or ULI on a public notice"),
  R("heading-prominent", "12 CFR 1003.5(e): a lobby notice the public can see", "layout", "heading", "the heading is bold, ≥ 14 pt, on page 1", { layout: { page: 1, bold: true, minPt: 14, maxYFraction: 0.1 } }),
];
export const LOBBY_NOTICE_SAMPLE: Record<string, unknown> = {
  institution_name: "Partner Bank",
  locations: ["Home office lobby — 100 Partner Plaza, Phoenix, AZ 85004 (Phoenix-Mesa-Chandler MSA)", "Branch lobby — 200 High Street, Columbus, OH 43215 (Columbus MSA)"],
};

export const VERSIONS_28_3: VersionInput[] = [
  V("NTC_HMDA_1003_5B_DISCLOSURE_STMT_NOTICE", DISCLOSURE_STMT_NOTICE_SOURCE, DISCLOSURE_STMT_NOTICE_RULES, DISCLOSURE_STMT_NOTICE_SAMPLE, RULE_SET, "12 CFR 1003.5(b)(2), (d); 28.3 rule 16 / T13 (FFIEC notice Wed Jun 16, 2027 → available Mon Jun 21, 2027 through 2032-06-21)"),
  V("NTC_HMDA_1003_5C_MODIFIED_LAR_NOTICE", MODIFIED_LAR_NOTICE_SOURCE, MODIFIED_LAR_NOTICE_RULES, MODIFIED_LAR_NOTICE_SAMPLE, RULE_SET, "12 CFR 1003.5(c)(1)–(2), (d); 28.3 rule 16 / open question 6 (available by Mar 31 following the data year; three years)"),
  V("NTC_HMDA_1003_5E_LOBBY_NOTICE", LOBBY_NOTICE_SOURCE, LOBBY_NOTICE_RULES, LOBBY_NOTICE_SAMPLE, RULE_SET, "12 CFR 1003.5(e); the Bureau's suggested lobby notice text; 28.3 rule 16 (permanent)"),
];
/** Partner-office artifacts (no borrower recipient): printed and posted/kept at the home office and MSA/MD branches; e-mailed to the office managers without E-SIGN consent; retained with the HMDA file. */
export const OVERRIDES_28_3: Record<string, Partial<NoticeTemplate>> = {
  NTC_HMDA_1003_5B_DISCLOSURE_STMT_NOTICE: { citation: "12 CFR 1003.5(b)(2), (d)", noticeClass: "hmda_public_notice", channelPolicy: "electronic_ok_without_esign", separateDocument: true, mayCombineWith: ["NTC_HMDA_1003_5C_MODIFIED_LAR_NOTICE"], retention: "hmda_3y (kept available five years per §1003.5(d))", piiLevel: "low" },
  NTC_HMDA_1003_5C_MODIFIED_LAR_NOTICE: { citation: "12 CFR 1003.5(c)(1)–(2), (d)", noticeClass: "hmda_public_notice", channelPolicy: "electronic_ok_without_esign", separateDocument: true, mayCombineWith: ["NTC_HMDA_1003_5B_DISCLOSURE_STMT_NOTICE"], retention: "hmda_3y", piiLevel: "low" },
  NTC_HMDA_1003_5E_LOBBY_NOTICE: { citation: "12 CFR 1003.5(e)", noticeClass: "hmda_public_notice", channelPolicy: "electronic_ok_without_esign", separateDocument: true, mayCombineWith: [], retention: "hmda_3y (posted permanently)", piiLevel: "low" },
};
