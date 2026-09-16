/**
 * §35.1 rule 6 — bounded hydration: "The entity load for a command is at most three queries whatever the history: the
 * scope's latest versions from `entity_latest_scoped`, the full history of `HISTORY_KINDS` (`payments`,
 * `counterparty_notifications`, and any kind whose authored map says `history: true`) for the scope, and the latest
 * global rows (`scope_key = ''`)". `payments.history` and 17.3's first-version gate read the history kinds in full; every
 * other kind is one version in the store. Runs on the command's own connection, inside the transaction, after the lock
 * (rule 7).
 */
import type { Queryable } from "../../../infra/db/client.ts";
import { decodeEntityData, type EntityScope } from "../../../infra/db/entities.ts";
import type { EntityRecord } from "../../../app/tools.ts";
import { HISTORY_KINDS } from "../projectors/index.ts";

type Row = { kind: string; id: string; version: number; data: unknown; updated_at: Date | string; updated_by: string };
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const toRecord = (r: Row): EntityRecord => ({ kind: r.kind, id: r.id, version: r.version, data: decodeEntityData(r.data), updatedAt: iso(r.updated_at), updatedBy: r.updated_by });
const COLS = "kind, id, version, data, updated_at, updated_by";

export interface BoundedLoad {
  readonly records: EntityRecord[];
  /** `<kind> <id>` of every row that came from the global query: a version a command writes over one of these stays global (rule 8: "global rows … that many loans read-then-bump" keep one scope, so the guard can see them). */
  readonly globalKeys: ReadonlySet<string>;
}
export const entityKey = (kind: string, id: string): string => `${kind} ${id}`;

/** The scope's latest non-history rows, its history kinds in full, then the global latest — oldest first within each, what `EntityStore.seed` takes. */
export async function loadBounded(q: Queryable, scope: EntityScope, historyKinds: ReadonlySet<string> = HISTORY_KINDS): Promise<EntityRecord[]> { return (await loadBoundedScoped(q, scope, historyKinds)).records; }

/** Rule 8 / rule 6: a command's new versions split by where they live — a bump of a row that was hydrated as global (and names no loan or application of its own) is saved global; everything else under the command's scope. */
export function splitByScope(versions: readonly EntityRecord[], globalKeys: ReadonlySet<string>): { global: EntityRecord[]; scoped: EntityRecord[] } {
  const global: EntityRecord[] = []; const scoped: EntityRecord[] = [];
  for (const r of versions) (globalKeys.has(entityKey(r.kind, r.id)) && !r.data["loan_id"] && !r.data["application_id"] ? global : scoped).push(r);
  return { global, scoped };
}

export async function loadBoundedScoped(q: Queryable, scope: EntityScope, historyKinds: ReadonlySet<string> = HISTORY_KINDS): Promise<BoundedLoad> {
  const out: Row[] = [];
  const kinds = [...historyKinds];
  if (scope.loanId || scope.applicationId) {
    const params = [scope.loanId ?? null, scope.applicationId ?? null, kinds];
    // 1. the scope's latest versions (every kind not in HISTORY_KINDS)
    out.push(...await q.query<Row>(`SELECT ${COLS} FROM entity_latest_scoped WHERE (($1::text IS NOT NULL AND loan_id = $1) OR ($2::text IS NOT NULL AND application_id = $2)) AND NOT (kind = ANY($3::text[])) ORDER BY kind, id, version`, params));
    // 2. HISTORY_KINDS in full for the scope
    out.push(...await q.query<Row>(`SELECT ${COLS} FROM entity_records WHERE (($1::text IS NOT NULL AND loan_id = $1) OR ($2::text IS NOT NULL AND application_id = $2)) AND kind = ANY($3::text[]) ORDER BY kind, id, version`, params));
  }
  // 3. the latest global rows (scope_key = '')
  const globals = await q.query<Row>(`SELECT ${COLS} FROM entity_latest_scoped WHERE scope_key = '' ORDER BY kind, id, version`);
  out.push(...globals);
  return { records: out.map(toRecord), globalKeys: new Set(globals.map((g) => entityKey(g.kind, g.id))) };
}
