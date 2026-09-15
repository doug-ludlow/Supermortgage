/**
 * 23.6 — the emitted document on disk and on the bus: a `documents` row holding the bytes (kind
 * du_specification_document, retention fnma_loan_file_life_plus_4y, Fannie Mae-confidential, never borrower-deliverable),
 * a `du_documents` row (db/migrations/0135_du_documents.sql) carrying the hash and the counts, and the
 * `du.document.emitted{sha256, container_count, relationship_count}` event 23.7 arms `SM_DU_PREFLIGHT_GATE` on. A
 * refusal writes nothing here and appends `du.document.refused{code, path}` instead (23.6 Data model "Baseline tables
 * written"; T4). `assembleDuDocument` (emit.ts) is pure; this file is the only writer of either table, and the two bus
 * paths — 23.1's buildDuRequest and 23.6's own assembleDuDocument tool (src/app/tools/section23-1.ts, section23-6.ts) —
 * both come through it.
 */
import { randomUUID } from "node:crypto";
import { toJson, type Queryable } from "../../../infra/db/client.ts";
import type { Actor, DomainEvent, EventStore } from "../../../kernel/events/index.ts";
import { assembleDuDocument, DU_MISMO_BUILD, DU_SPEC_VERSION, DuEmitError, type AssembleOptions, type DuCasefileInput, type DuDocument, type DuGraph, type DuSubmissionInput } from "./emit.ts";

export const DU_DOCUMENT_KIND = "du_specification_document";
export const DU_DOCUMENT_RETENTION = "fnma_loan_file_life_plus_4y";
export const DU_DOCUMENT_EMITTED = "du.document.emitted";
export const DU_DOCUMENT_REFUSED = "du.document.refused";
export const UNDERWRITER: Actor = { kind: "agent", id: "underwriter" };

export interface PersistDuDocumentInput {
  readonly application_id: string;
  readonly casefile_id: string;
  readonly submission_number: number;
  /** The du_submissions row once 23.1 has recorded it; null before (0135: nullable until then). */
  readonly submission_id?: string | null;
  readonly document: DuDocument;
  readonly emitted_at: string;
  /** The `documents` row id 23.1 minted for the request (`DuRequest.document_id`); a fresh one when absent. */
  readonly document_id?: string;
  readonly du_document_id?: string;
}

export interface PersistedDuDocument {
  readonly document_id: string;
  readonly du_document_id: string;
  readonly sha256: string;
  readonly byte_size: number;
  readonly emitted_at: string;
}

/** The XML bytes as a `documents` row (the text in metadata.xml beside its hash — where 32.2 keeps a letter's text) and the `du_documents` row. Same transaction as the caller's. */
export async function persistDuDocument(q: Queryable, i: PersistDuDocumentInput): Promise<PersistedDuDocument> {
  const document_id = i.document_id ?? randomUUID();
  const du_document_id = i.du_document_id ?? randomUUID();
  const xml = new TextDecoder().decode(i.document.bytes);
  const s = i.document.stats;
  const required_missing = i.document.gaps.length;
  await q.query(
    `INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, application_id, retention_class, metadata) VALUES ($1, $2, $3, $4, $5, 'application/xml', $6, $7, $8::jsonb)`,
    [document_id, DU_DOCUMENT_KIND, i.document.sha256, i.document.bytes.byteLength, `du://documents/${document_id}`, i.application_id, DU_DOCUMENT_RETENTION,
      toJson({ title: `DU Specification document — casefile ${i.casefile_id}, submission ${i.submission_number}`, xml, spec_version: DU_SPEC_VERSION, mismo_build: DU_MISMO_BUILD, casefile_id: i.casefile_id, submission_number: i.submission_number, container_count: s.container_count, relationship_count: s.relationship_count, borrower_count: s.borrower_count, required_missing, gaps: i.document.gaps, borrower_deliverable: false, confidential_to: "fannie_mae" })]);
  await q.query(
    `INSERT INTO du_documents (id, application_id, casefile_id, submission_id, document_id, sha256, spec_version, mismo_build, container_count, relationship_count, borrower_count, required_missing, emitted_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [du_document_id, i.application_id, i.casefile_id, i.submission_id ?? null, document_id, Buffer.from(i.document.sha256, "hex"), DU_SPEC_VERSION, DU_MISMO_BUILD, s.container_count, s.relationship_count, s.borrower_count, required_missing, i.emitted_at]);
  return { document_id, du_document_id, sha256: i.document.sha256, byte_size: i.document.bytes.byteLength, emitted_at: i.emitted_at };
}

export interface DuDocumentRow {
  readonly du_document_id: string; readonly application_id: string; readonly casefile_id: string; readonly submission_id: string | null; readonly document_id: string;
  readonly sha256: string; readonly spec_version: string; readonly mismo_build: string; readonly container_count: number; readonly relationship_count: number; readonly borrower_count: number; readonly required_missing: number;
  readonly emitted_at: string; readonly byte_size: number; readonly xml: string;
  /** From the documents row's metadata (0129 keeps no column for it): the submission the document was assembled for. */
  readonly submission_number: number;
}

/** One emitted document by its du_documents id, its documents id, or the latest for an application. */
export async function readDuDocument(q: Queryable, by: { du_document_id?: string | null; document_id?: string | null; application_id?: string | null }): Promise<DuDocumentRow | null> {
  const where = by.du_document_id ? ["d.id = $1", by.du_document_id] : by.document_id ? ["d.document_id = $1", by.document_id] : by.application_id ? ["d.application_id = $1", by.application_id] : null;
  if (!where) throw new RangeError("readDuDocument needs du_document_id, document_id or application_id");
  const rows = await q.query<Record<string, unknown>>(
    `SELECT d.id::text AS du_document_id, d.application_id::text AS application_id, d.casefile_id, d.submission_id::text AS submission_id, d.document_id::text AS document_id, encode(d.sha256, 'hex') AS sha256, d.spec_version, d.mismo_build,
            d.container_count, d.relationship_count, d.borrower_count, d.required_missing, d.emitted_at::text AS emitted_at, doc.byte_size, doc.metadata->>'xml' AS xml, (doc.metadata->>'submission_number')::int AS submission_number
       FROM du_documents d JOIN documents doc ON doc.id = d.document_id WHERE ${where[0]} ORDER BY d.emitted_at DESC, d.created_at DESC LIMIT 1`, [where[1]]);
  const r = rows[0];
  if (!r) return null;
  return { du_document_id: String(r["du_document_id"]), application_id: String(r["application_id"]), casefile_id: String(r["casefile_id"]), submission_id: r["submission_id"] === null ? null : String(r["submission_id"]), document_id: String(r["document_id"]), sha256: String(r["sha256"]), spec_version: String(r["spec_version"]), mismo_build: String(r["mismo_build"]),
    container_count: Number(r["container_count"]), relationship_count: Number(r["relationship_count"]), borrower_count: Number(r["borrower_count"]), required_missing: Number(r["required_missing"]), emitted_at: String(r["emitted_at"]), byte_size: Number(r["byte_size"]), xml: String(r["xml"] ?? ""), submission_number: Number(r["submission_number"] ?? 0) };
}

export interface EmittedInput { readonly application_id: string; readonly casefile_id: string; readonly submission_number: number; readonly submission_id?: string | null; readonly document_id: string; readonly du_document_id: string; readonly document: DuDocument; readonly emitted_at: string; }

/** `du.document.emitted{sha256, container_count, relationship_count}` — with `application_id` and `emitted_at` in the payload, which 23.7's `SM_DU_PREFLIGHT_GATE` arms on and anchors to (timers-23-7.ts). */
export function emitDuDocumentEmitted(events: EventStore, i: EmittedInput, actor: Actor = UNDERWRITER): DomainEvent {
  const s = i.document.stats;
  return events.append({ type: DU_DOCUMENT_EMITTED, applicationId: i.application_id, aggregate: { kind: "du_documents", id: i.du_document_id }, actor, occurredAt: i.emitted_at, payload: {
    application_id: i.application_id, casefile_id: i.casefile_id, submission_number: i.submission_number, submission_id: i.submission_id ?? null, document_id: i.document_id, du_document_id: i.du_document_id,
    sha256: i.document.sha256, spec_version: DU_SPEC_VERSION, mismo_build: DU_MISMO_BUILD, container_count: s.container_count, relationship_count: s.relationship_count, borrower_count: s.borrower_count, disputed_arcs_skipped: s.disputed_arcs_skipped,
    required_missing: i.document.gaps.length, gaps: i.document.gaps.map((g) => ({ code: g.code, path: g.xpath })), emitted_at: i.emitted_at, retention_class: DU_DOCUMENT_RETENTION, borrower_deliverable: false,
  } });
}

/** `du.document.refused{code, path}` — no bytes were written (T4). */
export function emitDuDocumentRefused(events: EventStore, i: { application_id: string; casefile_id: string; submission_number: number; error: DuEmitError; at: string }, actor: Actor = UNDERWRITER): DomainEvent {
  return events.append({ type: DU_DOCUMENT_REFUSED, applicationId: i.application_id, aggregate: { kind: "du_casefiles", id: i.casefile_id }, actor, occurredAt: i.at, payload: {
    application_id: i.application_id, casefile_id: i.casefile_id, submission_number: i.submission_number, code: i.error.code, path: i.error.xpath, detail: i.error.detail, documents_row_written: false,
  } });
}

export interface EmitDuDocumentInput {
  readonly graph: DuGraph;
  readonly casefile: DuCasefileInput;
  readonly submission: DuSubmissionInput;
  readonly submission_id?: string | null;
  readonly document_id?: string;
  readonly emitted_at: string;
  readonly options?: AssembleOptions;
  readonly actor?: Actor;
}
export interface EmittedDuDocument extends PersistedDuDocument { readonly document: DuDocument; readonly event: DomainEvent; }

/**
 * The whole 23.6 path in one call: assemble (rules 1–5, 8), persist the bytes and the du_documents row in the caller's
 * transaction, append `du.document.emitted`. A `DuEmitError` appends `du.document.refused{code, path}` and is rethrown
 * before anything is written (T4). `q` null means no database in this runtime: the document is assembled and the event
 * appended, and nothing persists (the 23.1 unit harness).
 */
export async function emitDuDocument(q: Queryable | null, events: EventStore, i: EmitDuDocumentInput): Promise<EmittedDuDocument> {
  const actor = i.actor ?? UNDERWRITER;
  let document: DuDocument;
  try {
    document = assembleDuDocument(i.graph, i.casefile, i.submission, i.options ?? {});
  } catch (e) {
    if (e instanceof DuEmitError) emitDuDocumentRefused(events, { application_id: i.graph.application_id, casefile_id: i.casefile.casefile_id, submission_number: i.submission.submission_number, error: e, at: i.emitted_at }, actor);
    throw e;
  }
  const document_id = i.document_id ?? randomUUID();
  const du_document_id = randomUUID();
  const base = { application_id: i.graph.application_id, casefile_id: i.casefile.casefile_id, submission_number: i.submission.submission_number, submission_id: i.submission_id ?? null, document, document_id, du_document_id, emitted_at: i.emitted_at };
  const persisted: PersistedDuDocument = q ? await persistDuDocument(q, base) : { document_id, du_document_id, sha256: document.sha256, byte_size: document.bytes.byteLength, emitted_at: i.emitted_at };
  const event = emitDuDocumentEmitted(events, base, actor);
  return { ...persisted, document, event };
}
