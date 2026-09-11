-- 0072_closing_notices.sql — §25.4 other closing-time and immediate post-closing consumer notices
-- (spec/sections/25-compliance-testing-the-closing-disclosure-rescission-and-clo/25-4-*.md "Data model").
-- 25.4's own tables: `closing_notice_runs` (the closing-day package and the post-closing run with per-item evidence),
-- `escrow_elections` (the election / waiver record feeding servicing 3.8 at boarding), `ownership_transfer_notices`
-- (the §1026.39 expectation 30.4 mirrors — Fannie Mae sends its own purchase letter; the platform records, evidences
-- and only sends as a fallback) and `tax_reporting_seeds` (the Form 1098 seeds handed to servicing 7.1-A at boarding).
-- Baseline columns the spec adds: `disclosures.package_run_id` (0064), `loans.payment_address_named_at_closing` and
-- `loans.first_payment_letter_sent_at` (0001), `escrow_accounts.initial_statement_document_id` (0060 already carries
-- `initial_statement_delivered_at` / `initial_statement_delivery_basis`). Additive only: `applications` (0057), `loans`,
-- `documents`, `parties` (0001), `disclosures` (0064) and `escrow_accounts` (0001/0060) are referenced or extended, never rewritten.
-- `disclosures.kind` keeps 0064's CHECK (`state:[A-Z]{2}`): the spec's `state:UT_7_17_4` / `state:CA_CIV_2954` kinds are
-- stored as `state:UT` / `state:CA` with the statute on the package item (`closing_notice_runs.items[].disclosure_kind`).
BEGIN;

ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'fnma_loan_file_life_plus_4y';

-- ---------------------------------------------------------------- closing_notice_runs (package manifest with per-item evidence)
CREATE TABLE closing_notice_runs (
  run_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  loan_id                     uuid REFERENCES loans(id),                         -- set by 30.2 at hand-off
  kind                        text NOT NULL CHECK (kind IN ('closing_package', 'post_closing')),
  composed_at                 timestamptz NOT NULL,
  cd_disclosure_id            uuid REFERENCES disclosures(id),                   -- the consummation_ready CD version the package figures come from
  cd_version                  int,
  items                       jsonb NOT NULL DEFAULT '[]',                       -- [{notice_code, owner_process, required, in_package, basis, gate, disclosure_kind, rendered_document_id, channel, delivered_at, receipt_evidence, after_closing}]
  status                      text NOT NULL DEFAULT 'composing' CHECK (status IN ('composing', 'gated', 'delivered', 'evidenced', 'exception', 'scheduled', 'sent')),
  gates                       jsonb NOT NULL DEFAULT '{}',                       -- {GLBA_1016_4_INITIAL_PRIVACY_GATE: {open, reason}, SM_O64_CLOSING_PACKAGE_NOTICES_GATE: …, UT_7_17_4_…, CA_CIV_2954_…}
  consistency                 jsonb,                                             -- CD_ESCROW_VS_O11_3 result, variances, corrected_cd {cd_reason}
  refusal                     jsonb,                                             -- {code: 'JURISDICTION_RULE_UNVERIFIED', reason, state, escalate_to: 'officer'}
  escrow_statement_decision   text CHECK (escrow_statement_decision IN ('in_package', 'deferred', 'not_escrowed')),
  scheduled_on                date,                                              -- post_closing: disbursement + 2 business_days_servicer
  agent_run_id                text NOT NULL,
  consummation_at             timestamptz,
  property_state              char(2),
  retention_class             retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE closing_notice_runs IS '25.4: the closing-day notice run (kind=closing_package: composing → gated → delivered → evidenced | exception) and the post-closing run (scheduled → sent → evidenced) with per-item rendering, channel, delivery time and receipt evidence; SM_O64_CLOSING_PACKAGE_NOTICES_GATE opens on status=gated.';
CREATE INDEX closing_notice_runs_application_idx ON closing_notice_runs (application_id, kind);

-- ---------------------------------------------------------------- escrow_elections (feeds servicing 3.8 at boarding)
CREATE TABLE escrow_elections (
  election_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  election                    text NOT NULL CHECK (election IN ('escrow_full', 'waived', 'partial_taxes_only', 'partial_insurance_only')),
  waiver_policy_version       text NOT NULL,                                     -- the partner's written policy (B2-1.5-04)
  waiver_criteria             jsonb NOT NULL DEFAULT '{}',                       -- {ltv_pct, reserves_months_of_ti, mortgage_lates_30_in_12m, hpml, bpmi, delinquent_tax_financed_refi, flood_required_escrow, blanket_policy_unit, state}
  waiver_reasons              text[] NOT NULL DEFAULT '{}',                      -- block reasons: hpml | bpmi | delinquent_tax_financed_refi | flood_required_escrow | state_prohibits | partner_policy_*
  waiver_fee_cents            bigint NOT NULL DEFAULT 0 CHECK (waiver_fee_cents >= 0),  -- 0 unless the partner prices one (no Fannie Mae LLPA exists)
  state_notice_codes          text[] NOT NULL DEFAULT '{}',                      -- NTC_SM_ESCROW_ELECTION (+ NTC_UT_7_17_4_RESERVE_OPTIONS | NTC_CA_CIV_2954_IMPOUND_STMT)
  elected_at                  timestamptz NOT NULL,                              -- UT gate: elected_at ≤ consummation_at
  election_evidence_document_id uuid REFERENCES documents(id),
  interest_on_escrow_required boolean NOT NULL DEFAULT false,                    -- state (Utah §7-17-3 at ≤ 80% LTV)
  recorded_by                 text NOT NULL,                                     -- agent run id
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE escrow_elections IS '25.4: the borrower''s escrow election with the partner-policy criteria evaluated (evaluateEscrowWaiver), the waiver fee (default 0), the state notices delivered and the state interest-on-escrow flag; read by 30.3 and by servicing 3.8 at boarding.';
CREATE INDEX escrow_elections_application_idx ON escrow_elections (application_id, elected_at);

-- ---------------------------------------------------------------- ownership_transfer_notices (§1026.39 expectation; 30.4 mirrors)
CREATE TABLE ownership_transfer_notices (
  otn_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                     uuid NOT NULL REFERENCES loans(id),
  application_id              uuid REFERENCES applications(id),
  covered_person              text NOT NULL CHECK (covered_person IN ('fannie_mae', 'sm_warehouse_assignee', 'other')),
  date_of_transfer            date NOT NULL,                                     -- purchase advice date (acquirer's books) or the transferor's books date
  date_basis                  text NOT NULL DEFAULT 'acquirer_books' CHECK (date_basis IN ('acquirer_books', 'transferor_books')),
  due_date                    date NOT NULL,                                     -- date_of_transfer + 30 calendar days (no holiday/weekend adjustment)
  sender                      text NOT NULL DEFAULT 'covered_person_direct' CHECK (sender IN ('covered_person_direct', 'servicer_on_behalf')),
  notice_id                   uuid REFERENCES notices(id),                       -- only when sender = servicer_on_behalf (or SM is the assignee)
  sent_at                     timestamptz,
  evidence_document_id        uuid REFERENCES documents(id),                     -- copy of Fannie Mae's letter, or the borrower-reported receipt
  evidence_due                date,                                              -- purchase + 45 calendar days (SM_O64_FNMA_1026_39_EVIDENCE_45)
  status                      text NOT NULL DEFAULT 'expected' CHECK (status IN ('not_applicable', 'expected', 'sent', 'evidenced', 'exception_c1', 'exception_c2', 'exception_c3', 'overdue_unconfirmed')),
  rationale                   text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ownership_transfer_due CHECK (due_date = date_of_transfer + 30)
);
COMMENT ON TABLE ownership_transfer_notices IS '25.4: the Reg Z §1026.39 record per acquisition — covered person, date of transfer (at the covered person''s option), due date (30th calendar day), sender (Fannie Mae sends its own purchase letter by default; servicer_on_behalf only under a written Fannie Mae instruction), evidence and status; 30.4 mirrors status=expected and evidences the Fannie Mae letter.';
CREATE INDEX ownership_transfer_notices_loan_idx ON ownership_transfer_notices (loan_id, status);

-- ---------------------------------------------------------------- tax_reporting_seeds (→ servicing 7.1-A Form 1098)
CREATE TABLE tax_reporting_seeds (
  loan_id                     uuid PRIMARY KEY REFERENCES loans(id),
  origination_date            date NOT NULL,                                     -- the note/consummation date (decision 25.4-Q5) — Box 3
  principal_at_origination_cents bigint NOT NULL CHECK (principal_at_origination_cents > 0),  -- Box 2 in the origination year
  prepaid_interest_cents      bigint NOT NULL DEFAULT 0 CHECK (prepaid_interest_cents >= 0),  -- closing-year Box 1 candidate
  prepaid_interest_period     daterange,                                         -- [disbursement_date, first_period_end]
  points_paid_cents           bigint NOT NULL DEFAULT 0 CHECK (points_paid_cents >= 0),       -- Box 6-eligible: purchase of the principal residence, designated as points on the CD, % of principal, borrower-paid
  points_seller_paid_cents    bigint NOT NULL DEFAULT 0 CHECK (points_seller_paid_cents >= 0),
  points_refinance_excluded_cents bigint NOT NULL DEFAULT 0 CHECK (points_refinance_excluded_cents >= 0),
  mi_premiums_paid_at_closing_cents bigint NOT NULL DEFAULT 0 CHECK (mi_premiums_paid_at_closing_cents >= 0),  -- Box 5
  property_address_id         uuid,
  payer_of_record_borrower_id uuid REFERENCES parties(id),
  acquisition_date            date,                                              -- blank — partner originated (Box 11 never set here)
  source_cd_disclosure_id     uuid REFERENCES disclosures(id),
  seeds_hash                  char(64) NOT NULL,
  handed_off_at               timestamptz,                                       -- tax_reporting.seeds.handed_off (SM_O64_1098_SEEDS_AT_BOARDING_GATE)
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_reporting_seeds_origination CHECK (acquisition_date IS NULL)
);
COMMENT ON TABLE tax_reporting_seeds IS '25.4: Form 1098 seeds handed to servicing 7.1-A at boarding — origination date (note date), principal at origination, closing-year prepaid interest (Box 1 candidate), Box 6-eligible points (never on a refinance), MI paid at closing (Box 5), acquisition date blank (partner originated); immutable once handed off.';
CREATE TRIGGER tax_reporting_seeds_immutable BEFORE UPDATE OR DELETE ON tax_reporting_seeds FOR EACH ROW WHEN (OLD.handed_off_at IS NOT NULL) EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- baseline columns the spec adds
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS package_run_id uuid REFERENCES closing_notice_runs(run_id);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS payment_address_named_at_closing boolean NOT NULL DEFAULT true;   -- false only in the 1.3 combined MS-2 fallback
ALTER TABLE loans ADD COLUMN IF NOT EXISTS first_payment_letter_sent_at timestamptz;
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS initial_statement_document_id uuid REFERENCES documents(id);

COMMIT;
