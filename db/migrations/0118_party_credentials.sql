-- 0118_party_credentials.sql — 32.16 DELTA-29, e-mail + password accounts (docs/ux/17-the-conversational-product.md §2.0, §5).
--   party_credentials   one row per party that created an account with an e-mail and a password: the e-mail lowercased and
--                       unique (a servicing-book borrower whose e-mail is on file lands in their own party — resolveOrCreateByDestination),
--                       the password as a salted scrypt hash (docs/ux/17 DELTA-29: Argon2id via `node:crypto` scrypt is acceptable when the
--                       Argon2 native dependency is refused; src/infra/db/borrower-credentials.ts records the parameters), `email_verified_at`
--                       set when the six-digit e-mail code is entered, `failed_attempts` / `locked_until` for the lockout (ten failures →
--                       fifteen minutes). Never the password, never a code.
--   sessions            `auth_method` gains `password`: an L1 session opened without a one-time code (like oidc_google), so `last_l1_at`
--                       stays null and the fresh-L1 rule (01 §5) still asks for a code before money moves.
--   auth_challenges     `kind` gains `email_verify` (the account's e-mail code) and `password_reset` (the forgot-password code) — the same
--                       code path as `otp` (sha256(challenge_id:code), 10 minutes, OTP_MAX_ATTEMPTS, single use).
-- Append-only: 0116 holds the OIDC schema, 0117 the lead tokens; nothing there is edited.
BEGIN;

CREATE TABLE party_credentials (
  party_id            uuid PRIMARY KEY REFERENCES parties(id),
  email               text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash       text NOT NULL,                                       -- scrypt$N$r$p$<salt b64url>$<hash b64url>; never the password
  email_verified_at   timestamptz,
  failed_attempts     int NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE party_credentials IS 'UI-owned (02 §1.6; 32.16 DELTA-29): a borrower party''s e-mail + password account — the e-mail lowercased and unique, the password as a salted scrypt hash, the lockout counters.';
COMMENT ON COLUMN party_credentials.email IS 'pii';
COMMENT ON COLUMN party_credentials.password_hash IS 'scrypt (N=2^15, r=8, p=1, 32-byte salt) — Argon2id''s stand-in because the native dependency is not admitted into the runtime image (docs/ux/17 DELTA-29)';

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_auth_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_method_check CHECK (auth_method IN ('otp_phone', 'otp_email', 'passkey', 'oidc_google', 'password'));

ALTER TABLE auth_challenges DROP CONSTRAINT IF EXISTS auth_challenges_kind_check;
ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_kind_check CHECK (kind IN ('otp', 'passkey_registration', 'passkey_assertion', 'oidc', 'email_verify', 'password_reset'));

COMMIT;
