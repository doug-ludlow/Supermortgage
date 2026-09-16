/**
 * §35.2 process-owned tools — the `security-records` agent's document, e-sign and mail tools
 * (spec/sections/35-operations-runtime/35-2-documents-and-artifacts.md "AI agent design"), defined with
 * `defineTools("35.2", "security-records", defs)` and spread by ./index.ts. Every tool string is one spec/registry/agents.json
 * names for 35.2; src/app/tools.test.ts refuses the rest. Every tool reads and writes on the command's own transaction
 * (`txOf` — 35.1's `ctx.q`, or the runtime's database before the seam), so what it writes commits with its decision record and
 * events, or not at all.
 *
 *   documents.store   act  {kind, bytes_base64 | sha256+byte_size+storage_uri, mime_type, retention_class, metadata?} → the row
 *                          staged in document_blobs (`document.staged`), drained inline when the store is reachable (`document.stored`);
 *                          {op: "drain", limit?} — the drain over the scope's staged rows (the sweep's pass, by hand).
 *   documents.hold    act  {op: "place", document_id, reason, matter_ref} — an agent or a human places; {op: "release", document_id,
 *                          reason, matter_ref?} — a human compliance/counsel actor releases (HOLD_RELEASE_HUMAN_ONLY).
 *   documents.dispose act  {document_id, disposal_run_id} — inside a 19.1 disposal run with the officer attestation only
 *                          (DISPOSE_NEEDS_OFFICER_ATTESTATION); a held or unverified row is refused.
 *   documents.verify  act  {op: "run", as_of_date?} — the daily integrity unit (global; SM_DOC_INTEGRITY_DAILY); {op: "one", document_id}
 *                          — one row re-read and hashed (VERIFY_STORED_BYTES_ONLY: never re-rendered).
 *   documents.open    read {document_id, purpose, party_id? | staff_user_id?, session_id?, ip?, user_agent?} → the bytes (base64), hash,
 *                          served_from and text layer; a `document_access_log` row; `document.opened`.
 *   esign.envelope.create act {kind, documents: [{document_id, required_fields}], signers, consent_ids?, owner_process?} on the
 *                          envelope's application or loan → a draft envelope with its `created` evidence row.
 *   esign.envelope.send   act {envelope_id} — an active E-SIGN consent per signer covering the kind (NO_ENVELOPE_WITHOUT_CONSENT), arms
 *                          SM_ESIGN_ENVELOPE_EXPIRY_30.
 *   esign.envelope.sign   act {envelope_id, document_id, signer_party_id, field_ids, auth: {method: session_l2|session_l3, session_id, ip,
 *                          user_agent, typed_name}} — a human party through its own L2+ session (NO_AGENT_SIGNS, SESSION_LEVEL); the last
 *                          required field completes the envelope (the signed row, the audit trail, `esign.envelope.completed`).
 *   esign.envelope.void   act {envelope_id, reason} — the owning process (or 7.4's withdrawal consumer); a terminal envelope refuses.
 *   mail.batch            act {notice_ids | notice_batch_id, mail_class?} (global) — one outbound manifest per batch: pieces, the hashed
 *                          manifest document, the print-mail outbox message (key = the batch id), SM_MAIL_MANIFEST_2BD armed.
 *   mail.manifest.ingest  act {manifest_id, source: vendor | analyst, pieces?} (global) — the proof-of-mailing file matched by
 *                          notice_id + attempt_no; notice_deliveries.mailed_at/imb/mail_manifest_id; the clock satisfied.
 *   mail.fallback         act {batch_id} (global) — the in-house manifest with one merged PDF per mail class and the ops_analyst
 *                          escalation to print and post (rule 10).
 *
 * Guardrails: BYTES_ARE_WRITE_ONCE, URI_SWAP_ONCE (the trigger's), VERIFY_STORED_BYTES_ONLY, HOLD_RELEASE_HUMAN_ONLY,
 * DISPOSE_NEEDS_OFFICER_ATTESTATION, NO_ENVELOPE_WITHOUT_CONSENT, NO_AGENT_SIGNS, NO_MONEY_FIELD, NO_PII_IN_DECISION.
 */
import { defineTools, compute, never, guard, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { hasRole } from "../roles.ts";
import { AGENT, PROCESS, RULE_SET_VERSION, need, txOf, inTx, blobsOf, isUuid, assertRetentionClass, DocumentsRefused, type DocsDeps } from "../../domain/operations-runtime/documents/shared.ts";
import { storeDocument, drainStagedBlobs } from "../../domain/operations-runtime/documents/store.ts";
import { placeHold, releaseHold } from "../../domain/operations-runtime/documents/hold.ts";
import { disposeDocument } from "../../domain/operations-runtime/documents/dispose.ts";
import { integrityRun, verifyOne } from "../../domain/operations-runtime/documents/integrity.ts";
import { openDocument, type OpenPurpose } from "../../domain/operations-runtime/documents/open.ts";
import { createEnvelope, sendEnvelope, signFields, voidEnvelope, type RequiredField, type SignerAuth } from "../../domain/operations-runtime/documents/esign.ts";
import { mailBatch, ingestManifest, mailFallback } from "../../domain/operations-runtime/documents/mail.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { docsDecision } from "../../domain/operations-runtime/documents/decision.ts";
import { render1098CopyB, boxesFromRow, SM_FILER, IRS_1098_TEMPLATE_CODE, IRS_1098_TEMPLATE_VERSION } from "../../domain/operations-runtime/documents/irs-1098.ts";
import { GlyphUnsupported } from "../../infra/files/pdf.ts";
import { RenderRefused } from "../../notices/service.ts";
import { retentionFor } from "../../runtime/documents/notice-sink.ts";
import { payloadHash } from "../../notices/render.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import type { Recipient, ChannelContext } from "../../notices/channel.ts";
import type { Runtime } from "../../runtime/app.ts";
import type { PgArtifactSink } from "../../runtime/documents/notice-sink.ts";

const has = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "";
const moneyKey = (k: string): boolean => /_cents$/.test(k) || /^(amount|cents|upb|balance)$/.test(k);
const namesMoney = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as Record<string, unknown>).some(moneyKey);

/** Rule 12: no money moves here — an input that names a money field (outside a render payload, which is the owning section's) is refused. */
export const NO_MONEY_FIELD = never("NO_MONEY_FIELD", "35.2 rule 12: 'No money moves here. No ledger set is posted by any 35.2 tool; the figures on a rendered page are the owning process's, reproduced to the cent and never recomputed'",
  (i) => namesMoney(i["changes"]) || namesMoney(i["data"]) || namesMoney(i["overrides"]) || Object.keys(i).some(moneyKey), "a 35.2 tool never writes or corrects a money field; a figure belongs to the owning section's command");
export const BYTES_ARE_WRITE_ONCE = never("BYTES_ARE_WRITE_ONCE", "35.2 guardrails: BYTES_ARE_WRITE_ONCE — a stored byte is never altered; a correction is a new document with supersedes_document_id",
  (i) => (has(i, "document_id") && (has(i, "bytes_base64") || has(i, "bytes"))) || i["replace"] === true || i["overwrite"] === true, "the bytes of an existing document are write-once; store a new document that supersedes it");
/** Rule 1: the integrity unit compares stored bytes to the recorded hash and never re-renders — an input asking for a re-render or carrying a payload/template is refused. */
export const VERIFY_STORED_BYTES_ONLY = never("VERIFY_STORED_BYTES_ONLY", "35.2 rule 1 / guardrails: VERIFY_STORED_BYTES_ONLY — the daily integrity unit re-reads and hashes stored bytes; it never re-renders, so a change of the writer, of node:zlib or of a template can never open a sev 1 on an old document",
  (i) => i["re_render"] === true || has(i, "payload") || has(i, "template_code"), "documents.verify compares stored bytes to documents.sha256; it takes no payload, template or re_render");
/** Rule 8: no agent ever signs — a signature field's actor is always a human party. */
export const NO_AGENT_SIGNS = guard("NO_AGENT_SIGNS", "35.2 rule 8: 'No agent ever signs (NO_AGENT_SIGNS); a signature field's actor is always a human party'",
  (_i, ctx) => (ctx.actor.kind !== "human" ? `${ctx.actor.kind}:${ctx.actor.id} may not sign; a signature is a human party's act through its own session` : undefined));
const OPEN_PURPOSES: ReadonlySet<string> = new Set(["borrower_view", "staff_view", "esign_view", "verify_portal", "evidence_pack", "integrity"]);
export const HOLD_RELEASE_HUMAN_ONLY = guard("HOLD_RELEASE_HUMAN_ONLY", "35.2 rule 5 / 19.1 AI agent design: holds.release is not allowed — human only (compliance or counsel)",
  (i, ctx) => (str(i, "op") === "release" && !(ctx.actor.kind === "human" && hasRole(ctx.actor, ["compliance", "counsel"])) ? `a hold is released by a human compliance or counsel actor; ${ctx.actor.kind}:${ctx.actor.id} may not` : undefined));

/** The command's document dependencies (transaction, store, events, escalations, actor, clock). */
export const depsOf = (ctx: CommandContext, rt: ToolRuntime): DocsDeps => ({ q: txOf(ctx, rt), blobs: blobsOf(rt), events: ctx.events, escalations: rt.escalations, actor: ctx.actor, now: ctx.now });
/** A handler-level refusal (a fact read from a row) rides the bus as a CommandRefused with the guardrail's code. */
export async function refusing<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof DocumentsRefused) throw new CommandRefused(tool, e.code, e.citation, e.message);
    if (e instanceof Error && /^(URI_SWAP_ONCE)/.test(e.message)) throw new CommandRefused(tool, "URI_SWAP_ONCE", "35.2 guardrails: URI_SWAP_ONCE — storage_uri changes once, from worm_pending:<id> to the stored URI", e.message);
    throw e;
  }
}
const scopeOf = (ctx: CommandContext): { loan_id: string | null; application_id: string | null } => ({ loan_id: ctx.loanId || null, application_id: ctx.applicationId ?? null });
const bytesOf = (i: ToolInput): Buffer | undefined => (typeof i["bytes_base64"] === "string" && i["bytes_base64"] ? Buffer.from(i["bytes_base64"], "base64") : Buffer.isBuffer(i["bytes"]) ? (i["bytes"] as Buffer) : undefined);

const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };

/** `documents.render`: a notice through the Notice Registry (the sink renders, stages/stores and links `notices.document_id`), or a document kind of 35.2's own (the 1098 Copy B). */
async function renderHandler(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  const kind = str(i, "document_kind");
  if (!kind) need(i, "template_code");
  if (kind === "irs_1098_copy_b") return render1098(i, ctx, rt);
  if (kind) throw new RangeError(`documents.render: document_kind ${kind} is not one 35.2 renders (irs_1098_copy_b) — a notice is rendered by template_code`);
  const notices = rt.notices; if (!notices) throw new PortUnavailable("notices");
  const runtime = runtimeOf(rt);
  const sink = rt.services["artifacts"] as PgArtifactSink | undefined;
  const templateCode = str(i, "template_code");
  const asOf = D(str(i, "as_of") || ctx.now.slice(0, 10));
  const version = runtime.noticeRegistry.activeVersion(templateCode, asOf);
  if (!version) throw new RangeError(`documents.render: no approved version of ${templateCode} in effect on ${asOf}`);
  const payload = (i["payload"] as Record<string, unknown> | undefined) ?? {};
  const s = scopeOf(ctx);
  // idempotency (edge case): the same payload rendered twice at this clock on this subject is one row — the existing id is rendered under again, never re-stored
  const hash = payloadHash(payload);
  const existing = (await txOf(ctx, rt).query<{ id: string }>(`SELECT id FROM documents WHERE template_code = $1 AND template_version = $2 AND payload_hash = $3 AND loan_id IS NOT DISTINCT FROM $4 AND application_id IS NOT DISTINCT FROM $5 AND created_at = $6::timestamptz LIMIT 1`, [templateCode, version.version, hash, s.loan_id, s.application_id, ctx.now]))[0];
  const documentId = existing?.id ?? sink?.idFor({ templateCode, version: version.version, payloadHash: hash, ...(s.loan_id ? { loanId: s.loan_id } : {}), ...(s.application_id ? { applicationId: s.application_id } : {}) });
  if (existing && sink) sink.knownIds.add(existing.id);
  let n;
  try {
    n = notices.render({ templateCode, ...(s.loan_id ? { loanId: s.loan_id } : {}), ...(s.application_id ? { applicationId: s.application_id } : {}), recipients: (i["recipients"] as readonly Recipient[] | undefined) ?? [], payload, asOf, ...(documentId ? { renderedDocumentId: documentId } : {}), ...(typeof i["case_id"] === "string" ? { caseId: i["case_id"] } : {}) });
  } catch (e) { if (e instanceof GlyphUnsupported || e instanceof RenderRefused) throw new CommandRefused("documents.render", "GLYPH_UNSUPPORTED", "35.2 rule 2: a payload character outside WinAnsi is refused naming the character and the block; nothing is silently substituted", e.message); throw e; }
  // a held notice (7.1: the checklist failed) is not sent: the answer says `held` with the reason, the rendered row and its bytes stay for the reviewer
  if (i["send"] === true && n.status !== "held") n = await notices.send(n.id, (i["channel_context"] as ChannelContext | undefined) ?? {});
  const retention = retentionFor(runtime.noticeRegistry.template(templateCode).retention);
  const pdf = n.renderedDocumentId ? sink?.results.get(n.renderedDocumentId) : undefined;
  return { document_id: n.renderedDocumentId ?? null, notice_id: n.id, status: n.status, held_reason: n.heldReason ?? null, template_code: templateCode, template_version: version.version, payload_hash: hash, existing: !!existing, retention_class: retention,
    ...(pdf ? { sha256: pdf.sha256, byte_size: pdf.byte_size, page_count: pdf.page_count, placements: pdf.placements } : {}), checklist_passed: n.checklist.passed, deliveries: n.deliveries.map((d) => ({ attempt_no: d.attemptNo, channel: d.channel, vendor: d.vendor, vendor_piece_id: d.vendorPieceId })) };
}
/** The Form 1098 Copy B from the tax_forms_1098 row (35.2 rule 11): stored as a documents row under tax_4y; the figures are 7.1's. */
async function render1098(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  need(i, "tax_form_1098_id", "payer", "direct_access_phone");
  const payer = i["payer"] as { name?: unknown; address?: unknown; tin_last4?: unknown };
  if (!payer || typeof payer !== "object" || typeof payer.name !== "string" || typeof payer.address !== "string" || typeof payer.tin_last4 !== "string") throw new RangeError("documents.render{irs_1098_copy_b}: payer {name, address, tin_last4} is required");
  const q = txOf(ctx, rt);
  const row = (await q.query<{ id: string; loan_id: string; tax_year: number; boxes: Record<string, unknown>; payer_party_id: string | null }>(`SELECT id, loan_id, tax_year, boxes, payer_party_id FROM tax_forms_1098 WHERE id = $1`, [str(i, "tax_form_1098_id")]))[0];
  if (!row) throw new RangeError(`documents.render{irs_1098_copy_b}: no tax_forms_1098 row ${str(i, "tax_form_1098_id")}`);
  const boxes = boxesFromRow(row.boxes);
  const copy = render1098CopyB({ tax_year: Number(row.tax_year), boxes, filer: SM_FILER, payer: { name: payer.name, address: payer.address, tin_last4: payer.tin_last4 }, direct_access_phone: str(i, "direct_access_phone"), account_last4: str(i, "account_last4") || "0000", now: ctx.now });
  const r = await inTx(ctx, rt, async (tq) => storeDocument({ ...depsOf(ctx, rt), q: tq }, { kind: "irs_1098_copy_b", bytes: copy.bytes, mime_type: "application/pdf", retention_class: "tax_4y", loan_id: row.loan_id, template_code: IRS_1098_TEMPLATE_CODE, template_version: IRS_1098_TEMPLATE_VERSION, payload_hash: copy.payload_hash, page_count: copy.page_count, text_layer: true, locale: "en", metadata: { title: `Form 1098 ${row.tax_year} Copy B`, tax_form_1098_id: row.id, tax_year: row.tax_year } }));
  ctx.events.append({ type: "document.rendered", loanId: row.loan_id, aggregate: { kind: "document", id: r.document_id }, actor: ctx.actor, payload: { document_id: r.document_id, template_code: IRS_1098_TEMPLATE_CODE, template_version: IRS_1098_TEMPLATE_VERSION, payload_hash: copy.payload_hash, sha256: r.sha256, byte_size: r.byte_size, page_count: copy.page_count, tax_form_1098_id: row.id } });
  return { document_id: r.document_id, sha256: r.sha256, byte_size: r.byte_size, page_count: copy.page_count, payload_hash: copy.payload_hash, storage_status: r.storage_status, retention_class: "tax_4y", placements: copy.placements, template_code: IRS_1098_TEMPLATE_CODE, template_version: IRS_1098_TEMPLATE_VERSION, tax_year: row.tax_year, box1_cents: boxes.box1_cents.toString(), box2_cents: boxes.box2_cents.toString(), existing: r.existing };
}

export const TOOLS_35_2: readonly ToolDef[] = defineTools(PROCESS, AGENT, [
  { name: "documents.render", kind: "act", ruleSetVersion: RULE_SET_VERSION, guardrails: [],
    handler: compute(async (i, ctx, rt) => refusing("documents.render", () => renderHandler(i, ctx, rt))),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return docsDecision({ subject: { kind: "document", id: String(o["document_id"] ?? "") }, action: "render", sha256: typeof o["sha256"] === "string" ? o["sha256"] : null, retention_class: typeof o["retention_class"] === "string" ? o["retention_class"] : str(i, "document_kind") === "irs_1098_copy_b" ? "tax_4y" : null, ...scopeOf(ctx), counts: { page_count: Number(o["page_count"] ?? 0) }, rationale: `rendered ${str(i, "document_kind") || str(i, "template_code")} ${String(o["template_version"] ?? "")} (payload ${String(o["payload_hash"] ?? "").slice(0, 12)}…)${o["notice_id"] ? ` for notice ${String(o["notice_id"])} (${String(o["status"])})` : ""}${o["existing"] === true ? "; idempotent: the row already existed at this clock" : ""}` }); } },
  { name: "documents.store", kind: "act", ruleSetVersion: RULE_SET_VERSION, guardrails: [NO_MONEY_FIELD, BYTES_ARE_WRITE_ONCE],
    handler: compute(async (i, ctx, rt) => refusing("documents.store", async () => {
      const op = str(i, "op") || "store";
      if (op === "drain") {
        const scope = { ...(ctx.loanId ? { loanId: ctx.loanId } : {}), ...(ctx.applicationId ? { applicationId: ctx.applicationId } : {}) };
        return inTx(ctx, rt, async (q) => { const r = await drainStagedBlobs({ ...depsOf(ctx, rt), q }, scope, typeof i["limit"] === "number" ? i["limit"] : 200); return { op: "drain", ...r }; });
      }
      if (op !== "store") throw new RangeError(`documents.store op ${op} is not store or drain`);
      need(i, "kind", "mime_type", "retention_class");
      assertRetentionClass(str(i, "retention_class"));
      const bytes = bytesOf(i);
      const s = scopeOf(ctx);
      return inTx(ctx, rt, async (q) => storeDocument({ ...depsOf(ctx, rt), q }, {
        ...(has(i, "id") && isUuid(i["id"]) ? { id: i["id"] as string } : {}), kind: str(i, "kind"), ...(bytes ? { bytes } : { sha256: str(i, "sha256"), byte_size: (Number.isInteger(i["byte_size"]) && Number(i["byte_size"]) > 0 ? Number(i["byte_size"]) : (() => { throw new RangeError("documents.store: a vendor-held artifact needs a positive integer byte_size"); })()), vendor_storage_uri: str(i, "storage_uri") }),
        mime_type: str(i, "mime_type"), retention_class: str(i, "retention_class"), loan_id: s.loan_id, application_id: s.application_id,
        metadata: (i["metadata"] as Record<string, unknown> | undefined) ?? {}, ...(typeof i["page_count"] === "number" ? { page_count: i["page_count"] } : {}),
        ...(has(i, "template_code") ? { template_code: str(i, "template_code"), template_version: str(i, "template_version") || null, payload_hash: str(i, "payload_hash") || null } : {}),
        ...(typeof i["text_layer"] === "boolean" ? { text_layer: i["text_layer"] } : {}), ...(has(i, "locale") ? { locale: str(i, "locale") } : {}),
        ...(has(i, "supersedes_document_id") ? { supersedes_document_id: str(i, "supersedes_document_id") } : {}), ...(i["stage_only"] === true ? { stage_only: true } : {}) }));
    })),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; const s = scopeOf(ctx);
      return o["op"] === "drain" ? docsDecision({ subject: { kind: "document", id: s.loan_id ?? s.application_id ?? "global" }, action: "drain", ...s, counts: { drained: Number(o["drained"] ?? 0), failed: Number(o["failed"] ?? 0), skipped: Number(o["skipped"] ?? 0) }, rationale: `drain of the scope's staged rows: ${String(o["drained"])} stored, ${String(o["failed"])} not yet (attempts counted), ${String(o["skipped"])} skipped` })
        : docsDecision({ subject: { kind: "document", id: String(o["document_id"] ?? "") }, action: "store", sha256: String(o["sha256"] ?? ""), retention_class: str(i, "retention_class"), hold: false, ...s, rationale: o["existing"] === true ? "idempotent: the same render at this clock already has its row" : `stored as ${String(o["storage_status"])} (${String(o["storage_uri"])})` }); } },
  { name: "documents.hold", kind: "act", ruleSetVersion: RULE_SET_VERSION, humanRoles: ["compliance", "counsel", "officer", "ops_analyst"], guardrails: [NO_MONEY_FIELD, HOLD_RELEASE_HUMAN_ONLY],
    handler: compute(async (i, ctx, rt) => refusing("documents.hold", async () => {
      const op = str(i, "op") || "place";
      need(i, "document_id", "reason");
      if (op === "place") { need(i, "matter_ref"); return inTx(ctx, rt, async (q) => placeHold({ ...depsOf(ctx, rt), q }, { document_id: str(i, "document_id"), reason: str(i, "reason"), matter_ref: str(i, "matter_ref") })); }
      if (op === "release") return inTx(ctx, rt, async (q) => releaseHold({ ...depsOf(ctx, rt), q }, { document_id: str(i, "document_id"), reason: str(i, "reason"), matter_ref: str(i, "matter_ref") || null }));
      throw new RangeError(`documents.hold op ${op} is not place or release`);
    })),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return docsDecision({ subject: { kind: "document", id: str(i, "document_id") }, action: `hold.${str(i, "op") || "place"}`, hold: o["legal_hold"] === true, ...scopeOf(ctx), counts: { open_matters: Array.isArray(o["open_matters"]) ? (o["open_matters"] as unknown[]).length : 0 }, rationale: `${str(i, "op") || "place"}: document_holds row ${String(o["hold_id"] ?? "")} by ${ctx.actor.kind}:${ctx.actor.id}${ctx.actor.role ? ` (${ctx.actor.role})` : ""}` }); } },
  { name: "documents.verify", kind: "act", ruleSetVersion: RULE_SET_VERSION, humanRoles: ["ops_analyst", "officer", "ciso"], guardrails: [NO_MONEY_FIELD, VERIFY_STORED_BYTES_ONLY],
    handler: compute(async (i, ctx, rt) => refusing("documents.verify", async () => {
      need(i, "op");
      const op = str(i, "op");
      if (op === "run") {
        if (ctx.loanId || ctx.applicationId) throw new RangeError("documents.verify{op: run} is the platform's daily unit: a global command (no loan, no application)");
        const deferWrite = rt.services["deferWrite"] as ((fn: (q: import("../../infra/db/client.ts").Queryable) => Promise<void>) => void) | undefined;
        if (!deferWrite) throw new PortUnavailable("service:deferWrite");
        const asOf = str(i, "as_of_date") || String(wallClock(Date.parse(ctx.now), "America/New_York").date);   // the environment day at 02:30 America/New_York
        if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new RangeError("as_of_date is YYYY-MM-DD");
        return inTx(ctx, rt, async (q) => { const r = await integrityRun({ ...depsOf(ctx, rt), q, deferWrite }, { as_of_date: asOf }); return { op: "run", ...r, findings: r.findings.map((f) => ({ document_id: f.document_id, finding: f.finding, expected_sha256: f.expected_sha256, actual_sha256: f.actual_sha256, escalation_id: f.escalation_id })) }; });
      }
      if (op === "one") { need(i, "document_id"); return inTx(ctx, rt, async (q) => ({ op: "one", ...(await verifyOne({ ...depsOf(ctx, rt), q }, { document_id: str(i, "document_id") })) })); }
      throw new RangeError(`documents.verify op ${op} is not run or one`);
    })),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>;
      return o["op"] === "run" ? docsDecision({ subject: { kind: "integrity_run", id: String(o["run_id"] ?? "") }, action: "verify", counts: { documents_checked: Number(o["documents_checked"] ?? 0), verified: Number(o["verified"] ?? 0), mismatches: Number(o["mismatches"] ?? 0), missing: Number(o["missing"] ?? 0), unreadable: Number(o["unreadable"] ?? 0), skipped_staged: Number(o["skipped_staged"] ?? 0), skipped_foreign: Number(o["skipped_foreign"] ?? 0) }, rationale: `integrity run ${String(o["as_of_date"])} (${String(o["scope"])}): every stored object re-read and hashed against documents.sha256; nothing re-rendered; report document ${String(o["report_document_id"] ?? "")}` })
        : docsDecision({ subject: { kind: "document", id: str(i, "document_id") }, action: "verify.one", ...scopeOf(ctx), sha256: typeof o["expected_sha256"] === "string" ? o["expected_sha256"] : null, rationale: `re-read and hashed: ${String(o["status"])}${o["escalation_id"] ? ` (sev 1 ${String(o["escalation_id"])} to ciso)` : ""}` }); } },
  { name: "documents.open", kind: "read", humanRoles: ["ops_analyst", "officer", "compliance", "ciso", "counsel"], guardrails: [],
    handler: compute(async (i, ctx, rt) => refusing("documents.open", async () => {
      need(i, "document_id", "purpose");
      const purpose = str(i, "purpose"); if (!OPEN_PURPOSES.has(purpose)) throw new RangeError(`documents.open purpose ${purpose} is not one the access log records`);
      const r = await openDocument({ q: txOf(ctx, rt), blobs: blobsOf(rt) }, { document_id: str(i, "document_id"), purpose: purpose as OpenPurpose, party_id: str(i, "party_id") || null, staff_user_id: str(i, "staff_user_id") || (ctx.actor.kind === "human" ? ctx.actor.id : null), session_id: str(i, "session_id") || null, ip: str(i, "ip") || null, user_agent: str(i, "user_agent") || null });
      if (r.kind === "unknown") throw new RangeError(`documents.open: no documents row ${str(i, "document_id")}`);
      if (r.kind === "tombstone") return { document_id: r.row.id, tombstone: true, sha256: r.sha256, disposal_run_id: r.disposal_run_id, disposed_at: r.disposed_at };
      if (r.kind === "unavailable") throw new DocumentsRefused("DOCUMENT_CONTENT_UNAVAILABLE", "35.2 rule 7: the viewer serves stored bytes — none are reachable for this row (the store is down and no staged copy remains)", `document ${r.row.id} has no readable bytes`);
      if (r.kind === "mismatch") throw new DocumentsRefused("INTEGRITY_FAILED", "35.2 rule 7: a served mismatch is refused INTEGRITY_FAILED and raises the same sev 1 as the daily run (documents.verify{op: one})", `document ${r.row.id}: expected ${r.expected_sha256}, read ${r.actual_sha256}`);
      ctx.events.append({ type: "document.opened", ...(r.row.loan_id ? { loanId: r.row.loan_id } : {}), ...(r.row.application_id ? { applicationId: r.row.application_id } : {}), aggregate: { kind: "document", id: r.row.id }, actor: ctx.actor, payload: { document_id: r.row.id, purpose, party_id: str(i, "party_id") || null, staff_user_id: str(i, "staff_user_id") || (ctx.actor.kind === "human" ? ctx.actor.id : null), sha256: r.sha256, byte_size: r.byte_size, served_from: r.served_from, access_log_id: r.access_log_id } });
      return { document_id: r.row.id, tombstone: false, mime_type: r.mime_type, sha256: r.sha256, byte_size: r.byte_size, served_from: r.served_from, text_layer: r.text, bytes_base64: r.bytes.toString("base64"), access_log_id: r.access_log_id, storage_status: r.row.storage_status, verify_status: r.row.verify_status };
    })) },
  { name: "esign.envelope.create", kind: "act", ruleSetVersion: RULE_SET_VERSION, guardrails: [NO_MONEY_FIELD],
    handler: compute(async (i, ctx, rt) => refusing("esign.envelope.create", async () => {
      need(i, "kind", "documents", "signers");
      const docs = i["documents"]; if (!Array.isArray(docs)) throw new RangeError("documents is a list of {document_id, required_fields}");
      const signers = i["signers"]; if (!Array.isArray(signers)) throw new RangeError("signers is a list of party ids");
      return inTx(ctx, rt, async (q) => createEnvelope({ ...depsOf(ctx, rt), q }, scopeOf(ctx), { kind: str(i, "kind"), ...(has(i, "owner_process") ? { owner_process: str(i, "owner_process") } : {}), documents: (docs as { document_id: string; required_fields?: RequiredField[] }[]).map((d) => ({ document_id: String(d.document_id), required_fields: d.required_fields ?? [] })), signers: (signers as unknown[]).map(String), ...(Array.isArray(i["consent_ids"]) ? { consent_ids: (i["consent_ids"] as unknown[]).map(String) } : {}), expires_on: str(i, "expires_on") || null, vendor_envelope_ref: str(i, "vendor_envelope_ref") || null }));
    })),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return docsDecision({ subject: { kind: "envelope", id: String(o["id"] ?? "") }, action: "envelope.create", ...scopeOf(ctx), retention_class: typeof o["retention_class"] === "string" ? o["retention_class"] : null, counts: { documents: Array.isArray(i["documents"]) ? (i["documents"] as unknown[]).length : 0, signers: Array.isArray(i["signers"]) ? (i["signers"] as unknown[]).length : 0 }, rationale: `draft ${str(i, "kind")} envelope for ${str(i, "owner_process") || "35.2"}` }); } },
  { name: "esign.envelope.send", kind: "act", ruleSetVersion: RULE_SET_VERSION, guardrails: [NO_MONEY_FIELD],
    handler: compute(async (i, ctx, rt) => refusing("esign.envelope.send", async () => { need(i, "envelope_id"); return inTx(ctx, rt, async (q) => sendEnvelope({ ...depsOf(ctx, rt), q }, { envelope_id: str(i, "envelope_id") })); })),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return docsDecision({ subject: { kind: "envelope", id: str(i, "envelope_id") }, action: "envelope.send", ...scopeOf(ctx), counts: { signers: Array.isArray(o["signer_party_ids"]) ? (o["signer_party_ids"] as unknown[]).length : 0, consents: Array.isArray(o["consent_ids"]) ? (o["consent_ids"] as unknown[]).length : 0 }, rationale: `sent: an active E-SIGN consent covers ${String(o["kind"] ?? "")} for every signer; expires ${String(o["expires_on"] ?? "")}` }); } },
  { name: "esign.envelope.sign", kind: "act", ruleSetVersion: RULE_SET_VERSION, humanRoles: ["borrower", "ops_analyst", "officer"], guardrails: [NO_MONEY_FIELD, NO_AGENT_SIGNS],
    handler: compute(async (i, ctx, rt) => refusing("esign.envelope.sign", async () => {
      need(i, "envelope_id", "document_id", "signer_party_id", "field_ids", "auth");
      const fields = i["field_ids"]; if (!Array.isArray(fields)) throw new RangeError("field_ids is a list");
      const auth = i["auth"] as SignerAuth; if (!auth || typeof auth !== "object" || typeof auth.method !== "string") throw new RangeError("auth {method, session_id, ip, user_agent, typed_name} is required");
      return inTx(ctx, rt, async (q) => signFields({ ...depsOf(ctx, rt), q }, { envelope_id: str(i, "envelope_id"), document_id: str(i, "document_id"), signer_party_id: str(i, "signer_party_id"), field_ids: (fields as unknown[]).map(String), auth }));
    })),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; const auth = (i["auth"] ?? {}) as { method?: string }; return docsDecision({ subject: { kind: "envelope", id: str(i, "envelope_id") }, action: "envelope.sign", ...scopeOf(ctx), counts: { fields_signed: Array.isArray(o["fields_signed"]) ? (o["fields_signed"] as unknown[]).length : 0, remaining: Number(o["remaining"] ?? 0) }, rationale: `fields ${Array.isArray(o["fields_signed"]) ? (o["fields_signed"] as unknown[]).join(", ") : ""} signed by a human party through ${String(auth.method ?? "")}${o["completed"] === true ? `; envelope completed, evidence ${String(o["evidence_document_id"] ?? "")}` : ""}` }); } },
  { name: "esign.envelope.void", kind: "act", ruleSetVersion: RULE_SET_VERSION, guardrails: [NO_MONEY_FIELD],
    handler: compute(async (i, ctx, rt) => refusing("esign.envelope.void", async () => { need(i, "envelope_id", "reason"); return inTx(ctx, rt, async (q) => voidEnvelope({ ...depsOf(ctx, rt), q }, { envelope_id: str(i, "envelope_id"), reason: str(i, "reason") })); })),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return docsDecision({ subject: { kind: "envelope", id: str(i, "envelope_id") }, action: "envelope.void", ...scopeOf(ctx), sha256: typeof o["evidence_sha256"] === "string" ? o["evidence_sha256"] : null, rationale: `voided (${str(i, "reason")}); the audit trail is document ${String(o["evidence_document_id"] ?? "")}` }); } },
  { name: "mail.batch", kind: "act", ruleSetVersion: RULE_SET_VERSION, guardrails: [NO_MONEY_FIELD],
    handler: compute(async (i, ctx, rt) => refusing("mail.batch", async () => {
      if (ctx.loanId || ctx.applicationId) throw new RangeError("mail.batch is a global command: a batch spans loans");
      if (!has(i, "notice_ids") && !has(i, "notice_batch_id")) need(i, "notice_ids");
      return inTx(ctx, rt, async (q) => mailBatch({ ...depsOf(ctx, rt), q }, { ...(Array.isArray(i["notice_ids"]) ? { notice_ids: (i["notice_ids"] as unknown[]).map(String) } : {}), notice_batch_id: str(i, "notice_batch_id") || null, mail_class: str(i, "mail_class") || null }));
    })),
    decision: (_i, output) => { const o = (output ?? {}) as Record<string, unknown>; return docsDecision({ subject: { kind: "manifest", id: String(o["manifest_id"] ?? "") }, action: "batch", sha256: typeof o["file_sha256"] === "string" ? o["file_sha256"] : null, retention_class: "corporate_7y", loan_id: null, application_id: null, counts: { pieces: Number(o["piece_count"] ?? 0), sheets: Number(o["sheet_count"] ?? 0) }, rationale: `outbound manifest for batch ${String(o["batch_id"] ?? "")}: ${String(o["piece_count"])} piece(s) to the print-mail adapter; SM_MAIL_MANIFEST_2BD armed` }); } },
  { name: "mail.manifest.ingest", kind: "act", ruleSetVersion: RULE_SET_VERSION, humanRoles: ["ops_analyst", "officer"], guardrails: [NO_MONEY_FIELD],
    handler: compute(async (i, ctx, rt) => refusing("mail.manifest.ingest", async () => {
      need(i, "manifest_id");
      const source = str(i, "source") || "vendor"; if (source !== "vendor" && source !== "analyst") throw new RangeError("source is vendor or analyst");
      return inTx(ctx, rt, async (q) => ingestManifest({ ...depsOf(ctx, rt), q }, rt.ports.printMail, { manifest_id: str(i, "manifest_id"), source, ...(Array.isArray(i["pieces"]) ? { pieces: i["pieces"] as { notice_id: string; attempt_no: number; mailed_on: string; imb?: string | null }[] } : {}) }));
    })),
    decision: (i, output) => { const o = (output ?? {}) as Record<string, unknown>; return docsDecision({ subject: { kind: "manifest", id: str(i, "manifest_id") }, action: "ingest", loan_id: null, application_id: null, counts: { pieces: Number(o["piece_count"] ?? 0), matched: Number(o["matched"] ?? 0), unmatched: Array.isArray(o["unmatched"]) ? (o["unmatched"] as unknown[]).length : 0, unmailed: Array.isArray(o["unmailed"]) ? (o["unmailed"] as unknown[]).length : 0 }, rationale: `proof of mailing (${str(i, "source") || "vendor"}) for manifest ${str(i, "manifest_id")}: ${o["reconciled"] === true ? "reconciled" : "not reconciled"}` }); } },
  { name: "mail.fallback", kind: "act", ruleSetVersion: RULE_SET_VERSION, humanRoles: ["ops_analyst", "officer"], guardrails: [NO_MONEY_FIELD],
    handler: compute(async (i, ctx, rt) => refusing("mail.fallback", async () => { need(i, "batch_id"); return inTx(ctx, rt, async (q) => mailFallback({ ...depsOf(ctx, rt), q }, { batch_id: str(i, "batch_id") })); })),
    decision: (i, output) => { const o = (output ?? {}) as Record<string, unknown>; return docsDecision({ subject: { kind: "manifest", id: String(o["manifest_id"] ?? "") }, action: "fallback", retention_class: "corporate_7y", loan_id: null, application_id: null, counts: { pieces: Number(o["piece_count"] ?? 0), merged: Array.isArray(o["merged"]) ? (o["merged"] as unknown[]).length : 0 }, rationale: `in-house manifest for batch ${str(i, "batch_id")}: one merged PDF per mail class; ops_analyst to print and post` }); } },
  { name: "documents.dispose", kind: "act", ruleSetVersion: RULE_SET_VERSION, humanRoles: ["officer", "compliance"], guardrails: [NO_MONEY_FIELD],
    handler: compute(async (i, ctx, rt) => refusing("documents.dispose", async () => { need(i, "document_id", "disposal_run_id"); return inTx(ctx, rt, async (q) => disposeDocument({ ...depsOf(ctx, rt), q }, { document_id: str(i, "document_id"), disposal_run_id: str(i, "disposal_run_id") })); })),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return docsDecision({ subject: { kind: "document", id: str(i, "document_id") }, action: "dispose", sha256: String(o["sha256"] ?? ""), ...scopeOf(ctx), rationale: `disposed under 19.1 run ${str(i, "disposal_run_id")} (officer attestation and WORM check on the log); the row is the tombstone` }); } },
]);
