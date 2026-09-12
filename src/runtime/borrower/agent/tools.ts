/**
 * The model-facing tool contract (docs/ux/17 §3.3, DELTA-24): the Anthropic tool schema generated at boot from the 32.16 bus tool
 * definitions (src/app/tools/section32-16.ts `MODEL_TOOLS_32_16` — names, descriptions, JSON schemas), and the executor that runs each
 * call the model makes as that bus command for the session's party and subject, as the thread-owning agent (`intake` before funding,
 * `borrower-comms` after), with the turn's run info on the decision row. Every call is a bus command with an agent_decisions row; a
 * refusal (the bus's allowlist, a guardrail, a tool's own *Refused) comes back to the model as a tool error and is recorded on the
 * turn's `tool_calls` — and, because a unit of work that refused persists nothing, the executor appends the bus's `command.refused`
 * event itself so the audit path sees the attempt (32.16 T3).
 *
 * What a tool hands back for the API and not the model — `tokens` (the figures behind the `{{token}}`s), a rates `element`, the card a
 * proposal went into, a card that was sent — is stripped from the model's result and kept on the turn.
 */
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Actor } from "../../../kernel/events/index.ts";
import type { Runtime } from "../../app.ts";
import type { Subject } from "../../../infra/db/borrower-parties.ts";
import { CommandRefused } from "../../../app/commands.ts";
import { MODEL_TOOLS_32_16, PROCESS_32_16 } from "../../../app/tools/section32-16.ts";
import { toBorrowerError } from "../errors.ts";
import type { LlmToolExecutor, LlmToolResult } from "./llm.ts";

type P = Record<string, unknown>;
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The Anthropic tool schema, generated once at boot from the 32.16 definitions (a stable tool list keeps the cached prefix stable). */
export const MODEL_TOOLS: readonly Anthropic.Tool[] = MODEL_TOOLS_32_16.map((t) => ({ name: t.model_name, description: t.description, input_schema: t.input_schema as Anthropic.Tool["input_schema"] }));
export const busToolName = (modelName: string): string | null => MODEL_TOOLS_32_16.find((t) => t.model_name === modelName)?.name ?? null;

/** One tool call as `agent_turns.tool_calls` records it: the name, the args hash (never the args), the decision id, the outcome. */
export interface ToolCallRecord { readonly name: string; readonly args_hash: string; readonly decision_id: string | null; readonly is_error: boolean; readonly refused?: { readonly code: string; readonly event: "command.refused" }; readonly error?: string }
export interface TurnFacts { readonly party_id: string; readonly session_id: string; readonly conversation_id: string; readonly message_id: string | null; readonly channel: string; readonly assurance_level: string; readonly subject: Subject | null; readonly routed_to: "intake" | "borrower-comms"; readonly utterance: string }
export interface ToolLedger {
  readonly calls: ToolCallRecord[];
  readonly tokens: Record<string, string>;
  /** Rows the API renders beside the reply (a rates element): `messages{sender: system, body_text: null, copy_tokens}`. */
  readonly elements: P[];
  proposed_card_instance_id: string | null;
  proposed_misses: number;
  requested_card_instance_id: string | null;
  human_requested: boolean;
  explained: string | null;
}
export const newLedger = (): ToolLedger => ({ calls: [], tokens: {}, elements: [], proposed_card_instance_id: null, proposed_misses: 0, requested_card_instance_id: null, human_requested: false, explained: null });

export interface ExecutorDeps { readonly runtime: Runtime; readonly facts: TurnFacts; readonly ledger: ToolLedger; readonly run: { runId: string; modelVersion: string; promptVersion: string } }

/** The executor the model loop calls: model name → bus tool, the API's facts on the input, the run info on the decision, the refusal read back. */
export function toolExecutor(d: ExecutorDeps): LlmToolExecutor {
  const { runtime, facts, ledger } = d;
  const actor: Actor = { kind: "agent", id: facts.routed_to };
  const scope = { loanId: facts.subject?.loan_id ?? "", ...(facts.subject?.application_id ? { applicationId: facts.subject.application_id } : {}) };
  const factsInput: P = { party_id: facts.party_id, session_id: facts.session_id, conversation_id: facts.conversation_id, message_id: facts.message_id, channel: facts.channel, assurance_level: facts.assurance_level, subject: { application_id: facts.subject?.application_id ?? null, loan_id: facts.subject?.loan_id ?? null }, routed_to: facts.routed_to, utterance: facts.utterance };
  return async (modelName, input): Promise<LlmToolResult> => {
    const name = busToolName(modelName);
    const args_hash = sha256(JSON.stringify(input));
    if (!name) { ledger.calls.push({ name: modelName, args_hash, decision_id: null, is_error: true, error: "TOOL_UNKNOWN" }); return { result: { error: "TOOL_UNKNOWN", message: `${modelName} is not a tool of this conversation` }, is_error: true }; }
    try {
      // the model's fields first, the API's facts last: the model never sets the party, the subject, the session or the channel
      const r = await runtime.execute({ process: PROCESS_32_16, name, ...scope, actor, input: { ...input, ...factsInput }, run: d.run });
      const out = (r.output && typeof r.output === "object" ? (r.output as P) : { value: r.output });
      const { tokens, element, ...visible } = out;
      if (tokens && typeof tokens === "object") Object.assign(ledger.tokens, tokens as Record<string, string>);
      if (element && typeof element === "object") ledger.elements.push(element as P);
      if (name === "card.propose" && typeof out["card_instance_id"] === "string") { ledger.proposed_card_instance_id = out["card_instance_id"]; ledger.proposed_misses = Number(out["misses"] ?? 0); }
      if (name === "card.request" && out["sent"] === true && typeof out["card_instance_id"] === "string") ledger.requested_card_instance_id = out["card_instance_id"];
      if (name === "human.transfer" || (name === "command.run" && input["name"] === "human.request")) ledger.human_requested = true;
      if (name === "explain" && typeof out["copy_key"] === "string" && out["outcome"] !== "refused") ledger.explained = out["copy_key"];
      ledger.calls.push({ name, args_hash, decision_id: r.decisions[0]?.id ?? null, is_error: false });
      return { result: visible };
    } catch (e) {
      if (e instanceof CommandRefused) {
        // the bus refused before anything ran; its `command.refused` event did not persist with the rolled-back unit of work — appended here so the audit path sees the attempt
        await runtime.uow.run(scope, (ctx) => ctx.events.append({ type: "command.refused", ...(scope.loanId ? { loanId: scope.loanId } : {}), ...(scope.applicationId ? { applicationId: scope.applicationId } : {}), actor, payload: { command: e.command, code: e.code, citation: e.citation, reason: e.message, subject_id: null, tool: name, via: "32.16 agent turn", run_id: d.run.runId, attempted: input["name"] ?? null } }), { clock: runtime.clock }).catch(() => undefined);
        ledger.calls.push({ name, args_hash, decision_id: null, is_error: true, refused: { code: e.code, event: "command.refused" } });
        return { result: { error: e.code, refused: true, message: e.message, copy_key: toBorrowerError(e).body().copy_key }, is_error: true };
      }
      const be = toBorrowerError(e);
      ledger.calls.push({ name, args_hash, decision_id: null, is_error: true, error: be.code });
      return { result: { error: be.code, message: be.message, copy_key: be.body().copy_key }, is_error: true };
    }
  };
}
