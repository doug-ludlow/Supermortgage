-- 0167_documents_fake_inbox_status.sql — 35.2 Documents and artifacts at the 35.5 (cashiering) merge: the column-restricted
-- trigger (0160) meets 35.5's FAKE bank inbox. 35.5's lockbox and ACH-returns ingests read a delivered file from a `documents`
-- row the in-repo FAKE vendor queues at `storage_uri = fake-queue://…` (`metadata.fake_store = '35.5'`, the bytes in
-- `metadata.fake_bytes_b64`) and mark its delivery status in that row's metadata (`status` queued → dequeued → ingested |
-- variance | duplicate | failed, with `dequeued_at`, `batch_id`, `return_file_id`, `duplicate_of`, `error`, `failed_at`) —
-- a nonprod stand-in for the bank's SFTP mailbox, never an artifact of record: the file of record is the row the ingest
-- stores through 35.2's `documents.store` (`worm_pending:<id>` → the stored URI, write-once as 0160 rules). 0160 refused
-- every metadata change; this migration re-creates the function with one more permitted change, (e): on a FAKE inbox row
-- only those status keys may differ — the bytes, the identity keys and every other column stay write-once; every other rule
-- of 0160 ((a)–(d), DELETE refused, the disposal tombstone) is repeated verbatim. Append-only: a new file, 0160 untouched.
BEGIN;

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
  -- (e) the FAKE bank inbox (35.5 lockbox.ts PgFakeLockboxQueue / ach.ts PgFakeOdfiQueue): a delivered file waiting for the ingest
  --     is a `documents` row at `fake-queue://…` whose delivery status the FAKE vendor marks (queued → dequeued → ingested |
  --     variance | duplicate | failed); only those status keys change, the bytes (`fake_bytes_b64`), the identity keys and every
  --     other column stay write-once. The file of record is the row the ingest stores through 35.2 (`worm_pending:` → stored).
  --     (NULL-safe: a row without the fake_store key, or with NULL metadata, is an ordinary row — the guard must refuse, never pass on NULL)
  IF NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    IF NOT coalesce(OLD.storage_uri LIKE 'fake-queue://%' AND coalesce(OLD.metadata->>'fake_store', '') = '35.5'
            AND (NEW.metadata - ARRAY['status', 'dequeued_at', 'batch_id', 'return_file_id', 'duplicate_of', 'error', 'failed_at'])
              = (OLD.metadata - ARRAY['status', 'dequeued_at', 'batch_id', 'return_file_id', 'duplicate_of', 'error', 'failed_at']), false) THEN
      RAISE EXCEPTION 'documents_column_restricted: metadata is write-once on % (only a FAKE inbox row at fake-queue:// marks its delivery status)', OLD.id;
    END IF;
  END IF;
  -- write-once: everything outside (a)–(e)
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.loan_id IS DISTINCT FROM OLD.loan_id OR NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type OR NEW.received_from IS DISTINCT FROM OLD.received_from OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.doc_class IS DISTINCT FROM OLD.doc_class
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

COMMENT ON TRIGGER documents_column_restricted ON documents IS '35.2 Data model: DELETE refused; UPDATE only for (a) the URI swap once, (b) legal_hold under sm.document_hold, (c) verify_status/last_verified_at under sm.integrity_run, (d) disposal under sm.disposal_run, (e) the delivery-status keys of a FAKE bank inbox row at fake-queue:// (35.5); every other column is write-once.';

COMMIT;
