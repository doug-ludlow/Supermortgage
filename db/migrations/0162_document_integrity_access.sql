-- 0162_document_integrity_access.sql — 35.2 Documents and artifacts: the daily integrity run, its findings and the access log
-- (spec/sections/35-operations-runtime/35-2-documents-and-artifacts.md, "Data model": `document_integrity_runs`,
-- `document_integrity_findings`, `document_access_log` — all append-only).
--
-- The integrity unit (`documents.verify{op: run}`, daily at 02:30 America/New_York — SM_DOC_INTEGRITY_DAILY) re-reads every
-- stored object and hashes it (rule 1: it never re-renders); a run row is inserted complete after the scan, one finding per
-- mismatch/missing/unreadable object with the sev-1 `ciso` escalation it opened (19.1 CTL-SEC-22), and the run's own report
-- (NDJSON, `corporate_7y`) is a `documents` row. The access log records every serve — the borrower viewer, the staff view,
-- the verify portal, the e-sign view, the evidence pack — with the hash of the bytes served (rule 7); retention security_logs_5y.
BEGIN;

CREATE TABLE document_integrity_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date          date NOT NULL,
  started_at          timestamptz NOT NULL,
  finished_at         timestamptz,
  scope               text NOT NULL CHECK (scope IN ('full', 'rolling_7d_plus_sample')),
  documents_checked   int NOT NULL DEFAULT 0,
  verified            int NOT NULL DEFAULT 0,
  mismatches          int NOT NULL DEFAULT 0,
  missing             int NOT NULL DEFAULT 0,
  skipped_staged      int NOT NULL DEFAULT 0,
  skipped_foreign     int NOT NULL DEFAULT 0,                    -- rows another section wrote with a storage_uri the store does not hold (evidence://, report://, du://)
  report_document_id  uuid REFERENCES documents(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_integrity_runs_date_idx ON document_integrity_runs (as_of_date, started_at);
CREATE TRIGGER document_integrity_runs_immutable BEFORE UPDATE OR DELETE ON document_integrity_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE document_integrity_runs IS '35.2: one row per daily integrity run (documents.verify{op: run}); inserted complete after the scan; append-only. report_document_id is the run''s own NDJSON report (corporate_7y).';

CREATE TABLE document_integrity_findings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES document_integrity_runs(id),
  document_id         uuid NOT NULL REFERENCES documents(id),
  finding             text NOT NULL CHECK (finding IN ('mismatch', 'missing', 'unreadable')),
  expected_sha256     char(64),
  actual_sha256       char(64),
  stored_generation   text,
  escalation_id       uuid REFERENCES escalations(id),
  staged_copy_exists  boolean,                                   -- the staged blob still holds the bytes (nonprod, or a production row drained under 7 days ago)
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_integrity_findings_document_idx ON document_integrity_findings (document_id, created_at);
CREATE TRIGGER document_integrity_findings_immutable BEFORE UPDATE OR DELETE ON document_integrity_findings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE document_integrity_findings IS '35.2 / 19.1-T12: an object whose re-read hash differs, is missing or unreadable; its disposal is blocked and a sev-1 ciso escalation is open; append-only.';

CREATE TABLE document_access_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         uuid NOT NULL REFERENCES documents(id),
  purpose             text NOT NULL CHECK (purpose IN ('borrower_view', 'staff_view', 'esign_view', 'verify_portal', 'evidence_pack', 'integrity')),
  party_id            uuid,
  staff_user_id       text,                                      -- the staff session's user id, or the header actor's id outside production (34.1)
  session_id          uuid,
  ip                  inet,                                      -- pii
  user_agent          text,
  sha256_served       char(64) NOT NULL,
  byte_size_served    bigint NOT NULL,
  served_from         text NOT NULL CHECK (served_from IN ('object_store', 'staged_blob')),
  retention_class     retention_class NOT NULL DEFAULT 'security_logs_5y',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_access_log_document_idx ON document_access_log (document_id, created_at);
CREATE TRIGGER document_access_log_immutable BEFORE UPDATE OR DELETE ON document_access_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON COLUMN document_access_log.ip IS 'pii';
COMMENT ON TABLE document_access_log IS '35.2 rule 7: every serve of a document''s bytes, with the hash of what was served (equal to documents.sha256 — a served mismatch is refused INTEGRITY_FAILED); append-only; security_logs_5y.';

COMMIT;
