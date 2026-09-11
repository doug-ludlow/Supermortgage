/**
 * §22.3 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 22.3 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it (`FNMA_B1_1_03_CREDIT_DOCS_4M` is 22.1's). Wired by
 * src/domain/timer-overrides.ts. Every event named here is appended by src/domain/verification/ops-22-3.ts (the
 * `closing.scheduled` trigger by 26.2 / 22.1's harness; `closing.consummated` by 26.1).
 *
 * Conventions the grammar forces: a "[note_date − N, note_date]" window is `between −N and 0 <unit>` anchored on the
 * `scheduled_note_date` the closing event carries (the engine reports `window opens <date>` and is due on the note
 * date); an " A or B " satisfier becomes one resolution event ops-22-3 emits in both branches (`vvoe.completed` is
 * emitted for the verbal/written/vendor/document methods AND for a DU employment validation whose Close by Date is on/after
 * the note date — `vvoeFromDuValidation`); a rule "evaluated as a gate" is `evaluator:` + the evaluated event.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_22_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // R1: the verbal VOE window — ten creditor business days back from the scheduled note date (refinance fixture Fri Oct 23 – Fri Nov 6, 2026).
  o("FNMA_B3_3_1_04_VVOE_10BD", { offset: "between −10 and 0 business_days_creditor", anchorField: "scheduled_note_date", satisfied: "`vvoe.completed{within_window=true}`",
    why: "§22.3 timer table: trigger '`closing.scheduled` (and each reschedule)', anchor `scheduled_note_date`, 'window = [note_date − 10 `business_days_creditor`, note_date]; refinance fixture: Fri Oct 23, 2026 – Fri Nov 6, 2026', satisfied by '`vvoe.completed{within_window=true}` for every employed borrower, or `du_validation` employment with Close by Date ≥ note date' — recordVvoe stamps `within_window` from windowForMethod(note_date_used) and vvoeFromDuValidation emits the same event (method=du_validation) when the Close by Date is on/after the note date (B3-3.1-04: 'within 10 business days prior to the note date'; 'Compliance with the DU message satisfies the requirement')." });
  // R1: self-employment business existence — 120 calendar days (refinance fixture Thu Jul 9 – Fri Nov 6, 2026).
  o("FNMA_B3_3_1_04_SE_VERIFY_120", { offset: "between −120 and 0 calendar_days", anchorField: "scheduled_note_date", satisfied: "`business.existence.verified{within_window=true}`",
    why: "§22.3 timer table: trigger `closing.scheduled`, anchor `scheduled_note_date`, 'window = [note_date − 120 `calendar_days`, note_date]; refinance fixture: Thu Jul 9, 2026 – Fri Nov 6, 2026', satisfied by '`business.existence.verified{within_window=true}`' — verifyBusinessExistence (B3-3.1-04: 'verify the existence of the borrower's business within 120 calendar days prior to the note date')." });
  // R1: the paystub / bank-statement alternative — 15 creditor business days (fixture Fri Oct 16, 2026); the qualifying document is recorded as a VVOE by that method.
  o("FNMA_B3_3_1_04_VVOE_ALT_15BD", { offset: "between −15 and 0 business_days_creditor", anchorField: "scheduled_note_date", satisfied: "`vvoe.completed{method∈{paystub_15bd, bank_statement_15bd}, within_window=true}`",
    why: "§22.3 timer table: trigger `closing.scheduled`, anchor `scheduled_note_date`, 'paystub/bank-statement alternative dated ≥ note_date − 15 `business_days_creditor` (fixture: Fri Oct 16, 2026)', satisfied by 'qualifying alternative document' — recordVvoe{method=paystub_15bd|bank_statement_15bd} measures the document date against the 15-BD window (B3-3.1-04 alternatives; 00a-fnma §4.7); breach 'falls back to verbal/vendor method'." });
  // R9: the DU "Close by Date" — armed by 22.3's own record of the DU employment validation message (23.2's `du.findings.received` is a bundle; the per-component
  // outcome is `income.validated{component}`), due on the Close by Date the message states, satisfied by 26.1's consummation; reassessCloseBy handles the slip.
  o("FNMA_B3_2_02_DU_CLOSE_BY_GATE", { trigger: "`income.validated{component=employment}`", anchorField: "close_by_date", offset: "0 calendar_days", satisfied: "`closing.consummated`",
    why: "§22.3 timer table: trigger '`du.findings.received{employment validated}`', anchor '`close_by_date` from the DU message', 'closing must occur ≤ `close_by_date`', satisfied by '`closing.consummated ≤ close_by_date`' — recordDuValidation turns the DU employment-validation message into `income.validated{component=employment, close_by_date}` (R9 worked example: message Wed Oct 7, 2026, Close by Fri Nov 20, 2026); a consummation after the due date is `satisfied_late` and reassessCloseBy emits `du.close_by.missed` / `du.resubmission.requested` / `rep_warrant_relief.updated` (B3-2-02: 'ensuring the loan closes by the Close by Date'; A2-2-04 relief lost if not cured)." });
  // R10: Form 4506-C / 8821 validity — 120 calendar days from the borrower's signature (fixture Mon Oct 5, 2026 → Tue Feb 2, 2027); a fresh signature arms a new instance.
  o("FNMA_B3_3_1_02_4506C_VALID_120", { anchorField: "signed_on", satisfied: "`transcript.ordered`",
    why: "§22.3 timer table: trigger `transcript.authorization.signed`, anchor `signed_at`, '+120 `calendar_days`; fixture: signed Mon Oct 5, 2026 → valid through Tue Feb 2, 2027', satisfied by 'transcripts ordered before expiry, or a fresh signature' — signAuthorization carries `signed_on` (the creditor civil date of `signed_at`) and orderTranscript refuses an order after `valid_until` (B3-3.1-02: 'valid for 120 days after completion (including signature)'); a re-signed form is a new `transcript.authorization.signed` instance." });
  // R7: option 2 start-date window (purchase fixture Mon Oct 19, 2026 – Tue Feb 16, 2027), armed by the option choice and satisfied by the verified offer.
  o("FNMA_B3_3_3_03_OFFER_START_WINDOW", { offset: "between −30 and +90 calendar_days", anchorField: "scheduled_note_date", satisfied: "`employment.offer.verified{option=2, within_window=true}`",
    why: "§22.3 timer table: trigger '`employment.offer.option.selected{option=2}`', anchor `scheduled_note_date`, 'start date ∈ [note_date − 30 `calendar_days`, note_date + 90 `calendar_days`]', satisfied by 'offer start date inside the window and reserves documented' — selectOfferOption emits the selection with `scheduled_note_date`, then `employment.offer.verified{option=2, within_window=true, reserves_documented=true, sfc_codes=[707]}` or `employment.offer.option.refused` (B3-3.3-03 Option 2; SFC 707)." });
  // B3-3.1-01: the three-year continuance rule is a gate over the calculated source, evaluated by evaluators-22-3.ts `22.3.continuance3y` and closed by the evaluation record.
  o("FNMA_B3_3_1_01_CONTINUANCE_3Y", { evaluator: "22.3.continuance3y", anchorField: "scheduled_note_date", satisfied: "`income.continuance.evaluated{result=pass}`",
    why: "§22.3 timer table: 'rule, evaluated as a gate', trigger `income.calculated`, anchor `scheduled_note_date`, '`continuance_end_date ≥ note_date + 3 years` where a defined end exists (child support by age, alimony term, retirement-distribution asset sufficiency)', satisfied by 'documented continuance'; breach 'income excluded from qualifying with a written reason (22.5 recalculates DTI)' — evaluateContinuance emits `income.continuance.evaluated{result}` and, on failure, `income.excluded{written_reason}` (B3-3.1-01: 'expected to continue for at least three years from the note date')." });
  // Policy: the VVOE is scheduled within two creditor business days of the window opening so the gate is never the last-day surprise.
  o("SM_VVOE_SCHEDULE_2BD", { trigger: "`vvoe.window.opened`", anchorField: "window_start", offset: "+2 business_days_creditor", satisfied: "`vvoe.completed`",
    why: "§22.3 timer table: trigger 'window opens', anchor `window_start`, '+2 `business_days_creditor`', satisfied by `vvoe.completed`; breach 'sev 3 → alternative method queued' — scheduleVvoe emits `vvoe.window.opened{window_start}` when the R1 window is computed for a borrower (edge case: 'the agent schedules VVOEs two business days before the note date by default to survive small slips')." });
}
