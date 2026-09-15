-- 0127_du_graph.sql — 23.5 The relationship graph and the modeled set: what a DU submission is assembled from
-- (spec/sections/23-desktop-underwriter-and-the-credit-decision/23-5-the-relationship-graph-and-the-modeled-set.md "Data model").
--
-- Desktop Underwriter receives a flat set of labelled containers plus a RELATIONSHIPS block whose RELATIONSHIP elements
-- arc between labels by arcrole URI. This migration makes `applications` (0057) able to answer every arc DU can ask for:
-- who owns each asset, liability and expense (join tables — many-to-many, never zero owners, held at COMMIT by deferred
-- constraint triggers); which asset secures which liability (a nullable FK on the liability, because no sample shows one
-- liability secured by two properties while one property with two liens is ordinary); which income item belongs to which
-- employer (`application_income.employer_id`, with `employment_income` bound to it by CHECK so the indicator and the arc
-- cannot disagree); which borrowers share a credit report (a directed self-loop table); which borrower position each
-- party holds (`application_borrowers.borrower_ordinal`, 1..4, allocated under a row lock on the application); the
-- borrower's own answers to the fourteen URLA section 5 declarations (asked, never derived: only the borrower's own
-- kernel Actor may assert them); and a residence history with a stated housing basis.
--
-- Ported from Homestead-Mortgages' six migrations (the_declaration_is_asked, housing_basis_has_one_home,
-- an_asset_has_an_owner, an_owner_is_a_borrowing_party, four_borrowers_in_order, du_mints_its_own_casefile) under the
-- name mapping the hand-off script binds: application_parties → application_borrowers (`borrower_role` ∈ {borrower,
-- co_borrower, non_occupant_co_borrower} is a borrowing role; non_borrowing_spouse and trustee are not); principals →
-- the kernel Actor {kind, id, role} held as jsonb; connector_snapshots → verifications (0081) for a 22.4 pull and
-- credit_reports (0079) for a 22.2 pull; the Du* Prisma enums → text + CHECK (… IN (…)) with the DU data point named in
-- the column comment as `DU <DataPointName>` — the convention tools/build-du.mjs reads (`npm run du:verify` diffs every
-- such list against DU_ENUMERATIONS, and the three per-kind AssetType CHECKs against the URLA partition); DateTime →
-- timestamptz; BigInt → bigint cents. Every refusal raises ERRCODE check_violation with the code first in MESSAGE
-- (DU_GRAPH_ORPHAN, DU_GRAPH_CROSSES_APPLICATIONS, DU_DECLARATION_NOT_SELF_ATTESTED, DU_CASEFILE_ID_WRITE_ONCE and the
-- section's own DU_GRAPH_* / DU_DECLARATION_* / DU_RESIDENCE_* / DU_JOINT_CREDIT_* codes) so the unit of work can
-- surface it.
--
-- `application_assets`, `application_liabilities` and `application_reo` (0057) stay tables in this migration: 22.4's
-- writers move onto the du_* tables in the next phase and turn them into projections then (23.5 Open question 1).
-- Retention: every row carries `retention_class` = fnma_loan_file_life_plus_4y (0059), the loan file's own class.
BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. The employer, and the income item that names it (rule 2: the employer arc is derived, not stored twice)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0080's employment_verifications is a per-verification evidence record (append-only, one row per VOE call) with the
-- employer's name as text — not an entity two pulls can agree on. `CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER` (53 of
-- the corpus's 349 arcs) needs a row with an identity, so `employers` is new. The identity rules are Homestead's
-- (identity.ts): `ein:<digits>` when a vendor gave one, `name:<normalized>` otherwise; `name_key` is the name form the row
-- would have had with no EIN, written once, so a payroll pull that promotes the key to `ein:` and a bank pull that only
-- knows the name still find one row for one job. Phase 4's 22.3 writer populates it.
CREATE TABLE employers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  application_borrower_id     uuid NOT NULL REFERENCES application_borrowers(id) ON DELETE CASCADE,
  identity_key                text NOT NULL,                                    -- ein:<digits> | name:<normalized>
  derived_from                text NOT NULL CHECK (derived_from IN ('ein', 'name')),
  name_key                    text NOT NULL,                                    -- the name: form, written once
  ein                         text,
  display_name                text NOT NULL,
  address_line_text           text,
  address_unit                text,
  city_name                   text,
  state_code                  char(2),
  postal_code                 text,
  country_code                char(2),
  phone                       text,
  first_seen_verification_id  uuid REFERENCES verifications(verification_id) ON DELETE SET NULL,
  retention_class             retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employers_identity_key_is_prefixed CHECK ((derived_from = 'ein') = (identity_key LIKE 'ein:%')),
  CONSTRAINT employers_name_key_is_a_name CHECK (name_key LIKE 'name:%'),
  CONSTRAINT employers_display_name_fits_the_wire CHECK (char_length(display_name) BETWEEN 1 AND 150),
  CONSTRAINT employers_postal_code_has_no_dash CHECK (postal_code IS NULL OR postal_code ~ '^([0-9]{5}|[0-9]{9})$')
);
CREATE UNIQUE INDEX employers_borrower_identity_key ON employers(application_borrower_id, identity_key);
CREATE INDEX employers_app_idx ON employers(application_id);
-- Not unique: two EINs filed under one trade name are two employers sharing a name key.
CREATE INDEX employers_borrower_name_key_idx ON employers(application_borrower_id, name_key);
COMMENT ON TABLE employers IS '23.5: the EMPLOYER container, one row per employer per borrower per application. identity_key is ein:<digits> when a vendor gave one, name:<normalized> otherwise (Homestead identity.ts); application_income.employer_id is the CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER arc.';
COMMENT ON COLUMN employers.display_name IS 'pii. EMPLOYER/LEGAL_ENTITY/LEGAL_ENTITY_DETAIL/FullName, String 150.';

-- ON DELETE RESTRICT, not SET NULL: the CHECK below binds employment_income to the presence of the employer, so a
-- referential SET NULL on an employment_income = true row would violate it from inside the RI trigger — a
-- check_violation on application_income, a table the deleter never touched, naming neither the employer nor whoever
-- was removing it (Homestead hit exactly this and moved the edge to RESTRICT). With RESTRICT the deleter sees the
-- foreign key. The way out is REPOINT, not retirement: whoever merges two employer rows (22.3's writer, Phase 4)
-- updates every application_income.employer_id naming the loser onto the survivor in the same transaction, and only
-- then deletes the loser. A borrower delete (19.x) reaches the same edge through employers.application_borrower_id
-- ON DELETE CASCADE and is refused while the borrower's income still names the employer — the income goes first.
ALTER TABLE application_income ADD COLUMN employer_id uuid REFERENCES employers(id) ON DELETE RESTRICT;
ALTER TABLE application_income ADD COLUMN employment_income boolean NOT NULL DEFAULT false;
-- The indicator DU reads (EmploymentIncomeIndicator) and the arc DU reads are one fact.
ALTER TABLE application_income ADD CONSTRAINT application_income_employment_income_names_an_employer CHECK (employment_income = (employer_id IS NOT NULL));
CREATE INDEX application_income_employer_idx ON application_income(employer_id) WHERE employer_id IS NOT NULL;
COMMENT ON COLUMN application_income.employer_id IS '23.5 rule 2: the employer this item is earned from; the CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER arc. employment_income = (employer_id IS NOT NULL) by CHECK.';

-- An income item's employer is on the same application and the same borrower: an arc across two applications names a
-- label the document does not contain, and the XSD accepts that silently.
CREATE OR REPLACE FUNCTION application_income_employer_stays_inside_the_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e_app uuid; e_ab uuid;
BEGIN
  IF NEW.employer_id IS NULL THEN RETURN NEW; END IF;
  SELECT application_id, application_borrower_id INTO e_app, e_ab FROM employers WHERE id = NEW.employer_id;
  IF e_app IS DISTINCT FROM NEW.application_id OR e_ab IS DISTINCT FROM NEW.application_borrower_id THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_GRAPH_CROSSES_APPLICATIONS: income item %s (application %s, borrower %s) names employer %s on application %s, borrower %s; an arc across two applications points at a label this document does not contain', NEW.id, NEW.application_id, NEW.application_borrower_id, NEW.employer_id, e_app, e_ab);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_income_employer_stays_inside_the_application BEFORE INSERT OR UPDATE OF employer_id, application_id, application_borrower_id ON application_income FOR EACH ROW EXECUTE FUNCTION application_income_employer_stays_inside_the_application();

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Four borrowers, in order (rule 6): application_borrowers.borrower_ordinal
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- BORROWER is 1:4 and DU conveys Borrower 1 through 4 by document order and label ordinal; no element states the
-- position. A POSITION in one submitted document, not an identity — application_borrowers.id is the identity — which is
-- why a freed ordinal is reused and the survivors are never renumbered.
ALTER TABLE application_borrowers ADD COLUMN borrower_ordinal int;

-- Backfilled BEFORE the constraints, which are not satisfiable without it: every borrowing row in the table carries a
-- NULL ordinal and no application has a Borrower 1. The `borrower` role (0057's primary applicant) is Borrower 1 and
-- the rest follow in the order they joined — role FIRST, because every application PgApplicationRepository.create
-- opened inserted all of its borrowers in one transaction, so their created_at values are one value (now() is the
-- transaction's start) and a (created_at, id) order alone would let the co-borrower's uuid decide who Borrower 1 is
-- in about half of every existing multi-borrower file. Homestead's backfill sorted the primary first for the same reason.
UPDATE application_borrowers ab
   SET borrower_ordinal = o.n
  FROM (SELECT id, row_number() OVER (PARTITION BY application_id ORDER BY (borrower_role <> 'borrower'), created_at, id) AS n
          FROM application_borrowers
         WHERE borrower_role IN ('borrower', 'co_borrower', 'non_occupant_co_borrower')) o
 WHERE ab.id = o.id;

-- An application already holding five borrowing parties took a 5 from the backfill; say which rather than let the CHECK
-- refuse the migration with a message naming no row.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT application_id::text, ', ') INTO bad FROM application_borrowers WHERE borrower_ordinal > 4;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'BORROWER is 1:4 and these applications have more borrowing parties: %', bad;
  END IF;
END $$;

ALTER TABLE application_borrowers
  ADD CONSTRAINT application_borrowers_borrower_ordinal_is_one_to_four CHECK (borrower_ordinal IS NULL OR borrower_ordinal BETWEEN 1 AND 4),
  -- Both directions: a non-borrowing role emits no BORROWER element and has no position; a borrowing role MUST have one,
  -- because the label allocator and LOAN_DETAIL/BorrowerCount read it.
  ADD CONSTRAINT application_borrowers_borrowers_are_numbered CHECK ((borrower_role IN ('borrower', 'co_borrower', 'non_occupant_co_borrower')) = (borrower_ordinal IS NOT NULL));

-- Exactly one Borrower 1 — created BEFORE the general index so a second Borrower 1 is reported as that rule rather than
-- as a position collision that could have been any of the four (Postgres walks the indexes in OID order).
CREATE UNIQUE INDEX application_borrowers_one_first_borrower ON application_borrowers(application_id) WHERE borrower_ordinal = 1;
CREATE UNIQUE INDEX application_borrowers_one_party_per_ordinal ON application_borrowers(application_id, borrower_ordinal) WHERE borrower_ordinal IS NOT NULL;

-- The allocator (rule 6): position 1 belongs to the `borrower` role — the primary applicant every route opens an
-- application with — and the other borrowing roles take the smallest free position from 2, so which row is Borrower 1
-- does not depend on insert order (a refinance copies the prior application's borrowers in (created_at, id) order,
-- which a same-transaction tie leaves to the uuid). Under a row lock on the application, so two concurrent appends
-- cannot take the same position. FOR NO KEY UPDATE and not FOR UPDATE: the allocator must conflict with itself and
-- nothing else. Every foreign key that names applications(id) — loan_events.application_id, which PgUnitOfWork
-- writes BEFORE the command's deferred `commit` hook inserts the borrower — holds FOR KEY SHARE on the row, and FOR
-- UPDATE conflicts with KEY SHARE: two concurrent appends inside two commands on one application deadlocked, and any
-- append waited behind every open command that merely referenced the application. NO KEY UPDATE conflicts with NO
-- KEY UPDATE (concurrent allocators still serialize) and not with KEY SHARE.
-- Homestead allocated in its writer; here every existing writer (0057's PgApplicationRepository.create, 32.2's
-- invite) inserts a borrowing row with no ordinal, and a constraint whose only satisfier is a writer that does not
-- exist yet is a constraint that breaks every intake — so the allocation is the database's. A caller may still state
-- a position; the unique index refuses a collision. When no position is free the row is handed 5 and the CHECK above
-- refuses it: a fifth borrower is a CHECK violation, DU permits four.
CREATE OR REPLACE FUNCTION application_borrowers_allocate_ordinal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE taken int[]; n int;
BEGIN
  IF NEW.borrower_role NOT IN ('borrower', 'co_borrower', 'non_occupant_co_borrower') THEN
    NEW.borrower_ordinal := NULL;                     -- a non-borrowing role holds no position (freed on a demotion)
    RETURN NEW;
  END IF;
  IF NEW.borrower_ordinal IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM applications WHERE id = NEW.application_id FOR NO KEY UPDATE;
  SELECT coalesce(array_agg(borrower_ordinal), '{}') INTO taken
    FROM application_borrowers WHERE application_id = NEW.application_id AND borrower_ordinal IS NOT NULL AND id <> NEW.id;
  n := CASE WHEN NEW.borrower_role = 'borrower' THEN 1 ELSE 2 END;   -- Borrower 1 is the `borrower` role, whenever it arrives
  WHILE n <= 4 AND n = ANY (taken) LOOP n := n + 1; END LOOP;
  NEW.borrower_ordinal := n;
  RETURN NEW;
END $$;
CREATE TRIGGER application_borrowers_allocate_ordinal_write BEFORE INSERT OR UPDATE OF borrower_role ON application_borrowers FOR EACH ROW EXECUTE FUNCTION application_borrowers_allocate_ordinal();
COMMENT ON COLUMN application_borrowers.borrower_ordinal IS '23.5 rule 6: DU Borrower 1..4, the LOAN_IsAssociatedWith_ROLE position. NOT NULL for a borrowing role (borrower, co_borrower, non_occupant_co_borrower), NULL for non_borrowing_spouse and trustee. Position 1 is the `borrower` role''s; the other borrowing roles are allocated the smallest free position from 2, under a FOR NO KEY UPDATE row lock on the application; a freed ordinal is reused and the survivors are never renumbered.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. DU mints its own casefile identifier: applications.du_casefile_id, write-once
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- AutomatedUnderwritingCaseIdentifier is a String 30 that DU MINTS — it comes back on the first response and every
-- resubmission must carry it. Unique where not null: two credit requests sharing one casefile is the confusion this
-- column exists to prevent, and it does not become acceptable because DU assigned it.
ALTER TABLE applications ADD COLUMN du_casefile_id varchar(30) CHECK (du_casefile_id IS NULL OR char_length(du_casefile_id) BETWEEN 1 AND 30);
CREATE UNIQUE INDEX applications_du_casefile_id_key ON applications(du_casefile_id) WHERE du_casefile_id IS NOT NULL;

-- Rewriting the SAME value is a no-op (a resubmission that stores what it already stored is an ordinary retry);
-- a different value, or clearing it, raises — overwriting silently starts a second case at Fannie Mae while our own
-- records still say one, and clearing loses the only handle we have on the first.
CREATE OR REPLACE FUNCTION applications_du_casefile_is_write_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.du_casefile_id IS NOT NULL AND NEW.du_casefile_id IS DISTINCT FROM OLD.du_casefile_id THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_CASEFILE_ID_WRITE_ONCE: application %s already carries DU casefile %s; a resubmission carries the case DU named, and a new case is a new application', OLD.id, OLD.du_casefile_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER applications_du_casefile_is_write_once_update BEFORE UPDATE OF du_casefile_id ON applications FOR EACH ROW EXECUTE FUNCTION applications_du_casefile_is_write_once();
COMMENT ON COLUMN applications.du_casefile_id IS '23.5: AutomatedUnderwritingCaseIdentifier, minted by DU and returned on the first response (23.7 writes it from the FAKE ack). Write-once: the same value again is a no-op, a different value raises DU_CASEFILE_ID_WRITE_ONCE. Null until a submission has been answered.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. The DEAL-level rows: du_assets, du_owned_properties, du_liabilities, du_expenses
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- All four hang off the APPLICATION. DEAL/ASSETS/ASSET is a sibling of PARTIES on the wire, and whose asset it is is an
-- arc between the two, so an owner column of any kind on these tables would be the wrong shape.
CREATE TABLE du_assets (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- Which URLA section this row is. One container serves four of them; this says which columns the row may fill and
  -- which AssetType values it may take — both as CHECKs below. Ours: no DU data point behind it.
  kind                          text NOT NULL CHECK (kind IN ('DEPOSIT_ACCOUNT', 'OTHER_ASSET', 'GIFT_OR_GRANT', 'OWNED_PROPERTY')),
  asset_type                    text,
  asset_type_other_description  text CHECK (asset_type_other_description IN ('OtherLiquidAsset', 'OtherNonLiquidAsset')),
  funds_source_type             text CHECK (funds_source_type IN ('CommunityNonProfit', 'Employer', 'FederalAgency', 'Lender', 'LocalAgency', 'Other', 'Parent', 'Relative', 'ReligiousNonProfit', 'StateAgency', 'UnmarriedPartner', 'UnrelatedFriend')),
  funds_source_type_other_description text,
  included_in_asset_account     boolean,
  institution_name              text,                                           -- ASSET_HOLDER/NAME/FullName, String 150
  account_identifier_encrypted  bytea,                                          -- AssetAccountIdentifier, String 30; pii, encrypted per 19.x
  account_last4                 char(4),
  cash_or_market_value_cents    bigint,
  -- 22.4's re-pull identity (rule 5): prefixed by the application_borrowers row whose pull produced it, so two borrowers
  -- pulling one joint account produce two rows with two owner sets until 22.4 reconciles them. Unique with the
  -- application ACROSS retired rows: an account that goes away and comes back is one account, revived, not a twin.
  identity_key                  text NOT NULL,
  -- Lineage: the 22.4 asset report (verifications, 0081) that produced, first saw, last confirmed or retired the row.
  -- Null on a row a person typed.
  source_verification_id        uuid REFERENCES verifications(verification_id) ON DELETE SET NULL,
  first_seen_verification_id    uuid REFERENCES verifications(verification_id) ON DELETE SET NULL,
  last_seen_verification_id     uuid REFERENCES verifications(verification_id) ON DELETE SET NULL,
  retired_by_verification_id    uuid REFERENCES verifications(verification_id) ON DELETE SET NULL,
  -- Live or retired. Superseded rather than deleted — you cannot diff against a row you deleted, and only live rows are
  -- emitted, counted or required to have an owner.
  retired_at                    timestamptz,
  retention_class               retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT du_assets_retired_by_a_verification_is_retired CHECK (retired_by_verification_id IS NULL OR retired_at IS NOT NULL)
);
CREATE INDEX du_assets_app_idx ON du_assets(application_id) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX du_assets_application_identity_key ON du_assets(application_id, identity_key);
-- Not a rule about assets — the target the composite foreign key on du_owned_properties needs, so an owned property can
-- name its parent's kind as well as its id.
CREATE UNIQUE INDEX du_assets_id_kind ON du_assets(id, kind);
COMMENT ON TABLE du_assets IS '23.5: URLA 2a, 2b, 3a and 4d, which are one XML container (ASSET). kind says which section a row is; the per-kind CHECKs give each kind the AssetType values and the columns its section carries. Live while retired_at IS NULL; ≥ 1 owner arc at COMMIT (du_assets_have_an_owner); ≤ 50 live per application (du_assets_fit_fifty).';
COMMENT ON COLUMN du_assets.kind IS 'Ours: the URLA section (2a deposit account, 2b other asset, 4d gift or grant, 3a owned property). Not a DU data point.';
COMMENT ON COLUMN du_assets.asset_type IS 'DU AssetType. The 22 values partition by URLA section: du_assets_deposit_account_shape (2a.1), du_assets_other_asset_shape (2b.1), du_assets_gift_or_grant_shape (4d.1); NULL on an OWNED_PROPERTY row.';
COMMENT ON COLUMN du_assets.asset_type_other_description IS 'DU AssetTypeOtherDescription. 2b.1, present exactly when asset_type = Other; an enumeration on the wire, not free text.';
COMMENT ON COLUMN du_assets.funds_source_type IS 'DU FundsSourceType. 4d.3, GIFT_OR_GRANT rows only.';
COMMENT ON COLUMN du_assets.account_identifier_encrypted IS 'pii';
COMMENT ON COLUMN du_assets.institution_name IS 'pii';

-- ─── The four asset kinds have disjoint fields, and disjoint types ──────────────────────────────────────────────────
-- An REO asset carries no ASSET_DETAIL at all (21 REO assets in the corpus, none with one; DU Map record 189: a
-- property "can't be listed as both"). The XSD permits an ASSET with both, so this CHECK is the only thing stopping an
-- REO row from acquiring an account number.
ALTER TABLE du_assets
  ADD CONSTRAINT du_assets_owned_property_carries_no_asset_detail CHECK (
    kind <> 'OWNED_PROPERTY' OR (
      asset_type IS NULL AND asset_type_other_description IS NULL AND cash_or_market_value_cents IS NULL
      AND institution_name IS NULL AND account_identifier_encrypted IS NULL AND account_last4 IS NULL
      AND funds_source_type IS NULL AND funds_source_type_other_description IS NULL AND included_in_asset_account IS NULL
    )
  ),
  -- Each kind names the AssetType values its URLA section holds, not only which columns must be null: with
  -- kind = OTHER_ASSET and asset_type = CheckingAccount the 2b shape rule would apply to a 2a row and the emitted
  -- checking account would carry neither holder nor account identifier, both of which DU requires once an amount
  -- exists. `asset_type IS NOT NULL` is spelled beside each list because NULL IN (…) is NULL and a CHECK passes on NULL.
  -- The three lists are the partition the DU Enumerations tab draws by Form Field ID (thirteen at 2a.1, six at 2b.1,
  -- three at 4d.1); `npm run du:verify` diffs them against enums.ts on every build.
  ADD CONSTRAINT du_assets_deposit_account_shape CHECK (
    kind <> 'DEPOSIT_ACCOUNT' OR (
      asset_type IS NOT NULL
      AND asset_type IN ('Bond', 'BridgeLoanNotDeposited', 'CertificateOfDepositTimeDeposit', 'CheckingAccount', 'IndividualDevelopmentAccount', 'LifeInsurance', 'MoneyMarketFund', 'MutualFund', 'RetirementFund', 'SavingsAccount', 'Stock', 'StockOptions', 'TrustAccount')
      AND cash_or_market_value_cents IS NOT NULL
      AND institution_name IS NOT NULL
      AND funds_source_type IS NULL AND included_in_asset_account IS NULL
    )
  ),
  ADD CONSTRAINT du_assets_other_asset_shape CHECK (
    kind <> 'OTHER_ASSET' OR (
      asset_type IS NOT NULL
      AND asset_type IN ('CashOnHand', 'Other', 'PendingNetSaleProceedsFromRealEstateAssets', 'ProceedsFromSaleOfNonRealEstateAsset', 'ProceedsFromSecuredLoan', 'ProceedsFromUnsecuredLoan')
      AND cash_or_market_value_cents IS NOT NULL
      AND account_identifier_encrypted IS NULL AND account_last4 IS NULL AND funds_source_type IS NULL
    )
  ),
  ADD CONSTRAINT du_assets_gift_or_grant_shape CHECK (
    kind <> 'GIFT_OR_GRANT' OR (
      asset_type IS NOT NULL
      AND asset_type IN ('GiftOfCash', 'GiftOfPropertyEquity', 'Grant')
      AND cash_or_market_value_cents IS NOT NULL
      AND funds_source_type IS NOT NULL
      AND account_identifier_encrypted IS NULL AND account_last4 IS NULL
    )
  ),
  -- IncludedInAssetAccountIndicator is 4d.2, conditional on GiftOfCash or Grant — not GiftOfPropertyEquity, which is
  -- a credit in the transaction and was never in an account to be included in.
  ADD CONSTRAINT du_assets_included_in_account_needs_cash_or_grant CHECK (included_in_asset_account IS NULL OR asset_type IN ('GiftOfCash', 'Grant')),
  -- AssetTypeOtherDescription is conditional on Other, both directions; NULL-safe because asset_type is nullable.
  ADD CONSTRAINT du_assets_other_description_needs_other CHECK ((asset_type IS NOT DISTINCT FROM 'Other') = (asset_type_other_description IS NOT NULL)),
  ADD CONSTRAINT du_assets_funds_source_description_needs_other CHECK ((funds_source_type IS NOT DISTINCT FROM 'Other') = (funds_source_type_other_description IS NOT NULL)),
  -- Amount 9.2 on the wire: nine integer digits and two decimals is the widest DU takes.
  ADD CONSTRAINT du_assets_value_fits_amount_9_2 CHECK (cash_or_market_value_cents IS NULL OR cash_or_market_value_cents BETWEEN 0 AND 99999999999),
  ADD CONSTRAINT du_assets_strings_fit_the_wire CHECK (char_length(coalesce(institution_name, '')) <= 150 AND char_length(coalesce(funds_source_type_other_description, '')) <= 80);

-- URLA 3a. A child OF an asset and never a sibling: moving OWNED_PROPERTY beside COLLATERALS fails MISMO schema
-- validation, and there is no other legal location for it. The unique asset_id is the 0:1, the cascade is the nesting,
-- and the composite foreign key against a generated asset_kind column is what makes "inside an REO asset" true rather
-- than intended: (asset_id, asset_kind) can only match an asset whose kind is OWNED_PROPERTY.
CREATE TABLE du_owned_properties (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id                        uuid NOT NULL UNIQUE REFERENCES du_assets(id) ON DELETE CASCADE,
  asset_kind                      text GENERATED ALWAYS AS ('OWNED_PROPERTY') STORED,
  -- Denormalized from the asset and written ONLY by a trigger (du_owned_properties_inherit_their_application): the
  -- partial unique index for "one subject property" cannot see through the asset to the application.
  application_id                  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  address_line_text               text,                                         -- String 35 at this destination (3a.2.1)
  address_unit                    text,
  city_name                       text,
  state_code                      char(2),
  postal_code                     text,
  country_code                    char(2),
  disposition                     text NOT NULL CHECK (disposition IN ('PendingSale', 'Retain', 'Sold')),
  is_subject                      boolean NOT NULL DEFAULT false,
  current_usage                   text CHECK (current_usage IN ('Investment', 'PrimaryResidence', 'SecondHome')),
  property_usage                  text CHECK (property_usage IN ('Investment', 'Other', 'PrimaryResidence', 'SecondHome')),
  property_usage_other_description text CHECK (property_usage_other_description IN ('Chattel', 'Commercial', 'Farm', 'Land', 'Multifamily', 'Timeshare')),
  market_value_cents              bigint,
  -- Derived (rule 3) by du_owned_properties_total_their_liens and du_liabilities_retotal_their_property: the total UPB
  -- of the live liabilities secured by this row. No caller writes it; a value passed in is overwritten.
  lien_upb_cents                  bigint,
  monthly_expenses_cents          bigint,
  monthly_rental_income_cents     bigint,                                       -- 3a.7 gross; zero is a legitimate answer
  monthly_net_rental_income_cents bigint,                                       -- 3a.8 net; signed — DI-C08 emits -678.00
  retention_class                 retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT du_owned_properties_attach_to_an_reo_asset FOREIGN KEY (asset_id, asset_kind) REFERENCES du_assets(id, kind) ON DELETE CASCADE
);
CREATE INDEX du_owned_properties_app_idx ON du_owned_properties(application_id);
-- OwnedPropertySubjectIndicator is how DU links the REO schedule to COLLATERALS/SUBJECT_PROPERTY; there is no arc.
CREATE UNIQUE INDEX du_owned_properties_one_subject_per_application ON du_owned_properties(application_id) WHERE is_subject;
COMMENT ON TABLE du_owned_properties IS '23.5: URLA 3a, a 0:1 child of an OWNED_PROPERTY asset and never a sibling; (asset_id, asset_kind) → du_assets(id, kind) is the relational spelling of the nesting. application_id is inherited by trigger and lien_upb_cents is derived from the live liabilities securing the row; a caller writes neither.';
COMMENT ON COLUMN du_owned_properties.disposition IS 'DU OwnedPropertyDispositionStatusType. 3a.4.';
COMMENT ON COLUMN du_owned_properties.current_usage IS 'DU PropertyCurrentUsageType. How the property is used today.';
COMMENT ON COLUMN du_owned_properties.property_usage IS 'DU PropertyUsageType. 3a.5, the intended usage, conditional on disposition = Retain.';
COMMENT ON COLUMN du_owned_properties.property_usage_other_description IS 'DU PropertyUsageTypeOtherDescription. Present exactly when property_usage = Other.';
COMMENT ON COLUMN du_owned_properties.lien_upb_cents IS '23.5 rule 3: OwnedPropertyLienUPBAmount (3a.12), "the total amount of all remaining mortgages and liens against the owned real property" — derived from du_liabilities.unpaid_balance_cents where secured_by_owned_property_id = id and retired_at IS NULL; never written by a caller. NULL is a property owned free and clear.';

ALTER TABLE du_owned_properties
  -- A non-subject REO must carry its own address; a subject REO may (null means "render the subject property's here").
  ADD CONSTRAINT du_owned_properties_non_subject_carries_its_own_address CHECK (is_subject OR (address_line_text IS NOT NULL AND city_name IS NOT NULL AND state_code IS NOT NULL AND postal_code IS NOT NULL)),
  ADD CONSTRAINT du_owned_properties_subject_override_is_whole CHECK (NOT is_subject OR ((address_line_text IS NULL AND address_unit IS NULL AND city_name IS NULL AND state_code IS NULL AND postal_code IS NULL AND country_code IS NULL) OR (address_line_text IS NOT NULL AND city_name IS NOT NULL AND state_code IS NOT NULL AND postal_code IS NOT NULL))),
  ADD CONSTRAINT du_owned_properties_address_fits_the_wire CHECK (char_length(coalesce(address_line_text, '')) <= 35 AND char_length(coalesce(address_unit, '')) <= 11 AND char_length(coalesce(city_name, '')) <= 35),
  -- MISMO 3.4 does not separate zip from zip+4: five digits or nine, no dash — and the XSD accepts a dash.
  ADD CONSTRAINT du_owned_properties_postal_code_has_no_dash CHECK (postal_code IS NULL OR postal_code ~ '^([0-9]{5}|[0-9]{9})$'),
  ADD CONSTRAINT du_owned_properties_intended_usage_needs_retain CHECK (property_usage IS NULL OR disposition = 'Retain'),
  ADD CONSTRAINT du_owned_properties_other_description_needs_other CHECK ((property_usage IS NOT DISTINCT FROM 'Other') = (property_usage_other_description IS NOT NULL)),
  ADD CONSTRAINT du_owned_properties_amounts_fit_amount_9_2 CHECK (coalesce(market_value_cents, 0) BETWEEN 0 AND 99999999999 AND coalesce(lien_upb_cents, 0) BETWEEN 0 AND 99999999999 AND coalesce(monthly_expenses_cents, 0) BETWEEN 0 AND 99999999999 AND coalesce(monthly_rental_income_cents, 0) BETWEEN 0 AND 99999999999),
  -- The one signed amount: net rental is income minus expenses and is negative when the property loses money.
  ADD CONSTRAINT du_owned_properties_rental_net_fits_signed_amount_9_2 CHECK (monthly_net_rental_income_cents IS NULL OR monthly_net_rental_income_cents BETWEEN -99999999999 AND 99999999999),
  ADD CONSTRAINT du_owned_properties_rental_net_needs_retain CHECK (monthly_net_rental_income_cents IS NULL OR disposition = 'Retain');

CREATE TABLE du_liabilities (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  liability_type                  text NOT NULL CHECK (liability_type IN ('CollectionsJudgmentsAndLiens', 'Installment', 'LeasePayment', 'Open30DayChargeAccount', 'Other', 'Revolving', 'Taxes', 'TaxLien', 'HELOC', 'MortgageLoan')),
  liability_type_other_description text,                                       -- 2c.1, String 80, exactly when Other
  mortgage_type                   text CHECK (mortgage_type IN ('FHA')),
  creditor_name                   text NOT NULL,                                -- LIABILITY_HOLDER/NAME/FullName, String 150
  account_identifier_encrypted    bytea,                                        -- LiabilityAccountIdentifier, String 30; pii
  account_last4                   char(4),
  monthly_payment_cents           bigint NOT NULL,
  unpaid_balance_cents            bigint NOT NULL,
  remaining_term_months           int,
  paid_off_at_or_before_closing   boolean NOT NULL DEFAULT false,
  exclusion_indicator             boolean NOT NULL DEFAULT false,
  heloc_maximum_balance_cents     bigint,
  payment_includes_taxes_insurance boolean,
  -- The one arc that is a foreign key rather than a join table: ASSET_IsAssociatedWith_LIABILITY (23 in the corpus, no
  -- liability the target of more than one asset; one property with two liens is ordinary).
  secured_by_owned_property_id    uuid REFERENCES du_owned_properties(id) ON DELETE SET NULL,
  identity_key                    text NOT NULL,
  -- Exactly one source: the 22.4 asset report (verifications) that produced the row, or the 22.2 credit report whose
  -- tradeline it is. first/last-seen and retired-by are the 22.4 pull lineage. NO ACTION on the source, not SET NULL:
  -- the exactly-one-source CHECK below would refuse the referential SET NULL from inside the RI trigger, as a
  -- check_violation on du_liabilities rather than a foreign-key refusal on the delete — so the foreign key refuses the
  -- delete itself, and a verification a liability was produced from is retired or repointed (19.x) before it goes.
  source_verification_id          uuid REFERENCES verifications(verification_id),
  source_credit_report_id         uuid REFERENCES credit_reports(id),
  first_seen_verification_id      uuid REFERENCES verifications(verification_id) ON DELETE SET NULL,
  last_seen_verification_id       uuid REFERENCES verifications(verification_id) ON DELETE SET NULL,
  retired_by_verification_id      uuid REFERENCES verifications(verification_id) ON DELETE SET NULL,
  retired_at                      timestamptz,
  retention_class                 retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT du_liabilities_have_exactly_one_source CHECK (num_nonnulls(source_verification_id, source_credit_report_id) = 1),
  CONSTRAINT du_liabilities_retired_by_a_verification_is_retired CHECK (retired_by_verification_id IS NULL OR retired_at IS NOT NULL)
);
CREATE INDEX du_liabilities_app_idx ON du_liabilities(application_id) WHERE retired_at IS NULL;
CREATE INDEX du_liabilities_secured_by_idx ON du_liabilities(secured_by_owned_property_id) WHERE secured_by_owned_property_id IS NOT NULL;
CREATE UNIQUE INDEX du_liabilities_application_identity_key ON du_liabilities(application_id, identity_key);
COMMENT ON TABLE du_liabilities IS '23.5: URLA 2c and 3a.11 (LIABILITY). Exactly one source — a 22.4 verification or a 22.2 credit report; ≥ 1 obligor arc at COMMIT (du_liabilities_have_an_obligor); ≤ 50 live; secured_by_owned_property_id is the ASSET_IsAssociatedWith_LIABILITY arc and stays inside the application.';
COMMENT ON COLUMN du_liabilities.liability_type IS 'DU LiabilityType. 2c.1 (declared) and 3a.11 (mortgages against owned property) in one column.';
COMMENT ON COLUMN du_liabilities.mortgage_type IS 'DU MortgageType. 3a.14, the REO mortgage variant only.';
COMMENT ON COLUMN du_liabilities.account_identifier_encrypted IS 'pii';
COMMENT ON COLUMN du_liabilities.creditor_name IS 'pii';

ALTER TABLE du_liabilities
  -- Only the REO mortgage variant participates in ASSET_IsAssociatedWith_LIABILITY and carries the HELOC maximum,
  -- the taxes-and-insurance indicator and MortgageType.
  ADD CONSTRAINT du_liabilities_only_a_mortgage_is_secured CHECK (secured_by_owned_property_id IS NULL OR liability_type IN ('MortgageLoan', 'HELOC')),
  ADD CONSTRAINT du_liabilities_heloc_maximum_needs_a_heloc CHECK (heloc_maximum_balance_cents IS NULL OR liability_type = 'HELOC'),
  ADD CONSTRAINT du_liabilities_taxes_indicator_needs_a_mortgage CHECK (payment_includes_taxes_insurance IS NULL OR liability_type IN ('MortgageLoan', 'HELOC')),
  ADD CONSTRAINT du_liabilities_mortgage_type_needs_a_mortgage CHECK (mortgage_type IS NULL OR liability_type IN ('MortgageLoan', 'HELOC')),
  ADD CONSTRAINT du_liabilities_other_description_needs_other CHECK ((liability_type = 'Other') = (liability_type_other_description IS NOT NULL)),
  ADD CONSTRAINT du_liabilities_amounts_fit_amount_9_2 CHECK (unpaid_balance_cents BETWEEN 0 AND 99999999999 AND monthly_payment_cents BETWEEN 0 AND 99999999999 AND coalesce(heloc_maximum_balance_cents, 0) BETWEEN 0 AND 99999999999),
  ADD CONSTRAINT du_liabilities_strings_fit_the_wire CHECK (char_length(creditor_name) BETWEEN 1 AND 150 AND char_length(coalesce(liability_type_other_description, '')) <= 80),
  -- LiabilityRemainingTermMonthsCount is Numeric 3: 1200 months writes cleanly and is rejected by DU.
  ADD CONSTRAINT du_liabilities_remaining_term_fits_numeric_3 CHECK (remaining_term_months IS NULL OR remaining_term_months BETWEEN 0 AND 999);

-- Two instances in the entire corpus, and EXPENSE is the one container here with no _DETAIL child. Typed by a person;
-- no connector supersedes one, so no retired_at.
CREATE TABLE du_expenses (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  expense_type                text NOT NULL CHECK (expense_type IN ('Alimony', 'ChildSupport', 'JobRelatedExpenses', 'Other', 'SeparateMaintenanceExpense')),
  expense_other_description   text,                                             -- 2d.1, exactly when Other
  monthly_payment_cents       bigint NOT NULL,
  remaining_term_months       int,
  alimony_owed_to_name        text,                                             -- ours; the EXPENSE container carries four data points and this is none of them
  retention_class             retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT du_expenses_other_description_needs_other CHECK ((expense_type = 'Other') = (expense_other_description IS NOT NULL)),
  CONSTRAINT du_expenses_amount_fits_amount_9_2 CHECK (monthly_payment_cents BETWEEN 0 AND 99999999999),
  CONSTRAINT du_expenses_remaining_term_fits_numeric_3 CHECK (remaining_term_months IS NULL OR remaining_term_months BETWEEN 0 AND 999),
  CONSTRAINT du_expenses_alimony_name_is_bounded CHECK (char_length(coalesce(alimony_owed_to_name, '')) <= 150)
);
CREATE INDEX du_expenses_app_idx ON du_expenses(application_id);
COMMENT ON TABLE du_expenses IS '23.5: URLA 2d (EXPENSE). ≥ 1 payer arc at COMMIT (du_expenses_have_a_payer); ≤ 50 per application.';
COMMENT ON COLUMN du_expenses.expense_type IS 'DU ExpenseType. 2d.1.';
COMMENT ON COLUMN du_expenses.alimony_owed_to_name IS 'pii. Ours, not DU''s: the serializer never looks for somewhere to put it.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. The arcs: three ownership join tables and the joint credit report self-loop
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Two rows for one asset IS joint ownership: MISMO has no "joint" flag and nowhere on a RELATIONSHIP to record a share.
-- The `to` end of the arc is the ROLE element, emitted from the application_borrowers edge rather than from the person,
-- so the arcs point at the edge — a borrower dropped from the application takes their arcs with them by cascade rather
-- than leaving one naming a label the document does not contain. `role` is where a distinction we need and DU does not
-- (which borrower supplied the statement) can live without polluting the arc.
CREATE TABLE du_asset_parties (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id                uuid NOT NULL REFERENCES du_assets(id) ON DELETE CASCADE,
  application_borrower_id uuid NOT NULL REFERENCES application_borrowers(id) ON DELETE CASCADE,
  role                    text NOT NULL DEFAULT 'owner',
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, application_borrower_id)
);
CREATE INDEX du_asset_parties_borrower_idx ON du_asset_parties(application_borrower_id);
COMMENT ON TABLE du_asset_parties IS '23.5: ASSET_IsAssociatedWith_ROLE. Two rows for one asset is joint ownership. Both ends on the same application and the borrower in a borrowing role (du_asset_parties_stay_inside_the_application); the last arc cannot be removed from a live asset (du_asset_parties_leave_an_owner).';

CREATE TABLE du_liability_parties (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  liability_id            uuid NOT NULL REFERENCES du_liabilities(id) ON DELETE CASCADE,
  application_borrower_id uuid NOT NULL REFERENCES application_borrowers(id) ON DELETE CASCADE,
  role                    text NOT NULL DEFAULT 'obligor',
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (liability_id, application_borrower_id)
);
CREATE INDEX du_liability_parties_borrower_idx ON du_liability_parties(application_borrower_id);
COMMENT ON TABLE du_liability_parties IS '23.5: LIABILITY_IsAssociatedWith_ROLE; same shape and triggers as du_asset_parties.';

CREATE TABLE du_expense_parties (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id              uuid NOT NULL REFERENCES du_expenses(id) ON DELETE CASCADE,
  application_borrower_id uuid NOT NULL REFERENCES application_borrowers(id) ON DELETE CASCADE,
  role                    text NOT NULL DEFAULT 'payer',
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (expense_id, application_borrower_id)
);
CREATE INDEX du_expense_parties_borrower_idx ON du_expense_parties(application_borrower_id);
COMMENT ON TABLE du_expense_parties IS '23.5: EXPENSE_IsAssociatedWith_ROLE; a join table because alimony can be joint and the arc role reads like the asset''s.';

-- ROLE_SharesJointCreditReportWith_ROLE. A GROUPING, not a flag: DI-C02 emits BORROWER_3 → BORROWER_2 while BORROWER_1
-- stands alone, so the group's primary is not the application's primary borrower. Directed: `to` is the group's
-- primary, `from` the additional borrower; reversed, DU reads the wrong borrower as primary.
CREATE TABLE du_joint_credit_report_links (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_application_borrower_id  uuid NOT NULL REFERENCES application_borrowers(id) ON DELETE CASCADE,
  to_application_borrower_id    uuid NOT NULL REFERENCES application_borrowers(id) ON DELETE CASCADE,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT du_joint_credit_links_are_not_reflexive CHECK (from_application_borrower_id <> to_application_borrower_id)
);
-- One group per additional borrower: a borrower whose report is shared with two different primaries is two
-- contradictory groups.
CREATE UNIQUE INDEX du_joint_credit_links_one_group_per_additional_borrower ON du_joint_credit_report_links(application_id, from_application_borrower_id);
CREATE INDEX du_joint_credit_links_by_group_primary ON du_joint_credit_report_links(application_id, to_application_borrower_id);
COMMENT ON TABLE du_joint_credit_report_links IS '23.5: ROLE_SharesJointCreditReportWith_ROLE. Directed — to_ is the group''s primary, from_ the additional borrower; one group per additional borrower (unique on from_) and exactly one primary per group (du_joint_credit_groups_have_one_primary).';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. The declaration is asked, not derived: du_declarations, du_bankruptcy_filings; and where the borrower lives
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- URLA section 5 is one container per borrower per credit request, keyed on the application_borrowers edge (the answer
-- to "have you declared bankruptcy in the past seven years" is different on a different date). The twelve NOT NULL
-- answers are the point: a nullable one lets a half-answered declaration reach the serializer and be completed with No
-- on a document the borrower signs. Every answer is DU's Yes/No; DU reads twelve of them as Booleans on the wire and
-- two (5a.1, 5a.1.1) as enumerations — the enumerated two carry the DU comment the generator diffs.
CREATE TABLE du_declarations (
  id                                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_borrower_id               uuid NOT NULL UNIQUE REFERENCES application_borrowers(id) ON DELETE CASCADE,
  -- The kernel Actor {kind, id, role} of the borrower's own session: kind = human, role = borrower, id the party behind
  -- application_borrower_id (32.2 stamps it from the signed-in session, never from the client's claim). Refused
  -- otherwise by du_declarations_are_self_attested.
  asserted_by_actor                     jsonb NOT NULL CHECK (jsonb_typeof(asserted_by_actor) = 'object'),
  asserted_at                           timestamptz NOT NULL DEFAULT now(),
  -- 5a. About this property and your money for this loan
  intent_to_occupy                      text NOT NULL CHECK (intent_to_occupy IN ('Yes', 'No')),                       -- A
  homeowner_past_three_years            text CHECK (homeowner_past_three_years IN ('Yes', 'No')),                      -- 5a.1.1, iff A = Yes
  property_usage                        text CHECK (property_usage IN ('Investment', 'PrimaryResidence', 'SecondHome')), -- 5a.1.2, iff 5a.1.1 = Yes
  prior_property_title                  text CHECK (prior_property_title IN ('JointWithOtherThanSpouse', 'JointWithSpouse', 'Sole')), -- 5a.1.3, optional (no DU conditionality)
  fha_secondary_residence               text CHECK (fha_secondary_residence IN ('Yes', 'No')),                         -- optional; FHA-conditional, the preflight requires it
  special_borrower_seller_relationship  text CHECK (special_borrower_seller_relationship IN ('Yes', 'No')),            -- B, conditional on a purchase (loan-level; the preflight)
  undisclosed_borrowed_funds            text NOT NULL CHECK (undisclosed_borrowed_funds IN ('Yes', 'No')),             -- C
  undisclosed_borrowed_funds_cents      bigint,                                                                        -- 5a.3.1, iff C = Yes
  undisclosed_mortgage_application      text NOT NULL CHECK (undisclosed_mortgage_application IN ('Yes', 'No')),       -- D.1
  undisclosed_credit_application        text NOT NULL CHECK (undisclosed_credit_application IN ('Yes', 'No')),         -- D.2
  property_proposed_clean_energy_lien   text NOT NULL CHECK (property_proposed_clean_energy_lien IN ('Yes', 'No')),    -- E
  -- 5b. About your finances
  undisclosed_comaker_of_note           text NOT NULL CHECK (undisclosed_comaker_of_note IN ('Yes', 'No')),            -- F
  outstanding_judgments                 text NOT NULL CHECK (outstanding_judgments IN ('Yes', 'No')),                  -- G
  presently_delinquent                  text NOT NULL CHECK (presently_delinquent IN ('Yes', 'No')),                   -- H
  party_to_lawsuit                      text CHECK (party_to_lawsuit IN ('Yes', 'No')),                                -- I, optional for DU; required on FHA/VA by the preflight
  prior_property_deed_in_lieu_conveyed  text NOT NULL CHECK (prior_property_deed_in_lieu_conveyed IN ('Yes', 'No')),   -- J
  prior_property_short_sale_completed   text NOT NULL CHECK (prior_property_short_sale_completed IN ('Yes', 'No')),    -- K
  prior_property_foreclosure_completed  text NOT NULL CHECK (prior_property_foreclosure_completed IN ('Yes', 'No')),   -- L
  bankruptcy                            text NOT NULL CHECK (bankruptcy IN ('Yes', 'No')),                             -- M; the gate on du_bankruptcy_filings
  -- The borrower's own words. DU consumes no explanation element; this is for the 1003, the underwriter and the file's
  -- own record, and is never discarded.
  bankruptcy_explanation                text,
  retention_class                       retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                            timestamptz NOT NULL DEFAULT now(),
  updated_at                            timestamptz NOT NULL DEFAULT now(),
  -- A follow-up exists exactly when its trigger question says (DU conditionality statements, verbatim, as CHECKs).
  -- PriorPropertyTitleType gets none: it is optional for DU with a blank conditionality cell.
  CONSTRAINT du_declarations_homeowner_follows_intent CHECK ((intent_to_occupy = 'Yes') = (homeowner_past_three_years IS NOT NULL)),
  CONSTRAINT du_declarations_prior_usage_follows_homeowner CHECK ((intent_to_occupy = 'Yes' AND homeowner_past_three_years = 'Yes') = (property_usage IS NOT NULL)),
  CONSTRAINT du_declarations_borrowed_amount_follows_indicator CHECK ((undisclosed_borrowed_funds = 'Yes') = (undisclosed_borrowed_funds_cents IS NOT NULL)),
  CONSTRAINT du_declarations_borrowed_amount_fits_amount_9_2 CHECK (undisclosed_borrowed_funds_cents IS NULL OR undisclosed_borrowed_funds_cents BETWEEN 0 AND 99999999999)
);
COMMENT ON TABLE du_declarations IS '23.5 rule 4: URLA section 5 as of one credit request, one row per borrower. Asked and never derived — du_declarations_are_self_attested refuses every actor but the declaring borrower''s own (kind human, role borrower, id the party behind application_borrower_id); an agent actor or another party''s actor raises DU_DECLARATION_NOT_SELF_ATTESTED.';
COMMENT ON COLUMN du_declarations.intent_to_occupy IS 'DU IntentToOccupyType. 5a.1 (question A).';
COMMENT ON COLUMN du_declarations.homeowner_past_three_years IS 'DU HomeownerPastThreeYearsType. 5a.1.1, present exactly when A = Yes.';
COMMENT ON COLUMN du_declarations.property_usage IS 'DU PriorPropertyUsageType. 5a.1.2, present exactly when 5a.1.1 = Yes.';
COMMENT ON COLUMN du_declarations.prior_property_title IS 'DU PriorPropertyTitleType. 5a.1.3, optional.';
COMMENT ON COLUMN du_declarations.special_borrower_seller_relationship IS 'Yes/No; SpecialBorrowerSellerRelationshipIndicator (5a.B), a Boolean on the wire, conditional on a purchase.';
COMMENT ON COLUMN du_declarations.undisclosed_borrowed_funds IS 'Yes/No; UndisclosedBorrowedFundsIndicator (5a.C), a Boolean on the wire.';
COMMENT ON COLUMN du_declarations.undisclosed_mortgage_application IS 'Yes/No; UndisclosedMortgageApplicationIndicator (5a.D.1), a Boolean on the wire.';
COMMENT ON COLUMN du_declarations.undisclosed_credit_application IS 'Yes/No; UndisclosedCreditApplicationIndicator (5a.D.2), a Boolean on the wire.';
COMMENT ON COLUMN du_declarations.property_proposed_clean_energy_lien IS 'Yes/No; PropertyProposedCleanEnergyLienIndicator (5a.E), a Boolean on the wire.';
COMMENT ON COLUMN du_declarations.undisclosed_comaker_of_note IS 'Yes/No; UndisclosedComakerOfNoteIndicator (5b.F), a Boolean on the wire.';
COMMENT ON COLUMN du_declarations.outstanding_judgments IS 'Yes/No; OutstandingJudgmentsIndicator (5b.G), a Boolean on the wire.';
COMMENT ON COLUMN du_declarations.presently_delinquent IS 'Yes/No; PresentlyDelinquentIndicator (5b.H), a Boolean on the wire.';
COMMENT ON COLUMN du_declarations.party_to_lawsuit IS 'Yes/No; PartyToLawsuitIndicator (5b.I), a Boolean on the wire, optional for DU.';
COMMENT ON COLUMN du_declarations.prior_property_deed_in_lieu_conveyed IS 'Yes/No; PriorPropertyDeedInLieuConveyedIndicator (5b.J), a Boolean on the wire.';
COMMENT ON COLUMN du_declarations.prior_property_short_sale_completed IS 'Yes/No; PriorPropertyShortSaleCompletedIndicator (5b.K), a Boolean on the wire.';
COMMENT ON COLUMN du_declarations.prior_property_foreclosure_completed IS 'Yes/No; PriorPropertyForeclosureCompletedIndicator (5b.L), a Boolean on the wire.';
COMMENT ON COLUMN du_declarations.bankruptcy IS 'Yes/No; BankruptcyIndicator (5b.M), a Boolean on the wire; Yes requires ≥ 1 du_bankruptcy_filings row at COMMIT and No forbids one.';
COMMENT ON COLUMN du_declarations.bankruptcy_explanation IS 'pii. The borrower''s written explanation, verbatim; DU consumes no explanation element.';
COMMENT ON COLUMN du_declarations.asserted_by_actor IS 'The kernel Actor {kind, id, role} that asserted the row; must be the borrower''s own (human / borrower / the party behind application_borrower_id).';

-- Which chapters, when the borrower declared a bankruptcy: a set, not a list of filings. URLA asks for the type(s) and
-- there are exactly four legal chapters; the unique pair admits each once.
CREATE TABLE du_bankruptcy_filings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id  uuid NOT NULL REFERENCES du_declarations(id) ON DELETE CASCADE,
  chapter         text NOT NULL CHECK (chapter IN ('ChapterEleven', 'ChapterSeven', 'ChapterThirteen', 'ChapterTwelve')),
  retention_class retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (declaration_id, chapter)
);
COMMENT ON TABLE du_bankruptcy_filings IS '23.5: the chapter(s) of a declared bankruptcy (5b.8.1). Deferred triggers refuse a Yes with no chapter and a chapter on a No at COMMIT, including the deletion of the last chapter in a later transaction.';
COMMENT ON COLUMN du_bankruptcy_filings.chapter IS 'DU BankruptcyChapterType. 5b.8.1.';

-- Where they live, and where they lived before. One Current per borrower; several Prior rows when under two years.
CREATE TABLE du_residences (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_borrower_id uuid NOT NULL REFERENCES application_borrowers(id) ON DELETE CASCADE,
  residency_type          text NOT NULL CHECK (residency_type IN ('Current', 'Prior')),
  residency_basis         text NOT NULL CHECK (residency_basis IN ('LivingRentFree', 'Own', 'Rent')),
  monthly_rent_cents      bigint,
  address_line_text       text,                                                 -- String 50 at RESIDENCE/ADDRESS
  address_unit            text,
  city_name               text,
  state_code              char(2),
  postal_code             text,
  country_code            char(2),
  duration_months         int NOT NULL,
  retention_class         retention_class NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- The rent is required exactly when the basis is Rent (23.5 T8).
  CONSTRAINT du_residences_rent_iff_rent_basis CHECK ((residency_basis = 'Rent') = (monthly_rent_cents IS NOT NULL)),
  CONSTRAINT du_residences_rent_fits_amount_9_2 CHECK (monthly_rent_cents IS NULL OR monthly_rent_cents BETWEEN 0 AND 99999999999),
  -- BorrowerResidencyDurationMonthsCount is Numeric 3.
  CONSTRAINT du_residences_duration_fits_numeric_3 CHECK (duration_months BETWEEN 0 AND 999),
  -- A Prior residence carries its own address; nothing else knows it.
  CONSTRAINT du_residences_prior_carries_its_own_address CHECK (residency_type <> 'Prior' OR (address_line_text IS NOT NULL AND city_name IS NOT NULL AND state_code IS NOT NULL AND postal_code IS NOT NULL)),
  CONSTRAINT du_residences_address_fits_the_wire CHECK (char_length(coalesce(address_line_text, '')) <= 50 AND char_length(coalesce(address_unit, '')) <= 11 AND char_length(coalesce(city_name, '')) <= 35 AND (postal_code IS NULL OR postal_code ~ '^([0-9]{5}|[0-9]{9})$'))
);
CREATE UNIQUE INDEX du_residences_one_current_per_borrower ON du_residences(application_borrower_id) WHERE residency_type = 'Current';
CREATE INDEX du_residences_borrower_idx ON du_residences(application_borrower_id);
COMMENT ON TABLE du_residences IS '23.5: URLA 1a.13–1a.16 — where a borrower lives (one Current, with its basis and, when Rent, the monthly rent) and lived (Prior rows, when under two years). A borrower with any residence row has exactly one Current at COMMIT (du_residences_keep_a_current_home).';
COMMENT ON COLUMN du_residences.residency_type IS 'DU BorrowerResidencyType. Current (1a.13) or Prior (1a.15).';
COMMENT ON COLUMN du_residences.residency_basis IS 'DU BorrowerResidencyBasisType. 1a.14.1 / 1a.16.1; Rent carries monthly_rent_cents.';
COMMENT ON COLUMN du_residences.address_line_text IS 'pii';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. The invariants, as triggers — every refusal raises check_violation with its code first in the message
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- updated_at on the rows that are updated in place (retire, revive, re-total, re-assert).
CREATE OR REPLACE FUNCTION du_rows_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER du_assets_touch_updated_at BEFORE UPDATE ON du_assets FOR EACH ROW EXECUTE FUNCTION du_rows_touch_updated_at();
CREATE TRIGGER du_liabilities_touch_updated_at BEFORE UPDATE ON du_liabilities FOR EACH ROW EXECUTE FUNCTION du_rows_touch_updated_at();
CREATE TRIGGER du_owned_properties_touch_updated_at BEFORE UPDATE ON du_owned_properties FOR EACH ROW EXECUTE FUNCTION du_rows_touch_updated_at();
CREATE TRIGGER du_declarations_touch_updated_at BEFORE UPDATE ON du_declarations FOR EACH ROW EXECUTE FUNCTION du_rows_touch_updated_at();
CREATE TRIGGER employers_touch_updated_at BEFORE UPDATE ON employers FOR EACH ROW EXECUTE FUNCTION du_rows_touch_updated_at();

-- ─── Live or retired: the spec's spelling is `retired_by_verification_id` set; retired_at is when ──────────────────
-- A writer that names the retiring pull and nothing else gets a retired row; clearing the verification id (a revive:
-- an account that went away and came back is one account) clears retired_at with it.
CREATE OR REPLACE FUNCTION du_rows_retire_with_their_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.retired_by_verification_id IS NOT NULL AND NEW.retired_at IS NULL THEN NEW.retired_at := now(); END IF;
  IF TG_OP = 'UPDATE' AND OLD.retired_by_verification_id IS NOT NULL AND NEW.retired_by_verification_id IS NULL AND NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at THEN NEW.retired_at := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER du_assets_retire_with_their_verification BEFORE INSERT OR UPDATE ON du_assets FOR EACH ROW EXECUTE FUNCTION du_rows_retire_with_their_verification();
CREATE TRIGGER du_liabilities_retire_with_their_verification BEFORE INSERT OR UPDATE ON du_liabilities FOR EACH ROW EXECUTE FUNCTION du_rows_retire_with_their_verification();

-- ─── OWNED_PROPERTY inherits its application and totals its liens (rule 3; 23.5 T3, T13) ───────────────────────────
-- application_id exists for the one-subject partial unique index and for nothing else, so nothing is allowed to set
-- it by hand: a caller's value is overwritten with the asset's.
CREATE OR REPLACE FUNCTION du_owned_properties_inherit_their_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.application_id := (SELECT application_id FROM du_assets WHERE id = NEW.asset_id);
  RETURN NEW;
END $$;
CREATE TRIGGER du_owned_properties_inherit_their_application_write BEFORE INSERT OR UPDATE ON du_owned_properties FOR EACH ROW EXECUTE FUNCTION du_owned_properties_inherit_their_application();

-- The lien balance is a TOTAL (DU Map record 193, 3a.12: "the total amount of all remaining mortgages and liens
-- against the owned real property"; DI-C04 emits 206,514.00 for 198,514.00 + 8,000.00) and it is derived: computed on
-- both sides of the relationship, a value passed in is overwritten rather than refused, NULL when no live liability
-- points at the row.
CREATE OR REPLACE FUNCTION du_owned_properties_total_their_liens() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.lien_upb_cents := (SELECT sum(unpaid_balance_cents) FROM du_liabilities WHERE secured_by_owned_property_id = NEW.id AND retired_at IS NULL);
  RETURN NEW;
END $$;
CREATE TRIGGER du_owned_properties_total_their_liens_write BEFORE INSERT OR UPDATE ON du_owned_properties FOR EACH ROW EXECUTE FUNCTION du_owned_properties_total_their_liens();

-- The other side: a lien written, retired, repointed or deleted re-totals the property it left and the one it joined.
-- The UPDATE re-enters the BEFORE trigger above, which recomputes the same value and stops.
CREATE OR REPLACE FUNCTION du_liabilities_retotal_their_property() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op uuid;
BEGIN
  FOREACH op IN ARRAY ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.secured_by_owned_property_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.secured_by_owned_property_id END] LOOP
    IF op IS NOT NULL THEN
      UPDATE du_owned_properties SET lien_upb_cents = (SELECT sum(unpaid_balance_cents) FROM du_liabilities WHERE secured_by_owned_property_id = op AND retired_at IS NULL) WHERE id = op;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER du_liabilities_retotal_their_property_write AFTER INSERT OR UPDATE OR DELETE ON du_liabilities FOR EACH ROW EXECUTE FUNCTION du_liabilities_retotal_their_property();

-- ─── The FK arc stays inside the application (23.5 T4's sibling for the one arc that is a foreign key) ──────────────
CREATE OR REPLACE FUNCTION du_liabilities_are_secured_inside_the_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op_app uuid;
BEGIN
  IF NEW.secured_by_owned_property_id IS NULL THEN RETURN NEW; END IF;
  SELECT application_id INTO op_app FROM du_owned_properties WHERE id = NEW.secured_by_owned_property_id;
  IF op_app IS DISTINCT FROM NEW.application_id THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_GRAPH_CROSSES_APPLICATIONS: liability %s is on application %s but the owned property securing it is on %s; an arc across two applications points at a label this document does not contain', NEW.id, NEW.application_id, op_app);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER du_liabilities_stay_inside_the_application BEFORE INSERT OR UPDATE ON du_liabilities FOR EACH ROW EXECUTE FUNCTION du_liabilities_are_secured_inside_the_application();

-- ─── An owner is a borrowing party on THIS application (23.5 T4) ────────────────────────────────────────────────────
-- The foreign key says the edge exists; what it cannot say is that the edge is on the SAME application as the row it
-- owns, or that its role is a borrowing one — a non-borrowing spouse and a trustee never become DU Borrower elements.
-- TG_ARGV: the owned table, the arc's column naming it.
CREATE OR REPLACE FUNCTION du_links_stay_inside_the_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE app uuid; ab_app uuid; r text; owned uuid := (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
BEGIN
  EXECUTE format('SELECT application_id FROM %I WHERE id = $1', TG_ARGV[0]) INTO app USING owned;
  SELECT application_id, borrower_role INTO ab_app, r FROM application_borrowers WHERE id = NEW.application_borrower_id;
  IF ab_app IS DISTINCT FROM app THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_GRAPH_CROSSES_APPLICATIONS: application_borrower %s is on application %s but %s %s is on %s; an arc across two applications points at a label this document does not contain', NEW.application_borrower_id, ab_app, TG_ARGV[0], owned, app);
  END IF;
  IF r NOT IN ('borrower', 'co_borrower', 'non_occupant_co_borrower') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_GRAPH_OWNER_NOT_A_BORROWER: application_borrower %s is a %s, which is not a DU Borrower', NEW.application_borrower_id, r);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER du_asset_parties_stay_inside_the_application BEFORE INSERT OR UPDATE ON du_asset_parties FOR EACH ROW EXECUTE FUNCTION du_links_stay_inside_the_application('du_assets', 'asset_id');
CREATE TRIGGER du_liability_parties_stay_inside_the_application BEFORE INSERT OR UPDATE ON du_liability_parties FOR EACH ROW EXECUTE FUNCTION du_links_stay_inside_the_application('du_liabilities', 'liability_id');
CREATE TRIGGER du_expense_parties_stay_inside_the_application BEFORE INSERT OR UPDATE ON du_expense_parties FOR EACH ROW EXECUTE FUNCTION du_links_stay_inside_the_application('du_expenses', 'expense_id');

-- ─── Nothing emittable is left without an owner, EVER (rule 1; 23.5 T1, T2) ─────────────────────────────────────────
-- Deferred to COMMIT, because a row and its first owner arc land in one transaction and neither is writable before the
-- other. The rule is about rows that will be EMITTED: a row deleted inside this transaction is not one, and a retired
-- row is not one either — so retiring an asset and then removing its last arc commits. INSERT OR UPDATE, because a row
-- can become live without being inserted (a revive clears retired_at). TG_ARGV: the arc table, its column naming the
-- owned row, whether the owned table supersedes (has retired_at).
--
-- Every COMMIT-time count here and below LOCKS THE ROW IT COUNTS UNDER (FOR NO KEY UPDATE) before counting. A deferred
-- check that only reads is subject to write skew under READ COMMITTED: two sessions each delete one of an asset's two
-- owner arcs, each COMMIT-time count sees the other arc still there, both commit, and a live asset has no owner — the
-- state this trigger exists to make unreachable. With the lock the second committer waits for the first, then counts
-- again on a fresh snapshot and is refused. NO KEY UPDATE, not FOR UPDATE, so the lock never conflicts with the KEY
-- SHARE every foreign key check on the row takes.
CREATE OR REPLACE FUNCTION du_rows_have_an_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int; link_tbl text := TG_ARGV[0]; col text := TG_ARGV[1]; supersedes boolean := TG_ARGV[2]::boolean; live boolean; rid uuid := NEW.id;
BEGIN
  IF supersedes THEN
    EXECUTE format('SELECT true FROM %I WHERE id = $1 AND retired_at IS NULL FOR NO KEY UPDATE', TG_TABLE_NAME) INTO live USING rid;
  ELSE
    EXECUTE format('SELECT true FROM %I WHERE id = $1 FOR NO KEY UPDATE', TG_TABLE_NAME) INTO live USING rid;
  END IF;
  IF live IS NOT TRUE THEN RETURN NULL; END IF;
  EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', link_tbl, col) INTO n USING rid;
  IF n = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_GRAPH_ORPHAN: %s %s has no owner arc and cannot be emitted; every ASSET, LIABILITY and EXPENSE in all eighteen shipped samples carries at least one', TG_TABLE_NAME, rid);
  END IF;
  RETURN NULL;
END $$;

-- The mirror side: re-check the PARENT of an arc that was removed or moved. Silent when that parent is gone or retired,
-- because deleting a row together with its arcs is the ordinary case. The parent row is locked (FOR NO KEY UPDATE)
-- before the count — see du_rows_have_an_owner — so two sessions removing one arc each serialize and the second sees
-- the first's removal; a parent retired by a concurrent session is re-read after that session commits (the row lock
-- re-evaluates `retired_at IS NULL` on the committed version) and no longer needs an owner.
CREATE OR REPLACE FUNCTION du_link_removal_rechecks_its_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int; parent_tbl text := TG_ARGV[0]; col text := TG_ARGV[1]; supersedes boolean := TG_ARGV[2]::boolean; pid uuid; still boolean;
BEGIN
  pid := (to_jsonb(OLD) ->> col)::uuid;
  IF supersedes THEN
    EXECUTE format('SELECT true FROM %I WHERE id = $1 AND retired_at IS NULL FOR NO KEY UPDATE', parent_tbl) INTO still USING pid;
  ELSE
    EXECUTE format('SELECT true FROM %I WHERE id = $1 FOR NO KEY UPDATE', parent_tbl) INTO still USING pid;
  END IF;
  IF still IS NOT TRUE THEN RETURN NULL; END IF;
  EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', TG_TABLE_NAME, col) INTO n USING pid;
  IF n = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_GRAPH_ORPHAN: %s %s has no owner arc left and cannot be emitted; removing the last owner is removing the arc', parent_tbl, pid);
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER du_assets_have_an_owner AFTER INSERT OR UPDATE ON du_assets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_rows_have_an_owner('du_asset_parties', 'asset_id', 'true');
CREATE CONSTRAINT TRIGGER du_liabilities_have_an_obligor AFTER INSERT OR UPDATE ON du_liabilities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_rows_have_an_owner('du_liability_parties', 'liability_id', 'true');
CREATE CONSTRAINT TRIGGER du_expenses_have_a_payer AFTER INSERT OR UPDATE ON du_expenses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_rows_have_an_owner('du_expense_parties', 'expense_id', 'false');
CREATE CONSTRAINT TRIGGER du_asset_parties_leave_an_owner AFTER DELETE OR UPDATE ON du_asset_parties DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_link_removal_rechecks_its_parent('du_assets', 'asset_id', 'true');
CREATE CONSTRAINT TRIGGER du_liability_parties_leave_an_obligor AFTER DELETE OR UPDATE ON du_liability_parties DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_link_removal_rechecks_its_parent('du_liabilities', 'liability_id', 'true');
CREATE CONSTRAINT TRIGGER du_expense_parties_leave_a_payer AFTER DELETE OR UPDATE ON du_expense_parties DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_link_removal_rechecks_its_parent('du_expenses', 'expense_id', 'false');

-- ─── The container maxima, which the XSD does not enforce ───────────────────────────────────────────────────────────
-- ASSET, LIABILITY and EXPENSE are each 0:50 per DEAL. Counts LIVE rows (the cardinality is about emitted elements; a
-- cap on ingest is a lockout after four re-pulls) at COMMIT (a revive that clears retired_at is invisible to a BEFORE
-- INSERT count). `> 50`, not `>= 50`: the row being checked is already in the count. Counted under a NO KEY UPDATE lock
-- on the application (the same lock the ordinal allocator takes; never FOR UPDATE, which would conflict with the KEY
-- SHARE the unit of work's loan_events rows hold), so two sessions each writing the fiftieth row cannot both commit.
CREATE OR REPLACE FUNCTION du_container_fits_fifty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int; supersedes boolean := TG_ARGV[0]::boolean;
BEGIN
  PERFORM 1 FROM applications WHERE id = NEW.application_id FOR NO KEY UPDATE;
  IF supersedes THEN
    EXECUTE format('SELECT count(*) FROM %I WHERE application_id = $1 AND retired_at IS NULL', TG_TABLE_NAME) INTO n USING NEW.application_id;
  ELSE
    EXECUTE format('SELECT count(*) FROM %I WHERE application_id = $1', TG_TABLE_NAME) INTO n USING NEW.application_id;
  END IF;
  IF n > 50 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_GRAPH_CONTAINER_OVERFLOW: %s is 0:50 per DEAL and application %s would emit %s rows', TG_TABLE_NAME, NEW.application_id, n);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER du_assets_fit_fifty AFTER INSERT OR UPDATE ON du_assets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_container_fits_fifty('true');
CREATE CONSTRAINT TRIGGER du_liabilities_fit_fifty AFTER INSERT OR UPDATE ON du_liabilities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_container_fits_fifty('true');
CREATE CONSTRAINT TRIGGER du_expenses_fit_fifty AFTER INSERT OR UPDATE ON du_expenses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_container_fits_fifty('false');

-- ─── The joint credit report is a partition, and its `to` end is primary (23.5 T12) ─────────────────────────────────
-- Both endpoints belong to THIS application and are borrowing roles; a group has exactly one primary, so a party who
-- is a `from` may not also be a `to`. The two EXISTS checks read the other links on the application, so they run
-- under the application's NO KEY UPDATE lock: two sessions writing link(b3 → b1) and link(b1 → b4) at once would
-- otherwise each see no conflict and leave b1 both a primary and an additional borrower.
CREATE OR REPLACE FUNCTION du_joint_credit_groups_have_one_primary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE from_app uuid; to_app uuid; from_role text; to_role text;
BEGIN
  PERFORM 1 FROM applications WHERE id = NEW.application_id FOR NO KEY UPDATE;
  SELECT application_id, borrower_role INTO from_app, from_role FROM application_borrowers WHERE id = NEW.from_application_borrower_id;
  SELECT application_id, borrower_role INTO to_app, to_role FROM application_borrowers WHERE id = NEW.to_application_borrower_id;
  IF from_app IS DISTINCT FROM NEW.application_id OR to_app IS DISTINCT FROM NEW.application_id THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_GRAPH_CROSSES_APPLICATIONS: joint credit link on application %s names borrowers on %s and %s; an arc across two applications points at a label this document does not contain', NEW.application_id, from_app, to_app);
  END IF;
  IF from_role NOT IN ('borrower', 'co_borrower', 'non_occupant_co_borrower') OR to_role NOT IN ('borrower', 'co_borrower', 'non_occupant_co_borrower') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_GRAPH_OWNER_NOT_A_BORROWER: a joint credit report is shared between two DU Borrowers; this link names a %s and a %s', from_role, to_role);
  END IF;
  IF EXISTS (SELECT 1 FROM du_joint_credit_report_links WHERE application_id = NEW.application_id AND from_application_borrower_id = NEW.to_application_borrower_id AND id <> NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_JOINT_CREDIT_GROUP: application_borrower %s is already an additional borrower in another group on this application and cannot also be a group primary', NEW.to_application_borrower_id);
  END IF;
  IF EXISTS (SELECT 1 FROM du_joint_credit_report_links WHERE application_id = NEW.application_id AND to_application_borrower_id = NEW.from_application_borrower_id AND id <> NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_JOINT_CREDIT_GROUP: application_borrower %s is already a group primary on this application and cannot also be an additional borrower', NEW.from_application_borrower_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER du_joint_credit_groups_have_one_primary_write BEFORE INSERT OR UPDATE ON du_joint_credit_report_links FOR EACH ROW EXECUTE FUNCTION du_joint_credit_groups_have_one_primary();

-- ─── Chapters exist if and only if the borrower declared a bankruptcy (23.5 T5) ─────────────────────────────────────
-- Deferred, at COMMIT, because the declaration row and its chapter rows land in one transaction. Two trigger functions
-- rather than one that works out which table fired it; the filings function checks BOTH endpoints, because an UPDATE
-- that moves a chapter between declarations leaves the one it left saying Yes with nothing naming a chapter. The
-- declaration row is locked before the chapters are counted (two sessions deleting one chapter each of a Yes with two).
CREATE OR REPLACE FUNCTION du_bankruptcy_chapters_match(d_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE says text; n int;
BEGIN
  SELECT bankruptcy INTO says FROM du_declarations WHERE id = d_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN; END IF;                  -- the declaration itself was deleted
  SELECT count(*) INTO n FROM du_bankruptcy_filings WHERE declaration_id = d_id;
  IF says = 'Yes' AND n = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'du_bankruptcy_chapters_match_the_indicator', TABLE = 'du_declarations',
      MESSAGE = format('DU_DECLARATION_BANKRUPTCY_CHAPTERS: declaration %s says bankruptcy = Yes but names no chapter; URLA 5b.8.1 asks which type(s)', d_id);
  END IF;
  IF says = 'No' AND n > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'du_bankruptcy_chapters_match_the_indicator', TABLE = 'du_declarations',
      MESSAGE = format('DU_DECLARATION_BANKRUPTCY_CHAPTERS: declaration %s names %s bankruptcy chapter(s) but says bankruptcy = No', d_id, n);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION du_bankruptcy_chapters_match_from_declaration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM du_bankruptcy_chapters_match(NEW.id); RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION du_bankruptcy_chapters_match_from_filing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN PERFORM du_bankruptcy_chapters_match(NEW.declaration_id); END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM du_bankruptcy_chapters_match(OLD.declaration_id); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER du_bankruptcy_chapters_match_the_indicator_decl AFTER INSERT OR UPDATE ON du_declarations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_bankruptcy_chapters_match_from_declaration();
CREATE CONSTRAINT TRIGGER du_bankruptcy_chapters_match_the_indicator_filing AFTER INSERT OR UPDATE OR DELETE ON du_bankruptcy_filings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_bankruptcy_chapters_match_from_filing();

-- ─── Nobody but the borrower declares (rule 4; 23.5 T6) ─────────────────────────────────────────────────────────────
-- A clean credit report is absence of evidence, not a No, and there must be no code path that fills a declaration from
-- a pull — including one somebody writes in six months without reading this. "Self" is enforced and not merely implied:
-- refusing only the agent kinds would leave one borrower's session able to assert for the co-borrower. The party behind
-- the row is application_borrowers.party_id (0111), or the servicing borrower's party through borrower_id (0057/0001)
-- once the two are linked; a row with neither has nobody who could have signed it.
CREATE OR REPLACE FUNCTION du_declarations_are_self_attested() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_kind text := NEW.asserted_by_actor ->> 'kind'; actor_role text := NEW.asserted_by_actor ->> 'role'; actor_id text := NEW.asserted_by_actor ->> 'id'; declaring_party uuid;
BEGIN
  IF actor_kind IS DISTINCT FROM 'human' OR actor_role IS DISTINCT FROM 'borrower' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_DECLARATION_NOT_SELF_ATTESTED: a %s actor (%s%s) may not declare on a borrower''s behalf; URLA section 5 is a statement the borrower signs', coalesce(actor_kind, 'null'), coalesce(actor_id, 'null'), CASE WHEN actor_role IS NULL THEN '' ELSE ' / ' || actor_role END);
  END IF;
  SELECT coalesce(ab.party_id, b.party_id) INTO declaring_party
    FROM application_borrowers ab LEFT JOIN borrowers b ON b.id = ab.borrower_id
   WHERE ab.id = NEW.application_borrower_id;
  IF declaring_party IS NULL OR actor_id IS DISTINCT FROM declaring_party::text THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_DECLARATION_NOT_SELF_ATTESTED: actor %s is not the party behind application_borrower %s (%s); one borrower does not answer section 5 for another', coalesce(actor_id, 'null'), NEW.application_borrower_id, coalesce(declaring_party::text, 'no party'));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER du_declarations_are_self_attested_write BEFORE INSERT OR UPDATE ON du_declarations FOR EACH ROW EXECUTE FUNCTION du_declarations_are_self_attested();

-- ─── A declaration or a residence belongs to a borrowing party ──────────────────────────────────────────────────────
-- A non-borrowing spouse and a trustee do not become DU Borrower elements, so a declaration or a residence on one is a
-- row with nowhere to go.
CREATE OR REPLACE FUNCTION du_borrower_scoped_rows_need_a_borrowing_role() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  SELECT borrower_role INTO r FROM application_borrowers WHERE id = NEW.application_borrower_id;
  IF r IS NULL OR r NOT IN ('borrower', 'co_borrower', 'non_occupant_co_borrower') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_GRAPH_OWNER_NOT_A_BORROWER: application_borrower %s is %s, which is not a DU Borrower', NEW.application_borrower_id, coalesce(r, 'missing'));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER du_declarations_need_a_borrowing_role BEFORE INSERT OR UPDATE ON du_declarations FOR EACH ROW EXECUTE FUNCTION du_borrower_scoped_rows_need_a_borrowing_role();
CREATE TRIGGER du_residences_need_a_borrowing_role BEFORE INSERT OR UPDATE ON du_residences FOR EACH ROW EXECUTE FUNCTION du_borrower_scoped_rows_need_a_borrowing_role();

-- ─── A borrower with any residence row has a CURRENT one (23.5 T8) ──────────────────────────────────────────────────
-- Deferred: answering again deletes every row and writes the new set, so there is an instant mid-transaction when the
-- borrower has no residence at all. A borrower with NO residence rows is untouched — that is a borrower who has not
-- answered. Both edges, because an UPDATE can move a row from one borrower to another. The application_borrowers row
-- is locked before the rows are read (one session deleting the Current while another adds a Prior).
CREATE OR REPLACE FUNCTION du_residences_current_home_present(edge uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM application_borrowers WHERE id = edge FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM du_residences WHERE application_borrower_id = edge)
     AND NOT EXISTS (SELECT 1 FROM du_residences WHERE application_borrower_id = edge AND residency_type = 'Current') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'du_residences_keep_a_current_home', TABLE = 'du_residences',
      MESSAGE = format('DU_RESIDENCE_NO_CURRENT_HOME: application_borrower %s carries residences but none is Current; DU needs the current residence with its basis on every file', edge);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION du_residences_keep_a_current_home() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN PERFORM du_residences_current_home_present(NEW.application_borrower_id); END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM du_residences_current_home_present(OLD.application_borrower_id); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER du_residences_keep_a_current_home AFTER INSERT OR UPDATE OR DELETE ON du_residences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_residences_keep_a_current_home();

-- ─── The role-flip guard (23.5 T14): a demotion is the write that has to be refused ─────────────────────────────────
-- Flipping a co-borrower to a non-borrowing spouse after the fact would leave their declaration, residences, ownership
-- arcs and joint-credit links in place — the dangling-arc state the foreign keys exist to make unreachable, reached
-- through the one write that touches neither end of an arc. Repoint or retire first.
CREATE OR REPLACE FUNCTION application_borrowers_keep_their_du_rows_valid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.borrower_role IN ('borrower', 'co_borrower', 'non_occupant_co_borrower') THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM du_declarations WHERE application_borrower_id = NEW.id)
     OR EXISTS (SELECT 1 FROM du_residences WHERE application_borrower_id = NEW.id)
     OR EXISTS (SELECT 1 FROM du_asset_parties p JOIN du_assets a ON a.id = p.asset_id WHERE p.application_borrower_id = NEW.id AND a.retired_at IS NULL)
     OR EXISTS (SELECT 1 FROM du_liability_parties p JOIN du_liabilities l ON l.id = p.liability_id WHERE p.application_borrower_id = NEW.id AND l.retired_at IS NULL)
     OR EXISTS (SELECT 1 FROM du_expense_parties WHERE application_borrower_id = NEW.id)
     OR EXISTS (SELECT 1 FROM du_joint_credit_report_links WHERE from_application_borrower_id = NEW.id OR to_application_borrower_id = NEW.id)
     OR EXISTS (SELECT 1 FROM employers WHERE application_borrower_id = NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME, TABLE = TG_TABLE_NAME,
      MESSAGE = format('DU_GRAPH_BORROWER_ROLE_IN_USE: application_borrower %s carries DU borrower rows and cannot become %s; repoint or retire the declaration, residences, ownership arcs, joint-credit links and employers first', NEW.id, NEW.borrower_role);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_borrowers_keep_their_du_rows_valid_update BEFORE UPDATE OF borrower_role ON application_borrowers FOR EACH ROW EXECUTE FUNCTION application_borrowers_keep_their_du_rows_valid();

COMMIT;
