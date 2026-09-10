/**
 * §12.7 timer overrides (process-owned; the §12 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 12.7 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_12_7(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_LL202601_DISASTER_FC_PRIOR_APPROVAL_5", {
    trigger: "`prereferral.review.completed{outcome=hold_disaster_approval}`",
    satisfied: "`fnma.approval.received{kind=disaster_foreclosure}`",
    why: "§12.7 timer table: trigger `foreclosure.prereferral_review.completed{disaster=true}` (13.4), anchor 'review completion', 5 `calendar_days` to submit to hazard_loss@fanniemae.com, satisfied by `fnma.approval.received` (LL-2026-01: \"Fannie Mae's prior written approval is required before referring a disaster-impacted loan to foreclosure — submission … within 5 days of completing the pre-referral review\"). The 13.4 `complete_review` handler spells completion `prereferral.review.completed{review_id, outcome, items}` and a disaster-impacted loan's outcome is `hold_disaster_approval` (foreclosure/referral.ts `reviewOutcome`); the event date is the review completion. The approval is the hazard_loss@ reply ops-12-7.ts `ingestFnmaDisasterForeclosureApproval` records as `fnma.approval.received{kind=disaster_foreclosure, approval_id}` — the `kind` condition keeps other Fannie Mae approvals (12.5 extension, 12.9 liquidation) from satisfying this clock.",
  });
}
