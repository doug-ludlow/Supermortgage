/**
 * Authored template versions for the §16 payoff and lien release notices (see section13.ts for the
 * pattern: V(code, source, rules, sample, ruleSet, formBasis) with block-level
 * checklists). `SECTION_16_OVERRIDES` carries this section's channel/combination
 * policy per code; both are spread by ../catalog.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";
import { VERSIONS_16_1, OVERRIDES_16_1 } from "./section16-1.ts";
import { VERSIONS_16_2, OVERRIDES_16_2 } from "./section16-2.ts";
import { VERSIONS_16_3, OVERRIDES_16_3 } from "./section16-3.ts";
import { VERSIONS_16_4, OVERRIDES_16_4 } from "./section16-4.ts";

export const SECTION_16_VERSIONS: VersionInput[] = [...VERSIONS_16_1, ...VERSIONS_16_2, ...VERSIONS_16_3, ...VERSIONS_16_4];
export const SECTION_16_OVERRIDES: Record<string, Partial<NoticeTemplate>> = { ...OVERRIDES_16_1, ...OVERRIDES_16_2, ...OVERRIDES_16_3, ...OVERRIDES_16_4 };
