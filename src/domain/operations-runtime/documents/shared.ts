/**
 * §35.2 shared helpers — the command's transaction, refusals and the row shapes the documents tools share.
 *
 * `txOf(ctx, rt)` is the narrow port onto 35.1's persistence seam: after 35.1 the command context carries `q` (the
 * command's own transaction, everything a command reads or writes is inside it after the lock); before it, the runtime's
 * `db` rides on the services map. Both bases resolve here so the same handler code runs on either.
 */
import type { Queryable, Db } from "../../../infra/db/client.ts";
import type { CommandContext } from "../../../app/commands.ts";
import { PortUnavailable, type ToolInput, type ToolRuntime } from "../../../app/tools.ts";
import type { Actor, EventStore } from "../../../kernel/events/index.ts";
import type { ObjectStorePort } from "../../../infra/blobs/pg-fake-blob-store.ts";
import type { EscalationService } from "../../../app/escalations.ts";

export const PROCESS = "35.2";
export const AGENT = "security-records";
export const RULE_SET_VERSION = "docs.v1";
export const PROMPT_VERSION = "35.2-v1";
export const RENDER_ENGINE = "sm-pdf";

/** A refusal raised inside a handler once a row has been read (the bus-level guardrails only see the input); the tool layer maps it to `CommandRefused`. */
export class DocumentsRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, reason: string) { super(`${code}: ${reason}`); this.name = "DocumentsRefused"; this.code = code; this.citation = citation; }
}

export const dbOf = (rt: ToolRuntime): Db => { const d = rt.services["db"] as Db | undefined; if (!d) throw new PortUnavailable("service:db"); return d; };
/** The command's transaction (35.1 `ctx.q`) or, before the seam, the runtime's database. */
export const txOf = (ctx: CommandContext, rt: ToolRuntime): Queryable => (ctx as { q?: Queryable }).q ?? dbOf(rt);
/** Run `fn` on the command's transaction when there is one, else in a transaction of its own (HEAD: the pool). */
export const inTx = async <T>(ctx: CommandContext, rt: ToolRuntime, fn: (q: Queryable) => Promise<T>): Promise<T> => { const q = (ctx as { q?: Queryable }).q; return q ? fn(q) : dbOf(rt).tx(fn); };
export const blobsOf = (rt: ToolRuntime): ObjectStorePort => { const b = rt.services["blobs"] as ObjectStorePort | undefined; if (!b) throw new PortUnavailable("service:blobs"); return b; };

export const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`35.2: ${k} is required`); };
export const str = (i: Record<string, unknown>, k: string): string => (i[k] === undefined || i[k] === null ? "" : String(i[k]));
export const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const actorRef = (a: Actor): string => `${a.kind}:${a.id}${a.role ? `(${a.role})` : ""}`;

/** The `documents` columns the tools read. */
export interface DocumentRow extends Record<string, unknown> {
  id: string; loan_id: string | null; application_id: string | null; kind: string; sha256: string; byte_size: bigint | number; storage_uri: string; mime_type: string | null;
  retention_class: string; legal_hold: boolean; metadata: Record<string, unknown>; created_at: string; page_count: number | null; supersedes_document_id: string | null;
  storage_status: "staged" | "stored" | "disposed"; stored_generation: string | null; render_engine: string | null; render_version: string | null; template_code: string | null; template_version: string | null;
  payload_hash: string | null; text_layer: boolean | null; locale: string | null; last_verified_at: string | null; verify_status: "unverified" | "verified" | "mismatch" | "missing"; disposed_at: string | null; disposal_run_id: string | null;
}
export const DOCUMENT_COLUMNS = "id, loan_id, application_id, kind, sha256, byte_size, storage_uri, mime_type, retention_class::text AS retention_class, legal_hold, metadata, created_at, page_count, supersedes_document_id, storage_status, stored_generation, render_engine, render_version, template_code, template_version, payload_hash, text_layer, locale, last_verified_at, verify_status, disposed_at, disposal_run_id";
export async function readDocument(q: Queryable, id: string): Promise<DocumentRow | undefined> {
  if (!isUuid(id)) throw new RangeError(`35.2: document_id must be a uuid (got ${JSON.stringify(id)})`);
  return (await q.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`, [id]))[0];
}
export async function requireDocument(q: Queryable, id: string): Promise<DocumentRow> { const d = await readDocument(q, id); if (!d) throw new RangeError(`35.2: no document ${id}`); return d; }

/** The dependencies every documents operation takes: the transaction, the object store, the command's event store, its escalations, actor and clock. */
export interface DocsDeps { readonly q: Queryable; readonly blobs: ObjectStorePort; readonly events: EventStore; readonly escalations?: EscalationService; readonly actor: Actor; readonly now: string; }

/** The event key of a document: its loan, its application, or neither (the aggregate is always the document). */
export const docKey = (d: { loan_id: string | null; application_id: string | null }): { loanId?: string; applicationId?: string } => ({ ...(d.loan_id ? { loanId: d.loan_id } : {}), ...(d.application_id ? { applicationId: d.application_id } : {}) });

/** Retention classes the migrations define (db/migrations: 0001, 0003, 0005, 0008, 0020, 0059, 0064, 0065, 0073, 0094) — a class outside this set is refused before any row is written. */
export const RETENTION_CLASSES: ReadonlySet<string> = new Set(["life_of_loan_plus_4y", "respa_5y", "regz_2y", "ecoa_25m", "glba_5y", "permanent", "tpsc_2y_post_revocation", "corporate_7y", "fcra_furnishing_5y", "security_logs_5y", "regx_1y_post_transfer", "regulatory_correspondence_7y",
  "tcpa_consent_4y", "tax_4y", "privacy_notice_5y", "esign_consent_life_of_loan_plus_4y", "unclaimed_property_10y", "court_record_7y", "transfer_out_archive", "ai_governance_7y", "fnma_reporting_7y", "nydfs_500_17b_cert_support_5y", "fcra",
  "regz_le_3y", "regz_cd_5y", "regz_atr_3y", "regb_25m", "hmda_3y", "respa_afba_5y", "fdpa_life_of_loan", "fnma_loan_file_life_plus_4y", "ron_recording_state_ny", "esign_consent_life", "bsa_sar_5y", "fnma_enote_signing_life_plus_7y"]);
export function assertRetentionClass(c: string): void { if (!RETENTION_CLASSES.has(c)) throw new RangeError(`35.2: retention_class ${c} is not a class the retention matrix defines`); }

/** The upload allow-list (edge case: "larger than 25 MB or with a MIME type outside {pdf, jpeg, png, tiff} → UNSUPPORTED_ARTIFACT before any row is written"). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_MIME_TYPES: ReadonlySet<string> = new Set(["application/pdf", "image/jpeg", "image/png", "image/tiff"]);
