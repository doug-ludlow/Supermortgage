/**
 * §14.3 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section14.ts.
 *
 * NTC_REGX_39B_EARLY_INTERVENTION_BK — the §1024.39(c)(1)(iii) modified written early-intervention notice:
 * the (b)(2) items (contact, owner/assignee options, how to apply, counselors) with the bankruptcy legend,
 * "may not contain a request for payment" (checklist `REGX_39C1_NO_PAYMENT_REQUEST`, block), by the 45th day
 * after the petition when delinquent at filing, once per case, to the borrower or to bankruptcy counsel
 * (comment 39(c)-1) — on an FDCPA debt-collector loan with counsel of record the notice is counsel-addressed
 * and a debtor copy goes only with counsel's consent (Reg F §1006.6(b)(2); 14.3 rule 4(iii); 14.3-Q2 default) —
 * and again after a discharge only when the borrower makes a payment ((c)(2)(ii)).
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });

const EI_BK_SOURCE = `{{#block "legend" page=1 y=0.05 pt=12 bold}}{{#if discharged}}You received a discharge of your personal liability for this mortgage loan in your Chapter {{chapter}} bankruptcy case (No. {{case_number}}).{{else}}You are a debtor in a Chapter {{chapter}} bankruptcy case (No. {{case_number}}).{{/if}} This notice is for informational purposes only and is not an attempt to collect a debt from you personally. It is not a request for payment.{{/block}}
{{#block "ref" page=1 y=0.13 pt=12}}{{date notice_date}}. {{borrower_name}}, loan number ending {{account_last4}}. Property: {{property_address}}.{{#if counsel_routed}} Sent to {{counsel_name}}, counsel of record for the debtor.{{#if debtor_copy}} A copy is sent to the borrower with counsel's consent.{{else}} No copy is sent to the borrower directly (12 CFR 1006.6(b)(2)).{{/if}}{{/if}}{{/block}}
{{#block "status" page=1 y=0.2 pt=12}}Our records show that your mortgage loan is past due. Because of your bankruptcy case we are not asking you to pay anything through this notice; it describes options that may help you keep your home. We encourage you to discuss these options with your bankruptcy attorney or the trustee.{{/block}}
{{#block "contact" page=1 y=0.3 pt=12}}Call your assigned team directly at {{team_phone}}. Write to us at {{servicer_address}}. Notices of error and requests for information: {{exclusive_address}}.{{/block}}
{{#block "owner" page=1 y=0.4 pt=12}}The owner of your mortgage loan is {{owner_name}}. {{owner_name}} offers alternatives to foreclosure through {{servicer_name}} for which you may apply.{{/block}}
{{#block "options" page=1 y=0.5 pt=12}}Options that may be available: {{#each options}}{{this}}; {{/each}}Not all borrowers qualify.{{/block}}
{{#block "apply" page=1 y=0.65 pt=12}}Contact us for instructions on how to apply. A Mortgage Assistance Application (Form 710) is available at {{upload_url}}. Documents we may request: {{#each document_list}}{{this}}; {{/each}}{{/block}}
{{#block "counseling" page=1 y=0.8 pt=12}}Housing counselors: {{cfpb_counselor_url}} · {{hud_counselor_url}} · HUD {{hud_phone}} · Fannie Mae HOPE hotline {{hope_hotline}} · knowyouroptions.com{{/block}}`;

/** Words that make a sentence a request for payment; the informational wording above never uses them. */
const PAYMENT_REQUEST = "(please (pay|remit)|amount (now )?due|payment (is )?(now )?due|minimum payment|you (must|owe|are required to|need to) pay|pay \\$|remit \\$|total due|bring your (loan|account) current|make (a|your) (mortgage |monthly )?payment|past[- ]due amount of \\$|send (us )?(a |your )?payment|payment coupon)";
const COUNSEL_ROUTED = { "==": [{ var: "recipient" }, "counsel"] };
const EI_BK_RULES: ContentRule[] = [
  R("REGX_39C1_NO_PAYMENT_REQUEST", "12 CFR 1024.39(c)(1)(iii)(B): the written notice 'may not contain a request for payment'", "absence", PAYMENT_REQUEST, "no request for payment anywhere in the notice"),
  R("no-amount-due-field", "12 CFR 1024.39(c)(1)(iii)(B); 14.3 guardrail (checklist block)", "data_equality", "amount_due_cents", "no amount due, payment due date, past-due amount, minimum payment or coupon is merged into the notice", { predicate: { "!": { or: [{ present: "amount_due_cents" }, { present: "payment_due_date" }, { present: "past_due_cents" }, { present: "minimum_payment_cents" }, { present: "payment_coupon" }] } } }),
  // the legend is checked as merged, not as template text: the chapter, the case number and the informational sentence must all render
  R("bk-legend", "12 CFR 1026.41(f)(2); 12 CFR 1024.39(c); 11 U.S.C. §524(j)", "presence", "(You are a debtor in a Chapter (7|11|12|13) bankruptcy case|You received a discharge of your personal liability for this mortgage loan in your Chapter (7|11|12|13) bankruptcy case) \\(No\\. [^\\s()]+\\)\\. This notice is for informational purposes only and is not an attempt to collect a debt from you personally\\. It is not a request for payment\\.", "bankruptcy/discharge legend with the chapter and case number"),
  R("bk-legend-fields", "12 CFR 1026.41(f)(2)(i); 14.3 data model (chapter, case_number)", "data_equality", "chapter", "chapter and case number merged into the legend", { predicate: { and: [{ in: [{ var: "chapter" }, ["7", "11", "12", "13"]] }, { present: "case_number" }] } }),
  R("bk-status", "12 CFR 1026.41(f)(2)(i) (status as a debtor or the discharged status)", "presence", "(You are a debtor in a Chapter (7|11|12|13) bankruptcy case|You received a discharge of your personal liability)", "status sentence"),
  R("legend-layout", "14.3 rule 6; H-30(E)/(F) placement", "layout", "legend", "legend on page 1, 12-pt bold", { layout: { page: 1, minPt: 12, bold: true } }),
  // (b)(2)(ii): "the telephone number to access servicer personnel assigned … and the servicer's mailing address" — a rendered number and addresses, not the template's connective text
  R("ii-contact", "12 CFR 1024.39(b)(2)(ii); comment 35(c)-2", "presence", "Call your assigned team directly at \\(\\d{3}\\) \\d{3}-\\d{4}\\. Write to us at [^.]*\\d[^.]*\\. Notices of error and requests for information: [^.]*\\d", "team direct number + servicer mailing address + exclusive NoE/RFI address"),
  R("ii-contact-fields", "12 CFR 1024.39(b)(2)(ii); 12 CFR 1024.35(c) (exclusive address)", "data_equality", "team_phone", "team_phone, servicer_address and exclusive_address merged", { predicate: { and: [{ matches: ["team_phone", "^\\(\\d{3}\\) \\d{3}-\\d{4}$"] }, { present: "servicer_address" }, { present: "exclusive_address" }] } }),
  R("owner-assignee", "12 CFR 1024.39(b)(2)(iii); comment 39(c)(1)(ii)-1 (an option the owner or assignee offers through the servicer); 14.3 rule 6 (owner = Fannie Mae)", "presence", "The owner of your mortgage loan is Fannie Mae", "owner/assignee named"),
  R("iii-options", "12 CFR 1024.39(b)(2)(iii)", "presence", "Not all borrowers qualify", "generic examples of options with the qualifier"),
  R("iii-options-retention", "rule_sets.fnma.workout_hierarchy", "presence", "repayment plan; payment deferral; forbearance; loan modification", "retention options in hierarchy order"),
  R("iv-apply", "12 CFR 1024.39(b)(2)(iv)", "presence", "Contact us for instructions on how to apply\\. A Mortgage Assistance Application \\(Form 710\\) is available at \\S+\\.", "how to apply, with the application location merged"),
  R("iv-apply-fields", "12 CFR 1024.39(b)(2)(iv); Fannie Mae Form 710", "data_equality", "upload_url", "upload_url and the document list merged", { predicate: { and: [{ present: "upload_url" }, { present: "document_list" }] } }),
  R("v-counseling", "12 CFR 1024.39(b)(2)(v)", "presence", "HUD \\(\\d{3}\\) \\d{3}-\\d{4}", "HUD toll-free number"),
  R("v-cfpb-list", "12 CFR 1024.39(b)(2)(v)", "presence", "consumerfinance\\.gov/find-a-housing-counselor", "CFPB counselor list"),
  R("min-12pt", "12 CFR 1024.39(b)(2) readable type (policy 12-pt)", "layout", "options", "options block at 12-pt", { layout: { page: 1, minPt: 12 } }),
  R("timing-45", "12 CFR 1024.39(c)(1)(iii)(A): 'not later than the 45th day after the borrower files a bankruptcy petition'", "data_range", "days_after_petition", "≤ 45 days after the petition when delinquent at filing", { range: { max: 45 }, when: { "==": [{ var: "trigger" }, "petition"] } }),
  R("once-per-case", "12 CFR 1024.39(c)(1)(iii)(C); comment 39(c)(2)-1", "data_equality", "prior_notice_this_case", "not more than once during a single bankruptcy case", { predicate: { "==": [{ var: "prior_notice_this_case" }, false] } }),
  R("counsel-named", "comment 39(c)-1 (the notice may go to the borrower's bankruptcy counsel)", "conditional", "counsel_name", "counsel named when routed to counsel", { when: COUNSEL_ROUTED, predicate: { present: "counsel_name" } }),
  R("counsel-confirmed", "comment 39(c)-1 (confirming counsel by the court filings is reasonable)", "conditional", "counsel_docket_document_id", "counsel confirmed from the docket", { when: COUNSEL_ROUTED, predicate: { present: "counsel_docket_document_id" } }),
  // Reg F §1006.6(b)(2) / 14.3 rule 4(iii) / 14.3-Q2: counsel-addressed; a debtor copy only with counsel's documented consent — and the notice says which.
  R("debtor-copy-consent", "12 CFR 1006.6(b)(2); 14.3 rule 4(iii); 14.3-Q2 (debtor copy only with counsel's consent)", "conditional", "counsel_consent_document_id", "a debtor copy on a counsel-routed notice requires counsel's written consent on file", { when: { and: [COUNSEL_ROUTED, { "==": [{ var: "debtor_copy" }, true] }] }, predicate: { present: "counsel_consent_document_id" } }),
  R("counsel-no-debtor-copy", "12 CFR 1006.6(b)(2); 14.3 rule 4(iii)", "presence", "No copy is sent to the borrower directly", "counsel-routed notice without consent states that no debtor copy is sent", { when: { and: [COUNSEL_ROUTED, { "!": { "==": [{ var: "debtor_copy" }, true] } }] } }),
  R("counsel-debtor-copy-named", "comment 39(c)-1; 14.3-Q2", "presence", "A copy is sent to the borrower with counsel's consent", "counsel-routed notice with consent names the debtor copy", { when: { and: [COUNSEL_ROUTED, { "==": [{ var: "debtor_copy" }, true] }] } }),
  R("discharge-trigger", "12 CFR 1024.39(c)(2)(ii): after a discharge the notice resumes only on a partial or periodic payment", "conditional", "payment_received_on", "post-discharge notice tied to a payment", { when: { "==": [{ var: "trigger" }, "discharge_payment"] }, predicate: { and: [{ present: "payment_received_on" }, { "==": [{ var: "discharged" }, true] }] } }),
  R("no-threat", "12 CFR 1006.18; 11 U.S.C. §362(a)(6)", "absence", "(garnish|arrest|we will sue|foreclosure (sale )?(is|has been) scheduled)", "no collection threats"),
];
const EI_BK_SAMPLE: Record<string, unknown> = { notice_date: "2026-10-20", borrower_name: "A. Borrower", account_last4: "1234", property_address: "1 Test St, Testville TX 75001", trigger: "petition", petition_date: "2026-09-08", days_after_petition: 42,
  chapter: "13", case_number: "4:26-bk-31234", discharged: false, recipient: "counsel", counsel_routed: true, counsel_name: "J. Counsel, Esq.", counsel_docket_document_id: "dkt-3-notice-of-appearance", fdcpa_debt_collector: true, debtor_copy: false,
  team_phone: "(800) 555-0199", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001", owner_name: "Fannie Mae", servicer_name: "Supermortgage",
  options: ["repayment plan", "payment deferral", "forbearance", "loan modification (Flex Modification)", "short sale", "Mortgage Release (deed-in-lieu)"], upload_url: "portal.example.com/upload", document_list: ["pay stubs", "bank statements", "hardship letter"],
  cfpb_counselor_url: "consumerfinance.gov/find-a-housing-counselor", hud_counselor_url: "hud.gov/counseling", hud_phone: "(800) 569-4287", hope_hotline: "(888) 995-4673", prior_notice_this_case: false };

export const VERSIONS_14_3: VersionInput[] = [
  V("NTC_REGX_39B_EARLY_INTERVENTION_BK", EI_BK_SOURCE, EI_BK_RULES, EI_BK_SAMPLE, "regx.early_intervention.2025-07", "Appendix MS-4(A)–(C) as modified by §1024.39(c)(1)(iii)"),
];
export const OVERRIDES_14_3: Record<string, Partial<NoticeTemplate>> = {
  // bankruptcy variants are mail-only unless counsel consents to e-mail (7.4); the notice is never combined with a solicitation package that asks for payment
  NTC_REGX_39B_EARLY_INTERVENTION_BK: { channelPolicy: "mail_only", citation: "12 CFR 1024.39(c)(1)(iii); comment 39(c)-1; 14.3 rule 6", mayCombineWith: [], separateDocument: false },
};
