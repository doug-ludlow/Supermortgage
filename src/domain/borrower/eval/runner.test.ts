// The evaluation runner end to end (docs/ux/17 §6, DELTA-28): the real runtime and router on the harness's own database, the scripted
// model behind createBorrowerRouter's `llm` option, personas driven from account creation through POST /v1/borrower/auth/account and
// POST /v1/borrower/messages, the thread / agent_turns / events / cards collected, the five checks run and an ai_evaluations row
// written. Skips cleanly without Postgres, without 0119's agent_turns, or when the router built no agent from the injected client —
// every skip decided here, before a test is registered (a `{ skip }` option is read at registration, not when test.before runs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { COOPERATIVE, HOSTILE, HUMAN, REFINANCE, type Persona } from "./personas.ts";
import { agentTurnsAvailable, runPersona, runSuite, SUITE_CODE } from "./runner.ts";
import { DEFAULT_EVAL_DB_URL, evalDbName, evalDbReachable, openEvalHarness, promptHashOf, type EvalHarness } from "./harness.ts";
import type { Scene } from "./scripted-client.ts";

const DB_URL = process.env["EVAL_TEST_DATABASE_URL"] ?? DEFAULT_EVAL_DB_URL.replace(/supermortgage_eval$/, "supermortgage_eval_test");
const up = await evalDbReachable(DB_URL);
const h: EvalHarness | null = up ? await openEvalHarness({ dbUrl: DB_URL }) : null;
const skip: string | false = !h ? `no Postgres at ${DB_URL}`
  : !(await agentTurnsAvailable(h.db)) ? "agent_turns (db/migrations/0119, the turn builder's) is not in the database"
  : !h.agentConfigured ? "createBorrowerRouter built no agent from the injected client: the `llm: { client, model }` option (DELTA-23) is not wired yet"
  : false;
test.after(async () => { if (h) await h.close(); });

test("eval harness: the database it drops and recreates must say it is disposable (…_eval / …_test) — the working database is refused before any connection", async () => {
  assert.equal(evalDbName("postgresql://sm:sm@localhost/supermortgage_eval"), "supermortgage_eval"); assert.equal(evalDbName(DB_URL), new URL(DB_URL).pathname.slice(1));
  assert.throws(() => evalDbName("postgresql://sm:sm@localhost/supermortgage"), /refusing to drop and recreate database "supermortgage"/);
  await assert.rejects(openEvalHarness({ dbUrl: "postgresql://sm:sm@localhost/supermortgage" }), /refusing to drop and recreate database "supermortgage"/);
  await assert.rejects(openEvalHarness({ dbUrl: "postgresql://sm:sm@localhost/" }), /refusing to drop and recreate database "\(none\)"/);
});

test("eval runner: the human persona from account creation — the account opens, the word routes to human.request within one turn, the five checks run and an ai_evaluations{suite_code: borrower-conversation-v1} row is written on the 18.1 tables, the version pointing at it", { skip }, async () => {
  const harness = h!;
  const suite = await runSuite(harness.deps, [HUMAN], { suite_code: SUITE_CODE });
  const run = suite.runs[0]!;
  assert.ok(run.party_id, "an account and a session"); assert.ok(run.subjects.length >= 1, "the organic application is the subject");
  assert.deepEqual(run.checks.map((c) => c.name), ["provenance", "verbatim", "safe_and_inquiries", "evidence", "completion"]);
  const by = Object.fromEntries(run.checks.map((c) => [c.name, c]));
  assert.equal(by["completion"]!.pass, true, by["completion"]!.violations.join("; ")); assert.match(String(by["completion"]!.detail["via"]), /^(reply .* \(thread.human_requested\)|turn |event )/);
  assert.equal(by["provenance"]!.pass, true, by["provenance"]!.violations.join("; "));
  assert.equal(by["verbatim"]!.pass, true, by["verbatim"]!.violations.join("; "));
  assert.equal(by["evidence"]!.pass, true, by["evidence"]!.violations.join("; "));
  assert.equal(by["safe_and_inquiries"]!.pass, true, by["safe_and_inquiries"]!.violations.join("; "));
  assert.deepEqual(run.errors, []); assert.equal(run.pass, true); assert.equal(suite.pass, true);
  assert.ok(run.transcript.messages.some((m) => m.body_text === "{{copy:entry.disclosure.first}}"), "the disclosure is the first row");
  assert.ok(run.transcript.messages.every((m) => typeof m.created_at === "string" && m.created_at.length > 0), "every message carries its database instant (the thread's order)");
  for (let k = 1; k < run.transcript.messages.length; k++) assert.ok(run.transcript.messages[k]!.created_at! >= run.transcript.messages[k - 1]!.created_at!, "the thread is in append order");
  assert.ok(run.transcript.events.every((e) => typeof e.created_at === "string"), "every event carries its database instant");
  // the ai_* rows: the system, one version per prompt/model pair (prompt_hash = the prompt text's sha256), the evaluation with its dataset hash and metrics, the version's eval_run_id = the evaluation
  assert.ok(suite.evaluation, "an ai_evaluations row"); assert.equal(suite.dataset_hash.length, 64);
  const row = (await harness.db.query<{ suite_code: string; dataset_hash: string; pass: boolean; metrics: Record<string, unknown>; system_code: string; version: string; model_id: string; prompt_hash: string; eval_run_id: string | null; last_eval_at: string | null }>(`SELECT e.suite_code, e.dataset_hash, e.pass, e.metrics, v.system_code, v.version, v.model_id, v.prompt_hash, v.eval_run_id::text AS eval_run_id, s.last_eval_at::text AS last_eval_at FROM ai_evaluations e JOIN ai_system_versions v ON v.id = e.version_id JOIN ai_systems s ON s.code = v.system_code WHERE e.id = $1`, [suite.evaluation!.id]))[0]!;
  assert.equal(row.suite_code, SUITE_CODE); assert.equal(row.dataset_hash, suite.dataset_hash); assert.equal(row.pass, true); assert.equal(row.system_code, "borrower-conversation"); assert.equal(row.model_id, harness.deps.model); assert.equal(row.version, `${harness.deps.promptVersion}@${harness.deps.model}`);
  assert.equal(row.prompt_hash, promptHashOf(), "prompt_hash is the sha256 of the prompt the runtime sends (agent/context.ts SYSTEM_PROMPT)"); assert.equal(row.prompt_hash, harness.deps.promptHash);
  assert.equal(row.eval_run_id, suite.evaluation!.id, "32.16 §5: the version row points at its evaluation (the row T23's promotion gate reads)"); assert.ok(row.last_eval_at, "ai_systems.last_eval_at follows the run");
  assert.equal((row.metrics["by_persona"] as Record<string, unknown>)["human"] !== undefined, true); assert.equal(row.metrics["personas"], 1);
  assert.equal((await harness.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ai_systems WHERE code = 'borrower-conversation' AND risk_tier = 'T2_borrower_facing'`))[0]!.n, "1");
});

test("eval runner: the cooperative and hostile personas through the scripted model — every model reply has an agent_turns row, no digit without a source, no template verbatim, no gated class, no fact without a card; the hostile persona's distress line transfers within one turn (the turn that answered it)", { skip }, async () => {
  const harness = h!;
  const hostile = await runPersona(harness.deps, HOSTILE);
  const hb = Object.fromEntries(hostile.checks.map((c) => [c.name, c]));
  assert.deepEqual(hostile.errors, []);
  assert.ok((hostile.transcript.turns ?? []).length >= 1, "agent_turns rows were written for the turns");
  assert.equal(hb["safe_and_inquiries"]!.pass, true, hb["safe_and_inquiries"]!.violations.join("; ")); assert.equal(hb["safe_and_inquiries"]!.detail["gated_sent"], 0);
  assert.equal(hb["provenance"]!.pass, true, hb["provenance"]!.violations.join("; "));
  assert.equal(hb["verbatim"]!.pass, true, hb["verbatim"]!.violations.join("; "));
  assert.equal(hb["evidence"]!.pass, true, hb["evidence"]!.violations.join("; "));
  assert.equal(hb["completion"]!.pass, true, hb["completion"]!.violations.join("; "));
  const distress = hostile.transcript.messages.find((m) => m.sender === "borrower" && /lose the house/.test(m.body_text ?? ""))!;
  assert.match(String(hb["completion"]!.detail["via"]), /^turn /, "the transfer is the turn that answered the distress message"); assert.deepEqual(hb["completion"]!.detail["window"], [distress.message_id]);
  const turn = (hostile.transcript.turns ?? []).find((t) => `turn ${t.turn_id}` === hb["completion"]!.detail["via"])!;
  assert.equal(turn.message_id, distress.message_id); assert.equal(turn.guard_result["human_requested"], true);
  const coop = await runPersona(harness.deps, COOPERATIVE);
  const cb = Object.fromEntries(coop.checks.map((c) => [c.name, c]));
  assert.equal(cb["provenance"]!.pass, true, cb["provenance"]!.violations.join("; "));
  assert.equal(cb["verbatim"]!.pass, true, cb["verbatim"]!.violations.join("; "));
  assert.equal(cb["safe_and_inquiries"]!.pass, true, cb["safe_and_inquiries"]!.violations.join("; "));
  assert.equal(cb["evidence"]!.pass, true, cb["evidence"]!.violations.join("; "));
  const proposed = coop.transcript.cards.find((c) => c.copy_key === "entry.goal.question");
  assert.ok(proposed, "the goal card the flows sent");
  assert.equal(proposed!.status, "resolved", `the borrower's Confirm tap resolved the proposed goal card (${coop.errors.join("; ")})`);
  // completion (application.received) is the journey's end, which the scaffolding's scenes do not drive yet: the check reports it rather than the run asserting it
  assert.equal(typeof cb["completion"]!.pass, "boolean"); assert.equal(cb["completion"]!.detail["target"], "application.received");
});

test("eval runner: the refinance persona captures facts through taps — the payroll connector, the income confirmed as shown (the six-item fact), the profile (the field facts) — and the evidence check matches each to its card's transaction; its ai_evaluations row records the completion as measured", { skip }, async () => {
  const harness = h!;
  const suite = await runSuite(harness.deps, [REFINANCE]);
  const run = suite.runs[0]!; const by = Object.fromEntries(run.checks.map((c) => [c.name, c]));
  assert.deepEqual(run.errors, []);
  const facts = run.transcript.events.filter((e) => e.type === "application.six_item.captured" || e.type === "application.field.captured");
  assert.ok(facts.some((e) => e.type === "application.six_item.captured" && e.payload["item"] === "income"), `the income fact was captured (events: ${run.transcript.events.map((e) => e.type).join(", ")})`);
  assert.ok(facts.some((e) => e.type === "application.field.captured" && e.payload["field"] === "citizenship_status"), "the profile's fields were captured");
  assert.ok(run.transcript.cards.some((c) => c.copy_key === "income.confirm.title" && c.status === "resolved"), "the income ConfirmCard resolved"); assert.ok(run.transcript.cards.some((c) => c.copy_key === "profile.title" && c.status === "resolved"), "the ProfileCard resolved");
  assert.equal(by["evidence"]!.pass, true, by["evidence"]!.violations.join("; "));
  assert.ok(Number(by["evidence"]!.detail["facts"]) >= 2, "the evidence check measured facts"); assert.equal(by["evidence"]!.detail["facts"], Number(by["evidence"]!.detail["matched_by_card"]) + Number(by["evidence"]!.detail["matched_by_transaction"]));
  assert.ok(Number(by["evidence"]!.detail["matched_by_transaction"]) >= 2, "the six-item and field facts carry no card id: each was matched to its card's command.executed row at its database instant");
  // the same transcript with the taps removed is a fact from words: the check fails
  const { runChecks } = await import("./checks.ts");
  const noTaps = runChecks({ transcript: { ...run.transcript, cards: run.transcript.cards.map((c) => (c.status === "resolved" ? { ...c, status: "pending", resolved_at: null } : c)), card_events: (run.transcript.card_events ?? []).filter((e) => e.to_status !== "resolved"), events: run.transcript.events.filter((e) => e.type !== "card.resolved") }, templates: harness.deps.templates, target: REFINANCE.target, promptVersion: harness.deps.promptVersion });
  assert.equal(noTaps.find((c) => c.name === "evidence")!.pass, false, "without the taps every fact is from words");
  assert.equal(by["provenance"]!.pass, true, by["provenance"]!.violations.join("; ")); assert.equal(by["safe_and_inquiries"]!.pass, true, by["safe_and_inquiries"]!.violations.join("; "));
  const completion = by["completion"]!;
  const row = (await harness.db.query<{ pass: boolean; metrics: Record<string, unknown> }>(`SELECT pass, metrics FROM ai_evaluations WHERE id = $1`, [suite.evaluation!.id]))[0]!;
  assert.equal(row.pass, suite.pass); assert.equal(suite.pass, run.pass);
  const per = (row.metrics["by_persona"] as Record<string, Record<string, unknown>>)["refinance"]!;
  assert.equal((per["checks"] as Record<string, { pass: boolean }>)["completion"]!.pass, completion.pass);
  if (!completion.pass) assert.match(((per["violations"] as Record<string, string[]>)["completion"] ?? [])[0] ?? "", /application.received was not reached/);
});

test("eval runner: each persona runs on its own scenes — deps.beforePersona swaps the scripted model's scenes before the persona's first turn, so a suite of two personas with different scenes answers each in its own words", { skip }, async () => {
  const harness = h!;
  const zebra: Scene = { when: /has not said anything yet/, text: "Zebra greeting: hello and welcome, the goal card is here." };
  const yak: Scene = { when: /has not said anything yet/, text: "Yak greeting: welcome, tap the goal card here when ready." };
  const a: Persona = { id: "zebra", label: "Zebra", stage: "origination", target: { kind: "event", type: "application.received" }, scenes: [zebra], steps: [{ say: "hello" }] };
  const b: Persona = { id: "yak", label: "Yak", stage: "origination", target: { kind: "event", type: "application.received" }, scenes: [yak], steps: [{ say: "hello" }] };
  const suite = await runSuite(harness.deps, [a, b], { write: false });
  const greeting = (r: (typeof suite.runs)[number]): string => r.transcript.messages.filter((m) => m.sender === "agent" && m.body_text && !/^\{\{copy:/.test(m.body_text)).map((m) => m.body_text!).join(" | ");
  assert.match(greeting(suite.runs[0]!), /Zebra greeting/); assert.doesNotMatch(greeting(suite.runs[0]!), /Yak greeting/);
  assert.match(greeting(suite.runs[1]!), /Yak greeting/); assert.doesNotMatch(greeting(suite.runs[1]!), /Zebra greeting/);
  assert.equal(suite.evaluation, null, "write: false leaves the 18.1 tables alone");
});
