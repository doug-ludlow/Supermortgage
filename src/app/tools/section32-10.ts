/**
 * §32.10 process-owned tools — bus tools for 32.10 defined with `defineTools("32.10", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 32.10; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_32_10: readonly ToolDef[] = [];
