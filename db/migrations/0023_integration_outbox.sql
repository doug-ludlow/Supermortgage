-- 0023_integration_outbox.sql — outbox delivery state on integration_messages and the
-- human_portal_tasks queue every adapter falls back to (LSDU upload, CRS upload, DMDC batch,
-- e-OSCAR web app, P360 bulk ZIP, bank-portal download). Spec: 5.1 "queued (in an
-- integration_messages outbox batch)", 5.2 CRS "upload is a human_portal_task", 8.2-T11, 13.8 DMDC.
BEGIN;

ALTER TABLE integration_messages
  ADD COLUMN IF NOT EXISTS attempts        int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_at         timestamptz,
  ADD COLUMN IF NOT EXISTS response        jsonb,
  ADD COLUMN IF NOT EXISTS loan_id         uuid REFERENCES loans(id),
  ADD COLUMN IF NOT EXISTS source_event_id uuid REFERENCES loan_events(id);
ALTER TABLE integration_messages DROP CONSTRAINT IF EXISTS integration_messages_status_check;
ALTER TABLE integration_messages ADD CONSTRAINT integration_messages_status_check
  CHECK (status IN ('received', 'queued', 'sent', 'acked', 'rejected', 'failed', 'dead', 'duplicate'));
CREATE INDEX IF NOT EXISTS integration_messages_due_idx ON integration_messages(adapter, next_attempt_at) WHERE status = 'queued';

CREATE TABLE human_portal_tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL,                       -- lsdu_file_upload | lsdu_single_lar | crs_batch_upload | crs_instruction | p360_reogram | p360_bulk_claim | dmdc_batch_upload | eoscar_web_entry | amn_upload | connect_pull | dra_review | bank_portal_download | attestation | ...
  adapter               text NOT NULL,
  owner_role            text NOT NULL DEFAULT 'fnma_portal_operator',
  loan_id               uuid REFERENCES loans(id),
  integration_message_id uuid REFERENCES integration_messages(id),
  package               jsonb NOT NULL DEFAULT '{}',         -- file names, manifest, deadline, instructions
  due_at                timestamptz,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  opened_at             timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  completed_by          text,
  evidence_document_id  uuid REFERENCES documents(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX human_portal_tasks_open_idx ON human_portal_tasks(owner_role, due_at) WHERE status IN ('open', 'in_progress');

COMMIT;
