/**
 * §35.9 — reading the sections' rows. Sections 11–15 keep their case rows in the entity store (`entity_records`, kind =
 * table name, the `entity_current` view for the latest version); this process reads them through the command's store when
 * inside a command and through SQL on the same transaction otherwise (rule 1: "the owning section's status is read after the
 * event", SECTION_STATUS_READ_ONLY: never written here). Ids the sections mint are text; the engine's own tables key cases by
 * uuid (`case_id uuid → cases`), so a non-uuid section id maps to a stable uuid (`caseUuid`) and the raw id rides in `detail`.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { decodeEntityData } from "../../../infra/db/entities.ts";

export type Row = Record<string, unknown>;
export interface CurrentRow { readonly kind: string; readonly id: string; readonly version: number; readonly loan_id: string | null; readonly data: Row }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);
/** A stable uuid for a section's text id (sha256 folded into the uuid shape, version nibble 5). */
export function caseUuid(id: string): string {
  if (isUuid(id)) return id.toLowerCase();
  const h = createHash("sha256").update(`35.9:case:${id}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const toRow = (r: Row): CurrentRow => ({ kind: String(r["kind"]), id: String(r["id"]), version: Number(r["version"]), loan_id: (r["loan_id"] as string | null) ?? null, data: decodeEntityData(r["data"]) });

export async function currentRow(q: Queryable, kind: string, id: string): Promise<CurrentRow | null> {
  const rows = await q.query<Row>(`SELECT kind, id, version, loan_id, data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]);
  return rows[0] ? toRow(rows[0]) : null;
}
/** The loan's rows of a kind (scoped by `loan_id`, or by the row's own `loan_id` field for a global-keyed kind). */
export async function loanRows(q: Queryable, kind: string, loanId: string): Promise<CurrentRow[]> {
  const rows = await q.query<Row>(`SELECT kind, id, version, loan_id, data FROM entity_current WHERE kind = $1 AND (loan_id = $2 OR data->>'loan_id' = $2) ORDER BY version, id`, [kind, loanId]);
  return rows.map(toRow);
}
export async function globalRows(q: Queryable, kind: string): Promise<CurrentRow[]> {
  const rows = await q.query<Row>(`SELECT kind, id, version, loan_id, data FROM entity_current WHERE kind = $1 ORDER BY id`, [kind]);
  return rows.map(toRow);
}
export const str = (d: Row, k: string): string => (d[k] === undefined || d[k] === null ? "" : String(d[k]));
export const openForeclosure = (rows: readonly CurrentRow[]): CurrentRow | null => rows.find((r) => !/^closed_/.test(str(r.data, "status"))) ?? null;
export const openBankruptcy = (rows: readonly CurrentRow[]): CurrentRow | null => rows.find((r) => !/^(closed|closed_no_case|dismissed|transferred_out|discharged)$/.test(str(r.data, "status"))) ?? null;
export const openLossmit = (rows: readonly CurrentRow[]): CurrentRow | null => rows.find((r) => !/^(withdrawn|denied|closed|completed|cancelled|expired)$/.test(str(r.data, "status"))) ?? null;
