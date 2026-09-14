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
import { type ConsoleStore, READ_ONLY_ROLES, CONSOLE_ROLES, maskEmail } from "./store.ts";
import type { Runtime } from "../runtime/app.ts";
import { parseMultipart } from "../runtime/borrower/routes.ts";
import { importPartnerBook, listPartnerBookImports, partnerBookReport, type PartnerBookImportInput } from "../runtime/partner-book.ts";

/** `runtime` is what the 33.1 partner-book view needs (the upload runs `importPartnerBook`; the loans list reads the facts); without it those routes answer 501. */
export interface ConsoleServerOptions { readonly store: ConsoleStore; readonly clock?: { now(): string }; readonly uiHtml?: string; readonly runtime?: Runtime; }

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
const MAX_UPLOAD = 64 * 1024 * 1024;
async function raw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_UPLOAD) throw new RangeError(`request body over ${MAX_UPLOAD} bytes`); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
const UUID = /^[0-9a-f-]{36}$/i;
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
      // the access log names who looked at whom, never the address itself: `?email=` is masked the way the trace masks it (19.2 / DELTA-28)
      const logged = new URL(url.toString()); if (logged.searchParams.has("email")) logged.searchParams.set("email", maskEmail(logged.searchParams.get("email")) ?? "");
      await store.logAccess({ at: now, actor, method: req.method ?? "GET", path: logged.pathname + logged.search });
      if (req.method === "GET") {
        if (url.pathname === "/api/me") { json(res, 200, { actor, readOnly: READ_ONLY_ROLES.has(actor.role!) }); return; }
        // DELTA-28 (docs/ux/17 §6): the conversation trace — the most recent turns across parties, and one party's thread / cards / turns by party_id or e-mail
        if (url.pathname === "/api/ai/conversation/recent") {
          if (!store.aiRecentTurns) { json(res, 501, { error: "the conversation trace needs the Postgres console store" }); return; }
          json(res, 200, { as_of: now, turns: await store.aiRecentTurns(Number(url.searchParams.get("limit") ?? 20) || 20) }); return;
        }
        if (url.pathname === "/api/ai/conversation") {
          if (!store.aiConversation || !store.aiPartyByEmail) { json(res, 501, { error: "the conversation trace needs the Postgres console store" }); return; }
          const email = url.searchParams.get("email"); let partyId = url.searchParams.get("party_id");
          if (!partyId && !email) { json(res, 400, { error: "party_id=<uuid> or email=<address> is required" }); return; }
          if (!partyId && email) partyId = (await store.aiPartyByEmail(email)) ?? null;
          const c = partyId ? await store.aiConversation(partyId) : undefined;
          if (!c) json(res, 404, { error: "no such party" }); else json(res, 200, c); return;
        }
        if (url.pathname === "/api/queue") { const kind = url.searchParams.get("kind"); const loanId = url.searchParams.get("loanId"); json(res, 200, await store.queue({ role: url.searchParams.get("role") ?? actor.role!, now, ...(kind ? { kind: kind as never } : {}), ...(loanId ? { loanId } : {}) })); return; }
        if (url.pathname === "/api/loans") { json(res, 200, await store.searchLoans(url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 20))); return; }
        const m = /^\/api\/loans\/([^/]+)$/.exec(url.pathname);
        if (m) { const l = await store.loan(decodeURIComponent(m[1]!), now); if (!l) json(res, 404, { error: "no such loan" }); else json(res, 200, l); return; }
        // 32.14 T18: the entry funnel — counts per stage from loan_events/lead events only (src/console/pg-store.ts funnel)
        if (url.pathname === "/api/funnel") { json(res, 200, await store.funnel({ from: url.searchParams.get("from") ?? new Date(Date.parse(now) - 30 * 86_400_000).toISOString(), to: url.searchParams.get("to") ?? now })); return; }
        if (url.pathname === "/api/dashboard") { json(res, 200, await store.dashboard(now)); return; }
        // 33.1: the partner book — the imports (newest first), one import's report (per-row exceptions and gap counts, never a destination) and the monitored loans with their latest facts
        if (url.pathname.startsWith("/api/partner-book/")) {
          const rt = opts.runtime; if (!rt) { json(res, 501, { error: "the partner book needs the runtime (createConsoleServer({ runtime }))" }); return; }
          const partner = url.searchParams.get("partner_party_id"); const partnerId = partner && UUID.test(partner) ? partner : null;
          if (url.pathname === "/api/partner-book/imports") { json(res, 200, { as_of: now, imports: await listPartnerBookImports(rt, partnerId ?? undefined) }); return; }
          if (url.pathname === "/api/partner-book/loans") { json(res, 200, { as_of: now, loans: await monitoredLoans(rt, partnerId) }); return; }
          // 33.3: the readiness rows of one monitored loan (the examiner's view — every item with its source, as-of and validity)
          const rm = /^\/api\/partner-book\/loans\/([^/]+)\/readiness$/.exec(url.pathname);
          if (rm) { const id = decodeURIComponent(rm[1]!); if (!UUID.test(id)) { json(res, 400, { error: "loan_id is a uuid" }); return; } json(res, 200, { as_of: now, loan_id: id, rows: await readinessRows(rt, id) }); return; }
          const pm = /^\/api\/partner-book\/imports\/([^/]+)$/.exec(url.pathname);
          if (pm) { const r = await partnerBookReport(rt, decodeURIComponent(pm[1]!)); if (!r) json(res, 404, { error: "no such import" }); else json(res, 200, r); return; }
        }
        json(res, 404, { error: "not found" }); return;
      }
      if (req.method === "POST") {
        if (READ_ONLY_ROLES.has(actor.role!)) { json(res, 403, { error: `${actor.role} is read-only` }); return; }
        // 33.1: the operator uploads the tape and the supplement; the portfolio agent loads, provisions and invites (src/runtime/partner-book.ts importPartnerBook); the actor is the console's human
        if (url.pathname === "/api/partner-book/imports") {
          const rt = opts.runtime; if (!rt) { json(res, 501, { error: "the partner book needs the runtime (createConsoleServer({ runtime }))" }); return; }
          let input: PartnerBookImportInput;
          try { input = await partnerBookUpload(req); } catch (e) { if (e instanceof RangeError) { json(res, 400, { error: e.message }); return; } throw e; }
          json(res, 200, await importPartnerBook(rt, input, actor)); return;
        }
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
