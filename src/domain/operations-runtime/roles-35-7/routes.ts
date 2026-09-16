/**
 * §35.7 — the portal routes (Inputs and triggers), a table the console mounts beside 34.4's (src/console/server.ts, the
 * same dispatch: the session resolved, the role chosen among `roles` — 403 ROLE_REQUIRED before any read — the handler
 * with the session's actor, the outcome completing the staff_actions row). Every handler runs its tool ON THE BUS
 * (`runtime.execute`, process 35.7) with the session's actor {kind: human, id: staff_user_id, role} (34.1 rule 3).
 *
 *   POST /ops/api/roles/grants {staff_user_id, role, environment?, rationale}      admin                  → roles.grant
 *   POST /ops/api/roles/grants/{request_id}/confirm                                 compliance             → roles.grant{op: confirm}
 *   POST /ops/api/roles/grants/{id}/revoke {rationale}                              admin                  → roles.revoke
 *   GET  /ops/api/roles/queue?environment=&role=&page=                              ops_analyst | compliance | admin → roles.queue
 *   POST /ops/api/roles/approvals {request_id}                                      any kernel role (the tool checks the request's) → roles.approve
 *   POST /ops/api/roles/breakglass {role, subject: {loan_id | application_id}, reason}  compliance | officer → roles.breakglass
 *   POST /ops/api/roles/breakglass/{id}/review {disposition, reason}                compliance             → roles.breakglass{op: review}
 *   POST /ops/api/principals {kind, staff_user_id?, party_id?, name, scopes, expires_at}  admin           → principals.issue (the token once, in this answer)
 *   POST /ops/api/principals/{id}/revoke {rationale}                                admin                  → principals.revoke
 *   POST /ops/api/handover/plan {environment}                                       compliance | admin     → handover.plan
 *   POST /ops/api/handover/enable {environment, role, request_id?}                  compliance | admin     → handover.enable{request | confirm}
 *   POST /ops/api/handover/revert {environment, role, rationale, request_id?}       compliance | admin     → handover.enable{op: revert} (one of the two people requests; the other confirms with request_id within 10 minutes)
 *   GET  /ops/api/handover/board?environment=                                       ops_analyst | officer | compliance | admin → handover.board
 * A RolesRefused (a StaffError) answers in the console's shape with its status, code and extras; a bus CommandRefused as 409.
 */
import type { Actor } from "../../../kernel/events/index.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { CommandRefused } from "../../../app/commands.ts";
import { StaffError } from "../../../runtime/staff/roles.ts";
import { HUMAN_ROLES } from "../../../app/roles.ts";
import type { ControlsRoute, ControlsRequest, ControlsResponse } from "../../../runtime/controls/routes.ts";
import { PROCESS_35_7, isUuid, s } from "./types.ts";

type Row = Record<string, unknown>;
export const ROLES_READ_ROLES: readonly string[] = ["ops_analyst", "compliance", "admin"];
export const BOARD_READ_ROLES: readonly string[] = ["ops_analyst", "officer", "compliance", "admin"];

export function rolesRoutes(deps: { readonly runtime: Runtime }): ControlsRoute[] {
  const rt = deps.runtime;
  const act = async (name: string, actor: Actor, input: Row, subject: { kind: string; id: string } | null, extra: (o: Row) => Row = () => ({})): Promise<ControlsResponse> => {
    try {
      const r = await rt.execute({ process: PROCESS_35_7, name, loanId: "", actor, input });
      const o = (r.output ?? {}) as Row;
      return { status: 200, body: { ...o, ...extra(o), decision_ids: r.decisions.map((d) => d.id), events: r.events.map((e) => e.type), escalations: r.escalations }, command: `${PROCESS_35_7} ${name}`, subject: subject ?? (typeof o["grant_id"] === "string" ? { kind: "grant", id: o["grant_id"] } : typeof o["principal_id"] === "string" ? { kind: "principal", id: o["principal_id"] } : typeof o["request_id"] === "string" ? { kind: "request", id: o["request_id"] } : null) };
    } catch (e) {
      if (e instanceof StaffError) return { status: e.status, body: { error: e.code.toLowerCase(), code: e.code, reason: e.message, ...e.extra }, command: `${PROCESS_35_7} ${name}`, subject };
      if (e instanceof CommandRefused) return { status: 409, body: { error: "refused", command: e.command, code: e.code, citation: e.citation, reason: e.message }, command: `${PROCESS_35_7} ${name}`, subject };
      if (e instanceof RangeError) return { status: 400, body: { error: "bad_request", code: "BAD_REQUEST", reason: e.message }, command: `${PROCESS_35_7} ${name}`, subject };
      throw e;
    }
  };
  const read = async (name: string, actor: Actor, input: Row): Promise<ControlsResponse> => act(name, actor, input, null);
  const uuidParam = (p: Record<string, string>, k: string): string => { const v = p[k] ?? ""; if (!isUuid(v)) throw new RangeError(`${k} is a uuid`); return v; };
  const env = (r: ControlsRequest): Row => ({ ...(typeof r.body["environment"] === "string" ? { environment: r.body["environment"] } : {}) });
  return [
    { method: "POST", path: "/api/roles/grants", roles: ["admin"], command: "roles.grant", handler: (r) => act("roles.grant", r.actor, { staff_user_id: r.body["staff_user_id"], role: r.body["role"], rationale: r.body["rationale"], ...env(r) }, isUuid(r.body["staff_user_id"]) ? { kind: "staff_user", id: r.body["staff_user_id"] } : null) },
    { method: "POST", path: "/api/roles/grants/:request_id/confirm", roles: ["compliance"], command: "roles.grant", handler: (r) => act("roles.grant", r.actor, { op: "confirm", request_id: uuidParam(r.params, "request_id"), ...env(r) }, { kind: "request", id: r.params["request_id"]! }) },
    { method: "POST", path: "/api/roles/grants/:id/revoke", roles: ["admin"], command: "roles.revoke", handler: (r) => act("roles.revoke", r.actor, { grant_id: uuidParam(r.params, "id"), rationale: r.body["rationale"], ...env(r) }, { kind: "grant", id: r.params["id"]! }) },
    { method: "GET", path: "/api/roles/queue", roles: ROLES_READ_ROLES, command: "roles.queue", handler: (r) => read("roles.queue", r.actor, { environment: r.query.get("environment"), role: r.query.get("role"), page: Number(r.query.get("page") ?? 1), page_size: Number(r.query.get("page_size") ?? 100) }) },
    { method: "POST", path: "/api/roles/approvals", roles: [...new Set(["ops_analyst", "officer", "compliance", "admin", ...HUMAN_ROLES])], command: "roles.approve", handler: (r) => act("roles.approve", r.actor, { request_id: s(r.body["request_id"]), ...env(r) }, isUuid(r.body["request_id"]) ? { kind: "request", id: r.body["request_id"] } : null) },
    { method: "POST", path: "/api/roles/breakglass", roles: ["compliance", "officer"], command: "roles.breakglass", handler: (r) => act("roles.breakglass", r.actor, { role: r.body["role"], subject: r.body["subject"], reason: r.body["reason"], ...env(r) }, null, (o) => ({ acted_as: undefined, ...o })) },
    { method: "POST", path: "/api/roles/breakglass/:id/review", roles: ["compliance"], command: "roles.breakglass", handler: (r) => act("roles.breakglass", r.actor, { op: "review", breakglass_id: uuidParam(r.params, "id"), disposition: r.body["disposition"], reason: r.body["reason"], ...env(r) }, { kind: "breakglass", id: r.params["id"]! }) },
    { method: "POST", path: "/api/principals", roles: ["admin"], command: "principals.issue", handler: (r) => act("principals.issue", r.actor, { kind: r.body["kind"], staff_user_id: r.body["staff_user_id"], party_id: r.body["party_id"], name: r.body["name"], scopes: r.body["scopes"], expires_at: r.body["expires_at"], ...env(r) }, isUuid(r.body["staff_user_id"]) ? { kind: "staff_user", id: r.body["staff_user_id"] } : null) },
    { method: "POST", path: "/api/principals/:id/revoke", roles: ["admin"], command: "principals.revoke", handler: (r) => act("principals.revoke", r.actor, { principal_id: uuidParam(r.params, "id"), rationale: r.body["rationale"], ...env(r) }, { kind: "principal", id: r.params["id"]! }) },
    { method: "POST", path: "/api/handover/plan", roles: ["compliance", "admin"], command: "handover.plan", handler: (r) => act("handover.plan", r.actor, { ...env(r) }, null) },
    { method: "POST", path: "/api/handover/enable", roles: ["compliance", "admin"], command: "handover.enable", handler: (r) => act("handover.enable", r.actor, { ...(r.body["request_id"] ? { op: "confirm", request_id: s(r.body["request_id"]) } : { op: "request", role: r.body["role"] }), rationale: r.body["rationale"], ...env(r) }, isUuid(r.body["request_id"]) ? { kind: "request", id: r.body["request_id"] } : null) },
    { method: "POST", path: "/api/handover/revert", roles: ["compliance", "admin"], command: "handover.enable", handler: (r) => act("handover.enable", r.actor, { op: "revert", role: r.body["role"], ...(r.body["request_id"] ? { request_id: s(r.body["request_id"]) } : {}), rationale: r.body["rationale"], ...env(r) }, isUuid(r.body["request_id"]) ? { kind: "request", id: r.body["request_id"] } : null) },
    { method: "GET", path: "/api/handover/board", roles: BOARD_READ_ROLES, command: "handover.board", handler: (r) => read("handover.board", r.actor, { environment: r.query.get("environment") }) },
  ];
}
