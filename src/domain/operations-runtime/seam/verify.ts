/**
 * §35.1 rule 13 — the daily verify run: "At 06:00 ET the sweep runs `record.verify{as_of_date}`: for every typed kind, every
 * version since the last run has an `entity_projections` row (else a `projection_gaps` row), and for a sample of 100 rows per
 * kind plus every money-bearing row written that day the typed columns equal the JSON version's fields and, where a ledger
 * set exists, the typed sum equals the set's lines by `rule_ref`; one `projection_runs` row and `projection.run_completed`.
 * A mismatch on a money column is `projection.mismatch_found` with a sev 1 `ciso` escalation and no correction by the run
 * (T13); a mismatch on a non-money column is sev 3 `qc_officer`." Rule 14: the run writes no money column, ever.
 *
 * The run's writes ride on the caller's unit of work (`record.verify` on the bus, or the sweep's global unit of work): the
 * gap and mismatch rows go on the transaction, the events and escalations on the context, and the projection_runs row is
 * inserted finished in the same final transaction as `projection.run_completed`.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { decodeEntityData } from "../../../infra/db/entities.ts";
import type { EntityRecord } from "../../../app/tools.ts";
import type { EscalationService } from "../../../app/escalations.ts";
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { PROJECTORS, projectorFor } from "../projectors/index.ts";
import type { ColumnSpec, ProjectorMap } from "../projectors/types.ts";
import { columnValue, isMoneyColumn } from "./project.ts";
import { gapsReport } from "./replay.ts";

export interface VerifyContext {
  readonly q: Queryable;
  readonly events: { append(e: { type: string; aggregate?: { kind: string; id: string }; actor: Actor; payload: Record<string, unknown> }): DomainEvent };
  readonly escalations: EscalationService;
  readonly actor: Actor;
  readonly now: string;
}
export interface VerifyInput { readonly as_of_date: string; readonly kinds?: readonly string[] | null; readonly sample?: number; }
export interface MismatchRow { readonly id: string; readonly kind: string; readonly entity_id: string; readonly scope_key: string; readonly version: number; readonly target_table: string; readonly target_id: string | null; readonly column_name: string; readonly is_money: boolean; readonly json_value: string | null; readonly row_value: string | null; readonly escalation_id: string; readonly owner: string; }
export interface VerifyReport { readonly run_id: string; readonly as_of_date: string; readonly outcome: "completed"; readonly kinds_checked: number; readonly rows_verified: number; readonly mismatches: number; readonly gaps: number; readonly gap_rows: { kind: string; reason: string; versions_unprojected: number }[]; readonly mismatch_rows: MismatchRow[]; readonly event: DomainEvent; }

type ProjRow = { projection_id: string; kind: string; entity_id: string; scope_key: string; version: number; target_table: string; target_id: string | null; data: unknown };

/** A column's comparable text: money as cents strings, dates as civil dates, instants as ISO, booleans and numbers as their text — never a name or account beyond what the column already holds. */
function asText(spec: ColumnSpec, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (spec.type === "timestamp") { const t = Date.parse(String(v)); return Number.isFinite(t) ? new Date(t).toISOString() : String(v); }
  if (spec.type === "date") return String(v).slice(0, 10);
  if (spec.type === "json") return JSON.stringify(v);
  if (spec.type === "numeric") return String(Number(v));
  return String(v);
}

const moneyBearing = (m: ProjectorMap): boolean => Object.values(m.columns).some((c) => c.type === "money") || (m.children ?? []).some((c) => Object.values(c.columns).some((x) => x.type === "money"));

/** The projected rows to verify for a kind — one per entity, its latest projected version (an upserted row holds the latest version's fields): a sample of `sample` entities plus every entity with a money-bearing row written that day. */
async function sampleOf(q: Queryable, m: ProjectorMap, asOf: string, sample: number): Promise<ProjRow[]> {
  const latestPer = `SELECT DISTINCT ON (p.kind, p.entity_id, p.scope_key) p.id AS projection_id, p.kind, p.entity_id, p.scope_key, p.version, p.target_table, p.target_id, p.projected_at, r.data FROM entity_projections p JOIN entity_records r ON r.kind = p.kind AND r.id = p.entity_id AND r.scope_key = p.scope_key AND r.version = p.version WHERE p.kind = $1 ORDER BY p.kind, p.entity_id, p.scope_key, p.version DESC`;
  const latest = await q.query<ProjRow>(`SELECT * FROM (${latestPer}) x ORDER BY x.projected_at DESC, x.version DESC LIMIT $2`, [m.kind, sample]);
  const seen = new Set(latest.map((r) => r.projection_id));
  const out = [...latest];
  if (moneyBearing(m)) for (const r of await q.query<ProjRow>(`SELECT * FROM (${latestPer}) x WHERE x.projected_at >= $2::date AND x.projected_at < ($2::date + interval '1 day') ORDER BY x.projected_at`, [m.kind, asOf])) if (!seen.has(r.projection_id)) { seen.add(r.projection_id); out.push(r); }
  return out;
}

/** The typed columns of one projected version against the JSON version's fields, plus the ledger check for 2.1's allocations (the typed sum against the set's lines by rule_ref). */
async function compareRow(q: Queryable, m: ProjectorMap, p: ProjRow): Promise<{ column: string; is_money: boolean; json: string | null; row: string | null }[]> {
  if ((m as { outbox?: boolean }).outbox || !p.target_id) return [];
  const data = decodeEntityData(p.data);
  const [row] = await q.query<Record<string, unknown>>(`SELECT * FROM ${m.table} WHERE ${m.idColumn} = $1`, [p.target_id]);
  if (!row) return [{ column: m.idColumn, is_money: false, json: p.target_id, row: null }];
  const out: { column: string; is_money: boolean; json: string | null; row: string | null }[] = [];
  for (const [field, spec] of Object.entries(m.columns)) {
    const raw = spec.path ? spec.path.reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), data) : data[field];
    if (raw === undefined || raw === null) continue;
    let json: string | null; try { json = asText(spec, columnValue(spec, raw)); } catch { continue; }   // a schema mismatch is a gap, not a mismatch
    const rv = asText(spec, row[spec.column]);
    if (json !== rv) out.push({ column: spec.column, is_money: spec.type === "money" || isMoneyColumn(spec.column), json, row: rv });
  }
  for (const c of m.children ?? []) {
    const children = Array.isArray(data[c.field]) ? (data[c.field] as Record<string, unknown>[]) : [];
    if (!children.length) continue;
    const rows = await q.query<Record<string, unknown>>(`SELECT * FROM ${c.table} WHERE ${c.parentColumn} = $1 ORDER BY 1`, [p.target_id]);
    const moneyCols = Object.entries(c.columns).filter(([, s]) => s.type === "money");
    for (const [field, spec] of moneyCols) {
      const jsonSum = children.reduce((a, ch) => { try { return a + (columnValue(spec, ch[field]) as bigint); } catch { return a; } }, 0n);
      const rowSum = rows.reduce((a, r) => a + (typeof r[spec.column] === "bigint" ? (r[spec.column] as bigint) : BigInt(String(r[spec.column] ?? 0))), 0n);
      if (jsonSum !== rowSum) out.push({ column: `${c.table}.${spec.column}:sum`, is_money: true, json: jsonSum.toString(), row: rowSum.toString() });
      // where the section's ledger set exists, the typed sum equals the set's lines by rule_ref (worked example A)
      const setIds = [...new Set(children.map((ch) => ch["ledger_entry_set_id"]).filter((x): x is string => typeof x === "string"))];
      for (const setId of setIds) {
        const lines = await q.query<{ rule_ref: string; amount_cents: bigint }>(`SELECT rule_ref, amount_cents FROM ledger_lines WHERE set_id = $1`, [setId]);
        if (!lines.length) continue;
        for (const r of rows.filter((x) => x["ledger_entry_set_id"] === setId)) {
          const line = lines.find((l) => l.rule_ref === r["rule_ref"]);
          if (!line) continue;
          const a = r[spec.column] as bigint; const l = line.amount_cents < 0n ? -line.amount_cents : line.amount_cents;
          if (a !== l) out.push({ column: `${c.table}.${spec.column}@${String(r["rule_ref"])}`, is_money: true, json: l.toString(), row: a.toString() });
        }
      }
    }
  }
  return out;
}

export async function verifyRun(ctx: VerifyContext, i: VerifyInput): Promise<VerifyReport> {
  const runId = randomUUID(); const startedAt = ctx.now; const q = ctx.q;
  const kinds = i.kinds?.length ? PROJECTORS.filter((m) => i.kinds!.includes(m.kind)) : PROJECTORS;
  // 1. gaps: every kind with un-projected versions (no map → no_projector; a typed kind's version without its row → listed too), one projection_gaps row per kind and reason
  const report = await gapsReport(q, i.as_of_date);
  const gapRows = report.kinds.filter((g) => !i.kinds?.length || i.kinds.includes(g.kind) || g.reason === "no_projector");
  // 2. the verify: the sample per kind, every money-bearing row of the day, the ledger sets
  const mismatchRows: MismatchRow[] = []; let rowsVerified = 0;
  for (const m of kinds) {
    for (const p of await sampleOf(q, m, i.as_of_date, i.sample ?? 100)) {
      rowsVerified++;
      for (const d of await compareRow(q, m, p)) {
        const owner = m.owner;
        const esc = ctx.escalations.open({ kind: d.is_money ? "sev1" : "sev3", ownerRole: d.is_money ? "ciso" : "qc_officer", severity: d.is_money ? "1" : "3",
          payload: { code: "PROJECTION_MISMATCH", run_id: runId, kind: p.kind, entity_id: p.entity_id, scope_key: p.scope_key, version: p.version, target_table: p.target_table, target_id: p.target_id, column: d.column, is_money: d.is_money, json_value: d.json, row_value: d.row, owning_process: owner,
            reason: d.is_money ? `a money column differs from the owning section's version: the correction is ${owner}'s officer command; the run wrote nothing (35.1 rule 13 / 14)` : `a typed column differs from the version; ${owner} owns the row` } }, ctx.actor);
        const id = randomUUID();
        ctx.events.append({ type: "projection.mismatch_found", aggregate: { kind: "projection_run", id: runId }, actor: ctx.actor, payload: { run_id: runId, kind: p.kind, entity_id: p.entity_id, scope_key: p.scope_key, version: p.version, column: d.column, is_money: d.is_money, target_table: p.target_table, target_id: p.target_id, escalation_id: esc.id, owning_process: owner, mismatch_id: id } });
        mismatchRows.push({ id, kind: p.kind, entity_id: p.entity_id, scope_key: p.scope_key, version: p.version, target_table: p.target_table, target_id: p.target_id, column_name: d.column, is_money: d.is_money, json_value: d.json, row_value: d.row, escalation_id: esc.id, owner });
      }
    }
  }
  // 3. the run row, finished, and its receipt — in the caller's transaction
  const finishedAt = ctx.now;
  await q.query(`INSERT INTO projection_runs (id, as_of_date, started_at, finished_at, kinds_checked, rows_verified, mismatches, gaps, outcome, actor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', $9)`,
    [runId, i.as_of_date, startedAt, finishedAt, kinds.length, rowsVerified, mismatchRows.length, gapRows.length, `${ctx.actor.kind}:${ctx.actor.id}`]);
  // the mismatch rows reference the run row (projection_mismatches.run_id → projection_runs): written once it exists, in the same transaction
  for (const mm of mismatchRows) await q.query(`INSERT INTO projection_mismatches (id, run_id, kind, entity_id, scope_key, version, target_table, target_id, column_name, is_money, json_value, row_value, escalation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [mm.id, runId, mm.kind, mm.entity_id, mm.scope_key, mm.version, mm.target_table, mm.target_id, mm.column_name, mm.is_money, mm.json_value, mm.row_value, mm.escalation_id]);
  for (const g of gapRows) {
    await q.query(`INSERT INTO projection_gaps (id, run_id, kind, scope_key, versions_unprojected, reason, detail, first_seen_at, as_of_date) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [randomUUID(), runId, g.kind, g.scopes === 1 ? "" : "", g.versions_unprojected, g.reason, JSON.stringify({ ...g.detail, scopes: g.scopes }), g.first_seen_at ?? finishedAt, i.as_of_date]);
    ctx.events.append({ type: "projection.gap_found", aggregate: { kind: "projection_run", id: runId }, actor: ctx.actor, payload: { run_id: runId, kind: g.kind, reason: g.reason, versions: g.versions_unprojected, scopes: g.scopes, as_of_date: i.as_of_date } });
  }
  // the receipt SM_PROJECTION_LAG_DAILY arms on and is satisfied by (a platform clock on the global subject; src/kernel/timers/engine.ts exempts §35 from the origination-context rule)
  const event = ctx.events.append({ type: "projection.run_completed", aggregate: { kind: "projection_run", id: runId }, actor: ctx.actor, payload: { run_id: runId, as_of_date: i.as_of_date, kinds_checked: kinds.length, rows_verified: rowsVerified, mismatches: mismatchRows.length, gaps: gapRows.length, started_at: startedAt, finished_at: finishedAt } });
  return { run_id: runId, as_of_date: i.as_of_date, outcome: "completed", kinds_checked: kinds.length, rows_verified: rowsVerified, mismatches: mismatchRows.length, gaps: gapRows.length, gap_rows: gapRows.map((g) => ({ kind: g.kind, reason: g.reason, versions_unprojected: g.versions_unprojected })), mismatch_rows: mismatchRows, event };
}

/** A failed run inserts `failed` and no event (rule: "a failed run inserts failed and no event") — on its own connection, after the run's transaction rolled back. */
export async function recordFailedRun(q: Queryable, i: { as_of_date: string; started_at: string; now: string; actor: Actor; error: string }): Promise<string> {
  const id = randomUUID();
  await q.query(`INSERT INTO projection_runs (id, as_of_date, started_at, finished_at, outcome, actor) VALUES ($1, $2, $3, $4, 'failed', $5)`, [id, i.as_of_date, i.started_at, i.now, `${i.actor.kind}:${i.actor.id} — ${i.error.slice(0, 200)}`]);
  return id;
}

/** True when a completed run exists for the day (the sweep runs the verify once per calendar day at/after 06:00 ET). */
export async function verifiedToday(q: Queryable, asOf: string): Promise<boolean> {
  return (await q.query(`SELECT 1 FROM projection_runs WHERE as_of_date = $1 AND outcome = 'completed' LIMIT 1`, [asOf])).length > 0;
}

export const typedKinds = (): string[] => PROJECTORS.map((m) => m.kind);
export const isTypedKind = (kind: string): boolean => projectorFor(kind) !== undefined;
