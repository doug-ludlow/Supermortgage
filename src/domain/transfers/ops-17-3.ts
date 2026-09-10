/**
 * §17.3 Data/document transfer — operating rules over the §1.6/§17.3
 * calculators in reconciliation.ts, custody-mers.ts and respa.ts: the
 * deliverable plan (D01–D34), the outbound data-quality gate and its tie-outs
 * (T3), the post-T receipt rule (T4), the final-period close (T5), the final
 * accounting and advances-reimbursement watches (T6), the eNote Servicing
 * Agent hand-off (T7), the partner's MIN Update file and post-transfer
 * snapshot (T8), transferee requests (T9), the one-year NoE/RFI tail (T10),
 * the Form 2009 hand-off (T11), retention and de-identification (T12), the
 * preliminary QC (T13), the CBAM LOA-cancellation task (T14), the
 * counterparty notification groups, the custodial-account disposition, the
 * ledger entry sets at freeze, and the bus-facing rules the 17.3 tools apply:
 * the per-deliverable acknowledgment conditions (F-1-11 as-of / load report /
 * index / every custodial account), the cutover freeze (not before COB T−1, no
 * postings dated ≥ T), wire matching, the shortage/surplus resolution, the T+30
 * custodial adjustment window, the participation-notes hand-off, the final
 * cycle notice content and the partner's MERS acknowledgment rows. Every
 * function is pure; nothing here edits a balance — differences are
 * categorized and escalated (§17.3 guardrail).
 */
import { type PlainDate, addDays, addYears, max as maxDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { EntrySetInput, LineInput } from "../../kernel/ledger/ledger.ts";
import { eventDeadlineMs, fannieBusinessDay } from "../investor/period.ts";
import { deadlines as noeDeadlines, exceptionNoticeDue, type AssertionType, type Deadlines } from "../servicing-requests/noe.ts";
import { outboundSchedule, finalPeriodCloseMs, transfereeRequestDue, finalAccountingDue, expectedWires, type LoanBalances } from "./reconciliation.ts";
import { mersTransaction, mersClocks, form2009Overdue } from "./custody-mers.ts";
import type { MersTxnRow, MersTxnType } from "./inbound.ts";
import { forwardBy } from "./respa.ts";
import { SUPERMORTGAGE_ORG_ID } from "./inbound.ts";
import type { TransferType } from "./batch.ts";

export interface Escalation { readonly kind: "officer" | "attorney" | "signing_officer" | "fnma_portal_operator" | "human_portal_task"; readonly to?: "supermortgage" | "partner" | "transferee"; readonly severity?: "sev1" | "sev2" | "sev3" | "sev4"; readonly reason: string; }

// ============================================================ deliverable plan (D01–D34)
export type DeliverableKind = "D01" | "D02" | "D03" | "D04" | "D05" | "D06" | "D07" | "D08" | "D09" | "D10" | "D11" | "D12" | "D13" | "D14" | "D15" | "D16" | "D17" | "D18" | "D19" | "D20" | "D21" | "D22" | "D23" | "D24" | "D25" | "D26" | "D27" | "D28" | "D29" | "D30" | "D31" | "D32" | "D33" | "D34";
export type DeliverableRecipient = "transferee" | "transferee_custodian" | "transferor_custodian" | "fnma" | "mi" | "insurer" | "vendor" | "law_firm" | "trustee";
export type DeliverableStatus = "planned" | "generated" | "validated" | "attested" | "delivered" | "acked" | "exception" | "resolved";
export const DELIVERABLE_KINDS: Readonly<Record<DeliverableKind, string>> = {
  D01: "test_tape", D02: "preliminary_tape", D03: "final_tape", D04: "trial_balance", D05: "payment_history_life_of_loan", D06: "escrow_history", D07: "escrow_analyses", D08: "custodial_bank_recons", D09: "investor_reports_3m", D10: "shortage_surplus_recon",
  D11: "code_definitions", D12: "mi_list_and_approvals", D13: "insurance_list_expirations_optional", D14: "unpaid_bills_as_of_T", D15: "tax_flood_contracts_or_tape_notice", D16: "autodraft_list_with_authorizations", D17: "arm_details", D18: "emortgage_list_enote_copies_audit_trail", D19: "delinquency_default_info", D20: "fc_bk_lists_with_law_firms",
  D21: "workout_status", D22: "litigation_records", D23: "correspondence_complaints_escalations", D24: "title_policies", D25: "acquired_property_records", D26: "acp_enrollment", D27: "fair_lending_data", D28: "image_bundle_with_index", D29: "consents_evidence", D30: "successor_and_party_records",
  D31: "final_accounting", D32: "forwarding_file_daily", D33: "credit_reporting_handoff", D34: "open_case_handoff",
};
/** The status ladder per deliverable: planned → generated → validated → attested → delivered → acked (or exception → resolved). */
export const DELIVERABLE_NEXT: Readonly<Record<DeliverableStatus, readonly DeliverableStatus[]>> = { planned: ["generated"], generated: ["validated", "exception"], validated: ["attested", "exception"], attested: ["delivered"], delivered: ["acked", "exception"], acked: [], exception: ["resolved"], resolved: ["generated"] };
export const DELIVERABLE_RECIPIENTS: readonly DeliverableRecipient[] = ["transferee", "transferee_custodian", "transferor_custodian", "fnma", "mi", "insurer", "vendor", "law_firm", "trustee"];
/** Regeneration follows the ladder (planned / resolved → generated); an acknowledged deliverable is regenerated only as an explicit correction — the transferee's load report showed differences (Bulletin 2020-02 preliminary QC: "a corrected preliminary"), so the corrected file climbs the ladder again and is acknowledged again. */
export function regenerationAllowed(from: DeliverableStatus, corrected: boolean): { allowed: boolean; refusal: string | null } {
  if (DELIVERABLE_NEXT[from].includes("generated")) return { allowed: true, refusal: null };
  if (from === "acked" && corrected) return { allowed: true, refusal: null };
  if (from === "acked") return { allowed: false, refusal: "deliverable is acked; regenerate it only as a correction (corrected=true) when the transferee's load report or exception file showed differences" };
  return { allowed: false, refusal: `deliverable is ${from}; cannot generate (planned → generated → validated → attested → delivered → acked; exception → resolved → generated)` };
}
// ============================================================ batch population facts (the timer conditions the spec keys on)
/** The listed loans' facts the 17.3 timer conditions read: foreclosure/litigation (SM_XFER_OUT_LAW_FIRM_NOTICE_T1), bankruptcy (SM_XFER_OUT_BK_TRUSTEE_NOTICE_T1), eNotes (FNMA_F1_11_ENOTE_SERVICING_AGENT_T0), participation pools (FNMA_F1_11_PARTICIPATION_NOTES_30) and the MI insurers (MI_MGIC_TRANSFER_NOTICE_60). */
export interface ListedLoanFacts { readonly loan_id: string; readonly foreclosure?: boolean; readonly litigation?: boolean; readonly bankruptcy?: boolean; readonly enote?: boolean; readonly mi?: string | null; readonly participation_pool?: boolean; }
export interface BatchPopulationFacts { readonly loan_count: number; readonly fc_or_litigation: number; readonly bk: number; readonly emortgage_count: number; readonly participation_pool: number; readonly mi_insurers: readonly string[]; }
/** Counts from the attested loan list (17.1); an explicit count wins over the derived one (the loan list may be summarized). */
export function batchPopulationFacts(loans: readonly ListedLoanFacts[], explicit: Partial<BatchPopulationFacts> = {}): BatchPopulationFacts {
  const n = (v: number | undefined, derived: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : derived);
  const insurers = [...new Set([...(explicit.mi_insurers ?? []), ...loans.map((l) => l.mi).filter((m): m is string => typeof m === "string" && m !== "")])];
  return { loan_count: n(explicit.loan_count, loans.length), fc_or_litigation: n(explicit.fc_or_litigation, loans.filter((l) => l.foreclosure || l.litigation).length), bk: n(explicit.bk, loans.filter((l) => l.bankruptcy).length), emortgage_count: n(explicit.emortgage_count, loans.filter((l) => l.enote).length), participation_pool: n(explicit.participation_pool, loans.filter((l) => l.participation_pool).length), mi_insurers: insurers };
}
/** MGIC (Mar 12, 2026): "Notify us within 60 days of acquiring or selling servicing rights" — due T+60 (policy: sent at T−1 servicer BD); other insurers per master policy [UNVERIFIED — default: notify before T]. One pending notice per insurer of the batch; the MGIC one is the MI_MGIC_TRANSFER_NOTICE_60 row. */
export function miTransferNotices(transferDate: PlainDate, insurers: readonly string[]): { mi: string; due: PlainDate; send_by: PlainDate; timer: "MI_MGIC_TRANSFER_NOTICE_60" | "SM_XFER_OUT_MI_NOTICE_T1"; event: { type: "transfer.mi_transfer_notice.pending"; mi: string; transfer_date: PlainDate } }[] {
  return [...new Set(insurers)].map((mi) => ({ mi, due: addDays(transferDate, 60), send_by: addBusinessDays(transferDate, -1, servicer), timer: mi === "MGIC" ? "MI_MGIC_TRANSFER_NOTICE_60" : "SM_XFER_OUT_MI_NOTICE_T1", event: { type: "transfer.mi_transfer_notice.pending", mi, transfer_date: transferDate } }));
}
export interface PlannedDeliverable { readonly kind: DeliverableKind; readonly name: string; readonly as_of: PlainDate; readonly due: PlainDate; readonly recipient: DeliverableRecipient; readonly channel: "sftp" | "edelivery_mers" | "custodian_portal" | "email" | "portal" | "restricted"; readonly status: "planned"; }
/** Rule 17.3 deliverable schedule: as-of and due dates for every F-1-11 deliverable from the transfer date (test T−30, preliminary T−14, final/trial balance COB T−1 delivered T+1 BD, images T+5 BD, custodial recons T+5 BD, final accounting T+30). */
export function planDeliverables(T: PlainDate): PlannedDeliverable[] {
  const s = outboundSchedule(T) as Record<string, PlainDate>; const tMinus1 = addDays(T, -1);
  const row = (kind: DeliverableKind, as_of: PlainDate, due: PlainDate, recipient: DeliverableRecipient = "transferee", channel: PlannedDeliverable["channel"] = "sftp"): PlannedDeliverable => ({ kind, name: DELIVERABLE_KINDS[kind], as_of, due, recipient, channel, status: "planned" });
  return [
    row("D01", s.test_tape_by!, s.test_tape_by!), row("D02", s.preliminary_by!, s.preliminary_by!), row("D03", tMinus1, s.final_tape_by!), row("D04", tMinus1, s.final_tape_by!), row("D05", tMinus1, s.final_tape_by!), row("D06", tMinus1, s.final_tape_by!), row("D07", tMinus1, s.final_tape_by!),
    row("D08", tMinus1, s.custodial_recons_by!), row("D09", tMinus1, s.final_tape_by!), row("D10", tMinus1, s.final_accounting_by!), row("D11", tMinus1, s.final_tape_by!), row("D12", tMinus1, s.final_tape_by!), row("D13", tMinus1, s.final_tape_by!), row("D14", T, s.final_tape_by!), row("D15", tMinus1, s.final_tape_by!),
    row("D16", tMinus1, s.final_tape_by!), row("D17", tMinus1, s.final_tape_by!), row("D18", tMinus1, s.counterparties_by!, "transferee", "edelivery_mers"), row("D19", tMinus1, s.final_tape_by!), row("D20", tMinus1, s.final_tape_by!), row("D21", tMinus1, s.final_tape_by!), row("D22", tMinus1, s.final_tape_by!), row("D23", tMinus1, s.images_by!),
    row("D24", tMinus1, s.images_by!), row("D25", tMinus1, s.final_tape_by!), row("D26", tMinus1, s.final_tape_by!), row("D27", tMinus1, s.final_tape_by!, "transferee", "restricted"), row("D28", tMinus1, s.images_by!), row("D29", tMinus1, s.images_by!), row("D30", tMinus1, s.final_tape_by!),
    row("D31", T, s.final_accounting_by!), row("D32", T, s.final_tape_by!), row("D33", tMinus1, s.final_tape_by!), row("D34", tMinus1, s.final_tape_by!),
  ];
}

// ============================================================ T3 outbound data-quality gate
export interface OutboundLoanTieOut { readonly loan_id: string; readonly tape_upb_cents: Cents; readonly trial_balance_upb_cents: Cents; readonly ledger_principal_cents: Cents; readonly fnma_position_upb_cents?: Cents | null; readonly tape_escrow_cents?: Cents; readonly ledger_escrow_cents?: Cents; readonly tape_unapplied_cents?: Cents; readonly ledger_unapplied_cents?: Cents; }
export type TieOutRule = "TIE_OUT_UPB_TAPE_TRIAL_BALANCE" | "TIE_OUT_UPB_TAPE_LEDGER" | "TIE_OUT_UPB_FNMA_POSITION" | "TIE_OUT_ESCROW" | "TIE_OUT_UNAPPLIED" | "TIE_OUT_DOCUMENT_COUNT";
export interface TieOutFailure { readonly loan_id: string | null; readonly rule: TieOutRule; readonly left_cents: Cents; readonly right_cents: Cents; readonly variance_cents: Cents; readonly category: "unknown"; readonly resolution: "resolve_with_evidence_or_escalate"; readonly balance_edit_allowed: false; }
export interface OutboundDqResult { readonly passed: boolean; readonly hard_failures: TieOutFailure[]; readonly hard_rule_failures: readonly { loan_id: string; rule: string }[]; readonly totals: { tape_upb_cents: Cents; trial_balance_upb_cents: Cents; ledger_principal_cents: Cents; fnma_position_upb_cents: Cents | null }; readonly attestation_blocked: boolean; readonly balance_edits: readonly never[]; readonly refusal: string | null; readonly rule_set_version: string; }
export const OUTBOUND_RULE_SET_VERSION = "1.1-outbound@HF-001..HF-020,W-001..W-016+tie-outs";
/** Rule 17.3 outbound DQ gate: Σ tape UPB = Σ trial-balance UPB = Σ ledger principal = Fannie Mae position; escrow and unapplied tie per loan; document counts tie to the image index. Any hard failure blocks attestation; the agent categorizes the difference and never edits a balance. */
export function outboundDqGate(i: { loans: readonly OutboundLoanTieOut[]; hard_rule_failures?: readonly { loan_id: string; rule: string }[]; document_count?: number; image_index_count?: number; fnma_position_total_cents?: Cents | null }): OutboundDqResult {
  const fail: TieOutFailure[] = [];
  const f = (loan_id: string | null, rule: TieOutRule, l: Cents, r: Cents): void => { if (l !== r) fail.push({ loan_id, rule, left_cents: l, right_cents: r, variance_cents: r - l, category: "unknown", resolution: "resolve_with_evidence_or_escalate", balance_edit_allowed: false }); };
  let tape = 0n, tb = 0n, ledger = 0n, fnma = 0n, anyFnma = false;
  for (const l of i.loans) {
    tape += l.tape_upb_cents; tb += l.trial_balance_upb_cents; ledger += l.ledger_principal_cents; if (l.fnma_position_upb_cents != null) { fnma += l.fnma_position_upb_cents; anyFnma = true; }
    f(l.loan_id, "TIE_OUT_UPB_TAPE_TRIAL_BALANCE", l.tape_upb_cents, l.trial_balance_upb_cents); f(l.loan_id, "TIE_OUT_UPB_TAPE_LEDGER", l.tape_upb_cents, l.ledger_principal_cents);
    if (l.fnma_position_upb_cents != null) f(l.loan_id, "TIE_OUT_UPB_FNMA_POSITION", l.ledger_principal_cents, l.fnma_position_upb_cents);
    if (l.tape_escrow_cents !== undefined && l.ledger_escrow_cents !== undefined) f(l.loan_id, "TIE_OUT_ESCROW", l.tape_escrow_cents, l.ledger_escrow_cents);
    if (l.tape_unapplied_cents !== undefined && l.ledger_unapplied_cents !== undefined) f(l.loan_id, "TIE_OUT_UNAPPLIED", l.tape_unapplied_cents, l.ledger_unapplied_cents);
  }
  const fnmaTotal = i.fnma_position_total_cents ?? (anyFnma ? fnma : null);
  if (fnmaTotal !== null) f(null, "TIE_OUT_UPB_FNMA_POSITION", ledger, fnmaTotal);
  if (i.document_count !== undefined && i.image_index_count !== undefined) f(null, "TIE_OUT_DOCUMENT_COUNT", BigInt(i.document_count), BigInt(i.image_index_count));
  const hardRules = i.hard_rule_failures ?? [];
  const passed = fail.length === 0 && hardRules.length === 0;
  return { passed, hard_failures: fail, hard_rule_failures: hardRules, totals: { tape_upb_cents: tape, trial_balance_upb_cents: tb, ledger_principal_cents: ledger, fnma_position_upb_cents: fnmaTotal }, attestation_blocked: !passed, balance_edits: [], rule_set_version: OUTBOUND_RULE_SET_VERSION,
    refusal: passed ? null : `attestation blocked: ${fail.length} tie-out failure(s) and ${hardRules.length} hard-rule failure(s) — differences are categorized and resolved with evidence or escalated; no balance may be altered to make a tie-out pass (§1024.38(b)(4)(i))` };
}
/** Rule 17.3: the attestation is an `officer` act over a passed gate; it states the as-of date, rule-set version, scorecard and tie-outs. */
export function attestationGate(i: { dq: OutboundDqResult; as_of: PlainDate; attested_by: { kind: "human" | "agent"; id: string; role?: string } | null; scorecard_document_id: string | null }): { allowed: boolean; refusal: string | null; statement: { as_of: PlainDate; rule_set_version: string; scorecard_document_id: string | null; tie_outs: OutboundDqResult["totals"]; attested_by: string } | null } {
  if (i.dq.attestation_blocked) return { allowed: false, refusal: i.dq.refusal, statement: null };
  const a = i.attested_by;
  if (!a || a.kind !== "human" || a.role !== "officer") return { allowed: false, refusal: "attestation requires a Supermortgage officer (17.3 guardrail)", statement: null };
  if (!i.scorecard_document_id) return { allowed: false, refusal: "attestation needs the DQ scorecard document", statement: null };
  return { allowed: true, refusal: null, statement: { as_of: i.as_of, rule_set_version: i.dq.rule_set_version, scorecard_document_id: i.scorecard_document_id, tie_outs: i.dq.totals, attested_by: a.id } };
}
/** Guardrail: a request to change a balance so a tie-out passes is refused outright; the difference goes to the 1.6 taxonomy with evidence or to the officer. */
export function balanceEditRequest(i: { field: string; from_cents: Cents; to_cents: Cents; reason: string; evidence_document_id?: string | null }): { refused: true; refusal: string; alternative: "categorize_and_resolve_with_evidence" | "escalate_officer"; escalation: Escalation | null } {
  const ev = Boolean(i.evidence_document_id);
  return { refused: true, refusal: `the agent may not alter ${i.field} (${i.from_cents} → ${i.to_cents}) to make a tie-out pass`, alternative: ev ? "categorize_and_resolve_with_evidence" : "escalate_officer", escalation: ev ? null : { kind: "officer", severity: "sev2", reason: `unexplained tie-out difference on ${i.field}: ${i.reason}` } };
}

// ============================================================ T4 post-T receipts
export interface PostTransferReceipt { readonly loan_id: string; readonly received_on: PlainDate; readonly transfer_date: PlainDate; readonly listed: boolean; readonly channel: "lockbox" | "ach" | "web" | "branch" | "trustee" | "wire"; readonly amount_cents: Cents; }
/** Rule 17.3: a payment received on/after T for a listed loan is a misdirected payment (direction out) — never `payment.received`, never an investor event; it rides the next servicer-business-day forwarding file. */
export function postTransferReceipt(r: PostTransferReceipt): { payment_received_event: "payment.received" | null; investor_event: null; misdirected_payment: { direction: "out"; loan_id: string; received_on: PlainDate; amount_cents: Cents; channel: PostTransferReceipt["channel"]; status: "pending_forward" } | null; forwarding_file_date: PlainDate | null; gate: "SM_XFER_OUT_POST_T_EVENT_GATE"; refusal: string | null } {
  const misdirected = r.listed && r.received_on >= r.transfer_date;
  if (!misdirected) return { payment_received_event: "payment.received", investor_event: null, misdirected_payment: null, forwarding_file_date: null, gate: "SM_XFER_OUT_POST_T_EVENT_GATE", refusal: null };
  return { payment_received_event: null, investor_event: null, misdirected_payment: { direction: "out", loan_id: r.loan_id, received_on: r.received_on, amount_cents: r.amount_cents, channel: r.channel, status: "pending_forward" }, forwarding_file_date: forwardBy(r.received_on), gate: "SM_XFER_OUT_POST_T_EVENT_GATE",
    refusal: `payment.received refused: ${r.loan_id} received ${r.received_on} ≥ transfer date ${r.transfer_date} — misdirected payment forwarded on ${forwardBy(r.received_on)}; no investor event with an activity date ≥ T` };
}
/** The `misdirected_payments{direction=out}` row (0019 DDL) for a post-T receipt: received by Supermortgage, instrument from the channel, forwarded on the next servicer business day's file. */
export const INSTRUMENT_BY_CHANNEL: Readonly<Record<PostTransferReceipt["channel"], "check" | "ach" | "card" | "wire" | "cash">> = { lockbox: "check", ach: "ach", web: "ach", branch: "check", trustee: "check", wire: "wire" };
export function misdirectedPaymentRow(r: PostTransferReceipt & { payment_id: string }): { loan_id: string; direction: "out"; received_by: "supermortgage"; transferor_received_at: null; received_at: PlainDate; amount_cents: Cents; instrument: "check" | "ach" | "card" | "wire" | "cash"; forwarded_at: null; forward_reference: null; payment_id: string; protected: false; disposition: null; forwarding_file_date: PlainDate } | null {
  const p = postTransferReceipt(r); if (!p.misdirected_payment) return null;
  return { loan_id: r.loan_id, direction: "out", received_by: "supermortgage", transferor_received_at: null, received_at: r.received_on, amount_cents: r.amount_cents, instrument: INSTRUMENT_BY_CHANNEL[r.channel], forwarded_at: null, forward_reference: null, payment_id: r.payment_id, protected: false, disposition: null, forwarding_file_date: p.forwarding_file_date! };
}
/** The daily forwarding file (D32): every misdirected receipt not yet forwarded whose forwarding date is the file date. */
export function forwardingFile(fileDate: PlainDate, items: readonly { loan_id: string; received_on: PlainDate; amount_cents: Cents; forwarded_on?: PlainDate | null }[]): { file_date: PlainDate; kind: "D32"; rows: { loan_id: string; received_on: PlainDate; amount_cents: Cents }[]; total_cents: Cents } {
  const rows = items.filter((x) => !x.forwarded_on && forwardBy(x.received_on) <= fileDate).map((x) => ({ loan_id: x.loan_id, received_on: x.received_on, amount_cents: x.amount_cents }));
  return { file_date: fileDate, kind: "D32", rows, total_cents: rows.reduce((a, x) => a + x.amount_cents, 0n) };
}

// ============================================================ T5 final-period close
const ET = "America/New_York";
/** Rule 17.3 final-period reporting: events processed ≤ T−1 are due 3:00 a.m. ET the next Fannie business day (LL-2026-05); the transfer month closes BD2 17:00 ET with zero open hard rejects — an open reject on the close day escalates to `officer`. */
export function finalPeriodClose(i: { transfer_date: PlainDate; processed_at_ms: number; open_hard_rejects: number; now_ms: number }): { event_due_ms: number; event_due_et: { date: PlainDate; hour: number; minute: number }; period_close_ms: number; period_close_date: PlainDate; close_permitted: boolean; escalation: Escalation | null } {
  const eventDue = eventDeadlineMs(i.processed_at_ms); const closeMs = finalPeriodCloseMs(i.transfer_date); const closeDate = fannieBusinessDay(i.transfer_date, 2);
  const nowEt = wallClock(i.now_ms, ET); const onCloseDay = nowEt.date >= closeDate;
  const esc: Escalation | null = i.open_hard_rejects > 0 && onCloseDay ? { kind: "officer", severity: "sev1", reason: `${i.open_hard_rejects} open hard reject(s) at ${nowEt.date} ${String(nowEt.hour).padStart(2, "0")}:${String(nowEt.minute).padStart(2, "0")} ET — the final period must close ${closeDate} 17:00 ET with zero open hard rejects (FNMA_IRM_PERIOD_CLOSE_BD2_1700)` } : null;
  const d = wallClock(eventDue, ET);
  return { event_due_ms: eventDue, event_due_et: { date: d.date, hour: d.hour, minute: d.minute }, period_close_ms: closeMs, period_close_date: closeDate, close_permitted: i.open_hard_rejects === 0, escalation: esc };
}

// ============================================================ T6 final accounting and advances reimbursement
/** F-1-11: the final accounting (D31) is due T+30; unacked past that → sev 1 `officer`. */
export function finalAccountingWatch(i: { transfer_date: PlainDate; acked_on: PlainDate | null; today: PlainDate }): { due: PlainDate; breached: boolean; timer: "FNMA_F1_11_FINAL_ACCOUNTING_30"; escalation: Escalation | null } {
  const due = finalAccountingDue(i.transfer_date); const breached = !i.acked_on && i.today > due;
  return { due, breached, timer: "FNMA_F1_11_FINAL_ACCOUNTING_30", escalation: breached ? { kind: "officer", severity: "sev1", reason: `final accounting (D31) not acknowledged by ${due}` } : null };
}
/** Contract: the transferee reimburses advances within 30 days of the final accounting ack; past that the partner receives a demand-letter draft for the receivable. */
export function advanceReimbursementWatch(i: { acked_on: PlainDate; receivable_cents: Cents; reimbursed_on: PlainDate | null; today: PlainDate }): { due: PlainDate; breached: boolean; timer: "SM_ADVANCE_REIMBURSEMENT_RECEIVABLE_30"; demand_letter_draft: { to: "transferee"; via: "partner"; amount_cents: Cents; receivable_account: "due_from_transferee"; basis: string; status: "draft" } | null } {
  const due = addDays(i.acked_on, 30); const breached = !i.reimbursed_on && i.today > due;
  return { due, breached, timer: "SM_ADVANCE_REIMBURSEMENT_RECEIVABLE_30", demand_letter_draft: breached ? { to: "transferee", via: "partner", amount_cents: i.receivable_cents, receivable_account: "due_from_transferee", basis: `F-1-11 advances reimbursement due ${due} (30 days after the final accounting ack ${i.acked_on})`, status: "draft" } : null };
}

// ============================================================ T7 eNote Servicing Agent hand-off
/** F-1-11: the eRegistry Servicing Agent must be the transferee "prior to the date of the transfer" (T−1 servicer BD); still Supermortgage then → sev 1, the partner is escalated (T−5 BD warning); Supermortgage cannot remain Servicing Agent past T. */
export function enoteServicingAgentHandoff(i: { transfer_date: PlainDate; servicing_agent_org_id: string; transferee_org_id: string; checked_on: PlainDate }): { due: PlainDate; warn_from: PlainDate; updated: boolean; breached: boolean; severity: "sev1" | null; timer: "FNMA_F1_11_ENOTE_SERVICING_AGENT_T0"; escalation: Escalation | null; unauthorized_past_transfer: boolean } {
  const due = addBusinessDays(i.transfer_date, -1, servicer); const warn = addBusinessDays(i.transfer_date, -5, servicer);
  const updated = i.servicing_agent_org_id === i.transferee_org_id; const still = i.servicing_agent_org_id === SUPERMORTGAGE_ORG_ID;
  const breached = !updated && i.checked_on >= due;
  const esc: Escalation | null = !updated && i.checked_on >= warn ? { kind: "officer", to: "partner", severity: breached ? "sev1" : "sev2", reason: `eNote Servicing Agent is ${still ? "still Supermortgage" : i.servicing_agent_org_id} on ${i.checked_on}; must be the transferee (${i.transferee_org_id}) by ${due} — partner/Fannie Mae to resolve` } : null;
  return { due, warn_from: warn, updated, breached, severity: breached ? "sev1" : null, timer: "FNMA_F1_11_ENOTE_SERVICING_AGENT_T0", escalation: esc, unauthorized_past_transfer: still && i.checked_on >= i.transfer_date };
}

// ============================================================ T8 MERS MIN Update and snapshot
export type OutboundMersTransaction = ReturnType<typeof mersTransaction> | "min_update_clear_subservicer" | "tos_initiate_and_deactivate_non_mers";
/** MERS Procedures 24.2 §1.5, outbound: sub_to_sub replaces the Subservicer Org ID, sub_to_master clears it (a resigning Member must remove its Org ID), a servicing sale is a TOS (and "Transfer to Non-MERS Status" when the transferee is not a Member). custody-mers.mersTransaction has no sub_to_master branch (it was written for §1.5 inbound), so the outbound map lives here. */
export function outboundMersTransaction(type: TransferType, transfereeIsMersMember = true): OutboundMersTransaction {
  if (type === "sub_to_master") return "min_update_clear_subservicer";
  if (type === "servicing_sale" && !transfereeIsMersMember) return "tos_initiate_and_deactivate_non_mers";
  return mersTransaction(type);
}
/** MERS Procedures 24.2: for a sub_to_sub / sub_to_master batch the partner's MIN Update file replaces (or clears) Supermortgage's Org ID in the Subservicer field; a servicing sale is a TOS. */
export function minUpdateFile(i: { type: TransferType; mins: readonly { min: string; subservicer_org_id: string | null }[]; new_subservicer_org_id: string | null }): { transaction: OutboundMersTransaction; submitted_by: "partner"; rows: { min: string; subservicer_before: string | null; subservicer_after: string | null }[]; remaining_supermortgage: number } {
  const tx = outboundMersTransaction(i.type);
  const after = i.type === "sub_to_master" ? null : i.new_subservicer_org_id;
  const rows = i.mins.map((m) => ({ min: m.min, subservicer_before: m.subservicer_org_id, subservicer_after: tx === "none" ? m.subservicer_org_id : after }));
  return { transaction: tx, submitted_by: "partner", rows, remaining_supermortgage: rows.filter((r) => r.subservicer_after === SUPERMORTGAGE_ORG_ID).length };
}
/** SM_MERS_POST_TRANSFER_VERIFY_3: the T+3 servicer-BD snapshot must cover every MIN of the batch (1.5: "100% of MINs") and show none with Supermortgage in the Subservicer field — a snapshot missing MINs verifies nothing. */
export function verifyMersSnapshot(i: { transfer_date: PlainDate; snapshot_on: PlainDate; mins: readonly string[]; snapshot: readonly { min: string; subservicer_org_id: string | null }[] }): { verify_by: PlainDate; on_time: boolean; expected: number; missing_from_snapshot: string[]; remaining_with_supermortgage: string[]; ok: boolean; event: "mers.snapshot.verified" | null } {
  const verifyBy = mersClocks(i.transfer_date).verify_by; const expected = [...new Set(i.mins)];
  const seen = new Set(i.snapshot.map((r) => r.min)); const missing = expected.filter((m) => !seen.has(m));
  const remaining = i.snapshot.filter((r) => expected.includes(r.min) && r.subservicer_org_id === SUPERMORTGAGE_ORG_ID).map((r) => r.min);
  const ok = expected.length > 0 && missing.length === 0 && remaining.length === 0;
  return { verify_by: verifyBy, on_time: i.snapshot_on <= verifyBy, expected: expected.length, missing_from_snapshot: missing, remaining_with_supermortgage: remaining, ok, event: ok ? "mers.snapshot.verified" : null };
}

// ============================================================ T9 transferee requests
export type TransfereeRequestKind = "missing_document" | "data_question" | "lossmit_document" | "payment_research" | "complaint_research" | "noe_rfi_research";
/** Bulletin 2020-02 / decision 3: 5 servicer BD inside the 90-day support window, 10 BD after; a missing-document answer carries the document hash. */
export function transfereeRequest(i: { received_on: PlainDate; transfer_date: PlainDate; kind: TransfereeRequestKind; document?: { id: string; sha256: string } | null; responded_on?: PlainDate | null }): { due: PlainDate; sla_business_days: 5 | 10; within_support_window: boolean; response: { document_id: string; document_hash: string } | null; status: "open" | "responded" | "overdue"; on_time: boolean | null } {
  const windowEnd = addDays(i.transfer_date, 90); const inWindow = i.received_on <= windowEnd;
  const due = inWindow ? transfereeRequestDue(i.received_on) : addBusinessDays(i.received_on, 10, servicer);
  const doc = i.document ?? null; const responded = i.responded_on ?? null;
  return { due, sla_business_days: inWindow ? 5 : 10, within_support_window: inWindow, response: responded && doc ? { document_id: doc.id, document_hash: doc.sha256 } : null, status: responded ? "responded" : "open", on_time: responded ? responded <= due : null };
}
/** SM_XFER_OUT_TRANSFEREE_REQUEST_5BD breach action: more than 10 open requests → `officer`. */
export function transfereeRequestBacklog(open: number): Escalation | null { return open > 10 ? { kind: "officer", severity: "sev2", reason: `${open} transferee requests open (> 10)` } : null; }

// ============================================================ T10 one-year NoE/RFI tail
/** §1024.35(g)(1)(iii) / §1024.36(f)(1)(v): a notice about Supermortgage's servicing is timely through T+1 year (the 4.1/4.2 clocks run); after that it is `untimely` and the (g)(2)/(f)(2) notice goes out within 5 federal BD. */
export function postTransferNoe(i: { transfer_date: PlainDate; received_on: PlainDate; assertion_type: AssertionType }): { tail_end: PlainDate; timely: boolean; exception: "untimely" | null; deadlines: Deadlines | null; exception_notice: { template: "NTC_REGX_35G2_EXCEPTION"; citation: "§1024.35(g)(2)"; due: PlainDate } | null; gate: "REGX_1024_35G_NOE_TAIL_1Y" } {
  const tailEnd = addYears(i.transfer_date, 1); const timely = i.received_on <= tailEnd;
  return { tail_end: tailEnd, timely, exception: timely ? null : "untimely", deadlines: timely ? noeDeadlines(i.assertion_type, i.received_on) : null, exception_notice: timely ? null : { template: "NTC_REGX_35G2_EXCEPTION", citation: "§1024.35(g)(2)", due: exceptionNoticeDue(i.received_on) }, gate: "REGX_1024_35G_NOE_TAIL_1Y" };
}

// ============================================================ T11 Form 2009 hand-off
/** Document Transfers Job Aid: executed Form 2009s for open non-liquidation releases go to the transferee custodian by T; the custodian's 90-day report responsibility passes with them — only with them: an unsigned or undelivered Form 2009 leaves the 90-day report with the transferor custodian. */
export function form2009Handoff(i: { transfer_date: PlainDate; releases: readonly { loan_id: string; opened_on: PlainDate; liquidation: boolean; executed_form2009_document_id: string | null }[]; delivered_on: PlainDate | null }): { due: PlainDate; items: { loan_id: string; report_due: PlainDate; overdue_at_transfer: boolean; responsibility_after_transfer: "transferee_custodian" | "transferor_custodian"; executed: boolean }[]; delivered_by_transfer: boolean; signing_officer_required: string[]; event: "custody.form2009.handed_off" | null; recipient: "transferee_custodian" } {
  const open = i.releases.filter((r) => !r.liquidation);
  const unsigned = open.filter((r) => !r.executed_form2009_document_id).map((r) => r.loan_id);
  const delivered = i.delivered_on !== null && i.delivered_on <= i.transfer_date && unsigned.length === 0;
  const items = open.map((r) => ({ loan_id: r.loan_id, report_due: addDays(r.opened_on, 90), overdue_at_transfer: form2009Overdue(r.opened_on, i.transfer_date, r.liquidation), responsibility_after_transfer: delivered ? ("transferee_custodian" as const) : ("transferor_custodian" as const), executed: Boolean(r.executed_form2009_document_id) }));
  return { due: i.transfer_date, items, delivered_by_transfer: delivered, signing_officer_required: unsigned, event: delivered ? "custody.form2009.handed_off" : null, recipient: "transferee_custodian" };
}

// ============================================================ T12 retention and de-identification
/** retain_until = max(T + 1 year [§1024.38(c)(1)], T + 7 years [policy transfer_out_archive], any legal hold, state rule). */
export function retentionPlan(i: { transfer_date: PlainDate; legal_hold_until?: PlainDate | null; state_retention_years?: number | null }): { regx_floor: PlainDate; policy_archive_until: PlainDate; retain_until: PlainDate; retention_class: "transfer_out_archive"; legal_hold: boolean } {
  const floor = addYears(i.transfer_date, 1); const policy = addYears(i.transfer_date, 7);
  const cands = [floor, policy, ...(i.legal_hold_until ? [i.legal_hold_until] : []), ...(i.state_retention_years ? [addYears(i.transfer_date, i.state_retention_years)] : [])];
  return { regx_floor: floor, policy_archive_until: policy, retain_until: maxDate(...cands), retention_class: "transfer_out_archive", legal_hold: Boolean(i.legal_hold_until) };
}
/** After retain_until (no legal hold) PII is de-identified per 19.1; the manifest hashes and dates stay queryable indefinitely. */
export function deidentify(i: { retain_until: PlainDate; legal_hold: boolean; today: PlainDate; manifest: readonly { document_id: string; sha256: string; as_of: PlainDate }[]; pii_fields: readonly string[] }): { ran: boolean; reason: string | null; deidentified_at: PlainDate | null; pii_removed: readonly string[]; manifest: readonly { document_id: string; sha256: string; as_of: PlainDate }[]; gate: "REGX_1024_38C1_RETENTION_1Y" } {
  if (i.legal_hold) return { ran: false, reason: "legal hold blocks de-identification", deidentified_at: null, pii_removed: [], manifest: i.manifest, gate: "REGX_1024_38C1_RETENTION_1Y" };
  if (i.today <= i.retain_until) return { ran: false, reason: `retain_until ${i.retain_until} not yet passed`, deidentified_at: null, pii_removed: [], manifest: i.manifest, gate: "REGX_1024_38C1_RETENTION_1Y" };
  return { ran: true, reason: null, deidentified_at: i.today, pii_removed: i.pii_fields, manifest: i.manifest, gate: "REGX_1024_38C1_RETENTION_1Y" };
}

// ============================================================ T13 preliminary QC
/** Bulletin 2020-02: the transferee-system values must match the submitted preliminary; a mapping difference blocks `transfer.prelim_qc.completed` until a corrected preliminary is acknowledged. */
export function prelimQc(i: { load_report: { differences: readonly { field: string; loan_count: number }[] } | null; corrected_preliminary_acked: boolean }): { match: boolean; satisfiable: boolean; event: "transfer.prelim_qc.completed" | null; blocking: readonly { field: string; loan_count: number }[]; corrective_action: "send_corrected_preliminary" | "await_load_report" | null; timer: "SM_XFER_OUT_PRELIM_QC_7" } {
  if (!i.load_report) return { match: false, satisfiable: false, event: null, blocking: [], corrective_action: "await_load_report", timer: "SM_XFER_OUT_PRELIM_QC_7" };
  const diffs = i.load_report.differences.filter((d) => d.loan_count > 0);
  if (diffs.length && !i.corrected_preliminary_acked) return { match: false, satisfiable: false, event: null, blocking: diffs, corrective_action: "send_corrected_preliminary", timer: "SM_XFER_OUT_PRELIM_QC_7" };
  if (diffs.length) return { match: false, satisfiable: false, event: null, blocking: diffs, corrective_action: "await_load_report", timer: "SM_XFER_OUT_PRELIM_QC_7" };
  return { match: true, satisfiable: true, event: "transfer.prelim_qc.completed", blocking: [], corrective_action: null, timer: "SM_XFER_OUT_PRELIM_QC_7" };
}

// ============================================================ T14 CBAM LOA cancellation
/** After the last batch's final-period draft clears (and the final Form 496/496A), the CBAM LOA-cancellation `human_portal_task` is due +10 servicer BD. */
export function cbamLoaCancellation(i: { last_batch_for_partner: boolean; draft_cleared_on: PlainDate }): { due: PlainDate | null; task: { kind: "human_portal_task"; portal: "CBAM"; action: "loa_cancellation"; due: PlainDate; completion_event: "human_portal_task.completed" } | null; timer: "SM_XFER_OUT_CUSTODIAL_ACCOUNT_CLOSE" } {
  if (!i.last_batch_for_partner) return { due: null, task: null, timer: "SM_XFER_OUT_CUSTODIAL_ACCOUNT_CLOSE" };
  const due = addBusinessDays(i.draft_cleared_on, 10, servicer);
  return { due, task: { kind: "human_portal_task", portal: "CBAM", action: "loa_cancellation", due, completion_event: "human_portal_task.completed" }, timer: "SM_XFER_OUT_CUSTODIAL_ACCOUNT_CLOSE" };
}

// ============================================================ counterparty notifications
export type PartyType = "custodian_transferor" | "custodian_transferee" | "mi" | "hazard_insurer" | "flood_insurer" | "earthquake_other_insurer" | "optional_insurance" | "tax_service" | "flood_service" | "taxing_authority" | "hoa" | "leaseholder" | "lien_holder" | "utility" | "law_firm" | "bk_trustee" | "debtor_counsel" | "mers" | "eregistry" | "credit_bureau" | "eoscar" | "print_mail" | "edelivery" | "telephony" | "lockbox_bank" | "custodial_bank" | "lpi_tracker" | "preservation" | "fnma_p360" | "fnma_ir_rep";
export type NotificationKind = "transfer_notice" | "endorsement_request" | "continue_or_discontinue" | "payment_address_change" | "servicing_agent_update" | "min_update" | "deactivation" | "final_cycle" | "account_closure";
export type CounterpartyGroup = "mi" | "insurers" | "vendors" | "taxing_authorities" | "law_firms" | "bk_trustees" | "custodians" | "mers" | "credit_bureaus" | "servicing_vendors" | "fnma";
/** The timer group a party belongs to (SM_XFER_OUT_MI_NOTICE_T1 / INSURER_ENDORSEMENT_T1 / VENDOR_NOTICE_T1 / TAXING_AUTHORITY_NOTICE_T1 / LAW_FIRM_NOTICE_T1 / BK_TRUSTEE_NOTICE_T1). */
export function counterpartyGroup(p: PartyType): CounterpartyGroup {
  switch (p) {
    case "mi": return "mi";
    case "hazard_insurer": case "flood_insurer": case "earthquake_other_insurer": case "lpi_tracker": return "insurers";
    case "tax_service": case "flood_service": case "optional_insurance": case "preservation": return "vendors";
    case "taxing_authority": case "hoa": case "leaseholder": case "lien_holder": case "utility": return "taxing_authorities";
    case "law_firm": return "law_firms";
    case "bk_trustee": case "debtor_counsel": return "bk_trustees";
    case "custodian_transferor": case "custodian_transferee": return "custodians";
    case "mers": case "eregistry": return "mers";
    case "credit_bureau": case "eoscar": return "credit_bureaus";
    case "fnma_p360": case "fnma_ir_rep": return "fnma";
    default: return "servicing_vendors";
  }
}
/** The notice each party gets (F-1-11 third-party list): MI/taxing/law-firm transfer notices, carrier endorsement requests, vendor continue/discontinue, trustee payment-address changes, MERS MIN Update / eRegistry Servicing Agent, bureaus' final cycle, custodial-bank account closure. */
export function notificationKind(p: PartyType): NotificationKind {
  switch (p) {
    case "hazard_insurer": case "flood_insurer": case "earthquake_other_insurer": case "lpi_tracker": return "endorsement_request";
    case "tax_service": case "flood_service": case "optional_insurance": case "preservation": case "print_mail": case "edelivery": case "telephony": case "lockbox_bank": return "continue_or_discontinue";
    case "bk_trustee": case "debtor_counsel": return "payment_address_change";
    case "eregistry": return "servicing_agent_update";
    case "mers": return "min_update";
    case "credit_bureau": case "eoscar": return "final_cycle";
    case "custodial_bank": return "account_closure";
    default: return "transfer_notice";
  }
}
export interface CounterpartyNotification { readonly party_type: PartyType; readonly party_id: string; readonly loan_id?: string | null; readonly kind: NotificationKind; readonly group: CounterpartyGroup; readonly due_at: PlainDate; readonly sent_at?: PlainDate | null; }
/** Plan: every party due T−1 servicer BD (transferor custodian at approval; bureaus at the next cycle; custodial bank after the final draft). */
export function planCounterpartyNotifications(i: { transfer_date: PlainDate; approved_on: PlainDate; parties: readonly { party_type: PartyType; party_id: string; loan_id?: string | null }[] }): CounterpartyNotification[] {
  const tMinus1 = addBusinessDays(i.transfer_date, -1, servicer);
  return i.parties.map((p) => ({ party_type: p.party_type, party_id: p.party_id, loan_id: p.loan_id ?? null, kind: notificationKind(p.party_type), group: counterpartyGroup(p.party_type), due_at: p.party_type === "custodian_transferor" ? i.approved_on : p.party_type === "credit_bureau" || p.party_type === "custodial_bank" ? i.transfer_date : tMinus1, sent_at: null }));
}
/** Status: which groups are fully sent (→ `transfer.counterparty_notices.sent{group}`) and whether every notice due before T is sent (→ `transfer.counterparties.notified`, SM_XFER_OUT_COUNTERPARTIES_T1). */
export function counterpartyStatus(i: { transfer_date: PlainDate; notifications: readonly CounterpartyNotification[] }): { groups_complete: CounterpartyGroup[]; group_events: { type: "transfer.counterparty_notices.sent"; group: CounterpartyGroup }[]; unsent_due_before_transfer: CounterpartyNotification[]; all_due_before_transfer_sent: boolean; event: { type: "transfer.counterparties.notified"; all_due_before_transfer_sent: true } | null } {
  const groups = [...new Set(i.notifications.map((n) => n.group))];
  const complete = groups.filter((g) => i.notifications.filter((n) => n.group === g).every((n) => Boolean(n.sent_at)));
  const unsent = i.notifications.filter((n) => n.due_at < i.transfer_date && !n.sent_at);
  return { groups_complete: complete, group_events: complete.map((group) => ({ type: "transfer.counterparty_notices.sent" as const, group })), unsent_due_before_transfer: unsent, all_due_before_transfer_sent: unsent.length === 0, event: unsent.length === 0 ? { type: "transfer.counterparties.notified", all_due_before_transfer_sent: true } : null };
}
/** MGIC (Mar 12, 2026): notice within 60 days of selling servicing rights carrying certificate, borrower, selling servicer, new servicer name/address, new loan number and effective date. */
export const MI_NOTICE_FIELDS = ["certificate_number", "borrower_name", "selling_servicer", "new_servicer_name", "new_servicer_address", "new_loan_number", "effective_date", "requestor_contact"] as const;
export function miNoticeCheck(payload: Record<string, unknown>): { ok: boolean; missing: string[] } { const m = MI_NOTICE_FIELDS.filter((k) => payload[k] === undefined || payload[k] === null || payload[k] === ""); return { ok: m.length === 0, missing: [...m] }; }

// ============================================================ custodial-account disposition (SM_XFER_OUT_CUSTODIAL_CLOSE_60)
/** After the F-1-11 reconciliation ack and the T+30 window: a fully-vacated account settles to zero and closes (Forms 1013/1014 withdrawn in CBAM — `human_portal_task`); an account retaining loans stays open with a post-transfer reconciliation certificate. */
export function custodialAccountDisposition(i: { account_id: string; recon_acked_on: PlainDate; adjustment_window_closed: boolean; open_variance: boolean; population_fully_transferred: boolean; balance_cents: Cents; forms_1013_1014_withdrawn: boolean; bank_closure_letter_document_id: string | null; recon_certificate_document_id: string | null }): { due: PlainDate; armed: boolean; outcome: "closed" | "recon_certificate_filed" | null; remaining_steps: string[]; portal_task: { kind: "human_portal_task"; portal: "CBAM"; action: "withdraw_forms_1013_1014"; countersignature: "partner" } | null; event: { type: "transfer.custodial_account.disposed"; outcome: "closed" | "recon_certificate_filed"; account_id: string } | null } {
  const due = addDays(i.recon_acked_on, 60); const armed = i.adjustment_window_closed && !i.open_variance;
  if (i.population_fully_transferred) {
    const steps: string[] = []; if (i.balance_cents !== 0n) steps.push(`settle balance ${i.balance_cents} to zero`); if (!i.forms_1013_1014_withdrawn) steps.push("withdraw Forms 1013/1014 in CBAM (partner countersignature)"); if (!i.bank_closure_letter_document_id) steps.push("close depository account and file the bank closure letter");
    const done = steps.length === 0;
    return { due, armed, outcome: done ? "closed" : null, remaining_steps: steps, portal_task: i.forms_1013_1014_withdrawn ? null : { kind: "human_portal_task", portal: "CBAM", action: "withdraw_forms_1013_1014", countersignature: "partner" }, event: done ? { type: "transfer.custodial_account.disposed", outcome: "closed", account_id: i.account_id } : null };
  }
  const done = Boolean(i.recon_certificate_document_id);
  return { due, armed, outcome: done ? "recon_certificate_filed" : null, remaining_steps: done ? [] : ["remove the transferred loans' balances and file the post-transfer reconciliation certificate"], portal_task: null, event: done ? { type: "transfer.custodial_account.disposed", outcome: "recon_certificate_filed", account_id: i.account_id } : null };
}

// ============================================================ funds: ledger at freeze (worked example)
/** Fannie Mae's Stop Delinquency Advance policy (15.4; the 17.3 worked example "scheduled P&I advanced to Fannie Mae under Stop Delinquency Advance rules for 3 months"): on a scheduled/scheduled loan Supermortgage advances the scheduled P&I for each delinquent installment through the fourth consecutive month, after which advances stop — the receivable billed to the transferee is `months advanced × scheduled P&I` (3 × 161,603 = 484,809). */
export const STOP_DELINQUENCY_ADVANCE_MONTHS = 4;
export function piAdvancesReceivable(i: { scheduled_pi_cents: Cents; installments_delinquent: number }): { months_advanced: number; receivable_cents: Cents; advances_stopped: boolean } {
  if (!Number.isInteger(i.installments_delinquent) || i.installments_delinquent < 0) throw new RangeError("installments_delinquent is a whole number of installments");
  if (i.scheduled_pi_cents <= 0n) throw new RangeError("scheduled_pi_cents must be positive");
  const months = Math.min(i.installments_delinquent, STOP_DELINQUENCY_ADVANCE_MONTHS);
  return { months_advanced: months, receivable_cents: BigInt(months) * i.scheduled_pi_cents, advances_stopped: i.installments_delinquent >= STOP_DELINQUENCY_ADVANCE_MONTHS };
}
export interface LedgerLine { readonly account: string; readonly side: "Dr" | "Cr"; readonly amount_cents: Cents; readonly rule_ref: string; }
export interface EntrySet { readonly description: string; readonly lines: readonly LedgerLine[]; readonly balanced: boolean; }
const set = (description: string, lines: readonly Omit<LedgerLine, "rule_ref">[], rule_ref: string): EntrySet => { const dr = lines.filter((l) => l.side === "Dr").reduce((a, l) => a + l.amount_cents, 0n), cr = lines.filter((l) => l.side === "Cr").reduce((a, l) => a + l.amount_cents, 0n); return { description, lines: lines.map((l) => ({ ...l, rule_ref })), balanced: dr === cr }; };
/** F-1-11 funds: the T&I wire (escrow incl. interest through T−1), the forwardable P&I wire (unapplied + prepaid next-period P&I) and the advances receivable posted on the final-accounting ack. */
export function ledgerAtFreeze(loans: readonly LoanBalances[]): { wires: ReturnType<typeof expectedWires>; ti_wire: EntrySet; pi_wire: EntrySet; advances_on_ack: EntrySet; reimbursement: EntrySet } {
  const w = expectedWires(loans, true);
  const unapplied = loans.reduce((a, l) => a + l.unapplied_cents, 0n); const prepaid = loans.reduce((a, l) => a + (l.prepaid_next_period_pi_cents ?? 0n) + (l.unremitted_pi_cents ?? 0n), 0n);
  return { wires: w,
    ti_wire: set("T&I custodial balance wired to the transferee", [{ account: "escrow", side: "Dr", amount_cents: w.ti_wire_cents }, { account: "custodial_ti_cash", side: "Cr", amount_cents: w.ti_wire_cents }], "17.3 funds: F-1-11 T&I"),
    pi_wire: set("forwardable P&I wired to the transferee", [{ account: "suspense_unapplied", side: "Dr", amount_cents: unapplied }, { account: "fnma_remittance_payable_next_period", side: "Dr", amount_cents: prepaid }, { account: "custodial_pi_cash", side: "Cr", amount_cents: w.pi_wire_cents }], "17.3 funds: F-1-11 P&I forwardable"),
    advances_on_ack: set("advances receivable recognized on the final-accounting ack", [{ account: "due_from_transferee", side: "Dr", amount_cents: w.final_accounting_receivable_cents }, { account: "servicer_advance_receivable", side: "Cr", amount_cents: w.pi_advances_receivable_cents }, { account: "escrow_advances", side: "Cr", amount_cents: w.escrow_advances_receivable_cents }, { account: "corporate_advances", side: "Cr", amount_cents: w.corporate_advances_receivable_cents }], "17.3 funds: F-1-11 advances reimbursement"),
    reimbursement: set("transferee reimbursement received", [{ account: "custodial_pi_cash", side: "Dr", amount_cents: w.final_accounting_receivable_cents }, { account: "due_from_transferee", side: "Cr", amount_cents: w.final_accounting_receivable_cents }], "17.3 funds: advance_reimbursement_in") };
}
/** The same sets on the kernel ledger (src/kernel/ledger accounts): per-loan `escrow` / `suspense_unapplied` (loan scope), the prepaid next-period P&I on the corporate `fnma_payable` (the spec's `fnma_remittance_payable`), the custodial P&I / T&I cash accounts (custodial scope). Zero lines are dropped; a wire with nothing to move posts nothing. */
export interface WireLoan extends LoanBalances { readonly loan_id: string; }
export function wireLedgerSets(i: { loans: readonly WireLoan[]; pi_custodial_account_id: string; ti_custodial_account_id: string; effective_date: PlainDate; batch_id: string }): { ti: EntrySetInput | null; pi: EntrySetInput | null; ti_wire_cents: Cents; pi_wire_cents: Cents } {
  const rule = (k: string): string => `17.3 funds: F-1-11 ${k}`;
  const ti: LineInput[] = [], pi: LineInput[] = []; let tiTotal = 0n, piTotal = 0n, prepaid = 0n;
  for (const l of i.loans) {
    const w = expectedWires([l], true);
    if (w.ti_wire_cents > 0n) { ti.push({ account: { scope: "loan", loanId: l.loan_id, account: "escrow" }, amountCents: w.ti_wire_cents, ruleRef: rule("T&I"), memo: "escrow balance incl. interest through T−1 wired to the transferee" }); tiTotal += w.ti_wire_cents; }
    if (l.unapplied_cents > 0n) { pi.push({ account: { scope: "loan", loanId: l.loan_id, account: "suspense_unapplied" }, amountCents: l.unapplied_cents, ruleRef: rule("P&I forwardable"), memo: "unapplied funds forwarded" }); piTotal += l.unapplied_cents; }
    const p = (l.prepaid_next_period_pi_cents ?? 0n) + (l.unremitted_pi_cents ?? 0n); prepaid += p; piTotal += p;
  }
  if (prepaid > 0n) pi.push({ account: { scope: "corporate", account: "fnma_payable" }, amountCents: prepaid, ruleRef: rule("P&I forwardable"), memo: "fnma_remittance_payable: next-period P&I belonging to the transferee's period" });
  if (tiTotal > 0n) ti.push({ account: { scope: "custodial", custodialAccountId: i.ti_custodial_account_id, account: "custodial_ti_cash" }, amountCents: -tiTotal, ruleRef: rule("T&I"), memo: "T&I wire to the transferee" });
  if (piTotal > 0n) pi.push({ account: { scope: "custodial", custodialAccountId: i.pi_custodial_account_id, account: "custodial_pi_cash" }, amountCents: -piTotal, ruleRef: rule("P&I forwardable"), memo: "P&I forwardable wire to the transferee" });
  return { ti: tiTotal > 0n ? { effectiveDate: i.effective_date, description: `T&I custodial balances wired to the transferee (batch ${i.batch_id})`, lines: ti } : null, pi: piTotal > 0n ? { effectiveDate: i.effective_date, description: `forwardable P&I wired to the transferee (batch ${i.batch_id})`, lines: pi } : null, ti_wire_cents: tiTotal, pi_wire_cents: piTotal };
}
/** On the final-accounting ack: the escrow and corporate advances on the loans become the receivable from the transferee (corporate `advance_receivable`, the spec's `due_from_transferee`); the P&I advanced to Fannie Mae already sits in `advance_receivable` (15.4 Stop Delinquency Advance postings), so it is claimed, not reclassified. */
export function advancesOnAckLedgerSet(i: { loans: readonly WireLoan[]; effective_date: PlainDate; batch_id: string }): { set: EntrySetInput | null; reclassified_cents: Cents; pi_advances_claimed_cents: Cents; due_from_transferee_cents: Cents } {
  const rule = "17.3 funds: F-1-11 advances reimbursement"; const lines: LineInput[] = []; let reclass = 0n;
  for (const l of i.loans) {
    if (l.escrow_cents < 0n) { lines.push({ account: { scope: "loan", loanId: l.loan_id, account: "escrow_advance" }, amountCents: l.escrow_cents, ruleRef: rule, memo: "escrow advance billed to the transferee" }); reclass += -l.escrow_cents; }
    if (l.corporate_advances_cents > 0n) { lines.push({ account: { scope: "loan", loanId: l.loan_id, account: "corporate_advance" }, amountCents: -l.corporate_advances_cents, ruleRef: rule, memo: "corporate advances billed to the transferee (recoverable from the borrower per the note)" }); reclass += l.corporate_advances_cents; }
  }
  if (reclass > 0n) lines.unshift({ account: { scope: "corporate", account: "advance_receivable" }, amountCents: reclass, ruleRef: rule, memo: "due_from_transferee" });
  const w = expectedWires(i.loans, true);
  return { set: reclass > 0n ? { effectiveDate: i.effective_date, description: `advances receivable from the transferee recognized on the final-accounting ack (batch ${i.batch_id})`, lines } : null, reclassified_cents: reclass, pi_advances_claimed_cents: w.pi_advances_receivable_cents, due_from_transferee_cents: w.final_accounting_receivable_cents };
}

// ============================================================ support window / archive / debrief
/** Decision 3: forwarding daily and 5-BD requests through T+90 (Mar 1, 2027 in the example); after the window forward on receipt and answer within 10 BD. */
export function supportWindow(i: { transfer_date: PlainDate; today: PlainDate }): { window_end: PlainDate; open: boolean; forwarding: "daily" | "on_receipt"; request_sla_business_days: 5 | 10; event: "transfer.support_window.expired" | null } {
  const end = addDays(i.transfer_date, 90); const open = i.today <= end;
  return { window_end: end, open, forwarding: open ? "daily" : "on_receipt", request_sla_business_days: open ? 5 : 10, event: open ? null : "transfer.support_window.expired" };
}
/** SM_XFER_OUT_ARCHIVE_MANIFEST_10: every listed loan needs a `transfer_out_archives` row (manifest of every document hash) within 10 servicer BD of the D31 ack. */
export function archiveManifestStatus(i: { d31_acked_on: PlainDate; listed_loans: readonly string[]; archives: readonly { loan_id: string; archive_manifest_document_id: string | null }[] }): { due: PlainDate; missing: string[]; complete: boolean; event: { type: "transfer.archive.written"; all_loans: true } | null } {
  const have = new Set(i.archives.filter((a) => a.archive_manifest_document_id).map((a) => a.loan_id)); const missing = i.listed_loans.filter((l) => !have.has(l));
  return { due: addBusinessDays(i.d31_acked_on, 10, servicer), missing, complete: missing.length === 0, event: missing.length === 0 ? { type: "transfer.archive.written", all_loans: true } : null };
}
/** Bulletin 2020-02 post-transfer de-brief (T+30): deliverable timeliness, exceptions, transferee requests, misdirected payments, counterparty acks. */
export function buildDebrief(i: { transfer_date: PlainDate; deliverables: readonly { kind: DeliverableKind; due: PlainDate; acked_at: PlainDate | null; status: DeliverableStatus }[]; transferee_requests: readonly { due: PlainDate; responded_on: PlainDate | null }[]; misdirected_count: number; counterparty_notifications: readonly CounterpartyNotification[] }): { due: PlainDate; late_deliverables: DeliverableKind[]; open_exceptions: DeliverableKind[]; late_requests: number; misdirected_payments: number; unacked_counterparties: number; event: "transfer.debrief.completed" } {
  return { due: addDays(i.transfer_date, 30), late_deliverables: i.deliverables.filter((d) => !d.acked_at || d.acked_at > d.due).map((d) => d.kind), open_exceptions: i.deliverables.filter((d) => d.status === "exception").map((d) => d.kind), late_requests: i.transferee_requests.filter((r) => !r.responded_on || r.responded_on > r.due).length, misdirected_payments: i.misdirected_count, unacked_counterparties: i.counterparty_notifications.filter((n) => !n.sent_at).length, event: "transfer.debrief.completed" };
}

// ============================================================ acknowledgment conditions (F-1-11 rows; the ingestTransfereeAck tool)
export interface AckInput { readonly kind: DeliverableKind; readonly stored: { readonly status?: unknown; readonly as_of?: unknown } | null; readonly as_of: PlainDate | null; readonly transfer_date: PlainDate | null; readonly load_report: unknown; readonly index_count: number | null; readonly document_count: number | null; readonly custodial_accounts: readonly string[]; readonly accounts_acked: readonly string[]; }
/** Rule 17.3 per-deliverable ack: only a `delivered` deliverable can be acknowledged (planned → generated → validated → attested → delivered → acked); D04 carries `as_of = T−1` — the transfer date's eve, not merely the date the file was generated as of (FNMA_F1_11_TRIAL_BALANCE_T1); D02 comes with the transferee load report (SM_XFER_OUT_PRELIM_TAPE_14); D28's index reconciles to the document count (SM_XFER_OUT_IMAGES_5); D08 covers every Supermortgage custodial account holding funds for the population (FNMA_F1_11_CUSTODIAL_RECON_5BD). */
export function ackConditions(i: AckInput): { ok: boolean; refusal: string | null; every_account: boolean | null; ladder_violation: boolean } {
  const from = (typeof i.stored?.status === "string" ? (i.stored.status as DeliverableStatus) : "planned");
  if (!DELIVERABLE_NEXT[from]?.includes("acked")) return { ok: false, refusal: `deliverable ${i.kind} is ${from}; only a delivered deliverable can be acknowledged (planned → generated → validated → attested → delivered → acked)`, every_account: null, ladder_violation: true };
  const storedAsOf = typeof i.stored?.as_of === "string" ? i.stored.as_of : null;
  const tMinus1 = i.transfer_date ? addDays(i.transfer_date, -1) : storedAsOf;
  if (i.kind === "D04" && (!i.as_of || !tMinus1 || i.as_of !== tMinus1 || (storedAsOf !== null && i.as_of !== storedAsOf))) return { ok: false, refusal: `D04 trial balance ack must carry as_of = transfer_date − 1 (${tMinus1 ?? "unplanned"}${storedAsOf && storedAsOf !== tMinus1 ? `; generated as of ${storedAsOf}` : ""}); got ${i.as_of ?? "none"} (F-1-11: trial balances as of close of business the day before transfer)`, every_account: null, ladder_violation: false };
  if (i.kind === "D02" && !i.load_report) return { ok: false, refusal: "D02 preliminary ack comes with the transferee load report (SM_XFER_OUT_PRELIM_TAPE_14; Bulletin 2020-02 preliminary QC)", every_account: null, ladder_violation: false };
  if (i.kind === "D28" && (i.index_count === null || i.document_count === null || i.index_count !== i.document_count)) return { ok: false, refusal: `D28 image index (${i.index_count ?? "?"} rows) must reconcile to the document count (${i.document_count ?? "?"})`, every_account: null, ladder_violation: false };
  if (i.kind === "D08") {
    const missing = i.custodial_accounts.filter((a) => !i.accounts_acked.includes(a));
    if (i.custodial_accounts.length === 0 || missing.length) return { ok: false, refusal: `D08 custodial reconciliation ack must cover every Supermortgage custodial account holding funds for the transferred population (A2-1-07); missing ${missing.join(", ") || "the account list"}`, every_account: false, ladder_violation: false };
    return { ok: true, refusal: null, every_account: true, ladder_violation: false };
  }
  return { ok: true, refusal: null, every_account: null, ladder_violation: false };
}
/** SM_XFER_OUT_FINAL_TAPE_1 is satisfied by `deliverable.acked{D03,D05,D06}` — one batch-level event once the final tape, the life-of-loan payment histories and the escrow histories are all acknowledged. */
export function finalTapeSetAcked(acked: readonly DeliverableKind[]): { complete: boolean; missing: DeliverableKind[]; event: { type: "deliverable.acked"; D03: true; D05: true; D06: true; group: "final_tape" } | null } {
  const missing = (["D03", "D05", "D06"] as const).filter((k) => !acked.includes(k));
  return { complete: missing.length === 0, missing, event: missing.length === 0 ? { type: "deliverable.acked", D03: true, D05: true, D06: true, group: "final_tape" } : null };
}
/** The delivery ladder for sendDeliverable: an `attested` deliverable is delivered; a `delivered` one may be re-sent (unacknowledged after 2 business days); `resolved` (after an exception) must be regenerated, validated and attested again. */
export function deliveryAllowed(from: DeliverableStatus, resend: boolean): { allowed: boolean; refusal: string | null } {
  if (from === "attested") return { allowed: true, refusal: null };
  if (from === "delivered" && resend) return { allowed: true, refusal: null };
  if (from === "delivered") return { allowed: false, refusal: "deliverable is already delivered; pass resend=true to re-send an unacknowledged deliverable (2 business days)" };
  return { allowed: false, refusal: `deliverable is ${from}; only an attested deliverable can be delivered${from === "resolved" ? " (a resolved exception is regenerated, validated and attested first)" : ""}` };
}

// ============================================================ cutover freeze (SM_XFER_OUT_CUTOVER_FREEZE_T1 / SM_XFER_OUT_POST_T_EVENT_GATE)
/** Rule 17.3: the ledgers freeze at COB `transfer_date − 1` after the last posting batch — not before, and only when no posting for a listed loan is dated ≥ T; `payment_holds{transfer_out_cutover}` go on every loan and `transfer.cutover.frozen` starts the final-tape / wire / image clocks. */
export function cutoverFreeze(i: { transfer_date: PlainDate; frozen_on: PlainDate; loans: readonly string[]; postings: readonly { loan_id: string; effective_date: PlainDate }[]; last_posting_batch_closed: boolean }): { freeze_at: PlainDate; allowed: boolean; refusal: string | null; holds: { loan_id: string; hold: "transfer_out_cutover" }[]; postings_on_or_after_transfer: string[]; event: { type: "transfer.cutover.frozen"; transfer_date: PlainDate; holds: number } | null } {
  const freezeAt = addDays(i.transfer_date, -1);
  const late = i.postings.filter((p) => i.loans.includes(p.loan_id) && p.effective_date >= i.transfer_date).map((p) => p.loan_id);
  let refusal: string | null = null;
  if (i.frozen_on < freezeAt) refusal = `cutover freeze not before COB ${freezeAt} (transfer_date − 1); requested ${i.frozen_on}`;
  else if (!i.last_posting_batch_closed) refusal = "cutover freeze runs after the last posting batch of the day has closed";
  else if (late.length) refusal = `${late.length} posting(s) dated ≥ ${i.transfer_date} on listed loans (${[...new Set(late)].join(", ")}) — misdirected activity goes to the forwarding file, never onto the loan`;
  else if (i.loans.length === 0) refusal = "no listed loans to freeze";
  const holds = refusal ? [] : i.loans.map((loan_id) => ({ loan_id, hold: "transfer_out_cutover" as const }));
  return { freeze_at: freezeAt, allowed: refusal === null, refusal, holds, postings_on_or_after_transfer: [...new Set(late)], event: refusal === null ? { type: "transfer.cutover.frozen", transfer_date: i.transfer_date, holds: holds.length } : null };
}

// ============================================================ wires (SM_XFER_OUT_FUNDS_WIRE_1) — matched to the trial-balance totals, never adjusted
export type WireKind = "ti" | "pi" | "other";
/** Rule 17.3: the T&I and forwardable P&I wires (T+1 BD) are matched to the trial-balance totals; a difference is a variance for the `officer` (1.6 taxonomy in reverse) — Supermortgage's trial balance and bank evidence control; no balance is altered. */
export function matchWires(i: { loans: readonly LoanBalances[]; confirmations: readonly { kind: WireKind; amount_cents: Cents; reference: string }[] }): { expected: { ti_cents: Cents; pi_cents: Cents }; received: { ti_cents: Cents; pi_cents: Cents; other_cents: Cents }; variances: { kind: WireKind; expected_cents: Cents; received_cents: Cents; variance_cents: Cents }[]; matched: boolean; event: "recon.transfer_out_wires.matched" | null; escalation: Escalation | null } {
  const w = expectedWires(i.loans, true);
  const sum = (k: WireKind): Cents => i.confirmations.filter((c) => c.kind === k).reduce((a, c) => a + c.amount_cents, 0n);
  const received = { ti_cents: sum("ti"), pi_cents: sum("pi"), other_cents: sum("other") };
  const variances = ([["ti", w.ti_wire_cents, received.ti_cents], ["pi", w.pi_wire_cents, received.pi_cents]] as const).filter(([, e, r]) => e !== r).map(([kind, e, r]) => ({ kind, expected_cents: e, received_cents: r, variance_cents: r - e }));
  const matched = variances.length === 0 && i.confirmations.length > 0;
  return { expected: { ti_cents: w.ti_wire_cents, pi_cents: w.pi_wire_cents }, received, variances, matched, event: matched ? "recon.transfer_out_wires.matched" : null,
    escalation: variances.length ? { kind: "officer", severity: "sev1", reason: `wire variance(s) ${variances.map((v) => `${v.kind} ${v.variance_cents}`).join(", ")} against the trial-balance totals — resolve with bank evidence; no balance edit` } : null };
}

// ============================================================ shortage/surplus (FNMA_F1_11_SHORTAGE_SURPLUS_ADJ_30)
/** F-1-11: unresolved shortage/surplus items → the partner `officer`'s adjustment request to the Fannie Mae IR representative by T+30 (`fnma.shortage_surplus_adjustment.requested`); zero unresolved → the `officer`-signed reconciliation (`recon.final_period.no_adjustment`). Either closes the timer (`recon.shortage_surplus.resolved{outcome}`); unresolved shortages otherwise shift to the transferee. */
export function shortageSurplusResolution(i: { transfer_date: PlainDate; unresolved_cents: Cents; adjustment_request_document_id: string | null; signed_by: { kind: "human" | "agent"; id: string; role?: string } | null }): { due: PlainDate; outcome: "adjustment_requested" | "no_adjustment" | null; refusal: string | null; events: readonly string[]; requires: "partner_officer" | "officer"; transferee_liability_exposure: boolean } {
  const due = addDays(i.transfer_date, 30); const signed = i.signed_by?.kind === "human" && (i.signed_by.role === "officer" || i.signed_by.role === "fnma_portal_operator");
  if (i.unresolved_cents !== 0n) {
    if (!i.adjustment_request_document_id) return { due, outcome: null, refusal: `unresolved shortage/surplus ${i.unresolved_cents} cents: the adjustment request to the Investor Reporting Representative (partner officer e-mail with support) is required by ${due}`, events: [], requires: "partner_officer", transferee_liability_exposure: true };
    if (!signed) return { due, outcome: null, refusal: "the adjustment request is a partner officer / fnma_portal_operator act", events: [], requires: "partner_officer", transferee_liability_exposure: true };
    return { due, outcome: "adjustment_requested", refusal: null, events: ["fnma.shortage_surplus_adjustment.requested", "recon.shortage_surplus.resolved"], requires: "partner_officer", transferee_liability_exposure: false };
  }
  if (!signed) return { due, outcome: null, refusal: "the officer signs the reconciliation showing zero unresolved items", events: [], requires: "officer", transferee_liability_exposure: false };
  return { due, outcome: "no_adjustment", refusal: null, events: ["recon.final_period.no_adjustment", "recon.shortage_surplus.resolved"], requires: "officer", transferee_liability_exposure: false };
}

// ============================================================ custodial adjustment window (SM_XFER_OUT_CUSTODIAL_CLOSE_60 trigger)
/** The +60-day close clock starts when FNMA_F1_11_CUSTODIAL_RECON_5BD is satisfied for every account **and** the T+30 adjustment window has closed with no open variance; the event carries the (latest) reconciliation ack date as its anchor. */
export function custodialAdjustmentWindow(i: { transfer_date: PlainDate; today: PlainDate; custodial_accounts: readonly string[]; recon_acks: readonly { account_id: string; acked_on: PlainDate }[]; open_variance: boolean }): { window_closes_on: PlainDate; window_closed: boolean; all_accounts_acked: boolean; missing: string[]; recon_acked_on: PlainDate | null; event: { type: "transfer.custodial_recon.acked"; adjustment_window_closed: true; open_variance: false; recon_acked_on: PlainDate } | null; blocker: string | null } {
  const closes = addDays(i.transfer_date, 30); const closed = i.today > closes;
  const acked = new Set(i.recon_acks.map((a) => a.account_id)); const missing = i.custodial_accounts.filter((a) => !acked.has(a));
  const all = i.custodial_accounts.length > 0 && missing.length === 0;
  const last = i.recon_acks.length ? i.recon_acks.map((a) => a.acked_on).reduce((a, b) => (a > b ? a : b)) : null;
  const blocker = !all ? `custodial reconciliation not acked for ${missing.join(", ") || "any account"}` : !closed ? `T+30 adjustment window open until ${closes}` : i.open_variance ? "open variance on the final period" : null;
  return { window_closes_on: closes, window_closed: closed, all_accounts_acked: all, missing, recon_acked_on: last, event: blocker === null && last ? { type: "transfer.custodial_recon.acked", adjustment_window_closed: true, open_variance: false, recon_acked_on: last } : null, blocker };
}

// ============================================================ participation notes (FNMA_F1_11_PARTICIPATION_NOTES_30, the 1.4 code armed from the outbound cutover)
/** F-1-11 / 1.4: notes for participation-pool loans held by the transferor reach the transferee custodian within 30 days of `transfer_date`. The registry row is 1.4's loan-level `loan.boarded{…}` trigger; a transfer-out batch never boards, so 17.3 arms the same code on its cutover fact when the batch carries a participation pool. */
export function participationNotesHandoff(i: { transfer_date: PlainDate; participation_pool: number }): { applies: boolean; due: PlainDate; timer: "FNMA_F1_11_PARTICIPATION_NOTES_30"; recipient: "transferee_custodian"; event: { type: "transfer.participation_notes.pending"; transfer_date: PlainDate; participation_pool: number } | null } {
  const applies = i.participation_pool > 0;
  return { applies, due: addDays(i.transfer_date, 30), timer: "FNMA_F1_11_PARTICIPATION_NOTES_30", recipient: "transferee_custodian", event: applies ? { type: "transfer.participation_notes.pending", transfer_date: i.transfer_date, participation_pool: i.participation_pool } : null };
}

// ============================================================ credit bureaus (SM_XFER_OUT_CREDIT_FINAL_CYCLE) and MERS acknowledgments
/** Rule 17.3 counterparty content, bureaus: the final Metro 2 cycle reports status 05 with date closed = T (8.1); the notice to a bureau is that cycle's file, its ack the bureau's acceptance. */
export function finalCycleNoticeCheck(payload: Record<string, unknown>, transferDate: PlainDate): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (String(payload.account_status ?? "") !== "05") problems.push(`account_status must be 05 (transferred); got ${String(payload.account_status ?? "none")}`);
  if (String(payload.date_closed ?? "") !== transferDate) problems.push(`date_closed must equal the transfer date ${transferDate}; got ${String(payload.date_closed ?? "none")}`);
  return { ok: problems.length === 0, problems };
}
/** The partner's acknowledgment rows (1.5 vocabulary, outbound): sub_to_sub / sub_to_master are Subservicer MIN Updates (replace / clear); a servicing sale is the partner's TOS initiation; a custodian-only move has no MERS transaction. */
export function outboundMersAckRows(i: { type: TransferType; transfer_date: PlainDate; partner_org_id: string; mins: readonly { min: string; loan_id?: string | null }[] }): { txn_type: MersTxnType | null; rows: MersTxnRow[]; tos: boolean } {
  const tx = outboundMersTransaction(i.type);
  const txn_type: MersTxnType | null = tx === "min_update_subservicer" || tx === "min_update_replace_subservicer" || tx === "min_update_clear_subservicer" ? "min_update_subservicer" : tx === "tos_seller_initiated" || tx === "tos_initiate_and_deactivate_non_mers" ? "tos_initiate" : null;
  const rows: MersTxnRow[] = txn_type ? i.mins.map((m) => ({ min: m.min, loan_id: m.loan_id ?? null, txn_type, effective_date: i.transfer_date, submitted_by_org_id: i.partner_org_id, status: "prepared" as const })) : [];
  return { txn_type, rows, tos: txn_type === "tos_initiate" };
}
/** F-1-11 eMortgage hand-off is complete only with the Servicing Agent update **and** the eDelivery copies and audit trails acknowledged by the transferee (all "prior to the date of the transfer"). */
export function enoteHandoffEvidence(i: { updated: boolean; edelivery_copies_acked: boolean; audit_trails_acked: boolean }): { complete: boolean; missing: string[] } {
  const missing = [...(i.updated ? [] : ["servicing_agent_update"]), ...(i.edelivery_copies_acked ? [] : ["edelivery_copies"]), ...(i.audit_trails_acked ? [] : ["audit_trails"])];
  return { complete: missing.length === 0, missing };
}
