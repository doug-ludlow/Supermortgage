-- 0096_post_closing_collateral.sql — §26.4 Post-closing document collection, collateral perfection and trailing documents
-- (spec/sections/26-…/26-4-post-closing-document-collection-collateral-perfection-and-t.md "Data model").
-- Owned here: trailing_documents (baseline table per spec/origination/01-architecture-baseline-addendum.md §3 — "columns defined
-- here"; no earlier migration created it), mers_registrations, note_endorsements, note_custody_shipments, lost_note_affidavits,
-- recorded_instrument_reviews, final_policy_reviews, plus the "26.4 adds" columns on the shared 0019 tables (custody_records
-- holder_role / trust receipt / custodian exception / certification / Form 2009 columns; enotes custody_reconciled_at /
-- location_change_history / authoritative_copy_hash_verified_at), the servicing-file columns on loans (mers_registered_at,
-- recorded_instrument_number, title_policy_number — `min` exists since 0001) and the MERS System transaction kinds 26.4 logs in
-- mers_transactions (pre_closing_registration, registration_reversal, min_update_interim_funder, inquiry).
-- Not here (other owners, never duplicated): closings / closing_documents (0073; `mers_assignment_3749` and `allonge` kinds),
-- recordings (0094), title_orders (0091), custody_records / enotes / mers_transactions base rows (0019), documents / loans /
-- agent_decisions (0001), escalations (0019), timers; bailee_letters / warehouse_advances / warehouse_collateral_defects (0097 —
-- applies after this file, so bailee_letter_id / advance_id carry no FK), deliveries (0105). Money is bigint cents; instants
-- timestamptz; local dates date. mers_registrations, recorded_instrument_reviews and final_policy_reviews are append-only
-- (0001's forbid_mutation on DELETE; every state change is also an appended loan_events row — `mers.min.*`, `trailing_document.*`).
BEGIN;

-- ---------------------------------------------------------------- trailing_documents (baseline; the follow-up ladder and the 120/180-day escalations run on it)
CREATE TABLE trailing_documents (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  loan_id                     uuid REFERENCES loans(id),                          -- set at the 30.2 hand-off
  kind                        text NOT NULL CHECK (kind IN ('recorded_security_instrument', 'final_title_policy', 'recorded_assignment', 'mi_certificate', 'flood_cert',
                                'recorded_poa', 'recorded_subordination', 'recorded_cema_3172', 'recorded_tx_affidavit_3185', 'recorded_assignment_to_mers', 'recorded_release_prior_lien',
                                'final_aol', 'custodian_trust_receipt', 'custodian_certification', 'recorded_correction')),
  expected_from               text NOT NULL CHECK (expected_from IN ('erecording_vendor', 'county', 'settlement_agent', 'title_underwriter', 'mi_company', 'flood_vendor', 'custodian', 'prior_servicer')),
  source_party_id             uuid REFERENCES parties(id),
  anchor_event                text,                                               -- recording.confirmed | recording.submitted | loan.funded | collateral.void.opened
  anchor_at                   date,
  due_at                      date,                                               -- eRecorded image +5 business_days_creditor; paper +90 (county override); policy +60; MI cert +5 BD
  received_at                 timestamptz,
  document_id                 uuid REFERENCES documents(id),
  review_status               text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'passed', 'defect')),
  defects                     jsonb NOT NULL DEFAULT '[]',
  followups                   jsonb NOT NULL DEFAULT '[]',                        -- [{at, channel ∈ {portal, email, phone, vendor_api}, to_party_id, response, next_at}]
  escalation_id               uuid REFERENCES escalations(id),
  blocks                      text[] NOT NULL DEFAULT '{}',                       -- ⊆ {none, qc_file, servicing_file, foreclosure_referral}
  status                      text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'open', 'received', 'reviewed', 'defect_open', 'closed', 'waived')),
  waived_by                   text,                                               -- officer party id, or 'system' for loan_cancelled
  waived_reason               text,
  closed_at                   timestamptz,
  funded_on                   date,                                               -- SM_O74_TRAILING_DOC_ESCALATE_120 anchor
  retention_class             retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, kind)
);
COMMENT ON TABLE trailing_documents IS '26.4 (baseline table; columns defined here): every document expected after closing — recorded security instrument, final policy/AOL, MI certificate, flood LOL, recorded POA/subordination/CEMA/TX affidavit/Maine assignment, custodian trust receipt and certification — with its anchor, due date, review result, follow-up ladder (every 30 days), 120-day officer escalation / 28.2 QC flag and 180-day certified-copy substitution; closed only on a passed review, waived only by officer (or loan_cancelled); collateral.file.complete when every row is closed/waived.';
CREATE INDEX trailing_documents_open_idx ON trailing_documents (status, due_at) WHERE status IN ('open', 'defect_open');

-- ---------------------------------------------------------------- mers_registrations (append-only; one row per MIN)
CREATE TABLE mers_registrations (
  min                         char(18) NOT NULL,                                  -- 7-digit partner Org ID + 10-digit sequence + check digit
  application_id              uuid NOT NULL REFERENCES applications(id),
  loan_id                     uuid REFERENCES loans(id),
  registration_kind           text NOT NULL CHECK (registration_kind IN ('mom', 'non_mom_assignment')),
  state                       char(2),
  security_instrument_document_id uuid REFERENCES documents(id),
  mers_rider                  boolean NOT NULL DEFAULT false,                     -- MT/OR/WA Form 3158
  assignment_to_mers_document_id uuid REFERENCES documents(id),                   -- Maine Form 3749
  assignment_executed_on      date,
  pre_closing_registered_at   timestamptz,
  registered_at               timestamptz,
  anchor_kind                 text NOT NULL CHECK (anchor_kind IN ('note_date', 'funding_date', 'assignment_executed_date')),
  anchor_date                 date NOT NULL,
  registration_due_at         date NOT NULL,                                      -- anchor_date + 7 calendar days (MERS Procedures Rel. 26.1)
  policy_target_at            date NOT NULL,                                      -- note_date + 7 (SM policy)
  target_batch_on             date,                                               -- SM_O74_MOM_REGISTER_TARGET_1BD
  servicer_org_id             char(7) NOT NULL,                                   -- partner
  subservicer_org_id          char(7) NOT NULL,                                   -- SM
  investor_org_id             char(7) NOT NULL,                                   -- partner at registration; Fannie Mae after purchase (30.1 verifies)
  interim_funder_org_id       char(7),                                            -- SM while a warehouse advance exists (27.1 verifies; 27.2 removes)
  interim_funder_set_at       timestamptz,
  interim_funder_removed_at   timestamptz,
  custodian_org_id            char(7),
  batch_ref                   text,
  channel                     text NOT NULL DEFAULT 'xml' CHECK (channel IN ('xml', 'flat_file', 'web')),
  mers_response               jsonb,
  status                      text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'pre_closing', 'active', 'reversed', 'deactivated')),
  reversal_reason             text,
  deactivation_reason         text,                                               -- MERS reason code [UNVERIFIED list]
  last_reconciled_at          timestamptz,
  reconciliation_variances    jsonb NOT NULL DEFAULT '[]',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (min, application_id)
);
COMMENT ON TABLE mers_registrations IS '26.4: the MERS System registration of a MIN — anchor (note date for purchases outside escrow states; funding date for refinances / escrow states; Form 3749 execution date for non-MOM), registration_due_at (+7 calendar days), policy target, Servicer/Investor = partner, Subservicer = SM, Interim Funder = SM while an advance is open, batch reference and MERS response, reversal / deactivation, monthly reconciliation state.';
CREATE INDEX mers_registrations_due_idx ON mers_registrations (status, registration_due_at);
CREATE TRIGGER mers_registrations_no_delete BEFORE DELETE ON mers_registrations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- note_endorsements (B8-3-04; exactly one blank endorsement by the partner)
CREATE TABLE note_endorsements (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  closing_document_id         uuid NOT NULL REFERENCES closing_documents(document_id),   -- the note (26.1)
  application_id              uuid NOT NULL REFERENCES applications(id),
  method                      text NOT NULL CHECK (method IN ('printed_facsimile', 'allonge_pre_executed', 'wet_post_closing')),
  endorsement_text            text NOT NULL,                                      -- "PAY TO THE ORDER OF ______ WITHOUT RECOURSE [PARTNER] By: ___ Name: ___ Title: ___"
  signing_officer_party_id    uuid REFERENCES parties(id),
  signed_at                   timestamptz,
  signature_kind              text CHECK (signature_kind IN ('wet', 'facsimile')),
  facsimile_authority_document_ids uuid[] NOT NULL DEFAULT '{}',                  -- the four B8-3-04 documents; jurisdiction opinion matched to the property state
  allonge_document_id         uuid REFERENCES documents(id),
  allonge_identifiers         jsonb,                                              -- {borrower_names, note_date, note_amount_cents, property_address}
  note_references_allonge     boolean NOT NULL DEFAULT false,                     -- "SEE ATTACHED ALLONGE FOR ENDORSEMENT"
  affixed_by_party_id         uuid REFERENCES parties(id),
  affixed_at                  timestamptz,
  custodian_review_result     text NOT NULL DEFAULT 'pending' CHECK (custodian_review_result IN ('pending', 'accepted', 'exception')),
  exception_codes             text[] NOT NULL DEFAULT '{}',
  chain                       jsonb NOT NULL DEFAULT '[]',                        -- [{endorser: partner, endorsee: "blank", at}] — never SM, never Fannie Mae by name
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE note_endorsements IS '26.4 rule 2 (B8-3-04, E-2-01, RDC §8): the partner''s endorsement of the note in blank without recourse — printed facsimile (four-document authority file), pre-executed allonge (identifiers must match the note; affixed; note references it) or wet post-closing at the endorsement desk; the SM_O74_ENDORSEMENT_BEFORE_SHIP_GATE facts.';

-- ---------------------------------------------------------------- note_custody_shipments (tracked overnight courier; scans keyed by tracking_ref)
CREATE TABLE note_custody_shipments (
  shipment_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custody_record_id           uuid REFERENCES custody_records(loan_id),           -- shared custody_records (0019/0094/0097)
  application_id              uuid NOT NULL REFERENCES applications(id),
  from_party_id               uuid REFERENCES parties(id),
  to_party_id                 uuid REFERENCES parties(id),
  to_role                     text NOT NULL CHECK (to_role IN ('fcc_bailee', 'endorsement_desk', 'sm_designated_custodian', 'fnma_custodian', 'settlement_agent_return', 'borrower_return')),
  bailee_letter_id            uuid,                                               -- 27.1 bailee_letters (0097 applies later — no FK); required for fcc_bailee / sm_designated_custodian
  carrier                     text,
  tracking_ref                text,
  contents                    jsonb NOT NULL DEFAULT '[]',                        -- [{document_kind, closing_document_id, original}]
  shipped_at                  timestamptz,
  pickup_scan_at              timestamptz,                                        -- SM_O74_NOTE_PICKUP_SCAN_1BD satisfied / SM_O74_NOTE_TRANSIT_3BD anchor
  delivered_at                timestamptz,                                        -- SM_O74_TRUST_RECEIPT_1BD anchor
  trust_receipt_at            timestamptz,
  exception                   jsonb,                                              -- carrier exception, custodian exception, trace / claim
  status                      text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'shipped', 'in_transit', 'delivered', 'receipted', 'exception', 'lost', 'returned')),
  time_zone                   text NOT NULL DEFAULT 'America/New_York',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE note_custody_shipments IS '26.4 rule 4: each movement of the original paper note (settlement agent → FCC as SM''s bailee by default; endorsement desk; returns) under a bailee letter, with the carrier pickup / delivery scans and the custodian trust receipt the SM_O74_NOTE_* timers key on; lost → lost_note_affidavits.';
CREATE INDEX note_custody_shipments_tracking_idx ON note_custody_shipments (tracking_ref);

-- ---------------------------------------------------------------- lost_note_affidavits (rule 5: re-execution first; LNA per RDC; certifiability per loan)
CREATE TABLE lost_note_affidavits (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custody_record_id           uuid REFERENCES custody_records(loan_id),
  application_id              uuid NOT NULL REFERENCES applications(id),
  shipment_id                 uuid REFERENCES note_custody_shipments(shipment_id),
  search_started_at           timestamptz NOT NULL,
  search_evidence_document_ids uuid[] NOT NULL DEFAULT '{}',                       -- carrier trace, settlement-agent attestation, custodian search
  courier_claim_ref           text,
  decision                    text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 're_execute', 'lna', 'both')),
  decided_by                  uuid REFERENCES parties(id),                        -- officer
  decided_at                  timestamptz,
  replacement_note_document_id uuid REFERENCES documents(id),
  replacement_note_signed_at  timestamptz,
  lna_document_id             uuid REFERENCES documents(id),
  executed_by_party_id        uuid REFERENCES parties(id),                        -- partner signing_officer
  notarized_at                timestamptz,
  indemnity_text_ok           boolean,
  note_description_ok         boolean,                                            -- loan amount, borrower name, note date
  note_copy_attached          boolean,
  custodian_accepted_at       timestamptz,
  fnma_position               text NOT NULL DEFAULT 'unknown' CHECK (fnma_position IN ('unknown', 'accepted', 'rejected')),
  warehouse_effect            text NOT NULL DEFAULT 'unsecured_wet' CHECK (warehouse_effect IN ('unsecured_wet', 'cured', 'repurchase')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE lost_note_affidavits IS '26.4 rule 5: a note lost in transit after the documented search (E-1.1-02 standard) — the officer''s decision within SM_O74_LNA_DECISION_5BD (re-execution by the borrower preferred; LNA alone only if the borrower cannot or will not), the LNA executed by the partner''s signing_officer, notarized, with indemnity, note description and note copy (RDC v15), Fannie Mae certifiability confirmed per loan (no E-2-01 row, no SFC), and the 27.1 warehouse effect.';

-- ---------------------------------------------------------------- recorded_instrument_reviews (append-only; rule 6 checklist)
CREATE TABLE recorded_instrument_reviews (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id                text NOT NULL REFERENCES recordings(recording_id),  -- 26.2
  trailing_document_id        uuid NOT NULL REFERENCES trailing_documents(id),
  executed_document_id        uuid REFERENCES documents(id),
  recorded_image_document_id  uuid REFERENCES documents(id),
  checks                      jsonb NOT NULL DEFAULT '{}',                        -- {legal_description_hash_match, names_vesting_match, min_present, mers_nominee_language_present, nmlsr_block_present, notary_certificate_complete, ron_statement_present_if_ron, riders_attached_count_match, page_count_match, recording_stamp_present, instrument_number_captured, county_correct, signatures_initials_present, date_match}
  result                      text NOT NULL CHECK (result IN ('pass', 'defect')),
  defect_kind                 text CHECK (defect_kind IN ('legal_description', 'missing_rider', 'notary_defect', 'wrong_county', 'missing_pages', 'name_error', 'min_missing', 'image_illegible', 'other')),
  cure                        text NOT NULL DEFAULT 'none' CHECK (cure IN ('rerecord', 'corrective_instrument', 'scriveners_affidavit', 'county_correction', 'certified_copy_request', 'none')),
  cure_submitted_at           timestamptz,                                        -- SM_O74_RERECORD_CURE_10BD satisfied
  cured_at                    timestamptz,
  title_underwriter_notified_at timestamptz,
  reviewed_at                 timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE recorded_instrument_reviews IS '26.4 rule 6: the recorded image reviewed against the executed set — page count, legal description hash, names/vesting, MIN and nominee paragraph, NMLSR block, notary certificate (RON statement), stamp / instrument number / county, riders (MERS Rider in MT/OR/WA) — pass closes the trailing item; a defect opens the cure by the county''s rerecording_method with the title underwriter notified.';
CREATE TRIGGER recorded_instrument_reviews_no_delete BEFORE DELETE ON recorded_instrument_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- final_policy_reviews (append-only; rule 7 / B7-2-03)
CREATE TABLE final_policy_reviews (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_order_id              uuid NOT NULL REFERENCES title_orders(id),          -- 24.4
  trailing_document_id        uuid NOT NULL REFERENCES trailing_documents(id),
  policy_kind                 text NOT NULL CHECK (policy_kind IN ('alta_2021_loan', 'alta_2006_loan', 'state_form', 'short_form', 'aol')),
  policy_number               text,
  date_of_policy              timestamptz,
  insured_text                text,
  insured_ok                  boolean NOT NULL,                                   -- partner "its successors and/or assigns as their interests may appear"; never MERS
  amount_cents                bigint NOT NULL,
  amount_ok                   boolean NOT NULL,                                   -- ≥ original principal
  schedule_a_ok               boolean NOT NULL,                                   -- vesting, legal description, insured mortgage recording data = recordings
  schedule_b_diff             jsonb NOT NULL DEFAULT '{}',                        -- {expected_removed, present, new_exceptions}
  endorsements_issued         text[] NOT NULL DEFAULT '{}',
  endorsements_ok             boolean NOT NULL,                                   -- required_endorsements ⊆ issued; ALTA 8.1; T-42/T-42.1 for TX 50(a)(6)
  creditors_rights_exclusion_absent boolean NOT NULL,
  gap_ok                      boolean NOT NULL,                                   -- Date of Policy ≥ recorded_at, or 2021 form effective at closing without a gap exception
  policy_form_ok              boolean NOT NULL,                                   -- 2021 ALTA Loan Policy for loans originated on/after 2024-01-01
  result                      text NOT NULL CHECK (result IN ('pass', 'defect')),
  defects                     jsonb NOT NULL DEFAULT '[]',
  correction_requested_at     timestamptz,
  corrected_policy_document_id uuid REFERENCES documents(id),
  closed_at                   timestamptz,
  reviewed_at                 timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE final_policy_reviews IS '26.4 rule 7 (B7-2-01/-03/-04): the final policy or AOL reviewed against 24.4''s commitment and required_endorsements — form, insured (partner ISAOA/ATIMA, never MERS), amount ≥ original principal, Schedule A = recorded instrument, Schedule B without new exceptions, endorsements incl. ALTA 8.1, no 1990 creditors''-rights exclusion, gap; defects → correction request on the 30-day cadence; not a purchase gate (QC 28.2 and foreclosure-referral document).';
CREATE TRIGGER final_policy_reviews_no_delete BEFORE DELETE ON final_policy_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- custody_records (0019, shared with 1.4 / 26.2 / 27.1): 26.4 adds
ALTER TABLE custody_records
  ADD COLUMN IF NOT EXISTS holder_role                     text CHECK (holder_role IN ('settlement_agent', 'courier', 'endorsement_desk', 'fcc_bailee', 'sm_designated_custodian', 'fnma_custodian', 'fnma_evault', 'released')),
  ADD COLUMN IF NOT EXISTS bailee_acknowledgment_document_id uuid REFERENCES documents(id),   -- UCC 9-313(c)
  ADD COLUMN IF NOT EXISTS trust_receipt_document_id       uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS custodian_loan_id               text,
  ADD COLUMN IF NOT EXISTS custodian_exception_codes       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS custodian_exception_cured_at    timestamptz,
  ADD COLUMN IF NOT EXISTS certified_at                    timestamptz,                  -- 29.4 sets
  ADD COLUMN IF NOT EXISTS release_request_form_2009_id    uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS lost_note                       boolean NOT NULL DEFAULT false;   -- 13.3 / E-1.1-02 hand-off
COMMENT ON COLUMN custody_records.holder_role IS '26.4 state machine: settlement_agent → courier → fcc_bailee (holding_for_party_id = SM) → fnma_custodian at custody.certified + loan.purchased; eNote: fnma_evault after the Transfer of Control; released on a Form 2009 release / cancelled loan.';

-- ---------------------------------------------------------------- enotes (0019 / 0094 / 0097): 26.4 adds
ALTER TABLE enotes
  ADD COLUMN IF NOT EXISTS custody_reconciled_at            timestamptz,                 -- SM_O74_EVAULT_EREGISTRY_RECONCILE_MONTHLY
  ADD COLUMN IF NOT EXISTS location_change_history          jsonb NOT NULL DEFAULT '[]', -- Transfer of Location transactions (vendor migration)
  ADD COLUMN IF NOT EXISTS authoritative_copy_hash_verified_at timestamptz;              -- daily eVault ↔ eRegistry hash check

-- ---------------------------------------------------------------- loans (0001): the servicing-file facts 30.4 / 29.3 read (loans.min exists since 0001)
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS mers_registered_at               timestamptz,
  ADD COLUMN IF NOT EXISTS recorded_instrument_number       text,
  ADD COLUMN IF NOT EXISTS title_policy_number              text,
  ADD COLUMN IF NOT EXISTS collateral_file_complete_at      timestamptz;                 -- collateral.file.complete (30.4 seeds the servicing file from it)

-- ---------------------------------------------------------------- mers_transactions (0019 / 0094): the MERS System kinds 26.4 logs
ALTER TABLE mers_transactions DROP CONSTRAINT IF EXISTS mers_transactions_txn_type_check;
ALTER TABLE mers_transactions ADD CONSTRAINT mers_transactions_txn_type_check CHECK (txn_type IN ('min_update_subservicer','tos_initiate','tos_confirm','tob_confirm','registration','deactivation','min_update_other','deactivation_paid_in_full','deactivation_reversal',
  'eregistry_registration','eregistry_registration_reversal','eregistry_change_data_secured_party','eregistry_change_data_secured_party_release','eregistry_edelivery','eregistry_transfer_control_location','eregistry_transfer_servicing_agent','eregistry_change_status','eregistry_inquiry',
  'pre_closing_registration','registration_reversal','min_update_interim_funder','inquiry'));
ALTER TABLE mers_transactions ADD COLUMN IF NOT EXISTS application_id uuid REFERENCES applications(id);
ALTER TABLE mers_transactions ADD COLUMN IF NOT EXISTS error_codes text[] NOT NULL DEFAULT '{}';   -- MERS reject codes (Integration Handbook)

COMMIT;
