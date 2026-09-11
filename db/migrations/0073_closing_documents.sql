-- 0073_closing_documents.sql — §26.1 closing document generation and closing instructions
-- (spec/sections/26-closing-execution-documents-eclosing-ron-funding-and-post-cl/26-1-*.md; addendum §3 "Closing and funding").
-- 26.1's own tables (document_templates, closing_data_snapshots, closing_document_sets, document_qc_checks, closing_instructions,
-- tx_home_equity_reviews, buydown_agreements, cema_packages) plus the shared closing tables the addendum names and no earlier
-- migration created: `closings` (26.2 executes; 26.1 sets document_set_id) and `closing_documents` (template version, data hash,
-- signed document id — 30.2's OB-002 compares the mapped note terms' hash to `closing_documents.data_hash`). Additive only:
-- `applications` (0057), `documents` / `parties` (0001), `escalations` (0019) are referenced, never altered.
BEGIN;

ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'fnma_loan_file_life_plus_4y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'fnma_enote_signing_life_plus_7y';

-- ---------------------------------------------------------------- document_templates (the versioned uniform-instrument library)
CREATE TABLE document_templates (
  template_id                 text PRIMARY KEY,                                   -- '<form>:<revision>', e.g. '3003:2021-07', '3047:2026-05'
  form_number                 text NOT NULL,                                      -- 3200, 3200e, 3003, 3044.1, 3140, 3158, 3172, 3185, 3441, 3442, SM_CLOSING_INSTRUCTIONS …
  family                      text NOT NULL CHECK (family IN ('note', 'enote', 'security_instrument', 'rider', 'addendum', 'special_purpose', 'affidavit', 'notice', 'closing_instruction', 'closing_receipt', 'allonge', 'urla')),
  state                       char(2),                                            -- null = multistate
  product_scope               text[] NOT NULL DEFAULT '{fixed}',                  -- fixed, arm plan list, home_equity_tx, cema_ny
  revision_date               text NOT NULL,                                      -- footer, e.g. '07/2021'
  revision_family             text NOT NULL,                                      -- '2021' — mixing families is a nonstandard document (Fact Sheet Jan 2023)
  mandatory_from              date,
  retired_after               date,
  authorized_changes_applied  jsonb NOT NULL DEFAULT '[]',                        -- per-state changes with the instruction paragraph number
  smart_doc_profile           text NOT NULL DEFAULT 'none' CHECK (smart_doc_profile IN ('none', 'v1_0_2_cat1_closing_dtd_2_3_1')),
  source_url                  text,
  source_hash                 char(64),
  counsel_approval_id         text,
  status                      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'active', 'retired')),
  retention_class             retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE document_templates IS '26.1: the Fannie Mae/Freddie Mac uniform-instrument template library (07/2021 family with dated state revisions — VA 3047 2026-07-01, CA 3005 2027-01-01, MD 3021 2025-10-01), eNote SMART Doc templates and SM closing forms; an instrument renders only from an active template whose mandatory/retired window contains the note date; any version ever used is retained fnma_loan_file_life_plus_4y.';
CREATE INDEX document_templates_form_idx ON document_templates(form_number, state, status);
CREATE TRIGGER document_templates_no_delete BEFORE DELETE ON document_templates FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- closings (addendum §3; 26.2 executes, 26.1 sets document_set_id)
CREATE TABLE closings (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  loan_id                     uuid REFERENCES loans(id),                          -- set by 30.2 at hand-off
  scheduled_at                timestamptz,
  consummation_at             timestamptz,
  closing_type                text CHECK (closing_type IN ('ron', 'ipen', 'hybrid', 'wet')),
  settlement_agent_party_id   uuid REFERENCES parties(id),
  notary_party_id             uuid REFERENCES parties(id),
  location_type               text CHECK (location_type IN ('lender_office', 'attorney_office', 'title_company', 'settlement_agent_office', 'remote', 'other')),
  status                      text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'documents_released', 'in_session', 'signed', 'consummated', 'rescheduled', 'cancelled')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE closings IS 'Addendum §3: one row per scheduled closing (26.2 schedules and executes; 26.1 chooses closing_type and attaches the document set; TX 50(a)(6) closings are wet at a permitted office).';
CREATE INDEX closings_application_idx ON closings(application_id);

-- ---------------------------------------------------------------- closing_data_snapshots (append-only)
CREATE TABLE closing_data_snapshots (
  snapshot_id                 text PRIMARY KEY,
  application_id              uuid NOT NULL REFERENCES applications(id),
  cd_version                  int NOT NULL,                                       -- the 25.2 disclosures.version whose figures are embedded
  du_submission_number        text,
  lock_id                     text,
  taken_at                    timestamptz NOT NULL,
  payload                     jsonb NOT NULL,                                     -- borrowers/capacities, vesting, legal description, amount, rate (3 dp), term, dates, P&I, late charge, ARM, MIN, NMLSR IDs, servicer address, buydown, escrow flag, riders, TX/NY flags
  payload_hash                char(64) NOT NULL,                                  -- SHA-256 of the canonical JSON
  note_terms_hash             char(64) NOT NULL,                                  -- noteTermsHash of the note terms (30.2 OB-002 comparator)
  min                         char(18),
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE closing_data_snapshots IS '26.1: the CD-final data every instrument of a set is rendered from; PII; immutable — a data change is a new snapshot and a new set (re-draw).';
CREATE INDEX closing_data_snapshots_application_idx ON closing_data_snapshots(application_id, taken_at);
CREATE TRIGGER closing_data_snapshots_immutable BEFORE UPDATE OR DELETE ON closing_data_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- closing_document_sets (state machine)
CREATE TABLE closing_document_sets (
  set_id                      text PRIMARY KEY,
  application_id              uuid NOT NULL REFERENCES applications(id),
  closing_id                  uuid REFERENCES closings(id),
  snapshot_id                 text REFERENCES closing_data_snapshots(snapshot_id),
  closing_type                text CHECK (closing_type IN ('ron', 'ipen', 'hybrid', 'wet')),   -- chosen here; 26.2 executes
  document_set_profile        text,                                               -- AZ_REFI_FIXED_ENOTE, TX_50A6_WET, NY_CEMA_PAPER …
  status                      text NOT NULL DEFAULT 'pending_data' CHECK (status IN ('pending_data', 'snapshot_taken', 'generated', 'qc_failed', 'qc_passed', 'released', 'executed', 'closed', 'superseded', 'voided')),
  cd_version_required         int,
  cd_received_on              date,
  generated_at                timestamptz,
  qc_passed_at                timestamptz,
  released_at                 timestamptz,
  released_to_party_id        uuid REFERENCES parties(id),                        -- settlement agent or eClosing platform
  superseded_by_set_id        text REFERENCES closing_document_sets(set_id),
  redraw_reason               text CHECK (redraw_reason IN ('cd_corrected', 'rate_change', 'date_change', 'vesting_change', 'template_retired', 'qc_defect_found', 'borrower_request')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE closing_document_sets IS '26.1 state machine: pending_data → snapshot_taken → generated → qc_failed | qc_passed → released (gated by SM_O71_TEMPLATE_VERSION_GATE, SM_O71_DOC_QC_PASS_GATE, TX gates) → executed (26.2) → closed (26.3 loan.funded); released → superseded on re-draw; voided on withdrawal/denial.';
CREATE INDEX closing_document_sets_application_idx ON closing_document_sets(application_id, status);
ALTER TABLE closings ADD COLUMN document_set_id text REFERENCES closing_document_sets(set_id);

-- ---------------------------------------------------------------- closing_documents (addendum §3 + 26.1 columns)
CREATE TABLE closing_documents (
  document_id                 uuid PRIMARY KEY REFERENCES documents(id),
  set_id                      text NOT NULL REFERENCES closing_document_sets(set_id),
  application_id              uuid NOT NULL REFERENCES applications(id),
  template_id                 text REFERENCES document_templates(template_id),
  template_revision_date      text,
  kind                        text NOT NULL CHECK (kind IN ('note', 'enote', 'security_instrument', 'rider_condo', 'rider_pud', 'rider_1_4_family', 'rider_second_home', 'rider_arm', 'rider_mers', 'rider_trust', 'rider_leasehold_cross_default', 'addendum_note', 'poa_copy', 'trust_certification', 'buydown_agreement', 'tx_notice_12day', 'tx_itemization', 'tx_fmv_acknowledgment', 'tx_affidavit_3185', 'tx_closing_receipt', 'tx_f2_notice', 'ny_cema_3172', 'ny_cema_exhibit', 'ny_255_affidavit', 'final_1003', 'closing_instructions', 'closing_receipt', 'name_affidavit', 'rescission_notice_h8', 'mers_assignment_3749', 'allonge', 'other_state')),
  form_number                 text,
  data_hash                   char(64) NOT NULL,                                  -- note/eNote: noteTermsHash (30.2 OB-002); otherwise closing_data_snapshots.payload_hash
  snapshot_hash               char(64) NOT NULL,
  render_hash                 char(64) NOT NULL,                                  -- SHA-256 of the rendered artifact
  signers                     jsonb NOT NULL DEFAULT '[]',                        -- [{party_id, capacity, signature_method, required}]
  notarized                   boolean NOT NULL DEFAULT false,
  witness_count               int NOT NULL DEFAULT 0,
  recordable                  boolean NOT NULL DEFAULT false,
  signed_document_id          uuid REFERENCES documents(id),                      -- set by 26.2
  execution_status            text NOT NULL DEFAULT 'unsigned' CHECK (execution_status IN ('unsigned', 'signed', 'notarized', 'tamper_sealed', 'voided')),
  retention_class             retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE closing_documents IS 'Addendum §3 / 26.1: every rendered closing artifact with its template version, data hash and render hash; 26.2 sets signed_document_id / execution_status; 26.4 adds the allonge; a Maine Form 3749 is the only kind containing "assignment".';
CREATE INDEX closing_documents_set_idx ON closing_documents(set_id, kind);
CREATE TRIGGER closing_documents_no_delete BEFORE DELETE ON closing_documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- document_qc_checks (append-only)
CREATE TABLE document_qc_checks (
  check_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id                      text NOT NULL REFERENCES closing_document_sets(set_id),
  rule_code                   text NOT NULL CHECK (rule_code IN ('DQC_NOTE_CD_AMOUNT', 'DQC_NOTE_CD_RATE', 'DQC_NOTE_CD_PI', 'DQC_NOTE_SI_DATE', 'DQC_SI_VESTING_TITLE', 'DQC_SI_LEGAL_TITLE', 'DQC_NMLSR_36G', 'DQC_1003_FINAL_TERMS', 'DQC_RIDERS_REQUIRED', 'DQC_TEMPLATE_VERSION', 'DQC_LATE_CHARGE_STATE', 'DQC_MIN_CHECK_DIGIT', 'DQC_ENOTE_ARC_VIEW', 'DQC_TX_2PCT', 'DQC_TX_80LTV', 'DQC_CEMA_SUM', 'DQC_NAME_VARIANCE')),
  severity                    text NOT NULL DEFAULT 'hard' CHECK (severity IN ('hard', 'soft')),
  result                      text NOT NULL CHECK (result IN ('pass', 'fail', 'waived')),
  expected                    text,
  actual                      text,
  reason                      text,
  evidence_document_ids       uuid[] NOT NULL DEFAULT '{}',
  waived_by                   text,                                               -- officer (money/hard rules) with reason
  checked_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE document_qc_checks IS '26.1 data-to-document QC: every rule compares the snapshot, the rendered document and the upstream record; a hard fail blocks release (SM_O71_DOC_QC_PASS_GATE); waivers are officer-only with reason.';
CREATE INDEX document_qc_checks_set_idx ON document_qc_checks(set_id, rule_code);
CREATE TRIGGER document_qc_checks_immutable BEFORE UPDATE OR DELETE ON document_qc_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- closing_instructions
CREATE TABLE closing_instructions (
  instruction_id              text PRIMARY KEY,
  set_id                      text NOT NULL REFERENCES closing_document_sets(set_id),
  settlement_agent_party_id   uuid REFERENCES parties(id),
  version                     int NOT NULL DEFAULT 1,
  sent_at                     timestamptz,
  acknowledged_at             timestamptz,
  acknowledged_by             text,
  content                     jsonb NOT NULL,                                     -- funding conditions, wire_verifications.id reference, return list, recording incl. MIN/MERS Rider, eRecording, signing/notary/witness per document, POA/trust, TX items, CPL, disbursement rule, e-closing confirmation
  pdf_document_id             uuid REFERENCES documents(id),
  signing_officer_signature_required boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE closing_instructions IS '26.1 NTC_SM_CLOSING_INSTRUCTIONS in the partner''s name: the settlement agent''s acknowledgment opens SM_O71_INSTRUCTIONS_ACK_GATE (mandatory for TX 50(a)(6) per B5-4.1-03); wire instructions are referenced by wire_verifications.id, never typed.';

-- ---------------------------------------------------------------- tx_home_equity_reviews
CREATE TABLE tx_home_equity_reviews (
  application_id              uuid PRIMARY KEY REFERENCES applications(id),
  is_50a6                     boolean NOT NULL DEFAULT false,
  classification_basis        text,
  prior_50a6_closing_date     date,
  one_year_ok                 boolean,
  fmv_cents                   bigint,
  ltv_80_ok                   boolean,
  fee_test                    jsonb,                                              -- {items:[{fee_item_id, counted, reason}], total_counted_cents, cap_cents, pass}
  notice_12day_delivered_at   date,
  notice_12day_channel        text CHECK (notice_12day_channel IN ('electronic', 'in_person', 'mailed')),
  notice_12day_presumed_received_at date,
  application_submitted_at    date NOT NULL,
  earliest_closing_date       date,
  itemization_received_at     date,
  itemization_source          text CHECK (itemization_source IN ('cd', 'separate')),
  application_copy_received_at date,
  earliest_itemization_closing_date date,
  emergency_consent_document_id uuid REFERENCES documents(id),
  closing_location_party_id   uuid REFERENCES parties(id),
  closing_location_type       text CHECK (closing_location_type IN ('lender_office', 'attorney_office', 'title_company')),
  fmv_ack_document_id         uuid REFERENCES documents(id),
  affidavit_3185_document_id  uuid REFERENCES documents(id),
  closing_receipt_document_id uuid REFERENCES documents(id),
  f2_refinance                boolean NOT NULL DEFAULT false,
  f2_notice_due               date,
  f2_notice_delivered_at      date,
  f2_earliest_closing_date    date,
  f1_affidavit_document_id    uuid REFERENCES documents(id),
  result                      text NOT NULL DEFAULT 'pending' CHECK (result IN ('eligible', 'ineligible', 'pending')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE tx_home_equity_reviews IS '26.1 Texas §50(a)(6)/(f)(2) review: 12-day notice (7 TAC §153.12/§153.51 presumption), one-business-day itemization (§153.13, business_days_regz_specific), 2% fee test (§153.5), 80% LTV, one-year rule, closing location (§153.15), 50(f)(2) notice (§153.45).';

-- ---------------------------------------------------------------- buydown_agreements
CREATE TABLE buydown_agreements (
  application_id              uuid PRIMARY KEY REFERENCES applications(id),
  provider_party_id           text NOT NULL,
  provider_type               text NOT NULL CHECK (provider_type IN ('seller', 'builder', 'lender', 'borrower', 'other_interested_party')),
  schedule                    jsonb NOT NULL,                                     -- [{year, bought_down_rate, borrower_payment_cents, subsidy_cents_per_month}]
  total_subsidy_cents         bigint NOT NULL,
  classification              text NOT NULL CHECK (classification IN ('moderate', 'significant')),   -- SFC 009 / 014
  ipc_counted_cents           bigint NOT NULL DEFAULT 0,
  custodial_account_id        uuid,
  funded_at                   timestamptz,
  return_on_payoff_to         text NOT NULL DEFAULT 'credit_to_payoff' CHECK (return_on_payoff_to IN ('borrower', 'lender', 'credit_to_payoff')),
  agreement_document_id       uuid REFERENCES documents(id),
  signed_document_id          uuid REFERENCES documents(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE buydown_agreements IS '26.1 / B2-1.4-04: the written buydown plan (schedule, subsidy, SFC 009/014, IPC count, custodial funding, payoff treatment); the note keeps the permanent terms.';

-- ---------------------------------------------------------------- cema_packages
CREATE TABLE cema_packages (
  application_id              uuid PRIMARY KEY REFERENCES applications(id),
  prior_liens                 jsonb NOT NULL,                                     -- [{lender, recorded_at, instrument_no, unpaid_principal_cents, assignment_received}]
  new_money_cents             bigint NOT NULL DEFAULT 0,
  consolidated_amount_cents   bigint NOT NULL,
  form_3172_document_id       uuid REFERENCES documents(id),
  exhibits                    jsonb NOT NULL DEFAULT '[]',
  section_255_affidavit_document_id uuid REFERENCES documents(id),
  mortgage_tax_on_new_money_cents bigint NOT NULL DEFAULT 0,
  assignment_to_partner_document_ids uuid[] NOT NULL DEFAULT '{}',
  status                      text NOT NULL DEFAULT 'buildable' CHECK (status IN ('buildable', 'blocked', 'built', 'recorded', 'abandoned')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE cema_packages IS '26.1 / B8-2-02, NY Tax Law §255: Form 3172 consolidation of the prior notes/mortgages plus new money; tax on the new money only; never an eNote.';

COMMIT;
