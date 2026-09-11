/**
 * §12.2 operating rules over the pure calculators in evaluation.ts / ops.ts — the event-emitting steps of the
 * complete-application evaluation lifecycle that the 12.2 timer rows (timers-12-2.ts, ./timers.ts) are armed and
 * satisfied by. Every function validates its inbound record and returns the events to append (the tool handler in
 * src/app/tools/section12-2.ts appends them); nothing here touches the store or the clock.
 *   - third-party requests placed for every outstanding item (§1024.41(c)(4)(i); `REGX_1024_41C4_THIRD_PARTY_REQUEST_PROMPT`)
 *   - decision draft → reviewer SLA with the "1 BD if <10 days remain, never past day 30" tightening (`SM_LM_REVIEWER_DENIAL_APPROVAL_2BD`)
 *   - reviewer decision with independence (reviewer ≠ evaluator run owner; NY supervisory — 3 NYCRR 419.7(f))
 *   - acceptance by trial payment and the (e)(2)(ii) reasonable period for the other acceptance items (`REGX_1024_41E2II_TRIAL_OTHER_REQS_REASONABLE`)
 *   - the SMDU adapter callback (`smdu.case.decisioned{declined, borrower_current}` → Form 182 / Reg B clocks)
 *   - "CA denial provided" (`lossmit.denial.provided{state}` arms `CA_CIV_2923_6E_NOD_NOS_HOLD_31`) and the gate sweep that
 *     records `timer.lapsed{code}` once a not_before_gate's day has passed (Cal. Civ. Code §2923.6(e) "timer lapse")
 *   - deemed rejection after the policy grace (§1024.41(e)(2)(i); rule 7) and the `lm_offer_pending` hold release.
 * Money is bigint cents; dates are PlainDate.
 */
import { type PlainDate, addDays, daysBetween, min } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { appealWindow, type Option } from "./evaluation.ts";
import { deemedRejection, nyOverlay } from "./ops.ts";

export interface EmittedEvent { readonly type: string; readonly payload: Record<string, unknown>; }

// ============================================================ third-party requests (§1024.41(c)(4)(i); comment 41(c)(4)(i)-1)
/** Adapter each third-party item is requested through (12.2 Integrations). */
export const THIRD_PARTY_ADAPTERS: Readonly<Record<string, string>> = { BPO: "valuation-order-api", APPRAISAL: "valuation-order-api", AVM: "valuation-order-api", VALUATION: "valuation-order-api", MI: "mi", MI_DECISION: "mi", CREDIT: "credit-bureau", CREDIT_REPORT: "credit-bureau", TITLE: "title-vendor" };
export function thirdPartyAdapter(item: string): string {
  const a = THIRD_PARTY_ADAPTERS[item.toUpperCase()];
  if (!a) throw new RangeError(`no adapter for third-party item ${item} (12.2 Integrations: valuation, MI, consumer report, title)`);
  return a;
}
/**
 * Place the request for every outstanding third-party item "promptly" — one `integration_messages.sent` per item; the
 * clock is satisfied only by the last one (`items_remaining=0`). A request for an item the evaluation is not waiting on,
 * or a set that leaves an item unrequested, is refused so a partial batch can never satisfy the row.
 */
export function thirdPartyRequests(i: { evaluation_id: string; outstanding: readonly string[]; items: readonly string[]; requested_on: PlainDate; started_on: PlainDate }): { events: EmittedEvent[]; request_by: PlainDate; on_time: boolean } {
  if (!i.items.length) throw new RangeError("items is required: at least one third-party item to request");
  const outstanding = new Set(i.outstanding);
  for (const item of i.items) if (!outstanding.has(item)) throw new RangeError(`third-party item ${item} is not outstanding on ${i.evaluation_id}`);
  const missing = i.outstanding.filter((x) => !i.items.includes(x));
  if (missing.length) throw new RangeError(`every outstanding item must be requested together: missing ${missing.join(", ")} (§1024.41(c)(4)(i))`);
  const requestBy = addBusinessDays(i.started_on, 2, servicer);
  const uniq = [...new Set(i.items)];
  const events = uniq.map((item, n) => ({ type: "integration_messages.sent", payload: { kind: "third_party_request", evaluation_id: i.evaluation_id, item, adapter: thirdPartyAdapter(item), direction: "outbound", requested_on: i.requested_on, items_remaining: uniq.length - n - 1 } }));
  return { events, request_by: requestBy, on_time: i.requested_on <= requestBy };
}

// ============================================================ decision draft → reviewer SLA (rule 6; SM_LM_REVIEWER_DENIAL_APPROVAL_2BD)
export type DeterminationResultCode = "offered" | "denied" | "not_evaluated_ranking" | "not_evaluated_ineligible_by_loan_data" | "pending_third_party" | "referred_to_fnma";
export interface DraftDetermination { readonly option: Option; readonly result: DeterminationResultCode; readonly reason_codes?: readonly string[]; }
const MODIFICATION_OPTIONS: readonly Option[] = ["flex_mod"];
const REASON_CODE = /^(INV_FNMA|FNMA|REGX|SM|AFFORD|NPV)_[A-Z0-9_]+$/;
/** Rule 1/5: a modification option excluded by loan data alone is still a denial for §1024.41(d); any denial or ineligibility routes to the reviewer (rule 6). */
export function hasDenial(determinations: readonly DraftDetermination[]): boolean {
  return determinations.some((d) => d.result === "denied" || (d.result === "not_evaluated_ineligible_by_loan_data" && MODIFICATION_OPTIONS.includes(d.option)));
}
/** Reviewer SLA: 2 servicer business days from the draft, 1 if fewer than 10 days remain on the 30-day clock, never past the 30-day date. */
export function reviewerDue(draftedOn: PlainDate, completeOn: PlainDate): { due: PlainDate; business_days: 1 | 2; days_remaining: number; day30: PlainDate } {
  const day30 = addDays(completeOn, 30); const remaining = daysBetween(draftedOn, day30);
  const bd: 1 | 2 = remaining < 10 ? 1 : 2;
  return { due: min(addBusinessDays(draftedOn, bd, servicer), day30), business_days: bd, days_remaining: remaining, day30 };
}
export function draftDecision(i: { evaluation_id: string; complete_on: PlainDate; drafted_on: PlainDate; determinations: readonly DraftDetermination[]; discretionary_c2ii?: boolean; duplicative?: boolean; reg_b_adverse?: boolean }): { status: "decision_drafted" | "reviewer_pending"; has_denial: boolean; reviewer_required: boolean; review_due: PlainDate; review_business_days: 1 | 2; days_remaining: number; events: EmittedEvent[] } {
  if (!i.determinations.length) throw new RangeError("determinations is required: every option gets a determination row (12.2 rule 5)");
  for (const d of i.determinations) for (const c of d.reason_codes ?? []) if (!REASON_CODE.test(c)) throw new RangeError(`reason code ${c} is not from the catalog (12.2 guardrail)`);
  if (i.determinations.some((d) => d.option === "flex_mod" && (d.reason_codes ?? []).includes("NPV_NEGATIVE"))) throw new RangeError("NPV_NEGATIVE is disabled for flex_mod under fnma.workout.2026-08 (12.2 rule 5)");
  const denial = hasDenial(i.determinations);
  const reviewer = denial || Boolean(i.discretionary_c2ii) || Boolean(i.duplicative) || Boolean(i.reg_b_adverse);
  const due = reviewerDue(i.drafted_on, i.complete_on);
  return { status: reviewer ? "reviewer_pending" : "decision_drafted", has_denial: denial, reviewer_required: reviewer, review_due: due.due, review_business_days: due.business_days, days_remaining: due.days_remaining,
    events: [{ type: "lossmit.evaluation.decision_drafted", payload: { evaluation_id: i.evaluation_id, has_denial: denial, reviewer_required: reviewer, drafted_on: i.drafted_on, review_due: due.due, review_business_days: due.business_days, days_remaining: due.days_remaining, day30: due.day30, determinations: i.determinations.map((d) => ({ option: d.option, result: d.result, reason_codes: [...(d.reason_codes ?? [])] })) } }] };
}

// ============================================================ reviewer decision (rule 6; assertReviewerIndependence; NY 419.7(f))
export interface Reviewer { readonly id: string; readonly role: string; readonly supervisory?: boolean; readonly involved_in_evaluation?: boolean; }
export function reviewDecision(i: { evaluation_id: string; reviewer: Reviewer; evaluator_run_owner?: string | null; decision: "approved" | "edited" | "returned"; state?: string | null; reviewed_on: PlainDate; edits?: readonly string[] }): { status: "decided" | "evaluating"; supervisory_reviewer_recorded: boolean; events: EmittedEvent[] } {
  if (i.reviewer.role !== "lossmit_reviewer") throw new RangeError(`reviewer must hold lossmit_reviewer (got ${i.reviewer.role})`);
  if (i.evaluator_run_owner && i.reviewer.id === i.evaluator_run_owner) throw new RangeError("reviewer independence: the reviewer may not be the evaluator run owner (12.2 assertReviewerIndependence)");
  if (i.reviewer.involved_in_evaluation) throw new RangeError("reviewer independence: the reviewer was involved in the evaluation (12.2 assertReviewerIndependence)");
  if (i.state === "NY") { const ny = nyOverlay({ provided_on: i.reviewed_on, tier: "ge_90", denial: true, reviewer: { id: i.reviewer.id, supervisory: Boolean(i.reviewer.supervisory), involved_in_evaluation: Boolean(i.reviewer.involved_in_evaluation) } }); if (ny.refusal) throw new RangeError(ny.refusal); }
  const supervisory = i.state === "NY" ? Boolean(i.reviewer.supervisory) : false;
  return { status: i.decision === "returned" ? "evaluating" : "decided", supervisory_reviewer_recorded: supervisory,
    events: [{ type: "lossmit.evaluation.reviewed", payload: { evaluation_id: i.evaluation_id, reviewer_id: i.reviewer.id, decision: i.decision, supervisory, state: i.state ?? null, reviewed_on: i.reviewed_on, edits: [...(i.edits ?? [])] } }] };
}

// ============================================================ acceptance by payment (rule 8; §1024.41(e)(2)(ii); REGX_1024_41E2II_TRIAL_OTHER_REQS_REASONABLE)
export const TRIAL_OTHER_ITEMS_REASONABLE_DAYS = 14;
export function trialFirstPayment(i: { offer_id: string; evaluation_id: string | null; option: Option | string; payment_date: PlainDate; due_on: PlainDate; amount_cents: Cents; required_cents: Cents; acceptance_items_outstanding: readonly string[]; tier?: string | null; state?: string | null }): { accepted_by_payment: boolean; other_acceptance_items_missing: boolean; reasonable_period_by: PlainDate | null; events: EmittedEvent[] } {
  if (typeof i.amount_cents !== "bigint" || typeof i.required_cents !== "bigint") throw new RangeError("amount_cents and required_cents are bigint cents");
  if (i.amount_cents <= 0n) throw new RangeError("amount_cents must be positive");
  const onTime = i.payment_date <= i.due_on && i.amount_cents >= i.required_cents;
  const missing = i.acceptance_items_outstanding.length > 0;
  const by = onTime && missing ? addDays(i.payment_date, TRIAL_OTHER_ITEMS_REASONABLE_DAYS) : null;
  const events: EmittedEvent[] = [{ type: "lossmit.trial.first_payment_received", payload: { offer_id: i.offer_id, evaluation_id: i.evaluation_id, option: i.option, payment_date: i.payment_date, due_on: i.due_on, amount_cents: i.amount_cents.toString(), required_cents: i.required_cents.toString(), accepted_by_payment: onTime, acceptance: onTime, other_acceptance_items_missing: onTime && missing, acceptance_items_missing: onTime && missing, acceptance_items_outstanding: [...i.acceptance_items_outstanding], reasonable_period_by: by } }];
  if (onTime) events.push({ type: "lossmit.offer.responded", payload: { offer_id: i.offer_id, evaluation_id: i.evaluation_id, option: i.option, response: "accepted", accepted_via: "payment", responded_on: i.payment_date, tier: i.tier ?? null, state: i.state ?? null, disaster: i.option === "disaster_payment_deferral" } });
  return { accepted_by_payment: onTime, other_acceptance_items_missing: onTime && missing, reasonable_period_by: by, events };
}
export function acceptanceItemsReceived(i: { offer_id: string; outstanding: readonly string[]; items: readonly string[]; received_on: PlainDate }): { items_remaining: string[]; complete: boolean; events: EmittedEvent[] } {
  if (!i.items.length) throw new RangeError("items is required");
  for (const item of i.items) if (!i.outstanding.includes(item)) throw new RangeError(`acceptance item ${item} is not outstanding on ${i.offer_id}`);
  const remaining = i.outstanding.filter((x) => !i.items.includes(x));
  // 'items received' is the satisfier: a partial batch is recorded as `.partial`; `.received` is appended only by the batch that clears the list (items_remaining=0).
  const payload = { offer_id: i.offer_id, items: [...i.items], received_on: i.received_on, items_remaining: remaining.length, outstanding: remaining };
  return { items_remaining: remaining, complete: remaining.length === 0, events: [{ type: remaining.length === 0 ? "lossmit.offer.acceptance_items.received" : "lossmit.offer.acceptance_items.partial", payload }] };
}

// ============================================================ SMDU adapter callback (Integrations; D2-1-01 Form 182; Reg B §1002.9)
export const SMDU_CASE_TYPES = ["IMMINENT_DEFAULT", "PAYMENT_DEFERRAL", "DISASTER_PAYMENT_DEFERRAL", "FLEX_MOD_TPP", "TPP_PAYMENT", "MOD_CLOSING", "SHORT_SALE_DELEGATED", "SHORT_SALE_NON_DELEGATED", "MORTGAGE_RELEASE", "CHARGE_OFF", "SECOND_LIEN", "VALUATION_ORDER", "FORBEARANCE", "REPAYMENT_PLAN"] as const;
export type SmduCaseType = (typeof SMDU_CASE_TYPES)[number];
export type SmduDecision = "approved" | "declined" | "refer";
export function ingestSmduDecision(i: { case_id: string; case_type: string; decision: string; borrower_current: boolean; decided_on: PlainDate; evaluation_id?: string | null; reasons?: readonly string[]; non_delegated?: boolean }): { status: "decisioned" | "declined" | "fnma_referral_pending"; declined: boolean; form182_required: boolean; form182_by: PlainDate | null; rep_warrant_relief: boolean; events: EmittedEvent[] } {
  if (!i.case_id) throw new RangeError("case_id is required");
  if (!(SMDU_CASE_TYPES as readonly string[]).includes(i.case_type)) throw new RangeError(`case_type ${i.case_type} is not an SMDU case type (12.2 Integrations)`);
  if (i.decision !== "approved" && i.decision !== "declined" && i.decision !== "refer") throw new RangeError(`decision ${i.decision} must be approved, declined or refer`);
  if (typeof i.borrower_current !== "boolean") throw new RangeError("borrower_current is required (D2-1-01: a current borrower's decline is Reg B adverse action)");
  const declined = i.decision === "declined";
  const refer = i.decision === "refer" || Boolean(i.non_delegated);
  const form182 = declined && i.borrower_current;
  return { status: refer ? "fnma_referral_pending" : declined ? "declined" : "decisioned", declined, form182_required: form182, form182_by: form182 ? addDays(i.decided_on, 30) : null, rep_warrant_relief: !refer,
    events: [{ type: "smdu.case.decisioned", payload: { case_id: i.case_id, case_type: i.case_type, decision: i.decision, declined, borrower_current: i.borrower_current, decided_on: i.decided_on, evaluation_id: i.evaluation_id ?? null, reasons: [...(i.reasons ?? [])], rep_warrant_relief: !refer, fnma_referral_pending: refer, form182_required: form182, form182_by: form182 ? addDays(i.decided_on, 30) : null } }] };
}

// ============================================================ "CA denial provided" (Cal. Civ. Code §2923.6(e); CA_CIV_2923_6E_NOD_NOS_HOLD_31)
/**
 * The Notice Registry's `notice.sent` carries `{notice_id, template, channels, sent_at}` only, so the 12.2 denial path
 * emits `lossmit.denial.provided{state, provided_at, template}` after the send — the CA gate keys on `state=CA`.
 */
export function denialProvided(i: { notice_id: string; template: string; state: string | null; provided_on: PlainDate; tier: string | null; evaluation_id: string | null; option?: string | null }): { appeal_days: 14 | 30; appeal_by: PlainDate; ca_nod_nos_hold_until: PlainDate | null; events: EmittedEvent[] } {
  if (!i.notice_id) throw new RangeError("notice_id is required");
  if (!/DENIAL/.test(i.template)) throw new RangeError(`${i.template} is not a denial template`);
  const appealDays: 14 | 30 = i.state === "CA" ? 30 : 14;
  const hold = i.state === "CA" ? addDays(i.provided_on, 31) : null;
  return { appeal_days: appealDays, appeal_by: appealWindow(i.provided_on, i.state ?? undefined), ca_nod_nos_hold_until: hold,
    events: [{ type: "lossmit.denial.provided", payload: { notice_id: i.notice_id, template: i.template, kind: "denial", state: i.state, provided_at: i.provided_on, tier: i.tier, evaluation_id: i.evaluation_id, option: i.option ?? null, appeal_days: appealDays, appeal_by: appealWindow(i.provided_on, i.state ?? undefined), ca_nod_nos_hold_until: hold } }] };
}

// ============================================================ gate sweep: not_before_gate "timer lapse"
export interface GateInstance { readonly id: string; readonly code: string; readonly status: string; readonly dueAt?: number; readonly dueDate?: PlainDate; readonly loanId?: string; }
/** Every armed instance of `code` whose due instant has passed at `nowIso` lapses: `timer.lapsed{code, timer_id}` is what satisfies the gate row. */
export function gateLapses(instances: readonly GateInstance[], code: string, nowIso: string): { lapsed: { timer_id: string; due_date: PlainDate | null }[]; events: EmittedEvent[] } {
  if (!code) throw new RangeError("code is required");
  const now = Date.parse(nowIso); if (Number.isNaN(now)) throw new RangeError(`now ${nowIso} is not an instant`);
  const today = wallClock(now, "America/New_York").date;
  const lapsed = instances.filter((t) => t.code === code && t.status === "armed" && t.dueAt !== undefined && t.dueAt <= now).map((t) => ({ timer_id: t.id, due_date: t.dueDate ?? null }));
  return { lapsed, events: lapsed.map((l) => ({ type: "timer.lapsed", payload: { code, timer_id: l.timer_id, due_date: l.due_date, lapsed_on: today } })) };
}

// ============================================================ deemed rejection (rule 7; §1024.41(e)(2)(i); open question 1)
export function deemedRejectionSweep(i: { offer_id: string; evaluation_id: string | null; option: string | null; accept_by: PlainDate; window_days: number; today: PlainDate; responded: boolean; other_pending_offer: boolean; appeal_pending: boolean; all_options_rejected: boolean }): { deemed_rejected: boolean; deemed_rejected_on: PlainDate; hold_released: boolean; g2_satisfied: boolean; events: EmittedEvent[] } {
  const r = deemedRejection({ accept_by: i.accept_by, window_days: i.window_days, today: i.today, responded: i.responded, other_pending_offer: i.other_pending_offer, appeal_pending: i.appeal_pending });
  const events: EmittedEvent[] = [];
  if (r.deemed_rejected) {
    events.push({ type: "lossmit.offer.deemed_rejected", payload: { offer_id: i.offer_id, evaluation_id: i.evaluation_id, option: i.option, accept_by: i.accept_by, grace_days: r.grace_days, deemed_rejected_on: r.deemed_rejected_on, hold_released: r.hold_released, hold_kind: r.hold_kind } });
    if (r.hold_released) events.push({ type: "foreclosure_holds.closed", payload: { kind: r.hold_kind, offer_id: i.offer_id, reason: `deemed rejected ${r.deemed_rejected_on} (§1024.41(e)(2)(i))`, g2_satisfied: i.all_options_rejected } });
  }
  return { deemed_rejected: r.deemed_rejected, deemed_rejected_on: r.deemed_rejected_on, hold_released: r.hold_released, g2_satisfied: r.hold_released && i.all_options_rejected, events };
}
