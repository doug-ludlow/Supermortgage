/**
 * §8.3 process-owned tools — additional bus tools for 8.3 defined with `defineTools("8.3", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section08.ts). Every tool string must be one
 * spec/registry/agents.json names for 8.3; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_8_3: readonly ToolDef[] = [];
