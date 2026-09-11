-- 0094_eclosing_execution.sql — §26.2 eClosing execution (RON, IPEN, hybrid, wet), eNote signing, eVault custody, MERS
-- eRegistry registration, eRecording and paper-note handling
-- (spec/sections/26-closing-execution-documents-eclosing-ron-funding-and-post-cl/26-2-*.md; addendum §3 "Closing and funding").
-- 26.2's own table `eclosing_eligibility` (settlement-agent/county eClosing capability captured during 24.4 vetting), the
-- baseline closing tables the addendum names and no earlier migration created — `signing_sessions` (one per signer group per
-- closing: identity proofing, notarial acts, tamper seal, audit trail) and `recordings` (one per recordable instrument:
-- eRecording or paper fallback, rejection cure, instrument number, Date-of-Policy gap) — plus the columns 26.2 adds to the
-- shared tables: `closings` (0073) gains the execution columns of the 26.2 data model; `enotes` (0019, shared with 1.4)
-- gains the addendum columns (registered_at, controller_org_id, location_org_id, delegatee_org_id, interim_funder_org_id)
-- and the 26.2 registration/Secured Party columns by ALTER — never a second CREATE; its primary key moves to a surrogate so
-- an eNote row exists from the tamper seal (application-keyed) and is joined to the servicing `loans` row at the 30.2
-- hand-off (loan_id stays UNIQUE for the servicing side); `custody_records` (0019, keyed by loan_id — 0097 references it)
-- gains the paper-note chain columns (note_form, chain, original_received_at) and the closing-time note locations;
-- `jurisdiction_rules` (0002) gains the RON/witness/recording rows as jsonb. `mers_transactions` (0019) already carries
-- txn_type/status/submitted_at; the eRegistry request kinds are added to its CHECK. Additive only; applied migrations are
-- never edited.
BEGIN;

ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'fnma_enote_signing_life_plus_7y';

-- ───────────────────────────── eclosing_eligibility (new; 24.4 vetting captures it, 26.2 gates on it) ─────────────────────────────
CREATE TABLE eclosing_eligibility (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_agent_party_id   uuid NOT NULL REFERENCES parties(id),
  county_fips                 char(5),                                            -- null = every county the agent serves
  state                       char(2),
  ron_capable                 boolean NOT NULL DEFAULT false,
  ipen_capable                boolean NOT NULL DEFAULT false,
  erecording_submitter        boolean NOT NULL DEFAULT false,
  platforms                   text[] NOT NULL DEFAULT '{}',                       -- eClosing TSP names from Fannie Mae's list
  remote_witness_service      boolean NOT NULL DEFAULT false,
  verified_at                 timestamptz,
  verified_by                 text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE eclosing_eligibility IS '26.2: settlement agent / county eClosing capability (ron_capable, ipen_capable, erecording_submitter, platforms, remote_witness_service) captured during 24.4 vetting; SM_O72_AGENT_ECLOSING_ELIGIBLE_GATE requires a row matching closings.closing_type.';
CREATE INDEX eclosing_eligibility_agent_idx ON eclosing_eligibility (settlement_agent_party_id, county_fips);

-- ───────────────────────────── closings (0073): execution columns of the 26.2 data model ─────────────────────────────
ALTER TABLE closings
  ADD COLUMN IF NOT EXISTS signing_start_at                timestamptz,
  ADD COLUMN IF NOT EXISTS signing_end_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS consummation_on                 date,                  -- local date of the final note/eNote signature (25.3 anchors its period here)
  ADD COLUMN IF NOT EXISTS closing_location_party_id       uuid REFERENCES parties(id),
  ADD COLUMN IF NOT EXISTS closing_location_type           text CHECK (closing_location_type IN ('lender_office', 'attorney_office', 'title_company', 'settlement_agent_office', 'remote', 'homestead', 'other')),
  ADD COLUMN IF NOT EXISTS ron_provider_party_id           uuid REFERENCES parties(id),
  ADD COLUMN IF NOT EXISTS remote_notarization_indicator   boolean NOT NULL DEFAULT false,   -- ULDD (29.3)
  ADD COLUMN IF NOT EXISTS enote_indicator                 boolean NOT NULL DEFAULT false,   -- ULDD (29.3)
  ADD COLUMN IF NOT EXISTS witness_manifest                jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS execution_review_passed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS execution_defects               jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS pre_session_checks_passed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS transaction_type                text,
  ADD COLUMN IF NOT EXISTS is_hpml                         boolean,
  ADD COLUMN IF NOT EXISTS note_form                       text CHECK (note_form IN ('enote', 'paper')),
  ADD COLUMN IF NOT EXISTS execution_status                text NOT NULL DEFAULT 'scheduled' CHECK (execution_status IN ('scheduled', 'package_released', 'pre_session_checks_passed', 'session_in_progress', 'signed', 'notarized', 'sealed', 'execution_reviewed', 'awaiting_funding', 'funded', 'recorded', 'complete', 'session_failed', 'rescheduled', 'converted_to_paper_path', 'voided'));
COMMENT ON COLUMN closings.execution_status IS '26.2 state machine: scheduled → package_released → pre_session_checks_passed → session_in_progress → signed → notarized → sealed → execution_reviewed → awaiting_funding → funded → recorded → complete; side states session_failed / rescheduled / converted_to_paper_path / voided. closings.status (0073) keeps the coarse baseline values.';

-- ───────────────────────────── signing_sessions (baseline; 26.2 columns) ─────────────────────────────
CREATE TABLE signing_sessions (
  session_id                  text PRIMARY KEY,
  closing_id                  uuid NOT NULL REFERENCES closings(id),
  application_id              uuid NOT NULL REFERENCES applications(id),
  platform_session_ref        text,
  mode                        text NOT NULL CHECK (mode IN ('ron', 'ipen', 'esign_only', 'wet_witnessed')),
  signer_party_ids            uuid[] NOT NULL DEFAULT '{}',
  notary_party_id             uuid REFERENCES parties(id),
  notary_commission_state     char(2),
  notary_commission_number    text,
  notary_physical_location_state char(2),
  signer_physical_location    jsonb NOT NULL DEFAULT '{}',                        -- {party_id: {state, country}}
  consent_record_id           uuid REFERENCES consents(id),
  identity_proofing           jsonb NOT NULL DEFAULT '[]',                        -- per signer: method, credential_type, credential_analysis_result, kba{questions, correct, attempts, seconds}, vendor, evidence_document_id
  recording_ref               text,                                               -- provider-held audio-video recording reference
  recording_custodian         text CHECK (recording_custodian IN ('ron_provider', 'notary_repository', 'sm')),
  recording_retention_years   int,                                                -- from jurisdiction_rules (AZ 5; TX 5; NY 10)
  journal_ref                 text,
  audit_trail_document_id     uuid REFERENCES documents(id),
  audit_trail_hash            char(64),
  audit_trail_received_at     timestamptz,
  documents_signed            jsonb NOT NULL DEFAULT '[]',                        -- [{closing_document_id, signed_at, signature_method}]
  notarial_acts               jsonb NOT NULL DEFAULT '[]',                        -- [{closing_document_id, act_type, completed_at, certificate_indicates_communication_technology}]
  started_at                  timestamptz,
  ended_at                    timestamptz,
  status                      text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'consent_captured', 'identity_proofed', 'in_session', 'documents_signed', 'notarial_acts_complete', 'tamper_sealed', 'audit_trail_received', 'completed', 'failed', 'abandoned')),
  failure_reason              text CHECK (failure_reason IN ('identity', 'credential_analysis', 'connectivity', 'notary_unavailable', 'consent_withdrawn', 'signer_no_show', 'document_defect', 'platform_outage')),
  retake_blocked_until        timestamptz,                                        -- 1 TAC §87.70: no KBA retake with the same notary for 24 hours after the second failure
  retention_class             retention_class NOT NULL DEFAULT 'fnma_enote_signing_life_plus_7y',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE signing_sessions IS '26.2: one signing session per signer group per closing — mode (ron/ipen/esign_only/wet_witnessed), notary commission and physical location, identity proofing per signer (credential analysis + KBA or personal knowledge / credible witness), notarial acts, tamper seal, audit trail (fnma_enote_signing_life_plus_7y); the platform records, never signs.';
CREATE INDEX signing_sessions_closing_idx ON signing_sessions (closing_id);

-- ───────────────────────────── enotes (0019, shared with 1.4): addendum + 26.2 columns by ALTER ─────────────────────────────
ALTER TABLE enotes DROP CONSTRAINT enotes_pkey;
ALTER TABLE enotes
  ADD COLUMN IF NOT EXISTS id                              uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS application_id                  uuid REFERENCES applications(id),
  ALTER COLUMN loan_id DROP NOT NULL,
  ADD CONSTRAINT enotes_pkey PRIMARY KEY (id),
  ADD CONSTRAINT enotes_loan_id_unique UNIQUE (loan_id),
  ADD CONSTRAINT enotes_keyed CHECK (loan_id IS NOT NULL OR application_id IS NOT NULL),
  -- addendum columns
  ADD COLUMN IF NOT EXISTS registered_at                   timestamptz,
  ADD COLUMN IF NOT EXISTS controller_org_id               char(7),               -- partner Org ID (first Controller, B8-8-02)
  ADD COLUMN IF NOT EXISTS location_org_id                 char(7),               -- SM / vendor eVault Org ID
  ADD COLUMN IF NOT EXISTS interim_funder_org_id           char(7),               -- no Interim Funder role on the eRegistry; kept for the addendum's shape (Secured Party is the eNote analogue)
  -- 26.2 columns
  ADD COLUMN IF NOT EXISTS closing_document_id             uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS smart_doc_version               text NOT NULL DEFAULT '1.0.2-cat1',
  ADD COLUMN IF NOT EXISTS signing_completed_at            timestamptz,
  ADD COLUMN IF NOT EXISTS tamper_sealed_at                timestamptz,
  ADD COLUMN IF NOT EXISTS tamper_seal_hash                char(64),
  ADD COLUMN IF NOT EXISTS tamper_seal_hash_alg            text NOT NULL DEFAULT 'SHA-256',
  ADD COLUMN IF NOT EXISTS authoritative_copy_ref          text,                  -- eVault object id
  ADD COLUMN IF NOT EXISTS authoritative_copy_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS registration_due_at             timestamptz,           -- end of the next business_days_federal day after the seal, 23:59 ET
  ADD COLUMN IF NOT EXISTS eregistry_registration_txn_id   text,
  ADD COLUMN IF NOT EXISTS registration_status             text NOT NULL DEFAULT 'pending' CHECK (registration_status IN ('pending', 'registered', 'rejected', 'reversed')),
  ADD COLUMN IF NOT EXISTS secured_party_org_id            char(7),
  ADD COLUMN IF NOT EXISTS secured_party_set_at            timestamptz,
  ADD COLUMN IF NOT EXISTS edelivered_to_fnma_at           timestamptz,           -- 29.4 emits enote.edelivered; 26.2 only records
  ADD COLUMN IF NOT EXISTS transfer_control_location_at    timestamptz,
  ADD COLUMN IF NOT EXISTS transfer_effective_date         date,
  ADD COLUMN IF NOT EXISTS status                          text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'signed', 'tamper_sealed', 'registered', 'secured_party_set', 'edelivered', 'control_transferred', 'reversed', 'converted_to_paper'));
ALTER TABLE enotes ALTER COLUMN controller SET DEFAULT 'PARTNER';
ALTER TABLE enotes ALTER COLUMN location SET DEFAULT 'SM';
COMMENT ON TABLE enotes IS '1.4 / 26.2 (shared): the eNote — MIN, Controller/Location/Delegatee/Servicing Agent Org IDs, Authoritative Copy reference and hash, tamper seal, registration_due_at (MERS_PROC_ENOTE_REGISTER_1BD), eRegistry registration, Secured Party (before any warehouse advance), eDelivery and transfer of Control/Location (29.4). Application-keyed from the tamper seal; loan_id is set at the 30.2 hand-off.';

-- ───────────────────────────── mers_transactions (0019): eRegistry request kinds ─────────────────────────────
ALTER TABLE mers_transactions DROP CONSTRAINT IF EXISTS mers_transactions_txn_type_check;
ALTER TABLE mers_transactions ADD CONSTRAINT mers_transactions_txn_type_check CHECK (txn_type IN ('min_update_subservicer','tos_initiate','tos_confirm','tob_confirm','registration','deactivation','min_update_other','deactivation_paid_in_full','deactivation_reversal',
  'eregistry_registration','eregistry_registration_reversal','eregistry_change_data_secured_party','eregistry_change_data_secured_party_release','eregistry_edelivery','eregistry_transfer_control_location','eregistry_transfer_servicing_agent','eregistry_change_status','eregistry_inquiry'));
ALTER TABLE mers_transactions ALTER COLUMN loan_id DROP NOT NULL;
ALTER TABLE mers_transactions
  ADD COLUMN IF NOT EXISTS application_id                  uuid REFERENCES applications(id),
  ADD COLUMN IF NOT EXISTS request_signed_hash             char(64),              -- every XML Request is digitally signed (tamper-evident) or the eRegistry rejects it
  ADD COLUMN IF NOT EXISTS ack_at                          timestamptz,
  ADD COLUMN IF NOT EXISTS result                          text,
  ADD COLUMN IF NOT EXISTS error_codes                     text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT mers_transactions_keyed CHECK (loan_id IS NOT NULL OR application_id IS NOT NULL);

-- ───────────────────────────── recordings (baseline; 26.2 columns) ─────────────────────────────
CREATE TABLE recordings (
  recording_id                text PRIMARY KEY,
  closing_id                  uuid NOT NULL REFERENCES closings(id),
  application_id              uuid NOT NULL REFERENCES applications(id),
  closing_document_id         uuid REFERENCES documents(id),
  channel                     text NOT NULL CHECK (channel IN ('erecording', 'paper')),
  vendor                      text,
  submitter_party_id          uuid REFERENCES parties(id),                        -- SM or the settlement agent
  county_fips                 char(5),
  state                       char(2),
  county                      text,
  package_ref                 text,
  pria_model                  text CHECK (pria_model IN ('model_1_image', 'model_2_image_index', 'model_3_xml')),
  submitted_at                timestamptz,
  accepted_at                 timestamptz,
  rejected_at                 timestamptz,
  rejection_reason            text,
  resubmitted_count           int NOT NULL DEFAULT 0,
  paper_fallback_at           timestamptz,
  county_receipt_at           timestamptz,
  recorded_at                 timestamptz,
  instrument_number           text,
  book_page                   text,
  recording_fee_cents         bigint,
  recorded_image_document_id  uuid REFERENCES documents(id),
  date_of_policy              date,
  gap_days                    int,                                                -- recorded_at.date − Date of Policy (Covered Risk 14)
  status                      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'accepted', 'rejected', 'paper_fallback', 'recorded')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE recordings IS '26.2: one recording package per recordable instrument — eRecording (PRIA 2.4.2; Model 2 image+index default) or paper fallback with courier tracking; rejection cure (SM_O72_RECORDING_REJECT_CURE_2BD), county receipt (SM_O72_PAPER_FALLBACK_5BD), instrument number / recording timestamp and the Date-of-Policy gap; the recorded image flows to 26.4 trailing_documents.';
CREATE INDEX recordings_closing_idx ON recordings (closing_id);

-- ───────────────────────────── custody_records (0019, shared with 1.4): paper-note chain at signing ─────────────────────────────
ALTER TABLE custody_records DROP CONSTRAINT IF EXISTS custody_records_note_location_check;
ALTER TABLE custody_records ADD CONSTRAINT custody_records_note_location_check CHECK (note_location IN ('custodian','released_form_2009','fnma_evault','settlement_agent','courier','warehouse_custodian','document_custodian'));
ALTER TABLE custody_records
  ADD COLUMN IF NOT EXISTS application_id                  uuid REFERENCES applications(id),
  ADD COLUMN IF NOT EXISTS note_form                       text CHECK (note_form IN ('enote', 'paper')),
  ADD COLUMN IF NOT EXISTS chain                           jsonb NOT NULL DEFAULT '[]',   -- [{holder_party_id, holder_role, from_at, to_at, tracking_ref, evidence_document_id}]
  ADD COLUMN IF NOT EXISTS original_received_at            timestamptz;                  -- 26.4 timer anchor

-- ───────────────────────────── jurisdiction_rules (0002): RON / witness / recording rows (jsonb, not a new table) ─────────────────────────────
ALTER TABLE jurisdiction_rules ADD COLUMN IF NOT EXISTS ron jsonb;
COMMENT ON COLUMN jurisdiction_rules.ron IS '26.2: {ron_authorized, ron_statute_cite, fnma_listed, out_of_state_ron_accepted, notary_in_state_required, identity_proofing_methods[], kba_params{min_questions, seconds, pass_pct, retake_within_hours, new_question_pct}, recording_retention_years, journal_required, witness_count, witness_statute_cite, remote_witness_allowed, erecording_available_by_county{fips: bool}, acknowledgment_form_ref} — populated from primary statutes before a state is enabled (AZ, OH, TX, NY read).';

COMMIT;
