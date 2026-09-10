/**
 * §2.7 process-owned tools — additional bus tools for 2.7 defined with `defineTools("2.7", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section02.ts). Every tool string must be one
 * spec/registry/agents.json names for 2.7; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_2_7: readonly ToolDef[] = [];
