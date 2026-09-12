/**
 * The conversation trace (docs/ux/17 §6 / DELTA-28's console view, brought forward): `GET /api/ai/conversation?party_id=|email=` and
 * `GET /api/ai/conversation/recent?limit=` on the ops console API, over the real runtime on its own database — an account created through the
 * borrower API with the scripted Messages API client (the same shape src/domain/borrower/32-16.spec.test.ts drives), one message, then both
 * endpoints read as an ops user: the turn joined to the borrower text it answered and the reply it produced, the thread and the cards, and the
 * cross-party listing with the e-mail masked to its first two characters. The ops token and the console's actor headers gate the routes as
 * they gate every other `/api/*` call; the access log carries the masked address. Skips without Postgres (REQUIRE_DB=1 makes that a failure).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { connect, reachable, type Db } from "../infra/db/client.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { FixedClock } from "../kernel/events/index.ts";
import { Runtime } from "../runtime/app.ts";
import { createApiServer, listen } from "../runtime/server.ts";
import { createLogger } from "../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../runtime/borrower/routes.ts";
import { seedEntryDemo } from "../runtime/entry-seed.ts";
import { PROMPT_VERSION } from "../runtime/borrower/agent/context.ts";
import { maskEmail } from "./store.ts";

const DB_URL = process.env["CONSOLE_AI_TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_console_ai_test";
const ADMIN_URL = (() => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })();
const up = await reachable(ADMIN_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
const NOW = "2026-09-12T16:00:00.000Z";
type Json = Record<string, unknown>;

// ---------------------------------------------------------------- the scripted Messages API client (32-16.spec.test.ts's shape: the first turn greets; one scene answers the question)
const REPLY = "It goes like this: we confirm a few facts about you and the home, connect your income, then price it. What are you hoping to do?";
function scriptedClient(): { client: Anthropic; requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const text = (t: string): Anthropic.Message => ({ id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: "scripted", content: [{ type: "text", text: t, citations: null }], stop_reason: "end_turn", stop_sequence: null, stop_details: null, usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null } } as unknown as Anthropic.Message);
  const create = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    requests.push(params);
    const last = params.messages.at(-1)!; const content = typeof last.content === "string" ? last.content : "";
    if (content.startsWith("[guard]")) return text("Let me put that another way: the next thing I need from you is on the rail.");
    const borrower = content.split("[borrower]\n")[1] ?? "";
    if (/how does this work/i.test(borrower)) return text(REPLY);
    if (/just created their account/.test(content)) return text("Hi {{party.first_name}}. Are you looking to buy a home, lower your rate or payment, or take cash out?");
    return text("Okay — what would you like to do next?");
  };
  return { client: { messages: { create } } as unknown as Anthropic, requests };
}

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";
const scripted = scriptedClient();
test.before(async () => {
  if (skip) return;
  const name = new URL(DB_URL).pathname.slice(1);
  const a = connect(ADMIN_URL); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock: new FixedClock(NOW) });
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${R}`]))[0]!.id;
  await seedEntryDemo(runtime, { partner_id: partnerPartyId, states: ["AZ", "CO"], now: NOW });
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId, llm: { client: scripted.client, model: "scripted" } });
  // the console mounted (the default): /ops and /api/* behind the ops token, the console's actor headers naming the human
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.7", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
/** The response with the thread's own text removed (body_text / borrower_text / reply_text): what the console adds must never carry the address. */
const withoutText = (v: unknown): unknown => Array.isArray(v) ? v.map(withoutText) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Json).filter(([k]) => !["body_text", "borrower_text", "reply_text"].includes(k)).map(([k, x]) => [k, withoutText(x)])) : v;
const ops = (role = "ops_analyst"): Record<string, string> => ({ authorization: `Bearer ${TOKEN}`, "x-actor-id": `u-${role}`, "x-actor-role": role });
/** The flows' reactions and the agent's queued turns (the first turn after sign-up runs behind the session hooks) have run. */
const settle = async () => { await router.flows!.settle(); await router.agent?.settle(); await router.flows!.settle(); };

test("GET /api/ai/conversation?party_id=|email= and /api/ai/conversation/recent: an account through the borrower API on the scripted model, one message → the thread, the cards and the agent_turns row joined to the borrower text and the reply; the cross-party listing masks the e-mail to its first two characters; the ops token and the actor headers gate both; the access log never carries the address", { skip }, async () => {
  const email = `casey-${R}@example.test`;
  const created = await api("POST", "/v1/borrower/auth/account", { action: "create", email, password: `pw-${R}` }); assert.equal(created.status, 200, JSON.stringify(created.body));
  const token = created.body["token"] as string; const partyId = (created.body["party"] as Json)["party_id"] as string; await settle();
  const sent = await api("POST", "/v1/borrower/messages", { text: "how does this work?" }, { authorization: `Bearer ${token}` }); assert.equal(sent.status, 200, JSON.stringify(sent.body)); await settle();
  const reply = sent.body["reply"] as Json; assert.equal(reply["sender"], "agent"); assert.equal(reply["body_text"], REPLY);
  const turnId = String((reply["copy_tokens"] as Json)["turn_id"]);

  // the gates: no token → 401 from the API; a token without the console's actor → 401 from the console; a read-only role reads it like anyone
  assert.equal((await api("GET", `/api/ai/conversation?party_id=${partyId}`)).status, 401);
  assert.equal((await api("GET", `/api/ai/conversation?party_id=${partyId}`, undefined, { authorization: `Bearer ${TOKEN}` })).status, 401);
  assert.equal((await api("GET", "/api/ai/conversation", undefined, ops())).status, 400, "party_id or email is required");
  assert.equal((await api("GET", `/api/ai/conversation?party_id=${randomUUID()}`, undefined, ops())).status, 404);
  assert.equal((await api("GET", `/api/ai/conversation?email=nobody-${R}@example.test`, undefined, ops())).status, 404);

  // by party id: the thread in order, the cards, the turns — each turn showing the borrower text it answered and the reply it produced
  const byId = await api("GET", `/api/ai/conversation?party_id=${partyId}`, undefined, ops("examiner")); assert.equal(byId.status, 200, JSON.stringify(byId.body).slice(0, 300));
  const c = byId.body as { party: Json; conversation_id: string; messages: Json[]; cards: Json[]; turns: Json[] };
  assert.equal(c.party["party_id"], partyId); assert.equal(c.party["email_masked"], maskEmail(email)); assert.equal(c.party["email_masked"], `ca***`); assert.ok(c.conversation_id);
  const borrowerRow = c.messages.find((m) => m["sender"] === "borrower"); assert.ok(borrowerRow, "the borrower's message in the thread"); assert.equal(borrowerRow["body_text"], "how does this work?");
  const replyRow = c.messages.find((m) => m["message_id"] === reply["message_id"]); assert.ok(replyRow); assert.equal(replyRow["sender"], "agent"); assert.equal(replyRow["body_text"], REPLY); assert.equal((replyRow["copy_tokens"] as Json)["source"], "agent_turn");
  for (let k = 1; k < c.messages.length; k++) assert.ok(String(c.messages[k]!["at"]) >= String(c.messages[k - 1]!["at"]), "messages in order");
  assert.ok(c.cards.length >= 1, "the session's cards (the goal ChoiceCard at least)"); for (const card of c.cards) for (const f of ["card_instance_id", "kind", "copy_key", "status", "created_at"]) assert.ok(f in card, f);
  assert.ok(c.cards.some((x) => x["copy_key"] === "entry.goal.question" && x["kind"] === "ChoiceCard"));
  const turn = c.turns.find((t) => t["turn_id"] === turnId); assert.ok(turn, `the agent_turns row ${turnId} among ${c.turns.length}`);
  assert.equal(turn["message_id"], borrowerRow["message_id"]); assert.equal(turn["borrower_text"], "how does this work?");
  assert.equal(turn["reply_message_id"], reply["message_id"]); assert.equal(turn["reply_text"], REPLY);
  assert.equal(turn["model_version"], "scripted"); assert.equal(turn["prompt_version"], PROMPT_VERSION); assert.ok(Array.isArray(turn["tool_calls"])); assert.equal(typeof turn["guard_result"], "object");
  assert.equal(turn["tokens_in"], 7); assert.equal(turn["tokens_out"], 3); assert.equal(typeof turn["latency_ms"], "number"); assert.ok(turn["created_at"]);
  const first = c.turns.find((t) => t["message_id"] === null); assert.ok(first, "the session's first turn (no borrower text) is a turn too"); assert.equal(first["borrower_text"], null);
  for (let k = 1; k < c.turns.length; k++) assert.ok(String(c.turns[k]!["created_at"]) >= String(c.turns[k - 1]!["created_at"]), "turns in order");
  // by e-mail (the account's credential row, lowercased): the same trace
  const byEmail = await api("GET", `/api/ai/conversation?email=${encodeURIComponent(email.toUpperCase())}`, undefined, ops()); assert.equal(byEmail.status, 200, JSON.stringify(byEmail.body).slice(0, 300));
  assert.deepEqual(byEmail.body, byId.body);
  // the address lives only where the thread itself says it (the app's `{{party.first_name}}` falls back to the e-mail for a party with no name yet — the greeting's own body text); every field the console adds is masked
  assert.ok(!JSON.stringify(withoutText(byEmail.body)).includes(email), "outside the message bodies the trace never carries the address");

  // the recent listing across parties: newest first, the e-mail masked, the same join; the limit is honoured
  const recent = await api("GET", "/api/ai/conversation/recent?limit=20", undefined, ops()); assert.equal(recent.status, 200, JSON.stringify(recent.body).slice(0, 300));
  const turns = recent.body["turns"] as Json[]; assert.ok(turns.length >= 2 && turns.length <= 20, `${turns.length} turns`);
  const mine = turns.find((t) => t["turn_id"] === turnId); assert.ok(mine, "the turn in the cross-party listing");
  assert.equal(mine["party_id"], partyId); assert.equal(mine["conversation_id"], c.conversation_id); assert.equal(mine["email_masked"], "ca***"); assert.equal(mine["borrower_text"], "how does this work?"); assert.equal(mine["reply_text"], REPLY); assert.equal(mine["model_version"], "scripted");
  assert.ok(!JSON.stringify(withoutText(recent.body)).includes(email), "outside the message bodies the listing never carries the address");
  for (let k = 1; k < turns.length; k++) assert.ok(String(turns[k]!["created_at"]) <= String(turns[k - 1]!["created_at"]), "newest first");
  assert.equal(((await api("GET", "/api/ai/conversation/recent?limit=1", undefined, ops())).body["turns"] as Json[]).length, 1);
  // the access log names the reads (19.2) with the address masked
  const log = await db.query<{ purpose: string }>(`SELECT purpose FROM access_log WHERE table_name = 'ops_console' AND purpose LIKE '%/api/ai/conversation%' ORDER BY id`);
  assert.ok(log.length >= 6, `${log.length} console reads logged`); assert.ok(log.some((l) => /email=ca\*\*\*$/i.test(l.purpose)), `the e-mail lookup is logged masked (as typed, upper-cased): ${log.map((l) => l.purpose).join(" | ")}`); assert.ok(!log.some((l) => l.purpose.includes(email)), "never the address");
  assert.ok(scripted.requests.length >= 2, "the first turn and the message both ran on the scripted model");
});
