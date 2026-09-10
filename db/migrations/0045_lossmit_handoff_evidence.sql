-- 17.4 Loss-mit in-flight transfer: the evidence the handoff tools persist that 0019 had no home for.
-- (a) `lossmit_reviewer_approvals` — the approval record a `lossmit_reviewer` writes before an adverse determination issues
--     before T (17.4 escalations: reviewer ≠ evaluator per §1024.41(h)(3); Colorado AI Act / LL-2026-04). `draftDetermination`
--     verifies the record by id, case and outcome; append-only like every decision table.
-- (b) `case_handoffs` — the per-case evidence `packageCase` records: the transferee's acknowledgment reference and party,
--     the 5-BD cure (resolved_at, cure_document_id), the documented deficiencies, the sale-window flag and the measured
--     pre-T work-down state that the batch roll-ups (SM_LOSSMIT_PRE_T_WORKDOWN_T1, SM_LOSSMIT_HANDOFF_FILE_1) read.
CREATE TABLE lossmit_reviewer_approvals (
  id                    text PRIMARY KEY,
  case_id               uuid NOT NULL REFERENCES cases(id),
  outcome               text NOT NULL CHECK (outcome IN ('denial','offer','appeal_denied','appeal_granted')),
  evaluator_id          text NOT NULL,
  reviewer_id           text NOT NULL,
  reviewer_role         text,
  approved_on           date NOT NULL,
  escalation_id         text,
  evidence_document_id  uuid REFERENCES documents(id),
  at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lossmit_reviewer_separation CHECK (reviewer_id <> evaluator_id)
);
CREATE INDEX lossmit_reviewer_approvals_case ON lossmit_reviewer_approvals(case_id);
CREATE TRIGGER lossmit_reviewer_approvals_immutable BEFORE UPDATE OR DELETE ON lossmit_reviewer_approvals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE case_handoffs
  ADD COLUMN sale_within_45_days   boolean,
  ADD COLUMN ack_reference         text,
  ADD COLUMN acked_by              text,
  ADD COLUMN resolved_at           timestamptz,
  ADD COLUMN cure_document_id      uuid REFERENCES documents(id),
  ADD COLUMN deficiencies          jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN pre_transfer_workdown text CHECK (pre_transfer_workdown IN ('documented','undocumented'));
