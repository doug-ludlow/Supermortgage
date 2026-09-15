-- 0143 — 35.5 rule 9 FAKE seeds (every build stage; replaced by the licensing workstream's go-live values through
-- `servicer_profile.write{op: activate}` by `compliance`, never by editing these rows):
--   jurisdiction_rules      the 50 states + DC (0002:135 declared the table; empty at HEAD). `licensed` = the platform's
--                           DEFAULT_LICENSED_STATES (src/runtime/transfers.ts); `rules.nsf_fee` and `rules.late_charge` are the
--                           2.7 rule 7 / lateChargeTerms inputs. FAKE defaults: 5.000% / 15 days everywhere except NY 2.000%
--                           (NY RPL §254-b — [UNVERIFIED state table, as 2.7-T9 records]) and NC 4.000%; NSF allowed, cap 2,500¢.
--   payment_requirements    SM-PR-v1, the written Reg Z §1026.36(c)(1)(iii) requirements version the channels cite.
--   payment_channels        lockbox (17:00 America/Chicago — worked example E), ach_debit_origin and portal_onetime (23:59 ET).
--   parties                 the platform's own servicing party (party_type servicer, legal_name 'Supermortgage LLC', no servicer
--                           number — transfers.ts:101 keys the per-partner servicer rows named "Supermortgage" by servicer number).
--   servicer_profiles       version 1 = the former SERVICER_CONTACT constant (src/runtime/servicing.ts:46 at HEAD): the authored
--                           samples' values, status active from 2020-01-01, so no rendered text changes until v2 is activated.
-- Every INSERT is idempotent (ON CONFLICT DO NOTHING / WHERE NOT EXISTS) — a database seeded by an earlier build keeps its rows.
BEGIN;

-- ───────────────────────────── jurisdiction_rules: 50 states + DC ─────────────────────────────
INSERT INTO jurisdiction_rules (state, licensed, rules)
SELECT s.state,
       s.state IN ('TX', 'CA', 'FL', 'NY', 'IL', 'OH', 'PA', 'GA', 'NC', 'AZ', 'WA', 'CO', 'MN', 'NJ', 'MD'),
       jsonb_build_object(
         'nsf_fee', jsonb_build_object('allowed', true, 'cap_cents', 2500),
         'late_charge', jsonb_build_object('max_pct', CASE s.state WHEN 'NY' THEN '2.000' WHEN 'NC' THEN '4.000' ELSE '5.000' END, 'min_grace_days', 15),
         'fake', true)
FROM unnest(ARRAY['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']) AS s(state)
ON CONFLICT (state) DO NOTHING;

-- ───────────────────────────── payment requirements and channels (0003:70-83) ─────────────────────────────
INSERT INTO payment_requirements (version, effective_from, text)
VALUES ('SM-PR-v1', '2020-01-01', 'Payments are credited as of the day of receipt when made by 5:00 p.m. local time at the lockbox address on your statement (checks and money orders), by 11:59 p.m. Eastern in the portal, or on the settlement date of an authorized ACH debit. Payments sent elsewhere may be credited up to five days late. Reg Z 12 CFR 1026.36(c)(1)(iii) written requirements, version SM-PR-v1 (FAKE).')
ON CONFLICT (version) DO NOTHING;

INSERT INTO payment_channels (channel, cutoff_time, cutoff_tz, requirements_version, conforming_rules) VALUES
  ('lockbox',          '17:00', 'America/Chicago',  'SM-PR-v1', '{"instruments": ["check", "money_order", "cashiers_check"], "fake_lockbox_id": "LBX-1"}'),
  ('ach_debit_origin', '23:59', 'America/New_York', 'SM-PR-v1', '{"received_on": "settlement_date"}'),
  ('portal_onetime',   '23:59', 'America/New_York', 'SM-PR-v1', '{"instruments": ["ach", "card_debit"]}')
ON CONFLICT (channel) DO NOTHING;

-- ───────────────────────────── the platform's own servicing party ─────────────────────────────
INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact)
SELECT 'servicer', 'Supermortgage LLC', NULL, NULL, '{"fake": true}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM parties WHERE party_type = 'servicer' AND legal_name = 'Supermortgage LLC' AND servicer_number IS NULL);

-- ───────────────────────────── servicer_profiles v1 = the former SERVICER_CONTACT ─────────────────────────────
INSERT INTO servicer_profiles (servicing_party_id, version, effective_from, effective_to, legal_name, dba, nmls_id, tin, toll_free_phone, servicer_address, exclusive_address, remittance_address, payment_requirements_version, portal_url, counselor_url, hud_phone, hours, languages, status)
SELECT p.id, 1, '2020-01-01', NULL, 'Supermortgage LLC', NULL, 'FAKE-000000', '12-3456789', '(800) 555-0100', 'PO Box 1, Testville TX 75001', 'PO Box 2, Testville TX 75001', 'Supermortgage, PO Box 7, Testville TX 75001', 'SM-PR-v1',
       'https://portal.example.com/statements', 'consumerfinance.gov/find-a-housing-counselor', '(800) 569-4287', 'Mon-Fri 08:00-20:00 ET', ARRAY['en', 'es'], 'active'
FROM parties p
WHERE p.party_type = 'servicer' AND p.legal_name = 'Supermortgage LLC' AND p.servicer_number IS NULL
  AND NOT EXISTS (SELECT 1 FROM servicer_profiles sp WHERE sp.servicing_party_id = p.id AND sp.version = 1)
ORDER BY p.created_at LIMIT 1;

COMMIT;
