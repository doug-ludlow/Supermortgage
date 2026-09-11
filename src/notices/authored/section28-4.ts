/**
 * §28.4 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 * 28.4 owns no notice code (spec "Outputs and artifacts": "Notices: none to borrowers about SARs (prohibited);
 * adverse-action notices through 21.6 (NTC_REGB_1002_9_ADVERSE_ACTION — taxonomy reasons only, scanned by
 * ops-28-4.ts denialReasonsForCase); victim record packages under §609(e); Fannie Mae reports through LQC/the fraud
 * form" — the last two are document packages, not borrower notices), so both maps stay empty on purpose.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_28_4: VersionInput[] = [];
export const OVERRIDES_28_4: Record<string, Partial<NoticeTemplate>> = {};
