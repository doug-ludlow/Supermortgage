-- 0004_escrow.sql — Section 3 (3.1–3.9): escrow accounts fixed, analyses, statements, bills, disbursements, waivers, interest.
BEGIN;

-- 3.1 escrow_accounts fields fixed here
ALTER TABLE escrow_accounts
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','waived','closed','suspended')),
  ADD COLUMN IF NOT EXISTS established_at date,
  ADD COLUMN IF NOT EXISTS establishment_reason text CHECK (establishment_reason IN ('origination','waiver_revocation','borrower_request','workout','transfer_in','hpml_required','flood_required')),
  ADD COLUMN IF NOT EXISTS computation_year_start date,
  ADD COLUMN IF NOT EXISTS computation_year_end date,
  ADD COLUMN IF NOT EXISTS payment_frequency text NOT NULL DEFAULT 'monthly' CHECK (payment_frequency IN ('monthly','biweekly')),
  ADD COLUMN IF NOT EXISTS cushion_months numeric(4,2) NOT NULL DEFAULT 2.00 CHECK (cushion_months <= 2.00),
  ADD COLUMN IF NOT EXISTS cushion_cap_source text CHECK (cushion_cap_source IN ('regx','instrument','state','policy')),
  ADD COLUMN IF NOT EXISTS monthly_escrow_payment_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shortage_installment_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shortage_installments_remaining int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deficiency_installment_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deficiency_installments_remaining int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS custodial_account_id uuid REFERENCES custodial_accounts(id),
  ADD COLUMN IF NOT EXISTS interest_rule_code text,
  ADD COLUMN IF NOT EXISTS analysis_lead_days int NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS surplus_retained_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surplus_retained_at timestamptz;

-- 3.2 escrow_lines fixed
ALTER TABLE escrow_lines
  ADD COLUMN IF NOT EXISTS payee_id uuid REFERENCES parties(id),
  ADD COLUMN IF NOT EXISTS payee_reference text,
  ADD COLUMN IF NOT EXISTS frequency text CHECK (frequency IN ('annual','semiannual','quarterly','monthly','triennial','biennial')),
  ADD COLUMN IF NOT EXISTS installment_count int,
  ADD COLUMN IF NOT EXISTS estimate_basis text CHECK (estimate_basis IN ('known_bill','prior_year','prior_year_cpi','comparable','quote','contract')),
  ADD COLUMN IF NOT EXISTS estimated_annual_cents bigint,
  ADD COLUMN IF NOT EXISTS cycle_years int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS terminates_on date,
  ADD COLUMN IF NOT EXISTS source text CHECK (source IN ('tax_service','insurance_tracker','mi_adapter','hoa_manual','boarding')),
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to date;

ALTER TABLE loan_terms
  ADD COLUMN IF NOT EXISTS security_instrument_version text CHECK (security_instrument_version IN ('uniform_2001','uniform_2021','other')),
  ADD COLUMN IF NOT EXISTS instrument_cushion_months numeric(4,2),
  ADD COLUMN IF NOT EXISTS instrument_shortage_max_months int,
  ADD COLUMN IF NOT EXISTS hpml_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flood_escrow_mandatory boolean NOT NULL DEFAULT false;

CREATE TYPE escrow_bill_status AS ENUM ('projected','received','scheduled','paid','delinquent','supplemental','corrected','void');
CREATE TABLE escrow_bills (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_line_id        uuid NOT NULL REFERENCES escrow_lines(id),
  tax_year_or_policy_term text,
  installment_no        smallint NOT NULL DEFAULT 1,
  amount_cents          bigint NOT NULL,
  due_date              date NOT NULL,
  penalty_date          date,                                      -- economic loss date
  discount_date         date,
  discount_amount_cents bigint,
  installment_option    jsonb,
  borrower_preference   text,
  status                escrow_bill_status NOT NULL DEFAULT 'projected',
  vendor_ref            text,
  received_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE escrow_analysis_type AS ENUM ('initial','annual','interim','transfer_in','workout','payoff','reinstatement');
CREATE TYPE escrow_analysis_status AS ENUM ('computed','anomaly_review','approved','statement_sent','effective','superseded','cancelled');
CREATE TABLE escrow_analyses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_account_id     uuid NOT NULL REFERENCES escrow_accounts(id),
  analysis_type         escrow_analysis_type NOT NULL,
  run_at                timestamptz NOT NULL DEFAULT now(),
  as_of_date            date NOT NULL,
  projection_start      date NOT NULL,
  projection_end        date NOT NULL,
  lines_snapshot        jsonb NOT NULL,
  annual_disbursements_cents bigint NOT NULL,
  base_payment_cents    bigint NOT NULL,
  cushion_months        numeric(4,2) NOT NULL,
  cushion_cents         bigint NOT NULL,
  cushion_cap_source    text,
  cushion_cap_cents     bigint,
  lowest_target_cents   bigint,
  cap_check_passed      boolean,
  preaccrual_check_passed boolean,
  low_point_month       date,
  low_point_uncorrected_cents bigint,
  required_start_balance_cents bigint,
  target_at_start_cents bigint,
  projected_actual_at_start_cents bigint,
  surplus_cents         bigint NOT NULL DEFAULT 0,
  shortage_cents        bigint NOT NULL DEFAULT 0,
  deficiency_cents      bigint NOT NULL DEFAULT 0,
  borrower_current      boolean NOT NULL,
  decision              jsonb NOT NULL DEFAULT '{}',
  new_payment_cents     bigint,
  new_payment_effective_date date,
  instrument_cap_applied boolean NOT NULL DEFAULT false,
  state_overlay_codes   text[] NOT NULL DEFAULT '{}',
  status                escrow_analysis_status NOT NULL DEFAULT 'computed',
  rule_set_version      text NOT NULL,
  agent_decision_id     uuid REFERENCES agent_decisions(id),
  supersedes_analysis_id uuid REFERENCES escrow_analyses(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE escrow_analysis_lines (
  analysis_id           uuid NOT NULL REFERENCES escrow_analyses(id),
  period_index          smallint NOT NULL,
  period_date           date NOT NULL,
  deposit_cents         bigint NOT NULL DEFAULT 0,
  disbursement_cents    bigint NOT NULL DEFAULT 0,
  description           text,
  running_balance_uncorrected_cents bigint NOT NULL,
  running_balance_zeroed_cents bigint NOT NULL,
  target_balance_cents  bigint NOT NULL,
  PRIMARY KEY (analysis_id, period_index)
);

-- 3.1 / 3.3 statements
CREATE TYPE escrow_statement_type AS ENUM ('initial','annual','short_year_transfer','short_year_payoff','short_year_reset','post_exemption_history');
CREATE TABLE escrow_statements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  escrow_account_id     uuid NOT NULL REFERENCES escrow_accounts(id),
  statement_type        escrow_statement_type NOT NULL,
  analysis_id           uuid REFERENCES escrow_analyses(id),
  projection_analysis_id uuid REFERENCES escrow_analyses(id),
  prior_projection_document_id uuid REFERENCES documents(id),
  notice_id             uuid,
  required_reason       text,
  anchor_date           date NOT NULL,
  due_at                timestamptz NOT NULL,
  timer_id              uuid REFERENCES timers(id),
  history_from          date,
  history_to            date,
  exemption_applied     boolean NOT NULL DEFAULT false,
  exemption_reason      text CHECK (exemption_reason IN ('delinquent_30','foreclosure_action','bankruptcy')),
  exemption_started_at  date,
  exemption_ended_at    date,
  sent_at               timestamptz,
  delivery_channel      text,
  document_id           uuid REFERENCES documents(id),
  status                text NOT NULL DEFAULT 'pending',
  retention             retention_class NOT NULL DEFAULT 'respa_5y',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE escrow_statement_history_lines (
  statement_id          uuid NOT NULL REFERENCES escrow_statements(id),
  period_date           date NOT NULL,
  projected_deposit_cents bigint NOT NULL DEFAULT 0,
  actual_deposit_cents  bigint NOT NULL DEFAULT 0,
  projected_disbursement_cents bigint NOT NULL DEFAULT 0,
  actual_disbursement_cents bigint NOT NULL DEFAULT 0,
  description           text,
  projected_balance_cents bigint NOT NULL,
  actual_balance_cents  bigint NOT NULL,
  variance_flag         boolean NOT NULL DEFAULT false,
  PRIMARY KEY (statement_id, period_date, description)
);

-- 3.6 repayment plans
CREATE TABLE escrow_repayment_plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_account_id     uuid NOT NULL REFERENCES escrow_accounts(id),
  analysis_id           uuid REFERENCES escrow_analyses(id),
  kind                  text NOT NULL CHECK (kind IN ('shortage','deficiency')),
  basis                 text NOT NULL CHECK (basis IN ('regx_default','workout_60','borrower_election','instrument_cap','state_nh')),
  total_cents           bigint NOT NULL,
  months                int NOT NULL,
  installment_cents     bigint NOT NULL,
  final_installment_cents bigint NOT NULL,
  start_due_date        date NOT NULL,
  end_due_date          date NOT NULL,
  collected_cents       bigint NOT NULL DEFAULT 0,
  remaining_cents       bigint NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','superseded','paid_lump','cancelled')),
  election_evidence_document_id uuid REFERENCES documents(id),
  interest_bearing      boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- 3.7 disbursements (full definition; also used by 3.5 refunds and 9.x LPI)
CREATE TYPE disbursement_kind AS ENUM ('tax','hazard','flood','wind','other_insurance','mi','hoa','ground_rent','surplus_refund','payoff_refund','surplus_credit','lpi_premium','loss_draft','mi_refund','other');
CREATE TYPE disbursement_method AS ENUM ('tax_service_bulk','ach','ach_credit','check','wire','vendor_epay','internal_transfer','credit_to_new_loan');
CREATE TYPE disbursement_status AS ENUM ('projected','scheduled','funds_check','advance_required','released','sent','issued','confirmed','cleared','rejected','returned','stopped','reissued','escheated','cancelled','refunded');
CREATE TABLE disbursements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  escrow_account_id     uuid REFERENCES escrow_accounts(id),
  escrow_line_id        uuid REFERENCES escrow_lines(id),
  escrow_bill_id        uuid REFERENCES escrow_bills(id),
  disbursement_kind     disbursement_kind NOT NULL,
  payee_id              uuid REFERENCES parties(id),
  payee_type            text,
  payee_instruction_id  uuid,
  amount_cents          bigint NOT NULL,
  due_date              date,
  due_at                timestamptz,
  penalty_date          date,
  discount_date         date,
  discount_cents        bigint,
  must_pay_by           date,
  release_date          date,
  method                disbursement_method,
  status                disbursement_status NOT NULL DEFAULT 'projected',
  advance_cents         bigint NOT NULL DEFAULT 0,
  sent_at               timestamptz,
  issued_at             timestamptz,
  confirmed_at          timestamptz,
  cleared_at            timestamptz,
  check_number          text,
  positive_pay_sent_at  timestamptz,
  external_ref          text,
  ledger_entry_set_id   uuid REFERENCES ledger_entry_sets(id),
  investor_event_id     uuid,
  analysis_id           uuid REFERENCES escrow_analyses(id),
  timer_id              uuid REFERENCES timers(id),
  penalty_incurred_cents bigint NOT NULL DEFAULT 0,
  penalty_cause         text NOT NULL DEFAULT 'none' CHECK (penalty_cause IN ('none','servicer_error','vendor_error','borrower','payee')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disbursements_loan_idx ON disbursements(loan_id, due_date);

ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS payee_kind text CHECK (payee_kind IN ('taxing_authority','insurer','mi_company','hoa','ground_lessor','payment_contractor','other')),
  ADD COLUMN IF NOT EXISTS remittance_instructions_encrypted bytea,
  ADD COLUMN IF NOT EXISTS remittance_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS tax_service_agency_id text;
COMMENT ON COLUMN parties.remittance_instructions_encrypted IS 'pii';
CREATE TABLE payee_instruction_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id              uuid NOT NULL REFERENCES parties(id),
  instructions_encrypted bytea NOT NULL,
  validated_at          timestamptz,
  validated_by          text,
  effective_from        timestamptz NOT NULL DEFAULT now(),
  effective_to          timestamptz
);
CREATE TABLE nonescrow_tax_checks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  check_date            date NOT NULL,
  source                text,
  status                text NOT NULL CHECK (status IN ('paid','delinquent','sold','unknown')),
  delinquent_cents      bigint,
  tax_sale_date         date,
  case_id               uuid REFERENCES cases(id)
);

-- investor_events (baseline family; escrow subtype fields) — created here, extended by 5.x
CREATE TYPE investor_event_status AS ENUM ('queued','sent','accepted','accepted_warning','rejected','corrected','closed','withdrawn');
CREATE TABLE investor_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  event_family          text NOT NULL,                             -- escrow | lar | liquidation | payoff | ...
  event_type            text NOT NULL,
  escrow_category       text CHECK (escrow_category IN ('taxes_insurance','loss_draft','buy_down','renovation')),
  escrow_item_type      text,
  item_amount_cents     bigint,
  category_balance_after_cents bigint,
  contractual_payment_cents bigint,
  processed_date        date,
  sequence_no           int,
  activity_period       text,                                      -- YYYY-MM
  period_key            text,
  payload               jsonb NOT NULL DEFAULT '{}',
  status                investor_event_status NOT NULL DEFAULT 'queued',
  fnma_response         jsonb,
  deadline_at           timestamptz,
  sent_at               timestamptz,
  acked_at              timestamptz,
  supersedes_id         uuid REFERENCES investor_events(id),
  idempotency_key       text UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX investor_events_loan_idx ON investor_events(loan_id, activity_period);
CREATE TABLE escrow_attestations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_key            text NOT NULL,
  servicer_number       char(9) NOT NULL,
  category              text NOT NULL,
  loan_count            int NOT NULL,
  ending_balance_cents  bigint NOT NULL,
  aggregate_contractual_payment_cents bigint NOT NULL,
  fnma_values           jsonb,
  reconciled            boolean NOT NULL DEFAULT false,
  commentary            text,
  attested_by           text,
  attested_at           timestamptz,
  evidence_document_id  uuid REFERENCES documents(id),
  UNIQUE (period_key, servicer_number, category)
);

-- 3.8 waivers
CREATE TABLE escrow_waivers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  scope                 text NOT NULL CHECK (scope IN ('full','partial')),
  waived_line_types     text[] NOT NULL DEFAULT '{}',
  origin                text NOT NULL CHECK (origin IN ('origination','borrower_request','state_right','transfer_in')),
  requested_at          timestamptz,
  decided_at            timestamptz,
  decision              text CHECK (decision IN ('approved','denied','not_applicable')),
  denial_reasons        text[] NOT NULL DEFAULT '{}',
  state_right_applied   text,
  effective_date        date,
  revoked_at            timestamptz,
  revocation_reason     text CHECK (revocation_reason IN ('tax_or_insurance_unpaid','modification_trial','deferral','borrower_request','transfer')),
  basis_document_id     uuid REFERENCES documents(id),
  notice_ids            uuid[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- 3.9 interest on escrow
ALTER TABLE jurisdiction_rules ADD COLUMN IF NOT EXISTS escrow_interest jsonb;
ALTER TABLE jurisdiction_rules ADD COLUMN IF NOT EXISTS escrow_cushion_max_months numeric(4,2);
CREATE TABLE jurisdiction_rate_observations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state                 char(2) NOT NULL,
  index_code            text NOT NULL,
  observed_value_bps    int NOT NULL,
  effective_from        date NOT NULL,
  effective_to          date,
  source_url            text,
  evidence_document_id  uuid REFERENCES documents(id),
  entered_by            text NOT NULL,
  verified              boolean NOT NULL DEFAULT false
);
CREATE TABLE escrow_interest_accruals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  basis_balance_cents   bigint NOT NULL,
  rate_bps              int NOT NULL,
  day_count             int NOT NULL,
  accrued_exact         numeric(20,8) NOT NULL,
  posted_cents          bigint,
  posted_at             timestamptz,
  ledger_entry_set_id   uuid REFERENCES ledger_entry_sets(id),
  investor_event_id     uuid REFERENCES investor_events(id),
  rule_version          text NOT NULL,
  status                text NOT NULL DEFAULT 'accruing' CHECK (status IN ('accruing','posted','prorated_posted','void'))
);
CREATE TABLE escrow_interest_1099 (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year              smallint NOT NULL,
  borrower_id           uuid NOT NULL REFERENCES borrowers(id),
  tin_hash              text NOT NULL,
  total_cents           bigint NOT NULL,
  furnished_at          timestamptz,
  filed_at              timestamptz,
  correction_of         uuid REFERENCES escrow_interest_1099(id)
);

COMMIT;
