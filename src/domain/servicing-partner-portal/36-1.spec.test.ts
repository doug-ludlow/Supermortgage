// 36.1 Partner identity, doors, roles, action log, tenant scope
// spec/sections/36-servicing-partner-portal/36-1-partner-identity-doors-roles-action-log-tenant-scope.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness (34.1's, over the partner tables): own database `<base>_36_1` (dropped, created, migrated), the API server of
// src/runtime/server.ts in-process with the ops console at /ops and /ops/api (T7/T8's other surface) and the partner prefix
// /v1/partner/* (src/runtime/partner-portal/routes.ts), the FAKE e-delivery port (the code is echoed as `fake_code` outside
// production, exactly as the borrower and staff doors), a FixedClock. The demo partner (33.1's Northlight fixture, 12 monitored
// loans through seedPartnerBookDemo) with its seeded partner_admin (seedPartnerPortalDemo — 36.1 Operational prerequisites),
// and a second partner (one loan of its own, imported through importPartnerBook) for the cross-tenant test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { writeXlsx } from "../../infra/files/xlsx.ts";
import { M3_V1 } from "../partner-book/profiles/m3-v1.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, demoMin, type DemoLoan } from "../partner-book/fixtures/partner-book-demo.ts";
import { importPartnerBook, seedPartnerBookDemo } from "../../runtime/partner-book.ts";
import { seedPartnerPortalDemo, DEMO_PARTNER_ADMIN_EMAIL } from "../../runtime/partner-portal/seed.ts";
import { PARTNER_INVITE_TEMPLATE, PARTNER_RULE_SET_VERSION, PARTNER_MODEL_VERSION, PARTNER_PROMPT_VERSION, SIGNIN_INVALID } from "../../runtime/partner-portal/auth.ts";
import { bootstrapStaffAdmin } from "../../runtime/staff/auth.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
/** 2026-09-14 08:00 America/New_York. */
const T0 = "2026-09-14T12:00:00.000Z";
const clock = new FixedClock(T0);
type Json = Record<string, unknown>;

// the people: the seeded partner_admin of the demo partner (Northlight), the partner_ops colleagues she invites (T2's and T4's), the one disabled in T5, a staff admin for T7
const NORA = { email: DEMO_PARTNER_ADMIN_EMAIL, name: "Nora Northlight", password: `nora-northlight-admin-${R}` };
const OLI = { email: `oli.ops.${R}@northlight.example`, name: "Oli Operations", password: `oli-partner-ops-pass-${R}` };       // T2: partner_ops, cannot upload
const PAT = { email: `pat.ops.${R}@northlight.example`, name: "Pat Ops", password: `pat-partner-ops-pass-${R}` };              // T4: invited, signs in, cannot upload
const DEE = { email: `dee.disabled.${R}@northlight.example`, name: "Dee Disabled", password: `dee-disabled-user-pass-${R}` };   // T5: disabled after enrolment
const ADA = { email: `ada.admin.${R}@example.test`, name: "Ada Admin", password: `ada-correct-horse-${R}` };                      // T7: a staff admin with a staff session
let noraId = ""; let oliId = ""; let patId = ""; let deeId = "";
type Session = { token: string; session_id: string; partner_user_id: string; partner_party_id: string; role: string; body: Json };
let nora: Session; let oli: Session; let dee: Session;
let partnerA = ""; let partnerB = ""; let loanOfA = ""; let loanOfB = "";

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
const logLines: string[] = [];
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const edelivery = (): FakeEdelivery => runtime.ports.edelivery as FakeEdelivery;
const DENISE = { name: "Denise Okoro", email: `denise.okoro.${R}@example.test`, phone: "+16025550177", number: "NL-200007" };

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|partner|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger });
  // operational prerequisites: the demo partner's parties{servicer} row (33.1's ensurePartner finds it by legal name) and its 12-loan book
  partnerA = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, '{"phone": "+18005550199"}'::jsonb) RETURNING id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id]))[0]!.id;
  const seeded = await seedPartnerBookDemo(runtime, { partner_id: partnerA });
  assert.equal(seeded.status, "loaded"); assert.equal(seeded.partner_party_id, partnerA); assert.equal(seeded.rows_loaded, 12);
  loanOfA = seeded.loans.find((l) => l.servicer_loan_number === loanN(1).servicer_loan_number)!.loan_id;
  // the second partner with one monitored loan of its own (33.1-T5's second-partner tape: loan 7's row under another number, name and MIN)
  const col = (key: string): number => { const i = M3_V1.columns.findIndex((c) => c.key === key); assert.ok(i >= 0, `the profile's ${key} column`); return i; };
  const row = [...book.tapeRows[7]!]; row[col("borrower_name")] = DENISE.name; row[col("servicer_loan_number")] = DENISE.number; row[col("mers_min")] = demoMin(207);
  const partnerBInput = { legal_name: `Second Servicer (FAKE partner) ${R}`, nmlsr_id: "7654321", servicer_number: "300054321" };
  const b = await importPartnerBook(runtime, { partner: partnerBInput, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "second-partner.xlsx", content: writeXlsx([book.tapeRows[0]!, row], "M3") }, supplement: { filename: "second-partner-supplement.csv", content: new Uint8Array(Buffer.from(`servicer_loan_number,borrower_email,borrower_phone,borrower_name\n${DENISE.number},${DENISE.email},${DENISE.phone},${DENISE.name}\n`, "utf8")) }, synthetic: true }, { kind: "system", id: "seed-demo" });
  assert.equal(b.status, "loaded", JSON.stringify(b.report).slice(0, 600)); assert.equal(b.rows_loaded, 1);
  partnerB = b.partner_party_id; loanOfB = b.loans[0]!.loan_id; assert.notEqual(partnerB, partnerA);
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) await close(); });

// ---------------------------------------------------------------- helpers over the API
type Reply = { status: number; body: Json; headers: Headers };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.36.0.1", "user-agent": "36.1-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {}, headers: r.headers };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
/** The door's first half: a code to the e-mail (FAKE, echoed) verified into an enrol/step token — never a session. */
async function codeToken(email: string): Promise<{ token: string; body: Json; fake_code: string }> {
  const c = await api("POST", "/v1/partner/auth/code", { email });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body["delivery"], "FAKE"); assert.equal(typeof c.body["fake_code"], "string");
  const v = await api("POST", "/v1/partner/auth/verify", { email, code: c.body["fake_code"] });
  assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(typeof v.body["token"], "string"); assert.equal(v.body["session"], null);
  return { token: v.body["token"] as string, body: v.body, fake_code: c.body["fake_code"] as string };
}
/** Enrolment: the code, then the password on the enrol token (status invited → active). */
async function enrol(p: { email: string; password: string }): Promise<string> {
  const { token } = await codeToken(p.email);
  const r = await api("POST", "/v1/partner/auth/password", { token, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["enrolled"], true);
  return r.body["partner_user_id"] as string;
}
/** A session: the code (possession) and the password (knowledge) — rule 1's two factors. */
async function signIn(p: { email: string; password: string }): Promise<Session> {
  await codeToken(p.email);
  const r = await api("POST", "/v1/partner/auth/signin", { email: p.email, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body["token"] as string, session_id: r.body["session_id"] as string, partner_user_id: r.body["partner_user_id"] as string, partner_party_id: r.body["partner_party_id"] as string, role: r.body["role"] as string, body: r.body };
}
/** A partner_admin invites a colleague through the partner prefix (partner.user.invite on the bus; the tenant from the session). */
async function invite(admin: Session, p: { email: string; name: string }, roles: string[]): Promise<Json> {
  const r = await api("POST", "/v1/partner/users/invite", { email: p.email, name: p.name, roles, partner_party_id: partnerB /* ignored: the tenant is the session's (rule 8) */ }, bearer(admin.token));
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["status"], "invited"); assert.equal(r.body["partner_party_id"], admin.partner_party_id, "the tenant is the session's, never the body's");
  return r.body;
}
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type ActionRow = { id: string; partner_user_id: string | null; partner_party_id: string | null; role: string | null; action: string; subject_kind: string | null; subject_id: string | null; result: string; refusal_code: string | null; row_text: string };
const actions = async (where: string, params: unknown[] = []): Promise<ActionRow[]> => db.query<ActionRow>(`SELECT id::text AS id, partner_user_id::text AS partner_user_id, partner_party_id::text AS partner_party_id, role, action, subject_kind, subject_id, result, refusal_code, partner_actions::text AS row_text FROM partner_actions WHERE ${where} ORDER BY at, id`, params);
/** Every homeowner name, e-mail and phone the two tapes carry — none may appear on a log row (rule 5; T3, T6). */
const homeownerPii = (): string[] => [...book.loans.flatMap((l) => [l.name, l.first_name, l.last_name, l.email, l.phone, l.supplement_email, l.supplement_phone]), DENISE.name, "Okoro", DENISE.email, DENISE.phone].filter((x): x is string => typeof x === "string" && x.length > 2);
const assertNoPii = (text: string, what: string): void => { for (const p of homeownerPii()) assert.ok(!text.includes(p), `${what} carries homeowner data: ${p}`); assert.doesNotMatch(text, /@/, `${what} carries an e-mail address`); };
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("36.1-T1: Given a seeded partner_admin bound to the demo partner, when they request an email code and verify it plus password, then a `partner_sessions` row exists with that `partner_party_id` and role `partner_admin`, and no `staff_sessions` row is written.", { skip }, async () => {
  // the seed (Operational prerequisites): the demo partner's first partner_admin, invited by the system actor through partner.user.invite; idempotent
  const seed = await seedPartnerPortalDemo(runtime, { partner_id: partnerA });
  assert.equal(seed.created, true); assert.equal(seed.partner_party_id, partnerA); assert.deepEqual(seed.roles, ["partner_admin"]); assert.equal(seed.status, "invited");
  noraId = seed.partner_user_id;
  assert.equal((await seedPartnerPortalDemo(runtime, { partner_id: partnerA })).created, false, "the seed invites the first admin once");
  const row = (await db.query<{ status: string; roles: string[]; partner_party_id: string; invited_by: string | null; invited_by_actor: string }>(`SELECT status, roles, partner_party_id::text AS partner_party_id, invited_by::text AS invited_by, invited_by_actor FROM partner_users WHERE id = $1`, [noraId]))[0]!;
  assert.deepEqual([row.status, row.roles, row.partner_party_id, row.invited_by, row.invited_by_actor], ["invited", ["partner_admin"], partnerA, null, "system:seed-demo"]);
  // the code, verified: an enrol token that opens nothing (GET /v1/partner/me with it answers 401); the password at enrolment
  const { token, body } = await codeToken(NORA.email);
  assert.deepEqual([body["partner_user_id"], body["partner_party_id"], body["status"], body["has_password"], body["roles"]], [noraId, partnerA, "invited", false, ["partner_admin"]]);
  const me = await api("GET", "/v1/partner/me", undefined, bearer(token));
  assert.equal(me.status, 401, JSON.stringify(me.body)); assert.equal(me.body["code"], "AUTH_REQUIRED");
  assert.equal(await count(`partner_sessions WHERE partner_user_id = $1`, [noraId]), 0, "a code alone opens no session");
  const set = await api("POST", "/v1/partner/auth/password", { token, password: NORA.password });
  assert.equal(set.status, 200, JSON.stringify(set.body)); assert.equal(set.body["enrolled"], true); assert.equal(set.body["status"], "active");
  // the same enrol token again is a reset now, and a reset needs a second proof the mailbox does not give
  const reset = await api("POST", "/v1/partner/auth/password", { token, password: `another-long-password-${R}` });
  assert.equal(reset.status, 401, JSON.stringify(reset.body)); assert.equal(reset.body["code"], "PROOF_REQUIRED");
  // the sign-in: the password (knowledge) plus the code verified within 10 minutes (possession) — the session
  const signin = await api("POST", "/v1/partner/auth/signin", { email: NORA.email, password: NORA.password });
  assert.equal(signin.status, 200, JSON.stringify(signin.body));
  nora = { token: signin.body["token"] as string, session_id: signin.body["session_id"] as string, partner_user_id: signin.body["partner_user_id"] as string, partner_party_id: signin.body["partner_party_id"] as string, role: signin.body["role"] as string, body: signin.body };
  assert.deepEqual([nora.partner_user_id, nora.partner_party_id, nora.role, signin.body["roles"], signin.body["factors"]], [noraId, partnerA, "partner_admin", ["partner_admin"], ["email_code", "password"]]);
  // the session row: bound to the demo partner, role partner_admin, 30 minutes idle within 12 hours absolute
  const s = (await db.query<{ partner_user_id: string; partner_party_id: string; role: string; factors: string[]; revoked_at: string | null; idle_minutes: number }>(`SELECT partner_user_id::text AS partner_user_id, partner_party_id::text AS partner_party_id, role, factors, revoked_at::text AS revoked_at, round(extract(epoch FROM (expires_at - created_at)) / 60)::int AS idle_minutes FROM partner_sessions WHERE id = $1`, [nora.session_id]))[0]!;
  assert.deepEqual([s.partner_user_id, s.partner_party_id, s.role, s.factors, s.revoked_at, s.idle_minutes], [noraId, partnerA, "partner_admin", ["email_code", "password"], null, 30]);
  // the password alone, again: FACTOR_REQUIRED (the code was spent by the session)
  const again = await api("POST", "/v1/partner/auth/signin", { email: NORA.email, password: NORA.password });
  assert.equal(again.status, 401); assert.equal(again.body["code"], "FACTOR_REQUIRED");
  assert.equal(await count(`partner_sessions WHERE partner_user_id = $1`, [noraId]), 1);
  // never a staff row (36.1-T1; rule 2): no staff_sessions, no staff_users, no staff_actions row from any of this
  assert.equal(await count(`staff_sessions`), 0, "no staff_sessions row is written"); assert.equal(await count(`staff_users`), 0); assert.equal(await count(`staff_actions`), 0, "the partner prefix never reaches the /v1 door's staff_actions log");
  // /v1/partner/me under the session: the user, the tenant's legal name and NMLSR id, the roles held, the session's default role
  const who = await api("GET", "/v1/partner/me", undefined, bearer(nora.token));
  assert.equal(who.status, 200, JSON.stringify(who.body));
  assert.deepEqual([who.body["partner_user_id"], who.body["role"], who.body["acted_as"], who.body["roles"]], [noraId, "partner_admin", "partner_admin", ["partner_admin"]]);
  const partner = who.body["partner"] as Json; assert.deepEqual([partner["partner_party_id"], partner["legal_name"]], [partnerA, DEMO_PARTNER.legal_name]); assert.equal(typeof partner["nmlsr_id"], "string", "the NMLSR id from the partners entity (33.1's planPartner)");
  // the codes went to the partner rows of auth_challenges, never the staff rows
  assert.equal(await count(`auth_challenges WHERE subject_kind = 'partner' AND partner_user_id = $1 AND kind = 'otp'`, [noraId]), 1, "one code: verified into the enrol token, then the possession factor of the first sign-in");
  assert.equal(await count(`auth_challenges WHERE subject_kind = 'staff'`), 0);
});

test("36.1-T2: Given a partner_ops session, when they `POST /v1/partner/book/imports`, then the command is refused `403 ROLE_REQUIRED`.", { skip }, async () => {
  const inv = await invite(nora, OLI, ["partner_ops"]); oliId = inv["partner_user_id"] as string;
  assert.equal(await enrol(OLI), oliId);
  oli = await signIn(OLI);
  assert.deepEqual([oli.partner_party_id, oli.role, oli.body["roles"]], [partnerA, "partner_ops", ["partner_ops"]]);
  const importsBefore = await count(`partner_book_imports`); const actionsBefore = await count(`partner_actions`);
  // the act under the session's default role (partner_ops): 403 ROLE_REQUIRED{role: partner_admin, held, act_as: []} — before any read of the body or any write
  const r = await api("POST", "/v1/partner/book/imports", { as_of_date: DEMO_AS_OF, profile: "m3-v1", partner_party_id: partnerB }, bearer(oli.token));
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.deepEqual([r.body["code"], r.body["role"], r.body["held"], r.body["act_as"]], ["ROLE_REQUIRED", "partner_admin", ["partner_ops"], []]);
  // naming a role the session does not hold is refused the same way; a role the route accepts but the account lacks never substitutes
  const asAdmin = await api("POST", "/v1/partner/book/imports?role=partner_admin", {}, bearer(oli.token));
  assert.equal(asAdmin.status, 403); assert.deepEqual([asAdmin.body["code"], asAdmin.body["act_as"]], ["ROLE_REQUIRED", []]);
  assert.equal(await count(`partner_book_imports`), importsBefore, "nothing was written");
  // rule 5: the refusal is on the log — the command asked for, the role asked for, result refused
  const rows = await actions(`partner_user_id = $1 AND result = 'refused' AND refusal_code = 'ROLE_REQUIRED'`, [oliId]);
  assert.equal(rows.length, 2); assert.deepEqual([rows[0]!.result, rows[0]!.refusal_code, rows[0]!.role, rows[0]!.partner_party_id], ["refused", "ROLE_REQUIRED", "partner_admin", partnerA]);
  assert.equal(await count(`partner_actions`), actionsBefore + 2);
  // the partner_ops session reads the book (a loan page) — reads are not refused
  const read = await api("GET", `/v1/partner/book/loans/${loanOfA}`, undefined, bearer(oli.token));
  assert.equal(read.status, 200, JSON.stringify(read.body)); assert.equal(read.body["acted_as"], "partner_ops");
});

test("36.1-T3: Given partner A’s session, when they `GET /v1/partner/book/loans/:id` for a loan whose `partner_party_id` is partner B, then the response is `404 NOT_FOUND` and a `partner_actions` row is written with `result=refused` and no homeowner PII.", { skip }, async () => {
  const loanB = (await db.query<{ partner_party_id: string; status: string }>(`SELECT partner_party_id::text AS partner_party_id, status::text AS status FROM loans WHERE id = $1`, [loanOfB]))[0]!;
  assert.deepEqual([loanB.partner_party_id, loanB.status], [partnerB, "monitored"], "partner B's monitored loan exists");
  // partner A's admin asks for it: 404 NOT_FOUND — never 403, never a body that names the loan
  const r = await api("GET", `/v1/partner/book/loans/${loanOfB}`, undefined, bearer(nora.token));
  assert.equal(r.status, 404, JSON.stringify(r.body)); assert.equal(r.body["code"], "NOT_FOUND");
  assert.doesNotMatch(JSON.stringify(r.body), new RegExp(`Second Servicer|${escapeRe(DENISE.number)}|Okoro`), "existence is not a signal");
  // the log row: refused, NOT_FOUND, the requested id, the person and the tenant — and no homeowner name, e-mail or phone
  const rows = await actions(`partner_user_id = $1 AND subject_id = $2`, [noraId, loanOfB]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.action, rows[0]!.subject_kind, rows[0]!.result, rows[0]!.refusal_code, rows[0]!.partner_party_id, rows[0]!.role], ["partner_portal.viewed", "loan", "refused", "NOT_FOUND", partnerA, "partner_admin"]);
  assertNoPii(rows[0]!.row_text, "the refused log row");
  // partner A's own loan answers 200 with the partner-grade projection (34.3's page scoped to the tenant)
  const own = await api("GET", `/v1/partner/book/loans/${loanOfA}`, undefined, bearer(nora.token));
  assert.equal(own.status, 200, JSON.stringify(own.body));
  const loan = own.body["loan"] as Json; const homeowner = own.body["homeowner"] as Json;
  assert.deepEqual([loan["loan_id"], loan["partner_party_id"], loan["status"], loan["servicer_loan_number"]], [loanOfA, partnerA, "monitored", loanN(1).servicer_loan_number]);
  assert.equal(homeowner["name"], `${loanN(1).first_name} ${loanN(1).last_name[0]}.`, "first name + last initial"); assert.equal(homeowner["email"], undefined); assert.equal(homeowner["phone"], undefined);
  assert.doesNotMatch(JSON.stringify(own.body), /@/, "no e-mail on a partner surface");
  // a loan id that exists nowhere and a malformed id answer the same 404
  assert.equal((await api("GET", `/v1/partner/book/loans/${randomUUID()}`, undefined, bearer(nora.token))).status, 404);
  assert.equal((await api("GET", `/v1/partner/book/loans/not-a-uuid`, undefined, bearer(nora.token))).status, 404);
});

test("36.1-T4: Given a partner_admin, when they invite a partner_ops user, then that user can sign in and cannot upload.", { skip }, async () => {
  const messagesBefore = edelivery().messages.size; const decisionsBefore = await count(`agent_decisions WHERE action = 'partner.user.invite'`);
  const inv = await invite(nora, PAT, ["partner_ops"]); patId = inv["partner_user_id"] as string;
  assert.deepEqual([inv["roles"], inv["invited_by"], inv["reinvited"], inv["bounced"], inv["held_reason"], inv["acted_as"]], [["partner_ops"], noraId, false, false, null, "partner_admin"]);
  assert.equal(typeof inv["notice_id"], "string"); assert.equal(typeof inv["decision_id"], "string");
  // the row: invited, the tenant's, the e-mail hashed and encrypted, never in clear on the row
  const row = (await db.query<{ status: string; roles: string[]; partner_party_id: string; invited_by: string | null; name: string | null; row_text: string }>(`SELECT status, roles, partner_party_id::text AS partner_party_id, invited_by::text AS invited_by, name, partner_users::text AS row_text FROM partner_users WHERE id = $1`, [patId]))[0]!;
  assert.deepEqual([row.status, row.roles, row.partner_party_id, row.invited_by, row.name], ["invited", ["partner_ops"], partnerA, noraId, PAT.name]);
  assert.ok(!row.row_text.includes(PAT.email), "the e-mail is never in clear on the row");
  // NTC_SM_PARTNER_USER_INVITE by e-mail to that address (the FAKE port holds it): the partner's legal name, the roles, the sign-in address; no loan figure, no homeowner data
  assert.equal(edelivery().messages.size, messagesBefore + 1);
  const msg = [...edelivery().messages.values()].find((m) => m.messageId.startsWith(`partner_user:${patId}:invite:`));
  assert.ok(msg, "the invitation is the FAKE port's"); assert.equal(msg.message.to, PAT.email); assert.equal(msg.message.channel, "email"); assert.equal(msg.status, "sent");
  assert.match(msg.message.subject, new RegExp(`^${escapeRe(DEMO_PARTNER.legal_name)} invited you .* partner_ops$`));
  const notice = (await db.query<{ template_code: string; status: string; payload: Json }>(`SELECT template_code, status, payload FROM notices WHERE id = $1`, [inv["notice_id"]]))[0]!;
  assert.equal(notice.template_code, PARTNER_INVITE_TEMPLATE); assert.equal(notice.status, "sent");
  const rendered = runtime.noticeMemory.get(inv["notice_id"] as string); assert.ok(rendered, "the rendered notice is in the runtime's memory");
  const text = JSON.stringify(rendered.rendered);
  assert.match(text, new RegExp(escapeRe(DEMO_PARTNER.legal_name))); assert.match(text, /partner_ops/); assert.match(text, /\/partners\/sign-in/); assert.match(text, /a code will be sent to this e-mail/);
  assert.doesNotMatch(text, /\$|\bloan\b|\bborrower\b|\bhomeowner\b/); assert.doesNotMatch(text, /@/, "the e-mail is 'this e-mail', never spelled");
  // the decision record: {partner_user_id, partner_party_id, action invite, roles, rationale, by, partner_portal.access.v1, deterministic, 36.1-v1, 1}, approved by the partner_admin
  const decisions = await db.query<{ agent: string; subject_kind: string | null; subject_id: string | null; rationale: string; approved_by: string | null; approved_role: string | null; rule_set_version: string; model_version: string | null; prompt_version: string | null; confidence: string | null }>(`SELECT agent, subject_kind, subject_id, rationale, approved_by, approved_role, rule_set_version, model_version, prompt_version, confidence::text AS confidence FROM agent_decisions WHERE action = 'partner.user.invite' AND subject_id = $1`, [patId]);
  assert.equal(decisions.length, 1); assert.equal(await count(`agent_decisions WHERE action = 'partner.user.invite'`), decisionsBefore + 1);
  const d = decisions[0]!;
  assert.deepEqual([d.agent, d.subject_kind, d.approved_by, d.approved_role, d.rule_set_version, d.model_version, d.prompt_version, Number(d.confidence)], ["security-records", "partner_user", noraId, "partner_admin", PARTNER_RULE_SET_VERSION, PARTNER_MODEL_VERSION, PARTNER_PROMPT_VERSION, 1]);
  assert.match(d.rationale, new RegExp(`partner_user ${patId} of tenant ${partnerA}: action invite, roles \\[partner_ops\\]`)); assert.doesNotMatch(d.rationale, /@/);
  // rule 2: a role is never self-granted — the admin's own e-mail is refused; a staff role is not a partner role
  const self = await api("POST", "/v1/partner/users/invite", { email: NORA.email, name: NORA.name, roles: ["partner_admin"] }, bearer(nora.token));
  assert.equal(self.status, 409, JSON.stringify(self.body)); assert.equal(self.body["code"], "NO_SELF_ROLE_CHANGE");
  const staffRole = await api("POST", "/v1/partner/users/invite", { email: `x.${R}@northlight.example`, name: "X", roles: ["ops_analyst"] }, bearer(nora.token));
  assert.equal(staffRole.status, 400, JSON.stringify(staffRole.body)); assert.match(String(staffRole.body["reason"]), /unknown partner role ops_analyst/);
  // rule 3: partner_ops cannot invite (the Admin area is partner_admin's)
  const opsInvite = await api("POST", "/v1/partner/users/invite", { email: `y.${R}@northlight.example`, name: "Y", roles: ["partner_ops"] }, bearer(oli.token));
  assert.equal(opsInvite.status, 403); assert.equal(opsInvite.body["code"], "ROLE_REQUIRED");
  assert.equal(await count(`partner_users WHERE partner_party_id = $1`, [partnerA]), 3, "no row for the refused invitations");
  // the invitee enrols (the code to the e-mail on the row, then the password) and signs in: a partner_ops session, bound to the tenant
  assert.equal(await enrol(PAT), patId);
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM partner_users WHERE id = $1`, [patId]))[0]!.status, "active");
  const pat = await signIn(PAT);
  assert.deepEqual([pat.partner_user_id, pat.partner_party_id, pat.role], [patId, partnerA, "partner_ops"]);
  // … and cannot upload
  const up = await api("POST", "/v1/partner/book/imports", {}, bearer(pat.token));
  assert.equal(up.status, 403, JSON.stringify(up.body)); assert.deepEqual([up.body["code"], up.body["role"], up.body["act_as"]], ["ROLE_REQUIRED", "partner_admin", []]);
  // the Admin area lists the tenant's users (and no other tenant's) to the partner_admin only
  const users = await api("GET", "/v1/partner/users", undefined, bearer(nora.token));
  assert.equal(users.status, 200); assert.deepEqual((users.body["users"] as Json[]).map((u) => u["partner_user_id"]).sort(), [noraId, oliId, patId].sort());
  assert.equal((await api("GET", "/v1/partner/users", undefined, bearer(pat.token))).status, 403);
  // the partner_admin's upload act passes the role gate (the tape drop itself is 36.2's: 501 until then)
  const adminUpload = await api("POST", "/v1/partner/book/imports", {}, bearer(nora.token));
  assert.equal(adminUpload.status, 501, JSON.stringify(adminUpload.body)); assert.equal(adminUpload.body["code"], "NOT_WIRED");
});

test("36.1-T5: Given a disabled partner_user, when they present a valid code and password, then sign-in is refused and the session is not created.", { skip }, async () => {
  const inv = await invite(nora, DEE, ["partner_auditor"]); deeId = inv["partner_user_id"] as string;
  assert.equal(await enrol(DEE), deeId);
  dee = await signIn(DEE); assert.equal(dee.role, "partner_auditor");
  assert.equal((await api("GET", "/v1/partner/me", undefined, bearer(dee.token))).status, 200);
  // the disable (DELTA-01 — no command in V1): the row's status and the revocation of its sessions in one transaction, as the state machine says
  await db.tx(async (q) => { await q.query(`UPDATE partner_users SET status = 'disabled', disabled_at = $2 WHERE id = $1`, [deeId, clock.now()]); await q.query(`UPDATE partner_sessions SET revoked_at = $2 WHERE partner_user_id = $1 AND revoked_at IS NULL`, [deeId, clock.now()]); });
  const sessionsBefore = await count(`partner_sessions`);
  // the old session answers 401 SESSION_EXPIRED (rule 6)
  const old = await api("GET", "/v1/partner/me", undefined, bearer(dee.token));
  assert.equal(old.status, 401); assert.equal(old.body["code"], "SESSION_EXPIRED");
  // a code request answers the unknown-address shape (no enumeration) and mints no code the disabled row could verify
  const c = await api("POST", "/v1/partner/auth/code", { email: DEE.email });
  assert.equal(c.status, 200); assert.equal(c.body["delivery"], "FAKE"); assert.equal(typeof c.body["fake_code"], "string");
  assert.equal(await count(`auth_challenges WHERE subject_kind = 'partner' AND partner_user_id = $1 AND kind = 'otp' AND consumed_at IS NULL AND expires_at > $2::timestamptz`, [deeId, clock.now()]), 0, "no open code on the disabled row");
  // the valid code and the valid password: the generic door answer at verify and at sign-in; no session row
  const v = await api("POST", "/v1/partner/auth/verify", { email: DEE.email, code: c.body["fake_code"] });
  assert.equal(v.status, 401, JSON.stringify(v.body)); assert.equal(v.body["code"], "OTP_INVALID"); assert.equal(v.body["token"], undefined);
  const s = await api("POST", "/v1/partner/auth/signin", { email: DEE.email, password: DEE.password });
  assert.equal(s.status, 401, JSON.stringify(s.body)); assert.equal(s.body["code"], SIGNIN_INVALID); assert.equal(s.body["token"], undefined);
  assert.equal(await count(`partner_sessions`), sessionsBefore, "no session row is created");
  assert.equal(await count(`partner_sessions WHERE partner_user_id = $1 AND revoked_at IS NULL`, [deeId]), 0);
  // the same generic answer as an unknown address and a wrong password (existence is not a signal)
  const unknown = await api("POST", "/v1/partner/auth/signin", { email: `nobody.${R}@northlight.example`, password: DEE.password });
  assert.equal(unknown.status, 401); assert.equal(unknown.body["code"], SIGNIN_INVALID);
  await codeToken(NORA.email);
  const wrong = await api("POST", "/v1/partner/auth/signin", { email: NORA.email, password: "not-the-password-at-all" });
  assert.equal(wrong.status, 401); assert.equal(wrong.body["code"], SIGNIN_INVALID);
  assert.equal((await db.query<{ failed_signins: number }>(`SELECT failed_signins FROM partner_users WHERE id = $1`, [noraId]))[0]!.failed_signins, 1, "a wrong password counts on the account (rule 1)");
  // the log keeps the reason the wire does not say
  const rows = await actions(`partner_user_id IS NULL AND subject_kind = 'auth.signin' AND result = 'refused'`);
  assert.ok(rows.some((r) => r.refusal_code === "ACCOUNT_DISABLED"), rows.map((r) => r.refusal_code).join(","));
  assert.ok(rows.some((r) => r.refusal_code === "NO_ACCOUNT"));
  for (const r of await actions(`subject_kind LIKE 'auth.%'`)) assert.ok(!r.row_text.includes("@"), "no door row carries an e-mail");
});

test("36.1-T6: Given any successful partner GET, when the action log is read, then `partner_actions` contains `partner_portal.viewed` with `view`, `partner_user_id`, `partner_party_id`, and no email/phone/name of a homeowner.", { skip }, async () => {
  const before = await count(`partner_actions`);
  const me = await api("GET", "/v1/partner/me", undefined, bearer(nora.token)); assert.equal(me.status, 200);
  const loan = await api("GET", `/v1/partner/book/loans/${loanOfA}?role=partner_admin`, undefined, bearer(nora.token)); assert.equal(loan.status, 200);
  const users = await api("GET", "/v1/partner/users", undefined, bearer(nora.token)); assert.equal(users.status, 200);
  const opsLoan = await api("GET", `/v1/partner/book/loans/${loanOfA}`, undefined, bearer(oli.token)); assert.equal(opsLoan.status, 200);
  assert.equal(await count(`partner_actions`), before + 4, "one row per request");
  const rows = (await actions(`result = 'ok' AND action = 'partner_portal.viewed'`)).slice(-4);
  // the view is the row's subject_kind (discrepancy 4), the row's id its subject_id; the person and the tenant on every row; the role that acted
  assert.deepEqual(rows.map((r) => [r.subject_kind, r.subject_id, r.partner_user_id, r.partner_party_id, r.role]), [
    ["me", noraId, noraId, partnerA, "partner_admin"], ["loan", loanOfA, noraId, partnerA, "partner_admin"], ["users", partnerA, noraId, partnerA, "partner_admin"], ["loan", loanOfA, oliId, partnerA, "partner_ops"]]);
  // no e-mail, phone or name of a homeowner on any row of the log — and no money figure, no filter text
  for (const r of await actions(`true`)) { assertNoPii(r.row_text, `partner_actions ${r.id}`); assert.doesNotMatch(r.row_text, /\$|\d{3}-\d{3}-\d{4}|\+1\d{10}/, "no figure or phone"); assert.ok(!r.row_text.includes("role=partner_admin"), "the query string is never on the row"); }
  // the log is append-only (migration 0243): an update or a delete is refused by the trigger
  await assert.rejects(db.query(`UPDATE partner_actions SET result = 'ok' WHERE id = $1`, [rows[0]!.id]));
  await assert.rejects(db.query(`DELETE FROM partner_actions WHERE id = $1`, [rows[0]!.id]));
  // rule 4 on the users list: the tenant's rows only — none of partner A's users belong to partner B's tenant
  assert.ok((users.body["users"] as Json[]).every((u) => !JSON.stringify(u).includes(partnerB)));
});

test("36.1-T7: Given a staff session cookie, when it is sent to `/v1/partner/*` or `/partners`, then the request is unauthenticated (no staff fallback).", { skip }, async () => {
  // a staff admin with a real staff session (34.1's doors on /ops/api)
  const boot = await bootstrapStaffAdmin(runtime, ADA.email, { legal_name: ADA.name }); assert.equal(boot.created, true);
  const sc = await api("POST", "/ops/api/auth/code", { email: ADA.email }); assert.equal(sc.status, 200, JSON.stringify(sc.body));
  const sv = await api("POST", "/ops/api/auth/verify", { email: ADA.email, code: sc.body["fake_code"] }); assert.equal(sv.status, 200, JSON.stringify(sv.body));
  const sp = await api("POST", "/ops/api/auth/password", { token: sv.body["token"], password: ADA.password }); assert.equal(sp.status, 200, JSON.stringify(sp.body));
  const sc2 = await api("POST", "/ops/api/auth/code", { email: ADA.email }); await api("POST", "/ops/api/auth/verify", { email: ADA.email, code: sc2.body["fake_code"] });
  const ss = await api("POST", "/ops/api/auth/signin", { email: ADA.email, password: ADA.password }); assert.equal(ss.status, 200, JSON.stringify(ss.body));
  const staffToken = ss.body["token"] as string; assert.match(ss.headers.get("set-cookie") ?? "", /^sm_staff=/);
  assert.equal((await api("GET", "/ops/api/me", undefined, { cookie: `sm_staff=${encodeURIComponent(staffToken)}` })).status, 200, "the staff cookie opens /ops/api");
  const partnerBefore = await count(`partner_sessions`); const staffActionsBefore = await count(`staff_actions`);
  // the same cookie, the same token as a bearer, the ops API_TOKEN and the header actor: 401 on every /v1/partner/* route — no staff fallback
  const attempts: [string, string, Record<string, string>][] = [
    ["GET", "/v1/partner/me", { cookie: `sm_staff=${encodeURIComponent(staffToken)}` }],
    ["GET", `/v1/partner/book/loans/${loanOfA}`, { cookie: `sm_staff=${encodeURIComponent(staffToken)}` }],
    ["GET", "/v1/partner/users", { cookie: `sm_staff=${encodeURIComponent(staffToken)}`, "x-staff-role": "admin" }],
    ["GET", "/v1/partner/me", bearer(staffToken)],
    ["GET", "/v1/partner/me", bearer(TOKEN)],
    ["GET", "/v1/partner/me", { cookie: `sm_token=${encodeURIComponent(TOKEN)}`, "x-actor-id": "u-deploy", "x-actor-role": "ops_analyst" }],
    ["POST", "/v1/partner/users/invite", { ...bearer(TOKEN), "x-actor-id": "u-deploy", "x-actor-role": "admin" }],
    ["POST", "/v1/partner/book/imports", { cookie: `sm_staff=${encodeURIComponent(staffToken)}`, "x-staff-role": "ops_analyst" }],
  ];
  for (const [method, path, headers] of attempts) {
    const r = await api(method, path, method === "POST" ? {} : undefined, headers);
    assert.equal(r.status, 401, `${method} ${path} with ${Object.keys(headers).join("+")}: ${JSON.stringify(r.body)}`); assert.equal(r.body["code"], "AUTH_REQUIRED");
  }
  // the partner app's own paths are not the API's: /partners answers nothing to a staff cookie either (the app's proxy forwards only to /v1/partner/*)
  for (const p of ["/partners", "/partners/sign-in", "/partners/book"]) { const app = await api("GET", p, undefined, { cookie: `sm_staff=${encodeURIComponent(staffToken)}` }); assert.ok(app.status === 401 || app.status === 404, `${p}: ${app.status}`); assert.equal(app.headers.get("set-cookie"), null); assert.equal(app.body["token"], undefined); }
  assert.equal(await count(`partner_sessions`), partnerBefore, "no partner session for a staff member");
  assert.equal(await count(`staff_actions`), staffActionsBefore, "the partner prefix writes no staff_actions row — its refusals are partner_actions rows");
  const refused = await actions(`partner_user_id IS NULL AND result = 'refused' AND refusal_code = 'AUTH_REQUIRED'`);
  assert.ok(refused.length >= attempts.length, `${refused.length} refused rows`);
});

test("36.1-T8: Given a partner session, when it is sent to `/ops` or `/ops/api/*`, then the request is unauthenticated (no partner fallback).", { skip }, async () => {
  assert.equal((await api("GET", "/v1/partner/me", undefined, bearer(nora.token))).status, 200, "the partner session is live");
  const staffActionsBefore = await count(`staff_actions`);
  // the partner bearer, and the partner token as a staff cookie: 401 on /ops/api/* — no partner fallback
  const attempts: [string, Record<string, string>][] = [["/ops/api/me", bearer(nora.token)], ["/ops/api/dashboard", bearer(nora.token)], ["/ops/api/partner-book/loans", bearer(nora.token)], ["/ops/api/me", { cookie: `sm_staff=${encodeURIComponent(nora.token)}` }], ["/ops/api/me", { cookie: `sm_partner_session=${encodeURIComponent(nora.token)}` }], ["/ops/api/me", { ...bearer(nora.token), "x-staff-role": "admin" }]];
  for (const [path, headers] of attempts) {
    const r = await api("GET", path, undefined, headers);
    assert.equal(r.status, 401, `${path} with ${Object.keys(headers).join("+")}: ${JSON.stringify(r.body)}`); assert.equal(r.body["code"], "AUTH_REQUIRED");
  }
  const act = await api("POST", "/ops/api/tools/36.1/partner.user.invite", { input: { partner_party_id: partnerA, email: `z.${R}@northlight.example`, roles: ["partner_ops"] } }, bearer(nora.token));
  assert.equal(act.status, 401, JSON.stringify(act.body));
  // the /ops page is the staff door: it sets no staff cookie and reads no partner session
  const page = await fetch(`${base}/ops`, { headers: bearer(nora.token) });
  assert.equal(page.status, 200); assert.match(page.headers.get("content-type") ?? "", /text\/html/); assert.equal(page.headers.get("set-cookie"), null); await page.text();
  // the machine and borrower prefixes resolve no partner session either (rule 7): /v1/partner-book/* and /v1/borrower/*
  const machine = await api("GET", "/v1/partner-book/imports", undefined, bearer(nora.token));
  assert.equal(machine.status, 401, JSON.stringify(machine.body));
  const borrowerMe = await api("GET", "/v1/borrower/me", undefined, bearer(nora.token));
  assert.equal(borrowerMe.status, 401, JSON.stringify(borrowerMe.body));
  // nothing of it opened a staff session; the staff surfaces logged their refusals on their own log; the partner session is untouched
  assert.equal(await count(`staff_sessions WHERE revoked_at IS NULL`), 1, "only the staff admin's own session from T7");
  assert.ok((await count(`staff_actions`)) > staffActionsBefore, "the staff surfaces log their refusals on staff_actions, never on partner_actions");
  assert.equal(await count(`partner_actions WHERE subject_kind = 'dashboard' OR subject_kind LIKE 'ops%'`), 0);
  assert.equal((await api("GET", "/v1/partner/me", undefined, bearer(nora.token))).status, 200, "the partner session survives its refusals elsewhere");
});
