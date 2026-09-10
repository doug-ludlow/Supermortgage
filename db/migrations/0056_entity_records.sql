-- Runtime persistence for the agent-tool entity store (src/app/tools.ts EntityStore).
-- One row per version of a record; the tools' in-memory store is hydrated per loan
-- (loan-scoped rows + global rows) at the start of a command and every new version
-- is written back in the command's transaction. Append-only like the event log.
CREATE TABLE entity_records (
  kind        text        NOT NULL,
  id          text        NOT NULL,
  version     integer     NOT NULL CHECK (version >= 1),
  loan_id     text,                       -- NULL = global (registries, schedules, calendars)
  data        jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL,
  updated_by  text        NOT NULL,       -- "<actor kind>:<actor id>"
  PRIMARY KEY (kind, id, version)
);
CREATE INDEX entity_records_loan_idx ON entity_records (loan_id, kind);
CREATE INDEX entity_records_global_idx ON entity_records (kind) WHERE loan_id IS NULL;
CREATE TRIGGER entity_records_immutable BEFORE UPDATE OR DELETE ON entity_records FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Current version of every record.
CREATE VIEW entity_current AS
  SELECT DISTINCT ON (kind, id) kind, id, version, loan_id, data, updated_at, updated_by
  FROM entity_records
  ORDER BY kind, id, version DESC;
