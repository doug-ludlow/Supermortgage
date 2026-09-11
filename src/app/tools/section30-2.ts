/**
 * §30.2 process-owned tools — bus tools for 30.2 defined with `defineTools("30.2", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 30.2; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_30_2: readonly ToolDef[] = [];
