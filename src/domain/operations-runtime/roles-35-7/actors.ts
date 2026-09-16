/**
 * §35.7 — who may run a command of this process: an ACTIVE staff_users row holding one of the named roles (34.1 rule 3: the
 * actor is verified from rows, never trusted from the request — src/runtime/staff/auth.ts requireStaffActor's pattern).
 * The one exception is the nonprod bootstrap of the owner's own account (open-questions decision Q2 of 34.5): the FAKE
 * confirmers `FAKE:admin` and `FAKE:compliance` are admitted, as those two ids only, with those two roles only, when the
 * environment is not production — so every invariant (NO_SELF_ROLE_CHANGE, CONFIRMER_IS_HOLDER, a distinct confirmer) holds
 * literally and every row and decision says FAKE.
 */
import type { Actor } from "../../../kernel/events/index.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import { RolesRefused } from "./refusals.ts";
import { isProduction, isUuid } from "./types.ts";

export interface StaffActorRow { readonly id: string; readonly roles: string[]; readonly reviewer_roles: string[]; readonly status: string; readonly fake: boolean }
export const FAKE_ADMIN: Actor = { kind: "human", id: "FAKE:admin", role: "admin" };
export const FAKE_COMPLIANCE: Actor = { kind: "human", id: "FAKE:compliance", role: "compliance" };
const isFakeConfirmer = (a: Actor, environment: string): boolean => !isProduction(environment) && a.kind === "human" && ((a.id === FAKE_ADMIN.id && a.role === "admin") || (a.id === FAKE_COMPLIANCE.id && a.role === "compliance"));

export async function staffRow(q: Queryable, id: string): Promise<StaffActorRow | undefined> {
  if (!isUuid(id)) return undefined;
  const [r] = await q.query<{ id: string; roles: string[]; reviewer_roles: string[]; status: string }>(`SELECT id::text AS id, roles, reviewer_roles, status::text AS status FROM staff_users WHERE id = $1`, [id]);
  return r ? { ...r, fake: false } : undefined;
}
/** The actor as a verified active staff row holding one of `roles` (acting as one of them), else 403 ROLE_REQUIRED / ROLE_DENIED. */
export async function requireActiveStaff(q: Queryable, actor: Actor, roles: readonly string[], what: string, environment: string): Promise<StaffActorRow> {
  if (actor.kind !== "human") throw new RolesRefused(403, "ROLE_REQUIRED", `${what} is a person's act (${actor.kind}:${actor.id} may not run it)`, { role: roles[0], held: [], act_as: [] });
  if (isFakeConfirmer(actor, environment)) return { id: actor.id, roles: [actor.role!], reviewer_roles: [], status: "active", fake: true };
  const row = await staffRow(q, actor.id);
  const held = row ? [...row.roles, ...row.reviewer_roles] : [];
  if (!row || row.status !== "active") throw new RolesRefused(403, "ROLE_DENIED", `${what} needs an active staff member holding ${roles.join(" or ")}; the actor ${actor.id} is ${row ? row.status : "not a staff user"}`, { role: roles[0], held: [], act_as: [] });
  if (!actor.role || !roles.includes(actor.role) || !held.includes(actor.role)) throw new RolesRefused(403, "ROLE_REQUIRED", `${what} needs ${roles.join(" or ")}${actor.role ? `, not ${actor.role}` : ""}`, { role: roles[0], held, act_as: roles.filter((r) => held.includes(r)) });
  return row;
}
