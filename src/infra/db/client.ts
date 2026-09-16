/**
 * Thin Postgres client. bigint columns come back as `bigint` (never Number —
 * cents are bigint everywhere), timestamps as ISO strings, dates as
 * `YYYY-MM-DD`. Everything the repositories do runs through `Queryable` so a
 * unit of work can hand them a transaction.
 */
import pg from "pg";

// int8 → bigint; date/timestamptz → strings (we never want JS Date objects leaking into domain code).
pg.types.setTypeParser(20, (v: string) => BigInt(v));
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
pg.types.setTypeParser(1114, (v: string) => new Date(v + "Z").toISOString());

export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]>;
}

/** A connection of its own, outside the pool — the sweep's session-level lease (35.1 rule 12: LEASE_DIES_WITH_SESSION). */
export interface DedicatedClient extends Queryable { end(): Promise<void>; }

export interface Db extends Queryable {
  /** Run `fn` in a transaction; commit on return, roll back on throw. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** A dedicated session (a new client, not a pool member): the caller ends it. */
  dedicated(): Promise<DedicatedClient>;
  end(): Promise<void>;
}

/**
 * The command's own connection as a `Db` (35.1 rule 7: everything a command reads or writes is inside its transaction, on
 * the connection that holds its lock): `query` runs on the transaction; `tx` is a savepoint inside it (released on return,
 * rolled back to on throw), so a unit of work a tool runs from within a command commits with the command or not at all and
 * never waits on a second pool connection; `dedicated` is the pool's (a session of its own).
 */
export function transactionDb(q: Queryable, outer: Db): Db {
  let depth = 0;
  return {
    query: (sql, params) => q.query(sql, params),
    async tx<T>(fn: (inner: Queryable) => Promise<T>): Promise<T> {
      const sp = `cmd_sp_${++depth}`;
      await q.query(`SAVEPOINT ${sp}`);
      try { const out = await fn(q); await q.query(`RELEASE SAVEPOINT ${sp}`); return out; }
      catch (e) { await q.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => undefined); throw e; }
    },
    dedicated: () => outer.dedicated(),
    end: async () => undefined,
  };
}

/** JSON with bigint → string, so event payloads and decision evidence can carry cents. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

class PoolDb implements Db {
  private readonly pool: pg.Pool;
  private readonly connectionString: string;
  constructor(connectionString: string) { this.connectionString = connectionString; this.pool = new pg.Pool({ connectionString, max: 4 }); }
  async dedicated(): Promise<DedicatedClient> {
    const client = new pg.Client({ connectionString: this.connectionString });
    await client.connect();
    return { query: async (sql, params = []) => (await client.query(sql, [...params])).rows, end: () => client.end() };
  }
  async query<R extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    const res = await this.pool.query(sql, [...params]);
    return res.rows as R[];
  }
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const q: Queryable = { query: async (sql, params = []) => (await client.query(sql, [...params])).rows };
      const out = await fn(q);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  async end(): Promise<void> { await this.pool.end(); }
}

export function connect(connectionString: string | undefined = process.env["DATABASE_URL"]): Db {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PoolDb(connectionString);
}

/** True when a database answers `SELECT 1` within `timeoutMs`; used by tests to skip cleanly without Postgres. */
export async function reachable(connectionString: string, timeoutMs = 1500): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: timeoutMs });
  try { await client.connect(); await client.query("SELECT 1"); return true; }
  catch { return false; }
  finally { await client.end().catch(() => undefined); }
}
