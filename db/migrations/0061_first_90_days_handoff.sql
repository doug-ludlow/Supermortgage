-- 0061_first_90_days_handoff.sql — §30.4 first-90-days servicing hand-off of a newly originated loan (spec/sections/30-…/30-4-….md
-- "Data model"): the hand-off checklist (HO-001…HO-022), vendor activations, EPD flags, §1024.38(c)(2) servicing-file
-- compilations and the origination retention schedule, plus the additive columns the spec names on `loans` and `documents`.
-- Nothing here redefines a servicing table; `retention_schedule.retention_class` carries the origination domain (baseline
-- addendum §10) as text because the servicing `retention_class` enum is owned by 0001/0008/0020 (an enum value cannot be
-- added inside the transaction that first uses it).
BEGIN;

-- ---------------------------------------------------------------- servicing_handoffs (rule 1, rule 12)
CREATE TABLE servicing_handoffs (
  handoff_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  application_id        uuid REFERENCES applications(id),                       -- both ids during the hand-off (addendum §3)
  opened_at             timestamptz NOT NULL,                                    -- = loans.boarded_at (30.2 `loan.boarded`)
  first_payment_date    date NOT NULL,
  purchase_date         date,                                                    -- `loan.purchased` (29.4); HO-010…HO-014 become due
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete', 'complete_with_exceptions', 'closed', 'reopened')),
  close_by              date NOT NULL,                                           -- opened_at + 90 calendar days (SM_ORIG_HANDOFF_CLOSE_90)
  closed_at             timestamptz,
  close_basis           text CHECK (close_basis IN ('all_items_satisfied', 'officer_override', 'loan_paid_off', 'loan_transferred')),
  exception_count       int NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  agent_decision_id     uuid REFERENCES agent_decisions(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT servicing_handoffs_closed_basis CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND close_basis IS NOT NULL))
);
CREATE UNIQUE INDEX servicing_handoffs_open_one ON servicing_handoffs(loan_id) WHERE status <> 'closed';
CREATE INDEX servicing_handoffs_status_idx ON servicing_handoffs(status, close_by);
COMMENT ON TABLE servicing_handoffs IS '30.4 rule 1/12: one hand-off per origination, opened at `loan.boarded`; open → complete | complete_with_exceptions → closed (SM_ORIG_HANDOFF_CLOSE_90 or completion + third statement) → reopened → closed; a paid-off/transferred loan closes with that basis.';

-- ---------------------------------------------------------------- handoff_items (HO-001…HO-022)
CREATE TABLE handoff_items (
  item_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id            uuid NOT NULL REFERENCES servicing_handoffs(handoff_id),
  item_code             text NOT NULL CHECK (item_code ~ '^HO-0(0[1-9]|1[0-9]|2[0-2])$'),
  owner_process         text NOT NULL,                                           -- e.g. 30.2, 25.4, 7.1 — the obligation's owner
  timer_code            text,                                                    -- governing timer, referenced not redefined
  due_at                timestamptz,                                             -- null for HO-010…HO-014 until `loan.purchased`
  satisfying_event      text,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'satisfied', 'not_applicable', 'breached', 'waived')),
  satisfied_at          timestamptz,
  evidence_document_id  uuid REFERENCES documents(id),
  evidence_event_id     uuid REFERENCES loan_events(id),
  timer_instance_id     uuid REFERENCES timers(id),                              -- the breached instance (rule 1)
  na_reason             text,                                                    -- no_mi | not_purchased | loan_terminated
  waiver_decision_id    uuid REFERENCES agent_decisions(id),                     -- `waived` requires an officer decision record
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handoff_items_waived_needs_decision CHECK (status <> 'waived' OR waiver_decision_id IS NOT NULL),
  CONSTRAINT handoff_items_breached_names_timer CHECK (status <> 'breached' OR timer_instance_id IS NOT NULL OR timer_code IS NOT NULL),
  UNIQUE (handoff_id, item_code)
);
CREATE INDEX handoff_items_status_idx ON handoff_items(status, due_at);
COMMENT ON TABLE handoff_items IS '30.4 rule 1: the 22 hand-off items with owner, governing timer and satisfying event; 30.4 never re-implements the underlying obligation — the item records the owner''s evidence ids.';

-- ---------------------------------------------------------------- vendor_activations (rule 8)
CREATE TABLE vendor_activations (
  activation_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  vendor_kind           text NOT NULL CHECK (vendor_kind IN ('tax_service', 'flood_lol', 'insurance_tracking', 'mi_activation')),
  vendor_party_id       uuid REFERENCES parties(id),
  contract_ref          text,                                                    -- tax-service contract no. | flood LOL certificate id | tracking-vendor loan id | MI certificate no.
  attempt               int NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  requested_at          timestamptz NOT NULL,
  confirmed_at          timestamptz,
  status                text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'rejected', 'not_applicable')),
  reject_reason         text,
  evidence_document_id  uuid REFERENCES documents(id),
  cost_cents            bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),   -- tax-service LOL fee (partner-paid per the CD or SM-absorbed; 20.4)
  request_payload       jsonb NOT NULL DEFAULT '{}',                             -- servicing loan number, APN(s), LOL certificate, policies, MI certificate
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_activations_confirmed_ref CHECK (status <> 'confirmed' OR (confirmed_at IS NOT NULL AND contract_ref IS NOT NULL)),
  CONSTRAINT vendor_activations_rejected_reason CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);
CREATE INDEX vendor_activations_loan_idx ON vendor_activations(loan_id, vendor_kind, attempt);
COMMENT ON TABLE vendor_activations IS '30.4 rule 8: tax-service LOL contract, flood LOL servicing link, insurance-tracking load and MI activation confirmation requested at `loan.boarded`; requested → confirmed | rejected → requested (retry with corrected data) | not_applicable.';

-- ---------------------------------------------------------------- epd_flags (rule 7; never deleted)
CREATE TABLE epd_flags (
  flag_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  definition            text NOT NULL CHECK (definition IN ('fnma_e205_p1_3_60', 'sm_qc_p1_6_60', 'sm_watch_p1_6_30')),
  installment_no        int NOT NULL CHECK (installment_no BETWEEN 1 AND 6),
  installment_due_date  date NOT NULL,
  flagged_at            timestamptz NOT NULL,
  days_past_due_at_flag int NOT NULL CHECK (days_past_due_at_flag >= 0),
  basis                 text NOT NULL DEFAULT 'calendar_days_past_due' CHECK (basis IN ('calendar_days_past_due', 'fnma_month_bucket')),
  fnma_month_bucket     text,                                                    -- 5.1's month-bucket status recorded alongside for reconciliation
  raised_by_event_id    uuid REFERENCES loan_events(id),
  cleared_at            timestamptz,
  clear_reason          text CHECK (clear_reason IS NULL OR clear_reason IN ('payment', 'reversal', 'posting_error')),
  cleared_by_event_id   uuid REFERENCES loan_events(id),                         -- the ledger event — the agent cannot clear without one
  qc_review_id          uuid,                                                    -- 28.2 qc_reviews{kind='epd'}
  fraud_case_id         uuid,                                                    -- 28.4 (nullable)
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT epd_flags_e205_installments CHECK (definition <> 'fnma_e205_p1_3_60' OR installment_no <= 3),
  CONSTRAINT epd_flags_cleared_needs_ledger_event CHECK (cleared_at IS NULL OR (clear_reason IS NOT NULL AND cleared_by_event_id IS NOT NULL))
);
CREATE INDEX epd_flags_loan_idx ON epd_flags(loan_id, definition, installment_no);
CREATE INDEX epd_flags_open_idx ON epd_flags(definition) WHERE cleared_at IS NULL;
CREATE OR REPLACE FUNCTION epd_flags_history_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'epd_flags rows are never deleted (30.4 rule 7: flags are history)'; END IF;
  IF OLD.cleared_at IS NOT NULL AND (NEW.cleared_at IS DISTINCT FROM OLD.cleared_at OR NEW.clear_reason IS DISTINCT FROM OLD.clear_reason) THEN
    RAISE EXCEPTION 'a cleared epd_flags row is immutable';
  END IF;
  IF NEW.definition <> OLD.definition OR NEW.installment_no <> OLD.installment_no OR NEW.flagged_at <> OLD.flagged_at OR NEW.days_past_due_at_flag <> OLD.days_past_due_at_flag THEN
    RAISE EXCEPTION 'epd_flags raise facts are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER epd_flags_history_only BEFORE UPDATE OR DELETE ON epd_flags FOR EACH ROW EXECUTE FUNCTION epd_flags_history_only();
COMMENT ON TABLE epd_flags IS '30.4 rule 7: early-payment-default flags — E-2-05 (payments 1–3, 60+), 28.2 policy (payments 1–6, 60+) and the 30-day early warning; raised → cleared (payment/reversal/posting_error, always with the ledger event) | confirmed_to_qc; never deleted.';

-- ---------------------------------------------------------------- servicing_file_compilations (rule 9, §1024.38(c)(2))
CREATE TABLE servicing_file_compilations (
  compilation_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  kind                  text NOT NULL CHECK (kind IN ('boarding_test', 'borrower_request', 'regx_35_36', 'exam', 'litigation', 'fnma_lqc')),
  request_id            text,                                                    -- the `servicing_file.requested` id (null for the boarding test)
  requested_at          timestamptz NOT NULL,
  due_on                date NOT NULL,                                           -- requested_at + 5 calendar days (REGX_1024_38C2_SERVICING_FILE_5)
  completed_at          timestamptz,
  elapsed_seconds       numeric(12,3) CHECK (elapsed_seconds IS NULL OR elapsed_seconds >= 0),
  items                 jsonb NOT NULL DEFAULT '{}',                             -- (c)(2)(i)–(v): included / not applicable, document ids, row counts, hash
  package_document_id   uuid REFERENCES documents(id),                           -- documents{kind='servicing_file_package'}
  package_sha256        char(64),
  within_five_days      boolean,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT servicing_file_compilations_real_request CHECK (kind = 'boarding_test' OR request_id IS NOT NULL),
  CONSTRAINT servicing_file_compilations_completed CHECK (completed_at IS NULL OR (elapsed_seconds IS NOT NULL AND package_sha256 IS NOT NULL AND within_five_days IS NOT NULL))
);
CREATE INDEX servicing_file_compilations_loan_idx ON servicing_file_compilations(loan_id, kind, requested_at DESC);
COMMENT ON TABLE servicing_file_compilations IS '30.4 rule 9: every §1024.38(c)(2) compile — the boarding-day test (SM_SERVICING_FILE_COMPILE_TEST_1BD) proves the five-day capability and records elapsed_seconds; real requests run under REGX_1024_38C2_SERVICING_FILE_5 (five calendar days from receipt).';

-- ---------------------------------------------------------------- retention_schedule (rule 11)
CREATE TABLE retention_schedule (
  document_id               uuid PRIMARY KEY REFERENCES documents(id),
  loan_id                   uuid REFERENCES loans(id),
  application_id            uuid REFERENCES applications(id),
  retention_class           text NOT NULL CHECK (retention_class IN ('regz_le_3y', 'regz_cd_5y', 'regz_atr_3y', 'regz_loc_comp_3y', 'regz_general_2y', 'regb_25m', 'hmda_3y', 'respa_afba_5y', 'respa_s8_5y', 'fdpa_life_of_loan', 'fnma_loan_file_life_plus_4y', 'respa_servicing_1y_post', 'bsa_sar_5y', 'ofac_10y', 'esign_consent_life', 'fnma_accounting_report_18m') OR retention_class ~ '^ron_recording_state_[0-9]+y$'),
  governing_class           text,                                                -- the longest applicable class (the CD: fnma_loan_file_life_plus_4y over regz_cd_5y)
  anchor_event              text NOT NULL CHECK (anchor_event IN ('consummation', 'action_taken_notice', 'hmda_submission', 'afba_execution', 'sar_filing', 'liquidation', 'servicing_transfer', 'discharge', 'compensation_payment', 'ofac_screening', 'ron_session', 'report_filing')),
  anchor_date               date NOT NULL,
  class_until               date,                                                -- the class's own end (LE 2029-11-06; CD 2031-11-06)
  retention_until           date,                                                -- computed; NULL = life/permanent until a liquidation anchor exists
  legal_hold                boolean NOT NULL DEFAULT false,                      -- litigation, exam, LQC case: suspends purge
  jurisdiction_extension_days int NOT NULL DEFAULT 0 CHECK (jurisdiction_extension_days >= 0),
  purge_floor               date,                                                -- nothing purged automatically before Jan 1 of consummation year + 5
  computed_at               timestamptz NOT NULL DEFAULT now(),
  rule_version              text NOT NULL,                                       -- rule_sets.retention.<version>
  CONSTRAINT retention_schedule_until_after_anchor CHECK (retention_until IS NULL OR retention_until >= anchor_date)
);
CREATE INDEX retention_schedule_until_idx ON retention_schedule(retention_until) WHERE retention_until IS NOT NULL AND legal_hold = false;
CREATE INDEX retention_schedule_loan_idx ON retention_schedule(loan_id);
COMMENT ON TABLE retention_schedule IS '30.4 rule 11: class + anchor + computed retention_until per indexed origination document (Reg Z §1026.25, Reg B §1002.12, Reg C §1003.5, RESPA §1024.15, FDPA, BSA, E-SIGN, A2-4.1-02); recomputed on liquidation/transfer; the 18.x purge job reads it; a shorter rule never shortens an existing retention_until without compliance sign-off.';

-- ---------------------------------------------------------------- additive columns on baseline tables (spec "Columns added")
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS handoff_status                  text CHECK (handoff_status IS NULL OR handoff_status IN ('open', 'complete', 'complete_with_exceptions', 'closed', 'reopened')),
  ADD COLUMN IF NOT EXISTS epd_watch_until                 date,                  -- sixth scheduled due date + 60 calendar days
  ADD COLUMN IF NOT EXISTS epd_fnma_e205                   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS epd_qc_policy                   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS servicing_file_last_compiled_at timestamptz;
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS retention_anchor_date date,
  ADD COLUMN IF NOT EXISTS retention_until       date;                            -- NULL = life/permanent until a liquidation anchor exists
COMMENT ON COLUMN loans.epd_watch_until IS '30.4 rule 7: the SM_ORIG_EPD_WATCH_P6_60 window end (sixth scheduled due date + 60 calendar days).';
COMMENT ON COLUMN documents.retention_until IS '30.4 rule 11: mirror of retention_schedule.retention_until for the purge job; NULL = life/permanent.';

COMMIT;
