/**
 * §21.1 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 21.1 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * Emitters live in src/domain/application/ops-21-1.ts (the `intake` agent's rules): `escalation.opened{role=mlo_of_record,
 * stage=application}` (openMloReview), `application.mlo.approved` / `.returned` (decideMloReview), `application.received`
 * (receiveApplication), `application.borrower.added{joint_intent_required}` (addBorrower), `application.trid_received`
 * (detectSixItems), `application.scif.presented{all_borrowers}` (presentScif), `application.demographics.collected
 * {all_borrowers}` (askDemographics), `application.joint_intent.affirmed{all_borrowers}` (affirmJointIntent).
 * Referenced, never redefined: `REGZ_1026_19E1_LE_3BD` (21.2/20.3 — arms on `application.trid_received` with the
 * `trid_application_date` anchor 21.1 puts on the payload), `REGB_1002_9_DECISION_30` (21.6), `FNMA_B1_1_03_CREDIT_DOCS_4M` (22.1).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_21_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Rule 7 / T8: the SLA anchors on the escalation's own opened_at and is satisfied by either MLO decision event (the column's "`application.mlo.approved` or `.returned`" — both are `application.mlo.<decision>`; assignment/reassignment/status events are `application.mlo_of_record.*` and never satisfy it).
  o("SM_O21_MLO_REVIEW_SLA_1BD", { anchorField: "opened_at", satisfied: "`application.mlo.*`",
    why: "§21.1 timer table: trigger '`escalation.opened{role=mlo_of_record, stage=application}`', anchor 'escalation opened_at', '+1 `business_days_creditor`', satisfied by '`application.mlo.approved` or `.returned`', breach 'sev 2 → reassign to the next licensed MLO for the state; sev 1 to partner `officer` at +2' — openMloReview emits the trigger with `opened_at`; decideMloReview emits `application.mlo.approved{stage}` / `application.mlo.returned{stage}` (T8: opened Fri Oct 9 16:00 → due Tue Oct 13 end of creditor day, Mon Oct 12 Columbus Day closed)." });
  // Rule 7/8 / T7, T12: condition-shaped gate over the MLO-of-record facts; the stage-application approval is the event that opens it; the nightly NMLS feed re-evaluates it (loadNmlsFeed) and closes it on `inactive`.
  o("SAFE_1008_103_MLO_OF_RECORD_GATE", { evaluator: "21.1.mloOfRecordGate", satisfied: "`application.mlo.approved{stage=application}`",
    why: "§21.1 timer table: not_before_gate on `application.received`, 'open when `mlo_of_record_id` set, NMLS status active for the property state, and `mlo_review_state='approved'` for stage `application`'; breach 'blocks `issueLE` (21.2) and `executeLock` (21.4); in `assisted` mode also blocks any `particular_terms_presented` utterance' — evaluators-21-1.ts mloOfRecordGate over gateFacts(app); T12: 'the MLO of record's NMLS status changes to inactive … the gate closes, the LE issuance in 21.2 is blocked until reassignment'." });
  // Rule 6 / T6: SCIF presented (answers may be blank) to every borrower before DU.
  o("SM_O21_SCIF_PRESENT_GATE", { evaluator: "21.1.scifPresentGate", satisfied: "`application.scif.presented{all_borrowers=true}`",
    why: "§21.1 timer table: not_before_gate on `application.received`, 'open when `scif_forms.presented_at` exists for every borrower', breach 'blocks `du.submit` (23.1) — SCIF data are delivered through DU'; LL-2022-03 / B2-2-06 'Lenders are required to present the Supplemental Consumer Information Form (Form 1103) to the borrower' — presentScif emits `application.scif.presented{all_borrowers}` once the last borrower has `presented_at` (T6: 'even with all answers blank')." });
  // Rule 3 / state machine: an `applicant_demographics` row (answered or declined) for every borrower before `intake_complete`.
  o("SM_O21_DEMOGRAPHICS_ASKED_GATE", { evaluator: "21.1.demographicsAskedGate", satisfied: "`application.demographics.collected{all_borrowers=true}`",
    why: "§21.1 timer table: not_before_gate on `application.received`, 'open when every borrower has an `applicant_demographics` row (answered or declined)', breach 'blocks `intake_complete`; sev 2 to `compliance-sentinel` if a decision is attempted without it'; Reg C App. B instruction 1 'You must ask the applicant for this information (but you cannot require the applicant to provide it)' — askDemographics emits `application.demographics.collected{all_borrowers}`." });
  // Rule 4 / T5: arms when a co-borrower (joint credit) is added — a non-borrowing spouse (§1002.7(d)(4)) never arms it; open when every borrower affirmed by a method distinct from the accuracy attestation.
  o("SM_O21_JOINT_INTENT_GATE", { trigger: "`application.borrower.added{joint_intent_required=true}`", evaluator: "21.1.jointIntentGate", satisfied: "`application.joint_intent.affirmed{all_borrowers=true}`",
    why: "§21.1 timer table: not_before_gate on '`application.borrower.added` (second borrower)', 'open when every borrower has `joint_intent_affirmed_at` ≤ `trid_received_at`', breach 'blocks credit pull for the co-borrower (22.2) and DU submission'; comment 7(d)(1)-3 'A person's intent to be a joint applicant must be evidenced at the time of application … The method used to establish intent must be distinct from the means used by individuals to affirm the accuracy of information' — addBorrower emits `joint_intent_required=true` for a credit-requesting second borrower; affirmJointIntent emits `application.joint_intent.affirmed{all_borrowers}`." });
  // Rule 1 / T9: the abandon clock anchors on the last borrower activity (every capture re-anchors it; ops touched()); `application.trid_received` stops it.
  o("SM_O21_INTAKE_ABANDON_30", { anchorField: "last_activity_at", offset: "+30 calendar_days",
    why: "§21.1 timer table: deadline on `application.started`, anchor 'last borrower activity', '+30 `calendar_days` (reset on activity; stops at `trid_received`)', satisfied by `application.trid_received`, breach '`application.abandoned`; data purged per `regb_25m` only if never `received`, else retained' — the runtime's `application.started` (src/runtime/app.ts createApplication) arms it; abandonSweep emits `application.abandoned{purge, retain_until}` (T9: last activity Mon Oct 5 → abandons Wed Nov 4, 2026)." });
}
