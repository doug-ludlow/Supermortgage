/**
 * 36.1 persistence (migration 0243): `partner_users`, `partner_credentials`, `partner_sessions`, `partner_actions`
 * (append-only) and the partner rows of `auth_challenges` (subject_kind = partner). Nothing here decides policy —
 * ./auth.ts (the doors and the invitation), ./roles.ts (the roles), ./scope.ts (the tenant) and ./routes.ts do; this
 * module reads and writes rows. Every write takes a `Queryable` so a tool can defer it into the command's transaction.
 * The shape of src/runtime/staff/repo.ts, over the partner tables only: no query here names a staff_* table.
 *
 * The e-mail is stored twice and never in clear: `email_hash` = sha256 of the lowercased, trimmed address (the lookup by
 * normalized value; unique per tenant), `email_encrypted` = AES-256-GCM under the staff e-mail key (the door needs the
 * address to send a code; a FAKE constant key stands in outside production — src/runtime/staff/repo.ts staffEmailKey).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import { emailHash, encryptEmail, decryptEmail, hashToken, hashCode, normalizeEmail, isEmail, newToken, staffEmailKey, FAILURE_WINDOW_MINUTES, type PasskeySecret } from "../staff/repo.ts";
import type { PartnerRole } from "./roles.ts";

export { emailHash, encryptEmail, decryptEmail, hashToken, hashCode, normalizeEmail, isEmail, newToken, staffEmailKey, type PasskeySecret };

export type PartnerUserStatus = "invited" | "active" | "disabled";
export interface PartnerUserRow {
  readonly id: string; readonly partner_party_id: string; readonly email_hash: string; readonly email_encrypted: Buffer; readonly name: string | null; readonly roles: PartnerRole[]; readonly status: PartnerUserStatus;
  readonly invited_by: string | null; readonly invited_by_actor: string | null; readonly invited_at: string | null; readonly enrolled_at: string | null; readonly disabled_at: string | null; readonly failed_signins: number; readonly locked_until: string | null; readonly last_failed_at: string | null; readonly created_at: string;
}
export interface PartnerCredentialRow { readonly id: string; readonly partner_user_id: string; readonly kind: "password" | "passkey"; readonly secret_hash: string; readonly label: string | null; readonly created_at: string; readonly revoked_at: string | null }
export type PartnerFactor = "email_code" | "passkey" | "password";
export interface PartnerSessionRow { readonly id: string; readonly partner_user_id: string; readonly partner_party_id: string; readonly role: PartnerRole; readonly factors: PartnerFactor[]; readonly created_at: string; readonly last_seen_at: string; readonly expires_at: string; readonly revoked_at: string | null; readonly ip: string | null; readonly user_agent: string | null }
export interface PartnerChallengeRow { readonly challenge_id: string; readonly kind: "otp" | "passkey_registration" | "passkey_assertion"; readonly partner_user_id: string | null; readonly code_hash: string | null; readonly challenge: string | null; readonly delivery: string | null; readonly attempts: number; readonly created_at: string; readonly expires_at: string; readonly consumed_at: string | null }
/** Rule 5: one row per request, ids and the role only. */
export interface PartnerActionInput { readonly at: string; readonly partner_user_id: string | null; readonly partner_party_id: string | null; readonly role: string | null; readonly action: string; readonly subject_kind: string | null; readonly subject_id: string | null; readonly result: "ok" | "refused"; readonly refusal_code: string | null }
export interface PartnerActionRow extends PartnerActionInput { readonly id: string; readonly created_at: string }
/** The tenant's parties{servicer} row as the portal shows it (the door's legal name, the NMLSR id from the partners entity — read by ./auth.ts). */
export interface TenantRow { readonly id: string; readonly legal_name: string; readonly party_type: string }

const ISO = (col: string, as: string = col): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${as}`;
const USER_COLS = `id::text AS id, partner_party_id::text AS partner_party_id, email_hash, email_encrypted, name, roles, status, invited_by::text AS invited_by, invited_by_actor, ${ISO("invited_at")}, ${ISO("enrolled_at")}, ${ISO("disabled_at")}, failed_signins, ${ISO("locked_until")}, ${ISO("last_failed_at")}, ${ISO("created_at")}`;
const CRED_COLS = `id::text AS id, partner_user_id::text AS partner_user_id, kind, secret_hash, label, ${ISO("created_at")}, ${ISO("revoked_at")}`;
const SESSION_COLS = `id::text AS id, partner_user_id::text AS partner_user_id, partner_party_id::text AS partner_party_id, role, factors, ${ISO("created_at")}, ${ISO("last_seen_at")}, ${ISO("expires_at")}, ${ISO("revoked_at")}, ip, user_agent`;
const CHALLENGE_COLS = `challenge_id::text AS challenge_id, kind, partner_user_id::text AS partner_user_id, code_hash, challenge, delivery, attempts, ${ISO("created_at")}, ${ISO("expires_at")}, ${ISO("consumed_at")}`;
const ACTION_COLS = `id::text AS id, ${ISO("at")}, partner_user_id::text AS partner_user_id, partner_party_id::text AS partner_party_id, role, action, subject_kind, subject_id, result, refusal_code, ${ISO("created_at")}`;

export class PgPartnerRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  // ───────── the tenant (parties{servicer}; 33.1's row)
  async tenant(partnerPartyId: string, q: Queryable = this.db): Promise<TenantRow | undefined> { return (await q.query<TenantRow & Record<string, unknown>>(`SELECT id::text AS id, legal_name, party_type::text AS party_type FROM parties WHERE id = $1 AND party_type = 'servicer'`, [partnerPartyId]))[0]; }

  // ───────── users
  async createUser(i: { id?: string; partner_party_id: string; email_hash: string; email_encrypted: Buffer; name: string | null; roles: readonly PartnerRole[]; invited_by: string | null; invited_by_actor: string | null; now: string }, q: Queryable = this.db): Promise<PartnerUserRow> {
    const rows = await q.query<PartnerUserRow & Record<string, unknown>>(`INSERT INTO partner_users (id, partner_party_id, email_hash, email_encrypted, name, roles, status, invited_by, invited_by_actor, invited_at) VALUES ($1, $2, $3, $4, $5, $6::text[], 'invited', $7, $8, $9) RETURNING ${USER_COLS}`,
      [i.id ?? randomUUID(), i.partner_party_id, i.email_hash, i.email_encrypted, i.name, [...i.roles], i.invited_by, i.invited_by_actor, i.now]);
    return rows[0]!;
  }
  async user(id: string, q: Queryable = this.db): Promise<PartnerUserRow | undefined> { return (await q.query<PartnerUserRow & Record<string, unknown>>(`SELECT ${USER_COLS} FROM partner_users WHERE id = $1`, [id]))[0]; }
  /** Every row for the e-mail (the same person may work at two partners — two rows, two tenants), newest first. */
  async usersByEmailHash(hash: string, q: Queryable = this.db): Promise<PartnerUserRow[]> { return q.query<PartnerUserRow & Record<string, unknown>>(`SELECT ${USER_COLS} FROM partner_users WHERE email_hash = $1 ORDER BY created_at DESC, id`, [hash]); }
  /**
   * The row a door names: the e-mail, and — when the person has a row at more than one tenant — the tenant the door names
   * (`partner_party_id`), else the newest row that is not disabled, else the newest row. The choice only selects among the
   * caller's own rows; it grants nothing.
   */
  async userByEmailHash(hash: string, partnerPartyId: string | null = null, q: Queryable = this.db): Promise<PartnerUserRow | undefined> {
    const rows = await this.usersByEmailHash(hash, q);
    if (partnerPartyId) return rows.find((r) => r.partner_party_id === partnerPartyId);
    return rows.find((r) => r.status !== "disabled") ?? rows[0];
  }
  async userInTenant(partnerPartyId: string, hash: string, q: Queryable = this.db): Promise<PartnerUserRow | undefined> { return (await q.query<PartnerUserRow & Record<string, unknown>>(`SELECT ${USER_COLS} FROM partner_users WHERE partner_party_id = $1 AND email_hash = $2`, [partnerPartyId, hash]))[0]; }
  /** Rule 4: the tenant's users and no other tenant's. */
  async usersOfTenant(partnerPartyId: string, q: Queryable = this.db): Promise<PartnerUserRow[]> { return q.query<PartnerUserRow & Record<string, unknown>>(`SELECT ${USER_COLS} FROM partner_users WHERE partner_party_id = $1 ORDER BY created_at, id`, [partnerPartyId]); }
  async activeAdminsOfTenant(partnerPartyId: string, q: Queryable = this.db): Promise<string[]> { return (await q.query<{ id: string }>(`SELECT id::text AS id FROM partner_users WHERE partner_party_id = $1 AND status = 'active' AND 'partner_admin' = ANY(roles)`, [partnerPartyId])).map((r) => r.id); }
  /** Edge cases: a re-invitation supersedes the name and the roles on the invited row (the e-mail is the same row's — the tenant's unique key). */
  async reinvite(id: string, i: { name: string | null; roles: readonly PartnerRole[]; invited_by: string | null; invited_by_actor: string | null; now: string }, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE partner_users SET name = coalesce($2, name), roles = $3::text[], invited_by = $4, invited_by_actor = $5, invited_at = $6 WHERE id = $1 AND status = 'invited'`, [id, i.name, [...i.roles], i.invited_by, i.invited_by_actor, i.now]);
  }
  async markEnrolled(id: string, now: string, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE partner_users SET status = 'active', enrolled_at = coalesce(enrolled_at, $2::timestamptz) WHERE id = $1 AND status = 'invited'`, [id, now]); }
  nextFailure(row: Pick<PartnerUserRow, "failed_signins" | "locked_until" | "last_failed_at">, now: string, lockAt: number, lockMinutes: number): { failures: number; locks: boolean; locked_until: string | undefined } {
    const t = Date.parse(now);
    const fresh = (row.locked_until !== null && Date.parse(row.locked_until) <= t) || (row.last_failed_at !== null && Date.parse(row.last_failed_at) < t - FAILURE_WINDOW_MINUTES * 60_000);
    const failures = fresh ? 1 : row.failed_signins + 1;
    const locks = failures >= lockAt;
    return { failures, locks, locked_until: locks ? new Date(t + lockMinutes * 60_000).toISOString() : undefined };
  }
  /** Rule 1: one more failure in the hour's window (`nextFailure`); the fifth locks the account until now + 15 minutes. */
  async recordFailure(id: string, now: string, lockAt: number, lockMinutes: number, q: Queryable = this.db): Promise<PartnerUserRow> {
    const until = new Date(Date.parse(now) + lockMinutes * 60_000).toISOString();
    return (await q.query<PartnerUserRow & Record<string, unknown>>(
      `UPDATE partner_users SET failed_signins = n.failures, locked_until = CASE WHEN n.failures >= $2 THEN $3::timestamptz ELSE NULL END, last_failed_at = $4::timestamptz
         FROM (SELECT CASE WHEN (locked_until IS NOT NULL AND locked_until <= $4::timestamptz) OR (last_failed_at IS NOT NULL AND last_failed_at < $4::timestamptz - make_interval(mins => $5)) THEN 1 ELSE failed_signins + 1 END AS failures FROM partner_users WHERE id = $1) n
        WHERE partner_users.id = $1 RETURNING ${USER_COLS}`, [id, lockAt, until, now, FAILURE_WINDOW_MINUTES]))[0]!;
  }
  async clearFailures(id: string, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE partner_users SET failed_signins = 0, locked_until = NULL, last_failed_at = NULL WHERE id = $1`, [id]); }
  isLocked(row: Pick<PartnerUserRow, "locked_until">, now: string): boolean { return row.locked_until !== null && Date.parse(row.locked_until) > Date.parse(now); }

  // ───────── credentials
  async addPassword(userId: string, hash: string, now: string, q: Queryable = this.db): Promise<PartnerCredentialRow> {
    await q.query(`UPDATE partner_credentials SET revoked_at = $2 WHERE partner_user_id = $1 AND kind = 'password' AND revoked_at IS NULL`, [userId, now]);
    return (await q.query<PartnerCredentialRow & Record<string, unknown>>(`INSERT INTO partner_credentials (partner_user_id, kind, secret_hash, label, created_at) VALUES ($1, 'password', $2, 'password', $3) RETURNING ${CRED_COLS}`, [userId, hash, now]))[0]!;
  }
  async password(userId: string, q: Queryable = this.db): Promise<PartnerCredentialRow | undefined> { return (await q.query<PartnerCredentialRow & Record<string, unknown>>(`SELECT ${CRED_COLS} FROM partner_credentials WHERE partner_user_id = $1 AND kind = 'password' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId]))[0]; }
  async addPasskey(userId: string, secret: PasskeySecret, label: string | null, now: string, q: Queryable = this.db): Promise<PartnerCredentialRow> {
    return (await q.query<PartnerCredentialRow & Record<string, unknown>>(`INSERT INTO partner_credentials (partner_user_id, kind, secret_hash, label, created_at) VALUES ($1, 'passkey', $2, $3, $4) RETURNING ${CRED_COLS}`, [userId, toJson(secret), label, now]))[0]!;
  }
  async passkeys(userId: string, q: Queryable = this.db): Promise<(PartnerCredentialRow & { secret: PasskeySecret })[]> {
    const rows = await q.query<PartnerCredentialRow & Record<string, unknown>>(`SELECT ${CRED_COLS} FROM partner_credentials WHERE partner_user_id = $1 AND kind = 'passkey' AND revoked_at IS NULL ORDER BY created_at`, [userId]);
    return rows.map((r) => ({ ...r, secret: JSON.parse(r.secret_hash) as PasskeySecret }));
  }
  async passkeyByCredentialId(userId: string, credentialId: string, q: Queryable = this.db): Promise<(PartnerCredentialRow & { secret: PasskeySecret }) | undefined> { return (await this.passkeys(userId, q)).find((p) => p.secret.credential_id === credentialId); }
  async passkeyUsed(id: string, secret: PasskeySecret, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE partner_credentials SET secret_hash = $2 WHERE id = $1`, [id, toJson(secret)]); }
  async credentialKinds(userId: string, q: Queryable = this.db): Promise<string[]> { return (await q.query<{ kind: string }>(`SELECT DISTINCT kind FROM partner_credentials WHERE partner_user_id = $1 AND revoked_at IS NULL ORDER BY kind`, [userId])).map((r) => r.kind); }

  // ───────── sessions (rule 6)
  async createSession(i: { partner_user_id: string; partner_party_id: string; role: PartnerRole; factors: readonly PartnerFactor[]; now: string; expires_at: string; ip: string | null; user_agent: string | null }, q: Queryable = this.db): Promise<{ session: PartnerSessionRow; token: string }> {
    const token = newToken();
    const rows = await q.query<PartnerSessionRow & Record<string, unknown>>(`INSERT INTO partner_sessions (partner_user_id, partner_party_id, role, token_hash, factors, created_at, last_seen_at, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5::text[], $6, $6, $7, $8, $9) RETURNING ${SESSION_COLS}`,
      [i.partner_user_id, i.partner_party_id, i.role, hashToken(token), [...i.factors], i.now, i.expires_at, i.ip, i.user_agent]);
    return { session: rows[0]!, token };
  }
  async sessionByToken(token: string, q: Queryable = this.db): Promise<PartnerSessionRow | undefined> { return (await q.query<PartnerSessionRow & Record<string, unknown>>(`SELECT ${SESSION_COLS} FROM partner_sessions WHERE token_hash = $1`, [hashToken(token)]))[0]; }
  async session(id: string, q: Queryable = this.db): Promise<PartnerSessionRow | undefined> { return (await q.query<PartnerSessionRow & Record<string, unknown>>(`SELECT ${SESSION_COLS} FROM partner_sessions WHERE id = $1`, [id]))[0]; }
  async touchSession(id: string, now: string, expiresAt: string, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE partner_sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1`, [id, now, expiresAt]); }
  async revokeSession(id: string, now: string, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE partner_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, now]); }
  /** Rule 6: a disable or a role change revokes every open session of the user in the same transaction; returns their ids. */
  async revokeSessionsOf(userId: string, now: string, q: Queryable = this.db): Promise<string[]> { return (await q.query<{ id: string }>(`UPDATE partner_sessions SET revoked_at = $2 WHERE partner_user_id = $1 AND revoked_at IS NULL RETURNING id::text AS id`, [userId, now])).map((r) => r.id); }
  async openSessionsOf(userId: string, now: string, q: Queryable = this.db): Promise<PartnerSessionRow[]> { return q.query<PartnerSessionRow & Record<string, unknown>>(`SELECT ${SESSION_COLS} FROM partner_sessions WHERE partner_user_id = $1 AND revoked_at IS NULL AND expires_at > $2::timestamptz ORDER BY created_at`, [userId, now]); }

  // ───────── challenges (auth_challenges, subject_kind = partner)
  async createChallenge(i: { kind: PartnerChallengeRow["kind"]; partner_user_id: string | null; code?: string | null; challenge?: string | null; delivery?: string | null; delivery_ref?: string | null; expires_at: string }, q: Queryable = this.db): Promise<PartnerChallengeRow> {
    const id = randomUUID();
    const rows = await q.query<PartnerChallengeRow & Record<string, unknown>>(`INSERT INTO auth_challenges (challenge_id, kind, subject_kind, partner_user_id, channel, code_hash, challenge, delivery, delivery_ref, expires_at) VALUES ($1, $2, 'partner', $3, 'email', $4, $5, $6, $7, $8) RETURNING ${CHALLENGE_COLS}`,
      [id, i.kind, i.partner_user_id, i.code ? hashCode(id, i.code) : null, i.challenge ?? null, i.delivery ?? null, i.delivery_ref ?? null, i.expires_at]);
    return rows[0]!;
  }
  async challenge(id: string, q: Queryable = this.db): Promise<PartnerChallengeRow | undefined> { return (await q.query<PartnerChallengeRow & Record<string, unknown>>(`SELECT ${CHALLENGE_COLS} FROM auth_challenges WHERE challenge_id = $1 AND subject_kind = 'partner'`, [id]))[0]; }
  /** The user's newest unconsumed, unexpired code (verify names the e-mail, not the challenge). */
  async openCodeOf(userId: string, now: string, q: Queryable = this.db): Promise<PartnerChallengeRow | undefined> {
    return (await q.query<PartnerChallengeRow & Record<string, unknown>>(`SELECT ${CHALLENGE_COLS} FROM auth_challenges WHERE subject_kind = 'partner' AND kind = 'otp' AND partner_user_id = $1 AND consumed_at IS NULL AND expires_at > $2::timestamptz ORDER BY created_at DESC LIMIT 1`, [userId, now]))[0];
  }
  async bumpAttempts(id: string, q: Queryable = this.db): Promise<number> { return (await q.query<{ attempts: number }>(`UPDATE auth_challenges SET attempts = attempts + 1 WHERE challenge_id = $1 RETURNING attempts`, [id]))[0]?.attempts ?? 0; }
  /** A verified code is consumed and, on an otp row, carries the sha-256 of the enrol/step token it yielded. */
  async consume(id: string, now: string, stepTokenHash: string | null = null, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE auth_challenges SET consumed_at = $2, challenge = coalesce($3, challenge) WHERE challenge_id = $1 AND consumed_at IS NULL`, [id, now, stepTokenHash]); }
  /** The consumed otp row an enrol/step token names, when it was verified within `withinMinutes`. */
  async stepToken(tokenHash: string, now: string, withinMinutes: number, q: Queryable = this.db): Promise<PartnerChallengeRow | undefined> {
    return (await q.query<PartnerChallengeRow & Record<string, unknown>>(`SELECT ${CHALLENGE_COLS} FROM auth_challenges WHERE subject_kind = 'partner' AND kind = 'otp' AND challenge = $1 AND consumed_at IS NOT NULL AND consumed_at > $2::timestamptz - make_interval(mins => $3) AND partner_user_id IS NOT NULL LIMIT 1`, [tokenHash, now, withinMinutes]))[0];
  }
  /** Rule 1: the possession factor — the newest code verified or passkey asserted for the user within the window that no session has spent yet (`spendPossession` closes the gap, so one code or one assertion opens at most one session). */
  async possessionWithin(userId: string, now: string, withinMinutes: number, q: Queryable = this.db, kinds: readonly ("otp" | "passkey_assertion")[] = ["otp", "passkey_assertion"]): Promise<{ factor: "email_code" | "passkey"; challenge_id: string; at: string } | null> {
    const r = (await q.query<{ challenge_id: string; kind: string; consumed_at: string }>(`SELECT challenge_id::text AS challenge_id, kind, ${ISO("consumed_at")} FROM auth_challenges WHERE subject_kind = 'partner' AND partner_user_id = $1 AND kind = ANY($4::text[]) AND consumed_at IS NOT NULL AND consumed_at < expires_at AND consumed_at > $2::timestamptz - make_interval(mins => $3) ORDER BY consumed_at DESC, created_at DESC LIMIT 1`, [userId, now, withinMinutes, [...kinds]]))[0];
    return r ? { factor: r.kind === "otp" ? "email_code" : "passkey", challenge_id: r.challenge_id, at: r.consumed_at } : null;
  }
  async spendPossession(challengeId: string, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE auth_challenges SET expires_at = consumed_at WHERE challenge_id = $1 AND subject_kind = 'partner' AND consumed_at IS NOT NULL`, [challengeId]); }

  // ───────── the action log (append-only; rule 5)
  async logAction(a: PartnerActionInput, q: Queryable = this.db): Promise<void> {
    await q.query(`INSERT INTO partner_actions (at, partner_user_id, partner_party_id, role, action, subject_kind, subject_id, result, refusal_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [a.at, a.partner_user_id, a.partner_party_id, a.role, a.action, a.subject_kind, a.subject_id, a.result, a.refusal_code]);
  }
  async actions(f: { partner_party_id?: string | null; partner_user_id?: string | null; subject_id?: string | null; since?: string | null; limit?: number }, q: Queryable = this.db): Promise<PartnerActionRow[]> {
    return q.query<PartnerActionRow & Record<string, unknown>>(`SELECT ${ACTION_COLS} FROM partner_actions WHERE ($1::uuid IS NULL OR partner_party_id = $1::uuid) AND ($2::uuid IS NULL OR partner_user_id = $2::uuid) AND ($3::text IS NULL OR subject_id = $3) AND ($4::timestamptz IS NULL OR at >= $4::timestamptz) ORDER BY at DESC, id LIMIT $5`, [f.partner_party_id ?? null, f.partner_user_id ?? null, f.subject_id ?? null, f.since ?? null, Math.min(Math.max(f.limit ?? 200, 1), 2000)]);
  }
}
