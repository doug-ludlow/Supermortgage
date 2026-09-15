// 34.2 The account directory: every person, their activity and their record, masked by role
// spec/sections/34-operator-portal/34-2-the-account-directory-every-person-their-activity-and-their-record-masked-by-role.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness: own database `<base>_34_2` (dropped, created, migrated); the API server of src/runtime/server.ts in-process with
// the ops console mounted at /ops and /ops/api (createApiServer's default `console`) and a borrower router built here (the scripted
// model of src/domain/borrower/eval/scripted-client.ts behind the borrower turn, the fixture partner as the default partner); the
// FAKE rate feed, reviewers and analyst so 33.2's review and 33.3's readiness run on the sweep exactly as 33-2/33-3.spec.test.ts run
// them; the 34.1 doors for the staff (bootstrap → invite → code → password → sign-in, the FAKE code echoed as `fake_code`); a
// FixedClock the tests advance. The fixture: the 33.1 demo book posted to POST /v1/partner-book/imports with its supplement carrying
// loan 1's SSN last four and date of birth (the supplement columns the importer reads, src/domain/partner-book/import.ts), loan 1's
// homeowner (Maria Garcia) signed in through the code door and then the account door, and one homegrown account (Ines Ferreira —
// the front door: a password hash, a session token, an SSN typed into her thread and the FAKE identity vendor's payload on her rows)
// who is T1's homegrown account, T5's co-borrower and T6's fixture account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { AnthropicLlm } from "../../runtime/borrower/agent/llm.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { FakeRateFeed } from "../../infra/integrations/rates.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { bootstrapStaffAdmin } from "../../runtime/staff/auth.ts";
import { scriptedClient, type Scene } from "../borrower/eval/scripted-client.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, type DemoLoan } from "../partner-book/fixtures/partner-book-demo.ts";
import { ACTIVITY_KINDS } from "../../runtime/directory/activity.ts";
import { queryHash } from "../../runtime/directory/search.ts";
import { DIRECTORY_MODEL_VERSION, DIRECTORY_PROMPT_VERSION, DIRECTORY_RULE_SET_VERSION, UNMASK_MINUTES } from "../../runtime/directory/unmask.ts";
import { EXPORT_DOCUMENT_KIND } from "../../runtime/directory/export.ts";
import { EVIDENCE_SECTIONS } from "../../runtime/controls/evidence.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
type Json = Record<string, unknown>;
const MIN = 60_000;
/** The timeline (America/New_York is UTC−4 in September): the import and the invitations on 2026-09-14 08:00 ET; Maria's two sign-ins that afternoon; the homegrown account after them;
 * the sweep on 2026-09-15 07:20 ET (past 20.1's 06:30 run, 33.2's 07:00 review and 33.3's 07:15 readiness pass); the staff at 09:00 ET and on. */
const T_IMPORT = "2026-09-14T12:00:00.000Z";
const T_CODE = "2026-09-14T15:00:00.000Z";
const T_PASSWORD = "2026-09-14T16:00:00.000Z";
const T_HOMEGROWN = "2026-09-14T17:00:00.000Z";
const T_SWEEP = "2026-09-15T11:20:00.000Z";
const T_STAFF = "2026-09-15T13:00:00.000Z";
const T_TALK = "2026-09-15T13:20:00.000Z";
const T_EXPORT = "2026-09-15T13:30:00.000Z";
const T_CONTRACT = "2026-09-15T13:35:00.000Z";
const AS_OF_SWEEP = "2026-09-15";
const clock = new FixedClock(T_IMPORT);
const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- the scripted models: the borrower turn (33.1 rule 5 / 33.2 rule 7 scenes) and the refinance analyst (33.2 rule 4 / 33.3's clean rationales)
const MONITORED_FIRST_TURN: Scene = { when: /signed in for the first time to the account their servicer set up/, text: "Hi {{party.first_name}}, I'm Michelle, the automated assistant here. Your loan with {{partner_book.partner_name}} is on the record here and {{partner_book.partner_name}} keeps servicing it." };
const RETURNING: Scene = { when: /the borrower is back/, text: "Welcome back, {{party.first_name}}. Your loan with {{partner_book.partner_name}} is on the record here and nothing is needed from you now." };
const REFI_CANDIDATE_REPLY = "Yes, {{party.first_name}}, this morning's check says a refinance would put you ahead. The card here has the terms.";
const REFI_WATCHING_REPLY = "Not yet, {{party.first_name}}. Rates have not come down far enough for you. I look at your loan every morning and will say so the day they do.";
const REFI_OTHER_REPLY = "Not right now, {{party.first_name}}. I look at your loan every morning and will say so when that changes.";
const REFI_QUESTION: Scene = { when: /refinanc/i, text: (s) => { const review = (s.record?.["partner_book"] as Json | undefined)?.["review"] as Json | undefined; const verdict = String(review?.["verdict"] ?? "none"); return verdict === "candidate" ? REFI_CANDIDATE_REPLY : verdict === "watching" ? REFI_WATCHING_REPLY : REFI_OTHER_REPLY; } };
/** The homegrown account's turns (the account door's first turn, her typed question): a token-free line, no figure. */
const FALLBACK = "Thanks for writing. Tell me what brings you here today and I will point you to the next step.";
const scripted = scriptedClient([MONITORED_FIRST_TURN, RETURNING, REFI_QUESTION], { fallbackText: FALLBACK });
const CLEAN_RATIONALE = "Your rate today is {{facts.rate_now}} and this morning's sheet shows {{facts.candidate_rate}}, which lowers the payment by {{facts.monthly_delta}}. The offer is on the card here.";
const ANALYST_CANDIDATE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: CLEAN_RATIONALE, flags: [] } }], text: "Written." };
const ANALYST_WATCHING: Scene = { when: /verdict is watching/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "Rates are not below yours yet; the book is checked every morning.", flags: [] } }], text: "Written." };
const ANALYST_OTHER: Scene = { when: /verdict is (excluded|not_now)/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "The loan is out of today's review because of what is on the partner's file; nothing is offered.", flags: [] } }], text: "Written." };
const analystScripted = scriptedClient([ANALYST_CANDIDATE, ANALYST_WATCHING, ANALYST_OTHER]);

// ---------------------------------------------------------------- the people
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const L1 = loanN(1);
/** The supplement's identity columns for loan 1 (src/domain/partner-book/import.ts readSupplement: tin_last4, date_of_birth) — what T3's unmask shows. */
const MARIA_TIN4 = "6789"; const MARIA_DOB = "1986-04-12";
const MARIA_PASSWORD = `pw-maria-34-2-${R}`;
const INES = { name: "Ines Ferreira", email: `ines.ferreira.${R}@example.com`, password: `pw-ines-34-2-${R}`, ssn: "987-65-4321" };
const ADA = { email: `ada.admin.${R}@example.test`, name: "Ada Admin", password: `ada-correct-horse-${R}` };
const OLI = { email: `oli.analyst.${R}@example.test`, name: "Oli Analyst", password: `oli-analyst-pass-${R}`, roles: ["ops_analyst"] };
const CARA = { email: `cara.compliance.${R}@example.test`, name: "Cara Compliance", password: `cara-reviewer-pass-${R}`, roles: ["compliance"] };
const ORA = { email: `ora.officer.${R}@example.test`, name: "Ora Officer", password: `ora-officer-pass-${R}`, roles: ["officer"] };
type Person = { email: string; name: string; password: string };

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = "";
const logLines: string[] = [];

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|directory|staff|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: new FakeRateFeed(), reviewers: new FakeReviewers({ delaySeconds: 0 }), analystLlm: new AnthropicLlm({ client: analystScripted.client, model: "scripted" }) });
  // the partner's parties{servicer} row (ensurePartner finds it by legal name) doubles as the borrower surface's configured partner and the entry seed's demo partner
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, '{"phone": "+18005550199"}'::jsonb) RETURNING id::text AS id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id]))[0]!.id;
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId, llm: { client: scripted.client, model: "scripted" } });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

// ---------------------------------------------------------------- helpers over the API
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.34.2.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, "user-agent": "34.2-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const settle = async (): Promise<void> => { await router.flows!.settle(); await router.agent?.settle(); await router.flows!.settle(); };
const b64 = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type EventRow = { id: string; type: string; actor_kind: string; actor_id: string; actor_role: string | null; payload: Json; sequence: string; occurred_at: string; loan_id: string | null; application_id: string | null };
const events = async (type: string): Promise<EventRow[]> => db.query<EventRow>(`SELECT id::text AS id, type, actor_kind::text AS actor_kind, actor_id, actor_role, payload, sequence::text AS sequence, occurred_at::text AS occurred_at, loan_id::text AS loan_id, application_id::text AS application_id FROM loan_events WHERE type = $1 ORDER BY loan_events.sequence`, [type]);
type ActionRow = { id: string; staff_user_id: string | null; session_id: string | null; at: string; route: string; method: string; subject_kind: string | null; subject_id: string | null; command: string | null; result: string; refusal_code: string | null };
/** The staff_actions row of a request (34.1 rule 4 — written once the route answered, so the tests wait for it). */
async function actionRow(where: string, params: unknown[]): Promise<ActionRow> {
  for (let i = 0; i < 100; i++) { const r = await db.query<ActionRow>(`SELECT id::text AS id, staff_user_id::text AS staff_user_id, session_id::text AS session_id, at::text AS at, route, method, subject_kind, subject_id, command, result, refusal_code FROM staff_actions WHERE ${where} ORDER BY at DESC, id DESC LIMIT 1`, params); if (r.length) return r[0]!; await sleep(20); }
  assert.fail(`no staff_actions row for ${where} ${JSON.stringify(params)}`);
}
type DecisionRow = { id: string; agent: string; action: string; subject_kind: string | null; subject_id: string | null; rationale: string; approved_by: string | null; approved_role: string | null; rule_set_version: string; model_version: string | null; prompt_version: string | null; confidence: string | null; evidence_document_ids: string[] | null };
const decision = async (id: string): Promise<DecisionRow> => { const r = (await db.query<DecisionRow>(`SELECT id::text AS id, agent, action, subject_kind, subject_id, rationale, approved_by, approved_role, rule_set_version, model_version, prompt_version, confidence::text AS confidence, evidence_document_ids FROM agent_decisions WHERE id = $1`, [id]))[0]; assert.ok(r, `decision ${id}`); return r; };
const ui = (): PgBorrowerUiRepository => new PgBorrowerUiRepository(db);

// ───────── the staff (34.1's doors, as 34-1.spec.test.ts drives them)
type Staff = { token: string; session_id: string; staff_user_id: string; roles: string[] };
async function codeToken(email: string): Promise<string> {
  const c = await api("POST", "/ops/api/auth/code", { email });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body["delivery"], "FAKE"); assert.equal(typeof c.body["fake_code"], "string");
  const v = await api("POST", "/ops/api/auth/verify", { email, code: c.body["fake_code"] });
  assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(typeof v.body["token"], "string");
  return v.body["token"] as string;
}
async function enrol(p: Person): Promise<string> {
  const token = await codeToken(p.email);
  const r = await api("POST", "/ops/api/auth/password", { token, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["enrolled"], true);
  return r.body["staff_user_id"] as string;
}
/** A session: the code (possession) and the password (knowledge) — 34.1 rule 1's two factors; called afresh by each test (the portal's 30-minute idle rule and the clock the tests move). */
async function staffSignIn(p: Person): Promise<Staff> {
  await codeToken(p.email);
  const r = await api("POST", "/ops/api/auth/signin", { email: p.email, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body["token"] as string, session_id: r.body["session_id"] as string, staff_user_id: r.body["staff_user_id"] as string, roles: r.body["roles"] as string[] };
}
async function invite(adminToken: string, p: Person & { roles: string[] }): Promise<string> {
  const r = await api("POST", "/ops/api/staff/invite", { email: p.email, legal_name: p.name, roles: p.roles }, bearer(adminToken));
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["status"], "invited");
  return r.body["staff_user_id"] as string;
}
// ───────── the borrower doors (33.1's, as 33-1.spec.test.ts drives them)
async function signInByCode(email: string, ip: string): Promise<{ token: string; party_id: string; session: Json }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }, {}, ip);
  assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["delivery"], "FAKE"); assert.equal(typeof req.body["fake_code"], "string");
  const v = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, {}, ip);
  assert.equal(v.status, 200, JSON.stringify(v.body)); await settle();
  return { token: v.body["token"] as string, party_id: (v.body["party"] as Json)["party_id"] as string, session: v.body["session"] as Json };
}
/** The fixture's supplement with the identity columns the importer reads (tin_last4, date_of_birth) — loan 1 carries them, every other row leaves them blank. */
function supplementWithIdentity(): string {
  return book.supplement.split(/\r?\n/).map((line, i) => { if (!line.trim()) return line; if (i === 0) return `${line},tin_last4,date_of_birth`; return line.startsWith(`${L1.servicer_loan_number},`) ? `${line},${MARIA_TIN4},${MARIA_DOB}` : `${line},,`; }).join("\r\n");
}

// ---------------------------------------------------------------- the fixture, once per file
type Fixture = { import_id: string; loan1Id: string; mariaId: string; mariaTokens: string[]; mariaSessionIds: string[]; ines: { party_id: string; token: string; application_id: string; vendor_session_id: string; client_secret: string; message_id: string }; staff: { adaId: string; oliId: string; caraId: string; oraId: string } };
let fixture: Promise<Fixture> | undefined;
/** Built once per file; every test awaits the same attempt (a failure in the fixture reports its own cause under every test, never a second half-built one). */
function fixtureOnce(): Promise<Fixture> { return (fixture ??= buildFixture()); }
async function buildFixture(): Promise<Fixture> {
  // the staff (34.1): the bootstrap admin, then an analyst, a compliance user and an officer, each enrolled through the code + password door
  clock.set(T_IMPORT);
  const boot = await bootstrapStaffAdmin(runtime, ADA.email, { legal_name: ADA.name }); assert.equal(boot.created, true); const adaId = boot.staff_user_id!;
  assert.equal(await enrol(ADA), adaId);
  const admin = await staffSignIn(ADA);
  const oliId = await invite(admin.token, OLI); const caraId = await invite(admin.token, CARA); const oraId = await invite(admin.token, ORA);
  assert.equal(await enrol(OLI), oliId); assert.equal(await enrol(CARA), caraId); assert.equal(await enrol(ORA), oraId);
  // the FAKE sheet / program / LLPA matrix / cost schedule the review prices with (33.2's harness), then the fixture book posted as the operator posts it (33.1), the supplement carrying loan 1's SSN last four and date of birth
  const seed = await seedEntryDemo(runtime, { partner_id: partnerPartyId, nmlsr_id: DEMO_PARTNER.nmlsr_id }); assert.equal(seed.partner_id, partnerPartyId);
  const imp = await api("POST", "/v1/partner-book/imports", { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content_base64: b64(book.tape) }, supplement: { filename: "partner-book-demo-supplement.csv", content_base64: b64(supplementWithIdentity()) } }, { ...bearer(TOKEN), "x-actor-id": "u-ops-analyst" });
  assert.equal(imp.status, 200, JSON.stringify(imp.body).slice(0, 800)); assert.equal(imp.body["status"], "loaded"); assert.equal(imp.body["rows_loaded"], 12); assert.equal(imp.body["partner_party_id"], partnerPartyId);
  await settle();
  const loan1 = (await db.query<{ id: string }>(`SELECT id::text AS id FROM loans WHERE partner_party_id = $1 AND servicer_loan_number = $2`, [partnerPartyId, L1.servicer_loan_number]))[0]; assert.ok(loan1, "loan 1 on the book");
  const maria = (await db.query<{ party_id: string; tin_last4: string | null; date_of_birth: string | null }>(`SELECT b.party_id::text AS party_id, b.tin_last4, b.date_of_birth::text AS date_of_birth FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC LIMIT 1`, [loan1.id]))[0];
  assert.ok(maria?.party_id, "loan 1's party"); assert.equal(maria.tin_last4, MARIA_TIN4, "the supplement's SSN last four on the borrowers row"); assert.equal(maria.date_of_birth, MARIA_DOB);
  // Maria signs in twice: the code door (33.1 rule 6: the activation, the first turn), then the account door — the password set on the e-mail on file and the code proving possession opens the password session (32.16 DELTA-29)
  clock.set(T_CODE);
  const s1 = await signInByCode(L1.email!, "10.34.2.11"); assert.equal(s1.party_id, maria.party_id); assert.equal(s1.session["auth_method"], "otp_email"); assert.equal(s1.session["level"], "L1");
  clock.set(T_PASSWORD);
  const create = await api("POST", "/v1/borrower/auth/account", { action: "create", email: L1.email, password: MARIA_PASSWORD }, {}, "10.34.2.12");
  assert.equal(create.status, 200, JSON.stringify(create.body)); assert.equal(typeof create.body["fake_code"], "string", "the e-mail is on file: a code proves possession first");
  const s2 = await api("POST", "/v1/borrower/auth/account", { action: "verify_email", challenge_id: create.body["challenge_id"], code: create.body["fake_code"] }, {}, "10.34.2.12");
  assert.equal(s2.status, 200, JSON.stringify(s2.body)); assert.equal((s2.body["party"] as Json)["party_id"], maria.party_id, "the password session opens on the same party"); assert.equal((s2.body["session"] as Json)["auth_method"], "password");
  await settle();
  // the homegrown account (the front door: an e-mail on file for no one opens the session at once — a credential row, a session, the organic application and the first turn), an SSN typed into her thread, the FAKE identity vendor on her application
  clock.set(T_HOMEGROWN);
  const ines = await api("POST", "/v1/borrower/auth/account", { action: "create", email: INES.email, password: INES.password }, {}, "10.34.2.21");
  assert.equal(ines.status, 200, JSON.stringify(ines.body)); assert.equal(typeof ines.body["token"], "string", "a session, not a code"); const inesId = (ines.body["party"] as Json)["party_id"] as string; const inesToken = ines.body["token"] as string;
  await settle();
  await db.query(`UPDATE parties SET legal_name = $2 WHERE id = $1`, [inesId, INES.name]);
  const typed = await api("POST", "/v1/borrower/messages", { text: `My social is ${INES.ssn} — is that what you need from me?` }, bearer(inesToken), "10.34.2.21");
  assert.equal(typed.status, 200, JSON.stringify(typed.body).slice(0, 600)); await settle();
  const inesMessage = (await db.query<{ message_id: string }>(`SELECT m.message_id::text AS message_id FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE c.party_id = $1 AND m.sender = 'borrower' ORDER BY m.at DESC LIMIT 1`, [inesId]))[0]; assert.ok(inesMessage, "the typed message on her thread");
  const inesApp = (await db.query<{ application_id: string }>(`SELECT application_id::text AS application_id FROM application_borrowers WHERE party_id = $1 ORDER BY created_at LIMIT 1`, [inesId]))[0]; assert.ok(inesApp, "the organic application of the front door");
  const identity = await api("POST", "/v1/borrower/identity/stripe/session", { application_id: inesApp.application_id, fake_complete: true }, bearer(inesToken), "10.34.2.21");
  assert.equal(identity.status, 200, JSON.stringify(identity.body).slice(0, 600)); assert.equal(identity.body["delivery"], "FAKE"); assert.equal(identity.body["status"], "verified"); assert.equal(typeof identity.body["vendor_session_id"], "string"); assert.equal(typeof identity.body["client_secret"], "string");
  await settle();
  // the morning after: the day's passes — 20.1's run, 33.2's review with the scripted analyst, the offer delivered, 33.3's readiness; the FAKE MLO's terms review on the second sweep puts loan 1's OfferCard on the rail
  clock.set(T_SWEEP);
  const sweep = await runtime.sweep(); await settle();
  assert.ok(sweep.partner_book_review.ran, `the review ran: ${sweep.partner_book_review.reason}`); assert.equal(sweep.partner_book_review.as_of_date, AS_OF_SWEEP);
  assert.ok(sweep.partner_book_readiness.ran, `the readiness pass ran: ${sweep.partner_book_readiness.skipped}`);
  await runtime.sweep(); await settle();
  clock.set(T_STAFF);
  const mariaSessions = await db.query<{ session_id: string }>(`SELECT session_id::text AS session_id FROM sessions WHERE party_id = $1 ORDER BY created_at`, [maria.party_id]);
  return { import_id: imp.body["import_id"] as string, loan1Id: loan1.id, mariaId: maria.party_id, mariaTokens: [s1.token, s2.body["token"] as string], mariaSessionIds: mariaSessions.map((s) => s.session_id),
    ines: { party_id: inesId, token: inesToken, application_id: inesApp.application_id, vendor_session_id: identity.body["vendor_session_id"] as string, client_secret: identity.body["client_secret"] as string, message_id: inesMessage.message_id }, staff: { adaId, oliId, caraId, oraId } };
}

// ---------------------------------------------------------------- the contract (T6's shape, applied to every response the tests read): no full SSN, no credential hash, no session token, no vendor payload
const FULL_SSN = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/;
/** The keys a secret rides under on the rows: a token, a hash, the encrypted TIN, the tape's raw cells, a vendor blob (the identity ConnectCard's `props` / its transition's `evidence` / the ui_events payload all key it `vendor_session_id`; the vendor's `client_secret`) — none may reach a response. */
const FORBIDDEN_KEYS = new Set(["token", "token_hash", "password_hash", "context_hash", "args_hash", "secret_hash", "tin_encrypted", "raw", "vendor_payload", "vendor_response", "vendor_session_id", "client_secret", "email_encrypted", "public_key_jwk", "credential_id"]);
/** The vendor's own result fields (src/runtime/borrower/vendors/fake-stripe-identity.ts session_result / extraction): a vendor payload copied anywhere would carry them. */
const VENDOR_RESULT_MARKERS = ["face_match_score", "face_match_threshold", "document_authentication_result", "liveness_result", "data_match", "1 Fixture Way"];
function assertNoSecrets(value: unknown, secrets: readonly string[], where: string, path = "$"): void {
  if (typeof value === "string") { assert.ok(!FULL_SSN.test(value), `${where} ${path} carries a full SSN: ${value}`); for (const s of secrets) assert.ok(!value.includes(s), `${where} ${path} carries a secret (${s.slice(0, 8)}…)`); assert.ok(!value.startsWith("scrypt$"), `${where} ${path} carries a credential hash`); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoSecrets(v, secrets, where, `${path}[${i}]`)); return; }
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value as Json)) { assert.ok(!FORBIDDEN_KEYS.has(k), `${where} ${path}.${k} is a forbidden key`); assertNoSecrets(v, secrets, where, `${path}.${k}`); }
}
/** Every hash and token the fixture rows carry (read from the rows themselves) plus the SSN typed into the thread, the vendor's secret and the vendor's result fields (the vendor's session id is the record's own reference — 22.6 writes it on identity.verified — and not the payload). */
async function secretsOf(partyIds: readonly string[], f: Fixture): Promise<string[]> {
  const out = new Set<string>([INES.ssn, INES.ssn.replace(/-/g, ""), f.ines.client_secret, ...VENDOR_RESULT_MARKERS, ...f.mariaTokens, f.ines.token]);
  for (const r of await db.query<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE party_id = ANY($1::uuid[])`, [partyIds])) out.add(r.token_hash);
  for (const r of await db.query<{ password_hash: string }>(`SELECT password_hash FROM party_credentials WHERE party_id = ANY($1::uuid[])`, [partyIds])) out.add(r.password_hash);
  for (const r of await db.query<{ context_hash: string | null; tool_calls: unknown }>(`SELECT context_hash, tool_calls FROM agent_turns WHERE party_id = ANY($1::uuid[])`, [partyIds])) { if (r.context_hash) out.add(r.context_hash); for (const c of Array.isArray(r.tool_calls) ? (r.tool_calls as Json[]) : []) if (typeof c["args_hash"] === "string" && c["args_hash"]) out.add(c["args_hash"]); }
  return [...out].filter((s) => s.length >= 8);
}

test("34.2-T1: Given the fixture book imported and one homegrown account, when an `ops_analyst` searches by the last four of loan 1's servicer loan number, by \"Garcia\", by the first six characters of the e-mail and by the phone's last four digits, then each search lists Maria Garcia once with masked contact, `directory.searched` is logged with a query hash and no query text, and a two-character query is refused.", { skip }, async () => {
  const f = await fixtureOnce();
  // the fixture book (12 monitored loans, Maria on loan 1) and one homegrown account (Ines, through the front door — a parties{borrower} row on no partner's loan)
  assert.equal(await count(`loans WHERE partner_party_id = $1 AND status = 'monitored'`, [partnerPartyId]), 12);
  assert.equal(await count(`parties WHERE id = $1 AND party_type = 'borrower'`, [f.ines.party_id]), 1); assert.equal(await count(`borrowers WHERE party_id = $1`, [f.ines.party_id]), 0, "the homegrown account holds no partner's loan");
  const analyst = await staffSignIn(OLI); assert.deepEqual(analyst.roles, ["ops_analyst"]);
  const queries = [L1.servicer_loan_number.slice(-4), "Garcia", L1.email!.slice(0, 6), L1.phone!.slice(-4)];
  assert.deepEqual(queries, ["0001", "Garcia", "maria.", "0101"]);
  for (const q of queries) {
    const r = await api("GET", `/ops/api/directory/search?q=${encodeURIComponent(q)}`, undefined, bearer(analyst.token));
    assert.equal(r.status, 200, `${q}: ${JSON.stringify(r.body)}`);
    const results = r.body["results"] as Json[];
    const maria = results.filter((x) => x["legal_name"] === L1.name);
    assert.equal(maria.length, 1, `${q} lists Maria Garcia once (${results.map((x) => x["legal_name"]).join(", ")})`);
    assert.equal(maria[0]!["party_id"], f.mariaId); assert.equal(maria[0]!["origin"], "partner_book"); assert.equal(maria[0]!["partner_name"], DEMO_PARTNER.legal_name);
    // masked contact: `m…@example.com` and `···0101`; no result carries the address or the number in clear
    assert.equal(maria[0]!["email"], "m…@example.com"); assert.equal(maria[0]!["phone"], "···0101");
    assert.ok((maria[0]!["subjects"] as Json[]).some((s) => s["loan_id"] === f.loan1Id && s["loan_last4"] === "····0001"), "the monitored loan by its last four");
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes(L1.email!) && !text.includes("maria.garcia") && !text.includes(L1.phone!) && !text.includes("6025550101") && !text.includes("555-0101"), `${q}: no e-mail or phone in clear`);
    for (const hit of results) { assert.ok(!String(hit["email"] ?? "").includes("@") || String(hit["email"]).startsWith(String(hit["email"])[0] + "…"), "every e-mail masked"); assert.match(String(hit["phone"] ?? "···"), /^···\d{0,4}$/); }
    // directory.searched{staff_user_id, query_hash, results}: the hash, never the text
    assert.equal(r.body["query_hash"], queryHash(q));
    const logged = (await events("directory.searched")).filter((e) => e.payload["query_hash"] === queryHash(q));
    assert.equal(logged.length, 1, `one directory.searched for ${q}`);
    const ev = logged[0]!; assert.equal(ev.actor_kind, "human"); assert.equal(ev.actor_id, analyst.staff_user_id); assert.equal(ev.actor_role, "ops_analyst");
    assert.equal(ev.payload["staff_user_id"], analyst.staff_user_id); assert.equal(ev.payload["results"], r.body["count"]); assert.equal(ev.payload["session_id"], analyst.session_id);
    assert.match(String(ev.payload["query_hash"]), /^[0-9a-f]{64}$/); assert.ok(!("q" in ev.payload) && !("query" in ev.payload) && !("text" in ev.payload), "no query field");
    const { query_hash: _hash, ...rest } = ev.payload; assert.ok(!JSON.stringify(rest).toLowerCase().includes(q.toLowerCase()), `no query text on the event: ${JSON.stringify(rest)}`);
    assert.ok(!JSON.stringify(ev.payload).includes("Garcia") && !JSON.stringify(ev.payload).includes("@"), "no name, no address on the event");
    // 34.1 rule 4: the action log's route carries the same hash and no query text
    const row = await actionRow(`staff_user_id = $1 AND command = 'directory.search' AND route = $2`, [analyst.staff_user_id, `/ops/api/directory/search?q=${queryHash(q)}`]);
    assert.equal(row.result, "ok"); assert.equal(row.method, "GET"); assert.equal(row.subject_kind, "search"); assert.equal(row.subject_id, queryHash(q)); assert.equal(row.session_id, analyst.session_id);
    assert.ok(!row.route.includes(q) || q.length >= 4 && row.route.slice(row.route.indexOf("q=") + 2) === queryHash(q), "the route is the hash");
  }
  // a two-character query is refused before any read: 400 QUERY_TOO_SHORT, nothing logged as searched, the action row refused with the code
  const short = await api("GET", `/ops/api/directory/search?q=${encodeURIComponent("Ga")}`, undefined, bearer(analyst.token));
  assert.equal(short.status, 400, JSON.stringify(short.body)); assert.equal(short.body["code"], "QUERY_TOO_SHORT");
  assert.equal((await events("directory.searched")).filter((e) => e.payload["query_hash"] === queryHash("Ga")).length, 0, "a refused query logs no directory.searched");
  const refused = await actionRow(`staff_user_id = $1 AND route = $2`, [analyst.staff_user_id, `/ops/api/directory/search?q=${queryHash("Ga")}`]);
  assert.equal(refused.result, "refused"); assert.equal(refused.refusal_code, "QUERY_TOO_SHORT"); assert.equal(refused.command, "directory.search");
  assert.equal(await count(`staff_actions WHERE route LIKE '%q=Ga%' OR route LIKE '%Garcia%' OR route LIKE '%maria.%'`), 0, "no query text on any action row");
  // the homegrown account is in the same directory (rule 1): searched by her name, listed once with origin front door
  const ines = await api("GET", `/ops/api/directory/search?q=${encodeURIComponent("Ferreira")}`, undefined, bearer(analyst.token));
  assert.equal(ines.status, 200); const hits = (ines.body["results"] as Json[]).filter((x) => x["party_id"] === f.ines.party_id); assert.equal(hits.length, 1); assert.equal(hits[0]!["origin"], "front_door"); assert.equal(hits[0]!["email"], "i…@example.com");
});

test("34.2-T2: Given loan 1's homeowner signed in twice (code, then password), when the analyst opens the account, then the page shows origin `partner book`, both sessions with doors and levels and no token, the monitored loan as the subject with the partner's latest facts as of their date, the latest review verdict and the readiness summary, e-mail and phone masked, and no SSN or date of birth.", { skip }, async () => {
  const f = await fixtureOnce();
  const analyst = await staffSignIn(OLI);
  const r = await api("GET", `/ops/api/directory/accounts/${f.mariaId}`, undefined, bearer(analyst.token));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 800));
  const a = r.body;
  assert.equal(a["party_id"], f.mariaId); assert.equal(a["legal_name"], L1.name);
  // the origin: the partner book, named
  assert.equal(a["origin"], `partner book: ${DEMO_PARTNER.legal_name}`); assert.equal(a["origin_kind"], "partner_book"); assert.deepEqual(a["partner"], { partner_party_id: partnerPartyId, partner_name: DEMO_PARTNER.legal_name });
  assert.ok((a["doors"] as string[]).includes(`partner book: ${DEMO_PARTNER.legal_name}`)); assert.equal(a["status"], "active");
  // both sessions with doors and levels — the code door, then the password — and never a token
  const sessions = a["sessions"] as Json[];
  assert.equal(sessions.length, 2, "signed in twice");
  assert.deepEqual(sessions.map((s) => [s["auth_method"], s["door"], s["level"]]), [["otp_email", "one-time code (e-mail)", "L1"], ["password", "password", "L1"]]);
  assert.deepEqual(sessions.map((s) => s["session_id"]), f.mariaSessionIds);
  assert.equal(a["first_session_at"], sessions[0]!["created_at"]); assert.equal(String(sessions[0]!["created_at"]).slice(0, 19), T_CODE.slice(0, 19)); assert.equal(String(sessions[1]!["created_at"]).slice(0, 19), T_PASSWORD.slice(0, 19));
  for (const s of sessions) for (const k of Object.keys(s)) assert.ok(!/token|hash|secret/i.test(k), `session field ${k}`);
  const hashes = (await db.query<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE party_id = $1`, [f.mariaId])).map((x) => x.token_hash); assert.equal(hashes.length, 2);
  const text = JSON.stringify(a);
  for (const secret of [...hashes, ...f.mariaTokens]) assert.ok(!text.includes(secret), "no session token or token hash on the page");
  assert.deepEqual(a["credential_kinds"], ["password"]);
  // the monitored loan as the subject, with the partner's latest facts as of their date (labelled as the partner's — edge case 5)
  const subjects = a["subjects"] as Json[];
  assert.equal(subjects.length, 1, "the monitored loan is the subject"); const loan = subjects[0]!;
  assert.equal(loan["loan_id"], f.loan1Id); assert.equal(loan["application_id"], null); assert.equal(loan["monitored"], true); assert.equal(loan["loan_status"], "monitored"); assert.equal(loan["stage"], "servicing"); assert.equal(loan["loan_last4"], "····0001"); assert.equal(loan["status_badge"], "Monitored");
  const partner = loan["partner"] as Json; assert.equal(partner["label"], "the partner's facts"); assert.equal(partner["partner_party_id"], partnerPartyId); assert.equal(partner["partner_name"], DEMO_PARTNER.legal_name);
  const latestFacts = (await db.query<{ as_of_date: string }>(`SELECT as_of_date::text AS as_of_date FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [f.loan1Id]))[0]!;
  assert.equal(partner["as_of_date"], latestFacts.as_of_date); assert.equal(partner["as_of_date"], DEMO_AS_OF);
  const facts = partner["facts"] as Json;
  assert.equal(facts["upb_cents"], "44136613"); assert.equal(facts["note_rate_pct"], "7.250"); assert.equal(facts["pi_cents"], "306979"); assert.equal(facts["ti_cents"], "61250"); assert.equal(facts["next_due_date"], "2026-10-01"); assert.equal(facts["last_payment_date"], "2026-09-01"); assert.equal(facts["servicing_status"], "Active"); assert.equal(facts["property_city"], "Phoenix"); assert.equal(facts["property_state"], "AZ");
  assert.ok(!("borrower_name" in facts) && !("raw" in partner), "the summary keys only, never the tape's raw cells");
  // the latest review verdict (33.2's review of the morning — the engine's verdict for loan 1 is `candidate`, 33.2-T2) and the readiness summary (33.3's row of the morning)
  const review = (await db.query<{ verdict: string; as_of_date: string }>(`SELECT verdict, as_of_date::text AS as_of_date FROM partner_book_reviews WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [f.loan1Id]))[0]!;
  assert.equal(review.verdict, "candidate"); assert.equal(review.as_of_date, AS_OF_SWEEP);
  const shown = loan["review"] as Json; assert.ok(shown, "the review on the subject");
  assert.equal(shown["outcome"], review.verdict); assert.equal(shown["as_of_date"], review.as_of_date); assert.ok(!("watch_rate_pct" in shown)); assert.ok(Array.isArray(shown["reasons_copy_keys"]));
  const readiness = (await db.query<{ id: string; ready: boolean; missing: string[]; as_of_date: string; application_id: string | null }>(`SELECT id::text AS id, ready, missing, as_of_date::text AS as_of_date, application_id::text AS application_id FROM readiness_checks WHERE loan_id = $1 ORDER BY created_at DESC LIMIT 1`, [f.loan1Id]))[0]!;
  assert.equal(readiness.as_of_date, AS_OF_SWEEP); assert.equal(readiness.ready, false); assert.equal(readiness.application_id, null);
  const rd = loan["readiness"] as Json; assert.ok(rd, "the readiness summary on the subject");
  assert.equal(rd["ready"], readiness.ready); assert.deepEqual(rd["missing"], readiness.missing); assert.equal(rd["as_of_date"], readiness.as_of_date); assert.equal(rd["readiness_check_id"], readiness.id); assert.equal(rd["loan_id"], f.loan1Id);
  // the engine's own list (the supplement carries loan 1's SSN last four, so `ssn` is present — 33.3 rule 1 reads borrowers.tin_last4; 33.3-T1's fixture without it lists ssn missing)
  assert.deepEqual(readiness.missing, ["identity", "income", "assets", "esign", "credit_authorization", "credit"]);
  // e-mail and phone masked; no SSN or date of birth
  const contact = a["contact"] as Json; assert.equal(contact["email"], "m…@example.com"); assert.equal(contact["phone"], "···0101"); assert.equal(contact["unmasked"], false); assert.deepEqual(contact["emails"], ["m…@example.com"]); assert.deepEqual(contact["phones"], ["···0101"]); assert.equal(contact["city"], null);
  assert.ok(!text.includes(L1.email!) && !text.includes("maria.garcia") && !text.includes(L1.phone!) && !text.includes("6025550101"), "no address or number in clear");
  const identity = a["identity"] as Json; assert.equal(identity["ssn_last4"], null); assert.equal(identity["date_of_birth"], null); assert.equal(identity["unmasked"], false); assert.equal(identity["on_file"], true, "the supplement's identity is on file — and not shown");
  assert.ok(!text.includes(MARIA_DOB) && !text.includes(`"${MARIA_TIN4}"`), "no SSN last four, no date of birth anywhere on the page");
  const walk = (v: unknown, path: string): void => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Json)) { if (/ssn|tin|birth|dob/i.test(k) && !/last4$/.test(k) && !["on_file"].includes(k)) assert.equal(x, null, `${path}.${k} carries a value`); if (/ssn_last4|tin_last4/.test(k)) assert.equal(x, null, `${path}.${k}`); walk(x, `${path}.${k}`); } };
  walk(a, "$");
  assert.deepEqual(a["mask"], { contact: false, identity: false }); assert.deepEqual(a["roles"], ["ops_analyst"]);
  assert.ok((a["invitations"] as Json[]).length >= 1, "the invitation of 33.1"); assert.equal((a["invitations"] as Json[])[0]!["kind"], "invitation");
  // the look is logged: directory.viewed{staff_user_id, party_id, section: account} and 34.1's action row
  const viewed = (await events("directory.viewed")).filter((e) => e.payload["party_id"] === f.mariaId && e.payload["section"] === "account" && e.payload["staff_user_id"] === analyst.staff_user_id);
  assert.ok(viewed.length >= 1); assert.equal(viewed.at(-1)!.id, a["event_id"]); assert.deepEqual(viewed.at(-1)!.payload["unmasked"], []);
  const row = await actionRow(`staff_user_id = $1 AND command = 'directory.account' AND subject_id = $2`, [analyst.staff_user_id, f.mariaId]);
  assert.equal(row.result, "ok"); assert.equal(row.subject_kind, "party"); assert.equal(row.route, `/ops/api/directory/accounts/${f.mariaId}`);
});

test("34.2-T3: Given the same account, when `compliance` unmasks contact and identity with a reason, then the full e-mail and phone and the supplement's SSN last four and date of birth are shown for 15 minutes, `directory.unmasked{fields, reason}` is logged with a decision record, and after 15 minutes the fields are masked again; given an `ops_analyst`, then `ROLE_REQUIRED{compliance}`.", { skip }, async () => {
  const f = await fixtureOnce();
  clock.set(T_STAFF);
  const compliance = await staffSignIn(CARA); const analyst = await staffSignIn(OLI);
  const account = async (s: Staff): Promise<Json> => { const r = await api("GET", `/ops/api/directory/accounts/${f.mariaId}`, undefined, bearer(s.token)); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400)); return r.body; };
  // before the unmask: compliance reads the masked view too
  const before = await account(compliance);
  assert.equal((before["contact"] as Json)["email"], "m…@example.com"); assert.equal((before["identity"] as Json)["ssn_last4"], null); assert.deepEqual(before["mask"], { contact: false, identity: false });
  // the unmask with a reason
  const reason = "case 4411: the homeowner asked what the partner has on file";
  const u = await api("POST", `/ops/api/directory/accounts/${f.mariaId}/unmask`, { fields: ["contact", "identity"], reason }, bearer(compliance.token));
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.deepEqual(u.body["fields"], ["contact", "identity"]); assert.equal(u.body["party_id"], f.mariaId); assert.equal(u.body["granted_at"], T_STAFF); assert.equal(u.body["expires_at"], new Date(Date.parse(T_STAFF) + UNMASK_MINUTES * MIN).toISOString()); assert.equal(UNMASK_MINUTES, 15);
  // shown: the full e-mail and phone, the supplement's SSN last four and date of birth
  const shown = await account(compliance);
  const contact = shown["contact"] as Json; assert.equal(contact["email"], L1.email); assert.equal(contact["phone"], L1.phone); assert.equal(contact["unmasked"], true);
  const identity = shown["identity"] as Json; assert.equal(identity["ssn_last4"], MARIA_TIN4); assert.equal(identity["date_of_birth"], MARIA_DOB); assert.equal(identity["source"], "partner supplement"); assert.equal(identity["unmasked"], true);
  assert.deepEqual(shown["mask"], { contact: true, identity: true });
  assert.ok(!FULL_SSN.test(JSON.stringify(shown)), "never a full SSN");
  // the row: directory_unmasks for compliance's session, expires_at = granted_at + 15 minutes
  const row = (await db.query<{ staff_user_id: string; session_id: string; party_id: string; fields: string[]; reason: string; granted_at: string; expires_at: string }>(`SELECT staff_user_id::text AS staff_user_id, session_id::text AS session_id, party_id::text AS party_id, fields, reason, granted_at::text AS granted_at, expires_at::text AS expires_at FROM directory_unmasks WHERE id = $1`, [u.body["unmask_id"] as string]))[0]!;
  assert.equal(row.staff_user_id, compliance.staff_user_id); assert.equal(row.session_id, compliance.session_id); assert.equal(row.party_id, f.mariaId); assert.deepEqual(row.fields, ["contact", "identity"]); assert.equal(row.reason, reason);
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.granted_at), 15 * MIN);
  // directory.unmasked{staff_user_id, party_id, fields, reason} by the compliance user
  const ev = (await events("directory.unmasked")).find((e) => e.id === u.body["event_id"]); assert.ok(ev, "the event");
  assert.deepEqual([ev.actor_kind, ev.actor_id, ev.actor_role], ["human", compliance.staff_user_id, "compliance"]);
  assert.deepEqual(ev.payload["fields"], ["contact", "identity"]); assert.equal(ev.payload["reason"], reason); assert.equal(ev.payload["staff_user_id"], compliance.staff_user_id); assert.equal(ev.payload["party_id"], f.mariaId); assert.equal(ev.payload["unmask_id"], u.body["unmask_id"]);
  assert.ok(!JSON.stringify(ev.payload).includes("@") && !JSON.stringify(ev.payload).includes(MARIA_TIN4) && !JSON.stringify(ev.payload).includes(MARIA_DOB), "no destination, no identity on the event");
  // the decision record: {party_id, action, fields, reason, by, rule_set_version: directory.mask.v1, model_version: deterministic, prompt_version: 34.2-v1, confidence: 1}
  const d = await decision(u.body["decision_id"] as string);
  assert.deepEqual([d.agent, d.action, d.subject_kind, d.subject_id, d.rationale, d.approved_by, d.approved_role], ["security-records", "directory.unmask", "party", f.mariaId, reason, compliance.staff_user_id, "compliance"]);
  assert.deepEqual([d.rule_set_version, d.model_version, d.prompt_version, Number(d.confidence)], [DIRECTORY_RULE_SET_VERSION, DIRECTORY_MODEL_VERSION, DIRECTORY_PROMPT_VERSION, 1]);
  assert.deepEqual([DIRECTORY_RULE_SET_VERSION, DIRECTORY_MODEL_VERSION, DIRECTORY_PROMPT_VERSION], ["directory.mask.v1", "deterministic", "34.2-v1"]);
  const action = await actionRow(`staff_user_id = $1 AND command = 'directory.unmask'`, [compliance.staff_user_id]); assert.equal(action.result, "ok"); assert.equal(action.subject_id, f.mariaId);
  // the analyst's own view stays masked while compliance's unmask is open (the unmask is compliance's session's)
  const analystView = await account(analyst);
  assert.equal((analystView["contact"] as Json)["email"], "m…@example.com"); assert.equal((analystView["identity"] as Json)["ssn_last4"], null); assert.equal((analystView["identity"] as Json)["date_of_birth"], null);
  // still open one second before the fifteenth minute; masked again after 15 minutes (edge case 4: re-masked on the next request)
  clock.set(new Date(Date.parse(T_STAFF) + 15 * MIN - 1000).toISOString());
  assert.equal(((await account(compliance))["contact"] as Json)["email"], L1.email, "open until the fifteenth minute");
  clock.set(new Date(Date.parse(T_STAFF) + 15 * MIN + 1000).toISOString());
  const after = await account(compliance);
  assert.equal((after["contact"] as Json)["email"], "m…@example.com"); assert.equal((after["contact"] as Json)["phone"], "···0101"); assert.equal((after["contact"] as Json)["unmasked"], false);
  assert.equal((after["identity"] as Json)["ssn_last4"], null); assert.equal((after["identity"] as Json)["date_of_birth"], null); assert.deepEqual(after["mask"], { contact: false, identity: false });
  assert.ok(!JSON.stringify(after).includes(L1.email!) && !JSON.stringify(after).includes(MARIA_DOB), "masked again");
  // an ops_analyst may not unmask: 403 ROLE_REQUIRED{compliance}, before any read — no row, no event
  const unmasks = await count(`directory_unmasks`); const unmasked = (await events("directory.unmasked")).length;
  const denied = await api("POST", `/ops/api/directory/accounts/${f.mariaId}/unmask`, { fields: ["contact", "identity"], reason: "curious" }, bearer(analyst.token));
  assert.equal(denied.status, 403, JSON.stringify(denied.body)); assert.equal(denied.body["code"], "ROLE_REQUIRED"); assert.equal(denied.body["role"], "compliance");
  assert.equal(await count(`directory_unmasks`), unmasks, "nothing granted"); assert.equal((await events("directory.unmasked")).length, unmasked, "nothing logged as unmasked");
  const deniedRow = await actionRow(`staff_user_id = $1 AND route = $2 AND method = 'POST'`, [analyst.staff_user_id, `/ops/api/directory/accounts/${f.mariaId}/unmask`]);
  assert.equal(deniedRow.result, "refused"); assert.equal(deniedRow.refusal_code, "ROLE_REQUIRED");
});

test("34.2-T4: Given the homeowner's thread with a first turn, a question and a resolved card, when the analyst reads the activity stream, then it lists in time order the invitation notice, the activation event, the sessions, the assistant's turns (model and prompt versions, guard result), the borrower's messages with tokens resolved as displayed, the card and its resolution, the daily review decision, and the analyst's own look, each with its kind and actor; filtering by kind `turn` leaves the turns only.", { skip }, async () => {
  const f = await fixtureOnce();
  // the homeowner is back: a code sign-in (the returning turn), her question (the scripted model answers from the situation's review — 33.2 rule 7), the Yes on the OfferCard (33.3-T2: the card resolved by the borrower, the refinance opened)
  clock.set(T_TALK);
  const s3 = await signInByCode(L1.email!, "10.34.2.13"); assert.equal(s3.party_id, f.mariaId);
  const question = "Does refinancing make sense for me right now?";
  const m = await api("POST", "/v1/borrower/messages", { text: question }, bearer(s3.token), "10.34.2.13");
  assert.equal(m.status, 200, JSON.stringify(m.body).slice(0, 600)); await settle();
  const reply = m.body["reply"] as Json; assert.equal(reply["sender"], "agent"); assert.ok(String(reply["body_text"]).includes("Maria"), `the reply greets by name: ${reply["body_text"]}`);
  clock.set(new Date(Date.parse(T_TALK) + 2 * MIN).toISOString());
  const offer = (await ui().cardsOf(f.mariaId)).find((c) => c.kind === "OfferCard" && c.status === "pending" && c.subject_loan_id === f.loan1Id); assert.ok(offer, "loan 1's OfferCard on the rail (33.2's delivery, the FAKE MLO's approval)");
  const yes = await api("POST", `/v1/borrower/cards/${offer.card_instance_id}/resolve`, { option_id: "yes", evidence: { option_id: "yes", tapped_at: clock.now() } }, bearer(s3.token), "10.34.2.13");
  assert.equal(yes.status, 201, JSON.stringify(yes.body).slice(0, 600)); await settle();
  assert.equal((await ui().cardsOf(f.mariaId)).find((c) => c.card_instance_id === offer.card_instance_id)!.status, "resolved");
  // the analyst reads the stream
  clock.set(new Date(Date.parse(T_TALK) + 5 * MIN).toISOString());
  const analyst = await staffSignIn(OLI);
  const looksBefore = await db.query<{ id: string }>(`SELECT id::text AS id FROM staff_actions WHERE staff_user_id = $1 AND command = 'directory.account' AND subject_id = $2 AND result = 'ok'`, [f.staff.oliId, f.mariaId]);
  assert.ok(looksBefore.length >= 1, "the analyst's own looks of T2/T3 are on 34.1's log");
  const r = await api("GET", `/ops/api/directory/accounts/${f.mariaId}/activity`, undefined, bearer(analyst.token));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600));
  const rows = r.body["rows"] as Json[]; assert.equal(r.body["count"], rows.length); assert.deepEqual(r.body["kinds"], [...ACTIVITY_KINDS]); assert.equal(r.body["party_id"], f.mariaId);
  // time order; every row a kind and an actor
  for (let i = 1; i < rows.length; i++) assert.ok(String(rows[i - 1]!["at"]) <= String(rows[i]!["at"]), `time order at row ${i}: ${rows[i - 1]!["at"]} > ${rows[i]!["at"]}`);
  for (const row of rows) { assert.ok((ACTIVITY_KINDS as readonly string[]).includes(String(row["kind"])), `kind ${row["kind"]}`); assert.ok(typeof row["actor"] === "string" && (row["actor"] as string).length > 0, "an actor"); assert.ok(typeof row["summary"] === "string" && typeof row["row_id"] === "string" && typeof row["table"] === "string", "a summary and a row id"); }
  const of = (kind: string): Json[] => rows.filter((x) => x["kind"] === kind);
  // the invitation notice (33.1's notices row, sent on the import's morning) — the earliest line
  const invitation = of("notice").find((x) => String(x["summary"]).startsWith("NTC_SM_PARTNER_BOOK_INVITATION")); assert.ok(invitation, "the invitation notice");
  assert.equal(invitation["table"], "notices"); assert.equal((invitation["detail"] as Json)["template_code"], "NTC_SM_PARTNER_BOOK_INVITATION"); assert.equal(String(invitation["at"]).slice(0, 19), T_IMPORT.slice(0, 19));
  const deliveries = (await db.query<{ channel: string }>(`SELECT channel FROM notice_deliveries WHERE notice_id = $1 ORDER BY attempt_no`, [invitation["row_id"]])).map((x) => x.channel);
  assert.ok(deliveries.length >= 1); assert.deepEqual((invitation["detail"] as Json)["channels"], deliveries, "the deliveries' channels as the section wrote them"); assert.ok(String(invitation["summary"]).includes(deliveries[0]!));
  assert.equal(await count(`notices WHERE id = $1 AND $2::uuid = ANY(recipient_party_ids)`, [invitation["row_id"], f.mariaId]), 1, "the row the import saved");
  assert.equal(of("notice").filter((x) => String(x["summary"]).startsWith("NTC_SM_PARTNER_BOOK_INVITATION")).length, 1, "one line per invitation, never the row twice");
  // the activation event (33.1 rule 6), on the first session
  const activated = of("event").find((x) => x["summary"] === "partner_book.account.activated"); assert.ok(activated, "the activation event");
  assert.equal(activated["table"], "loan_events"); assert.equal(String(activated["at"]).slice(0, 19), T_CODE.slice(0, 19)); assert.match(String(activated["actor"]), /^(system|agent|human):/); assert.equal((activated["detail"] as Json)["loan_id"], f.loan1Id);
  assert.ok(!("payload" in (activated["detail"] as Json)), "the event's type and keys, never its payload");
  // the sessions: the code door, the password, the code door again — each a row at its instant
  const sessions = of("session");
  assert.deepEqual(sessions.map((x) => x["summary"]), ["signed in · otp_email · L1", "signed in · password · L1", "signed in · otp_email · L1"]); assert.ok(sessions.every((x) => x["actor"] === "borrower" && x["table"] === "sessions"));
  assert.deepEqual(sessions.slice(0, 2).map((x) => x["row_id"]), f.mariaSessionIds);
  for (const s of sessions) for (const k of Object.keys(s["detail"] as Json)) assert.ok(!/token|hash/i.test(k));
  // the assistant's turns: model and prompt versions, the guard result — one line per agent_turns row of the party (the first turn, the returning turn, the answer, 33.2's analyst turn)
  const turns = of("turn");
  const turnRows = await db.query<{ turn_id: string; channel: string; model_version: string; prompt_version: string; reply_message_id: string | null; guard_result: Json }>(`SELECT turn_id::text AS turn_id, channel, model_version, prompt_version, reply_message_id::text AS reply_message_id, guard_result FROM agent_turns WHERE party_id = $1 ORDER BY created_at, turn_id`, [f.mariaId]);
  assert.ok(turnRows.length >= 3, `the first turn, the returning turn and the answer: ${turnRows.length}`); assert.equal(turns.length, turnRows.length, "every turn of the party, once");
  assert.deepEqual(turns.map((x) => x["row_id"]), turnRows.map((t) => t.turn_id));
  for (const t of turnRows) {
    const line = turns.find((x) => x["row_id"] === t.turn_id)!; const detail = line["detail"] as Json;
    assert.equal(line["table"], "agent_turns"); assert.equal(line["actor"], t.channel === "analyst" ? "agent:refi-analyst" : "agent:borrower-app");
    assert.equal(detail["model_version"], t.model_version); assert.equal(detail["prompt_version"], t.prompt_version); assert.equal(t.model_version, "scripted");
    assert.ok(String(line["summary"]).includes(`model ${t.model_version}`) && String(line["summary"]).includes(`prompt ${t.prompt_version}`), line["summary"] as string);
    assert.match(String(line["summary"]), /guard (passed|rejected)/); assert.ok(["passed", "rejected"].includes(String(detail["guard"]))); assert.ok(detail["guard_result"] && typeof detail["guard_result"] === "object");
    if (t.reply_message_id && t.guard_result?.["ok"] !== false) assert.equal(detail["guard"], "passed");
    assert.ok(!("context_hash" in detail) && !JSON.stringify(detail["tools"] ?? []).includes("args_hash"), "never the context hash or an args hash");
  }
  const appTurns = turnRows.filter((t) => t.channel === "app"); assert.ok(appTurns.length >= 3); assert.ok(appTurns.every((t) => turns.find((x) => x["row_id"] === t.turn_id)!["actor"] === "agent:borrower-app"));
  // the borrower's messages with tokens resolved as displayed: the first turn greets Maria and names the partner; the question as typed; the answer from the review
  const messages = of("message"); assert.ok(messages.length >= 4, `the greeting, the question, the answers: ${messages.length}`);
  for (const x of messages) { assert.ok(!String(x["summary"]).includes("{{"), `tokens resolved: ${x["summary"]}`); assert.ok(!String((x["detail"] as Json)["body_text"]).includes("{{")); assert.equal(x["table"], "messages"); assert.match(String(x["actor"]), /^(borrower|system|agent:[^:]+|human:[^:]*)$/, `one actor prefix: ${x["actor"]}`); }
  const disclosure = messages.find((x) => x["actor"] === "system" && String(x["summary"]).startsWith("This is an automated assistant for ")); assert.ok(disclosure, "the disclosure line (a {{copy:…}} row) rendered with the partner as the app renders it");
  assert.ok(String(disclosure["summary"]).includes(DEMO_PARTNER.legal_name), disclosure["summary"] as string);
  const greeting = messages.find((x) => String(x["actor"]).startsWith("agent:") && String(x["summary"]).startsWith("Hi Maria")); assert.ok(greeting, `the first turn as displayed: ${messages.map((x) => x["summary"]).join(" | ")}`);
  assert.ok(String(greeting["summary"]).includes(DEMO_PARTNER.legal_name), "the partner named as the servicer"); assert.equal(String(greeting["at"]).slice(0, 16), T_CODE.slice(0, 16)); assert.equal((greeting["detail"] as Json)["sender_label"], "Supermortgage");
  const greetingRow = (await db.query<{ sender_ref: string | null }>(`SELECT sender_ref FROM messages WHERE message_id = $1`, [greeting["row_id"]]))[0]!; assert.equal(greeting["actor"], greetingRow.sender_ref, "the agent the row names, as written (never prefixed twice)"); assert.match(String(greeting["actor"]), /^agent:[a-z-]+$/);
  const asked = messages.find((x) => x["actor"] === "borrower" && x["summary"] === question); assert.ok(asked, "the question"); assert.equal((asked["detail"] as Json)["sender_label"], "Maria"); assert.equal(String(asked["at"]).slice(0, 19), T_TALK.slice(0, 19));
  const answered = messages.find((x) => String(x["actor"]).startsWith("agent:") && String(x["summary"]).startsWith("Yes, Maria")); assert.ok(answered, "the answer from the review, the name resolved"); assert.equal(answered["actor"], greeting["actor"]);
  assert.ok(String(answered["at"]) >= String(asked["at"]));
  // the card and its resolution: the OfferCard as sent (pending) and the borrower's Yes (resolved)
  const cards = of("card");
  const sent = cards.find((x) => x["row_id"] === offer.card_instance_id); assert.ok(sent, "the OfferCard"); assert.equal(sent["table"], "card_instances"); assert.equal(sent["summary"], `OfferCard ${offer.copy_key} · pending`); assert.equal(sent["actor"], offer.created_by); assert.equal((sent["detail"] as Json)["status"], "resolved");
  const resolved = cards.find((x) => x["table"] === "card_instance_events" && (x["detail"] as Json)["card_instance_id"] === offer.card_instance_id && (x["detail"] as Json)["to_status"] === "resolved"); assert.ok(resolved, "the resolution");
  assert.equal(resolved["actor"], "borrower"); assert.equal(resolved["summary"], `OfferCard ${offer.copy_key} · resolved`); assert.ok(String(resolved["at"]) > String(sent["at"]));
  // the daily review decision (33.2: the refinance analyst's review.write on loan 1)
  const reviewDecision = of("decision").find((x) => String(x["summary"]).startsWith("review.write") && x["actor"] === "agent:refi-analyst"); assert.ok(reviewDecision, `the daily review decision: ${of("decision").map((x) => `${x["actor"]} ${x["summary"]}`).join(" | ")}`);
  assert.equal(reviewDecision["table"], "agent_decisions"); assert.equal((reviewDecision["detail"] as Json)["loan_id"], f.loan1Id); assert.equal((reviewDecision["detail"] as Json)["action"], "review.write");
  assert.equal(await count(`agent_decisions WHERE id = $1 AND agent = 'refi-analyst' AND loan_id = $2`, [reviewDecision["row_id"], f.loan1Id]), 1);
  assert.ok(of("decision").some((x) => String(x["summary"]).startsWith("readiness.check") && x["actor"] === "agent:refi-readiness"), "33.3's readiness decision too");
  // the analyst's own look: 34.1's staff_actions rows and the directory's own directory.viewed events, the staff member as actor
  const ownLooks = of("staff_look").filter((x) => x["actor"] === `staff:${analyst.staff_user_id}`); assert.ok(ownLooks.length >= 2, "the analyst's earlier looks");
  const look = ownLooks.find((x) => x["table"] === "staff_actions" && x["row_id"] === looksBefore[0]!.id); assert.ok(look, "34.1's log row");
  assert.ok(String(look["summary"]).includes("directory.account · ok") && String(look["summary"]).includes(`/ops/api/directory/accounts/${f.mariaId}`), look["summary"] as string);
  assert.ok(ownLooks.some((x) => x["table"] === "loan_events" && String(x["summary"]).startsWith("directory.viewed · account")), "the directory's own look events");
  assert.ok(of("staff_look").some((x) => x["actor"] === `staff:${f.staff.caraId}` && String(x["summary"]).startsWith("directory.unmasked")), "compliance's unmask of T3 is a line too");
  // nothing of another person: no line names the homegrown account
  assert.ok(!JSON.stringify(rows).includes(f.ines.party_id) && !JSON.stringify(rows).includes("Ferreira"));
  // kind=turn leaves the turns only
  const only = await api("GET", `/ops/api/directory/accounts/${f.mariaId}/activity?kind=turn`, undefined, bearer(analyst.token));
  assert.equal(only.status, 200); assert.deepEqual(only.body["kinds"], ["turn"]);
  const onlyRows = only.body["rows"] as Json[]; assert.ok(onlyRows.length >= 3); assert.ok(onlyRows.every((x) => x["kind"] === "turn")); assert.deepEqual(onlyRows.map((x) => x["row_id"]), turns.map((x) => x["row_id"]));
  const viewed = (await events("directory.viewed")).filter((e) => e.payload["party_id"] === f.mariaId && e.payload["section"] === "activity" && e.payload["staff_user_id"] === analyst.staff_user_id);
  assert.equal(viewed.length, 2); assert.deepEqual(viewed[1]!.payload["kinds"], ["turn"]);
  const row = await actionRow(`staff_user_id = $1 AND command = 'directory.activity' AND route = $2`, [analyst.staff_user_id, `/ops/api/directory/accounts/${f.mariaId}/activity?kind=turn`]); assert.equal(row.result, "ok");
});

test("34.2-T5: Given `compliance` exports the account, then a document exists on `documents` with a hash, `directory_exports` and `directory.exported` record it, and the pack carries the person's rows only (no other party's message, card or event appears).", { skip }, async () => {
  const f = await fixtureOnce();
  clock.set(T_EXPORT);
  // the shared subject: the refinance application T4's Yes opened for Maria (33.3 rule 4), with the homegrown account as co-borrower on it — her consent event and her decision carry the SAME application id and are not Maria's rows; Maria's own are
  const app = (await db.query<{ id: string }>(`SELECT id::text AS id FROM applications WHERE prior_loan_id = $1 ORDER BY created_at LIMIT 1`, [f.loan1Id]))[0]; assert.ok(app, "the refinance application of the Yes");
  assert.equal(await count(`application_borrowers WHERE application_id = $1 AND party_id = $2`, [app.id, f.mariaId]), 1);
  await db.query(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name, party_id) VALUES ($1, 'co_borrower', $2, $3)`, [app.id, INES.name, f.ines.party_id]);
  const mariaConsentEventId = randomUUID(); const inesConsentEventId = randomUUID(); const mariaDecisionId = randomUUID(); const inesDecisionId = randomUUID();
  for (const [id, party, at] of [[mariaConsentEventId, f.mariaId, "2026-09-15T13:28:00.000Z"], [inesConsentEventId, f.ines.party_id, "2026-09-15T13:29:00.000Z"]] as const)
    await db.query(`INSERT INTO loan_events (id, type, occurred_at, application_id, aggregate_kind, aggregate_id, actor_kind, actor_id, payload) VALUES ($1, 'consent.esign.granted', $2, $3::uuid, 'application', $3::text, 'system', 'borrower-app', $4::jsonb)`, [id, at, app.id, JSON.stringify({ party_id: party, application_id: app.id, kind: "esign" })]);
  for (const [id, party] of [[mariaDecisionId, f.mariaId], [inesDecisionId, f.ines.party_id]] as const)
    await db.query(`INSERT INTO agent_decisions (id, agent, application_id, subject_kind, subject_id, rule_code, action, rule_set_version, model_version, prompt_version, rationale, confidence, created_at) VALUES ($1, 'borrower-app', $2, 'party', $3, '32.2 rule 1', 'consent.record', 'consent.v1', 'deterministic', '32.2-v1', 'consent recorded', 1, '2026-09-15T13:29:30.000Z')`, [id, app.id, party]);
  // the other person's rows: her messages, her cards, her turns, her events
  const inesMessages = (await db.query<{ id: string }>(`SELECT m.message_id::text AS id FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE c.party_id = $1`, [f.ines.party_id])).map((x) => x.id);
  const inesCards = (await db.query<{ id: string }>(`SELECT card_instance_id::text AS id FROM card_instances WHERE party_id = $1`, [f.ines.party_id])).map((x) => x.id);
  const inesTurns = (await db.query<{ id: string }>(`SELECT turn_id::text AS id FROM agent_turns WHERE party_id = $1`, [f.ines.party_id])).map((x) => x.id);
  const inesEvents = (await db.query<{ id: string }>(`SELECT id::text AS id FROM loan_events WHERE application_id = $1 OR payload->>'party_id' = $2`, [f.ines.application_id, f.ines.party_id])).map((x) => x.id);
  assert.ok(inesMessages.length >= 2 && inesCards.length >= 1 && inesTurns.length >= 1 && inesEvents.length >= 1, `the other person's rows exist: ${inesMessages.length} messages, ${inesCards.length} cards, ${inesTurns.length} turns, ${inesEvents.length} events`);
  assert.ok(inesMessages.includes(f.ines.message_id));
  // the export
  const compliance = await staffSignIn(CARA);
  const reason = "examiner request 2026-09-15";
  const r = await api("POST", `/ops/api/directory/accounts/${f.mariaId}/export`, { reason, include_pack: true }, bearer(compliance.token));
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 600));
  const { export_id, pack_id, document_id, sha256: hash, byte_size, manifest, pack } = r.body as { export_id: string; pack_id: string; document_id: string; sha256: string; byte_size: number; manifest: Json; pack: { manifest: Json; sets: Record<string, Json[]>; events: Json[] } };
  assert.match(hash, /^[0-9a-f]{64}$/); assert.equal(r.body["party_id"], f.mariaId); assert.equal(r.body["pack_included"], true); assert.ok(pack && typeof pack === "object");
  // one layout for a person (rule 5: "34.4's layout restricted to the party"): the document is `{manifest, sets}`, its bytes hashed; the events ride in the pack's parts
  const document = JSON.stringify({ manifest: pack.manifest, sets: pack.sets });
  assert.equal(sha256(Buffer.from(document, "utf8")), hash, "the hash is the document's bytes'"); assert.equal(Buffer.byteLength(document), byte_size);
  assert.deepEqual(manifest["subject"], { kind: "party", id: f.mariaId, from_date: null, to_date: null }); assert.deepEqual(pack.manifest, manifest);
  assert.deepEqual((manifest["sections"] as Json[]).map((x) => x["name"]), [...EVIDENCE_SECTIONS], "every row set of the 34.4 layout, the directory's own last");
  for (const x of manifest["sections"] as Json[]) { assert.equal(typeof x["count"], "number"); assert.match(String(x["sha256"]), /^[0-9a-f]{64}$/); if (x["name"] !== "events") assert.equal(sha256(Buffer.from(JSON.stringify(pack.sets[x["name"] as string]), "utf8")), x["sha256"], `${x["name"]}: the hash is of the stored rows`); }
  assert.equal(manifest["produced_by"], compliance.staff_user_id); assert.equal(manifest["produced_role"], "compliance"); assert.equal(pack.events.length, (manifest["sections"] as Json[]).find((x) => x["name"] === "events")!["count"]);
  // documents: the pack, hashed, retained — an evidence_packs row with the manifest (34.4's row), the text kept with the documents row
  const doc = (await db.query<{ kind: string; sha256: string; byte_size: string; mime_type: string; retention_class: string; metadata: Json }>(`SELECT kind, sha256, byte_size::text AS byte_size, mime_type, retention_class::text AS retention_class, metadata FROM documents WHERE id = $1`, [document_id]))[0]; assert.ok(doc, "the documents row");
  assert.equal(doc.kind, EXPORT_DOCUMENT_KIND); assert.equal(doc.kind, "evidence_pack"); assert.equal(doc.sha256, hash); assert.equal(doc.byte_size, String(byte_size)); assert.equal(doc.mime_type, "application/json"); assert.equal(doc.metadata["pack_id"], pack_id); assert.deepEqual(doc.metadata["subject"], manifest["subject"]); assert.equal(doc.metadata["produced_by"], compliance.staff_user_id);
  assert.equal(doc.metadata["document"], document, "the document text rides with its row (retained where it was produced)");
  const packRow = (await db.query<{ subject_kind: string; subject_id: string; document_id: string; sha256: string; produced_by: string; manifest: Json }>(`SELECT subject_kind, subject_id, document_id::text AS document_id, sha256, produced_by::text AS produced_by, manifest FROM evidence_packs WHERE id = $1`, [pack_id]))[0]; assert.ok(packRow, "the evidence_packs row");
  assert.deepEqual([packRow.subject_kind, packRow.subject_id, packRow.document_id, packRow.sha256, packRow.produced_by], ["party", f.mariaId, document_id, hash, compliance.staff_user_id]); assert.deepEqual(packRow.manifest, manifest);
  // …and it reads back and verifies through 34.4's evidence route: every row set re-hashes to the manifest
  const got = await api("GET", `/ops/api/controls/evidence/${pack_id}?verify=1`, undefined, bearer(compliance.token)); assert.equal(got.status, 200, JSON.stringify(got.body).slice(0, 300));
  assert.equal(got.body["document_available"], true); assert.equal(got.body["document"], document); assert.equal((got.body["verification"] as Json)["verified"], true, JSON.stringify(got.body["verification"]).slice(0, 600));
  // directory_exports and directory.exported
  const row = (await db.query<{ staff_user_id: string; party_id: string; document_id: string; sha256: string; created_at: string }>(`SELECT staff_user_id::text AS staff_user_id, party_id::text AS party_id, document_id::text AS document_id, sha256, created_at::text AS created_at FROM directory_exports WHERE id = $1`, [export_id]))[0]; assert.ok(row, "the directory_exports row");
  assert.deepEqual([row.staff_user_id, row.party_id, row.document_id, row.sha256], [compliance.staff_user_id, f.mariaId, document_id, hash]);
  const ev = (await events("directory.exported")).find((e) => e.id === r.body["event_id"]); assert.ok(ev, "directory.exported");
  assert.deepEqual([ev.actor_kind, ev.actor_id, ev.actor_role], ["human", compliance.staff_user_id, "compliance"]);
  assert.equal(ev.payload["export_id"], export_id); assert.equal(ev.payload["pack_id"], pack_id); assert.equal(ev.payload["party_id"], f.mariaId); assert.equal(ev.payload["staff_user_id"], compliance.staff_user_id); assert.equal(ev.payload["document_id"], document_id); assert.equal(ev.payload["sha256"], hash);
  assert.ok(!JSON.stringify(ev.payload).includes("@") && !JSON.stringify(ev.payload).includes("Garcia"), "ids only");
  const produced = (await events("evidence.pack.produced")).find((e) => e.payload["pack_id"] === pack_id); assert.ok(produced, "34.4's own receipt"); assert.deepEqual([produced.actor_kind, produced.actor_id], ["human", compliance.staff_user_id]);
  const d = await decision(r.body["decision_id"] as string); assert.equal(d.action, "directory.export"); assert.equal(d.agent, "security-records"); assert.deepEqual(d.evidence_document_ids, [document_id]); assert.equal(d.rationale, reason); assert.equal(d.approved_role, "compliance");
  const action = await actionRow(`staff_user_id = $1 AND command = 'directory.export'`, [compliance.staff_user_id]); assert.equal(action.result, "ok"); assert.deepEqual([action.subject_kind, action.subject_id], ["export", export_id], "the row names the export produced (the person's own staff_actions set is a row set of the pack, which stays verifiable)");
  // the pack carries the person's rows only
  const dir = (table: string): Json[] => (pack.sets["directory"] ?? []).filter((x) => x["table_name"] === table).map((x) => x["data"] as Json);
  const pb = (table: string): Json[] => (pack.sets["partner_book"] ?? []).filter((x) => x["table_name"] === table).map((x) => x["data"] as Json);
  const mariaMessages = (await db.query<{ id: string }>(`SELECT m.message_id::text AS id FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE c.party_id = $1`, [f.mariaId])).map((x) => x.id);
  const messages = dir("messages"); assert.ok(messages.length >= 4); assert.ok(messages.every((x) => mariaMessages.includes(x["message_id"] as string)), "every message is Maria's"); assert.ok(!messages.some((x) => inesMessages.includes(x["message_id"] as string)), "no other party's message");
  const cards = dir("card_instances"); assert.ok(cards.length >= 1); assert.ok(!cards.some((x) => inesCards.includes(x["card_instance_id"] as string)), "no other party's card");
  assert.ok(cards.every((x) => x["subject_loan_id"] === f.loan1Id || x["subject_application_id"] === app.id || (x["subject_loan_id"] === null && x["subject_application_id"] === null)));
  assert.ok(!dir("card_instance_events").some((x) => inesCards.includes(x["card_instance_id"] as string)));
  const turns = pack.sets["agent_turns"]!; assert.ok(turns.length >= 3); assert.ok(!turns.some((x) => inesTurns.includes(x["turn_id"] as string)), "no other party's turn"); assert.ok(turns.every((x) => x["party_id"] === f.mariaId && !("context_hash" in x) && Array.isArray(x["tool_names"])), "the turn's versions, guard result and tool names — never the context hash");
  const evs = pack.events; assert.ok(evs.length >= 3);
  assert.ok(evs.some((x) => x["type"] === "partner_book.account.activated"), "the activation"); assert.ok(evs.some((x) => x["id"] === mariaConsentEventId), "Maria's own consent on the shared application");
  assert.ok(!evs.some((x) => x["id"] === inesConsentEventId), "no co-borrower's event on the shared application"); assert.ok(!evs.some((x) => inesEvents.includes(x["id"] as string)), "no other party's event");
  assert.ok(evs.every((x) => x["loan_id"] === f.loan1Id || x["application_id"] === app.id || (x["loan_id"] === null && x["application_id"] === null && ((x["payload"] as Json)?.["party_id"] === f.mariaId || (x["aggregate_kind"] === "party" && x["aggregate_id"] === f.mariaId)))), "events of the person's loan and application only");
  assert.ok(evs.every((x) => { const p = (x["payload"] as Json | null)?.["party_id"]; return p === undefined || p === null || p === f.mariaId; }), "no event naming another party");
  const decisions = pack.sets["decisions"]!; assert.ok(decisions.some((x) => x["id"] === mariaDecisionId)); assert.ok(!decisions.some((x) => x["id"] === inesDecisionId), "no co-borrower's decision on the shared application");
  assert.ok(decisions.every((x) => x["subject_kind"] !== "party" || x["subject_id"] === f.mariaId));
  assert.equal(dir("sessions").length, await count(`sessions WHERE party_id = $1`, [f.mariaId])); assert.ok(dir("sessions").every((x) => x["party_id"] === f.mariaId && !("token_hash" in x)), "the person's sessions, never a token");
  assert.ok(pb("partner_book_facts").length >= 1 && pb("partner_book_reviews").length >= 1 && pb("readiness_checks").length >= 1 && pb("partner_book_invitations").length >= 1, "the person's own partner-book rows"); assert.ok(pb("partner_book_facts").every((x) => !("raw" in x)), "the facts without the tape's raw cells");
  assert.ok(dir("directory_unmasks").length >= 1 && pack.sets["staff_actions"]!.length >= 1, "the looks and the unmask of this person"); assert.ok(pack.sets["staff_actions"]!.every((x) => x["subject_id"] === f.mariaId));
  const stream = (await api("GET", `/ops/api/directory/accounts/${f.mariaId}/activity`, undefined, bearer(compliance.token))).body["rows"] as Json[]; assert.ok(stream.some((x) => x["row_id"] === mariaConsentEventId) && !stream.some((x) => x["row_id"] === inesConsentEventId || x["row_id"] === inesDecisionId), "the activity stream keeps the same line");
  const text = document + JSON.stringify(pack.events);
  assert.ok(!text.includes(f.ines.party_id) && !text.includes(INES.name) && !text.includes("Ferreira") && !text.includes(INES.email) && !text.includes(INES.ssn), "nothing of the other person");
  for (const id of [...inesMessages, ...inesCards, ...inesTurns, ...inesEvents]) assert.ok(!text.includes(id), `row ${id} of the other person is in the pack`);
  assertNoSecrets(r.body, await secretsOf([f.mariaId, f.ines.party_id], f), "export");
  // an analyst may not export: ROLE_REQUIRED{compliance}, and nothing written
  const exports = await count(`directory_exports`);
  const denied = await api("POST", `/ops/api/directory/accounts/${f.mariaId}/export`, { reason: "x" }, bearer((await staffSignIn(OLI)).token));
  assert.equal(denied.status, 403, JSON.stringify(denied.body)); assert.equal(denied.body["code"], "ROLE_REQUIRED"); assert.equal(denied.body["role"], "compliance"); assert.equal(await count(`directory_exports`), exports);
});

test("34.2-T6: Given any directory response, then no field carries a full SSN, a credential hash, a session token or a vendor payload (contract test over every route with a fixture account whose rows carry each).", { skip }, async () => {
  const f = await fixtureOnce();
  clock.set(T_CONTRACT);
  const ines = f.ines.party_id;
  // the fixture account's rows carry each: the SSN typed into her thread, a credential hash, a session token hash, the vendor's payload (the identity ConnectCard's props / evidence, the ui_events payload) and the model's context hash
  assert.ok((await db.query<{ body_text: string }>(`SELECT body_text FROM messages WHERE message_id = $1`, [f.ines.message_id]))[0]!.body_text.includes(INES.ssn), "the typed SSN is on the row (the record is what the section wrote)");
  const cred = (await db.query<{ password_hash: string }>(`SELECT password_hash FROM party_credentials WHERE party_id = $1`, [ines]))[0]; assert.ok(cred?.password_hash && cred.password_hash.length >= 32, "a credential hash");
  const tokenHashes = (await db.query<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE party_id = $1`, [ines])).map((x) => x.token_hash); assert.ok(tokenHashes.length >= 1 && tokenHashes.every((h) => h.length >= 32), "a session token hash");
  assert.equal(await count(`card_instances WHERE party_id = $1 AND props->>'vendor_session_id' = $2`, [ines, f.ines.vendor_session_id]), 1, "the vendor's session on the card's props");
  assert.ok(await count(`card_instance_events e JOIN card_instances c ON c.card_instance_id = e.card_instance_id WHERE c.party_id = $1 AND e.evidence->>'vendor_session_id' = $2`, [ines, f.ines.vendor_session_id]) >= 1, "the vendor's payload on the card's transition");
  assert.ok(await count(`ui_events WHERE party_id = $1 AND payload->>'vendor_session_id' = $2`, [ines, f.ines.vendor_session_id]) >= 1, "the vendor's payload on the ui_events row");
  assert.ok(await count(`agent_turns WHERE party_id = $1 AND context_hash IS NOT NULL`, [ines]) >= 1, "the model's context hash");
  const secrets = await secretsOf([ines, f.mariaId], f);
  assert.ok(secrets.includes(cred.password_hash) && tokenHashes.every((h) => secrets.includes(h)) && secrets.includes(f.ines.client_secret) && secrets.includes(INES.ssn), "the contract hunts for every one of them");
  const vendorBlob = (v: unknown, where: string): void => { if (Array.isArray(v)) v.forEach((x, i) => vendorBlob(x, `${where}[${i}]`)); else if (v && typeof v === "object") { const o = v as Json; assert.ok(!("vendor" in o && ("outcome" in o || "started_at" in o || "completed_at" in o || "client_secret" in o)), `${where} carries a vendor blob`); for (const [k, x] of Object.entries(o)) vendorBlob(x, `${where}.${k}`); } };
  // every route, for every role that may call it, on the fixture account (and on Maria's — the FAKE vendor's ConnectCards of the Yes are on her rows too)
  const staff = { analyst: await staffSignIn(OLI), officer: await staffSignIn(ORA), compliance: await staffSignIn(CARA) };
  const checked: string[] = [];
  const get = async (who: keyof typeof staff, path: string): Promise<Json> => { const r = await api("GET", path, undefined, bearer(staff[who].token)); assert.equal(r.status, 200, `${who} ${path}: ${JSON.stringify(r.body).slice(0, 300)}`); assertNoSecrets(r.body, secrets, `${who} GET ${path}`); checked.push(`${who} GET ${path}`); return r.body; };
  const post = async (who: keyof typeof staff, path: string, body: Json, status: number): Promise<Json> => { const r = await api("POST", path, body, bearer(staff[who].token)); assert.equal(r.status, status, `${who} ${path}: ${JSON.stringify(r.body).slice(0, 300)}`); assertNoSecrets(r.body, secrets, `${who} POST ${path}`); checked.push(`${who} POST ${path}`); return r.body; };
  for (const party of [ines, f.mariaId]) for (const who of ["analyst", "officer", "compliance"] as const) {
    const q = party === ines ? "Ferreira" : "Garcia";
    const s = await get(who, `/ops/api/directory/search?q=${encodeURIComponent(q)}`); assert.ok((s["results"] as Json[]).some((x) => x["party_id"] === party));
    await get(who, `/ops/api/directory/search?q=${encodeURIComponent(party === ines ? INES.email.slice(0, 6) : L1.email!.slice(0, 6))}`);
    await get(who, `/ops/api/directory/accounts/${party}`);
    const act = await get(who, `/ops/api/directory/accounts/${party}/activity`); assert.ok((act["rows"] as Json[]).length >= 5);
    for (const kind of ACTIVITY_KINDS) await get(who, `/ops/api/directory/accounts/${party}/activity?kind=${kind}`);
    await get(who, `/ops/api/directory/accounts/${party}/activity?from=2026-09-14&to=2026-09-15`);
  }
  // the writing routes: the officer's and the compliance user's unmask, then the unmasked pages; the compliance export with the pack on the wire
  for (const party of [ines, f.mariaId]) {
    for (const who of ["officer", "compliance"] as const) {
      await post(who, `/ops/api/directory/accounts/${party}/unmask`, { fields: ["contact", "identity"], reason: "contract" }, 200);
      const page = await get(who, `/ops/api/directory/accounts/${party}`); assert.deepEqual(page["mask"], { contact: true, identity: true }, `${who} unmasked`);
      await get(who, `/ops/api/directory/accounts/${party}/activity`);
    }
    const x = await post("compliance", `/ops/api/directory/accounts/${party}/export`, { reason: "contract", include_pack: true }, 201);
    const xp = x["pack"] as { manifest: Json; sets: Record<string, Json[]>; events: Json[] }; assert.ok(xp, "the pack on the wire"); assert.equal((xp.manifest["subject"] as Json)["id"], party); vendorBlob(x, `the pack of ${party}`);
    // the vendor blobs' homes are never copied: a card row without its props, a transition without its evidence (the `directory` section of the one-person pack)
    const dirRows = (table: string): Json[] => (xp.sets["directory"] ?? []).filter((r) => r["table_name"] === table).map((r) => r["data"] as Json);
    assert.ok(dirRows("card_instances").length >= 1 && dirRows("card_instances").every((c) => !("props" in c)), "card rows without props");
    assert.ok(dirRows("card_instance_events").length >= 1 && dirRows("card_instance_events").every((e) => !("evidence" in e)), "transitions without evidence");
    if (party === ines) assert.ok(xp.events.some((e) => e["type"] === "identity.verified"), "the record's own identity.verified row is in the pack");
    const doc = (await db.query<{ metadata: Json }>(`SELECT metadata FROM documents WHERE id = $1`, [x["document_id"] as string]))[0]!; assertNoSecrets(doc.metadata, secrets, `the stored pack of ${party}`); assertNoSecrets(JSON.parse(String(doc.metadata["document"])), secrets, `the retained document of ${party}`);
    await post("analyst", `/ops/api/directory/accounts/${party}/unmask`, { fields: ["contact"], reason: "contract" }, 403);
    await post("officer", `/ops/api/directory/accounts/${party}/export`, { reason: "contract" }, 403);
  }
  // the refusals carry nothing either
  await get("analyst", `/ops/api/directory/search?q=${encodeURIComponent("zz")}`).catch(() => undefined);
  const short = await api("GET", `/ops/api/directory/search?q=zz`, undefined, bearer(staff.analyst.token)); assert.equal(short.status, 400); assertNoSecrets(short.body, secrets, "a refusal");
  const missing = await api("GET", `/ops/api/directory/accounts/${randomUUID()}`, undefined, bearer(staff.analyst.token)); assert.equal(missing.status, 404); assertNoSecrets(missing.body, secrets, "a 404");
  assert.ok(checked.length >= 60, `every route covered: ${checked.length}`);
  for (const route of ["directory/search", "/activity", "/unmask", "/export"]) assert.ok(checked.some((c) => c.includes(route)), route);
  assert.ok(checked.some((c) => /GET \/ops\/api\/directory\/accounts\/[0-9a-f-]{36}$/.test(c)), "the account route");
  // and the directory's own log rows carry none of it (34.1 rule 4)
  const actions = await db.query<{ row: string }>(`SELECT staff_actions::text AS row FROM staff_actions WHERE route LIKE '/ops/api/directory/%'`); assert.ok(actions.length >= checked.length);
  for (const a of actions) assertNoSecrets(a.row, secrets, "a staff_actions row");
  for (const e of await db.query<{ payload: Json }>(`SELECT payload FROM loan_events WHERE type LIKE 'directory.%'`)) assertNoSecrets(e.payload, secrets, "a directory event");
});
