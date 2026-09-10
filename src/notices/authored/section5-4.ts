/**
 * §5.4 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides; the section's original templates stay in ./section05.ts. Spread by
 * ../catalog.ts after the section files, so a version here supersedes one there for the same code and effective date.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_5_4: VersionInput[] = [];
export const OVERRIDES_5_4: Record<string, Partial<NoticeTemplate>> = {};
