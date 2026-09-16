/**
 * §35.2 rule 8 — the in-house e-sign envelope. An envelope is an electronic channel: `esign.envelope.send` requires, per
 * signer, an active E-SIGN consent whose scope covers the envelope kind (7.4's gate), records `sent` with the consent ids
 * and arms SM_ESIGN_ENVELOPE_EXPIRY_30; `esign.envelope.sign` requires an authenticated borrower session at L2 or above (or
 * the FAKE signer in tests) and writes one hash-chained `field_signed` event per field; the last required field completes
 * the envelope — the signed document (unsigned bytes + the per-field stamps + a signature page) is a new `documents` row that
 * supersedes the unsigned one, `signed_document_id` is written once, the audit-trail PDF (every event and the chain's head)
 * is the envelope's evidence, and `esign.envelope.completed` satisfies the clock. No agent ever signs (NO_AGENT_SIGNS).
 * A `completed` envelope is never voided; `esign.envelope.void` (the owning process, or `consent.esign.withdrawn` for a
 * signer) and the 30-day breach (`expired`) write the same audit trail and freeze the row.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import { canonicalJson } from "../../../notices/render.ts";
import { sha256Hex, stampPdf, appendPages, writePdf, type BlockInput } from "../../../infra/files/pdf.ts";
import { storeDocument } from "./store.ts";
import { documentBytes } from "./open.ts";
import { requireDocument, DocumentsRefused, type DocsDeps } from "./shared.ts";

export const ENVELOPE_KINDS = new Set(["disclosure_ack", "closing_ancillary", "consent", "servicing_agreement", "payoff_authorization", "other"]);
export const FIELD_KINDS = new Set(["signature", "initials", "date", "checkbox"]);
export const AUTH_METHODS = new Set(["session_l2", "session_l3", "otp_email", "otp_sms", "kba", "id_verified", "none"]);
export const TERMINAL = new Set(["completed", "declined", "voided", "expired"]);
export const ENVELOPE_EXPIRY_DAYS = 30;
export const EVIDENCE_KIND = "esign_audit_trail";
export const SIGNED_KIND = "signed_document";

export interface RequiredField { readonly field_id: string; readonly signer_party_id: string; readonly page: number; readonly kind: "signature" | "initials" | "date" | "checkbox"; }
export interface EnvelopeRow extends Record<string, unknown> {
  id: string; application_id: string | null; loan_id: string | null; owner_process: string; kind: string; vendor: string; status: string; signer_party_ids: string[]; consent_ids: string[]; created_by_actor: string;
  sent_at: string | null; completed_at: string | null; voided_at: string | null; void_reason: string | null; expires_on: string | null; evidence_document_id: string | null; evidence_sha256: string | null; chain_head: string | null; retention_class: string; created_at: string;
}
export interface EnvelopeDocumentRow extends Record<string, unknown> { id: string; envelope_id: string; sequence: number; document_id: string; required_fields: RequiredField[]; signed_document_id: string | null; signed_sha256: string | null; signed_at: string | null; }
export interface SignatureEventRow extends Record<string, unknown> {
  id: string; seq: string; envelope_id: string; document_id: string | null; signer_party_id: string | null; kind: string; at: string; auth_method: string; ip: string | null; user_agent: string | null; field_id: string | null; page: number | null; typed_name: string | null;
  document_sha256_at_event: string | null; prev_event_hash: string | null; event_hash: string; vendor_event_ref: string | null; payload: Record<string, unknown>;
}
export interface SignerAuth { readonly method: string; readonly session_id?: string | null; readonly ip?: string | null; readonly user_agent?: string | null; readonly typed_name?: string | null; }

const ENVELOPE_COLUMNS = "id, application_id, loan_id, owner_process, kind, vendor, status, signer_party_ids, consent_ids, created_by_actor, sent_at, completed_at, voided_at, void_reason, expires_on::text AS expires_on, evidence_document_id, evidence_sha256, chain_head, retention_class::text AS retention_class, created_at";
const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const envKey = (e: EnvelopeRow) => ({ ...(e.loan_id ? { loanId: e.loan_id } : {}), ...(e.application_id ? { applicationId: e.application_id } : {}) });
const retentionFor = (ownerProcess: string): string => (ownerProcess.startsWith("26.") ? "fnma_enote_signing_life_plus_7y" : "esign_consent_life_of_loan_plus_4y");
const plusDays = (iso: string, days: number): string => { const d = new Date(iso); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

export async function readEnvelope(q: Queryable, id: string): Promise<EnvelopeRow | undefined> { return (await q.query<EnvelopeRow>(`SELECT ${ENVELOPE_COLUMNS} FROM esign_envelopes WHERE id = $1`, [id]))[0]; }
export async function requireEnvelope(q: Queryable, id: string): Promise<EnvelopeRow> { if (!isUuid(id)) throw new RangeError(`envelope_id ${id} is not a uuid`); const e = await readEnvelope(q, id); if (!e) throw new RangeError(`no esign_envelopes row ${id}`); return e; }
export async function envelopeDocuments(q: Queryable, envelopeId: string): Promise<EnvelopeDocumentRow[]> { return q.query<EnvelopeDocumentRow>(`SELECT id, envelope_id, sequence, document_id, required_fields, signed_document_id, signed_sha256, signed_at FROM esign_envelope_documents WHERE envelope_id = $1 ORDER BY sequence`, [envelopeId]); }
export async function signatureEvents(q: Queryable, envelopeId: string): Promise<SignatureEventRow[]> { return q.query<SignatureEventRow>(`SELECT id, seq::text AS seq, envelope_id, document_id, signer_party_id, kind, at, auth_method, host(ip) AS ip, user_agent, field_id, page, typed_name, document_sha256_at_event, prev_event_hash, event_hash, vendor_event_ref, payload FROM esign_signature_events WHERE envelope_id = $1 ORDER BY seq`, [envelopeId]); }

// ───────── the chained evidence (A2-4.1-03) ─────────
export interface SignatureEventInput { readonly envelope_id: string; readonly document_id?: string | null; readonly signer_party_id?: string | null; readonly kind: string; readonly at: string; readonly auth_method: string; readonly ip?: string | null; readonly user_agent?: string | null; readonly field_id?: string | null; readonly page?: number | null; readonly typed_name?: string | null; readonly document_sha256_at_event?: string | null; readonly vendor_event_ref?: string | null; readonly payload?: Record<string, unknown>; }
const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)$/i;
/** The hashed view of an event: the row minus `event_hash` — every typed column exactly as stored, the payload the row carries and the vendor ref — chained through the previous row's hash. */
export function hashedView(i: SignatureEventInput, prev: string | null): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...(i.payload ?? {}) }; delete payload["hashed"];
  return { envelope_id: i.envelope_id, document_id: i.document_id ?? null, signer_party_id: i.signer_party_id ?? null, kind: i.kind, at: i.at, auth_method: i.auth_method, ip: i.ip ?? null, user_agent: i.user_agent ?? null, field_id: i.field_id ?? null, page: i.page ?? null, typed_name: i.typed_name ?? null, document_sha256_at_event: i.document_sha256_at_event ?? null, vendor_event_ref: i.vendor_event_ref ?? null, payload, prev_event_hash: prev };
}
export const eventHash = (hashed: Record<string, unknown>): string => sha256Hex(canonicalJson(hashed));
/** One append-only row: the hash covers the canonical JSON of `payload.hashed` (stored verbatim beside the typed columns) and chains to the previous row. */
export async function appendSignatureEvent(q: Queryable, i: SignatureEventInput): Promise<{ id: string; event_hash: string; prev_event_hash: string | null }> {
  if (!AUTH_METHODS.has(i.auth_method)) throw new RangeError(`auth_method ${i.auth_method} is not one the evidence records`);
  if (i.ip && !IP_RE.test(i.ip)) throw new RangeError(`ip ${i.ip} is not an address the evidence can store`);   // hash what is stored: never null an ip the chain would carry
  const env = (await q.query<{ retention_class: string }>(`SELECT retention_class::text AS retention_class FROM esign_envelopes WHERE id = $1`, [i.envelope_id]))[0];
  if (!env) throw new RangeError(`no esign_envelopes row ${i.envelope_id}`);
  const prev = (await q.query<{ event_hash: string }>(`SELECT event_hash FROM esign_signature_events WHERE envelope_id = $1 ORDER BY seq DESC LIMIT 1`, [i.envelope_id]))[0]?.event_hash ?? null;
  const hashed = hashedView(i, prev); const hash = eventHash(hashed);
  const r = await q.query<{ id: string }>(`INSERT INTO esign_signature_events (envelope_id, document_id, signer_party_id, kind, at, auth_method, ip, user_agent, field_id, page, typed_name, document_sha256_at_event, prev_event_hash, event_hash, vendor_event_ref, payload, retention_class) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::inet, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::retention_class) RETURNING id`,
    [i.envelope_id, i.document_id ?? null, i.signer_party_id ?? null, i.kind, i.at, i.auth_method, i.ip ?? null, i.user_agent ?? null, i.field_id ?? null, i.page ?? null, i.typed_name ?? null, i.document_sha256_at_event ?? null, prev, hash, i.vendor_event_ref ?? null, toJson({ ...(i.payload ?? {}), hashed }), env.retention_class]);
  return { id: r[0]!.id, event_hash: hash, prev_event_hash: prev };
}
/** The chain re-verified from the rows: every hash recomputes from its own `payload.hashed`, every link names the previous hash, every typed column and the payload agree with what was hashed, and the head is the one the envelope recorded when given. */
export function verifyChain(rows: readonly SignatureEventRow[], expectedHead?: string | null): { ok: boolean; head: string | null; count: number; failures: string[] } {
  const failures: string[] = []; let prev: string | null = null;
  for (const r of rows) {
    const hashed = (r.payload["hashed"] ?? null) as Record<string, unknown> | null;
    if (!hashed) { failures.push(`${r.id}: no hashed view`); continue; }
    if (eventHash(hashed) !== r.event_hash) failures.push(`${r.id}: event_hash does not recompute`);
    if ((hashed["prev_event_hash"] ?? null) !== prev || (r.prev_event_hash ?? null) !== prev) failures.push(`${r.id}: prev_event_hash does not chain`);
    for (const k of ["envelope_id", "document_id", "signer_party_id", "kind", "auth_method", "ip", "user_agent", "field_id", "typed_name", "document_sha256_at_event", "vendor_event_ref"] as const) if ((hashed[k] ?? null) !== (r[k] ?? null)) failures.push(`${r.id}: ${k} differs from the hashed view`);
    if ((hashed["page"] ?? null) !== (r.page === null || r.page === undefined ? null : Number(r.page))) failures.push(`${r.id}: page differs from the hashed view`);
    const stored: Record<string, unknown> = { ...r.payload }; delete stored["hashed"];
    if (canonicalJson(hashed["payload"] ?? {}) !== canonicalJson(stored)) failures.push(`${r.id}: payload differs from the hashed view`);
    if (Date.parse(String(hashed["at"])) !== Date.parse(r.at)) failures.push(`${r.id}: at differs from the hashed view`);
    prev = r.event_hash;
  }
  if (expectedHead !== undefined && expectedHead !== null && expectedHead !== prev) failures.push(`the chain's head ${prev ?? "none"} is not the recorded head ${expectedHead} (a truncated tail?)`);
  return { ok: failures.length === 0, head: prev, count: rows.length, failures };
}

// ───────── create / send ─────────
export interface CreateEnvelopeInput { readonly kind: string; readonly owner_process?: string; readonly documents: readonly { document_id: string; required_fields: readonly RequiredField[] }[]; readonly signers: readonly string[]; readonly consent_ids?: readonly string[]; readonly expires_on?: string | null; readonly vendor_envelope_ref?: string | null; }
export async function createEnvelope(deps: DocsDeps, key: { loan_id: string | null; application_id: string | null }, i: CreateEnvelopeInput): Promise<EnvelopeRow> {
  if (!key.loan_id && !key.application_id) throw new RangeError("35.2 esign.envelope.create needs an application or loan scope: the envelope's clocks belong to that subject");
  if (!ENVELOPE_KINDS.has(i.kind)) throw new RangeError(`envelope kind ${i.kind} is not one the spec names`);
  if (!i.documents.length) throw new RangeError("an envelope carries at least one document");
  if (!i.signers.length || !i.signers.every(isUuid)) throw new RangeError("signers are party uuids");
  for (const d of i.documents) {
    if (!isUuid(d.document_id)) throw new RangeError("documents[].document_id is a uuid");
    const row = await requireDocument(deps.q, d.document_id);
    if (row.storage_status === "disposed") throw new RangeError(`document ${d.document_id} was disposed`);
    if (row.mime_type !== "application/pdf" || row.render_engine !== "sm-pdf") throw new DocumentsRefused("UNSIGNABLE_DOCUMENT", "35.2 rule 8: the signed document is the unsigned bytes plus the per-field stamps and a signature page — only a PDF the platform's writer produced can carry them; a received file is signed by re-rendering it", `document ${d.document_id} is ${row.mime_type} rendered by ${row.render_engine ?? "another engine"}`);
    for (const f of d.required_fields ?? []) { if (!f.field_id || !FIELD_KINDS.has(f.kind) || !isUuid(f.signer_party_id) || !Number.isInteger(f.page) || f.page < 1) throw new RangeError(`required field ${String(f.field_id)} is malformed`); if (!i.signers.includes(f.signer_party_id)) throw new RangeError(`field ${f.field_id} names a signer who is not on the envelope`); if (row.page_count !== null && f.page > row.page_count) throw new RangeError(`field ${f.field_id} names page ${f.page} of a ${row.page_count}-page document`); }
    if ((d.required_fields ?? []).some((f, k, all) => all.findIndex((x) => x.field_id === f.field_id) !== k)) throw new RangeError(`document ${d.document_id} names a field id twice`);
  }
  const id = randomUUID(); const owner = i.owner_process ?? "35.2";
  const expiresOn = i.expires_on ?? plusDays(deps.now, ENVELOPE_EXPIRY_DAYS);
  await deps.q.query(`INSERT INTO esign_envelopes (id, application_id, loan_id, owner_process, kind, vendor, vendor_envelope_ref, status, signer_party_ids, consent_ids, created_by_actor, expires_on, retention_class, created_at) VALUES ($1, $2, $3, $4, $5, 'FAKE', $6, 'draft', $7::uuid[], $8::uuid[], $9, $10::date, $11::retention_class, $12::timestamptz)`,
    [id, key.application_id, key.loan_id, owner, i.kind, i.vendor_envelope_ref ?? null, [...i.signers], [...(i.consent_ids ?? [])], `${deps.actor.kind}:${deps.actor.id}`, expiresOn, retentionFor(owner), deps.now]);
  let seq = 0;
  for (const d of i.documents) await deps.q.query(`INSERT INTO esign_envelope_documents (envelope_id, sequence, document_id, required_fields) VALUES ($1, $2, $3, $4::jsonb)`, [id, ++seq, d.document_id, toJson(d.required_fields ?? [])]);
  await appendSignatureEvent(deps.q, { envelope_id: id, kind: "created", at: deps.now, auth_method: "none", payload: { document_ids: i.documents.map((d) => d.document_id), signer_party_ids: [...i.signers], created_by: `${deps.actor.kind}:${deps.actor.id}` } });
  const row = (await readEnvelope(deps.q, id))!;
  deps.events.append({ type: "esign.envelope.created", ...envKey(row), aggregate: { kind: "esign_envelope", id }, actor: deps.actor, payload: { envelope_id: id, kind: i.kind, owner_process: owner, document_ids: i.documents.map((d) => d.document_id), signer_party_ids: [...i.signers], expires_on: expiresOn } });
  return row;
}

/** Rule 8 / 7.4's gate: every signer holds an active E-SIGN consent whose scope covers the envelope kind — checked before any write. */
export async function consentsCovering(q: Queryable, e: EnvelopeRow): Promise<{ party_id: string; consent_id: string | null }[]> {
  const out: { party_id: string; consent_id: string | null }[] = [];
  for (const party of e.signer_party_ids) {
    const rows = await q.query<{ id: string }>(`SELECT id FROM consents WHERE kind = 'esign' AND status = 'active' AND granted AND revoked_at IS NULL AND party_id = $1 AND $2 = ANY(scope) ORDER BY (id = ANY($3::uuid[])) DESC, captured_at DESC LIMIT 1`, [party, e.kind, e.consent_ids]);   // the ids named at create are preferred, any active covering consent of the party serves
    out.push({ party_id: party, consent_id: rows[0]?.id ?? null });
  }
  return out;
}
export async function sendEnvelope(deps: DocsDeps, i: { envelope_id: string }): Promise<EnvelopeRow> {
  const e = await requireEnvelope(deps.q, i.envelope_id);
  if (TERMINAL.has(e.status)) throw new DocumentsRefused("ENVELOPE_TERMINAL", "35.2 state machine: a terminal envelope never changes; a correction is a new envelope", `envelope ${e.id} is ${e.status}`);
  if (e.status !== "draft") throw new RangeError(`envelope ${e.id} is already ${e.status}`);
  const covering = await consentsCovering(deps.q, e);
  const missing = covering.filter((c) => !c.consent_id);
  if (missing.length) throw new DocumentsRefused("NO_ENVELOPE_WITHOUT_CONSENT", "35.2 rule 8 / 7.4: esign.envelope.send requires, per signer, consents{kind=esign, status=active} whose scope covers the envelope kind — an envelope is an electronic channel", `no active E-SIGN consent covering ${e.kind} for ${missing.map((m) => m.party_id).join(", ")}; nothing written`);
  const consentIds = covering.map((c) => c.consent_id!);
  await deps.q.query(`UPDATE esign_envelopes SET status = 'sent', sent_at = $2::timestamptz, consent_ids = $3::uuid[] WHERE id = $1`, [e.id, deps.now, consentIds]);
  await appendSignatureEvent(deps.q, { envelope_id: e.id, kind: "sent", at: deps.now, auth_method: "none", payload: { consent_ids: consentIds, signer_party_ids: e.signer_party_ids, expires_on: e.expires_on } });
  const row = (await readEnvelope(deps.q, e.id))!;
  deps.events.append({ type: "esign.envelope.sent", ...envKey(row), aggregate: { kind: "esign_envelope", id: e.id }, actor: deps.actor, payload: { envelope_id: e.id, sent_at: deps.now, signer_party_ids: e.signer_party_ids, consent_ids: consentIds, expires_on: row.expires_on, kind: e.kind } });
  return row;
}

// ───────── sign ─────────
export interface SignInput { readonly envelope_id: string; readonly document_id: string; readonly signer_party_id: string; readonly field_ids: readonly string[]; readonly auth: SignerAuth; }
export interface SignResult { readonly envelope_id: string; readonly document_id: string; readonly status: string; readonly fields_signed: string[]; readonly remaining: number; readonly completed: boolean; readonly signed_document_ids: string[]; readonly evidence_document_id: string | null; readonly chain_head: string | null; }

async function assertSession(q: Queryable, auth: SignerAuth, signer: string, now: string): Promise<void> {
  if (auth.method !== "session_l2" && auth.method !== "session_l3") throw new DocumentsRefused("SESSION_LEVEL", "35.2 rule 8: esign.envelope.sign requires an authenticated borrower session at L2 or above (32.14)", `auth.method ${auth.method} is not a session`);
  if (!isUuid(auth.session_id)) throw new DocumentsRefused("SESSION_LEVEL", "35.2 rule 8: esign.envelope.sign requires an authenticated borrower session at L2 or above (32.14)", "auth.session_id is not a session id");
  const s = (await q.query<{ level: string; party_id: string; expires_at: string; revoked_at: string | null }>(`SELECT level, party_id, expires_at, revoked_at FROM sessions WHERE session_id = $1`, [auth.session_id]))[0];
  const claimed = auth.method === "session_l3" ? "L3" : "L2";
  if (!s || s.party_id !== signer || s.revoked_at || Date.parse(s.expires_at) <= Date.parse(now) || (claimed === "L3" ? s.level !== "L3" : s.level !== "L2" && s.level !== "L3")) throw new DocumentsRefused("SESSION_LEVEL", "35.2 rule 8: esign.envelope.sign requires an authenticated borrower session at L2 or above (32.14), the signer's own, unexpired and unrevoked — and the evidence names the level the session really holds", `session ${auth.session_id} does not authenticate ${signer} at ${claimed}`);
}

/** The signed document: the unsigned bytes with a stamp at every signed field and a signature page listing every field, signer, time and auth method. */
function signedRendering(unsigned: Buffer, events: readonly SignatureEventRow[], meta: { envelope_id: string; document_id: string; now: string }): { bytes: Buffer; page_count: number } {
  const signed = events.filter((e) => e.kind === "field_signed" && e.document_id === meta.document_id);
  const stamps = signed.map((e, k) => ({ page: e.page ?? 1, x: 306, y: 96 + (k % 12) * 14, text: `/s/ ${e.typed_name ?? e.signer_party_id ?? ""} — ${e.field_id ?? ""} — ${e.at}`, pt: 8, bold: true, block: `stamp:${e.field_id ?? k}` }));
  const stamped = stampPdf(unsigned, stamps, { creationDate: meta.now, idSeed: `signed:${meta.envelope_id}:${meta.document_id}:stamped` });
  const blocks: BlockInput[] = [
    { id: "signature_page", page: 1, yFraction: 0.04, pt: 14, bold: true, text: "Signature page" },
    { id: "signature_page_envelope", page: 1, yFraction: 0.09, pt: 9, bold: false, text: `Envelope ${meta.envelope_id} · document ${meta.document_id} · signed under the Supermortgage e-sign envelope (35.2 rule 8)` },
    ...signed.map((e, k) => ({ id: `signature_page_field_${e.field_id ?? k}`, page: 1, yFraction: 0.14 + k * 0.05, pt: 10, bold: false, text: `${e.field_id ?? ""} (page ${e.page ?? 1}) — signed by ${e.typed_name ?? ""} [party ${e.signer_party_id ?? ""}] at ${e.at} · auth ${e.auth_method} · ip ${e.ip ?? "n/a"} · ${e.user_agent ?? ""}` })),
  ];
  const out = appendPages(stamped.bytes, blocks, { creationDate: meta.now, idSeed: `signed:${meta.envelope_id}:${meta.document_id}` });
  return { bytes: out.bytes, page_count: out.page_count };
}
/** The audit-trail PDF: every signature event of the envelope and the hash chain's head. */
export function renderAuditTrail(e: EnvelopeRow, events: readonly SignatureEventRow[], now: string): { bytes: Buffer; page_count: number; head: string | null } {
  const chain = verifyChain(events);
  const blocks: BlockInput[] = [
    { id: "audit_header", page: 1, yFraction: 0.03, pt: 14, bold: true, text: `E-sign audit trail — envelope ${e.id}` },
    { id: "audit_envelope", page: 1, yFraction: 0.08, pt: 9, bold: false, text: `kind ${e.kind} · owner ${e.owner_process} · vendor ${e.vendor} · status ${e.status} · signers ${e.signer_party_ids.join(", ")} · consents ${e.consent_ids.join(", ") || "none"} · sent ${e.sent_at ?? "never"} · expires ${e.expires_on ?? "n/a"}${e.void_reason ? ` · ${e.status} because ${e.void_reason}` : ""}` },
    ...events.map((ev, k) => ({ id: `audit_event_${k + 1}`, page: 1, yFraction: 0.14 + k * 0.045, pt: 9, bold: false, text: `${k + 1}. ${ev.kind} at ${ev.at} · signer ${ev.signer_party_id ?? "—"} · document ${ev.document_id ?? "—"} · field ${ev.field_id ?? "—"}${ev.page ? ` p${ev.page}` : ""} · auth ${ev.auth_method} · ip ${ev.ip ?? "—"} · ua ${ev.user_agent ?? "—"} ${typeof ev.payload["reason"] === "string" ? ` · reason ${String(ev.payload["reason"])}` : ""} · hash ${ev.event_hash.slice(0, 16)}…` })),
    { id: "audit_chain", page: 1, yFraction: 0.14 + events.length * 0.045 + 0.02, pt: 9, bold: true, text: `Hash chain: ${events.length} events, head ${chain.head ?? "none"}, ${chain.ok ? "verified" : `BROKEN (${chain.failures.join("; ")})`} · rendered ${now}` },
  ];
  const w = writePdf({ blocks, title: `E-sign audit trail ${e.id}`, idSeed: `audit:${e.id}:${events.length}`, creationDate: now });
  return { bytes: w.bytes, page_count: w.page_count, head: chain.head };
}
async function storeEvidence(deps: DocsDeps, e: EnvelopeRow, now: string): Promise<{ document_id: string; sha256: string; head: string | null }> {
  const events = await signatureEvents(deps.q, e.id);
  const trail = renderAuditTrail(e, events, now);
  const stored = await storeDocument(deps, { kind: EVIDENCE_KIND, bytes: trail.bytes, mime_type: "application/pdf", retention_class: e.retention_class, loan_id: e.loan_id, application_id: e.application_id, page_count: trail.page_count, text_layer: true, locale: "en", metadata: { title: "E-sign audit trail", envelope_id: e.id, events: events.length, chain_head: trail.head } });
  return { document_id: stored.document_id, sha256: stored.sha256, head: trail.head };
}

export async function signFields(deps: DocsDeps, i: SignInput): Promise<SignResult> {
  if (deps.actor.kind !== "human") throw new DocumentsRefused("NO_AGENT_SIGNS", "35.2 rule 8: no agent ever signs — a signature field's actor is always a human party", `${deps.actor.kind}:${deps.actor.id} may not sign`);
  if (deps.actor.id !== i.signer_party_id) throw new RangeError("the signer is the acting party: actor.id must equal signer_party_id");
  const e = await requireEnvelope(deps.q, i.envelope_id);
  if (TERMINAL.has(e.status)) throw new DocumentsRefused("ENVELOPE_TERMINAL", "35.2 state machine: a terminal envelope never changes", `envelope ${e.id} is ${e.status}`);
  if (e.status === "draft") throw new RangeError(`envelope ${e.id} has not been sent`);
  if (!e.signer_party_ids.includes(i.signer_party_id)) throw new RangeError(`party ${i.signer_party_id} is not a signer of envelope ${e.id}`);
  await assertSession(deps.q, i.auth, i.signer_party_id, deps.now);
  const docs = await envelopeDocuments(deps.q, e.id);
  const doc = docs.find((d) => d.document_id === i.document_id); if (!doc) throw new RangeError(`document ${i.document_id} is not on envelope ${e.id}`);
  const unsigned = await requireDocument(deps.q, doc.document_id);
  const before = await signatureEvents(deps.q, e.id);
  const signedAlready = new Set(before.filter((x) => x.kind === "field_signed").map((x) => `${x.document_id}|${x.field_id}`));
  const mine = doc.required_fields.filter((f) => f.signer_party_id === i.signer_party_id);
  if (!i.field_ids.length) throw new RangeError("field_ids names at least one field");
  for (const f of i.field_ids) { const rf = mine.find((x) => x.field_id === f); if (!rf) throw new RangeError(`field ${f} is not a required field of ${i.signer_party_id} on document ${doc.document_id}`); if (signedAlready.has(`${doc.document_id}|${f}`)) throw new RangeError(`field ${f} is already signed`); }
  const common = { envelope_id: e.id, signer_party_id: i.signer_party_id, at: deps.now, auth_method: i.auth.method, ip: i.auth.ip ?? null, user_agent: i.auth.user_agent ?? null };
  const firstOfSigner = !before.some((x) => x.kind === "viewed" && x.signer_party_id === i.signer_party_id);
  if (firstOfSigner) {
    if (e.status === "sent") await deps.q.query(`UPDATE esign_envelopes SET status = 'in_progress' WHERE id = $1`, [e.id]);
    await appendSignatureEvent(deps.q, { ...common, kind: "viewed", document_id: doc.document_id, document_sha256_at_event: unsigned.sha256, payload: { session_id: i.auth.session_id ?? null } });
    await appendSignatureEvent(deps.q, { ...common, kind: "authenticated", document_id: doc.document_id, payload: { session_id: i.auth.session_id ?? null, level: i.auth.method === "session_l3" ? "L3" : "L2" } });
    await appendSignatureEvent(deps.q, { ...common, kind: "consent_affirmed", document_id: doc.document_id, payload: { consent_ids: e.consent_ids } });
    deps.events.append({ type: "esign.envelope.viewed", ...envKey(e), aggregate: { kind: "esign_envelope", id: e.id }, actor: deps.actor, payload: { envelope_id: e.id, document_id: doc.document_id, signer_party_id: i.signer_party_id, auth_method: i.auth.method } });
  }
  const signedNow: string[] = [];
  for (const f of i.field_ids) {
    const rf = mine.find((x) => x.field_id === f)!;
    await appendSignatureEvent(deps.q, { ...common, kind: "field_signed", document_id: doc.document_id, field_id: f, page: rf.page, typed_name: i.auth.typed_name ?? null, document_sha256_at_event: unsigned.sha256, payload: { field_kind: rf.kind } });
    signedNow.push(f);
    deps.events.append({ type: "esign.field.signed", ...envKey(e), aggregate: { kind: "esign_envelope", id: e.id }, actor: deps.actor, payload: { envelope_id: e.id, document_id: doc.document_id, signer_party_id: i.signer_party_id, field_id: f, field_kind: rf.kind, auth_method: i.auth.method } });
  }
  // completion: every required field of every signer on every document is signed
  const after = await signatureEvents(deps.q, e.id);
  const done = new Set(after.filter((x) => x.kind === "field_signed").map((x) => `${x.document_id}|${x.field_id}`));
  const remaining = docs.flatMap((d) => d.required_fields.filter((f) => !done.has(`${d.document_id}|${f.field_id}`)));
  if (remaining.length) return { envelope_id: e.id, document_id: doc.document_id, status: "in_progress", fields_signed: signedNow, remaining: remaining.length, completed: false, signed_document_ids: [], evidence_document_id: null, chain_head: after.at(-1)?.event_hash ?? null };
  const signedIds: string[] = [];
  for (const d of docs) {
    const row = await requireDocument(deps.q, d.document_id);
    const got = await documentBytes(deps.q, deps.blobs, row);
    if (!got) throw new DocumentsRefused("DOCUMENT_CONTENT_UNAVAILABLE", "35.2 rule 7: the signed rendering needs the unsigned bytes — none are reachable", `document ${d.document_id} has no readable bytes`);
    if (sha256Hex(got.bytes) !== row.sha256) throw new DocumentsRefused("INTEGRITY_FAILED", "35.2 rule 7: the unsigned bytes do not match their recorded hash", `document ${d.document_id}`);
    const rendered = signedRendering(got.bytes, after, { envelope_id: e.id, document_id: d.document_id, now: deps.now });
    const stored = await storeDocument(deps, { kind: SIGNED_KIND, bytes: rendered.bytes, mime_type: "application/pdf", retention_class: e.retention_class, loan_id: e.loan_id, application_id: e.application_id, page_count: rendered.page_count, text_layer: true, locale: row.locale ?? "en", supersedes_document_id: d.document_id, metadata: { title: `${String(row.metadata["title"] ?? row.kind)} (signed)`, envelope_id: e.id, unsigned_document_id: d.document_id } });
    await deps.q.query(`UPDATE esign_envelope_documents SET signed_document_id = $2, signed_sha256 = $3, signed_at = $4::timestamptz WHERE id = $1 AND signed_document_id IS NULL`, [d.id, stored.document_id, stored.sha256, deps.now]);
    signedIds.push(stored.document_id);
  }
  await appendSignatureEvent(deps.q, { ...common, kind: "completed", document_id: doc.document_id, payload: { signed_document_ids: signedIds } });
  const evidence = await storeEvidence(deps, { ...e, status: "completed", completed_at: deps.now }, deps.now);
  await deps.q.query(`UPDATE esign_envelopes SET status = 'completed', completed_at = $2::timestamptz, evidence_document_id = $3, evidence_sha256 = $4, chain_head = $5 WHERE id = $1`, [e.id, deps.now, evidence.document_id, evidence.sha256, evidence.head]);
  deps.events.append({ type: "esign.envelope.completed", ...envKey(e), aggregate: { kind: "esign_envelope", id: e.id }, actor: deps.actor, payload: { envelope_id: e.id, signed_document_ids: signedIds, evidence_document_id: evidence.document_id, evidence_sha256: evidence.sha256, chain_head: evidence.head, completed_at: deps.now } });
  return { envelope_id: e.id, document_id: doc.document_id, status: "completed", fields_signed: signedNow, remaining: 0, completed: true, signed_document_ids: signedIds, evidence_document_id: evidence.document_id, chain_head: evidence.head };
}

// ───────── void / expire / decline ─────────
export interface VoidResult { readonly envelope_id: string; readonly status: string; readonly reason: string; readonly evidence_document_id: string; readonly evidence_sha256: string; }
/** The terminal writes of a void, an expiry or a decline: the event, the audit trail, the frozen row. */
export async function closeEnvelope(deps: DocsDeps, i: { envelope_id: string; outcome: "voided" | "expired" | "declined"; reason: string; timer_id?: string | null; signer_party_id?: string | null }): Promise<VoidResult> {
  const e = await requireEnvelope(deps.q, i.envelope_id);
  if (TERMINAL.has(e.status)) throw new DocumentsRefused("ENVELOPE_TERMINAL", "35.2 state machine: a completed envelope is never voided; a terminal envelope never changes — a correction is a new envelope", `envelope ${e.id} is ${e.status}`);
  if (e.status === "draft") throw new RangeError(`envelope ${e.id} was never sent: a draft is not ${i.outcome}, it is simply never sent (a correction is a new envelope)`);
  await appendSignatureEvent(deps.q, { envelope_id: e.id, kind: i.outcome, at: deps.now, auth_method: "none", signer_party_id: i.signer_party_id ?? null, payload: { reason: i.reason, ...(i.timer_id ? { timer_id: i.timer_id } : {}), by: `${deps.actor.kind}:${deps.actor.id}` } });
  const evidence = await storeEvidence(deps, { ...e, status: i.outcome, voided_at: deps.now, void_reason: i.reason }, deps.now);
  await deps.q.query(`UPDATE esign_envelopes SET status = $2, voided_at = $3::timestamptz, void_reason = $4, evidence_document_id = $5, evidence_sha256 = $6, chain_head = $7 WHERE id = $1`, [e.id, i.outcome, deps.now, i.reason, evidence.document_id, evidence.sha256, evidence.head]);
  const type = i.outcome === "expired" ? "esign.envelope.expired" : i.outcome === "declined" ? "esign.envelope.declined" : "esign.envelope.voided";
  deps.events.append({ type, ...envKey(e), aggregate: { kind: "esign_envelope", id: e.id }, actor: deps.actor, payload: { envelope_id: e.id, reason: i.reason, ...(i.timer_id ? { timer_id: i.timer_id } : {}), evidence_document_id: evidence.document_id, owner_process: e.owner_process, kind: e.kind, signer_party_ids: e.signer_party_ids } });
  return { envelope_id: e.id, status: i.outcome, reason: i.reason, evidence_document_id: evidence.document_id, evidence_sha256: evidence.sha256 };
}
export const voidEnvelope = (deps: DocsDeps, i: { envelope_id: string; reason: string }): Promise<VoidResult> => closeEnvelope(deps, { envelope_id: i.envelope_id, outcome: "voided", reason: i.reason });
/** 7.4's consumer: `consent.esign.withdrawn` for a signer voids every open envelope the party is a signer of (an envelope is an electronic channel). */
export async function consumeConsentWithdrawn(deps: DocsDeps, i: { party_id: string; consent_id?: string | null }): Promise<VoidResult[]> {
  const rows = await deps.q.query<{ id: string }>(`SELECT id FROM esign_envelopes WHERE status IN ('sent', 'in_progress') AND $1 = ANY(signer_party_ids) ORDER BY created_at`, [i.party_id]);
  const out: VoidResult[] = [];
  for (const r of rows) out.push(await closeEnvelope(deps, { envelope_id: r.id, outcome: "voided", reason: "consent.esign.withdrawn", signer_party_id: i.party_id }));
  return out;
}
