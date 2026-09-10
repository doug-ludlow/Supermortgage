-- 0022_data_security.sql — Section 19 (19.1–19.4): retention registry, holds, disposal, records requests; security controls/assets/identities/incidents; counterparty contracts/vendors/tech-provider changes/Form 101; restricted fair-lending schema.
BEGIN;

-- 19.1 records retention
CREATE TABLE retention_classes (
  code                  text NOT NULL,
  version               text NOT NULL,
  name                  text NOT NULL,
  citation              text,
  basis                 text NOT NULL CHECK (basis IN ('law','guide','contract','policy')),
  anchor_event          text NOT NULL,
  anchor_rule           text NOT NULL CHECK (anchor_rule IN ('later_of_liquidation_or_transfer_out','discharge_or_transfer_out','record_created','last_collection_activity','call_date','decision_notified','form_due_date','report_filed','last_use','revocation_or_last_reliance')),
  offset_value          int NOT NULL,
  offset_unit           text NOT NULL CHECK (offset_unit IN ('days','months','years')),
  permanent_while_active boolean NOT NULL DEFAULT false,
  jurisdiction_overrides jsonb NOT NULL DEFAULT '{}',
  disposal_method       text NOT NULL DEFAULT 'crypto_shred' CHECK (disposal_method IN ('crypto_shred','object_delete','physical_destroy','none')),
  may_shorten           boolean NOT NULL DEFAULT false,
  effective_from        date NOT NULL,
  effective_to          date,
  PRIMARY KEY (code, version)
);
CREATE TABLE record_types (
  code                  text PRIMARY KEY,
  description           text,
  system_of_record      text NOT NULL,
  servicing_file_category text NOT NULL DEFAULT 'none' CHECK (servicing_file_category IN ('i_transactions','ii_security_instrument','iii_personnel_notes','iv_data_fields','v_borrower_submitted','none')),
  retention_class_codes text[] NOT NULL,
  pii_level             text NOT NULL DEFAULT 'none' CHECK (pii_level IN ('none','low','high','restricted')),
  fnma_property         boolean NOT NULL DEFAULT true,
  ny_419_9_scope        boolean NOT NULL DEFAULT false
);
CREATE TABLE record_objects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type           text NOT NULL REFERENCES record_types(code),
  object_ref            text NOT NULL,
  loan_id               uuid REFERENCES loans(id),
  borrower_id           uuid REFERENCES borrowers(id),
  case_id               uuid REFERENCES cases(id),
  state                 char(2),
  anchor_at             date,
  effective_class_code  text,
  eligible_for_disposal_at date,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retention_running','eligible','held','disposed')),
  hold_count            int NOT NULL DEFAULT 0,
  sha256                text,
  worm_location         text,
  disposed_at           timestamptz,
  disposal_run_id       uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX record_objects_loan_idx ON record_objects(loan_id);
CREATE TABLE legal_holds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                 text NOT NULL CHECK (scope IN ('loan','borrower','case','portfolio_batch','record_type','vendor','global')),
  scope_ref             text,
  reason                text NOT NULL CHECK (reason IN ('litigation','litigation_anticipated','subpoena','regulator_exam','fannie_mae_request','mora','complaint_escalated','internal_investigation','audit','incident')),
  matter_ref            text,
  placed_by             text NOT NULL,
  placed_at             timestamptz NOT NULL DEFAULT now(),
  released_by           text,
  released_at           timestamptz,
  release_approvals     jsonb NOT NULL DEFAULT '{}',
  next_review_at        date
);
CREATE OR REPLACE FUNCTION legal_hold_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.released_at IS NOT NULL AND OLD.released_at IS NULL THEN
    IF NOT (NEW.release_approvals ? 'officer' AND NEW.release_approvals ? 'attorney') THEN
      RAISE EXCEPTION 'legal hold release requires officer and attorney approvals';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legal_hold_release_guard BEFORE UPDATE ON legal_holds FOR EACH ROW EXECUTE FUNCTION legal_hold_release_guard();
CREATE TABLE legal_hold_objects (
  hold_id               uuid NOT NULL REFERENCES legal_holds(id),
  record_object_id      uuid NOT NULL REFERENCES record_objects(id),
  PRIMARY KEY (hold_id, record_object_id)
);
CREATE TABLE disposal_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at                timestamptz NOT NULL,
  class_code            text NOT NULL,
  object_count          int NOT NULL DEFAULT 0,
  method                text NOT NULL,
  manifest_document_id  uuid REFERENCES documents(id),
  vendor_certificate_document_id uuid REFERENCES documents(id),
  attested_by           text,
  attested_at           timestamptz,
  status                text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','awaiting_attestation','executed','failed')),
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
ALTER TABLE record_objects ADD CONSTRAINT record_objects_disposal_run_fk FOREIGN KEY (disposal_run_id) REFERENCES disposal_runs(id);
CREATE OR REPLACE FUNCTION record_objects_disposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'disposed' AND OLD.status <> 'disposed' THEN
    IF OLD.hold_count > 0 THEN RAISE EXCEPTION 'record_objects: legal hold active'; END IF;
    IF OLD.status = 'active' THEN RAISE EXCEPTION 'record_objects: permanent_while_active'; END IF;
    IF OLD.eligible_for_disposal_at IS NULL OR OLD.eligible_for_disposal_at > current_date THEN RAISE EXCEPTION 'record_objects: not yet eligible'; END IF;
    IF NEW.disposal_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM disposal_runs r WHERE r.id = NEW.disposal_run_id AND r.attested_by IS NOT NULL) THEN RAISE EXCEPTION 'record_objects: officer attestation required'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER record_objects_disposal_guard BEFORE UPDATE ON record_objects FOR EACH ROW EXECUTE FUNCTION record_objects_disposal_guard();
CREATE TRIGGER record_objects_no_delete BEFORE DELETE ON record_objects FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE records_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_type        text NOT NULL CHECK (requester_type IN ('fannie_mae','partner','regulator_state','regulator_federal','transferee_servicer','court_subpoena','mi_company','custodian','auditor','law_enforcement')),
  requester_ref         text,
  received_at           timestamptz NOT NULL,
  channel               text,
  due_at                timestamptz,
  scope                 jsonb NOT NULL DEFAULT '{}',
  format                text NOT NULL CHECK (format IN ('servicing_file_1024_38c2','full_loan_file','portfolio_export_mismo','ny_419_9_call_log','custom')),
  status                text NOT NULL DEFAULT 'received',
  production_manifest_document_id uuid REFERENCES documents(id),
  delivered_via         text,
  delivery_evidence_document_id uuid REFERENCES documents(id),
  redaction_log         jsonb,
  certification_document_id uuid REFERENCES documents(id),
  hold_id               uuid REFERENCES legal_holds(id),
  attorney_approved_at  timestamptz
);
CREATE TABLE servicing_file_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  compiled_at           timestamptz NOT NULL DEFAULT now(),
  compile_ms            int NOT NULL,
  bundle_document_id    uuid REFERENCES documents(id),
  sha256                text NOT NULL,
  sections              jsonb NOT NULL,
  requested_by          text
);
ALTER TABLE records_inventory
  ADD COLUMN IF NOT EXISTS storage_tier text CHECK (storage_tier IN ('hot_db','object_store','worm_archive','paper_offsite','custodian','vendor_hosted')),
  ADD COLUMN IF NOT EXISTS encryption_scope text,
  ADD COLUMN IF NOT EXISTS restore_sla_hours int,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

-- 19.2 security
CREATE TABLE security_controls (
  code                  text PRIMARY KEY,
  name                  text NOT NULL,
  objective             text,
  frameworks            jsonb NOT NULL DEFAULT '{}',
  owner_role            text NOT NULL,
  test_frequency        text,
  automated             boolean NOT NULL DEFAULT false,
  evidence_spec         text,
  status                text NOT NULL DEFAULT 'active'
);
CREATE TABLE control_tests (
  control_code          text NOT NULL REFERENCES security_controls(code),
  job_name              text NOT NULL,
  schedule              text,
  pass_criteria         jsonb NOT NULL DEFAULT '{}',
  version               text NOT NULL,
  PRIMARY KEY (control_code, job_name, version)
);
CREATE TABLE control_exceptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_code          text NOT NULL REFERENCES security_controls(code),
  scope                 text,
  justification         text NOT NULL,
  compensating_controls text,
  approved_by           text NOT NULL,
  approved_at           timestamptz NOT NULL DEFAULT now(),
  expires_at            date NOT NULL,
  review_due_at         date,
  CHECK (expires_at <= approved_at::date + 366)
);
CREATE TABLE control_test_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_code          text NOT NULL REFERENCES security_controls(code),
  ran_at                timestamptz NOT NULL DEFAULT now(),
  result                text NOT NULL CHECK (result IN ('pass','fail','exception')),
  metrics               jsonb,
  evidence_document_id  uuid REFERENCES documents(id),
  exception_id          uuid REFERENCES control_exceptions(id)
);
CREATE TRIGGER control_test_results_immutable BEFORE UPDATE OR DELETE ON control_test_results FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE assets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('service','database','bucket','queue','host','endpoint','saas','network','facility','key')),
  name                  text NOT NULL,
  owner                 text,
  location              text,
  classification        text NOT NULL CHECK (classification IN ('restricted','confidential','internal','public')),
  data_classes          text[] NOT NULL DEFAULT '{}',
  support_expiration    date,
  rto_hours             int,
  rpo_minutes           int,
  tier                  smallint CHECK (tier BETWEEN 0 AND 3),
  last_validated_at     timestamptz
);
CREATE TABLE identities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject               text NOT NULL UNIQUE,
  kind                  text NOT NULL CHECK (kind IN ('human','system','fnma_system_id','vendor')),
  privileged            boolean NOT NULL DEFAULT false,
  mfa_method            text,
  last_credential_reset_at timestamptz,
  entitlements          jsonb NOT NULL DEFAULT '{}',
  last_certified_at     timestamptz,
  certified_by          text,
  disabled_at           timestamptz
);
CREATE TABLE access_reviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                 text NOT NULL CHECK (scope IN ('all','privileged','fl_restricted','fnma_credentials')),
  period                text NOT NULL,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  reviewer              text,
  changes               jsonb
);
CREATE TABLE vulnerabilities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id              uuid REFERENCES assets(id),
  source                text,
  cve                   text,
  severity              text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  internet_facing       boolean NOT NULL DEFAULT false,
  detected_at           timestamptz NOT NULL,
  sla_due_at            timestamptz NOT NULL,
  remediated_at         timestamptz,
  exception_id          uuid REFERENCES control_exceptions(id)
);
CREATE TABLE security_program_records (                            -- pen_tests / independent_assessments / risk_assessments / board_reports / bcp_exercises / backup_restore_tests / training_completions / background_checks
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('pen_test','independent_assessment','risk_assessment','board_report','bcp_exercise','backup_restore_test','training_completion','background_check')),
  period                text,
  performer             text,
  document_id           uuid REFERENCES documents(id),
  findings              jsonb,
  remediation_plan      jsonb,
  result                text,
  completed_at          timestamptz,
  due_at                date
);
CREATE TABLE security_incidents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_at             timestamptz NOT NULL DEFAULT now(),
  identified_at         timestamptz,
  determined_at         timestamptz,
  discovered_at         date,
  severity              text NOT NULL CHECK (severity IN ('S1','S2','S3','S4')),
  category              text NOT NULL CHECK (category IN ('ransomware','ddos','bec','credential_compromise','data_exfiltration','lost_media','vendor_incident','insider','misdirected_disclosure','availability','vulnerability_exploited','other')),
  fnma_confidential_involved boolean NOT NULL DEFAULT false,
  fnma_systems_involved boolean NOT NULL DEFAULT false,
  unencrypted_customer_info_acquired text CHECK (unencrypted_customer_info_acquired IN ('yes','presumed','no_reliable_evidence','no')),
  consumer_count        int NOT NULL DEFAULT 0,
  residents_by_state    jsonb NOT NULL DEFAULT '{}',
  ny_residents          int NOT NULL DEFAULT 0,
  material_ops_harm     boolean NOT NULL DEFAULT false,
  ransomware_deployed   boolean NOT NULL DEFAULT false,
  extortion_payment     jsonb,
  law_enforcement_delay jsonb,
  vendor_id             uuid REFERENCES vendors(id),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','contained','eradicated','recovered','closed')),
  root_cause            text,
  lessons_learned_document_id uuid REFERENCES documents(id),
  independent_assessment_id uuid REFERENCES security_program_records(id),
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE TABLE incident_notices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id           uuid NOT NULL REFERENCES security_incidents(id),
  recipient             text NOT NULL,
  due_at                timestamptz NOT NULL,
  timer_id              uuid REFERENCES timers(id),
  drafted_document_id   uuid REFERENCES documents(id),
  sent_at               timestamptz,
  sent_by               text,
  channel               text,
  evidence_document_id  uuid REFERENCES documents(id),
  acknowledgement       text
);
CREATE TABLE incident_affected_persons (
  incident_id           uuid NOT NULL REFERENCES security_incidents(id),
  borrower_id           uuid NOT NULL REFERENCES borrowers(id),
  state                 char(2),
  encrypted_data        boolean NOT NULL DEFAULT false,
  notice_id             uuid REFERENCES notices(id),
  PRIMARY KEY (incident_id, borrower_id)
);
ALTER TABLE jurisdiction_rules ADD COLUMN IF NOT EXISTS breach_notice jsonb;
CREATE TABLE vendor_incidents (
  vendor_id             uuid NOT NULL REFERENCES vendors(id),
  security_incident_id  uuid NOT NULL REFERENCES security_incidents(id),
  reported_at           timestamptz NOT NULL,
  sla_met               boolean,
  PRIMARY KEY (vendor_id, security_incident_id)
);

-- 19.3 counterparties
CREATE TABLE counterparty_contracts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id       uuid REFERENCES parties(id),
  vendor_id             uuid REFERENCES vendors(id),
  kind                  text NOT NULL CHECK (kind IN ('subservicing_agreement','tech_provider_addendum','form_101','integration_agreement','ssa','vendor_msa','dpa','sla','custodial_agreement')),
  executed_at           date,
  effective_from        date,
  expires_at            date,
  termination_notice_days int,
  document_id           uuid REFERENCES documents(id),
  status                text NOT NULL DEFAULT 'draft',
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
ALTER TABLE vendors ADD CONSTRAINT vendors_contract_fk FOREIGN KEY (contract_id) REFERENCES counterparty_contracts(id);
CREATE TABLE contract_clauses (
  contract_id           uuid NOT NULL REFERENCES counterparty_contracts(id),
  clause_code           text NOT NULL,
  citation              text,
  status                text NOT NULL CHECK (status IN ('present','deviation','missing','n_a')),
  evidence_excerpt      text,
  reviewed_by           text,
  reviewed_at           timestamptz,
  officer_approved_at   timestamptz,
  PRIMARY KEY (contract_id, clause_code)
);
CREATE TABLE contract_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id           uuid NOT NULL REFERENCES counterparty_contracts(id),
  kind                  text NOT NULL,
  direction             text CHECK (direction IN ('sent','received')),
  occurred_at           timestamptz NOT NULL,
  received_at           timestamptz,
  document_id           uuid REFERENCES documents(id),
  fnma_notice_required  boolean NOT NULL DEFAULT false,
  fnma_notice_id        uuid,
  partner_notice_id     uuid REFERENCES notices(id)
);
CREATE TRIGGER contract_events_immutable BEFORE UPDATE OR DELETE ON contract_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE tech_provider_changes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity                text NOT NULL CHECK (entity IN ('partner','supermortgage')),
  provider_from         text,
  provider_to           text,
  critical_functions    text[] NOT NULL DEFAULT '{}',
  intent_declared_at    date,
  notice_sent_at        date,
  earliest_cutover_at   date,
  planned_cutover_at    date,
  transition_plan_document_id uuid REFERENCES documents(id),
  plan_requested_at     date,
  plan_delivered_at     date,
  fnma_ack_document_id  uuid REFERENCES documents(id),
  status                text NOT NULL DEFAULT 'declared'
);
CREATE TABLE portfolio_threshold_snapshots (
  entity                text NOT NULL,
  as_of                 date NOT NULL,
  loan_count            int NOT NULL,
  calendar_year         smallint NOT NULL,
  year_max              int NOT NULL,
  a2101_regime_active   boolean NOT NULL,
  PRIMARY KEY (entity, as_of)
);
CREATE TABLE vendor_assessments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             uuid NOT NULL REFERENCES vendors(id),
  kind                  text NOT NULL CHECK (kind IN ('onboarding','annual','biennial','post_incident','triggered')),
  questionnaire         jsonb,
  findings              jsonb,
  risk_rating           text,
  approved_by           text,
  completed_at          timestamptz
);
ALTER TABLE vendors ADD CONSTRAINT vendors_last_assessment_fk FOREIGN KEY (last_assessment_id) REFERENCES vendor_assessments(id);
CREATE TABLE data_access_authorizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_subscriber     text NOT NULL,
  subordinate_subscriber text NOT NULL,
  applications          text[] NOT NULL DEFAULT '{}',
  servicer_numbers      text[] NOT NULL DEFAULT '{}',
  executed_at           date,
  submitted_at          timestamptz,
  fnma_ack_at           timestamptz,
  terminated_at         date,
  termination_submitted_at timestamptz,
  document_id           uuid REFERENCES documents(id),
  retention             retention_class NOT NULL DEFAULT 'fnma_reporting_7y'
);
CREATE TABLE fnma_notices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('a2101_change_180','a2101_event_5bd','a2101_copies_5bd','transition_plan','ll2026_04_disclosure','supplement_attestation','form101','form101_termination','data_return_cert','other')),
  entity                text NOT NULL,
  due_at                timestamptz,
  sent_at               timestamptz,
  sent_by               text,
  channel               text,
  document_id           uuid REFERENCES documents(id),
  acknowledgement_document_id uuid REFERENCES documents(id),
  timer_id              uuid REFERENCES timers(id),
  retention             retention_class NOT NULL DEFAULT 'fnma_reporting_7y'
);
CREATE TRIGGER fnma_notices_immutable BEFORE DELETE ON fnma_notices FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE contract_events ADD CONSTRAINT contract_events_fnma_notice_fk FOREIGN KEY (fnma_notice_id) REFERENCES fnma_notices(id);
CREATE TABLE fnma_information_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL,
  received_at           timestamptz NOT NULL,
  due_at                timestamptz NOT NULL,
  responded_at          timestamptz,
  document_ids          uuid[] NOT NULL DEFAULT '{}'
);

-- 19.4 restricted fair-lending schema
CREATE SCHEMA IF NOT EXISTS restricted_fl;
CREATE TABLE restricted_fl.fair_lending_data (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES public.loans(id),
  borrower_seq          smallint NOT NULL,
  note_date             date NOT NULL,
  in_scope              boolean NOT NULL,
  source                text NOT NULL CHECK (source IN ('urla_1003','scif_1103','transferor_tape','prior_servicer_file','hmda_lar','not_obtained')),
  ethnicity_codes       smallint[] NOT NULL DEFAULT '{}',
  ethnicity_other_text_enc bytea,
  race_codes            smallint[] NOT NULL DEFAULT '{}',
  race_other_text_enc   bytea,
  sex_code              smallint,
  age_at_application    smallint,
  age_basis             text CHECK (age_basis IN ('dob','stated','unknown')),
  preferred_language    text CHECK (preferred_language IN ('english','chinese','korean','spanish','tagalog','vietnamese','other','not_provided','not_obtained')),
  preferred_language_other_enc bytea,
  collected_by_observation boolean,
  collected_at          date,
  version               int NOT NULL DEFAULT 1,
  updated_reason        text NOT NULL DEFAULT 'initial' CHECK (updated_reason IN ('initial','correction','assumption','ownership_transfer')),
  updated_by            text NOT NULL,
  data_quality          jsonb,
  evidence_document_id  uuid REFERENCES public.documents(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, borrower_seq, version)
);
CREATE TRIGGER fair_lending_data_immutable BEFORE UPDATE OR DELETE ON restricted_fl.fair_lending_data FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
CREATE TABLE restricted_fl.fl_access_log (
  id                    bigserial PRIMARY KEY,
  at                    timestamptz NOT NULL DEFAULT now(),
  principal             text NOT NULL,
  role                  text NOT NULL,
  purpose_code          text NOT NULL CHECK (purpose_code IN ('boarding_load','data_quality','fnma_query','regulator_query','transfer_out_export','monitoring_run','bias_test','audit','access_review')),
  request_id            text,
  query_hash            text,
  row_count             int,
  approved_by           text
);
CREATE TRIGGER fl_access_log_immutable BEFORE UPDATE OR DELETE ON restricted_fl.fl_access_log FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();
CREATE TABLE restricted_fl.fl_queries (
  code                  text NOT NULL,
  version               text NOT NULL,
  description           text,
  sql_template          text NOT NULL,
  output_columns        text[] NOT NULL DEFAULT '{}',
  aggregate_only        boolean NOT NULL DEFAULT false,
  approved_by           text,
  PRIMARY KEY (code, version)
);
-- DB-level use restriction: only fl_analytics may touch the restricted schema (19.4 rule 3)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fl_analytics') THEN CREATE ROLE fl_analytics NOLOGIN; END IF;
END $$;
REVOKE ALL ON SCHEMA restricted_fl FROM PUBLIC;
GRANT USAGE ON SCHEMA restricted_fl TO fl_analytics;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA restricted_fl TO fl_analytics;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA restricted_fl TO fl_analytics;
ALTER TABLE public.borrowers ADD COLUMN IF NOT EXISTS preferred_language_source text CHECK (preferred_language_source IN ('scif','borrower_stated','agent_detected_confirmed'));
CREATE TABLE fair_servicing_metric_defs (
  code                  text PRIMARY KEY,
  outcome_event         text NOT NULL,
  population_rule       text NOT NULL,
  legitimate_controls   text[] NOT NULL DEFAULT '{}',
  test_method           text NOT NULL CHECK (test_method IN ('two_proportion_z','fisher_exact','logistic_regression','t_test','mann_whitney')),
  thresholds            jsonb NOT NULL DEFAULT '{}',
  owner                 text
);
CREATE TABLE fair_servicing_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  method_version        text NOT NULL,
  population_counts     jsonb,
  dataset_hash          text,
  ran_at                timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'complete',
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE TABLE fair_servicing_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES fair_servicing_runs(id),
  metric_code           text NOT NULL REFERENCES fair_servicing_metric_defs(code),
  dimension             text NOT NULL CHECK (dimension IN ('ethnicity','race','sex','age_62_plus','language_non_english')),
  "group"               text NOT NULL,
  comparison_group      text NOT NULL,
  n_group               int NOT NULL,
  n_comparison          int NOT NULL,
  rate_group            numeric(8,6),
  rate_comparison       numeric(8,6),
  air                   numeric(8,4),
  diff                  numeric(8,6),
  z                     numeric(8,4),
  p_value               numeric(10,8),
  adjusted_effect       jsonb,
  flag                  text NOT NULL CHECK (flag IN ('none','screen','significant','material','suppressed')),
  notes                 text
);
CREATE TABLE fair_servicing_reviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id             uuid NOT NULL REFERENCES fair_servicing_results(id),
  opened_at             timestamptz NOT NULL DEFAULT now(),
  due_at                date NOT NULL,
  reviewer              text,
  root_cause            text,
  legitimate_justification text,
  corrective_actions    jsonb,
  status                text NOT NULL DEFAULT 'open',
  closed_at             timestamptz,
  privilege_marker      boolean NOT NULL DEFAULT true
);
CREATE TABLE ai_bias_tests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_system_code        text NOT NULL REFERENCES ai_systems(code),
  model_version         text,
  prompt_version        text,
  test_kind             text NOT NULL CHECK (test_kind IN ('attribute_leakage','counterfactual_perturbation','outcome_parity','explanation_consistency')),
  dataset_id            text,
  metrics               jsonb NOT NULL DEFAULT '{}',
  pass                  boolean NOT NULL,
  ran_at                timestamptz NOT NULL DEFAULT now(),
  reviewed_by           text,
  retention             retention_class NOT NULL DEFAULT 'ai_governance_7y'
);
CREATE TABLE impact_assessments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_system_code        text NOT NULL REFERENCES ai_systems(code),
  kind                  text NOT NULL CHECK (kind IN ('annual','modification')),
  document_id           uuid REFERENCES documents(id),
  completed_at          timestamptz,
  next_due_at           date NOT NULL,
  retention             retention_class NOT NULL DEFAULT 'ai_governance_7y'
);

COMMIT;
