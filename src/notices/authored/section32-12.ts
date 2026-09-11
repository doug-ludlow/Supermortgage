/**
 * §32.12 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_32_12: VersionInput[] = [];
export const OVERRIDES_32_12: Record<string, Partial<NoticeTemplate>> = {};
