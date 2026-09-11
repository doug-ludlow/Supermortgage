/**
 * §25.1 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 25.1 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * The six compliance gates are condition-shaped ("gate_open(checkpoint) = ∀ t ∈ tests(checkpoint): …"): each is backed
 * by evaluators-25-1.ts `25.1.gateOpen` over the run's test rows and closed by `compliance.gate.opened{gate=<name>}`,
 * which ops-25-1.ts evaluateComplianceGate appends. Every 25.1 event carries `applicationId`, so the rows arm only under
 * origination context (src/kernel/timers/engine.ts isOriginationContext). `REGZ_1026_19E1_LE_3BD` is 21.2's LE clock —
 * referenced ("keeps running" while the LE gate is blocked), never redefined here.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_25_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("SM_O61_COMPLIANCE_PASS_LE_GATE", { evaluator: "25.1.gateOpen", satisfied: "`compliance.gate.opened{gate=le}`",
    why: "§25.1 timer table: not_before_gate on `application.trid_received`, anchor 'gate evaluation', offset '0 (event)' — a gate, not a same-day deadline: open iff every blocking LE-checkpoint test (licensing, NMLSR IDs, E-SIGN consent, LO comp, AfBA, state high-cost) passed, is non-blocking or carries an officer waiver on a policy test (rule 'Gate composition'); satisfied by `compliance.gate.opened{gate=le}` (ops-25-1.ts evaluateComplianceGate); breach: `issueLE` refused, `escalation` to `officer` via SM_O61_BLOCKING_FAILURE_REVIEW_1BD while 21.2's `REGZ_1026_19E1_LE_3BD` keeps running." });
  o("SM_O61_COMPLIANCE_PASS_LOCK_GATE", { trigger: "`compliance.testrun.started{checkpoint=lock}`", evaluator: "25.1.gateOpen", satisfied: "`compliance.gate.opened{gate=lock}`",
    why: "§25.1 timer table: trigger 'lock request' (prose — the `lock` command calls assertGateOpen, whose run start `compliance.testrun.started{checkpoint=lock}` is the platform event for the request), anchor 'gate evaluation'; satisfied by '`compliance.gate.opened{gate=lock}` (steering options record, LO comp plan, pricing-exception review)'; breach: `lock` refused; `mlo_of_record` notified." });
  o("SM_O61_COMPLIANCE_PASS_CD_GATE", { trigger: "`compliance.testrun.started{checkpoint∈{cd, corrected_cd}}`", evaluator: "25.1.gateOpen", satisfied: "`compliance.gate.opened{gate=cd}`",
    why: "§25.1 timer table: trigger '`issueCD` / `issueCorrectedCD`' (commands, not events — each calls assertGateOpen, whose `compliance.testrun.started{checkpoint=cd|corrected_cd}` marks the evaluation), anchor 'gate evaluation'; satisfied by `compliance.gate.opened{gate=cd}`; breach: `issueCD` refused; sev 1 escalation to `officer`." });
  o("SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE", { evaluator: "25.1.gateOpen", satisfied: "`compliance.gate.opened{gate=consummation}`",
    why: "§25.1 timer table: not_before_gate on '`closing.scheduled` and again at signing start' (26.2 emits `closing.scheduled`; the signing-start re-run is the same checkpoint), anchor 'gate evaluation'; satisfied by `compliance.gate.opened{gate=consummation}`; breach: `consummate` refused; closing rescheduled per 25.2 if the APR is inaccurate (T4: cure plan 'corrected CD + new 3-business-day waiting period (25.2)')." });
  o("SM_O61_COMPLIANCE_PASS_DISBURSE_GATE", { evaluator: "25.1.gateOpen", satisfied: "`compliance.gate.opened{gate=disbursement}`",
    why: "§25.1 timer table: not_before_gate on the '`funding.authorized` request' (26.3), anchor 'gate evaluation'; satisfied by `compliance.gate.opened{gate=disbursement}`; breach: `disburse` refused (independent of `REGZ_1026_23_RESCISSION_3SBD_GATE`, 25.3)." });
  o("SM_O61_COMPLIANCE_PASS_DELIVERY_GATE", { evaluator: "25.1.gateOpen", satisfied: "`compliance.gate.opened{gate=delivery}`",
    why: "§25.1 timer table: not_before_gate on `delivery.uldd.built` (29.3), anchor 'gate evaluation'; satisfied by `compliance.gate.opened{gate=delivery}` (HOEPA=false, points and fees within the Fannie Mae cap, compliance certificate); breach: `submitDelivery` refused; sev 1 to `officer`." });
  o("SM_O61_BLOCKING_FAILURE_REVIEW_1BD", { satisfied: "`compliance.gate.opened`",
    why: "§25.1 timer table: deadline on `compliance.gate.blocked`, anchor 'event time', +1 `business_days_creditor` (T7: blocked Mon Oct 5, 2026 → due Tue Oct 6); satisfied by '`escalation` resolved (cure recorded or file withdrawn)' — the cure is recorded when the blocked gate re-derives to open on the next run (`compliance.gate.opened`, ops-25-1.ts evaluateComplianceGate after the cure or an officer waiver on a policy test); breach: sev 2 → `officer`; repeat daily." });
  o("SM_O61_LICENSE_CHECK_REFRESH_30", { satisfied: "`compliance.license.check_completed`",
    why: "§25.1 timer table: recurring on `compliance.license.check_completed`, anchor `checked_at`, +30 `calendar_days`; satisfied by 'new `license_checks` row' — every new row is recorded by ops-25-1.ts recordLicenseCheck, which appends `compliance.license.check_completed{checked_at}` (the recurring row re-arms from it); breach: a stale check counts as `not_found` → LE/CD gates block (effectiveLicense)." });
  o("SM_O61_APOR_REFRESH_7", { trigger: "`apor.table.ingested`", anchorField: "table_date", satisfied: "`apor.table.ingested`",
    why: "§25.1 timer table: recurring on 'APOR ingestion', anchor 'last table date', +7 `calendar_days`; satisfied by 'new APOR table' — the weekly FFIEC pull is 23.4's `apor.table.ingested{table_date}` (`FFIEC_APOR_TABLE_REFRESH_WEEKLY` names the same event; ops-25-1.ts ingestAporTable appends it with `source=origination`); breach: QM/HPML tests return `error` (block; not waivable — T13) until refreshed." });
  o("SM_O61_RULESET_ANNUAL_0101", { trigger: "`schedule.tick{cadence=annual, job=ruleset_annual_thresholds}`", anchorField: "date", satisfied: "`rule_set.version.loaded{bundle∈{regz.qm.general.2021, regz.hoepa, regz.hpml}}`",
    why: "§25.1 timer table: recurring on 'Jan 1', anchor 'calendar', offset 'annual'; satisfied by 'new QM/HOEPA/HPML threshold versions loaded before Jan 1' — the scheduler's annual tick (ops-25-1.ts annualRuleSetTick, `source=origination`) starts the year's clock and loadRuleSetVersion appends `rule_set.version.loaded{bundle, version}` for each threshold bundle (the 2026 tiers $137,958/$82,775, $4,139/$1,380, HOEPA $27,592/$1,380, HPML $34,200 are rule-set parameters versioned by year, never code constants); breach: sev 1 → `officer`." });
}
