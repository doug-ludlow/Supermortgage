/**
 * §14 bankruptcy tools — the spec's tool strings for its processes, verbatim, defined with
 * `defineTools(process, agent, defs)` from ../tools.ts (see section13.ts for the
 * pattern). Registered by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";
import { TOOLS_14_1 } from "./section14-1.ts";
import { TOOLS_14_2 } from "./section14-2.ts";
import { TOOLS_14_3 } from "./section14-3.ts";
import { TOOLS_14_4 } from "./section14-4.ts";

export const SECTION_14_TOOLS: readonly ToolDef[] = [...TOOLS_14_1, ...TOOLS_14_2, ...TOOLS_14_3, ...TOOLS_14_4];
