-- 0241_parallel_run_scope.sql — 35.12 Production posture: the loans a parallel run covers.
-- parallel_runs + loan_ids (uuid[]): the book the run compares each evening (rule 7 — `loan_ids | book: all` at open; an
-- `extended` row carries the same set). Ids only, never a person. Append-only: 0240 is applied elsewhere and stays as written.
BEGIN;
ALTER TABLE parallel_runs ADD COLUMN loan_ids uuid[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN parallel_runs.loan_ids IS '35.12 rule 7: the loans the run reconciles daily (loans.id); a file naming another loan opens a diff with ours = absent.';
COMMIT;
