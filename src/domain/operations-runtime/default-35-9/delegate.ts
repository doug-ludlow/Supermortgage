/**
 * §35.9 rule 2 / rule 3 — running another section's bus tool inside this command's unit of work, as that section's agent
 * (the src/app/tools/section32-2.ts `delegate` pattern): the owning tool's guardrails, role gates, gate evaluations, store
 * writes, events and decision record all run on the same store, event log and transaction as the 35.9 command — no nested
 * unit of work, no savepoint (35.1: never "write in your own unit of work and then throw" inside a command). A gate the
 * section closes surfaces as its own `GateClosed` (the section already appended `foreclosure.gate.refused`); the caller
 * records the refusal and never retries around it.
 */
import type { Actor } from "../../../kernel/events/index.ts";
import { AgentRegistry, loadAgentsFile } from "../../../app/agents.ts";
import { CommandBus, type CommandContext } from "../../../app/commands.ts";
import { GateClosed as _GateClosed } from "../../../app/evaluators.ts";
import { PortUnavailable, toolCommand, type ToolDef, type ToolInput, type ToolRuntime } from "../../../app/tools.ts";

let agentsFile: ReturnType<typeof loadAgentsFile> | undefined;
let fallbackRegistry: AgentRegistry | undefined;
const escalatesTo = (process: string): readonly string[] => { agentsFile ??= loadAgentsFile(); return agentsFile.processes.find((p: { process: string }) => p.process === process)?.escalates_to ?? []; };

export interface Delegated { readonly output: unknown; /** The owning tool's first domain event (never the bus's own `command.*` literal); the command's first event when the tool emitted none. */ readonly event_id: string; readonly decision_id: string | null; readonly events: readonly { id: string; type: string }[] }
/** Execute `<process> <name>` in this command's unit of work as `actor` (default: the tool's own agent). */
export async function delegate(rt: ToolRuntime, ctx: CommandContext, process: string, name: string, input: ToolInput, actor?: Actor): Promise<Delegated> {
  const { ALL_TOOLS } = await import("../../../app/tools/index.ts");
  const def: ToolDef | undefined = ALL_TOOLS.find((t) => t.process === process && t.name === name);
  if (!def) throw new PortUnavailable(`tool:${process} ${name}`);
  let agents = rt.services["agents"] as AgentRegistry | undefined;
  if (!agents) { fallbackRegistry ??= new AgentRegistry(); agents = fallbackRegistry; }
  agents.registerTool(def.agent, def.name);
  const cmd = toolCommand(def, rt, escalatesTo(process));
  const as: Actor = actor ?? { kind: "agent", id: def.agent };
  const mark = ctx.events.all().length;
  const r = await new CommandBus(agents).execute(cmd, as, input, ctx, ctx.run ? { run: ctx.run } : {});
  const appended = ctx.events.all().slice(mark).map((e) => ({ id: e.id, type: e.type }));
  const domain = appended.find((e) => !e.type.startsWith("command.") && !e.type.startsWith("timer.") && !e.type.startsWith("escalation."));
  return { output: r.output, event_id: domain?.id ?? r.event.id, decision_id: r.decisionId ?? null, events: appended };
}
export const GateClosed = _GateClosed;
export const isGateClosed = (e: unknown): e is _GateClosed => e instanceof Error && e.name === "GateClosed";
/** The gate code a refusal names (13.x: the gate ref is the registry code, e.g. BK_362_STAY_GATE). */
export const refusalCode = (e: unknown): string => (isGateClosed(e) ? e.ref : e instanceof Error ? e.name : "unknown");
