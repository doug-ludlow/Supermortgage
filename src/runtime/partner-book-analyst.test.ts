// 33.2 rule 4 — the refinance analyst's turn over the scripted Messages API client (no database: runAnalystModel is pure over the
// two model tools and the guard; analystTurn's pre-model skips are exercised with a runtime that is never touched).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptedClient, type Scene } from "../domain/borrower/eval/scripted-client.ts";
import { provenanceViolation } from "./borrower/agent/guard.ts";
import { AnthropicLlm } from "./borrower/agent/llm.ts";
import type { Runtime } from "./app.ts";
import { ANALYST_FLAGS, ANALYST_MODEL_TOOLS, ANALYST_PROMPT_VERSION, analystFactsResult, analystTurn, analystUserMessage, runAnalystModel, validateAnalystWrite, type AnalystReviewInput } from "./partner-book-analyst.ts";
import type { ReviewFacts } from "./partner-book-review.ts";
import { plainDate as D } from "../kernel/calendar/date.ts";

/** Loan 1 of the fixture on the first review (the engine's figures, as the review row carries them). */
const LOAN_1_FACTS: ReviewFacts = { note_rate_pct: "7.250", candidate_rate_pct: "6.375", rate_delta_bps: 87.5, upb_cents: "44136613", value_cents: "60500000", value_source: "partner_fmv", value_as_of: "2026-08-31", value_confidence: "medium", ltv: "0.7295", remaining_term_months: 337, pi_cents: "306979", candidate_pi_cents: "278246", candidate_loan_amount_cents: "44600000", monthly_delta_cents: "28733", npv_cents: "1942864", breakeven_months: 0, seven_year_delta_cents: "1913940", days_delinquent: 0, flags: [] };
const CANDIDATE: AnalystReviewInput = { loan_id: "11111111-1111-4111-8111-111111111111", party_id: "22222222-2222-4222-8222-222222222222", as_of_date: D("2026-09-15"), verdict: "candidate", reasons: ["rate_delta", "npv_positive", "seven_year_delta_positive", "prescreen", "state_rule"], facts: LOAN_1_FACTS };
const WATCHING: AnalystReviewInput = { ...CANDIDATE, loan_id: "33333333-3333-4333-8333-333333333333", verdict: "watching", reasons: ["rate_delta_bps -50 < 25", "seven_year_total_cost_delta ≤ 0"], facts: { ...LOAN_1_FACTS, note_rate_pct: "5.875", candidate_rate_pct: "6.375", rate_delta_bps: -50, watch_rate_pct: "5.625" } };

const CLEAN_RATIONALE = "Your rate today is {{facts.rate_now}} and the rate on this morning's sheet is {{facts.candidate_rate}}, which lowers the monthly payment by {{facts.monthly_delta}} and comes out ahead over the holding period by {{facts.npv}}. The offer and its terms are on the card here.";
const DIGIT_RATIONALE = "Your rate today is 7.250% and the sheet shows {{facts.candidate_rate}}, which lowers the payment by {{facts.monthly_delta}}.";
const llmOf = (scenes: readonly Scene[], opts: { regenerateText?: string } = {}) => { const s = scriptedClient(scenes, opts); return { scripted: s, llm: new AnthropicLlm({ client: s.client, model: "scripted" }) }; };

// ---------------------------------------------------------------- the scene shapes 33.2-T4 uses (the `when` matches the analyst's user message: "[review] … The engine's verdict is candidate …")
const CLEAN_SCENE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: CLEAN_RATIONALE, flags: ["value_low_confidence"] } }], text: "Written." };
const ONE_DIGIT_SCENE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: DIGIT_RATIONALE, flags: ["high_ltv"] } }], text: "Written.", regenerate: CLEAN_RATIONALE };
const TWO_DIGIT_SCENE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: DIGIT_RATIONALE, flags: [] } }], text: "Written.", regenerate: "Your rate is 7.25 percent today and the sheet is lower; the offer is on the card." };
const DECIDES_SCENE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: CLEAN_RATIONALE, flags: [], verdict: "not_now" } }], text: "Written." };

test("review_facts answers tokens and words — no raw figure anywhere in the model-facing text", () => {
  const r = analystFactsResult(CANDIDATE);
  assert.equal(provenanceViolation(r.text), null);
  for (const t of r.reasons_text) assert.equal(provenanceViolation(t), null);
  assert.deepEqual(Object.values(r.facts).filter((v) => !/^\{\{facts\.[a-z_]+\}\}$/.test(v)), []);
  assert.equal(r.facts["rate_now"], "{{facts.rate_now}}"); assert.equal(r.facts["candidate_rate"], "{{facts.candidate_rate}}"); assert.equal(r.facts["monthly_delta"], "{{facts.monthly_delta}}");
  assert.equal(r.verdict, "candidate"); assert.deepEqual(r.allowed_flags, [...ANALYST_FLAGS]);
  assert.ok(!("watch_rate" in r.facts), "no watch rate token for a candidate");
  const w = analystFactsResult(WATCHING);
  assert.equal(w.facts["watch_rate"], "{{facts.watch_rate}}"); assert.equal(provenanceViolation(w.text), null);
  assert.match(w.reasons_text[0]!, /under the program's floor/);
  assert.equal(provenanceViolation(analystUserMessage(CANDIDATE).replace(/^\[review\]\n.*\n/, "")), null, "the user message carries the verdict and reasons in words only (the loan-day line aside)");
  assert.deepEqual(ANALYST_MODEL_TOOLS.map((t) => t.name), ["review_facts", "review_write"]);
});

test("a clean scripted rationale with tokens passes: review_facts then review_write, the flags the scene set, no regeneration", async () => {
  const { scripted, llm } = llmOf([CLEAN_SCENE]);
  const run = await runAnalystModel(llm, CANDIDATE);
  assert.equal(run.outcome, "written"); assert.equal(run.rationale, CLEAN_RATIONALE); assert.deepEqual(run.flags, ["value_low_confidence"]);
  assert.deepEqual(run.calls.map((c) => [c.name, c.is_error]), [["review.facts", false], ["review.write", false]]);
  assert.equal(run.facts_results.length, 1); assert.equal(provenanceViolation(run.facts_results[0]!.text), null);
  assert.equal(run.guard.ok, true); assert.equal(run.guard.regenerated, false); assert.equal(run.guard.attempts, 1);
  assert.equal(run.requests, 2); assert.equal(scripted.turns[0]!.regenerated, false);
  assert.equal(run.model, "scripted"); assert.match(run.context_hash, /^[0-9a-f]{64}$/);
  // the tool results the model saw: the facts as tokens
  const factsResult = scripted.toolResults.find((r) => typeof r.content === "string" && r.content.includes("{{facts.rate_now}}"));
  assert.ok(factsResult, "review_facts result carried the tokens");
});

test("a digit outside a token → the guard refuses it, one regeneration runs with the [guard] correction, the clean rewrite passes", async () => {
  const { scripted, llm } = llmOf([ONE_DIGIT_SCENE]);
  const run = await runAnalystModel(llm, CANDIDATE);
  assert.equal(run.outcome, "written"); assert.equal(run.rationale, CLEAN_RATIONALE);
  assert.deepEqual(run.flags, ["high_ltv"], "the flags of the accepted review_write call stand when the rewrite comes as text");
  assert.equal(run.guard.regenerated, true); assert.equal(run.guard.attempts, 2); assert.equal(run.guard.ok, true);
  assert.match(run.first_violation ?? "", /raw figure "7\.250%"/);
  assert.equal(scripted.turns[0]!.regenerated, true);
  const guardReq = scripted.requests.at(-1)!; const last = guardReq.messages.at(-1)!;
  assert.match(String(last.content), /^\[guard\]\nYour rationale was not accepted: a raw figure "7\.250%" outside a \{\{token\}\}/);
  assert.equal(run.requests, 3);
});

test("two violations → skipped 'provenance' (the engine's explanation text stands in the review row)", async () => {
  const { llm } = llmOf([TWO_DIGIT_SCENE]);
  const run = await runAnalystModel(llm, CANDIDATE);
  assert.equal(run.outcome, "provenance"); assert.equal(run.rationale, null);
  assert.equal(run.guard.rejected_by, "provenance"); assert.equal(run.guard.regenerated, true); assert.equal(run.guard.attempts, 2);
  assert.match(run.guard.violation ?? "", /7\.25/);
});

test("review_write with a verdict key or a number is refused (ANALYST_NEVER_DECIDES); flags outside the list are refused", async () => {
  assert.deepEqual(validateAnalystWrite({ rationale: CLEAN_RATIONALE, flags: ["verdict_override"] }), { error: "BAD_FLAGS", message: `flags outside the analyst's list: verdict_override (allowed: ${ANALYST_FLAGS.join(", ")})` });
  assert.equal((validateAnalystWrite({ rationale: CLEAN_RATIONALE, flags: [], verdict: "candidate" }) as { error: string }).error, "ANALYST_NEVER_DECIDES");
  assert.equal((validateAnalystWrite({ rationale: CLEAN_RATIONALE, flags: [], candidate_rate_pct: "6.125" }) as { error: string }).error, "ANALYST_NEVER_DECIDES");
  assert.equal((validateAnalystWrite({ rationale: "6.125", flags: [] }) as { error: string }).error, "ANALYST_NEVER_DECIDES");
  assert.equal((validateAnalystWrite({ rationale: "", flags: [] }) as { error: string }).error, "BAD_INPUT");
  assert.deepEqual(validateAnalystWrite({ rationale: ` ${CLEAN_RATIONALE} `, flags: ["high_ltv", "high_ltv", "value_stale"] }), { rationale: CLEAN_RATIONALE, flags: ["high_ltv", "value_stale"] });
  const { scripted, llm } = llmOf([DECIDES_SCENE]);
  const run = await runAnalystModel(llm, CANDIDATE);
  assert.equal(run.outcome, "no_write"); assert.equal(run.rationale, null);
  assert.deepEqual(run.calls.map((c) => [c.name, c.is_error, c.error ?? null]), [["review.facts", false, null], ["review.write", true, "ANALYST_NEVER_DECIDES"]]);
  const refused = scripted.toolResults.find((r) => r.is_error === true);
  assert.ok(refused && String(refused.content).includes("ANALYST_NEVER_DECIDES"), "the model read the refusal");
  assert.equal(run.guard.rejected_by, "no_write");
});

test("analystTurn never throws: model off, the pass's cap, a 429 / overloaded model, any other failure — each a skip reason", async () => {
  const rt = {} as unknown as Runtime;   // never touched on these paths
  assert.deepEqual(await analystTurn(rt, null, CANDIDATE), { skipped: "model_off" });
  assert.deepEqual(await analystTurn(rt, undefined, CANDIDATE), { skipped: "model_off" });
  const { llm } = llmOf([CLEAN_SCENE]);
  assert.deepEqual(await analystTurn(rt, llm, CANDIDATE, { turns_today: 500 }), { skipped: "cap" });
  assert.deepEqual(await analystTurn(rt, llm, CANDIDATE, { turns_today: 3, max_per_day: 3 }), { skipped: "cap" });
  assert.deepEqual(await analystTurn(rt, llm, { ...CANDIDATE, party_id: null }), { skipped: "error" });
  const throwing = (e: unknown) => ({ model: "x", turn: async () => { throw e; } });
  assert.deepEqual(await analystTurn(rt, throwing(Object.assign(new Error("429 rate limited"), { status: 429 })), CANDIDATE), { skipped: "rate_limited" });
  assert.deepEqual(await analystTurn(rt, throwing(Object.assign(new Error("Overloaded"), { status: 529, error: { type: "overloaded_error" } })), CANDIDATE), { skipped: "rate_limited" });
  assert.deepEqual(await analystTurn(rt, throwing(new Error("ECONNRESET")), CANDIDATE), { skipped: "error" });
  assert.equal(ANALYST_PROMPT_VERSION, "33.2-p1");
});
