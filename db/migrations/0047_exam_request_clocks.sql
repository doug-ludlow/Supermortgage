-- 18.2 Fannie Mae MORA reviews — the rule-4 clocks the exam module keeps on each request item (ops-18-2 ExamRequestRow),
-- which 0021 exam_requests did not carry:
--   warn_50_at / warn_80_at   the timer table's "warning at 50% and 80%" columns of FNMA_A2401_REVIEW_FILE_30 and
--                             EXAM_REQUEST_DUE_AS_STATED (no kernel warning kind: examDeadlineSweep fires them, once each,
--                             as `exam.request.warning{level}`; the 80 % warning without a package drafts the extension request, rule 5)
--   approve_by_at             SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD: approval ≥1 BD before due_at (examiner's calendar)
--   officer_gate_at           approve_by_at − 3 BD (officer's calendar): the package must be assembled by then
--   fnma_loan_number          the Fannie Mae loan number the item resolves (rule 1: loans resolve by `loans.fnma_loan_number`)
--   warnings_fired            projection of the `exam.request.warning` events already emitted for the row (sweep idempotence)
-- and the side-state link a remedy demand leaves on the exam (T6: `disputed`, linked to the Section 5.x repurchase case).
-- Append-only: new file, nothing applied is edited.
ALTER TABLE exam_requests
  ADD COLUMN warn_50_at        date,
  ADD COLUMN warn_80_at        date,
  ADD COLUMN approve_by_at     date,
  ADD COLUMN officer_gate_at   date,
  ADD COLUMN fnma_loan_number  text,
  ADD COLUMN warnings_fired    smallint[] NOT NULL DEFAULT '{}';
ALTER TABLE exam_requests
  ADD CONSTRAINT exam_requests_warnings_fired_levels CHECK (warnings_fired <@ ARRAY[50, 80]::smallint[]);
COMMENT ON COLUMN exam_requests.warn_50_at IS '§18.2 timer table: warning at 50% of notification → due_at (examDeadlineSweep)';
COMMENT ON COLUMN exam_requests.warn_80_at IS '§18.2 timer table: warning at 80% — extension request drafted if no package is assembled (rule 5)';
COMMENT ON COLUMN exam_requests.approve_by_at IS 'SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD: officer approval ≥1 BD before due_at';
COMMENT ON COLUMN exam_requests.officer_gate_at IS 'SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD: package assembled by approve_by_at − 3 BD';

ALTER TABLE exams
  ADD COLUMN repurchase_case_id uuid,
  ADD COLUMN side_state text CHECK (side_state IN ('extension_pending', 'disputed', 'litigation_hold'));
COMMENT ON COLUMN exams.repurchase_case_id IS '§18.2 T6: the Section 5.x repurchase case a remedy demand received with the report is handed to (exam side state `disputed`)';
