// The personas as data (docs/ux/17 §6) and the scripted Messages API client that plays the model for them — no database, no model:
// every scene names a docs/ux/17 §3.3 tool, every persona has utterances and a target, and the client answers the agent turn's
// message shape (agent/context.ts) the way the API would.
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { COOPERATIVE, FAKE_SUITE, HOSTILE, HUMAN, PERSONAS, PURCHASE, REFINANCE, SERVICING_PAYOFF, personaById, sceneToolNames } from "./personas.ts";
import { DEFAULT_FALLBACK_TEXT, DEFAULT_REGENERATE_TEXT, modelToolName, parseSituation, scriptedClient, TURN_TOOLS } from "./scripted-client.ts";
import { datasetHash } from "./runner.ts";

const CARD = "33333333-3333-4333-8333-333333333333";
const situation = (borrower: string, next: Record<string, unknown> = { step: "card", card_instance_id: CARD, kind: "ChoiceCard", copy_key: "entry.goal.question" }): string =>
  `[situation]\n${JSON.stringify({ lender: "Partner Bank", session_next: next, pending_cards: [{ card_instance_id: CARD, kind: "ChoiceCard", copy_key: "entry.goal.question", options: [{ id: "lower_rate", label: "Lower my rate or payment" }] }], recent_messages: [], tokens_available: ["party.first_name"] }, null, 1)}\n\n[borrower]\n${borrower}`;
const DIGIT_OR_AMOUNT = /\d|\b(?:hundred|thousand|million|percent|dollars?|cents)\b/i;

test("eval personas: the nine personas of docs/ux/17 §6 plus the refinance and purchase journeys, each with utterances, scenes and a target; the FAKE suite is those that start from account creation", () => {
  assert.deepEqual(PERSONAS.map((p) => p.id), ["cooperative", "terse", "rambling", "anxious", "hostile", "non-native", "human", "refinance", "purchase", "servicing-payoff"]);
  for (const p of PERSONAS) { assert.ok(p.steps.some((s) => "say" in s), `${p.id} says something`); assert.ok(p.scenes.length > 0, `${p.id} has scenes`); assert.ok(p.label); }
  assert.deepEqual(REFINANCE.target, { kind: "event", type: "application.received" }); assert.deepEqual(PURCHASE.target, { kind: "event", type: "application.received" });
  assert.deepEqual(SERVICING_PAYOFF.target, { kind: "card", copy_key: "payoff.request", card_kind: "ChoiceCard" }); assert.equal(SERVICING_PAYOFF.requires, "serviced_loan");
  assert.equal(HUMAN.target.kind, "human"); assert.equal(HOSTILE.target.kind, "human");
  assert.deepEqual(FAKE_SUITE.map((p) => p.id), PERSONAS.filter((p) => p.id !== "servicing-payoff").map((p) => p.id));
  assert.equal(personaById("hostile"), HOSTILE); assert.equal(personaById("nobody"), undefined);
  // the dataset hash is a function of the personas as data: stable, and different when a persona changes — its steps, or what a scene says or calls (a function-valued scene by its source text)
  assert.equal(datasetHash(PERSONAS), datasetHash([...PERSONAS])); assert.notEqual(datasetHash(PERSONAS), datasetHash([{ ...COOPERATIVE, steps: [...COOPERATIVE.steps, { say: "one more" }] }]));
  const escrow = COOPERATIVE.scenes.find((s) => s.when.source.includes("escrow"))!; assert.equal(typeof escrow.text, "function");
  const reworded = { ...escrow, text: (s: Parameters<Exclude<typeof escrow.text, string>>[0]): string => `Escrow is money set aside for taxes and insurance. ${s.session_next.step}` };
  assert.notEqual(datasetHash([COOPERATIVE]), datasetHash([{ ...COOPERATIVE, scenes: COOPERATIVE.scenes.map((s) => (s === escrow ? reworded : s)) }]), "a scripted line reworded is a different dataset");
  const recalled = { ...escrow, calls: () => [{ name: "session.next", input: {} }] };
  assert.notEqual(datasetHash([COOPERATIVE]), datasetHash([{ ...COOPERATIVE, scenes: COOPERATIVE.scenes.map((s) => (s === escrow ? recalled : s)) }]), "a scripted tool call changed is a different dataset");
  // the refinance journey captures facts through taps only: the payroll connector, the income confirmed as the report shows it, the profile's answers
  const steps = REFINANCE.steps;
  assert.ok(steps.some((s) => "connect" in s && s.connect.vendor === "truv_income" && s.connect.copy_key === "income.connect.purpose"), "the connector step");
  assert.ok(steps.some((s) => "resolve" in s && s.resolve.copy_key === "income.confirm.title" && s.resolve.as_shown === true), "the income confirmed as shown");
  assert.ok(steps.some((s) => "resolve" in s && s.resolve.copy_key === "profile.title" && (s.resolve.fields ?? []).some((f) => f.path === "citizenship_status")), "the profile answers");
});

test("eval personas: every scripted tool call names a §3.3 tool spelled the model's way; every scripted line is digit-free, template-free and never the words the guard refuses", () => {
  assert.deepEqual(TURN_TOOLS, ["session.next", "record.get", "explain", "timer.due", "document.describe", "card.propose", "card.request", "command.run", "human.transfer"]);
  assert.equal(modelToolName("card.propose"), "card_propose"); assert.equal(modelToolName("human.transfer"), "human_transfer");
  for (const p of PERSONAS) for (const name of sceneToolNames(p.scenes)) assert.ok(TURN_TOOLS.includes(name), `${p.id}: ${name} is a turn tool`);
  const probe = parseSituation(situation("x")).situation;
  for (const p of PERSONAS) for (const s of p.scenes) {
    const lines = [typeof s.text === "function" ? s.text(probe, [{ name: "card.propose", is_error: false, content: {} }]) : s.text, typeof s.text === "function" ? s.text({ ...probe, session_next: { step: "idle", card_instance_id: null, kind: null, copy_key: null } }, []) : s.text, s.regenerate ?? ""];
    for (const line of lines) { assert.doesNotMatch(line.replace(/\{\{[a-z0-9_.]+\}\}/g, ""), DIGIT_OR_AMOUNT, `${p.id} ${s.when}: no figure outside a token`); assert.doesNotMatch(line, /\b(approved|denied|pre-approved|guarantee|lowest)\b/i, `${p.id} ${s.when}: never the guard's forbidden words`); }
  }
});

test("eval scripted client: answers the turn's [situation]/[borrower] message with the scene's calls (bus names → model names), its sentence on the tool results, its regenerate line after [guard], and a fallback when no scene matches", async () => {
  const parsed = parseSituation(situation("I want to lower my monthly payment"));
  assert.equal(parsed.borrower, "I want to lower my monthly payment"); assert.equal(parsed.situation.session_next.card_instance_id, CARD); assert.equal(parsed.situation.pending_cards.length, 1); assert.equal(parsed.guard, null);
  assert.equal(parseSituation("[guard]\nYour reply was not sent: a raw figure").guard, "Your reply was not sent: a raw figure");
  assert.equal(parseSituation("[visitor]\nhello").borrower, "hello", "the talk entry's shape still parses");
  const sc = scriptedClient(COOPERATIVE.scenes);
  const create = (messages: Anthropic.MessageParam[]): Promise<Anthropic.Message> => sc.client.messages.create({ model: "scripted", max_tokens: 10, messages } as Anthropic.MessageCreateParamsNonStreaming);
  const first = await create([{ role: "user", content: situation("I want to lower my monthly payment") }]);
  assert.equal(first.stop_reason, "tool_use"); const use = first.content[0] as Anthropic.ToolUseBlock; assert.equal(use.name, "card_propose"); assert.deepEqual(use.input, { card_instance_id: CARD, option_id: "lower_rate" });
  const second = await create([{ role: "user", content: situation("I want to lower my monthly payment") }, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: JSON.stringify({ card_instance_id: CARD, outcome: "proposed" }) }] }]);
  assert.equal(second.stop_reason, "end_turn"); assert.match((second.content[0] as Anthropic.TextBlock).text, /Got it: \{\{proposal.option\}\}\. Tap Confirm/);
  assert.equal(sc.turns.length, 1); assert.equal(sc.turns[0]!.results[0]!.name, "card.propose"); assert.equal(sc.toolResults.length, 1);
  const regen = await create([{ role: "user", content: "[guard]\nYour reply was not sent: a raw figure" }]); assert.equal((regen.content[0] as Anthropic.TextBlock).text, DEFAULT_REGENERATE_TEXT); assert.equal(sc.turns[0]!.regenerated, true);
  const idle = await create([{ role: "user", content: situation("I want to lower my monthly payment", { step: "idle", card_instance_id: null, kind: null, copy_key: null }) }]);
  assert.equal((idle.content[0] as Anthropic.ToolUseBlock).name, "session_next", "no ChoiceCard pending: the scene only looks");
  const none = await create([{ role: "user", content: situation("blorp") }]); assert.equal((none.content[0] as Anthropic.TextBlock).text, DEFAULT_FALLBACK_TEXT);
  sc.use(HOSTILE.scenes);
  const distress = await create([{ role: "user", content: situation("I am going to lose the house, I can't do this anymore.") }]);
  assert.equal((distress.content[0] as Anthropic.ToolUseBlock).name, "human_transfer"); assert.deepEqual((distress.content[0] as Anthropic.ToolUseBlock).input, { reason: "distress" });
});
