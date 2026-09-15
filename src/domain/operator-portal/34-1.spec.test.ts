// 34.1 Staff sign-in and roles: accounts, the doors, the action log, the access review
// spec/sections/34-operator-portal/34-1-staff-sign-in-and-roles-accounts-the-doors-the-action-log-the-access-review.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness: own database `<base>_34_1` (dropped, created, migrated), the API server of src/runtime/server.ts in-process
// with the ops console mounted at /ops and /ops/api (createApiServer's default `console`), the FAKE e-delivery port (the
// code is echoed as `fake_code` outside production, exactly as the borrower doors), a FixedClock the tests advance (30 idle
// minutes for T3, 11 minutes past the code window for T7, 91 days for T8's sweep). Every request the tests send to
// /ops/api/* is recorded so T6 can compare the action log row for row. The passkey fixtures (a P-256 credential, attestation
// `none`, the tiny CBOR encoder) are the borrower suites' (src/runtime/borrower/borrower.test.ts, 32-14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { b64url } from "../../runtime/borrower/webauthn.ts";
import { bootstrapStaffAdmin, STAFF_IDLE_MINUTES, STAFF_LOCK_AFTER_FAILURES, STAFF_PASSWORD_MIN_LENGTH, STAFF_POSSESSION_MINUTES, STAFF_RULE_SET_VERSION, STAFF_MODEL_VERSION, STAFF_PROMPT_VERSION, STAFF_INVITATION_TEMPLATE } from "../../runtime/staff/auth.ts";
import { ACCESS_REVIEW_DAYS } from "../../runtime/staff/roles.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
/** 2026-09-14 08:00 America/New_York; the review clock resolves end of day ET (src/kernel/timers/engine.ts endOfDay). */
const T0 = "2026-09-14T12:00:00.000Z";
const clock = new FixedClock(T0);
const at = (ms: number): string => new Date(Date.parse(clock.now()) + ms).toISOString();
const MIN = 60_000; const DAY = 86_400_000;
type Json = Record<string, unknown>;

// the people: the bootstrap admin, the colleague of T1/T2 (locked in T3, promoted in T5, demoted by T8's review), the officer of T4 (disabled by T8's review)
const ADA = { email: `ada.admin.${R}@example.test`, name: "Ada Admin", password: `ada-correct-horse-${R}` };
const OLI = { email: `oli.analyst.${R}@example.test`, name: "Oli Analyst", password: `oli-analyst-pass-${R}` };
const ORA = { email: `ora.officer.${R}@example.test`, name: "Ora Officer", password: `ora-officer-pass-${R}` };
const BEA = { email: `bea.admin.${R}@example.test`, name: "Bea Admin", password: `bea-second-admin-${R}` };       // T5: the second admin of the simultaneous disable
const CARA = { email: `cara.compliance.${R}@example.test`, name: "Cara Compliance", password: `cara-reviewer-pass-${R}` };   // T5: the reviewer who may not remove the last admin
let adaId = ""; let oliId = ""; let oraId = ""; let beaId = ""; let caraId = "";
let oliEnrolToken = "";   // T1's enrol token, spent by T2
let oliSessionId = "";    // T2's session, idled out in T3
const campaignId = `camp-34-1-${R}`;

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
const logLines: string[] = [];
/** Every request sent to the console's API (method + the route the action log records), for T6. */
const sent: { method: string; route: string }[] = [];
const edelivery = (): FakeEdelivery => runtime.ports.edelivery as FakeEdelivery;

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|staff|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) await close(); });

// ---------------------------------------------------------------- helpers over the API
type Reply = { status: number; body: Json; headers: Headers };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  if (path.startsWith("/ops/api/") || path.startsWith("/api/")) { const u = new URL(path, "http://x"); u.searchParams.delete("email"); sent.push({ method, route: u.pathname + u.search }); }
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.34.0.1", "user-agent": "34.1-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {}, headers: r.headers };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
/** The door's first half: a code to the e-mail (FAKE, echoed) verified into an enrol/step token — never a session. */
async function codeToken(email: string): Promise<{ token: string; body: Json; fake_code: string }> {
  const c = await api("POST", "/ops/api/auth/code", { email });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body["delivery"], "FAKE"); assert.equal(typeof c.body["fake_code"], "string");
  const v = await api("POST", "/ops/api/auth/verify", { email, code: c.body["fake_code"] });
  assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(typeof v.body["token"], "string"); assert.equal(v.body["session"], null);
  return { token: v.body["token"] as string, body: v.body, fake_code: c.body["fake_code"] as string };
}
/** Enrolment: the code, then the password on the enrol token (status invited → active). */
async function enrol(p: { email: string; password: string }): Promise<string> {
  const { token } = await codeToken(p.email);
  const r = await api("POST", "/ops/api/auth/password", { token, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["enrolled"], true);
  return r.body["staff_user_id"] as string;
}
/** A session: the code (possession) and the password (knowledge) — rule 1's two factors. */
async function signIn(p: { email: string; password: string }): Promise<{ token: string; session_id: string; staff_user_id: string; body: Json }> {
  await codeToken(p.email);
  const r = await api("POST", "/ops/api/auth/signin", { email: p.email, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body["token"] as string, session_id: r.body["session_id"] as string, staff_user_id: r.body["staff_user_id"] as string, body: r.body };
}
/** An admin invites; the invitee's id. */
async function invite(adminToken: string, p: { email: string; name: string }, roles: string[]): Promise<Json> {
  const r = await api("POST", "/ops/api/staff/invite", { email: p.email, legal_name: p.name, roles }, bearer(adminToken));
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["status"], "invited");
  return r.body;
}
type EventRow = { type: string; actor_kind: string; actor_id: string; actor_role: string | null; payload: Json; sequence: string; occurred_at: string };
const events = async (type: string): Promise<EventRow[]> => db.query<EventRow>(`SELECT type, actor_kind::text AS actor_kind, actor_id, actor_role, payload, sequence::text AS sequence, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 ORDER BY loan_events.sequence`, [type]);
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type UserRow = { id: string; email_hash: string; legal_name: string | null; roles: string[]; status: string; invited_by: string | null; enrolled_at: string | null; disabled_at: string | null; failed_signins: number; locked_until: string | null; row_text: string };
const userRow = async (id: string): Promise<UserRow> => (await db.query<UserRow>(`SELECT id::text AS id, email_hash, legal_name, roles, status, invited_by::text AS invited_by, enrolled_at::text AS enrolled_at, disabled_at::text AS disabled_at, failed_signins, locked_until::text AS locked_until, staff_users::text AS row_text FROM staff_users WHERE id = $1`, [id]))[0]!;
type SessionRow = { session_id: string; factors: string[]; created_at: string; last_seen_at: string; expires_at: string; revoked_at: string | null };
const ISO = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${col}`;
const sessionRow = async (id: string): Promise<SessionRow> => (await db.query<SessionRow>(`SELECT session_id::text AS session_id, factors, ${ISO("created_at")}, ${ISO("last_seen_at")}, ${ISO("expires_at")}, ${ISO("revoked_at")} FROM staff_sessions WHERE session_id = $1`, [id]))[0]!;
type DecisionRow = { id: string; agent: string; action: string; subject_kind: string | null; subject_id: string | null; rationale: string; approved_by: string | null; approved_role: string | null; rule_set_version: string; model_version: string | null; prompt_version: string | null; confidence: string | null };
const decisions = async (action: string): Promise<DecisionRow[]> => db.query<DecisionRow>(`SELECT id::text AS id, agent, action, subject_kind, subject_id, rationale, approved_by, approved_role, rule_set_version, model_version, prompt_version, confidence::text AS confidence FROM agent_decisions WHERE action = $1 ORDER BY created_at, id`, [action]);
type TimerRow = { id: string; status: string; anchor_date: string; due_date: string | null; due_at: string | null; satisfied_at: string | null; breached_at: string | null };
const reviewTimers = async (): Promise<TimerRow[]> => db.query<TimerRow>(`SELECT id::text AS id, status::text AS status, anchor_date::text AS anchor_date, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at FROM timers WHERE code = 'SM_STAFF_ACCESS_REVIEW_90' ORDER BY armed_at, id`);
const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

// ───────────────────────────── the WebAuthn fixtures (T7): a P-256 credential, attestation `none` — the borrower suites' encoder
type C = number | string | Buffer | CList | CMap | CObj;
interface CList extends Array<C> {}
interface CMap extends Map<C, C> {}
interface CObj { [k: string]: C; }
function cbor(v: C): Buffer {
  const head = (major: number, n: number): Buffer => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  const entries = Object.entries(v); return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}
const sha = (s: string | Buffer): Buffer => createHash("sha256").update(s).digest();
const clientData = (type: string, challenge: string): string => b64url.encode(Buffer.from(JSON.stringify({ type, challenge, origin: "http://localhost" })));

test("34.1-T1: Given the bootstrap admin, when they invite a colleague with roles `[ops_analyst]`, then a `staff_users{status=invited}` row exists with the e-mail hashed, `NTC_SM_STAFF_INVITATION` is sent to that e-mail (the FAKE port holds it, naming the inviter and the roles and no borrower data), `staff.invited` is logged without the e-mail, and the colleague's `POST /ops/api/auth/code` + `verify` yields an enrol token that opens no session (`GET /ops/api/me` with it answers 401).", { skip }, async () => {
  // the first admin (operational prerequisites): staff-bootstrap creates the only admin without an admin, once
  const boot = await bootstrapStaffAdmin(runtime, ADA.email, { legal_name: ADA.name });
  assert.equal(boot.created, true); adaId = boot.staff_user_id!;
  assert.equal((await bootstrapStaffAdmin(runtime, ADA.email, {})).created, false, "nothing else creates an admin without an admin");
  const ada = await userRow(adaId); assert.deepEqual([ada.status, ada.roles, ada.invited_by], ["invited", ["admin"], null]);
  assert.equal(await enrol(ADA), adaId);
  const admin = await signIn(ADA);
  assert.deepEqual(admin.body["roles"], ["admin"]);
  // the admin invites the colleague
  const messagesBefore = edelivery().messages.size;
  const inv = await invite(admin.token, OLI, ["ops_analyst"]);
  oliId = inv["staff_user_id"] as string;
  assert.deepEqual([inv["roles"], inv["invited_by"], inv["reinvited"], inv["bounced"], inv["held_reason"]], [["ops_analyst"], adaId, false, false, null]);
  assert.equal(typeof inv["notice_id"], "string");
  // the row: status invited, the e-mail hashed (sha-256 of the lowercased address), never in clear anywhere on the row
  const oli = await userRow(oliId);
  assert.deepEqual([oli.status, oli.roles, oli.legal_name, oli.invited_by, oli.enrolled_at], ["invited", ["ops_analyst"], OLI.name, adaId, null]);
  assert.equal(oli.email_hash, sha256hex(OLI.email.toLowerCase()));
  assert.ok(!oli.row_text.toLowerCase().includes(OLI.email.toLowerCase()), "the address is not on the row in clear");
  assert.equal(await count(`staff_users WHERE staff_users::text ILIKE $1`, [`%${OLI.email}%`]), 0);
  // NTC_SM_STAFF_INVITATION to that e-mail: the FAKE port holds it; it names the inviter and the roles, says a code will be sent, points at /ops, carries no borrower data
  const held = [...edelivery().messages.values()].filter((m) => m.message.to === OLI.email.toLowerCase());
  assert.equal(held.length, 1, "one message to the colleague"); assert.equal(edelivery().messages.size, messagesBefore + 1);
  assert.equal(held[0]!.message.channel, "email"); assert.equal(held[0]!.status, "sent");
  assert.match(held[0]!.message.subject, new RegExp(ADA.name)); assert.match(held[0]!.message.subject, /ops_analyst/);
  const notice = [...runtime.noticeMemory.values()].find((n) => n.templateCode === STAFF_INVITATION_TEMPLATE && n.id === inv["notice_id"]);
  assert.ok(notice, "the rendered invitation"); assert.equal(notice!.status, "sent"); assert.equal(notice!.checklist.passed, true);
  const text = notice!.rendered.text ?? "";
  assert.match(text, new RegExp(ADA.name)); assert.match(text, /ops_analyst/); assert.match(text, /\/ops\b/); assert.match(text, /a code will be sent to this e-mail/i);
  assert.doesNotMatch(text, /\$|\bloan\b|\bborrower\b|\bbalance\b|\brate\b|\bpayment\b/i, "no borrower data, no figure");
  assert.doesNotMatch(text, /@/, "the notice body carries no e-mail address");
  assert.equal(await count(`notices WHERE template_code = $1 AND id = $2`, [STAFF_INVITATION_TEMPLATE, inv["notice_id"]]), 1, "the notice row");
  // staff.invited without the e-mail
  const invited = (await events("staff.invited")).filter((e) => e.payload["staff_user_id"] === oliId);
  assert.equal(invited.length, 1);
  assert.deepEqual([invited[0]!.actor_kind, invited[0]!.actor_id, invited[0]!.actor_role], ["human", adaId, "admin"]);
  assert.deepEqual([invited[0]!.payload["invited_by"], invited[0]!.payload["roles"], invited[0]!.payload["origination"]], [adaId, ["ops_analyst"], true]);
  assert.doesNotMatch(JSON.stringify(invited[0]!.payload), /@/); assert.doesNotMatch(JSON.stringify(invited[0]!.payload), new RegExp(OLI.name));
  for (const e of await db.query<{ payload: Json }>(`SELECT payload FROM loan_events WHERE type LIKE 'staff.%'`)) assert.doesNotMatch(JSON.stringify(e.payload), /@/, "no staff event carries an e-mail");
  // the colleague's code + verify: an enrol token, never a session
  const { token, body } = await codeToken(OLI.email);
  oliEnrolToken = token;
  assert.deepEqual([body["staff_user_id"], body["status"], body["has_password"], body["roles"]], [oliId, "invited", false, ["ops_analyst"]]);
  const me = await api("GET", "/ops/api/me", undefined, bearer(token));
  assert.equal(me.status, 401, JSON.stringify(me.body)); assert.equal(me.body["code"], "AUTH_REQUIRED");
  assert.equal(await count(`staff_sessions WHERE staff_user_id = $1`, [oliId]), 0, "no session row for the colleague");
  assert.equal(await count(`auth_challenges WHERE subject_kind = 'staff' AND staff_user_id = $1 AND kind = 'otp' AND consumed_at IS NOT NULL`, [oliId]), 1, "the code is consumed into the enrol token");
});

test("34.1-T2: Given the enrol token, when the colleague sets a 12-character password and signs in with e-mail and password, then a session opens with `factors = [email_code, password]`, `GET /ops/api/me` answers their id and roles, `staff.enrolled` and `staff.signed_in` are logged; given an 11-character or breached password, then `PASSWORD_WEAK` and no credential row.", { skip }, async () => {
  assert.ok(oliEnrolToken, "T1's enrol token");
  // an 11-character password, then a breached one: PASSWORD_WEAK, no credential row, still invited
  const short = await api("POST", "/ops/api/auth/password", { token: oliEnrolToken, password: "elevenchars" });
  assert.equal(short.status, 400, JSON.stringify(short.body)); assert.equal(short.body["code"], "PASSWORD_WEAK"); assert.equal(short.body["reason"], "too_short");
  assert.equal("elevenchars".length, STAFF_PASSWORD_MIN_LENGTH - 1);
  const breached = await api("POST", "/ops/api/auth/password", { token: oliEnrolToken, password: "password1234" });
  assert.equal(breached.status, 400, JSON.stringify(breached.body)); assert.equal(breached.body["code"], "PASSWORD_WEAK"); assert.equal(breached.body["reason"], "breached");
  assert.equal(await count(`staff_credentials WHERE staff_user_id = $1`, [oliId]), 0, "no credential row"); assert.equal((await userRow(oliId)).status, "invited");
  assert.equal((await events("staff.enrolled")).filter((e) => e.payload["staff_user_id"] === oliId).length, 0);
  // a 12-character password on the enrol token
  const twelve = OLI.password; assert.ok(twelve.length >= 12);
  const set = await api("POST", "/ops/api/auth/password", { token: oliEnrolToken, password: twelve });
  assert.equal(set.status, 200, JSON.stringify(set.body)); assert.deepEqual(set.body, { staff_user_id: oliId, enrolled: true, status: "active" });
  const cred = await db.query<{ kind: string; secret_hash: string }>(`SELECT kind, secret_hash FROM staff_credentials WHERE staff_user_id = $1 AND revoked_at IS NULL`, [oliId]);
  assert.equal(cred.length, 1); assert.equal(cred[0]!.kind, "password"); assert.ok(!cred[0]!.secret_hash.includes(twelve), "hashed, never the password");
  const oli = await userRow(oliId); assert.equal(oli.status, "active"); assert.equal(oli.enrolled_at !== null, true);
  // e-mail + password: T1's code (verified within 10 minutes) is the possession factor, the password the knowledge factor — the session
  const r = await api("POST", "/ops/api/auth/signin", { email: OLI.email, password: twelve });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = { token: r.body["token"] as string, session_id: r.body["session_id"] as string, staff_user_id: r.body["staff_user_id"] as string, body: r.body };
  oliSessionId = s.session_id;
  assert.deepEqual(s.body["factors"], ["email_code", "password"]); assert.equal(s.staff_user_id, oliId); assert.deepEqual(s.body["roles"], ["ops_analyst"]); assert.equal(s.body["legal_name"], OLI.name);
  assert.match(r.headers.get("set-cookie") ?? "", /^sm_staff=.*HttpOnly/);
  const spent = await api("POST", "/ops/api/auth/signin", { email: OLI.email, password: twelve });
  assert.equal(spent.status, 401, "the session spent the possession factor; a second session needs a fresh code"); assert.equal(spent.body["code"], "FACTOR_REQUIRED");
  const row = await sessionRow(s.session_id); assert.deepEqual(row.factors, ["email_code", "password"]); assert.equal(row.revoked_at, null);
  assert.equal(await count(`staff_sessions WHERE token_hash = $1`, [s.token]), 0, "the token itself is never stored");
  assert.equal(await count(`staff_sessions WHERE token_hash = $1`, [sha256hex(s.token)]), 1);
  const me = await api("GET", "/ops/api/me", undefined, bearer(s.token));
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.deepEqual(me.body["actor"], { kind: "human", id: oliId, role: "ops_analyst" }); assert.equal(me.body["staff_user_id"], oliId); assert.deepEqual(me.body["roles"], ["ops_analyst"]); assert.equal(me.body["source"], "session");
  assert.deepEqual((me.body["session"] as Json)["factors"], ["email_code", "password"]); assert.equal((me.body["session"] as Json)["session_id"], s.session_id);
  // staff.enrolled{factor=password} and staff.signed_in{session_id, factors} logged, by the person
  const enrolled = (await events("staff.enrolled")).filter((e) => e.payload["staff_user_id"] === oliId);
  assert.equal(enrolled.length, 1); assert.equal(enrolled[0]!.payload["factor"], "password"); assert.deepEqual([enrolled[0]!.actor_kind, enrolled[0]!.actor_id], ["human", oliId]);
  const signed = (await events("staff.signed_in")).filter((e) => e.payload["staff_user_id"] === oliId);
  assert.equal(signed.length, 1); assert.equal(signed[0]!.payload["session_id"], s.session_id); assert.deepEqual(signed[0]!.payload["factors"], ["email_code", "password"]); assert.deepEqual([signed[0]!.actor_kind, signed[0]!.actor_id, signed[0]!.actor_role], ["human", oliId, "ops_analyst"]);
  assert.doesNotMatch(JSON.stringify([...enrolled, ...signed].map((e) => e.payload)), /@/);
});

test("34.1-T3: Given a session, when the clock passes 30 minutes idle, then the next request answers 401 `SESSION_EXPIRED` and the row reads revoked; given five wrong passwords in a row, then the sixth attempt answers `ACCOUNT_LOCKED`, `staff.signin.locked` is logged and a `compliance` escalation exists.", { skip }, async () => {
  const s = await signIn(OLI);
  const before = await sessionRow(s.session_id);
  assert.equal(before.expires_at, at(STAFF_IDLE_MINUTES * MIN), "the idle deadline is 30 minutes out");
  // 29 minutes on: still open, the deadline slides
  clock.set(at(29 * MIN));
  const alive = await api("GET", "/ops/api/me", undefined, bearer(s.token)); assert.equal(alive.status, 200, JSON.stringify(alive.body));
  assert.notEqual((await sessionRow(s.session_id)).last_seen_at, before.last_seen_at);
  // 31 idle minutes → 401 SESSION_EXPIRED, the row reads revoked
  clock.set(at(31 * MIN));
  const gone = await api("GET", "/ops/api/me", undefined, bearer(s.token));
  assert.equal(gone.status, 401, JSON.stringify(gone.body)); assert.equal(gone.body["code"], "SESSION_EXPIRED");
  const row = await sessionRow(s.session_id); assert.notEqual(row.revoked_at, null, "the row reads revoked");
  assert.equal((await api("GET", "/ops/api/me", undefined, bearer(s.token))).body["code"], "SESSION_EXPIRED", "and stays revoked");
  // T2's session idled out the same way (nothing touched it for 60 minutes): its deadline is behind the clock
  assert.ok(Date.parse((await sessionRow(oliSessionId)).expires_at) < Date.parse(clock.now()));
  // five wrong passwords in a row: the fifth locks, the sixth answers ACCOUNT_LOCKED
  const lockedBefore = (await events("staff.signin.locked")).length; const escBefore = await count(`escalations WHERE owner_role = 'compliance' AND payload->>'staff_user_id' = $1`, [oliId]);
  const attempts: Reply[] = [];
  for (let i = 1; i <= STAFF_LOCK_AFTER_FAILURES + 1; i++) attempts.push(await api("POST", "/ops/api/auth/signin", { email: OLI.email, password: `wrong-password-${i}` }));
  // the door never enumerates: a wrong password answers the code alone — no staff_user_id, no failure count (the `staff.signin.failed` events carry the count)
  for (let i = 0; i < STAFF_LOCK_AFTER_FAILURES; i++) { assert.equal(attempts[i]!.status, 401, JSON.stringify(attempts[i]!.body)); assert.equal(attempts[i]!.body["code"], "PASSWORD_WRONG"); assert.equal("failures" in attempts[i]!.body, false); assert.equal("staff_user_id" in attempts[i]!.body, false); }
  assert.equal(attempts[STAFF_LOCK_AFTER_FAILURES - 1]!.body["locked_until"], at(15 * MIN), "the fifth failure locks the account for 15 minutes");
  const sixth = attempts[STAFF_LOCK_AFTER_FAILURES]!;
  assert.equal(sixth.status, 423, JSON.stringify(sixth.body)); assert.equal(sixth.body["code"], "ACCOUNT_LOCKED"); assert.equal(sixth.body["locked_until"], at(15 * MIN));
  const oli = await userRow(oliId); assert.equal(oli.failed_signins, STAFF_LOCK_AFTER_FAILURES); assert.notEqual(oli.locked_until, null);
  const failed = (await events("staff.signin.failed")).filter((e) => e.payload["staff_user_id"] === oliId);
  assert.equal(failed.length, STAFF_LOCK_AFTER_FAILURES); assert.deepEqual(failed.map((e) => e.payload["locked"]), [false, false, false, false, true]); assert.deepEqual(failed.map((e) => e.payload["failures"]), [1, 2, 3, 4, 5]); assert.ok(failed.every((e) => e.payload["factor"] === "password"));
  const locked = (await events("staff.signin.locked")).filter((e) => e.payload["staff_user_id"] === oliId);
  assert.equal(locked.length, 1); assert.equal((await events("staff.signin.locked")).length, lockedBefore + 1);
  assert.deepEqual([locked[0]!.payload["failures"], locked[0]!.payload["locked_until"], locked[0]!.payload["origination"]], [STAFF_LOCK_AFTER_FAILURES, at(15 * MIN), true]);
  const esc = await db.query<{ kind: string; severity: string; owner_role: string; status: string; payload: Json }>(`SELECT kind, severity, owner_role, status, payload FROM escalations WHERE owner_role = 'compliance' AND payload->>'staff_user_id' = $1`, [oliId]);
  assert.equal(esc.length, escBefore + 1); assert.deepEqual([esc[0]!.kind, esc[0]!.severity, esc[0]!.status], ["sev3", "3", "open"]); assert.equal(esc[0]!.payload["failures"], STAFF_LOCK_AFTER_FAILURES);
  assert.doesNotMatch(JSON.stringify(esc[0]!.payload), /@/);
  // the right password is refused while the lock stands
  const still = await api("POST", "/ops/api/auth/signin", { email: OLI.email, password: OLI.password }); assert.equal(still.status, 423); assert.equal(still.body["code"], "ACCOUNT_LOCKED");
  assert.equal(await count(`staff_sessions WHERE staff_user_id = $1 AND revoked_at IS NULL AND expires_at > $2::timestamptz`, [oliId, clock.now()]), 0, "no session opened");
});

test("34.1-T4: Given an `ops_analyst` session, when they call an officer-only route (a campaign approval) then 403 `ROLE_REQUIRED{officer}` before any write; given an `officer` session, then the same call runs on the bus with `actor = {human, <staff_user_id>, officer}` and the decision record names them; given a request with only the legacy `x-actor-*` headers and no bearer, then 401.", { skip }, async () => {
  clock.set(at(16 * MIN));   // T3's 15-minute lock has lapsed
  // rule 1's window (review finding): a lapsed lock is a fresh window — one wrong password is failure 1 again, no new lock, no new `staff.signin.locked`, no new escalation
  const lockedBefore = (await events("staff.signin.locked")).length; const escBefore = await count(`escalations WHERE owner_role = 'compliance' AND payload->>'staff_user_id' = $1`, [oliId]);
  const one = await api("POST", "/ops/api/auth/signin", { email: OLI.email, password: "wrong-after-the-lock-lapsed" });
  assert.equal(one.status, 401, JSON.stringify(one.body)); assert.equal(one.body["code"], "PASSWORD_WRONG"); assert.equal(one.body["locked_until"], undefined);
  const lapsed = await userRow(oliId); assert.equal(lapsed.failed_signins, 1, "the count restarts after the lapsed lock"); assert.equal(lapsed.locked_until, null);
  const failedAfterLock = (await events("staff.signin.failed")).filter((e) => e.payload["staff_user_id"] === oliId); assert.deepEqual([failedAfterLock.at(-1)!.payload["failures"], failedAfterLock.at(-1)!.payload["locked"]], [1, false]);
  assert.equal((await events("staff.signin.locked")).length, lockedBefore, "no second lock"); assert.equal(await count(`escalations WHERE owner_role = 'compliance' AND payload->>'staff_user_id' = $1`, [oliId]), escBefore, "no second escalation");
  const admin = await signIn(ADA);
  // rule 2: 'admin manages staff users and roles and nothing else that touches a borrower' — an admin-only session is 403 ROLE_REQUIRED on every borrower, queue, dashboard, trace and partner-book read, before any read; the staff pages stay admin's
  for (const path of ["/ops/api/loans?q=", `/ops/api/ai/conversation?party_id=${randomUUID()}`, "/ops/api/ai/conversation/recent", "/ops/api/dashboard", "/ops/api/queue", "/ops/api/funnel", "/ops/api/partner-book/loans", "/ops/api/partner-book/imports"]) {
    const r = await api("GET", path, undefined, bearer(admin.token)); assert.equal(r.status, 403, `${path}: ${JSON.stringify(r.body)}`); assert.equal(r.body["code"], "ROLE_REQUIRED"); assert.deepEqual(r.body["held"], ["admin"]);
  }
  assert.equal((await api("GET", "/ops/api/staff", undefined, bearer(admin.token))).status, 200);
  const inv = await invite(admin.token, ORA, ["officer"]); oraId = inv["staff_user_id"] as string;
  assert.equal(await enrol(ORA), oraId);
  const analyst = await signIn(OLI);
  assert.equal((await userRow(oliId)).failed_signins, 0, "a successful sign-in clears the counter");
  // the campaign the officer will approve (ops_analyst may plan it; only officer approves — 20.2 CAMPAIGN_APPROVAL_IS_OFFICER)
  const created = await api("POST", "/ops/api/tools/20.2/planChannels", { input: { op: "create_campaign", campaign_id: campaignId, partner_id: "partner-1", kind: "refi_trigger_outbound", channels: ["email"], selection_rule_set: "sm.refi.2026.v1", creative_ids: [] } }, bearer(analyst.token));
  assert.equal(created.status, 200, JSON.stringify(created.body)); assert.equal((created.body["output"] as Json)["status"], "draft"); assert.deepEqual(created.body["actor"], { kind: "human", id: oliId, role: "ops_analyst" });
  // the ops_analyst asks for the approval: 403 ROLE_REQUIRED{officer} before any write
  const eventsBefore = await count(`loan_events`); const entitiesBefore = await count(`entity_records`); const decisionsBefore = await count(`agent_decisions`);
  const refused = await api("POST", "/ops/api/tools/20.2/planChannels", { input: { op: "approve_campaign", campaign_id: campaignId } }, bearer(analyst.token));
  assert.equal(refused.status, 403, JSON.stringify(refused.body)); assert.equal(refused.body["code"], "ROLE_REQUIRED"); assert.equal(refused.body["role"], "officer"); assert.deepEqual(refused.body["held"], ["ops_analyst"]);
  assert.equal(await count(`loan_events`), eventsBefore, "no event"); assert.equal(await count(`entity_records`), entitiesBefore, "no record"); assert.equal(await count(`agent_decisions`), decisionsBefore, "no decision");
  assert.equal((await events("campaign.approved")).filter((e) => e.payload["campaign_id"] === campaignId).length, 0);
  // the officer: the same call runs on the bus as {human, <staff_user_id>, officer}
  const officer = await signIn(ORA);
  assert.deepEqual(officer.body["roles"], ["officer"]);
  const approved = await api("POST", "/ops/api/tools/20.2/planChannels", { input: { op: "approve_campaign", campaign_id: campaignId } }, bearer(officer.token));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual(approved.body["actor"], { kind: "human", id: oraId, role: "officer" });
  const out = approved.body["output"] as Json; assert.equal(out["status"], "approved"); assert.equal(out["approved_by"], `human:${oraId}`, "the campaign's approval record names the person");
  assert.ok((approved.body["events"] as Json[]).some((e) => e["type"] === "campaign.approved"));
  const ev = (await events("campaign.approved")).filter((e) => e.payload["campaign_id"] === campaignId);
  assert.equal(ev.length, 1); assert.deepEqual([ev[0]!.actor_kind, ev[0]!.actor_id, ev[0]!.actor_role], ["human", oraId, "officer"]); assert.equal(ev[0]!.payload["approved_by"], `human:${oraId}`);
  const executed = (await events("command.executed")).filter((e) => e.payload["command"] === "planChannels" && e.actor_id === oraId);
  assert.equal(executed.length, 1); assert.deepEqual([executed[0]!.actor_kind, executed[0]!.actor_role, executed[0]!.payload["process"]], ["human", "officer", "20.2"]);
  const rec = await db.query<{ data: Json }>(`SELECT data FROM entity_records WHERE kind = 'marketing_campaigns' AND id = $1 ORDER BY version DESC LIMIT 1`, [campaignId]);
  assert.equal(rec[0]!.data["approved_by"], `human:${oraId}`);
  // the analyst's role is what the session holds, not what the request says: asking to act as officer is refused the same way
  const asked = await api("POST", "/ops/api/tools/20.2/planChannels", { input: { op: "approve_campaign", campaign_id: campaignId }, role: "officer" }, bearer(analyst.token));
  assert.equal(asked.status, 403); assert.equal(asked.body["code"], "ROLE_REQUIRED");
  const headerRole = await api("POST", "/ops/api/tools/20.2/planChannels", { input: { op: "approve_campaign", campaign_id: campaignId } }, { ...bearer(analyst.token), "x-staff-role": "officer", "x-actor-id": oraId, "x-actor-role": "officer" });
  assert.equal(headerRole.status, 403, JSON.stringify(headerRole.body)); assert.equal(headerRole.body["code"], "ROLE_REQUIRED");
  // the legacy x-actor-* headers alone (no bearer): 401
  for (const [method, path, body] of [["GET", "/ops/api/me", undefined], ["GET", "/ops/api/dashboard", undefined], ["POST", "/ops/api/tools/20.2/planChannels", { input: { op: "approve_campaign", campaign_id: campaignId } }], ["GET", "/api/me", undefined]] as const) {
    const r = await api(method, path, body, { "x-actor-id": "u-officer", "x-actor-role": "officer" });
    assert.equal(r.status, 401, `${method} ${path}: ${JSON.stringify(r.body)}`); assert.equal(r.body["code"], "AUTH_REQUIRED");
  }
  assert.equal((await api("GET", "/ops/api/me", undefined, { "x-actor-id": "u-officer", "x-actor-role": "officer", ...bearer("not-a-session-token") })).status, 401);
  // discrepancy (1): the headers survive only for the deploy workflow's own smoke calls behind the ops bearer token, outside production
  const deploy = await api("GET", "/ops/api/me", undefined, { "x-actor-id": "u-deploy", "x-actor-role": "ops_analyst", ...bearer(TOKEN) });
  assert.equal(deploy.status, 200, JSON.stringify(deploy.body)); assert.equal(deploy.body["source"], "header"); assert.deepEqual(deploy.body["actor"], { kind: "human", id: "u-deploy", role: "ops_analyst" }); assert.equal(deploy.body["staff_user_id"], null);
  assert.equal((await api("GET", "/ops/api/dashboard", undefined, { "x-actor-id": "u-deploy", "x-actor-role": "ops_analyst", cookie: `sm_token=${encodeURIComponent(TOKEN)}` })).status, 200, "the /login cookie is the same bearer");
});

// ---------------------------------------------------------------- review findings on the first build: the doors enumerate nothing, a wrong code counts toward the lock, a reset needs a second proof, the acts trust no actor the request names
test("34.1 rules 1–3 probes: verify answers one 401 OTP_INVALID for an unknown address, a missing code and a wrong code; a wrong code is a failed sign-in (five lock the account); one open code per address; a reset needs the current password or a passkey and spends the code; the sign-in door answers unknown and not-enrolled addresses alike; /v1/tools/34.1/* is refused and a header-named admin is ROLE_DENIED", { skip }, async () => {
  const PAT = { email: `pat.pending.${R}@example.test`, name: "Pat Pending" };
  const admin = await signIn(ADA);
  // (a) verify: the same status, code and message for an unknown address, a staff address with no open code and a wrong code
  const unknown = await api("POST", "/ops/api/auth/verify", { email: `nobody.${R}@example.test`, code: "000000" });
  const noCode = await api("POST", "/ops/api/auth/verify", { email: OLI.email, code: "000000" });
  assert.equal(unknown.status, 401, JSON.stringify(unknown.body)); assert.equal(unknown.body["code"], "OTP_INVALID"); assert.equal(noCode.status, unknown.status); assert.deepEqual(noCode.body, unknown.body);
  const c = await api("POST", "/ops/api/auth/code", { email: OLI.email }); assert.equal(c.status, 200); const right = c.body["fake_code"] as string;
  const wrong = await api("POST", "/ops/api/auth/verify", { email: OLI.email, code: right === "000000" ? "000001" : "000000" });
  assert.deepEqual(wrong.body, unknown.body); assert.equal(wrong.status, 401);
  // the wrong code is a failed sign-in on the account's counter: staff.signin.failed{factor: email_code, failures: 1}
  const failedOli = (await events("staff.signin.failed")).filter((e) => e.payload["staff_user_id"] === oliId); assert.deepEqual([failedOli.at(-1)!.payload["factor"], failedOli.at(-1)!.payload["failures"], failedOli.at(-1)!.payload["locked"]], ["email_code", 1, false]);
  assert.equal((await userRow(oliId)).failed_signins, 1);
  // one open code per address: a second request answers the open challenge and mints nothing (no fake_code, no second row, no second e-mail)
  const mailBefore = edelivery().messages.size;
  const c2 = await api("POST", "/ops/api/auth/code", { email: OLI.email });
  assert.equal(c2.status, 200, JSON.stringify(c2.body)); assert.equal(c2.body["challenge_id"], c.body["challenge_id"]); assert.equal(c2.body["fake_code"], undefined); assert.equal(c2.body["expires_at"], c.body["expires_at"]);
  assert.equal(await count(`auth_challenges WHERE subject_kind = 'staff' AND kind = 'otp' AND staff_user_id = $1 AND consumed_at IS NULL`, [oliId]), 1); assert.equal(edelivery().messages.size, mailBefore);
  const v = await api("POST", "/ops/api/auth/verify", { email: OLI.email, code: right }); assert.equal(v.status, 200, "the right code still verifies");
  const s = { token: "", session_id: "" }; { const r = await api("POST", "/ops/api/auth/signin", { email: OLI.email, password: OLI.password }); assert.equal(r.status, 200, JSON.stringify(r.body)); s.token = r.body["token"] as string; s.session_id = r.body["session_id"] as string; }   // that code and the password: the session (spends the code, clears the counter)
  assert.equal((await userRow(oliId)).failed_signins, 0);
  // five wrong codes lock the account exactly as five wrong passwords do (the officer's account; a locked address gets the unknown-address answer on every door until the lock lapses)
  const lockedBefore = (await events("staff.signin.locked")).length; const escBefore = await count(`escalations WHERE owner_role = 'compliance' AND payload->>'staff_user_id' = $1`, [oraId]);
  const oc = await api("POST", "/ops/api/auth/code", { email: ORA.email }); const oraRight = oc.body["fake_code"] as string;
  for (let i = 1; i <= STAFF_LOCK_AFTER_FAILURES; i++) { const g = await api("POST", "/ops/api/auth/verify", { email: ORA.email, code: oraRight === String(i).padStart(6, "0") ? "999999" : String(i).padStart(6, "0") }); assert.equal(g.status, 401); assert.equal(g.body["code"], "OTP_INVALID"); }
  const ora = await userRow(oraId); assert.equal(ora.failed_signins, STAFF_LOCK_AFTER_FAILURES); assert.ok(ora.locked_until); assert.equal(new Date(ora.locked_until!).toISOString(), at(15 * MIN), "locked 15 minutes");
  assert.equal((await events("staff.signin.locked")).length, lockedBefore + 1); assert.equal(await count(`escalations WHERE owner_role = 'compliance' AND payload->>'staff_user_id' = $1`, [oraId]), escBefore + 1, "the compliance escalation");
  const oraLocked = await api("POST", "/ops/api/auth/verify", { email: ORA.email, code: oraRight }); assert.equal(oraLocked.status, 401); assert.deepEqual(oraLocked.body, unknown.body, "the right code is refused the same way while the lock stands");
  const oraCode = await api("POST", "/ops/api/auth/code", { email: ORA.email }); assert.equal(oraCode.status, 200, "the unknown-address answer");
  assert.equal(await count(`auth_challenges WHERE challenge_id = $1 AND staff_user_id IS NULL`, [oraCode.body["challenge_id"]]), 1, "the row names no account: nothing can verify it"); assert.equal((await api("POST", "/ops/api/auth/verify", { email: ORA.email, code: oraCode.body["fake_code"] })).body["code"], "OTP_INVALID");
  assert.equal((await api("POST", "/ops/api/auth/signin", { email: ORA.email, password: ORA.password })).body["code"], "ACCOUNT_LOCKED");
  // (b) a reset: the step token alone is 401 PROOF_REQUIRED and changes nothing; a wrong current password is a failed sign-in; the current password resets it, revokes every session and spends the code (a sign-in on it is FACTOR_REQUIRED)
  const newPass = `oli-reset-pass-${R}`;
  const step = await codeToken(OLI.email);
  const alone = await api("POST", "/ops/api/auth/password", { token: step.token, password: newPass });
  assert.equal(alone.status, 401, JSON.stringify(alone.body)); assert.equal(alone.body["code"], "PROOF_REQUIRED");
  assert.equal((await api("GET", "/ops/api/me", undefined, bearer(s.token))).status, 200, "nothing changed"); assert.equal(await count(`staff_credentials WHERE staff_user_id = $1 AND kind = 'password' AND revoked_at IS NULL`, [oliId]), 1);
  const badCurrent = await api("POST", "/ops/api/auth/password", { token: step.token, password: newPass, current_password: "not-the-current-password" });
  assert.equal(badCurrent.status, 401); assert.equal(badCurrent.body["code"], "PROOF_REQUIRED"); assert.equal((await userRow(oliId)).failed_signins, 1, "a wrong current password is a failed sign-in");
  const reset = await api("POST", "/ops/api/auth/password", { token: step.token, password: newPass, current_password: OLI.password });
  assert.equal(reset.status, 200, JSON.stringify(reset.body)); assert.deepEqual([reset.body["staff_user_id"], reset.body["enrolled"], reset.body["status"], reset.body["proof"]], [oliId, false, "active", "current_password"]);
  assert.equal((await api("GET", "/ops/api/me", undefined, bearer(s.token))).body["code"], "SESSION_EXPIRED", "every session revoked"); assert.equal((await userRow(oliId)).failed_signins, 0);
  const spentCode = await api("POST", "/ops/api/auth/signin", { email: OLI.email, password: newPass }); assert.equal(spentCode.status, 401, JSON.stringify(spentCode.body)); assert.equal(spentCode.body["code"], "FACTOR_REQUIRED", "the reset spent the code: mailbox access alone opens no session");
  const resets = (await events("staff.password.reset")).filter((e) => e.payload["staff_user_id"] === oliId); assert.equal(resets.length, 1); assert.equal(resets[0]!.payload["proof"], "current_password");
  // and back to the suite's password the same way (the new password as the proof)
  const step2 = await codeToken(OLI.email); const back = await api("POST", "/ops/api/auth/password", { token: step2.token, password: OLI.password, current_password: newPass }); assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal((await api("POST", "/ops/api/auth/signin", { email: OLI.email, password: OLI.password })).body["code"], "FACTOR_REQUIRED"); assert.equal((await signIn(OLI)).staff_user_id, oliId, "a fresh code and the password open the session again");
  // (c) the sign-in door: an unknown address and a not-yet-enrolled one answer the same 401 PASSWORD_WRONG — no staff_user_id, no failure count; the action log keeps NOT_ENROLLED
  const patId = (await invite(admin.token, PAT, ["ops_analyst"]))["staff_user_id"] as string;
  const un = await api("POST", "/ops/api/auth/signin", { email: `nobody.${R}@example.test`, password: "whatever-password-1" });
  const ne = await api("POST", "/ops/api/auth/signin", { email: PAT.email, password: "whatever-password-1" });
  assert.equal(un.status, 401); assert.deepEqual(un.body, ne.body); assert.equal(un.body["code"], "PASSWORD_WRONG"); assert.equal("staff_user_id" in ne.body, false); assert.equal("failures" in ne.body, false);
  for (let i = 0; i < 50 && !(await db.query(`SELECT 1 FROM staff_actions WHERE refusal_code = 'NOT_ENROLLED' AND staff_user_id = $1`, [patId])).length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await db.query(`SELECT 1 FROM staff_actions WHERE route = '/ops/api/auth/signin' AND refusal_code = 'NOT_ENROLLED' AND staff_user_id = $1`, [patId])).length, 1);
  // (d) the staff acts trust no actor the request names: the generic tool routes refuse process 34.1 outright, even with the ops bearer token; the nonprod header actor named admin is no staff row (ROLE_DENIED on the bus, nothing written)
  const adminsBefore = await count(`staff_users WHERE 'admin' = ANY(roles)`);
  const forged = await api("POST", "/v1/tools/34.1/staff.invite", { actor: { kind: "system", id: "forged" }, input: { email: `mallory.${R}@example.test`, roles: ["admin"] } }, bearer(TOKEN));
  assert.equal(forged.status, 403, JSON.stringify(forged.body)); assert.equal(forged.body["code"], "STAFF_TOOLS_ARE_SESSION_ONLY");
  const forgedRole = await api("POST", "/v1/tools/34.1/staff.role.set", { actor: { kind: "human", id: "11111111-1111-4111-8111-111111111111", role: "admin" }, input: { staff_user_id: oliId, roles: ["admin"] } }, bearer(TOKEN));
  assert.equal(forgedRole.status, 403); assert.equal(forgedRole.body["code"], "STAFF_TOOLS_ARE_SESSION_ONLY");
  // `admin` is no console header role (src/console/store.ts CONSOLE_ROLES): a header naming it resolves to nothing — 401 before the bus
  const headerInvite = await api("POST", "/ops/api/staff/invite", { email: `mallory.${R}@example.test`, roles: ["admin"] }, { ...bearer(TOKEN), "x-actor-id": "u-deploy", "x-actor-role": "admin" });
  assert.equal(headerInvite.status, 401, JSON.stringify(headerInvite.body)); assert.equal(headerInvite.body["code"], "AUTH_REQUIRED");
  const headerRole = await api("PUT", `/ops/api/staff/${oliId}/roles`, { roles: ["admin"], rationale: "x" }, { ...bearer(TOKEN), "x-actor-id": randomUUID(), "x-actor-role": "admin" });
  assert.equal(headerRole.status, 401, JSON.stringify(headerRole.body));
  // a header role the console does know (compliance) reaches the bus on the review route and the act refuses it from rows: the actor is no active staff member — ROLE_DENIED, no review row
  const reviewsBefore = await count(`staff_access_reviews`);
  const headerReview = await api("POST", "/ops/api/staff/access-review", { decisions: [{ staff_user_id: adaId, decision: "keep" }, { staff_user_id: oliId, decision: "change", roles: ["admin"] }, { staff_user_id: oraId, decision: "keep" }], rationale: "x" }, { ...bearer(TOKEN), "x-actor-id": randomUUID(), "x-actor-role": "compliance" });
  assert.equal(headerReview.status, 409, JSON.stringify(headerReview.body)); assert.equal(headerReview.body["code"], "ROLE_DENIED"); assert.equal(await count(`staff_access_reviews`), reviewsBefore);
  assert.equal(await count(`staff_users WHERE 'admin' = ANY(roles)`), adminsBefore, "no admin minted"); assert.deepEqual((await userRow(oliId)).roles, ["ops_analyst"]);
  assert.equal(await count(`staff_users WHERE email_hash = $1`, [sha256hex(`mallory.${R}@example.test`)]), 0);
});

test("34.1-T5: Given an admin, when they change a colleague's roles, then `staff.role.changed{roles_before, roles_after, by}` is logged, the colleague's open sessions are revoked, and a decision record carries the rationale; when they try to change their own roles, then `NO_SELF_ROLE_CHANGE`; when they try to disable the last admin, then `LAST_ADMIN_STAYS`.", { skip }, async () => {
  const admin = await signIn(ADA);
  const colleague = await signIn(OLI);
  assert.equal((await api("GET", "/ops/api/me", undefined, bearer(colleague.token))).status, 200);
  const rationale = `promoted to officer for the Q4 campaign approvals (${R})`;
  const r = await api("PUT", `/ops/api/staff/${oliId}/roles`, { roles: ["officer", "ops_analyst"], rationale }, bearer(admin.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body["staff_user_id"], r.body["changed"], r.body["roles_before"], r.body["roles_after"], r.body["by"]], [oliId, true, ["ops_analyst"], ["ops_analyst", "officer"], adaId]);
  assert.ok((r.body["sessions_revoked"] as string[]).includes(colleague.session_id), "the colleague's open session is among the revoked");
  assert.equal((r.body["decision_ids"] as string[]).length, 1); assert.ok((r.body["events"] as string[]).includes("staff.role.changed"));
  assert.deepEqual((await userRow(oliId)).roles, ["ops_analyst", "officer"]);
  // staff.role.changed{roles_before, roles_after, by} by the admin
  const changed = (await events("staff.role.changed")).filter((e) => e.payload["staff_user_id"] === oliId);
  assert.equal(changed.length, 1);
  assert.deepEqual([changed[0]!.payload["roles_before"], changed[0]!.payload["roles_after"], changed[0]!.payload["by"], changed[0]!.payload["origination"]], [["ops_analyst"], ["ops_analyst", "officer"], adaId, true]);
  assert.deepEqual([changed[0]!.actor_kind, changed[0]!.actor_id, changed[0]!.actor_role], ["human", adaId, "admin"]);
  assert.ok((changed[0]!.payload["sessions_revoked"] as string[]).includes(colleague.session_id));
  // the colleague's open sessions are revoked: 401 SESSION_EXPIRED on the next request, the row reads revoked
  const gone = await api("GET", "/ops/api/me", undefined, bearer(colleague.token));
  assert.equal(gone.status, 401, JSON.stringify(gone.body)); assert.equal(gone.body["code"], "SESSION_EXPIRED");
  assert.notEqual((await sessionRow(colleague.session_id)).revoked_at, null);
  assert.equal(await count(`staff_sessions WHERE staff_user_id = $1 AND revoked_at IS NULL`, [oliId]), 0);
  // the decision record: staff.role.set with the rationale, by the admin, the spec's schema
  const d = (await decisions("staff.role.set")).filter((x) => x.subject_id === oliId);
  assert.equal(d.length, 1); assert.equal(d[0]!.id, (r.body["decision_ids"] as string[])[0]);
  assert.match(d[0]!.rationale, new RegExp(rationale.replace(/[()]/g, "\\$&"))); assert.match(d[0]!.rationale, /roles_before \[ops_analyst\] → roles_after \[ops_analyst, officer\]/); assert.match(d[0]!.rationale, new RegExp(`by ${adaId}`));
  assert.deepEqual([d[0]!.agent, d[0]!.subject_kind, d[0]!.approved_by, d[0]!.approved_role, d[0]!.rule_set_version, d[0]!.model_version, d[0]!.prompt_version, d[0]!.confidence], ["security-records", "staff_user", adaId, "admin", STAFF_RULE_SET_VERSION, STAFF_MODEL_VERSION, STAFF_PROMPT_VERSION, "1.0000"]);
  // the admin's own roles: NO_SELF_ROLE_CHANGE (a role is never self-granted); the same for a self-disable
  const self = await api("PUT", `/ops/api/staff/${adaId}/roles`, { roles: ["admin", "officer"], rationale: "myself" }, bearer(admin.token));
  assert.equal(self.status, 409, JSON.stringify(self.body)); assert.equal(self.body["code"], "NO_SELF_ROLE_CHANGE"); assert.equal(self.body["command"], "staff.role.set"); assert.match(String(self.body["citation"]), /34\.1 rule 2/);
  const selfOff = await api("POST", `/ops/api/staff/${adaId}/disable`, { rationale: "myself" }, bearer(admin.token));
  assert.equal(selfOff.status, 409, JSON.stringify(selfOff.body)); assert.equal(selfOff.body["code"], "NO_SELF_ROLE_CHANGE");
  assert.deepEqual([(await userRow(adaId)).roles, (await userRow(adaId)).status], [["admin"], "active"]);
  assert.equal((await api("GET", "/ops/api/me", undefined, bearer(admin.token))).status, 200, "a refused change revokes nothing");
  // the last admin (edge cases: "Two admins disable each other simultaneously → LAST_ADMIN_STAYS refuses the second"): a second admin, both requests in flight at once —
  // the test holds Bea's row locked so neither can commit, sends Ada's request first, then Bea's, then lets go; Ada's commits, Bea's re-checks the invariant under the lock and is refused
  const invB = await invite(admin.token, BEA, ["admin"]); beaId = invB["staff_user_id"] as string; assert.equal(await enrol(BEA), beaId);
  const bea = await signIn(BEA); assert.deepEqual(bea.body["roles"], ["admin"]);
  assert.deepEqual((await db.query<{ id: string }>(`SELECT id::text AS id FROM staff_users WHERE status = 'active' AND 'admin' = ANY(roles) ORDER BY created_at`)).map((u) => u.id), [adaId, beaId], "two active admins");
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  let adaReq: Promise<Reply> | undefined; let beaReq: Promise<Reply> | undefined;
  await db.tx(async (q) => {
    await q.query(`SELECT id FROM staff_users WHERE id = $1 FOR UPDATE`, [beaId]);
    adaReq = api("POST", `/ops/api/staff/${beaId}/disable`, { rationale: "Bea leaves" }, bearer(admin.token)); await sleep(400);
    beaReq = api("POST", `/ops/api/staff/${adaId}/disable`, { rationale: "Ada leaves" }, bearer(bea.token)); await sleep(400);
    assert.deepEqual([(await userRow(adaId)).status, (await userRow(beaId)).status], ["active", "active"], "both in flight, neither committed");
  });
  const [adaOff, beaOff] = await Promise.all([adaReq!, beaReq!]);
  assert.equal(adaOff.status, 200, JSON.stringify(adaOff.body)); assert.deepEqual([adaOff.body["staff_user_id"], adaOff.body["changed"], adaOff.body["by"]], [beaId, true, adaId]); assert.ok((adaOff.body["sessions_revoked"] as string[]).includes(bea.session_id));
  assert.equal(beaOff.status, 409, JSON.stringify(beaOff.body)); assert.equal(beaOff.body["code"], "LAST_ADMIN_STAYS"); assert.equal(beaOff.body["command"], "staff.disable"); assert.match(String(beaOff.body["citation"]), /at least one active admin/);
  assert.deepEqual([(await userRow(adaId)).status, (await userRow(adaId)).disabled_at, (await userRow(beaId)).status], ["active", null, "disabled"]);
  assert.deepEqual((await events("staff.disabled")).map((e) => [e.payload["staff_user_id"], e.payload["by"]]), [[beaId, adaId]], "one disable committed; the refused one left no event");
  assert.equal((await decisions("staff.disable")).length, 1); assert.equal((await decisions("staff.disable"))[0]!.subject_id, beaId);
  assert.equal((await api("GET", "/ops/api/me", undefined, bearer(bea.token))).status, 401, "Bea's session is revoked with the disable");
  assert.equal((await api("GET", "/ops/api/me", undefined, bearer(admin.token))).status, 200, "the admin's session stands");
  // the review path (rule 6) obeys the same invariant: a compliance reviewer may neither disable nor demote the only active admin
  const invC = await invite(admin.token, CARA, ["compliance"]); caraId = invC["staff_user_id"] as string; assert.equal(await enrol(CARA), caraId);
  const cara = await signIn(CARA);
  const activeIds = (await db.query<{ id: string }>(`SELECT id::text AS id FROM staff_users WHERE status = 'active'`)).map((u) => u.id);
  const keepOthers = activeIds.filter((id) => id !== adaId).map((id) => ({ staff_user_id: id, decision: "keep" }));
  const last = await api("POST", "/ops/api/staff/access-review", { decisions: [{ staff_user_id: adaId, decision: "disable" }, ...keepOthers], rationale: "offboarding the admin" }, bearer(cara.token));
  assert.equal(last.status, 409, JSON.stringify(last.body)); assert.equal(last.body["code"], "LAST_ADMIN_STAYS"); assert.equal(last.body["command"], "staff.disable");
  const demote = await api("POST", "/ops/api/staff/access-review", { decisions: [{ staff_user_id: adaId, decision: "change", roles: ["ops_analyst"] }, ...keepOthers], rationale: "demoting the admin" }, bearer(cara.token));
  assert.equal(demote.status, 409, JSON.stringify(demote.body)); assert.equal(demote.body["code"], "LAST_ADMIN_STAYS"); assert.equal(demote.body["command"], "staff.role.set");
  assert.deepEqual([(await userRow(adaId)).roles, (await userRow(adaId)).status], [["admin"], "active"]); assert.equal(await count(`staff_access_reviews`), 0, "a refused review writes no row");
  assert.equal((await events("staff.access_review.completed")).length, 0); assert.equal((await decisions("staff.role.set")).length, 1, "no decision for the refused change");
  assert.equal((await api("POST", `/ops/api/staff/${adaId}/disable`, { rationale: "x" }, bearer(cara.token))).body["code"], "ROLE_REQUIRED", "the disable route is admin's, not compliance's");
});

test("34.1-T6: Given every request of a session (reads and writes), then one `staff_actions` row per request exists with route, subject ids, command and result, and no row carries a name, an e-mail, a phone number or a money figure.", { skip }, async () => {
  const admin = await signIn(ADA);
  // a read and a write on this session, then the whole log against everything the suite sent so far
  const list = await api("GET", "/ops/api/staff", undefined, bearer(admin.token)); assert.equal(list.status, 200, JSON.stringify(list.body));
  const noChange = await api("PUT", `/ops/api/staff/${oliId}/roles`, { roles: ["ops_analyst", "officer"], rationale: "unchanged" }, bearer(admin.token)); assert.equal(noChange.status, 200); assert.equal(noChange.body["changed"], false);
  const mine = await api("GET", `/ops/api/staff/actions?staff_user_id=${adaId}&limit=50`, undefined, bearer(admin.token)); assert.equal(mine.status, 200, JSON.stringify(mine.body));
  // the row lands after the response is on the wire (the console's finally block): wait for the log to catch up with the requests sent
  for (let i = 0; i < 50 && (await count(`staff_actions`)) < sent.length; i++) await new Promise((r) => setTimeout(r, 20));
  type Row = { id: string; staff_user_id: string | null; session_id: string | null; at: string; route: string; method: string; subject_kind: string | null; subject_id: string | null; command: string | null; result: string; refusal_code: string | null };
  const rows = await db.query<Row>(`SELECT id::text AS id, staff_user_id::text AS staff_user_id, session_id::text AS session_id, at::text AS at, route, method, subject_kind, subject_id, command, result, refusal_code FROM staff_actions ORDER BY at, id`);
  // one row per request: the multiset of (method, route) the suite sent equals the table's
  const key = (x: { method: string; route: string }): string => `${x.method} ${x.route}`;
  assert.equal(rows.length, sent.length, `one staff_actions row per request (${rows.length} rows, ${sent.length} requests)`);
  assert.deepEqual(rows.map(key).sort(), sent.map(key).sort());
  // route, subject ids, command and result on the rows this session wrote
  const bySession = rows.filter((r) => r.session_id === admin.session_id);
  assert.ok(bySession.length >= 3); assert.ok(bySession.every((r) => r.staff_user_id === adaId));
  const read = bySession.find((r) => r.method === "GET" && r.route === "/ops/api/staff")!; assert.deepEqual([read.result, read.command, read.refusal_code], ["ok", null, null]);
  const write = bySession.find((r) => r.method === "PUT" && r.route === `/ops/api/staff/${oliId}/roles`)!; assert.deepEqual([write.result, write.command, write.subject_kind, write.subject_id], ["ok", "staff.role.set", "staff_user", oliId]);
  const filtered = bySession.find((r) => r.route.startsWith("/ops/api/staff/actions?"))!; assert.equal(filtered.route, `/ops/api/staff/actions?staff_user_id=${adaId}&limit=50`);
  // the rows of earlier tests: the door (no session), a refusal with its code, the bus command, the deploy workflow's header actor (no staff id)
  const door = rows.filter((r) => r.route === "/ops/api/auth/code"); assert.ok(door.length >= 5); assert.ok(door.every((r) => r.staff_user_id === null && r.session_id === null && r.result === "ok" && r.subject_kind === "auth_challenge"));
  const verify = rows.filter((r) => r.route === "/ops/api/auth/verify" && r.result === "ok"); assert.ok(verify.every((r) => r.staff_user_id !== null && r.session_id === null && r.subject_kind === "staff_user"));
  const signins = rows.filter((r) => r.route === "/ops/api/auth/signin"); assert.ok(signins.every((r) => r.command === "staff.signin"));
  assert.ok(signins.some((r) => r.result === "ok" && r.session_id !== null)); assert.ok(signins.some((r) => r.result === "refused" && r.refusal_code === "ACCOUNT_LOCKED" && r.staff_user_id === oliId)); assert.ok(signins.some((r) => r.result === "refused" && r.refusal_code === "PASSWORD_WRONG"));
  const gated = rows.filter((r) => r.route === "/ops/api/tools/20.2/planChannels" && r.refusal_code === "ROLE_REQUIRED"); assert.ok(gated.length >= 3); assert.ok(gated.every((r) => r.result === "refused" && r.command === "planChannels" && r.staff_user_id === oliId && r.session_id !== null));
  assert.ok(rows.some((r) => r.route === "/ops/api/tools/20.2/planChannels" && r.refusal_code === "AUTH_REQUIRED" && r.command === null && r.staff_user_id === null), "the headers-only call is logged too, no one named");
  assert.ok(rows.some((r) => r.route === "/ops/api/tools/20.2/planChannels" && r.result === "ok" && r.command === "planChannels" && r.staff_user_id === oraId));
  assert.ok(rows.some((r) => r.route === `/ops/api/staff/${adaId}/roles` && r.result === "refused" && r.refusal_code === "NO_SELF_ROLE_CHANGE" && r.command === "staff.role.set" && r.subject_id === adaId));
  assert.ok(rows.some((r) => r.route === `/ops/api/staff/${adaId}/disable` && r.result === "refused" && r.refusal_code === "LAST_ADMIN_STAYS" && r.command === "staff.disable" && r.staff_user_id === beaId && r.subject_id === adaId));
  assert.ok(rows.some((r) => r.route === `/ops/api/staff/${beaId}/disable` && r.result === "ok" && r.command === "staff.disable" && r.staff_user_id === adaId && r.subject_id === beaId));
  assert.ok(rows.some((r) => r.route === "/ops/api/staff/access-review" && r.result === "refused" && r.refusal_code === "LAST_ADMIN_STAYS" && r.command === "staff.access.review" && r.staff_user_id === caraId));
  assert.ok(rows.some((r) => r.route === "/ops/api/me" && r.result === "refused" && r.refusal_code === "AUTH_REQUIRED" && r.staff_user_id === null));
  assert.ok(rows.some((r) => r.route === "/ops/api/me" && r.result === "refused" && r.refusal_code === "SESSION_EXPIRED"));
  assert.ok(rows.some((r) => r.route === "/ops/api/auth/password" && r.result === "refused" && r.refusal_code === "PASSWORD_WEAK" && r.staff_user_id === oliId));
  assert.ok(rows.some((r) => r.route === "/ops/api/staff/invite" && r.result === "ok" && r.command === "staff.invite" && r.subject_kind === "staff_user" && r.subject_id === oliId && r.staff_user_id === adaId));
  assert.ok(rows.every((r) => ["ok", "refused", "error"].includes(r.result)));
  assert.ok(rows.every((r) => r.at.startsWith("2026-")));
  // no row carries a name, an e-mail, a phone number or a money figure — the whole table, every text column, uuids masked
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const people = [ADA, OLI, ORA, BEA, CARA];
  const names = [...people.map((p) => p.name), ...people.flatMap((p) => p.name.split(" ")).filter((w) => !["Admin", "Officer", "Analyst", "Compliance"].includes(w))];
  const emails = people.map((p) => p.email);
  for (const r of rows) {
    const text = [r.route, r.method, r.subject_kind, r.subject_id, r.command, r.result, r.refusal_code].filter((x): x is string => typeof x === "string").join(" ");
    const masked = text.replace(UUID, "<uuid>");
    assert.doesNotMatch(masked, /@/, `no e-mail: ${text}`);
    for (const e of emails) assert.ok(!text.toLowerCase().includes(e.toLowerCase()) && !text.toLowerCase().includes(e.split("@")[0]!.toLowerCase()), `no e-mail: ${text}`);
    for (const n of names) assert.ok(!text.includes(n), `no name (${n}): ${text}`);
    assert.doesNotMatch(masked, /\+?\d[\d\s().-]{7,}\d/, `no phone number: ${text}`);
    assert.doesNotMatch(masked, /\$|\d{1,3}(,\d{3})+|\d+\.\d{2}\b|\bcents?\b|\busd\b/i, `no money figure: ${text}`);
    assert.doesNotMatch(masked, /token=|code=|challenge=/i, `no secret in a query string: ${text}`);
    for (const p of people) assert.ok(!text.includes(p.password), `no password: ${text}`);
  }
  assert.equal(await count(`staff_actions WHERE staff_actions::text ILIKE '%@%'`), 0, "no column of any row carries an e-mail");
  for (const n of people.map((p) => p.name)) assert.equal(await count(`staff_actions WHERE staff_actions::text ILIKE $1`, [`%${n}%`]), 0, `no column carries the name ${n}`);
  // append-only (rule 4): a row is never updated or deleted
  await assert.rejects(db.query(`UPDATE staff_actions SET result = 'ok' WHERE id = $1`, [rows[0]!.id]));
  await assert.rejects(db.query(`DELETE FROM staff_actions WHERE id = $1`, [rows[0]!.id]));
  // the admin | compliance view of the log answers the same rows, ids only
  const listed = mine.body["actions"] as Json[]; assert.ok(listed.length >= 1); assert.ok(listed.every((a) => a["staff_user_id"] === adaId));
  assert.doesNotMatch(JSON.stringify(listed), /@/);
  const denied = await api("GET", "/ops/api/staff/actions", undefined, bearer((await signIn(OLI)).token)); assert.equal(denied.status, 403); assert.equal(denied.body["code"], "ROLE_REQUIRED"); assert.equal(denied.body["role"], "admin");
});

test("34.1-T7: Given a passkey registered on an enrolled session, when the user signs in with the passkey and the password, then a session opens with `factors = [passkey, password]` and no code was sent; given the passkey alone, then no session.", { skip }, async () => {
  const admin = await signIn(ADA);
  // the credential, registered on the enrolled session (rule 1; the borrower side's verifier)
  const opts = await api("POST", "/ops/api/auth/passkey/register-options", {}, bearer(admin.token));
  assert.equal(opts.status, 200, JSON.stringify(opts.body)); assert.equal((opts.body["rp"] as Json)["id"], "localhost"); assert.equal(opts.body["attestation"], "none");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const cose = new Map<C, C>([[1, 2], [3, -7], [-1, 1], [-2, b64url.decode(jwk.x)], [-3, b64url.decode(jwk.y)]]);
  const credId = Buffer.from(randomUUID().replace(/-/g, ""), "hex");
  const authData = Buffer.concat([sha("localhost"), Buffer.from([0x41]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([credId.length >> 8, credId.length & 0xff]), credId, cbor(cose)]);
  const attestationObject = b64url.encode(cbor({ fmt: "none", attStmt: {}, authData }));
  const noSession = await api("POST", "/ops/api/auth/passkey/register", { challenge_id: opts.body["challenge_id"], credential: { id: b64url.encode(credId), response: { clientDataJSON: clientData("webauthn.create", opts.body["challenge"] as string), attestationObject, transports: ["internal"] } } });
  assert.equal(noSession.status, 401, "registration needs the enrolled session");
  const reg = await api("POST", "/ops/api/auth/passkey/register", { challenge_id: opts.body["challenge_id"], credential: { id: b64url.encode(credId), response: { clientDataJSON: clientData("webauthn.create", opts.body["challenge"] as string), attestationObject, transports: ["internal"] } }, label: "laptop" }, bearer(admin.token));
  assert.equal(reg.status, 200, JSON.stringify(reg.body)); assert.equal(reg.body["credential_id"], b64url.encode(credId)); assert.equal(reg.body["attestation_verified"], "FAKE"); assert.equal(reg.body["algorithm"], -7);
  assert.equal(await count(`staff_credentials WHERE staff_user_id = $1 AND kind = 'passkey' AND revoked_at IS NULL`, [adaId]), 1);
  const enrolled = (await events("staff.enrolled")).filter((e) => e.payload["staff_user_id"] === adaId && e.payload["factor"] === "passkey"); assert.equal(enrolled.length, 1);
  // past the code window: every code verified so far is older than 10 minutes, so the passkey is the only possession factor on file
  clock.set(at((STAFF_POSSESSION_MINUTES + 1) * MIN));
  const codesBefore = await count(`auth_challenges WHERE subject_kind = 'staff' AND kind = 'otp'`); const mailBefore = edelivery().messages.size; const sessionsBefore = await count(`staff_sessions`);
  // the passkey alone: the assertion verifies, no session opens
  const ao = await api("POST", "/ops/api/auth/passkey/assert-options", { email: ADA.email });
  assert.equal(ao.status, 200, JSON.stringify(ao.body)); assert.deepEqual((ao.body["allow_credentials"] as Json[]).map((c) => c["id"]), [b64url.encode(credId)]);
  const authData2 = Buffer.concat([sha("localhost"), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
  const cdj = clientData("webauthn.get", ao.body["challenge"] as string);
  const signature = b64url.encode(cryptoSign("sha256", Buffer.concat([authData2, sha(b64url.decode(cdj))]), { key: privateKey, dsaEncoding: "der" }));
  const alone = await api("POST", "/ops/api/auth/passkey/assert", { challenge_id: ao.body["challenge_id"], credential: { id: b64url.encode(credId), response: { clientDataJSON: cdj, authenticatorData: b64url.encode(authData2), signature } } });
  assert.equal(alone.status, 200, JSON.stringify(alone.body)); assert.deepEqual([alone.body["verified"], alone.body["staff_user_id"], alone.body["possession"], alone.body["session"]], [true, adaId, "passkey", null]);
  assert.equal(alone.body["token"], undefined, "no token"); assert.equal(alone.headers.get("set-cookie"), null, "no cookie");
  assert.equal(await count(`staff_sessions`), sessionsBefore, "no session row");
  assert.equal((await api("GET", "/ops/api/me", undefined, bearer(String(ao.body["challenge_id"])))).status, 401);
  const replay = await api("POST", "/ops/api/auth/passkey/assert", { challenge_id: ao.body["challenge_id"], credential: { id: b64url.encode(credId), response: { clientDataJSON: cdj, authenticatorData: b64url.encode(authData2), signature } } });
  assert.equal(replay.status, 401); assert.equal(replay.body["code"], "PASSKEY_INVALID");
  // the passkey and the password: the session, factors [passkey, password]; no code was sent
  const s = await api("POST", "/ops/api/auth/signin", { email: ADA.email, password: ADA.password });
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.deepEqual(s.body["factors"], ["passkey", "password"]); assert.equal(s.body["staff_user_id"], adaId);
  assert.match(s.headers.get("set-cookie") ?? "", /^sm_staff=/);
  assert.deepEqual((await sessionRow(s.body["session_id"] as string)).factors, ["passkey", "password"]);
  assert.equal(await count(`auth_challenges WHERE subject_kind = 'staff' AND kind = 'otp'`), codesBefore, "no code issued"); assert.equal(edelivery().messages.size, mailBefore, "no e-mail sent");
  const signed = (await events("staff.signed_in")).filter((e) => e.payload["session_id"] === s.body["session_id"]);
  assert.equal(signed.length, 1); assert.deepEqual(signed[0]!.payload["factors"], ["passkey", "password"]); assert.equal(signed[0]!.payload["possession_challenge_id"], ao.body["challenge_id"]);
  const me = await api("GET", "/ops/api/me", undefined, bearer(s.body["token"] as string));
  assert.equal(me.status, 200); assert.deepEqual((me.body["session"] as Json)["factors"], ["passkey", "password"]); assert.deepEqual(me.body["roles"], ["admin"]);
  // the possession was spent by the session; the password alone is FACTOR_REQUIRED again
  const again = await api("POST", "/ops/api/auth/signin", { email: ADA.email, password: ADA.password });
  assert.equal(again.status, 401); assert.equal(again.body["code"], "FACTOR_REQUIRED");
  // the assertion of the credential with the password in one call: the same session shape
  const ao2 = await api("POST", "/ops/api/auth/passkey/assert-options", { email: ADA.email });
  const authData3 = Buffer.concat([sha("localhost"), Buffer.from([0x05]), Buffer.from([0, 0, 0, 2])]); const cdj2 = clientData("webauthn.get", ao2.body["challenge"] as string);
  const sig2 = b64url.encode(cryptoSign("sha256", Buffer.concat([authData3, sha(b64url.decode(cdj2))]), { key: privateKey, dsaEncoding: "der" }));
  const both = await api("POST", "/ops/api/auth/passkey/assert", { challenge_id: ao2.body["challenge_id"], credential: { id: b64url.encode(credId), response: { clientDataJSON: cdj2, authenticatorData: b64url.encode(authData3), signature: sig2 } }, password: ADA.password });
  assert.equal(both.status, 200, JSON.stringify(both.body)); assert.deepEqual(both.body["factors"], ["passkey", "password"]); assert.equal(typeof both.body["token"], "string");
  assert.equal(await count(`auth_challenges WHERE subject_kind = 'staff' AND kind = 'otp'`), codesBefore, "still no code");
});

test("34.1-T8: Given the last access review 90 calendar days ago, when the sweep passes, then `SM_STAFF_ACCESS_REVIEW_90` reads `breached` with one `compliance` escalation; given `staff.access.review` recording keep/change/disable for every active user, then the changes are applied through `staff.role.set`/`staff.disable`, `staff.access_review.completed` is logged, the clock is satisfied and re-armed 90 days out.", { skip }, async () => {
  // the last review: every active user kept (the clock arms on the completed review — rule 6 / the timer table)
  const admin = await signIn(ADA);
  const active = await db.query<{ id: string }>(`SELECT id::text AS id FROM staff_users WHERE status = 'active' ORDER BY created_at`);
  assert.deepEqual(active.map((u) => u.id).sort(), [adaId, oliId, oraId, caraId].sort(), "Bea is disabled (T5)");
  const undecided = await api("POST", "/ops/api/staff/access-review", { decisions: [{ staff_user_id: adaId, decision: "keep" }], rationale: "partial" }, bearer(admin.token));
  assert.equal(undecided.status, 400, "every active user is decided or the review is refused"); assert.equal(await count(`staff_access_reviews`), 0);
  const first = await api("POST", "/ops/api/staff/access-review", { decisions: active.map((u) => ({ staff_user_id: u.id, decision: "keep" })), rationale: "Q3 review: everyone keeps their roles" }, bearer(admin.token));
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body["changes"], 0); assert.equal(first.body["reviewed_by"], adaId); assert.equal(first.body["reviewed_at"], clock.now());
  const reviewedAt = clock.now(); const reviewDate = reviewedAt.slice(0, 10);
  let timers = await reviewTimers();
  assert.equal(timers.length, 1); assert.equal(timers[0]!.status, "armed"); assert.equal(timers[0]!.anchor_date, reviewDate);
  const due1 = new Date(Date.parse(`${reviewDate}T00:00:00Z`) + ACCESS_REVIEW_DAYS * DAY).toISOString().slice(0, 10);
  assert.equal(timers[0]!.due_date, due1); assert.equal(due1, "2026-12-13");
  const page = await api("GET", "/ops/api/staff/access-reviews", undefined, bearer(admin.token));
  assert.equal(page.status, 200); assert.equal((page.body["clock"] as Json)["status"], "armed"); assert.equal((page.body["clock"] as Json)["due_date"], due1); assert.equal(page.body["escalation"], null);
  // 90 calendar days pass without a review: the sweep breaches the clock, one compliance escalation
  clock.set(at(91 * DAY));
  const sweep = await runtime.sweep();
  const breached = sweep.breaches.filter((b) => b.code === "SM_STAFF_ACCESS_REVIEW_90");
  assert.equal(breached.length, 1); assert.deepEqual([breached[0]!.loan_id, breached[0]!.severity, breached[0]!.escalate_to], [null, 3, ["compliance"]]);
  timers = await reviewTimers(); assert.equal(timers.length, 1); assert.equal(timers[0]!.status, "breached"); assert.notEqual(timers[0]!.breached_at, null);
  const esc = await db.query<{ owner_role: string; severity: string; status: string; payload: Json }>(`SELECT owner_role, severity, status, payload FROM escalations WHERE payload->>'timer_code' = 'SM_STAFF_ACCESS_REVIEW_90'`);
  assert.equal(esc.length, 1); assert.deepEqual([esc[0]!.owner_role, esc[0]!.severity, esc[0]!.status], ["compliance", "3", "open"]); assert.equal(esc[0]!.payload["timer_id"], timers[0]!.id);
  assert.equal((await runtime.sweep()).breaches.filter((b) => b.code === "SM_STAFF_ACCESS_REVIEW_90").length, 0, "a breached clock breaches once");
  assert.equal(await count(`escalations WHERE payload->>'timer_code' = 'SM_STAFF_ACCESS_REVIEW_90'`), 1);
  // sessions keep working (edge cases: the control is the review, not a lock-out) — the admin's is past its 12 hours, so a fresh one
  const reviewer = await signIn(ADA);
  const overdue = await api("GET", "/ops/api/staff/access-reviews", undefined, bearer(reviewer.token));
  assert.equal(overdue.status, 200); assert.equal((overdue.body["clock"] as Json)["status"], "breached"); assert.notEqual(overdue.body["escalation"], null);
  // the review: keep the admin, change the colleague back to ops_analyst, disable the officer — the changes run through staff.role.set / staff.disable
  const oraSession = await signIn(ORA); assert.equal((await api("GET", "/ops/api/me", undefined, bearer(oraSession.token))).status, 200);
  const rationale = `Q4 review (${R}): the officer left, the analyst's approvals ended`;
  const decisionsBefore = { set: (await decisions("staff.role.set")).length, off: (await decisions("staff.disable")).length, review: (await decisions("staff.access.review")).length };
  const second = await api("POST", "/ops/api/staff/access-review", { decisions: [{ staff_user_id: adaId, decision: "keep" }, { staff_user_id: oliId, decision: "change", roles: ["ops_analyst"] }, { staff_user_id: oraId, decision: "disable" }, { staff_user_id: caraId, decision: "keep" }], rationale }, bearer(reviewer.token));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual([second.body["reviewed_by"], second.body["reviewed_at"], second.body["changes"]], [adaId, clock.now(), 2]);
  assert.deepEqual(second.body["users"], [
    { staff_user_id: adaId, roles_before: ["admin"], decision: "keep", roles_after: ["admin"] },
    { staff_user_id: oliId, roles_before: ["ops_analyst", "officer"], decision: "change", roles_after: ["ops_analyst"] },
    { staff_user_id: oraId, roles_before: ["officer"], decision: "disable", roles_after: [] },
    { staff_user_id: caraId, roles_before: ["compliance"], decision: "keep", roles_after: ["compliance"] }]);
  assert.deepEqual(second.body["applied"], [{ staff_user_id: oliId, decision: "change", changed: true }, { staff_user_id: oraId, decision: "disable", changed: true }]);
  assert.deepEqual((second.body["events"] as string[]).filter((t) => t.startsWith("staff.")).sort(), ["staff.access_review.completed", "staff.disabled", "staff.role.changed"]);
  assert.equal((second.body["decision_ids"] as string[]).length, 3, "staff.role.set, staff.disable and the review's own decision");
  // applied: the rows, the events (by the reviewer), the decisions with the review's rationale
  assert.deepEqual((await userRow(oliId)).roles, ["ops_analyst"]); assert.equal((await userRow(oraId)).status, "disabled"); assert.notEqual((await userRow(oraId)).disabled_at, null); assert.deepEqual((await userRow(adaId)).roles, ["admin"]);
  const changed = (await events("staff.role.changed")).filter((e) => e.payload["staff_user_id"] === oliId); assert.equal(changed.length, 2);
  assert.deepEqual([changed[1]!.payload["roles_before"], changed[1]!.payload["roles_after"], changed[1]!.payload["by"], changed[1]!.actor_id], [["ops_analyst", "officer"], ["ops_analyst"], adaId, adaId]);
  const disabled = (await events("staff.disabled")).filter((e) => e.payload["staff_user_id"] === oraId); assert.equal(disabled.length, 1); assert.equal((await events("staff.disabled")).length, 2, "Bea's (T5) and Ora's"); assert.equal(disabled[0]!.payload["by"], adaId); assert.ok((disabled[0]!.payload["sessions_revoked"] as string[]).includes(oraSession.session_id));
  const revoked = await api("GET", "/ops/api/me", undefined, bearer(oraSession.token)); assert.equal(revoked.status, 401, "the disabled officer's session is revoked in the same transaction (rule 5: 401 SESSION_EXPIRED on the next request)"); assert.equal(revoked.body["code"], "SESSION_EXPIRED"); assert.notEqual((await sessionRow(oraSession.session_id)).revoked_at, null);
  assert.equal((await api("POST", "/ops/api/auth/code", { email: ORA.email })).status, 200, "the door answers the same to a disabled address");
  const disabledDoor = await api("POST", "/ops/api/auth/signin", { email: ORA.email, password: ORA.password }); assert.equal(disabledDoor.status, 401); assert.equal(disabledDoor.body["code"], "PASSWORD_WRONG", "a disabled address answers the same as an unknown one"); assert.equal("staff_user_id" in disabledDoor.body, false);
  for (let i = 0; i < 50 && !(await db.query(`SELECT 1 FROM staff_actions WHERE route = '/ops/api/auth/signin' AND refusal_code = 'ACCOUNT_DISABLED' AND staff_user_id = $1`, [oraId])).length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await db.query(`SELECT 1 FROM staff_actions WHERE route = '/ops/api/auth/signin' AND refusal_code = 'ACCOUNT_DISABLED' AND staff_user_id = $1`, [oraId])).length, 1, "the action log keeps the reason");
  const sets = (await decisions("staff.role.set")).slice(decisionsBefore.set); assert.equal(sets.length, 1); assert.equal(sets[0]!.subject_id, oliId); assert.match(sets[0]!.rationale, /access review: Q4 review/); assert.equal(sets[0]!.approved_by, adaId);
  const offs = (await decisions("staff.disable")).slice(decisionsBefore.off); assert.equal(offs.length, 1); assert.equal(offs[0]!.subject_id, oraId); assert.match(offs[0]!.rationale, /access review: Q4 review/); assert.equal(offs[0]!.approved_by, adaId);
  const rev = (await decisions("staff.access.review")).slice(decisionsBefore.review); assert.equal(rev.length, 1); assert.equal(rev[0]!.subject_id, second.body["review_id"]); assert.match(rev[0]!.rationale, /4 active users reviewed/); assert.match(rev[0]!.rationale, /2 changes applied/);
  assert.deepEqual([rev[0]!.rule_set_version, rev[0]!.model_version, rev[0]!.prompt_version, rev[0]!.confidence, rev[0]!.approved_role], [STAFF_RULE_SET_VERSION, STAFF_MODEL_VERSION, STAFF_PROMPT_VERSION, "1.0000", "admin"]);
  // staff.access_review.completed{reviewed_by, users, changes} and the staff_access_reviews row
  const completed = await events("staff.access_review.completed"); assert.equal(completed.length, 2);
  const c = completed[1]!; assert.deepEqual([c.payload["review_id"], c.payload["reviewed_by"], c.payload["reviewed_at"], c.payload["changes"], c.payload["origination"]], [second.body["review_id"], adaId, clock.now(), 2, true]);
  assert.deepEqual((c.payload["users"] as Json[]).map((u) => u["decision"]), ["keep", "change", "disable", "keep"]); assert.doesNotMatch(JSON.stringify(c.payload), /@/);
  const reviews = await db.query<{ id: string; reviewed_by: string; users: Json[] }>(`SELECT id::text AS id, reviewed_by::text AS reviewed_by, users FROM staff_access_reviews ORDER BY reviewed_at`);
  assert.equal(reviews.length, 2); assert.equal(reviews[1]!.id, second.body["review_id"]); assert.equal(reviews[1]!.reviewed_by, adaId); assert.deepEqual(reviews[1]!.users, second.body["users"]);
  await assert.rejects(db.query(`DELETE FROM staff_access_reviews WHERE id = $1`, [reviews[1]!.id]), "append-only");
  // the clock: the breached instance satisfied (late), a new one armed 90 calendar days out
  timers = await reviewTimers(); assert.equal(timers.length, 2);
  assert.equal(timers[0]!.status, "satisfied_late"); assert.equal(timers[0]!.satisfied_at !== null, true);
  const secondDate = clock.now().slice(0, 10); const due2 = new Date(Date.parse(`${secondDate}T00:00:00Z`) + ACCESS_REVIEW_DAYS * DAY).toISOString().slice(0, 10);
  assert.deepEqual([timers[1]!.status, timers[1]!.anchor_date, timers[1]!.due_date], ["armed", secondDate, due2]); assert.equal(due2, "2027-03-14");
  const after = await api("GET", "/ops/api/staff/access-reviews", undefined, bearer(reviewer.token));
  assert.equal((after.body["clock"] as Json)["status"], "armed"); assert.equal((after.body["clock"] as Json)["due_date"], due2); assert.equal((after.body["reviews"] as Json[]).length, 2); assert.equal((after.body["active_users"] as Json[]).length, 3);
  assert.equal((await runtime.sweep()).breaches.filter((b) => b.code === "SM_STAFF_ACCESS_REVIEW_90").length, 0, "nothing due");
  // the reviewer may not change or disable their own row in the review (NO_SELF_ROLE_CHANGE)
  const selfReview = await api("POST", "/ops/api/staff/access-review", { decisions: [{ staff_user_id: adaId, decision: "change", roles: ["admin", "compliance"] }, { staff_user_id: oliId, decision: "keep" }, { staff_user_id: caraId, decision: "keep" }], rationale: "self" }, bearer(reviewer.token));
  assert.equal(selfReview.status, 409, JSON.stringify(selfReview.body)); assert.equal(selfReview.body["code"], "NO_SELF_ROLE_CHANGE");
  assert.equal(await count(`staff_access_reviews`), 2); assert.equal((await reviewTimers()).length, 2);
});
