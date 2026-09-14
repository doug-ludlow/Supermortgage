// 32.18 The DU moment: the assets connection, the credit pull and the underwriting run from the conversation
// spec/sections/32-borrower-experience/32-18-the-du-moment-assets-credit-and-the-underwriting-run-from-the-conversation.md
// One node:test per T-id, named exactly as the spec. The journey is driven through the borrower API the way the app drives it
// (the taps, the FAKE vendors finishing on the tap) with the scripted model of 32-16.spec.test.ts behind the turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { FakeStripeIdentity } from "../../runtime/borrower/vendors/fake-stripe-identity.ts";
import { FAKE_ASSET_ACCOUNTS, FAKE_PAYROLL_DEPOSITS } from "../../runtime/borrower/vendors/fake-plaid.ts";
import { REFINANCE_PROFILE } from "./eval/personas.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
const NOW = "2026-10-05T16:00:00.000Z";
const clock = new FixedClock(NOW);
type Json = Record<string, unknown>;

// ---------------------------------------------------------------- the scripted Messages API client (32-16.spec.test.ts's shape)
type Call = { name: string; input: Json };
type SceneCtx = { situation: Json; borrower: string; toolResults: Json[] };
type Scene = { when: RegExp; calls?: Call[] | ((c: SceneCtx) => Call[]); text: string | ((c: SceneCtx) => string); then?: string };
const FIRST_TURN: Scene = { when: /just created their account/, text: "Hi {{party.first_name}}, I'm Michelle, the automated assistant working for your lender. Are you looking to buy a home, lower your rate or payment, or take cash out?" };
const RETURNING: Scene = { when: /the borrower is back/, text: "Welcome back, {{party.first_name}}. The next thing I need from you is on the rail." };
function scriptedClient() {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = []; let scenes: Scene[] = [FIRST_TURN, RETURNING];
  let scene: Scene | undefined; let ctx: SceneCtx = { situation: {}, borrower: "", toolResults: [] };
  const message = (content: Anthropic.ContentBlock[], stop: "end_turn" | "tool_use"): Anthropic.Message =>
    ({ id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: "scripted", content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null } } as unknown as Anthropic.Message);
  const text = (t: string) => message([{ type: "text", text: t, citations: null }], "end_turn");
  const create = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    requests.push(params);
    const last = params.messages.at(-1)!;
    if (Array.isArray(last.content) && last.content.every((b) => (b as { type: string }).type === "tool_result")) {
      const results = (last.content as Anthropic.ToolResultBlockParam[]).map((r) => { try { return JSON.parse(String(r.content)) as Json; } catch { return { raw: r.content } as Json; } });
      ctx = { ...ctx, toolResults: [...ctx.toolResults, ...results] };
      const t = scene?.text; return text(typeof t === "function" ? t(ctx) : (t ?? "Okay."));
    }
    const content = typeof last.content === "string" ? last.content : "";
    if (content.startsWith("[guard]")) return text(scene?.then ?? "Let me put that another way: the next thing I need from you is on the rail.");
    const sit = /\[situation\]\n([\s\S]*?)\n\n\[borrower\]\n/.exec(content); const borrower = content.split("[borrower]\n")[1] ?? "";
    ctx = { situation: sit ? (JSON.parse(sit[1]!) as Json) : {}, borrower, toolResults: [] };
    scene = scenes.find((x) => x.when.test(borrower));
    if (!scene) return text("Okay — the next thing I need from you is on the rail here.");
    const calls = typeof scene.calls === "function" ? scene.calls(ctx) : scene.calls;
    if (!calls?.length) { const t = scene.text; return text(typeof t === "function" ? t(ctx) : t); }
    return message(calls.map((c, i) => ({ type: "tool_use", id: `toolu_${i}_${randomUUID().slice(0, 6)}`, name: c.name, input: c.input }) as unknown as Anthropic.ContentBlock), "tool_use");
  };
  return { client: { messages: { create } } as unknown as Anthropic, requests, use(next: Scene[]): void { scenes = [FIRST_TURN, RETURNING, ...next]; } };
}
const scripted = scriptedClient();

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${R}`]))[0]!.id;
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|32-18|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  await seedEntryDemo(runtime, { partner_id: partnerPartyId, states: ["AZ", "CO"], now: NOW });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId, llm: { client: scripted.client, model: "scripted" } });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); await journeyLock?.release(); } });

// ---------------------------------------------------------------- helpers over the borrower API
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.18.0.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const settle = async () => { await router.flows!.settle(); await router.agent?.settle(); await router.flows!.settle(); };
type CardRow = { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Json; evidence: Json | null; command_ref: string | null; created_at: string; resolved_at: string | null };
const cardsOf = async (partyId: string): Promise<CardRow[]> => db.query<CardRow>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at, resolved_at FROM card_instances WHERE party_id = $1 ORDER BY created_at, seq`, [partyId]);
const cardRow = async (id: string): Promise<CardRow> => (await db.query<CardRow>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at, resolved_at FROM card_instances WHERE card_instance_id = $1`, [id]))[0]!;
const events = async (appId: string, type?: string) => db.query<{ type: string; sequence: string; occurred_at: string; payload: Json }>(`SELECT type, sequence::text AS sequence, occurred_at, payload FROM loan_events WHERE application_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY loan_events.sequence`, [appId, type ?? null]);
const entitiesOf = async (kind: string, appId: string): Promise<Json[]> => (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1`, [kind])).map((r) => decodeEntityData(r.data) as Json).filter((d) => d["application_id"] === appId);
const fieldsEvidence = (card: CardRow, edits: Record<string, string> = {}) => ({ evidence: { fields: (card.props["fields"] as { path: string; value: string; source: string }[]).map((f) => ({ path: f.path, value_confirmed: edits[f.path] ?? f.value, source: f.source, confirmed_at: clock.now() })), edited: Object.keys(edits).length > 0 } });
const PASSWORD = `pw-du-${R}`;
type B = { token: string; party_id: string; app_id: string; email: string; name: string };
async function pending(b: B, copyKey: string): Promise<CardRow> { await settle(); const c = (await cardsOf(b.party_id)).filter((x) => x.copy_key === copyKey && x.status === "pending").at(-1); assert.ok(c, `a pending ${copyKey} card (pending: ${(await cardsOf(b.party_id)).filter((x) => x.status === "pending").map((x) => x.copy_key).join(", ")})`); return c; }
async function tap(b: B, card: CardRow, body: Json): Promise<Reply> { const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, body, bearer(b.token)); assert.equal(r.status, 201, `tap ${card.copy_key}: ${JSON.stringify(r.body).slice(0, 600)}`); await settle(); return r; }
async function signedUpWithGoal(tag: string, name = "Dana Reyes"): Promise<B> {
  const email = `${tag}-${R}@example.test`;
  const v = await api("POST", "/v1/borrower/auth/account", { action: "create", email, password: PASSWORD, legal_name: name }, {}, `10.18.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`);
  assert.equal(v.status, 200, JSON.stringify(v.body)); await settle();
  const token = v.body["token"] as string; const party_id = (v.body["party"] as Json)["party_id"] as string;
  const t = await api("GET", "/v1/borrower/thread?limit=500", undefined, bearer(token)); const goal = t.body["pinned_card"] as Json; assert.equal(goal["copy_key"], "entry.goal.question");
  const g = await api("POST", `/v1/borrower/cards/${goal["card_instance_id"]}/resolve`, { option_id: "lower_rate", evidence: { option_id: "lower_rate", tapped_at: clock.now() } }, bearer(token)); assert.equal(g.status, 201, JSON.stringify(g.body)); await settle();
  const apps = await db.query<{ id: string }>(`SELECT a.id FROM applications a JOIN application_borrowers ab ON ab.application_id = a.id WHERE ab.party_id = $1 ORDER BY a.created_at`, [party_id]); assert.equal(apps.length, 1);
  const legal = (await db.query<{ legal_name: string }>(`SELECT legal_name FROM parties WHERE id = $1`, [party_id]))[0]!.legal_name;
  return { token, party_id, app_id: apps[0]!.id, email, name: legal };
}
const ADDRESS = "100 N Central Ave, Phoenix, AZ 85004"; const DOB = "1988-04-12"; const SSN = "123-45-6789";
/** E5: the ID scan on the FAKE (the extraction named so the identity ConfirmCard has something to confirm), the identity confirmed, the SSN typed. */
async function identity(b: B): Promise<void> {
  const vs = await api("POST", "/v1/borrower/identity/stripe/session", { application_id: b.app_id }, bearer(b.token)); assert.equal(vs.status, 200, JSON.stringify(vs.body));
  (router.stripe as FakeStripeIdentity).complete(vs.body["vendor_session_id"] as string, clock.now(), { legal_name: b.name, date_of_birth: DOB, address: ADDRESS });
  const hook = await api("POST", "/v1/webhooks/stripe", { id: `evt-${randomUUID().slice(0, 8)}`, type: "identity.verification_session.verified", data: { object: { id: vs.body["vendor_session_id"], status: "verified" } } }, { "stripe-signature": "FAKE" }); assert.equal(hook.status, 200, JSON.stringify(hook.body)); await settle();
  const card = await pending(b, "identity.confirm.title"); await tap(b, card, fieldsEvidence(card));
}
async function typeSsn(b: B): Promise<void> { const ssn = await pending(b, "identity.ssn.title"); await tap(b, ssn, fieldsEvidence(ssn, { ssn: SSN })); }
async function home(b: B): Promise<void> { const card = await pending(b, "refi.home.confirm"); await tap(b, card, fieldsEvidence(card, { property_address: ADDRESS })); }
/** R3 on the FAKE: the payroll connection finishing on the tap, then the income ConfirmCard as the report shows it (an edit states a different figure — T5). */
async function income(b: B, edits: Record<string, string> = {}): Promise<void> {
  const connect = await pending(b, "income.connect.purpose");
  const s = await api("POST", "/v1/borrower/connect/truv_income/session", { card_instance_id: connect.card_instance_id, fake_complete: true }, bearer(b.token)); assert.equal(s.status, 200, JSON.stringify(s.body)); await settle();
  const card = await pending(b, "income.confirm.title"); await tap(b, card, fieldsEvidence(card, edits));
}
async function assets(b: B): Promise<Reply> { const card = await pending(b, "assets.connect.purpose"); const s = await api("POST", "/v1/borrower/connect/plaid_assets/session", { card_instance_id: card.card_instance_id, fake_complete: true }, bearer(b.token)); assert.equal(s.status, 200, JSON.stringify(s.body)); await settle(); return s; }
/** R4–R7: the profile, the declarations, the demographics, then the six items' cards (the value, the amount, the product). */
async function aboutYouAndSixItems(b: B, o: { value?: string; amount?: string } = {}): Promise<void> {
  const profile = await pending(b, "profile.title"); await tap(b, profile, { option_id: "submit", evidence: { fields: REFINANCE_PROFILE.map((x) => ({ path: x.path, value: x.value, answered_at: clock.now() })) } });
  const decl = await pending(b, "declarations.title"); await tap(b, decl, { option_id: "none", evidence: { option_id: "none", tapped_at: clock.now() } });
  const demo = await pending(b, "demographics.title"); await tap(b, demo, { option_id: "submit", evidence: { collection_method: "internet", answered_at: clock.now(), answers: { ethnicity: ["do_not_wish"], race: ["do_not_wish"], sex: "do_not_wish" } } });
  const value = await pending(b, "refi.value.confirm"); await tap(b, value, fieldsEvidence(value, { property_value_estimate: o.value ?? "80000000" }));
  const amount = await pending(b, "refi.loan_amount.confirm"); await tap(b, amount, fieldsEvidence(amount, { loan_amount_sought: o.amount ?? "56000000" }));
  const product = (await cardsOf(b.party_id)).filter((x) => x.copy_key === "refi.product.choice" && x.status === "pending").at(-1);
  if (product) await tap(b, product, { option_id: "FRM30", evidence: { option_id: "FRM30", tapped_at: clock.now() } });
}
/** The whole journey to the DU moment (T3/T4/T5/T7): the identity, the SSN (the credit pull), the home, the income, the assets, about you, the six items. */
async function toDu(tag: string, o: { incomeEdits?: Record<string, string>; withAssets?: boolean } = {}): Promise<B> {
  const b = await signedUpWithGoal(tag);
  await identity(b); await typeSsn(b); await home(b); await income(b, o.incomeEdits ?? {}); if (o.withAssets !== false) await assets(b); await aboutYouAndSixItems(b);
  return b;
}
const duSubmission = async (appId: string): Promise<Json> => { const subs = (await entitiesOf("du_submissions", appId)).sort((a, b) => Number(a["submission_number"]) - Number(b["submission_number"])); assert.ok(subs.length, "a du_submissions row"); return subs.at(-1)!; };
const validations = (sub: Json): Record<string, string> => Object.fromEntries(((sub["validation_results"] as Json[] | undefined) ?? []).map((v) => [String(v["component"]), String(v["outcome"])]));


test("32.18-T1: Given a new account whose goal was tapped (the connectors sent), then a `ConnectCard{plaid_assets}` (`assets.connect.purpose`, \"Connect with Plaid\") is on the record beside the identity and payroll cards; when the page opens `POST /v1/borrower/connect/plaid_assets/session` with `fake_complete: true` on it, then in that request `verification.received{kind=assets, supplier_code=plaid, report_days=365}` is logged, a `verifications` row carries the report reference, one `application_assets` row per account of the FAKE report exists (institution, last four, balance, `verified = true`), the card is `connected` with the `verification_id`, and nothing was posted by the page.", { skip }, async () => {
  const b = await signedUpWithGoal("t1");
  // the connectors, in send order: the ID scan, the payroll connection, the assets connection (rule 1)
  const connectors = (await cardsOf(b.party_id)).filter((c) => c.kind === "ConnectCard").map((c) => [c.copy_key, c.props["vendor"]]);
  assert.deepEqual(connectors, [["identity.stripe.purpose", "stripe_identity"], ["income.connect.purpose", "truv_income"], ["assets.connect.purpose", "plaid_assets"]], JSON.stringify(connectors));
  const card = await pending(b, "assets.connect.purpose"); assert.equal(card.props["state"], "not_started"); assert.equal(card.props["vendor_fake"], "FAKE"); assert.deepEqual(card.props["what_we_get"], ["balances", "twelve months of deposits"]);
  const webhooks = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE application_id = $1 AND type = 'verification.received'`, [b.app_id]); assert.equal(webhooks[0]!.n, "0");
  const s = await api("POST", "/v1/borrower/connect/plaid_assets/session", { card_instance_id: card.card_instance_id, fake_complete: true }, bearer(b.token)); assert.equal(s.status, 200, JSON.stringify(s.body)); await settle();
  assert.equal(s.body["vendor"], "plaid_assets"); assert.equal(s.body["delivery"], "FAKE"); assert.equal(s.body["status"], "report_ready"); assert.equal(s.body["outcome"], "connected", JSON.stringify(s.body)); assert.equal(s.body["accounts"], FAKE_ASSET_ACCOUNTS.length);
  const received = (await events(b.app_id, "verification.received")).filter((e) => e.payload["kind"] === "assets"); assert.equal(received.length, 1, "verification.received{kind=assets} once");
  assert.equal(received[0]!.payload["supplier_code"], "plaid"); assert.equal(received[0]!.payload["report_days"], 365); assert.equal(received[0]!.payload["report_reference_id"], s.body["report_reference_id"]);
  const verification = (await entitiesOf("verifications", b.app_id)).find((v) => v["kind"] === "assets")!; assert.ok(verification, "a verifications row"); assert.equal(verification["report_reference_id"], s.body["report_reference_id"]); assert.equal(verification["supplier_code"], "plaid"); assert.equal(verification["report_days"], 365);
  const rows = await db.query<{ institution: string; account_last4: string; balance_cents: string; verified: boolean; asset_kind: string }>(`SELECT institution, account_last4, balance_cents::text AS balance_cents, verified, asset_kind FROM application_assets WHERE application_id = $1 ORDER BY account_last4`, [b.app_id]);
  assert.deepEqual(rows.map((r) => [r.institution, r.account_last4, r.balance_cents, r.verified, r.asset_kind]), [...FAKE_ASSET_ACCOUNTS].sort((x, y) => x.last4.localeCompare(y.last4)).map((a) => [a.institution, a.last4, a.balance_cents, true, a.account_type]));
  const after = await cardRow(card.card_instance_id); assert.equal(after.status, "resolved"); assert.equal(after.props["state"], "connected"); assert.equal(after.evidence?.["outcome"], "connected"); assert.equal(after.evidence?.["verification_id"], s.body["verification_id"]); assert.equal(after.evidence?.["vendor_fake"], "FAKE");
  assert.equal((await db.query(`SELECT 1 FROM ui_events WHERE card_instance_id = $1 AND kind = 'connector_completed'`, [card.card_instance_id])).length, 1, "the connector's completion in the UI trail");
});

test("32.18-T2: Given the hard-pull authorization written on the goal's tap and the SSN captured as the one typed field, when the six items are in (`application.trid_received`), then the platform orders the credit report once — `credit.report.ordered` then `credit.report.received` with a usable tri-merge report (22.2; `permissible_purpose = credit_transaction_604a3A`, the partner's certification reference, `fee_sm_borne` — 22.2 refuses an order without the borrower's authorization reference, so the report proves it was given) — and 32.3 R2's liabilities ConfirmCard follows; before the six items nothing is ordered, and a second capture orders nothing more (one `credit_reports` row).", { skip }, async () => {
  const b = await signedUpWithGoal("t2");
  const lead = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'leads' AND id = $1`, [b.app_id])).map((r) => decodeEntityData(r.data) as Json)[0]; assert.ok(lead, "the organic application's lead record");
  const authz = ((lead["credit_authorizations"] as Json[] | undefined) ?? []).filter((a) => a["kind"] === "hard_application").map((a) => ({ authorization_id: String(a["authorization_id"]), kind: String(a["kind"]) })); assert.equal(authz.length, 1, `the goal's tap wrote the hard-pull authorization (32.17 rule 20): ${JSON.stringify(lead["credit_authorizations"])}`);
  assert.equal((await events(b.app_id, "credit.report.ordered")).length, 0, "nothing ordered before the SSN");
  await identity(b);
  assert.equal((await events(b.app_id, "credit.report.ordered")).length, 0, "the identity alone orders nothing");
  await typeSsn(b);
  assert.equal((await events(b.app_id, "credit.report.ordered")).length, 0, "the SSN alone orders nothing before the six items (22.2 R1)");
  await home(b); await income(b); await assets(b); await aboutYouAndSixItems(b);
  assert.equal((await events(b.app_id, "application.trid_received")).length, 1, "the six items are in");
  const ordered = await events(b.app_id, "credit.report.ordered"); const received = await events(b.app_id, "credit.report.received");
  assert.equal(ordered.length, 1, "one order on the six items"); assert.ok(received.length >= 1, "the FAKE bureau answered at once");
  const report = (await entitiesOf("credit_reports", b.app_id))[0]!; assert.ok(report, "the credit_reports row"); assert.equal(report["state"], "usable"); assert.match(String(report["report_type"]), /^tri_merge/); assert.equal(report["permissible_purpose"], "credit_transaction_604a3A");
  assert.equal(ordered[0]!.payload["permissible_purpose"], "credit_transaction_604a3A"); assert.equal(ordered[0]!.payload["certification_ref"], report["certification_ref"]); assert.ok(String(report["certification_ref"]).length > 0, "the partner's certification reference");
  assert.ok(authz[0]!.authorization_id, "the authorization 22.2 refused to order without");
  const liabilities = (await cardsOf(b.party_id)).find((c) => c.copy_key === "credit.liabilities.confirm"); assert.ok(liabilities, "R2's liabilities card followed the report");
  // a second SSN capture orders nothing more: the SSN card is resolved — re-run the flow's reaction path by re-sending the goal's own event through a fresh six-item capture on the intake record
  await runtime.execute({ process: "21.1", name: "captureField", loanId: "", applicationId: b.app_id, actor: { kind: "agent", id: "intake" }, input: { application_id: b.app_id, field: "ssn", value: SSN.replace(/\D/g, "") }, run: { runId: `t2:${R}`, modelVersion: "test", promptVersion: "test" } }); await settle();
  assert.equal((await events(b.app_id, "credit.report.ordered")).length, 1, "one order, however many captures"); assert.equal((await entitiesOf("credit_reports", b.app_id)).length, 1, "one credit_reports row");
});

test("32.18-T3: Given an application with the six items, a usable credit report, income on file and the assets report connected, when the last of them lands, then in that settlement `du.casefile.created`, `du.credit.associated`, `du.submitted`, `du.findings.received` and `du.findings.interpreted` are logged once each; the submission's snapshot is built from the tables (`loan_purpose = limited_cash_out_refinance`, the loan amount and value as stated, `product = fixed_30` over 360, `qualifying_income_cents` = Σ `application_income`, every borrower with `ssn_last4 = tin_last4`) and the request's `validation_report_refs` name the asset report (`supplier_type = plaid`, `report_type = asset_verification_365d`); the StatusCard `du.running` and the ChecklistCard are on the record; a further prerequisite event runs nothing more (one `du_casefiles` row).", { skip }, async () => {
  const b = await signedUpWithGoal("t3");
  await identity(b); await typeSsn(b); await home(b); await income(b); await assets(b);
  assert.equal((await events(b.app_id, "du.submitted")).length, 0, "nothing runs before the six items");
  await aboutYouAndSixItems(b);
  for (const type of ["du.casefile.created", "du.credit.associated", "du.submitted", "du.findings.received", "du.findings.interpreted"]) assert.equal((await events(b.app_id, type)).length, 1, `${type} once`);
  const sub = await duSubmission(b.app_id); const snap = sub["snapshot"] as Json;
  assert.equal(snap["loan_purpose"], "limited_cash_out_refinance"); assert.equal(String(snap["loan_amount_cents"]), "56000000"); assert.equal(String(snap["appraised_value_cents"]), "80000000"); assert.equal(snap["product"], "fixed_30"); assert.equal(snap["loan_term"], 360); assert.equal(snap["occupancy"], "principal_residence");
  const incomeRows = await db.query<{ total: string }>(`SELECT sum(monthly_amount_cents)::text AS total FROM application_income WHERE application_id = $1 AND qualifying`, [b.app_id]); assert.equal(String(snap["qualifying_income_cents"]), incomeRows[0]!.total, "Σ application_income");
  const borrowers = await db.query<{ id: string; tin_last4: string }>(`SELECT id::text AS id, tin_last4 FROM application_borrowers WHERE application_id = $1 ORDER BY created_at`, [b.app_id]);
  const report = (await entitiesOf("credit_reports", b.app_id))[0]!;
  assert.deepEqual((snap["borrowers"] as Json[]).map((x) => [x["borrower_id"], x["ssn_last4"]]), (report["borrower_ids"] as string[]).map((id, k) => [id, borrowers[k]!.tin_last4]), "every borrower the report names, with ssn_last4 = tin_last4");
  const refs = (sub["validation_report_refs"] as Json[] | undefined) ?? [];
  const reportRef = (await entitiesOf("verifications", b.app_id)).find((v) => v["kind"] === "assets")!["report_reference_id"];
  assert.ok(refs.some((r) => r["supplier_type"] === "plaid" && r["identifier"] === reportRef && r["report_type"] === "asset_verification_365d"), `the asset report on the request (the submission row): ${JSON.stringify(refs)}`);
  assert.ok(((sub["validation_results"] as Json[]) ?? []).some((v) => v["report_reference_id"] === reportRef), "the findings validated against it");
  const cards = await cardsOf(b.party_id); assert.ok(cards.some((c) => c.kind === "StatusCard" && c.copy_key === "du.running"), "the StatusCard du.running"); assert.ok(cards.some((c) => c.kind === "ChecklistCard"), "the ChecklistCard of conditions");
  // a further prerequisite event runs nothing more: one casefile
  await runtime.execute({ process: "21.1", name: "captureField", loanId: "", applicationId: b.app_id, actor: { kind: "agent", id: "intake" }, input: { application_id: b.app_id, field: "income", value: "820000" }, run: { runId: `t3:${R}`, modelVersion: "test", promptVersion: "test" } }); await settle();
  assert.equal((await entitiesOf("du_casefiles", b.app_id)).length, 1, "one du_casefiles row"); assert.equal((await events(b.app_id, "du.submitted")).length, 1);
});

test("32.18-T4: Given the worked example's application ($560,000.00 sought at 6.125% on a home worth $800,000.00, $8,200.00 a month of qualifying income, no tradelines on the fixture bureau's report), then the snapshot carries `total_obligations_cents` = $3,402.62 (the proposed P&I alone) and `qualifying_income_cents` = $8,200.00, and the FAKE findings show `dti_du = 41.50`.", { skip }, async () => {
  // the day's sheet: par (price 100.000) at 6.125% for FRM30, published after the seed's FAKE demo sheet so it is the newest (rule 4: no quote yet → the sheet's par rate)
  const grid = (rows: [string, string][]) => rows.map(([r, pr]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 45, price: pr }));
  await runtime.execute({ process: "20.4", name: "publishRateSheet", loanId: "", actor: { kind: "agent", id: "pricing" }, run: { runId: `t4:${R}`, modelVersion: "test", promptVersion: "test" }, input: { rate_sheet_id: `rs-t4-${R}`, partner_id: partnerPartyId, source: "pe_whole_loan_api", published_at: new Date(Date.parse(NOW) + 60_000).toISOString(), expires_at: new Date(Date.parse(NOW) + 86_400_000).toISOString(), prices: grid([["6.375", "101.875"], ["6.250", "101.375"], ["6.125", "100.000"], ["6.000", "99.750"], ["5.875", "99.125"]]), published_by: "32.18-T4 (FAKE sheet)" } });
  const b = await toDu("t4");
  const sub = await duSubmission(b.app_id); const snap = sub["snapshot"] as Json;
  assert.equal(String(snap["loan_amount_cents"]), "56000000"); assert.equal(String(snap["appraised_value_cents"]), "80000000"); assert.equal(String(snap["note_rate_pct"]), "6.125", "the newest published sheet's par rate for FRM30 (no quote yet)");
  assert.equal(String(snap["qualifying_income_cents"]), "820000", "$8,200.00");
  assert.equal(String(snap["total_obligations_cents"]), "340262", "the proposed P&I alone, $3,402.62 (no tradelines on the fixture bureau's report)");
  assert.equal(sub["dti_du"], "41.50", "4,149.54 bps half-up"); assert.equal(sub["recommendation"], "approve_eligible");
  assert.equal((await entitiesOf("credit_reports", b.app_id))[0]!["tradelines"] === undefined || ((await entitiesOf("credit_reports", b.app_id))[0]!["tradelines"] as unknown[]).length === 0, true, "no tradelines");
});

test("32.18-T5: Given the 12-month asset report on the request and a stated income within 10% of the report's payroll deposits, then the findings carry `validation_results` `assets`, `employment` and `income` `validated` for the borrower, the interpretation's relief covers the three, and no income documentation condition (`COND_DU_VERIFY_INCOME_BASE`) is opened for the borrower; given a stated income 20% above the deposits, `income` is `not_validated`, `employment` and `assets` stay `validated`, and the income documentation condition is opened (its evidence the paystub and the W-2) and stays open for 23.3's decision to request.", { skip }, async () => {
  // the stated income within 10% of the report's deposits (the ConfirmCard as the report shows it: $8,200.00 = the deposits)
  const b = await toDu("t5");
  const sub = await duSubmission(b.app_id); const v = validations(sub);
  assert.deepEqual(v, { assets: "validated", employment: "validated", income: "validated" }, JSON.stringify(sub["validation_results"]));
  assert.ok(((sub["validation_results"] as Json[])[0]!["report_reference_id"] as string).startsWith("PLAID-FAKE-"), "the report reference on every result");
  const interp = (await entitiesOf("du_findings_interpretations", b.app_id)).at(-1) ?? (await entitiesOf("du_interpretations", b.app_id)).at(-1);
  const relief = (interp?.["relief_components"] ?? interp?.["relief"]) as Json | string[] | undefined; assert.ok(relief, `relief on the interpretation: ${JSON.stringify(interp).slice(0, 400)}`);
  const reliefOn = Array.isArray(relief) ? relief : Object.entries(relief).filter(([, on]) => on === true).map(([k]) => k); for (const c of ["assets", "employment", "income"]) assert.ok(reliefOn.includes(c), `relief on ${c}: ${JSON.stringify(relief)}`);
  const openIncome = (await entitiesOf("conditions", b.app_id)).filter((c) => c["template_code"] === "COND_DU_VERIFY_INCOME_BASE" && !["cleared", "waived", "superseded", "satisfied"].includes(String(c["status"])));
  assert.equal(openIncome.length, 0, `no open income documentation condition: ${JSON.stringify(openIncome.map((c) => c["status"]))}`);
  // a stated income 20% above the deposits: employment and assets stay validated, income is not, and the income documentation condition is opened with its UploadCards
  const monthly = BigInt(FAKE_PAYROLL_DEPOSITS.monthly_cents); const above = ((monthly * 12n) / 10n).toString();
  const b2 = await toDu("t5b", { incomeEdits: { monthly_base_cents: above } });
  const sub2 = await duSubmission(b2.app_id); const v2 = validations(sub2);
  assert.deepEqual(v2, { assets: "validated", employment: "validated", income: "not_validated" }, JSON.stringify(sub2["validation_results"]));
  assert.equal(String((sub2["snapshot"] as Json)["qualifying_income_cents"]), above);
  const openIncome2 = (await entitiesOf("conditions", b2.app_id)).filter((c) => c["template_code"] === "COND_DU_VERIFY_INCOME_BASE" && !["cleared", "waived", "superseded", "satisfied"].includes(String(c["status"])));
  assert.ok(openIncome2.length >= 1, "the income documentation condition stays open");
  const kinds = ((openIncome2[0]!["evidence_kinds"] as string[] | undefined) ?? []); assert.ok(kinds.includes("paystub") && kinds.includes("w2"), `the paystub and the W-2 as its evidence: ${JSON.stringify(openIncome2[0])}`);
  assert.match(String(openIncome2[0]!["status"]), /^(open|waiting_borrower)$/, "an open state: waiting on the borrower");
});

test("32.18-T6: Given the findings interpreted, when the borrower asks how underwriting went, then the situation carries `underwriting{validated, conditions_for_you, checklist_card_instance_id}` and the reply says underwriting has run and names the checklist card, contains no DU message text, none of the words Approve, Eligible, Ineligible or Refer, and no figure; every `/v1/borrower/*` payload stays free of findings fields (32.3 T-03-19 unchanged).", { skip }, async () => {
  const b = await toDu("t6");
  const DU_WORDS = /\b(approve|approved|eligible|ineligible|refer|findings|DU)\b/i;
  const REPLY = "Underwriting has run on your application. The checklist card here lists what is still needed from you, and I will say when anything changes.";
  scripted.use([{ when: /how did underwriting go/i, text: REPLY }]);
  const r = await api("POST", "/v1/borrower/messages", { text: "How did underwriting go?", channel: "app" }, bearer(b.token)); assert.equal(r.status, 200, JSON.stringify(r.body)); await settle();
  const situation = /\[situation\]\n([\s\S]*?)\n\n\[borrower\]\n/.exec(String(scripted.requests.at(-1)!.messages[0]!.content))?.[1]; assert.ok(situation, "the situation the turn read"); const view = JSON.parse(situation) as Json;
  const uw = (view["record"] as Json)["underwriting"] as Json; assert.ok(uw, `underwriting on the situation: ${Object.keys(view["record"] as Json).join(",")}`);
  assert.deepEqual(uw["validated"], ["assets", "employment", "income"]); assert.equal(typeof uw["conditions_for_you"], "number"); assert.ok(uw["checklist_card_instance_id"], "the checklist card named");
  assert.doesNotMatch(situation, /Approve\/Eligible|approve_eligible|DU-1|dti_du|findings_json/, "no finding, recommendation or figure in the situation");
  const reply = r.body["reply"] as Json; assert.equal(reply["body_text"], REPLY); assert.doesNotMatch(String(reply["body_text"]), DU_WORDS); assert.doesNotMatch(String(reply["body_text"]), /\d/);
  // 32.3 T-03-19 unchanged: no findings field in any borrower payload
  for (const path of [`/v1/borrower/record?subject=${b.app_id}`, "/v1/borrower/thread?limit=500", "/v1/borrower/me"]) { const p = await api("GET", path, undefined, bearer(b.token)); assert.equal(p.status, 200); assert.doesNotMatch(JSON.stringify(p.body), /approve_eligible|Approve\/Eligible|findings_json|risk_factors|"DU-1"/, path); }
});

test("32.18-T7: Given the refinance persona's conversation (32.16's fixture: the goal, the home, the income, the connectors on the FAKE, the profile, the declarations, the demographics, the SSN, the value, the amount and the product), then `du.findings.received` is on the application before any Loan Estimate, with no platform-side DU call by the test, and 24.1's `readDuOffer` reads the FAKE findings' offer object as `value_acceptance` (the appraisal order after the intent proceeds on it).", { skip }, async () => {
  const b = await toDu("t7");
  const received = await events(b.app_id, "du.findings.received"); assert.equal(received.length, 1, "du.findings.received by the conversation's own taps — no platform-side DU call by the test");
  assert.equal((await events(b.app_id, "disclosure.le.delivered")).length, 0, "before any Loan Estimate");
  const decisions = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_decisions WHERE action = 'underwriting.run'`); assert.ok(Number(decisions[0]!.n) >= 1, "the DU moment's own decision record");
  // 32.18 rule 7: 24.1 reads the FAKE findings' offer object as value_acceptance
  const offer = await runtime.execute({ process: "24.1", name: "readDuOffer", loanId: "", applicationId: b.app_id, actor: { kind: "agent", id: "valuation" }, input: { application_id: b.app_id }, run: { runId: `t7:${R}`, modelVersion: "test", promptVersion: "test" } });
  assert.equal((offer.output as Json)["offer_type"], "value_acceptance", JSON.stringify(offer.output)); assert.equal((offer.output as Json)["recommendation"], "approve_eligible");
});
