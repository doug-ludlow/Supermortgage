// 34.5 The portal's information architecture and the accounts list
// spec/sections/34-operator-portal/34-5-the-portal-s-information-architecture-and-the-accounts-list.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness (34-2 / 34-4's): own database `<base>_…_34_5_spec` from the migrated template; the API server of src/runtime/server.ts
// in-process with the ops console mounted at /ops/api and a borrower router built here (a scripted model behind the borrower turn,
// the fixture partner as the default partner, the FAKE video vendor behind the video door); the FAKE rate feed and reviewers on the
// sweep; the 34.1 doors for the staff (the bootstrap with STAFF_BOOTSTRAP_ADMIN_ROLES outside production → invite → code → password
// → sign-in, the FAKE code echoed as `fake_code`); a FixedClock the fixture moves. The fixture: the entry seed and the 33.1 demo book
// as of 2026-09-01 (twelve partner-book parties, eleven invited), the 09-15 sweep (the late-tape and stale-sheet clocks breach — the
// two breached clocks; the late tape's breach opens the `ops_analyst` escalation), one `officer` escalation opened the way a section
// opens one, one held notice and one dead letter on loan 1; then the accounts of T2 through the borrower doors: Maria (loan 1's
// homeowner) by e-mail code, Pia by e-mail and password, Gabe by Google (the FAKE provider), Vera through the video door and
// identified by `video.identify`, one video visitor who never gave a name (an open session), and Cody by code on a fresh e-mail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Browser, BrowserContext, Page, Response } from "playwright-core";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { acquireBrowserLock, type TestLock } from "../../infra/db/test-lock.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { EscalationService } from "../../app/escalations.ts";
import { Runtime, type SweepReport } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { AnthropicLlm } from "../../runtime/borrower/agent/llm.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { FakeRateFeed } from "../../infra/integrations/rates.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { FakeTavus } from "../../infra/integrations/tavus.ts";
import { FAKE_OIDC_MARKER, type FakeOidcIdentity } from "../../infra/integrations/oidc.ts";
import { bootstrapStaffAdmin } from "../../runtime/staff/auth.ts";
import { STAFF_ROLES } from "../../runtime/staff/roles.ts";
import { maskEmail, maskPhone, SECRET_KEYS } from "../../runtime/directory/mask.ts";
import { originsOf } from "../../runtime/directory/search.ts";
import { canonicalListFilters, listFiltersHash, LIST_PAGE_SIZE } from "../../runtime/directory/list.ts";
import { OTHER_AREAS_NEED } from "../../runtime/portal/home.ts";
import { scriptedClient } from "../borrower/eval/scripted-client.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, type DemoLoan } from "../partner-book/fixtures/partner-book-demo.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
type Json = Record<string, unknown>;
const J = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
const MIN = 60_000;

/** The timeline (America/New_York is UTC−4 in September): the seed and the book on 2026-09-01; the sweep at 07:20 ET on 09-15 — past 20.1's 06:30 run, 33.2's 07:00 review and 33.3's 07:15 pass, a week past the partner's next tape (33.1 rule 8) — the staff and the borrower accounts that morning. */
const SEED_AT = "2026-09-01T16:00:00.000Z";
const NOW = "2026-09-15T11:20:00.000Z";
const T_STAFF = "2026-09-15T13:00:00.000Z";
const T_ACCOUNTS = "2026-09-15T13:10:00.000Z";
const clock = new FixedClock(SEED_AT);
const TAPE_CLOCK = "SM_PARTNER_BOOK_TAPE_EXPECTED_7"; const SHEET_CLOCK = "SM_RATE_SHEET_PUBLISH_DAILY";
const FOUR_ROLES = ["ops_analyst", "officer", "compliance", "admin"] as const;

// the scripted models: a token-free line behind every borrower turn (the account door's first turn, the video door's greeting); no figure
const scripted = scriptedClient([], { fallbackText: "Thanks for writing. Tell me what brings you here today and I will point you to the next step." });
const fakeTavus = new FakeTavus({ appBase: "http://127.0.0.1:3999" });
const CALLBACK_SECRET = `cb-${randomUUID().replace(/-/g, "")}`;

// the people: the staff (34.1) and the borrowers (the doors of 32.16, 32.17 and 33.1)
type Person = { email: string; name: string; password: string };
const ADA: Person = { email: `ada.admin.${R}@example.test`, name: "Ada Admin", password: `ada-correct-horse-${R}` };
const BEA: Person = { email: `bea.admin.${R}@example.test`, name: "Bea Admin", password: `bea-second-admin-${R}` };
const OLI: Person = { email: `oli.analyst.${R}@example.test`, name: "Oli Analyst", password: `oli-analyst-pass-${R}` };
const OTT: Person = { email: `ott.officer.${R}@example.test`, name: "Ott Officer", password: `ott-officer-pass-${R}` };
const CAM: Person = { email: `cam.compliance.${R}@example.test`, name: "Cam Compliance", password: `cam-compliance-pass-${R}` };
// T8's browser: section 32's harness — Playwright's Chromium from /opt/pw-browsers through playwright-core; one Chromium-driven suite at a time (src/infra/db/test-lock.ts)
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
let browserLock: TestLock | null = null;
const PIA = { email: `pia.password.${R}@example.com`, name: "Pia Password", password: `pw-pia-34-5-${R}` };
const GABE = { email: `gabe.google.${R}@example.com`, name: "Gabe Google" };
const VERA = { email: `vera.video.${R}@example.com`, name: "Vera Video" };
const CODY = { email: `cody.code.${R}@example.com` };
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const MARIA = loanN(1);
type Staff = { token: string; session_id: string; staff_user_id: string; roles: string[] };
type Borrower = { token: string; party_id: string };

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = ""; let loan1Id = ""; let mariaId = ""; let sweep: SweepReport;
let adaId = ""; let bea: Staff; let oli: Staff;
let pia: Borrower; let gabe: Borrower; let vera: Borrower; let ghost: Borrower; let cody: Borrower; let maria: Borrower;
let officerEscalationId = ""; let heldNoticeId = ""; let deadLetterId = "";
const logLines: string[] = [];

// ---------------------------------------------------------------- helpers over the API
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.34.5.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, "user-agent": "34.5-spec", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const as = (s: Staff, role?: string): Record<string, string> => ({ authorization: `Bearer ${s.token}`, ...(role ? { "x-staff-role": role } : {}) });
const settle = async (): Promise<void> => { await router.flows!.settle(); await router.agent?.settle(); await router.flows!.settle(); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
type EventRow = { id: string; type: string; actor_kind: string; actor_id: string; actor_role: string | null; payload: Json; occurred_at: string };
const events = async (type: string, where = "", params: unknown[] = []): Promise<EventRow[]> => db.query<EventRow>(`SELECT id::text AS id, type, actor_kind::text AS actor_kind, actor_id, actor_role, payload, occurred_at::text AS occurred_at FROM loan_events WHERE type = $1 ${where} ORDER BY loan_events.sequence`, [type, ...params]);
type ActionRow = { staff_user_id: string | null; session_id: string | null; route: string; method: string; subject_kind: string | null; subject_id: string | null; command: string | null; result: string; refusal_code: string | null; role: string | null };
/** The staff_actions rows of a session (34.1 rule 4 — written once the route answered, so the tests wait for the count they expect). */
async function actionsOf(sessionId: string, atLeast: number): Promise<ActionRow[]> {
  let rows: ActionRow[] = [];
  for (let i = 0; i < 150; i++) { rows = await db.query<ActionRow>(`SELECT staff_user_id::text AS staff_user_id, session_id::text AS session_id, route, method, subject_kind, subject_id, command, result, refusal_code, role FROM staff_actions WHERE session_id = $1 ORDER BY at, id`, [sessionId]); if (rows.length >= atLeast) return rows; await sleep(20); }
  return rows;
}

// ───────── T8's browser over the portal (src/console/ui/index.html served at /ops by this test's API server): a context per session with its cookie, every /ops/api answer captured with the role it was asked for (x-staff-role) and the role that acted (x-acted-as)
type Hit = { method: string; path: string; status: number; asked: string | null; acted_as: string | null; body: () => Promise<Json> };
type Portal = { page: Page; ctx: BrowserContext; hits: Hit[]; errors: string[]; label: string };
const RENDERED = "Number(document.body.dataset.rendered || 0)";
const rendered = (page: Page): Promise<number> => page.evaluate(RENDERED) as Promise<number>;
/** The page's render counter (`body[data-rendered]`, bumped when a view finished rendering, refused or not) moved past `after`. */
async function settled(page: Page, after: number): Promise<number> { await page.waitForFunction(`${RENDERED} > ${after}`, undefined, { timeout: 20_000 }); return rendered(page); }
const mainText = (page: Page): Promise<string> => page.locator("#main").innerText();
const refusalsOn = (page: Page): Promise<number> => page.locator("#main [data-refusal]").count();
const navLinks = (page: Page): Promise<{ view: string; kind: string; area: string }[]> => page.evaluate(`[...document.querySelectorAll("#nav a[data-view]")].map((a) => ({ view: a.dataset.view, kind: a.dataset.kind || "", area: a.dataset.area }))`) as Promise<{ view: string; kind: string; area: string }[]>;
const navSelector = (l: { view: string; kind: string }): string => `#nav a[data-view="${l.view}"][data-kind="${l.kind}"]`;
/** "no page renders a refusal string as its body": neither the server's code nor its reason reaches the screen as text. */
const clean = (text: string, where: string): void => assert.ok(!/ROLE_REQUIRED|role_required|this route needs|does not hold role/.test(text), `${where} rendered a refusal string as its body: ${text.slice(0, 300)}`);
async function openPortal(browser: Browser, s: Staff, label: string): Promise<Portal> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: "sm_staff", value: encodeURIComponent(s.token), domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Strict" }]);
  const page = await ctx.newPage(); const hits: Hit[] = []; const errors: string[] = [];
  page.on("response", (r: Response) => { const u = new URL(r.url()); if (!u.pathname.startsWith("/ops/api/")) return; const req = r.request(); hits.push({ method: req.method(), path: u.pathname + u.search, status: r.status(), asked: req.headers()["x-staff-role"] ?? null, acted_as: r.headers()["x-acted-as"] ?? null, body: () => r.json().catch(() => ({})) as Promise<Json> }); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/ops`, { waitUntil: "load", timeout: 60_000 });
  await settled(page, 0);
  return { page, ctx, hits, errors, label };
}
/** Click a sidebar link (or any selector) and wait for the view it opens to finish rendering; the answers it drew are the hits since the click. */
async function open(p: Portal, selector: string): Promise<Hit[]> { const before = p.hits.length; const n = await rendered(p.page); await p.page.click(selector); await settled(p.page, n); return p.hits.slice(before); }
async function pick(p: Portal, role: string): Promise<void> { const n = await rendered(p.page); await p.page.selectOption("#actorRole", role); await settled(p.page, n); }
/** Wait for an element the screen should show; a timeout names what the page did instead (the answers since `since`, the page's errors, the body). */
async function shown(p: Portal, selector: string, since: number): Promise<void> {
  try { await p.page.waitForSelector(selector, { timeout: 20_000 }); }
  catch (e) { throw new Error(`${p.label}: ${selector} never appeared — ${String(e).split("\n")[0]}; answers ${J(p.hits.slice(since).map((h) => [h.method, h.path, h.status, h.asked, h.acted_as]))}; errors ${J(p.errors)}; body: ${(await mainText(p.page)).slice(0, 600)}; out: ${await p.page.evaluate(`(document.querySelector(${JSON.stringify(selector.split(" ")[0])}) || {}).innerHTML || ""`)}`); }
}

// ───────── the staff (34.1's doors, as 34-1.spec.test.ts drives them)
async function codeToken(email: string): Promise<string> {
  const c = await api("POST", "/ops/api/auth/code", { email }); assert.equal(c.status, 200, J(c.body)); assert.equal(c.body["delivery"], "FAKE");
  const v = await api("POST", "/ops/api/auth/verify", { email, code: c.body["fake_code"] }); assert.equal(v.status, 200, J(v.body)); return v.body["token"] as string;
}
async function enrol(p: Person): Promise<string> { const token = await codeToken(p.email); const r = await api("POST", "/ops/api/auth/password", { token, password: p.password }); assert.equal(r.status, 200, J(r.body)); return r.body["staff_user_id"] as string; }
/** A session: the code (possession) and the password (knowledge) — 34.1 rule 1's two factors. */
async function staffSignIn(p: Person): Promise<Staff> {
  await codeToken(p.email);
  const r = await api("POST", "/ops/api/auth/signin", { email: p.email, password: p.password }); assert.equal(r.status, 200, J(r.body));
  return { token: r.body["token"] as string, session_id: r.body["session_id"] as string, staff_user_id: r.body["staff_user_id"] as string, roles: r.body["roles"] as string[] };
}
async function invite(by: Staff, p: Person, roles: readonly string[]): Promise<void> { const r = await api("POST", "/ops/api/staff/invite", { email: p.email, legal_name: p.name, roles, rationale: `${p.name} is a distinct natural person (${R})` }, as(by, "admin")); assert.equal(r.status, 200, J(r.body)); }

// ───────── the borrower doors (32.16 §2.0 the account door and Google; 32.16 the code door; 32.17 the video door; 33.1's invited homeowner)
async function byPassword(ip: string): Promise<Borrower> {
  const r = await api("POST", "/v1/borrower/auth/account", { action: "create", email: PIA.email, password: PIA.password }, {}, ip);
  assert.equal(r.status, 200, J(r.body)); assert.equal(typeof r.body["token"], "string", "a fresh e-mail: a session, not a code"); await settle();
  return { token: r.body["token"] as string, party_id: (r.body["party"] as Json)["party_id"] as string };
}
const REDIRECT_URI = "http://localhost/app/auth/google/callback";
async function byGoogle(fake: FakeOidcIdentity, ip: string): Promise<Borrower> {
  const s = await api("POST", "/v1/borrower/auth/oidc", { action: "start", provider: "google", redirect_uri: REDIRECT_URI, fake }, {}, ip); assert.equal(s.status, 200, J(s.body));
  const u = new URL(s.body["authorization_url"] as string);
  const r = await api("POST", "/v1/borrower/auth/oidc", { action: "callback", provider: "google", code: u.searchParams.get("code"), state: u.searchParams.get("state") }, { "x-fake-oidc": FAKE_OIDC_MARKER }, ip);
  assert.equal(r.status, 200, J(r.body)); await settle();
  return { token: r.body["token"] as string, party_id: (r.body["party"] as Json)["party_id"] as string };
}
async function byCode(email: string, ip: string): Promise<Borrower> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }, {}, ip); assert.equal(req.status, 200, J(req.body)); assert.equal(req.body["delivery"], "FAKE");
  const v = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, {}, ip); assert.equal(v.status, 200, J(v.body)); await settle();
  return { token: v.body["token"] as string, party_id: (v.body["party"] as Json)["party_id"] as string };
}
/** 32.17 rule 11: the video door with no bearer opens a provisional account (`Borrower (video)`, no contact) and the video session on it. */
async function byVideo(ip: string): Promise<Borrower> {
  const r = await api("POST", "/v1/borrower/video/sessions", {}, {}, ip); assert.equal(r.status, 201, J(r.body).slice(0, 300)); assert.equal(r.body["opened_account"], true); await settle();
  return { token: r.body["token"] as string, party_id: (r.body["party"] as Json)["party_id"] as string };
}
/** 32.17 rule 12: the name and the e-mail arrive through `video.identify` (the turn's tool), once. */
async function identify(b: Borrower, name: string, email: string): Promise<void> {
  await runtime.execute({ process: "32.17", name: "video.identify", loanId: "", actor: { kind: "agent", id: "borrower-app" }, run: { runId: `34-5-${R}`, modelVersion: "scripted", promptVersion: "34.5-spec" }, input: { party_id: b.party_id, fields: [{ path: "legal_name", value: name }, { path: "email", value: email }] } });
}

test.before(async () => {
  if (skip) return;
  browserLock = await acquireBrowserLock(DB_URL);   // T8 drives Chromium: one browser-driven suite at a time, in the shell suites' CI shard (src/infra/db/test-lock.ts)
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|portal|directory|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  clock.set(SEED_AT);
  // the FAKE feed publishes the day's sheet (20.1), the FAKE reviewers fill the roles Home lists; no analyst model (33.2's review runs its deterministic path)
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: new FakeRateFeed(), reviewers: new FakeReviewers({ delaySeconds: 0 }), analystLlm: null });
  // the partner's parties{servicer} row (33.1's ensurePartner finds it by legal name) doubles as the borrower surface's configured partner and the entry seed's demo partner
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, '{"phone": "+18005550199"}'::jsonb) RETURNING id::text AS id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id]))[0]!.id;
  const seed = await seedEntryDemo(runtime, { partner_id: partnerPartyId, nmlsr_id: DEMO_PARTNER.nmlsr_id }); assert.equal(seed.partner_id, partnerPartyId);
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId, llm: { client: scripted.client, model: "scripted" }, video: { tavus: fakeTavus, callbackSecret: CALLBACK_SECRET } });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  // the fixture book as of 2026-09-01 (33.1 T1): twelve monitored loans, twelve parties, eleven invitations, the reminder clocks
  const imp = await api("POST", "/v1/partner-book/imports", { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content_base64: Buffer.from(book.tape).toString("base64") }, supplement: { filename: "partner-book-demo-supplement.csv", content_base64: Buffer.from(book.supplement, "utf8").toString("base64") } }, { authorization: `Bearer ${TOKEN}`, "x-actor-id": "u-ops-analyst" }, "10.34.5.2");
  assert.equal(imp.status, 200, J(imp.body).slice(0, 600)); assert.equal(imp.body["rows_loaded"], 12); assert.equal(imp.body["invitations_sent"], 11);
  await settle();
  loan1Id = (await db.query<{ id: string }>(`SELECT id::text AS id FROM loans WHERE partner_party_id = $1 AND servicer_loan_number = $2`, [partnerPartyId, MARIA.servicer_loan_number]))[0]!.id;
  mariaId = (await db.query<{ party_id: string }>(`SELECT b.party_id::text AS party_id FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC LIMIT 1`, [loan1Id]))[0]!.party_id;
  // two weeks on: the sweep breaches the partner's late tape (33.1 rule 8 — the `ops_analyst` escalation) and the stale rate sheet; the reminders fall due tonight, not yet breached
  clock.set(NOW);
  sweep = await runtime.sweep(NOW); await settle();
  assert.ok(sweep.breaches.some((b) => b.code === TAPE_CLOCK), `the late-tape clock breached: ${J(sweep.breaches.map((b) => b.code))}`);
  // the rest of T1's fixture, as the platform writes such rows: an `officer` escalation (a section's dual-control ask on loan 1), a held notice on loan 1 (a delivery the registry held back), a dead letter (the FAKE print/mail adapter's message the outbox gave up on)
  const w = await runtime.uow.run({ loanId: loan1Id }, async (ctx) => { const esc = new EscalationService(ctx.events, ctx.clock); const e = esc.open({ kind: "officer", ownerRole: "officer", severity: "2", loanId: loan1Id, payload: { reason: "34.5-T1 fixture: a money act proposed by an analyst waits for an officer", command: "waiveLateCharge" } }, { kind: "agent", id: "servicing" }); officerEscalationId = e.id; return esc; }, { clock, commit: async (q) => { /* saved below with the events committed */ void q; } });
  await runtime.escalationRepo.save(w.result.list()[0]!, db);
  const template = (await db.query<{ code: string }>(`SELECT code FROM notice_templates ORDER BY code LIMIT 1`))[0]; assert.ok(template, "a notice template on the registry");
  heldNoticeId = (await db.query<{ id: string }>(`INSERT INTO notices (template_code, template_version, loan_id, recipient_party_ids, payload_hash, payload, status, held_reason, produced_at) VALUES ($1, '1', $2, ARRAY[$3]::uuid[], $4, '{"kind": "34.5-T1 fixture"}'::jsonb, 'held', 'no_delivery_address', $5::timestamptz) RETURNING id::text AS id`, [template.code, loan1Id, mariaId, createHash("sha256").update(`held-${R}`).digest("hex"), NOW]))[0]!.id;
  deadLetterId = (await db.query<{ id: string }>(`INSERT INTO integration_messages (adapter, direction, idempotency_key, status, error, attempts, last_attempt_at, loan_id, payload_summary) VALUES ('print-mail', 'out', $1, 'dead', 'FAKE print-mail: SFTP handshake failed after 5 attempts', 5, $2::timestamptz, $3, '{"kind": "notice", "vendor": "FAKE"}'::jsonb) RETURNING id::text AS id`, [`notice:${R}:${loan1Id}`, NOW, loan1Id]))[0]!.id;
  // 34.1: the bootstrap account holds the four staff roles on this nonprod (STAFF_BOOTSTRAP_ADMIN_ROLES, Q1); it enrols, signs in and invites a second admin and an analyst, who enrol and sign in
  clock.set(T_STAFF);
  const boot = await bootstrapStaffAdmin(runtime, ADA.email, { legal_name: ADA.name, roles: [...FOUR_ROLES], environment: "test" });
  assert.equal(boot.created, true); assert.deepEqual([...boot.roles], [...FOUR_ROLES]); adaId = boot.staff_user_id!;
  await enrol(ADA); const ada = await staffSignIn(ADA);
  await invite(ada, BEA, ["admin"]); await invite(ada, OLI, ["ops_analyst"]);
  await enrol(BEA); await enrol(OLI); bea = await staffSignIn(BEA); oli = await staffSignIn(OLI);
  assert.deepEqual(bea.roles, ["admin"]); assert.deepEqual(oli.roles, ["ops_analyst"]);
  // T2's accounts, each a minute apart: Maria (loan 1's invited homeowner) by e-mail code; Pia by e-mail and password; Gabe by Google; Vera through the video door, identified; a video visitor who never gave a name; Cody by code on a fresh e-mail
  clock.set(T_ACCOUNTS); maria = await byCode(MARIA.email!, "10.34.5.11"); assert.equal(maria.party_id, mariaId, "the code to the e-mail on file opens the provisioned party");
  clock.set(new Date(Date.parse(T_ACCOUNTS) + 1 * MIN).toISOString()); pia = await byPassword("10.34.5.12");
  await db.query(`UPDATE parties SET legal_name = $2 WHERE id = $1`, [pia.party_id, PIA.name]);   // DELTA-29: the account's name is captured on the identity card; the fixture writes it as the card would
  clock.set(new Date(Date.parse(T_ACCOUNTS) + 2 * MIN).toISOString()); gabe = await byGoogle({ email: GABE.email, name: GABE.name, email_verified: true }, "10.34.5.13");
  clock.set(new Date(Date.parse(T_ACCOUNTS) + 3 * MIN).toISOString()); vera = await byVideo("10.34.5.14"); await identify(vera, VERA.name, VERA.email); await settle();
  clock.set(new Date(Date.parse(T_ACCOUNTS) + 4 * MIN).toISOString()); ghost = await byVideo("10.34.5.15");
  clock.set(new Date(Date.parse(T_ACCOUNTS) + 5 * MIN).toISOString()); cody = await byCode(CODY.email, "10.34.5.16");
  clock.set(new Date(Date.parse(T_ACCOUNTS) + 6 * MIN).toISOString());
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); await browserLock?.release(); } });

/** Every leaf of a JSON value with its key path, for the contract scans. */
function leaves(v: unknown, path: string[] = [], out: { path: string[]; value: unknown }[] = []): { path: string[]; value: unknown }[] {
  if (Array.isArray(v)) v.forEach((x, i) => leaves(x, [...path, String(i)], out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Json)) leaves(x, [...path, k], out);
  else out.push({ path, value: v });
  return out;
}
const byId = <T extends { id: string }>(rows: readonly T[], id: string): T | undefined => rows.find((r) => r.id === id);

test("34.5-T1: Given the bootstrap account holding roles `[ops_analyst, officer, compliance, admin]` and the fixture book with two breached clocks, one open `ops_analyst` escalation, one open `officer` escalation, one held notice and one dead letter, when the account signs in and opens Home, then the page lists the clocks due within 24 hours and the breached clocks with code, subject and breach role, the open escalations counted by role, the work waiting for the session's held roles as one list where each row names the role it needs (both escalations, the held notice and the dead letter present), the dead-letter count, the roles a FAKE reviewer fills in this environment, and no request of the page was refused; given an account holding `[admin]` only, then Home answers 200 with the staff, access-review and controls tiles and one line naming the roles the other areas need, and its response carries no count or field derived from a borrower party, application or loan.", { skip }, async () => {
  // the bootstrap account signs in (34.1's two factors) — it holds the four roles — and opens Home: GET /ops/api/me, then the page's read, then the queue filtered by kind
  const ada = await staffSignIn(ADA); assert.deepEqual(ada.roles, [...FOUR_ROLES]); assert.equal(ada.staff_user_id, adaId);
  const me = await api("GET", "/ops/api/me", undefined, as(ada)); assert.equal(me.status, 200, J(me.body));
  const home = await api("GET", "/ops/api/portal/home", undefined, as(ada)); assert.equal(home.status, 200, J(home.body).slice(0, 400));
  const h = home.body;
  // the role that acted: the least-privileged role the route accepts that the account holds (34.1 rule 3: ops_analyst < officer < compliance < admin); the roles held; the areas the roles open — all eight
  assert.equal(h["acted_as"], "ops_analyst"); assert.deepEqual(h["roles"], [...FOUR_ROLES]); assert.deepEqual(h["ops_roles"], ["ops_analyst", "officer", "compliance"]);
  assert.deepEqual((h["areas"] as Json[]).map((a) => a["code"]), ["home", "people", "pipeline", "loans", "partner_book", "operations", "oversight", "staff"]);
  // the clocks: due within 24 hours and breached, each with code, subject and breach role — exactly the engine's rows
  const clocks = h["clocks"] as Json; assert.ok(clocks, "the clocks block");
  const breached = clocks["breached"] as Json[]; const due = clocks["due_24h"] as Json[];
  const breachedRows = await db.query<{ id: string; code: string; subject_kind: string; subject_id: string }>(`SELECT id::text AS id, code, subject_kind, subject_id FROM timers WHERE status = 'breached' ORDER BY breached_at`);
  assert.equal(breachedRows.length, 2, `the fixture's two breached clocks: ${J(breachedRows.map((t) => t.code))}`);
  assert.deepEqual(breached.map((t) => t["timer_id"]).sort(), breachedRows.map((t) => t.id).sort());
  assert.deepEqual(breached.map((t) => t["code"]).sort(), [SHEET_CLOCK, TAPE_CLOCK].sort(), "the partner's late tape and the stale rate sheet");
  for (const t of breached) { const row = breachedRows.find((r) => r.id === t["timer_id"])!; assert.deepEqual([t["code"], t["subject_kind"], t["subject_id"], t["status"]], [row.code, row.subject_kind, row.subject_id, "breached"]); assert.equal(typeof t["breach_role"], "string", `a breach role on ${row.code}`); assert.ok(t["breached_at"]); }
  const horizon = new Date(Date.parse(NOW) + 24 * 3600_000).toISOString();
  const dueRows = await db.query<{ id: string; code: string }>(`SELECT id::text AS id, code FROM timers WHERE status = 'armed' AND ((due_at IS NOT NULL AND due_at < $1::timestamptz) OR (due_at IS NULL AND due_date IS NOT NULL AND due_date < ($1::timestamptz)::date)) ORDER BY id`, [horizon]);
  assert.deepEqual(due.map((t) => t["timer_id"]).sort(), dueRows.map((t) => t.id).sort(), "the clocks due within 24 hours are the armed clocks whose due instant falls before now + 24h");
  assert.ok(due.some((t) => t["code"] === "SM_PARTNER_BOOK_INVITATION_REMINDER_14"), "the reminders fall due tonight");
  assert.ok(due.every((t) => typeof t["code"] === "string" && typeof t["subject_id"] === "string" && t["status"] === "armed" && (t["due_at"] || t["due_date"])));
  assert.deepEqual(clocks["counts"], { due_24h: due.length, breached: 2 });
  // the open escalations counted by role: the late tape's (ops_analyst), the fixture's officer ask — equal to the table
  const esc = h["escalations"] as Json; const byRole = esc["open_by_role"] as Record<string, number>;
  const expectedByRole: Record<string, number> = {}; for (const r of await db.query<{ owner_role: string; n: string }>(`SELECT owner_role, count(*)::text AS n FROM escalations WHERE completed_at IS NULL GROUP BY owner_role`)) expectedByRole[r.owner_role] = Number(r.n);
  assert.deepEqual(byRole, expectedByRole); assert.ok(byRole["ops_analyst"]! >= 1 && byRole["officer"]! >= 1, J(byRole)); assert.equal(esc["open"], Object.values(expectedByRole).reduce((a, b) => a + b, 0));
  // My queue: the work waiting for the held roles as ONE list, each row naming the role it needs — both escalations, the held notice and the dead letter present, the breached clocks too
  const q = h["my_queue"] as Json; assert.equal(q["title"], "My queue"); const rows = q["rows"] as (Json & { id: string })[]; assert.equal(q["count"], rows.length);
  assert.ok(rows.every((r) => typeof r["needs"] === "string" && (r["needs"] as string).length > 0 && Array.isArray(r["queue_roles"]) && typeof r["held"] === "boolean"), "every row names the role it needs");
  const late = rows.find((r) => r["kind"] === "escalation" && (r["detail"] as Json)["timer_code"] === TAPE_CLOCK); assert.ok(late, `the late-tape escalation among ${J(rows.map((r) => [r["kind"], r["needs"]]))}`); assert.deepEqual([late["needs"], late["held"]], ["ops_analyst", true]); assert.ok((late["queue_roles"] as string[]).includes("ops_analyst"));
  const officer = byId(rows, officerEscalationId); assert.ok(officer, "the officer escalation"); assert.deepEqual([officer["kind"], officer["needs"], officer["held"], officer["loan_id"]], ["escalation", "officer", true, loan1Id]); assert.deepEqual(officer["queue_roles"], ["officer"]);
  const held = byId(rows, heldNoticeId); assert.ok(held, "the held notice"); assert.deepEqual([held["kind"], held["needs"], held["loan_id"]], ["held_notice", "ops_analyst", loan1Id]); assert.deepEqual((held["queue_roles"] as string[]).sort(), ["compliance", "ops_analyst"]);
  const dead = byId(rows, deadLetterId); assert.ok(dead, "the dead letter"); assert.deepEqual([dead["kind"], dead["needs"], dead["held"], dead["loan_id"]], ["dead_letter", "fnma_portal_operator", false, loan1Id]); assert.deepEqual(dead["queue_roles"], ["ops_analyst"]);
  for (const t of breachedRows) { const r = byId(rows, t.id); assert.ok(r, `the breached clock ${t.code} on the queue`); assert.equal(r["kind"], "breached_timer"); }
  assert.equal(new Set(rows.map((r) => `${r["kind"]}:${r["id"]}`)).size, rows.length, "one row per item across the merged roles");
  const byKind = q["by_kind"] as Record<string, number>; assert.equal(byKind["escalation"]! >= 2 && byKind["held_notice"] === 1 && byKind["dead_letter"] === 1 && byKind["breached_timer"] === 2, true, J(byKind));
  // the dead-letter and held-notice counts; the roles a FAKE reviewer fills in this environment (the runtime's roster, marked FAKE)
  assert.deepEqual(h["counts"], { dead_letters: 1, held_notices: 1, portal_tasks: await count(`human_portal_tasks WHERE status IN ('open', 'in_progress')`) });
  assert.deepEqual(h["fake_reviewers"], { roles: [...runtime.reviewers!.roles], delay_s: 0, marker: "FAKE" });
  assert.ok((h["fake_reviewers"] as Json)["roles"] && ((h["fake_reviewers"] as Json)["roles"] as string[]).includes("underwriting_reviewer"));
  // the admin tiles ride along for an account that also holds admin; `?kind=` keeps the queue's filter
  assert.deepEqual(((h["admin"] as Json)["tiles"] as Json[]).map((t) => t["code"]), ["staff", "access_review", "controls"]);
  const filtered = await api("GET", "/ops/api/portal/home?kind=escalation", undefined, as(ada)); assert.equal(filtered.status, 200);
  const fq = (filtered.body["my_queue"] as Json)["rows"] as Json[]; assert.ok(fq.length >= 2 && fq.every((r) => r["kind"] === "escalation"), "the kind filter"); assert.equal(filtered.body["kind"], "escalation");
  // the look is logged (LOG_EVERY_LOOK): portal.home.viewed{staff_user_id, roles} with no borrower field
  const viewed = (await events("portal.home.viewed")).filter((e) => e.payload["staff_user_id"] === ada.staff_user_id);
  assert.equal(viewed.length, 2); assert.deepEqual(viewed[0]!.payload["roles"], [...FOUR_ROLES]); assert.deepEqual([viewed[0]!.actor_kind, viewed[0]!.actor_id, viewed[0]!.actor_role], ["human", ada.staff_user_id, "ops_analyst"]);
  // no request of the page was refused: every staff_actions row of this session answered ok (the sign-in, /me, the two reads)
  const actions = await actionsOf(ada.session_id, 4);
  assert.ok(actions.length >= 4, J(actions)); assert.ok(actions.every((a) => a.result === "ok" && a.refusal_code === null), `no refusal on the page: ${J(actions)}`);
  assert.ok(actions.some((a) => a.route === "/ops/api/portal/home" && a.command === "portal.home") && actions.some((a) => a.route === "/ops/api/portal/home?kind=escalation"));
  // an account holding [admin] only: Home answers 200 with the staff, access-review and controls tiles and one line naming the roles the other areas need — and no count or field derived from a borrower party, application or loan
  const admin = await api("GET", "/ops/api/portal/home", undefined, as(bea)); assert.equal(admin.status, 200, J(admin.body).slice(0, 400));
  const a = admin.body; assert.equal(a["acted_as"], "admin"); assert.deepEqual(a["roles"], ["admin"]); assert.deepEqual(a["ops_roles"], []);
  assert.deepEqual([a["clocks"], a["escalations"], a["my_queue"], a["counts"]], [null, null, null, null]);
  const tiles = (a["admin"] as Json)["tiles"] as Json[]; assert.deepEqual(tiles.map((t) => t["code"]), ["staff", "access_review", "controls"]);
  assert.equal((a["admin"] as Json)["other_areas"], OTHER_AREAS_NEED); for (const r of ["ops_analyst", "officer", "compliance"]) assert.ok(OTHER_AREAS_NEED.includes(r), `the line names ${r}`);
  assert.deepEqual((a["areas"] as Json[]).map((x) => x["code"]), ["home", "operations", "oversight", "staff"], "the areas an admin opens; none that would refuse");
  assert.deepEqual((tiles[0]!["detail"] as Json), { active: 3, invited: 0, disabled: 0 });
  const FORBIDDEN = /party|borrower|application|loan|escalation|notice|dead|timer|clock|breach|queue|servicer|partner/i;
  const ids = new Set([loan1Id, mariaId, pia.party_id, gabe.party_id, vera.party_id, ghost.party_id, cody.party_id, officerEscalationId, heldNoticeId, deadLetterId, partnerPartyId]);
  for (const leaf of leaves(a)) {
    if (leaf.value === null || leaf.value === undefined) continue;
    const key = leaf.path.filter((p) => !/^\d+$/.test(p)).join("."); const text = String(leaf.value);
    assert.ok(!ids.has(text), `${key} carries a borrower-side id: ${text}`);
    if (typeof leaf.value === "number") assert.ok(/^admin\.tiles\.detail\.(active|invited|disabled)$|^fake_reviewers\.delay_s$/.test(key), `a count an admin-only Home must not carry: ${key} = ${text}`);
    if (FORBIDDEN.test(key)) assert.ok(key === "admin.other_areas" || key.startsWith("admin.tiles"), `a borrower-derived field on an admin-only Home: ${key}`);
  }
  assert.equal(J(a).includes("FAKE reviewer"), false); assert.ok(!/\d{3}-\d{2}-\d{4}/.test(J(a)));
  const beaActions = await actionsOf(bea.session_id, 1); assert.ok(beaActions.filter((x) => x.route === "/ops/api/portal/home").every((x) => x.result === "ok"), J(beaActions));
});

test("34.5-T2: Given the fixture book imported (twelve partner-book parties, eleven invited), one account created by e-mail and password, one by Google, one by the video door that identified, one video-door party with an open session that never identified, and one signed in by code, when an `ops_analyst` opens People & accounts with no filter, then every identified borrower party is listed once, newest first by creation, each row carrying the name, masked e-mail and phone, origin (`front door`, `video door` or `partner book: <partner>`), the doors used, status (`invited` or `active`), the e-mail verification state, the stage, the subjects' last-four identifiers, the partner, and the created, first-seen and last-seen instants; the un-identified video party is not a row and its placeholder application is no subject of any row; `directory.listed{staff_user_id, filters_hash, results}` is logged with no filter text; and no row carries an unmasked e-mail or phone, an SSN, a date of birth, a credential hash or a token.", { skip }, async () => {
  // People & accounts, no filter, as the analyst — one page
  const r = await api("GET", "/ops/api/directory/list", undefined, as(oli)); assert.equal(r.status, 200, J(r.body).slice(0, 500));
  const b = r.body; const rows = b["rows"] as Json[];
  assert.deepEqual([b["tab"], b["sort"], b["acted_as"], b["page_size"], b["next"], b["results"]], ["accounts", "newest", "ops_analyst", LIST_PAGE_SIZE, null, rows.length]);
  // every identified borrower party is listed once, newest first by creation — the twelve partner-book parties and the four front-door / video-door accounts; the un-identified video party is not a row
  const expected = await db.query<{ id: string; created_at: string }>(`SELECT id::text AS id, created_at::text AS created_at FROM parties WHERE party_type = 'borrower' AND NOT (coalesce(contact->>'provisional', '') = 'video' AND coalesce(contact->>'email', '') = '') ORDER BY created_at DESC, id DESC`);
  assert.equal(expected.length, 16, "twelve partner-book parties and four identified accounts");
  assert.deepEqual(rows.map((x) => x["party_id"]), expected.map((x) => x.id), "newest first by creation, the id as the tiebreak");
  assert.equal(new Set(rows.map((x) => x["party_id"])).size, rows.length, "once each");
  assert.ok(!rows.some((x) => x["party_id"] === ghost.party_id), "the un-identified video party is not a row");
  const ghostApp = (await db.query<{ id: string }>(`SELECT a.id::text AS id FROM applications a JOIN application_borrowers ab ON ab.application_id = a.id WHERE ab.party_id = $1`, [ghost.party_id]))[0]; assert.ok(ghostApp, "its placeholder application exists");
  assert.ok(rows.every((x) => !(x["subjects"] as Json[]).some((s) => s["application_id"] === ghostApp.id)), "its placeholder application is no subject of any row");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE party_id = $1 AND revoked_at IS NULL AND expires_at > $2::timestamptz`, [ghost.party_id, clock.now()]))[0]!.n, "1", "the ghost's session is open — and still no row");
  // the columns, row by row: the name, masked e-mail and phone, origin, the doors used, status, the verification state, the stage, the subjects' last four, the partner, the instants
  const row = (id: string): Json => { const x = rows.find((y) => y["party_id"] === id); assert.ok(x, `a row for ${id}`); return x; };
  const origins = await originsOf(db, rows.map((x) => x["party_id"] as string));
  for (const x of rows) {
    assert.equal(x["origin"], origins.get(x["party_id"] as string)!.origin, "the origin exactly as the search derives it");
    assert.ok(["front door", "video door"].includes(x["origin_label"] as string) || (x["origin_label"] as string).startsWith("partner book: "));
    assert.ok(x["email"] === null || /^.…@/.test(x["email"] as string), `masked e-mail: ${x["email"]}`); assert.ok(x["phone"] === null || /^···\d{4}$/.test(x["phone"] as string), `masked phone: ${x["phone"]}`);
    assert.ok(["invited", "active"].includes(x["status"] as string)); assert.equal(typeof x["created_at"], "string"); assert.equal(x["verified"], x["email_verified_at"] !== null);
    if (x["status"] === "invited") assert.deepEqual([x["first_seen_at"], x["last_seen_at"], x["doors"]], [null, null, []]); else { assert.ok(x["first_seen_at"] && x["last_seen_at"] && (x["first_seen_at"] as string) <= (x["last_seen_at"] as string)); assert.ok((x["doors"] as string[]).length > 0); }
    assert.ok(Array.isArray(x["subjects"]) && (x["subjects"] as Json[]).every((s) => (s["loan_last4"] === null || /^····.{4}$/.test(s["loan_last4"] as string)) && (s["application_last4"] === null || /^····.{4}$/.test(s["application_last4"] as string))));
    if (x["legal_name"] !== null) assert.ok(!(x["legal_name"] as string).includes("@"), "a name, never an address");
  }
  // the partner book: twelve monitored rows on the fixture partner; eleven invited (no session), Maria active through the e-mail code — both doors, activated
  const bookRows = rows.filter((x) => x["origin"] === "partner_book"); assert.equal(bookRows.length, 12);
  for (const x of bookRows) { assert.equal(x["origin_label"], `partner book: ${DEMO_PARTNER.legal_name}`); assert.equal(x["stage"], "monitored"); assert.deepEqual(x["partner"], { partner_party_id: partnerPartyId, partner_name: DEMO_PARTNER.legal_name, source: "loan" }); assert.equal((x["subjects"] as Json[]).length, 1); }
  assert.equal(bookRows.filter((x) => x["status"] === "invited").length, 11); assert.equal(bookRows.filter((x) => x["status"] === "invited" && x["activated"] === false && x["email_verified_at"] === null).length, 11);
  const m = row(mariaId);
  assert.deepEqual([m["legal_name"], m["name_state"], m["email"], m["phone"], m["status"], m["stage"], m["activated"]], [MARIA.name, "captured", maskEmail(MARIA.email), maskPhone(MARIA.phone), "active", "monitored", true]);
  assert.deepEqual([m["origins"], m["doors"], m["door_methods"], m["signed_in_today"]], [[`partner book: ${DEMO_PARTNER.legal_name}`, "front door"], ["one-time code (e-mail)"], ["otp_email"], true]);
  assert.ok(m["email_verified_at"], "a code to the e-mail proved possession"); assert.deepEqual((m["subjects"] as Json[])[0]!["loan_last4"], `····${MARIA.servicer_loan_number.slice(-4)}`); assert.equal((m["subjects"] as Json[])[0]!["loan_id"], loan1Id);
  // the front door: Pia (e-mail and password — verified at once, the organic application), Gabe (Google — the provider's verified e-mail and display name), Cody (a code on a fresh e-mail: no application, the name not captured)
  const p = row(pia.party_id);
  assert.deepEqual([p["legal_name"], p["email"], p["origin"], p["origin_label"], p["origins"], p["doors"], p["status"], p["stage"], p["verified"]], [PIA.name, maskEmail(PIA.email), "front_door", "front door", ["front door"], ["password"], "active", "application", true]);
  assert.equal((p["subjects"] as Json[]).length, 1); assert.ok((p["subjects"] as Json[])[0]!["application_last4"]); assert.deepEqual(p["partner"], { partner_party_id: partnerPartyId, partner_name: DEMO_PARTNER.legal_name, source: "application" });
  const g = row(gabe.party_id);
  assert.deepEqual([g["legal_name"], g["email"], g["origin"], g["doors"], g["door_methods"], g["status"], g["stage"], g["verified"]], [GABE.name, maskEmail(GABE.email), "front_door", ["Google sign-in"], ["oidc_google"], "active", "application", true]);
  const c = row(cody.party_id);
  // a code sign-in on a fresh e-mail stays a lead-stage party (32.3 T15 / 32.14 DELTA-16): a live 20.3 lead names it and no application exists — the list's first stage
  assert.equal(await count(`entity_current WHERE kind = 'leads' AND data->>'party_id' = $1 AND coalesce(data->>'status', '') NOT IN ('converted', 'expired', 'closed_lost')`, [cody.party_id]), 1, "a live lead names Cody's party");
  assert.deepEqual([c["legal_name"], c["name_state"], c["email"], c["origin"], c["doors"], c["status"], c["stage"], c["verified"], c["subjects"]], [null, "not_captured", maskEmail(CODY.email), "front_door", ["one-time code (e-mail)"], "active", "lead", true, []]);
  assert.deepEqual(c["partner"], { partner_party_id: partnerPartyId, partner_name: DEMO_PARTNER.legal_name, source: "configured" }, "no subject: the configured entry partner");
  // the video door: Vera, identified — the name and the e-mail from video.identify (unverified), the doors she used
  const v = row(vera.party_id);
  assert.deepEqual([v["legal_name"], v["email"], v["origin"], v["origin_label"], v["doors"], v["door_methods"], v["status"], v["stage"], v["verified"], v["email_verified_at"]], [VERA.name, maskEmail(VERA.email), "video_door", "video door", ["video door"], ["video"], "active", "application", false, null]);
  assert.ok((v["origins"] as string[]).includes("video door"));
  // the look is logged as its hash (LOG_EVERY_LOOK / NO_PII_IN_LOG): directory.listed{staff_user_id, filters_hash, results} with no filter text; the action log's route carries the same hash
  const hash = listFiltersHash(canonicalListFilters(new URLSearchParams()));
  assert.equal(b["filters_hash"], hash); assert.equal(hash, createHash("sha256").update("{}").digest("hex"));
  const listed = (await events("directory.listed")).filter((e) => e.payload["staff_user_id"] === oli.staff_user_id);
  assert.equal(listed.length, 1); const ev = listed[0]!;
  assert.deepEqual([ev.actor_kind, ev.actor_id, ev.actor_role], ["human", oli.staff_user_id, "ops_analyst"]);
  assert.deepEqual(ev.payload, { staff_user_id: oli.staff_user_id, session_id: oli.session_id, filters_hash: hash, results: 16, tab: "accounts", next: false });
  const actions = await actionsOf(oli.session_id, 2); const look = actions.find((x) => x.command === "directory.list"); assert.ok(look, J(actions));
  assert.deepEqual([look.route, look.method, look.subject_kind, look.subject_id, look.result, look.refusal_code], [`/ops/api/directory/list?filters_hash=${hash}`, "GET", "list", hash, "ok", null]);
  // 34.2-T6's contract over every field: no unmasked e-mail or phone, no SSN, no date of birth, no credential hash, no token
  const text = J(b);
  for (const e of [MARIA.email!, PIA.email, GABE.email, VERA.email, CODY.email, ...book.loans.map((l) => l.email).filter((x): x is string => !!x)]) assert.ok(!text.toLowerCase().includes(e.toLowerCase()), `an unmasked e-mail: ${e}`);
  for (const ph of book.loans.map((l) => l.phone).filter((x): x is string => !!x)) { assert.ok(!text.includes(ph), `an unmasked phone: ${ph}`); assert.ok(!text.includes(ph.replace(/^\+1/, "")), `an unmasked phone: ${ph}`); }
  for (const t of [maria.token, pia.token, gabe.token, vera.token, ghost.token, cody.token, oli.token]) assert.ok(!text.includes(t), "a session token");
  assert.ok(!/\b\d{3}-\d{2}-\d{4}\b/.test(text), "an SSN shape"); assert.ok(!/\b(19|20)\d{2}-\d{2}-\d{2}\b(?!T)/.test(text.replace(/"(created_at|first_seen_at|last_seen_at|email_verified_at|as_of)":"[^"]*"/g, "")), "a date of birth");
  for (const leaf of leaves(b)) { const key = leaf.path.at(-1)!; assert.ok(!SECRET_KEYS.has(key) && !/date_of_birth|tin_last4|ssn|password/.test(key), `a secret key: ${leaf.path.join(".")}`); }
  const hashes = await db.query<{ h: string }>(`SELECT password_hash AS h FROM party_credentials UNION ALL SELECT token_hash FROM sessions`); for (const x of hashes) assert.ok(!text.includes(x.h), "a credential or token hash");
});

test("34.5-T3: Given the same accounts, when the analyst filters by origin `front_door`, by door `oidc_google`, by status `invited`, by stage `application`, by partner, by created-since and by last-seen-since, then each filter returns only the matching rows and `directory.counts` for the same filters returns totals by origin, by status, by stage and by created day that equal the rows; given more than 50 matches, then the list pages by a cursor of 50, `next` returns the remainder, and no party appears twice across pages.", { todo: true });
test("34.5-T4: Given the 100-loan transfer batch boarded without parties, a 21.1 interview application with no linked party, a lead created by `POST /v1/borrower/lead` that never authenticated, one video visit that ended before a name was given and one still open without a name, when an `ops_analyst`, an `officer` and a `compliance` session each open the \"Not yet an account\" tab, then the boarded borrowers and the interview are listed as `no account yet` with their kind (`boarded loan`, `interview`), the partner or the MLO of record, the created date and a last-four identifier only — no name, e-mail or phone; the lead is listed as `no account yet` with kind `lead`, its name when one was given, its e-mail and phone in full, its channel, its created date and its assurance level, the same to each of the three roles, each look logged as `directory.listed{staff_user_id, filters_hash, results}` carrying no name, e-mail or phone, and no route exports the tab or a lead (34.2's one-person export takes a party id only); an `admin` session is refused `ROLE_REQUIRED{role: ops_analyst}` before any read; both un-named video visits appear only in the count \"video visits, not identified\" and never as a row or a subject; the accounts tab of the same sessions stays masked; and when the lead later verifies and becomes a party, then it leaves this tab and appears in the accounts list with origin `front door` and its lead date as first contact.", { todo: true });
test("34.5-T5: Given a partner-book account listed as `invited` and a front-door account with an application, when the analyst opens each from the list, then 34.2's account page opens unchanged (identity masked, subjects, sessions, consents, activity stream) with the actions that belong to it — re-send the invitation (33.1 `account.invite{kind: reminder}` with a reason, once; a second is refused `REMINDER_CAP_1`), unmask (shown as `needs: officer or compliance` to the analyst), export (shown as `needs: compliance`) — and each action taken runs on the bus with `actor = {human, <staff_user_id>, <role>}`, writes one `staff_actions` row carrying the role, and appears in the account's activity stream as its own event.", { todo: true });
test("34.5-T6: Given applications on the fixture at `application` (a row with none of the four stage events), `decision` (`decision.issued`), `closing` (`clear_to_close.issued`) and `funded` (`loan.funded`), and one at `application` whose latest stage event is `application.trid_received`, when an `officer` opens Pipeline, then applications are listed by stage from lead to funded with the stage derived from the furthest of `application.trid_received`, `decision.issued`, `clear_to_close.issued` and `loan.funded` on the record (the events the `journey_progress` view reads), the per-stage counts sum to the number of applications, each row carries the borrower's masked name, the partner, the MLO of record, the channel, the application date and the next clock due, and each row opens the application page, which frames the record, the clocks, the escalations and the last ten acts and lists the stage's screen codes (`le_review`, `cd_review`, `conditions`, `closing_schedule`, `funding_release`) with the role each needs, from a static registry-shaped list.", { todo: true });
test("34.5-T7: Given the boarded demo book, the funded origination and the monitored partner-book loans, when an `ops_analyst` opens Loans, then serviced loans are listed with status, UPB, next due date, delinquency bucket, escrow flag, open cases (loss mitigation, foreclosure, bankruptcy), an open payoff request, transfer status and the partner, each figure read from the ledger and the owning sections' rows and never computed by the list; the monitored loans appear as `monitored` rows whose link opens the Partner book loan page; filters by status, delinquency bucket and case kind return only the matching loans; a loan row links to its borrower's account page and the account page's subject links back to the loan page.", { todo: true });
test("34.5-T8: Given one session per role (`ops_analyst`, `officer`, `compliance`, `admin`) and one session holding all four, when the portal renders its navigation and every area is opened through a real browser, then every link shown to a session answers 200 for that session, every area a session cannot open is absent from its navigation, a `GET` asked for with an `x-staff-role` the account holds but the route does not accept acts as the least-privileged accepted role the account holds and the response names it, a `POST` asked for with such a role is refused `ROLE_REQUIRED{role, act_as}` and the screen offers \"act as\" for each role in `act_as`, a role the account does not hold is refused `ROLE_REQUIRED{role}`, and no page renders a refusal string as its body.", { skip }, async () => {
  // one session per role — the analyst (Oli), an officer and a compliance officer the bootstrap admin invites (34.1), the second admin (Bea) — and one holding all four (Ada)
  const ada = await staffSignIn(ADA); assert.deepEqual(ada.roles, [...FOUR_ROLES]);
  await invite(ada, OTT, ["officer"]); await invite(ada, CAM, ["compliance"]); await enrol(OTT); await enrol(CAM);
  const sessions: Record<string, Staff> = { ops_analyst: await staffSignIn(OLI), officer: await staffSignIn(OTT), compliance: await staffSignIn(CAM), admin: await staffSignIn(BEA), all: ada };
  assert.deepEqual([sessions["ops_analyst"]!.roles, sessions["officer"]!.roles, sessions["compliance"]!.roles, sessions["admin"]!.roles], [["ops_analyst"], ["officer"], ["compliance"], ["admin"]]);
  // the navigation each session is shown (34.5 rule 1 and the server's gates): the ops roles open the work, the records and the oversight reads; compliance and admin the access review; admin the staff page; Pipeline and the Operations boards are increment 2
  const WORK = ["Home", "Escalations", "Portal tasks", "Held notices", "Dead letters", "Breached timers"];
  const OPS_AREAS = [...WORK, "People & accounts", "Loans", "Partner book", "Compliance Sentinel", "Controls", "Agents & AI path", "AI conversations"];
  const EXPECTED: Record<string, string[]> = { ops_analyst: OPS_AREAS, officer: OPS_AREAS, compliance: [...OPS_AREAS, "Access review"], admin: ["Home", "Controls", "Staff & roles", "Access review"], all: [...OPS_AREAS, "Staff & roles", "Access review"] };
  const ABSENT: Record<string, string[]> = { ops_analyst: ["Staff & roles", "Access review"], officer: ["Staff & roles", "Access review"], compliance: ["Staff & roles"], admin: ["People & accounts", "Loans", "Partner book", "Compliance Sentinel", "Agents & AI path", "AI conversations", "Escalations", "Dead letters"], all: [] };
  process.env["PLAYWRIGHT_BROWSERS_PATH"] = "/opt/pw-browsers";
  const pw = await import("playwright-core");
  const browser: Browser = await pw.chromium.launch({ headless: true, ...(existsSync(CHROME) ? { executablePath: CHROME } : {}) });
  const portals: Portal[] = [];
  try {
    for (const [label, s] of Object.entries(sessions)) {
      const p = await openPortal(browser, s, label); portals.push(p);
      assert.equal(await p.page.evaluate("document.body.dataset.renderedView"), "home", `${label} lands on Home, signed in`);
      // every area a session cannot open is absent from its navigation — and every one it can open is there, once, in the fixed order
      const links = await navLinks(p.page); const areas = links.map((l) => l.area);
      assert.deepEqual(areas, EXPECTED[label], `${label}'s navigation`); for (const a of ABSENT[label]!) assert.ok(!areas.includes(a), `${label} is shown ${a}`);
      // every link shown answers 200 for that session: each opened through the browser, every answer it drew 200, nothing refused on the screen, no refusal string as the body
      for (const l of links) {
        const drew = await open(p, navSelector(l));
        if (l.view !== "home" || l.kind) assert.ok(drew.length >= 1, `${label}: ${l.area} read nothing`);   // Home re-uses the read the sidebar's counts came from
        for (const h of drew) assert.equal(h.status, 200, `${label}: ${l.area} → ${h.method} ${h.path} answered ${h.status} (asked as ${h.asked})`);
        assert.equal(await refusalsOn(p.page), 0, `${label}: ${l.area} rendered a refusal`); clean(await mainText(p.page), `${label}: ${l.area}`);
        assert.equal(await p.page.evaluate("document.body.dataset.renderedView"), l.view);
      }
      // Home's first section is My queue for the ops roles (rule 2); an admin-only Home is the staff, access-review and controls tiles and the one line — no queue, no count
      await open(p, navSelector({ view: "home", kind: "" }));
      const body = await mainText(p.page);
      if (s.roles.some((r) => r !== "admin")) { assert.equal(await p.page.locator('#main h2[data-section="my_queue"]').count(), 1, `${label}: My queue`); assert.ok(/^My queue/.test(await p.page.locator('#main h2[data-section="my_queue"]').innerText())); assert.ok(body.includes("FAKE"), `${label}: the FAKE roster line`); }
      else { assert.equal(await p.page.locator('#main h2[data-section="my_queue"]').count(), 0); assert.deepEqual(await p.page.evaluate(`[...document.querySelectorAll("#main a[data-tile]")].map((t) => t.dataset.tile)`), ["staff", "access_review", "controls"]); assert.equal(await p.page.locator("#main [data-other-areas]").count(), 1); assert.ok(!/Dead letters|Held notices|Clocks/.test(body), `${label}: a borrower-derived tile on an admin-only Home`); }
      // the Controls tabs: the Evidence tab only when compliance is held (34.4 rule 5 — the mismatch fixed), and it answers 200 when shown
      await open(p, navSelector({ view: "controls", kind: "" }));
      const tabs = await p.page.evaluate(`[...document.querySelectorAll("#main .tabs button[data-tab]")].map((b) => b.dataset.tab)`) as string[];
      assert.deepEqual(tabs, s.roles.includes("compliance") ? ["clocks", "escalations", "outbox", "ai", "evidence"] : ["clocks", "escalations", "outbox", "ai"], `${label}'s Controls tabs`);
      if (s.roles.includes("compliance")) { const drew = await open(p, '#main .tabs button[data-tab="evidence"]'); const ev = drew.find((h) => h.method === "GET" && h.path.startsWith("/ops/api/controls/evidence")); assert.ok(ev && ev.status === 200, `${label}: the evidence packs`); }
      assert.deepEqual(p.errors, [], `${label}: page errors`);
      // the action log agrees (34.1 rule 4): nothing this session asked for through the navigation was refused
      const rows = await actionsOf(s.session_id, 3);
      assert.ok(rows.length >= 3 && rows.every((r) => r.result === "ok" && r.refusal_code === null), `${label}: a refused row among ${J(rows.filter((r) => r.result !== "ok"))}`);
    }
    const all = portals.find((p) => p.label === "all")!; const analyst = portals.find((p) => p.label === "ops_analyst")!; const admin = portals.find((p) => p.label === "admin")!;
    // a GET asked for with an x-staff-role the account holds but the route does not accept: the four-role session with "Act as" on admin opens People & accounts — the list acts as ops_analyst (the least-privileged accepted role held), the answer names it, the header says so, no refusal
    await pick(all, "admin");
    const drew = await open(all, navSelector({ view: "people", kind: "" }));
    const list = drew.find((h) => h.path.startsWith("/ops/api/directory/list")); assert.ok(list, J(drew));
    assert.deepEqual([list.status, list.asked, list.acted_as, (await list.body())["acted_as"]], [200, "admin", "ops_analyst", "ops_analyst"]);
    assert.equal(await all.page.locator("#actingAs").isVisible(), true); assert.equal(await all.page.locator("#actingAs").innerText(), "acting as ops_analyst");
    assert.equal(await refusalsOn(all.page), 0); assert.ok((await all.page.locator("#listout tbody tr").count()) >= 16, "the accounts listed");
    const listRow = (await actionsOf(ada.session_id, 1)).filter((r) => r.command === "directory.list").at(-1)!; assert.deepEqual([listRow.result, listRow.role], ["ok", "ops_analyst"], "the log row carries the role that acted");
    // a POST asked for with such a role: "Act as" on ops_analyst, the evidence pack (compliance's) requested for loan 1 — the read fell back to compliance and said so; the act is refused ROLE_REQUIRED{role: compliance, act_as: [compliance]} before any write, the screen offers "Act as compliance" and nothing else, and no refusal string is the body
    await pick(all, "ops_analyst");
    await open(all, navSelector({ view: "controls", kind: "" }));
    const evDrew = await open(all, '#main .tabs button[data-tab="evidence"]'); const evGet = evDrew.find((h) => h.method === "GET" && h.path.startsWith("/ops/api/controls/evidence"))!;
    assert.deepEqual([evGet.status, evGet.asked, evGet.acted_as], [200, "ops_analyst", "compliance"]); assert.equal(await all.page.locator("#actingAs").innerText(), "acting as compliance");
    const packsBefore = await count(`evidence_packs`);
    await all.page.fill('#evf input[name="id"]', loan1Id);
    let before = all.hits.length; await all.page.click('#evf button[type="submit"]'); await shown(all, '#evout [data-refusal="ROLE_REQUIRED"]', before);
    const evPost = all.hits.slice(before).find((h) => h.method === "POST" && h.path === "/ops/api/controls/evidence")!; assert.ok(evPost, J(all.hits.slice(before)));
    const refused = await evPost.body();
    assert.deepEqual([evPost.status, evPost.asked, evPost.acted_as, refused["code"], refused["role"], refused["held"], refused["act_as"]], [403, "ops_analyst", null, "ROLE_REQUIRED", "compliance", [...FOUR_ROLES], ["compliance"]]);
    assert.deepEqual(await all.page.evaluate(`[...document.querySelectorAll("#evout button[data-act-as]")].map((b) => b.dataset.actAs)`), ["compliance"], "one Act as button per role in act_as");
    assert.equal(await all.page.locator('#evout [data-refusal]').getAttribute("data-role"), "compliance"); clean(await mainText(all.page), "all: the refused pack");
    assert.equal(await count(`evidence_packs`), packsBefore, "nothing written");
    const refusedRow = (await actionsOf(ada.session_id, 1)).filter((r) => r.method === "POST" && r.route === "/ops/api/controls/evidence").at(-1)!;
    assert.deepEqual([refusedRow.result, refusedRow.refusal_code, refusedRow.role], ["refused", "ROLE_REQUIRED", "ops_analyst"], "the log row: refused, with the role asked for");
    // "Act as compliance" re-sends the same request with the role named — never silently — and the pack is produced as compliance
    before = all.hits.length; const n = await rendered(all.page); await all.page.click('#evout button[data-act-as="compliance"]'); await settled(all.page, n);
    const evOk = all.hits.slice(before).find((h) => h.method === "POST" && h.path === "/ops/api/controls/evidence")!; assert.ok(evOk, J(all.hits.slice(before)));
    const produced = await evOk.body(); assert.deepEqual([evOk.status, evOk.asked, evOk.acted_as], [200, "compliance", "compliance"]); assert.equal(typeof (produced["output"] as Json)["id"], "string");
    assert.equal(await count(`evidence_packs`), packsBefore + 1); assert.ok((await mainText(all.page)).includes("pack "), "the pack on the screen");
    const okRow = (await actionsOf(ada.session_id, 1)).filter((r) => r.command === "controls.evidence.pack" && r.result === "ok").at(-1)!; assert.equal(okRow.role, "compliance");
    // the same on a queue row's act: "Act as" on admin, Home's dead letter requeued — refused with every ops role the account holds offered (the legacy act is the ops roles'); the row stays dead
    await pick(all, "admin");
    await open(all, navSelector({ view: "home", kind: "" }));
    before = all.hits.length; await all.page.click(`#main tr[data-queue-row="dead_letter:${deadLetterId}"] button[data-act="dead_letter"]`); await shown(all, `[data-actout="dead_letter:${deadLetterId}"] [data-refusal="ROLE_REQUIRED"]`, before);
    const rq = all.hits.slice(before).find((h) => h.method === "POST" && h.path === "/ops/api/outbox/requeue")!; const rqBody = await rq.body();
    assert.deepEqual([rq.status, rq.asked, rqBody["role"], rqBody["act_as"]], [403, "admin", "ops_analyst", ["ops_analyst", "officer", "compliance"]]);
    assert.deepEqual(await all.page.evaluate(`[...document.querySelectorAll('[data-actout="dead_letter:${deadLetterId}"] button[data-act-as]')].map((b) => b.dataset.actAs)`), ["ops_analyst", "officer", "compliance"]);
    assert.equal((await db.query<{ status: string }>(`SELECT status FROM integration_messages WHERE id = $1`, [deadLetterId]))[0]!.status, "dead"); clean(await mainText(all.page), "all: the refused requeue");
    // a role the account does not hold is refused ROLE_REQUIRED{role} on either method, act_as empty — asked for by name from the analyst's browser, and an area reached by address (#staff): the page is a line naming admin with no offer, never the refusal string
    const notHeld = await analyst.page.evaluate(`fetch("/ops/api/staff", { headers: { "x-staff-role": "admin" }, credentials: "same-origin" }).then(async (r) => ({ status: r.status, acted: r.headers.get("x-acted-as"), body: await r.json() }))`) as { status: number; acted: string | null; body: Json };
    assert.deepEqual([notHeld.status, notHeld.acted, notHeld.body["code"], notHeld.body["role"], notHeld.body["held"], notHeld.body["act_as"]], [403, null, "ROLE_REQUIRED", "admin", ["ops_analyst"], []]);
    const notHeldPost = await analyst.page.evaluate(`fetch("/ops/api/staff/invite", { method: "POST", headers: { "x-staff-role": "admin", "content-type": "application/json" }, credentials: "same-origin", body: "{}" }).then(async (r) => ({ status: r.status, body: await r.json() }))`) as { status: number; body: Json };
    assert.deepEqual([notHeldPost.status, notHeldPost.body["code"], notHeldPost.body["role"], notHeldPost.body["act_as"]], [403, "ROLE_REQUIRED", "admin", []]);
    for (const [p, hash, role, path] of [[analyst, "#staff", "admin", "/ops/api/staff"], [admin, "#people", "ops_analyst", "/ops/api/directory/list"]] as const) {
      before = p.hits.length; const m = await rendered(p.page); await p.page.evaluate(`location.hash = "${hash}"`); await settled(p.page, m);
      const hit = p.hits.slice(before).find((h) => h.path.startsWith(path))!; assert.ok(hit, `${p.label}: ${hash} asked ${path}`); const b = await hit.body();
      assert.deepEqual([hit.status, hit.acted_as, b["code"], b["role"], b["act_as"]], [403, null, "ROLE_REQUIRED", role, []], `${p.label}: ${hash}`);
      assert.equal(await refusalsOn(p.page), 1, `${p.label}: one refusal line`); assert.equal(await p.page.locator("#main [data-refusal]").getAttribute("data-role"), role); assert.equal(await p.page.locator("#main button[data-act-as]").count(), 0, `${p.label}: nothing to offer`);
      const text = await mainText(p.page); clean(text, `${p.label}: ${hash}`); assert.ok(text.includes(role), `${p.label}: the line names ${role}`);
      assert.deepEqual(p.errors, [], `${p.label}: page errors`);
    }
  } finally { for (const p of portals) await p.ctx.close().catch(() => undefined); await browser.close().catch(() => undefined); }
});
test("34.5-T9: Given 34.1's action log with reads, writes and refusals by two staff members on two subjects, when `compliance` opens Oversight → Action log filtered by person, by subject and by date, then the rows list time, person id, role (from `staff_actions.role`), route, subject ids, the bus command, the result and the refusal code, the filters return only the matching rows, and no row carries a name, an e-mail, a phone number or a money figure; given an `ops_analyst`, then the same page lists only their own rows.", { todo: true });
test("34.5-T10: Given the bundles `analyst = [ops_analyst]`, `servicing officer = [ops_analyst, officer]`, `compliance officer = [compliance]` and `administrator = [admin]`, when an `admin` invites a colleague with the bundle `servicing officer`, then `staff.invite` runs with the expanded roles, `staff.invited{roles}` carries the two roles and the decision's rationale names the bundle; when an admin defines a bundle pairing `compliance` with `officer` or `ops_analyst`, then it is refused `BUNDLE_SEPARATION`; when an admin applies a bundle to their own row, then `NO_SELF_ROLE_CHANGE`; given a bundle naming a role outside `STAFF_ROLES ∪ HUMAN_ROLES`, then it is refused `UNKNOWN_ROLE`.", { todo: true });
test("34.5-T11: Given the six tools `portal.home`, `directory.list`, `directory.counts`, `pipeline.list`, `loans.list` and `notice.read`, then every table is identical before and after each tool except `staff_actions`, `access_log` and this process's own look events in `loan_events`; no `ledger_lines`, `timers`, `notices`, `parties`, `applications` or `loans` row changed (contract test); every request wrote one `staff_actions` row with ids and the role only; and every response passes 34.2-T6's contract (no full SSN, credential hash, session token or vendor payload in any field).", { todo: true });
test("34.5-T12: Given one `ops_analyst` session paging `directory.list` past 20 pages in one day, or reading more than 1,000 rows across `directory.list`, `pipeline.list` and `loans.list`, then one `compliance` escalation opens with the person id, the page and row counts and the day (`LIST_VOLUME`), a second day's paging opens a second, `directory.counts` never counts toward it, and the person named cannot complete the escalation (`SELF_SUBJECT`).", { todo: true });
test("34.5-T13: Given the owner holding `compliance` who unmasks 21 people in a day, then the 34.2 volume escalation opens naming their `staff_user_id`; their `controls.escalation.complete` on it is refused `SELF_SUBJECT`; with no other active `compliance` holder it is listed to `admin` as \"open until a second person\" and appears in the next access review's rationale; given a second `compliance` account, then that person completes it.", { todo: true });
test("34.5-T14: Given a platform with one active staff account, when it runs `staff.access.review` with `keep` on its own row and a rationale naming the single-operator condition, then the review's `users` entry for that row reads `self_attested` and the clock is satisfied; given two active accounts, when one runs the review with `keep` on its own row, then it is refused `SELF_REVIEW` and nothing is written; when the other runs it, then it completes with no `self_attested` entry.", { todo: true });
test("34.5-T15: Given a party with two sent notices and one held, when an `ops_analyst` opens a notice from the account page and from the loan page, then `notice.read` returns the rendered text as delivered with contact fields masked by role, `notice.read{staff_user_id, notice_id}` is logged, the look appears in the activity stream as `staff_look`, and given a `compliance` session with an open unmask, then the same text unmasked; no notice row changed.", { todo: true });
test("34.5-T16: Given fixture loan L-1 with an assessed late charge, when the loan page's officer waiver action is taken as `ops_analyst`, then 403 `ROLE_REQUIRED{role: officer, act_as: []}` and no ledger, event or decision row is written; when the same session holds `officer` and takes it as `ops_analyst`, then `ROLE_REQUIRED{role: officer, act_as: [officer]}` and nothing is written; when it is taken as `officer` with a rationale, then 2.7's courtesy waiver tool runs on the bus with `actor = {human, <staff_user_id>, officer}`, the ledger set it writes balances with its own `rule_ref`, the decision record carries the rationale, and the `staff_actions` row records `officer`.", { todo: true });
