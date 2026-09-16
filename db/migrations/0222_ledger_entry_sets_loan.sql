-- 35.10 (found by T10's reversal on Postgres): a loan's settlement posts custodial-only sets — 16.2's "payoff cash split" and
-- "Fannie Mae share recognition" carry no loan-scoped line — and the loan-scoped hydration (35.1 rule 6: PgLedgerRepository.setsForLoan,
-- "every set touching a loan") never loaded them, so 16.2's reversal could not find the sets the settlement row names. The set now
-- records the loan whose command posted it when none of its lines does; hydration takes both. Additive: existing rows stay null.
ALTER TABLE ledger_entry_sets ADD COLUMN loan_id uuid REFERENCES loans(id);
COMMENT ON COLUMN ledger_entry_sets.loan_id IS 'the loan whose command posted the set when no line carries a loan (custodial-only sets of a settlement); null otherwise';
CREATE INDEX ledger_entry_sets_loan_idx ON ledger_entry_sets(loan_id) WHERE loan_id IS NOT NULL;
