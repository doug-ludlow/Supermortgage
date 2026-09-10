/**
 * Authored template versions for the notices §1 owns: the RESPA servicing-
 * transfer notices (1.3, §1024.33(b)(4), Appendix MS-2), the initial escrow
 * account statement (1.6/3.1, §1024.17(g)) and the six §1024.41 loss-mit
 * notices 1.7 inherits from §12 (acknowledgments, determinations, appeals).
 * Every rule is a checklist item the spec names; the sample payload is the
 * worked example the spec gives, so the publish gate proves the template.
 */
import type { ContentRule, VersionInput } from "../registry.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
export const V = (templateCode: string, source: string, contentRules: ContentRule[], samplePayload: Record<string, unknown>, ruleSet: string, sampleFormBasis: string): VersionInput =>
  ({ templateCode, version: "1.0.0", effectiveFrom: D("2026-09-01"), source, contentRules: contentRules.filter((r) => r.kind !== "layout"), layoutRules: contentRules.filter((r) => r.kind === "layout"), samplePayload, ruleSet, sampleFormBasis });

// ------------------------------------------------------------------ 1.3 RESPA transfer notices (MS-2)
const MS2_BODY = `{{#block "heading" page=1 y=0.05 pt=14 bold}}NOTICE OF SERVICING TRANSFER{{/block}}
{{#block "effective" page=1 y=0.12 pt=11}}The servicing of your mortgage loan is being transferred, effective {{date effective_date}}. This means that after this date, a new servicer will be collecting your mortgage loan payments from you. Nothing else about your mortgage loan will change.{{/block}}
{{#block "transferor" page=1 y=0.2 pt=11}}{{transferor_name}} is now collecting your payments. {{transferor_name}} will stop accepting payments received from you after {{date transferor_stop_date}}. Contact {{transferor_name}} at {{transferor_tollfree}} (toll-free), {{transferor_address}}.{{/block}}
{{#block "transferee" page=1 y=0.3 pt=11}}{{transferee_name}} will collect your payments going forward. {{transferee_name}} will start accepting payments received from you on {{date transferee_start_date}}. Send all payments due on or after {{date transferee_start_date}} to {{transferee_name}} at {{transferee_remittance_address}}. Contact {{transferee_name}} at {{transferee_tollfree}} (toll-free), {{transferee_address}}.{{/block}}
{{#block "insurance" page=1 y=0.45 pt=11}}{{#if optional_insurance}}The transfer of servicing rights may affect the terms of or the continued availability of mortgage life or disability insurance or any other type of optional insurance: {{optional_insurance_action}}{{else}}This transfer does not affect any optional insurance you may have; you need not take any action to continue it.{{/if}}{{/block}}
{{#block "terms" page=1 y=0.55 pt=11}}The transfer of servicing does not affect any term or condition of the mortgage documents, other than terms directly related to the servicing of your loan.{{/block}}
{{#block "sixty_day" page=1 y=0.62 pt=11 bold}}Under Federal law, during the 60-day period following the effective date of the transfer of the loan servicing, a loan payment received by your old servicer on or before its due date may not be treated by the new servicer as late, and a late fee may not be imposed on you.{{/block}}
{{#block "body" page=1 y=0.75 pt=11}}Loan number ending {{account_last4}}. Property: {{property_address}}. {{#if master_servicer_name}}{{transferee_name}} services this loan as subservicer for {{master_servicer_name}}.{{/if}}{{/block}}`;
const MS2_RULES = (who: "transferor" | "transferee" | "both"): ContentRule[] => [
  R("b4-i-effective-date", "§1024.33(b)(4)(i)", "presence", "effective (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "effective date of the transfer"),
  R("b4-ii-transferee-block", "§1024.33(b)(4)(ii)", "presence", "will collect your payments going forward", "name, address and toll-free number of the transferee"),
  R("b4-ii-transferee-tollfree", "§1024.33(b)(4)(ii)", "presence", "will collect your payments going forward.*\\(\\d{3}\\) \\d{3}-\\d{4} \\(toll-free\\)", "transferee toll-free number"),
  R("b4-iii-transferor-tollfree", "§1024.33(b)(4)(iii)", "presence", "is now collecting your payments.*\\(\\d{3}\\) \\d{3}-\\d{4} \\(toll-free\\)", "transferor toll-free number"),
  R("b4-iv-stop-start", "§1024.33(b)(4)(iv)", "presence", "will stop accepting payments received from you after .* will start accepting payments received from you on", "transferor stop date and transferee start date"),
  R("b4-iv-consecutive", "§1024.33(b)(4)(iv); 1.3 rule 2", "data_range", "stop_start_gap_days", "stop and start dates are consecutive", { range: { min: 1, max: 1 } }),
  R("b4-v-insurance", "§1024.33(b)(4)(v)", "presence", "optional insurance", "optional-insurance paragraph"),
  R("b4-vi-terms", "§1024.33(b)(4)(vi)", "presence", "does not affect any term or condition of the mortgage documents", "terms-unchanged statement"),
  R("ms2-60-day", "§1024.33(c)(1); Appendix MS-2", "layout", "sixty_day", "60-day statement, prominent", { layout: { page: 1, bold: true } }),
  R("remittance-address", "1.3 checklist", "presence", "Send all payments due on or after .* to .* at ", "transferee remittance address"),
  R("both-contacts", "1.3 checklist", "presence", "Contact .* at .*Contact .* at ", "both servicers' contact blocks"),
  R("timing", who === "transferor" ? "§1024.33(b)(3)(i)" : who === "transferee" ? "§1024.33(b)(3)(ii)" : "§1024.33(b)(3)(iii)", "data_range", "days_from_effective_date", who === "transferor" ? "mailed ≥ 15 days before the effective date" : who === "transferee" ? "mailed ≤ 15 days after the effective date" : "combined notice ≥ 15 days before the effective date", who === "transferee" ? { range: { min: 0, max: 15 } } : { range: { max: -15 } }),
];
const MS2_SAMPLE = (who: "transferor" | "transferee" | "both"): Record<string, unknown> => ({
  effective_date: "2026-10-01", transferor_name: "Old Servicer LLC", transferor_tollfree: "(800) 555-0111", transferor_address: "PO Box 100, Oldtown OH 44101", transferor_stop_date: "2026-09-30",
  transferee_name: "Supermortgage", transferee_tollfree: "(800) 555-0100", transferee_address: "PO Box 1, Testville TX 75001", transferee_remittance_address: "PO Box 7, Testville TX 75001", transferee_start_date: "2026-10-01",
  stop_start_gap_days: 1, optional_insurance: false, account_last4: "1234", property_address: "1 Test St, Testville TX 75001", master_servicer_name: "Partner Bank", days_from_effective_date: who === "transferee" ? 15 : -15,
});

// ------------------------------------------------------------------ 1.6 / 3.1 initial escrow account statement (§1024.17(g))
const ESCROW_INITIAL_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}INITIAL ESCROW ACCOUNT DISCLOSURE STATEMENT{{/block}}
{{#block "payment" page=1 y=0.12 pt=11}}Your monthly mortgage payment for the coming year will be {{money monthly_payment_cents}}, of which {{money pi_cents}} will go toward principal and interest and {{money escrow_payment_cents}} will go into your escrow account. Computation year: {{date computation_year_start}} to {{date computation_year_end}}.{{/block}}
{{#block "itemization" page=1 y=0.25 pt=11}}Anticipated disbursements from your escrow account during the coming year: {{#each disbursements}}{{payee}} ({{use}}) {{money amount_cents}} on {{date on}}; {{/each}}{{/block}}
{{#block "cushion" page=1 y=0.4 pt=11}}Cushion selected by servicer: {{money cushion_cents}} (not more than one-sixth of the estimated total annual disbursements).{{/block}}
{{#block "trial" page=1 y=0.5 pt=11}}Trial running balance: {{#each trial_balance}}{{month}} deposit {{money deposit_cents}} disbursement {{money disbursement_cents}} balance {{money balance_cents}}; {{/each}}Starting balance {{money starting_balance_cents}}; lowest monthly balance {{money low_point_cents}}.{{/block}}
{{#block "keep" page=1 y=0.85 pt=11 bold}}THIS IS AN ESTIMATE OF ACTIVITY IN YOUR ESCROW ACCOUNT DURING THE COMING YEAR BASED ON PAYMENTS ANTICIPATED TO BE MADE FROM YOUR ACCOUNT. PLEASE KEEP THIS STATEMENT FOR COMPARISON WITH THE ACTUAL ACTIVITY IN YOUR ACCOUNT AT THE END OF THE ESCROW ACCOUNTING COMPUTATION YEAR.{{/block}}
{{#block "body" page=1 y=0.9 pt=11}}Loan number ending {{account_last4}}. Questions? Call {{servicer_phone}}.{{/block}}`;
const ESCROW_INITIAL_RULES: ContentRule[] = [
  R("g1-i-monthly-payment", "§1024.17(g)(1)(i)", "presence", "monthly mortgage payment for the coming year will be \\$[\\d,]+\\.\\d{2}", "monthly payment amount"),
  R("g1-i-escrow-portion", "§1024.17(g)(1)(i)", "presence", "\\$[\\d,]+\\.\\d{2} will go into your escrow account", "escrow portion of the payment"),
  R("g1-i-itemization", "§1024.17(g)(1)(i)", "presence", "Anticipated disbursements from your escrow account", "itemized estimated charges with anticipated disbursement dates"),
  R("g1-i-payee-use", "§1024.17(g)(1)(i); 3.1 checklist", "presence", "\\(county tax\\)|\\(hazard insurance\\)|\\(flood insurance\\)|\\(mortgage insurance\\)", "payee-use identification"),
  R("g1-i-cushion", "§1024.17(g)(1)(i); §1024.17(c)(1)(ii)", "presence", "Cushion selected by servicer: \\$[\\d,]+\\.\\d{2}", "cushion amount"),
  R("cushion-cap", "§1024.17(c)(1)(ii)", "data_range", "cushion_over_sixth_pct", "cushion ≤ one-sixth of annual disbursements", { range: { max: 100 } }),
  R("g1-i-trial-balance", "§1024.17(g)(1)(i); Appendix E", "presence", "Trial running balance", "trial running balance"),
  R("computation-year", "3.1 checklist", "presence", "Computation year: ", "computation year stated"),
  R("keep-statement", "Public Guidance Document (PGD)", "layout", "keep", "'keep this statement' language, prominent", { layout: { page: 1, bold: true } }),
  R("timing", "§1024.17(g)(1)(ii); §1024.17(e)", "data_range", "days_after_trigger", "within 45 days of settlement, or 60 days of a transfer-caused change", { range: { max: 60 } }),
];
const ESCROW_INITIAL_SAMPLE: Record<string, unknown> = {
  monthly_payment_cents: 219_257n, pi_cents: 158_017n, escrow_payment_cents: 61_240n, computation_year_start: "2026-10-01", computation_year_end: "2027-09-30",
  disbursements: [{ payee: "Travis County", use: "county tax", amount_cents: 480_000n, on: "2027-01-31" }, { payee: "Acme Insurance", use: "hazard insurance", amount_cents: 254_880n, on: "2027-07-15" }],
  cushion_cents: 122_480n, cushion_over_sixth_pct: 100, trial_balance: [{ month: "Oct", deposit_cents: 61_240n, disbursement_cents: 0n, balance_cents: 245_490n }, { month: "Jan", deposit_cents: 61_240n, disbursement_cents: 480_000n, balance_cents: 10_210n }],
  starting_balance_cents: 184_250n, low_point_cents: 10_210n, account_last4: "1234", servicer_phone: "(800) 555-0100", days_after_trigger: 45,
};

// ------------------------------------------------------------------ 12.1 acknowledgment — complete application (§1024.41(b)(2)(i)(B))
const CONTACT_BLOCK = `{{#block "contact" page=1 y=0.8 pt=11}}Your single point of contact: {{spoc_name}}, {{spoc_phone}}. Write to us at {{servicer_address}}. Notices of error and requests for information: {{exclusive_address}}. Housing counselors: {{hud_counselor_url}} · HUD {{hud_phone}} · HOPE hotline {{hope_hotline}}.{{/block}}
{{#if ai_notice}}{{#block "ai_notice" page=1 y=0.9 pt=10}}{{ai_notice}}{{/block}}{{/if}}`;
const ACK_COMPLETE_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We received your loss mitigation application on {{date received_date}}. Your application is complete as of {{date complete_date}}. We will evaluate your complete application for all loss mitigation options available to you and send you our written determination within 30 days, by {{date determination_due}}. {{#if other_lien_servicer}}Your loan is one of several liens on the property; {{other_lien_servicer}} services another one and may evaluate you separately.{{/if}}{{/block}}
{{#block "protection" page=1 y=0.35 pt=11 bold}}Because we received a complete application more than 37 days before any foreclosure sale, we will not make the first notice or filing for foreclosure, move for a foreclosure judgment or order of sale, or conduct a foreclosure sale while we evaluate your application, until you have been notified of our determination and any appeal period has ended.{{/block}}
{{#block "c3" page=1 y=0.55 pt=11}}(A) You have until {{date determination_due}} to hear from us. (B) You may be entitled to protections against foreclosure while we evaluate. (C) If we offer an option, you will have at least 14 days to accept or reject it. (D) If we deny a loan modification, you may appeal within 14 days. (E) You may contact us at any time. (F) You may qualify for other options with your other lien holders.{{/block}}
${CONTACT_BLOCK}`;
const ACK_COMPLETE_RULES: ContentRule[] = [
  R("states-complete", "§1024.41(b)(2)(i)(B)", "presence", "Your application is complete as of", "states the application is complete"),
  R("date-received", "§1024.41(b)(2)(i)(B)", "presence", "received your loss mitigation application on", "date received"),
  R("30-day-evaluation", "§1024.41(c)(1)", "presence", "written determination within 30 days", "30-day evaluation statement"),
  R("foreclosure-protection", "§1024.41(f)(2), (g)", "layout", "protection", "foreclosure-protection statement, prominent", { layout: { page: 1, bold: true } }),
  R("c3-elements", "§1024.41(c)(3)(i)(A)–(F)", "presence", "\\(A\\) .* \\(B\\) .* \\(C\\) .* \\(D\\) .* \\(E\\) .* \\(F\\) ", "all (c)(3)(i)(A)–(F) elements so exception (c)(3)(ii)(A) applies"),
  R("other-lien", "12.1 checklist", "conditional", "other_lien_servicer", "other-lien-servicer statement when known", { when: { present: "other_lien_servicer" }, predicate: { present: "other_lien_servicer" } }),
  R("spoc", "§1024.40", "presence", "Your single point of contact", "SPOC contact block"),
  R("noe-address", "comment 35(c)-2", "presence", "Notices of error and requests for information", "exclusive NoE/RFI address"),
  R("counselor-hope", "D2-2-05", "presence", "HUD \\(\\d{3}\\) \\d{3}-\\d{4} · HOPE hotline", "HUD counselor and HOPE hotline"),
  R("ai-notice", "Colorado AI pre-decision notice (jurisdiction_rules.ai_notice)", "conditional", "ai_notice", "AI notice paragraph where the jurisdiction requires it", { when: { "==": [{ var: "ai_notice_required" }, true] }, predicate: { present: "ai_notice" } }),
  R("sent-within-5bd", "§1024.41(b)(2)(i)(B)", "data_range", "business_days_after_receipt", "sent within 5 business days of receipt", { range: { max: 5 } }),
];
const ACK_COMPLETE_SAMPLE: Record<string, unknown> = { received_date: "2026-09-20", complete_date: "2026-09-20", determination_due: "2026-10-20", other_lien_servicer: null, spoc_name: "Team 4", spoc_phone: "(800) 555-0177", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001", hud_counselor_url: "hud.gov/counseling", hud_phone: "(800) 569-4287", hope_hotline: "(888) 995-4673", ai_notice_required: true, ai_notice: "An automated system helped review your application; a person made the decision. You may request a human review.", business_days_after_receipt: 3 };

// ------------------------------------------------------------------ 12.2 determinations (§1024.41(c)(1)(ii), (d))
const OFFER_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We have completed our evaluation of your complete loss mitigation application received {{date complete_date}}. We are offering you: {{#each offered}}{{name}} — payment {{money payment_cents}} due {{date first_due}} for {{duration_months}} months{{#if current_at_end}}, after which your loan will be current{{/if}}; capitalized amounts {{money capitalized_cents}}; fees {{money fees_cents}}. {{/each}}To accept, {{acceptance_steps}} by {{date accept_by}}.{{/block}}
{{#if denied}}{{#block "denied" page=1 y=0.4 pt=11}}We are not offering: {{#each denied}}{{name}} — {{reason}}. {{/each}}You may appeal the denial of a loan modification option within 14 days, by {{date appeal_by}}, by {{appeal_how}}; personnel not involved in the original decision will review it.{{/block}}{{/if}}
{{#block "other" page=1 y=0.6 pt=11}}Other options we considered: {{#each other_options}}{{name}}: {{determination}}; {{/each}}{{/block}}
{{#block "ecoa" page=1 y=0.72 pt=10}}The Federal Equal Credit Opportunity Act prohibits creditors from discriminating against credit applicants on the basis of race, color, religion, national origin, sex, marital status, age, or because all or part of the applicant's income derives from any public assistance program.{{/block}}
${CONTACT_BLOCK}`;
const OFFER_RULES: ContentRule[] = [
  R("options-offered", "§1024.41(c)(1)(ii)", "presence", "We are offering you: .* — payment \\$[\\d,]+\\.\\d{2} due", "option(s) offered with material terms"),
  R("terms-duration", "D2-2-05; NY 419.7(f)(1)", "presence", "for \\d+ months", "duration and whether current at end"),
  R("capitalized-itemized", "NY 419.7(f)(1)", "presence", "capitalized amounts \\$[\\d,]+\\.\\d{2}; fees \\$[\\d,]+\\.\\d{2}", "capitalized amounts and fees itemized"),
  R("accept-steps", "§1024.41(c)(1)(ii)", "presence", "To accept, .* by ", "steps to accept and accept_by"),
  R("accept-14-days", "§1024.41(e)(1)", "data_range", "acceptance_days", "acceptance period ≥ 14 days", { range: { min: 14 } }),
  R("appeal-rights", "§1024.41(h)(2)", "conditional", "denied", "appeal rights (14 days, how, different personnel) when a modification was denied", { when: { present: "denied" }, predicate: { present: "appeal_by" } }),
  R("other-determinations", "§1024.41(c)(1)(ii); comment 41(c)(1)-1", "presence", "Other options we considered", "other options' determinations"),
  R("spoc", "§1024.40", "presence", "Your single point of contact", "SPOC block"),
  R("counselor-hope", "D2-2-05", "presence", "HOPE hotline", "counselor/HOPE hotline"),
  R("ecoa", "Reg B §1002.9(b)(1)", "presence", "Equal Credit Opportunity Act", "ECOA statement"),
  R("timing-30", "§1024.41(c)(1)", "data_range", "days_after_complete", "provided within 30 days of the complete application", { range: { max: 30 } }),
];
const OFFER_SAMPLE: Record<string, unknown> = { complete_date: "2026-09-20", offered: [{ name: "Flex Modification trial period plan", payment_cents: 199_480n, first_due: "2026-11-01", duration_months: 3, current_at_end: true, capitalized_cents: 612_700n, fees_cents: 0n }], acceptance_steps: "make the first trial payment", accept_by: "2026-11-01", acceptance_days: 14,
  denied: [{ name: "Payment deferral", reason: "the loan has already received a payment deferral within the last 12 months (Fannie Mae D2-3.2-05)" }], appeal_by: "2026-11-01", appeal_how: "writing to the exclusive address below", other_options: [{ name: "Repayment plan", determination: "not offered: unaffordable at 31% DTI" }],
  days_after_complete: 28, spoc_name: "Team 4", spoc_phone: "(800) 555-0177", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001", hud_counselor_url: "hud.gov/counseling", hud_phone: "(800) 569-4287", hope_hotline: "(888) 995-4673", ai_notice_required: false };

const DENIAL_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We have completed our evaluation of your complete loss mitigation application received {{date complete_date}}. We are unable to offer you the following options: {{#each denied}}{{name}} — {{reason}}{{#if investor_requirement}} (investor: {{investor_name}}; requirement: {{investor_requirement}}){{/if}}. {{/each}}{{#if not_evaluated_other_criteria}}Your application was not evaluated on any other criteria.{{/if}}{{/block}}
{{#block "appeal" page=1 y=0.4 pt=11 bold}}You may appeal our denial of a loan modification option within {{appeal_days}} days, by {{date appeal_by}}, by {{appeal_how}}. Personnel not involved in the original decision will review your appeal.{{/block}}
{{#block "other" page=1 y=0.55 pt=11}}Other options that may still be available to you: {{#each other_available}}{{this}}; {{/each}}Next steps: {{next_steps}}. You may request copies of the documents we relied on.{{/block}}
{{#block "ecoa" page=1 y=0.7 pt=10}}The Federal Equal Credit Opportunity Act prohibits creditors from discriminating against credit applicants on the basis of race, color, religion, national origin, sex, marital status, age, or because all or part of the applicant's income derives from any public assistance program. {{#if credit_score_used}}FCRA: we used information from a consumer report; {{fcra_block}}{{/if}}{{/block}}
{{#if state_block}}{{#block "state" page=1 y=0.78 pt=10}}{{state_block}}{{/block}}{{/if}}
${CONTACT_BLOCK}`;
const DENIAL_RULES: ContentRule[] = [
  R("specific-reasons", "§1024.41(d)", "presence", "unable to offer you the following options: .* — ", "per-option specific reasons"),
  R("investor-named", "§1024.41(d); comment 41(d)-1", "conditional", "denied", "investor name and the specific requirement when the denial is investor-based", { when: { "==": [{ var: "investor_based" }, true] }, predicate: { present: "denied.0.investor_requirement" } }),
  R("investor-fannie-mae", "12.2 checklist", "conditional", "investor_name", "investor named as Fannie Mae", { when: { "==": [{ var: "investor_based" }, true] }, predicate: { "==": [{ var: "investor_name" }, "Fannie Mae"] } }),
  R("appeal-rights", "§1024.41(h)(2); CA §2923.6(f)", "layout", "appeal", "appeal rights and procedure, prominent", { layout: { page: 1, bold: true } }),
  R("appeal-days", "§1024.41(h)(2); CA §2923.6(f)", "data_range", "appeal_days", "14 days (30 in CA)", { range: { min: 14, max: 30 } }),
  R("other-options", "12.2 checklist", "presence", "Other options that may still be available", "other options and next steps"),
  R("documents-right", "policy", "presence", "request copies of the documents", "right to request documents"),
  R("ecoa", "Reg B §1002.9", "presence", "Equal Credit Opportunity Act", "ECOA block"),
  R("fcra", "FCRA §615", "conditional", "credit_score_used", "FCRA block when a consumer report was used", { when: { "==": [{ var: "credit_score_used" }, true] }, predicate: { present: "fcra_block" } }),
  R("ny-dfs", "NY 419.7(f)(2)", "conditional", "state_block", "DFS complaint statement for NY", { when: { "==": [{ var: "state" }, "NY"] }, predicate: { present: "state_block" } }),
  R("spoc", "§1024.40", "presence", "Your single point of contact", "SPOC block"),
  R("timing-30", "§1024.41(c)(1)", "data_range", "days_after_complete", "within 30 days of the complete application", { range: { max: 30 } }),
];
const DENIAL_SAMPLE: Record<string, unknown> = { complete_date: "2026-09-20", denied: [{ name: "Flex Modification", reason: "the modified payment would not reduce your payment and the loan is not 60+ days delinquent", investor_name: "Fannie Mae", investor_requirement: "Servicing Guide D2-3.2-07 eligibility: payment reduction or 60+ days delinquent" }], investor_based: true, investor_name: "Fannie Mae", not_evaluated_other_criteria: true,
  appeal_days: 14, appeal_by: "2026-11-01", appeal_how: "writing to the exclusive address below", other_available: ["repayment plan", "short sale", "Mortgage Release"], next_steps: "call your single point of contact", credit_score_used: false, state: "TX", state_block: null, days_after_complete: 28,
  spoc_name: "Team 4", spoc_phone: "(800) 555-0177", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001", hud_counselor_url: "hud.gov/counseling", hud_phone: "(800) 569-4287", hope_hotline: "(888) 995-4673", ai_notice_required: true, ai_notice: "A person not involved in the original decision made this determination; an automated system contributed the affordability calculation." };

// ------------------------------------------------------------------ 12.3 appeal determinations (§1024.41(h)(4))
const APPEAL_GRANTED_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We reviewed your appeal received {{date appeal_received}}. Personnel not involved in the original evaluation determined that we will offer you: {{#each granted}}{{name}} — payment {{money payment_cents}} due {{date first_due}}; {{/each}}To accept, {{acceptance_steps}} by {{date accept_by}}. {{#if original_offer_reinstated}}You may instead accept the offer made in our {{date original_offer_date}} notice.{{/if}} Your first trial period payment is due {{date tpp_first_due}}.{{/block}}
{{#block "final" page=1 y=0.5 pt=11 bold}}This determination is final; there is no further appeal.{{/block}}
${CONTACT_BLOCK}`;
const APPEAL_GRANTED_RULES: ContentRule[] = [
  R("determination-per-option", "§1024.41(h)(4)", "presence", "determined that we will offer you: .* — payment", "determination per option with new offer terms"),
  R("independent-personnel", "§1024.41(h)(3)", "presence", "Personnel not involved in the original evaluation", "independent evaluation statement"),
  R("accept-by", "§1024.41(h)(4)", "presence", "To accept, .* by ", "accept_by"),
  R("accept-14-days", "§1024.41(h)(4)", "data_range", "acceptance_days", "≥ 14 days to accept", { range: { min: 14 } }),
  R("original-offer", "§1024.41(h)(4); D2-2-07", "conditional", "original_offer_reinstated", "original-offer reinstatement statement where an offer stood", { when: { "==": [{ var: "original_offer_reinstated" }, true] }, predicate: { present: "original_offer_date" } }),
  R("tpp-first-due", "12.3 checklist", "presence", "first trial period payment is due", "TPP first due date"),
  R("no-further-appeal", "§1024.41(h)(4)", "layout", "final", "'no further appeal' statement", { layout: { page: 1, bold: true } }),
  R("timing-30", "§1024.41(h)(4)", "data_range", "days_after_appeal", "within 30 days of the appeal", { range: { max: 30 } }),
];
const APPEAL_GRANTED_SAMPLE: Record<string, unknown> = { appeal_received: "2026-10-05", granted: [{ name: "Flex Modification trial period plan", payment_cents: 189_910n, first_due: "2026-12-01" }], acceptance_steps: "make the first trial payment", accept_by: "2026-11-18", acceptance_days: 14, original_offer_reinstated: true, original_offer_date: "2026-09-24", tpp_first_due: "2026-12-01", days_after_appeal: 30,
  spoc_name: "Team 4", spoc_phone: "(800) 555-0177", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001", hud_counselor_url: "hud.gov/counseling", hud_phone: "(800) 569-4287", hope_hotline: "(888) 995-4673", ai_notice_required: false };

const APPEAL_DENIED_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We reviewed your appeal received {{date appeal_received}}. Personnel not involved in the original evaluation determined that we are unable to offer: {{#each denied}}{{name}} — {{reason}} (investor: {{investor_name}}; requirement: {{investor_requirement}}). {{/each}}{{/block}}
{{#block "final" page=1 y=0.35 pt=11 bold}}This determination is final; there is no further appeal.{{/block}}
{{#block "other" page=1 y=0.45 pt=11}}Other options still available to you: {{#each other_available}}{{this}}; {{/each}}If your loan remains in default, foreclosure may proceed: {{foreclosure_consequence}}{{/block}}
{{#if state_block}}{{#block "state" page=1 y=0.6 pt=10}}{{state_block}}{{/block}}{{/if}}
{{#block "explanation" page=1 y=0.7 pt=10}}{{decision_explanation}}{{/block}}
${CONTACT_BLOCK}`;
const APPEAL_DENIED_RULES: ContentRule[] = [
  R("specific-reasons", "§1024.41(h)(4), (d)", "presence", "unable to offer: .* — .* \\(investor: Fannie Mae; requirement: ", "specific reasons per option with the investor requirement named"),
  R("independent-personnel", "§1024.41(h)(3)", "presence", "Personnel not involved in the original evaluation", "independent evaluation statement"),
  R("no-further-appeal", "§1024.41(h)(4)", "layout", "final", "'no further appeal' statement", { layout: { page: 1, bold: true } }),
  R("other-options", "12.3 checklist", "presence", "Other options still available", "other options still available"),
  R("foreclosure-consequences", "12.3 checklist; CA 15-day statement", "presence", "foreclosure may proceed", "foreclosure consequences"),
  R("ny-dfs", "NY 419.7", "conditional", "state_block", "DFS complaint statement for NY", { when: { "==": [{ var: "state" }, "NY"] }, predicate: { present: "state_block" } }),
  R("human-decided", "Colorado explanation block", "presence", "A person .* decided", "human reviewer decided; AI contribution described"),
  R("counselor-hope", "D2-2-07", "presence", "HOPE hotline", "counselor/HOPE hotline"),
  R("timing-30", "§1024.41(h)(4)", "data_range", "days_after_appeal", "within 30 days of the appeal", { range: { max: 30 } }),
];
const APPEAL_DENIED_SAMPLE: Record<string, unknown> = { appeal_received: "2026-10-05", denied: [{ name: "Flex Modification", reason: "the modified payment would exceed the pre-modification payment", investor_name: "Fannie Mae", investor_requirement: "Servicing Guide D2-3.2-07: a Flex Modification must produce a payment reduction for loans less than 60 days delinquent" }], other_available: ["short sale", "Mortgage Release"], foreclosure_consequence: "a foreclosure sale may be scheduled no earlier than 15 days after this notice", state: "TX", state_block: null,
  decision_explanation: "A person on the appeals team decided this appeal; an automated system contributed the affordability calculation, which the reviewer checked.", days_after_appeal: 30,
  spoc_name: "Team 4", spoc_phone: "(800) 555-0177", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001", hud_counselor_url: "hud.gov/counseling", hud_phone: "(800) 569-4287", hope_hotline: "(888) 995-4673", ai_notice_required: false };

export const SECTION_01_VERSIONS: readonly VersionInput[] = [
  V("NTC_REGX_1024_33B_GOODBYE_MS2", MS2_BODY, MS2_RULES("transferor"), MS2_SAMPLE("transferor"), "regx.servicing_transfer.2014", "Appendix MS-2 (transferor)"),
  V("NTC_REGX_1024_33B_HELLO_MS2", MS2_BODY, MS2_RULES("transferee"), MS2_SAMPLE("transferee"), "regx.servicing_transfer.2014", "Appendix MS-2 (transferee)"),
  V("NTC_REGX_1024_33B_COMBINED_MS2", MS2_BODY, MS2_RULES("both"), MS2_SAMPLE("both"), "regx.servicing_transfer.2014", "Appendix MS-2 (combined)"),
  V("NTC_REGX_1024_17G_INITIAL_ESCROW_STMT", ESCROW_INITIAL_SOURCE, ESCROW_INITIAL_RULES, ESCROW_INITIAL_SAMPLE, "regx.escrow.2014", "§1024.17(g), Appendix E and the PGD"),
  V("NTC_REGX_41B2_ACK_COMPLETE", ACK_COMPLETE_SOURCE, ACK_COMPLETE_RULES, ACK_COMPLETE_SAMPLE, "regx.lossmit.2013", "12.1 checklist"),
  V("NTC_REGX_41C1_OFFER", OFFER_SOURCE, OFFER_RULES, OFFER_SAMPLE, "regx.lossmit.2013", "12.2 checklist"),
  V("NTC_REGX_41C1_DENIAL", DENIAL_SOURCE, DENIAL_RULES, DENIAL_SAMPLE, "regx.lossmit.2013", "12.2 checklist"),
  V("NTC_REGX_41H4_APPEAL_GRANTED", APPEAL_GRANTED_SOURCE, APPEAL_GRANTED_RULES, APPEAL_GRANTED_SAMPLE, "regx.lossmit.2013", "12.3 checklist"),
  V("NTC_REGX_41H4_APPEAL_DENIED", APPEAL_DENIED_SOURCE, APPEAL_DENIED_RULES, APPEAL_DENIED_SAMPLE, "regx.lossmit.2013", "12.3 checklist"),
];
