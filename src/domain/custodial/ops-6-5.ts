/**
 * §6.5 operating rules over the suspense / unclaimed-property calculators (./suspense.ts, ./ops.ts) — the process's
 * event emitters for the register review and the state unclaimed-property track. Each is a validated code path that
 * appends the event a 6.5 registry row is armed or satisfied by (src/kernel/timers/engine.ts matches them by type +
 * payload field on the same subject):
 *
 *   openUnclaimedPropertyItem   rule 4 / rule 7 / 6.4 rule 3: a payer-unknown receipt or a voided stale refund check
 *                               opens `unclaimed_property_items`; `unclaimed_property.item_opened{dormancy_start_on}`
 *                               arms STATE_UUPA_DORMANCY_3Y on the dormancy start (6.5-T5, 6.5-T7)
 *   presumeAbandoned            the per-state `unclaimed_property.cycle` sweep: on/after `presumed_abandoned_on` the item
 *                               is presumed abandoned (RUUPA §201(13)); `unclaimed_property.presumed_abandoned{filing_date,
 *                               cycle_end_on}` arms STATE_UUPA_DUE_DILIGENCE_NOTICE_60_180 (anchor: planned filing date)
 *                               and STATE_UUPA_REPORT_NOV1 (anchor: cycle end, June 30 default) (rule 7, 6.5-T7)
 *   openOfficerVerificationTask the `officer` verification task 47 days before filing ("officer verification task
 *                               created 2029-09-15 (policy lead)", 6.5-T7)
 *   unclaimedPropertyCycleSweep the scheduled composition of the two above for a state's items on a date
 *   sendDueDiligenceNotice      RUUPA §501(a): `UP-DUE-DILIGENCE-v1` by first-class mail, ≥ $50, inside the −180…−60 day
 *                               window before filing; `notice.sent{template=UP-DUE-DILIGENCE-v1}` satisfies the window row
 *   reportUnclaimedProperty     the state filing + remittance after the officer-verified NAUPA II file:
 *                               `unclaimed_property.reported{remitted=true}` per item satisfies STATE_UUPA_DORMANCY_3Y and
 *                               STATE_UUPA_REPORT_NOV1; the linked suspense item closes `escheated` (terminal)
 *   weeklyRegisterTick          the scheduler's Monday 06:00 servicer-local tick that arms SM_SUSPENSE_REGISTER_WEEKLY
 *   reviewSuspenseRegister      the weekly register review (rule 6; breach column of SM_UNIDENTIFIED_RESEARCH_30 and
 *                               SM_SUSPENSE_AGE_90_ESCALATE): aging per item, Form 496A Section III lines (> 30 days),
 *                               `officer` high escalation for non-terminal items ≥ 90 days (6.5-T8), the research-overdue
 *                               list; `suspense.register.reviewed` satisfies (and re-arms) SM_SUSPENSE_REGISTER_WEEKLY
 *
 * bigint cents; PlainDate + the servicer calendar; every write is validated before its event is appended — no bare appends.
 */
import { type PlainDate, addDays, dayOfWeek, daysBetween, plainDate } from "../../kernel/calendar/date.ts";
import { wallClock, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventInput, EventStore } from "../../kernel/events/index.ts";
import { DORMANCY_YEARS, escheat, isSuspenseTerminal } from "./suspense.ts";
import { ET, suspenseAging } from "./ops.ts";

// ---- ports -----------------------------------------------------------------
type StoredRecord = { readonly id: string; readonly data: Record<string, unknown> };
/** What the 6.5 emitters need from a unit of work: the event spine, the actor and the clock; the entity store and escalations when the caller has them. */
export interface SuspenseOps65 {
  readonly events: EventStore;
  readonly actor: Actor;
  /** ISO instant of the unit of work. */
  readonly now: string;
  readonly store?: { get(kind: string, id: string): StoredRecord | undefined; put(kind: string, id: string, data: Record<string, unknown>, by: Actor, now: string): StoredRecord; list?(kind: string): readonly StoredRecord[] };
  readonly escalations?: { open(input: { kind: "officer" | "human_portal_task"; ownerRole?: string; severity?: string; loanId?: string; payload?: Record<string, unknown> }, by: Actor): { id: string } };
}

export const UNCLAIMED_PROPERTY_ITEM = "unclaimed_property_item";
export const SUSPENSE_ITEM = "suspense_item";
export const WEEKLY_REGISTER_JOB = "suspense-register-weekly";
export const UNCLAIMED_PROPERTY_CYCLE_JOB = "unclaimed-property-cycle";
/** RUUPA §501(a): notice to the apparent owner when the value is $[50] or more. */
export const DUE_DILIGENCE_THRESHOLD_CENTS: Cents = 5_000n;
/** RUUPA §502(a): "if you do not contact us before (date 30 days after notice)". */
export const DUE_DILIGENCE_CONTACT_DAYS = 30;
/** Aging past which the weekly register lists an item on Form 496A Section III (rule 6) and the 90-day officer escalation (SM_SUSPENSE_AGE_90_ESCALATE). */
export const SECTION_III_AGING_DAYS = 30, ESCALATE_AGING_DAYS = 90, RESEARCH_AGING_DAYS = 30;
const UNIDENTIFIED = new Set(["unidentified_loan", "unidentified_payer"]);
const todayOf = (ops: SuspenseOps65): PlainDate => wallClock(Date.parse(ops.now), ET).date;
const need = (cond: boolean, msg: string): void => { if (!cond) throw new RangeError(msg); };
const STATE = /^[A-Z]{2}$/;

// ---- unclaimed property: open -----------------------------------------------
export interface UnclaimedPropertyOpenInput {
  readonly id?: string;
  /** One of the two (migration CHECK): the suspense item (payer unknown) or the voided stale check (6.4 rule 3). */
  readonly suspense_item_id?: string; readonly outstanding_check_id?: string;
  readonly loan_id?: string | null;
  readonly owner_name?: string | null; readonly owner_last_address?: string | null;
  /** State of the owner's last known address; the holder's state of domicile if unknown (RUUPA priority rules). */
  readonly state: string;
  readonly amount_cents: Cents;
  /** Last indication of interest / check issue date per state rule. */
  readonly dormancy_start_on: PlainDate;
  readonly naupa_property_code?: string | null;
}
export interface UnclaimedPropertyOpenResult { readonly id: string; readonly dormancy_years: number; readonly presumed_abandoned_on: PlainDate; readonly cycle: string; readonly report_due_on: PlainDate; readonly due_diligence_window: readonly [PlainDate, PlainDate]; readonly officer_verification_on: PlainDate; readonly owner_known: boolean; readonly event: DomainEvent }
/** Opens the `unclaimed_property_items` row and emits `unclaimed_property.item_opened` — STATE_UUPA_DORMANCY_3Y arms on `dormancy_start_on` (rule 7). */
export function openUnclaimedPropertyItem(ops: SuspenseOps65, f: UnclaimedPropertyOpenInput): UnclaimedPropertyOpenResult {
  need(!!f.suspense_item_id || !!f.outstanding_check_id, "an unclaimed-property item links a suspense_item_id or an outstanding_check_id");
  need(STATE.test(f.state), "state must be a two-letter code (owner's last known address; holder's state if unknown)");
  need(f.amount_cents > 0n, "amount_cents must be positive");
  const today = todayOf(ops);
  need(f.dormancy_start_on <= today, `dormancy_start_on ${f.dormancy_start_on} is after today ${today}`);
  const id = f.id ?? `up-${f.suspense_item_id ?? f.outstanding_check_id}`;
  const e = escheat(f.dormancy_start_on, f.state);
  const dormancy_years = DORMANCY_YEARS[f.state] ?? DORMANCY_YEARS.DEFAULT!;
  const owner_known = !!(f.owner_name && f.owner_last_address);
  const row = { suspense_item_id: f.suspense_item_id ?? null, outstanding_check_id: f.outstanding_check_id ?? null, loan_id: f.loan_id ?? null, owner_name: f.owner_name ?? null, owner_last_address: f.owner_last_address ?? null, state: f.state, naupa_property_code: f.naupa_property_code ?? null,
    amount_cents: f.amount_cents, dormancy_start_on: f.dormancy_start_on, presumed_abandoned_on: e.presumed_abandoned_on, report_cycle: e.cycle, report_due_on: e.report_due_on, due_diligence_notice_id: null, reported_on: null, remitted_on: null, state_confirmation_ref: null, status: "dormant" };
  ops.store?.put("unclaimed_property_items", id, row, ops.actor, ops.now);
  const event = ops.events.append({ type: "unclaimed_property.item_opened", ...(f.loan_id ? { loanId: f.loan_id } : {}), aggregate: { kind: UNCLAIMED_PROPERTY_ITEM, id }, actor: ops.actor,
    payload: { id, suspense_item_id: row.suspense_item_id, outstanding_check_id: row.outstanding_check_id, state: f.state, amount_cents: f.amount_cents, dormancy_start_on: f.dormancy_start_on, dormancy_years, presumed_abandoned_on: e.presumed_abandoned_on, report_cycle: e.cycle, report_due_on: e.report_due_on, owner_known } });
  return { id, dormancy_years, presumed_abandoned_on: e.presumed_abandoned_on, cycle: e.cycle, report_due_on: e.report_due_on, due_diligence_window: e.due_diligence_window, officer_verification_on: e.officer_verification_on, owner_known, event };
}

// ---- unclaimed property: presumed abandoned (cycle sweep) -----------------
export interface UnclaimedPropertyItemFacts { readonly id: string; readonly state: string; readonly amount_cents: Cents; readonly dormancy_start_on: PlainDate; readonly status: string; readonly loan_id?: string | null }
const factsOf = (ops: SuspenseOps65, id: string, given?: UnclaimedPropertyItemFacts): UnclaimedPropertyItemFacts => {
  if (given) return given;
  const rec = ops.store?.get("unclaimed_property_items", id);
  need(!!rec, `unclaimed_property_items ${id} is not on the register`);
  const d = rec!.data;
  return { id, state: String(d.state ?? ""), amount_cents: BigInt(String(d.amount_cents ?? "0")), dormancy_start_on: plainDate(String(d.dormancy_start_on)), status: String(d.status ?? "dormant"), loan_id: (d.loan_id as string | null | undefined) ?? null };
};
export interface PresumedAbandonedResult { readonly id: string; readonly presumed: boolean; readonly reason: string | null; readonly presumed_abandoned_on: PlainDate; readonly cycle: string; readonly cycle_end_on: PlainDate; readonly filing_date: PlainDate; readonly due_diligence_window: readonly [PlainDate, PlainDate]; readonly due_diligence_required: boolean; readonly officer_verification_on: PlainDate; readonly event: DomainEvent | null }
/**
 * On/after `presumed_abandoned_on` with no owner indication of interest (RUUPA §210(b)) the item is presumed abandoned:
 * `unclaimed_property.presumed_abandoned{filing_date, cycle_end_on}` arms the due-diligence window (anchor: planned filing
 * date) and the report deadline (anchor: cycle end, June 30 default → file before Nov 1).
 */
export function presumeAbandoned(ops: SuspenseOps65, f: { id: string; today?: PlainDate; item?: UnclaimedPropertyItemFacts }): PresumedAbandonedResult {
  const item = factsOf(ops, f.id, f.item);
  const today = f.today ?? todayOf(ops);
  const e = escheat(item.dormancy_start_on, item.state);
  const cycle_end_on = plainDate(`${e.cycle.slice(2)}-06-30`);
  const base = { id: item.id, presumed_abandoned_on: e.presumed_abandoned_on, cycle: e.cycle, cycle_end_on, filing_date: e.report_due_on, due_diligence_window: e.due_diligence_window, due_diligence_required: item.amount_cents >= DUE_DILIGENCE_THRESHOLD_CENTS, officer_verification_on: e.officer_verification_on };
  if (item.status !== "dormant") return { ...base, presumed: false, reason: `item is ${item.status}, not dormant`, event: null };
  if (today < e.presumed_abandoned_on) return { ...base, presumed: false, reason: `dormancy runs until ${e.presumed_abandoned_on}`, event: null };
  const rec = ops.store?.get("unclaimed_property_items", item.id);
  ops.store?.put("unclaimed_property_items", item.id, { ...(rec?.data ?? {}), status: "presumed_abandoned", presumed_abandoned_on: e.presumed_abandoned_on, report_cycle: e.cycle, report_due_on: e.report_due_on }, ops.actor, ops.now);
  const event = ops.events.append({ type: "unclaimed_property.presumed_abandoned", ...(item.loan_id ? { loanId: item.loan_id } : {}), aggregate: { kind: UNCLAIMED_PROPERTY_ITEM, id: item.id }, actor: ops.actor,
    payload: { id: item.id, state: item.state, amount_cents: item.amount_cents, dormancy_start_on: item.dormancy_start_on, presumed_abandoned_on: e.presumed_abandoned_on, presumed_on: today, cycle: e.cycle, cycle_end_on, filing_date: e.report_due_on, report_due_on: e.report_due_on, due_diligence_window_opens: e.due_diligence_window[0], due_diligence_window_closes: e.due_diligence_window[1], due_diligence_required: base.due_diligence_required, officer_verification_on: e.officer_verification_on } });
  return { ...base, presumed: true, reason: null, event };
}

/** The `officer` verification task for the state file, opened on the policy lead date (filing − 47 days: 2029-09-15 for a 2029-11-01 filing). */
export function openOfficerVerificationTask(ops: SuspenseOps65, f: { id: string; today?: PlainDate; item?: UnclaimedPropertyItemFacts }): { id: string; opened: boolean; task_id: string | null; created_on: PlainDate; verify_by: PlainDate; reason: string | null } {
  const item = factsOf(ops, f.id, f.item);
  const today = f.today ?? todayOf(ops);
  const e = escheat(item.dormancy_start_on, item.state);
  if (item.status !== "presumed_abandoned" && item.status !== "due_diligence_sent") return { id: item.id, opened: false, task_id: null, created_on: today, verify_by: e.report_due_on, reason: `item is ${item.status}` };
  if (today < e.officer_verification_on) return { id: item.id, opened: false, task_id: null, created_on: today, verify_by: e.report_due_on, reason: `verification task opens ${e.officer_verification_on}` };
  const rec = ops.store?.get("unclaimed_property_items", item.id);
  if (rec?.data.officer_task_id) return { id: item.id, opened: false, task_id: String(rec.data.officer_task_id), created_on: today, verify_by: e.report_due_on, reason: "task already open" };
  need(!!ops.escalations, "the officer verification task needs the escalation service");
  const task = ops.escalations!.open({ kind: "officer", severity: "high", ...(item.loan_id ? { loanId: item.loan_id } : {}), payload: { task: "unclaimed_property_verification", unclaimed_property_item_id: item.id, state: item.state, cycle: e.cycle, amount_cents: item.amount_cents, created_on: today, verify_by: e.report_due_on, deliverable: "NAUPA II file verification and state portal filing", rule_ref: "6.5 rule 7 / STATE_UUPA_REPORT_NOV1" } }, ops.actor);
  ops.store?.put("unclaimed_property_items", item.id, { ...(rec?.data ?? {}), officer_task_id: task.id, officer_task_created_on: today }, ops.actor, ops.now);
  return { id: item.id, opened: true, task_id: task.id, created_on: today, verify_by: e.report_due_on, reason: null };
}

/** The scheduled per-state cycle sweep: presumes abandoned what has aged out and opens the officer task when the lead date arrives. */
export function unclaimedPropertyCycleSweep(ops: SuspenseOps65, f: { today: PlainDate; items: readonly UnclaimedPropertyItemFacts[] }): { today: PlainDate; presumed: string[]; officer_tasks: string[]; tick: DomainEvent } {
  need(f.items.every((x) => STATE.test(x.state)), "every item carries a two-letter state");
  const tick = ops.events.append({ type: "schedule.tick", actor: { kind: "system", id: "scheduler" }, occurredAt: new Date(zonedEpochMs(f.today, "01:00", ET)).toISOString(), payload: { cadence: "per_state_cycle", job: UNCLAIMED_PROPERTY_CYCLE_JOB, date: f.today, states: [...new Set(f.items.map((x) => x.state))] } });
  const presumed: string[] = [], officer_tasks: string[] = [];
  for (const item of f.items) {
    const p = presumeAbandoned(ops, { id: item.id, today: f.today, item });
    if (p.presumed) presumed.push(item.id);
    const t = openOfficerVerificationTask(ops, { id: item.id, today: f.today, item: p.presumed ? { ...item, status: "presumed_abandoned" } : item });
    if (t.opened) officer_tasks.push(item.id);
  }
  return { today: f.today, presumed, officer_tasks, tick };
}

// ---- unclaimed property: due-diligence notice -------------------------------
export interface DueDiligenceNoticeInput { readonly id: string; readonly notice_id?: string; readonly sent_on?: PlainDate; readonly channel?: string; readonly recipient_party_id?: string | null; readonly item?: UnclaimedPropertyItemFacts }
/**
 * RUUPA §501(a)/§502(a): the `UP-DUE-DILIGENCE-v1` notice, first-class mail only, for items ≥ $50, sent not more than 180
 * nor less than 60 days before the filing; `notice.sent{template=UP-DUE-DILIGENCE-v1}` on the item satisfies
 * STATE_UUPA_DUE_DILIGENCE_NOTICE_60_180.
 */
export function sendDueDiligenceNotice(ops: SuspenseOps65, f: DueDiligenceNoticeInput): { id: string; notice_id: string; template: "UP-DUE-DILIGENCE-v1"; sent_on: PlainDate; contact_by: PlainDate; window: readonly [PlainDate, PlainDate]; event: DomainEvent } {
  const item = factsOf(ops, f.id, f.item);
  const sent_on = f.sent_on ?? todayOf(ops);
  const channel = f.channel ?? "mail_first_class";
  need(channel === "mail_first_class", "UP-DUE-DILIGENCE-v1 is always mailed first-class (RUUPA §502; Notice Registry channel policy mail_only)");
  need(item.amount_cents >= DUE_DILIGENCE_THRESHOLD_CENTS, `due-diligence notice is required at $50.00 or more (RUUPA §501(a)); ${item.amount_cents} cents is below the threshold`);
  need(item.status === "presumed_abandoned" || item.status === "due_diligence_sent", `item ${item.id} is ${item.status}; the notice follows presumption of abandonment`);
  const e = escheat(item.dormancy_start_on, item.state);
  const [opens, closes] = e.due_diligence_window;
  need(sent_on >= opens && sent_on <= closes, `notice date ${sent_on} is outside the §501(a) window ${opens}…${closes} (−180…−60 days before the ${e.report_due_on} filing)`);
  const notice_id = f.notice_id ?? `${item.id}-UP-DUE-DILIGENCE-v1`;
  const contact_by = addDays(sent_on, DUE_DILIGENCE_CONTACT_DAYS);
  const rec = ops.store?.get("unclaimed_property_items", item.id);
  ops.store?.put("unclaimed_property_items", item.id, { ...(rec?.data ?? {}), due_diligence_notice_id: notice_id, due_diligence_sent_on: sent_on, status: "due_diligence_sent" }, ops.actor, ops.now);
  const event = ops.events.append({ type: "notice.sent", ...(item.loan_id ? { loanId: item.loan_id } : {}), aggregate: { kind: UNCLAIMED_PROPERTY_ITEM, id: item.id }, actor: ops.actor, occurredAt: new Date(zonedEpochMs(sent_on, "17:00", ET)).toISOString(),
    payload: { notice_id, template: "UP-DUE-DILIGENCE-v1", unclaimed_property_item_id: item.id, state: item.state, amount_cents: item.amount_cents, channels: [{ party_id: f.recipient_party_id ?? null, channel: "mail_first_class", satisfies_timer: true }], sent_at: ops.now, sent_on, contact_by, days_before_filing: daysBetween(sent_on, e.report_due_on) } });
  return { id: item.id, notice_id, template: "UP-DUE-DILIGENCE-v1", sent_on, contact_by, window: e.due_diligence_window, event };
}

// ---- unclaimed property: report + remit -----------------------------------
export interface UnclaimedPropertyReportInput {
  readonly state: string; readonly cycle: string;
  /** The officer-verified NAUPA II file (`naupa.generate`). */
  readonly file_id: string; readonly officer_verification_id?: string;
  readonly filed_on: PlainDate; readonly remitted: boolean; readonly remittance_cents: Cents; readonly state_confirmation_ref?: string | null;
  readonly items: readonly UnclaimedPropertyItemFacts[];
}
export interface UnclaimedPropertyReportResult { readonly report_id: string; readonly state: string; readonly cycle: string; readonly filed_on: PlainDate; readonly remittance_cents: Cents; readonly item_count: number; readonly events: DomainEvent[]; readonly suspense_items_escheated: string[] }
/**
 * The state filing: report + remittance for the cycle's items on the officer-verified file. `unclaimed_property.reported{remitted=true}`
 * per item satisfies STATE_UUPA_DORMANCY_3Y and STATE_UUPA_REPORT_NOV1 ("`unclaimed_property.reported` + remitted"); the linked
 * suspense item closes `escheated` (terminal — SM_SUSPENSE_AGE_90_ESCALATE). Filed without remittance → refused: the row is not satisfied.
 */
export function reportUnclaimedProperty(ops: SuspenseOps65, f: UnclaimedPropertyReportInput): UnclaimedPropertyReportResult {
  need(STATE.test(f.state), "state must be a two-letter code");
  need(f.cycle.length > 0 && f.file_id.length > 0, "cycle and file_id are required");
  need(f.items.length > 0, "a report carries at least one item");
  need(f.remitted, "the report is satisfied only with the remittance (`unclaimed_property.reported` + remitted)");
  const total = f.items.reduce((a, x) => a + x.amount_cents, 0n);
  need(f.remittance_cents === total, `remittance_cents ${f.remittance_cents} must equal the items' total ${total}`);
  for (const x of f.items) need(x.state === f.state, `${x.id} belongs to ${x.state}, not the ${f.state} report`);
  const file = ops.store?.get("naupa_files", f.file_id);
  const verification = f.officer_verification_id ?? (file ? (file.data.officer_verification as string | null | undefined) ?? null : null);
  need(!!verification, "the NAUPA II file is filed only with the officer's verification (6.5 rule 7)");
  if (file) { need(String(file.data.state) === f.state && String(file.data.cycle) === f.cycle, `file ${f.file_id} is for ${String(file.data.state)} ${String(file.data.cycle)}`); need(BigInt(String(file.data.total_cents ?? "0")) === total, `file total ${String(file.data.total_cents)} differs from the items' total ${total}`); }
  const report_id = `${f.state}-${f.cycle}`;
  ops.store?.put("unclaimed_property_reports", report_id, { state: f.state, cycle: f.cycle, file_document_id: f.file_id, verification_signed_by: verification, filed_on: f.filed_on, remittance_cents: f.remittance_cents, remitted_on: f.filed_on, state_confirmation_ref: f.state_confirmation_ref ?? null, item_ids: f.items.map((x) => x.id) }, ops.actor, ops.now);
  const events: DomainEvent[] = [], suspense_items_escheated: string[] = [];
  for (const item of f.items) {
    const rec = ops.store?.get("unclaimed_property_items", item.id);
    ops.store?.put("unclaimed_property_items", item.id, { ...(rec?.data ?? {}), status: "reported", reported_on: f.filed_on, remitted_on: f.filed_on, report_cycle: f.cycle, state_confirmation_ref: f.state_confirmation_ref ?? null, report_id }, ops.actor, ops.now);
    events.push(ops.events.append({ type: "unclaimed_property.reported", ...(item.loan_id ? { loanId: item.loan_id } : {}), aggregate: { kind: UNCLAIMED_PROPERTY_ITEM, id: item.id }, actor: ops.actor,
      payload: { id: item.id, state: f.state, cycle: f.cycle, report_id, file_id: f.file_id, officer_verification: verification, filed_on: f.filed_on, remitted: true, remitted_on: f.filed_on, amount_cents: item.amount_cents, remittance_cents: f.remittance_cents, state_confirmation_ref: f.state_confirmation_ref ?? null } }));
    const suspenseId = rec ? (rec.data.suspense_item_id as string | null | undefined) ?? null : null;
    const s = suspenseId ? ops.store?.get("suspense_items", suspenseId) : undefined;
    if (suspenseId && s && !isSuspenseTerminal(String(s.data.status ?? "open"))) {
      const from = String(s.data.status ?? "open"); const loanId = (s.data.loan_id as string | undefined) || undefined;
      ops.store!.put("suspense_items", suspenseId, { ...s.data, status: "escheated", resolved_on: f.filed_on, resolution_event_id: events[events.length - 1]!.id }, ops.actor, ops.now);
      // the same shape 6.5's `suspense.read/write` emits, so the register timers close on the terminal status
      const base = { ...(loanId ? { loanId } : {}), aggregate: { kind: SUSPENSE_ITEM, id: suspenseId }, actor: ops.actor };
      events.push(ops.events.append({ type: "suspense.item.status_changed", ...base, payload: { id: suspenseId, status: "escheated", from, loan_id: loanId ?? null, credited_as_of: null } }));
      events.push(ops.events.append({ type: "suspense.item.closed", ...base, payload: { id: suspenseId, status: "escheated", loan_id: loanId ?? null, resolved_on: f.filed_on } }));
      suspense_items_escheated.push(suspenseId);
    }
  }
  return { report_id, state: f.state, cycle: f.cycle, filed_on: f.filed_on, remittance_cents: f.remittance_cents, item_count: f.items.length, events, suspense_items_escheated };
}

// ---- weekly register --------------------------------------------------------
/** The scheduler's Monday 06:00 servicer-local tick (SM_SUSPENSE_REGISTER_WEEKLY: `schedule.tick{cadence=weekly, weekday=monday, at=06:00}`). */
export function weeklyRegisterTick(monday: PlainDate): EventInput {
  need(dayOfWeek(monday) === 1, `${monday} is not a Monday`);
  return { type: "schedule.tick", actor: { kind: "system", id: "scheduler" }, occurredAt: new Date(zonedEpochMs(monday, "06:00", ET)).toISOString(), payload: { cadence: "weekly", weekday: "monday", at: "06:00", tz: "servicer_local", job: WEEKLY_REGISTER_JOB, date: monday } };
}
export interface RegisterItem { readonly id: string; readonly loan_id: string | null; readonly amount_cents: Cents; readonly status: string; readonly reason_code: string; readonly received_on: PlainDate }
export interface RegisterLine { readonly id: string; readonly loan_id: string | null; readonly reason_code: string; readonly status: string; readonly amount_cents: Cents; readonly aging_days: number }
export interface RegisterReview {
  readonly reviewed_on: PlainDate; readonly week_of: PlainDate; readonly reviewer: string;
  readonly open_count: number; readonly total_open_cents: Cents;
  /** Form 496A Section III "unapplied funds that need resolution": items > 30 days with reason, loan number (if any), amount and aging. */
  readonly section_iii: readonly RegisterLine[];
  /** Unidentified items past the 30-day research deadline without a match — the `officer` is notified in this register (SM_UNIDENTIFIED_RESEARCH_30 breach). */
  readonly research_overdue: readonly RegisterLine[];
  /** Non-terminal items ≥ 90 days: `officer` high escalation + partner aging report line (SM_SUSPENSE_AGE_90_ESCALATE breach, 6.5-T8). */
  readonly escalations: readonly { id: string; escalation_id: string | null; partner_report_line: string }[];
  readonly event: DomainEvent;
}
/** The weekly review over the register rows: aging, Section III, overdue research and 90-day escalations; `suspense.register.reviewed` closes (and re-arms) the weekly row. */
export function reviewSuspenseRegister(ops: SuspenseOps65, f: { reviewed_on?: PlainDate; items: readonly RegisterItem[]; reviewer: string }): RegisterReview {
  need(f.reviewer.length > 0, "reviewer is required (qc-audit reviewer run)");
  const reviewed_on = f.reviewed_on ?? todayOf(ops);
  const week_of = addDays(reviewed_on, -((dayOfWeek(reviewed_on) + 6) % 7));
  const seen = new Set<string>();
  for (const it of f.items) { need(!seen.has(it.id), `duplicate register item ${it.id}`); seen.add(it.id); need(it.amount_cents > 0n, `${it.id}: amount_cents must be positive`); need(it.received_on <= reviewed_on, `${it.id}: received_on ${it.received_on} is after the review date`); }
  const open = f.items.filter((it) => !isSuspenseTerminal(it.status));
  const line = (it: RegisterItem, aging_days: number): RegisterLine => ({ id: it.id, loan_id: it.loan_id, reason_code: it.reason_code, status: it.status, amount_cents: it.amount_cents, aging_days });
  const section_iii: RegisterLine[] = [], research_overdue: RegisterLine[] = [], escalations: { id: string; escalation_id: string | null; partner_report_line: string }[] = [];
  for (const it of open) {
    const a = suspenseAging({ item_id: it.id, loan_id: it.loan_id, amount_cents: it.amount_cents, status: it.status, received_on: it.received_on, today: reviewed_on });
    if (a.aging_days > SECTION_III_AGING_DAYS) section_iii.push(line(it, a.aging_days));
    if (UNIDENTIFIED.has(it.reason_code) && a.aging_days > RESEARCH_AGING_DAYS && !["matched_pending", "applied"].includes(it.status)) research_overdue.push(line(it, a.aging_days));
    if (a.escalation && a.partner_report_line) {
      const esc = ops.escalations?.open({ kind: "officer", severity: a.escalation.severity, ...(it.loan_id ? { loanId: it.loan_id } : {}), payload: { task: "suspense_aged_90", suspense_item_id: it.id, reason_code: it.reason_code, status: it.status, amount_cents: it.amount_cents, aging_days: a.aging_days, partner_report_line: a.partner_report_line, rule_ref: "6.5 SM_SUSPENSE_AGE_90_ESCALATE" } }, ops.actor) ?? null;
      escalations.push({ id: it.id, escalation_id: esc?.id ?? null, partner_report_line: a.partner_report_line });
    }
  }
  const total_open_cents = open.reduce((s, it) => s + it.amount_cents, 0n);
  const id = `register-${week_of}`;
  ops.store?.put("suspense_register_reviews", id, { reviewed_on, week_of, reviewer: f.reviewer, open_count: open.length, total_open_cents, section_iii_ids: section_iii.map((l) => l.id), research_overdue_ids: research_overdue.map((l) => l.id), escalated_ids: escalations.map((e) => e.id) }, ops.actor, ops.now);
  const event = ops.events.append({ type: "suspense.register.reviewed", actor: ops.actor, occurredAt: ops.now,
    payload: { review_id: id, reviewed_on, week_of, reviewer: f.reviewer, open_count: open.length, total_open_cents, section_iii_count: section_iii.length, research_overdue_ids: research_overdue.map((l) => l.id), escalated_ids: escalations.map((e) => e.id), officer_notified: research_overdue.length > 0 || escalations.length > 0 } });
  return { reviewed_on, week_of, reviewer: f.reviewer, open_count: open.length, total_open_cents, section_iii, research_overdue, escalations, event };
}
