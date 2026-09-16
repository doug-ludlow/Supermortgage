/**
 * §35.6's port on 35.2 (documents and artifacts). The pass stores the artifacts its steps produce — the daily Closing board,
 * the CD bytes 25.2 renders, the settlement statement the FAKE agent uploads — as `documents` rows with a sha256 over the
 * stored bytes. When 35.2's `documents.store` tool is on the bus, it replaces `storeDocument`'s fallback writer (the ask in
 * the 35.6 plan); until then this in-repo default writes the 35.2 `documents` row shape 26.1/26.2 already project into.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";

export interface StoreDocumentInput { readonly kind: string; readonly application_id: string | null; readonly loan_id: string | null; readonly text: string; readonly retention_class: string; readonly source: string; readonly now: string; readonly id?: string }
export interface DocumentsPort35_6 { store(q: Queryable, i: StoreDocumentInput): Promise<string> }

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Columns of the `documents` table this fallback can fill (read once per process; the table is 0001's + 26.1's additions). */
let columns: Set<string> | null = null;
async function documentColumns(q: Queryable): Promise<Set<string>> {
  if (columns) return columns;
  const rows = await q.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents'`);
  columns = new Set(rows.map((r) => r.column_name));
  return columns;
}

/** The in-repo default: one `documents` row (id, kind, sha256, retention class, the scope ids and the stored length); the bytes' hash is the row's `sha256`. */
export const pgDocumentsFallback: DocumentsPort35_6 = {
  async store(q, i) {
    const id = i.id ?? randomUUID();
    const cols = await documentColumns(q);
    const hash = sha256(i.text);
    const fields: Record<string, unknown> = { id };
    const set = (k: string, v: unknown): void => { if (cols.has(k)) fields[k] = v; };
    set("loan_id", i.loan_id); set("application_id", i.application_id); set("kind", i.kind); set("doc_class", i.kind); set("sha256", hash);
    set("retention_class", i.retention_class); set("source_channel", "system"); set("received_at", i.now); set("created_at", i.now); set("byte_size", Buffer.byteLength(i.text));
    set("mime_type", "application/json"); set("storage_uri", `mem://35.6/${id}`); set("metadata", JSON.stringify({ source: i.source, process: "35.6" })); set("integrity_status", "verified");
    const keys = Object.keys(fields);
    await q.query(`INSERT INTO documents (${keys.join(", ")}) VALUES (${keys.map((_k, n) => `$${n + 1}`).join(", ")})`, keys.map((k) => fields[k]));
    return id;
  },
};
let port: DocumentsPort35_6 = pgDocumentsFallback;
/** 35.2 (or a test) supplies its port; absent, the fallback writes the row directly. */
export function setDocumentsPort(p: DocumentsPort35_6 | null): void { port = p ?? pgDocumentsFallback; }
export const storeDocument = (q: Queryable, i: StoreDocumentInput): Promise<string> => port.store(q, i);
