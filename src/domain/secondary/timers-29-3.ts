/**
 * §29.3 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 29.3 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * The events named here are appended by src/domain/secondary/ops-29-3.ts (DeliveryBuildService): `delivery.assembling`
 * is the platform spelling of the state-machine `assembling` trigger, `earlycheck.completed{file_kind, clean}` of
 * `earlycheck_clean`; 26.3/30.2 emit `loan.funded{disbursement_date}`, 23.1 `du.final_submission.recorded`, 25.2
 * `disclosure.cd.corrected`. Every 29.3 event carries `applicationId` and `loanId`, so the rows arm under origination context.
 * Composed gates (FNMA_B3_2_10_DU_FINAL_MATCH_GATE, FNMA_UCD_ACCEPTED_GATE, …) are owned elsewhere and only read into
 * `delivery_packages.gate_results` — never overridden here.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_29_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Internal SLA: the disbursement date anchors (+1 business_days_creditor — Thu Nov 12 → Fri Nov 13, 2026); the build event closes it.
  o("SM_O103_ULDD_BUILD_SLA_1BD", { trigger: "`loan.funded`", anchorField: "disbursement_date", offset: "+1 business_days_creditor", satisfied: "`delivery.uldd.built`",
    why: "§29.3 timer table: deadline (internal) on `loan.funded`, anchor 'disbursement date', '+1 `business_days_creditor`', satisfied by `delivery.uldd.built` (DeliveryBuildService.build); breach 'sev 3 to `secondary` agent owner; sev 2 after 2 BD; aging report'. Worked example B: due Fri Nov 13 end of day, one business_days_creditor after Thu Nov 12." });
  // Internal SLA: +2 business_days_creditor from the disbursement date (Thu Nov 12 → Mon Nov 16); the freeze closes it.
  o("SM_O103_PACKAGE_FREEZE_SLA_2BD", { trigger: "`loan.funded`", anchorField: "disbursement_date", offset: "+2 business_days_creditor", satisfied: "`delivery.package.frozen`",
    why: "§29.3 timer table: deadline (internal) on `loan.funded`, anchor 'disbursement date', '+2 `business_days_creditor`', satisfied by `delivery.package.frozen` (DeliveryBuildService.freeze); breach 'sev 2; blocking reasons listed per gate'. Worked example B: due Mon Nov 16; example C: due Fri Nov 20." });
  // Not-before gate on freezePackage/submitDelivery: a clean run over exactly the built bytes (same file, same hash) — the evaluator compares the run's hash to `deliveries.uldd_sha256`.
  o("FNMA_C1_2_02_EARLYCHECK_CLEAN_GATE", { trigger: "`delivery.uldd.built`", evaluator: "29.3.earlycheckClean", satisfied: "`earlycheck.completed{file_kind=uldd_3_0, clean=true}`",
    why: "§29.3 timer table: not_before_gate on `freezePackage` and `submitDelivery`, trigger `delivery.uldd.built`, '`earlycheck_runs.clean = true` for `file_sha256 = deliveries.uldd_sha256` (same file, same hash)', satisfied by `earlycheck.completed{clean=true}` (the ULDD run — DeliveryBuildService.completeRun); breach 'freeze refused; fatal edits routed to owners'. C1-2-02: 'Loans may only be submitted and purchased in Loan Delivery if they are clear of all fatal edits.'" });
  // Not-before gate on buildUldd: the final DU Spec file's run (23.1's pre-closing run reused when the hash is unchanged — open question 5).
  o("FNMA_C1_2_02_DU_FILE_EARLYCHECK_GATE", { trigger: "`du.final_submission.recorded`", evaluator: "29.3.duFileEarlycheck", satisfied: "`earlycheck.completed{file_kind=du_spec_3_4, clean=true}`",
    why: "§29.3 timer table: not_before_gate on `buildUldd`, trigger `du.final_submission.recorded` (23.1), 'EarlyCheck run on the final DU Spec file (`file_kind = du_spec_3_4`) clean, or re-used run with identical hash', satisfied by `earlycheck.completed{file_kind=du_spec_3_4, clean=true}` (DeliveryBuildService.runDuFileCheck); breach 'build proceeds only after the DU-file run; DU Compare discrepancies go to 23.1'." });
  // R3: the four `assembling` gates arm on the platform's `delivery.assembling` event (the state-machine transition); identifier equalities/format checks a–q.
  o("FNMA_ULDD_IDENTIFIER_CONSISTENCY_GATE", { trigger: "`delivery.assembling`", evaluator: "29.3.identifierConsistency", satisfied: "`delivery.identifiers.reconciled`",
    why: "§29.3 timer table: not_before_gate on `buildUldd`, trigger `assembling` (= `delivery.assembling`, DeliveryBuildService.assemble), 'rules R3 (all identifier equalities/format checks pass)', satisfied by '`identifier_snapshot` complete' = `delivery.identifiers.reconciled{identifier_snapshot}`; breach '`delivery.identifier.mismatch.detected`; owner notified (23.1/24.2/24.3/24.6/25.2/26.x)' — `delivery.correction.requested{owner_process}`." });
  o("FNMA_C1_2_02_SFC_COMPLETENESS_GATE", { trigger: "`delivery.assembling`", evaluator: "29.3.sfcCompleteness", satisfied: "`delivery.sfc.assigned`",
    why: "§29.3 timer table: not_before_gate on `buildUldd`, trigger `assembling`, 'rule R4: every required SFC present, none contradictory, ≤ 10 included', satisfied by `delivery.sfc.assigned{codes}` (assignSfcs); breach 'build refused; compensatory-fee risk logged' — over ten opens an `officer` escalation with the candidate list; no code is dropped (T7)." });
  // LL-2026-06 assertion: ('067' ∈ sfc_codes) = (score_model = vantagescore_4) and one model for every borrower; the build event is the assertion having passed.
  o("FNMA_LL_2026_06_SFC_067_CONSISTENCY_GATE", { trigger: "`delivery.assembling`", evaluator: "29.3.sfc067Consistency", satisfied: "`delivery.uldd.built`",
    why: "§29.3 timer table: gate (assertion) on `assembling`, '`(\\'067\\' ∈ sfc_codes) = (applications.score_model = vantagescore_4)` and all borrowers\\' `score_model` identical' (LL-2026-06: 'For any loan originated using VantageScore 4.0, lenders must deliver Special Feature Code 067'; 'the same credit score model must be used for all borrowers on a single loan'); satisfied 'assertion' = the build that passed it (`delivery.uldd.built`); breach 'build refused; 22.2 notified' (sfc067Gate; `delivery.correction.requested{owner_process=22.2}`)." });
  // B4-1.4-10 assertion: SID 376 = ValueAcceptance ⇔ SFC 801/774 ⇔ method, offer ≤ 4 months old at the note date.
  o("FNMA_B4_1_4_10_VALUE_ACCEPTANCE_SFC_GATE", { trigger: "`delivery.assembling`", evaluator: "29.3.valueAcceptanceSfc", satisfied: "`delivery.uldd.built`",
    why: "§29.3 timer table: gate (assertion) on `assembling`, 'if `valuation_orders.method ∈ {value_acceptance, value_acceptance_pd}` then SID 376 = `ValueAcceptance` and SFC 801 (or 774) present and offer age ≤ 4 months at note date; else SID 376 ≠ `ValueAcceptance` and neither SFC present' (B4-1.4-10: 'not more than four months old on the date of the note and the mortgage'; 'must include SFC 801 at delivery'); satisfied by the build that passed it (`delivery.uldd.built`); breach 'build refused; 24.1 notified' (valueAcceptanceGate)." });
  // Not-before gate on 29.4's openOperatorTask: the clean ULDD run arms it; `delivery_packages.uldd_sha256` = hash of the exact file handed over and every composed gate open at `frozen_at`.
  o("SM_O103_PACKAGE_FREEZE_GATE", { trigger: "`earlycheck.completed{file_kind=uldd_3_0, clean=true}`", evaluator: "29.3.packageFreeze", satisfied: "`delivery.package.frozen`",
    why: "§29.3 timer table: not_before_gate on `openOperatorTask` (29.4), trigger `earlycheck_clean` (= `earlycheck.completed{file_kind=uldd_3_0, clean=true}`), '`delivery_packages` row with `uldd_sha256` = hash of the exact file handed over; all composed gates open at `frozen_at`', satisfied by `delivery.package.frozen{package_id, sha256}` (DeliveryBuildService.freeze); breach 'operator task not opened'." });
  // Event-driven watch: a post-funding corrected CD (25.2) supersedes the frozen package the same day; the registry keeps one trigger pattern, so the CD correction is the armed one (mapped-source writes and 29.4's `delivery.edit.observed{fatal}` go through the same supersede path).
  o("SM_O103_REBUILD_ON_CHANGE", { trigger: "`disclosure.cd.corrected`", offset: "same day", satisfied: "`delivery.package.superseded`",
    why: "§29.3 timer table: recurring watch (event-driven) on 'any mapped-source write, `disclosure.cd.corrected`, `delivery.edit.observed{fatal}`', anchor 'event time', offset 0, satisfied by '`delivery.package.superseded` + new build' (DeliveryBuildService.onCdCorrected / supersede → `delivery.uldd.rebuilt`); breach 'stale package can never be imported (29.4 verifies hash)'. T8: a corrected CD Tue Nov 17 before the operator import fires `delivery.package.superseded{reason=cd_corrected}`; the new package freezes only after `ucd.accepted{is_final}` for CD v3." });
}
