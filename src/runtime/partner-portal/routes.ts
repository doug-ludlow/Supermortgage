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
 *   POST /v1/partner/book/imports                   partner_admin (act)   the role gate before any write (36.1-T2); the tape drop itself is 36.2's — 501 NOT_WIRED until then
 *   GET  /v1/partner/book/loans/{id}                every partner role    the tenant's loan (34.3's bookLoan scoped by ./scope.ts); another tenant's → 404 NOT_FOUND (36.1-T3)
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
import { PartnerError, chooseRole, defaultRole, ADMIN_ROLES, READ_ROLES, type PartnerRole, type RoleMode } from "./roles.ts";
import { tenantLoan } from "./scope.ts";

export const PARTNER_PREFIX = "/v1/partner/";
const PROCESS_36_1 = "36.1";
type Json = Record<string, unknown>;
const plain = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
const sendJson = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body, plain)); };
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
/** The partner-grade name (brief §4.6): first name + last initial; never the full name on a partner surface. */
export const firstNameLastInitial = (name: string | null | undefined): string | null => { const parts = (name ?? "").trim().split(/\s+/).filter(Boolean); if (!parts.length) return null; return parts.length === 1 ? parts[0]! : `${parts[0]} ${parts[parts.length - 1]![0]}.`; };

export interface PartnerRouterOptions extends Omit<PartnerAuthOptions, "runtime"> { readonly runtime: Runtime; readonly logger: Logger }
export interface PartnerRouter { handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>; readonly auth: PartnerAuth }

/** A route's answer: the status, the body, and what the log row records. */
interface Answer { readonly status: number; readonly body: unknown; readonly subject?: { kind: string; id: string | null }; readonly command?: string; readonly acted_as?: string }

export function createPartnerRouter(opts: PartnerRouterOptions): PartnerRouter {
  const { runtime, logger } = opts;
  const auth = new PartnerAuth({ runtime, ...(opts.environment !== undefined ? { environment: opts.environment } : {}), ...(opts.rpId !== undefined ? { rpId: opts.rpId } : {}), ...(opts.allowedOrigins !== undefined ? { allowedOrigins: opts.allowedOrigins } : {}), ...(opts.emailKey !== undefined ? { emailKey: opts.emailKey } : {}), logger });
  const repo = new PgPartnerRepository(runtime.db);

  /** Rule 3: the role the session acts under for this route (`acted_as`), or 403 ROLE_REQUIRED before any write. */
  const actAs = (ctx: PartnerContext, required: readonly PartnerRole[], preferred: string | null, mode: RoleMode): string => chooseRole(ctx.user.roles, required, preferred, { mode });
  /** The partner actor on the bus (rule 2 / Verified requirement): `{human, partner_user_id, role}` — never a staff role. */
  const actorOf = (ctx: PartnerContext, role: string): Actor => ({ kind: "human", id: ctx.user.id, role });

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith(PARTNER_PREFIX)) return false;
    const started = Date.now(); const at = new Date(started).toISOString(); const now = runtime.clock.now();
    const log: { user: string | null; tenant: string | null; role: string | null; action: string; subject_kind: string | null; subject_id: string | null } = { user: null, tenant: null, role: null, action: "partner_portal.door", subject_kind: null, subject_id: null };
    /** What a route records before it does anything that can refuse (rule 5: the refused row names the subject asked for — 36.1-T3). */
    const note = (n: { subject?: { kind: string; id: string | null }; command?: string; acted_as?: string }): void => { if (n.command) log.action = n.command; if (n.subject) { log.subject_kind = n.subject.kind; log.subject_id = n.subject.id; } if (n.acted_as) log.role = n.acted_as; };
    let answer: { status: number; body: unknown; code: string | null };
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
        answer = { status: a.status, body: a.body, code: a.status >= 400 ? ((a.body as { code?: unknown } | null)?.code as string | undefined) ?? (a.status === 404 ? "NOT_FOUND" : "REFUSED") : null };
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
    sendJson(res, answer.status, answer.body);
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
    // ───────── the one partner write (36.2's tape drop): the role gate here, before any read of the body or any write (36.1-T2)
    if (method === "POST" && rest === "book/imports") {
      note({ command: "book.import", subject: { kind: "import", id: null } });
      const role = actAs(ctx, ADMIN_ROLES, preferred, "act");   // a partner_ops or partner_auditor session: 403 ROLE_REQUIRED{role: partner_admin, act_as: []}
      return { status: 501, acted_as: role, command: "book.import", subject: { kind: "import", id: null }, body: { error: "not_wired", code: "NOT_WIRED", reason: "the partner tape drop (POST /v1/partner/book/imports → 33.1's book.import with the partner from the session) is process 36.2; the role gate is 36.1's" } };
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
    const fallback = defaultRole(ctx.user.roles);
    return { status: 404, body: { error: "not_found", code: "NOT_FOUND", reason: "no such partner route" }, subject: { kind: "route", id: null }, ...(fallback ? { acted_as: fallback } : {}) };
  }
  return { handle, auth };
}
