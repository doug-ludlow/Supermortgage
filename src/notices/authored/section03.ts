/**
 * Authored template versions for the §3 escrow notices: the annual and
 * short-year statements (§1024.17(i)), the post-exemption history, the
 * (f)(5) shortage notice, the voluntary lump-sum insert, and the policy and
 * state notices 3.5/3.7/3.8 name. Sample payloads are the spec's worked
 * examples so the publish gate proves each template.
 */
import type { ContentRule, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const CONTACT = `{{#block "contact" page=2 y=0.9 pt=10}}Questions? Call {{servicer_phone}}. Notices of error and requests for information: {{exclusive_address}}.{{/block}}`;

// ------------------------------------------------------------------ 3.3 annual statement (§1024.17(i)(1)(i)–(viii))
const HISTORY = `{{#block "history" page=1 y=0.45 pt=10}}Account history {{date year_start}} to {{date year_end}}: {{#each history}}{{month}} deposits {{money deposits_cents}} disbursements {{money disbursements_cents}} balance {{money balance_cents}}{{#if assumed}} (assumed){{/if}}; {{/each}}{{/block}}`;
const ANNUAL_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}ANNUAL ESCROW ACCOUNT DISCLOSURE STATEMENT{{/block}}
{{#block "i_ii" page=1 y=0.12 pt=11}}(i) Your new monthly mortgage payment is {{money new_payment_cents}}, of which {{money new_escrow_portion_cents}} goes to escrow. (ii) Your past year's monthly payment was {{money prior_payment_cents}}, of which {{money prior_escrow_portion_cents}} went to escrow.{{/block}}
{{#block "iii_v" page=1 y=0.25 pt=11}}(iii) Total paid into your escrow account during the year: {{money deposits_total_cents}}. (iv) Total paid out: county tax {{money out_tax_cents}}, hazard insurance {{money out_insurance_cents}}, other {{money out_other_cents}}. (v) Balance at the end of the computation year: {{money ending_balance_cents}}. Interest credited: {{money interest_credited_cents}}.{{/block}}
${HISTORY}
{{#block "vi_vii" page=1 y=0.62 pt=11}}(vi) {{decision_text}} (vii) {{plan_text}}{{/block}}
{{#block "viii" page=1 y=0.72 pt=11}}(viii) Why your actual low balance differed from the projection: {{#each low_point_explanation}}{{this}}; {{/each}}{{/block}}
{{#block "projection" page=2 y=0.1 pt=10}}Attached: last year's projection ({{date prior_projection_date}}) and the coming year's projection: {{#each projection}}{{month}} target {{money target_cents}}; {{/each}}{{/block}}
{{#if state_supplement}}{{#block "state" page=2 y=0.6 pt=10}}{{state_supplement}}{{/block}}{{/if}}
${CONTACT}`;
const ANNUAL_RULES: ContentRule[] = [
  R("i-new-payment", "§1024.17(i)(1)(i)", "presence", "\\(i\\) Your new monthly mortgage payment is \\$[\\d,]+\\.\\d{2}, of which \\$[\\d,]+\\.\\d{2} goes to escrow", "current payment and escrow portion"),
  R("ii-prior-payment", "§1024.17(i)(1)(ii)", "presence", "\\(ii\\) Your past year's monthly payment was", "past year's payment and escrow portion"),
  R("iii-deposits", "§1024.17(i)(1)(iii)", "presence", "\\(iii\\) Total paid into your escrow account", "total deposits"),
  R("iv-disbursements", "§1024.17(i)(1)(iv)", "presence", "\\(iv\\) Total paid out: county tax .* hazard insurance .* other", "disbursements by type"),
  R("v-balance", "§1024.17(i)(1)(v)", "presence", "\\(v\\) Balance at the end of the computation year", "ending balance"),
  R("vi-handling", "§1024.17(i)(1)(vi)", "presence", "\\(vi\\) ", "surplus/shortage/deficiency handling"),
  R("vii-plan", "§1024.17(i)(1)(vii)", "presence", "\\(vii\\) ", "repayment plan statement"),
  R("viii-low-point", "§1024.17(i)(1)(viii)", "presence", "\\(viii\\) Why your actual low balance differed", "low-point explanation"),
  R("history", "§1024.17(i)(1); 3.3 rule 1", "presence", "Account history .* to ", "month-by-month history"),
  R("prior-projection", "§1024.17(i); 3.3 rule 8", "layout", "projection", "prior projection attached", { layout: { page: 2 } }),
  R("computation-year", "3.3 checklist", "presence", "Account history (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4} to", "computation-year dates"),
  R("interest-credited", "3.9 rule 10", "presence", "Interest credited: \\$[\\d,]+\\.\\d{2}", "interest credited for the year"),
  R("no-lump-sum-demand", "3.3 rule 4; CFPB FAQ", "conditional", "shortage_at_least_one_month", "no lump-sum wording when the shortage is ≥ one month", { when: { "==": [{ var: "shortage_at_least_one_month" }, true] }, predicate: { "!": { present: "lump_sum_text" } } }),
  R("no-lump-sum-text", "3.6 rule 8", "absence", "lump[- ]sum", "the statement body never mentions a lump sum"),
  R("timing-30", "§1024.17(i)(1)", "data_range", "days_after_year_end", "sent within 30 days of the computation-year end", { range: { max: 30 } }),
  R("state-supplement", "3.3 checklist (UT/MD/VT/ME)", "conditional", "state_supplement", "state supplement where required", { when: { "==": [{ var: "state_supplement_required" }, true] }, predicate: { present: "state_supplement" } }),
];
const ANNUAL_SAMPLE: Record<string, unknown> = {
  new_payment_cents: 175_239n, new_escrow_portion_cents: 17_222n, prior_payment_cents: 171_017n, prior_escrow_portion_cents: 13_000n, deposits_total_cents: 156_000n, out_tax_cents: 154_000n, out_insurance_cents: 0n, out_other_cents: 36_000n, ending_balance_cents: 70_000n, interest_credited_cents: 0n,
  year_start: "2026-07-01", year_end: "2027-06-30", history: [{ month: "Jul 2026", deposits_cents: 13_000n, disbursements_cents: 52_000n, balance_cents: 65_000n }, { month: "Jun 2027", deposits_cents: 13_000n, disbursements_cents: 0n, balance_cents: 70_000n, assumed: true }],
  decision_text: "Your account has a shortage of $406.68.", plan_text: "$33.89 per month for 12 months beginning 07/01/2027.", shortage_at_least_one_month: true,
  low_point_explanation: ["County tax paid 07/2026 was $520.00 vs $500.00 projected", "county tax paid 12/2026 was $760.00 vs $700.00 projected", "a supplemental tax bill of $260.00 was paid 03/2027 (not projected)", "low balance $180.00 vs $260.00 projected"],
  prior_projection_date: "2026-05-15", projection: [{ month: "Jul 2027", target_cents: 72_501n }, { month: "Dec 2027", target_cents: 27_666n }], state_supplement_required: false, days_after_year_end: 22, servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001",
};

// ------------------------------------------------------------------ 3.3 short-year statements (§1024.17(i)(4)) and post-exemption history ((i)(2))
const SHORT_YEAR_SOURCE = (kind: "transfer" | "reset") => `{{#block "heading" page=1 y=0.05 pt=14 bold}}SHORT-YEAR ESCROW ACCOUNT STATEMENT{{/block}}
{{#block "reason" page=1 y=0.12 pt=11}}This statement covers {{date year_start}} to {{date period_end}} because ${kind === "transfer" ? "the servicing of your loan transferred to {{transferee_name}} effective {{date period_end}}" : "your escrow computation year was reset effective {{date period_end}}"}.{{/block}}
${HISTORY}
{{#block "balance" page=1 y=0.6 pt=11}}Balance at {{date period_end}}: {{money ending_balance_cents}}.${kind === "transfer" ? " Your new servicer will project the coming year." : " Your new monthly escrow payment is {{money new_escrow_portion_cents}} effective {{date new_payment_effective_on}}."}{{/block}}
${kind === "reset" ? `{{#block "projection" page=2 y=0.1 pt=10}}Coming year projection: {{#each projection}}{{month}} target {{money target_cents}}; {{/each}}{{/block}}` : ""}
${CONTACT}`;
const SHORT_YEAR_RULES = (kind: "transfer" | "reset"): ContentRule[] => [
  R("period", "§1024.17(i)(4)", "presence", "This statement covers .* to ", "short-year period stated"),
  R("history", "§1024.17(i)(4)(i)", "presence", "Account history", "history to the short-year end"),
  R("balance", "§1024.17(i)(4)", "presence", "Balance at .*: \\$[\\d,]+\\.\\d{2}", "closing balance"),
  ...(kind === "transfer" ? [R("no-projection", "3.3 rule 7", "absence", "Coming year projection", "the transferor makes no projection; the transferee projects")] : [R("projection", "3.3 rule 7", "presence", "Coming year projection", "reset statement carries the new projection")]),
  R("timing-60", "§1024.17(i)(4)(i)–(ii)", "data_range", "days_after_event", "within 60 days of the transfer / reset", { range: { max: 60 } }),
];
const SHORT_YEAR_SAMPLE = (kind: "transfer" | "reset"): Record<string, unknown> => ({ year_start: "2026-07-01", period_end: kind === "transfer" ? "2027-03-01" : "2027-09-30", transferee_name: "Next Servicer LLC", history: [{ month: "Jul 2026", deposits_cents: 13_000n, disbursements_cents: 52_000n, balance_cents: 65_000n }], ending_balance_cents: 91_000n, new_escrow_portion_cents: 13_833n, new_payment_effective_on: "2027-11-01", projection: [{ month: "Nov 2027", target_cents: 60_000n }], days_after_event: 20, servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" });

const POST_EXEMPTION_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}ESCROW ACCOUNT HISTORY{{/block}}
{{#block "reason" page=1 y=0.12 pt=11}}Annual statements were not sent while your loan was {{exemption_reason}}. This history covers {{date year_start}} to {{date period_end}}, since your last statement.{{/block}}
${HISTORY}
{{#block "balance" page=1 y=0.6 pt=11}}Balance at {{date period_end}}: {{money ending_balance_cents}}. A new escrow analysis accompanies this history.{{/block}}
${CONTACT}`;
const POST_EXEMPTION_RULES: ContentRule[] = [
  R("covers-since-last", "§1024.17(i)(2)", "presence", "since your last statement", "history from the last statement"),
  R("history", "§1024.17(i)(2)", "presence", "Account history", "month-by-month history"),
  R("timing-90", "§1024.17(i)(2)", "data_range", "days_after_exemption_ended", "within 90 days of the exemption ending", { range: { max: 90 } }),
];
const POST_EXEMPTION_SAMPLE: Record<string, unknown> = { exemption_reason: "more than 30 days delinquent", year_start: "2026-07-01", period_end: "2027-09-10", history: [{ month: "Jul 2026", deposits_cents: 13_000n, disbursements_cents: 52_000n, balance_cents: 65_000n }], ending_balance_cents: 70_000n, days_after_exemption_ended: 45, servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

// ------------------------------------------------------------------ (f)(5) shortage notice and the voluntary lump-sum insert
const SHORTAGE_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}Our escrow analysis as of {{date as_of}} shows a shortage of {{money shortage_cents}} in your escrow account. You may allow the shortage to exist and pay it over {{months}} months at {{money installment_cents}} per month beginning {{date start_on}}. No interest is charged.{{/block}}
${CONTACT}`;
const SHORTAGE_RULES: ContentRule[] = [
  R("shortage-amount", "§1024.17(f)(5)", "presence", "shortage of \\$[\\d,]+\\.\\d{2}", "shortage amount"),
  R("options", "§1024.17(f)(3)", "presence", "pay it over \\d+ months at \\$[\\d,]+\\.\\d{2} per month", "repayment option"),
  R("months-12", "§1024.17(f)(3)(ii)", "data_range", "months", "≥ 12 months", { range: { min: 12 } }),
  R("no-lump-sum", "3.6 rule 8", "absence", "lump[- ]sum", "no lump-sum demand"),
];
const SHORTAGE_SAMPLE: Record<string, unknown> = { as_of: "2027-05-16", shortage_cents: 40_668n, months: 12, installment_cents: 3_389n, start_on: "2027-07-01", servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

const LUMPSUM_INSERT_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}Optional: you are not required to do this. If you prefer, you may pay all or part of the {{money shortage_cents}} shortage at any time, and your monthly escrow payment will be recalculated at your next analysis. Your monthly plan of {{money installment_cents}} continues unless you choose otherwise.{{/block}}`;
const LUMPSUM_INSERT_RULES: ContentRule[] = [
  R("optional", "CFPB escrow FAQ", "presence", "Optional: you are not required to do this", "worded as optional"),
  R("no-demand", "3.3 rule 4", "absence", "must pay|is due|required to pay", "no demand language"),
];
const LUMPSUM_INSERT_SAMPLE: Record<string, unknown> = { shortage_cents: 40_668n, installment_cents: 3_389n };

// ------------------------------------------------------------------ 3.5 surplus refund insert
const SURPLUS_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}Enclosed is your escrow surplus refund of {{money refund_cents}} from the escrow analysis dated {{date analysis_date}} (reference {{analysis_ref}}). Your monthly escrow payment is {{money escrow_payment_cents}}.{{/block}}
${CONTACT}`;
const SURPLUS_RULES: ContentRule[] = [R("amount", "§1024.17(f)(2)(i)", "presence", "surplus refund of \\$[\\d,]+\\.\\d{2}", "refund amount"), R("analysis-ref", "3.5 outputs", "presence", "reference [A-Z0-9-]+", "analysis reference"), R("timing-30", "§1024.17(f)(2)(i)", "data_range", "days_after_analysis", "refund within 30 days of the analysis", { range: { max: 30 } })];
const SURPLUS_SAMPLE: Record<string, unknown> = { refund_cents: 14_332n, analysis_date: "2027-05-16", analysis_ref: "EA-2027-0516", escrow_payment_cents: 13_833n, days_after_analysis: 6, servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

// ------------------------------------------------------------------ 3.6 / 3.7 advance and monitoring notices (policy)
const ADVANCE_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}On {{date advanced_on}} we advanced {{money advance_cents}} from our own funds to pay your {{item}} because your escrow account did not hold enough. We will complete an escrow analysis before asking you to repay it; no interest is charged.{{/block}}
${CONTACT}`;
const ADVANCE_RULES: ContentRule[] = [R("amount-item-date", "3.6 outputs (policy)", "presence", "advanced \\$[\\d,]+\\.\\d{2} .* to pay your", "amount, item and date"), R("analysis-follows", "§1024.17(f)(1)(ii)", "presence", "complete an escrow analysis before asking you to repay", "analysis before any repayment demand"), R("no-interest", "3.6 rule 6", "presence", "no interest is charged", "no interest")];
const ADVANCE_SAMPLE: Record<string, unknown> = { advanced_on: "2027-11-26", advance_cents: 26_000n, item: "county tax", servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

const HAZARD_ADVANCE_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}Your hazard insurance premium of {{money premium_cents}} was due {{date due_on}}. Because your loan is more than 30 days past due and your escrow account could not cover it, we advanced the premium on {{date advanced_on}} so your coverage continues. We will complete an escrow analysis before asking you to repay it.{{/block}}
${CONTACT}`;
const HAZARD_ADVANCE_RULES: ContentRule[] = [R("premium", "§1024.17(k)(5)(i)", "presence", "hazard insurance premium of \\$[\\d,]+\\.\\d{2}", "premium amount"), R("continues", "§1024.17(k)(5)(i)", "presence", "so your coverage continues", "coverage continued"), R("analysis-follows", "§1024.17(f)(1)(ii)", "presence", "escrow analysis before asking you to repay", "analysis before demand")];
const HAZARD_ADVANCE_SAMPLE: Record<string, unknown> = { premium_cents: 254_880n, due_on: "2027-10-01", advanced_on: "2027-10-01", servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

const NONESCROW_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}Our tax service reports that property taxes of {{money delinquent_cents}} for parcel {{parcel}} are delinquent. Your loan does not have an escrow account. Please pay them and send proof within 30 days, by {{date follow_up_on}}. If they remain unpaid and the property is scheduled for a tax sale, we may pay them to protect the lien, revoke your escrow waiver and establish an escrow account.{{/block}}
${CONTACT}`;
const NONESCROW_RULES: ContentRule[] = [R("delinquency", "3.7 rule 9 (policy)", "presence", "property taxes of \\$[\\d,]+\\.\\d{2} for parcel .* are delinquent", "delinquent taxes and parcel"), R("follow-up", "3.7 rule 9", "presence", "within 30 days, by", "30-day follow-up"), R("warning", "3.7 rule 9; 3.8 rule 5", "presence", "revoke your escrow waiver and establish an escrow account", "advance / waiver-revocation warning")];
const NONESCROW_SAMPLE: Record<string, unknown> = { delinquent_cents: 76_000n, parcel: "123-45-678", follow_up_on: "2027-10-31", servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

const IL_TAX_PAID_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}As required by the Illinois Mortgage Escrow Account Act (765 ILCS 910/15), this confirms that on {{date paid_on}} we paid {{money amount_cents}} in property taxes from your escrow account for the property at {{property_address}}, parcel {{parcel}}.{{/block}}
${CONTACT}`;
const IL_TAX_PAID_RULES: ContentRule[] = [R("payment-date", "765 ILCS 910/15", "presence", "on (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4} we paid", "payment date"), R("amount", "765 ILCS 910/15", "presence", "we paid \\$[\\d,]+\\.\\d{2} in property taxes", "amount"), R("property", "765 ILCS 910/15", "presence", "property at .*, parcel ", "property identification"), R("timing-45bd", "765 ILCS 910/15", "data_range", "business_days_after_payment", "within 45 business days of payment", { range: { max: 45 } })];
const IL_TAX_PAID_SAMPLE: Record<string, unknown> = { paid_on: "2027-06-03", amount_cents: 74_480n, property_address: "1 Test St, Chicago IL 60601", parcel: "14-21-101-001", business_days_after_payment: 20, servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

// ------------------------------------------------------------------ 3.8 waiver decision, revocation, Minnesota right
const WAIVER_DECISION_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}Your request to waive your escrow account received {{date requested_on}} is {{decision}}.{{#if approved}} The waiver is effective {{date effective_on}}; any remaining balance will be refunded within 30 days and a short-year statement will follow.{{else}} Reasons: {{#each reasons}}{{this}}; {{/each}}You may request again on or after {{date re_request_on}}. Basis: Fannie Mae Servicing Guide B-1-01; 12 CFR 1026.35(b); 42 U.S.C. 4012a (flood, where applicable).{{/if}}{{/block}}
{{#block "ai" page=1 y=0.5 pt=10}}{{ai_explanation}} You may ask for a person to review this decision by calling {{servicer_phone}}.{{/block}}
${CONTACT}`;
const WAIVER_DECISION_RULES: ContentRule[] = [
  R("decision", "3.8 rule 3", "presence", "is (approved|denied|partially approved)", "approve/deny stated"),
  R("reasons", "3.8 rule 3", "conditional", "reasons", "all failed reasons in plain language when denied", { when: { "==": [{ var: "approved" }, false] }, predicate: { present: "reasons.0" } }),
  R("re-request", "3.8 rule 3", "conditional", "re_request_on", "earliest re-request date when denied", { when: { "==": [{ var: "approved" }, false] }, predicate: { present: "re_request_on" } }),
  R("basis", "B-1-01; §1026.35(b); 22.5", "conditional", "approved", "basis retained on denials", { when: { "==": [{ var: "approved" }, false] }, predicate: { present: "reasons" } }),
  R("ai-explanation", "Colorado AI Act; LL-2026-04", "presence", "ask for a person to review this decision", "explanation and human-review path"),
  R("sla-10bd", "3.8 timer table ESC_WAIVER_DECISION_SLA_10BD", "data_range", "business_days_after_request", "decided within 10 business days", { range: { max: 10 } }),
];
const WAIVER_DECISION_SAMPLE: Record<string, unknown> = { requested_on: "2027-03-02", decision: "denied", approved: false, effective_on: null, reasons: ["your loan balance of $240,000.00 is not below 80% of the original property value of $300,000.00 (higher-priced mortgage loan rule)"], re_request_on: "2027-06-01", ai_explanation: "An automated rule check contributed to this decision; a person reviewed it.", business_days_after_request: 7, servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

const WAIVER_REVOCATION_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}On {{date advanced_on}} we advanced {{money advance_cents}} to pay your {{item}}, which was unpaid at its penalty date. Under your loan documents your escrow waiver is revoked as of {{date revoked_on}} and an escrow account has been established. Your new monthly escrow payment is {{money new_escrow_payment_cents}}, which includes {{money deficiency_installment_cents}} per month toward the advance over {{months}} months at no interest. An initial escrow account statement will follow within 45 days.{{/block}}
${CONTACT}`;
const WAIVER_REVOCATION_RULES: ContentRule[] = [R("reason", "3.8 rule 5", "presence", "unpaid at its penalty date", "reason for revocation"), R("new-payment", "3.8 outputs", "presence", "new monthly escrow payment is \\$[\\d,]+\\.\\d{2}", "new escrow payment"), R("initial-statement", "§1024.17(g)", "presence", "initial escrow account statement will follow within 45 days", "initial statement to follow"), R("no-interest", "3.6 rule 6", "presence", "at no interest", "no interest on the deficiency"), R("months-12", "§1024.17(f)(4)", "data_range", "months", "≥ 12 months", { range: { min: 12 } })];
const WAIVER_REVOCATION_SAMPLE: Record<string, unknown> = { advanced_on: "2027-12-11", advance_cents: 252_000n, item: "county tax", revoked_on: "2027-12-11", new_escrow_payment_cents: 41_000n, deficiency_installment_cents: 21_000n, months: 12, servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

const MN_DISCONTINUE_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}Under Minnesota Statutes section 47.20, subdivision 9, because your mortgage dated {{date mortgage_date}} reached its fifth anniversary on {{date anniversary}}, you may elect to discontinue your escrow account for taxes and insurance if you have not been more than 30 days late on any payment in the last 12 months. To elect, write to us at {{exclusive_address}}. If you elect, you become responsible for paying taxes and insurance directly.{{/block}}
${CONTACT}`;
const MN_DISCONTINUE_RULES: ContentRule[] = [R("statute", "Minn. Stat. 47.20 subd. 9", "presence", "Minnesota Statutes section 47.20, subdivision 9", "statutory basis"), R("anniversary", "Minn. Stat. 47.20 subd. 9", "presence", "fifth anniversary on", "anniversary date"), R("election", "Minn. Stat. 47.20 subd. 9", "presence", "To elect, write to us", "election procedure"), R("timing-60", "3.8 timer table STATE_MN_47_20_DISCONTINUE_NOTICE_60", "data_range", "days_after_anniversary", "within 60 days of the anniversary", { range: { max: 60 } })];
const MN_DISCONTINUE_SAMPLE: Record<string, unknown> = { mortgage_date: "2022-03-15", anniversary: "2027-03-15", days_after_anniversary: 20, servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

export const SECTION_03_VERSIONS: readonly VersionInput[] = [
  V("NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT", ANNUAL_SOURCE, ANNUAL_RULES, ANNUAL_SAMPLE, "regx.escrow.2014", "3.3 worked example"),
  V("NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR", SHORT_YEAR_SOURCE("transfer"), SHORT_YEAR_RULES("transfer"), SHORT_YEAR_SAMPLE("transfer"), "regx.escrow.2014", "§1024.17(i)(4)(i)"),
  V("NTC_REGX_1024_17I4_SHORT_YEAR_RESET", SHORT_YEAR_SOURCE("reset"), SHORT_YEAR_RULES("reset"), SHORT_YEAR_SAMPLE("reset"), "regx.escrow.2014", "§1024.17(i)(4)(iii)"),
  V("NTC_REGX_1024_17I_POST_EXEMPTION_HISTORY", POST_EXEMPTION_SOURCE, POST_EXEMPTION_RULES, POST_EXEMPTION_SAMPLE, "regx.escrow.2014", "§1024.17(i)(2)"),
  V("NTC_REGX_1024_17F_SHORTAGE", SHORTAGE_SOURCE, SHORTAGE_RULES, SHORTAGE_SAMPLE, "regx.escrow.2014", "§1024.17(f)(5)"),
  V("NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT", LUMPSUM_INSERT_SOURCE, LUMPSUM_INSERT_RULES, LUMPSUM_INSERT_SAMPLE, "sm.escrow.policy", "CFPB escrow FAQ"),
  V("NTC_SM_ESCROW_SURPLUS_REFUND", SURPLUS_SOURCE, SURPLUS_RULES, SURPLUS_SAMPLE, "sm.escrow.policy", "3.5 worked example (a)"),
  V("NTC_SM_ESCROW_ADVANCE", ADVANCE_SOURCE, ADVANCE_RULES, ADVANCE_SAMPLE, "sm.escrow.policy", "3.6 outputs"),
  V("NTC_SM_ESCROW_HAZARD_ADVANCE", HAZARD_ADVANCE_SOURCE, HAZARD_ADVANCE_RULES, HAZARD_ADVANCE_SAMPLE, "sm.escrow.policy", "3.7 outputs"),
  V("NTC_SM_NONESCROW_TAX_DELINQUENCY", NONESCROW_SOURCE, NONESCROW_RULES, NONESCROW_SAMPLE, "sm.escrow.policy", "3.7 rule 9"),
  V("NTC_IL_765_910_15_TAX_PAID", IL_TAX_PAID_SOURCE, IL_TAX_PAID_RULES, IL_TAX_PAID_SAMPLE, "state.il.escrow", "765 ILCS 910/15"),
  V("NTC_SM_ESCROW_WAIVER_DECISION", WAIVER_DECISION_SOURCE, WAIVER_DECISION_RULES, WAIVER_DECISION_SAMPLE, "sm.escrow.policy", "3.8 worked example"),
  V("NTC_SM_ESCROW_WAIVER_REVOCATION", WAIVER_REVOCATION_SOURCE, WAIVER_REVOCATION_RULES, WAIVER_REVOCATION_SAMPLE, "sm.escrow.policy", "3.8 revocation example"),
  V("NTC_MN_47_20_9_DISCONTINUE_RIGHT", MN_DISCONTINUE_SOURCE, MN_DISCONTINUE_RULES, MN_DISCONTINUE_SAMPLE, "state.mn.escrow", "Minn. Stat. 47.20 subd. 9"),
];
