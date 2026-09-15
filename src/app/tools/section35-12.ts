/**
 * §35.12 process-owned tools — bus tools for 35.12 defined with `defineTools("35.12", <agent>, defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 35.12; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 */
import type { ToolDef } from "../tools.ts";

export const TOOLS_35_12: readonly ToolDef[] = [];
