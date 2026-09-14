-- 0127_staff.sql — 34.1 Staff sign-in and roles: accounts, the doors, the action log, the access review
-- (spec/sections/34-operator-portal/34-1-staff-sign-in-and-roles-accounts-the-doors-the-action-log-the-access-review.md, Data model).
--   staff_users            one row per member of Supermortgage's own staff (internal only — no partner users): the e-mail as a
--                          sha-256 hash (unique, never the address) and AES-256-GCM encrypted (the door needs the address to send
--                          a code), the roles ⊆ {ops_analyst, officer, compliance, admin}, the state machine invited → active →
--                          disabled (rule 2 / state machine). `failed_signins` / `locked_until` carry rule 1's lockout ("five failed
--                          sign-ins lock the account for 15 minutes") — an account state, kept on the account row. Retention corporate_7y.
--   staff_credentials      the knowledge factor (kind password: an scrypt hash — src/infra/db/borrower-credentials.ts hashPassword,
--                          the borrower side's hasher, whose module comment records why Argon2id's native dependency is not admitted)
--                          and the possession factor a passkey gives (kind passkey: `secret_hash` holds the credential id, the COSE
--                          public key as JWK, the algorithm and the sign count as JSON). A revoked credential keeps its row.
--   staff_sessions         the portal session (rule 5): the bearer / `sm_staff` cookie stored only as its sha-256, the factors the
--                          session opened with (`{email_code, password}` or `{passkey, password}` — TWO_FACTORS), `expires_at` = the
--                          idle deadline (last_seen_at + 30 minutes, never past created_at + 12 hours), `revoked_at` on sign-out, role
--                          change, disable or expiry. Retention security_logs_5y.
--   staff_actions          APPEND-ONLY (rule 4): one row per /ops/api request — route, method, subject ids, the bus command when one
--                          ran, the result and the refusal code. Ids only: never a name, an e-mail, a phone or a figure (NO_PII_IN_LOG;
--                          the query string is stripped of `email`). Because the table is append-only the row is written ONCE, when the
--                          request completes (`at` is the request's start instant), so "before the handler runs, completed with the
--                          result" is one insert that carries both. Retention security_logs_5y.
--   staff_access_reviews   APPEND-ONLY (rule 6): the quarterly review — the reviewer, the instant and every active user's roles with
--                          the decision keep | change | disable (the changes themselves run through staff.role.set / staff.disable).
--   auth_challenges        reused for the staff code and the passkey challenges (rule 1; 32.2's OTP path): `subject_kind` = 'party'
--                          (the borrower rows, the default) | 'staff'; `staff_user_id` names the staff member (party_id stays null);
--                          `challenge` on a consumed staff otp row holds the sha-256 of the enrol/step token it yielded.
-- Five base tables (src/infra/db/db.test.ts counts 761 through 0127). Append-only: 0126 holds agent_turns' analyst channel; nothing there is edited.
BEGIN;

CREATE TABLE staff_users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash        text NOT NULL UNIQUE,                                   -- sha256(lower(trim(email))); the address itself is never a column in clear
  email_encrypted   bytea NOT NULL,                                         -- AES-256-GCM (iv || tag || ciphertext) under STAFF_EMAIL_KEY (a FAKE key outside production)
  legal_name        text,
  roles             text[] NOT NULL DEFAULT '{}' CHECK (roles <@ ARRAY['ops_analyst', 'officer', 'compliance', 'admin']::text[]),
  status            text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  invited_by        uuid REFERENCES staff_users(id),                        -- null for the bootstrap admin (main.ts staff-bootstrap / STAFF_BOOTSTRAP_ADMIN_EMAIL)
  invited_at        timestamptz,
  enrolled_at       timestamptz,
  disabled_at       timestamptz,
  failed_signins    int NOT NULL DEFAULT 0,                                 -- rule 1: reset on a successful sign-in
  locked_until      timestamptz,                                            -- rule 1: the fifth failure sets now + 15 minutes
  created_at        timestamptz NOT NULL DEFAULT now(),
  retention_class   retention_class NOT NULL DEFAULT 'corporate_7y'
);
COMMENT ON TABLE staff_users IS '34.1 staff accounts (Supermortgage''s own staff; internal only). The e-mail is hashed and encrypted, never in clear.';
COMMENT ON COLUMN staff_users.email_encrypted IS 'pii';

CREATE TABLE staff_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id     uuid NOT NULL REFERENCES staff_users(id),
  kind              text NOT NULL CHECK (kind IN ('password', 'passkey')),
  secret_hash       text NOT NULL,                                          -- password: scrypt$N$r$p$salt$key; passkey: {"credential_id","public_key_jwk","algorithm","sign_count","transports"}
  label             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  retention_class   retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX staff_credentials_user_idx ON staff_credentials(staff_user_id, kind) WHERE revoked_at IS NULL;
COMMENT ON TABLE staff_credentials IS '34.1 rule 1: the password (knowledge factor) and the passkeys (possession factor) of a staff member; a code alone never opens a session.';

CREATE TABLE staff_sessions (
  session_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id     uuid NOT NULL REFERENCES staff_users(id),
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
CREATE INDEX staff_sessions_user_idx ON staff_sessions(staff_user_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE staff_sessions IS '34.1 rule 5: a portal session — 30 minutes idle, 12 hours absolute, revoked on sign-out, role change, disable or expiry.';

CREATE TABLE staff_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id     uuid REFERENCES staff_users(id),                        -- null before a session exists (the door routes) or for the deploy workflow's header actor
  session_id        uuid REFERENCES staff_sessions(session_id),
  at                timestamptz NOT NULL,                                   -- the request's start instant
  route             text NOT NULL,                                          -- the path; the query string without `email`
  method            text NOT NULL,
  subject_kind      text,
  subject_id        text,
  command           text,                                                   -- the bus command when one ran (staff.invite, 20.2 campaign.approve, …)
  result            text NOT NULL CHECK (result IN ('ok', 'refused', 'error')),
  refusal_code      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  retention_class   retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX staff_actions_user_idx ON staff_actions(staff_user_id, at);
CREATE INDEX staff_actions_at_idx ON staff_actions(at);
CREATE TRIGGER staff_actions_immutable BEFORE UPDATE OR DELETE ON staff_actions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE staff_actions IS '34.1 rule 4: the action log — one append-only row per portal request, ids only (NO_PII_IN_LOG); exported by the evidence pack (34.4), retained five years.';

CREATE TABLE staff_access_reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewed_by       uuid NOT NULL REFERENCES staff_users(id),
  reviewed_at       timestamptz NOT NULL,
  users             jsonb NOT NULL,                                         -- [{staff_user_id, roles_before, decision: keep|change|disable, roles_after}]
  created_at        timestamptz NOT NULL DEFAULT now(),
  retention_class   retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE TRIGGER staff_access_reviews_immutable BEFORE UPDATE OR DELETE ON staff_access_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE staff_access_reviews IS '34.1 rule 6: the quarterly access review (SM_STAFF_ACCESS_REVIEW_90) — every active user''s roles and the reviewer''s decision; append-only.';

-- 34.1 rule 1 / Data model: the e-mail code and the passkey challenges reuse auth_challenges with subject_kind = staff
ALTER TABLE auth_challenges ADD COLUMN subject_kind text NOT NULL DEFAULT 'party' CHECK (subject_kind IN ('party', 'staff'));
ALTER TABLE auth_challenges ADD COLUMN staff_user_id uuid REFERENCES staff_users(id);
CREATE INDEX auth_challenges_staff_idx ON auth_challenges(staff_user_id, kind, created_at) WHERE subject_kind = 'staff';
COMMENT ON COLUMN auth_challenges.subject_kind IS '32.2: party (the borrower doors, default); 34.1: staff (the operator portal''s code and passkey challenges — party_id null, staff_user_id set)';

COMMIT;
