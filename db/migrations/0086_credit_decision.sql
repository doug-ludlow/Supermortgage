-- 0086_credit_decision.sql — 23.3 The credit decision: comprehensive risk assessment, conditional approval, condition
-- clearing (PTD/PTF), clear-to-close and the rep-and-warrant relief ledger (spec/sections/23-…/23-3-the-credit-decision-….md
-- "Data model"; addendum §3 `decisions` (0068, 21.6 — extended here, never re-created) and `rep_warrant_relief` ("per
-- component; relief type and date")). `applications` (0057) is the aggregate; `conditions` is 23.2's table (0085, in
-- flight — referenced by id, the FK is declared by a later migration once both exist); `documents` (0001/0057) and
-- `verifications` are referenced by id. State transitions are `loan_events` rows keyed by application_id
-- (decision.issued, credit_decision.recorded, condition.cleared, ptd.cleared, clear_to_close.issued, ptf.cleared,
-- decision.reopened, rep_warrant_relief.evaluated); the tables below keep the rows the process reads back and QC/MORA
-- audit. Retention: regb_25m for the notice/reasons and fnma_loan_file_life_plus_4y for the file; PII restricted.
BEGIN;

-- ───────────────────────────── decisions (0068) — the 23.3 columns of the decision of record ─────────────────────────────
-- 23.3 "adds" to 21.6's row: the DU submission / interpretation the decision rests on, the B3-1-01 risk assessment, the
-- LL-2026-04 record fields (inputs hash, evidence, rule-set / model / prompt versions, rationale, confidence), the
-- conditions snapshot the approval letter listed, the reviewer's action, validity, status and the CTC / PTF instants.
ALTER TABLE decisions
  ADD COLUMN du_submission_id        uuid,                                     -- du_submissions (0084)
  ADD COLUMN interpretation_id       uuid,                                     -- du_findings_interpretations (23.2)
  ADD COLUMN risk_assessment         jsonb,                                    -- {credit:{score_model, representative_score, history_summary}, capacity:{dti, residual_income_cents, income_sources[]}, capital:{funds_to_close_cents, reserves_months}, collateral:{ltv, cltv, hcltv, valuation_method, cu_score}, layering[], du_risk_factors[], cash_flow_assessment}
  ADD COLUMN inputs_hash             bytea,                                    -- sha256(ULAD snapshot hash + verification ids + findings hash)
  ADD COLUMN evidence_document_ids   uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN rule_set_versions       jsonb,                                    -- {fnma.selling, fnma.du, regb, regz.qm, jurisdiction}
  ADD COLUMN model_version           text,
  ADD COLUMN prompt_version          text,
  ADD COLUMN rationale               text,
  ADD COLUMN confidence              numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  ADD COLUMN conditions_snapshot     jsonb NOT NULL DEFAULT '[]',              -- borrower-facing conditions listed on NTC_REGB_1002_9_APPROVAL
  ADD COLUMN reviewer_action         text CHECK (reviewer_action IS NULL OR reviewer_action IN ('approved', 'modified', 'rejected')),
  ADD COLUMN reviewer_at             timestamptz,
  ADD COLUMN valid_until             date,                                     -- min(credit expiration, lock expiration, valuation expiry, DU close-by date, 90 days) — SM_UW_DECISION_VALIDITY anchor
  ADD COLUMN validity_component      text,                                     -- which component set valid_until (credit_expiration | lock_expiration | valuation_expiry | du_close_by | 90_day_cap)
  ADD COLUMN status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'reopened', 'withdrawn')),
  ADD COLUMN regb_notice_kind        text NOT NULL DEFAULT 'none' CHECK (regb_notice_kind IN ('approval', 'counteroffer', 'adverse_action', 'noia', 'none')),
  ADD COLUMN ctc_at                  timestamptz,
  ADD COLUMN ctc_checklist_id        text,
  ADD COLUMN ptf_cleared_at          timestamptz,
  ADD COLUMN reopen_cause            text CHECK (reopen_cause IS NULL OR reopen_cause IN ('contradictory_information', 'worse_du_recommendation', 'valid_until_expired', 'compliance_test_failed', 'prefunding_qc_defect', 'ineligible_change'));
COMMENT ON COLUMN decisions.risk_assessment IS '23.3 rule 1: B3-1-01 evaluation (equity investment, credit history, liquid reserves, reliable and recurring income, layering) recorded even when DU approves; never overrides an Approve/Eligible (23.3-Q1); never derived from applicant_demographics.';
COMMENT ON COLUMN decisions.valid_until IS '23.3 rule 2 / Q5: min(credit_reports.expires_at, locks.expires_at, valuation expiry, DU close-by date, issuance + 90 days); SM_UW_DECISION_VALIDITY breach → decision.reopened.';

-- ───────────────────────────── condition_clearances ─────────────────────────────
-- One row per clearance of a 23.2 condition: who cleared (agent for auto-clear rules (a)–(d); underwriting_reviewer for
-- requires_role / pending review / reopened-then-cleared inside 3 BD of closing; qc_officer never; funding_approver
-- funding-stage only), the Selling Guide topic + DU documentation level applied (standard_ref), the evidence and the
-- B1-1-03 age results per document. Append-only: a reversal is recorded on the row (reversed_at / reversal_reason set by
-- a later transaction) and the condition is reopened — the clearance itself is never deleted.
CREATE TABLE condition_clearances (
  clearance_id                text PRIMARY KEY,
  condition_id                text NOT NULL,                                   -- conditions.condition_id (23.2, 0085)
  application_id              uuid NOT NULL REFERENCES applications(id),
  cleared_by_kind             text NOT NULL CHECK (cleared_by_kind IN ('agent', 'underwriting_reviewer', 'qc_officer', 'funding_approver')),
  cleared_by_id               text NOT NULL,
  standard_ref                text NOT NULL,                                   -- e.g. B3-3.2-01/DU:paystub_30d_w2_1y
  evidence_document_ids       uuid[] NOT NULL DEFAULT '{}',
  evidence_verification_ids   uuid[] NOT NULL DEFAULT '{}',
  age_check                   jsonb NOT NULL DEFAULT '[]',                     -- [{document_id, kind, document_date, expires_on, note_date, pass, rule}] (B1-1-03)
  cleared_at                  timestamptz NOT NULL,
  notes                       text,
  qc_sample_flag              boolean NOT NULL DEFAULT false,
  reversed_at                 timestamptz,
  reversal_reason             text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT condition_clearances_qc_never_clears CHECK (cleared_by_kind <> 'qc_officer'),
  CONSTRAINT condition_clearances_reversal_reasoned CHECK (reversed_at IS NULL OR reversal_reason IS NOT NULL)
);
CREATE INDEX condition_clearances_condition_idx ON condition_clearances(condition_id, cleared_at);
CREATE INDEX condition_clearances_application_idx ON condition_clearances(application_id, cleared_at);
CREATE TRIGGER condition_clearances_never_deleted BEFORE DELETE ON condition_clearances FOR EACH ROW EXECUTE FUNCTION forbid_delete();
COMMENT ON TABLE condition_clearances IS '23.3 rule 3: one row per condition clearance — who cleared (qc_officer never: independence, D1-2-01), the Selling Guide topic + DU documentation level applied (B3-2-04: a more comprehensive level is always acceptable), evidence document / verification ids and the B1-1-03 age test per document at the projected note date; reversals are recorded, never deleted. Read by QC (28.1) and MORA.';

-- ───────────────────────────── ctc_checklists ─────────────────────────────
-- One row per evaluation of the clear-to-close criteria (rule 5): every item {code, owner_process, status ∈ {pass,
-- fail, waived, n/a}, evidence_ref}; passed iff every item pass / n/a (waived requires underwriting_reviewer);
-- CTC_REGB_TIMING is informational; CTC_QC_PREFUNDING surfaces 28.1's FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE as
-- the item SM_QC_PREFUNDING_HOLD. Append-only: the checklist is re-run continuously; each run is a new row.
CREATE TABLE ctc_checklists (
  checklist_id                text PRIMARY KEY,
  application_id              uuid NOT NULL REFERENCES applications(id),
  decision_id                 text NOT NULL REFERENCES decisions(decision_id),
  evaluated_at                timestamptz NOT NULL,
  items                       jsonb NOT NULL,                                  -- [{code, owner_process, status, evidence_ref, item_alias, blocking}]
  passed                      boolean NOT NULL,
  blocking_codes              text[] NOT NULL DEFAULT '{}',
  waived_by                   text,                                            -- the underwriting_reviewer who waived any item
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ctc_checklists_passed_means_no_block CHECK ((passed AND cardinality(blocking_codes) = 0) OR (NOT passed AND cardinality(blocking_codes) > 0))
);
CREATE INDEX ctc_checklists_application_idx ON ctc_checklists(application_id, evaluated_at);
CREATE TRIGGER ctc_checklists_immutable BEFORE UPDATE OR DELETE ON ctc_checklists FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE ctc_checklists IS '23.3 rule 5: the clear-to-close criteria per run — CTC_DU_FINAL_MATCH, CTC_PTD_ALL_CLEARED, CTC_NO_OPEN_INVESTIGATION, CTC_CREDIT_VALID, CTC_DU_CLOSE_BY, CTC_ASSETS_CASH_TO_CLOSE, CTC_VALUATION, CTC_PROPERTY_PROJECT, CTC_TITLE, CTC_INSURANCE_FLOOD, CTC_MI, CTC_COMPLIANCE, CTC_EDUCATION, CTC_LOCK, CTC_IDENTITY_OFAC, CTC_QC_PREFUNDING (SM_QC_PREFUNDING_HOLD), CTC_MLO_APPROVALS, CTC_REGB_TIMING (informational), CTC_DECISION_VALID; clear_to_close.issued only on passed = true (SM_UW_CTC_GATE). Append-only.';

-- ───────────────────────────── rep_warrant_relief (addendum §3) ─────────────────────────────
-- The relief ledger per component (A2-2-04 limited waiver and Day 1 Certainty; SEL-2025-09 undisclosed debt; Income
-- Calculator; A2-2-06 value acceptance / CU ≤ 2.5; A2-3.2-02 payment history): basis, whether the conditions are met, the
-- close-by / credit-expiration dates that bound it, status (eligible → at_risk when a closing moves past the date →
-- lost when it passes; confirmed_by_fnma only from Fannie Mae's relief reports, 28.2/30.4) and the confirmation instant.
-- Evaluated at CTC and again at funding; the 36-payment component opens at purchase (30.1) on the loans row.
CREATE TABLE rep_warrant_relief (
  relief_id                   text PRIMARY KEY,
  application_id              uuid NOT NULL REFERENCES applications(id),
  loan_id                     uuid REFERENCES loans(id),                       -- set from purchase (payment_history_36) / 30.2 boarding
  component                   text NOT NULL CHECK (component IN ('limited_waiver_du', 'income_validated', 'employment_validated', 'assets_validated', 'undisclosed_debt', 'income_calculator', 'value_acceptance', 'cu_score_2_5', 'payment_history_36')),
  basis_ref                   text NOT NULL,                                   -- DU message id / Selling Guide section
  conditions_met              boolean NOT NULL,
  close_by_date               date,                                            -- Day 1 Certainty "Close by Date" (22.3)
  credit_expiration_date      date,                                            -- undisclosed-debt relief bound (22.2)
  status                      text NOT NULL CHECK (status IN ('eligible', 'at_risk', 'lost', 'confirmed_by_fnma', 'not_applicable')),
  target_date                 date,                                            -- payment_history_36: the 36th monthly payment due date
  evaluated_at                timestamptz NOT NULL,
  confirmed_at                timestamptz,                                     -- from Fannie Mae relief reports (28.2 / 30.4 / 29.4)
  notes                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rep_warrant_relief_confirmed_has_instant CHECK (status <> 'confirmed_by_fnma' OR confirmed_at IS NOT NULL),
  CONSTRAINT rep_warrant_relief_one_per_component UNIQUE (application_id, component)
);
CREATE INDEX rep_warrant_relief_application_idx ON rep_warrant_relief(application_id);
CREATE TRIGGER rep_warrant_relief_never_deleted BEFORE DELETE ON rep_warrant_relief FOR EACH ROW EXECUTE FUNCTION forbid_delete();
COMMENT ON TABLE rep_warrant_relief IS '23.3 rule 7 / addendum §3: the rep-and-warrant relief ledger per component — limited_waiver_du (A2-2-04: Approve/Eligible, messages resolved, SFC 127, accurate data), income/employment/assets_validated (Day 1 Certainty; close by the Close by Date), undisclosed_debt (SEL-2025-09; close by the credit expiration date; mortgage-related debt excluded), income_calculator, value_acceptance / cu_score_2_5 (A2-2-06), payment_history_36 (A2-3.2-02: 36 payments after the acquisition date, ≤ two 30-day, no 60-day). Status flips to at_risk / lost as a closing moves past a bounding date; confirmed_by_fnma only from Fannie Mae reports (28.2/30.4). A2-2-07 life-of-loan matters survive every relief.';

COMMIT;
