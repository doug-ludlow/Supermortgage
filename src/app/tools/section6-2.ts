/**
 * §6.2 process-owned tools — additional bus tools for 6.2 defined with `defineTools("6.2", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section06.ts). Every tool string must be one
 * spec/registry/agents.json names for 6.2; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_6_2: readonly ToolDef[] = [];
