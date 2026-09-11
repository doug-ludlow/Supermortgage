-- 0117_lead_tokens.sql — DELTA-11, the L0 lead session (docs/ux/15-entry-sign-up-and-sign-in.md §4, §6.1).
-- `lead_tokens` maps the opaque `sm_borrower_lead` cookie (HttpOnly; the proxy forwards it as `x-borrower-lead`) to a
-- 20.3 lead: the token itself is never stored (sha256 only, like `sessions.token_hash`), the row carries no loan data and
-- no PII, expires 30 days after creation, and records the party the lead was linked to at L1 (`lead.linked{party_id}`).
-- A lead that expires (`lead.expired`, SM_LEAD_INACTIVITY_EXPIRY_90) has its row purged (32.14 T19).
-- `messages.copy_tokens` (nullable jsonb): the tokens a copy-referenced line needs, the way cards carry theirs — the `entry.resumed`
-- receipt's `{answers}` composed server-side from the lead's facts (32.14 S3); the shell substitutes them at render.
-- Idempotent (IF NOT EXISTS) so a database that applied the first cut re-applies cleanly: `DELETE FROM schema_migrations WHERE version = '0117_lead_tokens'` then db/migrate.sh.
-- `auth_challenges.lead_token_hash` binds a challenge (an OIDC `state`, a code) to the lead token present when it was
-- issued, so a code cannot be replayed onto another visitor's lead (§3). 0116 holds the OIDC schema; nothing else here.
BEGIN;

CREATE TABLE IF NOT EXISTS lead_tokens (
  token_hash        text PRIMARY KEY,                               -- sha256 of the cookie value; the token is never stored
  lead_id           text NOT NULL,                                  -- the 20.3 lead (global entity id; not a uuid before conversion)
  partner_party_id  uuid REFERENCES parties(id),                    -- the partner the lead was opened for (DELTA-15 default or the referral's)
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,                           -- created_at + 30 days
  last_seen_at      timestamptz NOT NULL,
  linked_party_id   uuid REFERENCES parties(id),                    -- null until L1 (`lead.linked{party_id}`)
  linked_at         timestamptz,
  ip                text,
  user_agent        text,
  retention_class   retention_class NOT NULL DEFAULT 'sm_lead_36m'
);
COMMENT ON TABLE lead_tokens IS 'UI-owned (02 §1.6; 32.14 DELTA-11): the anonymous minute''s cookie → lead map. No loan data, no PII; purged when the lead expires.';
CREATE INDEX IF NOT EXISTS lead_tokens_lead_idx ON lead_tokens(lead_id);
CREATE INDEX IF NOT EXISTS lead_tokens_expires_idx ON lead_tokens(expires_at);

ALTER TABLE auth_challenges ADD COLUMN IF NOT EXISTS lead_token_hash text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS copy_tokens jsonb;
COMMENT ON COLUMN messages.copy_tokens IS '32.14 DELTA-11: the tokens a {{copy:key}} line renders with (e.g. entry.resumed''s answers), composed by the API — never loan data, never a demographic value';
COMMENT ON COLUMN auth_challenges.lead_token_hash IS '32.14 §3 / §6.1: the lead token present when the challenge was issued (sha256), so a code or OIDC state is never replayed onto another visitor''s lead';

COMMIT;
