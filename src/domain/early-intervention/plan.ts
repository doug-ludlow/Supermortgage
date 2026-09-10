/**
 * §11.1 Fannie Mae D2-2-02 contact cadence — the per-loan `contact_attempt_plans`
 * state machine: `not_started → active (cycles every 7 days) → ceased{reason} → active`
 * on a resume trigger, `suspended{reason}` for bankruptcy / cease / attorney /
 * pre-sale, terminal `closed` on cure, payoff, title transfer or transfer-out.
 * Every transition returns the domain events the timers arm and satisfy on
 * (`contact.attempted`, `contact.completed`, `contact.live.established`,
 * `contact.plan.cycle_closed`, `contact.plan.ceased`, …); the command layer
 * (dial request) refuses any outbound attempt the plan or a pre-dial check
 * does not permit.
 */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { type Calendar, servicer } from "../../kernel/calendar/business.ts";
import { liveSatisfiedEvent } from "./windows.ts";

export const FIRST_ATTEMPT_DAY = 17;   // 11.1 rule 5 / 11.1-Q2 (policy; partner may set 16–25)
export const CYCLE_DAYS = 7;           // D2-2-02 "continue every 7 days"
/** The D2-2-02 cadence clocks a cease/suspend/close cancels (11.1 timer table: "cancelled by plan ceased/suspended/closed"); read by timers.ts `attachEarlyInterventionTimerCancellations`. */
export const FNMA_CADENCE_TIMERS = ["FNMA_D2202_OUTBOUND_EVERY_7", "FNMA_D2202_OUTBOUND_START_36", "FNMA_D2202_CONTINUE_AFTER_210"] as const;

export type PlanStatus = "not_started" | "active" | "ceased" | "suspended" | "closed";
export type CeaseReason = "qrpc_workout" | "resolved" | "brp_complete" | "ptp_pending" | "qrpc_no_interest" | "pre_sale_stop" | "bankruptcy" | "cease_request" | "attorney" | "transfer_out" | "deceased_pending_sii";
export type SuspendReason = "bankruptcy" | "cease_request" | "attorney" | "pre_sale_stop";
export type ResumeTrigger = "promise_broken" | "workout_failure" | "brp_incomplete" | "new_delinquency" | "sale_postponed" | "bankruptcy_resolved" | "cease_withdrawn" | "attorney_nonresponse" | "qrpc_stale";
export type CloseReason = "cured" | "paid_off" | "title_transferred" | "transfer_out";

export interface PlanEvent { readonly type: string; readonly payload: Record<string, unknown>; }
export interface PlanAttempt { readonly contact_id: string; readonly on: PlainDate; readonly mode: "ai_voice" | "human_voice" | "sms" | "email" | "letter"; readonly outcome: string; readonly live_contact: boolean; readonly daypart?: "morning" | "afternoon" | "evening" | "weekend"; readonly person?: string; readonly number_id?: string | null; episode?: number; }
/** One active stretch of the cadence: from open/resume to cease/suspend/close, anchored on the earliest unpaid due date it was opened for. */
export interface PlanEpisode { readonly no: number; readonly opened_on: PlainDate; readonly due_date: PlainDate | null; readonly trigger: "day_17" | ResumeTrigger; closed_on: PlainDate | null; }
export interface ContactPlan {
  readonly loan_id: string;
  status: PlanStatus;
  cease_reason: CeaseReason | null;
  suspend_reason: SuspendReason | null;
  close_reason: CloseReason | null;
  cycle_no: number;
  cycle_start: PlainDate | null;
  /** Last attempt + 7 (holiday-shifted) while active; null when not active. */
  cycle_due_at: PlainDate | null;
  last_attempt_on: PlainDate | null;
  opened_on: PlainDate | null;
  resume_at: PlainDate | null;
  readonly attempts: PlanAttempt[];
  readonly episodes: PlanEpisode[];
  readonly history: string[];
}

/** `active` / `ceased{ptp_pending}` / `suspended{bankruptcy}` — the notation the spec uses for plan state. */
export function planState(p: ContactPlan): string {
  if (p.status === "ceased") return `ceased{${p.cease_reason}}`;
  if (p.status === "suspended") return `suspended{${p.suspend_reason}}`;
  if (p.status === "closed") return `closed{${p.close_reason}}`;
  return p.status;
}

export function newPlan(loanId: string): ContactPlan {
  return { loan_id: loanId, status: "not_started", cease_reason: null, suspend_reason: null, close_reason: null, cycle_no: 0, cycle_start: null, cycle_due_at: null, last_attempt_on: null, opened_on: null, resume_at: null, attempts: [], episodes: [], history: [] };
}

const note = (p: ContactPlan, on: PlainDate, what: string): void => { p.history.push(`${on} ${what}`); };
/** The canonical §1024.39(a) satisfier (windows.ts) emitted alongside `contact.live.established`; the plan knows the loan, not the windows. */
const liveEvent = (p: ContactPlan, a: PlanAttempt): PlanEvent => { const e = liveSatisfiedEvent(null, "contact.live.established", a.on, { contact_id: a.contact_id }); return { type: e.type, payload: { ...e.payload, loan_id: p.loan_id } }; };
const shift = (d: PlainDate, cal: Calendar): PlainDate => { let x = d; while (!cal.isBusinessDay(x)) x = addDays(x, 1); return x; };
const currentEpisode = (p: ContactPlan): PlanEpisode | undefined => p.episodes[p.episodes.length - 1];
const openEpisode = (p: ContactPlan, on: PlainDate, dueDate: PlainDate | null, trigger: PlanEpisode["trigger"]): void => { p.episodes.push({ no: p.episodes.length + 1, opened_on: on, due_date: dueDate, trigger, closed_on: null }); };
const closeEpisode = (p: ContactPlan, on: PlainDate): void => { const e = currentEpisode(p); if (e && e.closed_on === null) e.closed_on = on; };

/** 11.1 rule 5: the plan opens on the first day the counter reaches day 17 (all loans, principal residence or not). */
export function openPlanIfDue(p: ContactPlan, regxDays: number, today: PlainDate, o: { due_date?: PlainDate | null } = {}): PlanEvent[] {
  if (p.status !== "not_started" || regxDays < FIRST_ATTEMPT_DAY) return [];
  p.status = "active"; p.opened_on = today; p.cycle_no = 1; p.cycle_start = today; p.cycle_due_at = today;
  openEpisode(p, today, o.due_date ?? null, "day_17");
  note(p, today, `active (day ${regxDays})`);
  return [{ type: "contact.plan.opened", payload: { loan_id: p.loan_id, regx_days_delinquent: regxDays, first_attempt_day: FIRST_ATTEMPT_DAY, due_date: o.due_date ?? null } }];
}

export interface PreDialChecks { readonly consent: boolean; readonly quiet_hours: boolean; readonly regf_count: boolean; readonly post_conversation: boolean; readonly pre_sale: boolean; readonly cease_flags: boolean; readonly bk_flag: boolean; readonly attorney_flag: boolean; readonly workplace: boolean; }
export const ALL_CHECKS_PASS: PreDialChecks = { consent: true, quiet_hours: true, regf_count: true, post_conversation: true, pre_sale: true, cease_flags: true, bk_flag: true, attorney_flag: true, workplace: true };

/** `dial.request`: refused unless the plan is `active` and every pre-dial check passes (11.1 guardrail: "no dial without every pre-dial check passing"). */
export function dialRequest(p: ContactPlan, i: { on: PlainDate; mode: PlanAttempt["mode"]; checks: PreDialChecks; person?: string; number_id?: string | null }): { allowed: boolean; refused_by: string | null; reason: string | null; event: PlanEvent | null } {
  if (p.status !== "active") return { allowed: false, refused_by: "PLAN_NOT_ACTIVE", reason: `plan is ${planState(p)}: no outbound attempt is dialable`, event: null };
  const failing = (Object.keys(i.checks) as (keyof PreDialChecks)[]).filter((k) => !i.checks[k]);
  if (failing.length) return { allowed: false, refused_by: "PRE_DIAL_CHECKS", reason: `pre-dial check(s) failed: ${failing.join(", ")}`, event: null };
  return { allowed: true, refused_by: null, reason: null, event: { type: "contact.attempt.requested", payload: { loan_id: p.loan_id, direction: "outbound", mode: i.mode, on: i.on, person: i.person ?? null, number_id: i.number_id ?? null, pre_dial_checks: i.checks } } };
}

/** An outbound attempt while active: `contact.attempted` (every attempt), `contact.completed` (conversation/qrpc), `contact.live.established` (live contact), and the 7-day cycle bookkeeping. */
export function recordAttempt(p: ContactPlan, a: PlanAttempt, cal: Calendar = servicer): PlanEvent[] {
  if (p.status !== "active") throw new RangeError(`plan is ${planState(p)}: attempts are not dialable`);
  const events: PlanEvent[] = [];
  if (p.cycle_start && daysBetween(p.cycle_start, a.on) >= CYCLE_DAYS) events.push(...closeCycle(p, a.on));
  const row: PlanAttempt = { ...a, episode: currentEpisode(p)?.no ?? 0 };
  p.attempts.push(row); p.last_attempt_on = a.on; p.cycle_due_at = shift(addDays(a.on, CYCLE_DAYS), cal);
  events.push({ type: "contact.attempted", payload: { loan_id: p.loan_id, contact_id: a.contact_id, direction: "outbound", mode: a.mode, outcome: a.outcome, on: a.on, live_contact: a.live_contact, person: a.person ?? null, cycle_no: p.cycle_no } });
  if (a.outcome === "conversation" || a.outcome === "qrpc") events.push({ type: "contact.completed", payload: { loan_id: p.loan_id, contact_id: a.contact_id, outcome: a.outcome, on: a.on, person: a.person ?? null } });
  if (a.live_contact) events.push({ type: "contact.live.established", payload: { loan_id: p.loan_id, contact_id: a.contact_id, on: a.on, basis: a.mode === "human_voice" ? "human_voice" : "ai_voice_flag", direction: "outbound" } }, liveEvent(p, a));
  return events;
}
/** Borrower-initiated contact (comment 39(a)-2): counts for Reg X and the Fannie Mae file; never an outbound attempt. */
export function recordInbound(p: ContactPlan, a: PlanAttempt): PlanEvent[] {
  p.attempts.push({ ...a, episode: currentEpisode(p)?.no ?? 0 });
  const events: PlanEvent[] = [{ type: "contact.inbound.received", payload: { loan_id: p.loan_id, contact_id: a.contact_id, direction: "inbound", on: a.on, outcome: a.outcome } }];
  if (a.live_contact) events.push({ type: "contact.live.established", payload: { loan_id: p.loan_id, contact_id: a.contact_id, on: a.on, basis: "borrower_initiated", direction: "inbound" } }, liveEvent(p, a));
  return events;
}
/** Closes the running 7-day cycle: `contact.plan.cycle_closed` carries the daypart mix `FNMA_A42104_VARY_TIMES_CYCLE` validates. */
export function closeCycle(p: ContactPlan, on: PlainDate): PlanEvent[] {
  const inCycle = p.attempts.filter((a) => p.cycle_start && a.on >= p.cycle_start && a.on < on);
  const ev: PlanEvent = { type: "contact.plan.cycle_closed", payload: { loan_id: p.loan_id, cycle_no: p.cycle_no, cycle_start: p.cycle_start, closed_on: on, attempts: inCycle.length, evening_or_weekend_attempts: inCycle.filter((a) => a.daypart === "evening" || a.daypart === "weekend").length, distinct_daypart_slots: new Set(inCycle.map((a) => a.daypart).filter(Boolean)).size } };
  p.cycle_no += 1; p.cycle_start = on;
  return [ev];
}

export function cease(p: ContactPlan, reason: CeaseReason, on: PlainDate): PlanEvent[] {
  if (p.status === "closed") return [];
  const events: PlanEvent[] = [];
  if (p.status === "active" && p.cycle_start) events.push(...closeCycle(p, on));
  closeEpisode(p, on);
  p.status = "ceased"; p.cease_reason = reason; p.suspend_reason = null; p.cycle_due_at = null; p.cycle_start = null;
  note(p, on, `ceased{${reason}}`);
  events.push({ type: "contact.plan.ceased", payload: { loan_id: p.loan_id, reason, on, cancel_timers: [...FNMA_CADENCE_TIMERS] } });
  return events;
}
export function suspend(p: ContactPlan, reason: SuspendReason, on: PlainDate): PlanEvent[] {
  if (p.status === "closed") return [];
  const events: PlanEvent[] = [];
  if (p.status === "active" && p.cycle_start) events.push(...closeCycle(p, on));
  closeEpisode(p, on);
  p.status = "suspended"; p.suspend_reason = reason; p.cease_reason = null; p.cycle_due_at = null; p.cycle_start = null;
  note(p, on, `suspended{${reason}}`);
  events.push({ type: "contact.plan.suspended", payload: { loan_id: p.loan_id, reason, on, cancel_timers: [...FNMA_CADENCE_TIMERS] } });
  return events;
}
export function resume(p: ContactPlan, trigger: ResumeTrigger, on: PlainDate, o: { due_date?: PlainDate | null } = {}): PlanEvent[] {
  if (p.status !== "ceased" && p.status !== "suspended") return [];
  p.status = "active"; p.cease_reason = null; p.suspend_reason = null; p.cycle_no += 1; p.cycle_start = on; p.cycle_due_at = on; p.resume_at = on;
  openEpisode(p, on, o.due_date ?? null, trigger);
  note(p, on, `active (resumed: ${trigger})`);
  return [{ type: "contact.plan.resumed", payload: { loan_id: p.loan_id, trigger, on, due_date: o.due_date ?? null } }];
}
export function close(p: ContactPlan, reason: CloseReason, on: PlainDate): PlanEvent[] {
  closeEpisode(p, on);
  p.status = "closed"; p.close_reason = reason; p.cycle_due_at = null; p.cycle_start = null;
  note(p, on, `closed{${reason}}`);
  return [{ type: "contact.plan.closed", payload: { loan_id: p.loan_id, reason, on, cancel_timers: [...FNMA_CADENCE_TIMERS] } }];
}

/** 11.1-T3: the installment is paid → `ceased{resolved}` (D2-2-02 "delinquency is resolved"); a cure with nothing else unpaid closes the plan. */
export function delinquencyResolved(p: ContactPlan, on: PlainDate, o: { cured?: boolean } = {}): PlanEvent[] {
  const events = p.status === "active" ? cease(p, "resolved", on) : [];
  if (o.cured) events.push(...close(p, "cured", on));
  return events;
}
/** A new missed installment after a resolution re-opens the cadence at day 17 (D2-2-02 resume trigger "new delinquency"). */
export function newDelinquency(p: ContactPlan, regxDays: number, on: PlainDate, o: { due_date?: PlainDate | null } = {}): PlanEvent[] {
  if (p.status === "closed" || p.status === "not_started") { p.status = "not_started"; p.close_reason = null; return openPlanIfDue(p, regxDays, on, o); }
  if (p.status === "ceased" && p.cease_reason === "resolved") return regxDays >= FIRST_ATTEMPT_DAY ? resume(p, "new_delinquency", on, o) : [];
  return [];
}

export type CommitmentKind = "promise_to_pay_full" | "promise_to_pay_partial" | "brp_submission" | "forbearance_request" | "repayment_plan_request" | "deferral_request" | "modification_request" | "liquidation_request" | "no_interest" | "refused" | "callback_only" | "promise_to_pay" | "workout_interest";
const WORKOUT: readonly CommitmentKind[] = ["brp_submission", "forbearance_request", "repayment_plan_request", "deferral_request", "modification_request", "liquidation_request", "workout_interest"];
/** `FNMA_D2202_CESSATION_ON_QRPC`: plan → ceased{qrpc_workout | qrpc_no_interest | ptp_pending}, or stays active on a partial/callback-only (or refused) commitment. */
export function cessationReasonFor(commitment: CommitmentKind, o: { promise_valid?: boolean } = {}): CeaseReason | null {
  if (commitment === "promise_to_pay_full" || commitment === "promise_to_pay") return o.promise_valid === false ? null : "ptp_pending";
  if (WORKOUT.includes(commitment)) return "qrpc_workout";
  if (commitment === "no_interest") return "qrpc_no_interest";
  return null;   // promise_to_pay_partial, callback_only, refused → the cadence continues
}
export function applyQrpc(p: ContactPlan, i: { on: PlainDate; commitment: CommitmentKind; promise_valid?: boolean }): { plan_status: string; ceased: boolean; events: PlanEvent[] } {
  const reason = cessationReasonFor(i.commitment, { ...(i.promise_valid !== undefined ? { promise_valid: i.promise_valid } : {}) });
  const events = reason ? cease(p, reason, i.on) : [];
  return { plan_status: planState(p), ceased: reason !== null, events };
}

/** 11.1 edge case "Bankruptcy": cadence `suspended{bankruptcy}` from the petition date. */
export function applyPetition(p: ContactPlan, on: PlainDate): PlanEvent[] { return suspend(p, "bankruptcy", on); }
/** 11.4 rule 6 / 11.4-T7: written cease → `suspended{cease_request}`. */
export function applyWrittenCease(p: ContactPlan, on: PlainDate): PlanEvent[] { return suspend(p, "cease_request", on); }
export function applyAttorney(p: ContactPlan, on: PlainDate): PlanEvent[] { return suspend(p, "attorney", on); }
/** 11.1 rule 11: pre-sale stop → `suspended{pre_sale_stop}`; a postponed sale resumes until the new stop date. */
export function applyPreSaleStop(p: ContactPlan, on: PlainDate): PlanEvent[] { return suspend(p, "pre_sale_stop", on); }

export interface CadenceBreach { readonly timer: "FNMA_D2202_OUTBOUND_START_36" | "FNMA_D2202_OUTBOUND_EVERY_7"; readonly episode: number; readonly detail: string; }
/** D2-2-02 breach test over the attempt log, per active episode: first outbound by day 36 of the episode's due date (rolled to an open day) and no gap > 7 days (shifted) while active. */
export function fnmaCadenceBreaches(p: ContactPlan, o: { through: PlainDate; cal?: Calendar }): readonly CadenceBreach[] {
  const cal = o.cal ?? servicer; const out: CadenceBreach[] = [];
  for (const e of p.episodes) {
    const outbound = p.attempts.filter((a) => a.episode === e.no && a.mode !== "letter").map((a) => a.on).sort();
    const end = e.closed_on ?? o.through;
    if (e.due_date) { const startDue = shift(addDays(e.due_date, 36), cal); if ((!outbound.length && end >= startDue) || (outbound.length && outbound[0]! > startDue)) out.push({ timer: "FNMA_D2202_OUTBOUND_START_36", episode: e.no, detail: `no outbound attempt by ${startDue}` }); }
    for (let k = 1; k < outbound.length; k++) if (shift(addDays(outbound[k - 1]!, CYCLE_DAYS), cal) < outbound[k]!) out.push({ timer: "FNMA_D2202_OUTBOUND_EVERY_7", episode: e.no, detail: `gap ${outbound[k - 1]} → ${outbound[k]}` });
    if (outbound.length && e.closed_on === null && p.status === "active" && p.cycle_due_at && o.through > p.cycle_due_at) out.push({ timer: "FNMA_D2202_OUTBOUND_EVERY_7", episode: e.no, detail: `no attempt by ${p.cycle_due_at}` });
  }
  return out;
}
