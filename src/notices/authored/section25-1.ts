/**
 * §25.1 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * NTC_REGZ_1026_38_CD — the Closing Disclosure (12 CFR 1026.38; form H-25). 25.1 owns the template because its "Loan
 * Calculations" figures (Total of Payments, Finance Charge, Amount Financed, APR, TIP) come from `apr_calculations`
 * (worked example 1: $1,224,943.20 / $668,793.15 / $556,150.05 / 6.159% / 119.059%); 25.2 renders and delivers it.
 * Statutory content checked: (a)(3) loan terms and creditor/settlement-agent identification; (b) loan terms; (c)
 * projected payments; (o)(1)–(5) loan calculations with the (o)(4) APR statement "Your costs over the loan term
 * expressed as a rate. This is not your interest rate." and the (o)(5) TIP statement; (r) contact information with the
 * creditor's and loan originator's NMLSR IDs (§1026.36(g)); (s) confirm receipt; (t)(4) percentages to three
 * decimals; (f)(5) no CD-preparation or disclosure-delivery fee.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const present = (...paths: string[]): Record<string, unknown> => ({ and: paths.map((p) => ({ present: p })) });
const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}";

const CD_SOURCE = `{{#block "heading" page=1 y=0.03 pt=16 bold}}Closing Disclosure{{/block}}
{{#block "purpose" page=1 y=0.06 pt=10}}This form is a statement of final loan terms and closing costs. Compare this document with your Loan Estimate.{{/block}}
{{#block "closing_information" page=1 y=0.09 pt=10}}Date Issued {{date date_issued}}. Closing Date {{date closing_date}}. Disbursement Date {{date disbursement_date}}. Settlement Agent {{settlement_agent_name}}. File # {{file_number}}. Property {{property_address}}. Appraised Prop. Value {{money appraised_value_cents}}.{{/block}}
{{#block "transaction_information" page=1 y=0.15 pt=10}}Borrower {{#each borrowers}}{{this}}; {{/each}}Lender {{creditor_name}}. Loan Term {{loan_term_years}} years. Purpose {{purpose}}. Product {{product}}. Loan Type {{loan_type}}. Loan ID # {{loan_id_number}}. MIC # {{mic_number}}.{{/block}}
{{#block "loan_terms" page=1 y=0.22 pt=11 bold}}Loan Terms{{/block}}
{{#block "loan_terms_body" page=1 y=0.24 pt=10}}Loan Amount {{money loan_amount_cents}}. Can this amount increase after closing? {{#if loan_amount_can_increase}}YES{{else}}NO{{/if}}. Interest Rate {{pct interest_rate_pct}}. Can this amount increase after closing? {{#if rate_can_increase}}YES{{else}}NO{{/if}}. Monthly Principal & Interest {{money pi_cents}}. Can this amount increase after closing? {{#if pi_can_increase}}YES{{else}}NO{{/if}}. Does the loan have these features? Prepayment Penalty {{#if prepayment_penalty}}YES{{else}}NO{{/if}}. Balloon Payment {{#if balloon_payment}}YES{{else}}NO{{/if}}.{{/block}}
{{#block "projected_payments" page=1 y=0.4 pt=11 bold}}Projected Payments{{/block}}
{{#block "projected_payments_body" page=1 y=0.42 pt=10}}Payment Calculation Years 1-{{loan_term_years}}: Principal & Interest {{money pi_cents}}; Mortgage Insurance {{money mi_cents}}; Estimated Escrow {{money escrow_cents}}; Estimated Total Monthly Payment {{money total_monthly_payment_cents}}. Estimated Taxes, Insurance & Assessments {{money taxes_insurance_assessments_monthly_cents}} a month. {{#if escrow}}In escrow? YES — property taxes, homeowner's insurance.{{else}}In escrow? NO.{{/if}}{{/block}}
{{#block "costs_at_closing" page=1 y=0.55 pt=11 bold}}Costs at Closing{{/block}}
{{#block "costs_at_closing_body" page=1 y=0.57 pt=10}}Closing Costs {{money closing_costs_cents}} includes {{money loan_costs_cents}} in Loan Costs + {{money other_costs_cents}} in Other Costs − {{money lender_credits_cents}} in Lender Credits. Cash to Close {{money cash_to_close_cents}}.{{/block}}
{{#block "loan_calculations" page=5 y=0.05 pt=11 bold}}Loan Calculations{{/block}}
{{#block "loan_calculations_body" page=5 y=0.07 pt=10}}Total of Payments. Total you will have paid after you make all payments of principal, interest, mortgage insurance, and loan costs, as scheduled. {{money total_of_payments_cents}}. Finance Charge. The dollar amount the loan will cost you. {{money finance_charge_cents}}. Amount Financed. The loan amount available after paying your upfront finance charge. {{money amount_financed_cents}}.{{/block}}
{{#block "apr" page=5 y=0.15 pt=10 bold}}Annual Percentage Rate (APR). Your costs over the loan term expressed as a rate. This is not your interest rate. {{pct apr}}{{/block}}
{{#block "tip" page=5 y=0.18 pt=10 bold}}Total Interest Percentage (TIP). The total amount of interest that you will pay over the loan term as a percentage of your loan amount. {{pct tip_pct}}{{/block}}
{{#block "other_disclosures" page=5 y=0.22 pt=10}}Other Disclosures. Appraisal: If the property was appraised for your loan, your lender is required to give you a copy at no additional cost at least 3 days before closing. Contract Details: See your note and security instrument for information about nonpayment, default, any required repayment in full before the scheduled date, and the rules for making payments before they are due. Liability after Foreclosure: {{#if state_antideficiency}}state law may protect you from liability for the unpaid balance.{{else}}you may have to pay any unpaid balance after foreclosure — consult an attorney.{{/if}} Refinance: Refinancing this loan will depend on your future financial situation, the property value, and market conditions. Tax Deductions: If you borrow more than this property is worth, the interest on the loan amount above this property's fair market value is not deductible from your federal income taxes. Consult a tax advisor.{{/block}}
{{#block "contact_information" page=5 y=0.45 pt=10}}Contact Information. Lender {{creditor_name}}, {{creditor_address}}, NMLS ID {{creditor_nmlsr_id}}, Contact {{creditor_contact_name}}, Contact NMLS ID {{mlo_nmlsr_id}}, Email {{creditor_email}}, Phone {{creditor_phone}}. Settlement Agent {{settlement_agent_name}}, {{settlement_agent_address}}, License ID {{settlement_agent_license_id}}, Contact {{settlement_agent_contact}}, Phone {{settlement_agent_phone}}.{{/block}}
{{#block "confirm_receipt" page=5 y=0.7 pt=10 bold}}Confirm Receipt. By signing, you are only confirming that you have received this form. You do not have to accept this loan because you have signed or received this form. Applicant Signature / Date. Co-Applicant Signature / Date.{{/block}}`;

const CD_RULES: ContentRule[] = [
  R("heading", "§1026.38(a)(2); H-25", "layout", "heading", "the form is titled Closing Disclosure", { layout: { page: 1, bold: true, minPt: 14 } }),
  R("a2-purpose", "§1026.38(a)(2)", "presence", "statement of final loan terms and closing costs\\. Compare this document with your Loan Estimate", "the (a)(2) statement of purpose"),
  R("a3-closing-information", "§1026.38(a)(3)", "data_equality", "date_issued,closing_date,disbursement_date,settlement_agent_name,file_number,property_address", "date issued, closing date, disbursement date, settlement agent, file number and property", { predicate: present("date_issued", "closing_date", "disbursement_date", "settlement_agent_name", "file_number", "property_address") }),
  R("a3-dates-text", "§1026.38(a)(3)(i)–(iii)", "presence", `Date Issued ${MONTH}\\. Closing Date ${MONTH}\\. Disbursement Date ${MONTH}`, "date issued, closing date and disbursement date rendered as dates"),
  R("a4-a5-parties", "§1026.38(a)(4)–(5)", "data_equality", "borrowers,creditor_name,loan_term_years,purpose,product,loan_type,loan_id_number", "borrower(s), creditor, loan term, purpose, product, loan type and loan ID", { predicate: { and: [{ present: "borrowers" }, { present: "creditor_name" }, { present: "loan_term_years" }, { present: "purpose" }, { present: "product" }, { present: "loan_type" }, { present: "loan_id_number" }] } }),
  R("b-loan-terms", "§1026.38(b); §1026.37(b)", "presence", "Loan Amount \\$[\\d,]+\\.\\d{2}\\. Can this amount increase after closing\\? (YES|NO)\\. Interest Rate \\d+\\.\\d{3}%.*Monthly Principal & Interest \\$[\\d,]+\\.\\d{2}", "loan amount, interest rate and monthly P&I with the increase questions"),
  R("b-loan-terms-data", "§1026.38(b)", "data_equality", "loan_amount_cents,interest_rate_pct,pi_cents", "loan terms carried from the note (CD_NOTE_PI consistency, 25.2)", { predicate: { and: [{ ">": [{ var: "loan_amount_cents" }, 0] }, { ">": [{ var: "pi_cents" }, 0] }, { present: "interest_rate_pct" }] } }),
  R("b-features", "§1026.38(b); §1026.37(b)(4)", "presence", "Prepayment Penalty (YES|NO)\\. Balloon Payment (YES|NO)", "prepayment-penalty and balloon features answered"),
  R("c-projected-payments", "§1026.38(c)", "presence", "Projected Payments.*Principal & Interest \\$[\\d,]+\\.\\d{2}; Mortgage Insurance \\$[\\d,]+\\.\\d{2}; Estimated Escrow \\$[\\d,]+\\.\\d{2}; Estimated Total Monthly Payment \\$[\\d,]+\\.\\d{2}", "projected payments table"),
  R("c-escrow-statement", "§1026.38(c)(4)", "presence", "In escrow\\? (YES|NO)", "escrow statement in the projected payments"),
  R("d-costs-at-closing", "§1026.38(d)", "presence", "Closing Costs \\$[\\d,]+\\.\\d{2} includes \\$[\\d,]+\\.\\d{2} in Loan Costs \\+ \\$[\\d,]+\\.\\d{2} in Other Costs − \\$[\\d,]+\\.\\d{2} in Lender Credits\\. Cash to Close \\$[\\d,]+\\.\\d{2}", "costs at closing summary"),
  R("o1-total-of-payments", "§1026.38(o)(1)", "presence", "Total of Payments\\. Total you will have paid after you make all payments of principal, interest, mortgage insurance, and loan costs, as scheduled\\. \\$[\\d,]+\\.\\d{2}", "total of payments with its statement"),
  R("o2-finance-charge", "§1026.38(o)(2)", "presence", "Finance Charge\\. The dollar amount the loan will cost you\\. \\$[\\d,]+\\.\\d{2}", "finance charge with its statement"),
  R("o3-amount-financed", "§1026.38(o)(3)", "presence", "Amount Financed\\. The loan amount available after paying your upfront finance charge\\. \\$[\\d,]+\\.\\d{2}", "amount financed with its statement"),
  R("o4-apr-statement", "§1026.38(o)(4)", "presence", "Annual Percentage Rate \\(APR\\)\\. Your costs over the loan term expressed as a rate\\. This is not your interest rate\\. \\d+\\.\\d{3}%", "APR with the (o)(4) statement, three decimals ((t)(4))"),
  R("o5-tip-statement", "§1026.38(o)(5)", "presence", "Total Interest Percentage \\(TIP\\)\\. The total amount of interest that you will pay over the loan term as a percentage of your loan amount\\. \\d+\\.\\d{3}%", "TIP with the (o)(5) statement"),
  R("o-loan-calculations-data", "§1026.38(o); 25.1 apr_calculations", "data_equality", "total_of_payments_cents,finance_charge_cents,amount_financed_cents,apr,tip_pct", "loan calculations come from the checkpoint apr_calculations row", { predicate: { and: [{ ">": [{ var: "total_of_payments_cents" }, 0] }, { ">": [{ var: "finance_charge_cents" }, 0] }, { ">": [{ var: "amount_financed_cents" }, 0] }, { present: "apr" }, { present: "tip_pct" }] } }),
  R("o-amount-financed-le-loan", "comment 18(b); §1026.38(o)(3)", "data_equality", "amount_financed_cents,loan_amount_cents", "amount financed = loan amount − prepaid finance charges (never above the loan amount)", { predicate: { "<=": [{ var: "amount_financed_cents" }, { var: "loan_amount_cents" }] } }),
  R("apr-range", "§1026.22; §1026.38(t)(4)", "data_range", "apr", "APR is a percentage between 0 and 30", { range: { min: 0, max: 30 } }),
  R("apr-prominent", "§1026.38(o)(4); H-25 page 5", "layout", "apr", "APR block on page 5, bold", { layout: { page: 5, bold: true } }),
  R("p-other-disclosures", "§1026.38(p)", "presence", "Appraisal:.*Contract Details:.*Liability after Foreclosure:.*Refinance:.*Tax Deductions:", "the (p) other disclosures"),
  R("r-contact-nmlsr", "§1026.38(r); §1026.36(g)", "data_equality", "creditor_name,creditor_nmlsr_id,creditor_contact_name,mlo_nmlsr_id", "the creditor's name and NMLSR ID and the loan originator's name and NMLSR ID", { predicate: { and: [{ present: "creditor_name" }, { matches: ["creditor_nmlsr_id", "^\\d{3,}$"] }, { present: "creditor_contact_name" }, { matches: ["mlo_nmlsr_id", "^\\d{3,}$"] }] } }),
  R("r-contact-text", "§1026.38(r)", "presence", "Lender \\S.*NMLS ID \\d{3,}, Contact \\S.*Contact NMLS ID \\d{3,}.*Settlement Agent \\S.*License ID", "contact block rendered with both NMLSR IDs and the settlement agent", { severity: "block" }),
  R("s-confirm-receipt", "§1026.38(s)", "presence", "By signing, you are only confirming that you have received this form\\. You do not have to accept this loan because you have signed or received this form", "confirm-receipt statement"),
  R("f5-no-cd-fee", "§1026.19(f)(5); 25.2-T14", "absence", "(CD preparation fee|disclosure delivery fee)", "no fee may be imposed for preparing or delivering the Closing Disclosure"),
  R("closing-not-before-disbursement", "§1026.38(a)(3)(ii)–(iii); 25.3 rescission", "data_range", "days_closing_to_disbursement", "disbursement date is on or after the closing date (refinance of a principal dwelling: after the rescission period)", { range: { min: 0 } }),
];
/** Worked example 1 (refinance fixture, CD issued Mon Nov 2, 2026): loan $560,000.00 at 6.125%, P&I $3,402.62, total of payments $1,224,943.20, finance charge $668,793.15, amount financed $556,150.05, APR 6.159%, TIP 119.059%. */
const CD_SAMPLE: Record<string, unknown> = {
  date_issued: "2026-11-02", closing_date: "2026-11-06", disbursement_date: "2026-11-12", days_closing_to_disbursement: 6, settlement_agent_name: "Desert Title Agency LLC", file_number: "DT-2026-11841", property_address: "4821 E Camelback Rd, Phoenix AZ 85018", appraised_value_cents: 80_000_000n,
  borrowers: ["Alex Rivera"], creditor_name: "Partner Bank, N.A.", loan_term_years: 30, purpose: "Refinance", product: "Fixed Rate", loan_type: "Conventional", loan_id_number: "APP-REFI-1", mic_number: "N/A",
  loan_amount_cents: 56_000_000n, loan_amount_can_increase: false, interest_rate_pct: "6.125", rate_can_increase: false, pi_cents: 340_262n, pi_can_increase: false, prepayment_penalty: false, balloon_payment: false,
  mi_cents: 0n, escrow_cents: 68_750n, total_monthly_payment_cents: 409_012n, taxes_insurance_assessments_monthly_cents: 68_750n, escrow: true,
  closing_costs_cents: 545_452n, loan_costs_cents: 380_952n, other_costs_cents: 164_500n, lender_credits_cents: 0n, cash_to_close_cents: 545_452n,
  total_of_payments_cents: 122_494_320n, finance_charge_cents: 66_879_315n, amount_financed_cents: 55_615_005n, apr: "6.159", tip_pct: "119.059", state_antideficiency: true,
  creditor_address: "100 Partner Plaza, Phoenix AZ 85004", creditor_nmlsr_id: "123456", creditor_contact_name: "Jordan Lee", mlo_nmlsr_id: "987654", creditor_email: "jlee@partnerbank.example", creditor_phone: "(602) 555-0100",
  settlement_agent_address: "2 Title Way, Phoenix AZ 85012", settlement_agent_license_id: "AZ-TA-4471", settlement_agent_contact: "Sam Ortiz", settlement_agent_phone: "(602) 555-0177",
};

export const VERSIONS_25_1: VersionInput[] = [
  V("NTC_REGZ_1026_38_CD", CD_SOURCE, CD_RULES, CD_SAMPLE, "regz.trid.2017", "12 CFR 1026.38 / form H-25 (Closing Disclosure); 25.1 worked example 1 figures"),
];
export const OVERRIDES_25_1: Record<string, Partial<NoticeTemplate>> = {
  NTC_REGZ_1026_38_CD: { name: "Closing Disclosure (H-25)", citation: "12 CFR 1026.38; 12 CFR 1026.19(f); form H-25", noticeClass: "trid_disclosures", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: [], retention: "regz_cd_5y", piiLevel: "high" },
};
