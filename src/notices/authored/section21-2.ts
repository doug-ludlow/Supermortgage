/**
 * §21.2 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * NTC_REGZ_1026_37_LE — the Loan Estimate, form H-24 (§1026.37(o)(3)(i)): every §1026.37 element the spec names —
 *   (a)(13) rate lock statement with the expiration date/time and time zone (blank once intent arrives inside the
 *   period, comment 37(a)(13)-4), (b) loan terms, (c) projected payments, (f)/(g) loan and other costs by section
 *   with lender credits, (h) cash to close, (k) lender and loan officer NMLSR IDs (§1026.36(g)), (l) comparisons
 *   (In 5 Years, APR, TIP), (m) other considerations incl. the (m)(6) servicing statement, (n) confirm receipt.
 * NTC_REGZ_1026_19E1VI_PROVIDER_LIST — the written list of settlement service providers (§1026.19(e)(1)(vi)(C)):
 *   at least one available provider per shoppable service, affiliates flagged, delivered with the LE.
 * NTC_REGZ_1026_19E2II_PRELE_ESTIMATE — the §1026.19(e)(2)(ii) wrapper for any consumer-specific written estimate
 *   issued before the LE (retired name per the verification report item 13: 20.4's NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER
 *   is canonical; this version carries the identical statement so 21.1/21.2 screens rendered through it comply).
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });

// ------------------------------------------------------------------ NTC_REGZ_1026_37_LE (form H-24)
export const LE_H24_SOURCE = `{{#block "heading" page=1 y=0.03 pt=18 bold}}Loan Estimate{{/block}}
{{#block "save" page=1 y=0.06 pt=10}}Save this Loan Estimate to compare with your Closing Disclosure.{{/block}}
{{#block "ref" page=1 y=0.09 pt=10}}DATE ISSUED {{date date_issued}}. APPLICANTS {{applicants}}. PROPERTY {{property_address}}. EST. PROP. VALUE {{money estimated_value_cents}}. LOAN TERM {{loan_term_years}} years. PURPOSE {{purpose}}. PRODUCT {{product}}. LOAN TYPE {{loan_type}}. LOAN ID # {{loan_id}}.{{/block}}
{{#block "rate_lock" page=1 y=0.16 pt=10}}RATE LOCK {{#if rate_locked}}YES, until {{lock_expires}}{{else}}NO{{/if}}. Before closing, your interest rate, points, and lender credits can change unless you lock the interest rate. {{#if costs_expire_display}}All other estimated closing costs expire on {{costs_expire_display}}.{{/if}}{{/block}}
{{#block "loan_terms" page=1 y=0.22 pt=10}}Loan Terms. Loan Amount {{money loan_amount_cents}}. Interest Rate {{interest_rate_pct}}%. Monthly Principal & Interest {{money pi_cents}} (see Projected Payments below for your Estimated Total Monthly Payment). Prepayment Penalty {{#if prepayment_penalty}}YES{{else}}NO{{/if}}. Balloon Payment {{#if balloon_payment}}YES{{else}}NO{{/if}}.{{/block}}
{{#block "projected_payments" page=1 y=0.42 pt=10}}Projected Payments. Years 1-{{loan_term_years}}: Principal & Interest {{money pi_cents}}; Mortgage Insurance {{money mi_monthly_cents}}; Estimated Escrow {{money escrow_monthly_cents}}; Estimated Total Monthly Payment {{money total_monthly_payment_cents}}. Estimated Taxes, Insurance & Assessments {{money taxes_insurance_monthly_cents}} a month ({{#if escrowed}}in escrow{{else}}not in escrow{{/if}}).{{/block}}
{{#block "costs_at_closing" page=1 y=0.78 pt=10}}Costs at Closing. Estimated Closing Costs {{money total_closing_costs_cents}} — includes {{money loan_costs_cents}} in Loan Costs + {{money other_costs_cents}} in Other Costs – {{money lender_credits_abs_cents}} in Lender Credits. See page 2 for details. Estimated Cash to Close {{money cash_to_close_cents}} — includes Closing Costs. See Calculating Cash to Close on page 2 for details.{{/block}}
{{#block "loan_costs" page=2 y=0.05 pt=10}}Loan Costs. A. Origination Charges {{money total_a_cents}} {{#each section_a}}{{this}}; {{/each}}B. Services You Cannot Shop For {{money total_b_cents}} {{#each section_b}}{{this}}; {{/each}}C. Services You Can Shop For {{money total_c_cents}} {{#each section_c}}{{this}}; {{/each}}D. TOTAL LOAN COSTS (A + B + C) {{money loan_costs_cents}}.{{/block}}
{{#block "other_costs" page=2 y=0.45 pt=10}}Other Costs. E. Taxes and Other Government Fees {{money total_e_cents}} {{#each section_e}}{{this}}; {{/each}}F. Prepaids {{money total_f_cents}} {{#each section_f}}{{this}}; {{/each}}G. Initial Escrow Payment at Closing {{money total_g_cents}} {{#each section_g}}{{this}}; {{/each}}H. Other {{money total_h_cents}} {{#each section_h}}{{this}}; {{/each}}I. TOTAL OTHER COSTS (E + F + G + H) {{money other_costs_cents}}. J. TOTAL CLOSING COSTS {{money total_closing_costs_cents}}: D + I {{money d_plus_i_cents}}; Lender Credits {{money lender_credits_cents}}.{{/block}}
{{#block "cash_to_close" page=2 y=0.82 pt=10}}Calculating Cash to Close. Total Closing Costs (J) {{money total_closing_costs_cents}}. Closing Costs Financed (Paid from your Loan Amount) {{money closing_costs_financed_cents}}. Down Payment/Funds from Borrower {{money down_payment_cents}}. Deposit {{money deposit_cents}}. Funds for Borrower {{money funds_for_borrower_cents}}. Seller Credits {{money seller_credits_cents}}. Adjustments and Other Credits {{money adjustments_cents}}. Estimated Cash to Close {{money cash_to_close_cents}}.{{/block}}
{{#block "contact" page=3 y=0.05 pt=10}}Additional Information About This Loan. LENDER {{lender_name}} NMLS/LICENSE ID {{lender_nmlsr_id}}. LOAN OFFICER {{loan_officer_name}} NMLS/LICENSE ID {{loan_officer_nmlsr_id}}. EMAIL {{lender_email}}. PHONE {{lender_phone}}.{{/block}}
{{#block "comparisons" page=3 y=0.18 pt=10}}Comparisons. Use these measures to compare this loan with other loans. In 5 Years: {{money in_5y_total_cents}} Total you will have paid in principal, interest, mortgage insurance, and loan costs. {{money in_5y_principal_cents}} Principal you will have paid off. Annual Percentage Rate (APR) {{apr_pct}}% Your costs over the loan term expressed as a rate. This is not your interest rate. Total Interest Percentage (TIP) {{tip_pct}}% The total amount of interest that you will pay over the loan term as a percentage of your loan amount.{{/block}}
{{#block "other_considerations" page=3 y=0.42 pt=10}}Other Considerations. Appraisal: We may order an appraisal to determine the property's value and charge you for this appraisal. We will promptly give you a copy of any appraisal, even if your loan does not close. You can pay for an additional appraisal for your own use at your own cost. Assumption: If you sell or transfer this property to another person, we will not allow assumption of this loan on the original terms. Homeowner's Insurance: This loan requires homeowner's insurance on the property, which you may obtain from a company of your choice that we find acceptable. Late Payment: {{late_payment_statement}} Refinance: Refinancing this loan will depend on your future financial situation, the property value, and market conditions. You may not be able to refinance this loan. Servicing: We intend [X] to service your loan. If so, you will make your payments to us. [ ] to transfer servicing of your loan.{{#if refinance_transaction}} Liability after Foreclosure: Taking this loan could end any state law protection you may currently have against liability for unpaid debt if your lender forecloses on your home. If you lose this protection, you may have to pay any debt remaining even after foreclosure. You may want to consult a lawyer for more information.{{/if}}{{/block}}
{{#block "confirm_receipt" page=3 y=0.85 pt=10}}Confirm Receipt. By signing, you are only confirming that you have received this form. You do not have to accept this loan because you have signed or received this form. Applicant Signature / Date. Co-Applicant Signature / Date.{{/block}}`;

const LE_RULES: ContentRule[] = [
  R("h24-heading", "12 CFR 1026.37(o)(3)(i): form H-24", "layout", "heading", "the form is titled Loan Estimate at the top of page 1", { layout: { page: 1, maxYFraction: 0.05, bold: true } }),
  R("date-issued", "12 CFR 1026.37(a)(4)", "presence", "DATE ISSUED (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "date the disclosure is issued"),
  R("applicants-property", "12 CFR 1026.37(a)(5)–(6)", "presence", "APPLICANTS .+ PROPERTY .+ EST\\. PROP\\. VALUE \\$[\\d,]+\\.\\d{2}", "applicants, property and estimated value"),
  R("loan-id", "12 CFR 1026.37(a)(12)", "presence", "LOAN ID # \\S+", "loan identification number"),
  R("rate-lock", "12 CFR 1026.37(a)(13)", "presence", "RATE LOCK (YES, until .+ [A-Z]{2,4}T?|NO)\\.", "rate lock statement (with date, time and time zone when locked)"),
  R("rate-lock-statement", "12 CFR 1026.37(a)(13)(ii)", "presence", "interest rate, points, and lender credits can change unless you lock the interest rate", "(a)(13)(ii) accompanying statement"),
  R("costs-expire-or-intent", "12 CFR 1026.37(a)(13)(ii); comment 37(a)(13)-4", "conditional", "costs_expire_display", "estimated closing costs expiration date and time (with time zone) unless intent to proceed was received within the period", { when: { "!": { var: "intent_received_in_period" } }, predicate: { matches: ["costs_expire_display", "^\\d{1,2}/\\d{1,2}/\\d{4} at \\d{1,2}:\\d{2} [ap]\\.m\\. [A-Z]{2,5}$"] } }),
  R("costs-expire-blank-after-intent", "comment 37(a)(13)-4: once the consumer indicates an intent to proceed within the time specified, the date and time at which estimated closing costs expire are left blank", "conditional", "costs_expire_display", "expiration blank after intent", { when: { var: "intent_received_in_period" }, predicate: { "!": { present: "costs_expire_display" } } }),
  R("loan-terms", "12 CFR 1026.37(b)", "presence", "Loan Amount \\$[\\d,]+\\.\\d{2}\\. Interest Rate \\d+\\.\\d{3}%\\. Monthly Principal & Interest \\$[\\d,]+\\.\\d{2}", "loan amount, interest rate, monthly P&I"),
  R("prepay-balloon", "12 CFR 1026.37(b)(7)", "presence", "Prepayment Penalty (YES|NO)\\. Balloon Payment (YES|NO)\\.", "prepayment penalty and balloon statements"),
  R("projected-payments", "12 CFR 1026.37(c)", "presence", "Projected Payments\\. .* Estimated Total Monthly Payment \\$[\\d,]+\\.\\d{2}", "projected payments table"),
  R("costs-at-closing", "12 CFR 1026.37(d)", "presence", "Estimated Closing Costs \\$[\\d,]+\\.\\d{2} .* Estimated Cash to Close \\$[\\d,]+\\.\\d{2}", "costs at closing"),
  R("loan-costs-sections", "12 CFR 1026.37(f)", "presence", "A\\. Origination Charges .* B\\. Services You Cannot Shop For .* C\\. Services You Can Shop For .* D\\. TOTAL LOAN COSTS", "loan costs sections A–D"),
  R("other-costs-sections", "12 CFR 1026.37(g)", "presence", "E\\. Taxes and Other Government Fees .* F\\. Prepaids .* G\\. Initial Escrow Payment at Closing .* H\\. Other .* I\\. TOTAL OTHER COSTS .* J\\. TOTAL CLOSING COSTS", "other costs sections E–J"),
  R("lender-credits-line", "12 CFR 1026.37(g)(6)(ii)", "presence", "Lender Credits -?\\$[\\d,]+\\.\\d{2}", "lender credits line"),
  R("lender-credit-nonpositive", "12 CFR 1026.19(e)(3)(i); 21.2 rule 6: a lender credit may not decrease", "data_equality", "lender_credits_cents", "lender credits are zero or a credit", { predicate: { "<=": [{ var: "lender_credits_cents" }, 0] } }),
  R("loan-costs-sum", "12 CFR 1026.37(f)(5): D = A + B + C", "data_equality", "loan_costs_cents", "D equals A + B + C", { predicate: { "==": [{ var: "loan_costs_cents" }, { var: "sum_abc_cents" }] } }),
  R("cash-to-close", "12 CFR 1026.37(h)", "presence", "Calculating Cash to Close\\. .* Estimated Cash to Close \\$[\\d,]+\\.\\d{2}", "calculating cash to close table"),
  R("lender-nmlsr", "12 CFR 1026.37(k)(1); 1026.36(g)", "presence", "LENDER .+ NMLS/LICENSE ID \\d+\\.", "creditor name and NMLSR ID"),
  R("loan-officer-nmlsr", "12 CFR 1026.37(k)(2); 1026.36(g)", "presence", "LOAN OFFICER .+ NMLS/LICENSE ID \\d+\\.", "loan officer name and NMLSR ID"),
  R("loan-officer-nmlsr-data", "12 CFR 1026.36(g); 21.2 guardrail: never issue an LE without the MLO's NMLSR ID", "data_equality", "loan_officer_nmlsr_id", "MLO of record NMLSR ID present", { predicate: { matches: ["loan_officer_nmlsr_id", "^\\d{3,}$"] } }),
  R("in-5-years", "12 CFR 1026.37(l)(1)", "presence", "In 5 Years: \\$[\\d,]+\\.\\d{2} Total you will have paid in principal, interest, mortgage insurance, and loan costs\\. \\$[\\d,]+\\.\\d{2} Principal you will have paid off", "In 5 Years comparison"),
  R("apr", "12 CFR 1026.37(l)(2)", "presence", "Annual Percentage Rate \\(APR\\) \\d+\\.\\d{3}%", "APR expressed as a percentage to three decimals"),
  R("tip", "12 CFR 1026.37(l)(3)", "presence", "Total Interest Percentage \\(TIP\\) \\d+\\.\\d{3}%", "TIP to three decimals"),
  R("appraisal-statement", "12 CFR 1026.37(m)(1)", "presence", "We may order an appraisal to determine the property's value and charge you for this appraisal\\. We will promptly give you a copy of any appraisal, even if your loan does not close", "appraisal statement"),
  R("late-payment", "12 CFR 1026.37(m)(4)", "presence", "Late Payment: .* (\\$[\\d,]+\\.\\d{2}|\\d+(\\.\\d+)?%)", "late payment charge as a dollar amount or percentage"),
  R("refinance-statement", "12 CFR 1026.37(m)(5)", "presence", "Refinancing this loan will depend on your future financial situation, the property value, and market conditions\\. You may not be able to refinance this loan\\.", "refinance statement"),
  R("servicing-statement", "12 CFR 1026.37(m)(6)", "presence", "We intend \\[X\\] to service your loan\\. If so, you will make your payments to us\\.", "servicing statement — partner services (SM subservices from day one)"),
  R("servicing-intent-service", "21.2 rule 7 / guardrail: never alter the servicing statement from `service`", "data_equality", "servicing_intent", "servicing_intent = service", { predicate: { "==": [{ var: "servicing_intent" }, "service"] } }),
  R("deficiency-statement", "12 CFR 1026.37(m)(7): refinance only", "conditional", "refinance_transaction", "liability-after-foreclosure statement on a refinance", { when: { var: "refinance_transaction" }, predicate: { "==": [{ var: "refinance_transaction" }, true] } }),
  R("confirm-receipt", "12 CFR 1026.37(n)", "presence", "By signing, you are only confirming that you have received this form\\. You do not have to accept this loan because you have signed or received this form\\.", "confirm receipt statement"),
  R("no-collection", "12 CFR 1026.19(e)(2)(i)(A); 21.2 guardrail: never impose or collect any fee", "absence", "(pay now|payment due today|charge your card)", "no fee demand on the estimate"),
];
const LE_SAMPLE = { date_issued: "2026-10-05", applicants: "Alex Borrower", property_address: "4210 E Camelback Rd, Phoenix, AZ 85018", estimated_value_cents: 82_000_000n, loan_term_years: 30, purpose: "Refinance", product: "Fixed Rate", loan_type: "Conventional", loan_id: "APP-21-2-FIX",
  rate_locked: false, lock_expires: "", costs_expire_display: "10/20/2026 at 5:00 p.m. MST", intent_received_in_period: false,
  loan_amount_cents: 56_000_000n, interest_rate_pct: "6.125", pi_cents: 340_262n, prepayment_penalty: false, balloon_payment: false, mi_monthly_cents: 0n, escrow_monthly_cents: 55_000n, total_monthly_payment_cents: 395_262n, taxes_insurance_monthly_cents: 55_000n, escrowed: true,
  total_closing_costs_cents: 350_543n, loan_costs_cents: 261_700n, other_costs_cents: 350_543n, lender_credits_cents: -261_700n, lender_credits_abs_cents: 261_700n, sum_abc_cents: 261_700n, d_plus_i_cents: 612_243n, cash_to_close_cents: 350_543n,
  total_a_cents: 0n, total_b_cents: 82_200n, total_c_cents: 179_500n, total_e_cents: 7_000n, total_f_cents: 178_543n, total_g_cents: 165_000n, total_h_cents: 0n,
  section_a: [] as string[], section_b: ["Appraisal Fee to AMC $650.00", "Credit Report Fee $75.00", "Flood Determination Fee $12.00", "Tax Service Fee $85.00"], section_c: ["Title – Lender's Title Policy $1,150.00", "Title – Settlement Agent Fee $495.00", "Title – Endorsements $150.00"], section_e: ["Recording Fees $70.00", "Transfer Taxes $0.00"], section_f: ["Prepaid Interest ($93.97 per day for 19 days @ 6.125%) $1,785.43", "Homeowner's Insurance Premium $0.00", "Property Taxes $0.00"], section_g: ["Property Taxes $400.00 per month for 3 mo. $1,200.00", "Homeowner's Insurance $150.00 per month for 3 mo. $450.00"], section_h: [] as string[],
  closing_costs_financed_cents: 0n, down_payment_cents: 0n, deposit_cents: 0n, funds_for_borrower_cents: 0n, seller_credits_cents: 0n, adjustments_cents: 0n,
  lender_name: "Partner Bank, N.A.", lender_nmlsr_id: "123456", loan_officer_name: "Jordan Rivera", loan_officer_nmlsr_id: "987654", lender_email: "loans@partnerbank.example", lender_phone: "(800) 555-0155",
  in_5y_total_cents: 20_677_420n, in_5y_principal_cents: 3_809_713n, apr_pct: "6.125", tip_pct: "118.740", servicing_intent: "service", refinance_transaction: true,
  late_payment_statement: "If your payment is more than 15 days late, we will charge a late fee of 5% of the monthly principal and interest payment." };

// ------------------------------------------------------------------ NTC_REGZ_1026_19E1VI_PROVIDER_LIST
export const PROVIDER_LIST_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}Written List of Settlement Service Providers{{/block}}
{{#block "intro" page=1 y=0.1 pt=11}}Loan Estimate dated {{date date_issued}} for {{applicants}}, property {{property_address}}. Your Loan Estimate lists services you can shop for (section C). You may choose any provider for these services, including one not on this list, subject to our reasonable requirements. For each service we identify at least one provider that is available to you. Providers marked "affiliate" are affiliated with the lender.{{/block}}
{{#block "services" page=1 y=0.3 pt=11}}{{#each services}}Service: {{service}} — {{#each providers}}{{name}} ({{#if affiliate}}affiliate{{else}}not affiliated{{/if}}; estimated fee {{money estimated_fee_cents}}); {{/each}}{{/each}}{{/block}}
{{#block "footer" page=1 y=0.85 pt=11}}This list is provided with your Loan Estimate ({{le_reference}}) and is not a Loan Estimate. Questions: {{lender_name}}, {{lender_phone}}.{{/block}}`;
const PROVIDER_LIST_RULES: ContentRule[] = [
  R("heading", "12 CFR 1026.19(e)(1)(vi)(C)", "presence", "Written List of Settlement Service Providers", "titled written list"),
  R("shop-statement", "12 CFR 1026.19(e)(1)(vi)(A): consumer may select the provider subject to reasonable requirements", "presence", "You may choose any provider for these services, including one not on this list", "shopping statement"),
  R("at-least-one-provider", "12 CFR 1026.19(e)(1)(vi)(C): at least one available provider for each service", "data_range", "min_providers_per_service", "≥1 provider per shoppable service", { range: { min: 1 } }),
  R("services-listed", "12 CFR 1026.19(e)(1)(vi)(C)", "data_range", "services.length", "every section-C service appears", { range: { min: 1 } }),
  R("affiliate-flag", "12 CFR 1024.15; 21.3 AfBA: affiliates flagged", "presence", "\\((affiliate|not affiliated); estimated fee \\$[\\d,]+\\.\\d{2}\\)", "affiliate flag and estimated fee per provider"),
  R("with-le", "21.2 data model: delivered_with_le", "data_equality", "delivered_with_le", "delivered with the Loan Estimate", { predicate: { "==": [{ var: "delivered_with_le" }, true] } }),
  R("not-an-le", "12 CFR 1026.19(e)(2)(ii)", "presence", "is not a Loan Estimate", "not a Loan Estimate statement"),
];
const PROVIDER_LIST_SAMPLE = { date_issued: "2026-10-05", applicants: "Alex Borrower", property_address: "4210 E Camelback Rd, Phoenix, AZ 85018", le_reference: "LE v1 / APP-21-2-FIX",
  services: [{ service: "Title – Lender's Title Policy", providers: [{ name: "Grand Canyon Title Agency", affiliate: false, estimated_fee_cents: 115_000n }] }, { service: "Title – Settlement Agent Fee", providers: [{ name: "Grand Canyon Title Agency", affiliate: false, estimated_fee_cents: 49_500n }] }, { service: "Title – Endorsements", providers: [{ name: "Grand Canyon Title Agency", affiliate: false, estimated_fee_cents: 15_000n }] }],
  min_providers_per_service: 1, delivered_with_le: true, lender_name: "Partner Bank, N.A.", lender_phone: "(800) 555-0155" };

// ------------------------------------------------------------------ NTC_REGZ_1026_19E2II_PRELE_ESTIMATE
export const PRELE_ESTIMATE_STATEMENT = "Your actual rate, payment, and costs could be higher. Get an official Loan Estimate before choosing a loan.";
export const PRELE_ESTIMATE_SOURCE = `{{#block "disclaimer" page=1 y=0.02 pt=12 bold}}${PRELE_ESTIMATE_STATEMENT}{{/block}}
{{#block "heading" page=1 y=0.08 pt=14 bold}}Written Estimate of Terms and Costs{{/block}}
{{#block "body" page=1 y=0.14 pt=11}}Prepared {{date prepared_on}} for {{applicants}} by {{lender_name}} (NMLS ID {{lender_nmlsr_id}}) from pricing scenario {{quote_id}}. Loan amount {{money loan_amount_cents}}; interest rate {{interest_rate_pct}}%; estimated monthly principal & interest {{money pi_cents}}; estimated closing costs {{money estimated_closing_costs_cents}}. This is not a Loan Estimate and is not a commitment to lend. No fee other than a bona fide and reasonable credit report fee may be imposed before you receive a Loan Estimate and indicate an intent to proceed.{{/block}}`;
const PRELE_RULES: ContentRule[] = [
  R("statement-text", "12 CFR 1026.19(e)(2)(ii)", "presence", "Your actual rate, payment, and costs could be higher\\. Get an official Loan Estimate before choosing a loan\\.", "the (e)(2)(ii) statement verbatim"),
  R("statement-top-12pt", "12 CFR 1026.19(e)(2)(ii): at the top of the front of the first page in a font size no smaller than 12-point", "layout", "disclaimer", "statement at the top of page 1 in ≥ 12-point type", { layout: { page: 1, maxYFraction: 0.05, minPt: 12 } }),
  R("not-an-le", "12 CFR 1026.19(e)(2)(ii)", "presence", "This is not a Loan Estimate", "not a Loan Estimate"),
  R("no-fee", "12 CFR 1026.19(e)(2)(i)(A)", "presence", "No fee other than a bona fide and reasonable credit report fee may be imposed", "fee restriction statement"),
  R("no-verification-docs", "12 CFR 1026.19(e)(2)(iii)", "absence", "(must (submit|provide) (verifying|verification) documents|pay stubs? required before)", "no verification documents demanded"),
  R("scenario-ref", "21.2 integrations: idempotent by quote_id", "data_equality", "quote_id", "pricing scenario referenced", { predicate: { present: "quote_id" } }),
];
const PRELE_SAMPLE = { prepared_on: "2026-10-05", applicants: "Alex Borrower", lender_name: "Partner Bank, N.A.", lender_nmlsr_id: "123456", quote_id: "Q-20-4-0001", loan_amount_cents: 56_000_000n, interest_rate_pct: "6.125", pi_cents: 340_262n, estimated_closing_costs_cents: 350_543n };

export const VERSIONS_21_2: VersionInput[] = [
  V("NTC_REGZ_1026_37_LE", LE_H24_SOURCE, LE_RULES, LE_SAMPLE, "regz.trid.2017", "12 CFR 1026.37; form H-24 (2017); 21.2 worked example 1 (refinance fixture)"),
  V("NTC_REGZ_1026_19E1VI_PROVIDER_LIST", PROVIDER_LIST_SOURCE, PROVIDER_LIST_RULES, PROVIDER_LIST_SAMPLE, "regz.trid.2017", "12 CFR 1026.19(e)(1)(vi)(C); 21.2 refinance fixture section C providers"),
  V("NTC_REGZ_1026_19E2II_PRELE_ESTIMATE", PRELE_ESTIMATE_SOURCE, PRELE_RULES, PRELE_SAMPLE, "regz.trid.2017", "12 CFR 1026.19(e)(2)(ii); 20.4 written quote of Oct 5, 2026 10:45 (21.2-T11)"),
];
export const OVERRIDES_21_2: Record<string, Partial<NoticeTemplate>> = {
  NTC_REGZ_1026_37_LE: { channelPolicy: "esign_or_mail", noticeClass: "disclosures", separateDocument: true, mayCombineWith: ["NTC_REGZ_1026_19E1VI_PROVIDER_LIST"], retention: "regz_le_3y", citation: "12 CFR 1026.19(e)(1)(i), 1026.37, 1026.37(o)(3)(iii) (E-SIGN consent before electronic delivery), 1026.25(c)(1)(i); form H-24" },
  NTC_REGZ_1026_19E1VI_PROVIDER_LIST: { channelPolicy: "esign_or_mail", noticeClass: "disclosures", separateDocument: true, mayCombineWith: ["NTC_REGZ_1026_37_LE"], retention: "regz_le_3y", citation: "12 CFR 1026.19(e)(1)(vi)(C); delivered with the Loan Estimate" },
  NTC_REGZ_1026_19E2II_PRELE_ESTIMATE: { channelPolicy: "electronic_ok_without_esign", noticeClass: "disclosures", separateDocument: false, mayCombineWith: ["NTC_SM_RATE_QUOTE", "NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER"], retention: "regz_le_3y", citation: "12 CFR 1026.19(e)(2)(ii) — wrapper retired in favour of 20.4's NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER (verification report item 13); identical statement" },
};
