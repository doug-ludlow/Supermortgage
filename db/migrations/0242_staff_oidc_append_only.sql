-- 0242_staff_oidc_append_only.sql — 35.12 Production posture: staff_oidc_identities as an append-only ledger.
-- 0240 created the table with a mutable revoked_at and UNIQUE (issuer, subject); the convention is append-only (a binding is bound and
-- later revoked by a superseding row), so this file adds `action` ∈ {bound, revoked}, drops the unique constraint in favour of a
-- partial index on the bound rows, and adds the forbid_mutation trigger. PST-06 reads the latest row per (staff_user_id, issuer,
-- subject). 0240 stays as written (append-only in both senses). Retention security_logs_5y; issuer and subject only, never an e-mail.
BEGIN;
ALTER TABLE staff_oidc_identities ADD COLUMN action text NOT NULL DEFAULT 'bound' CHECK (action IN ('bound', 'revoked'));
ALTER TABLE staff_oidc_identities DROP CONSTRAINT staff_oidc_identities_issuer_subject_key;
CREATE INDEX staff_oidc_identities_latest_idx ON staff_oidc_identities (staff_user_id, issuer, subject, created_at DESC);
CREATE TRIGGER staff_oidc_identities_immutable BEFORE UPDATE OR DELETE ON staff_oidc_identities FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON COLUMN staff_oidc_identities.action IS '35.12 PST-06: bound | revoked — the binding in force is the latest row per (staff_user_id, issuer, subject).';
COMMIT;
