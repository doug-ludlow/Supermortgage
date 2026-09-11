-- 0106: 29.4 Loan Delivery submission, custodian certification, purchase, purchase advice reconciliation and post-delivery
-- corrections/remedies — the tables 29.4 owns (`delivery_operator_tasks`, `custodian_certifications`, `wire_instructions`,
-- `purchase_advices`, `post_purchase_adjustments`) and the 29.4 status columns added to the shared `deliveries` row
-- (0105, 29.3 owns the build columns). The addendum's status enumerations are widened to the 29.4 state machine
-- (`purchase_error`, `cancelled_to_draft`; certification `none` → `awaiting_certification` → certified / qualified_cert /
-- auto_certified) while keeping 0105's values valid, and `deliveries.purchase_advice_id` gains its FK. Loan Delivery is
-- observed, never commanded: every status column carries its `status_source`. Money in bigint cents (signed where the
-- Purchase Advice deducts prepaid interest); rates 5 dp; prices 6 dp; every Fannie Mae instant is ET. Operator tasks,
-- certifications, advices and PPAs are append-only (forbid_delete / forbid_mutation as the spec's audit trail requires).
BEGIN;

-- ───────────────────────────── deliveries: 29.4 status columns (addendum §3; 0105 created the row) ─────────────────────────────
ALTER TABLE deliveries
  DROP CONSTRAINT IF EXISTS deliveries_loan_delivery_status_check,
  DROP CONSTRAINT IF EXISTS deliveries_certification_status_check,
  ADD CONSTRAINT deliveries_loan_delivery_status_check CHECK (loan_delivery_status IN ('not_started', 'draft', 'submitted', 'purchase_requested', 'purchase_error', 'purchase_ready', 'purchased_and_funded', 'cancelled_to_draft', 'withdrawn')),
  ADD CONSTRAINT deliveries_certification_status_check CHECK (certification_status IN ('none', 'pending', 'awaiting_certification', 'certified', 'qualified', 'qualified_cert', 'exception', 'auto_certified')),
  ADD COLUMN IF NOT EXISTS submitted_at                   timestamptz,                                    -- ET; the operator's submit evidence
  ADD COLUMN IF NOT EXISTS submitted_by_operator_id       text,
  ADD COLUMN IF NOT EXISTS submit_before_2100_et          boolean,                                        -- C2-2-04 9:00 p.m. ET data cutoff
  ADD COLUMN IF NOT EXISTS edit_history_document_id       uuid REFERENCES documents(id),                  -- Edit History CSV export
  ADD COLUMN IF NOT EXISTS purchase_ready_at              date,                                           -- the LLPA date (User Guide p. 44)
  ADD COLUMN IF NOT EXISTS payee_code                     text,
  ADD COLUMN IF NOT EXISTS wire_instruction_id            uuid,                                           -- FK below
  ADD COLUMN IF NOT EXISTS bailee_letter_id               uuid REFERENCES bailee_letters(bailee_letter_id),   -- 27.1
  ADD COLUMN IF NOT EXISTS transfer_of_control_request_id text,
  ADD COLUMN IF NOT EXISTS custodian_certification_id     uuid,                                           -- FK below
  ADD COLUMN IF NOT EXISTS lpi_due_date                   date,                                           -- reported LPI; recomputed on payments before purchase (R1)
  ADD COLUMN IF NOT EXISTS first_payment_date             date,
  ADD COLUMN IF NOT EXISTS status_observed_at             timestamptz,
  ADD COLUMN IF NOT EXISTS status_source                  text CHECK (status_source IN ('operator_capture', 'custodian_notice', 'connect_report', 'purchase_advice_api', 'evault_event')),
  ADD COLUMN IF NOT EXISTS expected_certification_date    date,
  ADD COLUMN IF NOT EXISTS expected_purchase_date         date,
  ADD COLUMN IF NOT EXISTS delivery_attempt               int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS withdrawn_reason               text;

-- ───────────────────────────── wire_instructions (partner-level; reused per loan) ─────────────────────────────
CREATE TABLE wire_instructions (
  wire_instruction_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                    text NOT NULL,
  payee_code                    text NOT NULL,                                                   -- C2-2-07 / ULDD SID 642
  beneficiary_encrypted         bytea,                                                           -- bank, ABA, account — PII/financial-account class; never logged
  receiver_type                 text NOT NULL CHECK (receiver_type IN ('seller', 'warehouse_lender', 'disbursement_agent')),
  warehouse_lender_org_id       text,                                                            -- ULDD SID 650.1
  letter_type                   text NOT NULL DEFAULT 'none' CHECK (letter_type IN ('bailee', 'form_2004a', 'none')),
  bailee_letter_name            text,                                                            -- must equal bailee_letters.letter_name letterhead text byte-for-byte
  status                        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'inactive')),
  form_482_document_id          uuid REFERENCES documents(id),
  form_482_signed_by            text,                                                            -- partner officer
  fnma_confirmation_call_at     timestamptz,                                                     -- C2-2-07 call-back to the signer
  approved_by_warehouse_at      timestamptz,                                                     -- SM warehouse org: Pending → Active
  approved_by_operator_id       text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wire_instructions_bailee_name CHECK (letter_type <> 'bailee' OR status <> 'active' OR bailee_letter_name IS NOT NULL)
);
CREATE INDEX wire_instructions_partner_idx ON wire_instructions(partner_id, payee_code);
CREATE TRIGGER wire_instructions_never_deleted BEFORE DELETE ON wire_instructions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
COMMENT ON TABLE wire_instructions IS '29.4 data model: partner-level wire designations by payee code (Form 482 — C2-2-07; never a wire nickname); for loans under a bailee letter the SM warehouse-lender org approves the instruction after entering the exact letterhead text as the Bailee Letter Name (Warehouse Lender User Guide p. 5); beneficiary details encrypted, never e-mailed or logged.';
ALTER TABLE deliveries ADD CONSTRAINT deliveries_wire_instruction_fk FOREIGN KEY (wire_instruction_id) REFERENCES wire_instructions(wire_instruction_id);

-- ───────────────────────────── delivery_operator_tasks (the un-automatable UI steps with evidence) ─────────────────────────────
CREATE TABLE delivery_operator_tasks (
  task_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id                   uuid NOT NULL REFERENCES deliveries(delivery_id),
  package_id                    uuid REFERENCES delivery_packages(package_id),
  kind                          text NOT NULL CHECK (kind IN ('import_and_submit', 'resolve_edits', 'assign_wire', 'data_revision_response', 'cancel_certification', 'warehouse_wire_approval', 'form_482_request', 'form_2004a_execution', 'ldte_validation', 'lqc_data_validation', 'connect_purchase_advice_download', 'purchase_expected_check')),
  org                           text NOT NULL CHECK (org IN ('partner_seller_org', 'sm_warehouse_org')),
  escalation_id                 text NOT NULL,                                                   -- human_portal_task escalation (fnma_portal_operator)
  instruction_document_id       uuid REFERENCES documents(id),                                   -- AI-rendered one-page instruction sheet
  checklist                     jsonb NOT NULL DEFAULT '[]'::jsonb,                              -- [{step, expected}]
  sla_due_at                    timestamptz,                                                     -- SM_LOAN_DELIVERY_OPERATOR_SLA_1BD: 15:00 MT
  opened_at                     timestamptz NOT NULL DEFAULT now(),
  started_at                    timestamptz,
  completed_at                  timestamptz,
  operator_id                   text,
  captured_state                jsonb NOT NULL DEFAULT '{}'::jsonb,                              -- status values, Fannie Mae loan number, edit codes, wire status — keyed by evidence document
  evidence_document_ids         uuid[] NOT NULL DEFAULT '{}',                                    -- screenshots/exports; retention fnma_loan_file_life_plus_4y
  hash_confirmed                boolean NOT NULL DEFAULT false,                                  -- file name + SHA-256 on the sheet = file imported
  outcome                       text CHECK (outcome IN ('completed', 'blocked', 'cancelled')),
  block_reason                  text CHECK (block_reason IN ('unexpected_edit', 'commitment_missing', 'commitment_edit', 'wire_pending', 'ui_outage', 'hash_mismatch')),
  CONSTRAINT delivery_operator_tasks_complete_needs_evidence CHECK (outcome <> 'completed' OR kind <> 'import_and_submit' OR (hash_confirmed AND cardinality(evidence_document_ids) >= 4))
);
CREATE INDEX delivery_operator_tasks_delivery_idx ON delivery_operator_tasks(delivery_id, kind);
CREATE TRIGGER delivery_operator_tasks_never_deleted BEFORE DELETE ON delivery_operator_tasks FOR EACH ROW EXECUTE FUNCTION forbid_delete();
COMMENT ON TABLE delivery_operator_tasks IS '29.4 data model: every Loan Delivery UI action (import/submit, edit resolution, wire assignment, data-revision response, Cancel Certification) and SM warehouse-org wire approval as a fnma_portal_operator task with the instruction sheet, the expected screen values, the captured state and the mandatory evidence (import result, Edit History CSV, loan-record print, Wire Details); the task cannot complete without the four items and hash_confirmed; two operators are never assigned the same loan across the seller and warehouse orgs.';

-- ───────────────────────────── custodian_certifications (Document Certification; eVault auto-certification) ─────────────────────────────
CREATE TABLE custodian_certifications (
  certification_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id                   uuid NOT NULL REFERENCES deliveries(delivery_id),
  custodian_party_id            uuid REFERENCES parties(id),
  custodian_fin                 text,                                                            -- Financial Institution Number (Seller Profile)
  custody_mode                  text NOT NULL CHECK (custody_mode IN ('shipped_package', 'pre_positioned_at_fcc', 'evault_auto')),
  package_document_ids          uuid[] NOT NULL DEFAULT '{}',                                    -- cover letter, bailee letter, Form 2004A copy, POA, name affidavit, riders (E-2-01)
  carrier                       text,
  tracking_number               text,
  package_shipped_at            timestamptz,                                                     -- FNMA_C2_2_02_SHIP_SAME_DAY_AS_SUBMIT
  first_morning_service         boolean,
  received_at_custodian         timestamptz,                                                     -- ET (carrier tracking)
  received_by_0730_et           boolean,                                                         -- User Guide p. 64 expectation
  custodian_cutoff_local_at     timestamptz,                                                     -- cash SLA 4:00 p.m. EST (Job Aids v4.0)
  certified_at                  timestamptz,
  certification_kind            text CHECK (certification_kind IN ('certified', 'qualified_cert', 'auto_certified_enote', 'manual_evault_review')),
  data_revisions                jsonb NOT NULL DEFAULT '[]'::jsonb,                              -- [{field, custodian_value, seller_value, editable_by_custodian, seller_response, responded_at}]
  document_exceptions           jsonb NOT NULL DEFAULT '[]'::jsonb,
  bailee_validation             text NOT NULL DEFAULT 'n/a' CHECK (bailee_validation IN ('n/a', 'passed', 'failed')),
  bailee_letter_name_used       text,
  notice_document_ids           uuid[] NOT NULL DEFAULT '{}',
  fnma_loan_number_recorded_at  timestamptz,                                                     -- FNMA_C1_2_02_FNMA_LOAN_NUMBER_TO_CUSTODIAN_30 evidence
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custodian_certifications_certified_kind CHECK (certified_at IS NULL OR certification_kind IS NOT NULL),
  CONSTRAINT custodian_certifications_bailee_failed_not_certified CHECK (bailee_validation <> 'failed' OR certified_at IS NULL)
);
CREATE INDEX custodian_certifications_delivery_idx ON custodian_certifications(delivery_id);
CREATE TRIGGER custodian_certifications_never_deleted BEFORE DELETE ON custodian_certifications FOR EACH ROW EXECUTE FUNCTION forbid_delete();
COMMENT ON TABLE custodian_certifications IS '29.4 data model: the custodian leg per delivery attempt — shipment and first-morning receipt, the custodian''s certification (certified / qualified_cert after an accepted data revision / auto_certified_enote where Fannie Mae is the custodian), data revisions and the seller''s response (R4), document exceptions, and the bailee letterhead validation that cannot be certified on a mismatch (Job Aids v4.0).';
ALTER TABLE deliveries ADD CONSTRAINT deliveries_custodian_certification_fk FOREIGN KEY (custodian_certification_id) REFERENCES custodian_certifications(certification_id);

-- ───────────────────────────── purchase_advices (addendum: price, upb_cents, interest_adjustment_cents, net_proceeds_cents, fees) ─────────────────────────────
CREATE TABLE purchase_advices (
  purchase_advice_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id                   uuid NOT NULL REFERENCES deliveries(delivery_id),
  loan_id                       uuid NOT NULL REFERENCES loans(id),
  fnma_loan_number              char(10) NOT NULL,                                               -- C2-2-05: entered into the records immediately
  advice_date                   date NOT NULL,
  purchase_date                 date NOT NULL,                                                   -- Purchased and Funded date = acquisition date
  commitment_id_fnma            text,
  payee_code                    text,
  remittance_type               text NOT NULL CHECK (remittance_type IN ('actual_actual', 'scheduled_scheduled', 'scheduled_actual')),
  pass_through_rate             numeric(7,5) NOT NULL,
  servicing_fee_rate            numeric(7,5),
  price                         numeric(9,6) NOT NULL,                                           -- percent of UPB, six decimals
  upb_cents                     bigint NOT NULL,
  principal_proceeds_cents      bigint NOT NULL,                                                 -- round(upb × price ÷ 100)
  interest_adjustment_cents     bigint NOT NULL,                                                 -- signed; negative when prepaid interest is deducted (C2-1.1-06)
  llpa_total_cents              bigint NOT NULL DEFAULT 0,                                       -- signed
  llpa_lines                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  fees                          jsonb NOT NULL DEFAULT '[]'::jsonb,                              -- commitment / pair-off / extension / other
  net_proceeds_cents            bigint NOT NULL,
  wire_reference                text,
  source                        text NOT NULL CHECK (source IN ('api', 'connect_report')),
  raw_payload_document_id       uuid REFERENCES documents(id),
  received_at                   timestamptz NOT NULL,
  expected_net_proceeds_cents   bigint,                                                          -- platform pre-computation (27.2 formula; 30/360 case)
  expected_net_high_cents       bigint,                                                          -- act/365 case until the day count is confirmed (open question 3)
  variance_cents                bigint,
  reconciled_at                 timestamptz,
  adjustment_request_due_at     date NOT NULL,                                                   -- advice_date + 30 calendar days (C2-2-05; 27.2's FNMA_C2_2_05_PPA_REQUEST_30)
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_advices_one_per_advice UNIQUE (fnma_loan_number, advice_date)              -- API idempotency key
);
CREATE INDEX purchase_advices_loan_idx ON purchase_advices(loan_id, purchase_date);
CREATE TRIGGER purchase_advices_immutable BEFORE DELETE ON purchase_advices FOR EACH ROW EXECUTE FUNCTION forbid_delete();
COMMENT ON TABLE purchase_advices IS '29.4 data model (addendum §3): the Whole Loan Purchase Advice per loan (Sellers API daily JSON or the Fannie Mae Connect report) with price, UPB, signed interest adjustment, LLPA lines, fees and net proceeds; the platform''s expected range and the tie-out variance (R3: |variance| ≤ $1.00 auto-reconciles; otherwise decomposition and the officer''s adjustment request within 30 days of the advice date).';
ALTER TABLE deliveries ADD CONSTRAINT deliveries_purchase_advice_fk FOREIGN KEY (purchase_advice_id) REFERENCES purchase_advices(purchase_advice_id);

-- ───────────────────────────── post_purchase_adjustments (seller-initiated PPAs; LQC-initiated data validation) ─────────────────────────────
CREATE TABLE post_purchase_adjustments (
  ppa_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                       uuid NOT NULL REFERENCES loans(id),
  fnma_loan_number              char(10) NOT NULL,
  initiated_by                  text NOT NULL CHECK (initiated_by IN ('seller', 'fnma_lqc')),
  discovered_at                 timestamptz NOT NULL,
  attributes                    jsonb NOT NULL,                                                  -- [{attribute, delivered_value, corrected_value, evidence_document_id}]
  lsdu_submitted_at             timestamptz,                                                     -- PPA web portal via LSDU, Loan Data Change tab (operator act)
  ppa_form_document_id          uuid REFERENCES documents(id),                                   -- the .csv per the job aid; documents named <FM Loan No.>_<Document Name>.pdf ≤ 3 MB
  expected_llpa_delta_cents     bigint NOT NULL DEFAULT 0,                                       -- signed; $100 minimum for a draft/refund (PPA FAQ Q9)
  notification_report_document_id uuid REFERENCES documents(id),                                 -- Post-Purchase Adjustment Notification (Fannie Mae Connect)
  llpa_draft_or_refund_cents    bigint,
  settled_at                    timestamptz,
  status                        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'processed', 'closed', 'declined')),
  repricing_eligible            boolean NOT NULL,                                                -- discovered ≤ acquisition_date + 18 months (C1-2-02)
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_purchase_adjustments_settled_when_closed CHECK (status <> 'closed' OR settled_at IS NOT NULL)
);
CREATE INDEX post_purchase_adjustments_loan_idx ON post_purchase_adjustments(loan_id, status);
CREATE TRIGGER post_purchase_adjustments_never_deleted BEFORE DELETE ON post_purchase_adjustments FOR EACH ROW EXECUTE FUNCTION forbid_delete();
COMMENT ON TABLE post_purchase_adjustments IS '29.4 data model (R8): post-purchase data corrections — seller-initiated through LSDU (PPA Request Form .csv; 10 business days processing; LLPA draft/refund ≥ $100 typically within five business days) or Fannie Mae-initiated through Loan Quality Connect (28.2 case); repricing_eligible only inside the 18-month lookback from the acquisition date, data corrections always required (C1-2-02).';

COMMIT;
