-- 0230_ops_stewardship.sql — 35.11 Operations stewardship and hosted measurement
-- (spec/sections/35-operations-runtime/35-11-operations-stewardship-and-hosted-measurement.md, Data model).
--   ops_exceptions              mutable on the `timers` precedent (status and the latest triage move; never deleted): one live
--                               exception per source (partial unique index), ids / adapters / error classes only. Retention corporate_7y.
--   exception_triages           APPEND-ONLY (forbid_mutation): every act on an exception — opened, classified (with rule 3's counted
--                               signals), requeue_auto, requeue_proposed, assigned, resolved, abandoned, escalated. Retention corporate_7y.
--   ops_daily_reports           APPEND-ONLY: one hashed row per (environment, as_of_date) per distinct content (rule 5, the 0129
--                               precedent) — counts and codes only. Retention corporate_7y.
--   hosted_probe_runs           APPEND-ONLY: every hosted probe run (rule 10) — per-tool status, code and http status, never a body.
--   persisted_measurement_runs  APPEND-ONLY: every persisted count (rule 11) with the migration head and git sha it measured.
--   persisted_measurements      APPEND-ONLY: one row per manifest table per run — post-migrate count, after-journey count, delta, verdict.
-- Six base tables (src/infra/db/db.test.ts counts 789 through 0171; 795 with this file). No PII column anywhere: an exception names
-- ids, adapters and error classes, never a payload, a name or an account (rule 9, NO_PAYLOAD_IN_EXCEPTION).
BEGIN;

CREATE TABLE ops_exceptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment      text NOT NULL,                                          -- nonprod | production | probe | the ENVIRONMENT value
  source_kind      text NOT NULL CHECK (source_kind IN ('integration_message', 'cycle_registry', 'cycle_run', 'job', 'escalation', 'sweep_run', 'role_queue', 'fake_actor')),
  source_id        text NOT NULL,                                          -- the message id, "<cycle_code>:<period_key>", the run id, the job id, the role, the day
  adapter          text,
  loan_id          uuid REFERENCES loans(id),
  application_id   uuid REFERENCES applications(id),
  kind             text NOT NULL DEFAULT 'unclassified' CHECK (kind IN ('unclassified', 'adapter_down', 'transient', 'poison', 'needs_person', 'missed_cycle', 'stalled_run', 'dead_unit', 'unstaffed_role', 'fake_in_production')),
  confidence       numeric(5,4),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'assigned', 'resolved', 'abandoned')),
  owner_role       text NOT NULL DEFAULT 'ops_analyst',                   -- a kernel HumanRole (src/app/roles.ts)
  opened_at        timestamptz NOT NULL,
  classified_at    timestamptz,
  assigned_at      timestamptz,
  resolved_at      timestamptz,
  auto_requeues    int NOT NULL DEFAULT 0 CHECK (auto_requeues >= 0),      -- rule 4's cap of 1
  escalation_id    uuid REFERENCES escalations(id),
  latest_triage_id uuid,                                                   -- exception_triages.id (no FK: the triage row references this row)
  created_at       timestamptz NOT NULL DEFAULT now(),
  retention_class  retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE UNIQUE INDEX ops_exceptions_live_source_idx ON ops_exceptions (source_kind, source_id) WHERE status IN ('open', 'triaged', 'assigned');
CREATE INDEX ops_exceptions_env_status_idx ON ops_exceptions (environment, status, opened_at);
CREATE INDEX ops_exceptions_adapter_idx ON ops_exceptions (adapter) WHERE adapter IS NOT NULL;
CREATE OR REPLACE FUNCTION ops_exceptions_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ops_exceptions is never deleted (35.11 data model: mutable on the timers precedent, never deleted)'; END $$;
CREATE TRIGGER ops_exceptions_no_delete BEFORE DELETE ON ops_exceptions FOR EACH ROW EXECUTE FUNCTION ops_exceptions_no_delete();
COMMENT ON TABLE ops_exceptions IS '35.11 data model: one live exception per source (partial unique index on (source_kind, source_id) while open/triaged/assigned); status and the latest triage move, nothing is deleted; no payload, name or account — ids, adapters and error classes only.';

CREATE TABLE exception_triages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exception_id    uuid NOT NULL REFERENCES ops_exceptions(id),
  action          text NOT NULL CHECK (action IN ('opened', 'classified', 'requeue_auto', 'requeue_proposed', 'assigned', 'resolved', 'abandoned', 'escalated')),
  kind            text,                                                    -- the classification at that act
  confidence      numeric(5,4),
  signals         jsonb NOT NULL DEFAULT '{}',                             -- rule 3: {D15, S60, A, C} — counts and classes only
  actor_kind      actor_kind NOT NULL,
  actor_id        text NOT NULL,
  actor_role      text,
  assigned_role   text,
  reason          text,
  decision_id     uuid REFERENCES agent_decisions(id),
  event_id        uuid REFERENCES loan_events(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX exception_triages_exception_idx ON exception_triages (exception_id, created_at, id);
CREATE TRIGGER exception_triages_immutable BEFORE UPDATE OR DELETE ON exception_triages FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE exception_triages IS '35.11 data model: the append-only record of every act on an exception — the stored signals, the confidence, who classified, requeued, assigned or abandoned it and why.';

CREATE TABLE ops_daily_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     text NOT NULL,
  as_of_date      date NOT NULL,
  produced_on     date NOT NULL,                                          -- the ET date the report ran (a report of D is produced on D+1 at/after 00:15 ET; SM_OPS_REPORT_DAILY anchors here — an additive erratum to the spec's column list, see timers-35-11.ts)
  sweep           jsonb,                                                   -- {runs, completed, skipped, failed, longest_ms, heartbeat_ok}; null when the feed is absent
  cycles          jsonb,                                                   -- [{cycle_code, runs, receipts, units_done, units_dead, overdue_since}]
  breaches        jsonb NOT NULL DEFAULT '[]',                             -- [{timer_code, count, owner_role, severity}]
  escalations     jsonb NOT NULL DEFAULT '{}',                             -- {open_by_role, opened_today, completed_today, oldest_open_at}
  outbox          jsonb NOT NULL DEFAULT '[]',                             -- [{adapter, queued, sent, retried, dead, requeued_by_hand, requeued_auto}]
  exceptions      jsonb NOT NULL DEFAULT '{}',                             -- {opened, classified, by_kind, assigned, resolved, abandoned, open_over_1bd}
  fake_approvals  int NOT NULL DEFAULT 0,
  fake_roles      text[] NOT NULL DEFAULT '{}',
  kill_switches   jsonb NOT NULL DEFAULT '[]',                             -- [{code, state, since}]
  projection      jsonb,                                                   -- {gaps, mismatches}
  documents       jsonb,                                                   -- {integrity_findings, staged_over_1d}
  roles           jsonb,                                                   -- {unstaffed: [role]}
  override_rates  jsonb NOT NULL DEFAULT '[]',                             -- [{system_code, decisions, overrides, override_rate, out_of_band}]
  sha256          char(64) NOT NULL,                                       -- over the canonical JSON of every column above
  document_id     uuid REFERENCES documents(id),                           -- the rendered report (35.2's store; a documents row until it lands)
  produced_by     text NOT NULL,                                           -- sweep:<sweep_run_id> | human:<staff_user_id> | agent:qc-audit
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'corporate_7y',
  UNIQUE (environment, as_of_date, sha256)
);
CREATE INDEX ops_daily_reports_day_idx ON ops_daily_reports (environment, as_of_date, created_at DESC);
CREATE TRIGGER ops_daily_reports_immutable BEFORE UPDATE OR DELETE ON ops_daily_reports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE ops_daily_reports IS '35.11 rule 5: one hashed row per environment-day per distinct content; a re-run appends a newer row only when the sha256 differs (the 34.3 / 0129 precedent). Counts and codes only.';

CREATE TABLE hosted_probe_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target          text NOT NULL CHECK (target IN ('probe', 'deployed')),
  database_name   text NOT NULL,
  base_url        text NOT NULL,                                           -- the deployed API's origin; `local` for the probe
  migration_head  text NOT NULL,                                           -- the newest file name under db/migrations at the run
  git_sha         text NOT NULL,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz,
  outcome         text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started', 'completed', 'failed')),
  failure         text,                                                    -- the reason of a failed run (a code, never a body)
  tools_total     int NOT NULL DEFAULT 0,
  executed        int NOT NULL DEFAULT 0,
  refused_typed   int NOT NULL DEFAULT 0,
  not_wired       int NOT NULL DEFAULT 0,
  errored         int NOT NULL DEFAULT 0,
  results         jsonb NOT NULL DEFAULT '[]',                             -- [{process, name, status, code, http_status, duration_ms}] — never a response body
  sha256          char(64) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX hosted_probe_runs_started_idx ON hosted_probe_runs (target, started_at DESC);
CREATE TRIGGER hosted_probe_runs_immutable BEFORE UPDATE OR DELETE ON hosted_probe_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE hosted_probe_runs IS '35.11 rule 10: every hosted probe run — the migration head and git sha it measured, the four counts and one result per (process, tool) pair; a failed run keeps its results so far and emits nothing.';

CREATE TABLE persisted_measurement_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  database_name     text NOT NULL,
  migration_head    text NOT NULL,
  git_sha           text NOT NULL,
  journeys          text[] NOT NULL DEFAULT '{}',                          -- the test files that ran, by basename
  post_migrate_at   timestamptz NOT NULL,
  measured_at       timestamptz NOT NULL,
  outcome           text NOT NULL DEFAULT 'completed' CHECK (outcome IN ('completed', 'failed')),
  tables_total      int NOT NULL DEFAULT 0,
  tables_with_rows  int NOT NULL DEFAULT 0,
  sections_complete int[] NOT NULL DEFAULT '{}',
  sha256            char(64) NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  retention_class   retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE TRIGGER persisted_measurement_runs_immutable BEFORE UPDATE OR DELETE ON persisted_measurement_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE persisted_measurement_runs IS '35.11 rule 11: every persisted count — the database, the migration head and the git sha it measured, the journeys that ran, the sections whose expected tables all persisted.';

CREATE TABLE persisted_measurements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES persisted_measurement_runs(id),
  section             int NOT NULL,
  process             text NOT NULL,
  table_name          text NOT NULL,
  post_migrate_count  bigint NOT NULL DEFAULT 0,
  after_journey_count bigint NOT NULL DEFAULT 0,
  delta               bigint NOT NULL DEFAULT 0,
  expected            boolean NOT NULL DEFAULT false,                      -- a journey step names the table in its writes list
  expected_by         text,                                                -- "<journey>:<step>" — the step that should have written it
  verdict             text NOT NULL CHECK (verdict IN ('persisted', 'untouched', 'seeded_only', 'missing_ddl')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  retention_class     retention_class NOT NULL DEFAULT 'corporate_7y',
  UNIQUE (run_id, table_name)
);
CREATE INDEX persisted_measurements_run_idx ON persisted_measurements (run_id, section, process);
CREATE TRIGGER persisted_measurements_immutable BEFORE UPDATE OR DELETE ON persisted_measurements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE persisted_measurements IS '35.11 rule 11: one row per manifest table per run — delta = after − post_migrate; persisted when delta > 0, seeded_only when delta = 0 and post_migrate > 0, untouched when both are 0, missing_ddl when the table is in the manifest and not in the database.';

COMMIT;
