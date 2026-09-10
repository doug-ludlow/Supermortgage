-- 0034_reo_15_1_portal_evidence.sql — §15.1 REOgram / TPS: the collections the claims-reo tools persist that 0017 did not
-- create (portal_tasks, comp_fee_exposures, crs_313_drafts, claim_flags, closing_statements) and the columns the tools write on
-- the 0017 tables (proceeds receipts, the persisted F-1-20 split and its ledger sets, the rescission re-add, handoff requests).
-- Append-only: 0017 is not edited.
BEGIN;

-- ── 0017 tables: columns the 15.1 tools write ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE reo_cases
  ADD COLUMN tenant_identified_on date,
  ADD COLUMN rescinded_at         timestamptz;

ALTER TABLE reogram_confirmations
  ALTER COLUMN reo_case_id DROP NOT NULL,                       -- the notification can arrive before the case is opened (rule 2: the clock runs from receipt)
  ADD COLUMN loan_id           uuid REFERENCES loans(id),
  ADD COLUMN notification_hash char(64),                        -- sha256 of the daily notification e-mail (Audit and evidence)
  ADD COLUMN package           jsonb,                            -- rule 3 package the operator confirms field-by-field
  ADD COLUMN gates_checked     jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN blocked           boolean,
  ADD COLUMN missing           jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN fact_sources      jsonb NOT NULL DEFAULT '[]',      -- rule 4: which records (properties, mi_policies) the gate was evaluated on
  ADD COLUMN package_built_at  timestamptz;

ALTER TABLE tps_cases
  ADD COLUMN completion_date       date,                         -- sale completion (final payment / court confirmation) — anchors FNMA_E3502_TPS_INSURANCE_CANCEL_14
  ADD COLUMN deposit_remitted_at   timestamptz,                  -- rule 9: failed-sale deposit remitted (311)
  ADD COLUMN custodial_account_id  text,
  ADD COLUMN ledger_set_ids        jsonb NOT NULL DEFAULT '[]',  -- the balanced F-1-20 entry sets (amount due, servicer recovery, surplus)
  ADD COLUMN split_computed_at     timestamptz;

ALTER TABLE reo_handoff_tasks
  ADD COLUMN loan_id               uuid REFERENCES loans(id),
  ADD COLUMN timer                 text,
  ADD COLUMN policy_id             text,
  ADD COLUMN cancel_as_of          date,
  ADD COLUMN refund_requested      boolean,
  ADD COLUMN requested_at          date,                         -- fnma.request.received (eviction documents / recovery-firm information)
  ADD COLUMN requested_by          text,
  ADD COLUMN nonreimbursable       boolean,                      -- rule 6: post-sale emergency order on SF CPM direction
  ADD COLUMN scope                 text,
  ADD COLUMN sf_cpm_direction_ref  text;

ALTER TABLE elimination_rescission_requests
  ALTER COLUMN reo_case_id DROP NOT NULL,
  ADD COLUMN loan_id                       uuid REFERENCES loans(id),
  ADD COLUMN template                      jsonb,                -- the Excel template rows (loan, property, reason, requested action, documents)
  ADD COLUMN fees_nonreimbursable_reason   text CHECK (fees_nonreimbursable_reason IN ('e4102_rescission')),
  ADD COLUMN lar_removal_accepted          boolean,
  ADD COLUMN action_code                   text,
  ADD COLUMN drafted_at                    timestamptz,
  ADD COLUMN attorney_escalation_id        uuid REFERENCES escalations(id),
  ADD COLUMN reintegrated_at               timestamptz,          -- loan.reactivated (FNMA_E4102_REINTEGRATE_24H)
  ADD COLUMN readd_portal_task_id          uuid REFERENCES escalations(id),
  ADD COLUMN readd_request_sent_at         timestamptz,          -- 5.x re-add e-mailed to readd_requests@fanniemae.com
  ADD COLUMN title_steps_instructed_at     timestamptz,          -- attorney.instruction.sent{kind=TITLE_RESTORATION} (FNMA_E4102_TITLE_RESTORE_2)
  ADD COLUMN title_instruction_document_id uuid REFERENCES documents(id),
  ADD COLUMN resumed                       jsonb,                -- ['sda_status','escrow','statements']
  ADD COLUMN cases_reopened                jsonb;                -- ['delinquency','foreclosure']

ALTER TABLE crs_batches
  ADD COLUMN tps_case_id     uuid REFERENCES tps_cases(id),
  ADD COLUMN loan_id         uuid REFERENCES loans(id),
  ADD COLUMN kind            text CHECK (kind IN ('tps_proceeds','tps_deposit')),
  ADD COLUMN lines           jsonb,                              -- [{code ∈ {311, 351}, cents}]
  ADD COLUMN cap_cents       bigint,                             -- the persisted figure the batch was capped at (never the caller's)
  ADD COLUMN cap_source      text,
  ADD COLUMN settle_by       date,
  ADD COLUMN drafted_at      timestamptz,
  ADD COLUMN settled_on      date,
  ADD COLUMN settled_at      timestamptz,
  ADD COLUMN bank_reference  text;

-- ── the operator's queue: every human_portal_task escalation the 15.1 tools open ──────────────────────────────────────
CREATE TABLE portal_tasks (
  id                    uuid PRIMARY KEY REFERENCES escalations(id),
  loan_id               uuid REFERENCES loans(id),
  task_type             text NOT NULL,                           -- p360.reogram.confirm | p360.reogram.exception | p360.tps.update_upload | elimination_rescission.submit | fnma.readd_request.email
  due_at                timestamptz,
  p360_case_id          text,
  fnma_loan_number      text,
  tps_case_id           uuid REFERENCES tps_cases(id),
  request_id            uuid REFERENCES elimination_rescission_requests(id),
  exception_code        text,
  package               jsonb,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  opened_at             timestamptz NOT NULL DEFAULT now(),
  owner_role            text NOT NULL,
  completed_at          timestamptz,
  completed_by          text,
  evidence_document_id  uuid REFERENCES documents(id),           -- the P360 case export / screenshot hashed into documents
  evidence_sha256       char(64)
);
CREATE INDEX portal_tasks_open_idx ON portal_tasks(owner_role, status, due_at);

-- ── rule 11: compensatory-fee exposure for a late REOgram confirmation, matched to the inbound code-313 draft ──────────
CREATE TABLE comp_fee_exposures (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                   uuid NOT NULL REFERENCES loans(id),
  reogram_confirmation_id   uuid REFERENCES reogram_confirmations(id),
  fnma_loan_number          text,
  kind                      text NOT NULL DEFAULT 'comp_fee_exposure',
  rule                      text NOT NULL DEFAULT 'A1-4.2-02',
  confirm_due_at            timestamptz,
  due_on                    date NOT NULL,
  confirmed_on              date NOT NULL,
  late_days                 int NOT NULL CHECK (late_days > 0),
  crs_code                  text NOT NULL DEFAULT '313',
  rebuttal_evidence         text,                                -- reasonable-explanation evidence (outage, notification not received)
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','reconciled','rebutted','closed')),
  matched_draft_id          uuid,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crs_313_drafts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid REFERENCES loans(id),
  fnma_loan_number      text NOT NULL,
  amount_cents          bigint NOT NULL,
  draft_date            date NOT NULL,
  matched_exposure_id   uuid REFERENCES comp_fee_exposures(id),
  disposition           text NOT NULL CHECK (disposition IN ('matched_reconcile','unmatched_dispute')),
  received_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE comp_fee_exposures ADD CONSTRAINT comp_fee_exposures_draft_fk FOREIGN KEY (matched_draft_id) REFERENCES crs_313_drafts(id);

-- ── rule 7 / T9: carrier refusal flagged for the final expense claim (E-4.4-02) ────────────────────────────────────────
CREATE TABLE claim_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reo_case_id   uuid REFERENCES reo_cases(id),
  loan_id       uuid NOT NULL REFERENCES loans(id),
  kind          text NOT NULL,                                   -- carrier_refused_refund
  rule          text NOT NULL,                                   -- E-4.4-02
  policy_kind   text CHECK (policy_kind IN ('hazard','flood','lpi')),
  comment       text NOT NULL,
  applies_to    text NOT NULL DEFAULT 'final_expense_claim',
  flagged_at    timestamptz NOT NULL DEFAULT now()
);

-- ── F-1-08: the closing statement to SF CPM on the 311 remittance date ─────────────────────────────────────────────────
CREATE TABLE closing_statements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tps_case_id   uuid REFERENCES tps_cases(id),
  loan_id       uuid NOT NULL REFERENCES loans(id),
  recipient     text NOT NULL DEFAULT 'sf_cpm',
  send_by       date NOT NULL,
  on_time       boolean NOT NULL,
  breakdown     jsonb NOT NULL,                                  -- principal, interest, servicing fees, advances, other, amount due, recovery, surplus
  document_id   uuid REFERENCES documents(id),
  sha256        char(64),
  status        text NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted','sent')),
  drafted_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

COMMIT;
