/**
 * Authored template versions for the §14 bankruptcy notices (see section13.ts for the
 * pattern: V(code, source, rules, sample, ruleSet, formBasis) with block-level
 * checklists). `SECTION_14_OVERRIDES` carries this section's channel/combination
 * policy per code; both are spread by ../catalog.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";
import { VERSIONS_14_1, OVERRIDES_14_1 } from "./section14-1.ts";
import { VERSIONS_14_2, OVERRIDES_14_2 } from "./section14-2.ts";
import { VERSIONS_14_3, OVERRIDES_14_3 } from "./section14-3.ts";
import { VERSIONS_14_4, OVERRIDES_14_4 } from "./section14-4.ts";

export const SECTION_14_VERSIONS: VersionInput[] = [...VERSIONS_14_1, ...VERSIONS_14_2, ...VERSIONS_14_3, ...VERSIONS_14_4];
export const SECTION_14_OVERRIDES: Record<string, Partial<NoticeTemplate>> = { ...OVERRIDES_14_1, ...OVERRIDES_14_2, ...OVERRIDES_14_3, ...OVERRIDES_14_4 };
