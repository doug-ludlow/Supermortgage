-- 0085_du_findings_conditions.sql — §23.2 DU findings interpretation, recommendation policy and conditions generation
-- (spec/sections/23-…/23-2-du-findings-interpretation-recommendation-policy-and-conditi.md "Data model"; addendum §3).
-- Owned here: conditions (the addendum-§3 shared conditions ledger that 22.1 document_requests.condition_id (0078) and 22.4
-- (0081) reference — no earlier migration created it; 23.3 owns the lifecycle transitions and its own condition_clearances),
-- du_message_rules (config, versioned per DU release), du_findings_interpretations (one per submission),
-- homeready_evaluations, homeownership_education_records, restructure_proposals. Not here (other owners, never duplicated):
-- du_casefiles / du_submissions / du_resubmission_checks (23.1's 0084, in flight — `du_submission_id` columns are plain uuids
-- with no FK so this file applies whether or not 0084 has landed), documents (0001), applications / application_borrowers
-- (0057), fraud_investigations (0083 — the du_red_flag investigation event carries the 22.6 case id), decisions (0068).
-- Append-only where the spec says so: du_findings_interpretations, homeready_evaluations and du_message_rules are evidence
-- rows (0001's forbid_mutation); conditions, education records and proposals are versioned by status transitions that 23.3 /
-- 21.6 own, so they are updatable but every transition is also a loan_events row. Retention fnma_loan_file_life_plus_4y.
BEGIN;

-- ---------------------------------------------------------------- conditions (addendum §3: source ∈ {du, underwriter, qc, compliance, closing}, stage ∈ {ptd, ptf, post_closing}, status)
CREATE TABLE conditions (
  condition_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                uuid NOT NULL REFERENCES applications(id),
  loan_id                       uuid REFERENCES loans(id),                      -- set after 30.2's hand-off (post_closing conditions)
  borrower_id                   uuid REFERENCES application_borrowers(id),      -- null unless the DU message is borrower-specific (JSON v2 associations)
  source                        text NOT NULL CHECK (source IN ('du', 'underwriter', 'qc', 'compliance', 'closing')),
  stage                         text NOT NULL CHECK (stage IN ('ptd', 'ptf', 'post_closing')),
  status                        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_borrower', 'waiting_third_party', 'satisfied_pending_review', 'cleared', 'waived', 'superseded', 'reopened')),
  template_code                 text NOT NULL,                                  -- e.g. COND_DU_VERIFY_INCOME_BASE, COND_DU_UNMAPPED_MESSAGE, COND_DELIVERY_SFC_127
  du_message_id                 text,
  du_submission_id              uuid,                                           -- 23.1 du_submissions (0084; no FK — see header)
  text                          text NOT NULL,                                  -- SM-rendered, borrower-safe needs-list wording (never DU wording / message ids) — restricted (may carry borrower names)
  internal_text                 text NOT NULL,                                  -- DU wording, kept apart from the borrower text
  category                      text NOT NULL CHECK (category IN ('income', 'employment', 'assets', 'credit', 'liabilities', 'property', 'project', 'title', 'insurance', 'mi', 'occupancy', 'identity', 'program', 'compliance', 'closing', 'funding')),
  evidence_kinds                text[] NOT NULL DEFAULT '{}',                   -- accepted verifications.kind / document classes
  auto_clear_rule               text,                                           -- rule id that may clear it without a human (23.3)
  requires_role                 text CHECK (requires_role IN ('underwriting_reviewer', 'qc_officer', 'funding_approver')),
  borrower_visible              boolean NOT NULL DEFAULT true,
  opened_at                     timestamptz NOT NULL,
  due_at                        timestamptz,
  cleared_at                    timestamptz,
  cleared_by                    text,                                           -- agent run id or user id
  clear_evidence_document_ids   uuid[] NOT NULL DEFAULT '{}',                   -- retained on supersession (T9)
  superseded_by_condition_id    uuid REFERENCES conditions(condition_id),
  superseded_by_submission_id   uuid,
  qc_sampled                    boolean NOT NULL DEFAULT false,
  retention_class               text NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'cleared' OR cleared_at IS NOT NULL),
  CHECK (source <> 'du' OR du_message_id IS NOT NULL OR template_code LIKE 'COND_DELIVERY_SFC_%')
);
COMMENT ON TABLE conditions IS '23.2/23.3 conditions ledger (addendum §3): PTD/PTF/post_closing conditions opened from DU messages (23.2), underwriter/QC/compliance/closing rules; borrower-facing `text` is SM-rendered, `internal_text` keeps the DU wording; lifecycle transitions are 23.3''s and each is a loan_events row (condition.opened / cleared / superseded / reopened). PII: text may contain borrower names — restricted. Retention fnma_loan_file_life_plus_4y.';
CREATE INDEX conditions_app_idx ON conditions (application_id, stage, status);
CREATE INDEX conditions_submission_idx ON conditions (du_submission_id) WHERE du_submission_id IS NOT NULL;
CREATE INDEX conditions_open_ptd_idx ON conditions (application_id) WHERE stage = 'ptd' AND status IN ('open', 'waiting_borrower', 'waiting_third_party', 'satisfied_pending_review', 'reopened');

-- ---------------------------------------------------------------- du_message_rules (config: DU message catalog per release; 11 new / 25 modified / 7 retired on Sept 25, 2026)
CREATE TABLE du_message_rules (
  rule_id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id                text NOT NULL,
  du_release                text NOT NULL,                                      -- e.g. 2026-09-25
  section                   text NOT NULL CHECK (section IN ('summary', 'rep_warrant_relief', 'priority_action', 'verification', 'eligibility', 'potential_red_flag', 'observation', 'validation', 'mi', 'value_acceptance', 'homeready', 'cu', 'sfc')),
  action                    text NOT NULL CHECK (action IN ('open_condition', 'open_investigation', 'record_only', 'structural_ineligible', 'offer', 'mi_requirement', 'sfc_required', 'sfc_optional')),
  condition_template_code   text,
  stage                     text CHECK (stage IN ('ptd', 'ptf', 'post_closing')),
  category                  text NOT NULL CHECK (category IN ('income', 'employment', 'assets', 'credit', 'liabilities', 'property', 'project', 'title', 'insurance', 'mi', 'occupancy', 'identity', 'program', 'compliance', 'closing', 'funding')),
  evidence_kinds            text[] NOT NULL DEFAULT '{}',
  auto_clear_rule           text,
  severity                  text NOT NULL DEFAULT 'standard' CHECK (severity IN ('critical', 'standard', 'info')),
  borrower_text             text,                                               -- SM needs-list wording for open_condition rows; partner-approved (underwriting_reviewer sign-off on the mapping table)
  reason_code               text,                                               -- structural reason / SFC / red-flag name
  lever                     text CHECK (lever IN ('loan_amount', 'term', 'product', 'occupancy_correction', 'liability_payoff', 'asset_addition', 'mi_option', 'remove_homeready', 'add_homeready', 'co_borrower_change')),
  effective_from            date NOT NULL,
  effective_to              date,
  approved_by               text,                                               -- underwriting_reviewer who signed off the mapping row
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, du_release, effective_from)
);
COMMENT ON TABLE du_message_rules IS '23.2 du_message_rules: the DU message catalog per release mapped to an action (open_condition / open_investigation / record_only / structural_ineligible / offer / mi_requirement / sfc_required / sfc_optional), condition template, stage, category and evidence; a message id with no row for its release goes to triage and opens COND_DU_UNMAPPED_MESSAGE (never dropped). Versioned per release; rows are immutable (a change is a new effective_from row).';
CREATE INDEX du_message_rules_lookup_idx ON du_message_rules (message_id, du_release);
CREATE TRIGGER du_message_rules_immutable BEFORE UPDATE OR DELETE ON du_message_rules FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- du_findings_interpretations (one per submission; immutable evidence)
CREATE TABLE du_findings_interpretations (
  interpretation_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                uuid NOT NULL REFERENCES applications(id),
  submission_id                 uuid NOT NULL,                                  -- 23.1 du_submissions (0084; no FK — see header)
  submission_number             integer NOT NULL,
  is_final                      boolean NOT NULL DEFAULT false,                 -- the final closed-loan match submission (23.1 rule 5)
  recommendation                text NOT NULL CHECK (recommendation IN ('approve_eligible', 'approve_ineligible', 'refer_with_caution', 'out_of_scope', 'error')),
  policy_generation             text NOT NULL CHECK (policy_generation IN ('pre_2026_06_27', '2026_06_27', '2026_09_26')),
  du_release                    text NOT NULL,
  policy_outcome                text NOT NULL CHECK (policy_outcome IN ('proceed', 'restructure_required', 'decline_candidate', 'out_of_policy_manual', 'error')),
  structural_reasons            jsonb NOT NULL DEFAULT '[]',                    -- eligibility messages [{message_id, reason_code, lever, text}]
  conditions_opened             integer NOT NULL DEFAULT 0,
  ptd_conditions_opened         integer NOT NULL DEFAULT 0,
  investigations_opened         integer NOT NULL DEFAULT 0,
  unmapped_messages             integer NOT NULL DEFAULT 0,
  mi_coverage_pct               numeric(5,2),
  mi_standard_coverage_pct      numeric(5,2),
  mi_min_coverage_option        boolean NOT NULL DEFAULT false,
  value_acceptance_offer        text NOT NULL DEFAULT 'none' CHECK (value_acceptance_offer IN ('none', 'value_acceptance', 'value_acceptance_pd')),
  value_acceptance_offer_at     timestamptz,
  sfc_801_permitted             boolean NOT NULL DEFAULT false,                 -- only when the offer is on the final submission (B4-1.4-10)
  homeready_message             boolean NOT NULL DEFAULT false,
  sfc_required                  text[] NOT NULL DEFAULT '{}',                   -- 127 always; 067, 900, 184, 801, 774, 808, 118, 009/014, 168, 304, 007 as applicable
  close_by_date                 date,                                           -- DU employment validation close-by date (22.3 gate)
  credit_expiration_date        date,
  relief_components             jsonb NOT NULL DEFAULT '{}',                    -- {income, employment, assets, undisclosed_debt} validated flags
  decline_candidate             boolean NOT NULL DEFAULT false,
  manual_underwriting_offered   boolean NOT NULL DEFAULT false CHECK (manual_underwriting_offered = false),   -- 23.2-Q1: never
  recommendation_drift          jsonb,                                          -- {cause, from, to, du_release, du_release_date, policy_generation}
  interpreted_at                timestamptz NOT NULL,
  agent_decision_id             uuid,                                           -- agent_decisions (0001)
  created_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id)
);
COMMENT ON TABLE du_findings_interpretations IS '23.2 du_findings_interpretations: one immutable row per DU submission — recommendation, policy outcome (Approve/Eligible only proceeds; no manual underwriting, no variances), structural reasons, counts of conditions / investigations / unmapped messages, MI coverage, value-acceptance offer (exercisable only on the final submission), SFC set, close-by date, relief components, drift record; `du.findings.interpreted` satisfies SM_DU_CONDITIONS_SLA_4H.';
CREATE INDEX du_findings_interpretations_app_idx ON du_findings_interpretations (application_id, submission_number DESC);
CREATE TRIGGER du_findings_interpretations_immutable BEFORE UPDATE OR DELETE ON du_findings_interpretations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- homeready_evaluations (B5-6-01; AMI only from DU / the AMI API / the web tool)
CREATE TABLE homeready_evaluations (
  evaluation_id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  property_fips                   text NOT NULL,
  ami_source                      text NOT NULL CHECK (ami_source IN ('du_message', 'ami_api', 'web_tool')),
  ami_annual_cents                bigint NOT NULL CHECK (ami_annual_cents > 0),
  limit_pct                       numeric(5,2) NOT NULL DEFAULT 80.00,
  income_limit_annual_cents       bigint NOT NULL,                              -- floor(ami × 80 / 100)
  qualifying_income_annual_cents  bigint NOT NULL,                              -- Σ(monthly qualifying income of all note signers) × 12; never non-borrower household income
  eligible                        boolean NOT NULL,
  ami_dataset_version             text NOT NULL,
  api_response_document_id        uuid REFERENCES documents(id),
  evaluated_at                    timestamptz NOT NULL,
  created_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE homeready_evaluations IS '23.2 homeready_evaluations: HomeReady/AMI test — qualifying income ≤ 80 % of the AMI Fannie Mae uses (DU message, AMI Lookup and HomeReady Evaluation API, or the web tool via fnma_portal_operator; never HUD/other AMIs); immutable evidence with the dataset version.';
CREATE INDEX homeready_evaluations_app_idx ON homeready_evaluations (application_id, evaluated_at DESC);
CREATE TRIGGER homeready_evaluations_immutable BEFORE UPDATE OR DELETE ON homeready_evaluations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- homeownership_education_records (B2-2-06; FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE; FNMA_B5_6_01_COUNSELING_CREDIT_12M)
CREATE TABLE homeownership_education_records (
  record_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id            uuid NOT NULL REFERENCES applications(id),
  borrower_id               uuid NOT NULL REFERENCES application_borrowers(id),
  requirement_basis         text NOT NULL CHECK (requirement_basis IN ('homeready_all_ftb', 'ltv_over_95_all_ftb', 'du_no_tradelines', 'none')),
  provider_name             text,
  provider_type             text CHECK (provider_type IN ('homeview', 'hud_approved_agency', 'nis_aligned_provider')),
  course_type               text CHECK (course_type IN ('education', 'counseling')),
  certificate_document_id   uuid REFERENCES documents(id),                      -- retained in the loan file (B2-2-06)
  completed_on              date,
  verified_at               timestamptz,
  counseling_within_12m     boolean NOT NULL DEFAULT false,                     -- SFC 184 + DU Housing Counseling data
  status                    text NOT NULL DEFAULT 'required_open' CHECK (status IN ('required_open', 'received', 'verified', 'not_required')),
  retention_class           text NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'verified' OR (certificate_document_id IS NOT NULL AND verified_at IS NOT NULL AND completed_on IS NOT NULL)),   -- never verified without the certificate document
  UNIQUE (application_id, borrower_id)
);
COMMENT ON TABLE homeownership_education_records IS '23.2 homeownership_education_records: per-borrower B2-2-06 requirement (basis: HomeReady purchase with all occupying first-time homebuyers; > 95 % LTV with all first-time homebuyers; DU purchase with no tradelines) — certificate intake (HomeView / HUD-approved agency / NIS-aligned provider), verification checks and the 12-month counseling credit flag (SFC 184). required_open → received → verified; not_required when the basis disappears.';
CREATE INDEX homeownership_education_records_app_idx ON homeownership_education_records (application_id, status);

-- ---------------------------------------------------------------- restructure_proposals (rule 7; Reg B treatment; 21.5 / 20.4 / 23.1 loop)
CREATE TABLE restructure_proposals (
  proposal_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id            uuid NOT NULL REFERENCES applications(id),
  trigger_submission_id     uuid,                                               -- 23.1 du_submissions (0084; no FK — see header); null for 22.5 dti.du_cap.exceeded / 23.4 fee_change triggers
  kind                      text NOT NULL CHECK (kind IN ('loan_amount', 'term', 'product', 'occupancy_correction', 'liability_payoff', 'asset_addition', 'mi_option', 'remove_homeready', 'add_homeready', 'co_borrower_change', 'fee_change')),
  "from"                    jsonb NOT NULL,
  "to"                      jsonb NOT NULL,
  expected_recommendation   text NOT NULL CHECK (expected_recommendation IN ('approve_eligible', 'approve_ineligible', 'refer_with_caution', 'out_of_scope', 'error')),
  expected_dti_bps          integer,
  arithmetic                jsonb NOT NULL DEFAULT '{}',                        -- P&I, MI, taxes, insurance, debts, obligations, LTV — computed before any resubmission
  regb_treatment            text NOT NULL CHECK (regb_treatment IN ('borrower_initiated', 'counteroffer', 'none')),
  initiated_by              text NOT NULL CHECK (initiated_by IN ('sm', 'borrower')),
  changed_circumstance_id   uuid,                                               -- 21.5 changed_circumstances
  status                    text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'expired')),
  proposed_at               timestamptz NOT NULL,
  decided_at                timestamptz,
  reviewer_id               text,                                               -- underwriting_reviewer approval (required before a counteroffer reaches the borrower)
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (regb_treatment <> 'counteroffer' OR status = 'proposed' OR status = 'expired' OR reviewer_id IS NOT NULL)
);
COMMENT ON TABLE restructure_proposals IS '23.2 restructure_proposals: lawful levers (loan amount, term, product, liability payoff, assets, MI option, occupancy correction with evidence, co-borrower change; 23.4''s fee_change) with the expected outcome computed from current data before resubmission; an SM-initiated change of terms is a Reg B counteroffer that needs underwriting_reviewer before borrower contact (21.6), a borrower-initiated one only 21.5''s changed-circumstance rules; expired by REGB_1002_9_COUNTEROFFER_90.';
CREATE INDEX restructure_proposals_app_idx ON restructure_proposals (application_id, status);

COMMIT;
