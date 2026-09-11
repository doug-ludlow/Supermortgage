/**
 * §23.3 process-owned tools — bus tools for 23.3 defined with `defineTools("23.3", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 23.3; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_23_3: readonly ToolDef[] = [];
