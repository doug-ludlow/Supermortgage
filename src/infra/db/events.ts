/**
 * `loan_events` repository — the persisted append-only spine. Rows are
 * inserted with the domain's own event ids (uuid) so timers, ledger sets and
 * decisions can reference them; the database assigns the global `sequence`.
 */
import type { DomainEvent, ActorKind } from "../../kernel/events/index.ts";
import { type Queryable, toJson, isUuid } from "./client.ts";

interface EventRow extends Record<string, unknown> {
  id: string; sequence: bigint; type: string; occurred_at: string; loan_id: string | null; aggregate_kind: string | null; aggregate_id: string | null;
  actor_kind: ActorKind; actor_id: string; actor_role: string | null; payload: Record<string, unknown>; causation_id: string | null; correlation_id: string | null;
}

const COLS = "id, sequence, type, occurred_at, loan_id, aggregate_kind, aggregate_id, actor_kind, actor_id, actor_role, payload, causation_id, correlation_id";

export function rowToEvent(r: EventRow): DomainEvent {
  return {
    id: r.id, sequence: Number(r.sequence), type: r.type, occurredAt: r.occurred_at, payload: r.payload,
    actor: { kind: r.actor_kind, id: r.actor_id, ...(r.actor_role ? { role: r.actor_role } : {}) },
    ...(r.loan_id ? { loanId: r.loan_id } : {}),
    ...(r.aggregate_kind && r.aggregate_id ? { aggregate: { kind: r.aggregate_kind, id: r.aggregate_id } } : {}),
    ...(r.causation_id ? { causationId: r.causation_id } : {}),
    ...(r.correlation_id ? { correlationId: r.correlation_id } : {}),
  };
}

export class PgEventRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  /** Append in order; returns the persisted events with their database sequence. */
  async append(events: readonly DomainEvent[], q: Queryable = this.db): Promise<DomainEvent[]> {
    const out: DomainEvent[] = [];
    for (const e of events) {
      const rows = await q.query<EventRow>(
        `INSERT INTO loan_events (id, type, occurred_at, loan_id, aggregate_kind, aggregate_id, actor_kind, actor_id, actor_role, payload, causation_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12) RETURNING ${COLS}`,
        [e.id, e.type, e.occurredAt, e.loanId ?? null, e.aggregate?.kind ?? null, e.aggregate?.id ?? null, e.actor.kind, e.actor.id, e.actor.role ?? null,
          toJson(e.payload), isUuid(e.causationId) ? e.causationId : null, isUuid(e.correlationId) ? e.correlationId : null]);
      out.push(rowToEvent(rows[0]!));
    }
    return out;
  }
  async byLoan(loanId: string): Promise<DomainEvent[]> {
    return (await this.db.query<EventRow>(`SELECT ${COLS} FROM loan_events WHERE loan_id = $1 ORDER BY sequence`, [loanId])).map(rowToEvent);
  }
  async ofType(type: string, limit = 1000): Promise<DomainEvent[]> {
    return (await this.db.query<EventRow>(`SELECT ${COLS} FROM loan_events WHERE type = $1 ORDER BY sequence LIMIT $2`, [type, limit])).map(rowToEvent);
  }
  async since(sequence: number, limit = 1000): Promise<DomainEvent[]> {
    return (await this.db.query<EventRow>(`SELECT ${COLS} FROM loan_events WHERE sequence > $1 ORDER BY sequence LIMIT $2`, [sequence, limit])).map(rowToEvent);
  }
  async get(id: string): Promise<DomainEvent | undefined> {
    const rows = await this.db.query<EventRow>(`SELECT ${COLS} FROM loan_events WHERE id = $1`, [id]);
    return rows[0] ? rowToEvent(rows[0]) : undefined;
  }
}
