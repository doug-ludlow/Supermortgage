/**
 * Authored template versions for the §18 QC, audit and attestations notices (see section13.ts for the
 * pattern: V(code, source, rules, sample, ruleSet, formBasis) with block-level
 * checklists). `SECTION_18_OVERRIDES` carries this section's channel/combination
 * policy per code; both are spread by ../catalog.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";
import { VERSIONS_18_1, OVERRIDES_18_1 } from "./section18-1.ts";
import { VERSIONS_18_2, OVERRIDES_18_2 } from "./section18-2.ts";
import { VERSIONS_18_3, OVERRIDES_18_3 } from "./section18-3.ts";
import { VERSIONS_18_4, OVERRIDES_18_4 } from "./section18-4.ts";
import { VERSIONS_18_5, OVERRIDES_18_5 } from "./section18-5.ts";
import { VERSIONS_18_6, OVERRIDES_18_6 } from "./section18-6.ts";
import { VERSIONS_18_7, OVERRIDES_18_7 } from "./section18-7.ts";

export const SECTION_18_VERSIONS: VersionInput[] = [...VERSIONS_18_1, ...VERSIONS_18_2, ...VERSIONS_18_3, ...VERSIONS_18_4, ...VERSIONS_18_5, ...VERSIONS_18_6, ...VERSIONS_18_7];
export const SECTION_18_OVERRIDES: Record<string, Partial<NoticeTemplate>> = { ...OVERRIDES_18_1, ...OVERRIDES_18_2, ...OVERRIDES_18_3, ...OVERRIDES_18_4, ...OVERRIDES_18_5, ...OVERRIDES_18_6, ...OVERRIDES_18_7 };
