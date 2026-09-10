/**
 * §16.3 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section16.ts.
 *
 * NTC_LIEN_RELEASE_RECORDED — the recorded-release letter (policy; Fla. Stat. §701.04(2) mandatory in FL):
 *   recorded instrument copy, recording reference, statement that the lien is released, MERS deactivation
 *   note, tax/insurance reminders. NTC_NJ_CANCELLATION_RIGHT — N.J.S.A. 46:18-11.2 nonbank notice of the
 *   right to demand cancellation, fee ≤ $25, how to demand. NTC_ENOTE_PAPER_COPY — the F-1-09 letter with
 *   the eNote print marked "Copy" and "Paid-In-Full". NTC_NOTE_RETURNED — cover letter returning the
 *   original note marked "Paid in Full" (NY RPAPL §1921 45 days on request; MD §7-106).
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const DATE_RULE = R("date", "notice date", "presence", "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "date of the notice");
const CONTACT_RULE = R("contact", "12 CFR 1024.40(a); borrower questions route to human_agent", "presence", "Contact: .*\\(\\d{3}\\) \\d{3}-\\d{4}", "contact block with a telephone number");
const NO_PENALTY_CHARGE = R("no-penalty-charge", "F-1-09: penalty never passed to the borrower", "absence", "(late[- ]release penalty|statutory penalty).{0,40}(charged to you|added to your)", "no penalty passed to the borrower");
const BASE = { notice_date: "2026-10-27", account_last4: "4567", borrower_name: "A. Borrower", property_address: "12 Elm St, Columbus OH 43215", servicer_name: "Supermortgage", servicer_address: "PO Box 1, Testville TX 75001", team_phone: "(800) 555-0199", team_name: "Payoff & Lien Release Team", toll_free: "(800) 555-0100", website: "portal.example.com/payoff" };
const HEAD = (title: string) => `{{#block "heading" page=1 y=0.05 pt=14 bold}}${title}{{/block}}\n{{#block "ref" page=1 y=0.1 pt=11}}{{date notice_date}}. {{borrower_name}}, loan number ending {{account_last4}}. Property: {{property_address}}.{{/block}}`;
const CONTACT = `{{#block "contact" page=1 y=0.88 pt=11}}Contact: {{team_name}}, {{team_phone}} (toll-free {{toll_free}}), {{servicer_address}}, {{website}}.{{/block}}`;

// ------------------------------------------------------------------ NTC_LIEN_RELEASE_RECORDED
const LIEN_RELEASE_RECORDED = `${HEAD("Your mortgage lien has been released")}
{{#block "body" page=1 y=0.18 pt=11}}Your loan was paid in full on {{date payoff_date}}. The {{instrument_title}} releasing the lien of the {{security_instrument_title}} recorded {{date original_recording_date}} as {{original_recording_reference}} was recorded with the {{recording_office}} on {{date recorded_date}} as {{recording_reference}}. A copy of the recorded instrument is enclosed. The lien on your property has been released and you owe nothing further on this loan.{{/block}}
{{#block "mers" page=1 y=0.4 pt=11}}{{#if min}}This loan was registered on the MERS System (MIN {{min}}). The MERS registration will be deactivated as paid in full within 60 days of recording; no action is needed from you.{{/if}}{{/block}}
{{#block "reminders" page=1 y=0.5 pt=11}}Reminders: {{servicer_name}} no longer collects escrow, so property tax bills and hazard insurance premiums are now payable directly by you. Contact your taxing authority and your insurance carrier to update the billing address and remove {{servicer_name}} as mortgagee and loss payee.{{#if escrow_refund_cents}} Any remaining escrow balance of {{money escrow_refund_cents}} is refunded separately within 20 days of payoff.{{/if}}{{/block}}
{{#block "florida" page=1 y=0.66 pt=11}}{{#if florida}}This recorded release is sent to you as required by section 701.04(2), Florida Statutes.{{/if}}{{/block}}
{{#block "note" page=1 y=0.74 pt=11}}{{#if note_return_note}}{{note_return_note}}{{/if}}{{/block}}
${CONTACT}`;
const LIEN_RELEASE_RECORDED_RULES = [DATE_RULE, CONTACT_RULE, NO_PENALTY_CHARGE,
  R("released", "16.3 rule 8: statement that the lien is released", "presence", "lien on your property has been released", "release statement"),
  R("paid-in-full", "C-1.2-04", "presence", "paid in full on [A-Z][a-z]+ \\d{1,2}, \\d{4}", "payoff date"),
  R("recording-reference", "16.3 outputs: recording reference (instrument no./book-page)", "presence", "recorded with the .+ on [A-Z][a-z]+ \\d{1,2}, \\d{4} as .+", "recording office, date and reference"),
  R("image", "16.3 rule 8: always send the recorded image (FL §701.04(2) mandatory)", "data_equality", "recorded_image_attached", "recorded instrument copy enclosed", { predicate: { "==": [{ var: "recorded_image_attached" }, true] } }),
  R("mers-note", "16.4: MERS deactivation note when a MIN exists", "data_equality", "min", "MERS deactivation note follows the MIN", { predicate: { or: [{ "!": { present: "min" } }, { matches: ["min", "^\\d{7}-\\d{10}-\\d$"] }] } }),
  R("tax-insurance", "16.3 outputs: tax/insurance reminders", "presence", "property tax bills and hazard insurance premiums", "tax and insurance reminder"),
  R("florida", "Fla. Stat. §701.04(2)", "conditional", "florida", "FL letters cite §701.04(2)", { when: { "==": [{ var: "state" }, "FL"] }, predicate: { or: [{ "!=": [{ var: "state" }, "FL"] }, { "==": [{ var: "florida" }, true] }] } }),
  R("heading-layout", "plain-language heading", "layout", "heading", "heading on page 1, bold, ≥ 12pt", { layout: { page: 1, bold: true, minPt: 12, maxYFraction: 0.1 } })];
const LIEN_RELEASE_RECORDED_SAMPLE = { ...BASE, state: "OH", florida: false, payoff_date: "2026-10-16", instrument_title: "Release of Mortgage", security_instrument_title: "Mortgage", original_recording_date: "2019-05-03", original_recording_reference: "Instrument No. 201905030054321", recording_office: "Franklin County Recorder", recorded_date: "2026-10-26", recording_reference: "Instrument No. 202610260012345", recorded_image_attached: true, min: "1000123-0000456789-0", escrow_refund_cents: 0n, note_return_note: "" };

// ------------------------------------------------------------------ NTC_NJ_CANCELLATION_RIGHT
const NJ_CANCELLATION_RIGHT = `${HEAD("Notice of your right to demand cancellation of your mortgage")}
{{#block "body" page=1 y=0.18 pt=11}}Your mortgage loan was paid in full on {{date payoff_date}}. Under N.J.S.A. 46:18-11.2 you have the right to demand that {{servicer_name}} cancel (discharge) the mortgage of record. This notice is sent to you within 10 days of payoff. Once we receive your demand and the cancellation fee, we will cancel the mortgage of record within 30 days after receipt of the fee and send you a copy of the transmittal to the county recording officer.{{/block}}
{{#block "fee" page=1 y=0.4 pt=11}}The cancellation service fee is {{money cancellation_fee_cents}}{{#if fee_waived}} (we have waived this fee; no payment is required){{/if}}. By law the fee may not exceed $25.00.{{/block}}
{{#block "how" page=1 y=0.5 pt=11}}How to demand cancellation: send a written request stating your name, the property address and loan number ending {{account_last4}}, with the fee{{#if fee_waived}} (none){{/if}}, to {{servicer_name}}, {{servicer_address}}, or submit it at {{website}}. You may also call {{team_phone}}. If you do not make a demand, we will still cancel the mortgage of record{{#if cancellation_target_date}} — our target is {{date cancellation_target_date}}{{/if}}.{{/block}}
${CONTACT}`;
const NJ_CANCELLATION_RIGHT_RULES = [DATE_RULE, CONTACT_RULE, NO_PENALTY_CHARGE,
  R("right", "N.J.S.A. 46:18-11.2: notify the mortgagor of the right to demand cancellation", "presence", "right to demand that .+ cancel \\(discharge\\) the mortgage", "right to demand cancellation"),
  R("statute", "N.J.S.A. 46:18-11.2", "presence", "N\\.J\\.S\\.A\\. 46:18-11\\.2", "statutory citation"),
  R("ten-days", "NJ_46_18_112_RIGHT_TO_DEMAND_NOTICE_10", "data_range", "days_after_payoff", "sent within 10 days of payoff", { range: { min: 0, max: 10 } }),
  R("fee-cap", "N.J.S.A. 46:18-11.2: service fee ≤ $25", "data_range", "cancellation_fee_cents", "fee within the $25 cap", { range: { min: 0, max: 2500 } }),
  R("fee-cap-text", "N.J.S.A. 46:18-11.2", "presence", "may not exceed \\$25\\.00", "cap disclosed"),
  R("thirty-days", "N.J.S.A. 46:18-11.2: cancel within 30 days of receipt of the fee", "presence", "within 30 days after receipt of the fee", "30-day cancellation commitment"),
  R("how", "16.3 outputs: how to demand", "presence", "How to demand cancellation: send a written request", "demand instructions"),
  R("transmittal", "N.J.S.A. 46:18-11.2: copy of the transmittal to the mortgagor", "presence", "copy of the transmittal", "transmittal copy promised")];
const NJ_CANCELLATION_RIGHT_SAMPLE = { ...BASE, notice_date: "2026-10-21", property_address: "8 Bay Ave, Newark NJ 07102", payoff_date: "2026-10-16", days_after_payoff: 5, cancellation_fee_cents: 2_500n, fee_waived: false, cancellation_target_date: "2026-11-06" };

// ------------------------------------------------------------------ NTC_ENOTE_PAPER_COPY
const ENOTE_PAPER_COPY = `${HEAD("Paper copy of your electronic promissory note")}
{{#block "body" page=1 y=0.18 pt=11}}Your loan was documented by an electronic promissory note (an "eNote") held in an electronic vault; there is no paper original to return. Your loan was paid in full on {{date payoff_date}}. Enclosed is a paper copy of the eNote, printed from the authoritative copy and marked "Copy" and "Paid-In-Full". This copy is provided under Fannie Mae Servicing Guide F-1-09 because the law of {{state_name}} requires the return of a paid note.{{/block}}
{{#block "registry" page=1 y=0.42 pt=11}}The MERS eRegistry status of the eNote has been updated to paid off{{#if eregistry_updated_date}} on {{date eregistry_updated_date}}{{/if}} and the MERS registration{{#if min}} (MIN {{min}}){{/if}} is being deactivated.{{#if release_recording_reference}} The release of the lien was recorded on {{date recorded_date}} as {{release_recording_reference}}.{{/if}}{{/block}}
{{#block "no-original" page=1 y=0.56 pt=11}}Because the note was electronic, this paper copy is not a negotiable original and cannot be presented for payment. No further amounts are owed on this loan.{{/block}}
${CONTACT}`;
const ENOTE_PAPER_COPY_RULES = [DATE_RULE, CONTACT_RULE, NO_PENALTY_CHARGE,
  R("copy-mark", "F-1-09: paper copy marked \"Copy\"", "presence", "marked \"Copy\" and \"Paid-In-Full\"", "Copy / Paid-In-Full marking"),
  R("enote", "F-1-09 eNote payoff", "presence", "electronic promissory note", "explains the eNote"),
  R("no-paper-original", "F-1-09: no paper original exists", "presence", "no paper original to return", "no original statement"),
  R("f-1-09", "Servicing Guide F-1-09", "presence", "F-1-09", "Guide citation"),
  R("eregistry", "F-1-09: eRegistry updated, MERS deactivated", "presence", "eRegistry status .+ paid off", "eRegistry statement"),
  R("marked-data", "F-1-09", "data_equality", "enclosure_marked_copy_paid_in_full", "the enclosed print carries both markings", { predicate: { "==": [{ var: "enclosure_marked_copy_paid_in_full" }, true] } })];
const ENOTE_PAPER_COPY_SAMPLE = { ...BASE, notice_date: "2026-11-05", property_address: "44 Hudson St, Albany NY 12207", state_name: "New York", payoff_date: "2026-10-16", eregistry_updated_date: "2026-10-20", min: "1000123-0000456789-0", release_recording_reference: "Instrument No. 2026-11020", recorded_date: "2026-10-30", enclosure_marked_copy_paid_in_full: true };

// ------------------------------------------------------------------ NTC_NOTE_RETURNED
const NOTE_RETURNED = `${HEAD("Your original promissory note, marked \"Paid in Full\"")}
{{#block "body" page=1 y=0.18 pt=11}}Your loan was paid in full on {{date payoff_date}}. Enclosed is the original promissory note dated {{date note_date}}, marked "Paid in Full"{{#if mortgage_enclosed}}, together with the original {{security_instrument_title}}{{/if}}.{{#if requested_on}} You (or your designee) requested these documents on {{date requested_on}}; this return is made within {{days_after_request}} days of that request as required by {{statutory_basis}}.{{else}} This return is made as required by {{statutory_basis}}.{{/if}}{{#if release_recording_reference}} The release of the lien was recorded on {{date recorded_date}} as {{release_recording_reference}}.{{/if}}{{/block}}
{{#block "enclosures" page=1 y=0.46 pt=11}}Enclosures: {{#each enclosures}}{{this}}; {{/each}}{{/block}}
{{#block "keep" page=1 y=0.54 pt=11}}Keep these documents with your property records. No further amounts are owed on this loan.{{/block}}
${CONTACT}`;
const NOTE_RETURNED_RULES = [DATE_RULE, CONTACT_RULE, NO_PENALTY_CHARGE,
  R("paid-in-full", "16.3 rule 8: original note marked \"Paid in Full\"", "presence", "marked \"Paid in Full\"", "note marking"),
  R("original", "16.3 rule 8", "presence", "Enclosed is the original promissory note", "original note enclosed"),
  R("enclosures", "16.3 outputs: cover letter lists the enclosures", "presence", "Enclosures: .+;", "enclosure list"),
  R("statute", "NY RPAPL §1921; Md. Real Prop. §7-106", "presence", "as required by (RPAPL|Real Prop|Md\\.|N\\.Y\\.)", "statutory basis"),
  // the 45-day clock exists only where the borrower/designee requested the originals (NY RPAPL §1921); the Maryland return (Real Prop. §7-106) and the F-1-09 return carry no request date
  R("ny-45", "NY RPAPL §1921: deliver within 45 days of the request", "data_range", "days_after_request", "within 45 days of the request", { range: { min: 0, max: 45 }, when: { present: "requested_on" } }),
  R("request-days", "NY RPAPL §1921: the letter's day count is computed from the request date", "conditional", "days_after_request", "days_after_request accompanies requested_on", { when: { present: "requested_on" }, predicate: { present: "days_after_request" } })];
const NOTE_RETURNED_SAMPLE = { ...BASE, notice_date: "2026-11-12", property_address: "44 Hudson St, Albany NY 12207", payoff_date: "2026-10-16", note_date: "2019-05-01", mortgage_enclosed: true, security_instrument_title: "Mortgage", requested_on: "2026-10-16", days_after_request: 27, statutory_basis: "N.Y. RPAPL §1921", release_recording_reference: "Instrument No. 2026-11020", recorded_date: "2026-10-30", enclosures: ["Original promissory note dated May 1, 2019, marked Paid in Full", "Original mortgage recorded May 3, 2019"] };

export const VERSIONS_16_3: VersionInput[] = [
  V("NTC_LIEN_RELEASE_RECORDED", LIEN_RELEASE_RECORDED, LIEN_RELEASE_RECORDED_RULES, LIEN_RELEASE_RECORDED_SAMPLE, "sm.release.2026-09", "16.3 outputs; worked example 1 (Ohio, recorded 10/26/2026); Fla. Stat. §701.04(2)"),
  V("NTC_NJ_CANCELLATION_RIGHT", NJ_CANCELLATION_RIGHT, NJ_CANCELLATION_RIGHT_RULES, NJ_CANCELLATION_RIGHT_SAMPLE, "state.nj.46-18-11_2.2026", "N.J.S.A. 46:18-11.2 nonbank notice; 16.3-T6"),
  V("NTC_ENOTE_PAPER_COPY", ENOTE_PAPER_COPY, ENOTE_PAPER_COPY_RULES, ENOTE_PAPER_COPY_SAMPLE, "fnma.f109.2026-09", "Servicing Guide F-1-09 eNote paper copy letter"),
  V("NTC_NOTE_RETURNED", NOTE_RETURNED, NOTE_RETURNED_RULES, NOTE_RETURNED_SAMPLE, "sm.release.2026-09", "16.3 rule 8 note-return cover letter; NY RPAPL §1921; Md. Real Prop. §7-106"),
];
export const OVERRIDES_16_3: Record<string, Partial<NoticeTemplate>> = {
  NTC_LIEN_RELEASE_RECORDED: { citation: "16.3 rule 8 (policy); Fla. Stat. §701.04(2); O.C.G.A. §44-14-3", channelPolicy: "esign_or_mail" },
  NTC_NJ_CANCELLATION_RIGHT: { citation: "N.J.S.A. 46:18-11.2", channelPolicy: "esign_or_mail" },
  NTC_ENOTE_PAPER_COPY: { citation: "Fannie Mae Servicing Guide F-1-09", channelPolicy: "mail_only", separateDocument: true },
  NTC_NOTE_RETURNED: { citation: "N.Y. RPAPL §1921; Md. Real Prop. §7-106", channelPolicy: "mail_only", separateDocument: true },
};
