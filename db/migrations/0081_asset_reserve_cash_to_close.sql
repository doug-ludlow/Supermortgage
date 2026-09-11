-- 0081_asset_reserve_cash_to_close.sql — 22.4 Asset, reserve and cash-to-close verification: the tables the process's data
-- model adds (spec/sections/22-…/22-4-…md "Data model"). `application_assets` (0057) gains the 22.4-owned columns beside the
-- baseline ones (`asset_kind`, `institution`, `balance_cents`, `verified` stay for 21.1's intake declaration); `verifications`
-- — called "baseline" by 22.1, 22.3 and 22.4 and created by none of 0057/0078/0080 — is created here with 22.3's owned columns
-- (component, supplier_code, report_reference_id, vendor_data_as_of, close_by_date, du_validation_outcome, report_document_id,
-- authorization_consent_id) and 22.4's `kind = assets` columns (report_days, accounts, large_deposit_messages, supplemental);
-- IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so a sibling definition landing first cannot collide. `asset_deposits`,
-- `gift_records` and `ipc_items` change status (versioned by updated_at; history in loan_events `asset.*`, `gift.*`, `ipc.*`);
-- `funds_to_close_worksheets` (one row per computation — the reconciliation artifact, every CD version retained) and
-- `reserve_calculations` are append-only evidence (forbid_mutation, 0001). `conditions` (23.2/23.3), `fee_items` (21.2/25.2),
-- `payoff_demands`/`subordinations` (24.4), `disclosures` (25.2) and `agent_runs` are referenced by id only.
BEGIN;

-- ───────────────────────────── application_assets: 22.4-owned columns (R2–R4, state machine) ─────────────────────────────
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS borrower_ids uuid[] NOT NULL DEFAULT '{}';                       -- joint accounts
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS asset_type text;                                                  -- checking | savings | money_market | cd | brokerage_stocks_bonds_funds | stock_options_vested | retirement | trust | life_insurance_cash_value | business_account | gift | gift_of_equity | grant | employer_assistance | community_second | lender_contribution | emd | sale_of_personal_asset | proceeds_real_estate_sale | secured_borrowed_funds | bridge_loan | cash_on_hand_homeready | virtual_currency_converted | rent_credit | trade_equity | sweat_equity | ida | pooled_savings | foreign_asset | other
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS institution_name text;
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS holder_names text[] NOT NULL DEFAULT '{}';
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS owner_match boolean;                                              -- holder ⊇ a borrower (B3-4.2-01)
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS liquid boolean NOT NULL DEFAULT true;                             -- B3-4.4-01 liquid list
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS usable_for text NOT NULL DEFAULT 'both' CHECK (usable_for IN ('closing', 'reserves', 'both', 'none'));
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS declared_balance_cents bigint;
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS verified_balance_cents bigint;
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS haircut_bps int NOT NULL DEFAULT 0 CHECK (haircut_bps BETWEEN 0 AND 10000);   -- policy; 0 for securities and vested retirement (B3-4.3-01/-03; open question 1)
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS secured_loan_offset_cents bigint NOT NULL DEFAULT 0;             -- B3-4.3-15
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS emd_offset_cents bigint NOT NULL DEFAULT 0;                      -- EMD cleared after the statement's period end
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS unsourced_deposit_offset_cents bigint NOT NULL DEFAULT 0;        -- R3
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS usable_cents bigint NOT NULL DEFAULT 0;                          -- R4 (computed)
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS verification_method text NOT NULL DEFAULT 'none' CHECK (verification_method IN ('statements', 'form_1006', 'lender_system_printout', 'du_asset_report', 'liquidation_evidence', 'gift_evidence', 'grant_evidence', 'settlement_statement', 'bill_of_sale', 'buyout_agreement', 'none'));
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS statement_period_start date;
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS statement_period_end date;
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS statement_count int NOT NULL DEFAULT 0;
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS du_45d_ok boolean;                                                -- R1: period_end ≥ application_date − 45 days (quarterly 90)
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS b1_1_03_expires_at date;                                          -- 22.1 computes (document.extracted.expires_at); never recomputed here
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS du_validation_outcome text NOT NULL DEFAULT 'not_submitted' CHECK (du_validation_outcome IN ('validated', 'not_validated', 'not_submitted', 'not_eligible'));
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS du_report_reference_id text;
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS evidence_document_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'declared' CHECK (status IN ('declared', 'documentation_requested', 'documented', 'verified', 'rejected', 'sourced', 'usable', 'finalized', 'reverified', 'withdrawn'));
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS reject_reason text CHECK (reject_reason IS NULL OR reject_reason IN ('unverified_funds', 'owner_mismatch', 'ineligible_source'));
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS liquidation_required_for_closing boolean NOT NULL DEFAULT false; -- B3-4.3-01/-03: securities / retirement count for closing only with receipt documented
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS liquidated_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS pii_flags text[] NOT NULL DEFAULT '{account_number}';
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y';
ALTER TABLE application_assets ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
COMMENT ON COLUMN application_assets.usable_cents IS '22.4 R4: max(0, verified − secured_loan_offset − emd_offset − unsourced_deposit_offset) × (10000 − haircut_bps) / 10000, floored; 0 for non-vested options, unsecured loans, cash-on-hand outside HomeReady and unconverted virtual currency.';
COMMENT ON COLUMN application_assets.du_45d_ok IS '22.4 R1 (B3-4.4-02): most recent monthly statement dated within 45 days of the INITIAL application date (quarterly 90); purchase 2 consecutive / refinance 1; never re-based on amendment.';

-- ───────────────────────────── verifications (baseline; 22.3 owns the report columns, 22.4 the kind=assets ones) ─────────────────────────────
CREATE TABLE IF NOT EXISTS verifications (
  verification_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id             uuid NOT NULL REFERENCES applications(id),
  borrower_id                uuid REFERENCES application_borrowers(id),
  kind                       text NOT NULL CHECK (kind IN ('income', 'employment', 'vvoe', 'assets', 'tax_transcript', 'rental')),
  component                  text NOT NULL CHECK (component IN ('income', 'employment', 'assets', 'tax_transcript', 'rental')),   -- 22.3
  supplier_code              text NOT NULL,                                       -- DU validation service report supplier (00b-orig F1)
  distributor                text,
  report_reference_id        text NOT NULL,                                       -- the identifier cited in the DU submission (23.1)
  vendor_data_as_of          date NOT NULL,
  du_validation_outcome      text CHECK (du_validation_outcome IS NULL OR du_validation_outcome IN ('validated', 'not_validated', 'unable_to_validate', 'not_submitted', 'not_eligible')),
  close_by_date              date,                                                -- 22.3 FNMA_B3_2_02_DU_CLOSE_BY_GATE
  report_document_id         uuid REFERENCES documents(id),                       -- stored copy (fnma_loan_file_life_plus_4y; account numbers → pii_flags)
  authorization_consent_id   uuid NOT NULL,                                       -- consents (B3-2-02 borrower authorization)
  received_at                timestamptz NOT NULL DEFAULT now(),
  created_at                 timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS report_days int CHECK (report_days IS NULL OR report_days IN (30, 60, 90, 365));   -- 22.4: 30 refinance / 60 purchase / 90 quarterly / 365 income-from-assets
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS accounts jsonb NOT NULL DEFAULT '[]';                                   -- per account: institution, last4, balance, period
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS large_deposit_messages jsonb NOT NULL DEFAULT '[]';                     -- DU messages naming the deposits to document
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS supplemental boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS verifications_app_kind_idx ON verifications(application_id, kind);
COMMENT ON TABLE verifications IS 'Vendor verification reports (DU validation service and IVES deliveries): 22.3 owns component/supplier/report reference/close-by; rows with kind = assets (22.4) carry report_days (30/60/90_quarter/365), the per-account balances and periods, DU large-deposit messages and the supplemental flag. The report data go supplier → DU directly (00b-orig Part (c)(5)); SM stores the copy and cites the report identifier in the casefile.';

-- ───────────────────────────── asset_deposits (R3 large deposits) ─────────────────────────────
CREATE TABLE asset_deposits (
  deposit_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id                   uuid NOT NULL REFERENCES application_assets(id),
  application_id             uuid NOT NULL REFERENCES applications(id),
  posted_on                  date NOT NULL,
  amount_cents               bigint NOT NULL CHECK (amount_cents > 0),
  description_on_statement   text NOT NULL DEFAULT '',
  readily_identifiable       boolean NOT NULL DEFAULT false,                      -- payroll / SSA / tax refund / transfer between verified accounts printed on the statement
  sourced_cents              bigint NOT NULL DEFAULT 0 CHECK (sourced_cents >= 0),
  unsourced_cents            bigint NOT NULL CHECK (unsourced_cents >= 0),        -- = amount − sourced
  threshold_cents            bigint NOT NULL CHECK (threshold_cents >= 0),        -- floor(total monthly qualifying income × 50 / 100)
  large_deposit              boolean NOT NULL DEFAULT false,                      -- unsourced_cents > threshold_cents (strictly greater: "exceeds")
  source_kind                text NOT NULL DEFAULT 'unknown' CHECK (source_kind IN ('payroll', 'government_benefit', 'tax_refund', 'transfer_verified_account', 'gift', 'grant', 'sale_of_asset', 'real_estate_proceeds', 'secured_loan', 'unsecured_loan', 'virtual_currency_exchange', 'business', 'unknown')),
  source_evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  du_message_id              text,
  status                     text NOT NULL DEFAULT 'not_applicable' CHECK (status IN ('not_applicable', 'flagged', 'sourced', 'partially_sourced', 'unsourced', 'waived_refinance', 'waived_du_validated')),
  reduction_cents            bigint NOT NULL DEFAULT 0 CHECK (reduction_cents >= 0),   -- applied to application_assets.unsourced_deposit_offset_cents
  dti_link_liability_id      uuid REFERENCES application_liabilities(id),         -- 22.5, when the source is a new loan
  request_id                 uuid,                                                -- 22.1 document_requests (the single structured question per deposit)
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (sourced_cents + unsourced_cents = amount_cents),
  CHECK (status <> 'sourced' OR unsourced_cents <= threshold_cents)
);
CREATE INDEX asset_deposits_asset_idx ON asset_deposits(asset_id, posted_on);
COMMENT ON TABLE asset_deposits IS '22.4 R3 (B3-4.2-02): per deposit on a verified account — purchase only, single deposit, only the unsourced portion is tested against 50 % of total monthly qualifying income ($8,200.00 → $4,100.00); printed payroll/SSA/tax-refund/verified-transfer sources need no further evidence; an unsourced large deposit reduces the account''s usable funds until sourced; refinance → waived_refinance; DU-validated accounts → only DU-named deposits (waived_du_validated otherwise).';

-- ───────────────────────────── gift_records (R5) ─────────────────────────────
CREATE TABLE gift_records (
  gift_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id             uuid NOT NULL REFERENCES applications(id),
  asset_id                   uuid REFERENCES application_assets(id),
  kind                       text NOT NULL CHECK (kind IN ('personal_gift', 'gift_of_equity', 'grant', 'employer_assistance')),
  donor_name                 text NOT NULL,
  donor_address              text,
  donor_phone                text,
  relationship               text NOT NULL,                                       -- B3-4.3-04 enumeration (relative; domestic partner, fiancé, former relative, long-standing familial-like / mentorship)
  donor_interested_party_check text NOT NULL DEFAULT 'unresolved' CHECK (donor_interested_party_check IN ('clear', 'match', 'unresolved')),
  letter_document_id         uuid REFERENCES documents(id),
  amount_stated_cents        bigint NOT NULL CHECK (amount_stated_cents >= 0),
  amount_is_maximum          boolean NOT NULL DEFAULT false,
  no_repayment_statement     boolean NOT NULL DEFAULT false,
  transfer_status            text NOT NULL DEFAULT 'not_transferred' CHECK (transfer_status IN ('not_transferred', 'transferred_to_borrower', 'transferred_to_closing_agent', 'at_settlement_official_check')),
  transfer_evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  transfer_amount_cents      bigint NOT NULL DEFAULT 0 CHECK (transfer_amount_cents >= 0),
  pooled_with_borrower       boolean NOT NULL DEFAULT false,
  shared_residency_certification_document_id uuid REFERENCES documents(id),
  usable_for                 text NOT NULL DEFAULT 'both' CHECK (usable_for IN ('closing', 'reserves', 'both', 'none')),   -- personal gift → both; gift of equity → closing
  status                     text NOT NULL DEFAULT 'declared' CHECK (status IN ('declared', 'letter_received', 'transfer_verified', 'complete', 'rejected')),
  reject_reason              text,                                                -- interested_party_donor | investment_property | ineligible_donor | missing_no_repayment_statement
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'transfer_verified' OR (no_repayment_statement AND cardinality(transfer_evidence_document_ids) > 0)),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);
CREATE INDEX gift_records_app_idx ON gift_records(application_id);
COMMENT ON TABLE gift_records IS '22.4 R5 (B3-4.3-04 02/04/2026; B3-4.3-05): gift letter (amount or maximum, no-repayment statement, donor name/address/phone/relationship), donor interested-party check against the transaction''s parties (match → rejected, 22.6 case), transfer evidence before or at settlement (FNMA_B3_4_3_04_GIFT_TRANSFER_GATE); gifts barred on investment property; gifts of equity fund closing only.';

-- ───────────────────────────── ipc_items (R7) ─────────────────────────────
CREATE TABLE ipc_items (
  ipc_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id             uuid NOT NULL REFERENCES applications(id),
  payer_party_id             text NOT NULL,                                       -- seller, builder, agent, affiliate, lender-as-interested-party
  payer_role                 text NOT NULL CHECK (payer_role IN ('seller', 'builder', 'developer', 'agent', 'broker', 'affiliate', 'lender_as_interested_party', 'lender')),
  kind                       text NOT NULL CHECK (kind IN ('financing_concession', 'sales_concession', 'common_customary_fee', 'buydown_subsidy', 'hoa_prepaid', 'lender_incentive', 'undisclosed_suspected')),
  amount_cents               bigint NOT NULL CHECK (amount_cents >= 0),
  hoa_months                 int CHECK (hoa_months IS NULL OR hoa_months >= 0),   -- HOA assessments count only up to 12 months
  funded_by_interested_party boolean,                                             -- buydown subsidies count when funded by an interested party (or an affiliated lender)
  disclosed_on_settlement    boolean NOT NULL DEFAULT true,
  counts_toward_limit        boolean NOT NULL DEFAULT true,
  evidence_document_ids      uuid[] NOT NULL DEFAULT '{}',
  status                     text NOT NULL DEFAULT 'declared' CHECK (status IN ('declared', 'verified', 'excess_reclassified', 'rejected')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ipc_items_app_idx ON ipc_items(application_id);
COMMENT ON TABLE ipc_items IS '22.4 R7 (B3-4.1-02 05/07/2025): interested-party contributions; financing concessions, interested-party-funded buydown subsidies and HOA prepaids (≤ 12 months) count against 3 % (CLTV > 90), 6 % (75.01–90), 9 % (≤ 75) or 2 % (investment) of min(price, appraised value); excess → sales concession (price/LTV/MI recomputed, 21.5 changed circumstance); undisclosed IPCs and payment abatements make the loan ineligible (22.6 case).';

-- ───────────────────────────── funds_to_close_worksheets (R8/R9; one immutable row per computation) ─────────────────────────────
CREATE TABLE funds_to_close_worksheets (
  worksheet_row_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worksheet_id               uuid NOT NULL,
  application_id             uuid NOT NULL REFERENCES applications(id),
  version                    int NOT NULL CHECK (version >= 1),
  stage                      text NOT NULL,                                       -- application | le | du_findings | pre_cd | cd_v{n} | pre_consummation | final
  computed_at                timestamptz NOT NULL DEFAULT now(),
  transaction                text NOT NULL CHECK (transaction IN ('purchase', 'refinance', 'lcor', 'cash_out')),
  sales_price_cents          bigint NOT NULL DEFAULT 0,
  appraised_value_cents      bigint,
  loan_amount_cents          bigint NOT NULL,
  financed_mi_cents          bigint NOT NULL DEFAULT 0,
  payoffs_cents              bigint NOT NULL DEFAULT 0,                           -- Σ payoff_demands good-through-covered amounts (24.4)
  total_closing_costs_cents  bigint NOT NULL,                                     -- CD line J
  costs_paid_before_closing_cents bigint NOT NULL DEFAULT 0,
  costs_financed_cents       bigint NOT NULL DEFAULT 0,
  down_payment_cents         bigint NOT NULL DEFAULT 0,
  emd_cents                  bigint NOT NULL DEFAULT 0,
  seller_credits_cents       bigint NOT NULL DEFAULT 0,
  lender_credit_premium_cents bigint NOT NULL DEFAULT 0,
  lender_contribution_cents  bigint NOT NULL DEFAULT 0,
  gift_cents                 bigint NOT NULL DEFAULT 0,
  grant_cents                bigint NOT NULL DEFAULT 0,
  community_second_cents     bigint NOT NULL DEFAULT 0,
  other_credits_cents        bigint NOT NULL DEFAULT 0,
  principal_curtailment_cents bigint NOT NULL DEFAULT 0,                          -- LCOR overage cure (B2-1.5-05) → 26.3/27.1 postings
  cash_to_close_cents        bigint NOT NULL,                                     -- positive = from borrower; negative = to borrower (§1026.38(i))
  cash_back_cap_cents        bigint,                                              -- LCOR: max(1 % × loan, $2,000)
  cash_back_ok               boolean NOT NULL DEFAULT true,
  reserves_required_cents    bigint NOT NULL DEFAULT 0,                           -- rule R6
  funds_to_verify_cents      bigint NOT NULL,                                     -- max(cash_to_close, 0) + reserves_required
  verified_usable_closing_cents bigint NOT NULL DEFAULT 0,
  verified_usable_reserves_cents bigint NOT NULL DEFAULT 0,
  sufficient                 boolean NOT NULL,
  shortfall_cents            bigint NOT NULL DEFAULT 0,
  reserves_shortfall_cents   bigint NOT NULL DEFAULT 0,
  cd_disclosure_id           uuid,                                                -- 25.2 disclosures
  cd_cash_to_close_cents     bigint,
  reconciled_to_cd           boolean NOT NULL DEFAULT false,
  variances                  jsonb NOT NULL DEFAULT '[]',                         -- per CD line: "B. Title – settlement fee +$100.00"
  agent_run_id               uuid,
  rule_set_version           text NOT NULL DEFAULT 'fnma.selling.2026-09-02',
  UNIQUE (worksheet_id, version),
  CHECK (NOT reconciled_to_cd OR cd_cash_to_close_cents = cash_to_close_cents),
  CHECK (cash_back_ok OR cash_back_cap_cents IS NOT NULL)
);
CREATE INDEX funds_to_close_worksheets_app_idx ON funds_to_close_worksheets(application_id, version);
CREATE TRIGGER funds_to_close_worksheets_immutable BEFORE UPDATE OR DELETE ON funds_to_close_worksheets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE funds_to_close_worksheets IS '22.4 R8/R9: one immutable row per computation (every stage and CD version retained). Purchase: cash_to_close = down payment + J − paid before closing − financed − EMD − seller credits − lender credit − gifts/grants/Community Second at closing − other credits ($43,997.00 on the fixture); sufficient = Σ usable closing ≥ max(cash_to_close, 0) and reserves after closing ≥ required; reconciled_to_cd iff equal to the CD''s Cash to Close to the cent (variances routed to 25.2 — the worksheet never overrides the CD). LCOR: cash to borrower ≤ max(1 % × loan, $2,000) (B2-1.3-02) with the curtailment cure recorded here.';

-- ───────────────────────────── reserve_calculations (R6; append-only) ─────────────────────────────
CREATE TABLE reserve_calculations (
  calc_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id             uuid NOT NULL REFERENCES applications(id),
  worksheet_id               uuid,
  basis                      text NOT NULL CHECK (basis IN ('du_findings', 'b3_4_1_01_occupancy', 'b3_4_1_01_multiple_financed', 'employment_offer_option_2', 'nontraditional_credit')),
  months                     int CHECK (months IS NULL OR months IN (0, 2, 6)),
  pitia_cents                bigint NOT NULL DEFAULT 0,                           -- 22.5's qualifying PITIA
  other_financed_upb_cents   bigint NOT NULL DEFAULT 0,
  financed_property_count    int NOT NULL DEFAULT 0,
  pct_bps                    int NOT NULL DEFAULT 0 CHECK (pct_bps IN (0, 200, 400, 600)),
  required_cents             bigint NOT NULL CHECK (required_cents >= 0),
  du_required_cents          bigint,
  verified_cents             bigint NOT NULL DEFAULT 0,
  tolerance_90pct_ok         boolean NOT NULL,                                    -- 23.1 B3-2-10: verified ≥ 90 % of the findings' requirement (else B3_2_10_RESERVES_90PCT resubmission)
  sufficient                 boolean NOT NULL,
  computed_at                timestamptz NOT NULL DEFAULT now(),
  rule_set_version           text NOT NULL DEFAULT 'fnma.selling.2026-09-02'
);
CREATE INDEX reserve_calculations_app_idx ON reserve_calculations(application_id, computed_at);
CREATE TRIGGER reserve_calculations_immutable BEFORE UPDATE OR DELETE ON reserve_calculations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE reserve_calculations IS '22.4 R6 (B3-4.1-01 08/07/2024): required = max(DU "Reserves Required to be Verified", months × qualifying PITIA — 0 one-unit principal, 2 second home, 6 two-to-four-unit principal / investment / cash-out with DTI > 45 %) + 2/4/6 % of the other financed properties'' UPB ($410,000.00 × 2 % = $8,200.00 → $16,200.00 on the fixture) + 22.3/22.2 add-ons; gifts count, gifts of equity / IPCs / lender contributions / cash-out proceeds do not; append-only.';

COMMIT;
