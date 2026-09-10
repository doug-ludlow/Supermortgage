/**
 * §17.4 operating rules over the §1.7/§17.4 calculators (lossmit-inflight.ts):
 * the open-case inventory and "pending" rule, the TO-01..TO-15 handoff checks,
 * the exported deadline table, the pre-T work-down window, post-transfer
 * forwarding ("promptly" = 1 servicer BD; same day near a deadline), the
 * foreclosure hold instruction and TO-11 gate export, retained NoE/RFI/complaint
 * ownership, trial payments straddling T (F-1-27), determinations proposed to
 * beat T (lossmit_reviewer record; never issued unreviewed), the bankruptcy
 * handoff (3002.1/POC/MFR items, trustee/counsel notices) and the SMDU
 * continuity check. Every function is pure; dates are PlainDate, money is cents.
 */
import { type PlainDate, addDays, addMonths, daysBetween, endOfMonth } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, federal } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { transfereeAckDue, transfereeEvaluationDue, transfereeAppealDue, transferorClocks, honorTransferorOffer, forbearanceCarryover, transferorContinuesGate } from "./lossmit-inflight.ts";
import { tierAtReceipt } from "../foreclosure/gates.ts";
import { deadlines as noeDeadlines, type AssertionType } from "../servicing-requests/noe.ts";
import { itemDeadlines as rfiDeadlines } from "../servicing-requests/rfi.ts";
import { trialMonthMet } from "../lossmit/flexmod.ts";
import { paymentChangeDeadline } from "../bankruptcy/notices.ts";

export type CaseType = "lossmit" | "appeal" | "forbearance" | "deferral" | "modification" | "shortsale" | "dil" | "foreclosure" | "bankruptcy" | "insurance_claim" | "mi_claim" | "fpi" | "pmi_cancel" | "payoff" | "noe" | "rfi" | "complaint" | "sii" | "scra" | "fraud" | "qc_finding";
export type HandoffStatus = "inventoried" | "pre_transfer_active" | "snapshot" | "packaged" | "delivered" | "acked" | "closed_transferred" | "deficient" | "resolved" | "retained";
export type OwnerAfterTransfer = "transferee" | "supermortgage";
export type ForwardKind = "lossmit_document" | "appeal" | "acceptance" | "rejection" | "correspondence" | "counsel_notice" | "trustee_payment" | "insurer_check" | "other";
export type CheckResult = "pass" | "fail" | "n_a";
export type DeterminationOutcome = "denial" | "offer" | "appeal_denied" | "appeal_granted";
/** Adverse determinations: the ones that need a `lossmit_reviewer` record before T (Colorado AI Act; LL-2026-04; §1024.41(h)(3) separation). */
export const ADVERSE_OUTCOMES: readonly DeterminationOutcome[] = ["denial", "appeal_denied"];
export interface Escalation { readonly kind: "officer" | "attorney" | "lossmit_reviewer" | "fnma_portal_operator" | "human_agent" | "licensed_specialist"; readonly severity?: "sev1" | "sev2"; readonly reason: string; }
export interface DeadlineRow { readonly code: string; readonly anchor: PlainDate; readonly due_at: PlainDate; readonly status: "open" | "satisfied" | "exported"; readonly owner_after_transfer: OwnerAfterTransfer; }
export interface HandoffCheck { readonly check_code: string; readonly result: CheckResult; readonly note: string; }

/** The `lossmit_handoff_checks.check_code` catalogue — mirror of 1.7 `lossmit_carryover_checks`. */
export const HANDOFF_CHECK_CODES: readonly string[] = ["TO-01", "TO-02", "TO-03", "TO-04", "TO-05", "TO-06", "TO-07", "TO-08", "TO-09", "TO-10", "TO-11", "TO-12", "TO-13", "TO-14", "TO-15"];
/** Case types Supermortgage keeps after T (owner stays Supermortgage; the transferee gets a copy). */
export const RETAINED_CASE_TYPES: readonly CaseType[] = ["noe", "rfi", "complaint"];
/** §1024.41(h) appeal window used for the "denial with an expired appeal window is not pending" rule. */
const APPEAL_WINDOW_DAYS = 14;

const dayBefore = (T: PlainDate, n = 1): PlainDate => addBusinessDays(T, -n, servicer);

// ============================================================ inventory
/** Inventory rule: in scope if open at attestation or opened afterwards for a listed loan; a loss-mit case is "pending" (comment 41(k)(1)(i)-1) if subject to §1024.41 and not fully resolved — a denial with an expired appeal window is not pending but its history is still delivered. */
export function inventoryScope(i: { listed: boolean; case_type: CaseType; opened_on: PlainDate; closed_on?: PlainDate | null; attested_on: PlainDate; subject_to_1024_41?: boolean; denial_sent_on?: PlainDate | null; appeal_received_on?: PlainDate | null; today: PlainDate }): { in_scope: boolean; pending: boolean; history_delivered: boolean; handoff_status: HandoffStatus | null; owner_after_transfer: OwnerAfterTransfer | null } {
  const closed = i.closed_on ?? null;
  const openAtAttestation = i.opened_on <= i.attested_on && (!closed || closed >= i.attested_on);
  const openedAfter = i.opened_on > i.attested_on && !closed;
  const inScope = i.listed && (openAtAttestation || openedAfter);
  if (!inScope) return { in_scope: false, pending: false, history_delivered: false, handoff_status: null, owner_after_transfer: null };
  const retained = RETAINED_CASE_TYPES.includes(i.case_type);
  const denial = i.denial_sent_on ?? null;
  const appealWindowExpired = denial !== null && !i.appeal_received_on && addDays(denial, APPEAL_WINDOW_DAYS) < i.today;
  const pending = (i.subject_to_1024_41 ?? true) && !closed && !appealWindowExpired;
  return { in_scope: true, pending, history_delivered: true, handoff_status: retained ? "retained" : "inventoried", owner_after_transfer: retained ? "supermortgage" : "transferee" };
}

// ============================================================ checks and deadline table
export interface CaseSnapshot {
  readonly case_type: CaseType;
  readonly received_at?: PlainDate | null; readonly completeness?: "incomplete" | "facially_complete" | "complete" | null; readonly facially_complete_at?: PlainDate | null; readonly complete_at?: PlainDate | null;
  readonly ack_sent_at?: PlainDate | null; readonly ack_document_id?: string | null; readonly reasonable_date?: PlainDate | null;
  readonly determination_sent_at?: PlainDate | null; readonly determination_outcome?: DeterminationOutcome | null; readonly determination_document_id?: string | null; readonly determination_options?: readonly string[]; readonly determination_reasons?: readonly string[]; readonly determination_reviewer_id?: string | null; readonly evaluator_id?: string | null;
  readonly appeal_received_at?: PlainDate | null; readonly appeal_decided_at?: PlainDate | null; readonly appeal_reviewer_id?: string | null; readonly appeal_decision_document_id?: string | null;
  /** Bankruptcy evidence for SM_BK_HANDOFF_T1 (pending 3002.1/POC/MFR items, counsel instruction and trustee/debtor-counsel notice dates). */
  readonly bankruptcy?: { readonly pending_items: readonly { readonly kind: BkItemKind; readonly due_on?: PlainDate | null; readonly effective_due?: PlainDate | null }[]; readonly counsel_instructed_on?: PlainDate | null; readonly trustee_notice_sent_on?: PlainDate | null; readonly debtor_counsel_notice_sent_on?: PlainDate | null } | null;
  readonly claim_open?: boolean; readonly sii_pending?: boolean; readonly fpi_cycle_open?: boolean;
  readonly offer_sent_at?: PlainDate | null; readonly acceptance_deadline?: PlainDate | null; readonly offer_terms?: { readonly amount_cents: Cents; readonly rate_pct?: string; readonly term_months?: number } | null;
  readonly trial_start?: PlainDate | null; readonly trial_payments?: readonly { readonly due_on: PlainDate; readonly received_on: PlainDate | null }[];
  readonly forbearance_history?: { readonly initial_start: PlainDate; readonly increments_months: readonly number[] } | null;
  readonly plan_terms?: { readonly kind: "repayment" | "deferral"; readonly amount_cents: Cents; readonly months: number } | null;
  readonly smdu_case_id?: string | null; readonly smdu_status?: string | null;
  readonly foreclosure?: { readonly sale_on: PlainDate | null; readonly earliest_unpaid_due: PlainDate | null; readonly holds_open: readonly string[] } | null;
  readonly counsel_instruction?: { readonly sent_on: PlainDate | null; readonly acked_on: PlainDate | null } | null;
  readonly recovery_analysis_document_id?: string | null; readonly ei_history_document_id?: string | null; readonly rule_set_version?: string | null;
  readonly colorado?: boolean; readonly ai_assisted?: boolean; readonly impact_assessment_ref?: string | null;
}

const has = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
const yes = (code: string, note: string): HandoffCheck => ({ check_code: code, result: "pass", note });
const no = (code: string, note: string): HandoffCheck => ({ check_code: code, result: "fail", note });
const na = (code: string, note: string): HandoffCheck => ({ check_code: code, result: "n_a", note });

/** TO-01..TO-15 over a case snapshot as of COB T−1. Unsent-but-unexpired items are documented, not failed (work-down rule). */
export function handoffChecks(s: CaseSnapshot, T: PlainDate): HandoffCheck[] {
  const out: HandoffCheck[] = [];
  const lossmit = ["lossmit", "appeal", "forbearance", "deferral", "modification", "shortsale", "dil"].includes(s.case_type);
  out.push(lossmit ? (has(s.received_at) ? yes("TO-01", `application present; received_at=${s.received_at}`) : no("TO-01", "no application received date")) : na("TO-01", "not a loss-mit case"));
  out.push(lossmit ? (has(s.completeness) ? yes("TO-02", `${s.completeness}; facially_complete_at=${s.facially_complete_at ?? "—"}; complete_at=${s.complete_at ?? "—"}`) : no("TO-02", "completeness status missing")) : na("TO-02", "not a loss-mit case"));
  if (lossmit && has(s.received_at)) {
    const ack = transferorClocks(s.received_at!, T);
    // TO-03 "acknowledgment sent? copy + reasonable date": a sent ack needs its copy, and the §1024.41(b)(2)(i)(B) reasonable date unless the application was complete.
    const needsReasonableDate = s.completeness !== "complete";
    out.push(has(s.ack_sent_at) ? (has(s.ack_document_id) && (!needsReasonableDate || has(s.reasonable_date)) ? yes("TO-03", `ack sent ${s.ack_sent_at}; copy ${s.ack_document_id}; reasonable_date=${s.reasonable_date ?? "n/a (complete)"}`) : no("TO-03", `ack sent ${s.ack_sent_at} without ${!has(s.ack_document_id) ? "the copy" : "the reasonable date"}`))
      : ack.handoff_if_unsent ? yes("TO-03", `not sent; period unexpired (due ${ack.ack_due}); transferee (k)(2)(i) deadline ${transfereeAckDue(T, true)}`) : no("TO-03", `ack not sent and due ${ack.ack_due} before T — Supermortgage's breach`));
  } else out.push(na("TO-03", "no application"));
  if (lossmit && has(s.complete_at)) {
    const due = addDays(s.complete_at!, 30);
    if (has(s.determination_sent_at)) {
      // TO-04 "determination sent? copy, options, reasons, reviewer record": the copy is required; any adverse determination (or one whose outcome is unrecorded) needs the
      // lossmit_reviewer record with reviewer ≠ evaluator; a Colorado AI-assisted determination also carries the impact-assessment reference and human-review record.
      const adverse = !has(s.determination_outcome) || ADVERSE_OUTCOMES.includes(s.determination_outcome!);
      const missing: string[] = [];
      if (!has(s.determination_document_id)) missing.push("the copy");
      if (adverse && !has(s.determination_reviewer_id)) missing.push("the lossmit_reviewer record");
      if (adverse && has(s.determination_reviewer_id) && s.determination_reviewer_id === s.evaluator_id) missing.push("reviewer separation (§1024.41(h)(3): reviewer = evaluator)");
      if (s.colorado && s.ai_assisted && !has(s.impact_assessment_ref)) missing.push("the Colorado impact-assessment reference");
      out.push(missing.length ? no("TO-04", `${s.determination_outcome ?? "determination"} sent ${s.determination_sent_at} without ${missing.join(", ")}`)
        : yes("TO-04", `${s.determination_outcome ?? "determination"} sent ${s.determination_sent_at}; copy ${s.determination_document_id}; options=${(s.determination_options ?? []).join("|") || "—"}; reasons=${(s.determination_reasons ?? []).join("|") || "—"}; reviewer=${s.determination_reviewer_id ?? "n/a (non-adverse)"}${s.colorado && s.ai_assisted ? `; impact_assessment=${s.impact_assessment_ref}; human_review=${s.determination_reviewer_id}` : ""}`));
    } else out.push(due >= T ? yes("TO-04", `not sent; period unexpired (due ${due}); transferee (k)(3) date ${transfereeEvaluationDue(T)}`) : no("TO-04", `determination due ${due} before T and not sent — Supermortgage's breach`));
  } else out.push(na("TO-04", "no complete application"));
  if (lossmit && has(s.appeal_received_at)) {
    const due = addDays(s.appeal_received_at!, 30);
    if (has(s.appeal_decided_at)) out.push(has(s.appeal_reviewer_id) && s.appeal_reviewer_id !== s.evaluator_id ? yes("TO-05", `appeal ${s.appeal_received_at} decided ${s.appeal_decided_at}; reviewer ${s.appeal_reviewer_id} ≠ evaluator ${s.evaluator_id ?? "—"}`) : no("TO-05", "appeal decided without reviewer separation (§1024.41(h)(3))"));
    else out.push(due >= T ? yes("TO-05", `appeal ${s.appeal_received_at} pending; due ${due}; transferee (k)(4) date ${transfereeAppealDue(T, s.appeal_received_at!)}`) : no("TO-05", `appeal decision due ${due} before T and not sent`));
  } else out.push(na("TO-05", "no appeal"));
  out.push(has(s.offer_sent_at) ? (has(s.acceptance_deadline) && s.offer_terms ? yes("TO-06", `offer ${s.offer_sent_at}; accept by ${s.acceptance_deadline}; ${s.offer_terms.amount_cents} cents${s.offer_terms.rate_pct ? ` @ ${s.offer_terms.rate_pct}%` : ""}${s.offer_terms.term_months ? ` / ${s.offer_terms.term_months} mo` : ""}`) : no("TO-06", "offer without terms or acceptance deadline")) : na("TO-06", "no offer"));
  out.push(has(s.trial_start) ? (s.trial_payments ? yes("TO-07", `trial from ${s.trial_start}; ${s.trial_payments.map((p) => `${p.due_on}:${p.received_on ?? "unpaid"}`).join(",")}`) : no("TO-07", "trial schedule without payment history")) : na("TO-07", "no trial plan"));
  if (s.forbearance_history) { const cum = s.forbearance_history.increments_months.reduce((a, b) => a + b, 0); const room = forbearanceCarryover(cum, 3); out.push(yes("TO-08", `initial start ${s.forbearance_history.initial_start}; increments ${s.forbearance_history.increments_months.join("+")} = ${cum} months; transferee may grant ${room.allowed_months} more`)); } else out.push(na("TO-08", "no forbearance history"));
  out.push(s.plan_terms ? yes("TO-09", `${s.plan_terms.kind}: ${s.plan_terms.amount_cents} cents × ${s.plan_terms.months}`) : na("TO-09", "no repayment/deferral plan"));
  out.push(has(s.smdu_case_id) ? (has(s.smdu_status) ? yes("TO-10", `SMDU ${s.smdu_case_id} ${s.smdu_status}`) : no("TO-10", "SMDU case without a status")) : na("TO-10", "no SMDU case"));
  if (s.foreclosure) { const g = foreclosureGates({ transfer_date: T, sale_on: s.foreclosure.sale_on, complete_received_on: s.complete_at ?? null, reasonable_date: s.reasonable_date ?? null, earliest_unpaid_due: s.foreclosure.earliest_unpaid_due }); out.push(yes("TO-11", g.map((x) => `${x.code}=${x.state}@${x.anchor ?? "—"}`).join("; "))); } else out.push(na("TO-11", "no foreclosure"));
  if (s.foreclosure || s.case_type === "bankruptcy") out.push(s.counsel_instruction?.acked_on ? yes("TO-12", `instruction sent ${s.counsel_instruction.sent_on}, acked ${s.counsel_instruction.acked_on}`) : no("TO-12", s.counsel_instruction?.sent_on ? `instruction sent ${s.counsel_instruction.sent_on}; no acknowledgment` : "no counsel instruction")); else out.push(na("TO-12", "no counsel"));
  out.push(lossmit ? (has(s.recovery_analysis_document_id) ? yes("TO-13", `recovery analysis ${s.recovery_analysis_document_id}`) : no("TO-13", "recovery analysis missing (§1024.38(b)(4))")) : na("TO-13", "not a loss-mit case"));
  out.push(has(s.ei_history_document_id) ? yes("TO-14", `EI/continuity history ${s.ei_history_document_id}`) : no("TO-14", "EI/continuity history missing (§1024.39/§1024.40)"));
  out.push(has(s.rule_set_version) ? yes("TO-15", `rule set ${s.rule_set_version}`) : no("TO-15", "rule-set version missing"));
  return out;
}

/** TO-11: the foreclosure gates exported with their anchors — (g) dual tracking, (f)(1) 120-day, (k)(2)(ii) first-filing. */
export function foreclosureGates(i: { transfer_date: PlainDate; sale_on: PlainDate | null; complete_received_on: PlainDate | null; reasonable_date?: PlainDate | null; earliest_unpaid_due?: PlainDate | null }): { code: string; state: "open" | "closed" | "exported"; anchor: PlainDate | null; note: string }[] {
  const out: { code: string; state: "open" | "closed" | "exported"; anchor: PlainDate | null; note: string }[] = [];
  if (i.complete_received_on) {
    const tier = tierAtReceipt(i.complete_received_on, i.sale_on);
    const closed = tier.regx !== "none";
    out.push({ code: "REGX_1024_41G_DUAL_TRACK_GATE", state: closed ? "closed" : "open", anchor: i.complete_received_on, note: closed ? `complete application ${i.complete_received_on} received ${tier.days_before_sale ?? "∞"} days before the sale (>37): no sale while pending (§1024.41(g))` : `complete application ${tier.days_before_sale} days before the sale (≤37): (g) not triggered; §1024.41(k)(2)(ii)(B) evaluation by the transferee${i.reasonable_date && i.complete_received_on <= i.reasonable_date ? " (received by the reasonable date)" : ""}` });
  } else out.push({ code: "REGX_1024_41G_DUAL_TRACK_GATE", state: "open", anchor: null, note: "no complete application pending" });
  out.push({ code: "REGX_1024_41F1_120_DAY_GATE", state: "exported", anchor: i.earliest_unpaid_due ?? null, note: "computed from the original delinquency, which continues across the transfer (13.1)" });
  if (i.reasonable_date) out.push({ code: "REGX_1024_41K2_NO_FIRST_FILING_GATE", state: "exported", anchor: i.reasonable_date, note: `no first notice/filing until ${addDays(i.reasonable_date, 1)} (§1024.41(k)(2)(ii))` });
  return out;
}

/** The exported deadline table: every open timer with anchor, due date and who owns it after T. */
export function deadlineTable(s: CaseSnapshot, T: PlainDate): DeadlineRow[] {
  const rows: DeadlineRow[] = [];
  const owner = (due: PlainDate): OwnerAfterTransfer => (due >= T ? "transferee" : "supermortgage");
  if (s.received_at && !s.ack_sent_at) { const c = transferorClocks(s.received_at, T); rows.push({ code: "REGX_1024_41B2_ACK_5", anchor: s.received_at, due_at: c.ack_due, status: "open", owner_after_transfer: owner(c.ack_due) }); if (c.handoff_if_unsent) rows.push({ code: "REGX_1024_41K2_TRANSFEREE_ACK_10", anchor: T, due_at: transfereeAckDue(T, true), status: "exported", owner_after_transfer: "transferee" }); }
  if (s.complete_at && !s.determination_sent_at) { const due = addDays(s.complete_at, 30); rows.push({ code: "REGX_1024_41C1_EVAL_30", anchor: s.complete_at, due_at: due, status: "open", owner_after_transfer: owner(due) }); rows.push({ code: "REGX_1024_41K3_COMPLETE_APP_EVAL_30", anchor: T, due_at: transfereeEvaluationDue(T), status: "exported", owner_after_transfer: "transferee" }); }
  if (s.appeal_received_at && !s.appeal_decided_at) { const due = addDays(s.appeal_received_at, 30); rows.push({ code: "REGX_1024_41H_APPEAL_DETERMINATION_30", anchor: s.appeal_received_at, due_at: due, status: "open", owner_after_transfer: owner(due) }); rows.push({ code: "REGX_1024_41K4_APPEAL_DETERMINATION_30", anchor: s.appeal_received_at, due_at: transfereeAppealDue(T, s.appeal_received_at), status: "exported", owner_after_transfer: "transferee" }); }
  // Discrepancy (2): "denials with open appeal windows are all in scope" — an adverse determination sent before T whose §1024.41(h) 14-day appeal window is still
  // open at T exports the window (1.7's REGX_1024_41H_APPEAL_WINDOW_14 on the inbound side); a window that expired before T is history, not a clock.
  if (s.determination_sent_at && !s.appeal_received_at && (!has(s.determination_outcome) || ADVERSE_OUTCOMES.includes(s.determination_outcome!))) { const end = addDays(s.determination_sent_at, APPEAL_WINDOW_DAYS); if (end >= T) rows.push({ code: "REGX_1024_41H_APPEAL_WINDOW_14", anchor: s.determination_sent_at, due_at: end, status: "exported", owner_after_transfer: "transferee" }); }
  if (s.acceptance_deadline) rows.push({ code: "REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE", anchor: s.acceptance_deadline, due_at: s.acceptance_deadline, status: s.acceptance_deadline >= T ? "exported" : "open", owner_after_transfer: owner(s.acceptance_deadline) });
  for (const p of s.trial_payments ?? []) if (!p.received_on) { const eom = endOfMonth(p.due_on); rows.push({ code: "FNMA_F1_27_TRIAL_PAYMENT_EOM", anchor: p.due_on, due_at: eom, status: "open", owner_after_transfer: eom < T ? "supermortgage" : "transferee" }); }
  if (s.forbearance_history) rows.push({ code: "FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M", anchor: s.forbearance_history.initial_start, due_at: addMonths(s.forbearance_history.initial_start, 12), status: "exported", owner_after_transfer: "transferee" });
  if (s.reasonable_date) rows.push({ code: "REGX_1024_41K2_NO_FIRST_FILING_GATE", anchor: s.reasonable_date, due_at: addDays(s.reasonable_date, 1), status: "exported", owner_after_transfer: "transferee" });
  if (s.foreclosure?.earliest_unpaid_due) rows.push({ code: "REGX_1024_41F1_120_DAY_GATE", anchor: s.foreclosure.earliest_unpaid_due, due_at: addDays(s.foreclosure.earliest_unpaid_due, 120), status: "exported", owner_after_transfer: "transferee" });
  return rows;
}

// ============================================================ pre-T work-down
/** Work-down rule: every 12.x action due in [T, T+10 federal BD] is completed before T or documented in TO-03/04/05 with the unexpired period — never rushed. */
export function workdownWindow(i: { transfer_date: PlainDate; actions: readonly { code: string; due: PlainDate; completed_on?: PlainDate | null; documented_check?: "TO-03" | "TO-04" | "TO-05" | null }[] }): { timer: "SM_LOSSMIT_PRE_T_WORKDOWN_T1"; due: PlainDate; window_end: PlainDate; in_window: string[]; undocumented: string[]; ok: boolean; escalation: Escalation | null } {
  const T = i.transfer_date; const end = addBusinessDays(T, 10, federal);
  const inWindow = i.actions.filter((a) => a.due >= T && a.due <= end);
  const undocumented = inWindow.filter((a) => !(a.completed_on && a.completed_on < T) && !a.documented_check).map((a) => a.code);
  return { timer: "SM_LOSSMIT_PRE_T_WORKDOWN_T1", due: dayBefore(T), window_end: end, in_window: inWindow.map((a) => a.code), undocumented, ok: undocumented.length === 0, escalation: undocumented.length ? { kind: "officer", severity: "sev2", reason: `actions due in [${T}, ${end}] neither completed before T nor documented: ${undocumented.join(", ")}` } : null };
}

/** REGX_1024_41_TRANSFEROR_CONTINUES_GATE: no 12.x/13.x/14.x/4.x timer on a listed loan may be cancelled with reason `transfer_out` before T. */
export function cancelTimerRequest(i: { listed: boolean; reason: string; today: PlainDate; transfer_date: PlainDate; timer_code: string }): { allowed: boolean; gate: "REGX_1024_41_TRANSFEROR_CONTINUES_GATE" | null; refusal: string | null } {
  const g = transferorContinuesGate(i.reason);
  if (i.listed && !g.ok && i.today < i.transfer_date) return { allowed: false, gate: g.gate, refusal: `cancelTimer ${i.timer_code} refused by ${g.gate}: reason transfer_out before ${i.transfer_date} (§1024.41(k) — the transferor's clocks run until T)` };
  return { allowed: true, gate: null, refusal: null };
}

// ============================================================ post-transfer forwarding
/** Post-transfer forwarding: any loss-mit submission, appeal, acceptance or rejection received by Supermortgage on a transferred loan is forwarded within 1 servicer BD with its receipt timestamp — same day when the item's deadline falls within that day; Supermortgage never evaluates, acknowledges or decides. */
export function postTransferForwarding(i: { kind: ForwardKind; received_on: PlainDate; transfer_date: PlainDate; loan_status: "transferred_out" | "active"; acceptance_deadline?: PlainDate | null; forwarded_on?: PlainDate | null; transferee_ack_on?: PlainDate | null }): { timer: "SM_LOSSMIT_POST_T_FORWARD_1"; receipt_date: PlainDate; forward_by: PlainDate; urgent_same_day: boolean; forward_on: PlainDate; honor: "honor_no_reunderwrite" | "expired" | null; satisfied: boolean; satisfied_by: "lossmit.forwarded_post_transfer" | null; on_time: boolean | null; evaluated_by_supermortgage: false; breach: Escalation | null; refusal: string | null } {
  const base = { timer: "SM_LOSSMIT_POST_T_FORWARD_1" as const, receipt_date: i.received_on, evaluated_by_supermortgage: false as const };
  if (i.loan_status !== "transferred_out" || i.received_on < i.transfer_date) return { ...base, forward_by: i.received_on, urgent_same_day: false, forward_on: i.received_on, honor: null, satisfied: false, satisfied_by: null, on_time: null, breach: null, refusal: "not a post-transfer receipt: the loan is still Supermortgage's and 12.x processes it" };
  const forwardBy = addBusinessDays(i.received_on, 1, servicer);
  const deadline = i.acceptance_deadline ?? null;
  const urgent = ["acceptance", "appeal", "rejection"].includes(i.kind) && deadline !== null && deadline <= forwardBy;
  const forwardOn = urgent ? i.received_on : forwardBy;
  const honor = i.kind === "acceptance" && deadline ? honorTransferorOffer(i.received_on, deadline) : null;
  const fwd = i.forwarded_on ?? null; const ack = i.transferee_ack_on ?? null;
  const onTime = fwd ? fwd <= forwardBy : null;
  const satisfied = fwd !== null && ack !== null;
  const breach: Escalation | null = fwd && fwd > forwardBy ? { kind: "officer", severity: "sev1", reason: `SM_LOSSMIT_POST_T_FORWARD_1 breached: ${i.kind} received ${i.received_on} forwarded ${fwd} after ${forwardBy}; receipt date still protects the borrower — transferee notified in writing (Compliance Sentinel)` } : null;
  return { ...base, forward_by: forwardBy, urgent_same_day: urgent, forward_on: forwardOn, honor, satisfied, satisfied_by: satisfied ? "lossmit.forwarded_post_transfer" : null, on_time: onTime, breach, refusal: null };
}

// ============================================================ foreclosure hold handoff
/** Sale-window handoff: a foreclosure with a complete application received >37 days before the sale is under §1024.41(g); counsel is instructed to hold by T−1 BD (both firms if the firm changes), the (g)/(f)(1)/(k)(2)(ii) gates go out in TO-11 and the transferee inherits the hold. */
export function foreclosureHoldHandoff(i: { transfer_date: PlainDate; sale_on: PlainDate; complete_received_on: PlainDate | null; reasonable_date?: PlainDate | null; earliest_unpaid_due?: PlainDate | null; instruction_sent_on?: PlainDate | null; counsel_acked_on?: PlainDate | null; firm_changes?: boolean; today?: PlainDate }): { hold_required: boolean; ground: "1024.41(g)" | "1024.41(k)(2)(ii)(B)" | null; days_before_sale: number | null; sale_within_45_days: boolean; hold_instruction_due: PlainDate; sale_window_handoff_due: PlainDate | null; instruction: { kind: "HOLD" | "PROCEED"; to: "attorney_network"; both_firms: boolean; due: PlainDate; sent: boolean; acked: boolean; acked_on_time: boolean | null }; to_11: HandoffCheck & { gates: ReturnType<typeof foreclosureGates> }; transferee_inherits_hold: boolean; escalation: Escalation | null } {
  const T = i.transfer_date;
  const gates = foreclosureGates({ transfer_date: T, sale_on: i.sale_on, complete_received_on: i.complete_received_on, reasonable_date: i.reasonable_date ?? null, earliest_unpaid_due: i.earliest_unpaid_due ?? null });
  const g = gates.find((x) => x.code === "REGX_1024_41G_DUAL_TRACK_GATE")!;
  const hold = g.state === "closed";
  const days = i.complete_received_on ? daysBetween(i.complete_received_on, i.sale_on) : null;
  const ground = hold ? "1024.41(g)" : i.complete_received_on && i.reasonable_date && i.complete_received_on <= i.reasonable_date ? "1024.41(k)(2)(ii)(B)" : null;
  const due = dayBefore(T);
  const within45 = i.sale_on <= addDays(T, 45);
  const acked = i.counsel_acked_on ?? null;
  const instruction = { kind: hold ? ("HOLD" as const) : ("PROCEED" as const), to: "attorney_network" as const, both_firms: i.firm_changes === true, due, sent: Boolean(i.instruction_sent_on), acked: acked !== null, acked_on_time: acked ? acked <= due : null };
  const today = i.today ?? null;
  const escalation: Escalation | null = hold && !acked && today !== null && today > due ? { kind: "officer", severity: "sev1", reason: `SM_LOSSMIT_HOLD_INSTRUCTIONS_T1 breached: hold on the ${i.sale_on} sale not acknowledged by counsel by ${due} — sale-risk report` } : null;
  const to11 = hold && !acked ? no("TO-11", "(g) gate closed but the hold instruction is not acknowledged") : yes("TO-11", gates.map((x) => `${x.code}=${x.state}@${x.anchor ?? "—"}`).join("; "));
  return { hold_required: hold, ground, days_before_sale: days, sale_within_45_days: within45, hold_instruction_due: due, sale_window_handoff_due: within45 ? dayBefore(T, 5) : null, instruction, to_11: { ...to11, gates }, transferee_inherits_hold: hold, escalation };
}

// ============================================================ retained NoE / RFI / complaint
/** NoE/RFI/complaints opened before T stay with Supermortgage on the unchanged 4.1/4.2 clocks; the transferee gets a copy; items about the transferee's future servicing are referred. */
export function retainedRequest(i: { kind: "noe" | "rfi" | "complaint"; received_on: PlainDate; transfer_date: PlainDate; assertion_type?: AssertionType; sale_date?: PlainDate | null; concerns?: "own_servicing" | "transferee_future_servicing" }): { gate: "SM_NOE_RFI_OPEN_RETAINED"; opened_before_transfer: boolean; owner: OwnerAfterTransfer; handoff_status: "retained" | "inventoried"; ack_due: PlainDate | null; response_due: PlainDate; answered_after_transfer: boolean; clocks_unchanged: true; copy_to_transferee: true; referred_to_transferee: boolean; forward_instead: boolean } {
  const before = i.received_on < i.transfer_date;
  const d = i.kind === "noe" ? noeDeadlines(i.assertion_type ?? "b1", i.received_on, { sale_date: i.sale_date ?? null }) : { ...rfiDeadlines("standard", i.received_on), ack_due: rfiDeadlines("standard", i.received_on).ack_due as PlainDate | null };
  return { gate: "SM_NOE_RFI_OPEN_RETAINED", opened_before_transfer: before, owner: before ? "supermortgage" : "transferee", handoff_status: before ? "retained" : "inventoried", ack_due: d.ack_due, response_due: d.response_due, answered_after_transfer: d.response_due >= i.transfer_date, clocks_unchanged: true, copy_to_transferee: true, referred_to_transferee: i.concerns === "transferee_future_servicing", forward_instead: !before };
}

// ============================================================ trial payments across T
/** F-1-27 across T: a trial payment fails only if not received by the last day of its due month; the servicer at month-end records the failure — Supermortgage only for months ending ≤ T−1. A payment mailed to Supermortgage after T is misdirected, protected, and forwarded with its receipt date. */
export function trialPaymentHandoff(i: { due_on: PlainDate; received_on: PlainDate | null; transfer_date: PlainDate; amount_cents?: Cents | null; trial_amount_cents?: Cents | null; forwarded_on?: PlainDate | null }): { timer: "FNMA_F1_27_TRIAL_PAYMENT_EOM"; month_end: PlainDate; month_end_servicer: OwnerAfterTransfer; misdirected: boolean; protected: boolean; receipt_date: PlainDate | null; forward_by: PlainDate | null; forwarded_on_time: boolean | null; month_met: boolean; failure_recorded_by_supermortgage: boolean; failure_determination_owner: OwnerAfterTransfer; smdu_reported_by_supermortgage: boolean } {
  const T = i.transfer_date; const eom = endOfMonth(i.due_on);
  const monthEndServicer: OwnerAfterTransfer = eom < T ? "supermortgage" : "transferee";
  const received = i.received_on ?? null;
  const misdirected = received !== null && received >= T;
  const amountsKnown = i.amount_cents !== undefined && i.amount_cents !== null && i.trial_amount_cents !== undefined && i.trial_amount_cents !== null;
  const met = received !== null && (amountsKnown ? trialMonthMet(received, i.due_on, i.amount_cents!, i.trial_amount_cents!) : received <= eom);
  const forwardBy = misdirected ? addBusinessDays(received!, 1, servicer) : null;
  const fwd = i.forwarded_on ?? null;
  return { timer: "FNMA_F1_27_TRIAL_PAYMENT_EOM", month_end: eom, month_end_servicer: monthEndServicer, misdirected, protected: misdirected, receipt_date: received, forward_by: forwardBy, forwarded_on_time: forwardBy && fwd ? fwd <= forwardBy : null, month_met: met, failure_recorded_by_supermortgage: monthEndServicer === "supermortgage" && !met, failure_determination_owner: monthEndServicer, smdu_reported_by_supermortgage: monthEndServicer === "supermortgage" };
}

// ============================================================ determinations before T
/** Determination proposed before T: an adverse notice cannot issue without a `lossmit_reviewer` approval record (reviewer ≠ evaluator, §1024.41(h)(3); Colorado AI Act / LL-2026-04); nothing issues on or after T; absent approval by T−1 the case is handed off undetermined with TO-04 documenting the unexpired period and the transferee's (k)(3) date. */
export type DeterminationRefusal = "DENIAL_NEEDS_REVIEWER" | "REVIEWER_SEPARATION" | "NOTHING_ISSUED_AFTER_T" | "NEVER_RUSH_DETERMINATION";
export function preTransferDetermination(i: { outcome: "denial" | "offer" | "appeal_denied" | "appeal_granted"; proposed_on: PlainDate; transfer_date: PlainDate; complete_at: PlainDate; evaluator_id: string; reviewer_approval?: { reviewer_id: string; approved_on: PlainDate; record_id: string } | null; ai_proposed?: boolean; /** The underwriter's attestation that the evaluation is complete (documents reviewed, NPV/waterfall run); `false` = a determination proposed before its evaluation is done, i.e. rushed to beat T. */ evaluation_complete?: boolean }): { adverse: boolean; issue_by: PlainDate; supermortgage_due: PlainDate; due_before_transfer: boolean; can_issue: boolean; refusal: string | null; refusal_code: DeterminationRefusal | null; rushed_to_beat_transfer: boolean; handoff: { status: "determined_before_transfer" | "handed_off_undetermined"; to_04: HandoffCheck; transferee_deadline: PlainDate | null }; escalation: Escalation | null } {
  const T = i.transfer_date; const issueBy = dayBefore(T); const adverse = i.outcome === "denial" || i.outcome === "appeal_denied";
  const due = addDays(i.complete_at, 30);
  const appr = i.reviewer_approval ?? null;
  let code: DeterminationRefusal | null = null;
  if (i.proposed_on > issueBy) code = "NOTHING_ISSUED_AFTER_T";
  else if (i.evaluation_complete === false) code = "NEVER_RUSH_DETERMINATION";   // work-down rule: never at the expense of the evaluation quality — hand off with the unexpired period instead
  else if (adverse && !appr) code = "DENIAL_NEEDS_REVIEWER";
  else if (adverse && appr && (appr.reviewer_id === i.evaluator_id || appr.approved_on > issueBy)) code = appr.reviewer_id === i.evaluator_id ? "REVIEWER_SEPARATION" : "NOTHING_ISSUED_AFTER_T";
  const canIssue = code === null;
  const refusal = code === "DENIAL_NEEDS_REVIEWER" ? `${i.outcome} notice cannot issue without a lossmit_reviewer approval record (Colorado AI Act; LL-2026-04)` : code === "REVIEWER_SEPARATION" ? `reviewer ${appr?.reviewer_id} evaluated the application — §1024.41(h)(3) requires a different reviewer` : code === "NOTHING_ISSUED_AFTER_T" ? `nothing issues on or after ${T} on a transferred loan (issue by ${issueBy})` : code === "NEVER_RUSH_DETERMINATION" ? `${i.outcome} proposed ${i.proposed_on} before the evaluation is complete — never rushed to beat ${T}; hand off with the unexpired period documented in TO-04` : null;
  // "Rushed to beat T": an adverse AI proposal inside the last two days before T without a reviewer record, or any proposal made before its evaluation is complete.
  const rushed = (adverse && (i.ai_proposed ?? true) && !appr && daysBetween(i.proposed_on, T) <= 2) || i.evaluation_complete === false;
  const to04: HandoffCheck = canIssue ? yes("TO-04", `${i.outcome} determination issued before T with reviewer record ${appr?.record_id ?? "n/a (non-adverse)"}`) : due >= T ? yes("TO-04", `not sent; period unexpired (due ${due}); transferee (k)(3) date ${transfereeEvaluationDue(T)}`) : no("TO-04", `determination due ${due} before T and not issued — Supermortgage's breach`);
  const escalation: Escalation | null = canIssue ? null : code === "DENIAL_NEEDS_REVIEWER" ? { kind: "lossmit_reviewer", reason: `${i.outcome} proposed ${i.proposed_on}: reviewer approval needed by ${issueBy} or the case is handed off undetermined — never issue an unreviewed adverse decision to beat T` } : due < T ? { kind: "officer", severity: "sev1", reason: `determination due ${due} before T not issued` } : null;
  return { adverse, issue_by: issueBy, supermortgage_due: due, due_before_transfer: due < T, can_issue: canIssue, refusal, refusal_code: code, rushed_to_beat_transfer: rushed, handoff: { status: canIssue ? "determined_before_transfer" : "handed_off_undetermined", to_04: to04, transferee_deadline: canIssue ? null : transfereeEvaluationDue(T) }, escalation };
}

// ============================================================ bankruptcy handoff
export type BkItemKind = "3002.1_payment_change" | "3002.1_fee_notice" | "3002.1_response" | "poc" | "mfr";
/** Bankruptcy handoff by T−1 BD: pending 3002.1/POC/MFR items are flagged with their due dates and the owner after T, counsel is instructed on them, and both servicer-change notices — trustee and debtor's counsel (open question 3 default: "trustee and debtor-counsel letters before T from 14.x templates") — go out (district practice [UNVERIFIED]). */
export function bankruptcyHandoff(i: { transfer_date: PlainDate; pending_items: readonly { kind: BkItemKind; due_on?: PlainDate | null; effective_due?: PlainDate | null }[]; counsel_instructed_on?: PlainDate | null; trustee_notice_sent_on?: PlainDate | null; debtor_counsel_notice_sent_on?: PlainDate | null; today?: PlainDate }): { timer: "SM_BK_HANDOFF_T1"; due: PlainDate; flagged: { kind: BkItemKind; due_on: PlainDate; owner_after_transfer: OwnerAfterTransfer; due_after_transfer: boolean }[]; counsel_instruction_due: PlainDate; trustee_notice_due: PlainDate; debtor_counsel_notice_due: PlainDate; counsel_instructed_on_time: boolean | null; trustee_notice_on_time: boolean | null; debtor_counsel_notice_on_time: boolean | null; satisfied: boolean; missing: ("counsel_instruction" | "trustee_notice" | "debtor_counsel_notice")[]; escalation: Escalation | null; unverified_local_practice: true } {
  const T = i.transfer_date; const due = dayBefore(T);
  const flagged = i.pending_items.map((p) => { const d = p.due_on ?? (p.effective_due ? paymentChangeDeadline(p.effective_due).deadline : null); if (!d) throw new RangeError(`${p.kind}: due_on or effective_due is required`); return { kind: p.kind, due_on: d, owner_after_transfer: (d >= T ? "transferee" : "supermortgage") as OwnerAfterTransfer, due_after_transfer: d >= T }; });
  const c = i.counsel_instructed_on ?? null; const t = i.trustee_notice_sent_on ?? null; const d = i.debtor_counsel_notice_sent_on ?? null;
  const cOk = c ? c <= due : null; const tOk = t ? t <= due : null; const dOk = d ? d <= due : null;
  const missing: ("counsel_instruction" | "trustee_notice" | "debtor_counsel_notice")[] = [];
  if (cOk !== true) missing.push("counsel_instruction"); if (tOk !== true) missing.push("trustee_notice"); if (dOk !== true) missing.push("debtor_counsel_notice");
  const satisfied = missing.length === 0;
  const today = i.today ?? null;
  const labels = { counsel_instruction: "counsel not instructed", trustee_notice: "trustee notice not sent", debtor_counsel_notice: "debtor-counsel notice not sent" } as const;
  const escalation: Escalation | null = !satisfied && today !== null && today > due ? { kind: "attorney", severity: "sev1", reason: `SM_BK_HANDOFF_T1 breached: ${missing.map((m) => labels[m]).join("; ")} by ${due}` } : null;
  return { timer: "SM_BK_HANDOFF_T1", due, flagged, counsel_instruction_due: due, trustee_notice_due: due, debtor_counsel_notice_due: due, counsel_instructed_on_time: cOk, trustee_notice_on_time: tOk, debtor_counsel_notice_on_time: dOk, satisfied, missing, escalation, unverified_local_practice: true };
}

// ============================================================ SMDU continuity
/** SM_SMDU_CASE_HANDOFF_T0: status current through T−1 (trial payments reported) and, for servicer-number changes, the Fannie Mae request package filed by the `fnma_portal_operator` [UNVERIFIED mechanics]. */
export function smduHandoff(i: { smdu_case_id: string; status_reported_through: PlainDate | null; transfer_date: PlainDate; servicer_number_change: boolean; fnma_request_package_filed?: boolean }): { timer: "SM_SMDU_CASE_HANDOFF_T0"; due: PlainDate; current_through_t1: boolean; request_package_required: boolean; ok: boolean; portal_task: { kind: "human_portal_task"; owner_role: "fnma_portal_operator"; reason: string } | null; escalation: Escalation | null; unverified: true } {
  const T = i.transfer_date; const t1 = addDays(T, -1);
  const current = i.status_reported_through !== null && i.status_reported_through >= t1;
  const needsPkg = i.servicer_number_change && !(i.fnma_request_package_filed ?? false);
  const ok = current && !needsPkg;
  return { timer: "SM_SMDU_CASE_HANDOFF_T0", due: T, current_through_t1: current, request_package_required: i.servicer_number_change, ok, portal_task: needsPkg ? { kind: "human_portal_task", owner_role: "fnma_portal_operator", reason: `SMDU ${i.smdu_case_id}: servicer-number change — file the Fannie Mae request package (loan list, SMDU case IDs, transfer date, D-Code) before ${T}` } : null, escalation: ok ? null : { kind: "fnma_portal_operator", severity: "sev1", reason: `SMDU ${i.smdu_case_id}: ${current ? "" : `status not current through ${t1}`}${!current && needsPkg ? "; " : ""}${needsPkg ? "request package not filed" : ""}` }, unverified: true };
}

/** Case handoff state machine transitions (per case). */
export const HANDOFF_TRANSITIONS: Readonly<Record<HandoffStatus, readonly HandoffStatus[]>> = {
  inventoried: ["pre_transfer_active", "retained"], pre_transfer_active: ["snapshot"], snapshot: ["packaged", "deficient"], packaged: ["delivered"], delivered: ["acked", "deficient"], acked: ["closed_transferred"], deficient: ["resolved"], resolved: ["packaged", "delivered"], closed_transferred: [], retained: ["closed_transferred"],
};
export function handoffTransition(from: HandoffStatus, to: HandoffStatus): { ok: boolean; refusal: string | null } { return HANDOFF_TRANSITIONS[from].includes(to) ? { ok: true, refusal: null } : { ok: false, refusal: `case_handoffs: ${from} → ${to} is not a transition of the 17.4 state machine` }; }

// ============================================================ inventory flags (the `case.handoff.inventoried` payload)
export interface InventoryFlags {
  readonly case_type: CaseType; readonly case_kind: CaseType; readonly lossmit: boolean; readonly retained: boolean;
  readonly fc_active: boolean; readonly gates_open: boolean; readonly hold_instruction_required: boolean; readonly sale_on: PlainDate | null; readonly sale_within_45_days: boolean;
  readonly bk_active: boolean; readonly smdu_case_id: string | null; readonly trial_payment_due_before_transfer: boolean; readonly trial_due_date: PlainDate | null;
  readonly claim_open: boolean; readonly sii_pending: boolean; readonly fpi_cycle_open: boolean;
}
const LOSSMIT_TYPES: readonly CaseType[] = ["lossmit", "appeal", "forbearance", "deferral", "modification", "shortsale", "dil"];
/**
 * The facts the T−1 handoff timers key on, derived from the case snapshot at attestation: `fc_active or gates open` (SM_LOSSMIT_HOLD_INSTRUCTIONS_T1),
 * `fc sale date ≤ T+45` (SM_FC_SALE_WINDOW_HANDOFF), `bk_active` (SM_BK_HANDOFF_T1), `smdu_case_id present` (SM_SMDU_CASE_HANDOFF_T0), a trial payment due
 * before T (FNMA_F1_27_TRIAL_PAYMENT_EOM), `insurance_claim or mi_claim open`, `sii pending` and `fpi notice cycle open`. Gates are "open" when a §1024.41
 * protection is in effect: an open foreclosure hold, a pending complete application ((g)) or appeal ((h)), or a delinquency still inside the 120-day (f)(1) period.
 */
export function inventoryFlags(s: CaseSnapshot, T: PlainDate): InventoryFlags {
  const lossmit = LOSSMIT_TYPES.includes(s.case_type);
  const fc = s.case_type === "foreclosure" || Boolean(s.foreclosure);
  const eu = s.foreclosure?.earliest_unpaid_due ?? null;
  const gatesOpen = (s.foreclosure?.holds_open.length ?? 0) > 0 || (has(s.complete_at) && !has(s.determination_sent_at)) || (has(s.appeal_received_at) && !has(s.appeal_decided_at)) || (eu !== null && daysBetween(eu, T) <= 120);
  const saleOn = s.foreclosure?.sale_on ?? null;
  const trial = (s.trial_payments ?? []).find((p) => !p.received_on && p.due_on < T) ?? null;
  return {
    case_type: s.case_type, case_kind: s.case_type, lossmit, retained: RETAINED_CASE_TYPES.includes(s.case_type),
    fc_active: fc, gates_open: gatesOpen, hold_instruction_required: fc || gatesOpen, sale_on: saleOn, sale_within_45_days: saleOn !== null && saleOn <= addDays(T, 45),
    bk_active: s.case_type === "bankruptcy" || Boolean(s.bankruptcy), smdu_case_id: has(s.smdu_case_id) ? s.smdu_case_id! : null,
    trial_payment_due_before_transfer: trial !== null, trial_due_date: trial?.due_on ?? null,
    claim_open: s.case_type === "insurance_claim" || s.case_type === "mi_claim" || s.claim_open === true, sii_pending: s.case_type === "sii" || s.sii_pending === true, fpi_cycle_open: s.case_type === "fpi" || s.fpi_cycle_open === true,
  };
}

// ============================================================ package evidence (the `case.handoff.packaged` payload)
/** The 12.x actions still open on the snapshot, each documented iff its TO-03/04/05 check passed — the work-down window is measured, never asserted. */
export function workdownEvidence(s: CaseSnapshot, T: PlainDate, checks: readonly HandoffCheck[]): ReturnType<typeof workdownWindow> {
  const passed = (code: string): boolean => checks.find((c) => c.check_code === code)?.result === "pass";
  const actions: { code: string; due: PlainDate; documented_check: "TO-03" | "TO-04" | "TO-05" | null }[] = [];
  if (has(s.received_at) && !has(s.ack_sent_at)) actions.push({ code: "REGX_1024_41B2_ACK_5", due: transferorClocks(s.received_at!, T).ack_due, documented_check: passed("TO-03") ? "TO-03" : null });
  if (has(s.complete_at) && !has(s.determination_sent_at)) actions.push({ code: "REGX_1024_41C1_EVAL_30", due: addDays(s.complete_at!, 30), documented_check: passed("TO-04") ? "TO-04" : null });
  if (has(s.appeal_received_at) && !has(s.appeal_decided_at)) actions.push({ code: "REGX_1024_41H_APPEAL_DETERMINATION_30", due: addDays(s.appeal_received_at!, 30), documented_check: passed("TO-05") ? "TO-05" : null });
  return workdownWindow({ transfer_date: T, actions });
}
export interface PackageEvidence {
  readonly lossmit: boolean; readonly pre_transfer_workdown: "documented" | "undocumented"; readonly workdown: ReturnType<typeof workdownWindow>;
  readonly bankruptcy: ReturnType<typeof bankruptcyHandoff> | null; readonly trustee_notice_sent: boolean; readonly debtor_counsel_notice_sent: boolean; readonly counsel_instructed: boolean;
  readonly sale_within_45_days: boolean; readonly deficiencies: string[];
}
/** What the packaged event may claim: the work-down state from the checks, the bankruptcy notices/instruction from dated evidence by T−1 BD, and the failed TO-* codes. */
export function packageEvidence(s: CaseSnapshot, T: PlainDate, checks: readonly HandoffCheck[]): PackageEvidence {
  const workdown = workdownEvidence(s, T, checks);
  const bk = s.bankruptcy ? bankruptcyHandoff({ transfer_date: T, pending_items: s.bankruptcy.pending_items, counsel_instructed_on: s.bankruptcy.counsel_instructed_on ?? null, trustee_notice_sent_on: s.bankruptcy.trustee_notice_sent_on ?? null, debtor_counsel_notice_sent_on: s.bankruptcy.debtor_counsel_notice_sent_on ?? null }) : null;
  return { lossmit: LOSSMIT_TYPES.includes(s.case_type), pre_transfer_workdown: workdown.ok ? "documented" : "undocumented", workdown, bankruptcy: bk, trustee_notice_sent: bk?.trustee_notice_on_time === true, debtor_counsel_notice_sent: bk?.debtor_counsel_notice_on_time === true, counsel_instructed: bk?.counsel_instructed_on_time === true, sale_within_45_days: inventoryFlags(s, T).sale_within_45_days, deficiencies: checks.filter((c) => c.result === "fail").map((c) => c.check_code) };
}

// ============================================================ batch-level roll-ups (the batch-subject rows)
/** One `case_handoffs` row as the roll-up sees it. Retained cases (NoE/RFI/complaint, owner stays Supermortgage) are never delivered or acked and do not count. */
export interface HandoffRow { readonly case_id: string; readonly case_type: CaseType; readonly status: HandoffStatus; readonly pre_transfer_workdown?: "documented" | "undocumented" | null }
const PAST_PACKAGED: readonly HandoffStatus[] = ["packaged", "delivered", "acked", "closed_transferred"];
/**
 * SM_LOSSMIT_HANDOFF_FILE_1 ("final case packages acked") and SM_LOSSMIT_PRE_T_WORKDOWN_T1 ("every 12.x action … completed before T or documented in
 * TO-03/04/05") are armed on the batch the attestation / cutover freeze names, so their satisfactions are batch facts: every handed-off case of the batch
 * acked; every loss-mit case of the batch packaged with its work-down documented. Measured over the rows, never asserted by the caller.
 */
export function batchHandoffRollup(rows: readonly HandoffRow[]): { handed_off: number; acked: number; all_acked: boolean; lossmit: number; lossmit_packaged: number; workdown_documented: boolean; workdown_undocumented: string[] } {
  const handed = rows.filter((r) => !RETAINED_CASE_TYPES.includes(r.case_type));
  const acked = handed.filter((r) => r.status === "acked" || r.status === "closed_transferred");
  const lm = handed.filter((r) => LOSSMIT_TYPES.includes(r.case_type));
  const packaged = lm.filter((r) => PAST_PACKAGED.includes(r.status));
  const undocumented = lm.filter((r) => !PAST_PACKAGED.includes(r.status) || r.pre_transfer_workdown !== "documented").map((r) => r.case_id);
  return { handed_off: handed.length, acked: acked.length, all_acked: handed.length > 0 && acked.length === handed.length, lossmit: lm.length, lossmit_packaged: packaged.length, workdown_documented: lm.length > 0 && undocumented.length === 0, workdown_undocumented: undocumented };
}

/** SM_LOSSMIT_HANDOFF_FILE_14: the transferee's acknowledgment of the preliminary case inventory + loss-mit file (17.3's D21 workout status / D34 open-case handoff, preliminary run) — due T−14 calendar days. */
export function preliminaryHandoffAck(i: { transfer_date: PlainDate; deliverable_kind: string; acked_on: PlainDate; as_of?: PlainDate | null }): { timer: "SM_LOSSMIT_HANDOFF_FILE_14"; due: PlainDate; deliverable_kind: "D21" | "D34"; on_time: boolean; refusal: string | null } {
  const due = addDays(i.transfer_date, -14);
  if (i.deliverable_kind !== "D21" && i.deliverable_kind !== "D34") return { timer: "SM_LOSSMIT_HANDOFF_FILE_14", due, deliverable_kind: "D34", on_time: false, refusal: `deliverable ${i.deliverable_kind || "(none)"} is not the preliminary case inventory (D34) or loss-mit file (D21)` };
  if (i.as_of && i.as_of >= i.transfer_date) return { timer: "SM_LOSSMIT_HANDOFF_FILE_14", due, deliverable_kind: i.deliverable_kind, on_time: false, refusal: `a preliminary ${i.deliverable_kind} is as of a date before T, not ${i.as_of}` };
  return { timer: "SM_LOSSMIT_HANDOFF_FILE_14", due, deliverable_kind: i.deliverable_kind, on_time: i.acked_on <= due, refusal: null };
}

// ============================================================ post-transfer intake
/**
 * A post-transfer submission addressed to Supermortgage (spec Inputs: `lossmit.document.received{loan.status='transferred_out'}`, `lossmit.appeal.received`,
 * `lossmit.offer.accepted/rejected`) is recorded as one receipt event, `lossmit.document.received{kind, loan_status=transferred_out, received_at}`, that arms
 * SM_LOSSMIT_POST_T_FORWARD_1 — never as the 12.x intake events, which would start Supermortgage's own (b)(2)/(h) clocks on a loan it no longer services.
 */
export function postTransferReceipt(i: { kind: ForwardKind; received_on: PlainDate; transfer_date: PlainDate; loan_status: "transferred_out" | "active"; acceptance_deadline?: PlainDate | null }): { event: "lossmit.document.received"; kind: ForwardKind; received_at: PlainDate; loan_status: "transferred_out"; forward_by: PlainDate; urgent_same_day: boolean; forward_on: PlainDate; refusal: string | null } {
  const f = postTransferForwarding({ kind: i.kind, received_on: i.received_on, transfer_date: i.transfer_date, loan_status: i.loan_status, acceptance_deadline: i.acceptance_deadline ?? null });
  return { event: "lossmit.document.received", kind: i.kind, received_at: i.received_on, loan_status: "transferred_out", forward_by: f.forward_by, urgent_same_day: f.urgent_same_day, forward_on: f.forward_on, refusal: f.refusal };
}

// ============================================================ counsel acknowledgment
/** SM_LOSSMIT_HOLD_INSTRUCTIONS_T1 is satisfied by the firm's acknowledgment (`attorney.instruction.acked`) — due T−1 servicer BD; late acknowledgments are recorded, not refused. */
export function counselAcknowledgment(i: { transfer_date: PlainDate; kind: "HOLD" | "PROCEED" | "FILE_TRANSFER"; acked_on: PlainDate; instruction_sent_on?: PlainDate | null }): { timer: "SM_LOSSMIT_HOLD_INSTRUCTIONS_T1"; due: PlainDate; on_time: boolean; satisfied_by: "attorney.instruction.acked"; before_transfer: boolean } {
  const due = dayBefore(i.transfer_date);
  if (i.instruction_sent_on && i.acked_on < i.instruction_sent_on) throw new RangeError(`acknowledgment ${i.acked_on} precedes the instruction sent ${i.instruction_sent_on}`);
  return { timer: "SM_LOSSMIT_HOLD_INSTRUCTIONS_T1", due, on_time: i.acked_on <= due, satisfied_by: "attorney.instruction.acked", before_transfer: i.acked_on < i.transfer_date };
}

// ============================================================ payoff requests received before T
/** SM_PAYOFF_REQUEST_OPEN_7BD (16.1; continues): a payoff request received before T is answered by a statement sent before T (`payoff.statement.sent`), or forwarded within 1 BD with its receipt date and the requester told of the transferee (7.x) — the deadline table then exports the 7-BD clock to the transferee. */
export function payoffRequestHandoff(i: { received_on: PlainDate; transfer_date: PlainDate; statement_sent_on?: PlainDate | null; forwarded_on?: PlainDate | null; requester_told_on?: PlainDate | null; today?: PlainDate | null }): { timer: "SM_PAYOFF_REQUEST_OPEN_7BD"; due: PlainDate; forward_by: PlainDate; outcome: "statement_sent" | "forwarded_to_transferee" | "open"; satisfied_by: "payoff.statement.sent" | null; exported_to_transferee: boolean; owner_after_transfer: OwnerAfterTransfer; on_time: boolean | null; refusal: string | null; breach: Escalation | null } {
  const T = i.transfer_date; const due = addBusinessDays(i.received_on, 7, servicer); const forwardBy = addBusinessDays(i.received_on, 1, servicer);
  const base = { timer: "SM_PAYOFF_REQUEST_OPEN_7BD" as const, due, forward_by: forwardBy };
  if (i.received_on >= T) return { ...base, outcome: "open", satisfied_by: null, exported_to_transferee: false, owner_after_transfer: "transferee", on_time: null, refusal: `payoff request received ${i.received_on} on or after T: not Supermortgage's — forward as post-transfer correspondence`, breach: null };
  const sent = i.statement_sent_on ?? null; const fwd = i.forwarded_on ?? null; const told = i.requester_told_on ?? null;
  if (sent !== null && sent >= T) return { ...base, outcome: "open", satisfied_by: null, exported_to_transferee: false, owner_after_transfer: due >= T ? "transferee" : "supermortgage", on_time: null, refusal: `nothing issues on or after ${T} on a transferred loan: the statement of ${sent} cannot be Supermortgage's`, breach: null };
  if (sent !== null) return { ...base, outcome: "statement_sent", satisfied_by: "payoff.statement.sent", exported_to_transferee: false, owner_after_transfer: "supermortgage", on_time: sent <= due, refusal: null, breach: sent > due ? { kind: "officer", severity: "sev1", reason: `SM_PAYOFF_REQUEST_OPEN_7BD breached: statement sent ${sent} after ${due}` } : null };
  if (fwd !== null) {
    const onTime = fwd <= forwardBy && told !== null;
    return { ...base, outcome: "forwarded_to_transferee", satisfied_by: null, exported_to_transferee: true, owner_after_transfer: "transferee", on_time: onTime, refusal: null, breach: onTime ? null : { kind: "officer", severity: "sev1", reason: told === null ? `payoff request forwarded ${fwd} without telling the requester of the transferee (7.x)` : `payoff request received ${i.received_on} forwarded ${fwd} after ${forwardBy} — the receipt date still governs the transferee's clock` } };
  }
  const today = i.today ?? null;
  return { ...base, outcome: "open", satisfied_by: null, exported_to_transferee: false, owner_after_transfer: due >= T ? "transferee" : "supermortgage", on_time: null, refusal: null, breach: today !== null && today > due ? { kind: "officer", severity: "sev1", reason: `SM_PAYOFF_REQUEST_OPEN_7BD breached: no statement by ${due}` } : null };
}

// ============================================================ escalations the spec names
/** `licensed_specialist` where a pre-T negotiation is MLO activity: terms negotiated with the borrower (rate, term, payment) rather than program-computed. */
export function negotiationIsMloActivity(i: { outcome: DeterminationOutcome; terms_negotiated?: boolean }): boolean { return i.outcome === "offer" && i.terms_negotiated === true; }
/** `human_agent` on borrower request — opened alongside the action, never instead of the forwarding duty. */
export function borrowerRequestsHuman(i: { borrower_requests_human?: boolean }): Escalation | null { return i.borrower_requests_human === true ? { kind: "human_agent", reason: "borrower asked for a person (17.4 escalations: human_agent on borrower request)" } : null; }
