/**
 * §23.2 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 23.2 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * Every 23.2 event carries `applicationId` (ops-23-2.ts emit), so the rows arm only under origination context
 * (src/kernel/timers/engine.ts isOriginationContext). `FNMA_B3_2_02_DU_CLOSE_BY_GATE` (22.3 owns) and
 * `REGB_1002_9_DECISION_30` (21.6 owns) are referenced by 23.2's table and are not overridden here.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_23_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("SM_DU_CONDITIONS_SLA_4H", { trigger: "`du.findings.received`", satisfied: "`du.findings.interpreted{conditions_materialized=true}`",
    why: "§23.2 timer table: deadline (internal) on `du.findings.received` (23.1's receiveFindings), anchor 'event time', '+4 hours (clock; within the same `business_days_creditor` day)'; satisfied by '`du.findings.interpreted` with all `open_condition` messages materialized' — ops-23-2.ts interpretFindings appends `du.findings.interpreted{conditions_materialized=true}` only after every open_condition / unmapped message has its condition row and `condition.opened` event; breach: sev 3 to `underwriter` agent owner; after 1 BD, `underwriting_reviewer`." });
  o("FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE", { trigger: "`homeownership_education.required`", evaluator: "23.2.homeownershipEducationGate", satisfied: "`homeownership_education.verified`",
    why: "§23.2 timer table: gate (blocks `clear_to_close` in 23.3 and `consummate` in 25.3/26.2) on `homeownership_education.required` (ops-23-2.ts requireEducation, emitted when the B2-2-06 basis is homeready_all_ftb / ltv_over_95_all_ftb / du_no_tradelines), offset 'must be `verified` \"prior to loan closing\"' (condition-shaped → evaluator 23.2.homeownershipEducationGate over the education records, the closing date and the as-of date); satisfied by '`homeownership_education.verified` for at least one borrower' (verifyEducationCertificate); breach: block CTC; borrower needs-list item; escalate to `underwriting_reviewer` if closing < 3 `business_days_creditor` away." });
  o("FNMA_B5_6_01_COUNSELING_CREDIT_12M", { trigger: "`homeownership_education.certificate.received{course_type=counseling}`", anchorField: "completed_on", evaluator: "23.2.counselingCredit12m", satisfied: "`homeownership_education.verified{counseling_within_12m=true}`",
    why: "§23.2 timer table: window (pricing only) on 'certificate received' — ops-23-2.ts receiveEducationCertificate appends `homeownership_education.certificate.received{course_type, completed_on}` (22.1's education_certificate intake); anchor `completed_on`; offset 'must be ≤ 12 `calendar_months` before closing date' (evaluator 23.2.counselingCredit12m: completed_on ≥ closing − 12 months); satisfied by 'SFC 184 + DU Housing Counseling data present' — verifyEducationCertificate appends `homeownership_education.verified{counseling_within_12m=true, sfc_184=true}` exactly when the HUD-agency counseling falls inside the window (T5); breach: credit not applied; `pricing` agent re-quotes without the credit." });
}
