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
 *   /, /index.html, /api/*                          the ops console (src/console) — its x-actor-id / x-actor-role headers name the human
 *
 * Every route but the two probes requires `Authorization: Bearer <API_TOKEN>` (or the cookie /login sets).
 * Refusals from the command bus answer 409 with the guardrail's code and citation; bad input 400; a
 * tool whose section service is not wired yet 501. Money in JSON is a decimal string of cents.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { CommandRefused, AiPathUnavailable } from "../app/commands.ts";
import { PortUnavailable } from "../app/tools.ts";
import { RoleDenied } from "../app/roles.ts";
import type { Actor } from "../kernel/events/index.ts";
import { createConsoleServer } from "../console/server.ts";
import { PgConsoleStore } from "../console/pg-store.ts";
import { Runtime, ToolNotFound } from "./app.ts";
import { isUuid } from "../infra/db/client.ts";
import type { Logger } from "./log.ts";

export interface ServerOptions { readonly runtime: Runtime; readonly apiToken: string; readonly logger: Logger; readonly console?: boolean; }

const plain = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
export const toJson = (v: unknown): string => JSON.stringify(v, plain);
const send = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(toJson(body)); };

const MAX_BODY = 4 * 1024 * 1024;
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
const same = (a: string, b: string): boolean => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApiServer(opts: ServerOptions): Server {
  const { runtime, logger } = opts;
  const consoleServer = opts.console === false ? null : createConsoleServer({ store: new PgConsoleStore(runtime.db, runtime.registry, runtime.agents), clock: runtime.clock });
  const authorized = (req: IncomingMessage): boolean => (opts.apiToken ? same(tokenOf(req), opts.apiToken) : true);

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
      if (!authorized(req)) { done(401, { error: "unauthorized", hint: "Authorization: Bearer <API_TOKEN>" }); return; }
      if (method === "GET" && path === "/login") {
        const t = url.searchParams.get("token") ?? "";
        if (!opts.apiToken || !same(t, opts.apiToken)) { done(401, { error: "unauthorized" }); return; }
        res.writeHead(302, { location: "/", "set-cookie": `sm_token=${encodeURIComponent(t)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200` }); res.end();
        logger.info("http", { method, path: "/login", status: 302, ms: Date.now() - started }); return;
      }
      if (method === "GET" && path === "/v1/tools") { done(200, { tools: runtime.listTools() }); return; }
      let m: RegExpExecArray | null;
      if (method === "POST" && (m = /^\/v1\/(?:loans\/([^/]+)\/)?tools\/([^/]+)\/([^/]+)$/.exec(path))) {
        const loanId = m[1] ? decodeURIComponent(m[1]) : "";
        if (loanId && !isUuid(loanId)) throw new RangeError("loanId must be the loan's uuid (loans.id)");
        const process = decodeURIComponent(m[2]!); const name = decodeURIComponent(m[3]!);
        const b = await readJson(req);
        const actor = actorOf(b["actor"]);
        const input = (b["input"] ?? {}) as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new RangeError("input must be a JSON object");
        const run = b["run"] as { runId?: unknown; modelVersion?: unknown; promptVersion?: unknown; confidence?: unknown } | undefined;
        const runInfo = run && typeof run.runId === "string" && typeof run.modelVersion === "string" && typeof run.promptVersion === "string"
          ? { runId: run.runId, modelVersion: run.modelVersion, promptVersion: run.promptVersion, ...(typeof run.confidence === "number" ? { confidence: run.confidence } : {}) } : undefined;
        const r = await runtime.execute({ process, name, loanId, actor, input: loanId && input["loan_id"] === undefined ? { ...input, loan_id: loanId } : input, ...(runInfo ? { run: runInfo } : {}), ...(b["approvedBy"] ? { approvedBy: actorOf(b["approvedBy"]) } : {}) });
        done(200, r, { tool: `${process} ${name}`, loan_id: loanId || null, actor: `${actor.kind}:${actor.id}`, events: r.events.length }); return;
      }
      if (method === "GET" && (m = /^\/v1\/loans\/([^/]+)\/(events|timers|ledger)$/.exec(path))) {
        const loanId = decodeURIComponent(m[1]!);
        if (!isUuid(loanId)) throw new RangeError("loanId must be the loan's uuid (loans.id)");
        if (m[2] === "events") done(200, { events: await runtime.uow.events.byLoan(loanId) });
        else if (m[2] === "timers") done(200, { timers: await runtime.uow.timers.open(loanId) });
        else done(200, { entry_sets: await runtime.uow.ledger.setsForLoan(loanId) });
        return;
      }
      if (method === "POST" && path === "/v1/sweep") { const report = await runtime.sweep(); done(200, report, { due: report.due, breaches: report.breaches.length }); return; }
      if (consoleServer && (path === "/" || path === "/index.html" || path.startsWith("/api/"))) { consoleServer.emit("request", req, res); return; }
      done(404, { error: "not found" });
    } catch (e) {
      if (e instanceof CommandRefused) { done(409, { error: "refused", command: e.command, code: e.code, citation: e.citation, reason: e.message }, { refused: e.code }); return; }
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
