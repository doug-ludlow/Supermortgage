/** `integration_messages` / `human_portal_tasks` backed implementations of the outbox and portal-task sink. */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/client.ts";
import { toJson } from "../db/client.ts";
import type { Outbox, OutboxMessage, EnqueueInput, Direction, PortalTaskSink, PortalTaskInput, HumanPortalTask } from "./outbox.ts";

interface Row extends Record<string, unknown> {
  id: string; adapter: string; direction: Direction; idempotency_key: string; status: OutboxMessage["status"]; payload_summary: Record<string, unknown>; acked_at: string | null; error: string | null;
  attempts: number; last_attempt_at: string | null; next_attempt_at: string | null; sent_at: string | null; response: unknown; loan_id: string | null; source_event_id: string | null; created_at: string;
}
function rowToMessage(r: Row): OutboxMessage {
  const summary = r.payload_summary;
  return { id: r.id, adapter: r.adapter, direction: r.direction, idempotencyKey: r.idempotency_key, payload: summary["payload"], payloadSummary: summary, createdAt: r.created_at, status: r.status, attempts: r.attempts,
    ...(r.loan_id ? { loanId: r.loan_id } : {}), ...(r.source_event_id ? { sourceEventId: r.source_event_id } : {}), ...(r.last_attempt_at ? { lastAttemptAt: r.last_attempt_at } : {}), ...(r.next_attempt_at ? { nextAttemptAt: r.next_attempt_at } : {}),
    ...(r.sent_at ? { sentAt: r.sent_at } : {}), ...(r.acked_at ? { ackedAt: r.acked_at } : {}), ...(r.error ? { error: r.error } : {}), ...(r.response !== null && r.response !== undefined ? { response: r.response } : {}) };
}

export class PgOutbox implements Outbox {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }
  async enqueue(input: EnqueueInput, now: string): Promise<{ message: OutboxMessage; duplicate: boolean }> {
    const direction = input.direction ?? "out";
    const existing = await this.byKey(input.adapter, direction, input.idempotencyKey);
    if (existing) return { message: existing, duplicate: true };
    const summary = { ...(input.payloadSummary ?? {}), payload: input.payload };
    const rows = await this.db.query<Row>(
      `INSERT INTO integration_messages (id, adapter, direction, idempotency_key, status, payload_summary, next_attempt_at, loan_id, source_event_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $7) RETURNING *`,
      [randomUUID(), input.adapter, direction, input.idempotencyKey, direction === "out" ? "queued" : "received", toJson(summary), now, input.loanId ?? null, input.sourceEventId ?? null]);
    return { message: rowToMessage(rows[0]!), duplicate: false };
  }
  async due(adapter: string, now: string, limit = 100): Promise<OutboxMessage[]> {
    return (await this.db.query<Row>(`SELECT * FROM integration_messages WHERE adapter = $1 AND status = 'queued' AND coalesce(next_attempt_at, created_at) <= $2 ORDER BY created_at LIMIT $3`, [adapter, now, limit])).map(rowToMessage);
  }
  async update(m: OutboxMessage): Promise<void> {
    await this.db.query(`UPDATE integration_messages SET status = $2, attempts = $3, last_attempt_at = $4, next_attempt_at = $5, sent_at = $6, acked_at = $7, error = $8, response = $9::jsonb WHERE id = $1`,
      [m.id, m.status, m.attempts, m.lastAttemptAt ?? null, m.nextAttemptAt ?? null, m.sentAt ?? null, m.ackedAt ?? null, m.error ?? null, m.response === undefined ? null : toJson(m.response)]);
  }
  async get(id: string): Promise<OutboxMessage | undefined> { const r = await this.db.query<Row>(`SELECT * FROM integration_messages WHERE id = $1`, [id]); return r[0] ? rowToMessage(r[0]) : undefined; }
  async byKey(adapter: string, direction: Direction, key: string): Promise<OutboxMessage | undefined> {
    const r = await this.db.query<Row>(`SELECT * FROM integration_messages WHERE adapter = $1 AND direction = $2 AND idempotency_key = $3`, [adapter, direction, key]); return r[0] ? rowToMessage(r[0]) : undefined;
  }
}

interface TaskRow extends Record<string, unknown> { id: string; kind: string; adapter: string; owner_role: string; loan_id: string | null; integration_message_id: string | null; package: Record<string, unknown>; due_at: string | null; status: HumanPortalTask["status"]; opened_at: string; completed_at: string | null; completed_by: string | null; evidence_document_id: string | null; }
function rowToTask(r: TaskRow): HumanPortalTask {
  return { id: r.id, kind: r.kind, adapter: r.adapter, ownerRole: r.owner_role, package: r.package, openedAt: r.opened_at, status: r.status,
    ...(r.loan_id ? { loanId: r.loan_id } : {}), ...(r.integration_message_id ? { integrationMessageId: r.integration_message_id } : {}), ...(r.due_at ? { dueAt: r.due_at } : {}),
    ...(r.completed_at ? { completedAt: r.completed_at } : {}), ...(r.completed_by ? { completedBy: r.completed_by } : {}), ...(r.evidence_document_id ? { evidenceDocumentId: r.evidence_document_id } : {}) };
}

export class PgPortalTasks implements PortalTaskSink {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }
  async open(t: PortalTaskInput, now: string): Promise<HumanPortalTask> {
    const rows = await this.db.query<TaskRow>(`INSERT INTO human_portal_tasks (kind, adapter, owner_role, loan_id, integration_message_id, package, due_at, opened_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
      [t.kind, t.adapter, t.ownerRole ?? "fnma_portal_operator", t.loanId ?? null, t.integrationMessageId ?? null, toJson(t.package ?? {}), t.dueAt ?? null, now]);
    return rowToTask(rows[0]!);
  }
  async open_(ownerRole?: string): Promise<HumanPortalTask[]> {
    const rows = ownerRole ? await this.db.query<TaskRow>(`SELECT * FROM human_portal_tasks WHERE owner_role = $1 AND status IN ('open', 'in_progress') ORDER BY due_at NULLS LAST`, [ownerRole])
      : await this.db.query<TaskRow>(`SELECT * FROM human_portal_tasks WHERE status IN ('open', 'in_progress') ORDER BY due_at NULLS LAST`);
    return rows.map(rowToTask);
  }
  async complete(id: string, by: string, evidenceDocumentId: string | null, now: string): Promise<void> {
    await this.db.query(`UPDATE human_portal_tasks SET status = 'completed', completed_at = $2, completed_by = $3, evidence_document_id = $4 WHERE id = $1`, [id, now, by, evidenceDocumentId]);
  }
}
