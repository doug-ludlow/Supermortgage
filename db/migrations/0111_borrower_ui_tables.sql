-- 0111_borrower_ui_tables.sql — the borrower surface's UI-owned tables (docs/ux/02-data-contracts.md §1.6; docs/ux/01-foundations.md §5, §6.1, §6.5, §9).
-- Owned here: conversations, messages (append-only), card_instances + card_instance_events (status transitions append),
-- deep_links, ui_events (append-only), sessions (01 §5 levels L1/L2/L3), plus the two identity tables §5 needs behind
-- the OTP/passkey routes (auth_challenges, passkey_credentials). Shared tables are REUSED, never redefined: parties
-- (0001) gains the `borrower` party type so a borrower is a party (02 §6: "party_id ∈ the subject's
-- application_borrowers/borrowers or a parties row with party_role"); application_borrowers (0057) and borrowers
-- (0001) gain the `party_id` link that scoping resolves through, and application_borrowers gains `prefill` — the
-- Stripe Identity extraction written "as source=stripe_identity pending confirmation" (01 §5 L3) until the borrower's
-- ConfirmCard commits it; notice_deliveries (0009) gains the `esign_portal` channel and the `card_instance_id` /
-- `rendered_document_id` delivery evidence (DELTA-08). Retention follows the owning record's class (02 §6 last bullet):
-- `sm_lead_36m` for pre-application conversations, `fnma_loan_file_life_plus_4y` once an application exists —
-- the UI rows carry the class column so 19.x/31.3 purge logic reads it like every other table.
-- Enum values are added outside the transaction (0100's rule: Postgres refuses a new value used as a DEFAULT in the
-- transaction that added it).
ALTER TYPE party_type ADD VALUE IF NOT EXISTS 'borrower';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'sm_lead_36m';
BEGIN;

-- ───────────────────────────── the party link (02 §6 party scoping) ─────────────────────────────
ALTER TABLE application_borrowers ADD COLUMN IF NOT EXISTS party_id uuid REFERENCES parties(id);
CREATE INDEX IF NOT EXISTS application_borrowers_party_idx ON application_borrowers(party_id) WHERE party_id IS NOT NULL;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS party_id uuid REFERENCES parties(id);
CREATE INDEX IF NOT EXISTS borrowers_party_idx ON borrowers(party_id) WHERE party_id IS NOT NULL;
-- L3 (01 §5): name / DOB / address extracted by Stripe Identity land here as {path: {value, source, extracted_at, confirmed_at}} and
-- count only once the ConfirmCard commits them (O2.1 rule 1); `source` is the ConfirmCard's source vocabulary (stripe_identity, …).
ALTER TABLE application_borrowers ADD COLUMN IF NOT EXISTS prefill jsonb NOT NULL DEFAULT '{}';
COMMENT ON COLUMN application_borrowers.prefill IS 'pii; 01 §5 L3 / 01 §3.3 ConfirmCard: {legal_name|date_of_birth|address: {value, source ∈ stripe_identity|credit_report|…, extracted_at, confirmed_at|null}} — prefilled, not yet submitted, until confirmed_at is set';

-- ───────────────────────────── conversations (one per party; 01 §6.1) ─────────────────────────────
CREATE TABLE conversations (
  conversation_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id          uuid NOT NULL REFERENCES parties(id),
  locale            text NOT NULL DEFAULT 'en-US',
  timezone          text NOT NULL DEFAULT 'America/New_York',
  retention_class   retention_class NOT NULL DEFAULT 'sm_lead_36m',   -- fnma_loan_file_life_plus_4y once an application exists (02 §6)
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (party_id)
);
COMMENT ON TABLE conversations IS 'UI-owned (02 §1.6): one conversation per party; the same thread continues across origination, servicing and refinances (01 §6.1).';

-- ───────────────────────────── messages (append-only) ─────────────────────────────
CREATE TABLE messages (
  message_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id         uuid NOT NULL REFERENCES conversations(conversation_id),
  at                      timestamptz NOT NULL,
  sender                  text NOT NULL CHECK (sender IN ('borrower', 'agent', 'human', 'notice', 'system')),
  sender_ref              text,                                            -- agent name, personnel id, notice id
  channel                 text NOT NULL CHECK (channel IN ('app', 'sms', 'email', 'voice', 'mail')),
  body_text               text,
  card_instance_id        uuid,                                            -- FK added after card_instances
  subject_application_id  uuid REFERENCES applications(id),
  subject_loan_id         uuid REFERENCES loans(id),
  external_ref            text,                                            -- twilio sid / email message id
  voice_turn              boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN messages.body_text IS 'pii';
CREATE INDEX messages_conversation_idx ON messages(conversation_id, at);
CREATE TRIGGER messages_immutable BEFORE UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── card_instances (01 §3 CardBase) + card_instance_events (transitions append) ─────────────────────────────
CREATE TABLE card_instances (
  card_instance_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id         uuid NOT NULL REFERENCES conversations(conversation_id),
  party_id                uuid NOT NULL REFERENCES parties(id),
  subject_application_id  uuid REFERENCES applications(id),
  subject_loan_id         uuid REFERENCES loans(id),
  kind                    text NOT NULL,                                   -- StatusCard | ChoiceCard | ConfirmCard | ConnectCard | ConsentCard | DocumentCard | … (01 §3)
  status                  text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'expired', 'superseded', 'cancelled')),
  created_by              text NOT NULL,                                   -- agent:<name> | human:<role> | system
  copy_key                text NOT NULL,                                   -- 12-message-copy-library
  props                   jsonb NOT NULL DEFAULT '{}',
  evidence                jsonb,                                           -- persisted on resolve
  command_ref             text,                                            -- the 02 §2 command the resolve issues; idempotency key = card_instance_id
  expires_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz,
  retention_class         retention_class NOT NULL DEFAULT 'sm_lead_36m'
);
CREATE INDEX card_instances_conversation_idx ON card_instances(conversation_id, status, created_at);
CREATE INDEX card_instances_party_pending_idx ON card_instances(party_id) WHERE status = 'pending';
ALTER TABLE messages ADD CONSTRAINT messages_card_instance_fk FOREIGN KEY (card_instance_id) REFERENCES card_instances(card_instance_id);
CREATE TABLE card_instance_events (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_instance_id        uuid NOT NULL REFERENCES card_instances(card_instance_id),
  from_status             text,
  to_status               text NOT NULL CHECK (to_status IN ('pending', 'resolved', 'expired', 'superseded', 'cancelled')),
  at                      timestamptz NOT NULL,
  actor                   text NOT NULL,                                   -- borrower:<party_id> | agent:<name> | system
  evidence                jsonb,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_instance_events_card_idx ON card_instance_events(card_instance_id, at);
CREATE TRIGGER card_instance_events_immutable BEFORE UPDATE OR DELETE ON card_instance_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── passkeys + sessions (01 §5) ─────────────────────────────
CREATE TABLE passkey_credentials (
  passkey_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id                uuid NOT NULL REFERENCES parties(id),
  credential_id           text NOT NULL UNIQUE,                            -- base64url
  public_key_jwk          jsonb NOT NULL,                                  -- COSE key converted to JWK at registration
  algorithm               int NOT NULL,                                    -- COSE alg: -7 ES256, -257 RS256
  sign_count              bigint NOT NULL DEFAULT 0,
  transports              text[] NOT NULL DEFAULT '{}',
  attestation_format      text NOT NULL DEFAULT 'none',
  created_at              timestamptz NOT NULL DEFAULT now(),
  last_used_at            timestamptz,
  revoked_at              timestamptz
);
CREATE INDEX passkey_credentials_party_idx ON passkey_credentials(party_id) WHERE revoked_at IS NULL;
CREATE TABLE sessions (
  session_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id                uuid NOT NULL REFERENCES parties(id),
  level                   text NOT NULL CHECK (level IN ('L1', 'L2', 'L3')),
  auth_method             text NOT NULL CHECK (auth_method IN ('otp_phone', 'otp_email', 'passkey')),
  token_hash              text NOT NULL UNIQUE,                            -- sha256 of the bearer token; the token itself is never stored
  created_at              timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL,
  last_l1_at              timestamptz,                                     -- the last one-time code verified on this session (fresh-L1 rule: money movement needs one within 10 minutes)
  expires_at              timestamptz NOT NULL,                            -- 30 minutes idle pre-funding; 7 days with a passkey in servicing
  revoked_at              timestamptz,
  passkey_id              uuid REFERENCES passkey_credentials(passkey_id),
  ip                      text,
  user_agent              text,
  retention_class         retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX sessions_party_idx ON sessions(party_id, last_seen_at);
CREATE TABLE auth_challenges (
  challenge_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    text NOT NULL CHECK (kind IN ('otp', 'passkey_registration', 'passkey_assertion')),
  party_id                uuid REFERENCES parties(id),
  session_id              uuid REFERENCES sessions(session_id),            -- passkey registration is bound to the session that requested it
  channel                 text CHECK (channel IN ('sms', 'email')),
  destination             text,                                            -- the phone / e-mail the code went to (pii)
  code_hash               text,                                            -- sha256(challenge_id:code); never the code
  challenge               text,                                            -- WebAuthn challenge (base64url)
  delivery                text,                                            -- FAKE | sms | email
  delivery_ref            text,                                            -- the adapter's message id
  attempts                int NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  consumed_at             timestamptz
);
COMMENT ON COLUMN auth_challenges.destination IS 'pii';
CREATE INDEX auth_challenges_open_idx ON auth_challenges(kind, expires_at) WHERE consumed_at IS NULL;

-- ───────────────────────────── deep_links (01 §6.5) ─────────────────────────────
CREATE TABLE deep_links (
  token                   text PRIMARY KEY,                                -- random; never encodes loan data
  party_id                uuid NOT NULL REFERENCES parties(id),
  target                  jsonb NOT NULL,                                  -- {card_instance_id} | {document_id} | {route}
  expires_at              timestamptz NOT NULL,                            -- created_at + 7 days
  single_use              boolean NOT NULL DEFAULT false,
  created_for_message_id  uuid REFERENCES messages(message_id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  used_at                 timestamptz,
  CONSTRAINT deep_links_target_shape CHECK (target ? 'card_instance_id' OR target ? 'document_id' OR target ? 'route')
);
CREATE INDEX deep_links_party_idx ON deep_links(party_id, expires_at);

-- ───────────────────────────── ui_events (01 §9; append-only) ─────────────────────────────
CREATE TABLE ui_events (
  ui_event_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id                uuid NOT NULL REFERENCES parties(id),
  session_id              uuid REFERENCES sessions(session_id),
  conversation_id         uuid REFERENCES conversations(conversation_id),
  card_instance_id        uuid REFERENCES card_instances(card_instance_id),
  kind                    text NOT NULL CHECK (kind IN ('card_shown', 'card_resolved', 'document_opened', 'document_scrolled_to_end', 'consent_affirmed', 'connector_started', 'connector_completed', 'deep_link_opened', 'voice_started', 'human_requested')),
  at                      timestamptz NOT NULL,
  ip                      text,
  user_agent              text,
  disclosure_version_id   uuid,
  payload                 jsonb NOT NULL DEFAULT '{}',                     -- never demographic values (01 §3.19)
  retention_class         retention_class NOT NULL DEFAULT 'sm_lead_36m'
);
CREATE INDEX ui_events_party_idx ON ui_events(party_id, at);
CREATE INDEX ui_events_card_idx ON ui_events(card_instance_id) WHERE card_instance_id IS NOT NULL;
CREATE TRIGGER ui_events_immutable BEFORE UPDATE OR DELETE ON ui_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── DELTA-08: card-delivered notices ─────────────────────────────
-- Notice Registry channel `esign_portal`: the delivery evidence is the card that carried the document beside the rendered document.
ALTER TABLE notice_deliveries DROP CONSTRAINT IF EXISTS notice_deliveries_channel_check;
ALTER TABLE notice_deliveries ADD CONSTRAINT notice_deliveries_channel_check CHECK (channel IN ('mail_first_class', 'mail_certified', 'email_link', 'portal_post', 'sms_link', 'esign_portal'));
ALTER TABLE notice_deliveries
  ADD COLUMN IF NOT EXISTS card_instance_id      uuid REFERENCES card_instances(card_instance_id),
  ADD COLUMN IF NOT EXISTS rendered_document_id  uuid REFERENCES documents(id);
COMMENT ON COLUMN notice_deliveries.card_instance_id IS 'DELTA-08: for channel esign_portal, the DocumentCard / NoticeCard that delivered the notice — evidence beside rendered_document_id';

COMMIT;
