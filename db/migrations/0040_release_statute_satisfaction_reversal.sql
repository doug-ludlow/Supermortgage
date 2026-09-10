-- 0040: §16.3 lien release — the persisted facts the fix round added to the spec's own tables (0018). Append-only: columns are
-- added, nothing applied is edited; no new tables.
--   release_tasks: how and when the *statutory* duty closed (recording, or delivery where the statute is satisfied by delivery:
--   MA G.L. c.183 §55, Md. Real Prop. §7-106; CA Civ. Code §2941(b)(1)(A) delivery to the trustee), the Md. §7-106 anchor
--   (receipt of certified funds/wire, or clearance for other paper) with the funds kind it came from, the payoff-reversal side
--   state (T11: `void` before recording, `post_recording_reversal` after — the reversing 16.2 event, the date, the status it
--   interrupted, the loan serviced as unsecured pending cure, the borrower-notice hold), who opened the task (the payoff event's
--   automatic open vs the agent) and whether rule-1 selection is still pending, and the officer-notice / penalty-basis marks the
--   daily exposure run persists (rule 9).
--   recording_submissions: the paper package's print-mail job and mail-tracking barcode (rule 5 / T8), the positive-pay fee
--   check number, and the ledger entry set the fee posting booked (Outputs "Ledger").
BEGIN;

ALTER TABLE release_tasks
  ADD COLUMN IF NOT EXISTS statutory_duty_satisfied_on  date,
  ADD COLUMN IF NOT EXISTS statutory_duty_satisfied_by  text CHECK (statutory_duty_satisfied_by IN ('recording','delivery_to_settlement_agent','delivery_to_trustee')),
  ADD COLUMN IF NOT EXISTS statute_satisfied_by_delivery boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delivered_on                 date,                                   -- to the disbursing settlement agent (MD/MA)
  ADD COLUMN IF NOT EXISTS delivered_to_trustee_on      date,                                   -- CA third-party trustee (WE2)
  ADD COLUMN IF NOT EXISTS delivery_evidence_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS funds_received_on            date,
  ADD COLUMN IF NOT EXISTS funds_kind                   text,                                   -- wire | certified | check | ach | … (16.2 funds)
  ADD COLUMN IF NOT EXISTS funds_cleared_on             date,
  ADD COLUMN IF NOT EXISTS md_delivery_anchor           date,                                   -- Md. §7-106: receipt (certified/wire) or clearance (other paper)
  ADD COLUMN IF NOT EXISTS funds_anchor_basis           text CHECK (funds_anchor_basis IN ('receipt_certified_or_wire','clearance','receipt_pending_clearance')),
  ADD COLUMN IF NOT EXISTS opened_by                    text NOT NULL DEFAULT 'agent' CHECK (opened_by IN ('agent','payoff_event')),
  ADD COLUMN IF NOT EXISTS selection_pending            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS opened_at                    timestamptz,
  ADD COLUMN IF NOT EXISTS reversal_event_id            uuid,                                   -- the 16.2 `payoff.reversed` loan_events row applied to this task
  ADD COLUMN IF NOT EXISTS reversed_on                  date,
  ADD COLUMN IF NOT EXISTS status_before_reversal       text,
  ADD COLUMN IF NOT EXISTS reversal                     jsonb,                                  -- ops-16-3 payoffReversal (branch, instrument_signed, action, timers released)
  ADD COLUMN IF NOT EXISTS loan_serviced_as             text CHECK (loan_serviced_as IN ('secured','unsecured_pending_cure')),
  ADD COLUMN IF NOT EXISTS borrower_notice_hold         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS borrower_charge_cents        bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS penalty_exposure_as_of       date,
  ADD COLUMN IF NOT EXISTS penalty_exposure_basis       text,
  ADD COLUMN IF NOT EXISTS penalty_officer_notified_at  timestamptz,
  ADD COLUMN IF NOT EXISTS penalty_notice_given_on      date,                                   -- OH R.C. §5301.36 notice (then $100/day)
  ADD COLUMN IF NOT EXISTS penalty_written_request_on   date,                                   -- AZ/NC written request
  ADD COLUMN IF NOT EXISTS penalty_postings             jsonb NOT NULL DEFAULT '[]';

-- the state machine's side states (spec): `void` (payoff reversed before execution), `post_recording_reversal` (attorney), `penalty_exposure`
COMMENT ON COLUMN release_tasks.status IS 'opened | awaiting_custody_docs | held | prepared | awaiting_execution | sent_to_fnma | sent_to_partner | executed | notarized | submitted | recorded | rejected | borrower_notified | mers_deactivation_pending | closed | delivered | delivered_to_trustee | trustee_recorded | submitted_to_public_trustee | void | post_recording_reversal | penalty_exposure';

ALTER TABLE recording_submissions
  ADD COLUMN IF NOT EXISTS tracked_by                   text CHECK (tracked_by IN ('vendor_package_id','mail_tracking_barcode','local_agent_receipt')),
  ADD COLUMN IF NOT EXISTS tracking_id                  text,
  ADD COLUMN IF NOT EXISTS mail_job_id                  text,                                   -- print-mail job (paper package)
  ADD COLUMN IF NOT EXISTS mail_tracking_barcode        char(31),                               -- USPS IMb assigned at job creation
  ADD COLUMN IF NOT EXISTS fee_check_number             text,                                   -- positive-pay fee check (outstanding_checks.check_number)
  ADD COLUMN IF NOT EXISTS fee_charge_target            text CHECK (fee_charge_target IN ('borrower','corporate_expense')),
  ADD COLUMN IF NOT EXISTS fee_ledger_set_id            uuid,                                   -- the balanced entry set the fee posting booked
  ADD COLUMN IF NOT EXISTS attempt                      int NOT NULL DEFAULT 1;

COMMIT;
