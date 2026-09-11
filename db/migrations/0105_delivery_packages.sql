-- 0105: 29.3 Delivery data preparation and pre-delivery validation — the baseline `deliveries` aggregate (addendum §3:
-- `uldd_file_id`, `earlycheck_runs`, `loan_delivery_status`, `certification_status`, `purchase_date`,
-- `purchase_advice_id`; 29.3 owns the build columns, 29.4 the status columns, 25.2 sets `ucd_casefile_id`, 24.2 supplies
-- the Doc File ID) and 29.3's children: `uldd_data_points` (provenance per Sort ID per build), `sfc_assignments`,
-- `earlycheck_runs` (the addendum's `deliveries.earlycheck_runs` stays the jsonb summary), `delivery_edits` (29.4 also
-- writes `source = loan_delivery`) and `delivery_packages` (frozen, hashed; immutable after `frozen_at` — a data change
-- is a new version). Hashes are SHA-256 over the exact bytes handed to EarlyCheck / the operator. Every 29.3 build is
-- an `agent_decisions` row (LL-2026-04). No ledger activity (27.2 posts at purchase); no consumer artifact.
BEGIN;

CREATE TABLE deliveries (
  delivery_id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                       uuid NOT NULL REFERENCES loans(id),
  application_id                uuid NOT NULL REFERENCES applications(id),
  partner_id                    text NOT NULL,
  commitment_id                 uuid REFERENCES commitments(commitment_id),          -- 29.1: the delivery target
  execution_type                text NOT NULL CHECK (execution_type IN ('whole_loan_best_efforts', 'whole_loan_mandatory')),
  remittance_type               text NOT NULL DEFAULT 'actual_actual' CHECK (remittance_type IN ('actual_actual', 'scheduled_actual', 'scheduled_scheduled')),
  pass_through_rate             numeric(7,5),
  servicing_fee_rate            numeric(7,5),
  -- 29.3 build columns
  build_status                  text NOT NULL DEFAULT 'pending_prerequisites' CHECK (build_status IN ('pending_prerequisites', 'assembling', 'du_file_checked', 'uldd_built', 'earlycheck_pending', 'earlycheck_clean', 'earlycheck_failed', 'frozen', 'superseded', 'withdrawn')),
  uldd_phase                    text NOT NULL DEFAULT '5.2.0',
  uldd_file_id                  uuid REFERENCES documents(id),                       -- addendum name; = the frozen XML (`uldd_document_id`)
  uldd_document_id              uuid REFERENCES documents(id),                       -- retention fnma_loan_file_life_plus_4y; Fannie Mae-confidential
  uldd_sha256                   bytea,
  uldd_built_at                 timestamptz,
  uldd_build_no                 int NOT NULL DEFAULT 0,
  loan_state_at_current_date    date,                                                -- ULDD "At Current" snapshot date (FAQ Q37) = the build date
  closed_loan_snapshot_hash     bytea,                                               -- must equal du_submissions.closed_loan_snapshot_hash (R1)
  identifier_snapshot           jsonb,                                               -- {du_casefile_id, ucd_casefile_id, ucdp_doc_file_id, property_data_id, cpm_project_id, cpm_certification_id, cpm_phase_id, mi_certificate_number, mi_company_code, commitment_id_fnma, payee_code, warehouse_lender_id, custodian_fin, mers_min, uli, lender_loan_id, income_calculator_ids[], du_validation_report_ids[]}
  sfc_codes                     text[] NOT NULL DEFAULT '{}',                        -- ≤ 10 (C1-2-02; SFC list 09.09.2026)
  earlycheck_runs               jsonb NOT NULL DEFAULT '{}'::jsonb,                  -- addendum column: summary {last_du_file_run_id, last_uldd_run_id, fatal_count, warning_count, clean}
  package_id                    uuid,                                                -- current frozen package (FK added below)
  enote_indicator               boolean NOT NULL DEFAULT false,
  ron_indicator                 boolean NOT NULL DEFAULT false,
  rebuild_reason                text,
  ucd_casefile_id               text,                                                -- 25.2 sets (ucd_submissions.casefile_id_ucd); = du_casefiles.casefile_id (R3 b)
  -- 29.4 status columns (addendum §3)
  loan_delivery_status          text NOT NULL DEFAULT 'not_started' CHECK (loan_delivery_status IN ('not_started', 'draft', 'submitted', 'purchase_requested', 'purchase_ready', 'purchased_and_funded', 'withdrawn')),
  certification_status          text CHECK (certification_status IN ('pending', 'certified', 'qualified', 'exception', 'auto_certified')),
  fnma_loan_number              char(10),
  purchase_date                 date,
  acquisition_date              date,
  purchase_advice_id            uuid,                                                -- 29.4 `purchase_advices` (FK added by 29.4's migration)
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(sfc_codes) <= 10)
);
COMMENT ON TABLE deliveries IS '29.3/29.4 data model (addendum §3 baseline): one whole-loan delivery per funded loan — 29.3 builds, validates, freezes and hashes the ULDD Phase 5 (5.2.0) package (build_status), 29.4 submits it through Loan Delivery and records certification and purchase (loan_delivery_status, certification_status, purchase_date, purchase_advice_id); 25.2 sets ucd_casefile_id. Retention fnma_loan_file_life_plus_4y.';
CREATE UNIQUE INDEX deliveries_loan_idx ON deliveries(loan_id);
CREATE INDEX deliveries_status_idx ON deliveries(build_status, loan_delivery_status);

-- R2: one row per populated Sort ID per build; unpopulated CR/CI points are recorded with value = null and condition_evaluated = true so gate T5 can prove the conditionality decision. Append-only.
CREATE TABLE uldd_data_points (
  data_point_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id                   uuid NOT NULL REFERENCES deliveries(delivery_id),
  build_no                      int NOT NULL,
  sort_id                       text,                                                -- Appendix D Sort ID (e.g. 322, 49.2); null when the Sort ID was not verified on the pages read (keyed by data_point_name)
  data_point_name               text NOT NULL,
  xpath                         text NOT NULL,
  conditionality                text NOT NULL CHECK (conditionality IN ('R', 'CR', 'CI', 'O')),
  value                         text,
  value_type                    text NOT NULL CHECK (value_type IN ('string', 'date', 'amount', 'percent', 'boolean', 'enum', 'integer')),
  source_table                  text NOT NULL,
  source_column                 text NOT NULL,
  source_record_id              uuid,
  source_version                text,
  derivation                    text,                                                -- formula for computed points (LTV, P&I, cents → dollars)
  override_value                text,
  override_reason               text,                                                -- required with override_value; enumeration defaults / formatting only — never amounts, dates, scores, values, identifiers
  override_by                   text,
  condition_evaluated           boolean NOT NULL DEFAULT false,
  condition                     text,
  pii                           boolean NOT NULL DEFAULT false,                      -- borrower name/SSN/DOB/addresses; restricted access
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CHECK (override_value IS NULL OR override_reason IS NOT NULL)
);
COMMENT ON TABLE uldd_data_points IS '29.3 R2: full provenance per Sort ID per build (fnma.uldd.5.2.0 Appendix D conditionality R/CR/CI/O); the audit evidence for LQC data-validation requests.';
CREATE INDEX uldd_data_points_build_idx ON uldd_data_points(delivery_id, build_no, sort_id);
CREATE TRIGGER uldd_data_points_immutable BEFORE UPDATE OR DELETE ON uldd_data_points FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- R4: the SFC set with the owning process's rule reference; invariant count(included_in_uldd) ≤ 10 (never dropped to fit — officer escalation). Append-only.
CREATE TABLE sfc_assignments (
  assignment_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id                   uuid NOT NULL REFERENCES deliveries(delivery_id),
  build_no                      int NOT NULL DEFAULT 1,
  sfc_code                      char(3) NOT NULL CHECK (sfc_code ~ '^[0-9]{3}$'),
  rule_ref                      text NOT NULL,                                       -- e.g. 23.2/SFC-127-always, LL-2026-06/score_model=vantagescore_4
  required                      boolean NOT NULL DEFAULT true,
  auto_derived_by_fnma          boolean NOT NULL DEFAULT false,                      -- per the SFC list note / Business Rules Dictionary
  evidence_ref                  text,                                                -- owning process's record/document/event id
  included_in_uldd              boolean NOT NULL DEFAULT true,
  assigned_at                   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE sfc_assignments IS '29.3 R4: Special Feature Codes assembled from the finished processes'' events (20.4/22.3/22.4/22.6/23.2/24.1/24.3/24.4/24.5/24.6/26.1/26.2/31.1), never recomputed; SFC list 09.09.2026 ("Up to ten SFCs may be reported at delivery").';
CREATE INDEX sfc_assignments_delivery_idx ON sfc_assignments(delivery_id, build_no) WHERE included_in_uldd;
CREATE TRIGGER sfc_assignments_immutable BEFORE UPDATE OR DELETE ON sfc_assignments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- EarlyCheck Direct Integration (or UI fallback) runs; idempotent per (delivery_id, file_sha256, file_kind) — an identical file is never re-submitted.
CREATE TABLE earlycheck_runs (
  run_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id                   uuid NOT NULL REFERENCES deliveries(delivery_id),
  build_no                      int NOT NULL,
  file_kind                     text NOT NULL CHECK (file_kind IN ('du_spec_3_4', 'uldd_3_0')),
  file_document_id              uuid REFERENCES documents(id),
  file_sha256                   bytea NOT NULL,                                      -- the hash of the file actually run (the UI fallback records the operator's file)
  channel                       text NOT NULL DEFAULT 'di' CHECK (channel IN ('di', 'ui')),
  submitted_at                  timestamptz NOT NULL,
  completed_at                  timestamptz,
  result_document_id            uuid REFERENCES documents(id),                       -- result data file / UI export
  edit_count_by_severity        jsonb,                                               -- {fatal, warning_to_fatal, warning, informational, observational}
  clean                         boolean,                                             -- zero fatal and zero warning-to-fatal
  du_compare_results            jsonb,
  standardized_address          jsonb,
  computed_fields               jsonb,                                               -- LTV, CLTV, DTI, monthly debt, monthly income as EarlyCheck computed them (R5)
  submitted_by                  text NOT NULL,                                       -- agent run or fnma_portal_operator
  correlation_id                text NOT NULL,
  escalation_id                 uuid REFERENCES escalations(id),                     -- the fnma_portal_operator UI-fallback task (after 60 minutes without a DI result)
  UNIQUE (delivery_id, file_kind, file_sha256, channel)
);
COMMENT ON TABLE earlycheck_runs IS '29.3: every EarlyCheck request/result pair (DI XML or UI export) with severities; a clean run certifies only the exact file hash it ran (FNMA_C1_2_02_EARLYCHECK_CLEAN_GATE, FNMA_C1_2_02_DU_FILE_EARLYCHECK_GATE). EarlyCheck mirrors Loan Delivery edits but not commitment/pricing edits — a clean run is not a clean import.';
CREATE INDEX earlycheck_runs_delivery_idx ON earlycheck_runs(delivery_id, file_kind, completed_at);

-- Edits observed (EarlyCheck here; LDTE at onboarding; Loan Delivery by 29.4) with their owner and resolution; fatal / warning-to-fatal / DU Compare edits are never bypassed.
CREATE TABLE delivery_edits (
  edit_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id                   uuid NOT NULL REFERENCES deliveries(delivery_id),
  run_id                        uuid REFERENCES earlycheck_runs(run_id),
  source                        text NOT NULL CHECK (source IN ('earlycheck', 'ldte', 'loan_delivery')),
  edit_code                     text NOT NULL,
  prefix                        text NOT NULL CHECK (prefix IN ('A', 'C', 'D', 'numeric', 'general')),   -- A = appraisal/UCDP (24.2), C = closing/UCD (25.2), D = DU (23.1), 3000-series = commitment (29.1)
  severity                      text NOT NULL CHECK (severity IN ('fatal', 'warning_to_fatal', 'warning', 'informational', 'observational')),
  message                       text NOT NULL,
  sort_ids                      text[] NOT NULL DEFAULT '{}',
  owner_process                 text NOT NULL,
  observed_at                   timestamptz NOT NULL,
  resolution                    text NOT NULL DEFAULT 'unresolved' CHECK (resolution IN ('data_corrected', 'source_corrected_upstream', 'bypassed_with_justification', 'unresolved', 'not_applicable')),
  resolution_ref                text,                                                -- event / record / rule reference
  resolved_at                   timestamptz,
  resolved_by                   text,
  details                       jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (resolution <> 'bypassed_with_justification' OR severity IN ('warning', 'informational', 'observational')),
  CHECK (resolution = 'unresolved' OR resolution_ref IS NOT NULL)
);
COMMENT ON TABLE delivery_edits IS '29.3 (and 29.4, source = loan_delivery): every edit with its Loan Delivery FAQ Q9 owner and resolution; a bypass is allowed only on warnings with a recorded justification (open question 6) and never on a DU Compare edit (23.1 corrects the source).';
CREATE INDEX delivery_edits_delivery_idx ON delivery_edits(delivery_id, resolution);

-- The frozen package: uldd_sha256 = hash of the exact file handed to 29.4; gate results at frozen_at; immutable after freeze — a data change produces a new version (superseded_by).
CREATE TABLE delivery_packages (
  package_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id                   uuid NOT NULL REFERENCES deliveries(delivery_id),
  version                       int NOT NULL,
  build_no                      int NOT NULL,
  uldd_document_id              uuid NOT NULL REFERENCES documents(id),
  uldd_sha256                   bytea NOT NULL,
  earlycheck_run_id             uuid NOT NULL REFERENCES earlycheck_runs(run_id),   -- the clean ULDD run on exactly this file hash
  identifier_snapshot           jsonb NOT NULL,
  sfc_codes                     text[] NOT NULL,
  gate_results                  jsonb NOT NULL,                                      -- every gate code with {result ∈ open|closed|n/a, evidence_ref}
  operator_instructions_document_id uuid REFERENCES documents(id),                   -- 29.4 renders
  frozen_at                     timestamptz NOT NULL,
  frozen_by_agent_run_id        text NOT NULL,
  agent_decision_id             uuid REFERENCES agent_decisions(id),
  status                        text NOT NULL DEFAULT 'frozen' CHECK (status IN ('frozen', 'handed_to_operator', 'imported', 'superseded')),
  superseded_by                 uuid REFERENCES delivery_packages(package_id),
  supersede_reason              text CHECK (supersede_reason IS NULL OR supersede_reason IN ('cd_corrected', 'mapped_source_write', 'loan_delivery_fatal_edit', 'commitment_modified', 'commitment_extended', 'commitment_expired', 'condition_reopened')),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, version),
  CHECK (cardinality(sfc_codes) <= 10)
);
COMMENT ON TABLE delivery_packages IS '29.3: the frozen, hashed package a human operator imports through Loan Delivery (no API — 29.4 fnma_portal_operator task); SM_O103_PACKAGE_FREEZE_GATE = a row whose uldd_sha256 equals the hash of the exact file handed over with every composed gate open at frozen_at; SM_O103_REBUILD_ON_CHANGE supersedes it on any post-freeze data change (a stale package is never imported).';
CREATE INDEX delivery_packages_current_idx ON delivery_packages(delivery_id) WHERE status IN ('frozen', 'handed_to_operator');
ALTER TABLE deliveries ADD CONSTRAINT deliveries_package_fk FOREIGN KEY (package_id) REFERENCES delivery_packages(package_id);

COMMIT;
