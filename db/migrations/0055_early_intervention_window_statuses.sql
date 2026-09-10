-- 0055_early_intervention_window_statuses.sql — Section 11.1/11.2: align the regx_ei_windows status CHECKs with the
-- state machines. 0013 carried only the data-model enums; the 11.1/11.2 state machines and tests also name
-- `breached` (a leg still open past its deadline — never deleted), `breached_at_boarding` (11.1-T20), `exempt_discharge`
-- (11.2 state machine: legs exempt after a discharge until a post-petition payment re-arms them), `bk_modified_required`
-- (11.2 state machine: the single per-case modified-notice task while options are available) and `transfer_out`
-- (11.1 edge case: window closed on transfer-out). Append-only: the constraints are replaced, never edited in place.
BEGIN;

ALTER TABLE regx_ei_windows DROP CONSTRAINT IF EXISTS regx_ei_windows_live_status_check;
ALTER TABLE regx_ei_windows ADD CONSTRAINT regx_ei_windows_live_status_check
  CHECK (live_status IN ('open','satisfied_live','satisfied_good_faith','satisfied_ongoing_lossmit','cancelled_paid',
                         'exempt_bk','exempt_fdcpa_cease','exempt_discharge','not_applicable',
                         'breached','breached_at_boarding','transfer_out'));

ALTER TABLE regx_ei_windows DROP CONSTRAINT IF EXISTS regx_ei_windows_notice_status_check;
ALTER TABLE regx_ei_windows ADD CONSTRAINT regx_ei_windows_notice_status_check
  CHECK (notice_status IN ('open','sent','satisfied_by_prior_180','cancelled_paid',
                           'exempt_bk_no_option','exempt_bk_cease','exempt_fdcpa_no_option','exempt_fdcpa_bk','exempt_discharge',
                           'bk_modified_required','deferred_transferee','not_applicable',
                           'breached','breached_at_boarding','transfer_out'));

COMMENT ON COLUMN regx_ei_windows.live_status IS '11.1 state machine: open → satisfied_live | satisfied_good_faith | satisfied_ongoing_lossmit | cancelled_paid | exempt_* | not_applicable; open past live_due_at → breached; seeded past due at boarding → breached_at_boarding; transfer-out → transfer_out';
COMMENT ON COLUMN regx_ei_windows.notice_status IS '11.2 state machine: open → sent | satisfied_by_prior_180 | cancelled_paid | exempt_* | deferred_transferee | not_applicable; petition with options available → bk_modified_required (one per case); open past notice_due_at → breached';

COMMIT;
