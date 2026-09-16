/**
 * §35.3 rule 1 — the planner lock. `cycles.plan` opens a DEDICATED `pg.Client` (the src/infra/db/test-lock.ts:14-20 shape: a
 * session-level advisory lock held on its own connection, outside the pool of four), takes `pg_try_advisory_lock(35_003)` and,
 * if refused, reports the holder so the caller appends `cycles.plan.skipped{holder}` and returns — the sweep's other passes run
 * regardless. The lock is session-level so it dies with the client: a planner killed mid-pass (the job's 300 s timeout) leaves
 * nothing locked (LEASE_DIES_WITH_SESSION — no table row is ever the lock; `cycle_runs` records, it never guards).
 *
 * Unlike test-lock.ts (which deliberately connects to the maintenance database so a lock spans every test clone), this client
 * connects to the APPLICATION database (D12): an advisory lock is per database, T1 reads `pg_locks` on the app database, and two
 * planners on one deployment share one database. The key 35_003 is distinct from 35.1's sweep lease (35_001): the demo advance
 * calls the planner from a `serve` instance that holds no sweep lease (rule 10). `application_name = cycles.plan:<holder>` is
 * what `holderOf` reads back from `pg_locks ⋈ pg_stat_activity` for the skipped pass's `holder`.
 */
import pg from "pg";
import type { Queryable } from "../../infra/db/client.ts";

export const PLANNER_LOCK_KEY = 35_003;
export const PLANNER_APP_NAME_PREFIX = "cycles.plan:";

export interface HeldLock { readonly held: true; readonly holder: string; release(): Promise<void>; }
export interface RefusedLock { readonly held: false; readonly holder: string | null; }
/** The port 35.1's own lease helper may satisfy at merge (§3): acquire once, release = unlock + end the session. */
export interface SessionLock { acquire(key: number, holder: string): Promise<HeldLock | RefusedLock>; }

/** Who holds an advisory lock on `key` in the current database: the session's `application_name` (`cycles.plan:<holder>`), or null when nobody does. */
export async function holderOf(q: Queryable, key: number = PLANNER_LOCK_KEY): Promise<string | null> {
  const rows = await q.query<{ application_name: string | null }>(
    `SELECT a.application_name FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.objid = $1 AND l.classid = 0 AND l.granted AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) LIMIT 1`, [key]);
  return rows[0]?.application_name ?? null;
}

export class PgSessionLock implements SessionLock {
  private readonly connectionString: string;
  constructor(connectionString: string) { this.connectionString = connectionString; }
  async acquire(key: number, holder: string): Promise<HeldLock | RefusedLock> {
    const client = new pg.Client({ connectionString: this.connectionString, application_name: `${PLANNER_APP_NAME_PREFIX}${holder}` });
    await client.connect();
    let held = false;
    try {
      const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [key]);
      held = r.rows[0]?.ok === true;
      if (!held) {
        const other = await holderOf({ query: async (sql, params = []) => (await client.query(sql, [...params])).rows }, key).catch(() => null);
        return { held: false, holder: other };
      }
    } finally { if (!held) await client.end().catch(() => undefined); }
    let released = false;
    return { held: true, holder, async release() { if (released) return; released = true; try { await client.query("SELECT pg_advisory_unlock($1)", [key]); } finally { await client.end().catch(() => undefined); } } };
  }
}
