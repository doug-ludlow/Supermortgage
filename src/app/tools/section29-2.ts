/**
 * §29.2 process-owned tools — bus tools for 29.2 defined with `defineTools("29.2", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 29.2; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_29_2: readonly ToolDef[] = [];
