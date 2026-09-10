-- 0052: §18.7 data-model corrections on the four eligibility tables created by 0021 (append-only: 0021 is applied, so
-- the changes are ALTERs and COMMENTs here — no new table).
--   eligibility_results — the spec's status ladder `compliant → warning → breach` is the band; `stale` is the flag the
--     integration rule sets ("GL feed failure → compute with the prior close flagged `stale`; quarterly certification
--     blocked until a fresh close", 18.7-T7) — 0021 folded it into `status`, which the calculator never writes; the
--     state machine `gl_received → upb_finalized → computed → officer_certified → form1002_prepared → submitted → acknowledged`
--     (monthly: `computed → reported_to_partner`; ladder: `remediation_plan`); the certification record (ELIG-CERT-Q-v1:
--     officer id, date, document) with the invariant that only a quarter-end, non-stale result is `officer_certified`
--     (guardrail "certifications are CEO/CFO acts"; 18.7-T7/T8); the detection dates the SM_ELIG_WARNING_REMEDIATION_30 /
--     SM_ELIG_BREACH_NOTIFY_1BD clocks anchor on; the decision-record `inputs_hash`; retention corporate_7y;
--   gl_snapshots — the close receipt date the BD5 test reads, the decision-record `inputs_hash` over the hashed source
--     documents (guardrail "every input is a hashed source document": at least one source document), the origination
--     liquidity inputs (rule 5: 50 bps of HFS + IRLC when originations exceed $1B in the quarter), the liquidity items
--     excluded for lack of a source (guardrail), retention corporate_7y;
--   upb_positions — non-negative UPB and loan counts, retention corporate_7y;
--   regulatory_filings — 18.7-T8: a Form 1002 is `submitted` only with the WebMB confirmation (submission_evidence) and the
--     CEO/CFO certification record (approved_by_officer_id); a Form 1002A only with the WebMB confirmation (0049's
--     regulatory_filings_submitted_evidence already requires submitted_at + confirmation document + evidence for every
--     filing type); the channel (WebMB is portal-only, shared with Freddie Mac and Ginnie Mae).
BEGIN;

-- ---- eligibility_results: stale flag, state machine, certification record, detection dates, inputs hash, retention ----
ALTER TABLE eligibility_results
  ADD COLUMN stale                     boolean NOT NULL DEFAULT false,
  ADD COLUMN state                     text NOT NULL DEFAULT 'computed',
  ADD COLUMN reason                    text,
  ADD COLUMN inputs_hash               text,
  ADD COLUMN certified_on              date,
  ADD COLUMN certification_document_id uuid REFERENCES documents(id),
  ADD COLUMN warning_detected_on       date,
  ADD COLUMN breach_detected_on        date,
  ADD COLUMN breach_trigger            text,
  ADD COLUMN remediation_plan_document_id uuid REFERENCES documents(id),
  ADD COLUMN remediation_plan_approved_on  date,
  ADD COLUMN retention                 retention_class NOT NULL DEFAULT 'corporate_7y';
-- 0021 let `status = 'stale'` stand in for the flag; the band stays the calculator's, the flag is `stale`.
UPDATE eligibility_results SET stale = true, status = 'warning' WHERE status = 'stale';
ALTER TABLE eligibility_results DROP CONSTRAINT eligibility_results_status_check;
ALTER TABLE eligibility_results ADD CONSTRAINT eligibility_results_status_check CHECK (status IN ('compliant', 'warning', 'breach'));
ALTER TABLE eligibility_results ADD CONSTRAINT eligibility_results_state_check
  CHECK (state IN ('gl_received', 'upb_finalized', 'computed', 'officer_certified', 'form1002_prepared', 'submitted', 'acknowledged', 'reported_to_partner', 'remediation_plan'));
-- 18.7-T7/T8 + guardrail: only a quarter-end, non-stale result carries the officer's certification (the agent never certifies).
ALTER TABLE eligibility_results ADD CONSTRAINT eligibility_results_certification_check
  CHECK (certified_by_officer_id IS NULL
         OR (stale = false AND certified_on IS NOT NULL AND EXTRACT(MONTH FROM period_end) IN (3, 6, 9, 12) AND period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date));
ALTER TABLE eligibility_results ADD CONSTRAINT eligibility_results_certified_state_check
  CHECK (state NOT IN ('officer_certified', 'form1002_prepared', 'submitted', 'acknowledged') OR certified_by_officer_id IS NOT NULL);
-- The ladder's clocks anchor on the detection date; a breach names its trigger (rule 6 flag or a negative surplus / ratio).
ALTER TABLE eligibility_results ADD CONSTRAINT eligibility_results_warning_detection_check CHECK (status <> 'warning' OR warning_detected_on IS NOT NULL);
ALTER TABLE eligibility_results ADD CONSTRAINT eligibility_results_breach_detection_check CHECK (status <> 'breach' OR (breach_detected_on IS NOT NULL AND breach_trigger IS NOT NULL));
ALTER TABLE eligibility_results ADD CONSTRAINT eligibility_results_remediation_check CHECK (state <> 'remediation_plan' OR (remediation_plan_document_id IS NOT NULL AND remediation_plan_approved_on IS NOT NULL));
COMMENT ON TABLE eligibility_results IS '§18.7 quarterly (and monthly) eligibility computation per entity: Adjusted Net Worth vs the $2.5M base + bps of UPB, the 6% ratio, allowable vs required liquidity, the $50B large-servicer buffer, rule-6 decline flags, the status band and the officer certification (ELIG-CERT-Q-v1). Subserviced UPB is excluded from the subservicer''s requirement (A4-1-01; FHFA FAQ #10).';
COMMENT ON COLUMN eligibility_results.status IS '§18.7 status ladder band: compliant → warning (surplus < 25% of the requirement / ANW, liquidity surplus < 25% of the requirement, or a projected next-quarter breach) → breach (surplus < 0, ratio < 6%, or a rule-6 decline trigger).';
COMMENT ON COLUMN eligibility_results.stale IS '§18.7 integrations / 18.7-T7: the GL close for the period was missing at BD5 — computed on the prior close; the quarterly certification cannot proceed.';
COMMENT ON COLUMN eligibility_results.state IS '§18.7 state machine: gl_received → upb_finalized → computed → officer_certified → form1002_prepared → submitted (WebMB) → acknowledged; monthly computed → reported_to_partner; ladder warning → remediation_plan.';
COMMENT ON COLUMN eligibility_results.certified_by_officer_id IS '§18.7 guardrail: certifications are CEO/CFO acts (officer); satisfies FHFA_ELIG_QUARTERLY_TEST as `eligibility.computed{quarter, certified_by_officer_id}`.';
COMMENT ON COLUMN eligibility_results.warning_detected_on IS '§18.7: anchor of SM_ELIG_WARNING_REMEDIATION_30 (board-approved remediation plan within 30 calendar days).';
COMMENT ON COLUMN eligibility_results.breach_detected_on IS '§18.7: anchor of SM_ELIG_BREACH_NOTIFY_1BD (partner + officer within 1 business day; Fannie Mae material adverse change within 5 BD, 18.4).';
COMMENT ON COLUMN eligibility_results.inputs_hash IS '§18.7 decision record `inputs_hash`: sha256 over the hashed GL source documents the run computed on (gl_snapshots.inputs_hash).';

-- ---- gl_snapshots: close receipt, inputs hash, origination-liquidity inputs, excluded items, retention -------------------
ALTER TABLE gl_snapshots
  ADD COLUMN received_on                  date,
  ADD COLUMN inputs_hash                  text,
  ADD COLUMN hfs_and_irlc_cents           bigint NOT NULL DEFAULT 0,
  ADD COLUMN quarterly_originations_over_1b boolean NOT NULL DEFAULT false,
  ADD COLUMN excluded_liquidity           jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN retention                    retention_class NOT NULL DEFAULT 'corporate_7y';
-- Guardrail: every input is a hashed source document — a snapshot without sources is refused at intake.
ALTER TABLE gl_snapshots ADD CONSTRAINT gl_snapshots_sources_check CHECK (cardinality(source_document_ids) > 0);
ALTER TABLE gl_snapshots ADD CONSTRAINT gl_snapshots_nonnegative_check
  CHECK (total_assets_cents >= 0 AND cash_unrestricted_cents >= 0 AND eligible_securities_cents >= 0 AND advance_line_committed_cents >= 0 AND advance_line_drawn_cents >= 0 AND advance_line_drawn_cents <= advance_line_committed_cents AND hfs_and_irlc_cents >= 0);
COMMENT ON TABLE gl_snapshots IS '§18.7 GL close per entity and period (gl adapter, monthly): the Adjusted Net Worth components, the allowable-liquidity inputs as classified on intake (unrestricted cash, eligible securities, committed advance lines — each with a custodial statement / facility agreement source or excluded), the hashed source documents.';
COMMENT ON COLUMN gl_snapshots.received_on IS '§18.7 schedule eligibility.compute.monthly: a close received after BD5 (business_days_fannie_et) leaves the run `stale` (18.7-T7).';
COMMENT ON COLUMN gl_snapshots.excluded_liquidity IS '§18.7 guardrail: items excluded from allowable liquidity for lack of a source, a pledge, a non-investment-grade or non-agency security, or a covenant-breached (committed-but-unavailable) line.';
COMMENT ON COLUMN gl_snapshots.hfs_and_irlc_cents IS '§18.7 rule 5 origination liquidity: 0.5% of loans held for sale + interest-rate lock commitments when originations exceed $1B in the quarter.';

-- ---- upb_positions: non-negative, retention ---------------------------------------------------------------------------
ALTER TABLE upb_positions ADD COLUMN retention retention_class NOT NULL DEFAULT 'corporate_7y';
ALTER TABLE upb_positions ADD CONSTRAINT upb_positions_nonnegative_check CHECK (upb_cents >= 0 AND loan_count >= 0);
COMMENT ON TABLE upb_positions IS '§18.7 month-end UPB by entity and class (Section 5 position, LSDU / Servicing Platform reconciled): ent_ss_sa (7 bps liquidity), ent_aa (3.5 bps), gnma (35 bps net worth / 10 bps liquidity), other, subserviced_for_others (excluded from the subservicer''s requirement, reported to the master monthly by BD5), hfs_and_irlc (origination liquidity).';

-- ---- regulatory_filings: Form 1002 / 1002A submission invariants (18.7-T8), channel --------------------------------------
ALTER TABLE regulatory_filings ADD COLUMN channel text;
ALTER TABLE regulatory_filings ADD CONSTRAINT regulatory_filings_channel_check CHECK (channel IS NULL OR channel IN ('WebMB', 'ECRM', 'email', 'mail', 'portal', 'alternate'));
-- 18.7-T8: the Form 1002 `submitted` transition needs the WebMB confirmation (submission_evidence) and the CEO/CFO certification record (approved_by_officer_id); the 1002A the confirmation.
ALTER TABLE regulatory_filings ADD CONSTRAINT regulatory_filings_form1002_certification
  CHECK (filing_type NOT IN ('form_1002', 'form_1002a') OR status NOT IN ('submitted', 'accepted', 'corrected')
         OR (submission_evidence IS NOT NULL AND (filing_type <> 'form_1002' OR approved_by_officer_id IS NOT NULL)));
COMMENT ON COLUMN regulatory_filings.channel IS '§18.7: Form 1002 / 1002A are submitted through WebMB (portal-only; shared with Freddie Mac and Ginnie Mae) — a human_portal_task; failure → the alternate method WebMB support directs, documented.';
COMMENT ON CONSTRAINT regulatory_filings_form1002_certification ON regulatory_filings IS '18.7-T8: marking the Form 1002 `submitted` without a WebMB confirmation and a CEO/CFO certification record is refused (A4-1-02: certified by the chief executive officer, the chief financial officer, or equivalent).';

COMMIT;
