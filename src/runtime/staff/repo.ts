/**
 * 34.1 persistence (migration 0127): `staff_users`, `staff_credentials`, `staff_sessions`, `staff_actions` (append-only),
 * `staff_access_reviews` (append-only) and the staff rows of `auth_challenges` (subject_kind = staff). Nothing here decides
 * policy — ./auth.ts (the doors), ./roles.ts (the invariants) and src/app/tools/section34-1.ts (the bus tools) do; this
 * module reads and writes rows. Every write takes a `Queryable` so a tool can defer it into the command's transaction.
 *
 * The e-mail is stored twice and never in clear: `email_hash` = sha256 of the lowercased, trimmed address (the lookup
 * key, unique), `email_encrypted` = AES-256-GCM under the staff e-mail key (the door needs the address to send a code).
 * The key is `STAFF_EMAIL_KEY` (32 bytes, base64 or hex, or any passphrase — sha256'd); outside production a FAKE
 * constant key stands in, so a deployed demo works without a secret and production is refused without one.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import type { StaffRole } from "./roles.ts";

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const isEmail = (email: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
export const sha256hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
export const emailHash = (email: string): string => sha256hex(normalizeEmail(email));
export const newToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => sha256hex(token);
export const hashCode = (challengeId: string, code: string): string => sha256hex(`${challengeId}:${code}`);
/** Rule 1: "five failed sign-ins for one account in an hour" — failures older than this restart the count (migration 0131 last_failed_at). */
export const FAILURE_WINDOW_MINUTES = 60;

export const FAKE_STAFF_EMAIL_KEY = "FAKE-staff-email-key-nonproduction-only";
/** The 32-byte AES key: `STAFF_EMAIL_KEY` (required in production), else the FAKE constant. */
export function staffEmailKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = (env["STAFF_EMAIL_KEY"] ?? "").trim();
  const environment = env["ENVIRONMENT"] ?? "nonprod";
  if (!raw && (environment === "production" || environment === "prod")) throw new Error("STAFF_EMAIL_KEY is not set (34.1: the staff e-mail cipher key is required in production)");
  return createHash("sha256").update(raw || FAKE_STAFF_EMAIL_KEY).digest();
}
export function encryptEmail(email: string, key: Buffer): Buffer {
  const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(normalizeEmail(email), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
export function decryptEmail(blob: Buffer | Uint8Array, key: Buffer): string {
  const b = Buffer.from(blob); const iv = b.subarray(0, 12); const tag = b.subarray(12, 28); const enc = b.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

export type StaffStatus = "invited" | "active" | "disabled";
export interface StaffUserRow {
  readonly id: string; readonly email_hash: string; readonly email_encrypted: Buffer; readonly legal_name: string | null; readonly roles: StaffRole[]; readonly status: StaffStatus;
  readonly invited_by: string | null; readonly invited_at: string | null; readonly enrolled_at: string | null; readonly disabled_at: string | null; readonly failed_signins: number; readonly locked_until: string | null; readonly last_failed_at: string | null; readonly created_at: string;
}
export interface StaffCredentialRow { readonly id: string; readonly staff_user_id: string; readonly kind: "password" | "passkey"; readonly secret_hash: string; readonly label: string | null; readonly created_at: string; readonly revoked_at: string | null }
export interface PasskeySecret { readonly credential_id: string; readonly public_key_jwk: Record<string, unknown>; readonly algorithm: number; readonly sign_count: string; readonly transports: readonly string[] }
export type StaffFactor = "email_code" | "passkey" | "password";
export interface StaffSessionRow { readonly session_id: string; readonly staff_user_id: string; readonly factors: StaffFactor[]; readonly created_at: string; readonly last_seen_at: string; readonly expires_at: string; readonly revoked_at: string | null; readonly ip: string | null; readonly user_agent: string | null }
export interface StaffChallengeRow { readonly challenge_id: string; readonly kind: "otp" | "passkey_registration" | "passkey_assertion"; readonly staff_user_id: string | null; readonly code_hash: string | null; readonly challenge: string | null; readonly delivery: string | null; readonly attempts: number; readonly created_at: string; readonly expires_at: string; readonly consumed_at: string | null }
/** Rule 4: one row per request. `role` (migration 0139) is the role that acted — the chosen actor's — or, on a refusal, the role that was asked for beside the code; null on the door routes (no session). */
export interface StaffActionInput { readonly staff_user_id: string | null; readonly session_id: string | null; readonly at: string; readonly route: string; readonly method: string; readonly subject_kind: string | null; readonly subject_id: string | null; readonly command: string | null; readonly result: "ok" | "refused" | "error"; readonly refusal_code: string | null; readonly role?: string | null }
export interface StaffActionRow extends StaffActionInput { readonly id: string; readonly role: string | null; readonly created_at: string }
export interface AccessReviewRow { readonly id: string; readonly reviewed_by: string; readonly reviewed_at: string; readonly users: unknown; readonly created_at: string }

const USER_COLS = `id::text AS id, email_hash, email_encrypted, legal_name, roles, status, invited_by::text AS invited_by, to_char(invited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS invited_at, to_char(enrolled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS enrolled_at, to_char(disabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS disabled_at, failed_signins, to_char(locked_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS locked_until, to_char(last_failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_failed_at, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;
const CRED_COLS = `id::text AS id, staff_user_id::text AS staff_user_id, kind, secret_hash, label, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at, to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS revoked_at`;
const SESSION_COLS = `session_id::text AS session_id, staff_user_id::text AS staff_user_id, factors, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at, to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at, to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS revoked_at, ip, user_agent`;
const CHALLENGE_COLS = `challenge_id::text AS challenge_id, kind, staff_user_id::text AS staff_user_id, code_hash, challenge, delivery, attempts, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at, to_char(consumed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS consumed_at`;
const REVIEW_COLS = `id::text AS id, reviewed_by::text AS reviewed_by, to_char(reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reviewed_at, users, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;
const ACTION_COLS = `id::text AS id, staff_user_id::text AS staff_user_id, session_id::text AS session_id, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, route, method, subject_kind, subject_id, command, result, refusal_code, role, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

export class PgStaffRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  // ───────── users
  async createUser(i: { id?: string; email_hash: string; email_encrypted: Buffer; legal_name: string | null; roles: readonly StaffRole[]; invited_by: string | null; now: string }, q: Queryable = this.db): Promise<StaffUserRow> {
    const rows = await q.query<StaffUserRow & Record<string, unknown>>(`INSERT INTO staff_users (id, email_hash, email_encrypted, legal_name, roles, status, invited_by, invited_at) VALUES ($1, $2, $3, $4, $5::text[], 'invited', $6, $7) RETURNING ${USER_COLS}`,
      [i.id ?? randomUUID(), i.email_hash, i.email_encrypted, i.legal_name, [...i.roles], i.invited_by, i.now]);
    return rows[0]!;
  }
  async user(id: string, q: Queryable = this.db): Promise<StaffUserRow | undefined> { return (await q.query<StaffUserRow & Record<string, unknown>>(`SELECT ${USER_COLS} FROM staff_users WHERE id = $1`, [id]))[0]; }
  async userByEmailHash(hash: string, q: Queryable = this.db): Promise<StaffUserRow | undefined> { return (await q.query<StaffUserRow & Record<string, unknown>>(`SELECT ${USER_COLS} FROM staff_users WHERE email_hash = $1`, [hash]))[0]; }
  async users(q: Queryable = this.db): Promise<StaffUserRow[]> { return q.query<StaffUserRow & Record<string, unknown>>(`SELECT ${USER_COLS} FROM staff_users ORDER BY created_at, id`); }
  async count(q: Queryable = this.db): Promise<number> { return Number((await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM staff_users`))[0]!.n); }
  /** Edge cases: a re-invitation to a corrected address supersedes the e-mail on the invited row (the old hash is dropped, never reused). */
  async reinvite(id: string, i: { email_hash: string; email_encrypted: Buffer; legal_name: string | null; roles: readonly StaffRole[]; invited_by: string | null; now: string }, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE staff_users SET email_hash = $2, email_encrypted = $3, legal_name = coalesce($4, legal_name), roles = $5::text[], invited_by = $6, invited_at = $7 WHERE id = $1 AND status = 'invited'`, [id, i.email_hash, i.email_encrypted, i.legal_name, [...i.roles], i.invited_by, i.now]);
  }
  async markEnrolled(id: string, now: string, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE staff_users SET status = 'active', enrolled_at = coalesce(enrolled_at, $2::timestamptz) WHERE id = $1 AND status = 'invited'`, [id, now]); }
  async setRoles(id: string, roles: readonly StaffRole[], q: Queryable = this.db): Promise<void> { await q.query(`UPDATE staff_users SET roles = $2::text[] WHERE id = $1`, [id, [...roles]]); }
  async disable(id: string, now: string, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE staff_users SET status = 'disabled', disabled_at = $2 WHERE id = $1 AND status <> 'disabled'`, [id, now]); }
  async activeAdminIds(q: Queryable = this.db): Promise<string[]> { return (await q.query<{ id: string }>(`SELECT id::text AS id FROM staff_users WHERE status = 'active' AND 'admin' = ANY(roles)`)).map((r) => r.id); }
  /**
   * Rule 2 (LAST_ADMIN_STAYS) inside the command's transaction: the active admin rows locked in id order (two admins acting at
   * once queue on the same rows instead of deadlocking); the rows come back re-evaluated after the lock, so the result is the
   * set the invariant is checked against — a change the other transaction already committed is seen, and the second refuses.
   */
  async lockActiveAdmins(q: Queryable): Promise<string[]> { return (await q.query<{ id: string }>(`SELECT id::text AS id FROM staff_users WHERE status = 'active' AND 'admin' = ANY(roles) ORDER BY id FOR UPDATE`)).map((r) => r.id); }
  /**
   * Rule 1's window ("five failed sign-ins for one account in an hour"): the count the next failure lands on — 1 when the
   * previous lock has lapsed or the last failure is older than an hour (a fresh window), else one more. The door computes
   * the event payload, the lock and the escalation from this; `recordFailure` writes the same rule, so the row agrees.
   */
  nextFailure(row: Pick<StaffUserRow, "failed_signins" | "locked_until" | "last_failed_at">, now: string, lockAt: number, lockMinutes: number): { failures: number; locks: boolean; locked_until: string | undefined } {
    const t = Date.parse(now);
    const fresh = (row.locked_until !== null && Date.parse(row.locked_until) <= t) || (row.last_failed_at !== null && Date.parse(row.last_failed_at) < t - FAILURE_WINDOW_MINUTES * 60_000);
    const failures = fresh ? 1 : row.failed_signins + 1;
    const locks = failures >= lockAt;
    return { failures, locks, locked_until: locks ? new Date(t + lockMinutes * 60_000).toISOString() : undefined };
  }
  /** Rule 1: one more failure in the hour's window (`nextFailure`); the fifth locks the account until now + 15 minutes. Returns the row after the write. */
  async recordFailure(id: string, now: string, lockAt: number, lockMinutes: number, q: Queryable = this.db): Promise<StaffUserRow> {
    const until = new Date(Date.parse(now) + lockMinutes * 60_000).toISOString();
    return (await q.query<StaffUserRow & Record<string, unknown>>(
      `UPDATE staff_users SET failed_signins = n.failures, locked_until = CASE WHEN n.failures >= $2 THEN $3::timestamptz ELSE NULL END, last_failed_at = $4::timestamptz
         FROM (SELECT CASE WHEN (locked_until IS NOT NULL AND locked_until <= $4::timestamptz) OR (last_failed_at IS NOT NULL AND last_failed_at < $4::timestamptz - make_interval(mins => $5)) THEN 1 ELSE failed_signins + 1 END AS failures FROM staff_users WHERE id = $1) n
        WHERE staff_users.id = $1 RETURNING ${USER_COLS}`, [id, lockAt, until, now, FAILURE_WINDOW_MINUTES]))[0]!;
  }
  async clearFailures(id: string, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE staff_users SET failed_signins = 0, locked_until = NULL, last_failed_at = NULL WHERE id = $1`, [id]); }
  isLocked(row: Pick<StaffUserRow, "locked_until">, now: string): boolean { return row.locked_until !== null && Date.parse(row.locked_until) > Date.parse(now); }

  // ───────── credentials
  async addPassword(userId: string, hash: string, now: string, q: Queryable = this.db): Promise<StaffCredentialRow> {
    await q.query(`UPDATE staff_credentials SET revoked_at = $2 WHERE staff_user_id = $1 AND kind = 'password' AND revoked_at IS NULL`, [userId, now]);
    return (await q.query<StaffCredentialRow & Record<string, unknown>>(`INSERT INTO staff_credentials (staff_user_id, kind, secret_hash, label, created_at) VALUES ($1, 'password', $2, 'password', $3) RETURNING ${CRED_COLS}`, [userId, hash, now]))[0]!;
  }
  async password(userId: string, q: Queryable = this.db): Promise<StaffCredentialRow | undefined> { return (await q.query<StaffCredentialRow & Record<string, unknown>>(`SELECT ${CRED_COLS} FROM staff_credentials WHERE staff_user_id = $1 AND kind = 'password' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId]))[0]; }
  async addPasskey(userId: string, secret: PasskeySecret, label: string | null, now: string, q: Queryable = this.db): Promise<StaffCredentialRow> {
    return (await q.query<StaffCredentialRow & Record<string, unknown>>(`INSERT INTO staff_credentials (staff_user_id, kind, secret_hash, label, created_at) VALUES ($1, 'passkey', $2, $3, $4) RETURNING ${CRED_COLS}`, [userId, toJson(secret), label, now]))[0]!;
  }
  async passkeys(userId: string, q: Queryable = this.db): Promise<(StaffCredentialRow & { secret: PasskeySecret })[]> {
    const rows = await q.query<StaffCredentialRow & Record<string, unknown>>(`SELECT ${CRED_COLS} FROM staff_credentials WHERE staff_user_id = $1 AND kind = 'passkey' AND revoked_at IS NULL ORDER BY created_at`, [userId]);
    return rows.map((r) => ({ ...r, secret: JSON.parse(r.secret_hash) as PasskeySecret }));
  }
  async passkeyByCredentialId(userId: string, credentialId: string, q: Queryable = this.db): Promise<(StaffCredentialRow & { secret: PasskeySecret }) | undefined> {
    return (await this.passkeys(userId, q)).find((p) => p.secret.credential_id === credentialId);
  }
  async passkeyUsed(id: string, secret: PasskeySecret, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE staff_credentials SET secret_hash = $2 WHERE id = $1`, [id, toJson(secret)]); }
  async credentialKinds(userId: string, q: Queryable = this.db): Promise<string[]> { return (await q.query<{ kind: string }>(`SELECT DISTINCT kind FROM staff_credentials WHERE staff_user_id = $1 AND revoked_at IS NULL ORDER BY kind`, [userId])).map((r) => r.kind); }

  // ───────── sessions
  async createSession(i: { staff_user_id: string; factors: readonly StaffFactor[]; now: string; expires_at: string; ip: string | null; user_agent: string | null }, q: Queryable = this.db): Promise<{ session: StaffSessionRow; token: string }> {
    const token = newToken();
    const rows = await q.query<StaffSessionRow & Record<string, unknown>>(`INSERT INTO staff_sessions (staff_user_id, token_hash, factors, created_at, last_seen_at, expires_at, ip, user_agent) VALUES ($1, $2, $3::text[], $4, $4, $5, $6, $7) RETURNING ${SESSION_COLS}`,
      [i.staff_user_id, hashToken(token), [...i.factors], i.now, i.expires_at, i.ip, i.user_agent]);
    return { session: rows[0]!, token };
  }
  async sessionByToken(token: string, q: Queryable = this.db): Promise<StaffSessionRow | undefined> { return (await q.query<StaffSessionRow & Record<string, unknown>>(`SELECT ${SESSION_COLS} FROM staff_sessions WHERE token_hash = $1`, [hashToken(token)]))[0]; }
  async session(id: string, q: Queryable = this.db): Promise<StaffSessionRow | undefined> { return (await q.query<StaffSessionRow & Record<string, unknown>>(`SELECT ${SESSION_COLS} FROM staff_sessions WHERE session_id = $1`, [id]))[0]; }
  async touchSession(id: string, now: string, expiresAt: string, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE staff_sessions SET last_seen_at = $2, expires_at = $3 WHERE session_id = $1`, [id, now, expiresAt]); }
  async revokeSession(id: string, now: string, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE staff_sessions SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`, [id, now]); }
  /** Rule 5: a role change or a disable revokes every open session of the user in the same transaction; returns their ids. */
  async revokeSessionsOf(userId: string, now: string, q: Queryable = this.db): Promise<string[]> { return (await q.query<{ session_id: string }>(`UPDATE staff_sessions SET revoked_at = $2 WHERE staff_user_id = $1 AND revoked_at IS NULL RETURNING session_id::text AS session_id`, [userId, now])).map((r) => r.session_id); }
  async openSessionsOf(userId: string, now: string, q: Queryable = this.db): Promise<StaffSessionRow[]> { return q.query<StaffSessionRow & Record<string, unknown>>(`SELECT ${SESSION_COLS} FROM staff_sessions WHERE staff_user_id = $1 AND revoked_at IS NULL AND expires_at > $2::timestamptz ORDER BY created_at`, [userId, now]); }

  // ───────── challenges (auth_challenges, subject_kind = staff)
  async createChallenge(i: { kind: StaffChallengeRow["kind"]; staff_user_id: string | null; code?: string | null; challenge?: string | null; delivery?: string | null; delivery_ref?: string | null; expires_at: string }, q: Queryable = this.db): Promise<StaffChallengeRow> {
    const id = randomUUID();
    const rows = await q.query<StaffChallengeRow & Record<string, unknown>>(`INSERT INTO auth_challenges (challenge_id, kind, subject_kind, staff_user_id, channel, code_hash, challenge, delivery, delivery_ref, expires_at) VALUES ($1, $2, 'staff', $3, 'email', $4, $5, $6, $7, $8) RETURNING ${CHALLENGE_COLS}`,
      [id, i.kind, i.staff_user_id, i.code ? hashCode(id, i.code) : null, i.challenge ?? null, i.delivery ?? null, i.delivery_ref ?? null, i.expires_at]);
    return rows[0]!;
  }
  async challenge(id: string, q: Queryable = this.db): Promise<StaffChallengeRow | undefined> { return (await q.query<StaffChallengeRow & Record<string, unknown>>(`SELECT ${CHALLENGE_COLS} FROM auth_challenges WHERE challenge_id = $1 AND subject_kind = 'staff'`, [id]))[0]; }
  /** The user's newest unconsumed, unexpired code (verify names the e-mail, not the challenge). */
  async openCodeOf(userId: string, now: string, q: Queryable = this.db): Promise<StaffChallengeRow | undefined> {
    return (await q.query<StaffChallengeRow & Record<string, unknown>>(`SELECT ${CHALLENGE_COLS} FROM auth_challenges WHERE subject_kind = 'staff' AND kind = 'otp' AND staff_user_id = $1 AND consumed_at IS NULL AND expires_at > $2::timestamptz ORDER BY created_at DESC LIMIT 1`, [userId, now]))[0];
  }
  async bumpAttempts(id: string, q: Queryable = this.db): Promise<number> { return (await q.query<{ attempts: number }>(`UPDATE auth_challenges SET attempts = attempts + 1 WHERE challenge_id = $1 RETURNING attempts`, [id]))[0]?.attempts ?? 0; }
  /** A verified code is consumed and, on an otp row, carries the sha-256 of the enrol/step token it yielded. */
  async consume(id: string, now: string, stepTokenHash: string | null = null, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE auth_challenges SET consumed_at = $2, challenge = coalesce($3, challenge) WHERE challenge_id = $1 AND consumed_at IS NULL`, [id, now, stepTokenHash]); }
  /** The consumed otp row an enrol/step token names, when it was verified within `withinMinutes`. */
  async stepToken(tokenHash: string, now: string, withinMinutes: number, q: Queryable = this.db): Promise<StaffChallengeRow | undefined> {
    return (await q.query<StaffChallengeRow & Record<string, unknown>>(`SELECT ${CHALLENGE_COLS} FROM auth_challenges WHERE subject_kind = 'staff' AND kind = 'otp' AND challenge = $1 AND consumed_at IS NOT NULL AND consumed_at > $2::timestamptz - make_interval(mins => $3) AND staff_user_id IS NOT NULL LIMIT 1`, [tokenHash, now, withinMinutes]))[0];
  }
  /**
   * Rule 1: the possession factor — the newest code verified or passkey asserted for the user within the window that no
   * session has spent yet. A verified row always reads `consumed_at < expires_at` (a code or an assertion is only accepted
   * before it expires); `spendPossession` closes that gap, so one code or one assertion opens at most one session.
   */
  async possessionWithin(userId: string, now: string, withinMinutes: number, q: Queryable = this.db, kinds: readonly ("otp" | "passkey_assertion")[] = ["otp", "passkey_assertion"]): Promise<{ factor: "email_code" | "passkey"; challenge_id: string; at: string } | null> {
    const r = (await q.query<{ challenge_id: string; kind: string; consumed_at: string }>(`SELECT challenge_id::text AS challenge_id, kind, to_char(consumed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS consumed_at FROM auth_challenges WHERE subject_kind = 'staff' AND staff_user_id = $1 AND kind = ANY($4::text[]) AND consumed_at IS NOT NULL AND consumed_at < expires_at AND consumed_at > $2::timestamptz - make_interval(mins => $3) ORDER BY consumed_at DESC, created_at DESC LIMIT 1`, [userId, now, withinMinutes, [...kinds]]))[0];
    return r ? { factor: r.kind === "otp" ? "email_code" : "passkey", challenge_id: r.challenge_id, at: r.consumed_at } : null;
  }
  /** The session that opened on a possession factor spends it (TWO_FACTORS: the next session needs a fresh code or assertion); the enrol/step token the same code yielded is untouched (it reads consumed_at only). */
  async spendPossession(challengeId: string, q: Queryable = this.db): Promise<void> { await q.query(`UPDATE auth_challenges SET expires_at = consumed_at WHERE challenge_id = $1 AND subject_kind = 'staff' AND consumed_at IS NOT NULL`, [challengeId]); }

  // ───────── the action log (append-only) and the reviews (append-only)
  async logAction(a: StaffActionInput, q: Queryable = this.db): Promise<void> {
    await q.query(`INSERT INTO staff_actions (staff_user_id, session_id, at, route, method, subject_kind, subject_id, command, result, refusal_code, role) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [a.staff_user_id, a.session_id, a.at, a.route, a.method, a.subject_kind, a.subject_id, a.command, a.result, a.refusal_code, a.role ?? null]);
  }
  async actions(f: { staff_user_id?: string | null; subject_id?: string | null; since?: string | null; limit?: number }, q: Queryable = this.db): Promise<StaffActionRow[]> {
    return q.query<StaffActionRow & Record<string, unknown>>(`SELECT ${ACTION_COLS} FROM staff_actions WHERE ($1::uuid IS NULL OR staff_user_id = $1::uuid) AND ($2::text IS NULL OR subject_id = $2) AND ($3::timestamptz IS NULL OR at >= $3::timestamptz) ORDER BY at DESC, id LIMIT $4`, [f.staff_user_id ?? null, f.subject_id ?? null, f.since ?? null, Math.min(Math.max(f.limit ?? 200, 1), 2000)]);
  }
  async insertReview(i: { id?: string; reviewed_by: string; reviewed_at: string; users: unknown }, q: Queryable = this.db): Promise<AccessReviewRow> {
    return (await q.query<AccessReviewRow & Record<string, unknown>>(`INSERT INTO staff_access_reviews (id, reviewed_by, reviewed_at, users) VALUES ($1, $2, $3, $4::jsonb) RETURNING ${REVIEW_COLS}`, [i.id ?? randomUUID(), i.reviewed_by, i.reviewed_at, toJson(i.users)]))[0]!;
  }
  async reviews(limit = 50, q: Queryable = this.db): Promise<AccessReviewRow[]> { return q.query<AccessReviewRow & Record<string, unknown>>(`SELECT ${REVIEW_COLS} FROM staff_access_reviews ORDER BY reviewed_at DESC LIMIT $1`, [limit]); }
}
