-- 0082: §22.5 liabilities, debt-to-income, qualifying payment and debts paid at closing — the three tables the spec's
-- data model adds beside the baseline `application_liabilities` (0057), whose 22.5-owned columns are appended here
-- (payment basis, inclusion / exclusion with evidence, payoff planning, the IRS lien flag, the state machine).
-- `qualifying_payments` and `dti_calculations` are immutable per version (a recomputation is a new version row — the
-- decision-of-record version is the one 28.3 reports to HMDA and 23.3 approves); `debt_payoff_plans` move
-- proposed → approved → evidenced | failed. Every figure is integer cents; rates are the spec's "bps" — thousandths of a percent (7.875 % = 7875); DTI bps are hundredths (38.00 % = 3800) (B3-6-02 R1).
BEGIN;

-- ───────────────────────────── application_liabilities: the columns 22.5 owns (B3-6-01/-05/-07) ─────────────────────────────
ALTER TABLE application_liabilities
  ADD COLUMN IF NOT EXISTS borrower_ids                   uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS liability_type                 text,                                     -- mortgage | heloc | installment | revolving | open_30_day | lease_auto | lease_other | student_loan | alimony | child_support | separate_maintenance | equalization_payment | garnishment | irs_installment | business_debt_personal_name | secured_by_financial_asset | co_signed | court_assigned | bridge_loan | community_second | other_recurring | collection_judgment_lien
  ADD COLUMN IF NOT EXISTS account_last4                  text,
  ADD COLUMN IF NOT EXISTS credit_tradeline_id            uuid,
  ADD COLUMN IF NOT EXISTS reported_payment_cents         bigint CHECK (reported_payment_cents IS NULL OR reported_payment_cents >= 0),
  ADD COLUMN IF NOT EXISTS remaining_months               integer CHECK (remaining_months IS NULL OR remaining_months >= 0),   -- creditor statement or ceil(balance ÷ payment) as of the scheduled note date
  ADD COLUMN IF NOT EXISTS qualifying_payment_cents       bigint NOT NULL DEFAULT 0 CHECK (qualifying_payment_cents >= 0),
  ADD COLUMN IF NOT EXISTS payment_basis                  text NOT NULL DEFAULT 'none' CHECK (payment_basis IN ('credit_report', 'creditor_statement', 'revolving_5pct', 'student_idr_zero_documented', 'student_1pct_balance', 'student_amortizing_documented', 'deferred_letter', 'lease_full', 'legal_agreement', 'irs_agreement', 'heloc_required_payment', 'mortgage_pitia', 'rental_net_loss', 'bridge_terms', 'none')),
  ADD COLUMN IF NOT EXISTS include_in_dti                 boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS exclusion_reason               text CHECK (exclusion_reason IS NULL OR exclusion_reason IN ('le_10_payments', 'paid_off_at_closing', 'paid_down_le_10', 'paid_by_other_12m', 'business_paid_12m_cashflow', 'secured_by_financial_asset', 'court_assigned_contingent', 'non_applicant_documented', 'voluntary_payment', 'open_30_day', 'heloc_no_payment', 'community_second_deferred_5y', 'income_reduction_elected', 'sold_before_closing', 'pending_sale_contract_cleared', 'rental_offset')),
  ADD COLUMN IF NOT EXISTS exclusion_evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS significantly_affects          boolean NOT NULL DEFAULT false,           -- B3-6-05 ≤ 10-payment override (Q4: payment > 15 % of income or revolving utilization > 80 %)
  ADD COLUMN IF NOT EXISTS income_reduction_elected       boolean NOT NULL DEFAULT false,           -- alimony / equalization / separate maintenance only (never child support)
  ADD COLUMN IF NOT EXISTS payoff_amount_cents            bigint CHECK (payoff_amount_cents IS NULL OR payoff_amount_cents >= 0),
  ADD COLUMN IF NOT EXISTS payoff_source_asset_id         uuid REFERENCES application_assets(id),   -- 22.4
  ADD COLUMN IF NOT EXISTS payoff_statement_document_id   uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS tax_lien_indicated             boolean NOT NULL DEFAULT false,           -- IRS agreements: Notice of Federal Tax Lien in the subject county (24.4 title search)
  ADD COLUMN IF NOT EXISTS du_message_ids                 text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS status                         text NOT NULL DEFAULT 'declared' CHECK (status IN ('declared', 'discovered', 'matched', 'unmatched_significant', 'basis_selected', 'included', 'excluded', 'payoff_planned', 'payoff_evidenced', 'finalized', 'reopened')),
  ADD COLUMN IF NOT EXISTS retention_class                text NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  ADD COLUMN IF NOT EXISTS pii_flags                      text[] NOT NULL DEFAULT '{account_number}',
  ADD CONSTRAINT application_liabilities_exclusion_consistent CHECK (include_in_dti OR exclusion_reason IS NOT NULL);
COMMENT ON TABLE application_liabilities IS '21.1 baseline (URLA 2c) extended by 22.5: liability type per B3-6-05, source (credit_report | application | udm_alert | refresh | borrower_disclosure | document | du_message | deposit_sourcing), qualifying payment with its basis, inclusion or exclusion with the Guide-named evidence, payoff planning (B3-6-07), the IRS lien flag (SEL-2026-05) and the per-liability state machine; excluded rows carry a reason';
CREATE INDEX IF NOT EXISTS application_liabilities_included_idx ON application_liabilities(application_id, include_in_dti);

-- ───────────────────────────── qualifying_payments (B3-6-03/-04; immutable per version) ─────────────────────────────
CREATE TABLE qualifying_payments (
  qp_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id             uuid NOT NULL REFERENCES applications(id),
  version                    integer NOT NULL CHECK (version >= 1),
  property_role              text NOT NULL CHECK (property_role IN ('subject_primary', 'subject_second_home', 'subject_investment', 'other_reo')),
  loan_amount_cents          bigint NOT NULL CHECK (loan_amount_cents > 0),
  note_rate_bps              integer NOT NULL CHECK (note_rate_bps > 0),
  term_months                integer NOT NULL DEFAULT 360 CHECK (term_months > 0),
  product                    text NOT NULL CHECK (product IN ('fixed', 'arm_3_or_less', 'arm_5', 'arm_7', 'arm_10', 'generic_arm')),
  index_bps                  integer,
  margin_bps                 integer,
  first_cap_bps              integer,
  fully_indexed_bps          integer,                                         -- index + margin as entered on the application
  hpml_or_hpct               boolean NOT NULL DEFAULT false,                  -- 23.4: flips the 7/10-year ARM qualifying rate to the fully indexed rate
  qualifying_rate_bps        integer NOT NULL CHECK (qualifying_rate_bps > 0),
  qualifying_rate_basis      text NOT NULL CHECK (qualifying_rate_basis IN ('note_rate', 'max_first_5y', 'greater_note_plus_cap_or_fir', 'greater_note_or_fir_hpml', 'du_arm_qualifying_rate_field')),
  buydown_ignored            boolean NOT NULL DEFAULT false,                  -- B3-6-04: qualified without consideration of the bought-down rate
  pi_cents                   bigint NOT NULL CHECK (pi_cents >= 0),
  bought_down_pi_cents       bigint CHECK (bought_down_pi_cents IS NULL OR bought_down_pi_cents >= 0),   -- the year-1 payment, recorded and never used to qualify
  mi_cents                   bigint NOT NULL DEFAULT 0 CHECK (mi_cents >= 0),
  taxes_cents                bigint NOT NULL DEFAULT 0 CHECK (taxes_cents >= 0),
  hazard_cents               bigint NOT NULL DEFAULT 0 CHECK (hazard_cents >= 0),
  flood_cents                bigint NOT NULL DEFAULT 0 CHECK (flood_cents >= 0),
  hoa_cents                  bigint NOT NULL DEFAULT 0 CHECK (hoa_cents >= 0),
  coop_fee_cents             bigint NOT NULL DEFAULT 0 CHECK (coop_fee_cents >= 0),
  ground_rent_cents          bigint NOT NULL DEFAULT 0 CHECK (ground_rent_cents >= 0),
  special_assessment_cents   bigint NOT NULL DEFAULT 0 CHECK (special_assessment_cents >= 0),
  subordinate_payment_cents  bigint NOT NULL DEFAULT 0 CHECK (subordinate_payment_cents >= 0),
  pitia_cents                bigint NOT NULL CHECK (pitia_cents >= 0),
  formula_version            text NOT NULL,
  inputs                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qualifying_payments_pitia_sum CHECK (pitia_cents = pi_cents + mi_cents + taxes_cents + hazard_cents + flood_cents + hoa_cents + coop_fee_cents + ground_rent_cents + special_assessment_cents + subordinate_payment_cents),
  UNIQUE (application_id, property_role, version)
);
COMMENT ON TABLE qualifying_payments IS '22.5 qualifying payment per version (B3-6-04): qualifying rate by product (fixed → note; ≤ 3-year ARM → max in first five years; 5-year ARM → greater of note + first cap or fully indexed; 7/10-year → note, fully indexed if HPML/HPCT; Generic ARM → DU field), P&I at that rate, PITIA components (B3-6-03); immutable — a term change is a new version';
CREATE INDEX qualifying_payments_app_idx ON qualifying_payments(application_id, version);
CREATE TRIGGER qualifying_payments_immutable BEFORE UPDATE OR DELETE ON qualifying_payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── dti_calculations (B3-6-02; immutable per version) ─────────────────────────────
CREATE TABLE dti_calculations (
  dti_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id             uuid NOT NULL REFERENCES applications(id),
  version                    integer NOT NULL CHECK (version >= 1),
  stage                      text NOT NULL CHECK (stage = 'application' OR stage = 'decision_of_record' OR stage = 'pre_cd' OR stage = 'final' OR stage ~ '^du_submission_[0-9]+$' OR stage ~ '^cd_v[0-9]+$'),
  income_snapshot_id         uuid,                                            -- 22.3 income snapshot (income_calculations)
  qualifying_income_cents    bigint NOT NULL CHECK (qualifying_income_cents > 0),
  income_reductions_cents    bigint NOT NULL DEFAULT 0 CHECK (income_reductions_cents >= 0),   -- alimony / equalization / separate maintenance elected (B3-6-05)
  qp_id                      uuid NOT NULL REFERENCES qualifying_payments(qp_id),
  obligations_cents          bigint NOT NULL CHECK (obligations_cents >= 0),
  liability_ids              uuid[] NOT NULL DEFAULT '{}',                    -- the included set
  dti_bps                    integer NOT NULL CHECK (dti_bps >= 0),           -- R1: round_half_up(obligations × 10000 / income), rounded once at the ratio
  dti_display_pct            numeric(5,2) NOT NULL,                           -- dti_bps / 100
  du_cap_ok                  boolean NOT NULL,                                -- dti_bps ≤ 5000 (B3-6-02 DU maximum)
  b3_2_10_check_id           uuid,                                            -- 23.1 du_resubmission_checks
  hmda_reported              boolean NOT NULL DEFAULT false,                  -- 28.3 reports the decision-of-record version (§1003.4(a)(23))
  agent_run_id               text,
  formula_version            text NOT NULL,
  computed_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dti_calculations_display CHECK (dti_display_pct = dti_bps / 100.0),
  CONSTRAINT dti_calculations_cap CHECK (du_cap_ok = (dti_bps <= 5000)),
  UNIQUE (application_id, version)
);
COMMENT ON TABLE dti_calculations IS '22.5 immutable DTI versions (B3-6-02): obligations = subject PITIA at the qualifying payment + other REO + Σ included liability payments; income = 22.3 qualifying income − elected reductions; dti_bps rounded half-up once; du_cap_ok is DU''s 50 % ceiling, the B3-2-10 45 %/3-point check (23.1) is referenced by b3_2_10_check_id; the decision-of-record version is the HMDA DTI (28.3) and the final version must equal the final DU submission (23.1) and the CD-final P&I (25.2)';
CREATE INDEX dti_calculations_app_idx ON dti_calculations(application_id, version);
CREATE TRIGGER dti_calculations_immutable BEFORE UPDATE OR DELETE ON dti_calculations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── debt_payoff_plans (B3-6-07) ─────────────────────────────
CREATE TABLE debt_payoff_plans (
  plan_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id             uuid NOT NULL REFERENCES applications(id),
  liability_id               uuid NOT NULL REFERENCES application_liabilities(id),
  mode                       text NOT NULL CHECK (mode IN ('pay_off_before_closing', 'pay_off_at_closing', 'pay_down_to_le_10', 'pay_down_revolving')),
  amount_cents               bigint NOT NULL CHECK (amount_cents > 0),        -- revolving: the current balance; paydown: balance − 10 × payment (creditor payoff letter governs)
  funds_source_asset_id      uuid REFERENCES application_assets(id),
  funds_verified_in_addition boolean NOT NULL DEFAULT false,                  -- B3-6-07: over and above closing costs and reserves (22.4 funds_to_verify += amount)
  evidence                   text CHECK (evidence IS NULL OR evidence IN ('payoff_statement_before_closing', 'settlement_statement_line', 'creditor_letter_remaining_payments', 'zero_balance_statement')),
  evidence_document_id       uuid REFERENCES documents(id),
  reviewer_required          boolean NOT NULL DEFAULT false,                  -- Q1: excluded payments > 10 % of income or payoff > 50 % of post-closing liquid assets → underwriting_reviewer
  status                     text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'evidenced', 'failed')),
  scheduled_note_date        date,
  rationale                  text NOT NULL,                                   -- the B3-6-07 "carefully evaluated" credit-use rationale
  formula_version            text NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT debt_payoff_plans_evidenced CHECK (status <> 'evidenced' OR evidence IS NOT NULL)
);
COMMENT ON TABLE debt_payoff_plans IS '22.5 debts paid off or paid down at or before closing (B3-6-07): revolving payoffs need no account closure; installment paydowns to ≤ 10 payments drop out; the funds are verified in addition to cash to close and reserves and the payoff must appear on the settlement statement or a pre-closing payoff / zero-balance statement (FNMA_B3_6_07_PAYOFF_FUNDS_GATE blocks funding.authorized otherwise; a failed plan re-includes the payment)';
CREATE INDEX debt_payoff_plans_app_idx ON debt_payoff_plans(application_id, status);

COMMIT;
