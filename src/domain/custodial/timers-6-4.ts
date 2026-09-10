/**
 * §6.4 timer overrides (process-owned; the §6 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 6.4 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The events are emitted by src/domain/custodial/ops-6-4.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_6_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Trigger column: "`escrow.balance.negative_detected` (net new negative not covered by advances)"; anchor "detection".
  // ops-6-4 detectNegativeEscrow emits the event only for N − A > 0 and carries `unfunded_cents` and `detected_on`.
  o("SM_TI_ESCROW_ADVANCE_FUND_1BD", { trigger: "`escrow.balance.negative_detected{unfunded_cents>0}`", anchorField: "detected_on", why: "§6.4 timer table: `escrow.balance.negative_detected` (net new negative not covered by advances), anchor detection → 1 business_days_servicer to `custodial.advance.funded` (rule 2: corporate must fund N − A within 1 BD; 6.4-T2)." });
  // Satisfied column: "`loss_draft.disbursed` (full)"; anchor "receipt date" — the register's `received_on`, not the ingestion instant.
  o("FNMA_F496A_LOSS_DRAFT_AGED_7M", { satisfied: "`loss_draft.disbursed{full=true}`", anchorField: "received_on", why: "§6.4 timer table: `loss_draft.received` anchored on the receipt date, 7 months, satisfied by `loss_draft.disbursed` (full) — a partial disbursement leaves the `loss_draft_aged_7m` flag armed (6.4-T3; Form 496A Section III: loss drafts aged seven months or greater require loan number, age in months, amount, and explanation for non-disbursement)." });
}
