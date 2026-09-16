-- 0146_installments_schedule.sql — §35.5 "The installment schedule and the daily cashiering cycle", data model rows 1–2:
-- `loan_installments` (2.1's projection, extended: sequence, the UPB before/after, the rate and terms the row was
-- projected under, the run that wrote it, the satisfying payment, the rounding flag) and `installment_schedule_runs`
-- (append-only; one row per schedule written at boarding or re-projected on a terms change; retention class
-- `life_of_loan_plus_4y`, the file default; no PII — ids, dates and cents only).
--
-- The state machine moves exactly `status`, `satisfied_on`, `credited_as_of`, `satisfied_by_payment_id`,
-- `late_charge_state` and `updated_at`; a trigger refuses any other UPDATE on a `satisfied` row (SATISFIED_ROW_FROZEN)
-- and every DELETE — a reprojection replaces `due` rows by INSERT … ON CONFLICT on the primary key and records the
-- prior values in `installment_schedule_runs.replaced`.
BEGIN;

CREATE TABLE installment_schedule_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                  uuid NOT NULL REFERENCES loans(id),
  terms_id                 uuid REFERENCES loan_terms(id),
  source                   text NOT NULL CHECK (source IN ('fund', 'transfer', 'reprojection', 'correction')),
  trigger_event_id         uuid,
  first_due                date NOT NULL,
  last_due                 date NOT NULL,
  rows                     int NOT NULL,
  rows_replaced            int NOT NULL DEFAULT 0,
  rows_kept                int NOT NULL DEFAULT 0,
  pi_cents                 bigint NOT NULL,
  rate_bps                 int NOT NULL,
  upb_start_cents          bigint NOT NULL,
  total_interest_cents     bigint NOT NULL,
  total_principal_cents    bigint NOT NULL,
  maturity_variance_cents  bigint NOT NULL DEFAULT 0,
  replaced                 jsonb NOT NULL DEFAULT '[]',
  sha256                   char(64) NOT NULL,
  decision_id              uuid REFERENCES agent_decisions(id) DEFERRABLE INITIALLY DEFERRED,
  retention                retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX installment_schedule_runs_loan_idx ON installment_schedule_runs (loan_id, created_at);
CREATE TRIGGER installment_schedule_runs_immutable BEFORE UPDATE OR DELETE ON installment_schedule_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE loan_installments
  ADD COLUMN sequence                int,
  ADD COLUMN upb_before_cents        bigint,
  ADD COLUMN upb_after_cents         bigint,
  ADD COLUMN rate_bps                int,
  ADD COLUMN terms_id                uuid REFERENCES loan_terms(id),
  ADD COLUMN schedule_run_id         uuid REFERENCES installment_schedule_runs(id),
  ADD COLUMN satisfied_by_payment_id uuid,
  ADD COLUMN absorbs_rounding        boolean NOT NULL DEFAULT false;
CREATE INDEX loan_installments_status_idx ON loan_installments (loan_id, status, due_date);

-- SATISFIED_ROW_FROZEN: a satisfied row's money and terms never change (a satisfied row changes only through 2.1's
-- reversal, which restores it to `due` first); nothing deletes a row.
CREATE OR REPLACE FUNCTION loan_installments_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'loan_installments rows are never deleted (35.5 data model)';
  END IF;
  IF OLD.status = 'satisfied' AND (
       NEW.pi_cents IS DISTINCT FROM OLD.pi_cents OR NEW.interest_cents IS DISTINCT FROM OLD.interest_cents
    OR NEW.principal_cents IS DISTINCT FROM OLD.principal_cents OR NEW.escrow_cents IS DISTINCT FROM OLD.escrow_cents
    OR NEW.upb_before_cents IS DISTINCT FROM OLD.upb_before_cents OR NEW.upb_after_cents IS DISTINCT FROM OLD.upb_after_cents
    OR NEW.rate_bps IS DISTINCT FROM OLD.rate_bps OR NEW.terms_id IS DISTINCT FROM OLD.terms_id
    OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.schedule_run_id IS DISTINCT FROM OLD.schedule_run_id
    OR NEW.absorbs_rounding IS DISTINCT FROM OLD.absorbs_rounding) THEN
    RAISE EXCEPTION 'SATISFIED_ROW_FROZEN: loan_installments (%, %) is satisfied; its money and terms change only through 2.1''s reversal', OLD.loan_id, OLD.due_date;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER loan_installments_frozen BEFORE UPDATE OR DELETE ON loan_installments FOR EACH ROW EXECUTE FUNCTION loan_installments_frozen();

COMMIT;
