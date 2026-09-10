/**
 * Command bus — the application layer every state change goes through
 * (ARCHITECTURE §"service.ts is the agent's tool surface"). A command
 * declares who may call it (actor kinds/roles), which agent allowlists carry
 * it, its guardrails (pure predicates that refuse before anything runs), and
 * a handler over the unit-of-work context. The bus:
 *
 *   1. checks the AI kill switch / AI-off flag for agent actors,
 *   2. checks the agent's tool allowlist,
 *   3. checks role gates and guardrails — a refusal writes nothing,
 *   4. runs the handler,
 *   5. writes the agent_decisions row (rule set, model, prompt, confidence,
 *      rationale, approver) and a `command.executed` event.
 *
 * Refusals are events too (`command.refused`) so the escalation and audit
 * paths see every attempt the guardrails stopped.
 */
import type { Actor, DomainEvent } from "../kernel/events/index.ts";
import type { UowContext } from "../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../infra/db/decisions.ts";
import { RoleDenied, hasRole, isAgent, describe } from "./roles.ts";
import type { AgentRegistry } from "./agents.ts";

export interface Guardrail<I> { readonly code: string; readonly citation: string; readonly refuse: (input: I, ctx: CommandContext) => string | undefined; }

export interface CommandSpec<I, O> {
  readonly name: string;                       // "cashiering.postPayment"
  readonly process: string;                    // spec process id
  readonly agent: string;                      // owning agent
  /** Who may invoke: agents (through their allowlist) and/or humans with these roles; empty roles = any human. */
  readonly allow: { readonly agents?: boolean; readonly humanRoles?: readonly string[]; readonly humansAny?: boolean };
  readonly guardrails?: readonly Guardrail<I>[];
  /** Fields an agent may never change (checked against `input.changes` when present). */
  readonly moneyFields?: readonly string[];
  readonly ruleSetVersion: string;
  readonly handler: (input: I, ctx: CommandContext) => O | Promise<O>;
  /** Builds the decision record; omit for read-only tools. */
  readonly decision?: (input: I, output: O, ctx: CommandContext) => Omit<DecisionInput, "agent" | "ruleSetVersion" | "approvedBy" | "approvedRole"> | null;
}

export interface CommandContext extends UowContext {
  readonly actor: Actor;
  readonly now: string;
  readonly run?: AgentRunInfo;
}
export interface AgentRunInfo { readonly runId: string; readonly modelVersion: string; readonly promptVersion: string; readonly confidence?: number; }

export class CommandRefused extends Error {
  readonly code: string; readonly citation: string; readonly command: string;
  constructor(command: string, code: string, citation: string, reason: string) { super(`${command} refused [${code}]: ${reason}`); this.name = "CommandRefused"; this.code = code; this.citation = citation; this.command = command; }
}
export class AiPathUnavailable extends Error { constructor(agent: string, why: string) { super(`AI path for ${agent} is off: ${why}`); this.name = "AiPathUnavailable"; } }

export interface ExecuteResult<O> { readonly output: O; readonly decisionId?: string; readonly event: DomainEvent; }

export class CommandBus {
  private readonly agents: AgentRegistry;
  constructor(agents: AgentRegistry) { this.agents = agents; }

  async execute<I, O>(cmd: CommandSpec<I, O>, actor: Actor, input: I, uow: UowContext, opts: { now?: string; run?: AgentRunInfo; approvedBy?: Actor } = {}): Promise<ExecuteResult<O>> {
    const now = opts.now ?? uow.clock.now();
    const ctx: CommandContext = { ...uow, actor, now, ...(opts.run ? { run: opts.run } : {}) };
    const refuse = (code: string, citation: string, reason: string): never => {
      const ref = input as { paymentId?: unknown; id?: unknown; batchLoanId?: unknown; noticeId?: unknown } | undefined;
      const subjectId = ref?.paymentId ?? ref?.id ?? ref?.batchLoanId ?? ref?.noticeId ?? null;
      uow.events.append({ type: "command.refused", loanId: uow.loanId, actor, payload: { command: cmd.name, code, citation, reason, subject_id: subjectId === null ? null : String(subjectId) } });
      throw new CommandRefused(cmd.name, code, citation, reason);
    };
    // 1. AI path gates
    if (isAgent(actor)) {
      const state = this.agents.aiState(actor.id);
      if (state.off) refuse("AI_OFF", "18.1 kill switch / AI-off mode", state.why ?? "AI path disabled");
      // 2. allowlist
      if (!this.agents.allows(actor.id, cmd.name)) refuse("NOT_ALLOWLISTED", `${cmd.process} agent tool allowlist`, `${actor.id} may not call ${cmd.name}`);
      if (!cmd.allow.agents) refuse("HUMAN_ONLY", `${cmd.process} guardrails`, `${cmd.name} is a human act`);
    } else if (actor.kind === "human") {
      if (!cmd.allow.humansAny && !(cmd.allow.humanRoles && hasRole(actor, cmd.allow.humanRoles))) refuse("ROLE_DENIED", `${cmd.process} guardrails`, new RoleDenied(actor, cmd.allow.humanRoles ?? ["human"], cmd.name).message);
    } else if (actor.kind !== "system") {
      refuse("ACTOR_KIND", `${cmd.process} guardrails`, `${describe(actor)} cannot issue commands`);
    }
    // 3. money fields and guardrails
    const changes = (input as { changes?: Record<string, unknown> })?.changes;
    if (cmd.moneyFields && changes && !hasRole(actor, ["officer"])) {
      const touched = Object.keys(changes).filter((f) => cmd.moneyFields!.includes(f));
      if (touched.length) refuse("MONEY_FIELD", "1.1 guardrail: money fields are never agent-corrected", `${touched.join(", ")} require an officer waiver or a transferor correction`);
    }
    for (const g of cmd.guardrails ?? []) { const why = g.refuse(input, ctx); if (why) refuse(g.code, g.citation, why); }
    // 4. run
    const output = await cmd.handler(input, ctx);
    // 5. audit
    let decisionId: string | undefined;
    const d = cmd.decision ? cmd.decision(input, output, ctx) : null;
    if (d) {
      const approver = opts.approvedBy ?? (actor.kind === "human" ? actor : undefined);
      uow.decide({ ...d, agent: cmd.agent, ruleSetVersion: cmd.ruleSetVersion, ...(opts.run ? { modelVersion: opts.run.modelVersion, promptVersion: opts.run.promptVersion, ...(opts.run.confidence !== undefined ? { confidence: opts.run.confidence } : {}) } : {}),
        ...(approver ? { approvedBy: approver.id, ...(approver.role ? { approvedRole: approver.role } : {}) } : {}) });
      decisionId = "queued";
    }
    const event = uow.events.append({ type: "command.executed", loanId: uow.loanId, actor, payload: { command: cmd.name, process: cmd.process, agent: cmd.agent, ...(opts.run ? { run_id: opts.run.runId, model_version: opts.run.modelVersion, prompt_version: opts.run.promptVersion } : {}), decision_recorded: !!d } });
    return { output, event, ...(decisionId ? { decisionId } : {}) };
  }
}
