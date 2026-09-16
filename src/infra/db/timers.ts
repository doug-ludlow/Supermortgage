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

/** 35.8's aggregate clocks (a work item's age and claim clocks, a proposal's approval clock): thousands of rows on a worked book, hydrated only by the commands that name their subjects — never by every global command's openGlobal(). */
export const SUBJECT_HYDRATED_KINDS: readonly string[] = ["work_item", "work_action"];
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
        [i.id, i.code, i.subject.kind, i.subject.id, i.loanId || null, i.armedAt, i.armedByEventId, i.anchorDate, i.dueDate ?? null, i.dueAt !== undefined ? new Date(i.dueAt).toISOString() : null,
          i.status, i.satisfiedAt ?? null, i.satisfiedByEventId ?? null, i.breachedAt ?? null, i.cancelledReason ?? null, i.note ?? null, i.applicationId ?? null]);
    }
  }
  /** Armed/breached timers whose subject is neither a loan nor an application (a transfer batch, a partner, a vendor …): what a global command can satisfy (32.12 backend delta — 17.2's proofs of mailing satisfy REGX_1024_33B3_COMBINED_15 on the batch) — less the kinds hydrated by subject (SUBJECT_HYDRATED_KINDS: one row per work item would otherwise be read by every global command). */
  async openGlobal(): Promise<TimerInstance[]> {
    return (await this.db.query<TimerRow>(`SELECT * FROM timers WHERE loan_id IS NULL AND application_id IS NULL AND status IN ('armed', 'breached') AND NOT (subject_kind = ANY($1::text[])) ORDER BY armed_at`, [[...SUBJECT_HYDRATED_KINDS]])).map(rowToInstance);
  }
  /** Armed/breached timers of the named aggregate subjects — what a command that names them (ToolDef.timerSubjects, UowOptions.subjects) hydrates in place of the global read. */
  async forSubjects(subjects: readonly { kind: string; id: string }[]): Promise<TimerInstance[]> {
    if (!subjects.length) return [];
    return (await this.db.query<TimerRow>(`SELECT t.* FROM timers t JOIN unnest($1::text[], $2::text[]) AS s(kind, id) ON s.kind = t.subject_kind AND s.id = t.subject_id WHERE t.status IN ('armed', 'breached') ORDER BY t.armed_at`, [subjects.map((s) => s.kind), subjects.map((s) => s.id)])).map(rowToInstance);
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
  /** 35.1 rule 12: the breach pass claims its due timers `FOR UPDATE SKIP LOCKED` (on the pass's own transaction) so a breach is evaluated once even if a lease ever failed. */
  async dueForUpdate(nowIso: string, q: Queryable = this.db): Promise<TimerInstance[]> {
    return (await q.query<TimerRow>(`SELECT * FROM timers WHERE status = 'armed' AND due_at <= $1 ORDER BY due_at FOR UPDATE SKIP LOCKED`, [nowIso])).map(rowToInstance);
  }
  async forApplication(applicationId: string): Promise<TimerInstance[]> {
    return (await this.db.query<TimerRow>(`SELECT * FROM timers WHERE application_id = $1 ORDER BY armed_at`, [applicationId])).map(rowToInstance);
  }
  async forSubject(kind: string, id: string): Promise<TimerInstance[]> {
    return (await this.db.query<TimerRow>(`SELECT * FROM timers WHERE subject_kind = $1 AND subject_id = $2 ORDER BY armed_at`, [kind, id])).map(rowToInstance);
  }
}
