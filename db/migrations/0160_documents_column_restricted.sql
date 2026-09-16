-- 0160_documents_column_restricted.sql — 35.2 Documents and artifacts: the `documents` row as the artifact record
-- (spec/sections/35-operations-runtime/35-2-documents-and-artifacts.md, "Data model": `documents` (baseline; extended;
-- column-restricted trigger)). Append-only migration: columns are added with defaults so every existing INSERT site
-- (src/runtime/book-ops/report.ts, src/runtime/controls/evidence.ts, src/app/tools/section32-2.ts, section20-3.ts,
-- src/domain/underwriting/du/persist.ts) keeps inserting unchanged; the trigger governs UPDATE and DELETE only.
--
-- Trigger `documents_column_restricted` (rule 1 "the hash is the bytes"; rule 4 "staging first"; rule 5 "holds are
-- two-sided"; rule 6 "disposal is 19.1's act"): DELETE is refused always; UPDATE is permitted only for
--   (a) `storage_uri`, `storage_status`, `stored_generation` in one statement, once, from `worm_pending:<id>` to the
--       stored URI (URI_SWAP_ONCE — the drain's swap after the re-read hash matched);
--   (b) `legal_hold` when `current_setting('sm.document_hold', true)` equals the row id (set by `documents.hold` inside
--       its transaction, which also inserts the `document_holds` row: a flip to true needs an open `placed` row, a flip
--       to false needs every `placed` row matched by a human `released` row — "writes the released row before the flag");
--   (c) `last_verified_at` and `verify_status` by the integrity unit (`sm.integrity_run` names the run); a `mismatch`
--       or `missing` never returns to `verified` by a later run (state machine: "only a ciso-closed escalation and a new
--       row");
--   (d) `storage_status = disposed`, `disposed_at`, `disposal_run_id` when `current_setting('sm.disposal_run', true)`
--       names the run, on a `stored` row;
-- any other column change is refused (sha256, byte_size, kind, mime_type, created_at, retention_class, metadata and
-- every other column are write-once). A disposed row is the tombstone 19.1 rule 7 requires: it never changes again.
BEGIN;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS storage_status    text NOT NULL DEFAULT 'staged' CHECK (storage_status IN ('staged', 'stored', 'disposed')),
  ADD COLUMN IF NOT EXISTS stored_generation text,
  ADD COLUMN IF NOT EXISTS render_engine     text,
  ADD COLUMN IF NOT EXISTS render_version    text,
  ADD COLUMN IF NOT EXISTS template_code     text,
  ADD COLUMN IF NOT EXISTS template_version  text,
  ADD COLUMN IF NOT EXISTS payload_hash      char(64),
  ADD COLUMN IF NOT EXISTS text_layer        boolean,
  ADD COLUMN IF NOT EXISTS locale            text,
  ADD COLUMN IF NOT EXISTS last_verified_at  timestamptz,
  ADD COLUMN IF NOT EXISTS verify_status     text NOT NULL DEFAULT 'unverified' CHECK (verify_status IN ('unverified', 'verified', 'mismatch', 'missing')),
  ADD COLUMN IF NOT EXISTS disposed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS disposal_run_id   uuid;

CREATE INDEX IF NOT EXISTS documents_staged_idx ON documents (created_at) WHERE storage_status = 'staged';
CREATE INDEX IF NOT EXISTS documents_stored_verify_idx ON documents (last_verified_at) WHERE storage_status = 'stored';
-- the render idempotency lookup (edge case: "the same payload rendered twice in one command → one row"; "a different clock is a different document")
CREATE INDEX IF NOT EXISTS documents_render_idem_idx ON documents (template_code, template_version, payload_hash, created_at) WHERE template_code IS NOT NULL AND payload_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION documents_column_restricted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  hold_setting text := current_setting('sm.document_hold', true);
  placed_n int; released_n int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'documents_column_restricted: documents is append-only — DELETE refused; a disposed row is the tombstone (35.2 rule 6)';
  END IF;
  IF OLD.storage_status = 'disposed' THEN
    RAISE EXCEPTION 'documents_column_restricted: % is a disposal tombstone and never changes', OLD.id;
  END IF;
  -- write-once: everything outside (a)–(d)
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.loan_id IS DISTINCT FROM OLD.loan_id OR NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type OR NEW.received_from IS DISTINCT FROM OLD.received_from OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
     OR NEW.metadata IS DISTINCT FROM OLD.metadata OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.doc_class IS DISTINCT FROM OLD.doc_class
     OR NEW.retention_anchor_date IS DISTINCT FROM OLD.retention_anchor_date OR NEW.retention_until IS DISTINCT FROM OLD.retention_until
     OR NEW.doc_subclass IS DISTINCT FROM OLD.doc_subclass OR NEW.classification_confidence IS DISTINCT FROM OLD.classification_confidence
     OR NEW.classifier_version IS DISTINCT FROM OLD.classifier_version OR NEW.source_channel IS DISTINCT FROM OLD.source_channel
     OR NEW.sender_identity IS DISTINCT FROM OLD.sender_identity OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.document_date IS DISTINCT FROM OLD.document_date OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.issuer_name IS DISTINCT FROM OLD.issuer_name OR NEW.subject_borrower_id IS DISTINCT FROM OLD.subject_borrower_id
     OR NEW.page_count IS DISTINCT FROM OLD.page_count OR NEW.integrity_status IS DISTINCT FROM OLD.integrity_status
     OR NEW.freshness_basis IS DISTINCT FROM OLD.freshness_basis OR NEW.freshness_status IS DISTINCT FROM OLD.freshness_status
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.supersedes_document_id IS DISTINCT FROM OLD.supersedes_document_id
     OR NEW.additional_retention_classes IS DISTINCT FROM OLD.additional_retention_classes OR NEW.purge_eligible_on IS DISTINCT FROM OLD.purge_eligible_on
     OR NEW.pii_flags IS DISTINCT FROM OLD.pii_flags OR NEW.render_engine IS DISTINCT FROM OLD.render_engine OR NEW.render_version IS DISTINCT FROM OLD.render_version
     OR NEW.template_code IS DISTINCT FROM OLD.template_code OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR NEW.text_layer IS DISTINCT FROM OLD.text_layer OR NEW.locale IS DISTINCT FROM OLD.locale
  THEN
    RAISE EXCEPTION 'documents_column_restricted: a write-once column changed on % (only the URI swap, legal_hold, verify_status/last_verified_at and the disposal columns may change)', OLD.id;
  END IF;
  -- (a) the one URI swap
  IF NEW.storage_uri IS DISTINCT FROM OLD.storage_uri OR NEW.stored_generation IS DISTINCT FROM OLD.stored_generation OR (NEW.storage_status = 'stored' AND OLD.storage_status <> 'stored') THEN
    IF NOT (OLD.storage_status = 'staged' AND OLD.storage_uri = 'worm_pending:' || OLD.id::text AND NEW.storage_status = 'stored'
            AND NEW.stored_generation IS NOT NULL AND NEW.storage_uri <> OLD.storage_uri AND NEW.storage_uri NOT LIKE 'worm_pending:%') THEN
      RAISE EXCEPTION 'URI_SWAP_ONCE: storage_uri, storage_status and stored_generation change once, from worm_pending:<id> to the stored URI (document %)', OLD.id;
    END IF;
  END IF;
  -- (b) legal hold, only inside documents.hold
  IF NEW.legal_hold IS DISTINCT FROM OLD.legal_hold THEN
    IF hold_setting IS DISTINCT FROM OLD.id::text THEN
      RAISE EXCEPTION 'documents_column_restricted: legal_hold changes only inside documents.hold (sm.document_hold must name %)', OLD.id;
    END IF;
    SELECT count(*) FILTER (WHERE action = 'placed'), count(*) FILTER (WHERE action = 'released' AND actor_kind = 'human')
      INTO placed_n, released_n FROM document_holds WHERE document_id = OLD.id;
    IF NEW.legal_hold AND placed_n <= released_n THEN
      RAISE EXCEPTION 'documents_column_restricted: legal_hold = true needs an open document_holds{placed} row for %', OLD.id;
    END IF;
    IF NOT NEW.legal_hold AND placed_n > released_n THEN
      RAISE EXCEPTION 'documents_column_restricted: legal_hold = false needs a human document_holds{released} row for every placed matter of % (the released row is written before the flag)', OLD.id;
    END IF;
  END IF;
  -- (c) the integrity unit
  IF NEW.last_verified_at IS DISTINCT FROM OLD.last_verified_at OR NEW.verify_status IS DISTINCT FROM OLD.verify_status THEN
    IF coalesce(current_setting('sm.integrity_run', true), '') = '' THEN
      RAISE EXCEPTION 'documents_column_restricted: verify_status and last_verified_at are the integrity unit''s (sm.integrity_run) — document %', OLD.id;
    END IF;
    IF OLD.verify_status IN ('mismatch', 'missing') AND NEW.verify_status = 'verified' THEN
      RAISE EXCEPTION 'documents_column_restricted: a mismatch never returns to verified by a later run (%) — the corrected object is a new document', OLD.id;
    END IF;
  END IF;
  -- (d) disposal, only inside the attested run
  IF NEW.storage_status = 'disposed' OR NEW.disposed_at IS DISTINCT FROM OLD.disposed_at OR NEW.disposal_run_id IS DISTINCT FROM OLD.disposal_run_id THEN
    IF NEW.storage_status <> 'disposed' OR NEW.disposed_at IS NULL OR NEW.disposal_run_id IS NULL
       OR current_setting('sm.disposal_run', true) IS DISTINCT FROM NEW.disposal_run_id::text OR OLD.storage_status <> 'stored' OR OLD.legal_hold THEN
      RAISE EXCEPTION 'documents_column_restricted: disposal only by the attested 19.1 run (sm.disposal_run) on a stored, unheld row (%)', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS documents_column_restricted ON documents;
CREATE TRIGGER documents_column_restricted BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION documents_column_restricted();

COMMENT ON COLUMN documents.storage_status IS '35.2 state machine: staged (bytes in document_blobs, storage_uri = worm_pending:<id>) → stored (the one URI swap after the drain re-read the object and the hash matched) → disposed (19.1 run with the officer attestation; the row is the tombstone).';
COMMENT ON COLUMN documents.verify_status IS '35.2 overlay: unverified → verified | mismatch | missing per integrity run (documents.verify); a mismatch never returns to verified — the corrected object is a new row with supersedes_document_id.';
COMMENT ON COLUMN documents.payload_hash IS '35.2 rule 2: the canonical-JSON hash of what was rendered (src/notices/render.ts payloadHash); with template_code, template_version and created_at the render idempotency key.';
COMMENT ON TRIGGER documents_column_restricted ON documents IS '35.2 Data model: DELETE refused; UPDATE only for (a) the URI swap once, (b) legal_hold under sm.document_hold, (c) verify_status/last_verified_at under sm.integrity_run, (d) disposal under sm.disposal_run; every other column is write-once.';

COMMIT;
