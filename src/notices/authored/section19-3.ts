/**
 * §19.3 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section19.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_19_3: VersionInput[] = [];
export const OVERRIDES_19_3: Record<string, Partial<NoticeTemplate>> = {};
