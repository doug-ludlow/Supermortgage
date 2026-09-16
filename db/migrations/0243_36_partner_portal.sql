-- 0243_36_partner_portal.sql — 36.1 Partner identity, doors, roles, action log, tenant scope
-- (spec/sections/36-servicing-partner-portal/36-1-partner-identity-doors-roles-action-log-tenant-scope.md, Data model).
-- The four tables copy the SHAPE of 34.1's staff tables (db/migrations/0127_staff.sql) and share none of them: a partner user is
-- never a row in staff_users, a partner session never a row in staff_sessions, a partner request never a row in staff_actions.
--   partner_users        one row per person at a servicer partner, bound to ONE parties{party_type = servicer} row (33.1's partner)
--                        and nothing else. The brief's `email` (normalized) is stored encrypted at rest as the template requires —
--                        `email_encrypted` (AES-256-GCM under the staff e-mail key, a FAKE key outside production) — with the lookup
--                        by normalized value through `email_hash` (sha-256 of the lowercased, trimmed address); unique per tenant.
--                        `name` is pii. `roles` ⊆ {partner_admin, partner_ops, partner_auditor} — the three partner roles, never a
--                        StaffRole. The state machine invited → active → disabled (a disable is DELTA-01). `failed_signins` /
--                        `locked_until` / `last_failed_at` carry rule 1's lockout (five failures in an hour lock the account 15
--                        minutes). Retention corporate_7y.
--   partner_credentials  kind password (the scrypt hash of src/infra/db/borrower-credentials.ts hashPassword — the hasher the staff
--                        door uses) and kind passkey (`secret_hash` holds the credential id, the COSE public key as JWK, the
--                        algorithm and the sign count as JSON). A revoked credential keeps its row.
--   partner_sessions     the portal session (rule 6): `id` (the cookie sm_partner_session on the app, the Authorization: Bearer on
--                        the API, stored only as `token_hash` — Open question 1's default: the same shape as 34.1's session row),
--                        `partner_party_id` (the tenant every query of the session is scoped to — rule 4), `role` (the acting role:
--                        the least-privileged role held — rule 3), the factors it opened with (TWO_FACTORS), `expires_at` = the idle
--                        deadline (last_seen_at + 30 minutes, never past created_at + 12 hours), `revoked_at` on sign-out, disable,
--                        role change or expiry. Retention security_logs_5y.
--   partner_actions      APPEND-ONLY (rule 5): one row per /v1/partner/* request — the person, the tenant, the role that acted (on a
--                        refusal the role asked for), `action` (`partner_portal.viewed` for a read, the bus command name for an act,
--                        `partner_portal.door` for a door route with no session), `subject_kind` (the view for a read — home, book,
--                        import, holds, eligibility, pipeline, pipeline.loan, loan, serviced, report, report.export, users, me — the
--                        subject's kind for an act), `subject_id`, `result` ∈ {ok, refused}, `refusal_code`. NO PII COLUMN: never a
--                        homeowner's name, e-mail or phone, never a money figure, never a filter's text. Written once, when the
--                        request completes (`at` is the request's start instant) — the table is append-only, so "written before the
--                        handler runs and completed with the result" is one insert that carries both. Retention security_logs_5y.
--   auth_challenges      reused for the partner code and the passkey challenges (rule 1; 32.2's OTP path, as 34.1 reused it):
--                        `subject_kind` gains 'partner' beside 0127's 'party' | 'staff'; `partner_user_id` names the partner user
--                        (party_id and staff_user_id stay null); `challenge` on a consumed partner otp row holds the sha-256 of the
--                        enrol/step token it yielded. No third OTP table.
-- Four base tables (src/infra/db/db.test.ts counts 863 through 0243). Append-only: 0127 is not edited; the check is re-declared here.
BEGIN;

CREATE TABLE partner_users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_party_id  uuid NOT NULL REFERENCES parties(id),                   -- 33.1's parties{party_type = servicer} row: the tenant
  email_hash        text NOT NULL,                                          -- sha256(lower(trim(email))): the lookup by normalized value
  email_encrypted   bytea NOT NULL,                                         -- the brief's `email`, encrypted at rest: AES-256-GCM (iv || tag || ciphertext) under STAFF_EMAIL_KEY (a FAKE key outside production)
  name              text,
  roles             text[] NOT NULL DEFAULT '{}' CHECK (roles <@ ARRAY['partner_admin', 'partner_ops', 'partner_auditor']::text[]),
  status            text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  invited_by        uuid REFERENCES partner_users(id),                      -- the partner_admin who invited; null when staff or the seed provisioned the row
  invited_by_actor  text,                                                   -- the inviting actor as `kind:id` (staff ops_analyst / admin, the seed's system actor, or the partner_admin's id)
  invited_at        timestamptz,
  enrolled_at       timestamptz,
  disabled_at       timestamptz,
  failed_signins    int NOT NULL DEFAULT 0,                                 -- rule 1: reset on a successful sign-in
  locked_until      timestamptz,                                            -- rule 1: the fifth failure sets now + 15 minutes
  last_failed_at    timestamptz,                                            -- rule 1: failures older than an hour restart the count
  created_at        timestamptz NOT NULL DEFAULT now(),
  retention_class   retention_class NOT NULL DEFAULT 'corporate_7y',
  UNIQUE (partner_party_id, email_hash)
);
CREATE INDEX partner_users_email_idx ON partner_users(email_hash);
CREATE INDEX partner_users_tenant_idx ON partner_users(partner_party_id, status);
COMMENT ON TABLE partner_users IS '36.1: a servicer partner''s people — one row per person per tenant (parties{servicer}); the e-mail is hashed and encrypted, never in clear; roles are the three partner roles, never a staff role.';
COMMENT ON COLUMN partner_users.email_encrypted IS 'pii';
COMMENT ON COLUMN partner_users.name IS 'pii';

CREATE TABLE partner_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_user_id   uuid NOT NULL REFERENCES partner_users(id),
  kind              text NOT NULL CHECK (kind IN ('password', 'passkey')),
  secret_hash       text NOT NULL,                                          -- password: scrypt$N$r$p$salt$key; passkey: {"credential_id","public_key_jwk","algorithm","sign_count","transports"}
  label             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  retention_class   retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX partner_credentials_user_idx ON partner_credentials(partner_user_id, kind) WHERE revoked_at IS NULL;
COMMENT ON TABLE partner_credentials IS '36.1 rule 1: the password (knowledge factor) and the passkeys (possession factor) of a partner user — the shape of 34.1''s staff_credentials, never the staff table; a code alone never opens a session.';

CREATE TABLE partner_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_user_id   uuid NOT NULL REFERENCES partner_users(id),
  partner_party_id  uuid NOT NULL REFERENCES parties(id),                   -- the tenant: every query of the session carries it (rule 4)
  role              text NOT NULL CHECK (role IN ('partner_admin', 'partner_ops', 'partner_auditor')),   -- the acting role: the session's default, the least-privileged held (rule 3)
  token_hash        text NOT NULL UNIQUE,                                   -- sha256 of the bearer; the token itself is never stored
  factors           text[] NOT NULL CHECK (factors <@ ARRAY['email_code', 'passkey', 'password']::text[]),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,                                   -- min(last_seen_at + 30 minutes, created_at + 12 hours)
  revoked_at        timestamptz,
  ip                text,
  user_agent        text,
  retention_class   retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX partner_sessions_user_idx ON partner_sessions(partner_user_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE partner_sessions IS '36.1 rule 6: a partner portal session — 30 minutes idle, 12 hours absolute, revoked on sign-out, disable, role change or expiry; bound to one partner_party_id and never switches.';

CREATE TABLE partner_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at                timestamptz NOT NULL,                                   -- the request's start instant
  partner_user_id   uuid REFERENCES partner_users(id),                      -- null on a door route (no session yet)
  partner_party_id  uuid REFERENCES parties(id),                            -- null on a door route
  role              text,                                                   -- the role that acted; on a refusal the role that was asked for; null on a door route
  action            text NOT NULL,                                          -- partner_portal.viewed (a read) | the bus command name (an act) | partner_portal.door (a door route)
  subject_kind      text,                                                   -- the view for a read (home, book, import, holds, eligibility, pipeline, pipeline.loan, loan, serviced, report, report.export, users, me); the subject's kind for an act
  subject_id        text,
  result            text NOT NULL CHECK (result IN ('ok', 'refused')),
  refusal_code      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  retention_class   retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX partner_actions_tenant_idx ON partner_actions(partner_party_id, at);
CREATE INDEX partner_actions_user_idx ON partner_actions(partner_user_id, at);
CREATE INDEX partner_actions_at_idx ON partner_actions(at);
CREATE TRIGGER partner_actions_immutable BEFORE UPDATE OR DELETE ON partner_actions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE partner_actions IS '36.1 rule 5: the partner action log — one append-only row per /v1/partner/* request, ids and the role only (NO_PII_IN_LOG: never a homeowner''s name, e-mail or phone, a money figure or a filter''s text); exported by staff through 34.4''s evidence pack, retained five years.';

-- 36.1 rule 1 / Data model: the e-mail code and the passkey challenges reuse auth_challenges with subject_kind = partner (0127 listed party | staff)
ALTER TABLE auth_challenges DROP CONSTRAINT auth_challenges_subject_kind_check;
ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_subject_kind_check CHECK (subject_kind IN ('party', 'staff', 'partner'));
ALTER TABLE auth_challenges ADD COLUMN partner_user_id uuid REFERENCES partner_users(id);
CREATE INDEX auth_challenges_partner_idx ON auth_challenges(partner_user_id, kind, created_at) WHERE subject_kind = 'partner';
COMMENT ON COLUMN auth_challenges.subject_kind IS '32.2: party (the borrower doors, default); 34.1: staff (the operator portal''s code and passkey challenges — party_id null, staff_user_id set); 36.1: partner (the partner portal''s — partner_user_id set)';

COMMIT;
