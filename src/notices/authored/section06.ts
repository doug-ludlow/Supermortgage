/**
 * Authored templates and versions for the §6 custodial notices. The Notice
 * Registry catalog (spec/registry/notices.json) harvests NTC_/INS_ codes, so
 * these seven spec-named templates carry their own `NoticeTemplate` rows
 * here and register through `registerSection06` (the catalog spreads them
 * in once src/notices/catalog.ts imports this file):
 *
 *   6.1 `CUST-DEP-INELIG-v1`   ineligible-depository notice to the Fannie Mae custodial team (A4-1-02, 3 BD)
 *   6.2 `CUST-TI-INT-DISP-v1`  interest-disposition memo (A4-1-02, 30 days)
 *   6.5 `SUSP-PARTIAL-HOLD-v1` partial payment held (C-1.1-02; §1026.41(d)(3) via 7.1)
 *   6.5 `SUSP-PARTIAL-RETURN-v1`, `SUSP-UNIDENTIFIED-RETURN-v1`, `SUSP-REFUND-v1`
 *   6.5 `UP-DUE-DILIGENCE-v1`  RUUPA §502(a) heading, first-class mail only, ≥ $50, −180…−60 days before filing
 *
 * Sample payloads are the spec's worked examples so the publish gate proves
 * each template.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import type { NoticeRegistry } from "../registry.ts";
import { publishCheck } from "../checklist.ts";
import { V } from "./section01.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const CONTACT = `{{#block "contact" page=1 y=0.85 pt=10}}Questions? Call {{servicer_phone}}. Notices of error and requests for information: {{exclusive_address}}.{{/block}}`;
const T = (code: string, name: string, ownerSection: string, citation: string, noticeClass: string, channelPolicy: NoticeTemplate["channelPolicy"], extra: Partial<NoticeTemplate> = {}): NoticeTemplate =>
  ({ code, name, citation, ownerSection, noticeClass, channelPolicy, separateDocument: false, mayCombineWith: [], retention: "life_of_loan_plus_4y", piiLevel: "medium", ...extra });

export const SECTION_06_TEMPLATES: readonly NoticeTemplate[] = [
  T("CUST-DEP-INELIG-v1", "custodial depository ineligibility notice", "6.1", "Servicing Guide A4-1-02 (notify Fannie Mae within three business days; remedies)", "custodial_internal", "electronic_ok_without_esign", { retention: "corporate_7y", piiLevel: "low", mentions: ["6.1"] }),
  T("CUST-TI-INT-DISP-v1", "T&I interest disposition memo", "6.2", "Servicing Guide A4-1-02 (disburse within 30 days of credit)", "custodial_internal", "electronic_ok_without_esign", { retention: "corporate_7y", piiLevel: "low", mentions: ["6.2", "6.4"] }),
  T("SUSP-PARTIAL-HOLD-v1", "partial payment held", "6.5", "Servicing Guide C-1.1-02; 12 CFR 1026.41(d)(3) via 7.1", "suspense_notices", "esign_or_mail", { mentions: ["6.5", "7.1"] }),
  T("SUSP-PARTIAL-RETURN-v1", "partial payment returned", "6.5", "Servicing Guide C-1.1-02 (return of a partial payment)", "suspense_notices", "esign_or_mail", { mentions: ["6.5"] }),
  T("SUSP-UNIDENTIFIED-RETURN-v1", "unidentified funds returned to remitter", "6.5", "Servicing Guide A4-1-01 (return in a timely manner)", "suspense_notices", "mail_only", { mentions: ["6.5"] }),
  T("SUSP-REFUND-v1", "overpayment refund", "6.5", "6.5 rule 5 (10 business days, policy); 12 CFR 1024.34(b)(1) for escrow after payoff", "suspense_notices", "esign_or_mail", { mentions: ["6.5", "16.2"] }),
  T("UP-DUE-DILIGENCE-v1", "unclaimed property due-diligence notice", "6.5", "Revised Uniform Unclaimed Property Act (2016) §501(a), §502(a); state variants per jurisdiction_rules", "state_notices", "mail_only", { separateDocument: true, mentions: ["6.5"] }),
];

// ------------------------------------------------------------------ 6.1 CUST-DEP-INELIG-v1 (A4-1-02, rule 5 worked example)
const DEP_INELIG_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}NOTICE OF CUSTODIAL DEPOSITORY INELIGIBILITY (Servicing Guide A4-1-02){{/block}}
{{#block "body" page=1 y=0.12 pt=11}}{{servicer_name}}, subservicer for {{master_servicer_name}} (servicer number {{servicer_number}}), notifies Fannie Mae that {{depository_name}} (ABA {{aba}}) no longer meets the custodial depository eligibility requirements of A4-1-02: {{agency}} rating {{new_rating}} (previously {{prior_rating}}; eligibility floor {{floor}}), detected {{date detected_on}}.{{/block}}
{{#block "remedy" page=1 y=0.3 pt=11}}Remedy plan: replacement custodial accounts at {{replacement_depository}} (eligible under A4-1-02), migration by {{date migrate_by}}; until then balances are kept fully insured or transferred at Fannie Mae's direction. Uninsured exposure at detection: {{money exposure_cents}}. Accounts affected: {{#each balances}}{{account_id}} ({{money balance_cents}}); {{/each}}{{/block}}
{{#block "timing" page=1 y=0.5 pt=11}}This notice is sent within three business days of detection (due {{date notify_by}}).{{#if partner_copied}} The master servicer is copied.{{/if}}{{/block}}`;
const DEP_INELIG_RULES: ContentRule[] = [
  R("cites-a4102", "A4-1-02", "presence", "Servicing Guide A4-1-02", "cites the eligibility rule"),
  R("ineligible", "A4-1-02", "presence", "no longer meets the custodial depository eligibility requirements", "states the ineligibility and the failed test"),
  R("remedy", "A4-1-02 (remedies)", "presence", "Remedy plan: replacement custodial accounts at", "carries the remedy plan"),
  R("exposure", "6.1 rule 5", "presence", "Uninsured exposure at detection: \\$[\\d,]+\\.\\d{2}", "fully-insured exposure computed"),
  R("three-bd", "A4-1-02 (three business days)", "data_range", "business_days_after_detection", "sent within three business days", { range: { max: 3 } }),
  R("partner-copied", "A2-1-07", "data_equality", "partner_copied", "the master servicer is actually copied (payload `partner_copied`, from the 6.1 package / email.send), not a template sentence", { predicate: { "==": [{ var: "partner_copied" }, true] } }),
];
const DEP_INELIG_SAMPLE: Record<string, unknown> = { servicer_name: "Supermortgage LLC", master_servicer_name: "Partner Bank N.A.", servicer_number: "123456789", depository_name: "Depository X", aba: "021000021", agency: "IDC", new_rating: "118", prior_rating: "128", floor: "125", detected_on: "2026-10-15", replacement_depository: "Depository Y", migrate_by: "2026-11-18", exposure_cents: 145_000_000n, balances: [{ account_id: "C-PI-SS-MBS", balance_cents: 170_000_000n }], notify_by: "2026-10-20", business_days_after_detection: 1, partner_copied: true };

// ------------------------------------------------------------------ 6.2 CUST-TI-INT-DISP-v1 (A4-1-02, rule 3 worked example)
const INT_DISP_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}INTEREST DISPOSITION MEMO — T&I CUSTODIAL ACCOUNT {{custodial_account_id}}{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}Bank interest of {{money amount_cents}} was credited on {{date credited_on}}. Administrative expenses (bank analysis fees on this account only): {{money admin_expense_cents}}. Statutory escrow interest funded to {{loan_count}} borrowers: {{money to_borrowers_cents}}. Residual to corporate: {{money to_corporate_cents}}.{{#if corporate_funds_shortfall_cents}} Corporate funded a shortfall of {{money corporate_funds_shortfall_cents}} (officer decision {{officer_decision_id}}).{{/if}}{{/block}}
{{#block "evidence" page=1 y=0.35 pt=11}}All of the credit was disbursed by {{date posted_on}} (deadline {{date disburse_by}}, 30 days after the credit, A4-1-02); interest pending after posting: {{money interest_pending_after_cents}}. Jurisdiction rule versions: {{#each jurisdiction_rule_versions}}{{this}}; {{/each}}{{/block}}`;
const INT_DISP_RULES: ContentRule[] = [
  R("identity", "6.2 rule 2", "presence", "Administrative expenses .* Statutory escrow interest funded to \\d+ borrowers: \\$[\\d,]+\\.\\d{2}\\. Residual to corporate: \\$[\\d,]+\\.\\d{2}", "allocation I − E − to_borrowers = to_corporate is listed"),
  R("thirty-day-evidence", "A4-1-02 (30 days)", "presence", "disbursed by .* \\(deadline .*, 30 days after the credit, A4-1-02\\)", "30-day disbursement evidence"),
  R("within-30", "A4-1-02 (30 days)", "data_range", "days_credit_to_posting", "posted within 30 days of the credit", { range: { max: 30 } }),
  R("pending-zero", "6.2-T2", "presence", "interest pending after posting: \\$0\\.00", "the composition's interest-pending line returns to zero"),
  R("rule-versions", "6.2 decision record", "presence", "Jurisdiction rule versions: .+;", "jurisdiction rule versions recorded"),
];
const INT_DISP_SAMPLE: Record<string, unknown> = { custodial_account_id: "C-TI-MAIN", amount_cents: 123_456n, credited_on: "2026-09-30", admin_expense_cents: 4_500n, loan_count: 312, to_borrowers_cents: 98_765n, to_corporate_cents: 20_191n, corporate_funds_shortfall_cents: 0n, officer_decision_id: null, posted_on: "2026-10-28", disburse_by: "2026-10-30", interest_pending_after_cents: 0n, days_credit_to_posting: 28, jurisdiction_rule_versions: ["NY GOL §5-601 2% (00a §5.5 v2026-09)"] };

// ------------------------------------------------------------------ 6.5 SUSP-PARTIAL-HOLD-v1 (C-1.1-02; worked example A)
const PARTIAL_HOLD_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}YOUR PARTIAL PAYMENT IS BEING HELD{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}On {{date received_on}} we received {{money amount_cents}} toward your monthly payment of {{money periodic_payment_cents}} due {{date due_date}}. Because it is less than a full payment, we are holding it as unapplied funds. The balance needed to complete the payment is {{money balance_due_cents}}. If we receive the balance by {{date commitment_due_on}}, we will apply the full payment as of the date the balance arrives. If we do not, the {{money amount_cents}} will be returned to you.{{/block}}
{{#block "statement" page=1 y=0.4 pt=11}}Funds held as unapplied are shown on your periodic statement until they are applied.{{/block}}
${CONTACT}`;
const PARTIAL_HOLD_RULES: ContentRule[] = [
  R("amount-held", "C-1.1-02", "presence", "we received \\$[\\d,]+\\.\\d{2} toward your monthly payment", "amount held"),
  R("balance-due", "C-1.1-02", "presence", "The balance needed to complete the payment is \\$[\\d,]+\\.\\d{2}", "balance due"),
  R("thirty-day-date", "C-1.1-02 (commits to paying the balance within the next 30 days)", "presence", "If we receive the balance by (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "30-day date"),
  R("thirty-days", "C-1.1-02", "data_range", "commitment_days", "commitment date is 30 days after receipt", { range: { min: 30, max: 30 } }),
  R("regz-41d3", "12 CFR 1026.41(d)(3) via 7.1", "presence", "shown on your periodic statement", "periodic-statement disclosure of unapplied funds"),
  R("regz-36c1ii", "12 CFR 1026.36(c)(1)(ii)(B)", "presence", "apply the full payment as of the date the balance arrives", "crediting on accumulation"),
];
const PARTIAL_HOLD_SAMPLE: Record<string, unknown> = { received_on: "2026-10-03", amount_cents: 150_000n, periodic_payment_cents: 184_217n, due_date: "2026-10-01", balance_due_cents: 34_217n, commitment_due_on: "2026-11-02", commitment_days: 30, servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

// ------------------------------------------------------------------ 6.5 SUSP-PARTIAL-RETURN-v1 (worked example A, day 30)
const PARTIAL_RETURN_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}PARTIAL PAYMENT RETURNED{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}On {{date received_on}} we received {{money amount_cents}} toward your monthly payment of {{money periodic_payment_cents}} due {{date due_date}}. The balance of {{money balance_due_cents}} was not received by {{date commitment_due_on}}, so on {{date returned_on}} we returned {{money amount_cents}} {{return_method}}. Your payment of {{money periodic_payment_cents}} remains due{{#if late_charge_text}}; {{late_charge_text}}{{/if}}.{{/block}}
${CONTACT}`;
const PARTIAL_RETURN_RULES: ContentRule[] = [
  R("amount-returned", "C-1.1-02", "presence", "we returned \\$[\\d,]+\\.\\d{2}", "amount returned"),
  R("why", "C-1.1-02", "presence", "was not received by", "why the funds were returned"),
  R("method", "6.5 rule 3 (original rail)", "presence", "we returned \\$[\\d,]+\\.\\d{2} (by ACH credit to|by check to)", "return method and destination"),
];
const PARTIAL_RETURN_SAMPLE: Record<string, unknown> = { received_on: "2026-10-03", amount_cents: 150_000n, periodic_payment_cents: 184_217n, due_date: "2026-10-01", balance_due_cents: 34_217n, commitment_due_on: "2026-11-02", returned_on: "2026-11-03", return_method: "by ACH credit to the account ending 8831 the payment came from", late_charge_text: "a late charge may apply under your note", servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

// ------------------------------------------------------------------ 6.5 SUSP-UNIDENTIFIED-RETURN-v1 (to the remitter; T5)
const UNIDENTIFIED_RETURN_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}RETURN OF FUNDS WE COULD NOT APPLY{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}On {{date received_on}} we received {{money amount_cents}} from {{remitter_name}} ({{instrument_description}}). We could not match these funds to any mortgage loan we service, and our research through {{date research_through}} did not identify one. {{#if refund_check}}Enclosed is a refund check for {{money amount_cents}}.{{else}}We have returned {{money amount_cents}} to the account the funds came from.{{/if}}{{/block}}
{{#block "help" page=1 y=0.4 pt=11}}If these funds were meant for a loan we service, call {{servicer_phone}} with the loan number so we can apply them correctly.{{/block}}`;
const UNIDENTIFIED_RETURN_RULES: ContentRule[] = [
  R("amount", "A4-1-01", "presence", "we received \\$[\\d,]+\\.\\d{2} from", "amount and remitter"),
  R("could-not-match", "A4-1-01 (research)", "presence", "could not match these funds to any mortgage loan", "explains the return"),
  R("within-60", "6.5 rule 4", "data_range", "days_receipt_to_return", "returned by day 60", { range: { max: 60 } }),
];
const UNIDENTIFIED_RETURN_SAMPLE: Record<string, unknown> = { received_on: "2026-10-07", amount_cents: 125_000n, remitter_name: "J. Smith", instrument_description: "check no. 1042", research_through: "2026-11-06", refund_check: true, days_receipt_to_return: 60, servicer_phone: "(800) 555-0100" };

// ------------------------------------------------------------------ 6.5 SUSP-REFUND-v1 (overpayment refund with computation)
const REFUND_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}REFUND OF OVERPAYMENT{{/block}}
{{#block "body" page=1 y=0.12 pt=11}}On {{date received_on}} we received {{money received_cents}}. The amount due on your loan was {{money amount_due_cents}}. The overpayment of {{money refund_cents}} is being refunded {{refund_method}} on {{date refund_on}}.{{#if curtailment_offered}} If you would rather apply it to principal, call us by {{date election_by}}.{{/if}}{{/block}}
${CONTACT}`;
const REFUND_RULES: ContentRule[] = [
  R("computation", "6.5 outputs (refund with computation)", "presence", "we received \\$[\\d,]+\\.\\d{2}\\. The amount due on your loan was \\$[\\d,]+\\.\\d{2}\\. The overpayment of \\$[\\d,]+\\.\\d{2}", "received, due and overpayment shown"),
  R("within-10bd", "6.5 rule 5 (10 BD policy)", "data_range", "business_days_to_refund", "refunded within 10 business days", { range: { max: 10 } }),
];
const REFUND_SAMPLE: Record<string, unknown> = { received_on: "2026-10-05", received_cents: 250_000n, amount_due_cents: 184_217n, refund_cents: 65_783n, refund_method: "by ACH credit to the account the payment came from", refund_on: "2026-10-09", curtailment_offered: true, election_by: "2026-10-08", business_days_to_refund: 4, servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" };

// ------------------------------------------------------------------ 6.5 UP-DUE-DILIGENCE-v1 (RUUPA §502(a); worked example C)
const DUE_DILIGENCE_SOURCE = `{{#block "heading" page=1 y=0.05 pt=14 bold}}NOTICE OF UNCLAIMED PROPERTY — {{state_name}}{{/block}}
{{#block "statutory" page=1 y=0.12 pt=12 bold}}The property described below may be transferred to the custody of the {{state_administrator}} if you do not contact us before {{date contact_by}}.{{/block}}
{{#block "property" page=1 y=0.25 pt=11}}Owner: {{owner_name}}. Property: {{property_description}} in the amount of {{money amount_cents}}, held by {{servicer_name}} since {{date dormancy_start_on}}.{{/block}}
{{#block "how" page=1 y=0.4 pt=11}}To claim this property, call {{servicer_phone}} or write to {{servicer_address}} before {{date contact_by}}.{{#if state_supplement}} {{state_supplement}}{{/if}}{{/block}}
{{#block "mail" page=1 y=0.9 pt=9}}Sent by first-class mail to the last known address on {{date notice_date}}.{{/block}}`;
const DUE_DILIGENCE_RULES: ContentRule[] = [
  R("502a-heading", "RUUPA §502(a)", "presence", "may be transferred to the custody of the .+ if you do not contact us before (January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}", "statutory heading"),
  R("502a-heading-layout", "RUUPA §502(a)", "layout", "statutory", "heading on page 1, bold", { layout: { page: 1, bold: true, minPt: 12 } }),
  R("contact-by-30", "6.5 outputs (date 30 days after notice)", "data_range", "days_to_contact_by", "contact-by date at least 30 days after the notice", { range: { min: 30 } }),
  R("501a-threshold", "RUUPA §501(a) ($50 or more)", "data_range", "amount_cents", "notice only for property of $50 or more", { range: { min: 5000 } }),
  R("501a-window", "RUUPA §501(a) (not more than 180 nor less than 60 days before filing)", "data_range", "days_before_filing", "sent between 180 and 60 days before the report is filed", { range: { min: 60, max: 180 } }),
  R("first-class-mail", "6.5 outputs (always mailed first-class)", "presence", "Sent by first-class mail", "first-class mail statement"),
  R("state-variant", "6.5 outputs (state variants keyed by jurisdiction_rules)", "conditional", "state_supplement", "state supplement where the state requires it", { when: { "==": [{ var: "state_supplement_required" }, true] }, predicate: { present: "state_supplement" } }),
];
const DUE_DILIGENCE_SAMPLE: Record<string, unknown> = { state_name: "Texas", state_administrator: "Texas Comptroller of Public Accounts, Unclaimed Property Division", contact_by: "2029-07-02", owner_name: "Sample Borrower", property_description: "uncashed escrow refund check no. 100231", amount_cents: 21_455n, servicer_name: "Supermortgage LLC", dormancy_start_on: "2026-03-01", servicer_phone: "(800) 555-0100", servicer_address: "PO Box 2, Testville TX 75001", notice_date: "2029-06-01", days_to_contact_by: 31, days_before_filing: 136, state_supplement_required: false };

export const SECTION_06_VERSIONS: readonly VersionInput[] = [
  V("CUST-DEP-INELIG-v1", DEP_INELIG_SOURCE, DEP_INELIG_RULES, DEP_INELIG_SAMPLE, "fnma.custodial.a4102.2023-07", "6.1 rule 5 worked example (IDC 128 → 118, Thu 2026-10-15)"),
  V("CUST-TI-INT-DISP-v1", INT_DISP_SOURCE, INT_DISP_RULES, INT_DISP_SAMPLE, "fnma.custodial.a4102.2023-07", "6.2 rule 3 worked example ($1,234.56 credit, $45.00 fees, $987.65 statutory, $201.91 corporate)"),
  V("SUSP-PARTIAL-HOLD-v1", PARTIAL_HOLD_SOURCE, PARTIAL_HOLD_RULES, PARTIAL_HOLD_SAMPLE, "fnma.c1102.2025-08; regz.1026_36c.2026", "6.5 worked example A ($1,500.00 held 10/03, balance $342.17, 30-day date 11/02)"),
  V("SUSP-PARTIAL-RETURN-v1", PARTIAL_RETURN_SOURCE, PARTIAL_RETURN_RULES, PARTIAL_RETURN_SAMPLE, "fnma.c1102.2025-08", "6.5 worked example A (nothing by 11/02 → returned 11/03 by ACH)"),
  V("SUSP-UNIDENTIFIED-RETURN-v1", UNIDENTIFIED_RETURN_SOURCE, UNIDENTIFIED_RETURN_RULES, UNIDENTIFIED_RETURN_SAMPLE, "fnma.a4101.2025-02", "6.5-T5 (unidentified check 10/07, refund check by 12/06)"),
  V("SUSP-REFUND-v1", REFUND_SOURCE, REFUND_RULES, REFUND_SAMPLE, "sm.suspense.refund.2026", "6.5 rule 5 (overpayment refund within 10 BD)"),
  V("UP-DUE-DILIGENCE-v1", DUE_DILIGENCE_SOURCE, DUE_DILIGENCE_RULES, DUE_DILIGENCE_SAMPLE, "ruupa.2016; jurisdiction_rules.unclaimed_property", "6.5 worked example C (TX refund check $214.55, dormancy 2026-03-01 → report before 2029-11-01)"),
];
export const SECTION_06_NOTICE_CODES: readonly string[] = SECTION_06_TEMPLATES.map((t) => t.code);

/** Register the §6 templates and draft their versions on a registry (idempotent). */
export function registerSection06(reg: NoticeRegistry): void {
  for (const t of SECTION_06_TEMPLATES) if (!reg.has(t.code)) reg.register(t);
  for (const v of SECTION_06_VERSIONS) if (!reg.versionsOf(v.templateCode).some((x) => x.version === v.version)) reg.draft(v);
}
/** Counsel approval of the §6 versions (each must pass its own checklist to publish). */
export function publishSection06(reg: NoticeRegistry, approvedBy = "counsel", approvedAt = "2026-09-01T00:00:00.000Z"): void {
  registerSection06(reg);
  for (const v of SECTION_06_VERSIONS) reg.publish(v.templateCode, v.version, approvedBy, approvedAt, publishCheck);
}
