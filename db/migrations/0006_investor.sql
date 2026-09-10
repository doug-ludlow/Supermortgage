-- 0006_investor.sql — Section 5 (5.1–5.7): investor events fixed, submissions, positions, remittances, liquidations, SDA, g-fees, repurchases, delinquency reporting; advances + rule_sets baseline.
BEGIN;

CREATE TABLE rule_sets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle                text NOT NULL,                             -- e.g. fnma.investor_reporting.channels
  version               text NOT NULL,
  effective_from        date NOT NULL,
  effective_to          date,
  content               jsonb NOT NULL,
  approved_by           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bundle, version)
);

-- 5.1 investor_events fixed
ALTER TABLE investor_events
  ADD COLUMN IF NOT EXISTS servicer_number char(9),
  ADD COLUMN IF NOT EXISTS fnma_loan_number char(10),
  ADD COLUMN IF NOT EXISTS effective_date date,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS per_loan_sequence bigint,
  ADD COLUMN IF NOT EXISTS source_loan_event_id uuid,
  ADD COLUMN IF NOT EXISTS channel text CHECK (channel IN ('lsdu_b2b','lsdu_upload','lsdu_single','se_api','se_b2b','se_csv','amn_b2b','amn_upload','human_portal')),
  ADD COLUMN IF NOT EXISTS projection_format text CHECK (projection_format IN ('lar80','se_json_v1','amn_fixed','csv')),
  ADD COLUMN IF NOT EXISTS projection_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS submission_id uuid,
  ADD COLUMN IF NOT EXISTS rule_set_version text;
CREATE TABLE investor_event_types (
  event_type            text NOT NULL,
  version               text NOT NULL,
  event_family          text NOT NULL,
  legacy_record         text,
  legacy_action_code    text,
  se_event_name         text,
  channel_mode          text NOT NULL CHECK (channel_mode IN ('legacy','dual','event')),
  effective_from        date NOT NULL,
  deadline_timer_code   text,
  PRIMARY KEY (event_type, version)
);
CREATE TABLE investor_submissions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  servicer_number       char(9) NOT NULL,
  channel               text NOT NULL,
  format                text NOT NULL,
  document_id           uuid REFERENCES documents(id),
  record_count          int NOT NULL DEFAULT 0,
  submitted_at          timestamptz,
  ack_status            text,
  fnma_submission_id    text,
  processed_at          timestamptz,
  accepted_count        int NOT NULL DEFAULT 0,
  rejected_count        int NOT NULL DEFAULT 0,
  warning_count         int NOT NULL DEFAULT 0
);
ALTER TABLE investor_events ADD CONSTRAINT investor_events_submission_fk FOREIGN KEY (submission_id) REFERENCES investor_submissions(id);
CREATE TABLE investor_event_exceptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              uuid NOT NULL REFERENCES investor_events(id),
  source                text NOT NULL CHECK (source IN ('lsdu','se','amn','connect')),
  severity              text NOT NULL CHECK (severity IN ('hard','soft','invalid','missing','fatal','warning','notification')),
  code                  text NOT NULL,
  message               text,
  fnma_expected         jsonb,
  detected_at           timestamptz NOT NULL DEFAULT now(),
  triage                jsonb,
  resolution            text CHECK (resolution IN ('resubmitted','superseded','ppa_filed','fnma_adjusted','closed_manual','accepted_as_is')),
  resolved_at           timestamptz,
  deadline_timer_id     uuid REFERENCES timers(id)
);
CREATE TABLE investor_loan_positions (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  fnma_lpi_date         date,
  fnma_actual_upb_cents bigint,
  fnma_scheduled_upb_cents bigint,
  fnma_nib_balance_cents bigint,
  fnma_ptr              numeric(9,6),
  fnma_note_rate        numeric(9,6),
  fnma_pi_cents         bigint,
  remittance_type       remittance_type,
  participation_pct     numeric(9,6) NOT NULL DEFAULT 100,
  last_accepted_sequence bigint,
  as_of                 timestamptz,
  source                text CHECK (source IN ('lsdu_trial_balance','se_loan_position','purchase_advice'))
);
CREATE TABLE investor_reporting_periods (
  servicer_number       char(9) NOT NULL,
  period                char(7) NOT NULL,
  opens_at              timestamptz NOT NULL,
  ired_at               timestamptz,
  bulk_cutoff_at        timestamptz,
  close_at              timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','interim_closed','closed','attested')),
  close_checklist       jsonb NOT NULL DEFAULT '{}',
  attested_by_agent_run_id uuid,
  PRIMARY KEY (servicer_number, period)
);
CREATE TABLE investor_loan_sequences (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  next_sequence         bigint NOT NULL DEFAULT 1
);

-- advances (baseline): delinquency P&I, g-fee, escrow/corporate advances
CREATE TYPE advance_kind AS ENUM ('delinquency_pi','delinquency_interest_sa','gfee','escrow','corporate','tax','hazard','flood','hoa','preservation','inspection','attorney_fee','attorney_cost','mi_premium','other');
CREATE TYPE advance_status AS ENUM ('outstanding','recovered_from_borrower','reimbursed_by_fnma','written_off');
CREATE TABLE advances (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  kind                  advance_kind NOT NULL,
  activity_period       char(7),
  amount_cents          bigint NOT NULL,
  principal_component_cents bigint,
  interest_component_cents bigint,
  funded_from           text CHECK (funded_from IN ('partner_line','supermortgage_corporate')),
  drafted_at            timestamptz,
  paid_date             date,
  invoice_document_id   uuid REFERENCES documents(id),
  status                advance_status NOT NULL DEFAULT 'outstanding',
  post_sale_nonreimbursable boolean NOT NULL DEFAULT false,
  ledger_entry_set_id   uuid REFERENCES ledger_entry_sets(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX advances_loan_idx ON advances(loan_id, kind, status);
CREATE TABLE advance_recoveries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id            uuid NOT NULL REFERENCES advances(id),
  source                text NOT NULL CHECK (source IN ('borrower_reinstatement','borrower_payoff','fnma_reimbursement','tps_proceeds','claim','write_off','reversal')),
  amount_cents          bigint NOT NULL,
  recovered_at          timestamptz NOT NULL DEFAULT now(),
  fnma_repay_due_at     date,
  ledger_entry_set_id   uuid REFERENCES ledger_entry_sets(id)
);

-- 5.2 remittance
CREATE TABLE remittance_calculations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  activity_period       char(7) NOT NULL,
  remittance_type       text NOT NULL CHECK (remittance_type IN ('AA','SA','SS')),
  cycle                 text NOT NULL DEFAULT 'standard',
  prior_actual_upb_cents bigint,
  prior_scheduled_upb_cents bigint,
  ptr                   numeric(9,6) NOT NULL,
  note_rate             numeric(9,6) NOT NULL,
  participation_pct     numeric(9,6) NOT NULL DEFAULT 100,
  interest_due_cents    bigint NOT NULL DEFAULT 0,
  principal_due_cents   bigint NOT NULL DEFAULT 0,
  scheduled_pi_cents    bigint,
  servicing_fee_cents   bigint NOT NULL DEFAULT 0,
  excess_servicing_cents bigint NOT NULL DEFAULT 0,
  gfee_cents            bigint NOT NULL DEFAULT 0,
  collected_interest_cents bigint NOT NULL DEFAULT 0,
  collected_principal_cents bigint NOT NULL DEFAULT 0,
  advance_cents         bigint NOT NULL DEFAULT 0,
  sda_flag              boolean NOT NULL DEFAULT false,
  basis                 text NOT NULL CHECK (basis IN ('contractual','curtailment','payoff','repurchase','liquidation','none')),
  computed_at           timestamptz NOT NULL DEFAULT now(),
  rule_set_version      text NOT NULL,
  UNIQUE (loan_id, activity_period, basis, computed_at)
);
CREATE TABLE remittances (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  servicer_number       char(9) NOT NULL,
  remittance_type       text,
  remittance_code       text,
  custodial_account_id  uuid REFERENCES custodial_accounts(id),
  kind                  text NOT NULL CHECK (kind IN ('pi_scheduled','pi_actual','payoff','curtailment','repurchase','gfee','special','tps_proceeds','short_sale','reo_proceeds','settlement','mi_refund','hazard_refund')),
  initiator             text NOT NULL CHECK (initiator IN ('fnma','servicer')),
  amount_expected_cents bigint,
  amount_notified_cents bigint,
  amount_drafted_cents  bigint,
  draft_date            date,
  settlement_date       date,
  crs_batch_id          uuid,
  status                text NOT NULL DEFAULT 'computed' CHECK (status IN ('computed','funded','instructed','notified','drafted','matched','variance','failed','cancelled')),
  loan_id               uuid REFERENCES loans(id),
  variance_cents        bigint,
  variance_reason       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crs_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id           uuid REFERENCES documents(id),
  line_count            int NOT NULL DEFAULT 0,
  total_cents           bigint NOT NULL DEFAULT 0,
  prepared_at           timestamptz NOT NULL DEFAULT now(),
  portal_task_id        uuid,
  uploaded_at           timestamptz,
  crs_result            jsonb,
  status                text NOT NULL DEFAULT 'prepared'
);
ALTER TABLE remittances ADD CONSTRAINT remittances_crs_batch_fk FOREIGN KEY (crs_batch_id) REFERENCES crs_batches(id);
CREATE TABLE draft_notifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                text NOT NULL CHECK (source IN ('api','connect_report')),
  filing_date           date NOT NULL,
  draft_type            text NOT NULL,
  servicer_number       char(9) NOT NULL,
  remittance_code       text,
  draft_date            date NOT NULL,
  amount_cents          bigint NOT NULL,
  loan_level            jsonb,
  document_id           uuid REFERENCES documents(id)
);
CREATE TABLE cash_positions (
  servicer_number       char(9) NOT NULL,
  remittance_type       text NOT NULL,
  period                char(7) NOT NULL,
  pi_applied_cents      bigint NOT NULL DEFAULT 0,
  cash_received_cents   bigint NOT NULL DEFAULT 0,
  adjustments_cents     bigint NOT NULL DEFAULT 0,
  draft_cents           bigint NOT NULL DEFAULT 0,
  outstanding_fm_pi_receivable_cents bigint NOT NULL DEFAULT 0,
  as_of                 timestamptz NOT NULL,
  PRIMARY KEY (servicer_number, remittance_type, period, as_of)
);
CREATE TABLE shortage_surplus (
  servicer_number       char(9) NOT NULL,
  period                char(7) NOT NULL,
  opening_cents         bigint NOT NULL,
  remitted_cents        bigint NOT NULL,
  reported_pi_cents     bigint NOT NULL,
  closing_cents         bigint NOT NULL,
  explained_items       jsonb NOT NULL DEFAULT '[]',
  form_472_document_id  uuid REFERENCES documents(id),
  surplus_first_seen_at timestamptz,
  PRIMARY KEY (servicer_number, period)
);

-- 5.3 liquidations
CREATE TABLE liquidation_facts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  liquidation_type      text NOT NULL CHECK (liquidation_type IN ('payoff','short_sale','mortgage_release','fcl_third_party','fcl_fnma_acquired','condemnation','charge_off','redemption')),
  legal_date            date NOT NULL,
  processed_at          timestamptz,
  purchaser             text CHECK (purchaser IN ('borrower','third_party','fnma','insurer')),
  insured_flag          text NOT NULL DEFAULT 'none' CHECK (insured_flag IN ('none','mi','fha','va')),
  fnma_loss_risk        boolean,
  proceeds_cents        bigint,
  proceeds_received_at  timestamptz,
  action_code           text CHECK (action_code IN ('60','65','67','70','71','72')),
  reported_event_id     uuid REFERENCES investor_events(id),
  reo_case_id           uuid,
  tps_case_id           uuid,
  reported_late         boolean NOT NULL DEFAULT false,
  notes                 text
);
CREATE TABLE dra_milestones (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  firm_id               uuid REFERENCES parties(id),
  dra_event_name        text NOT NULL,
  event_date            date NOT NULL,
  data_points           jsonb NOT NULL DEFAULT '{}',
  source                text NOT NULL CHECK (source IN ('attorney_feed','dra_export','p360_signal')),
  received_at           timestamptz NOT NULL DEFAULT now(),
  matched_case_event_id uuid,
  mismatch_reason       text
);

-- 5.4 SDA
CREATE TABLE sda_status (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  status                text NOT NULL DEFAULT 'not_applicable' CHECK (status IN ('not_applicable','predicted','active','exited')),
  predicted_entry_period char(7),
  fnma_start_date       date,
  fnma_adjusted_start_date date,
  fnma_expiration_date  date,
  fm_pi_receivable_cents bigint NOT NULL DEFAULT 0,
  servicer_advances_outstanding_cents bigint NOT NULL DEFAULT 0,
  exit_reason           text CHECK (exit_reason IN ('current','deferral','reclass','payoff','repurchase','liquidation')),
  last_reconciled_report_id uuid,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE draft_adjustments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  period                char(7) NOT NULL,
  type                  text NOT NULL CHECK (type IN ('sda_principal_credit','sda_interest_credit','sda_principal_recovery','sda_interest_recovery','reclass_reimbursement','delinquency_advance_reimbursement','other')),
  amount_cents          bigint NOT NULL,
  report_document_id    uuid REFERENCES documents(id),
  matched_advance_ids   uuid[] NOT NULL DEFAULT '{}'
);

-- 5.5 g-fee
CREATE TABLE gfee_calculations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  period                char(7) NOT NULL,
  scheduled_upb_cents   bigint NOT NULL,
  gfee_rate             numeric(9,6) NOT NULL,
  buyup_bps             int NOT NULL DEFAULT 0,
  buydown_bps           int NOT NULL DEFAULT 0,
  amount_cents          bigint NOT NULL,
  bill_amount_cents     bigint,
  variance_cents        bigint,
  relief_flag           boolean NOT NULL DEFAULT false,
  UNIQUE (loan_id, period)
);
CREATE TABLE gfee_relief_status (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  status                text NOT NULL DEFAULT 'not_applicable' CHECK (status IN ('not_applicable','predicted','active','exited')),
  fnma_start_date       date,
  outstanding_fnma_gfee_cents bigint NOT NULL DEFAULT 0,
  servicer_gfee_advances_cents bigint NOT NULL DEFAULT 0,
  exit_reason           text
);

-- 5.6 repurchases
CREATE TABLE repurchases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  type                  text NOT NULL CHECK (type IN ('voluntary_portfolio','voluntary_mbs_regular_4mo','due_on_sale','bk_plan_mod','fnma_demand','make_whole','dpo_indemnification')),
  demand_received_at    timestamptz,
  documents_due_at      timestamptz,
  appeal_stage          text NOT NULL DEFAULT 'none' CHECK (appeal_stage IN ('none','appeal1','appeal2','impasse','escalation','idr')),
  appeal_deadline_at    timestamptz,
  approval_document_id  uuid REFERENCES documents(id),
  repurchase_effective_date date,
  price_components      jsonb,
  action_code           text CHECK (action_code IN ('65','67')),
  reported_event_id     uuid REFERENCES investor_events(id),
  remittance_id         uuid REFERENCES remittances(id),
  responsible_party     text CHECK (responsible_party IN ('partner','originator','supermortgage')),
  status                text NOT NULL DEFAULT 'open',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- 5.7 delinquency reporting
CREATE TABLE delinquency_reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  servicer_number       char(9) NOT NULL,
  period                char(7) NOT NULL,
  channel               text NOT NULL CHECK (channel IN ('amn_b2b','amn_upload','se_api','se_csv')),
  document_id           uuid REFERENCES documents(id),
  record_count          int NOT NULL DEFAULT 0,
  submitted_at          timestamptz,
  ack_status            text,
  exception_report_document_id uuid REFERENCES documents(id),
  critical_exceptions   int NOT NULL DEFAULT 0,
  noncritical_exceptions int NOT NULL DEFAULT 0,
  corrections_submitted_at timestamptz,
  final_report_document_id uuid REFERENCES documents(id),
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','exceptions_open','corrected','final'))
);
CREATE TABLE delinquency_report_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id             uuid NOT NULL REFERENCES delinquency_reports(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  fnma_loan_number      char(10) NOT NULL,
  status_code           char(2) NOT NULL,
  reason_code           char(3),
  effective_date        date,
  completion_date       date,
  forbearance_type      text,
  imminent_default_ind  boolean,
  forbearance_payment_cents bigint,
  forbearance_payment_date date,
  derivation            jsonb NOT NULL DEFAULT '{}',
  exception_code        text,
  superseded_by_line_id uuid REFERENCES delinquency_report_lines(id)
);
CREATE TABLE delinquency_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  per_loan_sequence     bigint NOT NULL,
  servicer_action_type  text NOT NULL,
  status_types          text[] NOT NULL DEFAULT '{}' CHECK (cardinality(status_types) <= 5),
  reason_types          text[] NOT NULL DEFAULT '{}' CHECK (cardinality(reason_types) <= 5),
  processed_at          timestamptz NOT NULL,
  submission_id         uuid REFERENCES investor_submissions(id),
  status                investor_event_status NOT NULL DEFAULT 'queued',
  exceptions            jsonb
);
CREATE TABLE dq_code_maps (
  map                   text NOT NULL CHECK (map IN ('status','reason')),
  rule_set_version      text NOT NULL,
  internal_state        text NOT NULL,
  code                  text NOT NULL,
  priority_level        int NOT NULL,
  requires_effective    boolean NOT NULL DEFAULT false,
  requires_completion   boolean NOT NULL DEFAULT false,
  one_month_only        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (map, rule_set_version, internal_state)
);

COMMIT;
