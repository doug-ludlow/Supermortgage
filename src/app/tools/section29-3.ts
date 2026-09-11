/**
 * §29.3 process-owned tools — bus tools for 29.3 defined with `defineTools("29.3", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 29.3; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_29_3: readonly ToolDef[] = [];
