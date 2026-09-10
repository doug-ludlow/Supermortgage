/**
 * Every agent tool on the bus, by section. `tools/list-tools.ts` prints the
 * (process, tool) pairs for the audit; `bindTools` turns them into commands
 * over a runtime and registers each with its agent's allowlist.
 */
import type { ToolDef, ToolRuntime } from "../tools.ts";
import { toolCommand } from "../tools.ts";
import type { CommandSpec } from "../commands.ts";
import type { ToolInput } from "../tools.ts";
import { AgentRegistry, loadAgentsFile } from "../agents.ts";
import { SECTION_01_TOOLS } from "./section01.ts";
import { SECTION_02_TOOLS } from "./section02.ts";
import { SECTION_03_TOOLS } from "./section03.ts";
import { SECTION_04_TOOLS } from "./section04.ts";
import { SECTION_05_TOOLS } from "./section05.ts";
import { SECTION_06_TOOLS } from "./section06.ts";
import { SECTION_07_TOOLS } from "./section07.ts";
import { SECTION_08_TOOLS } from "./section08.ts";

export const ALL_TOOLS: readonly ToolDef[] = [...SECTION_01_TOOLS, ...SECTION_02_TOOLS, ...SECTION_03_TOOLS, ...SECTION_04_TOOLS, ...SECTION_05_TOOLS, ...SECTION_06_TOOLS, ...SECTION_07_TOOLS, ...SECTION_08_TOOLS];

export function bindTools(rt: ToolRuntime, agents: AgentRegistry, defs: readonly ToolDef[] = ALL_TOOLS): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of defs) {
    const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []);
    agents.registerTool(d.agent, cmd.name);
    out.set(`${d.process} ${d.name}`, cmd);
  }
  return out;
}
export const toolKey = (process: string, name: string): string => `${process} ${name}`;
