-- 0091_title_settlement.sql — §24.4 Title, vesting, settlement-agent vetting, existing-lien payoffs, subordinations and
-- curative (spec/sections/24-…/24-4-title-vesting-settlement-agent-vetting-existing-lien-payoffs.md "Data model";
-- addendum §3). Owned here: the addendum §3 baseline tables `title_orders`, `payoff_demands` and `subordinations` with
-- 24.4's column set (no earlier migration created them — 0081 references payoff_demands/subordinations by id only), and
-- 24.4's own `title_curative_items`, `settlement_agents`, `wire_verifications`, `trust_reviews`, `poa_reviews`.
-- Not here (other owners, never duplicated): applications / application_borrowers / application_liabilities /
-- application_properties (0057), parties / documents / loans / consents (0001), fee_items (21.x), conditions (23.1),
-- escalations / agent_decisions / timers (kernel), trailing_documents (26.4). Servicing seams referenced by id: the
-- same-servicer payoff is 16.1's `payoff_requests` row on `servicing_loan_id` (REGZ_1026_36C3_PAYOFF_STMT_7BD), the
-- `escrow_credit_to_new_loan` consent is 3.5's (30.3 posts `escrow.credit_to_new_loan.posted`). Reviews, curative
-- items and wire verifications are append-only (0001's forbid_mutation trigger): a re-review / re-verification is a
-- NEW row; status-bearing rows (title_orders, payoff_demands, subordinations, settlement_agents) carry updated_at and
-- their transitions are the events (`title.order.status_changed`, `payoff.statement.*`, `subordination.*`,
-- `settlement_agent.*`). Retention: loan-file class (`fnma_loan_file_life_plus_4y` → life_of_loan_plus_4y); vesting
-- names and the interactive-session recording reference are PII.
BEGIN;

-- ---------------------------------------------------------------- title_orders (baseline; 24.4 columns) — one row per order (commitment, datedown, final_policy, cpl, hoa_status, tax_cert, payoff_wire_check)
CREATE TABLE title_orders (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  order_type                  text NOT NULL CHECK (order_type IN ('commitment', 'datedown', 'final_policy', 'cpl', 'hoa_status', 'tax_cert', 'payoff_wire_check')),
  settlement_agent_party_id   uuid NOT NULL REFERENCES parties(id),
  underwriter_party_id        uuid REFERENCES parties(id),                     -- title insurer
  underwriter_license_state_ok boolean,                                        -- B7-2-02: licensed in the property state per the state DOI lookup (T4: insurer_not_licensed)
  underwriter_strength_basis  text CHECK (underwriter_strength_basis IN ('rating', 'financial_strength', 'reserves', 'claims_record', 'reinsurance_form_858', 'iowa_title_guaranty')),
  agent_alta_registry_ref     text,
  commitment_number           text,
  commitment_document_id      uuid REFERENCES documents(id),
  commitment_effective_date   date,
  commitment_received_at      timestamptz,
  datedown_effective_date     date,                                            -- SM_TITLE_COMMITMENT_DATEDOWN_GATE (≥ consummation − 30 calendar days, 24.4-Q2)
  datedown_received_at        timestamptz,
  proposed_insured_text       text NOT NULL,                                   -- "[Partner], its successors and/or assigns" — never MERS (B7-2-03)
  policy_form                 text,                                            -- the 2021 ALTA Loan Policy (07-01-2021) for every in-scope loan; short form / state-promulgated equivalent
  policy_amount_cents         bigint,                                          -- ≥ original principal (B7-2-03; fixture $560,000.00 → ≥ 56,000,000)
  note_amount_cents           bigint NOT NULL,
  vesting                     jsonb,                                           -- {names, tenancy, trust, estate ∈ {fee_simple, leasehold}} (PII)
  apn                         text NOT NULL,                                   -- 30.4 tax-service activation reads it from `title.commitment.received`
  legal_description_hash      text,
  schedule_b1_requirements    jsonb NOT NULL DEFAULT '[]'::jsonb,
  schedule_b2_exceptions      jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{kind, text, classification ∈ {minor_b7_2_05, curative, unacceptable, to_be_paid, resubordinate}, rule}]
  required_endorsements       text[] NOT NULL DEFAULT '{}',                    -- computed (rule 1): ALTA 8.1 always; 4/4.1 condo; 5/5.1 PUD; 6 ARM; 7/7.1/7.2 MH; 13.1 leasehold; TX 50(a)(6) T-2 + T-42 + T-42.1
  committed_endorsements      text[] NOT NULL DEFAULT '{}',
  issued_endorsements         text[] NOT NULL DEFAULT '{}',
  creditors_rights_exclusion  boolean NOT NULL DEFAULT false,                  -- B7-2-03: the 1990 creditors' rights exclusion language is prohibited
  t42_deletions               text[] NOT NULL DEFAULT '{}',                    -- TX 50(a)(6): no deletion of T-42 ¶2(a)–(e)
  aol                         boolean NOT NULL DEFAULT false,                  -- attorney opinion letter path (B7-2-06; feature flag title.aol_enabled)
  aol_attorney_party_id       uuid REFERENCES parties(id),
  sfc_codes                   text[] NOT NULL DEFAULT '{}',                    -- 155 (AOL) / 168 (trust) / 304 (TX 50(a)(6)) contributions for 29.3
  cpl_document_id             uuid REFERENCES documents(id),
  cpl_addressee_ok            boolean,                                         -- SM_CPL_BEFORE_FUNDING_GATE
  cpl_issued_at               timestamptz,
  wire_verification_id        uuid,                                            -- FK added below (wire_verifications)
  fee_gate_check_id           uuid,                                            -- 21.4 fee_gate_checks row for command order_title
  vendor_ref                  text,
  final_policy_received_at    timestamptz,
  status                      text NOT NULL CHECK (status IN ('ordered', 'commitment_received', 'reviewed', 'curative_open', 'cleared', 'dated_down', 'closed', 'policy_received', 'cancelled')),
  rejection_reason            text,                                            -- insurer_not_licensed / strength_basis_unknown
  retention                   retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  ordered_at                  timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE title_orders IS '24.4 title_orders (addendum §3 baseline): the title order and its commitment — insurer licensing/strength basis (B7-2-02), Schedule A vesting/legal description/APN, Schedule B-I requirements and B-II exceptions with their B7-2-05 classification, the computed vs committed/issued endorsements (B7-2-03/-04), policy form and amount, CPL evidence, AOL path and SFC contributions; status follows the 24.4 state machine ordered → commitment_received → reviewed ⇄ curative_open → cleared → dated_down → closed → policy_received | cancelled.';
CREATE INDEX title_orders_app_idx ON title_orders (application_id, ordered_at DESC);

-- ---------------------------------------------------------------- title_curative_items (new) — one row per item; clearing is a new row (append-only), the open item is the latest per (title_order_id, item_key) with cleared_at null
CREATE TABLE title_curative_items (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_order_id              uuid NOT NULL REFERENCES title_orders(id),
  item_key                    uuid NOT NULL DEFAULT gen_random_uuid(),         -- stable across the open row and its clearing row
  kind                        text NOT NULL CHECK (kind IN ('judgment', 'lien', 'tax_delinquent', 'hoa_delinquent', 'pace', 'ucc', 'name_variance', 'deceased_vestee', 'divorce_decree', 'probate', 'unreleased_prior_mortgage', 'survey_exception', 'easement_unacceptable', 'encroachment', 'legal_description_mismatch', 'redemption_period', 'other')),
  source                      text NOT NULL CHECK (source IN ('schedule_b1', 'schedule_b2', 'tax_cert', 'hoa_letter', 'fraud_screen')),
  description                 text NOT NULL,
  amount_cents                bigint,
  resolution                  text CHECK (resolution IN ('paid_at_closing', 'released', 'affirmative_coverage', 'endorsement', 'indemnity_accepted_by_officer', 'deleted_by_underwriter', 'not_required')),
  owner                       text NOT NULL CHECK (owner IN ('settlement_agent', 'borrower', 'title_underwriter', 'sm')),
  opened_at                   timestamptz NOT NULL,
  cleared_at                  timestamptz,
  evidence_document_id        uuid REFERENCES documents(id),
  officer_decision_id         uuid,                                            -- agent_decisions row for indemnity_accepted_by_officer (B7-2-05 indemnity)
  blocks_consummation         boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE title_curative_items IS '24.4 title_curative_items: every Schedule B / tax certificate / HOA letter / fraud-screen item that is not minor under B7-2-05 — kind, owner (agent, borrower, underwriter, SM), amount, resolution (paid at closing, released, affirmative coverage, endorsement, officer indemnity, underwriter deletion, not required) and evidence; an open blocking item holds title_orders.status at curative_open and refuses consummate. Append-only: clearing writes a new row with the same item_key.';
CREATE INDEX title_curative_items_order_idx ON title_curative_items (title_order_id, cleared_at);
CREATE TRIGGER title_curative_items_immutable BEFORE UPDATE OR DELETE ON title_curative_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- settlement_agents (new; party-level vetting record, re-vetted annually)
CREATE TABLE settlement_agents (
  party_id                    uuid PRIMARY KEY REFERENCES parties(id),
  agent_type                  text NOT NULL CHECK (agent_type IN ('title_agency', 'underwriter_direct', 'attorney', 'escrow_company')),
  state                       text NOT NULL,
  license_number              text,
  license_verified_at         timestamptz,
  alta_registry_id            text,
  underwriter_confirmed_by    uuid REFERENCES parties(id),
  eo_policy_limit_cents       bigint NOT NULL DEFAULT 0,                       -- ≥ $1,000,000 per claim (policy default, 24.4-Q3)
  eo_expires_on               date,
  fidelity_limit_cents        bigint NOT NULL DEFAULT 0,                       -- ≥ $500,000 or an underwriter CPL covering the loss (24.4-Q3)
  best_practices_attestation_at timestamptz,
  wire_instructions_hash      text,                                            -- letterhead instructions, re-verified annually
  vetting_status              text NOT NULL CHECK (vetting_status IN ('approved', 'approved_with_conditions', 'suspended', 'rejected')),
  vetting_reasons             jsonb NOT NULL DEFAULT '[]'::jsonb,
  vetting_conditions          jsonb NOT NULL DEFAULT '[]'::jsonb,
  vetting_expires_on          date NOT NULL,                                   -- annual (SM_SETTLEMENT_AGENT_VETTING_GATE)
  officer_exception_id        uuid,                                            -- agent_decisions row: partner officer approved an agent outside policy
  vetted_at                   timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE settlement_agents IS '24.4 settlement_agents: the party-level vetting record for title agencies, underwriter direct offices, closing attorneys and escrow companies — license in the property state (bar status in attorney states), E&O and fidelity/crime cover, ALTA Registry presence or underwriter confirmation, Best Practices attestation, letterhead wire instructions, RESPA §8 (no referral consideration); approved / approved_with_conditions / suspended / rejected with an annual expiry; an officer exception records an agent approved outside policy.';

-- ---------------------------------------------------------------- wire_verifications (new; append-only — every verification, change detection and release is a new row)
CREATE TABLE wire_verifications (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  purpose                     text NOT NULL CHECK (purpose IN ('closing_funds', 'payoff_existing_lien', 'subordinate_payoff')),
  beneficiary_party_id        uuid NOT NULL REFERENCES parties(id),
  vendor                      text NOT NULL CHECK (vendor IN ('fundingshield', 'certifid', 'manual_callback')),
  vendor_ref                  text,
  account_last4               text NOT NULL,
  routing_number_hash         text NOT NULL,
  instructions_hash           text NOT NULL,                                   -- idempotency (application_id, purpose, instructions_hash)
  instructions_channel        text NOT NULL CHECK (instructions_channel IN ('letterhead', 'portal', 'email', 'vendor_registry')),
  match_result                text NOT NULL CHECK (match_result IN ('verified', 'mismatch', 'not_found', 'changed')),
  callback_at                 timestamptz,
  callback_number_source      text CHECK (callback_number_source IN ('alta_registry', 'underwriter', 'prior_verified_record')),   -- never the e-mail carrying the instructions
  verified_at                 timestamptz,
  expires_at                  timestamptz,                                     -- verified_at + 30 days
  change_detected_at          timestamptz,
  hours_to_funding            numeric(8,2),                                    -- a change ≤ 48 hours before funding blocks the wire (24.4-Q5)
  blocks_disbursement         boolean NOT NULL DEFAULT false,
  block_reason                text,
  release_requires            text CHECK (release_requires IN ('funding_approver_after_second_callback')),
  released_by                 text,                                            -- funding_approver actor after the second callback (T8)
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE wire_verifications IS '24.4 wire_verifications: closing-funds and payoff-wire beneficiary verification — vendor match (FundingShield/CertifID; manual_callback with dual control on outage), the SM-initiated callback to an ALTA Registry / underwriter / prior-record number, a 30-day validity, change detection with the 48-hour funding freeze and the funding_approver release after a second callback. Append-only: every verification, change and release is a new row; the current record is the latest per (application_id, purpose, beneficiary).';
CREATE INDEX wire_verifications_app_idx ON wire_verifications (application_id, purpose, created_at DESC);
CREATE TRIGGER wire_verifications_immutable BEFORE UPDATE OR DELETE ON wire_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE title_orders ADD CONSTRAINT title_orders_wire_verification_fk FOREIGN KEY (wire_verification_id) REFERENCES wire_verifications(id);

-- ---------------------------------------------------------------- payoff_demands (baseline; 24.4 columns) — one row per existing lien being paid; refresh history is the event stream + statement_document_id versions
CREATE TABLE payoff_demands (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  liability_id                uuid NOT NULL REFERENCES application_liabilities(id),
  existing_servicer_party_id  uuid REFERENCES parties(id),
  same_servicer               boolean NOT NULL DEFAULT false,                  -- SM subservices the existing loan → 16.1 issues the statement (REGZ_1026_36C3_PAYOFF_STMT_7BD is SM's own clock)
  servicing_loan_id           uuid REFERENCES loans(id),                       -- when same-servicer (16.1 payoff_requests keyed on it)
  requested_at                timestamptz,
  request_channel             text,                                            -- external: the servicer's designated written channel (comment 36(c)(3)-2); same-servicer: servicing_16_1
  written_authorization_document_id uuid REFERENCES documents(id),
  follow_up_due               date,                                            -- SM_PAYOFF_DEMAND_FOLLOWUP_7BD (+7 business_days_creditor; external servicer only)
  statement_received_at       timestamptz,
  statement_document_id       uuid REFERENCES documents(id),
  statement_date              date,
  good_through_date           date,                                            -- SM_PAYOFF_GOOD_THROUGH_GATE: ≥ disbursement_date
  principal_cents             bigint,
  interest_cents              bigint,
  per_diem_cents              bigint,                                          -- reconciled to the note rate ±$0.02; never "corrected"
  fees_cents                  bigint,
  escrow_shortage_cents       bigint,
  credits_cents               bigint,
  total_cents                 bigint,
  computed_total_at_disbursement_cents bigint,                                 -- planning figure only: total + per_diem × extra days (comment 36(c)(3)-3)
  disbursement_date           date,
  wire_instructions_document_id uuid REFERENCES documents(id),
  wire_verification_id        uuid REFERENCES wire_verifications(id),
  short_payoff                boolean NOT NULL DEFAULT false,                  -- rule 8: rejected; DU resubmission; unreleasable until a written release commitment
  status                      text NOT NULL CHECK (status IN ('requested', 'received', 'stale', 'refreshed', 'funded', 'rejected')),
  escrow_treatment            text CHECK (escrow_treatment IN ('refund_by_servicer', 'credit_to_new_loan', 'net_against_shortage')),   -- same-servicer only (§1024.34(b))
  consent_id                  text,                                            -- 3.5's `escrow_credit_to_new_loan` consent (consent:escrow_credit_to_new_loan:<old loan>:<application>)
  refund_due_on               date,                                            -- 3.5's REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD (20 business_days_federal from the payoff posting)
  refresh_count               integer NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE payoff_demands IS '24.4 payoff_demands (addendum §3 baseline): the payoff of each existing lien — the written demand to the external servicer (or the request through servicing 16.1 when SM subservices the loan), the parsed statement (principal, interest paid through, per diem, good-through, fees, total; fixture $531,240.00 + 12 × $105.52 + $30.00 = $532,536.24 good through Nov 12, 2026), staleness/refresh against the disbursement date, wire verification, short-payoff rejection, and the same-servicer escrow treatment (§1024.34(b): refund within 20 federal business days, or credit to the new loan with consent).';
CREATE UNIQUE INDEX payoff_demands_app_liability_idx ON payoff_demands (application_id, liability_id);

-- ---------------------------------------------------------------- subordinations (baseline; 24.4 columns) — one row per subordinate lien staying in place
CREATE TABLE subordinations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  liability_id                uuid NOT NULL REFERENCES application_liabilities(id),
  lienholder_party_id         uuid REFERENCES parties(id),
  lien_kind                   text NOT NULL CHECK (lien_kind IN ('heloc', 'closed_end_second', 'community_second', 'dpa', 'employer', 'other')),
  statutory_position_preserved boolean NOT NULL DEFAULT false,                 -- jurisdiction_rules.subordination.statutory_position_preserved → waived_statutory
  requested_at                date,                                            -- SM_SUBORDINATION_REQUEST_3BD: within +3 business_days_creditor of the DU findings
  agreement_received_at       timestamptz,
  agreement_document_id       uuid REFERENCES documents(id),
  executed_at                 date,                                            -- FNMA_B2_1_2_04_RESUBORDINATION_GATE: executed before consummation
  recordable                  boolean,
  recorded_at                 date,                                            -- 26.4 confirms recording with (or immediately after) the new security instrument
  heloc_line_cents            bigint,
  heloc_drawn_cents           bigint,
  cltv_bps                    integer,                                         -- floor((first + drawn) × 10000 ÷ value) — fixture 7225
  hcltv_bps                   integer,                                         -- floor((first + line) × 10000 ÷ value) — fixture 7625
  terms_ok                    boolean,                                         -- B2-1.2-04: interest-covering payments, market rate, maturity/balloon ≥ 5 years after the note date, no shared appreciation unless Community Seconds
  terms_reasons               jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                      text NOT NULL CHECK (status IN ('requested', 'received', 'executed', 'recorded', 'waived_statutory', 'rejected')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE subordinations IS '24.4 subordinations (addendum §3 baseline): every subordinate lien left in place on a refinance (22.4 `subordinate_financing.declared` feeds it) — the resubordination request package, the executed/recordable agreement, HELOC line/drawn and the CLTV/HCLTV basis points DU is run with, the B2-1.2-04 terms check, and the statutory-position waiver; status requested → received → executed → recorded | waived_statutory | rejected (the lien must be paid off or the loan restructured).';
CREATE UNIQUE INDEX subordinations_app_liability_idx ON subordinations (application_id, liability_id);

-- ---------------------------------------------------------------- trust_reviews (new; append-only — a re-review after an amendment is a new row)
CREATE TABLE trust_reviews (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  borrower_id                 uuid NOT NULL REFERENCES application_borrowers(id),
  trust_name                  text NOT NULL,
  certification_document_id   uuid REFERENCES documents(id),
  trust_agreement_document_id uuid REFERENCES documents(id),
  attorney_opinion_document_id uuid REFERENCES documents(id),                  -- where no state trust-certification statute exists [policy]
  settlor_is_trustee          boolean NOT NULL,
  institutional_trustee       boolean NOT NULL,
  primary_beneficiary_is_settlor boolean NOT NULL,
  power_to_mortgage           boolean NOT NULL,
  revocable                   boolean NOT NULL,
  occupancy_ok                boolean NOT NULL,
  qualifying_party_ok         boolean NOT NULL,
  rider_required              boolean NOT NULL DEFAULT false,                  -- B8-5-02: the revocable trust rider is optional
  result                      text NOT NULL CHECK (result IN ('eligible', 'ineligible', 'needs_documents')),
  reasons                     jsonb NOT NULL DEFAULT '[]'::jsonb,
  signature_plan              jsonb NOT NULL DEFAULT '[]'::jsonb,              -- E-2-04: trustee capacity signature + settlor acknowledgment (26.1 renders)
  sfc_168                     boolean NOT NULL DEFAULT false,
  reviewed_at                 timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE trust_reviews IS '24.4 trust_reviews: the B2-2-05 inter vivos revocable trust review per trust borrower — eligible iff revocable ∧ primary beneficiary is the settlor ∧ (settlor is a trustee ∨ institutional trustee) ∧ power to mortgage ∧ occupancy ∧ qualifying party — with the certification / agreement / attorney-opinion evidence, the E-2-04 signature plan and SFC 168 for 29.3; feeds SM_TRUST_POA_REVIEW_GATE. Append-only: a re-review is a new row.';
CREATE INDEX trust_reviews_app_idx ON trust_reviews (application_id, borrower_id, reviewed_at DESC);
CREATE TRIGGER trust_reviews_immutable BEFORE UPDATE OR DELETE ON trust_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- poa_reviews (new; append-only)
CREATE TABLE poa_reviews (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  borrower_id                 uuid NOT NULL REFERENCES application_borrowers(id),
  poa_document_id             uuid REFERENCES documents(id),
  agent_party_id              uuid REFERENCES parties(id),
  transaction_type            text NOT NULL CHECK (transaction_type IN ('purchase', 'limited_cash_out', 'cash_out')),   -- B8-5-05: cash-out ineligible absent the applicable-law override
  agent_relationship          text NOT NULL CHECK (agent_relationship IN ('relative', 'other')),
  agent_ineligible_class      text NOT NULL CHECK (agent_ineligible_class IN ('none', 'lender_affiliate', 'loan_originator', 'title_employee', 'seller', 'real_estate_agent_interest')),
  interactive_session_recording_id text,                                       -- the recorded interactive session (documents.pii=true)
  cpl_required                boolean NOT NULL DEFAULT false,                  -- title insurer / policy-issuing agent employee as attorney-in-fact
  notarized                   boolean NOT NULL,
  dated_valid                 boolean NOT NULL,
  references_property         boolean NOT NULL,
  names_match                 boolean NOT NULL,
  recording_required          boolean NOT NULL DEFAULT false,                  -- jurisdiction_rules.poa.recording_required
  original_to_custodian       boolean NOT NULL DEFAULT false,                  -- jurisdiction_rules.poa.original_to_custodian
  applicable_law_override     boolean NOT NULL DEFAULT false,
  override_statement_document_id uuid REFERENCES documents(id),                -- the written file statement the override requires
  result                      text NOT NULL CHECK (result IN ('eligible', 'ineligible', 'needs_documents')),
  reasons                     jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewed_at                 timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE poa_reviews IS '24.4 poa_reviews: the B8-5-05 power-of-attorney review per borrower — purchase / limited cash-out only (cash-out ineligible unless the applicable-law override with a written file statement), the agent''s relationship and ineligible class with the recorded interactive-session exception (+ CPL for title-company employees), the document tests (notarized, dated valid, references the property, names match), recording / original-to-custodian per jurisdiction; an AOL is barred on a POA loan; feeds SM_TRUST_POA_REVIEW_GATE. Append-only: a re-review is a new row.';
CREATE INDEX poa_reviews_app_idx ON poa_reviews (application_id, borrower_id, reviewed_at DESC);
CREATE TRIGGER poa_reviews_immutable BEFORE UPDATE OR DELETE ON poa_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
