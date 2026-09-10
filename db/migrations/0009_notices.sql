-- 0009_notices.sql — Section 7 (7.1–7.6): Notice Registry, statements, ARM, E-SIGN consents, privacy, payoff requests.
BEGIN;


-- Notice Registry
CREATE TABLE notice_templates (
  code                  text PRIMARY KEY,                          -- NTC_*, INS_*
  name                  text NOT NULL,
  citation              text,
  owner_section         text NOT NULL,
  notice_class          text,                                      -- E-SIGN consent class (7.4)
  channel_policy        text NOT NULL DEFAULT 'esign_or_mail' CHECK (channel_policy IN ('esign_or_mail','mail_only','electronic_ok_without_esign')),
  separate_document     boolean NOT NULL DEFAULT false,
  may_combine_with      text[] NOT NULL DEFAULT '{}',
  retention             retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  pii_level             text NOT NULL DEFAULT 'medium'
);
CREATE TABLE notice_template_versions (
  template_code         text NOT NULL REFERENCES notice_templates(code),
  version               text NOT NULL,
  effective_from        date NOT NULL,
  effective_to          date,
  source_hash           text NOT NULL,
  sample_form_basis     text,
  content_rules         jsonb NOT NULL DEFAULT '[]',
  layout_rules          jsonb NOT NULL DEFAULT '[]',
  readability           jsonb,
  plain_language_status text NOT NULL DEFAULT 'draft' CHECK (plain_language_status IN ('draft','ai_reviewed','counsel_approved','retired')),
  approved_by           text,
  approved_at           timestamptz,
  rule_set              text,
  PRIMARY KEY (template_code, version)
);
CREATE TABLE notices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_code         text NOT NULL REFERENCES notice_templates(code),
  template_version      text NOT NULL,
  loan_id               uuid REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  recipient_party_ids   uuid[] NOT NULL DEFAULT '{}',
  address_snapshot      jsonb,
  payload_hash          text NOT NULL,
  payload               jsonb NOT NULL,
  document_id           uuid REFERENCES documents(id),
  channel_decision      jsonb,
  status                text NOT NULL DEFAULT 'rendered' CHECK (status IN ('rendered','held','sent','delivered','bounced','returned','superseded')),
  held_reason           text,
  produced_at           timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz,
  superseded_by         uuid REFERENCES notices(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN notices.address_snapshot IS 'pii';
CREATE INDEX notices_loan_idx ON notices(loan_id, template_code, created_at);
-- append-only: status transitions are allowed, content is not
CREATE OR REPLACE FUNCTION notices_content_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload_hash <> OLD.payload_hash OR NEW.template_code <> OLD.template_code OR NEW.template_version <> OLD.template_version OR NEW.payload <> OLD.payload THEN
    RAISE EXCEPTION 'notices content is append-only; supersede instead';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notices_content_immutable BEFORE UPDATE ON notices FOR EACH ROW EXECUTE FUNCTION notices_content_immutable();
CREATE TRIGGER notices_no_delete BEFORE DELETE ON notices FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE notice_checklist_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id             uuid NOT NULL REFERENCES notices(id),
  template_version      text NOT NULL,
  passed                boolean NOT NULL,
  results               jsonb NOT NULL,
  evaluated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notice_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_type            text NOT NULL,
  business_date         date NOT NULL,
  counts                jsonb NOT NULL DEFAULT '{}',
  vendor_file_id        text,
  status                text NOT NULL DEFAULT 'open'
);
CREATE TABLE notice_deliveries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id             uuid NOT NULL REFERENCES notices(id),
  attempt_no            smallint NOT NULL DEFAULT 1,
  channel               text NOT NULL CHECK (channel IN ('mail_first_class','mail_certified','email_link','portal_post','sms_link')),
  vendor                text,
  vendor_piece_id       text,
  imb                   text,
  submitted_at          timestamptz,
  manifest_id           uuid REFERENCES notice_batches(id),
  mailed_at             timestamptz,
  usps_scans            jsonb,
  email_message_id      text,
  email_status          text CHECK (email_status IN ('sent','delivered','bounced','complained')),
  link_first_opened_at  timestamptz,
  returned_at           timestamptz,
  return_reason         text,
  fallback_of           uuid REFERENCES notice_deliveries(id),
  UNIQUE (notice_id, attempt_no)
);

-- 7.1 statements
CREATE TABLE statement_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  payload               jsonb NOT NULL,
  hash                  text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER statement_snapshots_immutable BEFORE UPDATE OR DELETE ON statement_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE statement_cycles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  cycle_due_date        date NOT NULL,
  courtesy_period_end   date NOT NULL,
  statement_due_by      date NOT NULL,
  variant               text NOT NULL CHECK (variant IN ('standard','delinquent','tpp','accelerated','bk_ch7_11','bk_ch12_13','coupon_book','exempt_bk','exempt_charged_off','suppressed_transfer')),
  exemption_reason      text,
  single_statement_exemption_used boolean NOT NULL DEFAULT false,
  snapshot_id           uuid REFERENCES statement_snapshots(id),
  notice_id             uuid REFERENCES notices(id),
  status                text NOT NULL DEFAULT 'pending',
  generated_at          timestamptz,
  UNIQUE (loan_id, cycle_due_date)
);
CREATE TABLE tax_forms_1098 (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  tax_year              smallint NOT NULL,
  payer_party_id        uuid REFERENCES parties(id),
  boxes                 jsonb NOT NULL,                             -- box1..box11
  tin_status            text,
  furnished_at          timestamptz,
  channel               text,
  filed_at              timestamptz,
  irs_receipt_id        text,
  corrected_of          uuid REFERENCES tax_forms_1098(id),
  retention             retention_class NOT NULL DEFAULT 'tax_4y'
);

-- 7.2 / 7.3 ARM
ALTER TABLE loan_terms
  ADD COLUMN IF NOT EXISTS fnma_arm_plan text,
  ADD COLUMN IF NOT EXISTS index_type text,
  ADD COLUMN IF NOT EXISTS index_source_url text,
  ADD COLUMN IF NOT EXISTS margin_bps int,
  ADD COLUMN IF NOT EXISTS lookback_days int,
  ADD COLUMN IF NOT EXISTS first_change_date date,
  ADD COLUMN IF NOT EXISTS adjustment_period_months int,
  ADD COLUMN IF NOT EXISTS initial_cap_bps int,
  ADD COLUMN IF NOT EXISTS periodic_cap_bps int,
  ADD COLUMN IF NOT EXISTS lifetime_cap_bps int,
  ADD COLUMN IF NOT EXISTS floor_rate_bps int,
  ADD COLUMN IF NOT EXISTS rounding_rule text DEFAULT 'nearest_eighth_half_down',
  ADD COLUMN IF NOT EXISTS interest_only_until date,
  ADD COLUMN IF NOT EXISTS neg_am_limit_pct numeric(6,3),
  ADD COLUMN IF NOT EXISTS payment_cap_pct numeric(6,3),
  ADD COLUMN IF NOT EXISTS conversion_option boolean,
  ADD COLUMN IF NOT EXISTS replacement_index jsonb;
CREATE TABLE arm_index_captures (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  index_type            text NOT NULL,
  effective_date        date NOT NULL,
  value                 numeric(10,5) NOT NULL,
  source                text NOT NULL,
  captured_at           timestamptz NOT NULL DEFAULT now(),
  revision_of           uuid REFERENCES arm_index_captures(id)
);
CREATE TABLE arm_schedule (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  change_date           date NOT NULL,
  index_date            date NOT NULL,
  first_new_payment_due date NOT NULL,
  notice_window_open    date,
  notice_due_by         date,
  notice_kind           text CHECK (notice_kind IN ('c_60_120','c_25_120','c_first_25','fnma_only')),
  is_initial            boolean NOT NULL DEFAULT false,
  initial_notice_window_open date,
  initial_notice_due_by date,
  initial_notice_id     uuid REFERENCES notices(id),
  initial_notice_basis  text CHECK (initial_notice_basis IN ('estimate','actual')),
  status                text NOT NULL DEFAULT 'scheduled',
  UNIQUE (loan_id, change_date)
);
CREATE TABLE arm_adjustments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  change_date           date NOT NULL,
  index_date            date NOT NULL,
  index_value           numeric(10,5) NOT NULL,
  index_publication_date date,
  index_capture_id      uuid REFERENCES arm_index_captures(id),
  margin_bps            int NOT NULL,
  unrounded_rate        numeric(12,8) NOT NULL,
  rounded_rate_bps      int NOT NULL,
  cap_test              jsonb NOT NULL,
  new_rate_bps          int NOT NULL,
  prior_rate_bps        int NOT NULL,
  expected_upb_cents    bigint NOT NULL,
  remaining_term_months int NOT NULL,
  new_pi_cents          bigint NOT NULL,
  prior_pi_cents        bigint NOT NULL,
  escrow_cents          bigint,
  first_new_payment_due date NOT NULL,
  status                text NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated','verified','noticed','effective','corrected','superseded')),
  verified_by           text CHECK (verified_by IN ('engine_b','human')),
  notice_id             uuid REFERENCES notices(id),
  investor_event_id     uuid REFERENCES investor_events(id),
  correction_of         uuid REFERENCES arm_adjustments(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE arm_corrections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  detected_at           timestamptz NOT NULL,
  first_erroneous_change_date date NOT NULL,
  reamortization        jsonb,
  net_effect_cents      bigint NOT NULL,
  remedy                text CHECK (remedy IN ('cash_refund','reallocation','upb_reduction','none_undercharge')),
  borrower_election     text,
  irr_discussed_at      timestamptz,
  fnma_reported_at      timestamptz
);
CREATE TABLE arm_initial_estimates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  disclosure_date       date NOT NULL,
  index_effective_date  date NOT NULL,
  index_value           numeric(10,5) NOT NULL,
  est_rate_bps          int NOT NULL,
  est_pi_cents          bigint NOT NULL,
  expected_upb_cents    bigint NOT NULL,
  remaining_term_months int NOT NULL,
  is_estimate           boolean NOT NULL DEFAULT true,
  notice_id             uuid REFERENCES notices(id)
);
ALTER TABLE jurisdiction_rules ADD COLUMN IF NOT EXISTS hfa_contact jsonb;

-- 7.4 E-SIGN consents (baseline extended; append-only)
ALTER TABLE consents
  ADD COLUMN IF NOT EXISTS loan_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS scope text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending_verification','active','suspect','withdrawn','expired','superseded')),
  ADD COLUMN IF NOT EXISTS disclosure_version_id uuid,
  ADD COLUMN IF NOT EXISTS captured_via text,
  ADD COLUMN IF NOT EXISTS email_address_id uuid,
  ADD COLUMN IF NOT EXISTS hw_sw_version text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawal_channel text,
  ADD COLUMN IF NOT EXISTS withdrawal_reason text,
  ADD COLUMN IF NOT EXISTS reconsent_of uuid,
  ADD COLUMN IF NOT EXISTS supersedes uuid;
CREATE TABLE consent_disclosure_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL,
  version               text NOT NULL,
  text_hash             text NOT NULL,
  hw_sw_requirements    jsonb NOT NULL DEFAULT '{}',
  effective_from        date NOT NULL,
  effective_to          date,
  approved_by           text,
  UNIQUE (kind, version)
);
CREATE TABLE delivery_addresses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id              uuid NOT NULL REFERENCES parties(id),
  type                  text NOT NULL CHECK (type IN ('email','mobile')),
  value_enc             bytea NOT NULL,
  value_hash            text NOT NULL,
  verified_at           timestamptz,
  bounce_count          int NOT NULL DEFAULT 0,
  last_bounce_at        timestamptz,
  status                text NOT NULL DEFAULT 'active'
);
COMMENT ON COLUMN delivery_addresses.value_enc IS 'pii';
CREATE TABLE edelivery_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id             uuid NOT NULL REFERENCES notices(id),
  party_id              uuid NOT NULL REFERENCES parties(id),
  posted_at             timestamptz NOT NULL,
  notified_at           timestamptz,
  notification_message_id text,
  viewed_at             timestamptz,
  downloaded_at         timestamptz,
  mail_fallback_notice_id uuid REFERENCES notices(id)
);

-- 7.5 privacy
CREATE TABLE privacy_notice_programs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id            uuid REFERENCES parties(id),
  notice_version        text NOT NULL,
  model_form_variant    text,
  sharing_profile       text NOT NULL CHECK (sharing_profile IN ('exceptions_only','optout_required','optin_state')),
  annual_exception_eligible boolean NOT NULL DEFAULT false,
  last_partner_attestation_at timestamptz,
  effective_from        date NOT NULL,
  effective_to          date
);
ALTER TABLE parties ADD COLUMN IF NOT EXISTS privacy_optout jsonb;
CREATE VIEW privacy_notice_deliveries AS
  SELECT n.id AS notice_id, unnest(n.recipient_party_ids) AS party_id, n.loan_id,
         n.payload->>'kind' AS kind, n.payload->>'basis' AS basis, (n.payload->>'acknowledged_at')::timestamptz AS acknowledged_at, n.sent_at
  FROM notices n WHERE n.template_code LIKE 'NTC_REGP_%';

-- 7.6 payoff requests (figures owned by 16.1)
CREATE TABLE payoff_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  received_at           timestamptz NOT NULL,
  received_channel      text,
  written               boolean NOT NULL DEFAULT true,
  requester_party_id    uuid REFERENCES parties(id),
  requester_type        text CHECK (requester_type IN ('borrower','coborrower','successor_confirmed','attorney','counselor','refinancing_lender','title_escrow','other_agent')),
  authorization_evidence_document_id uuid REFERENCES documents(id),
  requested_good_through date,
  delivery_channel_requested text,
  delivery_address      jsonb,
  state                 char(2),
  deadline_federal      date,
  deadline_state        date,
  reasonable_time_reason text NOT NULL DEFAULT 'none' CHECK (reasonable_time_reason IN ('none','bankruptcy','foreclosure','disaster','other')),
  reason_evidence       text,
  status                text NOT NULL DEFAULT 'received',
  statement_notice_id   uuid REFERENCES notices(id),
  fee_cents             bigint NOT NULL DEFAULT 0,
  superseded_by         uuid REFERENCES payoff_requests(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN payoff_requests.delivery_address IS 'pii';
CREATE TABLE payoff_statements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payoff_request_id     uuid REFERENCES payoff_requests(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  good_through          date NOT NULL,
  upb_cents             bigint NOT NULL,
  interest_cents        bigint NOT NULL,
  per_diem_cents        bigint NOT NULL,
  nib_balance_cents     bigint NOT NULL DEFAULT 0,
  escrow_treatment      text,
  fees                  jsonb NOT NULL DEFAULT '[]',
  late_charges_cents    bigint NOT NULL DEFAULT 0,
  advances_cents        bigint NOT NULL DEFAULT 0,
  suspense_credit_cents bigint NOT NULL DEFAULT 0,
  total_cents           bigint NOT NULL,
  calc_version          text NOT NULL,
  hash                  text NOT NULL,
  notice_id             uuid REFERENCES notices(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payoff_statements_immutable BEFORE UPDATE OR DELETE ON payoff_statements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- back-fill FKs on notice_id columns created earlier as bare uuids
ALTER TABLE escrow_statements ADD CONSTRAINT escrow_statements_notice_fk FOREIGN KEY (notice_id) REFERENCES notices(id);
ALTER TABLE autodraft_notices ADD CONSTRAINT autodraft_notices_notice_fk FOREIGN KEY (notice_id) REFERENCES notices(id);
ALTER TABLE case_assertions ADD CONSTRAINT case_assertions_notice_fk FOREIGN KEY (response_notice_id) REFERENCES notices(id);
ALTER TABLE document_copy_requests ADD CONSTRAINT dcr_fulfilled_fk FOREIGN KEY (fulfilled_notice_id) REFERENCES notices(id);
ALTER TABLE document_copy_requests ADD CONSTRAINT dcr_withheld_fk FOREIGN KEY (withheld_notice_id) REFERENCES notices(id);
ALTER TABLE sii_acknowledgments ADD CONSTRAINT sii_ack_notice_fk FOREIGN KEY (sent_notice_id) REFERENCES notices(id);
ALTER TABLE unclaimed_property_items ADD CONSTRAINT upi_notice_fk FOREIGN KEY (due_diligence_notice_id) REFERENCES notices(id);

COMMIT;
