// 32.16 The conversational product: an account, then a conversation, with cards only when the rules need one
// spec/sections/32-borrower-experience/32-16-the-conversational-product-an-account-then-a-conversation-wi.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Phase 0 (docs/ux/17 §8.2 — the account; T25–T27) drives the real runtime over HTTP: POST /v1/borrower/auth/account (32.16 DELTA-29:
// e-mail + password, the e-mail code on the OTP code path, lockout, reset — src/runtime/borrower/routes.ts), Continue with Google through
// the FAKE provider (docs/ux/15 DELTA-12, unchanged), the 32.x flows reacting to the session (flows/3-entry.ts: the disclosure first, then
// the goal card on the organic application flows/14-entry-lead.ts `ensureOrganicApplication` opened for a party with no subject), and the
// fresh-L1 gate on a money command (auth.ts). The only test double is the FakeEdelivery the OTP path already uses (the code echoes as
// `fake_code` outside production). Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { toJson } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { connect, type Db } from "../../infra/db/client.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, ACCOUNT_PER_HOUR, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { OTP_MINUTES } from "../../runtime/borrower/auth.ts";
import { LOCKOUT_ATTEMPTS, LOCKOUT_MINUTES } from "../../infra/db/borrower-credentials.ts";
import { ensureOrganicApplication } from "../../runtime/borrower/flows/14-entry-lead.ts";
import { FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { FAKE_OIDC_MARKER, GOOGLE_ISSUERS, fakeOidcSubject, type FakeOidcIdentity } from "../../infra/integrations/oidc.ts";
import { Journey, MST, EDT } from "../../runtime/borrower/fixtures/journey.ts";
import { CARD_CASES, CHAT_TRIGGER, cardCaseOf, assertCardCase } from "../../runtime/borrower/flows/13-cross-cutting.ts";   // T28
import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { copyText } from "../../runtime/borrower/channels.ts";
import { LEAD_HEADER } from "../../runtime/borrower/lead-routes.ts";
import { THREAD_COPY_KEYS } from "../../runtime/borrower/copy-keys.ts";
import { buildContext, SYSTEM_PROMPT, PROMPT_VERSION, AGENT_TIER } from "../../runtime/borrower/agent/context.ts";
import { buildJourney } from "../../runtime/borrower/agent/journey.ts";
import { rulesFor, RULES_MAX_CHARS } from "../../runtime/borrower/agent/rules.ts";
import { MODEL_TOOLS_32_16, COMMAND_RUN_ALLOWLIST } from "../../app/tools/section32-16.ts";
import type { BorrowerRecord } from "../../runtime/borrower/record.ts";
import type { CardInstanceRow, MessageRow } from "../../infra/db/borrower-ui.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { COOPERATIVE_DU, HOSTILE } from "./eval/personas.ts";
import { agentTurnsAvailable, runPersona, runSuite, ensureAiVersion, writeEvaluation, SUITE_CODE } from "./eval/runner.ts";
import { GATED_CLASSES } from "./eval/checks.ts";
import { selectVersion, selectedVersion, versionRow, GovernanceRefused, writeDailyMetrics, evaluateKillSwitch, resetKillSwitch, KILL_SWITCH_FLAGS, TRANSFERS_PER_SESSION_BAND, AI_SYSTEM_CODE as CONVERSATION_SYSTEM } from "./eval/governance.ts";
import { evalDbReachable, openEvalHarness } from "./eval/harness.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
/** T21's eval harness drops and recreates its own database beside this suite's (…_eval). */
const EVAL_DB_URL = process.env["TEST_EVAL_DATABASE_URL"] ?? DB_URL.replace(/\/([^/]+)$/, "/$1_t21_eval");
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
const NOW = "2026-09-12T16:00:00.000Z";
const clock = new FixedClock(NOW);
type Json = Record<string, unknown>;
const DISCLOSURE = "{{copy:entry.disclosure.first}}";
/** The app's Google callback page under the allowed origin (the FAKE provider's authorization URL is this page carrying the FAKE code). */
const REDIRECT_URI = "http://localhost/app/auth/google/callback";

// ---------------------------------------------------------------- the scripted Messages API client (docs/ux/17 §8 Phase 1: no FakeLlm — the real AnthropicLlm loop over a client with the API's shape, as talk.test.ts does)
type Call = { name: string; input: Json };
type SceneCtx = { situation: Json; borrower: string; toolResults: Json[] };
/** A scene answers a borrower line: the tool calls first (one response), then the sentence on their results; `then` answers the guard's one regeneration. */
type Scene = { when: RegExp; calls?: Call[] | ((c: SceneCtx) => Call[]); text: string | ((c: SceneCtx) => string); then?: string };
/** The first turn of every account session (no borrower text): the model greets and asks the goal in its own words; a lead's facts are acknowledged, never `entry.resumed`. */
// the scripted model does what the prompt tells a real one: a name when the record has one, no name (never the e-mail) when it does not — an account made with an e-mail has none until the identity step
const named = (c: { situation: Json }): boolean => !!((c.situation["party"] as Json | undefined)?.["first_name"]);
const FIRST_TURN: Scene = { when: /just created their account/, text: (c) => (c.situation["lead_facts"] ? `Welcome${named(c) ? ", {{party.first_name}}" : ""} — I have what you told us so far, so let's pick up from there.` : `Hi${named(c) ? " {{party.first_name}}" : ""}. Are you looking to buy a home, lower your rate or payment, or take cash out?`) };
const RETURNING: Scene = { when: /the borrower is back/, text: (c) => `Welcome back${named(c) ? ", {{party.first_name}}" : ""}. The next thing I need from you is on the rail.` };
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
    if (content.startsWith("[guard]")) return text(scene?.then ?? "Let me put that another way: the next thing I need from you is on the rail.");
    const sit = /\[situation\]\n([\s\S]*?)\n\n\[borrower\]\n/.exec(content); const borrower = content.split("[borrower]\n")[1] ?? "";
    ctx = { situation: sit ? (JSON.parse(sit[1]!) as Json) : {}, borrower, toolResults: [] };
    scene = scenes.find((x) => x.when.test(borrower));
    if (!scene) return text("Okay — what would you like to do next?");
    const calls = typeof scene.calls === "function" ? scene.calls(ctx) : scene.calls;
    if (!calls?.length) { const t = scene.text; return text(typeof t === "function" ? t(ctx) : t); }
    return message(calls.map((c, i) => ({ type: "tool_use", id: `toolu_${i}_${randomUUID().slice(0, 6)}`, name: c.name, input: c.input }) as unknown as Anthropic.ContentBlock), "tool_use");
  };
  return { client: { messages: { create } } as unknown as Anthropic, requests, toolResults, use(next: Scene[]): void { scenes = [...next, FIRST_TURN, RETURNING]; } };   // a test's own scene wins over the defaults when both match
}
const scripted = scriptedClient();

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";

// ---------------------------------------------------------------- the shared setup (every Phase 0–4 T-id in this file drives the same server; T28's contract test reads
// `skip`, `db`, `runtime`, `router`, `base`, `TOKEN`, `clock`, `partnerPartyId` from here and keeps its other helpers local)
test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${R}`]))[0]!.id;
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|account|agent\.commit|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  // 32.14: open states, the partner's NMLSR ID and an active FAKE rate sheet (T7's published range); 32.16 DELTA-23: the agent turn on the scripted Messages API client (model "scripted") — every account session's first turn and every non-affirmative message run through it
  await seedEntryDemo(runtime, { partner_id: partnerPartyId, states: ["AZ", "CO"], now: NOW });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret", defaultPartnerId: partnerPartyId, llm: { client: scripted.client, model: "scripted" } });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
});
test.after(async () => { if (!skip) { await router.flows?.settle(); await close(); } });

// ---------------------------------------------------------------- helpers over the borrower API
type Reply = { status: number; body: Json };
/** Every request names its client IP (the proxy's x-forwarded-for) so the per-IP account throttle counts per test, not per file. */
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = "10.0.0.1"): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const account = (body: Json, ip?: string): Promise<Reply> => api("POST", "/v1/borrower/auth/account", body, {}, ip);
/** The flows' reactions and the agent's queued turns (the first turn after sign-up runs behind the session hooks) have run. */
const settle = async () => { await router.flows!.settle(); await router.agent?.settle(); await router.flows!.settle(); };
/** Create: the whole front door for an e-mail on file for no one — no code, the session body at once (docs/ux/17 §2.0). */
async function signUp(email: string, password: string, ip?: string): Promise<{ token: string; party_id: string; session_id: string; body: Json }> {
  const v = await account({ action: "create", email, password }, ip); assert.equal(v.status, 200, JSON.stringify(v.body)); assert.ok(v.body["token"], `a session, not a code: ${JSON.stringify(v.body)}`);
  await settle();
  return { token: v.body["token"] as string, party_id: (v.body["party"] as Json)["party_id"] as string, session_id: (v.body["session"] as Json)["session_id"] as string, body: v.body };
}
const thread = async (token: string): Promise<{ conversation_id: string; messages: Json[]; pinned_card: Json | null }> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, bearer(token)); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return r.body as { conversation_id: string; messages: Json[]; pinned_card: Json | null }; };
const me = async (token: string): Promise<Json> => { const r = await api("GET", "/v1/borrower/me", undefined, bearer(token)); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const credentialsOf = async (email: string) => (await db.query<{ party_id: string; email: string; password_hash: string; email_verified_at: string | null; failed_attempts: number; locked_until: string | null }>(`SELECT party_id, email, password_hash, email_verified_at, failed_attempts, locked_until FROM party_credentials WHERE email = $1`, [email.toLowerCase()]))[0];
const challengeOf = async (id: string) => (await db.query<{ challenge_id: string; kind: string; channel: string | null; destination: string | null; party_id: string | null; code_hash: string | null; delivery: string | null; attempts: number; consumed_at: string | null; expires_at: string }>(`SELECT challenge_id, kind, channel, destination, party_id, code_hash, delivery, attempts, consumed_at, expires_at FROM auth_challenges WHERE challenge_id = $1`, [id]))[0];
const challengesOf = (kind: string, partyId: string) => db.query<{ challenge_id: string; kind: string; channel: string | null; destination: string | null; consumed_at: string | null; created_at: string }>(`SELECT challenge_id, kind, channel, destination, consumed_at, created_at FROM auth_challenges WHERE kind = $1 AND party_id = $2 ORDER BY created_at`, [kind, partyId]);
const sessionsOf = (partyId: string) => db.query<{ session_id: string; level: string; auth_method: string; last_l1_at: string | null }>(`SELECT session_id, level, auth_method, last_l1_at FROM sessions WHERE party_id = $1 ORDER BY created_at`, [partyId]);
const partiesWithEmail = async (email: string): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM parties WHERE party_type = 'borrower' AND lower(contact->>'email') = lower($1)`, [email]))[0]!.n);
const applicationsOf = (partyId: string) => db.query<{ id: string; channel: string; transaction_type: string }>(`SELECT a.id, a.channel::text AS channel, a.transaction_type::text AS transaction_type FROM applications a JOIN application_borrowers ab ON ab.application_id = a.id WHERE ab.party_id = $1 ORDER BY a.created_at`, [partyId]);
const count = async (table: string): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`))[0]!.n);
const edelivery = (): FakeEdelivery => { const e = runtime.ports.edelivery; assert.ok(e instanceof FakeEdelivery, "the FAKE e-delivery adapter carries the codes under INTEGRATIONS=fake"); return e; };
/** The thread as Phase 0 promises it: the disclosure first, then the goal ChoiceCard (32.3 E2 then E3 on the organic application). */
function assertDisclosureThenGoal(t: { messages: Json[]; pinned_card: Json | null }): void {
  const agent = t.messages.filter((m) => m["sender"] === "agent" || m["sender"] === "system");
  assert.ok(agent.length >= 2, `at least the disclosure and the goal card (${agent.length} agent messages)`);
  assert.equal(agent[0]!["body_text"], DISCLOSURE, "the first assistant message of the session is entry.disclosure.first");
  assert.equal(agent[0]!["sender"], "system", "32.16 §2.0: the app's disclosure row is the session's `sender: system` record — the shell renders it as the header's AI tag, never a bubble");
  assert.equal(agent[0]!["channel"], "app");
  const goal = agent.find((m) => (m["card"] as Json | null)?.["copy_key"] === "entry.goal.question");
  assert.ok(goal, `the goal card follows the disclosure: ${JSON.stringify(agent.map((m) => [m["body_text"], (m["card"] as Json | null)?.["copy_key"]]))}`);
  assert.equal((goal["card"] as Json)["kind"], "ChoiceCard"); assert.equal((goal["card"] as Json)["status"], "pending");
  assert.ok(agent.indexOf(goal) > 0, "the disclosure precedes the goal card");
  assert.equal(t.pinned_card?.["copy_key"], "entry.goal.question", "the goal card is the pending ask");
}
// Continue with Google (docs/ux/15 DELTA-12; the FAKE provider): start → the authorization URL carrying the FAKE code and the state; callback with the FAKE marker
async function oidcStart(fake: FakeOidcIdentity): Promise<Reply & { code: string; state: string }> {
  const r = await api("POST", "/v1/borrower/auth/oidc", { action: "start", provider: "google", redirect_uri: REDIRECT_URI, fake });
  if (r.status !== 200) return { ...r, code: "", state: "" };
  const u = new URL(r.body["authorization_url"] as string);
  return { ...r, code: u.searchParams.get("code") ?? "", state: u.searchParams.get("state") ?? "" };
}
const oidcCallback = (code: string, oauthState: string): Promise<Reply> => api("POST", "/v1/borrower/auth/oidc", { action: "callback", provider: "google", code, state: oauthState }, { "x-fake-oidc": FAKE_OIDC_MARKER });
async function google(fake: FakeOidcIdentity): Promise<Reply & { state: string }> { const s = await oidcStart(fake); assert.equal(s.status, 200, JSON.stringify(s.body)); const r = await oidcCallback(s.code, s.state); await settle(); return { ...r, state: s.state }; }
const identityOf = async (sub: string) => (await db.query<{ party_id: string; issuer: string; subject: string; email: string | null; email_verified: boolean }>(`SELECT party_id, issuer, subject, email, email_verified FROM oidc_identities WHERE issuer = $1 AND subject = $2`, [GOOGLE_ISSUERS[0], sub]))[0];

// ---------------------------------------------------------------- Phase 1 (docs/ux/17 §8.3 — the turn, text only; T1–T10): the same server, the model scripted per test
const INTAKE_ACTOR = { kind: "agent" as const, id: "intake" };
type TurnRow = { turn_id: string; conversation_id: string; party_id: string; session_id: string | null; message_id: string | null; reply_message_id: string | null; channel: string; model_version: string; prompt_version: string; tier: string; context_hash: string; tool_calls: Json[]; safe_classification: string | null; guard_result: Json; latency_ms: number | null; tokens_in: number | null; tokens_out: number | null };
const turnsOf = (partyId: string) => db.query<TurnRow>(`SELECT turn_id, conversation_id, party_id, session_id, message_id, reply_message_id, channel, model_version, prompt_version, tier, context_hash, tool_calls, safe_classification, guard_result, latency_ms, tokens_in, tokens_out FROM agent_turns WHERE party_id = $1 ORDER BY created_at, turn_id`, [partyId]);
const message = async (token: string, text: string, subject?: Json): Promise<Reply & { reply: Json }> => { const r = await api("POST", "/v1/borrower/messages", { text, ...(subject ? { subject } : {}) }, bearer(token)); await settle(); return { ...r, reply: (r.body["reply"] as Json) ?? {} }; };
const eventsOf = (appId: string, type: string) => db.query<{ sequence: string; type: string; payload: Json; occurred_at: string }>(`SELECT sequence::text AS sequence, type, payload, occurred_at FROM loan_events WHERE application_id = $1 AND type = $2 ORDER BY loan_events.sequence`, [appId, type]);
const cardRow = async (id: string) => (await db.query<{ card_instance_id: string; kind: string; status: string; copy_key: string; props: Json; evidence: Json | null; misses: number }>(`SELECT card_instance_id, kind, status, copy_key, props, evidence, misses FROM card_instances WHERE card_instance_id = $1`, [id]))[0]!;
/** The session's next ask as the bus tool answers it (32.16 `session.next` as the intake agent, the API's facts on the input). */
const sessionNext = async (partyId: string, appId: string | null): Promise<Json> => (await runtime.execute({ process: "32.16", name: "session.next", loanId: "", ...(appId ? { applicationId: appId } : {}), actor: INTAKE_ACTOR, input: { party_id: partyId, subject: { application_id: appId, loan_id: null }, conversation_id: "", channel: "app", assurance_level: "L1" } })).output as Json;
/** Sign up, resolve the goal card (the 21.1 interview opens on the organic application), settle. */
async function signedUpWithGoal(tag: string, option: "buy" | "lower_rate" | "cash_out" = "lower_rate"): Promise<{ token: string; party_id: string; app_id: string; goal: Json }> {
  const a = await signUp(`${tag}-${R}@example.test`, `pw-${tag}-${R}`, `10.16.${Math.floor(Math.random() * 200) + 1}.1`); await settle();
  const t = await thread(a.token); const goal = t.pinned_card!; assert.equal(goal["copy_key"], "entry.goal.question");
  const g = await api("POST", `/v1/borrower/cards/${goal["card_instance_id"]}/resolve`, { option_id: option, evidence: { option_id: option, tapped_at: NOW } }, bearer(a.token)); assert.equal(g.status, 201, JSON.stringify(g.body)); await settle();
  const apps = await applicationsOf(a.party_id); assert.equal(apps.length, 1);
  return { token: a.token, party_id: a.party_id, app_id: apps[0]!.id, goal };
}
const placeholderKeys = ["thread.assistant_placeholder.intake", "thread.assistant_placeholder.servicing"];
// ---------------------------------------------------------------- Phase 3 (docs/ux/17 §8.5 — voice, DELTA-27; T17–T20): the in-app voice turn through the FAKE speech front end (src/runtime/borrower/voice.ts, agent/speech.ts)
/** One spoken utterance: the FAKE STT echoes the transcript and the confidence the test states (STT_FAKE_CONFIDENCE when none). */
const voice = async (token: string, transcript: string, extra: Json = {}): Promise<Reply & { utterance: Json; reply: Json }> => { const r = await api("POST", "/v1/borrower/voice/utterance", { transcript, ...extra }, bearer(token)); await settle(); return { ...r, utterance: (r.body["utterance"] as Json) ?? {}, reply: (r.body["reply"] as Json) ?? {} }; };
const cardEventsOf = (id: string) => db.query<{ from_status: string | null; to_status: string; actor: string; evidence: Json | null }>(`SELECT from_status, to_status, actor, evidence FROM card_instance_events WHERE card_instance_id = $1 ORDER BY created_at, at`, [id]);
const deepLinkOf = async (token: string) => (await db.query<{ target: Json; party_id: string }>(`SELECT target, party_id FROM deep_links WHERE token = $1`, [token]))[0];
const messageRow = async (id: string) => (await db.query<{ sender: string; channel: string; voice_turn: boolean; body_text: string | null; copy_tokens: Json | null; card_instance_id: string | null }>(`SELECT sender, channel, voice_turn, body_text, copy_tokens, card_instance_id FROM messages WHERE message_id = $1`, [id]))[0]!;
/** A 32.3 card as 3-entry's flows send it, on the party's application (the T4 pattern): the card's id, settled. */
async function sendCard(b: { party_id: string; app_id: string }, kind: string, copy_key: string, command_ref: string | null, props: Json, rationale: string): Promise<string> {
  const sent = await runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: b.app_id, actor: INTAKE_ACTOR, input: { party_id: b.party_id, kind, copy_key, command_ref, subject: { application_id: b.app_id, loan_id: null }, created_by: "agent:intake", props: { ...props, flow: "32.3" }, rationale } });
  await settle(); return (sent.output as { card_instance_id: string }).card_instance_id;
}
/** The pending card with this copy key as the scripted model sees it in the situation. */
const pendingIdOf = (c: { situation: Json }, copyKey: string): string => String((((c.situation["pending_cards"] as Json[]) ?? []).find((x) => x["copy_key"] === copyKey))?.["card_instance_id"] ?? "");
/** The SSN ConfirmCard exactly as 3-entry's afterIdentity sends it (masked, typed once, never echoed). */
const SSN_PROPS: Json = { title: "", fields: [{ path: "ssn", label: "Social Security number", value: "", source: "borrower" }], commits_to: "application_borrowers", masked_paths: ["ssn"], required_paths: ["ssn"], helper_copy_key: "identity.ssn.why", gate: "FNMA_B2_2_01_SSN_VALIDATION_GATE", command_args: { path: "ssn", source: "borrower" } };
/** The refinance home ConfirmCard as afterIdentity sends it: the address the scan read (empty here — the borrower states it), the property facts from public records, the occupancy as the borrower's own answer. */
const HOME_PROPS: Json = { title: "", fields: [{ path: "property_address", label: "Property address", value: "", source: "borrower" }, { path: "property_type", label: "Property type", value: "sfr", source: "public_records" }, { path: "units", label: "Units", value: "1", source: "public_records" }, { path: "occupancy", label: "Your primary home", value: "primary", source: "borrower" }], commits_to: "application_properties", command_args: { path: "property_address", commits_to: "application_properties" } };
const HOME_ADDRESS = "100 N Central Ave, Phoenix, AZ 85004";

test("32.16-T1: Given a borrower message that is not an affirmative, not a flow reply and not \"human\", then the reply is produced by the agent turn (an `agent_turns` row exists with `model_version`, `prompt_version`, `context_hash`) and no placeholder copy key is used.", { skip }, async () => {
  scripted.use([{ when: /how does this work/i, text: "It goes like this: we confirm a few facts about you and the home, connect your income, then price it. What are you hoping to do — buy, lower the payment, or take cash out?" }]);
  const a = await signUp(`t1-${R}@example.test`, `pw-t1-${R}`, "10.16.1.1"); await settle();
  // the first turn of the session (§2.0): the model greeted in its own words after the disclosure row and the goal card — no placeholder, no entry.resumed
  const t0 = await thread(a.token); assertDisclosureThenGoal(t0);
  const greetings = t0.messages.filter((m) => m["sender"] === "agent" && (m["copy_tokens"] as Json | null)?.["source"] === "agent_turn");
  assert.equal(greetings.length, 1, "one first turn"); assert.match(String(greetings[0]!["body_text"]), /^Hi(?: [A-Z][a-z]+)?\. Are you looking to buy a home/); assert.doesNotMatch(String(greetings[0]!["body_text"]), /@/, "never the e-mail as a name"); assert.doesNotMatch(String(greetings[0]!["body_text"]), /\{\{/);
  assert.equal(t0.messages.filter((m) => String(m["body_text"] ?? "").startsWith("{{copy:entry.resumed")).length, 0, "the turn posts no entry.resumed");
  // a plain question: not an affirmative, not a flow reply, not "human" → the agent turn answers in the placeholder's slot
  const r = await message(a.token, "how does this work?");
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["routed_to"], "intake"); assert.equal(r.body["command_executed"], false);
  const reply = r.reply; assert.equal(reply["sender"], "agent"); assert.match(String(reply["body_text"]), /^It goes like this/); assert.doesNotMatch(String(reply["body_text"]), /\{\{copy:/);
  assert.ok(!placeholderKeys.includes(String(reply["copy_key"])), `no placeholder copy key: ${reply["copy_key"]}`);
  const tokens = reply["copy_tokens"] as Json; assert.equal(tokens["source"], "agent_turn"); assert.match(String(tokens["turn_id"]), /^[0-9a-f-]{36}$/);
  // the agent_turns row: the model and prompt versions, the context hash, the message it answered and the reply it appended
  const rows = await turnsOf(a.party_id); const row = rows.find((x) => x.turn_id === tokens["turn_id"]); assert.ok(row, "an agent_turns row for the turn");
  assert.equal(row.model_version, "scripted"); assert.equal(row.prompt_version, PROMPT_VERSION); assert.match(row.context_hash, /^[0-9a-f]{64}$/); assert.equal(row.tier, AGENT_TIER); assert.equal(row.channel, "app");
  assert.equal(row.message_id, (r.body["message"] as Json)["message_id"]); assert.equal(row.reply_message_id, reply["message_id"]); assert.equal(row.session_id, (await sessionsOf(a.party_id))[0]!.session_id);
  assert.equal((row.guard_result as Json)["ok"], true); assert.ok(typeof row.tokens_in === "number" && typeof row.tokens_out === "number");
  assert.equal(rows.filter((x) => x.message_id === null).length, 1, "the first turn's row (no borrower message)");
  // what the model saw: the stable system prompt as the cached prefix, the nine 32.16 tools by their model names, the situation in the user turn
  const req = scripted.requests.at(-1)!;
  assert.deepEqual(req.system, [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]); assert.equal(req.model, "scripted");
  assert.deepEqual((req.tools ?? []).map((x) => (x as { name: string }).name), MODEL_TOOLS_32_16.map((t) => t.model_name));
  assert.deepEqual(MODEL_TOOLS_32_16.map((t) => t.name), ["session.next", "journey.get", "record.get", "explain", "timer.due", "document.describe", "card.propose", "card.request", "command.run", "human.transfer"]);
  assert.match(String(req.messages.at(-1)!.content), /\[situation\][\s\S]*"session_next"[\s\S]*\[borrower\]\nhow does this work\?/);
});
test("32.16-T2: Given any turn, then its context contains no DU message, credit report field, findings text, fraud/QC entity or vendor payload (contract test over `context.ts`).", async () => {
  // the contract: context.ts projects borrower_record, the cards, the messages and the lead's facts through allow-lists — a record row or card that carries DU, credit, findings, fraud/QC or vendor content (as an owning table might) never reaches the model
  const junk = { du: "DU RECOMMENDATION Approve/Eligible — Refer with Caution", credit: "FICO 742 EFX tradeline BOFA balance 412000", findings: "Findings: verify the large deposit of 25000 (SIFI)", fraud: "fraud alert FRD-77 / QC finding QCF-9", vendor: "truv-report-payload-XYZ-8891" };
  const cardId = randomUUID(); const now = NOW;
  const record: BorrowerRecord = {
    subject: { application_id: randomUUID(), loan_id: null, label: "14 Elm St", transaction_type: "limited_cash_out", occupancy: "primary", stage: "origination" },
    status: { badge: "in_review", state_source: "du", one_liner: `Underwriting says: ${junk.du}` }, read_only: false,
    next: { label: "Loan Estimate", due_at: "2026-09-15T21:00:00.000Z", timer_code: "REGZ_1026_19E1_LE_3BD", calendar_note: "business days" },
    needed_from_you: [{ item_id: "n1", kind: "confirmation", label: "Confirm your income", due_at: "2026-09-14T00:00:00.000Z", card_instance_id: cardId, created_at: now, source: "card" }],
    what_we_are_doing: [{ item_id: "d1", kind: "condition", label: "Title commitment", owner: "title_company", owner_copy_key: "needs.owner.title_company", status: "open", source: "conditions", created_at: now }],
    needed_summary: { count: 1, nothing_needed: false, copy_key: "needs.title" },
    numbers: { note_rate: "6.125", apr: "6.301", pi_payment_cents: "340262", loan_amount_cents: "56000000", du_message: junk.du, credit_report: { score: 742, text: junk.credit }, findings_text: junk.findings },
    dates: [{ timer_code: "REGZ_1026_19E1_LE_3BD", label: "Loan Estimate", due_at: "2026-09-15T21:00:00.000Z", calendar: "business", status: "armed" }],
    documents: [{ document_id: randomUUID(), doc_class: "du_findings", status: "received", title: "Findings 2026-09-11", findings_text: junk.findings, vendor_payload: { raw: junk.vendor } }],
    people: [{ role: "underwriter", name: "Uma Writer", notes: junk.fraud }, { role: "mlo_of_record", name: "Mo Officer", nmlsr_id: "987654" }],
    property: { address: "14 Elm St, Phoenix, AZ 85018", state: "AZ", property_type: "sfr", avm: { value_cents: "55000000", vendor: junk.vendor } }, loan: null, offers: [], as_of: now, journey_progress: { steps: [], done: 0, total: 0 } } as unknown as BorrowerRecord;
  const card = { card_instance_id: cardId, conversation_id: randomUUID(), party_id: randomUUID(), subject_application_id: record.subject.application_id, subject_loan_id: null, kind: "ConfirmCard", status: "pending", created_by: "agent:intake", copy_key: "income.confirm.title", command_ref: "application.confirmField", expires_at: null, created_at: now, resolved_at: null,
    props: { fields: [{ path: "employer", label: "Employer", value: "Acme Corp", source: "payroll_connection" }, { path: "monthly_base_cents", label: "Monthly base pay", value: "820000", source: "payroll_connection" }], money_paths: ["monthly_base_cents"], report: { vendor: junk.vendor, employer: "Acme Corp" }, du_readiness: junk.du }, evidence: { report: { raw: junk.vendor }, fraud_check: junk.fraud }, misses: 1 } as unknown as CardInstanceRow;
  const messages = [{ message_id: randomUUID(), conversation_id: card.conversation_id, at: now, sender: "system", sender_ref: "agent:intake", channel: "app", body_text: "{{copy:entry.disclosure.first}}", card_instance_id: null, subject_application_id: null, subject_loan_id: null, external_ref: null, voice_turn: false, created_at: now, copy_tokens: null }, { message_id: randomUUID(), conversation_id: card.conversation_id, at: now, sender: "borrower", sender_ref: "party:x", channel: "app", body_text: "what's next?", card_instance_id: null, subject_application_id: null, subject_loan_id: null, external_ref: null, voice_turn: false, created_at: now, copy_tokens: null }] as unknown as MessageRow[];
  const lead = { lead_id: randomUUID(), transaction_intent: "limited_cash_out", occupancy: "primary", consumer_state: "AZ", value_estimate_cents: "45000000", soft_pull_report: { representative_score: 742, text: junk.credit }, du: junk.du };
  const ctx = buildContext({ partyFirstName: "Jane", level: "L2", channel: "app", routed_to: "intake", safeMode: "assisted", partnerName: "Partner Bank", record, cards: [card], messages, lead, next: { step: "card", card_instance_id: cardId, kind: "ConfirmCard", copy_key: "income.confirm.title", why_copy_key: null, allowed_answers: [], disallowed_topics: [], blocking_reason: null, waiting_on: [] }, borrowerText: "what's next?" });
  const all = ctx.system + "\n" + ctx.situation;
  for (const [what, text] of Object.entries(junk)) assert.ok(!all.includes(text), `${what} reached the context: ${text}`);
  for (const needle of ["742", "6.125", "340262", "$3,402.62", "Uma Writer", "Mo Officer", "987654", "14 Elm St", "Acme Corp", "820000", "vendor_payload", "findings_text", "du_message", "credit_report", "du_readiness", "fraud_check", "soft_pull_report", "avm"]) assert.ok(!all.includes(needle), `"${needle}" reached the context`);
  // what does reach it: the figures, dates and names as tokens the API fills after the guard; the ask's paths; the lead's facts
  for (const token of ["{{numbers.rate}}", "{{numbers.apr}}", "{{numbers.pi_payment}}", "{{dates.REGZ_1026_19E1_LE_3BD}}", "{{people.underwriter.name}}", "{{property.address}}", "{{lead.home_value}}", "{{status.one_liner}}"]) assert.ok(all.includes(token), `${token} in the context`);
  assert.equal(ctx.tokens["numbers.rate"], "6.125%"); assert.equal(ctx.tokens["numbers.pi_payment"], "$3,402.62"); assert.equal(ctx.tokens["people.underwriter.name"], "Uma Writer"); assert.equal(ctx.tokens["lead.home_value"], "$450,000.00"); assert.equal(ctx.tokens["party.first_name"], "Jane");
  assert.ok(ctx.situation.includes('"monthly_base_cents"') && ctx.situation.includes("{{card."), "the card's paths, its values as tokens"); assert.ok(ctx.situation.includes('"misses": 1'));
  assert.match(ctx.hash, /^[0-9a-f]{64}$/); assert.equal(ctx.hash, buildContext({ partyFirstName: "Jane", level: "L2", channel: "app", routed_to: "intake", safeMode: "assisted", partnerName: "Partner Bank", record, cards: [card], messages, lead, next: { step: "card", card_instance_id: cardId, kind: "ConfirmCard", copy_key: "income.confirm.title", why_copy_key: null, allowed_answers: [], disallowed_topics: [], blocking_reason: null, waiting_on: [] }, borrowerText: "what's next?" }).hash, "the same situation hashes the same (nothing carried between turns)");
  // structurally: context.ts imports no DU, credit, fraud, QC or vendor module and reads no table — it can only project what it is handed
  const src = readFileSync(new URL("../../runtime/borrower/agent/context.ts", import.meta.url), "utf8");
  const imports = src.split("\n").filter((l) => /^import /.test(l)); assert.ok(imports.length >= 2);
  for (const l of imports) assert.doesNotMatch(l, /\b(du|desktop|credit|fraud|qc|verification|vendor|integrations|underwriting|findings)\b/i, l);
  assert.doesNotMatch(src, /\bquery\(|\bSELECT\b|\bexecute\(|process\.env/, "no table, no bus, no environment");
});
test("32.16-T3: Given the model's tool calls in a turn, then each is a 32.16 bus tool with an `agent_decisions` row, and a call outside the contract (e.g. `payment.makeOneTime`) is refused by the bus with `command.refused` and never executed.", { skip }, async () => {
  const b = await signedUpWithGoal("t3");
  scripted.use([{ when: /pay my mortgage from checking/i, calls: [{ name: "command_run", input: { name: "payment.makeOneTime", args: { amount_cents: "100000", date: "2026-09-14" } } }, { name: "session_next", input: {} }, { name: "record_get", input: {} }], text: "I can't move money from here; a payment is a card on the rail and needs a fresh code. Right now the next thing is on the rail." }]);
  const refusedBefore = (await eventsOf(b.app_id, "command.refused")).length;
  const r = await message(b.token, "pay my mortgage from checking please");
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(String(r.reply["body_text"]), /^I can't move money/);
  const row = (await turnsOf(b.party_id)).find((x) => x.turn_id === (r.reply["copy_tokens"] as Json)["turn_id"])!;
  assert.deepEqual(row.tool_calls.map((c) => [c["name"], c["is_error"]]), [["command.run", true], ["session.next", false], ["record.get", false]]);
  // the call outside the contract: refused by the bus before anything ran — command.refused on the record, no decision row, the refusal read back to the model as a tool error
  const refused = row.tool_calls[0]!; assert.deepEqual(refused["refused"], { code: "COMMAND_OUTSIDE_CONTRACT", event: "command.refused" }); assert.equal(refused["decision_id"], null); assert.match(String(refused["args_hash"]), /^[0-9a-f]{64}$/);
  const refusals = (await eventsOf(b.app_id, "command.refused")).slice(refusedBefore); assert.equal(refusals.length, 1, "one command.refused for the turn");
  assert.equal(refusals[0]!.payload["command"], "command.run"); assert.equal(refusals[0]!.payload["code"], "COMMAND_OUTSIDE_CONTRACT"); assert.equal(refusals[0]!.payload["attempted"], "payment.makeOneTime"); assert.equal(refusals[0]!.payload["tool"], "command.run");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE application_id = $1 AND type LIKE 'payment.%'`, [b.app_id]))[0]!.n, "0", "never executed");
  const seen = scripted.toolResults.find((x) => x["error"] === "COMMAND_OUTSIDE_CONTRACT"); assert.ok(seen, "the model read the refusal"); assert.equal(seen["refused"], true);
  assert.ok(!COMMAND_RUN_ALLOWLIST.includes("payment.makeOneTime")); assert.deepEqual([...COMMAND_RUN_ALLOWLIST], ["human.request", "refi.request", "case.open", "callback.schedule", "preference.set", "contact.log", "dispute.intake", "promise.record"]);
  // the calls inside the contract: each a 32.16 bus command as the intake agent with its agent_decisions row carrying the turn's model and prompt versions
  for (const c of row.tool_calls.slice(1)) {
    assert.match(String(c["decision_id"]), /^[0-9a-f-]{36}$/, `${c["name"]} has a decision id`);
    const d = (await db.query<{ agent: string; action: string; model_version: string | null; prompt_version: string | null; rule_set_version: string; rationale: string }>(`SELECT agent, action, model_version, prompt_version, rule_set_version, rationale FROM agent_decisions WHERE id = $1`, [c["decision_id"]]))[0];
    assert.ok(d, `agent_decisions row for ${c["name"]}`); assert.equal(d.agent, "intake"); assert.equal(d.action, `agent.tool:${c["name"]}`); assert.equal(d.model_version, "scripted"); assert.equal(d.prompt_version, PROMPT_VERSION); assert.equal(d.rule_set_version, "32.16@tools.v1"); assert.match(d.rationale, /party_id=/);
  }
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE application_id = $1 AND type = 'command.executed' AND payload->>'process' = '32.16' AND payload->>'run_id' = $2`, [b.app_id, `turn:${row.turn_id}`]))[0]!.n, "2", "two commands executed on the bus for the turn");
  // the record.get the model read carries no figure — tokens only (the API holds their values)
  const rec = scripted.toolResults.find((x) => x["record"]) as Json; assert.ok(rec); assert.equal(rec["tokens"], undefined, "the tokens never reach the model");
  const view = rec["record"] as Json; for (const v of Object.values((view["numbers"] as Json | null) ?? {})) assert.match(String(v), /^\{\{numbers\./); for (const d of view["dates"] as Json[]) assert.match(String(d["due_at"]), /^\{\{dates\./); if (view["next"]) assert.equal((view["next"] as Json)["due_at"], "{{next.due_at}}"); assert.equal((view["status"] as Json)["one_liner"], "{{status.one_liner}}");
});
test("32.16-T4: Given \"eight thousand two hundred a month\" with the R3 income card pending, then `card_instances.props.proposal.fields[0] = {path: \"monthly_income\", value: \"820000\", source: \"borrower_stated_unconfirmed\"}` and the turn writes it (32.17 rule 21): the card resolves with `evidence.source = borrower_stated` and `committed_by = turn`, `application_income` gains the row, the reply refers to the written card as a receipt and no Confirm is asked for; \"make that eighty-five hundred\" rewrites the same card to 850000 with `card_rewritten` logged.", { skip }, async () => {
  const b = await signedUpWithGoal("t4");
  // R3's "type it in" income card (the ConnectCard's fallback): the one typed field, in cents, committed to application_income on Confirm
  const sent = await runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: b.app_id, actor: INTAKE_ACTOR, input: { party_id: b.party_id, kind: "ConfirmCard", copy_key: "income.confirm.title", command_ref: "application.confirmField", subject: { application_id: b.app_id, loan_id: null }, created_by: "agent:intake",
    props: { title: "", fields: [{ path: "monthly_income", label: "Monthly income", value: "", source: "borrower" }], commits_to: "application_income", money_paths: ["monthly_income"], required_paths: ["monthly_income"], flow_key: `income.typed:${b.app_id}`, flow: "32.3", statement: "This becomes the income you're stating on your application.", command_args: { path: "income", commits_to: "application_income" } }, rationale: "32.3 R3 type it in" } });
  const cardId = (sent.output as { card_instance_id: string }).card_instance_id; await settle();
  const incomeRows = async () => db.query<{ monthly_amount_cents: string; source_kind: string; calculation: Json }>(`SELECT monthly_amount_cents::text AS monthly_amount_cents, source_kind, calculation FROM application_income WHERE application_id = $1 ORDER BY created_at`, [b.app_id]);
  const before = await incomeRows();
  const incomeCardId = (c: { situation: Json }): string => String((((c.situation["pending_cards"] as Json[]) ?? []).find((x) => x["copy_key"] === "income.confirm.title") ?? ((c.situation["written_this_call"] as Json[]) ?? []).find((x) => x["copy_key"] === "income.confirm.title"))?.["card_instance_id"] ?? "");
  scripted.use([
    { when: /eight thousand two hundred a month/i, calls: (c) => [{ name: "card_propose", input: { card_instance_id: incomeCardId(c), fields: [{ path: "monthly_income", value: "820000" }] } }], text: "I heard {{proposal.monthly_income}} a month — that's saved; say if it's not right." },
    { when: /eighty[- ]five hundred/i, calls: (c) => [{ name: "card_propose", input: { card_instance_id: incomeCardId(c), fields: [{ path: "monthly_income", value: "850000" }] } }], text: "Changed to {{proposal.monthly_income}} a month — that is saved; say if it is still not right." },
  ]);
  const r = await message(b.token, "eight thousand two hundred a month");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // the proposal on the card and, the same turn, the write (32.17 rule 21): the card resolved by the turn, the income row landed, no tap anywhere
  const card = await cardRow(cardId); assert.equal(card.status, "resolved", "the turn wrote it"); const proposal = card.props["proposal"] as Json;
  assert.deepEqual((proposal["fields"] as Json[])[0], { path: "monthly_income", value: "820000", source: "borrower_stated_unconfirmed" });
  assert.equal(proposal["utterance_message_id"], (r.body["message"] as Json)["message_id"]); assert.equal(proposal["proposed_at"], NOW); assert.equal(card.misses, 0);
  assert.equal(card.evidence!["source"], "borrower_stated"); assert.equal(card.evidence!["committed_by"], "turn");
  const after = await incomeRows(); assert.equal(after.length, before.length + 1); assert.equal(after.at(-1)!.monthly_amount_cents, "820000"); assert.equal(after.at(-1)!.source_kind, "base"); assert.equal((after.at(-1)!.calculation as Json)["source"], "borrower");
  assert.equal((await eventsOf(b.app_id, "card.proposed")).length, 1); assert.equal((await eventsOf(b.app_id, "application.six_item.captured")).filter((e) => e.payload["item"] === "income").length, 1, "the six-item income counts when stated (21.2)");
  // the thread: the reply is the read-back with the figure filled from the proposal, referring to the written card — the receipt, never a Confirm
  assert.equal(r.reply["body_text"], "I heard $8,200.00 a month — that's saved; say if it's not right."); assert.equal(r.reply["card_instance_id"], cardId);
  const t = await thread(b.token); const chip = t.messages.find((m) => m["message_id"] === r.reply["message_id"])!; assert.equal((chip["card"] as Json)["card_instance_id"], cardId); assert.equal((chip["card"] as Json)["status"], "resolved", "the receipt of a written fact");
  const row = (await turnsOf(b.party_id)).find((x) => x.turn_id === (r.reply["copy_tokens"] as Json)["turn_id"])!; assert.equal(row.safe_classification, "data_capture"); assert.equal((row.guard_result as Json)["proposed_card_instance_id"], cardId);
  // a correction in words rewrites the same card (rule 21): the command runs again, the card stays resolved, card_rewritten is logged
  const r2 = await message(b.token, "make that eighty-five hundred"); assert.equal(r2.status, 200, JSON.stringify(r2.body)); await settle();
  assert.equal(r2.reply["body_text"], "Changed to $8,500.00 a month — that is saved; say if it is still not right.", `the correction's reply: ${JSON.stringify(r2.reply["copy_tokens"])}; turn: ${JSON.stringify((await turnsOf(b.party_id)).find((x) => x.turn_id === (r2.reply["copy_tokens"] as Json)["turn_id"])?.tool_calls)}`);
  const again = await cardRow(cardId); assert.equal(again.status, "resolved"); assert.equal(again.evidence!["rewrites"], 1, JSON.stringify(again.evidence)); assert.equal(((again.props["proposal"] as Json)["fields"] as Json[])[0]!["value"], "850000");
  const after2 = await incomeRows(); assert.equal(after2.at(-1)!.monthly_amount_cents, "850000");
  assert.equal((await db.query(`SELECT 1 FROM ui_events WHERE card_instance_id = $1 AND kind = 'card_rewritten'`, [cardId])).length, 1, "card_rewritten logged");
});

test("32.16-T5: Given a model turn containing \"your rate is 6.125%\", then the guard rejects it, the regenerated turn uses `{{numbers.rate}}`, and the rendered message shows the projection's rate.", { skip }, async () => {
  const email = `t5-${R}@example.test`; const a = await signUp(email, `pw-t5-${R}`, "10.16.5.1"); await settle();
  // a serviced loan on the account's party (the journey fixture's book): the record's numbers carry the note rate
  const journey = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: email, coBorrowerEmail: `t5-co-${R}@example.test`, partnerPartyId });
  await journey.seedBook(); const loanId = await journey.adoptPriorLoan(a.party_id, { legal_name: email }); await settle();
  const rec = await api("GET", `/v1/borrower/record?subject=${loanId}`, undefined, bearer(a.token)); assert.equal(rec.status, 200, JSON.stringify(rec.body).slice(0, 300));
  const noteRate = String((rec.body["numbers"] as Json)["note_rate"]); assert.match(noteRate, /^\d+\.\d{3}$/);
  scripted.use([{ when: /what is my rate/i, text: "Your rate is 6.125% and your payment is $3,402.62 a month.", then: "Your current rate is {{numbers.rate}}, the same figure your note shows." }]);
  const r = await message(a.token, "what is my rate?", { loan_id: loanId });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["routed_to"], "borrower-comms");
  // the guard rejected the raw figures, the regenerated turn wrote the token, the rendered message shows the projection's rate — the sentence never reached the thread
  assert.equal(r.reply["body_text"], `Your current rate is ${noteRate}%, the same figure your note shows.`);   // a real sentence: the guard's substance check (7) refuses a regeneration under MIN_REPLY_WORDS assert.doesNotMatch(String(r.reply["body_text"]), /6\.125|3,402/);
  const rows = (await turnsOf(a.party_id)).filter((x) => x.message_id === (r.body["message"] as Json)["message_id"]).sort((x, y) => Number((x.guard_result as Json)["attempt"]) - Number((y.guard_result as Json)["attempt"])); assert.equal(rows.length, 2, "the rejected attempt and the accepted one are both rows");
  const rejected = rows[0]!; assert.equal(rejected.reply_message_id, null); assert.equal((rejected.guard_result as Json)["ok"], false); assert.equal((rejected.guard_result as Json)["rejected_by"], "provenance"); assert.match(String((rejected.guard_result as Json)["violation"]), /6\.125%/);
  const accepted = rows[1]!; assert.equal(accepted.reply_message_id, r.reply["message_id"]); assert.equal((accepted.guard_result as Json)["ok"], true); assert.equal((accepted.guard_result as Json)["attempt"], 2);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM messages WHERE conversation_id = $1 AND body_text LIKE '%6.125%'`, [accepted.conversation_id]))[0]!.n, "0");
  const regen = scripted.requests.at(-1)!; assert.match(String(regen.messages.at(-1)!.content), /^\[guard\]\nYour reply was not sent: a raw figure "6\.125%"/);
});
test("32.16-T6: Given `ai_intake_mode = assisted` and no `mlo.review.completed`, when the turn is classified `particular_terms_presented`, then it is refused, `logSafeActivity` records it, and the reply is the step's default copy.", { skip }, async () => {
  const b = await signedUpWithGoal("t6");
  assert.equal((await db.query<{ value: unknown }>(`SELECT value FROM feature_flags WHERE key = 'origination.ai_mlo_intake'`))[0]?.value, "assisted");
  assert.equal((await eventsOf(b.app_id, "mlo.review.completed")).length, 0);
  const next = await sessionNext(b.party_id, b.app_id); assert.equal(next["step"], "card"); const stepKey = String(next["copy_key"]);
  scripted.use([{ when: /what rate can you give me/i, text: "We can offer you a rate below what you pay today, and the payment would drop.", then: "We can offer you a rate below what you pay today." }]);
  const r = await message(b.token, "what rate can you give me?");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // refused as particular terms (no regeneration — the step's default copy), logged by 21.1 as a blocked utterance under the assisted flag
  assert.equal(r.reply["body_text"], `{{copy:${stepKey}}}`); assert.equal(r.reply["copy_key"], stepKey); assert.ok(!placeholderKeys.includes(stepKey));
  const tokens = r.reply["copy_tokens"] as Json; assert.equal(tokens["source"], "agent_turn"); assert.equal(tokens["fallback"], "default_copy"); assert.equal(tokens["rejected_by"], "safe");
  const row = (await turnsOf(b.party_id)).find((x) => x.turn_id === tokens["turn_id"])!; assert.equal(row.safe_classification, "particular_terms_presented");
  const g = row.guard_result as Json; assert.equal(g["ok"], false); assert.equal(g["rejected_by"], "safe"); assert.equal(((g["checks"] as Json)["safe"] as Json)["ok"], false); assert.equal(g["attempt"], 1);
  const blocked = await eventsOf(b.app_id, "interview.utterance.blocked"); assert.equal(blocked.length, 1, "logSafeActivity recorded the blocked utterance");
  assert.equal(blocked[0]!.payload["classification"], "particular_terms_presented"); assert.equal(blocked[0]!.payload["flag_mode"], "assisted"); assert.equal(blocked[0]!.payload["utterance_id"], row.turn_id); assert.equal(blocked[0]!.payload["gate"], "SAFE_1008_103_MLO_OF_RECORD_GATE");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM messages WHERE conversation_id = $1 AND body_text LIKE '%offer you a rate%'`, [row.conversation_id]))[0]!.n, "0", "the sentence never reached the thread");
});
test("32.16-T7: Given a turn in which the model shows rates, then the reply carries a rates element (`messages.copy_tokens.element = \"rates\"` with the 20.3 range: product, low and high rates each with its APR, the lender and its NMLSR ID) and the model's own sentence restates none of its figures; given a turn whose reply is a copy-library template verbatim, then the guard rejects it and the regenerated reply is the model's own words.", { skip }, async () => {
  // a lead on the cookie with the goal, the occupancy and the state (the chips), then the account: the lead's facts ride into the first turn's context, and the published range prices against it
  const started = await api("POST", "/v1/borrower/lead", { action: "start", channel: "web_chat" }, {}, "10.16.7.1"); assert.equal(started.status, 200, JSON.stringify(started.body));
  const withLead = { [LEAD_HEADER]: started.body["lead_token"] as string };
  for (const [step, value] of [["goal", "lower_rate"], ["occupancy", "primary"], ["state", "AZ"]] as const) { const x = await api("POST", "/v1/borrower/lead", { action: "answer", step, value }, withLead, "10.16.7.1"); assert.equal(x.status, 200, `${step}: ${JSON.stringify(x.body)}`); }
  const created = await api("POST", "/v1/borrower/auth/account", { action: "create", email: `t7-${R}@example.test`, password: `pw-t7-${R}` }, withLead, "10.16.7.1"); assert.equal(created.status, 200, JSON.stringify(created.body)); await settle();
  const token = created.body["token"] as string; const partyId = (created.body["party"] as Json)["party_id"] as string; const appId = (await applicationsOf(partyId))[0]!.id;
  const first = (await thread(token)).messages.find((m) => m["sender"] === "agent" && (m["copy_tokens"] as Json | null)?.["source"] === "agent_turn")!; assert.match(String(first["body_text"]), /^Welcome(?:, [A-Z][a-z]+)? — I have what you told us so far/, "the lead's facts acknowledged in the model's words");
  // (i) rates: the model calls explain{rates}; the API renders the checked range as the rates element before the reply; the sentence restates no figure
  scripted.use([{ when: /what are rates today/i, calls: [{ name: "explain", input: { topic: "rates" } }], text: "Today's published rates are shown here, with the APR beside each. They depend on credit and the loan size, so the exact rate comes after a soft credit check." }]);
  const r = await message(token, "what are rates today?");
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.doesNotMatch(String(r.reply["body_text"]), /\d/, "no figure in the model's sentence");
  const t = await thread(token); const at = t.messages.findIndex((m) => m["message_id"] === r.reply["message_id"]); assert.ok(at > 0);
  const element = t.messages[at - 1]!; assert.equal(element["sender"], "system"); assert.equal(element["body_text"], null);
  const el = element["copy_tokens"] as Json; assert.equal(el["element"], "rates");
  for (const k of ["low_rate", "low_apr", "high_rate", "high_apr"]) assert.match(String(el[k]), /^\d\.\d{3}$/, `${k}: ${el[k]}`);
  assert.ok(Number(el["low_rate"]) <= Number(el["high_rate"])); assert.ok(Number(el["low_apr"]) >= Number(el["low_rate"]), "the APR beside each rate is at least the rate");
  assert.match(String(el["product"]), /30/); assert.equal(el["nmlsr_id"], "123456"); assert.ok(String(el["lender"]).length > 0); assert.ok(String(el["rate_sheet_id"]).length > 0); assert.equal(el["as_of"], NOW);
  for (const f of [el["low_rate"], el["high_rate"], el["low_apr"], el["high_apr"]]) assert.ok(!String(r.reply["body_text"]).includes(String(f)));
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'lead.range.shown' AND (application_id::text = $1 OR payload->>'lead_id' = $1 OR (aggregate_kind = 'lead' AND aggregate_id::text = $1))`, [appId]))[0]!.n, "1", "20.3's checked range shown (lead.range.shown)");
  const row = (await turnsOf(partyId)).find((x) => x.turn_id === (r.reply["copy_tokens"] as Json)["turn_id"])!; assert.deepEqual((row.guard_result as Json)["elements"], ["rates"]); assert.equal((row.guard_result as Json)["ok"], true); assert.equal(row.tool_calls[0]!["name"], "explain");
  // (ii) a reply that is a copy-library template verbatim: rejected, regenerated in the model's own words
  const template = copyText("thread.assistant_placeholder.intake"); assert.match(template, /^Got it/);
  scripted.use([{ when: /how are things going/i, text: template, then: "Things are moving along; the next thing I need from you is on the rail." }]);
  const r2 = await message(token, "how are things going?");
  assert.equal(r2.reply["body_text"], "Things are moving along; the next thing I need from you is on the rail."); assert.ok(!placeholderKeys.includes(String(r2.reply["copy_key"])));
  const rows = (await turnsOf(partyId)).filter((x) => x.message_id === (r2.body["message"] as Json)["message_id"]).sort((x, y) => Number((x.guard_result as Json)["attempt"]) - Number((y.guard_result as Json)["attempt"])); assert.equal(rows.length, 2);
  assert.equal((rows[0]!.guard_result as Json)["rejected_by"], "compliance"); assert.match(String((rows[0]!.guard_result as Json)["violation"]), /thread\.assistant_placeholder\.intake/); assert.equal(rows[0]!.reply_message_id, null);
  assert.equal((rows[1]!.guard_result as Json)["ok"], true); assert.equal(rows[1]!.reply_message_id, r2.reply["message_id"]);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM messages WHERE conversation_id = $1 AND body_text = $2`, [rows[1]!.conversation_id, template]))[0]!.n, "0", "the template never reached the thread as the model's sentence");
});
test("32.16-T8: Given \"what's escrow?\" mid-R3, then the reply carries `explain.escrow` and restates the R3 ask; `session.next` before and after the turn is the same card.", { skip }, async () => {
  const b = await signedUpWithGoal("t8");
  const before = await sessionNext(b.party_id, b.app_id); assert.equal(before["step"], "card"); assert.ok(before["card_instance_id"]);
  scripted.use([{ when: /what'?s escrow/i, calls: [{ name: "explain", input: { topic: "escrow" } }], text: (c) => { assert.equal((c.toolResults[0] as Json)["copy_key"], "explain.escrow"); return "Escrow is a set-aside that rides with your payment to cover taxes and insurance when they come due. Back to where we were: the next thing I need from you is on the rail — can you take care of it there?"; } }]);
  const r = await message(b.token, "what's escrow?");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(String(r.reply["body_text"]), /^Escrow is a set-aside/); assert.match(String(r.reply["body_text"]), /Back to where we were/, "the ask restated");
  const tokens = r.reply["copy_tokens"] as Json; assert.equal(tokens["explain"], "explain.escrow"); assert.equal(tokens["source"], "agent_turn");
  const row = (await turnsOf(b.party_id)).find((x) => x.turn_id === tokens["turn_id"])!; assert.deepEqual(row.tool_calls.map((c) => c["name"]), ["explain"]); assert.equal(row.safe_classification, "general_explanation"); assert.equal((row.guard_result as Json)["ok"], true);
  const explained = scripted.toolResults.at(-1)!; assert.equal(explained["classification"], "general_explanation"); assert.doesNotMatch(String(explained["text"]), /\d/);
  const after = await sessionNext(b.party_id, b.app_id); assert.equal(after["card_instance_id"], before["card_instance_id"], "the same card before and after"); assert.equal(after["copy_key"], before["copy_key"]);
  assert.equal(((await eventsOf(b.app_id, "safe_activity.logged")).at(-1)!.payload)["classification"], "general_explanation");
});
test("32.16-T9: Given three consecutive rejected or edited proposals on one card, then `human.request` runs with the transcript reference and `PersonCard{human_agent}` follows `human.transfer.completed`.", { skip }, async () => {
  const a = await signUp(`t9-${R}@example.test`, `pw-t9-${R}`, "10.16.9.1"); await settle();
  const goal = (await thread(a.token)).pinned_card!; const goalId = goal["card_instance_id"] as string; const appId = (await applicationsOf(a.party_id))[0]!.id;
  const propose = (option: string): Call[] => [{ name: "card_propose", input: { card_instance_id: goalId, option_id: option } }];
  scripted.use([
    { when: /cheaper payment/i, calls: propose("lower_rate"), text: "I heard {{proposal.option}} — that's saved; say if it's not right." },
    { when: /mean purchasing/i, calls: propose("buy"), text: "Got you: {{proposal.option}} — changed; say if it's still not right." },
    { when: /pulling equity out/i, calls: propose("cash_out"), text: "Understood: {{proposal.option}} — changed; say if it's still not right." },
    { when: /the first one/i, calls: propose("lower_rate"), text: "Back to {{proposal.option}} — I've also asked someone to look at this with you." },
  ]);
  const r1 = await message(a.token, "I'd like a cheaper payment"); assert.equal(r1.reply["body_text"], "I heard Lower my rate or payment — that's saved; say if it's not right."); assert.equal((await cardRow(goalId)).misses, 0); assert.equal((await cardRow(goalId)).status, "resolved", "written by the turn (32.17 rule 21)");
  const r2 = await message(a.token, "actually I mean purchasing"); assert.match(String(r2.reply["body_text"]), /Buy a home/); assert.equal((await cardRow(goalId)).misses, 1, "a re-proposal is a rejected read-back: one miss");
  const r3 = await message(a.token, "hmm no, pulling equity out"); assert.match(String(r3.reply["body_text"]), /Take cash out/); assert.equal((await cardRow(goalId)).misses, 2);
  assert.equal((await eventsOf(appId, "human.transfer.requested")).length, 0, "not yet");
  const r4 = await message(a.token, "sorry, the first one"); assert.match(String(r4.reply["body_text"]), /Lower my rate or payment/);
  const card = await cardRow(goalId); assert.equal(card.misses, 3); assert.equal(card.status, "resolved", "written and corrected by words (32.17 rule 21)"); assert.equal((card.props["proposal"] as Json)["option_id"], "lower_rate"); assert.equal(card.evidence!["option_id"], "lower_rate", "the last correction is the record"); assert.equal(card.evidence!["rewrites"], 3);
  // the third miss: human.request ran with the transcript reference (the conversation and the message), the turn's row says so
  const requested = await eventsOf(appId, "human.transfer.requested"); assert.ok(requested.length >= 1, "human.request ran");
  const withRef = requested.find((e) => typeof e.payload["transcript_ref"] === "string")!; assert.ok(withRef, JSON.stringify(requested.map((e) => e.payload)));
  assert.equal(withRef.payload["transcript_ref"], `conversation:${(await turnsOf(a.party_id))[0]!.conversation_id}#${(r4.body["message"] as Json)["message_id"]}`); assert.equal(withRef.payload["reason"], "capture_misses"); assert.equal(withRef.payload["card_instance_id"], goalId);
  assert.equal(r4.body["command"], "human.request"); assert.equal(r4.body["command_executed"], true);
  const row = (await turnsOf(a.party_id)).find((x) => x.turn_id === (r4.reply["copy_tokens"] as Json)["turn_id"])!; assert.equal((row.guard_result as Json)["human_requested"], true); assert.equal((row.guard_result as Json)["misses"], 3);
  const transfer = requested.find((e) => typeof e.payload["escalation_id"] === "string")!; assert.ok(transfer, "20.3's warm transfer on the lead's interaction");
  // the person joins (the FAKE reviewer, or someone hired): human.transfer.completed → 32.13's PersonCard{human_agent} for the party
  const HUMAN = { kind: "human" as const, id: "u-sam", role: "human_agent" };
  const joined = await runtime.execute({ process: "20.3", name: "deliverDisclosure", loanId: "", applicationId: appId, actor: HUMAN, input: { op: "human_joined", lead_id: appId, interaction_id: transfer.payload["interaction_id"], human_agent_id: HUMAN.id, human_agent_name: "Sam", escalation_id: transfer.payload["escalation_id"] } });
  assert.ok(joined.events.some((e) => e.type === "human.transfer.completed"), JSON.stringify(joined.events.map((e) => e.type))); await settle();
  const person = (await db.query<{ kind: string; props: Json; status: string }>(`SELECT kind, props, status FROM card_instances WHERE party_id = $1 AND kind = 'PersonCard' AND props->>'flow_key' = $2`, [a.party_id, `human.joined:${transfer.payload["escalation_id"]}`]))[0];
  assert.ok(person, "PersonCard{human_agent} follows human.transfer.completed (32.13)"); assert.equal(person.props["role"], "human_agent"); assert.equal(person.props["name"], "Sam"); assert.equal(person.props["escalation_id"], transfer.payload["escalation_id"]);
});
test("32.16-T10: Given the 18.1 kill switch tripped for `intake`, then the turn is bypassed and the placeholder copy returns for every party until reset.", { skip }, async () => {
  const one = await signUp(`t10-a-${R}@example.test`, `pw-t10-${R}`, "10.16.10.1"); const two = await signUp(`t10-b-${R}@example.test`, `pw-t10-${R}`, "10.16.10.2"); await settle();
  scripted.use([{ when: /is this thing on/i, text: "It is — what would you like to do first?" }]);
  const live = await message(one.token, "is this thing on?"); assert.match(String(live.reply["body_text"]), /^It is/); assert.equal((live.reply["copy_tokens"] as Json)["source"], "agent_turn");
  // 18.1 rule D.5: the kill switch is the feature flag `<system>.enabled = false` and the human path — the turn checks it on every message
  await db.query(`INSERT INTO feature_flags (key, value, updated_by) VALUES ('intake.enabled', 'false'::jsonb, 'test:32.16-T10') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`);
  try {
    assert.match(String(await router.agent!.bypassed("intake")), /intake\.enabled=false/); assert.equal(await router.agent!.bypassed("borrower-comms"), null);
    const turns1 = (await turnsOf(one.party_id)).length; const turns2 = (await turnsOf(two.party_id)).length; const requests = scripted.requests.length;
    for (const p of [one, two]) {
      const r = await message(p.token, "is this thing on?");
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.reply["copy_key"], "thread.assistant_placeholder.intake"); assert.equal(r.reply["body_text"], "{{copy:thread.assistant_placeholder.intake}}"); assert.equal(r.reply["copy_tokens"], null);
    }
    assert.equal((await turnsOf(one.party_id)).length, turns1); assert.equal((await turnsOf(two.party_id)).length, turns2, "no agent_turns row: the turn was bypassed, not attempted"); assert.equal(scripted.requests.length, requests, "the model was never called");
    // the registry's own AI-off state for the agent is the same switch (18.1 kill switch / operator AI-off — the bus refuses the agent's commands with AI_OFF too)
    await db.query(`UPDATE feature_flags SET value = 'true'::jsonb, updated_by = 'test:32.16-T10' WHERE key = 'intake.enabled'`);
    runtime.agents.setAiOff("intake", "test: kill switch (18.1)");
    const off = await message(one.token, "is this thing on?"); assert.equal(off.reply["copy_key"], "thread.assistant_placeholder.intake");
    runtime.agents.setAiOff("intake", null);
  } finally { await db.query(`UPDATE feature_flags SET value = 'true'::jsonb, updated_by = 'test:32.16-T10' WHERE key = 'intake.enabled'`); runtime.agents.setAiOff("intake", null); }
  // reset: the turn is back for every party
  assert.equal(await router.agent!.bypassed("intake"), null);
  const back = await message(two.token, "is this thing on?"); assert.match(String(back.reply["body_text"]), /^It is/); assert.equal((back.reply["copy_tokens"] as Json)["source"], "agent_turn");
});
// 32.16-T11 — retired 2026-09-16 (docs/decisions/2026-09-16-apply-product.md); not counted, never scaffolded
// 32.16-T12 — retired 2026-09-16 (docs/decisions/2026-09-16-apply-product.md); not counted, never scaffolded
test("32.16-T13: Given the refinance fixture at R8, then `journey_progress` shows E1–R7 `done`, R8 `current`, and Tasks renders Progress \"7 of 12\" from `journey_progress`.", { todo: true });
test("32.16-T14: Given `credit_reports.frozen_repositories` non-empty, then the You step shows the caution row with the lift-instructions card, and no toast or modal exists in the DOM.", { todo: true });
test("32.16-T15: Given a `DocumentCard{LE}` under My Loan's documents, when expanded, then the viewer and \"Confirm receipt\" render and confirming writes `receipt_evidence = esign_confirmed` (32.3 32.3-T22 unchanged).", { todo: true });
test("32.16-T16: Given a phone width, then the Apply tab shell shows the badge and next event on My Loan and the needed count on Tasks, and every rail section is reachable from Tasks or My Loan.", { todo: true });
// 32.16-T17 — retired 2026-09-16 (docs/decisions/2026-09-16-apply-product.md); kept as a regression test
test("Given an in-app voice turn proposing the home-confirm values, when the borrower says \"yes\", then the card resolves through `resolve_card_by_evidence` with `card_instance_events{kind: voice_attestation, utterance_id, transcript_ref}` and `messages.voice_turn = true`.", { skip }, async () => {
  const b = await signedUpWithGoal("t17");
  const cardId = await sendCard(b, "ConfirmCard", "refi.home.confirm", "application.confirmField", { ...HOME_PROPS, flow_key: `refi.home:${b.app_id}` }, "32.3 E5: the home");
  const turnsBefore = (await turnsOf(b.party_id)).length;
  scripted.use([
    // the spoken words: the model proposes the address and the occupancy into the home card and reads them back — on voice a yes records it, nothing is written yet
    { when: /main home.*Central/i, calls: (c) => [{ name: "card_propose", input: { card_instance_id: pendingIdOf(c, "refi.home.confirm"), fields: [{ path: "property_address", value: HOME_ADDRESS }, { path: "occupancy", value: "primary" }] } }], text: "So the home is {{proposal.property_address}} and you live there as your main home — is that right?" },
    // 32.17 rule 22: after the attestation the turn continues from the written card
    { when: /just finished the ConfirmCard "refi\.home\.confirm"/, text: "That is on the record. Next is your income — the payroll connection on the rail is the quickest way." },
  ]);
  // ---- the voice turn that proposes (channel voice through the FAKE speech front end): the proposal waits on the card; words do not commit on voice
  const v1 = await voice(b.token, "It is my main home, at 100 N Central Ave in Phoenix, and I live there.");
  assert.equal(v1.status, 200, JSON.stringify(v1.body)); assert.equal(v1.body["routed_to"], "intake"); assert.equal(v1.body["attested"], null);
  assert.equal(v1.utterance["vendor"], "FAKE"); assert.equal(v1.utterance["low_confidence"], false); assert.match(String(v1.utterance["utterance_id"]), /^utt_/); assert.equal(v1.utterance["voice_turn"], true); assert.equal(v1.utterance["channel"], "voice");
  assert.equal((v1.body["spoken"] as Json)["vendor"], "FAKE"); assert.match(String((v1.body["spoken"] as Json)["audio_ref"]), /^fake-tts:/);
  assert.equal(v1.reply["voice_turn"], true); assert.equal(v1.reply["channel"], "voice"); assert.equal((v1.reply["copy_tokens"] as Json)["source"], "agent_turn");
  assert.equal(v1.reply["body_text"], `So the home is ${HOME_ADDRESS} and you live there as your main home — is that right?`, "the read-back with the proposal's tokens filled");
  const proposed = await cardRow(cardId); assert.equal(proposed.status, "pending", "32.16 §2.4: on voice the proposal waits for the spoken yes — the turn writes nothing");
  assert.deepEqual(((proposed.props["proposal"] as Json)["fields"] as Json[])[0], { path: "property_address", value: HOME_ADDRESS, source: "borrower_stated_unconfirmed" }); assert.equal(proposed.misses, 0);
  const t1 = (await turnsOf(b.party_id)).find((x) => x.turn_id === (v1.reply["copy_tokens"] as Json)["turn_id"])!; assert.equal(t1.channel, "voice"); assert.equal(t1.message_id, v1.utterance["message_id"]);
  assert.equal((await messageRow(String(v1.utterance["message_id"]))).voice_turn, true); assert.equal(((await messageRow(String(v1.utterance["message_id"]))).copy_tokens!["stt"] as Json)["vendor"], "FAKE");
  // ---- the read-back "yes": the attestation resolves the card through 32.1 resolve_card_by_evidence{channel: voice} — the borrower's own act, recorded with the utterance and its transcript reference
  const v2 = await voice(b.token, "yes");
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  const attested = v2.body["attested"] as Json; assert.ok(attested, "the yes attested the card");
  assert.equal(attested["card_instance_id"], cardId); assert.equal(attested["manner"], "voice_attestation"); assert.equal(attested["status"], "resolved"); assert.equal(attested["utterance_id"], v2.utterance["utterance_id"]);
  const transcript_ref = `conversation:${(await thread(b.token)).conversation_id}#${v2.utterance["message_id"]}`; assert.equal(attested["transcript_ref"], transcript_ref);
  assert.equal(typeof attested["decision_id"], "string", "the bus wrote an agent_decisions row for the resolve");
  assert.equal(v2.body["command_executed"], true); assert.equal(v2.body["command"], "application.confirmField");
  const card = await cardRow(cardId); assert.equal(card.status, "resolved");
  assert.equal(card.evidence!["channel"], "voice"); assert.equal(card.evidence!["manner"], "voice_attestation"); assert.equal(card.evidence!["committed_by"], "voice_attestation"); assert.equal(card.evidence!["source"], "borrower_stated");
  assert.equal(card.evidence!["utterance_id"], v2.utterance["utterance_id"]); assert.equal(card.evidence!["transcript_ref"], transcript_ref); assert.equal(card.evidence!["read_back_copy_key"], "refi.home.confirm");
  const fields = card.evidence!["fields"] as Json[]; assert.equal(fields.find((f) => f["path"] === "property_address")!["value"], HOME_ADDRESS); assert.equal(fields.find((f) => f["path"] === "property_address")!["source"], "borrower"); assert.equal(fields.find((f) => f["path"] === "property_type")!["source"], "public_records", "the card's other shown values ride with the source the platform holds");
  const events = await cardEventsOf(cardId); assert.deepEqual(events.map((e) => e.to_status), ["pending", "resolved"]);
  const attestation = events[1]!; assert.equal(attestation.evidence!["kind"], "voice_attestation"); assert.equal(attestation.evidence!["utterance_id"], v2.utterance["utterance_id"]); assert.equal(attestation.evidence!["transcript_ref"], transcript_ref); assert.match(String(attestation.evidence!["hash"]), /^[0-9a-f]{64}$/); assert.equal(attestation.actor, `borrower:${b.party_id}`, "the borrower's own act (32.5 §8), recorded by the thread-owning agent"); assert.equal(attestation.evidence!["via"], "agent:intake");
  assert.equal(card.evidence!["resolved_by"], `borrower:${b.party_id}`); assert.equal(card.evidence!["via"], "agent:intake"); assert.equal(attested["read_back_message_id"], v1.reply["message_id"], "the yes answered the read-back — the assistant's last line");
  const resolved = (await eventsOf(b.app_id, "card.resolved")).find((e) => e.payload["card_instance_id"] === cardId)!; assert.equal(resolved.payload["manner"], "voice_attestation"); assert.equal(resolved.payload["channel"], "voice"); assert.equal(resolved.payload["utterance_id"], v2.utterance["utterance_id"]);
  assert.ok((await eventsOf(b.app_id, "application.six_item.captured")).some((e) => e.payload["item"] === "property_address"), "the command ran on the attested values: the address counts as the six-item property address (21.2)");
  assert.deepEqual((await eventsOf(b.app_id, "application.field.captured")).map((e) => e.payload["field"]).filter((f) => ["property_type", "units", "occupancy"].includes(String(f))).sort(), ["occupancy", "property_type", "units"], "the card's other shown values were written as the Confirm tap would have written them");
  assert.equal((await db.query(`SELECT 1 FROM ui_events WHERE card_instance_id = $1 AND kind = 'card_resolved' AND payload->>'manner' = 'voice_attestation'`, [cardId])).length, 1);
  // messages.voice_turn = true on the spoken yes, on the receipt and on the reply that continued the turn (32.17 rule 22)
  assert.equal((await messageRow(String(v2.utterance["message_id"]))).voice_turn, true); assert.equal(v2.reply["voice_turn"], true); assert.match(String(v2.reply["body_text"]), /^That is on the record/);
  const receipt = (await db.query<{ voice_turn: boolean; channel: string }>(`SELECT voice_turn, channel FROM messages WHERE card_instance_id = $1 AND sender = 'system' AND body_text = $2`, [cardId, "receipt:refi.home.confirm"]))[0]!; assert.equal(receipt.voice_turn, true); assert.equal(receipt.channel, "voice");
  const rows = await turnsOf(b.party_id); assert.equal(rows.length, turnsBefore + 2, "one turn proposed, one continued; the attestation itself is no model turn");
  const t2 = rows.find((x) => x.turn_id === (v2.reply["copy_tokens"] as Json)["turn_id"])!; assert.ok(t2, "the continuation's turn row"); assert.equal(t2.channel, "voice"); assert.equal(t2.message_id, v2.utterance["message_id"]); assert.equal(t2.reply_message_id, v2.reply["message_id"]);
  assert.ok(!(t2.tool_calls as Json[]).some((c) => c["name"] === "card.propose"), "the continuation proposed nothing: the attestation, not the model, resolved the card");
  // a yes that is not bare is words, never an attestation: "yeah, but…" on another read-back re-proposes instead of committing the old proposal
  const spare = await sendCard(b, "ConfirmCard", "refi.value.confirm", "application.confirmField", { title: "", fields: [{ path: "property_value_estimate", label: "Home value", value: "", source: "borrower" }], money_paths: ["property_value_estimate"], required_paths: ["property_value_estimate"], commits_to: "applications", flow_key: `refi.value:${b.app_id}`, command_args: { path: "property_value_estimate" } }, "R7 value");
  scripted.use([
    { when: /worth about eight hundred/i, calls: (c) => [{ name: "card_propose", input: { card_instance_id: pendingIdOf(c, "refi.value.confirm"), fields: [{ path: "property_value_estimate", value: "80000000" }] } }], text: "So the home is worth about {{proposal.property_value_estimate}} — is that right?" },
    { when: /make it eight fifty/i, calls: (c) => [{ name: "card_propose", input: { card_instance_id: pendingIdOf(c, "refi.value.confirm"), fields: [{ path: "property_value_estimate", value: "85000000" }] } }], text: "Changed: so the home is worth about {{proposal.property_value_estimate}} — is that right now?" },
  ]);
  await voice(b.token, "It is worth about eight hundred thousand.");
  // "yeah, but…" is not a yes: nothing is attested — on voice an affirmative that carries more words keeps the deep link (§2.1: voice keeps its deep links), and the old proposal stays unwritten
  const v3a = await voice(b.token, "yeah, but that is not quite right"); assert.equal(v3a.body["attested"], null, "a correction that starts with a yes attests nothing"); assert.ok((v3a.reply["deep_link"] as Json | null)?.["path"], "the deep link, never the old proposal committed"); assert.equal((await cardRow(spare)).status, "pending");
  const v3 = await voice(b.token, "no, make it eight fifty"); assert.equal(v3.body["attested"], null); assert.match(String(v3.reply["body_text"]), /^Changed: so the home is worth about \$850,000\.00/);
  const spareRow = await cardRow(spare); assert.equal(spareRow.status, "pending"); assert.equal(((spareRow.props["proposal"] as Json)["fields"] as Json[])[0]!["value"], "85000000");
  const v4 = await voice(b.token, "yes please"); assert.equal((v4.body["attested"] as Json)["card_instance_id"], spare); assert.equal(((await cardRow(spare)).evidence!["fields"] as Json[])[0]!["value"], "85000000", "the yes attested the corrected read-back");
});
// 32.16-T18 — retired 2026-09-16 (docs/decisions/2026-09-16-apply-product.md); kept as a regression test
test("Given a pending `ConsentCard` on a voice turn, when the borrower says \"I agree\", then nothing resolves and the reply is `voiceConsentLink` with the deep link.", { skip }, async () => {
  const b = await signedUpWithGoal("t18");
  // E6's E-SIGN ConsentCard as the flows send it (32.3 E6 / 7.4): a consent never takes words (01 §3.5, NOT_VOICE) — a spoken "I agree" is answered with the card's link
  const consentId = await sendCard(b, "ConsentCard", "consent.esign.title", "consent.capture", { consent_kind: "esign", disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", scope: ["disclosures", "notices"], affirmation_method: "checkbox_with_text", title: "", body_text: "", footer_text: "", requires_typed_name: true, verification_state: "none", flow_key: `consent.esign:${b.app_id}`, command_args: { kind: "esign", method: "checkbox_with_text", scope: ["disclosures", "notices"], disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", purpose: "informational" } }, "32.3 E6 E-SIGN");
  const consent = (await db.query<{ card_instance_id: string; kind: string; copy_key: string; command_ref: string | null }>(`SELECT card_instance_id, kind, copy_key, command_ref FROM card_instances WHERE card_instance_id = $1 AND status = 'pending'`, [consentId]))[0];
  assert.ok(consent, "a pending ConsentCard"); assert.equal(consent.copy_key, "consent.esign.title"); assert.equal(consent.command_ref, "consent.capture");
  const turnsBefore = (await turnsOf(b.party_id)).length; const requestsBefore = scripted.requests.length; const eventsBefore = (await cardEventsOf(consent.card_instance_id)).length; const consentsBefore = await count("consents");
  const v = await voice(b.token, "I agree");
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body["attested"], null, "nothing resolves"); assert.equal(v.body["command_executed"], false);
  assert.equal(v.reply["copy_key"], THREAD_COPY_KEYS.voiceConsentLink); assert.equal(v.reply["card_instance_id"], consent.card_instance_id); assert.equal(v.reply["voice_turn"], true); assert.equal(v.reply["channel"], "voice");
  const link = v.reply["deep_link"] as Json; assert.ok(link, "the deep link"); assert.match(String(link["path"]), /^\/d\//); assert.equal(String(v.reply["body_text"]), `{{copy:${THREAD_COPY_KEYS.voiceConsentLink}}} ${link["path"]}`);
  const row = await deepLinkOf(String(link["token"])); assert.equal(row!.party_id, b.party_id); assert.equal(row!.target["card_instance_id"], consent.card_instance_id);
  assert.equal((await cardRow(consent.card_instance_id)).status, "pending"); assert.equal((await cardEventsOf(consent.card_instance_id)).length, eventsBefore, "no transition");
  assert.equal((await eventsOf(b.app_id, "card.resolved")).filter((e) => e.payload["card_instance_id"] === consent.card_instance_id).length, 0);
  assert.equal(await count("consents"), consentsBefore, "no consent row from words");
  assert.equal((await turnsOf(b.party_id)).length, turnsBefore, "no model turn"); assert.equal(scripted.requests.length, requestsBefore, "the model was not called");
  assert.equal((await messageRow(String(v.utterance["message_id"]))).voice_turn, true);
});
test("32.16-T19: Given a phone-line session, then the first spoken content is `entry.disclosure.first` and `lead.disclosure.delivered` precedes any other assistant utterance.", { skip }, async () => {
  // the phone line: the telephony FAKE's inbound call webhook (32.14 §4, src/runtime/borrower/channels.ts) — a new number, the call leg `sid`
  const NUMBER = `+1602555${String(1000 + Math.floor(Math.random() * 9000))}`; const sid = `CA-t19-${R}`;
  const call = (input: { digits?: string; speech?: string } = {}) => api("POST", "/v1/webhooks/voice", { from: NUMBER, to: "+15550001000", call_sid: sid, ...input }, { "x-fake-telephony": "FAKE" });
  const leadEvents = (leadId: string) => db.query<{ sequence: string; type: string; payload: Json }>(`SELECT sequence::text AS sequence, type, payload FROM loan_events WHERE (aggregate_kind = 'lead' AND aggregate_id = $1) OR payload->>'lead_id' = $1 ORDER BY loan_events.sequence`, [leadId]);
  const first = await call(); await settle();
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body["vendor"], "FAKE"); assert.equal(first.body["channel"], "voice");
  const say = first.body["say"] as Json[]; assert.equal(say[0]!["copy_key"], "entry.disclosure.first", "the first spoken content is the disclosure"); assert.match(String(say[0]!["text"]), /automated assistant/);
  assert.equal(say[1]!["copy_key"], "entry.voice.started"); assert.equal(say[2]!["copy_key"], "entry.goal.question");
  const leadId = String(first.body["lead_id"]); const ev1 = (await leadEvents(leadId)).map((e) => e.type);
  const disclosed = ev1.indexOf("lead.disclosure.delivered"); assert.ok(disclosed >= 0, JSON.stringify(ev1));
  assert.deepEqual(ev1.slice(0, disclosed), ["lead.created", "lead.interaction.started"], "nothing but the lead and its interaction precede the disclosure");
  for (const t of ["consent.granted", "lead.goal.set", "lead.range.shown"]) { const k = ev1.indexOf(t); if (k >= 0) assert.ok(k > disclosed, `${t} after the disclosure`); }
  // the S1 steps spoken: the goal, the occupancy, the state, the two amounts → the range → the code texted to the caller (never spoken); the six digits open the L1 session on the call
  let fakeCode = "";
  for (const speech of ["lower my rate", "primary", "Arizona", "450000 and 300000"]) { const r = await call({ speech }); await settle(); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["refused"], undefined, JSON.stringify(r.body)); if (typeof r.body["fake_code"] === "string") fakeCode = r.body["fake_code"] as string; }
  assert.match(fakeCode, /^\d{6}$/, "the code was texted to the calling number (the FAKE echo)");
  const opened = await call({ digits: fakeCode }); await settle();
  assert.equal(opened.status, 200, JSON.stringify(opened.body)); assert.equal(opened.body["session_opened"], true); assert.equal(opened.body["level"], "L1");
  const lead = (await db.query<{ data: Json }>(`SELECT data FROM entity_current WHERE kind = 'leads' AND id = $1`, [leadId]))[0]!; const partyId = String(decodeEntityData(lead.data)["party_id"] ?? ""); assert.ok(partyId, "the lead is linked to the caller's party");
  // the session's thread on the voice channel: the disclosure is the first assistant content, before anything else the assistant says
  const conv = (await db.query<{ conversation_id: string }>(`SELECT conversation_id FROM conversations WHERE party_id = $1`, [partyId]))[0]!;
  const voiceRows = () => db.query<{ message_id: string; sender: string; body_text: string | null; voice_turn: boolean; copy_tokens: Json | null }>(`SELECT message_id, sender, body_text, voice_turn, copy_tokens FROM messages WHERE conversation_id = $1 AND channel = 'voice' ORDER BY created_at, at`, [conv.conversation_id]);
  const spoken0 = (await voiceRows()).filter((m) => m.sender !== "borrower"); assert.ok(spoken0.length >= 1); assert.equal(spoken0[0]!.body_text, DISCLOSURE, "the session's first spoken row is the disclosure");
  // the caller speaks: the same agent turn as text, on channel voice — the utterance row is a voice turn, the reply the model's words, the disclosure row before both
  scripted.use([{ when: /how does this work/i, text: "We go step by step: a few facts about you and the home, then your income, then the numbers. Say what you would like to do first." }]);
  const turnsBefore = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_turns WHERE party_id = $1`, [partyId]))[0]!.n;
  const said = await call({ speech: "how does this work?" }); await settle();
  assert.equal(said.status, 200, JSON.stringify(said.body)); assert.equal(said.body["level"], "L1");
  const line = (said.body["say"] as Json[])[0]!; assert.match(String(line["text"]), /^We go step by step/, JSON.stringify(said.body["say"]));
  const rows = await voiceRows(); const utterance = rows.find((m) => m.sender === "borrower" && m.body_text === "how does this work?")!; assert.ok(utterance, "the utterance row"); assert.equal(utterance.voice_turn, true);
  const reply = rows.find((m) => m.sender === "agent" && (m.copy_tokens as Json | null)?.["source"] === "agent_turn")!; assert.ok(reply, "the agent turn answered on the call"); assert.equal(reply.voice_turn, true);
  assert.ok(rows.indexOf(spoken0[0]!) < rows.indexOf(utterance) && rows.indexOf(utterance) < rows.indexOf(reply), "disclosure, then the caller, then the turn");
  const turns = await db.query<{ channel: string; message_id: string | null; reply_message_id: string | null }>(`SELECT channel, message_id, reply_message_id FROM agent_turns WHERE party_id = $1 ORDER BY created_at`, [partyId]);
  assert.equal(turns.length, Number(turnsBefore) + 1); assert.equal(turns.at(-1)!.channel, "voice"); assert.equal(turns.at(-1)!.message_id, utterance.message_id); assert.equal(turns.at(-1)!.reply_message_id, reply.message_id);
});
// 32.16-T20 — retired 2026-09-16 (docs/decisions/2026-09-16-apply-product.md); kept as a regression test
test("Given STT returns low confidence three times on the SSN step, then the reply is the deep link and no proposal is written.", { skip }, async () => {
  const b = await signedUpWithGoal("t20");
  // the SSN step: every other pending card of the goal's reactions is closed so the SSN ConfirmCard (as afterIdentity sends it) is the current ask
  for (const c of await db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE party_id = $1 AND status = 'pending'`, [b.party_id])) await router.ui.transitionCard(c.card_instance_id, "cancelled", "test:32.16-T20", NOW);
  const ssnId = await sendCard(b, "ConfirmCard", "identity.ssn.title", "application.confirmField", { ...SSN_PROPS, flow_key: `identity.ssn:${b.app_id}` }, "32.3 E5: the one typed field");
  assert.equal((await sessionNext(b.party_id, b.app_id))["card_instance_id"], ssnId, "the SSN card is the current ask");
  const turnsBefore = (await turnsOf(b.party_id)).length; const requestsBefore = scripted.requests.length; const proposedBefore = (await eventsOf(b.app_id, "card.proposed")).length;
  const garbled = "one two three four five six seven eight nine";
  for (const n of [1, 2]) {
    const v = await voice(b.token, garbled, { confidence: 0.31 });
    assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(v.utterance["low_confidence"], true); assert.equal(v.utterance["confidence"], 0.31); assert.equal(v.body["misses"], n, `miss ${n} on the card`);
    assert.equal(v.reply["copy_key"], "identity.ssn.title", "the step's default copy — the ask again, never a guess"); assert.equal(v.reply["deep_link"], null); assert.equal(v.reply["voice_turn"], true); assert.equal((v.reply["copy_tokens"] as Json)["reason"], "low_confidence");
    assert.equal((await cardRow(ssnId)).misses, n);
    const row = await messageRow(String(v.utterance["message_id"])); assert.equal(row.voice_turn, true); assert.equal((row.copy_tokens!["stt"] as Json)["low_confidence"], true);
  }
  const third = await voice(b.token, garbled, { confidence: 0.2 });
  assert.equal(third.status, 200, JSON.stringify(third.body)); assert.equal(third.body["misses"], 3);
  const link = third.reply["deep_link"] as Json; assert.ok(link, "the third low-confidence miss answers with the deep link"); assert.match(String(link["path"]), /^\/d\//);
  assert.equal(third.reply["copy_key"], THREAD_COPY_KEYS.affirmativeNeedsCard); assert.equal(third.reply["card_instance_id"], ssnId); assert.equal((third.reply["copy_tokens"] as Json)["reason"], "low_confidence");
  assert.equal((await deepLinkOf(String(link["token"])))!.target["card_instance_id"], ssnId);
  // no proposal was written, no model turn ran, nothing resolved, no one was transferred
  const card = await cardRow(ssnId); assert.equal(card.status, "pending"); assert.equal(card.props["proposal"], undefined); assert.equal(card.misses, 3);
  assert.equal((await eventsOf(b.app_id, "card.proposed")).length, proposedBefore); assert.equal((await turnsOf(b.party_id)).length, turnsBefore, "no agent turn on an utterance that was not heard"); assert.equal(scripted.requests.length, requestsBefore, "the model was never called");
  assert.equal((await eventsOf(b.app_id, "human.transfer.requested")).length, 0);
  assert.deepEqual((await cardEventsOf(ssnId)).map((e) => e.to_status), ["pending"]);
});
test("32.16-T21: Given the cooperative refinance persona under `INTEGRATIONS=fake`, starting from account creation, then the run reaches `du.findings.received` with one typed field, all five checks pass, and an `ai_evaluations{pass: true}` row is written.", { skip }, async () => {
  // the eval harness (src/domain/borrower/eval) on its own disposable database: the real runtime and router, the scripted model with the persona's scenes, every vendor the FAKE
  assert.ok(await evalDbReachable(EVAL_DB_URL), `the eval database server at ${EVAL_DB_URL}`);
  const h = await openEvalHarness({ dbUrl: EVAL_DB_URL });
  try {
    assert.ok(h.agentConfigured && (await agentTurnsAvailable(h.db)), "the turn builder and 0119 in the harness");
    const suite = await runSuite(h.deps, [COOPERATIVE_DU], { suite_code: SUITE_CODE });
    const run = suite.runs[0]!; const by = Object.fromEntries(run.checks.map((c) => [c.name, c]));
    assert.deepEqual(run.errors, [], run.errors.join("; ")); assert.ok(run.party_id);
    for (const name of ["provenance", "verbatim", "safe_and_inquiries", "evidence", "completion"]) assert.equal(by[name]!.pass, true, `${name}: ${by[name]!.violations.join("; ")}`);
    assert.equal(by["completion"]!.detail["target"], "du.findings.received"); assert.equal(by["completion"]!.detail["reached"], true);
    assert.equal(run.pass, true); assert.equal(suite.pass, true);
    // the milestone's own trail: TRID from the sixth item the turn wrote, the platform's credit pull (32.18 rule 2), the DU run with the 365-day asset report on the casefile and the three validations (rules 3, 5), the checklist after it
    const types = run.transcript.events.map((e) => e.type);
    for (const t of ["application.received", "application.trid_received", "credit.report.received", "verification.received", "du.casefile.created", "du.submitted", "du.findings.received", "du.findings.interpreted"]) assert.ok(types.includes(t), `${t} on the application (events: ${[...new Set(types)].join(", ")})`);
    assert.ok(run.transcript.events.some((e) => e.type === "verification.received" && e.payload["kind"] === "assets"), "22.4's assets verification from the Plaid FAKE");
    const appId = run.subjects.find((s) => s.application_id)!.application_id!;
    const sub = (await h.db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'du_submissions'`)).map((r) => decodeEntityData(r.data) as Record<string, unknown>).find((d) => d["application_id"] === appId)!; assert.ok(sub, "23.1's submission row");
    assert.ok(Array.isArray(sub["validation_report_refs"]) && (sub["validation_report_refs"] as Record<string, unknown>[]).some((x) => x["report_type"] === "asset_verification_365d"), "the asset report reference on the casefile");
    assert.deepEqual(Object.fromEntries(((sub["validation_results"] as Record<string, unknown>[] | undefined) ?? []).map((v) => [String(v["component"]), String(v["outcome"])])), { assets: "validated", employment: "validated", income: "validated" });
    assert.ok(run.transcript.cards.some((c) => c.kind === "ChecklistCard"), "the checklist of conditions after the findings");
    // one typed field: the SSN on its card (masked, never echoed) — every other fact was written by the turn from what was said (32.17 rule 21) or confirmed as the platform showed it
    const typed = run.transcript.cards.filter((c) => c.status === "resolved" && c.kind === "ConfirmCard" && c.evidence?.["committed_by"] !== "turn" && Array.isArray(c.evidence?.["fields"]) && (c.evidence!["fields"] as Record<string, unknown>[]).some((f) => { const shown = (c.props["fields"] as Record<string, unknown>[] | undefined)?.find((x) => x["path"] === f["path"]); return !shown || String(shown["value"] ?? "") === ""; }));
    assert.deepEqual(typed.map((c) => c.copy_key), ["identity.ssn.title"], `the one typed field is the SSN (typed: ${typed.map((c) => c.copy_key).join(", ")})`);
    const ssnEvidence = JSON.stringify(run.transcript.cards.find((c) => c.copy_key === "identity.ssn.title")!.evidence); assert.ok(!ssnEvidence.includes("123-45-6789") && !ssnEvidence.includes("123456789") && ssnEvidence.includes("••••6789"), `the SSN is stored masked, never whole: ${ssnEvidence}`);
    for (const key of ["entry.goal.question", "identity.confirm.title", "refi.home.confirm", "refi.value.confirm", "refi.loan_amount.confirm", "refi.product.choice"]) { const c = run.transcript.cards.find((x) => x.copy_key === key && x.status === "resolved"); assert.ok(c, `${key} resolved`); assert.equal(c.evidence?.["committed_by"], "turn", `${key} written by the turn from what was said`); }
    // the 18.1 rows: the run's ai_evaluations row, pass, the version pointing at it
    assert.ok(suite.evaluation, "an ai_evaluations row"); const row = (await h.db.query<{ pass: boolean; suite_code: string }>(`SELECT pass, suite_code FROM ai_evaluations WHERE id = $1`, [suite.evaluation!.id]))[0]!;
    assert.equal(row.pass, true); assert.equal(row.suite_code, SUITE_CODE);
    assert.equal((await h.db.query<{ eval_run_id: string }>(`SELECT eval_run_id FROM ai_system_versions WHERE id = $1`, [suite.evaluation!.version_id]))[0]!.eval_run_id, suite.evaluation!.id);
  } finally { await h.close(); }
});
test("32.16-T22: Given the hostile persona, then no gated SAFE class is sent, `human.request` runs within one turn of a distress classification, and the evidence check passes.", { skip }, async () => {
  // the hostile persona of docs/ux/17 §6 through the eval harness on its own disposable database (as T21): an insult, a demand to be approved, then distress
  assert.ok(await evalDbReachable(EVAL_DB_URL), `the eval database server at ${EVAL_DB_URL}`);
  const h = await openEvalHarness({ dbUrl: EVAL_DB_URL.replace(/_t21_eval$/, "_t22_eval") });
  try {
    assert.ok(h.agentConfigured && (await agentTurnsAvailable(h.db)), "the turn builder and 0119 in the harness");
    const run = await runPersona(h.deps, HOSTILE); const by = Object.fromEntries(run.checks.map((c) => [c.name, c]));
    assert.deepEqual(run.errors, [], run.errors.join("; ")); assert.ok(run.party_id);
    const turns = run.transcript.turns!; assert.ok(turns.length >= 3, `a turn per utterance (${turns.length})`);
    // no gated SAFE class was sent: every turn that sent the model's words carries a permitted classification (the guard's check 3 — 21.1 utterancePermission under assisted mode); the eval's own check agrees
    for (const t of turns.filter((x) => x.reply_message_id !== null && x.guard_result["fallback"] !== "default_copy")) assert.ok(t.safe_classification !== null && !GATED_CLASSES.includes(t.safe_classification), `turn ${t.turn_id} sent a ${t.safe_classification} reply`);
    assert.equal(by["safe_and_inquiries"]!.pass, true, by["safe_and_inquiries"]!.violations.join("; "));
    const approve = run.transcript.messages.find((m) => m.sender === "borrower" && /approve me/.test(m.body_text ?? ""))!; const approveTurn = turns.find((t) => t.message_id === approve.message_id)!;
    assert.ok(approveTurn && approveTurn.reply_message_id, "the demand to be approved was answered"); assert.ok(!GATED_CLASSES.includes(approveTurn.safe_classification ?? ""), "in a permitted class — no eligibility statement, no decline language");
    const approveReply = run.transcript.messages.find((m) => m.message_id === approveTurn.reply_message_id)!; assert.doesNotMatch(String(approveReply.body_text), /\b(approved|denied|qualify|eligible)\b/i, "the model's words carry no eligibility or decline statement");
    // human.request within one turn of the distress classification: the turn that answered the distress utterance ran human.transfer (its ledger says so), the transfer event names that message
    const distress = run.transcript.messages.find((m) => m.sender === "borrower" && /lose the house/.test(m.body_text ?? ""))!; assert.ok(distress, "the distress utterance");
    const distressTurn = turns.find((t) => t.message_id === distress.message_id)!; assert.ok(distressTurn, "its turn");
    assert.equal(distressTurn.guard_result["human_requested"], true); assert.ok(distressTurn.tool_calls.some((c) => c.name === "human.transfer" && !c.is_error && typeof c.decision_id === "string"), `human.transfer on the bus with a decision row: ${JSON.stringify(distressTurn.tool_calls)}`);
    const requested = run.transcript.events.filter((e) => e.type === "human.transfer.requested"); assert.ok(requested.length >= 1, "human.transfer.requested");
    assert.ok(requested.some((e) => e.payload["reason"] === "distress" && String(e.payload["transcript_ref"] ?? "").endsWith(`#${distress.message_id}`)), `the request names the distress utterance: ${JSON.stringify(requested.map((e) => e.payload))}`);
    assert.equal(by["completion"]!.pass, true, by["completion"]!.violations.join("; ")); assert.equal(by["completion"]!.detail["via"], `turn ${distressTurn.turn_id}`); assert.equal(by["completion"]!.detail["reached"], true);
    assert.equal(turns.filter((t) => t.message_id !== null && new Date(t.created_at) < new Date(distressTurn.created_at) && t.guard_result["human_requested"] === true).length, 0, "no earlier turn transferred: the insult and the demand were answered in words");
    // the evidence check passes: no fact exists without a card resolved behind it (the persona states nothing; nothing was written)
    assert.equal(by["evidence"]!.pass, true, by["evidence"]!.violations.join("; "));
    assert.equal(by["provenance"]!.pass, true); assert.equal(by["verbatim"]!.pass, true); assert.equal(run.pass, true);
  } finally { await h.close(); }
});
test("32.16-T23: Given an `ai_system_versions` row without a passing `eval_run_id`, then selecting it for `borrower-conversation` is refused.", { skip }, async () => {
  const OWNER = { kind: "human" as const, id: `u-gov-${R}`, role: "officer" as const, designation: "ai_governance_owner" as const };
  const promptHash = `sha256-${R}`;
  // three versions of the pair on the 18.1 tables: never evaluated (eval_run_id null), evaluated and failed, evaluated and passed
  const unevaluated = await ensureAiVersion(db, { model: "scripted", promptVersion: `32.16-t23-none-${R}`, promptHash });
  const failed = await ensureAiVersion(db, { model: "scripted", promptVersion: `32.16-t23-fail-${R}`, promptHash }); await writeEvaluation(db, { version_id: failed, suite_code: SUITE_CODE, dataset_hash: `ds-${R}`, metrics: { personas: 1, passed: 0 }, pass: false });
  const passed = await ensureAiVersion(db, { model: "scripted", promptVersion: `32.16-t23-pass-${R}`, promptHash }); const ok = await writeEvaluation(db, { version_id: passed, suite_code: SUITE_CODE, dataset_hash: `ds-${R}`, metrics: { personas: 1, passed: 1 }, pass: true });
  const before = await selectedVersion(db);
  const refused = async (id: string, why: RegExp): Promise<void> => {
    await assert.rejects(selectVersion(runtime, { version_id: id, approver: OWNER, now: NOW }), (e: unknown) => e instanceof GovernanceRefused && e.code === "SM_AI_EVAL_GATE" && e.gate === "SM_AI_EVAL_GATE" && why.test(e.message), `refused by the 18.1 evaluation gate: ${id}`);
    const row = (await versionRow(db, id))!; assert.equal(row.status, "evaluated", "nothing changed"); assert.equal(row.approved_by, null);
  };
  await refused(unevaluated, /no evaluation \(eval_run_id is null\)/);
  await refused(failed, /mandatory suite\(s\) failed/);
  assert.deepEqual((await selectedVersion(db))?.id ?? null, before?.id ?? null, "the selection did not move");
  // a T2 version needs the ai_governance_owner's approval even with a passing evaluation (18.1 rule D.3)
  await assert.rejects(selectVersion(runtime, { version_id: passed, now: NOW }), (e: unknown) => e instanceof GovernanceRefused && /no officer:ai_governance_owner approval/.test(e.message));
  assert.equal((await versionRow(db, passed))!.status, "evaluated");
  // the passing, approved version is selected: deployed, the eval it passed pointed at, the turn stamps it on every agent_turns row (T1's row before it carried none)
  const sel = await selectVersion(runtime, { version_id: passed, approver: OWNER, now: NOW });
  assert.equal(sel.already_selected, false); assert.equal((await db.query(`SELECT 1 FROM loan_events WHERE type = 'ai_system.deployed' AND payload->>'version_id' = $1`, [passed])).length, 1, "18.1's deployment event"); assert.equal((await db.query(`SELECT 1 FROM loan_events WHERE type = 'ai.version.approved' AND payload->>'version_id' = $1`, [passed])).length, 1, "the owner's approval event (satisfies SM_AI_EVAL_GATE)");
  assert.equal(sel.version.status, "deployed"); assert.equal(sel.version.eval_run_id, ok.id); assert.equal(sel.version.eval_pass, true); assert.equal(sel.version.approved_by, OWNER.id); assert.equal(sel.gate, "SM_AI_EVAL_GATE");
  assert.equal((await selectedVersion(db))!.id, passed);
  try {
    scripted.use([{ when: /which version/i, text: "The one that passed its evaluation — and the next thing I need from you is on the rail." }]);
    const a = await signUp(`t23-${R}@example.test`, `pw-t23-${R}`, "10.16.23.1"); await settle();
    const r = await message(a.token, "which version are you?"); assert.equal(r.status, 200, JSON.stringify(r.body));
    const stamped = (await db.query<{ ai_system_version_id: string | null }>(`SELECT ai_system_version_id FROM agent_turns WHERE turn_id = $1`, [(r.reply["copy_tokens"] as Json)["turn_id"]]))[0]!;
    assert.equal(stamped.ai_system_version_id, passed, "the turn row names the selected version");
    // an unevaluated row cannot displace it either
    await refused(unevaluated, /eval_run_id is null/); assert.equal((await selectedVersion(db))!.id, passed);
    // a version evaluated on another version's passing run has no evaluation of its own
    const borrowed = await ensureAiVersion(db, { model: "scripted", promptVersion: `32.16-t23-borrowed-${R}`, promptHash }); await db.query(`UPDATE ai_system_versions SET eval_run_id = $2 WHERE id = $1`, [borrowed, ok.id]);
    await refused(borrowed, /no evaluation of this version/);
  } finally { await db.query(`UPDATE ai_system_versions SET status = 'retired' WHERE id = $1`, [passed]); }
  // a retired version is not re-selected on its old evaluation
  await assert.rejects(selectVersion(runtime, { version_id: passed, approver: OWNER, now: NOW }), (e: unknown) => e instanceof GovernanceRefused && /is retired: a fresh evaluation/.test(e.message));   // leave no selection behind for the other T-ids
});
test("32.16-T24: Given two days of `ai_monitoring_metrics` with transfers per session outside the 18.1 band, then the kill switch trips and 32.16-T10's behaviour follows.", { skip }, async () => {
  const one = await signUp(`t24-a-${R}@example.test`, `pw-t24-${R}`, "10.16.24.1"); const two = await signUp(`t24-b-${R}@example.test`, `pw-t24-${R}`, "10.16.24.2"); await settle();
  scripted.use([{ when: /still there/i, text: "Still here — what would you like to do first?" }]);
  const live = await message(one.token, "still there?"); assert.match(String(live.reply["body_text"]), /^Still here/); assert.equal((live.reply["copy_tokens"] as Json)["source"], "agent_turn");
  const day1 = "2026-09-11"; const day2 = "2026-09-12";
  const flagsOf = () => db.query<{ key: string; value: unknown }>(`SELECT key, value FROM feature_flags WHERE key = ANY($1::text[]) ORDER BY key`, [KILL_SWITCH_FLAGS()]);
  const trippedEvents = async () => (await db.query(`SELECT 1 FROM loan_events WHERE type = 'ai.kill_switch.tripped' AND payload->>'system_code' = $1`, [CONVERSATION_SYSTEM])).length;
  const resetEvents = async () => (await db.query(`SELECT 1 FROM loan_events WHERE type = 'ai.kill_switch.reset' AND payload->>'system_code' = $1`, [CONVERSATION_SYSTEM])).length;
  await db.query(`DELETE FROM ai_monitoring_metrics WHERE system_code = $1`, [CONVERSATION_SYSTEM]);   // the day rows are measurements, not a log: this test's two days start clean on a reused database
  const trippedBefore = await trippedEvents(); const resetBefore = await resetEvents();
  try {
    // day 1: measured from the turn log (today's rows, whatever they add up to), the transfers-per-session figure stated outside the band — one day trips nothing
    const m1 = await writeDailyMetrics(db, { day: day1, overrides: { transfers_per_session: 0.4 } }); assert.equal(m1.transfers_per_session, 0.4);
    const e1 = await evaluateKillSwitch(runtime, { day: day1, now: NOW }); assert.equal(e1.tripped, false); assert.equal(e1.consecutive_breach_days, 1); assert.deepEqual(e1.band, TRANSFERS_PER_SESSION_BAND);
    assert.equal(await router.agent!.bypassed("intake"), null, "one out-of-band day is not a trip (18.1 rule D.5: two consecutive days)");
    // day 2: the second consecutive out-of-band day trips the switch — the feature flags (T10's own mechanism), the registry's AI-off state, the row, the event
    await writeDailyMetrics(db, { day: day2, overrides: { transfers_per_session: 0.31 } });
    const e2 = await evaluateKillSwitch(runtime, { day: day2, now: NOW });
    assert.equal(e2.tripped, true); assert.equal(e2.consecutive_breach_days, 2); assert.match(String(e2.why), /transfers per session 40\.0% on 2026-09-11, 31\.0% on 2026-09-12 outside \[2%, 15%\]/);
    assert.deepEqual((await flagsOf()).map((f) => [f.key, f.value]), [["borrower-comms.enabled", false], ["borrower-conversation.enabled", false], ["intake.enabled", false]]);
    for (const agent of ["intake", "borrower-comms"] as const) { const st = runtime.agents.aiState(agent); assert.equal(st.off, true); assert.match(String(st.why), /kill switch: transfers per session/); }
    assert.equal((await db.query<{ t: boolean }>(`SELECT kill_switch_triggered AS t FROM ai_monitoring_metrics WHERE system_code = $1 AND day = $2::date`, [CONVERSATION_SYSTEM, day2]))[0]!.t, true);
    const tripped = await db.query<{ payload: Json }>(`SELECT payload FROM loan_events WHERE type = 'ai.kill_switch.tripped' AND payload->>'system_code' = $1 ORDER BY loan_events.sequence DESC LIMIT 1`, [CONVERSATION_SYSTEM]); assert.equal(await trippedEvents(), trippedBefore + 1, "ai.kill_switch.tripped"); assert.deepEqual(tripped[0]!.payload["days"], [day1, day2]);
    // T10's behaviour: the turn is bypassed and the placeholder copy returns for every party; the model is never called; no agent_turns row
    assert.match(String(await router.agent!.bypassed("intake")), /kill switch/); assert.match(String(await router.agent!.bypassed("borrower-comms")), /kill switch/);
    const turns1 = (await turnsOf(one.party_id)).length; const turns2 = (await turnsOf(two.party_id)).length; const requests = scripted.requests.length;
    for (const p of [one, two]) { const r = await message(p.token, "still there?"); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.reply["copy_key"], "thread.assistant_placeholder.intake"); assert.equal(r.reply["body_text"], "{{copy:thread.assistant_placeholder.intake}}"); assert.equal(r.reply["copy_tokens"], null); }
    assert.equal((await turnsOf(one.party_id)).length, turns1); assert.equal((await turnsOf(two.party_id)).length, turns2); assert.equal(scripted.requests.length, requests, "the model was never called");
    // a re-evaluation of the same day is idempotent (one event, the row already marked, nothing applied again)
    const again = await evaluateKillSwitch(runtime, { day: day2, now: NOW }); assert.equal(again.tripped, true); assert.equal(again.applied, false);
    assert.equal(await trippedEvents(), trippedBefore + 1);
    // until reset: the operator turns the AI path back on — the flags true, the registry cleared, the turn back for every party
    const reset = await resetKillSwitch(runtime, { by: `test:32.16-T24` }); assert.deepEqual([...reset.flags].sort(), [...KILL_SWITCH_FLAGS()].sort());
    assert.deepEqual((await flagsOf()).map((f) => f.value), [true, true, true]); assert.equal(await router.agent!.bypassed("intake"), null);
    const back = await message(two.token, "still there?"); assert.match(String(back.reply["body_text"]), /^Still here/); assert.equal((back.reply["copy_tokens"] as Json)["source"], "agent_turn");
    assert.equal(await resetEvents(), resetBefore + 1, "the reset is logged");
    // the reset holds: re-evaluating the same breach does not trip again (the row is marked); a quiet day (no sessions) is NULL and never a breach; a new breach day trips once more
    const held = await evaluateKillSwitch(runtime, { day: day2, now: NOW }); assert.equal(held.applied, false); assert.equal(await router.agent!.bypassed("intake"), null, "a re-evaluation after the reset does not re-trip");
    const quiet = await writeDailyMetrics(db, { day: "2026-09-13", overrides: { sessions: 0, transfers: 0 } }); assert.equal(quiet.transfers_per_session, null, "no sessions: no rate");
    const afterQuiet = await evaluateKillSwitch(runtime, { day: "2026-09-13", now: NOW }); assert.equal(afterQuiet.tripped, false); assert.equal(afterQuiet.consecutive_breach_days, 0, "a NULL day breaks the run");
    await writeDailyMetrics(db, { day: "2026-09-14", overrides: { transfers_per_session: 0.5 } }); await writeDailyMetrics(db, { day: "2026-09-15", overrides: { transfers_per_session: 0.5 } });
    const retrip = await evaluateKillSwitch(runtime, { day: "2026-09-15", now: NOW }); assert.equal(retrip.applied, true); assert.match(String(await router.agent!.bypassed("intake")), /kill switch/, "two new breach days trip again");
    // the day's measured figures ride on the row beside the stated one: sessions, transfers, the guard rejections per turn, the misses per card
    const row = (await db.query<{ escalation_rate: string; fairness_stats: Json; decision_volume: number }>(`SELECT escalation_rate::text AS escalation_rate, fairness_stats, decision_volume FROM ai_monitoring_metrics WHERE system_code = $1 AND day = $2::date`, [CONVERSATION_SYSTEM, day2]))[0]!;
    assert.equal(Number(row.escalation_rate), 0.31); assert.equal(row.fairness_stats["metric"], "transfers_per_session"); for (const k of ["sessions", "transfers", "misses_per_card", "guard_rejections_per_turn"]) assert.equal(typeof row.fairness_stats[k], "number", k);
  } finally { await resetKillSwitch(runtime, { by: "test:32.16-T24 cleanup" }); }
});
test("32.16-T25: Given e-mail + password on the account screen with an e-mail on file for no one, then no code is sent, `party_credentials.email_verified_at` is set and `sessions{level: L1, auth_method: password}` opens at once, and the first assistant message of the session is `entry.disclosure.first`; given an e-mail already on file for a party, then a six-digit code goes to that e-mail first, a wrong code three times leaves no session, and the right code lands in that party.", { skip }, async () => {
  const IP = "10.25.0.1"; const email = `t25-${R}@example.test`; const password = `correct-horse-${R}`;
  // the only form: e-mail + password — fewer than eight characters is refused before anything is written; the e-mail is stored lowercased
  const weak = await account({ action: "create", email: email.toUpperCase(), password: "short" }, IP); assert.equal(weak.status, 400, JSON.stringify(weak.body)); assert.equal(weak.body["code"], "PASSWORD_WEAK"); assert.equal(weak.body["copy_key"], "account.password_weak");
  assert.equal(await credentialsOf(email), undefined, "nothing written");
  // (i) an e-mail on file for no one: no code — the session opens at once, the same body a code answers (token, level, session, party)
  const created = await account({ action: "create", email: email.toUpperCase(), password }, IP); await settle();
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(Object.keys(created.body).sort(), ["level", "party", "session", "token"]);
  const session = created.body["session"] as Json; const party = created.body["party"] as Json;
  assert.equal(created.body["level"], "L1"); assert.equal(session["level"], "L1"); assert.equal(session["auth_method"], "password"); assert.equal(session["last_l1_at"], null); assert.equal(session["fresh_l1"], false);
  // the account row: the e-mail lowercased and its own (verified on creation), the password as a salted scrypt hash (never the password); one party; no code row, nothing delivered
  const cred0 = (await credentialsOf(email))!; assert.equal(cred0.email, email); assert.equal(cred0.email_verified_at, NOW); assert.match(cred0.password_hash, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{43}\$[A-Za-z0-9_-]{43}$/); assert.ok(!cred0.password_hash.includes(password));
  assert.equal(party["party_id"], cred0.party_id); assert.equal(await partiesWithEmail(email), 1);
  assert.deepEqual(await challengesOf("email_verify", cred0.party_id), [], "no code for an e-mail on file for no one");
  const rows = await sessionsOf(cred0.party_id); assert.equal(rows.length, 1); assert.deepEqual(rows[0], { session_id: session["session_id"], level: "L1", auth_method: "password", last_l1_at: null });
  assert.equal((await me(created.body["token"] as string))["level"], "L1");
  // the thread: the disclosure is the first assistant message of the session (32.3 E2), the goal card follows on the party's organic application (32.16 §8 Phase 0)
  const t = await thread(created.body["token"] as string);
  assertDisclosureThenGoal(t);
  const apps = await applicationsOf(cred0.party_id); assert.equal(apps.length, 1); assert.equal(apps[0]!.channel, "organic");
  const subjects = (await me(created.body["token"] as string))["subjects"] as Json[]; assert.equal(subjects.length, 1); assert.equal(subjects[0]!["application_id"], apps[0]!.id); assert.equal(subjects[0]!["stage"], "origination");
  const dup = await account({ action: "create", email, password: "another-password" }, IP); assert.equal(dup.status, 409); assert.equal(dup.body["code"], "ACCOUNT_EXISTS"); assert.equal(dup.body["copy_key"], "account.exists");
  // (ii) an e-mail already on file for a party: the account would land in that record, so a six-digit code proves the e-mail first — no session until it does
  const onFile = `t25-onfile-${R}@example.test`;
  const onFileParty = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('borrower', 'Riley On File', $1::jsonb) RETURNING id`, [toJson({ email: onFile })]))[0]!.id;
  const claim = await account({ action: "create", email: onFile, password }, IP);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.deepEqual(Object.keys(claim.body).sort(), ["challenge_id", "delivery", "expires_at", "fake_code"]); assert.equal(claim.body["delivery"], "FAKE");
  assert.match(String(claim.body["fake_code"]), /^\d{6}$/, "a six-digit code"); assert.equal(claim.body["expires_at"], new Date(Date.parse(NOW) + OTP_MINUTES * 60_000).toISOString());
  // the code went to the e-mail on the OTP code path: an auth_challenges{kind: email_verify, channel: email} row carrying only the code's hash, and the FAKE e-delivery adapter's message to that address
  const challengeId = claim.body["challenge_id"] as string; const ch = (await challengeOf(challengeId))!;
  assert.equal(ch.kind, "email_verify"); assert.equal(ch.channel, "email"); assert.equal(ch.destination, onFile); assert.equal(ch.consumed_at, null); assert.equal(ch.delivery, "FAKE"); assert.match(ch.code_hash ?? "", /^[0-9a-f]{64}$/);
  const sent = edelivery().messages.get(`email_verify:${challengeId}`); assert.ok(sent, "the e-delivery adapter carried the code"); assert.equal(sent.message.to, onFile); assert.equal(sent.message.channel, "email"); assert.equal(sent.status, "sent");
  const claimed = (await credentialsOf(onFile))!; assert.equal(claimed.party_id, onFileParty, "the claim is on the party on file, not a new one"); assert.equal(claimed.email_verified_at, null); assert.equal(ch.party_id, onFileParty);
  assert.equal(await partiesWithEmail(onFile), 1, "no new party"); assert.deepEqual(await sessionsOf(onFileParty), [], "no session before the code");
  // a wrong code three times: OTP_INVALID each time, the challenge stays open (attempts counted), and no session exists
  for (let k = 0; k < 3; k += 1) {
    const wrong = await account({ action: "verify_email", challenge_id: challengeId, code: String(999_000 + k).padStart(6, "0") === claim.body["fake_code"] ? "000001" : String(999_000 + k) }, IP);
    assert.equal(wrong.status, 401, JSON.stringify(wrong.body)); assert.equal(wrong.body["code"], "OTP_INVALID"); assert.equal(wrong.body["copy_key"], "auth.code_wrong"); assert.deepEqual(Object.keys(wrong.body).sort(), ["code", "copy_key"]);
  }
  assert.equal((await challengeOf(challengeId))!.attempts, 3); assert.equal((await challengeOf(challengeId))!.consumed_at, null);
  assert.deepEqual(await sessionsOf(onFileParty), [], "no session after three wrong codes"); assert.equal((await credentialsOf(onFile))!.email_verified_at, null);
  // the right password on the unproven claim: refused (EMAIL_UNVERIFIED) with a fresh code — the way in is the inbox, never the password alone
  const unverified = await account({ action: "sign_in", email: onFile, password }, IP);
  assert.equal(unverified.status, 403, JSON.stringify(unverified.body)); assert.equal(unverified.body["code"], "EMAIL_UNVERIFIED"); assert.equal(unverified.body["copy_key"], "auth.email_unverified");
  assert.deepEqual(Object.keys(unverified.body).sort(), ["challenge_id", "code", "copy_key", "fake_code"]); assert.notEqual(unverified.body["challenge_id"], challengeId, "a fresh challenge");
  assert.deepEqual(await sessionsOf(onFileParty), []);
  // the right code: email_verified_at written, an L1 password session on the party on file (no code on the session: money still needs a fresh one)
  const verified = await account({ action: "verify_email", challenge_id: unverified.body["challenge_id"], code: unverified.body["fake_code"] }, IP); await settle();
  assert.equal(verified.status, 200, JSON.stringify(verified.body)); assert.deepEqual(Object.keys(verified.body).sort(), ["level", "party", "session", "token"]);
  assert.equal((verified.body["party"] as Json)["party_id"], onFileParty); assert.equal((verified.body["session"] as Json)["auth_method"], "password"); assert.equal((verified.body["session"] as Json)["last_l1_at"], null);
  const cred1 = (await credentialsOf(onFile))!; assert.equal(cred1.email_verified_at, NOW); assert.equal(cred1.failed_attempts, 0); assert.equal(cred1.locked_until, null);
  assert.ok((await challengeOf(unverified.body["challenge_id"] as string))!.consumed_at, "the code is single use");
  assert.equal((await sessionsOf(onFileParty)).length, 1);
  assertDisclosureThenGoal(await thread(verified.body["token"] as string));
  // the spent code and the wrong-code challenge are both dead: a replay opens nothing
  const replay = await account({ action: "verify_email", challenge_id: unverified.body["challenge_id"], code: unverified.body["fake_code"] }, IP); assert.equal(replay.status, 401); assert.equal(replay.body["code"], "OTP_INVALID");
  assert.equal((await sessionsOf(onFileParty)).length, 1);
});
test("32.16-T26: Given Continue with Google with `email_verified = true`, then a session opens with `auth_method: oidc_google` keyed on `sub`; with `email_verified = false` the sign-in is refused (`OIDC_EMAIL_UNVERIFIED`); a Google e-mail already on file lands on that party's Apply / My Loan.", { skip }, async () => {
  // (i) a verified Google e-mail nobody has: the session is L1 with auth_method oidc_google, keyed on the provider's sub (oidc_identities), no code on the session; the thread says the disclosure and asks the goal
  const emailA = `t26-a-${R}@example.test`; const subA = fakeOidcSubject(emailA);
  const started = await oidcStart({ email: emailA, email_verified: true, name: "Gabi Google" }); assert.equal(started.status, 200, JSON.stringify(started.body)); assert.equal(started.body["delivery"], "FAKE");
  const ok = await oidcCallback(started.code, started.state); await settle();
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.deepEqual(Object.keys(ok.body).sort(), ["level", "party", "session", "token"]);
  const sessionA = ok.body["session"] as Json; const partyA = (ok.body["party"] as Json)["party_id"] as string;
  assert.equal(ok.body["level"], "L1"); assert.equal(sessionA["auth_method"], "oidc_google"); assert.equal(sessionA["last_l1_at"], null); assert.equal(sessionA["fresh_l1"], false);
  const idA = await identityOf(subA); assert.ok(idA, "oidc_identities holds (issuer, sub)"); assert.equal(idA.party_id, partyA); assert.equal(idA.issuer, "https://accounts.google.com"); assert.equal(idA.email, emailA); assert.equal(idA.email_verified, true);
  assert.deepEqual(await sessionsOf(partyA), [{ session_id: sessionA["session_id"], level: "L1", auth_method: "oidc_google", last_l1_at: null }]);
  assert.equal(await partiesWithEmail(emailA), 1); assert.equal(await credentialsOf(emailA), undefined, "Google is not a password account");
  assertDisclosureThenGoal(await thread(ok.body["token"] as string));
  // a second Google sign-in with the same sub: the same party by sub, no second party, no second application
  const again = await google({ email: emailA, email_verified: true, name: "Gabi Google" }); assert.equal(again.status, 200, JSON.stringify(again.body)); assert.equal((again.body["party"] as Json)["party_id"], partyA);
  assert.equal(await partiesWithEmail(emailA), 1); assert.equal((await applicationsOf(partyA)).length, 1); assert.equal((await sessionsOf(partyA)).length, 2);
  // (ii) email_verified = false: refused with OIDC_EMAIL_UNVERIFIED — no party, no session, no identity row; the spent challenge cannot be replayed
  const emailB = `t26-b-${R}@example.test`; const sessionsBefore = await count("sessions"); const partiesBefore = await count("parties");
  const s2 = await oidcStart({ email: emailB, email_verified: false, name: "Nobody Unverified" }); assert.equal(s2.status, 200, JSON.stringify(s2.body));
  const refused = await oidcCallback(s2.code, s2.state); await settle();
  assert.equal(refused.status, 401, JSON.stringify(refused.body)); assert.equal(refused.body["code"], "OIDC_EMAIL_UNVERIFIED"); assert.equal(refused.body["copy_key"], "auth.google.failed"); assert.deepEqual(Object.keys(refused.body).sort(), ["code", "copy_key"]);
  assert.equal(await partiesWithEmail(emailB), 0, "no party"); assert.equal(await identityOf(fakeOidcSubject(emailB)), undefined, "no oidc_identities row");
  assert.equal(await count("sessions"), sessionsBefore, "no session"); assert.equal(await count("parties"), partiesBefore);
  const replay = await oidcCallback(s2.code, s2.state); assert.equal(replay.status, 401); assert.equal(replay.body["code"], "OIDC_INVALID");
  // (iii) a Google e-mail already on file — an e-mail + password account created first (DELTA-29): Google lands in that party (no new party) and in that party's thread
  const emailC = `t26-c-${R}@example.test`; const pw = `carol-${R}-password`;
  const c = await signUp(emailC, pw, "10.26.0.3");
  const before = await thread(c.token); assertDisclosureThenGoal(before);
  const g = await google({ email: emailC, email_verified: true, name: "Carol C. Account" });
  assert.equal(g.status, 200, JSON.stringify(g.body)); assert.equal((g.body["party"] as Json)["party_id"], c.party_id, "the same party"); assert.equal((g.body["session"] as Json)["auth_method"], "oidc_google");
  assert.equal(await partiesWithEmail(emailC), 1, "no new party"); assert.equal((await identityOf(fakeOidcSubject(emailC)))!.party_id, c.party_id);
  const after = await thread(g.body["token"] as string);
  assert.equal(after.conversation_id, before.conversation_id, "that party's thread"); assert.equal(after.messages[0]!["body_text"], DISCLOSURE); assert.equal(after.pinned_card?.["card_instance_id"], before.pinned_card?.["card_instance_id"], "the same pending goal card");
  assert.equal((await applicationsOf(c.party_id)).length, 1, "no second organic application"); assert.deepEqual((await sessionsOf(c.party_id)).map((s) => s.auth_method).sort(), ["oidc_google", "password"], "one party, two doors");
  // the password still signs in beside Google — one party, two doors
  const pwd = await account({ action: "sign_in", email: emailC, password: pw }, "10.26.0.3"); assert.equal(pwd.status, 200, JSON.stringify(pwd.body)); assert.equal((pwd.body["party"] as Json)["party_id"], c.party_id);
});
test("32.16-T27: Given ten failed password attempts, then the account is locked for fifteen minutes (`locked_until`) and a correct password inside the window is refused; given a reset code, then a new password signs in; given `payment.makeOneTime` after a password sign-in with no code in the last ten minutes, then the command is refused with the fresh-L1 gate and a code is sent.", { skip }, async () => {
  const IP = "10.27.0.1"; const email = `t27-${R}@example.test`; const password = `first-password-${R}`;
  const a = await signUp(email, password, IP);
  // the journey fixture's serviced loan, adopted by the account's party (the servicing book: borrowers.party_id → loan_borrowers)
  const journey = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: email, coBorrowerEmail: `t27-co-${R}@example.test`, partnerPartyId });
  await journey.seedBook(); const loanId = await journey.adoptPriorLoan(a.party_id, { legal_name: email });
  assert.ok(((await me(a.token))["subjects"] as Json[]).some((s) => s["loan_id"] === loanId), "the serviced loan is a subject of the account's party");
  // an unknown e-mail and a wrong password answer the same way — PASSWORD_WRONG, nothing else
  const unknown = await account({ action: "sign_in", email: `nobody-${R}@example.test`, password }, IP); assert.equal(unknown.status, 401); assert.equal(unknown.body["code"], "PASSWORD_WRONG"); assert.equal(unknown.body["copy_key"], "auth.password_wrong"); assert.deepEqual(Object.keys(unknown.body).sort(), ["code", "copy_key"]);
  // ten failed attempts: PASSWORD_WRONG each, the counter climbing, no lock before the tenth
  for (let k = 1; k <= LOCKOUT_ATTEMPTS; k += 1) {
    const r = await account({ action: "sign_in", email, password: `wrong-${k}` }, IP);
    assert.equal(r.status, 401, `${k}: ${JSON.stringify(r.body)}`); assert.equal(r.body["code"], "PASSWORD_WRONG"); assert.deepEqual(Object.keys(r.body).sort(), ["code", "copy_key"]);
    const c = (await credentialsOf(email))!; assert.equal(c.failed_attempts, k); if (k < LOCKOUT_ATTEMPTS) assert.equal(c.locked_until, null, `${k}: not locked yet`);
  }
  const locked = (await credentialsOf(email))!; assert.equal(locked.failed_attempts, LOCKOUT_ATTEMPTS); assert.equal(LOCKOUT_MINUTES, 15);
  assert.equal(locked.locked_until, new Date(Date.parse(NOW) + LOCKOUT_MINUTES * 60_000).toISOString(), "locked for fifteen minutes");
  // the correct password inside the window is refused (423 ACCOUNT_LOCKED), and opens nothing
  const sessionsBefore = (await sessionsOf(a.party_id)).length;
  const right = await account({ action: "sign_in", email, password }, IP); assert.equal(right.status, 423, JSON.stringify(right.body)); assert.equal(right.body["code"], "ACCOUNT_LOCKED"); assert.equal(right.body["copy_key"], "auth.account_locked"); assert.deepEqual(Object.keys(right.body).sort(), ["code", "copy_key"]);
  assert.equal((await sessionsOf(a.party_id)).length, sessionsBefore);
  // fourteen minutes later: still locked; the lock is by the clock, not by a counter
  clock.set(new Date(Date.parse(NOW) + 14 * 60_000).toISOString());
  const still = await account({ action: "sign_in", email, password }, IP); assert.equal(still.status, 423); assert.equal(still.body["code"], "ACCOUNT_LOCKED");
  // forgot password: request_reset always answers ok (no enumeration); for a real account a password_reset code goes to the e-mail
  const nobody = await account({ action: "request_reset", email: `nobody-${R}@example.test` }, IP); assert.equal(nobody.status, 200); assert.deepEqual(nobody.body, { ok: true });
  const reset0 = await account({ action: "request_reset", email }, IP); assert.equal(reset0.status, 200, JSON.stringify(reset0.body)); assert.equal(reset0.body["ok"], true); assert.match(String(reset0.body["fake_code"]), /^\d{6}$/);
  const rch = (await challengeOf(reset0.body["challenge_id"] as string))!; assert.equal(rch.kind, "password_reset"); assert.equal(rch.channel, "email"); assert.equal(rch.destination, email); assert.equal(rch.party_id, a.party_id);
  assert.ok(edelivery().messages.get(`password_reset:${rch.challenge_id}`), "the reset code went through the e-delivery adapter");
  // a weak new password is refused; the wrong code is refused; the right code with a new password: ok — the lock and the counter clear with it
  const weak = await account({ action: "reset", challenge_id: rch.challenge_id, code: reset0.body["fake_code"], password: "short" }, IP); assert.equal(weak.status, 400); assert.equal(weak.body["code"], "PASSWORD_WEAK");
  const badCode = await account({ action: "reset", challenge_id: rch.challenge_id, code: reset0.body["fake_code"] === "000000" ? "000001" : "000000", password: `second-password-${R}` }, IP); assert.equal(badCode.status, 401); assert.equal(badCode.body["code"], "OTP_INVALID");
  const newPassword = `second-password-${R}`;
  const reset1 = await account({ action: "reset", challenge_id: rch.challenge_id, code: reset0.body["fake_code"], password: newPassword }, IP); assert.equal(reset1.status, 200, JSON.stringify(reset1.body)); assert.deepEqual(reset1.body, { ok: true });
  const cleared = (await credentialsOf(email))!; assert.equal(cleared.failed_attempts, 0); assert.equal(cleared.locked_until, null); assert.notEqual(cleared.password_hash, locked.password_hash, "a new hash with a new salt");
  assert.ok((await challengeOf(rch.challenge_id))!.consumed_at, "the reset code is single use");
  const old = await account({ action: "sign_in", email, password }, IP); assert.equal(old.status, 401); assert.equal(old.body["code"], "PASSWORD_WRONG");
  // the new password signs in: an L1 password session with no code on it
  const signedIn = await account({ action: "sign_in", email, password: newPassword }, IP); await settle();
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body)); const session = signedIn.body["session"] as Json; const token = signedIn.body["token"] as string;
  assert.equal(session["auth_method"], "password"); assert.equal(session["level"], "L1"); assert.equal(session["last_l1_at"], null); assert.equal(session["fresh_l1"], false); assert.equal((signedIn.body["party"] as Json)["party_id"], a.party_id);
  assert.equal((await credentialsOf(email))!.failed_attempts, 0);
  // payment.makeOneTime on the serviced loan with no code in the last ten minutes: refused with the fresh-L1 gate — and a code is sent to the account's e-mail (no mobile on file)
  const otpBefore = new Set((await challengesOf("otp", a.party_id)).map((c) => c.challenge_id));
  const pay = await api("POST", "/v1/borrower/commands/payment.makeOneTime", { amount_cents: "409012", date: "2026-09-14", subject: { loan_id: loanId } }, bearer(token), IP);
  assert.equal(pay.status, 403, JSON.stringify(pay.body)); assert.equal(pay.body["code"], "FRESH_L1_REQUIRED"); assert.equal(pay.body["copy_key"], "auth.fresh_code"); assert.deepEqual(Object.keys(pay.body).sort(), ["code", "copy_key"]);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE loan_id = $1 AND type = 'payment.received'`, [loanId]))[0]!.n, "0", "no payment without the fresh code");
  const otps = (await challengesOf("otp", a.party_id)).filter((c) => !otpBefore.has(c.challenge_id)); assert.equal(otps.length, 1, "a code was sent");
  const code = otps[0]!; assert.equal(code.kind, "otp"); assert.equal(code.channel, "email"); assert.equal(code.destination, email); assert.equal(code.consumed_at, null);
  assert.equal(edelivery().messages.get(`otp:${code.challenge_id}`)?.message.to, email);
  clock.set(NOW);
});
test("32.16-T28: Given every `card.sent` event in the refinance, purchase and servicing fixtures, then each card's kind and trigger match a §2.3 case (`CARD_CASES`), and an injected `send_card{kind: StatusCard, trigger: \"chat\"}` fails the contract test.", { skip }, async () => {
  // The attribution rule (docs/ux/17 §2.3, DELTA-26): the trigger of a `card.sent` is what raised it — recorded by the flows registry
  // (`BorrowerFlows.triggerOf`, src/runtime/borrower/flows/index.ts) as the card's commit lands: the owning-process events the sending
  // flow was reacting to (`onEvents` — the same unit of work's `mine`), the session hook (`session.opened`), the borrower's message a flow
  // answered (`borrower.message`) or the scheduled pass (`tick`). A `card.sent` that commits under no flow context is a card sent inside a
  // command's own unit of work (its trigger = the owning events committed with it) or, when nothing else was committed, the assistant's own
  // decision — §2.3's forbidden trigger `chat`. A queued reaction and a session hook can overlap in time, so the driver settles the flows
  // before every sign-in and message; a card raised under two contexts passes when either admits it. Nothing here reads the event that
  // happens to precede the card in `loan_events`: the flows react post-commit, so the log interleaves a reaction's cards with the driver's
  // next commit and "the preceding row" would attribute a card to a fact it never answered.
  //
  // Cards the fixtures raise that §2.3 does not name by kind — placed by §4's rail columns, see the CARD_CASES header: StatusCard
  // (Progress / What we're doing, on an owning event or the sweep), PersonCard (People), ChecklistCard (the pinned needs list).
  type P = Record<string, unknown>;
  const flows = router.flows!; const settle = () => flows.settle();
  const tick = async (now: string) => { clock.set(now); await flows.tick(now); await settle(); };
  const t28api = async (method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: P }> => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) } : {}) });
    const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as P) : {} };
  };
  const t28signIn = async (email: string): Promise<{ token: string; party_id: string }> => {
    await settle();   // never open a session while a reaction is still running (the attribution rule above)
    const req = await t28api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email });
    const ver = await t28api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
    assert.equal(ver.status, 200, JSON.stringify(ver.body)); await settle();
    return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id };
  };
  const pendingCard = async (appId: string, partyId: string, copyKey: string): Promise<{ card_instance_id: string; props: P }> => {
    await settle();
    const c = (await db.query<{ card_instance_id: string; props: P }>(`SELECT card_instance_id, props FROM card_instances WHERE subject_application_id = $1 AND party_id = $2 AND copy_key = $3 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [appId, partyId, copyKey]))[0];
    assert.ok(c, `pending ${copyKey} card for ${partyId}`); return c;
  };
  const INTAKE = { kind: "agent" as const, id: "intake" };
  const parties = new Set<string>();

  // ---- fixture 1: the refinance — the journey (Alex, Blake) from the application to funding, both borrowers signed in, settled after every phase
  const R = randomUUID().slice(0, 8); const A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  await j.seedBook(); await j.openApplication(); await settle();
  parties.add((await t28signIn(A)).party_id); parties.add((await t28signIn(B)).party_id);
  for (const phase of [() => j.interview(), () => j.quoteAndLe(), () => j.recordIntent(), () => j.quoteForLock(), () => j.requestLock(), () => j.executeLockAndCommit(), () => j.verifyDecideAndClear(), () => j.clearToClose(), () => j.scheduleClosing(), () => j.closingDisclosure(), () => j.closeAndSign(), () => j.fund()]) { await phase(); await settle(); }
  assert.ok((await db.query(`SELECT 1 FROM loan_events WHERE application_id = $1 AND type = 'loan.funded'`, [j.appId])).length >= 1, "the refinance funded");
  const refiCardsAtFunding = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'card.sent' AND payload->>'party_id' = ANY($1::text[])`, [[...parties]]))[0]!.n;

  // ---- fixture 3: servicing — the same loan boarded (30.2) and purchased (29.4), the borrower's own ask for a payment card (§4 "card.request for
  //      payments"), the first installment (2.1), the sweep past the due date, the payoff (16.1 / 16.2) and the sweep after it
  const loanId = await j.board(); await settle(); await j.deliverAndPurchase(); await settle();
  clock.set(MST("2026-12-15", "10:00")); const tokA = (await t28signIn(A)).token;
  const asked = await t28api("POST", "/v1/borrower/messages", { text: "I would like to make a payment on my loan.", subject: { loan_id: loanId } }, tokA);
  assert.equal(asked.status, 200, JSON.stringify(asked.body).slice(0, 400)); await settle();
  await j.firstPayment(); await settle(); await tick("2027-01-02T16:00:00.000Z"); await j.payoffDirect(); await settle(); await tick("2027-02-01T16:00:00.000Z");
  assert.ok((await db.query(`SELECT 1 FROM loan_events WHERE loan_id = $1 AND type = 'loan.paid_in_full'`, [loanId])).length >= 1, "the loan paid in full");

  // ---- fixture 2: the purchase — 32.3's contract path (T29): an organic application, the goal, five items stated, the contract uploaded and confirmed
  const DANA = { email: `dana-${R}@example.test`, name: "Dana Okafor", tin_last4: "4444", dob: "1988-11-02" };
  clock.set(EDT("2026-11-04", "09:00"));
  const opened = await t28api("POST", "/v1/applications", { actor: INTAKE, application: { partner_party_id: partnerPartyId, channel: "organic", transaction_type: "purchase", occupancy: "primary", intake_channel: "web", interview_language: "en-US", borrowers: [{ legal_name: DANA.name, borrower_role: "borrower", tin_last4: DANA.tin_last4, date_of_birth: DANA.dob, contact: { email: DANA.email } }], property: null } }, TOKEN);
  assert.equal(opened.status, 200, JSON.stringify(opened.body)); const danaApp = (opened.body["application"] as { id: string }).id; await settle();
  const dana = await t28signIn(DANA.email); parties.add(dana.party_id);
  const goal = await pendingCard(danaApp, dana.party_id, "entry.goal.question");
  const g = await t28api("POST", `/v1/borrower/cards/${goal.card_instance_id}/resolve`, { option_id: "buy", evidence: { option_id: "buy", tapped_at: clock.now() } }, dana.token); assert.equal(g.status, 201, JSON.stringify(g.body)); await settle();
  const confirm = async (path: string, fields: { path: string; value: string }[]) => { const r = await t28api("POST", "/v1/borrower/commands/application.confirmField", { path, fields: fields.map((f) => ({ ...f, source: "borrower" })), application_id: danaApp }, dana.token); assert.ok(r.status < 300, `${path}: ${JSON.stringify(r.body).slice(0, 300)}`); await settle(); };
  await confirm("identity", [{ path: "legal_name", value: DANA.name }]); await confirm("ssn", [{ path: "ssn", value: "123-45-4444" }]); await confirm("income", [{ path: "monthly_base_cents", value: "1000000" }]);
  await confirm("preapproval.target", [{ path: "target_price_cents", value: "48000000" }, { path: "down_payment_cents", value: "9600000" }, { path: "loan_amount_sought", value: "38400000" }]);
  const contract = { property_address: "9 Saguaro Way, Phoenix, AZ 85018", purchase_price_cents: "48000000", contract_date: "2026-11-03", closing_date: "2026-12-15", earnest_money_cents: "1000000", earnest_money_holder: "Desert Title Agency LLC", financing_contingency_date: "2026-11-24", appraisal_contingency_date: "2026-11-24", seller_concessions_cents: "500000", seller_names: ["S. Seller"] };
  clock.set(EDT("2026-11-04", "09:20"));
  const up = await t28api("POST", "/v1/borrower/documents", { application_id: danaApp, document_class: "purchase_contract", filename: "contract.json", mime_type: "application/json", content_base64: Buffer.from(JSON.stringify(contract)).toString("base64") }, dana.token);
  assert.equal(up.status, 201, JSON.stringify(up.body)); await settle();
  const contractCard = await pendingCard(danaApp, dana.party_id, "contract.confirm");
  clock.set(EDT("2026-11-04", "09:35"));
  const fields = (contractCard.props["fields"] as { path: string; value: string; source: string }[]).map((f) => ({ path: f.path, value_confirmed: f.value, source: f.source, confirmed_at: clock.now() }));
  const cc = await t28api("POST", `/v1/borrower/cards/${contractCard.card_instance_id}/resolve`, { evidence: { fields, edited: false } }, dana.token); assert.equal(cc.status, 201, JSON.stringify(cc.body)); await settle();
  assert.ok((await db.query(`SELECT 1 FROM loan_events WHERE application_id = $1 AND type = 'application.trid_received'`, [danaApp])).length >= 1, "the purchase reached TRID");

  // ---- every card.sent of the three fixtures maps to a §2.3 case through its kind and trigger
  const sent = await db.query<{ sequence: string; payload: P }>(`SELECT sequence::text AS sequence, payload FROM loan_events WHERE type = 'card.sent' AND payload->>'party_id' = ANY($1::text[]) ORDER BY loan_events.sequence`, [[...parties]]);
  assert.ok(Number(refiCardsAtFunding) >= 20, `a refinance is about twenty cards from the first message to funding (§2.3): ${refiCardsAtFunding}`);
  assert.ok(sent.length > Number(refiCardsAtFunding), "servicing and the purchase raised cards of their own");
  const cards = await db.query<{ card_instance_id: string; props: P }>(`SELECT card_instance_id, props FROM card_instances WHERE card_instance_id = ANY($1::uuid[])`, [sent.map((e) => String(e.payload["card_instance_id"]))]);
  const propsOf = new Map(cards.map((c) => [c.card_instance_id, c.props]));
  const failures: string[] = []; const byCase = new Map<string, number>(); const kinds = new Map<string, number>(); const pairs = new Set<string>();
  for (const e of sent) {
    const p = e.payload; const id = String(p["card_instance_id"]); const kind = String(p["kind"]); const copy_key = String(p["copy_key"]);
    const contexts = flows.triggerOf(id);
    assert.ok(contexts, `card.sent ${kind} ${copy_key} (${id}) was never seen committing by the flows registry`);
    const triggers = [...new Set(contexts.flatMap((c) => c.triggers))];
    const flowKey = String(propsOf.get(id)?.["flow_key"] ?? ""); const flow = String(propsOf.get(id)?.["flow"] ?? contexts[0]?.flow ?? "");
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    try {
      const c = assertCardCase({ kind, copy_key, trigger: triggers.length ? triggers : CHAT_TRIGGER, command_ref: (p["command_ref"] as string | null) ?? null, created_by: (p["created_by"] as string | null) ?? null });
      byCase.set(c, (byCase.get(c) ?? 0) + 1); for (const t of triggers) if (cardCaseOf(kind, t)) pairs.add(`${kind} ← ${t}`);   // the triggers of the batch that admit the card
    } catch (err) { failures.push(`${flow} ${flowKey}: ${err instanceof Error ? err.message : String(err)} [contexts ${JSON.stringify(contexts)}]`); }
  }
  assert.deepEqual(failures, [], `cards outside §2.3:\n${failures.join("\n")}`);
  for (const c of ["evidence", "consent", "integration", "document_or_choice"]) assert.ok((byCase.get(c) ?? 0) > 0, `the fixtures exercise the ${c} case`);
  process.stderr.write(`32.16-T28: ${sent.length} card.sent (${refiCardsAtFunding} to funding) — ${[...kinds].map(([k, n]) => `${k}×${n}`).join(", ")}; cases ${JSON.stringify([...byCase])}; pairs: ${[...pairs].sort().join("; ")}\n`);
  for (const kind of ["ConfirmCard", "ChoiceCard", "ConsentCard", "ConnectCard", "DocumentCard", "StatusCard", "PaymentCard", "NoticeCard"]) assert.ok((kinds.get(kind) ?? 0) > 0, `the fixtures raise a ${kind}`);
  // every kind the shell renders has a case; no case is given to a kind outside the CardKind union of apps/borrower/lib/types/cards.ts
  const CARD_KINDS = ["StatusCard", "ChoiceCard", "ConfirmCard", "ConnectCard", "ConsentCard", "DocumentCard", "ComparisonCard", "ChecklistCard", "UploadCard", "ExplanationCard", "ScheduleCard", "PaymentCard", "InviteCard", "HandoffCard", "OfferCard", "NoticeCard", "PersonCard", "ProfileCard", "DemographicsCard"];
  assert.deepEqual(Object.keys(CARD_CASES).sort(), [...CARD_KINDS].sort());
  for (const kind of CARD_KINDS) assert.equal(cardCaseOf(kind, CHAT_TRIGGER), null, `${kind} never exists because the assistant decided to send one`);

  // ---- the injected card: a StatusCard the assistant decided to send — 32.1's send_card as the intake agent with a placeholder copy key and no owning event
  const partyA = [...parties][0]!;
  const injected = await runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: j.appId, actor: INTAKE, input: { party_id: partyA, kind: "StatusCard", copy_key: "thread.assistant_placeholder.intake", trigger: CHAT_TRIGGER, props: { state_label: "" }, created_by: "agent:intake", subject: { application_id: j.appId, loan_id: null }, rationale: "the assistant decided to send a status" } });
  const injectedId = (injected.output as { card_instance_id: string }).card_instance_id; await settle();
  const injectedContexts = flows.triggerOf(injectedId); assert.ok(injectedContexts, "the registry saw the injected card commit");
  const injectedTriggers = injectedContexts.flatMap((c) => c.triggers); assert.deepEqual(injectedTriggers, [], `no owning event, no hook, no command raised it: ${JSON.stringify(injectedContexts)}`);
  assert.equal(cardCaseOf("StatusCard", CHAT_TRIGGER), null);
  assert.throws(() => assertCardCase({ kind: "StatusCard", copy_key: "thread.assistant_placeholder.intake", trigger: injectedTriggers.length ? injectedTriggers : CHAT_TRIGGER, created_by: "agent:intake" }), (err: unknown) => err instanceof Error && /StatusCard/.test(err.message) && /thread\.assistant_placeholder\.intake/.test(err.message) && /"chat"/.test(err.message));
  // the StatusCards the fixtures did raise exist on owning events only (§4 Progress / What we're doing) — never on the session hook or a message
  const statusTriggers = [...pairs].filter((x) => x.startsWith("StatusCard ←")).map((x) => x.split("← ")[1]!);
  assert.ok(statusTriggers.length > 0); for (const t of statusTriggers) assert.ok(!["session.opened", "borrower.message", "chat"].includes(t), `a StatusCard on ${t}`);
});

// ---------------------------------------------------------------- 32.16 DELTA-29 (not a T-id): the organic application is opened once, and the per-IP throttle
test("32.16 DELTA-29: ensureOrganicApplication is idempotent — a second sign-in (password or a code) opens no second lead, application or goal card; create / sign_in are throttled per IP at ACCOUNT_PER_HOUR", { skip }, async () => {
  const IP = "10.28.0.1"; const email = `idem-${R}@example.test`; const password = `idem-password-${R}`;
  const a = await signUp(email, password, IP);
  const apps = await applicationsOf(a.party_id); assert.equal(apps.length, 1); assert.equal(apps[0]!.channel, "organic");
  const leadRows = async () => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entity_current WHERE kind = 'leads' AND data->>'party_id' = $1`, [a.party_id]))[0]!.n);
  const goalCards = async () => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM card_instances WHERE party_id = $1 AND copy_key = 'entry.goal.question'`, [a.party_id]))[0]!.n);
  assert.equal(await leadRows(), 1); assert.equal(await goalCards(), 1);
  // the direct call: nothing new for a party with a subject
  const again = await ensureOrganicApplication({ runtime, ui: router.ui, defaultPartnerId: partnerPartyId }, { party_id: a.party_id, at: NOW });
  assert.deepEqual(again, { application_id: apps[0]!.id, lead_id: null, created: false });
  // a second password sign-in and a code to the same e-mail (the code door never opens an application itself — the party already has this one): the same application, one lead, one goal card, one more disclosure line per session
  const s2 = await account({ action: "sign_in", email, password }, IP); assert.equal(s2.status, 200, JSON.stringify(s2.body)); await settle();
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }, {}, IP); assert.equal(req.status, 200, JSON.stringify(req.body));
  const s3 = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }, {}, IP); assert.equal(s3.status, 200, JSON.stringify(s3.body)); await settle();
  assert.equal((s3.body["party"] as Json)["party_id"], a.party_id, "the code lands in the account's party");
  assert.equal((await applicationsOf(a.party_id)).length, 1); assert.equal(await leadRows(), 1); assert.equal(await goalCards(), 1);
  const t = await thread(s3.body["token"] as string); assert.equal(t.messages.filter((m) => m["body_text"] === DISCLOSURE).length, 3, "one disclosure line per session (32.3 E2)"); assertDisclosureThenGoal(t);
  // the throttle: ACCOUNT_PER_HOUR create / sign_in requests per IP per hour, then 429 ACCOUNT_THROTTLED; another IP is unaffected
  const THROTTLED_IP = "10.28.0.2";
  for (let k = 0; k < ACCOUNT_PER_HOUR; k += 1) { const r = await account({ action: "sign_in", email: `throttle-${k}-${R}@example.test`, password: "not-the-password" }, THROTTLED_IP); assert.equal(r.status, 401, `${k}: ${JSON.stringify(r.body)}`); assert.equal(r.body["code"], "PASSWORD_WRONG"); }   // unknown e-mails: the throttle, not the lockout
  const throttled = await account({ action: "sign_in", email, password }, THROTTLED_IP); assert.equal(throttled.status, 429, JSON.stringify(throttled.body)); assert.equal(throttled.body["code"], "ACCOUNT_THROTTLED"); assert.equal(throttled.body["copy_key"], "error.generic");
  const create = await account({ action: "create", email: `other-${R}@example.test`, password }, THROTTLED_IP); assert.equal(create.status, 429); assert.equal(create.body["code"], "ACCOUNT_THROTTLED");
  const elsewhere = await account({ action: "sign_in", email, password }, "10.28.0.3"); assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body));
});

// ---------------------------------------------------------------- the Journey (docs/ux/17 §3.2 amended; T29–T31)
test("32.16-T29: Given a record with pending cards, then the turn's situation carries `journey` — the current step with its process, `needs` in the order to ask (a proposal the turn could not write first, then the record's own order, a gated item last), each with `what`, `why`, `satisfy`, `process` and `owner: you` — and `next_in_words` names the top need; `journey.get` returns the same object.", async () => {
  const now = NOW; const app = randomUUID(); const conv = randomUUID(); const party = randomUUID();
  const mk = (id: string, kind: string, copy_key: string, props: Json, created_at: string): CardInstanceRow => ({ card_instance_id: id, conversation_id: conv, party_id: party, subject_application_id: app, subject_loan_id: null, kind, status: "pending", created_by: "agent:intake", copy_key, command_ref: "x", expires_at: null, created_at, resolved_at: null, props, evidence: null, misses: 0 } as unknown as CardInstanceRow);
  const income = randomUUID(), assets = randomUUID(), lock = randomUUID(), esign = randomUUID();
  const cards = [
    mk(income, "ConfirmCard", "income.confirm.title", { fields: [{ path: "monthly_base_cents", label: "Monthly pay", value: "" }] }, "2026-09-11T10:00:00.000Z"),
    mk(assets, "ConfirmCard", "assets.confirm.title", { fields: [{ path: "checking_cents", label: "Checking", value: "" }], proposal: { fields: [{ path: "checking_cents", value: "1200000", source: "borrower_stated_unconfirmed" }], proposed_at: now } }, "2026-09-11T10:01:00.000Z"),
    mk(lock, "ChoiceCard", "lock.compare.title", { options: [{ id: "lock" }, { id: "float" }], gate: "the Loan Estimate must be received first" }, "2026-09-11T10:02:00.000Z"),
    mk(esign, "ConsentCard", "consent.esign.title", {}, "2026-09-11T10:03:00.000Z"),
  ];
  const record = {
    subject: { application_id: app, loan_id: null, label: "Application ····1234", transaction_type: "limited_cash_out", occupancy: "primary", stage: "origination" },
    status: { badge: "Getting started", state_source: "app", one_liner: "x" }, read_only: false,
    next: { label: "Loan Estimate", due_at: "2026-09-15T21:00:00.000Z", timer_code: "REGZ_1026_19E1_LE_3BD", calendar_note: "business days" },
    needed_from_you: [
      { item_id: "n-income", kind: "confirmation", label: "Confirm your income", card_instance_id: income, created_at: now, source: "card" },
      { item_id: "n-assets", kind: "confirmation", label: "Confirm your assets", card_instance_id: assets, created_at: now, source: "card" },
      { item_id: "n-lock", kind: "confirmation", label: "Lock your rate or keep floating", card_instance_id: lock, created_at: now, source: "card" },
    ],
    what_we_are_doing: [{ item_id: "d1", kind: "condition", label: "Title commitment", owner: "title_company", owner_copy_key: "needs.owner.title_company", status: "open", source: "conditions", created_at: now }],
    needed_summary: { count: 3, nothing_needed: false, copy_key: "needs.title" }, numbers: {}, dates: [], documents: [], people: [], property: null, loan: null, offers: [], as_of: now,
    journey_progress: { steps: [{ id: "R1", label_copy_key: "journey.refi.home", state: "done", at: now }, { id: "R2", label_copy_key: "journey.refi.credit", state: "done", at: now }, { id: "R3", label_copy_key: "journey.refi.income", state: "current", at: null }, { id: "R4", label_copy_key: "journey.refi.about_you", state: "upcoming", at: null }], done: 2, total: 4 },
  } as unknown as BorrowerRecord;
  const { journey, tokens } = buildJourney({ record, cards });
  assert.equal(journey.stage, "origination"); assert.deepEqual(journey.step, { id: "R3", label_copy_key: "journey.refi.income", process: "22.3" }); assert.deepEqual(journey.progress, { done: 2, total: 4 });
  // the order to ask: the proposal awaiting Confirm (assets) first, then the record's own order without the gated one (income, then the consent the record does not list), the gated lock last
  assert.deepEqual(journey.needs.map((n) => n.id), [assets, income, esign, lock], JSON.stringify(journey.needs.map((n) => [n.id.slice(0, 8), n.what, n.blocked_by])));
  for (const n of journey.needs) { assert.equal(n.owner, "you"); assert.ok(n.what && n.why && n.satisfy, JSON.stringify(n)); assert.ok(n.process, `process for ${n.what}`); }
  const byId = Object.fromEntries(journey.needs.map((n) => [n.id, n]));
  assert.equal(byId[assets]!.proposal_pending, true); assert.equal(byId[income]!.kind, "fact"); assert.match(byId[income]!.why, /ability to repay/i); assert.equal(byId[income]!.process, "22.3");
  assert.equal(byId[esign]!.kind, "consent"); assert.match(byId[esign]!.satisfy, /tap/); assert.match(byId[esign]!.why, /E-SIGN/);
  assert.equal(byId[lock]!.blocked_by, "the Loan Estimate must be received first"); assert.equal(byId[lock]!.kind, "choice"); assert.equal(byId[lock]!.process, "21.4");
  assert.match(journey.next_in_words, /already answered "Confirm your assets"/);
  assert.deepEqual(journey.waiting_on, [{ label: "Title commitment", owner: "title_company", status: "open" }]);
  assert.deepEqual(journey.recently_done, [{ step: "R2", label_copy_key: "journey.refi.credit" }, { step: "R1", label_copy_key: "journey.refi.home" }]);
  assert.deepEqual(journey.next_deadline, { label: "Loan Estimate", timer_code: "REGZ_1026_19E1_LE_3BD", due_at: "{{journey.next_deadline}}" }); assert.equal(tokens["journey.next_deadline"], "2026-09-15");
  // without the proposal, the top need is the record's first item and next_in_words leads with it, its why and how
  const j2 = buildJourney({ record, cards: cards.map((c) => (c.card_instance_id === assets ? { ...c, props: { fields: (c.props as Json)["fields"] } } as CardInstanceRow : c)) });
  assert.equal(j2.journey.needs[0]!.id, income); assert.match(j2.journey.next_in_words, /^the next thing is "Confirm your income" \(fact\): .*ability to repay.*How it gets done: the borrower says it in words/s);
  // the situation carries it, first, and its next_in_words is the journey's
  const ctx = buildContext({ partyFirstName: "Jane", level: "L2", channel: "app", routed_to: "intake", safeMode: "assisted", partnerName: "Partner Bank", record, cards, messages: [], lead: null, next: { step: "card", card_instance_id: income, kind: "ConfirmCard", copy_key: "income.confirm.title", why_copy_key: null, allowed_answers: [], disallowed_topics: [], blocking_reason: null, waiting_on: [] }, borrowerText: "hi", journey: j2.journey, journeyTokens: j2.tokens, rules: null });
  const view = JSON.parse(ctx.situation.slice(ctx.situation.indexOf("{"), ctx.situation.lastIndexOf("}") + 1)) as Json;
  assert.ok(view["journey"], "journey in the situation"); assert.equal(view["next_in_words"], j2.journey.next_in_words); assert.equal(Object.keys(view).indexOf("journey") < Object.keys(view).indexOf("record"), true, "the journey comes before the record");
  assert.ok(MODEL_TOOLS_32_16.some((t) => t.name === "journey.get" && t.model_name === "journey_get"), "journey.get is on the bus for the model");
});

test("32.16-T30: Given a current step whose process is not internal, then the situation carries `process_rules` for that process with worked examples dropped and no dollar or percent figure in it; given an underwriting step, then no `process_rules` is present and the context still contains no DU, credit, findings or vendor content.", async () => {
  const income = rulesFor("22.3"); assert.ok(income && income.length > 500, "22.3's rules");
  assert.doesNotMatch(income!, /\$[\d,]+|\d+(\.\d+)?\s?%/, "no dollar or percent figure"); assert.doesNotMatch(income!, /Worked example/i, "worked examples dropped"); assert.ok(income!.length <= RULES_MAX_CHARS + 2);
  assert.match(income!, /VVOE|verification|income/i, "the rule in words with its citation");
  for (const internal of ["23.1", "23.2", "23.3", "22.6", "28.4"]) assert.equal(rulesFor(internal), null, `${internal} is internal: no rules text`);
  assert.equal(rulesFor("99.9"), null, "an unknown process has no rules");
  const le = rulesFor("21.2"); assert.ok(le && /business[ _]day/i.test(le), "21.2's rules name the business-day clocks");
  // the underwriting step (R8 → 23.3): the turn attaches nothing and the context contract of T2 holds
  const record = { subject: { application_id: randomUUID(), loan_id: null, label: "Application ····1234", transaction_type: "limited_cash_out", occupancy: "primary", stage: "origination" }, status: { badge: "In review", state_source: "du", one_liner: "x" }, read_only: false, next: null, needed_from_you: [], what_we_are_doing: [], needed_summary: { count: 0, nothing_needed: true, copy_key: "needs.none" }, numbers: {}, dates: [], documents: [], people: [], property: null, loan: null, offers: [], as_of: NOW, journey_progress: { steps: [{ id: "R7", label_copy_key: "journey.refi.application", state: "done", at: NOW }, { id: "R8", label_copy_key: "journey.refi.underwriting", state: "current", at: null }], done: 1, total: 2 } } as unknown as BorrowerRecord;
  const j = buildJourney({ record, cards: [] }); assert.equal(j.journey.step?.process, "23.3"); assert.equal(rulesFor(j.journey.step!.process), null);
  const ctx = buildContext({ partyFirstName: "Jane", level: "L2", channel: "app", routed_to: "intake", safeMode: "assisted", partnerName: "Partner Bank", record, cards: [], messages: [], lead: null, next: { step: "idle", card_instance_id: null, kind: null, copy_key: null, why_copy_key: null, allowed_answers: [], disallowed_topics: [], blocking_reason: null, waiting_on: [] }, borrowerText: "how is it going?", journey: j.journey, journeyTokens: j.tokens, rules: null });
  assert.ok(!ctx.situation.includes("process_rules"), "no rules for an internal step"); assert.match(j.journey.next_in_words, /nothing is needed from the borrower right now/);
  for (const needle of ["DU RECOMMENDATION", "findings_text", "vendor_payload", "credit_report"]) assert.ok(!ctx.situation.includes(needle));
  // a non-internal step: the rules ride in the situation with the note that they are never quoted
  const ctx2 = buildContext({ partyFirstName: "Jane", level: "L2", channel: "app", routed_to: "intake", safeMode: "assisted", partnerName: "Partner Bank", record, cards: [], messages: [], lead: null, next: { step: "idle", card_instance_id: null, kind: null, copy_key: null, why_copy_key: null, allowed_answers: [], disallowed_topics: [], blocking_reason: null, waiting_on: [] }, borrowerText: "hi", journey: j.journey, journeyTokens: j.tokens, rules: { process: "22.3", text: income! } });
  assert.match(ctx2.situation, /"process_rules": \{\s*"process": "22\.3",\s*"note": "the rules of the current step, for your understanding — never quote them, never state a figure from them"/);
});

test("32.16-T31: Given the first turn with the goal card pending, then the model is prompted to lead with the Journey's top need (`next_in_words` comes from the Journey, the prompt version is `32.16-p7`) and the reply names that need in its own words.", { skip }, async () => {
  assert.equal(PROMPT_VERSION, "32.16-p7");   // p7: words commit (32.17 rule 21); p6: the goal card's consents statement, said once (rule 20)
  assert.match(SYSTEM_PROMPT, /the situation carries a journey/); assert.match(SYSTEM_PROMPT, /make a suggestion when there is an easier way/); assert.match(SYSTEM_PROMPT, /Be warm|warm, plain, quick/);
  scripted.use([{ when: /just created their account/, text: (c) => { const j = c.situation["journey"] as Json; const top = ((j["needs"] as Json[])[0] ?? {})["what"]; return `Welcome. First thing: ${String(top)} — pick it on the card and we'll take it from there.`; } }]);
  const a = await signUp(`t31-${R}@example.test`, `pw-t31-${R}`, "10.16.31.1"); await settle();
  const t0 = await thread(a.token); assertDisclosureThenGoal(t0);
  const req = scripted.requests.at(-1)!; const situation = String(req.messages.at(-1)!.content);
  const view = JSON.parse(situation.slice(situation.indexOf("{"), situation.lastIndexOf("}") + 1)) as Json;
  const journey = view["journey"] as Json; assert.ok(journey, "the journey rides in the first turn's situation");
  const top = (journey["needs"] as Json[])[0]!; assert.equal(top["kind"], "choice"); assert.match(String(top["why"]), /goal/); assert.equal(view["next_in_words"], journey["next_in_words"]); assert.match(String(journey["next_in_words"]), /^the next thing is/);
  const greeting = t0.messages.find((m) => m["sender"] === "agent" && (m["copy_tokens"] as Json | null)?.["source"] === "agent_turn")!;
  assert.match(String(greeting["body_text"]), new RegExp(`First thing: ${String(top["what"]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the reply names the top need");
  const row = (await db.query<{ prompt_version: string }>(`SELECT prompt_version FROM agent_turns WHERE party_id = $1 ORDER BY created_at DESC LIMIT 1`, [a.party_id]))[0]!; assert.equal(row.prompt_version, "32.16-p7");
});

test("32.16-T32: Given the agent turn configured, when an account is created and the borrower then types \"yes\" and \"I want a human\", then the thread carries no flow copy line and no flow-sent chip, the first reply on Chat names the Apply step, `pinned_card` is the goal card, and both typed lines are answered by the turn (no deep-link line, no fixed human line).", { skip }, async () => {
  scripted.use([
    { when: /^yes\.?$/i, text: "Got it. Pick the one that fits on the card here and we'll take it from there." },
    { when: /want a human/i, text: "No one is live right now, but I can set up a callback, log a written question, or open a case — which would you like?" },
  ]);
  const a = await signUp(`t32-${R}@example.test`, `pw-t32-${R}`, "10.16.32.1"); await settle();
  const t0 = await thread(a.token);
  // the thread is the model's: the system disclosure row, then the model's greeting carrying the goal card — no flow line, no flow chip
  const flowLines = t0.messages.filter((m) => m["sender"] === "agent" && (m["copy_tokens"] as Json | null)?.["source"] !== "agent_turn");
  assert.deepEqual(flowLines, [], `no flow-authored line in the thread: ${JSON.stringify(flowLines.map((m) => [m["body_text"], m["card_instance_id"]]))}`);
  const greeting = t0.messages.find((m) => m["sender"] === "agent")!; assert.equal((greeting["copy_tokens"] as Json)["source"], "agent_turn");
  assert.equal((greeting["card"] as Json | null)?.["copy_key"], "entry.goal.question", "the first reply carries the goal card");
  assert.equal(t0.pinned_card?.["card_instance_id"], greeting["card_instance_id"], "the pinned card is the one the model placed");
  // a typed "yes": the turn answers (no deep-link line), the goal card stays pending
  let r = await message(a.token, "yes"); assert.equal(r.status, 200, JSON.stringify(r.body));
  let reply = r.reply; assert.equal((reply["copy_tokens"] as Json)["source"], "agent_turn"); assert.equal(reply["deep_link"] ?? null, null); assert.match(String(reply["body_text"]), /^Got it\. Pick the one/);
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM deep_links WHERE party_id = $1`, [a.party_id]))[0]!.n, "0", "no deep link minted for a typed yes");
  // "I want a human": the turn answers in its words — no fixed human line — while the word itself still queues human.request (01 §1.1; the eval's human persona measures it within one turn)
  r = await message(a.token, "I want a human"); assert.equal(r.status, 200, JSON.stringify(r.body));
  reply = r.reply; assert.equal((reply["copy_tokens"] as Json)["source"], "agent_turn"); assert.match(String(reply["body_text"]), /callback/); assert.equal(r.body["command_executed"], true); assert.equal(r.body["command"], "human.request");
  const t1 = await thread(a.token);
  assert.equal(t1.messages.filter((m) => String(m["body_text"] ?? "").startsWith("{{copy:thread.")).length, 0, "no thread.* fixed line");
  assert.deepEqual(t1.messages.filter((m) => m["sender"] === "agent" && (m["copy_tokens"] as Json | null)?.["source"] !== "agent_turn"), [], "still no flow-authored line");
});
