/**
 * 34.4 — the controls route table (spec "Inputs and triggers"), as data the console server mounts: `controlsRoutes(deps)`
 * returns `{method, path, roles, handler}` rows; the console's request loop (src/console/server.ts) resolves the staff
 * session, chooses the role among `roles` (403 ROLE_REQUIRED before any read), matches `method` + `path` (a `:param`
 * segment), calls `handler` and writes the `staff_actions` row (34.1 rule 4) with the `command` the handler names.
 *
 *   GET  /api/controls/timers                       ops_analyst | officer | compliance | admin   controls.timers (read)
 *   GET  /api/controls/timers/:id                   same                                          one clock with its history
 *   GET  /api/controls/escalations                  same                                          the list
 *   POST /api/controls/escalations/:id/complete     ops_analyst | officer | compliance             34.4 controls.escalation.complete on the bus
 *   GET  /api/controls/outbox                       same as timers
 *   POST /api/controls/outbox/:id/requeue           ops_analyst | officer                          34.4 controls.outbox.requeue on the bus
 *   GET  /api/controls/ai                           same as timers                                 systems, versions, evaluations, kill-switch state, pending requests
 *   POST /api/controls/ai/:code/kill                compliance | admin                             34.4 controls.ai.kill{op: request, action: trip} (compliance) | {op: confirm, request_id} (admin)
 *   POST /api/controls/ai/:code/reset               compliance | admin                             the same with action reset
 *   POST /api/controls/evidence                     compliance                                     34.4 controls.evidence.pack on the bus
 *   GET  /api/controls/evidence                     compliance                                     the packs
 *   GET  /api/controls/evidence/:id                 compliance                                     one pack (its manifest and, when stored, the document); `?verify=1` re-hashes the rows
 *
 * Every `/api/controls/timers*` route is GET (T1's contract, `assertNoTimerWrite`). The action routes run the bus tool with the
 * session's actor, so the guardrails and the decision record apply. The module's own refusal (`ControlsRefused`, a StaffError:
 * ROLE_REQUIRED, REQUEUE_CAP_3, TWO_PERSON_KILL, REQUEST_EXPIRED, …) is answered by the action route itself in the console's
 * refusal shape `{error, reason, …extra, code}` with the subject and the command still on the answer — so the refused act's
 * staff_actions row names what it was refused on (34.1 rule 4), exactly as src/runtime/book-ops/routes.ts answers its own; a
 * guardrail's `CommandRefused` (409, or 403 for ROLE_REQUIRED), a `RoleDenied` and a `RangeError` propagate to the console's catch.
 */
import type { Actor } from "../../kernel/events/index.ts";
import type { Runtime } from "../app.ts";
import type { BlobStorePort } from "../borrower/vendors/fake-blob-store.ts";
import { StaffError } from "../staff/roles.ts";
import { CONTROLS_PROCESS, isUuid, s, type Row } from "./common.ts";
import { controlsTimer, controlsTimers } from "./timers.ts";
import { getEscalation, listEscalations } from "./escalations.ts";
import { getOutboxMessage, listOutbox } from "./outbox.ts";
import { aiView, killRequests, killSwitchState } from "./ai.ts";
import { getEvidencePack, listEvidencePacks, storedPackDocument, verifyEvidencePack } from "./evidence.ts";

export interface ControlsRequest { readonly actor: Actor; readonly params: Record<string, string>; readonly query: URLSearchParams; readonly body: Row; readonly now: string; }
export interface ControlsResponse { readonly status: number; readonly body: unknown; /** the bus command the request ran, for the staff_actions row */ readonly command?: string | null; readonly subject?: { kind: string; id: string } | null; }
export interface ControlsRoute { readonly method: "GET" | "POST"; readonly path: string; readonly roles: readonly string[]; readonly command: string | null; readonly handler: (req: ControlsRequest) => Promise<ControlsResponse>; }
export interface ControlsDeps { readonly runtime: Runtime; readonly blobs?: BlobStorePort | null; }

export const CONTROLS_READ_ROLES: readonly string[] = ["ops_analyst", "officer", "compliance", "admin"];
export const CONTROLS_ACT_ROLES: readonly string[] = ["ops_analyst", "officer", "compliance"];
export const CONTROLS_KILL_ROLES: readonly string[] = ["compliance", "admin"];
export const CONTROLS_EVIDENCE_ROLES: readonly string[] = ["compliance"];
/** Rule 5 ("`compliance` only") / 34.1 rule 2 ("admin manages staff users and roles and nothing else that touches a borrower"): the pack — events, rendered notices, partner-book facts with the homeowner's name and address — is read back by compliance alone, like the POST (review finding). */
export const CONTROLS_EVIDENCE_READ_ROLES: readonly string[] = ["compliance"];

const ok = (body: unknown, extra: Partial<ControlsResponse> = {}): ControlsResponse => ({ status: 200, body, ...extra });
const q = (req: ControlsRequest, k: string): string | null => req.query.get(k);
const num = (v: string | null): number | null => (v === null || v === "" ? null : Number(v));
/** A bus execution's answer in the console's shape (src/console/server.ts POST /api/tools/…). */
const busAnswer = (out: Awaited<ReturnType<Runtime["execute"]>>, actor: Actor): Row => ({ output: out.output, decisionId: out.decisionId ?? null, decisions: out.decisions, events: out.events.map((e) => e.type), escalations: out.escalations, actor });
/** An action route's answer: the bus answer on success; the module's own refusal (a StaffError) in the console's refusal shape — the code last, so no extra can shadow it — with the command and the subject kept for the action log; anything else propagates. */
async function act(extra: { command: string; subject: { kind: string; id: string } | null }, fn: () => Promise<Row>): Promise<ControlsResponse> {
  try { return ok(await fn(), extra); }
  catch (e) { if (e instanceof StaffError) return { status: e.status, body: { error: e.code.toLowerCase(), reason: e.message, ...e.extra, code: e.code }, command: extra.command, ...(extra.subject ? { subject: extra.subject } : {}) }; throw e; }
}

export function controlsRoutes(deps: ControlsDeps): ControlsRoute[] {
  const rt = deps.runtime;
  const routes: ControlsRoute[] = [
    // ───────── clocks (rule 1: shown, never edited — every route GET)
    { method: "GET", path: "/api/controls/timers", roles: CONTROLS_READ_ROLES, command: null, handler: async (req) => ok(await controlsTimers(rt, { status: q(req, "status"), code: q(req, "code"), subject: q(req, "subject"), due_before: q(req, "due_before"), limit: num(q(req, "limit")) }, req.now)) },
    { method: "GET", path: "/api/controls/timers/:id", roles: CONTROLS_READ_ROLES, command: null, handler: async (req) => { const t = await controlsTimer(rt, req.params["id"] ?? "", req.now); return t ? ok(t, { subject: { kind: "timer", id: t.timer_id } }) : { status: 404, body: { error: "no such timer" } }; } },
    // ───────── escalations (rule 2)
    { method: "GET", path: "/api/controls/escalations", roles: CONTROLS_READ_ROLES, command: null, handler: async (req) => ok(await listEscalations(rt, { status: q(req, "status"), role: q(req, "role"), loan_id: q(req, "loan_id"), application_id: q(req, "application_id"), limit: num(q(req, "limit")) })) },
    { method: "GET", path: "/api/controls/escalations/:id", roles: CONTROLS_READ_ROLES, command: null, handler: async (req) => { const e = await getEscalation(rt, req.params["id"] ?? ""); return e ? ok(e, { subject: { kind: "escalation", id: e.id } }) : { status: 404, body: { error: "no such escalation" } }; } },
    { method: "POST", path: "/api/controls/escalations/:id/complete", roles: CONTROLS_ACT_ROLES, command: "controls.escalation.complete", handler: async (req) => {
      const id = req.params["id"] ?? ""; if (!isUuid(id)) throw new RangeError("escalation id is a uuid");
      return act({ command: "controls.escalation.complete", subject: { kind: "escalation", id } }, async () => busAnswer(await rt.execute({ process: CONTROLS_PROCESS, name: "controls.escalation.complete", loanId: "", actor: req.actor, input: { escalation_id: id, disposition: s(req.body["disposition"]), reason: s(req.body["reason"]) } }), req.actor));
    } },
    // ───────── the outbox (rule 3)
    { method: "GET", path: "/api/controls/outbox", roles: CONTROLS_READ_ROLES, command: null, handler: async (req) => ok(await listOutbox(rt, { adapter: q(req, "adapter"), status: q(req, "status"), loan_id: q(req, "loan_id"), limit: num(q(req, "limit")) })) },
    { method: "GET", path: "/api/controls/outbox/:id", roles: CONTROLS_READ_ROLES, command: null, handler: async (req) => { const m = await getOutboxMessage(rt, req.params["id"] ?? ""); return m ? ok(m, { subject: { kind: "integration_message", id: m.id } }) : { status: 404, body: { error: "no such message" } }; } },
    { method: "POST", path: "/api/controls/outbox/:id/requeue", roles: ["ops_analyst", "officer"], command: "controls.outbox.requeue", handler: async (req) => {
      const id = req.params["id"] ?? ""; if (!isUuid(id)) throw new RangeError("message id is a uuid");
      return act({ command: "controls.outbox.requeue", subject: { kind: "integration_message", id } }, async () => busAnswer(await rt.execute({ process: CONTROLS_PROCESS, name: "controls.outbox.requeue", loanId: "", actor: req.actor, input: { message_id: id, ...(req.body["reason"] ? { reason: s(req.body["reason"]) } : {}) } }), req.actor));
    } },
    // ───────── AI systems and the kill switch (rule 4)
    { method: "GET", path: "/api/controls/ai", roles: CONTROLS_READ_ROLES, command: null, handler: async (req) => ok(await aiView(rt, req.now)) },
    { method: "GET", path: "/api/controls/ai/:code", roles: CONTROLS_READ_ROLES, command: null, handler: async (req) => { const code = req.params["code"] ?? ""; return ok({ as_of: req.now, kill_switch: await killSwitchState(rt, code), requests: await killRequests(rt, { code }, req.now) }, { subject: { kind: "ai_system", id: code } }); } },
    ...(["kill", "reset"] as const).map((verb): ControlsRoute => ({ method: "POST", path: `/api/controls/ai/:code/${verb}`, roles: CONTROLS_KILL_ROLES, command: "controls.ai.kill", handler: async (req) => {
      const code = req.params["code"] ?? ""; const action = verb === "kill" ? "trip" : "reset";
      // compliance requests (op request); admin confirms the request id (op confirm) — both through the one tool, both logged as controls.ai.kill
      const op = req.body["request_id"] ? "confirm" : "request";
      const input: Row = op === "confirm" ? { op, request_id: s(req.body["request_id"]), code, action } : { op, code, action, reason: s(req.body["reason"]) };
      return act({ command: "controls.ai.kill", subject: { kind: "ai_system", id: code } }, async () => busAnswer(await rt.execute({ process: CONTROLS_PROCESS, name: "controls.ai.kill", loanId: "", actor: req.actor, input }), req.actor));
    } })),
    // ───────── the evidence pack (rule 5)
    { method: "POST", path: "/api/controls/evidence", roles: CONTROLS_EVIDENCE_ROLES, command: "controls.evidence.pack", handler: async (req) => {
      // the subject asked for, for the action log of a refused request (the pack's own id is the subject once one exists)
      const asked = (req.body["subject"] && typeof req.body["subject"] === "object" ? (req.body["subject"] as Row) : {}) as Row;
      const requested = (["loan_id", "application_id", "party_id"] as const).map((k) => (isUuid(asked[k]) ? { kind: k.slice(0, -3), id: asked[k] as string } : null)).find((x) => x !== null) ?? null;
      return act({ command: "controls.evidence.pack", subject: requested }, async () => {
      const out = await rt.execute({ process: CONTROLS_PROCESS, name: "controls.evidence.pack", loanId: "", actor: req.actor, input: { subject: req.body["subject"], ...(Array.isArray(req.body["sections"]) ? { sections: req.body["sections"] } : {}) } });
      const o = out.output as Row;
      // the document store (the borrower router's blob store when the console is given it): the pack text and its event parts under their document ids
      if (deps.blobs && typeof o["document"] === "string" && isUuid(o["document_id"])) {
        await deps.blobs.put(o["document_id"] as string, { bytes: Buffer.from(o["document"] as string, "utf8"), mime_type: "application/json", filename: `evidence-pack-${s(o["id"])}.json`, stored_at: req.now });
        for (const p of (Array.isArray(o["parts"]) ? (o["parts"] as Row[]) : [])) if (isUuid(p["document_id"]) && typeof p["content"] === "string") await deps.blobs.put(p["document_id"] as string, { bytes: Buffer.from(p["content"] as string, "utf8"), mime_type: "application/json", filename: `evidence-pack-${s(o["id"])}-part-${s(p["part"])}.json`, stored_at: req.now });
      }
      // the answer carries the manifest, the hash and the part count — never the whole document (it is the stored document; GET …/evidence/{id} reads it back)
      const { document: _doc, parts: _parts, ...summary } = o;
      return { ...busAnswer(out, req.actor), output: { ...summary, parts: (Array.isArray(o["parts"]) ? (o["parts"] as Row[]) : []).map(({ content: _c, ...p }) => p) } };
      }).then((res) => (res.status < 300 && isUuid(((res.body as Row)["output"] as Row | undefined)?.["id"]) ? { ...res, subject: { kind: "evidence_pack", id: s(((res.body as Row)["output"] as Row)["id"]) } } : res));
    } },
    { method: "GET", path: "/api/controls/evidence", roles: CONTROLS_EVIDENCE_READ_ROLES, command: null, handler: async (req) => ok({ as_of: req.now, packs: await listEvidencePacks(rt, { subject_kind: q(req, "subject_kind"), subject_id: q(req, "subject_id"), ...(num(q(req, "limit")) !== null ? { limit: num(q(req, "limit"))! } : {}) }) }) },
    { method: "GET", path: "/api/controls/evidence/:id", roles: CONTROLS_EVIDENCE_READ_ROLES, command: null, handler: async (req) => {
      const id = req.params["id"] ?? ""; const pack = await getEvidencePack(rt, id); if (!pack) return { status: 404, body: { error: "no such pack" } };
      // the document: the console's blob store (the packs this console produced), else the text retained with the documents row (a directory export's pack — 34.2 rule 5)
      const blob = deps.blobs && pack.document_id ? await deps.blobs.get(pack.document_id) : undefined;
      const document = blob ? blob.bytes.toString("utf8") : await storedPackDocument(rt, pack);
      const verify = q(req, "verify") === "1" || q(req, "verify") === "true";
      return ok({ ...pack, document, document_available: document !== null, ...(verify ? { verification: await verifyEvidencePack(rt, id) } : {}) }, { subject: { kind: "evidence_pack", id } });
    } },
  ];
  assertNoTimerWrite(routes);
  return routes;
}

/** T1's contract: no route under /api/controls/timers is anything but GET — a table that violates it never mounts. */
export function assertNoTimerWrite(routes: readonly ControlsRoute[]): void {
  const bad = routes.filter((r) => r.path.startsWith("/api/controls/timers") && r.method !== "GET");
  if (bad.length) throw new Error(`NO_CLOCK_EDIT: ${bad.map((r) => `${r.method} ${r.path}`).join(", ")} — clocks are shown, never edited (34.4 rule 1)`);
}

/** Match a request path against the table (`:param` segments); the console's loop uses it — `/ops/api/…` is normalised to `/api/…` by the caller. */
export function matchControlsRoute(routes: readonly ControlsRoute[], method: string, path: string): { route: ControlsRoute; params: Record<string, string> } | null {
  const parts = path.split("/").filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    const rp = r.path.split("/").filter(Boolean); if (rp.length !== parts.length) continue;
    const params: Record<string, string> = {}; let hit = true;
    for (let i = 0; i < rp.length; i++) { const seg = rp[i]!; if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]!); else if (seg !== parts[i]) { hit = false; break; } }
    if (hit) return { route: r, params };
  }
  return null;
}
