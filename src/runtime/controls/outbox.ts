/**
 * 34.4 rule 3 — the outbox: `integration_messages` by adapter and status with the retries, and `requeueMessage`: a failed or
 * dead-lettered message put back to `queued` by hand, at most three times. Each requeue is logged as
 * `outbox.requeued{message_id, adapter, requeue_no, by}` with the person as actor; the fourth attempt is refused
 * `REQUEUE_CAP_3` and opens an `ops_analyst` escalation (once — a fifth attempt names the same open escalation) instead of
 * touching the row. The count is the stored events, never a column edited: three `outbox.requeued` receipts for a message
 * mean the cap is reached whatever the row's `attempts` says (the sweep resets that per delivery).
 *
 * The same UPDATE the console's queue dispatches today (src/console/pg-store.ts requeueDeadLetter): status queued, attempts 0,
 * next_attempt_at now, error cleared — the FAKE adapter delivers it on the next sweep like any other (the spec's edge case).
 */
import { randomUUID } from "node:crypto";
import type { Actor } from "../../kernel/events/index.ts";
import type { Queryable } from "../../infra/db/client.ts";
import type { Runtime } from "../app.ts";
import { ControlsRefused, appendEvent, clampLimit, isUuid, requireStaffRole, s, type Row } from "./common.ts";

export const REQUEUE_CAP = 3;
/** The roles that requeue by hand (34.1 rule 2: ops_analyst and officer act on the platform's rows; admin touches no borrower row). */
export const REQUEUE_ROLES: readonly string[] = ["ops_analyst", "officer"];
export const REQUEUEABLE: readonly string[] = ["dead", "failed"];

export interface OutboxRow {
  readonly id: string; readonly adapter: string; readonly direction: string; readonly idempotency_key: string; readonly status: string;
  readonly attempts: number; readonly error: string | null; readonly loan_id: string | null; readonly document_id: string | null;
  readonly created_at: string; readonly last_attempt_at: string | null; readonly next_attempt_at: string | null; readonly sent_at: string | null; readonly acked_at: string | null;
  /** The hand requeues so far (the `outbox.requeued` receipts) and who made them. */
  readonly requeues: number; readonly requeued_by: readonly { by: string; role: string | null; at: string }[]; readonly requeues_left: number;
  /** The open REQUEUE_CAP_3 escalation for this message, when the fourth attempt opened one. */
  readonly cap_escalation_id: string | null;
}
export interface OutboxFilter { readonly adapter?: string | null; readonly status?: string | null; readonly loan_id?: string | null; readonly limit?: number | null; }

const SELECT = `SELECT m.id::text AS id, m.adapter, m.direction::text AS direction, m.idempotency_key, m.status, m.attempts, m.error, m.loan_id::text AS loan_id, m.document_id::text AS document_id,
    m.created_at::text AS created_at, m.last_attempt_at::text AS last_attempt_at, m.next_attempt_at::text AS next_attempt_at, m.sent_at::text AS sent_at, m.acked_at::text AS acked_at,
    coalesce((SELECT jsonb_agg(jsonb_build_object('by', r.actor_id, 'role', r.actor_role, 'at', r.occurred_at) ORDER BY r.sequence) FROM loan_events r WHERE r.type = 'outbox.requeued' AND r.payload->>'message_id' = m.id::text AND r.actor_kind = 'human'), '[]'::jsonb) AS requeued_by,
    (SELECT e.id::text FROM escalations e WHERE e.completed_at IS NULL AND e.payload->>'message_id' = m.id::text AND e.payload->>'code' = 'REQUEUE_CAP_3' ORDER BY e.opened_at DESC LIMIT 1) AS cap_escalation_id
  FROM integration_messages m`;
const toRow = (r: Row): OutboxRow => {
  const by = Array.isArray(r["requeued_by"]) ? (r["requeued_by"] as Row[]).map((x) => ({ by: s(x["by"]), role: x["role"] ? s(x["role"]) : null, at: s(x["at"]) })) : [];
  return { id: s(r["id"]), adapter: s(r["adapter"]), direction: s(r["direction"]), idempotency_key: s(r["idempotency_key"]), status: s(r["status"]), attempts: Number(r["attempts"] ?? 0), error: r["error"] ? s(r["error"]) : null, loan_id: r["loan_id"] ? s(r["loan_id"]) : null, document_id: r["document_id"] ? s(r["document_id"]) : null,
    created_at: s(r["created_at"]), last_attempt_at: r["last_attempt_at"] ? s(r["last_attempt_at"]) : null, next_attempt_at: r["next_attempt_at"] ? s(r["next_attempt_at"]) : null, sent_at: r["sent_at"] ? s(r["sent_at"]) : null, acked_at: r["acked_at"] ? s(r["acked_at"]) : null,
    requeues: by.length, requeued_by: by, requeues_left: Math.max(0, REQUEUE_CAP - by.length), cap_escalation_id: r["cap_escalation_id"] ? s(r["cap_escalation_id"]) : null };
};

/** `GET /ops/api/controls/outbox?adapter=&status=` — the messages (failed and dead first, newest first); by adapter, status (queued | failed | dead | sent | acked | rejected | received | duplicate | open = queued+failed+dead, the default), loan. */
export async function listOutbox(rt: Runtime, f: OutboxFilter = {}): Promise<{ as_of: string; count: number; by_adapter: { adapter: string; status: string; count: number }[]; messages: OutboxRow[] }> {
  const where: string[] = []; const p: unknown[] = [];
  const status = f.status?.trim() || "open";
  if (status === "open") where.push(`m.status IN ('queued', 'failed', 'dead')`); else if (status !== "all") { p.push(status); where.push(`m.status = $${p.length}`); }
  if (f.adapter) { p.push(f.adapter.trim()); where.push(`m.adapter = $${p.length}`); }
  if (f.loan_id) { if (!isUuid(f.loan_id)) throw new RangeError("loan_id is a uuid"); p.push(f.loan_id); where.push(`m.loan_id = $${p.length}::uuid`); }
  p.push(clampLimit(f.limit, 500, 5000));
  const rows = await rt.db.query<Row>(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY (m.status = 'dead') DESC, (m.status = 'failed') DESC, coalesce(m.last_attempt_at, m.created_at) DESC LIMIT $${p.length}`, p);
  const by = await rt.db.query<{ adapter: string; status: string; count: string }>(`SELECT adapter, status, count(*)::text AS count FROM integration_messages GROUP BY adapter, status ORDER BY adapter, status`);
  return { as_of: rt.clock.now(), count: rows.length, by_adapter: by.map((b) => ({ adapter: b.adapter, status: b.status, count: Number(b.count) })), messages: rows.map(toRow) };
}
export async function getOutboxMessage(rt: Runtime, id: string): Promise<OutboxRow | null> {
  if (!isUuid(id)) throw new RangeError("message id is a uuid");
  const r = (await rt.db.query<Row>(`${SELECT} WHERE m.id = $1::uuid`, [id]))[0]; return r ? toRow(r) : null;
}

/** The one writer of the requeue reset (rule 3's UPDATE): status queued, attempts 0, next_attempt_at now, error cleared — a dead or failed message only. 35.11's bounded automatic requeue (rule 4) calls it with `auto: true` on its own event; the cap above counts human `by` only. */
export async function resetForRequeue(q: Queryable, messageId: string, nowIso: string): Promise<{ id: string }[]> {
  return q.query<{ id: string }>(`UPDATE integration_messages SET status = 'queued', attempts = 0, next_attempt_at = $2::timestamptz, error = NULL WHERE id = $1::uuid AND status = ANY($3::text[]) RETURNING id::text AS id`, [messageId, nowIso, [...REQUEUEABLE]]);
}

export interface RequeueResult { readonly message_id: string; readonly adapter: string; readonly status: "queued"; readonly requeue_no: number; readonly requeues_left: number; readonly by: string; readonly by_role: string | null; readonly at: string; readonly event_id: string; }
/**
 * `controls.outbox.requeue{id}` — rule 3: the message back to `queued` (status dead or failed only), the receipt with the actor;
 * the fourth attempt refuses REQUEUE_CAP_3 and opens (once) the `ops_analyst` escalation `{message_id, adapter, code, requeues, by}`.
 */
export async function requeueMessage(rt: Runtime, i: { id: string; actor: Actor; reason?: string | null }, nowIso: string = rt.clock.now()): Promise<RequeueResult> {
  await requireStaffRole(rt.db, i.actor, REQUEUE_ROLES, "requeueing an outbox message");
  const m = await getOutboxMessage(rt, i.id); if (!m) throw new ControlsRefused(404, "NO_SUCH_MESSAGE", `no outbox message ${i.id}`);
  if (m.requeues >= REQUEUE_CAP) {
    // the fourth attempt: refused, an ops_analyst escalation instead (one open per message) — the row is untouched
    let escalationId = m.cap_escalation_id;
    if (!escalationId) {
      escalationId = randomUUID();
      // the escalation outlives the refusal that follows: written on the root runtime's pool, not on the refused command's transaction (35.1: a refusal writes nothing of its own)
      await rt.root.db.tx(async (q) => {
        await rt.escalationRepo.save({ id: escalationId!, kind: "sev4", ownerRole: "ops_analyst", ...(m.loan_id ? { loanId: m.loan_id } : {}), severity: "4", openedAt: nowIso, openedBy: `${i.actor.kind}:${i.actor.id}`, status: "open",
          payload: { code: "REQUEUE_CAP_3", message_id: m.id, adapter: m.adapter, idempotency_key: m.idempotency_key, status: m.status, requeues: m.requeues, attempted_by: i.actor.id, attempted_role: i.actor.role ?? null, reason: `a fourth hand requeue of ${m.adapter} message ${m.id} was refused (34.4 rule 3); the adapter or the message needs a person`, error: m.error } }, q);
        await appendEvent(q, { type: "escalation.created", actor: i.actor, loan_id: m.loan_id, aggregate: { kind: "escalation", id: escalationId! }, occurred_at: nowIso, payload: { escalation_id: escalationId, kind: "sev4", owner_role: "ops_analyst", severity: "4", code: "REQUEUE_CAP_3", message_id: m.id, adapter: m.adapter, requeues: m.requeues, by: i.actor.id } });
      });
    }
    throw new ControlsRefused(409, "REQUEUE_CAP_3", `message ${m.id} was already requeued ${m.requeues} times by hand; an ops_analyst escalation ${escalationId} is open for it`, { message_id: m.id, requeues: m.requeues, escalation_id: escalationId });
  }
  if (!REQUEUEABLE.includes(m.status)) throw new ControlsRefused(409, "NOT_REQUEUEABLE", `message ${m.id} is ${m.status}; only a dead or failed message is requeued`, { status: m.status });
  const requeueNo = m.requeues + 1;
  const eventId = await rt.db.tx(async (q) => {
    const rows = await resetForRequeue(q, m.id, nowIso);
    if (!rows.length) throw new ControlsRefused(409, "NOT_REQUEUEABLE", `message ${m.id} changed under the request`, {});
    const ev = await appendEvent(q, { type: "outbox.requeued", actor: i.actor, loan_id: m.loan_id, aggregate: { kind: "integration_message", id: m.id }, occurred_at: nowIso, payload: { message_id: m.id, adapter: m.adapter, idempotency_key: m.idempotency_key, from_status: m.status, requeue_no: requeueNo, cap: REQUEUE_CAP, by: i.actor.id, by_role: i.actor.role ?? null, reason: i.reason?.trim() || null } });
    return ev.id;
  });
  rt.logger?.info("controls.outbox.requeued", { message_id: m.id, adapter: m.adapter, requeue_no: requeueNo, by: i.actor.id, role: i.actor.role ?? null });
  return { message_id: m.id, adapter: m.adapter, status: "queued", requeue_no: requeueNo, requeues_left: REQUEUE_CAP - requeueNo, by: i.actor.id, by_role: i.actor.role ?? null, at: nowIso, event_id: eventId };
}
