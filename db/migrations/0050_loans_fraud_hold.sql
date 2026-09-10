-- 0050_loans_fraud_hold.sql — 18.5 Mortgage fraud reporting: the loan-level protective flag.
-- Spec (Outputs and artifacts): "loan-level protective flags (`loans.fraud_hold` with reason and expiry)"; guardrail:
-- "protective actions are time-boxed (auto-expire in 30 days unless renewed by the officer) to avoid harming innocent
-- borrowers"; rule 2: "hold suspicious payoff disbursements pending verified call-back (16.x)". 18.5-T1 holds the payoff
-- disbursement when the P1 case opens; 18.5-T8: placed 2026-10-05 with no officer renewal → expires 2026-11-04 and the
-- payoff proceeds. The columns are the row src/domain/qc-audit/ops-18-5.ts protectiveHold computes (`loan_row`) and
-- 16.x reads through payoffDisbursementGate before releasing proceeds; the placement/renewal/release history stays in
-- the append-only `fraud_cases.protective_holds` jsonb (0021) and the `loan.fraud_hold.set` / `loan.fraud_hold.released`
-- events. The `qc_audit` role keeps its 18.1 grant set (no writes on `loans`, 0046): the hold is written by the
-- platform's loan writer from the fraud module's event, never by the agent's SQL role. Append-only: new columns, no edits.
BEGIN;

ALTER TABLE loans ADD COLUMN fraud_hold            boolean NOT NULL DEFAULT false;
ALTER TABLE loans ADD COLUMN fraud_hold_reason     text;
ALTER TABLE loans ADD COLUMN fraud_hold_expires_on date;
ALTER TABLE loans ADD COLUMN fraud_hold_case_id    uuid REFERENCES fraud_cases(case_id);
-- a live hold always carries its reason and expiry (the guardrail's time box); a released hold clears all three
ALTER TABLE loans ADD CONSTRAINT loans_fraud_hold_reason_expiry_check
  CHECK ((fraud_hold AND fraud_hold_reason IS NOT NULL AND fraud_hold_expires_on IS NOT NULL)
      OR (NOT fraud_hold AND fraud_hold_reason IS NULL AND fraud_hold_expires_on IS NULL AND fraud_hold_case_id IS NULL));
CREATE INDEX loans_fraud_hold_live_idx ON loans (fraud_hold_expires_on) WHERE fraud_hold;

COMMENT ON COLUMN loans.fraud_hold IS '18.5 rule 2 protective action (hold_payoff_disbursement): true while the hold is live; 16.x payoff disbursement is held while true and today < fraud_hold_expires_on (payoffDisbursementGate)';
COMMENT ON COLUMN loans.fraud_hold_reason IS '18.5: the red flag behind the hold (e.g. PAYOFF_WIRE_CHANGE: payoff disbursement held pending verified call-back)';
COMMENT ON COLUMN loans.fraud_hold_expires_on IS '18.5 guardrail: placed/renewed date + 30 days; auto-expires unless renewed by the officer:fraud_officer with a rationale (18.5-T8: placed 2026-10-05 → expires 2026-11-04)';
COMMENT ON COLUMN loans.fraud_hold_case_id IS '18.5: the fraud_cases row whose protective_holds history carries the placement, renewals and release';

COMMIT;
