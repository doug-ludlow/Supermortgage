/**
 * §16.1 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section16.ts.
 *
 * `NTC_FNMA_NIB_BALANCE_NOTICE` — Fannie Mae Servicing Guide A4-2.1-07 "Borrower Notification of
 * Non-Interest-Bearing Balance" (or its equivalent): sent "as early as 180 days but no later than 150 days prior to
 * the maturity date or the projected date of payoff" (the anchor is whichever comes first — `anchor_date` /
 * `anchor_kind` from `nibNoticePayload`), and — if no contact — "as early as 75 days but no later than 60 days
 * before the maturity date". Deferred and forborne principal are non-interest-bearing and due at
 * maturity/sale/refinance/payoff (D2-3.2-04; F-1-27); an unaffordable balloon goes to SF CPM.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}";
const BASE = { notice_date: "2026-12-03", account_last4: "1234", borrower_name: "A. Borrower", property_address: "1 Test St, Testville OH 43001", servicer_name: "Supermortgage", servicer_address: "PO Box 1, Testville TX 75001", team_phone: "(800) 555-0199", team_name: "Payoff and Lien Release Team", toll_free: "(800) 555-0100", website: "portal.example.com/help", hud_phone: "(800) 569-4287", cfpb_counselor_url: "consumerfinance.gov/find-a-housing-counselor" };
const CONTACT = `{{#block "contact" page=1 y=0.85 pt=11}}Contact: {{team_name}}, {{team_phone}} (toll-free {{toll_free}}), {{servicer_address}}, {{website}}. Free housing counseling: HUD {{hud_phone}} · {{cfpb_counselor_url}}.{{/block}}`;
const CONTACT_RULE = R("contact", "12 CFR 1024.40(a); A4-2.1-07 'attempt to contact the borrower'", "presence", "Contact: .*\\(\\d{3}\\) \\d{3}-\\d{4}", "contact block with a telephone number");
const HUD_RULE = R("hud", "counseling referral", "presence", "HUD \\(\\d{3}\\) \\d{3}-\\d{4}", "HUD counseling line");
const NO_THREAT = R("no-threat", "12 CFR 1006.18; state UDAP", "absence", "(arrest|garnish|we will sue you tomorrow|foreclose immediately)", "no threats");

// ------------------------------------------------------------------ 16.1 A4-2.1-07 NIB balance notice
const NIB_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}{{#if second_notice}}Second notice: {{/if}}Notice of the non-interest-bearing balance on your mortgage loan{{/block}}
{{#block "ref" page=1 y=0.1 pt=11}}{{date notice_date}}. {{borrower_name}}, loan number ending {{account_last4}}. Property: {{property_address}}.{{/block}}
{{#block "body" page=1 y=0.17 pt=11}}Your mortgage loan has a non-interest-bearing balance of {{money nib_balance_cents}} ({{nib_description}}). This balance does not accrue interest and is not part of your monthly payment, but it is due and payable in full on the earliest of the maturity date of your loan, {{date maturity_date}}, the date you sell or transfer the property, the date you refinance, or the date you pay off the loan.{{#if projected_payoff_date}} Based on the payoff you have told us you expect, the projected date of payoff of your loan is {{date projected_payoff_date}}, and the balance will be due then.{{/if}} Your interest-bearing unpaid principal balance is {{money ib_upb_cents}}; the total principal you would owe at maturity, before interest and other charges, is {{money total_due_at_maturity_cents}}.{{#if second_notice}} This is our second notice; we have not been able to reach you about this balance since our first notice.{{/if}}{{/block}}
{{#block "options" page=1 y=0.45 pt=11}}If you do not expect to be able to pay this balance when it is due, please contact us at {{team_phone}} as soon as possible. Options may be available to you, including a repayment arrangement, a loan modification or other loss mitigation assistance, and you may request a written payoff statement at any time. Paying this balance early does not change your monthly payment.{{/block}}
{{#block "basis" page=1 y=0.65 pt=10}}This notice is sent {{days_before_anchor}} days before {{anchor_description}} as Fannie Mae's Servicing Guide (A4-2.1-07) requires for loans with an outstanding non-interest-bearing balance. It is not a bill and it is not a notice of default.{{/block}}
${CONTACT}`;
const NIB_RULES: ContentRule[] = [
  R("date", "notice date", "presence", MONTH, "date of the notice"),
  R("nib-amount", "A4-2.1-07; D2-3.2-04", "presence", "non-interest-bearing balance of \\$[\\d,]+\\.\\d{2}", "the NIB balance amount"),
  R("no-interest", "D2-3.2-04 / F-1-27 §3.8–3.9: deferred and forborne principal are non-interest-bearing", "presence", "does not accrue interest and is not part of your monthly payment", "non-interest-bearing statement"),
  R("due-events", "D2-3.2-04: due at maturity/sale/refinance/payoff", "presence", `due and payable in full on the earliest of the maturity date of your loan, ${MONTH}, the date you sell or transfer the property, the date you refinance, or the date you pay off the loan`, "maturity date and the due-in-full events"),
  R("ib-and-total", "A4-2.1-07", "presence", "interest-bearing unpaid principal balance is \\$[\\d,]+\\.\\d{2}; the total principal you would owe at maturity, before interest and other charges, is \\$[\\d,]+\\.\\d{2}", "interest-bearing balance and total at maturity"),
  R("options", "A4-2.1-07: unaffordable balance → contact / SF CPM options", "presence", "please contact us at \\(\\d{3}\\) \\d{3}-\\d{4} as soon as possible\\. Options may be available", "contact and options paragraph"),
  R("payoff-statement", "16.1 rule 11; §1026.36(c)(3)", "presence", "request a written payoff statement at any time", "written payoff statement offer"),
  R("basis", "A4-2.1-07 timing rows", "presence", "sent \\d+ days before (your maturity date|the projected date of payoff of your loan, " + MONTH + ") as Fannie Mae's Servicing Guide \\(A4-2\\.1-07\\) requires", "timing basis names the anchor (maturity or projected payoff)"),
  R("not-a-default", "A4-2.1-07; 12 CFR 1006.18", "presence", "not a bill and it is not a notice of default", "not a default notice"),
  R("nib-positive", "A4-2.1-07 applies only with an outstanding NIB balance", "data_range", "nib_balance_cents", "NIB balance > 0", { range: { min: 1 } }),
  R("anchor-kind", "A4-2.1-07: 'prior to the maturity date or the projected date of payoff'", "data_equality", "anchor_kind", "anchor is the maturity date or the projected date of payoff", { predicate: { in: [{ var: "anchor_kind" }, ["maturity", "projected_payoff"]] } }),
  R("projected-payoff-date", "A4-2.1-07: a projected-payoff anchor names the projected date", "conditional", "anchor_kind", "projected payoff anchor carries the projected payoff date", { when: { "==": [{ var: "anchor_kind" }, "projected_payoff"] }, predicate: { and: [{ present: "projected_payoff_date" }, { "==": [{ var: "sequence" }, "first"] }] } }),
  R("window-first", "A4-2.1-07: 'as early as 180 days but no later than 150 days prior to the maturity date or the projected date of payoff'", "data_range", "days_before_anchor", "first notice 150–180 days before the maturity date or the projected date of payoff", { when: { "==": [{ var: "sequence" }, "first"] }, range: { min: 150, max: 180 } }),
  R("window-second", "A4-2.1-07: 'as early as 75 days but no later than 60 days before the maturity date'", "data_range", "days_before_maturity", "second notice 60–75 days before maturity", { when: { "==": [{ var: "sequence" }, "second"] }, range: { min: 60, max: 75 } }),
  R("second-anchor", "A4-2.1-07: the second window runs to the maturity date, not the projected payoff", "conditional", "sequence", "second notice is anchored on the maturity date", { when: { "==": [{ var: "sequence" }, "second"] }, predicate: { "==": [{ var: "anchor_kind" }, "maturity"] } }),
  R("second-legend", "A4-2.1-07: second notice only if no contact after the first", "conditional", "sequence", "second notice carries the second-notice legend", { when: { "==": [{ var: "sequence" }, "second"] }, predicate: { "==": [{ var: "second_notice" }, true] } }),
  R("sequence", "A4-2.1-07 timing rows", "data_equality", "sequence", "sequence is first or second", { predicate: { in: [{ var: "sequence" }, ["first", "second"]] } }),
  R("heading-bold", "readability", "layout", "heading", "bold heading on page 1", { layout: { page: 1, bold: true, minPt: 14 } }),
  CONTACT_RULE, HUD_RULE, NO_THREAT,
];
/** Worked example B loan: NIB $12,000.00 over IB UPB $180,000.00, maturing 06/01/2027; first notice 12/03/2026 (180 days before maturity, no projected payoff). */
const NIB_SAMPLE = { ...BASE, notice_date: "2026-12-03", maturity_date: "2027-06-01", projected_payoff_date: null, anchor_date: "2027-06-01", anchor_kind: "maturity", anchor_description: "your maturity date", nib_balance_cents: 1_200_000n, ib_upb_cents: 18_000_000n, total_due_at_maturity_cents: 19_200_000n, days_before_maturity: 180, days_before_anchor: 180, sequence: "first", second_notice: false, nib_description: "deferred principal from a payment deferral, D2-3.2-04" };

export const VERSIONS_16_1: VersionInput[] = [
  V("NTC_FNMA_NIB_BALANCE_NOTICE", NIB_SOURCE, NIB_RULES, NIB_SAMPLE, "fnma.a4-2.1-07.2023", "A4-2.1-07 Borrower Notification of Non-Interest-Bearing Balance (equivalent); 16.1-T14"),
];
export const OVERRIDES_16_1: Record<string, Partial<NoticeTemplate>> = {
  NTC_FNMA_NIB_BALANCE_NOTICE: { citation: "Fannie Mae Servicing Guide A4-2.1-07 (10/11/2023); D2-3.2-04; F-1-27 §3.8–3.9", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: [] },
};
