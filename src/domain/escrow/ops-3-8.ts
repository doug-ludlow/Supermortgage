/**
 * §3.8 process operations — the waiver case lifecycle facts the 3.8 timers key on, appended by real code paths:
 *
 *   recordWaiverRequest      `escrow.waiver.requested`   the `escrow_waiver` case opened (borrower request / state election);
 *                                                        arms ESC_WAIVER_DECISION_SLA_10BD from `requested_on` and, for an
 *                                                        Illinois election, STATE_IL_765ILCS910_5_TERMINATION_RIGHT_GATE.
 *   recordWaiverEvaluation   `escrow.waiver.evaluating`  the rule engine run with its gate inputs (`hpml_flag`,
 *                                                        `flood_escrow_mandatory`, `flood_line`, `borrower_paid_mi_monthly`);
 *                                                        arms the HPML / flood / MI evaluation gates.
 *   recordWaiverDenial       `escrow.waiver.decided`     the engine's denial (rule outcomes are binding) with all reasons and
 *                                                        the earliest re-request date — the fact that closes the SLA and gates.
 *   trialOfferEscrowGate     `escrow.waiver.exception_documented` / `escrow.waiver.trial_gate.cleared{basis}` — rule 5: a
 *                                                        modification trial on a waived loan needs escrow established unless
 *                                                        the Flex Mod exception (current on T&I) is documented; blocked otherwise.
 *   minnesotaAnniversaryJob  `loan.anniversary{years=5}` the MN 5th-anniversary job (Minn. Stat. 47.20 subd. 9) — arms
 *                                                        STATE_MN_47_20_DISCONTINUE_NOTICE_60 for the discontinue-right notice.
 *
 * The §3 tools (src/app/tools/section03.ts, 3.8 block) call the first three; the trial gate and the anniversary job are the
 * inbound hand-off (§12 trial offer, after ops-3-2's ingestTrialPlanOfferPrepared) and the state job.
 */
import { type PlainDate, addYears, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { evaluateWaiver, type WaiverRequest, type WaiverDecision } from "./waiver.ts";
import { minnesotaDiscontinue, workoutEscrowGate } from "./ops.ts";

export const WAIVER_SLA_TIMER = "ESC_WAIVER_DECISION_SLA_10BD" as const;
export const WAIVER_SLA_BUSINESS_DAYS = 10;
export const TRIAL_GATE_TIMER = "FNMA_B101_WAIVER_REVOKE_BEFORE_TRIAL_GATE" as const;
export const MN_DISCONTINUE_TIMER = "STATE_MN_47_20_DISCONTINUE_NOTICE_60" as const;
export const MN_DISCONTINUE_NOTICE = "NTC_MN_47_20_9_DISCONTINUE_RIGHT" as const;
/** 3.8 data model `escrow_waivers.origin`. */
export type WaiverOrigin = "origination" | "borrower_request" | "state_right" | "transfer_in";
const ORIGINS: ReadonlySet<string> = new Set<WaiverOrigin>(["origination", "borrower_request", "state_right", "transfer_in"]);
const isDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const need = (cond: boolean, what: string): void => { if (!cond) throw new RangeError(what); };
const loanEvents = (events: EventStore, loanId: string, type: string): readonly DomainEvent[] => events.byLoan(loanId).filter((e) => e.type === type);
const forWaiver = (events: EventStore, loanId: string, type: string, waiverId: string): DomainEvent | undefined => loanEvents(events, loanId, type).filter((e) => e.payload.waiver_id === waiverId).at(-1);

/** The request record the rule engine needs (3.8 operational prerequisites); a caller-supplied verdict is never part of it. */
function validateRequest(r: WaiverRequest): void {
  need(isDate(r.requested_on), "request.requested_on must be an ISO date");
  need(typeof r.upb_cents === "bigint" && r.upb_cents >= 0n, "request.upb_cents must be non-negative bigint cents");
  need(typeof r.original_appraised_value_cents === "bigint" && r.original_appraised_value_cents > 0n, "request.original_appraised_value_cents must be positive bigint cents (Fannie Mae 80% test)");
  need(!r.hpml || r.consummation_date === undefined || isDate(r.consummation_date), "request.consummation_date must be an ISO date on an HPML loan");
  need(Array.isArray(r.next_due_dates) && r.next_due_dates.every(isDate), "request.next_due_dates must be ISO due dates");
}

/**
 * Intake: the borrower's request (or IL/MN election) opens the `escrow_waiver` case — `escrow.waiver.requested` with the
 * request date the SLA runs from, the state (an Illinois election arms the 765 ILCS 910/5 gate) and the HPML flag. Idempotent
 * per waiver id: a second intake for an open case returns the existing fact (`already_open`). The agent must not solicit —
 * the origin is the borrower's or the state right's, never the servicer's.
 */
export function recordWaiverRequest(events: EventStore, i: { readonly loan_id: string; readonly waiver_id: string; readonly request: WaiverRequest; readonly origin?: WaiverOrigin }, actor: Actor): { event: DomainEvent; already_open: boolean; decision_due_on: PlainDate; timer: typeof WAIVER_SLA_TIMER } {
  need(!!i.loan_id && !!i.waiver_id, "loan_id and waiver_id are required");
  validateRequest(i.request);
  const origin = i.origin ?? (i.request.state_right_met === true ? "state_right" : "borrower_request");
  need(ORIGINS.has(origin), `origin ${String(origin)} is not an escrow_waivers.origin`);
  const dueOn = addBusinessDays(i.request.requested_on, WAIVER_SLA_BUSINESS_DAYS, servicer);
  const existing = forWaiver(events, i.loan_id, "escrow.waiver.requested", i.waiver_id);
  if (existing) return { event: existing, already_open: true, decision_due_on: String(existing.payload.decision_due_on) as PlainDate, timer: WAIVER_SLA_TIMER };
  const event = events.append({ type: "escrow.waiver.requested", loanId: i.loan_id, actor, payload: {
    waiver_id: i.waiver_id, case_type: "escrow_waiver", origin, requested_on: i.request.requested_on, state: i.request.state ?? null, hpml: i.request.hpml,
    upb_cents: String(i.request.upb_cents), decision_due_on: dueOn, sla_timer: WAIVER_SLA_TIMER } });
  return { event, already_open: false, decision_due_on: dueOn, timer: WAIVER_SLA_TIMER };
}

/**
 * The rule-engine run (rule 1 evaluation order) recorded with the inputs the mandatory-escrow gates read: `hpml_flag`
 * (REGZ_1026_35B3_HPML_ESCROW_5Y_GATE / _LTV_GATE), `flood_escrow_mandatory` + `flood_line` (FLOOD_12CFR22_5_ESCROW_GATE)
 * and `borrower_paid_mi_monthly` (FNMA_B101_MI_MONTHLY_ESCROW_GATE). `waived_line_types` is what the request asks to waive.
 */
export function recordWaiverEvaluation(events: EventStore, i: { readonly loan_id: string; readonly waiver_id: string | null; readonly request: WaiverRequest; readonly waived_line_types: readonly string[]; readonly evaluated_on: PlainDate }, actor: Actor): { event: DomainEvent; decision: WaiverDecision } {
  need(!!i.loan_id, "loan_id is required");
  need(isDate(i.evaluated_on), "evaluated_on must be an ISO date");
  validateRequest(i.request);
  const decision = evaluateWaiver(i.request, i.evaluated_on);
  const lines = [...i.waived_line_types];
  const event = events.append({ type: "escrow.waiver.evaluating", loanId: i.loan_id, actor, payload: {
    waiver_id: i.waiver_id, evaluated_on: i.evaluated_on, requested_on: i.request.requested_on, waived_line_types: lines,
    hpml_flag: i.request.hpml, consummation_date: i.request.consummation_date ?? null, flood_escrow_mandatory: i.request.flood_escrow_mandatory, flood_line: lines.includes("flood"),
    borrower_paid_mi_monthly: i.request.monthly_mi_line, mi_line: lines.includes("mi"), state: i.request.state ?? null, state_right_met: i.request.state_right_met === true,
    engine_decision: decision.decision, reasons: decision.reasons, lines_kept: decision.lines_kept, re_request_on: decision.re_request_on, effective_on: decision.effective_on } });
  return { event, decision };
}

/**
 * Rule 3: the engine's denial is the decision (rule outcomes are binding) — `escrow.waiver.decided{decision=denied}` with all
 * failed reasons, the earliest re-request date (null when a reason is permanent) and the B-1-01 / §1026.35(b) / 22.5 basis
 * retained. Once per waiver id; an approval is approveWaiver's fact, never this one's.
 */
export function recordWaiverDenial(events: EventStore, i: { readonly loan_id: string; readonly waiver_id: string; readonly decision: WaiverDecision; readonly decided_on: PlainDate }, actor: Actor): { event: DomainEvent; already_decided: boolean } {
  need(!!i.loan_id && !!i.waiver_id, "loan_id and waiver_id are required");
  need(i.decision.decision === "denied", `recordWaiverDenial records the engine's denial; this decision is ${i.decision.decision}`);
  need(isDate(i.decided_on), "decided_on must be an ISO date");
  const existing = forWaiver(events, i.loan_id, "escrow.waiver.decided", i.waiver_id);
  if (existing) return { event: existing, already_decided: true };
  const event = events.append({ type: "escrow.waiver.decided", loanId: i.loan_id, actor, payload: {
    waiver_id: i.waiver_id, decision: "denied", decided_on: i.decided_on, reasons: i.decision.reasons, re_request_on: i.decision.re_request_on, permanent: i.decision.re_request_on === null,
    effective_on: null, lines_kept: i.decision.lines_kept, state_right_applied: false, basis: "B-1-01; 12 CFR 1026.35(b)(3); 12 CFR 22.5", notice: "NTC_SM_ESCROW_WAIVER_DECISION" } });
  return { event, already_decided: false };
}

/** Whether the loan is currently waived: the latest waiver fact (an approval/partial decision or a waiver-approved closure) not followed by a revocation or establishment. */
export function isWaived(events: EventStore, loanId: string): boolean {
  let waived = false;
  for (const e of events.byLoan(loanId)) {
    if (e.type === "loan.boarded" && e.payload.escrow_waived === true) waived = true;
    else if (e.type === "escrow.waiver.decided" && (e.payload.decision === "approved" || e.payload.decision === "partial")) waived = true;
    else if (e.type === "escrow.account.closed" && e.payload.reason === "waiver_approved") waived = true;
    else if (e.type === "escrow.waiver.revoked" || e.type === "escrow.account.established") waived = false;
  }
  return waived;
}

/** Workout programs whose trial offer the gate applies to (3.2 WorkoutProgram spelling); the Flex Mod exception is D2-3.2-06's alone. */
const FLEX_MOD = "flex_modification";
export interface TrialGateInput { readonly loan_id: string; readonly offer_id: string; readonly program: string; readonly current_on_ti: boolean; /** Overrides the event-derived waiver status (e.g. a boarded-waived loan whose evidence lives in the boarding record). */ readonly waived?: boolean; }
export interface TrialGateResult { readonly proceed: boolean; readonly waived: boolean; readonly basis: "escrow_established" | "exception_documented" | null; readonly block: string | null; readonly event: DomainEvent; readonly timer: typeof TRIAL_GATE_TIMER; }
/**
 * Rule 5 / T7: before a modification trial the waiver is revoked and escrow established, unless the borrower is current on all
 * T&I items and the modification is a Flex Mod (D2-3.2-06) — then the exception is documented (`escrow.waiver.exception_documented`)
 * and the offer proceeds. Either clearance is recorded as `escrow.waiver.trial_gate.cleared{basis}` (the fact that closes
 * FNMA_B101_WAIVER_REVOKE_BEFORE_TRIAL_GATE); a delinquent-T&I waived loan is blocked (`escrow.waiver.trial_offer_blocked`)
 * until the 3.7 advance revokes the waiver and establishes the account. Needs the §12 hand-off ingested first (ops-3-2).
 */
export function trialOfferEscrowGate(events: EventStore, i: TrialGateInput, actor: Actor): TrialGateResult {
  need(!!i.loan_id && !!i.offer_id, "loan_id and offer_id are required");
  need(typeof i.current_on_ti === "boolean", "current_on_ti must state whether the borrower is current on all taxes, insurance and related items");
  const prepared = loanEvents(events, i.loan_id, "lossmit.trial_plan.offer_prepared").filter((e) => e.payload.offer_id === i.offer_id).at(-1);
  need(prepared !== undefined, `no prepared trial plan offer ${i.offer_id} on ${i.loan_id}: ingest the §12 hand-off first (ops-3-2 ingestTrialPlanOfferPrepared)`);
  const waived = i.waived ?? isWaived(events, i.loan_id);
  const exception = waived && i.program === FLEX_MOD && i.current_on_ti;
  const gate = workoutEscrowGate({ waived, current_on_ti: i.current_on_ti, exception_documented: exception });
  const common = { offer_id: i.offer_id, program: i.program, waived, current_on_ti: i.current_on_ti, timer: TRIAL_GATE_TIMER };
  if (!waived) {
    const event = events.append({ type: "escrow.waiver.trial_gate.cleared", loanId: i.loan_id, actor, causationId: prepared!.id, payload: { ...common, basis: "escrow_established" } });
    return { proceed: true, waived, basis: "escrow_established", block: null, event, timer: TRIAL_GATE_TIMER };
  }
  if (gate.ok) {
    const documented = events.append({ type: "escrow.waiver.exception_documented", loanId: i.loan_id, actor, causationId: prepared!.id, payload: { ...common, exception: "flex_mod_current_on_ti", basis: "B-1-01 (revoke before the trial period unless current on all T&I items and the modification is a Flex Modification, D2-3.2-06)" } });
    const event = events.append({ type: "escrow.waiver.trial_gate.cleared", loanId: i.loan_id, actor, causationId: documented.id, payload: { ...common, basis: "exception_documented", exception_event_id: documented.id } });
    return { proceed: true, waived, basis: "exception_documented", block: null, event, timer: TRIAL_GATE_TIMER };
  }
  const reason = i.program === FLEX_MOD ? gate.block! : `program ${i.program} has no escrow-waiver exception: revoke the waiver and establish escrow before the trial period (B-1-01)`;
  const event = events.append({ type: "escrow.waiver.trial_offer_blocked", loanId: i.loan_id, actor, causationId: prepared!.id, payload: { ...common, reason, breach: "trial offer command refused" } });
  return { proceed: false, waived, basis: null, block: reason, event, timer: TRIAL_GATE_TIMER };
}

/**
 * The MN anniversary job: on or after the fifth anniversary of the mortgage date it appends `loan.anniversary{years=5,
 * of=mortgage_date, anniversary}` once per loan — the trigger of STATE_MN_47_20_DISCONTINUE_NOTICE_60 (notice within 60 days,
 * Minn. Stat. 47.20 subd. 9). Non-MN loans and loans short of the anniversary produce no fact.
 */
export function minnesotaAnniversaryJob(events: EventStore, i: { readonly loan_id: string; readonly state: string; readonly mortgage_date: PlainDate; readonly today: PlainDate }, actor: Actor): { due: boolean; anniversary: PlainDate; notice_due_on: PlainDate; event: DomainEvent | null; already_recorded: boolean } {
  need(!!i.loan_id, "loan_id is required");
  need(isDate(i.mortgage_date) && isDate(i.today), "mortgage_date and today must be ISO dates");
  const r = minnesotaDiscontinue({ mortgage_date: i.mortgage_date, today: i.today, written_election: false, late_over_30_in_12m: 0, fnma_80_test_passed: true });
  if (i.state !== "MN" || i.today < r.anniversary) return { due: false, anniversary: r.anniversary, notice_due_on: r.notice_due_on, event: null, already_recorded: false };
  const existing = loanEvents(events, i.loan_id, "loan.anniversary").find((e) => String(e.payload.years) === "5" && e.payload.of === "mortgage_date");
  if (existing) return { due: true, anniversary: r.anniversary, notice_due_on: r.notice_due_on, event: existing, already_recorded: true };
  const event = events.append({ type: "loan.anniversary", loanId: i.loan_id, actor, payload: { years: 5, n: 5, of: "mortgage_date", mortgage_date: i.mortgage_date, anniversary: r.anniversary, state: "MN", observed_on: i.today, notice_due_on: r.notice_due_on, template: MN_DISCONTINUE_NOTICE, timer: MN_DISCONTINUE_TIMER } });
  return { due: true, anniversary: r.anniversary, notice_due_on: r.notice_due_on, event, already_recorded: false };
}

/** The notice payload NTC_MN_47_20_9_DISCONTINUE_RIGHT renders from the anniversary fact (its checklist's `days_after_anniversary` ≤ 60). */
export function minnesotaDiscontinuePayload(anniversary: DomainEvent, sentOn: PlainDate, contact: { servicer_phone: string; exclusive_address: string }): Record<string, unknown> {
  const on = String(anniversary.payload.anniversary) as PlainDate;
  const days = Math.round((Date.parse(sentOn) - Date.parse(on)) / 86_400_000);
  return { mortgage_date: anniversary.payload.mortgage_date, anniversary: on, days_after_anniversary: days, notice_due_on: addDays(on, 60), fifth_anniversary_of: addYears(on, -5), ...contact };
}
