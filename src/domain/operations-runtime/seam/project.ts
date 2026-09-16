/**
 * §35.1 — the projection runner: copies entity versions onto the typed rows their authored maps name (rules 1–5).
 *
 *   projectVersions(q, { phase, versions, scope, ... })
 *     for each version whose kind has a map: skip when its entity_projections row exists (rule 4: a re-projection is a
 *     no-op by the unique key, not a duplicate-key error); mint the row's uuid once per (kind, legacy_ref, scope_key) in
 *     entity_keys (rule 5); validate every column against the map — a required field missing, a `number` in a money column,
 *     a value outside an enum, a malformed uuid / date → `schema_mismatch` (the version stands in JSONB, the daily run lists
 *     it; nothing is cast or guessed); INSERT or UPSERT the row, the child rows, then one entity_projections row.
 *
 *   A projector that throws (a database error the map did not foresee) rolls the command back whole in the `before` and
 *   `commit` phases (rule 2, T4); a replay records it as a `projector_error` gap and continues (`onError: "gap"`).
 *   Rule 3 (PROJECTOR_NEVER_COMPUTES): nothing here holds arithmetic; every figure is the owning section's, copied.
 *   Rule 14 (NO_MONEY_FIELD_CHANGE): the runner has no override path; a money column only ever takes the version's field.
 */
import { randomUUID } from "node:crypto";
import { isUuid, toJson, type Queryable } from "../../../infra/db/client.ts";
import type { EntityScope } from "../../../infra/db/entities.ts";
import type { EntityRecord } from "../../../app/tools.ts";
import { PgOutbox } from "../../../infra/integrations/pg-outbox.ts";
import { projectorFor } from "../projectors/index.ts";
import type { ColumnSpec, ProjectorMap } from "../projectors/types.ts";

export type Phase = "before" | "commit" | "replay";
export type GapReason = "no_projector" | "projector_error" | "schema_mismatch" | "key_conflict";

export interface ProjectionGap { readonly kind: string; readonly entity_id: string; readonly scope_key: string; readonly version: number; readonly reason: GapReason; readonly detail: Record<string, unknown>; }
export interface ProjectedRow { readonly kind: string; readonly entity_id: string; readonly scope_key: string; readonly version: number; readonly target_table: string; readonly target_id: string | null; readonly projection_id: string; readonly duplicate: boolean; }
export interface ProjectionOutcome { readonly projected: ProjectedRow[]; readonly gaps: ProjectionGap[]; readonly skipped: number; }

export interface ProjectOptions {
  readonly phase: Phase;
  readonly versions: readonly EntityRecord[];
  readonly scope: EntityScope;
  readonly now: string;
  /** The first event of the command (null on replay). */
  readonly commandEventId?: string | null;
  readonly runId?: string | null;
  /** `throw` (a command: rule 2) or `gap` (a replay: `projector_error`). */
  readonly onError?: "throw" | "gap";
  /** Replay only: skip a scope under a legal hold (HOLD_BLOCKS_REPLAY) — `key_conflict{hold: true}`. */
  readonly holds?: ReadonlySet<string>;
}

/** The scope key a version is stored under (entities.ts save / 0115): its own application or loan id, else the command's, else '' (global). */
export function scopeOf(r: EntityRecord, scope: EntityScope): { loanId: string | null; applicationId: string | null; scopeKey: string } {
  const loanId = typeof r.data["loan_id"] === "string" && r.data["loan_id"] ? (r.data["loan_id"] as string) : scope.loanId || null;
  const applicationId = typeof r.data["application_id"] === "string" && r.data["application_id"] ? (r.data["application_id"] as string) : scope.applicationId || null;
  return { loanId, applicationId, scopeKey: applicationId ?? loanId ?? "" };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS_RE = /^-?\d+$/;
export const isMoneyColumn = (column: string): boolean => column.endsWith("_cents");

class SchemaMismatch extends Error { readonly column: string; readonly problem: string; constructor(column: string, problem: string) { super(`${column}: ${problem}`); this.name = "SchemaMismatch"; this.column = column; this.problem = problem; } }

/** The SQL parameter a JSON value becomes for a column of the spec's type — validated, never computed or cast across kinds (rule 3). */
export function columnValue(spec: ColumnSpec, v: unknown): unknown {
  if (v === undefined || v === null) { if (spec.required) throw new SchemaMismatch(spec.column, "required field missing"); return undefined; }
  switch (spec.type) {
    case "money":
      if (typeof v === "bigint") return v;
      if (typeof v === "string" && DIGITS_RE.test(v)) return BigInt(v);   // the wire form of a bigint (a decimal string of cents) — the same value, not a cast
      throw new SchemaMismatch(spec.column, typeof v === "number" ? "a number in a money column (bigint cents required; never cast)" : `not bigint cents (${typeof v})`);
    case "uuid": if (isUuid(v)) return v; throw new SchemaMismatch(spec.column, "not a uuid");
    case "date": if (typeof v === "string" && DATE_RE.test(v)) return v; throw new SchemaMismatch(spec.column, "not a civil date");
    case "timestamp": if (typeof v === "string" && Number.isFinite(Date.parse(v))) return new Date(v).toISOString(); throw new SchemaMismatch(spec.column, "not an instant");
    case "int": if (typeof v === "number" && Number.isInteger(v)) return v; if (typeof v === "string" && DIGITS_RE.test(v)) return Number(v); if (typeof v === "bigint") return Number(v); throw new SchemaMismatch(spec.column, "not an integer");
    case "bool": if (typeof v === "boolean") return v; throw new SchemaMismatch(spec.column, "not a boolean");
    case "numeric": if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return v; if (typeof v === "number" && Number.isFinite(v)) return String(v); throw new SchemaMismatch(spec.column, "not a decimal");
    case "json": return toJson(v);
    case "text": {
      if (typeof v !== "string") throw new SchemaMismatch(spec.column, "not text");
      if (spec.values && !spec.values.includes(v)) throw new SchemaMismatch(spec.column, `value outside the column's set`);
      return v;
    }
  }
}

const fieldOf = (data: Record<string, unknown>, field: string, spec: ColumnSpec): unknown => {
  if (!spec.path) return data[field];
  let cur: unknown = data; for (const p of spec.path) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined; return cur;
};

/** The row's columns from the version: `{ column → value }` (undefined = leave the column to its default / untouched). Throws SchemaMismatch. */
export function rowOf(map: { columns: Readonly<Record<string, ColumnSpec>> }, data: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [field, spec] of Object.entries(map.columns)) {
    const v = columnValue(spec, fieldOf(data, field, spec));
    if (v !== undefined) out.set(spec.column, v);
    else if (spec.required) throw new SchemaMismatch(spec.column, "required field missing");
  }
  return out;
}

/** Pure schema check for the gap report: the reason a version would not project, or null when it would. */
export function classifyVersion(r: EntityRecord): { reason: GapReason; detail: Record<string, unknown> } | null {
  const map = projectorFor(r.kind);
  if (!map) return { reason: "no_projector", detail: {} };
  if ((map as { outbox?: boolean }).outbox) return null;
  try { rowOf(map, r.data); for (const c of map.children ?? []) for (const child of childRows(r.data, c.field)) rowOf(c, child); return null; }
  catch (e) { if (e instanceof SchemaMismatch) return { reason: "schema_mismatch", detail: { column: e.column, problem: e.problem } }; throw e; }
}

/** The child rows of a version: every object of an array field (2.1's `allocations[]`), or the one object of an object field (2.3's `reversal`). */
const childRows = (data: Record<string, unknown>, field: string): Record<string, unknown>[] => { const v = data[field]; if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object"); return v && typeof v === "object" ? [v as Record<string, unknown>] : []; };

/** Rule 5: one uuid per (kind, legacy_ref, scope_key), minted once, reused by every later version and by replay. A legacy ref that is already a uuid is its own. */
export async function mintKey(q: Queryable, kind: string, legacyRef: string, scopeKey: string): Promise<string> {
  const candidate = isUuid(legacyRef) ? legacyRef : randomUUID();
  await q.query(`INSERT INTO entity_keys (kind, legacy_ref, scope_key, target_uuid) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, legacy_ref, scope_key) DO NOTHING`, [kind, legacyRef, scopeKey, candidate]);
  const rows = await q.query<{ target_uuid: string }>(`SELECT target_uuid FROM entity_keys WHERE kind = $1 AND legacy_ref = $2 AND scope_key = $3`, [kind, legacyRef, scopeKey]);
  return rows[0]!.target_uuid;
}

async function alreadyProjected(q: Queryable, r: EntityRecord, scopeKey: string): Promise<boolean> {
  const rows = await q.query(`SELECT 1 FROM entity_projections WHERE kind = $1 AND entity_id = $2 AND scope_key = $3 AND version = $4`, [r.kind, r.id, scopeKey, r.version]);
  return rows.length > 0;
}

async function writeRow(q: Queryable, map: ProjectorMap, id: string, row: Map<string, unknown>): Promise<void> {
  const cols = [map.idColumn, ...row.keys()]; const vals = [id, ...row.values()];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  if (map.mode === "insert") { await q.query(`INSERT INTO ${map.table} (${cols.join(", ")}) VALUES (${placeholders})`, vals); return; }
  const updates = [...row.keys()].map((c) => `${c} = EXCLUDED.${c}`);
  await q.query(`INSERT INTO ${map.table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${map.idColumn}) DO ${updates.length ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"}`, vals);
}

/** Writes every child row of the version; answers the child tables that took a new row (a re-projection's `DO NOTHING` writes none). */
async function writeChildren(q: Queryable, map: ProjectorMap, parentId: string, data: Record<string, unknown>): Promise<string[]> {
  const written: string[] = [];
  for (const c of map.children ?? []) for (const child of childRows(data, c.field)) {
    const row = rowOf(c, child);
    const cols = [c.parentColumn, ...row.keys()]; const vals = [parentId, ...row.values()];
    const r = await q.query(`INSERT INTO ${c.table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT (${c.conflictColumns.join(", ")}) DO NOTHING RETURNING 1`, vals);
    if (r.length && !written.includes(c.table)) written.push(c.table);
  }
  return written;
}

export async function projectVersions(q: Queryable, o: ProjectOptions): Promise<ProjectionOutcome> {
  const projected: ProjectedRow[] = []; const gaps: ProjectionGap[] = []; let skipped = 0;
  const onError = o.onError ?? "throw";
  for (const r of o.versions) {
    const map = projectorFor(r.kind);
    if (!map || (o.phase !== "replay" && map.phase !== o.phase)) continue;
    const { loanId, applicationId, scopeKey } = scopeOf(r, o.scope);
    if (await alreadyProjected(q, r, scopeKey)) { skipped++; continue; }
    if (o.holds && (o.holds.has(loanId ?? "") || o.holds.has(applicationId ?? ""))) { gaps.push({ kind: r.kind, entity_id: r.id, scope_key: scopeKey, version: r.version, reason: "key_conflict", detail: { hold: true } }); continue; }
    if (onError === "gap") await q.query("SAVEPOINT seam_version");
    try {
      let targetId: string | null = null; let targetTable = map.table; let duplicate = false;
      if ((map as { outbox?: boolean }).outbox) {
        // rule 11: the kind `integration_messages` is a row projector into the real outbox (idempotency key = the store id)
        const adapter = typeof r.data["adapter"] === "string" ? (r.data["adapter"] as string) : typeof r.data["channel"] === "string" ? (r.data["channel"] as string) : "";
        if (!adapter) throw new SchemaMismatch("adapter", "required field missing");
        const res = await new PgOutbox(q).enqueue({ adapter, idempotencyKey: r.id, payload: r.data["package"] ?? r.data, payloadSummary: { kind: r.kind, entity_id: r.id, version: r.version, projector: map.version }, ...(loanId && isUuid(loanId) ? { loanId } : {}), ...(o.commandEventId ? { sourceEventId: o.commandEventId } : {}) }, o.now);
        targetId = res.message.id; duplicate = res.duplicate;
      } else {
        const data: Record<string, unknown> = { ...r.data };
        if (map.scopeColumn?.loan && data[map.scopeColumn.loan] === undefined && loanId) data[map.scopeColumn.loan] = loanId;
        if (map.scopeColumn?.application && data[map.scopeColumn.application] === undefined && applicationId) data[map.scopeColumn.application] = applicationId;
        const row = rowOf(map, data);
        for (const c of map.children ?? []) for (const child of childRows(data, c.field)) rowOf(c, child);   // validate every child before any write
        targetId = await mintKey(q, r.kind, r.id, scopeKey);
        await writeRow(q, map, targetId, row);
        const children = await writeChildren(q, map, targetId, data);
        if (children.length) targetTable = `${map.table}/${children.join("/")}`;
      }
      const projectionId = randomUUID();
      await q.query(`INSERT INTO entity_projections (id, kind, entity_id, scope_key, version, target_table, target_id, mode, phase, projector_version, command_event_id, run_id, projected_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [projectionId, r.kind, r.id, scopeKey, r.version, targetTable, targetId, map.mode, o.phase, map.version, o.commandEventId ?? null, o.runId ?? null, o.now]);
      projected.push({ kind: r.kind, entity_id: r.id, scope_key: scopeKey, version: r.version, target_table: targetTable, target_id: targetId, projection_id: projectionId, duplicate });
      if (onError === "gap") await q.query("RELEASE SAVEPOINT seam_version");
    } catch (e) {
      if (onError === "gap") await q.query("ROLLBACK TO SAVEPOINT seam_version").catch(() => undefined);
      if (e instanceof SchemaMismatch) { gaps.push({ kind: r.kind, entity_id: r.id, scope_key: scopeKey, version: r.version, reason: "schema_mismatch", detail: { column: e.column, problem: e.problem } }); continue; }
      if (onError === "gap") {
        // the failed statement was rolled back to the savepoint: the transaction goes on with the next version
        gaps.push({ kind: r.kind, entity_id: r.id, scope_key: scopeKey, version: r.version, reason: "projector_error", detail: { error: (e as Error).message.slice(0, 500) } }); continue;
      }
      throw e;
    }
  }
  return { projected, gaps, skipped };
}
