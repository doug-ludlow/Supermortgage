/**
 * 34.1 — the staff doors and the staff acts (spec/sections/34-operator-portal/34-1-*.md). Two halves:
 *
 *   StaffAuth (the doors; no bus command): the e-mail code (rule 1; 32.2's OTP path on `auth_challenges{subject_kind=staff}`,
 *   the FAKE e-delivery port outside production with `fake_code` echoed exactly as the borrower doors; one open code per address —
 *   a second request answers the open challenge and mints nothing; a wrong code is a failed sign-in on the account's counter, so
 *   five wrong codes lock the account exactly as five wrong passwords do; an unknown address, a missing code and a wrong code all
 *   answer the same 401 OTP_INVALID — the action log keeps the reason), the enrol/step token a verified code yields (10 minutes;
 *   NEVER a session — it sets the password at enrolment, or resets it with a second proof the mailbox does not give: the current
 *   password or a passkey asserted within 10 minutes, the reset spending the code so it cannot also open the session; and it
 *   registers a passkey — nothing else),
 *   the password (≥ 12 characters, the breached list, the borrower side's hasher — scrypt, see src/infra/db/borrower-credentials.ts),
 *   the passkeys (the borrower side's WebAuthn verifier, src/runtime/borrower/webauthn.ts) and the session (rule 5: 30 minutes
 *   idle, 12 hours absolute; revoked on sign-out, role change, disable or expiry → 401 SESSION_EXPIRED).
 *
 *   The acts (the `security-records` agent's tools in src/app/tools/section34-1.ts call these with the command's stores):
 *   staffInvite (the row, NTC_SM_STAFF_INVITATION by e-mail, `staff.invited` without the e-mail), staffSignin (the only path to a
 *   session: a possession factor — a code verified for this e-mail within 10 minutes or a passkey asserted — AND the password;
 *   five failures lock the account 15 minutes, log `staff.signin.locked` and open a `compliance` escalation), staffRoleSet /
 *   staffDisable (the actor is verified from rows, never trusted from the request: an active staff_users row holding `admin`,
 *   or for the review `compliance` | `admin` — ROLE_DENIED otherwise; the system actor invites only the first admin while
 *   staff_users is empty; NO_SELF_ROLE_CHANGE, LAST_ADMIN_STAYS — checked before the command and again under the admin rows' lock in
 *   the writing transaction, so two admins disabling each other at once end with the second refused; sessions revoked in the
 *   same transaction) and staffAccessReview
 *   (rule 6: every active user keep | change | disable, the changes through staffRoleSet / staffDisable, the row and
 *   `staff.access_review.completed{reviewed_at, origination: true}` which satisfies and re-arms SM_STAFF_ACCESS_REVIEW_90).
 *
 * Every event is global (no loan) and carries `origination: true` so the section-34 clock arms (the kernel arms section ≥ 20
 * clocks on origination-context events only); none carries an e-mail, a name, a phone or a code. Nothing here logs one either.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import type { Actor, Clock, EventStore } from "../../kernel/events/index.ts";
import { hashPassword, verifyPasswordHash, DUMMY_PASSWORD_HASH } from "../../infra/db/borrower-credentials.ts";
import { verifyRegistration, verifyAssertion, b64url } from "../borrower/webauthn.ts";
import { randomBytes } from "node:crypto";
import { CommandRefused } from "../../app/commands.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { NoticeService, type Notice } from "../../notices/service.ts";
import type { Recipient } from "../../notices/channel.ts";
import { PgNoticeRepository } from "../../infra/db/notices.ts";
import type { EdeliveryPort, EdeliveryMessage } from "../../infra/integrations/delivery.ts";
import { FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { plainDate } from "../../kernel/calendar/date.ts";
import { FAKE_SERVICER_CONTACT as SERVICER_CONTACT } from "../../domain/operations-runtime/servicing-config.ts";   // 35.5 rule 9: the FAKE build's servicer_profiles v1 values (the platform's own postal address on a staff invitation)
import type { Runtime } from "../app.ts";
import type { Logger } from "../log.ts";
import { PgStaffRepository, emailHash, encryptEmail, decryptEmail, isEmail, normalizeEmail, newToken, hashToken, hashCode, staffEmailKey, type StaffUserRow, type StaffSessionRow, type StaffChallengeRow, type StaffFactor, type PasskeySecret } from "./repo.ts";
import { StaffError, normalizeRoles, sameRoles, isSelfChange, wouldRemoveLastAdmin, planAccessReview, NO_SELF_ROLE_CHANGE, LAST_ADMIN_STAYS, type StaffRole, type ReviewInput, type ReviewEntry } from "./roles.ts";

export const STAFF_IDLE_MINUTES = 30;
export const STAFF_ABSOLUTE_HOURS = 12;
export const STAFF_CODE_MINUTES = 10;
export const STAFF_STEP_TOKEN_MINUTES = 10;
export const STAFF_POSSESSION_MINUTES = 10;
export const STAFF_CODE_MAX_ATTEMPTS = 5;
export const STAFF_LOCK_AFTER_FAILURES = 5;
export const STAFF_LOCK_MINUTES = 15;
export const STAFF_PASSWORD_MIN_LENGTH = 12;
export const SECURITY_RECORDS_AGENT = "security-records";
export const STAFF_RULE_SET_VERSION = "staff.access.v1";
export const STAFF_MODEL_VERSION = "deterministic";
export const STAFF_PROMPT_VERSION = "34.1-v1";
export const STAFF_INVITATION_TEMPLATE = "NTC_SM_STAFF_INVITATION";
export const STAFF_ACTOR: Actor = { kind: "agent", id: SECURITY_RECORDS_AGENT };

const minutesAfter = (iso: string, m: number): string => new Date(Date.parse(iso) + m * 60_000).toISOString();
const hoursAfter = (iso: string, h: number): string => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
const earlier = (a: string, b: string): string => (Date.parse(a) <= Date.parse(b) ? a : b);
/** Rule 5: the idle deadline never passes the absolute one. */
export const staffSessionExpiry = (createdAt: string, now: string): string => earlier(minutesAfter(now, STAFF_IDLE_MINUTES), hoursAfter(createdAt, STAFF_ABSOLUTE_HOURS));

/**
 * Rule 1: "checked against the breached-password list the borrower door uses". The borrower door (32.16 DELTA-29) checks
 * length only today, so this list is the platform's — the most common ≥ 12-character passwords of the public breach corpora,
 * compared lowercased (FAKE stand-in for a k-anonymity range lookup against Have I Been Pwned; swap `passwordProblem` when
 * that port exists). A candidate on the list, or under 12 characters, is PASSWORD_WEAK and writes no credential row.
 */
export const BREACHED_PASSWORDS: ReadonlySet<string> = new Set(["password1234", "password12345", "password123456", "passwordpassword", "123456789012", "1234567890123", "qwertyuiop12", "qwertyuiopasdfgh", "qwerty123456", "administrator", "supermortgage", "supermortgage1", "iloveyou1234", "welcome12345", "letmein12345", "1234567890ab", "abcdefghijkl", "changeme1234", "trustno1trustno1", "abc123abc123", "correcthorsebatterystaple", "mortgage1234", "sunshine1234", "princess1234", "football1234", "baseball1234", "monkey123456", "dragon123456", "master123456", "shadow123456", "superman1234", "michael12345", "jennifer1234", "computer1234", "internet1234", "passw0rd1234", "p@ssword1234", "p@ssw0rd1234", "welcome123456", "adminadmin12"]);
export const passwordProblem = (password: string): "too_short" | "breached" | null => password.length < STAFF_PASSWORD_MIN_LENGTH ? "too_short" : BREACHED_PASSWORDS.has(password.normalize("NFKC").toLowerCase()) ? "breached" : null;

const sixDigits = (): string => randomInt(0, 1_000_000).toString().padStart(6, "0");
export const opsSignInUrl = (env: NodeJS.ProcessEnv = process.env): string => (env["OPS_URL"] ?? "").trim().replace(/\/+$/, "") || `${(env["BORROWER_APP_URL"] ?? "https://app.supermortgage.example").replace(/\/+$/, "")}/ops`;

export interface StaffContext { readonly session: StaffSessionRow; readonly user: StaffUserRow; readonly token: string }
export interface StaffAuthOptions { readonly runtime: Runtime; readonly environment?: string; readonly rpId?: string; readonly allowedOrigins?: readonly string[]; readonly emailKey?: Buffer; readonly logger?: Logger }

export class StaffAuth {
  readonly runtime: Runtime; readonly repo: PgStaffRepository; readonly key: Buffer; readonly environment: string; readonly nonProduction: boolean; readonly rpId: string; readonly allowedOrigins: readonly string[]; readonly logger: Logger | undefined;
  constructor(o: StaffAuthOptions) {
    this.runtime = o.runtime; this.repo = new PgStaffRepository(o.runtime.db);
    this.environment = o.environment ?? process.env["ENVIRONMENT"] ?? "nonprod"; this.nonProduction = this.environment !== "production" && this.environment !== "prod";
    this.key = o.emailKey ?? staffEmailKey({ ...process.env, ENVIRONMENT: this.environment });
    this.rpId = o.rpId ?? process.env["BORROWER_RP_ID"] ?? "localhost"; this.allowedOrigins = o.allowedOrigins ?? (process.env["BORROWER_ORIGINS"] ? process.env["BORROWER_ORIGINS"].split(",").map((s) => s.trim()) : []);
    this.logger = o.logger ?? o.runtime.logger;
  }
  private get edelivery(): EdeliveryPort | undefined { return this.runtime.ports.edelivery; }
  private deliveryIsFake(): boolean { return !this.edelivery || this.edelivery instanceof FakeEdelivery; }
  emailOf(user: StaffUserRow): string { return decryptEmail(user.email_encrypted, this.key); }

  // ───────── the code (rule 1; POST /ops/api/auth/code)
  /**
   * A six-digit code to the e-mail on file; the answer is the same whether or not the address is a staff member's (no enumeration).
   * One open code per address: while an unconsumed, unexpired code stands, the answer names it (its challenge_id and expiry, no
   * `fake_code` — it was echoed when minted) and nothing is minted or sent, so a request loop neither floods the mailbox nor
   * restarts the guess budget. A locked or disabled account gets the unknown-address answer: a row no code path can verify.
   */
  async requestCode(email: string, now: string): Promise<{ challenge_id: string; delivery: string; expires_at: string; fake_code?: string }> {
    if (!isEmail(email)) throw new StaffError(400, "EMAIL_INVALID", "a valid e-mail address is required");
    const user = await this.repo.userByEmailHash(emailHash(email));
    const delivery = this.deliveryIsFake() ? "FAKE" : "email";
    const sendable = !!user && user.status !== "disabled" && !this.repo.isLocked(user, now);
    const open = sendable ? await this.repo.openCodeOf(user!.id, now) : undefined;
    if (open) { this.logger?.info("staff.code.reissued", { challenge_id: open.challenge_id, known: true, delivery: open.delivery, minted: false }); return { challenge_id: open.challenge_id, delivery: open.delivery ?? delivery, expires_at: open.expires_at }; }
    const code = sixDigits(); const expires_at = minutesAfter(now, STAFF_CODE_MINUTES);
    let delivery_ref: string | null = null;
    const ch = await this.repo.createChallenge({ kind: "otp", staff_user_id: sendable ? user!.id : null, code, delivery, expires_at });
    if (sendable && this.edelivery) { const r = await this.edelivery.send({ messageId: `staff_otp:${ch.challenge_id}`, noticeId: `staff_otp:${ch.challenge_id}`, channel: "email", to: normalizeEmail(email), subject: "Your Supermortgage operator portal sign-in code", consentId: "policy:authentication_otp" }, now); delivery_ref = r.messageId; }
    this.logger?.info("staff.code.requested", { challenge_id: ch.challenge_id, known: sendable, delivery, delivery_ref });
    return { challenge_id: ch.challenge_id, delivery, expires_at, ...(this.deliveryIsFake() && this.nonProduction ? { fake_code: code } : {}) };
  }
  // ───────── verify → the enrol/step token (POST /ops/api/auth/verify) — never a session
  /** An unknown address, a locked account, no open code and a wrong code all answer the same 401 OTP_INVALID (no enumeration); the action log's refusal_code keeps the reason. A wrong code is a failed sign-in on the account (rule 1's five → 15-minute lock). */
  async verifyCode(email: string, code: string, now: string): Promise<{ token: string; expires_at: string; staff_user_id: string; status: StaffUserRow["status"]; has_password: boolean; roles: readonly StaffRole[] }> {
    const invalid = (logCode: string): StaffError => new StaffError(401, "OTP_INVALID", "the code is not valid for this e-mail; request a new one", {}, logCode);
    const user = isEmail(email) ? await this.repo.userByEmailHash(emailHash(email)) : undefined;
    if (!user) throw invalid("OTP_NO_ACCOUNT");
    if (this.repo.isLocked(user, now)) throw invalid("ACCOUNT_LOCKED");
    const ch = await this.repo.openCodeOf(user.id, now);
    if (!ch) throw invalid("OTP_EXPIRED");
    const attempts = await this.repo.bumpAttempts(ch.challenge_id);
    if (attempts > STAFF_CODE_MAX_ATTEMPTS) throw new StaffError(429, "OTP_TOO_MANY_ATTEMPTS");
    if (ch.code_hash !== hashCode(ch.challenge_id, String(code).trim())) { await this.doorFailure(user, now, "email_code"); throw invalid("OTP_INVALID"); }
    const token = newToken();
    await this.repo.consume(ch.challenge_id, now, hashToken(token));
    this.logger?.info("staff.code.verified", { challenge_id: ch.challenge_id, staff_user_id: user.id });
    return { token, expires_at: minutesAfter(now, STAFF_STEP_TOKEN_MINUTES), staff_user_id: user.id, status: user.status, has_password: !!(await this.repo.password(user.id)), roles: user.roles };
  }
  /** The consumed code row and the staff member an enrol/step token names (401 TOKEN_INVALID otherwise). */
  private async stepOf(token: string, now: string): Promise<{ row: StaffChallengeRow; user: StaffUserRow }> {
    const row = token ? await this.repo.stepToken(hashToken(token), now, STAFF_STEP_TOKEN_MINUTES) : undefined;
    const user = row?.staff_user_id ? await this.repo.user(row.staff_user_id) : undefined;
    if (!row || !user) throw new StaffError(401, "TOKEN_INVALID", "the enrol token is unknown or older than 10 minutes");
    if (user.status === "disabled") throw new StaffError(403, "ACCOUNT_DISABLED");
    return { row, user };
  }
  /** The staff member an enrol/step token names (401 TOKEN_INVALID otherwise). */
  async stepUser(token: string, now: string): Promise<StaffUserRow> { return (await this.stepOf(token, now)).user; }
  /**
   * Rule 1: a failed sign-in at a door with no bus command (a wrong e-mail code; a wrong current password on a reset) — the same
   * counter, window, lock, `staff.signin.failed` / `staff.signin.locked` events and `compliance` escalation as staffSignin's
   * password path, committed with the row so five wrong codes lock the account exactly as five wrong passwords do.
   */
  private async doorFailure(user: StaffUserRow, now: string, factor: "email_code" | "password"): Promise<{ failures: number; locks: boolean; locked_until: string | undefined }> {
    const n = this.repo.nextFailure(user, now, STAFF_LOCK_AFTER_FAILURES, STAFF_LOCK_MINUTES);
    const actor: Actor = { kind: "human", id: user.id, role: user.roles[0] ?? "ops_analyst" };
    let escalations: EscalationService | undefined;
    await this.runtime.uow.run({}, async (ctx) => {
      ctx.events.append({ type: "staff.signin.failed", aggregate: { kind: "staff_user", id: user.id }, actor, payload: { staff_user_id: user.id, factor, failures: n.failures, locked: n.locks, origination: true } });
      if (n.locks) {
        ctx.events.append({ type: "staff.signin.locked", aggregate: { kind: "staff_user", id: user.id }, actor, payload: { staff_user_id: user.id, factor, failures: n.failures, locked_until: n.locked_until, lock_minutes: STAFF_LOCK_MINUTES, origination: true } });
        escalations = new EscalationService(ctx.events, ctx.clock);
        escalations.open({ kind: "sev3", ownerRole: "compliance", severity: "3", payload: { staff_user_id: user.id, failures: n.failures, locked_until: n.locked_until, reason: `staff.signin.locked: ${n.failures} failed sign-ins for one staff account within an hour (34.1 rule 1)` } }, actor);
      }
    }, { clock: this.runtime.clock, commit: async (q) => { await this.repo.recordFailure(user.id, now, STAFF_LOCK_AFTER_FAILURES, STAFF_LOCK_MINUTES, q); for (const e of escalations?.list() ?? []) await this.runtime.escalationRepo.save(e, q); } });
    this.logger?.info(n.locks ? "staff.signin.locked" : "staff.signin.failed", { staff_user_id: user.id, factor, failures: n.failures });
    return n;
  }
  // ───────── the password (POST /ops/api/auth/password): set at enrolment, or reset — both on the step token; the reset also needs a second proof
  /**
   * Enrolment (status invited): the step token sets the password and the same code stays the possession factor of the first
   * sign-in (T2). A reset (status active): the code that yielded the token came from the mailbox, so the mailbox alone must not
   * reset the password AND open the session (rule 1: 'a code alone never opens a portal session') — the reset needs the current
   * password (`proof.current_password`) or a passkey asserted within 10 minutes (401 PROOF_REQUIRED otherwise; a wrong current
   * password is a failed sign-in), revokes every session and spends the code (and the assertion), so the possession factor of the
   * next session is a fresh code or a fresh assertion.
   */
  async setPassword(token: string, password: string, now: string, proof: { current_password?: string | null } = {}): Promise<{ staff_user_id: string; enrolled: boolean; status: StaffUserRow["status"]; proof?: "current_password" | "passkey" }> {
    const { row: step, user } = await this.stepOf(token, now);
    const enrolling = user.status === "invited";
    let proofKind: "enrolment" | "current_password" | "passkey" = "enrolment"; let assertion: string | null = null;
    if (!enrolling) {
      if (this.repo.isLocked(user, now)) throw new StaffError(423, "ACCOUNT_LOCKED", "the account is locked; try again later", { locked_until: user.locked_until });
      const cred = await this.repo.password(user.id);
      const current = typeof proof.current_password === "string" ? proof.current_password : "";
      if (current && cred && (await verifyPasswordHash(current, cred.secret_hash))) proofKind = "current_password";
      else {
        const pk = await this.repo.possessionWithin(user.id, now, STAFF_POSSESSION_MINUTES, undefined, ["passkey_assertion"]);
        if (pk) { proofKind = "passkey"; assertion = pk.challenge_id; }
        else {
          if (current) { await this.doorFailure(user, now, "password"); throw new StaffError(401, "PROOF_REQUIRED", "the current password did not match; a reset needs the current password or a passkey asserted within 10 minutes", {}, "PASSWORD_WRONG"); }
          throw new StaffError(401, "PROOF_REQUIRED", "a reset needs a second proof the mailbox does not give: the current password (`current_password`) or a passkey asserted within 10 minutes");
        }
      }
    }
    const problem = passwordProblem(password);
    if (problem) throw new StaffError(400, "PASSWORD_WEAK", problem === "too_short" ? `a password is at least ${STAFF_PASSWORD_MIN_LENGTH} characters` : "this password appears on the breached-password list", { reason: problem });
    const hash = await hashPassword(password);
    await this.runtime.uow.run({}, async (ctx) => {
      if (enrolling) ctx.events.append({ type: "staff.enrolled", aggregate: { kind: "staff_user", id: user.id }, actor: { kind: "human", id: user.id, role: user.roles[0] ?? "ops_analyst" }, payload: { staff_user_id: user.id, factor: "password", origination: true } });
      else ctx.events.append({ type: "staff.password.reset", aggregate: { kind: "staff_user", id: user.id }, actor: { kind: "human", id: user.id, role: user.roles[0] ?? "ops_analyst" }, payload: { staff_user_id: user.id, proof: proofKind, origination: true } });
    }, { clock: this.runtime.clock, commit: async (q) => {
      await this.repo.addPassword(user.id, hash, now, q); await this.repo.clearFailures(user.id, q);
      if (enrolling) await this.repo.markEnrolled(user.id, now, q);
      else { await this.repo.revokeSessionsOf(user.id, now, q); await this.repo.spendPossession(step.challenge_id, q); if (assertion) await this.repo.spendPossession(assertion, q); }
    } });
    this.logger?.info(enrolling ? "staff.enrolled" : "staff.password.reset", { staff_user_id: user.id, factor: "password", proof: proofKind });
    return { staff_user_id: user.id, enrolled: enrolling, status: enrolling ? "active" : user.status, ...(proofKind === "enrolment" ? {} : { proof: proofKind }) };
  }

  // ───────── the session (rule 5)
  async authenticate(token: string, now: string): Promise<StaffContext> {
    if (!token) throw new StaffError(401, "AUTH_REQUIRED");
    const session = await this.repo.sessionByToken(token);
    if (!session) throw new StaffError(401, "AUTH_REQUIRED");
    if (session.revoked_at) throw new StaffError(401, "SESSION_EXPIRED");
    if (Date.parse(session.expires_at) <= Date.parse(now) || Date.parse(session.created_at) + STAFF_ABSOLUTE_HOURS * 3_600_000 <= Date.parse(now)) { await this.repo.revokeSession(session.session_id, now); throw new StaffError(401, "SESSION_EXPIRED"); }
    const user = await this.repo.user(session.staff_user_id);
    if (!user || user.status !== "active") { await this.repo.revokeSession(session.session_id, now); throw new StaffError(user?.status === "disabled" ? 403 : 401, user?.status === "disabled" ? "ACCOUNT_DISABLED" : "SESSION_EXPIRED"); }
    const expiresAt = staffSessionExpiry(session.created_at, now);
    await this.repo.touchSession(session.session_id, now, expiresAt);
    return { session: { ...session, last_seen_at: now, expires_at: expiresAt }, user, token };
  }
  async signOut(token: string, now: string): Promise<{ signed_out: boolean; session_id: string | null }> {
    const session = token ? await this.repo.sessionByToken(token) : undefined;
    if (!session || session.revoked_at) return { signed_out: true, session_id: null };
    await this.runtime.uow.run({}, async (ctx) => { ctx.events.append({ type: "staff.signed_out", aggregate: { kind: "staff_session", id: session.session_id }, actor: { kind: "human", id: session.staff_user_id }, payload: { staff_user_id: session.staff_user_id, session_id: session.session_id, origination: true } }); },
      { clock: this.runtime.clock, commit: async (q) => { await this.repo.revokeSession(session.session_id, now, q); } });
    return { signed_out: true, session_id: session.session_id };
  }

  // ───────── passkeys (rule 1; the borrower side's verifier reused)
  async registerOptions(ctx: StaffContext, now: string): Promise<Record<string, unknown>> {
    const challenge = b64url.encode(randomBytes(32)); const expires_at = minutesAfter(now, STAFF_CODE_MINUTES);
    const ch = await this.repo.createChallenge({ kind: "passkey_registration", staff_user_id: ctx.user.id, challenge, expires_at });
    const name = ctx.user.legal_name ?? "Supermortgage staff";
    return { challenge_id: ch.challenge_id, challenge, rp: { id: this.rpId, name: "Supermortgage operator portal" }, user: { id: b64url.encode(Buffer.from(ctx.user.id)), name, display_name: name }, pub_key_cred_params: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], timeout_ms: STAFF_CODE_MINUTES * 60_000, attestation: "none", expires_at };
  }
  async register(ctx: StaffContext, i: { challenge_id: string; credential: unknown; label?: string | null }, now: string): Promise<{ staff_credential_id: string; credential_id: string; algorithm: number; attestation_verified: string }> {
    const ch = await this.repo.challenge(i.challenge_id);
    if (!ch || ch.kind !== "passkey_registration" || ch.consumed_at || ch.staff_user_id !== ctx.user.id || Date.parse(ch.expires_at) <= Date.parse(now)) throw new StaffError(401, "PASSKEY_INVALID");
    const credential = i.credential as { id: string; response: { clientDataJSON: string; attestationObject: string; transports?: string[] } } | undefined;
    if (!credential || typeof credential !== "object" || typeof credential.id !== "string" || !credential.response) throw new RangeError("credential { id, response: { clientDataJSON, attestationObject } } is required");
    let r; try { r = verifyRegistration({ rpId: this.rpId, allowedOrigins: this.allowedOrigins, expectedChallenge: ch.challenge!, credential }); } catch (e) { throw new StaffError(401, "PASSKEY_INVALID", (e as Error).message); }
    const secret: PasskeySecret = { credential_id: r.credentialId, public_key_jwk: r.publicKey.jwk, algorithm: r.publicKey.algorithm, sign_count: String(r.signCount), transports: r.transports };
    const id = randomUUID();
    await this.runtime.uow.run({}, async (uctx) => { uctx.events.append({ type: "staff.enrolled", aggregate: { kind: "staff_user", id: ctx.user.id }, actor: { kind: "human", id: ctx.user.id, role: ctx.user.roles[0] ?? "ops_analyst" }, payload: { staff_user_id: ctx.user.id, factor: "passkey", staff_credential_id: id, origination: true } }); },
      { clock: this.runtime.clock, commit: async (q) => { await this.repo.consume(ch.challenge_id, now, null, q); await q.query(`INSERT INTO staff_credentials (id, staff_user_id, kind, secret_hash, label, created_at) VALUES ($1, $2, 'passkey', $3, $4, $5)`, [id, ctx.user.id, JSON.stringify(secret), i.label ?? null, now]); } });
    this.logger?.info("staff.passkey.registered", { staff_user_id: ctx.user.id, staff_credential_id: id, attestation_format: r.attestationFormat, attestation_verified: r.attestationVerified });
    return { staff_credential_id: id, credential_id: r.credentialId, algorithm: r.publicKey.algorithm, attestation_verified: r.attestationVerified };
  }
  /** The assertion options for an e-mail; an unknown e-mail gets the same shape with no credentials (no enumeration). */
  async assertOptions(email: string, now: string): Promise<Record<string, unknown>> {
    const user = isEmail(email) ? await this.repo.userByEmailHash(emailHash(email)) : undefined;
    const challenge = b64url.encode(randomBytes(32)); const expires_at = minutesAfter(now, STAFF_CODE_MINUTES);
    const ch = await this.repo.createChallenge({ kind: "passkey_assertion", staff_user_id: user?.id ?? null, challenge, expires_at });
    const keys = user && user.status === "active" ? await this.repo.passkeys(user.id) : [];
    return { challenge_id: ch.challenge_id, challenge, rp: { id: this.rpId, name: "Supermortgage operator portal" }, allow_credentials: keys.map((k) => ({ type: "public-key", id: k.secret.credential_id, transports: k.secret.transports })), timeout_ms: STAFF_CODE_MINUTES * 60_000, expires_at };
  }
  /** A verified assertion is the possession factor (consumed row); it opens NO session — staffSignin needs the password too (TWO_FACTORS). */
  async assert(i: { challenge_id: string; credential: unknown }, now: string): Promise<{ verified: true; staff_user_id: string; possession: "passkey"; expires_at: string }> {
    const ch = await this.repo.challenge(i.challenge_id);
    if (!ch || ch.kind !== "passkey_assertion" || ch.consumed_at || !ch.staff_user_id || Date.parse(ch.expires_at) <= Date.parse(now)) throw new StaffError(401, "PASSKEY_INVALID");
    const credential = i.credential as { id: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } } | undefined;
    if (!credential || typeof credential !== "object" || typeof credential.id !== "string" || !credential.response) throw new RangeError("credential { id, response: { clientDataJSON, authenticatorData, signature } } is required");
    const stored = await this.repo.passkeyByCredentialId(ch.staff_user_id, credential.id);
    if (!stored) throw new StaffError(401, "PASSKEY_INVALID");
    let r; try { r = verifyAssertion({ rpId: this.rpId, allowedOrigins: this.allowedOrigins, expectedChallenge: ch.challenge!, publicKeyJwk: stored.secret.public_key_jwk, algorithm: stored.secret.algorithm, storedSignCount: BigInt(stored.secret.sign_count), credential }); } catch (e) { throw new StaffError(401, "PASSKEY_INVALID", (e as Error).message); }
    await this.repo.consume(ch.challenge_id, now);
    await this.repo.passkeyUsed(stored.id, { ...stored.secret, sign_count: r.signCount.toString() });
    this.logger?.info("staff.passkey.asserted", { staff_user_id: ch.staff_user_id, staff_credential_id: stored.id });
    return { verified: true, staff_user_id: ch.staff_user_id, possession: "passkey", expires_at: minutesAfter(now, STAFF_POSSESSION_MINUTES) };
  }
}

// ═════════════════════════════ the acts (called by the 34.1 bus tools inside the command's unit of work)

export interface StaffActDeps {
  readonly runtime: Runtime; readonly db: Queryable; readonly events: EventStore; readonly clock: Clock; readonly now: string; readonly actor: Actor;
  readonly escalations: EscalationService; readonly deferWrite: (fn: (q: Queryable) => Promise<void>) => void; readonly decide?: (d: DecisionInput) => void; readonly emailKey?: Buffer;
}
const keyOf = (d: StaffActDeps): Buffer => d.emailKey ?? staffEmailKey();
const byOf = (d: StaffActDeps): string | null => (d.actor.kind === "human" ? d.actor.id : null);
const P = (o: Record<string, unknown>): Record<string, unknown> => ({ ...o, origination: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_CITATION = "34.1 rule 2: 'Roles are the only authority' — 'admin manages staff users and roles'; rule 3: 'The actor on the bus is the session's'; operational prerequisites: 'nothing else creates an admin without an admin'; edge cases: 'The ops bearer token leaks → … in production it opens nothing'";
/** The bootstrap's system actor (Operational prerequisites): the only non-human actor a staff act ever accepts, and only in the two bootstrap conditions below. */
export const STAFF_BOOTSTRAP_ACTOR: Actor = { kind: "system", id: "staff-bootstrap" };
/** `ENVIRONMENT` is production (the NO_HEADER_ACTOR_IN_PRODUCTION reading: `production` or `prod`). */
export const isProductionEnvironment = (environment: string | undefined = process.env["ENVIRONMENT"]): boolean => { const e = environment ?? "nonprod"; return e === "production" || e === "prod"; };
/**
 * Review finding (the first build trusted the actor the request named, so anyone with the ops bearer token could mint an admin
 * through /v1/tools/34.1/*): the acts verify the actor from rows. A human actor must be an ACTIVE staff_users row holding one of
 * `roles` — a forged `{human, <any id>, admin}` or the nonprod header actor is ROLE_DENIED; the system actor is accepted only
 * where `system` allows it: `bootstrap` (staff.invite while staff_users is empty — the first admin) and `bootstrap_upgrade`
 * (Q1 of the portal proposal, 2026-09-15: staff.role.set by `staff-bootstrap` on the one row of a nonprod table — the target,
 * invited by nobody — the one-row upgrade of the Operational prerequisites; never in production, never with two or more rows);
 * an agent actor never runs a staff act.
 */
async function requireStaffActor(d: StaffActDeps, repo: PgStaffRepository, command: string, roles: readonly StaffRole[], system: "bootstrap" | "bootstrap_upgrade" | "never" = "never", target?: string): Promise<void> {
  if (d.actor.kind === "human") {
    const row = UUID.test(d.actor.id) ? await repo.user(d.actor.id) : undefined;
    if (!row || row.status !== "active" || !row.roles.some((r) => roles.includes(r))) throw new CommandRefused(command, "ROLE_DENIED", ACTOR_CITATION, `${command} needs an active staff member holding ${roles.join(" or ")}; the actor ${d.actor.id} is ${!row ? "not a staff user" : row.status !== "active" ? row.status : `[${row.roles.join(", ")}]`}`);
    return;
  }
  if (d.actor.kind === "system" && system === "bootstrap" && (await repo.count()) === 0) return;
  if (d.actor.kind === "system" && system === "bootstrap_upgrade" && d.actor.id === STAFF_BOOTSTRAP_ACTOR.id && !isProductionEnvironment() && target && UUID.test(target) && (await repo.count()) === 1) {
    const row = await repo.user(target);
    if (row && row.invited_by === null) return;
  }
  throw new CommandRefused(command, "ROLE_DENIED", ACTOR_CITATION, `${command} is a staff act: ${d.actor.kind}:${d.actor.id} may not run it${system === "bootstrap" ? " (the system actor invites only the first admin, while staff_users is empty)" : system === "bootstrap_upgrade" ? " (the bootstrap's system actor upgrades only the one row of a nonprod staff table — the bootstrap e-mail's, invited by nobody)" : ""}`);
}

/** The decision record schema of 34.1's AI agent design: `{staff_user_id, action, roles_before, roles_after, rationale, by, rule_set_version: staff.access.v1, model_version: deterministic, prompt_version: 34.1-v1, confidence: 1}`. */
export function staffDecision(i: { action: "staff.role.set" | "staff.disable" | "staff.access.review"; staff_user_id: string; roles_before: readonly string[]; roles_after: readonly string[]; rationale: string; by: string | null; subject?: { kind: string; id: string } }): DecisionInput {
  return { agent: SECURITY_RECORDS_AGENT, action: i.action, ruleSetVersion: STAFF_RULE_SET_VERSION, modelVersion: STAFF_MODEL_VERSION, promptVersion: STAFF_PROMPT_VERSION, confidence: 1, subject: i.subject ?? { kind: "staff_user", id: i.staff_user_id },
    rationale: `${i.action} staff_user ${i.staff_user_id}: roles_before [${i.roles_before.join(", ")}] → roles_after [${i.roles_after.join(", ")}] by ${i.by ?? "system"}; rationale: ${i.rationale}` };
}

// ───────── staff.invite
export interface InviteInput { readonly email: string; readonly legal_name?: string | null; readonly roles: unknown; readonly rationale?: string | null }
export interface InviteResult { readonly staff_user_id: string; readonly status: "invited"; readonly roles: readonly StaffRole[]; readonly reinvited: boolean; readonly notice_id: string | null; readonly bounced: boolean; readonly held_reason: string | null; readonly invited_by: string | null }
export async function staffInvite(d: StaffActDeps, i: InviteInput): Promise<InviteResult> {
  if (!isEmail(i.email ?? "")) throw new RangeError("email is required (a valid address)");
  const roles = normalizeRoles(i.roles);
  const repo = new PgStaffRepository(d.db); const key = keyOf(d);
  await requireStaffActor(d, repo, "staff.invite", ["admin"], "bootstrap");
  const hash = emailHash(i.email); const encrypted = encryptEmail(i.email, key);
  const existing = await repo.userByEmailHash(hash);
  if (existing && existing.status !== "invited") throw new RangeError(`this e-mail already belongs to a staff member (${existing.status})`);
  const invited_by = byOf(d);
  const inviter = invited_by ? await repo.user(invited_by) : undefined;
  const inviter_name = inviter?.legal_name ?? (d.actor.kind === "human" ? "A Supermortgage administrator" : "The Supermortgage platform");
  const id = existing?.id ?? randomUUID();
  const legal_name = typeof i.legal_name === "string" && i.legal_name.trim() ? i.legal_name.trim() : null;
  // the invitation: NTC_SM_STAFF_INVITATION by e-mail through the Notice Registry (channel policy electronic_ok_without_esign — the notice is about the account, not a disclosure); the FAKE port holds it outside production
  let notice: Notice | null = null; let bounced = false; let held_reason: string | null = null;
  const rt = d.runtime;
  if (rt.ports.edelivery && rt.ports.printMail) {
    const subject = `${inviter_name} invited you to the Supermortgage operator portal as ${roles.join(", ")}`;
    const real = rt.ports.edelivery;
    const edelivery: EdeliveryPort = { send: (m: EdeliveryMessage, now: string) => real.send(m.noticeId === notice?.id ? { ...m, messageId: `staff_invite:${id}:${m.messageId.split(":").pop() ?? "1"}`, subject } : m, now), events: (since: string) => real.events(since) };
    const notices = new NoticeService({ registry: rt.noticeRegistry, events: d.events, clock: d.clock, printMail: rt.ports.printMail, edelivery, notices: rt.noticeMemory });
    const recipient: Recipient = { partyId: id, name: legal_name ?? "Colleague", mailingAddress: null, email: normalizeEmail(i.email) };
    notice = notices.render({ templateCode: STAFF_INVITATION_TEMPLATE, recipients: [recipient], payload: { inviter_name, roles: roles.join(", "), sign_in_url: opsSignInUrl(), platform_postal_address: SERVICER_CONTACT.servicer_address }, asOf: plainDate(d.now.slice(0, 10)) });
    if (notice.status === "held") held_reason = notice.heldReason ?? "held";
    else { try { const sent = await notices.send(notice.id); bounced = sent.deliveries.some((x) => x.emailStatus === "bounced"); } catch (e) { if (notice.deliveries.some((x) => x.emailStatus === "bounced")) bounced = true; else throw e; } }
    const n = notice;
    d.deferWrite(async (q) => { const nr = new PgNoticeRepository(rt.db); const t = rt.noticeRegistry.template(STAFF_INVITATION_TEMPLATE); await nr.upsertTemplate(t, q); const v = rt.noticeRegistry.activeVersion(t.code, plainDate(d.now.slice(0, 10))); if (v) await nr.saveVersion(v, q); await nr.saveNotice(n, q); });
  }
  d.deferWrite(async (q) => { if (existing) await repo.reinvite(id, { email_hash: hash, email_encrypted: encrypted, legal_name, roles, invited_by, now: d.now }, q); else await repo.createUser({ id, email_hash: hash, email_encrypted: encrypted, legal_name, roles, invited_by, now: d.now }, q); });
  d.events.append({ type: "staff.invited", aggregate: { kind: "staff_user", id }, actor: d.actor, payload: P({ staff_user_id: id, invited_by, roles, notice_id: notice?.id ?? null, bounced, held_reason, reinvited: !!existing }) });
  return { staff_user_id: id, status: "invited", roles, reinvited: !!existing, notice_id: notice?.id ?? null, bounced, held_reason, invited_by };
}

// ───────── staff.signin (the only path to a session)
export interface SigninInput { readonly email: string; readonly password: string; readonly ip?: string | null; readonly user_agent?: string | null }
export type SigninResult =
  | { readonly ok: true; readonly token: string; readonly session_id: string; readonly staff_user_id: string; readonly roles: readonly StaffRole[]; readonly factors: readonly StaffFactor[]; readonly expires_at: string; readonly legal_name: string | null }
  | { readonly ok: false; readonly code: "PASSWORD_WRONG" | "ACCOUNT_LOCKED" | "ACCOUNT_DISABLED" | "FACTOR_REQUIRED" | "NOT_ENROLLED"; readonly status: number; readonly staff_user_id: string | null; readonly locked_until?: string; readonly failures?: number };
export const SIGNIN_STATUS: Record<Extract<SigninResult, { ok: false }>["code"], number> = { PASSWORD_WRONG: 401, ACCOUNT_LOCKED: 423, ACCOUNT_DISABLED: 403, FACTOR_REQUIRED: 401, NOT_ENROLLED: 401 };
export async function staffSignin(d: StaffActDeps, i: SigninInput): Promise<SigninResult> {
  const repo = new PgStaffRepository(d.db);
  const fail = (code: Extract<SigninResult, { ok: false }>["code"], staff_user_id: string | null, extra: { locked_until?: string; failures?: number } = {}): SigninResult => ({ ok: false, code, status: SIGNIN_STATUS[code], staff_user_id, ...extra });
  const user = isEmail(i.email ?? "") ? await repo.userByEmailHash(emailHash(i.email)) : undefined;
  if (!user) { await verifyPasswordHash(i.password ?? "", DUMMY_PASSWORD_HASH); return fail("PASSWORD_WRONG", null); }   // the same time as a wrong password
  if (user.status === "disabled") return fail("ACCOUNT_DISABLED", user.id);
  if (repo.isLocked(user, d.now)) return fail("ACCOUNT_LOCKED", user.id, { locked_until: user.locked_until! });
  const cred = await repo.password(user.id);
  if (!cred || user.status !== "active") { await verifyPasswordHash(i.password ?? "", DUMMY_PASSWORD_HASH); return fail("NOT_ENROLLED", user.id); }
  const actor: Actor = d.actor.kind === "human" ? d.actor : { kind: "human", id: user.id, role: user.roles[0] ?? "ops_analyst" };
  if (!(await verifyPasswordHash(i.password ?? "", cred.secret_hash))) {
    // rule 1: five failed sign-ins in an hour lock the account for 15 minutes — the counter is written with the command (a lapsed lock or an hour of quiet restarts it: repo.nextFailure / recordFailure agree), the lock and the escalation on the fifth
    const { failures, locks, locked_until } = repo.nextFailure(user, d.now, STAFF_LOCK_AFTER_FAILURES, STAFF_LOCK_MINUTES);
    d.deferWrite(async (q) => { await repo.recordFailure(user.id, d.now, STAFF_LOCK_AFTER_FAILURES, STAFF_LOCK_MINUTES, q); });
    d.events.append({ type: "staff.signin.failed", aggregate: { kind: "staff_user", id: user.id }, actor, payload: P({ staff_user_id: user.id, factor: "password", failures, locked: locks }) });
    if (locks) {
      d.events.append({ type: "staff.signin.locked", aggregate: { kind: "staff_user", id: user.id }, actor, payload: P({ staff_user_id: user.id, factor: "password", failures, locked_until, lock_minutes: STAFF_LOCK_MINUTES }) });
      d.escalations.open({ kind: "sev3", ownerRole: "compliance", severity: "3", payload: { staff_user_id: user.id, failures, locked_until, reason: `staff.signin.locked: ${failures} failed sign-ins for one staff account within an hour (34.1 rule 1)` } }, actor);
    }
    return fail("PASSWORD_WRONG", user.id, { failures, ...(locked_until ? { locked_until } : {}) });
  }
  // TWO_FACTORS: the password alone never opens a session — a possession factor (a code verified for this e-mail, or a passkey asserted) within 10 minutes, not yet spent by a session
  const possession = await repo.possessionWithin(user.id, d.now, STAFF_POSSESSION_MINUTES);
  if (!possession) return fail("FACTOR_REQUIRED", user.id);
  const factors: StaffFactor[] = [possession.factor, "password"];
  const session_id = randomUUID(); const token = newToken(); const expires_at = staffSessionExpiry(d.now, d.now);
  d.deferWrite(async (q) => {
    await q.query(`INSERT INTO staff_sessions (session_id, staff_user_id, token_hash, factors, created_at, last_seen_at, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4::text[], $5, $5, $6, $7, $8)`, [session_id, user.id, hashToken(token), factors, d.now, expires_at, i.ip ?? null, i.user_agent ?? null]);
    await repo.clearFailures(user.id, q);
    await repo.spendPossession(possession.challenge_id, q);   // one code or one assertion opens one session (T2/T7: the password alone is FACTOR_REQUIRED again)
  });
  d.events.append({ type: "staff.signed_in", aggregate: { kind: "staff_session", id: session_id }, actor, payload: P({ staff_user_id: user.id, session_id, factors, possession_challenge_id: possession.challenge_id }) });
  return { ok: true, token, session_id, staff_user_id: user.id, roles: user.roles, factors, expires_at, legal_name: user.legal_name };
}

// ───────── staff.role.set / staff.disable (admin decisions with rationale; NO_SELF_ROLE_CHANGE, LAST_ADMIN_STAYS)
export interface RoleSetInput { readonly staff_user_id: string; readonly roles: unknown; readonly rationale?: string | null }
export interface RoleSetResult { readonly staff_user_id: string; readonly changed: boolean; readonly roles_before: readonly StaffRole[]; readonly roles_after: readonly StaffRole[]; readonly sessions_revoked: readonly string[]; readonly by: string | null }
export async function staffRoleSet(d: StaffActDeps, i: RoleSetInput, opts: { decide?: boolean; viaReview?: boolean } = {}): Promise<RoleSetResult> {
  const repo = new PgStaffRepository(d.db);
  if (!opts.viaReview) await requireStaffActor(d, repo, "staff.role.set", ["admin"], "bootstrap_upgrade", i.staff_user_id);   // the review verified compliance | admin already; the bootstrap's one-row upgrade is the system actor's only role change
  const by = byOf(d);
  if (isSelfChange(by, i.staff_user_id)) throw new CommandRefused("staff.role.set", NO_SELF_ROLE_CHANGE.code, NO_SELF_ROLE_CHANGE.citation, `${by} may not change their own roles`);
  const user = await repo.user(i.staff_user_id);
  if (!user) throw new RangeError(`no staff user ${i.staff_user_id}`);
  if (user.status === "disabled") throw new RangeError(`staff user ${user.id} is disabled; roles are not changed on a disabled account`);
  const after = normalizeRoles(i.roles); const before = user.roles;
  const rationale = (typeof i.rationale === "string" && i.rationale.trim()) || "role change";
  if (sameRoles(before, after)) return { staff_user_id: user.id, changed: false, roles_before: before, roles_after: after, sessions_revoked: [], by };
  if (user.status === "active" && wouldRemoveLastAdmin(await repo.activeAdminIds(), user.id, after)) throw new CommandRefused("staff.role.set", LAST_ADMIN_STAYS.code, LAST_ADMIN_STAYS.citation, `removing admin from ${user.id} would leave no active admin`);
  const open = (await repo.openSessionsOf(user.id, d.now)).map((s) => s.session_id);
  const demotesAdmin = user.status === "active" && before.includes("admin") && !after.includes("admin");
  d.deferWrite(async (q) => {
    // edge cases: "Two admins disable each other simultaneously → LAST_ADMIN_STAYS refuses the second" — the invariant is re-checked under the admin rows' lock in the transaction that writes the change; a refusal rolls the command back
    if (demotesAdmin && wouldRemoveLastAdmin(await repo.lockActiveAdmins(q), user.id, after)) throw new CommandRefused("staff.role.set", LAST_ADMIN_STAYS.code, LAST_ADMIN_STAYS.citation, `removing admin from ${user.id} would leave no active admin (another change to the admins committed first)`);
    await repo.setRoles(user.id, after, q); await repo.revokeSessionsOf(user.id, d.now, q);
  });
  d.events.append({ type: "staff.role.changed", aggregate: { kind: "staff_user", id: user.id }, actor: d.actor, payload: P({ staff_user_id: user.id, roles_before: before, roles_after: after, by, sessions_revoked: open }) });
  if (opts.decide && d.decide) d.decide(staffDecision({ action: "staff.role.set", staff_user_id: user.id, roles_before: before, roles_after: after, rationale, by }));
  return { staff_user_id: user.id, changed: true, roles_before: before, roles_after: after, sessions_revoked: open, by };
}
export interface DisableInput { readonly staff_user_id: string; readonly rationale?: string | null }
export interface DisableResult { readonly staff_user_id: string; readonly changed: boolean; readonly roles_before: readonly StaffRole[]; readonly sessions_revoked: readonly string[]; readonly by: string | null }
export async function staffDisable(d: StaffActDeps, i: DisableInput, opts: { decide?: boolean; viaReview?: boolean } = {}): Promise<DisableResult> {
  const repo = new PgStaffRepository(d.db);
  if (!opts.viaReview) await requireStaffActor(d, repo, "staff.disable", ["admin"]);
  const by = byOf(d);
  if (isSelfChange(by, i.staff_user_id)) throw new CommandRefused("staff.disable", NO_SELF_ROLE_CHANGE.code, NO_SELF_ROLE_CHANGE.citation, `${by} may not disable their own account`);
  const user = await repo.user(i.staff_user_id);
  if (!user) throw new RangeError(`no staff user ${i.staff_user_id}`);
  const rationale = (typeof i.rationale === "string" && i.rationale.trim()) || "disabled";
  if (user.status === "disabled") return { staff_user_id: user.id, changed: false, roles_before: user.roles, sessions_revoked: [], by };
  if (user.status === "active" && wouldRemoveLastAdmin(await repo.activeAdminIds(), user.id, [])) throw new CommandRefused("staff.disable", LAST_ADMIN_STAYS.code, LAST_ADMIN_STAYS.citation, `disabling ${user.id} would leave no active admin`);
  const open = (await repo.openSessionsOf(user.id, d.now)).map((s) => s.session_id);
  const disablesAdmin = user.status === "active" && user.roles.includes("admin");
  d.deferWrite(async (q) => {
    // edge cases: "Two admins disable each other simultaneously → LAST_ADMIN_STAYS refuses the second" — re-checked under the admin rows' lock in the writing transaction; the refusal rolls the command back
    if (disablesAdmin && wouldRemoveLastAdmin(await repo.lockActiveAdmins(q), user.id, [])) throw new CommandRefused("staff.disable", LAST_ADMIN_STAYS.code, LAST_ADMIN_STAYS.citation, `disabling ${user.id} would leave no active admin (another change to the admins committed first)`);
    await repo.disable(user.id, d.now, q); await repo.revokeSessionsOf(user.id, d.now, q);
  });
  d.events.append({ type: "staff.disabled", aggregate: { kind: "staff_user", id: user.id }, actor: d.actor, payload: P({ staff_user_id: user.id, by, roles_before: user.roles, sessions_revoked: open }) });
  if (opts.decide && d.decide) d.decide(staffDecision({ action: "staff.disable", staff_user_id: user.id, roles_before: user.roles, roles_after: [], rationale, by }));
  return { staff_user_id: user.id, changed: true, roles_before: user.roles, sessions_revoked: open, by };
}

// ───────── staff.access.review (rule 6)
export interface AccessReviewInput { readonly decisions: readonly ReviewInput[]; readonly rationale?: string | null }
export interface AccessReviewResult { readonly review_id: string; readonly reviewed_by: string | null; readonly reviewed_at: string; readonly users: readonly ReviewEntry[]; readonly changes: number; readonly applied: readonly { staff_user_id: string; decision: string; changed: boolean }[] }
export async function staffAccessReview(d: StaffActDeps, i: AccessReviewInput): Promise<AccessReviewResult> {
  const repo = new PgStaffRepository(d.db);
  await requireStaffActor(d, repo, "staff.access.review", ["compliance", "admin"]);
  const active = (await repo.users()).filter((u) => u.status === "active").map((u) => ({ id: u.id, roles: u.roles }));
  const decisions = Array.isArray(i.decisions) ? i.decisions : [];
  const plan = planAccessReview(active, decisions);
  if (plan.unknown.length) throw new RangeError(`the review names users that are not active staff: ${plan.unknown.join(", ")}`);
  if (plan.missing.length) throw new RangeError(`the review must decide every active user; missing: ${plan.missing.join(", ")}`);
  const rationale = (typeof i.rationale === "string" && i.rationale.trim()) || "quarterly access review";
  const applied: { staff_user_id: string; decision: string; changed: boolean }[] = [];
  for (const e of plan.changes) {
    if (e.decision === "change") { const r = await staffRoleSet(d, { staff_user_id: e.staff_user_id, roles: e.roles_after, rationale: `access review: ${rationale}` }, { decide: true, viaReview: true }); applied.push({ staff_user_id: e.staff_user_id, decision: "change", changed: r.changed }); }
    else { const r = await staffDisable(d, { staff_user_id: e.staff_user_id, rationale: `access review: ${rationale}` }, { decide: true, viaReview: true }); applied.push({ staff_user_id: e.staff_user_id, decision: "disable", changed: r.changed }); }
  }
  const review_id = randomUUID(); const reviewed_by = byOf(d);
  d.deferWrite(async (q) => { await repo.insertReview({ id: review_id, reviewed_by: reviewed_by ?? (await repo.activeAdminIds())[0] ?? plan.entries[0]!.staff_user_id, reviewed_at: d.now, users: plan.entries }, q); });
  d.events.append({ type: "staff.access_review.completed", aggregate: { kind: "staff_access_review", id: review_id }, actor: d.actor, payload: P({ review_id, reviewed_by, reviewed_at: d.now, users: plan.entries, changes: plan.changes.length }) });
  return { review_id, reviewed_by, reviewed_at: d.now, users: plan.entries, changes: plan.changes.length, applied };
}

// ───────── the first admin (Operational prerequisites: main.ts staff-bootstrap <email> / STAFF_BOOTSTRAP_ADMIN_EMAIL, with STAFF_BOOTSTRAP_ADMIN_ROLES outside production)
export const BOOTSTRAP_ROLES_RATIONALE = "bootstrap roles (nonprod)";
export interface BootstrapOptions {
  readonly logger?: Logger; readonly legal_name?: string;
  /** `STAFF_BOOTSTRAP_ADMIN_ROLES`: a comma list or an array (default `admin`); honoured only when `environment` is not production. */
  readonly roles?: string | readonly string[] | null | undefined;
  /** `ENVIRONMENT` (default: the process's); in production the roles setting is ignored and the first row holds `[admin]`. */
  readonly environment?: string;
}
export interface BootstrapResult { readonly created: boolean; readonly upgraded: boolean; readonly staff_user_id: string | null; readonly roles: readonly StaffRole[]; readonly reason: string }
/**
 * The roles the bootstrap gives (Operational prerequisites, Q1 of the portal proposal 2026-09-15): the setting outside production
 * — `admin` always among them, because the first row is the admin nothing else can create — and `[admin]` whatever the setting
 * says in production, where privileged authority is granted by a second admin's `staff.role.set` with a rationale, never by a
 * deployment variable. `ignored` says the production reading dropped roles the setting asked for.
 */
export function bootstrapRoles(setting: string | readonly string[] | null | undefined, environment?: string): { roles: StaffRole[]; requested: StaffRole[]; ignored: boolean; production: boolean } {
  const raw = setting === undefined || setting === null || (typeof setting === "string" && !setting.trim()) || (Array.isArray(setting) && !setting.length) ? ["admin"] : setting;
  const requested = normalizeRoles([...(typeof raw === "string" ? raw.split(",") : raw), "admin"]);
  const production = isProductionEnvironment(environment);
  const roles: StaffRole[] = production ? ["admin"] : requested;
  return { roles, requested, ignored: production && !sameRoles(requested, roles), production };
}
/**
 * `staff_users` empty → the first row, invited by the system actor with the roles above, NTC_SM_STAFF_INVITATION sent (a code to
 * that e-mail opens enrolment). Nonprod only, one upgrade and nothing else: the table holding exactly one row — the bootstrap
 * e-mail's, `invited_by` null — whose roles are a strict subset of the setting is upgraded through the real `staff.role.set` path
 * with the bootstrap's system actor and the rationale `bootstrap roles (nonprod)`: `staff.role.changed{roles_before, roles_after,
 * by}` and a decision record are written and the row's open sessions are revoked (rule 5); nothing is deleted. In production,
 * with two or more rows, when the one row is not the bootstrap's or was invited by an admin, or when the roles already equal
 * the setting, the bootstrap creates and changes nothing (34.1-T9). The e-mail is never logged.
 */
export async function bootstrapStaffAdmin(runtime: Runtime, email: string, opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const repo = new PgStaffRepository(runtime.db);
  if (!isEmail(email)) throw new RangeError("staff-bootstrap needs a valid e-mail address");
  const { roles, requested, ignored, production } = bootstrapRoles(opts.roles, opts.environment);
  if (ignored) opts.logger?.info("staff-bootstrap: STAFF_BOOTSTRAP_ADMIN_ROLES ignored in production", { requested, roles, environment: opts.environment ?? process.env["ENVIRONMENT"] ?? "nonprod", reason: "the roles setting is honoured only when ENVIRONMENT ≠ production; the first row holds [admin] and a second admin's staff.role.set grants the rest (34.1 operational prerequisites)" });
  const n = await repo.count();
  if (n === 0) {
    const r = await runtime.execute({ process: "34.1", name: "staff.invite", loanId: "", actor: STAFF_BOOTSTRAP_ACTOR, input: { email, legal_name: opts.legal_name ?? "Administrator", roles, rationale: `the first admin (34.1 operational prerequisites)${production ? "" : `; roles from STAFF_BOOTSTRAP_ADMIN_ROLES (nonprod)`}` } });
    const out = r.output as InviteResult;
    opts.logger?.info("staff-bootstrap: the first admin invited", { staff_user_id: out.staff_user_id, roles: out.roles, notice_id: out.notice_id, bounced: out.bounced, held_reason: out.held_reason });
    return { created: true, upgraded: false, staff_user_id: out.staff_user_id, roles: out.roles, reason: "invited" };
  }
  const skipped = (reason: string, extra: Record<string, unknown> = {}): BootstrapResult => { opts.logger?.info("staff-bootstrap: skipped", { reason, rows: n, ...extra }); return { created: false, upgraded: false, staff_user_id: null, roles, reason }; };
  if (production) return skipped("staff_users is not empty — nothing else creates an admin without an admin; no upgrade in production");
  if (n !== 1) return skipped("staff_users is not empty — nothing else creates an admin without an admin; the one-row upgrade needs exactly one row");
  const row = (await repo.users())[0]!;
  if (row.email_hash !== emailHash(email)) return skipped("staff_users is not empty; the one row is not the bootstrap e-mail's");
  if (row.invited_by !== null) return skipped("staff_users is not empty; the one row was invited by an admin, not the bootstrap", { staff_user_id: row.id });
  if (row.status === "disabled") return skipped("staff_users is not empty; the one row is disabled", { staff_user_id: row.id });
  if (sameRoles(row.roles, roles)) return skipped("staff_users is not empty; the roles already equal the setting", { staff_user_id: row.id, roles: row.roles });
  if (!row.roles.every((r) => roles.includes(r))) return skipped("staff_users is not empty; the one row's roles are not a subset of the setting — the bootstrap never removes a role", { staff_user_id: row.id, roles: row.roles });
  const r = await runtime.execute({ process: "34.1", name: "staff.role.set", loanId: "", actor: STAFF_BOOTSTRAP_ACTOR, input: { staff_user_id: row.id, roles, rationale: BOOTSTRAP_ROLES_RATIONALE } });
  const out = r.output as RoleSetResult;
  opts.logger?.info("staff-bootstrap: the one row upgraded (nonprod)", { staff_user_id: out.staff_user_id, roles_before: out.roles_before, roles_after: out.roles_after, sessions_revoked: out.sessions_revoked.length, rationale: BOOTSTRAP_ROLES_RATIONALE });
  return { created: false, upgraded: out.changed, staff_user_id: out.staff_user_id, roles: out.roles_after, reason: "upgraded" };
}
