/**
 * §19.4 timer satisfaction overrides: for every 19.4 registry row whose "Satisfied by"
 * column is prose, a `reg.override(code, { satisfied | evaluator, trigger?, offset?, anchorField?, why })`
 * (see src/domain/foreclosure/timers.ts applyForeclosureSatisfiedOverrides for the pattern).
 * Called from this section's timers.ts after the section-level overrides.
 *
 * Every event named here is appended by a real code path in ./ops-19-4.ts (the enclave's
 * intake, export, monitoring, bias-test and Colorado AI Act functions).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_19_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Trigger: the spec arms the boarding gate on `loan.boarded{note_date ≥ 2023-03-01}`. The platform's
  // `loan.boarded` (1.1, src/domain/boarding/service.ts) carries no note_date; the 19.4 intake
  // (`flIntake`, spec "Inputs and triggers": tape fields → `fl.record.received`) fires for the same loan at
  // boarding and is the event that carries `note_date`, so the gate arms on it with the spec's own condition.
  // Out-of-scope loans (note_date < 2023-03-01) get no `fl.record.received` at all → the gate is never evaluated (T2).
  o("FNMA_A2101_FL_DATA_QUERYABLE_AT_BOARDING", { trigger: "`fl.record.received{note_date>=2023-03-01}`", why: "§19.4 timer table: `loan.boarded{note_date ≥ 2023-03-01}` → FL row exists (`validated` or `not_obtained` with evidence); the 1.1 `loan.boarded` payload has no note_date, the 19.4 intake event `fl.record.received` (same loan, at boarding) carries it (A2-1-01)." });
  // Satisfied: "`fl.record.validated` or `fl.record.not_obtained` (transferor confirmation)". One pattern cannot
  // name two event types, so the confirmation path (`transferorConfirmation`) appends `fl.record.not_obtained`
  // and then `fl.record.validated{status=not_obtained, evidence_document_id}` — the row is complete with evidence.
  o("SM_BOARD_FL_DATA_FOLLOWUP_30", { satisfied: "`fl.record.validated{status∈{validated, not_obtained}}`", why: "§19.4 timer table: `fl.record.validated` or `fl.record.not_obtained` (transferor confirmation) — the confirmation appends both, the validated row carries status=not_obtained with the evidence document (rule 1; state machine `incomplete` → `not_obtained`)." });
  o("SM_AI_BIAS_TEST_QUARTERLY_90", { satisfied: "`ai.bias_tests.completed{scope=production, cadence=quarterly}`", why: "§19.4 timer table: 'tests completed' — the quarterly production bias tests on every high-consequential system (rule 9)." });
  o("SM_FAIR_SERVICING_REGRESSION_QUARTERLY", { satisfied: "`fair_servicing_run.completed{kind=regression, controls=true}`", why: "§19.4 timer table: 'run with controls completed' (RPT_FAIR_SERVICING_QUARTERLY_REGRESSION)." });
  o("SM_FAIR_SERVICING_BOARD_REPORT_365", { satisfied: "`board.report.delivered{kind=fair_servicing}`", why: "§19.4 timer table: 'report delivered' — RPT_FAIR_SERVICING_ANNUAL_BOARD with the 19.2 board cycle." });
  o("SM_FL_DATA_QUALITY_MONTHLY", { satisfied: "`report.produced{code=RPT_FL_DATA_QUALITY_MONTHLY}`", why: "§19.4 timer table: 'data-quality report' (RPT_FL_DATA_QUALITY_MONTHLY)." });
  // Anchors the registry spells in prose: "change date" → the `change_date` the 19.4 change record carries;
  // "last assessment" → `completed_at` of the satisfying `impact_assessment.completed` (the recurring re-arm anchors on
  // it; the first cycle anchors on the registration event's own date because that payload has no completed_at).
  o("CO_AI_ACT_IMPACT_ASSESSMENT_MOD_90D", { anchorField: "change_date", why: "§19.4 timer table: anchor 'change date' → `ai_system.changed.change_date`; +90 calendar days (Colorado SB 24-205; rule 11)." });
  o("CO_AI_ACT_IMPACT_ASSESSMENT_365", { anchorField: "completed_at", why: "§19.4 timer table: anchor 'last assessment' → `impact_assessment.completed.completed_at` on each re-arm; registration date for the first cycle (Colorado SB 24-205; rule 11)." });
}
