/**
 * §24.3 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 24.3 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * Emitters live in src/domain/property/ops-24-3.ts (the `valuation` agent's rules): `property.eligibility.completed
 * {result, property_class, subject_to}` and `property.repair.required{safety_related, path}` (runPropertyEligibility),
 * `property.repair.completed{safety_related}` / `property.completion.accepted` (acceptRepairCompletion),
 * `project.review.started` (startProjectReview), `project.docs.received{docs_as_of}` (receiveProjectDocs),
 * `project.inspection.reviewed{all_in_window}`, `project.reserve_study.used{study_date}` / `.accepted{in_window}`
 * (runProjectEligibility), `project.review.completed{established|new, reviewed_at, expires_at, docs_fresh}`
 * (completeProjectReview — for CPM projects the operator's recordCpmStatus completes it), `project.cpm.status.recorded`
 * (recordCpmStatus), `holdback.established{note_date}` / `.completed{completed_at}` / `.released` / `.overdue`
 * (establishHoldback / acceptCompletionEvidence / releaseFinalDraw / sweepHoldbacks), `mh.verification.completed{result}`
 * (verifyMh). Consumed, never redefined: `closing.consummated` (26.1) closes the two B4-2.1-01 validity deadlines and
 * the CPM gate. FNMA_B4_1_2_05_HOLDBACK_COMPLETION_180 and SM_HOLDBACK_FINAL_DRAW_5BD need no override — their
 * columns already parse (`holdback.established` +180 calendar_days from `note_date`, satisfied by `holdback.completed`;
 * `holdback.completed` +5 business_days_servicer from `completed_at`, satisfied by `holdback.released`).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_24_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // R4 / T1: established projects — reviewed_at + 1 year must be ≥ the note date; consummation inside the window closes it (26.1's `closing.consummated`).
  o("FNMA_B4_2_1_01_PROJECT_REVIEW_ESTABLISHED_1Y", { satisfied: "`closing.consummated`",
    why: "§24.3 timer table: deadline (gate on `consummate`) on '`project.review.completed{established}`', anchor reviewed_at, '+1 year `calendar_days`; must be ≥ note date', satisfied by 'consummation before expiry', breach 're-review (refresh docs)' — B4-2.1-01 (08/05/2026): established projects 'Must have been completed within one year prior to the note date' (T1: CPM certification Fri Oct 9, 2026 → expires_at 2027-10-09; note date Fri Nov 6, 2026 inside)." });
  // R4: new projects — reviewed_at + 180 calendar days.
  o("FNMA_B4_2_1_01_PROJECT_REVIEW_NEW_180", { satisfied: "`closing.consummated`",
    why: "§24.3 timer table: deadline (gate on `consummate`) on '`project.review.completed{new}`', anchor reviewed_at, '+180 `calendar_days`; must be ≥ note date', satisfied by 'consummation before expiry', breach 're-review' — B4-2.1-01: new projects 'Must have been completed within 180 days prior to the note date'." });
  // R4 / T12: condition-shaped gate over the operator's CPM record; Unavailable closes it regardless of the lender's analysis.
  o("FNMA_B4_2_1_01_CPM_CERT_VALID_GATE", { evaluator: "24.3.cpmCertValidGate", satisfied: "`closing.consummated`",
    why: "§24.3 timer table: not_before_gate on `consummate`, trigger '`project.cpm.status.recorded`', anchor 'note date', 'CPM certification unexpired at note date; status ≠ Unavailable', satisfied by 'CPM record', breach 'block; operator re-certification' — B4-2.1-01: CPM-approved projects 'Must be valid (unexpired) as of the note date'; B4-2.1-03: projects 'with a status of Unavailable in Condo Project Manager (CPM)…are ineligible for purchase' (evaluators-24-3.ts cpmCertValidGate; T12)." });
  // Open question 1 (policy): questionnaire / budget ≤ 120 calendar days old at the review date; a completed review with fresh documents closes it.
  o("SM_PROJECT_DOCS_AGE_120", { trigger: "`project.docs.received`", anchorField: "docs_as_of", evaluator: "24.3.projectDocsAgeGate", satisfied: "`project.review.completed{docs_fresh=true}`",
    why: "§24.3 timer table: policy gate on `project.review.completed`, trigger 'document intake', anchor docs_as_of, 'questionnaire/budget ≤ 120 `calendar_days` old at review (policy; Fannie Mae states 4 months for PERS only)', satisfied by 'fresh documents', breach 'request refresh' — receiveProjectDocs emits `project.docs.received{docs_as_of}` (the oldest document date); completeProjectReview emits `docs_fresh` from the docs_age test (R4: questionnaire Sept 22, 2026 / budget FY2026 ≤ 120 days at Oct 9, 2026)." });
  // B4-2.1-03 / guardrail: every structural/mechanical inspection completed within three years of the review date must be reviewed before the review can complete.
  o("FNMA_B4_2_1_03_INSPECTION_LOOKBACK_3Y", { evaluator: "24.3.inspectionLookbackGate", satisfied: "`project.inspection.reviewed{all_in_window=true}`",
    why: "§24.3 timer table: window on '`project.review.started`', anchor reviewed_at, '−3 years `calendar_days`', satisfied by 'every inspection in window reviewed', breach 'review cannot complete' — B4-2.1-03 (08/05/2026): 'If a structural and/or mechanical inspection was completed within 3 years of the lender's project review date, the lender must obtain and review the inspection report'; guardrail 'never mark a project eligible with an unreviewed in-window inspection report' — runProjectEligibility emits `project.inspection.reviewed{all_in_window}` (R4: engineer's report Mon May 4, 2026 inside the window from Oct 9, 2023)." });
  // B4-2.2-01: the reserve-study exception needs a study ≤ 3 years old (and never the baseline method for applications ≥ Aug 3, 2026).
  o("FNMA_B4_2_2_01_RESERVE_STUDY_AGE_3Y", { trigger: "`project.reserve_study.used`", anchorField: "study_date", evaluator: "24.3.reserveStudyAgeGate", satisfied: "`project.reserve_study.accepted{in_window=true}`",
    why: "§24.3 timer table: window, trigger 'reserve-study exception used', anchor 'study date', '≤ 3 years before review', satisfied by 'in-window study', breach 'reserve exception unavailable' — B4-2.2-01 (08/05/2026): 'The lender may review the most current reserve study or a reserve study update provided it has been completed within three years.'; FAQs: baseline funding not permitted for apps ≥ Aug 3, 2026 and 'the highest recommendation must be used' — runProjectEligibility emits `project.reserve_study.used{study_date}` and `.accepted{in_window}` when reserves fall below the dated minimum (T2: no reserve study → 10.42% < 15% fails)." });
  // R2 / R5 / T6: a safety-related deficiency is never postponed — completed with accepted evidence before the loan is sold.
  o("FNMA_B4_1_3_06_SAFETY_REPAIR_BEFORE_SALE_GATE", { evaluator: "24.3.safetyRepairBeforeSaleGate", satisfied: "`property.repair.completed{safety_related=true}`",
    why: "§24.3 timer table: not_before_gate on `submitDelivery`, trigger '`property.repair.required{safety_related=true}`', 'completion evidence accepted', satisfied by '`holdback`-ineligible items completed', breach 'block delivery (29.4)' — B4-1.3-05: 'any issues affecting the safety, soundness, or structural integrity are repaired before delivery'; B4-1.3-06: repaired 'with a resulting minimum condition rating of C5 prior to sale' — runPropertyEligibility emits the trigger per repair; acceptRepairCompletion emits `property.repair.completed{safety_related}` (T6: deck repaired Fri Nov 13, Completion Report received Mon Nov 16, 2026)." });
  // R2 / T6: every "subject to" item that is not an eligible postponed improvement needs Form 1004D / UAD 3.6 Completion Report or an alternative before delivery.
  o("FNMA_B4_1_2_05_COMPLETION_BEFORE_DELIVERY_GATE", { trigger: "`property.eligibility.completed{subject_to=true}`", evaluator: "24.3.completionBeforeDeliveryGate", satisfied: "`property.completion.accepted`",
    why: "§24.3 timer table: not_before_gate on `submitDelivery`, trigger '\"subject to\" appraisal', 'Form 1004D/UAD 3.6 Completion Report or alternative', satisfied by 'evidence', breach 'block delivery unless postponed-improvement path' — B4-1.2-05 (12/10/2025): 'Verification of completion of construction is required before sale of the loan to Fannie Mae, unless the lender complies with the postponed improvements policies' — runPropertyEligibility emits `property.eligibility.completed{subject_to}`; acceptRepairCompletion emits `property.completion.accepted{evidence_kind}` (T6: delivery blocked until the Nov 16, 2026 Completion Report is accepted)." });
  // R6 / T9: MH property → labels/data plate (or verification letter) and real-property evidence before consummation.
  o("SM_MH_LABEL_VERIFICATION_GATE", { trigger: "`property.eligibility.completed{property_class∈{mh, mh_advantage}}`", evaluator: "24.3.mhLabelVerificationGate", satisfied: "`mh.verification.completed{result=eligible}`",
    why: "§24.3 timer table: not_before_gate on `consummate`, trigger 'MH property', 'HUD label/data plate reported or verification letter on file; real-property evidence', satisfied by '`mh.verification.completed`', breach 'block' — B5-2-02 (12/10/2025): 'The appraiser must report the HUD Data Plate and HUD Certification Label information'; if missing 'the lender must obtain a HUD Certification Label verification letter'; 'both the manufactured home and the land must be legally classified as real property' — runPropertyEligibility emits the trigger with property_class mh / mh_advantage; verifyMh emits `mh.verification.completed{result, special_feature_codes}` (T9: built Jul 1, 1976 + affidavit of affixture + MH Advantage sticker → eligible, SFC 859)." });
}
