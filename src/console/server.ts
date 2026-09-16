/**
 * Ops console HTTP server — JSON API + the single-page UI, behind a real staff sign-in (34.1).
 *
 * The actor (34.1 rule 3): every `/ops/api/*` (and legacy `/api/*`) request resolves the staff session from the `sm_staff`
 * cookie or `Authorization: Bearer <session token>` (src/runtime/staff/auth.ts StaffAuth.authenticate — 30-minute idle,
 * 12-hour absolute; 401 SESSION_EXPIRED once it lapsed) and acts as `{kind: human, id: staff_user_id, role}` for the route's
 * chosen role (src/runtime/staff/roles.ts chooseRole): the request's preferred role (`x-staff-role` / `?role=` / body `role` —
 * the header's "Act as") when the account holds it and the route accepts it; on a GET a held role the route does not accept
 * falls back to the least-privileged accepted role the account holds (ops_analyst < officer < compliance < admin) and every
 * answer names the role that acted — the `x-acted-as` header and, on a JSON object, `acted_as`; on a POST / PUT / DELETE such a
 * role is refused 403 ROLE_REQUIRED{role, held, act_as: [the accepted roles the account holds]} before any write (the screen
 * offers "act as" and re-sends with the role named — intent on an act is chosen, never inferred); a role the account lacks is
 * refused on either method (`act_as: []`), as is a route none of the held roles opens. The legacy header actor (`x-actor-id` /
 * `x-actor-role`) is honoured ONLY when the request carries the ops bearer token (the deploy workflow's own smoke calls — the
 * API_TOKEN as a bearer or the `sm_token` cookie /login sets) and ENVIRONMENT ≠ production; headers alone answer 401.
 *
 * The action log (rule 4): one `staff_actions` row per request — route (the query string without `email` / `phone` / `name`, a `q`
 * as its sha-256 — src/runtime/directory/routes.ts directoryLoggedRoute, applied before dispatch to every route), method, subject
 * ids, the bus command when one ran, the result (ok | refused | error), the refusal code and the role (migration 0139: the role
 * that acted, or on a refusal the role that was asked for) — a request that hits no route or a disallowed method is `refused`
 * with NOT_FOUND / METHOD_NOT_ALLOWED; ids only, never a name, an e-mail, a phone or a figure. The 19.2 access log keeps its row too.
 *
 * Routes (the spec's Inputs list; every `/api/*` path is also served at `/ops/api/*`):
 *   the door (no session)   POST /ops/api/auth/code {email} → {challenge_id, delivery, expires_at, fake_code?}   POST /ops/api/auth/verify {email, code} → the enrol/step token (never a session)
 *                           POST /ops/api/auth/password {token, password}   POST /ops/api/auth/signin {email, password} → staff.signin → the session (cookie sm_staff + token)
 *                           POST /ops/api/auth/passkey/assert-options {email}   POST /ops/api/auth/passkey/assert {challenge_id, credential, password?}   POST /ops/api/auth/signout
 *   on a session            POST /ops/api/auth/passkey/register-options   POST /ops/api/auth/passkey/register {challenge_id, credential, label?}   GET /ops/api/me
 *   admin                   GET /ops/api/staff   POST /ops/api/staff/invite {email, legal_name, roles}   PUT /ops/api/staff/{id}/roles {roles, rationale}   POST /ops/api/staff/{id}/disable {rationale}
 *   compliance | admin      POST /ops/api/staff/access-review {decisions: [{staff_user_id, decision, roles?}], rationale}   GET /ops/api/staff/access-reviews   GET /ops/api/staff/actions
 *   the bus                 POST /ops/api/tools/{process}/{name} {input, loan_id?, application_id?, role?} — the tool's human roles decide the role (a tool that declares `moneyFields` is officer's here); 403 ROLE_REQUIRED{role, held, act_as} before any write, never a silent re-role
 *                           (for process 34.2 the session's `session_id` rides in the input: the directory tools honour it only as the actor's own open session)
 *   the legacy views        GET /api/dashboard | queue | loans | funnel | partner-book/holds | partner-book/loans/{id}/readiness | ai/*; POST /api/escalations/complete | portal-tasks/complete | notices/supersede | outbox/requeue | agents/ai-off | partner-book/imports (multipart → 33.1 book.import) | partner-book/resolve
 *
 * Section 34's route tables (mounted once when the runtime exists; dispatched after the session is resolved and BEFORE the legacy
 * branches; every one also served at the legacy /api/… alias) — `section34RouteTable` lists them:
 *   34.2 the directory      src/runtime/directory/routes.ts directoryRoutes — GET /ops/api/directory/search?q=, GET …/accounts/{party_id}, GET …/accounts/{party_id}/activity,
 *                           POST …/accounts/{party_id}/unmask (compliance | officer), POST …/accounts/{party_id}/export (compliance). The action log's `route` for every directory
 *                           request is `directoryLoggedRoute(url)` — `q` as its sha-256, `email`/`phone`/`name` dropped — never the typed query (rule 4, NO_PII_IN_LOG); a route whose
 *                           `logged_query` is false is logged that way wherever it lives.
 *   34.3 book operations    src/runtime/book-ops/routes.ts bookOpsRoutes — GET /ops/api/partner-book/partners | imports | imports/{id} | loans | loans/{id} | reviews | readiness | daily-report,
 *                           POST …/daily-report/export (compliance), POST …/loans/{id}/resolve (ops_analyst). These supersede the console's own partner-book reads at the same paths.
 *   34.4 controls           src/runtime/controls/routes.ts controlsRoutes — GET /ops/api/controls/timers[/{id}] | escalations[/{id}] | outbox[/{id}] | ai[/{code}] | evidence[/{id}],
 *                           POST …/escalations/{id}/complete, …/outbox/{id}/requeue, …/ai/{code}/kill | reset, …/evidence (compliance). Evidence packs are written to `blobs`
 *                           (ConsoleServerOptions.blobs; a FakeBlobStore of the console's own when none is given).
 *   34.5 the portal         src/runtime/portal/routes.ts portalRoutes — GET /ops/api/portal/home?kind= (every staff role; the least-privileged held role acts), GET /ops/api/directory/list?<filters>
 *                           (the ops roles; logged as `?filters_hash=<sha-256>` — directoryLoggedRoute). The same table shape and dispatch as 34.2's.
 * For each: the role gate answers 403 {error: role_required, code: ROLE_REQUIRED, role, held, act_as} BEFORE any read (34.1 rule 3 — `actAs` over the route's roles); the handler
 * receives the staff context {staff_user_id, session_id, role, roles}; its outcome (command, subject, result, refusal_code) completes the staff_actions row like every other route.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import type { Actor } from "../kernel/events/index.ts";
import { RoleDenied } from "../app/roles.ts";
import { CommandRefused } from "../app/commands.ts";
import { type ConsoleStore, READ_ONLY_ROLES, CONSOLE_ROLES, maskEmail } from "./store.ts";
import type { Runtime } from "../runtime/app.ts";
import type { Logger } from "../runtime/log.ts";
import { parseMultipart } from "../runtime/borrower/routes.ts";
import { holdsOf, importPartnerBook, listPartnerBookImports, partnerBookReport, partnerBookStatus, resolvePartnerBookLoan, type PartnerBookImportInput } from "../runtime/partner-book.ts";
import { isUuid, toJson } from "../infra/db/client.ts";
import { loadAgentsFile } from "../app/agents.ts";
import { StaffAuth, SIGNIN_STATUS, STAFF_ABSOLUTE_HOURS, type StaffContext, type SigninResult, type InviteResult } from "../runtime/staff/auth.ts";
import { PgStaffRepository, emailHash, type StaffUserRow } from "../runtime/staff/repo.ts";
import { StaffError, chooseRole, actAsOffer, OPS_ROLES, ACCESS_REVIEW_ROLES, STAFF_ROLES } from "../runtime/staff/roles.ts";
import { directoryRoutes, directoryLoggedRoute, matchDirectoryRoute, type DirectoryRoute } from "../runtime/directory/routes.ts";
import { DirectoryRefused } from "../runtime/directory/unmask.ts";
import { DirectorySearchRefused } from "../runtime/directory/search.ts";
import { bookOpsRoutes, type BookOpsRoute } from "../runtime/book-ops/routes.ts";
import { controlsRoutes, matchControlsRoute, type ControlsRoute } from "../runtime/controls/routes.ts";
import { documentStaffRoutes } from "../runtime/documents/staff-routes.ts";
import { portalRoutes } from "../runtime/portal/routes.ts";
import { FakeBlobStore, type BlobStorePort } from "../runtime/borrower/vendors/fake-blob-store.ts";
// 35.7: the roles routes, dual control on the tools route (rule 2), the break-glass held set (rule 8), the action log's surface/source
import { rolesRoutes } from "../domain/operations-runtime/roles-35-7/routes.ts";
import { workRoutes } from "../domain/operations-runtime/work-35-8/routes.ts";
// 35.11: the stewardship boards' routes (the exceptions, the day's report, the runbook, the hand requeue through 34.4) — 34.4's table shape and dispatch
import { stewardshipRoutes } from "../domain/operations-runtime/stewardship-35-11/routes.ts";
import { executeWithControls } from "../domain/operations-runtime/roles-35-7/dual-control.ts";
import { activeBreakglassOf, breakglassUsesOf } from "../domain/operations-runtime/roles-35-7/breakglass.ts";
import { RolesRefused } from "../domain/operations-runtime/roles-35-7/refusals.ts";

/** `runtime` is what the 33.1 partner-book view, the 34.1 doors and the section-34 tables need (without it those routes answer 501); `apiToken` + `environment` gate the legacy header actor (rule 3); `blobs` is the document store 34.4's evidence packs are written to (the borrower router's when the host passes it; a FakeBlobStore of the console's own otherwise). */
export interface ConsoleServerOptions { readonly store: ConsoleStore; readonly clock?: { now(): string }; readonly uiHtml?: string; readonly runtime?: Runtime; readonly apiToken?: string; readonly environment?: string; readonly staff?: StaffAuth; readonly logger?: Logger; readonly blobs?: BlobStorePort | null; }

/** One mounted section-34 route as the report and the tests read it: the method, the spec's /ops/api path, the roles the gate admits, the bus command it logs (null for a plain read). */
export interface MountedRoute { readonly section: "34.2" | "34.3" | "34.4" | "34.5"; readonly method: "GET" | "POST"; readonly path: string; readonly roles: readonly string[]; readonly command: string | null; readonly logged_query: boolean }
/** The three section-34 tables the console mounts, built from the core modules' own route tables (never a literal of the console's): the source of truth for what is served. */
export function section34RouteTable(runtime: Runtime, blobs?: BlobStorePort | null): MountedRoute[] {
  const directory = directoryRoutes({ runtime }).map((r): MountedRoute => ({ section: "34.2", method: r.method, path: r.path, roles: [...r.roles], command: r.command, logged_query: r.logged_query }));
  const book = bookOpsRoutes({ runtime }).map((r): MountedRoute => ({ section: "34.3", method: r.method, path: r.path, roles: [...r.roles], command: r.path.endsWith("/resolve") ? "book.resolve" : r.path.endsWith("/export") ? "book.daily_report:export" : r.path.endsWith("/daily-report") ? "book.daily_report" : null, logged_query: true }));
  const controls = controlsRoutes({ runtime, blobs: blobs ?? null }).map((r): MountedRoute => ({ section: "34.4", method: r.method, path: `/ops${r.path}`, roles: [...r.roles], command: r.command, logged_query: true }));
  const portal = portalRoutes({ runtime }).map((r): MountedRoute => ({ section: "34.5", method: r.method, path: r.path, roles: [...r.roles], command: r.command, logged_query: r.logged_query }));
  return [...directory, ...book, ...controls, ...portal];
}
/** A book-ops route path (`{id}` segments) against a request path — both in the spec's `/ops/api/…` form. */
function matchTemplate(template: string, actual: string): Record<string, string> | null {
  const t = template.split("/"); const a = actual.split("/"); if (t.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) { const seg = t[i]!; const m = /^\{(\w+)\}$/.exec(seg); if (m) { if (!a[i]) return null; params[m[1]!] = decodeURIComponent(a[i]!); } else if (seg !== a[i]) return null; }
  return params;
}
/** The refusal code a section-34 handler's answer carries, for the action log (ids and codes only). */
const codeOf = (body: unknown, status: number): string => { const c = body && typeof body === "object" ? (body as { code?: unknown })["code"] : undefined; return typeof c === "string" && c ? c : status === 404 ? "NOT_FOUND" : status >= 500 ? "INTERNAL" : "REFUSED"; };

const UI_PATH = fileURLToPath(new URL("./ui/index.html", import.meta.url));
export const STAFF_COOKIE = "sm_staff";
const same = (a: string, b: string): boolean => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieOf = (req: IncomingMessage, name: string): string => { const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(req.headers["cookie"] ?? "")); return m ? decodeURIComponent(m[1]!) : ""; };
const bearerOf = (req: IncomingMessage): string => { const h = String(req.headers["authorization"] ?? ""); return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : ""; };
const ipOf = (req: IncomingMessage): string | null => { const f = req.headers["x-forwarded-for"]; const s = Array.isArray(f) ? f[0] : f; return (s ? s.split(",")[0]!.trim() : req.socket?.remoteAddress) ?? null; };
const uaOf = (req: IncomingMessage): string | null => { const ua = req.headers["user-agent"]; return typeof ua === "string" ? ua.slice(0, 512) : null; };
const staffCookie = (token: string, maxAge: number): string => `${STAFF_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8"); return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
const MAX_UPLOAD = 64 * 1024 * 1024;
async function raw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_UPLOAD) throw new RangeError(`request body over ${MAX_UPLOAD} bytes`); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
const UUID = /^[0-9a-f-]{36}$/i;
const str = (b: Record<string, unknown>, k: string): string => (typeof b[k] === "string" ? (b[k] as string) : "");
/**
 * 33.1 (rule 1; docs/ux/17 §6 "the operator's console view"): the upload form's multipart body → the import input. Fields
 * `partner_legal_name`, `partner_nmlsr_id`, `as_of_date`, `profile` (m3-v1) and the two files `tape` (required) and `supplement`.
 */
async function partnerBookUpload(req: IncomingMessage): Promise<PartnerBookImportInput> {
  const ctype = String(req.headers["content-type"] ?? "");
  if (!/^multipart\/form-data/i.test(ctype)) throw new RangeError("the upload is multipart/form-data: partner_legal_name, partner_nmlsr_id, as_of_date, profile, tape (file), supplement (file)");
  const mp = parseMultipart(await raw(req), ctype);
  const field = (k: string): string => (mp.fields[k] ?? "").trim();
  const file = (k: string): { filename: string; content: Uint8Array } | undefined => { const f = mp.files.find((x) => x.field === k && x.bytes.length); return f ? { filename: f.filename ?? `${k}.csv`, content: new Uint8Array(f.bytes) } : undefined; };
  if (!field("partner_legal_name")) throw new RangeError("partner_legal_name is required");
  if (!field("partner_nmlsr_id")) throw new RangeError("partner_nmlsr_id is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(field("as_of_date"))) throw new RangeError("as_of_date is required (YYYY-MM-DD)");
  const profile = field("profile") || "m3-v1"; if (profile !== "m3-v1") throw new RangeError(`unknown profile ${profile}`);
  const tape = file("tape"); if (!tape) throw new RangeError("tape file is required");
  const supplement = file("supplement");
  return { partner: { legal_name: field("partner_legal_name"), nmlsr_id: field("partner_nmlsr_id"), ...(field("partner_servicer_number") ? { servicer_number: field("partner_servicer_number") } : {}), ...(field("partner_mers_org_id") ? { mers_org_id: field("partner_mers_org_id") } : {}) }, as_of_date: field("as_of_date"), profile, tape, ...(supplement ? { supplement } : {}) };
}
/** 33.1 rule 6 / 33.2 / 33.3: every monitored loan with its latest partner facts (the figures the borrower record shows), the primary borrower's party and whether that party has activated (`partner_book.account.activated` logged), the latest daily review (verdict, reasons, the analyst's rationale or why it was skipped — 33.2) and the latest readiness row (ready, missing, the refinance application — 33.3) — never a destination. */
async function monitoredLoans(rt: Runtime, partnerPartyId: string | null): Promise<Record<string, unknown>[]> {
  return rt.db.query(`SELECT l.id::text AS loan_id, l.servicer_loan_number, l.partner_party_id::text AS partner_party_id, pp.legal_name AS partner_name,
      b.legal_name AS borrower_name, b.party_id, pr.state, pr.city, f.as_of_date,
      f.facts->>'upb_cents' AS upb_cents, f.facts->>'note_rate_pct' AS note_rate_pct, f.facts->>'pi_cents' AS pi_cents, f.facts->>'ti_cents' AS ti_cents,
      f.facts->>'next_due_date' AS next_due_date, f.facts->>'last_payment_date' AS last_payment_date, f.facts->>'mba_delinquency_status' AS mba_delinquency_status,
      (SELECT count(*)::int FROM partner_book_invitations i WHERE i.loan_id = l.id AND i.kind = 'invitation') AS invitations,
      (SELECT count(*)::int FROM partner_book_invitations i WHERE i.loan_id = l.id AND i.kind = 'reminder') AS reminders,
      EXISTS (SELECT 1 FROM loan_events e WHERE e.loan_id = l.id AND e.type = 'partner_book.account.activated') AS activated,
      rv.as_of_date AS review_as_of_date, rv.verdict AS review_verdict, rv.reasons AS review_reasons, rv.analyst->>'rationale' AS review_rationale, rv.analyst->>'skipped' AS review_analyst_skipped, rv.analyst->'flags' AS review_flags,
      rc.as_of_date AS readiness_as_of_date, rc.ready AS readiness_ready, rc.missing AS readiness_missing, rc.application_id AS readiness_application_id, rc.created_at AS readiness_checked_at
    FROM loans l
    JOIN parties pp ON pp.id = l.partner_party_id
    LEFT JOIN properties pr ON pr.id = l.property_id
    LEFT JOIN LATERAL (SELECT bo.legal_name, bo.party_id::text AS party_id FROM loan_borrowers lb JOIN borrowers bo ON bo.id = lb.borrower_id WHERE lb.loan_id = l.id ORDER BY lb.is_primary DESC LIMIT 1) b ON true
    LEFT JOIN LATERAL (SELECT as_of_date::text AS as_of_date, facts FROM partner_book_facts pf WHERE pf.loan_id = l.id ORDER BY pf.as_of_date DESC, pf.created_at DESC LIMIT 1) f ON true
    LEFT JOIN LATERAL (SELECT as_of_date::text AS as_of_date, verdict, reasons, analyst FROM partner_book_reviews r WHERE r.loan_id = l.id ORDER BY r.as_of_date DESC, r.created_at DESC LIMIT 1) rv ON true
    LEFT JOIN LATERAL (SELECT as_of_date::text AS as_of_date, ready, missing, application_id::text AS application_id, created_at::text AS created_at FROM readiness_checks c WHERE c.loan_id = l.id ORDER BY c.created_at DESC LIMIT 1) rc ON true
    WHERE l.status = 'monitored' AND ($1::uuid IS NULL OR l.partner_party_id = $1::uuid)
    ORDER BY pp.legal_name, l.servicer_loan_number LIMIT 1000`, [partnerPartyId]);
}
/** 33.3 audit and evidence: one monitored loan's readiness rows by date with each item's source row, as-of and validity (the examiner's view), oldest first. */
async function readinessRows(rt: Runtime, loanId: string): Promise<Record<string, unknown>[]> {
  return rt.db.query(`SELECT r.id::text AS id, r.party_id::text AS party_id, r.application_id::text AS application_id, r.as_of_date::text AS as_of_date, r.items, r.ready, r.missing, r.decision_id::text AS decision_id, r.created_at::text AS created_at FROM readiness_checks r LEFT JOIN LATERAL (SELECT max(e.sequence) AS seq FROM loan_events e WHERE e.loan_id = r.loan_id AND e.type = 'partner_book.readiness.checked' AND e.payload->>'readiness_check_id' = r.id::text) ev ON true WHERE r.loan_id = $1 ORDER BY r.created_at, ev.seq NULLS FIRST, r.id`, [loanId]);
}
const sendJson = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }); res.end(toJson(data)); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The roles a tool's own role guardrail asks for (src/app/tools.ts needsRole answers "<why>; requires officer/compliance"), evaluated against the input and the actor alone — a guardrail that needs the command's stores throws and is left to the bus. */
function roleGate(def: { guardrails?: readonly { refuse: (input: Record<string, unknown>, ctx: never) => string | undefined }[] }, input: Record<string, unknown>, actor: Actor): string[] | null {
  for (const g of def.guardrails ?? []) {
    let why: string | undefined;
    try { why = g.refuse(input, { actor, now: new Date().toISOString(), loanId: typeof input["loan_id"] === "string" ? input["loan_id"] : "" } as never); } catch { continue; }
    const m = why ? /; requires ([a-z_/]+)$/.exec(why) : null;
    if (m) return m[1]!.split("/");
  }
  return null;
}
/** Who the request acts as: a staff session (rule 3) or, for the deploy workflow only, the legacy headers behind the ops bearer outside production. */
interface Resolved { readonly actor: Actor; readonly staff: StaffContext | null; readonly source: "session" | "header"; readonly held: readonly string[] }
/** The request's subject ids for the action log: the path's uuid, or the body's id-shaped fields — never a name, an e-mail or a figure. */
function subjectOf(path: string, b: Record<string, unknown> | null): { kind: string | null; id: string | null } {
  let m: RegExpExecArray | null;
  if ((m = /^\/api\/staff\/([0-9a-f-]{36})\b/i.exec(path))) return { kind: "staff_user", id: m[1]! };
  if ((m = /^\/api\/loans\/([^/]+)/.exec(path)) || (m = /^\/api\/partner-book\/loans\/([^/]+)/.exec(path))) return { kind: "loan", id: decodeURIComponent(m[1]!) };
  if ((m = /^\/api\/partner-book\/imports\/([^/]+)/.exec(path))) return { kind: "partner_book_import", id: decodeURIComponent(m[1]!) };
  if (b) {
    const fallback = path.includes("escalations") ? "escalation" : path.includes("portal-tasks") ? "portal_task" : path.includes("notices") ? "notice" : path.includes("outbox") ? "integration_message" : "record";
    for (const [k, kind] of [["staff_user_id", "staff_user"], ["loan_id", "loan"], ["application_id", "application"], ["escalation_id", "escalation"], ["import_id", "partner_book_import"], ["id", fallback]] as const) {
      const v = b[k]; if (typeof v === "string" && v && (UUID.test(v) || k === "id")) return { kind, id: v };
    }
    if (typeof b["agent"] === "string") return { kind: "agent", id: b["agent"] as string };
  }
  return { kind: null, id: null };
}

export function createConsoleServer(opts: ConsoleServerOptions): Server {
  const { store } = opts; const clock = opts.clock ?? { now: () => new Date().toISOString() };
  const ui = opts.uiHtml ?? readFileSync(UI_PATH, "utf8");
  const environment = opts.environment ?? process.env["ENVIRONMENT"] ?? "nonprod";
  const production = environment === "production" || environment === "prod";
  const staff: StaffAuth | null = opts.staff ?? (opts.runtime ? new StaffAuth({ runtime: opts.runtime, environment, ...(opts.logger ? { logger: opts.logger } : {}) }) : null);
  const repo = opts.runtime ? new PgStaffRepository(opts.runtime.db) : null;
  // ───────── section 34's route tables, built once when the runtime exists (34.2 the directory, 34.3 book operations, 34.4 controls); the evidence packs' document store
  const blobs: BlobStorePort | null = opts.blobs !== undefined ? opts.blobs : opts.runtime ? opts.runtime.blobs : null;   // 35.2: the runtime's object store (document_blobs) — the per-process FakeBlobStore only when no runtime exists
  // 34.5's two reads share 34.2's table shape and dispatch (the role gate, the staff context, the outcome onto the action log)
  const DIRECTORY: readonly DirectoryRoute[] = opts.runtime ? [...directoryRoutes({ runtime: opts.runtime }), ...portalRoutes({ runtime: opts.runtime })] : [];
  const BOOK: readonly BookOpsRoute[] = opts.runtime ? bookOpsRoutes({ runtime: opts.runtime }) : [];
  const CONTROLS: readonly ControlsRoute[] = opts.runtime ? [...controlsRoutes({ runtime: opts.runtime, blobs }), ...documentStaffRoutes({ runtime: opts.runtime })] : [];   // 35.2: the staff document view rides 34.4's dispatch
  // 35.7: the grants, the approvals, the break-glass, the principals and the handover (src/domain/operations-runtime/roles-35-7/routes.ts) — 34.4's table shape and dispatch
  const ROLES: readonly ControlsRoute[] = opts.runtime ? rolesRoutes({ runtime: opts.runtime }) : [];
  // 35.8: the queue, the items and the screens (src/domain/operations-runtime/work-35-8/routes.ts) — 34.4's table shape and dispatch; the body's `role` is the role the act is asked for (rule 4)
  const WORK: readonly ControlsRoute[] = opts.runtime ? workRoutes({ runtime: opts.runtime }) : [];
  const STEWARDSHIP: readonly ControlsRoute[] = opts.runtime ? stewardshipRoutes({ runtime: opts.runtime }) : [];
  const SECTION34_PREFIXES = ["/api/directory", "/api/partner-book/", "/api/controls", "/api/portal/", "/api/roles", "/api/principals", "/api/handover", "/api/work", "/api/stewardship"];   // the trailing slash: the legacy /api/portal-tasks/* acts are not 34.5's
  let escalatesTo: Map<string, readonly string[]> | null = null;
  /** The roles a bus tool admits on the human path (src/app/tools.ts toolCommand's default: ops_analyst + officer + the process's escalation roles). */
  const toolRoles = (def: { humanRoles?: readonly string[]; process: string }): readonly string[] => { if (def.humanRoles) return def.humanRoles; escalatesTo ??= new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const)); return [...new Set(["ops_analyst", "officer", ...(escalatesTo.get(def.process) ?? [])])]; };
  const opsTokenPresented = (req: IncomingMessage): boolean => { const t = bearerOf(req) || cookieOf(req, "sm_token"); return opts.apiToken === undefined ? true : same(t, opts.apiToken); };
  const headerActor = (req: IncomingMessage): Actor | null => {
    const id = String(req.headers["x-actor-id"] ?? "").trim(); const role = String(req.headers["x-actor-role"] ?? "").trim();
    if (!id || !role || !(CONSOLE_ROLES as readonly string[]).includes(role)) return null;
    return { kind: "human", id, role };
  };
  /** The session token: the cookie, or a bearer that is not the ops token. */
  const sessionToken = (req: IncomingMessage): string => { const c = cookieOf(req, STAFF_COOKIE); if (c) return c; const b = bearerOf(req); return b && !(opts.apiToken !== undefined && same(b, opts.apiToken)) ? b : ""; };
  /** Rule 3. A staff session wins; the legacy headers are honoured only with the ops bearer token and outside production; headers alone (no bearer) answer 401 (T4). */
  async function resolve(req: IncomingMessage, now: string): Promise<Resolved> {
    const h = headerActor(req);
    if (h && !production && opsTokenPresented(req) && !cookieOf(req, STAFF_COOKIE)) return { actor: h, staff: null, source: "header", held: [h.role!] };
    if (h && production) throw new StaffError(403, "NO_HEADER_ACTOR_IN_PRODUCTION", "the header actor opens nothing in production; sign in");
    if (!staff) throw new StaffError(401, "AUTH_REQUIRED", h ? "x-actor-* headers are honoured only with the ops bearer token outside production" : "x-actor-id and a valid x-actor-role are required (a staff session needs the runtime: createConsoleServer({ runtime }))");
    const token = sessionToken(req);
    if (!token) throw new StaffError(401, "AUTH_REQUIRED", h ? "x-actor-* headers are honoured only with the ops bearer token outside production; sign in" : "sign in");
    const ctx = await staff.authenticate(token, now);
    // 35.7 rule 1: a session's actable set is roles ∪ reviewer_roles (chooseRole orders the staff four first, then the reviewer roles in the account's order)
    return { actor: { kind: "human", id: ctx.user.id, role: ctx.user.roles[0] ?? "ops_analyst" }, staff: ctx, source: "session", held: [...ctx.user.roles, ...ctx.user.reviewer_roles.filter((r) => !(ctx.user.roles as readonly string[]).includes(r))] };
  }
  const staffOrThrow = (): { auth: StaffAuth; repo: PgStaffRepository; rt: Runtime } => { if (!staff || !repo || !opts.runtime) throw new StaffError(501, "STAFF_UNAVAILABLE", "staff sign-in needs the runtime (createConsoleServer({ runtime }))"); return { auth: staff, repo, rt: opts.runtime }; };
  const runtimeOrThrow = (): Runtime => { const rt = opts.runtime; if (!rt) throw new StaffError(501, "RUNTIME_UNAVAILABLE", "this route needs the runtime (createConsoleServer({ runtime }))"); return rt; };
  /** A staff row for the list and the review page — the e-mail masked, never a code or a token. */
  const publicUser = async (u: StaffUserRow, now: string): Promise<Record<string, unknown>> => {
    let masked: string | null = null; try { masked = maskEmail(staff!.emailOf(u)); } catch { masked = null; }
    return { staff_user_id: u.id, legal_name: u.legal_name, email_masked: masked, roles: u.roles, status: u.status, invited_by: u.invited_by, invited_at: u.invited_at, enrolled_at: u.enrolled_at, disabled_at: u.disabled_at, locked_until: u.locked_until, failed_signins: u.failed_signins, factors: await repo!.credentialKinds(u.id), open_sessions: (await repo!.openSessionsOf(u.id, now)).length };
  };

  return createServer(async (req, res) => {
    const now = clock.now();
    const url = new URL(req.url ?? "/", "http://console");
    // rule 3 (amended 2026-09-15): the role that acted rides on every answer — the `x-acted-as` header (set on the response the moment the role is chosen, so a section-34 handler
    // that writes its own body carries it too) and, on a JSON object, `acted_as`; a refusal before a role acted (ROLE_REQUIRED / ROLE_DENIED / READ_ONLY) carries neither
    let actedAs: string | null = null;
    const json = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void => sendJson(res, status, actedAs && isObject(data) && !("acted_as" in data) ? { ...data, acted_as: actedAs } : data, headers);
    // "/" standalone (npm run console); "/ops" behind the API (32.14 §6.3); the JSON API at /api/* and /ops/api/* alike
    if (req.method === "GET" && ["/", "/index.html", "/ops", "/ops/", "/ops/index.html"].includes(url.pathname)) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(ui); return; }
    const path = url.pathname.startsWith("/ops/api/") ? url.pathname.slice(4) : url.pathname;
    if (path === "/api/roles") { json(res, 200, { roles: CONSOLE_ROLES, readOnly: [...READ_ONLY_ROLES], staffRoles: STAFF_ROLES, staff: !!staff, production }); return; }
    if (!path.startsWith("/api/")) { json(res, 404, { error: "not found" }); return; }
    const method = req.method ?? "GET";
    // rule 4: the action log's row — completed with the result once the route answered (the table is append-only: one insert per request, `at` = the request's start).
    // NO_PII_IN_LOG (review finding): the route is derived ONCE, before dispatch, for every request — a directory path that misses the table (a wrong
    // method, an unknown sub-path, a non-uuid party id) must not write the typed e-mail / phone / name into the five-year log either — through
    // directoryLoggedRoute: `email`, `phone` and `name` dropped, `q` as its sha-256 (the hash the directory.searched event carries) on every route.
    const logRoute = directoryLoggedRoute(url);
    let held: readonly string[] = [];
    const action = { staff_user_id: null as string | null, session_id: null as string | null, subject_kind: null as string | null, subject_id: null as string | null, command: null as string | null, result: "ok" as "ok" | "refused" | "error", refusal_code: null as string | null, role: null as string | null };
    const setSubject = (s: { kind: string | null; id: string | null }): void => { if (s.id && !action.subject_id) { action.subject_kind = s.kind; action.subject_id = s.id; } };
    // `logCode`: the action log's refusal_code when the wire answer is deliberately generic (the doors never enumerate accounts)
    const refuse = (status: number, code: string, data: Record<string, unknown>, logCode: string = code): void => {
      action.result = status >= 500 ? "error" : "refused"; action.refusal_code = logCode;
      if (status === 403 && (code === "ROLE_REQUIRED" || code === "ROLE_DENIED" || code === "READ_ONLY")) { actedAs = null; res.removeHeader("x-acted-as"); }   // nothing acted
      json(res, status, { error: code.toLowerCase(), code, ...data });
    };
    /**
     * The route's chosen role (rule 3, src/runtime/staff/roles.ts chooseRole): the request's preferred role among the ones held when the route accepts it; a GET falls back to the
     * least-privileged accepted held role, a POST / PUT / DELETE answers 403 ROLE_REQUIRED{role, held, act_as}. Rule 4: the row carries the role that acted — or, on a refusal, the
     * role that was asked for. The deploy workflow's header actor keeps its role as named (no fallback: it holds one).
     */
    const actAs = (r: Resolved, required: readonly string[] | null, preferredBody?: string): Actor => {
      const acted = (role: string): Actor => { action.role = role; actedAs = role; res.setHeader("x-acted-as", role); return { kind: "human", id: r.actor.id, role }; };
      if (r.source === "header") { action.role = r.actor.role ?? null; if (required && !required.includes(r.actor.role!)) throw new StaffError(403, "ROLE_REQUIRED", `this route needs ${required.join(" or ")}`, { role: required[0], held: r.held, act_as: [] }); return acted(r.actor.role!); }
      const preferred = preferredBody || String(req.headers["x-staff-role"] ?? "").trim() || url.searchParams.get("role") || null;
      action.role = preferred;
      return acted(chooseRole(r.held, required, preferred, { mode: method === "GET" || method === "HEAD" ? "read" : "act" }));
    };
    /** A section-34 handler's answer (34.3 / 34.4 shape): the bus command and the subject onto the action log, the refusal code when it refused, the JSON on the wire. */
    const answer = (out: { status: number; body: unknown; command?: string | null; subject?: { kind: string; id: string } | null }): void => {
      if (out.command) action.command = out.command;
      if (out.subject?.id) { action.subject_kind = out.subject.kind; action.subject_id = out.subject.id; }
      if (out.status >= 400) { action.result = out.status >= 500 ? "error" : "refused"; action.refusal_code = codeOf(out.body, out.status); }
      json(res, out.status, out.body);
    };
    // rule 4 (34.1): the row lands before the answer leaves — the response's `end` is held until `finally` has written the staff_actions row, so a reader
    // who holds the answer always finds the row (under a loaded machine the write used to land after the client's next read and the log read one row short)
    const realEnd = res.end.bind(res);
    let heldEnd: unknown[] | null = null;
    res.end = ((...args: unknown[]) => { heldEnd = args; return res; }) as typeof res.end;
    const releaseEnd = (): void => { res.end = realEnd; if (heldEnd) (realEnd as (...a: unknown[]) => ServerResponse)(...heldEnd); };
    try {
      setSubject(subjectOf(path, null));
      // ───────── the door (no session; rule 1): the code, the enrol/step token, the password, the passkey assertion, the sign-in, the sign-out
      if (method === "POST" && path.startsWith("/api/auth/")) {
        const { auth: s, repo: sr, rt } = staffOrThrow();
        const b = await body(req);
        if (path === "/api/auth/code") { const r = await s.requestCode(str(b, "email"), now); setSubject({ kind: "auth_challenge", id: r.challenge_id }); json(res, 200, r); return; }
        if (path === "/api/auth/verify") { const r = await s.verifyCode(str(b, "email"), str(b, "code"), now); action.staff_user_id = r.staff_user_id; setSubject({ kind: "staff_user", id: r.staff_user_id }); json(res, 200, { ...r, session: null, note: "an enrol/step token: it sets or resets the password and registers a passkey; it opens no session (GET /ops/api/me with it answers 401)" }); return; }
        if (path === "/api/auth/password") {
          // rule 4: the row names the staff member the enrol/step token resolves to even when the password is refused (PASSWORD_WEAK)
          const u = await s.stepUser(str(b, "token"), now); action.staff_user_id = u.id; setSubject({ kind: "staff_user", id: u.id });
          const r = await s.setPassword(str(b, "token"), str(b, "password"), now, { current_password: str(b, "current_password") || null }); json(res, 200, r); return;
        }
        if (path === "/api/auth/passkey/assert-options") { const r = await s.assertOptions(str(b, "email"), now); setSubject({ kind: "auth_challenge", id: String(r["challenge_id"]) }); json(res, 200, r); return; }
        if (path === "/api/auth/signin" || path === "/api/auth/passkey/assert") {
          let email = str(b, "email");
          if (path === "/api/auth/passkey/assert") {
            const a = await s.assert({ challenge_id: str(b, "challenge_id"), credential: b["credential"] }, now);
            action.staff_user_id = a.staff_user_id; setSubject({ kind: "staff_user", id: a.staff_user_id });
            if (!str(b, "password")) { json(res, 200, { ...a, session: null, note: "the passkey is the possession factor; POST /ops/api/auth/signin {email, password} within 10 minutes opens the session (TWO_FACTORS)" }); return; }
            const u = await sr.user(a.staff_user_id); email = u ? s.emailOf(u) : "";
          }
          // staff.signin on the bus — the only path to a session; the actor is the person once the e-mail resolves (the system door otherwise)
          const known = email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? await sr.userByEmailHash(emailHash(email)) : undefined;
          const actor: Actor = known ? { kind: "human", id: known.id, role: known.roles[0] ?? "ops_analyst" } : { kind: "system", id: "staff-door" };
          action.command = "staff.signin"; if (known) { action.staff_user_id = known.id; setSubject({ kind: "staff_user", id: known.id }); }
          const r = await rt.execute({ process: "34.1", name: "staff.signin", loanId: "", actor, input: { email, password: str(b, "password"), ip: ipOf(req), user_agent: uaOf(req), actor_source: "door" } });
          const out = r.output as SigninResult;
          // the door never enumerates accounts: an unknown address, a not-yet-enrolled one and a disabled one all answer 401 PASSWORD_WRONG with nothing else; no answer carries the staff_user_id or the failure count (the action log's refusal_code and the staff events keep them); ACCOUNT_LOCKED (spec T3) and the locking failure carry `locked_until` only
          if (!out.ok) { const wire = out.code === "ACCOUNT_DISABLED" || out.code === "NOT_ENROLLED" ? "PASSWORD_WRONG" : out.code; refuse(SIGNIN_STATUS[wire], wire, out.locked_until ? { locked_until: out.locked_until } : {}, out.code); return; }
          action.staff_user_id = out.staff_user_id; action.session_id = out.session_id;
          json(res, 200, { token: out.token, session_id: out.session_id, staff_user_id: out.staff_user_id, roles: out.roles, factors: out.factors, expires_at: out.expires_at, legal_name: out.legal_name, absolute_hours: STAFF_ABSOLUTE_HOURS }, { "set-cookie": staffCookie(out.token, STAFF_ABSOLUTE_HOURS * 3600) }); return;
        }
        if (path === "/api/auth/signout") { const r = await s.signOut(sessionToken(req), now); action.session_id = r.session_id; json(res, 200, r, { "set-cookie": staffCookie("", 0) }); return; }
        if (path === "/api/auth/passkey/register-options" || path === "/api/auth/passkey/register") {
          const r = await resolve(req, now); if (!r.staff) throw new StaffError(401, "AUTH_REQUIRED", "passkeys are registered on an enrolled session");
          action.staff_user_id = r.staff.user.id; action.session_id = r.staff.session.session_id; setSubject({ kind: "staff_user", id: r.staff.user.id });
          if (path === "/api/auth/passkey/register-options") { json(res, 200, await s.registerOptions(r.staff, now)); return; }
          json(res, 200, await s.register(r.staff, { challenge_id: str(b, "challenge_id"), credential: b["credential"], label: str(b, "label") || null }, now)); return;
        }
        throw new StaffError(404, "NOT_FOUND", "no such auth route");
      }
      // ───────── every other /api request: the session (or the deploy workflow's header actor) → the access log → the route
      const r = await resolve(req, now);
      action.staff_user_id = r.staff?.user.id ?? null; action.session_id = r.staff?.session.session_id ?? null; held = r.held;
      // the access log names who looked at whom, never the address itself: `?email=` is masked the way the trace masks it (19.2 / DELTA-28); a directory search's `q` is a person's e-mail, phone or name and is logged as its hash
      const loggedPath = new URL(url.toString()); if (loggedPath.searchParams.has("email")) loggedPath.searchParams.set("email", maskEmail(loggedPath.searchParams.get("email")) ?? "");
      await store.logAccess({ at: now, actor: r.source === "header" ? r.actor : { kind: "human", id: r.actor.id, role: r.actor.role ?? "ops_analyst" }, method, path: path.startsWith("/api/directory") ? directoryLoggedRoute(loggedPath) : loggedPath.pathname + loggedPath.search });
      // ───────── section 34 (34.2 the directory, 34.3 book operations, 34.4 controls): the tables above, dispatched before the legacy branches — the role gate before any read (rule 3),
      // the handler with the session's staff context, the outcome completing the staff_actions row (rule 4). The tables are keyed by the spec's /ops/api/… paths; the legacy /api/… alias reaches them too.
      if (!opts.runtime && SECTION34_PREFIXES.some((p) => path.startsWith(p))) runtimeOrThrow();
      const opsPath = `/ops${path}`;
      const dir = matchDirectoryRoute(DIRECTORY, method, opsPath);
      if (dir) {
        // rule 4 / NO_PII_IN_LOG: the row's route is already the logged form (directoryLoggedRoute above, before the gate — a refused request logs the hash too)
        const b = method === "POST" ? await body(req) : {};
        const actor = actAs(r, [...dir.roles], str(b, "role"));
        const out = await dir.handler(req, res, { url: new URL(opsPath + url.search, "http://console"), staff: { staff_user_id: actor.id, session_id: r.staff?.session.session_id ?? null, role: actor.role!, roles: r.held }, body: b, now });
        action.command = out.command; if (out.subject_id) { action.subject_kind = out.subject_kind; action.subject_id = out.subject_id; }
        action.result = out.result; action.refusal_code = out.refusal_code ?? null; return;
      }
      for (const route of BOOK) {
        if (route.method !== method) continue; const params = matchTemplate(route.path, opsPath); if (!params) continue;
        const b = method === "POST" ? await body(req) : {};
        const actor = actAs(r, [...route.roles], str(b, "role"));
        const query = Object.fromEntries(url.searchParams); if (query["partner"] === undefined && query["partner_party_id"] !== undefined) query["partner"] = query["partner_party_id"];   // the console's older partner filter name
        answer(await route.handler({ params, query, body: b, staff: { staff_user_id: actor.id, role: actor.role!, session_id: r.staff?.session.session_id ?? null } })); return;
      }
      const ctl = matchControlsRoute(CONTROLS, method, path) ?? matchControlsRoute(ROLES, method, path) ?? matchControlsRoute(WORK, method, path) ?? matchControlsRoute(STEWARDSHIP, method, path);
      if (ctl) {
        // every route is logged the directory's way (logRoute above), so a `logged_query === false` row (none in 34.4 today) needs nothing more
        const b = method === "POST" ? await body(req) : {};
        // 35.7's routes: the body's `role` is the role being granted / handed over / broken into, never the "act as" preference (x-staff-role or ?role= carry that)
        const actor = actAs(r, [...ctl.route.roles], ROLES.includes(ctl.route) || STEWARDSHIP.includes(ctl.route) ? "" : str(b, "role"));
        answer(await ctl.route.handler({ actor, params: ctl.params, query: url.searchParams, body: b, now })); return;
      }
      if (method === "GET") {
        if (path === "/api/me") {
          const role = actAs(r, null).role!;
          json(res, 200, { actor: { kind: "human", id: r.actor.id, role }, readOnly: r.source === "header" ? READ_ONLY_ROLES.has(role) : false, source: r.source, staff_user_id: r.staff?.user.id ?? null, legal_name: r.staff?.user.legal_name ?? null, roles: r.held, role,
            session: r.staff ? { session_id: r.staff.session.session_id, factors: r.staff.session.factors, created_at: r.staff.session.created_at, last_seen_at: r.staff.session.last_seen_at, expires_at: r.staff.session.expires_at } : null }); return;
        }
        // ───────── 34.1 admin: the staff list; compliance | admin: the reviews (with the clock) and the action log
        if (path === "/api/staff") { actAs(r, ["admin"]); const { repo: sr } = staffOrThrow(); json(res, 200, { as_of: now, users: await Promise.all((await sr.users()).map((u) => publicUser(u, now))) }); return; }
        if (path === "/api/staff/access-reviews") {
          actAs(r, [...ACCESS_REVIEW_ROLES]); const { repo: sr, rt } = staffOrThrow();
          const clockRow = (await rt.db.query<{ id: string; status: string; due_at: string | null; due_date: string | null; armed_at: string; anchor_date: string }>(`SELECT id::text AS id, status::text AS status, due_at::text AS due_at, due_date::text AS due_date, armed_at::text AS armed_at, anchor_date::text AS anchor_date FROM timers WHERE code = 'SM_STAFF_ACCESS_REVIEW_90' ORDER BY armed_at DESC LIMIT 1`))[0] ?? null;
          const escalation = (await rt.db.query<{ id: string; opened_at: string; completed_at: string | null }>(`SELECT id::text AS id, opened_at::text AS opened_at, completed_at::text AS completed_at FROM escalations WHERE owner_role = 'compliance' AND payload->>'timer_code' = 'SM_STAFF_ACCESS_REVIEW_90' ORDER BY opened_at DESC LIMIT 1`))[0] ?? null;
          const active = (await sr.users()).filter((u) => u.status === "active");
          json(res, 200, { as_of: now, reviews: await sr.reviews(50), clock: clockRow ? { timer_id: clockRow.id, status: clockRow.status, due_at: clockRow.due_at, due_date: clockRow.due_date, armed_at: clockRow.armed_at, anchor_date: clockRow.anchor_date } : null, escalation, active_users: await Promise.all(active.map((u) => publicUser(u, now))) }); return;
        }
        if (path === "/api/staff/actions") { actAs(r, ["admin", "compliance"]); const { repo: sr } = staffOrThrow(); const sid = url.searchParams.get("staff_user_id"); json(res, 200, { as_of: now, actions: await sr.actions({ staff_user_id: sid && UUID.test(sid) ? sid : null, subject_id: url.searchParams.get("subject_id"), since: url.searchParams.get("since"), limit: Number(url.searchParams.get("limit") ?? 200) || 200 }) }); return; }
        // rule 2 ('admin manages staff users and roles and nothing else that touches a borrower') / rule 3 ('403 ROLE_REQUIRED before any read'): every borrower, queue, dashboard, funnel, conversation-trace and partner-book read is the ops roles' (ops_analyst | officer | compliance) — an admin-only session is refused here; the deploy workflow's header actor keeps its role as named
        const actor = actAs(r, r.source === "header" ? null : [...OPS_ROLES]);
        // DELTA-28 (docs/ux/17 §6): the conversation trace — the most recent turns across parties, and one party's thread / cards / turns by party_id or e-mail
        if (path === "/api/ai/conversation/recent") {
          if (!store.aiRecentTurns) { json(res, 501, { error: "the conversation trace needs the Postgres console store" }); return; }
          json(res, 200, { as_of: now, turns: await store.aiRecentTurns(Number(url.searchParams.get("limit") ?? 20) || 20) }); return;
        }
        if (path === "/api/ai/conversation") {
          if (!store.aiConversation || !store.aiPartyByEmail) { json(res, 501, { error: "the conversation trace needs the Postgres console store" }); return; }
          const email = url.searchParams.get("email"); let partyId = url.searchParams.get("party_id");
          if (!partyId && !email) { json(res, 400, { error: "party_id=<uuid> or email=<address> is required" }); return; }
          if (!partyId && email) partyId = (await store.aiPartyByEmail(email)) ?? null;
          if (partyId) setSubject({ kind: "party", id: partyId });
          const c = partyId ? await store.aiConversation(partyId) : undefined;
          if (!c) json(res, 404, { error: "no such party" }); else json(res, 200, c); return;
        }
        if (path === "/api/queue") { const kind = url.searchParams.get("kind"); const loanId = url.searchParams.get("loanId"); json(res, 200, await store.queue({ role: url.searchParams.get("role") ?? actor.role!, now, ...(kind ? { kind: kind as never } : {}), ...(loanId ? { loanId } : {}) })); return; }
        if (path === "/api/loans") { json(res, 200, await store.searchLoans(url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 20))); return; }
        const m = /^\/api\/loans\/([^/]+)$/.exec(path);
        if (m) { const l = await store.loan(decodeURIComponent(m[1]!), now); if (!l) json(res, 404, { error: "no such loan" }); else json(res, 200, l); return; }
        // 32.14 T18: the entry funnel — counts per stage from loan_events/lead events only (src/console/pg-store.ts funnel)
        if (path === "/api/funnel") { json(res, 200, await store.funnel({ from: url.searchParams.get("from") ?? new Date(Date.parse(now) - 30 * 86_400_000).toISOString(), to: url.searchParams.get("to") ?? now })); return; }
        if (path === "/api/dashboard") { json(res, 200, await store.dashboard(now)); return; }
        // 33.1: the partner book — the imports (newest first), one import's report (per-row exceptions and gap counts, never a destination) and the monitored loans with their latest facts
        if (path.startsWith("/api/partner-book/")) {
          const rt = opts.runtime; if (!rt) { json(res, 501, { error: "the partner book needs the runtime (createConsoleServer({ runtime }))" }); return; }
          const partner = url.searchParams.get("partner_party_id"); const partnerId = partner && UUID.test(partner) ? partner : null;
          if (path === "/api/partner-book/imports") { json(res, 200, { as_of: now, imports: await listPartnerBookImports(rt, partnerId ?? undefined) }); return; }
          if (path === "/api/partner-book/loans") { json(res, 200, { as_of: now, loans: await monitoredLoans(rt, partnerId) }); return; }
          // 33.1 rule 8: per partner "book as of <date>, next expected <date>" and the loans on hold (absent from the partner's latest tape) the operator resolves
          if (path === "/api/partner-book/holds") { json(res, 200, { as_of: now, partners: await partnerBookStatus(rt, now), holds: await holdsOf(rt, partnerId, now) }); return; }
          // 33.3: the readiness rows of one monitored loan (the examiner's view — every item with its source, as-of and validity)
          const rm = /^\/api\/partner-book\/loans\/([^/]+)\/readiness$/.exec(path);
          if (rm) { const id = decodeURIComponent(rm[1]!); if (!UUID.test(id)) { json(res, 400, { error: "loan_id is a uuid" }); return; } json(res, 200, { as_of: now, loan_id: id, rows: await readinessRows(rt, id) }); return; }
          const pm = /^\/api\/partner-book\/imports\/([^/]+)$/.exec(path);
          if (pm) { const rep = await partnerBookReport(rt, decodeURIComponent(pm[1]!)); if (!rep) json(res, 404, { error: "no such import" }); else json(res, 200, rep); return; }
        }
        refuse(404, "NOT_FOUND", {}); return;   // rule 4 (review finding): a missed route is a refused request on the log, never `ok`
      }
      if (method === "POST" || method === "PUT") {
        // ───────── 34.1 admin: invite, roles, disable; compliance | admin: the access review — every one a bus command with the person as actor
        let sm: RegExpExecArray | null = null;
        if (path === "/api/staff/invite" || (sm = /^\/api\/staff\/([^/]+)\/(roles|disable)$/.exec(path)) || path === "/api/staff/access-review") {
          const { rt } = staffOrThrow();
          const b = await body(req); setSubject(subjectOf(path, b));
          const review = path === "/api/staff/access-review";
          const actor = actAs(r, review ? [...ACCESS_REVIEW_ROLES] : ["admin"], str(b, "role"));
          const name = review ? "staff.access.review" : path === "/api/staff/invite" ? "staff.invite" : sm![2] === "roles" ? "staff.role.set" : "staff.disable";
          action.command = name;
          const targetId = sm ? decodeURIComponent(sm[1]!) : null; if (targetId && !UUID.test(targetId)) throw new RangeError("staff user id is a uuid");
          const input: Record<string, unknown> = review ? { decisions: b["decisions"], rationale: b["rationale"] } : path === "/api/staff/invite" ? { email: b["email"], legal_name: b["legal_name"], roles: b["roles"], rationale: b["rationale"] } : sm![2] === "roles" ? { staff_user_id: targetId, roles: b["roles"], rationale: b["rationale"] } : { staff_user_id: targetId, rationale: b["rationale"] };
          const out = await rt.execute({ process: "34.1", name, loanId: "", actor, input: { ...input, actor_source: r.source } });
          const o = out.output as Record<string, unknown>;
          if (name === "staff.invite") setSubject({ kind: "staff_user", id: (out.output as InviteResult).staff_user_id });
          if (review && typeof o["review_id"] === "string") setSubject({ kind: "staff_access_review", id: o["review_id"] });
          json(res, 200, { ...o, decision_ids: out.decisions.map((d) => d.id), events: out.events.map((e) => e.type), escalations: out.escalations }); return;
        }
        // ───────── the bus (rule 3 / T4): any tool with the session's actor for the tool's role; 403 ROLE_REQUIRED before any write
        let tm: RegExpExecArray | null = null;
        if (method === "POST" && (tm = /^\/api\/tools\/([^/]+)\/([^/]+)$/.exec(path))) {
          const rt = runtimeOrThrow();
          const process = decodeURIComponent(tm[1]!); const name = decodeURIComponent(tm[2]!);
          const def = rt.tool(process, name); if (!def) { refuse(404, "NO_SUCH_TOOL", { process, name }); return; }
          const b = await body(req); const loanId = str(b, "loan_id"); const applicationId = str(b, "application_id");
          if (loanId && !isUuid(loanId)) throw new RangeError("loan_id must be the loan's uuid"); if (applicationId && !isUuid(applicationId)) throw new RangeError("application_id must be the application's uuid");
          const input = b["input"] && typeof b["input"] === "object" && !Array.isArray(b["input"]) ? (b["input"] as Record<string, unknown>) : {};
          setSubject(loanId ? { kind: "loan", id: loanId } : applicationId ? { kind: "application", id: applicationId } : subjectOf(path, input));
          action.command = `${process} ${name}`;   // 35.7 T10: the bus command with its process on the log row
          // 35.7 rule 2: an approval is a record (roles.approve), never an input — a body approvedBy / input.approvals from a session is refused
          // a body approvedBy is refused on every tool; input.approvals only where the tool declares dual control (29.2 fundMarginCall and 31.1 carry their own `approvals` data — not this process's to refuse)
          if (b["approvedBy"] !== undefined || (def.dualControl && input["approvals"] !== undefined)) throw new RolesRefused(403, "APPROVER_NOT_SELF_ASSERTED", "an approval is a record written by a distinct verified person (roles.approve); a body approvedBy or input.approvals on a dual-control command is refused (35.7 rule 2)", {});
          // 35.7 rule 8: a broken-into role counts as held for the matching subject only, while unexpired; named for another subject or after expiry it is ROLE_DENIED
          let held35 = r.held; let breakglassRole: string | null = null;
          if (r.staff) {
            const uses = await breakglassUsesOf(rt.db, r.staff.user.id);
            if (uses.length) {
              const active = await activeBreakglassOf(rt.db, r.staff.user.id, now);
              const preferred = str(b, "role") || String(req.headers["x-staff-role"] ?? "").trim() || null;
              const matching = active.filter((u) => (u.subject_kind === "loan" && u.subject_id === loanId) || (u.subject_kind === "application" && u.subject_id === applicationId));
              held35 = [...r.held, ...matching.map((u) => u.role).filter((x) => !r.held.includes(x))];
              if (preferred && !held35.includes(preferred) && uses.some((u) => u.role === preferred)) { action.role = preferred; throw new RolesRefused(403, "ROLE_DENIED", `${preferred} was broken into for another subject or has expired; the acts under a break-glass are ordinary acts of that role on that subject only (35.7 rule 8)`, { role: preferred, subject: loanId ? { kind: "loan", id: loanId } : applicationId ? { kind: "application", id: applicationId } : null, held: [...r.held], act_as: [] }); }
              if (preferred && matching.some((u) => u.role === preferred)) breakglassRole = preferred;
            }
          }
          const r35: Resolved = held35 === r.held ? r : { ...r, held: held35 };
          // rule 2 ('waivers on money fields' are officer's) / rule 3 (34.1-T9, 34.5-T16): a tool that declares `moneyFields` is officer's on this surface — an analyst asking for it is
          // refused with the `act_as` offer, never substituted (35.8's proposal path is later); every other tool admits its own human roles
          const money = !!def.moneyFields?.length;
          const actor = actAs(r35, money ? ["officer"] : toolRoles(def), str(b, "role"));
          // rule 3 / T4: a role gate the tool states as a guardrail (src/app/tools.ts needsRole — "…; requires officer") is answered 403 ROLE_REQUIRED{role, held, act_as} here, before the
          // bus writes anything — `act_as` names the gated roles the account holds; the silent re-role of the actor to such a role (built 2026-09-14, retired 2026-09-15: intent on an act
          // is chosen, never inferred — it converted an analyst's money act into an execution under an authority the person never selected) is gone. A guardrail that needs the command's stores is left to the bus
          const gated = roleGate(def, { ...(loanId ? { loan_id: loanId } : {}), ...input }, actor);
          if (gated && !gated.includes(actor.role!)) { const offer = actAsOffer(r35.held, gated); throw new StaffError(403, "ROLE_REQUIRED", `${name} needs ${gated.join(" or ")}${offer.length ? `; act as ${offer.join(" or ")}` : ""}`, { role: gated[0], held: r35.held, act_as: offer }); }
          // 34.2: the directory tools take the session from the input and honour it only as the actor's own open staff session (unmask / export refuse SESSION_REQUIRED without one; the account view unmasks only what that session holds) — the body's staff_user_id / unmask are ignored by the tools
          const session = process === "34.2" ? { session_id: r.staff?.session.session_id ?? null } : {};
          // 35.7 rule 2 / rule 9: dual control around the bus (a declared command past its threshold needs roles.approve's record — 409 APPROVER_DISTINCT{request_id}) and `role.exercised` after a commit under a granted or broken-into role
          const grantRole = r.staff && actor.role && ((r.staff.user.reviewer_roles as readonly string[]).includes(actor.role) || breakglassRole === actor.role) ? actor.role : null;
          const out = await executeWithControls(rt, { process, name, loanId, ...(applicationId ? { applicationId } : {}), actor, input: { ...(loanId && input["loan_id"] === undefined ? { loan_id: loanId } : {}), ...(applicationId && input["application_id"] === undefined ? { application_id: applicationId } : {}), ...input, ...session } }, { surface: "ops", source: r.source, requestId: str(b, "request_id") || null, grantRole });
          json(res, 200, { output: out.output, decisionId: out.decisionId ?? null, decisions: out.decisions, events: out.events, timers: out.timers, escalations: out.escalations, actor }); return;
        }
        if (method !== "POST") { refuse(405, "METHOD_NOT_ALLOWED", {}); return; }
        // ───────── the legacy console acts: the ops roles (rule 2: admin touches no borrower); a read-only header role changes nothing
        const actor = actAs(r, r.source === "header" ? null : [...OPS_ROLES]);
        if (READ_ONLY_ROLES.has(actor.role!)) { refuse(403, "READ_ONLY", { reason: `${actor.role} is read-only` }); return; }
        // 33.1: the operator uploads the tape and the supplement; the portfolio agent loads, provisions and invites (src/runtime/partner-book.ts importPartnerBook); the actor is the console's human
        if (path === "/api/partner-book/imports") {
          const rt = opts.runtime; if (!rt) { json(res, 501, { error: "the partner book needs the runtime (createConsoleServer({ runtime }))" }); return; }
          let input: PartnerBookImportInput;
          try { input = await partnerBookUpload(req); } catch (e) { if (e instanceof RangeError) { action.result = "error"; action.refusal_code = "BAD_REQUEST"; json(res, 400, { error: e.message }); return; } throw e; }
          action.command = "book.import";
          const rep = await importPartnerBook(rt, input, actor); setSubject({ kind: "partner_book_import", id: rep.import_id });
          json(res, 200, rep); return;
        }
        // 33.1 rule 8: book.resolve{loan_id, resolution, reason} on the bus as the console's human (the bus refuses any role but ops_analyst: 403 role_denied)
        if (path === "/api/partner-book/resolve") {
          const rt = opts.runtime; if (!rt) { json(res, 501, { error: "the partner book needs the runtime (createConsoleServer({ runtime }))" }); return; }
          const b = await body(req); setSubject({ kind: "loan", id: str(b, "loan_id") || null });
          action.command = "book.resolve";
          const rr = await resolvePartnerBookLoan(rt, String(b["loan_id"] ?? ""), { resolution: String(b["resolution"] ?? ""), reason: String(b["reason"] ?? "") }, actor);
          json(res, 200, { ok: true, ...(rr.output as Record<string, unknown>), decision_id: rr.decision_id }); return;
        }
        const b = await body(req); setSubject(subjectOf(path, b));
        const id = String(b["id"] ?? "");
        const evidence = b["evidenceDocumentId"] ? String(b["evidenceDocumentId"]) : null;
        let out: { ok: true } | { ok: false; reason: string };
        switch (path) {
          case "/api/escalations/complete": action.command = "escalation.complete"; out = await store.completeEscalation(id, actor, evidence, now); break;
          case "/api/portal-tasks/complete": action.command = "portal_task.complete"; out = await store.completePortalTask(id, actor, evidence, now); break;
          case "/api/notices/supersede": action.command = "notice.supersede"; out = await store.releaseHeldNotice(id, actor, String(b["replacementId"] ?? ""), now); break;
          case "/api/outbox/requeue": action.command = "outbox.requeue"; out = await store.requeueDeadLetter(id, actor, now); break;
          case "/api/agents/ai-off": action.command = "ai.off"; out = await store.setAiOff(String(b["agent"] ?? ""), b["why"] === null || b["why"] === undefined ? null : String(b["why"]), actor, now); break;
          default: refuse(404, "NOT_FOUND", {}); return;
        }
        if (!out.ok) { action.result = "refused"; action.refusal_code = "CONSOLE_REFUSED"; }
        json(res, out.ok ? 200 : 409, out); return;
      }
      refuse(405, "METHOD_NOT_ALLOWED", {});   // a PUT / PATCH / DELETE on a read-only surface (T34.4-T1's probes) reads as refused on the log, never as a successful write
    } catch (e) {
      if (e instanceof StaffError) refuse(e.status, e.code, { reason: e.message, ...e.extra }, e.logCode);
      // a tool's own ROLE_REQUIRED guardrail (34.3 book.daily_report{op: export} needs compliance; 34.2's unmask / export) is the spec's 403 with the role it names, not a 409
      else if (e instanceof CommandRefused && e.code === "ROLE_REQUIRED") { const role = /requires ([a-z_]+)/.exec(e.message)?.[1] ?? null; refuse(403, "ROLE_REQUIRED", { reason: e.message, command: e.command, citation: e.citation, role, held: [...held], act_as: role ? actAsOffer(held, [role]) : [] }); }
      else if (e instanceof CommandRefused) { action.result = "refused"; action.refusal_code = e.code; json(res, 409, { error: "refused", command: e.command, code: e.code, citation: e.citation, reason: e.message }); }
      else if (e instanceof RoleDenied) refuse(403, "ROLE_REQUIRED", { reason: e.message, role: e.required[0], held: [...held], act_as: actAsOffer(held, e.required) });
      // 34.2's typed refusals reaching the generic bus route (SESSION_REQUIRED, REASON_REQUIRED, NOT_FOUND…; QUERY_TOO_SHORT / NARROW_QUERY) keep their status and code — they extend RangeError, so they must be matched before it
      else if (e instanceof DirectoryRefused) refuse(e.status, e.code, { reason: e.message, ...e.extra });
      else if (e instanceof DirectorySearchRefused) refuse(e.code === "QUERY_TOO_SHORT" ? 400 : 422, e.code, { reason: e.message, matches: e.matches });
      else if (e instanceof RangeError || e instanceof SyntaxError) { action.result = "error"; action.refusal_code = "BAD_REQUEST"; json(res, 400, { error: e.message }); }
      else { action.result = "error"; action.refusal_code = "INTERNAL"; opts.logger?.error("console.request.failed", { path, error: e }); json(res, 500, { error: (e as Error).message }); }
    } finally {
      // rule 4: one staff_actions row per request, ids only (the `email` query parameter is dropped from the route, a directory search's `q` is its hash; no name, phone, code, token or figure is ever set on `action`) — with the role that acted, or on a refusal the role that was asked for (`action.role`, migration 0139)
      if (repo) { try { await repo.logAction({ ...action, at: now, route: logRoute, method, surface: "ops", source: action.session_id ? "session" : held.length ? "header" : null }); } catch (err) { opts.logger?.error("staff_actions.write.failed", { path, error: err }); } }
      releaseEnd();
    }
  });
}

/** Start listening; resolves with the bound port (0 → ephemeral). */
export function listen(server: Server, port = 0, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { const a = server.address(); resolve(typeof a === "object" && a ? a.port : port); }); });
}
