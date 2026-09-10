/**
 * §16.2 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section16.ts.
 * Three policy letters the spec's Outputs name: the paid-in-full letter (payoff date, amounts applied,
 * escrow refund timing §1024.34(b)(1), short-year statement §1024.17(i)(4)(ii), release/recording timing
 * per `jurisdiction_rules.release`, MI/insurance/tax next steps, 1098 timing, contact for the recorded
 * release); the shortage demand (exact shortfall, per diem if applicable, deadline, consequences; never
 * more than a reliance-protected figure); and the overage refund advice (with the refund, within 10 BD,
 * never applied to fees). Channel: mail or e-delivery with consent.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const DATE_RULE = R("date", "notice date", "presence", "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "date of the notice");
const CONTACT_RULE = R("contact", "12 CFR 1024.40(a); 16.2 outputs (contact for the recorded release)", "presence", "Contact: .*\\(\\d{3}\\) \\d{3}-\\d{4}", "contact block with a telephone number");
const NO_THREAT = R("no-threat", "12 CFR 1006.18; state UDAP", "absence", "(arrest|garnish|we will sue you tomorrow)", "no threats");
const BASE = { notice_date: "2026-10-19", account_last4: "1187", borrower_name: "A. Borrower", property_address: "1 Test St, Columbus OH 43215", servicer_name: "Supermortgage", servicer_address: "PO Box 1, Testville TX 75001", team_phone: "(800) 555-0199", team_name: "Payoff & Lien Release Team", toll_free: "(800) 555-0100", website: "portal.example.com/help" };
const HEAD = (title: string) => `{{#block "heading" page=1 y=0.05 pt=14 bold}}${title}{{/block}}\n{{#block "ref" page=1 y=0.1 pt=11}}{{date notice_date}}. {{borrower_name}}, loan number ending {{account_last4}}. Property: {{property_address}}.{{/block}}`;
const CONTACT = `{{#block "contact" page=1 y=0.85 pt=11}}Contact: {{team_name}}, {{team_phone}} (toll-free {{toll_free}}), {{servicer_address}}, {{website}}.{{/block}}`;

// ------------------------------------------------------------------ NTC_PAYOFF_PAID_IN_FULL
const PIF = `${HEAD("Your mortgage loan has been paid in full")}
{{#block "applied" page=1 y=0.18 pt=11}}We received {{money amount_received_cents}} on {{date payoff_date}} and applied it as follows: {{#each applied}}{{label}} {{money cents}}; {{/each}}total {{money amount_applied_cents}}. Your loan balance is now {{money balance_after_cents}} and your loan is paid in full as of {{date payoff_date}}.{{/block}}
{{#block "escrow" page=1 y=0.32 pt=11}}{{#if escrowed}}Escrow account: your remaining escrow balance of {{money escrow_refund_cents}} will be refunded within 20 business days of the payoff date as required by 12 CFR 1024.34(b)(1), no later than {{date escrow_refund_by}}. A short-year escrow account statement will follow within 60 days of the payoff (12 CFR 1024.17(i)(4)(ii)), no later than {{date short_year_statement_by}}.{{else}}Escrow account: none was maintained on this loan; no escrow refund is due.{{/if}}{{/block}}
{{#block "release" page=1 y=0.46 pt=11}}Lien release: we will prepare, execute and record the release (satisfaction) of the mortgage with the {{release_county}} County recorder within {{release_days}} days of payoff as required by {{release_cite}}, no later than {{date release_by}}. You will receive a copy of the recorded release; there is no charge to you unless the recording fee was disclosed on your payoff statement.{{/block}}
{{#block "next_steps" page=1 y=0.6 pt=11}}Next steps: {{#if mi_active}}your mortgage insurance ended with the payoff and any unearned premium will be refunded to you (Homeowners Protection Act). {{/if}}We have asked your property insurance carrier to remove {{mortgagee_name}} as mortgagee; you may also tell your agent. We have notified the taxing authorities that future tax bills should be sent to you. {{#if autodraft}}Your automatic payment authorization was terminated on {{date payoff_date}}; any debit that still occurs will be refunded within 10 business days. {{/if}}Form 1098: interest of {{money interest_1098_cents}} paid in {{tax_year}} will be reported on your Form 1098, mailed by January 31, {{tax_year_next}}.{{/block}}
${CONTACT}`;
const PIF_RULES = [DATE_RULE, CONTACT_RULE, NO_THREAT,
  R("payoff-date", "16.2 outputs: payoff date", "presence", "paid in full as of (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "payoff date stated"),
  R("zero-balance", "16.2 rule 3: every loan account reads zero afterwards", "data_equality", "balance_after_cents", "the loan balance after application is zero", { predicate: { "==": [{ var: "balance_after_cents" }, 0] } }),
  R("zero-balance-text", "16.2 rule 3", "presence", "balance is now \\$0\\.00", "zero balance stated"),
  R("applied-equals-received", "16.2 rule 3: amounts applied reconcile to the funds received (less any overage refunded separately)", "data_equality", "amount_applied_cents", "applied ≤ received", { predicate: { "<=": [{ var: "amount_applied_cents" }, { var: "amount_received_cents" }] } }),
  R("amounts-applied", "16.2 outputs: amounts applied", "presence", "applied it as follows: .+\\$[\\d,]+\\.\\d{2}", "application lines"),
  R("escrow-20bd", "12 CFR 1024.34(b)(1)", "conditional", "escrow_refund_by", "escrow refund date within 20 BD when escrowed", { when: { "==": [{ var: "escrowed" }, true] }, predicate: { and: [{ present: "escrow_refund_by" }, { ">": [{ var: "escrow_refund_cents" }, 0] }] } }),
  R("escrow-text", "12 CFR 1024.34(b)(1); 12 CFR 1024.17(i)(4)(ii)", "conditional", "escrowed", "escrow refund and short-year statement timing", { when: { "==": [{ var: "escrowed" }, true] }, predicate: { present: "short_year_statement_by" } }),
  R("release-timing", "16.2 outputs: release/recording timing per jurisdiction_rules.release", "presence", "within \\d+ days of payoff as required by", "release timing and citation"),
  R("release-days", "jurisdiction_rules.release.deadline_days", "data_range", "release_days", "release deadline between 1 and 365 days", { range: { min: 1, max: 365 } }),
  R("form-1098", "C-4.2-01; 26 U.S.C. 6050H", "presence", "Form 1098", "1098 timing"),
  R("form-1098-interest", "C-4.2-01: interest at the note rate collected in the payoff year", "data_equality", "interest_1098_cents", "1098 interest and tax year present", { predicate: { and: [{ ">": [{ var: "interest_1098_cents" }, 0] }, { present: "tax_year" }] } }),
  R("recorded-release-contact", "16.2 outputs: contact for the recorded release", "presence", "copy of the recorded release", "recorded-release contact")];
const PIF_SAMPLE = { ...BASE, payoff_date: "2026-10-16", amount_received_cents: 20_105_147n, applied: [{ label: "Unpaid principal balance", cents: 19_950_000n }, { label: "Interest at the note rate, September 1 through October 15, 2026", cents: 155_147n }], amount_applied_cents: 20_105_147n, balance_after_cents: 0n, escrowed: true, escrow_refund_cents: 241_290n, escrow_refund_by: "2026-11-16", short_year_statement_by: "2026-12-15", release_county: "Franklin", release_days: 90, release_cite: "Ohio R.C. §5301.36", release_by: "2027-01-14", mi_active: false, mortgagee_name: "Fannie Mae, its successors and assigns", autodraft: true, interest_1098_cents: 155_147n, tax_year: 2026, tax_year_next: 2027 };

// ------------------------------------------------------------------ NTC_PAYOFF_SHORTAGE_DEMAND
const SHORT = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Payoff funds received short of the amount required{{/block}}
{{#block "ref" page=1 y=0.1 pt=11}}{{date notice_date}}. To: {{addressee_name}} ({{addressee_role}}), the party that remitted. Re: {{borrower_name}}, loan number ending {{account_last4}}. Property: {{property_address}}.{{/block}}
{{#block "shortfall" page=1 y=0.18 pt=11}}On {{date received_on}} we received {{money amount_received_cents}} from {{remitter}} toward the payoff of this loan. The amount required to pay the loan in full as of {{date received_on}} was {{money exact_total_cents}}, leaving a shortfall of {{money shortage_cents}}.{{#if per_diem_applies}} Interest continues to accrue at {{money per_diem_cents}} per day until the shortfall is received.{{/if}}{{/block}}
{{#block "deadline" page=1 y=0.34 pt=11}}Please remit the shortfall by {{date cure_by}}. The funds already received ({{money amount_received_cents}}) are being held in a suspense account ({{funds_status}}) and have not been applied to the loan.{{/block}}
{{#block "consequences" page=1 y=0.46 pt=11}}If the shortfall is not received by {{date uncured_on}}, the funds held will be applied to your loan according to the terms of your note (to the installments due and then as a principal curtailment), the loan will remain open, and interest and any escrow payments will continue to be due.{{/block}}
${CONTACT}`;
const SHORT_RULES = [DATE_RULE, CONTACT_RULE, NO_THREAT,
  R("exact-shortfall", "16.2 outputs: exact shortfall", "presence", "shortfall of \\$[\\d,]+\\.\\d{2}", "shortfall amount"),
  R("over-tolerance", "16.2 rule 2: |variance| ≤ $50 is absorbed, never demanded", "data_range", "shortage_cents", "shortfall exceeds the $50 tolerance", { range: { min: 5001 } }),
  R("per-diem", "16.2 outputs: per diem if applicable", "conditional", "per_diem_cents", "per diem stated when interest continues", { when: { "==": [{ var: "per_diem_applies" }, true] }, predicate: { ">": [{ var: "per_diem_cents" }, 0] } }),
  R("deadline", "16.2 timer SM_PAYOFF_SHORTAGE_CURE_5BD", "presence", "remit the shortfall by (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "cure deadline"),
  R("consequences", "16.2 rule 5: uncured at 30 days → applied per the note, loan continues", "presence", "applied to your loan according to the terms of your note", "consequences stated"),
  R("suspense", "16.2 rule 5: funds held in suspense_items{short_payoff}, never applied as a curtailment during the cure window", "data_equality", "funds_status", "funds held in short_payoff suspense", { predicate: { "==": [{ var: "funds_status" }, "short_payoff"] } }),
  R("suspense-text", "16.2 rule 5", "presence", "held in a suspense account", "suspense statement"),
  R("addressee-remitter", "16.2 rule 5: demand within 1 BD to the party that remitted (closing agent/borrower)", "data_equality", "addressee_role", "addressed to the remitting party", { predicate: { and: [{ present: "addressee_name" }, { in: [{ var: "addressee_role" }, ["closing_agent", "borrower", "estate", "successor_in_interest"]] }] } }),
  R("shortfall-figures", "16.2 rule 2: variance = amount − exact_total (the calculator's figures, never the model's)", "data_equality", "exact_total_cents", "exact total and amount received both stated and the amount received below the exact total", { predicate: { and: [{ present: "exact_total_cents" }, { present: "amount_received_cents" }, { "<": [{ var: "amount_received_cents" }, { var: "exact_total_cents" }] }] } }),
  R("uncured-date", "16.2 timer SM_PAYOFF_SHORTAGE_UNCURED_30", "data_equality", "uncured_on", "day-30 application date stated", { predicate: { present: "uncured_on" } }),
  R("no-reliance-demand", "16.2 guardrail: no demand for more than a reliance-protected figure", "data_equality", "reliance_protected", "no demand where the statement figure is reliance-protected", { predicate: { "==": [{ var: "reliance_protected" }, false] } })];
const SHORT_SAMPLE = { ...BASE, addressee_name: "Title Company of Columbus", addressee_role: "closing_agent", received_on: "2026-10-16", amount_received_cents: 20_083_037n, remitter: "Title Company of Columbus (closing agent)", funds_status: "short_payoff", exact_total_cents: 20_105_147n, shortage_cents: 22_110n, per_diem_applies: true, per_diem_cents: 3_416n, cure_by: "2026-10-26", uncured_on: "2026-11-15", state: "OH", reliance_protected: false };

// ------------------------------------------------------------------ NTC_PAYOFF_OVERAGE_REFUND_ADVICE
const OVER = `${HEAD("Refund of payoff overpayment")}
{{#block "overage" page=1 y=0.18 pt=11}}On {{date received_on}} we received {{money amount_received_cents}} toward the payoff of this loan. The amount required to pay the loan in full as of {{date payoff_date}} was {{money exact_total_cents}}, an overpayment of {{money overage_cents}}. Your loan is paid in full as of {{date payoff_date}}.{{/block}}
{{#block "refund" page=1 y=0.34 pt=11}}The enclosed refund of {{money refund_cents}} by {{refund_method}} is payable to {{refund_payee}} and was issued on {{date refund_issued_on}}, {{refund_bd_after_receipt}} business days after receipt (within 10 business days). Overpayments are refunded in full; {{money applied_to_fees_cents}} was applied to fees — they are not applied to any fee.{{/block}}
${CONTACT}`;
const OVER_RULES = [DATE_RULE, CONTACT_RULE, NO_THREAT,
  R("overage", "16.2 rule 2: variance > $1 → overage refund within 10 BD", "presence", "overpayment of \\$[\\d,]+\\.\\d{2}", "overage amount"),
  R("over-tolerance", "16.2 rule 2: over-tolerance $1", "data_range", "overage_cents", "overage exceeds the $1 tolerance", { range: { min: 101 } }),
  R("refund-equals-overage", "16.2 rule 10: refunded in full", "data_equality", "refund_cents", "refund equals the overage", { predicate: { "==": [{ var: "refund_cents" }, { var: "overage_cents" }] } }),
  R("refund-10bd", "16.2 timer SM_OVERPAYMENT_REFUND_10BD: refund within +10 business_days_servicer of receipt", "data_range", "refund_bd_after_receipt", "refund issued within 10 business days of receipt", { range: { min: 0, max: 10 } }),
  R("refund-10bd-text", "16.2 timer SM_OVERPAYMENT_REFUND_10BD", "presence", "within 10 business days", "10-BD statement"),
  R("not-to-fees", "16.2 rule 10: never applied to fees", "data_equality", "applied_to_fees_cents", "nothing applied to fees", { predicate: { "==": [{ var: "applied_to_fees_cents" }, 0] } }),
  R("not-to-fees-text", "16.2 rule 10", "presence", "not applied to any fee", "no fee application")];
const OVER_SAMPLE = { ...BASE, received_on: "2026-10-16", payoff_date: "2026-10-16", amount_received_cents: 20_131_647n, exact_total_cents: 20_105_147n, overage_cents: 26_500n, refund_cents: 26_500n, refund_method: "check", refund_payee: "A. Borrower", refund_issued_on: "2026-10-23", refund_bd_after_receipt: 5, applied_to_fees_cents: 0n };

export const VERSIONS_16_2: VersionInput[] = [
  V("NTC_PAYOFF_PAID_IN_FULL", PIF, PIF_RULES, PIF_SAMPLE, "sm.payoff.2026-09", "16.2 outputs (paid-in-full letter; F-1-09 satisfaction tasks; §1024.34(b)(1); §1024.17(i)(4)(ii))"),
  V("NTC_PAYOFF_SHORTAGE_DEMAND", SHORT, SHORT_RULES, SHORT_SAMPLE, "sm.payoff.2026-09", "16.2 rule 5 / outputs (shortage demand; 16.2-T4 $221.10 in Ohio)"),
  V("NTC_PAYOFF_OVERAGE_REFUND_ADVICE", OVER, OVER_RULES, OVER_SAMPLE, "sm.payoff.2026-09", "16.2 rule 2 / rule 10 (overage refund advice with the refund)"),
];
export const OVERRIDES_16_2: Record<string, Partial<NoticeTemplate>> = {
  NTC_PAYOFF_PAID_IN_FULL: { channelPolicy: "esign_or_mail", citation: "16.2 outputs: mail or e-delivery with consent; F-1-09; 12 CFR 1024.34(b)(1)" },
  NTC_PAYOFF_SHORTAGE_DEMAND: { channelPolicy: "esign_or_mail", citation: "16.2 outputs: mail or e-delivery with consent; shortage demands also by phone/e-mail to the closing agent" },
  NTC_PAYOFF_OVERAGE_REFUND_ADVICE: { channelPolicy: "esign_or_mail", citation: "16.2 outputs: sent with the refund; mail or e-delivery with consent" },
};
