/**
 * §35.8 — the portal routes (Inputs and triggers), a table the console mounts beside 34.4's and 35.7's
 * (src/console/server.ts: the session resolved, the role chosen among `roles` — 403 ROLE_REQUIRED before any read — the
 * handler with the session's actor, the outcome completing the staff_actions row). Every handler runs its tool ON THE BUS
 * (`runtime.execute`, process 35.8) with the session's actor {kind: human, id: staff_user_id, role} (34.1 rule 3); the
 * role the request names (`x-staff-role` / body `role`) is the role the act is asked for (rule 4).
 *
 *   GET  /ops/api/work/queue?role=&screen=&subject_kind=&subject_id=&status=          → work.queue
 *   POST /ops/api/work/items {screen_code, subject: {kind, id}, required_role?, reason}   → work.item.open (a `manual` item)
 *   POST /ops/api/work/items/{id}/claim | release                                       → work.item.claim | work.item.release
 *   POST /ops/api/work/items/{id}/close {disposition, reason, evidence_document_id?}      → work.item.close
 *   POST /ops/api/work/items/{id}/cancel {reason}                                        → work.item.cancel (ops_analyst)
 *   GET  /ops/api/work/screens/{code}/{subject_kind}/{subject_id}                        → work.screen.read
 *   POST /ops/api/work/screens/{code}/{subject_kind}/{subject_id}/derive {action, decision}                 → work.screen.derive
 *   POST /ops/api/work/screens/{code}/{subject_kind}/{subject_id}/act {action, decision, work_item_id?}     → work.screen.act
 *   POST /ops/api/work/screens/{code}/{subject_kind}/{subject_id}/propose {action, decision, work_item_id?} → work.action.propose
 *   POST /ops/api/work/actions/{id}/decide {decision ∈ {approved, declined}, reason}     → work.action.decide (a distinct officer)
 *   POST /ops/api/work/recon {as_of_date}                                                → work.log.recon (compliance)
 * The staff_actions row of an act names the dispatched owning tool (`command = "<process> <tool>"`, rule 7) and the
 * `work_actions` row as its subject; a WorkRefused (a StaffError) answers in the console's shape with its status and code.
 */
import type { Actor } from "../../../kernel/events/index.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { CommandRefused } from "../../../app/commands.ts";
import { StaffError } from "../../../runtime/staff/roles.ts";
import { HUMAN_ROLES } from "../../../app/roles.ts";
import type { ControlsRoute, ControlsRequest, ControlsResponse } from "../../../runtime/controls/routes.ts";
import { actionOf, screenOf } from "./screens.ts";
import { PROCESS_35_8, isUuid, obj, s, type Row } from "./types.ts";

/** Every kernel human role plus the staff four less admin (34.1: admin touches no borrower); the tool's own roles decide the act. */
export const WORK_ROLES: readonly string[] = [...new Set(["ops_analyst", "officer", "compliance", ...HUMAN_ROLES])];
export const WORK_READ_ROLES: readonly string[] = [...WORK_ROLES, "admin"];

export function workRoutes(deps: { readonly runtime: Runtime }): ControlsRoute[] {
  const rt = deps.runtime;
  const subjectParams = (p: Record<string, string>): { kind: "loan" | "application"; id: string } => { const kind = p["subject_kind"]; if (kind !== "loan" && kind !== "application") throw new RangeError("subject_kind is loan or application"); const id = p["subject_id"] ?? ""; if (!isUuid(id)) throw new RangeError("subject_id is a uuid"); return { kind, id }; };
  const uuidParam = (p: Record<string, string>, k: string): string => { const v = p[k] ?? ""; if (!isUuid(v)) throw new RangeError(`${k} is a uuid`); return v; };
  const commandOf = (code: string, action: string): string => { const sc = screenOf(code); const a = sc ? actionOf(sc, action) : undefined; return a ? `${a.process} ${a.tool}` : `${PROCESS_35_8} work.screen.act`; };
  const run = async (name: string, actor: Actor, input: Row, scope: { loanId?: string; applicationId?: string }, meta: { command: string; subject: { kind: string; id: string } | null }): Promise<ControlsResponse> => {
    try {
      const r = await rt.execute({ process: PROCESS_35_8, name, loanId: scope.loanId ?? "", ...(scope.applicationId ? { applicationId: scope.applicationId } : {}), actor, input });
      const o = obj(r.output);
      const command = typeof o["process"] === "string" && typeof o["tool"] === "string" ? `${o["process"]} ${o["tool"]}` : meta.command;
      const subject = meta.subject ?? (typeof o["action_id"] === "string" ? { kind: "work_action", id: o["action_id"] } : typeof o["item_id"] === "string" ? { kind: "work_item", id: o["item_id"] } : typeof o["run_id"] === "string" ? { kind: "work_log_recon_run", id: o["run_id"] } : null);
      const refused = o["refused"] === true;   // a decide that declined for STALE_DERIVATION answers 409 with the row written (rule 6)
      return { status: refused ? 409 : 200, body: { ...o, ...(refused ? { error: "refused", code: o["code"] } : {}), decision_ids: r.decisions.map((d) => d.id), events: r.events.map((e) => e.type), escalations: r.escalations }, command, subject };
    } catch (e) {
      if (e instanceof StaffError) { const subject = meta.subject ?? (typeof e.extra["action_id"] === "string" ? { kind: "work_action", id: e.extra["action_id"] } : null); return { status: e.status, body: { error: e.code.toLowerCase(), reason: e.message, ...e.extra, code: e.code }, command: meta.command, subject }; }
      if (e instanceof CommandRefused) return { status: e.code === "ROLE_REQUIRED" ? 403 : 409, body: { error: "refused", command: e.command, code: e.code, citation: e.citation, reason: e.message }, command: meta.command, subject: meta.subject };
      if (e instanceof RangeError) return { status: 400, body: { error: "bad_request", code: "BAD_REQUEST", reason: e.message }, command: meta.command, subject: meta.subject };
      throw e;
    }
  };
  const scopeOf = (sub: { kind: string; id: string }): { loanId?: string; applicationId?: string } => (sub.kind === "loan" ? { loanId: sub.id } : { applicationId: sub.id });
  const session = (r: ControlsRequest): Row => ({ ...(typeof r.body["session_id"] === "string" && isUuid(r.body["session_id"]) ? { session_id: r.body["session_id"] } : {}) });
  const screenAct = (name: string) => async (r: ControlsRequest): Promise<ControlsResponse> => {
    const sub = subjectParams(r.params); const code = r.params["code"] ?? ""; const action = s(r.body["action"]);
    return run(name, r.actor, { code, action, subject: sub, decision: obj(r.body["decision"]), ...(typeof r.body["work_item_id"] === "string" ? { work_item_id: r.body["work_item_id"] } : {}), ...(typeof r.body["rationale"] === "string" ? { rationale: r.body["rationale"] } : {}), ...session(r) }, scopeOf(sub), { command: commandOf(code, action), subject: null });
  };
  return [
    { method: "GET", path: "/api/work/queue", roles: WORK_READ_ROLES, command: "work.queue", handler: (r) => run("work.queue", r.actor, { role: r.query.get("role"), screen: r.query.get("screen"), status: r.query.get("status"), ...(r.query.get("subject_id") ? { subject: { kind: r.query.get("subject_kind") ?? "loan", id: r.query.get("subject_id") } } : {}), page: Number(r.query.get("page") ?? 1), page_size: Number(r.query.get("page_size") ?? 200) }, {}, { command: "35.8 work.queue", subject: null }) },
    { method: "POST", path: "/api/work/items", roles: WORK_ROLES, command: "work.item.open", handler: (r) => run("work.item.open", r.actor, { screen_code: r.body["screen_code"], subject: r.body["subject"], required_role: r.body["required_role"], reason: r.body["reason"], source_kind: "manual" }, {}, { command: "35.8 work.item.open", subject: null }) },
    { method: "POST", path: "/api/work/items/:id/claim", roles: WORK_ROLES, command: "work.item.claim", handler: (r) => run("work.item.claim", r.actor, { item_id: uuidParam(r.params, "id"), ...session(r) }, {}, { command: "35.8 work.item.claim", subject: { kind: "work_item", id: r.params["id"]! } }) },
    { method: "POST", path: "/api/work/items/:id/release", roles: WORK_ROLES, command: "work.item.release", handler: (r) => run("work.item.release", r.actor, { item_id: uuidParam(r.params, "id"), ...session(r) }, {}, { command: "35.8 work.item.release", subject: { kind: "work_item", id: r.params["id"]! } }) },
    { method: "POST", path: "/api/work/items/:id/close", roles: WORK_ROLES, command: "work.item.close", handler: (r) => run("work.item.close", r.actor, { item_id: uuidParam(r.params, "id"), disposition: r.body["disposition"], reason: r.body["reason"], evidence_document_id: r.body["evidence_document_id"], ...session(r) }, {}, { command: "35.8 work.item.close", subject: { kind: "work_item", id: r.params["id"]! } }) },
    { method: "POST", path: "/api/work/items/:id/cancel", roles: ["ops_analyst"], command: "work.item.cancel", handler: (r) => run("work.item.cancel", r.actor, { item_id: uuidParam(r.params, "id"), reason: r.body["reason"], ...session(r) }, {}, { command: "35.8 work.item.cancel", subject: { kind: "work_item", id: r.params["id"]! } }) },
    { method: "GET", path: "/api/work/screens/:code/:subject_kind/:subject_id", roles: WORK_ROLES, command: "work.screen.read", handler: (r) => { const sub = subjectParams(r.params); return run("work.screen.read", r.actor, { code: r.params["code"], subject: sub }, scopeOf(sub), { command: "35.8 work.screen.read", subject: sub }); } },
    { method: "POST", path: "/api/work/screens/:code/:subject_kind/:subject_id/derive", roles: WORK_ROLES, command: "work.screen.derive", handler: screenAct("work.screen.derive") },
    { method: "POST", path: "/api/work/screens/:code/:subject_kind/:subject_id/act", roles: WORK_ROLES, command: "work.screen.act", handler: screenAct("work.screen.act") },
    { method: "POST", path: "/api/work/screens/:code/:subject_kind/:subject_id/propose", roles: WORK_ROLES, command: "work.action.propose", handler: screenAct("work.action.propose") },
    { method: "POST", path: "/api/work/actions/:id/decide", roles: ["officer"], command: "work.action.decide", handler: async (r) => {
      const id = uuidParam(r.params, "id");
      const [row] = await rt.db.query<{ loan_id: string | null; application_id: string | null; process: string; tool: string }>(`SELECT loan_id::text AS loan_id, application_id::text AS application_id, process, tool FROM work_actions WHERE id = $1`, [id]);
      // global scope: the proposal's and the item's clocks (aggregate subjects) are hydrated with the global rows; the tool takes the subject's lock itself before re-deriving (35.1 rule 7) and the owning tool runs under it
      return run("work.action.decide", r.actor, { action_id: id, decision: r.body["decision"], reason: r.body["reason"], ...session(r) }, {}, { command: row ? `${row.process} ${row.tool}` : "35.8 work.action.decide", subject: { kind: "work_action", id } }); } },
    { method: "POST", path: "/api/work/recon", roles: ["compliance"], command: "work.log.recon", handler: (r) => run("work.log.recon", r.actor, { as_of_date: r.body["as_of_date"] }, {}, { command: "35.8 work.log.recon", subject: null }) },
  ];
}
