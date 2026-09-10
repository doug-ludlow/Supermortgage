/**
 * §12 operating rules that sit between the pure calculators (application,
 * evaluation, plans, deferral, flexmod, liquidation) and the tool bus: the
 * facial-completion / RFA / AI-outage / NPRM paths of 12.1, the denial,
 * third-party-delay, appeal, CA and counsel rules of 12.2–12.3, the plan
 * lifecycles of 12.4–12.5, the deferral structures and clocks of 12.6–12.7,
 * the Flex Mod document/ledger/incentive rules of 12.8 and the liquidation
 * routing, settlement and hold rules of 12.9. Every function is pure and
 * returns the record the command handler persists or the refusal it raises.
 */
import { type PlainDate, addDays, addMonths, daysBetween, endOfMonth, parts, ymd } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal, servicer, fannieEt, type Calendar } from "../../kernel/calendar/business.ts";
import type { Ledger, AccountRef, EntrySet } from "../../kernel/ledger/ledger.ts";
import type { EventInput, Actor } from "../../kernel/events/types.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { ackDue, supplementalRequestDate, classify } from "./application.ts";
import { appealEligible, independent, tier, deemedRejectionGraceDays, rankingReasonAllowed, type Option } from "./evaluation.ts";
import { repaymentTerms, solicitationDue, regxShortTermForbearance, preExpiryOutreachStart } from "./plans.ts";
import { nib as deferralNib } from "./deferral.ts";
import { waterfall, type WaterfallInputs } from "./flexmod.ts";
import { shortSaleClocks, leaseOption } from "./liquidation.ts";

export interface Hold { readonly kind: string; readonly from: PlainDate; readonly to: PlainDate | null; readonly active: boolean; }
export interface Escalation { readonly kind: "officer" | "lossmit_reviewer" | "attorney" | "human_portal_task" | "fraud_officer" | "signing_officer"; readonly severity?: "sev1" | "sev2" | "sev3" | "sev4"; readonly reason: string; readonly at_ms?: number; }
const hold = (kind: string, from: PlainDate, to: PlainDate | null = null): Hold => ({ kind, from, to, active: true });
const pctOf = (n: Cents, d: Cents): string => Decimal.ratio(n * 100n, d).toFixed(2);

// ============================================================ 12.1 applications
export interface FacialCompletionInput { readonly required_items: readonly string[]; readonly received: readonly { item: string; on: PlainDate }[]; readonly verification?: { stale_item: string; found_on: PlainDate } | null; readonly borrower_complied_on?: PlainDate | null; }
/** Rule 12.1: facial completion → verification → supplemental request (≥7 days) → deemed-complete date is the facial date. */
export function facialCompletion(i: FacialCompletionInput): { facially_complete_at: PlainDate | null; supplemental_request: { on: PlainDate; respond_by: PlainDate } | null; holds: Hold[]; deemed_complete_date: PlainDate | null; complete_at: PlainDate | null; c3_notice_by: PlainDate | null } {
  const got = new Map(i.received.map((r) => [r.item, r.on]));
  const missing = i.required_items.filter((it) => !got.has(it));
  if (missing.length) return { facially_complete_at: null, supplemental_request: null, holds: [], deemed_complete_date: null, complete_at: null, c3_notice_by: null };
  const facial = i.required_items.map((it) => got.get(it)!).reduce((a, b) => (b > a ? b : a));
  const holds = [hold("regx_f2_prefiling", facial)];
  if (!i.verification) return { facially_complete_at: facial, supplemental_request: null, holds, deemed_complete_date: facial, complete_at: facial, c3_notice_by: addBusinessDays(facial, 5, federal) };
  const reqOn = i.verification.found_on; const respondBy = supplementalRequestDate(reqOn);   // ≥7 days from the request (§1024.41(c)(2)(iv))
  const complied = i.borrower_complied_on ?? null;
  const completeAt = complied && complied <= respondBy ? complied : null;
  return { facially_complete_at: facial, supplemental_request: { on: reqOn, respond_by: respondBy }, holds, deemed_complete_date: completeAt ? facial : null, complete_at: completeAt, c3_notice_by: completeAt ? addBusinessDays(completeAt, 5, federal) : null };
}

/** Rule 12.1: an inquiry with no evaluative information is an RFA only — no ack clock; CA gets the SPOC assignment and the solicitation package. */
export function rfaFlow(i: { utterance: string; has_evaluative_info: boolean; confidence: number; state: string; later?: { utterance: string; has_evaluative_info: boolean; on: PlainDate } | null }): { kind: "rfa_only" | "application"; ack_timer: string | null; spoc_assignment: boolean; solicitation_package_sent: boolean; application_opened_on: PlainDate | null } {
  const kind = classify({ has_evaluative_info: i.has_evaluative_info, confidence: i.confidence });
  const later = i.later && classify({ has_evaluative_info: i.later.has_evaluative_info, confidence: 1 }) === "application" ? i.later.on : null;
  return { kind, ack_timer: kind === "application" ? "REGX_1024_41B2_LM_ACK_5" : null, spoc_assignment: i.state === "CA", solicitation_package_sent: kind === "rfa_only", application_opened_on: kind === "application" ? null : later };
}
/** The acknowledgment clocks an application arms (12.1 timer table): the Reg X federal-business-day clock and Fannie Mae's servicer-business-day twin. */
export const ACK_TIMER_CODES = ["REGX_1024_41B2_LM_ACK_5", "FNMA_D2205_BRP_ACK_5BD"] as const;

/** Rule 12.1 §1024.41(i): a duplicative application removes the procedural rights, so the determination is reviewer-approved; Fannie Mae's evaluation still runs; no (b)(2)/(c)(3) clocks; a courtesy notice goes out. */
export function duplicativeDetermination(i: { received_on: PlainDate; prior_complete_on: PlainDate; prior_fully_processed_by_us: boolean; current_since_prior: boolean; reviewer_approval_id?: string | null }): { duplicative: boolean; reviewer_required: boolean; refusal: string | null; fnma_evaluation_required: true; timers_started: readonly string[]; courtesy_notice: "NTC_REGX_41I_DUPLICATIVE" | null } {
  const dup = i.prior_fully_processed_by_us && !i.current_since_prior;
  if (!dup) return { duplicative: false, reviewer_required: false, refusal: null, fnma_evaluation_required: true, timers_started: [...ACK_TIMER_CODES, "REGX_1024_41C3_COMPLETE_NOTICE_5"], courtesy_notice: null };
  const approved = Boolean(i.reviewer_approval_id);
  return { duplicative: true, reviewer_required: true, refusal: approved ? null : "duplicative determination refused: lossmit_reviewer approval required before §1024.41 rights are removed (12.1 rule 8)", fnma_evaluation_required: true, timers_started: [], courtesy_notice: approved ? "NTC_REGX_41I_DUPLICATIVE" : null };
}

/** Rule 12.1: document-AI outage → human checklist task; the ack clock does not move. */
export function aiOutageFallback(i: { received_on: PlainDate; outage_started_on: PlainDate; outage_days: number }): { human_checklist_task: true; determination_on: PlainDate; ack_due_on: PlainDate; ack_on_time: boolean; incident: { kind: "ai_outage"; days: number; logged: true } } {
  const determination = addDays(i.outage_started_on, i.outage_days); const due = ackDue(i.received_on).due_on;
  return { human_checklist_task: true, determination_on: determination, ack_due_on: due, ack_on_time: determination <= due, incident: { kind: "ai_outage", days: i.outage_days, logged: true } };
}

/**
 * Rule 12.1 (CA §2924.10): every document submission is acknowledged within 5 business days. The registry row
 * (`CA_CIV_2924_10_ACK_5BD`) names a `state:CA` calendar the kernel does not yet define (business.ts `DAY_UNITS`),
 * so the count runs on the servicer calendar unless the caller passes one; the calendar used is reported.
 */
export function caPerDocumentAcks(state: string, uploads: readonly PlainDate[], calendar: Calendar = servicer): { upload_on: PlainDate; ack_by: PlainDate; code: "NTC_CA_2924_10_ACK"; calendar: string }[] {
  if (state !== "CA") return [];
  return uploads.map((u) => ({ upload_on: u, ack_by: addBusinessDays(u, 5, calendar), code: "NTC_CA_2924_10_ACK" as const, calendar: calendar.unit }));
}

/** Rule 12.1: under the 2024 NPRM regime an RFA opens a review cycle with its own hold; under the 2013 rule it does not. */
export function nprmRfa(i: { regime: "2024nprm" | "2013"; rfa_on: PlainDate; sale_on: PlainDate | null; oral: boolean }): { review_cycle_opened: boolean; hold: Hold | null; notice: "NTC_REGX_41_NPRM_RFA_RECEIVED" | null; days_before_sale: number | null } {
  const days = i.sale_on ? daysBetween(i.rfa_on, i.sale_on) : null;
  if (i.regime !== "2024nprm") return { review_cycle_opened: false, hold: null, notice: null, days_before_sale: days };
  // 12.1 rule 10: the review-cycle hold attaches only when the RFA arrives more than 37 days before a scheduled sale (no sale = attaches).
  const holdApplies = days === null || days > 37;
  return { review_cycle_opened: true, hold: holdApplies ? hold("lm_review_cycle", i.rfa_on) : null, notice: "NTC_REGX_41_NPRM_RFA_RECEIVED", days_before_sale: days };
}

/** Rule 12.1: ack missing at the day-5 deadline → officer sev-1 at 00:05 of day 6, re-send, NoE-risk flag. */
export function ackBreach(i: { received_on: PlainDate; produced: boolean; tz?: string }): { breached: boolean; escalation: Escalation | null; ack_resent: boolean; noe_risk_flag: boolean; day6: PlainDate } {
  const due = ackDue(i.received_on, i.tz ?? "America/New_York"); const day6 = addDays(due.due_on, 1);
  if (i.produced) return { breached: false, escalation: null, ack_resent: false, noe_risk_flag: false, day6 };
  return { breached: true, escalation: { kind: "officer", severity: "sev1", reason: "12.1 ack not produced by day 5", at_ms: zonedEpochMs(day6, "00:05", i.tz ?? "America/New_York") }, ack_resent: true, noe_risk_flag: true, day6 };
}

// ============================================================ 12.2 evaluation
/**
 * Rule 12.2 (§1024.41(d); comment 41(d)-1): a denial names the investor, quotes the specific criterion, says the other
 * criteria were not evaluated, may cite the hierarchy ranking only when the offered option outranks the denied one,
 * and cannot mail without reviewer approval. The content checks run against the *rendered* notice text (the
 * `NTC_REGX_41C1_DENIAL` template), never against a sentence this function composed itself.
 */
export function denialNoticeContent(i: { investor: string; option: string; criterion: string; reviewer_approval_id?: string | null; rendered_text?: string | null; ranking_reason?: { offered: Option; denied: Option } | null }): { required_statements: { investor: string; criterion: string; other_criteria: string }; names_investor: boolean | null; quotes_criterion: boolean | null; states_other_criteria: boolean | null; content_ok: boolean | null; ranking_reason_allowed: boolean | null; mailing_allowed: boolean; refusal: string | null } {
  const other = "not evaluated on any other criteria";
  const text = i.rendered_text ?? null;
  const names = text === null ? null : text.includes(i.investor);
  const quotes = text === null ? null : text.includes(i.criterion);
  const states = text === null ? null : new RegExp(other, "i").test(text);
  const contentOk = text === null ? null : Boolean(names && quotes && states);
  const ranking = i.ranking_reason ? rankingReasonAllowed(i.ranking_reason.offered, i.ranking_reason.denied) : null;
  const approved = Boolean(i.reviewer_approval_id);
  const refusal = !approved ? "lossmit_reviewer approval must be recorded before a denial is mailed (12.2 guardrail)"
    : ranking === false ? `ranking reason refused: ${i.ranking_reason!.offered} does not outrank ${i.ranking_reason!.denied} in the F-2-10 hierarchy (comment 41(d)-1)`
    : contentOk === false ? `denial content check failed: the rendered notice must name ${i.investor}, quote the criterion and state that other criteria were ${other} (§1024.41(d))` : null;
  return { required_statements: { investor: i.investor, criterion: i.criterion, other_criteria: other }, names_investor: names, quotes_criterion: quotes, states_other_criteria: states, content_ok: contentOk, ranking_reason_allowed: ranking, mailing_allowed: refusal === null, refusal };
}

/** Rule 12.2 §1024.41(e)(2)(i) / rule 7: no response by accept_by + policy grace → `deemed_rejected`; the offer hold releases only when nothing else is pending. */
export function deemedRejection(i: { accept_by: PlainDate; window_days: number; today: PlainDate; responded: boolean; other_pending_offer: boolean; appeal_pending: boolean }): { grace_days: 3 | 5; deemed_rejected_on: PlainDate; deemed_rejected: boolean; hold_released: boolean; hold_kind: "lm_offer_pending"; g2_satisfied: boolean } {
  const grace = deemedRejectionGraceDays(i.window_days); const on = addDays(i.accept_by, grace);
  const deemed = !i.responded && i.today >= on;
  const release = deemed && !i.other_pending_offer && !i.appeal_pending;
  return { grace_days: grace, deemed_rejected_on: on, deemed_rejected: deemed, hold_released: release, hold_kind: "lm_offer_pending", g2_satisfied: release };
}

/** Rule 12.2 NY (3 NYCRR 419.7(e)–(g)): tier ge_90 → 30 days to accept; an initial denial is reviewed by supervisory personnel not involved in the evaluation. */
export function nyOverlay(i: { provided_on: PlainDate; tier: "ge_90" | "lt_90" | "le_37"; denial: boolean; reviewer?: { id: string; supervisory: boolean; involved_in_evaluation: boolean } | null }): { accept_by: PlainDate; accept_by_basis: "ny_30" | "regx_7"; supervisory_review_required: boolean; supervisory_reviewer_recorded: boolean; refusal: string | null } {
  const accept = i.tier === "ge_90" ? addDays(i.provided_on, 30) : addDays(i.provided_on, 7);
  const r = i.reviewer ?? null; const ok = r !== null && r.supervisory && !r.involved_in_evaluation;
  return { accept_by: accept, accept_by_basis: i.tier === "ge_90" ? "ny_30" : "regx_7", supervisory_review_required: i.denial, supervisory_reviewer_recorded: i.denial && ok, refusal: i.denial && !ok ? "NY denial refused: supervisory personnel not involved in the evaluation must review the denial (3 NYCRR 419.7(f))" : null };
}

/** Rule 12.2 §1024.41(c)(4): third-party item outstanding at day 30 → delay notice + determinable results; determination within 5 days of receipt; hold throughout. */
export function thirdPartyDelay(i: { complete_on: PlainDate; item: string; received_on: PlainDate | null }): { day30: PlainDate; delay_notice_by: PlainDate; determinable_results_by: PlainDate; item_received_on: PlainDate | null; determination_by: PlainDate | null; hold: Hold; notice: "NTC_REGX_41C4IIB_THIRD_PARTY_DELAY" } {
  const day30 = addDays(i.complete_on, 30);
  return { day30, delay_notice_by: day30, determinable_results_by: day30, item_received_on: i.received_on, determination_by: i.received_on ? addDays(i.received_on, 5) : null, hold: hold("lm_third_party_pending", i.complete_on, i.received_on ? addDays(i.received_on, 5) : null), notice: "NTC_REGX_41C4IIB_THIRD_PARTY_DELAY" };
}

/** Rule 12.2: a current borrower declined in SMDU gets the Form 182 / Reg B notice within 30 days; an accepted counteroffer cancels the open clocks with a reason. */
export function imminentDefaultDecline(i: { complete_on: PlainDate; decided_on: PlainDate; notice_provided_on: PlainDate; counteroffer_accepted_on?: PlainDate | null }): { notice_code: "NTC_REGB_1002_9_LM_ADVERSE_ACTION"; form_basis: "Form 182"; notice_by: PlainDate; on_time: boolean; reg_b_timer: { code: "REGB_1002_9_ADVERSE_ACTION_30"; status: "satisfied" | "open" }; cancelled: { code: string; reason: string }[] } {
  const by = addDays(i.complete_on, 30);
  const cancelled = i.counteroffer_accepted_on ? ["REGX_1024_41E1_ACCEPT_7", "REGX_1024_41H2_APPEAL_WINDOW_14", "REGX_1024_41C1_EVALUATE_NOTIFY_30"].map((code) => ({ code, reason: `counteroffer accepted ${i.counteroffer_accepted_on}` })) : [];
  return { notice_code: "NTC_REGB_1002_9_LM_ADVERSE_ACTION", form_basis: "Form 182", notice_by: by, on_time: i.notice_provided_on <= by, reg_b_timer: { code: "REGB_1002_9_ADVERSE_ACTION_30", status: i.notice_provided_on <= by ? "satisfied" : "open" }, cancelled };
}

/** Rule 12.2/12.3 §1024.41(e)(2)(iii): an appeal extends a pending offer's accept-by to the appeal notice + 14. */
export function appealExtendsAcceptance(i: { original_accept_by: PlainDate; appeal_filed_on: PlainDate; appeal_notice_provided_on: PlainDate }): { accept_by: PlainDate; extended: boolean; timer: "REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED" } {
  const ext = addDays(i.appeal_notice_provided_on, 14);
  return { accept_by: ext > i.original_accept_by ? ext : i.original_accept_by, extended: ext > i.original_accept_by, timer: "REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED" };
}

/** Rule 12.2 (Cal. Civ. Code §2923.6): denial → 31-day NOD/NOS hold; NOD commands refused inside it; the notice shows the 30-day appeal window. */
export function caDenialHolds(i: { denial_provided_on: PlainDate; nod_requested_on: PlainDate }): { timer: "CA_CIV_2923_6E_NOD_NOS_HOLD_31"; hold_until: PlainDate; nod_allowed: boolean; refusal: string | null; appeal_window_days: 30; appeal_by: PlainDate } {
  const until = addDays(i.denial_provided_on, 31); const allowed = i.nod_requested_on >= until;
  return { timer: "CA_CIV_2923_6E_NOD_NOS_HOLD_31", hold_until: until, nod_allowed: allowed, refusal: allowed ? null : `NOD refused: CA_CIV_2923_6E_NOD_NOS_HOLD_31 holds until ${until} (Cal. Civ. Code §2923.6(e))`, appeal_window_days: 30, appeal_by: addDays(i.denial_provided_on, 30) };
}

/**
 * Rule 12.2 Integrations (SMDU failure): the portal fallback opens `human_portal_task{SMDU_UI}` only after 2 failed
 * submissions, or a B2B outage >4 hours with <7 days left on the 30-day clock; otherwise the B2B retry continues.
 * When it applies, the decision is recorded from the operator's SMDU result; the 30-day clock never moves.
 */
export type SmduFallbackBasis = "two_failed_submissions" | "outage_over_4h_within_7_days";
export function smduOutageEvaluation(i: { complete_on: PlainDate; outage_on: PlainDate; outage_hours: number; failed_submissions?: number; operator_result?: { decision: "approve" | "deny"; smdu_case_id: string; completed_on: PlainDate } | null; notice_provided_on?: PlainDate | null }): { day_of_outage: number; days_remaining: number; fallback: { applies: boolean; basis: SmduFallbackBasis | null }; portal_task: { kind: "human_portal_task"; package_attached: true; filed_on: PlainDate } | null; decision: { source: "operator_smdu_result"; decision: "approve" | "deny"; smdu_case_id: string } | null; notice_by: PlainDate; on_time: boolean | null } {
  const by = addDays(i.complete_on, 30); const day = daysBetween(i.complete_on, i.outage_on); const remaining = 30 - day;
  const basis: SmduFallbackBasis | null = (i.failed_submissions ?? 0) >= 2 ? "two_failed_submissions" : i.outage_hours > 4 && remaining < 7 ? "outage_over_4h_within_7_days" : null;
  const applies = basis !== null; const op = applies ? (i.operator_result ?? null) : null;
  return { day_of_outage: day, days_remaining: remaining, fallback: { applies, basis }, portal_task: applies ? { kind: "human_portal_task", package_attached: true, filed_on: i.outage_on } : null, decision: op ? { source: "operator_smdu_result", decision: op.decision, smdu_case_id: op.smdu_case_id } : null, notice_by: by, on_time: i.notice_provided_on ? i.notice_provided_on <= by : null };
}

/** Rule 12.2 §1024.41(g): a hold on a loan with a pending dispositive motion → counsel instruction within 1 BD; a sale conducted anyway is a sev-1 NoE-risk incident. */
export function counselInstruction(i: { hold_set_on: PlainDate; motion_pending: boolean; instruction_sent_on?: PlainDate | null; acknowledged_on?: PlainDate | null; sale_conducted_on?: PlainDate | null }): { instruction_due: PlainDate; sent_on_time: boolean; acknowledged: boolean; incident: Escalation | null } {
  const due = addBusinessDays(i.hold_set_on, 1, servicer);
  return { instruction_due: due, sent_on_time: Boolean(i.instruction_sent_on && i.instruction_sent_on <= due), acknowledged: Boolean(i.acknowledged_on), incident: i.sale_conducted_on ? { kind: "officer", severity: "sev1", reason: `sale conducted ${i.sale_conducted_on} despite hold set ${i.hold_set_on} — NoE risk (§1024.41(g); 13.x sale-event reconciliation)` } : null };
}

/** Rule 12.2/12.8: a streamlined solicitation while an incomplete application is open carries the incomplete-application disclosures and starts no (c)(1) clock. */
export function streamlinedSolicitationWithOpenApp(i: { open_incomplete_application: boolean; day: number }): { disclosures_included: boolean; diligence_follow_ups_continue: boolean; c1_clock_started: false; letter: "NTC_FNMA_D23206_SOLICIT_STREAMLINED" } {
  return { disclosures_included: i.open_incomplete_application, diligence_follow_ups_continue: i.open_incomplete_application, c1_clock_started: false, letter: "NTC_FNMA_D23206_SOLICIT_STREAMLINED" };
}

// ============================================================ 12.3 appeals
/** Rule 12.3 §1024.41(h)(3): the appeal reviewer is not the evaluator or the evaluator's supervisor-approver; a reason is logged on refusal. */
export function assignAppealReviewer(i: { candidate_id: string; evaluator_id: string; approver_id?: string | null; candidate_role: string }): { accepted: boolean; reason: string } {
  const excluded = [i.evaluator_id, ...(i.approver_id ? [i.approver_id] : [])];
  return independent(i.candidate_id, excluded) ? { accepted: true, reason: `${i.candidate_id} (${i.candidate_role}) took no part in the original evaluation (§1024.41(h)(3))` } : { accepted: false, reason: `${i.candidate_id} is the original ${i.candidate_id === i.evaluator_id ? "evaluator" : "approving reviewer"} — appeal review must be independent (§1024.41(h)(3); SM_APPEAL_INDEPENDENCE_GATE)` };
}

/** Rule 12.3: an appeal after the 14-day window is ineligible; new information is reviewed as such; holds release only on reviewer confirmation. */
export function lateAppeal(i: { denial_provided_on: PlainDate; appeal_received_on: PlainDate; new_information: readonly string[]; reviewer_confirmed_release: boolean; state?: string }): { window_ends: PlainDate; eligible: boolean; notice: "NTC_REGX_41H_APPEAL_INELIGIBLE" | "NTC_REGX_41H_APPEAL_ACK"; new_information_review: { items: string[]; as: "new_information" } | null; holds_released: boolean } {
  const ends = addDays(i.denial_provided_on, i.state === "CA" ? 30 : 14); const eligible = i.appeal_received_on <= ends;
  return { window_ends: ends, eligible, notice: eligible ? "NTC_REGX_41H_APPEAL_ACK" : "NTC_REGX_41H_APPEAL_INELIGIBLE", new_information_review: i.new_information.length ? { items: [...i.new_information], as: "new_information" } : null, holds_released: !eligible && i.reviewer_confirmed_release };
}

/** Rule 12.3 §1024.41(h)(1): appeal availability turns on the first filing, not on a hypothetical sale date. */
export function appealAvailabilityBeforeFiling(i: { days_delinquent: number; first_filing_made: boolean; sale_on: PlainDate | null; complete_on: PlainDate; denied_modification: boolean }): { appeal_available: boolean; tier: "ge_90" | "lt_90" | "le_37"; basis: string } {
  const t = tier(i.complete_on, i.sale_on);
  return { appeal_available: appealEligible(t, i.first_filing_made, i.denied_modification), tier: t, basis: i.sale_on ? `${t} by sale date` : "no sale scheduled → treated as ge_90; no first filing at receipt" };
}

/** Rule 12.3: appeal decision not provided by day 30 → officer sev-1, borrower status notice, holds maintained. */
export function appealDecisionBreach(i: { appeal_received_on: PlainDate; decided_on: PlainDate | null; today: PlainDate }): { decision_due: PlainDate; breached: boolean; escalation: Escalation | null; borrower_status_notice: boolean; holds_maintained: boolean } {
  const due = addDays(i.appeal_received_on, 30); const breached = !i.decided_on && i.today > due;
  return { decision_due: due, breached, escalation: breached ? { kind: "officer", severity: "sev1", reason: `appeal decision not provided by ${due} (§1024.41(h)(4))` } : null, borrower_status_notice: breached, holds_maintained: true };
}

// ============================================================ 12.4 forbearance
/** Rule 12.4 D2-3.2-01 / 12.4-T1: a plan offer carries the Evaluation Notice within 5 days, status 09 at BD2 of the month after the start, late-charge suppression, and the −30-day outreach anchor set at term creation (`FNMA_D23201_FORB_PREEXPIRY_CONTACT_30`). */
export function forbearanceActivation(i: { offered_on: PlainDate; term_start: PlainDate; term_end: PlainDate }): { evaluation_notice: "NTC_FNMA_D23201_FORB_PLAN"; evaluation_notice_by: PlainDate; status_code: "09"; status_report_by: PlainDate; late_charges_suppressed: true; preexpiry_outreach: { timer: "FNMA_D23201_FORB_PREEXPIRY_CONTACT_30"; anchor: PlainDate; begin_by: PlainDate }; holds: Hold[] } {
  const { y, m } = parts(i.term_start); const nextMonth = addMonths(ymd(y, m, 1), 1);
  return { evaluation_notice: "NTC_FNMA_D23201_FORB_PLAN", evaluation_notice_by: addDays(i.offered_on, 5), status_code: "09", status_report_by: addBusinessDays(addDays(nextMonth, -1), 2, fannieEt), late_charges_suppressed: true, preexpiry_outreach: { timer: "FNMA_D23201_FORB_PREEXPIRY_CONTACT_30", anchor: i.term_end, begin_by: preExpiryOutreachStart(i.term_end) }, holds: [hold("fnma_plan_performing", i.term_start, i.term_end)] };
}

/** Rule 12.4 rule 2 / 12.4-T3: a term that forbears past the sixth payment is not Reg X short-term and needs a recorded basis before activation. */
export type RegxBasis = "complete_application" | "c2ii_discretionary" | "servicer_initiated";
export function forbearanceBasisGate(i: { forborne_months_before: number; term_months: number; regx_basis?: RegxBasis | null }): { regx_short_term: boolean; forborne_months_after: number; basis_required: boolean; allowed: boolean; refusal: string | null } {
  const after = i.forborne_months_before + i.term_months; const shortTerm = regxShortTermForbearance(after);
  const allowed = shortTerm || Boolean(i.regx_basis);
  return { regx_short_term: shortTerm, forborne_months_after: after, basis_required: !shortTerm, allowed, refusal: allowed ? null : `activation refused: ${after} forborne payments exceed the §1024.41(c)(2)(iii) short-term boundary (6) — record regx_basis ∈ {complete_application, c2ii_discretionary, servicer_initiated} first (12.4 rule 2)` };
}

/** Rule 12.4 D2-3.2-01: pre-expiry outreach begins 30 days before term end and continues at least every 3 days; QRPC → hierarchy pre-screen the same day. */
export function preExpiryOutreach(i: { term_end: PlainDate; attempts: readonly PlainDate[]; qrpc_on?: PlainDate | null }): { begin_by: PlainDate; began_on_time: boolean; cadence_ok: boolean; max_gap_days: number; prescreen_on: PlainDate | null } {
  const beginBy = addDays(i.term_end, -30); const sorted = [...i.attempts].sort();
  let maxGap = 0; for (let k = 1; k < sorted.length; k++) maxGap = Math.max(maxGap, daysBetween(sorted[k - 1]!, sorted[k]!));
  const last = i.qrpc_on ?? sorted[sorted.length - 1] ?? null;
  return { begin_by: beginBy, began_on_time: sorted.length > 0 && sorted[0]! <= beginBy, cadence_ok: sorted.length > 0 && maxGap <= 3 && (last === null || last <= i.term_end), max_gap_days: maxGap, prescreen_on: i.qrpc_on ?? null };
}

/** Rule 12.4/12.6: forbearance expiry without QRPC → deferral solicitation (if eligible) or Flex Mod solicitation by term end + 15. */
export function postForbearanceDisposition(i: { term_end: PlainDate; qrpc: boolean; months_delinquent: number; deferral_eligible: boolean }): { solicitation: "payment_deferral" | "flex_mod" | null; notice: "NTC_FNMA_D23204_SOLICIT_POST_FORB" | "NTC_FNMA_D23206_SOLICIT_STREAMLINED" | null; by: PlainDate | null } {
  if (i.qrpc) return { solicitation: null, notice: null, by: null };
  const by = addDays(i.term_end, 15);
  return i.deferral_eligible ? { solicitation: "payment_deferral", notice: "NTC_FNMA_D23204_SOLICIT_POST_FORB", by } : { solicitation: "flex_mod", notice: "NTC_FNMA_D23206_SOLICIT_STREAMLINED", by };
}

/** Rule 12.4 D2-3.2-01 disaster: FEMA IA area + current at the disaster → up to 3 months without QRPC; attempts every ≤7 days. */
export function disasterForbearanceOffer(i: { fema_ia: boolean; current_at_disaster: boolean; months_delinquent: number; attempts: readonly PlainDate[] }): { months: number; qrpc_required: boolean; attempt_cadence_ok: boolean; max_gap_days: number; refusal: string | null } {
  if (!i.fema_ia) return { months: 0, qrpc_required: true, attempt_cadence_ok: false, max_gap_days: 0, refusal: "no FEMA IA declaration on the registry — a disaster forbearance cannot be asserted (12.4/12.7 guardrail)" };
  const sorted = [...i.attempts].sort(); let maxGap = 0; for (let k = 1; k < sorted.length; k++) maxGap = Math.max(maxGap, daysBetween(sorted[k - 1]!, sorted[k]!));
  return { months: i.current_at_disaster && i.months_delinquent <= 3 ? 3 : 0, qrpc_required: !(i.current_at_disaster && i.months_delinquent <= 3), attempt_cadence_ok: maxGap <= 7, max_gap_days: maxGap, refusal: null };
}

/** Rule 12.4: a reduced payment not received by month-end → mitigating-circumstances check, termination notice, late charges from the default date only. */
export function reducedPaymentMiss(i: { due_on: PlainDate; received_cents: Cents; reduced_payment_cents: Cents; mitigating_circumstances: boolean; plan_start: PlainDate }): { missed: boolean; mitigating_check: "performed"; terminated: boolean; termination_notice: "NTC_FNMA_D23201_FORB_TERMINATION" | null; late_charges_from: PlainDate | null; late_charges_before_default: 0n } {
  const missed = i.received_cents < i.reduced_payment_cents; const eom = endOfMonth(i.due_on);
  const terminated = missed && !i.mitigating_circumstances;
  return { missed, mitigating_check: "performed", terminated, termination_notice: terminated ? "NTC_FNMA_D23201_FORB_TERMINATION" : null, late_charges_from: terminated ? addDays(eom, 1) : null, late_charges_before_default: 0n };
}

/** Rule 12.4/12.5 holds: no 13.3 referral while a plan is active; allowed 1 BD after `terminated{failed_terms}` (subject to 13.1). */
export function referralGate(i: { plan_status: "active" | "terminated" | "completed" | "expired"; terminated_reason?: "failed_terms" | "borrower_request" | null; terminated_on?: PlainDate | null; today: PlainDate }): { allowed: boolean; allowed_from: PlainDate | null; refusal: string | null } {
  if (i.plan_status === "active") return { allowed: false, allowed_from: null, refusal: "13.3 referral refused: workout plan active (REGX_1024_41C2III_PERFORMANCE_HOLD / D2-3.2-01)" };
  if (i.plan_status === "terminated" && i.terminated_reason === "failed_terms" && i.terminated_on) { const from = addBusinessDays(i.terminated_on, 1, servicer); return from <= i.today ? { allowed: true, allowed_from: from, refusal: null } : { allowed: false, allowed_from: from, refusal: `referral allowed from ${from} (1 BD after terminated{failed_terms}), subject to 13.1` }; }
  return { allowed: true, allowed_from: i.terminated_on ?? i.today, refusal: null };
}

/** Rule 12.4 (Q1 2027 flag): with `smdu.plan_cases=on` the plan is an SMDU case and code 09 leaves the legacy file. */
export function planCaseRouting(i: { smdu_plan_cases: "on" | "off"; plan_kind: "forbearance" | "repayment_plan" }): { smdu_case_created: boolean; legacy_status_code_emitted: "09" | "12" | null } {
  const code = i.plan_kind === "forbearance" ? "09" : "12";
  return i.smdu_plan_cases === "on" ? { smdu_case_created: true, legacy_status_code_emitted: null } : { smdu_case_created: false, legacy_status_code_emitted: code };
}

// ============================================================ 12.5 repayment
/** Rule 12.5 D2-3.2-02: >90 days delinquent or >6-month term → BRP required; otherwise QRPC suffices. */
export function repaymentBrpGate(i: { days_delinquent: number; term_months: number; brp_complete: boolean; qrpc: boolean }): { allowed: boolean; refusal: string | null; basis: "brp" | "qrpc" } {
  const needBrp = i.days_delinquent > 90 || i.term_months > 6;
  if (needBrp) return i.brp_complete ? { allowed: true, refusal: null, basis: "brp" } : { allowed: false, refusal: `plan creation refused: ${i.days_delinquent} days delinquent / ${i.term_months}-month term needs a complete BRP (FNMA_D23202_REPAY_BRP_REQUIRED)`, basis: "brp" };
  return i.qrpc ? { allowed: true, refusal: null, basis: "qrpc" } : { allowed: false, refusal: "plan creation refused: QRPC not established", basis: "qrpc" };
}

/** Rule 12.5: a term over 12 months needs Fannie Mae approval (F-1-16 package); the plan is `extension_pending` until the approval id is recorded. */
export function repaymentExtension(i: { term_months: number; fnma_approval_id?: string | null }): { package: "F-1-16" | null; status: "extension_pending" | "approved" | "not_required" } {
  if (i.term_months <= 12) return { package: null, status: "not_required" };
  return { package: "F-1-16", status: i.fnma_approval_id ? "approved" : "extension_pending" };
}

/** Rule 12.5 D2-3.2-02 late charges: suppressed during the plan; waived at completion; on failure they accrue from the failed month only. */
export function lateChargeTreatment(i: { plan_months: number; outcome: "active" | "completed" | "failed"; failed_month?: number | null; late_charge_cents: Cents }): { suppressed_months: number[]; written_off_cents: Cents; write_off_reason: "D2-3.2-02" | null; accrue_from_month: number | null; accrued_cents: Cents } {
  const months = Array.from({ length: i.plan_months }, (_, k) => k + 1);
  if (i.outcome === "completed") return { suppressed_months: months, written_off_cents: BigInt(i.plan_months) * i.late_charge_cents, write_off_reason: "D2-3.2-02", accrue_from_month: null, accrued_cents: 0n };
  if (i.outcome === "failed" && i.failed_month) { const fm = i.failed_month; return { suppressed_months: months.filter((m) => m < fm), written_off_cents: 0n, write_off_reason: null, accrue_from_month: fm, accrued_cents: BigInt(i.plan_months - fm + 1) * i.late_charge_cents }; }
  return { suppressed_months: months, written_off_cents: 0n, write_off_reason: null, accrue_from_month: null, accrued_cents: 0n };
}

/** Rule 12.5: a missed month-end payment without QRPC → deferral or Flex Mod solicitation by month-end + 15. */
export function repaymentFailureSolicitation(i: { missed_month_end: PlainDate; qrpc: boolean; months_delinquent: number; deferral_eligible: boolean }): { solicitation: "payment_deferral" | "flex_mod" | null; notice: "NTC_FNMA_D23204_SOLICIT_POST_REPAY" | "NTC_FNMA_D23206_SOLICIT_STREAMLINED" | null; by: PlainDate | null } {
  if (i.qrpc) return { solicitation: null, notice: null, by: null };
  const by = solicitationDue(i.missed_month_end);
  return i.deferral_eligible ? { solicitation: "payment_deferral", notice: "NTC_FNMA_D23204_SOLICIT_POST_REPAY", by } : { solicitation: "flex_mod", notice: "NTC_FNMA_D23206_SOLICIT_STREAMLINED", by };
}

/** Rule 12.5 §1024.41(c)(2)(iii) / 12.5-T6: a short-term plan on an incomplete application → terms notice within 5 federal business days; the performance hold is active while the borrower performs. */
export function shortTermPlanOffer(i: { offered_on: PlainDate; months_of_arrears: number; term_months: number; application_complete: boolean }): { regx_short_term: boolean; terms_notice: "NTC_FNMA_D23202_REPAY_PLAN"; terms_notice_by: PlainDate | null; timers: readonly string[]; hold: Hold | null } {
  const shortTerm = i.months_of_arrears <= 3 && i.term_months <= 6;
  const c2iii = shortTerm && !i.application_complete;
  return { regx_short_term: shortTerm, terms_notice: "NTC_FNMA_D23202_REPAY_PLAN", terms_notice_by: c2iii ? addBusinessDays(i.offered_on, 5, federal) : null, timers: c2iii ? ["REGX_1024_41C2III_SHORTTERM_NOTICE_5", "FNMA_D2205_EVAL_NOTICE_REPAY", "REGX_1024_41C2III_PERFORMANCE_HOLD"] : ["FNMA_D2205_EVAL_NOTICE_REPAY", "REGX_1024_41C2III_PERFORMANCE_HOLD"], hold: hold("fnma_plan_performing", i.offered_on) };
}

/** Rule 12.5 (Cal. Civ. Code §2924.11(d)): no late fee from the start of evaluation, not only from plan start. */
export function caLateFeeBar(i: { state: string; evaluation_start: PlainDate; plan_start: PlainDate | null; assessment_on: PlainDate }): { allowed: boolean; barred_from: PlainDate | null; refusal: string | null } {
  if (i.state !== "CA") return { allowed: true, barred_from: null, refusal: null };
  const barred = i.assessment_on >= i.evaluation_start;
  return { allowed: !barred, barred_from: i.evaluation_start, refusal: barred ? `late fee refused: CA bars fees from the evaluation start ${i.evaluation_start} (Cal. Civ. Code §2924.11(d); CA_CIV_2924_11D_LATE_FEE_BAR)` : null };
}

/** Rule 12.5 reporting: status 12 at BD2 of the month after start; completion reported in the completion month; $500 incentive when the start delinquency was ≥60 days. */
export function repaymentReporting(i: { start_on: PlainDate; completed_on?: PlainDate | null; start_days_delinquent: number }): { status_code: "12"; effective_date: PlainDate; report_by: PlainDate; completion_report_month: PlainDate | null; incentive_cents: Cents; incentive_claim_cycle: PlainDate | null } {
  const { y, m } = parts(i.start_on); const nextMonth = addMonths(ymd(y, m, 1), 1);
  const reportBy = addBusinessDays(addDays(nextMonth, -1), 2, fannieEt);
  const incentive = i.completed_on && i.start_days_delinquent >= 60 ? 50_000n : 0n;
  return { status_code: "12", effective_date: i.start_on, report_by: reportBy, completion_report_month: i.completed_on ? ymd(parts(i.completed_on).y, parts(i.completed_on).m, 1) : null, incentive_cents: incentive, incentive_claim_cycle: incentive > 0n ? addMonths(ymd(parts(i.completed_on!).y, parts(i.completed_on!).m, 1), 1) : null };
}

/** Rule 12.5 rule 7: an escrow/rate change recomputes the contractual payment prospectively; the installment is unchanged; the 150% cap is re-tested. */
export function capRetest(i: { installment_cents: Cents; new_contractual_cents: Cents; plan_months: number }): { total_cents: Cents; pct_of_contractual: string; within_cap: boolean; recast: { months: number } | null } {
  const total = i.installment_cents + i.new_contractual_cents; const within = total * 2n <= i.new_contractual_cents * 3n;
  return { total_cents: total, pct_of_contractual: pctOf(total, i.new_contractual_cents), within_cap: within, recast: within ? null : { months: Math.min(12, i.plan_months + 1) } };
}

/** Rule 12.5 worked example helper: the arrears figure = unpaid installments + late charges. */
export function arrears(i: { piti_cents: Cents; unpaid_installments: number; late_charge_cents: Cents; late_charges: number }): { installments_cents: Cents; late_charges_cents: Cents; total_cents: Cents } {
  const inst = BigInt(i.unpaid_installments) * i.piti_cents; const lc = BigInt(i.late_charges) * i.late_charge_cents;
  return { installments_cents: inst, late_charges_cents: lc, total_cents: inst + lc };
}
export const repaymentTermsFor = repaymentTerms;

// ============================================================ 12.6 payment deferral
/** Rule 12.6 D2-3.2-04 cap: cumulative deferred months ≤12 → the deferral is limited to the remaining room; the rest must be paid; else Flex Mod. */
export function capStructure(i: { prior_deferred_months: number; requested_months: number; cap?: number }): { cumulative: number; contractual_payment_required: boolean; months_allowed: number; installments_to_pay: number; alternative: "flex_mod" | null } {
  const cap = i.cap ?? 12; const cum = i.prior_deferred_months + i.requested_months; const room = Math.max(0, cap - i.prior_deferred_months);
  const allowed = Math.min(room, i.requested_months);
  return { cumulative: cum, contractual_payment_required: cum > cap, months_allowed: allowed, installments_to_pay: i.requested_months - allowed, alternative: cum > cap ? "flex_mod" : null };
}

/** Rule 12.6: post-forbearance and post-repayment solicitation clocks (+15 days). */
export function deferralSolicitationClocks(i: { forbearance_expired_on?: PlainDate | null; repayment_failed_month_end?: PlainDate | null }): { post_forbearance_by: PlainDate | null; post_repayment_by: PlainDate | null } {
  return { post_forbearance_by: i.forbearance_expired_on ? addDays(i.forbearance_expired_on, 15) : null, post_repayment_by: i.repayment_failed_month_end ? solicitationDue(i.repayment_failed_month_end) : null };
}

/** Rule 12.6 Reg X: a deferral offered on a complete application carries (c)(1) content, a 14-day window, and a deemed rejection after the grace releases the holds. */
export function deferralOfferOnCompleteApp(i: { provided_on: PlainDate; tier?: "ge_90" | "lt_90"; grace_days?: number }): { c1_content: true; accept_by: PlainDate; window_days: 14 | 7; grace_days: number; deemed_rejected_on: PlainDate; holds_released_on: PlainDate; notice: "NTC_FNMA_D23204_DEFERRAL_OFFER" } {
  const window = i.tier === "lt_90" ? 7 : 14;   // §1024.41(e)(1): 14 days (≥90 before sale / no sale), 7 days (<90 but >37)
  const grace = i.grace_days ?? deemedRejectionGraceDays(window);   // policy grace: 5 after the 14-day window, 3 after the 7-day window (12.2 timer rows)
  const acceptBy = addDays(i.provided_on, window); const deemed = addDays(acceptBy, grace);
  return { c1_content: true, accept_by: acceptBy, window_days: window, grace_days: grace, deemed_rejected_on: deemed, holds_released_on: deemed, notice: "NTC_FNMA_D23204_DEFERRAL_OFFER" };
}

export interface Posting { readonly account: string; readonly debit: Cents; readonly credit: Cents; readonly rule_ref: string; }
/**
 * Rule 12.6 rule 7 ledger: NIB = deferred P&I + eligible advances (debit `deferred_principal`); the deferred
 * installments' principal and interest portions are credited to the `principal` and `interest_due` receivables so the
 * interest-bearing UPB *becomes* the scheduled amortized balance as though the installments had been paid; late
 * charges are waived by contra; the payoff statement shows the NIB line. The IB UPB is computed from the postings
 * (pre-deferral UPB less the principal credited), never echoed from the caller.
 */
export function deferralLedger(i: { pi_cents: Cents; months_deferred: number; escrow_advances_cents: Cents; servicing_advances_cents: Cents; late_charges_cents: Cents; pre_deferral_ib_upb_cents: Cents; scheduled_ib_upb_cents: Cents }): { postings: Posting[]; balanced: boolean; deferred_principal_cents: Cents; principal_portion_cents: Cents; interest_portion_cents: Cents; ib_upb_cents: Cents; ib_upb_equals_scheduled: boolean; payoff_lines: { line: string; cents: Cents }[] } {
  const nibCents = deferralNib(i.pi_cents, i.months_deferred, i.escrow_advances_cents, i.servicing_advances_cents); const pi = BigInt(i.months_deferred) * i.pi_cents;
  const principalPortion = i.pre_deferral_ib_upb_cents - i.scheduled_ib_upb_cents;
  if (principalPortion < 0n || principalPortion > pi) throw new RangeError(`scheduled IB UPB ${i.scheduled_ib_upb_cents} is not reachable from ${i.pre_deferral_ib_upb_cents} by ${i.months_deferred} installments of ${i.pi_cents}`);
  const interestPortion = pi - principalPortion;
  const postings: Posting[] = [
    { account: "deferred_principal", debit: nibCents, credit: 0n, rule_ref: "12.6.deferral" },
    { account: "principal", debit: 0n, credit: principalPortion, rule_ref: "12.6.deferral" },
    { account: "interest_due", debit: 0n, credit: interestPortion, rule_ref: "12.6.deferral" },
    { account: "escrow_advances", debit: 0n, credit: i.escrow_advances_cents, rule_ref: "12.6.deferral" },
    { account: "corporate_advances", debit: 0n, credit: i.servicing_advances_cents, rule_ref: "12.6.deferral" },
    { account: "late_charge_waivers", debit: i.late_charges_cents, credit: 0n, rule_ref: "12.6.deferral.late_charge_waiver" },
    { account: "late_charges_due", debit: 0n, credit: i.late_charges_cents, rule_ref: "12.6.deferral.late_charge_waiver" },
  ];
  const d = postings.reduce((a, p) => a + p.debit, 0n), c = postings.reduce((a, p) => a + p.credit, 0n);
  const ib = i.pre_deferral_ib_upb_cents - principalPortion;
  return { postings, balanced: d === c, deferred_principal_cents: nibCents, principal_portion_cents: principalPortion, interest_portion_cents: interestPortion, ib_upb_cents: ib, ib_upb_equals_scheduled: ib === i.scheduled_ib_upb_cents, payoff_lines: [{ line: "Unpaid principal balance (interest-bearing)", cents: ib }, { line: "Deferred principal (non-interest-bearing)", cents: nibCents }] };
}

/** Rule 12.6: SMDU B2B failure → portal task; the operator's completion is evidence on the case; the entry deadline is unchanged. */
export function smduDeferralOutage(i: { evaluation_on: PlainDate; failed_on: PlainDate; operator_completed_on: PlainDate; entry_deadline: PlainDate; evidence_document_id: string }): { portal_task: { kind: "human_portal_task"; filed_on: PlainDate }; completed_on: PlainDate; within_entry_deadline: boolean; case_evidence: { document_id: string; attached: true } } {
  return { portal_task: { kind: "human_portal_task", filed_on: i.failed_on }, completed_on: i.operator_completed_on, within_entry_deadline: i.operator_completed_on <= i.entry_deadline, case_evidence: { document_id: i.evidence_document_id, attached: true } };
}

/**
 * Rule 12.6/12.8 recording states: agreement executed by the signing officer, e-recorded, certified copy to the
 * custodian ≤25 days, original ≤5 BD after receipt from the recorder. The 25-day custodian clock anchors differently
 * by program: a payment deferral on the *effective date* (D2-3.2-04; `FNMA_D23204_CUSTODIAN_25`), a Flex Mod on
 * *receipt of the borrower-executed Form 3179* (F-1-27; `FNMA_F127_CUSTODIAN_25`) — the caller names which.
 */
export type CustodianAnchor = { basis: "effective_date"; on: PlainDate } | { basis: "executed_agreement_received"; on: PlainDate };
export function recordableAgreement(i: { recording_required: boolean; executed_by_role: string; borrower_signed_on: PlainDate; custodian_anchor: CustodianAnchor; erecorded_on?: PlainDate | null; recorded_original_received_on?: PlainDate | null }): { allowed: boolean; refusal: string | null; custodian_anchor: CustodianAnchor; certified_copy_to_custodian_by: PlainDate; erecorded_on: PlainDate | null; original_to_custodian_by: PlainDate | null; unrecorded_original_by: PlainDate | null } {
  const ok = !i.recording_required || i.executed_by_role === "signing_officer";
  const certBy = addDays(i.custodian_anchor.on, 25);
  return { allowed: ok, refusal: ok ? null : "a recordable agreement is executed only by signing_officer (12.6/12.8 guardrail)", custodian_anchor: i.custodian_anchor, certified_copy_to_custodian_by: certBy, erecorded_on: i.recording_required ? (i.erecorded_on ?? null) : null, original_to_custodian_by: i.recorded_original_received_on ? addBusinessDays(i.recorded_original_received_on, 5, servicer) : null, unrecorded_original_by: i.recording_required ? null : certBy };
}

// ============================================================ 12.7 disaster deferral
/** Rule 12.7 D2-3.2-05: disaster forbearance expiry without QRPC → solicitation by end + 15; on acceptance the case is entered by the acceptance month-end (or the next month under the processing-month policy). */
export function disasterDeferralTimeline(i: { fema_ia: boolean; incident_on: PlainDate; current_at_incident: boolean; forbearance_start: PlainDate; forbearance_end: PlainDate; qrpc: boolean; acceptance_on?: PlainDate | null; processing_month_policy?: boolean }): { eligible: boolean; solicitation_by: PlainDate; notice: "NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB"; entry_by: PlainDate | null; processing_month_entry_by: PlainDate | null } {
  const solicitBy = addDays(i.forbearance_end, 15);
  const entry = i.acceptance_on ? endOfMonth(i.acceptance_on) : null;
  return { eligible: i.fema_ia && i.current_at_incident && !i.qrpc, solicitation_by: solicitBy, notice: "NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB", entry_by: entry, processing_month_entry_by: entry && i.processing_month_policy ? endOfMonth(addMonths(entry, 1)) : null };
}

/** Rule 12.7 12-month rule: at 12 months delinquent the contractual payment is required before completion. */
export function disasterTwelveMonthRule(monthsDelinquent: number): { contractual_payment_required: boolean; eligible: boolean } {
  return { contractual_payment_required: monthsDelinquent >= 12, eligible: monthsDelinquent <= 12 };
}

/** Rule 12.7: one disaster deferral per `disaster_event_id`. */
export function sameEventCheck(i: { prior_event_ids: readonly string[]; requested_event_id: string }): { allowed: boolean; refusal: string | null } {
  const dup = i.prior_event_ids.includes(i.requested_event_id);
  return { allowed: !dup, refusal: dup ? `disaster deferral refused: a deferral was already completed for disaster_event_id ${i.requested_event_id} (D2-3.2-05)` : null };
}

/** Rule 12.7 routing: ineligible → Flex Mod under the reduced disaster criteria within 5 BD. */
export function disasterIneligibleRouting(i: { months_delinquent: number; screened_on: PlainDate }): { route: "flex_mod_disaster_criteria" | "disaster_payment_deferral"; evaluation_by: PlainDate | null; timer: "FNMA_D1301_DISASTER_FLEX_ROUTE" | null; reviewer: "lossmit_reviewer" | null } {
  if (i.months_delinquent <= 12) return { route: "disaster_payment_deferral", evaluation_by: null, timer: null, reviewer: null };
  return { route: "flex_mod_disaster_criteria", evaluation_by: addBusinessDays(i.screened_on, 5, servicer), timer: "FNMA_D1301_DISASTER_FLEX_ROUTE", reviewer: "lossmit_reviewer" };
}

/** Rule 12.7 rule 2 / 12.7-T2: 2+ months delinquent at the disaster → Fannie Mae prior-approval package; no offer until the approval id is recorded. */
export function disasterOfferGate(i: { delinquency_months_at_disaster: number; fnma_prior_approval_id?: string | null }): { prior_approval_required: boolean; package: "F-1-24" | null; offer_allowed: boolean; state: "fnma_prior_approval_pending" | "offerable"; refusal: string | null } {
  if (i.delinquency_months_at_disaster < 2) return { prior_approval_required: false, package: null, offer_allowed: true, state: "offerable", refusal: null };
  const ok = Boolean(i.fnma_prior_approval_id);
  return { prior_approval_required: true, package: "F-1-24", offer_allowed: ok, state: ok ? "offerable" : "fnma_prior_approval_pending", refusal: ok ? null : `offer refused: ${i.delinquency_months_at_disaster} months delinquent at the disaster — Fannie Mae prior approval must be recorded first (D2-3.2-05)` };
}

/** The human roles that may send the hazard_loss@fanniemae.com package (12.7 Integrations; open question 2 default `officer`). */
export const DISASTER_FC_PACKAGE_SENDERS = ["officer", "fnma_portal_operator"] as const;
/** Rule 12.7 foreclosure gate (LL-2026-01): a disaster loan is not referred without Fannie Mae approval; the agent prepares the package within 5 days of the pre-referral review, and only a human role sends it. */
export function disasterForeclosureGate(i: { review_completed_on: PlainDate; fnma_approval_id?: string | null; sender?: { kind: "agent" | "human"; role?: string | null } | null }): { referral_allowed: boolean; refusal: string | null; submission_by: PlainDate; package_prepared: true; sent_by_role: "officer"; send_allowed: boolean | null; send_refusal: string | null } {
  const ok = Boolean(i.fnma_approval_id);
  const sender = i.sender ?? null;
  const sendAllowed = sender === null ? null : sender.kind === "human" && (DISASTER_FC_PACKAGE_SENDERS as readonly string[]).includes(sender.role ?? "");
  return { referral_allowed: ok, refusal: ok ? null : "referral refused: disaster loan needs Fannie Mae foreclosure approval (D1-3-01)", submission_by: addDays(i.review_completed_on, 5), package_prepared: true, sent_by_role: "officer", send_allowed: sendAllowed, send_refusal: sendAllowed === false ? `package send refused: only ${DISASTER_FC_PACKAGE_SENDERS.join("/")} may submit to hazard_loss@fanniemae.com (12.7 guardrail)` : null };
}

// ============================================================ 12.8 Flex Mod
/** Rule 12.8 D2-3.2-06: day-90 solicitation by day 105 (+15); refused inside the sale-proximity window. */
export function streamlinedSolicitationWindow(i: { day90_on: PlainDate; brp_complete: boolean; sale_on: PlainDate | null; judicial: boolean }): { solicit_by: PlainDate; allowed: boolean; refusal: string | null } {
  const by = addDays(i.day90_on, 15);
  if (i.brp_complete) return { solicit_by: by, allowed: false, refusal: "a complete BRP is evaluated under 12.2, not solicited" };
  const win = i.judicial ? 60 : 30; const days = i.sale_on ? daysBetween(i.day90_on, i.sale_on) : null;
  const ok = days === null || days > win;
  return { solicit_by: by, allowed: ok, refusal: ok ? null : `solicitation refused: sale ${i.sale_on} is within ${win} days (FNMA_D23206_SOLICIT_SALE_PROXIMITY_GATE)` };
}

/** Rule 12.8 D2-3.1-02: an MBS loan cannot be executed by the servicer until reclassified; the effective date is re-dated to the month after reclassification. */
export function mbsExecutionGate(i: { mbs: boolean; reclassified_on: PlainDate | null; effective: PlainDate }): { execution_allowed: boolean; refusal: string | null; effective: PlainDate; redated: boolean } {
  if (!i.mbs || i.reclassified_on) { const need = i.reclassified_on && i.reclassified_on >= i.effective; const eff = need ? addMonths(ymd(parts(i.reclassified_on!).y, parts(i.reclassified_on!).m, 1), 1) : i.effective; return { execution_allowed: true, refusal: null, effective: eff, redated: eff !== i.effective }; }
  return { execution_allowed: false, refusal: "servicer execution blocked until smdu.case.reclassified (FNMA_D23102_MBS_RECLASS_BEFORE_EXECUTION)", effective: i.effective, redated: false };
}

/** Rule 12.8 documents: certified copy to the custodian 25 days from borrower signature; original within 5 BD of receipt from the recorder; unrecorded → fully executed original by the same date. */
export function modDocumentClocks(i: { form_3179_sent_on: PlainDate; borrower_signed_on: PlainDate; servicer_executed_on: PlainDate; servicer_role: string; recording_required: boolean; erecorded_on?: PlainDate | null; recorded_original_received_on?: PlainDate | null }): ReturnType<typeof recordableAgreement> & { servicer_executed_on: PlainDate } {
  return { ...recordableAgreement({ recording_required: i.recording_required, executed_by_role: i.servicer_role, borrower_signed_on: i.borrower_signed_on, custodian_anchor: { basis: "executed_agreement_received", on: i.borrower_signed_on }, erecorded_on: i.erecorded_on ?? null, recorded_original_received_on: i.recorded_original_received_on ?? null }), servicer_executed_on: i.servicer_executed_on };
}

/**
 * Rule 12.8 rule 7 / F-1-27 step 1 conversion: capitalize accrued interest, third-party escrow and servicing advances
 * and any prior non-interest-bearing balance into `principal` (buydown funds applied against the arrearage reduce it),
 * move the Step-5 forbearance to `forborne_principal`, waive late charges by contra, version the terms, reset
 * delinquency and report the loan-data change. The interest-bearing principal the postings leave equals the
 * waterfall's IB UPB (`ib_principal_after_cents`), prior NIB included.
 */
export function conversionLedger(i: WaterfallInputs & { late_charges_cents: Cents; effective: PlainDate; loan_data_change_acked: boolean }): { postings: Posting[]; balanced: boolean; capitalized_cents: Cents; prior_nib_cents: Cents; buydown_applied_cents: Cents; ib_principal_after_cents: Cents; ib_principal_equals_waterfall: boolean; late_charges_waived_cents: Cents; forborne_principal_cents: Cents; loan_terms_version: { effective: PlainDate; rate_pct: string; term_months: number; ib_upb_cents: Cents }; next_due: PlainDate; delinquency_reset: true; loan_data_change: { reported: true; acked: boolean } } {
  const w = waterfall(i); const buydown = i.buydown_funds_cents ?? 0n;
  const cap = i.accrued_interest_cents + i.escrow_advances_cents + i.servicing_advances_cents + i.prior_nib_cents;   // F-1-27 step 1 (late charges and projected shortage excluded)
  const postings: Posting[] = [
    { account: "principal", debit: cap - buydown, credit: 0n, rule_ref: "12.8.capitalization" },
    ...(buydown > 0n ? [{ account: "buydown_funds", debit: buydown, credit: 0n, rule_ref: "12.8.capitalization" }] : []),
    { account: "forborne_principal", debit: w.forborne_cents, credit: 0n, rule_ref: "12.8.capitalization" },
    { account: "interest_due", debit: 0n, credit: i.accrued_interest_cents, rule_ref: "12.8.capitalization" },
    { account: "escrow_advances", debit: 0n, credit: i.escrow_advances_cents, rule_ref: "12.8.capitalization" },
    { account: "corporate_advances", debit: 0n, credit: i.servicing_advances_cents, rule_ref: "12.8.capitalization" },
    ...(i.prior_nib_cents > 0n ? [{ account: "deferred_principal", debit: 0n, credit: i.prior_nib_cents, rule_ref: "12.8.capitalization" }] : []),   // prior deferral / modification NIB rolled into the new gross UPB
    { account: "principal", debit: 0n, credit: w.forborne_cents, rule_ref: "12.8.capitalization" },
    { account: "late_charge_waivers", debit: i.late_charges_cents, credit: 0n, rule_ref: "12.8.capitalization.late_charge_waiver" },
    { account: "late_charges_due", debit: 0n, credit: i.late_charges_cents, rule_ref: "12.8.capitalization.late_charge_waiver" },
  ];
  const d = postings.reduce((a, p) => a + p.debit, 0n), c = postings.reduce((a, p) => a + p.credit, 0n);
  const ibAfter = i.ib_upb_cents + postings.filter((p) => p.account === "principal").reduce((a, p) => a + p.debit - p.credit, 0n);
  return { postings, balanced: d === c, capitalized_cents: cap, prior_nib_cents: i.prior_nib_cents, buydown_applied_cents: buydown, ib_principal_after_cents: ibAfter, ib_principal_equals_waterfall: ibAfter === w.ib_upb_cents, late_charges_waived_cents: i.late_charges_cents, forborne_principal_cents: w.forborne_cents, loan_terms_version: { effective: i.effective, rate_pct: w.rate_pct, term_months: w.term_months, ib_upb_cents: w.ib_upb_cents }, next_due: i.effective, delinquency_reset: true, loan_data_change: { reported: true, acked: i.loan_data_change_acked } };
}

/** The kernel chart of accounts behind the 12.8 posting names (docs/ARCHITECTURE.md ledger): loan-scoped unless noted. */
export function conversionAccount(name: string, loanId: string): AccountRef {
  switch (name) {
    case "principal": case "interest_due": case "forborne_principal": case "deferred_principal": return { scope: "loan", loanId, account: name };
    case "escrow_advances": return { scope: "loan", loanId, account: "escrow_advance" };
    case "corporate_advances": return { scope: "loan", loanId, account: "corporate_advance" };
    case "late_charges_due": return { scope: "loan", loanId, account: "late_charges" };
    case "late_charge_waivers": return { scope: "corporate", account: "late_charge_income" };   // the waiver is written off against late-charge income
    case "buydown_funds": return { scope: "loan", loanId, account: "suspense_unapplied" };   // temporary buydown funds held on the loan and applied to the arrearage (F-1-27 step 1)
    default: throw new RangeError(`no kernel account for 12.8 posting ${name}`);
  }
}
/**
 * Rule 12.8 rule 7 / `FNMA_F127_CAPITALIZATION_DATE`: the conversion set is posted through the kernel ledger on the
 * capitalization date (effective date − 1 month) under `rule_ref 12.8.capitalization`, and `ledger.posted{rule_ref}`
 * is appended — the event the timer is satisfied by. This is the spec's 12.8 `ledger.post_conversion` tool body;
 * it is invoked here by the domain because spec/registry/agents.json does not yet allowlist that tool for 12.8.
 */
export function postConversionLedger(deps: { ledger: Ledger; events: { append(e: EventInput): unknown }; actor: Actor; now: string }, i: WaterfallInputs & { loan_id: string; late_charges_cents: Cents; effective: PlainDate; loan_data_change_acked: boolean; capitalization_on?: PlainDate | null }): { conversion: ReturnType<typeof conversionLedger>; set: EntrySet; capitalization_date: PlainDate; event_type: "ledger.posted" } {
  const conv = conversionLedger(i); const capOn = i.capitalization_on ?? addMonths(i.effective, -1);
  if (!conv.balanced) throw new RangeError("12.8 capitalization set does not balance");
  const set = deps.ledger.post({ effectiveDate: capOn, description: `Flex Modification capitalization effective ${i.effective} (F-1-27 step 1)`, lines: conv.postings.filter((p) => p.debit !== 0n || p.credit !== 0n).map((p) => ({ account: conversionAccount(p.account, i.loan_id), amountCents: p.debit - p.credit, ruleRef: p.rule_ref, memo: p.account })) }, deps.now);
  deps.events.append({ type: "ledger.posted", loanId: i.loan_id, actor: deps.actor, payload: { rule_ref: "12.8.capitalization", set_id: set.id, capitalization_date: capOn, effective_date: i.effective, capitalized_cents: conv.capitalized_cents, forborne_cents: conv.forborne_principal_cents, ib_upb_cents: conv.ib_principal_after_cents, late_charges_waived_cents: conv.late_charges_waived_cents } });
  return { conversion: conv, set, capitalization_date: capOn, event_type: "ledger.posted" };
}

/** Rule 12.8 F-2-02 (`FNMA_F202_FLEX_CLOSE_2M`): the $1,000 incentive is claimable when SMDU closes within two months of the last day of the month in which the final trial payment is due (a processing month does not extend it); later → no claim, sev-3. */
export function flexIncentive(i: { final_trial_due_on: PlainDate; smdu_closed_on: PlainDate }): { deadline: PlainDate; claim_cents: Cents; claimed: boolean; escalation: Escalation | null } {
  const deadline = endOfMonth(addMonths(i.final_trial_due_on, 2)); const ok = i.smdu_closed_on <= deadline;
  return { deadline, claim_cents: ok ? 100_000n : 0n, claimed: ok, escalation: ok ? null : { kind: "officer", severity: "sev3", reason: `SMDU close ${i.smdu_closed_on} after the incentive deadline ${deadline} (FNMA_F202_FLEX_CLOSE_2M)` } };
}

/** Rule 12.8 D2-3.2-06: the modification is not binding — and may not be booked as permanent — until (1) the TPP is completed, (2) the borrower executes and returns Form 3179 and (3) the servicer or Fannie Mae executes and dates it. */
export function bindingConditions(i: { tpp_completed: boolean; borrower_executed_on?: PlainDate | null; servicer_executed_on?: PlainDate | null; servicer_role?: string | null }): { binding: boolean; missing: string[]; refusal: string | null } {
  const missing: string[] = [];
  if (!i.tpp_completed) missing.push("trial period plan not completed");
  if (!i.borrower_executed_on) missing.push("Form 3179 not executed and returned by the borrower");
  if (!i.servicer_executed_on) missing.push("Form 3179 not executed and dated by the servicer or Fannie Mae");
  else if (i.servicer_role && i.servicer_role !== "signing_officer" && i.servicer_role !== "fannie_mae") missing.push(`servicer execution by ${i.servicer_role} is not a signing_officer execution`);
  return { binding: missing.length === 0, missing, refusal: missing.length ? `permanent modification refused: ${missing.join("; ")} (D2-3.2-06 binding conditions; 12.8 guardrail)` : null };
}
/** Rule 12.8 guardrail: Form 3179 goes out on the current template with its state riders only — no other edits. */
export const FORM_3179_TEMPLATE = "DOC_FNMA_FORM_3179" as const;
export const FORM_3179_RIDERS: readonly string[] = ["tx_50a6", "leasehold", "assignment_of_rents", "condo_pud", "ny_cema", "no_personal_liability_ch7"];
export function form3179Changes(i: { template: string; riders: readonly string[]; free_text_edits?: readonly string[] }): { allowed: boolean; refusal: string | null } {
  const badRiders = i.riders.filter((r) => !FORM_3179_RIDERS.includes(r)); const edits = i.free_text_edits ?? [];
  const problems = [...(i.template !== FORM_3179_TEMPLATE ? [`template ${i.template} is not ${FORM_3179_TEMPLATE}`] : []), ...(badRiders.length ? [`riders outside the catalog: ${badRiders.join(", ")}`] : []), ...(edits.length ? [`${edits.length} free-text edit(s)`] : [])];
  return { allowed: problems.length === 0, refusal: problems.length ? `Form 3179 change refused: ${problems.join("; ")} (12.8 guardrail: no changes outside the template/riders)` : null };
}

/** Rule 12.8 eligibility: three prior modifications → denial with the specific Fannie Mae criterion, reviewer approval, appeal rights. */
export function flexEligibilityDenial(i: { prior_modifications: number; reviewer_approval_id?: string | null; tier: "ge_90" | "lt_90" | "le_37"; first_filing_made: boolean; rendered_text?: string | null }): { denied: boolean; criterion: string; notice: ReturnType<typeof denialNoticeContent> | null; reviewer_required: boolean; appeal_rights: boolean } {
  if (i.prior_modifications < 3) return { denied: false, criterion: "", notice: null, reviewer_required: false, appeal_rights: false };
  const criterion = "the mortgage loan has not been modified three or more times previously";
  return { denied: true, criterion, notice: denialNoticeContent({ investor: "Fannie Mae", option: "Flex Modification", criterion, reviewer_approval_id: i.reviewer_approval_id ?? null, rendered_text: i.rendered_text ?? null }), reviewer_required: true, appeal_rights: appealEligible(i.tier, i.first_filing_made, true) };
}

/** Rule 12.8: the Modification Interest Rate feed must carry a rate effective on the evaluation date; otherwise the waterfall refuses and the officer is alerted. */
export function mirLookup(table: readonly { effective: PlainDate; rate_pct: string }[], evaluationOn: PlainDate): { rate_pct: string | null; effective: PlainDate | null; refusal: string | null; escalation: Escalation | null } {
  const rows = table.filter((r) => r.effective <= evaluationOn).sort((a, b) => (a.effective < b.effective ? 1 : -1));
  if (!rows.length) return { rate_pct: null, effective: null, refusal: `waterfall refused: no Modification Interest Rate effective on ${evaluationOn}`, escalation: { kind: "officer", severity: "sev2", reason: `MIR feed has no rate for ${evaluationOn}` } };
  return { rate_pct: rows[0]!.rate_pct, effective: rows[0]!.effective, refusal: null, escalation: null };
}

// ============================================================ 12.9 liquidation
/** 12.9 rule 1 / D2-3.3-01 tiering: `delinquency_tier` from `fnma_delinquency_status` at evaluation (Chapter 7 discharge is its own tier). */
export type DelinquencyTier = "lt_90" | "d90_18m" | "gt_18m" | "ch7_discharge";
/** D2-3.3-01 exceptions that lift the BRP requirement in the 90-days-to-18-months tier. */
export const SS_BRP_EXCEPTIONS = ["failed_flexmod_trial_12m", "flexmod_60_days_delinquent_12m", "three_prior_modifications", "forbearance_special_reporting_90", "fico_le_620"] as const;
export type SsBrpException = (typeof SS_BRP_EXCEPTIONS)[number];
export function shortSaleTier(i: { months_delinquent: number; days_delinquent?: number | null; chapter7_discharged?: boolean }): DelinquencyTier {
  if (i.chapter7_discharged) return "ch7_discharge";
  const days = i.days_delinquent ?? null;
  if (days !== null ? days < 90 : i.months_delinquent < 3) return "lt_90";
  return i.months_delinquent > 18 ? "gt_18m" : "d90_18m";
}
/**
 * Rule 12.9 D2-3.3-01 intake: tier the delinquency and apply the BRP rule of that tier — current/<90 days → complete BRP
 * (and, current/<60 days, imminent default with a qualifying hardship); 90 days–18 months → complete BRP unless a listed
 * exception applies; >18 months or Chapter 7 discharge → no BRP. Then the clocks: ack within 5 BD, valuation ordered on
 * eligibility, decision within 30 days of complete BRP + initial offer.
 */
export function shortSaleIntake(i: { offer_received_on: PlainDate; brp_complete: boolean; months_delinquent: number; days_delinquent?: number | null; imminent_default?: boolean; qualifying_hardship?: boolean; chapter7_discharged?: boolean; exceptions?: readonly string[] }): { eligible: boolean; tier: DelinquencyTier; brp_required: boolean; exception_applied: SsBrpException | null; imminent_default_required: boolean; ack_by: PlainDate; ack_notice: "NTC_FNMA_D23301_SS_OFFER_ACK"; valuation_ordered: boolean; decision_by: PlainDate; decision_notices: readonly string[]; refusal: string | null } {
  const clocks = shortSaleClocks(i.offer_received_on);
  const tier = shortSaleTier(i);
  const unknown = (i.exceptions ?? []).filter((e) => !(SS_BRP_EXCEPTIONS as readonly string[]).includes(e)); if (unknown.length) throw new RangeError(`unknown D2-3.3-01 BRP exception(s): ${unknown.join(", ")}`);
  const exception = tier === "d90_18m" ? ((i.exceptions ?? [])[0] as SsBrpException | undefined) ?? null : null;
  const brpRequired = tier === "lt_90" || (tier === "d90_18m" && exception === null);
  const idRequired = tier === "lt_90" && ((i.days_delinquent ?? null) !== null ? (i.days_delinquent as number) < 60 : i.months_delinquent < 2);
  let refusal: string | null = null;
  if (brpRequired && !i.brp_complete) refusal = `short sale not eligible: tier ${tier} requires a complete BRP${tier === "d90_18m" ? " (no D2-3.3-01 exception applies)" : ""} (D2-3.3-01)`;
  else if (idRequired && !(i.imminent_default === true && i.qualifying_hardship === true)) refusal = "short sale not eligible: current/<60 days delinquent requires imminent default (D2-1-01) with a qualifying hardship — death, divorce, disability, relocation >50 miles or PCS (D2-3.3-01)";
  const eligible = refusal === null;
  return { eligible, tier, brp_required: brpRequired, exception_applied: exception, imminent_default_required: idRequired, ack_by: clocks.ack_by, ack_notice: "NTC_FNMA_D23301_SS_OFFER_ACK", valuation_ordered: eligible, decision_by: clocks.decision_by, decision_notices: ["NTC_FNMA_D23301_SS_APPROVAL", "NTC_FNMA_D23301_SS_COUNTER", "NTC_FNMA_D23301_SS_DECLINE"], refusal };
}

/** Rule 12.9 D2-3.3-01 / 12.9-T5: closing funds are due within 60 days of approval; later funds without a Fannie Mae extension → the approval has expired and the case is re-evaluated. */
export function shortSaleClosingClock(i: { approved_on: PlainDate; funds_received_on?: PlainDate | null; fnma_extension_id?: string | null }): { close_by: PlainDate; timer: "FNMA_D23301_SS_CLOSE_60"; status: "open" | "closed" | "expired"; approval_expired: boolean; next: "re_evaluate" | null; refusal: string | null } {
  const closeBy = shortSaleClocks(i.approved_on, i.approved_on).close_by!;
  if (!i.funds_received_on) return { close_by: closeBy, timer: "FNMA_D23301_SS_CLOSE_60", status: "open", approval_expired: false, next: null, refusal: null };
  const late = i.funds_received_on > closeBy && !i.fnma_extension_id;
  return { close_by: closeBy, timer: "FNMA_D23301_SS_CLOSE_60", status: late ? "expired" : "closed", approval_expired: late, next: late ? "re_evaluate" : null, refusal: late ? `closing refused: funds ${i.funds_received_on} after the 60-day approval window ${closeBy} without a Fannie Mae extension — approval expired; re-evaluate (D2-3.3-01)` : null };
}

/** Rule 12.9: cash reserves over $50,000 route the case non-delegated with the assets field populated; no delegated approval issues. */
export function delegationRouting(i: { reserves_cents: Cents; net_proceeds_within_parameters: boolean; mi_non_delegated?: boolean }): { route: "delegated" | "non_delegated"; assets_field_cents: Cents | null; delegated_approval_allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (i.reserves_cents > 5_000_000n) reasons.push("cash reserves > $50,000 (D2-3.3-01 delegation limit)");
  if (!i.net_proceeds_within_parameters) reasons.push("net proceeds outside SMDU decision parameters");
  if (i.mi_non_delegated) reasons.push("MI company has not delegated");
  const nd = reasons.length > 0;
  return { route: nd ? "non_delegated" : "delegated", assets_field_cents: nd ? i.reserves_cents : null, delegated_approval_allowed: !nd, reasons };
}

/** Rule 12.9 settlement review: any payment to the borrower beyond the relocation incentive blocks funding and opens a fraud review. */
export function settlementReview(i: { cd_lines: readonly { payee: string; role: "borrower" | "buyer" | "agent" | "lienholder" | "other"; cents: Cents; purpose: string }[]; relocation_cents: Cents }): { borrower_total_cents: Cents; excess_cents: Cents; funding_blocked: boolean; escalation: Escalation | null; finding: string | null } {
  const total = i.cd_lines.filter((l) => l.role === "borrower").reduce((a, l) => a + l.cents, 0n); const excess = total > i.relocation_cents ? total - i.relocation_cents : 0n;
  return { borrower_total_cents: total, excess_cents: excess, funding_blocked: excess > 0n, escalation: excess > 0n ? { kind: "fraud_officer", severity: "sev2", reason: `Closing Disclosure pays the borrower ${excess} cents beyond the relocation incentive` } : null, finding: excess > 0n ? "undisclosed borrower payment on the CD" : null };
}

/** Rule 12.9 holds: no dispositive motion during the listing period; no sale for 60 days after approval; CA → NOD rescission task within 5 BD. */
export function liquidationHolds(i: { phase: "listing" | "approved" | "closed"; approved_on?: PlainDate | null; state?: string; today: PlainDate; requested: "motion_for_judgment" | "sale" | "referral" }): { allowed: boolean; refusal: string | null; hold_until: PlainDate | null; ca_rescission_task_by: PlainDate | null } {
  const ca = i.state === "CA" && i.phase === "approved" && i.approved_on ? addBusinessDays(i.approved_on, 5, servicer) : null;
  if (i.phase === "listing" && i.requested !== "referral") return { allowed: false, refusal: "refused: no dispositive motion or sale while the borrower performs under a short-sale listing (comment 41(g)(3)-1)", hold_until: null, ca_rescission_task_by: ca };
  if (i.phase === "approved" && i.approved_on) { const until = addDays(i.approved_on, 60); const ok = i.today >= until; return { allowed: ok, refusal: ok ? null : `refused: sale/motion held until ${until} after approval (FNMA_E3401_SS_APPROVED_HOLD_60)`, hold_until: until, ca_rescission_task_by: ca }; }
  return { allowed: true, refusal: null, hold_until: null, ca_rescission_task_by: ca };
}

/** Rule 12.9 lease options: Chapter 13 bars the 12-month lease; the 3-month transition needs a principal residence. */
export function dilExitOption(kind: "12_month" | "3_month" | "immediate", inChapter13: boolean, principalResidence: boolean): { allowed: boolean; refusal: string | null } {
  if (kind === "immediate") return { allowed: true, refusal: null };
  const ok = leaseOption(kind, inChapter13, principalResidence);
  return { allowed: ok, refusal: ok ? null : kind === "12_month" ? "12-month lease refused: borrower in an active Chapter 13 case (D2-3.3-02)" : "3-month transition refused: not a principal residence" };
}

/** Rule 12.9 Military Indulgence (D2-3.3-03 / SCRA): DMDC-verified active duty on a pre-service loan → indulgence case, 6% cap from call-up, late charges after call-up waived, status 32, quarterly contact. */
export function militaryIndulgence(i: { dmdc_verified: boolean; loan_originated_on: PlainDate; service_started_on: PlainDate; note_rate_pct: string; late_charges_after_callup_cents: Cents }): { case_opened: boolean; refusal: string | null; rate_cap_pct: "6.000"; cap_applies: boolean; retroactive_from: PlainDate | null; late_charges_waived_cents: Cents; status_code: "32" | null; quarterly_contact: { basis: "D2-3.4-01: contact at least every three months"; every_days: 90; first_contact_by: PlainDate; registry_timer: null } | null } {
  const pre = i.loan_originated_on < i.service_started_on;
  if (!i.dmdc_verified || !pre) return { case_opened: false, refusal: !i.dmdc_verified ? "DMDC verification required" : "loan originated during service — SCRA §3937 rate cap does not apply", rate_cap_pct: "6.000", cap_applies: false, retroactive_from: null, late_charges_waived_cents: 0n, status_code: null, quarterly_contact: null };
  // D2-3.4-01's quarterly-contact duty has no row in spec/registry/timers.json (12.9's timer list omits it); the cadence is stated here without inventing a registry code.
  return { case_opened: true, refusal: null, rate_cap_pct: "6.000", cap_applies: Decimal.parse(i.note_rate_pct).cmp(Decimal.parse("6")) > 0, retroactive_from: i.service_started_on, late_charges_waived_cents: i.late_charges_after_callup_cents, status_code: "32", quarterly_contact: { basis: "D2-3.4-01: contact at least every three months", every_days: 90, first_contact_by: addDays(i.service_started_on, 90), registry_timer: null } };
}

/** Rule 12.9 DIL clocks in one record: 60/90 document window, weekly updates past day 60, lien release 30 BD after vacancy confirmation. */
export function dilCase(i: { acceptance_on: PlainDate; exit_option: "immediate" | "transition_3m" | "lease_12m"; interior_bpo_within_90_days?: boolean; deed_accepted_on?: PlainDate | null; vacancy_confirmed_on?: PlainDate | null; updates?: readonly PlainDate[] }): { docs_deadline: PlainDate; docs_extended_deadline: PlainDate; inspection_order_by: PlainDate | null; weekly_updates_required_from: PlainDate; weekly_cadence_ok: boolean; deed_recordation_submit_by: PlainDate | null; lien_release_due: PlainDate | null } {
  const sorted = [...(i.updates ?? [])].sort(); let maxGap = 0; for (let k = 1; k < sorted.length; k++) maxGap = Math.max(maxGap, daysBetween(sorted[k - 1]!, sorted[k]!));
  // Lien release: 30 servicer BD after the later of acceptance and the inspection confirming vacancy/security (`FNMA_D23302_DIL_LIEN_RELEASE_30BD`); deed submitted for recordation within 5 BD of acceptance (`FNMA_D23302_DIL_DEED_RECORD_5BD`); interior inspection within 60 days unless an interior BPO ≤90 days exists (`FNMA_D23302_DIL_INSPECTION_60`).
  const lienAnchor = i.vacancy_confirmed_on ? (i.vacancy_confirmed_on > i.acceptance_on ? i.vacancy_confirmed_on : i.acceptance_on) : null;
  return { docs_deadline: addDays(i.acceptance_on, 60), docs_extended_deadline: addDays(i.acceptance_on, 90), inspection_order_by: i.interior_bpo_within_90_days === true ? null : addDays(i.acceptance_on, 60), weekly_updates_required_from: addDays(i.acceptance_on, 60), weekly_cadence_ok: maxGap <= 7, deed_recordation_submit_by: i.deed_accepted_on ? addBusinessDays(i.deed_accepted_on, 5, servicer) : null, lien_release_due: lienAnchor ? addBusinessDays(lienAnchor, 30, servicer) : null };
}

export const shortSaleRelocationCents = 750_000n;
export const money = (c: Cents): string => `$${(c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(c % 100n).toString().padStart(2, "0")}`;
export const roundCents = (n: Cents, d: Cents): Cents => divRound(n, d, "HALF_UP");
