/**
 * Authored template versions for the §2 cashiering notices (2.1–2.7 "Outputs
 * and artifacts"). The §2 spec names its templates with hyphenated codes
 * (`PAY-NONCONFORMING-v1`, `SUSP-PARTIAL-HOLD-v1`, …) rather than NTC_/INS_
 * codes, so they are not in spec/registry/notices.json; `registerSection02`
 * registers the templates and drafts the versions on a registry, and
 * `publishSection02` runs the same publish gate the catalog uses. Every rule
 * is a required-content item the spec states; the sample payload is the
 * section's worked example (fixture L-1), so the gate proves each template.
 */
import { NoticeRegistry, type ContentRule, type NoticeTemplate, type VersionInput } from "../registry.ts";
import { publishCheck } from "../checklist.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const T = (code: string, ownerSection: string, name: string, citation: string, noticeClass: string, channelPolicy: NoticeTemplate["channelPolicy"], extra: Partial<NoticeTemplate> = {}): NoticeTemplate =>
  ({ code, name, citation, ownerSection, noticeClass, channelPolicy, separateDocument: false, mayCombineWith: [], retention: "life_of_loan_plus_4y", piiLevel: "medium", mentions: [ownerSection], ...extra });
const CONTACT = `{{#block "contact" page=1 y=0.9 pt=10}}Loan number ending {{account_last4}}. Questions? Call {{servicer_phone}}. Notices of error and requests for information: {{exclusive_address}}.{{/block}}`;
const COMMON = { account_last4: "1234", servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001", esign_consent: true };

// ------------------------------------------------------------------ 2.1 payment requirements, non-conforming payments, confirmations
/** The Reg Z §1026.36(c)(1)(iii) written payment requirements block (hello notice, statements, portal): the six-item required-content checklist. */
const PAY_REQUIREMENTS_SOURCE = `{{#block "heading" page=1 y=0.05 pt=12 bold}}HOW TO MAKE YOUR PAYMENT{{/block}}
{{#block "address" page=1 y=0.1 pt=10}}Remittance address: mail checks, money orders and cashier's checks to {{remittance_address}}.{{/block}}
{{#block "cutoff" page=1 y=0.2 pt=10}}Cut-off times: mailed payments received at the remittance address by {{mail_cutoff_local}} local time are credited that day; online and phone payments submitted by {{portal_cutoff_et}} Eastern Time are credited as of the day you submit them; payments received after the cut-off are credited the next business day.{{/block}}
{{#block "instruments" page=1 y=0.35 pt=10}}Accepted instruments: personal check, money order, cashier's check, and bank transfer (ACH) through the portal, phone system or your bank's bill-pay service. We do not accept cash{{#if cards_accepted}} and we accept debit cards without a fee{{else}} or credit cards{{/if}}.{{/block}}
{{#block "loan_number" page=1 y=0.5 pt=10}}Write your loan number on every check or money order and return the payment coupon so we can identify your payment.{{/block}}
{{#block "currency" page=1 y=0.6 pt=10}}Payments must be made in U.S. dollars.{{/block}}
{{#block "curtailment" page=1 y=0.7 pt=10}}To designate additional principal, use the "additional principal" field on the portal or coupon, or write "principal only" on the check; undesignated extra funds are held and applied on your instruction.{{/block}}
${CONTACT}`;
const PAY_REQUIREMENTS_RULES: ContentRule[] = [
  R("address", "12 CFR 1026.36(c)(1)(iii); comment 36(c)(1)(iii)-1", "presence", "Remittance address: .* to .+\\.", "one remittance address (lockbox P.O. box)"),
  R("cutoff-by-channel", "comment 36(c)(1)(iii)-1, -2", "presence", "Cut-off times: mailed payments .* by \\d{1,2}:\\d{2} (a\\.m\\.|p\\.m\\.) local time.*online and phone payments submitted by", "cut-off time by channel"),
  R("cutoff-reasonable", "comment 36(c)(1)(iii)-2 (5 p.m. is reasonable for mailed checks)", "data_range", "mail_cutoff_hhmm", "the mail cut-off is not earlier than 5:00 p.m.", { range: { min: "17:00" } }),
  R("instruments", "comment 36(c)(1)(iii)-1", "presence", "Accepted instruments: .*check.*money order.*cashier's check.*\\(ACH\\)", "accepted instruments listed"),
  R("loan-number", "comment 36(c)(1)(iii)-1 (account number/coupon)", "presence", "Write your loan number on every check", "loan-number requirement"),
  R("us-dollars", "comment 36(c)(1)(iii)-1", "presence", "U\\.S\\. dollars", "U.S. dollars"),
  R("curtailment-designation", "2.1 outputs; C-1.2-01 (borrower identification of a curtailment)", "presence", "To designate additional principal", "how to designate curtailments"),
  R("no-cards-by-default", "2.1-Q3 / 2.3-Q4 (no credit cards; no convenience fees)", "absence", "credit cards accepted|convenience fee", "no credit cards and no convenience fees"),
];
const PAY_REQUIREMENTS_SAMPLE: Record<string, unknown> = { ...COMMON, remittance_address: "Supermortgage, PO Box 7, Testville TX 75001", mail_cutoff_local: "5:00 p.m.", mail_cutoff_hhmm: "17:00", portal_cutoff_et: "11:59 p.m.", cards_accepted: false };

const PAY_NONCONFORMING_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}We received your payment of {{money amount_cents}} on {{date received_on}} at {{received_where}}, which did not conform to our written payment requirements ({{nonconforming_reason}}). We accepted it and credited it to your loan as of {{date credited_as_of}}. Under 12 CFR 1026.36(c)(1)(iii) a non-conforming payment may be credited up to five days after receipt; {{#if credited_on_receipt}}our policy credits it as of the day it was received{{else}}it was credited {{credited_days_after_receipt}} days after receipt{{/if}}.{{/block}}
{{#block "requirements" page=1 y=0.35 pt=10}}To have future payments credited as of the day we receive them: send payments to {{remittance_address}} by {{mail_cutoff_local}} local time, by check, money order, cashier's check or ACH, in U.S. dollars, with your loan number on the payment.{{/block}}
${CONTACT}`;
const PAY_NONCONFORMING_RULES: ContentRule[] = [
  R("accepted-not-refused", "12 CFR 1024.35(b)(1); 2.1 rule 3 (never refused because of form alone)", "presence", "We accepted it and credited it", "the payment was accepted"),
  R("citation", "12 CFR 1026.36(c)(1)(iii)", "presence", "12 CFR 1026\\.36\\(c\\)\\(1\\)\\(iii\\)", "citation stated"),
  R("credited-as-of", "12 CFR 1026.36(c)(1)(i), (iii)", "presence", "credited it to your loan as of (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "credited-as-of date stated"),
  R("five-day-cap", "12 CFR 1026.36(c)(1)(iii); REGZ_1026_36C1III_NONCONFORMING_5CD", "data_range", "credited_days_after_receipt", "never credited more than 5 days after receipt", { range: { min: 0, max: 5 } }),
  R("restates-requirements", "2.1 outputs (restates the written requirements)", "presence", "To have future payments credited as of the day we receive them: send payments to .* by .* in U\\.S\\. dollars, with your loan number", "written requirements restated"),
  R("never-refused-wording", "12 CFR 1024.35(b)(1)", "absence", "we (refused|rejected|returned) your payment", "no refusal language"),
];
const PAY_NONCONFORMING_SAMPLE: Record<string, unknown> = { ...COMMON, amount_cents: 219_257n, received_on: "2026-09-11", received_where: "our corporate office", nonconforming_reason: "sent to an address other than the remittance address", credited_as_of: "2026-09-11", credited_on_receipt: true, credited_days_after_receipt: 0, remittance_address: "Supermortgage, PO Box 7, Testville TX 75001", mail_cutoff_local: "5:00 p.m." };

const PAY_CONFIRM_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}Payment confirmation number {{confirmation_number}}. We received your {{channel_label}} payment of {{money amount_cents}} on {{date received_on}}; it is credited to your loan as of {{date credited_as_of}}{{#if pending_settlement}} and is subject to settlement of the bank transfer{{/if}}.{{/block}}
${CONTACT}`;
const PAY_CONFIRM_RULES: ContentRule[] = [
  R("confirmation-number", "2.1 integrations (confirmation number = payments.id)", "presence", "Payment confirmation number \\S+", "confirmation number"),
  R("amount-date", "2.1 outputs", "presence", "payment of \\$[\\d,]+\\.\\d{2} on (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "amount and receipt date"),
  R("credited-as-of", "12 CFR 1026.36(c)(1)(i)", "presence", "credited to your loan as of", "credited-as-of date"),
  R("electronic-only-with-consent", "2.1 outputs (electronic only with consent, else none); 15 U.S.C. 7001(c)", "data_equality", "esign_consent", "sent only to a borrower with E-SIGN consent", { predicate: { "==": [{ var: "esign_consent" }, true] } }),
];
const PAY_CONFIRM_SAMPLE: Record<string, unknown> = { ...COMMON, confirmation_number: "3f1c2a9e", channel_label: "online", amount_cents: 219_257n, received_on: "2026-09-03", credited_as_of: "2026-09-03", pending_settlement: true };

// ------------------------------------------------------------------ 2.2 partial payments
/** Amount held, balance needed, commitment date, how to send; C-1.1-02 and §1026.41(d)(5); channel per E-SIGN consent, else mail; within 1 BD of the hold. */
const SUSP_HOLD_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}We received your payment of {{money received_cents}} on {{date received_on}}. It is less than your full monthly payment of {{money periodic_payment_cents}} due {{date installment_due_date}}, so we are holding {{money held_cents}} in an unapplied funds account instead of applying it to your loan. We need {{money balance_needed_cents}} more to apply a full payment. Please send the balance by {{date commitment_due_on}}; when the full payment accumulates we will apply it as of the day the balance arrives.{{/block}}
{{#block "how" page=1 y=0.4 pt=10}}How to send the balance: online at {{portal_url}}, by phone at {{servicer_phone}}, or by check to {{remittance_address}} with your loan number. If the balance does not arrive by {{date commitment_due_on}} the funds held will be returned to you and the payment will remain unpaid.{{/block}}
{{#block "late" page=1 y=0.6 pt=10}}Under your note a late charge of {{money late_charge_if_unpaid_cents}} applies if the full payment is not received by {{date grace_end_on}}.{{/block}}
${CONTACT}`;
const SUSP_HOLD_RULES: ContentRule[] = [
  R("amount-held", "Servicing Guide C-1.1-02; 12 CFR 1026.41(d)(3)", "presence", "we are holding \\$[\\d,]+\\.\\d{2} in an unapplied funds account", "amount held"),
  R("balance-needed", "12 CFR 1026.41(d)(5)", "presence", "We need \\$[\\d,]+\\.\\d{2} more to apply a full payment", "balance needed"),
  R("commitment-date", "Servicing Guide C-1.1-02 (30-day commitment)", "presence", "Please send the balance by (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "commitment date"),
  R("how-to-send", "12 CFR 1026.41(d)(5) (what must be done for the funds to be applied)", "presence", "How to send the balance: online at .* by phone at .* or by check to", "how to send"),
  R("balance-ties", "2.2 rule 1 (s = P − (a + U))", "data_equality", "balance_needed_cents", "held + needed = periodic payment", { predicate: { "==": [{ "var": "check_sum_cents" }, { var: "periodic_payment_cents" }] } }),
  R("commitment-30-days", "Servicing Guide C-1.1-02 (within the next 30 days)", "data_range", "commitment_days_after_receipt", "commitment date ≤ 30 days after receipt", { range: { min: 1, max: 30 } }),
  R("sent-within-1bd", "2.2 guardrails (hold notice within 1 BD of the hold)", "data_range", "business_days_since_hold", "sent within 1 business day of the hold", { range: { min: 0, max: 1 } }),
  R("citation-c1102", "Servicing Guide C-1.1-02", "presence", "unapplied funds", "C-1.1-02 unapplied-funds language"),
  R("late-charge-disclosed", "Note ¶6(A); 12 CFR 1026.41(d)(1)(ii)", "presence", "late charge of \\$[\\d,]+\\.\\d{2} applies if the full payment is not received by", "late-charge consequence"),
];
const SUSP_HOLD_SAMPLE: Record<string, unknown> = { ...COMMON, received_cents: 200_000n, received_on: "2026-09-10", periodic_payment_cents: 219_257n, installment_due_date: "2026-09-01", held_cents: 200_000n, balance_needed_cents: 19_257n, check_sum_cents: 219_257n, commitment_due_on: "2026-10-10", commitment_days_after_receipt: 30, business_days_since_hold: 1, portal_url: "portal.example.com/pay", remittance_address: "Supermortgage, PO Box 7, Testville TX 75001", late_charge_if_unpaid_cents: 7_901n, grace_end_on: "2026-09-16" };

const SUSP_RETURN_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}On {{date received_on}} we received {{money amount_cents}}, less than your full monthly payment, and held it while you committed to send the balance by {{date commitment_due_on}}. The balance did not arrive, so on {{date returned_on}} we returned {{money amount_cents}} to you {{return_rail_text}}. Your payment due {{date installment_due_date}} remains unpaid; the full amount now due is {{money amount_due_cents}}.{{/block}}
${CONTACT}`;
const SUSP_RETURN_RULES: ContentRule[] = [
  R("amount-returned", "Servicing Guide C-1.1-02 (authorized to return); 6.5 rule 3", "presence", "we returned \\$[\\d,]+\\.\\d{2} to you", "amount returned"),
  R("rail", "2.2 rule 6 (by the original rail)", "presence", "(to the bank account it came from|by check to your mailing address)", "return rail"),
  R("installment-unpaid", "2.2 rule 6 (funds returned are not received for any purpose)", "presence", "remains unpaid", "the installment stays unpaid"),
  R("after-day-30", "2.2 rule 6 (returns at day 30)", "data_range", "days_after_commitment_date", "returned after the commitment date lapsed", { range: { min: 1 } }),
];
const SUSP_RETURN_SAMPLE: Record<string, unknown> = { ...COMMON, received_on: "2026-09-10", amount_cents: 200_000n, commitment_due_on: "2026-10-10", returned_on: "2026-10-11", return_rail_text: "by check to your mailing address", installment_due_date: "2026-09-01", amount_due_cents: 227_158n, days_after_commitment_date: 1 };

const SUSP_50RULE_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}Your payment of {{money amount_cents}} received {{date received_on}} was {{money shortfall_cents}} short of your full monthly payment. Because the shortage was $50.00 or less we applied the payment in full to your {{date installment_due_date}} installment and reduced the amount deposited to your escrow account by {{money shortfall_cents}}; no late charge applies. This is application {{count_12m}} of 3 permitted in a 12-month period; the escrow shortage will be collected at your next escrow analysis.{{/block}}
${CONTACT}`;
const SUSP_50RULE_RULES: ContentRule[] = [
  R("shortfall-le-50", "Servicing Guide C-1.1-02 ($50 rule)", "data_range", "shortfall_cents", "shortfall ≤ $50.00", { range: { min: 1, max: 5000 } }),
  R("escrow-reduced", "Servicing Guide C-1.1-02", "presence", "reduced the amount deposited to your escrow account by \\$[\\d,]+\\.\\d{2}", "escrow reduced by the shortfall"),
  R("no-late-charge", "2.2 rule 2", "presence", "no late charge applies", "no late charge"),
  R("count-le-3", "Servicing Guide C-1.1-02 (three per 12 months)", "data_range", "count_12m", "at most three in 12 months", { range: { min: 1, max: 3 } }),
];
const SUSP_50RULE_SAMPLE: Record<string, unknown> = { ...COMMON, amount_cents: 215_000n, received_on: "2026-09-08", shortfall_cents: 4_257n, installment_due_date: "2026-09-01", count_12m: 2 };

// ------------------------------------------------------------------ 2.3 autodraft
/** Copy of the authorization + terms (Reg E §1005.10(b)); the Nacha minimum elements; optional-enrollment statement (§1005.10(e)(1)); within 1 BD. */
const AUTODRAFT_CONFIRM_SOURCE = `{{#block "heading" page=1 y=0.05 pt=12 bold}}YOUR AUTOMATIC PAYMENT AUTHORIZATION — COPY FOR YOUR RECORDS{{/block}}
{{#block "terms" page=1 y=0.1 pt=10}}Consumer name: {{borrower_name}}. Loan number ending {{account_last4}}. Date of authorization: {{date authorized_on}}. Account to be debited: {{account_type}} account ending {{account_masked}} at routing number {{routing}}. Amount: {{amount_text}}. Timing and frequency: {{frequency_text}}, first debit on {{date first_debit_on}}. Debits will appear on your bank statement as "{{company_name}} MORTGAGE PMT".{{/block}}
{{#block "variable" page=1 y=0.35 pt=10}}Because your payment can change (for example after an escrow analysis or an interest-rate change), we will send you written notice of the new amount and date at least 10 days before a debit that differs from the previous one{{#if range_election}}, unless it stays within the range you elected ({{range_text}}){{/if}}.{{/block}}
{{#block "revoke" page=1 y=0.5 pt=10}}How to revoke: you may cancel this authorization at any time online, by calling {{servicer_phone}}, or by writing to {{servicer_address}}. A revocation we receive at least 3 business days before a scheduled debit stops that debit.{{/block}}
{{#block "optional" page=1 y=0.65 pt=10 bold}}Automatic payments are optional. Your loan does not require them and no term of your loan depends on them.{{/block}}
${CONTACT}`;
const AUTODRAFT_CONFIRM_RULES: ContentRule[] = [
  R("copy-provided", "12 CFR 1005.10(b) (provide a copy)", "presence", "COPY FOR YOUR RECORDS", "copy of the authorization"),
  R("nacha-consumer-name", "Nacha Meaningful Modernization (minimum elements)", "presence", "Consumer name: .+\\. Loan number", "consumer name"),
  R("nacha-account", "Nacha minimum elements", "presence", "account ending \\*+\\d{4} at routing number \\d{9}", "account to be debited (masked)"),
  R("nacha-amount", "Nacha minimum elements (amount or method of determining it)", "presence", "Amount: .+\\. Timing and frequency", "amount or method"),
  R("nacha-timing", "Nacha minimum elements", "presence", "Timing and frequency: .*first debit on", "timing/frequency and first debit date"),
  R("nacha-date", "Nacha minimum elements", "presence", "Date of authorization: (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "date of authorization"),
  R("nacha-revocation", "Nacha minimum elements; 12 CFR 1005.10(c)", "presence", "How to revoke: .* at least 3 business days before a scheduled debit stops that debit", "revocation instructions"),
  R("company-name", "2.3 rule 1 (SUPERMORTGAGE)", "presence", "\"SUPERMORTGAGE MORTGAGE PMT\"", "company name as it will appear"),
  R("variable-amount-notice", "12 CFR 1005.10(d)(1)", "presence", "at least 10 days before a debit that differs", "variable-amount notice statement"),
  R("optional", "12 CFR 1005.10(e)(1) (compulsory use)", "layout", "optional", "optional-enrollment statement, prominent", { layout: { page: 1, bold: true } }),
  R("account-masked", "2.3 guardrails (never read back full account numbers); PII", "data_equality", "account_masked", "account number masked to last 4", { predicate: { matches: ["account_masked", "^\\*+\\d{4}$"] } }),
  R("sent-within-1bd", "SM_AUTODRAFT_COPY_DELIVERY_1BD", "data_range", "business_days_after_authorization", "delivered within 1 BD", { range: { min: 0, max: 1 } }),
];
const AUTODRAFT_CONFIRM_SAMPLE: Record<string, unknown> = { ...COMMON, borrower_name: "Bea Borrower", authorized_on: "2026-09-20", account_type: "checking", account_masked: "******9876", routing: "021000021", amount_text: "your full monthly payment (currently $2,192.57) plus $100.00 additional principal", frequency_text: "monthly on the 1st", first_debit_on: "2026-10-01", company_name: "SUPERMORTGAGE", range_election: false, servicer_address: "PO Box 1, Testville TX 75001", business_days_after_authorization: 1 };

const AUTODRAFT_AMOUNT_CHANGE_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}Your automatic payment amount is changing. On {{date debit_on}} we will debit {{money new_amount_cents}} from your account ending {{account_masked}} (previously {{money prior_amount_cents}}). Reason: {{reason}}. If you do not want this debit, contact us at least 3 business days before {{date debit_on}}.{{/block}}
${CONTACT}`;
const AUTODRAFT_AMOUNT_CHANGE_RULES: ContentRule[] = [
  R("amount-and-date", "12 CFR 1005.10(d)(1)", "presence", "On (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4} we will debit \\$[\\d,]+\\.\\d{2}", "amount and date of the transfer"),
  R("ten-days", "12 CFR 1005.10(d)(1) (at least 10 days before)", "data_range", "days_before_debit", "sent ≥ 10 days before the scheduled debit", { range: { min: 10 } }),
  R("stop-window", "12 CFR 1005.10(c)", "presence", "at least 3 business days before", "stop-payment window"),
];
const AUTODRAFT_AMOUNT_CHANGE_SAMPLE: Record<string, unknown> = { ...COMMON, debit_on: "2027-01-01", new_amount_cents: 232_933n, prior_amount_cents: 229_257n, account_masked: "******9876", reason: "your escrow payment changed after the annual escrow analysis", days_before_debit: 20 };

const AUTODRAFT_REVOKED_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}We received your request on {{date revoked_on}} to cancel automatic payments for your loan, and we have cancelled them{{#if stopped_debit_on}}; the debit scheduled for {{date stopped_debit_on}} will not be made{{/if}}. {{#if refund_on}}A debit that settled after your request was refunded to your account on {{date refund_on}}. {{/if}}Next steps: your payment of {{money periodic_payment_cents}} remains due on the {{due_day}} of each month; you can pay online, by phone at {{servicer_phone}}, or by mail to {{remittance_address}}. Your authorization record is kept for two years after this cancellation.{{/block}}
${CONTACT}`;
const AUTODRAFT_REVOKED_RULES: ContentRule[] = [
  R("confirmation", "12 CFR 1005.10(c); 2.3 rule 6", "presence", "we have cancelled them", "revocation confirmed"),
  R("next-steps", "2.3 outputs (next steps)", "presence", "Next steps: .* remains due on the .* of each month", "how to keep paying"),
  R("retention", "Nacha (retain 2 years from revocation)", "presence", "kept for two years after this cancellation", "retention statement"),
];
const AUTODRAFT_REVOKED_SAMPLE: Record<string, unknown> = { ...COMMON, revoked_on: "2026-09-27", stopped_debit_on: "2026-10-01", refund_on: null, periodic_payment_cents: 219_257n, due_day: "1st", remittance_address: "Supermortgage, PO Box 7, Testville TX 75001" };

const AUTODRAFT_RETURN_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}The automatic payment of {{money amount_cents}} we debited on {{date settlement_date}} was returned by your bank on {{date returned_on}} ({{return_code}}: {{return_reason}}). The payment has been reversed and your {{date installment_due_date}} installment is unpaid. {{#if nsf_fee_cents}}A returned-payment fee of {{money nsf_fee_cents}} has been charged as permitted by your loan documents and state law. {{/if}}{{#if retry_on}}We will retry the debit on {{date retry_on}} as "RETRY PYMT" unless you pay another way first. {{/if}}Alternatives: pay online, by phone at {{servicer_phone}}, or by mail to {{remittance_address}}.{{/block}}
${CONTACT}`;
const AUTODRAFT_RETURN_RULES: ContentRule[] = [
  R("return-reason", "2.3 rule 7", "presence", "returned by your bank on .* \\(R\\d{2}: .+\\)", "return reason"),
  R("fee-if-any", "2.7 rule 7; 12 CFR 1026.41(d)(4)", "conditional", "nsf_fee_cents", "fee disclosed when charged", { when: { ">": [{ var: "nsf_fee_cents" }, 0] }, predicate: { present: "nsf_fee_cents" } }),
  R("retry-date", "Nacha reinitiation rules (RETRY PYMT)", "conditional", "retry_on", "retry date when a reinitiation is scheduled", { when: { present: "retry_on" }, predicate: { present: "retry_on" } }),
  R("alternatives", "2.3 outputs (alternatives)", "presence", "Alternatives: pay online", "alternatives"),
  R("retry-label", "Nacha Network Risk (reinitiated entries carry RETRY PYMT)", "conditional", "retry_on", "RETRY PYMT description", { when: { present: "retry_on" }, predicate: { "==": [{ var: "company_entry_description" }, "RETRY PYMT"] } }),
];
const AUTODRAFT_RETURN_SAMPLE: Record<string, unknown> = { ...COMMON, amount_cents: 229_257n, settlement_date: "2027-02-01", returned_on: "2027-02-03", return_code: "R01", return_reason: "insufficient funds", installment_due_date: "2027-02-01", nsf_fee_cents: 2_500n, retry_on: "2027-02-08", company_entry_description: "RETRY PYMT", remittance_address: "Supermortgage, PO Box 7, Testville TX 75001" };

const AUTODRAFT_RETRY_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}Advance notice: on {{date retry_on}} we will reinitiate the returned debit of {{money amount_cents}} from your account ending {{account_masked}}. It will appear as "SUPERMORTGAGE RETRY PYMT". This is reinitiation {{attempt}} of at most 2 within 180 days; if it is returned again, automatic payments will be suspended until you contact us.{{/block}}
${CONTACT}`;
const AUTODRAFT_RETRY_RULES: ContentRule[] = [
  R("date-amount", "2.3 rule 7", "presence", "on (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4} we will reinitiate the returned debit of \\$[\\d,]+\\.\\d{2}", "retry date and amount"),
  R("retry-pymt", "Nacha Network Risk", "presence", "RETRY PYMT", "RETRY PYMT description"),
  R("max-two", "Nacha (≤ 2 reinitiations in 180 days)", "data_range", "attempt", "at most the second reinitiation", { range: { min: 1, max: 2 } }),
];
const AUTODRAFT_RETRY_SAMPLE: Record<string, unknown> = { ...COMMON, retry_on: "2027-02-08", amount_cents: 229_257n, account_masked: "******9876", attempt: 1 };

const AUTODRAFT_SUSPENDED_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}Automatic payments for your loan are suspended as of {{date suspended_on}} because {{reason_text}}. No further debits will be made until {{resume_condition}}. Your payment of {{money periodic_payment_cents}} remains due on the {{due_day}} of each month; pay online, by phone at {{servicer_phone}}, or by mail to {{remittance_address}} in the meantime.{{/block}}
${CONTACT}`;
const AUTODRAFT_SUSPENDED_RULES: ContentRule[] = [
  R("reason", "2.3 rule 7 (suspended_returns / administrative return / stop payment)", "presence", "suspended as of .* because .+\\. No further debits", "reason for the suspension"),
  R("resume", "2.3 state machine (suspended_returns → active on borrower re-confirmation; R08 needs a new authorization)", "presence", "until (you confirm|you provide|we receive a new authorization)", "what resumes drafting"),
  R("keep-paying", "2.3 outputs", "presence", "remains due on the", "payment still due"),
];
const AUTODRAFT_SUSPENDED_SAMPLE: Record<string, unknown> = { ...COMMON, suspended_on: "2027-02-10", reason_text: "two debits for the same installment were returned for insufficient funds", resume_condition: "you confirm with us that the account can be debited again", periodic_payment_cents: 219_257n, due_day: "1st", remittance_address: "Supermortgage, PO Box 7, Testville TX 75001" };

// ------------------------------------------------------------------ 2.4 curtailments and re-amortization
const CURTAIL_CONFIRM_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}We applied {{money amount_cents}} you designated as additional principal on {{date applied_on}}. Your principal balance is now {{money new_upb_cents}}. Your payment due date and monthly payment amount do not change (Note section 4); interest on your next installment is computed on the reduced balance.{{/block}}
${CONTACT}`;
const CURTAIL_CONFIRM_RULES: ContentRule[] = [
  R("amount-applied", "Servicing Guide C-1.2-01", "presence", "We applied \\$[\\d,]+\\.\\d{2} you designated as additional principal", "amount applied"),
  R("new-balance", "2.4 outputs", "presence", "principal balance is now \\$[\\d,]+\\.\\d{2}", "new principal balance"),
  R("no-change", "Form 3200 §4 (no change in due date or payment)", "presence", "payment due date and monthly payment amount do not change", "due date / payment unchanged"),
  R("balance-ties", "2.4 rule 2", "data_equality", "new_upb_cents", "new UPB = prior UPB − curtailment", { predicate: { "==": [{ var: "new_upb_cents" }, { var: "expected_upb_cents" }] } }),
  R("electronic-with-consent-else-statement", "2.4 outputs (electronic with consent, else on the next statement); 15 U.S.C. 7001(c)", "data_equality", "esign_consent", "sent electronically only to a borrower with E-SIGN consent; otherwise carried on the next periodic statement (channel_rule=next_statement), never mailed on its own", { predicate: { or: [{ "==": [{ var: "esign_consent" }, true] }, { "==": [{ var: "channel_rule" }, "next_statement"] }] } }),
];
const CURTAIL_CONFIRM_SAMPLE: Record<string, unknown> = { ...COMMON, amount_cents: 100_000n, applied_on: "2026-09-03", new_upb_cents: 24_854_677n, expected_upb_cents: 24_854_677n };

const CURTAIL_REDIRECT_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}We received {{money amount_cents}} on {{date received_on}} marked "principal only". Because your loan was past due, Fannie Mae's servicing rules (Servicing Guide C-1.2-01) require additional principal to be applied first toward bringing the loan current. We applied {{money applied_to_installments_cents}} to your {{date installment_due_date}} installment and are holding {{money held_cents}} toward your next payment{{#if principal_reduced_cents}}; {{money principal_reduced_cents}} reduced your principal{{/if}}. Principal reduction resumes once your loan is current.{{/block}}
${CONTACT}`;
const CURTAIL_REDIRECT_RULES: ContentRule[] = [
  R("citation", "Servicing Guide C-1.2-01", "presence", "C-1\\.2-01", "citation"),
  R("cure-first", "Servicing Guide C-1.2-01 (must first be applied toward curing the delinquency)", "presence", "applied first toward bringing the loan current", "cure-first explanation"),
  R("held", "2.4 rule 3", "presence", "holding \\$[\\d,]+\\.\\d{2} toward your next payment", "amount held toward the next installment"),
  R("resumes", "2.4 rule 3", "presence", "Principal reduction resumes once your loan is current", "resumption statement"),
];
const CURTAIL_REDIRECT_SAMPLE: Record<string, unknown> = { ...COMMON, amount_cents: 300_000n, received_on: "2026-10-20", applied_to_installments_cents: 219_257n, installment_due_date: "2026-09-01", held_cents: 80_743n, principal_reduced_cents: 0n };

const REAMORT_OFFER_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}After your principal curtailment of {{money curtailment_cents}}, you may re-amortize your loan. Fannie Mae Form 181 (Agreement for Modification, Re-Amortization, or Extension of a Mortgage) is enclosed: your principal and interest payment would change from {{money current_pi_cents}} to {{money new_pi_cents}}, effective with the payment due {{date effective_on}}, based on your balance of {{money upb_cents}} at {{pct rate_pct}} over the remaining {{remaining_term_months}} months. Your interest rate and maturity date do not change and there is no fee. A re-amortization is not a loan modification. {{#if borrower_execution_required}}Please sign and return the enclosed agreement by {{date return_by}}.{{else}}No signature is required; the agreement will be executed by our signing officer and a copy sent to you.{{/if}}{{/block}}
${CONTACT}`;
const REAMORT_OFFER_RULES: ContentRule[] = [
  R("form-181", "Servicing Guide C-1.2-01 (Form 181)", "presence", "Form 181", "Form 181 named"),
  R("new-payment", "2.4 rule 6", "presence", "would change from \\$[\\d,]+\\.\\d{2} to \\$[\\d,]+\\.\\d{2}, effective with the payment due", "old and new P&I with the effective date"),
  R("no-fee", "2.4 rule 6 [policy: no fee]; A2-3-05", "presence", "there is no fee", "no fee"),
  R("not-a-modification", "Servicing Guide C-1.2-01 (not a modification for eligibility)", "presence", "not a loan modification", "not-a-modification statement"),
  R("signature", "Servicing Guide C-1.2-01 (borrower execution where needed for enforceability)", "conditional", "borrower_execution_required", "signature request when the state requires execution", { when: { "==": [{ var: "borrower_execution_required" }, true] }, predicate: { present: "return_by" } }),
  R("effective-30-days", "2.4 rule 6 (first installment due ≥ 30 days after execution)", "data_range", "days_from_execution_to_effective", "effective ≥ 30 days after execution", { range: { min: 30 } }),
];
const REAMORT_OFFER_SAMPLE: Record<string, unknown> = { ...COMMON, curtailment_cents: 5_000_000n, current_pi_cents: 158_017n, new_pi_cents: 127_162n, effective_on: "2026-12-01", upb_cents: 19_854_677n, rate_pct: "6.500", remaining_term_months: 346, borrower_execution_required: false, return_by: null, days_from_execution_to_effective: 42 };

/** New payment and date; doubles as the Reg E 10-day notice for autodraft borrowers when sent ≥ 10 days ahead. */
const REAMORT_EFFECTIVE_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}Your re-amortization is effective. Beginning with the payment due {{date effective_on}}, your monthly payment is {{money new_total_payment_cents}} (principal and interest {{money new_pi_cents}} plus escrow {{money escrow_cents}}). {{#if autodraft}}Your automatic payment of {{money new_total_payment_cents}} will be drafted on {{date next_debit_on}} from your account ending {{account_masked}}.{{/if}}{{/block}}
${CONTACT}`;
const REAMORT_EFFECTIVE_RULES: ContentRule[] = [
  R("new-payment-and-date", "2.4 outputs", "presence", "Beginning with the payment due .*, your monthly payment is \\$[\\d,]+\\.\\d{2}", "new payment and date"),
  R("reg-e-amount-date", "12 CFR 1005.10(d)(1)", "conditional", "autodraft", "exact debit amount and date for autodraft borrowers", { when: { "==": [{ var: "autodraft" }, true] }, predicate: { and: [{ present: "next_debit_on" }, { present: "new_total_payment_cents" }] } }),
  R("reg-e-ten-days", "12 CFR 1005.10(d)(1) (≥ 10 days before)", "conditional", "days_before_debit", "sent ≥ 10 days before the changed debit", { when: { "==": [{ var: "autodraft" }, true] }, predicate: { ">=": [{ var: "days_before_debit" }, 10] } }),
  R("total-ties", "2.3 rule 4 (amount = P&I + escrow)", "data_equality", "new_total_payment_cents", "total = P&I + escrow", { predicate: { "==": [{ var: "new_total_payment_cents" }, { var: "check_total_cents" }] } }),
];
const REAMORT_EFFECTIVE_SAMPLE: Record<string, unknown> = { ...COMMON, effective_on: "2026-12-01", new_total_payment_cents: 188_402n, check_total_cents: 188_402n, new_pi_cents: 127_162n, escrow_cents: 61_240n, autodraft: true, next_debit_on: "2026-12-01", account_masked: "******9876", days_before_debit: 21 };

// ------------------------------------------------------------------ 2.5 third-party biweekly programs
const THIRDPARTY_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}You told us that {{contractor_name}} will send your mortgage payments. Please note: Supermortgage is not a party to your arrangement with {{contractor_name}} and does not endorse, market or receive any payment from it. Partial (half) payments are held in an unapplied funds account until a full monthly payment accumulates, and are applied as of the day the full payment accumulates. Late charges follow your note: if a full payment is not received by the {{grace_day}} of the month a late charge of {{money late_charge_cents}} applies regardless of when the contractor debited you. Extra amounts are applied to principal only when designated as principal. A free option exists: Supermortgage's in-house split payment plan debits half your payment on the 1st and 15th with no fee.{{/block}}
${CONTACT}`;
const THIRDPARTY_RULES: ContentRule[] = [
  R("not-party", "2.5 rule 6 (no endorsement / no compensation); UDAAP", "presence", "not a party to your arrangement", "not party to the arrangement"),
  R("no-endorsement", "2.5 rule 6", "presence", "does not endorse, market or receive any payment", "no endorsement or compensation"),
  R("halves-held", "12 CFR 1026.36(c)(1)(ii); 2.5 rule 2", "presence", "held in an unapplied funds account until a full monthly payment accumulates", "halves held until accumulation"),
  R("late-charges", "2.5 rule 3", "presence", "Late charges follow your note", "late charges follow the note"),
  R("principal-only-when-designated", "Form 3200 §4; C-1.2-01", "presence", "applied to principal only when designated", "extra applied to principal only when designated"),
  R("free-option", "2.5 rule 6 / guardrails (always mention the free in-house option)", "presence", "A free option exists", "free in-house option"),
  R("no-marketing", "2.5 guardrails (never market or recommend a contractor)", "absence", "we recommend|we endorse", "no recommendation language"),
];
const THIRDPARTY_SAMPLE: Record<string, unknown> = { ...COMMON, contractor_name: "BiWeekly Co.", grace_day: "16th", late_charge_cents: 7_901n };

// ------------------------------------------------------------------ 2.6 trial period plans
const TRIAL_RECEIVED_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}We received your trial period plan payment {{trial_number}} of {{trial_count}} — {{money amount_cents}} on {{date received_on}}. {{#if satisfied}}This satisfies the trial payment due {{date due_on}}.{{else}}We have received {{money cumulative_cents}} of the {{money trial_amount_cents}} due by {{date month_end}}.{{/if}} Trial payments are held as unapplied funds in a custodial account until a full contractual payment accumulates or the trial completes; we are currently holding {{money held_cents}}.{{/block}}
${CONTACT}`;
const TRIAL_RECEIVED_RULES: ContentRule[] = [
  R("trial-number", "Servicing Guide D2-3.2-06; F-1-22", "presence", "trial period plan payment \\d of \\d", "trial number and count"),
  R("held", "Servicing Guide C-1.1-02 (accept and hold as unapplied funds)", "presence", "held as unapplied funds in a custodial account", "held-funds statement"),
  R("month-end-deadline", "Servicing Guide D2-3.2-06 (by the last day of the month)", "conditional", "satisfied", "month-end deadline when not yet satisfied", { when: { "==": [{ var: "satisfied" }, false] }, predicate: { present: "month_end" } }),
  R("electronic-only-with-consent", "2.6 outputs (optional confirmation; electronic with consent, else none); 15 U.S.C. 7001(c)", "data_equality", "esign_consent", "sent only to a borrower with E-SIGN consent", { predicate: { "==": [{ var: "esign_consent" }, true] } }),
];
const TRIAL_RECEIVED_SAMPLE: Record<string, unknown> = { ...COMMON, trial_number: 1, trial_count: 3, amount_cents: 195_900n, received_on: "2026-10-01", satisfied: true, due_on: "2026-10-01", cumulative_cents: 195_900n, trial_amount_cents: 195_900n, month_end: "2026-10-31", held_cents: 195_900n };

const TRIAL_APPLIED_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}Your held trial period payments now total a full contractual payment. As Fannie Mae's servicing rules require (Servicing Guide C-1.1-02), on {{date applied_on}} we applied {{money applied_cents}} to your {{date installment_due_date}} installment (interest {{money interest_cents}}, principal {{money principal_cents}}, escrow {{money escrow_cents}}). This does not change your trial period plan; we continue to hold {{money held_cents}} toward your next trial payment{{#if late_charges_suspended}}, and late charges assessed during the trial are suspended and will be waived when your modification takes effect{{/if}}.{{/block}}
${CONTACT}`;
const TRIAL_APPLIED_RULES: ContentRule[] = [
  R("citation", "Servicing Guide C-1.1-02 (must apply all full payments)", "presence", "C-1\\.1-02", "citation"),
  R("application", "2.6 rule 2", "presence", "we applied \\$[\\d,]+\\.\\d{2} to your .* installment \\(interest .*, principal .*, escrow .*\\)", "application detail"),
  R("trial-unchanged", "LL-2026-01; 2.6 edge cases", "presence", "does not change your trial period plan", "trial status unaffected"),
  R("amount-ties", "2.1 rule 5", "data_equality", "applied_cents", "applied = interest + principal + escrow", { predicate: { "==": [{ var: "applied_cents" }, { var: "check_sum_cents" }] } }),
];
const TRIAL_APPLIED_SAMPLE: Record<string, unknown> = { ...COMMON, applied_on: "2026-11-02", applied_cents: 219_257n, check_sum_cents: 219_257n, installment_due_date: "2026-07-01", interest_cents: 135_294n, principal_cents: 22_723n, escrow_cents: 61_240n, held_cents: 172_543n, late_charges_suspended: true };

const TRIAL_COMPLETE_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}You completed your trial period plan. The {{money residual_cents}} of trial payments still held was applied on {{date applied_on}} to reduce the amount that would otherwise be added to your loan balance (Servicing Guide C-1.1-02): {{money applied_to_interest_cents}} to unpaid interest{{#if applied_to_escrow_advances_cents}} and {{money applied_to_escrow_advances_cents}} to escrow advances{{/if}}. All late charges on your loan — {{money late_charges_waived_cents}} — have been waived and none were added to your balance (Servicing Guide D2-3.2-06; F-1-27). Your modification is effective {{date effective_on}}.{{/block}}
${CONTACT}`;
const TRIAL_COMPLETE_RULES: ContentRule[] = [
  R("residual-applied", "Servicing Guide C-1.1-02 (unapplied funds reduce capitalization)", "presence", "applied on .* to reduce the amount that would otherwise be added to your loan balance", "residual reduces capitalization"),
  R("late-charges-waived", "Servicing Guide D2-3.2-06; F-1-27", "presence", "late charges on your loan — \\$[\\d,]+\\.\\d{2} — have been waived", "late charges waived"),
  R("none-capitalized", "Servicing Guide F-1-27 (late charges may not be capitalized)", "data_equality", "late_charges_capitalized_cents", "no late charge capitalized", { predicate: { "==": [{ var: "late_charges_capitalized_cents" }, 0] } }),
  R("before-effective", "FNMA_C1102_TRIAL_RESIDUAL_BEFORE_EFFECTIVE_0", "data_range", "days_applied_before_effective", "residual applied before the effective date", { range: { min: 1 } }),
];
const TRIAL_COMPLETE_SAMPLE: Record<string, unknown> = { ...COMMON, residual_cents: 149_186n, applied_on: "2026-12-31", applied_to_interest_cents: 149_186n, applied_to_escrow_advances_cents: 0n, late_charges_waived_cents: 47_406n, late_charges_capitalized_cents: 0n, effective_on: "2027-01-01", days_applied_before_effective: 1 };

const TRIAL_FAILED_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}Your trial period plan ended on {{date failed_on}} because the trial payment due {{date missed_due_on}} was not received by {{date month_end}} (Servicing Guide D2-3.2-06). What happens to the {{money held_cents}} we hold: {{#if applied}}because it covers a full contractual payment, we applied {{money applied_cents}} to your {{date installment_due_date}} installment{{#if remaining_cents}} and continue to hold {{money remaining_cents}}{{/if}}.{{else}}it is less than a full contractual payment, so we will hold it for 30 days while we contact you about other options; if no arrangement is made by {{date return_by}} it will be returned to you.{{/if}} Late charges suspended during the trial ({{money released_late_charges_cents}}) are now due.{{/block}}
${CONTACT}`;
const TRIAL_FAILED_RULES: ContentRule[] = [
  R("why", "Servicing Guide D2-3.2-06 (failed if not paid by the last day of the month)", "presence", "was not received by", "failure reason"),
  R("funds-disposition", "2.6 rule 6 / 2.6-Q3", "presence", "What happens to the \\$[\\d,]+\\.\\d{2} we hold:", "disposition of held funds"),
  R("thirty-days", "SM_TRIAL_FAILED_FUNDS_RESOLVE_30", "conditional", "applied", "30-day hold with contact when below PITI", { when: { "==": [{ var: "applied" }, false] }, predicate: { present: "return_by" } }),
  R("late-charges-collectible", "Servicing Guide D2-3.2-06 (authorized to assess)", "presence", "suspended during the trial .* are now due", "suspended charges collectible"),
];
const TRIAL_FAILED_SAMPLE: Record<string, unknown> = { ...COMMON, failed_on: "2026-12-31", missed_due_on: "2026-12-01", month_end: "2026-12-31", held_cents: 172_543n, applied: false, applied_cents: 0n, installment_due_date: null, remaining_cents: 0n, return_by: "2027-01-30", released_late_charges_cents: 7_901n };

// ------------------------------------------------------------------ 2.7 fees
const LC_NSF_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}Your payment of {{money payment_cents}} dated {{date settlement_date}} was returned by your bank on {{date returned_on}} ({{return_code}}). A returned-payment fee of {{money fee_cents}} has been charged as authorized by {{authority}}. How to avoid this fee: keep sufficient funds available on your draft date, or pay by another method. This fee is listed on your next statement.{{/block}}
${CONTACT}`;
const LC_NSF_RULES: ContentRule[] = [
  R("amount", "2.7 rule 7", "presence", "returned-payment fee of \\$[\\d,]+\\.\\d{2}", "fee amount"),
  R("authority", "2.7 rule 7 (document or state-law authority); FDCPA §808(1)", "presence", "as authorized by .+\\. How to avoid", "authority stated"),
  R("how-to-avoid", "2.7 outputs", "presence", "How to avoid this fee", "how to avoid"),
  R("within-cap", "2.7 rule 7 (min(policy $25, state cap))", "data_range", "fee_over_cap", "fee ≤ the state cap", { range: { max: 0 } }),
  R("once-per-item", "2.7 rule 7 (once per returned item)", "data_range", "fees_for_this_item", "one fee per returned item", { range: { max: 1 } }),
  R("statement", "12 CFR 1026.41(d)(4)", "presence", "listed on your next statement", "statement disclosure"),
];
const LC_NSF_SAMPLE: Record<string, unknown> = { ...COMMON, payment_cents: 229_257n, settlement_date: "2027-02-01", returned_on: "2027-02-03", return_code: "R01", fee_cents: 2_500n, authority: "your note and Texas law", fee_over_cap: 0, fees_for_this_item: 1 };

const LC_WAIVER_SOURCE = `{{#block "body" page=1 y=0.08 pt=11}}We have waived the late charge of {{money waived_cents}} assessed on {{date assessed_on}} for your {{date installment_due_date}} installment ({{reason_text}}). Nothing further is due for this charge{{#if refund_cents}}, and {{money refund_cents}} you had paid toward it is being refunded{{/if}}.{{/block}}
${CONTACT}`;
const LC_WAIVER_RULES: ContentRule[] = [
  R("amount", "2.7 rule 5", "presence", "waived the late charge of \\$[\\d,]+\\.\\d{2}", "waived amount"),
  R("reason", "2.7 rule 5 (reason codes)", "presence", "installment \\(.+\\)\\.", "waiver reason"),
  R("no-conditioning", "2.7 rule 5 (never conditioned on enrollment); Reg E compulsory-use analog", "absence", "enroll|sign up|autopay", "not conditioned on any product"),
];
const LC_WAIVER_SAMPLE: Record<string, unknown> = { ...COMMON, waived_cents: 7_901n, assessed_on: "2026-09-17", installment_due_date: "2026-09-01", reason_text: "one-time courtesy waiver", refund_cents: 0n };

// ------------------------------------------------------------------ registry entries
export const SECTION_02_TEMPLATES: readonly NoticeTemplate[] = [
  T("PAY-REQUIREMENTS-v1", "2.1", "written payment requirements", "12 CFR 1026.36(c)(1)(iii); comment 36(c)(1)(iii)-1, -2", "servicing_general", "esign_or_mail", { mayCombineWith: ["NTC_REGX_1024_33B_HELLO_MS2", "NTC_REGZ_41_STMT_STD", "NTC_REGZ_41_STMT_DELQ"] }),
  T("PAY-NONCONFORMING-v1", "2.1", "accepted non-conforming payment", "12 CFR 1026.36(c)(1)(iii); 12 CFR 1024.35(b)(1)", "servicing_general", "esign_or_mail"),
  T("PAY-CONFIRM-v1", "2.1", "payment confirmation", "2.1 outputs (service notice; electronic only with consent)", "payment_confirmations", "esign_or_mail", { piiLevel: "low" }),
  T("SUSP-PARTIAL-HOLD-v1", "2.2", "partial payment held", "Servicing Guide C-1.1-02; 12 CFR 1026.41(d)(5)", "servicing_general", "esign_or_mail"),
  T("SUSP-PARTIAL-RETURN-v1", "2.2", "partial payment returned", "Servicing Guide C-1.1-02; 6.5 rule 3", "servicing_general", "esign_or_mail"),
  T("SUSP-50RULE-APPLIED-v1", "2.2", "short payment applied under the $50 rule", "Servicing Guide C-1.1-02 ($50 rule); 2.2-Q2 (statement may carry it)", "servicing_general", "esign_or_mail", { mayCombineWith: ["NTC_REGZ_41_STMT_STD"] }),
  T("AUTODRAFT-CONFIRM-v1", "2.3", "autodraft authorization copy", "12 CFR 1005.10(b); Nacha Operating Rules (authorization minimum elements)", "autodraft", "esign_or_mail"),
  T("AUTODRAFT-AMOUNT-CHANGE-v1", "2.3", "autodraft variable-amount notice", "12 CFR 1005.10(d)(1)", "autodraft", "esign_or_mail", { mayCombineWith: ["NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT", "REAMORT-EFFECTIVE-v1"] }),
  T("AUTODRAFT-REVOKED-v1", "2.3", "autodraft revocation confirmation", "12 CFR 1005.10(c); Nacha (2-year retention)", "autodraft", "esign_or_mail"),
  T("AUTODRAFT-RETURN-v1", "2.3", "autodraft return notice", "2.3 rule 7; Nacha reinitiation rules", "autodraft", "esign_or_mail", { mayCombineWith: ["LC-NSF-FEE-v1", "AUTODRAFT-RETRY-v1"] }),
  T("AUTODRAFT-RETRY-v1", "2.3", "autodraft reinitiation notice", "Nacha Network Risk and Enforcement (RETRY PYMT)", "autodraft", "esign_or_mail", { mayCombineWith: ["AUTODRAFT-RETURN-v1"] }),
  T("AUTODRAFT-SUSPENDED-v1", "2.3", "autodraft suspended", "2.3 rule 7; 2.3 state machine (suspended_returns)", "autodraft", "esign_or_mail"),
  T("CURTAIL-CONFIRM-v1", "2.4", "curtailment confirmation", "Servicing Guide C-1.2-01; Form 3200 §4", "servicing_general", "esign_or_mail", { mayCombineWith: ["NTC_REGZ_41_STMT_STD"] }),
  T("CURTAIL-REDIRECT-v1", "2.4", "curtailment redirected to cure", "Servicing Guide C-1.2-01 (delinquent loans)", "servicing_general", "esign_or_mail"),
  T("REAMORT-OFFER-v1", "2.4", "re-amortization offer with Form 181", "Servicing Guide C-1.2-01 (Form 181)", "servicing_general", "esign_or_mail", { separateDocument: true }),
  T("REAMORT-EFFECTIVE-v1", "2.4", "re-amortization effective", "Servicing Guide C-1.2-01; 12 CFR 1005.10(d)(1) when it carries the debit amount and date", "servicing_general", "esign_or_mail"),
  T("THIRDPARTY-BIWEEKLY-INFO-v1", "2.5", "third-party biweekly program information", "Servicing Guide C-1.1-04; 12 CFR 1026.36(c)(1)(ii); UDAAP", "servicing_general", "esign_or_mail"),
  T("TRIAL-PAYMENT-RECEIVED-v1", "2.6", "trial payment received", "Servicing Guide C-1.1-02; D2-3.2-06", "lossmit", "esign_or_mail", { piiLevel: "low" }),
  T("TRIAL-FUNDS-APPLIED-v1", "2.6", "trial funds applied to a contractual installment", "Servicing Guide C-1.1-02", "lossmit", "esign_or_mail"),
  T("TRIAL-COMPLETE-FUNDS-v1", "2.6", "trial complete: residual applied, late charges waived", "Servicing Guide C-1.1-02; D2-3.2-06; F-1-27", "lossmit", "esign_or_mail", { mayCombineWith: ["NTC_REGX_41_MOD_AGREEMENT"] }),
  T("TRIAL-FAILED-FUNDS-v1", "2.6", "trial failed: held funds", "Servicing Guide C-1.1-02; D2-3.2-06; F-1-22", "lossmit", "esign_or_mail"),
  T("LC-NSF-FEE-v1", "2.7", "returned-payment fee", "2.7 rule 7; 12 CFR 1026.41(d)(4); FDCPA §808(1)", "servicing_general", "esign_or_mail", { mayCombineWith: ["AUTODRAFT-RETURN-v1"] }),
  T("LC-WAIVER-CONFIRM-v1", "2.7", "late-charge waiver confirmation", "2.7 rule 5", "servicing_general", "esign_or_mail", { mayCombineWith: ["NTC_REGZ_41_STMT_STD"], piiLevel: "low" }),
];

export const SECTION_02_VERSIONS: readonly VersionInput[] = [
  V("PAY-REQUIREMENTS-v1", PAY_REQUIREMENTS_SOURCE, PAY_REQUIREMENTS_RULES, PAY_REQUIREMENTS_SAMPLE, "regz.payment_requirements.2013", "2.1 operational prerequisites (written payment requirements)"),
  V("PAY-NONCONFORMING-v1", PAY_NONCONFORMING_SOURCE, PAY_NONCONFORMING_RULES, PAY_NONCONFORMING_SAMPLE, "regz.payment_requirements.2013", "2.1 worked example B"),
  V("PAY-CONFIRM-v1", PAY_CONFIRM_SOURCE, PAY_CONFIRM_RULES, PAY_CONFIRM_SAMPLE, "sm.cashiering.v1", "2.1 worked example A (portal channel)"),
  V("SUSP-PARTIAL-HOLD-v1", SUSP_HOLD_SOURCE, SUSP_HOLD_RULES, SUSP_HOLD_SAMPLE, "fnma.c1102.2025", "2.2 worked example C"),
  V("SUSP-PARTIAL-RETURN-v1", SUSP_RETURN_SOURCE, SUSP_RETURN_RULES, SUSP_RETURN_SAMPLE, "fnma.c1102.2025", "2.2-T7 / 6.5 rule 3"),
  V("SUSP-50RULE-APPLIED-v1", SUSP_50RULE_SOURCE, SUSP_50RULE_RULES, SUSP_50RULE_SAMPLE, "fnma.c1102.2025", "2.2 worked example D"),
  V("AUTODRAFT-CONFIRM-v1", AUTODRAFT_CONFIRM_SOURCE, AUTODRAFT_CONFIRM_RULES, AUTODRAFT_CONFIRM_SAMPLE, "rege.1005_10.2026", "2.3 worked example E (WEB enrollment)"),
  V("AUTODRAFT-AMOUNT-CHANGE-v1", AUTODRAFT_AMOUNT_CHANGE_SOURCE, AUTODRAFT_AMOUNT_CHANGE_RULES, AUTODRAFT_AMOUNT_CHANGE_SAMPLE, "rege.1005_10.2026", "2.3 worked example E (escrow change to $2,329.33)"),
  V("AUTODRAFT-REVOKED-v1", AUTODRAFT_REVOKED_SOURCE, AUTODRAFT_REVOKED_RULES, AUTODRAFT_REVOKED_SAMPLE, "rege.1005_10.2026", "2.3-T4"),
  V("AUTODRAFT-RETURN-v1", AUTODRAFT_RETURN_SOURCE, AUTODRAFT_RETURN_RULES, AUTODRAFT_RETURN_SAMPLE, "nacha.2026", "2.3 worked example E (R01 2027-02-03)"),
  V("AUTODRAFT-RETRY-v1", AUTODRAFT_RETRY_SOURCE, AUTODRAFT_RETRY_RULES, AUTODRAFT_RETRY_SAMPLE, "nacha.2026", "2.3 worked example E (retry 2027-02-08)"),
  V("AUTODRAFT-SUSPENDED-v1", AUTODRAFT_SUSPENDED_SOURCE, AUTODRAFT_SUSPENDED_RULES, AUTODRAFT_SUSPENDED_SAMPLE, "nacha.2026", "2.3 state machine (suspended_returns)"),
  V("CURTAIL-CONFIRM-v1", CURTAIL_CONFIRM_SOURCE, CURTAIL_CONFIRM_RULES, CURTAIL_CONFIRM_SAMPLE, "fnma.c1201.2024", "2.4 worked example F"),
  V("CURTAIL-REDIRECT-v1", CURTAIL_REDIRECT_SOURCE, CURTAIL_REDIRECT_RULES, CURTAIL_REDIRECT_SAMPLE, "fnma.c1201.2024", "2.4 worked example G"),
  V("REAMORT-OFFER-v1", REAMORT_OFFER_SOURCE, REAMORT_OFFER_RULES, REAMORT_OFFER_SAMPLE, "fnma.c1201.2024", "2.4 worked example H"),
  V("REAMORT-EFFECTIVE-v1", REAMORT_EFFECTIVE_SOURCE, REAMORT_EFFECTIVE_RULES, REAMORT_EFFECTIVE_SAMPLE, "fnma.c1201.2024", "2.4-T8"),
  V("THIRDPARTY-BIWEEKLY-INFO-v1", THIRDPARTY_SOURCE, THIRDPARTY_RULES, THIRDPARTY_SAMPLE, "fnma.c1104.2014", "2.5 outputs"),
  V("TRIAL-PAYMENT-RECEIVED-v1", TRIAL_RECEIVED_SOURCE, TRIAL_RECEIVED_RULES, TRIAL_RECEIVED_SAMPLE, "fnma.c1102.2025", "2.6 worked example J (trial 1)"),
  V("TRIAL-FUNDS-APPLIED-v1", TRIAL_APPLIED_SOURCE, TRIAL_APPLIED_RULES, TRIAL_APPLIED_SAMPLE, "fnma.c1102.2025", "2.6 worked example J (2026-11-02)"),
  V("TRIAL-COMPLETE-FUNDS-v1", TRIAL_COMPLETE_SOURCE, TRIAL_COMPLETE_RULES, TRIAL_COMPLETE_SAMPLE, "fnma.f127.2025", "2.6 worked example J (completion)"),
  V("TRIAL-FAILED-FUNDS-v1", TRIAL_FAILED_SOURCE, TRIAL_FAILED_RULES, TRIAL_FAILED_SAMPLE, "fnma.c1102.2025", "2.6 worked example J (had the 2026-12-01 payment arrived 2027-01-02)"),
  V("LC-NSF-FEE-v1", LC_NSF_SOURCE, LC_NSF_RULES, LC_NSF_SAMPLE, "sm.fees.v1", "2.7-T10"),
  V("LC-WAIVER-CONFIRM-v1", LC_WAIVER_SOURCE, LC_WAIVER_RULES, LC_WAIVER_SAMPLE, "sm.fees.v1", "2.7-T11"),
];

/** Register the §2 templates and draft their versions on a registry (idempotent; the codes are not in spec/registry/notices.json). */
export function registerSection02(reg: NoticeRegistry): void {
  for (const t of SECTION_02_TEMPLATES) if (!reg.has(t.code)) reg.register(t);
  for (const v of SECTION_02_VERSIONS) if (!reg.versionsOf(v.templateCode).some((x) => x.version === v.version)) reg.draft(v);
}
/** Counsel approval through the same publish gate the catalog uses (each version must pass its own checklist). */
export function publishSection02(reg: NoticeRegistry, approvedBy = "counsel", approvedAt = "2026-09-01T00:00:00.000Z"): void {
  registerSection02(reg);
  for (const v of SECTION_02_VERSIONS) reg.publish(v.templateCode, v.version, approvedBy, approvedAt, publishCheck);
}
