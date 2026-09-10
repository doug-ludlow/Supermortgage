/**
 * §13.6 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides; the section's original templates stay in ./section13.ts. Spread by
 * ../catalog.ts after the section files, so a version here supersedes one there for the same code and effective date.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_13_6: VersionInput[] = [];
export const OVERRIDES_13_6: Record<string, Partial<NoticeTemplate>> = {};
