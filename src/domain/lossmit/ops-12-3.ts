/**
 * §12.3 operating rules over the pure calculators in evaluation.ts / ops.ts — the event-emitting steps of the appeal
 * lifecycle (`lossmit_appeals.status`: received → eligibility_checked → ineligible | under_review → decided_* →
 * notice_provided → awaiting_response → accepted | deemed_rejected) that the 12.3 timer rows (timers-12-3.ts) are armed
 * and satisfied by. Every function validates its inbound record and returns the events to append; the handler in
 * src/app/tools/section12-3.ts (reached through the 12.2 `lossmit.evaluation.*` tool — 12.3 registers no tool of its
 * own) appends them, so nothing here touches the store or the clock.
 *   - receipt: eligibility (rule 1: tier ge_90 or no first filing, and a denied trial/permanent modification; rule 3:
 *     late → `ineligible{late}`), the `lm_appeal_pending` hold opened on receipt (rule 8), the (e)(2)(iii) suspension of a
 *     pending original offer, the E-3.4-01 counsel instruction on a loan in foreclosure, the (k)(4) later-of decision
 *     anchor for an appeal inherited at transfer (`lossmit.appeal.received`)
 *   - reviewer assignment behind the independence gate (rule 4; §1024.41(h)(3)) — accepted → `lossmit.appeal.reviewer_assigned`,
 *     refused → `lossmit.appeal.assignment_refused{reason}` (the logged reason of 12.3-T2)
 *   - new information during the appeal (D2-2-07 options 1/2; rule 3) → `lossmit.appeal.new_information.reviewed`
 *   - the human determination provided with the (h)(4) notice → `lossmit.appeal.decided{outcome, provided_at, accept_by,
 *     tpp_first_due_date, original_offer_pending, state}` (rule 6: accept_by = provided_at + 14; the 15th rule; CA 15-day tail)
 *   - hold release only on reviewer confirmation for an ineligible appeal (12.3-T3) → `foreclosure_holds.closed{kind=lm_appeal_pending}`
 *   - NY postmark evidence from the print/mail vendor → `lossmit.denial.postmarked{state, postmark_on}` (3 NYCRR 419.7(h))
 *   - breach of the 30-day clock → officer sev-1, borrower status notice, holds maintained (12.3-T10).
 * Dates are PlainDate; money never enters this process (offer terms come from 12.2/12.8).
 */
import { type PlainDate, addDays, max } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { appealEligible, appealWindow, appealDeadlines, tppFirstDue, tier, type Tier } from "./evaluation.ts";
import { assignAppealReviewer, appealExtendsAcceptance, appealDecisionBreach } from "./ops.ts";

export interface EmittedEvent { readonly type: string; readonly payload: Record<string, unknown>; }

export type AppealChannel = "written" | "portal" | "email" | "fax" | "mail" | "oral";
export type IneligibilityReason = "tier_lt_90_after_filing" | "non_modification_option" | "late" | "duplicative_prior_complete" | "not_principal_residence_fnma";
export type AppealDecision = "granted_new_offer" | "granted_original_offer_reinstated" | "denied";
export type AppealStatus = "received" | "eligibility_checked" | "ineligible" | "under_review" | "decided_granted" | "decided_denied" | "notice_provided" | "awaiting_response" | "accepted" | "deemed_rejected" | "closed";
export const APPEAL_CHANNELS: readonly AppealChannel[] = ["written", "portal", "email", "fax", "mail", "oral"];
export const HOLD_KIND = "lm_appeal_pending" as const;
export const COUNSEL_INSTRUCTION = "appeal pending — do not move for judgment/sale (Fannie Mae E-3.4-01; §1024.41(g))";

// ============================================================ receipt (rules 1–3, 8; §1024.41(h)(1)–(2), (k)(4); D2-2-07)
export interface AppealReceipt {
  readonly appeal_id: string; readonly application_id: string; readonly evaluation_id: string;
  readonly denial_notice_id?: string | null;
  /** Date the (c)(1)(ii) denial was provided; NY anchors the window on the postmark when the mailing proof carries one. */
  readonly denial_provided_on: PlainDate; readonly postmark_on?: PlainDate | null; readonly state?: string | null;
  readonly received_on: PlainDate; readonly received_at?: string | null; readonly channel: string;
  /** Loan facts at receipt (rule 1). */
  readonly complete_on: PlainDate; readonly sale_on: PlainDate | null; readonly first_filing_made: boolean; readonly denied_modification: boolean;
  readonly principal_residence?: boolean | null; readonly prior_complete_brp_continuously_delinquent?: boolean;
  /** A prior (h)(4) determination on the same evaluation — no further appeal (§1024.41(h)(4)). */
  readonly prior_appeal_decided?: boolean;
  readonly in_foreclosure: boolean;
  /** A pending original offer (12.2) whose acceptance deadline (e)(2)(iii) extends. */
  readonly original_offer?: { readonly offer_id: string; readonly accept_by: PlainDate; readonly option?: string | null } | null;
  /** Transfer-in with a pending appeal (§1024.41(k)(4); 1.7): decision due 30 days after the later of transfer and appeal. */
  readonly transfer_date?: PlainDate | null;
  readonly new_information_doc_ids?: readonly string[];
}
export interface AppealReceiptResult {
  readonly appeal_id: string; readonly status: AppealStatus; readonly eligible: boolean; readonly ineligibility_reason: IneligibilityReason | null;
  readonly tier: Tier; readonly appeal_window_ends: PlainDate; readonly late: boolean;
  readonly decision_due: PlainDate; readonly decision_anchor_date: PlainDate; readonly assign_reviewer_by: PlainDate;
  readonly court_delay_request_by: PlainDate | null; readonly written_confirmation_required: boolean;
  readonly fnma_d2207_variance: string | null; readonly notice: "NTC_REGX_41H_APPEAL_ACK" | "NTC_REGX_41H_APPEAL_INELIGIBLE";
  readonly hold_id: string; readonly original_offer_pending: boolean; readonly events: EmittedEvent[];
}
export function receiveAppeal(i: AppealReceipt): AppealReceiptResult {
  for (const k of ["appeal_id", "application_id", "evaluation_id", "channel"] as const) if (!i[k]) throw new RangeError(`${k} is required`);
  if (!APPEAL_CHANNELS.includes(i.channel as AppealChannel)) throw new RangeError(`channel ${i.channel} is not one of ${APPEAL_CHANNELS.join("/")}`);
  if (i.received_on < i.denial_provided_on) throw new RangeError(`appeal received ${i.received_on} before the denial was provided ${i.denial_provided_on}`);
  if (i.prior_appeal_decided) throw new RangeError("the appeal determination is not subject to further appeal (§1024.41(h)(4)); new information is an NoE candidate or a new application (rule 3)");
  const state = i.state ?? null;
  const windowEnds = appealWindow(i.denial_provided_on, state ?? undefined, i.postmark_on ?? undefined);
  const late = i.received_on > windowEnds;
  const t = tier(i.complete_on, i.sale_on);
  const regx = appealEligible(t, i.first_filing_made, i.denied_modification);
  const reason: IneligibilityReason | null = !i.denied_modification ? "non_modification_option" : !regx ? "tier_lt_90_after_filing" : late ? "late" : null;
  const eligible = reason === null;
  // Rule 1: Fannie Mae's principal-residence / prior-complete-BRP limits do not narrow Reg X — the appeal is granted and the D2-2-07 variance is reported.
  const variance = eligible && i.principal_residence === false ? "not_principal_residence_fnma" : eligible && i.prior_complete_brp_continuously_delinquent ? "duplicative_prior_complete" : null;
  const dl = appealDeadlines(i.received_on, undefined, i.transfer_date ?? undefined);
  const anchor = i.transfer_date ? max(i.received_on, i.transfer_date) : i.received_on;
  const assignBy = addBusinessDays(i.received_on, 1, servicer);
  const courtBy = i.in_foreclosure ? addBusinessDays(i.received_on, 1, servicer) : null;
  const holdId = `hold-${i.appeal_id}-${HOLD_KIND}`;
  const offerPending = !!i.original_offer;
  const events: EmittedEvent[] = [];
  events.push({ type: "lossmit.appeal.received", payload: {
    appeal_id: i.appeal_id, application_id: i.application_id, evaluation_id: i.evaluation_id, denial_notice_id: i.denial_notice_id ?? null,
    received_date: i.received_on, received_at: i.received_at ?? null, channel: i.channel, written_confirmation_required: i.channel === "oral",
    eligible, ineligibility_reason: reason, tier: t, first_filing_made: i.first_filing_made, sale_on: i.sale_on, denied_modification: i.denied_modification,
    appeal_window_ends: windowEnds, late, state, decision_due: dl.decision_due, decision_anchor_date: anchor, transfer_date: i.transfer_date ?? null, k4_anchor_date: i.transfer_date ? anchor : null,
    original_offer_pending: offerPending, original_offer_id: i.original_offer?.offer_id ?? null, in_foreclosure: i.in_foreclosure,
    fnma_d2207_variance: variance, new_information: (i.new_information_doc_ids?.length ?? 0) > 0, new_information_doc_ids: [...(i.new_information_doc_ids ?? [])], hold_id: holdId } });
  // Rule 8: the hold opens on receipt, even before eligibility is confirmed.
  events.push({ type: "foreclosure_holds.opened", payload: { kind: HOLD_KIND, hold_id: holdId, appeal_id: i.appeal_id, reason: "appeal received (§1024.41(g)(1)/(f)(2)(i); 12.3 rule 8)" } });
  if (i.channel === "oral") events.push({ type: "lossmit.appeal.written_confirmation_requested", payload: { appeal_id: i.appeal_id, appeal_date: i.received_on, basis: "D2-2-07 requires a written appeal; the oral date is the appeal date (12.3 open question 1)" } });
  // §1024.41(e)(2)(iii): the original offer stays open until 14 days after the (h)(4) notice — its own clock is suspended at receipt.
  if (eligible && i.original_offer) events.push({ type: "lossmit.offer.accept_by.extended", payload: { offer_id: i.original_offer.offer_id, option: i.original_offer.option ?? null, appeal_id: i.appeal_id, previous_accept_by: i.original_offer.accept_by, accept_by: null, accept_by_basis: "e2iii_extension", pending: "14 days after the appeal determination notice (§1024.41(e)(2)(iii))" } });
  // E-3.4-01: while the appeal is pending, counsel is instructed to request that the court delay the next legal action.
  if (i.in_foreclosure) events.push({ type: "attorney.instruction.sent", payload: { instruction_id: `ai-${i.appeal_id}-court-delay`, kind: "appeal_pending_delay", appeal_id: i.appeal_id, instruction: COUNSEL_INSTRUCTION, due_by: courtBy, ack_required: true } });
  return { appeal_id: i.appeal_id, status: eligible ? "under_review" : "ineligible", eligible, ineligibility_reason: reason, tier: t, appeal_window_ends: windowEnds, late, decision_due: dl.decision_due, decision_anchor_date: anchor, assign_reviewer_by: assignBy,
    court_delay_request_by: courtBy, written_confirmation_required: i.channel === "oral", fnma_d2207_variance: variance, notice: eligible ? "NTC_REGX_41H_APPEAL_ACK" : "NTC_REGX_41H_APPEAL_INELIGIBLE", hold_id: holdId, original_offer_pending: eligible && offerPending, events };
}

// ============================================================ reviewer assignment behind the independence gate (rule 4; §1024.41(h)(3); comment 41(h)(3)-1)
export interface ReviewerAssignment {
  readonly appeal_id: string; readonly candidate_id: string; readonly candidate_role: string;
  /** The original evaluation's personnel: the evaluator run's accountable human, the approving reviewer, anyone who edited reason codes, a directly involved supervisor. */
  readonly evaluator_id: string; readonly approver_id?: string | null; readonly reason_code_editor_ids?: readonly string[]; readonly directly_involved_supervisor_ids?: readonly string[];
  readonly evaluator_run_id?: string | null; readonly appeal_run_id?: string | null; readonly assigned_on: PlainDate;
}
export function excludedIds(i: Pick<ReviewerAssignment, "evaluator_id" | "approver_id" | "reason_code_editor_ids" | "directly_involved_supervisor_ids">): string[] {
  return [...new Set([i.evaluator_id, ...(i.approver_id ? [i.approver_id] : []), ...(i.reason_code_editor_ids ?? []), ...(i.directly_involved_supervisor_ids ?? [])])];
}
export function assignReviewer(i: ReviewerAssignment): { accepted: boolean; reason: string; excluded_ids: string[]; events: EmittedEvent[] } {
  if (!i.appeal_id || !i.candidate_id || !i.evaluator_id) throw new RangeError("appeal_id, candidate_id and evaluator_id are required");
  const excluded = excludedIds(i);
  const base = assignAppealReviewer({ candidate_id: i.candidate_id, evaluator_id: i.evaluator_id, approver_id: i.approver_id ?? null, candidate_role: i.candidate_role });
  const editor = (i.reason_code_editor_ids ?? []).includes(i.candidate_id), supervisor = (i.directly_involved_supervisor_ids ?? []).includes(i.candidate_id);
  const accepted = base.accepted && !editor && !supervisor;
  const reason = accepted ? base.reason : !base.accepted ? base.reason : editor ? `${i.candidate_id} edited the reason codes of the original evaluation — appeal review must be independent (§1024.41(h)(3); 12.3 rule 4)` : `${i.candidate_id} supervised and was directly involved in the original evaluation (comment 41(h)(3)-1)`;
  const reviewerRun = i.appeal_run_id ?? `run-appeal-${i.appeal_id}`;
  const facts = { appeal_id: i.appeal_id, reviewer_id: i.candidate_id, reviewer_role: i.candidate_role, evaluator_id: i.evaluator_id, excluded_ids: excluded, reviewer_run_id: reviewerRun, evaluator_run_id: i.evaluator_run_id ?? null, prompt_version: "appeal" };
  const events: EmittedEvent[] = accepted
    ? [{ type: "lossmit.appeal.reviewer_assigned", payload: { ...facts, assigned_on: i.assigned_on, independence_check: { excluded_ids: excluded, result: "passed", reason } } }]
    : [{ type: "lossmit.appeal.assignment_refused", payload: { ...facts, candidate_id: i.candidate_id, refused_on: i.assigned_on, reason, independence_check: { excluded_ids: excluded, result: "failed", reason } } }];
  return { accepted, reason, excluded_ids: excluded, events };
}

// ============================================================ new information (rule 3; D2-2-07 options 1–3)
export interface NewInformation { readonly appeal_id: string; readonly doc_ids: readonly string[]; readonly received_on: PlainDate; readonly appeal_window_ends: PlainDate; readonly eligible: boolean; readonly decided: boolean; readonly asserts_error?: boolean; readonly borrower_current_since_prior_complete?: boolean; }
export type NewInformationRoute = "appeal_reevaluation" | "noe_candidate" | "new_complete_application" | "discretionary_reevaluation";
export function newInformation(i: NewInformation): { route: NewInformationRoute; as: "new_information"; events: EmittedEvent[] } {
  if (!i.doc_ids.length) throw new RangeError("doc_ids is required: at least one document");
  const route: NewInformationRoute = i.eligible && !i.decided ? "appeal_reevaluation" : i.asserts_error ? "noe_candidate" : i.borrower_current_since_prior_complete ? "new_complete_application" : "discretionary_reevaluation";
  const within = i.received_on <= i.appeal_window_ends;
  return { route, as: "new_information", events: [{ type: "lossmit.appeal.new_information.reviewed", payload: { appeal_id: i.appeal_id, doc_ids: [...i.doc_ids], received_on: i.received_on, within_appeal_window: within, during_appeal: !i.decided, as: "new_information", route, fnma_option: i.eligible && !i.decided ? (within ? 1 : 2) : 3 } }] };
}

// ============================================================ determination provided (rules 5–7; §1024.41(h)(4), (e)(2)(iii); D2-2-07 TPP timing)
export interface AppealDetermination {
  readonly appeal_id: string; readonly evaluation_id: string; readonly reviewer_id: string; readonly assigned_reviewer_id: string | null;
  readonly decision: AppealDecision; readonly decided_on: PlainDate; readonly provided_on: PlainDate; readonly notice_id: string;
  readonly state?: string | null; readonly tpp: boolean; readonly original_offer?: { readonly offer_id: string; readonly accept_by: PlainDate; readonly option?: string | null } | null;
  readonly ai_reeval_run_id?: string | null; readonly human_edits?: readonly string[];
}
export interface AppealDeterminationResult {
  readonly outcome: "granted" | "denied"; readonly status: AppealStatus; readonly accept_by: PlainDate | null; readonly tpp_first_due: PlainDate | null;
  readonly original_offer_accept_by: PlainDate | null; readonly ca_no_nod_nos_before: PlainDate | null; readonly template: "NTC_REGX_41H4_APPEAL_GRANTED" | "NTC_REGX_41H4_APPEAL_DENIED"; readonly events: EmittedEvent[];
}
export const appealTemplate = (decision: AppealDecision): AppealDeterminationResult["template"] => (decision === "denied" ? "NTC_REGX_41H4_APPEAL_DENIED" : "NTC_REGX_41H4_APPEAL_GRANTED");
export function decideAppeal(i: AppealDetermination): AppealDeterminationResult {
  if (!i.appeal_id || !i.reviewer_id || !i.notice_id) throw new RangeError("appeal_id, reviewer_id and notice_id are required");
  if (!i.assigned_reviewer_id) throw new RangeError("no independent reviewer assigned — the determination is signed by the human lossmit_reviewer (§1024.41(h)(3); SM_APPEAL_INDEPENDENCE_GATE)");
  if (i.reviewer_id !== i.assigned_reviewer_id) throw new RangeError(`${i.reviewer_id} is not the assigned independent reviewer ${i.assigned_reviewer_id} (§1024.41(h)(3))`);
  if (!["granted_new_offer", "granted_original_offer_reinstated", "denied"].includes(i.decision)) throw new RangeError(`decision ${String(i.decision)} is not granted_new_offer / granted_original_offer_reinstated / denied`);
  if (i.provided_on < i.decided_on) throw new RangeError(`notice provided ${i.provided_on} before the decision ${i.decided_on}`);
  const outcome = i.decision === "denied" ? "denied" : "granted";
  const acceptBy = outcome === "granted" ? addDays(i.provided_on, 14) : null;
  const tppFirst = outcome === "granted" && i.tpp ? tppFirstDue(i.provided_on) : null;
  const orig = i.original_offer ? appealExtendsAcceptance({ original_accept_by: i.original_offer.accept_by, appeal_filed_on: i.decided_on, appeal_notice_provided_on: i.provided_on }) : null;
  const caTail = i.state === "CA" && outcome === "denied" ? addDays(i.provided_on, 15) : null;
  const events: EmittedEvent[] = [{ type: "lossmit.appeal.decided", payload: {
    appeal_id: i.appeal_id, evaluation_id: i.evaluation_id, outcome, decision: i.decision, reviewer_id: i.reviewer_id, decided_on: i.decided_on, provided_at: i.provided_on, notice_id: i.notice_id, template: appealTemplate(i.decision),
    state: i.state ?? null, tpp: outcome === "granted" && i.tpp, tpp_first_due_date: tppFirst, accept_by: acceptBy, acceptance_days: 14,
    original_offer_pending: !!i.original_offer, original_offer_id: i.original_offer?.offer_id ?? null, original_offer_accept_by: orig?.accept_by ?? null,
    ca_no_nod_nos_before: caTail, no_further_appeal: true, ai_reeval_run_id: i.ai_reeval_run_id ?? null, human_edits: [...(i.human_edits ?? [])] } }];
  if (i.original_offer && orig) events.push({ type: "lossmit.offer.accept_by.extended", payload: { offer_id: i.original_offer.offer_id, option: i.original_offer.option ?? null, appeal_id: i.appeal_id, previous_accept_by: i.original_offer.accept_by, accept_by: orig.accept_by, extended: orig.extended, accept_by_basis: "e2iii_extension", timer: orig.timer } });
  return { outcome, status: outcome === "granted" ? "awaiting_response" : "notice_provided", accept_by: acceptBy, tpp_first_due: tppFirst, original_offer_accept_by: orig?.accept_by ?? null, ca_no_nod_nos_before: caTail, template: appealTemplate(i.decision), events };
}

// ============================================================ hold release (rule 8; 12.3-T3 "released only after reviewer confirmation")
export type HoldReleaseReason = "ineligible" | "denied" | "accepted" | "deemed_rejected" | "window_lapsed";
export function releaseAppealHold(i: { appeal_id: string; hold_id: string; reason: HoldReleaseReason; eligible: boolean; reviewer_confirmation?: { reviewer_id: string; confirmed_on: PlainDate } | null; ca_ny_tail_lapsed?: boolean; state?: string | null }): { released: boolean; events: EmittedEvent[] } {
  if (!i.hold_id) throw new RangeError("hold_id is required");
  if (i.reason === "ineligible" && !i.reviewer_confirmation) throw new RangeError("holds on an ineligible appeal release only after the reviewer confirms ineligibility (12.3 rule 8; 12.3-T3)");
  if (i.reason === "denied" && (i.state === "CA" || i.state === "NY") && !i.ca_ny_tail_lapsed) throw new RangeError(`the ${i.state} post-appeal tail has not lapsed (Cal. Civ. Code §2923.6(e) 15 days / 3 NYCRR 419.7(h))`);
  return { released: true, events: [{ type: "foreclosure_holds.closed", payload: { kind: HOLD_KIND, hold_id: i.hold_id, appeal_id: i.appeal_id, reason: i.reason, reviewer_id: i.reviewer_confirmation?.reviewer_id ?? null, confirmed_on: i.reviewer_confirmation?.confirmed_on ?? null } }] };
}

// ============================================================ NY postmark evidence (3 NYCRR 419.7(h); Integrations: "postmark evidence retained for NY")
export function denialPostmarked(i: { notice_id: string; evaluation_id?: string | null; state: string | null; printed_on: PlainDate; postmark_on: PlainDate; mailing_proof_document_id?: string | null }): { appeal_window_ends: PlainDate; events: EmittedEvent[] } {
  if (!i.notice_id) throw new RangeError("notice_id is required");
  if (i.postmark_on < i.printed_on) throw new RangeError(`postmark ${i.postmark_on} precedes the print date ${i.printed_on}`);
  const ends = appealWindow(i.printed_on, i.state ?? undefined, i.postmark_on);
  return { appeal_window_ends: ends, events: [{ type: "lossmit.denial.postmarked", payload: { notice_id: i.notice_id, evaluation_id: i.evaluation_id ?? null, state: i.state, printed_on: i.printed_on, postmark_on: i.postmark_on, appeal_window_ends: ends, mailing_proof_document_id: i.mailing_proof_document_id ?? null } }] };
}

// ============================================================ CA post-appeal NOD/NOS gate (Cal. Civ. Code §2923.6(e); 12.3-T6)
export function caPostAppealNod(i: { appeal_denial_provided_on: PlainDate; nod_requested_on: PlainDate }): { timer: "CA_CIV_2923_6E_POST_APPEAL_HOLD_15"; no_nod_before: PlainDate; nod_allowed: boolean; refusal: string | null } {
  const until = addDays(i.appeal_denial_provided_on, 15); const allowed = i.nod_requested_on >= until;
  return { timer: "CA_CIV_2923_6E_POST_APPEAL_HOLD_15", no_nod_before: until, nod_allowed: allowed, refusal: allowed ? null : `NOD/NOS refused: CA_CIV_2923_6E_POST_APPEAL_HOLD_15 holds until ${until} (15 days after the appeal denial; Cal. Civ. Code §2923.6(e))` };
}

// ============================================================ breach of the 30-day clock (12.3-T10; §1024.41(h)(4))
export function appealBreach(i: { appeal_id: string; appeal_received_on: PlainDate; decision_anchor_date?: PlainDate | null; decided_on: PlainDate | null; today: PlainDate; timer_id?: string | null; code?: string }): { decision_due: PlainDate; breached: boolean; escalation: { kind: "officer"; severity: "sev1"; reason: string } | null; borrower_status_notice: boolean; holds_maintained: boolean; events: EmittedEvent[] } {
  const b = appealDecisionBreach({ appeal_received_on: i.decision_anchor_date ?? i.appeal_received_on, decided_on: i.decided_on, today: i.today });
  const events: EmittedEvent[] = b.breached ? [{ type: "lossmit.appeal.breach.handled", payload: { appeal_id: i.appeal_id, code: i.code ?? "REGX_1024_41H4_APPEAL_DECIDE_30", timer_id: i.timer_id ?? null, decision_due: b.decision_due, escalation: "officer", severity: "sev1", borrower_status_notice: true, holds_maintained: true, hold_kind: HOLD_KIND } }] : [];
  return { decision_due: b.decision_due, breached: b.breached, escalation: b.escalation ? { kind: "officer", severity: "sev1", reason: b.escalation.reason } : null, borrower_status_notice: b.borrower_status_notice, holds_maintained: b.holds_maintained, events };
}
