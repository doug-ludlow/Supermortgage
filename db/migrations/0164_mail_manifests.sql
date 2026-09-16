-- 0164_mail_manifests.sql — 35.2 Documents and artifacts: print/mail manifests in and out
-- (spec/sections/35-operations-runtime/35-2-documents-and-artifacts.md "Data model": `mail_manifests`, `mail_manifest_pieces`,
-- `notice_deliveries.mail_manifest_id`; rules 9 and 10; "State machines: Per outbound mail manifest").
--
-- Mail is a manifest in and a manifest out (rule 9): `mail.batch` renders nothing — every piece's PDF already exists — and writes one
-- outbound row with one piece per notice delivery (sheets = ceil(page_count ÷ 2), the template's separate_document as
-- separate_envelope, the address snapshot from the notice), the manifest file itself stored as a document and hashed, one
-- integration_messages row to the print-mail adapter (idempotency key = the batch id), and arms SM_MAIL_MANIFEST_2BD. The vendor's
-- proof-of-mailing file comes back as an inbound row whose pieces are matched by notice_id + attempt_no; `mail.fallback` writes the
-- same manifest with vendor = in_house and one merged PDF per mail class (rule 10). Both tables are append-only: an outbound
-- manifest's later states are its inbound rows.
BEGIN;

CREATE TABLE mail_manifests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_batch_id   uuid REFERENCES notice_batches(id),                -- 0009's batch: notice_deliveries.manifest_id keeps naming it
  direction         text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  vendor            text NOT NULL,                                     -- FAKE, in_house, the vendor code
  file_name         text,
  sha256            char(64),
  piece_count       int NOT NULL,
  sheet_count       int,
  submitted_at      timestamptz,                                       -- outbound
  received_at       timestamptz,                                       -- inbound
  document_id       uuid REFERENCES documents(id),                     -- the manifest file itself (NDJSON, corporate_7y)
  reconciled        boolean,                                           -- inbound: matched count = outbound count
  status            text NOT NULL CHECK (status IN ('submitted', 'acknowledged', 'mailed', 'in_house', 'received')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_manifests_batch_idx ON mail_manifests (notice_batch_id, direction, created_at);
CREATE TRIGGER mail_manifests_immutable BEFORE UPDATE OR DELETE ON mail_manifests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE mail_manifests IS '35.2 rule 9: one outbound row per mail.batch / mail.fallback, one inbound row per proof-of-mailing file; append-only — an outbound manifest''s later states are its inbound rows.';

CREATE TABLE mail_manifest_pieces (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id        uuid NOT NULL REFERENCES mail_manifests(id),
  notice_id          uuid REFERENCES notices(id),                      -- null on an inbound piece the outbound manifest did not name
  attempt_no         int,
  document_id        uuid REFERENCES documents(id),                    -- the piece's PDF
  sha256             char(64),
  page_count         int,
  sheets             int,                                              -- duplex: ceil(page_count / 2)
  mail_class         text CHECK (mail_class IN ('first_class', 'certified', 'certified_rrr', 'priority')),
  separate_envelope  boolean,
  address_snapshot   jsonb,                                            -- pii
  vendor_piece_id    text,
  imb                text,
  mailed_on          date,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_manifest_pieces_manifest_idx ON mail_manifest_pieces (manifest_id);
CREATE INDEX mail_manifest_pieces_notice_idx ON mail_manifest_pieces (notice_id, attempt_no);
CREATE TRIGGER mail_manifest_pieces_immutable BEFORE UPDATE OR DELETE ON mail_manifest_pieces FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON COLUMN mail_manifest_pieces.address_snapshot IS 'pii';
COMMENT ON TABLE mail_manifest_pieces IS '35.2 rule 9: one row per piece of a manifest; an inbound manifest''s pieces are new rows keyed to the same notice_id and attempt_no; append-only.';

ALTER TABLE notice_deliveries ADD COLUMN IF NOT EXISTS mail_manifest_id uuid REFERENCES mail_manifests(id);
COMMENT ON COLUMN notice_deliveries.mail_manifest_id IS '35.2: the outbound mail_manifests row the piece was mailed on; manifest_id keeps 0009''s meaning (notice_batches)';

COMMIT;
