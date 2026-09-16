/**
 * §35.8 — the narrow ports on sibling processes built in parallel, each with an in-repo default so this process runs (and
 * its tests pass) whether or not the neighbour has merged (35.7's roles-35-7/ports.ts pattern):
 *   35.5  InstallmentsPort   the `loan_installments` version a derivation names in `sources` (the table exists in the base;
 *                            35.5's `version` column is read when present, else the row count stands in as the version).
 *   35.6  OrchestrationPort  the closing orchestration a funding screen acts on (step `funding_authorized`, waiting_human
 *                            {funding_approver}) and the `orchestration.held` items the queue opens; the default reads
 *                            `closing_orchestrations` when the table exists, else the `orchestration.*` event literals on
 *                            loan_events (the seam every §35 process writes), else nothing.
 *   35.3  JobsPort           35.3's dead units (`job.unit.dead` without a later `job.unit.resolved`) — from loan_events.
 *   35.9  CaseMilestonesPort 35.9's `case.milestone.due` items — from loan_events.
 *   35.2  DocumentsPort      `documents.store` for the derivation JSON and the daily report; the default inserts a `documents`
 *                            row with the text retained in `metadata` (34.4's evidence-pack precedent when no blob store is wired).
 * A test injects a port through the optional `ports` argument of the pass / the tools' services map (`work_ports`).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import { sha256Hex } from "../../../app/canonical.ts";
import type { Row } from "./types.ts";

export interface InstallmentsPort { version(q: Queryable, loanId: string): Promise<{ version: number; rows: number; source: string }> }
export interface OrchestrationView { readonly orchestration_id: string; readonly application_id: string; readonly step: string; readonly status: string; readonly waiting_on: string | null; readonly funding_id: string | null; readonly wire_id: string | null; readonly since: string | null }
export interface OrchestrationPort {
  /** The orchestration a funding screen acts on (null when 35.6 has none for the application). */
  forApplication(q: Queryable, applicationId: string): Promise<OrchestrationView | null>;
  /** The held steps the queue opens as `orchestration_held` items. */
  held(q: Queryable): Promise<readonly { id: string; application_id: string; role: string; since: string }[]>;
  /** 35.6 rule: the orchestration opens on the clear-to-close (35.8-T7) — the port records it (35.6's own tool once it lands). */
  openOnCtc(q: Queryable, i: { application_id: string; at: string; by: string }): Promise<{ orchestration_id: string } | null>;
  /** The release through 35.6 when it is registered (`orchestration.release`), else null and the screen dispatches 26.3 `prepareWire{op: release}` itself. */
  readonly releaseTool: { process: string; name: string } | null;
}
export interface JobsPort { dead(q: Queryable): Promise<readonly { id: string; loan_id: string | null; application_id: string | null; since: string; role: string; screen_code: string | null }[]> }
export interface CaseMilestonesPort { due(q: Queryable): Promise<readonly { id: string; loan_id: string | null; since: string; role: string; screen_code: string; case_kind: string }[]> }
export interface DocumentsPort { store(q: Queryable, i: { kind: string; text: string; loan_id: string | null; application_id: string | null; retention_class: string; metadata: Row; now: string; id?: string }): Promise<{ document_id: string; sha256: string; byte_size: number }>; verify(q: Queryable, documentId: string): Promise<{ ok: boolean; sha256: string | null; stored_sha256: string | null }> }
export interface WorkPorts { readonly installments?: InstallmentsPort; readonly orchestration?: OrchestrationPort; readonly jobs?: JobsPort; readonly caseMilestones?: CaseMilestonesPort; readonly documents?: DocumentsPort }

const exists = async (q: Queryable, table: string): Promise<boolean> => (await q.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`]))[0]?.r !== null;
const hasColumn = async (q: Queryable, table: string, column: string): Promise<boolean> => (await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column]))[0]?.n !== "0";

export const defaultInstallments: InstallmentsPort = {
  async version(q, loanId) {
    if (!(await exists(q, "loan_installments"))) return { version: 0, rows: 0, source: "servicing.loanCashState" };
    if (await hasColumn(q, "loan_installments", "version")) { const [r] = await q.query<{ v: string | null; n: string }>(`SELECT max(version)::text AS v, count(*)::text AS n FROM loan_installments WHERE loan_id = $1`, [loanId]); return { version: Number(r?.v ?? 0), rows: Number(r?.n ?? 0), source: "35.5 loan_installments" }; }
    const [r] = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_installments WHERE loan_id = $1`, [loanId]);
    return { version: Number(r?.n ?? 0), rows: Number(r?.n ?? 0), source: "loan_installments (rows as version until 35.5)" };
  },
};
export const defaultOrchestration: OrchestrationPort = {
  releaseTool: null,
  async forApplication(q, applicationId) {
    if (await exists(q, "closing_orchestrations")) {
      const [r] = await q.query<Row>(`SELECT id::text AS id, application_id::text AS application_id, step, status, waiting_on, funding_id::text AS funding_id, wire_id::text AS wire_id, updated_at::text AS since FROM closing_orchestrations WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`, [applicationId]).catch(() => [] as Row[]);
      if (r) return { orchestration_id: String(r["id"]), application_id: applicationId, step: String(r["step"] ?? ""), status: String(r["status"] ?? ""), waiting_on: (r["waiting_on"] as string | null) ?? null, funding_id: (r["funding_id"] as string | null) ?? null, wire_id: (r["wire_id"] as string | null) ?? null, since: (r["since"] as string | null) ?? null };
    }
    // the seam: 35.6's own event literals when its table has not landed (the last `orchestration.*` event of the application)
    const [e] = await q.query<Row>(`SELECT id::text AS id, type, payload, occurred_at::text AS at FROM loan_events WHERE application_id = $1 AND type LIKE 'orchestration.%' ORDER BY sequence DESC LIMIT 1`, [applicationId]);
    if (!e) return null;
    const p = (e["payload"] as Row) ?? {};
    return { orchestration_id: String(p["orchestration_id"] ?? e["id"]), application_id: applicationId, step: String(p["step"] ?? ""), status: String(e["type"]).replace("orchestration.", ""), waiting_on: (p["waiting_on"] as string | null) ?? (p["role"] as string | null) ?? null, funding_id: (p["funding_id"] as string | null) ?? null, wire_id: (p["wire_id"] as string | null) ?? null, since: String(e["at"]) };
  },
  async held(q) {
    if (await exists(q, "closing_orchestrations")) return (await q.query<Row>(`SELECT id::text AS id, application_id::text AS application_id, waiting_on AS role, updated_at::text AS since FROM closing_orchestrations WHERE status = 'held'`).catch(() => [] as Row[])).map((r) => ({ id: String(r["id"]), application_id: String(r["application_id"]), role: String(r["role"] ?? "ops_analyst"), since: String(r["since"]) }));
    const rows = await q.query<Row>(`SELECT h.id::text AS id, h.application_id::text AS application_id, h.payload, h.occurred_at::text AS since FROM loan_events h WHERE h.type = 'orchestration.held' AND NOT EXISTS (SELECT 1 FROM loan_events r WHERE r.type = 'orchestration.released' AND r.application_id = h.application_id AND r.sequence > h.sequence)`);
    return rows.map((r) => { const p = (r["payload"] as Row) ?? {}; return { id: String(p["orchestration_id"] ?? r["id"]), application_id: String(r["application_id"]), role: String(p["role"] ?? p["waiting_on"] ?? "ops_analyst"), since: String(r["since"]) }; });
  },
  async openOnCtc() { return null; },
};
export const defaultJobs: JobsPort = {
  async dead(q) {
    const rows = await q.query<Row>(`SELECT d.id::text AS id, d.loan_id::text AS loan_id, d.application_id::text AS application_id, d.payload, d.occurred_at::text AS since FROM loan_events d WHERE d.type = 'job.unit.dead' AND NOT EXISTS (SELECT 1 FROM loan_events r WHERE r.type = 'job.unit.resolved' AND r.sequence > d.sequence AND r.payload->>'unit_id' = d.payload->>'unit_id')`);
    return rows.map((r) => { const p = (r["payload"] as Row) ?? {}; return { id: String(p["unit_id"] ?? r["id"]), loan_id: (r["loan_id"] as string | null) ?? null, application_id: (r["application_id"] as string | null) ?? null, since: String(r["since"]), role: String(p["role"] ?? "ops_analyst"), screen_code: (p["screen_code"] as string | null) ?? null }; });
  },
};
export const defaultCaseMilestones: CaseMilestonesPort = {
  async due(q) {
    const rows = await q.query<Row>(`SELECT d.id::text AS id, d.loan_id::text AS loan_id, d.payload, d.occurred_at::text AS since FROM loan_events d WHERE d.type = 'case.milestone.due' AND NOT EXISTS (SELECT 1 FROM loan_events r WHERE r.type IN ('case.milestone.met', 'case.milestone.waived') AND r.sequence > d.sequence AND r.payload->>'milestone_id' = d.payload->>'milestone_id')`);
    return rows.map((r) => { const p = (r["payload"] as Row) ?? {}; const kind = String(p["case_kind"] ?? "foreclosure"); return { id: String(p["milestone_id"] ?? r["id"]), loan_id: (r["loan_id"] as string | null) ?? null, since: String(r["since"]), role: String(p["role"] ?? "ops_analyst"), screen_code: kind === "bankruptcy" ? "bankruptcy_case" : "foreclosure_case", case_kind: kind }; });
  },
};
export const defaultDocuments: DocumentsPort = {
  async store(q, i) {
    const document_id = i.id ?? randomUUID(); const sha256 = sha256Hex(i.text); const byte_size = Buffer.byteLength(i.text, "utf8");
    await q.query(`INSERT INTO documents (id, loan_id, application_id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'application/json', $8::retention_class, $9::jsonb, $10::timestamptz)`,
      [document_id, i.loan_id, i.application_id, i.kind, sha256, byte_size, `work://${i.kind}/${document_id}`, i.retention_class, toJson({ ...i.metadata, retained: "metadata", document: i.text }), i.now]);
    return { document_id, sha256, byte_size };
  },
  async verify(q, documentId) {
    const [r] = await q.query<{ sha256: string; document: string | null }>(`SELECT sha256, metadata->>'document' AS document FROM documents WHERE id = $1`, [documentId]);
    if (!r) return { ok: false, sha256: null, stored_sha256: null };
    const h = r.document === null ? null : sha256Hex(r.document);
    return { ok: h !== null && h === r.sha256, sha256: h, stored_sha256: r.sha256 };
  },
};
export const portsOf = (p: WorkPorts | undefined): Required<WorkPorts> => ({ installments: p?.installments ?? defaultInstallments, orchestration: p?.orchestration ?? defaultOrchestration, jobs: p?.jobs ?? defaultJobs, caseMilestones: p?.caseMilestones ?? defaultCaseMilestones, documents: p?.documents ?? defaultDocuments });
