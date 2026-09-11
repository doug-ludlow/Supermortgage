/**
 * §22.1 process-owned tools — bus tools for 22.1 defined with `defineTools("22.1", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 22.1; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_22_1: readonly ToolDef[] = [];
