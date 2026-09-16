/**
 * FakeBlobStore — where borrower uploads' bytes live until an object store is wired. FAKE: in-memory, per process
 * (a second Cloud Run instance does not see it); `documents.storage_uri` is `fake-blob://<document_id>`. Swap: a
 * `BlobStorePort` over Cloud Storage (bucket per environment, CMEK, signed URLs minted by the service account) —
 * DEPLOY.md "Borrower API". Documents rendered by the Notice Registry are looked up here too; a miss answers
 * DOCUMENT_CONTENT_UNAVAILABLE rather than pretending.
 */
export interface StoredBlob { readonly bytes: Buffer; readonly mime_type: string; readonly filename: string | null; readonly stored_at: string; }
/** `q` (35.2): the caller's transaction when the object is written inside a command (the `documents` row is uncommitted on that connection); a store that keeps no table ignores it. */
export interface BlobStorePort { readonly vendorName: string; put(documentId: string, blob: StoredBlob, q?: unknown): Promise<string>; get(documentId: string, q?: unknown): Promise<StoredBlob | undefined>; }

export class FakeBlobStore implements BlobStorePort {
  readonly vendorName = "fake-blob";
  readonly marker = "FAKE" as const;
  readonly blobs = new Map<string, StoredBlob>();
  async put(documentId: string, blob: StoredBlob): Promise<string> { this.blobs.set(documentId, blob); return `fake-blob://${documentId}`; }
  async get(documentId: string): Promise<StoredBlob | undefined> { return this.blobs.get(documentId); }
}
