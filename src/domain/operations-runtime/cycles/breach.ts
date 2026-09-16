/**
 * §35.3 rule 9 — "The breach pass is paged." After the executor budget the sweep breaches the due timers in pages of
 * BREACH_PAGE (500): `SELECT * FROM timers WHERE status = 'armed' AND due_at <= $1 ORDER BY due_at LIMIT 500 FOR UPDATE
 * SKIP LOCKED` (35.1's clause plus the LIMIT), one `db.tx` per page, until a page comes back short; a page's transaction is
 * the sweep's existing body (restore into a fresh engine, evaluate, append `timer.breached`, save, one escalation per
 * breach). Two concurrent passes take disjoint pages, so 10,000 due timers produce 20 transactions and exactly the
 * breaches a single pass would have produced, each once (T7). The two 35.3 deadline codes get their escalation enriched
 * here: SM_CYCLE_RUN_STALLED_1D's payload names the run's `cycle_code`, `period_key`, `units_done`/`units_total` (T12);
 * SM_JOB_DEAD_2H's owner role is the registry row's `escalation_role` (the Timers note: "the evaluator reads the row").
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { PgTimerRepository } from "../../../infra/db/timers.ts";
import { TimerEngine, type TimerInstance } from "../../../kernel/timers/engine.ts";
import { MemoryEventStore } from "../../../kernel/events/index.ts";
import { EscalationService } from "../../../app/escalations.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";

export const BREACH_PAGE = 500;
export const STALL_CODE = "SM_CYCLE_RUN_STALLED_1D";
export const DEAD_CODE = "SM_JOB_DEAD_2H";

export interface Breach { readonly loan_id: string | null; readonly code: string; readonly severity: number | null; readonly escalate_to: readonly string[]; readonly timer_id: string; }
export interface BreachPassReport { readonly due: number; readonly breaches: Breach[]; readonly pages: number; readonly page_size: number; }

/** The 35.3 enrichment: the stalled run's counters, the dead job's row and its cycle's escalation role. Tables absent → nothing extra. */
export async function enrichBreach(q: Queryable, inst: TimerInstance): Promise<{ payload: Record<string, unknown>; ownerRole: string | null }> {
  try {
    if (inst.code === STALL_CODE && inst.subject.kind === "cycle_run") {
      const [r] = await q.query<{ cycle_code: string; period_key: string; units_done: number; units_total: number; units_dead: number; status: string }>(`SELECT cycle_code, period_key, units_done, units_total, units_dead, status FROM cycle_runs WHERE id = $1`, [inst.subject.id]);
      return r ? { payload: { run_id: inst.subject.id, cycle_code: r.cycle_code, period_key: r.period_key, units_done: r.units_done, units_total: r.units_total, units_dead: r.units_dead, run_status: r.status }, ownerRole: null } : { payload: {}, ownerRole: null };
    }
    if (inst.code === DEAD_CODE && inst.subject.kind === "job") {
      const [r] = await q.query<{ cycle_code: string; period_key: string; unit_id: string; last_error_class: string | null; escalation_role: string | null; status: string }>(`SELECT j.cycle_code, j.period_key, j.unit_id, j.last_error_class, j.status, r.escalation_role FROM jobs j LEFT JOIN cycle_registry r ON r.cycle_code = j.cycle_code WHERE j.id = $1`, [inst.subject.id]);
      return r ? { payload: { job_id: inst.subject.id, cycle_code: r.cycle_code, period_key: r.period_key, unit_id: r.unit_id, error_class: r.last_error_class, job_status: r.status }, ownerRole: r.escalation_role ?? null } : { payload: {}, ownerRole: null };
    }
  } catch { /* a database without the 35.3 tables: the generic breach */ }
  return { payload: {}, ownerRole: null };
}

/** The paged breach pass (see the header). `SM_SWEEP_HEARTBEAT_DAILY` breaches only when its due day passed with no run at all (35.1 edge case 7) — the same filter the sweep applied. */
export async function breachPass(rt: Runtime, nowIso: string, o: { pageSize?: number } = {}): Promise<BreachPassReport> {
  const pageSize = o.pageSize ?? BREACH_PAGE;
  const asOfDate = wallClock(Date.parse(nowIso), "America/New_York").date;
  const breaches: Breach[] = []; let due = 0; let pages = 0;
  for (;;) {
    // a plain read (no transaction) decides whether another page is worth a transaction: 10,000 due timers are exactly 20 transactions
    if (!(await rt.db.query(`SELECT 1 FROM timers WHERE status = 'armed' AND due_at <= $1 LIMIT 1`, [nowIso])).length) break;
    const page = await rt.db.tx(async (q) => {
      const timerRepo = new PgTimerRepository(q);
      const rows = await timerRepo.dueForUpdate(nowIso, q, pageSize);
      if (!rows.length) return 0;
      const claimed = rows.filter((t) => t.code !== "SM_SWEEP_HEARTBEAT_DAILY" || (t.dueDate ?? wallClock(t.dueAt ?? Date.parse(nowIso), "America/New_York").date) < asOfDate);
      if (claimed.length) {
        const events = new MemoryEventStore(rt.clock);
        const engine = new TimerEngine(rt.registry, events);
        engine.restore(claimed);
        const escalations = new EscalationService(events, rt.clock);
        for (const b of engine.evaluate(nowIso)) {
          const sev = b.severity ?? 4;
          const extra = await enrichBreach(q, b.instance);
          const owner = extra.ownerRole ?? b.escalateTo[0] ?? "ops_analyst";
          escalations.open({ kind: `sev${sev}` as "sev1" | "sev2" | "sev3" | "sev4", ownerRole: owner, ...(b.instance.loanId ? { loanId: b.instance.loanId } : {}), severity: String(sev), slaTimerId: b.instance.id,
            payload: { timer_code: b.instance.code, timer_id: b.instance.id, due_at: b.instance.dueAt !== undefined ? new Date(b.instance.dueAt).toISOString() : null, breach: b.breachText, ...extra.payload } }, { kind: "system", id: "sweep" });
          breaches.push({ loan_id: b.instance.loanId ?? null, code: b.instance.code, severity: b.severity, escalate_to: extra.ownerRole ? [extra.ownerRole, ...b.escalateTo] : [...b.escalateTo], timer_id: b.instance.id });
        }
        const persisted = await rt.uow.events.append(events.since(0), q);
        await timerRepo.save(engine.all().filter((t) => t.status === "breached"), q);
        for (const e of escalations.list()) await rt.escalationRepo.save(e, q);
        rt.uow.notifyCommitted(persisted);
      }
      return rows.length;
    });
    if (page === 0) break;
    pages += 1; due += page;
    if (page < pageSize) break;
  }
  return { due, breaches, pages, page_size: pageSize };
}
