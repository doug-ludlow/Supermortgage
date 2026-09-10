/**
 * Authored template versions for the §19 records, security, vendors and fair lending notices (see section13.ts for the
 * pattern: V(code, source, rules, sample, ruleSet, formBasis) with block-level
 * checklists). `SECTION_19_OVERRIDES` carries this section's channel/combination
 * policy per code; both are spread by ../catalog.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";
import { VERSIONS_19_1, OVERRIDES_19_1 } from "./section19-1.ts";
import { VERSIONS_19_2, OVERRIDES_19_2 } from "./section19-2.ts";
import { VERSIONS_19_3, OVERRIDES_19_3 } from "./section19-3.ts";
import { VERSIONS_19_4, OVERRIDES_19_4 } from "./section19-4.ts";

export const SECTION_19_VERSIONS: VersionInput[] = [...VERSIONS_19_1, ...VERSIONS_19_2, ...VERSIONS_19_3, ...VERSIONS_19_4];
export const SECTION_19_OVERRIDES: Record<string, Partial<NoticeTemplate>> = { ...OVERRIDES_19_1, ...OVERRIDES_19_2, ...OVERRIDES_19_3, ...OVERRIDES_19_4 };
