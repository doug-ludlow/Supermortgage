/**
 * Authored template versions for the §7 compliance notices: the statement
 * variants and companions (7.1), the ARM notices (7.2), the E-SIGN/TCPA
 * consent documents (7.4), the Reg P privacy forms (7.5) and the payoff
 * statement family (7.6). Sample payloads come from the sections' worked
 * examples so the publish gate proves every template.
 */
import type { ContentRule, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const CONTACT = `{{#block "contact" page=1 y=0.92 pt=10}}Supermortgage · {{servicer_phone}} (toll-free) · {{servicer_address}} · Notices of error and requests for information: {{exclusive_address}}{{/block}}`;
const CONTACT_SAMPLE = { servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001" };
const CONTACT_RULE = R("contact", "§1026.41(d)(6); comment 35(c)-2", "presence", "\\(800\\) \\d{3}-\\d{4} \\(toll-free\\)", "toll-free number and exclusive NoE/RFI address");

// ------------------------------------------------------------------ 7.1 D2-2-03 payment reminder
const REMINDER_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Payment reminder{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}{{borrower_name}}, our records show that your payment due {{date due_date}} has not been received. We want to work with you to preserve homeownership. Late charges due: {{money late_charges_due_cents}}. Free HUD-approved housing counseling is available at HUD.gov or (800) 569-4287, and additional educational resources are at Fannie Mae's consumer website knowyouroptions.com.{{/block}}
${CONTACT}`;
const REMINDER_RULES: ContentRule[] = [
  R("name", "D2-2-03 item 1", "presence", "^\\s*\\S.*, our records show", "addresses the borrower by name"),
  R("work-with", "D2-2-03 item 2", "presence", "We want to work with you to preserve homeownership", "desire to work with the borrower"),
  R("late-charges", "D2-2-03 item 3", "presence", "Late charges due: \\$[\\d,]+\\.\\d{2}", "late charges due"),
  R("hud", "D2-2-03 item 4", "presence", "HUD\\.gov", "HUD-approved counseling"),
  R("fnma-site", "D2-2-03 item 5", "presence", "knowyouroptions\\.com", "Fannie Mae consumer website"),
  R("by-20th", "D2-2-03 timing", "data_range", "day_of_month_sent", "sent no later than the 20th", { range: { max: 20 } }),
  CONTACT_RULE,
];
const REMINDER_SAMPLE = { borrower_name: "Bea Borrower", due_date: "2026-10-01", late_charges_due_cents: 11671n, day_of_month_sent: 20, ...CONTACT_SAMPLE };

// ------------------------------------------------------------------ 7.1 Form 1098 (+ corrected)
const F1098_SOURCE = (corrected: boolean) => `{{#block "heading" page=1 y=0.05 pt=14 bold}}Form 1098 Mortgage Interest Statement — Tax year {{tax_year}}${corrected ? " — CORRECTED" : ""}{{/block}}
{{#block "parties" page=1 y=0.12 pt=10}}Recipient/lender: {{servicer_name}}, TIN {{servicer_tin}}. Payer/borrower: {{payer_name}}, account number {{account_number}}. Property: {{property_address}}.{{/block}}
{{#block "boxes" page=1 y=0.25 pt=10}}Box 1 Mortgage interest received from payer(s)/borrower(s): {{money box1_cents}}. Box 2 Outstanding mortgage principal as of {{date box2_as_of}}: {{money box2_cents}}. Box 3 Mortgage origination date: {{date box3_origination_date}}. Box 4 Refund of overpaid interest: {{money box4_cents}}. Box 5 Mortgage insurance premiums: {{money box5_cents}}. Box 6 Points paid on purchase of principal residence: {{money box6_cents}}. Box 10 Other (real estate taxes paid): {{money box10_cents}}. Box 11 Mortgage acquisition date: {{#if box11_acquisition_date}}{{date box11_acquisition_date}}{{else}}not applicable{{/if}}.{{/block}}
{{#block "furnish" page=1 y=0.6 pt=10}}Furnished to the payer by {{date furnish_by}}. This is important tax information and is being furnished to the IRS.{{/block}}
${CONTACT}`;
const F1098_RULES = (corrected: boolean): ContentRule[] => [
  R("box1", "IRC §6050H; Form 1098 box 1", "presence", "Box 1 Mortgage interest received from payer\\(s\\)/borrower\\(s\\): \\$[\\d,]+\\.\\d{2}", "box 1 interest received"),
  R("box2", "Form 1098 box 2", "presence", "Box 2 Outstanding mortgage principal as of (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}: \\$[\\d,]+\\.\\d{2}", "box 2 principal as of Jan 1 (or acquisition date)"),
  R("box3", "Form 1098 box 3", "presence", "Box 3 Mortgage origination date", "origination date"),
  R("box5", "Form 1098 box 5", "presence", "Box 5 Mortgage insurance premiums", "MI premiums"),
  R("box10", "Form 1098 box 10; 7.1 rule 11", "presence", "Box 10 Other \\(real estate taxes paid\\)", "informational real-estate taxes"),
  R("tin", "C-4.2-01: filed in the servicer's own name and TIN", "presence", "TIN \\d{2}-\\d{7}", "servicer TIN"),
  R("threshold", "Form 1098 instructions ($600 filing threshold; policy: furnish to all)", "data_range", "box1_cents_number", "box 1 ≥ $600 when filed", { range: { min: 60000 } }),
  R("furnish-jan31", "IRC §6050H(d)", "presence", "Furnished to the payer by January 31, \\d{4}", "furnish by January 31"),
  ...(corrected ? [R("corrected", "Form 1098 instructions (corrected returns)", "presence", "CORRECTED", "corrected box marked")] : [R("not-corrected", "7.1 rule 11", "absence", "CORRECTED", "original form carries no corrected marker")]),
  CONTACT_RULE,
];
const F1098_SAMPLE = { tax_year: 2026, servicer_name: "Supermortgage LLC", servicer_tin: "12-3456789", payer_name: "Bea Borrower", account_number: "0001234", property_address: "1 Test St, Testville TX 75001", box1_cents: 2341255n, box1_cents_number: 2341255, box2_as_of: "2026-01-01", box2_cents: 37104886n, box3_origination_date: "2021-11-01", box4_cents: 0n, box5_cents: 0n, box6_cents: 0n, box10_cents: 612500n, box11_acquisition_date: null, furnish_by: "2027-01-31", ...CONTACT_SAMPLE };

// ------------------------------------------------------------------ 7.1 (e)(3)(iv) coupon-book delinquency notice ((d)(8) items in writing)
const COUPON_DELQ_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Delinquency information{{/block}}
{{#block "d8" page=1 y=0.12 pt=11}}As of {{date statement_date}} you are {{days_delinquent}} days delinquent on your mortgage loan. Your delinquency began on {{date began_on}}. If you do not bring your loan current you may face foreclosure and additional expenses. Account history (last six months): {{#each history}}{{month}}: {{status}}; {{/each}}{{#if lossmit_program}}Loss mitigation program you have agreed to: {{lossmit_program}}.{{else}}No loss mitigation program is in place.{{/if}} {{#if first_notice_filed}}We have made the first notice or filing for foreclosure.{{else}}No foreclosure filing has been made.{{/if}} Total amount needed to bring the account current: {{money reinstatement_cents}}. Housing counselor information: {{counselor_url}} · HUD (800) 569-4287.{{/block}}
${CONTACT}`;
const COUPON_DELQ_RULES: ContentRule[] = [
  R("i-began", "§1026.41(d)(8)(i)", "presence", "delinquency began on", "date delinquency began"),
  R("ii-risks", "§1026.41(d)(8)(ii)", "presence", "may face foreclosure and additional expenses", "risks such as foreclosure and expenses"),
  R("iii-history", "§1026.41(d)(8)(iii)", "presence", "Account history \\(last six months\\)", "six-month history"),
  R("iv-lossmit", "§1026.41(d)(8)(iv)", "presence", "(Loss mitigation program you have agreed to|No loss mitigation program is in place)", "loss mitigation program"),
  R("v-first-notice", "§1026.41(d)(8)(v)", "presence", "(first notice or filing for foreclosure|No foreclosure filing has been made)", "first notice or filing"),
  R("vi-reinstatement", "§1026.41(d)(8)(vi)", "presence", "bring the account current: \\$[\\d,]+\\.\\d{2}", "amount to bring current"),
  R("vii-counselor", "§1026.41(d)(8)(vii)", "presence", "Housing counselor information", "counselor reference"),
  R("gt-45", "§1026.41(e)(3)(iv)", "data_range", "days_delinquent", "issued only when more than 45 days delinquent", { range: { min: 46 } }),
  CONTACT_RULE,
];
const COUPON_DELQ_SAMPLE = { statement_date: "2026-10-17", days_delinquent: 46, began_on: "2026-09-02", history: [{ month: "Sep", status: "$2,946.79 remaining" }, { month: "Oct", status: "$2,946.79 remaining" }], lossmit_program: null, first_notice_filed: false, reinstatement_cents: 612700n, counselor_url: "consumerfinance.gov/find-a-housing-counselor", ...CONTACT_SAMPLE };

// ------------------------------------------------------------------ 7.1 (e)(6) charge-off suspension
const CHARGEOFF_SOURCE = `{{#block "title" page=1 y=0.05 pt=14 bold}}Suspension of Statements & Notice of Charge Off — Retain This Copy for Your Records{{/block}}
{{#block "body" page=1 y=0.15 pt=11}}Loan number ending {{account_last4}}. Effective {{date chargeoff_date}}: (1) your mortgage loan has been charged off and we will not charge any additional fees or interest on the account; (2) we will no longer provide you a periodic statement for each billing cycle; (3) the lien on the property remains in place and you remain liable for the mortgage loan obligation and any obligations arising from or related to the property, which may include property taxes; (4) you may be required to pay the balance on the account in the future, for example upon sale of the property; (5) the balance on the account, {{money balance_cents}}, is not being canceled or forgiven; (6) the loan may be purchased, assigned, or transferred; (7) you may request a payoff statement at any time by contacting us.{{/block}}
${CONTACT}`;
const CHARGEOFF_RULES: ContentRule[] = [
  R("title-exact", "§1026.41(e)(6)(i)(B)", "presence", "Suspension of Statements & Notice of Charge Off — Retain This Copy for Your Records", "exact title"),
  R("item-1", "§1026.41(e)(6)(i)(B)", "presence", "charged off and we will not charge any additional fees or interest", "no additional fees or interest"),
  R("item-2", "§1026.41(e)(6)(i)(B)", "presence", "no longer provide you a periodic statement", "statements suspended"),
  R("item-3", "§1026.41(e)(6)(i)(B)", "presence", "lien on the property remains in place and you remain liable", "lien and liability"),
  R("item-4", "§1026.41(e)(6)(i)(B)", "presence", "may be required to pay the balance on the account in the future", "future payment"),
  R("item-5", "§1026.41(e)(6)(i)(B)", "presence", "is not being canceled or forgiven", "balance not forgiven"),
  R("item-6", "§1026.41(e)(6)(i)(B)", "presence", "may be purchased, assigned, or transferred", "transfer"),
  R("item-7", "7.1 rule 5; §1026.36(c)(3)", "presence", "request a payoff statement", "payoff statement availability"),
  R("within-30", "§1026.41(e)(6)(i)(B)", "data_range", "days_after_chargeoff", "sent within 30 days of charge-off", { range: { max: 30 } }),
  CONTACT_RULE,
];
const CHARGEOFF_SAMPLE = { account_last4: "1234", chargeoff_date: "2026-11-03", balance_cents: 37104886n, days_after_chargeoff: 30, ...CONTACT_SAMPLE };

// ------------------------------------------------------------------ 7.1 statement availability email (comment 41(c)-3)
const AVAIL_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}Your mortgage statement dated {{date statement_date}} for the loan ending {{account_last4}} is available. View it at {{portal_url}} (log in to see the amount due and payment due date). This message contains no account balances. To receive paper statements instead, reply or call {{servicer_phone}}.{{/block}}`;
const AVAIL_RULES: ContentRule[] = [
  R("link", "comment 41(c)-3", "presence", "available\\. View it at https://", "link to where the statement can be accessed"),
  R("no-amounts", "7.4 rule 9 / security", "absence", "\\$[\\d,]+\\.\\d{2}", "no balances in the email"),
  R("consent", "7.4 rule 9", "data_equality", "consent_status", "sent only under an active periodic_statements consent", { predicate: { "==": [{ var: "consent_status" }, "active"] } }),
];
const AVAIL_SAMPLE = { statement_date: "2026-10-17", account_last4: "1234", portal_url: "https://portal.example.com/statements", consent_status: "active", servicer_phone: "(800) 555-0100" };

// ------------------------------------------------------------------ 7.1 bankruptcy statement variants (H-30(E)/(F))
const BK_COMMON = `{{#block "legend" page=1 y=0.02 pt=10 bold}}This statement is for informational purposes only. {{#if discharged}}Our records show that you received a discharge in bankruptcy; this statement is not an attempt to collect a debt from you personally.{{else}}Our records show that you are a debtor in a bankruptcy case; this statement is not an attempt to collect a debt.{{/if}}{{/block}}`;
const BK7_SOURCE = `${BK_COMMON}
{{#block "amount_due" page=1 y=0.08 pt=14 bold}}Amount due {{money amount_due_cents}} — payment due date {{date due_date}}{{/block}}
{{#block "explanation" page=1 y=0.18 pt=10}}Explanation of amount due: principal {{money principal_cents}}, interest {{money interest_cents}}, escrow {{money escrow_cents}}; total {{money amount_due_cents}}.{{/block}}
{{#block "past_payments" page=1 y=0.3 pt=10}}Payments received since last statement: {{money payments_since_last_cents}}. Year to date: {{money ytd_cents}}; unapplied funds currently held {{money suspense_held_cents}}.{{/block}}
{{#block "transactions" page=2 y=0.1 pt=10}}Transaction activity: {{#each transactions}}{{date date}} {{description}} {{money amount_cents}}; {{/each}}{{/block}}
{{#block "account" page=1 y=0.45 pt=10}}Loan number ending {{account_last4}} · Unpaid principal balance {{money upb_cents}} · Interest rate {{pct rate_pct}} · No prepayment penalty · Housing counselor information: {{counselor_url}} · HUD {{hud_phone}}{{/block}}
${CONTACT}`;
const BK13_SOURCE = `${BK_COMMON}
{{#block "amount_due" page=1 y=0.08 pt=14 bold}}Post-petition amount due {{money post_petition_due_cents}} — payment due date {{date due_date}}{{/block}}
{{#block "explanation" page=1 y=0.18 pt=10}}Explanation of post-petition amount due: principal {{money principal_cents}}, interest {{money interest_cents}}, escrow {{money escrow_cents}}; total {{money post_petition_due_cents}}.{{/block}}
{{#block "arrearage" page=1 y=0.3 pt=10}}Pre-petition arrearage: total {{money prepetition_arrearage_cents}}; paid by the trustee to date {{money prepetition_paid_cents}}; remaining {{money prepetition_remaining_cents}}. Payments made by the trustee are shown as received.{{/block}}
{{#block "past_payments" page=1 y=0.4 pt=10}}Payments received since last statement: {{money payments_since_last_cents}} (including trustee payments {{money trustee_payments_cents}}). Year to date: {{money ytd_cents}}; unapplied funds currently held {{money suspense_held_cents}}.{{/block}}
{{#block "transactions" page=2 y=0.1 pt=10}}Transaction activity: {{#each transactions}}{{date date}} {{description}} {{money amount_cents}}; {{/each}}{{/block}}
{{#block "account" page=1 y=0.55 pt=10}}Loan number ending {{account_last4}} · Unpaid principal balance {{money upb_cents}} · Interest rate {{pct rate_pct}} · No prepayment penalty · Housing counselor information: {{counselor_url}} · HUD {{hud_phone}}{{/block}}
${CONTACT}`;
const BK_RULES = (ch13: boolean): ContentRule[] => [
  R("legend", "§1026.41(f)(1)/(3); H-30(E)/(F)", "presence", "for informational purposes only", "informational legend"),
  R("debtor", "§1026.41(f)(3)(ii)", "presence", "(debtor in a bankruptcy case|received a discharge in bankruptcy)", "debtor/discharge statement"),
  R("no-late-fee", "§1026.41(f)(3)(i)", "absence", "late fee", "no late-fee language"),
  R("no-delinquency-risk", "§1026.41(f)(3)(i)", "absence", "(days delinquent|foreclosure)", "no delinquency-length or foreclosure language"),
  R("account", "§1026.41(d)(7)", "presence", "Unpaid principal balance .* Interest rate", "account information"),
  R("bk-case", "7.1 guardrail: bk_* requires an open bankruptcy case with a docket reference", "data_equality", "docket_reference", "docket reference present", { predicate: { present: "docket_reference" } }),
  ...(ch13 ? [R("post-petition", "§1026.41(f)(5)(i)", "presence", "Post-petition amount due \\$[\\d,]+\\.\\d{2}", "post-petition amount due"), R("arrearage", "§1026.41(f)(5)(iii)–(v)", "presence", "Pre-petition arrearage: total \\$[\\d,]+\\.\\d{2}; paid by the trustee to date \\$[\\d,]+\\.\\d{2}; remaining \\$[\\d,]+\\.\\d{2}", "pre-petition arrearage figures"), R("trustee", "CFPB FAQ (Mar. 20, 2018)", "presence", "trustee payments", "trustee payments as transaction activity")] : [R("amount-due", "§1026.41(d)(1)", "presence", "Amount due \\$[\\d,]+\\.\\d{2}", "amount due")]),
  CONTACT_RULE,
];
const BK_SAMPLE = { discharged: false, docket_reference: "PACER 26-12345", due_date: "2026-12-01", amount_due_cents: 294679n, post_petition_due_cents: 294679n, principal_cents: 41750n, interest_cents: 191679n, escrow_cents: 61250n, prepetition_arrearage_cents: 589358n, prepetition_paid_cents: 98226n, prepetition_remaining_cents: 491132n, payments_since_last_cents: 392905n, trustee_payments_cents: 98226n, ytd_cents: 2357432n, suspense_held_cents: 0n, transactions: [{ date: "2026-11-10", description: "Trustee payment received", amount_cents: 98226n }], account_last4: "1234", upb_cents: 37104886n, rate_pct: "5.750", counselor_url: "consumerfinance.gov/find-a-housing-counselor", hud_phone: "(800) 569-4287", ...CONTACT_SAMPLE };

// ------------------------------------------------------------------ 7.1 trial period plan statement
const TPP_SOURCE = `{{#block "amount_due" page=1 y=0.05 pt=14 bold}}Amount due under your trial period plan {{money tpp_payment_cents}} — payment due date {{date due_date}}{{/block}}
{{#block "explanation" page=1 y=0.15 pt=10}}Explanation of amount due: your trial period plan payment is {{money tpp_payment_cents}}. Your contractual payment is {{money contractual_payment_cents}} (principal {{money principal_cents}}, interest {{money interest_cents}}, escrow {{money escrow_cents}}); past due under the contract {{money past_due_cents}}. Payments are applied according to your loan contract.{{/block}}
{{#block "late_fee" page=1 y=0.25 pt=10}}If payment is received after {{date late_fee_after_date}}, a late fee of {{money late_fee_cents}} will be charged.{{/block}}
{{#block "past_payments" page=1 y=0.32 pt=10}}Payments received since last statement: {{money payments_since_last.total_cents}} (principal {{money payments_since_last.principal_cents}}, interest {{money payments_since_last.interest_cents}}, escrow {{money payments_since_last.escrow_cents}}, fees {{money payments_since_last.fees_cents}}, unapplied {{money payments_since_last.suspense_cents}}). Year to date: {{money ytd.total_cents}}; unapplied funds currently held {{money ytd.suspense_held_cents}}.{{/block}}
{{#if suspense_instructions}}{{#block "suspense" page=1 y=0.42 pt=10}}{{suspense_instructions}}{{/block}}{{/if}}
{{#block "delinquency" page=1 y=0.5 pt=10 bold}}As of {{date statement_date}} you are {{days_delinquent}} days delinquent under your loan contract; your first unpaid payment was due {{date began_on}}. Loss mitigation program: trial period plan. Amount to bring the loan current: {{money reinstatement_cents}}. Housing counselor information: {{counselor_url}} · HUD {{hud_phone}}{{/block}}
{{#block "transactions" page=2 y=0.1 pt=10}}Transaction activity: {{#each transactions}}{{date date}} {{description}} {{money amount_cents}}; {{/each}}{{/block}}
{{#block "account" page=1 y=0.7 pt=10}}Loan number ending {{account_last4}} · Unpaid principal balance {{money upb_cents}} · Interest rate {{pct rate_pct}} · No prepayment penalty{{/block}}
${CONTACT}`;
const TPP_RULES: ContentRule[] = [
  R("tpp-amount", "comment 41(d)(1)-2", "presence", "Amount due under your trial period plan \\$[\\d,]+\\.\\d{2}", "TPP amount as the amount due"),
  R("both-amounts", "comment 41(d)(2)-2", "presence", "trial period plan payment is \\$[\\d,]+\\.\\d{2}\\. Your contractual payment is \\$[\\d,]+\\.\\d{2}", "explanation shows both amounts"),
  R("per-contract", "comment 41(d)-4", "presence", "applied according to your loan contract", "application per contract"),
  R("d3-ytd-suspense", "comment 41(d)(3)-1; 2.6 rule (trial funds disclosed)", "presence", "unapplied funds currently held", "YTD suspense held (trial funds)"),
  R("d5-suspense", "§1026.41(d)(5); 2.6-T5", "conditional", "suspense_instructions", "instructions when trial funds are held", { when: { ">": [{ var: "ytd.suspense_held_cents" }, 0] }, predicate: { present: "suspense_instructions" } }),
  R("d8-if-delinquent", "§1026.41(d)(8); 7.1 rule 6", "conditional", "reinstatement_cents", "delinquency box stays while the contract is delinquent", { when: { ">": [{ var: "days_delinquent" }, 45] }, predicate: { present: "reinstatement_cents" } }),
  R("account", "§1026.41(d)(7)", "presence", "Unpaid principal balance .* Interest rate", "account information"),
  CONTACT_RULE,
];
const TPP_SAMPLE = { tpp_payment_cents: 210000n, due_date: "2026-12-01", contractual_payment_cents: 294679n, principal_cents: 41750n, interest_cents: 191679n, escrow_cents: 61250n, past_due_cents: 589358n, late_fee_after_date: "2026-12-16", late_fee_cents: 11671n, payments_since_last: { total_cents: 210000n, principal_cents: 0n, interest_cents: 0n, escrow_cents: 0n, fees_cents: 0n, suspense_cents: 210000n }, ytd: { total_cents: 2567432n, suspense_held_cents: 210000n }, suspense_instructions: "We are holding $2,100.00 toward your trial period plan payment due December 1, 2026; it will be applied when the trial payment is complete.", statement_date: "2026-11-17", days_delinquent: 77, began_on: "2026-09-02", reinstatement_cents: 907379n, counselor_url: "consumerfinance.gov/find-a-housing-counselor", hud_phone: "(800) 569-4287", transactions: [{ date: "2026-11-02", description: "Trial period plan payment received", amount_cents: 210000n }], account_last4: "1234", upb_cents: 37104886n, rate_pct: "5.750", ...CONTACT_SAMPLE };

// ------------------------------------------------------------------ 7.2 Reg Z (c) ARM adjustment notice (H-4(D)(2))
const ARM_C_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Changes to your mortgage interest rate and payments on {{date change_date}}{{/block}}
{{#block "statement" page=1 y=0.12 pt=11}}Under the terms of your adjustable-rate mortgage, your interest rate and monthly payment will change on {{date change_date}}, and your rate may change again {{schedule_sentence}}.{{/block}}
{{#block "table" page=1 y=0.2 pt=11}}Current interest rate {{pct current_rate_pct}} — new interest rate {{pct new_rate_pct}}. Current principal and interest payment {{money current_pi_cents}} — new principal and interest payment {{money new_pi_cents}}, due {{date first_new_payment_due}}. {{#if interest_only}}Allocation: principal {{money new_principal_cents}}, interest {{money new_interest_cents}}, escrow {{money escrow_cents}}.{{/if}}{{/block}}
{{#block "index" page=1 y=0.35 pt=11}}Your new rate is based on the {{index_name}}, published by {{index_source}}, which was {{index_value}} on {{date index_date}}. Your margin of {{pct margin_pct}} percentage points is added to the index; the result is rounded to the nearest one-eighth of one percent.{{/block}}
{{#block "caps" page=1 y=0.47 pt=11}}Rate limits: your rate cannot increase or decrease by more than {{pct cap_this_change_pct}} at this change or ever exceed {{pct lifetime_cap_pct}}; it will never fall below {{pct floor_pct}}. {{#if cap_applied}}Your rate would have been {{pct uncapped_rate_pct}} but the cap limits it to {{pct new_rate_pct}}.{{else}}No limit applied at this change.{{/if}}{{/block}}
{{#block "balance" page=1 y=0.58 pt=11}}Your expected loan balance on {{date change_date}} is {{money expected_upb_cents}} and the remaining term is {{remaining_term_months}} months. Your new payment will fully repay the loan over the remaining term. There is no prepayment penalty.{{/block}}
{{#block "escrow" page=1 y=0.68 pt=10}}Additional information: with escrow of {{money escrow_cents}}, your total monthly payment will be {{money total_payment_cents}} (currently {{money current_total_cents}}). Next scheduled rate change: {{date next_change_date}}.{{/block}}
${CONTACT}`;
const ARM_C_RULES: ContentRule[] = [
  R("i-statement", "§1026.20(c)(2)(i)", "presence", "will change on .* and your rate may change again", "change statement with effective date and schedule"),
  R("ii-table", "§1026.20(c)(2)(ii)", "presence", "Current interest rate \\d+\\.\\d{3}% — new interest rate \\d+\\.\\d{3}%\\. Current principal and interest payment \\$[\\d,]+\\.\\d{2} — new principal and interest payment \\$[\\d,]+\\.\\d{2}, due", "rate/payment table with the first new payment due date"),
  R("iii-index", "§1026.20(c)(2)(iii)", "presence", "published by .* which was", "index and source"),
  R("iv-margin", "§1026.20(c)(2)(iv)", "presence", "margin of \\d+\\.\\d{3}% percentage points is added to the index", "margin explanation"),
  R("v-caps", "§1026.20(c)(2)(v)", "presence", "cannot increase or decrease by more than", "cap statement"),
  R("vi-balance", "§1026.20(c)(2)(vi)", "presence", "expected loan balance .* remaining term is \\d+ months", "expected balance and remaining term"),
  R("vi-amortization", "§1026.20(c)(2)(vi)", "presence", "fully repay the loan over the remaining term", "amortization statement"),
  R("vii-prepay", "§1026.20(c)(2)(vii)", "presence", "prepayment penalty", "prepayment penalty statement"),
  R("timing-window", "§1026.20(c)(2); comment 20(c)(2)-1", "data_range", "days_before_first_payment", "sent 60–120 days before the first new payment", { range: { min: 60, max: 120 } }),
  R("dual-engine", "7.2 agent design", "data_equality", "engines_agree", "both engines agree to the cent", { predicate: { "==": [{ var: "engines_agree" }, true] } }),
  CONTACT_RULE,
];
const ARM_C_SAMPLE = { change_date: "2026-11-01", schedule_sentence: "every six months thereafter", current_rate_pct: "5.750", new_rate_pct: "6.375", current_pi_cents: 233429n, new_pi_cents: 247644n, first_new_payment_due: "2026-12-01", interest_only: false, index_name: "30-day Average SOFR", index_source: "the Federal Reserve Bank of New York (newyorkfed.org)", index_value: "3.64883", index_date: "2026-09-17", margin_pct: "2.750", cap_this_change_pct: "2.000", lifetime_cap_pct: "10.750", floor_pct: "2.750", cap_applied: false, uncapped_rate_pct: "6.375", expected_upb_cents: 37104886n, remaining_term_months: 300, escrow_cents: 61250n, total_payment_cents: 308894n, current_total_cents: 294679n, next_change_date: "2027-05-01", days_before_first_payment: 75, engines_agree: true, ...CONTACT_SAMPLE };

// ------------------------------------------------------------------ 7.2 Fannie Mae rate-change / buydown / correction / interim
const RATE_CHANGE_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Notice of change to your mortgage loan effective {{date effective_date}}{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}This notice is required by your mortgage loan documents (Fannie Mae Servicing Guide C-2.1-02) and is provided for your information. {{#if rate_changed}}Your interest rate changes from {{pct current_rate_pct}} to {{pct new_rate_pct}} on {{date effective_date}}.{{/if}} {{#if payment_changed}}Your monthly payment changes from {{money current_payment_cents}} to {{money new_payment_cents}} with the payment due {{date first_new_payment_due}}.{{else}}Your monthly payment of {{money current_payment_cents}} does not change.{{/if}}{{/block}}
${CONTACT}`;
const RATE_CHANGE_RULES: ContentRule[] = [
  R("effective", "C-2.1-02", "presence", "effective (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "effective date"),
  R("required-by-contract", "7.2 decision 4; C-2.1-02", "presence", "required by your mortgage loan documents", "marked as contract-required information, not a collection communication"),
  R("change", "C-2.1-02", "presence", "(interest rate changes from|monthly payment changes from|does not change)", "the change described"),
  R("25-days", "7.2 rule 6 (policy ≥ 25 days)", "data_range", "days_before_effective", "sent at least 25 days before the effective date", { range: { min: 25 } }),
  CONTACT_RULE,
];
const RATE_CHANGE_SAMPLE = { effective_date: "2026-11-01", rate_changed: true, payment_changed: false, current_rate_pct: "5.750", new_rate_pct: "6.375", current_payment_cents: 233429n, new_payment_cents: 233429n, first_new_payment_due: "2026-12-01", days_before_effective: 25, ...CONTACT_SAMPLE };
const BUYDOWN_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Your temporary buydown payment increases on {{date step_date}}{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}Your temporary interest rate buydown steps up on {{date step_date}}: the rate you pay changes from {{pct current_effective_rate_pct}} to {{pct new_effective_rate_pct}} (note rate {{pct note_rate_pct}}) and your monthly principal and interest payment changes from {{money current_pi_cents}} to {{money new_pi_cents}}, first due {{date first_new_payment_due}}. This notice is sent 90 days before the payment change as required by your loan documents.{{/block}}
${CONTACT}`;
const BUYDOWN_RULES: ContentRule[] = [
  R("step", "C-2.1-02 temporary buydowns", "presence", "steps up on", "pending increase described"),
  R("amounts", "C-2.1-02", "presence", "payment changes from \\$[\\d,]+\\.\\d{2} to \\$[\\d,]+\\.\\d{2}", "current and new payment"),
  R("90-days", "C-2.1-02 (90 days prior)", "data_range", "days_before_change", "sent 90 days before the payment change", { range: { min: 90 } }),
  CONTACT_RULE,
];
const BUYDOWN_SAMPLE = { step_date: "2027-01-01", current_effective_rate_pct: "3.750", new_effective_rate_pct: "4.750", note_rate_pct: "5.750", current_pi_cents: 185245n, new_pi_cents: 208650n, first_new_payment_due: "2027-01-01", days_before_change: 90, ...CONTACT_SAMPLE };
const CORRECTION_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Correction of an error in your adjustable-rate mortgage adjustment{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}We found that the interest rate applied from {{date first_erroneous_change_date}} was {{pct erroneous_rate_pct}}; the correct rate under your note was {{pct correct_rate_pct}} (margin {{pct correct_margin_pct}} rather than {{pct erroneous_margin_pct}}). We re-amortized your loan from that date using the correct rate and the payments you actually made. Effect of the correction: {{#if overcharge}}you were overcharged {{money net_effect_cents}}. {{#if cash_refund}}A refund check for {{money net_effect_cents}} is enclosed; if you prefer, you may elect to apply it to your principal balance by calling us.{{else}}We have credited {{money net_effect_cents}} to your account.{{/if}}{{else}}the error was in your favor by {{money net_effect_cents}}; we will not collect it and your balance has not been changed.{{/if}} Your corrected principal balance is {{money corrected_upb_cents}} and your corrected payment is {{money corrected_pi_cents}}.{{/block}}
${CONTACT}`;
const CORRECTION_RULES: ContentRule[] = [
  R("effect", "C-2.2-01: notify the borrower about the effect of the correction", "presence", "Effect of the correction:", "effect of the correction"),
  R("re-amortized", "C-2.2-01 / F-1-01", "presence", "re-amortized your loan from that date", "re-amortization from the first erroneous adjustment"),
  R("refund-or-credit", "C-2.2-03", "presence", "(refund check|credited|will not collect it)", "refund, credit or absorbed undercharge"),
  R("election", "C-2.2-03 (borrower election)", "conditional", "cash_refund", "curtailment election offered with a cash refund", { when: { "==": [{ var: "cash_refund" }, true] }, predicate: { "==": [{ var: "election_offered" }, true] } }),
  CONTACT_RULE,
];
const CORRECTION_SAMPLE = { first_erroneous_change_date: "2026-11-01", erroneous_rate_pct: "6.875", correct_rate_pct: "6.375", correct_margin_pct: "2.750", erroneous_margin_pct: "3.250", overcharge: true, cash_refund: true, election_offered: true, net_effect_cents: 108314n, corrected_upb_cents: 36892544n, corrected_pi_cents: 247644n, ...CONTACT_SAMPLE };
const INTERIM_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We received your inquiry about your adjustable-rate mortgage adjustment on {{date received_date}}. We are still reviewing the {{issue}} and expect to complete our review by {{date expected_resolution_date}}. This interim response is sent because we could not resolve your inquiry within 20 days. Nothing in this letter changes your obligations under the note.{{/block}}
${CONTACT}`;
const INTERIM_RULES: ContentRule[] = [
  R("received", "C-2.2-01 (20-day interim response)", "presence", "received your inquiry .* on", "acknowledges the inquiry date"),
  R("expected", "C-2.2-01", "presence", "expect to complete our review by", "expected resolution date"),
  R("within-20", "C-2.2-01", "data_range", "days_after_receipt", "sent within 20 days of receipt", { range: { max: 20 } }),
  CONTACT_RULE,
];
const INTERIM_SAMPLE = { received_date: "2026-10-05", issue: "margin recorded at boarding", expected_resolution_date: "2026-11-15", days_after_receipt: 20, ...CONTACT_SAMPLE };

// ------------------------------------------------------------------ 7.4 E-SIGN / TCPA documents
const ESIGN_DISCLOSURE_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Consent to receive documents electronically (E-SIGN disclosure {{disclosure_version}}){{/block}}
{{#block "items" page=1 y=0.12 pt=11}}(1) Paper option and withdrawal: you have the right to have these documents provided on paper and the right to withdraw your consent at any time; withdrawal has no fee and no other consequence except that future documents will be mailed. (2) Scope: your consent applies to the following categories of records during our relationship: {{#each classes}}{{this}}; {{/each}}(3) Withdrawal and contact updates: withdraw or update your email address in the portal at {{portal_url}}, by calling {{servicer_phone}}, or by writing to {{servicer_address}}. (4) Paper copies: request a paper copy of any document at no fee by the same means. (5) Hardware and software requirements: {{hardware_software_requirements}}. (6) Demonstration: to consent you will open the link in our verification email and enter the code printed in the attached PDF, which shows you can access documents in the format we will use. (7) Consent is given electronically through the portal; a spoken statement or recording is not electronic consent.{{/block}}`;
const ESIGN_DISCLOSURE_RULES: ContentRule[] = [
  R("i-paper-withdraw", "15 U.S.C. 7001(c)(1)(B)(i)", "presence", "right to have these documents provided on paper and the right to withdraw", "paper option and withdrawal with conditions/consequences/fees"),
  R("ii-scope", "7001(c)(1)(B)(ii)", "presence", "applies to the following categories of records", "scope by categories"),
  R("iii-procedures", "7001(c)(1)(B)(iii)", "presence", "withdraw or update your email address", "withdrawal and contact-update procedures"),
  R("iv-paper-copy", "7001(c)(1)(B)(iv)", "presence", "request a paper copy of any document at no fee", "paper copy procedure and fee"),
  R("c-hwsw", "7001(c)(1)(C)(i)", "presence", "Hardware and software requirements:", "hardware/software statement"),
  R("c-demonstration", "7001(c)(1)(C)(ii)", "presence", "enter the code printed in the attached PDF", "demonstration test"),
  R("no-oral", "7001(c)(6)", "presence", "spoken statement or recording is not electronic consent", "oral consent excluded"),
];
const ESIGN_DISCLOSURE_SAMPLE = { disclosure_version: "v1.3", classes: ["periodic statements", "escrow statements", "ARM notices", "servicing notices", "privacy notices"], portal_url: "https://portal.example.com", hardware_software_requirements: "a current browser, an email address, and a PDF viewer (Adobe Reader 11 or later or equivalent)", servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001" };
const ESIGN_CONFIRM_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}Thank you. On {{date consented_on}} you consented to receive the following documents electronically: {{#each classes}}{{this}}; {{/each}}Disclosure version {{disclosure_version}}. You may request a paper copy of any document at no charge, and you may withdraw your consent at any time at {{portal_url}} or by calling {{servicer_phone}}.{{/block}}`;
const ESIGN_CONFIRM_RULES: ContentRule[] = [R("classes", "7.4 rule 1", "presence", "consented to receive the following documents electronically:", "classes listed"), R("paper-copy", "7001(c)(1)(B)(iv)", "presence", "paper copy of any document at no charge", "paper copy on request"), R("verified", "7001(c)(1)(C)(ii)", "data_equality", "status", "sent only for an active (verified) consent", { predicate: { "==": [{ var: "status" }, "active"] } })];
const ESIGN_CONFIRM_SAMPLE = { consented_on: "2026-10-02", classes: ["periodic statements", "ARM notices"], disclosure_version: "v1.3", portal_url: "https://portal.example.com", servicer_phone: "(800) 555-0100", status: "active" };
const HWSW_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We are changing the hardware and software needed to receive your documents electronically. Revised requirements: {{revised_requirements}}. This change may affect your ability to access or keep future electronic documents, so we need you to confirm access again by {{date reconfirm_by}} using the link and code we will send. You have the right to withdraw your consent without any fee or other consequence; until you confirm, we will send your documents by mail.{{/block}}`;
const HWSW_RULES: ContentRule[] = [R("revised", "7001(c)(1)(D)(i)", "presence", "Revised requirements:", "statement of revised requirements"), R("withdraw-no-fee", "7001(c)(1)(D)(i)", "presence", "withdraw your consent without any fee", "right to withdraw without fees"), R("redemonstrate", "7001(c)(1)(D)(ii)", "presence", "confirm access again", "re-demonstration required")];
const HWSW_SAMPLE = { revised_requirements: "a browser released within the last 24 months and a PDF viewer supporting PDF 1.7", reconfirm_by: "2027-02-15" };
const VERIFY_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}To finish setting up electronic delivery, open this link from this email: {{verification_url}} and enter the 6-character code printed in the attached PDF. The link and code expire on {{date expires_on}} (7 days). If you did not request this, ignore this message.{{/block}}`;
const VERIFY_RULES: ContentRule[] = [R("link", "7001(c)(1)(C)(ii); 7.4 rule 2", "presence", "open this link from this email: https://", "verification link"), R("token", "7.4 rule 2", "presence", "6-character code printed in the attached PDF", "token in the PDF"), R("expiry", "7.4 rule 2", "presence", "expire on .* \\(7 days\\)", "7-day window")];
const VERIFY_SAMPLE = { verification_url: "https://portal.example.com/verify/abc123", expires_on: "2026-10-09" };
const WITHDRAW_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We received your request on {{date received_on}} to stop electronic delivery{{#if partial}} for: {{#each classes}}{{this}}; {{/each}}{{/if}}. Effective {{date effective_on}}, those documents will be sent to you by mail at {{mailing_address}}. Documents already delivered electronically remain available in the portal. There is no fee for withdrawing.{{/block}}
${CONTACT}`;
const WITHDRAW_RULES: ContentRule[] = [R("effective", "7.4 rule 7 (1 business day)", "presence", "Effective .* will be sent to you by mail", "effective date and mail reversion"), R("no-fee", "7001(c)(1)(B)(i)", "presence", "no fee for withdrawing", "no fee"), R("prior-records", "7001(c)(4)", "presence", "already delivered electronically remain available", "prior records unaffected"), CONTACT_RULE];
const WITHDRAW_SAMPLE = { received_on: "2026-12-01", partial: false, classes: [], effective_on: "2026-12-02", mailing_address: "1 Test St, Testville TX 75001", ...CONTACT_SAMPLE };
const BOUNCE_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We could not deliver the email notifying you that your {{document_name}} dated {{date document_date}} was available (the message to {{email_masked}} was returned). A paper copy is enclosed, and we will send your documents by mail until you confirm your email address in the portal at {{portal_url}}. Enclosed: {{document_name}}.{{/block}}
${CONTACT}`;
const BOUNCE_RULES: ContentRule[] = [R("bounced", "7.4 rule 8", "presence", "was returned", "explains the bounce"), R("paper", "7.4 rule 8 (same-day mail)", "presence", "paper copy is enclosed", "paper copy enclosed"), R("reverify", "7.4 rule 8", "presence", "confirm your email address", "re-verification invitation"), CONTACT_RULE];
const BOUNCE_SAMPLE = { document_name: "periodic statement", document_date: "2026-12-03", email_masked: "b***@example.com", portal_url: "https://portal.example.com", ...CONTACT_SAMPLE };
const IRS_ECONSENT_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Consent to receive your Form 1098 electronically{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}If you do not consent, your Form 1098 will be furnished on paper. Your consent applies to Form 1098 for tax year {{tax_year}} and later years until you withdraw it. Withdraw at any time at {{portal_url}}, by calling {{servicer_phone}} or in writing; withdrawal takes effect for statements not yet furnished and we will confirm it. We may stop electronic furnishing, in which case you will receive paper. Update your contact information in the portal. Hardware and software requirements: {{hardware_software_requirements}}. Your Form 1098 will be posted in the portal by January 31 and remain accessible through October 15 of the following year; you may print or save it, and you may request a paper copy at no charge. To consent, complete the electronic verification (link and code) so we know you can access the form.{{/block}}`;
const IRS_ECONSENT_RULES: ContentRule[] = [R("paper-default", "Treas. Reg. §1.6050H-2(a)(4)(ii)", "presence", "If you do not consent, your Form 1098 will be furnished on paper", "paper default"), R("scope", "§1.6050H-2(a)(4)(ii)", "presence", "applies to Form 1098 for tax year", "scope and duration"), R("withdraw", "§1.6050H-2(a)(4)(ii)", "presence", "Withdraw at any time", "withdrawal procedure and effect"), R("access", "§1.6050H-2(a)(4)(ii); Pub. 1179", "presence", "posted in the portal by January 31 and remain accessible through October 15", "posting and access period"), R("hwsw", "§1.6050H-2(a)(4)(ii)", "presence", "Hardware and software requirements:", "hardware/software"), R("paper-copy", "§1.6050H-2(a)(4)(ii)", "presence", "paper copy at no charge", "paper copy on request")];
const IRS_ECONSENT_SAMPLE = { tax_year: 2026, portal_url: "https://portal.example.com", servicer_phone: "(800) 555-0100", hardware_software_requirements: "a current browser and a PDF viewer" };
const TCPA_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}Supermortgage: you agreed on {{date consented_on}} to receive {{channel_description}} at {{number_masked}} about your mortgage loan. Consent language: "{{consent_language}}". Message and data rates may apply. Reply STOP to stop texts at any time or call {{servicer_phone}}; reply HELP for help.{{/block}}`;
const TCPA_RULES: ContentRule[] = [R("number", "7.4 rule 12 (TCPA ledger)", "presence", "at \\(\\*\\*\\*\\) \\*\\*\\*-\\d{4}", "number recorded (masked)"), R("language", "7.4 rule 12", "presence", "Consent language: \"", "the consent language"), R("stop", "47 CFR 64.1200 (revocation by any reasonable means)", "presence", "Reply STOP to stop", "STOP instructions"), R("date", "7.4 rule 12", "presence", "agreed on (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "consent date")];
const TCPA_SAMPLE = { consented_on: "2026-10-02", channel_description: "text messages and automated or artificial-voice calls", number_masked: "(***) ***-0123", consent_language: "You agree that we may call or text this number using automated technology or an artificial voice", servicer_phone: "(800) 555-0100" };

// ------------------------------------------------------------------ 7.5 Reg P model forms
const PRIVACY_SOURCE = (kind: "initial" | "annual" | "revised") => `{{#block "facts" page=1 y=0.05 pt=14 bold}}FACTS — WHAT DOES {{upper partner_name}} DO WITH YOUR PERSONAL INFORMATION?{{/block}}
{{#block "why" page=1 y=0.12 pt=10}}Why? Financial companies choose how they share your personal information. Federal law gives consumers the right to limit some but not all sharing. Federal law also requires us to tell you how we collect, share, and protect your personal information. What? The types of personal information we collect and share depend on the product or service you have with us. This information can include: {{#each information_types}}{{this}}; {{/each}}How? All financial companies need to share customers' personal information to run their everyday business. In the section below, we list the reasons financial companies can share their customers' personal information; the reasons {{partner_name}} chooses to share; and whether you can limit this sharing.{{/block}}
{{#block "grid" page=1 y=0.35 pt=10}}For our everyday business purposes — such as to process your transactions, maintain your account(s), respond to court orders and legal investigations, or report to credit bureaus: Does {{partner_name}} share? Yes. Can you limit this sharing? No. For our marketing purposes — to offer our products and services to you: {{share_marketing}}; {{limit_marketing}}. For joint marketing with other financial companies: {{share_joint}}; {{limit_joint}}. For our affiliates' everyday business purposes — information about your transactions and experiences: {{share_affiliates_everyday}}; No. For our affiliates' everyday business purposes — information about your creditworthiness: {{share_affiliates_credit}}; {{limit_affiliates_credit}}. For our affiliates to market to you: {{share_affiliates_marketing}}; {{limit_affiliates_marketing}}. For nonaffiliates to market to you: {{share_nonaffiliates}}; {{limit_nonaffiliates}}.{{/block}}
${kind === "revised" ? `{{#block "optout" page=1 y=0.6 pt=10}}To limit our sharing: call {{optout_phone}} — our menu will prompt you through your choice(s) — or mail the enclosed form. Please note: if you are a new customer, we can begin sharing your information {{optout_days}} days from the date we sent this notice. When you are no longer our customer, we continue to share your information as described in this notice. However, you can contact us at any time to limit our sharing.{{/block}}` : ""}
{{#block "questions" page=1 y=0.7 pt=10}}Questions? Call {{partner_phone}} or go to {{partner_url}}.{{/block}}
{{#block "who" page=2 y=0.05 pt=10}}Who we are. Who is providing this notice? {{partner_name}}{{#if joint}}, together with Supermortgage, the company that services your loan on our behalf{{/if}}. What we do. How does {{partner_name}} protect my personal information? To protect your personal information from unauthorized access and use, we use security measures that comply with federal law. These measures include computer safeguards and secured files and buildings. How does {{partner_name}} collect my personal information? We collect your personal information, for example, when you {{#each collection_examples}}{{this}}; {{/each}}Why can't I limit all sharing? Federal law gives you the right to limit only sharing for affiliates' everyday business purposes — information about your creditworthiness; affiliates from using your information to market to you; and sharing for nonaffiliates to market to you. State laws and individual companies may give you additional rights to limit sharing. Definitions. Affiliates: companies related by common ownership or control. Nonaffiliates: companies not related by common ownership or control; {{partner_name}} does not share with nonaffiliates so they can market to you. Joint marketing: a formal agreement between nonaffiliated financial companies that together market financial products or services to you. Other important information: {{#each state_lines}}{{this}} {{/each}}Service providers: we share information with companies that service your loan on our behalf.{{/block}}`;
const PRIVACY_RULES = (kind: "initial" | "annual" | "revised"): ContentRule[] => [
  R("facts-title", "12 CFR 1016 App. A", "presence", "FACTS — WHAT DOES .* DO WITH YOUR PERSONAL INFORMATION\\?", "model form title with the institution name"),
  R("why-what-how", "App. A page 1", "presence", "Why\\? .* What\\? .* How\\? ", "Why/What/How boxes"),
  R("grid", "§1016.6(a)(2)–(5); App. A", "presence", "For our everyday business purposes .* Does .* share\\? Yes\\. Can you limit this sharing\\? No\\.", "sharing grid with the everyday-business row"),
  R("nonaffiliates-row", "§1016.6(a)(3)", "presence", "For nonaffiliates to market to you:", "nonaffiliate marketing row"),
  R("questions", "App. A", "presence", "Questions\\? Call", "contact"),
  R("who", "App. A page 2", "presence", "Who is providing this notice\\?", "who we are"),
  R("security", "§1016.6(a)(8)", "presence", "security measures that comply with federal law", "security statement"),
  R("former-customer", "§1016.6(a)(7)", kind === "revised" ? "presence" : "absence", "no longer our customer", kind === "revised" ? "former-customer statement" : "no opt-out block when sharing stays within the exceptions"),
  R("service-provider", "7.5 rule 1", "presence", "companies that service your loan on our behalf", "service-provider sharing disclosed generically"),
  R("no-optout-when-exceptions", "§1016.6(a)(6); 7.5 rule 7", "conditional", "share_nonaffiliates", "no opt-out block when not required", { when: { "==": [{ var: "sharing_profile" }, "exceptions_only"] }, predicate: { "==": [{ var: "share_nonaffiliates" }, "No"] } }),
  ...(kind === "revised" ? [R("optout-block", "§1016.8; §1016.7", "presence", "To limit our sharing: call", "opt-out mechanism"), R("optout-window", "§1016.8(a)(3) (reasonable opportunity; policy 30 days)", "data_range", "optout_days", "at least 30 days", { range: { min: 30 } })] : []),
  ...(kind === "annual" ? [R("basis", "§1016.9(c); 7.5 rule 6", "data_equality", "basis", "annual delivery basis recorded", { predicate: { in: [{ var: "basis" }, ["mail", "website_only", "portal_ack", "hello_insert"]] } })] : []),
];
const PRIVACY_SAMPLE = (kind: "initial" | "annual" | "revised") => ({ partner_name: "Partner Bank", partner_phone: "(800) 555-0177", partner_url: "partnerbank.example.com/privacy", joint: true, information_types: ["Social Security number and income", "account balances and payment history", "credit history and credit scores"], collection_examples: ["apply for a loan", "pay your bills", "give us your contact information"], share_marketing: "No", limit_marketing: "We don't share", share_joint: "No", limit_joint: "We don't share", share_affiliates_everyday: "Yes", share_affiliates_credit: "No", limit_affiliates_credit: "We don't share", share_affiliates_marketing: "No", limit_affiliates_marketing: "We don't share", share_nonaffiliates: kind === "revised" ? "Yes" : "No", limit_nonaffiliates: kind === "revised" ? "Yes" : "We don't share", sharing_profile: kind === "revised" ? "broader" : "exceptions_only", state_lines: [], optout_phone: "(800) 555-0188", optout_days: 30, basis: "mail" });
const OPTOUT_CONFIRM_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We received your privacy choices on {{date received_on}}: {{#each choices}}{{this}}; {{/each}}Your choices apply until you tell us otherwise and will be honored within 30 days. To change them, call {{optout_phone}}.{{/block}}`;
const OPTOUT_CONFIRM_RULES: ContentRule[] = [R("choices", "§1016.7", "presence", "received your privacy choices on", "choices confirmed"), R("honored", "§1016.7(e) (honored as soon as reasonably practicable)", "presence", "honored within 30 days", "timing"), R("dormant", "7.5: template dormant while sharing stays within the exceptions", "data_equality", "sharing_profile", "issued only under a broader sharing profile", { predicate: { "==": [{ var: "sharing_profile" }, "broader"] } })];
const OPTOUT_CONFIRM_SAMPLE = { received_on: "2027-07-10", choices: ["do not share my information with nonaffiliates to market to me"], optout_phone: "(800) 555-0188", sharing_profile: "broader" };
const CA_FIPA_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}IMPORTANT PRIVACY CHOICES FOR CONSUMERS{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}You have the right to control whether we share some of your personal information. Please read the following information carefully before you make your choices below. Your rights: you have the following rights to restrict the sharing of personal and financial information with our affiliates (companies we own or control) and outside companies that we do business with. Nothing in this form prohibits the sharing of information necessary for us to follow the law, as permitted by law, or to give you the best service on your accounts with us. Your choices: restrict information sharing with companies we own or control (affiliates) — unless you check this box, we may share personal and financial information about you with our affiliated companies [ ] NO, please do not share personal and financial information with your affiliated companies. Restrict information sharing with other companies we do business with to provide financial products and services — unless you check this box, we may share personal and financial information about you with outside companies we contract with to provide financial products and services to you [ ] NO, please do not share personal and financial information with outside companies you contract with to provide financial products and services. Time-sensitive reply: you may make your privacy choices at any time; your choices marked here will remain unless you state otherwise. Return this form to {{partner_name}}, {{return_address}}, or call {{optout_phone}}. Loan number ending {{account_last4}}.{{/block}}`;
const CA_FIPA_RULES: ContentRule[] = [R("title", "Cal. Fin. Code §4053(d) form", "presence", "IMPORTANT PRIVACY CHOICES FOR CONSUMERS", "statutory title"), R("opt-in-boxes", "Cal. Fin. Code §4053", "presence", "NO, please do not share personal and financial information with your affiliated companies", "affiliate choice box"), R("outside", "Cal. Fin. Code §4053", "presence", "outside companies you contract with", "nonaffiliate choice box"), R("no-ccpa", "Civ. Code §1798.145(e); 7.5-T7", "absence", "(CCPA|Consumer Privacy Act)", "the CCPA is not cited"), R("dormant", "7.5: sent only when the sharing profile requires it", "data_equality", "sharing_profile", "issued only under a broader sharing profile", { predicate: { "==": [{ var: "sharing_profile" }, "broader"] } })];
const CA_FIPA_SAMPLE = { partner_name: "Partner Bank", return_address: "PO Box 9, Sacramento CA 95814", optout_phone: "(800) 555-0188", account_last4: "1234", sharing_profile: "broader" };

// ------------------------------------------------------------------ 7.6 payoff statement family
const PAYOFF_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Payoff statement — good through {{date good_through}}{{/block}}
{{#block "parties" page=1 y=0.12 pt=10}}Requested by {{requester_name}} on behalf of {{borrower_names}}. Loan number {{loan_number_display}}. Property: {{property_address}}. Statement date {{date statement_date}}.{{/block}}
{{#block "total" page=1 y=0.2 pt=13 bold}}Total amount to pay your loan in full as of {{date good_through}}: {{money total_cents}}{{/block}}
{{#block "itemization" page=1 y=0.28 pt=10}}Itemization: unpaid principal balance {{money upb_cents}}; interest from {{date paid_through}} through {{date good_through}} at {{pct rate_pct}} ({{days}} days at {{money per_diem_cents}} per day, 365-day basis) {{money interest_cents}}; non-interest-bearing deferred balance {{money nib_cents}}; unpaid late charges {{money late_charges_cents}}; fees and advances payable by the borrower {{money fees_advances_cents}}; recording/release fee {{money recording_fee_cents}}; prepayment penalty: none; credits (unapplied funds) {{money credits_cents}}.{{/block}}
{{#block "escrow" page=1 y=0.45 pt=10}}Escrow: your escrow balance of {{money escrow_balance_cents}} is not deducted from the payoff and will be refunded within 20 business days after payoff. {{#if mi_proration_cents}}Borrower-paid mortgage insurance is prorated: {{money mi_proration_cents}}.{{/if}}{{/block}}
{{#block "perdiem" page=1 y=0.52 pt=10}}If funds are received after {{date good_through}}, add {{money per_diem_cents}} for each additional day. {{#if alternative_text}}{{alternative_text}}{{/if}}{{/block}}
{{#block "remit" page=1 y=0.6 pt=10}}Where and how to remit: wire to {{wire_bank}}, ABA {{wire_aba}}, account {{wire_account_masked}}, reference loan {{loan_number_display}}. Fraud warning: we will never change wire instructions by email; call {{servicer_phone}} to confirm before sending funds.{{/block}}
{{#block "updates" page=1 y=0.7 pt=10}}A written updated payoff statement will be provided on request. {{#if state_text}}{{state_text}}{{/if}}{{/block}}
${CONTACT}`;
const PAYOFF_RULES: ContentRule[] = [
  R("names", "7.6 rule 4", "presence", "Requested by .* on behalf of", "requester and borrower names"),
  R("loan-property", "7.6 rule 4", "presence", "Loan number .*\\. Property: ", "loan number and property"),
  R("good-through", "§1026.36(c)(3) (specified date)", "presence", "good through (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "good-through date"),
  R("total", "§1026.36(c)(3)", "presence", "Total amount to pay your loan in full as of .*: \\$[\\d,]+\\.\\d{2}", "total payoff"),
  R("itemization", "7.6 rule 4", "presence", "unpaid principal balance \\$[\\d,]+\\.\\d{2}; interest from .* through .* at \\d+\\.\\d{3}% \\(\\d+ days at \\$[\\d,]+\\.\\d{2} per day, 365-day basis\\)", "UPB, interest, per diem and basis"),
  R("nib", "A4-2.1-07", "presence", "non-interest-bearing deferred balance \\$", "NIB balance line"),
  R("fees", "7.6 rule 4", "presence", "unpaid late charges.*fees and advances payable by the borrower.*recording/release fee.*prepayment penalty: none.*credits", "late charges, fees/advances, recording fee, prepayment penalty, credits"),
  R("escrow", "§1024.34(b); 16.1 decision", "presence", "refunded within 20 business days after payoff", "escrow treatment"),
  R("per-diem", "7.6 rule 4", "presence", "add \\$[\\d,]+\\.\\d{2} for each additional day", "per-diem instruction"),
  R("remit", "7.6 rule 4", "presence", "Where and how to remit: wire to .* Fraud warning: we will never change wire instructions by email", "remittance instructions with the fraud warning"),
  R("updated", "7.6 rule 4", "presence", "written updated payoff statement will be provided on request", "updated statement on request"),
  R("fl-no-disclaimer", "Fla. Stat. §701.04", "conditional", "state", "no reservations or disclaimers in Florida", { when: { "==": [{ var: "state" }, "FL"] }, predicate: { "!": { matches: ["state_text", "(reserve the right|subject to change|disclaim)"] } } }),
  R("ca-2943", "Cal. Civ. Code §2943", "conditional", "state", "California statement elements and fee line", { when: { "==": [{ var: "state" }, "CA"] }, predicate: { matches: ["state_text", "Civil Code section 2943"] } }),
  R("within-7bd", "§1026.36(c)(3)", "data_range", "business_days_after_request", "sent within 7 business days of the written request", { range: { max: 7 } }),
  R("engine", "7.6 guardrail: figures only from the 16.1 engine", "data_equality", "calc_source", "figures from the 16.1 engine", { predicate: { "==": [{ var: "calc_source" }, "16.1"] } }),
  CONTACT_RULE,
];
const PAYOFF_SAMPLE = { good_through: "2026-11-20", requester_name: "Refi Lender Inc.", borrower_names: "Bea Borrower", loan_number_display: "****1234", property_address: "1 Test St, Testville TX 75001", statement_date: "2026-10-15", total_cents: 37234499n, upb_cents: 37104886n, paid_through: "2026-10-31", rate_pct: "6.375", days: 20, per_diem_cents: 6481n, interest_cents: 129613n, nib_cents: 0n, late_charges_cents: 0n, fees_advances_cents: 0n, recording_fee_cents: 0n, credits_cents: 0n, escrow_balance_cents: 183000n, mi_proration_cents: null, alternative_text: "If funds arrive before the November 1, 2026 payment is received, the unpaid principal balance is $371,602.55 with interest at 5.750% from October 1 through October 31, 2026 and 6.375% from November 1, 2026.", wire_bank: "Custodial Bank N.A.", wire_aba: "021000021", wire_account_masked: "****5678", state: "TX", state_text: null, business_days_after_request: 2, calc_source: "16.1", ...CONTACT_SAMPLE };
const PAYOFF_ACK_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We received your written payoff request on {{date received_on}}. Because {{reason_text}}, we cannot provide the payoff statement within seven business days; we expect to send it by {{date expected_on}}. Nothing else about your loan changes in the meantime.{{/block}}
${CONTACT}`;
const PAYOFF_ACK_RULES: ContentRule[] = [R("reason", "§1026.36(c)(3) (reasonable time); 7.6 rule 3", "presence", "Because .*, we cannot provide the payoff statement within seven business days", "reason stated"), R("expected", "7.6 rule 3", "presence", "expect to send it by", "expected date"), R("reason-category", "7.6 rule 3", "data_equality", "reason", "one of the permitted categories", { predicate: { in: [{ var: "reason" }, ["bankruptcy", "foreclosure", "disaster", "similar"]] } }), R("within-2bd", "SM_PAYOFF_DELAY_ACK_2BD", "data_range", "business_days_after_request", "acknowledged within 2 business days", { range: { max: 2 } }), CONTACT_RULE];
const PAYOFF_ACK_SAMPLE = { received_on: "2026-10-13", reason: "foreclosure", reason_text: "your loan is in foreclosure and the attorney's fees and costs must be obtained from the law firm", expected_on: "2026-10-27", business_days_after_request: 1, ...CONTACT_SAMPLE };
const PAYOFF_UPDATED_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Updated payoff statement — supersedes the statement dated {{date original_statement_date}}{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}Reason for the update: {{reason}} on {{date change_date}}. Updated total amount to pay your loan in full as of {{date good_through}}: {{money total_cents}} (previously {{money previous_total_cents}}). Per diem after {{date good_through}}: {{money per_diem_cents}}. The original statement is retained in our records and should not be relied on.{{/block}}
${CONTACT}`;
const PAYOFF_UPDATED_RULES: ContentRule[] = [R("supersedes", "7.6 rule 5", "presence", "supersedes the statement dated", "supersession"), R("reason", "7.6 rule 5", "presence", "Reason for the update:", "reason"), R("new-total", "comment 36(c)(3)-3 (accuracy)", "presence", "Updated total amount to pay your loan in full as of .*: \\$[\\d,]+\\.\\d{2} \\(previously \\$[\\d,]+\\.\\d{2}\\)", "new and previous totals"), CONTACT_RULE];
const PAYOFF_UPDATED_SAMPLE = { original_statement_date: "2026-10-15", reason: "an escrow tax disbursement was advanced", change_date: "2026-11-05", good_through: "2026-11-20", total_cents: 37646499n, previous_total_cents: 37234499n, per_diem_cents: 6481n, ...CONTACT_SAMPLE };
const PAYOFF_AUTH_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We received a payoff request on {{date received_on}} from {{requester_name}} ({{requester_type}}) for the loan of {{borrower_names}}. We cannot release the payoff statement to a third party without the borrower's authorization. Please provide {{authorization_needed}} by {{date respond_by}}. If we do not receive it, the statement will be sent to the borrower of record by {{date federal_due}}, and the borrower may share it with you.{{/block}}
${CONTACT}`;
const PAYOFF_AUTH_RULES: ContentRule[] = [R("third-party", "7.6 rule 2; §1016.14", "presence", "cannot release the payoff statement to a third party without the borrower's authorization", "authorization required"), R("what", "7.6 rule 2", "presence", "Please provide .* by", "authorization requested with a date"), R("fallback", "7.6 rule 2 (clock not tolled)", "presence", "sent to the borrower of record by", "borrower-of-record fallback"), R("same-day", "7.6 rule 2 (request the same day)", "data_range", "days_after_request", "sent the same day", { range: { max: 0 } }), CONTACT_RULE];
const PAYOFF_AUTH_SAMPLE = { received_on: "2026-10-13", requester_name: "Title Co. LLC", requester_type: "title/escrow company", borrower_names: "Bea Borrower", authorization_needed: "a borrower-signed authorization or the escrow instructions naming you", respond_by: "2026-10-20", federal_due: "2026-10-22", days_after_request: 0, ...CONTACT_SAMPLE };

export const SECTION_07_VERSIONS: readonly VersionInput[] = [
  V("NTC_FNMA_D2_2_03_PAYMENT_REMINDER", REMINDER_SOURCE, REMINDER_RULES, REMINDER_SAMPLE, "fnma.d2_2_03.2025-08", "D2-2-03 (SVC-2025-05)"),
  V("NTC_IRS_1098", F1098_SOURCE(false), F1098_RULES(false), F1098_SAMPLE, "irs.1098.2026", "7.1-T13 worked example"),
  V("NTC_IRS_1098_CORRECTED", F1098_SOURCE(true), F1098_RULES(true), F1098_SAMPLE, "irs.1098.2026", "Form 1098 instructions (corrected)"),
  V("NTC_REGZ_41E3IV_COUPON_DELQ_NOTICE", COUPON_DELQ_SOURCE, COUPON_DELQ_RULES, COUPON_DELQ_SAMPLE, "regz.periodic_statement.2018", "§1026.41(e)(3)(iv); (d)(8)"),
  V("NTC_REGZ_41E6_CHARGEOFF_SUSPENSION", CHARGEOFF_SOURCE, CHARGEOFF_RULES, CHARGEOFF_SAMPLE, "regz.periodic_statement.2018", "§1026.41(e)(6)"),
  V("NTC_REGZ_41_STMT_AVAIL_EMAIL", AVAIL_SOURCE, AVAIL_RULES, AVAIL_SAMPLE, "regz.periodic_statement.2018", "comment 41(c)-3"),
  V("NTC_REGZ_41_STMT_BK12_13", BK13_SOURCE, BK_RULES(true), BK_SAMPLE, "regz.periodic_statement.2018", "H-30(F)"),
  V("NTC_REGZ_41_STMT_BK7_11", BK7_SOURCE, BK_RULES(false), BK_SAMPLE, "regz.periodic_statement.2018", "H-30(E)"),
  V("NTC_REGZ_41_STMT_TPP", TPP_SOURCE, TPP_RULES, TPP_SAMPLE, "regz.periodic_statement.2018", "comments 41(d)(1)-2, 41(d)(2)-2, 41(d)-4"),
  V("NTC_REGZ_20C_ARM_ADJ", ARM_C_SOURCE, ARM_C_RULES, ARM_C_SAMPLE, "regz.arm_notices.2013", "H-4(D)(2); 7.2 worked example"),
  V("NTC_FNMA_C2_1_02_RATE_CHANGE", RATE_CHANGE_SOURCE, RATE_CHANGE_RULES, RATE_CHANGE_SAMPLE, "fnma.c2_1_02.2025-08", "C-2.1-02"),
  V("NTC_FNMA_C2_1_02_BUYDOWN_STEP_90", BUYDOWN_SOURCE, BUYDOWN_RULES, BUYDOWN_SAMPLE, "fnma.c2_1_02.2025-08", "C-2.1-02 temporary buydowns"),
  V("NTC_FNMA_C2_2_01_ARM_CORRECTION", CORRECTION_SOURCE, CORRECTION_RULES, CORRECTION_SAMPLE, "fnma.c2_2_01.2014-11", "C-2.2-01 / C-2.2-03"),
  V("NTC_ARM_INQUIRY_INTERIM_20", INTERIM_SOURCE, INTERIM_RULES, INTERIM_SAMPLE, "fnma.c2_2_01.2014-11", "C-2.2-01 interim response"),
  V("NTC_ESIGN_7001C_DISCLOSURE", ESIGN_DISCLOSURE_SOURCE, ESIGN_DISCLOSURE_RULES, ESIGN_DISCLOSURE_SAMPLE, "esign.7001c.v1", "15 U.S.C. 7001(c)(1)(B)–(C)"),
  V("NTC_ESIGN_CONSENT_CONFIRMATION", ESIGN_CONFIRM_SOURCE, ESIGN_CONFIRM_RULES, ESIGN_CONFIRM_SAMPLE, "esign.7001c.v1", "7.4 rule 2"),
  V("NTC_ESIGN_HWSW_CHANGE_RECONSENT", HWSW_SOURCE, HWSW_RULES, HWSW_SAMPLE, "esign.7001c.v1", "15 U.S.C. 7001(c)(1)(D)"),
  V("NTC_ESIGN_VERIFICATION_EMAIL", VERIFY_SOURCE, VERIFY_RULES, VERIFY_SAMPLE, "esign.7001c.v1", "7.4 rule 2 demonstration"),
  V("NTC_ESIGN_WITHDRAWAL_CONFIRMATION", WITHDRAW_SOURCE, WITHDRAW_RULES, WITHDRAW_SAMPLE, "esign.7001c.v1", "7.4 rule 7"),
  V("NTC_EDELIVERY_BOUNCE_PAPER_RESUME", BOUNCE_SOURCE, BOUNCE_RULES, BOUNCE_SAMPLE, "esign.7001c.v1", "7.4 rule 8"),
  V("NTC_IRS_ESTATEMENT_CONSENT_DISCLOSURE", IRS_ECONSENT_SOURCE, IRS_ECONSENT_RULES, IRS_ECONSENT_SAMPLE, "irs.1098.2026", "Treas. Reg. §1.6050H-2(a)(4)"),
  V("NTC_TCPA_CONSENT_CONFIRMATION", TCPA_SOURCE, TCPA_RULES, TCPA_SAMPLE, "tcpa.consent.v1", "7.4 rule 12"),
  V("NTC_REGP_1016_4_INITIAL", PRIVACY_SOURCE("initial"), PRIVACY_RULES("initial"), PRIVACY_SAMPLE("initial"), "regp.model_form.2009", "12 CFR 1016 Appendix A"),
  V("NTC_REGP_1016_5_ANNUAL", PRIVACY_SOURCE("annual"), PRIVACY_RULES("annual"), PRIVACY_SAMPLE("annual"), "regp.model_form.2009", "12 CFR 1016 Appendix A (annual)"),
  V("NTC_REGP_1016_8_REVISED", PRIVACY_SOURCE("revised"), PRIVACY_RULES("revised"), PRIVACY_SAMPLE("revised"), "regp.model_form.2009", "12 CFR 1016 Appendix A (with opt-out)"),
  V("NTC_REGP_OPT_OUT_CONFIRMATION", OPTOUT_CONFIRM_SOURCE, OPTOUT_CONFIRM_RULES, OPTOUT_CONFIRM_SAMPLE, "regp.model_form.2009", "§1016.7 (dormant)"),
  V("NTC_STATE_CA_FIPA", CA_FIPA_SOURCE, CA_FIPA_RULES, CA_FIPA_SAMPLE, "ca.fipa.4053", "Cal. Fin. Code §4053 form (dormant)"),
  V("NTC_REGZ_36C3_PAYOFF_STMT", PAYOFF_SOURCE, PAYOFF_RULES, PAYOFF_SAMPLE, "regz.payoff.2014", "7.6 worked example"),
  V("NTC_PAYOFF_REQUEST_ACK_DELAY", PAYOFF_ACK_SOURCE, PAYOFF_ACK_RULES, PAYOFF_ACK_SAMPLE, "regz.payoff.2014", "7.6 rule 3"),
  V("NTC_PAYOFF_UPDATED_STMT", PAYOFF_UPDATED_SOURCE, PAYOFF_UPDATED_RULES, PAYOFF_UPDATED_SAMPLE, "regz.payoff.2014", "7.6 rule 5"),
  V("NTC_PAYOFF_AUTHORIZATION_REQUEST", PAYOFF_AUTH_SOURCE, PAYOFF_AUTH_RULES, PAYOFF_AUTH_SAMPLE, "regz.payoff.2014", "7.6 rule 2"),
];
