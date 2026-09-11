-- 0110_retention_schedule_class_spelling.sql — maintainer item (30.4 / 31.3 seam): `retention_schedule.retention_class`
-- (0061, text with a CHECK) spelled the Reg Z §1026.25(c)(2) loan-originator-compensation class `regz_loc_comp_3y`
-- where the platform's retention_class enum (0109) and 31.3's class registry say `regz_locomp_3y`, and it lacked the
-- unfunded-file policy class `orig_unfunded_policy_25m` and the later origination classes the enum gained (0068/0094/0109).
-- One name means one thing on both sides (docs/ARCHITECTURE.md): rows written with the old spelling are re-spelled and
-- the CHECK is replaced (append-only: a new constraint, never an edited migration) with the enum's full label set.
BEGIN;

UPDATE retention_schedule SET retention_class = 'regz_locomp_3y' WHERE retention_class = 'regz_loc_comp_3y';

ALTER TABLE retention_schedule DROP CONSTRAINT IF EXISTS retention_schedule_retention_class_check;
ALTER TABLE retention_schedule ADD CONSTRAINT retention_schedule_retention_class_check CHECK (
  retention_class IN (
    -- 0061's classes, re-spelled
    'regz_le_3y', 'regz_cd_5y', 'regz_atr_3y', 'regz_locomp_3y', 'regz_general_2y', 'regb_25m', 'hmda_3y', 'respa_afba_5y', 'respa_s8_5y',
    'fdpa_life_of_loan', 'fnma_loan_file_life_plus_4y', 'respa_servicing_1y_post', 'bsa_sar_5y', 'ofac_10y', 'esign_consent_life', 'fnma_accounting_report_18m',
    -- the enum's origination additions (0059/0068/0094/0100/0109)
    'orig_unfunded_policy_25m', 'fnma_qc_3y', 'fnma_enote_signing_life_plus_7y', 'co_admt_3y', 'ofac_records_10y', 'ssa_89_5y', 'regb_selftest_25m', 'regb_prescreen_25m', 'ron_recording_state_ny'
  ) OR retention_class ~ '^ron_recording_state_[0-9]+y$'
);
COMMENT ON CONSTRAINT retention_schedule_retention_class_check ON retention_schedule IS '0110: the retention_class enum''s labels (0109 registry spelling: regz_locomp_3y; orig_unfunded_policy_25m) plus the per-state RON recording classes';

COMMIT;
