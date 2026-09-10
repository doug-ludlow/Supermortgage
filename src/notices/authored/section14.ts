/**
 * Authored template versions for the §14 bankruptcy notices (see section13.ts for the
 * pattern: V(code, source, rules, sample, ruleSet, formBasis) with block-level
 * checklists). `SECTION_14_OVERRIDES` carries this section's channel/combination
 * policy per code; both are spread by ../catalog.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const SECTION_14_VERSIONS: VersionInput[] = [];
export const SECTION_14_OVERRIDES: Record<string, Partial<NoticeTemplate>> = {};
