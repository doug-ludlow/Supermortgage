-- 0017_reo.sql — Section 15 (15.1–15.4): REO/TPS cases, REOgram confirmations, expense claims, MI claims, delinquency-advance positions.
BEGIN;

CREATE TABLE reo_cases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  property_id           uuid REFERENCES properties(id),
  liquidation_fact_id   uuid REFERENCES liquidation_facts(id),
  acquisition_type      text NOT NULL CHECK (acquisition_type IN ('fcl_sale','mortgage_release','court_order','redemption_expired')),
  legal_date            date NOT NULL,
  title_vests_at        date,
  redemption_expires_at date,
  grantee_name          text NOT NULL DEFAULT 'Federal National Mortgage Association',
  foreclosed_in_name_of text CHECK (foreclosed_in_name_of IN ('fnma','servicer','mers_assignee')),
  deed_record_due       date,
  deed_submitted_at     timestamptz,
  deed_recorded_at      timestamptz,
  deed_document_id      uuid REFERENCES documents(id),
  resale_restriction_flags jsonb,
  mi_policy_id          uuid REFERENCES mi_policies(id),
  occupancy_status      text,
  preservation_stopped_at timestamptz,
  handoff_status        text,
  status                text NOT NULL DEFAULT 'open',
  created_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE liquidation_facts ADD CONSTRAINT liquidation_facts_reo_fk FOREIGN KEY (reo_case_id) REFERENCES reo_cases(id);
ALTER TABLE sale_results ADD CONSTRAINT sale_results_reo_fk FOREIGN KEY (reogram_case_id) REFERENCES reo_cases(id);
ALTER TABLE liquidation_cases ADD CONSTRAINT liquidation_cases_reo_fk FOREIGN KEY (reogram_id) REFERENCES reo_cases(id);
CREATE TABLE reogram_confirmations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reo_case_id           uuid NOT NULL REFERENCES reo_cases(id),
  p360_case_id          text,
  notification_received_at timestamptz NOT NULL,
  confirm_due_at        timestamptz NOT NULL,
  confirmed_at          timestamptz,
  confirmed_by          text,
  p360_status           text NOT NULL DEFAULT 'potential' CHECK (p360_status IN ('potential','confirmed','accepted','exception','eliminated')),
  accepted_at           timestamptz,
  exceptions            jsonb NOT NULL DEFAULT '[]',
  edit_window_ends_at   timestamptz,
  package_document_id   uuid REFERENCES documents(id),
  evidence_document_id  uuid REFERENCES documents(id),
  late_days             int NOT NULL DEFAULT 0
);
CREATE TABLE tps_cases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  liquidation_fact_id   uuid REFERENCES liquidation_facts(id),
  sale_date             date NOT NULL,
  bid_type              text,
  fnma_bid_cents        bigint,
  successful_bid_cents  bigint NOT NULL,
  judgment_cents        bigint,
  purchaser_party_id    uuid REFERENCES parties(id),
  deposit_cents         bigint,
  deposit_received_at   timestamptz,
  final_payment_received_at timestamptz,
  gross_proceeds_cents  bigint,
  fnma_total_indebtedness_cents bigint,
  restricted_resale_price_cents bigint,
  amount_due_fnma_cents bigint,
  remit_due_at          date,
  remitted_at           timestamptz,
  crs_batch_id          uuid REFERENCES crs_batches(id),
  servicer_recovery_cents bigint,
  surplus_cents         bigint,
  surplus_disposition   text NOT NULL DEFAULT 'none' CHECK (surplus_disposition IN ('none','junior_lien','borrower','court_registry')),
  closing_statement_sent_at timestamptz,
  p360_case_id          text,
  p360_status           text CHECK (p360_status IN ('intake','recon_ready','recon_in_progress','on_hold','reconciled','servicer_billed')),
  p360_exceptions       jsonb,
  documents             jsonb NOT NULL DEFAULT '[]',
  sale_failed_at        timestamptz,
  status                text NOT NULL DEFAULT 'open'
);
ALTER TABLE liquidation_facts ADD CONSTRAINT liquidation_facts_tps_fk FOREIGN KEY (tps_case_id) REFERENCES tps_cases(id);
CREATE TABLE reo_handoff_tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reo_case_id           uuid NOT NULL REFERENCES reo_cases(id),
  kind                  text NOT NULL CHECK (kind IN ('hazard_cancel','flood_cancel','lpi_cancel','mortgagee_interest_removal','refund_capture','deed_record','title_curative','eviction_docs','recovery_firm_info','utilities_note','hoa_note','keys_vendor_contact','preservation_stop','cpm_issue_report')),
  due_at                timestamptz,
  completed_at          timestamptz,
  evidence_document_id  uuid REFERENCES documents(id),
  owner                 text NOT NULL CHECK (owner IN ('agent','fnma_portal_operator','attorney','vendor'))
);
CREATE TABLE elimination_rescission_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reo_case_id           uuid NOT NULL REFERENCES reo_cases(id),
  kind                  text NOT NULL CHECK (kind IN ('elimination','rescission','both')),
  reason_code           text NOT NULL CHECK (reason_code IN ('sale_set_aside','bk_stay_violation','scra','title_defect','wrong_loan','reinstated_pre_sale','other')),
  identified_at         timestamptz NOT NULL,
  submit_due_at         date NOT NULL,
  template_document_id  uuid REFERENCES documents(id),
  submitted_at          timestamptz,
  approved_at           timestamptz,
  reintegrate_due_at    timestamptz,
  title_steps_due_at    date,
  status                text NOT NULL DEFAULT 'open'
);

-- 15.2
CREATE TABLE allowable_fee_schedules (
  rule_set              text NOT NULL,
  code                  text NOT NULL,
  jurisdiction          text NOT NULL DEFAULT '*',
  kind                  text NOT NULL,
  cap_cents             bigint NOT NULL,
  cap_unit              text,
  life_of_default       boolean NOT NULL DEFAULT false,
  notes                 text,
  source_url            text,
  PRIMARY KEY (rule_set, code, jurisdiction)
);
CREATE TABLE expense_claims (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  claim_type            text NOT NULL CHECK (claim_type IN ('571','fnma_mod','npl','hecm','recon','sol')),
  claim_number          text NOT NULL UNIQUE,
  p360_claim_id         text,
  milestone_event_id    uuid,
  milestone_kind        text,
  milestone_date        date,
  final_due_at          date,
  interim               boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated','package_ready','submitted','hold','psa','approved','paid','partially_paid','denied','curtailed','rejected','void','disputed','closed')),
  submitted_at          timestamptz,
  submission_channel    text CHECK (submission_channel IN ('api','b2b','bulk_upload','single_entry')),
  p360_status           text,
  psa_due_at            date,
  paid_at               timestamptz,
  paid_amount_cents     bigint,
  check_number          text,
  ach_expected_by       date,
  ach_matched_entry_id  uuid,
  gross_cents           bigint NOT NULL DEFAULT 0,
  credits_cents         bigint NOT NULL DEFAULT 0,
  net_cents             bigint NOT NULL DEFAULT 0,
  submitter_poc         text,
  attachments_manifest  jsonb NOT NULL DEFAULT '[]',
  age_reset_count       int NOT NULL DEFAULT 0,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE expense_claim_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES expense_claims(id),
  advance_id            uuid REFERENCES advances(id),
  p360_expense_type     text NOT NULL,
  p360_subtype          text,
  service_start         date,
  service_end           date,
  quantity              int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents      bigint NOT NULL,
  amount_cents          bigint NOT NULL,
  paid_date             date,
  payee                 text,
  invoice_number        text,
  allowable_code        text,
  allowable_cap_cents   bigint,
  life_of_loan_used_cents bigint,
  excess_fee_approval_id text,
  hometracker_bid_id    uuid REFERENCES preservation_bids(id),
  nonrecoverable_indicator text NOT NULL DEFAULT 'blank' CHECK (nonrecoverable_indicator IN ('blank','non_recoverable','not_yet_recovered')),
  validation            text CHECK (validation IN ('pass','warn','fail')),
  validation_messages   jsonb NOT NULL DEFAULT '[]',
  attachment_document_ids uuid[] NOT NULL DEFAULT '{}',
  p360_line_status      text,
  approved_cents        bigint,
  denial_reason         text,
  curtail_reason        text,
  irt_inquiry_id        uuid,
  CHECK (amount_cents = unit_price_cents * quantity)
);
CREATE TABLE claim_credits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES expense_claims(id),
  kind                  text NOT NULL CHECK (kind IN ('hazard_refund','flood_refund','mi_refund','borrower_collection','escrow_balance','rents','other')),
  amount_cents          bigint NOT NULL,
  received_at           timestamptz,
  remit_code_if_post_claim text CHECK (remit_code_if_post_claim IN ('318','336','353','352','571')),
  remitted_at           timestamptz
);
CREATE TABLE irt_inquiries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid REFERENCES expense_claims(id),
  line_id               uuid REFERENCES expense_claim_lines(id),
  category              text NOT NULL,
  submitted_at          timestamptz,
  fnma_response_at      timestamptz,
  response_due_at       date,
  status                text NOT NULL DEFAULT 'open',
  reopen_count          int NOT NULL DEFAULT 0 CHECK (reopen_count <= 2),
  outcome               text,
  document_ids          uuid[] NOT NULL DEFAULT '{}'
);
ALTER TABLE expense_claim_lines ADD CONSTRAINT expense_claim_lines_irt_fk FOREIGN KEY (irt_inquiry_id) REFERENCES irt_inquiries(id);
ALTER TABLE advance_recoveries
  ADD COLUMN IF NOT EXISTS fnma_repaid_at timestamptz,
  ADD COLUMN IF NOT EXISTS crs_code text,
  ADD COLUMN IF NOT EXISTS report_line_ref text,
  ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE advance_recoveries DROP CONSTRAINT IF EXISTS advance_recoveries_source_check;
ALTER TABLE advance_recoveries ADD CONSTRAINT advance_recoveries_source_check CHECK (source IN ('borrower_reinstatement','borrower_payoff','payoff','fnma_reimbursement','tps_proceeds','claim','fnma_claim','mi_claim','write_off','reversal','fnma_liquidation_reimb','fnma_reclass_pa','fnma_deferral_reimb','fnma_sda_recovery_credit','sa_negative_interest_lar','payoff_proceeds','repurchase_price','borrower_contractual'));
ALTER TABLE property_inspections ADD CONSTRAINT property_inspections_claim_fk FOREIGN KEY (expense_claim_id) REFERENCES expense_claims(id);
ALTER TABLE preservation_work_orders ADD CONSTRAINT preservation_work_orders_claim_fk FOREIGN KEY (claim_id) REFERENCES expense_claims(id);
ALTER TABLE repair_inspections ADD CONSTRAINT repair_inspections_claim_fk FOREIGN KEY (claimed_in) REFERENCES expense_claims(id);

-- 15.3
CREATE TABLE mi_master_policy_terms (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_code          text NOT NULL,
  policy_form           text,
  effective_from        date NOT NULL,
  effective_to          date,
  claim_filing_days     int NOT NULL DEFAULT 60,
  late_deny_days        int NOT NULL DEFAULT 120,
  settlement_days       int NOT NULL DEFAULT 60,
  supplemental_days     int NOT NULL DEFAULT 90,
  interest_advance_cap_months int NOT NULL DEFAULT 36,
  attorney_fee_cap_rule text,
  nod_rule              text NOT NULL DEFAULT '25th of month of 2nd missed payment',
  appeal_days           int,
  micp_participant      boolean NOT NULL DEFAULT false,
  micp_effective_date   date,
  source_document_id    uuid REFERENCES documents(id)
);
CREATE TABLE mi_claims (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  mi_policy_id          uuid NOT NULL REFERENCES mi_policies(id),
  liquidation_fact_id   uuid REFERENCES liquidation_facts(id),
  liquidation_type      text NOT NULL CHECK (liquidation_type IN ('fcl_fnma','fcl_third_party','short_sale','mortgage_release','redemption_expired')),
  liquidation_date      date NOT NULL,
  claim_anchor_date     date NOT NULL,
  filer                 text NOT NULL CHECK (filer IN ('fnma_micp','servicer_direct')),
  micp_participant      boolean NOT NULL,
  micp_effective_date   date,
  master_policy_terms_id uuid REFERENCES mi_master_policy_terms(id),
  claim_filing_deadline date NOT NULL,
  micp_docs_due_at      date,
  direct_file_due_at    date,
  filed_at              timestamptz,
  perfected_at          timestamptz,
  settlement_due_at     date,
  supplemental_due_at   date,
  status                text NOT NULL DEFAULT 'open',
  settlement_option     text CHECK (settlement_option IN ('percentage','acquisition','third_party_sale','anticipated_loss')),
  expected_benefit_cents bigint,
  paid_benefit_cents    bigint,
  paid_at               timestamptz,
  paid_to               text CHECK (paid_to IN ('fnma','servicer')),
  curtailment_cents     bigint NOT NULL DEFAULT 0,
  curtailment_reasons   jsonb,
  denial_reason         text,
  rescission_flag       boolean NOT NULL DEFAULT false,
  servicer_caused_shortfall_cents bigint NOT NULL DEFAULT 0,
  make_whole_demand_id  uuid,
  notes                 text
);
CREATE TABLE mi_claim_calculations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES mi_claims(id),
  version               int NOT NULL,
  as_of                 date NOT NULL,
  upb_cents             bigint NOT NULL,
  interest_from         date NOT NULL,
  interest_to           date NOT NULL,
  interest_rate_bps     int NOT NULL,
  interest_cents        bigint NOT NULL,
  interest_months_capped boolean NOT NULL DEFAULT false,
  advances              jsonb NOT NULL DEFAULT '[]',
  attorney_fee_cap_cents bigint,
  credits               jsonb NOT NULL DEFAULT '[]',
  claim_amount_cents    bigint NOT NULL,
  coverage_pct          numeric(5,2) NOT NULL,
  benefit_cents         bigint NOT NULL,
  net_proceeds_cents    bigint,
  loss_cents            bigint,
  method_notes          text,
  UNIQUE (claim_id, version)
);
CREATE TRIGGER mi_claim_calculations_immutable BEFORE UPDATE OR DELETE ON mi_claim_calculations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE mi_claim_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES mi_claims(id),
  doc_kind              text NOT NULL,
  document_id           uuid REFERENCES documents(id),
  requested_at          timestamptz,
  due_at                date,
  potential_denial_date date,
  uploaded_at           timestamptz,
  uploaded_by           text,
  micp_request_id       text,
  status                text NOT NULL DEFAULT 'pending'
);
CREATE TABLE mi_curtailment_risk (
  loan_id               uuid NOT NULL REFERENCES loans(id),
  as_of                 date NOT NULL,
  nod_on_time           boolean,
  status_reports_current boolean,
  fcl_days_used         int,
  fcl_days_allowable    int,
  allowable_delays_days int,
  projected_excess_days int,
  interest_months_accrued int,
  cap_months_remaining  int,
  property_condition_flags int NOT NULL DEFAULT 0,
  docs_ready_pct        numeric(5,2),
  risk_score            numeric(4,3),
  PRIMARY KEY (loan_id, as_of)
);

-- 15.4
CREATE TABLE delinquency_advance_positions (
  loan_id               uuid NOT NULL REFERENCES loans(id),
  as_of                 date NOT NULL,
  remittance_type       text,
  servicing_option      text,
  servicer_pi_advances_outstanding_cents bigint NOT NULL DEFAULT 0,
  periods               jsonb NOT NULL DEFAULT '[]',
  fnma_sda_receivable_cents bigint NOT NULL DEFAULT 0,
  sa_interest_advanced_cents bigint NOT NULL DEFAULT 0,
  sa_month4_interest_cents bigint NOT NULL DEFAULT 0,
  gfee_advanced_cents   bigint NOT NULL DEFAULT 0,
  expected_recovery_event text CHECK (expected_recovery_event IN ('liquidation_lar','reclass_pa','deferral_acceptance','payoff','repurchase','borrower_contractual','pre_fcl_removal')),
  expected_by           date,
  matched_cents         bigint NOT NULL DEFAULT 0,
  variance_cents        bigint NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'accruing' CHECK (status IN ('accruing','sda_active','recovery_expected','matched','variance','escalated','closed')),
  PRIMARY KEY (loan_id, as_of)
);

COMMIT;
