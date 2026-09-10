/**
 * §13.7 timer overrides (process-owned; the §13 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 13.7 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_13_7(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  void o; // no 13.7 overrides yet — add `o(code, { … , why })` rows here.
}
