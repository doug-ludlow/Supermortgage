-- 0030: §14.1 data model — the per-loan ledger sub-accounts the bankruptcy ledger views post to ("Ledger sub-accounts
-- (baseline §5 extension, per loan): bk_prepetition_arrearage (frozen at petition), bk_postpetition_suspense,
-- bk_postpetition_fees_memo, bk_unsecured_cramdown, bk_trustee_clearing (trustee disbursement vouchers pending split)")
-- registered in the chart of accounts (0024; src/domain/bankruptcy/ops-14-1.ts BK_LOAN_ACCOUNTS posts to them:
-- rule 6(a) "post to bk_trustee_clearing, then split per the voucher"), and `timer_definitions.roll_rule` (spec data
-- model "timer_definitions.roll_rule ∈ {none, frbp_9006_forward}"; rule 5: FRBP clocks roll forward to the next federal
-- business day under Fed. R. Bankr. P. 9006(a)(1)(C) on the court calendar).
-- Append-only: 0016, 0024 and 0026 are not edited; no new table.
BEGIN;

INSERT INTO ledger_accounts (scope, account, kind, section, description) VALUES
  ('loan', 'bk_prepetition_arrearage', 'receivable', '14.1', 'pre-petition arrearage frozen at the petition date (Form 410A Part 3); cured through the trustee or the plan, reverts to the contract-terms view on dismissal'),
  ('loan', 'bk_postpetition_suspense', 'liability', '14.1', 'post-petition partial payments held under bankruptcy_hold (no 2.2 30-day return clock)'),
  ('loan', 'bk_postpetition_fees_memo', 'memo', '14.1', 'post-petition fees and charges (memo only; billable only through a Rule 3002.1(c) notice, 14.2)'),
  ('loan', 'bk_unsecured_cramdown', 'memo', '14.1', 'unsecured portion of a bifurcated claim after a confirmed cramdown (plan-terms view; opened only on confirmation)'),
  ('loan', 'bk_trustee_clearing', 'clearing', '14.1', 'trustee disbursement vouchers pending split (rule 6(a)); nets to zero once the voucher is split');

ALTER TABLE timer_definitions ADD COLUMN roll_rule text CHECK (roll_rule IN ('none', 'frbp_9006_forward'));
COMMENT ON COLUMN timer_definitions.roll_rule IS '§14.1 data model: how a due date falling on a weekend or federal legal holiday is handled — none (as computed) or frbp_9006_forward (Fed. R. Bankr. P. 9006(a)(1)(C): continues to the next day that is not a Saturday, Sunday or legal holiday; FRBP_3002C_POC_BAR_70, FRBP_3002C7_POC_SUPPLEMENT_120, FRBP_4001A3_ORDER_STAY_14). NULL where the registry row is not an FRBP clock.';

COMMIT;
