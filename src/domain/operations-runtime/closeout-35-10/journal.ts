/**
 * §35.10 rule 10 — the closeout journal: every step entered and completed, every owning command run, refused or failed, every
 * wait and hold, as a refinance_closeout_steps row on the command's transaction plus the closeout's own events on the prior loan
 * (`refinance.closeout.step.entered{step, clocked, entered_at, waiting_on}` arms SM_REFI_CLOSEOUT_STALLED_2BD when `clocked`;
 * `refinance.closeout.step.completed{step, completed_at}` satisfies it). Every payload carries `application_id`, `prior_loan_id`
 * and `origination: true` (Data model, Events).
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor, DomainEvent, EventStore } from "../../../kernel/events/index.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { appendStep, updateCloseout } from "./repo.ts";
import type { CloseoutRow, CloseoutStep, CloseoutStatus, StepKind, StepRow } from "./types.ts";

export const ET = "America/New_York";
export const CLOSEOUT_AGGREGATE = "refinance_closeout";
/** The steps a person, a statutory window, the partner's tape or 35.6 owns — no SM_REFI_CLOSEOUT_STALLED_2BD arms while waiting there (Data model: `clocked`). */
export const UNCLOCKED_WAITS: ReadonlySet<string> = new Set(["borrower", "signing_officer", "officer", "ops_analyst", "attorney", "partner", "partner_tape", "rescission_window", "35.6", "erecording", "SM_REFI_PARTNER_CONFIRM_21", "orchestration", "26.2", "26.3", "16.1", "35.5", "33.1", "3.5", "30.3", "settlement_agent", "custodial_accounts"]);

export interface JournalIo { readonly q: Queryable; readonly events: EventStore; readonly actor: Actor; readonly now: string; readonly sweepRunId: string | null; }
const day = (iso: string) => wallClock(Date.parse(iso), ET).date;
const base = (c: CloseoutRow) => ({ closeout_id: c.id, application_id: c.application_id, prior_loan_id: c.prior_loan_id, mode: c.mode, origination: true });
const appendEvent = (io: JournalIo, c: CloseoutRow, type: string, payload: Record<string, unknown>, causationId?: string | null): DomainEvent =>
  io.events.append({ type, loanId: c.prior_loan_id, applicationId: c.application_id, aggregate: { kind: CLOSEOUT_AGGREGATE, id: c.id }, actor: io.actor, payload: { ...base(c), ...payload }, ...(causationId ? { causationId } : {}) });

/** Enter `step`: the row moves, the journal records it, the event arms the stalled clock when the platform or a vendor owns the wait. */
export async function enterStep(io: JournalIo, c: CloseoutRow, step: CloseoutStep, o: { status?: CloseoutStatus; waiting_on?: string | null; trigger_event_id?: string | null; detail?: Record<string, unknown> } = {}): Promise<{ row: CloseoutRow; event: DomainEvent; entry: StepRow }> {
  const waitingOn = o.waiting_on ?? null;
  const clocked = !(waitingOn !== null && UNCLOCKED_WAITS.has(waitingOn)) && !(o.status !== undefined && ["waiting_human", "waiting_partner", "waiting_window", "held"].includes(o.status));
  const row = await updateCloseout(io.q, c.id, { step, status: o.status ?? "open", waiting_on: waitingOn, step_attempts: 0 }, io.now);
  const event = appendEvent(io, row, "refinance.closeout.step.entered", { step, clocked, entered_at: day(io.now), entered_at_iso: io.now, waiting_on: waitingOn, status: row.status, ...(typeof o.detail?.["transition"] === "string" ? { transition: o.detail["transition"] } : {}) }, o.trigger_event_id ?? null);
  const entry = await appendStep(io.q, { closeout_id: c.id, application_id: c.application_id, prior_loan_id: c.prior_loan_id, step, kind: "entered", clocked, waiting_on: waitingOn, trigger_event_id: o.trigger_event_id ?? null, actor_kind: io.actor.kind, actor_id: io.actor.id, actor_role: io.actor.role ?? null, detail: { event_id: event.id, status: row.status, ...(o.detail ?? {}) }, sweep_run_id: io.sweepRunId }, io.now);
  return { row, event, entry };
}
/** Complete the current step (satisfies SM_REFI_CLOSEOUT_STALLED_2BD for its entry). */
export async function completeStep(io: JournalIo, c: CloseoutRow, o: { trigger_event_id?: string | null; detail?: Record<string, unknown> } = {}): Promise<{ event: DomainEvent; entry: StepRow }> {
  const event = appendEvent(io, c, "refinance.closeout.step.completed", { step: c.step, completed_at: day(io.now), completed_at_iso: io.now }, o.trigger_event_id ?? null);
  const entry = await appendStep(io.q, { closeout_id: c.id, application_id: c.application_id, prior_loan_id: c.prior_loan_id, step: c.step, kind: "completed", trigger_event_id: o.trigger_event_id ?? null, actor_kind: io.actor.kind, actor_id: io.actor.id, actor_role: io.actor.role ?? null, detail: { event_id: event.id, ...(o.detail ?? {}) }, sweep_run_id: io.sweepRunId }, io.now);
  return { event, entry };
}
/** A journal line that moves nothing (a command run/refused/failed, a wait, a skip). */
export async function journal(io: JournalIo, c: CloseoutRow, kind: StepKind, o: { command?: { process: string; name: string; op?: string | null } | null; trigger_event_id?: string | null; decision_id?: string | null; refusal_code?: string | null; error_class?: string | null; waiting_on?: string | null; clocked?: boolean; detail?: Record<string, unknown>; actor?: Actor; step?: string } = {}): Promise<StepRow> {
  const actor = o.actor ?? io.actor;
  return appendStep(io.q, { closeout_id: c.id, application_id: c.application_id, prior_loan_id: c.prior_loan_id, step: o.step ?? c.step, kind, clocked: o.clocked === true, waiting_on: o.waiting_on ?? null, trigger_event_id: o.trigger_event_id ?? null, command_process: o.command?.process ?? null, command_name: o.command?.name ?? null, command_op: o.command?.op ?? null, actor_kind: actor.kind, actor_id: actor.id, actor_role: actor.role ?? null, decision_id: o.decision_id ?? null, refusal_code: o.refusal_code ?? null, error_class: o.error_class ?? null, detail: o.detail ?? {}, sweep_run_id: io.sweepRunId }, io.now);
}
/** The closeout's own event on the prior loan's log (`refinance.*`, `partner_book.retirement.*`). */
export const closeoutEvent = appendEvent;
export const civilDay = day;
