-- 0033: §14.4 data model — the columns the bankruptcy feed writes on `bankruptcy_reporting_state`
-- (0010/0016) that the runtime row (src/domain/bankruptcy/ops-14-4.ts ReportingStateRow) carries and
-- the table did not: the surrender/lien-avoidance treatment that derives `debt_discharged` (rule 4),
-- the discharge order the `debt_discharged=true` guardrail requires (distinct from the phase event's
-- evidence document), the versioned rule set the decision record names (`bk.credit_feed.v1; crrg.2026`),
-- and the retraction tombstone of a same-name false match (rule 10, T8): the PK row is never deleted —
-- it is marked `retracted` (8.3 reads it as "no active row") with the reversal date, reason and evidence,
-- and `bankruptcy_reporting_state_history` keeps every version (state-row history with docket evidence).
BEGIN;

ALTER TABLE bankruptcy_reporting_state
  ADD COLUMN IF NOT EXISTS surrendered                 boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS discharge_order_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS rule_set_version            text NOT NULL DEFAULT 'bk.credit_feed.v1; crrg.2026',
  ADD COLUMN IF NOT EXISTS retracted                   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retracted_on                date,
  ADD COLUMN IF NOT EXISTS retraction_reason           text CHECK (retraction_reason IS NULL OR retraction_reason IN ('false_match'));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bankruptcy_reporting_state_retraction_chk') THEN
    ALTER TABLE bankruptcy_reporting_state ADD CONSTRAINT bankruptcy_reporting_state_retraction_chk CHECK (NOT retracted OR (retracted_on IS NOT NULL AND retraction_reason IS NOT NULL));
  END IF;
END $$;

COMMENT ON COLUMN bankruptcy_reporting_state.surrendered IS '§14.4 rule 4: surrender / lien avoidance carried on the plan or discharge event — with a discharge the debt is discharged (CII H)';
COMMENT ON COLUMN bankruptcy_reporting_state.discharge_order_document_id IS '§14.4 guardrail: debt_discharged=true requires the discharge order document';
COMMENT ON COLUMN bankruptcy_reporting_state.rule_set_version IS '§14.4 decision record: rule_set_version (bk.credit_feed.v1; crrg.2026)';
COMMENT ON COLUMN bankruptcy_reporting_state.retracted IS '§14.4 rule 10 / T8: a same-name false match reversed by 14.1 — no active row survives; the PK row is a tombstone, never deleted';

-- Append-only history: every version of a filer's row with its evidence document (the audit section's
-- "state-row history with docket evidence hashes"; reconciliation of furnished CII against phases per cycle).
CREATE TABLE IF NOT EXISTS bankruptcy_reporting_state_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  borrower_id           uuid NOT NULL REFERENCES borrowers(id),
  version               int NOT NULL,
  row_data              jsonb NOT NULL,
  evidence_document_id  uuid REFERENCES documents(id),
  trigger_event_id      uuid,
  written_by            text NOT NULL,
  written_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, borrower_id, version)
);
CREATE OR REPLACE FUNCTION bankruptcy_reporting_state_history_append() RETURNS trigger AS $$
BEGIN
  INSERT INTO bankruptcy_reporting_state_history (loan_id, borrower_id, version, row_data, evidence_document_id, written_by)
  VALUES (NEW.loan_id, NEW.borrower_id,
          COALESCE((SELECT max(version) FROM bankruptcy_reporting_state_history h WHERE h.loan_id = NEW.loan_id AND h.borrower_id = NEW.borrower_id), 0) + 1,
          to_jsonb(NEW), NEW.evidence_document_id, current_user);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS bankruptcy_reporting_state_history_trg ON bankruptcy_reporting_state;
CREATE TRIGGER bankruptcy_reporting_state_history_trg AFTER INSERT OR UPDATE ON bankruptcy_reporting_state
  FOR EACH ROW EXECUTE FUNCTION bankruptcy_reporting_state_history_append();
CREATE OR REPLACE FUNCTION bankruptcy_reporting_state_history_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'bankruptcy_reporting_state_history is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS bankruptcy_reporting_state_history_immutable_trg ON bankruptcy_reporting_state_history;
CREATE TRIGGER bankruptcy_reporting_state_history_immutable_trg BEFORE UPDATE OR DELETE ON bankruptcy_reporting_state_history
  FOR EACH ROW EXECUTE FUNCTION bankruptcy_reporting_state_history_immutable();

COMMIT;
