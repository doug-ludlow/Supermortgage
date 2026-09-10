/**
 * §18 QC, audit and attestations tools — the spec's tool strings for its processes, verbatim, defined with
 * `defineTools(process, agent, defs)` from ../tools.ts (see section13.ts for the
 * pattern). Registered by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";
import { TOOLS_18_1 } from "./section18-1.ts";
import { TOOLS_18_2 } from "./section18-2.ts";
import { TOOLS_18_3 } from "./section18-3.ts";
import { TOOLS_18_4 } from "./section18-4.ts";
import { TOOLS_18_5 } from "./section18-5.ts";
import { TOOLS_18_6 } from "./section18-6.ts";
import { TOOLS_18_7 } from "./section18-7.ts";

export const SECTION_18_TOOLS: readonly ToolDef[] = [...TOOLS_18_1, ...TOOLS_18_2, ...TOOLS_18_3, ...TOOLS_18_4, ...TOOLS_18_5, ...TOOLS_18_6, ...TOOLS_18_7];
