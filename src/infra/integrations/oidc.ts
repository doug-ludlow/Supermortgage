/**
 * OpenID Connect sign-in — the port behind Sign in with Google (docs/ux/15-entry-sign-up-and-sign-in.md §3, DELTA-12).
 * Authorization Code + PKCE (S256) on the server: the borrower API mints the `state`, `nonce` and code challenge and keeps
 * them on an `auth_challenges{kind=oidc}` row; the port only talks to the provider.
 *
 *   start      the provider's authorization URL for that state / nonce / code challenge (the app navigates there)
 *   exchange   redeems the returned `code` with the PKCE verifier and answers the id token's claims with the SIGNATURE
 *              verified. The claim checks — `iss`, `aud`, `exp`, `nonce`, `email_verified` — are the API's
 *              (src/runtime/borrower/oidc.ts) so both adapters are held to the same rules.
 *
 *   FakeGoogleOidc      INTEGRATIONS=fake — the only provider then, named FAKE. The "authorization URL" is the app's own
 *                       callback with a `code` that carries the canned identity the start request hinted (`fake`) bound to
 *                       the challenge's nonce, so the round trip is exercised end to end without Google; the exchange is
 *                       refused unless the `x-fake-oidc: FAKE` marker rides along (the app sends it in fake/dev mode only).
 *   GoogleOidcAdapter   the real thing: discovery document, token endpoint, a JWKS cache refreshed on an unknown key id;
 *                       RS256 through node:crypto (the same verifier src/runtime/borrower/webauthn.ts uses for passkeys).
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PermanentRejection, TransientFailure } from "./failures.ts";

export interface OidcClaims {
  readonly iss: string; readonly sub: string; readonly aud: string | readonly string[]; readonly exp: number; readonly iat?: number | undefined; readonly nonce?: string | undefined;
  readonly email?: string | undefined; readonly email_verified?: boolean | undefined; readonly name?: string | undefined; readonly [claim: string]: unknown;
}
/** The canned identity a FAKE sign-in starts with (the app's tiny FAKE identity form; a test's fixture). */
export interface FakeOidcIdentity { readonly email: string; readonly email_verified?: boolean; readonly name?: string; readonly sub?: string; }
export interface OidcStartInput { readonly redirect_uri: string; readonly state: string; readonly nonce: string; readonly code_challenge: string; readonly login_hint?: string | undefined; readonly fake?: FakeOidcIdentity | undefined; }
export interface OidcExchangeInput { readonly code: string; readonly code_verifier: string; readonly redirect_uri: string; /** the `x-fake-oidc` header (FAKE only) */ readonly fake_marker?: string | undefined; }
export interface OidcPort {
  readonly vendorName: string;
  readonly provider: "google";
  /** `aud` the id token must name. */
  readonly clientId: string;
  /** `iss` values the id token may name. */
  readonly issuers: readonly string[];
  start(i: OidcStartInput, now: string): Promise<{ authorization_url: string }>;
  exchange(i: OidcExchangeInput, now: string): Promise<{ claims: OidcClaims }>;
}

export const GOOGLE_ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];
export const GOOGLE_SCOPES = "openid email profile";
export const FAKE_OIDC_MARKER = "FAKE";
export const FAKE_OIDC_CODE_PREFIX = "FAKE.";
const b64url = { encode: (b: Buffer | string): string => Buffer.from(b).toString("base64url"), decode: (s: string): Buffer => Buffer.from(s, "base64url") };
/** A stable, Google-shaped subject (21 digits) for a canned e-mail. */
export const fakeOidcSubject = (email: string): string => BigInt(`0x${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16)}`).toString().padStart(21, "1").slice(0, 21);
/** The FAKE authorization code: the canned claims, bound to the challenge's nonce. Exported so a test can forge a code whose nonce does not match. */
export function fakeOidcCode(identity: FakeOidcIdentity, nonce: string, now: string, ttlSeconds = 3600): string {
  const iat = Math.floor(Date.parse(now) / 1000);
  const claims = { sub: identity.sub ?? fakeOidcSubject(identity.email), email: identity.email.trim().toLowerCase(), email_verified: identity.email_verified ?? true, name: identity.name ?? null, nonce, iat, exp: iat + ttlSeconds };
  return `${FAKE_OIDC_CODE_PREFIX}${b64url.encode(JSON.stringify(claims))}`;
}

export class FakeGoogleOidc implements OidcPort {
  readonly vendorName = "FAKE";
  readonly provider = "google" as const;
  readonly clientId = "FAKE-google-oauth-client-id";
  readonly issuers = GOOGLE_ISSUERS;
  /** The identity a start without a `fake` hint signs in as. */
  readonly canned: FakeOidcIdentity = { email: "fake.borrower@example.test", email_verified: true, name: "FAKE Borrower" };
  readonly starts: { state: string; email: string; at: string }[] = [];
  private readonly log: ((line: string) => void) | undefined;
  constructor(log?: (line: string) => void) { this.log = log; }
  async start(i: OidcStartInput, now: string): Promise<{ authorization_url: string }> {
    const identity = i.fake ?? this.canned;
    const u = new URL(i.redirect_uri);
    u.searchParams.set("code", fakeOidcCode(identity, i.nonce, now)); u.searchParams.set("state", i.state); u.searchParams.set("scope", GOOGLE_SCOPES); u.searchParams.set("fake", FAKE_OIDC_MARKER);
    this.starts.push({ state: i.state, email: identity.email, at: now });
    this.log?.(`FAKE google oidc start state=${i.state} email=${identity.email}`);
    return { authorization_url: u.toString() };
  }
  async exchange(i: OidcExchangeInput, now: string): Promise<{ claims: OidcClaims }> {
    if (i.fake_marker !== FAKE_OIDC_MARKER) throw new PermanentRejection("OIDC_FAKE_MARKER_REQUIRED", `the FAKE provider redeems a code only with the x-fake-oidc: ${FAKE_OIDC_MARKER} marker`);
    if (!i.code.startsWith(FAKE_OIDC_CODE_PREFIX)) throw new PermanentRejection("OIDC_CODE_INVALID", "not a FAKE authorization code");
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(b64url.decode(i.code.slice(FAKE_OIDC_CODE_PREFIX.length)).toString("utf8")) as Record<string, unknown>; } catch { throw new PermanentRejection("OIDC_CODE_INVALID", "malformed FAKE authorization code"); }
    if (typeof parsed["sub"] !== "string" || typeof parsed["email"] !== "string" || typeof parsed["exp"] !== "number") throw new PermanentRejection("OIDC_CODE_INVALID", "malformed FAKE authorization code");
    if (typeof i.code_verifier !== "string" || i.code_verifier.length < 43) throw new PermanentRejection("OIDC_PKCE_INVALID", "a PKCE code_verifier is required");
    this.log?.(`FAKE google oidc exchange sub=${String(parsed["sub"])} at=${now}`);
    return { claims: { iss: GOOGLE_ISSUERS[0]!, aud: this.clientId, sub: parsed["sub"], email: parsed["email"], email_verified: parsed["email_verified"] === true, name: typeof parsed["name"] === "string" ? parsed["name"] : undefined, nonce: typeof parsed["nonce"] === "string" ? parsed["nonce"] : undefined, iat: typeof parsed["iat"] === "number" ? parsed["iat"] : undefined, exp: parsed["exp"] } };
  }
}

// ───────────────────────────── the real adapter
interface Discovery { readonly authorization_endpoint: string; readonly token_endpoint: string; readonly jwks_uri: string; readonly issuer?: string }
interface Jwk { readonly kid?: string; readonly kty: string; readonly alg?: string; readonly use?: string; readonly n?: string; readonly e?: string }
export const GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration";
type Fetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export class GoogleOidcAdapter implements OidcPort {
  readonly vendorName = "google";
  readonly provider = "google" as const;
  readonly clientId: string;
  readonly issuers = GOOGLE_ISSUERS;
  private readonly clientSecret: string;
  private readonly discoveryUrl: string;
  private readonly fetchFn: Fetch;
  private discovery: Discovery | null = null;
  private jwks: { keys: readonly Jwk[]; fetched_at: number } | null = null;
  /** A JWKS is re-read after this long, or at once on an unknown key id (Google rotates keys). */
  jwksTtlMs = 6 * 3_600_000;
  constructor(i: { clientId: string; clientSecret: string; discoveryUrl?: string; fetch?: Fetch }) {
    if (!i.clientId || !i.clientSecret) throw new RangeError("GoogleOidcAdapter needs the OAuth client id and secret (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)");
    this.clientId = i.clientId; this.clientSecret = i.clientSecret; this.discoveryUrl = i.discoveryUrl ?? GOOGLE_DISCOVERY_URL; this.fetchFn = i.fetch ?? ((input, init) => fetch(input, init));
  }
  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const r = await this.fetchFn(this.discoveryUrl).catch((e: unknown) => { throw new TransientFailure("google oidc discovery unreachable", e); });
    if (!r.ok) throw new TransientFailure(`google oidc discovery answered ${r.status}`);
    const d = (await r.json()) as Partial<Discovery>;
    if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new PermanentRejection("OIDC_DISCOVERY_INVALID", "the discovery document lacks authorization_endpoint / token_endpoint / jwks_uri");
    this.discovery = { authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri, ...(d.issuer ? { issuer: d.issuer } : {}) };
    return this.discovery;
  }
  private async keys(nowMs: number, force = false): Promise<readonly Jwk[]> {
    if (!force && this.jwks && nowMs - this.jwks.fetched_at < this.jwksTtlMs) return this.jwks.keys;
    const d = await this.discover();
    const r = await this.fetchFn(d.jwks_uri).catch((e: unknown) => { throw new TransientFailure("google jwks unreachable", e); });
    if (!r.ok) throw new TransientFailure(`google jwks answered ${r.status}`);
    const j = (await r.json()) as { keys?: Jwk[] };
    this.jwks = { keys: j.keys ?? [], fetched_at: nowMs };
    return this.jwks.keys;
  }
  async start(i: OidcStartInput, _now: string): Promise<{ authorization_url: string }> {
    const d = await this.discover();
    const u = new URL(d.authorization_endpoint);
    const params: Record<string, string> = { client_id: this.clientId, response_type: "code", scope: GOOGLE_SCOPES, redirect_uri: i.redirect_uri, state: i.state, nonce: i.nonce, code_challenge: i.code_challenge, code_challenge_method: "S256", access_type: "online", prompt: "select_account", ...(i.login_hint ? { login_hint: i.login_hint } : {}) };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return { authorization_url: u.toString() };
  }
  async exchange(i: OidcExchangeInput, now: string): Promise<{ claims: OidcClaims }> {
    const d = await this.discover();
    const body = new URLSearchParams({ grant_type: "authorization_code", code: i.code, code_verifier: i.code_verifier, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: i.redirect_uri }).toString();
    const r = await this.fetchFn(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body }).catch((e: unknown) => { throw new TransientFailure("google token endpoint unreachable", e); });
    if (r.status >= 500) throw new TransientFailure(`google token endpoint answered ${r.status}`);
    const j = (await r.json()) as { id_token?: unknown; error?: unknown; error_description?: unknown };
    if (!r.ok || typeof j.id_token !== "string") throw new PermanentRejection("OIDC_CODE_INVALID", `the code was not redeemed: ${String(j.error ?? r.status)}${j.error_description ? ` — ${String(j.error_description)}` : ""}`);
    return { claims: await this.verifyIdToken(j.id_token, Date.parse(now)) };
  }
  /** RS256 over `header.payload` against Google's JWKS (kid); the claims are answered for the API's own checks. The token itself never leaves this method. */
  async verifyIdToken(idToken: string, nowMs: number): Promise<OidcClaims> {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new PermanentRejection("OIDC_TOKEN_INVALID", "the id token is not a compact JWS");
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string }; let payload: OidcClaims;
    try { header = JSON.parse(b64url.decode(h).toString("utf8")) as { alg?: string; kid?: string }; payload = JSON.parse(b64url.decode(p).toString("utf8")) as OidcClaims; } catch { throw new PermanentRejection("OIDC_TOKEN_INVALID", "the id token does not decode"); }
    if (header.alg !== "RS256") throw new PermanentRejection("OIDC_TOKEN_INVALID", `id token alg ${String(header.alg)} is not RS256`);
    let jwk = (await this.keys(nowMs)).find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) jwk = (await this.keys(nowMs, true)).find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) throw new PermanentRejection("OIDC_TOKEN_INVALID", `no JWKS key ${String(header.kid)}`);
    const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e } as never, format: "jwk" });
    if (!cryptoVerify("sha256", Buffer.from(`${h}.${p}`), key, b64url.decode(s))) throw new PermanentRejection("OIDC_TOKEN_INVALID", "the id token signature did not verify");
    return payload;
  }
}
