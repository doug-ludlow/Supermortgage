-- 0129_partner_book_daily_reports.sql — 34.3 Partner book operations: the examiner's daily report per partner
-- (spec/sections/34-operator-portal/34-3-partner-book-operations-uploads-import-history-the-book-reviews-readiness-the-daily-report.md, Data model).
--   partner_book_daily_reports   APPEND-ONLY: one row per partner per day, produced by the sweep after 33.3's pass and on demand
--                                (src/runtime/book-ops/report.ts bookDailyReport). `review` = 33.2's receipt counts (reviewed, candidates,
--                                watching, not_now, excluded, offers_delivered, expired, analyst_turns, analyst_skipped_by_reason,
--                                fair_lending_extract_id, run_id); `readiness` = 33.3's (checked, ready, not_ready_by_item,
--                                applications_opened, du_runs); `book` = the summary (loans monitored, on_hold, paid_off, transferred_out,
--                                last_as_of_date, next_expected = last as-of + 7 days — 33.1 SM_PARTNER_BOOK_TAPE_EXPECTED_7). State machine:
--                                `produced` — a re-run the same day appends a newer row (newest wins); the export (a hashed `documents` row,
--                                `compliance`) appends the row carrying `document_id` rather than updating one. Nothing here is computed about a
--                                loan (rule 7): every figure is a receipt's count, a row count or a stored fact.
-- One base table (src/infra/db/db.test.ts counts 762 through 0129 once 0128's tables are counted too).
BEGIN;

CREATE TABLE partner_book_daily_reports (
  id                 uuid PRIMARY KEY,
  partner_party_id   uuid NOT NULL REFERENCES parties(id),
  as_of_date         date NOT NULL,
  review             jsonb NOT NULL DEFAULT '{}'::jsonb,
  readiness          jsonb NOT NULL DEFAULT '{}'::jsonb,
  book               jsonb NOT NULL DEFAULT '{}'::jsonb,
  produced_by        text NOT NULL,                                    -- `sweep` or the staff actor (`human:<staff_user_id>`) who asked for it
  document_id        uuid REFERENCES documents(id),                    -- the export when made (a newer row carries it; rows are never updated)
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE partner_book_daily_reports IS '34.3 rule 6: the examiner''s daily report per partner and day — the review and readiness receipts'' counts, the fair-lending extract id, the book summary with last_as_of_date and next_expected; append-only, newest row per partner-day wins; exportable by compliance as a hashed document (document_id)';
CREATE INDEX partner_book_daily_reports_partner_day_idx ON partner_book_daily_reports(partner_party_id, as_of_date, created_at DESC);
CREATE TRIGGER partner_book_daily_reports_immutable BEFORE UPDATE OR DELETE ON partner_book_daily_reports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
