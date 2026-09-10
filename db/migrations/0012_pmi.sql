-- 0012_pmi.sql — Section 10 (10.1–10.6): MI policies, schedules, LTV snapshots, cases, valuations, evaluations, terminations, disclosures, refunds, denials.
BEGIN;

CREATE TABLE mi_schedules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  version               int NOT NULL,
  basis                 text NOT NULL CHECK (basis IN ('initial','arm_reset','modification','correction')),
  effective_from        date NOT NULL,
  rate_bps              int NOT NULL,
  payment_cents         bigint NOT NULL,
  start_balance_cents   bigint NOT NULL,
  term_months_remaining int NOT NULL,
  io_months             int NOT NULL DEFAULT 0,
  forborne_principal_cents bigint NOT NULL DEFAULT 0,
  derived_80_date       date,
  derived_78_date       date,
  derived_midpoint_date date,
  superseded_by         uuid REFERENCES mi_schedules(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, version)
);
CREATE TABLE mi_schedule_rows (
  schedule_id           uuid NOT NULL REFERENCES mi_schedules(id),
  payment_no            int NOT NULL,
  due_date              date NOT NULL,
  scheduled_upb_cents   bigint NOT NULL,
  PRIMARY KEY (schedule_id, payment_no)
);
CREATE TRIGGER mi_schedule_rows_immutable BEFORE UPDATE OR DELETE ON mi_schedule_rows FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE mi_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  insurer_code          text NOT NULL,
  insurer_name          text NOT NULL,
  certificate_number_enc bytea,
  coverage_pct          numeric(5,2) NOT NULL,
  premium_plan          text NOT NULL CHECK (premium_plan IN ('bpmi_monthly','bpmi_annual','bpmi_single','bpmi_split','financed_single','lpmi_monthly','lpmi_single')),
  renewal_type          text CHECK (renewal_type IN ('constant','declining','level')),
  premium_rate_bps      int,
  premium_amount_cents  bigint,
  premium_paid_through  date,
  refundable            boolean NOT NULL DEFAULT false,
  hpa_covered           boolean NOT NULL,
  sales_price_cents     bigint,
  appraised_value_cents bigint,
  is_refinance          boolean NOT NULL DEFAULT false,
  original_value_cents  bigint,
  original_value_evidence_document_id uuid REFERENCES documents(id),
  original_appraised_value_cents bigint,
  occupancy_at_origination text NOT NULL CHECK (occupancy_at_origination IN ('principal','second_home','investment')),
  units                 smallint NOT NULL CHECK (units BETWEEN 1 AND 4),
  consummation_date     date NOT NULL,
  amortization_start    date NOT NULL,
  amortization_term_months int NOT NULL,
  maturity_date         date,
  midpoint_date         date,
  midpoint_termination_date date,
  midpoint_basis        text NOT NULL DEFAULT 'consummation' CHECK (midpoint_basis IN ('consummation','modification')),
  midpoint_schedule_id  uuid REFERENCES mi_schedules(id),
  scheduled_80_date     date,
  scheduled_78_date     date,
  active_schedule_id    uuid REFERENCES mi_schedules(id),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancel_pending','cancelled','terminated','insurer_cancelled','rescinded','transferred_out','lapsed')),
  termination_type      text CHECK (termination_type IN ('borrower_original_value','borrower_current_value','automatic_78','automatic_midpoint','state_law','insurer_initiated','high_risk')),
  terminated_on         date,
  lar89_action_code     char(2) CHECK (lar89_action_code IN ('51','52','53','54')),
  auto_status           text NOT NULL DEFAULT 'pending' CHECK (auto_status IN ('pending','deferred_not_current','terminated','not_applicable_midpoint_only')),
  auto_deferred_since   date,
  not_current_notice_id uuid REFERENCES notices(id),
  became_current_on     date,
  last_annual_disclosure_on date,
  next_annual_disclosure_due date,
  lpmi_equiv_termination_date date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN mi_policies.certificate_number_enc IS 'pii';
CREATE UNIQUE INDEX mi_policies_one_active ON mi_policies(loan_id) WHERE status IN ('active','cancel_pending');
-- 10.1: original value only changes with evidence
CREATE OR REPLACE FUNCTION mi_original_value_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.original_value_cents IS DISTINCT FROM OLD.original_value_cents AND NEW.original_value_evidence_document_id IS NULL THEN
    RAISE EXCEPTION 'mi_policies.original_value_cents requires an evidence document (mi.original_value.corrected)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mi_policies_original_value_guard BEFORE UPDATE ON mi_policies FOR EACH ROW EXECUTE FUNCTION mi_original_value_guard();

CREATE TABLE mi_ltv_snapshots (
  loan_id               uuid NOT NULL REFERENCES loans(id),
  as_of                 date NOT NULL,
  scheduled_upb_cents   bigint NOT NULL,
  evaluation_upb_cents  bigint NOT NULL,
  scheduled_ltv_bps     int NOT NULL,
  actual_ltv_bps        int NOT NULL,
  basis_value_cents     bigint NOT NULL,
  PRIMARY KEY (loan_id, as_of)
);
CREATE TABLE mi_holder_config (
  holder                text PRIMARY KEY,
  require_sub_lien_cert boolean NOT NULL DEFAULT false,
  evidence_types        text[] NOT NULL DEFAULT '{smdu_avm,smdu_bpo,smdu_appraisal}',
  verbal_request_accepted boolean NOT NULL DEFAULT true
);
CREATE TABLE mi_valuations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  kind                  text NOT NULL CHECK (kind IN ('avm','bpo_int_ext','appraisal_restricted','appraisal_1025')),
  source                text NOT NULL CHECK (source IN ('smdu_avm','smdu_order','borrower_supplied_rejected')),
  smdu_order_id         text,
  ordered_at            timestamptz,
  fee_cents             bigint NOT NULL DEFAULT 0,
  fee_ledger_entry_set_id uuid REFERENCES ledger_entry_sets(id),
  status                text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','in_progress','completed','cancelled','appealed')),
  value_cents           bigint,
  delivered_at          timestamptz,
  valid_until           date,
  appeal_submitted_at   timestamptz,
  report_document_id    uuid REFERENCES documents(id),
  invoice_id            text,
  crs_360_remittance_id uuid REFERENCES remittances(id)
);
CREATE TABLE mi_cases (
  case_id               uuid PRIMARY KEY REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  mi_policy_id          uuid NOT NULL REFERENCES mi_policies(id),
  request_channel       text NOT NULL CHECK (request_channel IN ('written','verbal','portal','sii')),
  received_at           timestamptz NOT NULL,
  written_confirmed_at  timestamptz,
  basis_requested       text,
  basis_evaluated       text,
  hpa_path              boolean NOT NULL DEFAULT false,
  evidence_type_disclosed_at timestamptz,
  sub_lien_cert_required boolean NOT NULL DEFAULT false,
  sub_lien_cert_received_at timestamptz,
  fee_required_cents    bigint NOT NULL DEFAULT 0,
  fee_received_at       timestamptz,
  evidence_satisfied_at timestamptz,
  valuation_id          uuid REFERENCES mi_valuations(id),
  smdu_evaluation_id    text,
  decision              text CHECK (decision IN ('eligible','ineligible','withdrawn','expired')),
  decision_at           timestamptz,
  decision_reasons      jsonb NOT NULL DEFAULT '[]',
  cancellation_effective_date date,
  denial_notice_id      uuid REFERENCES notices(id),
  state_overlay         text
);
CREATE TABLE mi_evaluations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES mi_cases(case_id),
  evaluated_at          timestamptz NOT NULL DEFAULT now(),
  rule_set_version      text NOT NULL,
  path                  text NOT NULL CHECK (path IN ('hpa_original','fnma_original','fnma_current','fnma_current_improvements','state_MN','state_NY')),
  basis_value_cents     bigint NOT NULL,
  evaluation_upb_cents  bigint NOT NULL,
  ltv_bps               int NOT NULL,
  threshold_bps         int,
  seasoning_months      int,
  is_current            boolean,
  late30_12m            int,
  late60_24m            int,
  disaster_excluded_count int NOT NULL DEFAULT 0,
  value_not_declined    boolean,
  smdu_decision         text,
  smdu_messages         jsonb,
  liability_relief      boolean,
  result                text NOT NULL,
  reasons               text[] NOT NULL DEFAULT '{}',
  agent_decision_id     uuid REFERENCES agent_decisions(id)
);
CREATE TRIGGER mi_evaluations_immutable BEFORE UPDATE OR DELETE ON mi_evaluations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE mi_terminations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  mi_policy_id          uuid NOT NULL REFERENCES mi_policies(id),
  type                  text NOT NULL,
  effective_date        date NOT NULL,
  basis_schedule_id     uuid REFERENCES mi_schedules(id),
  lar89_action_code     char(2) NOT NULL,
  investor_event_id     uuid REFERENCES investor_events(id),
  insurer_message_id    uuid REFERENCES integration_messages(id),
  notice_id             uuid REFERENCES notices(id),
  escrow_analysis_id    uuid REFERENCES escrow_analyses(id),
  refund_id             uuid,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER mi_terminations_immutable BEFORE UPDATE OR DELETE ON mi_terminations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE mi_disclosures (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  mi_policy_id          uuid NOT NULL REFERENCES mi_policies(id),
  kind                  text NOT NULL CHECK (kind IN ('annual_a3','annual_b_legacy','mn_47_207','ca_2954_6','lpmi_options','initial_origination_copy')),
  period_start          date,
  period_end            date,
  due_on                date NOT NULL,
  notice_id             uuid REFERENCES notices(id),
  channel               text,
  included_with         text CHECK (included_with IN ('escrow_statement','form_1098','standalone')),
  projected_80_date     date,
  projected_78_date     date,
  projected_midpoint_date date,
  schedule_version_id   uuid REFERENCES mi_schedules(id),
  sent_at               timestamptz,
  delivery_evidence_document_id uuid REFERENCES documents(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER mi_disclosures_immutable BEFORE UPDATE OR DELETE ON mi_disclosures FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE mi_refund_schedules (
  insurer_code          text NOT NULL,
  plan                  text NOT NULL,
  months_in_force       int NOT NULL,
  refund_pct_bps        int NOT NULL,
  PRIMARY KEY (insurer_code, plan, months_in_force)
);
CREATE TABLE mi_refunds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  mi_policy_id          uuid NOT NULL REFERENCES mi_policies(id),
  termination_id        uuid REFERENCES mi_terminations(id),
  effective_date        date NOT NULL,
  leg                   text NOT NULL CHECK (leg IN ('insurer_unearned','escrow_mi_line','lpmi_corporate')),
  estimate_cents        bigint NOT NULL,
  method                text NOT NULL CHECK (method IN ('days_365','days_30','single_schedule','hpa_schedule','insurer_stated')),
  coverage_paid_through date,
  days_in_force         int,
  insurer_notified_at   timestamptz,
  insurer_amount_cents  bigint,
  insurer_received_at   timestamptz,
  variance_cents        bigint,
  payee_party_id        uuid REFERENCES parties(id),
  pay_channel           text CHECK (pay_channel IN ('ach_credit','check','escrow_credit_disallowed')),
  paid_at               timestamptz,
  advance_ledger_entry_set_id uuid REFERENCES ledger_entry_sets(id),
  recovered_at          timestamptz,
  status                text NOT NULL DEFAULT 'estimated' CHECK (status IN ('estimated','awaiting_insurer','received','paid','advanced_paid','disputed','closed')),
  created_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mi_terminations ADD CONSTRAINT mi_terminations_refund_fk FOREIGN KEY (refund_id) REFERENCES mi_refunds(id);

CREATE TABLE mi_denial_reasons (
  code                  text PRIMARY KEY,
  hpa_ground            text,
  fnma_ground           text,
  required_fields       text[] NOT NULL DEFAULT '{}',
  cure_text_template    text
);
INSERT INTO mi_denial_reasons(code) VALUES ('LTV_ABOVE_THRESHOLD_ORIGINAL'),('LTV_ABOVE_THRESHOLD_CURRENT'),('NOT_CURRENT'),('PAYMENT_HISTORY_30_12M'),('PAYMENT_HISTORY_60_24M'),('VALUE_DECLINED_BELOW_ORIGINAL'),('SEASONING_LT_24M'),('SEASONING_LT_60M_LTV_GT_75'),('IMPROVEMENTS_NOT_SUBSTANTIATED'),('PROPERTY_TYPE_70_RULE'),('ASSUMPTION_HISTORY_LT_24M'),('EVIDENCE_NOT_RECEIVED'),('SUBORDINATE_LIEN_CERT_MISSING'),('MI_NOT_BORROWER_PAID'),('MI_NOT_ACTIVE'),('REQUEST_NOT_FROM_AUTHORIZED_PARTY');
CREATE TABLE mi_denials (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES mi_cases(case_id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  kind                  text NOT NULL CHECK (kind IN ('request_denial','auto_not_current','midpoint_not_current','case_expired','info_request')),
  determined_at         timestamptz NOT NULL DEFAULT now(),
  evaluation_id         uuid REFERENCES mi_evaluations(id),
  reason_codes          text[] NOT NULL DEFAULT '{}',
  reason_data           jsonb NOT NULL DEFAULT '{}',
  valuation_id          uuid REFERENCES mi_valuations(id),
  notice_id             uuid REFERENCES notices(id),
  due_on                date NOT NULL,
  sent_at               timestamptz,
  human_review_requested_at timestamptz,
  human_review_outcome  text,
  qc_sampled            boolean NOT NULL DEFAULT false,
  superseded_by_grant_id uuid REFERENCES mi_terminations(id)
);
CREATE TRIGGER mi_denials_immutable BEFORE UPDATE OR DELETE ON mi_denials FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
