/**
 * Test-only: a command bus bound to the §3 tools so the acceptance tests can prove guardrails through the same path
 * the agent uses (refusals are `command.refused` events; nothing else runs). Not imported by production code.
 */
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { SECTION_03_TOOLS } from "../../app/tools/section03.ts";
import { TOOLS_3_6 } from "../../app/tools/section3-6.ts";
import { TOOLS_3_7 } from "../../app/tools/section3-7.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

export { CommandRefused };
export const ESCROW_AGENT: Actor = { kind: "agent", id: "escrow" };
export const OFFICER_A: Actor = { kind: "human", id: "u-officer-a", role: "officer" };
export const OFFICER_B: Actor = { kind: "human", id: "u-officer-b", role: "officer" };
export const ANALYST: Actor = { kind: "human", id: "u-analyst", role: "ops_analyst" };

export interface EscrowBus {
  readonly ctx: UowContext & { decisions: DecisionInput[] };
  readonly rt: ToolRuntime;
  readonly events: MemoryEventStore;
  run(process: string, tool: string, actor: Actor, input: Record<string, unknown>): Promise<unknown>;
  /** Execute and return the typed refusal (or null when the command ran). */
  refusal(process: string, tool: string, actor: Actor, input: Record<string, unknown>): Promise<CommandRefused | null>;
}

/** `processes` names the §3 processes whose registry timers (with the §3 overrides) the harness arms and satisfies from the bus's events; empty = no timers. */
export function escrowBus(loanId = "L-1", now = "2027-03-02T15:00:00.000Z", processes: readonly string[] = []): EscrowBus {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const ctx: UowContext & { decisions: DecisionInput[] } = { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(processes.length ? loadOverriddenRegistry() : loadRegistry(), events, { processes: [...processes] }), clock, decide: (d) => { decisions.push({ loanId, ...d }); }, decisions };
  const agents = new AgentRegistry();
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  // Bind only the §3 tools (the same binding tools/index.ts performs), so these tests never load other sections' files.
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map([...SECTION_03_TOOLS, ...TOOLS_3_6, ...TOOLS_3_7].map((d) => { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); return [`${d.process} ${d.name}`, cmd] as const; }));
  const bus = new CommandBus(agents);
  const run = async (process: string, tool: string, actor: Actor, input: Record<string, unknown>): Promise<unknown> => { const cmd = cmds.get(`${process} ${tool}`); if (!cmd) throw new RangeError(`no §3 tool ${process} ${tool}`); return (await bus.execute(cmd, actor, input, ctx)).output; };
  const refusal = async (process: string, tool: string, actor: Actor, input: Record<string, unknown>): Promise<CommandRefused | null> => { try { await run(process, tool, actor, input); return null; } catch (e) { if (e instanceof CommandRefused) return e; throw e; } };
  return { ctx, rt, events, run, refusal };
}
