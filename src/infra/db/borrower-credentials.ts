/**
 * E-mail + password accounts (docs/ux/17-the-conversational-product.md §2.0, §5; DELTA-29; migration 0118): the
 * `party_credentials` row per party — the e-mail lowercased and unique, the password hash, the e-mail verification
 * stamp and the lockout counters (ten failures → `locked_until` fifteen minutes out). Nothing here decides policy
 * beyond the lockout arithmetic; src/runtime/borrower/routes.ts (POST /v1/borrower/auth/account) reads and writes rows
 * through this module.
 *
 * Password hashing: docs/ux/17 §2.0 asks for Argon2id; DELTA-29 allows `node:crypto` scrypt when the Argon2 dependency is
 * refused and asks that the choice be recorded. RECORDED HERE: the Argon2 native dependency is not admitted into the
 * runtime image (no native build step, no non-stdlib crypto), so passwords are hashed with scrypt — N = 2^15, r = 8,
 * p = 1, a 32-byte random salt, a 32-byte key — and compared with `timingSafeEqual`. The stored form is
 * `scrypt$<N>$<r>$<p>$<salt base64url>$<key base64url>` so the parameters can be raised (or the algorithm swapped for
 * Argon2id) and old rows re-hashed on their next successful sign-in without a migration.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Queryable } from "./client.ts";

const scrypt = promisify(scryptCb) as (password: string | Buffer, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export const SCRYPT_N = 2 ** 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_SALT_BYTES = 32;
export const SCRYPT_KEY_BYTES = 32;
/** docs/ux/17 §2.0: ten failed attempts lock the account for fifteen minutes. */
export const LOCKOUT_ATTEMPTS = 10;
export const LOCKOUT_MINUTES = 15;

export interface CredentialRow {
  readonly party_id: string; readonly email: string; readonly password_hash: string; readonly email_verified_at: string | null;
  readonly failed_attempts: number; readonly locked_until: string | null; readonly created_at: string; readonly updated_at: string;
}
const COLS = "party_id, email, password_hash, email_verified_at, failed_attempts, locked_until, created_at, updated_at";

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
/** A well-formed hash of a password nobody knows: a sign-in on an unknown e-mail compares against it so the answer takes the same time as a wrong password (no enumeration by timing). */
export const DUMMY_PASSWORD_HASH = "scrypt$32768$8$1$DOhJliZn4aX2AIAARxnnv5w5yNCDByzKWZi3S8YSFoo$f2qX7mpq-kuSq_Tp92-cu61nCgebQTs1RlsTBsFfB4k";
export const isEmail = (email: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

/** `scrypt$N$r$p$salt$key` for a fresh 32-byte salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * SCRYPT_N * SCRYPT_R * 2 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
/** Constant-time comparison against a stored `scrypt$…` string; an unparseable hash never matches. */
export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 || r < 1 || p < 1) return false;
  const salt = Buffer.from(parts[4]!, "base64url"); const expected = Buffer.from(parts[5]!, "base64url");
  if (!salt.length || !expected.length) return false;
  const key = await scrypt(password.normalize("NFKC"), salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export class PgBorrowerCredentialRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  /** A new account (unverified): the row carries the lowercased e-mail and the hash; the party already exists (resolveOrCreateByDestination). */
  async create(i: { party_id: string; email: string; password: string; now: string }, q: Queryable = this.db): Promise<CredentialRow> {
    const password_hash = await hashPassword(i.password);
    const rows = await q.query<CredentialRow & Record<string, unknown>>(
      `INSERT INTO party_credentials (party_id, email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $4) RETURNING ${COLS}`,
      [i.party_id, normalizeEmail(i.email), password_hash, i.now]);
    return rows[0]!;
  }
  async byEmail(email: string, q: Queryable = this.db): Promise<CredentialRow | undefined> {
    const rows = await q.query<CredentialRow & Record<string, unknown>>(`SELECT ${COLS} FROM party_credentials WHERE email = $1`, [normalizeEmail(email)]);
    return rows[0];
  }
  async byParty(partyId: string, q: Queryable = this.db): Promise<CredentialRow | undefined> {
    const rows = await q.query<CredentialRow & Record<string, unknown>>(`SELECT ${COLS} FROM party_credentials WHERE party_id = $1`, [partyId]);
    return rows[0];
  }
  /** The password against the row's hash — a pure comparison; the caller records the failure or clears the counter. */
  async verifyPassword(row: Pick<CredentialRow, "password_hash">, password: string): Promise<boolean> {
    return verifyPasswordHash(password, row.password_hash);
  }
  /** Is the account locked at `now`? */
  isLocked(row: Pick<CredentialRow, "locked_until">, now: string): boolean {
    return row.locked_until !== null && Date.parse(row.locked_until) > Date.parse(now);
  }
  /** One more failed attempt; the tenth locks the account until now + 15 minutes (docs/ux/17 §2.0). Returns the row after the write. */
  async recordFailure(partyId: string, now: string, q: Queryable = this.db): Promise<CredentialRow> {
    const lockedUntil = new Date(Date.parse(now) + LOCKOUT_MINUTES * 60_000).toISOString();
    const rows = await q.query<CredentialRow & Record<string, unknown>>(
      `UPDATE party_credentials SET failed_attempts = failed_attempts + 1, locked_until = CASE WHEN failed_attempts + 1 >= $3 THEN $4::timestamptz ELSE locked_until END, updated_at = $2 WHERE party_id = $1 RETURNING ${COLS}`,
      [partyId, now, LOCKOUT_ATTEMPTS, lockedUntil]);
    return rows[0]!;
  }
  /** A successful sign-in (or a reset): the counter and the lock are cleared. */
  async clearFailures(partyId: string, now: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE party_credentials SET failed_attempts = 0, locked_until = NULL, updated_at = $2 WHERE party_id = $1`, [partyId, now]);
  }
  async markEmailVerified(partyId: string, now: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE party_credentials SET email_verified_at = coalesce(email_verified_at, $2::timestamptz), updated_at = $2 WHERE party_id = $1`, [partyId, now]);
  }
  /** A new password (the reset flow): re-hashed with a fresh salt. */
  async setPassword(partyId: string, password: string, now: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE party_credentials SET password_hash = $2, updated_at = $3 WHERE party_id = $1`, [partyId, await hashPassword(password), now]);
  }
}
