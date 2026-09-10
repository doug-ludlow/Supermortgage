/**
 * §4 case commands' pure core: the `case.noe.opened` / `case.rfi.opened` / `case.complaint.opened` payloads the timer
 * registry anchors on (per-assertion profile flags and the computed due dates the 4.1/4.5 overrides in timers.ts name),
 * the §1024.35(i) credit-reporting suppression slice (rule 9), and the rule-6 correction entry sets — ledger-neutral
 * reversals plus re-postings with the original effective date, never edits. The command bus wrappers live in
 * src/app/tools/section04.ts; everything here is deterministic and testable without a runtime.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import type { EntrySet, EntrySetInput, LoanAccount, CorporateAccount } from "../../kernel/ledger/ledger.ts";
import { deadlines, isForeclosureAssertion, isPaymentRelated, noeForeclosureDue, type AssertionType, type Deadlines } from "./noe.ts";
import { itemDeadlines, type ItemKind } from "./rfi.ts";
import { nyDeadlines, triage, cfpbDeadlines, tx50a6Allegation, type NyComplaintCategory } from "./complaints.ts";
import { nyNoeDeadline } from "./ops.ts";
import { federalDays } from "./clocks.ts";

// ---------------------------------------------------------------- 4.1 NoE
export interface NoeAssertionInput { readonly id: string; readonly category: AssertionType; readonly description?: string; readonly period?: string; readonly amount_asserted_cents?: Cents; /** Rule 4: false only for the unidentifiable residue of an overbroad letter (the (g)(1)(ii) exception may attach to it alone). */ readonly identifiable?: boolean; }
export interface NoeOpenInput { readonly case_id: string; readonly loan_id: string; readonly receipt_date: PlainDate; readonly receipt_at?: string; readonly state?: string | null; readonly assertions: readonly NoeAssertionInput[]; readonly foreclosure_sale_date?: PlainDate | null; readonly is_qwr?: boolean; readonly linked_case_ids?: readonly string[]; }
export interface NoeOpenedAssertion { readonly id: string; readonly category: AssertionType; readonly profile: Deadlines["profile"]; readonly ack_due: PlainDate | null; readonly response_due: PlainDate; readonly extendable: boolean; readonly identifiable: boolean; }
export interface NoeOpenedPayload extends Record<string, unknown> {
  readonly case_id: string; readonly receipt_date: PlainDate; readonly receipt_at: string | null; readonly state: string | null;
  readonly assertions: readonly NoeOpenedAssertion[];
  /** Per-profile trigger qualifiers (4.1 timer table: "with any `b6`", "with any `b9`/`b10`", "with profile `std_30`", "any payment-related assertion"). */
  readonly payoff_assertion: boolean; readonly foreclosure_assertion: boolean; readonly std_assertion: boolean; readonly payment_related: boolean;
  /** A b9/b10 assertion on the (e)(3)(i)(B) sale-or-30 clock (profile `fc_before_sale`) vs. one on the §1024.35(f)(2) good-faith path (`fc_within_7_days_goodfaith`, where (d) and (e) do not apply). */
  readonly fc_response_assertion: boolean; readonly goodfaith_assertion: boolean;
  /** §1024.35(f)(2): (d) does not apply when every assertion is on the ≤7-days-before-sale good-faith path — no ack timer (4.1-T5). */
  readonly ack_required: boolean;
  readonly foreclosure_sale_date: PlainDate | null; readonly days_before_sale: number | null;
  /** min(30 federal BD, sale − 1) — anchor of REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30. */
  readonly noe_fc_response_due: PlainDate | null;
  /** NY: min(15 servicer BD, sale − 1) — anchor of NY_419_6_NOE_FC_RESPONSE_15BD. */
  readonly ny_noe_fc_response_due: PlainDate | null;
  readonly linked_case_ids: readonly string[];
}
/** The `case.noe.opened` event payload: profiles are per assertion (rule 3), the trigger qualifiers are the union. */
export function noeOpenedPayload(f: NoeOpenInput): NoeOpenedPayload {
  const sale = f.foreclosure_sale_date ?? null;
  const assertions = f.assertions.map((a) => { const d = deadlines(a.category, f.receipt_date, { sale_date: sale }); return { id: a.id, category: a.category, profile: d.profile, ack_due: d.ack_due, response_due: d.response_due, extendable: d.extendable, identifiable: a.identifiable !== false }; });
  const fc = f.assertions.some((a) => isForeclosureAssertion(a.category));
  const state = f.state ?? null;
  return {
    case_id: f.case_id, receipt_date: f.receipt_date, receipt_at: f.receipt_at ?? null, state, assertions,
    payoff_assertion: f.assertions.some((a) => a.category === "b6"), foreclosure_assertion: fc, std_assertion: assertions.some((a) => a.profile === "std_30"), payment_related: f.assertions.some((a) => isPaymentRelated(a.category)),
    fc_response_assertion: assertions.some((a) => a.profile === "fc_before_sale"), goodfaith_assertion: assertions.some((a) => a.profile === "fc_within_7_days_goodfaith"),
    ack_required: assertions.some((a) => a.ack_due !== null),
    foreclosure_sale_date: sale, days_before_sale: sale ? daysBetween(f.receipt_date, sale) : null,
    noe_fc_response_due: fc ? noeForeclosureDue(f.receipt_date, sale) : null,
    ny_noe_fc_response_due: fc && state === "NY" ? nyNoeDeadline(f.receipt_date, { foreclosure_assertion: true, sale_on: sale }).response_due : null,
    linked_case_ids: f.linked_case_ids ?? [],
  };
}
export interface NoeRespondedPayload extends Record<string, unknown> {
  readonly case_id: string; readonly assertion_ids: readonly string[];
  /** The profiles the response covers (rule 3: "the response may be one letter by day 7 or two letters") — the 4.1 timer rows are satisfied per assertion. */
  readonly payoff_assertion: boolean; readonly foreclosure_assertion: boolean; readonly std_assertion: boolean;
  /** Every assertion of the case has now been responded to (this response plus earlier ones). */
  readonly complete: boolean; readonly remaining_assertion_ids: readonly string[];
}
/** The `case.noe.responded` payload: which assertions this letter answers, the profile qualifiers the timer rows match, and whether the case is now fully responded. */
export function noeRespondedPayload(opened: NoeOpenedPayload, assertionIds: readonly string[], previouslyResponded: readonly string[] = []): NoeRespondedPayload {
  const answered = opened.assertions.filter((a) => assertionIds.includes(a.id));
  const done = new Set([...previouslyResponded, ...assertionIds]);
  const remaining = opened.assertions.filter((a) => !done.has(a.id)).map((a) => a.id);
  return { case_id: opened.case_id, assertion_ids: [...assertionIds], payoff_assertion: answered.some((a) => a.profile === "payoff_7"), foreclosure_assertion: answered.some((a) => isForeclosureAssertion(a.category)), std_assertion: answered.some((a) => a.profile === "std_30"), complete: remaining.length === 0, remaining_assertion_ids: remaining };
}
export interface SuppressionRow extends Record<string, unknown> { readonly loan_id: string; readonly case_id: string; readonly scope: readonly string[] | "all"; readonly starts_at: PlainDate; readonly ends_at: PlainDate; readonly reason: "regx_1024_35_i"; }
/** Rule 9 / §1024.35(i)(1): the 60-calendar-day suppression scoped to the disputed payment periods (or `all` for a b11 delinquency dispute); null when no assertion touches a payment. */
export function suppressionRow(f: NoeOpenInput): SuppressionRow | null {
  const pay = f.assertions.filter((a) => isPaymentRelated(a.category));
  if (!pay.length) return null;
  const periods = pay.map((a) => a.period).filter((p): p is string => !!p);
  return { loan_id: f.loan_id, case_id: f.case_id, scope: pay.some((a) => a.category === "b11") || !periods.length ? "all" : periods, starts_at: f.receipt_date, ends_at: addDays(f.receipt_date, 60), reason: "regx_1024_35_i" };
}
/** Rule 6: re-date a misapplied payment — the original allocation is reversed and re-posted with `effective_date` = actual receipt (the ledger is never edited). */
export function repostSet(original: EntrySet, effectiveDate: PlainDate, caseId: string): EntrySetInput {
  return { effectiveDate, description: `NoE ${caseId}: re-post of ${original.description} as of ${effectiveDate}`, sourceEventId: original.id, lines: original.lines.map((l) => ({ account: l.account, amountCents: l.amountCents, ruleRef: "4.1:r6:repost", memo: `NoE ${caseId} re-dated from ${original.effectiveDate}` })) };
}
const FEE_INCOME: Record<"late_charges" | "nsf_fees" | "other_fees", CorporateAccount> = { late_charges: "late_charge_income", nsf_fees: "nsf_fee_income", other_fees: "servicing_fee_income" };
/**
 * Rule 6: a fee lacking a basis is reversed as of its assessment date — credit the loan's fee receivable (the spec's
 * `borrower_receivable` leg is the `late_charges`/`nsf_fees`/`other_fees` loan account) and debit the income account it
 * was booked to; 9,211¢ in the worked example.
 */
export function feeReversalSet(loanId: string, account: "late_charges" | "nsf_fees" | "other_fees", amountCents: Cents, effectiveDate: PlainDate, caseId: string, reason: string, ruleRef = "4.1:r6:fee_reversal"): EntrySetInput {
  if (amountCents <= 0n) throw new RangeError("a fee reversal needs a positive amount");
  const loan: LoanAccount = account;
  return { effectiveDate, description: `NoE ${caseId}: reverse ${account} ${amountCents}¢ — ${reason}`, lines: [{ account: { scope: "loan", loanId, account: loan }, amountCents: -amountCents, ruleRef, memo: reason }, { account: { scope: "corporate", account: FEE_INCOME[account] }, amountCents, ruleRef, memo: reason }] };
}

// ---------------------------------------------------------------- 4.2 RFI
export interface RfiItemInput { readonly id: string; readonly kind: ItemKind | "document_request"; readonly description?: string; }
export interface RfiOpenInput { readonly case_id: string; readonly receipt_date: PlainDate; readonly state?: string | null; readonly requester_role?: "borrower" | "agent" | "confirmed_successor" | "potential_successor"; readonly items: readonly RfiItemInput[]; readonly is_potential_successor_request?: boolean; readonly linked_case_ids?: readonly string[]; }
export interface RfiOpenedPayload extends Record<string, unknown> {
  readonly case_id: string; readonly receipt_date: PlainDate; readonly state: string | null; readonly requester_role: string;
  readonly items: readonly { id: string; kind: RfiItemInput["kind"]; ack_due: PlainDate; response_due: PlainDate; extendable: boolean }[];
  readonly owner_identity_item: boolean; readonly std_item: boolean; readonly document_request_item: boolean; readonly is_potential_successor_request: boolean; readonly linked_case_ids: readonly string[];
  /** §1024.36(i)/comment 36(i)-2: the document description is due within the (d)(2) limit — 30 federal BD, or 10 when the request also asks owner identity — the anchor of REGX_1024_36I_SII_RFI_RESPONSE_30. */
  readonly sii_docs_due: PlainDate | null;
}
/** The `case.rfi.opened` payload: each item carries its own profile (rule 1); the qualifiers drive the 4.2 timer triggers. */
export function rfiOpenedPayload(f: RfiOpenInput): RfiOpenedPayload {
  const state = f.state ?? null;
  const items = f.items.map((it) => { const d = itemDeadlines(it.kind === "owner_identity" ? "owner_identity" : "standard", f.receipt_date, state ?? undefined); return { id: it.id, kind: it.kind, ...d }; });
  const owner = f.items.some((i) => i.kind === "owner_identity"); const sii = f.is_potential_successor_request === true;
  return { case_id: f.case_id, receipt_date: f.receipt_date, state, requester_role: f.requester_role ?? "borrower", items, owner_identity_item: owner, std_item: f.items.some((i) => i.kind !== "owner_identity"), document_request_item: f.items.some((i) => i.kind === "document_request"), is_potential_successor_request: sii, linked_case_ids: f.linked_case_ids ?? [], sii_docs_due: sii ? federalDays(f.receipt_date, owner ? 10 : 30) : null };
}
export interface RfiRespondedPayload extends Record<string, unknown> { readonly case_id: string; readonly item_ids: readonly string[]; readonly owner_identity_item: boolean; readonly std_item: boolean; readonly complete: boolean; readonly remaining_item_ids: readonly string[]; }
/** The `case.rfi.responded` payload: which items this answer covers (rule 1: each item has its own profile) and whether every item is now answered. */
export function rfiRespondedPayload(opened: RfiOpenedPayload, itemIds: readonly string[], previouslyResponded: readonly string[] = []): RfiRespondedPayload {
  const answered = opened.items.filter((it) => itemIds.includes(it.id));
  const done = new Set([...previouslyResponded, ...itemIds]);
  const remaining = opened.items.filter((it) => !done.has(it.id)).map((it) => it.id);
  return { case_id: opened.case_id, item_ids: [...itemIds], owner_identity_item: answered.some((it) => it.kind === "owner_identity"), std_item: answered.some((it) => it.kind !== "owner_identity"), complete: remaining.length === 0, remaining_item_ids: remaining };
}

// ---------------------------------------------------------------- 4.4 SII policy anchors
/**
 * 4.4 timer table / state machine: the "promptly" policy clocks — facilitate 2, document description 5, determination 10,
 * additional documents 5 federal BD — and "the `lossmit_pending` flag shortens every policy timer" (comment 38(b)(1)(vi)-5;
 * 4.4-T8 "all SII policy timers halve"): 1 / 2 / 5 / 2. Computed into the payload anchors the 4.4 overrides name.
 */
export function siiPolicyDue(anchor: PlainDate, lossmitPending: boolean): { facilitate_due: PlainDate; docs_description_due: PlainDate; determination_due: PlainDate; addl_docs_due: PlainDate } {
  const h = lossmitPending;
  return { facilitate_due: federalDays(anchor, h ? 1 : 2), docs_description_due: federalDays(anchor, h ? 2 : 5), determination_due: federalDays(anchor, h ? 5 : 10), addl_docs_due: federalDays(anchor, h ? 2 : 5) };
}

// ---------------------------------------------------------------- 4.5 complaints
export interface ComplaintOpenInput { readonly case_id: string; readonly received_on: PlainDate; readonly received_at?: string; readonly state?: string | null; readonly channel: "mail" | "fax" | "email" | "web_form" | "secure_message" | "chat_transcript" | "voice_transcript" | "sms" | "regulator_portal" | "cfpb_portal" | "attorney"; readonly source: "borrower_direct" | "successor" | "agent" | "cfpb_portal" | "state_regulator" | "state_ag" | "hud_fheo" | "fannie_mae_referral" | "partner" | "bbb" | "social" | "attorney_demand" | "internal_detected"; readonly text: string; readonly complaints_90d?: number; readonly ny_category?: NyComplaintCategory; readonly sale_on?: PlainDate | null; readonly external_ref?: string; readonly flags?: readonly string[]; /** 1.1 boarding flag: the loan is a Texas §50(a)(6) home-equity loan (Form 20 escalation runbook). */ readonly tx_50a6_loan?: boolean; }
export interface ComplaintOpenedPayload extends Record<string, unknown> {
  readonly case_id: string; readonly received: PlainDate; readonly received_at: string; readonly state: string | null; readonly source: string; readonly channel: string; readonly is_oral: boolean;
  readonly severity: "critical" | "standard"; readonly repeat: boolean; readonly opens_noe: boolean; readonly script_1024_38b5: boolean; readonly flags: readonly string[];
  /** NY 419.6 anchors: ack 5 BD; response 30 / 15-or-before-sale / 7 BD by category — anchor `ny_response_due` of NY_419_6_COMPLAINT_RESPONSE_30BD. */
  readonly ny_ack_due: PlainDate | null; readonly ny_response_due: PlainDate | null;
  readonly cfpb_response_by: PlainDate | null; readonly cfpb_final_by: PlainDate | null; readonly regulator_portal: "cfpb" | null; readonly external_ref: string | null;
  /** A §50(a)(6) loan whose complaint alleges a constitutional defect → Form 20 escalation and the 60-day cure clock (4.5-T5). */
  readonly tx_50a6_defect_alleged: boolean;
}
/** The `case.complaint.opened` payload: triage flags (rule 2), the NY 419.6 anchors and the CFPB portal dates. Only a voice transcript is oral (4.1 inputs: chat/secure-message/email/web-form text is "written"). */
export function complaintOpenedPayload(f: ComplaintOpenInput): ComplaintOpenedPayload {
  const oral = f.channel === "voice_transcript";
  const t = triage({ text: f.text, complaints_90d: f.complaints_90d ?? 0, channel: oral ? "oral" : "written" });
  const state = f.state ?? null;
  const ny = state === "NY" ? nyDeadlines(f.received_on, { category: f.ny_category ?? "standard", sale_on: f.sale_on ?? null }) : null;
  const cfpb = f.source === "cfpb_portal" ? cfpbDeadlines(f.received_on) : null;
  return { case_id: f.case_id, received: f.received_on, received_at: f.received_at ?? `${f.received_on}T12:00:00.000Z`, state, source: f.source, channel: f.channel, is_oral: oral, severity: t.severity, repeat: t.repeat, opens_noe: t.opens_noe, script_1024_38b5: t.script_1024_38b5, flags: f.flags ?? [], ny_ack_due: ny?.ack_by ?? null, ny_response_due: ny?.response_by ?? null, cfpb_response_by: cfpb?.response_by ?? null, cfpb_final_by: cfpb?.final_by ?? null, regulator_portal: f.source === "cfpb_portal" ? "cfpb" : null, external_ref: f.external_ref ?? null, tx_50a6_defect_alleged: (f.tx_50a6_loan === true || (f.flags ?? []).includes("tx_50a6")) && tx50a6Allegation(f.text) };
}
/** Rule 5 / guardrails: response text never conditions resolution on payment and never promises a loss-mitigation outcome. */
export function complaintResponseCheck(text: string): { ok: boolean; violations: string[] } {
  const v: string[] = [];
  if (/must (pay|bring your account current|remit)[^.]{0,60}(before|to|for) (we|our|us)/i.test(text)) v.push("resolution conditioned on payment");
  if (/(guarantee|promise|assure)[^.]{0,40}(modification|forbearance|approv|loss mitigation)/i.test(text) || /you will be approved/i.test(text)) v.push("promised a loss-mitigation outcome");
  return { ok: v.length === 0, violations: v };
}
