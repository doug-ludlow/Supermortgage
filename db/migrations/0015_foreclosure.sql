-- 0015_foreclosure.sql — Section 13 (13.1–13.9): gates, holds consumers, referral, prereferral, timeframes, law firms, litigation, SCRA.
BEGIN;

-- 13.1 gates
CREATE TABLE foreclosure_gate_definitions (
  code                  text PRIMARY KEY,
  citation              text NOT NULL,
  applies_to_steps      text[] NOT NULL,
  scope                 text NOT NULL CHECK (scope IN ('principal_residence_only','all')),
  evaluator             text NOT NULL,
  rule_set              text NOT NULL
);
CREATE TABLE foreclosure_gate_evaluations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  gate_code             text NOT NULL REFERENCES foreclosure_gate_definitions(code),
  step                  text NOT NULL,
  evaluated_at          timestamptz NOT NULL DEFAULT now(),
  result                text NOT NULL CHECK (result IN ('open','closed')),
  reason_code           text,
  inputs                jsonb NOT NULL DEFAULT '{}',
  rule_set_version      text NOT NULL,
  command_id            uuid,
  decision_id           uuid REFERENCES agent_decisions(id)
);
CREATE TRIGGER foreclosure_gate_evaluations_immutable BEFORE UPDATE OR DELETE ON foreclosure_gate_evaluations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS principal_residence boolean,
  ADD COLUMN IF NOT EXISTS regx_lossmit_scope boolean,
  ADD COLUMN IF NOT EXISTS fc_120_day_open_on date,
  ADD COLUMN IF NOT EXISTS fc_referral_deadline_on date;

-- 13.2
CREATE TABLE attorney_firms (
  firm_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id              uuid REFERENCES parties(id),
  legal_name            text NOT NULL,
  tax_id_enc            bytea,
  offices               jsonb NOT NULL DEFAULT '[]',
  qualifying_attorneys  jsonb NOT NULL DEFAULT '[]',
  eo_tier               text,
  eo_per_occurrence_cents bigint,
  eo_aggregate_cents    bigint,
  eo_expires_on         date,
  security_attestation_document_id uuid REFERENCES documents(id),
  doc_execution_certification_document_id uuid REFERENCES documents(id),
  vendor_disclosures    jsonb,
  adverse_practice_disclosure text,
  status                text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','rejected','form200_pending','no_objection','retained','suspended','terminated')),
  dra_attorney_role     boolean NOT NULL DEFAULT false,
  network_adapter_config jsonb,
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
COMMENT ON COLUMN attorney_firms.tax_id_enc IS 'pii';
CREATE TABLE attorney_instructions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES cases(id),
  firm_id               uuid REFERENCES attorney_firms(firm_id),
  kind                  text NOT NULL,
  payload               jsonb NOT NULL DEFAULT '{}',
  sent_at               timestamptz NOT NULL DEFAULT now(),
  acknowledged_at       timestamptz,
  ack_by                text,
  evidence_document_id  uuid REFERENCES documents(id),
  sla_timer_id          uuid REFERENCES timers(id)
);
ALTER TABLE foreclosure_holds ADD CONSTRAINT foreclosure_holds_instruction_fk FOREIGN KEY (attorney_instruction_id) REFERENCES attorney_instructions(id);
CREATE TABLE sale_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES cases(id),
  sale_at               timestamptz NOT NULL,
  status                text NOT NULL CHECK (status IN ('scheduled','postponed','cancelled','held','rescinded')),
  source                text NOT NULL CHECK (source IN ('firm_message','dra','court_docket')),
  postponed_reason      text,
  recorded_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lossmit_protection_snapshots (
  application_id        uuid PRIMARY KEY REFERENCES lossmit_applications(id),
  received_at           timestamptz NOT NULL,
  first_notice_filed_at timestamptz,
  sale_at_receipt       timestamptz,
  days_before_sale      int,
  protection_tier       text NOT NULL CHECK (protection_tier IN ('pre_filing_f2','g_full_90','g_37_to_89','fnma_15_to_37','fnma_lt_15','none')),
  rule_set_version      text NOT NULL
);
CREATE TRIGGER lossmit_protection_snapshots_immutable BEFORE UPDATE OR DELETE ON lossmit_protection_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 13.3 referral
CREATE TABLE foreclosure_cases (
  case_id               uuid PRIMARY KEY REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  firm_id               uuid REFERENCES attorney_firms(firm_id),
  jurisdiction_state    char(2) NOT NULL,
  method                text CHECK (method IN ('judicial','non_judicial','court_supervised')),
  foreclosing_party     text CHECK (foreclosing_party IN ('partner','fannie_mae')),
  referral_sent_at      timestamptz,
  referral_ack_at       timestamptz,
  referral_package_document_id uuid REFERENCES documents(id),
  first_notice_kind     text,
  first_notice_filed_at timestamptz,
  judgment_entered_at   timestamptz,
  sale_scheduled_at     timestamptz,
  sale_held_at          timestamptz,
  sale_outcome          text CHECK (sale_outcome IN ('fnma_acquired','third_party','cancelled','rescinded')),
  redemption_ends_at    date,
  confirmation_at       timestamptz,
  status                text NOT NULL DEFAULT 'prereferral',
  lpi_due_date          date,
  principal_residence   boolean,
  mi_company            text,
  deficiency_policy     text NOT NULL DEFAULT 'n_a' CHECK (deficiency_policy IN ('pursue','waive','n_a'))
);
CREATE TABLE foreclosure_milestones (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES foreclosure_cases(case_id),
  code                  text NOT NULL,
  occurred_on           date NOT NULL,
  source                text NOT NULL CHECK (source IN ('firm','dra','court','servicer')),
  evidence_document_id  uuid REFERENCES documents(id),
  reported_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER foreclosure_milestones_immutable BEFORE UPDATE OR DELETE ON foreclosure_milestones FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE attorney_referrals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES foreclosure_cases(case_id),
  firm_id               uuid NOT NULL REFERENCES attorney_firms(firm_id),
  package_manifest      jsonb NOT NULL,
  data_snapshot         jsonb NOT NULL,
  sent_at               timestamptz NOT NULL,
  ack_at                timestamptz,
  ack_complete          boolean,
  missing_items         jsonb
);
COMMENT ON COLUMN attorney_referrals.data_snapshot IS 'pii';
CREATE TABLE assignments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  from_party            text NOT NULL,
  to_party              text NOT NULL,
  state                 char(2) NOT NULL,
  prepared_at           timestamptz,
  executed_at           timestamptz,
  executed_by           uuid REFERENCES personnel(id),
  recorded_at           timestamptz,
  recording_ref         text,
  document_id           uuid REFERENCES documents(id),
  mers_transaction_id   text
);
CREATE TABLE note_custody (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  custodian_id          uuid REFERENCES parties(id),
  form_2009_request_id  text,
  requested_at          timestamptz,
  released_at           timestamptz,
  returned_at           timestamptz,
  lost_note_affidavit_id uuid REFERENCES documents(id)
);
CREATE TABLE bid_instructions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES foreclosure_cases(case_id),
  sale_at               timestamptz NOT NULL,
  basis                 text NOT NULL CHECK (basis IN ('reserve_price','total_indebtedness','mi_instruction','fha_va_rd')),
  reserve_price_cents   bigint,
  reserve_expires_on    date,
  total_indebtedness_cents bigint NOT NULL,
  insurance_claim_outstanding_cents bigint NOT NULL DEFAULT 0,
  bid_cents             bigint NOT NULL,
  transfer_tax_incremental boolean NOT NULL DEFAULT false,
  issued_at             timestamptz,
  firm_ack_at           timestamptz,
  decision_id           uuid REFERENCES agent_decisions(id)
);
CREATE TABLE sale_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES foreclosure_cases(case_id),
  sale_at               timestamptz NOT NULL,
  outcome               text NOT NULL,
  winning_bid_cents     bigint,
  bidder                text CHECK (bidder IN ('fnma','third_party')),
  deposit_cents         bigint,
  final_payment_received_at timestamptz,
  proceeds_remitted_at  timestamptz,
  surplus_cents         bigint NOT NULL DEFAULT 0,
  shortfall_cents       bigint NOT NULL DEFAULT 0,
  confirmation_at       timestamptz,
  reogram_case_id       uuid
);
ALTER TABLE jurisdiction_rules ADD COLUMN IF NOT EXISTS foreclosure jsonb;

-- 13.4 prereferral
CREATE TABLE prereferral_reviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES foreclosure_cases(case_id),
  window_opens_on       date,
  referral_required_on  date,
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  outcome               text CHECK (outcome IN ('refer','refer_expedited','hold_lossmit','hold_bankruptcy','hold_scra','hold_disaster_approval','hold_environmental','hold_title','hold_litigation','hold_occupancy_unresolved','postpone_e3204','not_eligible_other')),
  checklist             jsonb NOT NULL DEFAULT '[]',
  evidence_package_document_id uuid REFERENCES documents(id),
  decision_id           uuid REFERENCES agent_decisions(id),
  reviewer_role         text
);
CREATE TRIGGER prereferral_reviews_immutable BEFORE DELETE ON prereferral_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE disaster_fc_approval_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES foreclosure_cases(case_id),
  kind                  text NOT NULL CHECK (kind IN ('initiate','continue')),
  submitted_at          timestamptz,
  channel               text,
  message_id            uuid REFERENCES integration_messages(id),
  payload               jsonb NOT NULL,
  fnma_response         text NOT NULL DEFAULT 'pending' CHECK (fnma_response IN ('pending','approved','denied','info_requested')),
  responded_at          timestamptz,
  response_document_id  uuid REFERENCES documents(id),
  decision_id           uuid REFERENCES agent_decisions(id)
);

-- 13.5 timeframes / comp fees
CREATE TABLE comp_fee_delay_rules (
  category              text NOT NULL,
  exhibit_version       text NOT NULL,
  cap_days              int,
  cap_scope             text NOT NULL CHECK (cap_scope IN ('per_filing','first_occurrence','per_workout','total')),
  status_codes          text[] NOT NULL DEFAULT '{}',
  conditions            jsonb,
  PRIMARY KEY (category, exhibit_version)
);
CREATE TABLE fc_timeframe_tracking (
  case_id               uuid PRIMARY KEY REFERENCES foreclosure_cases(case_id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  state                 char(2) NOT NULL,
  nyc                   boolean NOT NULL DEFAULT false,
  method_used           text,
  method_preferred      text,
  method_deviation_form20_id uuid,
  lpi_due_date          date NOT NULL,
  allowable_days        int NOT NULL,
  exhibit_version       text NOT NULL,
  referral_sent_at      timestamptz,
  first_notice_filed_at timestamptz,
  sale_held_at          timestamptz,
  actual_days           int,
  credited_delay_days   int NOT NULL DEFAULT 0,
  excess_days           int NOT NULL DEFAULT 0,
  exposure_cents        bigint NOT NULL DEFAULT 0,
  exposure_as_of        date,
  status                text NOT NULL DEFAULT 'tracking' CHECK (status IN ('tracking','at_risk_70pct','over_allowable','closed_within','closed_over','closed_other'))
);
CREATE TABLE fc_delay_credits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES foreclosure_cases(case_id),
  category              text NOT NULL CHECK (category IN ('bk7','bk11','bk12','bk13','probate','military_indulgence','contested','workout_review_pre2012','tpp','nj_2010_2012','covid_moratorium','forbearance','forbearance_covid','legislative_judicial','other_reasonable')),
  status_code_reported  text,
  begin_on              date NOT NULL,
  end_on                date,
  actual_days           int,
  cap_days              int,
  credited_days         int NOT NULL DEFAULT 0,
  reported_timely       boolean,
  report_ack_id         uuid,
  evidence_ids          uuid[] NOT NULL DEFAULT '{}'
);
CREATE TRIGGER fc_delay_credits_immutable BEFORE DELETE ON fc_delay_credits FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE comp_fee_bills (
  bill_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period                char(7) NOT NULL,
  fnma_reference        text,
  loan_id               uuid NOT NULL REFERENCES loans(id),
  days_billed           int NOT NULL,
  upb_cents             bigint NOT NULL,
  ptr                   numeric(9,6) NOT NULL,
  amount_cents          bigint NOT NULL,
  received_at           timestamptz NOT NULL,
  rebuttal_status       text,
  rebuttal_document_id  uuid REFERENCES documents(id),
  allocation            text CHECK (allocation IN ('supermortgage','partner','shared')),
  paid_at               timestamptz
);

-- 13.6 law firms
CREATE TABLE attorney_retentions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               uuid NOT NULL REFERENCES attorney_firms(firm_id),
  jurisdiction_state    char(2) NOT NULL,
  form200_submitted_at  timestamptz,
  form200_response      text,
  form200_response_at   timestamptz,
  training_completed_at timestamptz,
  lra_executed_at       timestamptz,
  retained_from         date,
  retained_to           date,
  suspended_from        date,
  capacity_max_open     int
);
CREATE TABLE attorney_reviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               uuid NOT NULL REFERENCES attorney_firms(firm_id),
  kind                  text NOT NULL CHECK (kind IN ('annual','risk_triggered','onsite','desk')),
  scheduled_for         date,
  completed_at          timestamptz,
  elements              jsonb NOT NULL DEFAULT '[]',
  findings              jsonb NOT NULL DEFAULT '[]',
  remediation_plan_document_id uuid REFERENCES documents(id),
  fnma_requested        boolean NOT NULL DEFAULT false
);
CREATE TABLE attorney_escalations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               uuid NOT NULL REFERENCES attorney_firms(firm_id),
  category              text NOT NULL,
  discovered_at         timestamptz NOT NULL,
  sent_to_fnma_at       timestamptz,
  channel               text,
  message_id            uuid REFERENCES integration_messages(id),
  poc                   jsonb,
  fnma_direction        text,
  decision_id           uuid REFERENCES agent_decisions(id)
);
CREATE TABLE attorney_matters (
  matter_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES cases(id),
  firm_id               uuid NOT NULL REFERENCES attorney_firms(firm_id),
  kind                  text NOT NULL CHECK (kind IN ('foreclosure','bankruptcy','eviction','litigation','reo_closing')),
  referred_at           timestamptz NOT NULL,
  ack_at                timestamptz,
  ack_complete          boolean,
  status                text NOT NULL DEFAULT 'open',
  transferred_from_matter_id uuid REFERENCES attorney_matters(matter_id),
  transfer_reason       text
);
CREATE TABLE attorney_fee_schedules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state                 char(2) NOT NULL,
  method                text NOT NULL,
  allowable_fee_cents   bigint NOT NULL,
  milestones            jsonb NOT NULL,
  exhibit_version       text NOT NULL,
  effective_from        date NOT NULL,
  UNIQUE (state, method, exhibit_version)
);
CREATE TABLE attorney_invoices (
  invoice_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id             uuid NOT NULL REFERENCES attorney_matters(matter_id),
  firm_id               uuid NOT NULL REFERENCES attorney_firms(firm_id),
  received_at           timestamptz NOT NULL,
  period                text,
  review_result         text CHECK (review_result IN ('approved','partially_approved','rejected','excess_pending')),
  review_findings       jsonb,
  paid_at               timestamptz,
  paid_amount_cents     bigint,
  borrower_chargeable_cents bigint,
  claimable_cents       bigint,
  decision_id           uuid REFERENCES agent_decisions(id)
);
CREATE TABLE attorney_invoice_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id            uuid NOT NULL REFERENCES attorney_invoices(invoice_id),
  kind                  text NOT NULL CHECK (kind IN ('fee_milestone','cost','tech_fee','einvoice_fee','excess_fee')),
  milestone_code        text,
  pct                   numeric(6,3),
  amount_cents          bigint NOT NULL,
  description           text,
  receipt_document_id   uuid REFERENCES documents(id),
  approved_cents        bigint
);
CREATE TABLE dra_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imported_at           timestamptz NOT NULL DEFAULT now(),
  source                text NOT NULL CHECK (source IN ('portal_export','manual')),
  document_id           uuid REFERENCES documents(id),
  row_count             int NOT NULL DEFAULT 0
);
CREATE TABLE dra_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id           uuid REFERENCES dra_snapshots(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  event_name            text NOT NULL,
  event_date            date NOT NULL,
  entered_by_firm       uuid REFERENCES attorney_firms(firm_id),
  imported_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dra_reconciliation_exceptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES foreclosure_cases(case_id),
  expected_event        text NOT NULL,
  expected_by           date NOT NULL,
  found                 boolean NOT NULL DEFAULT false,
  difference_days       int,
  resolved_at           timestamptz
);

-- 13.7 litigation / environmental
CREATE TABLE form20_submissions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id             uuid,
  kind                  text NOT NULL CHECK (kind IN ('non_routine_litigation','environmental_litigation','method_deviation','other_escalation')),
  prepared_at           timestamptz NOT NULL DEFAULT now(),
  package_document_id   uuid REFERENCES documents(id),
  submitted_at          timestamptz,
  submitted_by          text,
  quatro_reference      text,
  fnma_response         text,
  responded_at          timestamptz
);
ALTER TABLE fc_timeframe_tracking ADD CONSTRAINT fc_tt_form20_fk FOREIGN KEY (method_deviation_form20_id) REFERENCES form20_submissions(id);
CREATE TABLE litigation_matters (
  matter_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  court                 text,
  docket_no             text,
  caption               text,
  role                  text CHECK (role IN ('defendant','plaintiff','third_party')),
  served_at             timestamptz,
  notice_received_at    timestamptz,
  classification        text NOT NULL DEFAULT 'routine' CHECK (classification IN ('routine','non_routine')),
  categories            text[] NOT NULL DEFAULT '{}',
  exception_category    text NOT NULL DEFAULT 'none' CHECK (exception_category IN ('standing','mers','hamp','none')),
  exception_trigger     text NOT NULL DEFAULT 'none' CHECK (exception_trigger IN ('summary_judgment','briefing','trial','none')),
  form20_required       boolean NOT NULL DEFAULT false,
  form20_due_at         timestamptz,
  form20_submission_id  uuid REFERENCES form20_submissions(id),
  fnma_direction        jsonb,
  counsel_firm_id       uuid REFERENCES attorney_firms(firm_id),
  special_counsel       boolean NOT NULL DEFAULT false,
  pleading_deadlines    jsonb NOT NULL DEFAULT '[]',
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','stayed','settled','judgment','dismissed','appeal','closed')),
  fc_hold_id            uuid REFERENCES foreclosure_holds(id),
  privileged            boolean NOT NULL DEFAULT false,
  decision_id           uuid REFERENCES agent_decisions(id)
);
ALTER TABLE form20_submissions ADD CONSTRAINT form20_matter_fk FOREIGN KEY (matter_id) REFERENCES litigation_matters(matter_id);
CREATE TABLE environmental_hazards (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  property_id           uuid REFERENCES properties(id),
  kind                  text NOT NULL,
  source                text,
  detected_at           timestamptz NOT NULL,
  severity              text NOT NULL CHECK (severity IN ('suspected','confirmed')),
  citation_document_id  uuid REFERENCES documents(id),
  children_under_8      boolean,
  property_value_cents  bigint,
  outstanding_debt_cents bigint,
  servicing_rep_reported_at timestamptz,
  lead_paint_notification_due_at timestamptz,
  fnma_direction        text,
  fc_hold_id            uuid REFERENCES foreclosure_holds(id),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared','fnma_directed_proceed','fnma_directed_hold','charged_off'))
);

-- 13.8 / 13.9 SCRA
CREATE TABLE scra_verifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  borrower_id           uuid NOT NULL REFERENCES borrowers(id),
  requested_at          timestamptz NOT NULL,
  method                text NOT NULL CHECK (method IN ('dmdc_single','dmdc_batch','orders','form_180','other')),
  status_date           date NOT NULL,
  on_active_duty        text NOT NULL CHECK (on_active_duty IN ('Y','X','N','Z','unknown')),
  left_active_duty_367  boolean,
  future_call_up        boolean,
  service_begin_on      date,
  service_end_on        date,
  component             text,
  certificate_id        text,
  certificate_document_id uuid REFERENCES documents(id),
  error_code            text,
  purpose               text NOT NULL CHECK (purpose IN ('boarding','day45','prereferral','first_notice','judgment','presale_30','presale_7','eviction','rate_cap','periodic','transfer')),
  operator_id           text,
  decision_id           uuid REFERENCES agent_decisions(id)
);
CREATE TRIGGER scra_verifications_immutable BEFORE UPDATE OR DELETE ON scra_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE scra_cases (
  case_id               uuid PRIMARY KEY REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  servicemember_party_id uuid REFERENCES parties(id),
  basis                 text NOT NULL CHECK (basis IN ('dmdc','orders','form_180','state_guard')),
  service_begin_on      date NOT NULL,
  service_end_on        date,
  pre_service_obligation boolean NOT NULL,
  protection_ends_on    date,
  fc_stay_granted_at    timestamptz,
  rate_cap_case_id      uuid,
  contact_cadence_next_on date,
  status                text NOT NULL DEFAULT 'open_active_duty' CHECK (status IN ('open_active_duty','open_tail_12m','closed'))
);
CREATE TABLE scra_affidavits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES foreclosure_cases(case_id),
  court                 text,
  kind                  text NOT NULL CHECK (kind IN ('non_military_affidavit','unable_to_determine','military_status_declaration')),
  subjects              jsonb NOT NULL,
  drafted_at            timestamptz,
  executed_at           timestamptz,
  executed_by           uuid REFERENCES personnel(id),
  notarized             boolean NOT NULL DEFAULT false,
  filed_at              timestamptz,
  filed_by_firm_id      uuid REFERENCES attorney_firms(firm_id),
  document_id           uuid REFERENCES documents(id)
);
CREATE TABLE scra_rate_periods (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scra_case_id          uuid REFERENCES scra_cases(case_id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  basis                 text NOT NULL CHECK (basis IN ('orders','dmdc','form_180')),
  notice_received_on    date NOT NULL,
  service_begin_on      date NOT NULL,
  cap_effective_payment_due date NOT NULL,
  statutory_effective_on date NOT NULL,
  service_end_on        date,
  cap_ends_on           date,
  method                text NOT NULL DEFAULT 'standard' CHECK (method IN ('standard','interest_subsidy')),
  pre_cap_rate          numeric(9,6) NOT NULL,
  capped_rate           numeric(9,6) NOT NULL,
  pre_cap_pi_cents      bigint NOT NULL,
  capped_pi_cents       bigint NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','tail','ended')),
  restoration_pi_cents  bigint,
  decision_id           uuid REFERENCES agent_decisions(id)
);
ALTER TABLE scra_cases ADD CONSTRAINT scra_cases_rate_period_fk FOREIGN KEY (rate_cap_case_id) REFERENCES scra_rate_periods(id);
CREATE TABLE scra_recalculations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id             uuid NOT NULL REFERENCES scra_rate_periods(id),
  installment_due_on    date NOT NULL,
  upb_before_cents      bigint NOT NULL,
  interest_note_cents   bigint NOT NULL,
  interest_capped_cents bigint NOT NULL,
  forgiven_cents        bigint NOT NULL,
  principal_cents       bigint NOT NULL,
  payment_received_cents bigint NOT NULL DEFAULT 0,
  reallocation_entry_set_id uuid REFERENCES ledger_entry_sets(id),
  overpayment_cents     bigint NOT NULL DEFAULT 0,
  UNIQUE (period_id, installment_due_on)
);
CREATE TRIGGER scra_recalculations_immutable BEFORE UPDATE OR DELETE ON scra_recalculations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE scra_overpayment_elections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id             uuid NOT NULL REFERENCES scra_rate_periods(id),
  amount_cents          bigint NOT NULL,
  election              text NOT NULL DEFAULT 'pending' CHECK (election IN ('apply_as_payment','curtailment','refund','pending')),
  elected_at            timestamptz,
  default_applied_at    timestamptz
);
CREATE TABLE form_1022_submissions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  period_id             uuid REFERENCES scra_rate_periods(id),
  reason                text NOT NULL CHECK (reason IN ('rate_reduction','payment_change','other_indulgence','rate_restoration')),
  month                 char(7) NOT NULL,
  due_by                date NOT NULL,
  sent_at               timestamptz,
  message_id            uuid REFERENCES integration_messages(id),
  fnma_ack              text,
  channel               text CHECK (channel IN ('email_form1022','mbs_upload','transaction_83','servicing_event'))
);
ALTER TABLE loan_terms ADD COLUMN IF NOT EXISTS rate_override_kind text;
ALTER TABLE loan_terms ADD COLUMN IF NOT EXISTS arm_frozen boolean NOT NULL DEFAULT false;

COMMIT;
