/**
 * §17.2 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section17.ts.
 *
 * Two artifacts are 17.2's own: the corrective notice after a transfer is cancelled or its date
 * moves once the goodbye notice has been mailed (§1024.33(b); policy +5 servicer BD), and the
 * §1024.33(c)(2)(ii) "proper recipient" letter that travels with a misdirected payment returned
 * to the payor instead of forwarded. The goodbye/combined MS-2 notices are 1.3's rows (issued here
 * by Supermortgage as transferor) and the short-year statement is 3.3's row. Channel: mail always;
 * an electronic courtesy copy to consented borrowers never substitutes for the mailed compliance copy.
 * `mail_only` is the registry's channel policy that keeps the mailed copy unconditional (channel.ts:
 * `esign_or_mail` would deliver electronically instead of mailing to a consented borrower); the
 * courtesy e-copy (17.2 decision 4) is a delivery extra outside the registry's channel decision and
 * is disclosed on the notice (`courtesy_electronic_copy`), never a substitute channel.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}";
const DATE_RULE = R("date", "notice date", "presence", MONTH, "date of the notice");
const NO_THREAT = R("no-threat", "12 CFR 1006.18; state UDAP", "absence", "(arrest|garnish|we will sue you|late fee will be charged)", "no threats, no late-fee threat");
const BASE = { notice_date: "2026-11-30", account_last4: "1234", borrower_name: "A. Borrower", property_address: "1 Test St, Testville TX 75001", transferor_name: "Supermortgage", transferor_tollfree: "(800) 555-0100", transferor_address: "PO Box 1, Testville TX 75001", transferor_remittance_address: "PO Box 7, Testville TX 75001", hours: "Monday to Friday 8 a.m. to 8 p.m. Eastern", transferee_name: "Newco Servicing LLC", transferee_tollfree: "(800) 555-0200", transferee_remittance_address: "PO Box 500, Newtown PA 19001", master_servicer_name: "Partner Bank" };
const HEAD = (title: string) => `{{#block "heading" page=1 y=0.05 pt=14 bold}}${title}{{/block}}\n{{#block "ref" page=1 y=0.1 pt=11}}{{date notice_date}}. {{borrower_name}}, loan number ending {{account_last4}}. Property: {{property_address}}.{{/block}}`;

// ------------------------------------------------------------------ NTC_REGX_1024_33B_CORRECTIVE (cancellation / date change after mailing)
const CORRECTIVE = `${HEAD("CORRECTION TO YOUR NOTICE OF SERVICING TRANSFER")}
{{#block "prior" page=1 y=0.16 pt=11}}On {{date prior_notice_date}} we sent you a Notice of Servicing Transfer stating that the servicing of your mortgage loan would transfer from {{transferor_name}} to {{transferee_name}} effective {{date original_effective_date}}. Please disregard that notice: {{#if cancelled}}the transfer has been cancelled.{{else}}the effective date of the transfer has changed.{{/if}}{{/block}}
{{#block "cancelled" page=1 y=0.26 pt=11}}{{#if cancelled}}{{transferor_name}} will continue to service your loan. Continue to send your payments to {{transferor_name}} at {{transferor_remittance_address}}. {{#if drafts_cancelled}}Because the transfer had been scheduled, your automatic payment drafts for payments due on or after {{date original_effective_date}} were cancelled in preparation for the transfer. Please make those payments directly to {{transferor_name}} until we confirm to you in writing that your automatic drafts have been restored.{{else}}Any automatic payment drafts you have with us continue unchanged, and you do not need to do anything.{{/if}} If you already sent a payment to {{transferee_name}}, it will be forwarded to us and credited as of the date it was received.{{/if}}{{/block}}
{{#block "rescheduled" page=1 y=0.36 pt=11}}{{#if date_changed}}The transfer of servicing to {{transferee_name}} is now expected to be effective {{date new_effective_date}}. Until then, continue to send your payments to {{transferor_name}} at {{transferor_remittance_address}}. We will send you a new Notice of Servicing Transfer not less than 15 days before the new effective date; it will restate the date {{transferor_name}} will stop accepting payments and the date {{transferee_name}} will begin accepting payments.{{/if}}{{/block}}
{{#block "terms" page=1 y=0.5 pt=11}}This correction does not affect any term or condition of the mortgage documents, other than terms directly related to the servicing of your loan.{{/block}}
{{#block "contact" page=1 y=0.6 pt=11}}Questions? Contact {{transferor_name}} at {{transferor_tollfree}} (toll-free), {{transferor_address}}, {{hours}}.{{#if date_changed}} You may also contact {{transferee_name}} at {{transferee_tollfree}} (toll-free).{{/if}}{{/block}}
{{#block "body" page=1 y=0.75 pt=11}}{{#if master_servicer_name}}{{transferor_name}} services this loan as subservicer for {{master_servicer_name}}.{{/if}} {{#if courtesy_electronic_copy}}A courtesy copy of this notice was also delivered electronically; this mailed copy is the official notice.{{/if}}{{/block}}`;
const CORRECTIVE_RULES: ContentRule[] = [
  DATE_RULE,
  R("prior-notice", "§1024.33(b); 17.2 edge case 'transfer cancelled or date moved after mailing'", "presence", `On ${MONTH} we sent you a Notice of Servicing Transfer`, "identifies the goodbye notice being corrected"),
  R("after-mailing", "17.2 timer SM_XFER_OUT_CORRECTIVE_NOTICE_5: 'after goodbye mailed'", "data_equality", "goodbye_mailed", "a corrective notice follows a mailed goodbye notice", { predicate: { "==": [{ var: "goodbye_mailed" }, true] } }),
  R("disregard", "17.2 edge case", "presence", "Please disregard that notice", "instructs the borrower to disregard the superseded notice"),
  R("outcome", "17.2 edge case: cancellation or date change", "presence", "(the transfer has been cancelled|the effective date of the transfer has changed)", "states cancellation or new date"),
  R("one-outcome", "17.2 edge case", "data_equality", "cancelled", "exactly one of cancelled / date_changed", { predicate: { "!=": [{ var: "cancelled" }, { var: "date_changed" }] } }),
  R("payment-direction", "§1024.33(b)(4)(iv): where to send payments", "presence", "continue to send your payments to .* at ", "tells the borrower where payments go now"),
  R("new-date", "17.2 edge case: 'new goodbye ≥15 days before any new date'", "conditional", "new_effective_date", "a date change names the new effective date", { when: { "==": [{ var: "date_changed" }, true] }, predicate: { present: "new_effective_date" } }),
  R("new-goodbye-15", "§1024.33(b)(3)(i); 17.2 edge case: 'a new goodbye ≥15 days before any new date'", "conditional", "new_goodbye_days_before_effective", "the new goodbye notice is due ≥15 days before the new date", { when: { "==": [{ var: "date_changed" }, true] }, predicate: { ">=": [{ var: "new_goodbye_days_before_effective" }, 15] } }),
  R("new-notice-promise", "§1024.33(b)(3)(i)", "presence", "a new Notice of Servicing Transfer not less than 15 days before the new effective date", "promises the new notice ≥15 days before the new date", { when: { "==": [{ var: "date_changed" }, true] } }),
  R("drafts-cancelled-status", "17.2 autodraft rule: 'scheduled debits with settlement ≥ T are cancelled at T-3 BD' — a cancellation on/after T−3 BD must not tell the borrower the drafts continue unchanged", "presence", "automatic payment drafts for payments due on or after .* were cancelled in preparation for the transfer", "tells the borrower the drafts were cancelled and how to pay meanwhile", { when: { and: [{ "==": [{ var: "cancelled" }, true] }, { "==": [{ var: "drafts_cancelled" }, true] }] } }),
  R("drafts-unchanged-status", "17.2 autodraft rule: before T−3 BD the drafts were never cancelled", "presence", "automatic payment drafts you have with us continue unchanged", "tells the borrower the drafts continue", { when: { and: [{ "==": [{ var: "cancelled" }, true] }, { "!": [{ "==": [{ var: "drafts_cancelled" }, true] }] }] } }),
  R("drafts-no-contradiction", "17.2 autodraft rule", "absence", "continue unchanged.*were cancelled in preparation|were cancelled in preparation.*continue unchanged", "never both draft statements"),
  R("timely", "17.2 timer SM_XFER_OUT_CORRECTIVE_NOTICE_5: +5 business_days_servicer (policy)", "data_range", "business_days_since_event", "mailed within 5 servicer business days of the cancellation / date change", { range: { min: 0, max: 5 } }),
  R("transferor-tollfree", "§1024.33(b)(4)(iii)", "presence", "Contact .* at \\(\\d{3}\\) \\d{3}-\\d{4} \\(toll-free\\)", "Supermortgage toll-free number"),
  R("terms", "§1024.33(b)(4)(vi)", "presence", "does not affect any term or condition of the mortgage documents", "terms-unchanged statement"),
  R("heading", "17.2 notice content", "layout", "heading", "correction heading prominent on page 1", { layout: { page: 1, bold: true, minPt: 12 } }),
  NO_THREAT,
];
// Cancelled Fri Nov 20 for T = Dec 1: the T−3 BD autodraft cancellation (Nov 25) has not run yet, so the drafts are unchanged.
const CORRECTIVE_SAMPLE = { ...BASE, prior_notice_date: "2026-11-16", original_effective_date: "2026-12-01", cancelled: true, date_changed: false, event: "transfer_cancelled", event_date: "2026-11-20", business_days_since_event: 5, goodbye_mailed: true, drafts_cancelled: false, new_effective_date: null, new_goodbye_days_before_effective: null, courtesy_electronic_copy: false };

// ------------------------------------------------------------------ NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN (§1024.33(c)(2)(ii) proper-recipient notice)
const RETURN = `${HEAD("YOUR PAYMENT IS BEING RETURNED — WHERE TO SEND IT")}
{{#block "receipt" page=1 y=0.16 pt=11}}On {{date received_on}} {{transferor_name}} received your {{instrument_label}} of {{money amount_cents}} for the mortgage loan ending {{account_last4}}. The servicing of this loan transferred to {{transferee_name}} effective {{date effective_date}}, and {{transferor_name}} stopped accepting payments after {{date transferor_stop_date}}.{{/block}}
{{#block "return" page=1 y=0.28 pt=11}}We are returning this payment to you with this letter rather than forwarding it because {{return_reason}}. Federal law requires us either to transfer your payment to the new servicer or to return it to you and tell you the proper recipient (12 CFR 1024.33(c)(2)).{{/block}}
{{#block "recipient" page=1 y=0.38 pt=12 bold}}The proper recipient of your payment is {{transferee_name}}. Send your payment to {{transferee_name}} at {{transferee_remittance_address}}. Questions about your account: {{transferee_name}}, {{transferee_tollfree}} (toll-free).{{/block}}
{{#block "protection" page=1 y=0.52 pt=11}}{{#if protected}}Because {{transferor_name}} received your payment on {{date received_on}}, on or before its due date including any grace period and during the 60-day period following the effective date of the transfer, it may not be treated by {{transferee_name}} as late for any purpose, and no late fee may be imposed on you for it. We have notified {{transferee_name}} of the date we received it.{{else}}We have notified {{transferee_name}} that we received this payment on {{date received_on}}. Please send your replacement payment to {{transferee_name}} promptly.{{/if}}{{/block}}
{{#block "contact" page=1 y=0.7 pt=11}}Questions for {{transferor_name}}: {{transferor_tollfree}} (toll-free), {{transferor_address}}, {{hours}}.{{/block}}
{{#block "body" page=1 y=0.8 pt=11}}Property: {{property_address}}. {{#if master_servicer_name}}{{transferor_name}} serviced this loan as subservicer for {{master_servicer_name}}.{{/if}}{{/block}}`;
const RETURN_RULES: ContentRule[] = [
  DATE_RULE,
  R("receipt", "§1024.33(c)(2); 17.2 rule: the receipt date travels with the funds", "presence", `On ${MONTH} \\S+ received your \\w+ of \\$[\\d,]+\\.\\d{2}`, "receipt date, instrument and amount"),
  R("c2-return-reason", "17.2 decision 2: return only when the instrument cannot be negotiated or forwarded", "presence", "rather than forwarding it because \\S", "states why the payment is returned rather than forwarded"),
  R("c2-proper-recipient", "§1024.33(c)(2)(ii): 'notify such person of the proper recipient of the payment'", "presence", "The proper recipient of your payment is [A-Za-z0-9]", "names the transferee as the proper recipient"),
  R("transferee-named", "§1024.33(c)(2)(ii); 17.2-T6", "data_equality", "transferee_name", "transferee name present", { predicate: { present: "transferee_name" } }),
  R("transferee-remittance", "§1024.33(b)(4)(ii); 17.2 data model transferee_remittance_address", "presence", "Send your payment to .+ at .+\\. Questions", "transferee remittance address"),
  R("transferee-tollfree", "§1024.33(b)(4)(ii)", "presence", "Questions about your account: .*\\(\\d{3}\\) \\d{3}-\\d{4} \\(toll-free\\)", "transferee toll-free number"),
  R("disposition", "17.2 state machine: returned (instrument returned + notice)", "data_equality", "disposition", "disposition is returned_to_payor", { predicate: { "==": [{ var: "disposition" }, "returned_to_payor"] } }),
  R("officer-decision", "17.2 escalations: officer for any decision to return rather than forward", "data_equality", "officer_approval_decision_id", "officer decision recorded", { predicate: { present: "officer_approval_decision_id" } }),
  R("promptly", "§1024.33(c)(2) 'promptly'; SM_1024_33C2_FORWARD_PROMPT_1 (+1 business_days_servicer)", "data_range", "business_days_since_receipt", "returned within 1 servicer business day of receipt", { range: { min: 0, max: 1 } }),
  R("c1-protection", "§1024.33(c)(1); comment 33(c)(1)-1", "presence", "may not be treated by .* as late for any purpose, and no late fee may be imposed", "60-day protection statement when the payment is protected", { when: { "==": [{ var: "protected" }, true] } }),
  R("transferee-notified", "§1024.33(c)(2); 17.2 rule: 'the receipt date travels with the funds'", "presence", "We have notified .* (of the date we received it|that we received this payment)", "transferee told of the receipt date"),
  R("recipient-prominent", "§1024.33(c)(2)(ii)", "layout", "recipient", "proper-recipient block prominent on page 1", { layout: { page: 1, bold: true, minPt: 12 } }),
  NO_THREAT,
];
const RETURN_SAMPLE = { ...BASE, notice_date: "2026-12-15", received_on: "2026-12-14", amount_cents: 161_603n, instrument_label: "check", effective_date: "2026-12-01", transferor_stop_date: "2026-11-30", return_reason: "the check is stale-dated and cannot be negotiated or forwarded", protected: true, disposition: "returned_to_payor", officer_approval_decision_id: "dec-17.2-return-P-9", business_days_since_receipt: 1 };

export const VERSIONS_17_2: VersionInput[] = [
  V("NTC_REGX_1024_33B_CORRECTIVE", CORRECTIVE, CORRECTIVE_RULES, CORRECTIVE_SAMPLE, "regx.servicing_transfer.2014", "§1024.33(b) corrective notice after cancellation / date change; 17.2-T10"),
  V("NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN", RETURN, RETURN_RULES, RETURN_SAMPLE, "regx.servicing_transfer.2014", "§1024.33(c)(2)(ii) proper-recipient notice; 17.2-T6"),
];
export const OVERRIDES_17_2: Record<string, Partial<NoticeTemplate>> = {
  NTC_REGX_1024_33B_CORRECTIVE: { channelPolicy: "mail_only", citation: "12 CFR 1024.33(b)(3)–(4); 17.2 outputs: 'channel: mail always' and decision 4: 'mail remains the compliance copy' — mail_only keeps the mailed copy unconditional; the courtesy e-copy to esign-consented borrowers is an extra outside the registry's channel decision", retention: "respa_5y", separateDocument: true },
  NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN: { channelPolicy: "mail_only", citation: "12 CFR 1024.33(c)(2)(ii); 17.2 outputs: 'channel: mail always' — the notice travels with the returned instrument", retention: "respa_5y", separateDocument: true },
};
