/**
 * Borrower identity persistence (docs/ux/01-foundations.md §5; migration 0111): `sessions` (levels L1/L2/L3, bearer
 * token stored only as a sha256 hash, idle expiry, the last one-time code for the fresh-L1 rule), `auth_challenges`
 * (one-time codes and WebAuthn challenges; a code is stored only as sha256(challenge_id:code)) and
 * `passkey_credentials` (the registered WebAuthn public keys). Nothing here decides policy — src/runtime/borrower/auth.ts
 * computes expiries and levels and this module reads and writes rows.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "./client.ts";
import { toJson } from "./client.ts";

export type SessionLevel = "L1" | "L2" | "L3";
/** 32.14 §3: `oidc_google` (DELTA-12) is an L1 session opened without a code — `last_l1_at` stays null, the fresh-L1 rule is unchanged. */
export type AuthMethod = "otp_phone" | "otp_email" | "passkey" | "oidc_google";
export interface SessionRow {
  readonly session_id: string; readonly party_id: string; readonly level: SessionLevel; readonly auth_method: AuthMethod; readonly created_at: string; readonly last_seen_at: string;
  readonly last_l1_at: string | null; readonly expires_at: string; readonly revoked_at: string | null; readonly passkey_id: string | null; readonly ip: string | null; readonly user_agent: string | null;
}
export interface ChallengeRow {
  readonly challenge_id: string; readonly kind: "otp" | "passkey_registration" | "passkey_assertion" | "oidc"; readonly party_id: string | null; readonly session_id: string | null; readonly channel: "sms" | "email" | null;
  readonly destination: string | null; readonly code_hash: string | null; readonly challenge: string | null; readonly delivery: string | null; readonly delivery_ref: string | null; readonly attempts: number; readonly created_at: string; readonly expires_at: string; readonly consumed_at: string | null;
  /** 32.14 DELTA-12 (kind = oidc): the identity provider, the id-token nonce and sha256 of the PKCE verifier; `challenge` carries the OAuth `state`, `destination` the redirect URI. */
  readonly provider: string | null; readonly nonce: string | null; readonly code_verifier_hash: string | null;
}
export interface PasskeyRow {
  readonly passkey_id: string; readonly party_id: string; readonly credential_id: string; readonly public_key_jwk: Record<string, unknown>; readonly algorithm: number; readonly sign_count: bigint; readonly transports: readonly string[];
  readonly attestation_format: string; readonly created_at: string; readonly last_used_at: string | null; readonly revoked_at: string | null;
}

export const sha256hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
/** A bearer token: 32 random bytes, base64url; the row keeps only its hash. */
export const newSessionToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => sha256hex(token);
export const hashCode = (challengeId: string, code: string): string => sha256hex(`${challengeId}:${code}`);

const SESSION_COLS = "session_id, party_id, level, auth_method, created_at, last_seen_at, last_l1_at, expires_at, revoked_at, passkey_id, ip, user_agent";
const CHALLENGE_COLS = "challenge_id, kind, party_id, session_id, channel, destination, code_hash, challenge, delivery, delivery_ref, attempts, created_at, expires_at, consumed_at, provider, nonce, code_verifier_hash";
const PASSKEY_COLS = "passkey_id, party_id, credential_id, public_key_jwk, algorithm, sign_count, transports, attestation_format, created_at, last_used_at, revoked_at";

export class PgBorrowerSessionRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  // ───────────────────────────── sessions
  async createSession(i: { party_id: string; level: SessionLevel; auth_method: AuthMethod; now: string; expires_at: string; last_l1_at?: string | null; passkey_id?: string | null; ip?: string | null; user_agent?: string | null }, q: Queryable = this.db): Promise<{ session: SessionRow; token: string }> {
    const token = newSessionToken(); const id = randomUUID();
    const rows = await q.query<SessionRow & Record<string, unknown>>(
      `INSERT INTO sessions (session_id, party_id, level, auth_method, token_hash, created_at, last_seen_at, last_l1_at, expires_at, passkey_id, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11) RETURNING ${SESSION_COLS}`,
      [id, i.party_id, i.level, i.auth_method, hashToken(token), i.now, i.last_l1_at ?? null, i.expires_at, i.passkey_id ?? null, i.ip ?? null, i.user_agent ?? null]);
    return { session: rows[0]!, token };
  }
  async byToken(token: string, q: Queryable = this.db): Promise<SessionRow | undefined> {
    const rows = await q.query<SessionRow & Record<string, unknown>>(`SELECT ${SESSION_COLS} FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
    return rows[0];
  }
  async get(sessionId: string, q: Queryable = this.db): Promise<SessionRow | undefined> {
    const rows = await q.query<SessionRow & Record<string, unknown>>(`SELECT ${SESSION_COLS} FROM sessions WHERE session_id = $1`, [sessionId]);
    return rows[0];
  }
  /** Activity: last_seen_at and the recomputed idle expiry. */
  async touch(sessionId: string, now: string, expiresAt: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE session_id = $1`, [sessionId, now, expiresAt]);
  }
  /** A one-time code verified on an existing session (fresh-L1 rule). */
  async recordL1(sessionId: string, at: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE sessions SET last_l1_at = $2 WHERE session_id = $1`, [sessionId, at]);
  }
  /** Levels only go up on a session (L2 after the SSN/DOB match, L3 after the identity vendor's webhook). */
  async raiseLevel(sessionId: string, level: SessionLevel, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE sessions SET level = $2 WHERE session_id = $1 AND (CASE level WHEN 'L1' THEN 1 WHEN 'L2' THEN 2 ELSE 3 END) < $3`, [sessionId, level, level === "L1" ? 1 : level === "L2" ? 2 : 3]);
  }
  /** Every live session of a party rises with it (the identity vendor's webhook lands out of band). */
  async raisePartyLevel(partyId: string, level: SessionLevel, now: string, q: Queryable = this.db): Promise<number> {
    const rows = await q.query<{ session_id: string }>(`UPDATE sessions SET level = $2 WHERE party_id = $1 AND revoked_at IS NULL AND expires_at > $4 AND (CASE level WHEN 'L1' THEN 1 WHEN 'L2' THEN 2 ELSE 3 END) < $3 RETURNING session_id`, [partyId, level, level === "L1" ? 1 : level === "L2" ? 2 : 3, now]);
    return rows.length;
  }
  async revoke(sessionId: string, now: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE sessions SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`, [sessionId, now]);
  }

  // ───────────────────────────── challenges
  async createChallenge(i: { challenge_id?: string; kind: ChallengeRow["kind"]; party_id?: string | null; session_id?: string | null; channel?: "sms" | "email" | null; destination?: string | null; code?: string | null; challenge?: string | null; delivery?: string | null; delivery_ref?: string | null; expires_at: string; provider?: string | null; nonce?: string | null; code_verifier_hash?: string | null }, q: Queryable = this.db): Promise<ChallengeRow> {
    const id = i.challenge_id ?? randomUUID();
    const rows = await q.query<ChallengeRow & Record<string, unknown>>(
      `INSERT INTO auth_challenges (challenge_id, kind, party_id, session_id, channel, destination, code_hash, challenge, delivery, delivery_ref, expires_at, provider, nonce, code_verifier_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${CHALLENGE_COLS}`,
      [id, i.kind, i.party_id ?? null, i.session_id ?? null, i.channel ?? null, i.destination ?? null, i.code ? hashCode(id, i.code) : null, i.challenge ?? null, i.delivery ?? null, i.delivery_ref ?? null, i.expires_at, i.provider ?? null, i.nonce ?? null, i.code_verifier_hash ?? null]);
    return rows[0]!;
  }
  async challenge(id: string, q: Queryable = this.db): Promise<ChallengeRow | undefined> {
    const rows = await q.query<ChallengeRow & Record<string, unknown>>(`SELECT ${CHALLENGE_COLS} FROM auth_challenges WHERE challenge_id = $1`, [id]);
    return rows[0];
  }
  /** 32.14 DELTA-12: the oidc challenge an OAuth `state` names (the provider's callback carries the state, never the challenge id). */
  async oidcChallengeByState(provider: string, state: string, q: Queryable = this.db): Promise<ChallengeRow | undefined> {
    const rows = await q.query<ChallengeRow & Record<string, unknown>>(`SELECT ${CHALLENGE_COLS} FROM auth_challenges WHERE kind = 'oidc' AND provider = $1 AND challenge = $2 ORDER BY created_at DESC LIMIT 1`, [provider, state]);
    return rows[0];
  }
  async bumpAttempts(id: string, q: Queryable = this.db): Promise<number> {
    const rows = await q.query<{ attempts: number }>(`UPDATE auth_challenges SET attempts = attempts + 1 WHERE challenge_id = $1 RETURNING attempts`, [id]);
    return rows[0]?.attempts ?? 0;
  }
  async consume(id: string, now: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE auth_challenges SET consumed_at = $2 WHERE challenge_id = $1 AND consumed_at IS NULL`, [id, now]);
  }
  async setChallengeParty(id: string, partyId: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE auth_challenges SET party_id = $2 WHERE challenge_id = $1`, [id, partyId]);
  }

  // ───────────────────────────── passkeys
  async addPasskey(i: { party_id: string; credential_id: string; public_key_jwk: Record<string, unknown>; algorithm: number; sign_count: bigint; transports?: readonly string[]; attestation_format?: string }, q: Queryable = this.db): Promise<PasskeyRow> {
    const rows = await q.query<PasskeyRow & Record<string, unknown>>(
      `INSERT INTO passkey_credentials (party_id, credential_id, public_key_jwk, algorithm, sign_count, transports, attestation_format) VALUES ($1, $2, $3::jsonb, $4, $5, $6::text[], $7) RETURNING ${PASSKEY_COLS}`,
      [i.party_id, i.credential_id, toJson(i.public_key_jwk), i.algorithm, i.sign_count, [...(i.transports ?? [])], i.attestation_format ?? "none"]);
    return rows[0]!;
  }
  async passkeyByCredential(credentialId: string, q: Queryable = this.db): Promise<PasskeyRow | undefined> {
    const rows = await q.query<PasskeyRow & Record<string, unknown>>(`SELECT ${PASSKEY_COLS} FROM passkey_credentials WHERE credential_id = $1 AND revoked_at IS NULL`, [credentialId]);
    return rows[0];
  }
  async passkeysOf(partyId: string, q: Queryable = this.db): Promise<PasskeyRow[]> {
    return q.query<PasskeyRow & Record<string, unknown>>(`SELECT ${PASSKEY_COLS} FROM passkey_credentials WHERE party_id = $1 AND revoked_at IS NULL ORDER BY created_at`, [partyId]);
  }
  async passkeyUsed(passkeyId: string, signCount: bigint, now: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE passkey_credentials SET sign_count = $2, last_used_at = $3 WHERE passkey_id = $1`, [passkeyId, signCount, now]);
  }
}
