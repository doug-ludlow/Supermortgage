-- 0134_du_projections.sql — 23.5 Open question 1, resolved as its default: `application_assets`, `application_liabilities`
-- and `application_reo` (0057, extended by 0081 / 0082) stop being tables and become read projections (VIEWs) over the
-- du_* tables of *_du_graph.sql. One writer, one truth: 22.4's Plaid FAKE settlement (src/runtime/borrower/routes.ts)
-- was the only SQL writer of any of the three, and it now writes through 23.5's `writeDuAsset` (an asset and its owner
-- arcs together, inside the command's transaction); 22.2 / 22.5 / 32.2 keep their own liability records in
-- entity_records (kind application_liabilities) and never inserted a row into the SQL table, and nothing ever wrote
-- application_reo. The readers that remain (src/app/tools/section32-18.ts's DTI sum over application_liabilities; the
-- 32.18 / conversation suites' asset assertions) read the same column names and types they read before.
--
-- The rows that can exist at this point, and what becomes of them:
--   application_assets       written by routes.ts's Plaid settlement only (verified = true, application_borrower_id the
--                            pull's borrower when it resolved, else NULL). Every row is migrated to du_assets under its
--                            OWN id (the foreign keys below keep pointing at it) with identity_key `legacy:<id>` — a key
--                            no re-pull computes, so the next Plaid pull writes its own `p:<borrower>:…` rows beside it
--                            rather than overwriting a row it cannot vouch for — and an owner arc: the row's own
--                            borrower, else the application's Borrower 1 (0133's backfilled ordinal). A row for which
--                            neither exists is retired rather than orphaned (23.5 Edge cases: "any owned row left
--                            ownerless is retired, not orphaned"); the deferred triggers exempt a retired row.
--   application_liabilities  none can exist: no INSERT into it was ever written (grep src apps tools db/*.sh for
--                            "INTO application_liabilities" finds nothing at 0133), and du_liabilities needs exactly one
--                            source row a legacy row could not name. Asserted below rather than assumed.
--   application_reo          none can exist for the same reason; asserted below.
--
-- The foreign keys that referenced the two dropped tables are repointed at du_assets(id) / du_liabilities(id) — a
-- view cannot be a foreign key target, the migrated assets keep their ids, and application_liabilities is empty, so the
-- repointed constraints validate as they are. `application_liabilities.payoff_source_asset_id` goes with its table.
--
-- Column derivations a reader should know (every one deterministic):
--   application_borrower_id  the FIRST owner arc by (created_at, id) — a joint row has two owners and the old column
--                            could name one; readers wanting all of them read du_asset_parties / du_liability_parties.
--   asset_kind               DU AssetType → 0057's vocabulary: CheckingAccount → checking; SavingsAccount,
--                            MoneyMarketFund, CertificateOfDepositTimeDeposit → savings; RetirementFund → retirement;
--                            GIFT_OR_GRANT → gift; the two sale-proceeds types → proceeds_of_sale; everything else → other.
--   verified                 the row names a 22.4 verification (source or last seen), or is a legacy: row (the dropped
--                            table's only writer hard-coded verified = true).
--   balance_cents            cash_or_market_value_cents, 0 for an OWNED_PROPERTY asset (which carries no amount).
--   liability_kind           DU LiabilityType → 0057's: MortgageLoan → mortgage, HELOC → heloc, Installment → installment,
--                            Revolving → revolving, LeasePayment → lease, everything else → other.
--   source                   'reo' when secured by an owned property, 'credit_report' when a 22.2 report is the source,
--                            else 'borrower_stated'.
--   application_reo          one row per live OWNED_PROPERTY asset's du_owned_properties row: address as the jsonb 0057
--                            defined, property_status Retain → retained / Sold → sold / PendingSale → pending_sale,
--                            occupancy from current_usage, mortgage_payment_cents the live secured liabilities' payments.
-- Only live rows (retired_at IS NULL) project; a retired row is excluded from every arc and every count (23.5 State machine).
--
-- src/infra/db/db.test.ts counts BASE TABLEs: three fewer after this file (a view is not a base table).
BEGIN;

-- ─── 1. Nothing to migrate for liabilities and REO — said, and checked ─────────────────────────────────────────────
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM application_liabilities;
  IF n > 0 THEN
    RAISE EXCEPTION 'application_liabilities holds % row(s), but no code path ever inserted one (22.2/22.5/32.2 keep liabilities in entity_records) and a du_liabilities row needs exactly one source (a verification or a credit report) a legacy row cannot name: retire or repoint these rows by hand before applying 0134', n;
  END IF;
  SELECT count(*) INTO n FROM application_reo;
  IF n > 0 THEN
    RAISE EXCEPTION 'application_reo holds % row(s), but no code path ever inserted one: move them onto du_assets{kind=OWNED_PROPERTY} + du_owned_properties by hand before applying 0134', n;
  END IF;
END $$;

-- ─── 2. application_assets → du_assets, same ids, legacy: keys ─────────────────────────────────────────────────────
INSERT INTO du_assets (id, application_id, kind, asset_type, asset_type_other_description, funds_source_type, funds_source_type_other_description, institution_name, account_last4, cash_or_market_value_cents, identity_key, created_at)
SELECT a.id, a.application_id,
       k.kind,
       k.asset_type,
       CASE WHEN k.asset_type = 'Other' THEN 'OtherLiquidAsset' END,
       CASE WHEN k.kind = 'GIFT_OR_GRANT' THEN 'Other' END,
       CASE WHEN k.kind = 'GIFT_OR_GRANT' THEN 'source not recorded (migrated from application_assets)' END,
       CASE WHEN k.kind = 'DEPOSIT_ACCOUNT' THEN left(coalesce(nullif(a.institution, ''), nullif(a.institution_name, ''), 'institution not recorded'), 150) ELSE left(coalesce(nullif(a.institution, ''), nullif(a.institution_name, '')), 150) END,
       CASE WHEN k.kind = 'DEPOSIT_ACCOUNT' THEN a.account_last4 END,
       a.balance_cents,
       'legacy:' || a.id::text,
       a.created_at
  FROM application_assets a
  CROSS JOIN LATERAL (
    SELECT CASE WHEN a.asset_kind IN ('gift', 'gift_of_equity', 'grant', 'employer_assistance') THEN 'GIFT_OR_GRANT'
                WHEN a.asset_kind IN ('checking', 'savings', 'money_market', 'cd', 'retirement', 'brokerage', 'brokerage_stocks_bonds_funds', 'trust', 'life_insurance_cash_value', 'stock_options_vested') THEN 'DEPOSIT_ACCOUNT'
                ELSE 'OTHER_ASSET' END AS kind,
           CASE a.asset_kind WHEN 'checking' THEN 'CheckingAccount' WHEN 'savings' THEN 'SavingsAccount' WHEN 'money_market' THEN 'MoneyMarketFund' WHEN 'cd' THEN 'CertificateOfDepositTimeDeposit'
                             WHEN 'retirement' THEN 'RetirementFund' WHEN 'brokerage' THEN 'Stock' WHEN 'brokerage_stocks_bonds_funds' THEN 'Stock' WHEN 'trust' THEN 'TrustAccount' WHEN 'life_insurance_cash_value' THEN 'LifeInsurance' WHEN 'stock_options_vested' THEN 'StockOptions'
                             WHEN 'gift' THEN 'GiftOfCash' WHEN 'gift_of_equity' THEN 'GiftOfPropertyEquity' WHEN 'grant' THEN 'Grant' WHEN 'employer_assistance' THEN 'Grant'
                             WHEN 'proceeds_of_sale' THEN 'PendingNetSaleProceedsFromRealEstateAssets' WHEN 'cash_on_hand' THEN 'CashOnHand' WHEN 'cash_on_hand_homeready' THEN 'CashOnHand'
                             ELSE 'Other' END AS asset_type
  ) k;

-- The owner arc: the row's own borrower (a borrowing role on the same application), or any borrower 0081's joint list names …
INSERT INTO du_asset_parties (asset_id, application_borrower_id)
SELECT DISTINCT a.id, ab.id
  FROM application_assets a
  JOIN application_borrowers ab ON ab.application_id = a.application_id AND ab.borrower_role IN ('borrower', 'co_borrower', 'non_occupant_co_borrower')
 WHERE ab.id = a.application_borrower_id OR ab.id = ANY (a.borrower_ids);
-- … else the application's Borrower 1 (0133 numbered every borrowing row) …
INSERT INTO du_asset_parties (asset_id, application_borrower_id)
SELECT a.id, ab.id
  FROM application_assets a
  JOIN application_borrowers ab ON ab.application_id = a.application_id AND ab.borrower_ordinal = 1
 WHERE NOT EXISTS (SELECT 1 FROM du_asset_parties p WHERE p.asset_id = a.id);
-- … and a row with neither is retired, not orphaned.
UPDATE du_assets d
   SET retired_at = now()
 WHERE d.identity_key LIKE 'legacy:%'
   AND NOT EXISTS (SELECT 1 FROM du_asset_parties p WHERE p.asset_id = d.id);

-- ─── 3. The foreign keys move onto the tables that now hold the rows ───────────────────────────────────────────────
ALTER TABLE asset_deposits DROP CONSTRAINT asset_deposits_asset_id_fkey, ADD CONSTRAINT asset_deposits_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES du_assets(id);
ALTER TABLE asset_deposits DROP CONSTRAINT asset_deposits_dti_link_liability_id_fkey, ADD CONSTRAINT asset_deposits_dti_link_liability_id_fkey FOREIGN KEY (dti_link_liability_id) REFERENCES du_liabilities(id);
ALTER TABLE gift_records DROP CONSTRAINT gift_records_asset_id_fkey, ADD CONSTRAINT gift_records_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES du_assets(id);
ALTER TABLE debt_payoff_plans DROP CONSTRAINT debt_payoff_plans_funds_source_asset_id_fkey, ADD CONSTRAINT debt_payoff_plans_funds_source_asset_id_fkey FOREIGN KEY (funds_source_asset_id) REFERENCES du_assets(id);
ALTER TABLE debt_payoff_plans DROP CONSTRAINT debt_payoff_plans_liability_id_fkey, ADD CONSTRAINT debt_payoff_plans_liability_id_fkey FOREIGN KEY (liability_id) REFERENCES du_liabilities(id);
ALTER TABLE payoff_demands DROP CONSTRAINT payoff_demands_liability_id_fkey, ADD CONSTRAINT payoff_demands_liability_id_fkey FOREIGN KEY (liability_id) REFERENCES du_liabilities(id);
ALTER TABLE subordinations DROP CONSTRAINT subordinations_liability_id_fkey, ADD CONSTRAINT subordinations_liability_id_fkey FOREIGN KEY (liability_id) REFERENCES du_liabilities(id);
ALTER TABLE inquiry_explanations DROP CONSTRAINT inquiry_explanations_new_liability_id_fkey, ADD CONSTRAINT inquiry_explanations_new_liability_id_fkey FOREIGN KEY (new_liability_id) REFERENCES du_liabilities(id);

-- ─── 4. The tables go … (liabilities first: its payoff_source_asset_id foreign key depends on application_assets) ──
DROP TABLE application_liabilities;
DROP TABLE application_reo;
DROP TABLE application_assets;

-- ─── 5. … and come back as projections ─────────────────────────────────────────────────────────────────────────────
CREATE VIEW application_assets AS
SELECT a.id,
       a.application_id,
       (SELECT p.application_borrower_id FROM du_asset_parties p WHERE p.asset_id = a.id ORDER BY p.created_at, p.id LIMIT 1) AS application_borrower_id,
       (CASE WHEN a.kind = 'GIFT_OR_GRANT' THEN 'gift'
             WHEN a.asset_type = 'CheckingAccount' THEN 'checking'
             WHEN a.asset_type IN ('SavingsAccount', 'MoneyMarketFund', 'CertificateOfDepositTimeDeposit') THEN 'savings'
             WHEN a.asset_type = 'RetirementFund' THEN 'retirement'
             WHEN a.asset_type IN ('PendingNetSaleProceedsFromRealEstateAssets', 'ProceedsFromSaleOfNonRealEstateAsset') THEN 'proceeds_of_sale'
             ELSE 'other' END)::text AS asset_kind,
       a.institution_name AS institution,
       a.account_last4,
       coalesce(a.cash_or_market_value_cents, 0)::bigint AS balance_cents,
       (a.source_verification_id IS NOT NULL OR a.last_seen_verification_id IS NOT NULL OR a.identity_key LIKE 'legacy:%') AS verified,
       a.created_at
  FROM du_assets a
 WHERE a.retired_at IS NULL;
COMMENT ON VIEW application_assets IS '0134: a read projection of du_assets (23.5) in 0057''s columns — live rows only; application_borrower_id is the first owner arc by (created_at, id), asset_kind is the DU AssetType in 0057''s vocabulary, verified means a 22.4 verification is named (or a legacy: row). Writers use 23.5 writeDuAsset.';

CREATE VIEW application_liabilities AS
SELECT l.id,
       l.application_id,
       (SELECT p.application_borrower_id FROM du_liability_parties p WHERE p.liability_id = l.id ORDER BY p.created_at, p.id LIMIT 1) AS application_borrower_id,
       (CASE l.liability_type WHEN 'MortgageLoan' THEN 'mortgage' WHEN 'HELOC' THEN 'heloc' WHEN 'Installment' THEN 'installment' WHEN 'Revolving' THEN 'revolving' WHEN 'LeasePayment' THEN 'lease' ELSE 'other' END)::text AS liability_kind,
       l.creditor_name,
       l.monthly_payment_cents,
       l.unpaid_balance_cents AS balance_cents,
       l.paid_off_at_or_before_closing AS paid_at_closing,
       (CASE WHEN l.secured_by_owned_property_id IS NOT NULL THEN 'reo' WHEN l.source_credit_report_id IS NOT NULL THEN 'credit_report' ELSE 'borrower_stated' END)::text AS source,
       l.created_at
  FROM du_liabilities l
 WHERE l.retired_at IS NULL;
COMMENT ON VIEW application_liabilities IS '0134: a read projection of du_liabilities (23.5) in 0057''s columns — live rows only; application_borrower_id is the first obligor arc by (created_at, id). Writers use 23.5 writeDuLiability.';

CREATE VIEW application_reo AS
SELECT o.id,
       o.application_id,
       (SELECT p.application_borrower_id FROM du_asset_parties p WHERE p.asset_id = o.asset_id ORDER BY p.created_at, p.id LIMIT 1) AS application_borrower_id,
       jsonb_strip_nulls(jsonb_build_object('line1', o.address_line_text, 'line2', o.address_unit, 'city', o.city_name, 'state', o.state_code, 'postal_code', o.postal_code, 'country', o.country_code)) AS address,
       (CASE o.disposition WHEN 'Retain' THEN 'retained' WHEN 'Sold' THEN 'sold' ELSE 'pending_sale' END)::text AS property_status,
       (CASE o.current_usage WHEN 'PrimaryResidence' THEN 'primary' WHEN 'SecondHome' THEN 'second_home' WHEN 'Investment' THEN 'investment' END)::occupancy_type AS occupancy,
       o.market_value_cents,
       coalesce((SELECT sum(l.monthly_payment_cents) FROM du_liabilities l WHERE l.secured_by_owned_property_id = o.id AND l.retired_at IS NULL), 0)::bigint AS mortgage_payment_cents,
       coalesce(o.monthly_rental_income_cents, 0)::bigint AS rental_income_cents,
       o.created_at
  FROM du_owned_properties o
  JOIN du_assets a ON a.id = o.asset_id
 WHERE a.retired_at IS NULL;
COMMENT ON VIEW application_reo IS '0134: a read projection of du_owned_properties (23.5 URLA 3a) in 0057''s columns — one row per live OWNED_PROPERTY asset; mortgage_payment_cents is the live secured liabilities'' payments. Writers use 23.5 writeDuOwnedProperty.';

COMMIT;
