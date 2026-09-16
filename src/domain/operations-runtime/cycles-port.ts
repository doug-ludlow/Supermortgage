/**
 * §35.5 — the narrow port on 35.3 (cycles, jobs, receipts), with an in-repo default so this process runs (and its tests pass)
 * whether or not 35.3 has merged (the 35.7 roles-35-7/ports.ts precedent):
 *
 *   CyclesPort.openRun(q, {cycle_code, as_of_date, planned_by, units_total})   one `cycle_runs` row per (cycle_code, period_key);
 *   CyclesPort.completeRun(q, run_id, counts)                                   its counters and `completed` status;
 *   CyclesPort.readRun(q, cycle_code, period_key)                               what a test or the receipt reads back.
 *
 * Default: 35.3's `cycle_runs` table when it exists (its `cycle_registry` row for the code is inserted when 35.3's seed has not
 * written it — the registry def 35.3 carries for `cashiering_daily` names 35.5 as owner, `cashiering` as agent); without the
 * table the run is read off the day's receipt event (`<receipt_event>{as_of_date, loans, units_…}`) — no side row of an
 * un-projected kind (35.1's verify would count it). Once 35.3's planner drives the units, its runner delegates to
 * `runCashieringUnit` (cashiering-cycle.ts) and this port's default is never reached on a live database.
 */
import type { Queryable } from "../../infra/db/client.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";

export interface CycleRunCounts { readonly units_total?: number; readonly units_done?: number; readonly units_dead?: number; readonly units_skipped?: number; }
export interface CycleRunRow { readonly id: string; readonly cycle_code: string; readonly period_key: string; readonly as_of_date: PlainDate; readonly status: string; readonly units_total: number; readonly units_done: number; readonly units_dead: number; readonly units_skipped: number; readonly opened_at: string; readonly completed_at: string | null; readonly receipt_id: string | null; }
export interface CyclesPort {
  openRun(q: Queryable, i: { cycle_code: string; as_of_date: PlainDate; planned_by: string; units_total: number; now: string; demo_offset_ms?: number }): Promise<string>;
  completeRun(q: Queryable, runId: string, i: CycleRunCounts & { now: string; receipt_id?: string | null }): Promise<void>;
  readRun(q: Queryable, cycle_code: string, period_key: string): Promise<CycleRunRow | null>;
}

/** The registry rows 35.5 owns, in 35.3's `cycle_registry` shape (its cycles.ts names the same codes, owner, agent, selector, runner and receipt event). */
export const CASHIERING_CYCLE_DEFS = {
  cashiering_daily: { owner_process: "35.5", owner_agent: "cashiering", unit_scope: "loan", schedule: "daily, every active loan (2.1 post received payments, 2.7 daily_run, 2.3 amount-change check)", period_grammar: "day", unit_selector: "active_loans_daily", unit_runner: "cashiering_daily", receipt_event: "cashiering.daily.run_completed", serves_timer: "SM_CASHIERING_DAILY_RECEIPT_1D", expected_by_rule: "same_day 23:59 ET" },
  lockbox_ingest: { owner_process: "35.5", owner_agent: "cashiering", unit_scope: "account", schedule: "per lockbox per business_days_servicer; the file by 10:00 in lockbox_batches.cutoff_tz", period_grammar: "day", unit_selector: "lockboxes_daily", unit_runner: "lockbox_ingest", receipt_event: "lockbox.ingest.run_completed", serves_timer: "SM_LOCKBOX_FILE_EXPECTED_1BD", expected_by_rule: "same_day 10:00 ET" },
  ach_file_build: { owner_process: "35.5", owner_agent: "cashiering", unit_scope: "global", schedule: "every banking day (business_days_federal) by 14:00 ET", period_grammar: "day", unit_selector: "period_global", unit_runner: "ach_file_build", receipt_event: "ach.file_build.run_completed", serves_timer: "SM_ACH_FILE_BUILD_1BD", expected_by_rule: "same_day 14:00 ET" },
  ach_returns_ingest: { owner_process: "35.5", owner_agent: "cashiering", unit_scope: "global", schedule: "every banking day 08:00 ET", period_grammar: "day", unit_selector: "period_global", unit_runner: "ach_returns_ingest", receipt_event: "ach.returns_ingest.run_completed", serves_timer: "SM_ACH_RETURN_ACTIONED_1BD", expected_by_rule: "same_day 23:59 ET" },
} as const;
export type CashieringCycleCode = keyof typeof CASHIERING_CYCLE_DEFS;

const exists = async (q: Queryable, table: string): Promise<boolean> => (await q.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`]))[0]?.r !== null;
const n = (v: unknown): number => Number(v ?? 0);

async function ensureRegistryRow(q: Queryable, code: string): Promise<void> {
  const d = CASHIERING_CYCLE_DEFS[code as CashieringCycleCode]; if (!d) throw new RangeError(`no 35.5 cycle ${code}`);
  await q.query(`INSERT INTO cycle_registry (cycle_code, owner_process, owner_agent, unit_scope, schedule, period_grammar, unit_selector, unit_runner, receipt_event, serves_timer, escalation_role, expected_by_rule, registry_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ops_analyst', $11, '35.5-port') ON CONFLICT (cycle_code) DO NOTHING`, [code, d.owner_process, d.owner_agent, d.unit_scope, d.schedule, d.period_grammar, d.unit_selector, d.unit_runner, d.receipt_event, d.serves_timer, d.expected_by_rule]);
}

const rowOf = (r: Record<string, unknown>): CycleRunRow => ({ id: String(r.id), cycle_code: String(r.cycle_code), period_key: String(r.period_key), as_of_date: String(r.as_of_date).slice(0, 10) as PlainDate, status: String(r.status), units_total: n(r.units_total), units_done: n(r.units_done), units_dead: n(r.units_dead), units_skipped: n(r.units_skipped), opened_at: String(r.opened_at), completed_at: (r.completed_at as string | null) ?? null, receipt_id: (r.receipt_id as string | null) ?? null });

/** The table-backed default (35.3 merged) and, without 35.3's tables, a read of the day's receipt: the run's counters live on `cashiering.daily.run_completed` (no side row — 35.1's verify counts every un-projected kind, and the receipt is the record the cycle leaves either way). */
export const defaultCyclesPort: CyclesPort = {
  async openRun(q, i) {
    const periodKey = i.as_of_date;
    if (!(await exists(q, "cycle_runs"))) return `${i.cycle_code}:${periodKey}`;
    await ensureRegistryRow(q, i.cycle_code);
    const rows = await q.query<{ id: string }>(`INSERT INTO cycle_runs (cycle_code, period_key, as_of_date, planned_by, opened_at, units_total, status, demo_offset_ms) VALUES ($1, $2, $2::date, $3, $4, $5, 'running', $6)
      ON CONFLICT (cycle_code, period_key) DO UPDATE SET units_total = GREATEST(cycle_runs.units_total, EXCLUDED.units_total), status = CASE WHEN cycle_runs.status = 'completed' THEN 'completed' ELSE 'running' END RETURNING id`, [i.cycle_code, periodKey, i.planned_by, i.now, i.units_total, i.demo_offset_ms ?? 0]);
    return rows[0]!.id;
  },
  async completeRun(q, runId, i) {
    if (!(await exists(q, "cycle_runs"))) return;
    await q.query(`UPDATE cycle_runs SET units_total = coalesce($2, units_total), units_done = coalesce($3, units_done), units_dead = coalesce($4, units_dead), units_skipped = coalesce($5, units_skipped), status = 'completed', completed_at = $6, receipt_id = coalesce($7::uuid, receipt_id) WHERE id = $1`, [runId, i.units_total ?? null, i.units_done ?? null, i.units_dead ?? null, i.units_skipped ?? null, i.now, i.receipt_id ?? null]);
  },
  async readRun(q, cycleCode, periodKey) {
    if (await exists(q, "cycle_runs")) {
      const rows = await q.query<Record<string, unknown>>(`SELECT id::text AS id, cycle_code, period_key, as_of_date::text AS as_of_date, status, units_total, units_done, units_dead, units_skipped, opened_at::text AS opened_at, completed_at::text AS completed_at, receipt_id::text AS receipt_id FROM cycle_runs WHERE cycle_code = $1 AND period_key = $2`, [cycleCode, periodKey]);
      return rows[0] ? rowOf(rows[0]) : null;
    }
    const d = CASHIERING_CYCLE_DEFS[cycleCode as CashieringCycleCode]; if (!d) return null;
    const ev = await q.query<{ id: string; payload: Record<string, unknown>; occurred_at: string }>(`SELECT id::text AS id, payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = $2 ORDER BY sequence LIMIT 1`, [d.receipt_event, periodKey]);
    if (!ev[0]) return null;
    const p = ev[0].payload;
    return { id: `${cycleCode}:${periodKey}`, cycle_code: cycleCode, period_key: periodKey, as_of_date: periodKey as PlainDate, status: "completed", units_total: n(p.loans ?? p.units_total), units_done: n(p.units_done) + n(p.units_already) + n(p.units_skipped_hold), units_dead: n(p.units_dead), units_skipped: n(p.units_no_config ?? p.units_skipped), opened_at: String(p.at ?? ev[0].occurred_at), completed_at: ev[0].occurred_at, receipt_id: ev[0].id };
  },
};
