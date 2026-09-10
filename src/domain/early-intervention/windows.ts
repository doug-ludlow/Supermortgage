/**
 * §11.1 Live contact / §11.2 Written early intervention notice — Reg X
 * §1024.39 windows per unpaid due date, satisfaction/cancellation rules,
 * the bankruptcy / FDCPA-cease / discharge overlays that move an open window
 * to its exempt status, the rule-6 good-faith determination, the 180/190-day
 * notice cycle, the transferee overlay, and the Fannie Mae D2-2-02 cadence
 * gate (the plan state machine itself lives in plan.ts).
 */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";

/** 11.1 data model + state machine: the enum plus the states the state machine and T20/T22 name (`breached`, `breached_at_boarding`) and the transfer-out close. */
export type LiveStatus = "open" | "satisfied_live" | "satisfied_good_faith" | "satisfied_ongoing_lossmit" | "cancelled_paid" | "exempt_bk" | "exempt_fdcpa_cease" | "exempt_discharge" | "not_applicable" | "breached" | "breached_at_boarding" | "transfer_out";
/** 11.2 data model + state machine: the notice-leg enum plus `bk_modified_required` (one per case), `exempt_discharge` (11.2 state machine), `breached`, `breached_at_boarding`, `transfer_out`. */
export type NoticeStatus = "open" | "sent" | "satisfied_by_prior_180" | "cancelled_paid" | "exempt_bk_no_option" | "exempt_bk_cease" | "exempt_fdcpa_no_option" | "exempt_fdcpa_bk" | "exempt_discharge" | "bk_modified_required" | "deferred_transferee" | "not_applicable" | "breached" | "breached_at_boarding" | "transfer_out";

export interface Window { readonly due_date: PlainDate; readonly live_due_at: PlainDate; readonly notice_due_at: PlainDate; readonly principal_residence: boolean; live: LiveStatus; notice: NoticeStatus; live_basis?: string; live_satisfied_by_contact_id?: string; good_faith_record_id?: string; covering_cycle_id?: string; cancel_reason?: string | null; notice_id?: string; notice_variant?: Variant; }
export interface Cycle { readonly id: string; readonly provided_on: PlainDate; readonly variant: "standard" | "fdcpa" | "bk" | "bk_fdcpa"; readonly cycle_end_at: PlainDate; }
export type Variant = Cycle["variant"];

export const LIVE_DAYS = 36, NOTICE_DAYS = 45, CYCLE_DAYS = 180, FDCPA_CYCLE_DAYS = 190, BK_NOTICE_DAYS = 45;

/** A §11 domain event (type + payload); the command layer appends it with the loan id. */
export interface WindowEvent { readonly type: string; readonly payload: Record<string, unknown>; }
export type LiveBasis = "contact.live.established" | "good_faith_efforts.determined" | "lossmit.ongoing_contact";
/**
 * The §1024.39(a) satisfier the 11.1 timer table lists as three alternatives ("`contact.live.established` in window,
 * or `good_faith_efforts.determined`, or `lossmit.ongoing_contact` active"). The registry grammar takes one event, so
 * every producer emits this canonical union event alongside the spec's own event, carrying the alternative as `basis`
 * (the 14.1 `bankruptcy.notice.verified{result}` precedent). `due_dates` is null when the producer does not know the
 * windows (plan.ts / contact.log); the engine satisfies every armed window for the loan, which by construction are the
 * windows containing the contact date (comment 39(a)-1).
 */
export function liveSatisfiedEvent(windows: readonly Window[] | null, basis: LiveBasis, on: PlainDate, o: { contact_id?: string | null; good_faith_record_id?: string | null } = {}): WindowEvent {
  return { type: "regx.ei_window.live.satisfied", payload: { due_dates: windows ? windows.map((w) => w.due_date) : null, basis, on, contact_id: o.contact_id ?? null, good_faith_record_id: o.good_faith_record_id ?? null } };
}
/** `loan.delinquency.window_opened` as the 11.1 counter job emits it: the legs' creation status lets the timers skip windows that are exempt/covered at creation. */
export function windowOpenedEvent(w: Window, extra: Record<string, unknown> = {}): WindowEvent {
  return { type: "loan.delinquency.window_opened", payload: { due_date: w.due_date, principal_residence: w.principal_residence, live_due_at: w.live_due_at, notice_due_at: w.notice_due_at, live_status: w.live, notice_status: w.notice, ...(w.covering_cycle_id ? { covering_cycle_id: w.covering_cycle_id } : {}), ...extra } };
}
/** `SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD` trigger: the flag is off for the loan, or AI-only efforts ≥3 without live contact by day 28 (11.1 timer table). */
export function humanFallbackRequiredEvent(w: Window, reason: "ai_voice_counts_false" | "ai_only_efforts_3_by_day_28", extra: Record<string, unknown> = {}): WindowEvent {
  return { type: "regx.ei_window.human_fallback.required", payload: { due_date: w.due_date, live_due_at: w.live_due_at, task_due: addDays(w.live_due_at, -5), reason, ...extra } };
}
/** `REGX_1024_39C_BK_MODIFIED_NOTICE_45` trigger: a petition while delinquent (anchor = petition date) or the first delinquency during the case (anchor = the due date, §1024.31). */
export function bkModifiedRequiredEvent(i: { bk_case_id: string; petition_date: PlainDate; anchor_on: PlainDate; basis: "petition_while_delinquent" | "first_delinquency_in_case" }): WindowEvent {
  return { type: "regx.ei_notice.bk_modified_required", payload: { bk_case_id: i.bk_case_id, petition_date: i.petition_date, anchor_on: i.anchor_on, basis: i.basis, due: addDays(i.anchor_on, BK_NOTICE_DAYS) } };
}
/** `REGX_1024_39B_TRANSFEREE_45_AFTER_FIRST_DUE` trigger: the transferor noticed within 45 days before transfer (comment 39(b)(1)-5). */
export function transfereeDeferredEvent(i: { transfer_date: PlainDate; transferor_notice_on: PlainDate; first_post_transfer_due_date: PlainDate }): WindowEvent {
  return { type: "regx.ei_transferee.deferred", payload: { transfer_date: i.transfer_date, transferor_notice_on: i.transferor_notice_on, first_post_transfer_due_date: i.first_post_transfer_due_date, first_notice_due: addDays(i.first_post_transfer_due_date, NOTICE_DAYS) } };
}

export interface OpenWindowOptions {
  readonly principal_residence: boolean;
  readonly active_cycle?: Cycle | null;
  readonly bankruptcy?: "none" | "active" | "discharged";
  readonly transferor_notice_within_45?: boolean;
  /** DC loan with an active written §805(c) cease (§1024.39(d)). */
  readonly fdcpa_cease?: boolean;
  /** Comment 39(c)(1)(ii)-1: always true for Fannie Mae loans — only a policy override can make a leg `exempt_*_no_option`. */
  readonly options_available?: boolean;
}

/** 11.1 rule 1 / 11.2 state machine: one window per unpaid due date, with the overlays that apply at creation. */
export function openWindow(dueDate: PlainDate, o: OpenWindowOptions): Window {
  const w: Window = { due_date: dueDate, live_due_at: addDays(dueDate, LIVE_DAYS), notice_due_at: addDays(dueDate, NOTICE_DAYS), principal_residence: o.principal_residence, live: "open", notice: "open" };
  // Non-principal residence: §1024.30(c)(2) — Reg X windows `not_applicable` (11.1 edge cases; 11.1-T22 / 11.2-T13).
  if (!o.principal_residence) { w.live = "not_applicable"; w.notice = "not_applicable"; return w; }
  if (o.bankruptcy === "active") { applyBankruptcyPetition([w], { fdcpa_cease: o.fdcpa_cease === true, options_available: o.options_available !== false }); return w; }
  if (o.bankruptcy === "discharged") { w.live = "exempt_discharge"; w.notice = "exempt_discharge"; return w; }
  if (o.fdcpa_cease) applyFdcpaCease([w], { options_available: o.options_available !== false });
  if (w.notice === "open" && o.active_cycle && o.active_cycle.cycle_end_at >= w.notice_due_at) { w.notice = "satisfied_by_prior_180"; w.covering_cycle_id = o.active_cycle.id; }
  if (w.notice === "open" && o.transferor_notice_within_45) w.notice = "deferred_transferee";
  return w;
}
export function liveDueMs(w: Window, loanTz: string): number { return zonedEpochMs(w.live_due_at, "23:59", loanTz); }

/** Comment 39(a)-1: paying the missed installment on/before day 36 (45) removes that duty; later payment leaves the obligation standing. */
export function installmentPaid(w: Window, creditedAsOf: PlainDate): void {
  if (w.live === "open" && creditedAsOf <= w.live_due_at) { w.live = "cancelled_paid"; w.cancel_reason = "paid_before_36"; }
  if (w.notice === "open" && creditedAsOf <= w.notice_due_at) { w.notice = "cancelled_paid"; w.cancel_reason = w.cancel_reason ?? "paid_before_45"; }
}
/** 11.1-T24 — a reversal (NSF) re-opens the installment: cancelled legs are reinstated with their original due dates. */
export function reinstateOnReversal(w: Window): { live_reinstated: boolean; notice_reinstated: boolean } {
  const l = w.live === "cancelled_paid", n = w.notice === "cancelled_paid";
  if (l) w.live = "open"; if (n) w.notice = "open"; w.cancel_reason = null;
  return { live_reinstated: l, notice_reinstated: n };
}
/** 11.1-T20 — windows seeded at boarding from the transferor's unpaid due dates; past deadlines are `breached_at_boarding`. */
export function seedWindowsAtBoarding(unpaidDueDates: readonly PlainDate[], boardedOn: PlainDate, principalResidence = true): Window[] {
  return unpaidDueDates.map((d) => { const w = openWindow(d, { principal_residence: principalResidence }); if (w.live === "open" && w.live_due_at < boardedOn) w.live = "breached_at_boarding"; if (w.notice === "open" && w.notice_due_at < boardedOn) w.notice = "breached_at_boarding"; return w; });
}
/** Any qualifying contact/effort dated inside (D, D+36] satisfies every open window containing that date. */
export function applyContact(windows: Window[], contactOn: PlainDate, kind: "live" | "good_faith" | "ongoing_lossmit", basis = "outbound", contactId?: string): Window[] {
  const hit: Window[] = [];
  for (const w of windows) if (w.live === "open" && contactOn > w.due_date && contactOn <= w.live_due_at) { w.live = kind === "live" ? "satisfied_live" : kind === "good_faith" ? "satisfied_good_faith" : "satisfied_ongoing_lossmit"; w.live_basis = basis; if (contactId) w.live_satisfied_by_contact_id = contactId; hit.push(w); }
  return hit;
}
/** 11.1/11.2 state machines: a leg still `open` past its deadline becomes `breached` — never deleted. */
export function sweep(windows: Window[], today: PlainDate): Window[] {
  const b: Window[] = [];
  for (const w of windows) { if (w.live === "open" && today > w.live_due_at) { w.live = "breached"; b.push(w); } if (w.notice === "open" && today > w.notice_due_at) { w.notice = "breached"; b.push(w); } }
  return b;
}
/** 11.2 state machine: `open → sent` when the EI notice is provided (mail date / electronic delivery) on or before the deadline. */
export function noticeProvided(w: Window, providedOn: PlainDate, noticeId: string, variant: Variant): { satisfied: boolean; provided_late: boolean } {
  if (w.notice !== "open" && w.notice !== "bk_modified_required" && w.notice !== "breached") return { satisfied: false, provided_late: false };
  const late = providedOn > w.notice_due_at && w.notice !== "bk_modified_required";
  w.notice = "sent"; w.notice_id = noticeId; w.notice_variant = variant;
  return { satisfied: !late, provided_late: late };
}

// ---- overlays that move an open window --------------------------------------------

/**
 * §1024.39(c)(1): from the petition date no live contact is required (`exempt_bk`); the notice leg is exempt only
 * when no option is available or a DC-loan cease is active (comment 39(c)(1)(ii)-1/-2) — otherwise one modified
 * notice per case is required (`bk_modified_required`, `REGX_1024_39C_BK_MODIFIED_NOTICE_45`).
 */
export function applyBankruptcyPetition(windows: Window[], o: { fdcpa_cease?: boolean; options_available?: boolean } = {}): Window[] {
  const hit: Window[] = [];
  for (const w of windows) {
    if (w.live === "open") { w.live = "exempt_bk"; hit.push(w); }
    if (w.notice === "open") { w.notice = o.fdcpa_cease ? "exempt_bk_cease" : o.options_available === false ? "exempt_bk_no_option" : "bk_modified_required"; if (!hit.includes(w)) hit.push(w); }
  }
  return hit;
}
/** §1024.39(d): a written §805(c) cease on a DC loan ends (a); (b) survives as the modified fdcpa variant unless no option is available. */
export function applyFdcpaCease(windows: Window[], o: { options_available?: boolean } = {}): Window[] {
  const hit: Window[] = [];
  for (const w of windows) {
    if (w.live === "open") { w.live = "exempt_fdcpa_cease"; hit.push(w); }
    if (w.notice === "open" && o.options_available === false) { w.notice = "exempt_fdcpa_no_option"; if (!hit.includes(w)) hit.push(w); }
  }
  return hit;
}
/**
 * §1024.39(c)(2)(i): after dismissal/closure/reaffirmation, windows resume from the next payment due date after the event.
 * The 14.x `bankruptcy.status.changed{to∈{dismissed, closed, reaffirmed}}` carries no due date, so this §11 reaction emits
 * `regx.ei_windows.resume_after_bk{next_due_date}` (the `REGX_1024_39A_RESUME_AFTER_BK_NEXT_DUE` / `REGX_1024_39C_RESUME_NEXT_DUE`
 * trigger, anchored on `next_due_date`) and the resumed windows open `after_bk_resume=true` (their satisfier).
 */
export function resumeAfterBankruptcy(eventOn: PlainDate, dueDates: readonly PlainDate[], o: { active_cycle?: Cycle | null; bankruptcy_event?: "dismissed" | "closed" | "reaffirmed" } = {}): { resume_from: PlainDate | null; windows: Window[]; events: WindowEvent[] } {
  const from = dueDates.filter((d) => d > eventOn).sort()[0] ?? null;
  const windows = from ? dueDates.filter((d) => d >= from).map((d) => openWindow(d, { principal_residence: true, active_cycle: o.active_cycle ?? null })) : [];
  const events: WindowEvent[] = from ? [{ type: "regx.ei_windows.resume_after_bk", payload: { event_on: eventOn, bankruptcy_event: o.bankruptcy_event ?? "dismissed", next_due_date: from } }, ...windows.map((w) => windowOpenedEvent(w, { after_bk_resume: true }))] : [];
  return { resume_from: from, windows, events };
}

// ---- rule 6: good-faith determination --------------------------------------------

export type EffortChannel = "ai_voice" | "human_voice" | "sms" | "email" | "letter" | "statement_sentence";
export interface EffortAttempt { readonly contact_id: string; readonly on: PlainDate; readonly channel: EffortChannel; readonly number_id?: string | null; readonly daypart?: "morning" | "afternoon" | "evening" | "weekend"; readonly outcome: string; readonly live_contact: boolean; readonly notice_id?: string | null; }
export interface GoodFaithRecord { readonly id: string; readonly window_due_date: PlainDate; readonly determined_at: PlainDate; readonly attempts: readonly string[]; readonly channels: readonly EffortChannel[]; readonly written_encouragement_notice_ids: readonly string[]; readonly reasonableness_rationale: string; readonly basis: "policy_minimum" | "long_delinquency_minimum"; }
export interface GoodFaithInput {
  readonly attempts: readonly EffortAttempt[];
  readonly known_good_numbers: readonly string[];
  readonly determined_on: PlainDate;
  /** Comment 39(a)-3 factors: ≥6 consecutive payments behind and non-responsive ≥90 days lowers the minimum (rule 6). */
  readonly consecutive_payments_behind?: number;
  readonly nonresponsive_days?: number;
  readonly statement_contact_sentence?: boolean;
}
export interface GoodFaithOutcome { readonly record: GoodFaithRecord | null; readonly window_live: LiveStatus; readonly shortfalls: readonly string[]; readonly escalation: { readonly role: "officer"; readonly severity: 1; readonly timer: "REGX_1024_39A_LIVE_CONTACT_36"; readonly task: "immediate_human_call" } | null; readonly in_window: readonly EffortAttempt[]; /** `good_faith_efforts.determined` + the canonical `regx.ei_window.live.satisfied{basis=good_faith_efforts.determined}` when the minimum is met; a live contact found in the window yields the live-contact pair. */ readonly events: readonly WindowEvent[]; }

const TELEPHONE: readonly EffortChannel[] = ["ai_voice", "human_voice"];
const WRITTEN: readonly EffortChannel[] = ["sms", "email", "letter"];

/**
 * 11.1 rule 6 — at `live_due_at − 1` (or when day 36 passes) with no live contact: the window is `satisfied_good_faith`
 * only when the policy minimum is met by attempts inside (D, D+36]; fewer attempts → `breached` once day 36 has passed
 * (never self-certified), with the sev-1 `officer` escalation and immediate human call task the timer row names.
 */
export function goodFaithDetermination(w: Window, i: GoodFaithInput): GoodFaithOutcome {
  const inWindow = i.attempts.filter((a) => a.on > w.due_date && a.on <= w.live_due_at);
  const live = inWindow.find((a) => a.live_contact);
  if (live && w.live === "open") { applyContact([w], live.on, "live", live.channel, live.contact_id); return { record: null, window_live: w.live, shortfalls: [], escalation: null, in_window: inWindow, events: [liveSatisfiedEvent([w], "contact.live.established", live.on, { contact_id: live.contact_id })] }; }
  if (w.live !== "open") return { record: null, window_live: w.live, shortfalls: [], escalation: null, in_window: inWindow, events: [] };
  const shortfalls: string[] = [];
  const calls = inWindow.filter((a) => TELEPHONE.includes(a.channel));
  const written = inWindow.filter((a) => WRITTEN.includes(a.channel));
  const longDelinquency = (i.consecutive_payments_behind ?? 0) >= 6 && (i.nonresponsive_days ?? 0) >= 90;
  let basis: GoodFaithRecord["basis"];
  if (longDelinquency) {
    basis = "long_delinquency_minimum";
    if (!i.statement_contact_sentence) shortfalls.push("periodic-statement contact sentence (ei_contact_sentence) missing");
    if (calls.length < 1) shortfalls.push("no telephone attempt in the window");
  } else {
    basis = "policy_minimum";
    for (const num of i.known_good_numbers) {
      const to = calls.filter((a) => a.number_id === num);
      const distinct = new Set(to.map((a) => `${a.on}|${a.daypart ?? ""}`)).size;
      if (to.length < 2 || distinct < 2) shortfalls.push(`number ${num}: ${to.length} attempt(s) on ${distinct} distinct day/daypart(s) (minimum 2)`);
    }
    if (i.known_good_numbers.length === 0 && calls.length < 2) shortfalls.push("no known good number and fewer than 2 telephone attempts");
    if (written.length < 1) shortfalls.push("no written or electronic 'please contact us' communication in the window");
  }
  if (shortfalls.length === 0) {
    const record: GoodFaithRecord = { id: `gfe-${w.due_date}-${i.determined_on}`, window_due_date: w.due_date, determined_at: i.determined_on, attempts: inWindow.map((a) => a.contact_id), channels: [...new Set(inWindow.map((a) => a.channel))], written_encouragement_notice_ids: written.map((a) => a.notice_id ?? null).filter((x): x is string => !!x), basis,
      reasonableness_rationale: `comment 39(a)-3: ${calls.length} telephone attempt(s) across ${new Set(calls.map((a) => a.on)).size} day(s) and ${written.length} written/electronic communication(s) inside (${w.due_date}, ${w.live_due_at}]; ${i.consecutive_payments_behind ?? 1} payment(s) behind; borrower unresponsive; every attempt live_contact=false` };
    w.live = "satisfied_good_faith"; w.live_basis = "good_faith_efforts.determined"; w.good_faith_record_id = record.id;
    const events: WindowEvent[] = [{ type: "good_faith_efforts.determined", payload: { record_id: record.id, window_due_date: w.due_date, determined_at: record.determined_at, attempts: [...record.attempts], channels: [...record.channels], basis: record.basis } }, liveSatisfiedEvent([w], "good_faith_efforts.determined", i.determined_on, { good_faith_record_id: record.id })];
    return { record, window_live: w.live, shortfalls: [], escalation: null, in_window: inWindow, events };
  }
  if (i.determined_on > w.live_due_at) { w.live = "breached"; return { record: null, window_live: w.live, shortfalls, escalation: { role: "officer", severity: 1, timer: "REGX_1024_39A_LIVE_CONTACT_36", task: "immediate_human_call" }, in_window: inWindow, events: [] }; }
  return { record: null, window_live: w.live, shortfalls, escalation: null, in_window: inWindow, events: [] };
}

// ---- 11.2 notice cycle ---------------------------------------------------------

/** 11.2 rule 3: after a notice, the next required date. */
export function noticeCycle(providedOn: PlainDate, variant: Variant, id: string): Cycle { return { id, provided_on: providedOn, variant, cycle_end_at: addDays(providedOn, variant === "fdcpa" || variant === "bk_fdcpa" ? FDCPA_CYCLE_DAYS : CYCLE_DAYS) }; }
export function nextNoticeDue(c: Cycle, regxDaysDelinquentAtCycleEnd: number, earliestUnpaidDue: PlainDate | null): { due_on: PlainDate; scheduled_on: PlainDate } {
  if (regxDaysDelinquentAtCycleEnd >= 45 || !earliestUnpaidDue) return { due_on: c.cycle_end_at, scheduled_on: addDays(c.cycle_end_at, -2) };
  const fromUnpaid = addDays(earliestUnpaidDue, NOTICE_DAYS);
  const due = (c.variant === "fdcpa" || c.variant === "bk_fdcpa") && fromUnpaid < c.cycle_end_at ? c.cycle_end_at : fromUnpaid;
  return { due_on: due, scheduled_on: addDays(due, -2) };
}
export function printHandoffDue(noticeDue: PlainDate): PlainDate { return addDays(noticeDue, -2); }
/**
 * 11.2 rule 3, the nightly review at the end of a 180/190-day cycle. `REGX_1024_39B_NOTICE_180_REPEAT` /
 * `REGX_1024_39D_FDCPA_NOTICE_190` are armed at `provided_at` + 180/190. On `cycle_end_at` the counter decides the leg:
 * ≥45 days delinquent → the repeat is due at cycle end (the armed instance stands; `next_required_by` = cycle end);
 * <45 (or current) → §1024.39(b)(1)/(d)(3)(iii) move the duty to "45 days after the payment due date for which the
 * borrower remains delinquent" — that date is always later than the cycle end, and it is exactly `notice_due_at` of the
 * window opened for that due date (a window whose D+45 lies beyond the cycle is not `satisfied_by_prior_180`, so its own
 * `REGX_1024_39B_WRITTEN_NOTICE_45` instance carries the deadline). The review therefore emits
 * `regx.ei_cycle.reviewed{repeat_required=false}`, which cancels the cycle instance (timers.ts cancellation table), and
 * `next_required_by` is recomputed nightly from the earliest unpaid due date until then (11.2-T4).
 */
export function cycleEndReview(c: Cycle, i: { today: PlainDate; regx_days_delinquent: number; earliest_unpaid_due: PlainDate | null }): { reviewed: boolean; repeat_required: boolean; next_required_by: PlainDate | null; scheduled_on: PlainDate | null; events: WindowEvent[] } {
  const next = i.earliest_unpaid_due || i.regx_days_delinquent >= 45 ? nextNoticeDue(c, i.regx_days_delinquent, i.earliest_unpaid_due) : null;
  if (i.today < c.cycle_end_at) return { reviewed: false, repeat_required: false, next_required_by: next?.due_on ?? null, scheduled_on: next?.scheduled_on ?? null, events: [] };
  const repeat = i.regx_days_delinquent >= 45;
  return { reviewed: true, repeat_required: repeat, next_required_by: repeat ? c.cycle_end_at : next?.due_on ?? null, scheduled_on: repeat ? addDays(c.cycle_end_at, -2) : next?.scheduled_on ?? null,
    events: [{ type: "regx.ei_cycle.reviewed", payload: { cycle_id: c.id, variant: c.variant, provided_on: c.provided_on, cycle_end_at: c.cycle_end_at, reviewed_on: i.today, regx_days_delinquent: i.regx_days_delinquent, earliest_unpaid_due: i.earliest_unpaid_due, repeat_required: repeat, next_required_by: repeat ? c.cycle_end_at : next?.due_on ?? null, basis: repeat ? "≥45 days delinquent at cycle end: repeat due at +180/+190" : "<45 days delinquent at cycle end: due 45 days after the due date for which the borrower remains delinquent (that window's REGX_1024_39B_WRITTEN_NOTICE_45)" } }] };
}
/** §1024.39(c)(1)(iii)(A): one modified notice per case within 45 days of the petition. */
export function bkModifiedNoticeDue(petitionOn: PlainDate, alreadySentForCase: boolean): PlainDate | null { return alreadySentForCase ? null : addDays(petitionOn, BK_NOTICE_DAYS); }
/** Transferee rule: first notice due 45 days after the first post-transfer due date when the transferor noticed within 45 days before transfer. */
export function transfereeFirstNoticeDue(firstPostTransferDue: PlainDate): PlainDate { return addDays(firstPostTransferDue, NOTICE_DAYS); }
/** 11.2 rule 1 — variant at send: bk (courtesy `bk_fdcpa` only by policy election), fdcpa (DC loan + active cease), else standard. */
export function variantFor(f: { bk_active: boolean; debt_collector: boolean; cease_active: boolean; courtesy_bk_fdcpa?: boolean }): Variant {
  if (f.bk_active) return f.debt_collector && f.cease_active && f.courtesy_bk_fdcpa ? "bk_fdcpa" : "bk";
  return f.debt_collector && f.cease_active ? "fdcpa" : "standard";
}

/** D2-2-02 cadence gate: first outbound attempt day 17 (policy), then every ≤7 days until a cessation trigger. */
export function cadence(regxDays: number, o: { consent_voice: boolean; suspended?: "bankruptcy" | "cease_request" | "attorney" | "pre_sale_stop" | "pre_sale" | null; ceased?: string | null }): { attempt: boolean; channel: "ai_voice" | "human_manual_dial" | null; reason?: string } {
  if (o.suspended) return { attempt: false, channel: null, reason: `suspended:${o.suspended}` };
  if (o.ceased) return { attempt: false, channel: null, reason: `ceased:${o.ceased}` };
  if (regxDays < 17) return { attempt: false, channel: null, reason: "grace/pre-day-17" };
  return { attempt: true, channel: o.consent_voice ? "ai_voice" : "human_manual_dial", ...(o.consent_voice ? {} : { reason: "TCPA_64_1200_A1_CELL_CONSENT_GATE" }) };
}
export function bspDueAfterQrpc(qrpcOn: PlainDate): PlainDate { return addBusinessDays(qrpcOn, 3, servicer); }
