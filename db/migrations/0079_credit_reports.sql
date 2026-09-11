-- 0079_credit_reports.sql — 22.2 Credit report ordering, credit-score model and merge rules, analysis, freezes/disputes,
-- inquiries and the pre-closing refresh (spec/sections/22-…/22-2-…md "Data model"; addendum §3 `credit_reports`).
-- `applications` (0057) is the aggregate; `application_borrowers` / `application_liabilities` (0057), `fee_items` (0064)
-- and `documents` (0001) are referenced by id only. Append-only where the rows are evidence: credit_reports (a re-pull
-- is a new row that `supersedes_report_id` chains to; state changes are events), credit_alerts resolutions are new
-- versions of the alert's `resolution` written by the runtime through the event log — the tables below keep the rows
-- the process reads back; every change of state is also a `loan_events` row keyed by application_id.
BEGIN;

-- R11: one score model per application (LL-2026-06 — "the same credit score model must be used for all borrowers on a
-- single loan"); set on the first hard pull from `credit.score_model_default`, changed only by a full re-pull of every
-- borrower under the other model before any DU submission relying on the new report (`credit.score.model.selected`).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS score_model text CHECK (score_model IN ('classic_fico', 'vantagescore_4'));
COMMENT ON COLUMN applications.score_model IS '22.2 R11: the loan''s credit-score model (Classic FICO or VantageScore 4.0; LL-2026-06 Sept 9, 2026), immutable except by a full re-pull with a written decision; feeds 20.4 (LLPA grid family), 23.1 (DU), 29.3/29.4 (SFC 067), 28.3 (HMDA model name).';

-- R1–R4, R10: the tri-merge / RMCR / soft pre-qualification / soft refresh / UDM snapshot rows (baseline `credit_reports`,
-- extended here). `expires_at = add_months(report_date, 4)` (B1-1-03); `representative_score` per B3-5.1-02 (null when
-- no borrower has a score → lowest LLPA band). FCRA use limitation: transaction-only (documents carry pii_flags ⊇
-- {consumer_report}); retention regb_25m then fnma_loan_file_life_plus_4y (22.1 R9). Append-only.
CREATE TABLE credit_reports (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  report_type                     text NOT NULL CHECK (report_type IN ('tri_merge_infile', 'rmcr', 'soft_prequal', 'soft_refresh', 'udm_snapshot')),
  reseller                        text NOT NULL,
  du_credit_provider_code         text,
  credit_reference_number         text,                                        -- DU reissue key (23.1 supplies it to the casefile)
  borrower_ids                    uuid[] NOT NULL,                             -- application_borrowers.id (joint report when > 1)
  repositories_requested          text[] NOT NULL,                             -- efx | exp | tu — three for every hard pull (credit.bi_merge = false)
  repositories_returned           text[] NOT NULL DEFAULT '{}',
  frozen_repositories             text[] NOT NULL DEFAULT '{}',
  fraud_alerts                    jsonb NOT NULL DEFAULT '[]',                 -- [{borrower_id, repository, kind ∈ initial|extended|active_duty, contact_phone}]
  score_model                     text NOT NULL CHECK (score_model IN ('classic_fico', 'vantagescore_4')),
  scores                          jsonb NOT NULL DEFAULT '{}',                 -- per borrower: {efx, exp, tu} → {score, model_version, key_factors[]}
  borrower_applicable_scores      jsonb NOT NULL DEFAULT '{}',                 -- middle of three / lower of two / the one (B3-5.1-02)
  representative_score            int CHECK (representative_score BETWEEN 300 AND 850),
  representative_score_borrower_id uuid,
  no_score_borrowers              uuid[] NOT NULL DEFAULT '{}',
  key_factors                     jsonb NOT NULL DEFAULT '{}',                 -- up to four reason codes per borrower per bureau + inquiries flag (§615(a); §609(g))
  inquiries_90d                   jsonb NOT NULL DEFAULT '[]',
  disputed_tradelines             jsonb NOT NULL DEFAULT '[]',
  public_records                  jsonb NOT NULL DEFAULT '[]',
  mortgage_tradelines             jsonb NOT NULL DEFAULT '[]',
  collections                     jsonb NOT NULL DEFAULT '[]',
  trended_data                    boolean NOT NULL DEFAULT false,              -- B3-5.2-01: the DU report must support trended credit data
  permissible_purpose             text NOT NULL CHECK (permissible_purpose IN ('credit_transaction_604a3A', 'consumer_initiated_604a3F', 'account_review_604a3A')),
  certification_ref               text NOT NULL,                               -- the partner's §1681e certification reference
  pulled_at                       timestamptz NOT NULL,
  report_date                     date NOT NULL,
  expires_at                      date NOT NULL,                               -- add_months(report_date, 4) — B1-1-03 four months on the note date
  fee_cents                       bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  fee_item_id                     uuid REFERENCES fee_items(id),               -- fee_items{fee_code=credit_report, le_section=B_cannot_shop, tolerance_class=zero}
  document_id                     uuid REFERENCES documents(id),               -- documents{doc_class=credit_report}; the final-DU report is flagged relied_upon
  supersedes_report_id            uuid REFERENCES credit_reports(id),
  state                           text NOT NULL DEFAULT 'received' CHECK (state IN ('ordered', 'received', 'parsed', 'usable', 'freeze_blocked', 'two_repository', 'no_score', 'error', 'du_reissued', 'relied_upon', 'superseded', 'expired')),
  state_reason                    text,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at = (report_date + interval '4 months')::date),
  CHECK (cardinality(borrower_ids) >= 1)
);
COMMENT ON TABLE credit_reports IS '22.2 data model (baseline credit_reports extended): tri-merge / RMCR / soft pre-qualification / soft refresh / UDM snapshot reports — B3-5.2-01 (three in-file merged report, trended data), B3-5.1-02 (applicable and representative scores), B1-1-03 (expires_at = report_date + 4 months), FCRA §604(a)(3)(A)/(F) permissible purpose with the partner''s §1681e certification; a re-pull is a new row chained by supersedes_report_id; append-only.';
CREATE INDEX credit_reports_app_idx ON credit_reports(application_id, report_date DESC);
CREATE INDEX credit_reports_expiry_idx ON credit_reports(expires_at) WHERE state NOT IN ('superseded', 'expired');
CREATE TRIGGER credit_reports_immutable BEFORE UPDATE OR DELETE ON credit_reports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- R9: undisclosed-debt monitoring alerts (UDM vendor, refresh comparison, inquiry review) and their triage.
CREATE TABLE credit_alerts (
  alert_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          uuid NOT NULL REFERENCES applications(id),
  borrower_id             uuid NOT NULL,                                       -- application_borrowers.id
  source                  text NOT NULL CHECK (source IN ('udm_vendor', 'refresh_compare', 'inquiry_review')),
  alert_type              text NOT NULL CHECK (alert_type IN ('new_tradeline', 'inquiry', 'secondary_reissue', 'bankruptcy', 'judgment', 'lien', 'collection', 'late_payment', 'balance_increase')),
  payload                 jsonb NOT NULL DEFAULT '{}',
  received_at             timestamptz NOT NULL,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'explained', 'verified_new_debt', 'false_positive', 'resolved')),
  resolution              jsonb,                                               -- {status, rationale, explanation, evidence_document_id, liability_id, triaged_at, relief_note}
  dti_impact_cents        bigint CHECK (dti_impact_cents IS NULL OR dti_impact_cents >= 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE credit_alerts IS '22.2 R9: undisclosed-debt monitoring from report_date through closing.consummated (B3-6-01 recalculation duty; A2-2-04 relief needs closing by the credit report expiration date) — open → explained | verified_new_debt (22.5 liability + 23.1 B3-2-10) | false_positive → resolved; SM_UDM_MONITOR_ACTIVE / SM_CREDIT_REFRESH_PRECLOSE_GATE read the statuses.';
CREATE INDEX credit_alerts_app_idx ON credit_alerts(application_id, status);

-- R4: security-freeze workflow (FCRA §605A(i); B3-5.1-01 — one frozen repository acceptable on a tri-merge, two or more ineligible until lifted).
CREATE TABLE credit_freeze_actions (
  action_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                   uuid NOT NULL REFERENCES applications(id),
  borrower_id                      uuid NOT NULL,                              -- application_borrowers.id
  report_id                        uuid NOT NULL REFERENCES credit_reports(id),
  repository                       text NOT NULL CHECK (repository IN ('efx', 'exp', 'tu')),
  detected_at                      timestamptz NOT NULL,
  borrower_notified_at             timestamptz,                                -- SM_CREDIT_FREEZE_FOLLOWUP_2 anchor
  lift_requested_by_borrower_at    timestamptz,
  lift_window_start                date,                                       -- temporary removal "for the period of time specified by the consumer"
  lift_window_end                  date,
  re_pull_at                       timestamptz,
  status                           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'lifted', 're_pulled', 'borrower_declined', 'ineligible_two_or_more')),
  created_at                       timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  CHECK (lift_window_end IS NULL OR lift_window_start IS NULL OR lift_window_end >= lift_window_start)
);
COMMENT ON TABLE credit_freeze_actions IS '22.2 R4: security freezes per borrower and repository (15 U.S.C. 1681c-1(i): 1-hour electronic / 3-business-day mail removal; temporary removal window) — open → lifted → re_pulled | borrower_declined (21.6 NOIA "lift the security freeze at {bureau}") | ineligible_two_or_more (B3-5.1-01) until lifted.';
CREATE INDEX credit_freeze_actions_app_idx ON credit_freeze_actions(application_id, status);

-- R8: every inquiry in the 90 days before the report date that is not the partner's own pull or a DU reissue (B3-5.3-04/-09).
CREATE TABLE inquiry_explanations (
  inquiry_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          uuid NOT NULL REFERENCES applications(id),
  borrower_id             uuid NOT NULL,                                       -- application_borrowers.id
  report_id               uuid REFERENCES credit_reports(id),
  creditor_name           text NOT NULL,
  inquiry_date            date NOT NULL,
  repository              text CHECK (repository IN ('efx', 'exp', 'tu')),
  explanation             text,
  new_credit_obtained     boolean,
  new_liability_id        uuid REFERENCES application_liabilities(id),         -- 22.5 adds the liability; 23.1 checks B3-2-10
  explained_at            timestamptz,
  evidence_document_id    uuid REFERENCES documents(id),
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'explained')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE inquiry_explanations IS '22.2 R8: borrower explanations for recent inquiries (B3-5.3-04: "the lender must confirm that the borrower has not obtained any additional credit"; B3-5.3-09) — new_credit_obtained → application_liabilities row (22.5) and the B3-2-10 DTI tolerance check (23.1: > 45% or +3 points → resubmit).';
CREATE INDEX inquiry_explanations_app_idx ON inquiry_explanations(application_id, status);

COMMIT;
