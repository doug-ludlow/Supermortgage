-- 0019_transfers.sql — Sections 1.2–1.7 (transfer-in) and 17.1–17.4 (transfer-out): batch approvals, RESPA notices, custody, MERS, reconciliation, in-flight loss-mit, deliverables, counterparties, archives.
BEGIN;

-- 1.2 / 17.1 transfer_batches additions
ALTER TYPE transfer_type ADD VALUE IF NOT EXISTS 'sub_to_master';
ALTER TYPE transfer_type ADD VALUE IF NOT EXISTS 'servicing_sale';
ALTER TYPE transfer_type ADD VALUE IF NOT EXISTS 'fnma_directed';
ALTER TYPE transfer_type ADD VALUE IF NOT EXISTS 'master_change_sub_retained';
ALTER TABLE transfer_batches
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  ADD COLUMN IF NOT EXISTS form629_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS custodian_matrix_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS form629_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS form629_submitted_by text,
  ADD COLUMN IF NOT EXISTS fnma_status text NOT NULL DEFAULT 'draft' CHECK (fnma_status IN ('draft','submitted','info_requested','approved','denied','withdrawn')),
  ADD COLUMN IF NOT EXISTS fnma_conditions jsonb,
  ADD COLUMN IF NOT EXISTS subservicer_indicated boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS purchase_price_bps numeric(8,4),
  ADD COLUMN IF NOT EXISTS form101_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS form1013_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS form1014_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS form2017_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS liability_start_date date,
  ADD COLUMN IF NOT EXISTS transferee_party_id uuid REFERENCES parties(id),
  ADD COLUMN IF NOT EXISTS transferee_servicer_number char(9),
  ADD COLUMN IF NOT EXISTS transferee_subservicer_party_id uuid REFERENCES parties(id),
  ADD COLUMN IF NOT EXISTS termination_basis text CHECK (termination_basis IN ('partner_instruction','fnma_without_cause','fnma_for_cause','partner_voluntary_termination','supermortgage_exit','sale')),
  ADD COLUMN IF NOT EXISTS fnma_notice_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS sale_agreement_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS fee_settlement jsonb,
  ADD COLUMN IF NOT EXISTS qx_request_id text,
  ADD COLUMN IF NOT EXISTS qx_status text,
  ADD COLUMN IF NOT EXISTS approval_letter_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS d_code text,
  ADD COLUMN IF NOT EXISTS attested_at timestamptz,
  ADD COLUMN IF NOT EXISTS attested_by text,
  ADD COLUMN IF NOT EXISTS form101_termination_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS form582_reflected_at timestamptz;
ALTER TABLE transfer_batch_loans
  ADD COLUMN IF NOT EXISTS offboarding_status text CHECK (offboarding_status IN ('listed','frozen','packaged','cutover','support_window','retained','withdrawn')),
  ADD COLUMN IF NOT EXISTS transferee_loan_number text;
CREATE TABLE transfer_batch_loan_list_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES transfer_batches(id),
  version               int NOT NULL,
  document_id           uuid REFERENCES documents(id),
  adds                  int NOT NULL DEFAULT 0,
  deletes               int NOT NULL DEFAULT 0,
  submitted_at          timestamptz,
  reason                text,
  UNIQUE (batch_id, version)
);
CREATE TRIGGER transfer_batch_loan_list_versions_immutable BEFORE UPDATE OR DELETE ON transfer_batch_loan_list_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE escalations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL,                             -- human_portal_task | officer | attorney | sev1 | sev2 | ...
  loan_id               uuid REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  batch_id              uuid REFERENCES transfer_batches(id),
  severity              text,
  owner_role            text,
  package_document_id   uuid REFERENCES documents(id),
  sla_timer_id          uuid REFERENCES timers(id),
  opened_at             timestamptz NOT NULL DEFAULT now(),
  opened_by             text NOT NULL,
  completed_at          timestamptz,
  completed_evidence_document_id uuid REFERENCES documents(id),
  payload               jsonb NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'open'
);
CREATE INDEX escalations_open_idx ON escalations(status, kind) WHERE status = 'open';

-- 1.3 / 17.2 notices, misdirected payments, loan columns
CREATE TABLE transfer_notice_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES transfer_batches(id),
  kind                  text NOT NULL CHECK (kind IN ('goodbye','hello','combined','corrective','short_year_escrow','final_statement')),
  due_at                date NOT NULL,
  render_count          int NOT NULL DEFAULT 0,
  qc_pass_count         int NOT NULL DEFAULT 0,
  mailed_count          int NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'planned'
);
CREATE TABLE misdirected_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  direction             text NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  received_by           text NOT NULL CHECK (received_by IN ('transferor','supermortgage','transferee')),
  transferor_received_at date,
  received_at           timestamptz,
  amount_cents          bigint NOT NULL,
  instrument            text CHECK (instrument IN ('check','ach','card','wire','cash')),
  forwarded_at          timestamptz,
  forward_reference     text,
  received_by_transferee_at timestamptz,
  transferee_ack_at     timestamptz,
  payment_id            uuid REFERENCES payments(id),
  protected             boolean NOT NULL DEFAULT false,
  disposition           text CHECK (disposition IN ('forwarded','returned_to_payor')),
  return_notice_id      uuid REFERENCES notices(id)
);
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS respa_effective_date date,
  ADD COLUMN IF NOT EXISTS transfer_window_end_date date,
  ADD COLUMN IF NOT EXISTS transfer_out_at date,
  ADD COLUMN IF NOT EXISTS transferee_party_id uuid REFERENCES parties(id),
  ADD COLUMN IF NOT EXISTS transferee_loan_number text,
  ADD COLUMN IF NOT EXISTS transferee_contact jsonb,
  ADD COLUMN IF NOT EXISTS transferee_remittance_address jsonb;
ALTER TYPE loan_status ADD VALUE IF NOT EXISTS 'transferred_out';

-- 1.4 custody
CREATE TABLE custody_records (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  custodian_party_id    uuid REFERENCES parties(id),
  custodian_fin         text,
  form_2017_document_id uuid REFERENCES documents(id),
  certification_status  text NOT NULL DEFAULT 'certified_transferor' CHECK (certification_status IN ('certified_transferor','recert_pending','recert_complete','exception','released')),
  note_location         text CHECK (note_location IN ('custodian','released_form_2009','fnma_evault')),
  d_code                text,
  code_type             text CHECK (code_type IN ('D','I','C','none')),
  released_at           timestamptz,
  release_reason        text,
  expected_return_at    date,
  sfc_508               boolean NOT NULL DEFAULT false
);
CREATE TABLE custody_recerts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES transfer_batches(id),
  custodian_party_id    uuid REFERENCES parties(id),
  code_type             text,
  ted                   date,
  trial_balance_sent_at timestamptz,
  first_docs_received_at timestamptz,
  start_file_ack_at     timestamptz,
  complete_file_ack_at  timestamptz,
  exception_count       int NOT NULL DEFAULT 0,
  extension_requested_at timestamptz,
  extension_until       date,
  status                text NOT NULL DEFAULT 'open'
);
CREATE TABLE custody_exceptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  kind                  text NOT NULL CHECK (kind IN ('missing_note','missing_mortgage','endorsement_break','allonge_missing','poa_missing','assignment_missing','data_mismatch','form_2009_missing')),
  raised_by             text NOT NULL CHECK (raised_by IN ('custodian','agent')),
  raised_at             timestamptz NOT NULL DEFAULT now(),
  notified_transferor_at timestamptz,
  resolved_at           timestamptz,
  resolution            text,
  evidence_document_id  uuid REFERENCES documents(id)
);
CREATE TRIGGER custody_exceptions_immutable BEFORE DELETE ON custody_exceptions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE enotes (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  min                   char(18) NOT NULL,
  controller            text NOT NULL DEFAULT 'FNMA',
  location              text NOT NULL DEFAULT 'FNMA',
  servicing_agent_org_id char(7),
  delegatee_org_id      char(7),
  evault_reference      text,
  enote_copy_document_id uuid REFERENCES documents(id),
  attribution_evidence_document_id uuid REFERENCES documents(id),
  audit_trail_document_id uuid REFERENCES documents(id),
  eregistry_verified_at timestamptz
);

-- 1.5 / 16.4 MERS
CREATE TABLE mers_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid REFERENCES transfer_batches(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  min                   char(18) NOT NULL,
  txn_type              text NOT NULL CHECK (txn_type IN ('min_update_subservicer','tos_initiate','tos_confirm','tob_confirm','registration','deactivation','min_update_other','deactivation_paid_in_full','deactivation_reversal')),
  effective_date        date,
  submitted_at          timestamptz,
  submitted_by_org_id   char(7),
  channel               text CHECK (channel IN ('flat_file','xml','ui')),
  status                text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','submitted','accepted','rejected','confirmed','cancelled')),
  mers_reject_code      text,
  file_document_id      uuid REFERENCES documents(id),
  reason_code           text,
  release_task_id       uuid REFERENCES release_tasks(id),
  release_recorded_at   timestamptz,
  recording_reference   text,
  verified_snapshot_id  uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER mers_transactions_no_delete BEFORE DELETE ON mers_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE mers_min_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  min                   char(18) NOT NULL,
  as_of                 timestamptz NOT NULL,
  status                text NOT NULL,
  servicer_org_id       char(7),
  subservicer_org_id    char(7),
  investor_org_id       char(7),
  note_owner_org_id     char(7),
  registration_date     date,
  mom                   boolean,
  source                text NOT NULL CHECK (source IN ('mers_batch','mers_link','mre'))
);
ALTER TABLE mers_transactions ADD CONSTRAINT mers_transactions_snapshot_fk FOREIGN KEY (verified_snapshot_id) REFERENCES mers_min_snapshots(id);
CREATE TABLE mers_qa_findings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('mre_mismatch','violation_notice','annual_report_exception')),
  min                   char(18),
  raised_at             timestamptz NOT NULL DEFAULT now(),
  due_at                timestamptz,
  resolved_at           timestamptz,
  detail                jsonb
);
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS mers_registered boolean,
  ADD COLUMN IF NOT EXISTS mers_servicer_org_id char(7),
  ADD COLUMN IF NOT EXISTS mers_subservicer_org_id char(7);

-- 1.6 / 17.3 reconciliation
ALTER TYPE reconciliation_kind ADD VALUE IF NOT EXISTS 'boarding_loan_level';
ALTER TYPE reconciliation_kind ADD VALUE IF NOT EXISTS 'boarding_wire_pi';
ALTER TYPE reconciliation_kind ADD VALUE IF NOT EXISTS 'boarding_wire_ti';
ALTER TYPE reconciliation_kind ADD VALUE IF NOT EXISTS 'boarding_wire_other';
ALTER TYPE reconciliation_kind ADD VALUE IF NOT EXISTS 'boarding_fnma_position';
ALTER TYPE reconciliation_kind ADD VALUE IF NOT EXISTS 'boarding_final_accounting';
ALTER TYPE reconciliation_kind ADD VALUE IF NOT EXISTS 'transfer_out_loan_level';
ALTER TYPE reconciliation_kind ADD VALUE IF NOT EXISTS 'transfer_out_wire_pi';
ALTER TYPE reconciliation_kind ADD VALUE IF NOT EXISTS 'transfer_out_wire_ti';
ALTER TYPE reconciliation_kind ADD VALUE IF NOT EXISTS 'transfer_out_fnma_position';
ALTER TYPE reconciliation_kind ADD VALUE IF NOT EXISTS 'transfer_out_final_accounting';
ALTER TABLE reconciliations
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES transfer_batches(id),
  ADD COLUMN IF NOT EXISTS scope text,
  ADD COLUMN IF NOT EXISTS source_a text,
  ADD COLUMN IF NOT EXISTS source_b text;
ALTER TABLE reconciliations ALTER COLUMN custodial_account_id DROP NOT NULL;
CREATE TABLE recon_variances (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id     uuid NOT NULL REFERENCES reconciliations(id),
  loan_id               uuid REFERENCES loans(id),
  field                 text NOT NULL,
  value_tape            bigint,
  value_trial_balance   bigint,
  value_fnma            bigint,
  value_wire            bigint,
  difference_cents      bigint NOT NULL,
  category              text CHECK (category IN ('timing_in_transit','transferor_error','mapping_error','fnma_reporting_lag','unknown')),
  owner                 text,
  sla_timer_id          uuid REFERENCES timers(id),
  resolved_at           timestamptz,
  resolution            text CHECK (resolution IN ('transferor_corrected','adjusted_with_evidence','absorbed_by_transferor','absorbed_by_supermortgage','written_off_officer')),
  evidence_document_id  uuid REFERENCES documents(id)
);
CREATE TRIGGER recon_variances_no_delete BEFORE DELETE ON recon_variances FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE transfer_funds_receipts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES transfer_batches(id),
  custodial_account_id  uuid REFERENCES custodial_accounts(id),
  kind                  text NOT NULL CHECK (kind IN ('pi_unremitted','unapplied','escrow','loss_draft','buydown','mi_accrual','interim_forwarded_payments','advance_reimbursement_out')),
  expected_cents        bigint NOT NULL,
  received_cents        bigint,
  received_at           timestamptz,
  wire_reference        text,
  matched_at            timestamptz,
  variance_id           uuid REFERENCES recon_variances(id)
);
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS source text;

-- 1.7 / 17.4 in-flight loss mitigation
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS origin text CHECK (origin IN ('borrower','transferor')),
  ADD COLUMN IF NOT EXISTS transferor_received_at date,
  ADD COLUMN IF NOT EXISTS subject_to_1024_41_at_transferor boolean,
  ADD COLUMN IF NOT EXISTS completeness_status text CHECK (completeness_status IN ('incomplete','facially_complete','complete')),
  ADD COLUMN IF NOT EXISTS facially_complete_at timestamptz,
  ADD COLUMN IF NOT EXISTS complete_at timestamptz,
  ADD COLUMN IF NOT EXISTS transferor_ack_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS transferor_reasonable_date date,
  ADD COLUMN IF NOT EXISTS transferor_determination jsonb,
  ADD COLUMN IF NOT EXISTS appeal_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS appeal_received_by text CHECK (appeal_received_by IN ('transferor','transferee')),
  ADD COLUMN IF NOT EXISTS offer jsonb,
  ADD COLUMN IF NOT EXISTS borrower_response text CHECK (borrower_response IN ('none','accepted','rejected')),
  ADD COLUMN IF NOT EXISTS trial_plan jsonb,
  ADD COLUMN IF NOT EXISTS forbearance_history jsonb,
  ADD COLUMN IF NOT EXISTS deemed_received_at date,
  ADD COLUMN IF NOT EXISTS evaluated_options jsonb,
  ADD COLUMN IF NOT EXISTS carryover_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS handoff_status text,
  ADD COLUMN IF NOT EXISTS transferred_out_at timestamptz;
ALTER TABLE timers ADD COLUMN IF NOT EXISTS owner_after_transfer text CHECK (owner_after_transfer IN ('transferee','supermortgage'));
CREATE TABLE lossmit_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES cases(id),
  document_id           uuid NOT NULL REFERENCES documents(id),
  received_by           text NOT NULL CHECK (received_by IN ('transferor','transferee')),
  received_at           timestamptz NOT NULL,
  kind                  text
);
CREATE TABLE lossmit_carryover_checks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES cases(id),
  check_code            text NOT NULL,
  result                text NOT NULL CHECK (result IN ('pass','fail','n_a')),
  requested_from_transferor_at timestamptz,
  resolved_at           timestamptz,
  evidence_document_id  uuid REFERENCES documents(id),
  at                    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER lossmit_carryover_checks_immutable BEFORE UPDATE OR DELETE ON lossmit_carryover_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE lossmit_handoff_checks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES cases(id),
  check_code            text NOT NULL,
  result                text NOT NULL CHECK (result IN ('pass','fail','n_a')),
  evidence_document_id  uuid REFERENCES documents(id),
  at                    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER lossmit_handoff_checks_immutable BEFORE UPDATE OR DELETE ON lossmit_handoff_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE case_handoffs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES transfer_batches(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid NOT NULL REFERENCES cases(id),
  case_type             text NOT NULL,
  snapshot_as_of        timestamptz NOT NULL,
  checklist             jsonb NOT NULL DEFAULT '[]',
  deadline_table        jsonb NOT NULL DEFAULT '[]',
  package_document_id   uuid REFERENCES documents(id),
  delivered_at          timestamptz,
  acked_at              timestamptz,
  status                text NOT NULL DEFAULT 'inventoried' CHECK (status IN ('inventoried','packaged','delivered','acked','deficient','resolved'))
);
CREATE TABLE post_transfer_forwardings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  received_at           timestamptz NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('lossmit_document','appeal','acceptance','rejection','correspondence','counsel_notice','trustee_payment','insurer_check','other')),
  forwarded_at          timestamptz,
  transferee_ack_at     timestamptz,
  document_id           uuid REFERENCES documents(id)
);

-- 17.3 deliverables
CREATE TABLE transfer_out_deliverables (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES transfer_batches(id),
  kind                  text NOT NULL,                             -- D01…D34
  as_of                 date,
  format                text CHECK (format IN ('mismo_xml','csv','pdf_bundle','image_index','json')),
  document_id           uuid REFERENCES documents(id),
  row_count             int,
  generated_at          timestamptz,
  validated_at          timestamptz,
  attested_at           timestamptz,
  delivered_at          timestamptz,
  delivery_channel      text CHECK (delivery_channel IN ('sftp','edelivery_mers','custodian_portal','email','portal')),
  acked_at              timestamptz,
  ack_reference         text,
  status                text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','generated','validated','attested','delivered','acked','exception','resolved')),
  recipient             text NOT NULL CHECK (recipient IN ('transferee','transferee_custodian','transferor_custodian','fnma','mi','insurer','vendor','law_firm','trustee'))
);
CREATE TABLE transfer_out_attestations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES transfer_batches(id),
  deliverable_id        uuid REFERENCES transfer_out_deliverables(id),
  dq_scorecard_document_id uuid REFERENCES documents(id),
  tie_outs              jsonb NOT NULL,
  attested_by           text NOT NULL,
  attested_at           timestamptz NOT NULL DEFAULT now(),
  statement_text_version text
);
CREATE TABLE counterparty_notifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES transfer_batches(id),
  loan_id               uuid REFERENCES loans(id),
  party_type            text NOT NULL,
  party_id              uuid REFERENCES parties(id),
  kind                  text NOT NULL CHECK (kind IN ('transfer_notice','endorsement_request','continue_or_discontinue','payment_address_change','servicing_agent_update','min_update','deactivation','final_cycle','account_closure')),
  due_at                timestamptz,
  sent_at               timestamptz,
  channel               text,
  document_id           uuid REFERENCES documents(id),
  acked_at              timestamptz,
  status                text NOT NULL DEFAULT 'planned'
);
CREATE TABLE transferee_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES transfer_batches(id),
  loan_id               uuid REFERENCES loans(id),
  received_at           timestamptz NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('missing_document','data_question','lossmit_document','payment_research','complaint_research','noe_rfi_research')),
  due_at                timestamptz NOT NULL,
  responded_at          timestamptz,
  response_document_id  uuid REFERENCES documents(id),
  status                text NOT NULL DEFAULT 'open'
);
CREATE TABLE transfer_out_archives (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  batch_id              uuid NOT NULL REFERENCES transfer_batches(id),
  archive_manifest_document_id uuid REFERENCES documents(id),
  retention             retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  retain_until          date,
  legal_hold            boolean NOT NULL DEFAULT false,
  deidentified_at       timestamptz
);

COMMIT;
