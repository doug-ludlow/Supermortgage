-- 0026: `timer_definitions` (4.1 data model — the registry rows persisted, including the
-- `business_days_federal` unit) and the `lossmit_facts` view (4.3 — the §1024.40(b)(1) facts per loan).
CREATE TABLE timer_definitions (
  code            text PRIMARY KEY,
  section         int  NOT NULL,
  process         text NOT NULL,
  kind            text NOT NULL,
  trigger_text    text NOT NULL,
  anchor_text     text NOT NULL,
  offset_text     text NOT NULL,
  satisfied_text  text NOT NULL,
  breach_text     text NOT NULL,
  unit            text CHECK (unit IN ('calendar_days', 'business_days_servicer', 'business_days_federal', 'business_days_fannie_et', 'banking_days', 'hours', 'minutes', 'months', 'years', 'evaluator', 'same_day', 'recurring', 'prose')),
  registry_hash   text NOT NULL,                        -- sha256 of spec/registry/timers.json the row came from
  loaded_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE timer_definitions IS 'spec/registry/timers.json persisted; tools/load-timer-definitions.ts loads it. Units: business_days_federal = all days except Saturdays, Sundays and the statutory 5 U.S.C. 6103(a) dates (4.1 rule 2).';

CREATE VIEW lossmit_facts AS
SELECT a.loan_id,
       a.id                       AS application_id,
       a.status                   AS application_status,
       a.received_date,
       a.facially_complete_at,
       a.complete_at,
       a.deemed_complete_date,
       a.reasonable_date,
       a.protection_tier,
       a.foreclosure_sale_date_at_receipt,
       a.first_filing_made_at_receipt,
       a.rule_set,
       (SELECT jsonb_agg(jsonb_build_object('code', r.catalog_code, 'status', r.status)) FROM lossmit_requirements r WHERE r.application_id = a.id) AS requirements,
       (SELECT jsonb_agg(jsonb_build_object('code', t.code, 'status', t.status, 'due_date', t.due_date)) FROM timers t WHERE t.loan_id = a.loan_id AND t.code LIKE 'REGX_1024_41%' AND t.status IN ('armed', 'breached')) AS deadlines
FROM lossmit_applications a
WHERE a.status NOT IN ('closed', 'withdrawn');
COMMENT ON VIEW lossmit_facts IS '4.3 rule 5: everything assigned personnel say about §1024.40(b)(1)(i)–(v) is read from this view at conversation time.';
