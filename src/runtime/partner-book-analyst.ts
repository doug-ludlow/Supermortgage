/**
 * §33.2 rule 4 — the refinance analyst's model turn (`refi-analyst`, prompt `33.2-p1`, effort low, at most two tool calls):
 *
 *   review_facts   the model's first tool — the day's review facts as `{{facts.<key>}}` tokens and the engine's verdict and
 *                  reasons in words; never a raw figure in the tool result (asserted: the surface resolves the tokens, never the model)
 *   review_write   the model's second tool — `{rationale, flags[]}` and nothing else: a verdict key, a figure key or a number in the
 *                  input is refused (ANALYST_NEVER_DECIDES); flags outside ANALYST_FLAGS are refused
 *
 * The guard's provenance rule (src/runtime/borrower/agent/guard.ts provenanceViolation) runs on the rationale: a digit or a spelled-out
 * amount outside a token → ONE regeneration (the transcript continued with a `[guard]` correction, the same exchange shape as
 * AnthropicLlm.regenerate so the scripted client of tests keys on it) → a second violation = `{ skipped: "provenance" }` and the
 * engine's own explanation text stands (partner-book-review.ts analystOf). The turn is skipped, never the review, when the model is
 * off (`model_off`: no llm), the pass's cap is reached (`cap`: PARTNER_BOOK_ANALYST_MAX_PER_DAY, default 500), the API answers 429 /
 * overloaded (`rate_limited`), the model refuses (`refused`), or anything else fails (`error`) — `analystTurn` never throws.
 *
 * Every turn the model actually took writes an `agent_turns` row (channel `analyst`, the party's conversation via conversationFor,
 * model_version, prompt_version, context_hash, tool_calls, guard_result, tokens; migration 0126 admits the channel) and counts under
 * `ai_systems{code=refi-analyst}` with one `ai_system_versions` row per prompt/model pair (18.1; the pattern of
 * src/domain/borrower/eval/runner.ts ensureAiVersion). The analyst never decides: the verdict, the rate and every figure are the
 * engine's — src/runtime/partner-book-review.ts computes the review and calls `analystTurn` per loan.
 *
 * The model port is the borrower agent's AnthropicLlm (src/runtime/borrower/agent/llm.ts) — `analystLlmFromEnv` builds it from
 * ANTHROPIC_API_KEY the way src/runtime/borrower/routes.ts builds the agent turn's (null without a key → every turn `model_off`);
 * tests wrap the scripted client: `new AnthropicLlm({ client: scriptedClient(scenes).client, model: "scripted" })`.
 */
import { createHash, randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlm, type LlmTurnInput, type LlmTurnOutput, type LlmToolResult } from "./borrower/agent/llm.ts";
import { provenanceViolation } from "./borrower/agent/guard.ts";
import { PgBorrowerUiRepository } from "../infra/db/borrower-ui.ts";
import type { Queryable } from "../infra/db/client.ts";
import type { PlainDate } from "../kernel/calendar/date.ts";
import type { Runtime } from "./app.ts";
import type { Logger } from "./log.ts";
import { reasonsInWords, reviewTokens, VERDICT_WORDS, type ReviewFacts, type ReviewVerdict } from "./partner-book-review.ts";

type P = Record<string, unknown>;

export const ANALYST_PROMPT_VERSION = "33.2-p1";
export const ANALYST_MODEL = process.env["PARTNER_BOOK_ANALYST_MODEL"] ?? "claude-opus-5";
/** The pass's cap (rule 4): PARTNER_BOOK_ANALYST_MAX_PER_DAY, default 500. */
export const ANALYST_MAX_PER_DAY = Number(process.env["PARTNER_BOOK_ANALYST_MAX_PER_DAY"] ?? 500);
/** Rule 4: at most two tool calls — review_facts, then review_write. */
export const ANALYST_MAX_TOOL_CALLS = 2;
export const ANALYST_EFFORT = "low" as const;
/** 18.1: the analyst's system code and tier (an internal turn: no borrower reads it; the surface resolves its tokens). */
export const ANALYST_AI_SYSTEM_CODE = "refi-analyst";
export const ANALYST_TIER = "T3_internal";
export const ANALYST_CHANNEL = "analyst";
/** AnthropicLlm or the scripted client wrapped in it — `model` names the model_version the row records (the turn output's model otherwise). */
export type AnalystLlm = { readonly model?: string; turn(input: LlmTurnInput): Promise<LlmTurnOutput> };
export const ANALYST_FLAGS = ["value_stale", "value_low_confidence", "arm_reset_within_12m", "prepayment_penalty", "recent_modification", "pay_string_late", "bankruptcy_or_foreclosure", "high_ltv", "tape_exception"] as const;
export type AnalystFlag = (typeof ANALYST_FLAGS)[number];

export type AnalystReviewInput = { readonly loan_id: string; readonly party_id: string | null; readonly as_of_date: PlainDate; readonly verdict: ReviewVerdict; readonly reasons: readonly string[]; readonly facts: ReviewFacts };
export type AnalystTurnOptions = {
  readonly logger?: Logger | undefined; readonly run_id?: string; readonly as_of_date?: PlainDate;
  /** The turns the pass has already taken today and its cap (the cap answers `{ skipped: "cap" }`). */
  readonly turns_today?: number; readonly max_per_day?: number;
};
export type AnalystSkipReason = "provenance" | "model_off" | "rate_limited" | "cap" | "refused" | "error";
export type AnalystTurnResult =
  | { readonly rationale: string; readonly flags: string[]; readonly confidence: number; readonly turn_id: string; readonly model_version: string; readonly prompt_version: string }
  | { readonly skipped: AnalystSkipReason; /** present when the model ran and its `agent_turns` row was written before the skip (provenance, refused, a run without a write): the pass counts such a skip as a turn under the cap and on the receipt */ readonly turn_id?: string };

// ---------------------------------------------------------------- the model's two tools

export const REVIEW_FACTS_TOOL = "review_facts";
export const REVIEW_WRITE_TOOL = "review_write";
/** The bus names the two model tools stand for (agents.json: review.facts, review.write) — `agent_turns.tool_calls` records these. */
export const ANALYST_BUS_TOOL_NAMES: Readonly<Record<string, string>> = { [REVIEW_FACTS_TOOL]: "review.facts", [REVIEW_WRITE_TOOL]: "review.write" };
export const ANALYST_MODEL_TOOLS: readonly Anthropic.Tool[] = [
  { name: REVIEW_FACTS_TOOL, description: "The day's review facts for this loan as {{facts.<key>}} tokens (the surface fills them; you never see or write the figures), with the engine's verdict and its reasons in words. Call it first, once.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: REVIEW_WRITE_TOOL, description: "Write the analyst's rationale and flags for the day's review. rationale: one to three sentences in the homeowner's language that state the verdict's reason, with every figure as a {{facts.<key>}} token from review_facts and no digit, amount or percentage of your own. flags: only codes from the allowed list. Nothing else — the verdict, the rate and every figure are the engine's.",
    input_schema: { type: "object", properties: { rationale: { type: "string" }, flags: { type: "array", items: { type: "string", enum: [...ANALYST_FLAGS] } } }, required: ["rationale", "flags"], additionalProperties: false } },
];

/** What `review_facts` answers the model: tokens and words, no figure (asserted on every text field — a violation here is a bug, never the model's). */
export interface AnalystFactsResult { readonly verdict: ReviewVerdict; readonly verdict_text: string; readonly reasons_text: string[]; readonly facts: Record<string, string>; readonly value_source: string; readonly value_confidence: string; readonly flags: string[]; readonly allowed_flags: string[]; readonly text: string }
const sourceWords = (s: ReviewFacts["value_source"]): string => (s === "partner_fmv" ? "the partner's current market value" : s === "partner_bpo" ? "the partner's broker price opinion" : "the partner's original appraisal");
export function analystFactsResult(i: { verdict: ReviewVerdict; reasons: readonly string[]; facts: ReviewFacts }): AnalystFactsResult {
  const f = i.facts; const t = reviewTokens(f); const reasons_text = reasonsInWords(i.reasons);
  const facts: Record<string, string> = {}; for (const [k, v] of Object.entries(t)) if (v) facts[k] = v;
  const parts = [`The engine's verdict is ${i.verdict.replace(/_/g, " ")} (${VERDICT_WORDS[i.verdict]}).`, `Reasons: ${reasons_text.join("; ") || "none"}.`,
    `The rate now is ${t.rate_now}${t.candidate_rate ? ` and today's candidate rate is ${t.candidate_rate} (a change of ${t.rate_delta})` : ""}.`,
    `The balance is ${t.upb} against a value of ${t.value} (${sourceWords(f.value_source)}, as of ${t.value_as_of}, ${f.value_confidence} confidence), a loan-to-value of ${t.ltv}, with ${t.remaining_term} left.`,
    `The payment now is ${t.payment_now}${t.candidate_payment ? `; the candidate payment would be ${t.candidate_payment}, a monthly change of ${t.monthly_delta}, savings over the holding period of ${t.npv}, a total-cost change over seven years of ${t.seven_year_delta}${t.breakeven ? ` and a breakeven of ${t.breakeven}` : ""}` : ""}.`,
    `Days delinquent: ${t.days_delinquent}.`, ...(t.watch_rate ? [`The rate the sheet would need to show for the numbers to work is ${t.watch_rate}.`] : []),
    ...(f.flags.length ? [`Flags on the facts: ${f.flags.map((x) => x.replace(/_/g, " ")).join(", ")}.`] : [])];
  const text = parts.join(" ");
  for (const s of [text, ...reasons_text, VERDICT_WORDS[i.verdict]]) { const v = provenanceViolation(s); if (v) throw new RangeError(`review_facts text carries ${v}`); }
  return { verdict: i.verdict, verdict_text: VERDICT_WORDS[i.verdict], reasons_text, facts, value_source: f.value_source, value_confidence: f.value_confidence, flags: [...f.flags], allowed_flags: [...ANALYST_FLAGS], text };
}

/** `review_write`'s input as the analyst may give it: `{rationale, flags[]}` only — anything else is the engine's (ANALYST_NEVER_DECIDES). */
export type AnalystWrite = { readonly rationale: string; readonly flags: AnalystFlag[] };
export type AnalystWriteRefusal = { readonly error: "ANALYST_NEVER_DECIDES" | "BAD_FLAGS" | "BAD_INPUT"; readonly message: string };
const WRITE_KEYS = new Set(["rationale", "flags"]);
const NUMBER_TEXT = /^\s*-?\$?\d[\d,]*(\.\d+)?\s*(%|bps|basis points)?\s*$/i;
export function validateAnalystWrite(input: P): AnalystWrite | AnalystWriteRefusal {
  const extra = Object.keys(input).filter((k) => !WRITE_KEYS.has(k));
  if (extra.length) return { error: "ANALYST_NEVER_DECIDES", message: `review_write takes {rationale, flags[]} only — \`${extra.join("`, `")}\` is the engine's to decide (the verdict, the rate and every figure are read from the engine's rows)` };
  const r = input["rationale"];
  if (typeof r !== "string" || !r.trim()) return { error: "BAD_INPUT", message: "rationale must be one to three sentences of text" };
  if (NUMBER_TEXT.test(r)) return { error: "ANALYST_NEVER_DECIDES", message: "the rationale is a number — figures are the engine's; use the {{facts.*}} tokens" };
  const flagsIn = input["flags"] ?? [];
  if (!Array.isArray(flagsIn)) return { error: "BAD_INPUT", message: "flags must be an array of codes from the allowed list" };
  const flags: AnalystFlag[] = []; const bad: string[] = [];
  for (const x of flagsIn) { const s = String(x); if ((ANALYST_FLAGS as readonly string[]).includes(s)) { if (!flags.includes(s as AnalystFlag)) flags.push(s as AnalystFlag); } else bad.push(s); }
  if (bad.length) return { error: "BAD_FLAGS", message: `flags outside the analyst's list: ${bad.join(", ")} (allowed: ${ANALYST_FLAGS.join(", ")})` };
  return { rationale: r.trim(), flags };
}

// ---------------------------------------------------------------- the prompt

export const ANALYST_SYSTEM_PROMPT = [
  "You are the refinance analyst for a partner's book of monitored home loans. Each morning the engine reviews every loan and decides the verdict: a candidate for a refinance offer, watching (the rate is not there yet), not now, or excluded. You never decide. You read the engine's facts and write the reason in plain words for the homeowner and for an examiner.",
  "Do exactly this: call review_facts once, then call review_write once with a rationale of one to three sentences in the homeowner's language that states the verdict's reason, and flags from the allowed list only (an empty list when none applies). At most these two tool calls.",
  "Figures: only as the {{facts.<key>}} tokens review_facts gives you, copied exactly (for example {{facts.rate_now}} or {{facts.monthly_delta}}). Never write a digit, an amount, a percentage or a spelled-out number of your own; the surface fills the tokens. A rationale with a figure outside a token is refused.",
  "Never name a credit score, a credit report, an automated underwriting result or an approval; never say approved, pre-approved, guaranteed, denied, or that the homeowner does or does not qualify. Do not restate the verdict as a decision of yours: it is the engine's.",
  "If the guard returns your rationale with a violation named, write it again without the problem — reply with the rationale alone, or call review_write again if you still may.",
].join("\n\n");
/** The turn's one user message: the loan-day and the engine's verdict and reasons in words (no figure; the facts come through the tool). */
export function analystUserMessage(review: AnalystReviewInput): string {
  return [`[review]`, `Daily review of a monitored loan as of ${review.as_of_date} (loan ${review.loan_id}).`, `The engine's verdict is ${review.verdict.replace(/_/g, " ")} — ${VERDICT_WORDS[review.verdict]}.`, `Reasons: ${reasonsInWords(review.reasons).join("; ") || "none"}.`, `Call review_facts, then review_write.`].join("\n");
}
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const ANALYST_PROMPT_HASH = sha256(ANALYST_SYSTEM_PROMPT);
const guardMessage = (violation: string): string => `[guard]\nYour rationale was not accepted: ${violation}\nWrite it again with every figure as a {{facts.<key>}} token and no digit, amount or spelled-out number of your own — reply with the rationale alone (one to three sentences), or call review_write again.`;

// ---------------------------------------------------------------- the model run (pure: no database — the guard loop and the two tools over any AnalystLlm)

/** One tool call as `agent_turns.tool_calls` records it (the borrower turn's shape: the name, the args hash — never the args —, the outcome). */
export interface AnalystToolCallRecord { readonly name: string; readonly args_hash: string; readonly decision_id: null; readonly is_error: boolean; readonly error?: string }
export interface AnalystGuardResult { readonly ok: boolean; readonly rejected_by: "provenance" | "no_write" | "model_refused" | null; readonly violation: string | null; readonly regenerable: boolean; readonly regenerated: boolean; readonly attempts: number; readonly checks: { readonly provenance: { readonly ok: boolean; readonly detail: string | null }; readonly write: { readonly ok: boolean; readonly detail: string | null } } }
export interface AnalystModelRun {
  readonly outcome: "written" | "provenance" | "refused" | "no_write";
  readonly rationale: string | null; readonly flags: AnalystFlag[];
  readonly calls: AnalystToolCallRecord[]; readonly guard: AnalystGuardResult;
  readonly usage: { input_tokens: number; output_tokens: number }; readonly requests: number; readonly model: string; readonly context_hash: string;
  /** Every `review_facts` result handed to the model (tests assert: tokens, no raw figure). */
  readonly facts_results: AnalystFactsResult[];
  /** The `[guard]` violation of the first attempt, when there was one. */
  readonly first_violation: string | null;
}
const rationaleOf = (out: LlmTurnOutput, writes: Map<string, AnalystWrite>, textStandsIn: boolean): { rationale: string | null; flags: AnalystFlag[] | null } => {
  const accepted = out.calls.filter((c) => c.name === REVIEW_WRITE_TOOL && !c.is_error && writes.has(c.id));
  const last = accepted.at(-1); if (last) { const w = writes.get(last.id)!; return { rationale: w.rationale, flags: w.flags }; }
  // the regeneration asked for the rationale as the reply: the text stands in for a review_write call
  return { rationale: textStandsIn && out.text.trim() ? out.text.trim() : null, flags: null };
};
/**
 * The model's turn over the two tools, the provenance guard and the one regeneration — no database. Throws only what the model
 * port throws (a 429, an outage); `analystTurn` classifies those.
 */
export async function runAnalystModel(llm: AnalystLlm, review: AnalystReviewInput, opts: { readonly maxToolCalls?: number; readonly logger?: Logger | undefined } = {}): Promise<AnalystModelRun> {
  const facts_results: AnalystFactsResult[] = []; const calls: AnalystToolCallRecord[] = []; const writes = new Map<string, AnalystWrite>();
  const execute = async (name: string, input: P, id: string): Promise<LlmToolResult> => {
    const args_hash = sha256(JSON.stringify(input)); const bus = ANALYST_BUS_TOOL_NAMES[name];
    if (!bus) { calls.push({ name, args_hash, decision_id: null, is_error: true, error: "TOOL_UNKNOWN" }); return { result: { error: "TOOL_UNKNOWN", message: `${name} is not a tool of this turn` }, is_error: true }; }
    if (name === REVIEW_FACTS_TOOL) {
      const r = analystFactsResult(review); facts_results.push(r); calls.push({ name: bus, args_hash, decision_id: null, is_error: false });
      return { result: r };
    }
    const v = validateAnalystWrite(input);
    if ("error" in v) { calls.push({ name: bus, args_hash, decision_id: null, is_error: true, error: v.error }); return { result: { error: v.error, refused: true, message: v.message }, is_error: true }; }
    writes.set(id, v); calls.push({ name: bus, args_hash, decision_id: null, is_error: false });
    return { result: { accepted: true, flags: v.flags, note: "the rationale is checked for provenance when the turn ends; the review row and the decision are written by the pass" } };
  };
  const system = ANALYST_SYSTEM_PROMPT; const user = analystUserMessage(review);
  const input: LlmTurnInput = { system, messages: [{ role: "user", content: user }], tools: ANALYST_MODEL_TOOLS, execute, maxToolCalls: opts.maxToolCalls ?? ANALYST_MAX_TOOL_CALLS, maxTokens: 700 };
  const context_hash = sha256(`${system}\n\n${user}\n\n${JSON.stringify(ANALYST_MODEL_TOOLS)}`);
  const base = (out: LlmTurnOutput) => ({ calls, usage: out.usage, requests: out.requests, model: out.model, context_hash, facts_results });

  const first = await llm.turn(input);
  if (first.refused) return { outcome: "refused", rationale: null, flags: [], ...base(first), first_violation: null, guard: { ok: false, rejected_by: "model_refused", violation: null, regenerable: false, regenerated: false, attempts: 1, checks: { provenance: { ok: true, detail: null }, write: { ok: false, detail: "the model refused" } } } };
  const w1 = rationaleOf(first, writes, false);
  if (w1.rationale === null) {
    const detail = calls.some((c) => c.name === "review.write") ? `review_write refused: ${calls.filter((c) => c.name === "review.write").map((c) => c.error).join(", ")}` : "the model did not call review_write";
    return { outcome: "no_write", rationale: null, flags: [], ...base(first), first_violation: null, guard: { ok: false, rejected_by: "no_write", violation: detail, regenerable: false, regenerated: false, attempts: 1, checks: { provenance: { ok: true, detail: null }, write: { ok: false, detail } } } };
  }
  const v1 = provenanceViolation(w1.rationale);
  if (!v1) return { outcome: "written", rationale: w1.rationale, flags: w1.flags ?? [], ...base(first), first_violation: null, guard: { ok: true, rejected_by: null, violation: null, regenerable: true, regenerated: false, attempts: 1, checks: { provenance: { ok: true, detail: null }, write: { ok: true, detail: null } } } };

  // the one regeneration (docs/ux/17 §3.5's shape): the rejected rationale and the violation go back as the next exchange; the tool budget continues
  opts.logger?.info("partner book analyst: provenance violation, regenerating", { loan_id: review.loan_id, violation: v1 });
  const messages: Anthropic.MessageParam[] = [...first.messages, { role: "assistant", content: first.text || `(rationale: ${w1.rationale})` }, { role: "user", content: guardMessage(v1) }];
  const remaining = Math.max(1, (input.maxToolCalls ?? ANALYST_MAX_TOOL_CALLS) - first.calls.length);
  const second = await llm.turn({ ...input, messages, maxToolCalls: remaining });
  const merged: LlmTurnOutput = { ...second, calls: [...first.calls, ...second.calls], usage: { input_tokens: first.usage.input_tokens + second.usage.input_tokens, output_tokens: first.usage.output_tokens + second.usage.output_tokens }, requests: first.requests + second.requests };
  if (second.refused) return { outcome: "refused", rationale: null, flags: w1.flags ?? [], ...base(merged), first_violation: v1, guard: { ok: false, rejected_by: "model_refused", violation: v1, regenerable: false, regenerated: true, attempts: 2, checks: { provenance: { ok: false, detail: v1 }, write: { ok: false, detail: "the model refused the regeneration" } } } };
  const w2 = rationaleOf(second, writes, true);
  const flags = w2.flags ?? w1.flags ?? [];
  const v2 = w2.rationale === null ? "no rationale in the regeneration" : provenanceViolation(w2.rationale);
  if (v2) return { outcome: "provenance", rationale: null, flags, ...base(merged), first_violation: v1, guard: { ok: false, rejected_by: "provenance", violation: v2, regenerable: false, regenerated: true, attempts: 2, checks: { provenance: { ok: false, detail: `${v1}; then ${v2}` }, write: { ok: w2.rationale !== null, detail: null } } } };
  return { outcome: "written", rationale: w2.rationale, flags, ...base(merged), first_violation: v1, guard: { ok: true, rejected_by: null, violation: null, regenerable: true, regenerated: true, attempts: 2, checks: { provenance: { ok: true, detail: `first attempt: ${v1}` }, write: { ok: true, detail: null } } } };
}

// ---------------------------------------------------------------- the 18.1 rows and the turn log

/** `ai_systems{refi-analyst}` and one `ai_system_versions` row per prompt/model pair (`version = <prompt>@<model>`), the runner's ensureAiVersion pattern; returns the version id. */
export async function ensureAnalystAiVersion(db: Queryable, i: { model: string; promptVersion: string; promptHash: string }): Promise<string> {
  await db.query(`INSERT INTO ai_systems (code, name, kind, purpose, risk_tier, owner_role, consumer_facing, domain, agent_package, sr11_7_model_class, model_version, prompt_version) VALUES ($1, 'Refinance analyst', 'agent', '33.2 rule 4: the daily refinance review of the partner book — the analyst reads the engine''s facts as tokens and writes the rationale and flags; it never decides', $2, 'ai_governance_owner', false, 'origination', NULL, 'llm_agent', $3, $4) ON CONFLICT (code) DO NOTHING`, [ANALYST_AI_SYSTEM_CODE, ANALYST_TIER, i.model, i.promptVersion]);
  const version = `${i.promptVersion}@${i.model}`;
  await db.query(`INSERT INTO ai_system_versions (system_code, version, model_id, prompt_hash, change_kind, status) VALUES ($1, $2, $3, $4, 'new', 'evaluated') ON CONFLICT (system_code, version) DO NOTHING`, [ANALYST_AI_SYSTEM_CODE, version, i.model, i.promptHash]);
  return (await db.query<{ id: string }>(`SELECT id::text AS id FROM ai_system_versions WHERE system_code = $1 AND version = $2`, [ANALYST_AI_SYSTEM_CODE, version]))[0]!.id;
}

const isRateLimited = (e: unknown): boolean => {
  const o = (e && typeof e === "object" ? e : {}) as { status?: unknown; error?: { type?: unknown; error?: { type?: unknown } }; message?: unknown };
  const status = typeof o.status === "number" ? o.status : null; const type = String(o.error?.type ?? o.error?.error?.type ?? "");
  return status === 429 || status === 529 || status === 503 || type === "rate_limit_error" || type === "overloaded_error" || /rate.?limit|overloaded/i.test(String(o.message ?? ""));
};

/**
 * The analyst's turn for one loan-day: the model run, then the `agent_turns` row and the 18.1 rows; the result the review row's
 * `analyst` carries (partner-book-review.ts analystOf). Never throws — every failure is a skip reason.
 */
export async function analystTurn(rt: Runtime, llm: AnalystLlm | null | undefined, review: AnalystReviewInput, opts: AnalystTurnOptions = {}): Promise<AnalystTurnResult> {
  const log = opts.logger;
  if (!llm) return { skipped: "model_off" };
  if ((opts.turns_today ?? 0) >= (opts.max_per_day ?? ANALYST_MAX_PER_DAY)) return { skipped: "cap" };
  if (!review.party_id) { log?.warn("partner book analyst: no party for the loan — no conversation for the turn log", { loan_id: review.loan_id }); return { skipped: "error" }; }
  const started = Date.now();
  let run: AnalystModelRun;
  try { run = await runAnalystModel(llm, review, { logger: log }); }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isRateLimited(e)) { log?.warn("partner book analyst: rate limited", { loan_id: review.loan_id, error: message }); return { skipped: "rate_limited" }; }
    log?.warn("partner book analyst: model failed", { loan_id: review.loan_id, error: message }); return { skipped: "error" };
  }
  const model_version = llm.model || run.model || ANALYST_MODEL; const turn_id = randomUUID();
  const skipped: AnalystSkipReason | null = run.outcome === "written" ? null : run.outcome === "provenance" ? "provenance" : run.outcome === "refused" ? "refused" : "error";
  try {
    const versionId = await ensureAnalystAiVersion(rt.db, { model: model_version, promptVersion: ANALYST_PROMPT_VERSION, promptHash: ANALYST_PROMPT_HASH });
    const conversation = await new PgBorrowerUiRepository(rt.db).conversationFor(review.party_id);
    const guard_result = { ...run.guard, ...(skipped ? { skipped } : {}), run_id: opts.run_id ?? null, as_of_date: opts.as_of_date ?? review.as_of_date, verdict: review.verdict, flags: run.flags };
    await rt.db.query(`INSERT INTO agent_turns (turn_id, conversation_id, party_id, session_id, message_id, reply_message_id, channel, ai_system_version_id, model_version, prompt_version, tier, context_hash, tool_calls, safe_classification, guard_result, latency_ms, tokens_in, tokens_out, created_at) VALUES ($1, $2, $3, NULL, NULL, NULL, $4, $5, $6, $7, $8, $9, $10::jsonb, NULL, $11::jsonb, $12, $13, $14, $15)`,
      [turn_id, conversation.conversation_id, review.party_id, ANALYST_CHANNEL, versionId, model_version, ANALYST_PROMPT_VERSION, ANALYST_TIER, run.context_hash, JSON.stringify(run.calls), JSON.stringify(guard_result), Date.now() - started, run.usage.input_tokens, run.usage.output_tokens, rt.clock.now()]);
  } catch (e) { log?.warn("partner book analyst: turn log not written", { loan_id: review.loan_id, error: e instanceof Error ? e.message : String(e) }); return { skipped: "error" }; }
  log?.info("partner book analyst turn", { turn_id, loan_id: review.loan_id, as_of_date: review.as_of_date, verdict: review.verdict, outcome: run.outcome, model: model_version, prompt_version: ANALYST_PROMPT_VERSION, calls: run.calls.map((c) => c.name), regenerated: run.guard.regenerated, requests: run.requests, tokens_in: run.usage.input_tokens, tokens_out: run.usage.output_tokens, ms: Date.now() - started });
  if (skipped) return { skipped, turn_id };
  return { rationale: run.rationale!, flags: [...run.flags], confidence: run.guard.regenerated ? 0.75 : 1, turn_id, model_version, prompt_version: ANALYST_PROMPT_VERSION };
}

/** The deploy's model the way the borrower agent's is built (routes.ts): ANTHROPIC_API_KEY, PARTNER_BOOK_ANALYST_MODEL (default claude-opus-5), effort low; null without a key (every turn `model_off`). */
export function analystLlmFromEnv(env: Record<string, string | undefined> = process.env, logger?: Logger, client?: Anthropic): AnalystLlm | null {
  const apiKey = (env["ANTHROPIC_API_KEY"] ?? "").trim();
  if (!apiKey && !client) return null;
  return new AnthropicLlm({ apiKey: apiKey || undefined, model: (env["PARTNER_BOOK_ANALYST_MODEL"] ?? "").trim() || ANALYST_MODEL, effort: ANALYST_EFFORT, client, logger });
}
