-- 0095_funding.sql — §26.3 Funding authorization and disbursement (spec/sections/26-…/26-3-funding-authorization-and-disbursement-….md "Data model").
-- Owned here: fundings (baseline table per spec/origination/01-architecture-baseline-addendum.md §3 — no earlier migration created it;
-- 25.3 exposes rescission_expires_at for it, 27.1 links warehouse_advance_id from 0097), funding_conditions, funding_worksheets,
-- funding_wires, funding_unwinds. Not here (other owners, never duplicated): closings / closing_documents (0073), recordings and
-- signing_sessions (0094), wire_verifications / settlement_agents / payoff_demands (0091), rescission_periods / rescission_exercises
-- (0071), warehouse_advances (0097 — applies after this file, so fundings.warehouse_advance_id carries no FK), disclosures (0064),
-- loans / documents / agent_decisions (0001), escalations (0019), timers, ledger_lines (baseline).
-- Money is bigint cents; instants timestamptz; local dates date. funding_conditions and funding_worksheets are append-only
-- snapshots/versions (0001's forbid_mutation); fundings, funding_wires and funding_unwinds are state rows whose every
-- change is also an appended loan_events row (`funding.*`, `loan.funded`).
BEGIN;

-- ---------------------------------------------------------------- fundings (one per closing; the origination anchor for disbursement_date / first_payment_date / lpi_date)
CREATE TABLE fundings (
  funding_id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                      uuid NOT NULL REFERENCES applications(id),
  loan_id                             uuid REFERENCES loans(id),                      -- set at loan.funded when 30.2 creates the servicing row
  closing_id                          uuid REFERENCES closings(id),                   -- 26.2
  funding_type                        text NOT NULL CHECK (funding_type IN ('wet', 'dry')),
  disbursement_authorization_mode     text NOT NULL CHECK (disbursement_authorization_mode IN ('table_funds_then_authorize', 'review_then_fund')),
  note_date                           date,
  consummation_at                     timestamptz,
  scheduled_funding_date              date,
  earliest_funding_date               date,                                           -- max(rescission expiry + 1 Fedwire day, dry-review readiness, TX expiry)
  funding_date                        date,                                           -- value date of the outbound wire (baseline column)
  disbursement_date                   date,                                           -- CD "Disbursement Date"; = funding_date unless the agent disburses later (baseline column)
  interest_accrual_start_date         date,                                           -- = disbursement_date (prepaid) / first of the month (interest credit)
  interest_mode                       text CHECK (interest_mode IN ('prepaid', 'interest_credit', 'none')),
  per_diem_basis                      smallint NOT NULL DEFAULT 365 CHECK (per_diem_basis IN (365, 360)),
  per_diem_cents                      bigint,                                         -- rounded half-up to the cent once (365_rounded_per_diem)
  prepaid_days                        smallint,
  interest_credit_days                smallint,
  per_diem_interest_cents             bigint,                                         -- per_diem_cents × prepaid_days (baseline column; 25.1/25.4 consume it)
  interest_credit_cents               bigint,                                         -- per_diem_cents × interest_credit_days (baseline column)
  first_payment_date                  date,
  first_payment_latest_allowed_date   date,                                           -- disbursement_date + 2 calendar months, clamped (C2-2-01)
  lpi_date                            date,                                           -- first_payment_date − 1 month (29.4 FNMA_C2_2_DELIVERY_LPI_45)
  maturity_date_expected              date,                                           -- first_payment_date − 1 month + term (B2-1.5-02)
  gross_loan_cents                    bigint,
  funding_worksheet                   jsonb,                                          -- latest funding_worksheets row (rule 4)
  net_wire_cents                      bigint,
  wire_id                             uuid,                                           -- funding_wires (FK added below; baseline column)
  wire_beneficiary_verification_id    uuid REFERENCES wire_verifications(id),         -- 24.4
  wire_instructions_hash              text,                                           -- must equal the verified record's hash at release
  wire_prepared_by_run_id             text,
  wire_released_by                    text,                                           -- funding_approver (never the funder agent)
  wire_released_at                    timestamptz,
  wire_imad                           text,
  wire_omad                           text,
  wire_confirmed_at                   timestamptz,
  funds_received_by_agent_at          timestamptz,
  disbursement_confirmed_at           timestamptz,
  disbursement_confirmation_source    text CHECK (disbursement_confirmation_source IN ('final_settlement_statement', 'recording_confirmation', 'agent_attestation', 'bank_debit_trace')),
  funding_conditions_checklist_id     uuid,                                           -- latest funding_conditions row (FK added below)
  warehouse_advance_id                uuid,                                           -- 27.1 warehouse_advances (0097 applies after this file — linked there)
  escrow_prefund                      boolean NOT NULL DEFAULT false,                 -- §1026.23(c) "other than in escrow" — officer-approved exception (26.3-Q4)
  rescission_expires_at               timestamptz,                                    -- copy of rescission_periods.expires_at (baseline column; 25.3)
  delivery_window_compressed          boolean NOT NULL DEFAULT false,                 -- interest-credit LPI compresses 29.4's 45-day window
  legal_form                          text NOT NULL DEFAULT 'secured_loan_to_partner' CHECK (legal_form IN ('secured_loan_to_partner', 'purchase_at_settlement')),
  hold_reason                         text,
  cancel_reason                       text CHECK (cancel_reason IS NULL OR cancel_reason IN ('rescinded_before_funding', 'conditions_failed', 'borrower_withdrew', 'documents_not_returned', 'fraud_suspected', 'lock_or_commitment_expired', 'partner_hold')),
  returned_funds_cents                bigint,
  returned_at                         timestamptz,
  unwind_id                           uuid,                                           -- 25.3 rescission_exercises.exercise_id or funding_unwinds.unwind_id
  status                              text NOT NULL DEFAULT 'pending_conditions' CHECK (status IN ('pending_conditions', 'conditions_met', 'authorized', 'advance_approved', 'wire_pending_release', 'wire_released', 'wire_accepted', 'funds_at_agent', 'disbursed', 'held', 'cancelled', 'returned', 'unwinding', 'unwound')),
  retention_class                     text NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                          timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fundings_disbursed_has_confirmation CHECK (status NOT IN ('disbursed', 'unwinding', 'unwound') OR (disbursement_date IS NOT NULL AND disbursement_confirmation_source IS NOT NULL)),
  CONSTRAINT fundings_released_has_approver CHECK (status NOT IN ('wire_released', 'wire_accepted', 'funds_at_agent', 'disbursed') OR wire_released_by IS NOT NULL),
  CONSTRAINT fundings_one_interest_mode CHECK (coalesce(per_diem_interest_cents, 0) = 0 OR coalesce(interest_credit_cents, 0) = 0)
);
COMMENT ON TABLE fundings IS '§26.3 funding record (baseline addendum §3): consummation → rescission expiry → Fedwire day → wire → disbursement; the origination source of disbursement_date, first_payment_date, lpi_date and prepaid interest / interest credit (30.2, 29.3, 29.4, 25.4 consume). Retention fnma_loan_file_life_plus_4y; wire details hashed.';
CREATE UNIQUE INDEX fundings_application_active ON fundings (application_id) WHERE status NOT IN ('cancelled', 'unwound');
CREATE INDEX fundings_scheduled ON fundings (scheduled_funding_date) WHERE status IN ('pending_conditions', 'conditions_met', 'authorized', 'advance_approved', 'wire_pending_release', 'held');

-- ---------------------------------------------------------------- funding_conditions (checklist snapshots; append-only)
CREATE TABLE funding_conditions (
  checklist_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  funding_id                          uuid NOT NULL REFERENCES fundings(funding_id),
  evaluated_at                        timestamptz NOT NULL,
  items                               jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{code, owner_process, status ∈ pass|fail|waived|n/a|pending, evidence_ref, evaluated_at, note}]
  passed                              boolean NOT NULL DEFAULT false,
  blocking_codes                      text[] NOT NULL DEFAULT '{}',
  pending_codes                       text[] NOT NULL DEFAULT '{}',
  pre_signing_subset_passed           boolean NOT NULL DEFAULT false,                 -- wet states: everything except the post-signing items
  waivers                             jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{code ∈ FC_RECORDING_CONFIRMED|FC_COMMITMENT_LIVE|FC_CD_ACK, waived_by ∈ funding_approver|officer, reason, at}]
  soft_flags                          text[] NOT NULL DEFAULT '{}',
  rule_set_versions                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE funding_conditions IS '§26.3 rule 1: one snapshot per evaluation of the 31 FC_ item codes, each resolved from platform state (never an e-mail assertion); waivers only for the three waivable items, by the funding_approver with a reason. Append-only.';
CREATE TRIGGER funding_conditions_immutable BEFORE UPDATE OR DELETE ON funding_conditions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE INDEX funding_conditions_funding ON funding_conditions (funding_id, evaluated_at DESC);
ALTER TABLE fundings ADD CONSTRAINT fundings_checklist_fk FOREIGN KEY (funding_conditions_checklist_id) REFERENCES funding_conditions(checklist_id);

-- ---------------------------------------------------------------- funding_worksheets (one row per version; append-only)
CREATE TABLE funding_worksheets (
  worksheet_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  funding_id                          uuid NOT NULL REFERENCES fundings(funding_id),
  version                             int NOT NULL,
  cd_version                          int NOT NULL,                                   -- 25.2 disclosures.version the figures reconcile to
  settlement_statement_document_id    uuid REFERENCES documents(id),
  lines                               jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{line_code, description, amount_cents, sign, source ∈ cd|settlement_statement|computed, cd_reference}]
  gross_loan_cents                    bigint NOT NULL,
  lender_retained_cents               bigint NOT NULL,                                -- prepaid interest + escrow deposit + lender-retained fees
  lender_credits_cents                bigint NOT NULL DEFAULT 0,
  interest_credit_cents               bigint NOT NULL DEFAULT 0,
  net_wire_cents                      bigint NOT NULL,
  agent_requested_net_cents           bigint,                                         -- from the settlement statement
  variance_cents                      bigint,                                         -- net_wire − agent_requested
  reconciled                          boolean NOT NULL DEFAULT false,                 -- variance = 0, or explained and ≤ $1.00 rounding
  variance_explanation                text,
  reconciled_at                       timestamptz,
  reconciled_by_run_id                text,
  created_at                          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funding_worksheets_version_unique UNIQUE (funding_id, version),
  CONSTRAINT funding_worksheets_reconciled_explained CHECK (NOT reconciled OR variance_cents = 0 OR (abs(variance_cents) <= 100 AND variance_explanation IS NOT NULL))
);
COMMENT ON TABLE funding_worksheets IS '§26.3 rule 4: gross loan (CD) − lender-retained items + lender credits (+ interest credit) = net wire; the settlement agent''s balanced statement must request the same net figure (fixture $557,249.57). Append-only versions.';
CREATE TRIGGER funding_worksheets_immutable BEFORE UPDATE OR DELETE ON funding_worksheets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- funding_wires (outbound funding wires, returns, unwind refunds; dual-control and four-eyes evidence)
CREATE TABLE funding_wires (
  wire_id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  funding_id                          uuid NOT NULL REFERENCES fundings(funding_id),
  kind                                text NOT NULL CHECK (kind IN ('funding', 'return', 'unwind_refund', 'curtailment')),
  direction                           text NOT NULL CHECK (direction IN ('out', 'in')),
  amount_cents                        bigint NOT NULL,
  value_date                          date NOT NULL,
  originator_account_ref              text NOT NULL,                                  -- SM funding account, hashed
  beneficiary_party_id                uuid REFERENCES parties(id),                    -- the settlement agent's verified escrow/trust account only
  beneficiary_verification_id         uuid REFERENCES wire_verifications(id),
  beneficiary_name_on_wire            text NOT NULL,
  originator_to_beneficiary_info      text NOT NULL,                                  -- partner name as lender, partner loan number, borrower last name, property — no SSN
  instructions_hash                   text NOT NULL,
  prepared_at                         timestamptz NOT NULL,
  prepared_by_run_id                  text NOT NULL,
  editors                             text[] NOT NULL DEFAULT '{}',                   -- every human who edited the worksheet or the wire; released_by must differ from all
  four_eyes_check                     jsonb NOT NULL DEFAULT '{}'::jsonb,              -- {instructions_hash_match, verification_unexpired, change_freeze_ok, ofac_screen_ref, amount_matches_worksheet, beneficiary_matches_cpl}
  posting_target                      text NOT NULL DEFAULT 'warehouse_advance_receivable' CHECK (posting_target = 'warehouse_advance_receivable'),
  released_by                         text,                                           -- funding_approver
  released_at                         timestamptz,
  bank_ref                            text,
  imad                                text,
  omad                                text,
  status                              text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'pending_release', 'released', 'accepted', 'settled', 'rejected', 'returned', 'recalled')),
  reject_reason                       text,
  recall_requested_at                 timestamptz,
  recall_outcome                      text,
  created_at                          timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funding_wires_released_by_not_editor CHECK (released_by IS NULL OR NOT (released_by = ANY (editors))),
  CONSTRAINT funding_wires_released_has_by CHECK (status NOT IN ('released', 'accepted', 'settled') OR (released_by IS NOT NULL AND released_at IS NOT NULL)),
  CONSTRAINT funding_wires_accepted_has_imad CHECK (status NOT IN ('accepted', 'settled') OR imad IS NOT NULL)
);
COMMENT ON TABLE funding_wires IS '§26.3 rule 7: Fedwire-only funding wires prepared by the funder agent from the 24.4 verified record, released by a distinct funding_approver (dual control), booked to warehouse_advance_receivable (rule 9). Idempotency key = wire_id + value date; a re-release after rejection is a new wire_id.';
CREATE INDEX funding_wires_funding ON funding_wires (funding_id, prepared_at DESC);
ALTER TABLE fundings ADD CONSTRAINT fundings_wire_fk FOREIGN KEY (wire_id) REFERENCES funding_wires(wire_id);

-- ---------------------------------------------------------------- funding_unwinds (cancellation / rescission / fraud unwind files)
CREATE TABLE funding_unwinds (
  unwind_id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  funding_id                          uuid NOT NULL REFERENCES fundings(funding_id),
  trigger                             text NOT NULL CHECK (trigger IN ('rescission_exercised_pre_disbursement', 'rescission_exercised_post_disbursement', 'conditions_failed', 'documents_not_returned', 'agent_failed_to_disburse', 'fraud', 'borrower_withdrew', 'partner_hold')),
  opened_at                           timestamptz NOT NULL,
  funds_position                      text NOT NULL CHECK (funds_position IN ('not_released', 'released_not_disbursed', 'disbursed')),
  rescission_exercise_id              uuid REFERENCES rescission_exercises(exercise_id),   -- 25.3 drives a post-disbursement rescission unwind
  steps                               jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{step, owner, moves_money, due_at, refund_due_at, done_at, evidence, approved_by, process}]
  approved_by                         text,                                           -- officer, for any step that moves money after disbursement
  closed_at                           timestamptz,
  outcome                             text,
  created_at                          timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funding_unwinds_closed_has_outcome CHECK (closed_at IS NULL OR outcome IS NOT NULL),
  CONSTRAINT funding_unwinds_disbursed_closed_by_officer CHECK (closed_at IS NULL OR funds_position <> 'disbursed' OR approved_by IS NOT NULL)
);
COMMENT ON TABLE funding_unwinds IS '§26.3 rule 10: every unwind step owned, timed and evidenced (void / reverse / release within 5 creditor business days; money steps on 25.3''s 20-day clock); money movements after disbursement require officer approval.';
CREATE INDEX funding_unwinds_funding ON funding_unwinds (funding_id);

COMMIT;
