/**
 * Sign in with Google on the borrower API (docs/ux/15-entry-sign-up-and-sign-in.md §3, DELTA-12) — the logic behind
 * `POST /v1/borrower/auth/oidc`; the route in ./routes.ts reads the body, calls `start` / `callback`, opens the thread and
 * answers the same session body as a one-time code so the app's proxy sets the cookie exactly as for `auth/otp`.
 *
 *   start      {provider: google, redirect_uri, fake?}  → Authorization Code + PKCE (S256) on the server: an
 *              `auth_challenges{kind: oidc}` row holds the `state` (the row's `challenge`), the id-token `nonce`, sha256 of
 *              the PKCE verifier and the redirect URI (10 minutes, single use); the verifier itself is derived from the
 *              router's secret and the row (`pkceVerifier`) so it is never stored and never serialized. The redirect URI must
 *              sit under an allowed origin (BORROWER_ORIGINS / the relying party). `fake` — a canned identity — is accepted
 *              only from the FAKE provider (INTEGRATIONS=fake); anywhere else it is a 400.
 *   callback   {provider: google, code, state} → the challenge the state names (unconsumed, unexpired, same provider — else
 *              401 OIDC_INVALID) is consumed FIRST (single use: a replay, or anything that fails after this point, finds it
 *              consumed), the code is redeemed through the port, the id token's claims are checked — `iss` ∈ Google's issuers,
 *              `aud` = the client id, `exp` in the future, `nonce` = the challenge's — and `email_verified` must be true
 *              (401 OIDC_EMAIL_UNVERIFIED: no party is ever linked by an unverified e-mail). The party is resolved by
 *              (issuer, sub) in `oidc_identities` first, else by the verified e-mail through the same resolver a code uses;
 *              the identity row is stored or refreshed; the provider's `name` becomes the party's provisional legal name
 *              (prefill source oidc_google, confirmed_at null). The session opens with auth_method `oidc_google` and no
 *              `last_l1_at` — the fresh-L1 rule still asks for a code before money moves (01 §5).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import { PgBorrowerOidcRepository } from "../../infra/db/borrower-oidc.ts";
import { sha256hex, type ChallengeRow, type SessionRow } from "../../infra/db/borrower-sessions.ts";
import type { PartyRow, Subject } from "../../infra/db/borrower-parties.ts";
import { FAKE_OIDC_MARKER, FakeGoogleOidc, type FakeOidcIdentity, type OidcClaims, type OidcPort } from "../../infra/integrations/oidc.ts";
import { PermanentRejection } from "../../infra/integrations/failures.ts";
import type { Logger } from "../log.ts";
import { BorrowerAuth, minutesAfter } from "./auth.ts";
import { BorrowerError } from "./errors.ts";

export const OIDC_MINUTES = 10;
export const OIDC_PROVIDERS: readonly string[] = ["google"];
/** The PKCE verifier for a challenge row: HMAC of the row's id and state under the router's secret (43 base64url chars, RFC 7636 §4.1) — recomputed at the callback, never stored. */
export const pkceVerifier = (secret: string, challengeId: string, state: string): string => createHmac("sha256", secret).update(`oidc:${challengeId}:${state}`).digest("base64url");
export const pkceChallenge = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");
/** A redirect URI the provider may send the code back to: under an allowed origin, or on the relying party's host (the app at /app on the API host). */
export function redirectUriAllowed(uri: string, allowedOrigins: readonly string[], rpId: string): boolean {
  let u: URL; try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (allowedOrigins.includes(u.origin)) return true;
  return u.hostname === rpId || u.hostname.endsWith(`.${rpId}`);
}
/** The `fake` hint of a start request (FAKE provider only): {email, email_verified?, name?, sub?}. */
export function fakeIdentityOf(v: unknown): FakeOidcIdentity | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new RangeError("fake must be an object { email, email_verified?, name?, sub? }");
  const o = v as Record<string, unknown>;
  if (typeof o["email"] !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o["email"].trim())) throw new RangeError("fake.email must be an e-mail address");
  if (o["email_verified"] !== undefined && typeof o["email_verified"] !== "boolean") throw new RangeError("fake.email_verified must be a boolean");
  if (o["name"] !== undefined && o["name"] !== null && typeof o["name"] !== "string") throw new RangeError("fake.name must be a string");
  if (o["sub"] !== undefined && o["sub"] !== null && (typeof o["sub"] !== "string" || !o["sub"].trim())) throw new RangeError("fake.sub must be a non-empty string");
  return { email: o["email"].trim().toLowerCase(), ...(o["email_verified"] !== undefined ? { email_verified: o["email_verified"] as boolean } : {}), ...(typeof o["name"] === "string" ? { name: o["name"] } : {}), ...(typeof o["sub"] === "string" ? { sub: o["sub"].trim() } : {}) };
}
export interface VerifiedIdentity { readonly iss: string; readonly sub: string; readonly email: string | null; readonly email_verified: boolean; readonly name: string | null; }
/** 32.14 §3: `iss`, `aud`, `exp` and `nonce` are the API's checks, whatever adapter answered the claims; a failure is 401 OIDC_INVALID (the reason stays in the log). */
export function verifyIdTokenClaims(claims: OidcClaims, expected: { issuers: readonly string[]; clientId: string; nonce: string; nowMs: number }): VerifiedIdentity {
  const refuse = (why: string): never => { throw new BorrowerError(401, "OIDC_INVALID", undefined, why); };
  if (typeof claims.iss !== "string" || !expected.issuers.includes(claims.iss)) refuse(`id token iss ${String(claims.iss)} is not the provider`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expected.clientId)) refuse("id token aud is not this client");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= expected.nowMs) refuse("id token expired");
  if (typeof claims.nonce !== "string" || claims.nonce !== expected.nonce) refuse("id token nonce does not match the challenge");
  if (typeof claims.sub !== "string" || !claims.sub.trim()) refuse("id token has no sub");
  const email = typeof claims.email === "string" && claims.email.trim() ? claims.email.trim().toLowerCase() : null;
  return { iss: claims.iss, sub: claims.sub.trim(), email, email_verified: claims.email_verified === true, name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : null };
}

export interface BorrowerOidcDeps { readonly auth: BorrowerAuth; readonly ui: PgBorrowerUiRepository; readonly port: OidcPort; readonly urlSecret: string; readonly allowedOrigins: readonly string[]; readonly rpId: string; readonly logger: Logger; readonly identities?: PgBorrowerOidcRepository; }
export interface OidcStartResult { readonly provider: string; readonly challenge_id: string; readonly authorization_url: string; readonly state: string; readonly expires_at: string; readonly delivery?: "FAKE"; }
export interface OidcCallbackResult { readonly token: string; readonly session: SessionRow; readonly party: PartyRow; readonly subjects: readonly Subject[]; readonly identity: VerifiedIdentity; readonly party_created: boolean; readonly identity_created: boolean; readonly resolved_by: "subject" | "email"; readonly challenge_id: string; }
const str = (b: Record<string, unknown>, k: string): string => (typeof b[k] === "string" ? (b[k] as string).trim() : "");

export class BorrowerOidc {
  private readonly d: BorrowerOidcDeps;
  readonly identities: PgBorrowerOidcRepository;
  constructor(d: BorrowerOidcDeps) { this.d = d; this.identities = d.identities ?? new PgBorrowerOidcRepository(d.auth.sessions["db" as keyof typeof d.auth.sessions] as never); }
  get isFake(): boolean { return this.d.port instanceof FakeGoogleOidc; }
  private provider(b: Record<string, unknown>): string {
    const provider = str(b, "provider") || this.d.port.provider;
    if (!OIDC_PROVIDERS.includes(provider) || provider !== this.d.port.provider) throw new RangeError(`provider must be ${this.d.port.provider}`);
    return provider;
  }

  async start(b: Record<string, unknown>, at: string): Promise<OidcStartResult> {
    const provider = this.provider(b);
    const redirectUri = str(b, "redirect_uri");
    if (!redirectUri) throw new RangeError("redirect_uri is required");
    if (!redirectUriAllowed(redirectUri, this.d.allowedOrigins, this.d.rpId)) throw new RangeError("redirect_uri is not under an allowed origin");
    const fake = fakeIdentityOf(b["fake"]);
    if (fake && !this.isFake) throw new RangeError("a fake identity hint is accepted only from the FAKE provider (INTEGRATIONS=fake)");
    const challengeId = randomUUIDv4(); const state = randomBytes(32).toString("base64url"); const nonce = randomBytes(16).toString("hex");
    const verifier = pkceVerifier(this.d.urlSecret, challengeId, state);
    const expiresAt = minutesAfter(at, OIDC_MINUTES);
    const row = await this.d.auth.sessions.createChallenge({ challenge_id: challengeId, kind: "oidc", provider, challenge: state, nonce, code_verifier_hash: sha256hex(verifier), destination: redirectUri, delivery: this.isFake ? "FAKE" : provider, expires_at: expiresAt });
    const { authorization_url } = await this.d.port.start({ redirect_uri: redirectUri, state, nonce, code_challenge: pkceChallenge(verifier), login_hint: str(b, "login_hint") || undefined, fake }, at);
    this.d.logger.info("borrower.oidc.started", { challenge_id: row.challenge_id, provider, vendor: this.d.port.vendorName, redirect_uri: redirectUri, fake_hint: !!fake });
    return { provider, challenge_id: row.challenge_id, authorization_url, state, expires_at: expiresAt, ...(this.isFake ? { delivery: "FAKE" as const } : {}) };
  }

  async callback(b: Record<string, unknown>, i: { at: string; ip: string | null; user_agent: string | null; fake_marker?: string | undefined }): Promise<OidcCallbackResult> {
    const provider = this.provider(b);
    const code = str(b, "code"); const state = str(b, "state");
    if (!code || !state) throw new RangeError("code and state are required");
    // the FAKE provider's guard runs before anything is consumed: a dev/test caller that forgot the marker keeps its state
    if (this.isFake && i.fake_marker !== FAKE_OIDC_MARKER) throw new BorrowerError(400, "OIDC_FAKE_MARKER_REQUIRED", undefined, `the FAKE provider needs the x-fake-oidc: ${FAKE_OIDC_MARKER} header`);
    const ch = await this.d.auth.sessions.oidcChallengeByState(provider, state);
    if (!ch || ch.kind !== "oidc" || ch.provider !== provider) throw new BorrowerError(401, "OIDC_INVALID", undefined, "unknown state");
    if (ch.consumed_at) throw new BorrowerError(401, "OIDC_INVALID", undefined, "replayed state");
    await this.d.auth.sessions.consume(ch.challenge_id, i.at);   // single use, before the exchange: whatever fails below leaves it consumed
    const identity = await this.redeem(ch, code, i);
    if (!identity.email_verified || !identity.email) { this.d.logger.info("borrower.oidc.refused", { challenge_id: ch.challenge_id, reason: "email_unverified" }); throw new BorrowerError(401, "OIDC_EMAIL_UNVERIFIED", undefined, "the provider did not verify the e-mail"); }
    // the party: by the provider's stable subject first, else by the verified e-mail (the same resolver a code to that e-mail uses)
    const known = await this.identities.bySubject(identity.iss, identity.sub);
    let party: PartyRow | undefined; let partyCreated = false; let resolvedBy: "subject" | "email" = "subject";
    if (known && !known.revoked_at) party = await this.d.auth.parties.get(known.party_id);
    if (!party) { const r = await this.d.auth.parties.resolveOrCreateByDestination("email", identity.email); party = r.party; partyCreated = r.created; resolvedBy = "email"; }
    const stored = await this.identities.upsert({ party_id: party.id, issuer: identity.iss, subject: identity.sub, email: identity.email, email_verified: true, name: identity.name, now: i.at });
    if (identity.name) await this.identities.provisionalName(party.id, identity.name, i.at);
    await this.d.auth.sessions.setChallengeParty(ch.challenge_id, party.id);
    const opened = await this.d.auth.openSession({ party_id: party.id, auth_method: "oidc_google", now: i.at, otp: false, ip: i.ip, user_agent: i.user_agent });
    return { token: opened.token, session: opened.session, party: opened.party, subjects: opened.subjects, identity, party_created: partyCreated, identity_created: stored.created, resolved_by: resolvedBy, challenge_id: ch.challenge_id };
  }

  /** The code → the id token's verified claims, on a consumed challenge: expiry, the verifier's integrity, the exchange, the claim checks. */
  private async redeem(ch: ChallengeRow, code: string, i: { at: string; fake_marker?: string | undefined }): Promise<VerifiedIdentity> {
    const nowMs = Date.parse(i.at);
    if (Date.parse(ch.expires_at) <= nowMs) throw new BorrowerError(401, "OIDC_INVALID", undefined, "the sign-in took longer than 10 minutes");
    const verifier = pkceVerifier(this.d.urlSecret, ch.challenge_id, ch.challenge ?? "");
    if (!ch.code_verifier_hash || sha256hex(verifier) !== ch.code_verifier_hash || !ch.nonce) throw new BorrowerError(401, "OIDC_INVALID", undefined, "the challenge's verifier cannot be reproduced (secret rotated?)");
    let claims: OidcClaims;
    try { claims = (await this.d.port.exchange({ code, code_verifier: verifier, redirect_uri: ch.destination ?? "", fake_marker: i.fake_marker }, i.at)).claims; }
    catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.d.logger.info("borrower.oidc.exchange_failed", { challenge_id: ch.challenge_id, vendor: this.d.port.vendorName, code: e instanceof PermanentRejection ? e.code : "exchange_failed", reason: why });
      if (e instanceof PermanentRejection && e.code === "OIDC_FAKE_MARKER_REQUIRED") throw new BorrowerError(400, "OIDC_FAKE_MARKER_REQUIRED", undefined, why);
      throw new BorrowerError(401, "OIDC_INVALID", undefined, why);
    }
    return verifyIdTokenClaims(claims, { issuers: this.d.port.issuers, clientId: this.d.port.clientId, nonce: ch.nonce, nowMs });
  }
}
const randomUUIDv4 = (): string => { const b = randomBytes(16); b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80; const h = b.toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
