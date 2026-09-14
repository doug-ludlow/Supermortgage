-- 0130_evidence_packs.sql — 34.4 evidence and controls: the evidence pack row (spec/sections/34-operator-portal/34-4-*.md
-- "Data model"): one append-only row per pack produced by `compliance` for a loan, an application, a person or a period —
-- the subject, the sections included, the manifest (every row set with its count and sha256, the part documents) and the
-- one document (`documents` row, kind evidence_pack) with its hash. The pack IS the stored rows (PACK_IS_STORED_ROWS):
-- nothing here is computed or summarized. The kill switch (18.1) keeps no table of its own on this platform: its state is
-- the `ai.kill_switch.requested / tripped / reset / request.expired` events (loan_events, append-only) plus the
-- `<code>.enabled` feature flag the borrower turn reads (32.16 T10) — no ai_kill_switches table is added.
BEGIN;

CREATE TABLE evidence_packs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind      text NOT NULL CHECK (subject_kind IN ('loan', 'application', 'party', 'period')),
  subject_id        text,                                                   -- the loan / application / party id; null for a period
  from_date         date,                                                   -- a period's first day (inclusive); null otherwise
  to_date           date,                                                   -- a period's last day (inclusive); null otherwise
  sections          text[] NOT NULL DEFAULT '{}',                           -- the row sets included (events, decisions, notices, timers, escalations, ledger_sets, agent_turns, consents, verifications, credit_reports, partner_book, staff_actions)
  manifest          jsonb NOT NULL,                                         -- {sections: [{name, count, sha256}], parts: [{part, document_id, sha256, byte_size, event_count, from_sequence, to_sequence}], part_count, ...}
  document_id       uuid REFERENCES documents(id),                          -- the pack document (kind evidence_pack): the manifest and every non-event row set; the event parts are their own documents (≤ 100,000 events each)
  sha256            text NOT NULL,                                          -- the pack document's hash
  produced_by       uuid REFERENCES staff_users(id),                        -- the compliance staff member (null only for a non-session actor outside production)
  created_at        timestamptz NOT NULL DEFAULT now(),
  retention_class   retention_class NOT NULL DEFAULT 'corporate_7y',
  CHECK ((subject_kind = 'period' AND from_date IS NOT NULL AND to_date IS NOT NULL AND subject_id IS NULL) OR (subject_kind <> 'period' AND subject_id IS NOT NULL))
);
CREATE INDEX evidence_packs_subject_idx ON evidence_packs(subject_kind, subject_id, created_at DESC);
CREATE INDEX evidence_packs_created_idx ON evidence_packs(created_at DESC);
CREATE TRIGGER evidence_packs_immutable BEFORE UPDATE OR DELETE ON evidence_packs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE evidence_packs IS '34.4 rule 5: the evidence pack — the stored rows for a loan, an application, a person or a period, each set with a count and a hash, one document with a hash; produced by compliance (18.2, 19.1); append-only, retained with the records.';

COMMIT;
