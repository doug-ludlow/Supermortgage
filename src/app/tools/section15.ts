/**
 * §15 REO, claims and advances tools — the spec's tool strings for its processes, verbatim, defined with
 * `defineTools(process, agent, defs)` from ../tools.ts (see section13.ts for the
 * pattern). Registered by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";
import { TOOLS_15_1 } from "./section15-1.ts";
import { TOOLS_15_2 } from "./section15-2.ts";
import { TOOLS_15_3 } from "./section15-3.ts";
import { TOOLS_15_4 } from "./section15-4.ts";

export const SECTION_15_TOOLS: readonly ToolDef[] = [...TOOLS_15_1, ...TOOLS_15_2, ...TOOLS_15_3, ...TOOLS_15_4];
