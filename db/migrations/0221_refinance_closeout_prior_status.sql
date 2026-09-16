-- 35.10 rule 1 / edge cases: `refinance_closeouts.prior_status_at_open` records loans.status as read once at closeout.open —
-- a closeout runs only from active | monitored; a paid_off prior loan completes{already_retired} with the existing settlement
-- id and any other status cancels{prior_not_retirable} — so the column admits every loan_status value (a cancelled or
-- completed-at-open row carries the real status, never a stand-in). Append-only migration: the CHECK is replaced, nothing else changes.
ALTER TABLE refinance_closeouts DROP CONSTRAINT IF EXISTS refinance_closeouts_prior_status_at_open_check;
ALTER TABLE refinance_closeouts ADD CONSTRAINT refinance_closeouts_prior_status_at_open_check CHECK (prior_status_at_open IN ('active', 'monitored', 'paid_off', 'staged', 'transferred_out', 'foreclosed', 'reo', 'repurchased', 'charged_off'));
