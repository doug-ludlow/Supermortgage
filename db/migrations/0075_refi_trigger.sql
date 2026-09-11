-- 0075_refi_trigger.sql — §20.1 Portfolio rate monitoring and refinance-opportunity detection on the subserviced book
-- (spec/sections/20-refinance-triggers-solicitation-lead-intake-and-pricing/20-1-*.md "Data model"; addendum §3).
-- 20.1's own tables: `partner_programs` (the partner's refinance program economics — term-sheet parameters carried as
-- configuration), `refi_trigger_runs` (one append-only summary per run) and `refi_opportunities` (one row per
-- (loan_id, as_of_date, program_id); status history in `loan_events`). The SERVICING portfolio is the data source, never
-- a copy: the trigger reads it through the investor-blind view `v_refi_universe` (rule 7 — no investor_id,
-- fnma_loan_number, pool_number, remittance_type, mbs_flag, sfc_codes; `loans.fnma_purchase_date` is exposed only to the
-- recapture gate and is deliberately NOT in the view). Column additions on `loans` (ALTER … ADD COLUMN IF NOT EXISTS,
-- never a second CREATE): refi_last_offered_at, refi_offers_12m, refi_do_not_solicit (set from 20.2's
-- marketing_suppressions), fnma_purchase_date (written by 29.4/30.1; IF NOT EXISTS so either side may land first).
-- Baseline tables used but owned elsewhere: loans / loan_terms / properties / parties / documents / agent_decisions
-- (0001), rule_sets (0006), jurisdiction_rules (0002; `rules.refi_borrower_interest_rule`), applications (0057),
-- rate_sheets / llpa_tables / pricing_quotes (0074), hmda_records (0068; the fair-lending extract reads it under the
-- applicant_demographics access log). `campaign_id` (20.2) and `lead_id` (20.3) are plain keys — those migrations land in parallel.
BEGIN;

-- ───────────────────────────── partner_programs (rule 6: the partner's own product; GLBA §1016.13 service-provider use) ─────────────────────────────
CREATE TABLE partner_programs (
  program_id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                          uuid NOT NULL REFERENCES parties(id),
  kind                                text NOT NULL CHECK (kind IN ('refi_self_improving')),
  product_owner                       text NOT NULL DEFAULT 'partner' CHECK (product_owner IN ('partner', 'sm', 'third_party')),   -- loadUniverse refuses 'sm' (glba_use_violation); 'third_party' needs the joint agreement
  joint_agreement_document_id         uuid REFERENCES documents(id),                                             -- §1016.13(b) written joint agreement (third_party only)
  third_party_cost_recovery           text NOT NULL DEFAULT 'gain_on_sale_only' CHECK (third_party_cost_recovery IN ('gain_on_sale_only')),
  residual_treatment                  text NOT NULL DEFAULT 'lender_credit' CHECK (residual_treatment IN ('lender_credit', 'rate_step_down_only')),
  residual_credit_cap_bps             numeric(6,3) NOT NULL DEFAULT 12.5,
  platform_fee_bps_annual             numeric(6,3) NOT NULL DEFAULT 12.5,
  platform_fee_payer                  text NOT NULL DEFAULT 'partner' CHECK (platform_fee_payer IN ('partner', 'borrower')),
  min_rate_reduction_bps              integer NOT NULL DEFAULT 25 CHECK (min_rate_reduction_bps >= 0),
  min_npv_cents                       bigint NOT NULL DEFAULT 0,
  holding_period_months               integer NOT NULL DEFAULT 84 CHECK (holding_period_months > 0),
  discount_rate_basis                 text NOT NULL DEFAULT 'new_note_rate' CHECK (discount_rate_basis IN ('new_note_rate')),
  max_offers_per_loan_per_12m         integer NOT NULL DEFAULT 2 CHECK (max_offers_per_loan_per_12m >= 0),
  resolicit_cooldown_days             integer NOT NULL DEFAULT 90 CHECK (resolicit_cooldown_days >= 0),
  premium_recapture_suppression_days  integer NOT NULL DEFAULT 120 CHECK (premium_recapture_suppression_days >= 0),
  effective_from                      date NOT NULL,
  effective_to                        date,
  approved_by                         text,                                                                       -- partner officer (rule-set / economics approval)
  term_sheet_document_id              uuid REFERENCES documents(id),                                             -- retention fnma_loan_file_life_plus_4y
  retention_class                     retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at                          timestamptz NOT NULL DEFAULT now(),
  CHECK (product_owner <> 'third_party' OR joint_agreement_document_id IS NOT NULL)
);
COMMENT ON TABLE partner_programs IS '20.1 data model: the partner''s refinance program economics (SM bears third-party costs; gain-on-sale recovers only those; residual as a capped lender credit; platform fee 12.5 bps/yr) — configuration defaults until the executed term sheet is filed [UNVERIFIED]; rule 6: the rule engine refuses any kind/product owner that is not the partner''s own product (GLBA §1016.13).';
CREATE INDEX partner_programs_partner_idx ON partner_programs(partner_id, kind, effective_from DESC);

-- ───────────────────────────── loans: origination adds its columns (data model "Column additions") ─────────────────────────────
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS refi_last_offered_at   timestamptz,                                   -- refi.opportunity.offered{offered_at}
  ADD COLUMN IF NOT EXISTS refi_offers_12m        integer NOT NULL DEFAULT 0,                    -- SM_REFI_OFFER_FREQUENCY_CAP counter (rolling 12 months)
  ADD COLUMN IF NOT EXISTS refi_do_not_solicit    boolean NOT NULL DEFAULT false,                -- set from marketing_suppressions (20.2)
  ADD COLUMN IF NOT EXISTS fnma_purchase_date     date;                                          -- 29.4/30.1: whole-loan purchase / MBS issue date — FNMA_C1_1_01_PREMIUM_RECAPTURE_120 anchor only, never a selection input
COMMENT ON COLUMN loans.fnma_purchase_date IS '29.4/30.1 write it (loan.purchased{purchase_date}); 20.1 rule 7: exposed only to the premium-recapture gate (which suppresses, never selects) — not in v_refi_universe.';

-- ───────────────────────────── refi_trigger_runs (append-only run summary) ─────────────────────────────
CREATE TABLE refi_trigger_runs (
  run_id                              text PRIMARY KEY,
  program_id                          uuid NOT NULL REFERENCES partner_programs(program_id),
  as_of_date                          date NOT NULL,
  trigger_kind                        text NOT NULL DEFAULT 'scheduled' CHECK (trigger_kind IN ('scheduled', 'rate_move')),
  rate_sheet_id                       text REFERENCES rate_sheets(rate_sheet_id),
  llpa_table_id                       text REFERENCES llpa_tables(llpa_table_id),
  rule_set_version                    text NOT NULL,                                             -- sm.refi_trigger.v1
  view_definition_hash                text NOT NULL,                                             -- audit: v_refi_universe definition + column allowlist
  purpose                             text NOT NULL,                                             -- partner_program:<program_id> (GLBA purpose tag on every read)
  loans_in_universe                   integer NOT NULL DEFAULT 0,
  loans_evaluated                     integer NOT NULL DEFAULT 0,
  opportunities_detected              integer NOT NULL DEFAULT 0,
  suppressed_by_reason                jsonb NOT NULL DEFAULT '{}',                               -- {premium_recapture_window: n, cooldown: n, frequency_cap: n, marketing_suppression: n, delinquent: n, …}
  fair_lending_extract_document_id    uuid REFERENCES documents(id),                             -- missing → run flagged incomplete (31.2)
  started_at                          timestamptz NOT NULL,
  completed_at                        timestamptz,
  agent_run_id                        text,
  created_at                          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, as_of_date, run_id)
);
COMMENT ON TABLE refi_trigger_runs IS '20.1 data model: one row per daily / rate-move run (SM_REFI_TRIGGER_DAILY → refi.trigger.run_completed) with the rule-set version, view hash, universe counts, suppression histogram and the fair-lending extract id (audit and evidence). Append-only.';
CREATE INDEX refi_trigger_runs_program_day_idx ON refi_trigger_runs(program_id, as_of_date DESC);
CREATE TRIGGER refi_trigger_runs_immutable BEFORE UPDATE OR DELETE ON refi_trigger_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── refi_opportunities (one per loan per as_of_date per program; PII: none beyond loan linkage) ─────────────────────────────
CREATE TABLE refi_opportunities (
  opportunity_id                      text PRIMARY KEY,
  run_id                              text REFERENCES refi_trigger_runs(run_id),                 -- null on the borrower-request path
  loan_id                             uuid NOT NULL REFERENCES loans(id),
  program_id                          uuid NOT NULL REFERENCES partner_programs(program_id),
  as_of_date                          date NOT NULL,
  trigger_kind                        text NOT NULL CHECK (trigger_kind IN ('scheduled', 'rate_move', 'borrower_request', 'mi_removal', 'arm_reset_ahead', 'term_change')),
  detected_at                         timestamptz NOT NULL,
  existing_terms                      jsonb NOT NULL,                                            -- {note_rate, upb_cents, remaining_term_months, pi_cents, escrow_monthly_cents, mi_monthly_cents, mi_status, occupancy, product, note_date, first_payment_date, investor_blind_hash}
  value_estimate                      jsonb NOT NULL,                                            -- {source ∈ {origination_indexed, avm}, value_cents, as_of, confidence}
  candidate_terms                     jsonb,                                                     -- {transaction_type, product_code, term_months, loan_amount_cents, note_rate, pi_cents, quote_id (20.4), ltv, cash_back_cents, …}
  same_term_candidate                 jsonb,                                                     -- {term_months, pi_cents, note_rate}
  benefit_metrics                     jsonb,                                                     -- rule 4 schema: rate_delta_bps, pi_delta_cents, payment_delta_cents, breakeven_months, lifetime_interest_delta_cents, same_term_*, npv_cents, balance_delta_at_h_cents, seven_year_total_cost_delta_cents
  eligibility_prescreen               jsonb,                                                     -- {ltv_ok, seasoning_ok, occupancy_ok, delinquency_ok, product_ok, state_rule_ok, requires_fnma_ownership_check, fnma_owned, reasons[]}
  gates                               jsonb NOT NULL DEFAULT '[]',                               -- [{code, status ∈ {open, closed, not_applicable}, opens_on, reason}]
  state_determination                 jsonb,                                                     -- MA §28C: {applies, months_since_consummation, pass, factors[], rule}
  status                              text NOT NULL CHECK (status IN ('detected', 'suppressed', 'offer_ready', 'offered', 'engaged', 'converted', 'declined', 'expired', 'requested')),
  suppression_reasons                 text[] NOT NULL DEFAULT '{}',
  present_same_term_first             boolean NOT NULL DEFAULT false,                            -- rule 5 (UDAAP: the term reset is disclosed with both numbers)
  offer_valid_until                   date,                                                      -- offered_at + 30 (SM_REFI_OPPORTUNITY_EXPIRY_30)
  campaign_id                         text,                                                      -- 20.2 (parallel migration)
  lead_id                             text,                                                      -- 20.3 (parallel migration)
  application_id                      uuid REFERENCES applications(id),                          -- 21.1 opens it with prior_loan_id = loan_id
  decision_id                         uuid REFERENCES agent_decisions(id),
  officer_acknowledgment_required     boolean NOT NULL DEFAULT false,                            -- request inside the premium-recapture window
  explanation_text                    text NOT NULL DEFAULT '',
  inputs_hash                         text NOT NULL DEFAULT '',
  rule_set_version                    text NOT NULL,
  created_at                          timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, as_of_date, program_id)                                                       -- edge case "Duplicate detection": idempotency key
);
COMMENT ON TABLE refi_opportunities IS '20.1 data model: the per-loan opportunity with benefit metrics, prescreen, gates and suppression reasons; state machine detected → suppressed | offer_ready → offered (20.2 marketing.touch.sent) → engaged (20.3 lead.created) → converted (application.received) | declined | expired; requested (borrower-initiated) → offer_ready. Status history is append-only in loan_events (refi.opportunity.*); idempotent on (loan_id, as_of_date, program_id).';
CREATE INDEX refi_opportunities_loan_idx ON refi_opportunities(loan_id, as_of_date DESC);
CREATE INDEX refi_opportunities_status_idx ON refi_opportunities(program_id, status, as_of_date DESC);
CREATE INDEX refi_opportunities_run_idx ON refi_opportunities(run_id);

-- ───────────────────────────── v_refi_universe (rule 7: the investor-blind read model) ─────────────────────────────
-- Excludes loans.fnma_loan_number, loans.fnma_purchase_date, loan_terms.remittance_type and every investor / pool / SFC
-- column by construction; any change to this view requires officer + compliance-sentinel sign-off (view hash on the run).
CREATE VIEW v_refi_universe AS
SELECT l.id                         AS loan_id,
       l.partner_party_id           AS partner_id,
       l.status                     AS status,
       l.instrument_date            AS note_date,
       l.origination_date           AS consummation_date,
       l.first_payment_date         AS first_payment_date,
       l.original_upb_cents         AS original_upb_cents,
       l.original_term_months       AS original_term_months,
       t.amortization               AS amortization,
       t.note_rate_bps              AS note_rate_bps,
       t.pi_cents                   AS pi_cents,
       t.escrow_payment_cents       AS escrow_monthly_cents,
       t.escrowed                   AS escrowed,
       t.remaining_term_months      AS remaining_term_months,
       t.maturity_date              AS maturity_date,
       p.state                      AS property_state,
       p.county                     AS county,
       p.occupancy                  AS occupancy,
       p.property_type              AS property_type,
       p.units                      AS units,
       l.refi_do_not_solicit        AS refi_do_not_solicit,
       l.refi_last_offered_at       AS refi_last_offered_at,
       l.refi_offers_12m            AS refi_offers_12m
FROM loans l
JOIN loan_terms t ON t.loan_id = l.id AND t.effective_to IS NULL
JOIN properties p ON p.id = l.property_id
WHERE l.status = 'active';
COMMENT ON VIEW v_refi_universe IS '20.1 rule 7: the rule engine''s investor-blind read model — no investor_id, fnma_loan_number, pool_number, remittance_type, mbs_flag, sfc_codes; fnma_purchase_date is read only by the recapture gate (which suppresses, never selects). Selection inputs are limited to rule 8''s list; delinquency, bankruptcy, loss-mitigation, MI and value estimates join from their own tables at run time.';

-- ───────────────────────────── the objective selection rule set (operational prerequisites; T5 static check) ─────────────────────────────
INSERT INTO rule_sets (bundle, version, effective_from, effective_to, content, approved_by)
VALUES ('sm.refi_trigger', 'v1', DATE '2026-09-01', NULL,
  '{"referenced_columns":["loan_id","status","note_rate_pct","upb_cents","remaining_term_months","amortization","product_code","occupancy","ltv_estimate","property_state","regx_days_delinquent","mi_status","mi_monthly_cents","refi_do_not_solicit","consent_flags","bankruptcy_active","foreclosure_referred","lossmit_plan_active","deceased_or_sii_pending","transfer_out_pending","escrowed","pi_cents","escrow_monthly_cents","value_estimate","note_date","first_payment_date","original_upb_cents","original_term_months","arm_first_adjustment_date"],"prohibited":["investor_id","fnma_loan_number","pool_number","remittance_type","mbs_flag","sfc_codes","zip","census_tract","language_preference","age","date_of_birth","name","applicant_demographics","credit_score"],"fire_rule":{"min_rate_reduction_bps":25,"min_npv_cents":0,"seven_year_total_cost_delta_positive":true,"same_term_npv_positive_when_lifetime_delta_positive":true},"holding_period_months":84,"reviewed_by":"compliance-sentinel"}'::jsonb,
  'partner officer (rule-set approval) + compliance-sentinel review')
ON CONFLICT (bundle, version) DO NOTHING;

COMMIT;
