-- 0108_ai_governance_fair_lending.sql — §31.2 AI governance, model risk and fair-lending controls for AI underwriting,
-- pricing and adverse action (spec/sections/31-cross-cutting-licensing-and-approvals-ai-governance-and-fair/31-2-….md
-- "Data model"). Owned here: the origination columns 31.2 adds to the shared 19.3 inventory `ai_systems` (0021) and to the
-- baseline decision record `agent_decisions` (0001; `application_id` from 0057), the `jurisdiction_rules.ai_governance`
-- key (0002 pattern: one jsonb column per section), and the new tables `ai_impact_assessments` (supersedes 19.4's
-- `impact_assessments` for origination systems), `ai_eval_suites` / `ai_eval_runs`, `fair_lending_runs` /
-- `fair_lending_findings` / `fair_lending_reviews` (origination counterparts of 19.4's fair_servicing_* — same flag
-- vocabulary, same thresholds), `lda_searches` and `consumer_ai_rights_requests` (Colorado rows mirror 21.6's
-- `adverse_actions.co_admt` block — 21.6 writes, 31.2 reads and reports). Not here (other owners, never duplicated):
-- `ai_bias_tests` (0022, 19.4), `pricing_exception_reviews` (0069, 25.1), `adverse_actions` / `hmda_records` (0068, 21.6/28.3),
-- `restricted_fl.applicant_demographics` (0057), `rule_sets` (0006 — a model inventory references rule-set versions, never a
-- parallel version table), `fnma_notices` / `records_requests` (0022). No money columns. Runs, findings, LDA searches and
-- rights requests are append-only (0001's forbid_mutation trigger); assessments, eval runs and reviews carry a status and are
-- never deleted (forbid_delete). Retention: ai_governance_7y (program records), co_admt_3y / regb_25m on consumer-level rows.
BEGIN;

-- ---------------------------------------------------------------- ai_systems: origination columns (19.3 owns the table)
ALTER TABLE ai_systems
  ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT 'servicing' CHECK (domain IN ('origination', 'servicing')),
  ADD COLUMN IF NOT EXISTS agent_package text CHECK (agent_package IS NULL OR agent_package IN ('intake', 'pricing', 'disclosure', 'verification', 'fraud-risk', 'underwriter', 'valuation', 'title-closing', 'compliance-tester', 'funder', 'warehouse', 'post-closing', 'secondary', 'hmda', 'boarding')),
  ADD COLUMN IF NOT EXISTS decision_kinds text[] NOT NULL DEFAULT '{}',                       -- ⊆ {credit_decision, counteroffer, noia, pricing_quote, lock_terms, pricing_exception, valuation_review, rov, fraud_hold, identity_hold, condition_waiver, needs_list, mlo_terms_prep, disclosure_content, qc_selection, delivery_prep}
  ADD COLUMN IF NOT EXISTS materially_influences_consequential_decision boolean NOT NULL DEFAULT false,   -- Colorado test (rule 1)
  ADD COLUMN IF NOT EXISTS co_admt_role text NOT NULL DEFAULT 'n_a' CHECK (co_admt_role IN ('developer', 'deployer', 'both', 'n_a')),
  ADD COLUMN IF NOT EXISTS co_technical_documentation_document_id uuid REFERENCES documents(id),    -- 6-1-1702 DOC_AI_SYSTEM_CARD
  ADD COLUMN IF NOT EXISTS co_docs_delivered_to_deployer_at timestamptz,
  ADD COLUMN IF NOT EXISTS co_docs_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS ca_admt_significant_decision boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ca_substantially_replaces_human boolean NOT NULL DEFAULT false,   -- false wherever underwriting_reviewer meets the (A)–(C) test
  ADD COLUMN IF NOT EXISTS sr11_7_model_class text CHECK (sr11_7_model_class IS NULL OR sr11_7_model_class IN ('rules_deterministic', 'llm_agent', 'vendor_model_consumed', 'scoring_model')),
  ADD COLUMN IF NOT EXISTS eval_suite_version text,
  ADD COLUMN IF NOT EXISTS bias_test_cadence text NOT NULL DEFAULT 'n_a' CHECK (bias_test_cadence IN ('pre_deploy_and_quarterly', 'pre_deploy_only', 'n_a')),
  ADD COLUMN IF NOT EXISTS decision_record_schema_version text,
  ADD COLUMN IF NOT EXISTS partner_notified_at timestamptz,                                 -- version-change notice (SM_O122_MODEL_CHANGE_NOTICE_TO_PARTNER_10BD)
  ADD COLUMN IF NOT EXISTS restricted_decision_kinds text[] NOT NULL DEFAULT '{}';         -- kill-switch per decision kind (state `restricted`)
COMMENT ON COLUMN ai_systems.domain IS '31.2 data model: origination systems carry agent_package, decision_kinds, the Colorado/California classification and the SR 11-7 model class; state machine registered → assessed → evaluated → bias_tested → partner_notified → deployed ⇄ monitored → restricted → retired.';

-- ---------------------------------------------------------------- agent_decisions: the decision-record minimum for origination decision systems (rule 3)
ALTER TABLE agent_decisions
  ADD COLUMN IF NOT EXISTS inputs_manifest jsonb,                                            -- ids and data classes sent to the model (leakage tests; incident scoping)
  ADD COLUMN IF NOT EXISTS rule_set_versions jsonb,
  ADD COLUMN IF NOT EXISTS tool_calls_hash text,
  ADD COLUMN IF NOT EXISTS outcome text,
  ADD COLUMN IF NOT EXISTS principal_factors jsonb,                                          -- ranked; the source of §1002.9(b)(2) reasons (≤ 4 used)
  ADD COLUMN IF NOT EXISTS reviewer_id text,
  ADD COLUMN IF NOT EXISTS reviewer_action text CHECK (reviewer_action IS NULL OR reviewer_action IN ('approved', 'modified', 'rejected')),
  ADD COLUMN IF NOT EXISTS co_material_influence boolean,
  ADD COLUMN IF NOT EXISTS human_involvement_level text CHECK (human_involvement_level IS NULL OR human_involvement_level IN ('none', 'review_authority', 'decided_by_human')),
  ADD COLUMN IF NOT EXISTS retention_classes text[] NOT NULL DEFAULT '{}';                 -- co_admt_3y ∪ regb_25m ∪ fnma_loan_file_life_plus_4y on origination decisions
COMMENT ON COLUMN agent_decisions.human_involvement_level IS '31.2 rule 3 / CA §7001 test: none | review_authority | decided_by_human (AI off: the human path writes decided_by_human and the monthly monitor runs on the rows unchanged).';

-- ---------------------------------------------------------------- jurisdiction_rules.ai_governance (new key; owned here)
ALTER TABLE jurisdiction_rules ADD COLUMN IF NOT EXISTS ai_governance jsonb;
COMMENT ON COLUMN jurisdiction_rules.ai_governance IS '31.2: {co_admt: {applies_from: 2027-01-01, deployer_notice_template, explanation_days: 30, human_review_days_policy: 30, records_years: 3}, ca_admt: {applies_from: 2027-01-01, applicability_position ∈ applies|exempt_glba|unresolved, pre_use_notice_template, optout_exception: human_appeal}, ut: {disclosure_on_request, at_start_high_risk}, tx: {consumer_disclosure_private_lender: false, intent_standard: true}, fair_lending_disparate_impact ∈ statutory_or_regulatory_verified|unverified|none_known, citations[]}.';

-- ---------------------------------------------------------------- ai_impact_assessments (rule 2; supersedes 19.4 impact_assessments for origination systems)
CREATE TABLE ai_impact_assessments (
  assessment_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_system_id              text NOT NULL REFERENCES ai_systems(code),
  system_version            text,
  kind                      text NOT NULL CHECK (kind IN ('pre_deployment', 'annual', 'material_modification', 'ca_cppa_risk_assessment', 'post_incident', 'post_finding')),
  framework_refs            text[] NOT NULL DEFAULT '{LL-2026-04,"SR 11-7","NIST AI RMF 1.0","CO 6-1-1702","CA §7150"}',
  purpose                   text NOT NULL,
  decision_kinds            text[] NOT NULL DEFAULT '{}',
  inputs_data_classes       text[] NOT NULL DEFAULT '{}',                                  -- with the attestation that no restricted demographic field is an input
  inputs_attested           boolean NOT NULL DEFAULT false,
  proxy_review              jsonb NOT NULL DEFAULT '[]',                                    -- [{input, class ∈ legitimate_credit_factor|proxy_risk|prohibited, disposition}]
  known_limitations         text,
  evaluation_summary        jsonb NOT NULL DEFAULT '{}',                                    -- ai_eval_runs ids, pass/fail
  bias_test_summary         jsonb NOT NULL DEFAULT '{}',                                    -- ai_bias_tests ids
  fair_lending_analysis     jsonb NOT NULL DEFAULT '{}',                                    -- fair_lending_runs ids; LDA search ids
  human_review_design       text,
  monitoring_plan           jsonb NOT NULL DEFAULT '{}',                                    -- metrics, thresholds, cadence, kill-switch
  vendor_dependencies       jsonb NOT NULL DEFAULT '{}',
  residual_risk_rating      text NOT NULL DEFAULT 'medium' CHECK (residual_risk_rating IN ('low', 'medium', 'high')),
  approved                  boolean NOT NULL DEFAULT false,
  approved_by               text,                                                          -- SM officer
  partner_officer_approved  boolean NOT NULL DEFAULT false,                                 -- partner officer for pre_deployment of high-risk systems (open question 4)
  completed_at              timestamptz,
  next_due_at               date,                                                          -- completed_at + 365 days (SM_O122_AI_ASSESSMENT_ANNUAL_365)
  document_id               uuid REFERENCES documents(id),
  status                    text NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted', 'approved', 'superseded')),
  retention                 retention_class NOT NULL DEFAULT 'ai_governance_7y',
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_impact_assessments_approved_needs_attestation CHECK (approved = false OR inputs_attested = true),
  CONSTRAINT ai_impact_assessments_approved_needs_completion CHECK (approved = false OR (completed_at IS NOT NULL AND approved_by IS NOT NULL))
);
COMMENT ON TABLE ai_impact_assessments IS '31.2 rule 2: pre-deployment / annual / material-modification / CA §7150 assessments (SR 11-7: (a)–(c) conceptual soundness, (d)–(g) outcomes analysis, (i) ongoing monitoring); an approved pre_deployment or material_modification row is the first condition of SM_O122_ORIGINATION_AI_DEPLOY_GATE. Retention ai_governance_7y (Colorado 3-year floor). Never deleted.';
CREATE INDEX ai_impact_assessments_system_idx ON ai_impact_assessments(ai_system_id, kind, completed_at DESC);
CREATE TRIGGER ai_impact_assessments_never_deleted BEFORE DELETE ON ai_impact_assessments FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- ai_eval_suites / ai_eval_runs
CREATE TABLE ai_eval_suites (
  suite_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_system_id              text NOT NULL REFERENCES ai_systems(code),
  suite_version             text NOT NULL,
  kinds                     text[] NOT NULL DEFAULT '{golden_set_accuracy,reason_code_accuracy,instruction_following,robustness,latency_cost}',
  golden_set_hash           text,
  oracle_refs               text[] NOT NULL DEFAULT '{}',                                  -- Fannie Mae Income Calculator, DU findings, 25.1 APR/fee oracles
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ai_system_id, suite_version)
);
COMMENT ON TABLE ai_eval_suites IS '31.2 data model: one suite per agent version — golden-set accuracy, reason-code accuracy, instruction-following/guardrail tests, robustness, latency/cost.';
CREATE TABLE ai_eval_runs (
  run_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id                  uuid REFERENCES ai_eval_suites(suite_id),
  suite_version             text NOT NULL,
  ai_system_id              text NOT NULL REFERENCES ai_systems(code),
  system_version            text,
  component_versions        jsonb NOT NULL DEFAULT '{}',                                    -- {prompt_version, model_version, provider_model_version, rule_set_versions}
  metrics                   jsonb NOT NULL DEFAULT '{}',
  pass                      boolean NOT NULL,
  drift_detected            boolean NOT NULL DEFAULT false,                                 -- golden-set deltas beyond tolerance → ai.monitor.drift_detected
  ran_by                    text NOT NULL,                                                 -- independent evaluation identity (SR 11-7 independence)
  ran_at                    timestamptz NOT NULL DEFAULT now(),
  report_document_id        uuid REFERENCES documents(id),
  retention                 retention_class NOT NULL DEFAULT 'ai_governance_7y'
);
COMMENT ON TABLE ai_eval_runs IS '31.2: evaluation runs per agent version; a pass for the current version satisfies the 19.3 SM_AI_SYSTEM_EVAL_BEFORE_DEPLOY leg of the deploy gate; drift on the golden set restricts high-risk decision kinds (SM_O122_DRIFT_ALERT_REVIEW_2BD). Never deleted.';
CREATE INDEX ai_eval_runs_system_idx ON ai_eval_runs(ai_system_id, ran_at DESC);
CREATE TRIGGER ai_eval_runs_never_deleted BEFORE DELETE ON ai_eval_runs FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- fair_lending_runs / findings / reviews (origination counterparts of 19.4 fair_servicing_*)
CREATE TABLE fair_lending_runs (
  run_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                     text NOT NULL CHECK (scope IN ('underwriting_outcomes', 'pricing_outcomes', 'pricing_exceptions', 'steering_product_mix', 'marketing_triggers', 'valuation_review', 'fraud_holds', 'complaint_mix', 'reason_accuracy')),
  kind                      text NOT NULL DEFAULT 'monthly' CHECK (kind IN ('monthly', 'regression', 'annual', 'shadow', 'back_test')),
  controls                  boolean NOT NULL DEFAULT false,                                 -- logistic regression with legitimate controls (rule 5)
  period_start              date NOT NULL,
  period_end                date NOT NULL,
  population_rule           text NOT NULL,                                                 -- e.g. hmda_records.action_taken in (1,2,3,4,5) and action_taken_date in period
  method_version            text NOT NULL,                                                 -- METH-FL-02 vN
  dataset_hash              bytea,
  population_counts         jsonb NOT NULL DEFAULT '{}',
  demographic_source        text NOT NULL DEFAULT 'applicant_demographics' CHECK (demographic_source IN ('applicant_demographics', 'bisg_proxy', 'mixed')),
  human_only                boolean NOT NULL DEFAULT false,                                 -- AI off: the AI-vs-human split is human-only
  status                    text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'extracted', 'computed', 'flagged', 'reviewed', 'closed')),
  ran_at                    timestamptz NOT NULL DEFAULT now(),
  retention                 retention_class NOT NULL DEFAULT 'ai_governance_7y'
);
COMMENT ON TABLE fair_lending_runs IS '31.2 rules 5–7: monthly (by the 15th for the prior month; SM_O122_FAIR_LENDING_MONITOR_MONTHLY), quarterly regression (quarter-end + 20; SM_O122_FAIR_LENDING_REGRESSION_QUARTERLY), pricing-exception (SM_O122_PRICING_EXCEPTION_REVIEW_MONTHLY) and reason-accuracy (SM_O122_REASON_ACCURACY_SAMPLE_MONTHLY) runs over the restricted enclave; aggregates only. Append-only.';
CREATE INDEX fair_lending_runs_period_idx ON fair_lending_runs(scope, period_end DESC);
CREATE TRIGGER fair_lending_runs_immutable BEFORE UPDATE OR DELETE ON fair_lending_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE fair_lending_findings (
  finding_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                    uuid NOT NULL REFERENCES fair_lending_runs(run_id),
  metric_code               text NOT NULL,                                                 -- UW_APPROVAL_RATE, UW_COUNTEROFFER_RATE, UW_REVIEWER_OVERRIDE_RATE, PR_RATE_SPREAD_BPS, PR_EXCEPTION_GRANT_RATE, ST_PRODUCT_MIX_HOMEREADY, VAL_ROV_GRANT_RATE, FR_HOLD_RATE, MK_TRIGGER_OFFER_RATE, CS_COMPLAINT_RATE, RA_REASON_ACCURACY, …
  dimension                 text NOT NULL CHECK (dimension IN ('ethnicity', 'race', 'sex', 'age_62_plus', 'language_non_english', 'geography_majority_minority', 'reviewer', 'all')),
  "group"                   text NOT NULL,
  comparison_group          text NOT NULL,
  n_group                   int NOT NULL,
  n_comparison              int NOT NULL,
  rate_group                numeric(8,6),
  rate_comparison           numeric(8,6),
  air                       numeric(8,4),
  diff                      numeric(8,6),                                                  -- raw gap (rate_group − rate_comparison)
  z                         numeric(8,4),
  p_value                   numeric(10,8),
  adjusted_effect           jsonb,                                                         -- {odds_ratio, ci_95: [lo, hi], controls[]}
  flag                      text NOT NULL CHECK (flag IN ('none', 'screen', 'significant', 'material', 'suppressed')),
  flagged_at                date NOT NULL,                                                 -- anchor of SM_O122_FAIR_LENDING_REVIEW_30D for material findings
  ai_vs_human_split         jsonb,                                                         -- the same metric on AI-decided vs reviewer-modified cases
  window_months             int NOT NULL DEFAULT 1 CHECK (window_months IN (1, 3, 6, 12)),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fair_lending_findings_small_cells_suppressed CHECK (flag = 'suppressed' OR (n_group >= 10 AND n_comparison >= 10))
);
COMMENT ON TABLE fair_lending_findings IS '31.2 rule 5 (19.4 rule 7): AIR four-fifths screen, two-proportion z (Fisher when any cell < 5), logistic regression with legitimate controls; material = significant after controls and raw gap ≥ 5 pp or adjusted OR outside 0.80–1.25; small cells < 10 suppressed; groups < 30 pooled over 3/6/12-month windows. Append-only.';
CREATE INDEX fair_lending_findings_run_idx ON fair_lending_findings(run_id, metric_code);
CREATE TRIGGER fair_lending_findings_immutable BEFORE UPDATE OR DELETE ON fair_lending_findings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE fair_lending_reviews (
  finding_id                uuid PRIMARY KEY REFERENCES fair_lending_findings(finding_id),
  opened_at                 date NOT NULL,
  due_on                    date NOT NULL,                                                 -- opened_at + 30 calendar days
  reviewer                  text,                                                          -- officer
  root_cause                text,
  legitimate_justification  text,                                                          -- e.g. Fannie Mae eligibility rule, LLPA matrix
  lda_search_id             uuid,
  corrective_actions        jsonb NOT NULL DEFAULT '[]',                                    -- rule-set change ids, prompt version, training, process
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'closed')),
  closed_at                 timestamptz,
  privilege_marker          boolean NOT NULL DEFAULT true,                                  -- counsel-directed by default (open question 2)
  CONSTRAINT fair_lending_reviews_closure_basis CHECK (status <> 'closed' OR (reviewer IS NOT NULL AND (jsonb_array_length(corrective_actions) > 0 OR legitimate_justification IS NOT NULL)))
);
COMMENT ON TABLE fair_lending_reviews IS '31.2 rule 7 / state machine: a material finding opens a review (SM_O122_FAIR_LENDING_REVIEW_30D, +30 calendar days) that cannot close without an officer disposition and a corrective action or a documented legitimate justification. Never deleted.';
CREATE TRIGGER fair_lending_reviews_never_deleted BEFORE DELETE ON fair_lending_reviews FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- lda_searches (rule 8)
CREATE TABLE lda_searches (
  search_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject                   text NOT NULL,                                                 -- rule_set id / threshold / agent policy
  trigger                   text NOT NULL,                                                 -- finding id, pre-deployment, or annual
  finding_id                uuid REFERENCES fair_lending_findings(finding_id),
  alternatives              jsonb NOT NULL DEFAULT '[]',                                    -- [{description, predictive_performance_delta, disparity_delta_by_dimension}]
  selected                  text,
  rationale                 text NOT NULL,
  approved_by               text,
  completed_at              timestamptz NOT NULL DEFAULT now(),
  document_id               uuid REFERENCES documents(id),
  retention                 retention_class NOT NULL DEFAULT 'ai_governance_7y'
);
COMMENT ON TABLE lda_searches IS '31.2 rule 8: less-discriminatory-alternative search — recorded whether or not a change is made (California 2 CCR §12060 / New Jersey N.J.A.C. 13:16 burden-shifting evidence). Append-only.';
ALTER TABLE fair_lending_reviews ADD CONSTRAINT fair_lending_reviews_lda_fk FOREIGN KEY (lda_search_id) REFERENCES lda_searches(search_id);
CREATE TRIGGER lda_searches_immutable BEFORE UPDATE OR DELETE ON lda_searches FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- consumer_ai_rights_requests
CREATE TABLE consumer_ai_rights_requests (
  request_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id            uuid NOT NULL REFERENCES applications(id),
  kind                      text NOT NULL CHECK (kind IN ('co_human_review', 'co_correction', 'co_data_access', 'ca_optout', 'ca_access', 'ut_disclosure', 'generic_explanation')),
  received_at               timestamptz NOT NULL,
  channel                   text,
  due_at                    date NOT NULL,
  handler_id                text,
  routed_to                 text NOT NULL DEFAULT '31.2',                                   -- 21.6 (Colorado), 20.3 (Utah), CA path
  outcome                   text,
  completed_at              timestamptz,
  notice_id                 uuid REFERENCES notices(id),
  retention_class           text[] NOT NULL DEFAULT '{co_admt_3y,regb_25m}',
  created_at                timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE consumer_ai_rights_requests IS '31.2 data model / rule 10: consumer AI-rights requests (received → routed → in_review → decided → communicated → closed); Colorado rows mirror 21.6 adverse_actions.co_admt (single source: 21.6 writes; 31.2 reads and reports). Append-only.';
CREATE INDEX consumer_ai_rights_requests_app_idx ON consumer_ai_rights_requests(application_id, received_at);
CREATE TRIGGER consumer_ai_rights_requests_immutable BEFORE UPDATE OR DELETE ON consumer_ai_rights_requests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
