/**
 * §10.1 timer overrides (process-owned; the §10 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 10.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Trigger vocabulary (src/domain/pmi/ops-10-1.ts `openCancellationRequest`): `mi.cancel.requested{case_id, received_at,
 * channel, basis, state, owner_occupied, hpa_covered, hpa_path, …}` — `received_at` is the anchor of the four request
 * clocks; `state`/`owner_occupied` narrow MN_47_207_RESPONSE_30 (section override).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_10_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // B-8.1-04: the 30-day rule after a borrower-paid valuation governs the *denial* "if applicable"; a granted case closes
  // the clock with the cancellation notice exactly as the sibling HPA_4904B_DENIAL_NOTICE_30 row does ("`mi.case.decided`
  // + `notice.sent` (`NTC_HPA_4904B_DENIAL` or `NTC_HPA_4904A_CANCELLED`)"), so a grant never breaches it (10.1-T5).
  o("FNMA_B8104_DENIAL_NOTICE_30", { satisfied: "`notice.sent{template∈{NTC_HPA_4904B_DENIAL, NTC_HPA_4904A_CANCELLED}}`", why: "§10.1 timer table: '`notice.sent` (`NTC_HPA_4904B_DENIAL`)' within 30 days of the valuation for a denial; B-8.1-04 'notify the borrower and provide the grounds for denial … within 30 days of receiving the valuation if applicable' — on a grant the decision is communicated by `NTC_HPA_4904A_CANCELLED` (10.1-T5 'when BPO $412,000 delivered, then `value_not_declined=true` and grant'), which closes the clock as it does HPA_4904B_DENIAL_NOTICE_30." });
}
