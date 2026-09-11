/**
 * §32.3 process-owned tools — bus tools for 32.3 defined with `defineTools("32.3", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 32.3; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_32_3: readonly ToolDef[] = [];
