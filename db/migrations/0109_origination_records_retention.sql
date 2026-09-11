-- 0109_origination_records_retention.sql — Section 31.3: records, retention, privacy, data ownership and security for
-- origination. One retention engine for the platform: 19.1's `retention_classes` / `record_types` / `record_objects` /
-- `legal_holds` / `disposal_runs` are extended (ALTER + rows), never redefined; the new tables are `pii_access_log`
-- (rule 8, append-only, security_logs_5y) and `vendor_flowdown_requirements` (rule 9); the per-class views are the
-- RPT_ORIG_RETENTION_STATUS projections of record_objects (objects by class/state). Retention classes are versioned
-- rows (version 1.0, effective 2026-10-01) with `may_shorten=false` throughout. Append-only: constraints are replaced, never edited.
BEGIN;

-- ─── retention_class enum: the origination codes 0059/0068/0094 did not add (values are not used inside this migration)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regz_locomp_3y';            -- §1026.25(c)(2)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regz_general_2y';           -- §1026.25(a)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regb_selftest_25m';         -- §1002.12(b)(6)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regb_prescreen_25m';        -- §1002.12(b)(7)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'respa_s8_5y';               -- §1024.14(h)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'ofac_10y';                  -- 31 CFR 501.601
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'orig_unfunded_policy_25m';  -- policy (rule 1, unfunded files)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'ron_recording_state_10y';   -- FL §117.245 / OH R.C. 147.65 (provider-held)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'ron_recording_state_5y';    -- AZ R2-12-1308 (provider-held)

-- ─── retention_classes: origination anchor rules and rows (19.1 registry; version 1.0, effective 2026-10-01)
ALTER TABLE retention_classes DROP CONSTRAINT IF EXISTS retention_classes_anchor_rule_check;
ALTER TABLE retention_classes ADD CONSTRAINT retention_classes_anchor_rule_check CHECK (anchor_rule IN (
  'later_of_liquidation_or_transfer_out','discharge_or_transfer_out','record_created','last_collection_activity','call_date','decision_notified','form_due_date','report_filed','last_use','revocation_or_last_reliance',
  'later_of_consummation_or_disclosure_required','consummation','lo_comp_paid','disclosure_or_action_required','regb_action_notified','self_test_completed','prescreen_solicitation','lar_signed','afba_executed','document_date',
  'funded_then_fnma_else_regb','notarial_act','sar_filed','ofac_transaction_or_unblocking','relationship_end','co_decided','unfunded_policy_max'));
ALTER TABLE retention_classes
  ADD COLUMN IF NOT EXISTS owner_process text,
  ADD COLUMN IF NOT EXISTS holder text NOT NULL DEFAULT 'platform' CHECK (holder IN ('platform','ron_provider','notary','repository'));
COMMENT ON COLUMN retention_classes.holder IS '31.3 nuance 4: RON recordings/journals are held by the RON provider (or the state repository) under state law; the platform keeps the access right, session audit trail and hash under the Fannie Mae class';
INSERT INTO retention_classes (code, version, name, citation, basis, anchor_event, anchor_rule, offset_value, offset_unit, permanent_while_active, disposal_method, may_shorten, effective_from, owner_process, holder) VALUES
  ('regz_le_3y', '1.0', 'Reg Z Loan Estimate evidence 3 years', '12 CFR 1026.25(c)(1)(i)', 'law', 'disclosure.le.delivered', 'later_of_consummation_or_disclosure_required', 3, 'years', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('regz_cd_5y', '1.0', 'Reg Z Closing Disclosure 5 years', '12 CFR 1026.25(c)(1)(ii)', 'law', 'closing.consummated', 'consummation', 5, 'years', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('regz_atr_3y', '1.0', 'Reg Z ATR evidence 3 years', '12 CFR 1026.25(c)(3)', 'law', 'closing.consummated', 'consummation', 3, 'years', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('regz_locomp_3y', '1.0', 'Reg Z loan originator compensation 3 years', '12 CFR 1026.25(c)(2)', 'law', 'lo_comp.paid', 'lo_comp_paid', 3, 'years', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('regz_general_2y', '1.0', 'Reg Z general evidence 2 years (= 19.1 REGZ_1026_25A_RETENTION_2Y)', '12 CFR 1026.25(a)', 'law', 'disclosure.le.delivered', 'disclosure_or_action_required', 2, 'years', false, 'crypto_shred', false, DATE '2026-10-01', '19.1', 'platform'),
  ('regb_25m', '1.0', 'Reg B application records 25 months', '12 CFR 1002.12(b)(1), (b)(4)', 'law', 'notice.adverse_action.sent | noia.sent | application.withdrawn | decision.issued{kind=approved_not_accepted} | loan.funded', 'regb_action_notified', 25, 'months', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('regb_selftest_25m', '1.0', 'Reg B self-test records 25 months', '12 CFR 1002.12(b)(6)', 'law', 'self_test.completed', 'self_test_completed', 25, 'months', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('regb_prescreen_25m', '1.0', 'Reg B prescreened solicitation records 25 months', '12 CFR 1002.12(b)(7)', 'law', 'prescreen.solicitation.sent', 'prescreen_solicitation', 25, 'months', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('hmda_3y', '1.0', 'HMDA submitted LAR 3 years', '12 CFR 1003.5(a)(1)(i)', 'law', 'hmda.lar.accepted', 'lar_signed', 3, 'years', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('respa_afba_5y', '1.0', 'RESPA AfBA disclosure 5 years', '12 CFR 1024.15(d)', 'law', 'afba.executed', 'afba_executed', 5, 'years', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('respa_s8_5y', '1.0', 'RESPA Section 8 records 5 years', '12 CFR 1024.14(h)', 'law', 'record.enrolled{record_type in (msa_agreement, referral_fee_record)}', 'document_date', 5, 'years', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('fdpa_life_of_loan', '1.0', 'SFHDF for the life of the loan (folds into the Fannie Mae class; unfunded: regb_25m)', '12 CFR 22.6(b) via Selling Guide B7-3-06 / A2-4.1-01', 'guide', 'loan.funded', 'funded_then_fnma_else_regb', 0, 'years', true, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('fnma_loan_file_life_plus_4y', '1.0', 'Fannie Mae loan file: permanent while active; at least four years after liquidation; longer where law requires', 'Selling Guide A2-4.1-01 / A2-4.1-02 / A2-4.1-03', 'guide', 'loan.liquidated | servicing.transferred_out', 'later_of_liquidation_or_transfer_out', 4, 'years', true, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('fnma_enote_signing_life_plus_7y', '1.0', 'eNote signing records: life of the loan plus seven years', 'Selling Guide B8-8-02', 'guide', 'enote.signed -> loan.liquidated | servicing.transferred_out', 'later_of_liquidation_or_transfer_out', 7, 'years', true, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('ron_recording_state_10y', '1.0', 'RON recording/journal 10 years (FL; OH journal) - held by the RON provider', 'Fla. Stat. 117.245; Ohio R.C. 147.65', 'law', 'closing.consummated{closing_type=ron}', 'notarial_act', 10, 'years', false, 'none', false, DATE '2026-10-01', '31.3', 'ron_provider'),
  ('ron_recording_state_5y', '1.0', 'RON recording 5 years (AZ) - held by the RON provider', 'Ariz. Admin. Code R2-12-1308', 'law', 'closing.consummated{closing_type=ron}', 'notarial_act', 5, 'years', false, 'none', false, DATE '2026-10-01', '31.3', 'ron_provider'),
  ('bsa_sar_5y', '1.0', 'SAR and supporting documentation 5 years from filing', '31 CFR 1029.320(c)', 'law', 'sar.filed', 'sar_filed', 5, 'years', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('ofac_10y', '1.0', 'OFAC screening/blocking records 10 years (blocked property: from unblocking)', '31 CFR 501.601', 'law', 'party.screened | ofac.property.blocked | ofac.transaction.rejected', 'ofac_transaction_or_unblocking', 10, 'years', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('esign_consent_life', '1.0', 'E-SIGN consent evidence for the life of the customer relationship, then the loan-file class', '15 U.S.C. 7001(c), (d)', 'law', 'consent.granted{kind=esign}', 'relationship_end', 0, 'years', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform'),
  ('orig_unfunded_policy_25m', '1.0', 'Unfunded file policy class: max(regb_25m, hmda_3y, ofac_10y, co_admt_3y, tcpa_consent_4y)', 'policy', 'policy', 'notice.adverse_action.sent | noia.sent | application.withdrawn | decision.issued{kind=approved_not_accepted}', 'unfunded_policy_max', 25, 'months', false, 'crypto_shred', false, DATE '2026-10-01', '31.3', 'platform')
ON CONFLICT (code, version) DO NOTHING;

-- ─── record_types: origination codes (each carries its own classes; the Fannie Mae class is added at loan.funded by records.classify)
INSERT INTO record_types (code, description, system_of_record, servicing_file_category, retention_class_codes, pii_level, fnma_property, ny_419_9_scope) VALUES
  ('urla_1003', 'origination record type (31.3)', 'origination', 'iv_data_fields', '{regb_25m}'::text[], 'high', false, false),
  ('scif_1103', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('credit_report', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('credit_refresh', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('verification_report', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('tax_transcript', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('ssa_89', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('bank_statement', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('paystub', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('w2_1099', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('tax_return', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('loan_estimate', 'origination record type (31.3)', 'origination', 'none', '{regz_le_3y,regz_general_2y}'::text[], 'low', false, false),
  ('le_delivery_evidence', 'origination record type (31.3)', 'origination', 'none', '{regz_le_3y,regz_general_2y}'::text[], 'low', false, false),
  ('changed_circumstance', 'origination record type (31.3)', 'origination', 'none', '{regz_le_3y,regz_general_2y}'::text[], 'low', false, false),
  ('tolerance_test', 'origination record type (31.3)', 'origination', 'none', '{regz_le_3y,regz_general_2y}'::text[], 'low', false, false),
  ('closing_disclosure', 'origination record type (31.3)', 'origination', 'none', '{regz_cd_5y,regz_general_2y}'::text[], 'low', false, false),
  ('cd_delivery_evidence', 'origination record type (31.3)', 'origination', 'none', '{regz_cd_5y,regz_general_2y}'::text[], 'low', false, false),
  ('companion_notice', 'origination record type (31.3)', 'origination', 'none', '{regz_general_2y}'::text[], 'low', false, false),
  ('privacy_notice_evidence', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('afba_disclosure', 'origination record type (31.3)', 'origination', 'none', '{respa_afba_5y}'::text[], 'low', false, false),
  ('adverse_action_notice', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('noia', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('counteroffer', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('statement_of_reasons', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('co_admt_notice', 'origination record type (31.3)', 'origination', 'none', '{co_admt_3y,regb_25m}'::text[], 'high', false, false),
  ('du_findings', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('du_submission_xml', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('appraisal_uad', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('ssr', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('cu_findings', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('property_data_collection', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('rov_file', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('project_review', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'none', false, false),
  ('title_commitment', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('title_policy', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('cpl', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('payoff_demand', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('sfhdf', 'origination record type (31.3)', 'origination', 'none', '{fdpa_life_of_loan}'::text[], 'none', false, false),
  ('flood_notice', 'origination record type (31.3)', 'origination', 'none', '{fdpa_life_of_loan}'::text[], 'low', false, false),
  ('insurance_evidence', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('mi_certificate', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('hpa_disclosure', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('qm_determination', 'origination record type (31.3)', 'origination', 'none', '{regz_atr_3y}'::text[], 'high', false, false),
  ('atr_evidence', 'origination record type (31.3)', 'origination', 'none', '{regz_atr_3y}'::text[], 'high', false, false),
  ('apr_calculation', 'origination record type (31.3)', 'origination', 'none', '{regz_general_2y}'::text[], 'low', false, false),
  ('compliance_test_run', 'origination record type (31.3)', 'origination', 'none', '{regz_general_2y}'::text[], 'low', false, false),
  ('note_image', 'origination record type (31.3)', 'origination', 'ii_security_instrument', '{regb_25m}'::text[], 'high', false, false),
  ('enote_smartdoc', 'origination record type (31.3)', 'origination', 'ii_security_instrument', '{regb_25m}'::text[], 'high', false, false),
  ('enote_signing_record', 'origination record type (31.3)', 'origination', 'ii_security_instrument', '{fnma_enote_signing_life_plus_7y}'::text[], 'high', false, false),
  ('security_instrument', 'origination record type (31.3)', 'origination', 'ii_security_instrument', '{regb_25m}'::text[], 'high', false, false),
  ('rider', 'origination record type (31.3)', 'origination', 'ii_security_instrument', '{regb_25m}'::text[], 'low', false, false),
  ('assignment', 'origination record type (31.3)', 'origination', 'ii_security_instrument', '{regb_25m}'::text[], 'low', false, false),
  ('closing_package', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('ron_session_audit', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('wire_evidence', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('funding_record', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('warehouse_advance', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('bailee_letter', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('uldd_file', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('earlycheck_result', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('ucd_file', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('purchase_advice', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('hmda_lar_row', 'origination record type (31.3)', 'origination', 'iv_data_fields', '{hmda_3y}'::text[], 'restricted', false, false),
  ('sar', 'origination record type (31.3)', 'origination', 'none', '{bsa_sar_5y}'::text[], 'high', false, false),
  ('ofac_screen', 'origination record type (31.3)', 'origination', 'none', '{ofac_10y}'::text[], 'high', false, false),
  ('fraud_report', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('qc_review', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'high', false, false),
  ('agent_decision', 'origination record type (31.3)', 'origination', 'none', '{regb_25m,co_admt_3y}'::text[], 'low', false, false),
  ('consent_esign', 'origination record type (31.3)', 'origination', 'none', '{esign_consent_life}'::text[], 'low', false, false),
  ('consent_tcpa', 'origination record type (31.3)', 'origination', 'none', '{tcpa_consent_4y}'::text[], 'low', false, false),
  ('consent_ai_disclosure', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('lo_comp_record', 'origination record type (31.3)', 'origination', 'none', '{regz_locomp_3y}'::text[], 'low', false, false),
  ('lock_confirmation', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('pricing_exception', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'low', false, false),
  ('fl_demographics', 'origination record type (31.3)', 'origination', 'none', '{regb_25m}'::text[], 'restricted', false, false),
  ('msa_agreement', 'origination record type (31.3)', 'origination', 'none', '{respa_s8_5y}'::text[], 'none', false, false),
  ('referral_fee_record', 'origination record type (31.3)', 'origination', 'none', '{respa_s8_5y}'::text[], 'none', false, false),
  ('self_test_record', 'origination record type (31.3)', 'origination', 'none', '{regb_selftest_25m}'::text[], 'restricted', false, false),
  ('prescreen_solicitation', 'origination record type (31.3)', 'origination', 'none', '{regb_prescreen_25m}'::text[], 'low', false, false)
ON CONFLICT (code) DO NOTHING;
COMMENT ON TABLE record_types IS '19.1 registry of record types; origination codes (31.3) carry fnma_property=false until loan.funded — records.classify adds fnma_loan_file_life_plus_4y for funded loans and the Reg B policy class for files that never fund';

-- ─── record_objects: origination columns and the pre-funding states of the 31.3 state machine
ALTER TABLE record_objects
  ADD COLUMN IF NOT EXISTS application_id uuid REFERENCES applications(id),
  ADD COLUMN IF NOT EXISTS funded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS regb_action_notified_at date,
  ADD COLUMN IF NOT EXISTS consummation_date date,
  ADD COLUMN IF NOT EXISTS disclosure_required_at date;
ALTER TABLE record_objects DROP CONSTRAINT IF EXISTS record_objects_status_check;
ALTER TABLE record_objects ADD CONSTRAINT record_objects_status_check CHECK (status IN ('active','retention_running','eligible','held','disposed','pre_funding','unfunded_running'));
CREATE INDEX IF NOT EXISTS record_objects_application_idx ON record_objects(application_id);
COMMENT ON COLUMN record_objects.funded IS '31.3: drives fnma_property — pre_funding → active{fnma_property=true} on loan.funded, or unfunded_running on regb_action_notified_at (effective class orig_unfunded_policy_25m)';
COMMENT ON COLUMN record_objects.regb_action_notified_at IS '31.3: 12 CFR 1002.12(b)(1) anchor — notice.adverse_action.sent / noia.sent / application.withdrawn / decision.issued{approved_not_accepted} / loan.funded (approval notified)';
COMMENT ON COLUMN record_objects.consummation_date IS '31.3: 12 CFR 1026.25(c)(1)(ii), (c)(3) anchor (closing.consummated)';
COMMENT ON COLUMN record_objects.disclosure_required_at IS '31.3: 12 CFR 1026.25(c)(1)(i) — the date the LE was required to be made (later-of with consummation_date and the action-required date)';

-- ─── legal_holds: origination auto-hold reasons and the application scope
ALTER TABLE legal_holds DROP CONSTRAINT IF EXISTS legal_holds_scope_check;
ALTER TABLE legal_holds ADD CONSTRAINT legal_holds_scope_check CHECK (scope IN ('loan','borrower','case','portfolio_batch','record_type','vendor','global','application'));
ALTER TABLE legal_holds DROP CONSTRAINT IF EXISTS legal_holds_reason_check;
ALTER TABLE legal_holds ADD CONSTRAINT legal_holds_reason_check CHECK (reason IN ('litigation','litigation_anticipated','subpoena','regulator_exam','fannie_mae_request','mora','complaint_escalated','internal_investigation','audit','incident',
  'origination_complaint_discrimination','origination_complaint_udaap','origination_regulator_inquiry','origination_co_ag_notice','origination_litigation','origination_qc_self_report','origination_security_incident'));
ALTER TABLE legal_holds
  ADD COLUMN IF NOT EXISTS application_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS security_incident_id uuid REFERENCES security_incidents(id),
  ADD COLUMN IF NOT EXISTS auto_placed boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN legal_holds.application_ids IS '31.3 SM_O123_LEGAL_HOLD_ON_TRIGGER_1H: every application the trigger touches is held within one hour (reason origination_*); release stays officer + attorney';

-- ─── disposal_runs: the unfunded-file purge sweep (rule 5) tombstone record
ALTER TABLE disposal_runs
  ADD COLUMN IF NOT EXISTS origination_unfunded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS application_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tombstone jsonb;
COMMENT ON COLUMN disposal_runs.tombstone IS '31.3 rule 5: {applications[], retained_columns (id, dates, action taken, HMDA-derived fields per hmda_3y), shredded (PII columns), agent_decisions: hashes_and_versions_only, credit_reports: crypto_shred}';

-- ─── pii_access_log (new; append-only; retention security_logs_5y): every read of a restricted table with its purpose code (rule 8)
CREATE TABLE pii_access_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at                    timestamptz NOT NULL DEFAULT now(),
  principal             text NOT NULL,
  role                  text NOT NULL,
  table_name            text NOT NULL CHECK (table_name IN ('applicant_demographics','credit_reports','documents_pii','du_findings','verification_raw')),
  application_id        uuid REFERENCES applications(id),
  purpose_code          text NOT NULL CHECK (purpose_code IN ('intake_write','hmda_export','boarding_export_19_4','monitoring_run','bias_test','qc_review','regulator_query','fnma_query','incident_scoping','borrower_request','access_review')),
  request_id            text NOT NULL,
  query_hash            text NOT NULL,
  row_count             int NOT NULL DEFAULT 0,
  decision              text NOT NULL DEFAULT 'allowed' CHECK (decision IN ('allowed','denied')),
  anomaly               text[] NOT NULL DEFAULT '{}',
  siem_alert_due_at     timestamptz,
  retention             text NOT NULL DEFAULT 'security_logs_5y' CHECK (retention = 'security_logs_5y')
);
CREATE INDEX pii_access_log_principal_idx ON pii_access_log(principal, at);
CREATE INDEX pii_access_log_application_idx ON pii_access_log(application_id);
CREATE TRIGGER pii_access_log_immutable BEFORE UPDATE OR DELETE ON pii_access_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE pii_access_log IS '31.3 data model `pii_access_log` (spec column `table` is table_name): at, principal, role, table ∈ {applicant_demographics, credit_reports, documents_pii, du_findings, verification_raw}, application_id, purpose_code, request_id, query_hash, row_count; shipped to the 19.2 SIEM; a denied read (principal outside the roster, off-purpose code, bulk read) is the pii.access.anomaly that opens SM_O123_PII_ACCESS_ANOMALY_1H';

-- ─── vendor_flowdown_requirements (new): 19.3 vendors joined to the clause codes required per class (rule 9)
CREATE TABLE vendor_flowdown_requirements (
  vendor_class          text PRIMARY KEY CHECK (vendor_class IN ('amc_appraiser','pdc','credit_reseller','verification_income_asset','ives_transcript','cbsv','identity_fraud','flood','title_settlement','wire_verification','eclosing_ron','evault','erecording','mi_company','print_mail','e_delivery','telephony_voice','model_provider','custodian','warehouse_bank')),
  required_clause_codes text[] NOT NULL,
  data_classes_permitted text[] NOT NULL DEFAULT '{}',
  state_overlays        jsonb NOT NULL DEFAULT '{}',
  version               text NOT NULL DEFAULT '1.0',
  effective_from        date NOT NULL DEFAULT DATE '2026-10-01'
);
COMMENT ON TABLE vendor_flowdown_requirements IS '31.3 rule 9 / SM_O123_VENDOR_FLOWDOWN_GATE: every required_clause_codes entry must be present (or deviation with attorney sign-off) in the vendor''s executed contract_clauses before an order; every class also requires DATA_RETURN_DESTROY_CERT, INCIDENT_NOTICE_24H, AUDIT_RIGHTS_FNMA, US_PROCESSING, SUBPROCESSOR_NOTICE; GLBA_1016_13_USE_LIMIT is the §1016.13 service-provider condition (GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE)';
INSERT INTO vendor_flowdown_requirements (vendor_class, required_clause_codes, data_classes_permitted, state_overlays) VALUES
  ('amc_appraiser', '{AIR_1026_42_INDEPENDENCE,UCDP_LENDER_AGENT_TERMS,FNMA_DATA_NO_REDISCLOSURE,GLBA_1016_13_USE_LIMIT,NPI_MINIMUM_NECESSARY,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{property,borrower_name_address}'::text[], '{}'::jsonb),
  ('pdc', '{FNMA_DATA_NO_REDISCLOSURE,GLBA_1016_13_USE_LIMIT,NPI_MINIMUM_NECESSARY,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{property}'::text[], '{}'::jsonb),
  ('credit_reseller', '{FCRA_END_USER_CERT,FCRA_PERMISSIBLE_PURPOSE_PER_PULL,GLBA_1016_13_USE_LIMIT,US_IP_ALLOW_LIST,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{npi,fcra_consumer_report}'::text[], '{}'::jsonb),
  ('verification_income_asset', '{FCRA_END_USER_CERT,BORROWER_AUTHORIZATION_SCOPE,NO_RETENTION_BEYOND_TRANSACTION,NO_TRAINING_ON_DATA,GLBA_1016_13_USE_LIMIT,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{npi,fcra_consumer_report}'::text[], '{}'::jsonb),
  ('ives_transcript', '{IRS_IVES_AUDIT_LOG,BORROWER_AUTHORIZATION_SCOPE,NO_RETENTION_BEYOND_TRANSACTION,GLBA_1016_13_USE_LIMIT,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{tax_data}'::text[], '{}'::jsonb),
  ('cbsv', '{BORROWER_AUTHORIZATION_SCOPE,NO_RETENTION_BEYOND_TRANSACTION,GLBA_1016_13_USE_LIMIT,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{ssn,npi}'::text[], '{}'::jsonb),
  ('identity_fraud', '{GLBA_1016_13_USE_LIMIT,BIOMETRIC_STATE_LAW_COMPLIANCE,RETENTION_LIMITS,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{npi,id_number}'::text[], '{}'::jsonb),
  ('flood', '{GLBA_1016_13_USE_LIMIT,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{property}'::text[], '{}'::jsonb),
  ('title_settlement', '{ALTA_BEST_PRACTICES,WIRE_FRAUD_CONTROLS,GLBA_1016_13_USE_LIMIT,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{npi,property}'::text[], '{}'::jsonb),
  ('wire_verification', '{GLBA_1016_13_USE_LIMIT,WIRE_FRAUD_CONTROLS,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{account_number}'::text[], '{}'::jsonb),
  ('eclosing_ron', '{RON_RECORDING_ACCESS_RIGHT,MISMO_RON_AUDIT_TRAIL,GLBA_1016_13_USE_LIMIT,BREACH_NOTICE_24H,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{npi,id_number,recording}'::text[], '{"FL": ["RON_STATE_RETENTION_FL"], "AZ": ["RON_STATE_RETENTION_AZ"], "OH": ["RON_STATE_RETENTION_OH"]}'::jsonb),
  ('evault', '{MERS_ERegistry_PARTICIPANT,SMART_DOC_INTEGRITY,TRANSFER_OF_CONTROL_COOPERATION,RETURN_EXPORT_ON_TERMINATION,GLBA_1016_13_USE_LIMIT,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{enote}'::text[], '{}'::jsonb),
  ('erecording', '{PRIA_STANDARDS,GLBA_1016_13_USE_LIMIT,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{security_instrument}'::text[], '{}'::jsonb),
  ('mi_company', '{MI_MASTER_POLICY_DATA_TERMS,NPI_LIMITED_TO_CERTIFICATE,GLBA_1016_13_USE_LIMIT,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{npi}'::text[], '{}'::jsonb),
  ('print_mail', '{GLBA_1016_13_USE_LIMIT,PROOF_RETENTION_19_1,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{npi}'::text[], '{}'::jsonb),
  ('e_delivery', '{GLBA_1016_13_USE_LIMIT,PROOF_RETENTION_19_1,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{npi}'::text[], '{}'::jsonb),
  ('telephony_voice', '{GLBA_1016_13_USE_LIMIT,CALL_RECORDING_CONSENT_STATES,RETENTION_TCPA_OR_LOAN_FILE,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{voice,npi}'::text[], '{}'::jsonb),
  ('model_provider', '{NO_TRAINING_ON_DATA,ZERO_RETENTION,NO_HUMAN_REVIEW_WITHOUT_NOTICE,MODEL_VERSION_CHANGE_NOTICE,ASSURANCE_REPORTS,GLBA_1016_13_USE_LIMIT,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{npi}'::text[], '{}'::jsonb),
  ('custodian', '{FNMA_DATA_NO_REDISCLOSURE,GLBA_1016_13_USE_LIMIT,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{note,npi}'::text[], '{}'::jsonb),
  ('warehouse_bank', '{BAILEE_TERMS,GLBA_1016_13_USE_LIMIT,DATA_RETURN_DESTROY_CERT,INCIDENT_NOTICE_24H,AUDIT_RIGHTS_FNMA,US_PROCESSING,SUBPROCESSOR_NOTICE}'::text[], '{note,npi}'::text[], '{}'::jsonb);

-- ─── per-class projections of record_objects (RPT_ORIG_RETENTION_STATUS: objects by class/state) — one view per origination class code (bsa_sar_5y is 28.4's view, migration 0102)
CREATE VIEW regz_le_3y AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'regz_le_3y'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'regz_le_3y' LIMIT 1) AS gate
  FROM record_objects o WHERE 'regz_le_3y' = ANY(o.applicable_class_codes);
COMMENT ON VIEW regz_le_3y IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class regz_le_3y with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW regz_cd_5y AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'regz_cd_5y'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'regz_cd_5y' LIMIT 1) AS gate
  FROM record_objects o WHERE 'regz_cd_5y' = ANY(o.applicable_class_codes);
COMMENT ON VIEW regz_cd_5y IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class regz_cd_5y with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW regz_atr_3y AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'regz_atr_3y'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'regz_atr_3y' LIMIT 1) AS gate
  FROM record_objects o WHERE 'regz_atr_3y' = ANY(o.applicable_class_codes);
COMMENT ON VIEW regz_atr_3y IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class regz_atr_3y with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW regz_locomp_3y AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'regz_locomp_3y'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'regz_locomp_3y' LIMIT 1) AS gate
  FROM record_objects o WHERE 'regz_locomp_3y' = ANY(o.applicable_class_codes);
COMMENT ON VIEW regz_locomp_3y IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class regz_locomp_3y with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW regz_general_2y AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'regz_general_2y'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'regz_general_2y' LIMIT 1) AS gate
  FROM record_objects o WHERE 'regz_general_2y' = ANY(o.applicable_class_codes);
COMMENT ON VIEW regz_general_2y IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class regz_general_2y with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW regb_25m AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'regb_25m'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'regb_25m' LIMIT 1) AS gate
  FROM record_objects o WHERE 'regb_25m' = ANY(o.applicable_class_codes);
COMMENT ON VIEW regb_25m IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class regb_25m with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW regb_selftest_25m AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'regb_selftest_25m'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'regb_selftest_25m' LIMIT 1) AS gate
  FROM record_objects o WHERE 'regb_selftest_25m' = ANY(o.applicable_class_codes);
COMMENT ON VIEW regb_selftest_25m IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class regb_selftest_25m with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW regb_prescreen_25m AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'regb_prescreen_25m'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'regb_prescreen_25m' LIMIT 1) AS gate
  FROM record_objects o WHERE 'regb_prescreen_25m' = ANY(o.applicable_class_codes);
COMMENT ON VIEW regb_prescreen_25m IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class regb_prescreen_25m with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW hmda_3y AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'hmda_3y'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'hmda_3y' LIMIT 1) AS gate
  FROM record_objects o WHERE 'hmda_3y' = ANY(o.applicable_class_codes);
COMMENT ON VIEW hmda_3y IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class hmda_3y with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW respa_afba_5y AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'respa_afba_5y'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'respa_afba_5y' LIMIT 1) AS gate
  FROM record_objects o WHERE 'respa_afba_5y' = ANY(o.applicable_class_codes);
COMMENT ON VIEW respa_afba_5y IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class respa_afba_5y with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW respa_s8_5y AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'respa_s8_5y'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'respa_s8_5y' LIMIT 1) AS gate
  FROM record_objects o WHERE 'respa_s8_5y' = ANY(o.applicable_class_codes);
COMMENT ON VIEW respa_s8_5y IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class respa_s8_5y with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW fdpa_life_of_loan AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'fdpa_life_of_loan'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'fdpa_life_of_loan' LIMIT 1) AS gate
  FROM record_objects o WHERE 'fdpa_life_of_loan' = ANY(o.applicable_class_codes);
COMMENT ON VIEW fdpa_life_of_loan IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class fdpa_life_of_loan with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW fnma_loan_file_life_plus_4y AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'fnma_loan_file_life_plus_4y'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'fnma_loan_file_life_plus_4y' LIMIT 1) AS gate
  FROM record_objects o WHERE 'fnma_loan_file_life_plus_4y' = ANY(o.applicable_class_codes);
COMMENT ON VIEW fnma_loan_file_life_plus_4y IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class fnma_loan_file_life_plus_4y with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW fnma_enote_signing_life_plus_7y AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'fnma_enote_signing_life_plus_7y'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'fnma_enote_signing_life_plus_7y' LIMIT 1) AS gate
  FROM record_objects o WHERE 'fnma_enote_signing_life_plus_7y' = ANY(o.applicable_class_codes);
COMMENT ON VIEW fnma_enote_signing_life_plus_7y IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class fnma_enote_signing_life_plus_7y with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW ofac_10y AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'ofac_10y'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'ofac_10y' LIMIT 1) AS gate
  FROM record_objects o WHERE 'ofac_10y' = ANY(o.applicable_class_codes);
COMMENT ON VIEW ofac_10y IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class ofac_10y with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW esign_consent_life AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'esign_consent_life'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'esign_consent_life' LIMIT 1) AS gate
  FROM record_objects o WHERE 'esign_consent_life' = ANY(o.applicable_class_codes);
COMMENT ON VIEW esign_consent_life IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class esign_consent_life with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';
CREATE VIEW orig_unfunded_policy_25m AS
  SELECT o.id AS record_object_id, o.application_id, o.loan_id, o.record_type, o.state, o.status, o.hold_count, o.funded, o.eligible_for_disposal_at, o.effective_class_code, o.anchors, o.schedule_version,
         'orig_unfunded_policy_25m'::text AS class_code, (SELECT g FROM jsonb_array_elements(o.gate_outcomes) g WHERE g->>'class_code' = 'orig_unfunded_policy_25m' LIMIT 1) AS gate
  FROM record_objects o WHERE 'orig_unfunded_policy_25m' = ANY(o.applicable_class_codes);
COMMENT ON VIEW orig_unfunded_policy_25m IS '31.3 RPT_ORIG_RETENTION_STATUS: the record objects carrying retention class orig_unfunded_policy_25m with that class''s last gate outcome (objects by class/state); a projection of record_objects, never a second copy of the retention engine.';

COMMIT;
