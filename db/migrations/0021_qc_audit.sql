-- 0021_qc_audit.sql — Section 18 (18.1–18.7): QC plan/rules/cycles/samples/tests/findings/CAPA, AI governance, exams, STAR, regulatory filings, fraud, Reg AB, eligibility.
BEGIN;

-- 18.1
CREATE TABLE qc_plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version               text NOT NULL UNIQUE,
  effective_from        date NOT NULL,
  approved_by_officer_id text,
  partner_accepted_at   timestamptz,
  document_id           uuid REFERENCES documents(id),
  scope_map             jsonb NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'draft',
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE TABLE qc_rules (
  code                  text NOT NULL,
  version               text NOT NULL,
  citation              text,
  taxonomy_nodes        text[] NOT NULL DEFAULT '{}',
  population_selector   text NOT NULL,
  test_kind             text NOT NULL CHECK (test_kind IN ('rederive','checklist','judgment_llm','judgment_human','control_walkthrough')),
  sampling              jsonb NOT NULL DEFAULT '{"method":"census"}',
  severity_default      text,
  owner_agent           text,
  remediation_owner_role text,
  enabled_from          date NOT NULL,
  enabled_to            date,
  PRIMARY KEY (code, version)
);
CREATE TABLE qc_cycles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('monthly','quarterly','annual','adhoc')),
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  report_document_id    uuid REFERENCES documents(id),
  signed_by_officer_id  text,
  status                text NOT NULL DEFAULT 'open'
);
CREATE TABLE qc_samples (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id              uuid NOT NULL REFERENCES qc_cycles(id),
  rule_code             text NOT NULL,
  rule_version          text NOT NULL,
  population_n          int NOT NULL,
  sample_n              int NOT NULL,
  selection_seed        bigint,
  selection_method      text NOT NULL,
  population_hash       text NOT NULL,
  FOREIGN KEY (rule_code, rule_version) REFERENCES qc_rules(code, version)
);
CREATE TABLE qc_tests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id             uuid NOT NULL REFERENCES qc_samples(id),
  subject_type          text NOT NULL CHECK (subject_type IN ('loan','case','notice','payment','escrow_analysis','agent_decision','investor_event','ledger_entry','contact','vendor','control')),
  subject_id            uuid NOT NULL,
  result                text NOT NULL CHECK (result IN ('pass','fail','na','inconclusive')),
  expected              jsonb,
  observed              jsonb,
  variance_cents        bigint,
  reviewer_kind         text NOT NULL CHECK (reviewer_kind IN ('engine','llm','human')),
  reviewer_model_version text,
  agent_decision_id     uuid REFERENCES agent_decisions(id),
  human_reviewer_id     text,
  tested_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER qc_tests_immutable BEFORE UPDATE OR DELETE ON qc_tests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE qc_findings (
  case_id               uuid PRIMARY KEY REFERENCES cases(id),
  finding_code          text NOT NULL,
  rule_code             text,
  cycle_id              uuid REFERENCES qc_cycles(id),
  severity              text NOT NULL CHECK (severity IN ('sev1_consumer_harm_or_fnma_breach','sev2_rule_breach_no_harm','sev3_documentation','sev4_observation')),
  root_cause            text CHECK (root_cause IN ('rule_defect','model_behavior','data_defect','vendor','human_error','process_gap','external')),
  affected_population_query text,
  affected_count        int NOT NULL DEFAULT 0,
  remediation_cents_total bigint NOT NULL DEFAULT 0,
  validated_at          timestamptz,
  reported_to_partner_at timestamptz,
  reported_to_fnma_at   timestamptz,
  regab_criterion       text,
  status                text NOT NULL DEFAULT 'open'
);
CREATE TABLE qc_corrective_actions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id            uuid NOT NULL REFERENCES qc_findings(case_id),
  action_kind           text NOT NULL CHECK (action_kind IN ('rule_fix','prompt_fix','retrain_eval','data_fix','refund','re_notice','vendor_action','training','policy_change')),
  owner_role            text NOT NULL,
  due_at                timestamptz NOT NULL,
  completed_at          timestamptz,
  effectiveness_check_cycle_id uuid REFERENCES qc_cycles(id),
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}'
);
CREATE TABLE qc_reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id              uuid NOT NULL REFERENCES qc_cycles(id),
  audience              text NOT NULL CHECK (audience IN ('senior_management','board','partner','fnma_on_request','regulator')),
  document_id           uuid REFERENCES documents(id),
  due_at                timestamptz,
  delivered_at          timestamptz,
  delivery_evidence     text
);
-- AI governance (18.1 + 19.3 merged inventory)
CREATE TABLE vendors (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id              uuid REFERENCES parties(id),
  name                  text NOT NULL,
  category              text NOT NULL CHECK (category IN ('cloud_infra','ai_model_provider','telephony_voice','print_mail','e_delivery','lockbox_ach','custodial_bank','tax_service','flood','insurance_tracking','mi','credit_bureau','e_oscar','attorney_network','preservation','valuation','skip_trace','records_storage','disposal','idp_security','qc_vendor','document_custodian','subservicer','other')),
  tier                  text NOT NULL CHECK (tier IN ('1_critical','2_significant','3_low')),
  critical_servicing_function boolean NOT NULL DEFAULT false,
  data_classes          text[] NOT NULL DEFAULT '{}',
  offshore              boolean NOT NULL DEFAULT false,
  subprocessors         jsonb NOT NULL DEFAULT '[]',
  ai_ml_used            boolean NOT NULL DEFAULT false,
  contract_id           uuid,
  soc2_report_document_id uuid REFERENCES documents(id),
  soc2_period_end       date,
  last_assessment_id    uuid,
  next_assessment_due   date,
  bcp_evidence_document_id uuid REFERENCES documents(id),
  incident_notice_sla_hours int,
  status                text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','due_diligence','approved','active','remediation','offboarding','terminated')),
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE TABLE ai_systems (
  code                  text PRIMARY KEY,
  name                  text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('agent','model','prompt_bundle','vendor_model','tool','deterministic_engine')),
  purpose               text NOT NULL,
  risk_tier             text NOT NULL CHECK (risk_tier IN ('T0_deterministic','T1_consequential','T2_borrower_facing','T3_internal')),
  owner_role            text NOT NULL,
  consumer_facing       boolean NOT NULL DEFAULT false,
  consequential_decision boolean NOT NULL DEFAULT false,
  consequential_decisions text[] NOT NULL DEFAULT '{}',
  human_touchpoints     text[] NOT NULL DEFAULT '{}',
  fnma_data_access      boolean NOT NULL DEFAULT false,
  vendor_id             uuid REFERENCES vendors(id),
  model_version         text,
  prompt_version        text,
  eval_suite_id         text,
  last_eval_at          timestamptz,
  monitoring_dashboard  text,
  impact_assessment_document_id uuid REFERENCES documents(id),
  deployed_at           timestamptz,
  retired_at            timestamptz,
  status                text NOT NULL DEFAULT 'inventoried'
);
CREATE TABLE ai_system_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_code           text NOT NULL REFERENCES ai_systems(code),
  version               text NOT NULL,
  model_id              text,
  prompt_hash           text,
  rule_set_versions     jsonb NOT NULL DEFAULT '{}',
  eval_run_id           uuid,
  approved_by           text,
  approved_at           timestamptz,
  change_kind           text NOT NULL CHECK (change_kind IN ('new','minor','major')),
  status                text NOT NULL DEFAULT 'evaluated' CHECK (status IN ('evaluated','deployed','rolled_back','retired')),
  UNIQUE (system_code, version)
);
CREATE TABLE ai_evaluations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id            uuid NOT NULL REFERENCES ai_system_versions(id),
  suite_code            text NOT NULL,
  dataset_hash          text NOT NULL,
  metrics               jsonb NOT NULL,
  pass                  boolean NOT NULL,
  run_at                timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ai_system_versions ADD CONSTRAINT ai_system_versions_eval_fk FOREIGN KEY (eval_run_id) REFERENCES ai_evaluations(id);
CREATE TABLE ai_monitoring_metrics (
  system_code           text NOT NULL REFERENCES ai_systems(code),
  day                   date NOT NULL,
  decision_volume       int NOT NULL DEFAULT 0,
  escalation_rate       numeric(6,4),
  override_rate         numeric(6,4),
  low_confidence_rate   numeric(6,4),
  complaint_rate_per_1000 numeric(8,4),
  latency_ms_p95        int,
  tool_error_rate       numeric(6,4),
  disclosure_given_rate numeric(6,4),
  ask_for_human_rate    numeric(6,4),
  fairness_stats        jsonb,
  kill_switch_triggered boolean NOT NULL DEFAULT false,
  PRIMARY KEY (system_code, day)
);
CREATE TABLE ai_policy_documents (
  code                  text NOT NULL,
  version               text NOT NULL,
  owner                 text NOT NULL,
  document_id           uuid REFERENCES documents(id),
  approved_at           timestamptz,
  next_review_due       date,
  PRIMARY KEY (code, version)
);
CREATE TABLE ai_disclosure_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester             text NOT NULL CHECK (requester IN ('fnma','partner','regulator','borrower')),
  received_at           timestamptz NOT NULL,
  due_at                timestamptz,
  package_document_id   uuid REFERENCES documents(id),
  signed_by             text,
  sent_at               timestamptz
);
CREATE TABLE ai_vendor_attestations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             uuid NOT NULL REFERENCES vendors(id),
  scope                 text,
  attestation_document_id uuid REFERENCES documents(id),
  equivalence_assessment jsonb,
  expires_at            date
);

-- 18.2 exams
CREATE TABLE exams (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_type             text NOT NULL,
  examiner              text NOT NULL,
  subject_entity        text NOT NULL CHECK (subject_entity IN ('partner','supermortgage','both')),
  notice_document_id    uuid REFERENCES documents(id),
  received_at           timestamptz NOT NULL,
  scope                 jsonb NOT NULL DEFAULT '{}',
  lead_officer_id       text,
  counsel_id            text,
  status                text NOT NULL DEFAULT 'open',
  closed_at             timestamptz,
  final_report_document_id uuid REFERENCES documents(id)
);
CREATE TABLE exam_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id               uuid NOT NULL REFERENCES exams(id),
  request_no            text NOT NULL,
  text                  text,
  taxonomy_nodes        text[] NOT NULL DEFAULT '{}',
  loan_ids              uuid[] NOT NULL DEFAULT '{}',
  due_at                timestamptz NOT NULL,
  internal_target_at    timestamptz,
  extension_requested_at timestamptz,
  extension_granted_until timestamptz,
  package_document_id   uuid REFERENCES documents(id),
  submitted_at          timestamptz,
  submission_evidence   text,
  status                text NOT NULL DEFAULT 'open',
  UNIQUE (exam_id, request_no)
);
CREATE TABLE evidence_taxonomy (
  node                  text PRIMARY KEY,
  parent                text REFERENCES evidence_taxonomy(node),
  description           text,
  sources               jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE evidence_index (
  loan_id               uuid NOT NULL REFERENCES loans(id),
  node                  text NOT NULL,
  ref_type              text NOT NULL,
  ref_id                uuid NOT NULL,
  occurred_at           timestamptz NOT NULL,
  document_hash         text,
  PRIMARY KEY (loan_id, node, ref_type, ref_id)
);
CREATE TABLE exam_findings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id               uuid NOT NULL REFERENCES exams(id),
  finding_ref           text NOT NULL,
  text                  text,
  severity              text,
  taxonomy_nodes        text[] NOT NULL DEFAULT '{}',
  response_document_id  uuid REFERENCES documents(id),
  qc_finding_case_id    uuid REFERENCES qc_findings(case_id),
  remediation_due_at    timestamptz,
  status                text NOT NULL DEFAULT 'open'
);
CREATE TABLE exam_productions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_request_id       uuid NOT NULL REFERENCES exam_requests(id),
  manifest              jsonb NOT NULL,
  privilege_log_document_id uuid REFERENCES documents(id),
  pii_redaction_applied boolean NOT NULL DEFAULT false,
  approved_by_officer_id text,
  approved_at           timestamptz
);

-- 18.3 STAR
CREATE TABLE star_metrics_config (
  program_year          smallint NOT NULL,
  metric_code           text NOT NULL,
  version               text NOT NULL,
  definition            jsonb NOT NULL,
  weight_by_peer_group  jsonb,
  source_citation       text,
  verified              boolean NOT NULL DEFAULT false,
  PRIMARY KEY (program_year, metric_code, version)
);
CREATE TABLE loan_delinquency_months (
  loan_id               uuid NOT NULL REFERENCES loans(id),
  as_of_month           char(7) NOT NULL,
  fnma_delinquency_status text,
  days_delinquent_fnma  int,
  workout_status        text,
  repayment_plan_active boolean NOT NULL DEFAULT false,
  forbearance_active    boolean NOT NULL DEFAULT false,
  fc_referred_at        date,
  fc_timeframe_days_allowed int,
  fc_days_elapsed       int,
  mtmltv_bps            int,
  transfer_in_month     char(7),
  transfer_out_month    char(7),
  disaster_flag         boolean NOT NULL DEFAULT false,
  PRIMARY KEY (loan_id, as_of_month)
);
CREATE TABLE star_metric_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_year          smallint NOT NULL,
  as_of_month           char(7) NOT NULL,
  view                  text NOT NULL CHECK (view IN ('master_partner','acting_supermortgage','internal_total')),
  metric_code           text NOT NULL,
  config_version        text NOT NULL,
  numerator             int NOT NULL,
  denominator           int NOT NULL,
  rate_bps              int,
  suppressed            boolean NOT NULL DEFAULT false,
  comp_rate_bps         int,
  computed_at           timestamptz NOT NULL DEFAULT now(),
  population_hash       text,
  UNIQUE (as_of_month, view, metric_code, config_version)
);
CREATE TABLE star_scorecards (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  view                  text NOT NULL,
  as_of_month           char(7) NOT NULL,
  document_id           uuid REFERENCES documents(id),
  metric_code           text NOT NULL,
  fnma_numerator        int,
  fnma_denominator      int,
  fnma_rate_bps         int,
  comp_rate_bps         int,
  rank                  int,
  peer_group            text,
  parsed_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE star_reconciliations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_month           char(7) NOT NULL,
  metric_code           text NOT NULL,
  internal_rate_bps     int,
  fnma_rate_bps         int,
  delta_bps             int,
  loan_level_diffs      jsonb,
  classification        text CHECK (classification IN ('reporting_timing','definition_mismatch','data_defect','fnma_error')),
  evidence_refs         text[] NOT NULL DEFAULT '{}',
  explanation           text,
  status                text NOT NULL DEFAULT 'open'
);

-- 18.4 filings and registries
CREATE TABLE regulatory_filings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity                text NOT NULL CHECK (entity IN ('partner','supermortgage')),
  filing_type           text NOT NULL CHECK (filing_type IN ('form_582','afs','form_1002','form_1002a','form_1001','isbr_attestation','form_183','capliq_plan','org_change_notice','tech_provider_notice','regab_1122','regab_1123','soc1')),
  period_end            date,
  due_at                date NOT NULL,
  package_document_id   uuid REFERENCES documents(id),
  data_snapshot         jsonb,
  prepared_by_agent_run_id uuid,
  approved_by_officer_id text,
  submitted_at          timestamptz,
  submission_evidence   text,
  confirmation_document_id uuid REFERENCES documents(id),
  status                text NOT NULL DEFAULT 'draft',
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE TABLE org_registry (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity                text NOT NULL,
  person_or_firm        text NOT NULL,
  role                  text NOT NULL,
  ownership_pct_bps     int,
  effective_from        date NOT NULL,
  effective_to          date,
  contact_enc           bytea
);
COMMENT ON COLUMN org_registry.contact_enc IS 'pii';
CREATE TABLE vendor_registry (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity                text NOT NULL,
  vendor_id             uuid REFERENCES vendors(id),
  vendor_name           text NOT NULL,
  vendor_type           text NOT NULL CHECK (vendor_type IN ('qc_vendor','document_custodian','technology_provider','subservicer','outsourcer','law_firm_network','ai_vendor','print_mail','other')),
  critical_function     boolean NOT NULL DEFAULT false,
  contract_document_id  uuid REFERENCES documents(id),
  fnma_clauses_present  boolean,
  starts_on             date,
  ends_on               date
);
CREATE TABLE corporate_insurance_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity                text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('fidelity','eo','cyber','other')),
  carrier               text NOT NULL,
  coverage_cents        bigint NOT NULL,
  deductible_cents      bigint NOT NULL DEFAULT 0,
  effective_on          date NOT NULL,
  expires_on            date NOT NULL,
  fnma_loss_payee       boolean NOT NULL DEFAULT false,
  document_id           uuid REFERENCES documents(id)
);
CREATE TABLE subservicing_arrangements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_entity         text NOT NULL,
  sub_entity            text NOT NULL,
  fnma_servicer_numbers text[] NOT NULL DEFAULT '{}',
  loan_count            int,
  upb_cents             bigint,
  form_101_document_id  uuid REFERENCES documents(id),
  form_629_ref          text,
  status                text NOT NULL DEFAULT 'active'
);
CREATE TABLE pending_actions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity                text NOT NULL,
  event_kind            text NOT NULL,
  occurred_at           date NOT NULL,
  fnma_due_at           date NOT NULL,
  partner_due_at        date,
  form582_updated_at    timestamptz,
  email_sent_at         timestamptz,
  document_id           uuid REFERENCES documents(id)
);
CREATE TABLE fiscal_years (
  entity                text NOT NULL,
  fye_date              date NOT NULL,
  auditor               text,
  afs_expected_at       date,
  PRIMARY KEY (entity, fye_date)
);

-- 18.5 fraud
CREATE TABLE fraud_red_flags (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid REFERENCES loans(id),
  party_id              uuid REFERENCES parties(id),
  vendor_id             uuid REFERENCES vendors(id),
  employee_ref          text,
  flag_code             text NOT NULL,
  source_event_id       uuid,
  score                 smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  detected_at           timestamptz NOT NULL DEFAULT now(),
  detector              text NOT NULL,
  case_id               uuid REFERENCES cases(id)
);
CREATE TRIGGER fraud_red_flags_immutable BEFORE UPDATE OR DELETE ON fraud_red_flags FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE fraud_cases (
  case_id               uuid PRIMARY KEY REFERENCES cases(id),
  subject_kind          text NOT NULL CHECK (subject_kind IN ('borrower','third_party','employee','vendor','law_firm','unknown')),
  subject_refs          text[] NOT NULL DEFAULT '{}',
  scheme_code           text,
  loans                 uuid[] NOT NULL DEFAULT '{}',
  score                 smallint,
  priority              text CHECK (priority IN ('P1','P2','P3')),
  flagged_at            timestamptz NOT NULL,
  diligence_due_at      date,
  exposure_cents        bigint NOT NULL DEFAULT 0,
  partner_notified_at   timestamptz,
  determination         text CHECK (determination IN ('reasonable_basis','unfounded','inconclusive')),
  determination_at      timestamptz,
  determined_by_officer_id text,
  fnma_report_due_at    date,
  fnma_report_filed_at  timestamptz,
  fnma_report_ref       text,
  ofac_reported_at      timestamptz,
  law_enforcement_referral_at timestamptz,
  carrier_claim_at      timestamptz,
  regulator_report_at   timestamptz,
  protective_holds      jsonb NOT NULL DEFAULT '[]',
  status                text NOT NULL DEFAULT 'open'
);
CREATE TABLE fraud_reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES fraud_cases(case_id),
  channel               text NOT NULL CHECK (channel IN ('lqc_self_report','ethics_email_ofac','fraud_tip_form','fraud_hotline','fnma_legal_email','law_enforcement','state_regulator','carrier')),
  package_document_id   uuid REFERENCES documents(id),
  signed_by_officer_id  text,
  due_at                timestamptz,
  sent_at               timestamptz,
  evidence              jsonb
);
CREATE TABLE screening_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind          text NOT NULL,
  subject_ref           text NOT NULL,
  list                  text NOT NULL,
  match_score           numeric(5,2),
  disposition           text,
  screened_at           timestamptz NOT NULL DEFAULT now(),
  reviewed_by           text
);

-- 18.6 Reg AB
CREATE TABLE investor_programs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investor              text NOT NULL,
  program_kind          text NOT NULL CHECK (program_kind IN ('fnma_mbs','fnma_portfolio','private_abs_registered','private_whole_loan','other')),
  regab_applicable      boolean NOT NULL,
  usap_requested        boolean NOT NULL DEFAULT false,
  psa_deliverable_due   jsonb,
  criteria_applicable   text[] NOT NULL DEFAULT '{}',
  partner_entity        text
);
CREATE TABLE control_matrix (
  criterion             text NOT NULL,
  control_code          text NOT NULL,
  description           text NOT NULL,
  owner_agent           text,
  evidence_query        text,
  qc_rule_codes         text[] NOT NULL DEFAULT '{}',
  frequency             text,
  key                   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (criterion, control_code)
);
CREATE TABLE control_evidence (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_code          text NOT NULL,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  qc_results_summary    jsonb,
  exceptions_count      int NOT NULL DEFAULT 0,
  generated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER control_evidence_immutable BEFORE UPDATE OR DELETE ON control_evidence FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE attestation_packages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity                text NOT NULL,
  fiscal_year           smallint NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('regab_1122_assessment','regab_1123_statement','soc1_type2','usap')),
  criteria_scope        text[] NOT NULL DEFAULT '{}',
  material_noncompliance jsonb NOT NULL DEFAULT '[]',
  exceptions            jsonb NOT NULL DEFAULT '[]',
  management_assertion_document_id uuid REFERENCES documents(id),
  signed_by_officer_id  text,
  auditor_report_document_id uuid REFERENCES documents(id),
  delivered_to          text,
  delivered_at          timestamptz,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','evidence_complete','assertion_signed','auditor_engaged','delivered','closed'))
);

-- 18.7 eligibility
CREATE TABLE eligibility_config (
  version               text PRIMARY KEY,
  effective_from        date NOT NULL,
  base_net_worth_cents  bigint NOT NULL DEFAULT 250000000,
  ratio_bps             int NOT NULL DEFAULT 600,
  large_servicer_threshold_cents bigint NOT NULL DEFAULT 5000000000000,
  bps_rates             jsonb NOT NULL,
  buffers               jsonb NOT NULL DEFAULT '{}',
  decline_triggers      jsonb NOT NULL DEFAULT '{}',
  liquidity_haircuts    jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE gl_snapshots (
  entity                text NOT NULL,
  period_end            date NOT NULL,
  total_equity_cents    bigint NOT NULL,
  goodwill_intangibles_cents bigint NOT NULL DEFAULT 0,
  affiliate_receivables_cents bigint NOT NULL DEFAULT 0,
  pledged_assets_net_cents bigint NOT NULL DEFAULT 0,
  total_assets_cents    bigint NOT NULL,
  net_income_qtd_cents  bigint,
  cash_unrestricted_cents bigint NOT NULL DEFAULT 0,
  eligible_securities_cents bigint NOT NULL DEFAULT 0,
  advance_line_committed_cents bigint NOT NULL DEFAULT 0,
  advance_line_drawn_cents bigint NOT NULL DEFAULT 0,
  source_document_ids   uuid[] NOT NULL DEFAULT '{}',
  certified_by          text,
  closed_by_bd5         boolean,
  PRIMARY KEY (entity, period_end)
);
CREATE TABLE upb_positions (
  entity                text NOT NULL,
  period_end            date NOT NULL,
  class                 text NOT NULL CHECK (class IN ('ent_ss_sa','ent_aa','gnma','other','subserviced_for_others','hfs_and_irlc')),
  upb_cents             bigint NOT NULL,
  loan_count            int NOT NULL DEFAULT 0,
  source                text,
  PRIMARY KEY (entity, period_end, class)
);
CREATE TABLE eligibility_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity                text NOT NULL,
  period_end            date NOT NULL,
  config_version        text NOT NULL REFERENCES eligibility_config(version),
  anw_cents             bigint NOT NULL,
  required_nw_cents     bigint NOT NULL,
  nw_surplus_cents      bigint NOT NULL,
  ratio_bps             int NOT NULL,
  allowable_liquidity_cents bigint NOT NULL,
  required_liquidity_cents bigint NOT NULL,
  liquidity_surplus_cents bigint NOT NULL,
  large_servicer        boolean NOT NULL DEFAULT false,
  buffer_required_cents bigint NOT NULL DEFAULT 0,
  decline_flags         jsonb NOT NULL DEFAULT '{}',
  status                text NOT NULL CHECK (status IN ('compliant','warning','breach','stale')),
  computed_at           timestamptz NOT NULL DEFAULT now(),
  certified_by_officer_id text,
  UNIQUE (entity, period_end, config_version)
);

COMMIT;
