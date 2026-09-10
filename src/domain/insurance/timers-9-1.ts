/**
 * §9.1 timer overrides (process-owned; the §9 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 9.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_9_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_B202_INSUFFICIENCY_NOTICE_5BD", { satisfied: "`notice.sent{template∈{INS_DEFICIENCY_NOTICE, INS_DEFICIENCY_NOTICE_BK}}`",
    why: "§9.1 timer table: satisfied by '`notice.sent` `INS_DEFICIENCY_NOTICE`' — the registry grammar keeps only the first backticked token, which would let any notice on the loan close the B-2-02 'must notify' SLA; the Notice Registry's `notice.sent` carries the template as `template`, and the §9.1 edge case sends the counsel-approved `INS_DEFICIENCY_NOTICE_BK` variant under a bankruptcy overlay." });
  o("FNMA_B201_ANNUAL_INSURANCE_REMINDER_365", { satisfied: "`notice.sent{template=INS_ANNUAL_REMINDER}`", anchorField: "sent_at",
    why: "§9.1 timer table: satisfied by '`notice.sent` `INS_ANNUAL_REMINDER`', anchored on 'last reminder sent_at' — the Notice Registry's `notice.sent` carries `template` and `sent_at`; the recurring row re-arms from the reminder just sent (rule 7: one per loan per 12 months), and the `loan.boarded` trigger has no sent_at so the first cycle anchors on boarding." });
  o("FNMA_B601_LPI_DOC_REQUEST_30", { trigger: "`fnma.request.received{kind=lpi_documentation}`", satisfied: "`fnma.request.responded{kind=lpi_documentation}`",
    why: "§9.1 timer table: trigger '`fnma.request.received` (LPI documentation)' — the parenthetical is the kind the column grammar drops; 'satisfied by `fnma.response.sent`' is the platform's `fnma.request.responded{kind}` on the Fannie Mae request aggregate (the same event the §9 B-3-01 row and 19.3 use), so the LPI documentation response closes only its own request (B-6-01: 30 days to produce the LPI documentation)." });
  o("FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD", { trigger: "`fnma.request.received{kind=flood_evidence}`",
    why: "§9.1 timer table: trigger '`fnma.request.received` (flood evidence)' — the parenthetical is the request kind the column grammar drops; an LPI documentation request must not arm the 10-Fannie-business-day flood clock (B-3-01)." });
}
