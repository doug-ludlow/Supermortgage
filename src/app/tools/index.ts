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
import { SECTION_09_TOOLS } from "./section09.ts";
import { SECTION_10_TOOLS } from "./section10.ts";
import { SECTION_11_TOOLS } from "./section11.ts";
import { SECTION_12_TOOLS } from "./section12.ts";
import { SECTION_13_TOOLS } from "./section13.ts";
import { SECTION_14_TOOLS } from "./section14.ts";
import { SECTION_15_TOOLS } from "./section15.ts";
import { SECTION_16_TOOLS } from "./section16.ts";
import { SECTION_17_TOOLS } from "./section17.ts";
import { SECTION_18_TOOLS } from "./section18.ts";
import { SECTION_19_TOOLS } from "./section19.ts";
// ---- §1–§13 process-owned files (scaffolded by tools/workflows/wire.py)
import { TOOLS_1_1 } from "./section1-1.ts";
import { TOOLS_1_2 } from "./section1-2.ts";
import { TOOLS_1_3 } from "./section1-3.ts";
import { TOOLS_1_4 } from "./section1-4.ts";
import { TOOLS_1_5 } from "./section1-5.ts";
import { TOOLS_1_6 } from "./section1-6.ts";
import { TOOLS_1_7 } from "./section1-7.ts";
import { TOOLS_2_1 } from "./section2-1.ts";
import { TOOLS_2_2 } from "./section2-2.ts";
import { TOOLS_2_3 } from "./section2-3.ts";
import { TOOLS_2_4 } from "./section2-4.ts";
import { TOOLS_2_5 } from "./section2-5.ts";
import { TOOLS_2_6 } from "./section2-6.ts";
import { TOOLS_2_7 } from "./section2-7.ts";
import { TOOLS_3_1 } from "./section3-1.ts";
import { TOOLS_3_2 } from "./section3-2.ts";
import { TOOLS_3_3 } from "./section3-3.ts";
import { TOOLS_3_4 } from "./section3-4.ts";
import { TOOLS_3_5 } from "./section3-5.ts";
import { TOOLS_3_6 } from "./section3-6.ts";
import { TOOLS_3_7 } from "./section3-7.ts";
import { TOOLS_3_8 } from "./section3-8.ts";
import { TOOLS_3_9 } from "./section3-9.ts";
import { TOOLS_4_1 } from "./section4-1.ts";
import { TOOLS_4_2 } from "./section4-2.ts";
import { TOOLS_4_3 } from "./section4-3.ts";
import { TOOLS_4_4 } from "./section4-4.ts";
import { TOOLS_4_5 } from "./section4-5.ts";
import { TOOLS_5_1 } from "./section5-1.ts";
import { TOOLS_5_2 } from "./section5-2.ts";
import { TOOLS_5_3 } from "./section5-3.ts";
import { TOOLS_5_4 } from "./section5-4.ts";
import { TOOLS_5_5 } from "./section5-5.ts";
import { TOOLS_5_6 } from "./section5-6.ts";
import { TOOLS_5_7 } from "./section5-7.ts";
import { TOOLS_6_1 } from "./section6-1.ts";
import { TOOLS_6_2 } from "./section6-2.ts";
import { TOOLS_6_3 } from "./section6-3.ts";
import { TOOLS_6_4 } from "./section6-4.ts";
import { TOOLS_6_5 } from "./section6-5.ts";
import { TOOLS_7_1 } from "./section7-1.ts";
import { TOOLS_7_2 } from "./section7-2.ts";
import { TOOLS_7_3 } from "./section7-3.ts";
import { TOOLS_7_4 } from "./section7-4.ts";
import { TOOLS_7_5 } from "./section7-5.ts";
import { TOOLS_7_6 } from "./section7-6.ts";
import { TOOLS_8_1 } from "./section8-1.ts";
import { TOOLS_8_2 } from "./section8-2.ts";
import { TOOLS_8_3 } from "./section8-3.ts";
import { TOOLS_9_1 } from "./section9-1.ts";
import { TOOLS_9_2 } from "./section9-2.ts";
import { TOOLS_9_3 } from "./section9-3.ts";
import { TOOLS_9_4 } from "./section9-4.ts";
import { TOOLS_9_5 } from "./section9-5.ts";
import { TOOLS_9_6 } from "./section9-6.ts";
import { TOOLS_9_7 } from "./section9-7.ts";
import { TOOLS_9_8 } from "./section9-8.ts";
import { TOOLS_9_9 } from "./section9-9.ts";
import { TOOLS_10_1 } from "./section10-1.ts";
import { TOOLS_10_2 } from "./section10-2.ts";
import { TOOLS_10_3 } from "./section10-3.ts";
import { TOOLS_10_4 } from "./section10-4.ts";
import { TOOLS_10_5 } from "./section10-5.ts";
import { TOOLS_10_6 } from "./section10-6.ts";
import { TOOLS_11_1 } from "./section11-1.ts";
import { TOOLS_11_2 } from "./section11-2.ts";
import { TOOLS_11_3 } from "./section11-3.ts";
import { TOOLS_11_4 } from "./section11-4.ts";
import { TOOLS_11_5 } from "./section11-5.ts";
import { TOOLS_12_1 } from "./section12-1.ts";
import { TOOLS_12_2 } from "./section12-2.ts";
import { TOOLS_12_3 } from "./section12-3.ts";
import { TOOLS_12_4 } from "./section12-4.ts";
import { TOOLS_12_5 } from "./section12-5.ts";
import { TOOLS_12_6 } from "./section12-6.ts";
import { TOOLS_12_7 } from "./section12-7.ts";
import { TOOLS_12_8 } from "./section12-8.ts";
import { TOOLS_12_9 } from "./section12-9.ts";
import { TOOLS_13_1 } from "./section13-1.ts";
import { TOOLS_13_2 } from "./section13-2.ts";
import { TOOLS_13_3 } from "./section13-3.ts";
import { TOOLS_13_4 } from "./section13-4.ts";
import { TOOLS_13_5 } from "./section13-5.ts";
import { TOOLS_13_6 } from "./section13-6.ts";
import { TOOLS_13_7 } from "./section13-7.ts";
import { TOOLS_13_8 } from "./section13-8.ts";
import { TOOLS_13_9 } from "./section13-9.ts";

export const ALL_TOOLS: readonly ToolDef[] = [...SECTION_01_TOOLS, ...SECTION_02_TOOLS, ...SECTION_03_TOOLS, ...SECTION_04_TOOLS, ...SECTION_05_TOOLS, ...SECTION_06_TOOLS, ...SECTION_07_TOOLS, ...SECTION_08_TOOLS, ...SECTION_09_TOOLS, ...SECTION_10_TOOLS, ...SECTION_11_TOOLS, ...SECTION_12_TOOLS, ...SECTION_13_TOOLS, ...SECTION_14_TOOLS, ...SECTION_15_TOOLS, ...SECTION_16_TOOLS, ...SECTION_17_TOOLS, ...SECTION_18_TOOLS, ...SECTION_19_TOOLS,
  ...TOOLS_1_1, ...TOOLS_1_2, ...TOOLS_1_3, ...TOOLS_1_4, ...TOOLS_1_5, ...TOOLS_1_6, ...TOOLS_1_7, ...TOOLS_2_1, ...TOOLS_2_2, ...TOOLS_2_3, ...TOOLS_2_4, ...TOOLS_2_5, ...TOOLS_2_6, ...TOOLS_2_7, ...TOOLS_3_1, ...TOOLS_3_2, ...TOOLS_3_3, ...TOOLS_3_4, ...TOOLS_3_5, ...TOOLS_3_6, ...TOOLS_3_7, ...TOOLS_3_8, ...TOOLS_3_9, ...TOOLS_4_1, ...TOOLS_4_2, ...TOOLS_4_3, ...TOOLS_4_4, ...TOOLS_4_5, ...TOOLS_5_1, ...TOOLS_5_2, ...TOOLS_5_3, ...TOOLS_5_4, ...TOOLS_5_5, ...TOOLS_5_6, ...TOOLS_5_7, ...TOOLS_6_1, ...TOOLS_6_2, ...TOOLS_6_3, ...TOOLS_6_4, ...TOOLS_6_5, ...TOOLS_7_1, ...TOOLS_7_2, ...TOOLS_7_3, ...TOOLS_7_4, ...TOOLS_7_5, ...TOOLS_7_6, ...TOOLS_8_1, ...TOOLS_8_2, ...TOOLS_8_3, ...TOOLS_9_1, ...TOOLS_9_2, ...TOOLS_9_3, ...TOOLS_9_4, ...TOOLS_9_5, ...TOOLS_9_6, ...TOOLS_9_7, ...TOOLS_9_8, ...TOOLS_9_9, ...TOOLS_10_1, ...TOOLS_10_2, ...TOOLS_10_3, ...TOOLS_10_4, ...TOOLS_10_5, ...TOOLS_10_6, ...TOOLS_11_1, ...TOOLS_11_2, ...TOOLS_11_3, ...TOOLS_11_4, ...TOOLS_11_5, ...TOOLS_12_1, ...TOOLS_12_2, ...TOOLS_12_3, ...TOOLS_12_4, ...TOOLS_12_5, ...TOOLS_12_6, ...TOOLS_12_7, ...TOOLS_12_8, ...TOOLS_12_9, ...TOOLS_13_1, ...TOOLS_13_2, ...TOOLS_13_3, ...TOOLS_13_4, ...TOOLS_13_5, ...TOOLS_13_6, ...TOOLS_13_7, ...TOOLS_13_8, ...TOOLS_13_9];

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
