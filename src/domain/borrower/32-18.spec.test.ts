// 32.18 The DU moment: the assets connection, the credit pull and the underwriting run from the conversation
// spec/sections/32-borrower-experience/32-18-the-du-moment-assets-credit-and-the-underwriting-run-from-the-conversation.md
// One node:test per T-id, named exactly as the spec. The journey is driven through the borrower API the way the app drives it
// (the taps, the FAKE vendors finishing on the tap) with the scripted model of 32-16.spec.test.ts behind the turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { decodeEntityData, encodeEntityData } from "../../infra/db/entities.ts";
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
import { readDuDocument } from "../underwriting/du/persist.ts";
import { decryptTin, tinCipherKey } from "../../infra/pii/tin.ts";
import { reactDuGaps } from "../../runtime/borrower/flows/3-entry.ts";
import type { FlowDeps, CardTrigger } from "../../runtime/borrower/flows/index.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
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

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";
/** The flow's own log lines about 32.18 rule 7's gaps (`borrower.flow.32-18.gap.*`) — T8 reads the platform-gap lines here. */
const flowLog: string[] = [];

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${R}`]))[0]!.id;
  const logger = createLogger("json", (line) => { if (/32-18\.gap/.test(line)) flowLog.push(line); if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|32-18|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  await seedEntryDemo(runtime, { partner_id: partnerPartyId, states: ["AZ", "CO"], now: NOW });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId, llm: { client: scripted.client, model: "scripted" } });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

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
async function signedUpWithGoal(tag: string, name = "Dana Reyes", option: "lower_rate" | "cash_out" = "lower_rate"): Promise<B> {
  const email = `${tag}-${R}@example.test`;
  const v = await api("POST", "/v1/borrower/auth/account", { action: "create", email, password: PASSWORD, legal_name: name }, {}, `10.18.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`);
  assert.equal(v.status, 200, JSON.stringify(v.body)); await settle();
  const token = v.body["token"] as string; const party_id = (v.body["party"] as Json)["party_id"] as string;
  const t = await api("GET", "/v1/borrower/thread?limit=500", undefined, bearer(token)); const goal = t.body["pinned_card"] as Json; assert.equal(goal["copy_key"], "entry.goal.question");
  const g = await api("POST", `/v1/borrower/cards/${goal["card_instance_id"]}/resolve`, { option_id: option, evidence: { option_id: option, tapped_at: clock.now() } }, bearer(token)); assert.equal(g.status, 201, JSON.stringify(g.body)); await settle();
  const apps = await db.query<{ id: string }>(`SELECT a.id FROM applications a JOIN application_borrowers ab ON ab.application_id = a.id WHERE ab.party_id = $1 ORDER BY a.created_at`, [party_id]); assert.equal(apps.length, 1);
  // the account door names the party by its e-mail (borrower-parties.ts); the name the ID reads (identity(): the FAKE's extraction) is `name` — 32.18 rule 7: it is what 23.6 splits into FirstName / LastName
  return { token, party_id, app_id: apps[0]!.id, email, name };
}
const ADDRESS = "100 N Central Ave, Phoenix, AZ 85004"; const DOB = "1988-04-12";
/** The typed SSN — its digits chosen so they coincide with no other fixture figure (the FAKE partner's seller number is 123456789), so T8's "never on a payload" checks are unambiguous. */
const SSN = "531-47-2468"; const SSN_DIGITS = SSN.replace(/\D/g, ""); const SSN_ANYWHERE = new RegExp(`${SSN_DIGITS.slice(0, 3)}-?${SSN_DIGITS.slice(3, 5)}-?${SSN_DIGITS.slice(5)}`);
/** E5: the ID scan on the FAKE (the extraction named so the identity ConfirmCard has something to confirm), the identity confirmed, the SSN typed. */
async function identity(b: B): Promise<void> {
  const vs = await api("POST", "/v1/borrower/identity/stripe/session", { application_id: b.app_id }, bearer(b.token)); assert.equal(vs.status, 200, JSON.stringify(vs.body));
  (router.stripe as FakeStripeIdentity).complete(vs.body["vendor_session_id"] as string, clock.now(), { legal_name: b.name, date_of_birth: DOB, address: ADDRESS });
  const hook = await api("POST", "/v1/webhooks/stripe", { id: `evt-${randomUUID().slice(0, 8)}`, type: "identity.verification_session.verified", data: { object: { id: vs.body["vendor_session_id"], status: "verified" } } }, { "stripe-signature": "FAKE" }); assert.equal(hook.status, 200, JSON.stringify(hook.body)); await settle();
  const card = await pending(b, "identity.confirm.title"); await tap(b, card, fieldsEvidence(card, { residency_basis: "own", months_at_address: "72" }));   // 32.3 E5: the residence basis and the months on the same card (six years, owned: no SQ-06)
}
async function typeSsn(b: B): Promise<void> { const ssn = await pending(b, "identity.ssn.title"); await tap(b, ssn, fieldsEvidence(ssn, { ssn: SSN })); }
/** R1: the home confirmed with the two facts only the borrower gives (32.18 rule 7: the estate and the clean-energy lien, asked on every file). */
async function home(b: B, edits: Record<string, string> = {}): Promise<void> { const card = await pending(b, "refi.home.confirm"); await tap(b, card, fieldsEvidence(card, { property_address: ADDRESS, estate_type: "fee_simple", existing_clean_energy_lien: "no", ...edits })); }
/** R3 on the FAKE: the payroll connection finishing on the tap, then the income ConfirmCard as the report shows it (an edit states a different figure — T5). */
async function income(b: B, edits: Record<string, string> = {}): Promise<void> {
  const connect = await pending(b, "income.connect.purpose");
  const s = await api("POST", "/v1/borrower/connect/truv_income/session", { card_instance_id: connect.card_instance_id, fake_complete: true }, bearer(b.token)); assert.equal(s.status, 200, JSON.stringify(s.body)); await settle();
  const card = await pending(b, "income.confirm.title"); await tap(b, card, fieldsEvidence(card, edits));
}
async function assets(b: B): Promise<Reply> { const card = await pending(b, "assets.connect.purpose"); const s = await api("POST", "/v1/borrower/connect/plaid_assets/session", { card_instance_id: card.card_instance_id, fake_complete: true }, bearer(b.token)); assert.equal(s.status, 200, JSON.stringify(s.body)); await settle(); return s; }
/** R4–R7: the profile, the declarations, the demographics, then the six items' cards (the value, the amount, the product). */
async function aboutYouAndSixItems(b: B, o: { value?: string; amount?: string; /** DELTA-37: the amount card's other fields (a cash-out's `cash_out_purpose`) */ amountEdits?: Record<string, string>; /** runs before the amount's tap — the sixth item, on which the DU moment runs (T8 alters the tables between the cards and the run) */ beforeAmount?: () => Promise<void> } = {}): Promise<void> {
  const profile = await pending(b, "profile.title"); await tap(b, profile, { option_id: "submit", evidence: { fields: REFINANCE_PROFILE.map((x) => ({ path: x.path, value: x.value, answered_at: clock.now() })) } });
  const occ = await pending(b, "declarations.occupancy"); await tap(b, occ, { option_id: "yes_no_prior", evidence: { option_id: "yes_no_prior", tapped_at: clock.now() } });   // 32.3 R5: 5a.A precedes the list on every file
  const lien = await pending(b, "declarations.clean_energy_lien"); await tap(b, lien, { option_id: "no", evidence: { option_id: "no", tapped_at: clock.now() } });   // then 5a.E on its own card
  const decl = await pending(b, "declarations.title"); await tap(b, decl, { option_id: "none", evidence: { option_id: "none", tapped_at: clock.now() } });
  const demo = await pending(b, "demographics.title"); await tap(b, demo, { option_id: "submit", evidence: { collection_method: "internet", answered_at: clock.now(), answers: { ethnicity: ["do_not_wish"], race: ["do_not_wish"], sex: "do_not_wish" } } });
  const value = await pending(b, "refi.value.confirm"); await tap(b, value, fieldsEvidence(value, { property_value_estimate: o.value ?? "80000000" }));
  const amount = await pending(b, "refi.loan_amount.confirm"); if (o.beforeAmount) await o.beforeAmount(); await tap(b, amount, fieldsEvidence(amount, { loan_amount_sought: o.amount ?? "56000000", ...(o.amountEdits ?? {}) }));
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

/** The guard's INTERNALS words (src/runtime/borrower/agent/guard.ts) and the hand-off's own — none may reach a thread line, a card prop or a borrower payload. */
const DU_INTERNALS = /\b(?:DU|desktop underwriter|findings?|preflight|casefile|MISMO|ULAD|XPath|data point|tradelines?|credit score)\b/i;
/** Every key at any depth of a payload — 32.13 T3/T6's contract: `tin` / `ssn` / `tin_encrypted` are never a key on a /v1/borrower/* response. */
const keysOf = (v: unknown, out: Set<string> = new Set()): Set<string> => { if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Json)) { out.add(k); keysOf(x, out); } return out; };
const emittedGaps = async (appId: string): Promise<{ payload: Json; gaps: { code: string; path: string }[] }[]> => (await events(appId, "du.document.emitted")).map((e) => ({ payload: e.payload, gaps: (e.payload["gaps"] as { code: string; path: string }[] | undefined) ?? [] }));
const pendingKeys = async (partyId: string): Promise<string[]> => (await cardsOf(partyId)).filter((c) => c.status === "pending").map((c) => `${c.copy_key}@${String(c.props["flow_key"])}`);
const borrowerRowsOf = async (appId: string) => db.query<{ id: string; legal_name: string; tin_last4: string | null; tin_encrypted: Buffer | null }>(`SELECT id::text AS id, legal_name, tin_last4, tin_encrypted FROM application_borrowers WHERE application_id = $1 ORDER BY created_at`, [appId]);

test("32.18-T8: Given the DU moment's document reports a required data point as missing (23.6's `du.document.emitted{required_missing, gaps}`, and 23.7's `du.preflight.refused` once preflight runs), then a gap the borrower supplies — a section 5 declaration, the current residence with its basis, the home's estate type or its existing clean-energy lien answer — makes the card that collects it the current ask on the rail (the declarations card, the address confirm card, the home card) in the copy library's words, with no DU word in any `/v1/borrower/*` payload or thread line, and its resolution re-runs the assembly so the gap closes; a gap the platform derives from what the borrower already gave — the last name from the legal name, the taxpayer identifier from the typed SSN, the state and the attachment type from the confirmed home — never becomes a borrower ask; and the refinance persona's journey (T7's cards, the home card carrying the estate type and the clean-energy lien answer) emits its document with `required_missing = 0`.", { skip }, async () => {
  // ── (1) the refinance persona's journey (T7's cards; the home card carrying the estate type and the clean-energy lien answer) emits its document with required_missing = 0
  const b = await toDu("t8");
  const [emitted, ...more] = await emittedGaps(b.app_id); assert.ok(emitted, "du.document.emitted on the DU moment"); assert.equal(more.length, 0, "one emission");
  assert.equal(Number(emitted.payload["required_missing"]), 0, `no gap: ${JSON.stringify(emitted.gaps)}`); assert.deepEqual(emitted.gaps, []);
  const doc = await readDuDocument(db, { application_id: b.app_id }); assert.ok(doc, "the du_documents row"); assert.equal(doc.required_missing, 0);
  // the platform's own points, derived at assembly from what the borrower already gave (rule 7): the last name from the legal name (23.6's split), the taxpayer identifier from the SSN typed on E5
  // (application_borrowers.tin_encrypted, decrypted for the document only), the state and the attachment type from the confirmed home (the address parsed into application_properties; sfr → Detached);
  // and the two the home card asked
  for (const s of ["<FirstName>Dana</FirstName>", "<LastName>Reyes</LastName>", "<TaxpayerIdentifierType>SocialSecurityNumber</TaxpayerIdentifierType>", `<TaxpayerIdentifierValue>${SSN_DIGITS}</TaxpayerIdentifierValue>`, "<StateCode>AZ</StateCode>", "<AttachmentType>Detached</AttachmentType>", "<PropertyEstateType>FeeSimple</PropertyEstateType>", "<PropertyExistingCleanEnergyLienIndicator>false</PropertyExistingCleanEnergyLienIndicator>"]) assert.ok(doc.xml.includes(s), `${s} on the document`);
  const [row] = await borrowerRowsOf(b.app_id); assert.equal(row!.legal_name, "Dana Reyes", "the legal name the identity card confirmed"); assert.equal(row!.tin_last4, SSN_DIGITS.slice(-4)); assert.ok(row!.tin_encrypted, "the nine digits at rest, encrypted"); assert.equal(decryptTin(row!.tin_encrypted!, tinCipherKey()), SSN_DIGITS);
  assert.equal((await db.query<{ legal_name: string }>(`SELECT legal_name FROM parties WHERE id = $1`, [b.party_id]))[0]!.legal_name, "Dana Reyes", "the party's display name follows the confirmed legal name (it was the account's e-mail)");
  const prop = (await db.query<Json>(`SELECT address_line1, city, state, postal_code, property_type, units, estate_type, existing_clean_energy_lien FROM application_properties WHERE application_id = $1 AND is_subject`, [b.app_id]))[0]!;
  assert.deepEqual(prop, { address_line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004", property_type: "sfr", units: 1, estate_type: "fee_simple", existing_clean_energy_lien: false }, "the home card's tap wrote the subject row: the parsed address, the type and units, the two asked facts");
  assert.ok(!(await pendingKeys(b.party_id)).some((k) => k.includes(":gap:")), `no card was re-sent on a zero-gap journey: ${(await pendingKeys(b.party_id)).join(", ")}`);
  const zeroPending = (await pendingKeys(b.party_id)).map((k) => k.split("@")[0]!).sort();   // what a zero-gap journey leaves pending (R2's cards): the yardstick for (2) and (3)
  // the SSN never leaves: no `tin` / `ssn` key and no nine digits on any borrower payload (32.13 T3/T6, 32.3 T12/T19), none on the ops record either (the document's bytes are Fannie Mae-confidential, never listed)
  for (const path of [`/v1/borrower/record?subject=${b.app_id}`, "/v1/borrower/thread?limit=500", "/v1/borrower/me"]) { const p = await api("GET", path, undefined, bearer(b.token)); assert.equal(p.status, 200, path); const keys = keysOf(p.body); for (const k of ["tin", "ssn", "tin_encrypted"]) assert.ok(!keys.has(k), `${path}: no key ${k}`); assert.doesNotMatch(JSON.stringify(p.body), SSN_ANYWHERE, `${path}: the digits never travel`); }
  const ops = await api("GET", `/v1/applications/${b.app_id}`, undefined, bearer(TOKEN)); assert.equal(ops.status, 200, JSON.stringify(ops.body).slice(0, 300)); assert.doesNotMatch(JSON.stringify(ops.body), SSN_ANYWHERE, "the ops record never carries the identifier"); assert.doesNotMatch(JSON.stringify(ops.body), /tin_encrypted|TaxpayerIdentifier/, "the ops record carries the hash and the counts, never the bytes");
  assert.equal(((ops.body["du"] as Json)["documents"] as Json[]).at(-1)!["required_missing"], 0, "the ops record's du.documents row reads zero");
  // 23.7 on the same emission: the document passes preflight (no refusal on the bus), the du_preflight_results row is on the ops record, and DU's own ten-digit casefile id is on the application from the FAKE port's first ack (rule 9) — what the deploy walk's twelfth outcome reads
  assert.equal((await events(b.app_id, "du.preflight.passed")).length, 1, "du.preflight.passed once"); assert.equal((await events(b.app_id, "du.preflight.refused")).length, 0, "no refusal");
  const preflight = (ops.body["du"] as Json)["preflight"] as Json[]; assert.equal(preflight.length, 1, "one preflight run on the record"); assert.equal(preflight[0]!["passed"], true); assert.equal(preflight[0]!["du_document_id"], doc.du_document_id); assert.ok((preflight[0]!["checks"] as Json[]).length >= 1 && (preflight[0]!["checks"] as Json[]).every((c) => c["passed"] === true), "every check passed");
  assert.match(String((ops.body["application"] as Json)["du_casefile_id"] ?? ""), /^\d{10}$/, `applications.du_casefile_id is the FAKE port's ten-digit id: ${String((ops.body["application"] as Json)["du_casefile_id"])}`);
  assert.equal((await events(b.app_id, "du.casefile_id.recorded")).length, 1, "written once, from the first ack");

  // ── (2) a gap the borrower supplies becomes the card: the declarations row gone and the estate unanswered when the assembly runs → the declarations card and the home card re-sent as the current ask
  const g = await signedUpWithGoal("t8g");
  await identity(g); await typeSsn(g); await home(g); await income(g); await assets(g);
  await aboutYouAndSixItems(g, { beforeAmount: async () => {
    const abs = (await borrowerRowsOf(g.app_id)).map((r) => r.id);
    await db.query(`DELETE FROM du_bankruptcy_filings WHERE declaration_id IN (SELECT id FROM du_declarations WHERE application_borrower_id = ANY ($1::uuid[]))`, [abs]);
    await db.query(`DELETE FROM du_declarations WHERE application_borrower_id = ANY ($1::uuid[])`, [abs]);
    await db.query(`UPDATE application_properties SET estate_type = NULL WHERE application_id = $1`, [g.app_id]);
  } });
  const [gapEmission] = await emittedGaps(g.app_id); assert.ok(gapEmission, "du.document.emitted on the DU moment");
  assert.ok(Number(gapEmission.payload["required_missing"]) > 0, "the document reports gaps"); const gapPaths = gapEmission.gaps.map((x) => x.path);
  assert.ok(gapPaths.some((p) => /\/BORROWER\/DECLARATION\//.test(p)), `a section 5 declaration among the gaps: ${gapPaths.join(", ")}`); assert.ok(gapPaths.some((p) => p.endsWith("/PROPERTY_DETAIL/PropertyEstateType")), "the estate type among the gaps");
  assert.ok(!gapPaths.some((p) => /LastName|TAXPAYER_IDENTIFIER|StateCode|AttachmentType|PropertyExistingCleanEnergyLien|RESIDENCES/.test(p)), `nothing else is missing on this journey: ${gapPaths.join(", ")}`);
  const gCards = await cardsOf(g.party_id); const gPending = gCards.filter((c) => c.status === "pending");
  const emission = String(gapEmission.payload["du_document_id"]).replace(/-/g, "").slice(0, 8); const abId = (await borrowerRowsOf(g.app_id))[0]!.id;
  const declRe = gPending.find((c) => c.copy_key === "declarations.occupancy" && c.props["flow_key"] === `declarations.occupancy:${abId}:gap:${emission}`); assert.ok(declRe, `the declarations sequence's first card re-sent under the emission's flow_key (pending: ${gPending.map((c) => `${c.copy_key}@${String(c.props["flow_key"])}`).join(", ")})`);
  assert.equal((declRe.props["declarations_seq"] as Json)["borrower_id"], (gCards.find((c) => c.copy_key === "declarations.occupancy" && c.status === "resolved")!.props["declarations_seq"] as Json)["borrower_id"], "the same borrower's sequence; the tapped card stays resolved");
  const homeRe = gPending.find((c) => c.copy_key === "refi.home.confirm" && c.props["flow_key"] === `refi.home:${abId}:gap:${emission}`); assert.ok(homeRe, "the home card re-sent under the emission's flow_key");
  const homeFields = homeRe.props["fields"] as { path: string; value: string; options?: unknown[] }[]; assert.ok(homeFields.some((f) => f.path === "estate_type" && f.value === "" && Array.isArray(f.options)), "the estate asked (a select, unanswered)"); assert.ok(homeFields.some((f) => f.path === "existing_clean_energy_lien" && f.value === "no"), "the lien answer the row still holds, shown");
  assert.deepEqual(homeRe.props["required_paths"], ["property_address", "estate_type", "existing_clean_energy_lien"]); assert.equal(homeRe.props["helper_copy_key"], "refi.home.why");
  // the current ask on the rail is the newest pending card (01 §1.3): one of the two re-sent; nothing else pending was raised by the emission
  const newest = gPending.at(-1)!;   // cardsOf orders by created_at then seq — the FixedClock stamps every card alike, so seq is the order the read model pins by (01 §1.3)
  assert.ok([declRe.card_instance_id, homeRe.card_instance_id].includes(newest.card_instance_id), `the current ask is a re-sent card: ${newest.copy_key}`);
  assert.deepEqual(gPending.filter((c) => c !== declRe && c !== homeRe).map((c) => c.copy_key).sort(), zeroPending, `two cards re-sent, no other: ${gPending.map((c) => c.copy_key).join(", ")}`);
  // Michelle's line beside the card is the copy library's, once, and no thread line or card prop names what runs behind it
  const thread = await api("GET", "/v1/borrower/thread?limit=500", undefined, bearer(g.token)); assert.equal(thread.status, 200);
  const lines = (thread.body["messages"] as Json[]).filter((m) => m["sender"] !== "borrower");
  // the line is flow-authored (`agent:intake`, a copy key): on a model-owned thread (32.16 §2.0, this harness) the read model hides it and the turn explains the card in its own words — the row is the evidence
  const resendLines = await db.query<{ card_instance_id: string | null }>(`SELECT card_instance_id FROM messages WHERE subject_application_id = $1 AND body_text = '{{copy:application.gap.resend}}'`, [g.app_id]);
  assert.equal(resendLines.length, 1, "the re-send line once per party and emission"); assert.equal(resendLines[0]!.card_instance_id, declRe.card_instance_id, "beside the first re-sent card");
  for (const m of lines) assert.doesNotMatch(String(m["body_text"] ?? ""), DU_INTERNALS, `thread line: ${String(m["body_text"])}`);
  for (const c of [declRe, homeRe]) assert.doesNotMatch(JSON.stringify(c.props), DU_INTERNALS, `${c.copy_key} props`);
  assert.doesNotMatch(JSON.stringify(thread.body), /required_missing|du_document|gaps|xpath/i, "no emission fact on the thread payload");
  const copyMd = readFileSync(fileURLToPath(new URL("../../../spec/sections/32-borrower-experience/copy-library.md", import.meta.url)), "utf8").split("\n");
  for (const key of ["application.gap.resend", "refi.home.why", "refi.home.estate", "refi.home.clean_energy_lien", "refi.home.confirm", "declarations.occupancy", "identity.confirm.title"]) { const line = copyMd.find((l) => l.startsWith(`- \`${key}\``)); assert.ok(line, `${key} in the copy library`); const text = /— "([^"]*)"/.exec(line)?.[1] ?? ""; assert.doesNotMatch(text, DU_INTERNALS, `${key}: ${text}`); }
  // the card resolves in the copy library's words: the home card's tap writes the estate — and its resolution re-runs the assembly (rule 7: underwriting.run{reassemble} over the graph as it now stands, 23.7's preflight on the emission), so the estate gap closes; the declaration gap stays until its own card resolves
  await tap(g, homeRe, fieldsEvidence(homeRe, { estate_type: "leasehold" }));
  assert.equal((await db.query<{ e: string }>(`SELECT estate_type AS e FROM application_properties WHERE application_id = $1 AND is_subject`, [g.app_id]))[0]!.e, "leasehold");
  assert.equal((await cardRow(homeRe.card_instance_id)).status, "resolved"); assert.ok(!(await pendingKeys(g.party_id)).some((k) => k.startsWith("refi.home.confirm@")), "no second home card while the first re-send stood");
  const afterHome = await emittedGaps(g.app_id); assert.equal(afterHome.length, 2, "the home card's resolution re-ran the assembly: a second du.document.emitted");
  assert.ok(!afterHome[1]!.gaps.some((x) => x.path.endsWith("/PROPERTY_DETAIL/PropertyEstateType")), `the estate gap closed: ${afterHome[1]!.gaps.map((x) => x.path).join(", ")}`); assert.ok(afterHome[1]!.gaps.some((x) => /\/BORROWER\/DECLARATION\//.test(x.path)), "the declaration gap stays until its card resolves");
  assert.equal((await pendingKeys(g.party_id)).filter((k) => k.startsWith("declarations.occupancy@")).length, 1, "the open declarations sequence is the current ask still — not re-sent under the second emission");
  assert.equal((await entitiesOf("du_casefiles", g.app_id)).length, 1, "one casefile: the re-assembly submits nothing (23.1 owns the resubmission)"); assert.equal((await events(g.app_id, "du.submitted")).length, 1);
  // the re-sent declarations sequence under the emission's key: 5a.A, 5a.E, None — the last tap asserts the fourteen answers and re-runs the assembly once more: no gap left
  const occRe = declRe; await tap(g, occRe, { option_id: "yes_no_prior", evidence: { option_id: "yes_no_prior", tapped_at: clock.now() } });
  const lienRe = await pending(g, "declarations.clean_energy_lien"); assert.equal(lienRe.props["flow_key"], `declarations.clean_energy_lien:${abId}:gap:${emission}`); await tap(g, lienRe, { option_id: "no", evidence: { option_id: "no", tapped_at: clock.now() } });
  assert.equal((await emittedGaps(g.app_id)).length, 2, "a card of the sequence before the last runs nothing and re-assembles nothing");
  const listRe = await pending(g, "declarations.title"); assert.equal(listRe.props["flow_key"], `declarations.list:${abId}:gap:${emission}`); await tap(g, listRe, { option_id: "none", evidence: { option_id: "none", tapped_at: clock.now() } });
  assert.equal((await db.query(`SELECT 1 FROM du_declarations WHERE application_borrower_id = $1`, [abId])).length, 1, "the borrower's du_declarations row is back, asserted by the tap");
  const closed = await emittedGaps(g.app_id); assert.equal(closed.length, 3, "the last tap re-ran the assembly"); assert.equal(Number(closed[2]!.payload["required_missing"]), 0, `the gap closed: ${closed[2]!.gaps.map((x) => x.path).join(", ")}`); assert.deepEqual(closed[2]!.gaps, []);
  assert.equal((await events(g.app_id, "du.preflight.passed")).length, 3, "23.7's preflight ran on every emission"); assert.equal((await events(g.app_id, "du.preflight.refused")).length, 0);
  assert.deepEqual((await pendingKeys(g.party_id)).map((k) => k.split("@")[0]!).sort(), zeroPending, "nothing re-sent on a zero-gap emission: the rail as a zero-gap journey leaves it");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM du_documents WHERE application_id = $1`, [g.app_id]))[0]!.n, "3", "three du_documents rows: the DU moment's and the two re-assemblies");

  // ── (2b) the other two gaps the borrower supplies: the current residence with its basis (E5's address card, re-sent with the residence asks) and the existing clean-energy lien answer (the home card)
  const r = await signedUpWithGoal("t8r");
  await identity(r); await typeSsn(r); await home(r); await income(r); await assets(r);
  await aboutYouAndSixItems(r, { beforeAmount: async () => {
    const abs = (await borrowerRowsOf(r.app_id)).map((x) => x.id);
    await db.query(`DELETE FROM du_residences WHERE application_borrower_id = ANY ($1::uuid[])`, [abs]);
    await db.query(`UPDATE application_properties SET existing_clean_energy_lien = NULL WHERE application_id = $1`, [r.app_id]);
  } });
  const [rEmission] = await emittedGaps(r.app_id); assert.ok(rEmission, "du.document.emitted on the DU moment"); const rPaths = rEmission.gaps.map((x) => x.path);
  assert.ok(rPaths.some((x) => /\/BORROWER\/RESIDENCES\//.test(x)), `the current residence among the gaps: ${rPaths.join(", ")}`); assert.ok(rPaths.some((x) => x.endsWith("/PROPERTY_DETAIL/PropertyExistingCleanEnergyLienIndicator")), `the lien answer among the gaps: ${rPaths.join(", ")}`);
  assert.ok(!rPaths.some((x) => /DECLARATION|LastName|TAXPAYER_IDENTIFIER|SUBJECT_PROPERTY\/ADDRESS\/StateCode|AttachmentType|PropertyEstateType/.test(x)), `nothing else is missing on this journey: ${rPaths.join(", ")}`);
  const rAb = (await borrowerRowsOf(r.app_id))[0]!.id; const rEm = String(rEmission.payload["du_document_id"]).replace(/-/g, "").slice(0, 8); const rPending = (await cardsOf(r.party_id)).filter((c) => c.status === "pending");
  const resRe = rPending.find((c) => c.copy_key === "identity.confirm.title" && c.props["flow_key"] === `identity.confirm:${rAb}:gap:${rEm}`); assert.ok(resRe, `the address confirm card re-sent with the residence asks (pending: ${rPending.map((c) => `${c.copy_key}@${String(c.props["flow_key"])}`).join(", ")})`);
  const resFields = resRe.props["fields"] as { path: string; value: string; source: string }[]; assert.deepEqual(resFields.map((f) => f.path), ["legal_name", "date_of_birth", "current_address", "residency_basis", "monthly_rent_cents", "months_at_address"]); assert.equal(resFields.find((f) => f.path === "current_address")!.value, ADDRESS, "the confirmed address, shown");
  assert.deepEqual(resRe.props["required_paths"], ["current_address", "residency_basis", "months_at_address"]); assert.equal(resRe.props["helper_copy_key"], "identity.residence.why"); assert.equal((resRe.props["command_args"] as Json)["path"], "identity");
  const homeR = rPending.find((c) => c.copy_key === "refi.home.confirm" && c.props["flow_key"] === `refi.home:${rAb}:gap:${rEm}`); assert.ok(homeR, "the home card re-sent for the lien answer");
  const homeRFields = homeR.props["fields"] as { path: string; value: string }[]; assert.equal(homeRFields.find((f) => f.path === "existing_clean_energy_lien")!.value, "", "the lien asked, unanswered"); assert.equal(homeRFields.find((f) => f.path === "estate_type")!.value, "fee_simple", "the estate the row still holds, shown");
  assert.deepEqual(rPending.filter((c) => c !== resRe && c !== homeR).map((c) => c.copy_key).sort(), zeroPending, "two cards re-sent, no other");
  for (const c of [resRe, homeR]) assert.doesNotMatch(JSON.stringify(c.props), DU_INTERNALS, `${c.copy_key} props`);
  // the residence card's tap: Rent at $1,800.00, 72 months → the Current du_residences row through 23.5 writeResidence in the confirm's own transaction — and the assembly re-runs, the residence gap closing, the lien gap standing (its card still pending, not re-sent)
  const resTap = await tap(r, resRe, fieldsEvidence(resRe, { residency_basis: "rent", monthly_rent_cents: "180000", months_at_address: "72" })); assert.ok((resTap.body["events"] as string[]).includes("du.graph.residence.written"));
  assert.deepEqual(await db.query<{ residency_type: string; residency_basis: string; monthly_rent_cents: string; duration_months: number }>(`SELECT residency_type, residency_basis, monthly_rent_cents::text AS monthly_rent_cents, duration_months FROM du_residences WHERE application_borrower_id = $1`, [rAb]), [{ residency_type: "Current", residency_basis: "Rent", monthly_rent_cents: "180000", duration_months: 72 }]);
  const afterRes = await emittedGaps(r.app_id); assert.equal(afterRes.length, 2, "the residence card's resolution re-ran the assembly"); assert.ok(!afterRes[1]!.gaps.some((x) => /RESIDENCES/.test(x.path)), "the residence gap closed"); assert.ok(afterRes[1]!.gaps.some((x) => x.path.endsWith("PropertyExistingCleanEnergyLienIndicator")), "the lien gap stands");
  assert.equal((await pendingKeys(r.party_id)).filter((k) => k.startsWith("refi.home.confirm@")).length, 1, "the pending home card is the ask still — not re-sent under the second emission");
  await tap(r, homeR, fieldsEvidence(homeR, { existing_clean_energy_lien: "yes" }));
  assert.equal((await db.query<{ l: boolean }>(`SELECT existing_clean_energy_lien AS l FROM application_properties WHERE application_id = $1 AND is_subject`, [r.app_id]))[0]!.l, true);
  const rClosed = await emittedGaps(r.app_id); assert.equal(rClosed.length, 3); assert.equal(Number(rClosed[2]!.payload["required_missing"]), 0, `the gaps closed: ${rClosed[2]!.gaps.map((x) => x.path).join(", ")}`);
  assert.ok((await readDuDocument(db, { application_id: r.app_id }))!.xml.includes("<PropertyExistingCleanEnergyLienIndicator>true</PropertyExistingCleanEnergyLienIndicator>"), "the newest document carries the answer as tapped");

  // ── (2c) 23.7's du.preflight.refused{code, xpath, rule} maps the same way (23.7 Open question 1: a refusal at a borrower point goes to the rail directly): a refusal naming a
  // section 5 point re-sends the declarations sequence under that emission's key; one naming a platform point (an ASSET) is logged and never asked. The FAKE port's documents pass
  // preflight (part 1), so the refusal is delivered to the flow's reaction as 23.7 would append it — flows/18-du-gaps.ts reacts to the event type, not to who emitted it.
  const flows = router.flows as unknown as { deps: FlowDeps; within<T>(t: CardTrigger, fn: () => Promise<T>): Promise<T> };
  const refusal = (xpath: string, code: string) => ({ id: randomUUID(), type: "du.preflight.refused", occurredAt: clock.now(), applicationId: r.app_id, aggregate: { kind: "application", id: r.app_id }, actor: { kind: "agent" as const, id: "underwriter" }, sequence: 0, payload: { application_id: r.app_id, du_document_id: randomUUID(), document_id: randomUUID(), passed: false, code, xpath, rule: "23.7 rule 1", detail: "" } });
  const refusedAt = `/MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/ROLES/ROLE/BORROWER/DECLARATION/DECLARATION_DETAIL/BankruptcyIndicator`;
  const refusalEvent = refusal(refusedAt, "DU_PREFLIGHT_ORPHAN"); const platformRefusal = refusal(`/MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET[1]/ASSET_DETAIL/AssetType`, "DU_PREFLIGHT_DUPLICATE_ASSET");
  const platformLogged = flowLog.filter((l) => l.includes("32-18.gap.platform")).length;
  await flows.within({ source: "event", flow: "32.18", triggers: ["du.preflight.refused"] }, () => reactDuGaps(flows.deps, [refusalEvent, platformRefusal])); await settle();
  const refEm = String(refusalEvent.payload["du_document_id"]).replace(/-/g, "").slice(0, 8);
  const refCard = (await cardsOf(r.party_id)).find((c) => c.copy_key === "declarations.occupancy" && c.props["flow_key"] === `declarations.occupancy:${rAb}:gap:${refEm}`); assert.ok(refCard, `the declarations sequence re-sent for the refusal's point (pending: ${(await pendingKeys(r.party_id)).join(", ")})`); assert.equal(refCard.status, "pending");
  assert.equal((await pendingKeys(r.party_id)).filter((k) => k.includes(`:gap:${String(platformRefusal.payload["du_document_id"]).replace(/-/g, "").slice(0, 8)}`)).length, 0, "a refusal at a platform point sends nothing");
  const platformNow = flowLog.slice(platformLogged).filter((l) => l.includes("32-18.gap.platform") && l.includes(r.app_id)); assert.equal(platformNow.length, 1, "the platform point logged once, never asked"); assert.ok(platformNow[0]!.includes("DU_PREFLIGHT_DUPLICATE_ASSET"));
  assert.doesNotMatch(JSON.stringify(refCard.props), DU_INTERNALS, "no DU word on the re-sent card");

  // ── (3) a gap the platform derives never becomes a borrower ask: the last name, the taxpayer identifier, the state and the attachment type missing at assembly → logged, no card
  const p = await signedUpWithGoal("t8p");
  await identity(p); await typeSsn(p); await home(p); await income(p); await assets(p);
  const platformBefore = flowLog.filter((l) => l.includes("32-18.gap.platform")).length;
  await aboutYouAndSixItems(p, { beforeAmount: async () => {
    await db.query(`UPDATE application_borrowers SET legal_name = 'Dana', tin_encrypted = NULL WHERE application_id = $1`, [p.app_id]);
    await db.query(`UPDATE application_properties SET state = NULL, property_type = NULL WHERE application_id = $1`, [p.app_id]);
  } });
  const [platformEmission] = await emittedGaps(p.app_id); assert.ok(platformEmission, "du.document.emitted on the DU moment");
  const platformPaths = platformEmission.gaps.map((x) => x.path);
  for (const point of ["INDIVIDUAL/NAME/LastName", "TAXPAYER_IDENTIFIER/TaxpayerIdentifierType", "TAXPAYER_IDENTIFIER/TaxpayerIdentifierValue", "SUBJECT_PROPERTY/ADDRESS/StateCode", "PROPERTY_DETAIL/AttachmentType"]) assert.ok(platformPaths.some((x) => x.endsWith(point)), `${point} among the gaps: ${platformPaths.join(", ")}`);
  assert.ok(!platformPaths.some((x) => /DECLARATION|RESIDENCES|PropertyEstateType|PropertyExistingCleanEnergyLien/.test(x)), `only the platform's points are missing: ${platformPaths.join(", ")}`);
  assert.ok(!(await pendingKeys(p.party_id)).some((k) => k.includes(":gap:")), `no card re-sent for a platform gap: ${(await pendingKeys(p.party_id)).join(", ")}`);
  assert.deepEqual((await pendingKeys(p.party_id)).map((k) => k.split("@")[0]!).sort(), zeroPending, "the rail as a zero-gap journey leaves it: nothing asked");
  const platformLines = flowLog.slice(platformBefore).filter((l) => l.includes("32-18.gap.platform") && l.includes(p.app_id)); assert.equal(platformLines.length, platformPaths.length, `every platform gap logged, none asked: ${platformLines.length} of ${platformPaths.length}`);
  for (const l of platformLines) assert.doesNotMatch(l, SSN_ANYWHERE, "the log names the path, never a value");
  const pThread = await api("GET", "/v1/borrower/thread?limit=500", undefined, bearer(p.token)); assert.equal(pThread.status, 200);
  assert.ok(!(pThread.body["messages"] as Json[]).some((m) => m["body_text"] === "{{copy:application.gap.resend}}"), "no re-send line for a platform gap");
  assert.equal((await db.query(`SELECT 1 FROM messages WHERE subject_application_id = $1 AND body_text = '{{copy:application.gap.resend}}'`, [p.app_id])).length, 0, "no re-send line written for a platform gap");
});
test("32.18 DELTA-37 (the cash-out purpose): Given the refinance persona on a `cash_out` file, then `refi.loan_amount.confirm` asks what the cash is for — a `cash_out_purpose` field whose options are the four MISMO ids 21.1 admits, a required path — so a bare tap is refused 409 CARD_FIELD_REQUIRED with a copy key, the tap that names it writes 21.1's record (`applications.cash_out_purpose`, `application.field.captured{value}`) and the DU moment's document carries LOAN/REFINANCE/RefinancePrimaryPurposeType with required_missing = 0; given a limited cash-out, then the card has no such field; given the purpose gone from the record and a refusal at that XPath, then rule 7 re-sends the amount card (`refi.loan_amount:<ab>:gap:<emission>`) asking it, its tap re-runs the assembly and the gap closes.", async () => {
  // ── a limited cash-out asks no purpose (T8's journey): the card has the one field
  const lco = await toDu("t8lco");
  const lcoAmount = (await cardsOf(lco.party_id)).find((c) => c.copy_key === "refi.loan_amount.confirm")!; assert.deepEqual((lcoAmount.props["fields"] as Json[]).map((f) => f["path"]), ["loan_amount_sought"]); assert.deepEqual(lcoAmount.props["required_paths"], ["loan_amount_sought"]);
  assert.equal(Number((await emittedGaps(lco.app_id))[0]!.payload["required_missing"]), 0);
  // ── the cash-out: the card asks the purpose; a bare tap is refused; the naming tap writes the record and the document
  const b = await signedUpWithGoal("t8cash", "Dana Reyes", "cash_out");
  assert.equal((await db.query<{ t: string }>(`SELECT transaction_type::text AS t FROM applications WHERE id = $1`, [b.app_id]))[0]!.t, "cash_out");
  await identity(b); await typeSsn(b); await home(b); await income(b); await assets(b);
  let bare: Reply | null = null; let card: CardRow | null = null;
  await aboutYouAndSixItems(b, { amountEdits: { cash_out_purpose: "DebtConsolidation" }, beforeAmount: async () => {
    card = await pending(b, "refi.loan_amount.confirm");
    const fields = card.props["fields"] as { path: string; label: string; value: string; source: string; options?: { id: string; label: string }[] }[];
    assert.deepEqual(fields.map((f) => f.path), ["loan_amount_sought", "cash_out_purpose"], "the amount, then what the cash is for");
    const purpose = fields[1]!; assert.equal(purpose.value, "", "asked, not defaulted"); assert.equal(purpose.source, "borrower"); assert.equal(purpose.label, "What the cash is for");
    assert.deepEqual(purpose.options, [{ id: "DebtConsolidation", label: "Pay off other debts" }, { id: "HomeImprovement", label: "Improve the home" }, { id: "Education", label: "Pay for school" }, { id: "Cash", label: "Other / keep the cash" }], "the MISMO ids in the copy library's words (apply.property.cash_out_purpose)");
    assert.deepEqual(card.props["required_paths"], ["loan_amount_sought", "cash_out_purpose"]); assert.deepEqual(card.props["money_paths"], ["loan_amount_sought"]);
    assert.doesNotMatch(JSON.stringify(card.props), DU_INTERNALS, "no DU word on the card");
    bare = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, fieldsEvidence(card, { loan_amount_sought: "56000000" }), bearer(b.token)); await settle();
    assert.equal(bare.status, 409, JSON.stringify(bare.body)); assert.equal(bare.body["code"], "CARD_FIELD_REQUIRED"); assert.equal(bare.body["copy_key"], "thread.card_field_required");
    assert.equal((await cardRow(card.card_instance_id)).status, "pending", "nothing written without the purpose"); assert.equal((await events(b.app_id, "application.trid_received")).length, 0, "the sixth item did not count");
    const outside = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, fieldsEvidence(card, { loan_amount_sought: "56000000", cash_out_purpose: "pay off debts" }), bearer(b.token)); await settle();
    assert.ok(outside.status >= 400, `a spelling outside ULAD_ENUMS.cash_out_purpose is refused: ${JSON.stringify(outside.body).slice(0, 200)}`); assert.equal((await cardRow(card.card_instance_id)).status, "pending");
  } });
  assert.ok(bare, "the bare tap ran");
  const intake = (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'applications' AND id = $1`, [b.app_id])).map((r) => decodeEntityData(r.data))[0]!;
  assert.equal(intake["cash_out_purpose"], "DebtConsolidation", "21.1's record keeps the purpose"); assert.equal(intake["transaction_type"], "cash_out");
  const captured = (await events(b.app_id, "application.field.captured")).filter((e) => e.payload["field"] === "cash_out_purpose"); assert.equal(captured.length, 1); assert.equal(captured[0]!.payload["value"], "DebtConsolidation");
  assert.equal(((await cardRow(card!.card_instance_id)).evidence!["fields"] as Json[]).find((f) => f["path"] === "cash_out_purpose")?.["value_confirmed"], "DebtConsolidation", "the card's evidence carries it");
  const [emitted, ...more] = await emittedGaps(b.app_id); assert.ok(emitted, "the DU moment ran on the sixth item"); assert.equal(more.length, 0);
  assert.equal(Number(emitted.payload["required_missing"]), 0, `no gap: ${JSON.stringify(emitted.gaps)}`); assert.deepEqual(emitted.gaps, []);
  const doc = await readDuDocument(db, { application_id: b.app_id }); assert.ok(doc); assert.equal(doc.required_missing, 0);
  assert.match(doc.xml, /<RefinanceCashOutDeterminationType>CashOut<\/RefinanceCashOutDeterminationType>\s*<RefinancePrimaryPurposeType>DebtConsolidation<\/RefinancePrimaryPurposeType>/, "the purpose on the document, after the determination");
  assert.equal((await events(b.app_id, "du.preflight.passed")).length, 1); assert.equal((await events(b.app_id, "du.submitted")).length, 1);
  assert.ok(!(await pendingKeys(b.party_id)).some((k) => k.includes(":gap:")), "nothing re-sent on a zero-gap cash-out journey");
  // the purpose never travels as a DU word: the thread's lines and the card (props and evidence) name the field in the copy library's words only (T8's measure)
  const thread = await api("GET", "/v1/borrower/thread?limit=500", undefined, bearer(b.token)); assert.equal(thread.status, 200);
  for (const m of (thread.body["messages"] as Json[])) assert.doesNotMatch(String(m["body_text"] ?? ""), DU_INTERNALS, `thread line: ${String(m["body_text"])}`);
  assert.doesNotMatch(JSON.stringify((await cardRow(card!.card_instance_id)).evidence), DU_INTERNALS, "the card's evidence");
  // ── the gap remains without the purpose: the record without it and a refusal at the XPath (23.7's event, as T8 (3) delivers it) → the amount card re-sent under the emission's key, asking the purpose; its tap re-runs the assembly (rule 7) and the gap closes
  // (entity_records is append-only, entity_current its newest version: a further version without the purpose is the test's seam, as T8 (2) alters the tables between the cards and the run)
  await db.query(`INSERT INTO entity_records (kind, id, version, loan_id, application_id, data, updated_at, updated_by) SELECT kind, id, version + 1, loan_id, application_id, $2::jsonb, updated_at, updated_by FROM entity_records WHERE kind = 'applications' AND id = $1 ORDER BY version DESC LIMIT 1`, [b.app_id, encodeEntityData({ ...intake, cash_out_purpose: null })]);
  const flows = router.flows as unknown as { deps: FlowDeps; within<T>(t: CardTrigger, fn: () => Promise<T>): Promise<T> };
  const refusal = { id: randomUUID(), type: "du.preflight.refused", occurredAt: clock.now(), applicationId: b.app_id, aggregate: { kind: "application", id: b.app_id }, actor: { kind: "agent" as const, id: "underwriter" }, sequence: 0, payload: { application_id: b.app_id, du_document_id: randomUUID(), document_id: randomUUID(), passed: false, code: "DU_PREFLIGHT_ORPHAN", xpath: "/MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/LOANS/LOAN/REFINANCE/RefinancePrimaryPurposeType", rule: "23.7 rule 1", detail: "" } };
  await flows.within({ source: "event", flow: "32.18", triggers: ["du.preflight.refused"] }, () => reactDuGaps(flows.deps, [refusal])); await settle();
  const em = String(refusal.payload["du_document_id"]).replace(/-/g, "").slice(0, 8); const ab = (await borrowerRowsOf(b.app_id))[0]!.id;
  const re = (await cardsOf(b.party_id)).find((c) => c.copy_key === "refi.loan_amount.confirm" && c.props["flow_key"] === `refi.loan_amount:${ab}:gap:${em}`); assert.ok(re, `the amount card re-sent under the emission's key (pending: ${(await pendingKeys(b.party_id)).join(", ")})`); assert.equal(re.status, "pending");
  const reFields = re.props["fields"] as { path: string; value: string }[]; assert.equal(reFields.find((f) => f.path === "cash_out_purpose")?.value, "", "the purpose asked again (the record has none)"); assert.equal(reFields.find((f) => f.path === "loan_amount_sought")?.value, "56000000", "the amount it carries is the record's");
  assert.deepEqual(re.props["required_paths"], ["loan_amount_sought", "cash_out_purpose"]);
  assert.equal((await db.query<{ card_instance_id: string | null }>(`SELECT card_instance_id FROM messages WHERE subject_application_id = $1 AND body_text = '{{copy:application.gap.resend}}'`, [b.app_id])).length, 1, "the copy library's re-send line beside it");
  await flows.within({ source: "event", flow: "32.18", triggers: ["du.preflight.refused"] }, () => reactDuGaps(flows.deps, [refusal])); await settle();
  assert.equal((await cardsOf(b.party_id)).filter((c) => c.copy_key === "refi.loan_amount.confirm" && c.status === "pending").length, 1, "one card per ask (a replayed delivery re-sends nothing)");
  await tap(b, re, fieldsEvidence(re, { cash_out_purpose: "HomeImprovement" }));
  const closed = await emittedGaps(b.app_id); assert.equal(closed.length, 2, "the re-sent card's tap re-ran the assembly"); assert.equal(Number(closed[1]!.payload["required_missing"]), 0, `the gap closed: ${closed[1]!.gaps.map((x) => x.path).join(", ")}`);
  const doc2 = await readDuDocument(db, { application_id: b.app_id }); assert.ok(doc2 && doc2.du_document_id !== doc.du_document_id, "a second du_documents row"); assert.ok(doc2.xml.includes("<RefinancePrimaryPurposeType>HomeImprovement</RefinancePrimaryPurposeType>"), "the answer given on the re-sent card");
  assert.equal((await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'applications' AND id = $1`, [b.app_id])).map((r) => decodeEntityData(r.data))[0]!["cash_out_purpose"], "HomeImprovement");
  assert.equal((await entitiesOf("du_casefiles", b.app_id)).length, 1, "one casefile: the re-assembly submits nothing (23.1 owns the resubmission)"); assert.equal((await events(b.app_id, "du.submitted")).length, 1);
});
