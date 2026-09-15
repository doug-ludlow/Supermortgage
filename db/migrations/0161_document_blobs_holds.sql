-- 0161_document_blobs_holds.sql — 35.2 Documents and artifacts: the staged bytes and the legal-hold log
-- (spec/sections/35-operations-runtime/35-2-documents-and-artifacts.md, "Data model": `document_blobs` (new; write-once
-- bytes), `document_holds` (new; append-only)).
--
-- `document_blobs` is the staged copy every `documents.store` writes in the command's transaction (rule 4 "staging first,
-- always") and, in every nonprod stage, the FAKE object store's bucket itself (`fake-blob://<document_id>#<generation>`
-- resolves to this row — Discrepancy 4). Trigger: UPDATE permitted only to set `drained_at`/`drain_generation` once, to bump
-- `drain_attempts`/`last_drain_error`, and to null `content` once after the drain in production (`sm.environment`) or by the
-- attested disposal run (`sm.disposal_run`, so the tombstone's bytes are gone in every stage); DELETE refused.
-- `document_holds` is the two-sided hold log (rule 5): a `placed` row by an agent or a human, a `released` row by a human
-- `compliance` or `counsel` actor only (HOLD_RELEASE_HUMAN_ONLY, enforced by the CHECK); append-only (forbid_mutation).
BEGIN;

CREATE TABLE document_blobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id        uuid NOT NULL UNIQUE REFERENCES documents(id),
  sha256             char(64) NOT NULL,
  byte_size          bigint NOT NULL,
  mime_type          text NOT NULL,
  content            bytea,                                    -- the staged bytes; NULL only after a production drain + 7 days, or after disposal
  staged_at          timestamptz NOT NULL,
  drained_at         timestamptz,
  drain_generation   text,
  drain_attempts     int NOT NULL DEFAULT 0,
  last_drain_error   text,
  hold_ref           text,                                     -- the object store's temporary-hold reference the drain placed for a row held while staged (document_holds is append-only)
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE document_blobs IS '35.2: the staged copy of every stored artifact (write-once bytes); in nonprod the FAKE object store''s bucket (PgFakeBlobStore, src/infra/blobs/pg-fake-blob-store.ts).';

CREATE OR REPLACE FUNCTION document_blobs_update_restricted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document_blobs_update_restricted: document_blobs is write-once — DELETE refused (document %)', OLD.document_id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size OR NEW.mime_type IS DISTINCT FROM OLD.mime_type OR NEW.staged_at IS DISTINCT FROM OLD.staged_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'document_blobs_update_restricted: a write-once column changed (document %)', OLD.document_id;
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content THEN
    IF NOT (NEW.content IS NULL AND OLD.content IS NOT NULL
            AND ((OLD.drained_at IS NOT NULL AND current_setting('sm.environment', true) = 'production')
                 OR coalesce(current_setting('sm.disposal_run', true), '') <> '')) THEN
      RAISE EXCEPTION 'document_blobs_update_restricted: content is write-once; it is nulled only after a production drain or by the attested disposal run (document %)', OLD.document_id;
    END IF;
  END IF;
  IF OLD.drained_at IS NOT NULL AND (NEW.drained_at IS DISTINCT FROM OLD.drained_at OR NEW.drain_generation IS DISTINCT FROM OLD.drain_generation) THEN
    RAISE EXCEPTION 'document_blobs_update_restricted: drained_at and drain_generation are set once (document %)', OLD.document_id;
  END IF;
  IF NEW.drain_attempts < OLD.drain_attempts THEN
    RAISE EXCEPTION 'document_blobs_update_restricted: drain_attempts never decreases (document %)', OLD.document_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_blobs_update_restricted BEFORE UPDATE OR DELETE ON document_blobs FOR EACH ROW EXECUTE FUNCTION document_blobs_update_restricted();

CREATE TABLE document_holds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigserial NOT NULL UNIQUE,                     -- the append order (a place and its release in one transaction share created_at)
  document_id    uuid NOT NULL REFERENCES documents(id),
  action         text NOT NULL CHECK (action IN ('placed', 'released')),
  reason         text NOT NULL,
  matter_ref     text NOT NULL,                                 -- litigation, subpoena, records request or MORA reference (19.1 records_requests.hold_id)
  actor_kind     actor_kind NOT NULL,
  actor_id       text NOT NULL,
  actor_role     text,
  blob_hold_ref  text,                                          -- the object store's hold acknowledgement; FAKE:hold:<n> in nonprod; NULL while the document is staged
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (action <> 'released' OR (actor_kind = 'human' AND actor_role IN ('compliance', 'counsel')))
);
CREATE INDEX document_holds_document_idx ON document_holds (document_id, seq);
CREATE TRIGGER document_holds_immutable BEFORE UPDATE OR DELETE ON document_holds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE document_holds IS '35.2 rule 5: every hold is a placed/released pair per matter; a released row requires a human compliance or counsel actor (HOLD_RELEASE_HUMAN_ONLY); append-only.';

COMMIT;
