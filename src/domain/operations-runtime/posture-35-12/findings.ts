/**
 * §35.12 rule 3 — `posture.drift.resolve` (ciso): a finding resolves only by evidence. `cause: manifest` stands when the latest check
 * of the control on a manifest recorded after the finding passes (check.ts already resolved it then; this path answers the same
 * `resolved` row idempotently or refuses FINDING_CLOSES_BY_EVIDENCE). `cause: exception` needs a 19.2 `control_exceptions` row
 * approved by the Qualified Individual (`ciso`) whose `expires_at` is ≤ 12 months out (the table's CHECK) and not past: the finding
 * is `excepted`, `posture.drift.resolved{cause: exception}` satisfies SM_PROD_POSTURE_DRIFT_1BD; when the exception expires with the
 * check still failing, the next run opens a new finding (check.ts). No manifest and no exception → FINDING_CLOSES_BY_EVIDENCE, no row.
 * `op: acknowledge` writes the optional `acknowledged` row (the state machine's first arrow) and satisfies nothing.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import { FINDING_COLS, findingAggregate, findingById, type FindingRow } from "./check.ts";
import { byOf } from "./decision.ts";
import { decisionFor, personId, refuse, requireRole, type PostureDeps } from "./deps.ts";
import { PostureRefused } from "./refusals.ts";
import { P, isUuid, s } from "./types.ts";

export interface ResolveInput { readonly finding_id: string; readonly cause?: string | null; readonly exception_id?: string | null; readonly reason?: string | null; readonly op?: string | null }
export interface ResolveResult { readonly finding_id: string; readonly environment: string; readonly control_code: string; readonly action: "resolved" | "excepted" | "acknowledged"; readonly cause: "manifest" | "exception" | null; readonly exception_id: string | null; readonly expires_at: string | null; readonly check_id: string | null; readonly by: string }
export const RESOLVE_ROLES: readonly string[] = ["ciso"];

interface ExceptionRow { readonly id: string; readonly control_code: string; readonly approved_by: string; readonly approved_at: string; readonly expires_at: string }
async function exceptionRow(q: Queryable, id: string): Promise<ExceptionRow | undefined> {
  if (!isUuid(id)) return undefined;
  return (await q.query<ExceptionRow & Record<string, unknown>>(`SELECT id::text AS id, control_code, approved_by, approved_at::text AS approved_at, expires_at::text AS expires_at FROM control_exceptions WHERE id = $1`, [id]))[0];
}
/** A later manifest's passing check row for the finding's control (the evidence `cause: manifest` needs). */
async function passingCheckAfter(q: Queryable, f: FindingRow): Promise<{ id: string; checked_at: string } | undefined> {
  return (await q.query<{ id: string; checked_at: string }>(`SELECT c.id::text AS id, c.checked_at::text AS checked_at FROM posture_checks c JOIN environment_manifests m ON m.id = c.manifest_id WHERE c.environment = $1 AND c.control_code = $2 AND c.result = 'pass' AND m.created_at > $3::timestamptz ORDER BY c.checked_at DESC LIMIT 1`, [f.environment, f.control_code, f.detected_at]))[0];
}
const cisoApproved = async (q: Queryable, e: ExceptionRow): Promise<boolean> => {
  const id = e.approved_by.replace(/^human:/, "");
  if (!isUuid(id)) return e.approved_by.toLowerCase().includes("ciso");
  const [u] = await q.query<{ roles: string[]; reviewer_roles: string[] }>(`SELECT roles, reviewer_roles FROM staff_users WHERE id = $1`, [id]);
  return !!u && [...u.roles, ...u.reviewer_roles].includes("ciso");
};

export async function resolveFinding(d: PostureDeps, i: ResolveInput): Promise<ResolveResult> {
  const f = await findingById(d.db, s(i.finding_id));
  if (!f) refuse(404, "FINDING_NOT_FOUND", `no posture finding ${s(i.finding_id) || "(none)"}`, { finding_id: i.finding_id ?? null });
  const finding = f!;
  await requireRole(d, RESOLVE_ROLES, "posture.drift.resolve", finding.environment);
  const by = personId(d.actor); const now = d.now; const reason = (typeof i.reason === "string" && i.reason.trim()) || null;
  const write = (action: string, extra: { check_id?: string | null; resolved_at?: string | null; cause?: string | null; exception_id?: string | null }): void => d.deferWrite(async (q) => {
    const decision_id = await decisionFor(q, "finding", finding.finding_id);
    await q.query(`INSERT INTO posture_findings (finding_id, environment, control_code, action, check_id, severity, detected_at, resolved_at, cause, exception_id, by, decision_id) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11, $12)`,
      [finding.finding_id, finding.environment, finding.control_code, action, extra.check_id ?? finding.check_id, finding.severity, finding.detected_at, extra.resolved_at ?? null, extra.cause ?? null, extra.exception_id ?? null, by, decision_id]);
  });
  if (s(i.op) === "acknowledge") {
    if (finding.action !== "opened") refuse(409, "FINDING_NOT_OPEN", `finding ${finding.finding_id} is ${finding.action}; only an opened finding is acknowledged`, { finding_id: finding.finding_id, action: finding.action });
    write("acknowledged", {});
    d.events.append({ type: "posture.drift.acknowledged", aggregate: findingAggregate(finding.finding_id), actor: d.actor, payload: P({ finding_id: finding.finding_id, environment: finding.environment, control_code: finding.control_code, by: byOf(d.actor), reason }) });
    return { finding_id: finding.finding_id, environment: finding.environment, control_code: finding.control_code, action: "acknowledged", cause: null, exception_id: null, expires_at: null, check_id: finding.check_id, by: byOf(d.actor) };
  }
  if (finding.action === "resolved" || finding.action === "expired") refuse(409, "FINDING_NOT_OPEN", `finding ${finding.finding_id} is already ${finding.action}`, { finding_id: finding.finding_id, action: finding.action });
  const cause = s(i.cause);
  if (cause === "manifest") {
    const evidence = await passingCheckAfter(d.db, finding);
    if (!evidence) refuse(409, "FINDING_CLOSES_BY_EVIDENCE", `finding ${finding.finding_id} (${finding.control_code} in ${finding.environment}) has no later manifest whose check passes and no approved exception; a person cannot close a finding by hand (35.12 rule 3)`, { finding_id: finding.finding_id, control_code: finding.control_code, cause });
    write("resolved", { check_id: evidence!.id, resolved_at: now, cause: "manifest" });
    d.events.append({ type: "posture.drift.resolved", aggregate: findingAggregate(finding.finding_id), actor: d.actor, payload: P({ finding_id: finding.finding_id, environment: finding.environment, control_code: finding.control_code, resolved_at: now, cause: "manifest", check_id: evidence!.id, by: byOf(d.actor), reason }) });
    return { finding_id: finding.finding_id, environment: finding.environment, control_code: finding.control_code, action: "resolved", cause: "manifest", exception_id: null, expires_at: null, check_id: evidence!.id, by: byOf(d.actor) };
  }
  if (cause === "exception") {
    const e = await exceptionRow(d.db, s(i.exception_id));
    if (!e) refuse(409, "FINDING_CLOSES_BY_EVIDENCE", `finding ${finding.finding_id}: no 19.2 control_exceptions row ${s(i.exception_id) || "(none)"}; a finding is excepted only by an exception the Qualified Individual approved (35.12 rule 3)`, { finding_id: finding.finding_id, exception_id: i.exception_id ?? null, cause });
    const ex = e!;
    if (!(await cisoApproved(d.db, ex))) refuse(409, "FINDING_CLOSES_BY_EVIDENCE", `exception ${ex.id} was not approved by the Qualified Individual (ciso): approved_by = ${ex.approved_by}`, { finding_id: finding.finding_id, exception_id: ex.id, approved_by: ex.approved_by });
    if (Date.parse(`${ex.expires_at}T23:59:59Z`) < Date.parse(now)) refuse(409, "EXCEPTION_EXPIRED", `exception ${ex.id} expired on ${ex.expires_at}`, { finding_id: finding.finding_id, exception_id: ex.id, expires_at: ex.expires_at });
    if (Date.parse(ex.expires_at) > Date.parse(ex.approved_at) + 366 * 86_400_000) refuse(409, "EXCEPTION_TOO_LONG", `exception ${ex.id} runs past 12 months`, { exception_id: ex.id });
    write("excepted", { resolved_at: now, cause: "exception", exception_id: ex.id });
    d.events.append({ type: "posture.drift.resolved", aggregate: findingAggregate(finding.finding_id), actor: d.actor, payload: P({ finding_id: finding.finding_id, environment: finding.environment, control_code: finding.control_code, resolved_at: now, cause: "exception", exception_id: ex.id, expires_at: ex.expires_at, by: byOf(d.actor), reason }) });
    return { finding_id: finding.finding_id, environment: finding.environment, control_code: finding.control_code, action: "excepted", cause: "exception", exception_id: ex.id, expires_at: ex.expires_at, check_id: finding.check_id, by: byOf(d.actor) };
  }
  throw new PostureRefused(409, "FINDING_CLOSES_BY_EVIDENCE", `posture.drift.resolve needs cause ∈ {manifest, exception}: a finding resolves by a later manifest's passing check or an approved 19.2 exception, never by hand (35.12 rule 3)`, { finding_id: finding.finding_id, cause: cause || null });
}
/** Every finding of an environment with its current state (the posture board). */
export async function findingsBoard(q: Queryable, environment: string): Promise<FindingRow[]> {
  return q.query<FindingRow & Record<string, unknown>>(`SELECT DISTINCT ON (finding_id) ${FINDING_COLS} FROM posture_findings WHERE environment = $1 ORDER BY finding_id, created_at DESC, id DESC`, [environment]);
}
