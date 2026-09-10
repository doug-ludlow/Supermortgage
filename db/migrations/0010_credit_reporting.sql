-- 0010_credit_reporting.sql — Section 8 (8.1–8.3): Metro 2 cycles/snapshots/files, disputes, suppressions (authoritative), bankruptcy reporting state, accuracy program.
BEGIN;

ALTER TABLE loans ADD COLUMN IF NOT EXISTS credit_reporting_status text NOT NULL DEFAULT 'active' CHECK (credit_reporting_status IN ('active','hold','final_reported','never_report'));
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS credit_reporting_ecoa_override char(1);

CREATE TABLE furnisher_config (
  bureau                text PRIMARY KEY CHECK (bureau IN ('equifax','experian','transunion','innovis')),
  program_identifier    text NOT NULL,
  subscriber_code       text NOT NULL,
  transport             text NOT NULL CHECK (transport IN ('sts','edt','sftp')),
  pgp_key_id            text,
  file_naming           text NOT NULL,
  ack_expected_within_bd int NOT NULL DEFAULT 5,
  reporter_name         text NOT NULL,
  reporter_address      text NOT NULL,
  reporter_phone        text NOT NULL,
  software_vendor_name  text NOT NULL,
  software_version      text NOT NULL,
  furnisher_of_record   text NOT NULL DEFAULT 'supermortgage' CHECK (furnisher_of_record IN ('supermortgage','partner_private_label'))
);
CREATE TABLE metro2_cycles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date            date NOT NULL UNIQUE,
  status                text NOT NULL DEFAULT 'building' CHECK (status IN ('building','validated','held','transmitted','acknowledged','closed')),
  record_count          int NOT NULL DEFAULT 0,
  hash                  text,
  built_at              timestamptz,
  held_reason           text,
  approved_by           text,
  retention             retention_class NOT NULL DEFAULT 'fcra_furnishing_5y'
);
-- credit_reporting_suppressions: 8.3 authoritative schema (extends the 4.1 slice)
ALTER TABLE credit_reporting_suppressions
  ADD COLUMN IF NOT EXISTS mechanism text NOT NULL DEFAULT 'as_if_paid_projection' CHECK (mechanism IN ('report','flag_only','as_if_paid_projection','freeze_status','omit_account','delete_consumer','delete_account')),
  ADD COLUMN IF NOT EXISTS codes jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS evidence_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS agent_decision_id uuid REFERENCES agent_decisions(id),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','released')),
  ADD COLUMN IF NOT EXISTS released_reason text;
ALTER TABLE credit_reporting_suppressions ADD CONSTRAINT credit_reporting_suppressions_reason_chk CHECK (reason IN ('regx_1024_35_i','respa_6e3_qwr','fcra_a1b_inaccuracy_notice','fcra_dispute_open','identity_theft_block','identity_theft_report','bankruptcy_active','bankruptcy_discharged','scra_relief','scra_stay','disaster','forbearance','cares_accommodation','deceased','fdcpa_1006_30','boarding_unreconciled','transfer_out_final','qc_hold','litigation_hold'));
CREATE TABLE metro2_overlay_decisions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  borrower_id           uuid REFERENCES borrowers(id),
  cycle_id              uuid NOT NULL REFERENCES metro2_cycles(id),
  mechanism             text NOT NULL CHECK (mechanism IN ('report','omit_account','freeze_status','as_if_paid_projection','flag_only','delete_consumer','delete_account')),
  reasons               text[] NOT NULL DEFAULT '{}',
  codes                 jsonb NOT NULL DEFAULT '{}',
  suppression_ids       uuid[] NOT NULL DEFAULT '{}',
  agent_decision_id     uuid REFERENCES agent_decisions(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metro2_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id              uuid NOT NULL REFERENCES metro2_cycles(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  borrower_id           uuid NOT NULL REFERENCES borrowers(id),
  segment_role          text NOT NULL CHECK (segment_role IN ('base','j1','j2')),
  account_status        char(2) NOT NULL,
  payment_rating        char(1),
  payment_history_profile char(24) NOT NULL,
  special_comment       char(2),
  compliance_condition_code char(2),
  consumer_information_indicator char(2),
  ecoa_code             char(1) NOT NULL,
  current_balance_cents bigint NOT NULL,
  amount_past_due_cents bigint NOT NULL,
  scheduled_payment_cents bigint NOT NULL,
  actual_payment_cents  bigint NOT NULL,
  original_amount_cents bigint NOT NULL,
  charge_off_amount_cents bigint NOT NULL DEFAULT 0,
  date_opened           date NOT NULL,
  date_of_first_delinquency date,
  date_closed           date,
  date_of_last_payment  date,
  terms_duration        smallint,
  terms_frequency       char(1) NOT NULL DEFAULT 'M',
  interest_type_indicator char(1),
  k3                    jsonb NOT NULL,
  k4                    jsonb,
  l1                    jsonb,
  overlay_decision_id   uuid REFERENCES metro2_overlay_decisions(id),
  derivation            jsonb NOT NULL,
  delta_vs_prior        jsonb,
  validation_errors     jsonb NOT NULL DEFAULT '[]',
  omitted               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, loan_id, borrower_id)
);
CREATE TRIGGER metro2_snapshots_immutable BEFORE UPDATE OR DELETE ON metro2_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE metro2_files (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id              uuid NOT NULL REFERENCES metro2_cycles(id),
  bureau                text NOT NULL REFERENCES furnisher_config(bureau),
  file_name             text NOT NULL,
  document_id           uuid REFERENCES documents(id),
  hash                  text NOT NULL,
  header                jsonb NOT NULL,
  trailer               jsonb NOT NULL,
  transmitted_at        timestamptz,
  transport_ref         text,
  status                text NOT NULL DEFAULT 'built' CHECK (status IN ('built','transmitted','ack_pending','acknowledged','rejected','resubmitted')),
  resubmission_of       uuid REFERENCES metro2_files(id),
  UNIQUE (cycle_id, bureau, hash)
);
CREATE TABLE metro2_ack_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id               uuid NOT NULL REFERENCES metro2_files(id),
  loan_id               uuid REFERENCES loans(id),
  consumer_account_number text,
  severity              text NOT NULL CHECK (severity IN ('info','warning','reject')),
  bureau_code           text,
  bureau_message        text,
  field                 text,
  resolution            text NOT NULL DEFAULT 'pending' CHECK (resolution IN ('pending','corrected_next_cycle','aud_sent','resubmitted','accepted_as_is')),
  resolved_at           timestamptz,
  agent_decision_id     uuid REFERENCES agent_decisions(id)
);
CREATE TABLE credit_reporting_corrections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  borrower_id           uuid REFERENCES borrowers(id),
  source                text NOT NULL CHECK (source IN ('ack_reject','dispute_acdv','dispute_direct','noe','qc','transfer','self_identified')),
  fields_changed        jsonb NOT NULL,
  evidence              text,
  aud_control_number    text,
  aud_status            text,
  aud_bureaus           text[] NOT NULL DEFAULT '{}',
  aud_due_at            date,
  cycle_applied_id      uuid REFERENCES metro2_cycles(id),
  notice_id             uuid REFERENCES notices(id),
  agent_decision_id     uuid REFERENCES agent_decisions(id),
  officer_approved_by   text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER credit_reporting_corrections_immutable BEFORE UPDATE OR DELETE ON credit_reporting_corrections FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 8.2 disputes
CREATE TABLE credit_disputes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  borrower_id           uuid NOT NULL REFERENCES borrowers(id),
  source                text NOT NULL CHECK (source IN ('acdv','direct_written','direct_oral','noe_linked','complaint','attorney','cfpb_portal')),
  cra                   text CHECK (cra IN ('equifax','experian','transunion','innovis')),
  acdv_control_number   text,
  subscriber_code       text,
  dispute_codes         text[] NOT NULL DEFAULT '{}',
  fcra_relevant_information text,
  consumer_statement    text,
  image_document_ids    uuid[] NOT NULL DEFAULT '{}',
  cra_received_at       date,
  received_at           timestamptz NOT NULL,
  response_due_at       date,
  results_due_at        date,
  extended_to           date,
  category              text CHECK (category IN ('not_mine','identity_theft','mixed_file','liability','terms','status_or_rating','payment_history','balance','amount_past_due','dates','special_comment_or_ccc','bankruptcy_cii','deceased','scra','transfer_duplicate','other')),
  frivolous_basis       text,
  status                text NOT NULL DEFAULT 'received',
  determination         text CHECK (determination IN ('verified_as_reported','modified','deleted_consumer','deleted_account','unverifiable','frivolous_irrelevant','out_of_scope')),
  confidence            numeric(4,3),
  response_code         text,
  response_payload      jsonb,
  submitted_at          timestamptz,
  eoscar_status         text,
  investigation         jsonb NOT NULL DEFAULT '{}',
  agent_decision_id     uuid REFERENCES agent_decisions(id),
  reviewer_id           text,
  reviewer_action       text,
  correction_ids        uuid[] NOT NULL DEFAULT '{}',
  results_notice_id     uuid REFERENCES notices(id),
  frivolous_notice_id   uuid REFERENCES notices(id),
  ccc_transition        char(2) CHECK (ccc_transition IN ('XB','XC','XH','XR')),
  viewed_at             timestamptz,
  retention             retention_class NOT NULL DEFAULT 'fcra_furnishing_5y',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN credit_disputes.consumer_statement IS 'pii';
CREATE UNIQUE INDEX credit_disputes_acdv_unique ON credit_disputes(acdv_control_number) WHERE acdv_control_number IS NOT NULL;
CREATE TABLE credit_dispute_events (
  id                    bigserial PRIMARY KEY,
  dispute_id            uuid NOT NULL REFERENCES credit_disputes(id),
  event                 text NOT NULL CHECK (event IN ('received','viewed','investigated','escalated','reviewed','responded','corrected','closed','reopened')),
  payload               jsonb NOT NULL DEFAULT '{}',
  actor                 text NOT NULL,
  at                    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER credit_dispute_events_immutable BEFORE UPDATE OR DELETE ON credit_dispute_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE eoscar_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint              text NOT NULL,
  version               text NOT NULL,
  request_hash          text NOT NULL,
  http_status           int,
  validation_errors     jsonb,
  control_numbers       text[] NOT NULL DEFAULT '{}',
  idempotency_key       text NOT NULL UNIQUE,
  at                    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_dispute_evidence (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id            uuid NOT NULL REFERENCES credit_disputes(id),
  document_id           uuid REFERENCES documents(id),
  system_snapshot_id    uuid REFERENCES system_snapshots(id),
  evidence_type         text NOT NULL CHECK (evidence_type IN ('ledger_history','payment_image','allocation_trace','notice_copy','contact_log','lossmit_agreement','bankruptcy_docket','scra_certificate','prior_servicer_record','boarding_reconciliation','prior_dispute','borrower_submission')),
  relied_upon           boolean NOT NULL DEFAULT true,
  finding               text,
  CHECK (document_id IS NOT NULL OR system_snapshot_id IS NOT NULL)
);

-- 8.3 bankruptcy reporting state, accuracy program
CREATE TABLE bankruptcy_reporting_state (
  loan_id               uuid NOT NULL REFERENCES loans(id),
  borrower_id           uuid NOT NULL REFERENCES borrowers(id),
  chapter               smallint NOT NULL CHECK (chapter IN (7,11,12,13)),
  phase                 text NOT NULL CHECK (phase IN ('petition','confirmed','discharged','dismissed','withdrawn','closed','reaffirmed')),
  petition_date         date NOT NULL,
  confirmation_date     date,
  discharge_date        date,
  dismissal_date        date,
  reaffirmation_date    date,
  debt_discharged       boolean NOT NULL DEFAULT false,
  status_at_petition    char(2),
  amount_past_due_at_petition_cents bigint,
  post_petition_payment_cents bigint,
  plan_cures_arrears    boolean,
  cii_current           char(2),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (loan_id, borrower_id)
);
CREATE TABLE accuracy_controls (
  id                    text PRIMARY KEY,                          -- E-III-a … E-III-m
  citation              text NOT NULL,
  implementation        text NOT NULL,
  frequency             text NOT NULL,
  threshold             text,
  owner                 text NOT NULL
);
CREATE TABLE accuracy_control_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id            text NOT NULL REFERENCES accuracy_controls(id),
  run_at                timestamptz NOT NULL DEFAULT now(),
  result                text NOT NULL CHECK (result IN ('pass','fail','exception')),
  metrics               jsonb NOT NULL DEFAULT '{}',
  exceptions            jsonb NOT NULL DEFAULT '[]',
  escalation_id         uuid
);
CREATE TABLE sample_verifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id              uuid NOT NULL REFERENCES metro2_cycles(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  borrower_id           uuid NOT NULL REFERENCES borrowers(id),
  fields_compared       jsonb NOT NULL,
  match                 boolean NOT NULL,
  verified_by           text NOT NULL,
  verified_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE accuracy_policy_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id           uuid NOT NULL REFERENCES documents(id),
  approved_by           text NOT NULL,
  effective_at          date NOT NULL,
  next_review_at        date NOT NULL
);

COMMIT;
