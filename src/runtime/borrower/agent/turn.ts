/**
 * The agent turn (docs/ux/17 §3.1, DELTA-23) — Claude behind the account, on the bus's tools, in the slot the placeholder reply had:
 *
 *   build context (agent/context.ts: the record, the pending cards, the last messages, the lead's facts — nothing carried)
 *   → call the model with the tool contract (agent/llm.ts AnthropicLlm; agent/tools.ts runs every call as a 32.16 bus command)
 *   → classify and log the utterance (21.1 logSafeActivity through the bus) → the six guard checks (agent/guard.ts)
 *   → one regeneration with the violation named, else the step's default copy
 *   → fill the `{{token}}`s from the record, append the rates element rows and the reply to `messages`
 *   → the `agent_turns` row (every attempt, rejections included) → flows.settle() → the party's stream learns to re-fetch.
 *
 * Misses are counted per card (`card_instances.misses`, written by card.propose); the third runs `human.request` with the transcript
 * reference (§3.7). The 18.1 kill switch — the registry's AI-off state for the agent, or `feature_flags.<agent>.enabled = false` — bypasses
 * the turn: `run` answers null and the caller falls back to the placeholder copy for every party until the flag is reset (T10).
 * Turns are serialized per party (the first turn after sign-up and the borrower's first message never interleave).
 */
import { randomUUID } from "node:crypto";
import type { Actor } from "../../../kernel/events/index.ts";
import type { Runtime } from "../../app.ts";
import type { Logger } from "../../log.ts";
import type { Queryable } from "../../../infra/db/client.ts";
import { decodeEntityData } from "../../../infra/db/entities.ts";
import type { PgBorrowerUiRepository, MessageRow } from "../../../infra/db/borrower-ui.ts";
import type { Subject } from "../../../infra/db/borrower-parties.ts";
import { AI_PERMITTED_ALWAYS, type SafeClassification } from "../../../domain/application/ops-21-1.ts";
import { sessionNextOf, MISSES_TO_HUMAN } from "../../../app/tools/section32-16.ts";
import { CommandRefused } from "../../../app/commands.ts";
import type { BorrowerContext } from "../auth.ts";
import { copyTemplates } from "../channels.ts";
import { THREAD_COPY_KEYS } from "../copy-keys.ts";
import type { BorrowerFlows } from "../flows/index.ts";
import type { BorrowerRecordReader } from "../record.ts";
import type { BorrowerStreamHub } from "../stream.ts";
import { buildContext, fillTokens, AGENT_TIER, PROMPT_VERSION, MESSAGE_WINDOW } from "./context.ts";
import { guardUtterance, classifyUtterance, ASKS_IF_HUMAN, type GuardResult, type SafePermission } from "./guard.ts";
import type { AnthropicLlm, LlmTurnOutput } from "./llm.ts";
import { MODEL_TOOLS, newLedger, toolExecutor, type ToolLedger } from "./tools.ts";
import { MODEL_TOOLS_32_16 } from "../../../app/tools/section32-16.ts";

type P = Record<string, unknown>;
type Channel = "app" | "sms" | "email" | "voice";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const AI_SYSTEM_CODE = "borrower-conversation";

export interface AgentTurnRequest {
  readonly ctx: BorrowerContext;
  readonly conversation_id: string;
  /** The borrower message answered; null for the first turn of a session (no borrower text: the model greets and asks the goal). */
  readonly message_id: string | null;
  readonly text: string;
  readonly channel: Channel;
  readonly subject: Subject | null;
  readonly routed_to: "intake" | "borrower-comms";
  readonly now: string;
}
export interface AgentTurnReply {
  readonly reply: MessageRow;
  /** Empty for the model's own words; the step's copy key when the guard fell back to the default copy. */
  readonly copy_key: string;
  readonly turn_id: string;
  readonly guard: GuardResult | null;
  readonly calls: ToolLedger["calls"];
  readonly command_executed: boolean;
  readonly command: string | null;
}
export interface AgentTurnDeps {
  readonly runtime: Runtime; readonly ui: PgBorrowerUiRepository; readonly reader: BorrowerRecordReader; readonly flows: BorrowerFlows; readonly logger: Logger; readonly hub: BorrowerStreamHub;
  readonly llm: AnthropicLlm; readonly promptVersion?: string | undefined;
  /** The partner behind the party's first subject (routes.ts partnerFor): the lender's name the prompt names. */
  readonly partner: (ctx: BorrowerContext) => Promise<{ legal_name: string; nmlsr_id: string }>;
}

export class AgentTurnRunner {
  private readonly d: AgentTurnDeps;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly quarantined = new Set<string>();
  readonly promptVersion: string;
  constructor(deps: AgentTurnDeps) {
    this.d = deps; this.promptVersion = deps.promptVersion || PROMPT_VERSION;
    // 32.16 names both thread-owning agents for its nine tools (spec/registry/agents.json `agents_named`): the servicing turn runs them as borrower-comms, so the live registry carries them on that agent too (the file lists intake as the owner)
    for (const t of MODEL_TOOLS_32_16) for (const agent of ["intake", "borrower-comms"]) deps.runtime.agents.registerTool(agent, t.name);
  }
  get model(): string { return this.d.llm.model; }

  /** 18.1: the reason the agent's AI path is off (the registry's kill switch / AI-off, or `feature_flags.<agent>.enabled = false`), or null. */
  async bypassed(agent: "intake" | "borrower-comms"): Promise<string | null> {
    const state = this.d.runtime.agents.aiState(agent); if (state.off) return state.why ?? "AI path off";
    for (const key of [`${agent}.enabled`, `${AI_SYSTEM_CODE}.enabled`]) {
      const row = (await this.d.runtime.db.query<{ value: unknown }>(`SELECT value FROM feature_flags WHERE key = $1`, [key]))[0];
      if (row && (row.value === false || row.value === "false")) return `feature flag ${key}=false (18.1 kill switch)`;
    }
    if (this.quarantined.has(this.promptVersion)) return `prompt version ${this.promptVersion} quarantined (21.1 prohibited inquiry)`;
    return null;
  }

  /** Run one turn for the party, serialized behind its earlier turns; null when the turn is bypassed (the caller answers the placeholder). A factory enqueues at once and builds the request when its turn comes (the first turn after sign-up). */
  run(partyId: string, req: AgentTurnRequest | (() => Promise<AgentTurnRequest | null>)): Promise<AgentTurnReply | null> {
    const prev = this.queues.get(partyId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => { const r = typeof req === "function" ? await req() : req; return r ? this.turn(r) : null; });
    this.queues.set(partyId, next);
    return next;
  }
  /** Every queued turn has run (tests drive a message, settle, then read the thread). */
  async settle(): Promise<void> { await Promise.all([...this.queues.values()].map((p) => p.catch(() => undefined))); }

  private async turn(req: AgentTurnRequest): Promise<AgentTurnReply | null> {
    const { runtime, ui, logger } = this.d; const started = Date.now();
    const why = await this.bypassed(req.routed_to);
    if (why) { logger.warn("borrower.agent.bypassed", { party_id: req.ctx.party.id, agent: req.routed_to, why }); return null; }
    const turn_id = randomUUID(); const party = req.ctx.party; const level = req.ctx.session.level;
    // ---- the situation: the record, the cards, the last messages, the lead (nothing else)
    const cards = await ui.cardsOf(party.id);
    const record = req.subject ? await this.d.reader.record(party, req.subject, cards, req.now) : null;
    const allMessages = await ui.messagesAfter(req.conversation_id, null, 500);
    const window = allMessages.filter((m) => m.message_id !== req.message_id).slice(-(MESSAGE_WINDOW[req.channel] ?? 12) * 3);
    const lead = await this.leadOf(party.id);
    const partner = await this.d.partner(req.ctx);
    const safeMode = await this.flag("origination.ai_mlo_intake", "assisted");
    const next0 = sessionNextOf(record, cards);
    const context = buildContext({ partyFirstName: party.legal_name.split(/\s+/)[0] ?? party.legal_name, level, channel: req.channel, routed_to: req.routed_to, safeMode, partnerName: partner.legal_name, record, cards, messages: window, lead, next: next0, borrowerText: req.text });
    const disclosureFirst = allMessages[0]?.body_text === "{{copy:entry.disclosure.first}}";
    // ---- the model, on the bus's tools
    const ledger = newLedger(); Object.assign(ledger.tokens, context.tokens);
    const run = { runId: `turn:${turn_id}`, modelVersion: this.d.llm.model, promptVersion: this.promptVersion };
    const execute = toolExecutor({ runtime, ledger, run, facts: { party_id: party.id, session_id: req.ctx.session.session_id, conversation_id: req.conversation_id, message_id: req.message_id, channel: req.channel, assurance_level: level, subject: req.subject, routed_to: req.routed_to, utterance: req.text } });
    const input = { system: context.system, messages: [{ role: "user" as const, content: context.situation }], tools: MODEL_TOOLS, execute, maxTokens: 2048 };
    let out: LlmTurnOutput;
    try { out = await this.d.llm.turn(input); }
    catch (e) { logger.error("borrower.agent.model_failed", { turn_id, error: e instanceof Error ? e.message : String(e) }); return this.fallback(req, turn_id, next0.copy_key, null, ledger, context.hash, started, { input_tokens: 0, output_tokens: 0 }, "model_failed"); }
    // ---- the guard: one regeneration, then the step's default copy
    const templates = copyTemplates(); let guard: GuardResult | null = null; let attempts = 0;
    for (;;) {
      attempts++;
      if (out.refused || !out.text.trim()) { guard = null; break; }
      const classification = classifyUtterance(out.text, { proposed: ledger.proposed_card_instance_id !== null, routed_to: req.routed_to });
      const safe = await this.safePermission(req, classification, turn_id);
      guard = guardUtterance({ text: out.text, borrowerText: req.text, tokens: ledger.tokens, ratesElementShown: ledger.elements.some((e) => e["element"] === "rates"), ratesFigures: ledger.elements.flatMap((e) => [e["low_rate"], e["high_rate"], e["low_apr"], e["high_apr"]].map(String)), templates, classification, safe, promptVersion: this.promptVersion, utteranceId: turn_id, disclosureFirst });
      if (guard.ok) break;
      if (guard.quarantine_prompt_version) this.quarantined.add(guard.quarantine_prompt_version);
      // every rejection is an agent_turns row of its own (no reply_message_id)
      await this.record({ turn_id: randomUUID(), req, reply_message_id: null, context_hash: context.hash, ledger, classification, guard, latency_ms: Date.now() - started, usage: out.usage, attempt: attempts });
      logger.warn("borrower.agent.guard", { turn_id, attempt: attempts, rejected_by: guard.rejected_by, violation: guard.violation, regenerable: guard.regenerable });
      if (!guard.regenerable || attempts >= 2) break;
      try { out = await this.d.llm.regenerate(out, input, guard.violation ?? "the reply broke a rule"); }
      catch (e) { logger.error("borrower.agent.model_failed", { turn_id, error: e instanceof Error ? e.message : String(e) }); break; }
    }
    const accepted = guard?.ok === true;
    const classification = guard?.classification ?? null;
    // ---- the reply: the model's sentence with its tokens filled, or the step's default copy
    let body: string; let copy_key = ""; let fallback: string | null = null;
    if (accepted) { const f = fillTokens(out.text, ledger.tokens); body = f.text; if (f.unknown.length) logger.warn("borrower.agent.unknown_tokens", { turn_id, unknown: f.unknown }); }
    else { copy_key = next0.copy_key ?? (req.routed_to === "intake" ? THREAD_COPY_KEYS.placeholderIntake : THREAD_COPY_KEYS.placeholderServicing); body = `{{copy:${copy_key}}}`; fallback = out.refused ? "model_refused" : guard ? guard.rejected_by ?? "rejected" : "empty"; }
    const subjectIds = { subject_application_id: req.subject?.application_id ?? null, subject_loan_id: req.subject?.loan_id ?? null };
    // the rates element(s) the turn's tools produced ride on their own rows, before the reply (§3.5 check 2)
    for (const el of ledger.elements) await ui.appendMessage({ conversation_id: req.conversation_id, at: req.now, sender: "system", sender_ref: `agent:${req.routed_to}`, channel: req.channel, body_text: null, copy_tokens: el, ...subjectIds });
    const card_instance_id = ledger.proposed_card_instance_id ?? ledger.requested_card_instance_id ?? null;
    const copy_tokens: P = { source: "agent_turn", turn_id, ...(fallback ? { fallback: "default_copy", rejected_by: fallback, copy_key } : {}), ...(ledger.explained ? { explain: ledger.explained } : {}) };
    const replyId = await ui.appendMessage({ conversation_id: req.conversation_id, at: req.now, sender: "agent", sender_ref: `agent:${req.routed_to}`, channel: req.channel, body_text: body, card_instance_id, copy_tokens, voice_turn: req.channel === "voice", ...subjectIds });
    const reply = (await ui.message(replyId))!;
    // ---- §3.7: the third miss on a card goes to a human, with the transcript reference
    let command: string | null = null;
    if (ledger.proposed_misses >= MISSES_TO_HUMAN && ledger.proposed_card_instance_id) {
      try {
        await runtime.execute({ process: "32.16", name: "human.transfer", loanId: req.subject?.loan_id ?? "", ...(req.subject?.application_id ? { applicationId: req.subject.application_id } : {}), actor: { kind: "agent", id: req.routed_to }, run,
          input: { reason: "capture_misses", utterance: req.text, card_instance_id: ledger.proposed_card_instance_id, party_id: party.id, session_id: req.ctx.session.session_id, conversation_id: req.conversation_id, message_id: req.message_id, channel: req.channel, assurance_level: level, subject: { application_id: req.subject?.application_id ?? null, loan_id: req.subject?.loan_id ?? null } } });
        ledger.human_requested = true; command = "human.request";
      } catch (e) { logger.error("borrower.agent.misses.transfer_failed", { turn_id, error: e instanceof Error ? e.message : String(e) }); }
    }
    // (6) "are you a real person?" answered in the model's words → 20.3's re-delivery is logged (answerAreYouHuman)
    if (accepted && ASKS_IF_HUMAN.test(req.text)) await this.logAreYouHuman(req, lead).catch((e) => logger.warn("borrower.agent.are_you_human.log_failed", { turn_id, error: e instanceof Error ? e.message : String(e) }));
    if (ledger.human_requested && !command) command = "human.request";
    await this.record({ turn_id, req, reply_message_id: replyId, context_hash: context.hash, ledger, classification, guard, latency_ms: Date.now() - started, usage: out.usage, attempt: attempts, fallback });
    await this.d.flows.settle();
    const next1 = sessionNextOf(record, await ui.cardsOf(party.id));
    this.d.hub.notify(party.id, { event_name: "message.appended", at: req.now, subject: { application_id: subjectIds.subject_application_id, loan_id: subjectIds.subject_loan_id }, ref: replyId });
    logger.info("borrower.agent.turn", { turn_id, party_id: party.id, agent: req.routed_to, model: this.d.llm.model, prompt_version: this.promptVersion, calls: ledger.calls.map((c) => c.name), accepted, fallback, classification, next_before: next0.card_instance_id, next_after: next1.card_instance_id, ms: Date.now() - started, tokens_in: out.usage.input_tokens, tokens_out: out.usage.output_tokens });
    return { reply, copy_key, turn_id, guard, calls: ledger.calls, command_executed: ledger.calls.some((c) => !c.is_error && (c.name === "command.run" || c.name === "human.transfer" || c.name === "card.request")) || command !== null, command };
  }

  /** The model failed outright: the step's default copy, recorded like any other attempt. */
  private async fallback(req: AgentTurnRequest, turn_id: string, stepCopyKey: string | null, guard: GuardResult | null, ledger: ToolLedger, context_hash: string, started: number, usage: { input_tokens: number; output_tokens: number }, why: string): Promise<AgentTurnReply> {
    const copy_key = stepCopyKey ?? (req.routed_to === "intake" ? THREAD_COPY_KEYS.placeholderIntake : THREAD_COPY_KEYS.placeholderServicing);
    const replyId = await this.d.ui.appendMessage({ conversation_id: req.conversation_id, at: req.now, sender: "agent", sender_ref: `agent:${req.routed_to}`, channel: req.channel, body_text: `{{copy:${copy_key}}}`, copy_tokens: { source: "agent_turn", turn_id, fallback: "default_copy", rejected_by: why, copy_key }, subject_application_id: req.subject?.application_id ?? null, subject_loan_id: req.subject?.loan_id ?? null });
    await this.record({ turn_id, req, reply_message_id: replyId, context_hash, ledger, classification: null, guard, latency_ms: Date.now() - started, usage, attempt: 1, fallback: why });
    return { reply: (await this.d.ui.message(replyId))!, copy_key, turn_id, guard, calls: ledger.calls, command_executed: false, command: null };
  }

  /** 21.1's permission for the class, logged through the bus (safe_activity.logged / interview.utterance.blocked) when the application's intake record exists; local otherwise. */
  private async safePermission(req: AgentTurnRequest, classification: SafeClassification, utterance_id: string): Promise<SafePermission> {
    const local = (allowed: boolean, reason: string | null): SafePermission => ({ allowed, classification, fallback: allowed ? null : "general_explanation", reason, source: "local" });
    if (req.routed_to !== "intake") return local(true, null);   // the SAFE gate is origination's; a serviced loan's conversation is 4.x's
    const appId = req.subject?.application_id ?? null;
    const intake = appId ? (await this.d.runtime.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM entity_current WHERE kind = 'applications' AND id = $1`, [appId]))[0]?.n !== "0" : false;
    if (!intake) return AI_PERMITTED_ALWAYS.includes(classification) ? local(true, null) : local(false, `${classification} needs the MLO of record's review (no interview record yet)`);
    try {
      const r = await this.d.runtime.execute({ process: "21.1", name: "logSafeActivity", loanId: "", applicationId: appId!, actor: INTAKE, input: { application_id: appId, utterance_id, classification, at: req.now }, run: { runId: `turn:${utterance_id}`, modelVersion: this.d.llm.model, promptVersion: this.promptVersion } });
      const o = r.output as P;
      return { allowed: o["presented"] === true, classification, fallback: (o["fallback"] as SafeClassification | null) ?? null, reason: (o["reason"] as string | null) ?? null, source: "bus" };
    } catch (e) {
      if (e instanceof CommandRefused) return { allowed: false, classification, fallback: "general_explanation", reason: `${e.code}: ${e.message}`, source: "bus" };
      this.d.logger.warn("borrower.agent.safe.log_failed", { utterance_id, error: e instanceof Error ? e.message : String(e) });
      return AI_PERMITTED_ALWAYS.includes(classification) ? local(true, null) : local(false, e instanceof Error ? e.message : String(e));
    }
  }

  private async logAreYouHuman(req: AgentTurnRequest, lead: P | null): Promise<void> {
    const interaction = ((lead?.["interactions"] as P[] | undefined) ?? []).at(-1); if (!lead || !interaction) return;
    await this.d.runtime.execute({ process: "20.3", name: "deliverDisclosure", loanId: "", ...(req.subject?.application_id ? { applicationId: req.subject.application_id } : {}), actor: INTAKE, input: { op: "are_you_human", lead_id: String(lead["lead_id"]), interaction_id: String(interaction["interaction_id"]) } });
  }

  /** The party's lead (a global entity row): the facts a lead on the cookie carried, and the interaction 20.3's re-logging needs. */
  private async leadOf(partyId: string): Promise<P | null> {
    const row = (await this.d.runtime.db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'leads' AND data->>'party_id' = $1 ORDER BY updated_at DESC LIMIT 1`, [partyId]))[0];
    return row ? decodeEntityData(row.data) : null;
  }
  private async flag(key: string, fallback: string): Promise<string> {
    const row = (await this.d.runtime.db.query<{ value: unknown }>(`SELECT value FROM feature_flags WHERE key = $1`, [key]))[0];
    return typeof row?.value === "string" ? row.value : fallback;
  }

  /** The append-only `agent_turns` row (0119): one per attempt. */
  private async record(r: { turn_id: string; req: AgentTurnRequest; reply_message_id: string | null; context_hash: string; ledger: ToolLedger; classification: SafeClassification | null; guard: GuardResult | null; latency_ms: number; usage: { input_tokens: number; output_tokens: number }; attempt: number; fallback?: string | null }, q: Queryable = this.d.runtime.db): Promise<void> {
    const guard_result = { ...(r.guard ? { ok: r.guard.ok, rejected_by: r.guard.rejected_by, violation: r.guard.violation, regenerable: r.guard.regenerable, checks: r.guard.checks } : { ok: false, rejected_by: r.fallback ?? "model_refused" }), attempt: r.attempt, ...(r.fallback ? { fallback: "default_copy", reason: r.fallback } : {}), elements: r.ledger.elements.map((e) => e["element"]), proposed_card_instance_id: r.ledger.proposed_card_instance_id, misses: r.ledger.proposed_misses, human_requested: r.ledger.human_requested };
    await q.query(`INSERT INTO agent_turns (turn_id, conversation_id, party_id, session_id, message_id, reply_message_id, channel, ai_system_version_id, model_version, prompt_version, tier, context_hash, tool_calls, safe_classification, guard_result, latency_ms, tokens_in, tokens_out, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb, $15, $16, $17, $18)`,
      [r.turn_id, r.req.conversation_id, r.req.ctx.party.id, r.req.ctx.session.session_id, r.req.message_id, r.reply_message_id, r.req.channel, this.d.llm.model, this.promptVersion, AGENT_TIER, r.context_hash, JSON.stringify(r.ledger.calls), r.classification, JSON.stringify(guard_result), r.latency_ms, r.usage.input_tokens, r.usage.output_tokens, r.req.now]);
  }
}
