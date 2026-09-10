/**
 * §18.4 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section18.ts.
 *
 * spec/registry/notices.json owns no code for 18.4 ("No borrower notices, no ledger postings"), and the
 * notice registry publishes only catalog codes — so this stays empty. The four corporate letters the
 * spec names (F582-PKG-v1 answer sheet + evidence index, F582-PENDING-v1 Pending Actions notice,
 * ORG-CHG-NOTICE-v1 A4-1-03 advance/immediate notice, TECH-PROV-NOTICE-v1 A2-1-01 technology-provider
 * notice) are rendered by renderCorporateLetter in src/domain/qc-audit/ops-18-4.ts, which carries the
 * Guide language each must quote and refuses a changed Form 582 answer without an evidence pointer.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_18_4: VersionInput[] = [];
export const OVERRIDES_18_4: Record<string, Partial<NoticeTemplate>> = {};
