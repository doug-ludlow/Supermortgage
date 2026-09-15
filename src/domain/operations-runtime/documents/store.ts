/**
 * §35.2 rules 1 and 4 — `documents.store` and the drain.
 *
 * "The hash is the bytes": `documents.sha256` is SHA-256 of the exact bytes stored, `byte_size` their length; a caller whose
 * hash differs from the bytes' is refused and nothing is written. "Staging first, always": the row is written with
 * `storage_uri = worm_pending:<id>` and `storage_status = staged` beside the `document_blobs` row in the command's
 * transaction, `document.staged` is appended (SM_DOC_WORM_DRAIN_1D arms on it, anchored on `staged_at`), and when the object
 * store is reachable the drain runs inline in the same command: put with generation-match 0, re-read, compare the hash and
 * only then swap `storage_uri` to `fake-blob://<id>#<generation>` (`gs://…` in production) — the one permitted swap — and
 * append `document.stored{document_id, storage_uri, stored_generation}` (satisfies the clock). A store whose re-read hash
 * differs never swaps: `document_blobs.last_drain_error = HASH_MISMATCH_ON_PUT`, `drain_attempts` counts, the next drain
 * retries under a new generation, and after 5 attempts an `ops_analyst` escalation is opened; the staged copy stays the
 * served copy. Idempotency (edge case): the same (template_code, template_version, payload_hash, subject) rendered twice at
 * one clock is one row — the existing id is returned; a different clock is a different document.
 */
import { randomUUID } from "node:crypto";
import { toJson } from "../../../infra/db/client.ts";
import { AdapterUnavailable } from "../../../infra/integrations/failures.ts";
import { sha256Hex, WORM_PENDING } from "../../../infra/blobs/pg-fake-blob-store.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import { assertRetentionClass, docKey, readDocument, RENDER_ENGINE, type DocsDeps, type DocumentRow, DocumentsRefused } from "./shared.ts";

export const RENDER_VERSION = "sm-pdf/1";
export const DRAIN_MAX_ATTEMPTS = 5;

export interface StoreInput {
  readonly id?: string;
  readonly kind: string;
  /** The bytes, or for a vendor-held artifact the hash and size the vendor reported plus its URI. */
  readonly bytes?: Buffer;
  readonly sha256?: string;
  readonly byte_size?: number;
  readonly vendor_storage_uri?: string;
  readonly mime_type: string;
  readonly retention_class: string;
  readonly loan_id?: string | null;
  readonly application_id?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly page_count?: number | null;
  readonly template_code?: string | null;
  readonly template_version?: string | null;
  readonly payload_hash?: string | null;
  readonly text_layer?: boolean | null;
  readonly locale?: string | null;
  readonly supersedes_document_id?: string | null;
  readonly received_from?: string | null;
  /** 22.1's intake columns, written by the borrower upload route (0078). */
  readonly intake?: { doc_class: string | null; source_channel: string; sender_identity: Record<string, unknown>; received_at: string; subject_borrower_id: string | null };
  /** Skip the inline drain even when the store is reachable (a test that wants a staged row). */
  readonly stage_only?: boolean;
}
export interface StoreResult {
  readonly document_id: string; readonly sha256: string; readonly byte_size: number; readonly storage_status: DocumentRow["storage_status"]; readonly storage_uri: string; readonly stored_generation: string | null;
  /** True when the idempotent lookup found the row (nothing was written). */
  readonly existing: boolean;
  readonly drain: DrainOutcome | null;
}

/** `documents.store`: the row and its bytes, staged; drained inline when the store is reachable. */
export async function storeDocument(deps: DocsDeps, i: StoreInput): Promise<StoreResult> {
  assertRetentionClass(i.retention_class);
  if (!i.kind) throw new RangeError("35.2 documents.store: kind is required");
  if (!i.mime_type) throw new RangeError("35.2 documents.store: mime_type is required");
  let sha256: string; let byteSize: number;
  if (i.bytes) {
    sha256 = sha256Hex(i.bytes); byteSize = i.bytes.length;
    if (i.sha256 && i.sha256.toLowerCase() !== sha256) throw new DocumentsRefused("HASH_MISMATCH", "35.2 rule 1: the hash is the bytes", `the caller's sha256 ${i.sha256} is not the hash of the bytes (${sha256}); nothing written`);
    if (byteSize === 0) throw new RangeError("35.2 documents.store: empty bytes");
  } else {
    if (!i.sha256 || !/^[0-9a-f]{64}$/i.test(i.sha256) || i.byte_size === undefined || !i.vendor_storage_uri) throw new RangeError("35.2 documents.store: bytes, or sha256 + byte_size + vendor_storage_uri for a vendor-held artifact");
    sha256 = i.sha256.toLowerCase(); byteSize = i.byte_size;
  }
  const q = deps.q;
  // idempotency: the same render twice in one command (the same clock) is one row
  if (i.template_code && i.payload_hash) {
    const found = await q.query<{ id: string; storage_status: DocumentRow["storage_status"]; storage_uri: string; stored_generation: string | null; sha256: string; byte_size: bigint | number }>(
      `SELECT id, storage_status, storage_uri, stored_generation, sha256, byte_size FROM documents WHERE template_code = $1 AND template_version IS NOT DISTINCT FROM $2 AND payload_hash = $3 AND loan_id IS NOT DISTINCT FROM $4 AND application_id IS NOT DISTINCT FROM $5 AND created_at = $6::timestamptz ORDER BY created_at LIMIT 1`,
      [i.template_code, i.template_version ?? null, i.payload_hash, i.loan_id ?? null, i.application_id ?? null, deps.now]);
    const f = found[0];
    if (f) return { document_id: f.id, sha256: f.sha256, byte_size: Number(f.byte_size), storage_status: f.storage_status, storage_uri: f.storage_uri, stored_generation: f.stored_generation, existing: true, drain: null };
  }
  const id = i.id ?? randomUUID();
  const vendorHeld = !i.bytes;
  const storageUri = vendorHeld ? i.vendor_storage_uri! : `${WORM_PENDING}${id}`;
  await q.query(
    `INSERT INTO documents (id, loan_id, application_id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at, page_count, supersedes_document_id, received_from,
       storage_status, stored_generation, render_engine, render_version, template_code, template_version, payload_hash, text_layer, locale, doc_class, source_channel, sender_identity, received_at, subject_borrower_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::retention_class, $10::jsonb, $11::timestamptz, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26::jsonb, $27::timestamptz, $28)`,
    [id, i.loan_id ?? null, i.application_id ?? null, i.kind, sha256, byteSize, storageUri, i.mime_type, i.retention_class, toJson(i.metadata ?? {}), deps.now, i.page_count ?? null, i.supersedes_document_id ?? null, i.received_from ?? null,
      vendorHeld ? "stored" : "staged", vendorHeld ? "vendor" : null, i.template_code ? RENDER_ENGINE : null, i.template_code ? RENDER_VERSION : null, i.template_code ?? null, i.template_version ?? null, i.payload_hash ?? null, i.text_layer ?? null, i.locale ?? null,
      i.intake?.doc_class ?? null, i.intake?.source_channel ?? null, toJson(i.intake?.sender_identity ?? {}), i.intake?.received_at ?? null, i.intake?.subject_borrower_id ?? null]);
  if (vendorHeld) return { document_id: id, sha256, byte_size: byteSize, storage_status: "stored", storage_uri: storageUri, stored_generation: "vendor", existing: false, drain: null };
  await q.query(`INSERT INTO document_blobs (document_id, sha256, byte_size, mime_type, content, staged_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`, [id, sha256, byteSize, i.mime_type, i.bytes, deps.now]);
  const key = docKey({ loan_id: i.loan_id ?? null, application_id: i.application_id ?? null });
  deps.events.append({ type: "document.staged", ...key, aggregate: { kind: "document", id }, actor: deps.actor, payload: { document_id: id, staged_at: deps.now, kind: i.kind, sha256, byte_size: byteSize, mime_type: i.mime_type, retention_class: i.retention_class, ...(i.loan_id ? { loan_id: i.loan_id } : {}), ...(i.application_id ? { application_id: i.application_id } : {}) } });
  let drain: DrainOutcome | null = null;
  if (!i.stage_only && !deps.blobs.outage) drain = await drainOne(deps, id);
  const row = (await readDocument(q, id))!;
  return { document_id: id, sha256, byte_size: byteSize, storage_status: row.storage_status, storage_uri: row.storage_uri, stored_generation: row.stored_generation, existing: false, drain };
}

export interface DrainOutcome { readonly document_id: string; readonly outcome: "stored" | "unavailable" | "hash_mismatch" | "skipped"; readonly storage_uri: string | null; readonly stored_generation: string | null; readonly attempts: number; readonly error: string | null; }

/** The drain of one staged row: put, re-read, compare, swap once (35.2 rule 4; edge case "a generation whose re-read hash differs"). */
export async function drainOne(deps: DocsDeps, documentId: string): Promise<DrainOutcome> {
  const q = deps.q;
  const d = await readDocument(q, documentId);
  if (!d || d.storage_status !== "staged") return { document_id: documentId, outcome: "skipped", storage_uri: d?.storage_uri ?? null, stored_generation: d?.stored_generation ?? null, attempts: 0, error: null };
  const blob = (await q.query<{ content: Buffer | null; mime_type: string; staged_at: string; drain_attempts: number }>(`SELECT content, mime_type, staged_at, drain_attempts FROM document_blobs WHERE document_id = $1`, [documentId]))[0];
  if (!blob?.content) return { document_id: documentId, outcome: "skipped", storage_uri: d.storage_uri, stored_generation: null, attempts: blob?.drain_attempts ?? 0, error: "no staged bytes (a foreign storage_uri)" };
  const bytes = Buffer.isBuffer(blob.content) ? blob.content : Buffer.from(blob.content);
  const fail = async (error: string): Promise<DrainOutcome> => {
    const attempts = blob.drain_attempts + 1;
    await q.query(`UPDATE document_blobs SET drain_attempts = $2, last_drain_error = $3 WHERE document_id = $1`, [documentId, attempts, error]);
    deps.events.append({ type: "document.drain.failed", ...docKey(d), aggregate: { kind: "document", id: documentId }, actor: deps.actor, payload: { document_id: documentId, attempts, error, at: deps.now } });
    if (attempts >= DRAIN_MAX_ATTEMPTS && deps.escalations) {
      deps.escalations.open({ kind: "sev2", ownerRole: "ops_analyst", severity: "2", ...docKey(d), payload: { document_id: documentId, attempts, error, rule: "35.2 edge case: after 5 attempts the drain raises ops_analyst; the staged copy remains the served copy" } }, deps.actor);
    }
    return { document_id: documentId, outcome: error === "STORE_UNAVAILABLE" ? "unavailable" : "hash_mismatch", storage_uri: d.storage_uri, stored_generation: null, attempts, error };
  };
  let uri: string;
  try { uri = await deps.blobs.put(documentId, { bytes, mime_type: blob.mime_type, filename: (d.metadata["filename"] as string | undefined) ?? null, stored_at: blob.staged_at }, q); }
  catch (e) { if (e instanceof AdapterUnavailable) return fail("STORE_UNAVAILABLE"); throw e; }
  let back: Awaited<ReturnType<typeof deps.blobs.get>>;
  try { back = await deps.blobs.get(documentId, q); } catch (e) { if (e instanceof AdapterUnavailable) return fail("STORE_UNAVAILABLE"); throw e; }
  if (!back || sha256Hex(back.bytes) !== d.sha256) return fail("HASH_MISMATCH_ON_PUT");
  const generation = uri.includes("#") ? uri.slice(uri.lastIndexOf("#") + 1) : "1";
  await q.query(`UPDATE documents SET storage_uri = $2, storage_status = 'stored', stored_generation = $3 WHERE id = $1`, [documentId, uri, generation]);
  await q.query(`UPDATE document_blobs SET drained_at = $2::timestamptz, drain_generation = $3 WHERE document_id = $1`, [documentId, deps.now, generation]);
  // edge case: a hold placed while the document was staged — the object hold is placed by the drain when the object exists
  if (d.legal_hold) { const ref = await deps.blobs.hold(documentId); await q.query(`UPDATE document_blobs SET hold_ref = $2 WHERE document_id = $1`, [documentId, ref]); }
  deps.events.append({ type: "document.stored", ...docKey(d), aggregate: { kind: "document", id: documentId }, actor: deps.actor, payload: { document_id: documentId, storage_uri: uri, stored_generation: generation, sha256: d.sha256, stored_at: deps.now } });
  return { document_id: documentId, outcome: "stored", storage_uri: uri, stored_generation: generation, attempts: blob.drain_attempts, error: null };
}

/** The drain over every staged row in scope (the sweep's pass; `documents.store{op: "drain"}` by hand): oldest first, at most `limit`. */
export async function drainStagedBlobs(deps: DocsDeps, scope: { loanId?: string; applicationId?: string } = {}, limit = 200): Promise<{ drained: number; failed: number; skipped: number; outcomes: DrainOutcome[] }> {
  const where = scope.loanId ? `AND d.loan_id = $2` : scope.applicationId ? `AND d.application_id = $2` : "";
  const params: unknown[] = [limit, ...(scope.loanId ? [scope.loanId] : scope.applicationId ? [scope.applicationId] : [])];
  const rows = await deps.q.query<{ id: string }>(`SELECT d.id FROM documents d JOIN document_blobs b ON b.document_id = d.id WHERE d.storage_status = 'staged' AND b.content IS NOT NULL AND b.drain_attempts < ${DRAIN_MAX_ATTEMPTS} ${where} ORDER BY d.created_at LIMIT $1`, params);
  const outcomes: DrainOutcome[] = [];
  let drained = 0, failed = 0, skipped = 0;
  for (const r of rows) {
    const o = await drainOne(deps, r.id); outcomes.push(o);
    if (o.outcome === "stored") drained++; else if (o.outcome === "skipped") skipped++; else failed++;
    if (o.outcome === "unavailable") break;   // the store is down: the rest stay staged until the next sweep
  }
  return { drained, failed, skipped, outcomes };
}

/** A helper for the routes that store outside the bus: hashes the bytes the way `storeDocument` will. */
export const hashOf = (bytes: Buffer | Uint8Array | string): string => sha256Hex(bytes);
export type { Queryable };
