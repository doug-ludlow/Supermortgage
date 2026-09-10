-- 0053_records_lifecycle.sql — Section 19.1: the record-object lifecycle evaluates every class of the object's record type
-- (rule 1, max rule), so `record_objects` carries its per-class anchors, applicability facts and the last sweep's gate
-- outcomes; production approvals, hold reviews, inventory reviews, FTC disposal exceptions and drill results are
-- append-only tables of their own (the events that satisfy the timer rows); `records_requests` gains the state
-- machine's `refused` branch and the requester types it refuses. Append-only: constraints are replaced, never edited.
BEGIN;

-- record_objects: per-class anchors and the applicability facts the sweep reads (ops-19-1.ts objectEligibility)
ALTER TABLE record_objects
  ADD COLUMN IF NOT EXISTS anchors jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS applicable_class_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS gate_outcomes jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS fdcpa_debt_collector boolean,
  ADD COLUMN IF NOT EXISTS regz_disclosure boolean,
  ADD COLUMN IF NOT EXISTS jurisdiction_years int,
  ADD COLUMN IF NOT EXISTS schedule_version text NOT NULL DEFAULT 'v1';
COMMENT ON COLUMN record_objects.anchors IS '19.1 rule 1: anchor date per applicable retention class (null until the anchor event fires): liquidated_on, discharged_on, transferred_out_on, final_entry_on, last_collection_activity_on, notified_on, enforcement_notice_received_on, investigation_closed_on, revoked_on, last_reliance_on, filed_on, disclosure_due_date, call_on, record_on, form_due_date, last_use_on, created_on';
COMMENT ON COLUMN record_objects.applicable_class_codes IS '19.1 records.classify: the record type''s classes after the NY 419.9 (NY loans), Reg F (a) (fdcpa_debt_collector) and Reg Z (regz_disclosure) applicability facts';
COMMENT ON COLUMN record_objects.gate_outcomes IS '19.1 retention-sweep: [{class_code, timer_code, open, opens_on, reason}] from the last sweep — the planner''s decision record gates_checked[] / exceptions[]';
COMMENT ON COLUMN record_objects.jurisdiction_years IS '19.1 jurisdiction_overrides: the longer local period applied to the Fannie Mae 4-year class (unknown states default to the longest known)';

-- disposal_runs: the decision record of rule 7
ALTER TABLE disposal_runs
  ADD COLUMN IF NOT EXISTS gates_checked text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS holds_checked boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS exceptions jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS manifest_sha256 text;
COMMENT ON COLUMN disposal_runs.exceptions IS '19.1 decision record exceptions[]: [{object_id, reason}] — every object excluded from the run with its gate reason';

-- records_requests: the state machine''s refused branch and the requester types it refuses (unsigned borrower, unauthorized third party)
ALTER TABLE records_requests DROP CONSTRAINT IF EXISTS records_requests_requester_type_check;
ALTER TABLE records_requests ADD CONSTRAINT records_requests_requester_type_check
  CHECK (requester_type IN ('fannie_mae','partner','regulator_state','regulator_federal','transferee_servicer','court_subpoena','mi_company','custodian','auditor','law_enforcement','borrower','third_party'));
ALTER TABLE records_requests DROP CONSTRAINT IF EXISTS records_requests_status_check;
ALTER TABLE records_requests ADD CONSTRAINT records_requests_status_check
  CHECK (status IN ('received','scoped','compiling','qa_redaction','awaiting_certification','delivered','closed','refused','rerouted'));
ALTER TABLE records_requests
  ADD COLUMN IF NOT EXISTS refusal_reason text,
  ADD COLUMN IF NOT EXISTS attorney_review_escalation_id uuid REFERENCES escalations(id),
  ADD COLUMN IF NOT EXISTS new_requester_identity boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS authority_confidence numeric(4,3),
  ADD COLUMN IF NOT EXISTS production_requires text[] NOT NULL DEFAULT '{}';
CREATE OR REPLACE FUNCTION records_requests_refused_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'refused' AND (NEW.refusal_reason IS NULL OR NEW.attorney_review_escalation_id IS NULL) THEN
    RAISE EXCEPTION 'records_requests: a refused request carries its refusal reason and the attorney review';
  END IF;
  IF NEW.status = 'delivered' AND OLD.status = 'refused' THEN RAISE EXCEPTION 'records_requests: a refused request is never delivered'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER records_requests_refused_guard BEFORE INSERT OR UPDATE ON records_requests FOR EACH ROW EXECUTE FUNCTION records_requests_refused_guard();

-- production approvals (append-only): `records.request.approved{kind}` by a human of the role the escalation paragraph names
CREATE TABLE records_request_approvals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id            uuid NOT NULL REFERENCES records_requests(id),
  kind                  text NOT NULL CHECK (kind IN ('attorney_approval','officer_sign_off','officer_confirmation','authority_verified')),
  approved_by           text NOT NULL,
  approved_by_role      text NOT NULL CHECK (approved_by_role IN ('attorney','officer')),
  confidence            numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  rationale             text NOT NULL,
  event_id              uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  retention             retention_class NOT NULL DEFAULT 'corporate_7y',
  CONSTRAINT records_request_approvals_role_matches_kind CHECK (
    (kind = 'attorney_approval' AND approved_by_role = 'attorney') OR
    (kind IN ('officer_sign_off','officer_confirmation') AND approved_by_role = 'officer') OR
    (kind = 'authority_verified' AND confidence IS NOT NULL))
);
CREATE INDEX records_request_approvals_request_idx ON records_request_approvals(request_id);
CREATE TRIGGER records_request_approvals_immutable BEFORE UPDATE OR DELETE ON records_request_approvals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- legal hold reviews (append-only): SM_LEGAL_HOLD_REVIEW_180 is satisfied by `legal_hold.reviewed`; a review never releases
CREATE TABLE legal_hold_reviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id               uuid NOT NULL REFERENCES legal_holds(id),
  reviewed_at           timestamptz NOT NULL DEFAULT now(),
  reviewed_by           text NOT NULL,
  outcome               text NOT NULL CHECK (outcome IN ('continue','release_recommended')),
  matter_status         text NOT NULL,
  next_review_at        timestamptz NOT NULL,
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX legal_hold_reviews_hold_idx ON legal_hold_reviews(hold_id);
CREATE TRIGGER legal_hold_reviews_immutable BEFORE UPDATE OR DELETE ON legal_hold_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE legal_holds ADD COLUMN IF NOT EXISTS last_reviewed_at timestamptz;

-- annual records-inventory reviews (append-only): SM_RECORDS_INVENTORY_REVIEW_365 is satisfied by `records_inventory.reviewed`
CREATE TABLE records_inventory_reviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewed_on           date NOT NULL,
  reviewed_by           text NOT NULL,
  reviewed_count        int NOT NULL,
  gaps                  jsonb NOT NULL DEFAULT '[]',
  schedule_version      text NOT NULL,
  rule_set_version      text NOT NULL,
  guide_watch_diff      jsonb NOT NULL DEFAULT '[]',
  memo_document_id      uuid REFERENCES documents(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE TRIGGER records_inventory_reviews_immutable BEFORE UPDATE OR DELETE ON records_inventory_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- FTC 314.4(c)(6) documented exceptions (append-only): `record_object.disposal_excepted` cancels the two-year clock with the documentation as its reason
CREATE TABLE disposal_exceptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_object_id      uuid NOT NULL REFERENCES record_objects(id),
  timer_code            text NOT NULL DEFAULT 'FTC_314_4C6_DISPOSAL_2Y_POST_LAST_USE',
  kind                  text NOT NULL CHECK (kind IN ('legal_requirement','business_need','infeasible')),
  detail                text NOT NULL CHECK (length(btrim(detail)) > 0),
  documented_by         text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX disposal_exceptions_object_idx ON disposal_exceptions(record_object_id);
CREATE TRIGGER disposal_exceptions_immutable BEFORE UPDATE OR DELETE ON disposal_exceptions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- monthly servicing-file drills (CTL-REC-01): 25 random loans, each compiled by the tool; the row's satisfying event is the 25th compile
CREATE TABLE servicing_file_drills (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drill_id              text NOT NULL UNIQUE,
  run_on                date NOT NULL,
  control               text NOT NULL DEFAULT 'CTL-REC-01',
  sample_size           int NOT NULL,
  population            int NOT NULL,
  sample                text[] NOT NULL,
  passed                boolean NOT NULL,
  failures              jsonb NOT NULL DEFAULT '[]',
  qc_finding_process    text CHECK (qc_finding_process IS NULL OR qc_finding_process = '18.1'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  retention             retention_class NOT NULL DEFAULT 'corporate_7y'
);
ALTER TABLE servicing_file_snapshots
  ADD COLUMN IF NOT EXISTS drill_id text REFERENCES servicing_file_drills(drill_id),
  ADD COLUMN IF NOT EXISTS drill_index int,
  ADD COLUMN IF NOT EXISTS within_target boolean,
  ADD COLUMN IF NOT EXISTS gaps jsonb NOT NULL DEFAULT '[]';
COMMENT ON COLUMN servicing_file_snapshots.compile_ms IS '19.1 rule 5: the compile handler''s own measured wall-clock (target ≤ 5 minutes); never a caller-supplied figure';

COMMIT;
