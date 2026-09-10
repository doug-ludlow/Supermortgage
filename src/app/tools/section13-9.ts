/**
 * §13.9 process-owned tools — additional bus tools for 13.9 defined with `defineTools("13.9", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section13.ts). Every tool string must be one
 * spec/registry/agents.json names for 13.9; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_13_9: readonly ToolDef[] = [];
