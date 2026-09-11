-- 0066_intent_fee_gate_locks.sql — 21.4 Intent to proceed, fee collection and rate lock: the tables the process defines
-- (spec/sections/21-…/21-4-…md "Data model"). `applications` (0057) is the aggregate; `disclosures` / `fee_items` (21.2),
-- `pricing_quotes` / `rate_sheets` / `llpa_tables` (20.4) and `commitments` (29.1) are owned elsewhere and referenced by
-- id only (their migrations are being written in parallel or later; never redefined here). Append-only where the spec's
-- rows are evidence: fee_gate_checks (every attempt, refusals included), lock_extensions (one row per grant).
BEGIN;

-- Rule 2: one row per documented indication of intent (any channel; silence is never intent). `valid` is computed at
-- insert (received_at::date ≥ le_effective_receipt_date in the creditor time zone); an invalid record is kept as evidence.
CREATE TABLE intent_records (
  intent_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id             uuid NOT NULL REFERENCES applications(id),
  disclosure_id              uuid,                                     -- the LE version the intent refers to (21.2 `disclosures`)
  le_effective_receipt_date  date NOT NULL,
  received_at                timestamptz NOT NULL,
  channel                    text NOT NULL CHECK (channel IN ('app_button', 'chat', 'voice', 'email', 'esign_form', 'in_person', 'phone_human')),
  statement_text             text NOT NULL,                            -- verbatim utterance or e-mail excerpt (PII)
  evidence_document_id       uuid,                                     -- transcript / recording / e-mail / form (retention regz_le_3y + fnma_loan_file_life_plus_4y)
  recorded_by                text NOT NULL,                            -- agent run id or user id
  valid                      boolean NOT NULL,
  withdrawn_at               timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (statement_text <> '')
);
COMMENT ON TABLE intent_records IS '21.4 rule 2: intent to proceed (12 CFR 1026.19(e)(2)(i)(A); comment 19(e)(2)(i)(A)-2) — one row per statement, valid only when received on/after the LE''s effective receipt date; withdrawn_at closes the fee gate again; retention regz_le_3y + fnma_loan_file_life_plus_4y.';
CREATE INDEX intent_records_app_idx ON intent_records(application_id, received_at);

-- Rule 1: every guarded command (imposeFee, capturePaymentMethod, orderAppraisal, orderTitle, orderFloodDetermination,
-- orderPropertyDataCollection, the credit-report exemption) records its attempt and result. Append-only.
CREATE TABLE fee_gate_checks (
  check_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id),
  command          text NOT NULL CHECK (command IN ('impose_fee', 'capture_payment_method', 'order_appraisal', 'order_title', 'order_flood', 'order_pdc', 'order_credit_report')),
  fee_kind         text NOT NULL,
  fee_item_id      uuid,                                               -- 21.2 `fee_items`
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  collected_cents  bigint NOT NULL DEFAULT 0 CHECK (collected_cents >= 0 AND collected_cents <= amount_cents),
  checked_at       timestamptz NOT NULL,
  result           text NOT NULL CHECK (result IN ('open', 'closed_no_receipt', 'closed_no_intent', 'exempt_credit_report')),
  basis            jsonb NOT NULL DEFAULT '{}',                        -- {le_effective_receipt_date, intent_id, vendor_invoice_cents, checked_on}
  actor            text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (result IN ('open', 'exempt_credit_report') OR collected_cents = 0)
);
COMMENT ON TABLE fee_gate_checks IS '21.4 rule 1: REGZ_1026_19E2_INTENT_FEE_GATE checks — 12 CFR 1026.19(e)(2)(i)(A) (receipt + intent) and (B) (credit-report fee ≤ vendor invoice); refusals are the exam sample "fees before intent"; append-only.';
CREATE INDEX fee_gate_checks_app_idx ON fee_gate_checks(application_id, checked_at);
CREATE TRIGGER fee_gate_checks_immutable BEFORE UPDATE OR DELETE ON fee_gate_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Baseline §3 `locks` with the 21.4 columns: one lineage per application, one row per version (initial, extension
-- child rows below, relock, float_down, renegotiation). Money in cents; rates/prices as numerics with the spec's scale.
CREATE TABLE locks (
  lock_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  lineage_id                  uuid NOT NULL,
  version                     int NOT NULL CHECK (version >= 1),
  kind                        text NOT NULL CHECK (kind IN ('initial', 'extension', 'relock', 'float_down', 'renegotiation')),
  supersedes_lock_id          uuid REFERENCES locks(lock_id),
  status                      text NOT NULL CHECK (status IN ('requested', 'pending_mlo_approval', 'quote_expired', 'executed', 'confirmed', 'superseded', 'expired', 'cancelled', 'consummated')),
  requested_at                timestamptz NOT NULL,
  quote_id                    uuid,                                    -- 20.4 `pricing_quotes`
  quote_id_fnma               text,
  rate_sheet_id               text,
  llpa_version                text,
  mlo_approval_escalation_id  uuid,
  approved_at                 timestamptz,
  mlo_nmlsr_id                text,
  locked_at                   timestamptz,                             -- execution instant: "the date the interest rate is locked" ((e)(3)(iv)(D))
  rate_set_date               date,                                    -- locked_at::date in the creditor time zone (HMDA / APOR anchor)
  note_rate                   numeric(6,4) NOT NULL,
  price                       numeric(9,5) NOT NULL,
  points_cents                bigint NOT NULL DEFAULT 0 CHECK (points_cents >= 0),
  lender_credit_cents         bigint NOT NULL DEFAULT 0 CHECK (lender_credit_cents >= 0),
  lock_period_days            int NOT NULL CHECK (lock_period_days > 0),
  expires_on                  date,
  expires_at                  timestamptz,                             -- 17:00 creditor time zone by default
  expiry_roll_applied         boolean NOT NULL DEFAULT false,
  time_zone                   text NOT NULL DEFAULT 'America/Phoenix',
  product_code                text NOT NULL,
  loan_amount_cents           bigint NOT NULL CHECK (loan_amount_cents > 0),
  worst_case_pricing_applied  boolean NOT NULL DEFAULT false,
  extension_fee_cents         bigint NOT NULL DEFAULT 0,
  extension_payer             text CHECK (extension_payer IN ('borrower', 'lender_delay', 'lender_goodwill')),
  float_down_fee_cents        bigint NOT NULL DEFAULT 0,
  commitment_id               uuid,                                    -- 29.1 `commitments`
  revised_le_disclosure_id    uuid,                                    -- the revised LE / corrected CD carrying the terms
  state_agreement_variant     text CHECK (state_agreement_variant IN ('NY', 'NJ', 'MA')),
  property_state              text,
  ny_expiry_notice_required   boolean NOT NULL DEFAULT false,
  cancelled_reason            text CHECK (cancelled_reason IN ('borrower_withdrawal', 'lender_declination', 'product_change_ineligible', 'expired', 'superseded')),
  borrower_statement          text,
  recorded_by                 text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lineage_id, version),
  CHECK (status NOT IN ('executed', 'confirmed', 'expired', 'consummated') OR (locked_at IS NOT NULL AND rate_set_date IS NOT NULL AND expires_on IS NOT NULL AND expires_at IS NOT NULL AND mlo_nmlsr_id IS NOT NULL))
);
COMMENT ON TABLE locks IS '21.4 data model: rate lock lineage (baseline §3 + 21.4 columns) — requested → pending_mlo_approval → executed (lock.executed; REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD) → confirmed → extended/superseded/expired/cancelled/consummated; one lineage per application, one open Fannie Mae commitment per lineage (29.1).';
CREATE INDEX locks_app_idx ON locks(application_id, lineage_id, version);
CREATE INDEX locks_expiry_idx ON locks(expires_on) WHERE status IN ('executed', 'confirmed');

-- Rule 6: each extension grant (child of the lock version it extends). Append-only.
CREATE TABLE lock_extensions (
  extension_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lock_id            uuid NOT NULL REFERENCES locks(lock_id),
  days               int NOT NULL CHECK (days > 0),
  fee_cents          bigint NOT NULL CHECK (fee_cents >= 0),
  payer              text NOT NULL CHECK (payer IN ('borrower', 'lender_delay', 'lender_goodwill')),
  delay_attribution  text NOT NULL CHECK (delay_attribution IN ('borrower', 'lender', 'lender_agent')),
  granted_at         timestamptz NOT NULL,
  new_expires_on     date NOT NULL,
  new_expires_at     timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (payer = 'borrower' OR delay_attribution <> 'borrower')
);
COMMENT ON TABLE lock_extensions IS '21.4 rule 6: lock extensions — partner schedule (12.5 bps per 7 days); borrower-caused delay is the borrower''s cost ((e)(3)(iv)(C) changed circumstance), lender/agent delay is honored at the locked terms (MA rule, national policy); append-only.';
CREATE INDEX lock_extensions_lock_idx ON lock_extensions(lock_id, granted_at);
CREATE TRIGGER lock_extensions_immutable BEFORE UPDATE OR DELETE ON lock_extensions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Baseline §3 `changed_circumstances` with 21.5's columns (basis, information_received_at, narrative, evidence, the
-- 10 % bucket test, validity, reflected_on, baseline_reset) and 21.4's insert path (kind='rate_lock' on every
-- lock.executed / lock.relocked / lock.float_down.applied; kind='borrower_request' on a borrower-paid extension).
CREATE TABLE changed_circumstances (
  cc_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id             uuid NOT NULL REFERENCES applications(id),
  kind                       text NOT NULL CHECK (kind IN ('extraordinary_event', 'inaccurate_info', 'new_info', 'borrower_request', 'rate_lock', 'le_expired', 'construction_delay', 'eligibility_change')),   -- addendum §3 enum + 21.5's eligibility_change
  basis                      text CHECK (basis IN ('A1', 'A2', 'A3', 'B', 'C', 'D', 'E', 'F')),
  information_received_at    timestamptz NOT NULL,
  discovered_at              timestamptz NOT NULL,
  source_event_id            uuid,
  lock_id                    uuid REFERENCES locks(lock_id),
  narrative                  text NOT NULL,
  evidence_document_ids      uuid[] NOT NULL DEFAULT '{}',
  affected_fee_item_ids      uuid[] NOT NULL DEFAULT '{}',
  affected_amount_cents      bigint NOT NULL DEFAULT 0,
  ten_pct_threshold_test     jsonb,                                    -- {bucket_baseline_cents, bucket_revised_cents, increase_cents, threshold_cents, exceeds}
  valid                      boolean NOT NULL DEFAULT true,
  invalid_reason             text,
  revised_le_due_at          timestamptz,
  revised_le_disclosure_id   uuid,
  reflected_on               text CHECK (reflected_on IN ('le', 'cd', 'corrected_cd', 'none_decrease', 'none_invalid')),
  baseline_reset             boolean NOT NULL DEFAULT false,
  recorded_by                text NOT NULL,
  reviewer_id                text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'rate_lock' OR lock_id IS NOT NULL)
);
COMMENT ON TABLE changed_circumstances IS '21.4 / 21.5: changed circumstances (12 CFR 1026.19(e)(3)(iv)) — 21.4 inserts kind=rate_lock (basis D, discovered_at = locked_at, revised_le_due_at = +3 creditor business days) and kind=borrower_request (basis C) for borrower-paid extensions; 21.5 owns the semantics, validity and baseline resets.';
CREATE INDEX changed_circumstances_app_idx ON changed_circumstances(application_id, discovered_at);

COMMIT;
