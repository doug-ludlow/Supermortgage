/**
 * §35.9 — the narrow ports on sibling processes, each with an in-repo default so this process runs (and its tests pass)
 * whether or not the neighbour has merged (the roles-35-7/ports.ts pattern: a `to_regclass` probe, never a second
 * implementation of the neighbour):
 *   35.3  CyclesPort      — one `cycles.run_unit` per (cycle, period, unit): the default runs the unit and, when 35.3's
 *                           `cycle_runs` / `cycle_receipts` tables exist, records the run row (unique `(cycle_code, period_key)`),
 *                           its unit counters and the receipt row (35.3 rule 5) — the columns 35.3's spec names, nothing else.
 *   35.8  WorkItemsPort   — the queue item a due milestone, a deferred breach action, a counsel docket entry or an unexpected
 *                           transition opens; the default writes 35.8's `work_items` when it exists (unique open `(source_kind,
 *                           source_id)`), else answers null (the escalation the same path opens is the fallback a person sees).
 *   35.2  DocumentsPort   — `documents.store` for the referral / claim packages and the daily report: the default inserts a
 *                           baseline `documents` row with the sha256 of the canonical bytes (`storage_uri` mem://35.9/<sha>).
 *   35.5  ServicingConfigPort — the loan's zone (35.5 rule 9) from `loan_servicing_configs.time_zone` when the table exists,
 *                           else 11.1's LOAN_LOCAL_TZ.
 * A test or the runtime injects a port through the optional `ports` argument of the runner / pass.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { loanZoneOf } from "../../../runtime/delinquency.ts";
import { plainDate } from "../../../kernel/calendar/date.ts";

const exists = async (q: Queryable, table: string): Promise<boolean> => (await q.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`]))[0]?.r !== null;

// ---- 35.3 -------------------------------------------------------------------------------------------------------------------
export interface UnitOutcome { readonly status: "done" | "failed" | "skipped"; readonly decision_id?: string | null; readonly error?: string | null }
export interface CycleUnitInput { readonly cycle_code: string; readonly period_key: string; readonly as_of_date: string; readonly unit_id: string; readonly loan_id: string | null; readonly planned_by: string; readonly now: string }
export interface CycleRunHandle { readonly run_id: string; readonly recorded: boolean }
export interface CyclesPort {
  /** Open (or find) the cycle's run for the period; returns its id (a fresh uuid when 35.3 is not in the tree). */
  openRun(q: Queryable, i: { cycle_code: string; period_key: string; as_of_date: string; planned_by: string; units_total: number; now: string }): Promise<CycleRunHandle>;
  /** Record one unit's outcome on the run. */
  unitDone(q: Queryable, run: CycleRunHandle, i: CycleUnitInput, outcome: UnitOutcome): Promise<void>;
  /** Close the run and write its receipt (35.3 rule 5: exactly once per run). */
  complete(q: Queryable, run: CycleRunHandle, i: { cycle_code: string; period_key: string; as_of_date: string; units: readonly { unit_id: string; outcome: UnitOutcome }[]; receipt_event_id: string | null; now: string }): Promise<void>;
}
export const defaultCycles: CyclesPort = {
  async openRun(q, i) {
    if (!(await exists(q, "cycle_runs"))) return { run_id: randomUUID(), recorded: false };
    const rows = await q.query<{ id: string }>(
      `INSERT INTO cycle_runs (cycle_code, period_key, as_of_date, planned_by, opened_at, units_total, status)
       VALUES ($1, $2, $3::date, $4, $5::timestamptz, $6, 'running')
       ON CONFLICT (cycle_code, period_key) DO UPDATE SET planned_by = cycle_runs.planned_by RETURNING id::text AS id`,
      [i.cycle_code, i.period_key, i.as_of_date, i.planned_by, i.now, i.units_total]);
    return { run_id: rows[0]!.id, recorded: true };
  },
  async unitDone(q, run, _i, outcome) {
    if (!run.recorded) return;
    const col = outcome.status === "done" ? "units_done" : outcome.status === "failed" ? "units_dead" : "units_skipped";
    await q.query(`UPDATE cycle_runs SET ${col} = ${col} + 1 WHERE id = $1::uuid`, [run.run_id]);
  },
  async complete(q, run, i) {
    if (!run.recorded) return;
    const done = i.units.filter((u) => u.outcome.status === "done").length, dead = i.units.filter((u) => u.outcome.status === "failed").length, skipped = i.units.filter((u) => u.outcome.status === "skipped").length;
    const sha = createHash("sha256").update(JSON.stringify(i.units.map((u) => [u.unit_id, u.outcome.status, u.outcome.decision_id ?? null]))).digest("hex");
    const already = await q.query<{ id: string }>(`SELECT id::text AS id FROM cycle_receipts WHERE run_id = $1::uuid`, [run.run_id]);
    if (!already.length && (await exists(q, "cycle_receipts"))) {
      await q.query(`INSERT INTO cycle_receipts (run_id, cycle_code, period_key, as_of_date, units_total, units_done, units_dead, units_skipped, outcomes_sha256, receipt_event_id, emitted_by)
                     VALUES ($1::uuid, $2, $3, $4::date, $5, $6, $7, $8, $9, $10::uuid, $11)`,
        [run.run_id, i.cycle_code, i.period_key, i.as_of_date, i.units.length, done, dead, skipped, sha, i.receipt_event_id, `planner:${run.run_id}`]);
    }
    await q.query(`UPDATE cycle_runs SET status = 'completed', completed_at = $2::timestamptz, units_total = $3 WHERE id = $1::uuid`, [run.run_id, i.now, i.units.length]);
  },
};

// ---- 35.8 -------------------------------------------------------------------------------------------------------------------
export interface WorkItemInput {
  readonly screen_code: string; readonly subject_kind: "loan" | "application"; readonly subject_id: string; readonly loan_id: string | null;
  readonly source_kind: string; readonly source_id: string; readonly required_role: string; readonly due_at?: string | null; readonly now: string;
}
export interface WorkItemsPort {
  open(q: Queryable, i: WorkItemInput): Promise<string | null>;
  close(q: Queryable, i: { source_kind: string; source_id: string; disposition: string; now: string }): Promise<number>;
  /** 35.8's `work.action.propose` — a proposal a distinct `officer` decides; the default is an `approval_pending` item. */
  propose(q: Queryable, i: WorkItemInput & { action_code: string }): Promise<string | null>;
}
export const defaultWorkItems: WorkItemsPort = {
  async open(q, i) {
    if (!(await exists(q, "work_items"))) return null;
    const open = await q.query<{ id: string }>(`SELECT id::text AS id FROM work_items WHERE source_kind = $1 AND source_id = $2 AND status NOT IN ('closed', 'cancelled')`, [i.source_kind, i.source_id]);
    if (open[0]) return open[0].id;
    const rows = await q.query<{ id: string }>(
      `INSERT INTO work_items (screen_code, subject_kind, subject_id, loan_id, source_kind, source_id, required_role, status, opened_at, due_at)
       VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, 'open', $8::timestamptz, $9::timestamptz) RETURNING id::text AS id`,
      [i.screen_code, i.subject_kind, i.subject_id, i.loan_id, i.source_kind, i.source_id, i.required_role, i.now, i.due_at ?? null]);
    return rows[0]?.id ?? null;
  },
  async close(q, i) {
    if (!(await exists(q, "work_items"))) return 0;
    const rows = await q.query<{ id: string }>(`UPDATE work_items SET status = 'closed', closed_at = $3::timestamptz, disposition = $4, updated_at = $3::timestamptz WHERE source_kind = $1 AND source_id = $2 AND status NOT IN ('closed', 'cancelled') RETURNING id::text AS id`, [i.source_kind, i.source_id, i.now, i.disposition]);
    return rows.length;
  },
  async propose(q, i) { return defaultWorkItems.open(q, { ...i, source_kind: "approval_pending", source_id: `${i.source_id}:${i.action_code}` }); },
};

// ---- 35.2 -------------------------------------------------------------------------------------------------------------------
export interface StoredDocument { readonly document_id: string; readonly sha256: string; readonly byte_size: number }
export interface DocumentsPort {
  store(q: Queryable, i: { loan_id: string | null; kind: string; body: string; mime_type: string; retention_class: string; metadata: Record<string, unknown>; now: string }): Promise<StoredDocument>;
}
export const defaultDocuments: DocumentsPort = {
  async store(q, i) {
    const bytes = Buffer.from(i.body, "utf8"); const sha256 = createHash("sha256").update(bytes).digest("hex");
    const rows = await q.query<{ id: string }>(
      `INSERT INTO documents (loan_id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::retention_class, $8::jsonb, $9::timestamptz) RETURNING id::text AS id`,
      [i.loan_id, i.kind, sha256, bytes.length, `mem://35.9/${sha256}`, i.mime_type, i.retention_class, JSON.stringify(i.metadata), i.now]);
    return { document_id: rows[0]!.id, sha256, byte_size: bytes.length };
  },
};

// ---- 35.5 -------------------------------------------------------------------------------------------------------------------
export interface ServicingConfigPort { zoneOf(q: Queryable, loanId: string, asOf: string): Promise<string> }
export const defaultServicingConfig: ServicingConfigPort = { zoneOf: (q, loanId, asOf) => loanZoneOf(q, loanId, plainDate(asOf)) };

export interface DefaultOpsPorts { readonly cycles?: CyclesPort; readonly workItems?: WorkItemsPort; readonly documents?: DocumentsPort; readonly servicingConfig?: ServicingConfigPort }
export const portsOf = (p: DefaultOpsPorts | undefined): Required<DefaultOpsPorts> =>
  ({ cycles: p?.cycles ?? defaultCycles, workItems: p?.workItems ?? defaultWorkItems, documents: p?.documents ?? defaultDocuments, servicingConfig: p?.servicingConfig ?? defaultServicingConfig });
