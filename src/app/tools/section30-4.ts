/**
 * §30.4 process-owned tools — bus tools for 30.4 defined with `defineTools("30.4", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 30.4; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_30_4: readonly ToolDef[] = [];
