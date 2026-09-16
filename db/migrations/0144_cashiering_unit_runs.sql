-- 0144 — 35.5 rule 6 "One unit per loan per day, over the whole book (`cashiering_daily`)" (spec/sections/35-operations-runtime/35-5-*.md,
-- Data model `cashiering_unit_runs`): one row per cashiering unit — the loan, the planner's `as_of_date`, the loan-local civil date the unit
-- used (rule 9), what 2.1 posted, whether 2.7's daily run ran and what it assessed, 2.3's amount-change checks, the outcome and the decision.
--
--   Unique `(loan_id, as_of_date)` where `outcome = 'done'` — the once-per-loan-per-day key (guardrail ONE_UNIT_PER_LOAN_PER_DAY): a second
--   unit the same day finds the row and records only a decision naming it. `failed` and `skipped_hold` rows are not unique (35.3 retries a
--   failed unit; a hold can be seen by several planner passes).
--   `job_id` / `run_id` are plain uuids: the FKs to `jobs` / `cycle_runs` are added by 35.3's merge (35.5 plan C-jobs; 35.3 owns both tables).
--   `payments_posted`, `late_charge_fee_ids`, `amount_change_checks` are text[]: the ids at HEAD are the JSONB store's (`fees-n`, an
--   enrollment's `E-…`, a payment's uuid — or a legacy `PAY-…` / `ACH-…` written before 35.5); the spec's uuid[] applies once 35.1's projectors
--   mint the typed ids (plan D5 / Ask 2) — the columns widen then.
--   `interest_variance_cents` (rule 4): Σ over the unit's postings of the row's `interest_cents` − the engine's interest (a curtailment between
--   rows; worked example T14: 542¢), also recorded on each row's `interest_variance_cents`.
--   Append-only (forbid_mutation); retention life_of_loan_plus_4y (the spec's default). Money is bigint cents.
BEGIN;

CREATE TABLE cashiering_unit_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                  uuid NOT NULL REFERENCES loans(id),
  as_of_date               date NOT NULL,                              -- the planner's period key (the ET civil date of the as-of instant)
  job_id                   uuid,                                       -- FK to jobs added by 35.3's merge
  run_id                   uuid,                                       -- FK to cycle_runs added by 35.3's merge
  time_zone                text,                                       -- loan_servicing_configs.time_zone the unit used (null on a CONFIG_REQUIRED failure)
  local_date               date,                                       -- the loan-local civil date of the as-of instant (rule 9)
  payments_posted          text[] NOT NULL DEFAULT '{}',
  late_charge_run          boolean NOT NULL DEFAULT false,             -- 2.7 fees.assess{op: daily_run} executed by this unit
  late_charge_fee_ids      text[] NOT NULL DEFAULT '{}',
  amount_change_checks     text[] NOT NULL DEFAULT '{}',               -- the enrollment ids 2.3's amount-change check ran for
  due_today                boolean NOT NULL DEFAULT false,
  grace_ended_yesterday    boolean NOT NULL DEFAULT false,
  outcome                  text NOT NULL CHECK (outcome IN ('done', 'skipped_hold', 'failed')),
  error_class              text,                                       -- a CommandRefused code (CONFIG_REQUIRED, CUSTODIAL_REQUIRED, …) or the error's name
  duration_ms              int,
  interest_variance_cents  bigint,
  decision_id              uuid REFERENCES agent_decisions(id),
  retention_class          retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cashiering_unit_runs_once_per_day ON cashiering_unit_runs(loan_id, as_of_date) WHERE outcome = 'done';
CREATE INDEX cashiering_unit_runs_day_idx ON cashiering_unit_runs(as_of_date, outcome);
CREATE INDEX cashiering_unit_runs_loan_idx ON cashiering_unit_runs(loan_id, as_of_date);
CREATE TRIGGER cashiering_unit_runs_immutable BEFORE UPDATE OR DELETE ON cashiering_unit_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE cashiering_unit_runs IS '35.5 rule 6: one row per cashiering unit (loan × as_of_date); unique where outcome = done — the once-per-loan-per-day key; append-only.';
COMMENT ON COLUMN cashiering_unit_runs.job_id IS '35.3 jobs.id — FK added by 35.3''s merge.';
COMMENT ON COLUMN cashiering_unit_runs.run_id IS '35.3 cycle_runs.id — FK added by 35.3''s merge.';
COMMENT ON COLUMN cashiering_unit_runs.payments_posted IS 'The payment ids 2.1 posted in this unit (the JSONB store''s ids until 35.1 mints the typed uuids).';

COMMIT;
