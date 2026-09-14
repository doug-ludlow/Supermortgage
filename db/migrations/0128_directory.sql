-- 0128_directory.sql — 34.2 The account directory: every person, their activity and their record, masked by role
-- (spec/sections/34-operator-portal/34-2-the-account-directory-every-person-their-activity-and-their-record-masked-by-role.md, Data model).
--   directory_unmasks      APPEND-ONLY: a time-boxed unmask (rule 2) — the staff member, their portal session, the party, the
--                          fields (`contact` = the full e-mail and phone; `identity` = the SSN last four and the date of birth),
--                          the reason, granted_at and expires_at = granted_at + 15 minutes (state machine: granted → expired by
--                          the clock or the sign-out; the row itself never changes — an expired row is one whose expires_at has
--                          passed or whose staff session is revoked). Retention security_logs_5y.
--   directory_exports      APPEND-ONLY: one row per one-person evidence pack (rule 5) — the staff member, the party, the document
--                          on `documents` and its sha256. Retention security_logs_5y.
--   the search index       rule 4 / Discrepancy (1): "a generated column or materialized index over normalized e-mail, E.164 phone
--                          and lower-cased legal name on `parties` … no new table". Three expression indexes on the borrower rows
--                          of `parties`, each over the normalized form the directory searches by prefix (text_pattern_ops):
--                          lower(contact->>'email'), directory_e164(contact->>'phone') — the same normalization as
--                          src/infra/db/borrower-parties.ts normalizePhone, as an IMMUTABLE SQL function so it can be indexed —
--                          and lower(legal_name). The `emails` / `phones` lists a second destination lands in (attachDestination)
--                          are searched without the index (they are rare; the scan is bounded by the borrower rows).
-- Two base tables (src/infra/db/db.test.ts counts 763 through 0128). Nothing existing is edited.
BEGIN;

-- the E.164 normalization of src/infra/db/borrower-parties.ts normalizePhone, indexable
CREATE FUNCTION directory_e164(p text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN s.d = '' THEN NULL
    WHEN left(btrim(p), 1) = '+' THEN '+' || s.d
    WHEN length(s.d) = 10 THEN '+1' || s.d
    WHEN length(s.d) = 11 AND left(s.d, 1) = '1' THEN '+' || s.d
    ELSE s.d
  END
  FROM (SELECT regexp_replace(p, '[^0-9]', '', 'g') AS d) s
$$;
COMMENT ON FUNCTION directory_e164(text) IS '34.2 rule 4: the E.164 form the directory indexes and searches (normalizePhone in SQL).';

CREATE INDEX parties_directory_email_idx ON parties (lower(contact->>'email') text_pattern_ops) WHERE party_type = 'borrower';
CREATE INDEX parties_directory_phone_idx ON parties (directory_e164(contact->>'phone') text_pattern_ops) WHERE party_type = 'borrower';
CREATE INDEX parties_directory_name_idx  ON parties (lower(legal_name) text_pattern_ops) WHERE party_type = 'borrower';

CREATE TABLE directory_unmasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id     uuid NOT NULL,                                          -- staff_users(id) — not a foreign key so a test or the deploy workflow's header actor can be named without a staff row
  session_id        uuid,                                                   -- staff_sessions(session_id): the unmask is for that session (a sign-out ends it)
  party_id          uuid NOT NULL REFERENCES parties(id),
  fields            text[] NOT NULL CHECK (fields <@ ARRAY['contact', 'identity']::text[] AND cardinality(fields) > 0),
  reason            text NOT NULL CHECK (btrim(reason) <> ''),
  granted_at        timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,                                   -- granted_at + 15 minutes
  created_at        timestamptz NOT NULL DEFAULT now(),
  retention_class   retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX directory_unmasks_lookup_idx ON directory_unmasks(staff_user_id, party_id, expires_at);
CREATE INDEX directory_unmasks_day_idx ON directory_unmasks(staff_user_id, granted_at);
CREATE TRIGGER directory_unmasks_immutable BEFORE UPDATE OR DELETE ON directory_unmasks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE directory_unmasks IS '34.2 rule 2: a 15-minute unmask of contact and/or identity for one staff session with a reason; append-only, exported by the evidence pack.';

CREATE TABLE directory_exports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id     uuid NOT NULL,
  party_id          uuid NOT NULL REFERENCES parties(id),
  document_id       uuid NOT NULL REFERENCES documents(id),                 -- the pack
  sha256            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  retention_class   retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX directory_exports_party_idx ON directory_exports(party_id, created_at);
CREATE TRIGGER directory_exports_immutable BEFORE UPDATE OR DELETE ON directory_exports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE directory_exports IS '34.2 rule 5: the one-person evidence pack — who exported whom, the document and its hash; append-only.';

COMMIT;
