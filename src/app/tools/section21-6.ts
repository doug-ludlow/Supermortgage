/**
 * §21.6 process-owned tools — bus tools for 21.6 defined with `defineTools("21.6", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 21.6; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_21_6: readonly ToolDef[] = [];
