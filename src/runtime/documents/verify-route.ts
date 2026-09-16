/**
 * §35.2 / 16.1 rule 9 — the payoff verification portal, `GET /verify/{token}` (unauthenticated: the token is printed on the
 * statement and binds nothing but the statement hash and the vault version). The answer is the stored statement's facts —
 * the hash of its `documents` row (equal to the bytes' hash: `documents.open` re-hashes what it serves), the good-through
 * date and the total — never the borrower's name, address or account. Every answer that serves the hash is a
 * `document_access_log{purpose: verify_portal}` row (rule 7).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Runtime } from "../app.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { openDocumentInUow, raiseServedMismatch } from "./open-uow.ts";

export const VERIFY_TOKEN_RE = /^[A-HJ-NP-Z2-9]{12}$/;
const PORTAL: Actor = { kind: "system", id: "payoff-verify-portal" };
const plain = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
const json = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body, plain)); };

interface EntityRow extends Record<string, unknown> { id: string; loan_id: string | null; data: unknown; }

/** The statement a token verifies: the minted token's binding, then the `payoff_statements` row that carries the token (else the one with the bound hash). */
export async function statementForToken(runtime: Runtime, token: string): Promise<{ token: Record<string, unknown>; statement_id: string; statement: Record<string, unknown> } | null> {
  const t = (await runtime.db.query<EntityRow>(`SELECT id, loan_id, data FROM entity_current WHERE kind = 'payoff_verification_tokens' AND id = $1`, [token]))[0];
  if (!t) return null;
  const minted = decodeEntityData(t.data);
  const rows = await runtime.db.query<EntityRow>(`SELECT id, loan_id, data FROM entity_current WHERE kind = 'payoff_statements' AND (data->>'verification_token' = $1 OR data->>'hash' = $2) ORDER BY (data->>'verification_token' = $1) DESC, updated_at DESC LIMIT 1`, [token, String(minted["statement_hash"] ?? "")]);
  const s = rows[0]; if (!s) return null;
  return { token: minted, statement_id: s.id, statement: decodeEntityData(s.data) };
}

const evidenceDocumentOf = (statement: Record<string, unknown>): string | null => {
  const delivered = (statement["delivered_to"] as { evidence_document_id?: unknown }[] | undefined) ?? [];
  for (let k = delivered.length - 1; k >= 0; k--) { const id = delivered[k]?.evidence_document_id; if (typeof id === "string" && id) return id; }
  return null;
};

/** Mounted in src/runtime/server.ts before the borrower router; answers true when the request was `/verify/{token}`. */
export async function handleVerifyRoute(runtime: Runtime, req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
  const m = /^\/verify\/([^/]+)$/.exec(url.pathname);
  if (!m) return false;
  if (method !== "GET") { json(res, 405, { code: "METHOD_NOT_ALLOWED" }); return true; }
  const token = decodeURIComponent(m[1]!);
  if (!VERIFY_TOKEN_RE.test(token)) { json(res, 404, { code: "TOKEN_UNKNOWN" }); return true; }
  const found = await statementForToken(runtime, token);
  if (!found) { json(res, 404, { code: "TOKEN_UNKNOWN" }); return true; }
  const documentId = evidenceDocumentOf(found.statement);
  const facts = { token, statement_id: found.statement_id, good_through: found.statement["good_through"] ?? null, total_cents: found.statement["total_cents"] ?? null, wire_instruction_version_id: found.token["wire_instruction_version_id"] ?? null, issued_at: found.token["issued_at"] ?? null };
  if (!documentId) { json(res, 200, { ...facts, verified: false, reason: "STATEMENT_NOT_YET_DELIVERED", document_id: null, statement_sha256: null }); return true; }
  const ip = (req.socket.remoteAddress ?? null); const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const opened = await openDocumentInUow(runtime, { document_id: documentId, purpose: "verify_portal", ip, user_agent: ua }, PORTAL);
  if (opened.kind === "unknown" || opened.kind === "unavailable") { json(res, 503, { ...facts, verified: false, reason: "DOCUMENT_CONTENT_UNAVAILABLE", document_id: documentId }); return true; }
  if (opened.kind === "tombstone") { json(res, 410, { ...facts, verified: false, reason: "DOCUMENT_DISPOSED", document_id: documentId, statement_sha256: opened.sha256, disposed_at: opened.disposed_at }); return true; }
  if (opened.kind === "mismatch") { await raiseServedMismatch(runtime, documentId, PORTAL).catch((e) => runtime.logger?.error("verify portal: served mismatch escalation failed", { document_id: documentId, error: e })); json(res, 409, { ...facts, verified: false, reason: "INTEGRITY_FAILED", document_id: documentId }); return true; }
  json(res, 200, { ...facts, verified: true, document_id: documentId, statement_sha256: opened.sha256, byte_size: opened.byte_size, page_count: opened.row.page_count, template_code: opened.row.template_code, template_version: opened.row.template_version, served_from: opened.served_from });
  return true;
}
