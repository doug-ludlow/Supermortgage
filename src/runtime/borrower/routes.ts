/**
 * The borrower API (docs/ux/02-data-contracts.md §7) — the first half: identity and the document seam.
 *
 *   POST /v1/borrower/auth/otp                    { action: "request", channel: sms|email, destination }  → { challenge_id, delivery, expires_at, fake_code? }
 *                                                 { action: "verify", challenge_id, code }               → L1 session { token, session, party, level }; with a bearer: refreshes that session's fresh-L1 instead
 *   POST /v1/borrower/auth/account                32.16 DELTA-29, e-mail + password: { action: "create", email, password } → the e-mail code { challenge_id, delivery, expires_at, fake_code? }
 *                                                 { action: "verify_email", challenge_id, code } → L1 session (auth_method password; the party's organic application and the goal card follow)
 *                                                 { action: "sign_in", email, password } → L1 session | 401 PASSWORD_WRONG | 423 ACCOUNT_LOCKED | 403 EMAIL_UNVERIFIED {challenge_id, fake_code?}
 *                                                 { action: "request_reset", email } → { ok } (+ challenge_id / fake_code when the e-mail exists — never whether it does)
 *                                                 { action: "reset", challenge_id, code, password } → { ok }   (ACCOUNT_PER_HOUR per IP on create / sign_in)
 *   POST /v1/borrower/auth/passkey                { action: "register_options" | "register" | "assert_options" | "assert", … }  (WebAuthn; server-side verifier in ./webauthn.ts)
 *   POST /v1/borrower/auth/l2                     { ssn_last4, date_of_birth } matched against application_borrowers → L2
 *   POST /v1/borrower/identity/stripe/session     { application_id? } → ConnectCard + vendor session (FakeStripeIdentity) → L3 on the webhook
 *   POST /v1/webhooks/stripe                      vendor webhook (stripe-signature) → 22.6 verifyIdentity through the bus, prefill source=stripe_identity, sessions → L3
 *   POST /v1/webhooks/sms                         telephony webhook (x-fake-telephony: FAKE) { from, to, text, message_sid } → 32.14 §4: an unknown number starts a 20.3 lead keyed to it
 *                                                 (lead.start{channel: sms}; the disclosure is the first outbound text), replies are the S1 chips (lead.answer), the identity code goes to that number (./channels.ts)
 *   POST /v1/webhooks/voice                       telephony webhook { from, to, call_sid, digits?, speech? } → lead.start{channel: voice_inbound}; the spoken disclosure first; the code is texted to the caller; consents never by voice
 *   GET  /v1/borrower/me                          → { party, level, session, subjects[] }
 *   GET  /v1/borrower/deeplink/{token}            → target after L1 (7-day expiry; the token never encodes loan data)
 *   POST /v1/borrower/documents                   multipart (file, application_id, document_class?) → 22.1 ingestDocument → { document_id, status, … }
 *   GET  /v1/borrower/documents/{id}              → signed short-lived URL bound to the session; ui_events document_opened
 *   GET  /v1/borrower/documents/{id}/content      the bytes behind the signed URL (same session; exp + sig)
 *
 * Every response goes through ./serialize.ts (allow-listed shapes); every refusal is `{code, gate?, copy_key}` (./errors.ts).
 * Borrower sessions are the only credential here — the API_TOKEN of the ops routes is never accepted on /v1/borrower/*.
 */
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Runtime } from "../app.ts";
import type { Logger } from "../log.ts";
import { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import { normalizeDestination } from "../../infra/db/borrower-parties.ts";
import { hashCode, type ChallengeRow, type SessionRow } from "../../infra/db/borrower-sessions.ts";
import { DUMMY_PASSWORD_HASH, PgBorrowerCredentialRepository, isEmail, normalizeEmail } from "../../infra/db/borrower-credentials.ts";
import { FakeEdelivery, type EdeliveryPort, type TelephonyWebhookPort } from "../../infra/integrations/delivery.ts";
import { FakeGoogleOidc, type OidcPort } from "../../infra/integrations/oidc.ts";
import { PgBorrowerOidcRepository } from "../../infra/db/borrower-oidc.ts";
import { DOCUMENT_CLASSES } from "../../domain/verification/ops-22-1.ts";
import { isUuid, toJson } from "../../infra/db/client.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { BorrowerAuth, OTP_MAX_ATTEMPTS, OTP_MINUTES, assertSubject, bearerOf, hasFreshL1, minutesAfter, type BorrowerContext } from "./auth.ts";
import { BorrowerError, toBorrowerError } from "./errors.ts";
import { serialize, type ShapeName } from "./serialize.ts";
import { b64url, sha256, verifyAssertion, verifyRegistration } from "./webauthn.ts";
import { FakeStripeIdentity, type StripeIdentityPort } from "./vendors/fake-stripe-identity.ts";
import { FakeBlobStore, type BlobStorePort } from "./vendors/fake-blob-store.ts";
import { FakeTruv, type IncomeConnectPort } from "./vendors/fake-truv.ts";
import { BorrowerRecordReader } from "./record.ts";
import { BorrowerStreamHub } from "./stream.ts";
import { BorrowerCommands } from "./commands.ts";
import { BorrowerOidc } from "./oidc.ts";
import { createTalkRoutes, TALK_PATH, type TalkOptions, type TalkRoutes } from "./talk.ts";
import { createBorrowerChannels, type BorrowerChannels } from "./channels.ts";
import { BorrowerFlows } from "./flows/index.ts";
import { createLeadRoutes } from "./lead-routes.ts";
import { ensureOrganicApplication } from "./flows/14-entry-lead.ts";
import { connectorFailed } from "./flows/13-cross-cutting.ts";
import type { CardInstanceRow } from "../../infra/db/borrower-ui.ts";

export interface BorrowerRouterOptions {
  readonly runtime: Runtime;
  readonly logger: Logger;
  /** `production` disables the FAKE code echo; anything else (nonprod, test) is a non-production environment. */
  readonly environment?: string;
  readonly rpId?: string;
  readonly allowedOrigins?: readonly string[];
  readonly stripe?: StripeIdentityPort;
  readonly blobs?: BlobStorePort;
  /** 32.3 R3: the payroll connector (FakeTruv unless a real adapter is wired). */
  readonly truv?: IncomeConnectPort;
  /** Talk (talk.ts): the conversational entry's model — ANTHROPIC_API_KEY / TALK_MODEL from the environment when unset. */
  readonly talk?: TalkOptions | undefined;
  /** HMAC key for signed document URLs; random per process when unset (URLs then die with the process, which is fine for short-lived links). */
  readonly urlSecret?: string;
  readonly returnUrlBase?: string;
  /** 32.14 DELTA-12: Sign in with Google — the runtime's `oidc` port (FakeGoogleOidc under INTEGRATIONS=fake) unless a caller wires one. */
  readonly oidc?: OidcPort;
  /** 32.14 DELTA-15: the Phase I partner party id (`BORROWER_DEFAULT_PARTNER_ID`) the organic entry names when no application names one. */
  readonly defaultPartnerId?: string;
  /** 32.14 §4: the telephony vendor's inbound webhook adapter for /v1/webhooks/sms and /v1/webhooks/voice (FakeTelephonyWebhooks unless a real one is wired). */
  readonly telephonyWebhooks?: TelephonyWebhookPort;
}
export interface BorrowerRouter {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
  readonly auth: BorrowerAuth;
  readonly ui: PgBorrowerUiRepository;
  readonly stripe: StripeIdentityPort;
  readonly blobs: BlobStorePort;
  readonly truv: IncomeConnectPort;
  readonly hub: BorrowerStreamHub;
  readonly commands: BorrowerCommands;
  readonly reader: BorrowerRecordReader;
  /** The 32.x flows (src/runtime/borrower/flows): event → card, plus the scheduled `tick`. */
  readonly flows?: BorrowerFlows;
  /** 32.14 DELTA-12: the OpenID Connect provider behind /auth/oidc (FAKE unless a real adapter is wired). */
  readonly oidc: OidcPort;
  /** 32.14 §4: SMS and voice entry on the same lead (src/runtime/borrower/channels.ts) — the two telephony webhooks and the number → lead key. */
  readonly talk: TalkRoutes;
  readonly channels: BorrowerChannels;
}

const MAX_BODY = 32 * 1024 * 1024;
export const DOCUMENT_URL_MINUTES = 5;
/** 32.16 DELTA-29: the per-IP throttle on account creation and password sign-in (in memory, best effort across instances — the lead route's pattern). */
export const ACCOUNT_PER_HOUR = 20;
/** 32.16 §2.0: a password is at least eight characters (the only strength rule the API states). */
export const PASSWORD_MIN_LENGTH = 8;
const SYSTEM_ACTOR = { kind: "system" as const, id: "borrower-api" };
const WEBHOOK_ACTOR = { kind: "system" as const, id: "stripe-identity-webhook" };
/** 02 §1.4: the document families a borrower may open (own-only families need the party's own application_borrowers row as subject). */
const VISIBLE_FAMILIES: Readonly<Record<string, "own_only" | "shared">> = { identity: "own_only", income_employment: "own_only", assets: "own_only", letters: "own_only", insurance: "shared", hoa_project: "shared" };
const RENDERED_KINDS = new Set(["notice", "disclosure", "rendered_notice", "rendered_disclosure"]);

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new RangeError(`request body over ${MAX_BODY} bytes`); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
const jsonOf = (b: Buffer): Record<string, unknown> => { if (!b.length) return {}; const v = JSON.parse(b.toString("utf8")) as unknown; if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError("request body must be a JSON object"); return v as Record<string, unknown>; };
const str = (b: Record<string, unknown>, k: string): string => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
const need = (b: Record<string, unknown>, ...keys: string[]): void => { for (const k of keys) if (!str(b, k)) throw new RangeError(`${k} is required`); };

/** multipart/form-data → fields and one file (`file`), without a dependency. */
export interface MultipartFile { readonly field: string; readonly filename: string | null; readonly mime_type: string; readonly bytes: Buffer; }
export function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; files: MultipartFile[] } {
  const m = /boundary="?([^";]+)"?/i.exec(contentType); if (!m) throw new RangeError("multipart/form-data needs a boundary");
  const delim = Buffer.from(`--${m[1]!}`); const fields: Record<string, string> = {}; const files: MultipartFile[] = [];
  let pos = body.indexOf(delim); if (pos < 0) throw new RangeError("multipart: boundary not found");
  pos += delim.length;
  for (;;) {
    if (body.subarray(pos, pos + 2).toString() === "--") break;
    if (body.subarray(pos, pos + 2).toString() === "\r\n") pos += 2;
    const headEnd = body.indexOf("\r\n\r\n", pos); if (headEnd < 0) throw new RangeError("multipart: part without headers");
    const headers = body.subarray(pos, headEnd).toString("utf8").split("\r\n");
    const next = body.indexOf(delim, headEnd + 4); if (next < 0) throw new RangeError("multipart: unterminated part");
    let content = body.subarray(headEnd + 4, next); if (content.subarray(-2).toString() === "\r\n") content = content.subarray(0, -2);
    const disp = headers.find((h) => /^content-disposition:/i.test(h)) ?? "";
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1] ?? ""; const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    const ctype = (headers.find((h) => /^content-type:/i.test(h)) ?? "").replace(/^content-type:\s*/i, "").trim();
    if (filename !== undefined) files.push({ field: name, filename: filename || null, mime_type: ctype || "application/octet-stream", bytes: Buffer.from(content) });
    else fields[name] = content.toString("utf8");
    pos = next + delim.length;
  }
  return { fields, files };
}

export function createBorrowerRouter(opts: BorrowerRouterOptions): BorrowerRouter {
  const { runtime, logger } = opts;
  const environment = opts.environment ?? process.env["ENVIRONMENT"] ?? "nonprod";
  const nonProduction = environment !== "production" && environment !== "prod";
  const rpId = opts.rpId ?? process.env["BORROWER_RP_ID"] ?? "localhost";
  const allowedOrigins = opts.allowedOrigins ?? (process.env["BORROWER_ORIGINS"] ? process.env["BORROWER_ORIGINS"].split(",").map((s) => s.trim()) : []);
  const stripe = opts.stripe ?? new FakeStripeIdentity((line) => logger.info("vendor", line));
  const blobs = opts.blobs ?? new FakeBlobStore();
  const urlSecret = opts.urlSecret ?? process.env["BORROWER_URL_SECRET"] ?? randomBytes(32).toString("hex");
  const returnUrlBase = opts.returnUrlBase ?? process.env["BORROWER_APP_URL"] ?? "https://app.supermortgage.example";
  const auth = new BorrowerAuth(runtime.db);
  const credentials = new PgBorrowerCredentialRepository(runtime.db);   // 32.16 DELTA-29
  const ui = new PgBorrowerUiRepository(runtime.db);
  const reader = new BorrowerRecordReader(runtime.db);
  const hub = new BorrowerStreamHub(runtime.db);
  const commands = new BorrowerCommands(runtime, ui);
  // 02 §3: the stream is fed from the event store after each unit of work commits — the runtime's post-commit hook, in-process
  runtime.onCommitted((events) => { hub.publish(events).catch((e) => logger.error("borrower.stream.publish", { error: e })); });
  // the 32.x flows react to the same post-commit feed: the owning processes' events become the cards the borrower sees (src/runtime/borrower/flows)
  const defaultPartnerId = (opts.defaultPartnerId ?? process.env["BORROWER_DEFAULT_PARTNER_ID"] ?? "").trim() || undefined;   // 32.14 DELTA-15
  const flows = new BorrowerFlows({ runtime, ui, logger, blobs, defaultPartnerId }); flows.start();
  // 32.14 DELTA-11: the anonymous minute (POST /v1/borrower/lead, no session) and the lead→party link at verify (src/runtime/borrower/lead-routes.ts)
  const leads = createLeadRoutes({ runtime, logger, flows, defaultPartnerId });
  // 32.14 DELTA-12: Sign in with Google — the runtime's oidc port (the FAKE provider under INTEGRATIONS=fake); the PKCE verifier is derived from the router's secret
  const oidcPort: OidcPort = opts.oidc ?? runtime.ports.oidc ?? new FakeGoogleOidc((line) => logger.info("vendor", { line }));
  const oidcAuth = new BorrowerOidc({ auth, ui, port: oidcPort, urlSecret, allowedOrigins, rpId, logger, identities: new PgBorrowerOidcRepository(runtime.db) });
  commands.flows = flows;   // 32.3: a message a flow answers itself (T2, P9) comes before the generic reply
  const truv = opts.truv ?? new FakeTruv((line) => logger.info("vendor", line));
  const VERIFICATION_ACTOR = { kind: "agent" as const, id: "verification" };
  const now = (): string => runtime.clock.now();
  const edelivery: EdeliveryPort | undefined = runtime.ports.edelivery;
  const deliveryIsFake = (): boolean => !edelivery || edelivery instanceof FakeEdelivery;
  // 32.14 §4: SMS and voice entry on the same lead — the telephony vendor's inbound webhooks (./channels.ts; the FAKE adapter unless a real one is wired)
  const channels = createBorrowerChannels({ runtime, logger, auth, ui, flows, commands, telephony: opts.telephonyWebhooks, nonProduction, defaultPartnerId });
  // Talk: the anonymous minute and sign-in as one conversation with Claude on the same tools (./talk.ts); 503 TALK_NOT_CONFIGURED without the key
  const talk = createTalkRoutes({ runtime, logger, auth, ui, flows, commands, leads, nonProduction, defaultPartnerId, talk: opts.talk });

  const send = (res: ServerResponse, status: number, shape: ShapeName, body: unknown): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(toJson(serialize(shape, body))); };
  const sessionBody = (r: { token: string; session: SessionRow; party: { id: string; party_type: string; legal_name: string } }) =>
    ({ token: r.token, level: r.session.level, session: { ...r.session, fresh_l1: hasFreshL1(r.session, now()) }, party: { party_id: r.party.id, party_type: r.party.party_type, display_name: r.party.legal_name, first_name: r.party.legal_name.split(" ")[0] } });
  const signUrl = (sessionId: string, documentId: string, exp: string): string => createHmac("sha256", urlSecret).update(`${sessionId}:${documentId}:${exp}`).digest("base64url");
  const sixDigits = (): string => randomInt(0, 1_000_000).toString().padStart(6, "0");
  /** A six-digit code on a challenge row (kind otp | email_verify | password_reset) carried by the platform's e-delivery adapter — the FakeEdelivery test double under INTEGRATIONS=fake, marked FAKE and echoed outside production. */
  async function issueCode(i: { kind: "otp" | "email_verify" | "password_reset"; channel: "sms" | "email"; destination: string; party_id?: string | null; at: string; subject: string }): Promise<{ challenge: ChallengeRow; code: string; delivery_ref: string | null; expires_at: string }> {
    const code = sixDigits(); const expires_at = minutesAfter(i.at, OTP_MINUTES);
    const challenge = await auth.sessions.createChallenge({ kind: i.kind, channel: i.channel, destination: i.destination, party_id: i.party_id ?? null, code, expires_at, delivery: deliveryIsFake() ? "FAKE" : i.channel });
    let delivery_ref: string | null = null;
    if (edelivery) { const r = await edelivery.send({ messageId: `${i.kind}:${challenge.challenge_id}`, noticeId: `${i.kind}:${challenge.challenge_id}`, channel: i.channel, to: i.destination, subject: i.subject, consentId: "policy:authentication_otp" }, i.at); delivery_ref = r.messageId; }
    return { challenge, code, delivery_ref, expires_at };
  }
  /** The FAKE code echo: only when the delivery is the test double and the environment is not production. */
  const fakeCodeOf = (code: string): { fake_code?: string } => (deliveryIsFake() && nonProduction ? { fake_code: code } : {});
  /** The code checks every kind shares (OTP verify's): unknown / consumed → OTP_INVALID, expired → OTP_EXPIRED, over OTP_MAX_ATTEMPTS → OTP_TOO_MANY_ATTEMPTS, wrong → OTP_INVALID; a match consumes the row. */
  async function checkCode(kind: ChallengeRow["kind"], challengeId: string, code: string, at: string): Promise<ChallengeRow> {
    const ch = await auth.sessions.challenge(challengeId);
    if (!ch || ch.kind !== kind || ch.consumed_at) throw new BorrowerError(401, "OTP_INVALID");
    if (Date.parse(ch.expires_at) <= Date.parse(at)) throw new BorrowerError(401, "OTP_EXPIRED");
    const attempts = await auth.sessions.bumpAttempts(ch.challenge_id);
    if (attempts > OTP_MAX_ATTEMPTS) throw new BorrowerError(429, "OTP_TOO_MANY_ATTEMPTS");
    if (ch.code_hash !== hashCode(ch.challenge_id, code)) throw new BorrowerError(401, "OTP_INVALID");
    await auth.sessions.consume(ch.challenge_id, at);
    return ch;
  }
  /**
   * What every L1 sign-in does once the session row exists, in this order: the conversation, the lead behind the cookie (32.14 DELTA-11), then — through an
   * ACCOUNT door only (e-mail + password, Continue with Google: 32.16 §2.0 / §8 Phase 0 "anyone can create an account and land in a thread that says the
   * disclosure and asks the goal") — the party's organic application when it has no subject, no lead of its own and no lead cookie (32.16 DELTA-29
   * `ensureOrganicApplication`, so 3-entry's E3 asks the goal), then `flows.sessionOpened` (32.3 E1/E2: the disclosure is the first assistant content).
   * A one-time code is not an account door: a code sign-in on a fresh e-mail stays a lead-stage party (32.3 T15, 32.14 DELTA-16 — unchanged).
   */
  async function landSession(req: IncomingMessage, opened: { session: SessionRow; party: { id: string } }, at: string, channel: "app" | "sms", door: "account" | "code"): Promise<void> {
    await ui.conversationFor(opened.party.id);
    const lead_id = await leads.linkAtVerify(req, opened.party.id, at);
    if (door === "account") {
      const organic = await ensureOrganicApplication({ runtime, ui, logger, blobs, defaultPartnerId }, { party_id: opened.party.id, lead_id, at, session_id: opened.session.session_id });
      if (organic.created) logger.info("borrower.session.organic_application", { session_id: opened.session.session_id, party_id: opened.party.id, application_id: organic.application_id, lead_id: organic.lead_id });
    }
    await flows.sessionOpened({ party_id: opened.party.id, session_id: opened.session.session_id, channel, auth_method: opened.session.auth_method, at, lead_id });
  }
  /**
   * 32.16 §2.0 / 01 §5: a money command refused for want of a fresh code sends one — to the mobile when one is on file (verified by a code when it was
   * attached), else to the e-mail — on the session's party, so the app's "we just sent one" (`auth.fresh_code`) is true. The refusal itself is unchanged.
   */
  async function sendFreshL1Code(req: IncomingMessage, at: string): Promise<void> {
    const token = bearerOf(req); if (!token) return;
    const session = await auth.sessions.byToken(token); if (!session || session.revoked_at) return;
    const party = await auth.parties.get(session.party_id); if (!party) return;
    const phone = typeof party.contact["phone"] === "string" ? (party.contact["phone"] as string) : null; const email = typeof party.contact["email"] === "string" ? (party.contact["email"] as string) : null;
    const channel: "sms" | "email" | null = phone ? "sms" : email ? "email" : null; const destination = phone ?? email; if (!channel || !destination) return;
    const r = await issueCode({ kind: "otp", channel, destination, party_id: party.id, at, subject: "Your Supermortgage code" });
    logger.info("borrower.fresh_l1.code_sent", { session_id: session.session_id, challenge_id: r.challenge.challenge_id, channel, delivery: r.challenge.delivery, delivery_ref: r.delivery_ref });
  }
  const sameSig = (a: string, b: string): boolean => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  // ───────────────────────────── OTP (L1)
  async function otp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = jsonOf(await readBody(req)); const action = str(b, "action") || "request"; const at = now();
    if (action === "request") {
      const channel = str(b, "channel"); need(b, "destination");
      if (channel !== "sms" && channel !== "email") throw new RangeError("channel must be sms or email");
      const destination = normalizeDestination(channel, str(b, "destination"));
      if (channel === "email" ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destination) : !/^\+\d{10,15}$/.test(destination)) throw new RangeError(`destination is not a valid ${channel === "email" ? "e-mail address" : "phone number"}`);
      const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
      const expiresAt = minutesAfter(at, OTP_MINUTES);
      const challenge = await auth.sessions.createChallenge({ kind: "otp", channel, destination, code, expires_at: expiresAt, delivery: deliveryIsFake() ? "FAKE" : channel });
      // the platform's e-delivery adapter carries the code (SMS or e-mail); with INTEGRATIONS=fake that adapter is the FakeEdelivery test double — marked FAKE in the response
      let deliveryRef: string | null = null;
      if (edelivery) { const r = await edelivery.send({ messageId: `otp:${challenge.challenge_id}`, noticeId: `otp:${challenge.challenge_id}`, channel: channel === "sms" ? "sms" : "email", to: destination, subject: "Your Supermortgage sign-in code", consentId: "policy:authentication_otp" }, at); deliveryRef = r.messageId; }
      logger.info("borrower.otp.requested", { challenge_id: challenge.challenge_id, channel, delivery: challenge.delivery, delivery_ref: deliveryRef, vendor: deliveryIsFake() ? "FAKE" : "e-delivery" });
      send(res, 200, "otp_request", { challenge_id: challenge.challenge_id, channel, delivery: challenge.delivery, expires_at: expiresAt, ...(deliveryIsFake() && nonProduction ? { fake_code: code } : {}) });
      return;
    }
    if (action === "verify") {
      need(b, "challenge_id", "code");
      const ch = await auth.sessions.challenge(str(b, "challenge_id"));
      if (!ch || ch.kind !== "otp" || ch.consumed_at) throw new BorrowerError(401, "OTP_INVALID");
      if (Date.parse(ch.expires_at) <= Date.parse(at)) throw new BorrowerError(401, "OTP_EXPIRED");
      const attempts = await auth.sessions.bumpAttempts(ch.challenge_id);
      if (attempts > OTP_MAX_ATTEMPTS) throw new BorrowerError(429, "OTP_TOO_MANY_ATTEMPTS");
      if (ch.code_hash !== hashCode(ch.challenge_id, str(b, "code"))) throw new BorrowerError(401, "OTP_INVALID");
      await auth.sessions.consume(ch.challenge_id, at);
      const channel = ch.channel!; const destination = ch.destination!;
      // a live session presenting a fresh code: the fresh-L1 refresh (money movement); the same session continues
      const bearer = String(req.headers["authorization"] ?? "");
      if (bearer) {
        const ctx = await auth.authenticate(req, at);
        // 32.14 S3 "Mobile after Google": a destination on file for no one becomes THIS party's contact (the verified code is the proof — the same effect as party.updateContact, which is fresh-L1-gated and so could never run first);
        // on file for another party, or for an applicant who has not signed in yet, it is refused; on file for this party it is the fresh-L1 refresh as before
        const onFile = await auth.parties.destinationOnFile(channel, destination);
        if (onFile && "party" in onFile && onFile.party.id !== ctx.party.id) throw new BorrowerError(403, "PARTY_SCOPE", undefined, "the code belongs to a different party");
        if (onFile && "unlinked_application_borrower_id" in onFile) throw new BorrowerError(403, "PARTY_SCOPE", undefined, "the destination is on file for an applicant who has not signed in");
        const attached = await auth.parties.attachDestination(ctx.party.id, channel, destination);
        await auth.sessions.recordL1(ctx.session.session_id, at);
        logger.info("borrower.otp.refreshed", { session_id: ctx.session.session_id, channel, contact_added: attached.added, linked_application_borrowers: attached.linked_application_borrowers });
        send(res, 200, "session", sessionBody({ token: ctx.token, session: { ...ctx.session, last_l1_at: at }, party: ctx.party })); return;
      }
      const resolved = await auth.parties.resolveOrCreateByDestination(channel, destination);
      await auth.sessions.setChallengeParty(ch.challenge_id, resolved.party.id);
      const opened = await auth.openSession({ party_id: resolved.party.id, auth_method: channel === "sms" ? "otp_phone" : "otp_email", now: at, otp: true, ip: ipOf(req), user_agent: uaOf(req) });
      // 32.14 DELTA-11: the lead behind the `sm_borrower_lead` cookie (header x-borrower-lead) is linked to the party before the hook runs (`lead.linked{party_id}`);
      // 32.3 E1/E2: the session hook runs before the response — the automation disclosure is the first assistant content on the channel the code came through (an SMS code = the SMS thread)
      await landSession(req, opened, at, channel === "sms" ? "sms" : "app", "code");
      logger.info("borrower.session.opened", { session_id: opened.session.session_id, level: "L1", auth_method: opened.session.auth_method, party_created: resolved.created, linked_application_borrowers: resolved.linked_application_borrowers });
      send(res, 200, "session", sessionBody({ token: opened.token, session: opened.session, party: opened.party })); return;
    }
    throw new RangeError("action must be request or verify");
  }
  const ipOf = (req: IncomingMessage): string | null => { const f = req.headers["x-forwarded-for"]; const s = Array.isArray(f) ? f[0] : f; return (s ? s.split(",")[0]!.trim() : req.socket?.remoteAddress) ?? null; };
  const uaOf = (req: IncomingMessage): string | null => (typeof req.headers["user-agent"] === "string" ? (req.headers["user-agent"] as string).slice(0, 512) : null);

  // ───────────────────────────── 32.16 DELTA-29: e-mail + password accounts (docs/ux/17 §2.0)
  const accountStarts = new Map<string, number[]>();   // per-IP create / sign_in instants within the hour
  function accountThrottle(ip: string | null, at: string): void {
    const key = ip ?? "?"; const t = Date.parse(at); const kept = (accountStarts.get(key) ?? []).filter((x) => x > t - 3_600_000);
    if (kept.length >= ACCOUNT_PER_HOUR) throw new BorrowerError(429, "ACCOUNT_THROTTLED", undefined, `${ACCOUNT_PER_HOUR} account requests per hour per IP`);
    kept.push(t); accountStarts.set(key, kept);
  }
  const emailOf = (b: Record<string, unknown>): string => { need(b, "email"); const email = normalizeEmail(str(b, "email")); if (!isEmail(email)) throw new RangeError("email is not a valid e-mail address"); return email; };
  const passwordOf = (b: Record<string, unknown>): string => { const password = typeof b["password"] === "string" ? (b["password"] as string) : ""; if (!password) throw new RangeError("password is required"); if (password.length < PASSWORD_MIN_LENGTH) throw new BorrowerError(400, "PASSWORD_WEAK", undefined, `a password is at least ${PASSWORD_MIN_LENGTH} characters`); return password; };
  const emailVerifyCode = (email: string, partyId: string, at: string) => issueCode({ kind: "email_verify", channel: "email", destination: email, party_id: partyId, at, subject: "Verify your e-mail for Supermortgage" });
  /** An L1 password session: no code on the session (`last_l1_at` null — FRESH_L1_COMMANDS ask for one), the organic application and the disclosure first (landSession). */
  async function openPasswordSession(req: IncomingMessage, res: ServerResponse, partyId: string, at: string, how: "verify_email" | "sign_in"): Promise<void> {
    const opened = await auth.openSession({ party_id: partyId, auth_method: "password", now: at, otp: false, ip: ipOf(req), user_agent: uaOf(req) });
    await landSession(req, opened, at, "app", "account");
    logger.info("borrower.session.opened", { session_id: opened.session.session_id, level: "L1", auth_method: "password", how });
    send(res, 200, "session", sessionBody({ token: opened.token, session: opened.session, party: opened.party }));
  }
  async function account(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = jsonOf(await readBody(req)); const action = str(b, "action"); const at = now();
    if (action === "create") {
      accountThrottle(ipOf(req), at);
      const email = emailOf(b); const password = passwordOf(b);
      if (await credentials.byEmail(email)) throw new BorrowerError(409, "ACCOUNT_EXISTS", undefined, "an account already uses that e-mail");
      // the party: a servicing-book borrower whose e-mail is on file lands in their own party; a new e-mail creates one (the same resolver a code uses)
      const resolved = await auth.parties.resolveOrCreateByDestination("email", email);
      if (await credentials.byParty(resolved.party.id)) throw new BorrowerError(409, "ACCOUNT_EXISTS", undefined, "the party already has an account");
      await credentials.create({ party_id: resolved.party.id, email, password, now: at });
      const r = await emailVerifyCode(email, resolved.party.id, at);
      logger.info("borrower.account.created", { party_id: resolved.party.id, party_created: resolved.created, linked_application_borrowers: resolved.linked_application_borrowers, challenge_id: r.challenge.challenge_id, delivery: r.challenge.delivery, delivery_ref: r.delivery_ref, vendor: deliveryIsFake() ? "FAKE" : "e-delivery" });
      send(res, 200, "account_create", { challenge_id: r.challenge.challenge_id, delivery: r.challenge.delivery, expires_at: r.expires_at, ...fakeCodeOf(r.code) }); return;
    }
    if (action === "verify_email") {
      need(b, "challenge_id", "code");
      const ch = await checkCode("email_verify", str(b, "challenge_id"), str(b, "code"), at);
      const row = ch.party_id ? await credentials.byParty(ch.party_id) : undefined;
      if (!row || row.email !== normalizeEmail(ch.destination ?? "")) throw new BorrowerError(401, "OTP_INVALID", undefined, "the challenge names no account");
      await credentials.markEmailVerified(row.party_id, at);
      await credentials.clearFailures(row.party_id, at);
      await openPasswordSession(req, res, row.party_id, at, "verify_email"); return;
    }
    if (action === "sign_in") {
      accountThrottle(ipOf(req), at);
      const email = emailOf(b); const password = typeof b["password"] === "string" ? (b["password"] as string) : ""; if (!password) throw new RangeError("password is required");
      const row = await credentials.byEmail(email);
      // unknown e-mail: the same answer as a wrong password, after the same work (no account enumeration by code or by timing)
      if (!row) { await credentials.verifyPassword({ password_hash: DUMMY_PASSWORD_HASH }, password); throw new BorrowerError(401, "PASSWORD_WRONG"); }
      if (credentials.isLocked(row, at)) { logger.info("borrower.account.locked", { party_id: row.party_id, locked_until: row.locked_until }); throw new BorrowerError(423, "ACCOUNT_LOCKED"); }
      if (!(await credentials.verifyPassword(row, password))) {
        const after = await credentials.recordFailure(row.party_id, at);
        logger.info("borrower.account.sign_in.failed", { party_id: row.party_id, failed_attempts: after.failed_attempts, locked_until: after.locked_until });   // never the password
        throw new BorrowerError(401, "PASSWORD_WRONG");
      }
      if (!row.email_verified_at) {
        const r = await emailVerifyCode(row.email, row.party_id, at);
        logger.info("borrower.account.sign_in.unverified", { party_id: row.party_id, challenge_id: r.challenge.challenge_id, delivery: r.challenge.delivery });
        send(res, 403, "error", { ...new BorrowerError(403, "EMAIL_UNVERIFIED").body(), challenge_id: r.challenge.challenge_id, ...fakeCodeOf(r.code) }); return;
      }
      await credentials.clearFailures(row.party_id, at);
      await openPasswordSession(req, res, row.party_id, at, "sign_in"); return;
    }
    if (action === "request_reset") {
      const email = emailOf(b);
      const row = await credentials.byEmail(email);
      if (!row) { send(res, 200, "account_ok", { ok: true }); return; }   // always ok: no account enumeration
      const r = await issueCode({ kind: "password_reset", channel: "email", destination: row.email, party_id: row.party_id, at, subject: "Reset your Supermortgage password" });
      logger.info("borrower.account.reset_requested", { party_id: row.party_id, challenge_id: r.challenge.challenge_id, delivery: r.challenge.delivery, delivery_ref: r.delivery_ref });
      send(res, 200, "account_ok", { ok: true, challenge_id: r.challenge.challenge_id, ...fakeCodeOf(r.code) }); return;
    }
    if (action === "reset") {
      need(b, "challenge_id", "code"); const password = passwordOf(b);
      const ch = await checkCode("password_reset", str(b, "challenge_id"), str(b, "code"), at);
      const row = ch.party_id ? await credentials.byParty(ch.party_id) : undefined;
      if (!row) throw new BorrowerError(401, "OTP_INVALID", undefined, "the challenge names no account");
      await credentials.setPassword(row.party_id, password, at);
      await credentials.clearFailures(row.party_id, at);   // the lock clears with the new password
      if (!row.email_verified_at) await credentials.markEmailVerified(row.party_id, at);   // the reset code proved the e-mail too
      logger.info("borrower.account.reset", { party_id: row.party_id, challenge_id: ch.challenge_id });
      send(res, 200, "account_ok", { ok: true }); return;
    }
    throw new RangeError("action must be create, verify_email, sign_in, request_reset or reset");
  }

  // ───────────────────────────── passkeys (WebAuthn)
  async function passkey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = jsonOf(await readBody(req)); const action = str(b, "action"); const at = now();
    const challengeBytes = () => b64url.encode(randomBytes(32));
    if (action === "register_options") {
      const ctx = await auth.authenticate(req, at);
      const challenge = challengeBytes(); const expiresAt = minutesAfter(at, OTP_MINUTES);
      const ch = await auth.sessions.createChallenge({ kind: "passkey_registration", party_id: ctx.party.id, session_id: ctx.session.session_id, challenge, expires_at: expiresAt });
      send(res, 200, "passkey_options", { challenge_id: ch.challenge_id, challenge, rp: { id: rpId, name: "Supermortgage" }, user: { id: b64url.encode(Buffer.from(ctx.party.id)), name: ctx.party.legal_name, display_name: ctx.party.legal_name }, pub_key_cred_params: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], timeout_ms: OTP_MINUTES * 60_000, attestation: "none", expires_at: expiresAt }); return;
    }
    if (action === "register") {
      const ctx = await auth.authenticate(req, at); need(b, "challenge_id");
      const ch = await auth.sessions.challenge(str(b, "challenge_id"));
      if (!ch || ch.kind !== "passkey_registration" || ch.consumed_at || ch.session_id !== ctx.session.session_id || Date.parse(ch.expires_at) <= Date.parse(at)) throw new BorrowerError(401, "PASSKEY_INVALID");
      const credential = b["credential"] as { id: string; response: { clientDataJSON: string; attestationObject: string; transports?: string[] } } | undefined;
      if (!credential || typeof credential !== "object" || typeof credential.id !== "string" || !credential.response) throw new RangeError("credential { id, response: { clientDataJSON, attestationObject } } is required");
      let r; try { r = verifyRegistration({ rpId, allowedOrigins, expectedChallenge: ch.challenge!, credential }); } catch (e) { throw new BorrowerError(401, "PASSKEY_INVALID", undefined, (e as Error).message); }
      await auth.sessions.consume(ch.challenge_id, at);
      const row = await auth.sessions.addPasskey({ party_id: ctx.party.id, credential_id: r.credentialId, public_key_jwk: r.publicKey.jwk, algorithm: r.publicKey.algorithm, sign_count: BigInt(r.signCount), transports: r.transports, attestation_format: r.attestationFormat });
      logger.info("borrower.passkey.registered", { passkey_id: row.passkey_id, party_id: ctx.party.id, attestation_format: r.attestationFormat, attestation_verified: r.attestationVerified });
      send(res, 200, "passkey_registered", { passkey_id: row.passkey_id, credential_id: row.credential_id, algorithm: row.algorithm, attestation_verified: r.attestationVerified, created_at: row.created_at }); return;
    }
    if (action === "assert_options") {
      const challenge = challengeBytes(); const expiresAt = minutesAfter(at, OTP_MINUTES);
      const ch = await auth.sessions.createChallenge({ kind: "passkey_assertion", challenge, expires_at: expiresAt });
      send(res, 200, "passkey_options", { challenge_id: ch.challenge_id, challenge, rp: { id: rpId, name: "Supermortgage" }, allow_credentials: [], timeout_ms: OTP_MINUTES * 60_000, expires_at: expiresAt }); return;
    }
    if (action === "assert") {
      need(b, "challenge_id");
      const ch = await auth.sessions.challenge(str(b, "challenge_id"));
      if (!ch || ch.kind !== "passkey_assertion" || ch.consumed_at || Date.parse(ch.expires_at) <= Date.parse(at)) throw new BorrowerError(401, "PASSKEY_INVALID");
      const credential = b["credential"] as { id: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } } | undefined;
      if (!credential || typeof credential !== "object" || typeof credential.id !== "string" || !credential.response) throw new RangeError("credential { id, response: { clientDataJSON, authenticatorData, signature } } is required");
      const stored = await auth.sessions.passkeyByCredential(credential.id);
      if (!stored) throw new BorrowerError(401, "PASSKEY_INVALID");
      let r; try { r = verifyAssertion({ rpId, allowedOrigins, expectedChallenge: ch.challenge!, publicKeyJwk: stored.public_key_jwk, algorithm: stored.algorithm, storedSignCount: stored.sign_count, credential }); } catch (e) { throw new BorrowerError(401, "PASSKEY_INVALID", undefined, (e as Error).message); }
      await auth.sessions.consume(ch.challenge_id, at);
      await auth.sessions.passkeyUsed(stored.passkey_id, r.signCount, at);
      // a passkey is an L1 sign-in without a code: last_l1_at stays empty until a code is verified (the fresh-L1 rule wants a code)
      const opened = await auth.openSession({ party_id: stored.party_id, auth_method: "passkey", now: at, otp: false, passkey_id: stored.passkey_id, ip: ipOf(req), user_agent: uaOf(req) });
      const lead_id = await leads.linkAtVerify(req, stored.party_id, at);   // 32.14 DELTA-11: the lead cookie's lead is this party's now
      await flows.sessionOpened({ party_id: stored.party_id, session_id: opened.session.session_id, channel: "app", auth_method: "passkey", at, lead_id });
      logger.info("borrower.session.opened", { session_id: opened.session.session_id, level: "L1", auth_method: "passkey", passkey_id: stored.passkey_id });
      send(res, 200, "session", sessionBody({ token: opened.token, session: opened.session, party: opened.party })); return;
    }
    throw new RangeError("action must be register_options, register, assert_options or assert");
  }

  // ───────────────────────────── Sign in with Google (32.14 §3, DELTA-12): Authorization Code + PKCE on the server, the same session body as a code
  async function oidc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = jsonOf(await readBody(req)); const action = str(b, "action"); const at = now();
    if (action === "start") {
      const r = await oidcAuth.start(b, at);
      send(res, 200, "oidc_start", { authorization_url: r.authorization_url, state: r.state, expires_at: r.expires_at, ...(r.delivery ? { delivery: r.delivery } : {}) }); return;
    }
    if (action === "callback") {
      const marker = req.headers["x-fake-oidc"]; const fakeMarker = Array.isArray(marker) ? marker[0] : marker;
      const opened = await oidcAuth.callback(b, { at, ip: ipOf(req), user_agent: uaOf(req), fake_marker: fakeMarker });
      // 32.3 E1/E2 as for a code: the session hook runs before the response — the disclosure is the first assistant content; a passkey-less L1 session (no last_l1_at);
      // 32.14 DELTA-11: the lead cookie's lead is this party's now (as at OTP verify); 32.16 DELTA-29: a party with no subject gets its organic application first
      await landSession(req, opened, at, "app", "account");
      logger.info("borrower.session.opened", { session_id: opened.session.session_id, level: "L1", auth_method: opened.session.auth_method, provider: oidcPort.provider, vendor: oidcPort.vendorName, party_created: opened.party_created, identity_created: opened.identity_created, resolved_by: opened.resolved_by, challenge_id: opened.challenge_id });
      send(res, 200, "session", sessionBody({ token: opened.token, session: opened.session, party: opened.party })); return;
    }
    throw new RangeError("action must be start or callback");
  }

  // ───────────────────────────── L2: SSN last 4 + DOB against application_borrowers
  async function stepUpL2(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const b = jsonOf(await readBody(req)); need(b, "ssn_last4", "date_of_birth");
    const last4 = str(b, "ssn_last4"); const dob = str(b, "date_of_birth");
    if (!/^\d{4}$/.test(last4) || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new RangeError("ssn_last4 is four digits; date_of_birth is YYYY-MM-DD");
    const rows = await auth.parties.applicationBorrowersOf(ctx.party.id);
    const matched = rows.some((r) => r.tin_last4 === last4 && r.date_of_birth === dob);
    logger.info("borrower.l2.attempt", { session_id: ctx.session.session_id, matched });   // never the values
    if (!matched) throw new BorrowerError(403, "L2_MATCH_FAILED");
    await auth.sessions.raiseLevel(ctx.session.session_id, "L2");
    send(res, 200, "level", { level: ctx.session.level === "L3" ? "L3" : "L2", session_id: ctx.session.session_id });
  }

  // ───────────────────────────── L3: Stripe Identity session + webhook → 22.6 verifyIdentity
  async function identitySession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const b = jsonOf(await readBody(req));
    const requested = str(b, "application_id");
    const candidates = ctx.subjects.filter((s) => s.application_borrower_id && (!requested || s.application_id === requested));
    if (requested && !candidates.length) assertSubject(ctx, { application_id: requested });
    const subject = candidates[0];
    if (!subject || !subject.application_id || !subject.application_borrower_id) throw new BorrowerError(409, "IDENTITY_NO_APPLICATION", undefined, "no application on which this party is a borrower");
    const ab = (await auth.parties.applicationBorrowersOf(ctx.party.id)).find((r) => r.id === subject.application_borrower_id)!;
    const conv = await ui.conversationFor(ctx.party.id);
    const card = await ui.createCard({ conversation_id: conv.conversation_id, party_id: ctx.party.id, subject_application_id: subject.application_id, kind: "ConnectCard", created_by: "agent:verification", copy_key: "identity.stripe.purpose", props: { vendor: "stripe_identity", state: "in_progress" }, command_ref: "party.startIdentity", now: at });
    const address = (await runtime.db.query<{ a: string | null }>(`SELECT concat_ws(', ', address_line1, city, state || ' ' || postal_code) AS a FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at LIMIT 1`, [subject.application_id]))[0]?.a ?? null;
    const vs = await stripe.createSession({ party_id: ctx.party.id, application_id: subject.application_id, application_borrower_id: ab.id, legal_name: ab.legal_name, date_of_birth: ab.date_of_birth, address, return_url: `${returnUrlBase}/return/stripe_identity/${card.card_instance_id}` }, at);
    await runtime.db.query(`UPDATE card_instances SET props = props || $2::jsonb WHERE card_instance_id = $1`, [card.card_instance_id, toJson({ vendor_session_id: vs.vendor_session_id, started_at: at })]);
    await ui.logUiEvent({ party_id: ctx.party.id, session_id: ctx.session.session_id, conversation_id: conv.conversation_id, card_instance_id: card.card_instance_id, kind: "connector_started", at, ip: ctx.ip, user_agent: ctx.userAgent, payload: { vendor: "stripe_identity", vendor_session_id: vs.vendor_session_id } });
    const fake = stripe instanceof FakeStripeIdentity;
    logger.info("borrower.identity.session", { card_instance_id: card.card_instance_id, vendor_session_id: vs.vendor_session_id, vendor: fake ? "FAKE" : stripe.vendorName });
    send(res, 200, "identity_session", { vendor: "stripe_identity", vendor_session_id: vs.vendor_session_id, client_secret: vs.client_secret, return_url: vs.return_url, card_instance_id: card.card_instance_id, application_id: subject.application_id, status: vs.status, ...(fake ? { delivery: "FAKE" } : {}) });
  }
  async function stripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = now(); const raw = (await readBody(req)).toString("utf8");
    const sig = req.headers["stripe-signature"]; const parsed = await stripe.parseWebhook(raw, Array.isArray(sig) ? sig[0] : sig, at);
    const cards = await runtime.db.query<{ card_instance_id: string; party_id: string; subject_application_id: string; props: Record<string, unknown>; status: string }>(`SELECT card_instance_id, party_id, subject_application_id, props, status FROM card_instances WHERE kind = 'ConnectCard' AND props->>'vendor_session_id' = $1`, [parsed.vendor_session_id]);
    const card = cards[0];
    if (!card) throw new BorrowerError(404, "IDENTITY_SESSION_UNKNOWN");
    const fake = stripe instanceof FakeStripeIdentity;
    if (parsed.outcome === "ignored") { send(res, 200, "identity_webhook", { received: true, vendor: fake ? "FAKE" : stripe.vendorName, vendor_session_id: parsed.vendor_session_id, outcome: "ignored" }); return; }
    if (parsed.outcome !== "verified") {
      await ui.transitionCard(card.card_instance_id, parsed.outcome === "canceled" ? "cancelled" : "pending", "system", at, { vendor: "stripe_identity", vendor_session_id: parsed.vendor_session_id, outcome: parsed.outcome === "canceled" ? "failed" : "in_progress", completed_at: at });
      send(res, 200, "identity_webhook", { received: true, vendor: fake ? "FAKE" : stripe.vendorName, vendor_session_id: parsed.vendor_session_id, outcome: parsed.outcome }); return;
    }
    const result = await stripe.result(parsed.vendor_session_id);
    if (!result) throw new BorrowerError(404, "IDENTITY_SESSION_UNKNOWN");
    const applicationId = result.request.application_id; const abId = result.request.application_borrower_id;
    const borrowerIds = await auth.parties.applicationBorrowerIds(applicationId);
    // extracted name / DOB / address → application_borrowers.prefill as source=stripe_identity, confirmed_at null (pending the ConfirmCard)
    const prefill = { legal_name: { value: result.extraction.legal_name, source: "stripe_identity", extracted_at: at, confirmed_at: null }, date_of_birth: { value: result.extraction.date_of_birth, source: "stripe_identity", extracted_at: at, confirmed_at: null }, address: { value: result.extraction.address, source: "stripe_identity", extracted_at: at, confirmed_at: null } } as const;
    await auth.parties.writePrefill(abId, prefill);
    // (written before 22.6's op commits: 32.3 R1's identity ConfirmCard reads the prefill when it reacts to identity.verified)
    // 22.6's own op through the bus: identity.verified{level, all_borrowers_verified} → SM_IDENTITY_IAL2_GATE satisfies when the last borrower verifies. Never a second identity path.
    const r = await runtime.execute({ process: "22.6", name: "verifyIdentity", loanId: "", applicationId, actor: WEBHOOK_ACTOR,
      input: { application_id: applicationId, borrower_id: abId, method: "remote_doc_biometric", result: result.session_result, borrower_ids: borrowerIds, at, consent_id: card.card_instance_id } });
    const out = r.output as { outcome: string; level: string | null; all_borrowers_verified: boolean; gate: { open: boolean } };
    let raised = 0;
    if (out.outcome === "verified") raised = await auth.sessions.raisePartyLevel(card.party_id, "L3", at);
    await ui.transitionCard(card.card_instance_id, out.outcome === "verified" ? "resolved" : "pending", "system", at, { vendor: "stripe_identity", vendor_session_id: parsed.vendor_session_id, started_at: card.props["started_at"] ?? null, completed_at: at, outcome: out.outcome === "verified" ? "connected" : "failed" });
    await ui.logUiEvent({ party_id: card.party_id, card_instance_id: card.card_instance_id, kind: "connector_completed", at, payload: { vendor: "stripe_identity", vendor_session_id: parsed.vendor_session_id, outcome: out.outcome } });
    logger.info("borrower.identity.webhook", { vendor: fake ? "FAKE" : stripe.vendorName, vendor_session_id: parsed.vendor_session_id, outcome: out.outcome, level: out.level, sessions_raised: raised, all_borrowers_verified: out.all_borrowers_verified, events: r.events.map((e) => e.type) });
    send(res, 200, "identity_webhook", { received: true, vendor: fake ? "FAKE" : stripe.vendorName, vendor_session_id: parsed.vendor_session_id, outcome: out.outcome, level: out.outcome === "verified" ? "L3" : null, application_id: applicationId, prefilled: Object.keys(prefill), all_borrowers_verified: out.all_borrowers_verified, gate_open: out.gate.open });
  }

  // ───────────────────────────── me · deep links
  async function me(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    send(res, 200, "me", { party: { party_id: ctx.party.id, party_type: ctx.party.party_type, display_name: ctx.party.legal_name, first_name: ctx.party.legal_name.split(" ")[0] }, level: ctx.session.level, session: { ...ctx.session, fresh_l1: hasFreshL1(ctx.session, at) }, subjects: ctx.subjects, partner: await partnerFor(ctx) });
  }
  /** 32.13: the partner behind the party's first subject (the shell's automation marker and `{{partner.legal_name}}` in the disclosure line) — the application's intake record names the NMLSR id. */
  async function partnerFor(ctx: BorrowerContext): Promise<{ legal_name: string; nmlsr_id: string }> {
    const app = ctx.subjects.find((x) => x.application_id)?.application_id ?? null; const loan = ctx.subjects.find((x) => x.loan_id)?.loan_id ?? null;
    const row = app ? (await runtime.db.query<{ legal_name: string; data: unknown }>(`SELECT p.legal_name, (SELECT data FROM entity_current e WHERE e.kind = 'applications' AND e.id = a.id::text) AS data FROM applications a JOIN parties p ON p.id = a.partner_party_id WHERE a.id = $1`, [app]))[0]
      : loan ? (await runtime.db.query<{ legal_name: string; data: unknown }>(`SELECT p.legal_name, NULL AS data FROM loans l JOIN parties p ON p.id = l.partner_party_id WHERE l.id = $1`, [loan]))[0] : undefined;
    const nested = row?.data ? decodeEntityData(row.data) : null;
    // 32.14 DELTA-15: a party with no subject yet (a fresh sign-in) is the configured Phase I partner's
    const configured = !row && defaultPartnerId ? (await runtime.db.query<{ legal_name: string }>(`SELECT legal_name FROM parties WHERE id::text = $1`, [defaultPartnerId]))[0] : undefined;
    return { legal_name: (nested?.["partner_name"] as string | undefined) ?? row?.legal_name ?? configured?.legal_name ?? "Supermortgage", nmlsr_id: (nested?.["partner_nmlsr_id"] as string | undefined) ?? "" };
  }
  async function deepLink(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);   // L1 first: no loan data before a session (01 §6.5)
    const link = await ui.deepLink(token);
    if (!link) throw new BorrowerError(404, "DEEP_LINK_UNKNOWN");
    if (Date.parse(link.expires_at) <= Date.parse(at) || (link.single_use && link.used_at)) throw new BorrowerError(410, "DEEP_LINK_EXPIRED");
    if (link.party_id !== ctx.party.id) throw new BorrowerError(403, "PARTY_SCOPE", undefined, "the link was sent to another party");
    await ui.markDeepLinkUsed(token, at);
    await ui.logUiEvent({ party_id: ctx.party.id, session_id: ctx.session.session_id, card_instance_id: "card_instance_id" in link.target ? link.target.card_instance_id : null, kind: "deep_link_opened", at, ip: ctx.ip, user_agent: ctx.userAgent, payload: { target: link.target } });
    send(res, 200, "deep_link", { token, target: link.target, expires_at: link.expires_at });
  }

  // ───────────────────────────── documents: upload → 22.1; signed URL → bytes
  async function uploadDocument(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const ctype = String(req.headers["content-type"] ?? ""); const body = await readBody(req);
    let fields: Record<string, string>; let file: MultipartFile | undefined;
    if (/^multipart\/form-data/i.test(ctype)) { const p = parseMultipart(body, ctype); fields = p.fields; file = p.files.find((f) => f.field === "file") ?? p.files[0]; }
    else { const j = jsonOf(body); fields = Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === "string") as [string, string][]); if (typeof j["content_base64"] === "string") file = { field: "file", filename: str(j, "filename") || null, mime_type: str(j, "mime_type") || "application/octet-stream", bytes: Buffer.from(j["content_base64"] as string, "base64") }; }
    if (!file || !file.bytes.length) throw new RangeError("a file is required (multipart field `file`)");
    const applicationId = fields["application_id"] ?? "";
    if (!isUuid(applicationId)) throw new RangeError("application_id (uuid) is required");
    const subject = assertSubject(ctx, { application_id: applicationId });
    const declared = fields["document_class"] || null;
    if (declared && !DOCUMENT_CLASSES.some((c) => c.code === declared)) throw new RangeError(`document_class ${declared} is not a 22.1 document class`);
    const documentId = randomUUID(); const digest = sha256(file.bytes).toString("hex");
    const storageUri = await blobs.put(documentId, { bytes: file.bytes, mime_type: file.mime_type, filename: file.filename, stored_at: at });
    await runtime.db.query(`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, received_from, application_id, doc_class, source_channel, sender_identity, received_at, subject_borrower_id, page_count, metadata) VALUES ($1, 'origination_document', $2, $3, $4, $5, $6, $7, $8, 'borrower_upload', $9::jsonb, $10, $11, 0, $12::jsonb)`,
      [documentId, digest, file.bytes.length, storageUri, file.mime_type, ctx.party.id, applicationId, declared, toJson({ party_id: ctx.party.id, session_id: ctx.session.session_id, filename: file.filename }), at, subject.application_borrower_id, toJson({ filename: file.filename, blob_store: blobs.vendorName })]);
    // 22.1's intake op through the bus: document.received (+ the needs-list review clock); a duplicate hash links, never re-processes
    const r = await runtime.execute({ process: "22.1", name: "ingestDocument", loanId: "", applicationId, actor: SYSTEM_ACTOR,
      input: { application_id: applicationId, document_id: documentId, source_channel: "borrower_upload", sha256: digest, page_count: 0, declared_class: declared, subject_borrower_id: subject.application_borrower_id, applicant_borrower_ids: await auth.parties.applicationBorrowerIds(applicationId), sender_identity: { party_id: ctx.party.id, session_id: ctx.session.session_id }, received_at: at } });
    const out = r.output as Record<string, unknown>;
    logger.info("borrower.document.uploaded", { document_id: documentId, application_id: applicationId, bytes: file.bytes.length, status: out["status"], blob_store: blobs.vendorName });
    send(res, 201, "document_uploaded", { document_id: documentId, application_id: applicationId, status: out["status"], integrity_status: out["integrity_status"], quarantined: out["quarantined"], quarantine_reason: out["quarantine_reason"] ?? null, duplicate_of: out["duplicate_of"] ?? null, matched_request_ids: out["matched_request_ids"] ?? [], received_at: at, doc_class: declared, byte_size: file.bytes.length, sha256: digest });
  }
  interface DocRow { id: string; kind: string; doc_class: string | null; mime_type: string | null; application_id: string | null; loan_id: string | null; subject_borrower_id: string | null; metadata: Record<string, unknown>; }
  async function visibleDocument(ctx: BorrowerContext, id: string): Promise<DocRow> {
    if (!isUuid(id)) throw new RangeError("document id must be a uuid");
    const rows = await runtime.db.query<DocRow & Record<string, unknown>>(`SELECT id, kind, doc_class, mime_type, application_id, loan_id, subject_borrower_id, metadata FROM documents WHERE id = $1`, [id]);
    const d = rows[0];
    if (!d) throw new BorrowerError(403, "PARTY_SCOPE");                          // never confirm existence outside the party's scope
    const subject = assertSubject(ctx, { application_id: d.application_id, loan_id: d.loan_id });
    if (RENDERED_KINDS.has(d.kind)) return d;
    const family = DOCUMENT_CLASSES.find((c) => c.code === d.doc_class)?.family;
    const rule = family ? VISIBLE_FAMILIES[family] : undefined;
    if (!rule) throw new BorrowerError(403, "DOCUMENT_NOT_VISIBLE");
    if (rule === "own_only" && d.subject_borrower_id !== subject.application_borrower_id) throw new BorrowerError(403, "DOCUMENT_NOT_VISIBLE");
    return d;
  }
  async function documentLink(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const d = await visibleDocument(ctx, id);
    const exp = String(Date.parse(at) + DOCUMENT_URL_MINUTES * 60_000);
    const url = `/v1/borrower/documents/${d.id}/content?exp=${exp}&sig=${signUrl(ctx.session.session_id, d.id, exp)}`;
    await ui.logUiEvent({ party_id: ctx.party.id, session_id: ctx.session.session_id, kind: "document_opened", at, ip: ctx.ip, user_agent: ctx.userAgent, payload: { document_id: d.id, doc_class: d.doc_class, kind: d.kind } });
    send(res, 200, "document_link", { document_id: d.id, title: (d.metadata["title"] as string | undefined) ?? (d.metadata["filename"] as string | undefined) ?? d.doc_class ?? d.kind, doc_class: d.doc_class, mime_type: d.mime_type, url, expires_at: new Date(Number(exp)).toISOString() });
  }
  async function documentContent(req: IncomingMessage, res: ServerResponse, url: URL, id: string): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const exp = url.searchParams.get("exp") ?? ""; const sig = url.searchParams.get("sig") ?? "";
    if (!/^\d+$/.test(exp) || Number(exp) <= Date.parse(at)) throw new BorrowerError(410, "DEEP_LINK_EXPIRED");
    if (!sameSig(sig, signUrl(ctx.session.session_id, id, exp))) throw new BorrowerError(403, "PARTY_SCOPE", undefined, "the signed URL is bound to another session");
    const d = await visibleDocument(ctx, id);
    const blob = await blobs.get(d.id);
    if (!blob) throw new BorrowerError(404, "DOCUMENT_CONTENT_UNAVAILABLE");
    res.writeHead(200, { "content-type": blob.mime_type, "content-length": blob.bytes.length, "cache-control": "no-store", "content-disposition": `inline${blob.filename ? `; filename="${blob.filename.replace(/"/g, "")}"` : ""}` });
    res.end(blob.bytes);
  }

  // ───────────────────────────── the read models (02 §1) · the stream (02 §3) · commands and cards (02 §2, §7)
  const subjectParam = (ctx: BorrowerContext, url: URL) => { const s = url.searchParams.get("subject"); if (!s) return commands.subjectFor(ctx, null); if (!isUuid(s)) throw new RangeError("subject must be an application or loan uuid"); const found = ctx.subjects.find((x) => x.application_id === s || x.loan_id === s); if (!found) throw new BorrowerError(403, "PARTY_SCOPE", undefined, "the subject is not on this party's record"); return found; };
  async function record(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const subject = subjectParam(ctx, url);
    const cards = await ui.cardsOf(ctx.party.id);
    const r = await reader.record(ctx.party, subject, cards, at);
    // 01 §5 / 32.3 T3: personal terms (a quote, an LE, a lock) render from L2 — an L1 session's origination record omits `numbers`
    if (ctx.session.level === "L1" && !subject.loan_id) { const { numbers: _numbers, ...rest } = r; send(res, 200, "record", rest); return; }
    send(res, 200, "record", r);
  }
  // ───────────────────────────── 32.3: the in-app voice session (E1) and the FAKE payroll connector (R3)
  async function voiceSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const b = jsonOf(await readBody(req)); const requested = str(b, "application_id"); if (requested) assertSubject(ctx, { application_id: requested });
    const conv = await ui.conversationFor(ctx.party.id);
    await ui.logUiEvent({ party_id: ctx.party.id, session_id: ctx.session.session_id, conversation_id: conv.conversation_id, kind: "voice_started", at, ip: ctx.ip, user_agent: ctx.userAgent, payload: { vendor: "FAKE", telephony: "in_app" } });
    // the spoken disclosure first (E2: "voice reads it aloud"), then the lead's interaction on the voice channel
    await flows.sessionOpened({ party_id: ctx.party.id, session_id: ctx.session.session_id, channel: "voice", auth_method: ctx.session.auth_method, at });
    const first = (await ui.messagesAfter(conv.conversation_id, null, 500)).filter((m) => m.channel === "voice" && m.sender === "agent").at(-1) ?? null;
    logger.info("borrower.voice.session", { party_id: ctx.party.id, session_id: ctx.session.session_id, vendor: "FAKE" });
    send(res, 200, "voice_session", { session_id: ctx.session.session_id, channel: "voice", vendor: "FAKE", started_at: at, first_message: first ? reader.threadMessages([first], new Map(), ctx.party.legal_name.split(" ")[0] ?? ctx.party.legal_name)[0] : null });
  }
  async function connectSession(req: IncomingMessage, res: ServerResponse, vendor: string): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    if (vendor !== "truv_income") throw new BorrowerError(404, "NOT_FOUND", undefined, `${vendor} is not a connector this API opens`);
    const b = jsonOf(await readBody(req)); need(b, "card_instance_id"); const cardId = str(b, "card_instance_id");
    if (!isUuid(cardId)) throw new BorrowerError(403, "PARTY_SCOPE", undefined, "card id must be a uuid");
    const card = await ui.card(cardId);
    if (!card || card.party_id !== ctx.party.id) throw new BorrowerError(403, "PARTY_SCOPE", undefined, "the card is not this party's");
    if (card.kind !== "ConnectCard" || card.props["vendor"] !== "truv_income") throw new BorrowerError(409, "CARD_NOT_PENDING", undefined, "not a payroll ConnectCard");
    const subject = assertSubject(ctx, { application_id: card.subject_application_id });
    const orderId = ((card.evidence?.["command_output"] as Record<string, unknown> | undefined)?.["order_id"] as string | undefined) ?? null;
    if (!orderId) throw new BorrowerError(409, "CONNECT_NOT_STARTED", undefined, "resolve the ConnectCard first (verification.connect orders the report — 22.3)");
    const borrowerId = orderId.split(":")[1] ?? subject.application_borrower_id ?? "";
    const vs = await truv.createSession({ party_id: ctx.party.id, application_id: subject.application_id!, application_borrower_id: subject.application_borrower_id ?? "", borrower_id: borrowerId, card_instance_id: cardId, order_id: orderId }, at);
    await runtime.db.query(`UPDATE card_instances SET props = props || $2::jsonb WHERE card_instance_id = $1`, [cardId, toJson({ vendor_session_id: vs.vendor_session_id, started_at: at, state: "in_progress" })]);
    await ui.logUiEvent({ party_id: ctx.party.id, session_id: ctx.session.session_id, conversation_id: card.conversation_id, card_instance_id: cardId, kind: "connector_started", at, ip: ctx.ip, user_agent: ctx.userAgent, payload: { vendor: "truv_income", vendor_session_id: vs.vendor_session_id } });
    const fake = truv instanceof FakeTruv;
    logger.info("borrower.connect.session", { card_instance_id: cardId, vendor_session_id: vs.vendor_session_id, vendor: fake ? "FAKE" : truv.vendorName });
    send(res, 200, "connect_session", { vendor: "truv_income", vendor_session_id: vs.vendor_session_id, link_token: vs.link_token, card_instance_id: cardId, application_id: subject.application_id, status: vs.status, ...(fake ? { delivery: "FAKE" } : {}) });
  }
  async function truvWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = now(); const raw = (await readBody(req)).toString("utf8");
    const sig = req.headers["x-truv-signature"]; const parsed = await truv.parseWebhook(raw, Array.isArray(sig) ? sig[0] : sig, at);
    const card = (await runtime.db.query<{ card_instance_id: string; party_id: string; subject_application_id: string; props: Record<string, unknown>; evidence: Record<string, unknown> | null }>(`SELECT card_instance_id, party_id, subject_application_id, props, evidence FROM card_instances WHERE kind = 'ConnectCard' AND props->>'vendor_session_id' = $1`, [parsed.vendor_session_id]))[0];
    if (!card) throw new BorrowerError(404, "NOT_FOUND", undefined, "no ConnectCard for this vendor session");
    const fake = truv instanceof FakeTruv;
    if (parsed.outcome !== "report_ready" || !parsed.report) {
      if (parsed.outcome === "failed") await runtime.db.query(`UPDATE card_instances SET props = props || $2::jsonb WHERE card_instance_id = $1`, [card.card_instance_id, toJson({ state: "failed", completed_at: at })]);
      // 32.13 T-X-12: the failure the borrower never decodes — evidence without a code, the fallback line, an UploadCard for the same purpose
      if (parsed.outcome === "failed") await connectorFailed({ runtime, ui }, card, at, { name: "truv_income", fake, vendor_session_id: parsed.vendor_session_id });
      send(res, 200, "connect_webhook", { received: true, vendor: fake ? "FAKE" : truv.vendorName, vendor_session_id: parsed.vendor_session_id, outcome: parsed.outcome, application_id: card.subject_application_id, events: [] }); return;
    }
    const result = await truv.result(parsed.vendor_session_id); const request = result?.request; const report = parsed.report;
    const orderId = request?.order_id ?? ((card.evidence?.["command_output"] as Record<string, unknown> | undefined)?.["order_id"] as string | undefined) ?? null;
    // 22.3's own op through the bus: verification.received{kind=income} on the order the ConnectCard placed — the verifications row keeps the vendor's references; the figures stay on the card for the ConfirmCard (R3)
    const r = await runtime.execute({ process: "22.3", name: "orderVerificationReport", loanId: "", applicationId: card.subject_application_id, actor: VERIFICATION_ACTOR,
      input: { application_id: card.subject_application_id, op: "receive", borrower_id: request?.borrower_id ?? orderId?.split(":")[1] ?? "", kind: "income", supplier_code: "TRUV", report_reference_id: report.report_reference_id, vendor_data_as_of: report.vendor_data_as_of, report_document_id: report.report_document_id, authorization_consent_id: card.card_instance_id, ...(orderId ? { verification_id: orderId } : {}) } });
    const out = r.output as { verification_id: string };
    await runtime.db.query(`UPDATE card_instances SET evidence = coalesce(evidence, '{}'::jsonb) || $2::jsonb, props = props || $3::jsonb WHERE card_instance_id = $1`, [card.card_instance_id, toJson({ vendor: "truv_income", vendor_fake: "FAKE", vendor_session_id: parsed.vendor_session_id, completed_at: at, outcome: "connected", report, report_reference_id: report.report_reference_id, verification_id: out.verification_id }), toJson({ state: "connected", report_reference_id: report.report_reference_id, completed_at: at })]);
    await ui.logUiEvent({ party_id: card.party_id, card_instance_id: card.card_instance_id, kind: "connector_completed", at, payload: { vendor: "truv_income", vendor_session_id: parsed.vendor_session_id, outcome: "connected" } });
    logger.info("borrower.connect.webhook", { vendor: fake ? "FAKE" : truv.vendorName, vendor_session_id: parsed.vendor_session_id, verification_id: out.verification_id, events: r.events.map((e) => e.type) });
    send(res, 200, "connect_webhook", { received: true, vendor: fake ? "FAKE" : truv.vendorName, vendor_session_id: parsed.vendor_session_id, outcome: "connected", application_id: card.subject_application_id, verification_id: out.verification_id, report_reference_id: report.report_reference_id, events: r.events.map((e) => e.type) });
  }
  async function thread(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const after = url.searchParams.get("after"); const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
    const conv = await ui.conversationFor(ctx.party.id);
    const rows = await ui.messagesAfter(conv.conversation_id, after, limit + 1);
    const page = rows.slice(0, limit);
    const cardIds = [...new Set(page.map((m) => m.card_instance_id).filter((x): x is string => !!x))];
    const cards = new Map<string, CardInstanceRow>();
    for (const id of cardIds) { const c = await ui.card(id); if (c) cards.set(id, c); }
    const pinned = (await ui.cardsOf(ctx.party.id, { status: "pending" }))[0] ?? null;
    send(res, 200, "thread", { conversation_id: conv.conversation_id, messages: reader.threadMessages(page, cards, ctx.party.legal_name.split(" ")[0] ?? ctx.party.legal_name), pinned_card: pinned ? { ...pinned, subject: { application_id: pinned.subject_application_id, loan_id: pinned.subject_loan_id } } : null, next_after: page.at(-1)?.message_id ?? after, has_more: rows.length > limit });
  }
  async function history(req: IncomingMessage, res: ServerResponse, url: URL, view: string): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    if (!["payments", "escrow", "statements", "cases", "lossmit"].includes(view)) { send(res, 404, "error", new BorrowerError(404, "NOT_FOUND").body()); return; }
    const s = url.searchParams.get("subject");
    const subject = s ? subjectParam(ctx, url) : ctx.subjects.find((x) => x.loan_id) ?? commands.subjectFor(ctx, null);
    if (!subject.loan_id) throw new BorrowerError(409, "NO_SERVICED_LOAN", undefined, "history views need a serviced loan");
    send(res, 200, "history", { loan_id: subject.loan_id, view, rows: await reader.history(subject.loan_id, view as "payments") });
  }
  async function stream(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const at = now();
    // EventSource cannot set headers: the session token may ride on ?token=; the same session policy applies (no loan data before L1)
    const q = url.searchParams.get("token"); if (q && !req.headers["authorization"]) req.headers["authorization"] = `Bearer ${q}`;
    const ctx = await auth.authenticate(req, at);
    const h = req.headers["last-event-id"]; const raw = (Array.isArray(h) ? h[0] : h) ?? url.searchParams.get("last_event_id");
    const lastEventId = raw !== null && raw !== undefined && /^\d+$/.test(String(raw)) ? Number(raw) : null;
    hub.subscribe(ctx.party.id, res, lastEventId);
    logger.info("borrower.stream.opened", { party_id: ctx.party.id, session_id: ctx.session.session_id, last_event_id: lastEventId, connections: hub.connections(ctx.party.id) });
  }
  async function message(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const b = jsonOf(await readBody(req));
    const r = await commands.borrowerMessage(ctx, b, at);
    logger.info("borrower.message", { party_id: ctx.party.id, routed_to: r.routed_to, command_executed: r.command_executed, reply_copy_key: r.reply.copy_key, deep_link: !!r.reply.deep_link });
    send(res, 200, "message_reply", { message: { ...r.message, subject: { application_id: r.message.subject_application_id, loan_id: r.message.subject_loan_id }, delivery: { sent: true, delivered: true, read: true } }, reply: { ...r.reply, subject: { application_id: r.reply.subject_application_id, loan_id: r.reply.subject_loan_id }, delivery: { sent: true, delivered: true, read: false }, sender_label: "Supermortgage" }, routed_to: r.routed_to, command_executed: r.command_executed, command: r.command });
  }
  async function resolveCard(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const b = jsonOf(await readBody(req));
    const r = await commands.resolveCard(ctx, id, b, at);
    logger.info("borrower.card.resolved", { card_instance_id: id, kind: r.card.kind, command: r.command, idempotent: r.idempotent, events: r.events });
    send(res, r.idempotent ? 200 : 201, "card_resolved", { card: { ...r.card, subject: { application_id: r.card.subject_application_id, loan_id: r.card.subject_loan_id } }, command: r.command, idempotent: r.idempotent, result: r.result, events: r.events });
  }
  async function command(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const b = jsonOf(await readBody(req));
    const r = await commands.runCommand(ctx, name, b, at);
    logger.info("borrower.command", { command: name, party_id: ctx.party.id, subject: r.subject, events: r.events });
    send(res, 200, "command_result", r);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith("/v1/borrower/") && path !== "/v1/webhooks/stripe" && path !== "/v1/webhooks/truv" && path !== "/v1/webhooks/sms" && path !== "/v1/webhooks/voice") return false;
    const started = Date.now();
    const log = (status: number, extra: Record<string, unknown> = {}): void => logger.info("http", { method, path, status, ms: Date.now() - started, surface: "borrower", ...extra });
    try {
      let m: RegExpExecArray | null;
      if (path === "/v1/borrower/lead" && method === "POST") { await leads.handle(req, res, url); return true; }   // 32.14 DELTA-11: no session — the anonymous minute (lead-routes.ts logs its own line)
      if (path === TALK_PATH && method === "POST") { await talk.handle(req, res); return true; }   // Talk: no session needed; the lead cookie and, after sign-in, the bearer (talk.ts logs its own line)
      if (method === "POST" && path === "/v1/borrower/auth/otp") await otp(req, res);
      else if (method === "POST" && path === "/v1/borrower/auth/account") await account(req, res);   // 32.16 DELTA-29
      else if (method === "POST" && path === "/v1/borrower/auth/passkey") await passkey(req, res);
      else if (method === "POST" && path === "/v1/borrower/auth/oidc") await oidc(req, res);
      else if (method === "POST" && path === "/v1/borrower/auth/l2") await stepUpL2(req, res);
      else if (method === "POST" && path === "/v1/borrower/identity/stripe/session") await identitySession(req, res);
      else if (method === "POST" && path === "/v1/webhooks/stripe") await stripeWebhook(req, res);
      else if (method === "POST" && path === "/v1/webhooks/truv") await truvWebhook(req, res);
      else if (method === "POST" && path === "/v1/webhooks/sms") send(res, 200, "sms_webhook", await channels.sms(req));
      else if (method === "POST" && path === "/v1/webhooks/voice") send(res, 200, "voice_webhook", await channels.voice(req));
      else if (method === "POST" && path === "/v1/borrower/voice/session") await voiceSession(req, res);
      else if (method === "POST" && (m = /^\/v1\/borrower\/connect\/([a-z_]+)\/session$/.exec(path))) await connectSession(req, res, m[1]!);
      else if (method === "GET" && path === "/v1/borrower/me") await me(req, res);
      else if (method === "GET" && (m = /^\/v1\/borrower\/deeplink\/([^/]+)$/.exec(path))) await deepLink(req, res, decodeURIComponent(m[1]!));
      else if (method === "POST" && path === "/v1/borrower/documents") await uploadDocument(req, res);
      else if (method === "GET" && (m = /^\/v1\/borrower\/documents\/([^/]+)\/content$/.exec(path))) await documentContent(req, res, url, decodeURIComponent(m[1]!));
      else if (method === "GET" && (m = /^\/v1\/borrower\/documents\/([^/]+)$/.exec(path))) await documentLink(req, res, decodeURIComponent(m[1]!));
      else if (method === "GET" && path === "/v1/borrower/record") await record(req, res, url);
      else if (method === "GET" && path === "/v1/borrower/thread") await thread(req, res, url);
      else if (method === "GET" && (m = /^\/v1\/borrower\/history\/([a-z]+)$/.exec(path))) await history(req, res, url, m[1]!);
      else if (method === "GET" && path === "/v1/borrower/stream") { await stream(req, res, url); log(200, { stream: true }); return true; }
      else if (method === "POST" && path === "/v1/borrower/messages") await message(req, res);
      else if (method === "POST" && (m = /^\/v1\/borrower\/cards\/([^/]+)\/resolve$/.exec(path))) await resolveCard(req, res, decodeURIComponent(m[1]!));
      else if (method === "POST" && (m = /^\/v1\/borrower\/commands\/([^/]+)$/.exec(path))) await command(req, res, decodeURIComponent(m[1]!));
      else { send(res, 404, "error", new BorrowerError(404, "NOT_FOUND").body()); log(404); return true; }
      log(res.statusCode);
    } catch (e) {
      const be = toBorrowerError(e);
      if (be.status >= 500) logger.error("borrower.unhandled", { method, path, error: e });
      // 32.16 §2.0 / 01 §5: a money command refused for want of a fresh code sends one (mobile if on file, else the e-mail) — the refusal body is unchanged
      if (be.code === "FRESH_L1_REQUIRED") await sendFreshL1Code(req, now()).catch((err) => logger.error("borrower.fresh_l1.code_failed", { error: err instanceof Error ? err.message : String(err) }));
      send(res, be.status, "error", be.body());
      log(be.status, { code: be.code, ...(be.gate ? { gate: be.gate } : {}), reason: be.message });
    }
    return true;
  }
  return { handle, auth, ui, stripe, blobs, truv, hub, commands, reader, flows, oidc: oidcPort, channels, talk };
}
