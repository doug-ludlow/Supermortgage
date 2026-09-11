-- 0097_warehouse_facility.sql — §27.1 Warehouse facility mechanics: Supermortgage as warehouse provider under a recourse
-- loan-and-security agreement with the partner (spec/sections/27-…/27-1-warehouse-facility-mechanics-….md "Data model";
-- addendum §3 "Closing and funding"). Owned here: the addendum §3 baseline tables `warehouse_facilities`, `warehouse_advances`,
-- `bailee_letters` with 27.1's column sets, and the six 27.1 tables `warehouse_interest_accruals`, `warehouse_curtailments`,
-- `warehouse_collateral_defects`, `warehouse_borrowing_base_snapshots`, `warehouse_covenant_tests`, `warehouse_daily_reports`;
-- plus the "Added columns" 27.1 assigns to the shared 0019 tables (`custody_records.bailee_letter_id`,
-- `custody_records.holding_for_party_id`; `enotes.secured_party_org_id/_added_at/_released_at`). Not here (other owners,
-- never duplicated): applications (0057), loans / parties / documents / ledger_lines / agent_decisions (0001),
-- custody_records / enotes / escalations (0019), fundings (26.3, in flight — `fundings.warehouse_advance_id` lands with it).
-- Money is bigint cents; rates are integer basis points; the unrounded cumulative interest basis is numeric(20,8) dollars
-- for audit (rule 6). Accruals, borrowing-base snapshots, covenant tests and daily reports are append-only (0001's
-- forbid_mutation trigger); advances, facilities, bailee letters, curtailments and defects carry a status and are never
-- deleted. Retention: fnma_loan_file_life_plus_4y and the 7-year commercial-records policy.
BEGIN;

-- ---------------------------------------------------------------- warehouse_facilities (the executed LSA; one row per partner facility)
CREATE TABLE warehouse_facilities (
  facility_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                      uuid NOT NULL REFERENCES parties(id),
  agreement_kind                  text NOT NULL CHECK (agreement_kind IN ('lsa', 'mra')),
  legal_form                      text NOT NULL DEFAULT 'secured_loan_to_partner' CHECK (legal_form IN ('secured_loan_to_partner', 'purchase_at_closing')),   -- 31.1 §G Form A; Form B refused without an officer-and-counsel record
  officer_and_counsel_record_id   uuid,                                            -- required when legal_form = purchase_at_closing (never table funding by configuration)
  executed_at                     timestamptz,
  effective_from                  date,
  maturity_on                     date,
  facility_limit_cents            bigint NOT NULL CHECK (facility_limit_cents > 0),
  wet_sublimit_pct                numeric(5,2) NOT NULL DEFAULT 40,
  advance_rate_bps                integer NOT NULL DEFAULT 9800,
  index_code                      text NOT NULL DEFAULT 'sofr_daily_simple' CHECK (index_code IN ('sofr_daily_simple')),
  index_lookback_business_days    integer NOT NULL DEFAULT 1,
  spread_bps                      integer NOT NULL DEFAULT 250,
  floor_bps                       integer NOT NULL DEFAULT 0,
  day_count                       text NOT NULL DEFAULT 'act_360' CHECK (day_count IN ('act_360')),
  interest_treatment              text NOT NULL DEFAULT 'capitalize_monthly' CHECK (interest_treatment IN ('capitalize_monthly', 'invoice_monthly')),
  wet_note_delivery_business_days integer NOT NULL DEFAULT 5,
  aging_curtail_day               integer NOT NULL DEFAULT 45,
  curtail_pct                     numeric(5,2) NOT NULL DEFAULT 10,
  dwell_stepup_bps                integer NOT NULL DEFAULT 50,
  wet_overdue_stepup_bps          integer NOT NULL DEFAULT 100,
  repurchase_day                  integer NOT NULL DEFAULT 60,
  kickout_day                     integer NOT NULL DEFAULT 90,
  wire_fee_cents                  bigint NOT NULL DEFAULT 2500,
  custodian_fee_cents             bigint NOT NULL DEFAULT 0,                       -- pass-through when SM's designated custodian is used
  max_loan_cents                  bigint NOT NULL,                                 -- 2026 ceiling by units / county (F11 table)
  concentration_limits            jsonb NOT NULL DEFAULT '{}'::jsonb,              -- {wet_pct, state_pct, arm_pct, investment_pct, two_to_four_pct, tx_50a6_pct, aged_over_45_pct, paper_pct}
  covenants                       jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{code, threshold, unit, test_frequency}]
  ucc1_filing_number              text,
  ucc1_filed_on                   date,
  ucc1_lapse_on                   date,                                            -- filed_on + 5 years (9-515); continuation window opens 6 months earlier
  ucc_jurisdiction                text,                                            -- partner's state of organization (9-307)
  collection_account_ref          text,                                            -- bank/account hash (SM collection account = the partner's Form 482 payee code for SM)
  funding_account_ref             text,
  haircut_reserve_account_ref     text,
  fnma_warehouse_lender_id        char(9),                                         -- nine-digit warehouse lender ID (Loan Delivery warehouse-lender org)
  bailee_letter_name              text,                                            -- exact letterhead text = Loan Delivery "Letter Name" (Warehouse Lender User Guide p. 5)
  form_482_payee_hash             text,                                            -- hash of the partner's Form 482 instructions for SM; bailee_letters.wire_instructions_hash must equal it
  funding_agreement_fnma_executed_at timestamptz,                                  -- eNote Transfer of Control and Location and Custodial Agreement
  mers_org_id_sm                  char(7),
  partner_state                   char(2),
  california_financing_law_resolved boolean NOT NULL DEFAULT false,                -- 27.1-Q8: no California advance until resolved
  status                          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'suspended', 'terminated')),
  policy_version                  text NOT NULL DEFAULT 'sm.warehouse.v1',
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_facilities_form_b_needs_record CHECK (legal_form = 'secured_loan_to_partner' OR officer_and_counsel_record_id IS NOT NULL)
);
COMMENT ON TABLE warehouse_facilities IS '27.1 warehouse_facilities (addendum §3 baseline; 27.1 column set): the executed Warehouse Loan and Security Agreement per partner — limit, advance rate (9800 bps), wet sublimit, Daily Simple SOFR + spread act/360, aging/curtailment/repurchase/kick-out days, fees, concentration limits, covenants, UCC-1, accounts, Fannie Mae warehouse-lender ID, Bailee Letter Name, Form 482 hash, Funding Agreement, status. Legal form defaults to a secured loan to the partner (never table funding).';
CREATE TRIGGER warehouse_facilities_no_delete BEFORE DELETE ON warehouse_facilities FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- warehouse_advances (one per funded loan; state machine requested → … → repaid / repurchased / kicked_out)
CREATE TABLE warehouse_advances (
  advance_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id                     uuid NOT NULL REFERENCES warehouse_facilities(facility_id),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  loan_id                         uuid REFERENCES loans(id),                       -- set once 30.2 creates the servicing row (loans.warehouse_advance_id points back)
  funding_id                      uuid,                                            -- 26.3 fundings (in flight — no FK until it lands)
  requested_at                    timestamptz NOT NULL,
  approved_at                     timestamptz,
  advance_date                    date,                                            -- value date of the outbound wire (day 0 of aging)
  note_form                       text NOT NULL CHECK (note_form IN ('enote', 'paper')),
  wet                             boolean NOT NULL DEFAULT false,
  wet_reason                      text NOT NULL DEFAULT 'none' CHECK (wet_reason IN ('wet_state_paper', 'enote_pre_secured_party', 'none')),
  note_amount_cents               bigint NOT NULL CHECK (note_amount_cents > 0),
  net_disbursement_cents          bigint NOT NULL,
  advance_cents                   bigint NOT NULL DEFAULT 0,                       -- min(round_half_up(advance_rate × note_amount), net_disbursement)
  advance_rate_bps                integer NOT NULL DEFAULT 9800,
  partner_contribution_cents      bigint NOT NULL DEFAULT 0,                       -- net_disbursement − advance (haircut reserve)
  outstanding_principal_cents     bigint NOT NULL DEFAULT 0,
  capitalized_interest_cents      bigint NOT NULL DEFAULT 0,
  fees_outstanding_cents          bigint NOT NULL DEFAULT 0,
  interest_accrued_cents          bigint NOT NULL DEFAULT 0,
  index_rate_bps                  integer,
  all_in_rate_bps                 integer,
  dwell_stepup_active             boolean NOT NULL DEFAULT false,
  wet_overdue                     boolean NOT NULL DEFAULT false,
  collateral_value_cents          bigint NOT NULL DEFAULT 0,                       -- mark-to-commitment (rule 3)
  eligibility_snapshot            jsonb,                                           -- criteria → pass/fail with evidence ids and rule-set versions
  collateral_status               text NOT NULL DEFAULT 'unsecured_wet' CHECK (collateral_status IN ('unsecured_wet', 'secured_possession', 'secured_control', 'transferred_pending_payment', 'released', 'returned')),
  custody_record_id               uuid REFERENCES custody_records(loan_id),
  bailee_letter_id                uuid,                                            -- FK added below once bailee_letters exists
  interim_funder_designated_at    timestamptz,
  secured_party_added_at          timestamptz,
  secured_party_released_at       timestamptz,
  note_received_at                timestamptz,
  aged_days                       integer NOT NULL DEFAULT 0,
  aging_bucket                    text NOT NULL DEFAULT 'd0_30' CHECK (aging_bucket IN ('d0_30', 'd31_45', 'd46_60', 'd61_90', 'd90_plus')),
  curtailment_due_cents           bigint NOT NULL DEFAULT 0,
  repurchase_demanded_at          timestamptz,
  kickout_at                      timestamptz,
  status                          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'funded', 'delivered', 'transferred_pending_payment', 'repaid', 'repurchased', 'curtailed', 'kicked_out', 'returned')),
  rejection_reasons               jsonb NOT NULL DEFAULT '[]'::jsonb,
  wire_out_id                     text,                                            -- bank reference (Fedwire)
  repaid_at                       timestamptz,
  repaid_from                     text CHECK (repaid_from IN ('purchase_proceeds', 'partner_repurchase', 'curtailment', 'rescission_unwind')),
  agent_decision_id               uuid REFERENCES agent_decisions(id),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE warehouse_advances IS '27.1 warehouse_advances (addendum §3 baseline; 27.1 column set): one advance per funded loan under the facility — amounts, rate, wet/dry, collateral status chain (trust receipt / Secured Party / Interim Funder / Transfer of Control), aging bucket, curtailments, repurchase/kick-out marks, state machine status; repaid by 27.2 (purchase proceeds), a partner repurchase, or a 25.3 rescission unwind.';
CREATE INDEX warehouse_advances_facility_idx ON warehouse_advances (facility_id, status);
CREATE INDEX warehouse_advances_loan_idx ON warehouse_advances (loan_id);
CREATE INDEX warehouse_advances_application_idx ON warehouse_advances (application_id);
CREATE TRIGGER warehouse_advances_no_delete BEFORE DELETE ON warehouse_advances FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- bailee_letters (one per shipment; Letter Name = letterhead; Form 482 hash equality)
CREATE TABLE bailee_letters (
  bailee_letter_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id                     uuid NOT NULL REFERENCES warehouse_facilities(facility_id),
  custodian_party_id              uuid REFERENCES parties(id),
  letter_name                     text NOT NULL,                                   -- must equal warehouse_facilities.bailee_letter_name character-for-character
  letter_date                     date NOT NULL,
  loan_list                       jsonb NOT NULL,                                  -- [{advance_id, seller_loan_number, borrower_last_name, note_amount_cents, note_date}] (pii=true)
  wire_instructions_hash          text NOT NULL,                                   -- must equal the partner's Form 482 payee-code hash for SM
  release_condition_text          text NOT NULL,                                   -- C1-2-05 wording
  return_instruction_text         text,
  expires_on                      date NOT NULL,                                   -- letter_date + 90 calendar days (policy)
  signed_by                       text,                                            -- SM officer
  signature_kind                  text NOT NULL DEFAULT 'esign' CHECK (signature_kind IN ('esign', 'wet_ink')),
  document_id                     uuid REFERENCES documents(id),
  custodian_acknowledged_at       timestamptz,                                     -- trust receipt / 9-313(c) acknowledgment
  fnma_letter_type                text NOT NULL DEFAULT 'bailee' CHECK (fnma_letter_type IN ('bailee', 'form_2004a')),
  form_2004a_document_id          uuid REFERENCES documents(id),
  status                          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'acknowledged', 'released', 'withdrawn', 'corrected')),
  superseded_by                   uuid REFERENCES bailee_letters(bailee_letter_id),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE bailee_letters IS '27.1 bailee_letters (addendum §3 baseline; 27.1 column set): one SM bailee letter per paper-note shipment (many loans) — letterhead text = Loan Delivery Letter Name, wire instructions = the partner''s Form 482 payee code for SM (hash equality), the C1-2-05 release condition, expiry, SM officer e-signature, custodian acknowledgment, Form 2004A exception path, corrections per the Bailee Correction Reminders.';
CREATE INDEX bailee_letters_facility_idx ON bailee_letters (facility_id, status);
CREATE TRIGGER bailee_letters_no_delete BEFORE DELETE ON bailee_letters FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE warehouse_advances ADD CONSTRAINT warehouse_advances_bailee_letter_fk FOREIGN KEY (bailee_letter_id) REFERENCES bailee_letters(bailee_letter_id);

-- ---------------------------------------------------------------- warehouse_interest_accruals (rule 6: one row per advance per accrual date; cumulative method; append-only)
CREATE TABLE warehouse_interest_accruals (
  accrual_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id                      uuid NOT NULL REFERENCES warehouse_advances(advance_id),
  accrual_date                    date NOT NULL,
  principal_basis_cents           bigint NOT NULL,
  index_rate_bps                  integer NOT NULL,
  index_publication_date          date NOT NULL,                                   -- SOFR publication used (one-business-day lookback)
  spread_bps                      integer NOT NULL,
  stepup_bps                      integer NOT NULL DEFAULT 0,                      -- dwell (+50) and/or wet-overdue (+100)
  all_in_rate_bps                 integer NOT NULL,
  cumulative_interest             numeric(20,8) NOT NULL,                          -- unrounded cumulative basis in dollars, for audit
  posted_cents                    bigint NOT NULL,                                 -- round_half_up(C(n)) − Σ previous postings
  capitalized                     boolean NOT NULL DEFAULT false,
  ledger_entry_id                 uuid REFERENCES ledger_entry_sets(id),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (advance_id, accrual_date)
);
COMMENT ON TABLE warehouse_interest_accruals IS '27.1 warehouse_interest_accruals: the daily act/360 accrual per advance at max(SOFR, floor) + spread + step-ups, posted by the cumulative rounding method (Σ postings = rounded cumulative; $725.64 for the 7-day fixture, never the per-diem $725.62); capitalized flag set by the monthly capitalization.';
CREATE TRIGGER warehouse_interest_accruals_immutable BEFORE UPDATE OR DELETE ON warehouse_interest_accruals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- warehouse_curtailments (rule 8: aging_45 / margin_call / wet_overdue / partner_voluntary)
CREATE TABLE warehouse_curtailments (
  curtailment_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id                      uuid NOT NULL REFERENCES warehouse_advances(advance_id),
  kind                            text NOT NULL CHECK (kind IN ('aging_45', 'margin_call', 'wet_overdue', 'partner_voluntary')),
  due_on                          date NOT NULL,                                   -- day 45 rolled to the next servicer business day; margin call +1 BD; wet overdue day 10
  amount_cents                    bigint NOT NULL CHECK (amount_cents > 0),
  paid_at                         timestamptz,
  wire_in_ref                     text,
  ledger_entry_id                 uuid REFERENCES ledger_entry_sets(id),
  status                          text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid', 'cancelled')),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE warehouse_curtailments IS '27.1 warehouse_curtailments: partial repayments the facility demands — 10% at day 45 (payable next servicer business day), margin calls when outstanding > collateral value (SM_WH_MARGIN_CALL_1BD), full repayment at day 10 of a wet-overdue advance, partner voluntary; paid rows satisfy the aging / margin clocks.';
CREATE INDEX warehouse_curtailments_advance_idx ON warehouse_curtailments (advance_id, status);
CREATE TRIGGER warehouse_curtailments_no_delete BEFORE DELETE ON warehouse_curtailments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- warehouse_collateral_defects (rule 9: anything that prevents purchase on the current path; SM_WH_DEFECT_CURE_10BD)
CREATE TABLE warehouse_collateral_defects (
  defect_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id                      uuid NOT NULL REFERENCES warehouse_advances(advance_id),
  source                          text NOT NULL CHECK (source IN ('custodian_exception', 'loan_delivery_edit', 'purchase_error', 'earlycheck_fatal', 'qc_finding', 'compliance_failure', 'missing_document', 'eregistry_mismatch', 'mers_mismatch')),
  recorded_at                     timestamptz NOT NULL,
  description                     text NOT NULL,
  cure_owner                      text NOT NULL CHECK (cure_owner IN ('secondary', 'post-closing', 'compliance-tester', 'title-closing')),
  cure_due_at                     date NOT NULL,                                   -- recorded_at + 10 business_days_servicer
  cured_at                        timestamptz,
  outcome                         text CHECK (outcome IN ('cured', 'repurchased', 'substituted', 'written_off')),
  evidence_document_id            uuid REFERENCES documents(id),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE warehouse_collateral_defects IS '27.1 warehouse_collateral_defects: defects recorded for the warehouse ledger the same day they are found (two-hats information barrier) — custodian exception, Loan Delivery edit / Purchase Error, EarlyCheck fatal, QC, compliance, missing document, eRegistry / MERS mismatch — with the 10-business-day cure clock and the owning agent; not cured → repurchase from the partner''s own funds.';
CREATE INDEX warehouse_collateral_defects_advance_idx ON warehouse_collateral_defects (advance_id, cured_at);
CREATE TRIGGER warehouse_collateral_defects_no_delete BEFORE DELETE ON warehouse_collateral_defects FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- warehouse_borrowing_base_snapshots (rule 3: 07:00 ET each servicer business day; append-only)
CREATE TABLE warehouse_borrowing_base_snapshots (
  snapshot_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id                     uuid NOT NULL REFERENCES warehouse_facilities(facility_id),
  as_of                           date NOT NULL,
  facility_limit_cents            bigint NOT NULL,
  outstanding_cents               bigint NOT NULL,
  eligible_collateral_value_cents bigint NOT NULL,
  ineligible_cents                jsonb NOT NULL DEFAULT '{}'::jsonb,              -- by reason: aged_over_kickout, unsecured_wet_overdue, interim_funder_missing, incurable_defect, concentration
  availability_cents              bigint NOT NULL,
  wet_outstanding_cents           bigint NOT NULL,
  wet_sublimit_cents              bigint NOT NULL,
  concentrations                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  margin_call_cents               bigint NOT NULL DEFAULT 0,
  rows                            jsonb NOT NULL DEFAULT '[]'::jsonb,              -- per-advance collateral value / eligibility / margin call
  report_document_id              uuid REFERENCES documents(id),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, as_of)
);
COMMENT ON TABLE warehouse_borrowing_base_snapshots IS '27.1 warehouse_borrowing_base_snapshots: the daily borrowing base — Σ eligible collateral value (advance rate × min(note amount, commitment price × note amount)), availability = min(limit, base + pending) − outstanding, wet usage against the wet sublimit, concentrations, margin calls; an advance without its Interim Funder designation past day 7, wet past its deadline, kicked out or with an incurable defect is ineligible.';
CREATE TRIGGER warehouse_borrowing_base_snapshots_immutable BEFORE UPDATE OR DELETE ON warehouse_borrowing_base_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- warehouse_covenant_tests (rule 10: quarterly ≤ 45 days, annual ≤ 90 days; append-only — a waiver is a new row)
CREATE TABLE warehouse_covenant_tests (
  test_id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id                     uuid NOT NULL REFERENCES warehouse_facilities(facility_id),
  covenant_code                   text NOT NULL,
  period_end                      date NOT NULL,
  test_frequency                  text NOT NULL DEFAULT 'quarterly' CHECK (test_frequency IN ('quarterly', 'annual')),
  reported_value                  text NOT NULL,
  threshold                       text NOT NULL,
  result                          text NOT NULL CHECK (result IN ('pass', 'fail', 'waived')),
  received_at                     timestamptz,
  late                            boolean NOT NULL DEFAULT false,
  evidence_document_id            uuid REFERENCES documents(id),
  certified_by                    text,                                            -- partner officer (Form 360 authority)
  waiver_id                       uuid,                                            -- officer{sm} waiver within 5 business days
  created_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE warehouse_covenant_tests IS '27.1 warehouse_covenant_tests: the partner officer''s certified quarterly (≤ 45 days) / annual (≤ 90 days) package tested against the LSA covenants (tangible net worth, liquidity, leverage, approvals, negative pledge, haircut reserve); a late package or a failure breaches → facility suspended for new advances unless waived by SM''s officer within 5 business days.';
CREATE INDEX warehouse_covenant_tests_facility_idx ON warehouse_covenant_tests (facility_id, period_end DESC);
CREATE TRIGGER warehouse_covenant_tests_immutable BEFORE UPDATE OR DELETE ON warehouse_covenant_tests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- warehouse_daily_reports (rule 11: the partner's daily position report by 09:00 ET; append-only)
CREATE TABLE warehouse_daily_reports (
  report_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id                     uuid NOT NULL REFERENCES warehouse_facilities(facility_id),
  as_of                           date NOT NULL,
  document_id                     uuid REFERENCES documents(id),                   -- PDF
  data_export_id                  text,                                            -- JSON export reference
  delivered_at                    timestamptz,
  channel                         text NOT NULL DEFAULT 'partner_portal' CHECK (channel IN ('partner_portal', 'sftp', 'api')),
  content                         jsonb NOT NULL DEFAULT '{}'::jsonb,              -- position, per-advance table, curtailments due, defects, covenant status, index history
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, as_of)
);
COMMENT ON TABLE warehouse_daily_reports IS '27.1 warehouse_daily_reports: the daily report to the partner (by 09:00 ET after the borrowing base) — position, per-advance table (aged days, bucket, collateral status, accrued interest, all-in rate, expected purchase date, exceptions), curtailments due, defects, covenant status, index history — as PDF + JSON; the partner GL mirror rides the 27.2 export.';
CREATE TRIGGER warehouse_daily_reports_immutable BEFORE UPDATE OR DELETE ON warehouse_daily_reports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- added columns on the shared 0019 tables (27.1 "Added columns")
ALTER TABLE custody_records ADD COLUMN IF NOT EXISTS bailee_letter_id uuid REFERENCES bailee_letters(bailee_letter_id);
ALTER TABLE custody_records ADD COLUMN IF NOT EXISTS holding_for_party_id uuid REFERENCES parties(id);      -- secured party of record (SM while an advance is open)
COMMENT ON COLUMN custody_records.holding_for_party_id IS '27.1: the party the custodian holds the note for (9-313(c) acknowledgment) — SM while a warehouse advance is open.';
ALTER TABLE enotes ADD COLUMN IF NOT EXISTS secured_party_org_id char(7);
ALTER TABLE enotes ADD COLUMN IF NOT EXISTS secured_party_added_at timestamptz;
ALTER TABLE enotes ADD COLUMN IF NOT EXISTS secured_party_released_at timestamptz;                          -- set from the registry notification (deleted automatically on Transfer of Control)
COMMENT ON COLUMN enotes.secured_party_released_at IS '27.1: when the eRegistry removed SM as Secured Party (automatically on the Transfer of Control and Location to Fannie Mae; the Funding Agreement governs until proceeds) or on SM''s Release Secured Party.';
ALTER TABLE loans ADD COLUMN IF NOT EXISTS warehouse_advance_id uuid REFERENCES warehouse_advances(advance_id);   -- 30.2 sets it at boarding (investor = partner_warehouse)

COMMIT;
