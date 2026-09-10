/**
 * §14.2 authored notice versions (V(code, source, rules, sample, ruleSet, formBasis) from ./section01.ts;
 * see ./section13.ts) and per-code channel/combination overrides. Spread by ./section14.ts.
 *
 * The 14.2 spec names no NTC_/INS_ notice: its borrower-facing papers are the Official Forms (`CRT_B410S1` 12/25,
 * `CRT_B410S2` 12/16, `CRT_B410C13_M1R` / `_NR` / `_M2R` 12/25) and the certificate of service. The Notice Registry
 * catalog is spec/registry/notices.json (NTC_/INS_ codes only; `NoticeRegistry.draft` refuses a code outside the
 * catalog), so those court forms are rendered and content-checked from `COURT_FORMS` / `renderCourtForm` in
 * src/domain/bankruptcy/ops-14-2.ts (`documents.render`), and the debtor's service copy travels through `notice.send`.
 * The Reg Z rate-change notice and the escrow statement that travel as 410S-1 attachments are 7.2 / 3.3 templates.
 */
import type { NoticeTemplate, VersionInput } from "../registry.ts";

export const VERSIONS_14_2: VersionInput[] = [];
export const OVERRIDES_14_2: Record<string, Partial<NoticeTemplate>> = {};
