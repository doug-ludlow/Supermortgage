/**
 * §35.4 — the narrow ports on the neighbours this close depends on, each with an in-repo default so the process runs
 * (and its tests pass) whether or not the neighbour runs on the runtime (the roles-35-7/ports.ts pattern):
 *   35.3  CyclesPort — the chain's cycle steps on 35.3's own tables (`cycle_runs` / `jobs`, db/migrations/0146) through
 *         35.3's registry (service.ts cyclesOf): a cycle whose 35.3 runner has landed is planned as 35.3 jobs — the run
 *         35.3's planner opened for the (cycle, period) is reused and its `blocked` jobs are queued the moment the chain's
 *         dependencies (the owning sections' own receipts, rule 2) are met, so 35.3's executor runs the units (rule 1:
 *         "a 35.3 job per unit exists"); when 35.3's planner has not opened the run (a runtime without `databaseUrl`, where
 *         35.3's cycles pass is skipped) the run and its jobs are written here with the same keys 35.3 uses (rule 3's
 *         idempotency). A cycle whose runner has not landed (6.3's daily, 5.1's LAR at HEAD) is recorded on the step's
 *         `close.step.planned` journal row only and the sweep's inline runners / the FAKE neighbours stand in (sweep.ts).
 *         `claimedAt` reads 35.3's `job.unit.claimed` events (the runtime clock — a demo advance's day, never the wall
 *         clock of the lease), `allDead` the jobs. `executorPresent` is 35.3's own condition for its cycles pass
 *         (src/domain/operations-runtime/service.ts cyclesSweepPass: a runtime without `databaseUrl` never plans).
 *   35.2  DocumentBytesPort — the stored statement's bytes (`document_blobs.content` once 35.2's table exists; before it there
 *         are no stored bytes — a test injects its own port; the hash is the bytes, 35.2 rule 1, so no second bytes path).
 *   6.3   ConfigPort — `custodial.form496.human_approval` from configuration, never from the request (rule 7): 6.3's own rule
 *         computed from typed rows (first six months, an item aged > 60 days, a corporate funding > $25,000), pinnable by the
 *         environment (35.7 env.ts precedent) — no configuration table exists at HEAD.
 *   5.1   ServicerNumberPort — the servicer number the period keys on (the servicer party's, else the environment's, else 6.3's fixture number).
 * A test injects a port through `setClosePorts(rt, …)`; production runs the defaults.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { cyclesOf, OPS_STEWARD } from "../service.ts";
import { appendJobEvent, wallClockOf } from "../jobs.ts";
import { DEFAULT_SERVICER_NUMBER, HUMAN_APPROVAL_ENV, SERVICER_NUMBER_ENV } from "./types.ts";

export interface PlannedUnit { readonly unit_id: string; readonly loan_id?: string | null; readonly input: Record<string, unknown> }
export interface PlanUnitsInput { readonly cycle_code: string; readonly period_key: string; readonly as_of_date: string; readonly planned_by: string; readonly units: readonly PlannedUnit[] }
/** `persisted`: the units are 35.3 jobs (`run_id` a `cycle_runs` row); else the plan is journaled only and the sweep's inline runners / the FAKE neighbours stand in. `reused`: 35.3's planner had opened the run; `queued`: its blocked jobs this call queued. */
export interface PlanUnitsResult { readonly run_id: string; readonly job_ids: readonly string[]; readonly persisted: boolean; readonly reused?: boolean; readonly queued?: number }
export interface CyclesPort {
  /** Idempotent per (cycle_code, period_key, unit_id) — 35.3 rule 3. */
  planUnits(q: Queryable, i: PlanUnitsInput): Promise<PlanUnitsResult>;
  /** The instant the first unit of the run was claimed (35.3 `job.unit.claimed`, the runtime clock), else null. */
  claimedAt(q: Queryable, run_id: string): Promise<string | null>;
  /** True when every unit of the run is dead (35.3 `job.unit.dead` on every unit). */
  allDead(q: Queryable, run_id: string): Promise<boolean>;
  /** Whether 35.3's cycles pass (planner and executor) runs on this runtime — its own condition: a `databaseUrl` for the planner lock (service.ts cyclesSweepPass). */
  executorPresent(): boolean;
  /** Whether 35.3's registry on this runtime carries a runner for the cycle (the owner's unit has landed; runners.ts / cycles-35-4.ts). */
  runnerPresent(cycle_code: string): boolean;
}
export interface DocumentBytesPort { read(q: Queryable, document_id: string): Promise<Buffer | null> }
export interface ConfigPort { humanApprovalOn(q: Queryable, period: string, periodEnd: string): Promise<boolean> }
export interface ServicerNumberPort { servicerNumber(q: Queryable): Promise<string> }
export interface ClosePorts { readonly cycles?: CyclesPort; readonly documents?: DocumentBytesPort; readonly config?: ConfigPort; readonly servicer?: ServicerNumberPort }

const exists = async (q: Queryable, table: string): Promise<boolean> => (await q.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`]))[0]?.r !== null;
const journalOnly = (i: PlanUnitsInput): PlanUnitsResult => ({ run_id: randomUUID(), job_ids: i.units.map(() => randomUUID()), persisted: false });

/** Whether the owner's unit for `cycle_code` runs on this runtime: 35.3's cycles pass runs here AND its registry carries a runner for the cycle. Else the sweep's inline runners and the FAKE neighbours (nonprod) stand in. */
export function ownerRuns(rt: Runtime, cycle_code: string): boolean { return !!rt.databaseUrl && !!cyclesOf(rt).def(cycle_code)?.runner; }

/** 35.3's tables through 35.3's registry (see the header). */
export const cyclesPort35_3 = (rt: Runtime): CyclesPort => ({
  async planUnits(q, i) {
    if (!(await exists(q, "cycle_runs")) || !(await exists(q, "jobs"))) return journalOnly(i);
    const def = cyclesOf(rt).def(i.cycle_code);
    // the owner's unit has not landed in 35.3's registry (6.3's daily, 5.1's LAR at HEAD): no 35.3 job — the plan is journaled and the inline / FAKE path runs it (a run 35.3 did not plan is never written into its table)
    if (!def?.runner) return journalOnly(i);
    const wall = wallClockOf(rt).now(); const openedAt = rt.clock.now();   // D8: `job_events.at` binds the wall clock; `opened_at` the runtime clock the registry's clocks measure
    // a savepoint: a schema this port does not know must not poison the planner's transaction — the plan is journaled either way
    await q.query("SAVEPOINT sm_close_plan_units");
    try {
      const existing = (await q.query<{ id: string }>(`SELECT id::text AS id FROM cycle_runs WHERE cycle_code = $1 AND period_key = $2`, [i.cycle_code, i.period_key]))[0];
      if (existing) {
        // 35.3's planner opened the run (rule 3: one per (cycle, period)) with its own units, `blocked` on its registry row's dependency; the chain's dependencies — the owning sections' own receipts (rule 2) — are met, so the units are queued for 35.3's executor (`job_events{unblocked}` names the planner that did it)
        const blocked = await q.query<{ id: string }>(`UPDATE jobs SET status = 'queued', depends_on_satisfied = true WHERE run_id = $1 AND status = 'blocked' RETURNING id::text AS id`, [existing.id]);
        for (const j of blocked) await appendJobEvent(q, { job_id: j.id, kind: "unblocked", actor: OPS_STEWARD, at: wall, detail: { by: i.planned_by, planner: "35.4 close.plan", reason: "the close chain's dependencies are met (35.4 rule 1: the owning sections' own receipts)" } });
        const jobs = await q.query<{ id: string }>(`SELECT id::text AS id FROM jobs WHERE run_id = $1 ORDER BY created_at, id`, [existing.id]);
        await q.query("RELEASE SAVEPOINT sm_close_plan_units");
        return { run_id: existing.id, job_ids: jobs.map((j) => j.id), persisted: true, reused: true, queued: blocked.length };
      }
      // 35.3's planner has not opened the period's run (its cycles pass does not run on this runtime): its registry projected first (35.3 rule 2 — `cycle_runs.cycle_code` references it), then the run and its jobs with 35.3's own keys — `<cycle_code>:<period_key>:<unit_id>` (rule 3) — queued, since the chain's dependencies are met
      await cyclesOf(rt).upsertRegistry(q, wall);
      const run = await q.query<{ id: string }>(`INSERT INTO cycle_runs (cycle_code, period_key, as_of_date, planned_by, opened_at, units_total, status) VALUES ($1, $2, $3::date, $4, $5::timestamptz, $6, 'planned') ON CONFLICT (cycle_code, period_key) DO UPDATE SET planned_by = cycle_runs.planned_by RETURNING id::text AS id`, [i.cycle_code, i.period_key, i.as_of_date, i.planned_by, openedAt, i.units.length]);
      const runId = run[0]!.id; const ids: string[] = [];
      for (const u of i.units) {
        const r = await q.query<{ id: string; inserted: boolean }>(`INSERT INTO jobs (run_id, cycle_code, period_key, unit_id, loan_id, status, idempotency_key, input) VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7::jsonb) ON CONFLICT (idempotency_key) DO UPDATE SET unit_id = jobs.unit_id RETURNING id::text AS id, (xmax = 0) AS inserted`, [runId, i.cycle_code, i.period_key, u.unit_id, u.loan_id ?? null, `${i.cycle_code}:${i.period_key}:${u.unit_id}`, toJson(u.input)]);
        ids.push(r[0]!.id);
        if (r[0]!.inserted) await appendJobEvent(q, { job_id: r[0]!.id, kind: "planned", actor: OPS_STEWARD, at: wall, detail: { run_id: runId, period_key: i.period_key, unit_id: u.unit_id, planned_by: i.planned_by, planner: "35.4 close.plan" } });
      }
      await q.query("RELEASE SAVEPOINT sm_close_plan_units");
      return { run_id: runId, job_ids: ids, persisted: true };
    } catch (e) { await q.query("ROLLBACK TO SAVEPOINT sm_close_plan_units"); rt.logger?.warn("close: 35.3 jobs not written, the plan is journaled only", { cycle_code: i.cycle_code, period_key: i.period_key, error: e instanceof Error ? e.message : String(e) }); return journalOnly(i); }
  },
  async claimedAt(q, run_id) {
    // the first claim of any unit of the run — 35.3's `job.unit.claimed` (the executor's, or a by-hand `cycles.run_unit`), on the runtime clock the clocks measure (D8: the lease's heartbeat is wall clock, never a demo day)
    const r = await q.query<{ at: string | null }>(`SELECT to_char(min(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM loan_events WHERE type = 'job.unit.claimed' AND payload->>'run_id' = $1`, [run_id]);
    return r[0]?.at ?? null;
  },
  async allDead(q, run_id) {
    if (!(await exists(q, "jobs"))) return false;
    const r = await q.query<{ total: string; dead: string }>(`SELECT count(*)::text AS total, count(*) FILTER (WHERE status = 'dead')::text AS dead FROM jobs WHERE run_id = $1`, [run_id]);
    return Number(r[0]?.total ?? 0) > 0 && r[0]!.total === r[0]!.dead;
  },
  executorPresent() { return !!rt.databaseUrl; },
  runnerPresent(code) { return !!cyclesOf(rt).def(code)?.runner; },
});
export const defaultDocumentBytes: DocumentBytesPort = {
  // 35.2 rule 1: "the hash is the bytes" — the staged copy is the only bytes path; before 35.2's table exists there are no stored bytes to re-read (a test injects its own port)
  async read(q, document_id) {
    if (!(await exists(q, "document_blobs"))) return null;
    const r = await q.query<{ content: Buffer | null }>(`SELECT content FROM document_blobs WHERE document_id = $1`, [document_id]); return r[0]?.content ? Buffer.from(r[0].content) : null;
  },
};
/** Rule 7 / 6.3's rule: `custodial.form496.human_approval` is on for the first six months of the platform's closes, for any month with an item aged > 60 days at the period end, and for a corporate funding > $25,000 in the period; the environment may pin it (`on` | `off`), default `auto`. Read at call time, recorded on the row as `human_approval_flag`, never from the request (FLAG_FROM_CONFIG). */
export const CORPORATE_FUNDING_THRESHOLD_CENTS = 2_500_000n;   // $25,000.00 (6.3)
export const configFromEnv = (env: NodeJS.ProcessEnv): ConfigPort => ({
  async humanApprovalOn(q, period, periodEnd) {
    const v = (env[HUMAN_APPROVAL_ENV] ?? "auto").trim().toLowerCase();
    if (v === "on" || v === "true" || v === "1") return true;
    if (v === "off" || v === "false" || v === "0") return false;
    const first = (await q.query<{ p: string | null }>(`SELECT min(period)::text AS p FROM close_periods WHERE kind = 'month'`))[0]?.p ?? period;
    const months = (Number(period.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + (Number(period.slice(5, 7)) - Number(first.slice(5, 7)));
    if (months < 6) return true;
    const aged = (await q.query<{ c: string }>(`SELECT count(*)::text AS c FROM reconciliation_items WHERE status NOT IN ('cleared', 'posted', 'written_off') AND first_seen_on <= $1::date - 60 AND (resolved_on IS NULL OR resolved_on > $1::date)`, [periodEnd]))[0]?.c ?? "0";
    if (Number(aged) > 0) return true;
    const funded = (await q.query<{ s: string }>(`SELECT coalesce(max(abs(amount_cents)), 0)::text AS s FROM reconciliation_items WHERE status = 'funded' AND resolved_on >= $1::date AND resolved_on <= $2::date`, [`${period}-01`, periodEnd]))[0]?.s ?? "0";
    return BigInt(funded) > CORPORATE_FUNDING_THRESHOLD_CENTS;
  },
});
export const servicerFromDb = (env: NodeJS.ProcessEnv): ServicerNumberPort => ({
  async servicerNumber(q) {
    const r = await q.query<{ n: string | null }>(`SELECT servicer_number AS n FROM parties WHERE party_type = 'servicer' AND servicer_number IS NOT NULL ORDER BY created_at LIMIT 1`);   // never caught: a failed query inside the command's transaction poisons it, and parties.servicer_number is the baseline's (0001)
    return r[0]?.n ?? env[SERVICER_NUMBER_ENV] ?? DEFAULT_SERVICER_NUMBER;
  },
});

const registry = new WeakMap<object, ClosePorts>();
/** A test's injection point; keyed by the Runtime (or its root) so the command view sees the same ports. */
export function setClosePorts(rt: Runtime, ports: ClosePorts): void { registry.set(rt.root ?? rt, ports); }
export function closePorts(rt: Runtime): Required<ClosePorts> {
  const p = registry.get(rt.root ?? rt) ?? {};
  return { cycles: p.cycles ?? cyclesPort35_3(rt), documents: p.documents ?? defaultDocumentBytes, config: p.config ?? configFromEnv(rt.env), servicer: p.servicer ?? servicerFromDb(rt.env) };
}
