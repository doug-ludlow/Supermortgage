/**
 * PgFakeBlobStore — the FAKE object store of every nonprod stage (35.2 Integrations "blob-store"; Discrepancy 4): its
 * bucket is the `document_blobs` table, so two runtime instances and the sweep job see the same bytes (the in-memory,
 * per-process `FakeBlobStore` in src/runtime/borrower/vendors/fake-blob-store.ts is what it replaces). `vendorName =
 * "fake-blob"`, `marker = "FAKE"`; `documents.storage_uri` becomes `fake-blob://<document_id>#<generation>` after the drain
 * verified the re-read hash (35.2 rule 4). Production swaps in a Cloud Storage port with the same shape (35.12).
 *
 * The port: `put(documentId, blob, q?)` writes the object (the staged row is the object — a put of a row that already
 * exists is the object write and returns its generation: `1 + drain_attempts`, so a retry after HASH_MISMATCH_ON_PUT
 * "retries with a new object name"); `get(documentId, q?)` reads it back; `hold`/`unhold` are the temporary object holds
 * (`FAKE:hold:<n>`); `delete(documentId, q)` is the crypto-shred of a disposal (content := NULL under the attested run's
 * `sm.disposal_run` setting, so the tombstone's bytes are gone in every stage).
 *
 * Test hooks (35.2 Integrations: "it honours holds and can be told to corrupt or lose one object for tests"): `outage`
 * (every put/get throws AdapterUnavailable — rows stay `staged`), `corrupt(id, bytes?)` (every later read returns altered
 * bytes), `lose(id)` (reads answer nothing), `corruptOnPut(id)` (the first read after the next put differs once — the drain
 * must not swap), `restore(id)`. The overlays are process-local on purpose: the bytes in the table are never altered by a
 * test, so a second runtime over the same database still reads the stored ones (T16).
 */
import type { Db, Queryable } from "../db/client.ts";
import { AdapterUnavailable } from "../integrations/failures.ts";
import type { BlobStorePort, StoredBlob } from "../../runtime/borrower/vendors/fake-blob-store.ts";

export type { BlobStorePort, StoredBlob };

/** The object store as 35.2 needs it: the borrower router's `BlobStorePort` plus generations, holds and the disposal delete. */
export interface ObjectStorePort extends BlobStorePort {
  readonly marker: "FAKE" | "LIVE";
  /** True while the store is declared unreachable (a FAKE outage; a live port's circuit breaker). */
  readonly outage: boolean;
  put(documentId: string, blob: StoredBlob, q?: Queryable): Promise<string>;
  get(documentId: string, q?: Queryable): Promise<StoredBlob | undefined>;
  /** The object store's temporary hold on the object; returns the store's hold acknowledgement (`FAKE:hold:<n>`). */
  hold(documentId: string): Promise<string>;
  unhold(documentId: string): Promise<void>;
  /** The disposal delete (crypto-shred where the bucket is CMEK); runs inside the attested run's transaction. */
  delete(documentId: string, q: Queryable): Promise<void>;
}

export const FAKE_BLOB_SCHEME = "fake-blob://";
export const WORM_PENDING = "worm_pending:";

interface BlobRow extends Record<string, unknown> { document_id: string; sha256: string; byte_size: bigint | number; mime_type: string; content: Buffer | null; staged_at: string; drain_attempts: number; drain_generation: string | null; filename: string | null; }

export class PgFakeBlobStore implements ObjectStorePort {
  readonly vendorName = "fake-blob";
  readonly marker = "FAKE" as const;
  outage = false;
  private readonly db: Db;
  private readonly tampered = new Map<string, Buffer>();
  private readonly lost = new Set<string>();
  private readonly corruptNextRead = new Set<string>();
  private readonly holds = new Map<string, string>();
  private readonly deleted = new Set<string>();
  private holdCounter = 0;
  /** Every put/get/hold the store answered — a test's evidence that the drain re-read the object. */
  readonly log: { op: "put" | "get" | "hold" | "unhold" | "delete"; document_id: string; at: number }[] = [];

  constructor(db: Db) { this.db = db; }

  private check(op: string): void { if (this.outage) throw new AdapterUnavailable("blob-store", "staged_blob", `blob-store unavailable (FAKE outage) — ${op}`); }

  /** The object write. The staged row (35.2 rule 4: written by `documents.store` in the command's transaction) is the object; a put for a document with no staged row stages it here (the borrower router's and the console's direct callers). */
  async put(documentId: string, blob: StoredBlob, q: Queryable = this.db): Promise<string> {
    this.check("put");
    const sha256 = sha256Hex(blob.bytes);
    await q.query(`INSERT INTO document_blobs (document_id, sha256, byte_size, mime_type, content, staged_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (document_id) DO NOTHING`, [documentId, sha256, blob.bytes.length, blob.mime_type, blob.bytes, blob.stored_at]);
    const row = (await q.query<{ drain_attempts: number; drain_generation: string | null }>(`SELECT drain_attempts, drain_generation FROM document_blobs WHERE document_id = $1`, [documentId]))[0];
    const generation = row?.drain_generation ?? String((row?.drain_attempts ?? 0) + 1);
    this.log.push({ op: "put", document_id: documentId, at: this.log.length });
    this.deleted.delete(documentId);
    return `${FAKE_BLOB_SCHEME}${documentId}#${generation}`;
  }

  async get(documentId: string, q: Queryable = this.db): Promise<StoredBlob | undefined> {
    this.check("get");
    this.log.push({ op: "get", document_id: documentId, at: this.log.length });
    if (this.lost.has(documentId) || this.deleted.has(documentId)) return undefined;
    const rows = await q.query<BlobRow>(`SELECT b.document_id, b.sha256, b.byte_size, b.mime_type, b.content, b.staged_at, b.drain_attempts, b.drain_generation, d.metadata->>'filename' AS filename FROM document_blobs b JOIN documents d ON d.id = b.document_id WHERE b.document_id = $1`, [documentId]);
    const r = rows[0];
    if (!r || !r.content) return undefined;
    let bytes: Buffer = Buffer.isBuffer(r.content) ? r.content : Buffer.from(r.content);
    if (this.tampered.has(documentId)) bytes = this.tampered.get(documentId)!;
    else if (this.corruptNextRead.has(documentId)) { this.corruptNextRead.delete(documentId); bytes = corruptBytes(bytes); }
    return { bytes, mime_type: r.mime_type, filename: r.filename ?? null, stored_at: r.staged_at };
  }

  async hold(documentId: string): Promise<string> {
    this.check("hold");
    const ref = this.holds.get(documentId) ?? `FAKE:hold:${++this.holdCounter}`;
    this.holds.set(documentId, ref);
    this.log.push({ op: "hold", document_id: documentId, at: this.log.length });
    return ref;
  }
  async unhold(documentId: string): Promise<void> { this.check("unhold"); this.holds.delete(documentId); this.log.push({ op: "unhold", document_id: documentId, at: this.log.length }); }
  /** The hold references the FAKE store currently honours (a test's evidence that the hold was placed). */
  heldObjects(): ReadonlyMap<string, string> { return this.holds; }

  /** The disposal delete: the row's bytes go (content := NULL is permitted by the document_blobs trigger only under `sm.disposal_run`, which the caller set on `q`); the FAKE also forgets the object so a read answers nothing. */
  async delete(documentId: string, q: Queryable): Promise<void> {
    this.check("delete");
    if (this.holds.has(documentId)) throw new RangeError(`blob-store: ${documentId} is under a temporary hold (${this.holds.get(documentId)}) and cannot be deleted`);
    await q.query(`UPDATE document_blobs SET content = NULL WHERE document_id = $1`, [documentId]);
    this.deleted.add(documentId);
    this.log.push({ op: "delete", document_id: documentId, at: this.log.length });
  }

  // ---- test hooks (35.2 Integrations: "can be told to corrupt or lose one object for tests")
  /** Every later read of the object returns `bytes` (default: the stored bytes with one byte flipped) — the daily integrity run must find the mismatch. */
  async corrupt(documentId: string, bytes?: Buffer): Promise<void> {
    if (bytes) { this.tampered.set(documentId, bytes); return; }
    const row = (await this.db.query<{ content: Buffer | null }>(`SELECT content FROM document_blobs WHERE document_id = $1`, [documentId]))[0];
    if (!row?.content) throw new RangeError(`blob-store: no object ${documentId} to corrupt`);
    this.tampered.set(documentId, corruptBytes(Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content)));
  }
  /** The next read after a put answers altered bytes once — the drain compares, refuses to swap and retries with a new generation. */
  corruptOnPut(documentId: string): void { this.corruptNextRead.add(documentId); }
  /** The object is gone from the bucket (the integrity run's `missing` finding). */
  lose(documentId: string): void { this.lost.add(documentId); }
  restore(documentId: string): void { this.tampered.delete(documentId); this.lost.delete(documentId); this.corruptNextRead.delete(documentId); }
}

function corruptBytes(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes);
  const i = Math.min(out.length - 1, 16);
  if (i >= 0) out[i] = (out[i]! + 1) & 0xff;
  return out;
}

import { createHash } from "node:crypto";
export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
