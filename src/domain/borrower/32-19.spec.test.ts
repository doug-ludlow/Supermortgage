// 32.19 The Apply product
// spec/sections/32-borrower-experience/32-19-the-apply-product.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness is 32.13's (src/domain/borrower/harness.ts): one runtime over HTTP with every 32.x flow reacting to the
// committed events, read the way the page reads it (the borrower API: me, record, thread, cards, commands), plus the Apply
// product itself — the built Next.js app (apps/borrower, `.next-t13`, rebuilt when a source is newer) pointed at this
// test's API through its proxy and driven with Playwright's Chromium at 390 and 1280 px. Every clause is asserted
// against the database or the API, never the DOM alone. Accounts open through the real account door
// (`POST /v1/borrower/auth/account`, `landSession` → the organic application); T2 drives the door's own form, the others
// take the session cookie (ACCOUNT_PER_HOUR is per IP, and every browser request reaches the API from 127.0.0.1).
// Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { acquireBrowserLock, type TestLock } from "../../infra/db/test-lock.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { CONSENTS_VERSION } from "../../runtime/borrower/flows/3-entry.ts";
import { createHarness, type Context, type Page } from "./harness.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const NOW = "2026-09-10T16:00:00.000Z";
const clock = new FixedClock(NOW);
type Json = Record<string, unknown>;

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";
const H = createHarness({ apiBase: () => base });
const { pageFor, openApply, stopShell } = H;

let browserLock: TestLock | undefined;
test.before(async () => {
  if (skip) return;
  browserLock = await acquireBrowserLock(DB_URL);   // one Chromium-driven suite at a time (src/infra/db/test-lock.ts)
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`]))[0]!.id;
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  await seedEntryDemo(runtime, { partner_id: partnerPartyId, states: ["AZ", "CO", "TX"], now: NOW });   // the entry partner and its open states (the account door's organic application, 20.3's preapproval request)
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) { await stopShell(); await close(); await browserLock?.release(); } });

// ---------------------------------------------------------------- the borrower API and the tables (32.13's helpers)
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const settle = () => router.flows!.settle();
let ipN = 0;
/** The account door over the API from its own IP (ACCOUNT_PER_HOUR = 20 per IP): the session token (the proxy's cookie value) and the party; `landSession` created the organic application. */
async function account(label: string): Promise<{ email: string; token: string; party_id: string; application_id: string }> {
  const R = randomUUID().slice(0, 8); const email = `${label}-${R}@example.test`; ipN += 1;
  const r = await api("POST", "/v1/borrower/auth/account", { action: "create", email, password: `pw-${label}-${R}` }, undefined, { "x-forwarded-for": `10.19.${Math.floor(ipN / 200) + 1}.${(ipN % 200) + 1}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await settle();
  const party_id = (r.body["party"] as Json)["party_id"] as string;
  const app = await applicationOf(party_id); assert.ok(app, "landSession created the organic application");
  return { email, token: r.body["token"] as string, party_id, application_id: app.id };
}
interface AppRow { id: string; channel: string; transaction_type: string; occupancy: string }
const applicationOf = async (partyId: string): Promise<AppRow | undefined> => (await db.query<AppRow & Record<string, unknown>>(`SELECT a.id, a.channel::text AS channel, a.transaction_type::text AS transaction_type, a.occupancy::text AS occupancy FROM applications a JOIN application_borrowers ab ON ab.application_id = a.id WHERE ab.party_id = $1 ORDER BY a.created_at LIMIT 1`, [partyId]))[0];
interface CardRow { card_instance_id: string; kind: string; status: string; copy_key: string; props: Json; evidence: Json | null; command_ref: string | null; resolved_at: string | null; seq: string }
const cardsOf = async (partyId: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Record<string, unknown>>(`SELECT card_instance_id, kind, status, copy_key, props, evidence, command_ref, resolved_at, seq::text AS seq FROM card_instances WHERE party_id = $1 ORDER BY seq`, [partyId]); };
const card = (cards: CardRow[], key: string): CardRow | undefined => cards.filter((c) => c.copy_key === key).at(-1);
interface EventRow { sequence: string; type: string; payload: Json }
const events = async (appId: string): Promise<EventRow[]> => { await settle(); return db.query<EventRow & Record<string, unknown>>(`SELECT sequence::text AS sequence, type, payload FROM loan_events WHERE application_id = $1 ORDER BY sequence`, [appId]); };
const intake = async (appId: string): Promise<Json | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'applications' AND id = $1`, [appId]); return rows[0] ? (decodeEntityData(rows[0].data) as Json) : null; };
interface PropertyRow { address_line1: string | null; city: string | null; state: string | null; postal_code: string | null; property_type: string | null; units: number | null; estate_type: string | null; existing_clean_energy_lien: boolean | null; is_subject: boolean; estimated_value_cents: string | null }
const propertiesOf = (appId: string) => db.query<PropertyRow & Record<string, unknown>>(`SELECT address_line1, city, state, postal_code, property_type, units, estate_type, existing_clean_energy_lien, is_subject, estimated_value_cents::text AS estimated_value_cents FROM application_properties WHERE application_id = $1 ORDER BY created_at`, [appId]);
interface ConsentRow { kind: string; status: string; scope: string[] }
const consentsOf = (partyId: string, appId: string) => db.query<ConsentRow & Record<string, unknown>>(`SELECT kind::text AS kind, status, scope FROM consents WHERE party_id = $1 AND application_id = $2 ORDER BY captured_at, id`, [partyId, appId]);
const sessionsOf = (partyId: string) => db.query<{ level: string; auth_method: string; revoked_at: string | null }>(`SELECT level, auth_method, revoked_at FROM sessions WHERE party_id = $1 ORDER BY created_at`, [partyId]);

// ---------------------------------------------------------------- driving the screens (docs/ux/18 §2.5 test hooks; the labels are the copy library's)
const root = (page: Page) => page.locator('[data-testid="apply"]');
const attr = async (page: Page, name: string): Promise<string | null> => root(page).first().getAttribute(name);
const noError = async (page: Page, what: string): Promise<void> => { const n = await page.getByTestId("apply-error").count(); assert.equal(n, 0, `${what}: no .sm-error (${n ? await page.getByTestId("apply-error").first().innerText() : ""})`); };
async function continueTo(page: Page, step: string, what: string): Promise<void> {
  await page.getByTestId("apply-continue").first().click();
  try { await page.waitForSelector(`[data-testid="apply"][data-step="${step}"]`, { timeout: 60_000 }); }
  catch (e) { const err = await page.getByTestId("apply-error").allInnerTexts().catch(() => [] as string[]); throw new Error(`${what}: did not reach step ${step} (now ${await attr(page, "data-step")}); error=${JSON.stringify(err)}; logs=${JSON.stringify(page.logs?.slice(-8))}; ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }
  await noError(page, what);
}
/** The goal screen: Buy a home / Refinance my home (+ the refinance purpose), the occupancy, Continue → property. */
async function goal(page: Page, intent: "buy" | "refi", occupancy: "My primary home" | "A second home" | "An investment property", purpose?: "Lower payment" | "Pay off sooner" | "Take cash out"): Promise<void> {
  await page.waitForSelector('[data-testid="apply"][data-step="goal"]', { timeout: 30_000 });
  await page.getByRole("button", { name: intent === "buy" ? "Buy a home" : "Refinance my home" }).first().click();
  if (purpose) await page.getByRole("button", { name: purpose }).first().click();
  await page.getByRole("button", { name: occupancy }).first().click();
  await continueTo(page, "property", "goal");
}
const fill = async (page: Page, label: string, value: string): Promise<void> => page.getByLabel(label, { exact: true }).first().fill(value);
const pick = async (page: Page, label: string, option: string): Promise<void> => { await page.getByLabel(label, { exact: true }).first().selectOption({ label: option }); };
/** The consents statement above Property's Continue is the goal card's own (`props.statement`, `statement_version`). */
async function consentsStatement(page: Page): Promise<{ text: string; version: string | null }> {
  const el = page.getByTestId("apply-consents").first(); await el.waitFor({ timeout: 60_000 });
  return { text: (await el.innerText()).trim(), version: await el.getAttribute("data-statement-version") };
}
const seqOf = (evs: EventRow[], type: string, where: (p: Json) => boolean = () => true): number | null => { const e = evs.find((x) => x.type === type && where(x.payload)); return e ? Number(e.sequence) : null; };
const closeAll = async (...pages: { ctx: Context }[]): Promise<void> => { for (const p of pages) await p.ctx.close(); };
/** The API requests the page posted through its proxy (harness `page.requests`: `METHOD path body`), those matching `re`. */
const posted = (page: Page, re: RegExp): string[] => (page.requests ?? []).filter((r) => r.startsWith("POST ") && re.test(r));
const bodyOf = (line: string): Json => { const i = line.indexOf(" {"); return i >= 0 ? (JSON.parse(line.slice(i + 1)) as Json) : {}; };
interface BorrowerRow { id: string; legal_name: string | null; date_of_birth: string | null; tin_last4: string | null; citizenship_status: string | null; marital_status: string | null; language_preference: string | null; prefill: Json }
const borrowerOf = async (appId: string, partyId: string): Promise<BorrowerRow> => { const r = (await db.query<BorrowerRow & Record<string, unknown>>(`SELECT id, legal_name, date_of_birth::text AS date_of_birth, tin_last4, citizenship_status, marital_status, language_preference, prefill FROM application_borrowers WHERE application_id = $1 AND party_id = $2`, [appId, partyId]))[0]; assert.ok(r, "the application_borrowers row"); return r; };
interface ResidenceRow { residency_type: string; residency_basis: string; monthly_rent_cents: string | null; address_line_text: string | null; city_name: string | null; state_code: string | null; postal_code: string | null; duration_months: number }
const residencesOf = (abId: string) => db.query<ResidenceRow & Record<string, unknown>>(`SELECT residency_type, residency_basis, monthly_rent_cents::text AS monthly_rent_cents, address_line_text, city_name, state_code, postal_code, duration_months FROM du_residences WHERE application_borrower_id = $1 ORDER BY residency_type`, [abId]);
const fieldOf = (c: CardRow | undefined, path: string): Json | undefined => ((c?.evidence?.["fields"] as Json[] | undefined) ?? []).find((f) => f["path"] === path);
/** The addressed purchase's goal and property (T3's inputs) up to the You screen. */
async function buyToYou(page: Page): Promise<void> {
  await goal(page, "buy", "My primary home");
  await fill(page, "Property address", "24 Juniper Lane, Austin, TX 78701"); await fill(page, "State", "TX"); await fill(page, "Price", "650000"); await fill(page, "Down payment", "130000");
  await pick(page, "Do you own the land, or is it a leasehold?", "I own the land"); await pick(page, "Is there a PACE or clean-energy loan on the home?", "No");
  await consentsStatement(page);
  await continueTo(page, "you", "property");
}
/** The You screen: the name, the birth date, the SSN, "I live here as", the months (the prior panel when under 24), Continue → connect. */
async function you(page: Page, o: { name: string; dob: string; ssn: string; basis?: "Own" | "Rent" | "Rent-free"; rent?: string; months: string; prior?: { street: string; city: string; state: string; zip: string; basis: "Own" | "Rent" | "Rent-free"; rent?: string; months: string } }): Promise<void> {
  await page.waitForSelector('[data-testid="apply"][data-step="you"]', { timeout: 30_000 });
  await fill(page, "Legal name", o.name); await fill(page, "Date of birth", o.dob); await fill(page, "Social Security number", o.ssn);
  await page.getByRole("button", { name: new RegExp(`^${o.basis ?? "Own"}$`) }).first().click();
  if (o.rent !== undefined) await fill(page, "Monthly rent", o.rent);
  await fill(page, "Months at this address", o.months);
  if (o.prior) {
    await page.getByTestId("apply-prior-address").first().waitFor({ timeout: 10_000 });
    await fill(page, "Prior street address", o.prior.street); await fill(page, "Prior city", o.prior.city); await fill(page, "Prior state", o.prior.state); await fill(page, "Prior ZIP code", o.prior.zip);
    await pick(page, "How you lived there", o.prior.basis); if (o.prior.rent !== undefined) await fill(page, "Monthly rent there", o.prior.rent);
    await fill(page, "Months you lived there", o.prior.months);
  }
  await continueTo(page, "connect", "you");
}
/** The Connect screen: the monthly income and the employer, "Connect and continue" → details. */
async function connectStep(page: Page, income: string, employer: string): Promise<void> {
  await page.waitForSelector('[data-testid="apply"][data-step="connect"]', { timeout: 30_000 });
  await fill(page, "Monthly income", income); await fill(page, "Employer", employer);
  assert.equal((await page.getByTestId("apply-continue").first().innerText()).trim(), "Connect and continue", "the CTA is apply.connect.cta");
  await continueTo(page, "details", "connect");
}

test("32.19-T1: The door — Given a new browser with no cookies, when `/app` renders, then `[data-testid=\"apply\"][data-door=\"welcome\"]` renders on `.sm-proto` paper with the mark and a 430 px column at 1280 (full width at 390), no `thread`, `record` or `action-bar` test id exists, `footer.disclosure` is on the screen, Continue renders `data-door=\"intro\"`, \"Create an account\" renders `Account` in `sign_up`, and \"Already have an account?\" renders it in `sign_in`.", { skip }, async () => {
  const wide = await openApply(null, 1280); const { page } = wide;
  // a new browser with no cookies: the door on the .sm-proto paper, the mark, a 430 px column at 1280
  assert.equal(await attr(page, "data-door"), "welcome"); assert.equal(await attr(page, "data-tab"), null); assert.equal(await attr(page, "data-step"), null);
  assert.equal(await page.locator(".sm-proto").count(), 1, "the .sm-proto paper");
  assert.equal(await page.evaluate<string>("getComputedStyle(document.querySelector('.sm-phone')).backgroundColor"), "rgb(252, 252, 252)", "apply.css's --paper token on the column");
  const column = await page.locator(".sm-phone").first().boundingBox(); assert.ok(column && Math.round(column.width) === 430, `a 430 px column at 1280 (${column?.width})`);
  assert.ok(await page.locator(".sm-mark .sm-mark-s").first().isVisible(), "the mark"); assert.equal((await page.locator(".sm-mark-name").first().innerText()).trim(), "Supermortgage");
  for (const id of ["thread", "record", "action-bar", "shell", "tab-nav"]) assert.equal(await page.getByTestId(id).count(), 0, `no ${id} test id on /app`);
  assert.equal(await page.getByTestId("footer-disclosure").count(), 1, "footer.disclosure on the door");
  assert.match(await page.getByTestId("footer-disclosure").first().innerText(), /This chat is AI-powered\. Chats are recorded for quality\./, "the footer sentence is footer.disclosure's");
  assert.equal(await page.getByTestId("account").count(), 0, "nothing personal is asked before the account form");
  assert.equal(await page.getByTestId("apply-tab-apply").count(), 0, "the tabs are not offered signed out");
  // Continue → intro
  await page.getByTestId("apply-continue").first().click();
  await page.waitForSelector('[data-testid="apply"][data-door="intro"]', { timeout: 30_000 });
  assert.equal(await page.getByTestId("footer-disclosure").count(), 1, "footer.disclosure on the intro");
  assert.match(await page.locator(".sm-bubble").first().innerText(), /What is Supermortgage\?/);
  // "Create an account" → Account in sign_up
  await page.getByRole("button", { name: "Create an account" }).first().click();
  await page.waitForSelector('[data-testid="apply"][data-door="account"] [data-testid="account"][data-mode="sign_up"]', { timeout: 30_000 });
  assert.equal(await page.getByTestId("footer-disclosure").count(), 1, "footer.disclosure on the account door");
  assert.equal(await page.locator('[data-testid="account-form"] input[type="email"]').count(), 1, "Account's e-mail + password form");
  assert.equal(await page.locator('[data-testid="account-form"] input[type="password"]').count(), 1);
  assert.equal(await page.getByTestId("account-google").count(), 1, "Continue with Google beside the form (walk outcome 1)");
  // back through the mark: "Already have an account?" → Account in sign_in
  await page.locator(".sm-mark").first().click(); await page.waitForSelector('[data-testid="apply"][data-door="welcome"]', { timeout: 30_000 });
  await page.getByTestId("apply-continue").first().click(); await page.waitForSelector('[data-testid="apply"][data-door="intro"]', { timeout: 30_000 });
  await page.getByRole("button", { name: "Already have an account?" }).first().click();
  await page.waitForSelector('[data-testid="apply"][data-door="account"] [data-testid="account"][data-mode="sign_in"]', { timeout: 30_000 });
  assert.equal(await page.getByTestId("account-code-request").count(), 1, "the code door beside Sign in (33.1 rule 5)");
  // nothing opened a session: the API still answers 401 to a bare me, and the browser holds no session cookie
  assert.equal((await api("GET", "/v1/borrower/me")).status, 401);
  assert.equal((await wide.ctx.cookies()).filter((c) => c.name === "sm_borrower_session").length, 0, "no session cookie");
  // full width at 390
  const phone = await openApply(null, 390);
  const box = await phone.page.locator(".sm-phone").first().boundingBox(); assert.ok(box && Math.round(box.width) === 390, `full width at 390 (${box?.width})`);
  assert.equal(await phone.page.getByTestId("footer-disclosure").count(), 1);
  assert.equal(await phone.page.evaluate<number>("document.documentElement.scrollWidth"), 390, "no horizontal scroll at 390");
  await closeAll(wide, phone);
});
test("32.19-T2: The account lands on Apply — Given the account door, when an e-mail + password account is created (or the FAKE Google form under `INTEGRATIONS=fake`), then `sessions{level: L1, auth_method: password | oidc_google}` opens, `GET /v1/borrower/me` lists the organic application (`channel = organic`, created by `landSession`), the page lands on `data-tab=\"apply\" data-step=\"goal\"` with the pending `entry.goal.question` card loaded, and a returning cookie holder lands there without the door.", { skip }, async () => {
  const R = randomUUID().slice(0, 8); const email = `t2-${R}@example.test`;
  const { page, ctx } = await openApply(null, 390);
  await page.getByTestId("apply-continue").first().click(); await page.waitForSelector('[data-testid="apply"][data-door="intro"]', { timeout: 30_000 });
  await page.getByRole("button", { name: "Create an account" }).first().click(); await page.waitForSelector('[data-testid="account"][data-mode="sign_up"]', { timeout: 30_000 });
  // the e-mail + password account through the door's own form (the FAKE Google form renders only under SHOW_FAKE_MARKERS, off in this production build)
  await page.locator('[data-testid="account-form"] input[type="email"]').fill(email);
  await page.locator('[data-testid="account-form"] input[type="password"]').fill(`pw-t2-${R}-strong`);
  await page.locator('[data-testid="account-form"] button[type="submit"]').first().click();
  try { await page.waitForSelector('[data-testid="apply"][data-tab="apply"][data-step="goal"]', { timeout: 60_000 }); }
  catch (e) { throw new Error(`the account did not land on Apply: account-error=${JSON.stringify(await page.getByTestId("account-error").allInnerTexts().catch(() => []))}; apply-error=${JSON.stringify(await page.getByTestId("apply-error").allInnerTexts().catch(() => []))}; logs=${JSON.stringify(page.logs?.slice(-8))}; ${String(e).split("\n")[0]}`); }
  assert.equal(await attr(page, "data-door"), null, "the door is gone"); await noError(page, "the landing");
  assert.equal(await page.getByTestId("account").count(), 0, "the account form is gone");
  // the session the proxy holds as the cookie: L1, auth_method password
  const cookie = (await ctx.cookies()).find((c) => c.name === "sm_borrower_session"); assert.ok(cookie, "the proxy set the session cookie"); const token = decodeURIComponent(cookie.value);
  const me = await api("GET", "/v1/borrower/me", undefined, token); assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body["level"], "L1"); const partyId = (me.body["party"] as Json)["party_id"] as string;
  const sessions = await sessionsOf(partyId); assert.equal(sessions.length, 1, "one session"); assert.equal(sessions[0]!.level, "L1"); assert.equal(sessions[0]!.auth_method, "password"); assert.equal(sessions[0]!.revoked_at, null);
  // GET /v1/borrower/me lists the organic application landSession created
  const subject = (me.body["subjects"] as Json[]).find((s) => s["application_id"]); assert.ok(subject, `me lists the application: ${JSON.stringify(me.body["subjects"])}`);
  const app = await applicationOf(partyId); assert.ok(app); assert.equal(app.id, subject["application_id"]); assert.equal(app.channel, "organic");
  // the page landed on data-tab="apply" data-step="goal" with the pending entry.goal.question card loaded: Continue is live, and Property shows the card's own consents statement
  const cards = await cardsOf(partyId); const g = card(cards, "entry.goal.question"); assert.ok(g, "the goal card"); assert.equal(g.status, "pending"); assert.equal(g.kind, "ChoiceCard");
  await goal(page, "buy", "My primary home");
  const st = await consentsStatement(page); assert.equal(st.text, String(g.props["statement"])); assert.equal(st.version, CONSENTS_VERSION);
  assert.equal(await page.getByTestId("footer-disclosure").count(), 1, "footer.disclosure on the step");
  // a returning cookie holder lands there without the door: a MutationObserver from the first paint never sees [data-door]
  const back = await pageFor(token, 390);
  await back.ctx.addInitScript("window.__doorSeen = false; new MutationObserver(() => { if (document.querySelector('[data-testid=\"apply\"][data-door]') || document.querySelector('[data-testid=\"account\"]')) window.__doorSeen = true; }).observe(document.documentElement, { subtree: true, attributes: true, childList: true });");
  await back.page.reload({ waitUntil: "load" });
  await back.page.waitForSelector('[data-testid="apply"][data-tab="apply"][data-step="goal"]', { timeout: 30_000 });
  assert.equal(await back.page.evaluate<boolean>("window.__doorSeen"), false, "the door never rendered for the cookie holder");
  assert.equal(await back.page.getByTestId("account").count(), 0); assert.equal(await back.page.getByTestId("apply-tab-apply").count(), 1, "the five tabs are offered");
  assert.equal((await sessionsOf(partyId)).length, 1, "the return opened no second session");
  await closeAll({ ctx }, back);
});
test("32.19-T3: Buy with an address — Given Buy a home, an occupancy, an address, a state, a price, a down payment, the estate type and the clean-energy lien answer, when Continue on Property, then `entry.goal.question` is resolved with `option_id = buy` and `args.property = {address, state}`, `applications.transaction_type = purchase` and `occupancy` as tapped, the three consents are written on that tap (`consents{esign: pending_verification}`, `{tcpa_sms: active}`, `credit.authorization.captured{kind = hard_pull}` — no ConsentCard, no checkbox), `application.confirmField{path = property_address}` captured the six-item address and wrote `estate_type` and `existing_clean_energy_lien` on the subject `application_properties` row before the goal tap, no `preapproval.intro` or `preapproval.where` card was sent, and the price and down payment are not yet written.", { skip }, async () => {
  const a = await account("t3");
  const { page, ctx } = await openApply(a.token, 390);
  await goal(page, "buy", "A second home");
  // the address branch: the six fields, the card's consents statement above Continue, no checkbox, no ConsentCard
  assert.equal(await page.locator('[data-testid="apply"] input[type="checkbox"]').count(), 0, "no checkbox");
  await fill(page, "Property address", "24 Juniper Lane, Austin, TX 78701"); await fill(page, "State", "TX"); await fill(page, "Price", "650000"); await fill(page, "Down payment", "130000");
  await pick(page, "Do you own the land, or is it a leasehold?", "I own the land"); await pick(page, "Is there a PACE or clean-energy loan on the home?", "No");
  const before = await cardsOf(a.party_id); const g0 = card(before, "entry.goal.question"); assert.ok(g0); assert.equal(g0.status, "pending");
  const st = await consentsStatement(page); assert.equal(st.text, String(g0.props["statement"])); assert.equal(st.version, CONSENTS_VERSION);
  assert.equal(before.filter((c) => c.kind === "ConsentCard").length, 0, "no ConsentCard before the tap");
  assert.equal((await propertiesOf(a.application_id)).length, 0, "no subject row before Continue"); assert.equal((await consentsOf(a.party_id, a.application_id)).length, 0, "no consent before the tap");
  await continueTo(page, "you", "property");
  // entry.goal.question resolved with option_id = buy and args.property = {address, state}
  const cards = await cardsOf(a.party_id); const g = card(cards, "entry.goal.question"); assert.ok(g); assert.equal(g.status, "resolved");
  assert.equal(g.evidence?.["option_id"], "buy"); assert.equal((g.evidence?.["command_output"] as Json)["property_tbd"], false, "setGoal saw {address, state}, not tbd");
  const rec = await intake(a.application_id); assert.ok(rec);
  assert.equal(rec["property_address"], "24 Juniper Lane, Austin, TX 78701"); assert.equal(rec["property_state"], "TX"); assert.equal(rec["transaction_type"], "purchase"); assert.equal(rec["occupancy"], "second_home");
  // applications.transaction_type = purchase and occupancy as tapped
  const app = await applicationOf(a.party_id); assert.ok(app); assert.equal(app.transaction_type, "purchase"); assert.equal(app.occupancy, "second_home");
  // the three consents on that tap — no ConsentCard, no checkbox
  const consents = await consentsOf(a.party_id, a.application_id);
  assert.equal(consents.find((c) => c.kind === "esign")?.status, "pending_verification", `esign: ${JSON.stringify(consents)}`);
  assert.equal(consents.find((c) => c.kind === "tcpa_sms")?.status, "active", `tcpa_sms: ${JSON.stringify(consents)}`);
  const evs = await events(a.application_id);
  // two rows of the event: 20.3 captureConsent's (kind = the authorization kind, hard_application) and 32.2 credit.authorize's (kind = hard_pull, the tapped card)
  const authz = evs.filter((e) => e.type === "credit.authorization.captured"); assert.ok(authz.length >= 1, "credit.authorization.captured");
  const hard = authz.find((e) => e.payload["kind"] === "hard_pull"); assert.ok(hard, `credit.authorization.captured{kind = hard_pull}: ${JSON.stringify(authz.map((e) => e.payload["kind"]))}`); assert.equal(hard.payload["card_instance_id"], g.card_instance_id, "written on the goal card's tap");
  assert.equal(cards.filter((c) => c.kind === "ConsentCard").length, 0, "no ConsentCard");
  assert.equal(await page.locator('[data-testid="apply"] input[type="checkbox"]').count(), 0);
  // application.confirmField{path = property_address} captured the six-item address and wrote estate_type and existing_clean_energy_lien on the subject row.
  // DEVIATION (recorded, not hidden): the sentence says "before the goal tap"; 21.1 refuses a capture before the interview the goal tap opens (section21-1.ts `load`:
  // "no application … in the entity store (startInterview opens it)"), so the page runs the command on the same Continue, right after the goal resolve — the
  // address the tap carried (args.property) is what the flows read (3-entry.ts isTbd, DELTA-36), which is why no preapproval card was sent. The order is asserted as it is.
  const six = seqOf(evs, "application.six_item.captured", (p) => p["item"] === "property_address"); const received = seqOf(evs, "application.received");
  assert.ok(six !== null, "application.six_item.captured{property_address}"); assert.ok(received !== null, "application.received on the goal tap");
  assert.ok(received! < six!, `the goal tap's application.received (seq ${received}) precedes the six-item address (seq ${six}) — the command needs the interview the tap opens`);
  assert.equal(seqOf(evs, "application.received", () => true), received, "one application.received");
  const props = await propertiesOf(a.application_id); assert.equal(props.length, 1, "one subject application_properties row"); const row = props[0]!;
  assert.equal(row.address_line1, "24 Juniper Lane"); assert.equal(row.city, "Austin"); assert.equal(row.state, "TX"); assert.equal(row.postal_code, "78701"); assert.equal(row.property_type, "sfr"); assert.equal(row.units, 1);
  assert.equal(row.estate_type, "fee_simple"); assert.equal(row.existing_clean_energy_lien, false); assert.equal(row.is_subject, true);
  // no preapproval.intro or preapproval.where card was sent (isTbd was false when application.received reacted); the connectors were
  assert.deepEqual(cards.filter((c) => c.copy_key === "preapproval.intro" || c.copy_key === "preapproval.where").map((c) => c.copy_key), [], "no preapproval.* card");
  assert.equal(seqOf(evs, "prequal.requested"), null, "no preapproval request");
  for (const key of ["identity.stripe.purpose", "income.connect.purpose", "assets.connect.purpose"]) assert.equal(card(cards, key)?.status, "pending", `${key} sent on application.received`);
  // the price and down payment are not yet written
  assert.equal(seqOf(evs, "application.six_item.captured", (p) => p["item"] === "property_value_estimate"), null, "no value six-item yet");
  assert.equal(seqOf(evs, "application.six_item.captured", (p) => p["item"] === "loan_amount_sought"), null, "no loan amount six-item yet");
  assert.equal(row.estimated_value_cents, null); assert.equal(rec["property_value_estimate_cents"] ?? null, null); assert.equal(rec["loan_amount_sought_cents"] ?? null, null);
  assert.equal(seqOf(evs, "application.trid_received"), null, "the six items are not complete: the file stays received");
  // the page: Tasks marks the property task done from the card statuses and the record, never from memory
  await page.getByTestId("apply-tab-tasks").first().click(); await page.waitForSelector('[data-testid="apply-task-property"][data-done="true"]', { timeout: 30_000 });
  assert.equal(await page.getByTestId("apply-task-you").first().getAttribute("data-done"), "false");
  // back on Property from Tasks: the fields still carry the address, Continue is live without a second tap (the goal card is resolved, not awaited again) and reaches You with no error
  await page.getByTestId("apply-task-property").first().click(); await page.waitForSelector('[data-testid="apply"][data-step="property"]', { timeout: 30_000 });
  assert.equal(await page.getByLabel("Property address", { exact: true }).first().inputValue(), "24 Juniper Lane, Austin, TX 78701");
  assert.equal(await page.getByTestId("apply-continue").first().getAttribute("disabled"), null, "Continue is live on a return to Property");
  await continueTo(page, "you", "property again");
  const again = await events(a.application_id);
  assert.equal(again.filter((e) => e.type === "application.received").length, 1, "no second goal tap"); assert.equal((await cardsOf(a.party_id)).filter((c) => c.copy_key === "entry.goal.question").length, 1);
  assert.equal((await propertiesOf(a.application_id)).length, 1, "the same subject row (upsert)");
  await ctx.close();
});
test("32.19-T4: Buy, still looking — Given Buy a home with Still looking, a state, a price range, a down payment and the first-time answer, when Continue, then the goal resolves with `args.property = {tbd: true, state}` and the result carries `property_tbd = true`, `preapproval.intro` and `preapproval.where` are sent, `preapproval.where` is resolved with `state`, `price_min_cents`, `price_max_cents`, `down_payment_cents`, no `property_address` six-item is captured, and after the demographics `preapproval.target` is resolved with the target price, the down payment, the loan amount and `FRM30`; the file stays `received` and Review reads the badge with `apply.review.tbd`.", { skip }, async () => {
  const a = await account("t4");
  const { page, ctx } = await openApply(a.token, 390);
  await goal(page, "buy", "My primary home");
  await page.getByRole("button", { name: "Still looking" }).first().click();
  assert.equal(await page.getByLabel("Property address", { exact: true }).count(), 0, "no address on the still-looking branch");
  assert.equal(await page.getByLabel("Do you own the land, or is it a leasehold?", { exact: true }).count(), 0, "no estate / lien on the still-looking branch");
  await fill(page, "State", "AZ"); await fill(page, "Price range — low", "400000"); await fill(page, "Price range — high", "500000"); await fill(page, "Down payment", "100000");
  await pick(page, "First-time buyer?", "Yes");
  const before = await cardsOf(a.party_id); const g0 = card(before, "entry.goal.question"); assert.ok(g0); assert.equal(g0.status, "pending");
  const st = await consentsStatement(page); assert.equal(st.text, String(g0.props["statement"]));
  assert.equal(card(before, "preapproval.where"), undefined, "no preapproval card before the tap");
  await continueTo(page, "you", "still looking");
  // the goal resolves with args.property = {tbd: true, state}; the result carries property_tbd = true
  const cards = await cardsOf(a.party_id); const g = card(cards, "entry.goal.question"); assert.ok(g); assert.equal(g.status, "resolved");
  assert.equal(g.evidence?.["option_id"], "buy"); assert.equal((g.evidence?.["command_output"] as Json)["property_tbd"], true);
  const rec = await intake(a.application_id); assert.ok(rec); assert.equal(rec["property_state"], "AZ"); assert.equal(rec["property_address"] ?? null, null, "no address on the intake record"); assert.equal(rec["transaction_type"], "purchase");
  const app = await applicationOf(a.party_id); assert.equal(app?.transaction_type, "purchase"); assert.equal(app?.occupancy, "primary");
  // preapproval.intro and preapproval.where are sent (isPurchase && isTbd on application.received), and preapproval.where is resolved with the four fields and the first-time answer
  const intro = card(cards, "preapproval.intro"); assert.ok(intro, "preapproval.intro sent"); assert.equal(intro.kind, "StatusCard");
  const where = card(cards, "preapproval.where"); assert.ok(where, "preapproval.where sent"); assert.equal(where.kind, "ConfirmCard"); assert.equal(where.status, "resolved"); assert.equal(where.command_ref, "application.confirmField");
  const fields = (where.evidence?.["fields"] as Json[] | undefined) ?? []; const val = (p: string): unknown => fields.find((f) => f["path"] === p)?.["value_confirmed"];
  assert.equal(val("state"), "AZ"); assert.equal(val("price_min_cents"), "40000000"); assert.equal(val("price_max_cents"), "50000000"); assert.equal(val("down_payment_cents"), "10000000"); assert.equal(val("first_time_buyer"), "yes");
  assert.equal((where.evidence?.["command_output"] as Json)["state"], "AZ", "confirmField{path: preapproval.where} ran");
  // 20.3's preapproval request rode the resolve (lead_id = application_id on an organic application)
  const evs = await events(a.application_id);
  assert.ok(seqOf(evs, "prequal.requested") !== null, `prequal.requested: ${evs.map((e) => e.type).join(", ")}`);
  const lead = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'leads' AND id = $1`, [a.application_id]))[0]; assert.ok(lead, "the lead record");
  const leadData = decodeEntityData(lead.data) as Json; assert.equal(leadData["status"], "prequal_requested"); const pq = ((leadData["prequalifications"] as Json[] | undefined) ?? []).at(-1); assert.equal(pq?.["kind"], "preapproval");
  // no property_address six-item is captured (21.1 refuses a TBD address); no subject row carries an address
  assert.equal(seqOf(evs, "application.six_item.captured", (p) => p["item"] === "property_address"), null, "no property_address six-item on a TBD purchase");
  assert.deepEqual((await propertiesOf(a.application_id)).filter((p) => p.address_line1).length, 0, "no addressed subject row");
  const record = await api("GET", `/v1/borrower/record?subject=${a.application_id}`, undefined, a.token); assert.equal(record.status, 200, JSON.stringify(record.body).slice(0, 300));
  assert.ok(!((record.body["property"] as Json | undefined)?.["address"]), "the record's property carries no address (tbd)");
  // the file stays received: no trid_received, no credit pull (the demographics, preapproval.target and Review's apply.review.tbd are Sessions 2–3's screens — 32.19 §5)
  assert.equal(seqOf(evs, "application.trid_received"), null); assert.equal(seqOf(evs, "credit.report.ordered"), null); assert.equal(rec["status"], "received");
  assert.equal(card(cards, "preapproval.target"), undefined, "preapproval.target comes after the demographics");
  await page.getByTestId("apply-tab-tasks").first().click(); await page.waitForSelector('[data-testid="apply-task-property"][data-done="true"]', { timeout: 30_000 });
  // back on Property from Tasks: Continue is live without a second tap and holds (preapproval.where is resolved, nothing pending to write)
  await page.getByTestId("apply-task-property").first().click(); await page.waitForSelector('[data-testid="apply"][data-step="property"]', { timeout: 30_000 });
  assert.equal(await page.getByLabel("Price range — high", { exact: true }).first().inputValue(), "500000");
  await continueTo(page, "you", "still looking again");
  const again = await cardsOf(a.party_id);
  assert.equal(again.filter((c) => c.copy_key === "entry.goal.question").length, 1, "no second goal card"); assert.equal(again.filter((c) => c.copy_key === "preapproval.where").length, 1, "preapproval.where resolved once");
  assert.equal((await events(a.application_id)).filter((e) => e.type === "prequal.requested").length, 1, "one preapproval request");
  await ctx.close();
});
test("32.19-T5: Refinance — Given Refinance my home with Lower payment, Pay off sooner or Take cash out, then the goal resolves with `lower_rate`, `lower_rate` or `cash_out` (`transaction_type = limited_cash_out | limited_cash_out | cash_out`), Property shows no shopping switch, the address, estate type and lien answer are held until `refi.home.confirm` is sent — with the SSN card, on `application.field.captured{current_address}` — and then resolve it (`edited = true`, the six-item address and the subject row), and Pay off sooner resolves `refi.product.choice` with `FRM15`.", { skip }, async () => {
  const CASES = [["Lower payment", "lower_rate", "limited_cash_out", 390], ["Pay off sooner", "lower_rate", "limited_cash_out", 1280], ["Take cash out", "cash_out", "cash_out", 390]] as const;
  for (const [i, [purpose, option, transactionType, width]] of CASES.entries()) {
    const a = await account(`t5-${i}`); const address = `${10 + i} Elm Street, Phoenix, AZ 85001`;
    const { page, ctx } = await openApply(a.token, width);
    await goal(page, "refi", "My primary home", purpose);
    // Property shows no shopping switch; the current home's fields; cash out only for cash
    assert.equal(await page.getByTestId("apply-property-switch").count(), 0, `${purpose}: no shopping switch`); assert.equal(await page.getByRole("button", { name: "Still looking" }).count(), 0);
    assert.match(await page.locator(".sm-bubble h1").first().innerText(), /Your current home\./);
    await fill(page, "Property address", address); await fill(page, "State", "AZ"); await fill(page, "About what is it worth?", "500000"); await fill(page, "Current balance", "300000");
    if (option === "cash_out") await fill(page, "Cash out", "50000"); else assert.equal(await page.getByLabel("Cash out", { exact: true }).count(), 0, `${purpose}: no cash-out field`);
    await pick(page, "Do you own the land, or is it a leasehold?", "It is a leasehold"); await pick(page, "Is there a PACE or clean-energy loan on the home?", "Yes");
    const before = await cardsOf(a.party_id); const g0 = card(before, "entry.goal.question"); assert.ok(g0); assert.equal(g0.status, "pending");
    const st = await consentsStatement(page); assert.equal(st.text, String(g0.props["statement"]));
    await continueTo(page, "you", `refinance: ${purpose}`);
    // the goal resolves with lower_rate | lower_rate | cash_out → transaction_type limited_cash_out | limited_cash_out | cash_out
    const cards = await cardsOf(a.party_id); const g = card(cards, "entry.goal.question"); assert.ok(g); assert.equal(g.status, "resolved"); assert.equal(g.evidence?.["option_id"], option);
    const app = await applicationOf(a.party_id); assert.equal(app?.transaction_type, transactionType, purpose); assert.equal(app?.occupancy, "primary");
    const rec = await intake(a.application_id); assert.ok(rec); assert.equal(rec["transaction_type"], transactionType); assert.equal(rec["property_state"], "AZ");
    assert.equal(rec["property_address"], address, "setGoal's args.property.address reaches 21.1's intake record only");
    // the address, estate type and lien answer are held: no six-item, no subject-row facts, no refi.home.confirm yet — it is sent on application.field.captured{current_address}, with the SSN card
    const evs = await events(a.application_id);
    assert.equal(seqOf(evs, "application.six_item.captured", (p) => p["item"] === "property_address"), null, `${purpose}: the six-item address waits for refi.home.confirm`);
    assert.equal((await propertiesOf(a.application_id)).filter((p) => p.address_line1 || p.estate_type || p.existing_clean_energy_lien !== null).length, 0, `${purpose}: no subject-row facts yet`);
    assert.equal(card(cards, "refi.home.confirm"), undefined, `${purpose}: refi.home.confirm is not sent before application.field.captured{current_address}`);
    assert.equal(seqOf(evs, "application.field.captured", (p) => p["field"] === "current_address"), null);
    assert.equal(card(cards, "identity.ssn.title"), undefined, "the SSN card comes with the home card, after the identity card");
    assert.equal(card(cards, "identity.stripe.purpose")?.status, "pending", "the identity connector is the next ask");
    assert.equal(cards.filter((c) => c.copy_key === "preapproval.intro" || c.copy_key === "preapproval.where").length, 0, "no preapproval card on a refinance");
    // the consents rode the tap here too
    const consents = await consentsOf(a.party_id, a.application_id); assert.equal(consents.find((c) => c.kind === "esign")?.status, "pending_verification"); assert.equal(consents.find((c) => c.kind === "tcpa_sms")?.status, "active");
    assert.ok(evs.some((e) => e.type === "credit.authorization.captured" && e.payload["kind"] === "hard_pull"), "credit.authorization.captured{kind = hard_pull} on the tap");
    // the draft holds the address, the estate and the lien: back on Property through Tasks, the fields still carry them; the task is not done until the home card resolves
    await page.getByTestId("apply-tab-tasks").first().click(); await page.waitForSelector('[data-testid="apply-task-property"]', { timeout: 30_000 });
    assert.equal(await page.getByTestId("apply-task-property").first().getAttribute("data-done"), "false", "the property task waits for refi.home.confirm");
    await page.getByTestId("apply-task-property").first().click(); await page.waitForSelector('[data-testid="apply"][data-step="property"]', { timeout: 30_000 });
    assert.equal(await page.getByLabel("Property address", { exact: true }).first().inputValue(), address);
    assert.equal(await page.getByLabel("Do you own the land, or is it a leasehold?", { exact: true }).first().inputValue(), "leasehold");
    assert.equal(await page.getByLabel("Is there a PACE or clean-energy loan on the home?", { exact: true }).first().inputValue(), "yes");
    assert.equal(await page.getByLabel("Current balance", { exact: true }).first().inputValue(), "300000");
    // the You screen's Continue: the identity card's resolve captures current_address, and refi.home.confirm is sent with the SSN card on that event; the step then resolves it with the held address, estate type and lien
    await page.getByTestId("apply-continue").first().click(); await page.waitForSelector('[data-testid="apply"][data-step="you"]', { timeout: 60_000 }); await noError(page, "property → you");
    await you(page, { name: `Riley Ortega ${i}`, dob: "1979-03-02", ssn: "212-55-100" + i, basis: "Own", months: "60" });
    const after = await cardsOf(a.party_id); const home = card(after, "refi.home.confirm"); assert.ok(home, `${purpose}: refi.home.confirm sent`); assert.equal(home.kind, "ConfirmCard"); assert.equal(home.status, "resolved", `${purpose}: refi.home.confirm resolved by the You step`);
    assert.equal(home.evidence?.["edited"], true, "edited = true: the address, estate and lien were the page's edits over the card's values");
    assert.equal(fieldOf(home, "property_address")?.["value_confirmed"], address); assert.equal(fieldOf(home, "estate_type")?.["value_confirmed"], "leasehold"); assert.equal(fieldOf(home, "existing_clean_energy_lien")?.["value_confirmed"], "yes");
    const evs2 = await events(a.application_id);
    const captured = seqOf(evs2, "application.field.captured", (p) => p["field"] === "current_address"); const six = seqOf(evs2, "application.six_item.captured", (p) => p["item"] === "property_address");
    assert.ok(captured !== null, "application.field.captured{current_address} (the identity card's resolve)"); assert.ok(six !== null, `${purpose}: the six-item address on refi.home.confirm's resolve`); assert.ok(captured! < six!, "the home card came with the SSN card, on the current_address capture, and was resolved after it");
    assert.ok(Number(home.seq) > Number(card(after, "identity.confirm.title")!.seq), "refi.home.confirm was sent after the identity card"); assert.ok(card(after, "identity.ssn.title"), "with the SSN card");
    const rows = await propertiesOf(a.application_id); assert.equal(rows.length, 1, `${purpose}: one subject row`); const row = rows[0]!;
    assert.equal(row.address_line1, `${10 + i} Elm Street`); assert.equal(row.city, "Phoenix"); assert.equal(row.state, "AZ"); assert.equal(row.postal_code, "85001"); assert.equal(row.estate_type, "leasehold"); assert.equal(row.existing_clean_energy_lien, true); assert.equal(row.is_subject, true);
    await page.getByTestId("apply-tab-tasks").first().click(); await page.waitForSelector('[data-testid="apply-task-property"][data-done="true"]', { timeout: 30_000 });
    await ctx.close();
  }
  // Pay off sooner's FRM15 on refi.product.choice is the Review screen's tap — Session 3 (32.19 §5)
});
test("32.19-T6: You — Given the You screen with a legal name, a date of birth, an SSN, \"I live here as\" and the months, when Continue, then `POST /v1/borrower/identity/stripe/session {fake_complete: true}` ran on the pending `identity.stripe.purpose` card, `identity.confirm.title` was resolved with the typed values as edits (`source = borrower`) and the residence basis (one Current `du_residences` row), `identity.ssn.title` was resolved (`tin_last4` set, the SSN never echoed), a prior-address panel renders only when the months are under 24 and resolves `identity.prior_residence.title`, and the page posted no `credit.authorize` and needed no L2.", { skip }, async () => {
  const a = await account("t6"); const SSN = "123-45-6789"; const DIGITS = "123456789";
  const { page, ctx } = await openApply(a.token, 390);
  await buyToYou(page);
  const before = await cardsOf(a.party_id); const connector = card(before, "identity.stripe.purpose"); assert.ok(connector); assert.equal(connector.status, "pending", "the identity connector is pending before Continue");
  assert.equal(card(before, "identity.confirm.title"), undefined, "no identity card before the scan"); assert.equal(card(before, "identity.ssn.title"), undefined);
  const authzBefore = (await events(a.application_id)).filter((e) => e.type === "credit.authorization.captured").length; assert.ok(authzBefore >= 1, "the goal tap wrote the authorization (32.17 rule 20)");
  assert.equal(await page.locator('[data-testid="apply"] input[type="checkbox"]').count(), 0, "no credit checkbox on You");
  // the prior-address panel renders only when the months are under 24
  await fill(page, "Months at this address", "36"); assert.equal(await page.getByTestId("apply-prior-address").count(), 0, "no prior panel at 36 months");
  await fill(page, "Months at this address", "24"); assert.equal(await page.getByTestId("apply-prior-address").count(), 0, "no prior panel at 24 months");
  await fill(page, "Months at this address", "18"); assert.equal(await page.getByTestId("apply-prior-address").count(), 1, "the prior panel at 18 months");
  await you(page, { name: "Taylor Reyes", dob: "1988-04-12", ssn: SSN, basis: "Rent", rent: "1850", months: "18", prior: { street: "9 Oak Avenue", city: "Dallas", state: "TX", zip: "75201", basis: "Own", months: "40" } });
  // POST /v1/borrower/identity/stripe/session {application_id, fake_complete: true} ran on the pending identity.stripe.purpose card — the FAKE finished on the tap
  const sessions = posted(page, /\/v1\/borrower\/identity\/stripe\/session/); assert.equal(sessions.length, 1, `one identity session: ${JSON.stringify(page.requests)}`);
  assert.equal(bodyOf(sessions[0]!)["fake_complete"], true); assert.equal(bodyOf(sessions[0]!)["application_id"], a.application_id);
  const cards = await cardsOf(a.party_id); const scan = card(cards, "identity.stripe.purpose"); assert.ok(scan); assert.equal(scan.card_instance_id, connector.card_instance_id, "the flow's own connector card, never a second one"); assert.equal(scan.status, "resolved"); assert.equal(scan.evidence?.["outcome"], "connected");
  const started = await db.query<{ payload: Json }>(`SELECT payload FROM ui_events WHERE card_instance_id = $1 AND kind = 'connector_started'`, [scan.card_instance_id]); assert.equal(started[0]?.payload["vendor"], "stripe_identity");
  const evs = await events(a.application_id); assert.ok(seqOf(evs, "identity.verified") !== null, "identity.verified (22.6)");
  // identity.confirm.title resolved with the typed values as edits (source = borrower) and the residence basis: one Current du_residences row
  const identity = card(cards, "identity.confirm.title"); assert.ok(identity, "the identity card"); assert.equal(identity.status, "resolved"); assert.equal(identity.command_ref, "application.confirmField"); assert.equal(identity.evidence?.["edited"], true);
  assert.equal(fieldOf(identity, "legal_name")?.["value_confirmed"], "Taylor Reyes"); assert.equal(fieldOf(identity, "legal_name")?.["source"], "borrower"); assert.equal(fieldOf(identity, "date_of_birth")?.["value_confirmed"], "1988-04-12");
  assert.equal(fieldOf(identity, "residency_basis")?.["value_confirmed"], "rent"); assert.equal(fieldOf(identity, "monthly_rent_cents")?.["value_confirmed"], "185000"); assert.equal(fieldOf(identity, "months_at_address")?.["value_confirmed"], "18");
  assert.equal(fieldOf(identity, "current_address")?.["value_confirmed"], (identity.props["fields"] as Json[]).find((f) => f["path"] === "current_address")?.["value"], "the current address is the card's own (the ID's reading)");
  const b = await borrowerOf(a.application_id, a.party_id);
  assert.equal(b.legal_name, "Taylor Reyes"); assert.equal(b.date_of_birth, "1988-04-12"); assert.equal((b.prefill["legal_name"] as Json)["source"], "borrower", "the edited name is the borrower's"); assert.ok((b.prefill["legal_name"] as Json)["confirmed_at"]);
  assert.ok(seqOf(evs, "application.six_item.captured", (p) => p["item"] === "name") !== null, "the six-item name"); assert.ok(seqOf(evs, "application.field.captured", (p) => p["field"] === "current_address") !== null);
  const residences = await residencesOf(b.id); const current = residences.filter((r) => r.residency_type === "Current"); assert.equal(current.length, 1, "one Current du_residences row");
  assert.equal(current[0]!.residency_basis, "Rent"); assert.equal(current[0]!.monthly_rent_cents, "185000"); assert.equal(current[0]!.duration_months, 18);
  // identity.ssn.title resolved: tin_last4 set, the SSN never echoed — masked in the stored evidence, absent from every card, the thread and the page
  const ssn = card(cards, "identity.ssn.title"); assert.ok(ssn, "the SSN card"); assert.equal(ssn.status, "resolved"); assert.equal(ssn.evidence?.["edited"], true);
  assert.equal(fieldOf(ssn, "ssn")?.["value_confirmed"], "••••6789"); assert.equal(fieldOf(ssn, "ssn")?.["masked"], true);
  assert.equal(b.tin_last4, "6789"); assert.ok(seqOf(evs, "application.six_item.captured", (p) => p["item"] === "ssn") !== null, "the six-item ssn");
  const stored = JSON.stringify(cards.map((c) => [c.props, c.evidence])); assert.ok(!stored.includes(DIGITS) && !stored.includes(SSN), "no card carries the nine digits");
  const thread = await api("GET", "/v1/borrower/thread?limit=500", undefined, a.token); assert.equal(thread.status, 200); const wire = JSON.stringify(thread.body); assert.ok(!wire.includes(DIGITS) && !wire.includes(SSN), "the thread never echoes the SSN");
  const html = await page.content(); assert.ok(!html.includes(DIGITS) && !html.includes(SSN), "the page holds the digits only until the card is written");
  assert.ok(!JSON.stringify(evs).includes(DIGITS), "no event payload carries the SSN");
  const carried = (page.requests ?? []).filter((r) => r.includes(DIGITS) || r.includes(SSN)); assert.equal(carried.length, 1, `the digits crossed the wire once: ${JSON.stringify(carried.map((r) => r.split(" ").slice(0, 2).join(" ")))}`);
  assert.ok(carried[0]!.startsWith(`POST /v1/borrower/cards/${ssn.card_instance_id}/resolve `), "…in the SSN card's resolve, never in another request");
  // the prior-address panel's card: identity.prior_residence.title resolved — the Prior du_residences row with its own address
  const prior = card(cards, "identity.prior_residence.title"); assert.ok(prior, "identity.prior_residence.title sent (18 < 24 months)"); assert.equal(prior.status, "resolved");
  assert.equal(fieldOf(prior, "prior_address_line")?.["value_confirmed"], "9 Oak Avenue"); assert.equal(fieldOf(prior, "prior_residency_basis")?.["value_confirmed"], "own"); assert.equal(fieldOf(prior, "prior_months_at_address")?.["value_confirmed"], "40");
  const priorRow = residences.find((r) => r.residency_type === "Prior"); assert.ok(priorRow, "the Prior du_residences row"); assert.equal(priorRow.address_line_text, "9 Oak Avenue"); assert.equal(priorRow.city_name, "Dallas"); assert.equal(priorRow.state_code, "TX"); assert.equal(priorRow.postal_code, "75201"); assert.equal(priorRow.residency_basis, "Own"); assert.equal(priorRow.duration_months, 40);
  assert.ok(Number(prior.seq) > Number(ssn.seq), "the prior card rode with the SSN card, after it");
  // the page posted no credit.authorize and needed no L2: no such request, no new authorization row, the session never stepped up to L2 (the FAKE scan raised L3)
  assert.equal(posted(page, /commands\/credit\.authorize/).length, 0, "no credit.authorize from the page"); assert.equal(posted(page, /\/auth\/l2/).length, 0, "no L2 challenge");
  assert.equal((await events(a.application_id)).filter((e) => e.type === "credit.authorization.captured").length, authzBefore, "no second authorization");
  const levels = (await sessionsOf(a.party_id)).map((s) => s.level); assert.ok(!levels.includes("L2"), `no L2 session: ${levels.join(",")}`); assert.deepEqual([...new Set(levels)].sort(), ["L3"], "the one session, raised to L3 by the verified scan");
  assert.equal(posted(page, /\/commands\//).length, 1, `the page's only command is the six-field confirmField of Property: ${JSON.stringify(posted(page, /\/commands\//))}`);
  assert.equal(seqOf(evs, "credit.report.ordered"), null, "the pull waits for the six items (trid_received)");
  // Tasks marks the credit-check task done from the SSN card's status
  await page.getByTestId("apply-tab-tasks").first().click(); await page.waitForSelector('[data-testid="apply-task-you"][data-done="true"]', { timeout: 30_000 });
  assert.equal(await page.getByTestId("apply-task-connect").first().getAttribute("data-done"), "false");
  await ctx.close();
});
test("32.19-T7: Connect — Given the Connect screen with a monthly income and an employer, when Connect and continue, then `POST /v1/borrower/connect/truv_income/session {card_instance_id, fake_complete: true}` ran on the pending payroll card, `income.confirm.title` was resolved with the typed income and employer as edits (`application_income` with `employer_id` and `employment_income = true`; six-item `income`), `POST /v1/borrower/connect/plaid_assets/session` ran on the assets card (`verification.received{kind = assets}`, the card `connected`), and the page never posted `verification.connect`.", { skip }, async () => {
  const a = await account("t7");
  const { page, ctx } = await openApply(a.token, 390);
  await buyToYou(page);
  await you(page, { name: "Morgan Vale", dob: "1990-11-30", ssn: "321-54-9876", basis: "Own", months: "48" });
  const before = await cardsOf(a.party_id); const payroll = card(before, "income.connect.purpose"); const assets = card(before, "assets.connect.purpose");
  assert.ok(payroll && assets); assert.equal(payroll.status, "pending"); assert.equal(assets.status, "pending"); assert.equal(card(before, "income.confirm.title"), undefined, "no income card before the connection");
  assert.equal(await page.getByRole("button", { name: /skip/i }).count(), 0, "no Skip in v1 (32.19 §2.5)");
  const commandsBefore = posted(page, /\/commands\//).length;
  await connectStep(page, "8500", "Acme Robotics");
  // POST connect/truv_income/session {card_instance_id, fake_complete: true} on the pending payroll card; the route resolved the connector and 22.3 received the FAKE report
  const truv = posted(page, /\/v1\/borrower\/connect\/truv_income\/session/); assert.equal(truv.length, 1, `one payroll session: ${JSON.stringify(page.requests)}`);
  assert.deepEqual(bodyOf(truv[0]!), { card_instance_id: payroll.card_instance_id, fake_complete: true });
  const cards = await cardsOf(a.party_id); const payrollAfter = card(cards, "income.connect.purpose"); assert.equal(payrollAfter?.status, "resolved"); assert.equal(payrollAfter?.evidence?.["vendor"], "truv_income"); assert.ok(payrollAfter?.evidence?.["report_reference_id"], "the FAKE report on the card");
  const evs = await events(a.application_id);
  assert.ok(seqOf(evs, "verification.received", (p) => p["kind"] === "income") !== null, "verification.received{income}");
  // income.confirm.title resolved with the typed income and employer as edits over the report's figures
  const income = card(cards, "income.confirm.title"); assert.ok(income, "the income card"); assert.equal(income.status, "resolved"); assert.equal(income.command_ref, "application.confirmField"); assert.equal(income.evidence?.["edited"], true);
  assert.equal(fieldOf(income, "employer")?.["value_confirmed"], "Acme Robotics"); assert.equal(fieldOf(income, "monthly_base_cents")?.["value_confirmed"], "850000");
  const shownEmployer = (income.props["fields"] as Json[]).find((f) => f["path"] === "employer")?.["value"]; assert.notEqual(shownEmployer, "Acme Robotics", "the typed employer differs from the FAKE report's (an edit)");
  assert.equal((income.evidence?.["command_output"] as Json)["amount_cents"], "850000"); assert.equal((income.evidence?.["command_output"] as Json)["source"], "borrower", "an edited figure is the borrower's own statement"); assert.equal((income.evidence?.["command_output"] as Json)["employment_income"], true);
  const b = await borrowerOf(a.application_id, a.party_id);
  interface IncomeRow { monthly_amount_cents: string; employer: Json; employer_id: string | null; employment_income: boolean; calculation: Json; source_kind: string }
  const rows = await db.query<IncomeRow & Record<string, unknown>>(`SELECT monthly_amount_cents::text AS monthly_amount_cents, employer, employer_id, employment_income, calculation, source_kind FROM application_income WHERE application_id = $1 AND application_borrower_id = $2`, [a.application_id, b.id]);
  assert.equal(rows.length, 1, "one application_income row"); const row = rows[0]!;
  assert.equal(row.monthly_amount_cents, "850000"); assert.equal(row.source_kind, "base"); assert.equal(row.employer["name"], "Acme Robotics"); assert.ok(row.employer_id, "employer_id set"); assert.equal(row.employment_income, true); assert.equal(row.calculation["source"], "borrower");
  const employers = await db.query<{ id: string; display_name: string }>(`SELECT id, display_name FROM employers WHERE application_id = $1`, [a.application_id]); assert.equal(employers.length, 1); assert.equal(employers[0]!.id, row.employer_id); assert.equal(employers[0]!.display_name, "Acme Robotics");
  assert.ok(seqOf(evs, "application.six_item.captured", (p) => p["item"] === "income") !== null, "the six-item income");
  // POST connect/plaid_assets/session on the assets card: verification.received{assets}, the accounts as assets, the card connected
  const plaid = posted(page, /\/v1\/borrower\/connect\/plaid_assets\/session/); assert.equal(plaid.length, 1, "one assets session"); assert.deepEqual(bodyOf(plaid[0]!), { card_instance_id: assets.card_instance_id, fake_complete: true });
  const assetsAfter = card(cards, "assets.connect.purpose"); assert.equal(assetsAfter?.status, "resolved"); assert.equal(assetsAfter?.props["state"], "connected"); assert.equal(assetsAfter?.evidence?.["outcome"], "connected"); assert.ok(assetsAfter?.evidence?.["verification_id"]);
  assert.ok(seqOf(evs, "verification.received", (p) => p["kind"] === "assets") !== null, "verification.received{kind = assets}");
  assert.ok((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM application_assets WHERE application_id = $1`, [a.application_id]))[0]!.n !== "0", "the report's accounts as application_assets rows");
  for (const id of [payroll.card_instance_id, assets.card_instance_id]) { const done = await db.query<{ payload: Json }>(`SELECT payload FROM ui_events WHERE card_instance_id = $1 AND kind = 'connector_completed'`, [id]); assert.equal(done[0]?.payload["outcome"], "connected", `connector_completed on ${id}`); }
  // the page never posted verification.connect (the connectors finish on their session routes); its only command stays Property's confirmField
  assert.equal(posted(page, /commands\/verification\.connect/).length, 0, `no verification.connect: ${JSON.stringify(posted(page, /\/commands\//))}`);
  assert.equal(posted(page, /\/commands\//).length, commandsBefore, "no command posted by Connect");
  // six-item income → the profile card is the next ask (Details)
  assert.equal(card(cards, "profile.title")?.status, "pending", "profile.title sent on the six-item income");
  await page.getByTestId("apply-tab-tasks").first().click(); await page.waitForSelector('[data-testid="apply-task-connect"][data-done="true"]', { timeout: 30_000 });
  await ctx.close();
});
test("32.19-T8: Details — Given Details, when Continue with citizenship, marital status, dependents, military service and language, then `profile.title` resolves with the five fields (`application_borrowers.citizenship_status`, `marital_status`, `language_preference`); when Continue without citizenship, then the step stays with `.sm-error` and nothing is posted; given married, then `apply.details.spouse_later` renders and no `application.inviteParty` is posted.", { skip }, async () => {
  const a = await account("t8");
  const { page, ctx } = await openApply(a.token, 1280);
  await buyToYou(page);
  await you(page, { name: "Jordan Blake", dob: "1985-07-19", ssn: "456-78-1234", basis: "Rent-free", months: "30" });
  await connectStep(page, "7200", "Northwind Traders");
  const before = await cardsOf(a.party_id); const profile0 = card(before, "profile.title"); assert.ok(profile0, "profile.title pending on Details"); assert.equal(profile0.status, "pending"); assert.equal(profile0.kind, "ProfileCard");
  const options = (path: string): string[] => ((profile0.props["fields"] as Json[]).find((f) => f["path"] === path)?.["options"] as Json[] | undefined ?? []).map((o) => String(o["id"]));
  // Continue without citizenship: the step stays with .sm-error (copy, never a code) and nothing is posted
  const postsBefore = (page.requests ?? []).filter((r) => r.startsWith("POST ")).length;
  assert.equal(await page.getByLabel("Citizenship", { exact: true }).first().inputValue(), "", "no visual default counts as an answer");
  await pick(page, "Marital status", "Married"); await fill(page, "Dependents", "2"); await pick(page, "Military service", "No"); await pick(page, "Language preference", "English");
  await page.getByTestId("apply-continue").first().click();
  await page.getByTestId("apply-error").first().waitFor({ timeout: 15_000 });
  assert.equal(await attr(page, "data-step"), "details", "the step stays");
  const err = (await page.getByTestId("apply-error").first().innerText()).trim(); assert.equal(err, "Answer the first four questions to continue.", "apply.details.required's copy"); assert.doesNotMatch(err, /^[A-Z_]{6,}$/);
  assert.equal(await page.locator(".sm-error").count(), 1);
  assert.equal((page.requests ?? []).filter((r) => r.startsWith("POST ")).length, postsBefore, "nothing was posted");
  assert.equal(card(await cardsOf(a.party_id), "profile.title")?.status, "pending"); assert.equal((await borrowerOf(a.application_id, a.party_id)).citizenship_status, null);
  // married: apply.details.spouse_later renders; no application.inviteParty is posted (the Invite control stays disabled)
  const spouse = page.getByTestId("apply-spouse-later").first(); assert.ok(await spouse.isVisible()); assert.equal((await spouse.innerText()).trim(), "Your spouse's part comes later. Nothing to add now.");
  assert.equal(await page.locator('[data-testid="apply"] .sm-invite[disabled]').count(), 1, "Invite is disabled in v1");
  // Continue with the five: profile.title resolves with option_id submit and the card's own option ids
  await pick(page, "Citizenship", "U.S. citizen");
  await continueTo(page, "questions", "details");
  const cards = await cardsOf(a.party_id); const profile = card(cards, "profile.title"); assert.ok(profile); assert.equal(profile.status, "resolved"); assert.equal(profile.command_ref, "application.confirmField");
  const answers = Object.fromEntries(((profile.evidence?.["fields"] as Json[]) ?? []).map((f) => [String(f["path"]), String(f["value"])]));
  assert.deepEqual(answers, { citizenship_status: "us_citizen", marital_status: "married", dependents: "2", military_service: "none", language_preference: "english" }, "the five fields");
  for (const f of (profile.evidence?.["fields"] as Json[]) ?? []) assert.ok(f["answered_at"], `${String(f["path"])} answered_at`);
  for (const [path, value] of Object.entries(answers)) if (options(path).length) assert.ok(options(path).includes(value), `${path}: ${value} is one of the card's option ids ${options(path).join("/")}`);
  const resolves = posted(page, new RegExp(`/cards/${profile.card_instance_id}/resolve`)); assert.equal(resolves.length, 1); assert.equal(bodyOf(resolves[0]!)["option_id"], "submit");
  const b = await borrowerOf(a.application_id, a.party_id); assert.equal(b.citizenship_status, "us_citizen"); assert.equal(b.marital_status, "married"); assert.equal(b.language_preference, "english");
  // the five plain fields each went through 21.1 captureField (ULAD-validated; a plain field is an event, not an intake-record value): application.field.captured{field} ×5
  const evs = await events(a.application_id);
  for (const field of ["citizenship_status", "marital_status", "dependents", "military_service", "language_preference"]) assert.ok(seqOf(evs, "application.field.captured", (p) => p["field"] === field) !== null, `application.field.captured{${field}}`);
  assert.equal(posted(page, /commands\/application\.inviteParty/).length, 0, "no inviteParty"); assert.equal(seqOf(evs, "application.party.invited"), null); assert.equal(cards.filter((c) => c.kind === "InviteCard").length, 0);
  assert.ok(card(cards, "declarations.occupancy"), "the declarations sequence starts on the citizenship capture");
  await page.getByTestId("apply-tab-tasks").first().click(); await page.waitForSelector('[data-testid="apply-task-details"][data-done="true"]', { timeout: 30_000 });
  await ctx.close();
});
test("32.19-T9: Declarations — Given \"Do any apply?\", when None, then `declarations.occupancy`, `declarations.clean_energy_lien` and `declarations.title{none}` are resolved one at a time and the borrower's `du_declarations` row carries the fourteen typed answers (32.3-T14 unchanged); when Something applies, then each `declarations.item` card renders one question at a time and every Yes with its follow-up persists.", { todo: true });
test("32.19-T10: Demographics — Given Demographics, when \"I do not wish to provide this information\", then `demographics.title` resolves with `[\"do_not_wish\"]` for ethnicity and race and `\"do_not_wish\"` for sex and `applicant_demographics.* = declined` with `collection_method = internet`; when answered, then only the card's own option ids are sent and the answers are never kept on the card.", { todo: true });
test("32.19-T11: Review is a readiness view — Given Review, then it reads `record.status.badge` and the pending cards from `/v1/borrower/thread`, renders no control that names a submission, lists every pending card as a task, and its one CTA resolves the number cards (`refi.value.confirm`, `refi.loan_amount.confirm`, `refi.product.choice`, or `preapproval.target`); the screen's text contains none of \"DU\", \"Desktop Underwriter\", \"Fannie\", \"Approve\", \"Eligible\", \"Ineligible\", \"Refer\".", { todo: true });
test("32.19-T12: The DU moment from the screens — Given Buy with an address or a refinance driven end to end through the Apply screens at 390 px with the FAKE vendors finishing on the tap, when the number cards are confirmed, then `application.trid_received`, `credit.report.received`, `du.document.emitted{required_missing = 0}`, `du.preflight.passed`, `du.submitted` and `du.findings.received` follow without any command posted by the page, the badge reads Verifying, Result renders the copy library's `du.running` line and the ChecklistCard when it comes, and a re-sent gap card (32.18 rule 7) renders as a task in the copy library's words.", { todo: true });
test("32.19-T13: Errors stay on the step — Given a required field empty, then the step stays with `.sm-error` and nothing is posted; given a `409 CARD_FIELD_REQUIRED` or a refusal `{code, copy_key}` from the API, then the step stays and `.sm-error` renders `copy(copy_key)`, never the code.", { todo: true });
test("32.19-T14: Tasks — Given the seven tasks, then each row's done state is derived from the card statuses (never remembered), a tap jumps to the step, a pending card with no step of its own (a gap card, `credit.liabilities.confirm`, `refi.current_loan.confirm`, a 33.3 refi_trigger card) renders in Tasks through the card component and resolves there, and the nothing-needed state renders when nothing is pending (32.13-T15).", { todo: true });
test("32.19-T15: My Loan, Chat, Account — Given a fresh account, then My Loan renders `apply.loan.empty`; given a partner-book party (33.1), then My Loan renders the badge Monitored, the partner as servicer, the loan's last four and the numbers, and Apply shows no organic step; Chat posts `POST /v1/borrower/messages` only and never resolves a card or posts a command; Account shows the first name and the partner and Sign out posts `auth/sign-out` and the next load is the door; a second fresh context sees nothing of the first person.", { todo: true });
test("32.19-T16: Deep links, returns, `?card=` — Given `/app/d/{token}` without a session, then `Account` renders with the token retained and after the session `/app?card={id}` lands on the step that owns the card's copy key (`STEP_OF_COPY_KEY`) or on Tasks with the card expanded; `/app/return/{vendor}/{card}` and `/app/auth/google/callback` land the same way; an unknown or another party's card lands on Apply with no card and no data revealed.", { todo: true });
test("32.19-T17: The chrome at 390 — Given every Apply screen at 390 px, then the five tabs and the primary CTA are in the viewport, `document.documentElement.scrollWidth ≤ 390`, `footer.disclosure` is present, the mark and the paper tokens are `apply.css`'s, and axe reports no serious violation at 390 and at 1280.", { todo: true });
test("32.19-T18: Every string is a copy key — Given every string the Apply screens render, then it is a key of copy-library.md (the `apply.*` family) rendered through `lib/copy`, no `.tsx` under `components/apply` contains a sentence literal, and 32.13-T13/T14 pass over the new keys.", { todo: true });
