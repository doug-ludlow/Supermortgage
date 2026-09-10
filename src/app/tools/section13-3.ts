/**
 * §13.3 process-owned tools — additional bus tools for 13.3 defined with `defineTools("13.3", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section13.ts). Every tool string must be one
 * spec/registry/agents.json names for 13.3; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_13_3: readonly ToolDef[] = [];
