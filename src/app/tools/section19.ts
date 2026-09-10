/**
 * §19 records, security, vendors and fair lending tools — the spec's tool strings for its processes, verbatim, defined with
 * `defineTools(process, agent, defs)` from ../tools.ts (see section13.ts for the
 * pattern). Registered by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";
import { TOOLS_19_1 } from "./section19-1.ts";
import { TOOLS_19_2 } from "./section19-2.ts";
import { TOOLS_19_3 } from "./section19-3.ts";
import { TOOLS_19_4 } from "./section19-4.ts";

export const SECTION_19_TOOLS: readonly ToolDef[] = [...TOOLS_19_1, ...TOOLS_19_2, ...TOOLS_19_3, ...TOOLS_19_4];
