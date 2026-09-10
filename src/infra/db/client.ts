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

export interface Db extends Queryable {
  /** Run `fn` in a transaction; commit on return, roll back on throw. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** JSON with bigint → string, so event payloads and decision evidence can carry cents. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

class PoolDb implements Db {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString, max: 4 }); }
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
