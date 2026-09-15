/**
 * §35.5 process-owned tools — bus tools for 35.5 defined with `defineTools("35.5", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 35.5; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_35_5: readonly ToolDef[] = [];
