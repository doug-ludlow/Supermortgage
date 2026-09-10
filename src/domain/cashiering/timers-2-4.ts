/**
 * §2.4 timer overrides (process-owned; the §2 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 2.4 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_2_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // "`payment.received{designation=curtailment}` on a current loan": the loan is current once the scheduled payment submitted with the
  // curtailment has been applied — F-1-09 "apply the scheduled monthly payment first, then apply the principal curtailment"; worked
  // example F (319,257¢ on 2026-09-03 with the 2026-09-01 installment unpaid at receipt) is the spec's own "fixture L-1 current" case.
  // `current_after_funds` (service.ts receipt facts) is true when the funds cover every installment due on/before receipt, false when
  // rule 3 redirects them to cure (example G) — then FNMA_C1201_DELINQUENT_CURE_FIRST_GATE governs instead and this clock must not arm.
  o("FNMA_C1201_CURTAILMENT_APPLY_IMMEDIATE_0BD", { trigger: "`payment.received{designation=curtailment, current_after_funds=true}`", anchorField: "received_on", offset: "same day", satisfied: "`payment.curtailment.applied`",
    why: "§2.4 timer table: `payment.received{designation=curtailment}` on a current loan → same `business_days_servicer` day (0), anchored on `received_on`, satisfied by `payment.curtailment.applied` (C-1.2-01 'immediately accept and apply'; F-1-09 ordering makes example F a current-loan curtailment)." });
}
