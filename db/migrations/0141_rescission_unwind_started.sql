-- 0141_rescission_unwind_started.sql — 25.3 Right of rescission: the unwind START (comment 23(d)(2)-3).
-- (spec/sections/25-compliance-testing-the-closing-disclosure-rescission-and-clo/25-3-right-of-rescission-refinances-of-principal-dwellings-notice.md,
-- Data model and Timers and gates.) REGZ_1026_23D2_RESCISSION_REFUND_20 is satisfied by `rescission.unwind.started`: within the 20
-- calendar days of §1026.23(d)(2) the money is returned AND the security-interest termination process is begun — "The 20-day period
-- for the creditor's action refers to the time within which the creditor must begin the process. It does not require all necessary
-- steps to have been completed within that time" (comment 23(d)(2)-3). Recording/MERS completion is seen through to
-- `rescission.unwind.completed`, the platform completion target (a sev 2 follow-up while open).
-- New tables: none. One nullable column on the append-only rescission_exercises row (0071).
BEGIN;
ALTER TABLE rescission_exercises ADD COLUMN termination_begun_at timestamptz;
COMMENT ON COLUMN rescission_exercises.termination_begun_at IS '25.3: the first security-interest termination step taken (wire cancelled, eNote reversal requested or release submitted for recording); with money_returned_at it satisfies REGZ_1026_23D2_RESCISSION_REFUND_20 (comment 23(d)(2)-3: the 20 days bound the start of the process, not its completion — security_terminated_at records completion).';
COMMIT;
