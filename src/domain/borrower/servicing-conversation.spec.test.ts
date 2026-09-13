// The servicing conversation (32.16 Stage 4; docs/ux/17 §1 principles 2–8, §2.3, §3.3 `card.request` / `explain`, §4 "Servicing (08–12)"):
// a servicing borrower handles their loan BY TALKING, with a card only when money moves or a consent is needed. A scripted Messages
// API client plays the assistant (the real AnthropicLlm loop, the real 32.16 bus tools, the real guard — no FakeLlm) and the test
// plays the borrower over the real runtime on its own database: the journey fixture's loan boarded from origination (as 32.8 does),
// the borrower's account created at the door with the e-mail on file (docs/ux/17 §2.0: a code first, then the session lands in
// their thread). Every card the model raises is the owning flow's own card (flows/8-servicing-payments.ts builders, 32.9's payoff
// choice, 32.7's e-delivery consent); money and consents never resolve from the turn — the bus refuses the direct attempt, the card
// appears, the tap resolves it. Skips without Postgres (not a spec unit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST } from "../../runtime/borrower/fixtures/journey.ts";
import { sendPeriodicStatement } from "../../runtime/servicing.ts";
import { esignVerificationToken } from "../../app/tools/section32-2.ts";
import { copyTemplates } from "../../runtime/borrower/channels.ts";
import { verbatimTemplate, provenanceViolation } from "../../runtime/borrower/agent/guard.ts";
import { CARD_REQUESTS, SERVICING_EXPLAIN_TOPICS, EXPLAIN_TOPICS, MODEL_TOOLS_32_16, COMMAND_RUN_ALLOWLIST, requestArgs } from "../../app/tools/section32-16.ts";
import { cardCaseOf } from "../../runtime/borrower/flows/13-cross-cutting.ts";
import { EXTRA_PRINCIPAL, SERVICING_ESIGN_SCOPES } from "../../runtime/borrower/flows/8-servicing-payments.ts";
import { servicingView, historyView, usd } from "../../runtime/borrower/agent/servicing-context.ts";
import type { BorrowerRecord } from "../../runtime/borrower/record.ts";

const DB_URL = process.env["SERVICING_CONVERSATION_TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_servicing_conversation_test";
const ADMIN_URL = ((): string => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })();   // the suite creates its own database in `before`: the probe is the server's admin database
const up = await reachable(ADMIN_URL);
const skip = up ? false : `no Postgres at ${ADMIN_URL}`;
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
type Json = Record<string, unknown>;
const PASSWORD = `correct-horse-${randomUUID().slice(0, 8)}`;
const ACCOUNT = { last4: "9876", type: "checking", routing: "021000021" };

// ---------------------------------------------------------------- the scripted Messages API client (docs/ux/17 §8 Phase 1: the real AnthropicLlm loop over a client with the API's shape)
type Call = { name: string; input: Json };
type SceneCtx = { situation: Json; borrower: string; toolResults: Json[] };
/** A scene answers a borrower line: the tool calls first (one response), then the sentence on their results; `then` answers the guard's one regeneration. */
type Scene = { when: RegExp; calls?: Call[] | ((c: SceneCtx) => Call[]); text: string | ((c: SceneCtx) => string); then?: string };
const FIRST_TURN: Scene = { when: /just created their account/, text: "Welcome back, {{party.first_name}}. Your loan is right here — ask me anything about it." };
const RETURNING: Scene = { when: /the borrower is back/, text: "Welcome back, {{party.first_name}}. Ask me anything about your loan." };
function scriptedClient() {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = []; const toolResults: Json[] = []; let scenes: Scene[] = [FIRST_TURN, RETURNING];
  let scene: Scene | undefined; let ctx: SceneCtx = { situation: {}, borrower: "", toolResults: [] };
  const message = (content: Anthropic.ContentBlock[], stop: "end_turn" | "tool_use"): Anthropic.Message =>
    ({ id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: "scripted", content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null } } as unknown as Anthropic.Message);
  const text = (t: string) => message([{ type: "text", text: t, citations: null }], "end_turn");
  const create = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    requests.push(params);
    const last = params.messages.at(-1)!;
    if (Array.isArray(last.content) && last.content.every((b) => (b as { type: string }).type === "tool_result")) {
      const results = (last.content as Anthropic.ToolResultBlockParam[]).map((r) => { try { return JSON.parse(String(r.content)) as Json; } catch { return { raw: r.content } as Json; } });
      toolResults.push(...results); ctx = { ...ctx, toolResults: [...ctx.toolResults, ...results] };
      const t = scene?.text; return text(typeof t === "function" ? t(ctx) : (t ?? "Okay."));
    }
    const content = typeof last.content === "string" ? last.content : "";
    if (content.startsWith("[guard]")) return text(scene?.then ?? "Let me put that another way: the next thing is on the rail.");
    const sit = /\[situation\]\n([\s\S]*?)\n\n\[borrower\]\n/.exec(content); const borrower = content.split("[borrower]\n")[1] ?? "";
    ctx = { situation: sit ? (JSON.parse(sit[1]!) as Json) : {}, borrower, toolResults: [] };
    scene = scenes.find((x) => x.when.test(borrower));
    if (!scene) return text("Okay — what would you like to do next?");
    const calls = typeof scene.calls === "function" ? scene.calls(ctx) : scene.calls;
    if (!calls?.length) { const t = scene.text; return text(typeof t === "function" ? t(ctx) : t); }
    return message(calls.map((c, i) => ({ type: "tool_use", id: `toolu_${i}_${randomUUID().slice(0, 6)}`, name: c.name, input: c.input }) as unknown as Anthropic.ContentBlock), "tool_use");
  };
  return { client: { messages: { create } } as unknown as Anthropic, requests, toolResults, use(next: Scene[]): void { scenes = [FIRST_TURN, RETURNING, ...next]; } };
}
const scripted = scriptedClient();

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";
/** The servicing borrower: the journey's Alex, the boarded loan, the account's session token. */
const S: { j?: Journey; A: string; B: string; partyA: string; loanId: string; appId: string; token: string; conversation_id: string; enrollmentId: string; consentId: string; extraCardId: string; extraPaymentId: string; quoteId: string; statementCardId: string } = { A: "", B: "", partyA: "", loanId: "", appId: "", token: "", conversation_id: "", enrollmentId: "", consentId: "", extraCardId: "", extraPaymentId: "", quoteId: "", statementCardId: "" };
const js = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
/** Every figure the record, the cards or the engines stated to the borrower: the only digits an assistant line may carry (filled tokens). */
const knownFigures = new Set<string>();

test.before(async () => {
  if (skip) return;
  const name = new URL(DB_URL).pathname.slice(1); const admin = new URL(DB_URL); admin.pathname = "/postgres";
  const a = connect(admin.toString()); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`]))[0]!.id;
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|agent|error|unhandled|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret", llm: { client: scripted.client, model: "scripted" } });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) { await settle(); await close(); } });

// ---------------------------------------------------------------- helpers over the borrower API, the flows and the tables
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, token?: string, ip = "10.44.0.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
/** The flows' reactions and the agent's queued turns have run. */
const settle = async () => { await router.flows!.settle(); await router.agent?.settle(); await router.flows!.settle(); };
const tick = async (now: string) => { clock.set(now); await router.flows!.tick(now); await settle(); };
/** An OTP sign-in (the journey's parties; a fresh L1 code on that session). */
async function otpSignIn(email: string): Promise<{ token: string; party_id: string }> {
  await settle();   // never open a session while a reaction is still running (32.16 T28): the disclosure is the session's first row
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email });
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body)); await settle();
  return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id };
}
/** 01 §5 / docs/ux/17 §2.0 step-up: a code on the live account session (the same token) — what every money command and consent tap needs within ten minutes. */
async function freshCode(): Promise<void> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: S.A }, S.token); assert.equal(req.status, 200, JSON.stringify(req.body));
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, S.token); assert.equal(ver.status, 200, JSON.stringify(ver.body));
  assert.equal(ver.body["token"], S.token, "the same session, refreshed"); assert.equal((ver.body["session"] as Json)["fresh_l1"], true);
}
/** A new day: the borrower signs in again at the account door (e-mail + password; an idle password session has expired) — the same party, a new session, the disclosure row and the model's greeting first. */
async function signInAgain(at: string): Promise<void> {
  clock.set(at);
  const r = await api("POST", "/v1/borrower/auth/account", { action: "sign_in", email: S.A, password: PASSWORD }); assert.equal(r.status, 200, JSON.stringify(r.body));
  S.token = r.body["token"] as string; assert.equal((r.body["party"] as Json)["party_id"], S.partyA); await settle();
}
/** The borrower says something on the loan; the reply as the API answered it, after the flows and the turn settled. */
async function say(text: string): Promise<Reply & { reply: Json }> { const r = await api("POST", "/v1/borrower/messages", { text, subject: { loan_id: S.loanId } }, S.token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 500)); await settle(); return { ...r, reply: (r.body["reply"] as Json) ?? {} }; }
const resolve = (cardId: string, body: Json) => api("POST", `/v1/borrower/cards/${cardId}/resolve`, body, S.token);
const record = async (): Promise<BorrowerRecord> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${S.loanId}`, undefined, S.token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400)); return r.body as unknown as BorrowerRecord; };
const thread = async (): Promise<Json[]> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, S.token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return r.body["messages"] as Json[]; };
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Json; evidence: Json | null; command_ref: string | null; created_at: string; subject_loan_id: string | null }
const cards = async (): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Json>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at, subject_loan_id FROM card_instances WHERE party_id = $1 ORDER BY created_at, card_instance_id`, [S.partyA]); };
const card = async (id: string): Promise<CardRow> => (await cards()).find((c) => c.card_instance_id === id)!;
const events = (type: string) => db.query<{ sequence: string; type: string; payload: Json; occurred_at: string }>(`SELECT sequence::text AS sequence, type, payload, occurred_at FROM loan_events WHERE loan_id = $1 AND type = $2 ORDER BY sequence`, [S.loanId, type]);
type TurnRow = { turn_id: string; message_id: string | null; reply_message_id: string | null; tool_calls: Json[]; safe_classification: string | null; guard_result: Json; model_version: string; prompt_version: string; context_hash: string };
const turns = () => db.query<TurnRow>(`SELECT turn_id, message_id, reply_message_id, tool_calls, safe_classification, guard_result, model_version, prompt_version, context_hash FROM agent_turns WHERE party_id = $1 ORDER BY created_at, turn_id`, [S.partyA]);
const turnOf = async (reply: Json): Promise<TurnRow> => { const id = (reply["copy_tokens"] as Json | null)?.["turn_id"]; const row = (await turns()).find((t) => t.turn_id === id); assert.ok(row, `an agent_turns row for the reply (${JSON.stringify(reply["copy_tokens"])})`); return row; };
const entity = async (kind: string, id: string): Promise<Json | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const principalBalance = async (): Promise<bigint> => BigInt((await db.query<{ s: string | null }>(`SELECT sum(amount_cents)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'principal'`, [S.loanId]))[0]?.s ?? "0");
const refusals = () => db.query<{ payload: Json }>(`SELECT payload FROM loan_events WHERE (loan_id = $1 OR application_id = $2) AND type = 'command.refused' ORDER BY sequence`, [S.loanId, S.appId]);
/** The reply is the model's own accepted sentence: tokens filled, no template, digits only from what a tool stated. */
function assertOwnWords(reply: Json): void {
  const body = String(reply["body_text"]); const tokens = reply["copy_tokens"] as Json | null;
  assert.equal(tokens?.["source"], "agent_turn", `the agent turn answered: ${JSON.stringify(tokens)}`); assert.equal(tokens?.["fallback"], undefined, `not the default copy: ${body}`);
  assert.doesNotMatch(body, /\{\{/, `every token filled: ${body}`); assert.doesNotMatch(body, /^\{\{copy:/);
  assert.equal(verbatimTemplate(body, copyTemplates()), null, `never a copy-library template: ${body}`);
  let bare = body; for (const f of [...knownFigures].sort((a, b) => b.length - a.length)) bare = bare.split(f).join(" ");
  assert.doesNotMatch(bare, /\d/, `a digit a tool did not supply: "${body}" (known: ${[...knownFigures].join(" | ")})`);
}

// ═══════════════════════════════════ the loan and the account door
test("servicing conversation: the boarded loan (the journey through funding and 30.2), then the borrower creates their account with the e-mail on file — a code first, then the session lands in their thread with the loan as its subject and the disclosure as its first row", { skip }, async () => {
  const R = randomUUID().slice(0, 8); S.A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`; S.B = B;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: S.A, coBorrowerEmail: B, partnerPartyId }); S.j = j;
  // the journey runs on the ops bus alone: no borrower session until the loan is serviced, so the thread the account door opens is a servicing thread from its first row (the journey's clock rewinds between phases; a session opened mid-journey would put a flow's card before the disclosure)
  await j.seedBook(); await j.openApplication();
  await j.interview(); await j.quoteAndLe(); await j.recordIntent(); await j.quoteForLock(); await j.requestLock(); await j.executeLockAndCommit(); await j.verifyDecideAndClear(); await j.clearToClose();
  await j.scheduleClosing(); await j.closingDisclosure(); await j.closeAndSign(); await j.fund();
  S.loanId = await j.board(); S.appId = j.appId; await settle();
  assert.equal((await events("loan.boarded")).length, 1, "boarded once");
  // Tue Dec 15, 2026 10:00 MST — the account door (docs/ux/17 §2.0): the e-mail is on file for Alex's party, so a six-digit code proves it before any session
  clock.set(MST("2026-12-15", "10:00"));
  const claim = await api("POST", "/v1/borrower/auth/account", { action: "create", email: S.A, password: PASSWORD });
  assert.equal(claim.status, 200, JSON.stringify(claim.body)); assert.match(String(claim.body["fake_code"]), /^\d{6}$/, "a code to the e-mail on file, no session yet");
  const verified = await api("POST", "/v1/borrower/auth/account", { action: "verify_email", challenge_id: claim.body["challenge_id"], code: claim.body["fake_code"] });
  assert.equal(verified.status, 200, JSON.stringify(verified.body)); await settle();
  S.token = verified.body["token"] as string; S.partyA = String((verified.body["party"] as Json)["party_id"]);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM application_borrowers WHERE application_id = $1 AND party_id = $2`, [S.appId, S.partyA]))[0]!.n, "1", "the account landed in the applicant on file: the e-mail linked the party to the loan's borrower");
  const me = await api("GET", "/v1/borrower/me", undefined, S.token); assert.equal(me.status, 200);
  const subjects = me.body["subjects"] as Json[]; assert.ok(subjects.some((s) => s["loan_id"] === S.loanId && s["stage"] === "servicing"), `the serviced loan is a subject: ${JSON.stringify(subjects)}`);
  assert.equal((me.body["session"] as Json)["fresh_l1"], false, "no code on the password session: money still needs one");
  const t = await thread(); S.conversation_id = String(t[0]!["conversation_id"]);
  const mine = t.filter((m) => m["sender"] !== "borrower");
  assert.equal(mine[0]!["body_text"], "{{copy:entry.disclosure.first}}", "the session's first row is the disclosure record (rendered as the header)");
  const greeting = t.filter((m) => m["sender"] === "agent" && (m["copy_tokens"] as Json | null)?.["source"] === "agent_turn").at(-1)!;
  assert.ok(greeting, "the first turn ran on the account door"); assert.match(String(greeting["body_text"]), /^Welcome back, Alex\./); assertOwnWords(greeting);
  // the figures the record states — the only digits an assistant line may carry from here on
  const rec = await record(); const n = rec.numbers as Json; const next = n["next_payment"] as Json;
  for (const v of [usd(n["upb_cents"]), usd(next["amount_cents"]), usd(next["pi_cents"]), usd(next["escrow_cents"]), usd(n["escrow_balance_cents"]), String(next["due_on"]), `${String(n["note_rate"])}%`, String(n["days_past_due"])]) if (v) knownFigures.add(v);
  assert.ok(knownFigures.has("$4,090.12") && knownFigures.has("2027-01-01"), `the loan's installment and first due date (${[...knownFigures].join(", ")})`);
});

// ═══════════════════════════════════ 1. "what's my balance and when is it due" → explained in words, tokens filled, no card
test("servicing conversation: \"what's my balance and when is it due\" — explain{balance} answers from the record as tokens; the reply is the model's words with the record's figures filled, no card, an agent_turns row", { skip }, async () => {
  const before = (await cards()).length;
  scripted.use([{ when: /what'?s my balance and when is it due/i, calls: (c) => {
    // the situation block itself carries the serviced loan's block as tokens (agent/context.ts merges agent/servicing-context.ts servicingView): the model could answer without a tool; the figures still never reach it
    const rec = c.situation["record"] as Json; const sv = rec["servicing"] as Json; assert.ok(sv, `record.servicing in the situation: ${JSON.stringify(Object.keys(rec))}`);
    assert.equal((sv["next_payment"] as Json)["amount"], "{{numbers.next_payment}}"); assert.equal((sv["next_payment"] as Json)["due_on"], "{{dates.next_payment_due}}"); assert.equal(sv["balance"], "{{numbers.upb}}"); assert.equal((sv["autopay"] as Json)["status"], "none");
    assert.ok((c.situation["tokens_available"] as string[]).includes("dates.next_payment_due")); assert.doesNotMatch(JSON.stringify(sv), /\$\d|\d,\d{3}|\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?%/, `no figure in the situation's servicing block: ${JSON.stringify(sv)}`);
    return [{ name: "explain", input: { topic: "balance" } }];
  }, text: (c) => {
    const r = c.toolResults[0]!; assert.equal(r["outcome"], "explained", JSON.stringify(r)); assert.equal(r["copy_key"], "explain.balance"); assert.equal(r["library_copy_key"], "account.current"); assert.equal(r["tokens"], undefined, "the tokens never reach the model");
    const facts = r["facts"] as Json; assert.equal(facts["balance"], "{{numbers.upb}}"); assert.equal((facts["next_payment"] as Json)["amount"], "{{numbers.next_payment}}"); assert.equal((facts["next_payment"] as Json)["due_on"], "{{dates.next_payment_due}}"); assert.equal((facts["terms"] as Json)["grace_days"], "{{loan.grace_days}}");
    assert.doesNotMatch(JSON.stringify(facts), /\d{3,}/, `no figure in what the model sees: ${JSON.stringify(facts)}`); assert.doesNotMatch(String(r["text"]), /\d/);
    return "Your balance is {{numbers.upb}}. Your next payment of {{numbers.next_payment}} is due {{dates.next_payment_due}}, and there is a {{loan.grace_days}}-day grace period before any late charge.";
  } }]);
  const r = await say("what's my balance and when is it due?");
  const rec = await record(); const n = rec.numbers as Json; const next = n["next_payment"] as Json;
  const grace = (await db.query<{ g: number }>(`SELECT late_charge_grace_days AS g FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [S.loanId]))[0]!.g; knownFigures.add(String(grace));
  assert.equal(r.reply["body_text"], `Your balance is ${usd(n["upb_cents"])}. Your next payment of ${usd(next["amount_cents"])} is due ${String(next["due_on"])}, and there is a ${grace}-day grace period before any late charge.`);
  assertOwnWords(r.reply); assert.equal((r.reply["copy_tokens"] as Json)["explain"], "explain.balance"); assert.equal(r.reply["card_instance_id"], null);
  assert.equal((await cards()).length, before, "a question is talk: no card");
  const row = await turnOf(r.reply); assert.deepEqual(row.tool_calls.map((c) => [c["name"], c["is_error"]]), [["explain", false]]); assert.equal(row.safe_classification, "general_explanation"); assert.equal((row.guard_result as Json)["ok"], true); assert.equal(row.model_version, "scripted"); assert.match(row.context_hash, /^[0-9a-f]{64}$/);
  assert.equal(r.body["routed_to"], "borrower-comms");
});

// ═══════════════════════════════════ 2. "pay 500 extra toward principal" → the extra-principal PaymentCard → the bus refuses a direct attempt → the tap (fresh code) → posted, the ledger balanced
test("servicing conversation: \"pay 500 extra toward principal\" — the model raises the extra-principal PaymentCard (the amount as its editable default); a direct payment.extraPrincipal from the turn is refused by the bus; the tap with a fresh code posts a curtailment with a balanced ledger set behind it", { skip }, async () => {
  assert.ok(EXTRA_PRINCIPAL.test("pay 500 extra toward principal") && !EXTRA_PRINCIPAL.test("I would like to make a payment on my loan."), "32.8's PAY answer stands for a payment; an extra-principal ask reaches the turn");
  scripted.use([
    { when: /pay 500 extra toward principal/i, calls: [{ name: "card_request", input: { kind: "extra_principal", args: { amount_cents: "50000" } } }], text: (c) => { const r = c.toolResults[0]!; assert.equal(r["outcome"], "sent", JSON.stringify(r)); assert.equal(r["card_kind"], "PaymentCard"); assert.equal(r["command_ref"], "payment.extraPrincipal"); assert.equal(r["tokens"], undefined); return "I've put the extra-principal card on the rail with {{request.amount}} as the amount — on a current loan it goes to principal the day it lands. Tap it there with a fresh code and it's done; nothing moves until then."; } },
    { when: /just send it from my checking/i, calls: [{ name: "command_run", input: { name: "payment.extraPrincipal", args: { amount_cents: "50000" } } }], text: (c) => { assert.equal(c.toolResults[0]!["error"], "COMMAND_OUTSIDE_CONTRACT", JSON.stringify(c.toolResults[0])); return "I can't move money from here — the card on the rail is the only way, and it asks for a fresh code first."; } },
  ]);
  const upbBefore = await principalBalance(); const receivedBefore = (await events("payment.received")).length;
  const r = await say("pay 500 extra toward principal");
  assert.notEqual(r.reply["copy_key"], "payment.card_offered", "not 32.8's contractual PaymentCard answer"); knownFigures.add("$500.00");
  assert.equal(r.reply["body_text"], "I've put the extra-principal card on the rail with $500.00 as the amount — on a current loan it goes to principal the day it lands. Tap it there with a fresh code and it's done; nothing moves until then."); assertOwnWords(r.reply);
  const c = await card(String(r.reply["card_instance_id"])); S.extraCardId = c.card_instance_id;
  assert.equal(c.kind, "PaymentCard"); assert.equal(c.copy_key, "payment.extra_principal"); assert.equal(c.command_ref, "payment.extraPrincipal"); assert.equal(c.status, "pending"); assert.equal(c.subject_loan_id, S.loanId);
  assert.equal(c.props["mode"], "extra_principal"); assert.equal(c.props["amount_default_cents"], "50000"); assert.equal(c.props["amount_source"], "borrower_stated_unconfirmed"); assert.equal(c.props["amount_editable"], true); assert.equal(c.props["fresh_l1_required"], true); assert.equal(c.props["applies"], "same_day_principal"); assert.equal(c.props["requested_by"], "card.request"); assert.equal(c.props["flow"], "32.16"); assert.equal(c.props["flow_key"], `request.extra_principal:${S.appId}`);
  assert.deepEqual(c.props["command_args"], { date: "2026-12-15", designation: "curtailment" }); assert.deepEqual(c.props["copy_tokens"], { money: "$500.00", date: "2027-01-01" });
  assert.equal((await events("payment.received")).length, receivedBefore, "nothing moved on words");
  const sent = (await events("card.sent")).find((e) => e.payload["card_instance_id"] === c.card_instance_id)!; assert.equal(sent.payload["trigger"], "card.request"); assert.equal(cardCaseOf("PaymentCard", "card.request"), "document_or_choice", "§2.3: a PaymentCard on the borrower's ask");
  // the direct attempt: refused by the bus before anything ran — command.refused on the record, never executed
  const r2 = await say("no card, just send it from my checking");
  assertOwnWords(r2.reply); const row = await turnOf(r2.reply); assert.deepEqual(row.tool_calls[0]!["refused"], { code: "COMMAND_OUTSIDE_CONTRACT", event: "command.refused" });
  const refused = (await refusals()).map((x) => x.payload).filter((p) => p["attempted"] === "payment.extraPrincipal"); assert.equal(refused.length, 1); assert.equal(refused[0]!["command"], "command.run");
  assert.equal((await events("payment.received")).length, receivedBefore, "never executed");
  // the tap without a fresh code: refused with the fresh-L1 gate (32.8 T2); with one: the curtailment is received, the card resolved
  const gated = await resolve(c.card_instance_id, { option_id: "extra_principal", evidence: { amount_cents: "50000", date: "2026-12-15", account_id: "new", new_account: ACCOUNT, submitted_at: clock.now() }, args: { amount_cents: "50000", date: "2026-12-15", account: ACCOUNT } });
  assert.equal(gated.status, 403, JSON.stringify(gated.body)); assert.equal(gated.body["code"], "FRESH_L1_REQUIRED"); assert.equal((await card(c.card_instance_id)).status, "pending");
  await freshCode();
  const paid = await resolve(c.card_instance_id, { option_id: "extra_principal", evidence: { amount_cents: "50000", date: "2026-12-15", account_id: "new", new_account: ACCOUNT, submitted_at: clock.now() }, args: { amount_cents: "50000", date: "2026-12-15", account: ACCOUNT } });
  assert.equal(paid.status, 201, JSON.stringify(paid.body).slice(0, 500)); assert.equal(paid.body["command"], "payment.extraPrincipal"); await settle();
  const received = (await events("payment.received")).at(-1)!; assert.equal(received.payload["amount_cents"], "50000"); assert.equal(received.payload["designation"], "curtailment"); assert.equal(received.payload["card_instance_id"], c.card_instance_id); assert.equal(received.payload["channel"], "portal");
  S.extraPaymentId = String(received.payload["payment_id"]);
  assert.equal((await card(c.card_instance_id)).status, "resolved");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ui_events WHERE card_instance_id = $1 AND kind = 'card_resolved'`, [c.card_instance_id]))[0]!.n, "1", "the tap is the evidence");
  // Wed Dec 16 00:30 MST: the cashiering sweep posts it through 2.1's allocation engine — a curtailment on a current loan goes to principal; every ledger set balances and every line carries its rule
  await tick(MST("2026-12-16", "00:30"));
  const pay = (await entity("payments", S.extraPaymentId))!; assert.equal(pay["status"], "posted", js(pay));
  assert.equal(pay["allocation_outcome"], "curtailment", "2.4 rule 2: a designated curtailment on a current loan, applied the same day"); assert.equal(pay["suspense_item_id"], undefined, "never held as a partial");
  const sets = await db.query<{ id: string; description: string; total: string; lines: string; unruled: string }>(`SELECT s.id, s.description, sum(l.amount_cents)::text AS total, count(*)::text AS lines, (count(*) FILTER (WHERE l.rule_ref IS NULL OR l.rule_ref = ''))::text AS unruled FROM ledger_entry_sets s JOIN ledger_lines l ON l.set_id = s.id WHERE s.description LIKE $1 GROUP BY s.id, s.description ORDER BY s.description`, [`%${S.extraPaymentId}%`]);
  assert.deepEqual(sets.map((x) => x.description.split(" ")[0]).sort(), ["allocation", "cash", "receipt"], `the receipt, the allocation and the cash split for ${S.extraPaymentId}: ${JSON.stringify(sets)}`);
  for (const s of sets) { assert.equal(s.total, "0", `balanced: ${s.description}`); assert.equal(s.unruled, "0", `every line carries its rule_ref: ${s.description}`); assert.ok(Number(s.lines) >= 2); }
  assert.equal(await principalBalance(), upbBefore - 50_000n, "the principal balance is lower by exactly the curtailment");
  await signInAgain(MST("2026-12-16", "00:35"));   // the overnight idle expired the password session
  const rec = await record(); knownFigures.add(usd((rec.numbers as Json)["upb_cents"])!); assert.equal(String((rec.numbers as Json)["upb_cents"]), (upbBefore - 50_000n).toString(), "the Record reads the ledger");
});

// ═══════════════════════════════════ 3. "set up autopay on the 1st" → the enrollment ConsentCard → the bus refuses a direct autodraft.enroll → tap → the authorization ConsentCard → tap → active
test("servicing conversation: \"set up autopay on the 1st\" — the model raises the enrollment ConsentCard with every Reg E element; a direct autodraft.enroll is refused by the bus; the tap (fresh code, the account on the card) requests the enrollment, 32.8's authorization card follows, and its tap makes autopay active", { skip }, async () => {
  await signInAgain(MST("2026-12-16", "08:00"));
  scripted.use([
    { when: /set up autopay on the 1st/i, calls: [{ name: "card_request", input: { kind: "autopay_enroll", args: { draft_day: 1 } } }], text: (c) => { const r = c.toolResults[0]!; assert.equal(r["outcome"], "sent", JSON.stringify(r)); assert.equal(r["card_kind"], "ConsentCard"); return "The autopay enrollment card is on the rail: it drafts on the {{request.draft_day}} of each month and shows every element of the authorization. Add the account and type your name there — a fresh code is asked — and a copy of the authorization follows."; } },
    { when: /skip the card and turn it on/i, calls: [{ name: "command_run", input: { name: "autodraft.enroll", args: { draft_day: 1 } } }], text: (c) => { assert.equal(c.toolResults[0]!["error"], "COMMAND_OUTSIDE_CONTRACT"); return "Autopay is a consent, so it only turns on from the card — I can't do it from here."; } },
  ]);
  const r = await say("set up autopay on the 1st"); knownFigures.add("1st");
  assert.equal(r.reply["body_text"], "The autopay enrollment card is on the rail: it drafts on the 1st of each month and shows every element of the authorization. Add the account and type your name there — a fresh code is asked — and a copy of the authorization follows."); assertOwnWords(r.reply);
  const c = await card(String(r.reply["card_instance_id"]));
  assert.equal(c.kind, "ConsentCard"); assert.equal(c.copy_key, "autopay.enroll"); assert.equal(c.command_ref, "autodraft.enroll"); assert.equal(c.status, "pending"); assert.equal(c.props["consent_kind"], "autodraft"); assert.equal(c.props["draft_day"], 1); assert.equal(c.props["requires_typed_name"], true); assert.equal(c.props["fresh_l1_required"], true); assert.equal(c.props["optional"], true);
  const elements = c.props["elements"] as Json[]; for (const id of ["borrower", "loan", "amount", "amount_variable", "timing", "first_debit", "company", "revoke", "date", "esign", "optional"]) assert.ok(elements.some((e) => e["id"] === id), `2.x rule 1 element ${id}`);
  assert.equal(elements.find((e) => e["id"] === "timing")!["value"], "monthly on the 1st"); assert.equal(c.props["first_debit_on"], "2027-01-01"); assert.deepEqual(c.props["command_args"], { amount_rule: "contractual", draft_day: 1, include_fees: false, elements_displayed: true });
  assert.equal(cardCaseOf("ConsentCard", "card.request"), "consent");
  const r2 = await say("skip the card and turn it on"); assertOwnWords(r2.reply);
  assert.equal((await refusals()).map((x) => x.payload).filter((p) => p["attempted"] === "autodraft.enroll").length, 1, "refused by the bus before anything ran");
  assert.equal((await events("autodraft.enrollment.requested")).length, 0);
  // the tap: the typed name and the account on the card, a fresh code → autodraft.enroll → the enrollment is requested → 32.8's authorization ConsentCard
  await freshCode();
  const tapped = await resolve(c.card_instance_id, { option_id: "affirm", evidence: { consent_kind: "autodraft", method: "checkbox_with_text", affirmed_at: clock.now(), typed_name: "Alex Borrower" }, args: { account: ACCOUNT } });
  assert.equal(tapped.status, 201, JSON.stringify(tapped.body).slice(0, 500)); assert.equal(tapped.body["command"], "autodraft.enroll"); await settle();
  const requested = (await events("autodraft.enrollment.requested")).at(-1)!; assert.equal(requested.payload["draft_day"], 1); assert.equal(requested.payload["card_instance_id"], c.card_instance_id);
  S.enrollmentId = String(requested.payload["enrollment_id"]); assert.equal((await entity("autodraft_enrollments", S.enrollmentId))!["status"], "requested");
  const auth = (await cards()).find((x) => x.props["flow_key"] === `autodraft.authorize:${S.enrollmentId}`)!; assert.ok(auth, "32.8's ConsentCard{autodraft_authorization} follows"); assert.equal(auth.copy_key, "consent.autodraft.title"); assert.equal(auth.command_ref, "consent.capture"); assert.equal(auth.status, "pending");
  const ok = await resolve(auth.card_instance_id, { option_id: "affirm", evidence: { consent_kind: "autodraft_authorization", disclosure_version_id: "AUTODRAFT-CONFIRM-v1", method: "checkbox_with_text", text_hash: "sha256:autodraft-v1", affirmed_at: clock.now(), typed_name: "Alex Borrower" } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body).slice(0, 500)); await settle();
  const e = (await entity("autodraft_enrollments", S.enrollmentId))!; assert.equal(e["status"], "active"); assert.equal(e["account_last4"], "9876"); assert.equal(e["next_draft_on"], "2027-01-01");
  assert.ok((await cards()).some((x) => x.props["flow_key"] === `autopay.active:${S.enrollmentId}`), "StatusCard autopay.active");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ui_events WHERE card_instance_id = ANY($1::uuid[]) AND kind = 'consent_affirmed'`, [[c.card_instance_id, auth.card_instance_id]]))[0]!.n, "2", "two consents, two taps");
  const rec = await record(); const auto = (rec.loan as Json)["autodraft"] as Json; assert.equal(auto["status"], "active"); assert.equal(auto["next_draft_on"], "2027-01-01"); knownFigures.add("••••9876");
  // the enrolled loan's own facts now ride as tokens (agent/servicing-context.ts)
  const sv = servicingView(rec); assert.equal((sv.view["autopay"] as Json)["status"], "active"); assert.equal(sv.tokens["loan.autodraft.next_draft_on"], "2027-01-01"); assert.equal(sv.tokens["loan.autodraft.account_last4"], "••••9876"); assert.equal(sv.tokens["loan.autodraft.draft_day"], "1st");
});

// ═══════════════════════════════════ 4. a payoff question → explain{payoff} says why the number moves; the payoff card carries the engine's figure; the tap requests the written statement
test("servicing conversation: \"how much would it take to close out my loan if I sell next month?\" — the model explains why a payoff changes daily and raises the payoff card: 16.1's figure lives on the card, never in the sentence; the tap starts the written statement's clock", { skip }, async () => {
  await signInAgain(MST("2026-12-16", "10:00"));
  scripted.use([{ when: /close out my loan if I sell next month/i, calls: [{ name: "explain", input: { topic: "payoff" } }, { name: "card_request", input: { kind: "payoff_quote", args: { good_through: "2027-01-15" } } }], text: (c) => {
    const ex = c.toolResults[0]!; assert.equal(ex["outcome"], "explained"); assert.deepEqual(ex["facts"], {}, "payoff hands the model no figure"); assert.match(String(ex["note"]), /state no figure/);
    const r = c.toolResults[1]!; assert.equal(r["outcome"], "sent", JSON.stringify(r)); assert.equal(r["card_kind"], "ChoiceCard"); assert.equal(r["copy_key"], "payoff.written.choice"); assert.ok(!("total_cents" in r) && !("tokens" in r), `the figure never reaches the model: ${JSON.stringify(r)}`);
    return "The exact figure is on the payoff card on the rail, good through the date shown there. It changes a little every day because interest accrues daily, so a figure for next month is only good through its date. Tapping the card sends you a written statement.";
  } }]);
  const r = await say("how much would it take to close out my loan if I sell next month?");
  assertOwnWords(r.reply); assert.doesNotMatch(String(r.reply["body_text"]), /\d|\$/, "no figure in the model's sentence");
  const c = await card(String(r.reply["card_instance_id"])); assert.equal(c.kind, "ChoiceCard"); assert.equal(c.copy_key, "payoff.written.choice"); assert.equal(c.command_ref, "case.open"); assert.equal(c.status, "pending"); assert.equal(c.props["figure_on_card"], true);
  S.quoteId = String(c.props["quote_id"]); const q = (await entity("payoff_quotes", S.quoteId))!; assert.equal(q["quote_type"], "portal"); assert.equal(q["good_through"], "2027-01-15");
  assert.equal(c.props["total_cents"], String(q["total_cents"])); assert.equal(c.props["per_diem_cents"], String(q["per_diem_cents"])); assert.equal(c.props["good_through"], "2027-01-15"); assert.deepEqual(c.props["copy_tokens"], { money: usd(String(q["total_cents"])), date: "2027-01-15" });
  assert.ok(BigInt(String(q["total_cents"])) > BigInt(String((await record()).numbers!["upb_cents"])), "the payoff carries interest through the good-through date on top of the balance");
  const computed = (await events("payoff.quote.computed")).find((e) => e.payload["quote_id"] === S.quoteId)!; assert.equal(computed.payload["quote_type"], "portal"); assert.equal(computed.payload["oral"], false);
  assert.equal((await events("payoff.request.received")).length, 0, "a question is not a written request: no §1026.36(c)(3) clock yet");
  const row = await turnOf(r.reply); assert.deepEqual(row.tool_calls.map((x) => x["name"]), ["explain", "card.request"]);
  // the tap: 32.2 case.open{payoff_request} → 32.9's reaction records the 16.1 written request → the 7-BD clock
  const sent = await resolve(c.card_instance_id, { option_id: "send", evidence: { option_id: "send", tapped_at: clock.now() } }); assert.equal(sent.status, 201, JSON.stringify(sent.body).slice(0, 400)); assert.equal(sent.body["command"], "case.open"); await settle();
  const received = (await events("payoff.request.received")).at(-1)!; assert.ok(received, "the written request"); assert.equal(received.payload["written"], true);
  const t7 = (await db.query<{ status: string }>(`SELECT status::text AS status FROM timers WHERE loan_id = $1 AND code = 'REGZ_1026_36C3_PAYOFF_STMT_7BD' ORDER BY armed_at DESC LIMIT 1`, [S.loanId]))[0]; assert.equal(t7?.status, "armed");
  assert.equal((await card(c.card_instance_id)).status, "resolved");
});

// ═══════════════════════════════════ 5. "what is escrow?" → explain, no card
test("servicing conversation: \"what is escrow?\" — explain{escrow} on the serviced loan: the words plus the escrow facts as tokens; no card exists for a question", { skip }, async () => {
  const before = (await cards()).length;
  scripted.use([{ when: /what is escrow/i, calls: [{ name: "explain", input: { topic: "escrow" } }], text: (c) => { const r = c.toolResults[0]!; assert.equal(r["outcome"], "explained"); assert.equal(r["copy_key"], "explain.escrow"); assert.equal(r["library_copy_key"], "escrow.statement"); assert.ok((r["facts"] as Json)["escrow"], "the loan's escrow block"); assert.doesNotMatch(String(r["text"]), /\d/); return "Escrow is the set-aside that rides with your monthly payment to cover your property taxes and insurance when they come due, so those bills never land all at once. Once a year we review it and adjust the share. Your escrow portion of the next payment is {{numbers.next_payment_escrow}}."; } }]);
  const r = await say("what is escrow?");
  assertOwnWords(r.reply); assert.match(String(r.reply["body_text"]), /^Escrow is the set-aside/); assert.match(String(r.reply["body_text"]), /is \$687\.50\.$/, "the escrow share from the record's next installment");
  assert.equal(r.reply["card_instance_id"], null); assert.equal((await cards()).length, before, "no card for a question");
  assert.equal((r.reply["copy_tokens"] as Json)["explain"], "explain.escrow"); assert.equal((await turnOf(r.reply)).safe_classification, "general_explanation");
});

// ═══════════════════════════════════ 6. "I lost my job and can't pay next month" → 32.10's intake card; the model's explanation, no promises (the guard refuses decline language)
test("servicing conversation: \"I lost my job and can't pay next month\" — 32.10's QRPC read-back card is the hardship intake (the flow answers first, 32.10 T2); the model's follow-up explanation carries no promise: decline language is refused by the guard and never reaches the thread, and the accepted words name no eligibility", { skip }, async () => {
  await signInAgain(MST("2026-12-17", "10:00"));
  const r = await say("I lost my job and can't pay next month");
  assert.equal(r.reply["copy_key"], "hardship.heard", "32.10 T2: the flow's intake answers this line"); assert.equal(r.body["command"], "lossmit.requestAssistance");
  const qrpc = (await cards()).find((c) => c.copy_key === "hardship.qrpc.confirm" && c.status === "pending")!; assert.ok(qrpc, "the hardship intake card: the read-back of what was understood"); assert.equal(qrpc.kind, "ConfirmCard"); assert.equal(qrpc.command_ref, "lossmit.requestAssistance");
  assert.equal((await events("lossmit.application.received")).length, 1, "a stated hardship is an application (12.1)");
  // the model, asked what happens now: a first attempt with decline language is refused by the guard's scope check (never regenerated, never sent) — the step's default copy answers
  scripted.use([
    { when: /will I be approved for help/i, text: "You won't be declined — almost everyone is approved, so don't worry about it." },
    { when: /so what happens next/i, calls: [{ name: "explain", input: { topic: "hardship" } }], text: (c) => { const x = c.toolResults[0]!; assert.equal(x["outcome"], "explained"); assert.equal(x["library_copy_key"], "hardship.open"); assert.equal(((x["facts"] as Json)["hardship"] as Json)["status"], "application_pending"); assert.doesNotMatch(String(x["text"]), /\d|approved|eligib|declin|denied|qualif/i); return "Nothing on your loan changes today. What you told me is recorded as a request for help; we confirm what else is needed within a few business days, look at every option the program allows, and send the decision with its reasons and how to appeal. First, please check the read-back on the rail and confirm it."; } },
  ]);
  const r2 = await say("what happens now, will I be approved for help?");
  assert.equal(r2.reply["body_text"], `{{copy:${String(r2.reply["copy_key"])}}}`, "the step's default copy, not the model's sentence");
  assert.ok((await cards()).some((c) => c.status === "pending" && c.copy_key === r2.reply["copy_key"]), `the default copy is the current ask's (${String(r2.reply["copy_key"])}: the intake's needs list or the read-back)`);
  const tk = r2.reply["copy_tokens"] as Json; assert.equal(tk["fallback"], "default_copy"); assert.equal(tk["rejected_by"], "scope");
  const rejected = (await turns()).find((t) => t.message_id === (r2.body["message"] as Json)["message_id"] && (t.guard_result as Json)["ok"] === false)!; assert.ok(rejected); assert.equal((rejected.guard_result as Json)["rejected_by"], "scope"); assert.match(String((rejected.guard_result as Json)["violation"]), /decline language/); assert.equal((rejected.guard_result as Json)["regenerable"], false);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM messages WHERE conversation_id = $1 AND body_text LIKE '%declined%'`, [S.conversation_id]))[0]!.n, "0", "the sentence never reached the thread");
  const r3 = await say("ok, so what happens next?");
  assertOwnWords(r3.reply); assert.match(String(r3.reply["body_text"]), /^Nothing on your loan changes today/); assert.doesNotMatch(String(r3.reply["body_text"]), /approved|eligib|declin|denied|qualif|guarantee/i, "no promise, no eligibility statement");
  assert.equal((r3.reply["copy_tokens"] as Json)["explain"], "explain.hardship");
  assert.equal((await cards()).find((c) => c.card_instance_id === qrpc.card_instance_id)!.status, "pending", "the intake card still waits for the borrower's tap");
});

// ═══════════════════════════════════ 7. e-delivery in words → the consent card (the bus refuses the direct consent) → tap → verify → active; a statement; "send me last month's statement" → the statement's own DocumentCard
test("servicing conversation: \"I want my statements online\" — the model raises 32.7's e-delivery ConsentCard; a direct consent.capture is refused by the bus; the tap and the demonstration test make it active; a statement is issued; \"send me last month's statement\" points at the statement's own DocumentCard and mints no card", { skip }, async () => {
  scripted.use([
    { when: /statements online/i, calls: [{ name: "card_request", input: { kind: "paperless" } }], text: (c) => { assert.equal(c.toolResults[0]!["outcome"], "sent", JSON.stringify(c.toolResults[0])); return "The e-delivery consent is on the rail: check the box and type your name there and your statements and notices come here instead of by mail. Until then they stay on paper."; } },
    { when: /just say yes for me/i, calls: [{ name: "command_run", input: { name: "consent.capture", args: { kind: "esign" } } }], text: (c) => { assert.equal(c.toolResults[0]!["error"], "COMMAND_OUTSIDE_CONTRACT"); return "A consent only counts from the card, with your typed name — I can't give it for you."; } },
  ]);
  const r = await say("I want my statements online, not on paper");
  assertOwnWords(r.reply); const c = await card(String(r.reply["card_instance_id"]));
  assert.equal(c.kind, "ConsentCard"); assert.equal(c.copy_key, "consent.esign.servicing"); assert.equal(c.command_ref, "consent.capture"); assert.equal(c.props["consent_kind"], "esign"); assert.ok((c.props["scope"] as string[]).includes("periodic_statements")); assert.equal(c.props["requires_typed_name"], true);
  const r2 = await say("just say yes for me"); assertOwnWords(r2.reply);
  assert.equal((await refusals()).map((x) => x.payload).filter((p) => p["attempted"] === "consent.capture").length, 1);
  await freshCode();
  const tapped = await resolve(c.card_instance_id, { option_id: "affirm", evidence: { consent_kind: "esign", disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", method: "checkbox_with_text", text_hash: "sha256:esign-7001c", affirmed_at: clock.now(), typed_name: "Alex Borrower" } });
  assert.equal(tapped.status, 201, JSON.stringify(tapped.body).slice(0, 500)); assert.equal(tapped.body["command"], "consent.capture");
  S.consentId = String((tapped.body["result"] as Json)["consent_id"]); assert.equal((await db.query<{ status: string }>(`SELECT status FROM consents WHERE id = $1`, [S.consentId]))[0]!.status, "pending_verification", "7.4: the demonstration test runs before active");
  const ver = await api("POST", "/v1/borrower/commands/consent.capture", { op: "verify", consent_id: S.consentId, token: esignVerificationToken(S.consentId), scope: c.props["scope"], subject: { loan_id: S.loanId } }, S.token); assert.equal(ver.status, 200, JSON.stringify(ver.body).slice(0, 400)); await settle();
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM consents WHERE id = $1`, [S.consentId]))[0]!.status, "active");
  // the co-borrower went paperless too (7.4 rule 4: when any party mails, the cycle mails) — Blake's own session, the same consent and demonstration test, as 32.8 T7 captures one
  const blake = await otpSignIn(S.B);
  const bc = await api("POST", "/v1/borrower/commands/consent.capture", { kind: "esign", method: "checkbox_with_text", scope: [...SERVICING_ESIGN_SCOPES], disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", purpose: "informational", text_hash: "sha256:esign-7001c", subject: { loan_id: S.loanId } }, blake.token); assert.equal(bc.status, 200, JSON.stringify(bc.body).slice(0, 300));
  const bId = String((bc.body["result"] as Json)["consent_id"]); const bv = await api("POST", "/v1/borrower/commands/consent.capture", { op: "verify", consent_id: bId, token: esignVerificationToken(bId), scope: [...SERVICING_ESIGN_SCOPES], subject: { loan_id: S.loanId } }, blake.token); assert.equal(bv.status, 200, JSON.stringify(bv.body).slice(0, 300)); await settle();
  // Sun Dec 20: 7.1's cycle for the Jan 1 installment — under the active consents the statement is delivered electronically: 32.8's DocumentCard `statement.available`
  const now = MST("2026-12-20", "09:00"); clock.set(now);
  const run = await sendPeriodicStatement(runtime, S.loanId, { cycle_due_date: D("2027-01-01"), statement_date: D("2026-12-20"), now }); assert.equal(run.channel, "electronic", JSON.stringify(run.events.map((e) => e.type))); await settle();
  const doc = (await cards()).find((x) => x.kind === "DocumentCard" && x.copy_key === "statement.available")!; assert.ok(doc, "32.8's DocumentCard for the statement"); S.statementCardId = doc.card_instance_id; assert.equal(doc.props["cycle_due_date"], "2027-01-01");
  await signInAgain(MST("2026-12-21", "10:00"));
  const docsBefore = (await cards()).filter((x) => x.kind === "DocumentCard").length;
  scripted.use([{ when: /send me last month'?s statement/i, calls: [{ name: "card_request", input: { kind: "statement_copy" } }], text: (c) => { const x = c.toolResults[0]!; assert.equal(x["outcome"], "on_rail", JSON.stringify(x)); assert.equal(x["card_instance_id"], S.statementCardId); assert.equal(x["cycle_due_date"], "2027-01-01"); return "Your latest statement is on the rail under Documents — that card opens it. Everything on it stays there whenever you need it."; } }]);
  const r3 = await say("send me last month's statement");
  assertOwnWords(r3.reply); assert.equal(r3.reply["card_instance_id"], S.statementCardId, "the reply references the statement's own card");
  assert.equal((await cards()).filter((x) => x.kind === "DocumentCard").length, docsBefore, "no DocumentCard minted on the borrower's ask (§2.3)"); assert.equal(cardCaseOf("DocumentCard", "card.request"), null);
  const hv = historyView("statements", (await api("GET", `/v1/borrower/history/statements?subject=${S.loanId}`, undefined, S.token)).body["rows"] as Json[]); assert.equal(hv.tokens["statements.1.cycle_due_date"], "2027-01-01");
});

// ═══════════════════════════════════ 8. "am I talking to a computer?" → the model says it is automated and offers a callback; no transfer runs
test("servicing conversation: \"am I talking to a computer?\" — answered in the model's own words: it says it is automated and offers a callback request or a written dispute (the guard's disclosure check); no transfer runs because no person is staffed (docs/ux/17 §1 principle 8)", { skip }, async () => {
  await signInAgain(MST("2026-12-21", "11:00"));
  const transfers = (await events("human.transfer.requested")).length;
  // "is this a real person?" — the identity question reaches the turn (commands.ts's "human" path stands aside for it when a turn is configured; "are you a real person?" stays 32.3 T2's own scripted line): the model's words, the guard's disclosure check
  scripted.use([{ when: /is this a real person/i, text: "No — I'm automated, not a real person, and there's no one staffed live right now. If you want a person I can log a callback request or a written dispute for you; tell me which." }]);
  const r0 = await say("is this a real person?");
  assertOwnWords(r0.reply); assert.match(String(r0.reply["body_text"]), /I'm automated, not a real person/); assert.match(String(r0.reply["body_text"]), /callback request/); assert.notEqual(r0.reply["copy_key"], "thread.human_requested", "the human path did not take the identity question");
  assert.equal((await events("human.transfer.requested")).length, transfers, "no transfer queued for a question about who is talking"); assert.equal(r0.body["command_executed"], false);
  scripted.use([{ when: /am I talking to a computer/i, text: "Yes — I'm an automated assistant, not a person, and no one is staffed live right now. If you'd like a person, I can log a callback request or a written dispute; just say which." }]);
  const r = await say("am I talking to a computer?");
  assertOwnWords(r.reply); assert.match(String(r.reply["body_text"]), /automated assistant, not a person/); assert.match(String(r.reply["body_text"]), /callback request/);
  const row = await turnOf(r.reply); assert.equal(((row.guard_result as Json)["checks"] as Json)["disclosure"] && (((row.guard_result as Json)["checks"] as Json)["disclosure"] as Json)["ok"], true); assert.equal((row.guard_result as Json)["human_requested"], false);
  assert.equal((await events("human.transfer.requested")).length, transfers, "no transfer while no person exists");
  assert.equal(r.body["command_executed"], false);
  // a callback asked for in words is a card too: the number on file and the best time are confirmed there, and the tap logs the written request
  scripted.use([{ when: /call me back tomorrow afternoon/i, calls: [{ name: "card_request", input: { kind: "callback", args: { window: "afternoon" } } }], text: (c) => { assert.equal(c.toolResults[0]!["outcome"], "sent", JSON.stringify(c.toolResults[0])); return "The callback card is on the rail — confirm the number and the afternoon there and it's logged. No one is staffed live yet, so I can't promise a time."; } }]);
  const r2 = await say("ok, have someone call me back tomorrow afternoon"); assertOwnWords(r2.reply);
  const cb = await card(String(r2.reply["card_instance_id"])); assert.equal(cb.kind, "ConfirmCard"); assert.equal(cb.copy_key, "callback.request"); assert.equal(cb.command_ref, "case.open"); assert.deepEqual((cb.props["fields"] as Json[]).map((f) => f["path"]), ["phone", "window"]); assert.equal((cb.props["fields"] as Json[])[1]!["value"], "afternoon");
});

// ═══════════════════════════════════ the catalogue and the topics as data; the invariants over the whole transcript
test("servicing conversation: the card.request catalogue — every kind is an existing card on a §2.3 case for the borrower's ask, every arg is validated before anything runs, every explain topic's words carry no figure", () => {
  // the servicing asks (Stage 4); sibling stages add their own kinds (the typed income and assets cards of 32.3) in the same shape — every entry keeps the contract below
  for (const k of ["payment", "extra_principal", "autopay_enroll", "autopay_change", "autopay_pause", "autopay_revoke", "payoff_quote", "escrow_shortage", "hardship", "upload", "callback", "dispute", "statement_copy", "paperless"]) assert.ok(k in CARD_REQUESTS, `${k} in the catalogue`);
  for (const [k, s] of Object.entries(CARD_REQUESTS)) {
    if (k === "statement_copy") { assert.equal(s.command_ref, null); assert.equal(cardCaseOf(s.kind, "card.request"), null, "a DocumentCard is never minted on an ask: the statement's own card is referenced"); continue; }
    assert.ok(cardCaseOf(s.kind, "card.request"), `${k}: a ${s.kind} is a §2.3 case on the borrower's ask`); assert.ok(s.command_ref, `${k} delegates to a command`); assert.ok(s.owner && s.description);
  }
  // money commands and consents are cards here, never command.run
  for (const cmd of ["payment.makeOneTime", "payment.extraPrincipal", "autodraft.enroll", "autodraft.change", "autodraft.pause", "autodraft.revoke", "escrow.electShortage", "consent.capture"]) assert.ok(!COMMAND_RUN_ALLOWLIST.includes(cmd), `${cmd} is not a command a turn may run`);
  assert.throws(() => requestArgs("autopay_enroll", { draft_day: 20 }), /1 to 16/); assert.throws(() => requestArgs("extra_principal", { amount_cents: "five hundred" }), /amount_cents/); assert.throws(() => requestArgs("callback", { window: "midnight" }), /morning\/afternoon\/evening/);
  assert.deepEqual(requestArgs("extra_principal", { amount_cents: "50000", bogus: "x" }), { amount_cents: "50000" }); assert.deepEqual(requestArgs("autopay_enroll", { draft_day: "5" }), { draft_day: 5 });
  for (const [k, t] of Object.entries(SERVICING_EXPLAIN_TOPICS)) { assert.equal(provenanceViolation(t.text), null, `${k}: ${provenanceViolation(t.text)}`); assert.ok(t.record_fields.length || t.history || t.terms || k === "payoff", `${k} names what it reads`); }
  assert.ok(Object.keys(EXPLAIN_TOPICS).length > 0);   // the origination topics are the Stage 3 owner's (their `cash_out` line carries "one and", which the guard would refuse if repeated verbatim — reported, not asserted here)
  const schema = MODEL_TOOLS_32_16.find((t) => t.name === "card.request")!; assert.deepEqual((((schema.input_schema as Json)["properties"] as Json)["kind"] as Json)["enum"], Object.keys(CARD_REQUESTS)); assert.ok(String(MODEL_TOOLS_32_16.find((t) => t.name === "explain")!.description).includes("balance, payment_applied"));
});

test("servicing conversation: over the whole transcript — no assistant line carries a digit a tool did not supply, none is a copy-library template, every money movement has a card.resolved and a balanced ledger set behind it, and every turn the model answered has its agent_turns row", { skip }, async () => {
  const t = await thread(); const rows = await turns();
  const agentLines = t.filter((m) => m["sender"] === "agent" && (m["copy_tokens"] as Json | null)?.["source"] === "agent_turn");
  assert.ok(agentLines.length >= 12, `the model answered the conversation (${agentLines.length} lines)`);
  for (const m of agentLines) {
    const tk = m["copy_tokens"] as Json; const body = String(m["body_text"]);
    if (tk["fallback"]) { assert.match(body, /^\{\{copy:/, "a rejected turn answers the step's copy, never the model's sentence"); continue; }
    assertOwnWords(m);
    // docs/ux/17 §1 principle 5 / §3.7: a reply says something — never a bare "What next?" / "Anything else?" line, never fewer than a sentence's worth of words
    assert.doesNotMatch(body, /^\s*(?:what|so|and|ok(?:ay)?|now|anything|what)?\s*(?:next|now|else|then|more)?\s*\?\s*$/i, `a bare prompt, no content: "${body}"`);
    assert.ok((body.match(/[A-Za-z0-9$][^\s]*/g) ?? []).length >= 7, `a reply carries content (${body})`);
    const row = rows.find((x) => x.reply_message_id === m["message_id"]); assert.ok(row, `an agent_turns row behind "${body.slice(0, 40)}"`); assert.equal((row.guard_result as Json)["ok"], true);
    for (const c of row.tool_calls) { assert.ok(MODEL_TOOLS_32_16.some((x) => x.name === c["name"]), `${c["name"]} is a 32.16 tool`); if (!c["is_error"]) assert.match(String(c["decision_id"]), /^[0-9a-f-]{36}$/, `${c["name"]} has its agent_decisions row`); }
  }
  // every borrower line the turn answered (not the flows' own answers) has a row naming it
  for (const m of t.filter((x) => x["sender"] === "borrower")) { const reply = t.find((x) => x["sender"] === "agent" && (x["copy_tokens"] as Json | null)?.["source"] === "agent_turn" && rows.some((r) => r.reply_message_id === x["message_id"] && r.message_id === m["message_id"])); if (reply) assert.ok(rows.some((r) => r.message_id === m["message_id"]), `a row for "${m["body_text"]}"`); }
  // money: every portal payment on the loan came from a resolved card with the borrower's tap as its evidence, and posted through balanced sets
  const received = await events("payment.received");
  assert.ok(received.some((e) => e.payload["designation"] === "curtailment"), "the extra principal");
  for (const e of received.filter((x) => x.payload["channel"] === "portal")) {
    const id = String(e.payload["card_instance_id"]); assert.match(id, /^[0-9a-f-]{36}$/, "a portal payment names its card");
    assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ui_events WHERE card_instance_id = $1 AND kind = 'card_resolved'`, [id]))[0]!.n, "1");
    const sets = await db.query<{ total: string }>(`SELECT sum(l.amount_cents)::text AS total FROM ledger_entry_sets s JOIN ledger_lines l ON l.set_id = s.id WHERE s.description LIKE $1 GROUP BY s.id`, [`%${String(e.payload["payment_id"])}%`]);
    assert.ok(sets.length >= 1, "posted"); for (const s of sets) assert.equal(s.total, "0");
  }
  // the consents: each affirmed on a card, never by a turn
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ui_events WHERE party_id = $1 AND kind = 'consent_affirmed'`, [S.partyA]))[0]!.n, "3", "autopay enroll, the authorization, e-delivery");
  const attempted = (await refusals()).map((x) => String(x.payload["attempted"])); for (const cmd of ["payment.extraPrincipal", "autodraft.enroll", "consent.capture"]) assert.ok(attempted.includes(cmd), `${cmd} refused by the bus when the model tried it directly`);
});
