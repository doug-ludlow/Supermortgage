-- 0013_early_intervention.sql — Section 11 (11.1–11.5): Reg X EI windows, contact plans, phone numbers, QRPC, promises, FDCPA, imminent default.
BEGIN;

CREATE TABLE regx_ei_windows (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  due_date              date NOT NULL,
  principal_residence   boolean NOT NULL DEFAULT true,
  live_due_at           timestamptz NOT NULL,
  notice_due_at         timestamptz NOT NULL,
  live_status           text NOT NULL DEFAULT 'open' CHECK (live_status IN ('open','satisfied_live','satisfied_good_faith','satisfied_ongoing_lossmit','cancelled_paid','exempt_bk','exempt_fdcpa_cease','exempt_discharge','not_applicable')),
  live_satisfied_by_contact_id uuid REFERENCES contacts(id),
  good_faith_record_id  uuid,
  notice_status         text NOT NULL DEFAULT 'open' CHECK (notice_status IN ('open','sent','satisfied_by_prior_180','cancelled_paid','exempt_bk_no_option','exempt_bk_cease','exempt_fdcpa_no_option','exempt_fdcpa_bk','deferred_transferee','not_applicable')),
  notice_id             uuid REFERENCES notices(id),
  notice_variant        text,
  cancelled_at          timestamptz,
  cancel_reason         text,
  UNIQUE (loan_id, due_date)
);
CREATE TABLE phone_numbers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id              uuid NOT NULL REFERENCES parties(id),
  e164_enc              bytea NOT NULL,
  e164_hash             text NOT NULL,
  line_type             text NOT NULL DEFAULT 'unknown' CHECK (line_type IN ('mobile','landline','voip','unknown')),
  line_type_checked_at  timestamptz,
  source                text CHECK (source IN ('application','borrower_provided','prior_servicer','skip_trace','inbound_caller_id')),
  tcpa_voice_consent_id uuid REFERENCES consents(id),
  tcpa_sms_consent_id   uuid REFERENCES consents(id),
  workplace             boolean NOT NULL DEFAULT false,
  employer_prohibits    boolean NOT NULL DEFAULT false,
  inconvenient_windows  jsonb,
  dnc                   boolean NOT NULL DEFAULT false,
  reassigned_check_at   timestamptz,
  last_good_contact_at  timestamptz,
  bad_number_count      int NOT NULL DEFAULT 0,
  time_zone             text
);
COMMENT ON COLUMN phone_numbers.e164_enc IS 'pii';
CREATE TABLE contact_attempt_plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  cycle_no              int NOT NULL,
  cycle_start           date NOT NULL,
  cycle_due_at          timestamptz NOT NULL,
  planned_attempts      jsonb NOT NULL DEFAULT '[]',
  status                text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','satisfied','ceased','suspended')),
  cease_reason          text CHECK (cease_reason IN ('qrpc_workout','resolved','brp_complete','ptp_pending','qrpc_no_interest','pre_sale_stop','bankruptcy','cease_request','attorney','transfer_out','deceased_pending_sii')),
  resume_at             timestamptz,
  UNIQUE (loan_id, cycle_no)
);
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS attempt_plan_id uuid REFERENCES contact_attempt_plans(id),
  ADD COLUMN IF NOT EXISTS phone_number_id uuid REFERENCES phone_numbers(id),
  ADD COLUMN IF NOT EXISTS outcome text,
  ADD COLUMN IF NOT EXISTS live_contact_basis text CHECK (live_contact_basis IN ('ai_voice_flag','human_voice','in_person','borrower_initiated','authorized_agent')),
  ADD COLUMN IF NOT EXISTS regx_windows_satisfied uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS fnma_cycle_id uuid,
  ADD COLUMN IF NOT EXISTS regf_counted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS regf_person_id uuid,
  ADD COLUMN IF NOT EXISTS regf_exclusion text CHECK (regf_exclusion IN ('consent_within_7d','not_connected','professional')),
  ADD COLUMN IF NOT EXISTS tcpa_consent_id uuid REFERENCES consents(id),
  ADD COLUMN IF NOT EXISTS tcpa_basis text CHECK (tcpa_basis IN ('consent','human_manual_dial','landline_exempt_3in30','n/a')),
  ADD COLUMN IF NOT EXISTS quiet_hours_check jsonb,
  ADD COLUMN IF NOT EXISTS ai_disclosure_at timestamptz,
  ADD COLUMN IF NOT EXISTS recording_disclosure_at timestamptz,
  ADD COLUMN IF NOT EXISTS fdcpa_disclosure_at timestamptz,
  ADD COLUMN IF NOT EXISTS recording_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS duration_s int,
  ADD COLUMN IF NOT EXISTS human_agent_id uuid REFERENCES personnel(id),
  ADD COLUMN IF NOT EXISTS purpose text;
CREATE TABLE good_faith_effort_records (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  window_id             uuid NOT NULL REFERENCES regx_ei_windows(id),
  determined_at         timestamptz NOT NULL DEFAULT now(),
  attempts              uuid[] NOT NULL DEFAULT '{}',
  channels              text[] NOT NULL DEFAULT '{}',
  written_encouragement_notice_ids uuid[] NOT NULL DEFAULT '{}',
  reasonableness_rationale text NOT NULL,
  decision_id           uuid REFERENCES agent_decisions(id)
);
ALTER TABLE regx_ei_windows ADD CONSTRAINT regx_ei_windows_gf_fk FOREIGN KEY (good_faith_record_id) REFERENCES good_faith_effort_records(id);
CREATE TABLE contact_preferences (
  party_id              uuid PRIMARY KEY REFERENCES parties(id),
  preferred_channel     text,
  preferred_windows     jsonb,
  language              text,
  do_not_call_reason    text,
  human_only            boolean NOT NULL DEFAULT false,
  set_by                text NOT NULL,
  set_at                timestamptz NOT NULL DEFAULT now()
);
CREATE MATERIALIZED VIEW frequency_counters AS
  SELECT regf_person_id, loan_id,
         count(*) FILTER (WHERE mode = 'call' AND attempted_at > now() - interval '7 days') AS calls_7d,
         max(attempted_at) FILTER (WHERE outcome IN ('conversation','qrpc')) AS last_conversation_at
  FROM contacts WHERE regf_person_id IS NOT NULL GROUP BY regf_person_id, loan_id;

-- 11.2
CREATE TABLE ei_notice_cycles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  notice_id             uuid REFERENCES notices(id),
  variant               text NOT NULL CHECK (variant IN ('standard','fdcpa','bk','bk_fdcpa')),
  provided_at           date NOT NULL,
  cycle_end_at          date NOT NULL,
  next_required_by      date,
  bk_case_id            uuid REFERENCES cases(id),
  fdcpa_cycle_end_190   date,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','closed'))
);
CREATE TABLE solicitation_packages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  kind                  text NOT NULL CHECK (kind IN ('form745_letter','bsp')),
  trigger               text NOT NULL CHECK (trigger IN ('day45_no_qrpc','qrpc_no_resolution','resolicit')),
  sent_at               timestamptz,
  channel               text,
  form_745_version      text,
  form_710_version      text,
  includes_4506c        boolean NOT NULL DEFAULT false,
  hope_hotline_present  boolean NOT NULL DEFAULT false,
  document_ids          uuid[] NOT NULL DEFAULT '{}',
  fnma_action_event_id  uuid REFERENCES investor_events(id),
  previous_bsp_id       uuid REFERENCES solicitation_packages(id)
);

-- 11.3 QRPC
ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS authorization_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS authorization_scope text CHECK (authorization_scope IN ('discuss_only','receive_documents','negotiate')),
  ADD COLUMN IF NOT EXISTS authorization_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS authorization_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS counselor_agency_id text;
CREATE TABLE promises (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  party_id              uuid REFERENCES parties(id),
  qrpc_id               uuid,
  amount_cents          bigint NOT NULL,
  covers                text NOT NULL CHECK (covers IN ('full_delinquent_amount','partial')),
  due_on                date NOT NULL,
  method                text CHECK (method IN ('ach_scheduled','portal','phone_pay','mail','other')),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','kept','partial','broken','cancelled')),
  payment_ids           uuid[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE qrpc_records (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  contact_id            uuid NOT NULL REFERENCES contacts(id),
  party_id              uuid REFERENCES parties(id),
  party_role            text NOT NULL CHECK (party_role IN ('borrower','co_borrower','trusted_advisor','authorized_third_party','confirmed_successor','bk_counsel')),
  authorization_id      uuid REFERENCES documents(id),
  achieved_at           timestamptz NOT NULL,
  channel               text NOT NULL,
  conducted_by          text NOT NULL CHECK (conducted_by IN ('ai_agent','human_agent','ai_with_human_join')),
  live_contact_counted  boolean NOT NULL DEFAULT true,
  human_verified_by     text,
  human_verified_at     timestamptz,
  reason_primary        text NOT NULL,
  reason_secondary      text[] NOT NULL DEFAULT '{}',
  reason_narrative      text,
  fnma_reason_code      char(3),
  fnma_reason_type      text,
  hardship_nature       text CHECK (hardship_nature IN ('temporary','permanent','unknown')),
  hardship_started_on   date,
  hardship_expected_end_on date,
  occupancy_status      text CHECK (occupancy_status IN ('borrower_occupied_principal','second_home','tenant_occupied','vacant','unknown')),
  occupancy_intent      text CHECK (occupancy_intent IN ('retain','sell','vacate_or_surrender','undecided')),
  ability_to_pay        text CHECK (ability_to_pay IN ('can_pay_now','can_pay_by_date','can_pay_partial','cannot_pay','unknown')),
  stated_monthly_income_cents bigint,
  stated_monthly_expenses_cents bigint,
  stated_surplus_cents  bigint,
  can_resume_full_payment_on date,
  options_explained     jsonb NOT NULL DEFAULT '[]',
  payment_importance_emphasized boolean NOT NULL DEFAULT false,
  commitment_kind       text CHECK (commitment_kind IN ('promise_to_pay_full','promise_to_pay_partial','brp_submission','forbearance_request','repayment_plan_request','deferral_request','modification_request','liquidation_request','no_interest','refused','callback_only')),
  promise_id            uuid REFERENCES promises(id),
  next_action           text,
  next_action_due_on    date,
  resolution_status     text NOT NULL DEFAULT 'none' CHECK (resolution_status IN ('none','ptp_pending','workout_in_progress','resolved')),
  transcript_document_id uuid REFERENCES documents(id),
  decision_id           uuid REFERENCES agent_decisions(id),
  fnma_reported_event_id uuid REFERENCES investor_events(id),
  superseded_by         uuid REFERENCES qrpc_records(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN qrpc_records.stated_monthly_income_cents IS 'pii';
CREATE TRIGGER qrpc_records_immutable BEFORE UPDATE OR DELETE ON qrpc_records FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE promises ADD CONSTRAINT promises_qrpc_fk FOREIGN KEY (qrpc_id) REFERENCES qrpc_records(id);

-- 11.4 FDCPA
CREATE TABLE fdcpa_status (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  debt_collector        boolean NOT NULL,
  determination_basis   text NOT NULL CHECK (determination_basis IN ('default_at_obtain','bankruptcy_at_obtain','foreclosure_at_obtain','counsel_override','not_in_default')),
  regx_days_delinquent_at_boarding int,
  threshold_days        int,
  determined_at         timestamptz NOT NULL DEFAULT now(),
  rule_version          text,
  initial_communication_at timestamptz,
  initial_communication_channel text,
  validation_notice_id  uuid REFERENCES notices(id),
  validation_sent_at    timestamptz,
  validation_channel    text,
  assumed_receipt_on    date,
  validation_period_end_on date,
  oc_request_at         timestamptz,
  oc_response_sent_at   timestamptz,
  cease_received_at     timestamptz,
  cease_document_id     uuid REFERENCES documents(id),
  cease_by_party_id     uuid REFERENCES parties(id),
  cease_scope           text CHECK (cease_scope IN ('written_full','oral_calls_only')),
  attorney_party_id     uuid REFERENCES parties(id),
  attorney_nonresponse_since timestamptz,
  workplace_prohibited  boolean NOT NULL DEFAULT false,
  furnishing_gate_open_at timestamptz,
  undeliverable_at      timestamptz,
  state_overlays        text[] NOT NULL DEFAULT '{}',
  assumed_name_used     text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fdcpa_disputes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  received_at           timestamptz NOT NULL,
  channel               text,
  within_validation_period boolean NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('dispute','original_creditor_request')),
  basis                 text CHECK (basis IN ('not_my_debt','amount_wrong','other')),
  duplicative_of        uuid REFERENCES fdcpa_disputes(id),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','verification_sent','oc_sent','duplicative_notified','closed')),
  noe_case_id           uuid REFERENCES cases(id),
  collection_ceased_at  timestamptz,
  collection_resumed_at timestamptz,
  verification_document_ids uuid[] NOT NULL DEFAULT '{}'
);
CREATE TABLE validation_notices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  notice_id             uuid REFERENCES notices(id),
  itemization_date_kind text NOT NULL CHECK (itemization_date_kind IN ('last_statement','last_payment','charge_off','transaction','judgment')),
  itemization_date      date NOT NULL,
  amount_on_itemization_cents bigint NOT NULL,
  interest_since_cents  bigint NOT NULL DEFAULT 0,
  fees_since_cents      bigint NOT NULL DEFAULT 0,
  payments_since_cents  bigint NOT NULL DEFAULT 0,
  credits_since_cents   bigint NOT NULL DEFAULT 0,
  current_amount_cents  bigint NOT NULL,
  periodic_statement_substitute boolean NOT NULL DEFAULT false,
  statement_document_id uuid REFERENCES documents(id),
  language              text,
  english_included      boolean NOT NULL DEFAULT true,
  esign_consent_id      uuid REFERENCES consents(id)
);

-- 11.5 imminent default
CREATE TABLE credit_scores (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id           uuid NOT NULL REFERENCES borrowers(id),
  pulled_at             timestamptz NOT NULL,
  bureau                text NOT NULL,
  score                 int NOT NULL,
  model                 text,
  permissible_purpose   text NOT NULL,
  document_id           uuid REFERENCES documents(id)
);
COMMENT ON COLUMN credit_scores.score IS 'pii';
CREATE TABLE imminent_default_evaluations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  lossmit_case_id       uuid REFERENCES cases(id),
  requested_at          timestamptz NOT NULL,
  request_source        text,
  evaluation_date       date NOT NULL,
  regx_days_delinquent_at_eval int NOT NULL,
  fnma_delinquency_status_at_eval text,
  workout_track         text NOT NULL CHECK (workout_track IN ('modification','short_sale','mortgage_release')),
  principal_residence   boolean NOT NULL,
  pcs_exception         boolean NOT NULL DEFAULT false,
  pcs_distance_miles    numeric(8,2),
  brp_complete_at       timestamptz,
  income_doc_oldest_date date,
  cash_reserves_cents   bigint,
  cash_reserves_pass    boolean,
  hardship_type         text,
  hardship_documented   boolean NOT NULL DEFAULT false,
  hardship_document_ids uuid[] NOT NULL DEFAULT '{}',
  credit_path           jsonb,
  hardship_path         jsonb,
  eligibility_result    text NOT NULL CHECK (eligibility_result IN ('eligible_hardship','eligible_credit','ineligible','pending_documents','rerouted_delinquent','withdrawn')),
  ineligibility_reasons text[] NOT NULL DEFAULT '{}',
  smdu_case_id          text,
  smdu_submission_id    text,
  smdu_decision         text CHECK (smdu_decision IN ('approved','declined','counteroffer','pending')),
  smdu_decided_at       timestamptz,
  imminent_default_indicator boolean,
  reviewer_id           text,
  reviewed_at           timestamptz,
  adverse_notice_id     uuid REFERENCES notices(id),
  adverse_notice_due_on date,
  decision_id           uuid REFERENCES agent_decisions(id),
  superseded_by         uuid REFERENCES imminent_default_evaluations(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN imminent_default_evaluations.credit_path IS 'pii';
CREATE TRIGGER imminent_default_evaluations_immutable BEFORE UPDATE OR DELETE ON imminent_default_evaluations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
