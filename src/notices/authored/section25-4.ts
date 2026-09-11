/**
 * §25.4 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * NTC_SM_FIRST_PAYMENT_LETTER       — 30.2 renders and sends it (rule 9 content checklist (a)–(m) runs over the rendered text:
 *                                     "servicing on behalf of [Partner], your lender", loan number, property, first payment
 *                                     date and amount with the P&I / escrow / MI split, how to pay, grace/late charge, escrow
 *                                     summary with the initial-statement pointer, "not a notice of servicing transfer", the
 *                                     FCRA B-1 sentence verbatim (8.1's MODEL_B1), E-SIGN invitation, privacy reference,
 *                                     HUD/CFPB block, ACP handling); 25.4 imposes Reg E §1005.10(e)(1): the autopay offer is
 *                                     optional, never pre-checked, never a condition (T7).
 * NTC_REGZ_1026_39_OWNERSHIP_TRANSFER — fallback / assignee use only: §1026.39(d)(1)–(5) content (covered person, date of
 *                                     transfer, agent for rescission notices and payment issues, recording statement —
 *                                     MERS: "has not been recorded in public records" — and the H-25-style partial-payment
 *                                     policy, alternative (ii), with the "new lender may have a different policy" sentence).
 * NTC_SM_ESCROW_ELECTION            — the election record with the partner's policy statements where waived and the CD
 *                                     escrow-section cross-reference; non-waivable cases (B2-1.5-04 BPMI; §1026.35 HPML) named.
 * NTC_UT_7_17_4_RESERVE_OPTIONS     — Utah Code §7-17-4: both options, "a reserve account is not required by the lender",
 *                                     borrower legally responsible for taxes/insurance/other charges, selection at closing,
 *                                     §7-17-3 interest and no-service-charge statements.
 * NTC_CA_CIV_2954_IMPOUND_STMT      — Cal. Civ. Code §2954: the written statement that the impound account "shall not be
 *                                     required as a condition" (with the (a)(1) exception where it may be) and whether
 *                                     interest will be paid.
 */
import type { ContentRule, NoticeTemplate, VersionInput } from "../registry.ts";
import { V } from "./section01.ts";
import { MODEL_B1 } from "./section08.ts";

const R = (rule_id: string, citation: string, kind: ContentRule["kind"], selector: string, message: string, extra: Partial<ContentRule> = {}): ContentRule => ({ rule_id, citation, kind, selector, severity: "block", message, ...extra });
const present = (...paths: string[]): Record<string, unknown> => ({ and: paths.map((p) => ({ present: p })) });
const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}";
const MONEY = "\\$[\\d,]+\\.\\d{2}";
const PHONE = "\\(\\d{3}\\) \\d{3}-\\d{4}";
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Reg E §1005.10(e)(1) / (b): text that conditions the loan on autopay or pre-checks enrollment (shared with ops-25-4.ts validateFirstPaymentLetterAutopay). */
export const AUTOPAY_CONDITION_PATTERN = "(enrol+ment|autopay|automatic payments?|preauthorized (electronic )?(fund )?transfers?)[^.]{0,60}\\b(is|are|will be)\\s+(?<!not )(required|mandatory|a condition)|\\b(must|required to|need to)\\s+(enrol+|sign up for|set up)\\b[^.]{0,40}\\b(autopay|automatic payments?|ach)\\b|\\[\\s*[xX✓]\\s*\\]\\s*(enrol+|autopay|automatic payments?)|(?<!not a )condition of (this|your|the) loan";

// ------------------------------------------------------------------ NTC_SM_FIRST_PAYMENT_LETTER (30.2 sends; 25.4 owns)
const FIRST_PAYMENT_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}YOUR FIRST MORTGAGE PAYMENT{{/block}}
{{#block "servicer" page=1 y=0.09 pt=11}}{{{servicer_name}}}, servicing on behalf of {{{partner_name}}}, your lender. Servicing loan number {{{servicing_loan_number}}}. Borrower(s): {{#each borrower_names}}{{this}}; {{/each}}Property: {{{property_address}}}.{{/block}}
{{#block "payment" page=1 y=0.16 pt=12 bold}}Your first payment of {{money total_cents}} is due {{date first_payment_date}}: principal and interest {{money pi_cents}}, escrow {{money escrow_cents}}{{#if has_mi}}, mortgage insurance {{money mi_cents}}{{/if}}; monthly total {{money total_cents}}.{{/block}}
{{#block "how_to_pay" page=1 y=0.24 pt=11}}How to pay: make your payment to {{{payee_line}}} — mail to {{{remittance_address}}}; online at {{{portal_url}}}; or call {{{servicer_phone}}} ({{{contact_hours}}}). {{{automation_disclosure}}}{{/block}}
{{#block "autopay" page=1 y=0.32 pt=11}}Automatic payments (autopay) are optional. Enrolling is not a condition of your loan and was not a condition of your loan approval; you may enroll, change or cancel at any time in the borrower portal, where you authorize the transfers in writing and receive a copy of your authorization.{{/block}}
{{#block "grace" page=1 y=0.4 pt=11}}Your note provides a grace period of {{late_charge_grace_days}} days; a late charge of {{late_charge_pct}}% of the principal and interest payment applies to a payment received after the grace period.{{/block}}
{{#block "escrow" page=1 y=0.46 pt=11}}Escrow: {{{escrow_summary}}} {{{initial_escrow_statement_pointer}}}{{/block}}
{{#block "statement" page=1 y=0.52 pt=11}}A monthly periodic statement will follow for each payment.{{#if arm_first_change_date}} Your interest rate first changes on {{date arm_first_change_date}}; you will receive a separate notice at least 210 days before the first payment at the new rate.{{/if}}{{/block}}
{{#block "not_transfer" page=1 y=0.58 pt=11}}Your loan terms and the payee are as disclosed at closing. This letter is not a notice of servicing transfer.{{/block}}
{{#block "b1" page=1 y=0.64 pt=11}}{{{b1_text}}}{{/block}}
{{#block "esign" page=1 y=0.7 pt=11}}{{#if esign_invitation}}You can enroll in electronic delivery of your statements and notices in the borrower portal (E-SIGN disclosure enclosed).{{/if}}{{/block}}
{{#block "privacy" page=1 y=0.76 pt=11}}Privacy: {{{privacy_reference}}}{{/block}}
{{#block "hud" page=1 y=0.82 pt=11}}{{{hud_cfpb_block}}}{{/block}}
{{#block "acp" page=1 y=0.9 pt=11}}{{#if acp_or_successor_handling}}{{{acp_or_successor_handling}}}{{/if}}{{#if language_preference}} Language preference on file: {{{language_preference}}}.{{/if}}{{/block}}`;
const FIRST_PAYMENT_RULES: ContentRule[] = [
  R("a-servicer-on-behalf", "30.2 rule 9(a); 1.3 branding", "presence", "servicing on behalf of \\S.*, your lender", "SM identified as servicer 'servicing on behalf of [Partner], your lender'"),
  R("a-partner-name-data", "30.2 rule 9(a)", "data_equality", "partner_name,servicer_name", "the creditor's name as on the note", { predicate: present("partner_name", "servicer_name") }),
  R("b-loan-number", "30.2 rule 9(b)", "presence", "Servicing loan number \\S+", "servicing loan number"),
  R("c-property", "30.2 rule 9(c)", "data_equality", "property_address,borrower_names", "property address and borrower names", { predicate: present("property_address", "borrower_names") }),
  R("d-first-payment", "30.2 rule 9(d); 25.4 worked example 3", "presence", `first payment of ${MONEY} is due ${MONTH}: principal and interest ${MONEY}, escrow ${MONEY}.*; monthly total ${MONEY}`, "first payment due date and amount with the P&I / escrow / MI breakdown and the monthly total"),
  R("d-total-equals-breakdown", "30.2 rule 9(d); 25.4 worked example 3 ($3,402.62 + $525.00 = $3,927.62)", "data_equality", "total_cents,breakdown_sum_cents", "total = P&I + escrow + MI", { predicate: { and: [{ "==": [{ var: "total_cents" }, { var: "breakdown_sum_cents" }] }, { ">": [{ var: "total_cents" }, 0] }] } }),
  R("d-first-payment-date", "30.2 rule 9(d)", "data_equality", "first_payment_date", "first payment date carried as a date", { predicate: { matches: ["first_payment_date", "^\\d{4}-\\d{2}-\\d{2}$"] } }),
  R("e-how-to-pay", "30.2 rule 9(e)", "presence", `How to pay: make your payment to Supermortgage, as servicer for \\S.* — mail to .*; online at .*; or call ${PHONE}`, "how to pay: payee, mailing address, portal, phone"),
  R("e-how-to-pay-data", "30.2 rule 9(e)", "data_equality", "remittance_address,portal_url,servicer_phone,contact_hours,automation_disclosure", "mailing address, portal, phone/AI assistant with hours and the automation disclosure", { predicate: present("remittance_address", "portal_url", "servicer_phone", "contact_hours", "automation_disclosure") }),
  R("e-payee-identical", "25.4 first-payment letter content; 25.4-Q4", "data_equality", "payee_line", "payee 'Supermortgage, as servicer for [Partner]' identical to the note/CD", { predicate: { matches: ["payee_line", "^Supermortgage, as servicer for .+"] } }),
  R("rege-1005-10e1-optional-stated", "12 CFR 1005.10(e)(1)", "presence", "\\(autopay\\) are optional\\. Enrolling is not a condition of your loan", "the autopay offer states enrollment is optional and not a condition of the loan"),
  R("rege-1005-10e1-no-condition", "12 CFR 1005.10(e)(1)", "absence", AUTOPAY_CONDITION_PATTERN, "no statement that autopay enrollment is required or a condition of the loan"),
  R("rege-1005-10e1-no-precheck", "12 CFR 1005.10(b), (e)(1); 25.4 guardrail 'never pre-check enrollment'", "data_equality", "autopay_prechecked,autopay_required", "autopay enrollment is never pre-checked or required", { predicate: { and: [{ "==": [{ var: "autopay_prechecked" }, false] }, { "==": [{ var: "autopay_required" }, false] }] } }),
  R("rege-1005-10e1-no-precheck-text", "12 CFR 1005.10(b)", "absence", "\\[\\s*[xX✓]\\s*\\]", "no pre-checked box"),
  R("rege-1005-10b-authorization", "12 CFR 1005.10(b); 2.x SM_AUTODRAFT_COPY_DELIVERY_1BD", "presence", "authorize the transfers in writing and receive a copy of your authorization", "WEB/PPD authorization captured only through servicing 2.x's flow, with a copy"),
  R("f-grace-late-charge", "30.2 rule 9(f); note §7", "presence", "grace period of \\d+ days; a late charge of \\d+(\\.\\d+)?% of the principal and interest payment", "grace period and late-charge statement per the note"),
  R("g-escrow-summary", "30.2 rule 9(g)", "presence", "Escrow: \\S", "escrow account summary with the initial-statement pointer"),
  R("g-escrow-data", "30.2 rule 9(g)", "data_equality", "escrow_summary", "escrow summary present", { predicate: present("escrow_summary") }),
  R("periodic-statement-follows", "25.4 first-payment letter content; §1026.41 (7.1)", "presence", "monthly periodic statement will follow", "statement that a monthly periodic statement will follow"),
  R("h-not-a-transfer-notice", "30.2 rule 9(h); §1024.33(b)", "presence", "as disclosed at closing\\. This letter is not a notice of servicing transfer", "terms and payee as disclosed at closing; not a servicing-transfer notice"),
  R("h-not-a-transfer-data", "30.2 rule 9(h)", "data_equality", "not_a_transfer_notice", "flagged informational", { predicate: { "==": [{ var: "not_a_transfer_notice" }, true] } }),
  R("i-fcra-b1", "30.2 rule 9(i); 15 U.S.C. 1681s-2(a)(7); 12 CFR 1022 App. B Model B-1", "presence", esc(MODEL_B1), "FCRA §623(a)(7) negative-information notice (model B-1 text verbatim)"),
  R("i-fcra-b1-data", "8.1 MODEL_B1", "data_equality", "b1_text", "B-1 text is 8.1's model text", { predicate: { "==": [{ var: "b1_text" }, MODEL_B1] } }),
  R("j-esign-invitation", "30.2 rule 9(j); 7.4", "conditional", "esign_invitation", "E-SIGN enrollment invitation when OW-002", { when: { "==": [{ var: "esign_invitation" }, true] }, predicate: present("esign_invitation") }),
  R("k-privacy", "30.2 rule 9(k); 21.3 / 7.5", "presence", "Privacy: \\S", "reference to the partner's privacy notice delivered at application"),
  R("l-hud-cfpb", "30.2 rule 9(l)", "presence", "(\\(800\\) 569-4287|consumerfinance\\.gov)", "HUD counseling / CFPB contact block"),
  R("m-acp-successor", "30.2 rule 9(m); 1.3 ACP rule", "conditional", "acp_or_successor_handling", "successor/ACP handling as applicable", { when: { present: "acp_or_successor_handling" }, predicate: present("acp_or_successor_handling") }),
  R("payment-prominent", "30.2 rule 9(d)", "layout", "payment", "first payment block on page 1, bold, ≥ 12 pt", { layout: { page: 1, bold: true, minPt: 12 } }),
];
/** Worked example 3 / refinance fixture: P&I $3,402.62 + escrow $525.00 = $3,927.62 due Fri Jan 1, 2027; no MI. */
const FIRST_PAYMENT_SAMPLE: Record<string, unknown> = {
  servicer_name: "Supermortgage", partner_name: "Partner Bank, N.A.", servicing_loan_number: "1000000018", borrower_names: ["Alex Rivera"], property_address: "4821 E Camelback Rd, Phoenix AZ 85018", first_payment_date: "2027-01-01",
  pi_cents: 340_262n, escrow_cents: 52_500n, mi_cents: 0n, has_mi: false, total_cents: 392_762n, breakdown_sum_cents: 392_762n,
  remittance_address: "PO Box 7, Testville TX 75001", payee_line: "Supermortgage, as servicer for Partner Bank, N.A.", portal_url: "portal.supermortgage.example", servicer_phone: "(800) 555-0100", contact_hours: "Mon–Fri 8am–8pm ET", automation_disclosure: "Our phone and chat assistant is automated; you can ask for a person at any time.", autopay_prechecked: false, autopay_required: false,
  late_charge_pct: "5.000", late_charge_grace_days: 15, escrow_summary: "your escrow account starts with $1,875.00 and collects $525.00 monthly.", initial_escrow_statement_pointer: "See the initial escrow account statement delivered at settlement.", not_a_transfer_notice: true, b1_text: MODEL_B1, esign_invitation: true,
  privacy_reference: "Partner Bank, N.A.'s privacy notice was delivered with your application; it continues to apply.", hud_cfpb_block: "Housing counseling: (800) 569-4287 (HUD) / consumerfinance.gov/find-a-housing-counselor.", acp_or_successor_handling: null, arm_first_change_date: null, language_preference: null, account_last4: "0018",
};

// ------------------------------------------------------------------ NTC_REGZ_1026_39_OWNERSHIP_TRANSFER (fallback / assignee use)
const OWNERSHIP_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}NOTICE OF TRANSFER OF OWNERSHIP OF YOUR MORTGAGE LOAN{{/block}}
{{#block "d1" page=1 y=0.1 pt=11}}Your mortgage loan (loan number {{{loan_number}}}, property {{{property_address}}}) was sold, assigned or otherwise transferred to {{{covered_person_name}}}, {{{covered_person_address}}}, telephone {{{covered_person_phone}}}{{#if covered_person_web}}, {{{covered_person_web}}}{{/if}}, who is now the owner of your loan.{{/block}}
{{#block "d2" page=1 y=0.2 pt=11}}Date of transfer: {{date date_of_transfer}}.{{/block}}
{{#block "d3" page=1 y=0.26 pt=11}}The party authorized to receive notice of the right to rescind and to resolve issues concerning your payments is {{{agent_name}}}, servicer for {{{agent_on_behalf_of}}}, {{{agent_address}}}, telephone {{{agent_phone}}}, e-mail {{{agent_email}}}, portal {{{agent_portal_url}}}.{{/block}}
{{#block "d4" page=1 y=0.36 pt=11}}{{{recording_statement}}}{{/block}}
{{#block "d5" page=1 y=0.44 pt=11 bold}}Partial Payment Policy{{/block}}
{{#block "d5_body" page=1 y=0.46 pt=11}}{{{partial_payment_text}}} {{{sale_statement}}}{{/block}}
{{#block "optional" page=1 y=0.56 pt=11}}{{#if fnma_not_servicer}}{{{fnma_not_servicer}}} {{/if}}This notice does not change the terms or conditions of your mortgage loan, note or security instrument. Borrower(s): {{#each borrower_names}}{{this}}; {{/each}}{{/block}}`;
const OWNERSHIP_RULES: ContentRule[] = [
  R("d1-covered-person", "§1026.39(d)(1); comment 39(d)(1)-1", "data_equality", "covered_person_name,covered_person_address,covered_person_phone", "name, address and telephone number of the covered person who owns the loan (never the servicer)", { predicate: { and: [{ present: "covered_person_name" }, { matches: ["covered_person_address", "\\d{5}"] }, { matches: ["covered_person_phone", "^\\(\\d{3}\\) \\d{3}-\\d{4}$"] }] } }),
  R("d1-covered-person-text", "§1026.39(d)(1)", "presence", `transferred to \\S.*, telephone ${PHONE}.*, who is now the owner of your loan`, "covered person block rendered"),
  R("d2-date-of-transfer", "§1026.39(d)(2); (b)(2)", "presence", `Date of transfer: ${MONTH}\\.`, "date of transfer"),
  R("d2-date-basis", "§1026.39(b)(2)", "data_equality", "date_of_transfer,date_basis", "date of transfer at the covered person's option (acquirer's or transferor's books)", { predicate: { and: [{ matches: ["date_of_transfer", "^\\d{4}-\\d{2}-\\d{2}$"] }, { in: [{ var: "date_basis" }, ["acquirer_books", "transferor_books"]] }] } }),
  R("d3-agent", "§1026.39(d)(3); comment 39(d)(3)-2", "presence", `authorized to receive notice of the right to rescind and to resolve issues concerning your payments is \\S.*, telephone ${PHONE}, e-mail \\S+@\\S+, portal \\S+`, "agent for rescission notices and payment issues with address, phone, e-mail and portal"),
  R("d3-agent-data", "§1026.39(d)(3)", "data_equality", "agent_name,agent_address,agent_phone,agent_email,agent_portal_url,agent_on_behalf_of", "agent block carried on the payload", { predicate: present("agent_name", "agent_address", "agent_phone", "agent_email", "agent_portal_url", "agent_on_behalf_of") }),
  R("d4-recording", "§1026.39(d)(4); comment 39(d)(4)-1", "presence", "(has not been recorded in public records at the time this notice is provided|is or may be recorded in public records)", "where the transfer is or may be recorded, or that it has not been recorded"),
  R("d4-mers", "§1026.39(d)(4); 26.4 (MERS registration is not a public land record)", "conditional", "recording_statement", "MERS-registered loans state the transfer has not been recorded", { when: { "==": [{ var: "mers_registered" }, true] }, predicate: { matches: ["recording_statement", "has not been recorded in public records"] } }),
  R("d5-heading", "§1026.39(d)(5); comment 39(d)(5)-1 (H-25 format)", "layout", "d5", "Partial Payment Policy heading, bold", { layout: { page: 1, bold: true } }),
  R("d5-alternative", "§1026.39(d)(5)(i)–(iii); 2.1/7.1 suspense rule", "data_equality", "partial_payment_policy", "one of the three alternatives", { predicate: { in: [{ var: "partial_payment_policy" }, ["i", "ii", "iii"]] } }),
  R("d5-alternative-ii-text", "§1026.39(d)(5)(ii)", "conditional", "partial_payment_text", "alternative (ii): hold partial payments in a separate account until the remainder is paid", { when: { "==": [{ var: "partial_payment_policy" }, "ii"] }, predicate: { matches: ["partial_payment_text", "hold partial payments in a separate account"] } }),
  R("d5-text", "§1026.39(d)(5)", "presence", "(may accept partial payments|hold partial payments in a separate account|does not accept any partial payments)", "partial-payment policy statement"),
  R("d5-iv-sold", "§1026.39(d)(5)(iv)", "presence", "If this loan is sold, your new lender may have a different policy", "the new-covered-person statement"),
  R("b1-timing", "§1026.39(b)(1); comment 39(b)(1)-1", "data_range", "days_to_due", "mailed or delivered on or before the 30th calendar day following the date of transfer", { range: { min: 0, max: 30 } }),
  R("sender-basis", "25.4-Q1; guardrail 'never send in Fannie Mae's name without a written Fannie Mae instruction'", "conditional", "sender", "a Fannie Mae notice only on Fannie Mae's behalf under a written instruction", { when: { "==": [{ var: "covered_person" }, "fannie_mae"] }, predicate: { "==": [{ var: "sender" }, "servicer_on_behalf"] } }),
  R("terms-unchanged", "Fannie Mae 'Understanding your loan purchase letter'", "presence", "does not change the terms or conditions of your mortgage loan", "terms-unchanged statement"),
];
/** Assignee example: SM took an assignment at funding Thu Nov 12, 2026 and the loan is unsold — notice by Sat Dec 12 (day 30). */
const OWNERSHIP_SAMPLE: Record<string, unknown> = {
  loan_number: "1000000018", property_address: "4821 E Camelback Rd, Phoenix AZ 85018", borrower_names: ["Alex Rivera"],
  covered_person_name: "Supermortgage Warehouse Lending LLC", covered_person_address: "1 Supermortgage Way, Testville TX 75001", covered_person_phone: "(800) 555-0100", covered_person_email: null, covered_person_web: "supermortgage.example", covered_person: "sm_warehouse_assignee", sender: "covered_person_direct",
  date_of_transfer: "2026-11-12", date_basis: "acquirer_books", agent_name: "Supermortgage", agent_on_behalf_of: "Partner Bank, N.A.", agent_address: "PO Box 1, Testville TX 75001", agent_phone: "(800) 555-0100", agent_email: "help@supermortgage.example", agent_portal_url: "portal.supermortgage.example",
  mers_registered: true, recorded_in_public_records: false, county_recorder: "Maricopa County Recorder", recording_statement: "The transfer of ownership of your loan has not been recorded in public records at the time this notice is provided. It may later be recorded with the Maricopa County Recorder.",
  partial_payment_policy: "ii", partial_payment_text: "We may hold partial payments in a separate account until you pay the remainder of the payment and then apply the full payment to your loan.", sale_statement: "If this loan is sold, your new lender may have a different policy.", fnma_not_servicer: null, days_to_due: 30,
};

// ------------------------------------------------------------------ NTC_SM_ESCROW_ELECTION
const ELECTION_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}ESCROW ACCOUNT ELECTION{{/block}}
{{#block "ids" page=1 y=0.1 pt=11}}Loan number {{{loan_number}}}. Borrower(s): {{#each borrower_names}}{{this}}; {{/each}}Property: {{{property_address}}}. Lender: {{{partner_name}}}.{{/block}}
{{#block "election" page=1 y=0.16 pt=12 bold}}Your election: {{{election_text}}}.{{/block}}
{{#block "basis" page=1 y=0.22 pt=11}}{{#if waived}}Under {{{partner_name}}}'s written escrow-waiver policy (version {{{waiver_policy_version}}}) your request to waive the escrow account is approved. The policy considers more than the loan-to-value ratio: your ability to pay taxes, insurance premiums and other charges in lump sums when due, and your payment history. You are responsible for paying property taxes, hazard insurance and any other charges directly when due; the standard escrow provision remains in your security instrument. {{#if waiver_fee_cents}}An escrow waiver fee of {{money waiver_fee_cents}} is charged and shown on your Closing Disclosure as "Escrow Waiver Fee".{{else}}No escrow waiver fee is charged.{{/if}}{{else}}An escrow account is established for {{{escrowed_items}}}.{{#if non_waivable_reason_text}} This account cannot be waived: {{{non_waivable_reason_text}}}.{{/if}}{{/if}}{{/block}}
{{#block "cd" page=1 y=0.4 pt=11}}See your Closing Disclosure: Initial Escrow Payment at Closing {{money initial_escrow_payment_cents}}; Monthly Escrow Payment {{money monthly_escrow_cents}}; Escrowed Property Costs over Year 1 {{money escrowed_costs_year1_cents}}.{{/block}}
{{#block "interest" page=1 y=0.5 pt=11}}Interest on escrow: {{{interest_statement}}}{{/block}}
{{#block "state" page=1 y=0.56 pt=11}}{{#if state_notice_codes}}State notice(s) delivered with this election: {{#each state_notice_codes}}{{this}}; {{/each}}{{/if}}Elected at {{{elected_at_text}}}.{{/block}}`;
const ELECTION_RULES: ContentRule[] = [
  R("election-value", "25.4 data model escrow_elections.election", "data_equality", "election", "election ∈ {escrow_full, waived, partial_taxes_only, partial_insurance_only}", { predicate: { in: [{ var: "election" }, ["escrow_full", "waived", "partial_taxes_only", "partial_insurance_only"]] } }),
  R("election-text", "25.4 outputs: election record", "presence", "Your election: \\S", "the election stated"),
  R("election-prominent", "25.4 outputs", "layout", "election", "election block bold", { layout: { page: 1, bold: true } }),
  R("waived-policy", "B2-1.5-04: written policy; waiver not based solely on LTV; financial ability", "conditional", "waiver_policy_version", "a waiver names the partner's written policy version", { when: { "==": [{ var: "waived" }, true] }, predicate: present("waiver_policy_version") }),
  R("waived-responsibility-text", "B2-1.5-04; 25.4 outputs (partner's policy statements)", "conditional", "waived", "waived: borrower responsible for taxes/insurance; standard escrow provision remains", { when: { "==": [{ var: "waived" }, true] }, predicate: { "==": [{ var: "waived" }, true] } }),
  R("established-items", "25.4 outputs", "conditional", "escrowed_items", "an established account names the escrowed items", { when: { "==": [{ var: "waived" }, false] }, predicate: present("escrowed_items") }),
  R("non-waivable-reason", "B2-1.5-04 (BPMI; refinance financing taxes); §1026.35(b)(1) (HPML)", "conditional", "non_waivable_reason", "a non-waivable case names its reason", { when: { present: "non_waivable_reason" }, predicate: { in: [{ var: "non_waivable_reason" }, ["bpmi", "hpml", "delinquent_tax_financed_refi", "flood_required_escrow", "state_prohibits"]] } }),
  R("cd-cross-reference", "§1026.38(l)(7); 25.4 outputs (CD escrow-section cross-reference)", "presence", `Initial Escrow Payment at Closing ${MONEY}; Monthly Escrow Payment ${MONEY}; Escrowed Property Costs over Year 1 ${MONEY}`, "CD escrow-section cross-reference"),
  R("waiver-fee-non-negative", "25.4-Q6: no Fannie Mae escrow-waiver LLPA; a fee, if any, is a finance charge (25.1)", "data_range", "waiver_fee_cents", "waiver fee ≥ 0 (default 0)", { range: { min: 0 } }),
  R("interest-statement", "Utah §7-17-3; Cal. Civ. Code §2954.8; servicing 3.x", "presence", "Interest on escrow: \\S", "interest-on-escrow statement"),
  R("elected-at", "25.4 data model escrow_elections.elected_at", "data_equality", "elected_at", "election timestamp", { predicate: { matches: ["elected_at", "^\\d{4}-\\d{2}-\\d{2}T"] } }),
];
/** Purchase fixture: BPMI → escrow_full, non-waivable (B2-1.5-04); worked example 3 CD figures for the cross-reference. */
const ELECTION_SAMPLE: Record<string, unknown> = {
  loan_number: "1000000026", borrower_names: ["Jordan Park", "Casey Park"], property_address: "77 Buckeye Ln, Columbus OH 43215", partner_name: "Partner Bank, N.A.", election: "escrow_full", election_text: "escrow account for property taxes, homeowner's insurance and mortgage insurance (escrow_full)", waived: false,
  waiver_policy_version: "partner.escrow_waiver.2026-09", escrowed_items: "property taxes, homeowner's insurance and borrower-paid mortgage insurance", non_waivable_reason: "bpmi", non_waivable_reason_text: "borrower-paid mortgage insurance premiums cannot be waived (Fannie Mae Selling Guide B2-1.5-04)", waiver_fee_cents: 0n,
  initial_escrow_payment_cents: 187_500n, monthly_escrow_cents: 52_500n, escrowed_costs_year1_cents: 630_000n, interest_statement: "No interest is paid on escrow funds in Ohio (no state interest-on-escrow statute located; servicing 3.x).", state_notice_codes: [], elected_at: "2026-11-18T15:00:00.000Z", elected_at_text: "signing on November 18, 2026",
};

// ------------------------------------------------------------------ NTC_UT_7_17_4_RESERVE_OPTIONS (Utah Code §7-17-4)
const UT_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}NOTICE OF OPTIONS IN LIEU OF A RESERVE ACCOUNT (Utah Code Section 7-17-4){{/block}}
{{#block "ids" page=1 y=0.1 pt=11}}Lender: {{{partner_name}}}. Borrower(s): {{#each borrower_names}}{{this}}; {{/each}}Property: {{{property_address}}}. Loan number {{{loan_number}}}.{{/block}}
{{#block "options" page=1 y=0.16 pt=11}}You have two options. Option 1: you may elect to maintain a noninterest-bearing reserve account to be serviced by the lender at no charge to you, into which you pay monthly amounts for insurance premiums, taxes and other charges on the property. Option 2: you may manage the payment of insurance premiums, taxes and other charges for your own account, paying each directly when due.{{/block}}
{{#block "statements" page=1 y=0.3 pt=12 bold}}A reserve account is not required by the lender. You are legally responsible for the payment of taxes, insurance premiums, and other charges on the property whether or not a reserve account is maintained. You must select one of the options at the closing of the loan.{{/block}}
{{#block "interest" page=1 y=0.42 pt=11}}{{#if interest_on_reserve}}Because this loan does not exceed 80% of the appraised value, if a reserve account is maintained the lender will, on a yearly basis as of December 31, calculate and credit to the account interest on the average daily balance at the rate required by Utah Code Section 7-17-3.{{else}}While this loan exceeds 80% of the appraised value of the property, no interest is required to be credited to a reserve account (Utah Code Section 7-17-3(2)); interest is credited once the principal balance is paid down to 80%.{{/if}} A lender may not require or impose a service charge for the administration of a reserve account.{{/block}}
{{#block "default" page=1 y=0.54 pt=11}}If you elect to manage these payments yourself and fail to pay taxes, insurance premiums or other charges before the delinquency date, the lender may require you to establish a reserve account without interest, unless the delinquency is paid within 30 days and it is your first delinquency (Utah Code Section 7-17-4(3)).{{/block}}
{{#block "selection" page=1 y=0.66 pt=12 bold}}Your selection at closing: {{#if elected_reserve_account}}Option 1 — reserve account serviced by the lender at no charge.{{else}}Option 2 — you will pay taxes, insurance premiums and other charges for your own account.{{/if}}{{/block}}`;
const UT_RULES: ContentRule[] = [
  R("option-1", "Utah Code §7-17-4(1)(a)", "presence", "noninterest-bearing reserve account to be serviced by the lender at no charge", "option 1: noninterest-bearing reserve account serviced by the lender at no charge"),
  R("option-2", "Utah Code §7-17-4(1)(b)", "presence", "manage the payment of insurance premiums, taxes and other charges for your own account", "option 2: self-payment"),
  R("not-required", "Utah Code §7-17-4(2)(b)(i)", "presence", "a reserve account is not required by the lender", "statement that a reserve account is not required by the lender"),
  R("not-required-data", "Utah Code §7-17-4(2)(b)(i)", "data_equality", "reserve_required_by_lender", "lender does not require the account", { predicate: { "==": [{ var: "reserve_required_by_lender" }, false] } }),
  R("legally-responsible", "Utah Code §7-17-4(2)(b)(ii)", "presence", "legally responsible for the payment of taxes, insurance premiums, and other charges", "borrower legally responsible for taxes, insurance premiums and other charges"),
  R("select-at-closing", "Utah Code §7-17-4(2)(c)", "presence", "select one of the options at the closing", "selection at the closing"),
  R("statements-prominent", "Utah Code §7-17-4(2)(b): 'clearly describe'", "layout", "statements", "the mandated statements bold, ≥ 12 pt", { layout: { page: 1, bold: true, minPt: 12 } }),
  R("no-service-charge", "Utah Code §7-17-3", "presence", "may not require or impose a service charge for the administration of a reserve account", "no service charge"),
  R("no-service-charge-data", "Utah Code §7-17-3", "data_range", "service_charge_cents", "service charge is zero", { range: { min: 0, max: 0 } }),
  R("interest-rule", "Utah Code §7-17-3(1)–(2)", "data_equality", "interest_on_reserve,ltv_pct,interest_paid_from_ltv_pct", "interest credited on a required reserve account at ≤ 80% LTV; not while the loan exceeds 80%", { predicate: { or: [{ and: [{ "==": [{ var: "interest_on_reserve" }, true] }, { "<=": [{ var: "ltv_pct" }, 80] }] }, { and: [{ "==": [{ var: "interest_on_reserve" }, false] }, { or: [{ ">": [{ var: "ltv_pct" }, 80] }, { "==": [{ var: "elected_reserve_account" }, false] }] }] }] } }),
  R("selection-recorded", "Utah Code §7-17-4(2)(c); 25.4-T8 (`escrow_elections.elected_at ≤ consummation_at`)", "presence", "Your selection at closing: Option [12]", "the borrower's selection recorded"),
  R("self-pay-default", "Utah Code §7-17-4(3)", "presence", "establish a reserve account without interest", "the self-payment default consequence"),
];
/** T8: Utah property, LTV 70%, borrower elects a reserve account → interest credited (§7-17-3). */
const UT_SAMPLE: Record<string, unknown> = { partner_name: "Partner Bank, N.A.", borrower_names: ["Taylor Young"], property_address: "12 Wasatch Dr, Salt Lake City UT 84101", loan_number: "1000000034", ltv_pct: 70, election: "escrow_full", elected_reserve_account: true, interest_on_reserve: true, interest_paid_from_ltv_pct: 80, reserve_required_by_lender: false, service_charge_cents: 0n };

// ------------------------------------------------------------------ NTC_CA_CIV_2954_IMPOUND_STMT (Cal. Civ. Code §2954)
const CA_SOURCE = `{{#block "heading" page=1 y=0.04 pt=14 bold}}STATEMENT REGARDING IMPOUND ACCOUNT (California Civil Code Section 2954){{/block}}
{{#block "ids" page=1 y=0.1 pt=11}}Lender: {{{partner_name}}}. Borrower(s): {{#each borrower_names}}{{this}}; {{/each}}Property: {{{property_address}}}. Loan number {{{loan_number}}}.{{/block}}
{{#block "condition" page=1 y=0.16 pt=12 bold}}The establishment of an impound, trust, or other type of account for the payment of taxes on the property, insurance premiums, or other purposes relating to the property shall not be required as a condition of this loan on a single-family, owner-occupied dwelling.{{/block}}
{{#block "exception" page=1 y=0.26 pt=11}}{{#if account_may_be_required}}Exception: Civil Code Section 2954(a)(1) permits the account to be required where the original principal amount of the loan is 90 percent or more of the sale price or appraised value, or where the combined principal amount of all loans secured by the property exceeds 80 percent; this loan is within that exception, and this statement is provided as a matter of policy.{{else}}This loan is not within the exceptions of Civil Code Section 2954(a)(1); the account is established at your election.{{/if}}{{/block}}
{{#block "interest" page=1 y=0.36 pt=12 bold}}Interest will {{#if interest_paid}}{{else}}not {{/if}}be paid on the funds in the account. {{{interest_statement}}}{{/block}}
{{#block "election" page=1 y=0.46 pt=11}}You have elected to establish an impound account for the payment of taxes and insurance premiums. This statement is furnished before or with that election.{{/block}}`;
const CA_RULES: ContentRule[] = [
  R("not-required-as-condition", "Cal. Civ. Code §2954(a)", "presence", "shall not be required as a condition of this loan on a single-family, owner-occupied dwelling", "statement that the account is not required as a condition"),
  R("not-required-data", "Cal. Civ. Code §2954(a)", "data_equality", "required_as_condition,single_family_owner_occupied", "not a condition; single-family owner-occupied dwelling", { predicate: { and: [{ "==": [{ var: "required_as_condition" }, false] }, { "==": [{ var: "single_family_owner_occupied" }, true] }] } }),
  R("condition-prominent", "Cal. Civ. Code §2954(a): 'statement in writing'", "layout", "condition", "the statement bold, ≥ 12 pt", { layout: { page: 1, bold: true, minPt: 12 } }),
  R("interest-statement", "Cal. Civ. Code §2954(a): 'stating whether or not interest will be paid'", "presence", "Interest will (not )?be paid on the funds in the account", "whether or not interest will be paid"),
  R("interest-data", "Cal. Civ. Code §2954(a); §2954.8 (servicing 3.x)", "data_equality", "interest_paid", "interest yes/no carried as a boolean", { predicate: { in: [{ var: "interest_paid" }, [true, false]] } }),
  R("a1-exception", "Cal. Civ. Code §2954(a)(1)", "conditional", "account_may_be_required", "the (a)(1) exception named where the LTV is ≥ 90% or combined loans exceed 80%", { when: { "==": [{ var: "account_may_be_required" }, true] }, predicate: { ">=": [{ var: "ltv_pct" }, 80] } }),
  R("exception-text", "Cal. Civ. Code §2954(a)(1)", "presence", "(90 percent or more of the sale price|not within the exceptions of Civil Code Section 2954\\(a\\)\\(1\\))", "exception paragraph rendered"),
  R("election-timing", "25.4 timer table: 'delivered before or with the election'", "presence", "furnished before or with that election", "timing statement"),
];
/** T9: California single-family owner-occupied purchase at 85% LTV, impound elected → statute; not within (a)(1). */
const CA_SAMPLE: Record<string, unknown> = { partner_name: "Partner Bank, N.A.", borrower_names: ["Morgan Lee"], property_address: "900 Mission St, San Diego CA 92101", loan_number: "1000000042", ltv_pct: 85, single_family_owner_occupied: true, account_may_be_required: false, required_as_condition: false, interest_paid: false, interest_statement: "No interest will be paid on the funds in the impound account (Civ. Code §2954.8 — servicing 3.x applies any statutory interest)." };

export const VERSIONS_25_4: VersionInput[] = [
  V("NTC_SM_FIRST_PAYMENT_LETTER", FIRST_PAYMENT_SOURCE, FIRST_PAYMENT_RULES, FIRST_PAYMENT_SAMPLE, "sm.closing_notices.2026-09", "30.2 rule 9 first-payment letter (a)–(m); 12 CFR 1005.10(e)(1); 12 CFR 1022 App. B Model B-1; 25.4 worked example 3 ($3,927.62)"),
  V("NTC_REGZ_1026_39_OWNERSHIP_TRANSFER", OWNERSHIP_SOURCE, OWNERSHIP_RULES, OWNERSHIP_SAMPLE, "regz.1026_39.2011", "12 CFR 1026.39(d)(1)–(5); comments 39(d)(1)-1, 39(d)(3)-2, 39(d)(4)-1, 39(d)(5)-1; 25.4 assignee example (Nov 12 → Dec 12, 2026)"),
  V("NTC_SM_ESCROW_ELECTION", ELECTION_SOURCE, ELECTION_RULES, ELECTION_SAMPLE, "sm.closing_notices.2026-09", "Fannie Mae Selling Guide B2-1.5-04; 12 CFR 1026.35(b)(1); 25.4 worked examples 2–3"),
  V("NTC_UT_7_17_4_RESERVE_OPTIONS", UT_SOURCE, UT_RULES, UT_SAMPLE, "ut.7_17_4.2010", "Utah Code §§7-17-3, 7-17-4 (ch. 378, 2010 General Session); 25.4-T8"),
  V("NTC_CA_CIV_2954_IMPOUND_STMT", CA_SOURCE, CA_RULES, CA_SAMPLE, "ca.civ_2954.2011", "Cal. Civ. Code §2954(a), (a)(1), (c) (eff. Jan 1, 2011); 25.4-T9"),
];
export const OVERRIDES_25_4: Record<string, Partial<NoticeTemplate>> = {
  NTC_SM_FIRST_PAYMENT_LETTER: { name: "First-payment letter (with autopay enrollment offer)", citation: "30.2 rule 9; 12 CFR 1005.10(e)(1); 15 U.S.C. 1681s-2(a)(7)", noticeClass: "general_correspondence", channelPolicy: "esign_or_mail", separateDocument: false, mayCombineWith: ["NTC_FCRA_1681S2A7_B1", "NTC_ESIGN_7001C_DISCLOSURE"], retention: "fnma_loan_file_life_plus_4y", piiLevel: "medium" },
  NTC_REGZ_1026_39_OWNERSHIP_TRANSFER: { name: "Notice of transfer of ownership of the mortgage loan (§1026.39)", citation: "12 CFR 1026.39", noticeClass: "regx_correspondence", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: [], retention: "fnma_loan_file_life_plus_4y", piiLevel: "medium" },
  NTC_SM_ESCROW_ELECTION: { name: "Escrow account election record", citation: "Fannie Mae Selling Guide B2-1.5-04; 12 CFR 1026.35(b)", noticeClass: "closing", channelPolicy: "esign_or_mail", separateDocument: false, mayCombineWith: ["NTC_UT_7_17_4_RESERVE_OPTIONS", "NTC_CA_CIV_2954_IMPOUND_STMT"], retention: "fnma_loan_file_life_plus_4y", piiLevel: "medium" },
  NTC_UT_7_17_4_RESERVE_OPTIONS: { name: "Utah notice of options in lieu of a reserve account", citation: "Utah Code §7-17-4", noticeClass: "closing", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: ["NTC_SM_ESCROW_ELECTION"], retention: "fnma_loan_file_life_plus_4y", piiLevel: "medium" },
  NTC_CA_CIV_2954_IMPOUND_STMT: { name: "California impound account statement", citation: "Cal. Civ. Code §2954", noticeClass: "closing", channelPolicy: "esign_or_mail", separateDocument: true, mayCombineWith: ["NTC_SM_ESCROW_ELECTION"], retention: "fnma_loan_file_life_plus_4y", piiLevel: "medium" },
};
