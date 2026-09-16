-- 0142_cycles_jobs_receipts.sql — §35.3 "Cycles, jobs and receipts": the code registry's projection, one run per
-- (cycle, period), the jobs table the executors claim `FOR UPDATE SKIP LOCKED`, the append-only job log and the receipts.
-- Retention class `corporate_7y` on every table (spec "Data model": "New tables (retention `corporate_7y`; no PII column
-- in any of them — a unit is identified by ids, never by a name or an account)"). `cycle_registry`, `cycle_runs` and `jobs`
-- are mutable on the `timers` precedent (counters, status and the lease move; never deleted); `job_events` and
-- `cycle_receipts` are append-only (forbid_mutation, like loan_events). Leases are wall clock: `lease_until` and
-- `heartbeat_at` are written with Postgres `now()`, never the demo clock (rule 6, LEASE_IS_WALL_CLOCK).
BEGIN;

-- Data model: cycle_registry — the planner upserts the code registry's rows (src/domain/operations-runtime/cycles/cycles.ts CYCLES) and their runtime counters.
CREATE TABLE cycle_registry (
  cycle_code         text PRIMARY KEY,
  owner_process      text NOT NULL,
  owner_agent        text NOT NULL,
  unit_scope         text NOT NULL CHECK (unit_scope IN ('loan', 'account', 'period', 'global')),
  schedule           text NOT NULL,
  period_grammar     text NOT NULL CHECK (period_grammar IN ('day', 'month', 'tax_year', 'billing_cycle', 'event')),
  unit_selector      text NOT NULL,
  unit_runner        text NOT NULL,
  receipt_event      text NOT NULL,
  depends_on         jsonb NOT NULL DEFAULT '[]',
  serves_timer       text,
  escalation_role    text NOT NULL DEFAULT 'ops_analyst',
  expected_by_rule   text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  paused_by          text,
  paused_reason      text,
  last_period_key    text,
  last_run_id        uuid,
  last_receipt_at    timestamptz,
  next_period_key    text,
  next_expected_by   timestamptz,
  overdue_since      timestamptz,
  last_error_class   text,
  registry_version   text NOT NULL,
  retention_class    retention_class NOT NULL DEFAULT 'corporate_7y',
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Data model: cycle_runs — one row per (cycle, period); the counters and the status move; never deleted.
CREATE TABLE cycle_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_code         text NOT NULL REFERENCES cycle_registry(cycle_code),
  period_key         text NOT NULL,
  as_of_date         date NOT NULL,
  planned_by         text NOT NULL,
  opened_at          timestamptz NOT NULL,
  units_total        int NOT NULL DEFAULT 0,
  units_done         int NOT NULL DEFAULT 0,
  units_dead         int NOT NULL DEFAULT 0,
  units_skipped      int NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'running', 'completed', 'cancelled')),
  completed_at       timestamptz,
  receipt_id         uuid,
  cancelled_by       text,
  cancelled_reason   text,
  demo_offset_ms     bigint NOT NULL DEFAULT 0,
  retention_class    retention_class NOT NULL DEFAULT 'corporate_7y',
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_code, period_key)
);
CREATE INDEX cycle_runs_status_idx ON cycle_runs (status, opened_at);

-- Data model: jobs — one row per unit of a run; status, attempts and the lease move; never deleted. `input` carries ids and dates only (rule 8: no `*_cents`, no `state`).
CREATE TABLE jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 uuid NOT NULL REFERENCES cycle_runs(id),
  cycle_code             text NOT NULL REFERENCES cycle_registry(cycle_code),
  period_key             text NOT NULL,
  unit_id                text NOT NULL,
  loan_id                uuid REFERENCES loans(id),
  application_id         uuid,
  priority               int NOT NULL DEFAULT 100,
  depends_on_satisfied   boolean NOT NULL DEFAULT true,
  status                 text NOT NULL DEFAULT 'queued' CHECK (status IN ('blocked', 'queued', 'running', 'done', 'failed', 'dead', 'abandoned', 'skipped')),
  attempts               int NOT NULL DEFAULT 0,
  max_attempts           int NOT NULL DEFAULT 3,
  run_after              timestamptz,
  lease_holder           text,
  lease_until            timestamptz,
  heartbeat_at           timestamptz,
  last_error_class       text,
  last_error             text,
  decision_id            uuid REFERENCES agent_decisions(id),
  idempotency_key        text NOT NULL UNIQUE,
  input                  jsonb NOT NULL DEFAULT '{}',
  retention_class        retention_class NOT NULL DEFAULT 'corporate_7y',
  created_at             timestamptz NOT NULL DEFAULT now(),
  finished_at            timestamptz
);
CREATE INDEX jobs_claim_idx ON jobs (status, run_after, priority, created_at);
CREATE INDEX jobs_run_idx ON jobs (run_id, status);
CREATE INDEX jobs_loan_idx ON jobs (loan_id) WHERE loan_id IS NOT NULL;

-- Data model: job_events — the append-only chain of every job (planned, blocked, unblocked, claimed, heartbeat, done, failed, dead, lease_expired, requeued, abandoned, skipped).
CREATE TABLE job_events (
  id               bigserial PRIMARY KEY,
  job_id           uuid NOT NULL REFERENCES jobs(id),
  kind             text NOT NULL CHECK (kind IN ('planned', 'blocked', 'unblocked', 'claimed', 'heartbeat', 'done', 'failed', 'dead', 'lease_expired', 'requeued', 'abandoned', 'skipped')),
  attempt          int,
  holder           text,
  actor_kind       actor_kind NOT NULL,
  actor_id         text NOT NULL,
  actor_role       text,
  error_class      text,
  error            text,
  detail           jsonb NOT NULL DEFAULT '{}',
  retention_class  retention_class NOT NULL DEFAULT 'corporate_7y',
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events (job_id, id);
CREATE TRIGGER job_events_immutable BEFORE UPDATE OR DELETE ON job_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: cycle_receipts — the exactly-once receipt of a run (rule 5, RECEIPT_ONCE: unique run_id); append-only.
CREATE TABLE cycle_receipts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL UNIQUE REFERENCES cycle_runs(id),
  cycle_code         text NOT NULL,
  period_key         text NOT NULL,
  as_of_date         date NOT NULL,
  units_total        int NOT NULL,
  units_done         int NOT NULL,
  units_dead         int NOT NULL,
  units_skipped      int NOT NULL,
  outcomes_sha256    char(64) NOT NULL,
  receipt_event_id   uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,
  generic_event_id   uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,
  emitted_by         text NOT NULL,
  retention_class    retention_class NOT NULL DEFAULT 'corporate_7y',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER cycle_receipts_immutable BEFORE UPDATE OR DELETE ON cycle_receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
