/**
 * §2.5 timer overrides (process-owned; the §2 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 2.5 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_2_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Registry row: satisfied `payment.applied`. The accumulated halves post as one periodic payment "with credited_as_of = the
  // completing receipt's date" (rule 2): contractual when the installment is already due (`payment.applied`), but prepaid
  // when the completing half lands before the due date — worked example I's alternative cadence (halves 2026-09-14 and
  // 09-28 for 2026-10-01, 2.5-T2) — which the platform spells `payment.prepaid.applied`. The one event both paths emit,
  // carrying the outcome, is the posting; a bare `payment.applied` would leave the prepaid case armed past its 1-BD deadline.
  o("REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD", { satisfied: "`payment.posted{outcome∈{applied, prepaid, applied_with_50_rule}}`",
    why: "§2.5 rule 2: 'on accumulation ≥ P, apply with credited_as_of = the completing receipt's date' — the posting of the accumulated periodic payment, contractual or prepaid (worked example I alternative cadence: halves 09-14/09-28 for 2026-10-01)." });
}
