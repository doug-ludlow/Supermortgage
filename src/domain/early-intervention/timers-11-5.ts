/**
 * §11.5 timer overrides (process-owned; the §11 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 11.5 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_11_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // §11.5 inputs: "`lossmit.brp.complete` (12.1) — starts the evaluation clock"; timer table (12.2 owns): trigger `lossmit.brp.complete`,
  // anchor "complete date", 30 calendar_days, satisfied "evaluation notice sent". The 12.1 completeness determination is spelled
  // `lossmit.application.completed{complete_date}` on the platform (emitted by the 12.1 tool `lossmit.application.open/update`,
  // src/app/tools/section12.ts, when the BRP is verified complete) — the same event FNMA_D2205_INCOME_DOC_90 arms on.
  o("REGX_1024_41C1_EVALUATE_30", { trigger: "`lossmit.application.completed`", anchorField: "complete_date",
    why: "§11.5 timer table (12.2 owns): `lossmit.brp.complete` → evaluation notice within 30 calendar_days of the complete date (§1024.41(c)(1)); the platform spells 12.1's complete-BRP determination `lossmit.application.completed{complete_date}` (section12.ts lossmit.application.open/update)." });
}
