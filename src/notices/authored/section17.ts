/**
 * Authored template versions for the §17 transfers out notices (see section13.ts for the
 * pattern: V(code, source, rules, sample, ruleSet, formBasis) with block-level
 * checklists). `SECTION_17_OVERRIDES` carries this section's channel/combination
 * policy per code; both are spread by ../catalog.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";
import { VERSIONS_17_1, OVERRIDES_17_1 } from "./section17-1.ts";
import { VERSIONS_17_2, OVERRIDES_17_2 } from "./section17-2.ts";
import { VERSIONS_17_3, OVERRIDES_17_3 } from "./section17-3.ts";
import { VERSIONS_17_4, OVERRIDES_17_4 } from "./section17-4.ts";

export const SECTION_17_VERSIONS: VersionInput[] = [...VERSIONS_17_1, ...VERSIONS_17_2, ...VERSIONS_17_3, ...VERSIONS_17_4];
export const SECTION_17_OVERRIDES: Record<string, Partial<NoticeTemplate>> = { ...OVERRIDES_17_1, ...OVERRIDES_17_2, ...OVERRIDES_17_3, ...OVERRIDES_17_4 };
