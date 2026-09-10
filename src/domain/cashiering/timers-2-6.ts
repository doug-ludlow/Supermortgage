/**
 * §2.6 timer overrides (process-owned; the §2 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 2.6 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_2_6(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // The section override (./timers.ts) already names the trigger and the evaluator; this row pins the trigger to a computation
  // that reports the evaluator's fact, so the gate never arms from a capitalization event that is silent on late charges.
  // Emitted by src/domain/cashiering/ops-2-6.ts computeCapitalization (12.8's F-1-27 step 1 on cashiering's figures).
  o("FNMA_F127_LC_NOT_CAPITALIZED_GATE", { trigger: "`lossmit.modification.capitalization_computed{late_charges_in_capitalization_cents present}`", evaluator: "2.6.lateChargesExcludedFromCapitalization",
    why: "§2.6 timer table: trigger 'modification capitalization computation', offset 'capitalized amount excludes `late_charges`', satisfied '12.8 computation', breach 'refused'; F-1-27 (08/13/2025): 'Late charges may not be capitalized and must be waived if the borrower satisfies all conditions of the Trial Period Plan'." });
}
