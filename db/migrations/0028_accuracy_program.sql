-- 0028: §8.3 data model — `accuracy_program` (Reg V Appendix E as code, the program-level row that
-- versions the control set in `accuracy_controls` (0010) with the CRRG edition, the officer approval
-- and the next review date) plus the E-III-d `accuracy_sample_verifications` the monthly control run
-- records; `accuracy_controls` gains the program link.
BEGIN;

CREATE TABLE accuracy_program (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL DEFAULT 'Reg V Appendix E accuracy and integrity program',
  rule_set_version      text NOT NULL,                                    -- e.g. fcra.regv.2026-09
  crrg_edition          text NOT NULL,                                    -- e.g. crrg.2026
  policy_document_id    uuid REFERENCES documents(id),
  approved_by           text,                                             -- officer
  effective_at          timestamptz NOT NULL DEFAULT now(),
  next_review_at        timestamptz,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'retired'))
);
COMMENT ON TABLE accuracy_program IS '§8.3 rule 11: the versioned Appendix E program — each guideline component in accuracy_controls belongs to a program version approved by an officer and reviewed annually (E-III-l).';
ALTER TABLE accuracy_controls ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES accuracy_program(id);

CREATE TABLE accuracy_sample_verifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id              uuid NOT NULL REFERENCES metro2_cycles(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  borrower_id           uuid,
  fields_compared       jsonb NOT NULL,
  match                 boolean NOT NULL,
  verified_by           text NOT NULL,                                    -- qc-audit run id
  verified_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accuracy_sample_verifications_cycle_idx ON accuracy_sample_verifications (cycle_id);
COMMENT ON TABLE accuracy_sample_verifications IS '§8.3 rule 11 E-III-d: >= 200 tradelines (or 5%) per cycle re-derived field by field; match rate < 99.5% escalates to officer.';

COMMIT;
