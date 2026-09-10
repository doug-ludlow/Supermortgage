/**
 * Authored template versions for the §8 credit-reporting notices: the
 * §1681s-2(a)(7) negative-information notices (Appendix B models B-1/B-2),
 * the designated accuracy/direct-dispute address, and the Reg V §1022.43
 * results, frivolous-determination and acknowledgment letters.
 */
import type { ContentRule, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
export const MODEL_B1 = "We may report information about your account to credit bureaus. Late payments, missed payments, or other defaults on your account may be reflected in your credit report.";
export const MODEL_B2 = "We have told a credit bureau about a late payment, missed payment or other default on your account. This information may be reflected in your credit report.";
const CONTACT = `{{#block "contact" page=1 y=0.9 pt=10}}Supermortgage · {{servicer_phone}} (toll-free) · {{servicer_address}}{{/block}}`;
const CONTACT_SAMPLE = { servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001" };

const B1_SOURCE = `{{#block "b1" page=1 y=0.8 pt=11 bold}}${MODEL_B1}{{/block}}`;
const B1_RULES: ContentRule[] = [R("model-text", "12 CFR 1022 App. B, Model B-1; 15 U.S.C. §1681s-2(a)(7)(A)", "presence", MODEL_B1.replace(/[.]/g, "\\."), "Model B-1 text verbatim"), R("per-account", "§1681s-2(a)(7)(A)(i)", "data_equality", "account_last4", "one notice per account", { predicate: { present: "account_last4" } })];
const B2_SOURCE = `{{#block "b2" page=1 y=0.1 pt=11 bold}}${MODEL_B2}{{/block}}
{{#block "account" page=1 y=0.2 pt=10}}Loan number ending {{account_last4}}. Information was first furnished on {{date first_furnished_on}}.{{/block}}
${CONTACT}`;
const B2_RULES: ContentRule[] = [R("model-text", "12 CFR 1022 App. B, Model B-2; §1681s-2(a)(7)(A)(ii)", "presence", MODEL_B2.replace(/[.]/g, "\\."), "Model B-2 text verbatim"), R("within-30", "§1681s-2(a)(7)(B)(i)", "data_range", "days_after_furnishing", "sent within 30 days after furnishing", { range: { max: 30 } }), R("account", "§1681s-2(a)(7)(A)", "presence", "Loan number ending \\d{4}", "account identified")];
const ADDRESS_SOURCE = `{{#block "heading" page=1 y=0.05 pt=12 bold}}Where to send notices about the accuracy of your credit reporting{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}If you believe information we furnished to a credit bureau is inaccurate, write to us at {{dispute_address}} or use the secure message center at {{portal_url}}. Include your name, loan number, the specific information you dispute, why you dispute it, and any supporting documents. Notices sent to any other address may not be treated as notices under the Fair Credit Reporting Act.{{/block}}`;
const ADDRESS_RULES: ContentRule[] = [R("address", "15 U.S.C. §1681s-2(a)(1)(C); 12 CFR 1022.43(c)(2)", "presence", "write to us at PO Box", "the designated address"), R("online", "8.2 operational prerequisite", "presence", "secure message center at https://", "online channel declared"), R("what-to-include", "12 CFR 1022.43(d)", "presence", "the specific information you dispute, why you dispute it, and any supporting documents", "the (d) contents"), R("conspicuous", "§1681s-2(a)(1)(C) clearly and conspicuously", "layout", "heading", "heading on page 1", { layout: { page: 1, bold: true } })];
const RESULTS_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Results of our investigation of your credit reporting dispute{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}We received your dispute on {{date received_on}}. {{#each items}}Item: {{item}}. Determination: {{determination}}. Reason: {{reason}}. {{/each}}{{#if corrections}}What we corrected: {{#each corrections}}{{this}}; {{/each}}The corrected information will appear in our next monthly report to the credit bureaus and we have sent an update to each bureau.{{else}}No changes were made to the information we furnished.{{/if}} You may also dispute this information directly with the credit bureaus and you may add a statement of dispute to your credit file. {{#if adverse_ai}}This determination was generated with automated tools; you may request review by a person by calling {{servicer_phone}}.{{/if}} Send further disputes to {{dispute_address}}.{{/block}}
${CONTACT}`;
const RESULTS_RULES: ContentRule[] = [R("items", "12 CFR 1022.43(e)(3)", "presence", "Item: .* Determination: .* Reason: ", "each item, determination and reason"), R("corrections", "§1022.43(e)(3)", "presence", "(What we corrected: .* next monthly report|No changes were made)", "corrections and when they appear"), R("cra-rights", "§1022.43(e); §1681i", "presence", "dispute this information directly with the credit bureaus and you may add a statement of dispute", "CRA dispute rights"), R("address", "§1022.43(c)(2)", "presence", "Send further disputes to PO Box", "direct-dispute address"), R("human-review", "8.2 rule 8 (Colorado AI Act posture)", "conditional", "adverse_ai", "human-review path on adverse AI determinations", { when: { "==": [{ var: "adverse_ai" }, true] }, predicate: { "==": [{ var: "human_review_offered" }, true] } }), R("within-30", "§1022.43(e)(3) (before the 30-day period expires)", "data_range", "days_after_receipt", "sent by day 30", { range: { max: 30 } })];
const FRIVOLOUS_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}Notice regarding your credit reporting dispute{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}We received your dispute on {{date received_on}}. We have determined that we cannot investigate it because {{reason}}. To have your dispute investigated, please send the following information to {{dispute_address}}: {{#each required_information}}{{this}}; {{/each}}{{/block}}
${CONTACT}`;
const FRIVOLOUS_RULES: ContentRule[] = [R("reasons", "12 CFR 1022.43(f)(2)(ii)(A)", "presence", "cannot investigate it because", "reasons for the determination"), R("required-info", "§1022.43(f)(2)(ii)(B)", "presence", "please send the following information to PO Box .*: .+;", "identification of information required"), R("within-5bd", "§1022.43(f)(2)(i) (5 business days)", "data_range", "business_days_after_determination", "sent within 5 business days of the determination", { range: { max: 5 } }), R("human-made", "8.2 rule 7: frivolous determinations are made only by a human reviewer", "data_equality", "determined_by_human", "human determination", { predicate: { "==": [{ var: "determined_by_human" }, true] } })];
const ACK_SOURCE = `{{#block "body" page=1 y=0.1 pt=11}}We received your credit reporting dispute on {{date received_on}} and are investigating it. We will send you the results by {{date results_due}}. If you have documents that support your dispute, send them to {{dispute_address}}.{{/block}}
${CONTACT}`;
const ACK_RULES: ContentRule[] = [R("received", "8.2 (optional acknowledgment; policy)", "presence", "received your credit reporting dispute on", "acknowledges receipt"), R("results-date", "§1022.43(e)", "presence", "send you the results by", "states the results date")];

const S = { account_last4: "1234", first_furnished_on: "2027-04-05", days_after_furnishing: 10, dispute_address: "PO Box 2, Testville TX 75001", portal_url: "https://portal.example.com/messages", received_on: "2027-09-03", items: [{ item: "February 2027 payment reported late", determination: "verified as reported", reason: "our records show the February 1 installment was not received until the deferral in August" }], corrections: [], adverse_ai: true, human_review_offered: true, days_after_receipt: 25, reason: "it is a repeat of a dispute we already investigated and contains no new information", required_information: ["the specific account information you dispute", "why you believe it is inaccurate", "supporting documents such as a cleared check image"], business_days_after_determination: 5, determined_by_human: true, results_due: "2027-10-03", ...CONTACT_SAMPLE };

export const SECTION_08_VERSIONS: readonly VersionInput[] = [
  V("NTC_FCRA_1681S2A7_B1", B1_SOURCE, B1_RULES, S, "fcra.regv.2026-09", "12 CFR 1022 Appendix B, Model B-1"),
  V("NTC_FCRA_1681S2A7_B2", B2_SOURCE, B2_RULES, S, "fcra.regv.2026-09", "12 CFR 1022 Appendix B, Model B-2"),
  V("NTC_FCRA_1681S2A1C_ADDRESS", ADDRESS_SOURCE, ADDRESS_RULES, S, "fcra.regv.2026-09", "15 U.S.C. §1681s-2(a)(1)(C); 12 CFR 1022.43(c)(2)"),
  V("NTC_FCRA_1022_43E_RESULTS", RESULTS_SOURCE, RESULTS_RULES, S, "fcra.regv.2026-09", "12 CFR 1022.43(e)(3)"),
  V("NTC_FCRA_1022_43F_FRIVOLOUS", FRIVOLOUS_SOURCE, FRIVOLOUS_RULES, S, "fcra.regv.2026-09", "12 CFR 1022.43(f)(2)"),
  V("NTC_FCRA_1022_43_ACK", ACK_SOURCE, ACK_RULES, S, "fcra.regv.2026-09", "8.2 policy acknowledgment"),
];
