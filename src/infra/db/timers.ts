/**
 * `timers` repository — persisted TimerInstances. Unlike events and ledger
 * lines a timer row changes state (armed → satisfied/breached/cancelled), so
 * writes are upserts keyed by the instance id; every transition is also an
 * event (`timer.armed` / `timer.satisfied` / …) on the append-only log.
 */
import type { TimerInstance, TimerStatus } from "../../kernel/timers/engine.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Queryable } from "./client.ts";

interface TimerRow extends Record<string, unknown> {
  id: string; code: string; subject_kind: string; subject_id: string; loan_id: string | null; application_id: string | null; armed_at: string; armed_by_event_id: string; anchor_date: string;
  due_date: string | null; due_at: string | null; status: TimerStatus; satisfied_at: string | null; satisfied_by_event_id: string | null; breached_at: string | null; cancelled_reason: string | null; note: string | null;
}

function rowToInstance(r: TimerRow): TimerInstance {
  return {
    id: r.id, code: r.code, subject: { kind: r.subject_kind, id: r.subject_id }, armedAt: r.armed_at, armedByEventId: r.armed_by_event_id, anchorDate: r.anchor_date as PlainDate, status: r.status,
    ...(r.loan_id ? { loanId: r.loan_id } : {}), ...(r.application_id ? { applicationId: r.application_id } : {}), ...(r.due_date ? { dueDate: r.due_date as PlainDate } : {}), ...(r.due_at ? { dueAt: Date.parse(r.due_at) } : {}),
    ...(r.satisfied_at ? { satisfiedAt: r.satisfied_at } : {}), ...(r.satisfied_by_event_id ? { satisfiedByEventId: r.satisfied_by_event_id } : {}),
    ...(r.breached_at ? { breachedAt: r.breached_at } : {}), ...(r.cancelled_reason ? { cancelledReason: r.cancelled_reason } : {}), ...(r.note ? { note: r.note } : {}),
  };
}

export class PgTimerRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  async save(instances: readonly TimerInstance[], q: Queryable = this.db): Promise<void> {
    for (const i of instances) {
      await q.query(
        `INSERT INTO timers (id, code, subject_kind, subject_id, loan_id, armed_at, armed_by_event_id, anchor_date, due_date, due_at, status, satisfied_at, satisfied_by_event_id, breached_at, cancelled_reason, note, application_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, satisfied_at = EXCLUDED.satisfied_at, satisfied_by_event_id = EXCLUDED.satisfied_by_event_id,
           breached_at = EXCLUDED.breached_at, cancelled_reason = EXCLUDED.cancelled_reason, note = EXCLUDED.note`,
        [i.id, i.code, i.subject.kind, i.subject.id, i.loanId ?? null, i.armedAt, i.armedByEventId, i.anchorDate, i.dueDate ?? null, i.dueAt !== undefined ? new Date(i.dueAt).toISOString() : null,
          i.status, i.satisfiedAt ?? null, i.satisfiedByEventId ?? null, i.breachedAt ?? null, i.cancelledReason ?? null, i.note ?? null, i.applicationId ?? null]);
    }
  }
  /** Armed/breached timers, optionally for one loan. */
  async open(loanId?: string): Promise<TimerInstance[]> {
    const rows = loanId
      ? await this.db.query<TimerRow>(`SELECT * FROM timers WHERE loan_id = $1 AND status IN ('armed', 'breached') ORDER BY armed_at`, [loanId])
      : await this.db.query<TimerRow>(`SELECT * FROM timers WHERE status IN ('armed', 'breached') ORDER BY due_at NULLS LAST`);
    return rows.map(rowToInstance);
  }
  /** Armed timers due at or before `nowIso` — the sweep the breach evaluator runs on. */
  async due(nowIso: string): Promise<TimerInstance[]> {
    return (await this.db.query<TimerRow>(`SELECT * FROM timers WHERE status = 'armed' AND due_at <= $1 ORDER BY due_at`, [nowIso])).map(rowToInstance);
  }
  async forApplication(applicationId: string): Promise<TimerInstance[]> {
    return (await this.db.query<TimerRow>(`SELECT * FROM timers WHERE application_id = $1 ORDER BY armed_at`, [applicationId])).map(rowToInstance);
  }
  async forSubject(kind: string, id: string): Promise<TimerInstance[]> {
    return (await this.db.query<TimerRow>(`SELECT * FROM timers WHERE subject_kind = $1 AND subject_id = $2 ORDER BY armed_at`, [kind, id])).map(rowToInstance);
  }
}
