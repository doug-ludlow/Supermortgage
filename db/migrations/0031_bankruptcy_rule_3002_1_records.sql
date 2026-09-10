-- 0031: §14.2 data model — the records the Rule 3002.1 module (src/app/tools/section14-2.ts) persists that 0016
-- did not carry: the per-change decision record for a change that is skipped (rule 1: "The decision is recorded per
-- change"; guardrail: only a scope-test failure with a decision record can skip a filing), the frozen post-petition and
-- arrearage views the (g) response is computed from (rule 7: "On `bankruptcy.plan.completed` the post-petition and
-- arrearage views are frozen"), the recorded relief-order decision (14.2-Q2 and its exception) every later scope test
-- reads, counsel's requests for figures for a 3002.1 paper (E-2.1-04, FNMA_E2_1_04_DOCS_TO_FIRM_3BD), the rendered form
-- packages with their computation hashes (rule 9 evidence bundle), and the columns the existing 14.2 tables lacked for
-- the rows the tools write (loan linkage, stated facts and disagreements on the (f)/(g) response, the deadline
-- computation and decision record on the notice, the 9006 evidence and prior-notice linkage on fee items).
-- Append-only: new file; 0016 is not edited. Retention `court_record_7y` (0020) on every court-record table.
BEGIN;

ALTER TABLE bk_payment_change_notices
  ADD COLUMN IF NOT EXISTS detected_on            date,
  ADD COLUMN IF NOT EXISTS row_due_by             date,
  ADD COLUMN IF NOT EXISTS file_by                date,
  ADD COLUMN IF NOT EXISTS parts                  smallint[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS supersedes             uuid REFERENCES bk_payment_change_notices(id),
  ADD COLUMN IF NOT EXISTS superseded_by          uuid REFERENCES bk_payment_change_notices(id),
  ADD COLUMN IF NOT EXISTS package_id             uuid,
  ADD COLUMN IF NOT EXISTS hold_amount_cents      bigint,
  ADD COLUMN IF NOT EXISTS "order"                jsonb,
  ADD COLUMN IF NOT EXISTS effective_on           date,
  ADD COLUMN IF NOT EXISTS deadline_calc          jsonb,
  ADD COLUMN IF NOT EXISTS decision               jsonb;
COMMENT ON COLUMN bk_payment_change_notices.deadline_calc IS '§14.2 rule 9: the Rule 9006 deadline computation {anchor, offset, roll_rule, calendar_version, holidays_applied, result, target}';
COMMENT ON COLUMN bk_payment_change_notices.decision IS '§14.2 AI agent design: the decision record {case_id, filing_type, trigger_event_id, computation_hash, deadline_calc, scope_test_result, fee_items, service_list, rule_set_version, model_version, rationale, outcome, reviewer_id}';
COMMENT ON COLUMN bk_payment_change_notices.supersedes IS '§14.2 edge case: a later change to the same due date supersedes the earlier notice (new filing; the earlier row is marked superseded)';
COMMENT ON COLUMN bk_payment_change_notices."order" IS '§14.2 (b)(4)/(e): the court''s order {docket_event_id, entered_on, determined_total_cents, applies_from} — its figures are applied on entry, never the agent''s';

-- rule 1: the skip decision for a change that is out of scope / ceased on relief / no change in the total
CREATE TABLE IF NOT EXISTS bk_payment_change_decisions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES bankruptcy_cases(case_id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  source                text,
  effective_due_date    date NOT NULL,
  old_total_cents       bigint NOT NULL,
  new_total_cents       bigint NOT NULL,
  scope_test_result     text NOT NULL,
  outcome               text NOT NULL,
  rule_code             text,
  decision              jsonb NOT NULL,
  status                text NOT NULL CHECK (status IN ('out_of_scope','no_change')),
  decided_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bk_payment_change_decisions_loan_idx ON bk_payment_change_decisions (loan_id, effective_due_date);

ALTER TABLE bk_postpetition_fee_items
  ADD COLUMN IF NOT EXISTS recoverable            boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS evidence_document_id   uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS source_process         text,
  ADD COLUMN IF NOT EXISTS waived_reason          text,
  ADD COLUMN IF NOT EXISTS paid_cents             bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS batch_files_on         date,
  ADD COLUMN IF NOT EXISTS noticed_on             date,
  ADD COLUMN IF NOT EXISTS resolved_at            timestamptz,
  ADD COLUMN IF NOT EXISTS late_notice_attempt    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS counsel_advice_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS approved_by            text;
COMMENT ON COLUMN bk_postpetition_fee_items.evidence_document_id IS '§14.2 inputs: `fee.incurred_postpetition.evidence_document_id` — incurrence evidence for the sanction-proof bundle';
COMMENT ON COLUMN bk_postpetition_fee_items.late_notice_attempt IS '§14.2 rule 5: a precluded item noticed late only on the officer''s approval with counsel''s advice';

ALTER TABLE bk_status_responses
  ADD COLUMN IF NOT EXISTS loan_id                uuid REFERENCES loans(id),
  ADD COLUMN IF NOT EXISTS form                   text,
  ADD COLUMN IF NOT EXISTS timer                  text,
  ADD COLUMN IF NOT EXISTS filing_type            text,
  ADD COLUMN IF NOT EXISTS frozen_view_id         uuid,
  ADD COLUMN IF NOT EXISTS ledger_view_id         uuid,
  ADD COLUMN IF NOT EXISTS ledger_snapshot_hash   text,
  ADD COLUMN IF NOT EXISTS stated_facts           jsonb,
  ADD COLUMN IF NOT EXISTS disagreements          jsonb,
  ADD COLUMN IF NOT EXISTS checklist              jsonb,
  ADD COLUMN IF NOT EXISTS fnma_fee_cents         bigint,
  ADD COLUMN IF NOT EXISTS filed_at               timestamptz,
  ADD COLUMN IF NOT EXISTS served_at              timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bk_status_responses_status_chk') THEN
    ALTER TABLE bk_status_responses ADD CONSTRAINT bk_status_responses_status_chk CHECK (status IN ('open','triggered','computed','package_ready','signed','filed_served','resolved'));
  END IF;
END $$;
COMMENT ON COLUMN bk_status_responses.stated_facts IS '§14.2 rules 6–7: what the motion / trustee''s notice states, compared with the ledger at $0.00 tolerance';
COMMENT ON COLUMN bk_status_responses.ledger_snapshot_hash IS '§14.2 rule 7 / audit: the frozen ledger views the response was computed from';

-- rule 7: the post-petition and arrearage views frozen on plan completion for the trustee's Form 410C13-N
CREATE TABLE IF NOT EXISTS bk_ledger_views_frozen (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES bankruptcy_cases(case_id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  completed_on          date NOT NULL,
  source                text NOT NULL CHECK (source IN ('tfs','epay','final_voucher','trustee_final_report','ntc_final_report')),
  final_voucher_id      text,
  trustee_id            text,
  frozen_at             timestamptz NOT NULL DEFAULT now(),
  views                 jsonb NOT NULL,
  ledger_snapshot_hash  text NOT NULL,
  watch_timer           text NOT NULL DEFAULT 'SM_BK_3002_1G1_TRUSTEE_NOTICE_WATCH_45',
  watch_lapses_on       date NOT NULL,
  retention             retention_class NOT NULL DEFAULT 'court_record_7y'
);
CREATE INDEX IF NOT EXISTS bk_ledger_views_frozen_loan_idx ON bk_ledger_views_frozen (loan_id, frozen_at);
ALTER TABLE bk_status_responses ADD CONSTRAINT bk_status_responses_frozen_view_fk FOREIGN KEY (frozen_view_id) REFERENCES bk_ledger_views_frozen(id);

-- Rule 3002.1(a) / 14.2-Q2: the relief-order decision (continue filing while the case is open unless counsel advises otherwise) every later scope test reads
CREATE TABLE IF NOT EXISTS bk_rule3002_1_scope (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  case_id               uuid REFERENCES bankruptcy_cases(case_id),
  docket_event_id       uuid REFERENCES bankruptcy_docket_events(id),
  relief_order_entered  boolean NOT NULL DEFAULT true,
  relief_order_entered_on date NOT NULL,
  case_open             boolean NOT NULL DEFAULT true,
  counsel_advises_improper boolean NOT NULL DEFAULT false,
  court_orders_continued_compliance boolean NOT NULL DEFAULT false,
  continue_filing       boolean NOT NULL,
  in_scope              boolean NOT NULL,
  gate                  text NOT NULL DEFAULT 'SM_BK_3002_1_RELIEF_CEASE_CHECK',
  counsel_advice_document_id uuid REFERENCES documents(id),
  decision              jsonb NOT NULL,
  decided_at            timestamptz NOT NULL DEFAULT now()
);

-- E-2.1-04: counsel's request for figures for any 3002.1 paper, delivered within 3 servicer business days (FNMA_E2_1_04_DOCS_TO_FIRM_3BD)
CREATE TABLE IF NOT EXISTS bk_counsel_figure_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES bankruptcy_cases(case_id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  firm_id               text NOT NULL,
  filing_type           text NOT NULL CHECK (filing_type IN ('s1_payment_change','s2_fee_notice','m1r_status_response','nr_final_cure_response','m2r_motion_response')),
  subject               text,
  requested_at          timestamptz NOT NULL,
  due                   date NOT NULL,
  timer                 text NOT NULL DEFAULT 'FNMA_E2_1_04_DOCS_TO_FIRM_3BD',
  fulfilled_at          timestamptz,
  computation_hash      text,
  package_id            uuid,
  late                  boolean,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','fulfilled'))
);

-- rule 9: the rendered form package (figures, checklist, computation hash, deadline calc) handed to counsel
CREATE TABLE IF NOT EXISTS bk_filing_packages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES bankruptcy_cases(case_id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  notice_id             uuid REFERENCES bk_payment_change_notices(id),
  form                  text NOT NULL,
  filing_type           text NOT NULL CHECK (filing_type IN ('s1_payment_change','s2_fee_notice','m1r_status_response','nr_final_cure_response','m2r_motion_response')),
  data                  jsonb NOT NULL,
  pi_new_cents          bigint,
  escrow_new_cents      bigint,
  new_total_cents       bigint,
  notice_date           date,
  lines                 jsonb,
  total_cents           bigint,
  fee_item_ids          uuid[] NOT NULL DEFAULT '{}',
  previously_noticed_ids uuid[] NOT NULL DEFAULT '{}',
  memo_balance_cents    bigint,
  analysis_id           text,
  ledger_snapshot_hash  text,
  computation_hash      text NOT NULL,
  deadline_calc         jsonb,
  rule_set_version      text NOT NULL,
  status                text NOT NULL DEFAULT 'package_ready',
  rendered_at           timestamptz NOT NULL DEFAULT now(),
  retention             retention_class NOT NULL DEFAULT 'court_record_7y'
);
ALTER TABLE bk_payment_change_notices ADD CONSTRAINT bk_payment_change_notices_package_fk FOREIGN KEY (package_id) REFERENCES bk_filing_packages(id);

COMMIT;
