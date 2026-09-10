/**
 * §2.6 process-owned tools — additional bus tools for 2.6 defined with `defineTools("2.6", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section02.ts). Every tool string must be one
 * spec/registry/agents.json names for 2.6; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_2_6: readonly ToolDef[] = [];
