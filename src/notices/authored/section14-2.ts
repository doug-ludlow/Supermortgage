/**
 * §14.2 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section14.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_14_2: VersionInput[] = [];
export const OVERRIDES_14_2: Record<string, Partial<NoticeTemplate>> = {};
