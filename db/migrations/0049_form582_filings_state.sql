-- 0049: §18.4 data-model corrections on the Form 582 tables created by 0021 (append-only: 0021 is applied, so the
-- changes are ALTERs and COMMENTs here — no new table).
--   regulatory_filings.status — the spec's state machine `open → data_assembled → registry_verified (Supermortgage QC)
--     → partner_delivered (for partner filings) → officer_review → submitted (ECRM) → accepted | corrected`, and for the
--     org-change / technology-provider notices `detected → classified → drafted → officer_approved → filed → acknowledged`
--     (0021 defaulted to 'draft' with no CHECK — a state ops-18-4.ts FORM582_STATES never writes); the `late` flag "when
--     past due_at"; 18.4-T7: no row is `submitted` (or beyond) without the ECRM confirmation document, and no Form 582
--     without the officer's approval record — the agent cannot certify or submit (baseline §8 item 3);
--   subservicing_arrangements — the typed master/sub Fannie Mae servicer numbers the Subservicing screen lists (rule 2,
--     18.4-T8) beside 0021's fnma_servicer_numbers array, and the 1.2 status set;
--   corporate_insurance_policies — is the spec's `insurance_policies` registry: that name is Section 9's borrower
--     hazard-policy table (0011_insurance.sql), so the corporate fidelity/E&O/cyber registry keeps the `corporate_`
--     prefix; A3-5-01 loss payee and the A3-5-02 deductible rule are documented on the columns; expiry after effect;
--   pending_actions — the second evidence pointer: FNMA_A4102_ORG_CHANGE_5BD is satisfied only when the Pending
--     Actions update AND the mailbox email are both evidenced (`org_change.notice.filed`), so the row keeps both;
--   fiscal_years — the auditor's AFS delivery commitment ≥ 15 days before the Fannie Mae deadline (FYE + 75);
--   org_registry — effective-dated history and the 0–100% ownership range;
--   retention corporate_7y on every 18.4 table that lacked it (data-model bullet "Retention corporate_7y").
BEGIN;

-- ---- regulatory_filings: state machine, late flag, ECRM confirmation / officer approval invariants ---------------------
UPDATE regulatory_filings SET status = 'open' WHERE status = 'draft';
ALTER TABLE regulatory_filings ALTER COLUMN status SET DEFAULT 'open';
ALTER TABLE regulatory_filings ADD CONSTRAINT regulatory_filings_status_check
  CHECK (CASE WHEN filing_type IN ('org_change_notice', 'tech_provider_notice')
              THEN status IN ('detected', 'classified', 'drafted', 'officer_approved', 'filed', 'acknowledged')
              ELSE status IN ('open', 'data_assembled', 'registry_verified', 'partner_delivered', 'officer_review', 'submitted', 'accepted', 'corrected') END);
ALTER TABLE regulatory_filings ADD COLUMN late boolean NOT NULL DEFAULT false;
ALTER TABLE regulatory_filings ADD CONSTRAINT regulatory_filings_late_check CHECK (late = false OR submitted_at IS NOT NULL);
-- 18.4-T7: submitted (ECRM) only with the confirmation captured to documents; a Form 582 only with the officer's approval record
ALTER TABLE regulatory_filings ADD CONSTRAINT regulatory_filings_submitted_evidence
  CHECK (status NOT IN ('submitted', 'accepted', 'corrected') OR (submitted_at IS NOT NULL AND confirmation_document_id IS NOT NULL AND submission_evidence IS NOT NULL));
ALTER TABLE regulatory_filings ADD CONSTRAINT regulatory_filings_form582_officer_approval
  CHECK (filing_type <> 'form_582' OR status NOT IN ('submitted', 'accepted', 'corrected') OR approved_by_officer_id IS NOT NULL);
-- partner_delivered is a partner-filing state
ALTER TABLE regulatory_filings ADD CONSTRAINT regulatory_filings_partner_delivered_check CHECK (status <> 'partner_delivered' OR entity = 'partner');
COMMENT ON TABLE regulatory_filings IS '§18.4 regulatory filings per entity (Form 582, AFS, Form 1002/1002A/1001, ISBR attestation, Form 183, cap/liq plan, org-change and technology-provider notices, Reg AB 1122/1123, SOC 1): due_at, data snapshot, agent run, officer approval, ECRM submission evidence; status follows the §18.4 state machine.';
COMMENT ON COLUMN regulatory_filings.status IS '§18.4 state machine: open → data_assembled → registry_verified → partner_delivered (partner filings) → officer_review → submitted (ECRM) → accepted | corrected; notices: detected → classified → drafted → officer_approved → filed (Pending Actions + email) → acknowledged.';
COMMENT ON COLUMN regulatory_filings.late IS '§18.4 state machine: `late` flag when submitted past due_at (rule 1: due_at = FYE + 90 calendar days, no business-day roll; FYE 2026-12-31 → 2027-03-31).';
COMMENT ON COLUMN regulatory_filings.confirmation_document_id IS '18.4-T7: the ECRM submission confirmation captured to documents by the designated submitter (FORM582_BUSINESS_ROLE) — without it the transition to submitted is refused; the agent never takes it.';
COMMENT ON COLUMN regulatory_filings.approved_by_officer_id IS '§18.4 rule 6: the officer certifies from the console after reviewing the diff; the ECRM human_portal_task carries this approval record.';

-- ---- subservicing_arrangements: the servicer-number pair the Subservicing screen lists, the 1.2 status set -------------
ALTER TABLE subservicing_arrangements
  ADD COLUMN master_servicer_number text,
  ADD COLUMN sub_servicer_number    text,
  ADD COLUMN retention              retention_class NOT NULL DEFAULT 'corporate_7y';
ALTER TABLE subservicing_arrangements ADD CONSTRAINT subservicing_arrangements_status_check CHECK (status IN ('active', 'terminated'));
ALTER TABLE subservicing_arrangements ADD CONSTRAINT subservicing_arrangements_counts_check CHECK ((loan_count IS NULL OR loan_count >= 0) AND (upb_cents IS NULL OR upb_cents >= 0));
COMMENT ON TABLE subservicing_arrangements IS '§18.4 data model (from 1.2): master/sub entities, Fannie Mae servicer numbers, FYE loan count and UPB (reconciled to the Section 5 position), Form 101 / Form 629 references, status — the Subservicing screen of both Form 582s (A2-1-07: the master servicer confirms its subservicing arrangements annually).';
COMMENT ON COLUMN subservicing_arrangements.master_servicer_number IS '§18.4 rule 2 / 18.4-T8: the master''s Fannie Mae servicer number Supermortgage lists under "subservice for others = YES".';
COMMENT ON COLUMN subservicing_arrangements.sub_servicer_number IS '§18.4 rule 2: Supermortgage''s Fannie Mae servicer number the partner lists under "use a subservicer = YES".';
COMMENT ON COLUMN subservicing_arrangements.fnma_servicer_numbers IS '§18.4 data model `fnma_servicer_numbers`: all servicer numbers on the arrangement; the typed pair master_servicer_number / sub_servicer_number is what the Subservicing screen lists.';

-- ---- corporate_insurance_policies: the spec's `insurance_policies` registry --------------------------------------------
ALTER TABLE corporate_insurance_policies ADD COLUMN retention retention_class NOT NULL DEFAULT 'corporate_7y';
ALTER TABLE corporate_insurance_policies ADD CONSTRAINT corporate_insurance_policies_term_check CHECK (expires_on > effective_on);
ALTER TABLE corporate_insurance_policies ADD CONSTRAINT corporate_insurance_policies_amounts_check CHECK (coverage_cents >= 0 AND deductible_cents >= 0);
COMMENT ON TABLE corporate_insurance_policies IS '§18.4 data model `insurance_policies` — the corporate fidelity bond / E&O / cyber registry (entity, kind, carrier, coverage_cents, deductible_cents, effective/expires, fnma_loss_payee, document_id). Named with the corporate_ prefix because `insurance_policies` is Section 9''s borrower hazard-policy table (0011_insurance.sql). A3-5-01/02/03; FNMA_A3501_INSURANCE_EXPIRY_30 arms on expires_on − 30 (18.4-T4).';
COMMENT ON COLUMN corporate_insurance_policies.fnma_loss_payee IS 'A3-5-01: fidelity bond and E&O policies name Fannie Mae as loss payee — the consistency check insurance_fnma_loss_payee (ops-18-4.ts) blocks officer_review while false.';
COMMENT ON COLUMN corporate_insurance_policies.deductible_cents IS 'A3-5-02/03: deductible ≤ the higher of 10% / $100,000 (basis ≤ $100M) or 15% (basis > $100M) of the required coverage (insuranceWorksheet.max_deductible_cents; $5B UPB → $828,750).';
COMMENT ON COLUMN corporate_insurance_policies.coverage_cents IS 'A3-5-02: required fidelity = $300,000 up to $100M + 0.150% of the next $400M + 0.125% of the next $500M + 0.100% above $1B, cap $150M ($5B UPB → $5,525,000); E&O equal, capped $10M SF / $30M SF + multifamily.';

-- ---- pending_actions: both evidence pointers; fiscal_years: the auditor commitment; org_registry: history ---------------
ALTER TABLE pending_actions
  ADD COLUMN email_evidence_document_id uuid REFERENCES documents(id),
  ADD COLUMN retention                  retention_class NOT NULL DEFAULT 'corporate_7y';
ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_due_check CHECK (fnma_due_at >= occurred_at AND (partner_due_at IS NULL OR partner_due_at >= occurred_at));
COMMENT ON TABLE pending_actions IS '§18.4 A4-1-02 material changes: reported via the Pending Actions section of Form 582 and an email to the Changes in Lender Organization mailbox within five business_days_fannie_et of the occurrence (18.4-T2: Tue 2026-11-10 → 2026-11-18, Veterans Day excluded; internal target day 4).';
COMMENT ON COLUMN pending_actions.document_id IS '§18.4: evidence of the Pending Actions update in Form 582 (one of the two pointers FNMA_A4102_ORG_CHANGE_5BD waits for).';
COMMENT ON COLUMN pending_actions.email_evidence_document_id IS '§18.4: sent-mail evidence of the Changes in Lender Organization mailbox email — the clock closes only with both this and document_id.';
ALTER TABLE fiscal_years ADD COLUMN retention retention_class NOT NULL DEFAULT 'corporate_7y';
ALTER TABLE fiscal_years ADD CONSTRAINT fiscal_years_afs_commitment_check CHECK (afs_expected_at IS NULL OR afs_expected_at <= fye_date + 75);
COMMENT ON TABLE fiscal_years IS '§18.4 fiscal-year registry for both entities: FYE dates, auditor engagement, AFS delivery commitment (≥ 15 days before the Fannie Mae deadline, i.e. ≤ FYE + 75 — SM_AFS_AUDITOR_DELIVERY_FYE_75); a short year still carries a 90-day clock.';
ALTER TABLE org_registry ADD COLUMN retention retention_class NOT NULL DEFAULT 'corporate_7y';
ALTER TABLE org_registry ADD CONSTRAINT org_registry_effective_check CHECK (effective_to IS NULL OR effective_to >= effective_from);
ALTER TABLE org_registry ADD CONSTRAINT org_registry_ownership_check CHECK (ownership_pct_bps IS NULL OR (ownership_pct_bps >= 0 AND ownership_pct_bps <= 10000));
COMMENT ON TABLE org_registry IS '§18.4 data model: officers, directors and owners (≥ 5% = 500 bps triggers A4-1-03 prior approval) with effective-dated history and PII-encrypted contact; a write covered by an open FNMA_A4103_MAJOR_CHANGE_ADVANCE_60 gate is refused in the platform''s own records (ops-18-4.ts platformRecordWrite).';
ALTER TABLE vendor_registry ADD COLUMN retention retention_class NOT NULL DEFAULT 'corporate_7y';

COMMIT;
