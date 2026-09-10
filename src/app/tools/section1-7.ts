/**
 * §1.7 process-owned tools — additional bus tools for 1.7 defined with `defineTools("1.7", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section01.ts). Every tool string must be one
 * spec/registry/agents.json names for 1.7; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_1_7: readonly ToolDef[] = [];
