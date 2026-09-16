-- 35.6 Closing, funding and delivery orchestration — the claim cursor (T12: a row is claimed by exactly one pass per sweep
-- instant). `last_pass_as_of` is the sweep `as_of` of the last claim; a claim at the same instant skips the row, so two
-- passes started in the same minute never both process a row, and a pass that finished early cannot hand its rows to the
-- other pass's later page. Append-only migration: a nullable column, no data change.
BEGIN;
ALTER TABLE closing_orchestrations ADD COLUMN last_pass_as_of timestamptz;
COMMENT ON COLUMN closing_orchestrations.last_pass_as_of IS '35.6 rule 1 / T12: the sweep as_of of the last claim; a claim at the same as_of skips the row (one pass per row per sweep instant)';
COMMIT;
