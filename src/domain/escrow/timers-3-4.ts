/**
 * §3.4 timer overrides (process-owned; the §3 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 3.4 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_3_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // The two not-before gates: the registry's satisfied column is a bare field condition (`cap_check_passed=true`) that
  // the event grammar cannot parse. The field lives on the cushion module's `escrow.cushion.validated` loan_event
  // (§3.4 Outputs and artifacts: "`loan_events`: `escrow.cushion.validated`, `escrow.cushion.cap_failed` (with reason)";
  // Data model: `cap_check_passed bool`, `preaccrual_check_passed bool`), appended by src/domain/escrow/ops-3-4.ts from
  // runEscrowAnalysis. The gate stays evaluator-backed for approveAnalysis (§3.4 breach: "`approveAnalysis` refused").
  o("REGX_1024_17C5_CUSHION_CAP_GATE", { satisfied: "`escrow.cushion.validated{cap_check_passed=true}`", evaluator: "3.4.cushionCap",
    why: "§3.4 timer table: `escrow.analysis.computing` → satisfied by `cap_check_passed=true` — the data-model field carried by the module's `escrow.cushion.validated` event (rules 2–3: cushion ≤ floor(annual/6) and min target ≤ cap)." });
  o("REGX_1024_17C6_PREACCRUAL_GATE", { satisfied: "`escrow.cushion.validated{preaccrual_check_passed=true}`", evaluator: "3.4.preaccrual",
    why: "§3.4 timer table: `escrow.analysis.computing` → satisfied by `preaccrual_check_passed=true` — the data-model field carried by the module's `escrow.cushion.validated` event (rule 5: every projected disbursement ≥ availability and ≤ penalty date)." });
  // ESC_INHERITED_CUSHION_CHECK_10BD: the row's trigger is `loan.boarded` (first alternative; nothing emits
  // `transfer.in.completed`), anchored on the payload's `boarded_at`. §1024.17(c)(8) makes the check one "for each
  // escrow account", so a non-escrowed boarding (`escrowed=false` on the 1.1 loan.boarded payload) has no cushion to
  // validate and must not arm a check that would only breach.
  o("ESC_INHERITED_CUSHION_CHECK_10BD", { trigger: "`loan.boarded{escrowed=true}`", anchorField: "boarded_at",
    why: "§3.4 Inputs: \"`loan.boarded` / `transfer.in.completed` — validation of the inherited cushion and the settlement deposit\"; §1024.17(c)(8): \"the applicable cushion for each escrow account\" — only escrowed boardings carry a cushion to check." });
}
