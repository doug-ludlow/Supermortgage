/**
 * §35.2 rule 7 — the viewer serves stored bytes. `documents.open` resolves the row, streams the object (or the staged blob
 * while `storage_status = staged`, or during a store outage), hashes the bytes on the way out — the hash on the log row equals
 * the row's `sha256`; a served mismatch is refused INTEGRITY_FAILED and raises the same sev 1 as the daily run — and writes
 * `document_access_log`. A disposed row answers its tombstone (the hash and the disposal run id; the routes answer 410).
 * Ownership and signatures are the routes' (NOT_YOUR_DOCUMENT → 404, never 403; an expired or mis-signed URL → 401).
 */
import type { Queryable } from "../../../infra/db/client.ts";
import { AdapterUnavailable } from "../../../infra/integrations/failures.ts";
import { sha256Hex, type ObjectStorePort } from "../../../infra/blobs/pg-fake-blob-store.ts";
import { textLayer } from "../../../infra/files/pdf.ts";
import { readDocument, type DocumentRow } from "./shared.ts";

export type OpenPurpose = "borrower_view" | "staff_view" | "esign_view" | "verify_portal" | "evidence_pack" | "integrity";
export interface OpenInput {
  readonly document_id: string; readonly purpose: OpenPurpose;
  readonly party_id?: string | null; readonly staff_user_id?: string | null; readonly session_id?: string | null; readonly ip?: string | null; readonly user_agent?: string | null;
  /** Skip the access-log row (a probe that serves nothing). */
  readonly log?: boolean;
}
export type OpenResult =
  | { readonly kind: "unknown" }
  | { readonly kind: "tombstone"; readonly row: DocumentRow; readonly sha256: string; readonly disposal_run_id: string | null; readonly disposed_at: string | null }
  | { readonly kind: "unavailable"; readonly row: DocumentRow }
  | { readonly kind: "mismatch"; readonly row: DocumentRow; readonly expected_sha256: string; readonly actual_sha256: string; readonly served_from: "object_store" | "staged_blob" }
  | { readonly kind: "bytes"; readonly row: DocumentRow; readonly bytes: Buffer; readonly mime_type: string; readonly sha256: string; readonly byte_size: number; readonly served_from: "object_store" | "staged_blob"; readonly text: string | null; readonly access_log_id: string | null;
      /** a `stored` row whose object the reachable store no longer holds: the staged copy served, the `missing` finding is the caller's to raise (documents.verify{op: one}) */ readonly store_missing: boolean };

const isPdf = (mime: string | null): boolean => mime === "application/pdf";

/** The bytes of a document: the object store for a stored row, the staged blob otherwise (and during a store outage). */
export async function documentBytes(q: Queryable, blobs: ObjectStorePort, row: DocumentRow): Promise<{ bytes: Buffer; mime_type: string; served_from: "object_store" | "staged_blob"; store_missing: boolean } | null> {
  let storeMissing = false;
  if (row.storage_status === "stored" && (row.storage_uri.startsWith("fake-blob://") || row.storage_uri.startsWith("gs://"))) {
    try { const b = await blobs.get(row.id, q); if (b) return { bytes: b.bytes, mime_type: b.mime_type, served_from: "object_store", store_missing: false }; storeMissing = true; }
    catch (e) { if (!(e instanceof AdapterUnavailable)) throw e; }
  }
  const staged = (await q.query<{ content: Buffer | null; mime_type: string }>(`SELECT content, mime_type FROM document_blobs WHERE document_id = $1`, [row.id]))[0];
  if (staged?.content) return { bytes: Buffer.isBuffer(staged.content) ? staged.content : Buffer.from(staged.content), mime_type: staged.mime_type, served_from: "staged_blob", store_missing: storeMissing };
  return null;
}

export interface AccessLogInput { readonly document_id: string; readonly purpose: OpenPurpose; readonly party_id: string | null; readonly staff_user_id: string | null; readonly session_id: string | null; readonly ip: string | null; readonly user_agent: string | null; readonly sha256_served: string; readonly byte_size_served: number; readonly served_from: "object_store" | "staged_blob"; }
/** Rule 7: every serve is a document_access_log row with the hash of what was served. */
export async function insertAccessLog(q: Queryable, i: AccessLogInput): Promise<string | null> {
  const r = await q.query<{ id: string }>(`INSERT INTO document_access_log (document_id, purpose, party_id, staff_user_id, session_id, ip, user_agent, sha256_served, byte_size_served, served_from) VALUES ($1, $2, $3, $4, $5, $6::inet, $7, $8, $9, $10) RETURNING id`,
    [i.document_id, i.purpose, i.party_id, i.staff_user_id, i.session_id, i.ip && /^[0-9a-f.:]+$/i.test(i.ip) ? i.ip : null, i.user_agent, i.sha256_served, i.byte_size_served, i.served_from]);
  return r[0]?.id ?? null;
}

export async function openDocument(deps: { q: Queryable; blobs: ObjectStorePort }, i: OpenInput): Promise<OpenResult> {
  const row = await readDocument(deps.q, i.document_id);
  if (!row) return { kind: "unknown" };
  if (row.storage_status === "disposed") return { kind: "tombstone", row, sha256: row.sha256, disposal_run_id: row.disposal_run_id, disposed_at: row.disposed_at };
  const got = await documentBytes(deps.q, deps.blobs, row);
  if (!got) return { kind: "unavailable", row };
  const actual = sha256Hex(got.bytes);
  if (actual !== row.sha256) return { kind: "mismatch", row, expected_sha256: row.sha256, actual_sha256: actual, served_from: got.served_from };
  let accessLogId: string | null = null;
  if (i.log !== false) accessLogId = await insertAccessLog(deps.q, { document_id: row.id, purpose: i.purpose, party_id: i.party_id ?? null, staff_user_id: i.staff_user_id ?? null, session_id: i.session_id ?? null, ip: i.ip ?? null, user_agent: i.user_agent ?? null, sha256_served: actual, byte_size_served: got.bytes.length, served_from: got.served_from });
  let text: string | null = null;
  if (isPdf(got.mime_type) && row.text_layer) { try { text = textLayer(got.bytes).text; } catch { text = null; } }
  return { kind: "bytes", row, bytes: got.bytes, mime_type: got.mime_type, sha256: actual, byte_size: got.bytes.length, served_from: got.served_from, text, access_log_id: accessLogId, store_missing: got.store_missing };
}
