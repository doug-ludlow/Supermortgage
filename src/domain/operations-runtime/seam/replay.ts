/**
 * §35.1 — `record.replay{kind, scope_key?, dry_run}` and `record.project{kind, entity_id?}` (edge case 1: "a projector is
 * authored for a kind with existing JSONB history → record.replay{kind} walks every scope's versions oldest first, mints
 * keys once, inserts append-only targets once per version and upserts mutable ones to the latest; a second replay writes
 * zero rows and zero events" — REPLAY_IS_IDEMPOTENT), and `record.gaps{as_of_date}` (the same report as the verify run
 * without the verify: kinds by gap reason with counts). HOLD_BLOCKS_REPLAY: a scope under an open `legal_holds` row is
 * skipped as `key_conflict{hold: true}`; never a write under hold.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { decodeEntityData } from "../../../infra/db/entities.ts";
import type { EntityRecord } from "../../../app/tools.ts";
import { projectorFor } from "../projectors/index.ts";
import { classifyVersion, projectVersions, type GapReason, type ProjectionGap, type ProjectionOutcome } from "./project.ts";

type Row = { kind: string; id: string; version: number; scope_key: string; loan_id: string | null; application_id: string | null; data: unknown; updated_at: Date | string; updated_by: string };
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const toRecord = (r: Row): EntityRecord => ({ kind: r.kind, id: r.id, version: r.version, data: decodeEntityData(r.data), updatedAt: iso(r.updated_at), updatedBy: r.updated_by });

/** The versions of a kind with no entity_projections row, oldest first (every scope, or one), with their scope keys. */
export async function unprojectedVersions(q: Queryable, kind: string, o: { scopeKey?: string | null; entityId?: string | null; limit?: number } = {}): Promise<{ record: EntityRecord; scope_key: string; loan_id: string | null; application_id: string | null }[]> {
  const params: unknown[] = [kind]; const where: string[] = ["r.kind = $1"];
  if (o.scopeKey !== undefined && o.scopeKey !== null) { params.push(o.scopeKey); where.push(`r.scope_key = $${params.length}`); }
  if (o.entityId) { params.push(o.entityId); where.push(`r.id = $${params.length}`); }
  params.push(o.limit ?? 10_000);
  const rows = await q.query<Row>(`SELECT r.kind, r.id, r.version, r.scope_key, r.loan_id, r.application_id, r.data, r.updated_at, r.updated_by FROM entity_records r
    WHERE ${where.join(" AND ")} AND NOT EXISTS (SELECT 1 FROM entity_projections p WHERE p.kind = r.kind AND p.entity_id = r.id AND p.scope_key = r.scope_key AND p.version = r.version)
    ORDER BY r.scope_key, r.id, r.version LIMIT $${params.length}`, params);
  return rows.map((r) => ({ record: toRecord(r), scope_key: r.scope_key, loan_id: r.loan_id, application_id: r.application_id }));
}

/** Scopes (loan ids and application ids) under an open legal hold — HOLD_BLOCKS_REPLAY. */
export async function heldScopes(q: Queryable): Promise<Set<string>> {
  const rows = await q.query<{ scope: string; scope_ref: string | null; application_ids: string[] | null }>(`SELECT scope, scope_ref, application_ids FROM legal_holds WHERE released_at IS NULL`).catch(() => []);
  const out = new Set<string>();
  for (const r of rows) { if (r.scope_ref) out.add(r.scope_ref); for (const a of r.application_ids ?? []) out.add(a); }
  return out;
}

export interface ReplayResult { readonly kind: string; readonly scope_key: string | null; readonly dry_run: boolean; readonly run_id: string; readonly versions: number; readonly rows_written: number; readonly gaps: ProjectionGap[]; readonly reason?: "no_projector"; readonly outcome?: ProjectionOutcome; }

/**
 * Replay one kind's un-projected versions into its typed table inside the caller's transaction (the command's); idempotent —
 * a second run finds nothing un-projected and writes nothing. `dry_run` counts and classifies without writing.
 */
export async function replayKind(q: Queryable, i: { kind: string; scope_key?: string | null; entity_id?: string | null; dry_run?: boolean; now: string; run_id?: string }): Promise<ReplayResult> {
  const runId = i.run_id ?? randomUUID();
  const map = projectorFor(i.kind);
  const base = { kind: i.kind, scope_key: i.scope_key ?? null, dry_run: i.dry_run === true, run_id: runId };
  if (!map) return { ...base, versions: 0, rows_written: 0, gaps: [], reason: "no_projector" };
  const pending = await unprojectedVersions(q, i.kind, { scopeKey: i.scope_key ?? null, entityId: i.entity_id ?? null });
  const holds = await heldScopes(q);
  if (i.dry_run) {
    const gaps: ProjectionGap[] = [];
    for (const p of pending) {
      if (holds.has(p.loan_id ?? "") || holds.has(p.application_id ?? "")) { gaps.push({ kind: p.record.kind, entity_id: p.record.id, scope_key: p.scope_key, version: p.record.version, reason: "key_conflict", detail: { hold: true } }); continue; }
      const c = classifyVersion(p.record); if (c) gaps.push({ kind: p.record.kind, entity_id: p.record.id, scope_key: p.scope_key, version: p.record.version, reason: c.reason, detail: c.detail });
    }
    return { ...base, versions: pending.length, rows_written: 0, gaps };
  }
  // each version is projected under its own stored scope (the row's loan / application), oldest first
  const projected: ProjectionOutcome["projected"] = []; const gaps: ProjectionGap[] = []; let skipped = 0;
  for (const p of pending) {
    const out = await projectVersions(q, { phase: "replay", versions: [p.record], scope: { ...(p.loan_id ? { loanId: p.loan_id } : {}), ...(p.application_id ? { applicationId: p.application_id } : {}) }, now: i.now, runId, commandEventId: null, onError: "gap", holds });
    projected.push(...out.projected); gaps.push(...out.gaps); skipped += out.skipped;
  }
  return { ...base, versions: pending.length, rows_written: projected.filter((r) => !r.duplicate).length, gaps, outcome: { projected, gaps, skipped } };
}

export interface GapReportRow { readonly kind: string; readonly reason: GapReason; readonly versions_unprojected: number; readonly scopes: number; readonly detail: Record<string, unknown>; readonly first_seen_at: string | null; }
export interface GapReport { readonly as_of_date: string; readonly kinds: GapReportRow[]; readonly total_versions_unprojected: number; }

/** The gap report: every kind with un-projected versions, by reason (no_projector when no map; else the schema check's verdict per version). Reads only. */
export async function gapsReport(q: Queryable, asOfDate: string): Promise<GapReport> {
  const rows = await q.query<Row & { first_seen_at: string }>(`SELECT r.kind, r.id, r.version, r.scope_key, r.loan_id, r.application_id, r.data, r.updated_at, r.updated_by, min(r.updated_at) OVER (PARTITION BY r.kind) AS first_seen_at FROM entity_records r
    WHERE r.updated_at < ($1::date + interval '1 day') AND NOT EXISTS (SELECT 1 FROM entity_projections p WHERE p.kind = r.kind AND p.entity_id = r.id AND p.scope_key = r.scope_key AND p.version = r.version) ORDER BY r.kind, r.scope_key, r.id, r.version`, [asOfDate]);
  const holds = await heldScopes(q);
  const by = new Map<string, { reason: GapReason; n: number; scopes: Set<string>; detail: Record<string, unknown>; first: string | null }>();
  for (const r of rows) {
    const rec = toRecord(r);
    const held = holds.has(r.loan_id ?? "") || holds.has(r.application_id ?? "");
    const c = held ? { reason: "key_conflict" as GapReason, detail: { hold: true } } : (classifyVersion(rec) ?? { reason: "projector_error" as GapReason, detail: { problem: "a typed kind's version has no projection (written before its map was authored, or its projector was skipped): record.replay projects it" } });
    const key = `${r.kind}|${c.reason}`;
    const cur = by.get(key) ?? { reason: c.reason, n: 0, scopes: new Set<string>(), detail: c.detail, first: iso(r.first_seen_at) };
    cur.n += 1; cur.scopes.add(r.scope_key); by.set(key, cur);
  }
  const kinds = [...by.entries()].map(([key, v]) => ({ kind: key.split("|")[0]!, reason: v.reason, versions_unprojected: v.n, scopes: v.scopes.size, detail: v.detail, first_seen_at: v.first })).sort((a, b) => a.kind.localeCompare(b.kind) || a.reason.localeCompare(b.reason));
  return { as_of_date: asOfDate, kinds, total_versions_unprojected: kinds.reduce((a, k) => a + k.versions_unprojected, 0) };
}
