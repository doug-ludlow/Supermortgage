-- DELTA-01 (docs/ux/BACKEND-DELTAS.md; README §7 "Reg C preapproval program" adopted; 32.3 P8): the preapproval program's columns on
-- 20.3's prequalifications — `kind` (the rule-4 prequalification or the §1003.2(b)(2) preapproval), the DU casefile the comprehensive
-- analysis ran on (23.1 TBD casefile), the approved amount and the letter's validity (23.3 SM_UW_DECISION_VALIDITY). The event
-- `preapproval.letter.issued` is emitted by src/domain/leads-pricing/ops-20-3.ts issuePreapprovalLetter; 28.3 records preapproval=1.
ALTER TABLE prequalifications ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'prequalification' CHECK (kind IN ('prequalification', 'preapproval'));
ALTER TABLE prequalifications ADD COLUMN IF NOT EXISTS du_casefile_id text;
ALTER TABLE prequalifications ADD COLUMN IF NOT EXISTS approved_amount_cents bigint CHECK (approved_amount_cents IS NULL OR approved_amount_cents > 0);
ALTER TABLE prequalifications ADD COLUMN IF NOT EXISTS valid_until date;
ALTER TABLE prequalifications ADD CONSTRAINT prequalifications_preapproval_complete CHECK (kind <> 'preapproval' OR outcome IS DISTINCT FROM 'letter_issued' OR (du_casefile_id IS NOT NULL AND approved_amount_cents IS NOT NULL AND valid_until IS NOT NULL));
COMMENT ON COLUMN prequalifications.kind IS 'DELTA-01: prequalification (20.3 rule 4, soft pull, not a commitment) | preapproval (Reg C §1003.2(b)(2) program: written commitment after DU on a TBD property; HMDA preapproval record)';
COMMENT ON COLUMN prequalifications.du_casefile_id IS 'DELTA-01: the 23.1 casefile (property TBD) the preapproval decision ran on';
COMMENT ON COLUMN prequalifications.approved_amount_cents IS 'DELTA-01: the approved loan amount on the letter (bigint cents)';
COMMENT ON COLUMN prequalifications.valid_until IS 'DELTA-01: the letter''s validity — 23.3 SM_UW_DECISION_VALIDITY (90 days or the earliest expiring component)';
