/**
 * §26.1 process-owned tools — bus tools for 26.1 defined with `defineTools("26.1", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 26.1; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_26_1: readonly ToolDef[] = [];
