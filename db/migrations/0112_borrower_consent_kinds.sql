-- 0112_borrower_consent_kinds.sql — the consent kinds the borrower surface's ConsentCard captures (docs/ux/01-foundations.md §3.5)
-- on the 7.4 `consents` table (0001, extended by 0009 / 0057 / 0076 / 0077): `credit_authorization` (O1.3 audit hash),
-- `joint_intent` (Reg B §1002.7(d), per borrower — SM_O21_JOINT_INTENT_GATE), `irs_estatement` (7.4: `tax_statements` only
-- under this kind), `blanket_verification_authorization` (DELTA-05 standing connections). Columns: `standing` (DELTA-05:
-- a standing authorization keeps Truv/Plaid connections live under a refresh/retention policy) and `party_id` — 7.4's data
-- model keys consent by party ("consent is per party across that party's loans"), the table so far only by borrower / loan /
-- application / lead; the borrower surface authenticates a party (0111) and its cards capture consent for that party.
-- `scope text[]` already exists (0009); its class vocabulary is documented on the column. Enum values are added outside
-- the transaction (0100's rule).
ALTER TYPE consent_kind ADD VALUE IF NOT EXISTS 'credit_authorization';
ALTER TYPE consent_kind ADD VALUE IF NOT EXISTS 'joint_intent';
ALTER TYPE consent_kind ADD VALUE IF NOT EXISTS 'irs_estatement';
ALTER TYPE consent_kind ADD VALUE IF NOT EXISTS 'blanket_verification_authorization';
BEGIN;

ALTER TABLE consents
  ADD COLUMN IF NOT EXISTS standing  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS party_id  uuid REFERENCES parties(id);
COMMENT ON COLUMN consents.standing IS 'DELTA-05 (09 §5): a standing verification authorization (kind=blanket_verification_authorization) keeps the vendor connection live under the refresh/retention policy until withdrawn';
COMMENT ON COLUMN consents.party_id IS '7.4 data model: consent is per party (loan_ids lists the loans it covers); the borrower surface captures consent for the authenticated party (0111 sessions.party_id)';
COMMENT ON COLUMN consents.scope IS 'E-SIGN classes (7.4 rule 1; each maps to notice_templates.notice_class): servicing — periodic_statements, escrow_statements, regx_correspondence, arm_notices, privacy_notices, lossmit_notices, early_intervention_notices, insurance_notices, pmi_notices, payoff_statements, general_correspondence (tax_statements only under kind=irs_estatement); origination (21.2 / 21.3 / 25.2) — disclosures, notices; closing (26.1 / 26.2) — esign_signatures, enote';
CREATE INDEX IF NOT EXISTS consents_party_kind_idx ON consents(party_id, kind) WHERE party_id IS NOT NULL;
-- a party-keyed consent captured before any loan, application or lead exists (a returning borrower's ConsentCard) is a valid row
ALTER TABLE consents DROP CONSTRAINT IF EXISTS consents_keyed;
ALTER TABLE consents ADD CONSTRAINT consents_keyed CHECK (loan_id IS NOT NULL OR application_id IS NOT NULL OR lead_id IS NOT NULL OR party_id IS NOT NULL);

COMMIT;
