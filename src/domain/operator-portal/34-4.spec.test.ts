// 34.4 Evidence and controls: clocks, escalations, the outbox, AI systems, the evidence pack
// spec/sections/34-operator-portal/34-4-evidence-and-controls-clocks-escalations-the-outbox-ai-systems-the-evidence-pack.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness: own database `<base>_34_4` (dropped, created, migrated), the API server of src/runtime/server.ts in-process with
// the ops console mounted at /ops/api (createApiServer's default `console`, its own FakeBlobStore as the packs' document store)
// and a borrower router on the scripted Messages API client (src/domain/borrower/eval/scripted-client.ts) so a borrower turn
// really runs — or is bypassed — behind the kill switch. The fixture book (33.1 rule 7) is posted to POST /v1/partner-book/imports
// with the clock at 2026-09-01 (the invitations go out; the fourteen-day reminder clocks arm), then the clock moves to 07:20
// America/New_York on 2026-09-16 and runtime.sweep() takes the day's passes with the FAKE rate feed, the FAKE reviewers and 33.2's
// scripted analyst: the reminder clocks and the late-tape clock breach, the daily review and readiness clocks arm. The staff (34.1):
// the bootstrap admin invites an ops_analyst and a compliance user; each enrols (code + password) and signs in — the sessions are
// opened after the clock move and every later move stays under the 30-minute idle window. Every /ops/api request the suite sends is
// recorded with the money fingerprint taken before and after it when it is a controls route (T6), so the action log and the money
// contract are checked request for request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime, type SweepReport } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { AnthropicLlm } from "../../runtime/borrower/agent/llm.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { bootstrapStaffAdmin, STAFF_LOCK_AFTER_FAILURES } from "../../runtime/staff/auth.ts";
import { section34RouteTable } from "../../console/server.ts";
import { CONTROLS_AGENT, CONTROLS_MODEL_VERSION, CONTROLS_PROMPT_VERSION, CONTROLS_RULE_SET_VERSION } from "../../runtime/controls/common.ts";
import { KILL_CONFIRM_MINUTES } from "../../runtime/controls/ai.ts";
import { REQUEUE_CAP } from "../../runtime/controls/outbox.ts";
import { EVIDENCE_SECTIONS } from "../../runtime/controls/evidence.ts";
import { FakeRateFeed } from "../../infra/integrations/rates.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { scriptedClient, type Scene } from "../borrower/eval/scripted-client.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, type DemoLoan } from "../partner-book/fixtures/partner-book-demo.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
type Json = Record<string, unknown>;

/** The fixture book's as-of day, 12:00 America/New_York: the invitations go out, the reminders arm +14 calendar days (due end of 2026-09-15 ET). */
const SEED_AT = "2026-09-01T16:00:00.000Z";
/** 07:20 America/New_York on 2026-09-16 — the morning after the reminders' due day: the sweep breaches them; past 20.1's 06:30 run, 33.2's 07:00 review and 33.3's 07:15 pass, which arm the daily clocks. */
const NOW = "2026-09-16T11:20:00.000Z";
const clock = new FixedClock(NOW);
const MIN = 60_000;
const at = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const REMINDER = "SM_PARTNER_BOOK_INVITATION_REMINDER_14"; const REVIEW_CLOCK = "SM_PARTNER_BOOK_REVIEW_DAILY"; const READINESS_CLOCK = "SM_PARTNER_BOOK_READINESS_DAILY"; const TAPE_CLOCK = "SM_PARTNER_BOOK_TAPE_EXPECTED_7"; const SHEET_CLOCK = "SM_RATE_SHEET_PUBLISH_DAILY";
const PLACEHOLDER = "thread.assistant_placeholder.intake";

// ---------------------------------------------------------------- 33.2's scripted analyst (rule 4): review_facts then review_write, every figure a {{facts.*}} token
const CLEAN_RATIONALE = "Your rate today is {{facts.rate_now}} and this morning's sheet shows {{facts.candidate_rate}}, which lowers the payment by {{facts.monthly_delta}}. The offer is on the card here.";
const ANALYST_CANDIDATE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: CLEAN_RATIONALE, flags: ["value_low_confidence"] } }], text: "Written." };
const ANALYST_WATCHING: Scene = { when: /verdict is watching/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "Rates are not below yours yet; the book is checked every morning.", flags: [] } }], text: "Written." };
const ANALYST_NOT_NOW: Scene = { when: /verdict is not now/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "Not today; the loan is held out of this morning's review.", flags: [] } }], text: "Written." };
const ANALYST_EXCLUDED: Scene = { when: /verdict is excluded/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "The loan is out of today's review because of what is on the partner's file; nothing is offered.", flags: ["pay_string_late"] } }], text: "Written." };
const analystScripted = scriptedClient([ANALYST_CANDIDATE, ANALYST_WATCHING, ANALYST_NOT_NOW, ANALYST_EXCLUDED]);

// ---------------------------------------------------------------- the scripted borrower model: the monitored first turn (33.1 rule 5), the organic first turn (32.16), the returning line, and the question T4 asks with the switch armed and tripped
const MONITORED_FIRST_TURN: Scene = { when: /signed in for the first time to the account their servicer set up/, text: "Hi {{party.first_name}}, I'm Michelle, the automated assistant here. Your loan with {{partner_book.partner_name}} is on the record here, and {{partner_book.partner_name}} keeps servicing it." };
const ORGANIC_FIRST_TURN: Scene = { when: /just created their account/, text: "Hi. Are you looking to buy a home, lower your rate or payment, or take cash out?" };
const RETURNING: Scene = { when: /the borrower is back/, text: "Welcome back, {{party.first_name}}. The next thing I need from you is on the rail." };
const PING_REPLY = "It is — what would you like to do first?";
const PING: Scene = { when: /is this thing on/i, text: PING_REPLY };
const scripted = scriptedClient([MONITORED_FIRST_TURN, ORGANIC_FIRST_TURN, RETURNING, PING]);

// the people (34.1): the bootstrap admin (confirms the kill switch), the analyst (clocks, escalations, the outbox), the compliance user (the kill switch, the pack), Pat (locked in T2 for a compliance escalation)
const ADA = { email: `ada.admin.${R}@example.test`, name: "Ada Admin", password: `ada-correct-horse-${R}` };
const OLI = { email: `oli.analyst.${R}@example.test`, name: "Oli Analyst", password: `oli-analyst-pass-${R}` };
const CARA = { email: `cara.compliance.${R}@example.test`, name: "Cara Compliance", password: `cara-reviewer-pass-${R}` };
const PAT = { email: `pat.pending.${R}@example.test`, name: "Pat Pending", password: `pat-analyst-pass-${R}` };
type Session = { token: string; session_id: string; staff_user_id: string; role: string };
let ada: Session; let oli: Session; let cara: Session; let patId = "";

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = ""; let loan1Id = ""; let party1Id = ""; let sweep: SweepReport | undefined; let moneyBaseline = "";
const logLines: string[] = [];
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");
const J = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|controls|kill|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  clock.set(SEED_AT);
  // the FAKE feed publishes the day's sheet (20.1), the FAKE MLO reviews offer terms (32.11), 33.2's scripted analyst plays rule 4's turn — the passes that arm the daily clocks T1 lists
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: new FakeRateFeed(), reviewers: new FakeReviewers({ delaySeconds: 0 }), analystLlm: new AnthropicLlm({ client: analystScripted.client, model: "scripted" }) });
  // the partner's parties{servicer} row (33.1's ensurePartner finds it by legal name) doubles as the borrower surface's configured partner and the entry seed's demo partner
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, '{"phone": "+18005550199"}'::jsonb) RETURNING id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id]))[0]!.id;
  const seed = await seedEntryDemo(runtime, { partner_id: partnerPartyId, nmlsr_id: DEMO_PARTNER.nmlsr_id });
  assert.equal(seed.partner_id, partnerPartyId, "the demo partner is the fixture partner");
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId, llm: { client: scripted.client, model: "scripted" } });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  // the fixture book as of 2026-09-01, posted the way the operator posts it (33.1 T1): twelve monitored loans, eleven invitations, the reminder clocks
  const imp = await bapi("POST", "/v1/partner-book/imports", { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content_base64: Buffer.from(book.tape).toString("base64") }, supplement: { filename: "partner-book-demo-supplement.csv", content_base64: Buffer.from(book.supplement, "utf8").toString("base64") } }, undefined, "10.34.4.2", { authorization: `Bearer ${TOKEN}`, "x-actor-id": "u-ops-analyst" });
  assert.equal(imp.status, 200, J(imp.body).slice(0, 600)); assert.equal(imp.body["status"], "loaded"); assert.equal(imp.body["rows_loaded"], 12); assert.equal(imp.body["invitations_sent"], 11);
  await settle();
  loan1Id = (await db.query<{ id: string }>(`SELECT id::text AS id FROM loans WHERE partner_party_id = $1 AND servicer_loan_number = $2`, [partnerPartyId, loanN(1).servicer_loan_number]))[0]!.id;
  party1Id = (await db.query<{ party_id: string }>(`SELECT b.party_id::text AS party_id FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC LIMIT 1`, [loan1Id]))[0]!.party_id;
  // two weeks on: the sweep breaches the reminders (their breach action sends one reminder each) and the late-tape clock, runs 20.1's check, 33.2's review and 33.3's readiness pass, which arm their daily clocks
  clock.set(NOW);
  sweep = await runtime.sweep(NOW); await settle();
  assert.ok(sweep.breaches.some((b) => b.code === REMINDER), `the reminder clocks breached: ${J(sweep.breaches.map((b) => b.code))}`);
  assert.ok(sweep.partner_book_review.ran, `the review ran: ${sweep.partner_book_review.line}`);
  // 34.1: the bootstrap admin, enrolled and signed in, invites the analyst and the compliance user; each enrols and signs in (the code and the password)
  const boot = await bootstrapStaffAdmin(runtime, ADA.email, { legal_name: ADA.name }); assert.equal(boot.created, true);
  await enrol(ADA); ada = await signIn(ADA, "admin");
  await invite(ada, OLI, ["ops_analyst"]); await invite(ada, CARA, ["compliance"]);
  await enrol(OLI); await enrol(CARA);
  oli = await signIn(OLI, "ops_analyst"); cara = await signIn(CARA, "compliance");
  moneyBaseline = await moneyFingerprint();
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

// ---------------------------------------------------------------- helpers over the API (34.1's doors, the console's routes, the action log, the borrower API)
type Reply = { status: number; body: Json };
/** Every /ops/api request the suite sent: the method and the route the action log records, who sent it, the answer, and — for a controls route — the money fingerprint before and after (T6). */
type Sent = { method: string; route: string; status: number; staff_user_id: string | null; session_id: string | null; controls: boolean; money_before: string; money_after: string };
const sent: Sent[] = [];
async function api(method: string, path: string, body?: unknown, s?: Session | null, headers: Record<string, string> = {}): Promise<Reply> {
  const ops = path.startsWith("/ops/api/"); const controls = path.startsWith("/ops/api/controls");
  const before = controls ? await moneyFingerprint() : "";
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.34.4.1", "user-agent": "34.4-spec", ...(s ? { authorization: `Bearer ${s.token}`, "x-staff-role": s.role } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); const reply = { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
  if (ops) { const u = new URL(path, "http://x"); u.searchParams.delete("email"); sent.push({ method, route: u.pathname + u.search, status: r.status, staff_user_id: s?.staff_user_id ?? null, session_id: s?.session_id ?? null, controls, money_before: before, money_after: controls ? await moneyFingerprint() : "" }); }
  return reply;
}
/** The borrower API (and the ops-bearer import): not the console, so never on the action log. */
async function bapi(method: string, path: string, body?: unknown, token?: string, ip = "10.34.4.9", headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const settle = async (): Promise<void> => { await router.flows!.settle(); await router.agent?.settle(); await router.flows!.settle(); };
/** The door's first half: a code to the e-mail (FAKE, echoed) verified into an enrol/step token. */
async function codeToken(email: string): Promise<string> {
  const c = await api("POST", "/ops/api/auth/code", { email });
  assert.equal(c.status, 200, J(c.body)); assert.equal(c.body["delivery"], "FAKE"); assert.equal(typeof c.body["fake_code"], "string");
  const v = await api("POST", "/ops/api/auth/verify", { email, code: c.body["fake_code"] });
  assert.equal(v.status, 200, J(v.body)); assert.equal(typeof v.body["token"], "string");
  return v.body["token"] as string;
}
async function enrol(p: { email: string; password: string }): Promise<string> {
  const token = await codeToken(p.email);
  const r = await api("POST", "/ops/api/auth/password", { token, password: p.password });
  assert.equal(r.status, 200, J(r.body)); assert.equal(r.body["enrolled"], true);
  return r.body["staff_user_id"] as string;
}
async function signIn(p: { email: string; password: string }, role: string): Promise<Session> {
  await codeToken(p.email);
  const r = await api("POST", "/ops/api/auth/signin", { email: p.email, password: p.password });
  assert.equal(r.status, 200, J(r.body)); assert.deepEqual(r.body["roles"], [role]);
  return { token: r.body["token"] as string, session_id: r.body["session_id"] as string, staff_user_id: r.body["staff_user_id"] as string, role };
}
async function invite(admin: Session, p: { email: string; name: string }, roles: string[]): Promise<string> {
  const r = await api("POST", "/ops/api/staff/invite", { email: p.email, legal_name: p.name, roles }, admin);
  assert.equal(r.status, 200, J(r.body)); assert.equal(r.body["status"], "invited");
  return r.body["staff_user_id"] as string;
}
/** 33.1 T7's door: a code to the e-mail on file, verified — the session on the provisioned party (the first turn runs behind it). */
async function signInByCode(email: string, ip: string): Promise<{ token: string; party_id: string }> {
  const req = await bapi("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }, undefined, ip);
  assert.equal(req.status, 200, J(req.body)); assert.equal(req.body["delivery"], "FAKE");
  const v = await bapi("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, undefined, ip);
  assert.equal(v.status, 200, J(v.body)); await settle();
  return { token: v.body["token"] as string, party_id: (v.body["party"] as Json)["party_id"] as string };
}
/** 32.16's front door: an e-mail on file for no one and a password open the session at once; the organic application routes the turn to `intake`. */
async function signUp(email: string, password: string, ip: string): Promise<{ token: string; party_id: string }> {
  const v = await bapi("POST", "/v1/borrower/auth/account", { action: "create", email, password }, undefined, ip);
  assert.equal(v.status, 200, J(v.body)); assert.ok(v.body["token"], `a session, not a code: ${J(v.body)}`);
  await settle();
  return { token: v.body["token"] as string, party_id: (v.body["party"] as Json)["party_id"] as string };
}
const message = async (token: string, text: string): Promise<Reply & { reply: Json }> => { const r = await bapi("POST", "/v1/borrower/messages", { text }, token); await settle(); return { ...r, reply: (r.body["reply"] as Json) ?? {} }; };
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type ActionRow = { id: string; staff_user_id: string | null; session_id: string | null; route: string; method: string; subject_kind: string | null; subject_id: string | null; command: string | null; result: string; refusal_code: string | null };
/** The action log once it has caught up with every request sent (34.1 rule 4: one row per request, written after the answer is on the wire). */
async function actions(where = "", params: unknown[] = []): Promise<ActionRow[]> {
  for (let i = 0; i < 150 && (await count(`staff_actions`)) < sent.length; i++) await new Promise((r) => setTimeout(r, 20));
  return db.query<ActionRow>(`SELECT id::text AS id, staff_user_id::text AS staff_user_id, session_id::text AS session_id, route, method, subject_kind, subject_id, command, result, refusal_code FROM staff_actions ${where} ORDER BY at, created_at, id`, params);
}
type EventRow = { id: string; loan_id: string | null; actor_kind: string; actor_id: string; actor_role: string | null; payload: Json; occurred_at: string };
const events = async (type: string, where = "", params: unknown[] = []): Promise<EventRow[]> => db.query<EventRow>(`SELECT id::text AS id, loan_id::text AS loan_id, actor_kind::text AS actor_kind, actor_id, actor_role, payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 ${where} ORDER BY sequence`, [type, ...params]);
type DecisionRow = { id: string; agent: string; action: string; subject_kind: string | null; subject_id: string | null; loan_id: string | null; rationale: string; approved_by: string | null; approved_role: string | null; rule_set_version: string; model_version: string | null; prompt_version: string | null; confidence: string | null };
const DECISION_COLS = `id::text AS id, agent, action, subject_kind, subject_id, loan_id::text AS loan_id, rationale, approved_by, approved_role, rule_set_version, model_version, prompt_version, confidence::text AS confidence`;
/** The one decision a controls act recorded: the bus answers its ids in `decisions` (its `decisionId` is the sentinel "queued" — src/app/commands.ts). */
const decisionIdOf = (body: Json): string => { const ds = body["decisions"] as Json[]; assert.ok(Array.isArray(ds) && ds.length === 1, `one decision: ${J(body["decisions"])}`); assert.equal(body["decisionId"], "queued"); return String(ds[0]!["id"]); };
const decision = async (id: unknown): Promise<DecisionRow> => { assert.equal(typeof id, "string", "a decision id"); const r = (await db.query<DecisionRow>(`SELECT ${DECISION_COLS} FROM agent_decisions WHERE id = $1`, [id]))[0]; assert.ok(r, `decision ${id}`); return r; };
const sentinelDecisions = (): Promise<DecisionRow[]> => db.query<DecisionRow>(`SELECT ${DECISION_COLS} FROM agent_decisions WHERE agent = $1 ORDER BY created_at, id`, [CONTROLS_AGENT]);
/** The decision record of the `compliance-sentinel` agent (the spec's schema), as the rationale text of the row. */
const record = (d: DecisionRow): Json => JSON.parse(d.rationale) as Json;
const flagOf = async (key: string): Promise<unknown> => (await db.query<{ value: unknown }>(`SELECT value FROM feature_flags WHERE key = $1`, [key]))[0]?.value;
/**
 * T6's contract, kept independently of the module's own probe: the ledger (every line's amount, every set) and every money column
 * the portal could reach — loans, loan_terms, the partner-book facts, the escrow accounts — hashed in one string. A wrong column name
 * here fails the query, never hides a change.
 */
async function moneyFingerprint(): Promise<string> {
  const probes = [
    `SELECT count(*)::text AS n, coalesce(sum(amount_cents), 0)::text AS sum, md5(coalesce(string_agg(id::text || ':' || set_id::text || ':' || amount_cents::text || ':' || account, ',' ORDER BY id), '')) AS h FROM ledger_lines`,
    `SELECT count(*)::text AS n, md5(coalesce(string_agg(id::text || ':' || effective_date::text || ':' || coalesce(reverses_set_id::text, ''), ',' ORDER BY id), '')) AS h FROM ledger_entry_sets`,
    `SELECT count(*)::text AS n, md5(coalesce(string_agg(id::text || ':' || original_upb_cents::text || ':' || status::text, ',' ORDER BY id), '')) AS h FROM loans`,
    `SELECT count(*)::text AS n, md5(coalesce(string_agg(id::text || ':' || coalesce(note_rate_bps::text, '') || ':' || coalesce(pi_cents::text, '') || ':' || coalesce(escrow_payment_cents::text, '') || ':' || coalesce(deferred_principal_cents::text, '') || ':' || coalesce(late_charge_max_cents::text, ''), ',' ORDER BY id), '')) AS h FROM loan_terms`,
    `SELECT count(*)::text AS n, md5(coalesce(string_agg(id::text || ':' || coalesce(facts->>'upb_cents', '') || ':' || coalesce(facts->>'pi_cents', '') || ':' || coalesce(facts->>'ti_cents', '') || ':' || coalesce(facts->>'note_rate_pct', '') || ':' || coalesce(facts->>'escrow_balance_cents', ''), ',' ORDER BY id), '')) AS h FROM partner_book_facts`,
    `SELECT count(*)::text AS n, md5(coalesce(string_agg(id::text || ':' || coalesce(shortage_cents::text, '') || ':' || coalesce(surplus_cents::text, '') || ':' || coalesce(monthly_escrow_payment_cents::text, ''), ',' ORDER BY id), '')) AS h FROM escrow_accounts`,
  ];
  const parts: string[] = [];
  for (const sql of probes) parts.push(J((await db.query<Json>(sql))[0]));
  return sha256hex(parts.join("\n"));
}
const byCode = (rows: readonly Json[]): Record<string, number> => { const out: Record<string, number> = {}; for (const r of rows) out[String(r["code"])] = (out[String(r["code"])] ?? 0) + 1; return out; };

// what the earlier tests leave for the later ones (the file runs in spec order)
let reminderTimerId = ""; let failedMessageId = ""; let organic: { token: string; party_id: string } | undefined;

test("34.4-T1: Given breached and armed clocks on the fixture book (the invitation reminders, the review clock), when an `ops_analyst` opens the clocks view, then each lists its code, subject, due date, severity and breach role, and no route exists that changes a timer row (contract test: every `/ops/api/controls/timers*` route is `GET`).", { skip }, async () => {
  const view = await api("GET", "/ops/api/controls/timers", undefined, oli);
  assert.equal(view.status, 200, J(view.body).slice(0, 400));
  const timers = view.body["timers"] as Json[]; const counts = view.body["counts"] as Json;
  assert.equal(view.body["as_of"], NOW); assert.deepEqual(view.body["filter"], { status: "open", code: null, subject: null, due_before: null });
  // the engine's clocks at the 09-16 sweep: thirteen breached — the eleven reminders (one per invited homeowner), the partner's late tape (33.1 rule 8) and the stale rate sheet (armed by the 09-01 seed)
  const breached = timers.filter((t) => t["status"] === "breached"); const armed = timers.filter((t) => t["status"] === "armed");
  assert.deepEqual(byCode(breached), { [REMINDER]: 11, [TAPE_CLOCK]: 1, [SHEET_CLOCK]: 1 });
  assert.equal(counts["breached"], 13); assert.equal(counts["armed"], armed.length); assert.equal(timers.length, breached.length + armed.length, "the default view is every open clock: armed and breached");
  assert.ok(armed.length >= 5, J(byCode(armed)));
  // loan 1's reminder: code, subject, due date, the registry's severity and breach role, the events that armed it and would satisfy it
  const reminder = timers.find((t) => t["code"] === REMINDER && t["loan_id"] === loan1Id); assert.ok(reminder, "loan 1's reminder clock"); reminderTimerId = String(reminder["timer_id"]);
  assert.deepEqual([reminder["status"], reminder["subject_kind"], reminder["subject_id"], reminder["due_date"], reminder["severity"], reminder["breach_role"], reminder["escalate_to"], reminder["process"], reminder["kind"]], ["breached", "loan", loan1Id, "2026-09-15", 3, "portfolio", ["portfolio"], "33.1", "deadline"]);
  assert.match(String(reminder["due_at"]), /^2026-09-16 03:59:00/, "end of the due day in America/New_York"); assert.ok(reminder["breached_at"]); assert.equal(reminder["satisfied_at"], null); assert.equal(reminder["due"], false);
  assert.match(String(reminder["armed_by"]), /partner_book\.invitation\.sent/); assert.match(String(reminder["satisfied_by"]), /partner_book\.account\.activated/); assert.match(String(reminder["breach"]), /reminder/);
  assert.equal((reminder["arming_event"] as Json)["type"], "partner_book.invitation.sent"); assert.equal(reminder["satisfying_event"], null);
  assert.equal(breached.filter((t) => t["code"] === REMINDER).every((t) => t["due_date"] === "2026-09-15" && t["severity"] === 3 && t["breach_role"] === "portfolio" && t["subject_kind"] === "loan"), true);
  // the review clock (33.2), armed by this morning's run for tomorrow 07:00 ET; the readiness clock beside it; the late-tape clock breached to the analyst
  const review = timers.find((t) => t["code"] === REVIEW_CLOCK); assert.ok(review, "the daily review clock");
  assert.deepEqual([review["status"], review["due"], review["due_date"], review["severity"], review["breach_role"], review["process"], review["kind"], review["satisfied_at"]], ["armed", false, "2026-09-17", 3, "compliance-sentinel", "33.2", "recurring", null]);
  assert.match(String(review["due_at"]), /^2026-09-17 11:00:00/); assert.match(String(review["armed_by"]), /partner_book\.review\.run_completed/); assert.equal((review["arming_event"] as Json)["type"], "partner_book.review.run_completed"); assert.equal(String(review["subject_id"]).length > 0, true);
  const readiness = timers.find((t) => t["code"] === READINESS_CLOCK); assert.ok(readiness); assert.deepEqual([readiness["status"], readiness["due_date"], readiness["severity"], readiness["breach_role"], readiness["process"]], ["armed", "2026-09-17", 3, "compliance-sentinel", "33.3"]);
  const late = timers.find((t) => t["code"] === TAPE_CLOCK); assert.ok(late); assert.deepEqual([late["status"], late["due_date"], late["severity"], late["breach_role"], late["process"]], ["breached", "2026-09-08", 3, "ops_analyst", "33.1"]);
  // every listed clock names its code, subject, due date, severity and breach role — the severity and the role exactly as the registry the sweep uses carries them (null severity where the registry has none: an expiry deadline, a not-before gate; the breach role the sweep's default then)
  const registry = runtime.registry;
  for (const t of timers) {
    assert.match(String(t["timer_id"]), UUID_RE); assert.equal(typeof t["code"], "string"); assert.equal(typeof t["subject_kind"], "string"); assert.equal(typeof t["subject_id"], "string");
    for (const k of ["due_date", "due_at", "severity", "breach_role", "armed_at", "anchor_date", "armed_by", "satisfied_by"]) assert.ok(k in t, `${t["code"]} lists ${k}`);
    const def = registry.get(String(t["code"])); assert.ok(def, `${t["code"]} is a registry clock`);
    assert.equal(t["severity"], def.severity.level ?? null, `${t["code"]}: the registry's severity`); assert.equal(t["breach_role"], def.severity.escalateTo[0] ?? "ops_analyst", `${t["code"]}: the registry's breach role`); assert.equal(t["process"], def.process);
  }
  for (const t of timers.filter((x) => [REMINDER, REVIEW_CLOCK, READINESS_CLOCK, TAPE_CLOCK, SHEET_CLOCK].includes(String(x["code"])))) { assert.equal(typeof t["severity"], "number", `${t["code"]}: the fixture book's clocks carry a severity`); assert.equal(typeof t["breach_role"], "string"); assert.ok(t["due_date"] && t["due_at"], `${t["code"]}: a due date`); }
  assert.ok(breached.every((t) => t["breached_at"] !== null) && armed.every((t) => t["breached_at"] === null));
  // the filters: status, code, subject (a loan id), due_before
  const onlyBreached = await api("GET", "/ops/api/controls/timers?status=breached", undefined, oli); assert.equal(onlyBreached.status, 200); assert.equal((onlyBreached.body["timers"] as Json[]).length, 13); assert.ok((onlyBreached.body["timers"] as Json[]).every((t) => t["status"] === "breached"));
  const byReminder = await api("GET", `/ops/api/controls/timers?code=${REMINDER}&status=all`, undefined, oli); assert.equal((byReminder.body["timers"] as Json[]).length, 11); assert.ok((byReminder.body["timers"] as Json[]).every((t) => t["code"] === REMINDER));
  const bySubject = await api("GET", `/ops/api/controls/timers?subject=${loan1Id}&status=all`, undefined, oli); const mine = bySubject.body["timers"] as Json[]; assert.ok(mine.length >= 1 && mine.some((t) => t["timer_id"] === reminderTimerId)); assert.ok(mine.every((t) => t["loan_id"] === loan1Id || t["subject_id"] === loan1Id), J(mine.map((t) => [t["code"], t["loan_id"]])));
  const dueBefore = await api("GET", "/ops/api/controls/timers?due_before=2026-09-16T12:00:00Z&status=all", undefined, oli); const early = dueBefore.body["timers"] as Json[]; assert.ok(early.some((t) => t["timer_id"] === reminderTimerId)); assert.ok(!early.some((t) => t["code"] === REVIEW_CLOCK), "tomorrow's review clock is not due before noon today");
  const bad = await api("GET", "/ops/api/controls/timers?due_before=not-a-date", undefined, oli); assert.equal(bad.status, 400, J(bad.body));
  // one clock with its history: the timer.armed and timer.breached events that carry its id — a read the action log records against the clock (T5 finds it among loan 1's staff actions)
  const one = await api("GET", `/ops/api/controls/timers/${reminderTimerId}`, undefined, oli);
  assert.equal(one.status, 200, J(one.body)); assert.equal(one.body["timer_id"], reminderTimerId); assert.equal(one.body["code"], REMINDER);
  const history = one.body["history"] as Json[]; assert.deepEqual(history.map((h) => h["type"]), ["timer.armed", "timer.breached"]); assert.ok(history.every((h) => (h["payload"] as Json)["timer_id"] === reminderTimerId));
  assert.equal((await api("GET", `/ops/api/controls/timers/${randomUUID()}`, undefined, oli)).status, 404);
  // the admin sees the clocks too (a read); the compliance user too
  assert.equal((await api("GET", "/ops/api/controls/timers?status=breached", undefined, cara)).status, 200); assert.equal((await api("GET", "/ops/api/controls/timers?status=breached", undefined, ada)).status, 200);
  // the contract: every /ops/api/controls/timers* route the console mounts is GET (the table the console serves, built from the core module's own)
  const table = section34RouteTable(runtime); const mounted = table.filter((r) => r.path.startsWith("/ops/api/controls/timers"));
  assert.deepEqual(mounted.map((r) => `${r.method} ${r.path}`), ["GET /ops/api/controls/timers", "GET /ops/api/controls/timers/:id"]);
  assert.ok(mounted.every((r) => r.method === "GET" && r.command === null), J(mounted));
  assert.equal(table.filter((r) => r.section === "34.4" && r.method !== "GET" && r.path.includes("timers")).length, 0);
  // and on the wire: a write to a timer path answers no route (404 / 405) and changes nothing — the row, the timer events, the count of clocks
  const rowBefore = await db.query<Json>(`SELECT status::text AS status, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at, cancelled_reason, note FROM timers WHERE id = $1`, [reminderTimerId]);
  const timerEventsBefore = await count(`loan_events WHERE type LIKE 'timer.%'`); const timersBefore = await count(`timers`);
  const writes: [string, string, unknown][] = [
    ["POST", "/ops/api/controls/timers", { code: REMINDER, subject_id: loan1Id, due_date: "2026-12-31" }],
    ["POST", `/ops/api/controls/timers/${reminderTimerId}`, { status: "satisfied" }],
    ["POST", `/ops/api/controls/timers/${reminderTimerId}/satisfy`, { reason: "x" }],
    ["POST", `/ops/api/controls/timers/${reminderTimerId}/cancel`, { reason: "x" }],
    ["POST", `/ops/api/controls/timers/${reminderTimerId}/extend`, { due_date: "2026-12-31" }],
    ["PUT", `/ops/api/controls/timers/${reminderTimerId}`, { status: "satisfied" }],
    ["PATCH", `/ops/api/controls/timers/${reminderTimerId}`, { due_date: "2026-12-31" }],
    ["DELETE", `/ops/api/controls/timers/${reminderTimerId}`, undefined],
  ];
  for (const [method, path, body] of writes) { const r = await api(method, path, body, oli); assert.ok(r.status === 404 || r.status === 405, `${method} ${path} must answer no route: ${r.status} ${J(r.body)}`); }
  // the bus tool behind the view is a read: an instruction to satisfy, extend or cancel a clock is NO_CLOCK_EDIT
  const cancel = await api("POST", "/ops/api/tools/34.4/controls.timers", { input: { op: "cancel", timer_id: reminderTimerId } }, oli); assert.equal(cancel.status, 409, J(cancel.body)); assert.equal(cancel.body["code"], "NO_CLOCK_EDIT");
  const extend = await api("POST", "/ops/api/tools/34.4/controls.timers", { input: { extend: true, timer_id: reminderTimerId, new_due_date: "2026-12-31" } }, oli); assert.equal(extend.status, 409); assert.equal(extend.body["code"], "NO_CLOCK_EDIT");
  const tool = await api("POST", "/ops/api/tools/34.4/controls.timers", { input: { status: "breached" } }, oli); assert.equal(tool.status, 200, J(tool.body).slice(0, 300)); assert.equal(((tool.body["output"] as Json)["timers"] as Json[]).length, 13); assert.equal(tool.body["decisionId"], null, "a read records no decision");
  assert.deepEqual(await db.query<Json>(`SELECT status::text AS status, due_date::text AS due_date, due_at::text AS due_at, satisfied_at::text AS satisfied_at, breached_at::text AS breached_at, cancelled_reason, note FROM timers WHERE id = $1`, [reminderTimerId]), rowBefore, "the timer row is untouched");
  assert.equal(await count(`loan_events WHERE type LIKE 'timer.%'`), timerEventsBefore, "no timer event"); assert.equal(await count(`timers`), timersBefore, "no clock added or removed");
});

test("34.4-T2: Given an open `ops_analyst` escalation, when the analyst completes it with a disposition and a reason, then the owning section's completion ran with `actor = {human, <staff_user_id>, ops_analyst}`, `escalation.completed` is logged and the decision record carries the reason; given a `compliance` escalation and an `ops_analyst` session, then `ROLE_REQUIRED{compliance}`.", { skip }, async () => {
  // the open ops_analyst escalation the fixture yields: the late-tape clock's breach (33.1 rule 8 — the partner's next tape was expected 2026-09-08); 33.1 owns no completion command, so its completion is the row's (the spec's edge case)
  const list = await api("GET", "/ops/api/controls/escalations?status=open&role=ops_analyst", undefined, oli);
  assert.equal(list.status, 200, J(list.body).slice(0, 300));
  const open = list.body["escalations"] as Json[]; assert.ok(open.every((e) => e["owner_role"] === "ops_analyst" && e["status"] === "open"));
  const late = open.find((e) => (e["payload"] as Json)["timer_code"] === TAPE_CLOCK); assert.ok(late, `the late-tape escalation among ${J(open.map((e) => [e["kind"], (e["payload"] as Json)["timer_code"]]))}`);
  assert.deepEqual([late["kind"], late["severity"], late["completion"], late["dispositions"], late["disposition"], late["completed_by"], late["opened_by"]], ["sev3", "3", "row", ["resolved", "dismissed", "referred"], null, null, "system:sweep"]);
  const lateId = String(late["id"]); assert.match(lateId, UUID_RE);
  // a compliance escalation, opened the way the platform opens one (34.1 rule 1): Pat's five wrong passwords lock the account and open it
  patId = await invite(ada, PAT, ["ops_analyst"]); assert.equal(await enrol(PAT), patId);
  for (let i = 1; i <= STAFF_LOCK_AFTER_FAILURES; i++) { const r = await api("POST", "/ops/api/auth/signin", { email: PAT.email, password: `wrong-password-${i}-${R}` }); assert.equal(r.status, 401, J(r.body)); }
  const [theirs] = await db.query<{ id: string }>(`SELECT id::text AS id FROM escalations WHERE owner_role = 'compliance' AND payload->>'staff_user_id' = $1 AND completed_at IS NULL`, [patId]);
  assert.ok(theirs, "the compliance escalation of the lock");
  // the analyst's session on the compliance escalation: 403 ROLE_REQUIRED{compliance} before any write
  const eventsBefore = await count(`loan_events`); const decisionsBefore = await count(`agent_decisions`);
  const denied = await api("POST", `/ops/api/controls/escalations/${theirs.id}/complete`, { disposition: "resolved", reason: "not mine" }, oli);
  assert.equal(denied.status, 403, J(denied.body)); assert.equal(denied.body["code"], "ROLE_REQUIRED"); assert.equal(denied.body["role"], "compliance"); assert.deepEqual(denied.body["held"], ["ops_analyst"]);
  assert.equal(await count(`escalations WHERE id = $1 AND completed_at IS NULL`, [theirs.id]), 1, "still open"); assert.equal((await events("escalation.completed", "AND payload->>'escalation_id' = $2", [theirs.id])).length, 0);
  assert.equal(await count(`loan_events`), eventsBefore, "no event"); assert.equal(await count(`agent_decisions`), decisionsBefore, "no decision");
  // the disposition is one of the escalation's own set; a reason is required
  const badDisposition = await api("POST", `/ops/api/controls/escalations/${lateId}/complete`, { disposition: "approved", reason: "x" }, oli); assert.equal(badDisposition.status, 400, J(badDisposition.body)); assert.equal(badDisposition.body["code"], "DISPOSITION_REQUIRED"); assert.deepEqual(badDisposition.body["dispositions"], ["resolved", "dismissed", "referred"]);
  const noReason = await api("POST", `/ops/api/controls/escalations/${lateId}/complete`, { disposition: "resolved", reason: "   " }, oli); assert.equal(noReason.status, 400); assert.equal(noReason.body["code"], "REASON_REQUIRED");
  assert.equal(await count(`escalations WHERE id = $1 AND completed_at IS NULL`, [lateId]), 1);
  // the analyst completes the ops_analyst escalation with a disposition and a reason
  const reason = `the partner's September tape reached the SFTP drop this morning; the book reloads on the upload (${R})`;
  const done = await api("POST", `/ops/api/controls/escalations/${lateId}/complete`, { disposition: "resolved", reason }, oli);
  assert.equal(done.status, 200, J(done.body));
  assert.deepEqual(done.body["actor"], { kind: "human", id: oli.staff_user_id, role: "ops_analyst" });
  const out = done.body["output"] as Json;
  assert.deepEqual([out["escalation_id"], out["via"], out["disposition"], out["reason"], out["completed_by"], out["completed_by_role"], out["owner_role"]], [lateId, "row", "resolved", reason, oli.staff_user_id, "ops_analyst", "ops_analyst"]); assert.equal(Date.parse(String(out["completed_at"])), Date.parse(clock.now()), "completed now");
  assert.ok((done.body["events"] as string[]).includes("command.executed"), J(done.body["events"])); assert.ok((out["events"] as string[]).includes("escalation.completed"), J(out["events"]));
  // the row completed; the receipt is logged with the person as actor
  const [row] = await db.query<{ status: string; completed_at: string | null }>(`SELECT status, completed_at::text AS completed_at FROM escalations WHERE id = $1`, [lateId]); assert.equal(row!.status, "completed"); assert.ok(row!.completed_at);
  const receipt = await events("escalation.completed", "AND payload->>'escalation_id' = $2", [lateId]);
  assert.equal(receipt.length, 1); assert.deepEqual([receipt[0]!.actor_kind, receipt[0]!.actor_id, receipt[0]!.actor_role], ["human", oli.staff_user_id, "ops_analyst"]);
  assert.deepEqual([receipt[0]!.payload["disposition"], receipt[0]!.payload["reason"], receipt[0]!.payload["by"], receipt[0]!.payload["completed_by_role"], receipt[0]!.payload["owner_role"], receipt[0]!.payload["via"]], ["resolved", reason, oli.staff_user_id, "ops_analyst", "ops_analyst", "controls.escalation.complete"]);
  // the completion command ran on the bus as the person: command.executed{command: controls.escalation.complete, process: 34.4} with actor = {human, <staff_user_id>, ops_analyst}
  const executed = (await events("command.executed")).filter((e) => e.payload["command"] === "controls.escalation.complete" && e.actor_id === oli.staff_user_id);
  assert.equal(executed.length, 1); assert.deepEqual([executed[0]!.actor_kind, executed[0]!.actor_role, executed[0]!.payload["process"], executed[0]!.payload["agent"], executed[0]!.payload["decision_recorded"]], ["human", "ops_analyst", "34.4", CONTROLS_AGENT, true]);
  // the decision record carries the reason (the spec's schema), approved by the person under their role
  const d = await decision(decisionIdOf(done.body));
  assert.deepEqual([d.agent, d.action, d.subject_kind, d.subject_id, d.approved_by, d.approved_role, d.rule_set_version, d.model_version, d.prompt_version, Number(d.confidence)], [CONTROLS_AGENT, "controls.escalation.complete", "escalation", lateId, oli.staff_user_id, "ops_analyst", CONTROLS_RULE_SET_VERSION, CONTROLS_MODEL_VERSION, CONTROLS_PROMPT_VERSION, 1]);
  assert.deepEqual(record(d), { subject: { kind: "escalation", id: lateId }, action: "controls.escalation.complete", disposition: "resolved", reason, by: oli.staff_user_id, by_role: "ops_analyst", rule_set_version: "controls.v1", model_version: "deterministic", prompt_version: "34.4-v1", confidence: 1 });
  // the list reads it back completed, with who and why; a second completion is refused
  const completed = await api("GET", "/ops/api/controls/escalations?status=completed&role=ops_analyst", undefined, oli);
  const mine = (completed.body["escalations"] as Json[]).find((e) => e["id"] === lateId); assert.ok(mine); assert.deepEqual([mine["status"], mine["completed_by"], mine["completed_by_role"], mine["disposition"], mine["reason"]], ["completed", oli.staff_user_id, "ops_analyst", "resolved", reason]);
  const again = await api("POST", `/ops/api/controls/escalations/${lateId}/complete`, { disposition: "resolved", reason: "again" }, oli); assert.equal(again.status, 409, J(again.body)); assert.equal(again.body["code"], "ALREADY_COMPLETED");
  // the compliance user completes the compliance escalation the same way — their role, their name on the receipt
  const c = await api("POST", `/ops/api/controls/escalations/${theirs.id}/complete`, { disposition: "referred", reason: `the lock lapsed; the account owner confirmed the attempts were theirs (${R})` }, cara);
  assert.equal(c.status, 200, J(c.body)); assert.deepEqual([(c.body["output"] as Json)["completed_by"], (c.body["output"] as Json)["completed_by_role"], (c.body["output"] as Json)["via"]], [cara.staff_user_id, "compliance", "row"]);
  const cr = await events("escalation.completed", "AND payload->>'escalation_id' = $2", [theirs.id]); assert.equal(cr.length, 1); assert.deepEqual([cr[0]!.actor_id, cr[0]!.actor_role, cr[0]!.payload["disposition"]], [cara.staff_user_id, "compliance", "referred"]);
  assert.equal(record(await decision(decisionIdOf(c.body)))["by"], cara.staff_user_id);
});

test("34.4-T3: Given a failed outbox message, when it is requeued three times by hand, then each requeue is logged with the actor and the message is `queued`; the fourth attempt is refused `REQUEUE_CAP_3` and an `ops_analyst` escalation exists.", { skip }, async () => {
  // the FAKE print/mail adapter's message for a notice of loan 1, failed by the vendor (the same row the sweep's outbox pass retries)
  const ERROR = "FAKE print-mail: SFTP handshake failed";
  failedMessageId = (await db.query<{ id: string }>(`INSERT INTO integration_messages (adapter, direction, idempotency_key, status, error, attempts, last_attempt_at, loan_id, payload_summary) VALUES ('print-mail', 'out', $1, 'failed', $2, 1, $3::timestamptz, $4, '{"kind": "notice", "vendor": "FAKE"}'::jsonb) RETURNING id::text AS id`, [`notice:${R}:${loan1Id}`, ERROR, NOW, loan1Id]))[0]!.id;
  const id = failedMessageId;
  /** The FAKE vendor fails the delivery again (what the sweep's outbox pass records when the adapter throws): the row back to failed. */
  const failAgain = (): Promise<unknown> => db.query(`UPDATE integration_messages SET status = 'failed', error = $2, attempts = attempts + 1, last_attempt_at = $3::timestamptz WHERE id = $1`, [id, ERROR, clock.now()]);
  const rowOf = async (): Promise<{ status: string; attempts: number; error: string | null; next_attempt_at: string | null }> => (await db.query<{ status: string; attempts: number; error: string | null; next_attempt_at: string | null }>(`SELECT status, attempts, error, next_attempt_at::text AS next_attempt_at FROM integration_messages WHERE id = $1`, [id]))[0]!;
  // the outbox view lists it failed, with no hand requeue yet
  const view = await api("GET", "/ops/api/controls/outbox?adapter=print-mail&status=failed", undefined, oli);
  assert.equal(view.status, 200, J(view.body).slice(0, 300));
  const listed = (view.body["messages"] as Json[]).find((m) => m["id"] === id); assert.ok(listed, "the failed message on the outbox view");
  assert.deepEqual([listed["adapter"], listed["status"], listed["error"], listed["loan_id"], listed["requeues"], listed["requeues_left"], listed["requeued_by"], listed["cap_escalation_id"]], ["print-mail", "failed", ERROR, loan1Id, 0, REQUEUE_CAP, [], null]);
  assert.ok((view.body["by_adapter"] as Json[]).some((b) => b["adapter"] === "print-mail" && b["status"] === "failed" && b["count"] === 1));
  // three hand requeues: each logged with the actor, the message queued; the FAKE vendor fails it again between them
  for (let n = 1; n <= REQUEUE_CAP; n++) {
    const reason = `hand requeue ${n} (${R})`;
    const r = await api("POST", `/ops/api/controls/outbox/${id}/requeue`, { reason }, oli);
    assert.equal(r.status, 200, `requeue ${n}: ${J(r.body)}`);
    const o = r.body["output"] as Json;
    assert.deepEqual([o["message_id"], o["adapter"], o["status"], o["requeue_no"], o["requeues_left"], o["by"], o["by_role"], o["at"]], [id, "print-mail", "queued", n, REQUEUE_CAP - n, oli.staff_user_id, "ops_analyst", clock.now()]);
    assert.deepEqual(r.body["actor"], { kind: "human", id: oli.staff_user_id, role: "ops_analyst" }); assert.deepEqual(r.body["events"], ["command.executed"], "the bus's own receipt; the outbox.requeued receipt is on the log below"); assert.match(String(o["event_id"]), UUID_RE);
    const row = await rowOf(); assert.deepEqual([row.status, row.attempts, row.error], ["queued", 0, null]); assert.ok(row.next_attempt_at, "due for the next sweep");
    const receipts = await events("outbox.requeued", "AND payload->>'message_id' = $2", [id]);
    assert.equal(receipts.length, n); const last = receipts[n - 1]!;
    assert.deepEqual([last.actor_kind, last.actor_id, last.actor_role, last.loan_id], ["human", oli.staff_user_id, "ops_analyst", loan1Id]);
    assert.deepEqual([last.payload["message_id"], last.payload["adapter"], last.payload["from_status"], last.payload["requeue_no"], last.payload["cap"], last.payload["by"], last.payload["by_role"], last.payload["reason"]], [id, "print-mail", "failed", n, REQUEUE_CAP, oli.staff_user_id, "ops_analyst", reason]);
    const d = await decision(decisionIdOf(r.body)); assert.deepEqual([d.action, d.subject_kind, d.subject_id, d.approved_by, d.approved_role], ["controls.outbox.requeue", "integration_message", id, oli.staff_user_id, "ops_analyst"]); assert.equal(record(d)["by"], oli.staff_user_id); assert.equal(record(d)["reason"], reason);
    const shown = await api("GET", `/ops/api/controls/outbox/${id}`, undefined, oli); assert.equal(shown.body["requeues"], n); assert.equal(shown.body["status"], "queued"); assert.ok((shown.body["requeued_by"] as Json[]).every((x) => x["by"] === oli.staff_user_id && x["role"] === "ops_analyst"));
    // a queued message is not requeued again by hand — it is the sweep's (rule 3 counts hand requeues of a failed or dead message); after the third, any hand attempt is the fourth whatever the status
    if (n < REQUEUE_CAP) { const queued = await api("POST", `/ops/api/controls/outbox/${id}/requeue`, {}, oli); assert.equal(queued.status, 409, J(queued.body)); assert.equal(queued.body["code"], "NOT_REQUEUEABLE"); }
    await failAgain();
  }
  assert.deepEqual((await events("outbox.requeued", "AND payload->>'message_id' = $2", [id])).map((e) => e.payload["requeue_no"]), [1, 2, 3]);
  // the fourth attempt: refused REQUEUE_CAP_3; the row untouched; one ops_analyst escalation instead
  const escalationsBefore = await count(`escalations`); const untouched = await rowOf(); assert.equal(untouched.status, "failed");
  const fourth = await api("POST", `/ops/api/controls/outbox/${id}/requeue`, { reason: "once more" }, oli);
  assert.equal(fourth.status, 409, J(fourth.body)); assert.equal(fourth.body["code"], "REQUEUE_CAP_3"); assert.equal(fourth.body["message_id"], id); assert.equal(fourth.body["requeues"], 3);
  const escalationId = String(fourth.body["escalation_id"]); assert.match(escalationId, UUID_RE);
  assert.deepEqual(await rowOf(), untouched, "the row is untouched: still failed");
  assert.equal((await events("outbox.requeued", "AND payload->>'message_id' = $2", [id])).length, 3, "no fourth receipt");
  assert.equal(await count(`escalations`), escalationsBefore + 1);
  const [esc] = await db.query<{ owner_role: string; kind: string; severity: string; loan_id: string | null; completed_at: string | null; opened_by: string; payload: Json }>(`SELECT owner_role, kind, severity, loan_id::text AS loan_id, completed_at::text AS completed_at, opened_by, payload FROM escalations WHERE id = $1`, [escalationId]);
  assert.ok(esc, "the escalation row"); assert.deepEqual([esc.owner_role, esc.kind, esc.severity, esc.loan_id, esc.completed_at, esc.opened_by], ["ops_analyst", "sev4", "4", loan1Id, null, `human:${oli.staff_user_id}`]);
  assert.deepEqual([esc.payload["code"], esc.payload["message_id"], esc.payload["adapter"], esc.payload["requeues"], esc.payload["attempted_by"], esc.payload["attempted_role"]], ["REQUEUE_CAP_3", id, "print-mail", 3, oli.staff_user_id, "ops_analyst"]);
  const created = (await events("escalation.created", "AND payload->>'escalation_id' = $2", [escalationId])); assert.equal(created.length, 1); assert.deepEqual([created[0]!.actor_id, created[0]!.payload["code"], created[0]!.payload["owner_role"]], [oli.staff_user_id, "REQUEUE_CAP_3", "ops_analyst"]);
  assert.equal((await sentinelDecisions()).filter((d) => d.subject_id === id).length, 3, "no decision for the refused attempt");
  // the escalation is on the escalations view; the message names it; a fifth attempt names the same one
  const openList = await api("GET", "/ops/api/controls/escalations?status=open&role=ops_analyst", undefined, oli);
  const onView = (openList.body["escalations"] as Json[]).find((e) => e["id"] === escalationId); assert.ok(onView, "the cap escalation on the view"); assert.equal((onView["payload"] as Json)["message_id"], id); assert.equal(onView["completion"], "row");
  const shown = await api("GET", `/ops/api/controls/outbox/${id}`, undefined, oli); assert.deepEqual([shown.body["status"], shown.body["requeues"], shown.body["requeues_left"], shown.body["cap_escalation_id"]], ["failed", 3, 0, escalationId]);
  const fifth = await api("POST", `/ops/api/controls/outbox/${id}/requeue`, {}, oli); assert.equal(fifth.status, 409); assert.equal(fifth.body["code"], "REQUEUE_CAP_3"); assert.equal(fifth.body["escalation_id"], escalationId);
  assert.equal(await count(`escalations WHERE payload->>'message_id' = $1`, [id]), 1, "one escalation per message");
  // the route is the analyst's (and the officer's): the compliance session is 403 ROLE_REQUIRED before any write; an unknown message is 404
  const denied = await api("POST", `/ops/api/controls/outbox/${id}/requeue`, {}, cara); assert.equal(denied.status, 403, J(denied.body)); assert.equal(denied.body["code"], "ROLE_REQUIRED"); assert.equal(denied.body["role"], "ops_analyst");
  assert.equal((await api("POST", `/ops/api/controls/outbox/${randomUUID()}/requeue`, {}, oli)).status, 404);
  // the action log: three ok rows naming the command and the message, the refused rows with their codes
  const rows = await actions(`WHERE route = $1`, [`/ops/api/controls/outbox/${id}/requeue`]);
  assert.equal(rows.filter((r) => r.result === "ok").length, 3); assert.ok(rows.filter((r) => r.result === "ok").every((r) => r.command === "controls.outbox.requeue" && r.subject_kind === "integration_message" && r.subject_id === id && r.staff_user_id === oli.staff_user_id && r.session_id === oli.session_id));
  assert.equal(rows.filter((r) => r.refusal_code === "REQUEUE_CAP_3").length, 2); assert.equal(rows.filter((r) => r.refusal_code === "NOT_REQUEUEABLE").length, REQUEUE_CAP - 1); assert.equal(rows.filter((r) => r.refusal_code === "ROLE_REQUIRED" && r.staff_user_id === cara.staff_user_id).length, 1);
});

test("34.4-T4: Given `compliance` requests the kill switch for `intake` with a reason, then nothing trips until an `admin` confirms the same request id within 10 minutes; once confirmed `ai.kill_switch.tripped{by, confirmed_by, reason}` is logged, the AI view shows it tripped, a borrower turn returns the placeholder (32.16 T-17-10), and the reset needs the same two people; an unconfirmed request expires at 10 minutes with nothing tripped.", { skip }, async () => {
  const t0 = clock.now();
  const KILL = "/ops/api/controls/ai/intake/kill"; const RESET = "/ops/api/controls/ai/intake/reset";
  const state = async (): Promise<{ view: Json; intake: Json }> => { const v = await api("GET", "/ops/api/controls/ai", undefined, cara); assert.equal(v.status, 200, J(v.body).slice(0, 300)); const intake = (v.body["agents"] as Json[]).find((a) => a["agent"] === "intake"); assert.ok(intake, "intake on the AI view"); return { view: v.body, intake }; };
  const turnsOf = (partyId: string): Promise<number> => count(`agent_turns WHERE party_id = $1`, [partyId]);
  // a homebuyer whose turns route to `intake` (32.16's front door opens an organic application); the model answers while the switch is armed
  organic = await signUp(`t4.homebuyer.${R}@example.test`, `pw-t4-homebuyer-${R}`, "10.34.4.40");
  const live = await message(organic.token, "is this thing on?");
  assert.equal(live.status, 200, J(live.body).slice(0, 300)); assert.equal(live.body["routed_to"], "intake"); assert.equal(live.reply["body_text"], PING_REPLY); assert.equal((live.reply["copy_tokens"] as Json)["source"], "agent_turn");
  // the AI view before: the systems with their versions and evaluations, the registry's agents, intake armed with no request pending
  const before = await state();
  assert.ok(Array.isArray(before.view["systems"]) && (before.view["systems"] as Json[]).some((s) => s["code"] === "refi-analyst" && Array.isArray(s["versions"])), "the ai_systems rows with their versions");
  assert.deepEqual([(before.intake["kill_switch"] as Json)["state"], before.intake["off"], before.intake["pending_request"]], ["armed", false, null]);
  assert.equal((before.view["requests"] as Json[]).length, 0);
  // the roles: the analyst is refused at the gate; the admin may confirm but not request (compliance requests) — nothing is logged
  const analyst = await api("POST", KILL, { reason: "x" }, oli); assert.equal(analyst.status, 403, J(analyst.body)); assert.equal(analyst.body["code"], "ROLE_REQUIRED"); assert.equal(analyst.body["role"], "compliance"); assert.deepEqual(analyst.body["held"], ["ops_analyst"]);
  const adminAsks = await api("POST", KILL, { reason: "x" }, ada); assert.equal(adminAsks.status, 403, J(adminAsks.body)); assert.equal(adminAsks.body["code"], "ROLE_REQUIRED"); assert.equal(adminAsks.body["role"], "compliance");
  const noReason = await api("POST", KILL, { reason: "" }, cara); assert.equal(noReason.status, 400, J(noReason.body)); assert.equal(noReason.body["code"], "REASON_REQUIRED");
  assert.equal((await events("ai.kill_switch.requested")).length, 0);
  // step one: compliance requests with a reason — a request, nothing trips
  const reason = `prompt 32.16-p7 answered a rate question with a figure on the thread; 18.1 rule D.5 (${R})`;
  const req = await api("POST", KILL, { reason }, cara);
  assert.equal(req.status, 200, J(req.body)); assert.deepEqual(req.body["actor"], { kind: "human", id: cara.staff_user_id, role: "compliance" });
  const r1 = req.body["output"] as Json; const requestId = String(r1["request_id"]); assert.match(requestId, UUID_RE);
  assert.deepEqual([r1["code"], r1["action"], r1["status"], r1["by"], r1["by_role"], r1["reason"], r1["requested_at"], r1["expires_at"], r1["confirmed_by"]], ["intake", "trip", "pending", cara.staff_user_id, "compliance", reason, t0, at(t0, KILL_CONFIRM_MINUTES * MIN), null]);
  const requested = await events("ai.kill_switch.requested"); assert.equal(requested.length, 1); assert.deepEqual([requested[0]!.actor_id, requested[0]!.actor_role, requested[0]!.payload["request_id"], requested[0]!.payload["code"], requested[0]!.payload["action"], requested[0]!.payload["by"], requested[0]!.payload["reason"], requested[0]!.payload["confirm_role"]], [cara.staff_user_id, "compliance", requestId, "intake", "trip", cara.staff_user_id, reason, "admin"]);
  assert.equal((await events("ai.kill_switch.tripped")).length, 0, "nothing trips on the request"); assert.notEqual(await flagOf("intake.enabled"), false); assert.equal(runtime.agents.aiState("intake").off, false);
  const pending = await state(); assert.equal((pending.intake["kill_switch"] as Json)["state"], "armed"); assert.equal((pending.intake["pending_request"] as Json)["request_id"], requestId); assert.equal((pending.intake["pending_request"] as Json)["status"], "pending");
  const stillLive = await message(organic.token, "is this thing on?"); assert.equal(stillLive.reply["body_text"], PING_REPLY, "the turn still runs: one person trips nothing");
  // the same request id: the requester cannot confirm (a confirmation is the admin's), a second request is refused while one is pending, an unknown id is 404
  const self = await api("POST", KILL, { request_id: requestId }, cara); assert.equal(self.status, 403, J(self.body)); assert.equal(self.body["code"], "ROLE_REQUIRED"); assert.equal(self.body["role"], "admin");
  const dup = await api("POST", KILL, { reason: "again" }, cara); assert.equal(dup.status, 409, J(dup.body)); assert.equal(dup.body["code"], "REQUEST_PENDING"); assert.equal(dup.body["request_id"], requestId);
  const unknown = await api("POST", KILL, { request_id: randomUUID() }, ada); assert.equal(unknown.status, 404, J(unknown.body)); assert.equal(unknown.body["code"], "NO_SUCH_REQUEST");
  assert.equal((await events("ai.kill_switch.tripped")).length, 0);
  // step two: the admin confirms the same request id four minutes later — 18.1's trip with both actors and the reason
  clock.set(at(t0, 4 * MIN));
  const conf = await api("POST", KILL, { request_id: requestId }, ada);
  assert.equal(conf.status, 200, J(conf.body)); assert.deepEqual(conf.body["actor"], { kind: "human", id: ada.staff_user_id, role: "admin" });
  const c1 = conf.body["output"] as Json;
  assert.deepEqual([c1["request_id"], c1["code"], c1["action"], c1["state"], c1["event"], c1["by"], c1["confirmed_by"], c1["reason"], c1["at"], c1["flag"]], [requestId, "intake", "trip", "tripped", "ai.kill_switch.tripped", cara.staff_user_id, ada.staff_user_id, reason, clock.now(), false]);
  assert.deepEqual(conf.body["events"], ["command.executed"]);
  const tripped = await events("ai.kill_switch.tripped"); assert.equal(tripped.length, 1);
  assert.deepEqual([tripped[0]!.actor_kind, tripped[0]!.actor_id, tripped[0]!.actor_role, tripped[0]!.occurred_at.slice(0, 19)], ["human", ada.staff_user_id, "admin", clock.now().replace("T", " ").slice(0, 19)]);
  assert.deepEqual([tripped[0]!.payload["code"], tripped[0]!.payload["request_id"], tripped[0]!.payload["by"], tripped[0]!.payload["by_role"], tripped[0]!.payload["confirmed_by"], tripped[0]!.payload["confirmed_by_role"], tripped[0]!.payload["reason"]], ["intake", requestId, cara.staff_user_id, "compliance", ada.staff_user_id, "admin", reason]);
  // 18.1's levers, both set: the feature flag `intake.enabled = false` the turn reads on every message, and the registry's AI-off state for the agent
  assert.equal(await flagOf("intake.enabled"), false); assert.equal(runtime.agents.aiState("intake").off, true); assert.match(runtime.agents.aiState("intake").why ?? "", /kill switch tripped by .* confirmed by/);
  // the AI view shows it tripped, by whom and confirmed by whom
  const on = await state(); const ks = on.intake["kill_switch"] as Json;
  assert.deepEqual([ks["state"], ks["by"], ks["confirmed_by"], ks["reason"], ks["request_id"], ks["flag"], on.intake["off"], on.intake["pending_request"]], ["tripped", cara.staff_user_id, ada.staff_user_id, reason, requestId, false, true, null]);
  assert.ok((ks["history"] as Json[]).some((h) => h["type"] === "ai.kill_switch.tripped" && h["by"] === cara.staff_user_id && h["confirmed_by"] === ada.staff_user_id));
  assert.ok((on.view["requests"] as Json[]).some((x) => x["request_id"] === requestId && x["status"] === "confirmed" && x["confirmed_by"] === ada.staff_user_id));
  // the two decision records: the request by compliance, the confirmation naming both
  const dReq = await decision(decisionIdOf(req.body)); assert.deepEqual([dReq.action, dReq.subject_kind, dReq.subject_id, dReq.approved_by, dReq.approved_role], ["controls.ai.kill:request:trip", "ai_system", "intake", cara.staff_user_id, "compliance"]); assert.deepEqual([record(dReq)["by"], record(dReq)["confirmed_by"], record(dReq)["reason"]], [cara.staff_user_id, null, reason]);
  const dConf = await decision(decisionIdOf(conf.body)); assert.deepEqual([dConf.action, dConf.subject_id, dConf.approved_by, dConf.approved_role], ["controls.ai.kill:confirm:trip", "intake", ada.staff_user_id, "admin"]); assert.deepEqual([record(dConf)["by"], record(dConf)["confirmed_by"], record(dConf)["reason"]], [cara.staff_user_id, ada.staff_user_id, reason]);
  // a borrower turn returns the placeholder (32.16 T-17-10): the model is never called, no agent_turns row is written — on every turn until reset
  const turns0 = await turnsOf(organic.party_id); const calls0 = scripted.requests.length;
  for (const text of ["is this thing on?", "hello?"]) {
    const off = await message(organic.token, text);
    assert.equal(off.status, 200, J(off.body).slice(0, 300)); assert.equal(off.body["routed_to"], "intake");
    assert.deepEqual([off.reply["copy_key"], off.reply["body_text"], off.reply["copy_tokens"]], [PLACEHOLDER, `{{copy:${PLACEHOLDER}}}`, null]);
  }
  assert.equal(await turnsOf(organic.party_id), turns0, "no agent_turns row: the turn was bypassed, not attempted"); assert.equal(scripted.requests.length, calls0, "the model was never called");
  // while tripped: a second trip request is refused; the reset needs the same two people — compliance requests, admin confirms
  const trippedAgain = await api("POST", KILL, { reason: "x" }, cara); assert.equal(trippedAgain.status, 409, J(trippedAgain.body)); assert.equal(trippedAgain.body["code"], "ALREADY_TRIPPED");
  const adminResets = await api("POST", RESET, { reason: "fixed" }, ada); assert.equal(adminResets.status, 403, J(adminResets.body)); assert.equal(adminResets.body["code"], "ROLE_REQUIRED"); assert.equal(adminResets.body["role"], "compliance");
  const resetReason = `prompt 32.16-p8 evaluated and approved (${R})`;
  const rreq = await api("POST", RESET, { reason: resetReason }, cara); assert.equal(rreq.status, 200, J(rreq.body)); const resetId = String((rreq.body["output"] as Json)["request_id"]); assert.equal((rreq.body["output"] as Json)["action"], "reset"); assert.equal((rreq.body["output"] as Json)["status"], "pending");
  assert.equal(runtime.agents.aiState("intake").off, true, "still tripped on the request alone"); assert.equal(await flagOf("intake.enabled"), false);
  assert.equal((await message(organic.token, "is this thing on?")).reply["copy_key"], PLACEHOLDER, "still the placeholder");
  const selfReset = await api("POST", RESET, { request_id: resetId }, cara); assert.equal(selfReset.status, 403); assert.equal(selfReset.body["code"], "ROLE_REQUIRED"); assert.equal(selfReset.body["role"], "admin");
  clock.set(at(t0, 6 * MIN));
  const rconf = await api("POST", RESET, { request_id: resetId }, ada); assert.equal(rconf.status, 200, J(rconf.body));
  assert.deepEqual([(rconf.body["output"] as Json)["state"], (rconf.body["output"] as Json)["event"], (rconf.body["output"] as Json)["by"], (rconf.body["output"] as Json)["confirmed_by"], (rconf.body["output"] as Json)["flag"]], ["armed", "ai.kill_switch.reset", cara.staff_user_id, ada.staff_user_id, true]);
  const reset = await events("ai.kill_switch.reset"); assert.equal(reset.length, 1); assert.deepEqual([reset[0]!.actor_id, reset[0]!.actor_role, reset[0]!.payload["by"], reset[0]!.payload["confirmed_by"], reset[0]!.payload["reason"], reset[0]!.payload["request_id"]], [ada.staff_user_id, "admin", cara.staff_user_id, ada.staff_user_id, resetReason, resetId]);
  assert.equal(await flagOf("intake.enabled"), true); assert.equal(runtime.agents.aiState("intake").off, false);
  const back = await state(); assert.equal((back.intake["kill_switch"] as Json)["state"], "armed"); assert.equal(back.intake["off"], false); assert.equal(back.intake["pending_request"], null);
  const alive = await message(organic.token, "is this thing on?"); assert.equal(alive.reply["body_text"], PING_REPLY, "the turn is back after the reset"); assert.equal(await turnsOf(organic.party_id), turns0 + 1);
  // an unconfirmed request expires at 10 minutes with nothing tripped: the late confirmation is refused, the expiry is logged once, the switch stays armed
  const t1 = clock.now();
  const second = await api("POST", KILL, { reason: `a second look (${R})` }, cara); assert.equal(second.status, 200, J(second.body)); const expiring = String((second.body["output"] as Json)["request_id"]); assert.equal((second.body["output"] as Json)["expires_at"], at(t1, KILL_CONFIRM_MINUTES * MIN));
  clock.set(at(t1, 9 * MIN));
  const nine = await state(); assert.equal((nine.intake["pending_request"] as Json)["request_id"], expiring); assert.equal((nine.intake["kill_switch"] as Json)["state"], "armed"); assert.equal(nine.view["expired_now"], 0);
  clock.set(at(t1, KILL_CONFIRM_MINUTES * MIN + 1000));
  const lateConf = await api("POST", KILL, { request_id: expiring }, ada); assert.equal(lateConf.status, 409, J(lateConf.body)); assert.equal(lateConf.body["code"], "REQUEST_EXPIRED"); assert.equal(lateConf.body["request_id"], expiring);
  const expired = await events("ai.kill_switch.request.expired"); assert.equal(expired.length, 1); assert.deepEqual([expired[0]!.payload["request_id"], expired[0]!.payload["code"], expired[0]!.payload["action"], expired[0]!.payload["requested_by"], expired[0]!.actor_kind], [expiring, "intake", "trip", cara.staff_user_id, "system"]);
  assert.equal((await events("ai.kill_switch.tripped")).length, 1, "nothing tripped"); assert.equal(await flagOf("intake.enabled"), true); assert.equal(runtime.agents.aiState("intake").off, false);
  const after = await state(); assert.equal((after.intake["kill_switch"] as Json)["state"], "armed"); assert.equal(after.intake["pending_request"], null); assert.equal(after.view["expired_now"], 0, "logged once — the late confirmation already expired it");
  assert.ok((after.view["requests"] as Json[]).some((x) => x["request_id"] === expiring && x["status"] === "expired" && x["confirmed_by"] === null));
  assert.equal((await message(organic.token, "is this thing on?")).reply["body_text"], PING_REPLY);
  // every kill-switch act is on the action log with its outcome
  const rows = await actions(`WHERE route IN ($1, $2)`, [KILL, RESET]);
  assert.equal(rows.filter((r) => r.result === "ok").length, 5, "request, confirm, reset request, reset confirm, the expiring request"); assert.ok(rows.filter((r) => r.result === "ok").every((r) => r.command === "controls.ai.kill" && r.subject_kind === "ai_system" && r.subject_id === "intake"));
  for (const code of ["ROLE_REQUIRED", "REQUEST_PENDING", "NO_SUCH_REQUEST", "ALREADY_TRIPPED", "REQUEST_EXPIRED", "REASON_REQUIRED"]) assert.ok(rows.some((r) => r.result === "refused" && r.refusal_code === code), `a refused row with ${code}`);
});

test("34.4-T5: Given `compliance` requests the evidence pack for loan 1 of the fixture, then one document exists with a hash, `evidence_packs.manifest` lists events, decisions, notices with rendered text and checklists, timers with histories, the partner-book facts, reviews and readiness, agent turns with model and prompt versions, consents and the staff actions on the loan, each with a count and a hash, and no row of another loan or person is in it.", { skip }, async () => {
  // loan 1's homeowner signs in through the code door (33.1 T7) and asks one question: the loan's record now holds her agent turns beside 33.2's analyst turn
  const maria = await signInByCode(loanN(1).email!, "10.34.4.50"); assert.equal(maria.party_id, party1Id, "the session opens on loan 1's party");
  const ask = await message(maria.token, "is this thing on?"); assert.equal(ask.status, 200, J(ask.body).slice(0, 300)); assert.equal(ask.body["routed_to"], "borrower-comms"); assert.equal(ask.reply["body_text"], PING_REPLY);
  const partyTurns = await db.query<{ model_version: string; prompt_version: string }>(`SELECT model_version, prompt_version FROM agent_turns WHERE party_id = $1 ORDER BY created_at`, [party1Id]);
  assert.ok(partyTurns.length >= 2, `the analyst's turn and the homeowner's: ${J(partyTurns)}`); assert.ok(partyTurns.every((t) => t.model_version === "scripted" && t.prompt_version));
  // compliance only: the analyst and the admin are refused at the gate, before any write
  for (const s of [oli, ada]) { const r = await api("POST", "/ops/api/controls/evidence", { subject: { loan_id: loan1Id } }, s); assert.equal(r.status, 403, J(r.body)); assert.equal(r.body["code"], "ROLE_REQUIRED"); assert.equal(r.body["role"], "compliance"); }
  assert.equal(await count(`evidence_packs`), 0); assert.equal(await count(`documents WHERE kind = 'evidence_pack'`), 0);
  // compliance requests the pack for loan 1
  const producedAt = clock.now();
  const r = await api("POST", "/ops/api/controls/evidence", { subject: { loan_id: loan1Id } }, cara);
  assert.equal(r.status, 200, J(r.body).slice(0, 600)); assert.deepEqual(r.body["actor"], { kind: "human", id: cara.staff_user_id, role: "compliance" }); assert.deepEqual(r.body["events"], ["command.executed"]);
  const out = r.body["output"] as Json; const packId = String(out["id"]); const docId = String(out["document_id"]); const sha = String(out["sha256"]);
  assert.match(packId, UUID_RE); assert.match(docId, UUID_RE); assert.match(sha, /^[0-9a-f]{64}$/);
  assert.deepEqual([out["subject_kind"], out["subject_id"], out["from_date"], out["to_date"], out["sections"], out["part_count"], out["produced_by"], out["created_at"]], ["loan", loan1Id, null, null, [...EVIDENCE_SECTIONS], 1, cara.staff_user_id, producedAt]);
  assert.equal("document" in out, false, "the answer carries the manifest and the hash, never the whole document"); assert.ok(Array.isArray(out["parts"]) && (out["parts"] as Json[]).length === 1 && !("content" in (out["parts"] as Json[])[0]!));
  const manifest = out["manifest"] as Json;
  assert.deepEqual([manifest["pack_id"], manifest["subject"], manifest["produced_at"], manifest["produced_by"], manifest["produced_role"], manifest["rule_set_version"], manifest["part_count"]], [packId, { kind: "loan", id: loan1Id, from_date: null, to_date: null }, producedAt, cara.staff_user_id, "compliance", CONTROLS_RULE_SET_VERSION, 1]);
  // one document with a hash (kind evidence_pack), the event part as its own document, the evidence_packs row (append-only), the event
  const docs = await db.query<{ id: string; kind: string; sha256: string; loan_id: string | null; byte_size: string; storage_uri: string; mime_type: string; metadata: Json }>(`SELECT id::text AS id, kind, sha256, loan_id::text AS loan_id, byte_size::text AS byte_size, storage_uri, mime_type, metadata FROM documents WHERE metadata->>'pack_id' = $1 ORDER BY kind`, [packId]);
  assert.deepEqual(docs.map((d) => d.kind), ["evidence_pack", "evidence_pack_part"], "one pack document and one event part");
  const doc = docs[0]!; assert.deepEqual([doc.id, doc.sha256, doc.loan_id, Number(doc.byte_size), doc.storage_uri, doc.mime_type, doc.metadata["produced_by"]], [docId, sha, loan1Id, out["byte_size"], `evidence://packs/${packId}`, "application/json", cara.staff_user_id]);
  assert.equal(await count(`documents WHERE kind = 'evidence_pack'`), 1, "one document");
  const part = (out["parts"] as Json[])[0]!; assert.deepEqual([docs[1]!.id, docs[1]!.sha256], [part["document_id"], part["sha256"]]); assert.equal((manifest["parts"] as Json[])[0]!["document_id"], part["document_id"]);
  const [packRow] = await db.query<{ subject_kind: string; subject_id: string; sections: string[]; manifest: Json; document_id: string; sha256: string; produced_by: string; created_at: string }>(`SELECT subject_kind, subject_id, sections, manifest, document_id::text AS document_id, sha256, produced_by::text AS produced_by, created_at::text AS created_at FROM evidence_packs WHERE id = $1`, [packId]);
  assert.ok(packRow); assert.deepEqual([packRow.subject_kind, packRow.subject_id, packRow.sections, packRow.document_id, packRow.sha256, packRow.produced_by], ["loan", loan1Id, [...EVIDENCE_SECTIONS], docId, sha, cara.staff_user_id]); assert.deepEqual(packRow.manifest, manifest);
  await assert.rejects(db.query(`UPDATE evidence_packs SET sha256 = 'x' WHERE id = $1`, [packId]), "append-only"); await assert.rejects(db.query(`DELETE FROM evidence_packs WHERE id = $1`, [packId]));
  const produced = await events("evidence.pack.produced", "AND payload->>'pack_id' = $2", [packId]);
  assert.equal(produced.length, 1); assert.deepEqual([produced[0]!.actor_kind, produced[0]!.actor_id, produced[0]!.actor_role, produced[0]!.loan_id, produced[0]!.payload["sha256"], produced[0]!.payload["document_id"], produced[0]!.payload["by"], (produced[0]!.payload["subject"] as Json)["id"]], ["human", cara.staff_user_id, "compliance", loan1Id, sha, docId, cara.staff_user_id, loan1Id]);
  // read back from the document store: the text re-hashes to the row's sha256; the examiner's verification re-reads the rows and agrees with every stored hash
  const got = await api("GET", `/ops/api/controls/evidence/${packId}?verify=1`, undefined, cara);
  assert.equal(got.status, 200, J(got.body).slice(0, 300)); assert.equal(got.body["document_available"], true); assert.equal(got.body["sha256"], sha);
  const document = String(got.body["document"]); assert.equal(sha256hex(document), sha, "the stored document hashes to the row's sha256"); assert.equal(Buffer.byteLength(document, "utf8"), out["byte_size"]);
  const verification = got.body["verification"] as Json; assert.equal(verification["verified"], true, J(verification)); assert.ok((verification["sections"] as Json[]).every((x) => x["ok"] === true) && (verification["parts"] as Json[]).every((x) => x["ok"] === true));
  const listed = await api("GET", "/ops/api/controls/evidence?subject_kind=loan", undefined, cara); assert.ok((listed.body["packs"] as Json[]).some((p) => p["id"] === packId && p["subject_id"] === loan1Id));
  assert.equal((await api("GET", `/ops/api/controls/evidence/${packId}`, undefined, oli)).status, 403, "the packs are compliance's (and the admin's) to read");
  // the manifest: every row set with a count and a hash; the document is those stored rows and nothing else
  const sections = manifest["sections"] as Json[];
  assert.deepEqual(sections.map((x) => x["name"]), [...EVIDENCE_SECTIONS]);
  for (const x of sections) { assert.equal(typeof x["count"], "number", `${x["name"]} has a count`); assert.match(String(x["sha256"]), /^[0-9a-f]{64}$/, `${x["name"]} has a hash`); }
  const n = (name: string): number => Number(sections.find((x) => x["name"] === name)!["count"]);
  const detail = (name: string): Json => sections.find((x) => x["name"] === name)!["detail"] as Json;
  const body = JSON.parse(document) as { manifest: Json; sets: Record<string, Json[]> };
  assert.deepEqual(body.manifest, manifest); assert.deepEqual(Object.keys(body.sets).sort(), EVIDENCE_SECTIONS.filter((s) => s !== "events").sort());
  for (const name of EVIDENCE_SECTIONS) { if (name === "events") continue; assert.equal(body.sets[name]!.length, n(name), `${name}: the count is the rows`); assert.equal(sha256hex(JSON.stringify(body.sets[name])), sections.find((x) => x["name"] === name)!["sha256"], `${name}: the hash is of the stored rows`); }
  assert.equal(sections.find((x) => x["name"] === "events")!["sha256"], sha256hex(String(part["sha256"])), "the events hash chains the part");
  assert.equal(n("events"), (manifest["parts"] as Json[])[0]!["event_count"]); assert.ok(n("events") > 0); assert.equal(n("events"), (await count(`loan_events WHERE loan_id = $1`, [loan1Id])) - 1, "every event of loan 1 (the pack's own evidence.pack.produced landed after the read)");
  // the counts the engine yields for loan 1 at this point of the fixture's life
  assert.equal(n("decisions"), await count(`agent_decisions WHERE loan_id = $1 AND agent <> $2`, [loan1Id, CONTROLS_AGENT])); assert.ok(n("decisions") >= 10, `the run's, the review's, the offer's and the readiness decisions: ${n("decisions")}`);
  assert.equal(n("notices"), 3, "the invitation, the refinance offer and the reminder (35.2: a notice rendered through the command path is a notices row with its document)"); assert.deepEqual(detail("notices"), { notices: 3, checklist_results: 3, deliveries: 3, rendered_text: 3 });
  assert.deepEqual((body.sets["notices"] as Json[]).map((x) => x["template_code"]).sort(), ["NTC_REGZ_1026_24_REFI_OFFER", "NTC_SM_PARTNER_BOOK_INVITATION", "NTC_SM_PARTNER_BOOK_INVITATION"], "the invitation, the refinance offer and the reminder");
  for (const notice of body.sets["notices"]!) {
    assert.equal(notice["loan_id"], loan1Id);
    assert.equal((notice["checklist_results"] as Json[]).length, 1); assert.equal((notice["checklist_results"] as Json[])[0]!["notice_id"], notice["id"]); assert.equal((notice["deliveries"] as Json[]).length, 1);
    const rendered = notice["rendered"] as Json; assert.ok(rendered && typeof rendered["text"] === "string", "the rendered text");
    if (notice["template_code"] === "NTC_SM_PARTNER_BOOK_INVITATION") assert.ok(String(rendered["text"]).includes(DEMO_PARTNER.legal_name), "the invitation names the partner");
  }
  assert.equal(n("timers"), await count(`timers WHERE loan_id = $1`, [loan1Id])); assert.ok(n("timers") >= 5, `loan 1's clocks: ${n("timers")}`);
  assert.equal(detail("timers")["history_events"], await count(`loan_events WHERE type LIKE 'timer.%' AND (payload->>'timer_id')::uuid IN (SELECT id FROM timers WHERE loan_id = $1)`, [loan1Id]));
  assert.ok(body.sets["timers"]!.every((t) => t["loan_id"] === loan1Id && Array.isArray(t["history"]) && (t["history"] as Json[]).every((h) => (h["payload"] as Json)["timer_id"] === t["id"])), "every clock with its own history");
  const reminderRow = body.sets["timers"]!.find((t) => t["id"] === reminderTimerId); assert.ok(reminderRow, "loan 1's reminder clock"); assert.deepEqual((reminderRow["history"] as Json[]).map((h) => h["type"]), ["timer.armed", "timer.breached", "timer.satisfied"], "armed, breached, then satisfied by the homeowner's sign-in this morning");
  assert.equal(n("escalations"), await count(`escalations WHERE loan_id = $1`, [loan1Id])); assert.equal(n("escalations"), 2, "the reminder's breach and T3's requeue cap");
  assert.ok(body.sets["escalations"]!.every((e) => e["loan_id"] === loan1Id && Array.isArray(e["completions"])));
  assert.equal(n("ledger_sets"), 0, "a monitored loan has no ledger set (33.1: the partner's servicing figures are facts, not postings)");
  assert.equal(n("agent_turns"), partyTurns.length); assert.ok(n("agent_turns") >= 2);
  for (const t of body.sets["agent_turns"]!) { assert.equal(t["party_id"], party1Id); assert.equal(t["model_version"], "scripted"); assert.equal(typeof t["prompt_version"], "string"); assert.ok(Array.isArray(t["tool_names"])); for (const k of ["context_hash", "guard_result", "tier", "safe_classification"]) assert.ok(k in t, `a turn lists ${k}`); for (const k of ["context", "messages", "tool_calls", "transcript"]) assert.equal(k in t, false, `never the ${k}`); }
  assert.equal(n("consents"), await count(`consents WHERE loan_id = $1`, [loan1Id])); assert.equal(n("consents"), 0, "the fixture writes no consents row for a monitored loan (the offer's ai_disclosure_ack is a lead consent record, not a consents row)");
  assert.equal(n("verifications"), 0); assert.equal(n("credit_reports"), 0);
  assert.deepEqual(detail("partner_book"), { partner_book_facts: 1, partner_book_invitations: 2, partner_book_reviews: 1, readiness_checks: 1 }); assert.equal(n("partner_book"), 5);
  assert.ok(body.sets["partner_book"]!.every((row) => (row["data"] as Json)["loan_id"] === loan1Id));
  const facts = body.sets["partner_book"]!.find((row) => row["table_name"] === "partner_book_facts")!["data"] as Json; assert.equal((facts["facts"] as Json)["upb_cents"], "44136613", "worked example A: loan 1's UPB as the tape carries it"); assert.equal(facts["as_of_date"], DEMO_AS_OF);
  for (const inv of body.sets["partner_book"]!.filter((row) => row["table_name"] === "partner_book_invitations")) { const d = inv["data"] as Json; assert.match(String(d["destination_hash"]), /^[0-9a-f]{64}$/); assert.equal("message_id" in d, false); assert.equal(J(d).includes("@"), false, "a hash and a date, never a destination"); }
  assert.ok(body.sets["partner_book"]!.some((row) => row["table_name"] === "partner_book_reviews" && typeof (row["data"] as Json)["verdict"] === "string") && body.sets["partner_book"]!.some((row) => row["table_name"] === "readiness_checks" && typeof (row["data"] as Json)["ready"] === "boolean"));
  // the staff actions on the loan: T1's read of loan 1's clock, T3's requeues of loan 1's message (ok and refused), the outbox reads — every one a row on the loan's own ids, none on anything else
  const loanIds = new Set((await db.query<{ id: string }>(`SELECT id::text AS id FROM timers WHERE loan_id = $1::uuid UNION SELECT id::text FROM escalations WHERE loan_id = $1::uuid UNION SELECT id::text FROM notices WHERE loan_id = $1::uuid UNION SELECT id::text FROM integration_messages WHERE loan_id = $1::uuid UNION SELECT $2::text`, [loan1Id, loan1Id])).map((x) => x.id));
  const staffRows = body.sets["staff_actions"]!;
  assert.equal(n("staff_actions"), staffRows.length); assert.ok(staffRows.length >= 6, `${staffRows.length} staff actions on loan 1`);
  assert.ok(staffRows.every((a) => loanIds.has(String(a["subject_id"]))), "every staff action is on one of loan 1's own ids");
  assert.ok(staffRows.some((a) => a["route"] === `/ops/api/controls/timers/${reminderTimerId}` && a["result"] === "ok" && a["staff_user_id"] === oli.staff_user_id));
  assert.equal(staffRows.filter((a) => a["command"] === "controls.outbox.requeue" && a["result"] === "ok" && a["subject_id"] === failedMessageId).length, 3);
  assert.ok(staffRows.some((a) => a["refusal_code"] === "REQUEUE_CAP_3" && a["subject_id"] === failedMessageId));
  assert.ok(staffRows.every((a) => !J(a).includes("@")), "ids only on the action log");
  // no row of another loan or person: not one of the other eleven loans' ids, their parties, their homeowners' names, e-mails or loan numbers, nor the T4 homebuyer's party
  const others = await db.query<{ id: string; party_id: string | null; servicer_loan_number: string }>(`SELECT l.id::text AS id, b.party_id::text AS party_id, l.servicer_loan_number FROM loans l LEFT JOIN loan_borrowers lb ON lb.loan_id = l.id LEFT JOIN borrowers b ON b.id = lb.borrower_id WHERE l.partner_party_id = $1 AND l.id <> $2::uuid`, [partnerPartyId, loan1Id]);
  assert.equal(others.length, 11);
  for (const o of others) { assert.equal(document.includes(o.id), false, `another loan's id ${o.servicer_loan_number}`); if (o.party_id) assert.equal(document.includes(o.party_id), false, `another person's party ${o.servicer_loan_number}`); assert.equal(document.includes(o.servicer_loan_number), false, `another loan's number ${o.servicer_loan_number}`); }
  for (const l of book.loans.filter((x) => x.n !== 1)) { assert.equal(document.includes(l.name), false, `another homeowner's name (${l.n})`); if (l.email) assert.equal(document.toLowerCase().includes(l.email.toLowerCase()), false, `another homeowner's e-mail (${l.n})`); }
  assert.ok(organic); assert.equal(document.includes(organic.party_id), false, "the T4 homebuyer is another person"); assert.equal(document.includes(patId), false);
  assert.ok(document.includes(loan1Id) && document.includes(party1Id) && document.includes(loanN(1).servicer_loan_number), "loan 1's own rows are there");
  // the decision names the person; the action log carries the pack id under the command
  const d = await decision(decisionIdOf(r.body));
  assert.deepEqual([d.agent, d.action, d.subject_kind, d.subject_id, d.approved_by, d.approved_role, d.rule_set_version], [CONTROLS_AGENT, "controls.evidence.pack", "evidence_pack", packId, cara.staff_user_id, "compliance", CONTROLS_RULE_SET_VERSION]);
  assert.equal(record(d)["by"], cara.staff_user_id); assert.match(String(record(d)["reason"]), new RegExp(`pack for loan ${loan1Id}.*${sha}`));
  const logged = (await actions(`WHERE route = '/ops/api/controls/evidence' AND result = 'ok'`)); assert.equal(logged.length, 1); assert.deepEqual([logged[0]!.command, logged[0]!.subject_kind, logged[0]!.subject_id, logged[0]!.staff_user_id, logged[0]!.session_id], ["controls.evidence.pack", "evidence_pack", packId, cara.staff_user_id, cara.session_id]);
});

test("34.4-T6: Given any controls response, then no money field was written by the portal (the ledger and money columns before and after every controls route are identical in a contract test), and every action route recorded a `staff_actions` row and a decision record naming the person.", { skip }, async () => {
  // one last pass over every read route, then the whole record of the suite
  for (const path of ["/ops/api/controls/timers?status=all", "/ops/api/controls/escalations?status=all", "/ops/api/controls/outbox?status=all", "/ops/api/controls/ai", "/ops/api/controls/ai/intake"]) { const r = await api("GET", path, undefined, oli); assert.equal(r.status, 200, `${path}: ${J(r.body).slice(0, 200)}`); }
  assert.equal((await api("GET", "/ops/api/controls/evidence", undefined, cara)).status, 200);
  const controls = sent.filter((x) => x.controls);
  assert.ok(controls.length >= 50, `${controls.length} controls requests over the suite`);
  // the money contract: the ledger and every money column are identical before and after every controls route — the acts included, the refusals included
  for (const x of controls) assert.equal(x.money_after, x.money_before, `${x.method} ${x.route} (${x.status}) changed a money column`);
  assert.equal(await moneyFingerprint(), moneyBaseline, "and the whole suite left the money columns as the sweep left them");
  // the action routes are the mounted table's POST rows (src/console/server.ts section34RouteTable, built from the module's own); T1's write probes hit no route at all
  const table = section34RouteTable(runtime).filter((r) => r.section === "34.4");
  const onRoute = (method: string, route: string): boolean => table.some((r) => r.method === method && new RegExp(`^${r.path.replace(/:[a-z]+/g, "[^/]+")}(\\?.*)?$`).test(route));
  const probes = controls.filter((x) => !onRoute(x.method, x.route)); assert.equal(probes.length, 8, "T1's eight write probes on the timer paths"); assert.ok(probes.every((x) => x.status === 404 || x.status === 405));
  const acts = controls.filter((x) => x.method === "POST" && onRoute("POST", x.route)); const okActs = acts.filter((x) => x.status === 200); const refusedActs = acts.filter((x) => x.status >= 400);
  assert.equal(okActs.length, 11, `T2: two completions; T3: three requeues; T4: request, confirm, reset request, reset confirm, the expiring request; T5: the pack — got ${J(okActs.map((x) => x.route))}`);
  assert.ok(refusedActs.length >= 15);
  // one staff_actions row per controls request (34.1 rule 4): the multiset of (method, route) the suite sent is the table's
  const rows = await actions(`WHERE route LIKE '/ops/api/controls%'`);
  const key = (x: { method: string; route: string }): string => `${x.method} ${x.route}`;
  assert.equal(rows.length, controls.length, `one staff_actions row per controls request (${rows.length} rows, ${controls.length} requests)`);
  assert.deepEqual(rows.map(key).sort(), controls.map(key).sort());
  // every action route that ran recorded the person, the session, the command and the subject; every refused one its code; every read no command
  const COMMANDS = new Set(["controls.escalation.complete", "controls.outbox.requeue", "controls.ai.kill", "controls.evidence.pack"]);
  const okRows = rows.filter((r) => r.method === "POST" && r.result === "ok" && onRoute("POST", r.route));
  assert.equal(okRows.length, okActs.length, "one ok row per action that ran");
  for (const x of okActs) assert.equal(okRows.filter((r) => r.route === x.route && r.staff_user_id === x.staff_user_id && r.session_id === x.session_id).length, okActs.filter((y) => y.route === x.route && y.staff_user_id === x.staff_user_id).length, `${x.route} by ${x.staff_user_id}`);
  assert.ok(okRows.every((r) => r.command !== null && COMMANDS.has(r.command) && r.subject_kind !== null && r.subject_id !== null && r.refusal_code === null), J(okRows.filter((r) => !r.command)));
  const refusedRows = rows.filter((r) => r.method === "POST" && r.result !== "ok" && onRoute("POST", r.route));
  assert.equal(refusedRows.length, refusedActs.length, "one refused row per action refused"); assert.ok(refusedRows.every((r) => r.refusal_code !== null && r.staff_user_id !== null));
  // the module's own refusals (ROLE_REQUIRED inside the act, REQUEUE_CAP_3, REQUEST_EXPIRED, …) name the subject they were refused on and the command asked for; the console's gate (a role the session lacks) names neither
  assert.ok(refusedRows.filter((r) => ["REQUEUE_CAP_3", "REQUEST_EXPIRED", "ALREADY_TRIPPED", "REQUEST_PENDING", "ALREADY_COMPLETED", "DISPOSITION_REQUIRED"].includes(r.refusal_code ?? "")).every((r) => r.subject_id !== null && r.command !== null), J(refusedRows.filter((r) => r.subject_id === null).map((r) => [r.route, r.refusal_code])));
  assert.ok(rows.filter((r) => r.method === "GET").every((r) => r.command === null && (r.result === "ok" || r.refusal_code !== null)));
  assert.ok(rows.every((r) => r.staff_user_id !== null && r.session_id !== null), "every controls request was a signed-in person's");
  // every action that ran recorded a decision record of the compliance-sentinel agent naming the person, under the section's rule set, model and prompt versions
  const staff = new Map([[ada.staff_user_id, "admin"], [oli.staff_user_id, "ops_analyst"], [cara.staff_user_id, "compliance"]]);
  const decs = await sentinelDecisions();
  assert.equal(decs.length, okActs.length, "one decision per action that ran");
  for (const d of decs) {
    const rec = record(d);
    assert.deepEqual([d.rule_set_version, d.model_version, d.prompt_version, Number(d.confidence)], [CONTROLS_RULE_SET_VERSION, CONTROLS_MODEL_VERSION, CONTROLS_PROMPT_VERSION, 1], d.id);
    assert.ok(d.approved_by && staff.has(d.approved_by), `approved by a staff member: ${d.approved_by}`); assert.equal(d.approved_role, staff.get(d.approved_by!));
    assert.ok(rec["by"] === d.approved_by || rec["confirmed_by"] === d.approved_by, `the record names the person who acted: ${d.rationale}`);
    assert.ok(staff.has(String(rec["by"])), `by a staff member: ${rec["by"]}`);
    assert.deepEqual([rec["rule_set_version"], rec["model_version"], rec["prompt_version"], rec["confidence"]], ["controls.v1", "deterministic", "34.4-v1", 1]);
    assert.ok(d.subject_id && (rec["subject"] as Json)["id"] === d.subject_id); assert.equal(typeof rec["reason"], "string"); assert.ok(String(rec["reason"]).length > 0);
    // the person on the decision is the person on the action log's row for that command
    assert.ok(okRows.some((r) => r.staff_user_id === d.approved_by && (r.subject_id === d.subject_id || (r.command === "controls.ai.kill" && d.subject_id === "intake"))), `an action row for ${d.action} by ${d.approved_by}`);
  }
  assert.deepEqual({ complete: decs.filter((d) => d.action === "controls.escalation.complete").length, requeue: decs.filter((d) => d.action === "controls.outbox.requeue").length, kill: decs.filter((d) => d.action.startsWith("controls.ai.kill:")).length, pack: decs.filter((d) => d.action === "controls.evidence.pack").length },
    { complete: okRows.filter((r) => r.command === "controls.escalation.complete").length, requeue: okRows.filter((r) => r.command === "controls.outbox.requeue").length, kill: okRows.filter((r) => r.command === "controls.ai.kill").length, pack: okRows.filter((r) => r.command === "controls.evidence.pack").length });
  // the mounted table: every 34.4 action route names the bus command the log carries; every read names none; no route under timers writes
  assert.equal(table.length, 15); assert.ok(table.filter((r) => r.method === "POST").every((r) => r.command !== null && COMMANDS.has(r.command))); assert.ok(table.filter((r) => r.method === "GET").every((r) => r.command === null));
  assert.deepEqual(new Set(okRows.map((r) => r.command)), new Set(table.filter((r) => r.method === "POST").map((r) => r.command)), "every action route ran at least once in this suite");
  // ids only on the log (34.1 rule 4): no e-mail, no name, no money figure on any controls row
  const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  for (const r of rows) {
    const text = [r.route, r.subject_kind, r.subject_id, r.command, r.refusal_code].filter((x): x is string => typeof x === "string").join(" "); const masked = text.replace(UUIDS, "<uuid>");
    assert.doesNotMatch(masked, /@/, text); for (const p of [ADA, OLI, CARA, PAT]) assert.ok(!text.includes(p.name) && !text.includes(p.password), text);
    assert.doesNotMatch(masked, /\$|\d{1,3}(,\d{3})+|\d+\.\d{2}\b|\bcents?\b/i, `no money figure: ${text}`);
  }
  assert.ok(logLines.every((l) => !/"severity":"ERROR"/.test(l)), logLines.filter((l) => /"severity":"ERROR"/.test(l)).slice(0, 3).join("\n"));
});
