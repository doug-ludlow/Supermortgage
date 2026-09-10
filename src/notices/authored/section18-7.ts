/**
 * §18.7 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section18.ts.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

// spec/registry/notices.json owns no notice code for 18.7 ("No borrower notices"): the quarterly
// Eligibility Certification (ELIG-CERT-Q-v1) and the partner UPB report (ELIG-UPB-PARTNER-M-v1) are
// internal / partner artifacts, not authored borrower-facing templates.
export const VERSIONS_18_7: VersionInput[] = [];
export const OVERRIDES_18_7: Record<string, Partial<NoticeTemplate>> = {};
