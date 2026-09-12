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
 *   /, /index.html, /api/*                          the ops console (src/console) — its x-actor-id / x-actor-role headers name the human
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
import { CardRefused } from "../app/tools/section32-1.ts";
import { RescissionRefused } from "../domain/compliance-disclosures/ops-25-3.ts";
import { PortUnavailable } from "../app/tools.ts";
import { RoleDenied } from "../app/roles.ts";
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
import { seedEntryDemo } from "./entry-seed.ts";
import { OffsetClock, advanceDemoClock, demoClockStatus } from "./demo-clock.ts";

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
const ACTOR_KINDS = new Set(["human", "agent", "system"]);
function actorOf(v: unknown): Actor {
  const a = v as { kind?: unknown; id?: unknown; role?: unknown } | undefined;
  if (!a || typeof a !== "object" || typeof a.kind !== "string" || !ACTOR_KINDS.has(a.kind) || typeof a.id !== "string" || !a.id) throw new RangeError("actor must be { kind: human|agent|system, id, role? }");
  if (a.role !== undefined && typeof a.role !== "string") throw new RangeError("actor.role must be a string");
  return { kind: a.kind as Actor["kind"], id: a.id, ...(typeof a.role === "string" ? { role: a.role } : {}) };
}
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
  const consoleServer = opts.console === false ? null : createConsoleServer({ store: new PgConsoleStore(runtime.db, runtime.registry, runtime.agents, { fakeReviewers: runtime.reviewers ? { roles: runtime.reviewers.roles, delaySeconds: runtime.reviewers.delaySeconds } : null }), clock: runtime.clock });
  const authorized = (req: IncomingMessage): boolean => (opts.apiToken ? same(tokenOf(req), opts.apiToken) : true);
  const borrower = opts.borrowerRouter ?? createBorrowerRouter({ runtime, logger, ...(opts.borrower ?? {}) });
  // the demo clock routes refuse in production (docs/DEPLOY.md "The demo clock"); the borrower options carry the environment main.ts read from ENVIRONMENT
  const environment = opts.borrower?.environment ?? process.env["ENVIRONMENT"] ?? "nonprod";

  return createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://runtime");
    const method = req.method ?? "GET";
    const path = url.pathname;
    const done = (status: number, body: unknown, extra: Record<string, unknown> = {}): void => {
      send(res, status, body);
      logger.info("http", { method, path, status, ms: Date.now() - started, ...extra });
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
      // the borrower API authenticates its own sessions (and the vendor webhook its signature); the ops token is never accepted there
      if (await borrower.handle(req, res, url, method)) return;
      if (!authorized(req)) { done(401, { error: "unauthorized", hint: "Authorization: Bearer <API_TOKEN>" }); return; }
      if (method === "GET" && path === "/v1/tools") { done(200, { tools: runtime.listTools() }); return; }
      let m: RegExpExecArray | null;
      if (method === "POST" && (m = /^\/v1\/(?:loans\/([^/]+)\/)?tools\/([^/]+)\/([^/]+)$/.exec(path))) {
        const loanId = m[1] ? decodeURIComponent(m[1]) : "";
        if (loanId && !isUuid(loanId)) throw new RangeError("loanId must be the loan's uuid (loans.id)");
        const process = decodeURIComponent(m[2]!); const name = decodeURIComponent(m[3]!);
        const b = await readJson(req);
        const actor = actorOf(b["actor"]);
        const input = toolInput(b["input"]);
        const run = b["run"] as { runId?: unknown; modelVersion?: unknown; promptVersion?: unknown; confidence?: unknown } | undefined;
        const runInfo = run && typeof run.runId === "string" && typeof run.modelVersion === "string" && typeof run.promptVersion === "string"
          ? { runId: run.runId, modelVersion: run.modelVersion, promptVersion: run.promptVersion, ...(typeof run.confidence === "number" ? { confidence: run.confidence } : {}) } : undefined;
        const r = await runtime.execute({ process, name, loanId, actor, input: loanId && input["loan_id"] === undefined ? { ...input, loan_id: loanId } : input, ...(runInfo ? { run: runInfo } : {}), ...(b["approvedBy"] ? { approvedBy: actorOf(b["approvedBy"]) } : {}) });
        done(200, r, { tool: `${process} ${name}`, loan_id: loanId || null, actor: `${actor.kind}:${actor.id}`, events: r.events.length }); return;
      }
      if (method === "POST" && (m = /^\/v1\/applications\/([^/]+)\/tools\/([^/]+)\/([^/]+)$/.exec(path))) {
        const applicationId = decodeURIComponent(m[1]!);
        if (!isUuid(applicationId)) throw new RangeError("applicationId must be the application's uuid (applications.id)");
        const process = decodeURIComponent(m[2]!); const name = decodeURIComponent(m[3]!);
        const b = await readJson(req);
        const actor = actorOf(b["actor"]);
        const input = toolInput(b["input"]);
        const app = await runtime.applications.get(applicationId);
        if (!app) { done(404, { error: "no_such_application" }); return; }
        const loanId = app.loan_id ?? "";
        const run = b["run"] as { runId?: unknown; modelVersion?: unknown; promptVersion?: unknown; confidence?: unknown } | undefined;
        const runInfo = run && typeof run.runId === "string" && typeof run.modelVersion === "string" && typeof run.promptVersion === "string"
          ? { runId: run.runId, modelVersion: run.modelVersion, promptVersion: run.promptVersion, ...(typeof run.confidence === "number" ? { confidence: run.confidence } : {}) } : undefined;
        const r = await runtime.execute({ process, name, loanId, applicationId, actor, input: { ...(loanId && input["loan_id"] === undefined ? { loan_id: loanId } : {}), ...(input["application_id"] === undefined ? { application_id: applicationId } : {}), ...input }, ...(runInfo ? { run: runInfo } : {}), ...(b["approvedBy"] ? { approvedBy: actorOf(b["approvedBy"]) } : {}) });
        done(200, r, { tool: `${process} ${name}`, application_id: applicationId, loan_id: loanId || null, actor: `${actor.kind}:${actor.id}`, events: r.events.length }); return;
      }
      if (method === "POST" && path === "/v1/applications") {
        const b = await readJson(req);
        const actor = actorOf(b["actor"]);
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
        const actor = actorOf(b["actor"]);
        const app = await runtime.applications.get(applicationId);
        if (!app) { done(404, { error: "no_such_application" }); return; }
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
        const actor = actorOf(b["actor"]);
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
        const actor = b["actor"] ? actorOf(b["actor"]) : { kind: "system" as const, id: "demo-seed" };
        const demo = generateDemoBatch();
        const r = await boardTransferBatch(runtime, { ...DEMO_BATCH }, encodeTransferBatch(demo, demo.coborrowers), actor);
        done(200, r, { batch: r.batch_id, status: r.status, boarded: r.loans.boarded }); return;
      }
      if (method === "POST" && path === "/v1/transfers/batches") {
        const b = await readJson(req);
        const actor = actorOf(b["actor"]);
        const batch = b["batch"] as Record<string, unknown> | undefined; const files = b["files"] as Record<string, unknown> | undefined;
        if (!batch || typeof batch !== "object") throw new RangeError("batch is required: { batch_id, transfer_date, transferor_name, transferor_servicer_number, partner_servicer_number, transferor_mers_org_id, partner_mers_org_id, ... }");
        if (!files || typeof files !== "object" || typeof files["boarding_tape.final.csv"] !== "string") throw new RangeError("files must carry the tape CSV texts; boarding_tape.final.csv is required");
        for (const k of ["batch_id", "transfer_date", "transferor_name", "transferor_servicer_number", "partner_servicer_number", "transferor_mers_org_id", "partner_mers_org_id"]) if (typeof batch[k] !== "string" || !batch[k]) throw new RangeError(`batch.${k} is required`);
        const input: TransferBatchInput = { ...(batch as unknown as TransferBatchInput), transfer_date: plainDateOf(batch["transfer_date"]), ...(batch["respa_effective_date"] ? { respa_effective_date: plainDateOf(batch["respa_effective_date"]) } : {}), ...(batch["sale_date"] ? { sale_date: plainDateOf(batch["sale_date"]) } : {}) };
        const empty = (): string => "";
        const f: TransferBatchFiles = { "boarding_tape.final.csv": String(files["boarding_tape.final.csv"]), "payment_history.csv": String(files["payment_history.csv"] ?? empty()), "escrow_history.csv": String(files["escrow_history.csv"] ?? empty()), "escrow_analysis.csv": String(files["escrow_analysis.csv"] ?? empty()),
          "lossmit_file.csv": String(files["lossmit_file.csv"] ?? empty()), "fc_bk_file.csv": String(files["fc_bk_file.csv"] ?? empty()), "consents_file.csv": String(files["consents_file.csv"] ?? empty()), "images_manifest.csv": String(files["images_manifest.csv"] ?? empty()), "trial_balance.csv": String(files["trial_balance.csv"] ?? empty()),
          "fnma_position.csv": String(files["fnma_position.csv"] ?? empty()), "mers_lookup.csv": String(files["mers_lookup.csv"] ?? empty()), "fair_lending.csv": String(files["fair_lending.csv"] ?? empty()) };
        const r = await boardTransferBatch(runtime, input, f, actor);
        done(200, r, { batch: r.batch_id, status: r.status, boarded: r.loans.boarded }); return;
      }
      if (method === "GET" && (m = /^\/v1\/transfers\/batches\/([^/]+)$/.exec(path))) {
        const rec = await runtime.entities.current("transfer_batches", decodeURIComponent(m[1]!));
        if (!rec) done(404, { error: "no_such_batch" }); else done(200, rec.data);
        return;
      }
      // the demo clock (src/runtime/demo-clock.ts): advance the hosted demo through days in minutes, running the sweep minute for every calendar day crossed; ops token; never in production
      if (path === "/v1/demo/clock" || path === "/v1/demo/advance") {
        if (environment === "production") { done(403, { error: "forbidden", reason: "the demo clock does not exist in production (ENVIRONMENT=production)" }); return; }
        const clock = runtime.clock;
        if (!(clock instanceof OffsetClock)) { done(501, { error: "not_wired", reason: "the runtime's clock is not the demo OffsetClock (src/runtime/main.ts constructs it outside production)" }); return; }
        if (method === "GET" && path === "/v1/demo/clock") { done(200, await demoClockStatus(runtime.db, clock)); return; }
        if (method === "POST" && path === "/v1/demo/advance") {
          const b = await readJson(req);
          const actor = b["actor"] ? actorOf(b["actor"]) : { kind: "human" as const, id: "ops" };
          const r = await advanceDemoClock({ runtime, clock, flows: borrower.flows, logger, actor: `${actor.kind}:${actor.id}` }, { to: b["to"], days: b["days"], budget_ms: b["budget_ms"] });
          done(200, r, { advanced: r.advanced, complete: r.complete, from: r.from, to: r.to, days_crossed: r.days_crossed, steps: r.steps.length, steps_remaining: r.steps_remaining, due: r.due, breaches: r.breaches }); return;
        }
        done(404, { error: "not found" }); return;
      }
      if (method === "POST" && path === "/v1/sweep") { if (borrower.flows) await borrower.flows.tick(runtime.clock.now()); const report = await runtime.sweep(); done(200, report, { due: report.due, breaches: report.breaches.length }); return; }
      // 32.14 §6.3: the root of the host is the borrower thread (the load balancer sends / to /app); the ops console page lives at /ops and its JSON API stays at /api/*
      if (consoleServer && (path === "/ops" || path === "/ops/" || path === "/ops/index.html" || path.startsWith("/api/"))) { consoleServer.emit("request", req, res); return; }
      done(404, { error: "not found" });
    } catch (e) {
      if (e instanceof CommandRefused) { done(409, { error: "refused", command: e.command, code: e.code, citation: e.citation, reason: e.message }, { refused: e.code }); return; }
      // a section's own typed refusal thrown by its tool (not a bus guardrail): the same 409 shape, its code and reason kept (32.5 T10, 32.7 T6)
      if (e instanceof CardRefused) { done(409, { error: "refused", code: e.code, reason: e.message }, { refused: e.code }); return; }
      if (e instanceof RescissionRefused) { done(409, { error: "refused", code: e.code, citation: e.citation, reason: e.message }, { refused: e.code }); return; }
      if (e instanceof BoardingRefused) { done(409, { error: "refused", command: "applications.fund", code: e.code, citation: "30.2 rule 2 / OB-018: boarding is refused until the source record is corrected", reason: e.message, application_id: e.applicationId, validations: e.validations }, { refused: e.code }); return; }
      if (e instanceof ApplicationNotFound) { done(404, { error: "no_such_application", reason: e.message }); return; }
      if (e instanceof RoleDenied) { done(403, { error: "role_denied", reason: e.message }); return; }
      if (e instanceof AiPathUnavailable) { done(503, { error: "ai_path_unavailable", reason: e.message }); return; }
      if (e instanceof ToolNotFound) { done(404, { error: "no_such_tool", reason: e.message }); return; }
      if (e instanceof PortUnavailable) { done(501, { error: "not_wired", reason: e.message }); return; }
      if (e instanceof RangeError || e instanceof TypeError || e instanceof SyntaxError) { done(400, { error: "bad_request", reason: e.message }); return; }
      logger.error("unhandled", { method, path, error: e });
      done(500, { error: "internal" });
    }
  });
}

export function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { const a = server.address(); resolve(typeof a === "object" && a ? a.port : port); }); });
}
