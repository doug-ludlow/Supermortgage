/**
 * §35.7 — the grants (rules 1, 3, 9; state machine "per grant"): `roles.grant` by an admin for a person other than
 * themselves, refused UNKNOWN_ROLE / ROLE_DISJOINT{role, conflicts_with} / STAFF_ROLE_IS_34_1 before any write; an
 * independence role (qc_officer, funding_approver, ciso, bsa_officer) waits as `role.grant.requested{request_id}` for a
 * compliance member — a different person, not the grantee (CONFIRMER_IS_HOLDER) — to confirm within 10 minutes, else the
 * request expires (REQUEST_EXPIRED, `role.grant.request.expired`); every other role activates at once. Activation is one
 * transaction: the role_grants{grant} row, staff_users.reviewer_roles (under the row's lock — two admins granting at once
 * end with the second refused ALREADY_HELD, one `role.granted`), the identities mirror, the decision row's id on the grant row,
 * `role.granted{grant_id, …}` on the `role_grant` aggregate (arms SM_ROLE_GRANT_DORMANT_30D) and, when the role's latest
 * queue snapshot is `unstaffed`, `role.staffed{cause: grant}` on the `role_queue` aggregate (satisfies
 * SM_ROLE_QUEUE_UNSTAFFED_1BD). `roles.revoke` writes the revoke row, drops the word, revokes the person's sessions (34.1
 * rule 5) and mirrors. The functions take 34.1's StaffActDeps (the command's stores) and run inside the tool's unit of work:
 * rows are deferred into the command's transaction, events ride ctx.events, so a refusal writes nothing.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import type { StaffActDeps } from "../../../runtime/staff/auth.ts";
import { PgStaffRepository } from "../../../runtime/staff/repo.ts";
import { isSelfChange } from "../../../runtime/staff/roles.ts";
import { conflictsWith } from "./matrix.ts";
import { mirrorStaffIdentity } from "./identities.ts";
import { RolesRefused } from "./refusals.ts";
import { requireActiveStaff, staffRow } from "./actors.ts";
import { latestSnapshot, roleQueueAggregate } from "./snapshots.ts";
import { CONFIRM_MINUTES, INDEPENDENCE_ROLES, P, STAFF_WORDS, isKernelRole, isUuid, minutesAfter, s, type Row } from "./types.ts";

export interface GrantInput { readonly staff_user_id: string; readonly role: string; readonly environment: string; readonly rationale?: string | null }
export interface GrantResult { readonly status: "active" | "pending" | "already_held"; readonly grant_id: string | null; readonly request_id: string | null; readonly staff_user_id: string; readonly role: string; readonly environment: string; readonly expires_at?: string; readonly by: string; readonly confirmed_by: string | null; readonly staffed: boolean }
export interface GrantRow { readonly id: string; readonly staff_user_id: string; readonly role: string; readonly environment: string; readonly action: string; readonly request_id: string | null; readonly granted_by: string | null; readonly confirmed_by: string | null; readonly cause: string | null; readonly rationale: string | null; readonly decision_id: string | null; readonly effective_at: string; readonly expires_at: string | null; readonly created_at: string }

export const GRANT_COLS = `id::text AS id, staff_user_id::text AS staff_user_id, role, environment, action, request_id::text AS request_id, granted_by::text AS granted_by, confirmed_by::text AS confirmed_by, cause, rationale, decision_id::text AS decision_id, effective_at::text AS effective_at, expires_at::text AS expires_at, created_at::text AS created_at`;
export const grantAggregate = (grantId: string): { kind: string; id: string } => ({ kind: "role_grant", id: grantId });
const nameOf = (a: Actor): string => (a.kind === "human" ? a.id : `${a.kind}:${a.id}`);

/** The latest row for (person, role, environment); `active` when it is a grant (or an unexpired break-glass). */
export async function latestGrant(q: Queryable, staffUserId: string, role: string, environment: string): Promise<GrantRow | undefined> {
  return (await q.query<GrantRow & Record<string, unknown>>(`SELECT ${GRANT_COLS} FROM role_grants WHERE staff_user_id = $1 AND role = $2 AND environment = $3 ORDER BY created_at DESC, id DESC LIMIT 1`, [staffUserId, role, environment]))[0];
}
export async function activeGrants(q: Queryable, staffUserId: string, environment: string): Promise<GrantRow[]> {
  const rows = await q.query<GrantRow & Record<string, unknown>>(`SELECT DISTINCT ON (role) ${GRANT_COLS} FROM role_grants WHERE staff_user_id = $1 AND environment = $2 ORDER BY role, created_at DESC, id DESC`, [staffUserId, environment]);
  return rows.filter((r) => r.action === "grant");
}
/** The decision row of this command, already inserted in the transaction (unit-of-work: decisions precede opts.commit). */
export const decisionIdOf = async (q: Queryable, subjectKind: string, subjectId: string): Promise<string | null> => (await q.query<{ id: string }>(`SELECT id::text AS id FROM agent_decisions WHERE subject_kind = $1 AND subject_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`, [subjectKind, subjectId]))[0]?.id ?? null;

/** Rule 1 + rule 3 over the person's roles ∪ reviewer_roles: the checks a grant and a break-glass share. */
export function assertGrantable(role: string, held: readonly string[], what: string): void {
  if (!isKernelRole(role)) throw new RolesRefused(409, "UNKNOWN_ROLE", `${what}: ${role || "(none)"} is not one of the kernel's human roles`, { role });
  if (STAFF_WORDS.includes(role)) throw new RolesRefused(409, "STAFF_ROLE_IS_34_1", `${what}: ${role} is a staff role held once in staff_users.roles — 34.1 staff.role.set grants it`, { role });
  const conflicts = conflictsWith(role, held);
  if (conflicts.length) throw new RolesRefused(409, "ROLE_DISJOINT", `${what}: ${role} may not be held beside ${conflicts.join(", ")} on one person (35.7 rule 3)`, { role, conflicts_with: conflicts });
}

interface Activation { readonly grant_id: string; readonly staff_user_id: string; readonly role: string; readonly environment: string; readonly request_id: string | null; readonly granted_by: string | null; readonly confirmed_by: string | null; readonly cause: string; readonly rationale: string | null; readonly by: Actor; readonly confirmer: Actor | null; readonly subject: { kind: string; id: string } }
/** The activation everything shares: the row, the word, the mirror, the events. Runs its writes in the command's transaction. */
async function activate(d: StaffActDeps, a: Activation): Promise<{ staffed: boolean }> {
  const snap = await latestSnapshot(d.db, a.environment, a.role);
  const staffed = snap?.status === "unstaffed";
  d.deferWrite(async (q) => {
    const [row] = await q.query<{ roles: string[]; reviewer_roles: string[]; status: string }>(`SELECT roles, reviewer_roles, status::text AS status FROM staff_users WHERE id = $1 FOR UPDATE`, [a.staff_user_id]);
    if (!row || row.status !== "active") throw new RolesRefused(409, "STAFF_NOT_ACTIVE", `staff user ${a.staff_user_id} is not active`, { staff_user_id: a.staff_user_id });
    if (row.reviewer_roles.includes(a.role)) { const g = await latestGrant(q, a.staff_user_id, a.role, a.environment); throw new RolesRefused(409, "ALREADY_HELD", `${a.role} was granted to ${a.staff_user_id} by another admin an instant ago (grant ${g?.id ?? "?"})`, { grant_id: g?.id ?? null, role: a.role }); }
    assertGrantable(a.role, [...row.roles, ...row.reviewer_roles], "roles.grant");
    const decision_id = await decisionIdOf(q, a.subject.kind, a.subject.id);
    await q.query(`INSERT INTO role_grants (id, staff_user_id, role, environment, action, request_id, granted_by, confirmed_by, cause, rationale, decision_id, effective_at) VALUES ($1, $2, $3, $4, 'grant', $5, $6, $7, $8, $9, $10, $11)`,
      [a.grant_id, a.staff_user_id, a.role, a.environment, a.request_id, a.granted_by, a.confirmed_by, a.cause, a.rationale, decision_id, d.now]);
    await new PgStaffRepository(q).setReviewerRoles(a.staff_user_id, [...row.reviewer_roles, a.role], q);
    await mirrorStaffIdentity(q, a.staff_user_id, d.now);
  });
  d.events.append({ type: "role.granted", aggregate: grantAggregate(a.grant_id), actor: a.by, payload: P({ grant_id: a.grant_id, staff_user_id: a.staff_user_id, role: a.role, environment: a.environment, by: nameOf(a.by), confirmed_by: a.confirmer ? nameOf(a.confirmer) : null, cause: a.cause, effective_at: d.now, request_id: a.request_id }) });
  if (staffed) d.events.append({ type: "role.staffed", aggregate: roleQueueAggregate(a.environment, a.role), actor: a.by, payload: P({ environment: a.environment, role: a.role, staff_user_id: a.staff_user_id, cause: "grant", grant_id: a.grant_id }) });
  return { staffed };
}

/** `roles.grant` (admin). Returns `pending` for an independence role (the compliance confirmation activates it), `active` otherwise, `already_held` when the person holds it. */
export async function grantRole(d: StaffActDeps, i: GrantInput): Promise<GrantResult> {
  const what = "roles.grant";
  if (!isUuid(i.staff_user_id)) throw new RangeError("staff_user_id is required (a staff_users id)");
  const admin = await requireActiveStaff(d.db, d.actor, ["admin"], what, i.environment);
  if (isSelfChange(admin.id, i.staff_user_id)) throw new RolesRefused(409, "NO_SELF_ROLE_CHANGE", `${admin.id} may not grant a role to their own account (34.1 rule 2)`, { staff_user_id: i.staff_user_id });
  const target = await staffRow(d.db, i.staff_user_id);
  if (!target) throw new RangeError(`no staff user ${i.staff_user_id}`);
  if (target.status !== "active") throw new RolesRefused(409, "STAFF_NOT_ACTIVE", `staff user ${i.staff_user_id} is ${target.status}; a role is granted to an active account`, { staff_user_id: i.staff_user_id, status: target.status });
  const held = [...target.roles, ...target.reviewer_roles];
  const by = nameOf(d.actor);
  if (held.includes(i.role)) {
    if (STAFF_WORDS.includes(i.role) || !isKernelRole(i.role)) assertGrantable(i.role, [], what);
    const g = await latestGrant(d.db, i.staff_user_id, i.role, i.environment);
    return { status: "already_held", grant_id: g?.id ?? null, request_id: g?.request_id ?? null, staff_user_id: i.staff_user_id, role: i.role, environment: i.environment, by, confirmed_by: g?.confirmed_by ?? null, staffed: false };
  }
  assertGrantable(i.role, held, what);
  const rationale = (typeof i.rationale === "string" && i.rationale.trim()) || null;
  if (INDEPENDENCE_ROLES.includes(i.role)) {
    const request_id = randomUUID(); const expires_at = minutesAfter(d.now, CONFIRM_MINUTES);
    d.events.append({ type: "role.grant.requested", aggregate: { kind: "role_grant_request", id: request_id }, actor: d.actor, payload: P({ request_id, staff_user_id: i.staff_user_id, role: i.role, environment: i.environment, by, rationale, requested_at: d.now, expires_at }) });
    return { status: "pending", grant_id: null, request_id, staff_user_id: i.staff_user_id, role: i.role, environment: i.environment, expires_at, by, confirmed_by: null, staffed: false };
  }
  const grant_id = randomUUID();
  const { staffed } = await activate(d, { grant_id, staff_user_id: i.staff_user_id, role: i.role, environment: i.environment, request_id: null, granted_by: admin.fake ? null : admin.id, confirmed_by: null, cause: admin.fake ? "bootstrap_nonprod" : "grant", rationale, by: d.actor, confirmer: null, subject: { kind: "grant", id: grant_id } });
  return { status: "active", grant_id, request_id: null, staff_user_id: i.staff_user_id, role: i.role, environment: i.environment, by, confirmed_by: null, staffed };
}

export interface GrantRequest { readonly request_id: string; readonly staff_user_id: string; readonly role: string; readonly environment: string; readonly by: string; readonly rationale: string | null; readonly requested_at: string; readonly expires_at: string; readonly resolved: "granted" | "expired" | null }
/** An independence-role request as the events record it: open until `role.granted{request_id}` or `role.grant.request.expired{request_id}`. */
export async function grantRequest(q: Queryable, requestId: string): Promise<GrantRequest | undefined> {
  if (!isUuid(requestId)) return undefined;
  const [r] = await q.query<{ payload: Row; resolved: string | null }>(`SELECT r.payload, (SELECT x.type FROM loan_events x WHERE x.type IN ('role.granted', 'role.grant.request.expired') AND x.payload->>'request_id' = r.payload->>'request_id' ORDER BY x.sequence LIMIT 1) AS resolved
      FROM loan_events r WHERE r.type = 'role.grant.requested' AND r.payload->>'request_id' = $1 ORDER BY r.sequence DESC LIMIT 1`, [requestId]);
  if (!r) return undefined;
  const p = r.payload;
  return { request_id: s(p["request_id"]), staff_user_id: s(p["staff_user_id"]), role: s(p["role"]), environment: s(p["environment"]), by: s(p["by"]), rationale: p["rationale"] === null || p["rationale"] === undefined ? null : s(p["rationale"]), requested_at: s(p["requested_at"]), expires_at: s(p["expires_at"]), resolved: r.resolved === "role.granted" ? "granted" : r.resolved === "role.grant.request.expired" ? "expired" : null };
}
/** The open requests older than 10 minutes (the sweep expires them). */
export async function staleGrantRequests(q: Queryable, nowIso: string): Promise<GrantRequest[]> {
  const rows = await q.query<{ request_id: string }>(`SELECT r.payload->>'request_id' AS request_id FROM loan_events r WHERE r.type = 'role.grant.requested' AND (r.payload->>'expires_at')::timestamptz <= $1::timestamptz
      AND NOT EXISTS (SELECT 1 FROM loan_events x WHERE x.type IN ('role.granted', 'role.grant.request.expired') AND x.payload->>'request_id' = r.payload->>'request_id') ORDER BY r.sequence`, [nowIso]);
  const out: GrantRequest[] = [];
  for (const r of rows) { const g = await grantRequest(q, r.request_id); if (g) out.push(g); }
  return out;
}
export const grantRequestExpiredEvent = (r: GrantRequest, nowIso: string) => ({ type: "role.grant.request.expired", aggregate: { kind: "role_grant_request", id: r.request_id }, actor: { kind: "system" as const, id: "roles-35-7" }, payload: P({ request_id: r.request_id, staff_user_id: r.staff_user_id, role: r.role, environment: r.environment, requested_by: r.by, requested_at: r.requested_at, expires_at: r.expires_at, expired_at: nowIso, reason: `no compliance confirmation within ${CONFIRM_MINUTES} minutes (35.7 rule 3); the grant never activated` }) });

/** `roles.grant{op: confirm, request_id}` — a compliance member other than the granting admin and the grantee, within 10 minutes. */
export async function confirmGrant(d: StaffActDeps, i: { request_id: string; environment: string }): Promise<GrantResult> {
  const what = "roles.grant:confirm";
  const r = await grantRequest(d.db, i.request_id);
  if (!r) throw new RolesRefused(404, "REQUEST_NOT_FOUND", `no grant request ${i.request_id || "(none)"}`, { request_id: i.request_id });
  if (r.resolved === "granted") { const g = await latestGrant(d.db, r.staff_user_id, r.role, r.environment); return { status: "already_held", grant_id: g?.id ?? null, request_id: r.request_id, staff_user_id: r.staff_user_id, role: r.role, environment: r.environment, by: r.by, confirmed_by: g?.confirmed_by ?? null, staffed: false }; }
  if (r.resolved === "expired" || Date.parse(r.expires_at) <= Date.parse(d.now)) {
    // the refusal persists nothing of this command, so the expiry is logged in its own transaction (the sweep would log it a minute later anyway)
    if (r.resolved !== "expired") await d.runtime.uow.run({}, (ctx) => ctx.events.append(grantRequestExpiredEvent(r, d.now)), { clock: d.runtime.clock });
    throw new RolesRefused(409, "REQUEST_EXPIRED", `grant request ${r.request_id} expired at ${r.expires_at}; the grant never activated (35.7 rule 3)`, { request_id: r.request_id, expires_at: r.expires_at });
  }
  const confirmer = await requireActiveStaff(d.db, d.actor, ["compliance"], what, r.environment);
  if (confirmer.id === r.staff_user_id) throw new RolesRefused(409, "CONFIRMER_IS_HOLDER", `${confirmer.id} may not confirm a grant of ${r.role} to themselves (35.7 rule 3)`, { request_id: r.request_id, role: r.role });
  if (nameOf(d.actor) === r.by) throw new RolesRefused(409, "CONFIRMER_IS_REQUESTER", `the confirmation of ${r.request_id} is a different person's than the request (35.7 rule 3)`, { request_id: r.request_id });
  const target = await staffRow(d.db, r.staff_user_id);
  if (!target || target.status !== "active") throw new RolesRefused(409, "STAFF_NOT_ACTIVE", `staff user ${r.staff_user_id} is ${target?.status ?? "unknown"}`, { staff_user_id: r.staff_user_id });
  const held = [...target.roles, ...target.reviewer_roles];
  if (held.includes(r.role)) { const g = await latestGrant(d.db, r.staff_user_id, r.role, r.environment); return { status: "already_held", grant_id: g?.id ?? null, request_id: r.request_id, staff_user_id: r.staff_user_id, role: r.role, environment: r.environment, by: r.by, confirmed_by: g?.confirmed_by ?? null, staffed: false }; }
  assertGrantable(r.role, held, what);
  const grant_id = randomUUID();
  const granted_by = isUuid(r.by) ? r.by : null;
  const { staffed } = await activate(d, { grant_id, staff_user_id: r.staff_user_id, role: r.role, environment: r.environment, request_id: r.request_id, granted_by, confirmed_by: confirmer.fake ? null : confirmer.id, cause: confirmer.fake || !granted_by ? "bootstrap_nonprod" : "grant", rationale: r.rationale, by: { kind: "human", id: r.by, role: "admin" }, confirmer: d.actor, subject: { kind: "grant", id: grant_id } });
  return { status: "active", grant_id, request_id: r.request_id, staff_user_id: r.staff_user_id, role: r.role, environment: r.environment, by: r.by, confirmed_by: nameOf(d.actor), staffed };
}

export interface RevokeInput { readonly grant_id?: string | null; readonly staff_user_id?: string | null; readonly role?: string | null; readonly environment: string; readonly rationale?: string | null }
export interface RevokeResult { readonly grant_id: string; readonly revoke_id: string; readonly staff_user_id: string; readonly role: string; readonly environment: string; readonly cause: string; readonly by: string; readonly sessions_revoked: readonly string[] }
/** `roles.revoke` (admin): the revoke row, the word dropped, the person's sessions revoked (34.1 rule 5), the mirror, `role.revoked`. */
export async function revokeGrant(d: StaffActDeps, i: RevokeInput): Promise<RevokeResult> {
  const what = "roles.revoke";
  const admin = await requireActiveStaff(d.db, d.actor, ["admin"], what, i.environment);
  let g: GrantRow | undefined;
  if (i.grant_id) { if (!isUuid(i.grant_id)) throw new RangeError("grant_id is a uuid"); g = (await d.db.query<GrantRow & Record<string, unknown>>(`SELECT ${GRANT_COLS} FROM role_grants WHERE id = $1`, [i.grant_id]))[0]; if (g) g = await latestGrant(d.db, g.staff_user_id, g.role, g.environment); }
  else { if (!isUuid(i.staff_user_id) || !i.role) throw new RangeError("roles.revoke needs grant_id or staff_user_id + role"); g = await latestGrant(d.db, i.staff_user_id!, i.role!, i.environment); }
  if (!g || g.action !== "grant") throw new RolesRefused(409, "GRANT_NOT_ACTIVE", `no active grant to revoke${i.grant_id ? ` (${i.grant_id})` : ` (${i.staff_user_id} ${i.role})`}`, { grant_id: i.grant_id ?? null });
  if (isSelfChange(admin.id, g.staff_user_id)) throw new RolesRefused(409, "NO_SELF_ROLE_CHANGE", `${admin.id} may not revoke their own role (34.1 rule 2)`, { staff_user_id: g.staff_user_id });
  const grant = g;
  const revoke_id = randomUUID(); const rationale = (typeof i.rationale === "string" && i.rationale.trim()) || null;
  const repo = new PgStaffRepository(d.db);
  const open = (await repo.openSessionsOf(grant.staff_user_id, d.now)).map((x) => x.session_id);
  d.deferWrite(async (q) => {
    const [row] = await q.query<{ reviewer_roles: string[] }>(`SELECT reviewer_roles FROM staff_users WHERE id = $1 FOR UPDATE`, [grant.staff_user_id]);
    const decision_id = await decisionIdOf(q, "grant", grant.id);
    await q.query(`INSERT INTO role_grants (id, staff_user_id, role, environment, action, request_id, granted_by, confirmed_by, cause, rationale, decision_id, effective_at) VALUES ($1, $2, $3, $4, 'revoke', NULL, $5, NULL, 'revoke', $6, $7, $8)`, [revoke_id, grant.staff_user_id, grant.role, grant.environment, admin.fake ? null : admin.id, rationale, decision_id, d.now]);
    await new PgStaffRepository(q).setReviewerRoles(grant.staff_user_id, (row?.reviewer_roles ?? []).filter((r) => r !== grant.role), q);
    await repo.revokeSessionsOf(grant.staff_user_id, d.now, q);
    await mirrorStaffIdentity(q, grant.staff_user_id, d.now);
  });
  d.events.append({ type: "role.revoked", aggregate: grantAggregate(grant.id), actor: d.actor, payload: P({ grant_id: grant.id, revoke_id, staff_user_id: grant.staff_user_id, role: grant.role, environment: grant.environment, by: nameOf(d.actor), cause: "revoke", rationale, sessions_revoked: open }) });
  return { grant_id: grant.id, revoke_id, staff_user_id: grant.staff_user_id, role: grant.role, environment: grant.environment, cause: "revoke", by: nameOf(d.actor), sessions_revoked: open };
}
