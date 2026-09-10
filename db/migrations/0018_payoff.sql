-- 0018_payoff.sql — Section 16 (16.1–16.4): payoff quotes, statements (fixed), wire instructions, funds, settlements, housekeeping, lien release, MERS deactivation.
BEGIN;

CREATE TABLE payoff_wire_instructions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custodial_account_id  uuid REFERENCES custodial_accounts(id),
  bank_name             text NOT NULL,
  aba_encrypted         bytea NOT NULL,
  account_encrypted     bytea NOT NULL,
  account_last4         char(4) NOT NULL,
  beneficiary_name      text NOT NULL,
  reference_format      text,
  effective_from        date NOT NULL,
  approved_by_officer_id text NOT NULL,
  second_approver_id    text,
  attestation_document_id uuid REFERENCES documents(id),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired'))
);
COMMENT ON COLUMN payoff_wire_instructions.aba_encrypted IS 'pii';
COMMENT ON COLUMN payoff_wire_instructions.account_encrypted IS 'pii';

CREATE TABLE payoff_quotes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  request_id            uuid REFERENCES payoff_requests(id),
  quote_type            text NOT NULL CHECK (quote_type IN ('statement','oral','portal','internal','updated')),
  calc_at               timestamptz NOT NULL DEFAULT now(),
  ledger_snapshot_id    uuid,
  good_through          date NOT NULL,
  accrual_start         date NOT NULL,
  days_partial          int NOT NULL,
  months_full           int NOT NULL,
  rate_segments         jsonb NOT NULL DEFAULT '[]',
  upb_cents             bigint NOT NULL,
  interest_full_months_cents bigint NOT NULL DEFAULT 0,
  interest_partial_cents bigint NOT NULL DEFAULT 0,
  per_diem_cents        bigint NOT NULL,
  nib_deferred_cents    bigint NOT NULL DEFAULT 0,
  nib_forborne_cents    bigint NOT NULL DEFAULT 0,
  late_charges_cents    bigint NOT NULL DEFAULT 0,
  nsf_fees_cents        bigint NOT NULL DEFAULT 0,
  other_fees            jsonb NOT NULL DEFAULT '{}',
  corporate_advances_cents bigint NOT NULL DEFAULT 0,
  escrow_advance_cents  bigint NOT NULL DEFAULT 0,
  recording_fee_cents   bigint NOT NULL DEFAULT 0,
  release_fee_third_party_cents bigint NOT NULL DEFAULT 0,
  prepayment_premium_cents bigint NOT NULL DEFAULT 0 CHECK (prepayment_premium_cents = 0),
  buydown_credit_cents  bigint NOT NULL DEFAULT 0,
  suspense_credit_cents bigint NOT NULL DEFAULT 0,
  mi_proration_cents    bigint NOT NULL DEFAULT 0,
  escrow_balance_cents  bigint NOT NULL DEFAULT 0,
  escrow_treatment      text NOT NULL DEFAULT 'refund_separately' CHECK (escrow_treatment IN ('refund_separately','net_credit')),
  hsa_note_flag         boolean NOT NULL DEFAULT false,
  scra_rate_applied     boolean NOT NULL DEFAULT false,
  bk_components         jsonb,
  fcl_components        jsonb,
  total_cents           bigint NOT NULL,
  alt_figures           jsonb,
  calc_version          text NOT NULL,
  rule_set              text NOT NULL,
  hash                  text NOT NULL,
  superseded_by_id      uuid REFERENCES payoff_quotes(id),
  reason                text
);
CREATE INDEX payoff_quotes_loan_idx ON payoff_quotes(loan_id, calc_at);
-- append-only except the supersession back-link
CREATE OR REPLACE FUNCTION payoff_quotes_supersede_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hash <> OLD.hash OR NEW.total_cents <> OLD.total_cents OR NEW.good_through <> OLD.good_through THEN RAISE EXCEPTION 'payoff_quotes are append-only; issue an updated quote'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payoff_quotes_supersede_only BEFORE UPDATE ON payoff_quotes FOR EACH ROW EXECUTE FUNCTION payoff_quotes_supersede_only();
CREATE TRIGGER payoff_quotes_no_delete BEFORE DELETE ON payoff_quotes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE payoff_requests ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES payoff_quotes(id);
ALTER TABLE payoff_requests ADD COLUMN IF NOT EXISTS channel_metadata jsonb;
-- 7.6 payoff_statements: 16.1 fixes the shape
ALTER TABLE payoff_statements
  ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES payoff_quotes(id),
  ADD COLUMN IF NOT EXISTS template_code text,
  ADD COLUMN IF NOT EXISTS state_variant text,
  ADD COLUMN IF NOT EXISTS wire_instruction_version_id uuid REFERENCES payoff_wire_instructions(id),
  ADD COLUMN IF NOT EXISTS verification_token char(12),
  ADD COLUMN IF NOT EXISTS delivered_to jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS valid_until date,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'rendered' CHECK (status IN ('rendered','sent','superseded','expired','relied_upon','closed'));
ALTER TABLE jurisdiction_rules ADD COLUMN IF NOT EXISTS payoff jsonb;

-- 16.2
CREATE TABLE payoff_funds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  quote_id              uuid REFERENCES payoff_quotes(id),
  payment_id            uuid REFERENCES payments(id),
  received_at           timestamptz NOT NULL,
  credited_as_of        date NOT NULL,
  method                text NOT NULL CHECK (method IN ('wire','ach_credit','ach_debit','cashiers_check','certified_check','check','internal_transfer','closing_agent_wire')),
  amount_cents          bigint NOT NULL,
  source_party_id       uuid REFERENCES parties(id),
  bank_reference        text,
  cleared_at            timestamptz,
  settlement_date       date,
  status                text NOT NULL DEFAULT 'received' CHECK (status IN ('received','held','cleared','applied','short_suspense','over_pending_refund','reversed')),
  variance_cents        bigint,
  variance_reason       text
);
CREATE TABLE payoff_settlements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL UNIQUE REFERENCES loans(id),
  payoff_date           date NOT NULL,
  processed_at          timestamptz NOT NULL DEFAULT now(),
  remittance_type       remittance_type NOT NULL,
  participation_pct     numeric(9,6) NOT NULL DEFAULT 100,
  upb_cents             bigint NOT NULL,
  nib_cents             bigint NOT NULL DEFAULT 0,
  interest_note_rate_cents bigint NOT NULL,
  interest_ptr_cents    bigint NOT NULL,
  servicing_fee_cents   bigint NOT NULL DEFAULT 0,
  ss_interest_gap_cents bigint NOT NULL DEFAULT 0,
  fees_collected        jsonb NOT NULL DEFAULT '{}',
  advances_recovered_cents bigint NOT NULL DEFAULT 0,
  fnma_advance_repay_cents bigint NOT NULL DEFAULT 0,
  buydown_remit_cents   bigint NOT NULL DEFAULT 0,
  escrow_balance_cents  bigint NOT NULL DEFAULT 0,
  shortage_cents        bigint NOT NULL DEFAULT 0,
  shortage_disposition  text NOT NULL DEFAULT 'none' CHECK (shortage_disposition IN ('none','borrower_collected','servicer_absorbed','reliance_absorbed','waived_tolerance')),
  overage_cents         bigint NOT NULL DEFAULT 0,
  overage_refund_disbursement_id uuid REFERENCES disbursements(id),
  remittance_id         uuid REFERENCES remittances(id),
  removal_event_id      uuid REFERENCES investor_events(id),
  finality_at           timestamptz,
  status                text NOT NULL DEFAULT 'open'
);
CREATE TABLE payoff_housekeeping_tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id         uuid NOT NULL REFERENCES payoff_settlements(id),
  task                  text NOT NULL CHECK (task IN ('escrow_refund','short_year_statement','mi_notify','insurance_interest_remove','lpi_cancel','tax_authority_notify','tax_service_delete','credit_report_paid','form_1098_tag','autodraft_stop','fnma_advance_repay','buydown_apply','paid_in_full_letter','records_retention_start','enote_paper_copy','custody_docs_request')),
  owner_agent           text NOT NULL,
  due_at                timestamptz,
  timer_id              uuid REFERENCES timers(id),
  status                text NOT NULL DEFAULT 'open',
  completed_at          timestamptz,
  evidence_document_id  uuid REFERENCES documents(id),
  UNIQUE (settlement_id, task)
);

-- 16.3
CREATE TABLE signing_officers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id             uuid REFERENCES personnel(id),
  authority             text NOT NULL CHECK (authority IN ('mers_signing_officer_partner_resolution','mers_signing_officer_supermortgage_resolution','lpoa_attorney_in_fact','partner_officer')),
  resolution_reference  text,
  valid_from            date NOT NULL,
  valid_to              date,
  notary_commissions    jsonb NOT NULL DEFAULT '[]',
  ron_enabled           boolean NOT NULL DEFAULT false
);
CREATE TABLE lpoas (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state                 char(2) NOT NULL,
  grantee               text NOT NULL CHECK (grantee IN ('partner','supermortgage')),
  scope                 text[] NOT NULL DEFAULT '{}',
  executed_at           date,
  recorded_at           date,
  recording_reference   text,
  document_id           uuid REFERENCES documents(id),
  status                text NOT NULL DEFAULT 'active'
);
CREATE TABLE custody_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  custodian_id          uuid REFERENCES parties(id),
  form                  text NOT NULL DEFAULT '2009',
  documents_requested   text[] NOT NULL DEFAULT '{}',
  sent_at               timestamptz,
  received_at           timestamptz,
  returned_to_custodian_at timestamptz,
  status                text NOT NULL DEFAULT 'open'
);
CREATE TABLE release_tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  settlement_id         uuid REFERENCES payoff_settlements(id),
  release_kind          text,
  state                 char(2) NOT NULL,
  county                text,
  recording_office_id   text,
  security_instrument_document_id uuid REFERENCES documents(id),
  instrument_type       text CHECK (instrument_type IN ('satisfaction_of_mortgage','release_of_mortgage','discharge_of_mortgage','certificate_of_discharge','certificate_of_satisfaction','cancellation_of_security_deed','release_of_lien','deed_of_release_and_reconveyance','request_for_full_reconveyance','substitution_of_trustee_and_full_reconveyance','request_for_release_public_trustee','satisfaction_piece','ucc3_termination')),
  mortgagee_of_record   text CHECK (mortgagee_of_record IN ('mers','fannie_mae','partner','supermortgage','prior_lender_unassigned','other')),
  signatory_path        text CHECK (signatory_path IN ('mers_signing_officer','lpoa_attorney_in_fact','fnma_execution','partner_officer','trustee_third_party')),
  min                   char(18),
  fnma_loan_number      char(10),
  deadline_at           date NOT NULL,
  statutory_anchor      text,
  original_note_required boolean NOT NULL DEFAULT false,
  custody_request_id    uuid REFERENCES custody_requests(id),
  prepared_at           timestamptz,
  document_id           uuid REFERENCES documents(id),
  executed_at           timestamptz,
  signing_officer_id    uuid REFERENCES signing_officers(id),
  notarized_at          timestamptz,
  ron                   boolean NOT NULL DEFAULT false,
  submitted_at          timestamptz,
  submission_id         uuid,
  recorded_at           timestamptz,
  recording_reference   text,
  recorded_document_id  uuid REFERENCES documents(id),
  borrower_notified_at  timestamptz,
  note_returned_at      timestamptz,
  status                text NOT NULL DEFAULT 'open',
  penalty_exposure_cents bigint NOT NULL DEFAULT 0
);
CREATE TABLE recording_submissions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_task_id       uuid NOT NULL REFERENCES release_tasks(id),
  channel               text NOT NULL CHECK (channel IN ('simplifile','csc','epn','paper_mail','walk_in')),
  vendor_package_id     text,
  pria_version          text,
  submitted_at          timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','accepted','rejected','recorded','returned','cancelled')),
  reject_code           text,
  reject_text           text,
  fees_cents            bigint NOT NULL DEFAULT 0,
  recorded_at           timestamptz,
  recording_reference   text,
  image_document_id     uuid REFERENCES documents(id)
);
ALTER TABLE release_tasks ADD CONSTRAINT release_tasks_submission_fk FOREIGN KEY (submission_id) REFERENCES recording_submissions(id);

-- 16.4 (mers_transactions is created in the transfers migration; eRegistry table here)
CREATE TABLE mers_eregistry_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  min                   char(18) NOT NULL,
  enote_id              text,
  txn_type              text NOT NULL CHECK (txn_type IN ('change_status_paid_off','registration_deactivation','change_status_reversal')),
  requested_at          timestamptz NOT NULL,
  requested_via         text NOT NULL CHECK (requested_via IN ('evault_api','fnma_request','ui')),
  controller_org_id     char(7),
  status                text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted','rejected','confirmed')),
  ack_reference         text,
  evidence_document_id  uuid REFERENCES documents(id)
);

COMMIT;
