-- 0068 — §21.6 Application-status decisions: decisions (baseline addendum §3, enum extended per 21.6 blueprint-defect 8),
-- adverse_actions (principal reasons with sources; FCRA block per applicant; Colorado ADMT record), noias (§1002.9(c)(2)),
-- withdrawals (express only for HMDA code 4), hmda_records (28.3 owns the LAR; 21.6 writes action taken / date / denial reasons).
-- Append-only where the spec says so: withdrawals are the borrower's verbatim statement (never edited); decisions, adverse_actions
-- and noias are never deleted (later columns — reviewer, notice, HMDA, Colorado progress — are set by later transactions).
BEGIN;

ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'hmda_3y';       -- 12 CFR 1003.5(a)(1): LAR retained 3 years
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'co_admt_3y';    -- C.R.S. 6-1-1703: not less than three years after the consequential decision

CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME; END $$;

-- ───────────────────────────── decisions (addendum §3; 21.6 data model) ─────────────────────────────
CREATE TABLE decisions (
  decision_id               text PRIMARY KEY,
  application_id            uuid NOT NULL REFERENCES applications(id),
  kind                      text NOT NULL CHECK (kind IN ('conditional_approval', 'approval', 'counteroffer', 'denial', 'incomplete', 'withdrawal', 'file_closed_incomplete', 'approved_not_accepted')),
  recommended_at            timestamptz NOT NULL,                     -- the agent's proposal (decision.recommended)
  decided_at                timestamptz,                              -- the reviewer's approval for adverse kinds; the recommendation instant for approvals
  basis_component           text NOT NULL CHECK (basis_component IN ('rules', 'judgmental', 'combined', 'automatic_denial_factor')),
  decision_factors          jsonb NOT NULL DEFAULT '[]',              -- [{rule_id, description, threshold, observed, applicant_ids[], evidence_document_ids[], failed}]
  reasons                   jsonb NOT NULL DEFAULT '[]',              -- ECOA reason codes + narrative (addendum §3)
  counteroffer_terms        jsonb,                                    -- {loan_amount_cents, note_rate, product_code, ltv, conditions[], expires_on}
  combined_notice           boolean NOT NULL DEFAULT false,           -- C-4 used (comment 9(a)(1)-6)
  reviewer_escalation_id    uuid,
  reviewer_id               text,                                     -- the named underwriting_reviewer (partner or delegated SM staff)
  reviewer_decided_at       timestamptz,
  reviewer_outcome          text CHECK (reviewer_outcome IN ('approved', 'returned')),
  reviewer_sla_due_on       date,
  decided_by                text,                                     -- agent run / reviewer (addendum §3)
  notice_id                 uuid,
  sent_at                   timestamptz,
  hmda_action_taken         int CHECK (hmda_action_taken BETWEEN 1 AND 8),
  hmda_action_taken_date    date,
  after_conditional_approval boolean NOT NULL DEFAULT false,
  du_recommendation         text CHECK (du_recommendation IN ('approve_eligible', 'approve_ineligible', 'refer_with_caution', 'out_of_scope', 'error')),
  data_sufficient           boolean NOT NULL DEFAULT true,            -- comment 9(a)(1)-4: incompleteness is a reason only when a decision could not be made
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- state-machine guard: every denial, counteroffer and NOIA carries the reviewer's decision before it is sent
  CONSTRAINT decisions_reviewed_before_sent CHECK (kind NOT IN ('denial', 'counteroffer', 'incomplete') OR sent_at IS NULL OR reviewer_decided_at IS NOT NULL)
);
COMMENT ON TABLE decisions IS '21.6 / addendum §3: one row per credit decision, NOIA, withdrawal or closure; kind extended with file_closed_incomplete and approved_not_accepted; adverse kinds require reviewer_decided_at before sent_at.';
CREATE INDEX decisions_application_idx ON decisions(application_id, recommended_at);
CREATE TRIGGER decisions_never_deleted BEFORE DELETE ON decisions FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ───────────────────────────── adverse_actions ─────────────────────────────
CREATE TABLE adverse_actions (
  adverse_action_id         text PRIMARY KEY,
  application_id            uuid NOT NULL REFERENCES applications(id),
  decision_id               text NOT NULL REFERENCES decisions(decision_id),
  kind                      text NOT NULL CHECK (kind IN ('denial', 'denial_incomplete', 'counteroffer_not_accepted', 'denial_after_counteroffer', 'counteroffer')),
  principal_reasons         jsonb NOT NULL DEFAULT '[]',              -- ordered; ≤ 4; [{reason_code, statement_text, factor_ref, source, hmda_denial_code}]
  per_applicant             jsonb NOT NULL DEFAULT '[]',              -- [{applicant_id, notice_id, fcra_block{cra[], score, score_range_low, score_range_high, key_factors[], score_date, score_provider, model}, delivery}]
  federal_agency_block      text NOT NULL,                            -- FTC text (Appendix A item 9) or CFPB (item 1)
  state_overlays            text[] NOT NULL DEFAULT '{}',
  co_admt                   jsonb,                                    -- {pre_use_notice_id, explanation_due_at, explanation_notice_id, explanation_sent_at, human_review_requested_at, human_review_reviewer_id, human_review_completed_at, human_review_outcome, correction_requested_at, correction_completed_at}
  reviewer_escalation_id    uuid,
  approved_by_reviewer_at   timestamptz,
  approving_reviewer_id     text,
  sent_at                   timestamptz,
  retention_class           text[] NOT NULL DEFAULT '{regb_25m,fnma_loan_file_life_plus_4y}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adverse_actions_reasons_max4 CHECK (jsonb_array_length(principal_reasons) BETWEEN 0 AND 4),
  CONSTRAINT adverse_actions_approved_before_sent CHECK (sent_at IS NULL OR (approved_by_reviewer_at IS NOT NULL AND approved_by_reviewer_at <= sent_at))
);
COMMENT ON TABLE adverse_actions IS '21.6: the ECOA/FCRA adverse action record — principal reasons with sources (comments 9(b)(2)-1 to -9), one FCRA §615(a) block per applicant, the Federal agency block, state overlays and the Colorado SB 26-189 ADMT record; approved_by_reviewer_at precedes sent_at.';
CREATE INDEX adverse_actions_application_idx ON adverse_actions(application_id);
CREATE TRIGGER adverse_actions_never_deleted BEFORE DELETE ON adverse_actions FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ───────────────────────────── noias (§1002.9(c)(2)) ─────────────────────────────
CREATE TABLE noias (
  noia_id                   text PRIMARY KEY,
  application_id            uuid NOT NULL REFERENCES applications(id),
  decision_id               text NOT NULL REFERENCES decisions(decision_id),
  items_needed              jsonb NOT NULL DEFAULT '[]',              -- [{item, description}]
  designated_period_days    int NOT NULL DEFAULT 14 CHECK (designated_period_days >= 10),
  sent_at                   timestamptz,
  sent_on                   date,
  response_due_on           date,
  oral_request_at           timestamptz,                              -- comment 9(c)(3)-1: an oral request alone never satisfies the clock
  responded_at              timestamptz,
  closed_at                 timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT noias_items_present CHECK (jsonb_array_length(items_needed) >= 1)
);
COMMENT ON TABLE noias IS '21.6: notice of incompleteness — the information needed, the designated period (default 14, ≥ 10 by policy), response_due_on = sent_on + period; an unanswered NOIA closes the file for incompleteness (HMDA 5).';
CREATE INDEX noias_application_idx ON noias(application_id);
CREATE TRIGGER noias_never_deleted BEFORE DELETE ON noias FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ───────────────────────────── withdrawals (express only) ─────────────────────────────
CREATE TABLE withdrawals (
  withdrawal_id             text PRIMARY KEY,
  application_id            uuid NOT NULL REFERENCES applications(id),
  received_at               timestamptz NOT NULL,
  received_on               date NOT NULL,
  channel                   text NOT NULL,                            -- voice | chat | web | email | mail | in_person
  statement_text            text NOT NULL,                            -- the borrower's words, verbatim
  evidence_document_id      uuid REFERENCES documents(id),
  express                   boolean NOT NULL,                         -- must be true to use HMDA code 4 (comment 4(a)(8)(i)-5)
  after_decision            boolean NOT NULL DEFAULT false,           -- comment 4(a)(8)(i)-4: still the decision
  created_at                timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE withdrawals IS '21.6: an express withdrawal captured verbatim (any channel); silence is never a withdrawal; append-only.';
CREATE INDEX withdrawals_application_idx ON withdrawals(application_id);
CREATE TRIGGER withdrawals_immutable BEFORE UPDATE OR DELETE ON withdrawals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── hmda_records (28.3 owns the LAR; 21.6 writes action taken) ─────────────────────────────
CREATE TABLE hmda_records (
  application_id            uuid PRIMARY KEY REFERENCES applications(id),
  loan_id                   uuid REFERENCES loans(id),
  uli                       text,                                     -- ULI assigned at application (28.3); partner LEI prefix
  reporter_lei              text,
  action_taken              int CHECK (action_taken BETWEEN 1 AND 8), -- FIG 2026: 1 originated … 5 closed for incompleteness … 8 preapproval approved not accepted
  action_taken_date         date,
  denial_reason_1           int CHECK (denial_reason_1 BETWEEN 1 AND 10 OR denial_reason_1 = 1111),
  denial_reason_2           int,
  denial_reason_3           int,
  denial_reason_4           int,
  denial_reason_other_text  text CHECK (denial_reason_other_text IS NULL OR char_length(denial_reason_other_text) <= 255),
  action_basis              text,                                     -- the mapping rationale (comments 4(a)(8)(i)-3 to -13)
  written_by_process        text NOT NULL DEFAULT '21.6',
  final_action_quarter_end  date,                                     -- §1003.4(f): LAR entry within 30 calendar days after the quarter end (28.3)
  retention_class           retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hmda_denial_reasons_only_on_denial CHECK (action_taken = 3 OR denial_reason_1 IS NULL)
);
COMMENT ON TABLE hmda_records IS '28.3 HMDA store (12 CFR 1003.4(a)(8), (a)(16)); 21.6 writes action_taken, action_taken_date and denial_reason_1..4 / other text in the same transaction as the terminal disposition — exactly one action code per terminal application.';

COMMIT;
