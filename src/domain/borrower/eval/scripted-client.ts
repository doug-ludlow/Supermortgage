/**
 * A scripted Messages API client for the agent turn (docs/ux/17 §6: "scripted personas under INTEGRATIONS=fake"). The pattern is
 * src/runtime/borrower/talk.test.ts's scriptedClient, adapted to the account-door turn's message shape (agent/context.ts):
 *
 *   user: "[situation]\n<json>\n\n[borrower]\n<the borrower's text>"      → the scene whose `when` matches the borrower's text answers
 *                                                                          with its tool calls (one response; the bus tool names of
 *                                                                          docs/ux/17 §3.3 spelled the model's way, "." → "_")
 *   user: [tool_result …]                                                 → the scene's sentence (end_turn)
 *   user: "[guard]\n…"                                                    → the scene's `regenerate` line (the one regeneration)
 *
 * A scene's calls and text may be functions of the parsed situation (the pending card's id, the record's tokens) and, for the
 * text, of the tool results the bus handed back — so a persona can propose on whatever card `session.next` names.
 */
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";

type P = Record<string, unknown>;
/** The bus tool names the turn exposes to the model (docs/ux/17 §3.3, DELTA-24). */
export const TURN_TOOLS: readonly string[] = ["session.next", "record.get", "explain", "timer.due", "document.describe", "card.propose", "card.request", "command.run", "human.transfer"];
/** The model-facing spelling of a bus tool name (src/app/tools/section32-16.ts modelToolName). */
export const modelToolName = (bus: string): string => bus.replace(/\./g, "_");

export interface SessionNextView { readonly step: string; readonly card_instance_id: string | null; readonly kind: string | null; readonly copy_key: string | null; readonly allowed_answers?: readonly P[]; readonly [k: string]: unknown }
export interface Situation { readonly session_next: SessionNextView; readonly pending_cards: readonly P[]; readonly record: P | null; readonly recent_messages: readonly P[]; readonly tokens_available: readonly string[]; readonly lead_facts: P | null; readonly raw: P }
export interface Call { readonly name: string; readonly input: P }
export interface ToolResultView { readonly name: string; readonly is_error: boolean; readonly content: unknown }
export interface Scene {
  readonly when: RegExp;
  readonly calls?: readonly Call[] | ((s: Situation) => readonly Call[]);
  readonly text: string | ((s: Situation, results: readonly ToolResultView[]) => string);
  /** The line after a `[guard]` rejection (docs/ux/17 §3.5's one regeneration). */
  readonly regenerate?: string;
}
export interface ScriptedTurn { readonly borrower: string; readonly scene: Scene | null; readonly calls: readonly Call[]; readonly results: readonly ToolResultView[]; text: string; regenerated: boolean }
export interface ScriptedClient {
  readonly client: Anthropic;
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[];
  readonly toolResults: Anthropic.ToolResultBlockParam[];
  readonly turns: ScriptedTurn[];
  /** Swap the scenes (the runner sets each persona's before its run). */
  use(scenes: readonly Scene[]): void;
}

const NO_SITUATION: Situation = { session_next: { step: "idle", card_instance_id: null, kind: null, copy_key: null }, pending_cards: [], record: null, recent_messages: [], tokens_available: [], lead_facts: null, raw: {} };
/** Split the turn's user message into the situation (parsed JSON), the borrower's text, and a `[guard]` violation when it is one. */
export function parseSituation(content: string): { situation: Situation; borrower: string; guard: string | null } {
  if (content.startsWith("[guard]")) return { situation: NO_SITUATION, borrower: "", guard: content.slice("[guard]".length).trim() };
  const m = /^\[situation\]\n([\s\S]*?)\n\n\[borrower\]\n([\s\S]*)$/.exec(content);
  if (!m) return { situation: NO_SITUATION, borrower: content.split("[visitor]\n")[1] ?? content, guard: null };
  let raw: P = {};
  try { raw = JSON.parse(m[1]!) as P; } catch { raw = {}; }
  const next = (raw["session_next"] && typeof raw["session_next"] === "object" ? raw["session_next"] : NO_SITUATION.session_next) as SessionNextView;
  return { situation: { session_next: next, pending_cards: Array.isArray(raw["pending_cards"]) ? (raw["pending_cards"] as P[]) : [], record: (raw["record"] as P | null) ?? null, recent_messages: Array.isArray(raw["recent_messages"]) ? (raw["recent_messages"] as P[]) : [], tokens_available: Array.isArray(raw["tokens_available"]) ? (raw["tokens_available"] as string[]) : [], lead_facts: (raw["lead_facts"] as P | null) ?? null, raw }, borrower: m[2]!, guard: null };
}

export const DEFAULT_FALLBACK_TEXT = "Sorry, I did not catch that. Could you say it another way?";
export const DEFAULT_REGENERATE_TEXT = "Let me say that more simply. The next step is on the card here.";

/** Answers like the API: the scene's tool calls on a fresh borrower message, its sentence on their results, its regenerate line after `[guard]`. */
export function scriptedClient(initial: readonly Scene[] = [], opts: { fallbackText?: string; regenerateText?: string } = {}): ScriptedClient {
  let scenes = initial;
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = []; const toolResults: Anthropic.ToolResultBlockParam[] = []; const turns: ScriptedTurn[] = [];
  let current: { turn: ScriptedTurn; situation: Situation; toolUses: Map<string, string> } | null = null;
  const message = (content: Anthropic.ContentBlock[], stop: "end_turn" | "tool_use"): Anthropic.Message =>
    ({ id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: "scripted", content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null } } as unknown as Anthropic.Message);
  const text = (t: string): Anthropic.Message => message([{ type: "text", text: t, citations: null }], "end_turn");
  const create = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    requests.push(params);
    const last = params.messages.at(-1)!;
    if (Array.isArray(last.content) && last.content.length && last.content.every((b) => (b as { type: string }).type === "tool_result")) {
      const blocks = last.content as Anthropic.ToolResultBlockParam[]; toolResults.push(...blocks);
      if (!current) return text(opts.fallbackText ?? DEFAULT_FALLBACK_TEXT);
      const results: ToolResultView[] = blocks.map((b) => { let content: unknown = b.content; if (typeof b.content === "string") { try { content = JSON.parse(b.content); } catch { content = b.content; } } return { name: current!.toolUses.get(b.tool_use_id) ?? "?", is_error: b.is_error === true, content }; });
      (current.turn.results as ToolResultView[]).push(...results);
      const s = current.turn.scene; const line = !s ? (opts.fallbackText ?? DEFAULT_FALLBACK_TEXT) : typeof s.text === "function" ? s.text(current.situation, current.turn.results) : s.text;
      current.turn.text = line; return text(line);
    }
    const content = typeof last.content === "string" ? last.content : "";
    const parsed = parseSituation(content);
    if (parsed.guard !== null) { const line = current?.turn.scene?.regenerate ?? opts.regenerateText ?? DEFAULT_REGENERATE_TEXT; if (current) { current.turn.regenerated = true; current.turn.text = line; } return text(line); }
    const scene = scenes.find((x) => x.when.test(parsed.borrower)) ?? null;
    const calls = !scene?.calls ? [] : typeof scene.calls === "function" ? scene.calls(parsed.situation) : scene.calls;
    const turn: ScriptedTurn = { borrower: parsed.borrower, scene, calls, results: [], text: "", regenerated: false }; turns.push(turn);
    current = { turn, situation: parsed.situation, toolUses: new Map() };
    if (!scene) { turn.text = opts.fallbackText ?? DEFAULT_FALLBACK_TEXT; return text(turn.text); }
    if (!calls.length) { turn.text = typeof scene.text === "function" ? scene.text(parsed.situation, []) : scene.text; return text(turn.text); }
    const uses = calls.map((c, i) => { const id = `toolu_${i}_${randomUUID().slice(0, 6)}`; current!.toolUses.set(id, c.name); return { type: "tool_use", id, name: modelToolName(c.name), input: c.input } as unknown as Anthropic.ContentBlock; });
    return message(uses, "tool_use");
  };
  return { client: { messages: { create } } as unknown as Anthropic, requests, toolResults, turns, use(next) { scenes = next; } };
}
