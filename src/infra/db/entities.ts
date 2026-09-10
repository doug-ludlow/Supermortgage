/**
 * Persistence for the agent-tool entity store (src/app/tools.ts `EntityStore`).
 *
 * The tools read and write the store synchronously, so the runtime hydrates it
 * before a command (this loan's rows plus the global rows) and writes every new
 * version back in the command's transaction (PgUnitOfWork `commit` hook). Rows
 * are append-only versions; `entity_current` is the latest of each.
 *
 * Cents travel as bigint inside the store; JSON cannot carry them, so a bigint
 * is stored as `{"$bigint": "<digits>"}` and restored on load — a value that is
 * a bigint before the round trip is a bigint after it.
 */
import type { Queryable } from "./client.ts";
import type { EntityRecord } from "../../app/tools.ts";

type Row = { kind: string; id: string; version: number; loan_id: string | null; data: unknown; updated_at: Date | string; updated_by: string; };

export function encodeEntityData(data: Record<string, unknown>): string {
  return JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
}
export function decodeEntityData(v: unknown): Record<string, unknown> {
  const revive = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(revive);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (typeof o["$bigint"] === "string" && Object.keys(o).length === 1) return BigInt(o["$bigint"]);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) out[k] = revive(val);
      return out;
    }
    return x;
  };
  return revive(typeof v === "string" ? JSON.parse(v) : v) as Record<string, unknown>;
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const toRecord = (r: Row): EntityRecord => ({ kind: r.kind, id: r.id, version: r.version, data: decodeEntityData(r.data), updatedAt: iso(r.updated_at), updatedBy: r.updated_by });

export class PgEntityRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  /** Every version of the loan's rows and of the global rows, oldest first — what `EntityStore.seed` takes. An empty loanId loads only the global rows. */
  async load(loanId: string): Promise<EntityRecord[]> {
    const rows = loanId
      ? await this.db.query<Row>(`SELECT * FROM entity_records WHERE loan_id = $1 OR loan_id IS NULL ORDER BY kind, id, version`, [loanId])
      : await this.db.query<Row>(`SELECT * FROM entity_records WHERE loan_id IS NULL ORDER BY kind, id, version`);
    return rows.map(toRecord);
  }

  /** Current version of one record (any loan). */
  async current(kind: string, id: string): Promise<EntityRecord | undefined> {
    const rows = await this.db.query<Row>(`SELECT * FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  /**
   * Append new versions. A record's loan is `data.loan_id` when the tool wrote one, else the command's
   * loan; a command with no loan (loanId "") writes global rows.
   */
  async save(records: readonly EntityRecord[], commandLoanId: string | null, q: Queryable = this.db): Promise<void> {
    for (const r of records) {
      const loanId = typeof r.data["loan_id"] === "string" && r.data["loan_id"] ? (r.data["loan_id"] as string) : commandLoanId || null;
      await q.query(`INSERT INTO entity_records (kind, id, version, loan_id, data, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [r.kind, r.id, r.version, loanId, encodeEntityData(r.data), r.updatedAt, r.updatedBy]);
    }
  }
}
