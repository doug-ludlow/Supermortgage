-- 0116_entry_sign_in.sql — 32.14 Entry, sign-up and sign-in (docs/ux/15-entry-sign-up-and-sign-in.md §3, §6.1; DELTA-12):
-- Sign in with Google (OpenID Connect, Authorization Code + PKCE on the server).
--   oidc_identities   the provider's stable subject (`sub`) keyed to a borrower party — the e-mail resolves the party only
--                     because the provider verified it (`email_verified`), and later sign-ins resolve by `sub` even when the
--                     e-mail changed. `retention_class` starts at sm_lead_36m and is promoted with the conversation's class
--                     (PgBorrowerUiRepository.setRetentionClass), like the other UI-owned rows (02 §1.6).
--   sessions          `auth_method` gains `oidc_google`: an L1 session opened without a one-time code, so `last_l1_at` stays
--                     null and the fresh-L1 rule (01 §5) still asks for a code before money moves.
--   auth_challenges   `kind` gains `oidc`; `provider` names the identity provider, `challenge` carries the OAuth `state`,
--                     `nonce` the id-token nonce, `code_verifier_hash` sha256 of the PKCE verifier (the verifier itself is
--                     derived from the router's secret and the row — never stored, never serialized), `destination` the
--                     redirect URI the code went to. 10 minutes, single use (consumed_at).
-- DELTA-11's `lead_tokens` and `auth_challenges.lead_token_hash` are migration 0117's (append-only: one concern per file).
BEGIN;

CREATE TABLE oidc_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id          uuid NOT NULL REFERENCES parties(id),
  issuer            text NOT NULL,                                        -- https://accounts.google.com
  subject           text NOT NULL,                                        -- the provider's stable `sub`
  email             text,
  email_verified    boolean NOT NULL DEFAULT false,
  name              text,
  first_seen_at     timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL,
  revoked_at        timestamptz,
  retention_class   retention_class NOT NULL DEFAULT 'sm_lead_36m',
  UNIQUE (issuer, subject)
);
COMMENT ON TABLE oidc_identities IS 'UI-owned (02 §1.6; 32.14 §6.1 DELTA-12): a borrower party keyed on an OpenID Connect (issuer, subject); the party is resolved by the verified e-mail on the first sign-in and by `sub` afterwards.';
COMMENT ON COLUMN oidc_identities.email IS 'pii';
COMMENT ON COLUMN oidc_identities.name IS 'pii; the provider''s display name — the party''s provisional legal name (prefill source oidc_google, confirmed_at null until the identity ConfirmCard)';
CREATE INDEX oidc_identities_party_idx ON oidc_identities(party_id) WHERE revoked_at IS NULL;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_auth_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_method_check CHECK (auth_method IN ('otp_phone', 'otp_email', 'passkey', 'oidc_google'));

ALTER TABLE auth_challenges DROP CONSTRAINT IF EXISTS auth_challenges_kind_check;
ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_kind_check CHECK (kind IN ('otp', 'passkey_registration', 'passkey_assertion', 'oidc'));
ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS provider            text,                     -- google
  ADD COLUMN IF NOT EXISTS nonce               text,                     -- the id-token nonce the callback must echo
  ADD COLUMN IF NOT EXISTS code_verifier_hash  text;                     -- sha256(PKCE code_verifier); never the verifier
COMMENT ON COLUMN auth_challenges.challenge IS 'WebAuthn challenge (base64url), or the OAuth `state` of an oidc challenge';
CREATE INDEX auth_challenges_oidc_state_idx ON auth_challenges(provider, challenge) WHERE kind = 'oidc';

COMMIT;
