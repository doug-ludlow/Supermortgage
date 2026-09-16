/**
 * §35.7 rule 8 — break-glass is loud, short and reviewed. An active compliance or officer account assumes a role it does
 * not hold for ONE subject (a loan or an application) and 4 hours with a reason: a role_grants{action: breakglass} row, a
 * breakglass_uses row, `role.breakglass.used` on the `breakglass` aggregate (arms SM_ROLE_BREAKGLASS_REVIEW_1BD) and a
 * decision. The four independence roles cannot be broken into (NO_BREAKGLASS_INDEPENDENT_ROLE — the bus guardrail, re-checked
 * here), nor a role whose pair the person already holds (rule 3). A second break-glass by the same person for the same
 * subject and role inside the 4 hours returns the existing use (no second clock). The acts under it are the surfaces'
 * concern (the held set carries the role for the matching subject only, ROLE_DENIED elsewhere — src/console/server.ts and
 * v1-auth.ts). The review is by a DIFFERENT compliance member (APPROVER_DISTINCT otherwise): `role.breakglass.reviewed` and a
 * decision, never an update. The expiry is the sweep's (sweep.ts): a role_grants{breakglass_expired} row and
 * `role.revoked{cause: breakglass_expired}`.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import type { StaffActDeps } from "../../../runtime/staff/auth.ts";
import { conflictsWith } from "./matrix.ts";
import { RolesRefused } from "./refusals.ts";
import { requireActiveStaff } from "./actors.ts";
import { GRANT_COLS, decisionIdOf, grantAggregate, type GrantRow } from "./grants.ts";
import { BREAKGLASS_HOURS, INDEPENDENCE_ROLES, P, STAFF_WORDS, hoursAfter, isKernelRole, isUuid, s } from "./types.ts";

export interface BreakglassSubject { readonly kind: "loan" | "application"; readonly id: string }
export interface BreakglassUse { readonly id: string; readonly grant_id: string; readonly staff_user_id: string; readonly role: string; readonly subject_kind: "loan" | "application"; readonly subject_id: string; readonly reason: string; readonly used_at: string; readonly expires_at: string }
const USE_COLS = `id::text AS id, grant_id::text AS grant_id, staff_user_id::text AS staff_user_id, role, subject_kind, subject_id::text AS subject_id, reason, used_at::text AS used_at, expires_at::text AS expires_at`;
export const breakglassAggregate = (id: string): { kind: string; id: string } => ({ kind: "breakglass", id });
const nameOf = (a: Actor): string => (a.kind === "human" ? a.id : `${a.kind}:${a.id}`);

export function subjectOf(v: unknown): BreakglassSubject {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  if (isUuid(o["loan_id"])) return { kind: "loan", id: o["loan_id"] };
  if (isUuid(o["application_id"])) return { kind: "application", id: o["application_id"] };
  throw new RangeError("subject is required: {loan_id} or {application_id} (a uuid)");
}
/** The person's break-glass uses that are still inside their 4 hours and whose grant row has not expired (the sweep writes the expiry row). */
export async function activeBreakglassOf(q: Queryable, staffUserId: string, nowIso: string): Promise<BreakglassUse[]> {
  return q.query<BreakglassUse & Record<string, unknown>>(`SELECT ${USE_COLS} FROM breakglass_uses u WHERE u.staff_user_id = $1 AND u.expires_at > $2::timestamptz
      AND NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.staff_user_id = u.staff_user_id AND g.role = u.role AND g.action = 'breakglass_expired' AND g.request_id = u.id) ORDER BY u.used_at DESC`, [staffUserId, nowIso]);
}
/** Every break-glass use of the person (active or not), newest first — the surfaces answer ROLE_DENIED for a role that was only ever broken into. */
export async function breakglassUsesOf(q: Queryable, staffUserId: string): Promise<BreakglassUse[]> {
  return q.query<BreakglassUse & Record<string, unknown>>(`SELECT ${USE_COLS} FROM breakglass_uses WHERE staff_user_id = $1 ORDER BY used_at DESC`, [staffUserId]);
}
export async function breakglassUse(q: Queryable, id: string): Promise<BreakglassUse | undefined> { return isUuid(id) ? (await q.query<BreakglassUse & Record<string, unknown>>(`SELECT ${USE_COLS} FROM breakglass_uses WHERE id = $1`, [id]))[0] : undefined; }

export interface BreakglassInput { readonly role: string; readonly subject: unknown; readonly reason: string; readonly environment: string }
export interface BreakglassResult { readonly breakglass_id: string; readonly grant_id: string; readonly staff_user_id: string; readonly role: string; readonly subject: BreakglassSubject; readonly used_at: string; readonly expires_at: string; readonly existing: boolean; readonly by: string }
export async function breakGlass(d: StaffActDeps, i: BreakglassInput): Promise<BreakglassResult> {
  const what = "roles.breakglass";
  const subject = subjectOf(i.subject);
  const reason = typeof i.reason === "string" ? i.reason.trim() : "";
  if (!reason) throw new RangeError("reason is required");
  if (!isKernelRole(i.role)) throw new RolesRefused(409, "UNKNOWN_ROLE", `${what}: ${s(i.role) || "(none)"} is not one of the kernel's human roles`, { role: i.role });
  if (INDEPENDENCE_ROLES.includes(i.role)) throw new RolesRefused(409, "NO_BREAKGLASS_INDEPENDENT_ROLE", `${what}: ${i.role} is an independence role and cannot be broken into (35.7 rule 8)`, { role: i.role });
  if (STAFF_WORDS.includes(i.role)) throw new RolesRefused(409, "STAFF_ROLE_IS_34_1", `${what}: ${i.role} is a staff role (34.1)`, { role: i.role });
  const person = await requireActiveStaff(d.db, d.actor, ["compliance", "officer"], what, i.environment);
  const held = [...person.roles, ...person.reviewer_roles];
  if (held.includes(i.role)) throw new RolesRefused(409, "ROLE_ALREADY_HELD", `${person.id} already holds ${i.role}; no break-glass is needed`, { role: i.role });
  const conflicts = conflictsWith(i.role, held);
  if (conflicts.length) throw new RolesRefused(409, "ROLE_DISJOINT", `${what}: ${i.role} may not be assumed beside ${conflicts.join(", ")} (35.7 rule 3)`, { role: i.role, conflicts_with: conflicts });
  const existing = (await activeBreakglassOf(d.db, person.id, d.now)).find((u) => u.role === i.role && u.subject_kind === subject.kind && u.subject_id === subject.id);
  if (existing) return { breakglass_id: existing.id, grant_id: existing.grant_id, staff_user_id: person.id, role: i.role, subject, used_at: existing.used_at, expires_at: existing.expires_at, existing: true, by: nameOf(d.actor) };
  const breakglass_id = randomUUID(); const grant_id = randomUUID(); const used_at = d.now; const expires_at = hoursAfter(used_at, BREAKGLASS_HOURS);
  d.deferWrite(async (q) => {
    const decision_id = await decisionIdOf(q, "breakglass", breakglass_id);
    await q.query(`INSERT INTO role_grants (id, staff_user_id, role, environment, action, request_id, granted_by, confirmed_by, cause, rationale, decision_id, effective_at, expires_at) VALUES ($1, $2, $3, $4, 'breakglass', $5, $6, NULL, 'breakglass', $7, $8, $9, $10)`,
      [grant_id, person.id, i.role, i.environment, breakglass_id, person.fake ? null : person.id, reason, decision_id, used_at, expires_at]);
    await q.query(`INSERT INTO breakglass_uses (id, grant_id, staff_user_id, role, subject_kind, subject_id, reason, used_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [breakglass_id, grant_id, person.id, i.role, subject.kind, subject.id, reason, used_at, expires_at]);
  });
  d.events.append({ type: "role.breakglass.used", aggregate: breakglassAggregate(breakglass_id), actor: d.actor, payload: P({ breakglass_id, grant_id, staff_user_id: person.id, role: i.role, environment: i.environment, subject, used_at, expires_at }) });
  return { breakglass_id, grant_id, staff_user_id: person.id, role: i.role, subject, used_at, expires_at, existing: false, by: nameOf(d.actor) };
}

export interface ReviewInput { readonly breakglass_id: string; readonly disposition: string; readonly reason?: string | null; readonly environment: string }
export interface ReviewResult { readonly breakglass_id: string; readonly grant_id: string; readonly reviewed_by: string; readonly disposition: "justified" | "unjustified"; readonly reason: string | null }
export async function reviewBreakGlass(d: StaffActDeps, i: ReviewInput): Promise<ReviewResult> {
  const what = "roles.breakglass:review";
  const use = await breakglassUse(d.db, s(i.breakglass_id));
  if (!use) throw new RangeError(`no break-glass use ${s(i.breakglass_id) || "(none)"}`);
  if (i.disposition !== "justified" && i.disposition !== "unjustified") throw new RangeError("disposition ∈ {justified, unjustified} is required");
  const reviewer = await requireActiveStaff(d.db, d.actor, ["compliance"], what, i.environment);
  if (reviewer.id === use.staff_user_id) throw new RolesRefused(409, "APPROVER_DISTINCT", `the review of break-glass ${use.id} is a different compliance member's than the person who used it (35.7 rule 8)`, { breakglass_id: use.id });
  const prior = await d.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'role.breakglass.reviewed' AND payload->>'breakglass_id' = $1`, [use.id]);
  if (Number(prior[0]!.n) > 0) throw new RolesRefused(409, "ALREADY_REVIEWED", `break-glass ${use.id} was reviewed already`, { breakglass_id: use.id });
  const reason = (typeof i.reason === "string" && i.reason.trim()) || null;
  d.events.append({ type: "role.breakglass.reviewed", aggregate: breakglassAggregate(use.id), actor: d.actor, payload: P({ breakglass_id: use.id, grant_id: use.grant_id, staff_user_id: use.staff_user_id, role: use.role, reviewed_by: nameOf(d.actor), disposition: i.disposition, reason, reviewed_at: d.now }) });
  return { breakglass_id: use.id, grant_id: use.grant_id, reviewed_by: nameOf(d.actor), disposition: i.disposition, reason };
}

/** The uses whose 4 hours have passed and whose grant has no expiry row yet (the sweep writes it). */
export async function expiredBreakglass(q: Queryable, nowIso: string): Promise<(BreakglassUse & { grant: GrantRow })[]> {
  const rows = await q.query<BreakglassUse & Record<string, unknown>>(`SELECT ${USE_COLS} FROM breakglass_uses u WHERE u.expires_at <= $1::timestamptz
      AND NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.action = 'breakglass_expired' AND g.request_id = u.id) ORDER BY u.expires_at`, [nowIso]);
  const out: (BreakglassUse & { grant: GrantRow })[] = [];
  for (const u of rows) { const [g] = await q.query<GrantRow & Record<string, unknown>>(`SELECT ${GRANT_COLS} FROM role_grants WHERE id = $1`, [u.grant_id]); if (g) out.push({ ...u, grant: g }); }
  return out;
}
export const breakglassExpiredRow = async (q: Queryable, u: BreakglassUse, nowIso: string, id: string = randomUUID()): Promise<string> => {
  await q.query(`INSERT INTO role_grants (id, staff_user_id, role, environment, action, request_id, granted_by, confirmed_by, cause, rationale, decision_id, effective_at, expires_at) SELECT $1, g.staff_user_id, g.role, g.environment, 'breakglass_expired', $2, NULL, NULL, 'breakglass_expired', 'the 4 hours passed (35.7 rule 8)', NULL, $3, g.expires_at FROM role_grants g WHERE g.id = $4`, [id, u.id, nowIso, u.grant_id]);
  return id;
};
export const breakglassExpiredEvent = (u: BreakglassUse & { grant: GrantRow }, revokeId: string, nowIso: string) => ({ type: "role.revoked", aggregate: grantAggregate(u.grant_id), actor: { kind: "system" as const, id: "roles-35-7" }, payload: P({ grant_id: u.grant_id, revoke_id: revokeId, breakglass_id: u.id, staff_user_id: u.staff_user_id, role: u.role, environment: u.grant.environment, by: null, cause: "breakglass_expired", expired_at: nowIso, expires_at: u.expires_at }) });
