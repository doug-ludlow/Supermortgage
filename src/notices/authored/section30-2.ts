/**
 * §30.2 process-owned notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts) and
 * per-code channel/combination overrides. Spread by ../catalog.ts after the servicing files, so a version here
 * supersedes one there for the same code and effective date.
 *
 * 30.2 owns no notice code (spec/registry/notices.json): `NTC_SM_FIRST_PAYMENT_LETTER` is 25.4's (30.2 sends it and
 * satisfies `SM_O64_FIRST_PAYMENT_LETTER_5BD` with `notice.sent{template=NTC_SM_FIRST_PAYMENT_LETTER}`),
 * `NTC_FCRA_1681S2A7_B1` is 8.1's (carried on the letter, recorded as its own `notices` row) and
 * `NTC_ESIGN_7001C_DISCLOSURE` is 7.4's (enclosed on OW-002). Authoring a second version of another process's code
 * here would collide with the owner's, so this file stays empty by design; the letter's rule-10 content checklist lives
 * in src/domain/orig-boarding/ops-30-2.ts (`firstPaymentLetterChecklist`) and the registry render is used as soon as
 * 25.4's version is published.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_30_2: VersionInput[] = [];
export const OVERRIDES_30_2: Record<string, Partial<NoticeTemplate>> = {};
