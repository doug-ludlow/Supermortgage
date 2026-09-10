/**
 * §9.6 process-owned tools — additional bus tools for 9.6 defined with `defineTools("9.6", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section09.ts). Every tool string must be one
 * spec/registry/agents.json names for 9.6; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_9_6: readonly ToolDef[] = [];
