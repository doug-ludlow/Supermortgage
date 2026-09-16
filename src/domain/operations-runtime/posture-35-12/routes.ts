/**
 * §35.12 — the portal routes (Inputs and triggers), a table the console mounts beside 35.7's (src/console/server.ts, the same
 * dispatch: the session resolved, the role chosen among `roles` — 403 ROLE_REQUIRED before any read — the handler with the
 * session's actor, the outcome completing the staff_actions row). Every handler runs its tool ON THE BUS (`runtime.execute`,
 * process 35.12) with the session's actor {kind: human, id: staff_user_id, role} (34.1 rule 3).
 *
 *   POST /ops/api/posture/manifests {environment, …}                              ciso | compliance | admin  → posture.record (a staff session; the deploy posts to /v1/posture/manifests)
 *   POST /ops/api/posture/check {environment, manifest_id?}                        ciso | compliance | admin  → posture.check
 *   POST /ops/api/posture/findings/{id}/resolve {cause, exception_id?, reason}      ciso                     → posture.drift.resolve
 *   POST /ops/api/integrations/switch {environment, vendor, mode, endpoint_class, secret_ref, egress_rule, rationale, request_id?}  ciso (request) | compliance (confirm) → integrations.switch
 *   GET  /ops/api/integrations?environment=                                          ops_analyst | officer | compliance | ciso | admin → integrations.status
 *   POST /ops/api/posture/drills {environment, …}                                    ciso                     → backup.drill
 *   POST /ops/api/posture/scans {environment, kind}                                  compliance               → data.scan
 *   POST /ops/api/posture/scans/{id}/purged {rebuilt_manifest_id}                    compliance               → data.scan{kind: nonprod_real_data, scan_id}
 *   POST /ops/api/parallel-run/open {environment, incumbent_servicer, loan_ids | book, opened_on}  officer → parallel_run.open
 *   POST /ops/api/parallel-run/{id}/reconcile {as_of_date, incumbent_file_document_id}  officer               → parallel_run.reconcile
 *   POST /ops/api/parallel-run/{id}/diffs/{diff_id} {disposition, reason}             officer                  → parallel_run.disposition
 *   POST /ops/api/parallel-run/{id}/close {outcome, reason}                           officer                  → parallel_run.close
 *   GET  /ops/api/parallel-run/{id}                                                   ops_analyst | officer | compliance | ciso | admin → the parallel-run board
 *   GET  /ops/api/go-live?environment=                                                compliance | ciso | officer | admin → go_live.check
 *   POST /ops/api/go-live/waive {environment, item_code, reason}                      compliance               → go_live.check{op: waive}
 *   POST /ops/api/go-live/attest {environment, request_id?}                           ciso (request) | compliance (confirm) → go_live.attest
 *   GET  /ops/api/posture?environment=                                                ops_analyst | officer | compliance | ciso | admin → the posture board
 * A PostureRefused (a StaffError) answers in the console's shape with its status, code and extras; a bus CommandRefused as 409.
 */
import type { Actor } from "../../../kernel/events/index.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { CommandRefused } from "../../../app/commands.ts";
import { StaffError } from "../../../runtime/staff/roles.ts";
import type { ControlsRoute, ControlsRequest, ControlsResponse } from "../../../runtime/controls/routes.ts";
import { postureBoard } from "./board.ts";
import { parallelRunBoard } from "./parallel-run.ts";
import { PROCESS_35_12, isUuid, s } from "./types.ts";

type Row = Record<string, unknown>;
export const POSTURE_READ_ROLES: readonly string[] = ["ops_analyst", "officer", "compliance", "ciso", "admin"];
export const POSTURE_ACT_ROLES: readonly string[] = ["ciso", "compliance", "admin"];
export const GO_LIVE_READ_ROLES: readonly string[] = ["compliance", "ciso", "officer", "admin"];

export function postureRoutes(deps: { readonly runtime: Runtime }): ControlsRoute[] {
  const rt = deps.runtime;
  const act = async (name: string, actor: Actor, input: Row, subject: { kind: string; id: string } | null): Promise<ControlsResponse> => {
    try {
      const r = await rt.execute({ process: PROCESS_35_12, name, loanId: "", actor, input });
      const o = (r.output ?? {}) as Row;
      return { status: 200, body: { ...o, decision_ids: r.decisions.map((d) => d.id), events: r.events.map((e) => e.type), escalations: r.escalations }, command: `${PROCESS_35_12} ${name}`, subject: subject ?? subjectOf(o) };
    } catch (e) {
      if (e instanceof StaffError) return { status: e.status, body: { error: e.code.toLowerCase(), code: e.code, reason: e.message, ...e.extra }, command: `${PROCESS_35_12} ${name}`, subject };
      if (e instanceof CommandRefused) return { status: 409, body: { error: "refused", command: e.command, code: e.code, citation: e.citation, reason: e.message }, command: `${PROCESS_35_12} ${name}`, subject };
      if (e instanceof RangeError) return { status: 400, body: { error: "bad_request", code: "BAD_REQUEST", reason: e.message }, command: `${PROCESS_35_12} ${name}`, subject };
      throw e;
    }
  };
  const uuidParam = (p: Record<string, string>, k: string): string => { const v = p[k] ?? ""; if (!isUuid(v)) throw new RangeError(`${k} is a uuid`); return v; };
  const env = (r: ControlsRequest): Row => ({ ...(typeof r.body["environment"] === "string" ? { environment: r.body["environment"] } : {}) });
  const qenv = (r: ControlsRequest): Row => ({ ...(r.query.get("environment") ? { environment: r.query.get("environment") } : {}) });
  return [
    { method: "POST", path: "/api/posture/manifests", roles: POSTURE_ACT_ROLES, command: "posture.record", handler: (r) => act("posture.record", r.actor, { ...r.body }, null) },
    { method: "POST", path: "/api/posture/check", roles: POSTURE_ACT_ROLES, command: "posture.check", handler: (r) => act("posture.check", r.actor, { ...env(r), ...(r.body["manifest_id"] ? { manifest_id: s(r.body["manifest_id"]) } : {}) }, null) },
    { method: "POST", path: "/api/posture/findings/:id/resolve", roles: ["ciso"], command: "posture.drift.resolve", handler: (r) => act("posture.drift.resolve", r.actor, { finding_id: uuidParam(r.params, "id"), cause: r.body["cause"], exception_id: r.body["exception_id"], reason: r.body["reason"], ...(r.body["op"] ? { op: r.body["op"] } : {}) }, { kind: "posture_finding", id: r.params["id"]! }) },
    { method: "POST", path: "/api/integrations/switch", roles: ["ciso", "compliance"], command: "integrations.switch", handler: (r) => act("integrations.switch", r.actor, { ...(r.body["request_id"] ? { op: "confirm", request_id: s(r.body["request_id"]) } : { op: "request", vendor: r.body["vendor"], mode: r.body["mode"], endpoint_class: r.body["endpoint_class"], secret_ref: r.body["secret_ref"], egress_rule: r.body["egress_rule"] }), rationale: r.body["rationale"], ...env(r) }, isUuid(r.body["request_id"]) ? { kind: "request", id: r.body["request_id"] } : null) },
    { method: "GET", path: "/api/integrations", roles: POSTURE_READ_ROLES, command: "integrations.status", handler: (r) => act("integrations.status", r.actor, qenv(r), null) },
    { method: "POST", path: "/api/posture/drills", roles: ["ciso"], command: "backup.drill", handler: (r) => act("backup.drill", r.actor, { ...r.body }, null) },
    { method: "POST", path: "/api/posture/scans", roles: ["compliance"], command: "data.scan", handler: (r) => act("data.scan", r.actor, { ...env(r), kind: r.body["kind"] }, null) },
    { method: "POST", path: "/api/posture/scans/:id/purged", roles: ["compliance"], command: "data.scan", handler: (r) => act("data.scan", r.actor, { ...env(r), kind: "nonprod_real_data", scan_id: uuidParam(r.params, "id"), rebuilt_manifest_id: r.body["rebuilt_manifest_id"] }, { kind: "data_scan", id: r.params["id"]! }) },
    { method: "POST", path: "/api/parallel-run/open", roles: ["officer"], command: "parallel_run.open", handler: (r) => act("parallel_run.open", r.actor, { ...env(r), incumbent_servicer: r.body["incumbent_servicer"], loan_ids: r.body["loan_ids"], book: r.body["book"], opened_on: r.body["opened_on"], reason: r.body["reason"] }, null) },
    { method: "POST", path: "/api/parallel-run/:id/reconcile", roles: ["officer"], command: "parallel_run.reconcile", handler: (r) => act("parallel_run.reconcile", r.actor, { parallel_run_id: uuidParam(r.params, "id"), as_of_date: r.body["as_of_date"], incumbent_file_document_id: r.body["incumbent_file_document_id"], ...(r.body["incumbent_file_csv"] ? { incumbent_file_csv: r.body["incumbent_file_csv"] } : {}) }, { kind: "parallel_run", id: r.params["id"]! }) },
    { method: "POST", path: "/api/parallel-run/:id/diffs/:diff_id", roles: ["officer"], command: "parallel_run.disposition", handler: (r) => act("parallel_run.disposition", r.actor, { parallel_run_id: uuidParam(r.params, "id"), diff_id: uuidParam(r.params, "diff_id"), disposition: r.body["disposition"], reason: r.body["reason"] }, { kind: "parallel_run_diff", id: r.params["diff_id"]! }) },
    { method: "POST", path: "/api/parallel-run/:id/close", roles: ["officer"], command: "parallel_run.close", handler: (r) => act("parallel_run.close", r.actor, { parallel_run_id: uuidParam(r.params, "id"), outcome: r.body["outcome"], reason: r.body["reason"] }, { kind: "parallel_run", id: r.params["id"]! }) },
    { method: "GET", path: "/api/go-live", roles: GO_LIVE_READ_ROLES, command: "go_live.check", handler: (r) => act("go_live.check", r.actor, { op: "check", ...qenv(r) }, null) },
    { method: "POST", path: "/api/go-live/waive", roles: ["compliance"], command: "go_live.check", handler: (r) => act("go_live.check", r.actor, { op: "waive", ...env(r), item_code: r.body["item_code"], reason: r.body["reason"] }, null) },
    { method: "POST", path: "/api/go-live/attest", roles: ["ciso", "compliance"], command: "go_live.attest", handler: (r) => act("go_live.attest", r.actor, { ...(r.body["request_id"] ? { op: "confirm", request_id: s(r.body["request_id"]) } : { op: "request" }), ...env(r), reason: r.body["reason"] }, isUuid(r.body["request_id"]) ? { kind: "request", id: r.body["request_id"] } : null) },
    { method: "GET", path: "/api/parallel-run/:id", roles: POSTURE_READ_ROLES, command: null, handler: async (r) => { const id = uuidParam(r.params, "id"); const board = await parallelRunBoard(rt.db, id, rt.clock.now()); return board["found"] === false ? { status: 404, body: { error: "not_found", code: "RUN_NOT_FOUND", parallel_run_id: id }, subject: null } : { status: 200, body: board, subject: { kind: "parallel_run", id } }; } },
    { method: "GET", path: "/api/posture", roles: POSTURE_READ_ROLES, command: null, handler: async (r) => ({ status: 200, body: await postureBoard(rt, { environment: r.query.get("environment") }), subject: null }) },
  ];
}
const subjectOf = (o: Row): { kind: string; id: string } | null => (typeof o["manifest_id"] === "string" ? { kind: "environment_manifest", id: o["manifest_id"] } : typeof o["run_id"] === "string" ? { kind: "posture_check_run", id: o["run_id"] } : typeof o["finding_id"] === "string" ? { kind: "posture_finding", id: o["finding_id"] } : typeof o["switch_id"] === "string" ? { kind: "integration_switch", id: o["switch_id"] } : typeof o["request_id"] === "string" ? { kind: "request", id: o["request_id"] } : typeof o["drill_id"] === "string" ? { kind: "restore_drill", id: o["drill_id"] } : typeof o["scan_id"] === "string" ? { kind: "data_scan", id: o["scan_id"] } : typeof o["parallel_run_id"] === "string" ? { kind: "parallel_run", id: o["parallel_run_id"] } : typeof o["checklist_id"] === "string" ? { kind: "go_live_checklist", id: o["checklist_id"] } : null);
