/**
 * §35.3 rules 6–7 — the jobs table's mechanics: the claim (`FOR UPDATE SKIP LOCKED LIMIT n`, a wall-clock lease of five
 * minutes written with Postgres `now()` — LEASE_IS_WALL_CLOCK), `JOB_RETRY` (distinct from the outbox's DEFAULT_RETRY:
 * cap 3, 60 s then 120 s; `unavailable` and `runner_missing` go dead at once), the `job_events` chain and the error
 * classification. Every write here runs on the caller's transaction (`Queryable`): the executor's own unit of work or the
 * unit's command.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import { PortUnavailable } from "../../../app/tools.ts";
import { CommandRefused } from "../../../app/commands.ts";

/** Rule 7: "JOB_RETRY, distinct from the outbox's policy" — attempt 1 at claim, a throw → failed with run_after = now + 60 s; attempt 2 → + 120 s; attempt 3's throw → dead. */
export const JOB_RETRY = { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 15 * 60_000 } as const;
/** Rule 6: the lease and its heartbeat, wall clock. */
export const LEASE_MINUTES = 5;
export const HEARTBEAT_MS = 30_000;
export const CLAIM_LIMIT = 20;
/** Rule 6: the executor stops claiming once 240 s of the job's 300 s timeout have elapsed (the demo advance's DEFAULT_ADVANCE_BUDGET_MS precedent, demo-clock.ts:62; run.tf:351). */
export const EXECUTOR_BUDGET_MS = 240_000;

export type JobStatus = "blocked" | "queued" | "running" | "done" | "failed" | "dead" | "abandoned" | "skipped";
export type JobEventKind = "planned" | "blocked" | "unblocked" | "claimed" | "heartbeat" | "done" | "failed" | "dead" | "lease_expired" | "requeued" | "abandoned" | "skipped";

export interface JobRow extends Record<string, unknown> {
  id: string; run_id: string; cycle_code: string; period_key: string; unit_id: string; loan_id: string | null; application_id: string | null; priority: number; depends_on_satisfied: boolean;
  status: JobStatus; attempts: number; max_attempts: number; run_after: string | null; lease_holder: string | null; lease_until: string | null; heartbeat_at: string | null;
  last_error_class: string | null; last_error: string | null; decision_id: string | null; idempotency_key: string; input: Record<string, unknown>; created_at: string; finished_at: string | null;
}
export const JOB_COLS = `id, run_id, cycle_code, period_key, unit_id, loan_id, application_id, priority, depends_on_satisfied, status, attempts, max_attempts, run_after::text AS run_after, lease_holder, lease_until::text AS lease_until, heartbeat_at::text AS heartbeat_at, last_error_class, last_error, decision_id, idempotency_key, input, created_at::text AS created_at, finished_at::text AS finished_at`;

/** The backoff after a failed attempt `n` (1-based): 60 s, 120 s, … capped at 15 minutes. */
export const retryDelayMs = (attempt: number): number => Math.min(JOB_RETRY.baseDelayMs * 2 ** Math.max(0, attempt - 1), JOB_RETRY.maxDelayMs);

/** The outbox's `FailureKind` vocabulary (outbox.ts:123) applied to a unit: a port or service that is down cannot be helped by a retry in a minute. */
export class RunnerMissing extends Error { readonly runner: string; constructor(runner: string) { super(`no runner ${runner} has landed (a def-less cycle is runner_missing)`); this.name = "RunnerMissing"; this.runner = runner; } }
export function classifyError(e: unknown): { error_class: string; message: string; dead_now: boolean } {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  if (e instanceof RunnerMissing) return { error_class: "runner_missing", message, dead_now: true };
  if (e instanceof PortUnavailable || (e instanceof Error && e.name === "PortUnavailable")) return { error_class: "unavailable", message, dead_now: true };
  if (e instanceof Error && (e.name === "TransientFailure" || /\b(ECONNREFUSED|ETIMEDOUT|unavailable|outage|port .* is down)\b/i.test(message))) return { error_class: "unavailable", message, dead_now: true };
  if (e instanceof CommandRefused) return { error_class: `refused:${e.code}`, message, dead_now: false };
  return { error_class: e instanceof Error && e.name && e.name !== "Error" ? e.name : "error", message, dead_now: false };
}

export async function jobEvent(q: Queryable, jobId: string, kind: JobEventKind, o: { attempt?: number | null; holder?: string | null; actor: Actor; error_class?: string | null; error?: string | null; detail?: Record<string, unknown> }): Promise<void> {
  await q.query(`INSERT INTO job_events (job_id, kind, attempt, holder, actor_kind, actor_id, actor_role, error_class, error, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [jobId, kind, o.attempt ?? null, o.holder ?? null, o.actor.kind, o.actor.id, o.actor.role ?? null, o.error_class ?? null, o.error ?? null, JSON.stringify(o.detail ?? {})]);
}

/** Rule 6's claim, verbatim: the queued jobs whose `run_after` has passed, by priority then age, `FOR UPDATE SKIP LOCKED LIMIT n`; the lease is `now() + 5 minutes` of wall clock. */
export async function claimSql(q: Queryable, holder: string, limit: number = CLAIM_LIMIT, exclude: readonly string[] = []): Promise<JobRow[]> {
  return q.query<JobRow>(
    `UPDATE jobs SET status = 'running', lease_holder = $1, lease_until = now() + interval '${LEASE_MINUTES} minutes', heartbeat_at = now(), attempts = attempts + 1
      WHERE id IN (SELECT id FROM jobs WHERE status = 'queued' AND (run_after IS NULL OR run_after <= now()) AND NOT (cycle_code = ANY($3::text[])) ORDER BY priority, created_at FOR UPDATE SKIP LOCKED LIMIT $2)
      RETURNING ${JOB_COLS}`, [holder, Math.max(1, Math.min(500, limit)), [...exclude]]);
}
/** The heartbeat (rule 6): `heartbeat_at` and `lease_until` extended by five minutes, wall clock, for the holder's running jobs. */
export async function heartbeatSql(q: Queryable, holder: string, jobIds: readonly string[]): Promise<number> {
  if (!jobIds.length) return 0;
  return (await q.query(`UPDATE jobs SET heartbeat_at = now(), lease_until = now() + interval '${LEASE_MINUTES} minutes' WHERE status = 'running' AND lease_holder = $1 AND id = ANY($2::uuid[]) RETURNING id`, [holder, [...jobIds]])).length;
}
export async function loadJob(q: Queryable, id: string, forUpdate = false): Promise<JobRow | undefined> {
  return (await q.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]))[0];
}

export interface RunCounters extends Record<string, unknown> { units_total: number; units_done: number; units_dead: number; units_skipped: number; status: string; cycle_code: string; period_key: string; as_of_date: string; }
export const RUN_COLS = `id, cycle_code, period_key, as_of_date::text AS as_of_date, planned_by, opened_at::text AS opened_at, units_total, units_done, units_dead, units_skipped, status, completed_at::text AS completed_at, receipt_id, cancelled_by, cancelled_reason, demo_offset_ms::text AS demo_offset_ms, created_at::text AS created_at`;
export const countersFull = (c: RunCounters): boolean => c.units_done + c.units_dead + c.units_skipped >= c.units_total && c.units_dead === 0;
