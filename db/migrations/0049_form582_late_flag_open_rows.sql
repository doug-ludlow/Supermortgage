-- 0049_form582_late_flag_open_rows: §18.4 state machine — "`late` flag when past `due_at`". 0049_form582_filings_state's
-- regulatory_filings_late_check allowed `late` only on a submitted row (late = false OR submitted_at IS NOT NULL), so an open
-- Form 582 / AFS / notice row past its due_at could not carry the flag and `late` was recordable only at submission. Append-only:
-- the constraint is replaced here, the applied migration is not edited.
--   late is set (a) on any open row once due_at has passed — ops-18-4.ts lateFlag / the filing.late_check sweep, and (b) at
--   submission or filing when submitted_at's Eastern civil date is past due_at (filingSubmit / noticeTransition); a row
--   submitted on or before due_at is never late (rule 1: due_at = FYE + 90 calendar days, no business-day roll).
BEGIN;
ALTER TABLE regulatory_filings DROP CONSTRAINT regulatory_filings_late_check;
ALTER TABLE regulatory_filings ADD CONSTRAINT regulatory_filings_late_check
  CHECK (late = false OR submitted_at IS NULL OR (submitted_at AT TIME ZONE 'America/New_York')::date > due_at);
COMMENT ON COLUMN regulatory_filings.late IS '§18.4 state machine: `late` flag when past due_at — set on an open row by the filing.late_check sweep once due_at has passed, and at submission/filing when submitted past due_at (rule 1: due_at = FYE + 90 calendar days, no business-day roll; FYE 2026-12-31 → 2027-03-31). A row submitted on or before due_at is never late.';
COMMIT;
