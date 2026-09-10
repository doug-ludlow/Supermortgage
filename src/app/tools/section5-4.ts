/**
 * §5.4 process-owned tools — additional bus tools for 5.4 defined with `defineTools("5.4", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section05.ts). Every tool string must be one
 * spec/registry/agents.json names for 5.4; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_5_4: readonly ToolDef[] = [];
