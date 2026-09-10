/**
 * §16 payoff and lien release tools — the spec's tool strings for its processes, verbatim, defined with
 * `defineTools(process, agent, defs)` from ../tools.ts (see section13.ts for the
 * pattern). Registered by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";
import { TOOLS_16_1 } from "./section16-1.ts";
import { TOOLS_16_2 } from "./section16-2.ts";
import { TOOLS_16_3 } from "./section16-3.ts";
import { TOOLS_16_4 } from "./section16-4.ts";

export const SECTION_16_TOOLS: readonly ToolDef[] = [...TOOLS_16_1, ...TOOLS_16_2, ...TOOLS_16_3, ...TOOLS_16_4];
