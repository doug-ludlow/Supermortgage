/**
 * §31.2 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 31.2 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_31_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  void o; // no 31.2 overrides yet — add `o(code, { … , why })` rows here.
}
