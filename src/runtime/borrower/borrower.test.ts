/**
 * The borrower API's identity seam over HTTP against Postgres (docs/ux/01-foundations.md §5, 02 §6–§7, 13 §1/§3):
 * sessions and levels, one-time codes through the FAKE delivery adapter, passkeys through the server-side WebAuthn
 * verifier, L2 from application_borrowers, L3 through the FAKE Stripe Identity webhook (22.6's own op; SM_IDENTITY_IAL2_GATE
 * satisfies; prefill rows carry source=stripe_identity), party scoping, the fresh-L1 guard, deep-link expiry, document
 * upload through 22.1 and the signed URL, and the `{code, gate?, copy_key}` error contract. Skips without a database.
 * Titles are plain for now; the 32.2-Tn ids land when the section is registered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../app.ts";
import { createApiServer, listen } from "../server.ts";
import { createLogger } from "../log.ts";
import { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import { PgBorrowerSessionRepository } from "../../infra/db/borrower-sessions.ts";
import { FakeStripeIdentity } from "./vendors/fake-stripe-identity.ts";
import { BorrowerError } from "./errors.ts";
import { hasFreshL1, requireFreshL1, sessionExpiry } from "./auth.ts";
import { b64url } from "./webauthn.ts";
import { FORBIDDEN_FIELDS } from "./serialize.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
const T0 = "2026-10-05T17:41:00.000Z";
const clock = new FixedClock(T0);
const stripe = new FakeStripeIdentity();
const lines: string[] = [];

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = ""; let appA = ""; let appB = ""; let abA = ""; let abB = "";
const EMAIL_A = `avery-${R}@example.test`; const PHONE_B = `+1602555${R.replace(/\D/g, "").padEnd(4, "7").slice(0, 4)}`;

test.before(async () => {
  if (skip) return;
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", (l) => lines.push(l)), console: false, borrower: { stripe, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number) VALUES ('servicer', $1, '123456789') RETURNING id`, [`Lender ${R}`]))[0]!.id;
  const open = async (borrowers: unknown[], addr: string) => {
    const r = await ops("POST", "/v1/applications", { actor: { kind: "agent", id: "intake" }, application: { partner_party_id: partnerPartyId, channel: "organic", transaction_type: "limited_cash_out", occupancy: "primary", borrowers, property: { address_line1: addr, city: "Phoenix", state: "AZ", postal_code: "85018" } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const app = r.body["application"] as { id: string; borrowers: { id: string }[] };
    return { id: app.id, ab: app.borrowers[0]!.id };
  };
  const a = await open([{ legal_name: "Avery Fixture", tin_last4: "1234", date_of_birth: "1988-04-12", contact: { email: EMAIL_A } }], "4821 E Camelback Rd"); appA = a.id; abA = a.ab;
  const b = await open([{ legal_name: "Blake Other", tin_last4: "9876", date_of_birth: "1979-01-02", contact: { phone: PHONE_B } }], "1 Other St"); appB = b.id; abB = b.ab;
  // the IAL2 gate arms on application.received (22.6 timers) — the record every borrower application carries once the six items are in
  for (const id of [appA, appB]) await runtime.uow.run({ applicationId: id }, (ctx) => ctx.events.append({ type: "application.received", applicationId: id, aggregate: { kind: "application", id }, actor: { kind: "agent", id: "intake" }, payload: { application_id: id, received_at: T0 } }), { clock });
});
test.after(async () => { if (!skip) await close(); });

type Reply = { status: number; body: Record<string, unknown>; headers: Headers };
async function ops(method: string, path: string, body?: unknown): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown>, headers: r.headers };
}
async function api(method: string, path: string, body?: unknown, token?: string, extraHeaders: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...extraHeaders }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: r.headers };
}
/** L1 through the FAKE code path: request → the code comes back in the body (nonprod) → verify → session token. */
async function signIn(channel: "sms" | "email", destination: string): Promise<{ token: string; session: Record<string, unknown>; party: Record<string, unknown> }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel, destination });
  assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["delivery"], "FAKE");
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return { token: ver.body["token"] as string, session: ver.body["session"] as Record<string, unknown>, party: ver.body["party"] as Record<string, unknown> };
}
const errorShape = (b: Record<string, unknown>, code: string): void => { assert.equal(b["code"], code, JSON.stringify(b)); assert.equal(typeof b["copy_key"], "string"); for (const k of Object.keys(b)) assert.ok(["code", "gate", "copy_key"].includes(k), `error carries only code/gate/copy_key, not ${k}`); };

test("one-time codes: the code goes out through the platform's e-delivery adapter (FAKE in nonprod, marked in the body), a wrong code is refused, the right one opens an L1 session keyed to the party the destination belongs to", { skip }, async () => {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: EMAIL_A });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  assert.equal(req.body["delivery"], "FAKE"); assert.match(String(req.body["fake_code"]), /^\d{6}$/); assert.equal(req.body["channel"], "email");
  assert.ok(lines.some((l) => l.includes("borrower.otp.requested") && l.includes('"vendor":"FAKE"')), "the adapter call is logged as FAKE");
  const sent = [...runtime.ports.edelivery!.constructor === Object ? [] : (runtime.ports.edelivery as unknown as { messages: Map<string, { message: { channel: string; to: string } }> }).messages.values()].filter((m) => m.message.to === EMAIL_A);
  assert.ok(sent.length >= 1, "FakeEdelivery carried the code"); assert.equal(sent[0]!.message.channel, "email");
  const wrong = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: "000000" });
  assert.equal(wrong.status, 401); errorShape(wrong.body, "OTP_INVALID");
  const ok = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body["level"], "L1"); assert.equal(typeof ok.body["token"], "string");
  const session = ok.body["session"] as Record<string, unknown>; assert.equal(session["auth_method"], "otp_email"); assert.equal(session["fresh_l1"], true);
  assert.ok(!("token_hash" in session) && !("ip" in session), "the session shape carries no hash or address");
  // the code proved possession of the application borrower's e-mail: that row is now this party's, and the application is a subject
  const me = await api("GET", "/v1/borrower/me", undefined, ok.body["token"] as string);
  assert.equal(me.status, 200);
  const subjects = me.body["subjects"] as { application_id: string; stage: string; role: string }[];
  assert.ok(subjects.some((s) => s.application_id === appA && s.stage === "origination" && s.role === "borrower"), JSON.stringify(subjects));
  assert.ok(!subjects.some((s) => s.application_id === appB), "another party's application is not a subject");
  const [ab] = await db.query<{ party_id: string | null }>(`SELECT party_id FROM application_borrowers WHERE id = $1`, [abA]);
  assert.equal(ab!.party_id, (me.body["party"] as { party_id: string }).party_id);
  // a second code is spent once; replaying it is refused
  const replay = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(replay.status, 401); errorShape(replay.body, "OTP_INVALID");
  // the ops API token is not a borrower credential; no session → AUTH_REQUIRED with a copy key and nothing else
  const noAuth = await api("GET", "/v1/borrower/me", undefined, TOKEN);
  assert.equal(noAuth.status, 401); errorShape(noAuth.body, "AUTH_REQUIRED");
});

test("sessions expire 30 minutes idle before funding (SESSION_EXPIRED), and the expiry policy is 7 days only for a passkey session on a serviced loan", { skip }, async () => {
  const s = await signIn("email", EMAIL_A);
  clock.set("2026-10-05T18:00:00.000Z");
  assert.equal((await api("GET", "/v1/borrower/me", undefined, s.token)).status, 200, "19 minutes idle is fine");
  clock.set("2026-10-05T18:31:00.000Z");
  const expired = await api("GET", "/v1/borrower/me", undefined, s.token);
  assert.equal(expired.status, 401); errorShape(expired.body, "SESSION_EXPIRED");
  clock.set(T0);
  const origination = [{ application_id: appA, loan_id: null, role: "borrower", stage: "origination" as const, label: "x", application_borrower_id: abA }];
  const servicing = [{ application_id: null, loan_id: randomUUID(), role: "borrower", stage: "servicing" as const, label: "x", application_borrower_id: null }];
  assert.equal(sessionExpiry("otp_email", origination, T0), "2026-10-05T18:11:00.000Z");
  assert.equal(sessionExpiry("passkey", origination, T0), "2026-10-05T18:11:00.000Z", "a passkey before funding still idles out at 30 minutes");
  assert.equal(sessionExpiry("passkey", servicing, T0), "2026-10-12T17:41:00.000Z", "7 days with a passkey in servicing");
  assert.equal(sessionExpiry("otp_phone", servicing, T0), "2026-10-05T18:11:00.000Z");
});

test("fresh-L1 guard: money movement needs a code verified within 10 minutes; a passkey sign-in has none; re-verifying a code on the live session refreshes it without a new session", { skip }, async () => {
  clock.set(T0);
  const s = await signIn("email", EMAIL_A);
  const repo = new PgBorrowerSessionRepository(db);
  const row = (await repo.get(s.session["session_id"] as string))!;
  assert.equal(hasFreshL1(row, T0), true); assert.doesNotThrow(() => requireFreshL1(row, "2026-10-05T17:50:59.000Z"));
  assert.throws(() => requireFreshL1(row, "2026-10-05T17:52:00.000Z"), (e: unknown) => e instanceof BorrowerError && e.code === "FRESH_L1_REQUIRED" && e.status === 403 && e.body().copy_key === "auth.fresh_code");
  clock.set("2026-10-05T17:55:00.000Z");
  assert.equal(((await api("GET", "/v1/borrower/me", undefined, s.token)).body["session"] as { fresh_l1: boolean }).fresh_l1, false);
  // a fresh code presented with the bearer: same session, last_l1_at moves
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: EMAIL_A });
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, s.token);
  assert.equal(ver.status, 200, JSON.stringify(ver.body)); assert.equal(ver.body["token"], s.token);
  assert.equal(hasFreshL1((await repo.get(s.session["session_id"] as string))!, "2026-10-05T17:55:00.000Z"), true);
  // a code for another party's destination never refreshes this session
  const other = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "sms", destination: PHONE_B });
  const cross = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: other.body["challenge_id"], code: other.body["fake_code"] }, s.token);
  assert.equal(cross.status, 403); errorShape(cross.body, "PARTY_SCOPE");
  clock.set(T0);
});

// ───────────────────────────── a tiny CBOR encoder for the WebAuthn fixtures (the server decodes; a real authenticator encodes)
type C = number | string | Buffer | CList | CMap | CObj;
interface CList extends Array<C> {}
interface CMap extends Map<C, C> {}
interface CObj { [k: string]: C; }
function cbor(v: C): Buffer {
  const head = (major: number, n: number): Buffer => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : n < 65536 ? Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([(major << 5) | 26]), Buffer.from(new Uint32Array([n]).buffer).reverse()]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  const entries = Object.entries(v); return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}
const sha = (s: string | Buffer): Buffer => createHash("sha256").update(s).digest();

test("passkeys: WebAuthn registration parses the attestation object (COSE P-256 → JWK; attestation statement FAKE-accepted) and an assertion verifies the ES256 signature, opening an L1 session without a fresh code", { skip }, async () => {
  const s = await signIn("email", EMAIL_A);
  const opts = await api("POST", "/v1/borrower/auth/passkey", { action: "register_options" }, s.token);
  assert.equal(opts.status, 200, JSON.stringify(opts.body)); assert.equal((opts.body["rp"] as { id: string }).id, "localhost");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const cose = new Map<C, C>([[1, 2], [3, -7], [-1, 1], [-2, b64url.decode(jwk.x)], [-3, b64url.decode(jwk.y)]]);
  const credId = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
  const authData = Buffer.concat([sha("localhost"), Buffer.from([0x41]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([credId.length >> 8, credId.length & 0xff]), credId, cbor(cose)]);
  const clientData = (type: string, challenge: string) => b64url.encode(Buffer.from(JSON.stringify({ type, challenge, origin: "http://localhost" })));
  const attestationObject = b64url.encode(cbor({ fmt: "none", attStmt: {}, authData }));
  const bad = await api("POST", "/v1/borrower/auth/passkey", { action: "register", challenge_id: opts.body["challenge_id"], credential: { id: b64url.encode(credId), response: { clientDataJSON: clientData("webauthn.create", "not-the-challenge"), attestationObject } } }, s.token);
  assert.equal(bad.status, 401); errorShape(bad.body, "PASSKEY_INVALID");
  const reg = await api("POST", "/v1/borrower/auth/passkey", { action: "register", challenge_id: opts.body["challenge_id"], credential: { id: b64url.encode(credId), response: { clientDataJSON: clientData("webauthn.create", opts.body["challenge"] as string), attestationObject, transports: ["internal"] } } }, s.token);
  assert.equal(reg.status, 200, JSON.stringify(reg.body)); assert.equal(reg.body["attestation_verified"], "FAKE"); assert.equal(reg.body["algorithm"], -7);
  const [stored] = await db.query<{ public_key_jwk: { kty: string; crv: string } }>(`SELECT public_key_jwk FROM passkey_credentials WHERE passkey_id = $1`, [reg.body["passkey_id"] as string]);
  assert.deepEqual([stored!.public_key_jwk.kty, stored!.public_key_jwk.crv], ["EC", "P-256"]);
  // sign in with the passkey: no session, no code
  const ao = await api("POST", "/v1/borrower/auth/passkey", { action: "assert_options" });
  assert.equal(ao.status, 200);
  const authData2 = Buffer.concat([sha("localhost"), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
  const cdj = clientData("webauthn.get", ao.body["challenge"] as string);
  const signature = b64url.encode(cryptoSign("sha256", Buffer.concat([authData2, sha(b64url.decode(cdj))]), { key: privateKey, dsaEncoding: "der" }));
  const forged = await api("POST", "/v1/borrower/auth/passkey", { action: "assert", challenge_id: ao.body["challenge_id"], credential: { id: b64url.encode(credId), response: { clientDataJSON: cdj, authenticatorData: b64url.encode(authData2), signature: b64url.encode(Buffer.from(b64url.decode(signature).map((b, i) => (i === 10 ? b ^ 0xff : b)))) } } });
  assert.equal(forged.status, 401); errorShape(forged.body, "PASSKEY_INVALID");
  const ok = await api("POST", "/v1/borrower/auth/passkey", { action: "assert", challenge_id: ao.body["challenge_id"], credential: { id: b64url.encode(credId), response: { clientDataJSON: cdj, authenticatorData: b64url.encode(authData2), signature } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const session = ok.body["session"] as Record<string, unknown>;
  assert.equal(session["auth_method"], "passkey"); assert.equal(session["fresh_l1"], false, "a passkey sign-in is L1 without a code: money movement will ask for one");
  assert.equal((ok.body["party"] as { party_id: string }).party_id, (s.party as { party_id: string }).party_id);
  const [pk] = await db.query<{ sign_count: bigint }>(`SELECT sign_count FROM passkey_credentials WHERE passkey_id = $1`, [reg.body["passkey_id"] as string]);
  assert.equal(pk!.sign_count, 1n);
});

test("L2: SSN last 4 + date of birth are matched against the party's own application_borrowers row; a mismatch is refused without echoing anything; the level rises on the session", { skip }, async () => {
  const s = await signIn("email", EMAIL_A);
  const miss = await api("POST", "/v1/borrower/auth/l2", { ssn_last4: "9876", date_of_birth: "1979-01-02" }, s.token);   // Blake's facts, Avery's session
  assert.equal(miss.status, 403); errorShape(miss.body, "L2_MATCH_FAILED");
  const hit = await api("POST", "/v1/borrower/auth/l2", { ssn_last4: "1234", date_of_birth: "1988-04-12" }, s.token);
  assert.equal(hit.status, 200, JSON.stringify(hit.body)); assert.equal(hit.body["level"], "L2");
  assert.equal((await api("GET", "/v1/borrower/me", undefined, s.token)).body["level"], "L2");
  assert.ok(lines.filter((l) => l.includes("borrower.l2.attempt")).every((l) => !l.includes("1234") && !l.includes("1988-04-12")), "the values are never logged");
});

test("L3: the Stripe Identity session opens a ConnectCard; the FAKE webhook records the result through 22.6's verifyIdentity (identity.verified satisfies SM_IDENTITY_IAL2_GATE), writes name/DOB/address to application_borrowers.prefill as source=stripe_identity pending confirmation, and raises the party's sessions to L3", { skip }, async () => {
  const s = await signIn("email", EMAIL_A);
  const armed = await db.query<{ status: string }>(`SELECT status FROM timers WHERE application_id = $1 AND code = 'SM_IDENTITY_IAL2_GATE'`, [appA]);
  assert.equal(armed[0]?.status, "armed", "the gate armed on application.received");
  const vs = await api("POST", "/v1/borrower/identity/stripe/session", { application_id: appA }, s.token);
  assert.equal(vs.status, 200, JSON.stringify(vs.body));
  assert.equal(vs.body["vendor"], "stripe_identity"); assert.equal(vs.body["delivery"], "FAKE"); assert.match(String(vs.body["vendor_session_id"]), /^vs_FAKE_/);
  assert.ok(stripe.log.some((l) => l.op === "create_session" && l.vendor === "FAKE"), "the vendor fake logs vendor: FAKE");
  const card = await new PgBorrowerUiRepository(db).card(vs.body["card_instance_id"] as string);
  assert.equal(card?.kind, "ConnectCard"); assert.equal(card?.status, "pending"); assert.equal(card?.copy_key, "identity.stripe.purpose");
  // the webhook must carry the vendor signature (FAKE for the fake adapter)
  const unsigned = await api("POST", "/v1/webhooks/stripe", { id: "evt_1", type: "identity.verification_session.verified", data: { object: { id: vs.body["vendor_session_id"], status: "verified" } } });
  assert.equal(unsigned.status, 400); errorShape(unsigned.body, "BAD_REQUEST");
  clock.set("2026-10-05T17:45:00.000Z");
  const hook = await api("POST", "/v1/webhooks/stripe", { id: "evt_2", type: "identity.verification_session.verified", data: { object: { id: vs.body["vendor_session_id"], status: "verified" } } }, undefined, { "stripe-signature": "FAKE" });
  assert.equal(hook.status, 200, JSON.stringify(hook.body));
  assert.equal(hook.body["outcome"], "verified"); assert.equal(hook.body["level"], "L3"); assert.equal(hook.body["all_borrowers_verified"], true); assert.equal(hook.body["gate_open"], true);
  assert.deepEqual(hook.body["prefilled"], ["legal_name", "date_of_birth", "address"]);
  // 22.6's op, on the bus, keyed by the application: identity.verified with the vendor and level; the gate timer satisfied
  const ev = await db.query<{ type: string; payload: Record<string, unknown> }>(`SELECT type, payload FROM loan_events WHERE application_id = $1 AND type = 'identity.verified'`, [appA]);
  assert.equal(ev.length, 1); assert.equal(ev[0]!.payload["vendor"], "stripe_identity"); assert.equal(ev[0]!.payload["level"], "ial2_remote_doc_biometric"); assert.equal(ev[0]!.payload["all_borrowers_verified"], true);
  const gate = await db.query<{ status: string }>(`SELECT status FROM timers WHERE application_id = $1 AND code = 'SM_IDENTITY_IAL2_GATE'`, [appA]);
  assert.equal(gate[0]?.status, "satisfied");
  const ver = await db.query<{ data: Record<string, unknown> }>(`SELECT data FROM entity_records WHERE kind = 'verifications' AND application_id = $1`, [appA]);
  assert.ok(ver.some((v) => v.data["vendor"] === "stripe_identity" && v.data["outcome"] === "verified"), "the 22.6 verifications record persisted through the runtime's entity store");
  // source=stripe_identity rows on application_borrowers: extracted, not confirmed
  const [ab] = await db.query<{ legal_name: string; prefill: Record<string, { value: string; source: string; confirmed_at: null }> }>(`SELECT legal_name, prefill FROM application_borrowers WHERE id = $1`, [abA]);
  for (const path of ["legal_name", "date_of_birth", "address"]) { assert.equal(ab!.prefill[path]!.source, "stripe_identity", path); assert.equal(ab!.prefill[path]!.confirmed_at, null, `${path} awaits the ConfirmCard`); }
  assert.equal(ab!.prefill["legal_name"]!.value, "Avery Fixture"); assert.equal(ab!.prefill["date_of_birth"]!.value, "1988-04-12");
  assert.equal(ab!.legal_name, "Avery Fixture", "the submitted field is untouched until confirmation (O2.1 rule 1)");
  // the party's live session is L3 now; the card resolved with the vendor evidence; the ui_events trail
  assert.equal((await api("GET", "/v1/borrower/me", undefined, s.token)).body["level"], "L3");
  const resolved = await new PgBorrowerUiRepository(db).card(vs.body["card_instance_id"] as string);
  assert.equal(resolved?.status, "resolved"); assert.equal((resolved?.evidence as { outcome: string }).outcome, "connected");
  const kinds = (await new PgBorrowerUiRepository(db).uiEvents((s.party as { party_id: string }).party_id)).map((e) => e.kind);
  assert.ok(kinds.includes("connector_started") && kinds.includes("connector_completed"), kinds.join(","));
  assert.ok(lines.some((l) => l.includes("borrower.identity.webhook") && l.includes('"vendor":"FAKE"')));
  // a second application on which Blake is the only borrower is untouched: identity is per party
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM timers WHERE application_id = $1 AND code = 'SM_IDENTITY_IAL2_GATE'`, [appB]))[0]?.status, "armed");
  clock.set(T0);
});

test("documents: a multipart upload lands in `documents` and goes through 22.1's ingestDocument (document.received keyed by the application); the signed URL is bound to the session, expires, and logs ui_events{document_opened}; party scoping refuses another party's subject", { skip }, async () => {
  clock.set(T0);
  const a = await signIn("email", EMAIL_A);
  const b = await signIn("sms", PHONE_B);
  const boundary = "----sm" + R;
  const part = (name: string, value: string, file?: { filename: string; type: string }) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file ? `; filename="${file.filename}"` : ""}\r\n${file ? `Content-Type: ${file.type}\r\n` : ""}\r\n${value}\r\n`;
  const body = (appId: string) => part("application_id", appId) + part("document_class", "paystub") + part("file", "%PDF-1.4 paystub bytes " + R, { filename: "paystub.pdf", type: "application/pdf" }) + `--${boundary}--\r\n`;
  const upload = (token: string, appId: string) => fetch(base + "/v1/borrower/documents", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` }, body: body(appId) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
  // Blake may not upload against Avery's application (02 §6): refused before anything is written
  const cross = await upload(b.token, appA);
  assert.equal(cross.status, 403); errorShape(cross.body, "PARTY_SCOPE");
  const up = await upload(a.token, appA);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body["status"], "received"); assert.equal(up.body["quarantined"], false); assert.equal(up.body["doc_class"], "paystub");
  const docId = up.body["document_id"] as string;
  const [row] = await db.query<{ source_channel: string; application_id: string; subject_borrower_id: string; storage_uri: string; byte_size: bigint }>(`SELECT source_channel, application_id, subject_borrower_id, storage_uri, byte_size FROM documents WHERE id = $1`, [docId]);
  assert.equal(row!.source_channel, "borrower_upload"); assert.equal(row!.application_id, appA); assert.equal(row!.subject_borrower_id, abA); assert.equal(row!.storage_uri, `fake-blob://${docId}`);
  const ev = await db.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM loan_events WHERE application_id = $1 AND type = 'document.received'`, [appA]);
  assert.ok(ev.some((e) => e.payload["document_id"] === docId && e.payload["source_channel"] === "borrower_upload"), "22.1's document.received on the application's log");
  // the signed URL: session-bound, 5 minutes, logged
  const link = await api("GET", `/v1/borrower/documents/${docId}`, undefined, a.token);
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const url = link.body["url"] as string; assert.match(url, /^\/v1\/borrower\/documents\/[0-9a-f-]+\/content\?exp=\d+&sig=/);
  const opened = (await new PgBorrowerUiRepository(db).uiEvents((a.party as { party_id: string }).party_id, "document_opened")).filter((e) => e.payload["document_id"] === docId);
  assert.equal(opened.length, 1); assert.equal(opened[0]!.session_id, a.session["session_id"]);
  const content = await fetch(base + url, { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(content.status, 200); assert.equal(content.headers.get("content-type"), "application/pdf"); assert.equal(await content.text(), "%PDF-1.4 paystub bytes " + R);
  const otherSession = await signIn("email", EMAIL_A);
  const stolen = await fetch(base + url, { headers: { authorization: `Bearer ${otherSession.token}` } });
  assert.equal(stolen.status, 403, "the same party on another session cannot use this session's URL");
  clock.set("2026-10-05T17:47:00.000Z");
  assert.equal((await fetch(base + url, { headers: { authorization: `Bearer ${a.token}` } })).status, 410, "the URL is short-lived");
  clock.set(T0);
  // Blake's session: Avery's document is outside scope → PARTY_SCOPE, never a 404 that confirms it exists; an unknown id answers the same
  const scoped = await api("GET", `/v1/borrower/documents/${docId}`, undefined, b.token);
  assert.equal(scoped.status, 403); errorShape(scoped.body, "PARTY_SCOPE");
  assert.equal((await api("GET", `/v1/borrower/documents/${randomUUID()}`, undefined, b.token)).status, 403);
  // Blake's own upload on Blake's application works; the two parties' documents never cross
  const upB = await upload(b.token, appB);
  assert.equal(upB.status, 201, JSON.stringify(upB.body));
  assert.equal((await api("GET", `/v1/borrower/documents/${upB.body["document_id"]}`, undefined, a.token)).status, 403);
});

test("deep links: a token resolves to its target only after L1, for its own party, until it expires 7 days on; the token encodes nothing about the loan", { skip }, async () => {
  clock.set(T0);
  const a = await signIn("email", EMAIL_A); const b = await signIn("sms", PHONE_B);
  const ui = new PgBorrowerUiRepository(db);
  const conv = await ui.conversationFor((a.party as { party_id: string }).party_id);
  const card = await ui.createCard({ conversation_id: conv.conversation_id, party_id: conv.party_id, subject_application_id: appA, kind: "ConfirmCard", created_by: "agent:intake", copy_key: "identity.confirm.title", now: T0 });
  const link = await ui.createDeepLink({ party_id: conv.party_id, target: { card_instance_id: card.card_instance_id }, now: T0 });
  assert.equal(link.expires_at, "2026-10-12T17:41:00.000Z");
  assert.ok(!link.token.includes(appA.slice(0, 8)) && !link.token.includes(card.card_instance_id.slice(0, 8)) && link.token.length >= 32, "an opaque random token");
  const anon = await api("GET", `/v1/borrower/deeplink/${link.token}`);
  assert.equal(anon.status, 401); errorShape(anon.body, "AUTH_REQUIRED"); assert.ok(!("target" in anon.body), "no loan data before L1");
  const other = await api("GET", `/v1/borrower/deeplink/${link.token}`, undefined, b.token);
  assert.equal(other.status, 403); errorShape(other.body, "PARTY_SCOPE");
  const ok = await api("GET", `/v1/borrower/deeplink/${link.token}`, undefined, a.token);
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.deepEqual(ok.body["target"], { card_instance_id: card.card_instance_id });
  assert.equal((await ui.uiEvents(conv.party_id, "deep_link_opened")).filter((e) => e.card_instance_id === card.card_instance_id).length, 1);
  clock.set("2026-10-12T17:41:00.000Z");
  const a2 = await signIn("email", EMAIL_A);   // a fresh session on day 7: the link, not the session, is what expired
  const late = await api("GET", `/v1/borrower/deeplink/${link.token}`, undefined, a2.token);
  assert.equal(late.status, 410); errorShape(late.body, "DEEP_LINK_EXPIRED");
  clock.set(T0);
  const unknown = await api("GET", `/v1/borrower/deeplink/nope`, undefined, a.token);
  assert.equal(unknown.status, 404); errorShape(unknown.body, "DEEP_LINK_UNKNOWN");
});

test("contract (13 §3 T-X-03 as far as this stage goes): no /v1/borrower/* response carries a field named after the restricted tables; a bus refusal answers {code, gate, copy_key}", { skip }, async () => {
  const a = await signIn("email", EMAIL_A);
  const walk = (v: unknown, into: Set<string>): void => { if (Array.isArray(v)) v.forEach((x) => walk(x, into)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { into.add(k); walk(x, into); } };
  const seen = new Set<string>();
  for (const r of [await api("GET", "/v1/borrower/me", undefined, a.token), await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: EMAIL_A }), await api("POST", "/v1/borrower/identity/stripe/session", {}, a.token)]) { assert.equal(r.status, 200, JSON.stringify(r.body)); walk(r.body, seen); }
  for (const f of FORBIDDEN_FIELDS) assert.ok(!seen.has(f), `${f} leaked`);
  // a restricted table's column counts as restricted unless it is also an ordinary column of some non-restricted table (id, status, document_id, …)
  const cols = await db.query<{ column_name: string }>(`SELECT DISTINCT column_name FROM information_schema.columns WHERE table_schema IN ('public', 'restricted_fl') AND (table_name IN ('du_findings_interpretations', 'risk_assessment', 'credit_reports', 'compliance_test_runs', 'applicant_demographics') OR table_name LIKE 'qc\\_%' OR table_name LIKE 'fraud\\_%')
    AND column_name NOT IN (SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND NOT (table_name IN ('du_findings_interpretations', 'risk_assessment', 'credit_reports', 'compliance_test_runs') OR table_name LIKE 'qc\\_%' OR table_name LIKE 'fraud\\_%'))`);
  assert.ok(cols.length > 20, "the restricted tables have columns of their own");
  for (const c of cols) assert.ok(!seen.has(c.column_name), `${c.column_name} (a restricted-table column) leaked`);
});
