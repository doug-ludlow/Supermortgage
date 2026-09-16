/**
 * §35.9 — the narrow ports on sibling processes not yet in the tree, each with an in-repo default so this process runs (and
 * its tests pass) whether or not the neighbour has merged (the roles-35-7/ports.ts pattern: a `to_regclass` probe, never a
 * second implementation of the neighbour). 35.3's cycles and 35.5's servicing configuration ARE in the tree: the day's cycles
 * run through src/domain/operations-runtime/service.ts (cycles-35-9.ts registers the runners) and the loan's zone is
 * src/runtime/delinquency.ts's read of `loan_servicing_configs` (35.5 rule 9) — neither has a port here any more.
 *   35.8  WorkItemsPort   — the queue item a due milestone, a deferred breach action, a counsel docket entry or an unexpected
 *                           transition opens; the default writes 35.8's `work_items` when it exists (unique open `(source_kind,
 *                           source_id)`), else answers null (the escalation the same path opens is the fallback a person sees).
 *   35.2  DocumentsPort   — `documents.store` for the referral / claim packages and the daily report: the default inserts a
 *                           baseline `documents` row with the sha256 of the canonical bytes (`storage_uri` mem://35.9/<sha>).
 * A test or the runtime injects a port through the optional `ports` argument of the runner / pass.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";

const exists = async (q: Queryable, table: string): Promise<boolean> => (await q.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`]))[0]?.r !== null;

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

export interface DefaultOpsPorts { readonly workItems?: WorkItemsPort; readonly documents?: DocumentsPort }
export const portsOf = (p: DefaultOpsPorts | undefined): Required<DefaultOpsPorts> => ({ workItems: p?.workItems ?? defaultWorkItems, documents: p?.documents ?? defaultDocuments });
