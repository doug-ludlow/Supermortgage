/**
 * Authored template versions for the §19 records, security, vendors and fair lending notices (see section13.ts for the
 * pattern: V(code, source, rules, sample, ruleSet, formBasis) with block-level
 * checklists). `SECTION_19_OVERRIDES` carries this section's channel/combination
 * policy per code; both are spread by ../catalog.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const SECTION_19_VERSIONS: VersionInput[] = [];
export const SECTION_19_OVERRIDES: Record<string, Partial<NoticeTemplate>> = {};
