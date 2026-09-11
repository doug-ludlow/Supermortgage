/**
 * §20.4 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * NTC_SM_RATE_QUOTE — the consumer-specific written quote issued before the Loan Estimate (20.4 rule 7): the
 *   §1026.19(e)(2)(ii) statement verbatim at the top of page 1 in 12-pt bold (REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE;
 *   20.3 owns the stand-alone NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER template the statement is shared with), "estimate"
 *   language (§1026.17(c)(2)(i)), rate, estimated APR, term, P&I, estimated MI and escrow shown separately with the
 *   taxes-and-insurance statement when a total is shown, lock period and expiry, the third-party cost treatment
 *   sentence, no points, the lender credit if any, the MLO's and the partner's names and NMLSR IDs (§1026.36(g)),
 *   "not a commitment"; the layout must not resemble form H-24 (no "Loan Estimate" title, no LE section structure).
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });

export const RATE_QUOTE_DISCLAIMER = "Your actual rate, payment, and costs could be higher. Get an official Loan Estimate before choosing a loan.";
export const RATE_QUOTE_SOURCE = `{{#block "disclaimer" page=1 y=0.02 pt=12 bold}}${RATE_QUOTE_DISCLAIMER}{{/block}}
{{#block "heading" page=1 y=0.08 pt=14 bold}}{{title}}{{/block}}
{{#block "intro" page=1 y=0.13 pt=11}}Prepared {{date prepared_on}} for {{borrower_name}}, {{property_address}} (quote {{quote_id}}). This is an estimate of the terms available to you today under the partner's pricing policy; it is not a Loan Estimate and it is not a commitment to lend.{{/block}}
{{#block "terms" page=1 y=0.22 pt=11}}Loan amount {{money loan_amount_cents}} · {{term_months}}-month fixed rate · Interest rate {{note_rate_pct}}% · Estimated annual percentage rate (APR) {{apr_estimate_pct}}%. Estimated monthly principal and interest {{money pi_cents}}. Estimated mortgage insurance {{money mi_monthly_cents}} per month. Estimated escrow for taxes and insurance {{money escrow_monthly_estimate_cents}} per month (an estimate until your escrow analysis is prepared). {{#if shows_total}}Estimated total monthly payment {{money total_monthly_cents}}; the principal-and-interest payment alone does not include taxes and insurance.{{/if}}{{/block}}
{{#block "pricing" page=1 y=0.42 pt=11}}Points: none — this program charges no points. {{#if has_lender_credit}}Lender credit: {{money lender_credit_cents}} toward your closing costs.{{/if}} {{#if borrower_pays_costs}}Third-party costs of {{money third_party_costs_cents}} (appraisal, title, recording and similar services) are paid by you at closing, as you elected, in exchange for the lower rate shown.{{else}}Third-party costs of {{money third_party_costs_cents}} (appraisal, title, recording and similar services) are paid by Supermortgage under the partner's program and are not charged to you; they are recovered from the price the investor pays for the loan.{{/if}}{{/block}}
{{#block "validity" page=1 y=0.58 pt=11}}Lock period: {{lock_period_days}} days once you lock. Rates change daily; this quote is valid today until {{valid_until_display}}. After that time you will be re-quoted from the rates then in effect, which may be higher or lower.{{/block}}
{{#block "originator" page=1 y=0.72 pt=11}}Prepared by {{mlo_name}}, NMLSR ID {{mlo_nmlsr_id}}, on behalf of {{partner_name}}, NMLSR ID {{partner_nmlsr_id}}. Not a commitment to lend; all terms are subject to underwriting, appraisal and program eligibility.{{/block}}`;

export const RATE_QUOTE_RULES: ContentRule[] = [
  R("disclaimer-text", "12 CFR 1026.19(e)(2)(ii)", "presence", "Your actual rate, payment, and costs could be higher\\. Get an official Loan Estimate before choosing a loan\\.", "the (e)(2)(ii) statement verbatim"),
  R("disclaimer-top-12pt", "12 CFR 1026.19(e)(2)(ii): at the top of the front of the first page in a font size no smaller than 12-point", "layout", "disclaimer", "statement at the top of page 1 in ≥ 12-point type", { layout: { page: 1, maxYFraction: 0.05, minPt: 12 } }),
  R("estimate-language", "12 CFR 1026.17(c)(2)(i): the disclosure shall state clearly that it is an estimate", "presence", "This is an estimate of the terms", "estimate language"),
  R("not-an-le", "12 CFR 1026.19(e)(2)(ii); 20.4 rule 7: layout must not resemble H-24", "presence", "it is not a Loan Estimate", "not a Loan Estimate statement"),
  R("no-h24-title", "12 CFR 1026.19(e)(2)(ii): not substantially similar to form H-24 (no \"Loan Estimate\" title)", "data_equality", "title", "the title is not \"Loan Estimate\"", { predicate: { "!=": [{ var: "title" }, "Loan Estimate"] } }),
  R("no-h24-sections", "12 CFR 1026.19(e)(2)(ii): no H-24 section structure", "absence", "(Projected Payments|Costs at Closing|Calculating Cash to Close|Services You Can(not)? Shop For)", "no H-24 section headings"),
  R("rate-apr-term", "20.4 rule 7: rate, estimated APR, term", "presence", "Interest rate \\d+\\.\\d{3}% · Estimated annual percentage rate \\(APR\\) \\d+\\.\\d{3}%", "rate and estimated APR to three decimals"),
  R("pi", "20.4 rule 7: P&I", "presence", "Estimated monthly principal and interest \\$[\\d,]+\\.\\d{2}", "monthly P&I"),
  R("mi-escrow-separate", "20.4 rule 7: estimated MI and escrow separately", "presence", "Estimated mortgage insurance \\$[\\d,]+\\.\\d{2} per month\\. Estimated escrow for taxes and insurance \\$[\\d,]+\\.\\d{2} per month", "MI and escrow shown separately"),
  R("taxes-insurance-statement", "20.4 rule 7: \"payments do not include taxes and insurance\" if a total is shown", "conditional", "shows_total", "the P&I-alone statement accompanies a total", { when: { var: "shows_total" }, predicate: { "==": [{ var: "shows_total" }, true] } }),
  R("taxes-insurance-text", "20.4 rule 7", "presence", "does not include taxes and insurance", "taxes-and-insurance statement"),
  R("lock-and-expiry", "20.4 rule 6/7: lock period and expiry", "presence", "Lock period: \\d+ days .* valid today until \\d{4}-\\d{2}-\\d{2} \\d{1,2}:\\d{2} [ap]\\.m\\. ET", "lock period and the expiry time"),
  R("cost-treatment", "20.4 rule 7: third-party cost treatment sentence", "presence", "Third-party costs of \\$[\\d,]+\\.\\d{2} .* are paid by", "third-party cost treatment"),
  R("no-points", "20.4 rule 4/7: points = 0 by program", "presence", "Points: none", "no points"),
  R("no-points-data", "20.4 rule 4: points_cents = 0", "data_equality", "points_cents", "no points charged", { predicate: { "==": [{ var: "points_cents" }, 0] } }),
  R("lender-credit-when-any", "20.4 rule 7: lender credit if any", "conditional", "lender_credit_cents", "lender credit shown when positive", { when: { var: "has_lender_credit" }, predicate: { ">": [{ var: "lender_credit_cents" }, 0] } }),
  R("mlo-nmlsr", "12 CFR 1026.36(g); 20.4 rule 7", "presence", "Prepared by .+, NMLSR ID \\d+, on behalf of .+, NMLSR ID \\d+", "MLO and partner names with NMLSR IDs"),
  R("not-a-commitment", "20.4 rule 7", "presence", "Not a commitment to lend", "not a commitment"),
  R("no-fee-demand", "12 CFR 1026.19(e)(2)(i)(A)", "absence", "(pay now|payment due today|charge your card)", "no fee demand on a pre-LE estimate"),
];
/** Worked example A as re-quoted Mon Oct 5, 2026 (lead_quote, valid until 5:00 p.m. ET): 6.125 %, P&I $3,402.62, escrow $555.00, lender credit $700.00, SM-paid costs $3,485.00. */
export const RATE_QUOTE_SAMPLE = { title: "Your Rate Quote", prepared_on: "2026-10-05", borrower_name: "Alex Borrower", property_address: "4210 E Camelback Rd, Phoenix, AZ 85018", quote_id: "Q-20-4-A-1005",
  loan_amount_cents: 56_000_000n, term_months: 360, note_rate_pct: "6.125", apr_estimate_pct: "6.095", pi_cents: 340_262n, mi_monthly_cents: 0n, escrow_monthly_estimate_cents: 55_500n, total_monthly_cents: 395_762n, shows_total: true,
  points_cents: 0n, lender_credit_cents: 70_000n, has_lender_credit: true, borrower_pays_costs: false, third_party_costs_cents: 348_500n, lock_period_days: 45, valid_until_display: "2026-10-05 5:00 p.m. ET",
  mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", partner_name: "Partner Bank, N.A.", partner_nmlsr_id: "123456", escrowed: true, has_mi: false };

export const VERSIONS_20_4: VersionInput[] = [
  V("NTC_SM_RATE_QUOTE", RATE_QUOTE_SOURCE, RATE_QUOTE_RULES, RATE_QUOTE_SAMPLE, "sm.pricing.2026.v1", "12 CFR 1026.19(e)(2)(ii), 1026.17(c)(2)(i), 1026.36(g); 20.4 rule 7 and worked example A (Oct 5, 2026 lead quote)"),
];
export const OVERRIDES_20_4: Record<string, Partial<NoticeTemplate>> = {
  NTC_SM_RATE_QUOTE: { channelPolicy: "electronic_ok_without_esign", noticeClass: "disclosures", separateDocument: false, mayCombineWith: ["NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER", "NTC_SM_PREQUAL_LETTER"], retention: "sm_lead_36m", piiLevel: "medium",
    citation: "12 CFR 1026.19(e)(2)(ii) (statement at the top of page 1, ≥ 12-pt; not substantially similar to H-24/H-25); 1026.17(c)(2)(i); 1026.36(g) — a consumer-specific written estimate is not an advertisement (comment 2(a)(2)-1.ii); retention regz_le_3y once an application follows, else sm_lead_36m" },
};
