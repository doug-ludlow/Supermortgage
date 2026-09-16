/**
 * §35.4 — the narrow ports on the neighbours this close depends on, each with an in-repo default so the process runs
 * (and its tests pass) whether or not the neighbour has merged (the roles-35-7/ports.ts pattern):
 *   35.3  CyclesPort — planning a step's units as 35.3 jobs (`cycle_runs` + `jobs` when the tables exist; otherwise the
 *         units are recorded on the step's `close.step.planned` journal row only), the first claim and the dead count.
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
import type { Runtime } from "../../../runtime/app.ts";
import { DEFAULT_SERVICER_NUMBER, HUMAN_APPROVAL_ENV, SERVICER_NUMBER_ENV } from "./types.ts";

export interface PlannedUnit { readonly unit_id: string; readonly loan_id?: string | null; readonly input: Record<string, unknown> }
export interface PlanUnitsInput { readonly cycle_code: string; readonly period_key: string; readonly as_of_date: string; readonly planned_by: string; readonly units: readonly PlannedUnit[] }
export interface PlanUnitsResult { readonly run_id: string; readonly job_ids: readonly string[]; readonly persisted: boolean }
export interface CyclesPort {
  /** Idempotent per (cycle_code, period_key, unit_id) — 35.3 rule 3. */
  planUnits(q: Queryable, i: PlanUnitsInput): Promise<PlanUnitsResult>;
  /** The instant the first unit of the run was claimed (35.3 `job.unit.claimed`), else null. */
  claimedAt(q: Queryable, run_id: string): Promise<string | null>;
  /** True when every unit of the run is dead (35.3 `job.unit.dead` on every unit). */
  allDead(q: Queryable, run_id: string): Promise<boolean>;
  /** Whether 35.3's executor is present (its `jobs` table exists); when it is not, the sweep runs the planned units inline through this process's runners. */
  executorPresent(q: Queryable): Promise<boolean>;
}
export interface DocumentBytesPort { read(q: Queryable, document_id: string): Promise<Buffer | null> }
export interface ConfigPort { humanApprovalOn(q: Queryable, period: string, periodEnd: string): Promise<boolean> }
export interface ServicerNumberPort { servicerNumber(q: Queryable): Promise<string> }
export interface ClosePorts { readonly cycles?: CyclesPort; readonly documents?: DocumentBytesPort; readonly config?: ConfigPort; readonly servicer?: ServicerNumberPort }

const exists = async (q: Queryable, table: string): Promise<boolean> => (await q.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`]))[0]?.r !== null;

export const defaultCycles: CyclesPort = {
  async planUnits(q, i) {
    if (!(await exists(q, "cycle_runs")) || !(await exists(q, "jobs"))) return { run_id: randomUUID(), job_ids: i.units.map(() => randomUUID()), persisted: false };
    try {
      const run = await q.query<{ id: string }>(`INSERT INTO cycle_runs (cycle_code, period_key, as_of_date, planned_by, opened_at, units_total, status) VALUES ($1, $2, $3::date, $4, now(), $5, 'planned') ON CONFLICT (cycle_code, period_key) DO UPDATE SET planned_by = cycle_runs.planned_by RETURNING id::text AS id`, [i.cycle_code, i.period_key, i.as_of_date, i.planned_by, i.units.length]);
      const runId = run[0]!.id; const ids: string[] = [];
      for (const u of i.units) {
        const r = await q.query<{ id: string }>(`INSERT INTO jobs (run_id, cycle_code, period_key, unit_id, loan_id, status, idempotency_key, input) VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7::jsonb) ON CONFLICT (idempotency_key) DO UPDATE SET unit_id = jobs.unit_id RETURNING id::text AS id`, [runId, i.cycle_code, i.period_key, u.unit_id, u.loan_id ?? null, `${i.cycle_code}:${i.period_key}:${u.unit_id}`, JSON.stringify(u.input)]);
        ids.push(r[0]!.id);
      }
      return { run_id: runId, job_ids: ids, persisted: true };
    } catch { return { run_id: randomUUID(), job_ids: i.units.map(() => randomUUID()), persisted: false }; }
  },
  async claimedAt(q, run_id) {
    if (!(await exists(q, "jobs"))) return null;
    try { const r = await q.query<{ at: string | null }>(`SELECT min(coalesce(heartbeat_at, finished_at))::text AS at FROM jobs WHERE run_id = $1 AND status IN ('running', 'done', 'failed', 'dead')`, [run_id]); return r[0]?.at ?? null; } catch { return null; }
  },
  async allDead(q, run_id) {
    if (!(await exists(q, "jobs"))) return false;
    try { const r = await q.query<{ total: string; dead: string }>(`SELECT count(*)::text AS total, count(*) FILTER (WHERE status = 'dead')::text AS dead FROM jobs WHERE run_id = $1`, [run_id]); return Number(r[0]?.total ?? 0) > 0 && r[0]!.total === r[0]!.dead; } catch { return false; }
  },
  async executorPresent(q) { return exists(q, "jobs"); },
};
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
    const r = await q.query<{ n: string | null }>(`SELECT servicer_number AS n FROM parties WHERE party_type = 'servicer' AND servicer_number IS NOT NULL ORDER BY created_at LIMIT 1`).catch(() => [] as { n: string | null }[]);
    return r[0]?.n ?? env[SERVICER_NUMBER_ENV] ?? DEFAULT_SERVICER_NUMBER;
  },
});

const registry = new WeakMap<object, ClosePorts>();
/** A test's injection point; keyed by the Runtime (or its root) so the command view sees the same ports. */
export function setClosePorts(rt: Runtime, ports: ClosePorts): void { registry.set(rt.root ?? rt, ports); }
export function closePorts(rt: Runtime): Required<ClosePorts> {
  const p = registry.get(rt.root ?? rt) ?? {};
  return { cycles: p.cycles ?? defaultCycles, documents: p.documents ?? defaultDocumentBytes, config: p.config ?? configFromEnv(rt.env), servicer: p.servicer ?? servicerFromDb(rt.env) };
}
