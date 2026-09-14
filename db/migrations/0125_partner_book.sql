-- 0125_partner_book.sql — section 33, the partner book (spec/sections/33-partner-book): monitored loans, the partner's
-- facts, the invitations, the daily refinance review and the readiness checklist.
--   33.1 — `loans.status = monitored`: a loan loaded from a partner's tape, never serviced here (no ledger set, no
--          installments, none of sections 2–19); `fnma_loan_number` becomes nullable and the 0057 check accepts a
--          monitored loan (and the terminal states it reaches: a refinance funded here pays it off, a partner's later
--          tape may mark it transferred); `v_refi_universe` includes monitored loans so 20.1's run reads them (33.2 puts
--          the partner's facts on the row, never ledger or installments).
--   tables: partner_book_imports, partner_book_facts, partner_book_invitations (33.1), partner_book_reviews (33.2),
--          readiness_checks (33.3) — five base tables (src/infra/db/db.test.ts counts them).
-- Enum values are added outside the transaction (0100's rule).
ALTER TYPE loan_status ADD VALUE IF NOT EXISTS 'monitored';
BEGIN;

ALTER TABLE loans ALTER COLUMN fnma_loan_number DROP NOT NULL;
ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_fnma_number_after_purchase;
ALTER TABLE loans ADD CONSTRAINT loans_fnma_number_after_purchase
  CHECK (fnma_loan_number IS NOT NULL OR origination_application_id IS NOT NULL OR status IN ('monitored', 'paid_off', 'transferred_out'));
COMMENT ON COLUMN loans.fnma_loan_number IS '1.1 HF-001: the Fannie Mae loan number of a serviced loan; null only for an origination file before purchase (0057) and for a monitored loan of the partner book (33.1: the partner keeps servicing it; its investor data stays in partner_book_facts)';

-- 33.1 v_refi_universe: monitored loans are in the refinance universe (33.2 rule 1 overlays the partner facts on the row)
CREATE OR REPLACE VIEW v_refi_universe AS
  SELECT l.id AS loan_id, l.partner_party_id AS partner_id, l.status, l.instrument_date AS note_date, l.origination_date AS consummation_date,
         l.first_payment_date, l.original_upb_cents, l.original_term_months,
         t.amortization, t.note_rate_bps, t.pi_cents, t.escrow_payment_cents AS escrow_monthly_cents, t.escrowed, t.remaining_term_months, t.maturity_date,
         p.state AS property_state, p.county, p.occupancy, p.property_type, p.units,
         l.refi_do_not_solicit, l.refi_last_offered_at, l.refi_offers_12m
    FROM loans l
    JOIN loan_terms t ON t.loan_id = l.id AND t.effective_to IS NULL
    JOIN properties p ON p.id = l.property_id
   WHERE l.status IN ('active', 'monitored');

-- 33.1 the import (append-only; the report never carries a raw PII row)
CREATE TABLE partner_book_imports (
  id                 uuid PRIMARY KEY,
  partner_party_id   uuid NOT NULL REFERENCES parties(id),
  as_of_date         date NOT NULL,
  profile            text NOT NULL,
  status             text NOT NULL CHECK (status IN ('received', 'loaded', 'rejected')),
  tape_sha256        text NOT NULL,
  supplement_sha256  text,
  rows_total         integer NOT NULL DEFAULT 0,
  rows_loaded        integer NOT NULL DEFAULT 0,
  rows_exception     integer NOT NULL DEFAULT 0,
  loans_created      integer NOT NULL DEFAULT 0,
  loans_updated      integer NOT NULL DEFAULT 0,
  parties_created    integer NOT NULL DEFAULT 0,
  parties_linked     integer NOT NULL DEFAULT 0,
  invitations_sent   integer NOT NULL DEFAULT 0,
  report             jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id           text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE partner_book_imports IS '33.1: one row per upload of a partner tape (+ supplement); idempotent on the file hashes — the same files land once (already_loaded)';
CREATE UNIQUE INDEX partner_book_imports_files_idx ON partner_book_imports(partner_party_id, tape_sha256, COALESCE(supplement_sha256, ''));
CREATE INDEX partner_book_imports_partner_idx ON partner_book_imports(partner_party_id, created_at DESC);

-- 33.1 the partner's facts, whole (append-only; pii): the latest row per loan is the record 33.2 and the borrower record read
CREATE TABLE partner_book_facts (
  id                 uuid PRIMARY KEY,
  import_id          uuid NOT NULL REFERENCES partner_book_imports(id),
  loan_id            uuid NOT NULL REFERENCES loans(id),
  partner_party_id   uuid NOT NULL REFERENCES parties(id),
  as_of_date         date NOT NULL,
  facts              jsonb NOT NULL,
  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE partner_book_facts IS '33.1: every mapped column of the profile typed (money as decimal-string cents, dates ISO, flags booleans) under facts; every unmapped header verbatim under raw; investor columns stay here and never reach the refinance universe (20.1 rule 7)';
CREATE INDEX partner_book_facts_loan_idx ON partner_book_facts(loan_id, as_of_date DESC, created_at DESC);
CREATE INDEX partner_book_facts_import_idx ON partner_book_facts(import_id);

-- 33.1 the invitations (append-only; pii by hash only)
CREATE TABLE partner_book_invitations (
  id                 uuid PRIMARY KEY,
  import_id          uuid NOT NULL REFERENCES partner_book_imports(id),
  party_id           uuid NOT NULL REFERENCES parties(id),
  loan_id            uuid NOT NULL REFERENCES loans(id),
  channel            text NOT NULL CHECK (channel IN ('email', 'sms')),
  destination_hash   text NOT NULL,
  notice_id          uuid,
  message_id         text,
  sent_at            timestamptz NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('invitation', 'reminder')),
  bounced_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE partner_book_invitations IS '33.1 rule 4: one invitation per provisioned party per channel; one reminder at 14 days while invited (SM_PARTNER_BOOK_INVITATION_REMINDER_14); destination_hash is sha256 of the normalized destination — never the destination';
CREATE INDEX partner_book_invitations_party_idx ON partner_book_invitations(party_id, kind, sent_at DESC);
CREATE INDEX partner_book_invitations_loan_idx ON partner_book_invitations(loan_id);

-- 33.2 the daily refinance review (append-only): one row per loan per day
CREATE TABLE partner_book_reviews (
  id                 uuid PRIMARY KEY,
  loan_id            uuid NOT NULL REFERENCES loans(id),
  party_id           uuid REFERENCES parties(id),
  as_of_date         date NOT NULL,
  run_id             text NOT NULL,
  opportunity_id     text,
  verdict            text NOT NULL CHECK (verdict IN ('candidate', 'watching', 'not_now', 'excluded')),
  reasons            jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts              jsonb NOT NULL DEFAULT '{}'::jsonb,
  analyst            jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_id        uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, as_of_date)
);
COMMENT ON TABLE partner_book_reviews IS '33.2 rule 3: the verdict by the engine''s opportunity status, the engine''s facts copied, the analyst''s rationale and flags (or analyst.skipped) — the analyst never decides';
CREATE INDEX partner_book_reviews_day_idx ON partner_book_reviews(as_of_date, verdict);

-- 33.3 the readiness checklist (append-only): one row per loan per day and one on every triggering event
CREATE TABLE readiness_checks (
  id                 uuid PRIMARY KEY,
  loan_id            uuid NOT NULL REFERENCES loans(id),
  party_id           uuid REFERENCES parties(id),
  application_id     uuid REFERENCES applications(id),
  as_of_date         date NOT NULL,
  items              jsonb NOT NULL DEFAULT '[]'::jsonb,
  ready              boolean NOT NULL DEFAULT false,
  missing            jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision_id        uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE readiness_checks IS '33.3 rule 1: one entry per item {item, status present|stale|missing|not_applicable, source_table, source_id, as_of, valid_until, rule_ref, refresh_via}; ready when every required item is present; missing in the order asked';
CREATE INDEX readiness_checks_loan_idx ON readiness_checks(loan_id, created_at DESC);
CREATE INDEX readiness_checks_application_idx ON readiness_checks(application_id) WHERE application_id IS NOT NULL;

COMMIT;
