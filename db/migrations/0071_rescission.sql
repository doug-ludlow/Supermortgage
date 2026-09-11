-- 0071_rescission.sql — §25.3 Right of rescission (spec/sections/25-…/25-3-right-of-rescission-….md "Data model").
-- Owned here: rescission_periods, rescission_exercises, rescission_waivers, and the servicing flag column
-- loans.rescission_extended_until ("added flag column for servicing when status = extended_3y"; 30.2 boards it, 9.x/16.x read it).
-- Not here (other owners, never duplicated): `disclosures{kind=rescission_h8 | rescission_h9}` (0064 — one row per consumer per
-- copy set: delivered_at, delivery_channel, receipt_evidence), `fundings.rescission_expires_at` (26.3's funding tables carry the
-- copy of rescission_periods.expires_at), `timers`, `documents`, `agent_decisions`, `escalations` (baseline).
-- Money is bigint cents; instants timestamptz; local dates date. Exercises and waivers are append-only evidence (0001's forbid_mutation).
BEGIN;

-- ---------------------------------------------------------------- rescission_periods (one per rescindable transaction; recomputed rows are new versions)
CREATE TABLE rescission_periods (
  rescission_id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  loan_id                         uuid REFERENCES loans(id),                            -- set by 30.2 at hand-off
  version                         int NOT NULL DEFAULT 1,                               -- re-computation on any later delivery (edge cases: late notice, corrected CD)
  applicability                   text NOT NULL CHECK (applicability IN ('rescindable_full', 'rescindable_new_advance', 'exempt_purchase_money', 'exempt_same_creditor_no_new_money', 'not_principal_dwelling', 'exempt_other')),
  form                            text NOT NULL CHECK (form IN ('h8', 'h9', 'none')),
  original_creditor_match         boolean NOT NULL DEFAULT false,                       -- comment 23(f)-4: partner or a predecessor merged into it
  rescindable_amount_cents        bigint,                                               -- H-9: amount financed − (UPB + earned unpaid finance charge + refinancing costs)
  consumers                       jsonb NOT NULL DEFAULT '[]'::jsonb,                   -- [{consumer_id, role ∈ borrower|non_borrower_owner, ownership_basis}]
  consummation_at                 timestamptz,
  consummation_date_local         date,
  notice_delivered                jsonb NOT NULL DEFAULT '[]'::jsonb,                   -- per consumer: {delivered_at, channel, copies ∈ 1|2, evidence_document_id}
  material_disclosures_delivered  jsonb NOT NULL DEFAULT '[]'::jsonb,                   -- per consumer: {cd_version, effective_receipt_date} (25.2 cd_receipts)
  material_disclosures_accurate   boolean,                                              -- §1026.23(g) result copied from 25.1
  period_start_date               date,                                                 -- latest of the three events per consumer, then the latest across consumers
  expires_on                      date,                                                 -- day 3 (business_days_regz_specific; Saturdays count)
  expires_at                      timestamptz,                                          -- midnight local ending day 3 (fixture: 2026-11-11T07:00:00Z)
  status                          text NOT NULL DEFAULT 'pending_consummation' CHECK (status IN ('not_applicable', 'pending_consummation', 'running', 'expired_not_rescinded', 'waived', 'rescinded', 'extended_3y')),
  reasonably_satisfied_at         timestamptz,
  satisfaction_basis              text CHECK (satisfaction_basis IN ('channel_sweep', 'borrower_confirmation', 'both')),
  waiver_id                       uuid,                                                 -- FK added below (rescission_waivers)
  funding_release_at              timestamptz,
  mail_allowance_ends_on          date,                                                 -- expires_on + 2 calendar days (SM_O63_MAILED_NOTICE_ALLOWANCE_2)
  extended_expires_at             date,                                                 -- consummation + 3 years when defective (§1026.23(a)(3)(i))
  time_zone                       text NOT NULL DEFAULT 'America/Phoenix',
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rescission_periods_form_matches CHECK ((applicability IN ('rescindable_full') AND form = 'h8') OR (applicability = 'rescindable_new_advance' AND form = 'h9') OR (applicability NOT IN ('rescindable_full', 'rescindable_new_advance') AND form = 'none')),
  CONSTRAINT rescission_periods_running_has_expiry CHECK (status NOT IN ('running', 'expired_not_rescinded') OR (period_start_date IS NOT NULL AND expires_at IS NOT NULL)),
  CONSTRAINT rescission_periods_extended_has_date CHECK (status <> 'extended_3y' OR extended_expires_at IS NOT NULL),
  CONSTRAINT rescission_periods_waived_has_waiver CHECK (status <> 'waived' OR waiver_id IS NOT NULL)
);
COMMENT ON TABLE rescission_periods IS '25.3: applicability (§1026.23(f)), the consumers entitled to rescind, per-consumer notice and material-disclosure delivery evidence, the period (latest of consummation / notice / material disclosures → midnight of the 3rd specific business day), satisfaction of non-rescission, waiver, funding release and the 3-year extended right; fundings.rescission_expires_at and loans.rescission_extended_until are copies for the funder and servicing.';
CREATE INDEX rescission_periods_application_idx ON rescission_periods(application_id, version);
CREATE INDEX rescission_periods_running_idx ON rescission_periods(expires_at) WHERE status = 'running';
CREATE INDEX rescission_periods_extended_idx ON rescission_periods(extended_expires_at) WHERE status = 'extended_3y';

-- ---------------------------------------------------------------- rescission_exercises (append-only; every inbound exercise, valid or disputed)
CREATE TABLE rescission_exercises (
  exercise_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rescission_id                   uuid NOT NULL REFERENCES rescission_periods(rescission_id),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  consumer_id                     text NOT NULL,
  received_at                     timestamptz NOT NULL,
  received_on                     date NOT NULL,                                        -- local civil date; refund_due_at anchors here
  given_at                        date NOT NULL,                                        -- postmark/mailing date if mailed; delivery date otherwise (§1026.23(a)(2))
  method                          text NOT NULL CHECK (method IN ('mail', 'email', 'portal', 'fax', 'hand')),
  document_id                     uuid REFERENCES documents(id),
  valid                           boolean NOT NULL,                                     -- written; within the period or the extended period
  invalid_reason                  text,
  refund_due_at                   date NOT NULL,                                        -- received_on + 20 calendar_days (§1026.23(d)(2))
  after_disbursement              boolean NOT NULL DEFAULT false,
  security_terminated_at          timestamptz,
  money_returned_at               timestamptz,
  tender_status                   text NOT NULL DEFAULT 'pending' CHECK (tender_status IN ('pending', 'tendered', 'court_modified')),
  status                          text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'validated', 'unwinding', 'closed', 'disputed')),
  unwind_checklist                jsonb NOT NULL DEFAULT '[]'::jsonb,                   -- [{step, owner, citation}] with evidence refs as completed
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rescission_exercises_refund_window CHECK (refund_due_at = received_on + 20)
);
COMMENT ON TABLE rescission_exercises IS '25.3: a consumer''s written notice of rescission — given when mailed (postmark) or delivered to the designated place; valid if on or before expires_on (or within the extended right); the 20-calendar-day unwind (REGZ_1026_23D2_RESCISSION_REFUND_20) with the checklist evidence. Append-only.';
CREATE INDEX rescission_exercises_rescission_idx ON rescission_exercises(rescission_id, received_at);
CREATE TRIGGER rescission_exercises_immutable BEFORE UPDATE OR DELETE ON rescission_exercises FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- rescission_waivers (append-only; §1026.23(e) — consumer-authored, dated, signed by all; printed forms prohibited)
CREATE TABLE rescission_waivers (
  waiver_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rescission_id                   uuid NOT NULL REFERENCES rescission_periods(rescission_id),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  statement_document_id           uuid NOT NULL REFERENCES documents(id),               -- the consumer's own dated, signed statement
  statement_dated_on              date NOT NULL,
  signed_by                       jsonb NOT NULL DEFAULT '[]'::jsonb,                   -- every consumer entitled to rescind
  consumer_written                boolean NOT NULL DEFAULT true CHECK (consumer_written),  -- no template, no pre-printed language
  emergency_summary               text NOT NULL,
  received_at                     timestamptz NOT NULL,
  accepted_by                     text,                                                 -- officer user id (officer-only)
  accepted_at                     timestamptz,
  rejected_reason                 text,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rescission_waivers_decided CHECK ((accepted_at IS NOT NULL AND accepted_by IS NOT NULL AND rejected_reason IS NULL) OR (accepted_at IS NULL AND accepted_by IS NULL))
);
COMMENT ON TABLE rescission_waivers IS '25.3: a bona fide personal financial emergency waiver under §1026.23(e) — the consumer''s dated written statement describing the emergency, signed by all consumers entitled to rescind, accepted or rejected by the partner officer within 4 hours; on acceptance rescission_periods.status = waived and disbursement may proceed. Append-only.';
CREATE INDEX rescission_waivers_rescission_idx ON rescission_waivers(rescission_id);
CREATE TRIGGER rescission_waivers_immutable BEFORE UPDATE OR DELETE ON rescission_waivers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE rescission_periods ADD CONSTRAINT rescission_periods_waiver_fk FOREIGN KEY (waiver_id) REFERENCES rescission_waivers(waiver_id);

-- ---------------------------------------------------------------- servicing flag (30.2 boards it; 9.x/16.x payoff and lien-release check it; sale/transfer lapses it)
ALTER TABLE loans ADD COLUMN IF NOT EXISTS rescission_extended_until date;
COMMENT ON COLUMN loans.rescission_extended_until IS '25.3: consummation + 3 years while the right of rescission is extended (notice or material disclosures defective — §1026.23(a)(3)(i)); null when the period expired unexercised; cleared on lapse (expiry, transfer of all interest, sale) or cure.';

COMMIT;
