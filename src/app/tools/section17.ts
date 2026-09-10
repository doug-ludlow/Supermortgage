/**
 * §17 transfers out tools — the spec's tool strings for its processes, verbatim, defined with
 * `defineTools(process, agent, defs)` from ../tools.ts (see section13.ts for the
 * pattern). Registered by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";
import { TOOLS_17_1 } from "./section17-1.ts";
import { TOOLS_17_2 } from "./section17-2.ts";
import { TOOLS_17_3 } from "./section17-3.ts";
import { TOOLS_17_4 } from "./section17-4.ts";

export const SECTION_17_TOOLS: readonly ToolDef[] = [...TOOLS_17_1, ...TOOLS_17_2, ...TOOLS_17_3, ...TOOLS_17_4];
