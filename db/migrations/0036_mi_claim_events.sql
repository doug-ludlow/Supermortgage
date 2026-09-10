-- 0036: §15.3 data model — `mi_claim_events`, the MI claim's case events (filed, doc_requested, doc_uploaded,
-- message, perfected, eob_received, paid, curtailed, denied, rescinded, appealed, supplemental_filed, closed).
-- Append-only like every other event table: each row links the `mi_claims` row, its case and loan, the MICP
-- request id / claim document / EOB amount the event carries, and who recorded it (MICP operator, insurer
-- adapter, Fannie Mae, the claims-reo agent). Retention life_of_loan_plus_4y (spec §15.3 "Audit and evidence").
BEGIN;

CREATE TABLE mi_claim_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES mi_claims(id),
  case_id               uuid REFERENCES cases(id),                                 -- cases.case_type = 'mi_claim'
  loan_id               uuid NOT NULL REFERENCES loans(id),
  kind                  text NOT NULL CHECK (kind IN ('filed','doc_requested','doc_uploaded','message','perfected','eob_received','paid','curtailed','denied','rescinded','appealed','supplemental_filed','closed')),
  occurred_at           timestamptz NOT NULL,
  source                text NOT NULL CHECK (source IN ('micp','insurer','fnma','servicer','agent')),
  filer                 text CHECK (filer IN ('fnma_micp','servicer_direct')),
  micp_request_id       text,                                                      -- MICP Dashboard request id (doc_requested / doc_uploaded / message)
  claim_document_id     uuid REFERENCES mi_claim_documents(id),
  document_id           uuid REFERENCES documents(id),                             -- EOB, denial/curtailment letter, appeal letter, upload evidence
  amount_cents          bigint,                                                    -- benefit paid, curtailment, supplemental amount
  paid_to               text CHECK (paid_to IN ('fnma','servicer')),
  reason                text,                                                      -- curtailment / denial / rescission reason as the insurer states it
  payload               jsonb NOT NULL DEFAULT '{}',
  actor_kind            actor_kind NOT NULL,
  actor_id              text NOT NULL,
  loan_event_id         uuid REFERENCES loan_events(id),
  recorded_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mi_claim_events IS '§15.3 MI claim case events: filed, doc_requested, doc_uploaded, message, perfected, eob_received, paid, curtailed, denied, rescinded, appealed, supplemental_filed, closed — append-only evidence for A1-3-02 make-whole defenses and insurer audits (E-4.5-01, F-1-06).';
CREATE INDEX mi_claim_events_claim_idx ON mi_claim_events (claim_id, occurred_at);
CREATE INDEX mi_claim_events_loan_kind_idx ON mi_claim_events (loan_id, kind);
CREATE TRIGGER mi_claim_events_immutable BEFORE UPDATE OR DELETE ON mi_claim_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
