-- 0166_notice_deliveries_party.sql — 35.2 Documents and artifacts: the recipient of each notice delivery
-- (spec/sections/35-operations-runtime/35-2-documents-and-artifacts.md, rule 9 — "each mail_manifest_pieces row carries … the
-- piece's address snapshot").
--
-- A notice addressed to two parties has two mail deliveries; a bounced e-delivery's paper fallback is a third delivery for the
-- party the bounce named. The Notice Registry's Delivery has always carried the party (src/notices/service.ts `Delivery.partyId`),
-- the row did not: `mail.batch` had to map the k-th mail delivery to the k-th mail decision, which is wrong the moment a
-- delivery is not a decision (a fallback, a re-mail). The column is written by the registry's upsert (PgNoticeRepository) for
-- every delivery it saves and never edited afterwards (coalesce on conflict); `mail.batch` reads it to pick the address
-- snapshot row, and falls back to the positional mapping only for a row written before this migration.
BEGIN;

ALTER TABLE notice_deliveries ADD COLUMN party_id uuid;
CREATE INDEX notice_deliveries_party_idx ON notice_deliveries (party_id) WHERE party_id IS NOT NULL;
COMMENT ON COLUMN notice_deliveries.party_id IS '35.2: the delivery''s recipient (notices.address_snapshot[party_id] is the piece''s address); write-once by the registry''s upsert.';

COMMIT;
