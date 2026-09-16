/**
 * 36.1 — the partner doors and the one partner-identity act (spec/sections/36-servicing-partner-portal/36-1-*.md). The
 * MECHANICS of 34.1's staff door (src/runtime/staff/auth.ts) copied over the partner tables (migration 0243) — never the
 * staff tables, never a StaffRole:
 *
 *   PartnerAuth (the doors; no bus command): the e-mail code (rule 1; 32.2's OTP path on `auth_challenges{subject_kind=partner}`,
 *   the FAKE e-delivery port outside production with `fake_code` echoed exactly as the borrower and staff doors; one open code per
 *   address; a wrong code is a failed sign-in on the account's counter; an unknown address, a disabled account, a locked account,
 *   a missing code and a wrong code all answer the same 401 OTP_INVALID — the action log keeps the reason), the enrol/step token a
 *   verified code yields (10 minutes; NEVER a session — it sets the password at enrolment, resets it with a second proof, and
 *   registers a passkey), the password (≥ 12 characters, the breached list, the scrypt hasher the staff door uses), the passkeys
 *   (the borrower side's WebAuthn verifier, src/runtime/borrower/webauthn.ts), the sign-in (the only path to a `partner_sessions`
 *   row: a possession factor — a code verified for this e-mail within 10 minutes or a passkey asserted — AND the password; a
 *   disabled user is refused with the generic door answer and no session row — 36.1-T5; five failures lock the account 15 minutes
 *   and open one `compliance` escalation as 34.1 rule 1 does) and the session (rule 6: 30 minutes idle, 12 hours absolute; revoked
 *   on sign-out, disable, role change or expiry → 401 SESSION_EXPIRED). The session's `role` is the least-privileged role held
 *   (rule 3); every session is bound to one `partner_party_id` (rule 4).
 *
 *   The act (the `security-records` agent's one tool, src/app/tools/section36-1.ts, calls it with the command's stores):
 *   partnerInvite — rule 8: `partner.user.invite{partner_party_id, email, name, roles}` by staff `ops_analyst` / `admin` for any
 *   tenant (the only way a tenant gets its first user), by a `partner_admin` for their own tenant only (the tenant is the actor's
 *   row's, never the body's), by the seed's system actor outside production (the demo partner's first admin). The actor is
 *   verified from rows, never trusted from the request (34.1's review finding). It writes `partner_users{status = invited}`,
 *   renders NTC_SM_PARTNER_USER_INVITE by e-mail through the Notice Registry, refuses the caller's own e-mail
 *   (NO_SELF_ROLE_CHANGE) and re-invites an existing invited row for the same normalized e-mail in the tenant.
 *
 * Open question 3's default: no `loan_events` row for a door or an invitation — the action log (rule 5) and the decision record
 * are the record; the lock's `compliance` escalation is the escalation service's own row and event. Nothing here logs an e-mail,
 * a name, a phone or a code.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import type { Actor, Clock, EventStore } from "../../kernel/events/index.ts";
import { hashPassword, verifyPasswordHash, DUMMY_PASSWORD_HASH } from "../../infra/db/borrower-credentials.ts";
import { verifyRegistration, verifyAssertion, b64url } from "../borrower/webauthn.ts";
import { CommandRefused } from "../../app/commands.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { NoticeService, type Notice } from "../../notices/service.ts";
import type { Recipient } from "../../notices/channel.ts";
import { PgNoticeRepository } from "../../infra/db/notices.ts";
import type { EdeliveryPort, EdeliveryMessage } from "../../infra/integrations/delivery.ts";
import { FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { plainDate } from "../../kernel/calendar/date.ts";
import { FAKE_SERVICER_PROFILE_V1 } from "../../domain/operations-runtime/servicing-config.ts";
import { passwordProblem, STAFF_PASSWORD_MIN_LENGTH, isProductionEnvironment } from "../staff/auth.ts";
import { PgStaffRepository } from "../staff/repo.ts";
import type { Runtime } from "../app.ts";
import type { Logger } from "../log.ts";
import { PgPartnerRepository, emailHash, encryptEmail, decryptEmail, isEmail, normalizeEmail, newToken, hashToken, hashCode, staffEmailKey, type PartnerUserRow, type PartnerSessionRow, type PartnerChallengeRow, type PartnerFactor, type PasskeySecret } from "./repo.ts";
import { PartnerError, normalizePartnerRoles, defaultRole, NO_SELF_ROLE_CHANGE, type PartnerRole } from "./roles.ts";

export const PARTNER_IDLE_MINUTES = 30;
export const PARTNER_ABSOLUTE_HOURS = 12;
export const PARTNER_CODE_MINUTES = 10;
export const PARTNER_STEP_TOKEN_MINUTES = 10;
export const PARTNER_POSSESSION_MINUTES = 10;
export const PARTNER_CODE_MAX_ATTEMPTS = 5;
export const PARTNER_LOCK_AFTER_FAILURES = 5;
export const PARTNER_LOCK_MINUTES = 15;
export const PARTNER_PASSWORD_MIN_LENGTH = STAFF_PASSWORD_MIN_LENGTH;
export const SECURITY_RECORDS_AGENT = "security-records";
export const PARTNER_RULE_SET_VERSION = "partner_portal.access.v1";
export const PARTNER_MODEL_VERSION = "deterministic";
export const PARTNER_PROMPT_VERSION = "36.1-v1";
export const PARTNER_INVITE_TEMPLATE = "NTC_SM_PARTNER_USER_INVITE";
/** The door answer every account-state refusal of the sign-in shares (rule 1 / T5: "the generic door answer"); the log keeps the reason. */
export const SIGNIN_INVALID = "SIGNIN_INVALID";
/** The seed's system actor (rule 8: "the seed runs the same command with the system actor") — accepted by partner.user.invite outside production only. */
export const PARTNER_SEED_ACTOR: Actor = { kind: "system", id: "seed-demo" };
/** The staff roles that may provision a tenant's users from /ops (rule 8). */
export const STAFF_PROVISION_ROLES: readonly string[] = ["ops_analyst", "admin"];

const minutesAfter = (iso: string, m: number): string => new Date(Date.parse(iso) + m * 60_000).toISOString();
const hoursAfter = (iso: string, h: number): string => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
const earlier = (a: string, b: string): string => (Date.parse(a) <= Date.parse(b) ? a : b);
/** Rule 6: the idle deadline never passes the absolute one. */
export const partnerSessionExpiry = (createdAt: string, now: string): string => earlier(minutesAfter(now, PARTNER_IDLE_MINUTES), hoursAfter(createdAt, PARTNER_ABSOLUTE_HOURS));
const sixDigits = (): string => randomInt(0, 1_000_000).toString().padStart(6, "0");
/** The partner app's door: PARTNER_URL, else the app base + /partners/sign-in (Outputs: "the sign-in address /partners/sign-in"). */
export const partnerSignInUrl = (env: NodeJS.ProcessEnv = process.env): string => { const own = (env["PARTNER_URL"] ?? "").trim().replace(/\/+$/, ""); return own ? `${own}/partners/sign-in` : `${(env["BORROWER_APP_URL"] ?? "https://app.supermortgage.example").replace(/\/+$/, "")}/partners/sign-in`; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A partner session resolved for a request: the row, the user, the bearer. */
export interface PartnerContext { readonly session: PartnerSessionRow; readonly user: PartnerUserRow; readonly token: string }
export interface PartnerAuthOptions { readonly runtime: Runtime; readonly environment?: string; readonly rpId?: string; readonly allowedOrigins?: readonly string[]; readonly emailKey?: Buffer; readonly logger?: Logger }

export class PartnerAuth {
  readonly runtime: Runtime; readonly repo: PgPartnerRepository; readonly environment: string; readonly nonProduction: boolean; readonly rpId: string; readonly allowedOrigins: readonly string[]; readonly logger: Logger | undefined;
  private keyOption: Buffer | undefined; private resolvedKey: Buffer | undefined;
  constructor(o: PartnerAuthOptions) {
    this.runtime = o.runtime; this.repo = new PgPartnerRepository(o.runtime.db);
    this.environment = o.environment ?? o.runtime.environment ?? process.env["ENVIRONMENT"] ?? "nonprod"; this.nonProduction = !isProductionEnvironment(this.environment);
    this.keyOption = o.emailKey;
    this.rpId = o.rpId ?? process.env["BORROWER_RP_ID"] ?? "localhost"; this.allowedOrigins = o.allowedOrigins ?? (process.env["BORROWER_ORIGINS"] ? process.env["BORROWER_ORIGINS"].split(",").map((s) => s.trim()) : []);
    this.logger = o.logger ?? o.runtime.logger;
  }
  /** The e-mail cipher key (34.1's STAFF_EMAIL_KEY; a FAKE constant outside production), resolved at the first door use rather than at construction: the API server builds the partner router eagerly, and a production server that lacks the key must refuse the door, not the whole server (src/runtime/demo-clock.test.ts's production guard). */
  get key(): Buffer { if (!this.resolvedKey) this.resolvedKey = this.keyOption ?? staffEmailKey({ ...process.env, ENVIRONMENT: this.environment }); return this.resolvedKey; }
  private get edelivery(): EdeliveryPort | undefined { return this.runtime.ports.edelivery; }
  private deliveryIsFake(): boolean { return !this.edelivery || this.edelivery instanceof FakeEdelivery; }
  emailOf(user: PartnerUserRow): string { return decryptEmail(user.email_encrypted, this.key); }
  private tenantOf(i: { partner_party_id?: unknown }): string | null { return typeof i.partner_party_id === "string" && UUID.test(i.partner_party_id) ? i.partner_party_id : null; }

  // ───────── the code (rule 1; POST /v1/partner/auth/code)
  /**
   * A six-digit code to the e-mail on the partner user row; the answer is the same whether or not the address is a partner
   * user's (no enumeration). One open code per address; a disabled or locked account gets the unknown-address answer: a row no
   * code path can verify. The FAKE port echoes `fake_code` outside production.
   */
  async requestCode(i: { email: string; partner_party_id?: unknown }, now: string): Promise<{ challenge_id: string; delivery: string; expires_at: string; fake_code?: string }> {
    if (!isEmail(i.email ?? "")) throw new PartnerError(400, "EMAIL_INVALID", "a valid e-mail address is required");
    const user = await this.repo.userByEmailHash(emailHash(i.email), this.tenantOf(i));
    const delivery = this.deliveryIsFake() ? "FAKE" : "email";
    const sendable = !!user && user.status !== "disabled" && !this.repo.isLocked(user, now);
    const open = sendable ? await this.repo.openCodeOf(user!.id, now) : undefined;
    if (open) { this.logger?.info("partner.code.reissued", { challenge_id: open.challenge_id, known: true, minted: false }); return { challenge_id: open.challenge_id, delivery: open.delivery ?? delivery, expires_at: open.expires_at }; }
    const code = sixDigits(); const expires_at = minutesAfter(now, PARTNER_CODE_MINUTES);
    let delivery_ref: string | null = null;
    const ch = await this.repo.createChallenge({ kind: "otp", partner_user_id: sendable ? user!.id : null, code, delivery, expires_at });
    if (sendable && this.edelivery) { const r = await this.edelivery.send({ messageId: `partner_otp:${ch.challenge_id}`, noticeId: `partner_otp:${ch.challenge_id}`, channel: "email", to: normalizeEmail(i.email), subject: "Your partner portal sign-in code", consentId: "policy:authentication_otp" }, now); delivery_ref = r.messageId; }
    this.logger?.info("partner.code.requested", { challenge_id: ch.challenge_id, known: sendable, delivery, delivery_ref });
    return { challenge_id: ch.challenge_id, delivery, expires_at, ...(this.deliveryIsFake() && this.nonProduction ? { fake_code: code } : {}) };
  }
  // ───────── verify → the enrol/step token (POST /v1/partner/auth/verify) — never a session
  async verifyCode(i: { email: string; code: string; partner_party_id?: unknown }, now: string): Promise<{ token: string; expires_at: string; partner_user_id: string; partner_party_id: string; status: PartnerUserRow["status"]; has_password: boolean; roles: readonly PartnerRole[] }> {
    const invalid = (logCode: string): PartnerError => new PartnerError(401, "OTP_INVALID", "the code is not valid for this e-mail; request a new one", {}, logCode);
    const user = isEmail(i.email ?? "") ? await this.repo.userByEmailHash(emailHash(i.email), this.tenantOf(i)) : undefined;
    if (!user) throw invalid("OTP_NO_ACCOUNT");
    if (user.status === "disabled") throw invalid("ACCOUNT_DISABLED");   // T5: the generic door answer; the row is never written
    if (this.repo.isLocked(user, now)) throw invalid("ACCOUNT_LOCKED");
    const ch = await this.repo.openCodeOf(user.id, now);
    if (!ch) throw invalid("OTP_EXPIRED");
    const attempts = await this.repo.bumpAttempts(ch.challenge_id);
    if (attempts > PARTNER_CODE_MAX_ATTEMPTS) throw new PartnerError(429, "OTP_TOO_MANY_ATTEMPTS");
    if (ch.code_hash !== hashCode(ch.challenge_id, String(i.code ?? "").trim())) { await this.doorFailure(user, now, "email_code"); throw invalid("OTP_INVALID"); }
    const token = newToken();
    await this.repo.consume(ch.challenge_id, now, hashToken(token));
    this.logger?.info("partner.code.verified", { challenge_id: ch.challenge_id, partner_user_id: user.id });
    return { token, expires_at: minutesAfter(now, PARTNER_STEP_TOKEN_MINUTES), partner_user_id: user.id, partner_party_id: user.partner_party_id, status: user.status, has_password: !!(await this.repo.password(user.id)), roles: user.roles };
  }
  /** The consumed code row and the partner user an enrol/step token names (401 TOKEN_INVALID otherwise; a disabled user's token opens nothing). */
  private async stepOf(token: string, now: string): Promise<{ row: PartnerChallengeRow; user: PartnerUserRow }> {
    const row = token ? await this.repo.stepToken(hashToken(token), now, PARTNER_STEP_TOKEN_MINUTES) : undefined;
    const user = row?.partner_user_id ? await this.repo.user(row.partner_user_id) : undefined;
    if (!row || !user || user.status === "disabled") throw new PartnerError(401, "TOKEN_INVALID", "the enrol token is unknown or older than 10 minutes", {}, user?.status === "disabled" ? "ACCOUNT_DISABLED" : "TOKEN_INVALID");
    return { row, user };
  }
  /**
   * Rule 1: a failed sign-in (a wrong code, a wrong password) — the account's counter in the hour's window, the fifth locks the
   * account 15 minutes and opens one `compliance` escalation (the same escalation the staff door opens), committed with the row.
   */
  private async doorFailure(user: PartnerUserRow, now: string, factor: "email_code" | "password"): Promise<{ failures: number; locks: boolean; locked_until: string | undefined }> {
    const n = this.repo.nextFailure(user, now, PARTNER_LOCK_AFTER_FAILURES, PARTNER_LOCK_MINUTES);
    const actor: Actor = { kind: "human", id: user.id, role: defaultRole(user.roles) ?? "partner_ops" };
    let escalations: EscalationService | undefined;
    await this.runtime.uow.run({}, async (ctx) => {
      if (n.locks) {
        escalations = new EscalationService(ctx.events, ctx.clock);
        escalations.open({ kind: "sev3", ownerRole: "compliance", severity: "3", payload: { partner_user_id: user.id, partner_party_id: user.partner_party_id, failures: n.failures, locked_until: n.locked_until, reason: `partner.signin.locked: ${n.failures} failed sign-ins for one partner account within an hour (36.1 rule 1; 34.1 rule 1)` } }, actor);
      }
    }, { clock: this.runtime.clock, commit: async (q) => { await this.repo.recordFailure(user.id, now, PARTNER_LOCK_AFTER_FAILURES, PARTNER_LOCK_MINUTES, q); for (const e of escalations?.list() ?? []) await this.runtime.escalationRepo.save(e, q); } });
    this.logger?.info(n.locks ? "partner.signin.locked" : "partner.signin.failed", { partner_user_id: user.id, factor, failures: n.failures });
    return n;
  }
  // ───────── the password (POST /v1/partner/auth/password): set at enrolment, or reset — both on the step token; the reset also needs a second proof
  async setPassword(i: { token: string; password: string; current_password?: string | null }, now: string): Promise<{ partner_user_id: string; partner_party_id: string; enrolled: boolean; status: PartnerUserRow["status"]; proof?: "current_password" | "passkey" }> {
    const { row: step, user } = await this.stepOf(i.token ?? "", now);
    const enrolling = user.status === "invited";
    let proofKind: "enrolment" | "current_password" | "passkey" = "enrolment"; let assertion: string | null = null;
    if (!enrolling) {
      if (this.repo.isLocked(user, now)) throw new PartnerError(423, "ACCOUNT_LOCKED", "the account is locked; try again later", { locked_until: user.locked_until });
      const cred = await this.repo.password(user.id);
      const current = typeof i.current_password === "string" ? i.current_password : "";
      if (current && cred && (await verifyPasswordHash(current, cred.secret_hash))) proofKind = "current_password";
      else {
        const pk = await this.repo.possessionWithin(user.id, now, PARTNER_POSSESSION_MINUTES, undefined, ["passkey_assertion"]);
        if (pk) { proofKind = "passkey"; assertion = pk.challenge_id; }
        else {
          if (current) { await this.doorFailure(user, now, "password"); throw new PartnerError(401, "PROOF_REQUIRED", "the current password did not match; a reset needs the current password or a passkey asserted within 10 minutes", {}, "PASSWORD_WRONG"); }
          throw new PartnerError(401, "PROOF_REQUIRED", "a reset needs a second proof the mailbox does not give: the current password (`current_password`) or a passkey asserted within 10 minutes");
        }
      }
    }
    const problem = passwordProblem(i.password ?? "");
    if (problem) throw new PartnerError(400, "PASSWORD_WEAK", problem === "too_short" ? `a password is at least ${PARTNER_PASSWORD_MIN_LENGTH} characters` : "this password appears on the breached-password list", { reason: problem });
    const hash = await hashPassword(i.password);
    await this.runtime.db.tx(async (q) => {
      await this.repo.addPassword(user.id, hash, now, q); await this.repo.clearFailures(user.id, q);
      if (enrolling) await this.repo.markEnrolled(user.id, now, q);
      else { await this.repo.revokeSessionsOf(user.id, now, q); await this.repo.spendPossession(step.challenge_id, q); if (assertion) await this.repo.spendPossession(assertion, q); }
    });
    this.logger?.info(enrolling ? "partner.enrolled" : "partner.password.reset", { partner_user_id: user.id, factor: "password", proof: proofKind });
    return { partner_user_id: user.id, partner_party_id: user.partner_party_id, enrolled: enrolling, status: enrolling ? "active" : user.status, ...(proofKind === "enrolment" ? {} : { proof: proofKind }) };
  }

  // ───────── the sign-in (POST /v1/partner/auth/signin) — the only path to a partner_sessions row
  /**
   * The password against the scrypt hash AND a possession factor (a code verified for this e-mail within 10 minutes, or a passkey
   * asserted) — TWO_FACTORS. An unknown address, a disabled account (T5), a locked account, an account not yet enrolled and a
   * wrong password all answer the same 401 SIGNIN_INVALID (the log keeps the reason); a matched password with no possession factor
   * answers 401 FACTOR_REQUIRED (the app then asks for the code). The session's role is the least-privileged role held (rule 3).
   */
  async signIn(i: { email: string; password: string; partner_party_id?: unknown; ip?: string | null; user_agent?: string | null }, now: string): Promise<{ token: string; session_id: string; partner_user_id: string; partner_party_id: string; role: PartnerRole; roles: readonly PartnerRole[]; factors: readonly PartnerFactor[]; expires_at: string; name: string | null }> {
    const invalid = (logCode: string): PartnerError => new PartnerError(401, SIGNIN_INVALID, "the e-mail, the password or the code is not valid", {}, logCode);
    const user = isEmail(i.email ?? "") ? await this.repo.userByEmailHash(emailHash(i.email), this.tenantOf(i)) : undefined;
    if (!user) { await verifyPasswordHash(i.password ?? "", DUMMY_PASSWORD_HASH); throw invalid("NO_ACCOUNT"); }   // the same time as a wrong password
    if (user.status === "disabled") { await verifyPasswordHash(i.password ?? "", DUMMY_PASSWORD_HASH); throw invalid("ACCOUNT_DISABLED"); }   // T5: refused, no session row
    if (this.repo.isLocked(user, now)) { await verifyPasswordHash(i.password ?? "", DUMMY_PASSWORD_HASH); throw invalid("ACCOUNT_LOCKED"); }
    const cred = await this.repo.password(user.id);
    if (!cred || user.status !== "active") { await verifyPasswordHash(i.password ?? "", DUMMY_PASSWORD_HASH); throw invalid("NOT_ENROLLED"); }
    if (!(await verifyPasswordHash(i.password ?? "", cred.secret_hash))) { await this.doorFailure(user, now, "password"); throw invalid("PASSWORD_WRONG"); }
    const possession = await this.repo.possessionWithin(user.id, now, PARTNER_POSSESSION_MINUTES);
    if (!possession) throw new PartnerError(401, "FACTOR_REQUIRED", "a session opens only after a possession factor (the code to this e-mail, or a passkey) and the password");
    const role = defaultRole(user.roles);
    if (!role) throw invalid("NO_ROLE");
    const factors: PartnerFactor[] = [possession.factor, "password"];
    const expires_at = partnerSessionExpiry(now, now);
    let opened: { session: PartnerSessionRow; token: string } | undefined;
    await this.runtime.db.tx(async (q) => {
      opened = await this.repo.createSession({ partner_user_id: user.id, partner_party_id: user.partner_party_id, role, factors, now, expires_at, ip: i.ip ?? null, user_agent: i.user_agent ?? null }, q);
      await this.repo.clearFailures(user.id, q);
      await this.repo.spendPossession(possession.challenge_id, q);   // one code or one assertion opens one session
    });
    this.logger?.info("partner.signed_in", { partner_user_id: user.id, partner_party_id: user.partner_party_id, session_id: opened!.session.id, role, factors });
    return { token: opened!.token, session_id: opened!.session.id, partner_user_id: user.id, partner_party_id: user.partner_party_id, role, roles: user.roles, factors, expires_at, name: user.name };
  }

  // ───────── the session (rule 6)
  /** The bearer's session, or 401: AUTH_REQUIRED (no bearer, or a bearer that is not a partner session — a staff token, the API token), SESSION_EXPIRED (revoked, idled out, past 12 hours, or the user no longer active). */
  async authenticate(token: string, now: string): Promise<PartnerContext> {
    if (!token) throw new PartnerError(401, "AUTH_REQUIRED", "a partner session bearer is required");
    const session = await this.repo.sessionByToken(token);
    if (!session) throw new PartnerError(401, "AUTH_REQUIRED", "a partner session bearer is required");
    if (session.revoked_at) throw new PartnerError(401, "SESSION_EXPIRED");
    if (Date.parse(session.expires_at) <= Date.parse(now) || Date.parse(session.created_at) + PARTNER_ABSOLUTE_HOURS * 3_600_000 <= Date.parse(now)) { await this.repo.revokeSession(session.id, now); throw new PartnerError(401, "SESSION_EXPIRED"); }
    const user = await this.repo.user(session.partner_user_id);
    if (!user || user.status !== "active" || user.partner_party_id !== session.partner_party_id || !user.roles.includes(session.role)) { await this.repo.revokeSession(session.id, now); throw new PartnerError(401, "SESSION_EXPIRED", undefined, {}, user?.status === "disabled" ? "ACCOUNT_DISABLED" : "SESSION_EXPIRED"); }
    const expiresAt = partnerSessionExpiry(session.created_at, now);
    await this.repo.touchSession(session.id, now, expiresAt);
    return { session: { ...session, last_seen_at: now, expires_at: expiresAt }, user, token };
  }
  async signOut(token: string, now: string): Promise<{ signed_out: boolean; session_id: string | null }> {
    const session = token ? await this.repo.sessionByToken(token) : undefined;
    if (!session || session.revoked_at) return { signed_out: true, session_id: null };
    await this.repo.revokeSession(session.id, now);
    this.logger?.info("partner.signed_out", { partner_user_id: session.partner_user_id, session_id: session.id });
    return { signed_out: true, session_id: session.id };
  }

  // ───────── passkeys (rule 1; the borrower side's verifier reused, as the staff door reuses it)
  async registerOptions(ctx: PartnerContext, now: string): Promise<Record<string, unknown>> {
    const challenge = b64url.encode(randomBytes(32)); const expires_at = minutesAfter(now, PARTNER_CODE_MINUTES);
    const ch = await this.repo.createChallenge({ kind: "passkey_registration", partner_user_id: ctx.user.id, challenge, expires_at });
    const name = ctx.user.name ?? "Partner user";
    return { challenge_id: ch.challenge_id, challenge, rp: { id: this.rpId, name: "Supermortgage partner portal" }, user: { id: b64url.encode(Buffer.from(ctx.user.id)), name, display_name: name }, pub_key_cred_params: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], timeout_ms: PARTNER_CODE_MINUTES * 60_000, attestation: "none", expires_at };
  }
  async register(ctx: PartnerContext, i: { challenge_id: string; credential: unknown; label?: string | null }, now: string): Promise<{ partner_credential_id: string; credential_id: string; algorithm: number; attestation_verified: string }> {
    const ch = await this.repo.challenge(i.challenge_id ?? "");
    if (!ch || ch.kind !== "passkey_registration" || ch.consumed_at || ch.partner_user_id !== ctx.user.id || Date.parse(ch.expires_at) <= Date.parse(now)) throw new PartnerError(401, "PASSKEY_INVALID");
    const credential = i.credential as { id: string; response: { clientDataJSON: string; attestationObject: string; transports?: string[] } } | undefined;
    if (!credential || typeof credential !== "object" || typeof credential.id !== "string" || !credential.response) throw new RangeError("credential { id, response: { clientDataJSON, attestationObject } } is required");
    let r; try { r = verifyRegistration({ rpId: this.rpId, allowedOrigins: this.allowedOrigins, expectedChallenge: ch.challenge!, credential }); } catch (e) { throw new PartnerError(401, "PASSKEY_INVALID", (e as Error).message); }
    const secret: PasskeySecret = { credential_id: r.credentialId, public_key_jwk: r.publicKey.jwk, algorithm: r.publicKey.algorithm, sign_count: String(r.signCount), transports: r.transports };
    let id = "";
    await this.runtime.db.tx(async (q) => { await this.repo.consume(ch.challenge_id, now, null, q); id = (await this.repo.addPasskey(ctx.user.id, secret, i.label ?? null, now, q)).id; });
    this.logger?.info("partner.passkey.registered", { partner_user_id: ctx.user.id, partner_credential_id: id, attestation_format: r.attestationFormat, attestation_verified: r.attestationVerified });
    return { partner_credential_id: id, credential_id: r.credentialId, algorithm: r.publicKey.algorithm, attestation_verified: r.attestationVerified };
  }
  /** The assertion options for an e-mail; an unknown e-mail gets the same shape with no credentials (no enumeration). */
  async assertOptions(i: { email: string; partner_party_id?: unknown }, now: string): Promise<Record<string, unknown>> {
    const user = isEmail(i.email ?? "") ? await this.repo.userByEmailHash(emailHash(i.email), this.tenantOf(i)) : undefined;
    const challenge = b64url.encode(randomBytes(32)); const expires_at = minutesAfter(now, PARTNER_CODE_MINUTES);
    const ch = await this.repo.createChallenge({ kind: "passkey_assertion", partner_user_id: user?.id ?? null, challenge, expires_at });
    const keys = user && user.status === "active" ? await this.repo.passkeys(user.id) : [];
    return { challenge_id: ch.challenge_id, challenge, rp: { id: this.rpId, name: "Supermortgage partner portal" }, allow_credentials: keys.map((k) => ({ type: "public-key", id: k.secret.credential_id, transports: k.secret.transports })), timeout_ms: PARTNER_CODE_MINUTES * 60_000, expires_at };
  }
  /** A verified assertion is the possession factor (consumed row); it opens NO session — signIn needs the password too (TWO_FACTORS). */
  async assert(i: { challenge_id: string; credential: unknown }, now: string): Promise<{ verified: true; partner_user_id: string; possession: "passkey"; expires_at: string }> {
    const ch = await this.repo.challenge(i.challenge_id ?? "");
    if (!ch || ch.kind !== "passkey_assertion" || ch.consumed_at || !ch.partner_user_id || Date.parse(ch.expires_at) <= Date.parse(now)) throw new PartnerError(401, "PASSKEY_INVALID");
    const credential = i.credential as { id: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } } | undefined;
    if (!credential || typeof credential !== "object" || typeof credential.id !== "string" || !credential.response) throw new RangeError("credential { id, response: { clientDataJSON, authenticatorData, signature } } is required");
    const stored = await this.repo.passkeyByCredentialId(ch.partner_user_id, credential.id);
    if (!stored) throw new PartnerError(401, "PASSKEY_INVALID");
    let r; try { r = verifyAssertion({ rpId: this.rpId, allowedOrigins: this.allowedOrigins, expectedChallenge: ch.challenge!, publicKeyJwk: stored.secret.public_key_jwk, algorithm: stored.secret.algorithm, storedSignCount: BigInt(stored.secret.sign_count), credential }); } catch (e) { throw new PartnerError(401, "PASSKEY_INVALID", (e as Error).message); }
    await this.repo.consume(ch.challenge_id, now);
    await this.repo.passkeyUsed(stored.id, { ...stored.secret, sign_count: r.signCount.toString() });
    this.logger?.info("partner.passkey.asserted", { partner_user_id: ch.partner_user_id, partner_credential_id: stored.id });
    return { verified: true, partner_user_id: ch.partner_user_id, possession: "passkey", expires_at: minutesAfter(now, PARTNER_POSSESSION_MINUTES) };
  }
}

// ═════════════════════════════ the act (called by the 36.1 bus tool inside the command's unit of work)

export interface PartnerActDeps {
  readonly runtime: Runtime; readonly db: Queryable; readonly events: EventStore; readonly clock: Clock; readonly now: string; readonly actor: Actor;
  readonly escalations: EscalationService; readonly deferWrite: (fn: (q: Queryable) => Promise<void>) => void; readonly decide?: (d: DecisionInput) => void; readonly emailKey?: Buffer;
}
const ACTOR_CITATION = "36.1 rule 8: 'by staff ops_analyst / admin (from /ops through the existing bus route) for any tenant — the only way a tenant gets its first user; by a partner_admin for their own tenant only, partner_party_id from the session and never from the body'; rule 2: 'never ops_analyst, officer, compliance or admin' as a partner role";
/** Who may run partner.user.invite, verified from rows: a staff row (ops_analyst | admin, any tenant), a partner row (partner_admin, its own tenant), or the seed's system actor outside production. */
export type InviterKind = { readonly kind: "staff"; readonly staff_user_id: string; readonly role: string } | { readonly kind: "partner"; readonly partner_user_id: string; readonly partner_party_id: string; readonly name: string | null } | { readonly kind: "system" };
export async function requirePartnerInviter(d: PartnerActDeps, repo: PgPartnerRepository, tenantAsked: string | null): Promise<{ inviter: InviterKind; tenant: string }> {
  const command = "partner.user.invite";
  if (d.actor.kind === "human" && UUID.test(d.actor.id)) {
    // a partner_admin of a tenant: the tenant is the row's, never the body's (rule 8)
    const partner = await repo.user(d.actor.id);
    if (partner) {
      if (partner.status !== "active" || !partner.roles.includes("partner_admin")) throw new CommandRefused(command, "ROLE_DENIED", ACTOR_CITATION, `${command} needs an active partner_admin; the partner user ${partner.id} is ${partner.status !== "active" ? partner.status : `[${partner.roles.join(", ")}]`}`);
      if (d.actor.role && d.actor.role !== "partner_admin") throw new CommandRefused(command, "ROLE_DENIED", ACTOR_CITATION, `${command} is asked for under ${d.actor.role}; it needs partner_admin`);
      return { inviter: { kind: "partner", partner_user_id: partner.id, partner_party_id: partner.partner_party_id, name: partner.name }, tenant: partner.partner_party_id };
    }
    const staff = await new PgStaffRepository(d.db).user(d.actor.id);
    if (staff && staff.status === "active" && staff.roles.some((r) => STAFF_PROVISION_ROLES.includes(r))) {
      const role = d.actor.role && STAFF_PROVISION_ROLES.includes(d.actor.role) && (staff.roles as readonly string[]).includes(d.actor.role) ? d.actor.role : staff.roles.find((r) => STAFF_PROVISION_ROLES.includes(r))!;
      if (!tenantAsked) throw new RangeError("partner_party_id is required (the tenant's parties{servicer} row) when staff provision a partner user");
      return { inviter: { kind: "staff", staff_user_id: staff.id, role }, tenant: tenantAsked };
    }
    throw new CommandRefused(command, "ROLE_DENIED", ACTOR_CITATION, `${command} needs an active staff member holding ops_analyst or admin, or an active partner_admin of the tenant; the actor ${d.actor.id} is neither`);
  }
  if (d.actor.kind === "system" && d.actor.id === PARTNER_SEED_ACTOR.id && !isProductionEnvironment(d.runtime.environment)) {
    if (!tenantAsked) throw new RangeError("partner_party_id is required (the tenant's parties{servicer} row)");
    return { inviter: { kind: "system" }, tenant: tenantAsked };
  }
  throw new CommandRefused(command, "ROLE_DENIED", ACTOR_CITATION, `${command} is a staff or partner_admin act: ${d.actor.kind}:${d.actor.id} may not run it${d.actor.kind === "system" ? " (the system actor seeds the demo partner's first admin outside production only)" : ""}`);
}

/** The decision record schema of 36.1's AI agent design: `{partner_user_id, partner_party_id, action: invite, roles, rationale, by, rule_set_version: partner_portal.access.v1, model_version: deterministic, prompt_version: 36.1-v1, confidence: 1}`. */
export function partnerInviteDecision(i: { partner_user_id: string; partner_party_id: string; roles: readonly string[]; rationale: string; by: string | null; reinvited: boolean }): DecisionInput {
  return { agent: SECURITY_RECORDS_AGENT, action: "partner.user.invite", ruleSetVersion: PARTNER_RULE_SET_VERSION, modelVersion: PARTNER_MODEL_VERSION, promptVersion: PARTNER_PROMPT_VERSION, confidence: 1, subject: { kind: "partner_user", id: i.partner_user_id },
    rationale: `partner.user.invite partner_user ${i.partner_user_id} of tenant ${i.partner_party_id}: action invite, roles [${i.roles.join(", ")}]${i.reinvited ? " (re-invited)" : ""} by ${i.by ?? "system"}; rationale: ${i.rationale}` };
}

export interface PartnerInviteInput { readonly partner_party_id?: string | null; readonly email: string; readonly name?: string | null; readonly roles: unknown; readonly rationale?: string | null }
export interface PartnerInviteResult { readonly partner_user_id: string; readonly partner_party_id: string; readonly status: "invited"; readonly roles: readonly PartnerRole[]; readonly reinvited: boolean; readonly notice_id: string | null; readonly bounced: boolean; readonly held_reason: string | null; readonly invited_by: string | null; readonly invited_by_actor: string }
/** Rule 8: the row, the notice, the decision (recorded by the tool's `decision` hook). The e-mail is never on an event or a log row. */
export async function partnerInvite(d: PartnerActDeps, i: PartnerInviteInput): Promise<PartnerInviteResult> {
  if (!isEmail(i.email ?? "")) throw new RangeError("email is required (a valid address)");
  const roles = normalizePartnerRoles(i.roles);
  const repo = new PgPartnerRepository(d.db); const key = d.emailKey ?? staffEmailKey({ ...process.env, ENVIRONMENT: d.runtime.environment });
  const { inviter, tenant } = await requirePartnerInviter(d, repo, typeof i.partner_party_id === "string" && UUID.test(i.partner_party_id) ? i.partner_party_id : null);
  const party = await repo.tenant(tenant);
  if (!party) throw new RangeError(`no servicer partner ${tenant} (the tenant is a parties{party_type = servicer} row — 33.1's partner)`);
  const hash = emailHash(i.email);
  // rule 2: a role is never self-granted — the caller's own e-mail is refused
  if (inviter.kind === "partner") { const self = await repo.user(inviter.partner_user_id); if (self && self.email_hash === hash) throw new CommandRefused("partner.user.invite", NO_SELF_ROLE_CHANGE.code, NO_SELF_ROLE_CHANGE.citation, `${inviter.partner_user_id} may not invite their own e-mail`); }
  const existing = await repo.userInTenant(tenant, hash);
  if (existing && existing.status !== "invited") throw new RangeError(`this e-mail already belongs to a partner user of the tenant (${existing.status})`);
  const invited_by = inviter.kind === "partner" ? inviter.partner_user_id : null;
  const invited_by_actor = `${d.actor.kind}:${d.actor.id}`;
  const id = existing?.id ?? randomUUID();
  const name = typeof i.name === "string" && i.name.trim() ? i.name.trim() : null;
  // the invitation: NTC_SM_PARTNER_USER_INVITE by e-mail through the Notice Registry (channel policy electronic_ok_without_esign — the notice is about the account, not a disclosure); the FAKE port holds it outside production
  let notice: Notice | null = null; let bounced = false; let held_reason: string | null = null;
  const rt = d.runtime;
  if (rt.ports.edelivery && rt.ports.printMail) {
    const subject = `${party.legal_name} invited you to its partner portal as ${roles.join(", ")}`;
    const real = rt.ports.edelivery;
    const edelivery: EdeliveryPort = { send: (m: EdeliveryMessage, now: string) => real.send(m.noticeId === notice?.id ? { ...m, messageId: `partner_user:${id}:invite:${m.messageId.split(":").pop() ?? "1"}`, subject } : m, now), events: (since: string) => real.events(since) };
    const notices = new NoticeService({ registry: rt.noticeRegistry, events: d.events, clock: d.clock, printMail: rt.ports.printMail, edelivery, notices: rt.noticeMemory });
    const recipient: Recipient = { partyId: id, name: name ?? "Colleague", mailingAddress: null, email: normalizeEmail(i.email) };
    notice = notices.render({ templateCode: PARTNER_INVITE_TEMPLATE, recipients: [recipient], payload: { partner_legal_name: party.legal_name, roles: roles.join(", "), sign_in_url: partnerSignInUrl(), platform_postal_address: FAKE_SERVICER_PROFILE_V1.servicer_address }, asOf: plainDate(d.now.slice(0, 10)) });
    if (notice.status === "held") held_reason = notice.heldReason ?? "held";
    else { try { const sent = await notices.send(notice.id); bounced = sent.deliveries.some((x) => x.emailStatus === "bounced"); } catch (e) { if (notice.deliveries.some((x) => x.emailStatus === "bounced")) bounced = true; else throw e; } }
    const n = notice;
    d.deferWrite(async (q) => { const nr = new PgNoticeRepository(rt.db); const t = rt.noticeRegistry.template(PARTNER_INVITE_TEMPLATE); await nr.upsertTemplate(t, q); const v = rt.noticeRegistry.activeVersion(t.code, plainDate(d.now.slice(0, 10))); if (v) await nr.saveVersion(v, q); await nr.saveNotice(n, q); });
  }
  d.deferWrite(async (q) => { if (existing) await repo.reinvite(id, { name, roles, invited_by, invited_by_actor, now: d.now }, q); else await repo.createUser({ id, partner_party_id: tenant, email_hash: hash, email_encrypted: encryptEmail(i.email, key), name, roles, invited_by, invited_by_actor, now: d.now }, q); });
  return { partner_user_id: id, partner_party_id: tenant, status: "invited", roles, reinvited: !!existing, notice_id: notice?.id ?? null, bounced, held_reason, invited_by, invited_by_actor };
}
