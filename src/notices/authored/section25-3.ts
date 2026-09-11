/**
 * §25.3 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * NTC_REGZ_1026_23_H8 — Appendix H, form H-8 "NOTICE OF RIGHT TO CANCEL" (general rescission): the retention or acquisition
 * of a security interest in the consumer's principal dwelling, the right to cancel within three business days of the last of
 * the three events, how to cancel (a form designating the creditor's place of business), the effects of rescission and the
 * printed expiry date "midnight of ______" (§1026.23(b)(1)(i)–(v)).
 * NTC_REGZ_1026_23_H9 — form H-9 (refinancing with the original creditor): the same, for "a new transaction to increase the
 * amount of credit previously provided", stating the amount of the increase (§1026.23(f)(2): only the new advance is rescindable).
 * Two copies per consumer on paper, one when electronic (decision 25.3-Q1: two either way); retention `regz_cd_5y`.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const DATE = "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}";

const H8_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}NOTICE OF RIGHT TO CANCEL{{/block}}
{{#block "creditor" page=1 y=0.1 pt=11}}{{creditor_name}} — Loan secured by {{property_address}} — Notice to {{consumer_name}} (copy {{copies}} of {{copies}} per consumer).{{/block}}
{{#block "security" page=1 y=0.16 pt=11 bold}}Your Right to Cancel{{/block}}
{{#block "right" page=1 y=0.2 pt=11}}You are entering into a transaction that will result in a [mortgage/lien/security interest] [on/in] your home. You have a legal right under Federal law to cancel this transaction, without cost, within three business days from whichever of the following events occurs last: (1) the date of this transaction, which is {{date transaction_date}}; or (2) the date you received your Truth in Lending disclosures; or (3) the date you received this notice of your right to cancel.{{/block}}
{{#block "effects" page=1 y=0.36 pt=11}}If you cancel the transaction, the [mortgage/lien/security interest] is also cancelled. Within 20 calendar days after we receive your notice of cancellation, we must take the steps necessary to reflect the fact that the [mortgage/lien/security interest] [on/in] your home has been cancelled, and we must return to you any money or property you have given to us or to anyone else in connection with this transaction. You may keep any money or property we have given you until we have done the things mentioned above, but you must then offer to return the money or property. If it is impractical or unfair for you to return the property, you must offer its reasonable value. You may offer to return the property at your home or at the location of the property. Money must be returned to the address below. If we do not take possession of the money or property within 20 calendar days of your offer, you may keep it without further obligation.{{/block}}
{{#block "how" page=1 y=0.6 pt=11 bold}}How to Cancel{{/block}}
{{#block "how_body" page=1 y=0.64 pt=11}}If you decide to cancel this transaction, you may do so by notifying us in writing, at {{creditor_name}}, {{designated_address}}{{#if designated_email}} (or by e-mail to {{designated_email}}){{/if}}{{#if designated_fax}} (or by fax to {{designated_fax}}){{/if}}. You may use any written statement that is signed and dated by you and states your intention to cancel, or you may use this notice by dating and signing below. Keep one copy of this notice because it contains important information about your rights. If you cancel by mail or telegram, you must send the notice no later than midnight of {{date expiry_date}} (or midnight of the third business day following the latest of the three events listed above). If you send or deliver your written notice to cancel some other way, it must be delivered to the above address no later than that time.{{/block}}
{{#block "signature" page=1 y=0.88 pt=11 bold}}I WISH TO CANCEL. Consumer's Signature: ______________________ Date: ____________{{/block}}`;

const H9_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}NOTICE OF RIGHT TO CANCEL{{/block}}
{{#block "creditor" page=1 y=0.1 pt=11}}{{creditor_name}} — Loan secured by {{property_address}} — Notice to {{consumer_name}} (copy {{copies}} of {{copies}} per consumer).{{/block}}
{{#block "security" page=1 y=0.16 pt=11 bold}}Your Right to Cancel{{/block}}
{{#block "right" page=1 y=0.2 pt=11}}You are entering into a new transaction to increase the amount of credit previously provided to you. Your home is the security for this new transaction. The amount of the increase is {{money increase_cents}}. You have a legal right under Federal law to cancel this new transaction, without cost, within three business days from whichever of the following events occurs last: (1) the date of this new transaction, which is {{date transaction_date}}; or (2) the date you received your new Truth in Lending disclosures; or (3) the date you received this notice of your right to cancel.{{/block}}
{{#block "effects" page=1 y=0.36 pt=11}}If you cancel this new transaction, it will not affect any amount that you presently owe. Your home is the security for that amount. Within 20 calendar days after we receive your notice of cancellation of this new transaction, we must take the steps necessary to reflect the fact that your home does not secure the increase of credit. We must also return any money you have given to us or anyone else in connection with this new transaction. You may keep any money we have given you in this new transaction until we have done the things mentioned above, but you must then offer to return the money at the address below. If we do not take possession of the money within 20 calendar days of your offer, you may keep it without further obligation.{{/block}}
{{#block "how" page=1 y=0.6 pt=11 bold}}How to Cancel{{/block}}
{{#block "how_body" page=1 y=0.64 pt=11}}If you decide to cancel this new transaction, you may do so by notifying us in writing, at {{creditor_name}}, {{designated_address}}{{#if designated_email}} (or by e-mail to {{designated_email}}){{/if}}{{#if designated_fax}} (or by fax to {{designated_fax}}){{/if}}. You may use any written statement that is signed and dated by you and states your intention to cancel, or you may use this notice by dating and signing below. Keep one copy of this notice because it contains important information about your rights. If you cancel by mail or telegram, you must send the notice no later than midnight of {{date expiry_date}} (or midnight of the third business day following the latest of the three events listed above). If you send or deliver your written notice to cancel some other way, it must be delivered to the above address no later than that time.{{/block}}
{{#block "signature" page=1 y=0.88 pt=11 bold}}I WISH TO CANCEL. Consumer's Signature: ______________________ Date: ____________{{/block}}`;

const COMMON_RULES = (form: "h8" | "h9"): ContentRule[] => [
  R("heading", "Appendix H, form H-8/H-9", "layout", "heading", "NOTICE OF RIGHT TO CANCEL heading, prominent", { layout: { page: 1, bold: true, minPt: 14, maxYFraction: 0.1 } }),
  R("b1-i-security-interest", "§1026.23(b)(1)(i)", "presence", form === "h8" ? "result in a \\[mortgage/lien/security interest\\] \\[on/in\\] your home" : "Your home is the security for this new transaction", "the retention or acquisition of a security interest in the consumer's principal dwelling"),
  R("b1-ii-right", "§1026.23(b)(1)(ii)", "presence", "legal right under Federal law to cancel this (new )?transaction, without cost, within three business days from whichever of the following events occurs last", "the consumer's right to rescind the transaction"),
  R("b1-ii-three-events", "§1026.23(a)(3)(i); Appendix H", "presence", `\\(1\\) the date of this (new )?transaction, which is ${DATE}; or \\(2\\) the date you received your (new )?Truth in Lending disclosures; or \\(3\\) the date you received this notice of your right to cancel`, "the three events — the period runs from whichever occurs last, never from consummation alone"),
  R("b1-iii-how-designated-address", "§1026.23(b)(1)(iii)", "presence", "notifying us in writing, at [^\\n]{5,200}?\\d{5}", "how to exercise the right, designating the address of the creditor's place of business (street/PO box, city, state, ZIP)"),
  R("b1-iii-form", "§1026.23(b)(1)(iii)", "presence", "you may use this notice by dating and signing below", "a form for that purpose"),
  R("b1-iii-signature", "Appendix H", "layout", "signature", "I WISH TO CANCEL signature block, prominent", { layout: { page: 1, bold: true } }),
  R("b1-iii-signature-text", "Appendix H", "presence", "I WISH TO CANCEL", "the signature block"),
  R("b1-iv-effects-20-days", "§1026.23(b)(1)(iv); (d)(2)", "presence", form === "h8" ? "Within 20 calendar days after we receive your notice of cancellation, we must take the steps necessary to reflect the fact that the \\[mortgage/lien/security interest\\] \\[on/in\\] your home has been cancelled" : "Within 20 calendar days after we receive your notice of cancellation of this new transaction, we must take the steps necessary to reflect the fact that your home does not secure the increase of credit", "the effects of rescission (security interest void; 20 calendar days to unwind and return money or property)"),
  R("b1-v-expiry-printed", "§1026.23(b)(1)(v)", "presence", `no later than midnight of ${DATE}`, "the date the rescission period expires, printed as 'midnight of ______'"),
  R("b1-v-expiry-data", "§1026.23(b)(1)(v); 25.3 edge case 'wrong expiry date printed'", "data_equality", "expiry_date,transaction_date", "expiry date computed from the period (never blank); transaction date carried", { predicate: { and: [{ matches: ["expiry_date", "^\\d{4}-\\d{2}-\\d{2}$"] }, { matches: ["transaction_date", "^\\d{4}-\\d{2}-\\d{2}$"] }] } }),
  R("designated-place-data", "§1026.23(b)(1)(iii); decision 25.3-Q2", "data_equality", "creditor_name,designated_address", "the creditor's name and designated place of business carried on the notice", { predicate: { and: [{ present: "creditor_name" }, { present: "designated_address" }, { matches: ["designated_address", "\\d{5}"] }] } }),
  R("per-consumer", "§1026.23(b)(1); comment 23(b)(1)-1", "data_equality", "consumer_id,consumer_name,copies", "one notice per consumer entitled to rescind, two copies (one suffices electronically under E-SIGN — policy delivers two)", { predicate: { and: [{ present: "consumer_id" }, { present: "consumer_name" }, { in: [{ var: "copies" }, [1, 2]] }] } }),
  R("keep-a-copy", "Appendix H", "presence", "Keep one copy of this notice", "the consumer keeps a copy (the second copy is the one returned)"),
  R("no-waiver-language", "§1026.23(e) 'Printed forms for this purpose are prohibited'; 25.3 guardrails", "absence", "waive[sd]? (my|our|the) right|emergency", "the notice never carries waiver language or an emergency statement form"),
  R("form-code", "25.3 Data model: disclosures{kind=rescission_h8 | rescission_h9}", "data_equality", "form", `form = ${form}`, { predicate: { "==": [{ var: "form" }, form] } }),
];
const H8_RULES: ContentRule[] = [...COMMON_RULES("h8"), R("h8-not-new-advance", "§1026.23(f)(2); Appendix H-8 vs H-9", "absence", "increase the amount of credit previously provided", "H-8 is the general form — a same-creditor refinance uses H-9")];
const H9_RULES: ContentRule[] = [...COMMON_RULES("h9"),
  R("h9-new-transaction", "Appendix H, form H-9", "presence", "You are entering into a new transaction to increase the amount of credit previously provided to you", "the H-9 opening — the transaction is a refinancing with the original creditor"),
  R("h9-increase-stated", "§1026.23(f)(2); 25.3 worked example E", "presence", "The amount of the increase is \\$[\\d,]+\\.\\d{2}", "the H-9 states the amount of the increase (the rescindable new advance)"),
  R("h9-increase-positive", "§1026.23(f)(2) 'to the extent the new amount financed exceeds …'", "data_range", "increase_cents", "the increase is a positive new advance (≤ 0 → exempt_same_creditor_no_new_money, no notice)", { range: { min: 1 } }),
  R("h9-not-affect-existing", "Appendix H, form H-9", "presence", "it will not affect any amount that you presently owe", "the effect on the existing debt"),
];
const CREDITOR = { creditor_name: "Partner Bank, N.A.", designated_address: "100 Partner Plaza, Suite 400, Phoenix AZ 85004", designated_email: "rescission@partnerbank.example", designated_fax: null, property_address: "1234 W Camelback Rd, Phoenix AZ 85015" };
/** Fixture (worked example A): consummation Fri Nov 6, 2026 → expires midnight Tue Nov 10, 2026; two copies to the borrower and the non-borrower spouse. */
const H8_SAMPLE: Record<string, unknown> = { ...CREDITOR, template_code: "NTC_REGZ_1026_23_H8", form: "h8", consumer_id: "C-BORROWER", consumer_name: "Alex Borrower", transaction_date: "2026-11-06", expiry_date: "2026-11-10", copies: 2 };
/** Worked example E: same-creditor refinance with a $2,099.45 new advance → H-9 for the increase only. */
const H9_SAMPLE: Record<string, unknown> = { ...CREDITOR, template_code: "NTC_REGZ_1026_23_H9", form: "h9", consumer_id: "C-BORROWER", consumer_name: "Alex Borrower", transaction_date: "2026-11-06", expiry_date: "2026-11-10", copies: 2, increase_cents: 209_945n };

export const VERSIONS_25_3: VersionInput[] = [
  V("NTC_REGZ_1026_23_H8", H8_SOURCE, H8_RULES, H8_SAMPLE, "regz.rescission.1026_23", "Appendix H to 12 CFR Part 1026, form H-8 Rescission Model Form (General) (eCFR 9/03/2026); §1026.23(b)(1)"),
  V("NTC_REGZ_1026_23_H9", H9_SOURCE, H9_RULES, H9_SAMPLE, "regz.rescission.1026_23", "Appendix H to 12 CFR Part 1026, form H-9 Rescission Model Form (Refinancing with Original Creditor) (eCFR 9/03/2026); §1026.23(b)(1), (f)(2)"),
];
/** Delivered at signing to each consumer (paper at hybrid/wet closings; electronic copies under E-SIGN consent at RON); never combined with another notice — the consumer must be able to return one copy as the cancellation. */
export const OVERRIDES_25_3: Record<string, Partial<NoticeTemplate>> = {
  NTC_REGZ_1026_23_H8: { channelPolicy: "esign_or_mail", noticeClass: "disclosures", separateDocument: true, mayCombineWith: [], retention: "regz_cd_5y", citation: "12 CFR 1026.23(b); Appendix H form H-8" },
  NTC_REGZ_1026_23_H9: { channelPolicy: "esign_or_mail", noticeClass: "disclosures", separateDocument: true, mayCombineWith: [], retention: "regz_cd_5y", citation: "12 CFR 1026.23(b), (f)(2); Appendix H form H-9" },
};
