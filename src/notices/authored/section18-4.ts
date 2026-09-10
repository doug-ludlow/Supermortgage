/**
 * §18.4 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section18.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_18_4: VersionInput[] = [];
export const OVERRIDES_18_4: Record<string, Partial<NoticeTemplate>> = {};
