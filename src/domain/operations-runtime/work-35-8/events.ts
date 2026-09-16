/**
 * §35.8 — the process's event literals (Outputs and artifacts), each a builder so every module spells a type once. The
 * item and action events are keyed by their own aggregate (`work_item`, `work_action`) so the registry's clocks arm and
 * satisfy per item / per proposal (SM_WORK_ITEM_CLAIM_4H on `work.item.claimed{claimed_at}`, SM_WORK_ITEM_AGE_2BD / _5BD on
 * `work.item.opened{opened_at}`, SM_WORK_APPROVAL_1BD on `work.action.proposed{proposed_at}`); the loan or application the
 * item is about rides in the payload. The recon receipt is global (`work.log.recon.run_completed{as_of_date}`).
 */
import type { Actor, EventInput } from "../../../kernel/events/index.ts";
import type { Row } from "./types.ts";

export const WORK_ITEM_OPENED = "work.item.opened";
export const WORK_ITEM_CLAIMED = "work.item.claimed";
export const WORK_ITEM_RELEASED = "work.item.released";
export const WORK_ITEM_CLAIM_EXPIRED = "work.item.claim_expired";
export const WORK_ITEM_CLOSED = "work.item.closed";
export const WORK_ITEM_CANCELLED = "work.item.cancelled";
export const WORK_ACTION_EXECUTED = "work.action.executed";
export const WORK_ACTION_PROPOSED = "work.action.proposed";
export const WORK_ACTION_DECIDED = "work.action.decided";
export const WORK_ACTION_REFUSED = "work.action.refused";
export const WORK_LOG_RECON_RUN_COMPLETED = "work.log.recon.run_completed";
/** 35.7's literal, emitted with the role when SM_WORK_ITEM_AGE_5BD breaches (timer table row 3: "the queue is unstaffed for that role"). */
export const ROLE_QUEUE_UNSTAFFED = "role.queue.unstaffed";

type Ev = EventInput<Row>;
const item = (type: string, itemId: string, actor: Actor, payload: Row): Ev => ({ type, aggregate: { kind: "work_item", id: itemId }, actor, payload: { item_id: itemId, ...payload } });
const action = (type: string, actionId: string, actor: Actor, payload: Row): Ev => ({ type, aggregate: { kind: "work_action", id: actionId }, actor, payload: { action_id: actionId, ...payload } });

export const itemOpened = (id: string, actor: Actor, p: { screen_code: string; subject_kind: string; subject_id: string; source_kind: string; source_id: string; required_role: string; opened_at: string; loan_id: string | null; application_id: string | null; due_at: string | null }): Ev => item(WORK_ITEM_OPENED, id, actor, p);
export const itemClaimed = (id: string, actor: Actor, p: { by: string; claimed_at: string; claim_expires_at: string; role: string }): Ev => item(WORK_ITEM_CLAIMED, id, actor, p);
export const itemReleased = (id: string, actor: Actor, p: { by: string }): Ev => item(WORK_ITEM_RELEASED, id, actor, p);
export const itemClaimExpired = (id: string, actor: Actor, p: { lapses: number; was_claimed_by: string | null; timer_id: string | null }): Ev => item(WORK_ITEM_CLAIM_EXPIRED, id, actor, p);
export const itemClosed = (id: string, actor: Actor, p: { by: string; disposition: string; reason?: string | null; evidence_document_id?: string | null }): Ev => item(WORK_ITEM_CLOSED, id, actor, p);
export const itemCancelled = (id: string, actor: Actor, p: { by: string; reason: string }): Ev => item(WORK_ITEM_CANCELLED, id, actor, p);
export const actionExecuted = (id: string, actor: Actor, p: { screen_code: string; action_code: string; process: string; tool: string; by: string; role: string | null; input_sha256: string; command_event_id: string | null; approval_of?: string | null }): Ev => action(WORK_ACTION_EXECUTED, id, actor, p);
export const actionProposed = (id: string, actor: Actor, p: { tool: string; input_sha256: string; proposed_at: string; screen_code: string; action_code: string; by: string }): Ev => action(WORK_ACTION_PROPOSED, id, actor, p);
export const actionDecided = (id: string, actor: Actor, p: { decision: "approved" | "declined" | "expired"; by: string | null; executed_action_id?: string | null; code?: string | null }): Ev => action(WORK_ACTION_DECIDED, id, actor, p);
export const actionRefused = (id: string, actor: Actor, p: { code: string; screen_code: string; action_code: string; tool: string }): Ev => action(WORK_ACTION_REFUSED, id, actor, p);
export const reconCompleted = (runId: string, actor: Actor, p: { as_of_date: string; actions_checked: number; orphans: number; stale_screens: number; sole_officer_money_acts: number }): Ev => ({ type: WORK_LOG_RECON_RUN_COMPLETED, aggregate: { kind: "work_log_recon_run", id: runId }, actor, payload: { run_id: runId, ...p } });
export const roleQueueUnstaffed = (actor: Actor, p: { role: string; count: number; item_ids: readonly string[]; timer_ids: readonly string[]; timer_id: string | null; environment: string }): Ev => ({ type: ROLE_QUEUE_UNSTAFFED, aggregate: { kind: "role_queue", id: p.role }, actor, payload: { ...p, cause: "SM_WORK_ITEM_AGE_5BD" } });
