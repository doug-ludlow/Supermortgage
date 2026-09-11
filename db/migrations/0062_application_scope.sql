-- 0062_application_scope.sql — application-scoped runtime state (the origination side of the seam, 0057).
-- The agent-tool entity store keys rows by loan; before funding an origination command has an application and no loan.
ALTER TABLE entity_records ADD COLUMN application_id text;
CREATE INDEX entity_records_application_idx ON entity_records (application_id, kind) WHERE application_id IS NOT NULL;
COMMENT ON COLUMN entity_records.application_id IS 'applications.id for rows written by an application-scoped command (null = loan-scoped or global)';
