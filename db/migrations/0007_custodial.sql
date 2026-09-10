-- 0007_custodial.sql — Section 6 (6.1–6.5): depositories, custodial accounts fixed, forms, bank statements, reconciliations, unclaimed property.
BEGIN;

CREATE TABLE depositories (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name            text NOT NULL,
  aba_routing           char(9) NOT NULL UNIQUE,
  fdic_cert             text,
  ncua_charter          text,
  insurer               text CHECK (insurer IN ('fdic','ncusif','frb','fhlb')),
  total_assets_cents    bigint,
  assets_as_of          date,
  well_capitalized      boolean,
  well_capitalized_source text,
  eligibility_status    text NOT NULL DEFAULT 'unknown' CHECK (eligibility_status IN ('eligible','watch','ineligible','unknown')),
  eligibility_basis     jsonb,
  last_checked_at       timestamptz,
  next_check_due        date,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE depository_ratings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  depository_id         uuid NOT NULL REFERENCES depositories(id),
  agency                text NOT NULL CHECK (agency IN ('sp_st','sp_lt','moodys_st','moodys_lt','idc','kbra')),
  rating                text NOT NULL,
  numeric_rating        int,
  published_at          date NOT NULL,
  source_document_id    uuid REFERENCES documents(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER depository_ratings_immutable BEFORE UPDATE OR DELETE ON depository_ratings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE custodial_accounts
  ADD COLUMN IF NOT EXISTS depository_id uuid REFERENCES depositories(id),
  ADD COLUMN IF NOT EXISTS account_number_enc bytea,
  ADD COLUMN IF NOT EXISTS pool_class text CHECK (pool_class IN ('mbs','portfolio_mrs','na')),
  ADD COLUMN IF NOT EXISTS master_servicer_numbers text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS subservicer_number char(9),
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS interest_bearing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_drafting_account boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('planned','form_pending','active','pending_replacement','closing','closed')),
  ADD COLUMN IF NOT EXISTS opened_at date,
  ADD COLUMN IF NOT EXISTS closed_at date,
  ADD COLUMN IF NOT EXISTS statement_feed_id text,
  ADD COLUMN IF NOT EXISTS positive_pay boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS debit_whitelist_confirmed_at timestamptz;
COMMENT ON COLUMN custodial_accounts.account_number_enc IS 'pii';

CREATE TABLE custodial_forms (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  form_type             text NOT NULL CHECK (form_type IN ('1013','1014')),
  cbam_form_number      text,
  remittance_types      text[] NOT NULL DEFAULT '{}',
  effective_date        date,
  servicer_rep_user_id  text,
  depository_rep        jsonb,
  status                text NOT NULL DEFAULT 'in_draft' CHECK (status IN ('in_draft','pending_signatures','signatures_declined','fully_signed','in_effect','pending_replacement','closed_reported')),
  sent_at               timestamptz,
  servicer_signed_at    timestamptz,
  depository_signed_at  timestamptz,
  executed_document_id  uuid REFERENCES documents(id),
  replaces_form_id      uuid REFERENCES custodial_forms(id),
  human_portal_task_id  uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE custodial_account_events (
  id                    bigserial PRIMARY KEY,
  custodial_account_id  uuid REFERENCES custodial_accounts(id),
  form_id               uuid REFERENCES custodial_forms(id),
  event_type            text NOT NULL,
  payload               jsonb NOT NULL DEFAULT '{}',
  actor                 text NOT NULL,
  at                    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER custodial_account_events_immutable BEFORE UPDATE OR DELETE ON custodial_account_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 6.3 bank statements
CREATE TABLE bank_statements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  format                text NOT NULL CHECK (format IN ('bai2','camt053','camt052')),
  as_of_date            date NOT NULL,
  as_of_time            time,
  opening_ledger_cents  bigint,
  closing_ledger_cents  bigint,
  opening_available_cents bigint,
  closing_available_cents bigint,
  total_credits_cents   bigint NOT NULL DEFAULT 0,
  total_debits_cents    bigint NOT NULL DEFAULT 0,
  credit_count          int NOT NULL DEFAULT 0,
  debit_count           int NOT NULL DEFAULT 0,
  raw_document_id       uuid REFERENCES documents(id),
  parsed_at             timestamptz,
  control_totals_ok     boolean,
  retention             retention_class NOT NULL DEFAULT 'corporate_7y',
  UNIQUE (custodial_account_id, as_of_date, format)
);
CREATE TABLE bank_statement_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_statement_id     uuid NOT NULL REFERENCES bank_statements(id),
  line_no               int NOT NULL,
  type_code             text NOT NULL,
  direction             text NOT NULL CHECK (direction IN ('credit','debit')),
  amount_cents          bigint NOT NULL,
  funds_type            text,
  value_date            date,
  booking_date          date,
  bank_ref              text,
  customer_ref          text,
  text                  text,
  match_status          text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched','matched','exception')),
  matched_ledger_entry_set_ids uuid[] NOT NULL DEFAULT '{}',
  exception_id          uuid,
  UNIQUE (bank_statement_id, line_no)
);
ALTER TABLE suspense_items ADD CONSTRAINT suspense_items_bank_line_fk FOREIGN KEY (bank_statement_line_id) REFERENCES bank_statement_lines(id);
CREATE TABLE fnma_cash_positions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  servicer_number       char(9) NOT NULL,
  remittance_type       text NOT NULL,
  period                char(7) NOT NULL,
  as_of_date            date NOT NULL,
  adjustment_cents      bigint NOT NULL DEFAULT 0,
  draft_cents           bigint NOT NULL DEFAULT 0,
  raw_document_id       uuid REFERENCES documents(id)
);
CREATE TABLE fnma_cash_position_details (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_position_id      uuid NOT NULL REFERENCES fnma_cash_positions(id),
  loan_id               uuid REFERENCES loans(id),
  type                  text NOT NULL,
  amount_cents          bigint NOT NULL
);
CREATE TABLE fnma_draft_notifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_date           date NOT NULL,
  draft_type            text NOT NULL,
  draft_date            date NOT NULL,
  servicer_number       char(9) NOT NULL,
  remittance_type       text,
  amount_cents          bigint NOT NULL,
  loan_id               uuid REFERENCES loans(id),
  source                text NOT NULL CHECK (source IN ('api','connect_report','crs_report')),
  raw_document_id       uuid REFERENCES documents(id)
);
CREATE TYPE reconciliation_kind AS ENUM ('daily_three_way','monthly_form_496','monthly_form_496a');
CREATE TABLE reconciliations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  kind                  reconciliation_kind NOT NULL,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  status                text NOT NULL DEFAULT 'open',
  bank_balance_cents    bigint,
  deposits_in_transit_cents bigint NOT NULL DEFAULT 0,
  disbursements_in_transit_cents bigint NOT NULL DEFAULT 0,
  other_adjustments_cents bigint NOT NULL DEFAULT 0,
  adjusted_bank_cents   bigint,
  cashbook_cents        bigint,
  difference_cents      bigint,
  composition           jsonb NOT NULL DEFAULT '{}',
  fnma_receivable_cents bigint,
  fnma_receivable_source_document_id uuid REFERENCES documents(id),
  generated_document_id uuid REFERENCES documents(id),
  rendered_document_id  uuid REFERENCES documents(id),
  prepared_by_run_id    uuid,
  reviewed_by_run_id    uuid,
  approved_by_user_id   text,
  completed_at          timestamptz,
  timer_id              uuid REFERENCES timers(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TYPE reconciliation_item_category AS ENUM ('deposit_in_transit','disbursement_in_transit','bank_credit_unposted','bank_debit_unposted','draft_variance','returned_item','bank_fee','interest_credit','timing_difference','duplicate_posting','posting_error','servicing_fee_sweep_variance','advance_recovery_variance','pool_allocation_variance','title_mismatch','statement_missing','control_total_mismatch','fnma_receivable_variance','outstanding_check','stale_check','escrow_advance_unfunded','attestation_variance','loss_draft_aged_7m','unapplied_aged');
CREATE TABLE reconciliation_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id     uuid REFERENCES reconciliations(id),
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  category              reconciliation_item_category NOT NULL,
  severity              text,
  loan_id               uuid REFERENCES loans(id),
  fnma_loan_number      char(10),
  amount_cents          bigint NOT NULL,
  first_seen_on         date NOT NULL,
  aging_days            int NOT NULL DEFAULT 0,
  root_cause            text,
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  proposed_entries      jsonb,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','proposed','posted','cleared','funded','escalated','written_off')),
  resolved_on           date,
  decision_id           uuid REFERENCES agent_decisions(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bank_statement_lines ADD CONSTRAINT bank_statement_lines_exception_fk FOREIGN KEY (exception_id) REFERENCES reconciliation_items(id);
CREATE TABLE corporate_fundings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  reconciliation_item_id uuid REFERENCES reconciliation_items(id),
  amount_cents          bigint NOT NULL,
  reason                text NOT NULL,
  approval_tier         text NOT NULL CHECK (approval_tier IN ('agent','officer','officer_plus_partner')),
  approved_by           text,
  funded_on             date,
  recovered_on          date,
  ledger_entry_set_ids  uuid[] NOT NULL DEFAULT '{}'
);
CREATE TABLE remittance_components (
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  period                char(7) NOT NULL,
  remittance_type       text NOT NULL,
  pool_class            text,
  component_code        text NOT NULL CHECK (component_code IN ('L1_net_pi_aa','L2_principal_current_sa','L3_prepaid_net','L4_curtail_liq_principal','L5_interest_funding_curtail','L6_interest_gain_loss_sa','L7_payoff_fixed_installment_net','L8_delinquent_pi_net','L9_fnma_receivable','L10_fnma_receivable_adj','L11_other')),
  amount_cents          bigint NOT NULL,
  loan_level_support_document_id uuid REFERENCES documents(id),
  PRIMARY KEY (custodial_account_id, period, component_code)
);
CREATE TABLE form_templates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form                  text NOT NULL,
  version_label         text NOT NULL,
  template_document_id  uuid REFERENCES documents(id),
  sha256                text NOT NULL,
  cell_map              jsonb NOT NULL,
  valid_from            date NOT NULL,
  validated_by_test_run_id uuid,
  UNIQUE (form, version_label)
);

-- 6.2 T&I
CREATE TABLE custodial_interest_credits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  bank_statement_line_id uuid REFERENCES bank_statement_lines(id),
  credited_on           date NOT NULL,
  amount_cents          bigint NOT NULL,
  admin_expense_cents   bigint NOT NULL DEFAULT 0,
  disposition           text NOT NULL DEFAULT 'pending' CHECK (disposition IN ('pending','to_borrowers','to_corporate','mixed')),
  disbursed_on          date,
  allocation_document_id uuid REFERENCES documents(id),
  timer_id              uuid REFERENCES timers(id)
);
ALTER TABLE escrow_interest_accruals ADD COLUMN IF NOT EXISTS interest_credit_id uuid REFERENCES custodial_interest_credits(id);

-- 6.4 T&I snapshots, outstanding checks
CREATE TABLE ti_composition_snapshots (
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  period_end            date NOT NULL,
  positive_escrow_cents bigint NOT NULL DEFAULT 0,
  negative_escrow_cents bigint NOT NULL DEFAULT 0,
  advances_funded_cents bigint NOT NULL DEFAULT 0,
  loss_draft_cents      bigint NOT NULL DEFAULT 0,
  unapplied_cents       bigint NOT NULL DEFAULT 0,
  buydown_cents         bigint NOT NULL DEFAULT 0,
  interest_pending_cents bigint NOT NULL DEFAULT 0,
  other_cents           bigint NOT NULL DEFAULT 0,
  loan_count            int NOT NULL DEFAULT 0,
  contractual_escrow_payment_sum_cents bigint NOT NULL DEFAULT 0,
  by_category           jsonb NOT NULL DEFAULT '{}',
  source_snapshot_ids   uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (custodial_account_id, period_end)
);
CREATE TABLE outstanding_checks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disbursement_id       uuid REFERENCES disbursements(id),
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  check_number          text NOT NULL,
  payee                 text NOT NULL,
  issued_on             date NOT NULL,
  amount_cents          bigint NOT NULL,
  status                text NOT NULL DEFAULT 'outstanding' CHECK (status IN ('outstanding','paid','voided','stale','reissued','escheated')),
  paid_on               date,
  stale_on              date,
  positive_pay_status   text
);
COMMENT ON COLUMN outstanding_checks.payee IS 'pii';
CREATE TABLE escrow_attestation_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period                char(7) NOT NULL,
  fnma_ending_balance_cents bigint,
  servicer_ending_balance_cents bigint,
  loan_count_fnma       int,
  loan_count_servicer   int,
  contractual_sum_fnma  bigint,
  contractual_sum_servicer bigint,
  aligned               boolean,
  commentary            text,
  submitted_by          text,
  submitted_at          timestamptz
);

-- 6.5 unclaimed property
CREATE TABLE unclaimed_property_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suspense_item_id      uuid REFERENCES suspense_items(id),
  outstanding_check_id  uuid REFERENCES outstanding_checks(id),
  owner_name            text,
  owner_last_address    jsonb,
  state                 char(2) NOT NULL,
  naupa_property_code   text,
  dormancy_start_on     date NOT NULL,
  presumed_abandoned_on date NOT NULL,
  due_diligence_notice_id uuid,
  report_cycle          text,
  reported_on           date,
  remitted_on           date,
  state_confirmation_ref text,
  status                text NOT NULL DEFAULT 'dormant',
  CHECK (suspense_item_id IS NOT NULL OR outstanding_check_id IS NOT NULL)
);
COMMENT ON COLUMN unclaimed_property_items.owner_name IS 'pii';
CREATE TABLE unclaimed_property_reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state                 char(2) NOT NULL,
  cycle                 text NOT NULL,
  file_document_id      uuid REFERENCES documents(id),
  verification_signed_by text,
  filed_on              date,
  remittance_cents      bigint NOT NULL DEFAULT 0,
  UNIQUE (state, cycle)
);

COMMIT;
