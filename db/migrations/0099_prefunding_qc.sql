-- 0099_prefunding_qc.sql — §28.1 Prefunding quality control program: qc_sample_plans, qc_reviews (the common columns;
-- 28.2 adds the post-closing cycle columns by ALTER), qc_reverifications (shared with 28.2), origination columns on the
-- servicing QC tables qc_findings / qc_reports (0021, reused — never a second QC table set), and
-- applications.qc_prefunding_status (denormalized for 23.3's ctc_checklists item SM_QC_PREFUNDING_HOLD).
-- Retention class `fnma_qc_3y` (D1-1-01: three years from closed_at) is carried as text with a CHECK, like 0061's
-- loan_documents_index, so no enum value has to be added outside a transaction.
BEGIN;

-- ───────────────────────────── qc_sample_plans (rule 1/2: the monthly plan) ─────────────────────────────
CREATE TABLE qc_sample_plans (
  sample_plan_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                uuid NOT NULL REFERENCES parties(id),
  kind                      text NOT NULL CHECK (kind IN ('prefunding', 'post_closing')),
  period_month              date NOT NULL,                                          -- first calendar day of the month
  eligible_population       int  NOT NULL DEFAULT 0 CHECK (eligible_population >= 0),
  forecast_closings         int  NOT NULL DEFAULT 0 CHECK (forecast_closings >= 0),
  random_target             int  NOT NULL CHECK (random_target >= 0),                -- max(ceil(0.05 × forecast), 10); Fannie Mae-imposed floor wins (edge case)
  random_method             text NOT NULL DEFAULT 'uniform' CHECK (random_method IN ('uniform', 'stratified_channel')),
  strata                    jsonb NOT NULL DEFAULT '[]',                            -- [{key: channel|transaction_type|occupancy, volume, quota}] — every channel represented
  risk_trigger_set_version  text NOT NULL,
  imposed_floor_letter_document_id uuid REFERENCES documents(id),                  -- the Fannie Mae letter when a minimum is imposed
  planned_at                timestamptz NOT NULL DEFAULT now(),
  approved_by_qc_officer_at timestamptz,
  approved_by_qc_officer_id text,
  actuals                   jsonb NOT NULL DEFAULT '{"selected":0,"random_selected":0,"reviewed":0,"pct_of_eligible":0}',  -- D1-1-03 "percentage of total eligible loans reviewed"
  retention_class           text NOT NULL DEFAULT 'fnma_qc_3y' CHECK (retention_class IN ('fnma_qc_3y', 'fnma_loan_file_life_plus_4y')),
  UNIQUE (partner_id, kind, period_month)
);
COMMENT ON TABLE qc_sample_plans IS '28.1 rule 1/2: the monthly prefunding (28.2: post-closing) sample plan — eligible population, random target, strata quotas, the risk-trigger set version and the actuals reported under D1-1-03.';

-- ───────────────────────────── qc_reviews (state machine; 28.1 common columns) ─────────────────────────────
CREATE TABLE qc_reviews (
  review_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id            uuid REFERENCES applications(id),
  loan_id                   uuid REFERENCES loans(id),                             -- set after funding (30.2)
  partner_id                uuid NOT NULL REFERENCES parties(id),
  kind                      text NOT NULL CHECK (kind IN ('prefunding', 'post_closing_random', 'post_closing_discretionary', 'epd', 'fnma_lqc')),
  selection_basis           text NOT NULL CHECK (selection_basis IN ('random', 'risk_trigger', 'model_monitoring', 'channel_floor', 'fnma_request', 'discretionary_manual')),
  selection_reason_codes    text[] NOT NULL DEFAULT '{}',
  random_hit                boolean NOT NULL DEFAULT false,                          -- a risk-trigger selection the random draw also accepted (unbiased random statistics)
  sample_plan_id            uuid REFERENCES qc_sample_plans(sample_plan_id),
  review_type               text NOT NULL CHECK (review_type IN ('full_file', 'component')),
  component_scope           text[] NOT NULL DEFAULT '{}',                           -- subset of aus_data, ssn, income, employment_vvoe, assets, collateral, mi, occupancy, compliance, closing_docs, fraud
  status                    text NOT NULL DEFAULT 'selected' CHECK (status IN ('selected', 'in_review', 'awaiting_reverification', 'findings_drafted', 'officer_review', 'findings_released', 'rebuttal', 'reunderwrite', 'closed', 'cancelled', 'unable_to_complete')),
  reviewer_agent_run_id     text,                                                    -- must carry the qc-audit deployment identity (guard: never a production agent run)
  qc_officer_id             text,
  officer_signed_at         timestamptz,
  officer_sample            boolean NOT NULL DEFAULT false,                          -- in the officer's random 10% sample of no-defect conclusions (rule 6)
  selected_at               timestamptz NOT NULL DEFAULT now(),
  due_at                    date,                                                    -- SM_QC_PREFUNDING_REVIEW_SLA_2BD: selected_at + 2 business_days_creditor
  opened_at                 timestamptz NOT NULL DEFAULT now(),
  review_completed_at       timestamptz,
  closed_at                 timestamptz,
  outcome                   text CHECK (outcome IS NULL OR outcome IN ('no_defect', 'defect_corrected', 'defect_uncorrected', 'cancelled', 'unable_to_complete')),
  highest_severity          smallint CHECK (highest_severity IS NULL OR highest_severity BETWEEN 1 AND 4),  -- 1 = significant/ineligible … 4 = documentation
  findings                  jsonb NOT NULL DEFAULT '[]',                            -- addendum §3: finding ids on the review
  production_hold_applied   boolean NOT NULL DEFAULT true,
  hold_id                   text,
  hold_released_at          timestamptz,
  hold_released_by          text,                                                    -- closed{no_defect|defect_corrected} by the agent, or the qc_officer's unable_to_complete
  rule_set_version          text NOT NULL,
  model_version             text,
  prompt_version            text,
  retention_class           text NOT NULL DEFAULT 'fnma_qc_3y' CHECK (retention_class IN ('fnma_qc_3y', 'fnma_loan_file_life_plus_4y')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qc_reviews_subject CHECK (application_id IS NOT NULL OR loan_id IS NOT NULL),
  CONSTRAINT qc_reviews_terminal_outcome CHECK (status NOT IN ('closed', 'cancelled', 'unable_to_complete') OR outcome IS NOT NULL),
  CONSTRAINT qc_reviews_hold_release_path CHECK (hold_released_at IS NULL OR outcome IN ('no_defect', 'defect_corrected', 'unable_to_complete'))
);
CREATE INDEX qc_reviews_application_idx ON qc_reviews(application_id, kind);
CREATE INDEX qc_reviews_open_idx ON qc_reviews(status) WHERE status NOT IN ('closed', 'cancelled', 'unable_to_complete');
CREATE UNIQUE INDEX qc_reviews_one_prefunding_per_application ON qc_reviews(application_id) WHERE kind = 'prefunding';   -- rule 1: a loan already selected is never re-selected
COMMENT ON TABLE qc_reviews IS '28.1 (common columns; 28.2 adds the post-closing cycle columns): one QC review per selection — selection basis and reasons, scope, the prefunding state machine, outcome, severity, the production hold and its release, rule-set/model/prompt versions. FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE is open iff status ∈ {closed{no_defect, defect_corrected}, unable_to_complete}.';
-- history: terminal rows are immutable, rows are never deleted (D1-1-01 three-year record keeping)
CREATE OR REPLACE FUNCTION qc_reviews_history_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'qc_reviews rows are never deleted (D1-1-01: QC records retained at least three years)'; END IF;
  IF OLD.status IN ('closed', 'cancelled', 'unable_to_complete') AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.hold_released_at IS DISTINCT FROM OLD.hold_released_at) THEN
    RAISE EXCEPTION 'a terminal qc_reviews row is immutable (28.1 state machine)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qc_reviews_history_only BEFORE UPDATE OR DELETE ON qc_reviews FOR EACH ROW EXECUTE FUNCTION qc_reviews_history_only();

-- ───────────────────────────── qc_reverifications (rule 4(b), 28.1-Q6; shared with 28.2) ─────────────────────────────
CREATE TABLE qc_reverifications (
  reverification_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id                 uuid NOT NULL REFERENCES qc_reviews(review_id),
  application_id            uuid REFERENCES applications(id),
  kind                      text NOT NULL CHECK (kind IN ('ssn_cbsv', 'income_written', 'employment_verbal', 'employment_written', 'assets_written', 'tax_transcript', 'occupancy', 'appraisal_desk', 'appraisal_field', 'credit_refresh', 'title', 'mi', 'gift_donor', 'rent_landlord')),
  source                    text NOT NULL,                                           -- employer / institution / IRS / SSA / vendor
  requested_at              timestamptz NOT NULL DEFAULT now(),
  request_dates             date[] NOT NULL DEFAULT '{}',                           -- both request dates when a second request is logged (T12)
  response_due_at           date NOT NULL,                                           -- SM_QC_REVERIFICATION_RESPONSE_3BD: +3 business_days_creditor
  escalate_at               date,                                                   -- +5 BD: qc_officer decides unable_to_complete vs hold
  received_at               timestamptz,
  result                    text CHECK (result IS NULL OR result IN ('match', 'variance', 'no_response', 'unable')),
  variance                  jsonb,
  document_id               uuid REFERENCES documents(id),
  purpose_code              text NOT NULL DEFAULT 'qc_prefunding' CHECK (purpose_code IN ('qc_prefunding', 'qc_post_closing')),  -- vendor logs distinguish production and QC calls
  fee_cents                 bigint NOT NULL DEFAULT 0,                              -- third_party_costs, SM-borne
  officer_decision          text CHECK (officer_decision IS NULL OR officer_decision IN ('unable_to_complete', 'keep_hold')),
  retention_class           text NOT NULL DEFAULT 'fnma_qc_3y' CHECK (retention_class IN ('fnma_qc_3y', 'fnma_loan_file_life_plus_4y'))
);
CREATE INDEX qc_reverifications_review_idx ON qc_reverifications(review_id);
CREATE INDEX qc_reverifications_outstanding_idx ON qc_reverifications(response_due_at) WHERE received_at IS NULL;
COMMENT ON TABLE qc_reverifications IS '28.1 (shared with 28.2): reverifications ordered under a QC purpose code through the 22.x adapters — request dates, response due (+3 BD), result/variance, the fee SM bears, and the officer''s unable_to_complete vs hold decision.';

-- ───────────────────────────── qc_findings: origination columns (0021 table reused; PK case_id stays — an origination finding is a `cases{case_type=qc_finding}` row) ─────────────────────────────
ALTER TABLE qc_findings ADD COLUMN finding_id             uuid UNIQUE DEFAULT gen_random_uuid();
ALTER TABLE qc_findings ADD COLUMN review_id              uuid REFERENCES qc_reviews(review_id);
ALTER TABLE qc_findings ADD COLUMN application_id         uuid REFERENCES applications(id);
ALTER TABLE qc_findings ADD COLUMN category               text CHECK (category IS NULL OR category IN ('income_employment', 'assets', 'credit', 'liabilities', 'collateral', 'eligibility', 'data_integrity', 'legal_regulatory_compliance', 'insurance', 'closing_docs', 'identity_ssn', 'occupancy', 'fraud_misrepresentation'));  -- Loan Quality Connect-aligned
ALTER TABLE qc_findings ADD COLUMN sub_category           text;
ALTER TABLE qc_findings ADD COLUMN defect_code            text;                    -- rule_sets.fnma.qc.taxonomy.v1: `<category>/<sub_category>`
ALTER TABLE qc_findings ADD COLUMN severity_level         smallint CHECK (severity_level IS NULL OR severity_level BETWEEN 1 AND 4);  -- 1 ineligible/unsupported … 4 observation; maps onto the 0021 severity text
ALTER TABLE qc_findings ADD COLUMN description            text;
ALTER TABLE qc_findings ADD COLUMN evidence_refs          jsonb NOT NULL DEFAULT '[]';   -- [{document_id, page, extraction_id}]
ALTER TABLE qc_findings ADD COLUMN observed_value         text;
ALTER TABLE qc_findings ADD COLUMN expected_value         text;
ALTER TABLE qc_findings ADD COLUMN guide_citation         text;                    -- topic id + last-updated date
ALTER TABLE qc_findings ADD COLUMN law_citation           text;
ALTER TABLE qc_findings ADD COLUMN is_compliance          boolean NOT NULL DEFAULT false;   -- D1-1-03: compliance vs underwriting/eligibility defects
ALTER TABLE qc_findings ADD COLUMN finding_status         text CHECK (finding_status IS NULL OR finding_status IN ('draft', 'released', 'rebutted', 'corrected', 'sustained', 'withdrawn'));
ALTER TABLE qc_findings ADD COLUMN released_at            timestamptz;
ALTER TABLE qc_findings ADD COLUMN rebuttal               jsonb;                   -- {by_agent_run_id, text, evidence_refs, at}
ALTER TABLE qc_findings ADD COLUMN resolution             text CHECK (resolution IS NULL OR resolution IN ('condition_reopened', 'decision_reversed', 'data_corrected', 'no_action_rebuttal_accepted', 'waived_by_officer'));
ALTER TABLE qc_findings ADD COLUMN resolution_ref         text;                    -- condition id / decision id / DU submission id
ALTER TABLE qc_findings ADD COLUMN resolved_at            timestamptz;
ALTER TABLE qc_findings ADD COLUMN reviewed_by_qc_officer_at timestamptz;
ALTER TABLE qc_findings ADD COLUMN officer_decision       text CHECK (officer_decision IS NULL OR officer_decision IN ('released', 'withdrawn'));
ALTER TABLE qc_findings ADD CONSTRAINT qc_findings_origination_shape CHECK (review_id IS NULL OR (category IS NOT NULL AND defect_code IS NOT NULL AND severity_level IS NOT NULL AND finding_status IS NOT NULL));
ALTER TABLE qc_findings ADD CONSTRAINT qc_findings_release_needs_officer CHECK (finding_status IS DISTINCT FROM 'released' OR severity_level IS NULL OR severity_level > 2 OR reviewed_by_qc_officer_at IS NOT NULL);  -- the agent never self-approves a severity-1/2 finding
CREATE INDEX qc_findings_review_idx ON qc_findings(review_id) WHERE review_id IS NOT NULL;
CREATE INDEX qc_findings_defect_code_idx ON qc_findings(defect_code) WHERE defect_code IS NOT NULL;   -- rule 7 trend: same defect code in ≥ 3 loans
COMMENT ON COLUMN qc_findings.review_id IS '28.1: origination findings hang off qc_reviews; the 0021 case_id PK is the finding''s cases{case_type=qc_finding} row (loan_id null before funding).';

-- ───────────────────────────── qc_reports: origination kinds (0021 table reused; cycle_id becomes optional for prefunding/annual reports) ─────────────────────────────
ALTER TABLE qc_reports ALTER COLUMN cycle_id DROP NOT NULL;
ALTER TABLE qc_reports ADD COLUMN report_kind            text CHECK (report_kind IS NULL OR report_kind IN ('prefunding_monthly', 'post_closing_monthly', 'post_closing_quarterly', 'vendor_review_monthly', 'qc_audit_annual'));
ALTER TABLE qc_reports ADD COLUMN partner_id             uuid REFERENCES parties(id);
ALTER TABLE qc_reports ADD COLUMN period                 text;                    -- '2026-10' / '2026'
ALTER TABLE qc_reports ADD COLUMN sample_plan_id         uuid REFERENCES qc_sample_plans(sample_plan_id);
ALTER TABLE qc_reports ADD COLUMN metrics                jsonb NOT NULL DEFAULT '{}';    -- rule 7: defect rate by severity, sample_pct, categories, selection-to-release, officer concurrence, strata
ALTER TABLE qc_reports ADD COLUMN trend_window_months    int CHECK (trend_window_months IS NULL OR trend_window_months >= 0);   -- D1-1-03: ≥ 3 for prefunding monthly
ALTER TABLE qc_reports ADD COLUMN sample_description     text;                    -- D1-1-03: criteria, number reviewed, percentage of eligible
ALTER TABLE qc_reports ADD COLUMN issued_at              timestamptz;
ALTER TABLE qc_reports ADD COLUMN signed_by_qc_officer_at timestamptz;
ALTER TABLE qc_reports ADD COLUMN acknowledged_by_management_at timestamptz;
ALTER TABLE qc_reports ADD COLUMN corrective_action_plans jsonb NOT NULL DEFAULT '[]';   -- [{trend, action, owner, expected_resolution, due_date, status}] (D1-1-01)
ALTER TABLE qc_reports ADD COLUMN retention_class        text NOT NULL DEFAULT 'fnma_qc_3y' CHECK (retention_class IN ('fnma_qc_3y', 'corporate_7y'));
ALTER TABLE qc_reports ADD CONSTRAINT qc_reports_cycle_or_kind CHECK (cycle_id IS NOT NULL OR (report_kind IS NOT NULL AND period IS NOT NULL));
ALTER TABLE qc_reports ADD CONSTRAINT qc_reports_prefunding_trend CHECK (report_kind IS DISTINCT FROM 'prefunding_monthly' OR trend_window_months IS NULL OR trend_window_months >= 3);
COMMENT ON COLUMN qc_reports.report_kind IS '28.1/28.2: origination report kinds on the 0021 table; prefunding_monthly is due completion_date + 30 calendar days (FNMA_D1_1_03_PREFUNDING_REPORT_30) and signed by the qc_officer (SM_QC_REPORT_SIGNOFF_SLA_3BD).';

-- ───────────────────────────── applications.qc_prefunding_status (denormalized for the CTC checklist) ─────────────────────────────
ALTER TABLE applications ADD COLUMN IF NOT EXISTS qc_prefunding_status text NOT NULL DEFAULT 'not_selected' CHECK (qc_prefunding_status IN ('not_selected', 'selected', 'in_review', 'hold', 'cleared', 'defect_open'));
COMMENT ON COLUMN applications.qc_prefunding_status IS '28.1: not_selected | selected | in_review | hold | cleared | defect_open — projected from qc.review.* / qc.hold.* events for 23.3''s ctc_checklists item SM_QC_PREFUNDING_HOLD; the qc-audit agent itself never writes applications.';

COMMIT;
