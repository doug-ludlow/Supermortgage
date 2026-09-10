/**
 * Authored template versions for the §15 REO, claims and advances notices (see section13.ts for the
 * pattern: V(code, source, rules, sample, ruleSet, formBasis) with block-level
 * checklists). `SECTION_15_OVERRIDES` carries this section's channel/combination
 * policy per code; both are spread by ../catalog.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";
import { VERSIONS_15_1, OVERRIDES_15_1 } from "./section15-1.ts";
import { VERSIONS_15_2, OVERRIDES_15_2 } from "./section15-2.ts";
import { VERSIONS_15_3, OVERRIDES_15_3 } from "./section15-3.ts";
import { VERSIONS_15_4, OVERRIDES_15_4 } from "./section15-4.ts";

export const SECTION_15_VERSIONS: VersionInput[] = [...VERSIONS_15_1, ...VERSIONS_15_2, ...VERSIONS_15_3, ...VERSIONS_15_4];
export const SECTION_15_OVERRIDES: Record<string, Partial<NoticeTemplate>> = { ...OVERRIDES_15_1, ...OVERRIDES_15_2, ...OVERRIDES_15_3, ...OVERRIDES_15_4 };
