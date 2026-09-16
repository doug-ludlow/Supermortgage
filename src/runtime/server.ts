/**
 * HTTP surface of the hosted runtime (Cloud Run service `supermortgage-api`).
 *
 *   GET  /healthz                                   liveness (no auth)
 *   GET  /readyz                                    200 when Postgres answers (no auth)
 *   GET  /login?token=…                             sets the bearer token as an HttpOnly cookie for the ops console UI, redirects to /
 *   GET  /v1/tools                                  every tool on the bus
 *   POST /v1/loans/{loanId}/tools/{process}/{name}  execute a tool for a loan   body: { actor, input, run?, approvedBy? }
 *   POST /v1/tools/{process}/{name}                 execute a global tool (no loan)
 *   GET  /v1/loans/{loanId}/events|timers|ledger    the loan's record
 *   POST /v1/sweep                                  the timer sweep, once
 *   GET  /v1/demo/clock                             the demo clock (src/runtime/demo-clock.ts): what the runtime's clock reads, the offset, the latest step — 403 in production
 *   POST /v1/demo/advance                           { to?: ISO instant | days?: number, budget_ms?: number } advance the demo clock, running the sweep minute for every calendar day crossed (≤ 400 days; stops between steps once budget_ms is spent, `complete: false` — re-POST to carry on) — 403 in production
 *   POST /v1/applications                           open an application  body: { actor, application: { partner_party_id, channel, transaction_type, occupancy, borrowers: [{ legal_name, … }], property?: {…}, prior_loan_id? } }
 *   POST /v1/applications/{id}/tools/{process}/{name}   execute a tool for an application (before funding)   body as for loans
 *   POST /v1/applications/{id}/disclosures/le       render, MLO-approve, deliver and record receipt of the initial LE (21.2's LoanEstimateService; the MLO of record is the actor)  body: { actor, render: {...LeRenderInput}, mlo: { review_id, nmlsr_id }, delivery: { channel, at?, consent?, receipt? } }
 *   POST /v1/applications/{id}/fund                 fund the application (30.2 hand-off → the servicing loan)  body: { actor, funded?: {...loan.funded overrides}, snapshot?: {...OriginationSnapshot overrides} }; the funded payload defaults to 26.3's `loan.funded` on the application's log, the snapshot to the record's closing facts + the demo fixture; 404 unknown application, 409 when boarding refuses
 *   GET  /v1/applications/{id}                      the application's record: row, events, open timers, decisions
 *   GET  /v1/applications                           the newest applications
 *   POST /v1/transfers/batches                      board a servicing-transfer batch  body: { actor, batch: {...}, files: { "boarding_tape.final.csv": "...", ... } }
 *   POST /v1/transfers/batches/demo                 board the built-in 100-loan demo batch (fixtures/transfer-batch-demo)
 *   POST /v1/entry/seed-demo                        32.14 demo seed (FAKE): readiness rows for the demo states, partner NMLSR ID, an active rate sheet (idempotent)
 *   GET  /v1/transfers/batches/{batchId}            a batch's boarding summary
 *   /v1/partner/*                                   36.1 the servicing partner portal (src/runtime/partner-portal/routes.ts) — a partner_sessions bearer only: the staff cookie, the header actor and API_TOKEN open nothing there (36.1-T7), and a partner session opens nothing on /ops or /v1/partner-book/* (36.1-T8)
 *   /ops, /ops/api/*, /api/*                        the ops console (src/console) — 34.1: a staff session (cookie sm_staff / a session bearer) names the human; x-actor-id / x-actor-role survive only for the deploy workflow behind the ops bearer outside production
 *
 *   Borrower API (docs/ux/02 §7; src/runtime/borrower/routes.ts) — authenticated by a borrower session token, never by API_TOKEN:
 *   POST /v1/borrower/auth/otp                      { action: request, channel: sms|email, destination } → { challenge_id, delivery: FAKE|sms|email, expires_at }; { action: verify, challenge_id, code } → L1 session { token, … } (with a bearer: refreshes that session's fresh-L1)
 *   POST /v1/borrower/auth/passkey                  WebAuthn { action: register_options | register | assert_options | assert, … } → options / registered credential / L1 session
 *   POST /v1/borrower/auth/l2                       { ssn_last4, date_of_birth } matched against application_borrowers → level L2
 *   POST /v1/borrower/identity/stripe/session       → ConnectCard + Stripe Identity session { vendor_session_id, client_secret, card_instance_id } (FakeStripeIdentity in nonprod)
 *   POST /v1/webhooks/stripe                        the vendor's webhook (stripe-signature) → 22.6 verifyIdentity on the bus, application_borrowers.prefill source=stripe_identity, the party's sessions → L3
 *   GET  /v1/borrower/me                            → { party, level, session, subjects[] }
 *   GET  /v1/borrower/deeplink/{token}              → { target } after L1; 7-day expiry; the token never encodes loan data
 *   POST /v1/borrower/documents                     multipart { file, application_id, document_class? } → 22.1 ingestDocument → { document_id, status, … }
 *   GET  /v1/borrower/documents/{id}                → { url, expires_at }: a signed 5-minute URL bound to the session (ui_events document_opened)
 *   GET  /v1/borrower/documents/{id}/content        the bytes behind that URL
 *   GET  /v1/borrower/record?subject=…              → borrower_record (02 §1.1): status badge, next, needed_from_you[], numbers, dates[], documents[], people[], property, loan, offers[]
 *   GET  /v1/borrower/thread?after=…                → thread_messages (02 §1.2), paged, with the pinned current ask
 *   GET  /v1/borrower/history/{view}?subject=…      → payments | escrow | statements | cases | lossmit (02 §1.5) for a serviced loan
 *   GET  /v1/borrower/stream                        → SSE {event_name, at, subject, payload_ref} (02 §3), fed from the runtime's post-commit hook; Last-Event-ID replays; heartbeat
 *   POST /v1/borrower/messages                      { text, channel?, subject? } → borrower message + reply; an affirmative to a pending card gets its deep link and executes nothing (13 T-X-05)
 *   POST /v1/borrower/cards/{id}/resolve            { option_id?, evidence?, args?, channel? } → evidence to card_instances + ui_events, then the card's 32.2 command on the bus; idempotent on card_instance_id
 *   POST /v1/borrower/commands/{name}               { …args, subject? } → one of the 45 32.2 commands (src/app/tools/section32-2.ts) as the `borrower-app` agent
 *   Errors on these routes are `{ code, gate?, copy_key }` (02 §7); responses pass the allow-list serializer (src/runtime/borrower/serialize.ts).
 *
 * Every route but the two probes and the borrower API requires `Authorization: Bearer <API_TOKEN>` (or the cookie /login sets).
 * Refusals from the command bus answer 409 with the guardrail's code and citation — so do a section's own typed refusals
 * (32.1's CardRefused, 25.3/26.3's RescissionRefused: `{ error: refused, code, reason }`); bad input 400; a tool whose
 * section service is not wired yet 501. Money in JSON is a decimal string of cents.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { CommandRefused, AiPathUnavailable } from "../app/commands.ts";
import { refuseClientState } from "../domain/operations-runtime/cashiering-cycle.ts";
import { CardRefused } from "../app/tools/section32-1.ts";
import { orchestrationByApplication, orchestrationOwnsHandoff } from "../domain/operations-runtime/orchestration-35-6.ts";
import { hasRole } from "../app/roles.ts";
import { SnapshotRefused } from "../domain/operations-runtime/snapshot-35-6.ts";
import { RescissionRefused } from "../domain/compliance-disclosures/ops-25-3.ts";
import { CyclesRefused } from "../domain/operations-runtime/service.ts";
import { PortUnavailable } from "../app/tools.ts";
// 35.11 rule 10: a port's own typed failure thrown by a tool (the FAKE bank's rejection of a date, a feed not yet refreshed) is a typed refusal the unit of work rolled back — never an unhandled 500
import { AdapterUnavailable, PermanentRejection, TransientFailure } from "../infra/integrations/failures.ts";
import { StaleRecord } from "../domain/operations-runtime/seam/guard.ts";
import { RoleDenied } from "../app/roles.ts";
import { StaffError } from "./staff/roles.ts";
import { PrincipalRefused } from "../domain/operations-runtime/roles-35-7/refusals.ts";
// 35.7 rule 2: the /v1 door — every bearer resolved to a principal before the route; dual control around the tools; one staff_actions row per request
import { V1Auth, actorOf, subjectIdOf, type PrincipalContext } from "../domain/operations-runtime/roles-35-7/v1-auth.ts";
import { executeWithControls } from "../domain/operations-runtime/roles-35-7/dual-control.ts";
import { currentFakeSet, envDefault } from "../domain/operations-runtime/roles-35-7/env.ts";
import type { Actor } from "../kernel/events/index.ts";
import { createConsoleServer } from "../console/server.ts";
import { PgConsoleStore } from "../console/pg-store.ts";
import type { ApplicationInput } from "../infra/db/applications.ts";
import { Runtime, ToolNotFound } from "./app.ts";
import { boardTransferBatch, type TransferBatchInput } from "./transfers.ts";
import { fundApplication, demoSnapshot, demoFunded, fundedFromLog, snapshotOverridesFromRecord, deliverLoanEstimate, ApplicationNotFound, BoardingRefused, type DemoOverrides, type LoanEstimateDeliveryInput } from "./origination.ts";
import type { LoanFundedPayload } from "../domain/orig-boarding/ops-30-2.ts";
import { generateDemoBatch, DEMO_BATCH } from "../domain/boarding/demo-batch.ts";
import { encodeTransferBatch, type TransferBatchFiles } from "../domain/boarding/tape-codec.ts";
import { isUuid } from "../infra/db/client.ts";
import { plainDate } from "../kernel/calendar/date.ts";
import type { Logger } from "./log.ts";
import { createBorrowerRouter, type BorrowerRouter, type BorrowerRouterOptions } from "./borrower/routes.ts";
import { partnerBookInput } from "./partner-book-input.ts";
import { handleVerifyRoute } from "./documents/verify-route.ts";
import { holdsOf, importPartnerBook, listPartnerBookImports, partnerBookReport, partnerBookStatus, resolvePartnerBookLoan, seedPartnerBookDemo } from "./partner-book.ts";
import { seedEntryDemo } from "./entry-seed.ts";
// 36.1: the partner portal's own prefix — resolves only a partner_sessions bearer (rule 7), dispatched before the /v1 door
import { createPartnerRouter } from "./partner-portal/routes.ts";
import { seedPartnerPortalDemo } from "./partner-portal/seed.ts";
import { OffsetClock, advanceDemoClock, demoClockStatus } from "./demo-clock.ts";
/** 35.12 Inputs and triggers: the /v1 posture routes as aliases of the process's tools (the body is the input). */
const POSTURE_V1_ROUTES: Readonly<Record<string, string>> = { "/v1/posture/manifests": "posture.record", "/v1/posture/check": "posture.check", "/v1/posture/scans": "data.scan" };

export interface ServerOptions { readonly runtime: Runtime; readonly apiToken: string; readonly logger: Logger; readonly console?: boolean;
  /** The borrower API's own dependencies (vendor fakes, rpId, environment); defaults to the FAKE vendors. */
  readonly borrower?: Omit<BorrowerRouterOptions, "runtime" | "logger">;
  /** A borrower router built by the caller (tests that hold its stream hub); `borrower` is ignored when given. */
  readonly borrowerRouter?: BorrowerRouter; }

const plain = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
export const toJson = (v: unknown): string => JSON.stringify(v, plain);
const send = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(toJson(body)); };

const MAX_BODY = 64 * 1024 * 1024;   // a transfer batch of a few thousand loans is tens of MB of CSV
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new RangeError(`request body over ${MAX_BODY} bytes`); chunks.push(c as Buffer); }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError("request body must be a JSON object");
  return v as Record<string, unknown>;
}
// 33.1 inputs: the upload body reader (multipart or JSON) lives in ./partner-book-input.ts, shared with 36.2's partner route
/**
 * Section 34 (review findings): none of the operator portal's tools (34.1 staff acts, 34.2 directory looks / unmask / export,
 * 34.3 book operations, 34.4 controls — the two-person kill switch, the evidence pack) runs on the generic tool routes — there
 * the actor is whatever the request body names, so one holder of the ops bearer token could mint an admin, trip or reset the
 * AI kill switch alone by naming two fabricated staff ids, or attribute a look or an export to a staff id with no row ("The
 * ops bearer token leaks → … in production it opens nothing"; 34.1 rule 3: "The actor on the bus is the session's"; 34.4 rule
 * 4: "two people's decision"). Their only HTTP entry is the console's session path (src/console/server.ts /ops/api/…), where
 * the actor is the signed-in staff member; the first admin comes from `main.ts staff-bootstrap`. The acts verify the actor
 * from rows as well (src/runtime/staff/auth.ts requireStaffActor, src/runtime/controls/common.ts requireStaffRole, the 34.2
 * tools' staffOf) — this refusal is the outer layer.
 */
const staffToolsOnly = (process: string): boolean => /^34\./.test(process);
const STAFF_TOOLS_REFUSED = { error: "forbidden", code: "STAFF_TOOLS_ARE_SESSION_ONLY", hint: "section 34 tools (34.1 staff, 34.2 directory, 34.3 book operations, 34.4 controls) run only on the ops console's session routes (/ops/api/…); the first admin is `main.ts staff-bootstrap <email>`" };
function tokenOf(req: IncomingMessage): string {
  const h = String(req.headers["authorization"] ?? "");
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  const m = /(?:^|;\s*)sm_token=([^;]+)/.exec(String(req.headers["cookie"] ?? ""));
  return m ? decodeURIComponent(m[1]!) : "";
}
const plainDateOf = (v: unknown) => plainDate(String(v));
/** JSON carries money as decimal strings of cents: every `*_cents` field in a snapshot/funded override becomes a bigint, dates stay PlainDate strings. */
function reviveCents(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reviveCents);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k.endsWith("_cents") && (typeof x === "string" || typeof x === "number") && x !== "" ? BigInt(x) : reviveCents(x)]));
  return v;
}
/** A tool's `input` from JSON: an object, with every `*_cents` field (at any depth) revived to the bigint the tools compute with — the wire convention is a decimal string of cents. */
function toolInput(v: unknown): Record<string, unknown> {
  if (!v) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new RangeError("input must be a JSON object");
  return reviveCents(v) as Record<string, unknown>;
}
const same = (a: string, b: string): boolean => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApiServer(opts: ServerOptions): Server {
  const { runtime, logger } = opts;
  // DELTA-30: the console's queue rows name the FAKE reviewer that will fill them (src/infra/integrations/reviewers.ts) when the runtime runs one
  // 34.1: the console resolves the staff session itself (cookie sm_staff / a session bearer) and honours the legacy x-actor-* headers only behind the ops bearer outside production — so /ops and its /api are dispatched before the token check below
  // 35.7 rule 6: the console's queue marking reads the CURRENT FAKE set from Postgres (the environment's default minus the roles handed over to a person)
  const fakeResolve = (): Promise<readonly string[]> => currentFakeSet(runtime.db, runtime.environment, envDefault(runtime.env, runtime.environment).roles.filter((r) => runtime.reviewers!.defaultRoles.includes(r)));
  const consoleServer = opts.console === false ? null : createConsoleServer({ store: new PgConsoleStore(runtime.db, runtime.registry, runtime.agents, { fakeReviewers: runtime.reviewers ? { roles: runtime.reviewers.roles, delaySeconds: runtime.reviewers.delaySeconds, resolve: fakeResolve } : null }), clock: runtime.clock, runtime, apiToken: opts.apiToken, environment: opts.borrower?.environment ?? runtime.environment, logger });
  // 35.7 rule 2: the /v1 door — the shared API_TOKEN outside production (source shared_token), else an api_principals row (source principal); production refuses the shared token
  const v1 = new V1Auth(runtime, { apiToken: opts.apiToken });
  // 35.2: the borrower router's object store is the runtime's (PgFakeBlobStore over document_blobs in every nonprod stage) unless the caller wires one
  const borrower = opts.borrowerRouter ?? createBorrowerRouter({ runtime, logger, blobs: runtime.blobs, ...(opts.borrower ?? {}) });
  // the demo clock routes refuse in production (docs/DEPLOY.md "The demo clock"); the runtime's environment is the one source (35.7), the borrower options may name it too
  const environment = opts.borrower?.environment ?? runtime.environment;
  // 36.1 rule 7: the partner prefix resolves its own sessions (never a staff cookie, a header actor or the ops token) — mounted after the existing /v1/partner-book/* machine routes in the path grammar (the prefixes never overlap) and before /ops/api/*, both unchanged
  const partner = createPartnerRouter({ runtime, logger, environment, ...(opts.borrower?.rpId !== undefined ? { rpId: opts.borrower.rpId } : {}), ...(opts.borrower?.allowedOrigins !== undefined ? { allowedOrigins: opts.borrower.allowedOrigins } : {}) });

  return createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://runtime");
    const method = req.method ?? "GET";
    const path = url.pathname;
    // 35.7 (34.1 rule 4 on /v1): one staff_actions row per /v1 request — ids and codes only, never the token
    let principal: PrincipalContext | null = null; let v1Route = false;
    const action = { subject_kind: null as string | null, subject_id: null as string | null, command: null as string | null, result: "ok" as "ok" | "refused" | "error", refusal_code: null as string | null, role: null as string | null };
    const done = (status: number, body: unknown, extra: Record<string, unknown> = {}): void => {
      if (status >= 400) { action.result = status >= 500 ? "error" : "refused"; const b = body as { code?: unknown } | null; action.refusal_code = b && typeof b === "object" && typeof b.code === "string" ? b.code : status === 401 ? "UNAUTHORIZED" : status === 404 ? "NOT_FOUND" : status >= 500 ? "INTERNAL" : "REFUSED"; }
      send(res, status, body);
      logger.info("http", { method, path, status, ms: Date.now() - started, ...extra });
    };
    /** The /v1 tool routes' actor (rule 2): the principal's, with the role the request names among the roles the person holds and the tool accepts. */
    const resolveActor = async (b: Record<string, unknown>, def: ReturnType<Runtime["tool"]>, subject: { loanId?: string | null; applicationId?: string | null }, process: string, fallback?: Actor): Promise<{ actor: Actor; grantRole: string | null }> => {
      const c = principal!; v1.scopeCheck(c, { ...subject, process });
      const r = await v1.actorFor(c, { method, headers: req.headers, body: b, accepted: V1Auth.acceptedFor(def), dualControl: def?.dualControl !== undefined, subject, now: runtime.clock.now(), ...(fallback ? { fallback } : {}) });
      action.role = r.role; return { actor: r.actor, grantRole: r.grantRole };
    };
    try {
      if (method === "GET" && path === "/healthz") { done(200, { ok: true }); return; }
      if (method === "GET" && path === "/readyz") { const ok = await runtime.ready(); done(ok ? 200 : 503, { ok, database: ok ? "reachable" : "unreachable" }); return; }
      // /login is how a browser presents the token (it cannot send the header), so it runs before the token check
      if (method === "GET" && path === "/login") {
        const t = url.searchParams.get("token") ?? "";
        if (!opts.apiToken || !same(t, opts.apiToken)) { done(401, { error: "unauthorized", hint: "GET /login?token=<API_TOKEN>: the token did not match" }); return; }
        res.writeHead(302, { location: "/ops", "set-cookie": `sm_token=${encodeURIComponent(t)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200` }); res.end();
        logger.info("http", { method, path: "/login", status: 302, ms: Date.now() - started }); return;
      }
      // 35.2 / 16.1 rule 9: the payoff verification portal is public — the token printed on the statement is the only key
      if (await handleVerifyRoute(runtime, req, res, url, method)) { logger.info("http", { method, path, status: res.statusCode, ms: Date.now() - started }); return; }
      // the borrower API authenticates its own sessions (and the vendor webhook its signature); the ops token is never accepted there
      if (await borrower.handle(req, res, url, method)) return;
      // 36.1: /v1/partner/* authenticates its own partner sessions and writes its own partner_actions row; the /v1 door below never sees it (no staff fallback, no staff_actions row)
      if (await partner.handle(req, res, url, method)) return;
      // 32.14 §6.3 / 34.1: the ops console page lives at /ops and its JSON API at /ops/api/* (and the legacy /api/*); the console authenticates its own staff sessions (src/console/server.ts) — the ops token is one way in only for the deploy workflow's header actor
      if (consoleServer && (path === "/ops" || path === "/ops/" || path === "/ops/index.html" || path.startsWith("/ops/api/") || path.startsWith("/api/"))) { consoleServer.emit("request", req, res); return; }
      v1Route = path.startsWith("/v1/");
      // the tool routes' command and subject are on the row even when the door refuses the bearer (T13: a refused request names its command)
      const pre = v1Route && method === "POST" ? /^\/v1\/(?:loans\/([^/]+)\/|applications\/([^/]+)\/)?tools\/([^/]+)\/([^/]+)$/.exec(path) : null;
      if (pre) { action.command = `${decodeURIComponent(pre[3]!)} ${decodeURIComponent(pre[4]!)}`; Object.assign(action, subjectIdOf(pre[1] ? decodeURIComponent(pre[1]) : "", pre[2] ? decodeURIComponent(pre[2]) : undefined)); }
      try { principal = await v1.resolve(req, runtime.clock.now()); } catch (e) { if (e instanceof PrincipalRefused && e.context) principal = e.context as PrincipalContext; throw e; }
      if (method === "GET" && path === "/v1/tools") { done(200, { tools: runtime.listTools() }); return; }
      let m: RegExpExecArray | null;
      // 35.12 Inputs: the deploy workflow's `POST /v1/posture/manifests` (posture.record, under a 35.7 service principal), `POST /v1/posture/check` and
      // `POST /v1/posture/scans` (the cycle or a compliance principal) — the body IS the tool input; the same door, bus and staff_actions row as the tool routes
      const postureAlias = method === "POST" ? POSTURE_V1_ROUTES[path] : undefined;
      if (postureAlias) {
        const b = await readJson(req);
        action.command = `35.12 ${postureAlias}`;
        const { actor, grantRole } = await resolveActor({}, runtime.tool("35.12", postureAlias), {}, "35.12");
        const r = await executeWithControls(runtime, { process: "35.12", name: postureAlias, loanId: "", actor, input: toolInput(b) }, { surface: "v1", source: principal!.source, requestId: null, grantRole });
        done(200, r, { tool: `35.12 ${postureAlias}`, actor: `${actor.kind}:${actor.id}`, events: r.events.length }); return;
      }
      if (method === "POST" && (m = /^\/v1\/(?:loans\/([^/]+)\/)?tools\/([^/]+)\/([^/]+)$/.exec(path))) {
        const loanId = m[1] ? decodeURIComponent(m[1]) : "";
        if (loanId && !isUuid(loanId)) throw new RangeError("loanId must be the loan's uuid (loans.id)");
        const process = decodeURIComponent(m[2]!); const name = decodeURIComponent(m[3]!);
        if (staffToolsOnly(process)) { done(403, STAFF_TOOLS_REFUSED, { tool: `${process} ${name}` }); return; }
        const b = await readJson(req);
        action.command = `${process} ${name}`; Object.assign(action, subjectIdOf(loanId, undefined));
        const { actor, grantRole } = await resolveActor(b, runtime.tool(process, name), { loanId: loanId || null }, process);
        const input = toolInput(b["input"]);
        refuseClientState(process, name, input);   // 35.5 rule 5: the cash state is the server's (NO_CLIENT_STATE, 409, nothing written)
        const run = b["run"] as { runId?: unknown; modelVersion?: unknown; promptVersion?: unknown; confidence?: unknown } | undefined;
        const runInfo = run && typeof run.runId === "string" && typeof run.modelVersion === "string" && typeof run.promptVersion === "string"
          ? { runId: run.runId, modelVersion: run.modelVersion, promptVersion: run.promptVersion, ...(typeof run.confidence === "number" ? { confidence: run.confidence } : {}) } : undefined;
        const r = await executeWithControls(runtime, { process, name, loanId, actor, input: loanId && input["loan_id"] === undefined ? { ...input, loan_id: loanId } : input, ...(runInfo ? { run: runInfo } : {}), ...(principal!.source === "shared_token" && b["approvedBy"] ? { approvedBy: actorOf(b["approvedBy"]) } : {}) }, { surface: "v1", source: principal!.source, requestId: typeof b["request_id"] === "string" ? b["request_id"] : null, grantRole });
        done(200, r, { tool: `${process} ${name}`, loan_id: loanId || null, actor: `${actor.kind}:${actor.id}`, events: r.events.length }); return;
      }
      if (method === "POST" && (m = /^\/v1\/applications\/([^/]+)\/tools\/([^/]+)\/([^/]+)$/.exec(path))) {
        const applicationId = decodeURIComponent(m[1]!);
        if (!isUuid(applicationId)) throw new RangeError("applicationId must be the application's uuid (applications.id)");
        const process = decodeURIComponent(m[2]!); const name = decodeURIComponent(m[3]!);
        if (staffToolsOnly(process)) { done(403, STAFF_TOOLS_REFUSED, { tool: `${process} ${name}` }); return; }
        const b = await readJson(req);
        action.command = `${process} ${name}`; Object.assign(action, subjectIdOf("", applicationId));
        const app = await runtime.applications.get(applicationId);
        if (!app) { done(404, { error: "no_such_application" }); return; }
        const loanId = app.loan_id ?? "";
        const { actor, grantRole } = await resolveActor(b, runtime.tool(process, name), { loanId: loanId || null, applicationId }, process);
        const input = toolInput(b["input"]);
        refuseClientState(process, name, input);   // 35.5 rule 5
        const run = b["run"] as { runId?: unknown; modelVersion?: unknown; promptVersion?: unknown; confidence?: unknown } | undefined;
        const runInfo = run && typeof run.runId === "string" && typeof run.modelVersion === "string" && typeof run.promptVersion === "string"
          ? { runId: run.runId, modelVersion: run.modelVersion, promptVersion: run.promptVersion, ...(typeof run.confidence === "number" ? { confidence: run.confidence } : {}) } : undefined;
        const r = await executeWithControls(runtime, { process, name, loanId, applicationId, actor, input: { ...(loanId && input["loan_id"] === undefined ? { loan_id: loanId } : {}), ...(input["application_id"] === undefined ? { application_id: applicationId } : {}), ...input }, ...(runInfo ? { run: runInfo } : {}), ...(principal!.source === "shared_token" && b["approvedBy"] ? { approvedBy: actorOf(b["approvedBy"]) } : {}) }, { surface: "v1", source: principal!.source, requestId: typeof b["request_id"] === "string" ? b["request_id"] : null, grantRole });
        done(200, r, { tool: `${process} ${name}`, application_id: applicationId, loan_id: loanId || null, actor: `${actor.kind}:${actor.id}`, events: r.events.length }); return;
      }
      if (method === "POST" && path === "/v1/applications") {
        const b = await readJson(req);
        action.command = "applications.create";
        const { actor } = await resolveActor(b, undefined, {}, "applications");
        const a = b["application"] as Record<string, unknown> | undefined;
        if (!a || typeof a !== "object") throw new RangeError("application is required: { partner_party_id, channel, transaction_type, occupancy, borrowers: [{ legal_name }], property? }");
        for (const k of ["partner_party_id", "channel", "transaction_type", "occupancy"]) if (typeof a[k] !== "string" || !a[k]) throw new RangeError(`application.${k} is required`);
        if (!Array.isArray(a["borrowers"]) || !a["borrowers"].length) throw new RangeError("application.borrowers must list at least one borrower { legal_name }");
        const r = await runtime.createApplication(a as unknown as ApplicationInput, actor);
        done(200, r, { application_id: r.application.id, timers: r.timers.length }); return;
      }
      if (method === "POST" && (m = /^\/v1\/applications\/([^/]+)\/fund$/.exec(path))) {
        const applicationId = decodeURIComponent(m[1]!);
        if (!isUuid(applicationId)) throw new RangeError("applicationId must be the application's uuid (applications.id)");
        const b = await readJson(req);
        action.command = "applications.fund"; Object.assign(action, subjectIdOf("", applicationId));
        const { actor } = await resolveActor(b, undefined, { applicationId }, "fund");
        const app = await runtime.applications.get(applicationId);
        if (!app) { done(404, { error: "no_such_application" }); return; }
        // 35.6 rule 6: an orchestrated application funds through `orchestration.snapshot` + `orchestration.fund` — the snapshot from the record, an officer's `snapshot` overrides only (NO_CLIENT_STATE otherwise), a `funded` override never (26.3's loan.funded is read from the log); a second call is the duplicate receipt
        const orch = await orchestrationByApplication(runtime.db, applicationId);
        // 35.6 rule 2 / rule 6 / T14: on an orchestrated application (the pass owns the hand-off) and in production, refused before anything is written — a `snapshot` correction is an officer's (a money-field change proposed by an agent has no officer approval record), `funded` is never a client's; the nonprod harness path of a row the pass does not yet own keeps 30.2's fixture fill (Discrepancies (1))
        const orchestrated = orch !== null || environment === "production";
        if (orchestrated && b["snapshot"] !== undefined && !hasRole(actor, ["officer"])) { done(409, { error: "refused", command: "orchestration.fund", code: "NO_CLIENT_STATE", citation: "35.6 rule 6: snapshot overrides only from an officer actor", reason: `a snapshot override is an officer's correction (${actor.kind}:${actor.id})` }, { refused: "NO_CLIENT_STATE" }); return; }
        if (orchestrated && b["funded"] !== undefined) { done(409, { error: "refused", command: "orchestration.fund", code: "NO_CLIENT_STATE", citation: "35.6 rule 2 / rule 6: 26.3's loan.funded is read from the log", reason: "a `funded` payload is never a client's" }, { refused: "NO_CLIENT_STATE" }); return; }
        // 35.6 edge case: a POST /fund on an application whose orchestration is not at `funded` (26.3's loan.funded not on the log) → NOT_FUNDED, unless an officer supplies 26.3's facts as a correction
        if (orch !== null && !orchestrationOwnsHandoff(orch) && !(await fundedFromLog(runtime, applicationId)) && !(hasRole(actor, ["officer"]) && b["snapshot"] !== undefined)) { done(409, { error: "refused", command: "orchestration.fund", code: "NOT_FUNDED", citation: "35.6 edge cases: a POST /fund on an application whose orchestration is not at funded is refused unless an officer supplies 26.3's facts as a correction", reason: `orchestration at ${orch.step} (${orch.status}); no loan.funded on the log` }, { refused: "NOT_FUNDED", step: orch.step }); return; }
        if (orchestrated) {
          const input: Record<string, unknown> = { ...(b["snapshot"] !== undefined ? { snapshot: b["snapshot"] } : {}) };
          if (!app.loan_id) { const snap = await runtime.execute({ process: "35.6", name: "orchestration.snapshot", loanId: "", applicationId, actor, input: {} }); input["snapshot_id"] = (snap.output as { snapshot_id: string | null }).snapshot_id; }
          const r = await runtime.execute({ process: "35.6", name: "orchestration.fund", loanId: "", applicationId, actor, input });
          const out = r.output as Record<string, unknown>;
          done(200, out, { application_id: applicationId, loan_id: out["loan_id"], status: out["status"], duplicate: out["duplicate"], events: out["events"], via: "35.6" }); return;
        }
        const snapshotOverrides = (b["snapshot"] && typeof b["snapshot"] === "object" ? reviveCents(b["snapshot"]) : {}) as DemoOverrides;
        const fundedOverrides = (b["funded"] && typeof b["funded"] === "object" ? reviveCents(b["funded"]) : {}) as Partial<LoanFundedPayload>;
        // the record first: the closing facts 26.1/26.2 wrote and 26.3's loan.funded; the body's overrides win; the demo fixture fills what the record does not carry
        const recorded = await snapshotOverridesFromRecord(runtime, applicationId);
        const base = demoSnapshot(app);
        const merged: Record<string, unknown> = { ...recorded, ...snapshotOverrides };
        for (const k of ["note", "closing"] as const) { const r = recorded[k] as Record<string, unknown> | undefined; const o = snapshotOverrides[k] as Record<string, unknown> | undefined; if (r || o) merged[k] = { ...(base[k] as Record<string, unknown>), ...(r ?? {}), ...(o ?? {}) }; }
        const snapshot = demoSnapshot(app, merged as DemoOverrides);
        const logged = Object.keys(fundedOverrides).length ? null : await fundedFromLog(runtime, applicationId);
        const funded = logged ?? demoFunded(applicationId, { ...fundedOverrides, ...(fundedOverrides.funding_date ? { funding_date: plainDateOf(fundedOverrides.funding_date) } : {}), ...(fundedOverrides.disbursement_date ? { disbursement_date: plainDateOf(fundedOverrides.disbursement_date) } : {}) });
        const r = await fundApplication(runtime, applicationId, snapshot, funded, actor);
        done(200, r, { application_id: applicationId, loan_id: r.loan_id, status: r.status, duplicate: r.duplicate, events: r.events }); return;
      }
      if (method === "POST" && (m = /^\/v1\/applications\/([^/]+)\/disclosures\/le$/.exec(path))) {
        const applicationId = decodeURIComponent(m[1]!);
        if (!isUuid(applicationId)) throw new RangeError("applicationId must be the application's uuid (applications.id)");
        const b = await readJson(req);
        action.command = "applications.disclosures.le"; Object.assign(action, subjectIdOf("", applicationId));
        const { actor } = await resolveActor(b, undefined, { applicationId }, "21.2");
        if (!b["render"] || typeof b["render"] !== "object" || !b["mlo"] || typeof b["mlo"] !== "object" || !b["delivery"] || typeof b["delivery"] !== "object") throw new RangeError("render, mlo { review_id, nmlsr_id } and delivery { channel } are required");
        // 32.5 T9: `delivery.deliveries[]` (one per consumer) rides through as-is — the bridge chooses LoanEstimateService.deliverPerBorrower; `delivery.channel` stays required as the governing channel
        const render = reviveCents(b["render"]) as Record<string, unknown>;
        const input: LoanEstimateDeliveryInput = { render: { ...render, as_of: plainDateOf(render["as_of"]), fees: ((render["fees"] as Record<string, unknown>[] | undefined) ?? []).map((f) => ({ ...f, estimated_at: plainDateOf(f["estimated_at"]) })) } as unknown as LoanEstimateDeliveryInput["render"], mlo: b["mlo"] as LoanEstimateDeliveryInput["mlo"], delivery: b["delivery"] as LoanEstimateDeliveryInput["delivery"] };
        const r = await deliverLoanEstimate(runtime, applicationId, input, actor);
        done(200, r, { application_id: applicationId, disclosure_id: r.disclosure_id, status: r.status, events: r.events }); return;
      }
      if (method === "GET" && path === "/v1/applications") { done(200, { applications: await runtime.applications.list() }); return; }
      if (method === "GET" && (m = /^\/v1\/applications\/([^/]+)$/.exec(path))) {
        const applicationId = decodeURIComponent(m[1]!);
        if (!isUuid(applicationId)) throw new RangeError("applicationId must be the application's uuid (applications.id)");
        const rec = await runtime.applicationRecord(applicationId);
        if (!rec) done(404, { error: "no_such_application" }); else done(200, rec);
        return;
      }
      if (method === "GET" && (m = /^\/v1\/loans\/([^/]+)\/(events|timers|ledger)$/.exec(path))) {
        const loanId = decodeURIComponent(m[1]!);
        if (!isUuid(loanId)) throw new RangeError("loanId must be the loan's uuid (loans.id)");
        if (m[2] === "events") done(200, { events: await runtime.uow.events.byLoan(loanId) });
        else if (m[2] === "timers") done(200, { timers: await runtime.uow.timers.open(loanId) });
        else done(200, { entry_sets: await runtime.uow.ledger.setsForLoan(loanId) });
        return;
      }
      // 32.14 demo seed (FAKE, idempotent): readiness rows for the demo states, the partner's NMLSR ID, an active rate sheet — src/runtime/entry-seed.ts
      if (method === "POST" && path === "/v1/entry/seed-demo") {
        const b = await readJson(req);
        const r = await seedEntryDemo(runtime, { ...(Array.isArray(b["states"]) ? { states: (b["states"] as unknown[]).map(String) } : {}), ...(typeof b["partner_id"] === "string" ? { partner_id: b["partner_id"] as string } : {}), ...(typeof b["nmlsr_id"] === "string" ? { nmlsr_id: b["nmlsr_id"] as string } : {}) });
        done(200, r, { partner: r.partner_id, written: r.written.length, rate_sheet: r.rate_sheet_id }); return;
      }
      if (method === "POST" && path === "/v1/transfers/batches/demo") {
        const b = await readJson(req);
        action.command = "transfers.batches.demo";
        const { actor } = await resolveActor(b, undefined, {}, "transfers", { kind: "system", id: "demo-seed" });
        const demo = generateDemoBatch();
        const r = await boardTransferBatch(runtime, { ...DEMO_BATCH }, encodeTransferBatch(demo, demo.coborrowers), actor, { synthetic: true });   // 35.12 rule 6: the demo batch is synthetic
        done(200, r, { batch: r.batch_id, status: r.status, boarded: r.loans.boarded }); return;
      }
      if (method === "POST" && path === "/v1/transfers/batches") {
        // 35.12 rule 6 — the door: nonprod boards a tape only under `X-Supermortgage-Synthetic: true` (REAL_DATA_REFUSED_IN_NONPROD); production refuses a tape with it (SYNTHETIC_REFUSED_IN_PRODUCTION); the rows it boards inherit the marker
        const syntheticHeader = String(req.headers["x-supermortgage-synthetic"] ?? "").trim().toLowerCase() === "true";
        const productionEnv = runtime.environment === "production" || runtime.environment === "prod";
        if (productionEnv && syntheticHeader) { action.command = "transfers.batches"; done(409, { error: "synthetic_refused_in_production", code: "SYNTHETIC_REFUSED_IN_PRODUCTION", reason: "a synthetic tape never boards in production (35.12 rule 6)" }); return; }
        if (!productionEnv && !syntheticHeader) { action.command = "transfers.batches"; done(409, { error: "real_data_refused_in_nonprod", code: "REAL_DATA_REFUSED_IN_NONPROD", reason: "nonprod boards synthetic tapes only: send X-Supermortgage-Synthetic: true (35.12 rule 6; docs/DEPLOY.md §7)" }); return; }
        const b = await readJson(req);
        action.command = "transfers.batches";
        const { actor } = await resolveActor(b, undefined, {}, "transfers");
        const batch = b["batch"] as Record<string, unknown> | undefined; const files = b["files"] as Record<string, unknown> | undefined;
        if (!batch || typeof batch !== "object") throw new RangeError("batch is required: { batch_id, transfer_date, transferor_name, transferor_servicer_number, partner_servicer_number, transferor_mers_org_id, partner_mers_org_id, ... }");
        if (!files || typeof files !== "object" || typeof files["boarding_tape.final.csv"] !== "string") throw new RangeError("files must carry the tape CSV texts; boarding_tape.final.csv is required");
        for (const k of ["batch_id", "transfer_date", "transferor_name", "transferor_servicer_number", "partner_servicer_number", "transferor_mers_org_id", "partner_mers_org_id"]) if (typeof batch[k] !== "string" || !batch[k]) throw new RangeError(`batch.${k} is required`);
        const input: TransferBatchInput = { ...(batch as unknown as TransferBatchInput), transfer_date: plainDateOf(batch["transfer_date"]), ...(batch["respa_effective_date"] ? { respa_effective_date: plainDateOf(batch["respa_effective_date"]) } : {}), ...(batch["sale_date"] ? { sale_date: plainDateOf(batch["sale_date"]) } : {}) };
        const empty = (): string => "";
        const f: TransferBatchFiles = { "boarding_tape.final.csv": String(files["boarding_tape.final.csv"]), "payment_history.csv": String(files["payment_history.csv"] ?? empty()), "escrow_history.csv": String(files["escrow_history.csv"] ?? empty()), "escrow_analysis.csv": String(files["escrow_analysis.csv"] ?? empty()),
          "lossmit_file.csv": String(files["lossmit_file.csv"] ?? empty()), "fc_bk_file.csv": String(files["fc_bk_file.csv"] ?? empty()), "consents_file.csv": String(files["consents_file.csv"] ?? empty()), "images_manifest.csv": String(files["images_manifest.csv"] ?? empty()), "trial_balance.csv": String(files["trial_balance.csv"] ?? empty()),
          "fnma_position.csv": String(files["fnma_position.csv"] ?? empty()), "mers_lookup.csv": String(files["mers_lookup.csv"] ?? empty()), "fair_lending.csv": String(files["fair_lending.csv"] ?? empty()) };
        const r = await boardTransferBatch(runtime, input, f, actor, { synthetic: syntheticHeader });
        done(200, r, { batch: r.batch_id, status: r.status, boarded: r.loans.boarded }); return;
      }
      if (method === "GET" && (m = /^\/v1\/transfers\/batches\/([^/]+)$/.exec(path))) {
        const rec = await runtime.entities.current("transfer_batches", decodeURIComponent(m[1]!));
        if (!rec) done(404, { error: "no_such_batch" }); else done(200, rec.data);
        return;
      }
      // 33.1 the partner book: the operator uploads the tape and the supplement (JSON content_base64 or multipart); the portfolio agent loads, provisions and invites — src/runtime/partner-book.ts
      if (method === "POST" && path === "/v1/partner-book/imports") {
        action.command = "book.import"; v1.scopeCheck(principal!, { process: "33.1" });
        const actorHeader = principal!.person?.id ?? String(req.headers["x-actor-id"] ?? "");
        // 35.12 rule 6: `X-Supermortgage-Synthetic: true` marks every party the import writes (a fixture book); production refuses it
        const syntheticBook = String(req.headers["x-supermortgage-synthetic"] ?? "").trim().toLowerCase() === "true";
        if (syntheticBook && (runtime.environment === "production" || runtime.environment === "prod")) { done(409, { error: "synthetic_refused_in_production", code: "SYNTHETIC_REFUSED_IN_PRODUCTION", reason: "a synthetic partner book never loads in production (35.12 rule 6)" }); return; }
        const input = { ...(await partnerBookInput(req)), ...(syntheticBook ? { synthetic: true } : {}) };
        const r = await importPartnerBook(runtime, input, { kind: "human", id: actorHeader || "ops", ...(req.headers["x-actor-role"] ? { role: String(req.headers["x-actor-role"]) } : { role: "ops_analyst" }) });
        done(200, r, { import: r.import_id, status: r.status, rows_total: r.rows_total, rows_loaded: r.rows_loaded, loans_created: r.loans_created, invitations_sent: r.invitations_sent }); return;
      }
      if (method === "GET" && path === "/v1/partner-book/imports") { done(200, { imports: await listPartnerBookImports(runtime, url.searchParams.get("partner_party_id") ?? undefined) }); return; }
      // 33.1 rule 8: the holds (loans absent from the partner's latest tape) and per partner "book as of <date>, next expected <date>"
      if (method === "GET" && path === "/v1/partner-book/holds") { done(200, { as_of: runtime.clock.now(), partners: await partnerBookStatus(runtime), holds: await holdsOf(runtime, url.searchParams.get("partner_party_id")) }); return; }
      // 33.1 rule 8: `book.resolve{loan_id, resolution ∈ paid_off | transferred_out | keep, reason}` — an ops_analyst act on the bus (x-actor-role defaults to ops_analyst; any other role is refused ROLE_DENIED)
      if (method === "POST" && (m = /^\/v1\/partner-book\/loans\/([^/]+)\/resolve$/.exec(path))) {
        const b = await readJson(req);
        action.command = "book.resolve"; action.subject_kind = "loan"; action.subject_id = decodeURIComponent(m[1]!); v1.scopeCheck(principal!, { process: "33.1" });
        const actorHeader = principal!.person?.id ?? String(req.headers["x-actor-id"] ?? "");
        const r = await resolvePartnerBookLoan(runtime, decodeURIComponent(m[1]!), { resolution: String(b["resolution"] ?? ""), reason: String(b["reason"] ?? "") }, { kind: "human", id: actorHeader || "ops", ...(req.headers["x-actor-role"] ? { role: String(req.headers["x-actor-role"]) } : { role: "ops_analyst" }) });
        done(200, { ...(r.output as Record<string, unknown>), events: r.events, decision_id: r.decision_id }, { loan: decodeURIComponent(m[1]!), resolution: String(b["resolution"] ?? "") }); return;
      }
      if (method === "GET" && (m = /^\/v1\/partner-book\/imports\/([^/]+)$/.exec(path))) {
        const r = await partnerBookReport(runtime, decodeURIComponent(m[1]!));
        if (!r) done(404, { error: "no_such_import" }); else done(200, r);
        return;
      }
      // 33.1 rule 7: the fixture book under the demo partner (FAKE, idempotent — already_loaded on a rerun); never in production
      if (method === "POST" && path === "/v1/partner-book/seed-demo") {
        if (environment === "production") { done(403, { error: "forbidden", reason: "the demo book does not exist in production (ENVIRONMENT=production)" }); return; }
        const b = await readJson(req);
        const r = await seedPartnerBookDemo(runtime, { ...(typeof b["partner_id"] === "string" ? { partner_id: b["partner_id"] as string } : {}) });
        // 36.1 Operational prerequisites: the demo partner's first partner_admin beside the book (idempotent; never in production)
        const portal = await seedPartnerPortalDemo(runtime, { partner_id: r.partner_party_id });
        done(200, { ...r, partner_portal: portal }, { import: r.import_id, status: r.status, rows_loaded: r.rows_loaded, invitations_sent: r.invitations_sent, partner_admin: portal.partner_user_id, partner_admin_created: portal.created }); return;
      }
      // the demo clock (src/runtime/demo-clock.ts): advance the hosted demo through days in minutes, running the sweep minute for every calendar day crossed; ops token; never in production
      if (path === "/v1/demo/clock" || path === "/v1/demo/advance") {
        if (environment === "production") { done(403, { error: "forbidden", reason: "the demo clock does not exist in production (ENVIRONMENT=production)" }); return; }
        const clock = runtime.clock;
        if (!(clock instanceof OffsetClock)) { done(501, { error: "not_wired", reason: "the runtime's clock is not the demo OffsetClock (src/runtime/main.ts constructs it outside production)" }); return; }
        if (method === "GET" && path === "/v1/demo/clock") { done(200, await demoClockStatus(runtime.db, clock)); return; }
        if (method === "POST" && path === "/v1/demo/advance") {
          const b = await readJson(req);
          action.command = "demo.advance";
          const { actor } = await resolveActor(b, undefined, {}, "demo", { kind: "human", id: "ops" });
          const r = await advanceDemoClock({ runtime, clock, flows: borrower.flows, logger, actor: `${actor.kind}:${actor.id}` }, { to: b["to"], days: b["days"], budget_ms: b["budget_ms"] });
          done(200, r, { advanced: r.advanced, complete: r.complete, from: r.from, to: r.to, days_crossed: r.days_crossed, steps: r.steps.length, steps_remaining: r.steps_remaining, due: r.due, breaches: r.breaches }); return;
        }
        done(404, { error: "not found" }); return;
      }
      if (method === "POST" && path === "/v1/sweep") { action.command = "sweep"; v1.scopeCheck(principal!, { process: "sweep" }); if (borrower.flows) await borrower.flows.tick(runtime.clock.now()); const report = await runtime.sweep(); done(200, report, { due: report.due, breaches: report.breaches.length }); return; }
      done(404, { error: "not found" });
    } catch (e) {
      if (e instanceof CommandRefused) { done(409, { error: "refused", command: e.command, code: e.code, citation: e.citation, reason: e.message }, { refused: e.code }); return; }
      // 35.1 rule 8: the expected-version guard (declared or mechanical) refuses the whole command — nothing was written; the API log carries the refusal (open question 5)
      if (e instanceof StaleRecord) { done(409, e.toJSON(), { refused: e.code }); return; }
      // 35.7: the typed refusals of the /v1 door (PRINCIPAL_*, NO_SELF_ASSERTED_ACTOR, SHARED_TOKEN_REFUSED_IN_PRODUCTION, …), of dual control (APPROVER_DISTINCT{request_id}) and of the roles' tools — status, code and extras
      if (e instanceof StaffError) { done(e.status, { error: e.code.toLowerCase(), code: e.code, reason: e.message, ...e.extra }, { refused: e.code }); return; }
      // a section's own typed refusal thrown by its tool (not a bus guardrail): the same 409 shape, its code and reason kept (32.5 T10, 32.7 T6)
      if (e instanceof CardRefused) { done(409, { error: "refused", code: e.code, reason: e.message }, { refused: e.code }); return; }
      if (e instanceof RescissionRefused) { done(409, { error: "refused", code: e.code, citation: e.citation, reason: e.message }, { refused: e.code }); return; }
      // 35.3's own typed refusal (RUN_NOT_FOUND, JOB_NOT_DEAD, RECEIPT_ONCE, …): the same 409 shape with its code and detail — a typed refusal the unit of work rolled back, never a 500 (35.11 rule 10's `refused_typed`)
      if (e instanceof CyclesRefused) { done(409, { error: "refused", code: e.code, reason: e.message, ...e.detail }, { refused: e.code }); return; }
      if (e instanceof BoardingRefused) { done(409, { error: "refused", command: "applications.fund", code: e.code, citation: "30.2 rule 2 / OB-018: boarding is refused until the source record is corrected", reason: e.message, application_id: e.applicationId, validations: e.validations }, { refused: e.code }); return; }
      if (e instanceof ApplicationNotFound) { done(404, { error: "no_such_application", reason: e.message }); return; }
      // 35.6 rule 6: the hand-off refused by the snapshot (FIXTURE_REFUSED in production, SNAPSHOT_GAP, NO_LOAN_FUNDED) — the same 409 shape with the paths
      if (e instanceof SnapshotRefused) { done(409, { error: "refused", command: "orchestration.fund", code: e.code, citation: "35.6 rule 6: the hand-off snapshot is built from the record; a production gap refuses the hand-off", reason: e.message, gaps: e.gaps }, { refused: e.code }); return; }
      if (e instanceof RoleDenied) { done(403, { error: "role_denied", reason: e.message }); return; }
      if (e instanceof AiPathUnavailable) { done(503, { error: "ai_path_unavailable", reason: e.message }); return; }
      if (e instanceof ToolNotFound) { done(404, { error: "no_such_tool", reason: e.message }); return; }
      if (e instanceof PortUnavailable) { done(501, { error: "not_wired", reason: e.message }); return; }
      if (e instanceof PermanentRejection) { done(409, { error: "refused", code: `PORT_REJECTED:${e.code}`, kind: "rejected", reason: e.message, details: [...e.details] }, { refused: `PORT_REJECTED:${e.code}` }); return; }
      if (e instanceof TransientFailure) { done(409, { error: "refused", code: "PORT_TRANSIENT", kind: "transient", retryable: true, reason: e.message }, { refused: "PORT_TRANSIENT" }); return; }
      if (e instanceof AdapterUnavailable) { done(409, { error: "refused", code: "PORT_UNAVAILABLE", kind: "unavailable", fallback: e.fallbackKind, reason: e.message }, { refused: "PORT_UNAVAILABLE" }); return; }
      if (e instanceof RangeError || e instanceof TypeError || e instanceof SyntaxError) { done(400, { error: "bad_request", reason: e.message }); return; }
      logger.error("unhandled", { method, path, error: e });
      done(500, { error: "internal" });
    } finally {
      // 35.7 (34.1 rule 4): every /v1 request leaves a staff_actions row — surface v1, the principal (or the shared token), ids and codes only, never the token
      if (v1Route) { const q = new URL(url.toString()); q.searchParams.delete("email"); await v1.log({ context: principal, at: new Date(started).toISOString(), route: q.pathname + q.search, method, subject_kind: action.subject_kind, subject_id: action.subject_id, command: action.command, result: action.result, refusal_code: action.refusal_code, role: action.role }); }
    }
  });
}

export function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { const a = server.address(); resolve(typeof a === "object" && a ? a.port : port); }); });
}
