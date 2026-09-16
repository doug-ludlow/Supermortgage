/**
 * 34.4 rule 2 — escalations: the list (open or completed, by role) and `completeEscalation`: a named person completes an
 * escalation with a disposition from the escalation's own set and a reason. The completion runs the owning section's
 * completion command with the staff actor where one exists (the same routing DELTA-30's FAKE reviewers use —
 * src/infra/integrations/reviewers.ts: a `human_agent` transfer closes through `4.3 human.transfer{op=complete}`, an MLO stage
 * review through `21.1 openEscalation{op=decide}`, an underwriting reviewer's item through `21.6 openReviewerEscalation{op=decide}`
 * else `23.3 openEscalation{op=complete}`); an escalation whose owning section has no completion command (a sweep's sev1–sev4
 * breach, a guardrail refusal, 34.4's own REQUEUE_CAP_3) is completed on the row with the disposition and the reason, and the
 * section's rows are untouched (the spec's edge case). Either way `escalation.completed{escalation_id, disposition, reason, by}`
 * is logged with the person as actor.
 *
 * ROLE_REQUIRED: the caller's role must be the escalation's `owner_role` (34.1 rule 3 names it before any write); a
 * `compliance` escalation refuses an `ops_analyst` session with `ROLE_REQUIRED{compliance}` (T2).
 */
import type { Actor } from "../../kernel/events/index.ts";
import { CommandRefused } from "../../app/commands.ts";
import { RoleDenied } from "../../app/roles.ts";
import type { Runtime } from "../app.ts";
import { CYCLE_BREACH_CODES } from "../../domain/operations-runtime/timers-35-3.ts";
import { ControlsRefused, appendEvent, clampLimit, isUuid, requireStaffRole, s, type Row } from "./common.ts";

export interface EscalationRow {
  readonly id: string; readonly kind: string; readonly owner_role: string; readonly severity: string | null; readonly status: "open" | "completed";
  readonly loan_id: string | null; readonly application_id: string | null; readonly case_id: string | null; readonly batch_id: string | null; readonly sla_timer_id: string | null;
  readonly opened_at: string; readonly opened_by: string; readonly completed_at: string | null; readonly completed_evidence_document_id: string | null;
  readonly payload: Row;
  /** From `escalation.completed`: who completed it, their role, the disposition and the reason (null while open). */
  readonly completed_by: string | null; readonly completed_by_role: string | null; readonly disposition: string | null; readonly reason: string | null;
  /** The owning section's completion command this escalation closes through, or `row` (completed on the escalation row). */
  readonly completion: { process: string; name: string } | "row";
  readonly dispositions: readonly string[];
}
export interface EscalationsFilter { readonly status?: string | null; readonly role?: string | null; readonly loan_id?: string | null; readonly application_id?: string | null; readonly limit?: number | null; }

/** The disposition sets: the owning command's own outcomes where it has one; `resolved | dismissed | referred` for a row completion. */
export const ROW_DISPOSITIONS: readonly string[] = ["resolved", "dismissed", "referred"];
export const DECIDE_DISPOSITIONS: readonly string[] = ["approved", "rejected"];
/**
 * 35.3 (T12): an escalation the cycle engine's clocks opened — the breach pass's payload carries `timer_code` SM_CYCLE_RUN_STALLED_1D
 * or SM_JOB_DEAD_2H — or that names a `cycle_code` (a dead unit's at death, a by-hand `cycles.escalate`) closes on the row with
 * `completed_late` beside the row dispositions: the run or the unit completed after its clock breached (the clock reads
 * `satisfied_late`). Every other escalation's set is unchanged.
 */
export function rowDispositions(e: { readonly payload: Row }): readonly string[] {
  const p = e.payload ?? {};
  const cycles = (typeof p["timer_code"] === "string" && CYCLE_BREACH_CODES.has(p["timer_code"])) || typeof p["cycle_code"] === "string";
  return cycles ? [...ROW_DISPOSITIONS, "completed_late"] : ROW_DISPOSITIONS;
}
interface Owning { readonly process: string; readonly name: string; readonly dispositions: readonly string[]; readonly input: (e: EscalationRow, disposition: string, reason: string, actor: Actor) => Row; readonly fallback?: Owning; }
/** The owning section's completion command for an escalation, by its owner role and package (the FAKE reviewers' routing, DELTA-30). */
export function owningCompletion(e: { owner_role: string; kind: string; application_id: string | null; payload: Row }): Owning | null {
  const p = e.payload;
  if (e.owner_role === "human_agent") return { process: "4.3", name: "human.transfer", dispositions: ["completed"], input: (row, _d, _r, actor) => ({ op: "complete", escalation_id: row.id, human_agent_name: s(p["human_agent_name"]) || actor.id }) };
  if (e.owner_role === "mlo_of_record" && s(p["stage"]) && e.application_id) return { process: "21.1", name: "openEscalation", dispositions: DECIDE_DISPOSITIONS, input: (row, d, r) => ({ op: "decide", escalation_id: row.id, decision: d, notes: r }) };
  if (e.owner_role === "underwriting_reviewer" && s(p["decision_id"]) && e.application_id) return { process: "21.6", name: "openReviewerEscalation", dispositions: DECIDE_DISPOSITIONS, input: (_row, d, r) => ({ op: "decide", decision_id: s(p["decision_id"]), outcome: d, notes: r }),
    fallback: { process: "23.3", name: "openEscalation", dispositions: DECIDE_DISPOSITIONS, input: (row) => ({ op: "complete", escalation_id: row.id }) } };
  return null;
}
export const dispositionsOf = (e: { owner_role: string; kind: string; application_id: string | null; payload: Row }): readonly string[] => owningCompletion(e)?.dispositions ?? rowDispositions(e);

const toRow = (r: Row): EscalationRow => {
  const base = { id: s(r["id"]), kind: s(r["kind"]), owner_role: s(r["owner_role"]), severity: r["severity"] ? s(r["severity"]) : null, status: (r["completed_at"] ? "completed" : "open") as "open" | "completed",
    loan_id: r["loan_id"] ? s(r["loan_id"]) : null, application_id: r["application_id"] ? s(r["application_id"]) : null, case_id: r["case_id"] ? s(r["case_id"]) : null, batch_id: r["batch_id"] ? s(r["batch_id"]) : null, sla_timer_id: r["sla_timer_id"] ? s(r["sla_timer_id"]) : null,
    opened_at: s(r["opened_at"]), opened_by: s(r["opened_by"]), completed_at: r["completed_at"] ? s(r["completed_at"]) : null, completed_evidence_document_id: r["completed_evidence_document_id"] ? s(r["completed_evidence_document_id"]) : null, payload: (r["payload"] as Row | null) ?? {} };
  const done = (r["completion"] as Row | null) ?? null;
  const owning = owningCompletion(base);
  return { ...base, completed_by: done ? s(done["completed_by"]) || null : null, completed_by_role: done ? s(done["completed_by_role"]) || null : null, disposition: done ? s(done["disposition"]) || null : null, reason: done ? s(done["reason"]) || null : null,
    completion: owning ? { process: owning.process, name: owning.name } : "row", dispositions: owning?.dispositions ?? rowDispositions(base) };
};
const SELECT = `SELECT e.id::text AS id, e.kind, e.owner_role, e.severity, e.loan_id::text AS loan_id, e.application_id::text AS application_id, e.case_id::text AS case_id, e.batch_id::text AS batch_id, e.sla_timer_id::text AS sla_timer_id,
    e.opened_at::text AS opened_at, e.opened_by, e.completed_at::text AS completed_at, e.completed_evidence_document_id::text AS completed_evidence_document_id, e.payload,
    (SELECT c.payload FROM loan_events c WHERE c.type = 'escalation.completed' AND c.payload->>'escalation_id' = e.id::text ORDER BY c.sequence DESC LIMIT 1) AS completion
  FROM escalations e`;

/** `GET /ops/api/controls/escalations?status=&role=` — open (default) | completed | all; by owner role; by loan or application. */
export async function listEscalations(rt: Runtime, f: EscalationsFilter = {}): Promise<{ as_of: string; count: number; escalations: EscalationRow[] }> {
  const status = f.status === "completed" || f.status === "all" ? f.status : "open";
  const where: string[] = []; const p: unknown[] = [];
  if (status === "open") where.push(`e.completed_at IS NULL`); else if (status === "completed") where.push(`e.completed_at IS NOT NULL`);
  if (f.role) { p.push(f.role); where.push(`e.owner_role = $${p.length}`); }
  if (f.loan_id) { if (!isUuid(f.loan_id)) throw new RangeError("loan_id is a uuid"); p.push(f.loan_id); where.push(`e.loan_id = $${p.length}::uuid`); }
  if (f.application_id) { if (!isUuid(f.application_id)) throw new RangeError("application_id is a uuid"); p.push(f.application_id); where.push(`e.application_id = $${p.length}::uuid`); }
  p.push(clampLimit(f.limit, 500, 5000));
  const rows = await rt.db.query<Row>(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY (e.completed_at IS NULL) DESC, e.opened_at DESC LIMIT $${p.length}`, p);
  return { as_of: rt.clock.now(), count: rows.length, escalations: rows.map(toRow) };
}
export async function getEscalation(rt: Runtime, id: string): Promise<EscalationRow | null> {
  if (!isUuid(id)) throw new RangeError("escalation id is a uuid");
  const r = (await rt.db.query<Row>(`${SELECT} WHERE e.id = $1::uuid`, [id]))[0]; return r ? toRow(r) : null;
}

export interface CompleteEscalationResult { readonly escalation_id: string; readonly kind: string; readonly owner_role: string; readonly disposition: string; readonly reason: string; readonly completed_at: string; readonly completed_by: string; readonly completed_by_role: string; readonly via: { process: string; name: string } | "row"; readonly events: readonly string[]; readonly decision_ids: readonly string[]; readonly loan_id: string | null; readonly application_id: string | null; }
/**
 * `controls.escalation.complete{id, disposition, reason}` — rule 2. The actor is the staff member as `{human, staff_user_id, role}`;
 * the role must be the escalation's own (`ROLE_REQUIRED{owner_role}`); the disposition one of the escalation's set; the reason
 * non-empty. The owning command runs first where one exists (its refusal is the answer; nothing else is written); then the
 * row and `escalation.completed` — one transaction for the row path.
 */
export async function completeEscalation(rt: Runtime, i: { id: string; disposition: string; reason: string; actor: Actor }, nowIso: string = rt.clock.now()): Promise<CompleteEscalationResult> {
  const e = await getEscalation(rt, i.id); if (!e) throw new ControlsRefused(404, "NO_SUCH_ESCALATION", `no escalation ${i.id}`);
  await requireStaffRole(rt.db, i.actor, [e.owner_role], `completing escalation ${e.id} (${e.kind}, owned by ${e.owner_role})`);
  if (e.status === "completed") throw new ControlsRefused(409, "ALREADY_COMPLETED", `escalation ${e.id} was completed at ${e.completed_at}`, { completed_at: e.completed_at, completed_by: e.completed_by });
  const disposition = (i.disposition ?? "").trim(); const reason = (i.reason ?? "").trim();
  if (!e.dispositions.includes(disposition)) throw new ControlsRefused(400, "DISPOSITION_REQUIRED", `disposition is one of ${e.dispositions.join(" | ")} for this escalation`, { dispositions: e.dispositions });
  if (!reason) throw new ControlsRefused(400, "REASON_REQUIRED", "a reason is required");
  const owning = owningCompletion(e);
  const events: string[] = []; const decisionIds: string[] = []; let via: CompleteEscalationResult["via"] = "row";
  if (owning) {
    const exec = async (o: Owning): Promise<void> => {
      const out = await rt.execute({ process: o.process, name: o.name, loanId: e.loan_id ?? "", ...(e.application_id ? { applicationId: e.application_id } : {}), actor: i.actor, input: o.input(e, disposition, reason, i.actor) });
      events.push(...out.events.map((x) => x.type)); decisionIds.push(...out.decisions.map((d) => d.id)); via = { process: o.process, name: o.name };
    };
    try { await exec(owning); }
    catch (err) {
      if (owning.fallback && (err instanceof CommandRefused || err instanceof RangeError)) await exec(owning.fallback);
      else if (err instanceof RoleDenied) throw new ControlsRefused(403, "ROLE_REQUIRED", err.message, { role: err.required[0] });
      else throw err;
    }
  }
  // the row: completed by the person with the disposition and the reason; the receipt event when the owning command did not log one
  const completed = await rt.db.tx(async (q) => {
    const rows = await q.query<{ completed_at: string }>(`UPDATE escalations SET completed_at = coalesce(completed_at, $2::timestamptz), status = 'completed' WHERE id = $1::uuid RETURNING completed_at::text AS completed_at`, [e.id, nowIso]);
    const at = rows[0]?.completed_at ?? nowIso;
    // the receipt: the disposition and the reason ride a 34.4-shaped `escalation.completed` (the owning command's own receipt, when it logged one, stays beside it — the list and the pack read the newest)
    await appendEvent(q, { type: "escalation.completed", actor: i.actor, loan_id: e.loan_id, application_id: e.application_id, aggregate: { kind: "escalation", id: e.id }, occurred_at: nowIso,
      payload: { escalation_id: e.id, kind: e.kind, owner_role: e.owner_role, disposition, reason, by: i.actor.id, completed_by: i.actor.id, completed_by_role: i.actor.role ?? null, completed_at: at, via: via === "row" ? "controls.escalation.complete" : `${via.process} ${via.name}`, evidence_document_id: null } });
    if (!events.includes("escalation.completed")) events.push("escalation.completed");
    return at;
  });
  rt.logger?.info("controls.escalation.completed", { escalation_id: e.id, kind: e.kind, owner_role: e.owner_role, disposition, by: i.actor.id, role: i.actor.role ?? null, via });
  return { escalation_id: e.id, kind: e.kind, owner_role: e.owner_role, disposition, reason, completed_at: completed, completed_by: i.actor.id, completed_by_role: i.actor.role ?? "", via, events, decision_ids: decisionIds, loan_id: e.loan_id, application_id: e.application_id };
}
