/**
 * §35.1 rule 12 — the sweep is one execution at a time: "A sweep takes `pg_try_advisory_lock(35_001)` on a dedicated client
 * (test-lock.ts:15-20 pattern); a firing that does not get it writes `sweep_runs{outcome: skipped, skipped_reason:
 * lease_held}` and `sweep.run_skipped{holder}` and exits 0; the holder writes `sweep_runs{running}`, heartbeats every pass,
 * and finishes with `completed` and `sweep.run_completed` in its own final transaction." LEASE_DIES_WITH_SESSION: the
 * session-level lock is the lock; `sweep_runs` is the evidence (open question 3). A `running` row whose heartbeat is older
 * than 10 minutes is shown as `stale` by `record.lease{op: status}` — evidence, never a lock (the dead session no longer
 * holds it).
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Db, DedicatedClient, Queryable } from "../../../infra/db/client.ts";

export const SWEEP_LEASE_KEY = 35_001;
export const STALE_AFTER_MS = 10 * 60_000;

export interface SweepPass { readonly name: string; readonly duration_ms: number; readonly counts: Record<string, unknown>; }
export interface SweepLease {
  readonly holder: string; readonly runId: string; readonly client: DedicatedClient;
  /** UPDATE sweep_runs SET heartbeat_at, passes — after every pass (on the pool, never on the lease's session). */
  heartbeat(db: Queryable, nowIso: string, passes: readonly SweepPass[]): Promise<void>;
  /** pg_advisory_unlock, then the session ends; idempotent. */
  release(): Promise<void>;
}
export type LeaseResult = { readonly ok: true; readonly lease: SweepLease } | { readonly ok: false; readonly reason: "lease_held" | "lease_unavailable"; readonly runId: string; readonly holder: string; readonly error?: string };

export const defaultHolder = (): string => `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/**
 * Take the lease on a dedicated session: `lease_held` when another execution holds it (the row `skipped` is written by the
 * caller), `lease_unavailable` when the dedicated client cannot connect (edge case: "the run is failed{lease_unavailable}
 * before any pass; exit 1; the next minute tries again").
 */
export async function acquireSweepLease(db: Db, nowIso: string, holder: string = defaultHolder()): Promise<LeaseResult> {
  const runId = randomUUID();
  let client: DedicatedClient;
  try { client = await db.dedicated(); } catch (e) { return { ok: false, reason: "lease_unavailable", runId, holder, error: (e as Error).message }; }
  let got = false;
  try { got = (await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [SWEEP_LEASE_KEY]))[0]?.ok === true; }
  catch (e) { await client.end().catch(() => undefined); return { ok: false, reason: "lease_unavailable", runId, holder, error: (e as Error).message }; }
  if (!got) { await client.end().catch(() => undefined); return { ok: false, reason: "lease_held", runId, holder }; }
  let released = false;
  const lease: SweepLease = {
    holder, runId, client,
    async heartbeat(q, at, passes) { await q.query(`UPDATE sweep_runs SET heartbeat_at = $2, passes = $3::jsonb WHERE id = $1`, [runId, at, JSON.stringify(passes)]); },
    async release() { if (released) return; released = true; try { await client.query("SELECT pg_advisory_unlock($1)", [SWEEP_LEASE_KEY]); } catch { /* the session's end releases it */ } finally { await client.end().catch(() => undefined); } },
  };
  void nowIso;
  return { ok: true, lease };
}

export interface LeaseStatus {
  readonly as_of: string;
  readonly current: { run_id: string; holder: string; started_at: string; heartbeat_at: string; stale: boolean; passes: unknown } | null;
  readonly last_completed: { run_id: string; holder: string; started_at: string; finished_at: string | null; as_of_date: string; passes: unknown; outbox: unknown } | null;
  readonly last_skipped: { run_id: string; holder: string; started_at: string; skipped_reason: string | null } | null;
}

/** `record.lease{op: status}`: the current holder (a `running` row; `stale` when its heartbeat is older than 10 minutes), the last completed run, the last skip. */
export async function leaseStatus(q: Queryable, nowIso: string): Promise<LeaseStatus> {
  type R = { id: string; holder: string; started_at: string; heartbeat_at: string; finished_at: string | null; as_of_date: string; skipped_reason: string | null; passes: unknown; outbox: unknown };
  const [running] = await q.query<R>(`SELECT id, holder, started_at::text AS started_at, heartbeat_at::text AS heartbeat_at, finished_at::text AS finished_at, as_of_date::text AS as_of_date, skipped_reason, passes, outbox FROM sweep_runs WHERE outcome = 'running' ORDER BY started_at DESC LIMIT 1`);
  const [completed] = await q.query<R>(`SELECT id, holder, started_at::text AS started_at, heartbeat_at::text AS heartbeat_at, finished_at::text AS finished_at, as_of_date::text AS as_of_date, skipped_reason, passes, outbox FROM sweep_runs WHERE outcome = 'completed' ORDER BY finished_at DESC LIMIT 1`);
  const [skipped] = await q.query<R>(`SELECT id, holder, started_at::text AS started_at, heartbeat_at::text AS heartbeat_at, finished_at::text AS finished_at, as_of_date::text AS as_of_date, skipped_reason, passes, outbox FROM sweep_runs WHERE outcome = 'skipped' ORDER BY started_at DESC LIMIT 1`);
  return { as_of: nowIso,
    current: running ? { run_id: running.id, holder: running.holder, started_at: running.started_at, heartbeat_at: running.heartbeat_at, stale: Date.parse(nowIso) - Date.parse(running.heartbeat_at) > STALE_AFTER_MS, passes: running.passes } : null,
    last_completed: completed ? { run_id: completed.id, holder: completed.holder, started_at: completed.started_at, finished_at: completed.finished_at, as_of_date: completed.as_of_date, passes: completed.passes, outbox: completed.outbox } : null,
    last_skipped: skipped ? { run_id: skipped.id, holder: skipped.holder, started_at: skipped.started_at, skipped_reason: skipped.skipped_reason } : null };
}

/** `record.lease{op: list}`: the latest runs, newest first. */
export async function leaseList(q: Queryable, limit = 50): Promise<Record<string, unknown>[]> {
  return q.query(`SELECT id AS run_id, holder, lease_key, started_at::text AS started_at, heartbeat_at::text AS heartbeat_at, finished_at::text AS finished_at, as_of_date::text AS as_of_date, outcome, skipped_reason, passes, outbox FROM sweep_runs ORDER BY started_at DESC LIMIT $1`, [Math.max(1, Math.min(500, limit))]);
}
