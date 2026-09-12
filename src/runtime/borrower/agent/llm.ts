/**
 * The model port (docs/ux/17 §3.6, DELTA-23): Claude on the Messages API through @anthropic-ai/sdk — a manual tool loop with a
 * tool-call budget, one regeneration hook, `output_config.effort`, the system prompt as a cached prefix, and a refusal answered
 * as `refused` (never text). There is no fake model (32.16 §8 Phase 1 "no more fakes" for the model): tests drive this same loop
 * through a scripted Messages API client (`client` in the constructor), the way src/runtime/borrower/talk.test.ts does.
 *
 * Lifted out of talk.ts (the anonymous minute's ClaudeTalkAgent is now a thin caller of this class) so the account-door turn
 * (agent/turn.ts) and the talk entry share one loop.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../../log.ts";

type P = Record<string, unknown>;
export const DEFAULT_LLM_MODEL = "claude-opus-5";
export type LlmEffort = "low" | "medium" | "high";
/** The tool-call budget of a turn (docs/ux/17 §3.7: six tool calls, one regeneration). */
export const MAX_TOOL_CALLS = 6;

/** What a tool hands back to the model: a JSON-able result; `is_error` marks a refusal or a failure (the model reads it and moves on). */
export interface LlmToolResult { readonly result: unknown; readonly is_error?: boolean }
export type LlmToolExecutor = (name: string, input: P, id: string) => Promise<LlmToolResult>;
export interface LlmTurnInput {
  readonly system: string;
  readonly messages: Anthropic.MessageParam[];
  readonly tools: readonly Anthropic.Tool[];
  readonly execute: LlmToolExecutor;
  /** Tool calls this turn may still spend (default MAX_TOOL_CALLS). */
  readonly maxToolCalls?: number;
  readonly maxTokens?: number;
}
export interface LlmToolCall { readonly id: string; readonly name: string; readonly input: P; readonly result: unknown; readonly is_error: boolean }
export interface LlmTurnOutput {
  readonly text: string;
  readonly calls: readonly LlmToolCall[];
  readonly refused: boolean;
  readonly refusal_category: string | null;
  readonly stop_reason: string | null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  /** The transcript as the model saw it, ending with the tool results (the regeneration hook continues it). */
  readonly messages: Anthropic.MessageParam[];
  readonly requests: number;
  readonly model: string;
}

export interface AnthropicLlmOptions { readonly apiKey?: string | undefined; readonly model?: string | undefined; readonly effort?: LlmEffort | undefined; /** tests: a scripted client in place of the network */ readonly client?: Anthropic | undefined; readonly logger?: Logger | undefined }

/** Claude on the Messages API: the manual loop (no beta dependency), the system prompt cached as a prefix, tools executed one response at a time. */
export class AnthropicLlm {
  readonly name = "claude";
  readonly model: string;
  readonly effort: LlmEffort;
  private readonly client: Anthropic;
  private readonly logger: Logger | undefined;
  constructor(opts: AnthropicLlmOptions = {}) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model || DEFAULT_LLM_MODEL; this.effort = opts.effort ?? "low"; this.logger = opts.logger;
  }

  async turn(input: LlmTurnInput): Promise<LlmTurnOutput> {
    const budget = input.maxToolCalls ?? MAX_TOOL_CALLS;
    const messages: Anthropic.MessageParam[] = [...input.messages];
    const calls: LlmToolCall[] = []; const texts: string[] = [];
    let usage = { input_tokens: 0, output_tokens: 0 }; let requests = 0; let stop: string | null = null;
    // the loop ends on the first response without a tool call; a hard cap on requests keeps a model that keeps calling after the budget from looping
    for (let i = 0; i <= budget + 1; i++) {
      const response = await this.client.messages.create({
        model: this.model, max_tokens: input.maxTokens ?? 1024,
        output_config: { effort: this.effort },
        system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
        tools: [...input.tools], messages,
      });
      requests++; stop = response.stop_reason ?? null;
      usage = { input_tokens: usage.input_tokens + (response.usage?.input_tokens ?? 0), output_tokens: usage.output_tokens + (response.usage?.output_tokens ?? 0) };
      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category ?? null;
        this.logger?.warn("llm.refusal", { model: this.model, category });
        return { text: "", calls, refused: true, refusal_category: category, stop_reason: stop, usage, messages, requests, model: this.model };
      }
      for (const b of response.content) if (b.type === "text" && b.text.trim()) texts.push(b.text.trim());
      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || !uses.length) break;
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const args = (u.input && typeof u.input === "object" ? (u.input as P) : {});
        if (calls.length >= budget) {
          // docs/ux/17 §3.7: the turn budget — the call is not executed; the model answers with what it has
          calls.push({ id: u.id, name: u.name, input: args, result: { error: "TOOL_BUDGET", message: `no more than ${budget} tool calls in one turn; answer with what you have` }, is_error: true });
          results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(calls.at(-1)!.result), is_error: true });
          continue;
        }
        let outcome: LlmToolResult;
        try { outcome = await input.execute(u.name, args, u.id); }
        catch (e) { outcome = { result: { error: (e as { code?: string }).code ?? "TOOL_FAILED", message: e instanceof Error ? e.message : String(e) }, is_error: true }; }
        calls.push({ id: u.id, name: u.name, input: args, result: outcome.result, is_error: outcome.is_error === true });
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(outcome.result ?? null), ...(outcome.is_error ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
    return { text: texts.join(" "), calls, refused: false, refusal_category: null, stop_reason: stop, usage, messages, requests, model: this.model };
  }

  /**
   * The one regeneration (docs/ux/17 §3.5): the rejected sentence and the violation go back to the model as the next exchange, the
   * transcript otherwise unchanged; the tool budget continues from where the turn left it.
   */
  async regenerate(prior: LlmTurnOutput, input: LlmTurnInput, violation: string): Promise<LlmTurnOutput> {
    const messages: Anthropic.MessageParam[] = [...prior.messages, { role: "assistant", content: prior.text || "(no reply)" }, { role: "user", content: `[guard]\nYour reply was not sent: ${violation}\nWrite it again without the problem, in your own words.` }];
    const remaining = Math.max(0, (input.maxToolCalls ?? MAX_TOOL_CALLS) - prior.calls.length);
    const r = await this.turn({ ...input, messages, maxToolCalls: remaining });
    return { ...r, calls: [...prior.calls, ...r.calls], usage: { input_tokens: prior.usage.input_tokens + r.usage.input_tokens, output_tokens: prior.usage.output_tokens + r.usage.output_tokens }, requests: prior.requests + r.requests };
  }
}
