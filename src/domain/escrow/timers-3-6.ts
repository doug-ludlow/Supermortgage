/**
 * §3.6 timer overrides (process-owned; the §3 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 3.6 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The emitters live in src/app/tools/section3-6.ts + src/domain/escrow/ops-3-6.ts
 * (`escrow.lump_sum.received`), ./ops-3-4.ts (`escrow.analysis.computing{reason}`), src/app/tools/section3-7.ts
 * (`escrow.advance.posted{cause}`) and src/app/tools/section03.ts (`escrow.analysis.completed{analysis_type}` /
 * `escrow.analysis.approved`).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_3_6(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Row: `escrow.lump_sum.received` | anchor "received date" | 10 business_days_servicer | satisfied by `escrow.analysis.completed` (interim). postEscrowLumpSum's event carries `received_on` (the posting date the receipt is effective, not the command's clock) and the engine's completed fact carries `analysis_type`.
  o("ESC_LUMPSUM_REANALYSIS_10BD", { anchorField: "received_on", satisfied: "`escrow.analysis.completed{analysis_type=interim}`",
    why: "§3.6 timer table: `escrow.lump_sum.received` → received date + 10 business_days_servicer; satisfied by `escrow.analysis.completed` (interim) — rule 4: 'run an interim analysis within 10 BD'." });
  // Row (3.6 copy of the 3.2 code): `escrow.advance.posted` → 'interim analysis completed'; satisfied by `escrow.analysis.completed`. The section override keeps the 3.2 trigger qualifier (cause!=default) and the evaluator; the closing fact is the interim analysis the gate waits for.
  o("REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE", { satisfied: "`escrow.analysis.completed{analysis_type=interim}`",
    why: "§3.6 timer table: `escrow.advance.posted` → interim analysis completed; satisfied by `escrow.analysis.completed` (§1024.17(f)(1)(ii)); breach: `demandDeficiencyRepayment` (createRepaymentPlan kind=deficiency) refused." });
  // Rows: `escrow.analysis.computing` (FNMA: reason=workout) → not-before gates 'satisfied by analysis approval; breach: approval refused'. approveAnalysis asserts the evaluators on the engine's decision (assertAnalysisApprovalGates36) before appending `escrow.analysis.approved`, which closes the armed instances; createRepaymentPlan re-asserts them on the plan it activates.
  o("REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE", { satisfied: "`escrow.analysis.approved`", why: "§3.6 timer table: plan.months ≥ 12 when shortage ≥ one month (or any spread option chosen); satisfied by analysis approval (`escrow.analysis.approved`); breach: approval refused (§1024.17(f)(3))." });
  o("REGX_1024_17F4_DEFICIENCY_MIN_INSTALLMENTS_GATE", { satisfied: "`escrow.analysis.approved`", why: "§3.6 timer table: plan.months ≥ 2; satisfied by analysis approval (`escrow.analysis.approved`); breach: approval refused (§1024.17(f)(4))." });
  o("FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE", { satisfied: "`escrow.analysis.approved`", why: "§3.6 timer table: workout analysis → plan.months = 60 unless borrower election (≥ 12) evidenced; satisfied by analysis approval (`escrow.analysis.approved`); breach: approval refused; sev-2 (B-1-01)." });
}
