-- 35.5 — the daily cashiering unit: one row per (loan, as_of_date) the unit completed (rule 6; T4, T5, T6, T11, T15).
-- Data model: cashiering_unit_runs — append-only: `job_id` → 35.3's `jobs` and `run_id` → `cycle_runs` are recorded as plain
-- uuids (35.3's tables land on their own branch; the port in src/domain/operations-runtime/cycles-port.ts writes the run either way);
-- `local_date` is the loan-local civil date the unit used (rule 9), `outcome` ∈ {done, skipped_hold, failed}; `row_variances`
-- records, per installment 2.1 applied, the posted interest against the row's `interest_cents` when they differ (rule 4: the
-- interest is recomputed from the actual UPB after a curtailment between rows — T14's 542¢).
-- The once-per-loan-per-day key is the partial unique index on (loan_id, as_of_date) WHERE outcome = 'done'
-- (ONE_UNIT_PER_LOAN_PER_DAY): a second unit the same day finds the row and writes nothing.
BEGIN;

CREATE TABLE cashiering_unit_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                  uuid NOT NULL REFERENCES loans(id),
  as_of_date               date NOT NULL,
  job_id                   uuid,
  run_id                   uuid,
  time_zone                text NOT NULL,
  local_date               date NOT NULL,
  payments_posted          uuid[] NOT NULL DEFAULT '{}',
  payments_posted_refs     text[] NOT NULL DEFAULT '{}',
  late_charge_run          boolean NOT NULL DEFAULT false,
  late_charge_fee_ids      uuid[] NOT NULL DEFAULT '{}',
  late_charge_fee_refs     text[] NOT NULL DEFAULT '{}',
  amount_change_checks     uuid[] NOT NULL DEFAULT '{}',
  amount_change_check_refs text[] NOT NULL DEFAULT '{}',
  reprojections            uuid[] NOT NULL DEFAULT '{}',
  row_variances            jsonb NOT NULL DEFAULT '[]',
  due_today                boolean NOT NULL DEFAULT false,
  grace_ended_yesterday    boolean NOT NULL DEFAULT false,
  outcome                  text NOT NULL CHECK (outcome IN ('done', 'skipped_hold', 'failed')),
  error_class              text,
  duration_ms              int NOT NULL DEFAULT 0,
  decision_id              uuid REFERENCES agent_decisions(id) DEFERRABLE INITIALLY DEFERRED,
  retention_class          retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cashiering_unit_runs_once_per_day ON cashiering_unit_runs (loan_id, as_of_date) WHERE outcome = 'done';
CREATE INDEX cashiering_unit_runs_as_of_idx ON cashiering_unit_runs (as_of_date, outcome);
CREATE TRIGGER cashiering_unit_runs_immutable BEFORE UPDATE OR DELETE ON cashiering_unit_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
