-- 0150_persistence_seam.sql — §35.1 "Persistence seam and the typed record": the seam's own rows (retention class
-- `permanent`, 35.1 open question 6; no PII beyond ids and column names) beside the sections' typed tables the
-- projectors write. Append-only where the spec says so (forbid_mutation, like loan_events); `sweep_runs` is mutable on
-- the timers precedent (one INSERT at start, one UPDATE at finish, never deleted).
BEGIN;

-- Data model: entity_projections — one row per projected entity version, in the command's own transaction (lag 0).
CREATE TABLE entity_projections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL,
  entity_id          text NOT NULL,
  scope_key          text NOT NULL,                                  -- mirrors entity_records.scope_key (0115)
  version            int  NOT NULL CHECK (version >= 1),
  target_table       text NOT NULL,
  target_id          uuid,
  mode               text NOT NULL CHECK (mode IN ('insert', 'upsert')),
  phase              text NOT NULL CHECK (phase IN ('before', 'commit', 'replay')),
  projector_version  text NOT NULL,
  command_event_id   uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,   -- the first event of the command; null on replay (a `before` projector runs before events.append)
  run_id             uuid,                                           -- replay / verify run
  projected_at       timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, entity_id, scope_key, version)
);
CREATE INDEX entity_projections_target_idx ON entity_projections (target_table, target_id);
CREATE TRIGGER entity_projections_immutable BEFORE UPDATE OR DELETE ON entity_projections FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: entity_keys — one uuid per (kind, legacy ref, scope), minted once, reused by every later version and by replay (rule 5).
CREATE TABLE entity_keys (
  kind         text NOT NULL,
  legacy_ref   text NOT NULL,
  scope_key    text NOT NULL,
  target_uuid  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, legacy_ref, scope_key)
);
CREATE TRIGGER entity_keys_immutable BEFORE UPDATE OR DELETE ON entity_keys FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: projection_runs — the daily verify run (one row, inserted finished, in the run's own final transaction).
CREATE TABLE projection_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date          date NOT NULL,
  started_at          timestamptz NOT NULL,
  finished_at         timestamptz NOT NULL,
  kinds_checked       int NOT NULL DEFAULT 0,
  rows_verified       int NOT NULL DEFAULT 0,
  mismatches          int NOT NULL DEFAULT 0,
  gaps                int NOT NULL DEFAULT 0,
  outcome             text NOT NULL CHECK (outcome IN ('completed', 'failed')),
  report_document_id  uuid REFERENCES documents(id),                -- 35.2 stores the report
  actor               text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projection_runs_day_idx ON projection_runs (as_of_date, finished_at);
CREATE TRIGGER projection_runs_immutable BEFORE UPDATE OR DELETE ON projection_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: projection_gaps — per run, the kinds whose versions have no typed row and why (append-only per run).
CREATE TABLE projection_gaps (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               uuid NOT NULL REFERENCES projection_runs(id),
  kind                 text NOT NULL,
  scope_key            text NOT NULL,
  versions_unprojected int NOT NULL,
  reason               text NOT NULL CHECK (reason IN ('no_projector', 'projector_error', 'schema_mismatch', 'key_conflict')),
  detail               jsonb NOT NULL DEFAULT '{}',                  -- the error, the column, never the row
  first_seen_at        timestamptz NOT NULL,
  as_of_date           date NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projection_gaps_run_idx ON projection_gaps (run_id, kind);
CREATE TRIGGER projection_gaps_immutable BEFORE UPDATE OR DELETE ON projection_gaps FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: projection_mismatches — a typed column that differs from the JSON version's field (money as cents strings; never a name or account).
CREATE TABLE projection_mismatches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES projection_runs(id),
  kind           text NOT NULL,
  entity_id      text NOT NULL,
  scope_key      text NOT NULL,
  version        int NOT NULL,
  target_table   text NOT NULL,
  target_id      uuid,
  column_name    text NOT NULL,
  is_money       boolean NOT NULL,
  json_value     text,
  row_value      text,
  escalation_id  uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projection_mismatches_run_idx ON projection_mismatches (run_id, kind);
CREATE TRIGGER projection_mismatches_immutable BEFORE UPDATE OR DELETE ON projection_mismatches FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: service_snapshots — an accelerator only (rule 9): a stateful service's Maps folded through `through_sequence`.
CREATE TABLE service_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_key        text NOT NULL,
  application_id     uuid,
  loan_id            uuid,
  through_sequence   bigint NOT NULL,
  state              jsonb NOT NULL,                                 -- bigint-encoded as {"$bigint": "<digits>"} like entity_records
  state_sha256       text NOT NULL,
  projector_version  text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX service_snapshots_key_idx ON service_snapshots (service_key, coalesce(application_id::text, loan_id::text, ''), through_sequence);
CREATE TRIGGER service_snapshots_immutable BEFORE UPDATE OR DELETE ON service_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: sweep_runs — the lease's evidence (never the lock: the session-level advisory lock 35_001 is the lock).
CREATE TABLE sweep_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holder          text NOT NULL,                                     -- instance or job execution id
  lease_key       int NOT NULL DEFAULT 35001,
  started_at      timestamptz NOT NULL,
  heartbeat_at    timestamptz NOT NULL,
  finished_at     timestamptz,
  as_of_date      date NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('running', 'completed', 'failed', 'skipped')),
  skipped_reason  text,
  passes          jsonb NOT NULL DEFAULT '[]',                        -- [{name, duration_ms, counts}]
  outbox          jsonb NOT NULL DEFAULT '{}',                        -- {claimed, sent, retried, dead}
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sweep_runs_started_idx ON sweep_runs (started_at DESC);
CREATE OR REPLACE FUNCTION sweep_runs_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'sweep_runs is never deleted (35.1 data model)'; END $$;
CREATE TRIGGER sweep_runs_no_delete BEFORE DELETE ON sweep_runs FOR EACH ROW EXECUTE FUNCTION sweep_runs_no_delete();

-- Data model: outbox_dispatches — one row per delivery attempt at every message (append-only).
CREATE TABLE outbox_dispatches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        uuid NOT NULL REFERENCES integration_messages(id),
  attempt_no        int NOT NULL CHECK (attempt_no >= 1),
  run_id            uuid REFERENCES sweep_runs(id),
  adapter           text NOT NULL,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('acked', 'retry', 'dead', 'rejected', 'fallback', 'duplicate')),
  failure_kind      text,
  error             text,
  response_sha256   text,
  next_attempt_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, attempt_no)
);
CREATE TRIGGER outbox_dispatches_immutable BEFORE UPDATE OR DELETE ON outbox_dispatches FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: entity_latest_scoped — the hydration read for every kind not in HISTORY_KINDS (rule 6), beside entity_current (0056).
CREATE VIEW entity_latest_scoped AS
  SELECT DISTINCT ON (kind, id, scope_key) kind, id, scope_key, version, loan_id, application_id, data, updated_at, updated_by
  FROM entity_records
  ORDER BY kind, id, scope_key, version DESC;

COMMIT;
