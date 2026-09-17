/**
 * 36.1 — the `/v1/partner/*` prefix (spec/sections/36-servicing-partner-portal/36-1-*.md Inputs and triggers). Dispatched by
 * src/runtime/server.ts BEFORE the /v1 door resolves a principal, exactly as the borrower router is: this prefix resolves only a
 * `partner_sessions` bearer (rule 7 — a staff cookie, the `x-actor-*` headers, `x-staff-role` and the machine API_TOKEN open
 * nothing here, 36.1-T7), and a partner bearer opens nothing on /ops, /ops/api/*, /v1/partner-book/* or /v1/borrower/* (36.1-T8:
 * those surfaces resolve their own sessions and never read a partner_sessions row).
 *
 *   Doors (no session; ./auth.ts PartnerAuth):
 *   POST /v1/partner/auth/code             {email}                       → { challenge_id, delivery: FAKE|email, expires_at, fake_code? }
 *   POST /v1/partner/auth/verify           {email, code}                 → the enrol/step token (never a session)
 *   POST /v1/partner/auth/password         {token, password, current_password?}
 *   POST /v1/partner/auth/signin           {email, password}             → { token, session_id, partner_user_id, partner_party_id, role, roles, factors, expires_at }
 *   POST /v1/partner/auth/passkey/assert-options {email} · POST /v1/partner/auth/passkey/assert {challenge_id, credential}
 *   POST /v1/partner/auth/signout
 *   Session routes (Authorization: Bearer <partner session>; the app's cookie proxy turns sm_partner_session into it):
 *   GET  /v1/partner/me                                                   the user, the tenant (legal name, NMLSR id), the roles held, the session's default role
 *   POST /v1/partner/auth/passkey/register-options · POST /v1/partner/auth/passkey/register {challenge_id, credential, label?}
 *   GET  /v1/partner/users                          partner_admin         the tenant's users with roles and status
 *   POST /v1/partner/users/invite                   partner_admin         {email, name, roles} → partner.user.invite on the bus (the tenant from the session)
 *   POST /v1/partner/book/imports                   partner_admin (act)   36.2: the role gate before any read of the body (36.1-T2), then 33.1's book.import with the partner
 *                                                                         from the session and the partner user as actor (./book.ts); the report partnerBookReport returns
 *   GET  /v1/partner/book/imports                   every partner role    36.2: the tenant's import history (listPartnerBookImports) with who uploaded
 *   GET  /v1/partner/book/imports/{id}              every partner role    36.2: one import's report (partnerBookReport + 34.3's lines); another tenant's → 404 NOT_FOUND
 *   GET  /v1/partner/book/status                    every partner role    36.2: partnerBookStatus for the tenant — as of, next expected (33.1's clock), late, holds
 *   GET  /v1/partner/book/holds                     every partner role    36.2: holdsOf for the tenant, partner-grade, no resolve control
 *   POST /v1/partner/book/loans/{id}/resolve        no partner role       36.2 rule 9: 403 ROLE_REQUIRED{role: ops_analyst, act_as: []} before any read (also any POST under …/book/holds)
 *   GET  /v1/partner/book/loans/{id}                every partner role    the tenant's loan (34.3's bookLoan scoped by ./scope.ts); another tenant's → 404 NOT_FOUND (36.1-T3)
 *   GET  /v1/partner/eligibility?bucket=&state=&on_hold=  every partner role  36.3: the board — { as_of_date, counts, loans: PartnerLoanRow[] } (./eligibility.ts); every other query key dropped unread
 *   GET  /v1/partner/pipeline                       every partner role    36.4: the feed — { items: PipelineItem[] } newest first (./pipeline.ts); no query key in V1
 *   GET  /v1/partner/pipeline/{loan_id}             every partner role    36.4: the member's { loan, stages, current, clocks }; another tenant's, the new active loan's or an unknown id → 404 NOT_FOUND
 *   GET  /v1/partner/home                           every partner role    36.5 rule 1: { as_of_date, partner, book, eligibility, pipeline, latest_report_id } — counts of the tenant's rows (./home.ts)
 *   GET  /v1/partner/reports/daily[?as_of=]         partner_admin, partner_auditor  36.5 rule 2: 34.3's report row for the tenant and the day (404 for a day with no row), or the tenant's rows newest first;
 *                                                                         a partner_ops-only session → 403 ROLE_REQUIRED{role: partner_auditor, act_as: []} before any read
 *   GET  /v1/partner/reports/daily/export?as_of=&format=json|csv  partner_admin, partner_auditor  36.5 rule 3: the stored row as a file — a read, no documents row, no newer report row
 *   GET  /v1/partner/loans/{id}                     every partner role    36.5 rules 4–10: PartnerLoanDetail — the banner, the page's bucket, the stage, the row, the histories, `serviced`; another tenant's → 404
 *   GET  /v1/partner/loans/{id}/serviced[/...]      every partner role    36.6 rule 1: the tenant rule first (404), then 409 { available: false, code: SERVICED_PANE_NOT_BUILT } for every loan, every status, every path beneath
 *
 * Rule 3 on every session route: the request may name a held role (body `role` or `?role=`); a read falls back to the
 * least-privileged accepted held role and answers `acted_as`; an act is 403 ROLE_REQUIRED{role, held, act_as} before any write.
 * Rule 5 on every request: one `partner_actions` row — written when the request completes with the request's start instant,
 * the person, the tenant, the role that acted, `partner_portal.viewed` + the view (a read) or the command (an act), the result
 * and the refusal code; ids only, never a homeowner's name, e-mail or phone, a money figure or a filter's text.
 * Errors: a PartnerError with its status and code; a bus refusal 409 {code, citation}; RoleDenied 403; bad input 400.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { CommandRefused } from "../../app/commands.ts";
import { RoleDenied } from "../../app/roles.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { Runtime } from "../app.ts";
import type { Logger } from "../log.ts";
import { PartnerAuth, type PartnerContext, type PartnerAuthOptions } from "./auth.ts";
import { PgPartnerRepository, type PartnerActionInput } from "./repo.ts";
import { PartnerError, chooseRole, defaultRole, ADMIN_ROLES, EXPORT_ROLES, READ_ROLES, type PartnerRole, type RoleMode } from "./roles.ts";
import { tenantLoan, tenantLoanRow } from "./scope.ts";
import { firstNameLastInitial } from "./mask.ts";
import { BOOK_COPY, maskReportNumbers as maskFor, partnerHolds, partnerImport, partnerImportInputOf, partnerImportReport, partnerImports, partnerStatus } from "./book.ts";
import { eligibilityQueryFromUrl, partnerEligibility } from "./eligibility.ts";
import { partnerPipeline, partnerPipelineLoan } from "./pipeline.ts";
import { partnerDailyReport, partnerDailyReportExport, partnerDailyReports, partnerHome, partnerLoanDetail } from "./home.ts";
import { SERVICED_PANE_STATUS, SERVICED_REFUSAL } from "../../domain/servicing-partner-portal/serviced.ts";
export { firstNameLastInitial };

export const PARTNER_PREFIX = "/v1/partner/";
const PROCESS_36_1 = "36.1";
type Json = Record<string, unknown>;
const plain = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
const sendJson = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body, plain)); };
/** 36.5 rule 3: a stored row answered as a file (the export) — the bytes as they are, named for the download; still one log row, still no documents row. */
type RawFile = { readonly content_type: string; readonly filename: string; readonly content: string };
const sendRaw = (res: ServerResponse, status: number, f: RawFile): void => { res.writeHead(status, { "content-type": f.content_type, "content-disposition": `attachment; filename="${f.filename.replace(/["\\]/g, "")}"`, "cache-control": "no-store" }); res.end(f.content); };
const MAX_BODY = 1024 * 1024;
async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new RangeError(`request body over ${MAX_BODY} bytes`); chunks.push(c as Buffer); }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError("request body must be a JSON object");
  return v as Json;
}
const str = (b: Json, k: string): string => (typeof b[k] === "string" ? (b[k] as string) : "");
/** Rule 7: only `Authorization: Bearer` names a partner session — never a cookie (sm_staff, sm_token), never a header actor. */
const bearerOf = (req: IncomingMessage): string => { const h = String(req.headers["authorization"] ?? ""); return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : ""; };
const ipOf = (req: IncomingMessage): string | null => { const f = req.headers["x-forwarded-for"]; const s = Array.isArray(f) ? f[0] : f; return (s ? s.split(",")[0]!.trim() : req.socket?.remoteAddress) ?? null; };
const uaOf = (req: IncomingMessage): string | null => { const ua = req.headers["user-agent"]; return typeof ua === "string" ? ua.slice(0, 512) : null; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PartnerRouterOptions extends Omit<PartnerAuthOptions, "runtime"> { readonly runtime: Runtime; readonly logger: Logger }
export interface PartnerRouter { handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>; readonly auth: PartnerAuth }

/** A route's answer: the status, the body, and what the log row records. */
interface Answer { readonly status: number; readonly body: unknown; readonly subject?: { kind: string; id: string | null }; readonly command?: string; readonly acted_as?: string; readonly raw?: RawFile }

export function createPartnerRouter(opts: PartnerRouterOptions): PartnerRouter {
  const { runtime, logger } = opts;
  const auth = new PartnerAuth({ runtime, ...(opts.environment !== undefined ? { environment: opts.environment } : {}), ...(opts.rpId !== undefined ? { rpId: opts.rpId } : {}), ...(opts.allowedOrigins !== undefined ? { allowedOrigins: opts.allowedOrigins } : {}), ...(opts.emailKey !== undefined ? { emailKey: opts.emailKey } : {}), logger });
  const repo = new PgPartnerRepository(runtime.db);

  /** Rule 3: the role the session acts under for this route (`acted_as`), or 403 ROLE_REQUIRED before any write. */
  const actAs = (ctx: PartnerContext, required: readonly PartnerRole[], preferred: string | null, mode: RoleMode): string => chooseRole(ctx.user.roles, required, preferred, { mode });
  /** The partner actor on the bus (rule 2 / Verified requirement): `{human, partner_user_id, role}` — never a staff role. */
  const actorOf = (ctx: PartnerContext, role: string): Actor => ({ kind: "human", id: ctx.user.id, role });
  /** 36.6 rule 6: the loan is the tenant's or it does not exist — read on the `loans` row itself (no facts row needed: the new active loan is the tenant's too); nothing of sections 2–19 is read (rule 3). */
  const partnerServicedLoan = async (ctx: PartnerContext, loanId: string): Promise<void> => { await tenantLoanRow(runtime, ctx.session, loanId); };

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith(PARTNER_PREFIX)) return false;
    const started = Date.now(); const at = new Date(started).toISOString(); const now = runtime.clock.now();
    const log: { user: string | null; tenant: string | null; role: string | null; action: string; subject_kind: string | null; subject_id: string | null } = { user: null, tenant: null, role: null, action: "partner_portal.door", subject_kind: null, subject_id: null };
    /** What a route records before it does anything that can refuse (rule 5: the refused row names the subject asked for — 36.1-T3). */
    const note = (n: { subject?: { kind: string; id: string | null }; command?: string; acted_as?: string }): void => { if (n.command) log.action = n.command; if (n.subject) { log.subject_kind = n.subject.kind; log.subject_id = n.subject.id; } if (n.acted_as) log.role = n.acted_as; };
    let answer: { status: number; body: unknown; code: string | null; raw?: RawFile };
    try {
      const preferred = url.searchParams.get("role");
      // ───────── the doors (no session)
      if (path.startsWith(`${PARTNER_PREFIX}auth/`) && !path.startsWith(`${PARTNER_PREFIX}auth/passkey/register`)) {
        if (method !== "POST") throw new PartnerError(405, "METHOD_NOT_ALLOWED");
        const b = await readJson(req);
        const step = path.slice(`${PARTNER_PREFIX}auth/`.length); log.subject_kind = `auth.${step.replace(/\//g, ".")}`;
        let out: unknown;
        if (step === "code") out = await auth.requestCode({ email: str(b, "email"), partner_party_id: b["partner_party_id"] }, now);
        else if (step === "verify") { const v = await auth.verifyCode({ email: str(b, "email"), code: str(b, "code"), partner_party_id: b["partner_party_id"] }, now); log.user = v.partner_user_id; log.tenant = v.partner_party_id; out = { ...v, session: null }; }
        else if (step === "password") { const p = await auth.setPassword({ token: str(b, "token"), password: str(b, "password"), current_password: typeof b["current_password"] === "string" ? b["current_password"] : null }, now); log.user = p.partner_user_id; log.tenant = p.partner_party_id; out = p; }
        else if (step === "signin") { const s = await auth.signIn({ email: str(b, "email"), password: str(b, "password"), partner_party_id: b["partner_party_id"], ip: ipOf(req), user_agent: uaOf(req) }, now); log.user = s.partner_user_id; log.tenant = s.partner_party_id; log.role = s.role; out = s; }
        else if (step === "passkey/assert-options") out = await auth.assertOptions({ email: str(b, "email"), partner_party_id: b["partner_party_id"] }, now);
        else if (step === "passkey/assert") { const a = await auth.assert({ challenge_id: str(b, "challenge_id"), credential: b["credential"] }, now); log.user = a.partner_user_id; out = a; }
        else if (step === "signout") { const s = await auth.signOut(bearerOf(req), now); out = s; }
        else throw new PartnerError(404, "NOT_FOUND", "no such door");
        answer = { status: 200, body: out, code: null };
      } else {
        // ───────── every other route: the partner session (rule 7: the bearer only)
        const ctx = await auth.authenticate(bearerOf(req), now);
        log.user = ctx.user.id; log.tenant = ctx.session.partner_party_id; log.action = "partner_portal.viewed";
        const a = await route(ctx, method, path, url, preferred, req, note);
        note(a);
        answer = { status: a.status, body: a.body, code: a.status >= 400 ? ((a.body as { code?: unknown } | null)?.code as string | undefined) ?? (a.status === 404 ? "NOT_FOUND" : "REFUSED") : null, ...(a.raw ? { raw: a.raw } : {}) };
      }
    } catch (e) {
      if (e instanceof PartnerError) { if (e.code === "ROLE_REQUIRED" && typeof e.extra["role"] === "string") log.role = e.extra["role"] as string; answer = { status: e.status, body: { error: e.code.toLowerCase(), code: e.code, reason: e.message, ...e.extra }, code: e.logCode }; }
      else if (e instanceof CommandRefused) answer = { status: 409, body: { error: "refused", command: e.command, code: e.code, citation: e.citation, reason: e.message }, code: e.code };
      else if (e instanceof RoleDenied) answer = { status: 403, body: { error: "role_denied", code: "ROLE_DENIED", reason: e.message }, code: "ROLE_DENIED" };
      else if (e instanceof RangeError || e instanceof TypeError || e instanceof SyntaxError) answer = { status: 400, body: { error: "bad_request", code: "BAD_REQUEST", reason: e.message }, code: "BAD_REQUEST" };
      else { logger.error("partner.unhandled", { method, path, error: e }); answer = { status: 500, body: { error: "internal", code: "INTERNAL" }, code: "INTERNAL" }; }
    }
    // rule 5: one row per request, on the log BEFORE the answer is on the wire — ids and the role only (the query string is never on the row: a filter's text is never logged)
    const row: PartnerActionInput = { at, partner_user_id: log.user, partner_party_id: log.tenant, role: log.role, action: log.action, subject_kind: log.subject_kind, subject_id: log.subject_id, result: answer.status >= 400 ? "refused" : "ok", refusal_code: answer.status >= 400 ? answer.code ?? "REFUSED" : null };
    try { await repo.logAction(row); } catch (e) { logger.error("partner.action_log.failed", { method, path, error: e }); }
    if (answer.raw) sendRaw(res, answer.status, answer.raw); else sendJson(res, answer.status, answer.body);
    logger.info("http", { method, path, status: answer.status, ms: Date.now() - started, surface: "partner", ...(answer.code ? { refused: answer.code } : {}) });
    return true;
  }

  /** The session routes. `preferred` is the request's "act as" (body `role` wins over `?role=` on a POST). */
  async function route(ctx: PartnerContext, method: string, path: string, url: URL, preferred: string | null, req: IncomingMessage, note: (n: { subject?: { kind: string; id: string | null }; command?: string; acted_as?: string }) => void): Promise<Answer> {
    const now = runtime.clock.now(); const rest = path.slice(PARTNER_PREFIX.length);
    let m: RegExpExecArray | null;
    if (method === "GET" && rest === "me") {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const tenant = await repo.tenant(ctx.session.partner_party_id);
      const entity = await runtime.entities.current("partners", ctx.session.partner_party_id);
      const nmlsr = typeof entity?.data["nmlsr_id"] === "string" ? String(entity.data["nmlsr_id"]) : null;
      return { status: 200, acted_as: role, subject: { kind: "me", id: ctx.user.id }, body: { partner_user_id: ctx.user.id, name: ctx.user.name, roles: ctx.user.roles, role: ctx.session.role, acted_as: role, partner: { partner_party_id: ctx.session.partner_party_id, legal_name: tenant?.legal_name ?? null, nmlsr_id: nmlsr }, session: { session_id: ctx.session.id, created_at: ctx.session.created_at, expires_at: ctx.session.expires_at, factors: ctx.session.factors }, factors: await repo.credentialKinds(ctx.user.id) } };
    }
    if (method === "POST" && rest === "auth/passkey/register-options") { actAs(ctx, READ_ROLES, preferred, "act"); return { status: 200, subject: { kind: "auth.passkey.register-options", id: ctx.user.id }, body: await auth.registerOptions(ctx, now) }; }
    if (method === "POST" && rest === "auth/passkey/register") { const b = await readJson(req); actAs(ctx, READ_ROLES, str(b, "role") || preferred, "act"); const r = await auth.register(ctx, { challenge_id: str(b, "challenge_id"), credential: b["credential"], label: typeof b["label"] === "string" ? b["label"] : null }, now); return { status: 200, subject: { kind: "auth.passkey.register", id: r.partner_credential_id }, body: r }; }
    // ───────── the Admin area (rule 2: partner_admin only)
    if (method === "GET" && rest === "users") {
      const role = actAs(ctx, ADMIN_ROLES, preferred, "read");
      const users = await repo.usersOfTenant(ctx.session.partner_party_id);   // rule 4: the tenant's users and no other tenant's
      return { status: 200, acted_as: role, subject: { kind: "users", id: ctx.session.partner_party_id }, body: { partner_party_id: ctx.session.partner_party_id, acted_as: role, users: users.map((u) => ({ partner_user_id: u.id, name: u.name, email: auth.emailOf(u), roles: u.roles, status: u.status, invited_at: u.invited_at, enrolled_at: u.enrolled_at, disabled_at: u.disabled_at, locked_until: u.locked_until })) } };
    }
    if (method === "POST" && rest === "users/invite") {
      const b = await readJson(req);
      note({ command: "partner.user.invite", subject: { kind: "partner_user", id: null } });
      const role = actAs(ctx, ADMIN_ROLES, str(b, "role") || preferred, "act");   // 403 ROLE_REQUIRED before any write
      // rule 8: the tenant is the session's — a body partner_party_id is ignored; the tool verifies the actor from the partner_users row
      const r = await runtime.execute({ process: PROCESS_36_1, name: "partner.user.invite", loanId: "", actor: actorOf(ctx, role), input: { partner_party_id: ctx.session.partner_party_id, email: str(b, "email"), name: typeof b["name"] === "string" ? b["name"] : null, roles: b["roles"], rationale: typeof b["rationale"] === "string" ? b["rationale"] : null } });
      const out = r.output as { partner_user_id: string };
      return { status: 200, acted_as: role, command: "partner.user.invite", subject: { kind: "partner_user", id: out.partner_user_id }, body: { ...(r.output as Json), acted_as: role, decision_id: r.decisionId ?? null } };
    }
    // ───────── 36.2: the one partner write — the tape drop. The role gate first, before any read of the body or any write (36.1-T2); then
    // 33.1's book.import through importPartnerBook with the partner from the session and the partner user as actor (36.2 rules 1–3); the answer
    // is the report partnerBookReport returns (rule 5), `already_loaded` on the same files (rule 4), `rejected` with the missing headers (rule 6)
    if (method === "POST" && rest === "book/imports") {
      note({ command: "book.import", subject: { kind: "import", id: null } });
      const role = actAs(ctx, ADMIN_ROLES, preferred, "act");   // a partner_ops or partner_auditor session: 403 ROLE_REQUIRED{role: partner_admin, act_as: []}
      const { input, dropped } = await partnerImportInputOf(req);   // rule 2: `as_of_date`, `tape`, `supplement` — a `partner`, `partner_party_id`, `nmlsr_id` or `profile` field is dropped, not honoured
      if (dropped.length) logger.info("partner.book.import.fields_dropped", { partner_party_id: ctx.session.partner_party_id, fields: dropped });
      const r = await partnerImport(runtime, ctx.session, actorOf(ctx, role), input);
      const subject = { kind: "import", id: r.import_id || null }; note({ subject, acted_as: role });
      return { status: 200, acted_as: role, command: "book.import", subject, body: { ...maskFor(r, role), acted_as: role, copy: BOOK_COPY.upload } };
    }
    // ───────── 36.2 rule 9: no resolve under /v1/partner/* — 403 ROLE_REQUIRED{role: ops_analyst, act_as: []} before any read, whatever the loan id (the same answer for
    // the tenant's own loan and another tenant's, so the refusal reveals nothing); `book.resolve` stays an ops_analyst act on /ops (34.3). No POST under …/book/holds either.
    if (method === "POST" && (m = /^book\/(?:loans\/([^/]+)\/resolve|holds(?:\/.*)?)$/.exec(rest))) {
      const loanId = m[1] ? decodeURIComponent(m[1]) : null;
      note({ command: "book.resolve", subject: { kind: "loan", id: loanId && UUID.test(loanId) ? loanId : null } });
      throw new PartnerError(403, "ROLE_REQUIRED", "book.resolve is an ops_analyst act on /ops (33.1 rule 8, 34.3); no partner role resolves a hold", { role: "ops_analyst", held: [...ctx.user.roles], act_as: [] });
    }
    // ───────── 36.2 rules 7–9: the history, a report, the status line and the holds — every partner role reads them (Trigger & frequency)
    if (method === "GET" && rest === "book/imports") {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const subject = { kind: "imports", id: ctx.session.partner_party_id }; note({ subject, acted_as: role });
      return { status: 200, acted_as: role, subject, body: { ...(await partnerImports(runtime, ctx.session)), acted_as: role } };
    }
    if (method === "GET" && (m = /^book\/imports\/([^/]+)$/.exec(rest))) {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const importId = decodeURIComponent(m[1]!);
      const subject = { kind: "import", id: UUID.test(importId) ? importId : null }; note({ subject, acted_as: role });
      const r = await partnerImportReport(runtime, ctx.session, importId, role);   // another tenant's import → 404 NOT_FOUND, logged refused (rule 2)
      return { status: 200, acted_as: role, subject, body: { ...r, acted_as: role } };
    }
    if (method === "GET" && rest === "book/status") {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const subject = { kind: "status", id: ctx.session.partner_party_id }; note({ subject, acted_as: role });
      return { status: 200, acted_as: role, subject, body: { ...(await partnerStatus(runtime, ctx.session, now)), acted_as: role } };
    }
    if (method === "GET" && rest === "book/holds") {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const subject = { kind: "holds", id: ctx.session.partner_party_id }; note({ subject, acted_as: role });
      return { status: 200, acted_as: role, subject, body: { ...(await partnerHolds(runtime, ctx.session, now)), acted_as: role } };
    }
    // ───────── the loan page (rule 4: the tenant's loan or 404; 36.1-T3) — every partner role reads it (rule 2)
    if (method === "GET" && (m = /^book\/loans\/([^/]+)$/.exec(rest))) {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const loanId = decodeURIComponent(m[1]!);
      const subject = { kind: "loan", id: UUID.test(loanId) ? loanId : null }; note({ subject, acted_as: role });
      const l = await tenantLoan(runtime, ctx.session, loanId, now);   // 404 NOT_FOUND for another tenant's loan — thrown as a PartnerError, logged refused
      // the partner-grade projection of 34.3's page (brief §4.6; 36.5 owns the full two-mode page): ids, the number (partner_admin / partner_ops see it in full on the detail), the property's city and state, the hold, the homeowner as first name + last initial — no e-mail, no phone
      const number = role === "partner_auditor" ? l.loan.servicer_loan_number.slice(-4) : l.loan.servicer_loan_number;
      return { status: 200, acted_as: role, subject, body: { acted_as: role, loan: { loan_id: l.loan.loan_id, servicer_loan_number: number, status: l.loan.status, partner_party_id: l.loan.partner_party_id, partner_legal_name: l.loan.partner_legal_name, property: l.loan.property ? { city: l.loan.property.city, state: l.loan.property.state } : null },
        homeowner: { party_id: l.homeowner.party_id, name: firstNameLastInitial(l.homeowner.legal_name) }, on_hold: l.on_hold, hold: l.hold, facts_as_of: l.facts_by_as_of.length ? l.facts_by_as_of[l.facts_by_as_of.length - 1]!.as_of_date : null,
        reviews: l.reviews.map((r) => ({ as_of_date: r.as_of_date, verdict: r.verdict, reasons: r.reasons })), readiness: l.readiness.length ? l.readiness[l.readiness.length - 1] : null, offers: l.offers.map((o) => ({ opportunity_id: o.opportunity_id, status: o.status, offer_valid_until: o.offer_valid_until, expired: o.expired })), clocks: l.clocks } };
    }
    // ───────── 36.3: the eligibility board — every partner role reads it (Trigger & frequency); the three keys narrow, every other key is dropped unread (rule 3: never applied,
    // never an error, never on the log row — the applied and dropped key NAMES go to the server log only); the counts are the whole tenant book's on every answer (rule 4)
    if (method === "GET" && rest === "eligibility") {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const subject = { kind: "eligibility", id: ctx.session.partner_party_id }; note({ subject, acted_as: role });
      const query = eligibilityQueryFromUrl(url);
      if (query.dropped.length) logger.info("partner.eligibility.keys_dropped", { partner_party_id: ctx.session.partner_party_id, dropped: query.dropped, applied: query.applied });
      return { status: 200, acted_as: role, subject, body: { ...(await partnerEligibility(runtime, ctx.session, query, now)), acted_as: role } };
    }
    // ───────── 36.4: the pipeline feed and a member's detail — every partner role reads them; the list is the tenant's members only (another tenant's are absent, never refused —
    // 36.4-T5), the detail for another tenant's loan, the new active loan or an unknown id is 404 NOT_FOUND and logged refused (rule 9); no query key in V1 (Open question 5)
    if (method === "GET" && rest === "pipeline") {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const subject = { kind: "pipeline", id: ctx.session.partner_party_id }; note({ subject, acted_as: role });
      return { status: 200, acted_as: role, subject, body: { ...(await partnerPipeline(runtime, ctx.session, now)), acted_as: role } };
    }
    if (method === "GET" && (m = /^pipeline\/([^/]+)$/.exec(rest))) {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const loanId = decodeURIComponent(m[1]!);
      const subject = { kind: "pipeline.loan", id: UUID.test(loanId) ? loanId : null }; note({ subject, acted_as: role });
      if (!UUID.test(loanId)) throw new PartnerError(404, "NOT_FOUND", "no such loan");
      return { status: 200, acted_as: role, subject, body: { ...(await partnerPipelineLoan(runtime, ctx.session, loanId, role, now)), acted_as: role } };
    }
    // ───────── 36.5 rule 1: Home — every partner role reads it; counts of the tenant's rows the owners keep (33.1's line, 34.3's counts, 36.3's board, 36.4's feed, the newest report row)
    if (method === "GET" && rest === "home") {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const subject = { kind: "home", id: ctx.session.partner_party_id }; note({ subject, acted_as: role });
      return { status: 200, acted_as: role, subject, body: { ...(await partnerHome(runtime, ctx.session, now)), acted_as: role } };
    }
    // ───────── 36.5 rules 2–3: the daily report — partner_admin and partner_auditor (36.1 rule 2); a partner_ops-only session is 403 ROLE_REQUIRED{role: partner_auditor, act_as: []} before any read
    // (Edge cases); the row is 34.3's for the tenant and the day (404 for a day with no row — never produced here, Open question 3); the export is the stored row as a file (no documents row)
    if (method === "GET" && (rest === "reports/daily" || rest === "reports/daily/export")) {
      const exporting = rest.endsWith("/export");
      note({ subject: { kind: exporting ? "report.export" : "report", id: null } });
      const role = actAs(ctx, EXPORT_ROLES, preferred, "read");
      const asOf = url.searchParams.get("as_of");
      if (exporting) {
        if (asOf === null) throw new RangeError("as_of is required (YYYY-MM-DD)");
        const x = await partnerDailyReportExport(runtime, ctx.session, asOf, url.searchParams.get("format"));   // another tenant's day or a day with no row → 404 NOT_FOUND
        const subject = { kind: "report.export", id: x.report_id }; note({ subject, acted_as: role });
        return { status: 200, acted_as: role, subject, body: { report_id: x.report_id, as_of_date: x.as_of_date, format: x.format, byte_size: x.byte_size, acted_as: role }, raw: { content_type: x.content_type, filename: x.filename, content: x.content } };
      }
      if (asOf === null) {
        const subject = { kind: "reports", id: ctx.session.partner_party_id }; note({ subject, acted_as: role });
        return { status: 200, acted_as: role, subject, body: { ...(await partnerDailyReports(runtime, ctx.session)), acted_as: role } };
      }
      const r = await partnerDailyReport(runtime, ctx.session, asOf);
      const subject = { kind: "report", id: r.id }; note({ subject, acted_as: role });
      return { status: 200, acted_as: role, subject, body: { ...r, acted_as: role } };
    }
    // ───────── 36.6 rule 1: the serviced pane — the tenant rule first (another tenant's, an unknown or a malformed id: 404 NOT_FOUND, rule 6), then the one refusal for every loan of the tenant whatever its
    // status, under every role, on the route and every path beneath it (V2's module paths are covered before they are named — Open question 1); no other method is routed (the ordinary 404 below)
    if (method === "GET" && (m = /^loans\/([^/]+)\/serviced(?:\/.*)?$/.exec(rest))) {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const loanId = decodeURIComponent(m[1]!);
      const subject = { kind: "serviced", id: UUID.test(loanId) ? loanId : null }; note({ subject, acted_as: role });
      await partnerServicedLoan(ctx, loanId);
      return { status: SERVICED_PANE_STATUS, acted_as: role, subject, body: { ...SERVICED_REFUSAL } };
    }
    // ───────── 36.5 rules 4–10: the two-mode loan page — every partner role (the full servicer loan number for partner_admin / partner_ops, the last four for partner_auditor); another tenant's loan or an unknown id → 404
    if (method === "GET" && (m = /^loans\/([^/]+)$/.exec(rest))) {
      const role = actAs(ctx, READ_ROLES, preferred, "read");
      const loanId = decodeURIComponent(m[1]!);
      const subject = { kind: "loan", id: UUID.test(loanId) ? loanId : null }; note({ subject, acted_as: role });
      return { status: 200, acted_as: role, subject, body: { ...(await partnerLoanDetail(runtime, ctx.session, loanId, role, now)), acted_as: role } };
    }
    const fallback = defaultRole(ctx.user.roles);
    return { status: 404, body: { error: "not_found", code: "NOT_FOUND", reason: "no such partner route" }, subject: { kind: "route", id: null }, ...(fallback ? { acted_as: fallback } : {}) };
  }
  return { handle, auth };
}
