/**
 * §35.7 rule 9 — revocation cascades, dormancy is flagged. Called from 34.1's own acts (src/runtime/staff/auth.ts):
 *   cascadeDisable       staff.disable → in the same transaction a role_grants{revoke, cause: disabled} row per active reviewer
 *                        role, reviewer_roles = '{}', every principal of the person revoked, the identities row emptied;
 *                        `role.revoked{cause: disabled}` and `principal.revoked{cause: disabled}` beside `staff.disabled`.
 *   reviewerRolesReview  the access review's `change` naming reviewer_roles → the grants it drops are revoked with
 *                        cause access_review (the same transaction); a role it adds goes through roles.grant (never here).
 *   assertDormantRationales  the review's `keep` on a user with a dormant grant (SM_ROLE_GRANT_DORMANT_30D breached and not
 *                        exercised since) needs a `rationale` naming the grant (its id or its role) — DORMANT_GRANT_NEEDS_RATIONALE.
 *   mirrorAfterRoleSet   staff.role.set → the identities row follows the staff roles.
 * Every function takes the caller's Queryable and returns the events for the caller to append, so the rows and the events
 * commit together with 34.1's own.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor, EventInput } from "../../../kernel/events/index.ts";
import { PgStaffRepository } from "../../../runtime/staff/repo.ts";
import { activeGrants, decisionIdOf, grantAggregate } from "./grants.ts";
import { mirrorStaffIdentity } from "./identities.ts";
import { principalRevokedEvent, revokePrincipalsOf } from "./principals.ts";
import { RolesRefused } from "./refusals.ts";
import { P, isUuid } from "./types.ts";

export interface DormantGrant { readonly grant_id: string; readonly staff_user_id: string; readonly role: string; readonly environment: string; readonly timer_id: string; readonly breached_at: string | null; readonly effective_at: string }
/** The active grants whose SM_ROLE_GRANT_DORMANT_30D breached and that nothing exercised since (the board's `dormant_grants`). */
export async function dormantGrants(q: Queryable, environment: string | null = null): Promise<DormantGrant[]> {
  return q.query<DormantGrant & Record<string, unknown>>(`SELECT g.id::text AS grant_id, g.staff_user_id::text AS staff_user_id, g.role, g.environment, t.id::text AS timer_id, t.breached_at::text AS breached_at, g.effective_at::text AS effective_at
      FROM timers t JOIN role_grants g ON g.id::text = t.subject_id
      WHERE t.code = 'SM_ROLE_GRANT_DORMANT_30D' AND t.subject_kind = 'role_grant' AND t.status = 'breached' AND g.action = 'grant' AND ($1::text IS NULL OR g.environment = $1)
        AND NOT EXISTS (SELECT 1 FROM role_grants l WHERE l.staff_user_id = g.staff_user_id AND l.role = g.role AND l.environment = g.environment AND (l.created_at, l.id) > (g.created_at, g.id))
      ORDER BY t.breached_at, g.id`, [environment]);
}

const revokeRow = async (q: Queryable, g: { id: string; staff_user_id: string; role: string; environment: string }, cause: "disabled" | "access_review", by: string | null, nowIso: string): Promise<string> => {
  const id = randomUUID();
  const decision_id = await decisionIdOf(q, "staff_user", g.staff_user_id);
  await q.query(`INSERT INTO role_grants (id, staff_user_id, role, environment, action, request_id, granted_by, confirmed_by, cause, rationale, decision_id, effective_at) VALUES ($1, $2, $3, $4, 'revoke', NULL, NULL, NULL, $5, $6, $7, $8)`, [id, g.staff_user_id, g.role, g.environment, cause, cause === "disabled" ? "34.1 staff.disable (35.7 rule 9)" : "34.1 access review (35.7 rule 9)", decision_id, nowIso]);
  return id;
};
const revokedEvent = (g: { id: string; staff_user_id: string; role: string; environment: string }, revokeId: string, cause: string, by: string | null, actor: Actor, sessionsRevoked: readonly string[]): EventInput => ({ type: "role.revoked", aggregate: grantAggregate(g.id), actor, payload: P({ grant_id: g.id, revoke_id: revokeId, staff_user_id: g.staff_user_id, role: g.role, environment: g.environment, by, cause, sessions_revoked: sessionsRevoked }) });

/** 34.1 staff.disable's cascade: rows in `q` (the disable's transaction); the events returned ride beside `staff.disabled`. */
export async function cascadeDisable(q: Queryable, i: { staff_user_id: string; by: string | null; actor: Actor; now: string; sessions_revoked: readonly string[] }): Promise<EventInput[]> {
  const events: EventInput[] = [];
  const [row] = await q.query<{ reviewer_roles: string[] }>(`SELECT reviewer_roles FROM staff_users WHERE id = $1 FOR UPDATE`, [i.staff_user_id]);
  if (!row) return events;
  const envs = await q.query<{ environment: string }>(`SELECT DISTINCT environment FROM role_grants WHERE staff_user_id = $1`, [i.staff_user_id]);
  for (const e of envs) for (const g of await activeGrants(q, i.staff_user_id, e.environment)) { const rid = await revokeRow(q, g, "disabled", i.by, i.now); events.push(revokedEvent(g, rid, "disabled", i.by, i.actor, i.sessions_revoked)); }
  if (row.reviewer_roles.length) {
    // a word with no grant row (the nonprod bootstrap of an older row, or a hand-written one) still needs a ledger row for the trigger and the examiner
    for (const role of row.reviewer_roles) if (!(await q.query(`SELECT 1 FROM role_grants WHERE staff_user_id = $1 AND role = $2 AND action = 'revoke' AND cause = 'disabled' AND effective_at = $3`, [i.staff_user_id, role, i.now])).length) {
      const g = { id: randomUUID(), staff_user_id: i.staff_user_id, role, environment: envs[0]?.environment ?? "nonprod" };
      const rid = await revokeRow(q, g, "disabled", i.by, i.now); events.push(revokedEvent(g, rid, "disabled", i.by, i.actor, i.sessions_revoked));
    }
    await new PgStaffRepository(q).setReviewerRoles(i.staff_user_id, [], q);
  }
  for (const p of await revokePrincipalsOf(q, i.staff_user_id, i.by, "disabled", i.now)) events.push(principalRevokedEvent(p, i.by, "disabled", i.actor));
  await mirrorStaffIdentity(q, i.staff_user_id, i.now);
  return events;
}
/** 34.1 staff.role.set: the mirror follows the staff roles (rule 9: "the identities mirror row follows every change in the same transaction"). */
export async function mirrorAfterRoleSet(q: Queryable, staffUserId: string, nowIso: string): Promise<void> { await mirrorStaffIdentity(q, staffUserId, nowIso); }

/** The access review's `change` that names reviewer_roles: the grants it drops are revoked (cause access_review) in the review's transaction; the events returned ride beside `staff.access_review.completed`. */
export async function reviewerRolesReview(q: Queryable, i: { staff_user_id: string; reviewer_roles_after: readonly string[]; environment: string; by: string | null; actor: Actor; now: string }): Promise<EventInput[]> {
  const events: EventInput[] = [];
  const [row] = await q.query<{ reviewer_roles: string[] }>(`SELECT reviewer_roles FROM staff_users WHERE id = $1 FOR UPDATE`, [i.staff_user_id]);
  if (!row) return events;
  const dropped = row.reviewer_roles.filter((r) => !i.reviewer_roles_after.includes(r));
  if (!dropped.length) return events;
  const repo = new PgStaffRepository(q);
  const sessions = await repo.revokeSessionsOf(i.staff_user_id, i.now, q);
  for (const role of dropped) {
    const g = (await activeGrants(q, i.staff_user_id, i.environment)).find((x) => x.role === role) ?? { id: randomUUID(), staff_user_id: i.staff_user_id, role, environment: i.environment };
    const rid = await revokeRow(q, g, "access_review", i.by, i.now); events.push(revokedEvent(g, rid, "access_review", i.by, i.actor, sessions));
  }
  await repo.setReviewerRoles(i.staff_user_id, row.reviewer_roles.filter((r) => !dropped.includes(r)), q);
  await mirrorStaffIdentity(q, i.staff_user_id, i.now);
  return events;
}
/** DORMANT_GRANT_NEEDS_RATIONALE: a `keep` for a user with a dormant grant carries a rationale naming the grant (its id or its role). */
export async function assertDormantRationales(q: Queryable, decisions: readonly { staff_user_id: string; decision: string; rationale?: string | null }[]): Promise<void> {
  const dormant = await dormantGrants(q);
  for (const d of decisions) {
    if (d.decision !== "keep" || !isUuid(d.staff_user_id)) continue;
    for (const g of dormant.filter((x) => x.staff_user_id === d.staff_user_id)) {
      const text = typeof d.rationale === "string" ? d.rationale : "";
      if (!text.includes(g.grant_id) && !text.includes(g.role)) throw new RolesRefused(409, "DORMANT_GRANT_NEEDS_RATIONALE", `the keep of ${d.staff_user_id} needs a rationale naming the dormant grant ${g.grant_id} (${g.role}, never exercised in ${30} days — 35.7 rule 9)`, { staff_user_id: d.staff_user_id, grant_id: g.grant_id, role: g.role });
    }
  }
}
