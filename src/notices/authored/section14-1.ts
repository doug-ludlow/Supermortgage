/**
 * §14.1 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section14.ts.
 *
 * The three informational borrower/counsel letters 14.1 owns: `NTC_BK_PAYMENT_INSTRUCTIONS`
 * (post-petition payment address/amount — the "payment change reminder" of worked example A),
 * `NTC_BK_STATUS_INFO` (responses to inbound questions) and `NTC_BK_BREACH_INFORMATIONAL`
 * (the post-discharge breach-letter variant 13.x sends before an in rem referral). Every one is
 * "informational — not an attempt to collect" (§362(a)(6), §524(a)(2), §524(j)), mail-only unless
 * counsel consents to e-mail, and addressed c/o counsel where the debtor is represented.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const BK_DISCLAIMER = "This letter is for informational purposes only and is not an attempt to collect a debt from you personally. If you are in bankruptcy or have received a discharge, this letter is not a demand for payment.";
const DATE_RULE = R("date", "notice date", "presence", "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "date of the notice");
const DISCLAIMER_RULE = R("informational", "11 U.S.C. §362(a)(6); §524(a)(2); 14.1 outputs (\"informational — not an attempt to collect\")", "presence", "not an attempt to collect a debt from you personally", "informational disclaimer");
const DISCLAIMER_LAYOUT = R("disclaimer-prominent", "14.1 outputs; counsel review for discharge-injunction safety", "layout", "disclaimer", "disclaimer bold at the top of page 1", { layout: { page: 1, bold: true, minPt: 12, maxYFraction: 0.1 } });
const NO_DEMAND_RULE = R("no-demand", "11 U.S.C. §362(a)(6); §524(a)(2); 14.1 rule 4 (no outbound collection communication while gates are on)", "absence", "(you must pay|please remit|you owe|personally liable|failure to pay|immediate payment|pay now)", "no payment demand or personal-liability language");
const CASE_RULE = R("case-number", "14.1 data model: bankruptcy_cases.case_number_full", "presence", "case \\d:\\d{2}-bk-\\d+", "the bankruptcy case number");
const COUNSEL_RULE = R("counsel-routed", "Reg F §1006.6(b)(2); 14.1 rule 4 (contact_route=counsel_only where a debtor's attorney appears)", "conditional", "counsel_name", "addressed c/o counsel where the debtor is represented", { when: { "==": [{ var: "represented" }, true] }, predicate: { present: "counsel_name" } });
const ADDRESSEE = `{{#block "addressee" page=1 y=0.12 pt=11}}{{date notice_date}}. {{#if counsel_name}}Sent c/o {{counsel_name}}, counsel for the debtor in case {{case_number_full}} ({{court_name}}).{{else}}{{borrower_name}}, debtor in case {{case_number_full}} ({{court_name}}).{{/if}} Loan number ending {{account_last4}}. Property: {{property_address}}.{{/block}}`;
const BASE = { account_last4: "1234", borrower_name: "A. Borrower", property_address: "1 Test St, Houston TX 77001", servicer_name: "Supermortgage", servicer_address: "PO Box 1, Testville TX 75001", team_phone: "(800) 555-0199", represented: true, counsel_name: "D. Counsel, Esq.", case_number_full: "4:26-bk-31234", court_name: "U.S. Bankruptcy Court, Southern District of Texas", chapter: "13" };

// ------------------------------------------------------------------ NTC_BK_PAYMENT_INSTRUCTIONS (rule 6, worked example A)
const PAYMENT_INSTRUCTIONS_SOURCE = `{{#block "disclaimer" page=1 y=0.05 pt=12 bold}}${BK_DISCLAIMER}{{/block}}
${ADDRESSEE}
{{#block "instructions" page=1 y=0.22 pt=11}}Post-petition payment information for the Chapter {{chapter}} case: the post-petition installment amount is {{money postpetition_amount_cents}} beginning with the installment due {{date effective_due_date}}{{#if prior_amount_cents}} (previously {{money prior_amount_cents}}){{/if}}. {{#if conduit}}Under the confirmed plan and local practice, post-petition installments are paid through the Chapter 13 trustee, {{trustee_name}}, {{trustee_payment_address}}.{{else}}Post-petition installments are payable to {{servicer_name}} at {{payment_address}}.{{/if}}{{/block}}
{{#block "basis" page=1 y=0.42 pt=11}}{{#if form_410s1_filed_on}}This amount is the amount stated in the Notice of Mortgage Payment Change (Official Form 410S-1) filed on {{date form_410s1_filed_on}}{{#if form_410s1_docket_no}}, docket no. {{form_410s1_docket_no}}{{/if}}. {{/if}}{{#if shortfall_cents}}The installment due {{date shortfall_due_date}} was received in the prior amount, leaving an escrow shortfall of {{money shortfall_cents}} on the loan record; this is shared for reconciliation of the trustee's disbursements only.{{/if}}{{/block}}
{{#block "closing" page=1 y=0.62 pt=11}}Nothing in this letter changes the terms of the plan or the court's orders, and this letter is not a demand for payment. Questions may be directed to {{team_phone}} or {{servicer_address}}. A copy of this letter has been sent to {{#if conduit}}the trustee and {{/if}}{{#if counsel_name}}counsel{{else}}the debtor{{/if}}.{{/block}}`;
const PAYMENT_INSTRUCTIONS_RULES: ContentRule[] = [DATE_RULE, DISCLAIMER_RULE, DISCLAIMER_LAYOUT, NO_DEMAND_RULE, CASE_RULE, COUNSEL_RULE,
  R("amount", "14.1 outputs: post-petition payment address/amount", "presence", "post-petition installment amount is \\$[\\d,]+\\.\\d{2}", "the post-petition installment amount"),
  R("effective", "14.1 rule 6: the post-petition schedule", "presence", "beginning with the installment due (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "the installment the amount applies from"),
  R("channel", "E-2.1-06: post-petition payments to the servicer unless local practice requires trustee (conduit) payment", "presence", "(paid through the Chapter 13 trustee, .+, .+\\.|payable to .+ at .+\\.)", "the payment address — trustee (conduit) or servicer"),
  R("amount-positive", "14.1 rule 6", "data_range", "postpetition_amount_cents", "post-petition amount is positive", { range: { min: 1 } }),
  R("410s1-basis", "Fed. R. Bankr. P. 3002.1(b); 14.2: a payment change cites the filed Form 410S-1", "conditional", "form_410s1_filed_on", "a changed amount cites the filed 410S-1", { when: { present: "prior_amount_cents" }, predicate: { present: "form_410s1_filed_on" } }),
  R("no-terms-change", "11 U.S.C. §1327; 14.1 rule 7", "presence", "Nothing in this letter changes the terms of the plan or the court's orders", "no change to plan terms")];
const PAYMENT_INSTRUCTIONS_SAMPLE = { ...BASE, notice_date: "2026-12-21", postpetition_amount_cents: 280_672n, prior_amount_cents: 269_922n, effective_due_date: "2026-11-01", conduit: true, trustee_name: "Chapter 13 Trustee", trustee_payment_address: "PO Box 2, Houston TX 77001", payment_address: "PO Box 7, Testville TX 75001", form_410s1_filed_on: "2026-10-09", form_410s1_docket_no: "27", shortfall_cents: 10_750n, shortfall_due_date: "2026-11-01" };

// ------------------------------------------------------------------ NTC_BK_STATUS_INFO (responses to inbound questions)
const STATUS_INFO_SOURCE = `{{#block "disclaimer" page=1 y=0.05 pt=12 bold}}${BK_DISCLAIMER}{{/block}}
${ADDRESSEE}
{{#block "question" page=1 y=0.22 pt=11}}You asked on {{date inquiry_date}}: {{inquiry_summary}}{{/block}}
{{#block "status" page=1 y=0.3 pt=11}}Status as of {{date as_of}}: Chapter {{chapter}}; case status {{case_status}}; automatic stay {{stay_status}}. {{#if plan_confirmed_on}}Plan confirmed {{date plan_confirmed_on}}. {{/if}}Pre-petition arrearage stated in the proof of claim: {{money prepetition_arrearage_cents}}; received through the trustee toward that claim to date: {{money arrearage_received_cents}}. Post-petition installments: {{postpetition_paid_count}} of {{postpetition_due_count}} received; the next post-petition installment of {{money postpetition_amount_cents}} is scheduled for {{date next_postpetition_due}}.{{/block}}
{{#block "closing" page=1 y=0.6 pt=11}}This information is provided at your request for your records and is not a demand for payment. It is not a payoff or reinstatement quote; those figures are available on request through counsel. Questions: {{team_phone}} or {{servicer_address}}.{{/block}}`;
const STATUS_INFO_RULES: ContentRule[] = [DATE_RULE, DISCLAIMER_RULE, DISCLAIMER_LAYOUT, NO_DEMAND_RULE, CASE_RULE, COUNSEL_RULE,
  R("question", "14.1 outputs: responses to inbound questions", "presence", "You asked on (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}: ", "restates the inquiry"),
  R("status", "14.1 state machine; E-2.2-04 three accounting views", "presence", "Status as of .*: Chapter (7|11|12|13); case status .*; automatic stay ", "chapter, case status and stay status"),
  R("arrearage-view", "E-2.2-04: separate pre-/post-petition accounting", "presence", "Pre-petition arrearage stated in the proof of claim: \\$[\\d,]+\\.\\d{2}; received through the trustee toward that claim to date: \\$[\\d,]+\\.\\d{2}", "pre-petition arrearage and cure receipts"),
  R("postpetition-view", "E-2.2-04", "presence", "Post-petition installments: \\d+ of \\d+ received", "post-petition installment status"),
  R("not-a-quote", "16.1: payoff/reinstatement figures only through the quote path (to counsel)", "presence", "not a payoff or reinstatement quote", "no quote figures in an informational letter"),
  R("counts", "14.1 data model: bankruptcy_ledger_views.postpetition_installments", "data_range", "postpetition_due_count", "installment counts are non-negative", { range: { min: 0 } })];
const STATUS_INFO_SAMPLE = { ...BASE, notice_date: "2027-01-22", inquiry_date: "2027-01-19", inquiry_summary: "whether the December installment paid by the trustee has been applied and what the arrearage balance is", as_of: "2027-01-21", case_status: "active (plan confirmed)", stay_status: "in effect", plan_confirmed_on: "2026-12-10", prepetition_arrearage_cents: 1_424_194n, arrearage_received_cents: 23_737n, postpetition_paid_count: 3, postpetition_due_count: 3, postpetition_amount_cents: 280_672n, next_postpetition_due: "2027-02-01" };

// ------------------------------------------------------------------ NTC_BK_BREACH_INFORMATIONAL (rule 10; E-2.2-01 breach letter, post-discharge variant for 13.x)
const BREACH_INFORMATIONAL_SOURCE = `{{#block "disclaimer" page=1 y=0.05 pt=12 bold}}This notice is for informational purposes only and is not an attempt to collect a debt from you personally. Your personal liability on this loan was discharged in bankruptcy on {{date discharge_date}}; this notice is not a demand for payment and does not seek to collect the debt as your personal liability.{{/block}}
${ADDRESSEE}
{{#block "default" page=1 y=0.22 pt=11}}The lien on the property was not affected by the discharge, and the holder of the lien may act in the ordinary course to protect its interest in the property (11 U.S.C. §524(j)). The loan is in default: the installment due {{date first_unpaid_due}} and each installment since have not been received; {{installments_unpaid}} installments totaling {{money past_due_cents}} are unpaid as of {{date as_of}}. If the default is not cured on or before {{date cure_by}}, the holder of the lien may enforce it against the property only (in rem), including by foreclosure, as permitted by the mortgage and applicable law. The amount needed to cure the default as of {{date cure_by}} is {{money cure_cents}}; this figure is provided for your information and is not a demand for payment from you personally.{{/block}}
{{#block "options" page=1 y=0.52 pt=11}}You may, but are not required to, contact us through counsel about options that could keep the property, including a loan modification or other assistance, or about surrendering the property. Housing counseling is available at no cost from HUD-approved agencies at {{hud_phone}} or {{cfpb_counselor_url}}.{{/block}}
{{#block "closing" page=1 y=0.72 pt=11}}Questions: {{team_phone}} or {{servicer_address}}. {{#if counsel_name}}This notice is addressed to counsel; a copy goes to the debtor only with counsel's consent.{{/if}}{{/block}}`;
const BREACH_INFORMATIONAL_RULES: ContentRule[] = [DATE_RULE, DISCLAIMER_RULE, DISCLAIMER_LAYOUT, NO_DEMAND_RULE, CASE_RULE, COUNSEL_RULE,
  R("discharge", "11 U.S.C. §524(a)(2); 14.1 rule 10 (discharge-injunction mode)", "presence", "discharged in bankruptcy on (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "the discharge date"),
  R("in-rem", "11 U.S.C. §524(j); E-2.2-01 (foreclosure in rem after the breach letter)", "presence", "against the property only \\(in rem\\)", "in rem enforcement statement"),
  R("524j", "11 U.S.C. §524(j)", "presence", "11 U\\.S\\.C\\. §524\\(j\\)", "the ordinary-course lien statement"),
  R("default-facts", "E-2.2-01 breach letter content", "presence", "installment due .* and each installment since have not been received; \\d+ installments totaling \\$[\\d,]+\\.\\d{2} are unpaid", "the default facts"),
  R("cure-figure", "E-2.2-01 breach letter content (informational)", "presence", "amount needed to cure the default as of .* is \\$[\\d,]+\\.\\d{2}", "the cure figure, informational"),
  R("cure-period", "E-2.2-01 / security instrument §22: at least 30 days to cure", "data_range", "cure_days", "cure date at least 30 days after the notice", { range: { min: 30 } }),
  R("unpaid-count", "14.1 rule 6(d): contractual delinquency continues to age in Chapter 7", "data_range", "installments_unpaid", "at least one unpaid installment", { range: { min: 1 } }),
  R("counseling", "12 CFR 1024.39(b)(2)(iv); E-2.2-01", "presence", "Housing counseling is available at no cost from HUD-approved agencies", "housing counseling reference"),
  R("no-personal-liability", "11 U.S.C. §524(a)(2)", "absence", "(you are liable|your obligation to pay|you remain obligated)", "no statement of personal obligation")];
const BREACH_INFORMATIONAL_SAMPLE = { ...BASE, chapter: "7", notice_date: "2026-12-22", discharge_date: "2026-12-15", first_unpaid_due: "2026-06-01", installments_unpaid: 7, past_due_cents: 1_889_454n, as_of: "2026-12-22", cure_by: "2027-01-21", cure_days: 30, cure_cents: 1_889_454n, hud_phone: "(800) 569-4287", cfpb_counselor_url: "consumerfinance.gov/find-a-housing-counselor" };

export const VERSIONS_14_1: VersionInput[] = [
  V("NTC_BK_PAYMENT_INSTRUCTIONS", PAYMENT_INSTRUCTIONS_SOURCE, PAYMENT_INSTRUCTIONS_RULES, PAYMENT_INSTRUCTIONS_SAMPLE, "bk.informational.2026-09", "14.1 outputs — informational notices; worked example A (payment change reminder citing the filed 410S-1); 14.1-T7"),
  V("NTC_BK_STATUS_INFO", STATUS_INFO_SOURCE, STATUS_INFO_RULES, STATUS_INFO_SAMPLE, "bk.informational.2026-09", "14.1 outputs — informational notices (responses to inbound questions); E-2.2-04 accounting views"),
  V("NTC_BK_BREACH_INFORMATIONAL", BREACH_INFORMATIONAL_SOURCE, BREACH_INFORMATIONAL_RULES, BREACH_INFORMATIONAL_SAMPLE, "bk.informational.2026-09", "14.1 rule 10 / worked example C — post-discharge breach letter variant for 13.x (E-2.2-01; §524(j)); 14.1-T10"),
];
export const OVERRIDES_14_1: Record<string, Partial<NoticeTemplate>> = {
  NTC_BK_PAYMENT_INSTRUCTIONS: { channelPolicy: "mail_only", citation: "11 U.S.C. §362(a)(6), §524(a)(2); E-2.1-06; 14.1 outputs — informational, mail-only unless counsel consents to e-mail, counsel-addressed where represented" },
  NTC_BK_STATUS_INFO: { channelPolicy: "mail_only", citation: "11 U.S.C. §362(a)(6); E-2.2-04; 14.1 outputs — responses to inbound questions, informational, mail-only unless counsel consents" },
  NTC_BK_BREACH_INFORMATIONAL: { channelPolicy: "mail_only", citation: "11 U.S.C. §524(a)(2), §524(j); Fannie Mae E-2.2-01; 14.1 rule 10 — post-discharge breach letter variant for 13.x, mail-only unless counsel consents" },
};
