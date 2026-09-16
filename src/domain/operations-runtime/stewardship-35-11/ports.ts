/**
 * §35.11 — the narrow ports on sibling processes, each with an in-repo default so this process runs (and its tests pass)
 * whether or not the neighbour has merged (35.7's roles-35-7/ports.ts pattern):
 *   35.3  CyclesPort   — the registry rows past `next_expected_by` (cycle_registry), the receipts (cycle_receipts) and the runs;
 *                        the defaults read the tables when `to_regclass` finds them and answer none otherwise ("feeds: absent").
 *   35.2  ReportDocumentPort — where the rendered daily report is stored; the default writes a `documents` row (kind
 *                        ops_daily_report, storage_uri memory://ops-report/<report_id>) until 35.2's store lands.
 *   the feeds          — which of the tables the steward reads exist on this database (edge case 1: absent feeds are reported,
 *                        never fatal).
 * A test injects a port through the optional `ports` argument of the pass / the tools.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { Row } from "./types.ts";

export const FEED_TABLES = ["sweep_runs", "outbox_dispatches", "integration_messages", "cycle_registry", "cycle_runs", "cycle_receipts", "jobs", "projection_runs", "projection_gaps", "projection_mismatches", "document_integrity_findings", "document_blobs", "role_queue_snapshots", "role_handovers", "ai_systems", "ai_monitoring_metrics", "escalations", "timers", "agent_decisions", "loan_events", "feature_flags", "demo_clock", "documents"] as const;
export type FeedTable = (typeof FEED_TABLES)[number];
export type Feeds = Record<FeedTable, "present" | "absent">;

export const tableExists = async (q: Queryable, table: string): Promise<boolean> => (await q.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`]))[0]?.r !== null;
export async function feedsOf(q: Queryable): Promise<Feeds> {
  const out: Partial<Feeds> = {};
  for (const t of FEED_TABLES) out[t] = (await tableExists(q, t)) ? "present" : "absent";
  return out as Feeds;
}

export interface OverdueCycle { readonly cycle_code: string; readonly period_key: string; readonly next_expected_by: string; readonly overdue_since: string | null; readonly owner_process: string | null; readonly owner_agent: string | null; readonly escalation_role: string | null; readonly expected_by_rule: string | null; readonly schedule: string | null; readonly status: string | null }
export interface CycleRegistryRow extends OverdueCycle { readonly unit_scope: string | null; readonly last_period_key: string | null; readonly last_receipt_at: string | null; readonly next_period_key: string | null }
export interface CyclesPort {
  /** Active registry rows whose `next_expected_by` is before `now` (35.3 rule 11 sets `overdue_since` when it passes with no receipt). */
  overdue(q: Queryable, now: string): Promise<readonly OverdueCycle[]>;
  /** Whether a `cycle_receipts` row exists for the (cycle_code, period_key). */
  hasReceipt(q: Queryable, cycle_code: string, period_key: string): Promise<boolean>;
  /** One registry row (the runbook's `{cycle_code}` answer), or null. */
  registryRow(q: Queryable, cycle_code: string): Promise<CycleRegistryRow | null>;
  /** The day's per-cycle counters for the report: runs opened, receipts, units done/dead, overdue_since. */
  daySummary(q: Queryable, from: string, to: string): Promise<readonly Row[]>;
}
const periodOf = (r: Row): string => (typeof r["next_period_key"] === "string" && r["next_period_key"] ? String(r["next_period_key"]) : String(r["next_expected_by"] ?? "").slice(0, 10));
export const defaultCycles: CyclesPort = {
  async overdue(q, now) {
    if (!(await tableExists(q, "cycle_registry"))) return [];
    const rows = await q.query<Row>(`SELECT cycle_code, next_period_key, next_expected_by::text AS next_expected_by, overdue_since::text AS overdue_since, owner_process, owner_agent, escalation_role, expected_by_rule, schedule, status FROM cycle_registry WHERE next_expected_by IS NOT NULL AND next_expected_by < $1::timestamptz AND coalesce(status, 'active') = 'active' ORDER BY cycle_code`, [now]);
    return rows.map((r) => ({ cycle_code: String(r["cycle_code"]), period_key: periodOf(r), next_expected_by: String(r["next_expected_by"]), overdue_since: r["overdue_since"] ? String(r["overdue_since"]) : null, owner_process: r["owner_process"] ? String(r["owner_process"]) : null, owner_agent: r["owner_agent"] ? String(r["owner_agent"]) : null, escalation_role: r["escalation_role"] ? String(r["escalation_role"]) : null, expected_by_rule: r["expected_by_rule"] ? String(r["expected_by_rule"]) : null, schedule: r["schedule"] ? String(r["schedule"]) : null, status: r["status"] ? String(r["status"]) : null }));
  },
  async hasReceipt(q, cycle_code, period_key) {
    if (!(await tableExists(q, "cycle_receipts"))) return false;
    return (await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM cycle_receipts WHERE cycle_code = $1 AND period_key = $2`, [cycle_code, period_key]))[0]!.n !== "0";
  },
  async registryRow(q, cycle_code) {
    if (!(await tableExists(q, "cycle_registry"))) return null;
    const r = (await q.query<Row>(`SELECT cycle_code, owner_process, owner_agent, unit_scope, schedule, escalation_role, expected_by_rule, status, last_period_key, last_receipt_at::text AS last_receipt_at, next_period_key, next_expected_by::text AS next_expected_by, overdue_since::text AS overdue_since FROM cycle_registry WHERE cycle_code = $1`, [cycle_code]))[0];
    if (!r) return null;
    const str = (k: string): string | null => (r[k] === null || r[k] === undefined ? null : String(r[k]));
    return { cycle_code, period_key: periodOf(r), next_expected_by: str("next_expected_by") ?? "", overdue_since: str("overdue_since"), owner_process: str("owner_process"), owner_agent: str("owner_agent"), escalation_role: str("escalation_role"), expected_by_rule: str("expected_by_rule"), schedule: str("schedule"), status: str("status"), unit_scope: str("unit_scope"), last_period_key: str("last_period_key"), last_receipt_at: str("last_receipt_at"), next_period_key: str("next_period_key") };
  },
  async daySummary(q, from, to) {
    if (!(await tableExists(q, "cycle_registry"))) return [];
    const runs = (await tableExists(q, "cycle_runs")) ? await q.query<Row>(`SELECT cycle_code, count(*)::int AS runs, count(receipt_id)::int AS receipts, coalesce(sum(units_done), 0)::int AS units_done, coalesce(sum(units_dead), 0)::int AS units_dead FROM cycle_runs WHERE opened_at >= $1::timestamptz AND opened_at < $2::timestamptz GROUP BY cycle_code`, [from, to]) : [];
    const reg = await q.query<Row>(`SELECT cycle_code, overdue_since::text AS overdue_since FROM cycle_registry ORDER BY cycle_code`);
    return reg.map((r) => { const run = runs.find((x) => x["cycle_code"] === r["cycle_code"]); return { cycle_code: String(r["cycle_code"]), runs: Number(run?.["runs"] ?? 0), receipts: Number(run?.["receipts"] ?? 0), units_done: Number(run?.["units_done"] ?? 0), units_dead: Number(run?.["units_dead"] ?? 0), overdue_since: r["overdue_since"] ? String(r["overdue_since"]) : null }; });
  },
};

export interface ReportDocumentPort { store(q: Queryable, i: { report_id: string; environment: string; as_of_date: string; sha256: string; json: string; now: string }): Promise<string> }
export const defaultReportDocument: ReportDocumentPort = {
  async store(q, i) {
    const [row] = await q.query<{ id: string }>(`INSERT INTO documents (kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at) VALUES ('ops_daily_report', $1, $2, $3, 'application/json', 'corporate_7y', $4::jsonb, $5::timestamptz) RETURNING id::text AS id`,
      [i.sha256, Buffer.byteLength(i.json, "utf8"), `memory://ops-report/${i.report_id}`, JSON.stringify({ process: "35.11", report_id: i.report_id, environment: i.environment, as_of_date: i.as_of_date }), i.now]);
    return row!.id;
  },
};

export interface StewardPorts { readonly cycles?: CyclesPort; readonly reportDocument?: ReportDocumentPort }
export const portsOf = (p: StewardPorts | undefined): Required<StewardPorts> => ({ cycles: p?.cycles ?? defaultCycles, reportDocument: p?.reportDocument ?? defaultReportDocument });
