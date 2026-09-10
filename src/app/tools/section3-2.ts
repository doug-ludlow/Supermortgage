/**
 * §3.2 process-owned tools — additional bus tools for 3.2 defined with `defineTools("3.2", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section03.ts). Every tool string must be one
 * spec/registry/agents.json names for 3.2; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_3_2: readonly ToolDef[] = [];
