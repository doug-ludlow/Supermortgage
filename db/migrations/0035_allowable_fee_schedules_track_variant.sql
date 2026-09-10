-- 0035: §15.2 Operational prerequisites — "Versioned `allowable_fee_schedules` loaded" (Allowable Foreclosure Attorney
-- Fees Exhibit 12/18/2024, F-1-05 Defined Expense Reimbursement Limits 06/11/2025, PPM caps, E-5-06 technology caps).
--
-- allowable_fee_schedules (0017): the exhibit carries variant rows that share code + jurisdiction — TX $2,300 non-judicial /
-- $3,800 judicial 50(a)(6), FL $5,400 / $6,900 trial, NY $6,800 judicial / $2,000 co-op, WA $2,400 / $4,150 judicial,
-- CT $4,400 / $5,000, MN $2,375 / +$1,100 registered land — so the key gains `track` and `variant`; `life_cap_cents` carries
-- the life-of-default / life-of-loan ceilings (code violations $3,000 life, e-invoice $10.00 life of loan). The rows are
-- seeded verbatim from src/domain/reo/ops-15-2.ts ALLOWABLE_FEE_SCHEDULES (15.2-T1 proves every coded row has a distinct
-- key); the Guide-diff job re-validates them monthly under a new rule_set.
-- (advance_recoveries already carries the 15.2 data-model bullet — `source` ∈ {…, payoff, fnma_claim, mi_claim, …},
-- `fnma_repay_due_at`, `fnma_repaid_at`, `crs_code` — from 0017_reo.sql; nothing to add here.)
ALTER TABLE allowable_fee_schedules
  ADD COLUMN track          text NOT NULL DEFAULT '*' CHECK (track IN ('*', 'judicial', 'non_judicial')),
  ADD COLUMN variant        text NOT NULL DEFAULT '',
  ADD COLUMN life_cap_cents bigint;
ALTER TABLE allowable_fee_schedules DROP CONSTRAINT allowable_fee_schedules_pkey;
ALTER TABLE allowable_fee_schedules ADD PRIMARY KEY (rule_set, code, jurisdiction, track, variant);
COMMENT ON TABLE allowable_fee_schedules IS '§15.2 Operational prerequisites: versioned allowable schedules (rule_set = fnma.fcl_fees.2024-12-18 / fnma.f105_limits.2025-06 / fnma.ppm.2025-06 / fnma.tech_fees.2014-11) keyed by code, jurisdiction, foreclosure track and exhibit variant; the claim validator records the row''s rule_set and cap on every line (rule 2).';

INSERT INTO allowable_fee_schedules (rule_set, code, jurisdiction, track, variant, kind, cap_cents, cap_unit, life_of_default, life_cap_cents, notes, source_url) VALUES
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'TX', 'non_judicial', '', 'attorney_fee', 230000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'TX', 'judicial', '50(a)(6)', 'attorney_fee', 380000, 'per_default', true, NULL, 'home-equity judicial', 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'FL', 'judicial', '', 'attorney_fee', 540000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'FL', 'judicial', 'trial', 'attorney_fee', 690000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'NY', 'judicial', '', 'attorney_fee', 680000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'NY', 'non_judicial', 'co-op', 'attorney_fee', 200000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'CA', 'non_judicial', '', 'attorney_fee', 230000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'GA', 'non_judicial', '', 'attorney_fee', 222500, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'IL', 'judicial', '', 'attorney_fee', 410000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'NJ', 'judicial', '', 'attorney_fee', 670000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'OH', 'judicial', '', 'attorney_fee', 400000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'PA', 'judicial', '', 'attorney_fee', 415000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'VA', 'non_judicial', '', 'attorney_fee', 260000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'WA', 'non_judicial', '', 'attorney_fee', 240000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'WA', 'judicial', '', 'attorney_fee', 415000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'AZ', 'non_judicial', '', 'attorney_fee', 225000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'NV', 'non_judicial', '', 'attorney_fee', 265000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'MI', 'non_judicial', '', 'attorney_fee', 255000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'MA', 'non_judicial', '', 'attorney_fee', 470000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'CT', 'judicial', '', 'attorney_fee', 440000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'CT', 'judicial', 'foreclosure_by_sale', 'attorney_fee', 500000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'MD', '*', '', 'attorney_fee', 390000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'MN', 'non_judicial', '', 'attorney_fee', 237500, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'MN', 'non_judicial', 'registered_land', 'attorney_fee', 347500, 'per_default', true, NULL, '+$1,100 registered land', 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'CO', 'non_judicial', '', 'attorney_fee', 280000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.fcl_fees.2024-12-18', 'attorney_fee_fcl', 'NC', '*', '', 'attorney_fee', 295000, 'per_default', true, NULL, NULL, 'https://singlefamily.fanniemae.com/media/8971/display'),
  ('fnma.f105_limits.2025-06', 'inspection_exterior', '*', '*', '', 'inspection', 3000, 'per_unit', false, NULL, NULL, 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.f105_limits.2025-06', 'inspection_interior', '*', '*', '', 'inspection', 4500, 'per_unit', false, NULL, NULL, 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.f105_limits.2025-06', 'inspection_insured_loss', '*', '*', '', 'inspection', 6000, 'per_unit', false, NULL, NULL, 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.f105_limits.2025-06', 'code_violation', '*', '*', '', 'code_violation', 100000, 'per_unit', false, 300000, '$1,000 each / $3,000 life', 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.f105_limits.2025-06', 'mortgage_release_doc_prep', '*', '*', '', 'mortgage_release_doc', 65000, 'per_unit', false, NULL, '$650 each, upon completion', 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.ppm.2025-06', 'lock_change', '*', '*', '', 'preservation', 6000, 'per_unit', false, NULL, NULL, 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.ppm.2025-06', 'initial_grass_cut', '*', '*', '', 'preservation', 12500, 'per_unit', false, NULL, NULL, 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.ppm.2025-06', 'grass_recut', '*', '*', '', 'preservation', 8000, 'per_unit', false, NULL, NULL, 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.ppm.2025-06', 'debris_removal_cy', '*', '*', '', 'preservation', 5000, 'per_unit', false, NULL, 'per cubic yard; >10 CY BATF, >20 CY bid (9.9)', 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.ppm.2025-06', 'winterization', '*', '*', '', 'preservation', 22000, 'per_unit', false, NULL, NULL, 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.ppm.2025-06', 'boarding', '*', '*', '', 'preservation', 18500, 'per_unit', false, NULL, NULL, 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.ppm.2025-06', 'posting', '*', '*', '', 'preservation', 5000, 'per_unit', false, NULL, NULL, 'https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement'),
  ('fnma.tech_fees.2014-11', 'technology_fee', '*', '*', '', 'technology', 2500, 'per_default', true, NULL, '$25.00 per loan for the life of a default', 'https://servicing-guide.fanniemae.com/svc/e-5-06/technology-fees-and-electronic-invoicing'),
  ('fnma.tech_fees.2014-11', 'einvoice_fcl', '*', '*', '', 'einvoice', 500, 'life_of_loan', false, 1000, '$5.00 foreclosure; $10.00 for the life of the loan with einvoice_bk', 'https://servicing-guide.fanniemae.com/svc/e-5-06/technology-fees-and-electronic-invoicing'),
  ('fnma.tech_fees.2014-11', 'einvoice_bk', '*', '*', '', 'einvoice', 500, 'life_of_loan', false, 1000, '$5.00 bankruptcy; $10.00 for the life of the loan with einvoice_fcl', 'https://servicing-guide.fanniemae.com/svc/e-5-06/technology-fees-and-electronic-invoicing')
ON CONFLICT (rule_set, code, jurisdiction, track, variant) DO NOTHING;
