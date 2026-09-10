/**
 * §11.3 timer overrides (process-owned; the §11 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 11.3 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_11_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  void o; // no 11.3 overrides yet — add `o(code, { … , why })` rows here.
}
