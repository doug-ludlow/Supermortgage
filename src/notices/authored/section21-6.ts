/**
 * §21.6 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * `NTC_REGB_1002_9_ADVERSE_ACTION` — Reg B App. C forms C-1/C-3 combined with the FCRA §615(a) content, rendered per applicant
 * (identical ECOA content; the FCRA block carries only that applicant's score, range, ≤ 4 key factors — 5 with inquiries — score
 * date and provider, every CRA that furnished a report, the no-decision / free-report / dispute statements); the Federal agency
 * block names the FTC for a non-bank creditor (Appendix A item 9); a Colorado consumer's notice embeds the SB 26-189 explanation
 * (role of the ADMT, human review, correction) so the ECOA/FCRA notice also satisfies 6-1-1704 (6-1-1704(6)(a)).
 * `NTC_REGB_1002_9_COUNTEROFFER` — form C-4: the counteroffer terms and expiry plus the adverse-action content on the original
 * terms, so no second notice is needed if the counteroffer is not accepted (comment 9(a)(1)-6).
 * `NTC_REGB_1002_9_NOIA` — form C-6 (§1002.9(c)(2)): the information needed, the designated period and the statement that failure
 * to respond "will result in no further consideration being given to the application".
 * Referenced, not owned: `NTC_CO_SB26_189_ADMT_NOTICE` (20.3's catalog owner; 21.6 embeds the adverse_outcome_explanation content).
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const present = (...paths: string[]): Record<string, unknown> => ({ and: paths.map((p) => ({ present: p })) });
const NOT_A_REASON = "refer with caution|internal standards|internal policies|qualifying score|score cutoff|\\brace\\b|\\bcolor\\b|religion|national origin|\\bsex\\b|marital status|\\bage\\b|public assistance|desktop underwriter|\\bdu\\b";

const ECOA_BLOCK = `{{#block "ecoa" page=1 y=0.5 pt=10}}NOTICE: The Federal Equal Credit Opportunity Act prohibits creditors from discriminating against credit applicants on the basis of race, color, religion, national origin, sex, marital status, age (provided the applicant has the capacity to enter into a binding contract); because all or part of the applicant's income derives from any public assistance program; or because the applicant has in good faith exercised any right under the Consumer Credit Protection Act. The Federal agency that administers compliance with this law concerning this creditor is {{federal_agency_name}}, {{federal_agency_address}}.{{/block}}`;
const FCRA_BLOCK = `{{#block "fcra" page=1 y=0.62 pt=10}}{{#if uses_consumer_report}}Disclosure of use of information obtained from an outside source: our decision was based in whole or in part on information obtained in a report from the consumer reporting agency listed below. {{#each fcra.cra}}{{name}}, {{address}}, toll-free {{toll_free}}; {{/each}}{{fcra.no_decision_statement}} {{fcra.free_report_statement}} {{fcra.dispute_statement}} {{#if fcra.no_score}}No credit score was used in taking this action.{{else}}Your credit score: {{fcra.score}}. Scores range from a low of {{fcra.score_range_low}} to a high of {{fcra.score_range_high}}. Date the score was created: {{date fcra.score_date}}. Score provider: {{fcra.score_provider}}. Key factors that adversely affected your credit score: {{#each fcra.key_factors}}{{this}}; {{/each}}{{/if}}{{else}}No consumer report was used in taking this action.{{/if}}{{/block}}`;
const CO_BLOCK = `{{#block "colorado" page=2 y=0.1 pt=10}}{{#if colorado_consumer}}Colorado notice (C.R.S. 6-1-1704 and 6-1-1705): {{co_admt.role_description}} {{co_admt.additional_information_instructions}} {{co_admt.human_review_instructions}} {{co_admt.correction_instructions}}{{else}}{{human_review_statement}}{{/if}}{{/block}}`;

export const ADVERSE_ACTION_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}STATEMENT OF CREDIT DENIAL, TERMINATION, OR CHANGE{{/block}}
{{#block "parties" page=1 y=0.08 pt=10}}Date: {{date notice_date}}. Applicant: {{applicant_name}}. Application {{application_id}}. Creditor: {{creditor_name}}, {{creditor_address}}.{{/block}}
{{#block "action" page=1 y=0.14 pt=11 bold}}Description of action taken: {{action_statement}}{{/block}}
{{#block "reasons" page=1 y=0.2 pt=11}}Principal reason(s) for the action taken: {{#each principal_reasons}}({{@index}}) {{statement_text}}. {{/each}}{{/block}}
${ECOA_BLOCK}
${FCRA_BLOCK}
${CO_BLOCK}
{{#block "closing" page=2 y=0.5 pt=10}}If you have questions about this notice, contact {{creditor_name}} at {{creditor_address}}. This notice is retained for 25 months ({{retention_class}}).{{/block}}`;

export const ADVERSE_ACTION_RULES: ContentRule[] = [
  R("action-taken", "12 CFR 1002.9(a)(2)(i): a statement of the action taken", "presence", "Description of action taken: .+", "the statement of the action taken"),
  R("creditor-name-address", "12 CFR 1002.9(a)(2)(ii): the name and address of the creditor (the partner)", "data_equality", "creditor_name,creditor_address", "creditor name and address present", { predicate: present("creditor_name", "creditor_address") }),
  R("ecoa-notice", "12 CFR 1002.9(b)(1) ECOA notice", "presence", "Federal Equal Credit Opportunity Act prohibits creditors from discriminating", "the ECOA notice substantially similar to (b)(1)"),
  R("federal-agency", "12 CFR 1002.9(b)(1); Appendix A item 9 (FTC) / item 1 (CFPB)", "presence", "Federal Trade Commission, Consumer Response Center, 600 Pennsylvania Avenue NW, Washington, DC 20580|Bureau of Consumer Financial Protection, 1700 G Street NW, Washington, DC 20552", "the Federal agency's name and address as listed in Appendix A"),
  R("reasons-count", "comment 9(b)(2)-1: more than four reasons is not likely to be helpful; §1002.9(b)(2): at least one specific reason", "data_range", "reasons_count", "one to four principal reasons", { range: { min: 1, max: 4 } }),
  R("reasons-specific", "12 CFR 1002.9(b)(2); comments 9(b)(2)-2, -4, -9; B3-2-11; §1002.4(b)", "data_equality", "reasons_text_lc", "reasons are the taxonomy's statements — never a DU recommendation, an internal-standards or score-cutoff statement, or a prohibited basis", { predicate: { "!": [{ matches: ["reasons_text_lc", NOT_A_REASON] }] } }),
  R("statement-of-reasons", "12 CFR 1002.9(a)(2)(i)", "data_equality", "statement_of_reasons_provided", "the specific reasons are stated (not merely the right to request them)", { predicate: { "==": [{ var: "statement_of_reasons_provided" }, true] } }),
  R("fcra-cra-contact", "15 U.S.C. 1681m(a)(3)(A): name, address and toll-free telephone number of the CRA", "conditional", "fcra.cra", "every CRA that furnished a report is listed with address and toll-free number", { when: { "==": [{ var: "uses_consumer_report" }, true] }, predicate: present("fcra.cra") }),
  R("fcra-three-cras", "15 U.S.C. 1681m(a)(3)(A); tri-merge (B3-5.2-01)", "conditional", "fcra.cra", "the three nationwide CRAs' contact blocks", { when: { "==": [{ var: "uses_consumer_report" }, true] }, predicate: { and: [{ matches: ["fcra.cra.0.name", "Equifax|Experian|TransUnion"] }, { matches: ["fcra.cra.1.name", "Equifax|Experian|TransUnion"] }, { matches: ["fcra.cra.2.name", "Equifax|Experian|TransUnion"] }] } }),
  R("fcra-no-decision", "15 U.S.C. 1681m(a)(3)(B)", "presence", "did not make the decision to take the adverse action", "the CRA-did-not-decide statement"),
  R("fcra-free-report", "15 U.S.C. 1681m(a)(4)(A); §1681j 60-day period", "presence", "free copy of your consumer report.*60 days", "the free-report right with the 60-day period"),
  R("fcra-dispute", "15 U.S.C. 1681m(a)(4)(B); §1681i", "presence", "right to dispute", "the dispute right"),
  R("fcra-score", "15 U.S.C. 1681m(a)(2)(A); 1681g(f)(1)", "conditional", "fcra.score", "the numerical score used is disclosed when a score was used", { when: { and: [{ "==": [{ var: "uses_consumer_report" }, true] }, { "!": [{ "==": [{ var: "fcra.no_score" }, true] }] }] }, predicate: present("fcra.score", "fcra.score_date", "fcra.score_provider") }),
  R("fcra-score-range", "15 U.S.C. 1681g(f)(1)(B): the range of possible scores under the model used", "conditional", "fcra.score", "the score lies within the model's range", { when: { and: [{ "==": [{ var: "uses_consumer_report" }, true] }, { "!": [{ "==": [{ var: "fcra.no_score" }, true] }] }] }, predicate: { and: [{ ">=": [{ var: "fcra.score" }, { var: "fcra.score_range_low" }] }, { "<=": [{ var: "fcra.score" }, { var: "fcra.score_range_high" }] }] } }),
  R("fcra-key-factors-max", "15 U.S.C. 1681g(f)(1)(C), (f)(9): at most 4 key factors, 5 where inquiries is one", "conditional", "fcra.key_factor_count", "no more than four key factors (five with inquiries)", { when: { "==": [{ var: "uses_consumer_report" }, true] }, predicate: { or: [{ "<=": [{ var: "fcra.key_factor_count" }, 4] }, { and: [{ "==": [{ var: "fcra.inquiries_key_factor" }, true] }, { "<=": [{ var: "fcra.key_factor_count" }, 5] }] }] } }),
  R("colorado-explanation", "C.R.S. 6-1-1704(3), 6-1-1705(1)(a); 21.6 rule 7", "conditional", "co_admt.role_description", "a Colorado consumer's notice carries the ADMT role description, the human-review and the correction instructions", { when: { "==": [{ var: "colorado_consumer" }, true] }, predicate: present("co_admt.role_description", "co_admt.human_review_instructions", "co_admt.correction_instructions") }),
  R("colorado-text", "C.R.S. 6-1-1704(3): 'the role the covered ADMT played'", "conditional", "colorado_consumer", "the rendered notice names the automated system's role and the human-review route", { when: { "==": [{ var: "colorado_consumer" }, true] }, predicate: { and: [{ present: "co_admt.role_description" }, { matches: ["co_admt.role_description", "[Aa]utomated"] }, { matches: ["co_admt.human_review_instructions", "human review"] }] } }),
  R("action-prominent", "Reg B App. C form C-1 layout; 21.6 audit", "layout", "action", "the action statement is bold on page 1", { layout: { page: 1, bold: true, minPt: 11, maxYFraction: 0.2 } }),
];
/** Worked example 1: refinance fixture, denial after a Refer with Caution — sole applicant, notice sent Mon Oct 26, 2026 by e-delivery; representative score 712 (Classic FICO — Experian/Fair Isaac Risk Model V2, created 2026-10-05). */
export const ADVERSE_ACTION_SAMPLE: Record<string, unknown> = {
  creditor_name: "Partner Bank", creditor_address: "100 Partner Plaza, Phoenix, AZ 85004", applicant_name: "R. Borrower", application_id: "APP-REFI-1", notice_date: "2026-10-26", decided_on: "2026-10-26",
  action_statement: "Your application for credit has been denied.",
  principal_reasons: [{ statement_text: "Excessive obligations in relation to income", reason_code: "dti_excessive", hmda_denial_code: 1 }, { statement_text: "Delinquent past or present credit obligations with others", reason_code: "credit_delinquent", hmda_denial_code: 3 }],
  reasons_count: 2, reasons_text_lc: "excessive obligations in relation to income | delinquent past or present credit obligations with others", statement_of_reasons_provided: true,
  federal_agency_name: "Federal Trade Commission", federal_agency_address: "Consumer Response Center, 600 Pennsylvania Avenue NW, Washington, DC 20580",
  uses_consumer_report: true,
  fcra: { applicant_id: "B1", used_consumer_report: true, cra: [{ name: "Equifax", address: "P.O. Box 740241, Atlanta, GA 30374", phone: "1-800-685-1111", toll_free: "1-800-685-1111" }, { name: "Experian", address: "P.O. Box 2002, Allen, TX 75013", phone: "1-888-397-3742", toll_free: "1-888-397-3742" }, { name: "TransUnion", address: "P.O. Box 1000, Chester, PA 19016", phone: "1-800-916-8800", toll_free: "1-800-916-8800" }],
    no_score: false, score: 712, score_range_low: 300, score_range_high: 850, key_factors: ["Proportion of balances to credit limits on revolving accounts is too high", "Serious delinquency", "Too many accounts with balances", "Length of time accounts have been established"], key_factor_count: 4, inquiries_key_factor: false,
    score_date: "2026-10-05", score_provider: "Classic FICO — Experian/Fair Isaac Risk Model V2", model: "Experian/Fair Isaac Risk Model V2", bureau: "Experian",
    no_decision_statement: "The consumer reporting agency did not make the decision to take the adverse action and is unable to provide you the specific reasons why the adverse action was taken.", free_report_statement: "You have the right to obtain a free copy of your consumer report from the consumer reporting agency named above within 60 days of receiving this notice.", dispute_statement: "You have the right to dispute with the consumer reporting agency the accuracy or completeness of any information in your consumer report." },
  colorado_consumer: false, co_admt: null, human_review_statement: "You may request meaningful human review and reconsideration of this decision by a different underwriter: write to Partner Bank, 100 Partner Plaza, Phoenix, AZ 85004, or reply through your application portal.", mlo_nmlsr_id_required: false, retention_class: "regb_25m",
};

export const COUNTEROFFER_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}NOTICE OF ACTION TAKEN — COUNTEROFFER{{/block}}
{{#block "parties" page=1 y=0.08 pt=10}}Date: {{date notice_date}}. Applicant: {{applicant_name}}. Application {{application_id}}. Creditor: {{creditor_name}}, {{creditor_address}}.{{/block}}
{{#block "action" page=1 y=0.14 pt=11 bold}}Description of action taken: {{action_statement}}{{/block}}
{{#block "terms" page=1 y=0.2 pt=11}}Counteroffer terms: loan amount {{money counteroffer.loan_amount_cents}} at a note rate of {{counteroffer.note_rate}} % ({{counteroffer.product_code}}, loan-to-value {{counteroffer.ltv}} %){{#if counteroffer.conditions}}; conditions: {{#each counteroffer.conditions}}{{this}}; {{/each}}{{/if}} This counteroffer expires on {{date counteroffer.expires_on}}. {{acceptance_instructions}}{{#if original_terms}} Terms you requested: {{money original_terms.loan_amount_cents}} at {{original_terms.note_rate}} % ({{original_terms.product_code}}, loan-to-value {{original_terms.ltv}} %).{{/if}}{{/block}}
{{#block "reasons" page=1 y=0.34 pt=11}}{{#if combined_notice}}If you do not accept this counteroffer by {{date counteroffer.expires_on}}, this notice is also our notice of adverse action on the terms you requested, and no further notice will be sent. Principal reason(s) we cannot offer the terms you requested: {{#each principal_reasons}}({{@index}}) {{statement_text}}. {{/each}}{{else}}If you do not accept this counteroffer, we will send you a separate notice of the action taken on the terms you requested.{{/if}}{{/block}}
${ECOA_BLOCK}
${FCRA_BLOCK}
${CO_BLOCK}
{{#block "closing" page=2 y=0.5 pt=10}}If you have questions about this notice, contact {{creditor_name}} at {{creditor_address}}. This notice is retained for 25 months ({{retention_class}}).{{/block}}`;

export const COUNTEROFFER_RULES: ContentRule[] = [
  R("counteroffer-terms", "12 CFR 1002.9(a)(1)(iv); comment 9(a)(1)-5: the counteroffer's own expiry", "data_equality", "counteroffer.loan_amount_cents,counteroffer.note_rate,counteroffer.expires_on", "amount, rate and expiry of the counteroffer", { predicate: present("counteroffer.loan_amount_cents", "counteroffer.note_rate", "counteroffer.expires_on") }),
  R("expiry-stated", "comment 9(a)(1)-5", "presence", "This counteroffer expires on", "the expiration date is stated"),
  R("acceptance-route", "12 CFR 1002.9(a)(1)(iv): express acceptance or use", "presence", "To accept", "how to accept"),
  R("combined-adverse-content", "comment 9(a)(1)-6; form C-4: combined counteroffer and adverse action notice", "conditional", "principal_reasons", "a combined notice carries the reasons for the adverse action on the original terms", { when: { "==": [{ var: "combined_notice" }, true] }, predicate: { and: [{ ">=": [{ var: "reasons_count" }, 1] }, { "<=": [{ var: "reasons_count" }, 4] }] } }),
  R("combined-no-second-notice", "comment 9(a)(1)-6", "conditional", "combined_notice", "the combined notice says no further notice will be sent", { when: { "==": [{ var: "combined_notice" }, true] }, predicate: { "==": [{ var: "adverse_action_on_original_terms" }, true] } }),
  R("reasons-specific", "12 CFR 1002.9(b)(2); comments 9(b)(2)-2, -4, -9", "data_equality", "reasons_text_lc", "reasons from the taxonomy only", { predicate: { "!": [{ matches: ["reasons_text_lc", NOT_A_REASON] }] } }),
  R("creditor-name-address", "12 CFR 1002.9(a)(2)(ii)", "data_equality", "creditor_name,creditor_address", "creditor name and address present", { predicate: present("creditor_name", "creditor_address") }),
  R("ecoa-notice", "12 CFR 1002.9(b)(1)", "presence", "Federal Equal Credit Opportunity Act prohibits creditors from discriminating", "the ECOA notice"),
  R("federal-agency", "Appendix A item 9 / item 1", "presence", "Federal Trade Commission, Consumer Response Center, 600 Pennsylvania Avenue NW, Washington, DC 20580|Bureau of Consumer Financial Protection, 1700 G Street NW, Washington, DC 20552", "the Federal agency block"),
  R("fcra-when-used", "15 U.S.C. 1681m(a): the report was used in the overall decision", "conditional", "fcra.cra", "the FCRA block when a consumer report was used", { when: { "==": [{ var: "uses_consumer_report" }, true] }, predicate: present("fcra.cra", "fcra.no_decision_statement") }),
  R("fcra-key-factors-max", "15 U.S.C. 1681g(f)(1)(C), (f)(9)", "conditional", "fcra.key_factor_count", "no more than four key factors (five with inquiries)", { when: { "==": [{ var: "uses_consumer_report" }, true] }, predicate: { or: [{ "<=": [{ var: "fcra.key_factor_count" }, 4] }, { and: [{ "==": [{ var: "fcra.inquiries_key_factor" }, true] }, { "<=": [{ var: "fcra.key_factor_count" }, 5] }] }] } }),
  R("action-prominent", "Reg B App. C form C-4 layout", "layout", "action", "the action statement is bold on page 1", { layout: { page: 1, bold: true, minPt: 11, maxYFraction: 0.2 } }),
];
/** Worked example 2: purchase fixture — appraisal $445,000 against a $457,780 contract; counteroffer $400,500 (90 % of $445,000) at the same rate, C-4 combined, sent Tue Nov 3, 2026, expiring Wed Nov 18. */
export const COUNTEROFFER_SAMPLE: Record<string, unknown> = {
  ...ADVERSE_ACTION_SAMPLE, creditor_address: "100 Partner Plaza, Columbus, OH 43215", applicant_name: "A. Applicant", application_id: "APP-PURCH-1", notice_date: "2026-11-03", decided_on: "2026-11-03",
  action_statement: "We are unable to offer you credit on the terms you requested, but we can offer you credit on the following terms.",
  combined_notice: true, adverse_action_on_original_terms: true,
  counteroffer: { loan_amount_cents: 40_050_000n, note_rate: "6.125", product_code: "FNMA30_HOMEREADY", ltv: "90.0", conditions: ["Mortgage insurance at 25 % coverage"], expires_on: "2026-11-18" },
  original_terms: { loan_amount_cents: 41_200_000n, note_rate: "6.125", product_code: "FNMA30_HOMEREADY", ltv: "92.6" },
  acceptance_instructions: "To accept, sign the acceptance electronically in your application portal or return the signed acceptance to us before the expiration date.",
  principal_reasons: [{ statement_text: "Value or type of collateral not sufficient", reason_code: "collateral_value", hmda_denial_code: 4 }], reasons_count: 1, reasons_text_lc: "value or type of collateral not sufficient",
  fcra: { ...(ADVERSE_ACTION_SAMPLE.fcra as Record<string, unknown>), applicant_id: "A", score: 748, key_factors: ["Too few accounts currently paid as agreed", "Length of time accounts have been established"], key_factor_count: 2 },
  human_review_statement: "You may request meaningful human review and reconsideration of this decision by a different underwriter: write to Partner Bank, 100 Partner Plaza, Columbus, OH 43215, or reply through your application portal.",
};

export const NOIA_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}NOTICE OF INCOMPLETE APPLICATION{{/block}}
{{#block "parties" page=1 y=0.08 pt=10}}Date: {{date notice_date}}. Applicant: {{applicant_name}}. Application {{application_id}}. Creditor: {{creditor_name}}, {{creditor_address}}.{{/block}}
{{#block "items" page=1 y=0.14 pt=11}}Thank you for your application for credit. We cannot make a decision on your application because it is incomplete. We need the following information: {{#each items_needed}}({{@index}}) {{description}}; {{/each}}{{/block}}
{{#block "period" page=1 y=0.3 pt=11 bold}}Please provide this information within {{designated_period_days}} days of the date of this notice, that is, by {{date response_due_on}}. Failure to provide the information requested will result in no further consideration being given to the application.{{/block}}
{{#block "how" page=1 y=0.42 pt=10}}{{contact_instructions}}{{#if oral_request_made}} We previously asked for this information orally; this written notice confirms that request.{{/if}} If you supply the requested information within the designated period, we will take action on your application and notify you of that action.{{/block}}
{{#block "closing" page=1 y=0.55 pt=10}}This notice is retained for 25 months ({{retention_class}}).{{/block}}`;

export const NOIA_RULES: ContentRule[] = [
  R("items-specified", "12 CFR 1002.9(c)(2): 'specifying the information needed'", "data_range", "items_count", "at least one item of information needed", { range: { min: 1 } }),
  R("items-listed", "12 CFR 1002.9(c)(2)", "presence", "We need the following information: \\(0\\)", "the needed items are listed"),
  R("reasonable-period", "12 CFR 1002.9(c)(2): 'designating a reasonable period of time'; 21.6 policy ≥ 10 days, default 14", "data_range", "designated_period_days", "a designated period of at least 10 days", { range: { min: 10 } }),
  R("response-date", "12 CFR 1002.9(c)(2)", "data_equality", "response_due_on", "the response due date is stated", { predicate: present("response_due_on") }),
  R("no-further-consideration", "12 CFR 1002.9(c)(2) verbatim", "presence", "will result in no further consideration being given to the application", "the statutory consequence statement"),
  R("period-prominent", "form C-6 layout; 21.6 audit", "layout", "period", "the period and consequence are bold on page 1", { layout: { page: 1, bold: true, minPt: 11, maxYFraction: 0.35 } }),
  R("creditor-name-address", "12 CFR 1002.9(c)(2): a written notice from the creditor", "data_equality", "creditor_name,creditor_address", "creditor name and address present", { predicate: present("creditor_name", "creditor_address") }),
  R("action-on-response", "12 CFR 1002.9(c)(2): 'the creditor shall take action on the application and notify the applicant'", "presence", "we will take action on your application and notify you", "the action-on-response statement"),
];
/** Worked example 2: NOIA sent Tue Oct 27, 2026 listing the 2025 returns and the YTD P&L, 14 calendar days → response due Tue Nov 10, 2026. */
export const NOIA_SAMPLE: Record<string, unknown> = {
  creditor_name: "Partner Bank", creditor_address: "100 Partner Plaza, Columbus, OH 43215", applicant_name: "A. Applicant", application_id: "APP-PURCH-1", notice_date: "2026-10-27",
  items_needed: [{ item: "tax_returns_2025", description: "Signed 2025 federal tax returns for the self-employed co-borrower (all schedules)" }, { item: "ytd_pl", description: "Year-to-date profit and loss statement for the co-borrower's business" }], items_count: 2,
  designated_period_days: 14, response_due_on: "2026-11-10", oral_request_made: true, contact_instructions: "Send the information to Partner Bank, 100 Partner Plaza, Columbus, OH 43215, or upload it in your application portal.", retention_class: "regb_25m",
};

export const VERSIONS_21_6: VersionInput[] = [
  V("NTC_REGB_1002_9_ADVERSE_ACTION", ADVERSE_ACTION_SOURCE, ADVERSE_ACTION_RULES, ADVERSE_ACTION_SAMPLE, "regb.2026+fcra.615a+co.sb26_189", "Reg B App. C forms C-1/C-3 combined with FCRA §615(a) (15 U.S.C. 1681m(a)) and C.R.S. 6-1-1704 content"),
  V("NTC_REGB_1002_9_COUNTEROFFER", COUNTEROFFER_SOURCE, COUNTEROFFER_RULES, COUNTEROFFER_SAMPLE, "regb.2026+fcra.615a", "Reg B App. C form C-4 (combined counteroffer and adverse action notice; comment 9(a)(1)-6)"),
  V("NTC_REGB_1002_9_NOIA", NOIA_SOURCE, NOIA_RULES, NOIA_SAMPLE, "regb.2026", "Reg B App. C form C-6 (notice of incomplete application; §1002.9(c)(2))"),
];
export const OVERRIDES_21_6: Record<string, Partial<NoticeTemplate>> = {
  // Rule 6: e-delivery under E-SIGN consent else first-class mail; one notice per applicant (FCRA duty per consumer), never combined with another applicant's notice; Reg B 25-month retention (co_admt_3y for Colorado consumers).
  NTC_REGB_1002_9_ADVERSE_ACTION: { citation: "12 CFR 1002.9(a)(2), (b)(1)-(2); 15 U.S.C. 1681m(a); C.R.S. 6-1-1704(6)(a)", noticeClass: "origination_decisions", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: ["NTC_CO_SB26_189_ADMT_NOTICE"], retention: "regb_25m", piiLevel: "high" },
  NTC_REGB_1002_9_COUNTEROFFER: { citation: "12 CFR 1002.9(a)(1)(iv); comment 9(a)(1)-6; App. C form C-4", noticeClass: "origination_decisions", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: ["NTC_CO_SB26_189_ADMT_NOTICE"], retention: "regb_25m", piiLevel: "high" },
  NTC_REGB_1002_9_NOIA: { citation: "12 CFR 1002.9(c)(2); App. C form C-6", noticeClass: "origination_decisions", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: [], retention: "regb_25m", piiLevel: "medium" },
};
