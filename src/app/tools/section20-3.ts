/**
 * §20.3 process-owned tools — bus tools for 20.3 defined with `defineTools("20.3", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 20.3; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_20_3: readonly ToolDef[] = [];
