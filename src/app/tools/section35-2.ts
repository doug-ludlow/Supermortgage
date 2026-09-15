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
 *   (the render, open, verify, e-sign and mail tools follow in their commit groups)
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
import { docsDecision } from "../../domain/operations-runtime/documents/decision.ts";
import { render1098CopyB, boxesFromRow, SM_FILER, IRS_1098_TEMPLATE_CODE, IRS_1098_TEMPLATE_VERSION } from "../../domain/operations-runtime/documents/irs-1098.ts";
import { GlyphUnsupported } from "../../infra/files/pdf.ts";
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
  } catch (e) { if (e instanceof GlyphUnsupported) throw new CommandRefused("documents.render", "GLYPH_UNSUPPORTED", "35.2 rule 2: a payload character outside WinAnsi is refused naming the character and the block; nothing is silently substituted", e.message); throw e; }
  if (i["send"] === true) n = await notices.send(n.id, (i["channel_context"] as ChannelContext | undefined) ?? {});
  const pdf = n.renderedDocumentId ? sink?.results.get(n.renderedDocumentId) : undefined;
  return { document_id: n.renderedDocumentId ?? null, notice_id: n.id, status: n.status, held_reason: n.heldReason ?? null, template_code: templateCode, template_version: version.version, payload_hash: hash, existing: !!existing,
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
  return { document_id: r.document_id, sha256: r.sha256, byte_size: r.byte_size, page_count: copy.page_count, payload_hash: copy.payload_hash, storage_status: r.storage_status, placements: copy.placements, template_code: IRS_1098_TEMPLATE_CODE, template_version: IRS_1098_TEMPLATE_VERSION, tax_year: row.tax_year, box1_cents: boxes.box1_cents.toString(), box2_cents: boxes.box2_cents.toString(), existing: r.existing };
}

export const TOOLS_35_2: readonly ToolDef[] = defineTools(PROCESS, AGENT, [
  { name: "documents.render", kind: "act", ruleSetVersion: RULE_SET_VERSION, guardrails: [],
    handler: compute(async (i, ctx, rt) => refusing("documents.render", () => renderHandler(i, ctx, rt))),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return docsDecision({ subject: { kind: "document", id: String(o["document_id"] ?? "") }, action: "render", sha256: typeof o["sha256"] === "string" ? o["sha256"] : null, retention_class: str(i, "document_kind") === "irs_1098_copy_b" ? "tax_4y" : "life_of_loan_plus_4y", ...scopeOf(ctx), counts: { page_count: Number(o["page_count"] ?? 0) }, rationale: `rendered ${str(i, "document_kind") || str(i, "template_code")} ${String(o["template_version"] ?? "")} (payload ${String(o["payload_hash"] ?? "").slice(0, 12)}…)${o["notice_id"] ? ` for notice ${String(o["notice_id"])} (${String(o["status"])})` : ""}${o["existing"] === true ? "; idempotent: the row already existed at this clock" : ""}` }); } },
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
  { name: "documents.dispose", kind: "act", ruleSetVersion: RULE_SET_VERSION, humanRoles: ["officer", "compliance"], guardrails: [NO_MONEY_FIELD],
    handler: compute(async (i, ctx, rt) => refusing("documents.dispose", async () => { need(i, "document_id", "disposal_run_id"); return inTx(ctx, rt, async (q) => disposeDocument({ ...depsOf(ctx, rt), q }, { document_id: str(i, "document_id"), disposal_run_id: str(i, "disposal_run_id") })); })),
    decision: (i, output, ctx) => { const o = (output ?? {}) as Record<string, unknown>; return docsDecision({ subject: { kind: "document", id: str(i, "document_id") }, action: "dispose", sha256: String(o["sha256"] ?? ""), ...scopeOf(ctx), rationale: `disposed under 19.1 run ${str(i, "disposal_run_id")} (officer attestation and WORM check on the log); the row is the tombstone` }); } },
]);
