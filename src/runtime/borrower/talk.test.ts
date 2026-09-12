// Talk (src/runtime/borrower/talk.ts): the anonymous minute and sign-in as one conversation, over the real runtime on its own
// database. The model is scripted (a client with the Messages API's shape answering canned tool calls and sentences) so the
// loop, the tools, the verbatim notices, the guard and the cookies are asserted without the network; the last test runs the
// real model end to end and is skipped without ANTHROPIC_API_KEY. Skips without Postgres (not a spec unit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { connect, reachable, type Db } from "../../infra/db/index.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { Runtime } from "../app.ts";
import { createApiServer, listen } from "../server.ts";
import { createLogger } from "../log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "./routes.ts";
import { LEAD_HEADER } from "./lead-routes.ts";
import { seedEntryDemo } from "../entry-seed.ts";
import { ACCOUNT_HANDOFF_KEY, ClaudeTalkAgent, TALK_PATH, TALK_SYSTEM } from "./talk.ts";

const DB_URL = process.env["TALK_TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_talk_test";
const up = await reachable(DB_URL);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const NOW = "2026-09-10T16:00:00.000Z";
type Json = Record<string, unknown>;

// ---------------------------------------------------------------- a scripted Messages API client
type Call = { name: string; input: Json };
type Scene = { when: RegExp; calls?: Call[]; text: string };
/** Answers like the API: on a fresh visitor message, the scene's tool calls (one response); on their results, the scene's sentence. */
function scriptedClient(scenes: Scene[]): { client: Anthropic; requests: Anthropic.MessageCreateParamsNonStreaming[]; toolResults: Anthropic.ToolResultBlockParam[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = []; const toolResults: Anthropic.ToolResultBlockParam[] = [];
  let scene: Scene | undefined;
  const message = (content: Anthropic.ContentBlock[], stop: "end_turn" | "tool_use"): Anthropic.Message =>
    ({ id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: "scripted", content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null } } as unknown as Anthropic.Message);
  const create = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    requests.push(params);
    const last = params.messages.at(-1)!;
    if (Array.isArray(last.content) && last.content.every((b) => (b as { type: string }).type === "tool_result")) {
      toolResults.push(...(last.content as Anthropic.ToolResultBlockParam[]));
      return message([{ type: "text", text: scene?.text ?? "Okay.", citations: null }], "end_turn");
    }
    const visitor = typeof last.content === "string" ? last.content.split("[visitor]\n")[1] ?? "" : "";
    scene = scenes.find((s) => s.when.test(visitor));
    if (!scene) return message([{ type: "text", text: "Sorry, say that again?", citations: null }], "end_turn");
    if (!scene.calls?.length) return message([{ type: "text", text: scene.text, citations: null }], "end_turn");
    return message(scene.calls.map((c, i) => ({ type: "tool_use", id: `toolu_${i}_${randomUUID().slice(0, 6)}`, name: c.name, input: c.input }) as unknown as Anthropic.ContentBlock), "tool_use");
  };
  return { client: { messages: { create } } as unknown as Anthropic, requests, toolResults };
}

const SCENES: Scene[] = [
  { when: /has not said anything yet/, text: "Hi. What would you like to do: buy a home, lower your rate or payment, or take cash out?" },
  { when: /lower my payment/i, calls: [{ name: "set_fact", input: { step: "goal", value: "lower_rate" } }], text: "Got it. Is this your primary home, a second home, or an investment property?" },
  { when: /^primary$/i, calls: [{ name: "set_fact", input: { step: "occupancy", value: "primary" } }], text: "Which state is the home in?" },
  { when: /arizona/i, calls: [{ name: "set_fact", input: { step: "state", value: "AZ" } }], text: "About what is it worth, and about how much do you owe on it?" },
  { when: /worth about 450k/i, calls: [{ name: "set_fact", input: { step: "estimate", value: "", amounts_dollars: { home_value: 450000, balance_owed: 300000 } } }, { name: "show_rates", input: {} }], text: "Those are today's published rates above. Want to see the rate you'd actually get?" },
  { when: /go ahead/i, calls: [{ name: "create_account", input: {} }], text: "Seeing the rate you'd actually get takes a soft credit check that doesn't affect your score, and it starts with an account." },
  { when: /pay ahead/i, calls: [{ name: "send_message", input: { text: "can I pay ahead?" } }], text: "I've passed that to your file." },
  { when: /a person/i, calls: [{ name: "talk_to_person", input: {} }], text: "Of course. Someone will pick this up from here." },
  { when: /guess my rate/i, text: "You'd probably land around 6.1% and save $412 a month." },
  { when: /am I approved/i, text: "You're pre-approved as far as I can tell." },
  { when: /my income is/i, calls: [{ name: "send_message", input: { text: "income" } }], text: "Thanks." },
];

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined;
let scripted: ReturnType<typeof scriptedClient>; let partnerName = "";
test.before(async () => {
  if (skip) return;
  const name = new URL(DB_URL).pathname.slice(1); const admin = new URL(DB_URL); admin.pathname = "/postgres";
  const a = connect(admin.toString()); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock: new FixedClock(NOW) });
  const seeded = await seedEntryDemo(runtime, { states: ["AZ", "CO"], now: NOW });   // the demo seed: open states, the partner's NMLSR ID, an active FAKE rate sheet
  partnerName = seeded.partner_name;
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /talk|error|unhandled/i.test(line)) process.stderr.write(line + "\n"); });
  scripted = scriptedClient(SCENES);
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret", talk: { client: scripted.client, model: "scripted" } });
  const server = createApiServer({ runtime, apiToken: "ops-" + randomUUID(), logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) await close(); });

type Reply = { status: number; body: Json };
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const lines = (b: Json): Json[] => (b["lines"] as Json[] | undefined) ?? [];
const transcript = (b: Json): Json[] => (b["transcript"] as Json[] | undefined) ?? [];
const entity = async (kind: string, id: string): Promise<Json | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };

test("talk: arrive → the disclosure first (verbatim, from the library), the agent's greeting, the lead cookie; every turn re-reads the same lead", { skip }, async () => {
  const r = await post(TALK_PATH, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const token = r.body["lead_token"] as string; assert.ok(token, "lead_token leaves once for the proxy's cookie");
  assert.equal(r.body["agent"], "claude"); assert.equal(r.body["model"], "scripted"); assert.equal(r.body["step"], "goal");
  const t = transcript(r.body);
  assert.equal(t[0]!["role"], "notice"); assert.equal(t[0]!["copy_key"], "entry.disclosure.first"); assert.match(String(t[0]!["text"]), /automated assistant/); assert.ok(String(t[0]!["text"]).includes(partnerName), "the partner's name in the disclosure");
  assert.equal(t[1]!["role"], "agent"); assert.match(String(t[1]!["text"]), /What would you like to do/);
  // the system prompt is the stable, cached prefix; the tools ride on every request
  const req = scripted.requests.at(-1)!;
  assert.deepEqual(req.system, [{ type: "text", text: TALK_SYSTEM, cache_control: { type: "ephemeral" } }]);
  assert.deepEqual((req.tools ?? []).map((x) => (x as { name: string }).name), ["set_fact", "show_rates", "create_account", "talk_to_person", "send_message"]);
  assert.equal(req.model, "scripted");
  // a reload with the cookie continues the same lead and the same transcript — and never re-greets: no model call, no second opening line
  const requestsBefore = scripted.requests.length;
  const again = await post(TALK_PATH, {}, { [LEAD_HEADER]: token });
  assert.equal(again.body["lead_id"], r.body["lead_id"]); assert.equal(again.body["lead_token"], undefined, "no second lead, no second token");
  assert.equal(transcript(again.body)[0]!["copy_key"], "entry.disclosure.first");
  assert.equal(transcript(again.body).length, t.length, "the transcript as it was"); assert.deepEqual(lines(again.body), [], "no new lines"); assert.equal(scripted.requests.length, requestsBefore, "the model was not called");
  assert.equal((await entity("talk_transcripts", String(r.body["lead_id"])))?.["lead_id"], r.body["lead_id"], "the transcript is the lead's own entity row");
});

test("talk: the facts through set_fact (dollars → bigint cents in code), the range shown verbatim with APR and the NMLSR ID, then Create account with the lead carried over — one conversation, the same rows the chips write", { skip }, async () => {
  const start = await post(TALK_PATH, {}); const token = start.body["lead_token"] as string; const leadId = String(start.body["lead_id"]); const withLead = { [LEAD_HEADER]: token };
  let r = await post(TALK_PATH, { text: "I want to lower my payment" }, withLead);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["step"], "occupancy");
  assert.equal((await entity("leads", leadId))?.["transaction_intent"], "limited_cash_out");
  assert.match(String(lines(r.body).find((l) => l["role"] === "agent")?.["text"]), /primary home/);
  r = await post(TALK_PATH, { text: "primary" }, withLead); assert.equal(r.body["step"], "state");
  r = await post(TALK_PATH, { text: "Arizona" }, withLead); assert.equal(r.body["step"], "estimate");
  assert.equal((await entity("leads", leadId))?.["consumer_state"], "AZ");
  r = await post(TALK_PATH, { text: "worth about 450k and I owe 300k" }, withLead);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["step"], "identify");
  const lead = (await entity("leads", leadId))!;
  assert.equal(String(lead["value_estimate_cents"]), "45000000"); assert.equal(String(lead["stated_existing_balance_cents"]), "30000000");
  // the checked §1026.24 sentence, verbatim as 20.3 rendered it, then the promise — notices from the tool, never the model's words
  const card = lines(r.body).find((l) => l["copy_key"] === "entry.range.card"); assert.ok(card, "entry.range.card shown"); assert.equal(card!["role"], "notice");
  assert.match(String(card!["text"]), /\d\.\d{3}% \(\d\.\d{3}% APR\)/); assert.match(String(card!["text"]), /not a commitment/i); assert.ok(String(card!["text"]).includes("NMLSR ID 123456"), String(card!["text"]));
  assert.equal(lines(r.body).find((l) => l["copy_key"] === "entry.range.promise")?.["role"], "notice");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'lead.range.shown' AND payload->>'lead_id' = $1`, [leadId]))[0]!.n, "1");
  // the agent's sentence after the range may mention "the rates above" but carries no figure of its own
  const agentLine = String(lines(r.body).find((l) => l["role"] === "agent")?.["text"]); assert.doesNotMatch(agentLine, /\d%|\$\d/);
  // after the range: no code by text or e-mail (docs/ux/17 §2.0) — create_account shows the hand-off line and the app's Create account link
  r = await post(TALK_PATH, { text: "ok go ahead" }, withLead);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(lines(r.body).find((l) => l["copy_key"] === ACCOUNT_HANDOFF_KEY)?.["role"], "notice", JSON.stringify(lines(r.body)));
  assert.equal(r.body["session_opened"], false); assert.equal(r.body["token"], undefined, "no session from the talk route");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM auth_challenges WHERE kind = 'otp'`))[0]!.n, "0", "no code was sent");
  // Create account with the lead cookie: the session links the lead, the organic application is built from its answers, and the thread resumes with entry.resumed
  const signUp = await post("/v1/borrower/auth/account", { action: "create", email: `talk-${randomUUID().slice(0, 8)}@example.com`, password: "correct horse battery" }, { ...withLead, "x-forwarded-for": "10.0.0.9" });
  assert.equal(signUp.status, 200, JSON.stringify(signUp.body));
  const bearer = signUp.body["token"] as string; assert.ok(bearer, "the session token for the cookie");
  await router.flows!.settle();
  const linked = (await entity("leads", leadId))!; assert.equal(linked["party_id"], (signUp.body["party"] as Json)["party_id"], "lead.linked{party_id} at the account door");
  const thread = await (await fetch(`${base}/v1/borrower/thread?limit=200`, { headers: { authorization: `Bearer ${bearer}` } })).json() as Json;
  const bodies = ((thread["messages"] as Json[]) ?? []).map((m) => String(m["body_text"] ?? ""));
  assert.equal(bodies[0], "{{copy:entry.disclosure.first}}"); assert.ok(bodies.some((b) => b.startsWith("{{copy:entry.resumed}}")), `entry.resumed in the thread: ${JSON.stringify(bodies)}`);
  assert.equal((await db.query<{ t: string }>(`SELECT a.transaction_type::text AS t FROM applications a JOIN application_borrowers ab ON ab.application_id = a.id WHERE ab.party_id = $1`, [(signUp.body["party"] as Json)["party_id"]]))[0]?.t, "limited_cash_out", "the application carries the lead's goal");
  // after sign-in the L0 tools are gone and the visitor's words go to their file's conversation
  r = await post(TALK_PATH, { text: "can I pay ahead?" }, { ...withLead, authorization: `Bearer ${bearer}` });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["step"], "signed_in");
  const sent = scripted.toolResults.at(-1)!; assert.ok(!("is_error" in sent && sent.is_error), JSON.stringify(sent)); assert.match(String(sent.content), /reply/);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM messages WHERE sender = 'borrower' AND body_text = 'can I pay ahead?'`))[0]!.n, "1");
});

test("talk: the guard — a figure before the range and a forbidden word never reach the visitor; an L1-only tool before sign-in is refused to the model; a person is one call away", { skip }, async () => {
  const start = await post(TALK_PATH, {}); const withLead = { [LEAD_HEADER]: start.body["lead_token"] as string };
  let r = await post(TALK_PATH, { text: "guess my rate" }, withLead);
  const guessed = String(lines(r.body).find((l) => l["role"] === "agent")?.["text"]); assert.doesNotMatch(guessed, /6\.1%|\$412/); assert.match(guessed, /can't give a number yet/);
  r = await post(TALK_PATH, { text: "am I approved?" }, withLead);
  const approved = String(lines(r.body).find((l) => l["role"] === "agent")?.["text"]); assert.doesNotMatch(approved, /pre-approved/i); assert.match(approved, /another way/);
  r = await post(TALK_PATH, { text: "my income is 90k" }, withLead);
  const refused = scripted.toolResults.at(-1)!; assert.equal(refused.is_error, true); assert.match(String(refused.content), /TOOL_NOT_ALLOWED/);
  r = await post(TALK_PATH, { text: "I want a person" }, withLead);
  assert.equal(lines(r.body).find((l) => l["copy_key"] === "thread.human_requested")?.["role"], "notice");
  assert.equal((await entity("talk_transcripts", String(start.body["lead_id"])))?.["human_requested"], true);
});

test("talk: a lead that already carries answers (the chip flow on the same cookie) is read back as entry.resumed before the model picks up mid-way", { skip }, async () => {
  // the chip flow: start a lead and answer the goal through POST /v1/borrower/lead — the same lead the talk route will find on the cookie
  const started = await post("/v1/borrower/lead", { action: "start", channel: "web_chat" }); assert.equal(started.status, 200, JSON.stringify(started.body));
  const token = started.body["lead_token"] as string; const withLead = { [LEAD_HEADER]: token };
  const answered = await post("/v1/borrower/lead", { action: "answer", step: "goal", value: "lower_rate" }, withLead); assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const r = await post(TALK_PATH, {}, withLead);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["lead_id"], started.body["lead_id"], "the same lead");
  const t = transcript(r.body);
  assert.equal(t[0]!["copy_key"], "entry.disclosure.first");
  assert.equal(t[1]!["copy_key"], "entry.resumed", JSON.stringify(t)); assert.equal(t[1]!["role"], "notice"); assert.match(String(t[1]!["text"]), /lower my rate/);
  assert.equal(t[2]!["role"], "agent");
  assert.equal(r.body["step"], "occupancy", "the next unanswered step");
});

test("talk: without ANTHROPIC_API_KEY the route answers 503 TALK_NOT_CONFIGURED and nothing else changes", { skip }, async () => {
  const saved = process.env["ANTHROPIC_API_KEY"]; delete process.env["ANTHROPIC_API_KEY"];
  try {
    const logger = createLogger("json", () => undefined);
    const bare = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" });
    assert.equal(bare.talk.agent, null);
    const server = createApiServer({ runtime, apiToken: "ops-" + randomUUID(), logger, console: false, borrowerRouter: bare });
    const port = await listen(server, 0, "127.0.0.1");
    const r = await fetch(`http://127.0.0.1:${port}${TALK_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 503); assert.equal(((await r.json()) as Json)["code"], "TALK_NOT_CONFIGURED");
    const lead = await fetch(`http://127.0.0.1:${port}/v1/borrower/lead`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", channel: "web_chat" }) });
    assert.equal(lead.status, 200, "the chips still work");
    await new Promise<void>((resolve) => { bare.hub.close(); server.closeAllConnections?.(); server.close(() => resolve()); });
  } finally { if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved; }
});

test("talk: the real model end to end (ANTHROPIC_API_KEY) — one message carrying every fact reaches the range and the sign-in ask; no figure of its own", { skip: skip || (process.env["ANTHROPIC_API_KEY"] ? false : "no ANTHROPIC_API_KEY") }, async () => {
  const logger = createLogger("json", () => undefined);
  const agent = new ClaudeTalkAgent({ apiKey: process.env["ANTHROPIC_API_KEY"], model: process.env["TALK_MODEL"], logger });
  const real = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret", talk: { apiKey: process.env["ANTHROPIC_API_KEY"], model: agent.model } });
  const server = createApiServer({ runtime, apiToken: "ops-" + randomUUID(), logger, console: false, borrowerRouter: real });
  const port = await listen(server, 0, "127.0.0.1"); const url = `http://127.0.0.1:${port}${TALK_PATH}`;
  const call = async (body: Json, headers: Record<string, string> = {}): Promise<Json> => (await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })).json() as Promise<Json>;
  try {
    const start = await call({}); const withLead = { [LEAD_HEADER]: start["lead_token"] as string }; const leadId = String(start["lead_id"]);
    assert.equal(transcript(start)[0]!["copy_key"], "entry.disclosure.first");
    let r = await call({ text: "I want to lower my payment. It's my primary home in Arizona, worth about 450k, and I owe about 300k." }, withLead);
    for (let i = 0; i < 3 && r["step"] !== "identify"; i++) r = await call({ text: "yes, go ahead" }, withLead);   // a cautious model may confirm before the range
    const lead = (await entity("leads", leadId))!;
    assert.equal(lead["transaction_intent"], "limited_cash_out"); assert.equal(lead["consumer_state"], "AZ"); assert.equal(String(lead["value_estimate_cents"]), "45000000");
    assert.equal(r["step"], "identify", JSON.stringify(r));
    assert.ok(transcript(r).some((l) => l["copy_key"] === "entry.range.card"), "the range shown");
    for (const l of transcript(r)) if (l["role"] === "agent") assert.doesNotMatch(String(l["text"]), /\d\.\d+%|\$\d/, `no figure of its own: ${l["text"]}`);
  } finally { await new Promise<void>((resolve) => { real.hub.close(); server.closeAllConnections?.(); server.close(() => resolve()); }); }
});
