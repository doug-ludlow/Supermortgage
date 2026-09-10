-- 0036_mi_claim_appeals_default_reports.sql — §15.3 MI claim filing: the collections the claims-reo tools persist that 0017/0036 did not
-- create — the insurer's default-report acceptances the daily curtailment monitor ingests (master policy §53: NOD by the 25th of the
-- month of the second consecutive missed payment, monthly updates; MI_MP_NOD_25TH / MI_MP_STATUS_MONTHLY_25TH), the MI default watch
-- (MI_MP_INTEREST_CAP_36M anchor), the scheduled sales observed for the premium-paid-through gate, claim packages with their manifest
-- hashes, appeals with the human_agent approval over $10,000 (open question 4), and servicer-caused shortfall exposures (rule 9, A1-3-02).
-- Append-only: 0017 and 0036_mi_claim_events are not edited.
BEGIN;

-- ── default reporting to the insurer (Section 10/11 channel; 15.3 reads the history into the curtailment score) ───────────────────────
CREATE TABLE mi_default_reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  kind                  text NOT NULL CHECK (kind IN ('nod','monthly_status')),
  period                text NOT NULL,                                             -- YYYY-MM of the report's due date
  due_on                date NOT NULL,                                             -- the 25th (master policy §53)
  reported_on           date,
  accepted_on           date,                                                      -- insurer acceptance (portal/EDI acknowledgment)
  accepted              boolean NOT NULL DEFAULT false,
  late                  boolean NOT NULL DEFAULT false,
  days_late             int NOT NULL DEFAULT 0,
  excluded_interest_cents bigint NOT NULL DEFAULT 0,                               -- NOD lateness: interest between the 25th and the acceptance (rule 5)
  insurer_ref           text,
  source                text NOT NULL DEFAULT 'insurer_channel',
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, kind, period)
);
COMMENT ON TABLE mi_default_reports IS '§15.3: the insurer''s NOD / monthly-status acceptances (master policy §53) as the curtailment monitor ingests them; a late NOD projects the excluded interest (15.3-T4).';

CREATE TABLE mi_default_watch (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  insurer_code          text,
  first_unpaid_due_date date NOT NULL,                                             -- the default date: MI_MP_INTEREST_CAP_36M anchor
  second_missed_payment_due date NOT NULL,
  nod_due               date NOT NULL,                                             -- 25th of the month of the second missed payment
  first_status_due      date NOT NULL,
  interest_cap_not_after date NOT NULL,                                            -- first unpaid due date + 36 months (first uninsured installment)
  started_on            date NOT NULL,
  in_default            boolean NOT NULL DEFAULT true,
  default_ended_on      date
);

CREATE TABLE mi_scheduled_sales (
  loan_id               uuid NOT NULL REFERENCES loans(id),
  scheduled_sale_date   date NOT NULL,
  observed_on           date NOT NULL,
  premium_paid_through  date,
  liquidation_month     text NOT NULL,
  gate_open             boolean,                                                   -- 15.3.premiumPaidThroughLiquidationMonth (SM_MI_PREMIUM_PAID_THROUGH_GATE)
  flag_id               uuid REFERENCES escalations(id),                           -- sale package flagged to pmi; premium advanced (Section 10)
  PRIMARY KEY (loan_id, scheduled_sale_date)
);

-- ── claim packages, appeals, shortfalls ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE mi_claim_packages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES mi_claims(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  kind                  text NOT NULL CHECK (kind IN ('initial','supplemental')),
  route                 text CHECK (route IN ('fnma_micp','servicer_direct')),
  manifest              jsonb NOT NULL DEFAULT '[]',                               -- [{id, doc_kind, sha256}] (rule 3: every document hashed)
  mandatory             jsonb NOT NULL DEFAULT '[]',
  missing               jsonb NOT NULL DEFAULT '[]',
  complete              boolean NOT NULL DEFAULT false,
  supplemental_due_at   date,
  upload_by             date,
  amount_cents          bigint,
  result                text CHECK (result IN ('filed_by_fnma_from_upload','servicer_files','none_needed','pending_sweep')),
  advances_swept_through date,
  assembled_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mi_claim_packages_claim_idx ON mi_claim_packages (claim_id, kind);

CREATE TABLE mi_claim_appeals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES mi_claims(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  reason                text NOT NULL CHECK (reason IN ('curtailment','denial','rescission')),
  amount_cents          bigint NOT NULL,
  exhibits              jsonb NOT NULL DEFAULT '[]',
  basis                 text,
  drafted_by            text NOT NULL DEFAULT 'agent',
  approval              text NOT NULL CHECK (approval IN ('agent','human_agent','officer')),   -- human_agent when amount_cents > 1,000,000 (open question 4)
  attorney_review       boolean NOT NULL DEFAULT false,                            -- rescission disputes (agents paragraph)
  status                text NOT NULL CHECK (status IN ('ready_to_file','awaiting_human_agent_review','approved','filed')),
  approved_by           text,
  approved_role         text,
  approved_on           date,
  filed_at              date,
  filed_by              text,
  via                   text,                                                      -- micp | insurer (portal/EDI/e-mail)
  drafted_on            date NOT NULL
);
CREATE INDEX mi_claim_appeals_claim_idx ON mi_claim_appeals (claim_id, status);

CREATE TABLE mi_claim_shortfalls (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES mi_claims(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  cause                 text NOT NULL CHECK (cause IN ('late_nod','late_documents','missing_expense_request','foreclosure_delay','improper_conveyance','premium_netting','insurer_error','property_condition','other')),
  amount_cents          bigint NOT NULL,
  attribution           text NOT NULL CHECK (attribution IN ('servicer_caused','insurer_other')),
  servicer_caused_shortfall_cents bigint NOT NULL DEFAULT 0,
  exposure              text CHECK (exposure IN ('A1-3-02')),
  memo_account          text CHECK (memo_account IN ('contingent_make_whole_fnma')),
  timeline_evidence_reviewed boolean NOT NULL DEFAULT false,                       -- guardrail: never conceded servicer-caused without it
  timeline_evidence     jsonb,
  attorney_task_id      uuid REFERENCES escalations(id),                           -- conveyance defects
  rule_ref              text NOT NULL,
  demanded              boolean NOT NULL DEFAULT false,                            -- A1-3-02 demand → 5.6 booking
  make_whole_demand_id  uuid,
  UNIQUE (claim_id, cause)
);

COMMIT;
