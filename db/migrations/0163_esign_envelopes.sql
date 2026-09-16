-- 0163_esign_envelopes.sql — 35.2 Documents and artifacts: the in-house e-sign envelope
-- (spec/sections/35-operations-runtime/35-2-documents-and-artifacts.md "Data model": `esign_envelopes`, `esign_envelope_documents`,
-- `esign_signature_events`; "State machines: Per envelope"; rule 8).
--
-- An envelope is an electronic channel (rule 8): `esign.envelope.send` requires an active E-SIGN consent per signer whose scope
-- covers the kind and arms SM_ESIGN_ENVELOPE_EXPIRY_30; a field is signed only by a human party through an L2+ session (or the FAKE
-- signer in tests); the last required field completes the envelope — the signed bytes are a new `documents` row that supersedes the
-- unsigned one, `signed_document_id` is written once, and the audit trail (every signature event and the hash chain's head) is the
-- envelope's `evidence_document_id`. The signature events are append-only and hash-chained (A2-4.1-03). A terminal envelope
-- (completed, declined, voided, expired) never changes again; a correction is a new envelope.
BEGIN;

CREATE TABLE esign_envelopes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid REFERENCES applications(id),
  loan_id               uuid REFERENCES loans(id),
  owner_process         text NOT NULL,                                -- 21.2, 25.2, 26.1, 7.4, 16.1, 4.x, 35.2 …
  kind                  text NOT NULL CHECK (kind IN ('disclosure_ack', 'closing_ancillary', 'consent', 'servicing_agreement', 'payoff_authorization', 'other')),
  vendor                text NOT NULL DEFAULT 'FAKE',                 -- FAKE in every nonprod stage
  vendor_envelope_ref   text,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'in_progress', 'completed', 'declined', 'voided', 'expired')),
  signer_party_ids      uuid[] NOT NULL,
  consent_ids           uuid[] NOT NULL DEFAULT '{}',                 -- one active E-SIGN consent per signer, recorded at send
  created_by_actor      text NOT NULL,
  sent_at               timestamptz,
  completed_at          timestamptz,
  voided_at             timestamptz,
  void_reason           text,
  expires_on            date,
  evidence_document_id  uuid REFERENCES documents(id),                -- the audit-trail PDF written at completion, void or expiry
  evidence_sha256       char(64),
  retention_class       retention_class NOT NULL DEFAULT 'esign_consent_life_of_loan_plus_4y',
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT esign_envelopes_keyed CHECK (application_id IS NOT NULL OR loan_id IS NOT NULL)
);
CREATE INDEX esign_envelopes_application_idx ON esign_envelopes (application_id) WHERE application_id IS NOT NULL;
CREATE INDEX esign_envelopes_loan_idx ON esign_envelopes (loan_id) WHERE loan_id IS NOT NULL;
CREATE INDEX esign_envelopes_open_idx ON esign_envelopes (status) WHERE status IN ('sent', 'in_progress');

-- the state machine, as a trigger: the identity columns are write-once, a terminal envelope is frozen, every transition is one the spec names
CREATE OR REPLACE FUNCTION esign_envelopes_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'esign_envelopes_transition: an envelope is never deleted (append-only; a correction is a new envelope)'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.loan_id IS DISTINCT FROM OLD.loan_id OR NEW.owner_process IS DISTINCT FROM OLD.owner_process
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.vendor IS DISTINCT FROM OLD.vendor OR NEW.signer_party_ids IS DISTINCT FROM OLD.signer_party_ids OR NEW.created_by_actor IS DISTINCT FROM OLD.created_by_actor
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.retention_class IS DISTINCT FROM OLD.retention_class THEN
    RAISE EXCEPTION 'esign_envelopes_transition: the envelope''s identity columns are write-once (%)', OLD.id;
  END IF;
  IF OLD.status IN ('completed', 'declined', 'voided', 'expired') THEN
    RAISE EXCEPTION 'esign_envelopes_transition: envelope % is % (terminal) — a completed envelope is never voided; a correction is a new envelope', OLD.id, OLD.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('sent', 'voided'))
         OR (OLD.status = 'sent' AND NEW.status IN ('in_progress', 'completed', 'declined', 'voided', 'expired'))
         OR (OLD.status = 'in_progress' AND NEW.status IN ('completed', 'declined', 'voided', 'expired'))) THEN
      RAISE EXCEPTION 'esign_envelopes_transition: % → % is not a transition the state machine names (envelope %)', OLD.status, NEW.status, OLD.id;
    END IF;
    IF NEW.status = 'sent' AND NEW.sent_at IS NULL THEN RAISE EXCEPTION 'esign_envelopes_transition: sent needs sent_at'; END IF;
    IF NEW.status = 'completed' AND (NEW.completed_at IS NULL OR NEW.evidence_document_id IS NULL) THEN RAISE EXCEPTION 'esign_envelopes_transition: completed needs completed_at and the audit-trail evidence document'; END IF;
    IF NEW.status IN ('voided', 'expired') AND (NEW.voided_at IS NULL OR NEW.void_reason IS NULL) THEN RAISE EXCEPTION 'esign_envelopes_transition: % needs voided_at and void_reason', NEW.status; END IF;
  END IF;
  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN RAISE EXCEPTION 'esign_envelopes_transition: sent_at is written once'; END IF;
  IF OLD.evidence_document_id IS NOT NULL AND NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id THEN RAISE EXCEPTION 'esign_envelopes_transition: evidence_document_id is written once'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER esign_envelopes_transition BEFORE UPDATE OR DELETE ON esign_envelopes FOR EACH ROW EXECUTE FUNCTION esign_envelopes_transition();
COMMENT ON TABLE esign_envelopes IS '35.2 rule 8: the in-house e-sign envelope; status is the spec''s state machine (trigger); terminal rows are frozen; a correction is a new envelope.';

CREATE TABLE esign_envelope_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id           uuid NOT NULL REFERENCES esign_envelopes(id),
  sequence              int NOT NULL,
  document_id           uuid NOT NULL REFERENCES documents(id),      -- the unsigned bytes
  required_fields       jsonb NOT NULL DEFAULT '[]',                  -- [{field_id, signer_party_id, page, kind ∈ signature|initials|date|checkbox}]
  signed_document_id    uuid REFERENCES documents(id),                -- the signed bytes: unsigned + the signature page + the per-field stamps; set once
  signed_sha256         char(64),
  signed_at             timestamptz,
  UNIQUE (envelope_id, sequence)
);
CREATE INDEX esign_envelope_documents_document_idx ON esign_envelope_documents (document_id);
CREATE OR REPLACE FUNCTION esign_envelope_documents_signed_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'esign_envelope_documents_signed_once: an envelope document row is never deleted'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.envelope_id IS DISTINCT FROM OLD.envelope_id OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.required_fields IS DISTINCT FROM OLD.required_fields THEN
    RAISE EXCEPTION 'esign_envelope_documents_signed_once: the unsigned document and its required fields are write-once (%)', OLD.id;
  END IF;
  IF OLD.signed_document_id IS NOT NULL AND (NEW.signed_document_id IS DISTINCT FROM OLD.signed_document_id OR NEW.signed_sha256 IS DISTINCT FROM OLD.signed_sha256 OR NEW.signed_at IS DISTINCT FROM OLD.signed_at) THEN
    RAISE EXCEPTION 'esign_envelope_documents_signed_once: signed_document_id is set once (row %, already %)', OLD.id, OLD.signed_document_id;
  END IF;
  IF NEW.signed_document_id IS NOT NULL AND (NEW.signed_sha256 IS NULL OR NEW.signed_at IS NULL) THEN RAISE EXCEPTION 'esign_envelope_documents_signed_once: the signed row carries its hash and time'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER esign_envelope_documents_signed_once BEFORE UPDATE OR DELETE ON esign_envelope_documents FOR EACH ROW EXECUTE FUNCTION esign_envelope_documents_signed_once();
COMMENT ON TABLE esign_envelope_documents IS '35.2: the documents of an envelope with their required fields; signed_document_id (the superseding signed row) is written once.';

CREATE TABLE esign_signature_events (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                       bigserial NOT NULL,                            -- the chain order within an envelope
  envelope_id               uuid NOT NULL REFERENCES esign_envelopes(id),
  document_id               uuid,
  signer_party_id           uuid,
  kind                      text NOT NULL CHECK (kind IN ('created', 'sent', 'viewed', 'authenticated', 'consent_affirmed', 'field_signed', 'declined', 'completed', 'voided', 'expired')),
  at                        timestamptz NOT NULL,
  auth_method               text NOT NULL CHECK (auth_method IN ('session_l2', 'session_l3', 'otp_email', 'otp_sms', 'kba', 'id_verified', 'none')),
  ip                        inet,                                         -- pii
  user_agent                text,
  field_id                  text,
  page                      int,
  typed_name                text,                                         -- pii
  document_sha256_at_event  char(64),
  prev_event_hash           char(64),                                     -- the previous row's event_hash (null for the first)
  event_hash                char(64) NOT NULL,                            -- sha256 over the canonical JSON of payload.hashed (the row minus event_hash), chained through prev_event_hash
  vendor_event_ref          text,
  payload                   jsonb NOT NULL DEFAULT '{}',
  retention_class           retention_class NOT NULL DEFAULT 'esign_consent_life_of_loan_plus_4y',
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX esign_signature_events_envelope_idx ON esign_signature_events (envelope_id, seq);
CREATE TRIGGER esign_signature_events_immutable BEFORE UPDATE OR DELETE ON esign_signature_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON COLUMN esign_signature_events.ip IS 'pii';
COMMENT ON COLUMN esign_signature_events.typed_name IS 'pii';
COMMENT ON TABLE esign_signature_events IS '35.2 rule 8 / A2-4.1-03: the signature evidence — every envelope event with auth method, ip, user agent and the chained hash; append-only. fnma_enote_signing_life_plus_7y when the envelope belongs to a closing.';

COMMIT;
