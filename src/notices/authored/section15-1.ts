/**
 * §15.1 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section15.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_15_1: VersionInput[] = [];
export const OVERRIDES_15_1: Record<string, Partial<NoticeTemplate>> = {};
