/**
 * §35.3 rules 6–7 — the jobs table's own policy and repository. `JOB_RETRY` is distinct from the outbox's `DEFAULT_RETRY`
 * (src/infra/integrations/outbox.ts: 5 attempts, 30-minute cap) so a dead unit and a dead message are never confused:
 * attempt 1 at claim, a throw → `failed` with `run_after = now + 60 s`; attempt 2 → `failed`, `+120 s`; attempt 3's throw → `dead`.
 *
 * Every timestamp on a job — `lease_until`, `heartbeat_at`, `run_after`, `finished_at`, `job_events.at` — is bound from the WALL
 * clock (`wallClockOf(rt)`: the base of an OffsetClock, the system clock in production, the FixedClock a test gave the OffsetClock)
 * and never from the demo clock (rule 6, LEASE_IS_WALL_CLOCK): an advance of 400 days cannot expire an in-flight unit (T10), and a
 * test can read `run_after − failed_at` off `job_events.at` under a stepped clock (T4). The column defaults are never relied on.
 *
 * Budget constants: `EXECUTOR_BUDGET_MS` = 240 s of the sweep job's 300 s timeout (infra/terraform/run.tf:351-352; the demo
 * advance's DEFAULT_ADVANCE_BUDGET_MS precedent, src/runtime/demo-clock.ts:62); `CLAIM_LIMIT` = rule 6's `n = 20`; `LEASE_MS` =
 * 5 minutes; `HEARTBEAT_MS` = 30 s.
 */
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import type { Actor, Clock } from "../../kernel/events/index.ts";
import type { Runtime } from "../../runtime/app.ts";

export const JOB_RETRY = { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 15 * 60_000 } as const;
export const EXECUTOR_BUDGET_MS = 240_000;
export const CLAIM_LIMIT = 20;
export const LEASE_MS = 300_000;
export const HEARTBEAT_MS = 30_000;

/** The delay before the next attempt after the `attempt`-th failure: 60 s, 120 s, 240 s … capped at 15 minutes. */
export function backoff(attempt: number): number { return Math.min(JOB_RETRY.baseDelayMs * 2 ** Math.max(0, attempt - 1), JOB_RETRY.maxDelayMs); }

export type JobStatus = "blocked" | "queued" | "running" | "done" | "failed" | "dead" | "abandoned" | "skipped";
export type JobEventKind = "planned" | "blocked" | "unblocked" | "claimed" | "heartbeat" | "done" | "failed" | "dead" | "lease_expired" | "requeued" | "abandoned" | "skipped";

export interface JobRow extends Record<string, unknown> {
  id: string; run_id: string; cycle_code: string; period_key: string; unit_id: string; loan_id: string | null; application_id: string | null; priority: number; depends_on_satisfied: boolean;
  status: JobStatus; attempts: number; max_attempts: number; run_after: string | null; lease_holder: string | null; lease_until: string | null; heartbeat_at: string | null;
  last_error_class: string | null; last_error: string | null; decision_id: string | null; idempotency_key: string; input: Record<string, unknown>; created_at: string; finished_at: string | null;
}
export const JOB_COLS = "id::text AS id, run_id::text AS run_id, cycle_code, period_key, unit_id, loan_id::text AS loan_id, application_id::text AS application_id, priority, depends_on_satisfied, status, attempts, max_attempts, run_after, lease_holder, lease_until, heartbeat_at, last_error_class, last_error, decision_id::text AS decision_id, idempotency_key, input, created_at, finished_at";

/** The wall clock behind the runtime's clock: an OffsetClock's base (the demo offset never reaches a lease), else the clock itself. */
export function wallClockOf(rt: Pick<Runtime, "clock">): Clock {
  const c = rt.clock as Clock & { base?: Clock; refresh?: unknown };
  return c.base && typeof c.refresh === "function" ? c.base : rt.clock;
}
export const plusMs = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** Rule 6's claim, verbatim but for `$wall` in place of `now()`: `FOR UPDATE SKIP LOCKED LIMIT n` — three claimants take disjoint rows (T3). */
export async function claimJobs(q: Queryable, holder: string, n: number, wall: string): Promise<JobRow[]> {
  return q.query<JobRow>(
    `UPDATE jobs SET status = 'running', lease_holder = $1, lease_until = $2::timestamptz + interval '5 minutes', heartbeat_at = $2::timestamptz, attempts = attempts + 1
       WHERE id IN (SELECT id FROM jobs WHERE status = 'queued' AND (run_after IS NULL OR run_after <= $2::timestamptz) ORDER BY priority, created_at FOR UPDATE SKIP LOCKED LIMIT $3)
       RETURNING ${JOB_COLS}`, [holder, wall, n]);
}
/** The executor's heartbeat: `heartbeat_at` and `lease_until` move by wall clock while the holder still owns the lease (a reclaimed job is not touched). */
export async function heartbeat(q: Queryable, jobId: string, holder: string, wall: string): Promise<boolean> {
  const rows = await q.query<{ id: string }>(`UPDATE jobs SET heartbeat_at = $3::timestamptz, lease_until = $3::timestamptz + interval '5 minutes' WHERE id = $1 AND lease_holder = $2 AND status = 'running' RETURNING id::text AS id`, [jobId, holder, wall]);
  return rows.length > 0;
}
export async function getJob(q: Queryable, id: string): Promise<JobRow | undefined> { return (await q.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs WHERE id = $1`, [id]))[0]; }

export interface JobEventInput { readonly job_id: string; readonly kind: JobEventKind; readonly attempt?: number | null; readonly holder?: string | null; readonly actor: Actor; readonly error_class?: string | null; readonly error?: string | null; readonly detail?: Record<string, unknown>; readonly at: string; }
/** One `job_events` row (append-only); `at` is the caller's wall instant (D8). */
export async function appendJobEvent(q: Queryable, e: JobEventInput): Promise<void> {
  await q.query(`INSERT INTO job_events (job_id, kind, attempt, holder, actor_kind, actor_id, actor_role, error_class, error, detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz)`,
    [e.job_id, e.kind, e.attempt ?? null, e.holder ?? null, e.actor.kind, e.actor.id, e.actor.role ?? null, e.error_class ?? null, e.error ?? null, toJson(e.detail ?? {}), e.at]);
}

/** Rule 8 / T13: a unit's input carries ids and dates only — `state`, `custodial`, `changes` or any `*_cents` key is client state and is refused before anything is written. */
export const NO_CLIENT_STATE_KEYS = ["state", "custodial", "changes"] as const;
export function clientStateKey(input: Record<string, unknown> | undefined): string | null {
  if (!input || typeof input !== "object") return null;
  for (const k of Object.keys(input)) { if ((NO_CLIENT_STATE_KEYS as readonly string[]).includes(k) || /_cents$/.test(k)) return k; }
  const nested = input["input"];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) { const k = clientStateKey(nested as Record<string, unknown>); if (k) return `input.${k}`; }
  return null;
}
/** The `error_class` of a unit's throw: the message's leading class-like token (`fake_port_timeout`, `runner_missing`), else the error's name. */
export function errorClassOf(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^([a-z][a-z0-9_]{2,63})(?:\b|:)/.exec(msg.trim());
  if (m) return m[1]!;
  return e instanceof Error && e.name && e.name !== "Error" ? e.name.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase() : "error";
}
