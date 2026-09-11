/**
 * §22.4 process-owned tools — bus tools for 22.4 defined with `defineTools("22.4", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 22.4; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_22_4: readonly ToolDef[] = [];
