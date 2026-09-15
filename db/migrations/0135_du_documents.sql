-- 0135_du_documents.sql — 23.6 Assemble and emit the DU Specification document
-- (spec/sections/23-desktop-underwriter-and-the-credit-decision/23-6-assemble-and-emit-the-du-specification-document.md "Data model").
--
-- One row per emission of a DU Specification document (MISMO 3.4 Build 324 XML with the DU and ULAD extensions),
-- assembled by src/domain/underwriting/du/emit.ts from the 23.5 graph and persisted by du/persist.ts. The bytes are a
-- `documents` row (kind du_specification_document; the XML text in metadata.xml beside its sha256 — the same place 32.2
-- keeps a letter's text — retention fnma_loan_file_life_plus_4y, Fannie Mae-confidential, never borrower-deliverable);
-- this table carries what 23.1 and 23.7 read back without opening the bytes: the hash (the request hash — rule 6: the
-- hash is the bytes), the specification the tables were generated from, and the counts the `du.document.emitted`
-- payload names. Append-only: a re-emission with identical bytes is a new row with the same hash (23.1's duplicate
-- suppression reads the hash), and a refusal writes nothing here or in `documents` (T4).
--
-- Two references the spec draws as foreign keys are carried as plain columns at this build stage, and said so here
-- rather than left to be found: `casefile_id` is 23.1's casefile identifier (`du_casefiles.casefile_id`, text) and
-- `submission_id` the `du_submissions` row's id — but 23.1 keeps both records in `entity_records` (src/app/tools/
-- section23-1.ts `persist(rt, ctx, "du_casefiles", …)`), so the SQL tables of 0084 hold no row for a live casefile
-- and a REFERENCES clause would refuse every emission. The FKs are added the day 23.1's rows move into 0084's tables.
BEGIN;

CREATE TABLE du_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      uuid NOT NULL REFERENCES applications(id),
  casefile_id         text NOT NULL,                                     -- 23.1 du_casefiles.casefile_id (entity_records at this stage; see header)
  submission_id       uuid,                                              -- the du_submissions row once 23.1 records it (nullable until then)
  document_id         uuid NOT NULL REFERENCES documents(id),            -- the XML bytes (kind du_specification_document)
  sha256              bytea NOT NULL CHECK (octet_length(sha256) = 32),  -- SHA-256 of the UTF-8 document exactly as transmitted = du_submissions.request_hash
  spec_version        text NOT NULL DEFAULT '1.9.3',                     -- tools/build-du.mjs SPEC_VERSION: the DU Specification the six tables were generated from
  mismo_build         text NOT NULL DEFAULT 'B324',
  container_count     int NOT NULL CHECK (container_count >= 0),         -- labelled containers (ASSET, LIABILITY, EXPENSE, LOAN, PARTY, ROLE, EMPLOYER, CURRENT_INCOME_ITEM, …)
  relationship_count  int NOT NULL CHECK (relationship_count >= 0),      -- RELATIONSHIP arcs written (the two disputed arcs are never among them)
  borrower_count      int NOT NULL CHECK (borrower_count >= 0),          -- ROLEs whose PartyRoleType is Borrower (23.7 refuses more than four)
  required_missing    int NOT NULL DEFAULT 0 CHECK (required_missing >= 0), -- DU Map required/conditional points the document lacks, when assembled with conditionality = report (23.7's gate holds it; 0 under refuse)
  emitted_at          timestamptz NOT NULL,
  retention_class     retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX du_documents_application_idx ON du_documents(application_id, emitted_at);
CREATE INDEX du_documents_sha256_idx ON du_documents(sha256);
CREATE INDEX du_documents_document_idx ON du_documents(document_id);
CREATE TRIGGER du_documents_immutable BEFORE UPDATE OR DELETE ON du_documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE du_documents IS '23.6: one row per emission of a DU Specification document (MISMO 3.4 B324 + DU/ULAD extensions) assembled from the 23.5 graph; document_id is the documents row holding the bytes, sha256 the request hash 23.1 carries (the hash is the bytes), the counts the du.document.emitted payload. Append-only; a refusal writes nothing. casefile_id / submission_id reference 23.1 records kept in entity_records at this stage (no FK yet). Retention fnma_loan_file_life_plus_4y; Fannie Mae-confidential.';
COMMENT ON COLUMN du_documents.sha256 IS 'SHA-256 of the emitted UTF-8 bytes (32 raw bytes; hex on the wire and in du.document.emitted). Equal bytes, equal hash: the same graph emitted twice at the same instant is byte-identical (23.6-T7).';
COMMENT ON COLUMN du_documents.required_missing IS '23.6 rule 4 gaps recorded rather than refused: the runtime assembles with conditionality = report until the borrower flow collects every required point (TIN, residence, estate type — section 32 amendments), and 23.7 SM_DU_PREFLIGHT_GATE holds a document with any; the agent''s own assembleDuDocument refuses (T5).';

COMMIT;
