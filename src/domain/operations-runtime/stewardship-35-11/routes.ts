/**
 * §35.11 — the portal routes (Inputs and triggers), a table the console mounts beside 34.4's and 35.7's (src/console/server.ts,
 * the same dispatch: the session resolved, the role chosen among `roles` — 403 ROLE_REQUIRED before any read — the handler
 * with the session's actor, the outcome completing the staff_actions row of 34.1 rule 4). Every handler runs its tool ON THE
 * BUS (`runtime.execute`, process 35.11) with the session's actor {kind: human, id: staff_user_id, role}.
 *
 *   GET  /ops/api/stewardship/report?environment=&as_of_date=                       ops_analyst | compliance   → ops.report{force: false} (the day's row: read, produce when absent)
 *   GET  /ops/api/stewardship/exceptions?environment=&status=&kind=&adapter=&source_kind=   ops_analyst | compliance | officer | admin → ops.exceptions.list
 *   POST /ops/api/stewardship/exceptions/{id}/classify                              ops_analyst                → ops.exceptions.classify
 *   POST /ops/api/stewardship/exceptions/{id}/assign {role, reason}                 ops_analyst                → ops.exceptions.assign
 *   POST /ops/api/stewardship/exceptions/{id}/resolve {disposition, reason}         ops_analyst                → ops.exceptions.resolve
 *   POST /ops/api/stewardship/exceptions/{id}/requeue {reason}                      ops_analyst                → 34.4's controls.outbox.requeue with the session's actor (the hand requeue)
 *   GET  /ops/api/stewardship/runbook/{code}                                        ops_analyst | compliance | officer | admin → ops.runbook.read (a timer code, a cycle code or an adapter)
 * A StewardRefused (a StaffError) answers in the console's shape with its status, code and extras; a bus CommandRefused as 409.
 */
import type { Actor } from "../../../kernel/events/index.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { CommandRefused } from "../../../app/commands.ts";
import { StaffError } from "../../../runtime/staff/roles.ts";
import type { ControlsRoute, ControlsRequest, ControlsResponse } from "../../../runtime/controls/routes.ts";
import { requeueMessage } from "../../../runtime/controls/outbox.ts";
import { PROCESS_35_11, isUuid, s } from "./types.ts";

type Row = Record<string, unknown>;
export const STEWARDSHIP_READ_ROLES: readonly string[] = ["ops_analyst", "compliance", "officer", "admin"];
export const STEWARDSHIP_REPORT_ROLES: readonly string[] = ["ops_analyst", "compliance"];
export const STEWARDSHIP_ACT_ROLES: readonly string[] = ["ops_analyst"];

export function stewardshipRoutes(deps: { readonly runtime: Runtime }): ControlsRoute[] {
  const rt = deps.runtime;
  const act = async (name: string, actor: Actor, input: Row, subject: { kind: string; id: string } | null): Promise<ControlsResponse> => {
    try {
      const r = await rt.execute({ process: PROCESS_35_11, name, loanId: "", actor, input });
      const o = (r.output ?? {}) as Row;
      return { status: 200, body: { ...o, decision_ids: r.decisions.map((d) => d.id), events: r.events.map((e) => e.type), escalations: r.escalations }, command: `${PROCESS_35_11} ${name}`, subject: subject ?? (typeof o["exception_id"] === "string" ? { kind: "ops_exception", id: o["exception_id"] } : typeof o["report_id"] === "string" ? { kind: "ops_report", id: o["report_id"] } : null) };
    } catch (e) {
      if (e instanceof StaffError) return { status: e.status, body: { error: e.code.toLowerCase(), code: e.code, reason: e.message, ...e.extra }, command: `${PROCESS_35_11} ${name}`, subject };
      if (e instanceof CommandRefused) return { status: 409, body: { error: "refused", command: e.command, code: e.code, citation: e.citation, reason: e.message }, command: `${PROCESS_35_11} ${name}`, subject };
      if (e instanceof RangeError) return { status: 400, body: { error: "bad_request", code: "BAD_REQUEST", reason: e.message }, command: `${PROCESS_35_11} ${name}`, subject };
      throw e;
    }
  };
  const uuidParam = (p: Record<string, string>, k: string): string => { const v = p[k] ?? ""; if (!isUuid(v)) throw new RangeError(`${k} is a uuid`); return v; };
  const q = (r: ControlsRequest, k: string): string | undefined => { const v = r.query.get(k); return v === null || v === "" ? undefined : v; };
  return [
    { method: "GET", path: "/api/stewardship/report", roles: STEWARDSHIP_REPORT_ROLES, command: "ops.report", handler: (r) => act("ops.report", r.actor, { environment: q(r, "environment") ?? rt.environment, as_of_date: q(r, "as_of_date"), force: false }, null) },
    { method: "GET", path: "/api/stewardship/exceptions", roles: STEWARDSHIP_READ_ROLES, command: "ops.exceptions.list", handler: (r) => act("ops.exceptions.list", r.actor, { environment: q(r, "environment"), status: q(r, "status"), kind: q(r, "kind"), adapter: q(r, "adapter"), source_kind: q(r, "source_kind"), limit: q(r, "limit") }, null) },
    { method: "POST", path: "/api/stewardship/exceptions/:id/classify", roles: STEWARDSHIP_ACT_ROLES, command: "ops.exceptions.classify", handler: (r) => act("ops.exceptions.classify", r.actor, { exception_id: uuidParam(r.params, "id") }, { kind: "ops_exception", id: r.params["id"]! }) },
    { method: "POST", path: "/api/stewardship/exceptions/:id/assign", roles: STEWARDSHIP_ACT_ROLES, command: "ops.exceptions.assign", handler: (r) => act("ops.exceptions.assign", r.actor, { exception_id: uuidParam(r.params, "id"), role: r.body["role"], reason: r.body["reason"] }, { kind: "ops_exception", id: r.params["id"]! }) },
    { method: "POST", path: "/api/stewardship/exceptions/:id/resolve", roles: STEWARDSHIP_ACT_ROLES, command: "ops.exceptions.resolve", handler: (r) => act("ops.exceptions.resolve", r.actor, { exception_id: uuidParam(r.params, "id"), disposition: r.body["disposition"], reason: r.body["reason"] }, { kind: "ops_exception", id: r.params["id"]! }) },
    // the hand requeue is 34.4's, with the session's actor: the exception names the message; the person's requeue counts toward REQUEUE_CAP_3
    { method: "POST", path: "/api/stewardship/exceptions/:id/requeue", roles: STEWARDSHIP_ACT_ROLES, command: "controls.outbox.requeue", handler: async (r) => {
      const id = uuidParam(r.params, "id");
      const x = (await rt.db.query<{ source_kind: string; source_id: string }>(`SELECT source_kind, source_id FROM ops_exceptions WHERE id = $1::uuid`, [id]))[0];
      if (!x) return { status: 404, body: { error: "no_such_exception", code: "NO_SUCH_EXCEPTION", reason: `no exception ${id}` }, command: "controls.outbox.requeue", subject: { kind: "ops_exception", id } };
      if (x.source_kind !== "integration_message") return { status: 409, body: { error: "not_a_message", code: "NOT_A_MESSAGE", reason: `a ${x.source_kind} exception has no message to requeue` }, command: "controls.outbox.requeue", subject: { kind: "ops_exception", id } };
      try { const out = await requeueMessage(rt, { id: x.source_id, actor: r.actor, reason: s(r.body["reason"]) || null }, r.now); return { status: 200, body: { ...out, exception_id: id }, command: "controls.outbox.requeue", subject: { kind: "integration_message", id: x.source_id } }; }
      catch (e) { if (e instanceof StaffError) return { status: e.status, body: { error: e.code.toLowerCase(), code: e.code, reason: e.message, ...e.extra }, command: "controls.outbox.requeue", subject: { kind: "ops_exception", id } }; throw e; }
    } },
    { method: "GET", path: "/api/stewardship/runbook/:code", roles: STEWARDSHIP_READ_ROLES, command: "ops.runbook.read", handler: (r) => { const code = r.params["code"] ?? ""; const key = /^SM_[A-Z0-9_]+$/.test(code) ? "timer_code" : q(r, "kind") === "adapter" || /-/.test(code) ? "adapter" : "cycle_code"; return act("ops.runbook.read", r.actor, { [key]: code }, null); } },
  ];
}
