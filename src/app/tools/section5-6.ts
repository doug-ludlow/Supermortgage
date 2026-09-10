/**
 * §5.6 process-owned tools — additional bus tools for 5.6 defined with `defineTools("5.6", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section05.ts). Every tool string must be one
 * spec/registry/agents.json names for 5.6; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_5_6: readonly ToolDef[] = [];
