-- 0151 — 35.1 persistence seam: the links 35.5's plan asked of the seam (35.1 owns 0150–0159).
-- (1) payment_reversals' natural key: the payments projector's child map inserts one row per (payment_id, reversed_at)
--     from 2.3's `reversal` object and conflicts on it, so a re-projection or replay is a no-op (35.1 rule 4).
CREATE UNIQUE INDEX IF NOT EXISTS payment_reversals_payment_reversed_at_uidx ON payment_reversals (payment_id, reversed_at);

-- (2) 35.5's typed-at-source tables reference the typed payments row by uuid (a uuid legacy ref is its own row id, rule 5).
--     The constraints are added only where the table and the column exist: on a fresh database 35.5's 0142–0145 precede
--     this file and the constraint is added; where they are absent the block is a no-op and a later seam file adds it.
DO $$
BEGIN
  IF to_regclass('public.loan_installments') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'loan_installments' AND column_name = 'satisfied_by_payment_id')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loan_installments_satisfied_by_payment_id_fkey') THEN
    ALTER TABLE loan_installments ADD CONSTRAINT loan_installments_satisfied_by_payment_id_fkey FOREIGN KEY (satisfied_by_payment_id) REFERENCES payments(id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF to_regclass('public.lockbox_items') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lockbox_items' AND column_name = 'payment_id')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lockbox_items_payment_id_fkey') THEN
    ALTER TABLE lockbox_items ADD CONSTRAINT lockbox_items_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
