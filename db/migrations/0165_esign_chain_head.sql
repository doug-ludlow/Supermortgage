-- 0165_esign_chain_head.sql — 35.2 Documents and artifacts: the evidence chain's head on the envelope and the state machine tightened
-- (spec/sections/35-operations-runtime/35-2-documents-and-artifacts.md "Data model": esign_signature_events' chained hash; "State
-- machines: Per envelope"). Review of 0163: a terminal envelope records the head of its signature-event chain (write-once; a
-- truncated tail is then detectable from the rows), `completed` is reached only from `in_progress` (the first sign always writes
-- `viewed`), a draft is never voided (it is simply never sent), the void/completion columns move only with their status, and the
-- consent ids recorded at send are frozen after it.
BEGIN;

ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS chain_head char(64);
COMMENT ON COLUMN esign_envelopes.chain_head IS '35.2: the event_hash of the last esign_signature_events row when the envelope became terminal (the audit trail''s head); write-once.';

CREATE OR REPLACE FUNCTION esign_envelopes_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'esign_envelopes_transition: an envelope is never deleted (append-only; a correction is a new envelope)'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.loan_id IS DISTINCT FROM OLD.loan_id OR NEW.owner_process IS DISTINCT FROM OLD.owner_process
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.vendor IS DISTINCT FROM OLD.vendor OR NEW.signer_party_ids IS DISTINCT FROM OLD.signer_party_ids OR NEW.created_by_actor IS DISTINCT FROM OLD.created_by_actor
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.retention_class IS DISTINCT FROM OLD.retention_class OR NEW.expires_on IS DISTINCT FROM OLD.expires_on OR NEW.vendor_envelope_ref IS DISTINCT FROM OLD.vendor_envelope_ref THEN
    RAISE EXCEPTION 'esign_envelopes_transition: the envelope''s identity columns are write-once (%)', OLD.id;
  END IF;
  IF OLD.status IN ('completed', 'declined', 'voided', 'expired') THEN
    RAISE EXCEPTION 'esign_envelopes_transition: envelope % is % (terminal) — a completed envelope is never voided; a correction is a new envelope', OLD.id, OLD.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status = 'sent')
         OR (OLD.status = 'sent' AND NEW.status IN ('in_progress', 'declined', 'voided', 'expired'))
         OR (OLD.status = 'in_progress' AND NEW.status IN ('completed', 'declined', 'voided', 'expired'))) THEN
      RAISE EXCEPTION 'esign_envelopes_transition: % → % is not a transition the state machine names (envelope %)', OLD.status, NEW.status, OLD.id;
    END IF;
    IF NEW.status = 'sent' AND NEW.sent_at IS NULL THEN RAISE EXCEPTION 'esign_envelopes_transition: sent needs sent_at'; END IF;
    IF NEW.status = 'completed' AND (NEW.completed_at IS NULL OR NEW.evidence_document_id IS NULL OR NEW.chain_head IS NULL) THEN RAISE EXCEPTION 'esign_envelopes_transition: completed needs completed_at, the audit-trail evidence document and the chain head'; END IF;
    IF NEW.status IN ('voided', 'expired', 'declined') AND (NEW.voided_at IS NULL OR NEW.void_reason IS NULL OR NEW.evidence_document_id IS NULL OR NEW.chain_head IS NULL) THEN RAISE EXCEPTION 'esign_envelopes_transition: % needs voided_at, void_reason, the audit-trail evidence document and the chain head', NEW.status; END IF;
  ELSE
    -- no status change: the columns that belong to a transition do not move on their own
    IF NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.completed_at IS DISTINCT FROM OLD.completed_at OR NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
       OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256 OR NEW.chain_head IS DISTINCT FROM OLD.chain_head OR NEW.consent_ids IS DISTINCT FROM OLD.consent_ids THEN
      RAISE EXCEPTION 'esign_envelopes_transition: sent_at, completed_at, voided_at, void_reason, the evidence, the chain head and the consent ids move only with a status transition (envelope %)', OLD.id;
    END IF;
  END IF;
  IF NEW.consent_ids IS DISTINCT FROM OLD.consent_ids AND NOT (OLD.status = 'draft' AND NEW.status = 'sent') THEN RAISE EXCEPTION 'esign_envelopes_transition: the consent ids are recorded at send and frozen'; END IF;
  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN RAISE EXCEPTION 'esign_envelopes_transition: sent_at is written once'; END IF;
  IF OLD.evidence_document_id IS NOT NULL AND NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id THEN RAISE EXCEPTION 'esign_envelopes_transition: evidence_document_id is written once'; END IF;
  IF OLD.chain_head IS NOT NULL AND NEW.chain_head IS DISTINCT FROM OLD.chain_head THEN RAISE EXCEPTION 'esign_envelopes_transition: chain_head is written once'; END IF;
  RETURN NEW;
END $$;

COMMIT;
