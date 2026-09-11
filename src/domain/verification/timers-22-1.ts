/**
 * §22.1 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 22.1 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 * The events named here are appended by src/domain/verification/ops-22-1.ts (through src/app/tools/section22-1.ts).
 * `REGB_1002_9_DECISION_30` (20.3/21.6) and `FNMA_B4_1_2_04_APPRAISAL_12M` (24.1) are referenced rows: their owners
 * define them; 22.1 never computes an appraisal's age and never extends the Reg B clock.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_22_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // R2: a per-document expiry gate, not a count — `expires_at = add_months(document_date, 4)`, open iff every relied-upon credit document's
  // expires_at ≥ scheduled_note_date (most-recent-consecutive-document rule). evaluators-22-1.ts `22.1.creditDocs4m` asserts it; ops-22-1
  // assertGateOpen refuses issueCD / submitDuFinal / consummate on an expired document.
  o("FNMA_B1_1_03_CREDIT_DOCS_4M", { evaluator: "22.1.creditDocs4m", anchorField: "scheduled_note_date",
    why: "§22.1 timer table: 'not_before_gate (expiry gate) evaluated per relied-upon credit document', trigger '`document.extracted` and every `closing.scheduled`/reschedule', anchor `scheduled_note_date`, offset 'each document's `expires_at = document_date + 4 calendar months`; gate open iff `expires_at ≥ scheduled_note_date`', satisfied by '`assertGateOpen(applicationId,'FNMA_B1_1_03_CREDIT_DOCS_4M')` before `issueCD` (25.2), `submitDuFinal` (23.1) and `consummate`' (B1-1-03: 'Credit documents must be no more than four months old on the note date')." });
  // The warning clock arms only for a document that has an expiry (identity/contract documents carry none); the replacement document's
  // `document.superseded` retires it (spec: 'replacement document received or closing confirmed before `expires_at`').
  o("SM_DOC_EXPIRY_WARN_14", { trigger: "`document.extracted{expires_at}`", anchorField: "expires_at", satisfied: "`document.superseded`",
    why: "§22.1 timer table: trigger `document.extracted`, anchor `expires_at`, offset '−14 `calendar_days`', satisfied by 'replacement document received or closing confirmed before `expires_at`' — ops-22-1 supersede() emits `document.superseded` when the replacement of the same class/subject/period is received; breach → `document.expiring` and an automatic replacement request when `scheduled_note_date > expires_at` (freshnessSweep)." });
  // R3: a not-before floor keyed to the INITIAL application date (never re-based on amendment); any paystub at/after the floor with YTD earnings opens it.
  o("FNMA_B3_3_2_01_PAYSTUB_30D_GATE", { evaluator: "22.1.paystubFloor", anchorField: "application_date",
    why: "§22.1 timer table: trigger '`document.classified{doc_class=paystub}`', anchor '`applications.application_date` (initial loan application date; refinance fixture Mon Oct 5, 2026)', offset 'paystub `document_date ≥ application_date − 30 calendar_days`', satisfied by 'any paystub in the file that satisfies the floor and carries YTD earnings' (B3-3.2-01: 'dated no earlier than 30 days prior to the initial loan application date … include all year-to-date earnings')." });
  // R4: the two-dimensional B1-1-03 table (application date × scheduled disbursement date); the tax family is the `doc_family` the classifier stamps.
  o("FNMA_B1_1_03_TAX_YEAR_GATE", { trigger: "`document.classified{doc_family=tax}`", evaluator: "22.1.taxYear", anchorField: "application_date",
    why: "§22.1 timer table: trigger '`document.classified{doc_class∈tax}` and `closing.scheduled`', anchor '`application_date` × `scheduled_disbursement_date` (fixture Thu Nov 12, 2026)', offset 'table lookup (rules R3)', satisfied by 'the required year's return, or the transcript / Form 4868 path documented' — ops-22-1 taxYearRequirement/taxYearGate; the classifier stamps `doc_family` (the `document_classes.family`) on `document.classified`." });
}
