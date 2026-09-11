/**
 * §20.2 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_20_2: VersionInput[] = [];
export const OVERRIDES_20_2: Record<string, Partial<NoticeTemplate>> = {};
