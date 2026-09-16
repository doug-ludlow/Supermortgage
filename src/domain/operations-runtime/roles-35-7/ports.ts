/**
 * §35.7 — the narrow ports on sibling processes, each with an in-repo default so this process runs (and its tests pass)
 * whether or not the neighbour has merged:
 *   35.6  OrchestrationStepsPort — the steps in `waiting_human{role}` (closing_orchestrations.status = waiting_human,
 *         waiting_on = the role); the default reads the table when it exists, else answers none.
 *   35.3  CycleRunsPort — the daily scan's `scan_run_id` (cycle_runs.id when 35.3's table exists, else a fresh uuid);
 *         35.3's registry row `roles.queue_scan` imports ROLES_QUEUE_SCAN (queue.ts) as its runner.
 * A test injects a port through the optional `ports` argument of the runner / pass.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";

export interface WaitingHumanStep { readonly role: string; readonly application_id: string | null; readonly since: string | null }
export interface OrchestrationStepsPort { waitingHuman(q: Queryable): Promise<readonly WaitingHumanStep[]> }
export interface CycleRunsPort { openRun(q: Queryable, i: { as_of: string; planned_by: string }): Promise<string> }
export interface RolesPorts { readonly orchestrationSteps?: OrchestrationStepsPort; readonly cycleRuns?: CycleRunsPort }

const exists = async (q: Queryable, table: string): Promise<boolean> => (await q.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`]))[0]?.r !== null;

export const defaultOrchestrationSteps: OrchestrationStepsPort = {
  async waitingHuman(q) {
    if (!(await exists(q, "closing_orchestrations"))) return [];
    return (await q.query<{ role: string; application_id: string | null; since: string | null }>(`SELECT waiting_on AS role, application_id::text AS application_id, updated_at::text AS since FROM closing_orchestrations WHERE status = 'waiting_human' AND waiting_on IS NOT NULL`)).map((r) => ({ role: r.role, application_id: r.application_id, since: r.since }));
  },
};
export const defaultCycleRuns: CycleRunsPort = {
  async openRun(q, i) {
    if (!(await exists(q, "cycle_runs"))) return randomUUID();
    try {
      const rows = await q.query<{ id: string }>(`INSERT INTO cycle_runs (cycle_code, period_key, as_of_date, planned_by, opened_at, units_total, status) VALUES ('roles.queue_scan', $1, $2::date, $3, now(), 1, 'running') ON CONFLICT (cycle_code, period_key) DO UPDATE SET planned_by = cycle_runs.planned_by RETURNING id::text AS id`, [i.as_of, i.as_of, i.planned_by]);
      return rows[0]?.id ?? randomUUID();
    } catch { return randomUUID(); }
  },
};
export const portsOf = (p: RolesPorts | undefined): Required<RolesPorts> => ({ orchestrationSteps: p?.orchestrationSteps ?? defaultOrchestrationSteps, cycleRuns: p?.cycleRuns ?? defaultCycleRuns });
