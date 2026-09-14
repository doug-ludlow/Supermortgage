/**
 * 34.2 — the five directory routes (Inputs and triggers), as a table the operator portal's server mounts
 * (src/console/server.ts, after 34.1's session resolution and before its `staff_actions` row is completed):
 *
 *   GET  /ops/api/directory/search?q=                       ops_analyst | officer | compliance   → directory.search
 *   GET  /ops/api/directory/accounts/{party_id}             ops_analyst | officer | compliance   → directory.account
 *   GET  /ops/api/directory/accounts/{party_id}/activity    ops_analyst | officer | compliance   → directory.activity   (?from=&to=&kind=)
 *   POST /ops/api/directory/accounts/{party_id}/unmask      compliance | officer                 → directory.unmask     {fields, reason}
 *   POST /ops/api/directory/accounts/{party_id}/export      compliance                           → directory.export     {reason}
 *
 * Every handler runs its tool ON THE BUS (`runtime.execute`, process 34.2) with the session's actor `{kind: human, id:
 * staff_user_id, role}` (34.1 rule 3), so the agent's guardrails, the decision records and the events apply to a person
 * exactly as to an agent. The server answers `ROLE_REQUIRED{role}` before calling a handler whose `roles` the user lacks
 * (34.1 rule 3); the handler answers it again from the tool's own refusal should a caller bypass the table. A handler
 * returns what the action log needs — the bus command, the subject and the result — and never a name, an e-mail, a phone
 * or a figure (NO_PII_IN_LOG).
 *
 * Path parameters: the server may hand `ctx.params.party_id`; when it does not, the handler reads it from the URL.
 *
 * The action log's `route` (34.1 rule 4, NO_PII_IN_LOG): the search's `q` is a full e-mail, an E.164 phone or a name, so the
 * console must write the row's route through `directoryLoggedRoute(url)` — the path with `q` replaced by its sha-256 (the same
 * `query_hash` the `directory.searched` event carries) and `email` dropped — never `pathname + search`. `logged_query: false`
 * on a route says its query string may not be logged as typed.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../../kernel/events/index.ts";
import { CommandRefused } from "../../app/commands.ts";
import type { Runtime } from "../app.ts";
import { DIRECTORY_ROLES, EXPORT_ROLES, UNMASK_ROLES } from "./mask.ts";
import { DirectorySearchRefused, queryHash } from "./search.ts";
import { DirectoryRefused } from "./unmask.ts";

export const DIRECTORY_PROCESS = "34.2";
export const DIRECTORY_PATH = "/ops/api/directory";

/** What the server resolved for the request (34.1): the staff session and the role the route runs as. */
export interface DirectoryStaff { readonly staff_user_id: string; readonly session_id: string | null; readonly role: string; readonly roles: readonly string[] }
export interface DirectoryRouteContext { readonly url: URL; readonly staff: DirectoryStaff; readonly params?: Readonly<Record<string, string>>; /** the parsed JSON body when the server already read it; otherwise the handler reads the request */ readonly body?: unknown; readonly now?: string }
/** What the action log needs from the handler (34.1 rule 4): ids and codes only. */
export interface DirectoryRouteOutcome { readonly status: number; readonly command: string; readonly subject_kind: "party" | "search" | "export"; readonly subject_id: string | null; readonly result: "ok" | "refused" | "error"; readonly refusal_code?: string }
export interface DirectoryRoute { readonly method: "GET" | "POST"; readonly path: string; readonly pattern: RegExp; readonly roles: readonly string[]; readonly command: string; /** false: the query string carries a person's e-mail / phone / name and must reach the action log only through `directoryLoggedRoute` */ readonly logged_query: boolean; readonly handler: (req: IncomingMessage, res: ServerResponse, ctx: DirectoryRouteContext) => Promise<DirectoryRouteOutcome> }
export interface DirectoryRouteDeps { readonly runtime: Runtime }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTY = "([0-9a-fA-F-]{36})";

export function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) }); res.end(text);
}
export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); size += b.length; if (size > limit) throw new DirectoryRefused(413, "BODY_TOO_LARGE", "the body is too large"); chunks.push(b); }
  const text = Buffer.concat(chunks).toString("utf8").trim(); if (!text) return {};
  try { const v = JSON.parse(text) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { throw new DirectoryRefused(400, "BAD_JSON", "the body is not JSON"); }
}
const bodyOf = async (req: IncomingMessage, ctx: DirectoryRouteContext): Promise<Record<string, unknown>> => (ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? (ctx.body as Record<string, unknown>) : ctx.body === undefined ? readJson(req) : {});
const partyIdOf = (ctx: DirectoryRouteContext, pattern: RegExp): string => { const p = ctx.params?.["party_id"] ?? pattern.exec(ctx.url.pathname)?.[1] ?? ""; if (!UUID.test(p)) throw new DirectoryRefused(400, "BAD_PARTY_ID", "party_id must be a uuid"); return p; };
const actorOf = (s: DirectoryStaff): Actor => ({ kind: "human", id: s.staff_user_id, role: s.role });
const LOGGED_NEVER = ["email", "phone", "name"];
/**
 * The `route` the console's staff_actions row records: the path, `q` as its hash (T1: a query hash and no query text), no `email`,
 * `phone` or `name`. The console applies it to EVERY request before dispatch (review finding): a directory path that misses the
 * table — a wrong method, an unknown sub-path, a non-uuid party id — and the legacy `/api/loans?q=` search alike never write a typed
 * e-mail, phone or name into the five-year, append-only log.
 */
export function directoryLoggedRoute(url: URL): string {
  const logged = new URL(url.toString());
  for (const k of LOGGED_NEVER) logged.searchParams.delete(k);
  const q = logged.searchParams.get("q");
  if (q) logged.searchParams.set("q", queryHash(q));   // an empty `q=` carries nothing and stays as typed
  return logged.pathname + logged.search;
}

const ROLE_CODES = /ROLE|ALLOWLIST|HUMAN_ONLY|AI_OFF|KILL/;
const roleOfMessage = (m: string): string => { const hit = /requires ([a-z_\/]+)/.exec(m); const first = hit?.[1]?.split("/")[0]; return first ?? "compliance"; };
/** The refusal shape every directory route answers: `{error, code, ...extra}` with its status — a bus refusal (a guardrail) as 403 / 400 by code. */
function refusal(e: unknown): { status: number; code: string; body: Record<string, unknown> } {
  if (e instanceof DirectoryRefused) return { status: e.status, code: e.code, body: { error: e.message, code: e.code, ...e.extra } };
  if (e instanceof DirectorySearchRefused) return { status: e.code === "QUERY_TOO_SHORT" ? 400 : 422, code: e.code, body: { error: e.message, code: e.code, matches: e.matches } };
  if (e instanceof CommandRefused) {
    const forbidden = e.code === "ROLE_REQUIRED" || ROLE_CODES.test(e.code);
    const extra: Record<string, unknown> = e.code === "ROLE_REQUIRED" ? { role: roleOfMessage(e.message) } : {};
    return { status: forbidden ? 403 : 400, code: e.code, body: { error: e.message, code: e.code, citation: e.citation, ...extra } };
  }
  if (e instanceof RangeError) return { status: 400, code: "BAD_REQUEST", body: { error: e.message, code: "BAD_REQUEST" } };
  return { status: 500, code: "ERROR", body: { error: e instanceof Error ? e.message : String(e), code: "ERROR" } };
}

/** The table. `deps.runtime` executes the tools; the server supplies the session (ctx.staff) — nothing here reads a cookie or a header. */
export function directoryRoutes(deps: DirectoryRouteDeps): DirectoryRoute[] {
  const rt = deps.runtime;
  // the actor is the session's (34.1 rule 3); the tool takes `staff_user_id` from the actor and honours `session_id` only as the actor's own open staff session
  const run = async (name: string, ctx: DirectoryRouteContext, input: Record<string, unknown>): Promise<unknown> => (await rt.execute({ process: DIRECTORY_PROCESS, name, loanId: "", actor: actorOf(ctx.staff), input: { ...input, session_id: ctx.staff.session_id } })).output;
  const roleCheck = (ctx: DirectoryRouteContext, roles: readonly string[]): void => { if (!roles.includes(ctx.staff.role) && !ctx.staff.roles.some((r) => roles.includes(r))) throw new DirectoryRefused(403, "ROLE_REQUIRED", `this route needs ${roles.join(" or ")}`, { role: roles[0], roles }); };
  const answer = (res: ServerResponse, e: unknown, command: string, subject_kind: DirectoryRouteOutcome["subject_kind"], subject_id: string | null): DirectoryRouteOutcome => { const r = refusal(e); json(res, r.status, r.body); return { status: r.status, command, subject_kind, subject_id, result: r.status >= 500 ? "error" : "refused", refusal_code: r.code }; };

  const search: DirectoryRoute = { method: "GET", path: `${DIRECTORY_PATH}/search`, pattern: new RegExp(`^${DIRECTORY_PATH}/search/?$`), roles: DIRECTORY_ROLES, command: "directory.search", logged_query: false,
    handler: async (_req, res, ctx) => {
      try { roleCheck(ctx, DIRECTORY_ROLES); const q = ctx.url.searchParams.get("q") ?? ""; const out = await run("directory.search", ctx, { q }); json(res, 200, out); return { status: 200, command: "directory.search", subject_kind: "search", subject_id: (out as { query_hash?: string }).query_hash ?? null, result: "ok" }; }
      catch (e) { return answer(res, e, "directory.search", "search", null); }
    } };
  const accountPattern = new RegExp(`^${DIRECTORY_PATH}/accounts/${PARTY}/?$`);
  const account: DirectoryRoute = { method: "GET", path: `${DIRECTORY_PATH}/accounts/{party_id}`, pattern: accountPattern, roles: DIRECTORY_ROLES, command: "directory.account", logged_query: true,
    handler: async (_req, res, ctx) => {
      let party_id: string | null = null;
      try { roleCheck(ctx, DIRECTORY_ROLES); party_id = partyIdOf(ctx, accountPattern);   // the tool resolves the session's active unmask itself (34.2 rule 2): no caller path names the fields
        const out = await run("directory.account", ctx, { party_id }); if (!out) { json(res, 404, { error: `no account ${party_id}`, code: "NOT_FOUND" }); return { status: 404, command: "directory.account", subject_kind: "party", subject_id: party_id, result: "refused", refusal_code: "NOT_FOUND" }; }
        json(res, 200, out); return { status: 200, command: "directory.account", subject_kind: "party", subject_id: party_id, result: "ok" }; }
      catch (e) { return answer(res, e, "directory.account", "party", party_id); }
    } };
  const activityPattern = new RegExp(`^${DIRECTORY_PATH}/accounts/${PARTY}/activity/?$`);
  const activity: DirectoryRoute = { method: "GET", path: `${DIRECTORY_PATH}/accounts/{party_id}/activity`, pattern: activityPattern, roles: DIRECTORY_ROLES, command: "directory.activity", logged_query: true,
    handler: async (_req, res, ctx) => {
      let party_id: string | null = null;
      try { roleCheck(ctx, DIRECTORY_ROLES); party_id = partyIdOf(ctx, activityPattern); const sp = ctx.url.searchParams;
        const out = await run("directory.activity", ctx, { party_id, from: sp.get("from"), to: sp.get("to"), kind: sp.get("kind"), ...(sp.get("limit") ? { limit: Number(sp.get("limit")) } : {}) });
        if (!out) { json(res, 404, { error: `no account ${party_id}`, code: "NOT_FOUND" }); return { status: 404, command: "directory.activity", subject_kind: "party", subject_id: party_id, result: "refused", refusal_code: "NOT_FOUND" }; }
        json(res, 200, out); return { status: 200, command: "directory.activity", subject_kind: "party", subject_id: party_id, result: "ok" }; }
      catch (e) { return answer(res, e, "directory.activity", "party", party_id); }
    } };
  const unmaskPattern = new RegExp(`^${DIRECTORY_PATH}/accounts/${PARTY}/unmask/?$`);
  const unmask: DirectoryRoute = { method: "POST", path: `${DIRECTORY_PATH}/accounts/{party_id}/unmask`, pattern: unmaskPattern, roles: UNMASK_ROLES, command: "directory.unmask", logged_query: true,
    handler: async (req, res, ctx) => {
      let party_id: string | null = null;
      try { roleCheck(ctx, UNMASK_ROLES); party_id = partyIdOf(ctx, unmaskPattern); const body = await bodyOf(req, ctx);
        const out = await run("directory.unmask", ctx, { party_id, fields: body["fields"] ?? [], reason: body["reason"] ?? "" });
        json(res, 200, out); return { status: 200, command: "directory.unmask", subject_kind: "party", subject_id: party_id, result: "ok" }; }
      catch (e) { return answer(res, e, "directory.unmask", "party", party_id); }
    } };
  const exportPattern = new RegExp(`^${DIRECTORY_PATH}/accounts/${PARTY}/export/?$`);
  const exp: DirectoryRoute = { method: "POST", path: `${DIRECTORY_PATH}/accounts/{party_id}/export`, pattern: exportPattern, roles: EXPORT_ROLES, command: "directory.export", logged_query: true,
    handler: async (req, res, ctx) => {
      let party_id: string | null = null;
      try { roleCheck(ctx, EXPORT_ROLES); party_id = partyIdOf(ctx, exportPattern); const body = await bodyOf(req, ctx);
        const out = await run("directory.export", ctx, { party_id, reason: body["reason"] ?? "" }) as { export_id: string; document_id: string; sha256: string; byte_size: number; party_id: string; decision_id: string | null; event_id: string | null; pack?: unknown };
        const { pack: _pack, ...head } = out; json(res, 201, { ...head, pack_included: body["include_pack"] === true, ...(body["include_pack"] === true ? { pack: out.pack } : {}) });
        // the row's subject is the export produced (as 34.4's evidence route names the pack): the person's own staff_actions set — a row set of the pack — does not gain the pack's own receipt, so the pack verifies after it was produced
        return { status: 201, command: "directory.export", subject_kind: "export", subject_id: out.export_id, result: "ok" }; }
      catch (e) { return answer(res, e, "directory.export", "party", party_id); }
    } };
  return [search, account, activity, unmask, exp];
}

/** The route of the table a request falls on, for a server that dispatches by method + path (the account route's pattern rejects `/activity`, `/unmask` and `/export` by its `/?$`). */
export const matchDirectoryRoute = (routes: readonly DirectoryRoute[], method: string, pathname: string): DirectoryRoute | undefined => routes.find((r) => r.method === method.toUpperCase() && r.pattern.test(pathname));
