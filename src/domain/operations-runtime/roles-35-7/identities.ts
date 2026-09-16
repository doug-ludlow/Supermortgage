/**
 * §35.7 — 19.2's `identities` mirror (db/migrations/0022_data_security.sql), kept current in the same transaction as every
 * grant, revoke, principal, disable and access review: one `kind = human` row per staff holder (`subject = staff:<id>`,
 * `privileged` for the roles rule 3 names, `entitlements = {roles, reviewer_roles, principals}`, `last_certified_at` from the
 * latest 34.1 access review naming the person) and one `kind = system` row per service or partner principal
 * (`subject = principal:<id>`). 19.2's reviews (SM_PRIV_ACCESS_REVIEW_90, FNMA_SUPP_ACCESS_CERT_365) read it; this process
 * defines no review clock of its own. Every write takes a Queryable — the command's transaction.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import { PRIVILEGED_ROLES } from "./types.ts";

export const staffSubject = (staffUserId: string): string => `staff:${staffUserId}`;
export const principalSubject = (principalId: string): string => `principal:${principalId}`;

/** The staff holder's row after the change the caller is committing (reads the rows as the transaction sees them). */
export async function mirrorStaffIdentity(q: Queryable, staffUserId: string, now: string): Promise<void> {
  const [u] = await q.query<{ roles: string[]; reviewer_roles: string[]; status: string; disabled_at: string | null }>(`SELECT roles, reviewer_roles, status, disabled_at::text AS disabled_at FROM staff_users WHERE id = $1`, [staffUserId]);
  if (!u) return;
  const principals = (await q.query<{ id: string }>(`SELECT id::text AS id FROM api_principals WHERE staff_user_id = $1 AND revoked_at IS NULL ORDER BY issued_at`, [staffUserId])).map((r) => r.id);
  const [cert] = await q.query<{ reviewed_at: string; reviewed_by: string }>(`SELECT reviewed_at::text AS reviewed_at, reviewed_by::text AS reviewed_by FROM staff_access_reviews WHERE users @> $1::jsonb ORDER BY reviewed_at DESC LIMIT 1`, [toJson([{ staff_user_id: staffUserId }])]);
  const disabled = u.status === "disabled";
  const held = [...u.roles, ...u.reviewer_roles];
  const privileged = !disabled && held.some((r) => PRIVILEGED_ROLES.includes(r));
  const entitlements = disabled ? {} : { roles: u.roles, reviewer_roles: u.reviewer_roles, principals };
  await q.query(`INSERT INTO identities (subject, kind, privileged, mfa_method, entitlements, last_certified_at, certified_by, disabled_at)
      VALUES ($1, 'human', $2, 'password+possession', $3::jsonb, $4, $5, $6)
      ON CONFLICT (subject) DO UPDATE SET privileged = EXCLUDED.privileged, entitlements = EXCLUDED.entitlements, last_certified_at = EXCLUDED.last_certified_at, certified_by = EXCLUDED.certified_by, disabled_at = EXCLUDED.disabled_at`,
    [staffSubject(staffUserId), privileged, toJson(entitlements), cert?.reviewed_at ?? null, cert ? `staff:${cert.reviewed_by}` : null, disabled ? (u.disabled_at ?? now) : null]);
}
/** A service or partner principal is a `kind = system` identity (19.2: "one kind = system row per service principal"). */
export async function mirrorPrincipalIdentity(q: Queryable, principalId: string): Promise<void> {
  const [p] = await q.query<{ kind: string; name: string; scopes: unknown; revoked_at: string | null; issued_by: string | null }>(`SELECT kind, name, scopes, revoked_at::text AS revoked_at, issued_by::text AS issued_by FROM api_principals WHERE id = $1`, [principalId]);
  if (!p || p.kind === "staff") return;
  await q.query(`INSERT INTO identities (subject, kind, privileged, mfa_method, entitlements, disabled_at) VALUES ($1, 'system', false, 'bearer_token', $2::jsonb, $3)
      ON CONFLICT (subject) DO UPDATE SET entitlements = EXCLUDED.entitlements, disabled_at = EXCLUDED.disabled_at`,
    [principalSubject(principalId), toJson({ principal_id: principalId, kind: p.kind, name: p.name, scopes: p.scopes, issued_by: p.issued_by }), p.revoked_at]);
}
