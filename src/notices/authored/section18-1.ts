/**
 * §18.1 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section18.ts.
 * 18.1 owns no notice code (spec/registry/notices.json; Outputs: "No borrower notices originate here
 * except corrected notices produced by the owning section after a finding"), so both maps stay empty.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_18_1: VersionInput[] = [];
export const OVERRIDES_18_1: Record<string, Partial<NoticeTemplate>> = {};
