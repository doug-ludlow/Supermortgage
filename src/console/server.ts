/**
 * Ops console HTTP server — JSON API + the single-page UI. The actor comes
 * from `x-actor-id` / `x-actor-role` headers (the SSO/IdP integration of
 * 19.2 sets them at the edge; in development the UI's role picker does).
 * Read-only roles (auditor, examiner) can look at everything and change
 * nothing; every request is written to the access log (19.2 "examiner
 * accounts … logged").
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Actor } from "../kernel/events/index.ts";
import { type ConsoleStore, READ_ONLY_ROLES, CONSOLE_ROLES } from "./store.ts";

export interface ConsoleServerOptions { readonly store: ConsoleStore; readonly clock?: { now(): string }; readonly uiHtml?: string; }

const UI_PATH = fileURLToPath(new URL("./ui/index.html", import.meta.url));

function actorOf(req: IncomingMessage): Actor | null {
  const id = String(req.headers["x-actor-id"] ?? "").trim(); const role = String(req.headers["x-actor-role"] ?? "").trim();
  if (!id || !role) return null;
  if (!(CONSOLE_ROLES as readonly string[]).includes(role)) return null;
  return { kind: "human", id, role };
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8"); return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
const json = (res: ServerResponse, status: number, data: unknown): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };

export function createConsoleServer(opts: ConsoleServerOptions): Server {
  const { store } = opts; const clock = opts.clock ?? { now: () => new Date().toISOString() };
  const ui = opts.uiHtml ?? readFileSync(UI_PATH, "utf8");
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://console");
      // "/" standalone (npm run console); "/ops" behind the API (32.14 §6.3)
      if (req.method === "GET" && ["/", "/index.html", "/ops", "/ops/", "/ops/index.html"].includes(url.pathname)) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(ui); return; }
      if (url.pathname === "/api/roles") { json(res, 200, { roles: CONSOLE_ROLES, readOnly: [...READ_ONLY_ROLES] }); return; }
      const actor = actorOf(req);
      if (!actor) { json(res, 401, { error: "x-actor-id and a valid x-actor-role are required" }); return; }
      const now = clock.now();
      await store.logAccess({ at: now, actor, method: req.method ?? "GET", path: url.pathname + url.search });
      if (req.method === "GET") {
        if (url.pathname === "/api/me") { json(res, 200, { actor, readOnly: READ_ONLY_ROLES.has(actor.role!) }); return; }
        if (url.pathname === "/api/queue") { const kind = url.searchParams.get("kind"); const loanId = url.searchParams.get("loanId"); json(res, 200, await store.queue({ role: url.searchParams.get("role") ?? actor.role!, now, ...(kind ? { kind: kind as never } : {}), ...(loanId ? { loanId } : {}) })); return; }
        if (url.pathname === "/api/loans") { json(res, 200, await store.searchLoans(url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 20))); return; }
        const m = /^\/api\/loans\/([^/]+)$/.exec(url.pathname);
        if (m) { const l = await store.loan(decodeURIComponent(m[1]!), now); if (!l) json(res, 404, { error: "no such loan" }); else json(res, 200, l); return; }
        // 32.14 T18: the entry funnel — counts per stage from loan_events/lead events only (src/console/pg-store.ts funnel)
        if (url.pathname === "/api/funnel") { json(res, 200, await store.funnel({ from: url.searchParams.get("from") ?? new Date(Date.parse(now) - 30 * 86_400_000).toISOString(), to: url.searchParams.get("to") ?? now })); return; }
        if (url.pathname === "/api/dashboard") { json(res, 200, await store.dashboard(now)); return; }
        json(res, 404, { error: "not found" }); return;
      }
      if (req.method === "POST") {
        if (READ_ONLY_ROLES.has(actor.role!)) { json(res, 403, { error: `${actor.role} is read-only` }); return; }
        const b = await body(req);
        const id = String(b["id"] ?? "");
        const evidence = b["evidenceDocumentId"] ? String(b["evidenceDocumentId"]) : null;
        let r: { ok: true } | { ok: false; reason: string };
        switch (url.pathname) {
          case "/api/escalations/complete": r = await store.completeEscalation(id, actor, evidence, now); break;
          case "/api/portal-tasks/complete": r = await store.completePortalTask(id, actor, evidence, now); break;
          case "/api/notices/supersede": r = await store.releaseHeldNotice(id, actor, String(b["replacementId"] ?? ""), now); break;
          case "/api/outbox/requeue": r = await store.requeueDeadLetter(id, actor, now); break;
          case "/api/agents/ai-off": r = await store.setAiOff(String(b["agent"] ?? ""), b["why"] === null || b["why"] === undefined ? null : String(b["why"]), actor, now); break;
          default: json(res, 404, { error: "not found" }); return;
        }
        json(res, r.ok ? 200 : 409, r); return;
      }
      json(res, 405, { error: "method not allowed" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
}

/** Start listening; resolves with the bound port (0 → ephemeral). */
export function listen(server: Server, port = 0, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { const a = server.address(); resolve(typeof a === "object" && a ? a.port : port); }); });
}
