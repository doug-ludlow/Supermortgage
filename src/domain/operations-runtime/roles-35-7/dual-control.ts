/**
 * §35.7 rule 2 (discrepancy 4) — a command whose tool declares dual control (`ToolDef.dualControl {role, threshold}` — the
 * `requireDualControl` sites: 5.2 postLedger, 3.7 releaseDisbursement) runs only when an approval record exists:
 *   1. the surface calls `executeWithControls` instead of `runtime.execute`; when `threshold(input)` holds it looks for the
 *      newest open `dual_control.requested` of the same command, requester and input hash (or the body's `request_id`)
 *      that a distinct verified person approved (`dual_control.approved`) and nothing consumed;
 *   2. found → the command runs with `approvedBy = the approver` (the decision row's approved_by / approved_role) and
 *      `input.approvals = [approver]` (what the sections' own requireDualControl sites read), and the wrapped handler
 *      appends `dual_control.consumed{request_id}` inside the command's own unit of work — consumption and the act commit together;
 *   3. not found → its own global unit of work appends `dual_control.requested{request_id, command, subject, requested_by,
 *      input_hash, expires_at}` (idempotent: an open unexpired request with the same hash answers the same id) and the surface
 *      is refused 409 APPROVER_DISTINCT{request_id}; nothing else ran. commands.ts's default (the actor as its own approver) is
 *      thereby refused for such commands.
 *   `roles.approve{request_id}` (tools) writes the approval by a distinct verified person holding the role.
 * Threshold false or no declaration → the command runs as today. After a commit under a granted or broken-into role the
 * surface records `role.exercised` (exercised.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import type { DualControlProbe, ToolDef, ToolInput } from "../../../app/tools.ts";
import { PgLedgerRepository } from "../../../infra/db/ledger.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import type { ExecuteRequest, ExecuteResponse, Runtime } from "../../../runtime/app.ts";
import type { StaffActDeps } from "../../../runtime/staff/auth.ts";
import { requireActiveStaff } from "./actors.ts";
import { recordExercise } from "./exercised.ts";
import { DualControlRefused, RolesRefused } from "./refusals.ts";
import { DUAL_CONTROL_REQUEST_HOURS, P, STAFF_WORDS, hoursAfter, isUuid, s, type Row } from "./types.ts";

export interface DualControlRequest { readonly request_id: string; readonly command: string; readonly process: string; readonly subject: { kind: string; id: string } | null; readonly requested_by: string; readonly requested_role: string | null; readonly role: string; readonly input_hash: string; readonly requested_at: string; readonly expires_at: string; readonly approved: { approved_by: string; approved_role: string; at: string } | null; readonly consumed_at: string | null }
const canonical = (v: unknown): unknown => (Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Row).filter(([k]) => k !== "request_id" && k !== "approvals").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonical(x)])) : typeof v === "bigint" ? v.toString() : v);
export const inputHash = (input: unknown): string => createHash("sha256").update(toJson(canonical(input))).digest("hex");
const requestAggregate = (id: string): { kind: string; id: string } => ({ kind: "dual_control_request", id });

export async function dualControlRequest(q: Queryable, requestId: string): Promise<DualControlRequest | undefined> {
  if (!isUuid(requestId)) return undefined;
  const [r] = await q.query<{ payload: Row; at: string; approved: Row | null; approved_at: string | null; consumed_at: string | null }>(`SELECT r.payload, r.occurred_at::text AS at,
      (SELECT a.payload FROM loan_events a WHERE a.type = 'dual_control.approved' AND a.payload->>'request_id' = r.payload->>'request_id' ORDER BY a.sequence LIMIT 1) AS approved,
      (SELECT a.occurred_at::text FROM loan_events a WHERE a.type = 'dual_control.approved' AND a.payload->>'request_id' = r.payload->>'request_id' ORDER BY a.sequence LIMIT 1) AS approved_at,
      (SELECT c.occurred_at::text FROM loan_events c WHERE c.type = 'dual_control.consumed' AND c.payload->>'request_id' = r.payload->>'request_id' ORDER BY c.sequence LIMIT 1) AS consumed_at
      FROM loan_events r WHERE r.type = 'dual_control.requested' AND r.payload->>'request_id' = $1 ORDER BY r.sequence DESC LIMIT 1`, [requestId]);
  if (!r) return undefined;
  const p = r.payload;
  return { request_id: s(p["request_id"]), command: s(p["command"]), process: s(p["process"]), subject: (p["subject"] as { kind: string; id: string } | null) ?? null, requested_by: s(p["requested_by"]), requested_role: p["requested_role"] === null ? null : s(p["requested_role"]), role: s(p["role"]), input_hash: s(p["input_hash"]), requested_at: r.at, expires_at: s(p["expires_at"]), approved: r.approved ? { approved_by: s(r.approved["approved_by"]), approved_role: s(r.approved["approved_role"]), at: r.approved_at ?? "" } : null, consumed_at: r.consumed_at };
}
/** The newest open request of this command by this requester with this input hash (idempotent re-submission). */
async function openRequestByHash(q: Queryable, command: string, requestedBy: string, hash: string, nowIso: string): Promise<DualControlRequest | undefined> {
  const rows = await q.query<{ request_id: string }>(`SELECT r.payload->>'request_id' AS request_id FROM loan_events r WHERE r.type = 'dual_control.requested' AND r.payload->>'command' = $1 AND r.payload->>'requested_by' = $2 AND r.payload->>'input_hash' = $3 AND (r.payload->>'expires_at')::timestamptz > $4::timestamptz
      AND NOT EXISTS (SELECT 1 FROM loan_events c WHERE c.type = 'dual_control.consumed' AND c.payload->>'request_id' = r.payload->>'request_id') ORDER BY r.sequence DESC LIMIT 1`, [command, requestedBy, hash, nowIso]);
  return rows[0] ? dualControlRequest(q, rows[0].request_id) : undefined;
}

export interface ControlsContext { readonly surface: "ops" | "v1"; readonly source: "session" | "principal" | "shared_token" | "header"; readonly requestId?: string | null; readonly grantRole?: string | null }
/** The surfaces' execute: dual control (rule 2) around the runtime's own execute, then `role.exercised` for a granted or broken-into role. */
export async function executeWithControls(rt: Runtime, req: ExecuteRequest, c: ControlsContext): Promise<ExecuteResponse> {
  const def = rt.tool(req.process, req.name);
  const command = `${req.process} ${req.name}`;
  const subject = req.loanId ? { kind: "loan", id: req.loanId } : req.applicationId ? { kind: "application", id: req.applicationId } : null;
  let out: ExecuteResponse;
  const now = rt.clock.now();
  const probe: DualControlProbe = { now, loanId: req.loanId || null, entities: rt.entities, ports: rt.ports as Record<string, unknown>, ledgerSets: () => (req.loanId ? new PgLedgerRepository(rt.db).setsForLoan(req.loanId) : Promise.resolve([])) };
  if (def?.dualControl && req.actor.kind === "human" && (await def.dualControl.threshold(req.input, probe))) {
    const hash = inputHash(req.input);
    let found = c.requestId ? await dualControlRequest(rt.db, c.requestId) : undefined;
    if (found && (found.command !== command || found.requested_by !== req.actor.id)) throw new RolesRefused(409, "APPROVAL_STALE", `request ${found.request_id} is for ${found.command} by ${found.requested_by}, not ${command} by ${req.actor.id}`, { request_id: found.request_id });
    if (found && found.input_hash !== hash) throw new RolesRefused(409, "APPROVAL_STALE", `request ${found.request_id} was approved for a different input; submit the input as approved or request anew`, { request_id: found.request_id });
    if (!found) found = await openRequestByHash(rt.db, command, req.actor.id, hash, now);
    if (found && found.consumed_at) throw new RolesRefused(409, "APPROVAL_STALE", `request ${found.request_id} was consumed at ${found.consumed_at}`, { request_id: found.request_id });
    if (found && Date.parse(found.expires_at) <= Date.parse(now)) found = undefined;
    if (!found || !found.approved) {
      const request_id = found?.request_id ?? randomUUID(); const expires_at = found?.expires_at ?? hoursAfter(now, DUAL_CONTROL_REQUEST_HOURS);
      if (!found) await rt.uow.run({}, (ctx) => ctx.events.append({ type: "dual_control.requested", aggregate: requestAggregate(request_id), actor: req.actor, payload: P({ request_id, command, process: req.process, subject, requested_by: req.actor.id, requested_role: req.actor.role ?? null, role: def.dualControl!.role, input_hash: hash, requested_at: now, expires_at, surface: c.surface }) }), { clock: rt.clock });
      throw new DualControlRefused({ request_id, command, subject, role: def.dualControl.role, expires_at, requested_by: req.actor.id });
    }
    const approver: Actor = { kind: "human", id: found.approved.approved_by, role: found.approved.approved_role };
    const requestId = found.request_id;
    const wrapped: ToolDef = { ...def, handler: async (input: ToolInput, ctx, r) => { const result = await def.handler(input, ctx, r); ctx.events.append({ type: "dual_control.consumed", aggregate: requestAggregate(requestId), actor: ctx.actor, payload: P({ request_id: requestId, command, approved_by: approver.id, approved_role: approver.role, consumed_at: ctx.now }) }); return result; } };
    try { out = await rt.executeDef(wrapped, { ...req, input: { ...req.input, approvals: [approver] }, approvedBy: approver }); }
    catch (e) {
      // migration 0171: one `dual_control.consumed` per request — a concurrent resubmission of the same approval fails on the partial unique index and is refused as stale, the command's transaction rolled back whole
      if (e instanceof Error && (e as { constraint?: string }).constraint === "loan_events_dual_control_consumed_once") throw new RolesRefused(409, "APPROVAL_STALE", `request ${requestId} was consumed by a concurrent submission`, { request_id: requestId });
      throw e;
    }
  } else {
    out = await rt.execute(req);
  }
  // the exercise receipt (rule 9) rides after the command's commit in its own unit of work; a failed write is logged, never silent — the next act under the grant writes it (exercised.ts dedupes per grant)
  if (c.grantRole && req.actor.kind === "human" && req.actor.role === c.grantRole && !STAFF_WORDS.includes(c.grantRole)) await recordExercise(rt, { staff_user_id: req.actor.id, role: c.grantRole, environment: rt.environment, command, subject, actor: req.actor }).catch((e: unknown) => { rt.logger?.error("role.exercised write failed", { staff_user_id: req.actor.id, role: c.grantRole, command, error: e instanceof Error ? e.message : String(e) }); });
  return out;
}

export interface ApproveResult { readonly request_id: string; readonly command: string; readonly subject: { kind: string; id: string } | null; readonly requested_by: string; readonly approved_by: string; readonly approved_role: string; readonly expires_at: string }
/** `roles.approve{request_id}` — the only way a dual-control approval record comes to exist: a distinct verified person holding the request's role. */
export async function approveRequest(d: StaffActDeps, i: { request_id: string; environment: string }): Promise<ApproveResult> {
  const r = await dualControlRequest(d.db, s(i.request_id));
  if (!r) throw new RolesRefused(409, "APPROVAL_STALE", `no dual-control request ${s(i.request_id) || "(none)"}`, { request_id: s(i.request_id) || null });
  if (r.consumed_at) throw new RolesRefused(409, "APPROVAL_STALE", `request ${r.request_id} already committed (${r.command}) at ${r.consumed_at}`, { request_id: r.request_id, command: r.command });
  if (Date.parse(r.expires_at) <= Date.parse(d.now)) throw new RolesRefused(409, "APPROVAL_STALE", `request ${r.request_id} expired at ${r.expires_at}`, { request_id: r.request_id, command: r.command });
  if (r.approved) throw new RolesRefused(409, "APPROVAL_STALE", `request ${r.request_id} was approved already by ${r.approved.approved_by}`, { request_id: r.request_id, command: r.command });
  if (d.actor.kind === "human" && d.actor.id === r.requested_by) throw new RolesRefused(409, "APPROVER_DISTINCT", `${d.actor.id} requested ${r.command} and may not approve it; a second, distinct ${r.role} does (35.7 rule 2)`, { request_id: r.request_id, command: r.command, role: r.role });
  const person = await requireActiveStaff(d.db, d.actor, [r.role], "roles.approve", i.environment);
  d.events.append({ type: "dual_control.approved", aggregate: requestAggregate(r.request_id), actor: d.actor, payload: P({ request_id: r.request_id, command: r.command, process: r.process, subject: r.subject, requested_by: r.requested_by, approved_by: person.id, approved_role: r.role, approved_at: d.now, expires_at: r.expires_at }) });
  return { request_id: r.request_id, command: r.command, subject: r.subject, requested_by: r.requested_by, approved_by: person.id, approved_role: r.role, expires_at: r.expires_at };
}
