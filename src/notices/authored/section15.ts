/**
 * Authored template versions for the §15 REO, claims and advances notices (see section13.ts for the
 * pattern: V(code, source, rules, sample, ruleSet, formBasis) with block-level
 * checklists). `SECTION_15_OVERRIDES` carries this section's channel/combination
 * policy per code; both are spread by ../catalog.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const SECTION_15_VERSIONS: VersionInput[] = [];
export const SECTION_15_OVERRIDES: Record<string, Partial<NoticeTemplate>> = {};
