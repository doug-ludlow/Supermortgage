/**
 * §7.5 process-owned tools — additional bus tools for 7.5 defined with `defineTools("7.5", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section07.ts). Every tool string must be one
 * spec/registry/agents.json names for 7.5; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_7_5: readonly ToolDef[] = [];
