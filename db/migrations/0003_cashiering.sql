-- 0003_cashiering.sql — Section 2 (2.1–2.7) + the 6.5 suspense tables cashiering writes to.
-- Money bigint cents; append-only tables carry forbid_mutation triggers.
BEGIN;

ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'tpsc_2y_post_revocation';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'corporate_7y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'fcra_furnishing_5y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'security_logs_5y';

-- ───────────────────────────── 2.1 payments ─────────────────────────────
CREATE TYPE payment_channel AS ENUM ('lockbox','ach_debit_origin','ach_credit_inbound','wire','portal_onetime','ivr','agent_assisted','mail_office','card','third_party_contractor','assistance_program','bk_trustee','transferor_forward','transfer_in_opening');
CREATE TYPE payment_instrument AS ENUM ('check','money_order','cashiers_check','ach','wire','card_debit','card_credit','book_transfer');
CREATE TYPE payment_designation AS ENUM ('unspecified','contractual','curtailment','escrow_only','fees_only','trial','payoff','reinstatement','biweekly_half');
CREATE TYPE payer_type AS ENUM ('borrower','coborrower','successor','third_party','contractor','program','trustee','transferor');
CREATE TYPE payment_status AS ENUM ('received','identified','held','allocated','posted','reversed','returned','refunded');
CREATE TYPE allocation_outcome AS ENUM ('applied','applied_with_50_rule','curtailment','prepaid','unapplied','held_trial','held_bk','held_fc','held_dispute','refunded','payoff_routed');

CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid REFERENCES loans(id),                 -- null until identified
  custodial_account_id  uuid REFERENCES custodial_accounts(id),
  channel               payment_channel NOT NULL,
  instrument            payment_instrument NOT NULL,
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  received_at           timestamptz NOT NULL,
  received_on           date NOT NULL,                             -- Reg Z date of receipt
  credited_as_of        date NOT NULL,
  conforming            boolean NOT NULL DEFAULT true,
  nonconforming_reason  text,
  designation           payment_designation NOT NULL DEFAULT 'unspecified',
  borrower_instruction_text text,
  instruction_source    text,
  payer_type            payer_type NOT NULL DEFAULT 'borrower',
  payer_name            text,
  payer_bank_last4      char(4),
  check_number          text,
  trace_number          text,
  image_document_id     uuid REFERENCES documents(id),
  idempotency_key       text NOT NULL UNIQUE,                      -- sha256(channel|batch|item|amount|received_on)
  status                payment_status NOT NULL DEFAULT 'received',
  allocation_outcome    allocation_outcome,
  source_batch_id       text,
  source_item_id        text,
  settlement_date       date,
  good_funds_at         timestamptz,
  retention             retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN payments.payer_name IS 'pii';
COMMENT ON COLUMN payments.payer_bank_last4 IS 'pii';
CREATE INDEX payments_loan_idx ON payments(loan_id, received_on);

CREATE TYPE allocation_bucket AS ENUM ('interest','principal','escrow','late_charge','nsf_fee','other_fee','curtailment','suspense','deferred_principal','forborne_principal','corporate_advance','escrow_advance');
CREATE TABLE payment_allocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id            uuid NOT NULL REFERENCES payments(id),
  sequence              int NOT NULL,
  installment_due_date  date,
  bucket                allocation_bucket NOT NULL,
  amount_cents          bigint NOT NULL,
  ledger_entry_set_id   uuid REFERENCES ledger_entry_sets(id),
  rule_ref              text NOT NULL,                             -- e.g. F-1-09:order_1999plus:interest
  credited_as_of        date NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, sequence)
);
CREATE TRIGGER payment_allocations_immutable BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE payment_channels (
  channel               payment_channel PRIMARY KEY,
  cutoff_time           time NOT NULL,
  cutoff_tz             text NOT NULL DEFAULT 'America/New_York',
  requirements_version  text NOT NULL,
  conforming_rules      jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE payment_requirements (                                  -- Reg Z (c)(1)(iii) written requirements, versioned
  version               text PRIMARY KEY,
  effective_from        date NOT NULL,
  effective_to          date,
  text                  text NOT NULL,
  carried_by_notice_ids uuid[] NOT NULL DEFAULT '{}'
);
CREATE TYPE payment_hold_type AS ENUM ('bankruptcy','foreclosure_post_referral','noe_dispute','fraud','deceased_estate','payoff_pending','transfer_out_cutover');
CREATE TABLE payment_holds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  hold_type             payment_hold_type NOT NULL,
  owner_case_id         uuid REFERENCES cases(id),
  set_by                text NOT NULL,
  set_at                timestamptz NOT NULL DEFAULT now(),
  released_at           timestamptz
);
CREATE TABLE custodial_deposits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_ids           uuid[] NOT NULL,
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  clearing_deposited_at timestamptz,
  custodial_deposited_at timestamptz,
  bank_reference        text,
  evidence_document_id  uuid REFERENCES documents(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TYPE installment_status AS ENUM ('due','satisfied','prepaid','deferred','forborne');
CREATE TABLE loan_installments (                                     -- projection
  loan_id               uuid NOT NULL REFERENCES loans(id),
  due_date              date NOT NULL,
  pi_cents              bigint NOT NULL,
  interest_cents        bigint NOT NULL,
  principal_cents       bigint NOT NULL,
  escrow_cents          bigint NOT NULL DEFAULT 0,
  status                installment_status NOT NULL DEFAULT 'due',
  satisfied_on          date,
  credited_as_of        date,
  late_charge_state     text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (loan_id, due_date)
);
CREATE TYPE reversal_reason AS ENUM ('returned_item','misapplied','duplicate','servicer_error','borrower_request','court_order');
CREATE TABLE payment_reversals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id            uuid NOT NULL REFERENCES payments(id),
  reason                reversal_reason NOT NULL,
  return_code           text,
  reversed_at           timestamptz NOT NULL DEFAULT now(),
  ledger_entry_set_id   uuid REFERENCES ledger_entry_sets(id),
  decision_id           uuid REFERENCES agent_decisions(id)
);
CREATE TRIGGER payment_reversals_immutable BEFORE UPDATE OR DELETE ON payment_reversals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── 6.5 suspense (fixed there, used by 2.2) ─────────────────────────────
CREATE TYPE suspense_source AS ENUM ('lockbox','ach','wire','card','bank_credit_unposted','refund_returned','trustee','third_party','transfer_in','other');
CREATE TYPE suspense_reason AS ENUM ('partial_payment','partial_payment_50_rule','unidentified_loan','unidentified_payer','overpayment','duplicate_payment','post_payoff_receipt','pending_modification_hold','bankruptcy_hold','dispute_hold','foreclosure_hold','rental_income','third_party_unverified','returned_refund','transfer_in_inherited','remainder_under_p','prepaid_pending','biweekly_accumulation');
CREATE TYPE suspense_status AS ENUM ('open','researching','contact_pending','matched_pending','applied','returned','refunded','transferred','escheat_pending','escheated','written_off');
CREATE TABLE suspense_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid REFERENCES loans(id),
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  ledger_entry_set_id   uuid REFERENCES ledger_entry_sets(id),
  payment_id            uuid REFERENCES payments(id),
  source                suspense_source NOT NULL,
  reason_code           suspense_reason NOT NULL,
  amount_cents          bigint NOT NULL,
  received_on           date NOT NULL,
  credited_as_of        date,
  payer_name            text,
  payer_account_last4   char(4),
  memo                  text,
  image_document_id     uuid REFERENCES documents(id),
  bank_statement_line_id uuid,
  case_id               uuid REFERENCES cases(id),
  status                suspense_status NOT NULL DEFAULT 'open',
  resolution_due_on     date,
  aging_days            int NOT NULL DEFAULT 0,
  resolved_on           date,
  resolution_event_id   uuid,
  decision_id           uuid REFERENCES agent_decisions(id),
  partial_commitment_due_on date,
  partial_count_12m     int,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN suspense_items.payer_name IS 'pii';
CREATE TYPE suspense_action AS ENUM ('matched_candidate','contact_attempt','contact_result','return_initiated','refund_issued','applied','escheat_notice_sent','escheat_reported');
CREATE TABLE suspense_actions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suspense_item_id      uuid NOT NULL REFERENCES suspense_items(id),
  action                suspense_action NOT NULL,
  payload               jsonb NOT NULL DEFAULT '{}',
  actor                 text NOT NULL,
  at                    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER suspense_actions_immutable BEFORE UPDATE OR DELETE ON suspense_actions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── 2.2 partial payments ─────────────────────────────
CREATE TYPE partial_rule_path AS ENUM ('fifty_rule_escrow','hold_four_conditions','hold_policy_override','return','apply_forbearance_plan','apply_trial');
CREATE TABLE partial_payment_evaluations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id            uuid NOT NULL REFERENCES payments(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  shortfall_cents       bigint NOT NULL,
  rule_path             partial_rule_path NOT NULL,
  condition_commitment  boolean,
  condition_not_habitual boolean,
  condition_no_nsf_history boolean,
  condition_30day_commitment boolean,
  evidence_refs         text[] NOT NULL DEFAULT '{}',
  decision_id           uuid REFERENCES agent_decisions(id),
  decided_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER partial_payment_evaluations_immutable BEFORE UPDATE OR DELETE ON partial_payment_evaluations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE loan_counters (                                         -- materialized rolling counters
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  partial_count_12m     int NOT NULL DEFAULT 0,
  late_30_count_12m     int NOT NULL DEFAULT 0,
  nsf_count_12m         int NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── 2.3 ACH autodraft ─────────────────────────────
CREATE TYPE sec_code AS ENUM ('PPD','WEB','TEL','CCD');
CREATE TYPE enrollment_status AS ENUM ('pending_validation','pending_authorization','active','suspended','revoked','terminated');
CREATE TYPE autodraft_amount_rule AS ENUM ('full_periodic_payment','periodic_plus_fixed_extra','fixed_amount','half_payment_semimonthly','biweekly_half');
CREATE TYPE draft_day_rule AS ENUM ('due_date','fixed_day','split_1_15','every_14_days');
CREATE TYPE account_validation_status AS ENUM ('pending','validated_api','validated_prenote','validated_microentry','validated_history','validated_noc','failed');
CREATE TABLE autodraft_enrollments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  borrower_id           uuid NOT NULL REFERENCES borrowers(id),
  status                enrollment_status NOT NULL DEFAULT 'pending_validation',
  sec_code              sec_code NOT NULL,
  authorization_kind    text NOT NULL CHECK (authorization_kind IN ('recurring','standing')),
  amount_rule           autodraft_amount_rule NOT NULL,
  extra_principal_cents bigint NOT NULL DEFAULT 0,
  fixed_amount_cents    bigint,
  draft_day_rule        draft_day_rule NOT NULL,
  draft_day             smallint CHECK (draft_day BETWEEN 1 AND 16),
  next_draft_on         date,
  bank_account_token    text NOT NULL,                             -- vaulted
  bank_account_last4    char(4) NOT NULL,
  routing_number        char(9) NOT NULL,
  account_type          text NOT NULL CHECK (account_type IN ('checking','savings')),
  validation_status     account_validation_status NOT NULL DEFAULT 'pending',
  validated_at          timestamptz,
  consent_id            uuid REFERENCES consents(id),
  authorization_document_id uuid REFERENCES documents(id),
  authorization_copy_delivered_at timestamptz,
  revocation_instructions_version text,
  range_notice_election jsonb,
  created_via           payment_channel,
  revoked_at            timestamptz,
  revocation_source     text,
  termination_reason    text,
  retention_until       date,
  rule_set_version      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN autodraft_enrollments.bank_account_token IS 'pii';
CREATE TYPE ach_direction AS ENUM ('debit','credit');
CREATE TYPE ach_entry_status AS ENUM ('built','transmitted','acknowledged','settled','returned','noc_received','cancelled');
CREATE TABLE ach_files (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id_modifier      char(1) NOT NULL,
  built_at              timestamptz NOT NULL DEFAULT now(),
  transmitted_at        timestamptz,
  entry_count           int NOT NULL DEFAULT 0,
  total_debit_cents     bigint NOT NULL DEFAULT 0,
  total_credit_cents    bigint NOT NULL DEFAULT 0,
  ack_status            text,
  document_id           uuid REFERENCES documents(id),
  hash                  text,
  retention             retention_class NOT NULL DEFAULT 'respa_5y'
);
CREATE TABLE ach_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id         uuid REFERENCES autodraft_enrollments(id),
  payment_id            uuid REFERENCES payments(id),
  direction             ach_direction NOT NULL,
  sec_code              sec_code NOT NULL,
  amount_cents          bigint NOT NULL,
  effective_entry_date  date NOT NULL,
  settlement_date       date,
  company_entry_description text NOT NULL,
  trace_number          text,
  file_id               uuid REFERENCES ach_files(id),
  status                ach_entry_status NOT NULL DEFAULT 'built',
  return_code           text,
  returned_at           timestamptz,
  reinitiation_of_entry_id uuid REFERENCES ach_entries(id),
  reinitiation_count    int NOT NULL DEFAULT 0,
  idempotency_key       text NOT NULL UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ach_returns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id              uuid NOT NULL REFERENCES ach_entries(id),
  return_code           text NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  action_taken          text,
  raw                   jsonb
);
CREATE TABLE ach_nocs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id              uuid NOT NULL REFERENCES ach_entries(id),
  change_code           text NOT NULL,
  corrected_data        jsonb NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  action_taken          text,
  applied_at            timestamptz
);
CREATE TYPE autodraft_notice_kind AS ENUM ('enrollment_confirmation','variable_amount_10d','revocation_confirmation','return_notice','reinitiation_notice','suspension_notice');
CREATE TABLE autodraft_notices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id         uuid NOT NULL REFERENCES autodraft_enrollments(id),
  kind                  autodraft_notice_kind NOT NULL,
  notice_id             uuid,
  due_by                timestamptz,
  sent_at               timestamptz
);
CREATE TABLE fraud_monitor_findings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id              uuid REFERENCES ach_entries(id),
  enrollment_id         uuid REFERENCES autodraft_enrollments(id),
  rule                  text NOT NULL,
  score                 numeric(5,2) NOT NULL,
  disposition           text,
  reviewer              text,
  at                    timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── 2.4 curtailments ─────────────────────────────
CREATE TABLE curtailment_reapplications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  original_curtailment_event_ids uuid[] NOT NULL,
  amount_reapplied_cents bigint NOT NULL,
  eligibility           jsonb NOT NULL,                            -- {portfolio_or_nonmbs_participation, balance_not_higher_than_schedule, no_maf_funds, borrower_supplement_agreed}
  decision_id           uuid REFERENCES agent_decisions(id),
  investor_event_ids    uuid[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TYPE reamortization_status AS ENUM ('requested','computed','offered','executed','effective','declined');
CREATE TABLE reamortizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  requested_on          date NOT NULL,
  basis_upb_cents       bigint NOT NULL,
  rate                  numeric(9,6) NOT NULL,
  remaining_term_months int NOT NULL,
  new_pi_cents          bigint NOT NULL,
  effective_due_date    date NOT NULL,
  form_181_document_id  uuid REFERENCES documents(id),
  borrower_execution_required boolean NOT NULL DEFAULT false,
  executed_at           timestamptz,
  custodian_delivered_at timestamptz,
  evault_delivered_at   timestamptz,
  lar83_event_id        uuid,
  status                reamortization_status NOT NULL DEFAULT 'requested',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fnma_principal_reduction_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  source_document_id    uuid REFERENCES documents(id),
  amount_cents          bigint NOT NULL,
  applied_event_id      uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── 2.5 third-party / biweekly ─────────────────────────────
CREATE TABLE third_party_payment_arrangements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  contractor_id         uuid NOT NULL REFERENCES parties(id),
  cadence               text NOT NULL CHECK (cadence IN ('biweekly_half','monthly_full_plus_extra','other')),
  expected_amount_cents bigint NOT NULL,
  expected_remit_day    smallint,
  extra_principal_designation_rule text NOT NULL CHECK (extra_principal_designation_rule IN ('contractor_file','borrower_standing_instruction','none')),
  remittance_format     jsonb NOT NULL DEFAULT '{}',
  verified_at           timestamptz,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','ended')),
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE loan_terms ADD COLUMN IF NOT EXISTS payment_frequency text NOT NULL DEFAULT 'monthly' CHECK (payment_frequency IN ('monthly','biweekly'));
ALTER TABLE loan_terms ADD COLUMN IF NOT EXISTS biweekly_pi_cents bigint;
ALTER TABLE loan_terms ADD COLUMN IF NOT EXISTS interest_days_per_period smallint;

-- ───────────────────────────── 2.6 trial period ─────────────────────────────
CREATE TYPE trial_status AS ENUM ('due','satisfied','missed');
CREATE TABLE trial_payment_schedules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  trial_number          smallint NOT NULL,
  due_date              date NOT NULL,
  trial_amount_cents    bigint NOT NULL,
  received_cents        bigint NOT NULL DEFAULT 0,
  satisfied_on          date,
  status                trial_status NOT NULL DEFAULT 'due',
  smdu_reported_at      timestamptz,
  smdu_ack_ref          text,
  UNIQUE (case_id, trial_number)
);
CREATE TABLE trial_funds_summary (
  case_id               uuid PRIMARY KEY REFERENCES cases(id),
  held_cents            bigint NOT NULL DEFAULT 0,
  contractual_applied_cents bigint NOT NULL DEFAULT 0,
  installments_satisfied date[] NOT NULL DEFAULT '{}',
  residual_at_end_cents bigint,
  capitalization_reduction_cents bigint,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── 2.7 fees ─────────────────────────────
CREATE TYPE fee_type AS ENUM ('late_charge','nsf_fee','other_fee');
CREATE TYPE fee_state AS ENUM ('assessed','accrued_suspended','collected','partially_collected','waived','reversed','written_off');
CREATE TYPE fee_suppression_reason AS ENUM ('forbearance_active','repayment_plan_pending_waiver','trial_pending_waiver','scra_reduced_rate','bankruptcy_active','transfer_window_60','noe_dispute','foreclosure_referred','posting_backlog');
CREATE TYPE fee_waiver_reason AS ENUM ('workout_completion','trial_conversion','scra','transfer_misdirected','error_correction','courtesy','disaster_policy','fnma_request','bk_plan');
CREATE TABLE fees (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  fee_type              fee_type NOT NULL,
  installment_due_date  date,
  basis_cents           bigint,
  pct                   numeric(6,4),
  amount_cents          bigint NOT NULL,
  assessed_on           date NOT NULL,
  grace_end_on          date,
  state                 fee_state NOT NULL DEFAULT 'assessed',
  suppression_reason    fee_suppression_reason,
  collected_cents       bigint NOT NULL DEFAULT 0,
  waived_cents          bigint NOT NULL DEFAULT 0,
  waiver_reason         fee_waiver_reason,
  waived_by             text,
  decision_id           uuid REFERENCES agent_decisions(id),
  investor_reported_period text,
  bk_3002_1_notice_id   uuid,
  nonreimbursable_reason text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fees_loan_idx ON fees(loan_id, assessed_on);
CREATE TABLE late_charge_suppressions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  reason                fee_suppression_reason NOT NULL,
  source_case_id        uuid REFERENCES cases(id),
  starts_on             date NOT NULL,
  ends_on               date,
  mode                  text NOT NULL CHECK (mode IN ('no_accrual','accrue_suspended','no_collection')),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE late_charge_waiver_counters (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  courtesy_waivers_12m  int NOT NULL DEFAULT 0,
  nsf_waivers_12m       int NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMIT;
