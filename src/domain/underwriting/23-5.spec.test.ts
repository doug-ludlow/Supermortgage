// 23.5 The relationship graph and the modeled set: what a DU submission is assembled from
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-5-the-relationship-graph-and-the-modeled-set.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// DB-backed: the invariants live in Postgres (db/migrations/*_du_graph.sql) — CHECKs, unique indexes and deferred
// constraint triggers — so every case here writes rows through the pg client and asserts what the database refuses at
// the statement or at COMMIT. Plain SQL is the point: a second writer who never read the spec still cannot produce a row
// 23.6 cannot emit (T7 alone goes through the bus, because its subject is the command path the card resolves through). Own database
// `<base>_23_5`, dropped and created per run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { connect, reachable, type Db, type Queryable } from "../../infra/db/client.ts";
import { PgApplicationRepository } from "../../infra/db/applications.ts";
import { Runtime } from "../../runtime/app.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { DU_ENUMERATIONS, DU_ASSET_TYPES_BY_SECTION } from "./du/generated/enums.ts";

const BASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const DB_URL = ((): string => { const u = new URL(BASE_URL); u.pathname = `${u.pathname}_23_5`; return u.toString(); })();
const ADMIN_URL = ((): string => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })();
const up = await reachable(ADMIN_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${ADMIN_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${ADMIN_URL}`;

const MIGRATE_SH = fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

let db: Db;
let partnerPartyId = "";
/** Rows that existed BEFORE the du_graph migration ran, so its borrower_ordinal backfill had something to number (T9). */
let backfill: { tied: { app: string; borrower: string; co: string }; spouseOnly: { app: string; spouse: string }; coFirst: { app: string; borrower: string; co: string } };

test.before(async () => {
  if (skip) return;
  const name = new URL(DB_URL).pathname.slice(1);
  const a = connect(ADMIN_URL); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  const env = { ...process.env, DATABASE_URL: DB_URL };
  // The schema as it stood before the du_graph migration first, so that migration's backfill runs over existing rows
  // the way it will in production: migrate.sh walks its own migrations/ directory, so a temporary copy of db/ holding
  // every file up to (not including) *_du_graph.sql is run, the backfill fixture is written, and then the real
  // db/migrate.sh skips what is applied and applies the rest.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const graph = files.findIndex((f) => f.includes("_du_graph"));
  assert.ok(graph > 0, "db/migrations carries the du_graph migration");
  const stage = mkdtempSync(join(tmpdir(), "sm-23-5-"));
  try {
    mkdirSync(join(stage, "migrations"));
    for (const f of files.slice(0, graph)) copyFileSync(join(MIGRATIONS_DIR, f), join(stage, "migrations", f));
    copyFileSync(MIGRATE_SH, join(stage, "migrate.sh")); chmodSync(join(stage, "migrate.sh"), 0o755);
    execFileSync(join(stage, "migrate.sh"), { env, stdio: "pipe" });
    db = connect(DB_URL);
    partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name) VALUES ('servicer', 'FAKE Partner 23.5') RETURNING id`))[0]!.id;
    backfill = await seedBackfillFixture();
    await db.end();
    execFileSync(MIGRATE_SH, { env, stdio: "pipe" });
    db = connect(DB_URL);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
test.after(async () => { if (db) await db.end(); });

/** Three in-flight applications as every writer before 23.5 left them: no ordinal on any row. */
async function seedBackfillFixture(): Promise<typeof backfill> {
  // (1) Both borrowers in ONE transaction — PgApplicationRepository.create's shape — so created_at is one value for
  // both, and the co-borrower's uuid sorts first: a (created_at, id) backfill would make the co-borrower Borrower 1.
  const tied = await db.tx(async (q) => {
    const app = await newApplication(q);
    const co = "00000000-0000-4000-8000-000000000001"; const borrower = "00000000-0000-4000-8000-000000000002";
    await q.query(`INSERT INTO application_borrowers (id, application_id, borrower_role, legal_name) VALUES ($1, $2, 'co_borrower', 'Co Chris'), ($3, $2, 'borrower', 'Primary Pat')`, [co, app, borrower]);
    return { app, borrower, co };
  });
  // (2) A non-borrowing spouse alone: no position at all.
  const spouseApp = await newApplication();
  const spouse = (await db.query<{ id: string }>(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name) VALUES ($1, 'non_borrowing_spouse', 'Spouse Sam') RETURNING id`, [spouseApp]))[0]!.id;
  // (3) The co-borrower joined FIRST, in an earlier transaction; the primary applicant is still Borrower 1.
  const coFirstApp = await newApplication();
  const co2 = (await db.query<{ id: string }>(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name) VALUES ($1, 'co_borrower', 'Co Cam') RETURNING id`, [coFirstApp]))[0]!.id;
  const b2 = (await db.query<{ id: string }>(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name) VALUES ($1, 'borrower', 'Primary Pam') RETURNING id`, [coFirstApp]))[0]!.id;
  return { tied, spouseOnly: { app: spouseApp, spouse }, coFirst: { app: coFirstApp, borrower: b2, co: co2 } };
}

// ---------------------------------------------------------------- fixtures: an application, its borrowing parties, a 22.4 pull
type PgError = Error & { code?: string; constraint?: string };
type Role = "borrower" | "co_borrower" | "non_occupant_co_borrower" | "non_borrowing_spouse" | "trustee";

async function newApplication(q: Queryable = db): Promise<string> {
  return (await q.query<{ id: string }>(`INSERT INTO applications (partner_party_id, channel, transaction_type, occupancy) VALUES ($1, 'organic', 'purchase', 'primary') RETURNING id`, [partnerPartyId]))[0]!.id;
}
/** A borrowing (or not) party on the application, with its own `parties` row — the party a borrower's session signs in as (0111). */
async function newBorrower(appId: string, role: Role = "co_borrower", q: Queryable = db): Promise<{ id: string; party_id: string; borrower_ordinal: number | null }> {
  const party = (await q.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name) VALUES ('borrower', $1) RETURNING id`, [`Borrower ${randomUUID().slice(0, 8)}`]))[0]!.id;
  const row = (await q.query<{ id: string; borrower_ordinal: number | null }>(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name, party_id) VALUES ($1, $2, $3, $4) RETURNING id, borrower_ordinal`, [appId, role, `Borrower ${role}`, party]))[0]!;
  return { id: row.id, party_id: party, borrower_ordinal: row.borrower_ordinal };
}
/** A 22.4 asset report (verifications, 0081): the lineage every du_assets / du_liabilities row names. */
async function newVerification(appId: string, q: Queryable = db): Promise<string> {
  return (await q.query<{ verification_id: string }>(`INSERT INTO verifications (application_id, kind, component, supplier_code, report_reference_id, vendor_data_as_of, authorization_consent_id) VALUES ($1, 'assets', 'assets', 'FAKE', $2, CURRENT_DATE, gen_random_uuid()) RETURNING verification_id`, [appId, `R-${randomUUID().slice(0, 8)}`]))[0]!.verification_id;
}
type AssetRow = { kind: string; asset_type?: string | null; asset_type_other_description?: string | null; funds_source_type?: string | null; institution_name?: string | null; cash_or_market_value_cents?: bigint | null; account_last4?: string | null; identity_key?: string };
async function insertAsset(q: Queryable, appId: string, verificationId: string, a: AssetRow): Promise<string> {
  return (await q.query<{ id: string }>(
    `INSERT INTO du_assets (application_id, kind, asset_type, asset_type_other_description, funds_source_type, institution_name, cash_or_market_value_cents, account_last4, identity_key, source_verification_id, first_seen_verification_id, last_seen_verification_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10) RETURNING id`,
    [appId, a.kind, a.asset_type ?? null, a.asset_type_other_description ?? null, a.funds_source_type ?? null, a.institution_name ?? null, a.cash_or_market_value_cents ?? null, a.account_last4 ?? null, a.identity_key ?? `manual:${randomUUID()}`, verificationId]))[0]!.id;
}
/** An OWNED_PROPERTY asset with its owner arc and its 3a row. */
async function insertOwnedProperty(q: Queryable, appId: string, verificationId: string, ownerId: string, opts: { is_subject?: boolean; application_id?: string } = {}): Promise<{ assetId: string; propertyId: string }> {
  const assetId = await insertAsset(q, appId, verificationId, { kind: "OWNED_PROPERTY" });
  await q.query(`INSERT INTO du_asset_parties (asset_id, application_borrower_id) VALUES ($1, $2)`, [assetId, ownerId]);
  // A subject REO carries no address of its own (null means "render the subject property's here"); a non-subject one must.
  const address = opts.is_subject ? [null, null, null, null] : ["1234 Main St", "Springfield", "IL", "62701"];
  const propertyId = (await q.query<{ id: string }>(
    `INSERT INTO du_owned_properties (asset_id, application_id, address_line_text, city_name, state_code, postal_code, disposition, is_subject, market_value_cents)
     VALUES ($1, $2, $3, $4, $5, $6, 'Retain', $7, 45000000) RETURNING id`,
    [assetId, opts.application_id ?? appId, ...address, opts.is_subject ?? false]))[0]!.id;
  return { assetId, propertyId };
}
async function insertLiability(q: Queryable, appId: string, verificationId: string, obligorId: string, l: { liability_type: string; unpaid_balance_cents: bigint; secured_by?: string | null }): Promise<string> {
  const id = (await q.query<{ id: string }>(
    `INSERT INTO du_liabilities (application_id, liability_type, creditor_name, monthly_payment_cents, unpaid_balance_cents, secured_by_owned_property_id, identity_key, source_verification_id, first_seen_verification_id, last_seen_verification_id)
     VALUES ($1, $2, 'FAKE Lender', 150000, $3, $4, $5, $6, $6, $6) RETURNING id`,
    [appId, l.liability_type, l.unpaid_balance_cents, l.secured_by ?? null, `manual:${randomUUID()}`, verificationId]))[0]!.id;
  await q.query(`INSERT INTO du_liability_parties (liability_id, application_borrower_id) VALUES ($1, $2)`, [id, obligorId]);
  return id;
}
/** The fourteen section 5 answers, all No, asserted by `actor`; overrides for the case under test. */
async function insertDeclaration(q: Queryable, abId: string, actor: Record<string, unknown>, overrides: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    intent_to_occupy: "No", homeowner_past_three_years: null, property_usage: null, undisclosed_borrowed_funds: "No", undisclosed_borrowed_funds_cents: null,
    undisclosed_mortgage_application: "No", undisclosed_credit_application: "No", property_proposed_clean_energy_lien: "No", undisclosed_comaker_of_note: "No",
    outstanding_judgments: "No", presently_delinquent: "No", party_to_lawsuit: "No", prior_property_deed_in_lieu_conveyed: "No", prior_property_short_sale_completed: "No",
    prior_property_foreclosure_completed: "No", bankruptcy: "No", bankruptcy_explanation: null, ...overrides,
  };
  const cols = Object.keys(row);
  return (await q.query<{ id: string }>(
    `INSERT INTO du_declarations (application_borrower_id, asserted_by_actor, ${cols.join(", ")}) VALUES ($1, $2::jsonb, ${cols.map((_, i) => `$${i + 3}`).join(", ")}) RETURNING id`,
    [abId, JSON.stringify(actor), ...cols.map((c) => row[c])]))[0]!.id;
}
/** The borrower's own kernel Actor as 32.2 stamps it: kind human, role borrower, id the signed-in session's party. */
const ownActor = (partyId: string) => ({ kind: "human", id: partyId, role: "borrower" });
/** The refusal the spec names: ERRCODE check_violation (23514) with the code first in the message. */
const refusedWith = (code: string) => (e: unknown): boolean => {
  const err = e as PgError;
  assert.equal(err.code, "23514", `expected check_violation, got ${err.code}: ${err.message}`);
  assert.match(err.message, new RegExp(`^${code}: `));
  return true;
};
/** A refusal by a named CHECK, unique index or foreign key. */
const refusedBy = (constraint: string, sqlstate = "23514") => (e: unknown): boolean => {
  const err = e as PgError;
  assert.equal(err.code, sqlstate, `expected ${sqlstate}, got ${err.code}: ${err.message}`);
  assert.equal(err.constraint, constraint, err.message);
  return true;
};
const count = async (sql: string, params: unknown[]): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n ${sql}`, params))[0]!.n);
/** Whether a statement another session issued has come back within `ms` — "pending" is a statement waiting on a lock. */
const settled = (p: Promise<unknown>, ms = 300): Promise<"settled" | "pending"> => Promise.race([p.then(() => "settled" as const, () => "settled" as const), new Promise<"pending">((r) => setTimeout(r, ms, "pending"))]);
const client = async (): Promise<pg.Client> => { const c = new pg.Client({ connectionString: DB_URL }); await c.connect(); return c; };

test("23.5-T1: Given a live `du_assets` row, when the transaction commits with no `du_asset_parties` row for it, then COMMIT is refused with `DU_GRAPH_ORPHAN` and no row exists afterwards.", { skip }, async () => {
  const app = await newApplication(); const v = await newVerification(app);
  const id = randomUUID();
  await assert.rejects(db.tx(async (q) => {
    await q.query(`INSERT INTO du_assets (id, application_id, kind, asset_type, institution_name, cash_or_market_value_cents, identity_key, source_verification_id) VALUES ($1, $2, 'DEPOSIT_ACCOUNT', 'CheckingAccount', 'FAKE Bank', 1250000, $3, $4)`, [id, app, `manual:${id}`, v]);
    // the statement itself succeeds; the deferred constraint trigger du_assets_have_an_owner fires at COMMIT
    assert.equal(Number((await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM du_assets WHERE id = $1`, [id]))[0]!.n), 1);
  }), refusedWith("DU_GRAPH_ORPHAN"));
  assert.equal(await count(`FROM du_assets WHERE id = $1`, [id]), 0, "no row exists afterwards");
  // A retired row is not one that will be emitted, so it needs no owner: retiring and committing is allowed.
  await db.tx(async (q) => {
    await q.query(`INSERT INTO du_assets (application_id, kind, asset_type, institution_name, cash_or_market_value_cents, identity_key, source_verification_id, retired_by_verification_id) VALUES ($1, 'DEPOSIT_ACCOUNT', 'SavingsAccount', 'FAKE Bank', 1, $2, $3, $3)`, [app, `manual:${randomUUID()}`, v]);
  });
  // The same guarantee on a liability and an expense (du_liabilities_have_an_obligor, du_expenses_have_a_payer).
  await assert.rejects(db.tx((q) => q.query(`INSERT INTO du_liabilities (application_id, liability_type, creditor_name, monthly_payment_cents, unpaid_balance_cents, identity_key, source_verification_id) VALUES ($1, 'Revolving', 'FAKE Card', 5000, 120000, $2, $3)`, [app, `manual:${randomUUID()}`, v])), refusedWith("DU_GRAPH_ORPHAN"));
  await assert.rejects(db.tx((q) => q.query(`INSERT INTO du_expenses (application_id, expense_type, monthly_payment_cents) VALUES ($1, 'ChildSupport', 60000)`, [app])), refusedWith("DU_GRAPH_ORPHAN"));
  assert.equal(await count(`FROM du_liabilities WHERE application_id = $1`, [app]) + (await count(`FROM du_expenses WHERE application_id = $1`, [app])), 0);
  // A liability names exactly one source — a 22.4 verification or a 22.2 credit report — and that source cannot be
  // deleted from under it: the foreign key refuses the delete itself (23503, on the delete), never a SET NULL the
  // exactly-one-source CHECK would then refuse from inside the referential update as an error on du_liabilities.
  const b = await newBorrower(app, "borrower");
  await assert.rejects(db.query(`INSERT INTO du_liabilities (application_id, liability_type, creditor_name, monthly_payment_cents, unpaid_balance_cents, identity_key) VALUES ($1, 'Installment', 'FAKE Auto Finance', 40000, 1500000, $2)`, [app, `manual:${randomUUID()}`]), refusedBy("du_liabilities_have_exactly_one_source"));
  const v3 = await newVerification(app);
  const fromV3 = await db.tx((q) => insertLiability(q, app, v3, b.id, { liability_type: "Installment", unpaid_balance_cents: 1_500_000n }));
  await assert.rejects(db.query(`DELETE FROM verifications WHERE verification_id = $1`, [v3]), refusedBy("du_liabilities_source_verification_id_fkey", "23503"));
  assert.equal((await db.query<{ source_verification_id: string }>(`SELECT source_verification_id FROM du_liabilities WHERE id = $1`, [fromV3]))[0]!.source_verification_id, v3, "the liability still names the pull that produced it");
});

test("23.5-T2: Given an asset with two owner arcs, when one arc is deleted in a later transaction, then COMMIT succeeds; when the second is deleted, then COMMIT is refused.", { skip }, async () => {
  const app = await newApplication(); const v = await newVerification(app);
  const b1 = await newBorrower(app, "borrower"); const b2 = await newBorrower(app, "co_borrower");
  const assetId = await db.tx(async (q) => {
    const id = await insertAsset(q, app, v, { kind: "DEPOSIT_ACCOUNT", asset_type: "CheckingAccount", institution_name: "FAKE Bank", cash_or_market_value_cents: 500000n, account_last4: "4321" });
    await q.query(`INSERT INTO du_asset_parties (asset_id, application_borrower_id) VALUES ($1, $2), ($1, $3)`, [id, b1.id, b2.id]);
    return id;
  });
  assert.equal(await count(`FROM du_asset_parties WHERE asset_id = $1`, [assetId]), 2, "two rows for one asset is joint ownership");
  await db.tx((q) => q.query(`DELETE FROM du_asset_parties WHERE asset_id = $1 AND application_borrower_id = $2`, [assetId, b2.id]));
  assert.equal(await count(`FROM du_asset_parties WHERE asset_id = $1`, [assetId]), 1, "one owner left: COMMIT succeeded");
  await assert.rejects(db.tx((q) => q.query(`DELETE FROM du_asset_parties WHERE asset_id = $1 AND application_borrower_id = $2`, [assetId, b1.id])), refusedWith("DU_GRAPH_ORPHAN"));
  assert.equal(await count(`FROM du_asset_parties WHERE asset_id = $1`, [assetId]), 1, "the last arc is still there");
  // Retire the asset first and the same deletion commits: a superseded row is not emitted and needs no owner.
  await db.query(`UPDATE du_assets SET retired_by_verification_id = $2 WHERE id = $1`, [assetId, v]);
  const [retired] = await db.query<{ retired_at: string | null }>(`SELECT retired_at FROM du_assets WHERE id = $1`, [assetId]);
  assert.ok(retired!.retired_at, "retired_by_verification_id set is retired");
  await db.tx((q) => q.query(`DELETE FROM du_asset_parties WHERE asset_id = $1`, [assetId]));
  assert.equal(await count(`FROM du_asset_parties WHERE asset_id = $1`, [assetId]), 0);
  // And a revive (clearing the retiring pull) of an asset with no owner left is refused: a row can become live without being inserted.
  await assert.rejects(db.query(`UPDATE du_assets SET retired_by_verification_id = NULL WHERE id = $1`, [assetId]), refusedWith("DU_GRAPH_ORPHAN"));
  // Two sessions, one arc each. A COMMIT-time count that only reads is subject to write skew under READ COMMITTED —
  // each session's count sees the other's arc still there, both commit, and a live asset has no owner. The check
  // locks the asset's row (FOR NO KEY UPDATE) before counting, so the second committer waits for the first and then
  // counts again on what the first committed.
  const joint = await db.tx(async (q) => {
    const id = await insertAsset(q, app, v, { kind: "DEPOSIT_ACCOUNT", asset_type: "SavingsAccount", institution_name: "FAKE Bank", cash_or_market_value_cents: 900000n });
    await q.query(`INSERT INTO du_asset_parties (asset_id, application_borrower_id) VALUES ($1, $2), ($1, $3)`, [id, b1.id, b2.id]);
    return id;
  });
  const one = await client(); const two = await client();
  try {
    await one.query("BEGIN"); await one.query(`DELETE FROM du_asset_parties WHERE asset_id = $1 AND application_borrower_id = $2`, [joint, b1.id]);
    // Session one's deferred check runs now rather than at COMMIT: it sees the other arc, passes, and holds the
    // asset's row lock until the session ends — which is exactly what makes session two's COMMIT wait.
    await one.query("SET CONSTRAINTS ALL IMMEDIATE");
    await two.query("BEGIN"); await two.query(`DELETE FROM du_asset_parties WHERE asset_id = $1 AND application_borrower_id = $2`, [joint, b2.id]);
    const commitTwo = two.query("COMMIT"); commitTwo.catch(() => undefined);
    assert.equal(await settled(commitTwo), "pending", "session two's COMMIT waits on the asset's row lock instead of counting the arc session one is removing");
    await one.query("COMMIT");
    await assert.rejects(commitTwo, refusedWith("DU_GRAPH_ORPHAN"));
  } finally {
    await Promise.all([one, two].map((c) => c.end().catch(() => undefined)));
  }
  assert.equal(await count(`FROM du_asset_parties WHERE asset_id = $1 AND application_borrower_id = $2`, [joint, b2.id]), 1, "session two's arc is still there");
  assert.equal(await count(`FROM du_assets WHERE id = $1 AND retired_at IS NULL`, [joint]), 1, "the asset is live, with its one owner");
});

test("23.5-T3: Given an owned property and a liability secured by it with UPB $250,000.00, when a second liability of $40,000.00 is secured by the same property, then `du_owned_properties.lien_upb_cents` reads 29000000 with no caller having written it; when the first is retired, then it reads 4000000.", { skip }, async () => {
  const app = await newApplication(); const v = await newVerification(app); const b = await newBorrower(app, "borrower");
  const lien = async (propertyId: string): Promise<bigint | null> => (await db.query<{ lien_upb_cents: bigint | null }>(`SELECT lien_upb_cents FROM du_owned_properties WHERE id = $1`, [propertyId]))[0]!.lien_upb_cents;
  const { propertyId } = await db.tx((q) => insertOwnedProperty(q, app, v, b.id));
  assert.equal(await lien(propertyId), null, "free and clear: no live liability points at the row");
  const first = await db.tx((q) => insertLiability(q, app, v, b.id, { liability_type: "MortgageLoan", unpaid_balance_cents: 25_000_000n, secured_by: propertyId }));
  assert.equal(await lien(propertyId), 25_000_000n);
  await db.tx((q) => insertLiability(q, app, v, b.id, { liability_type: "HELOC", unpaid_balance_cents: 4_000_000n, secured_by: propertyId }));
  assert.equal(await lien(propertyId), 29_000_000n, "$250,000.00 + $40,000.00, summed by the trigger; no caller wrote lien_upb_cents");
  const v2 = await newVerification(app);
  await db.query(`UPDATE du_liabilities SET retired_by_verification_id = $2 WHERE id = $1`, [first, v2]);
  assert.equal(await lien(propertyId), 4_000_000n, "the retired first mortgage no longer counts");
  // Repointing the HELOC away re-totals both sides: the property reads NULL again. Only a mortgage or a HELOC is secured.
  await db.query(`UPDATE du_liabilities SET secured_by_owned_property_id = NULL WHERE secured_by_owned_property_id = $1`, [propertyId]);
  assert.equal(await lien(propertyId), null);
  await assert.rejects(db.tx((q) => insertLiability(q, app, v, b.id, { liability_type: "Revolving", unpaid_balance_cents: 1n, secured_by: propertyId })), refusedBy("du_liabilities_only_a_mortgage_is_secured"));
});

test("23.5-T4: Given an owner arc whose asset is on application A and whose borrower is on application B, when written, then it is refused with `DU_GRAPH_CROSSES_APPLICATIONS`.", { skip }, async () => {
  const appA = await newApplication(); const appB = await newApplication(); const v = await newVerification(appA);
  const a1 = await newBorrower(appA, "borrower"); const b1 = await newBorrower(appB, "borrower");
  const assetId = await db.tx(async (q) => {
    const id = await insertAsset(q, appA, v, { kind: "OTHER_ASSET", asset_type: "CashOnHand", cash_or_market_value_cents: 20000n });
    await q.query(`INSERT INTO du_asset_parties (asset_id, application_borrower_id) VALUES ($1, $2)`, [id, a1.id]);
    return id;
  });
  await assert.rejects(db.query(`INSERT INTO du_asset_parties (asset_id, application_borrower_id) VALUES ($1, $2)`, [assetId, b1.id]), refusedWith("DU_GRAPH_CROSSES_APPLICATIONS"));
  assert.equal(await count(`FROM du_asset_parties WHERE asset_id = $1`, [assetId]), 1);
  // The same guard on the other two arcs, and on the one arc that is a foreign key (a liability on B secured by A's property).
  const liabilityId = await db.tx((q) => insertLiability(q, appA, v, a1.id, { liability_type: "Revolving", unpaid_balance_cents: 100000n }));
  await assert.rejects(db.query(`INSERT INTO du_liability_parties (liability_id, application_borrower_id) VALUES ($1, $2)`, [liabilityId, b1.id]), refusedWith("DU_GRAPH_CROSSES_APPLICATIONS"));
  const expenseId = await db.tx(async (q) => { const id = (await q.query<{ id: string }>(`INSERT INTO du_expenses (application_id, expense_type, monthly_payment_cents) VALUES ($1, 'Alimony', 90000) RETURNING id`, [appA]))[0]!.id; await q.query(`INSERT INTO du_expense_parties (expense_id, application_borrower_id) VALUES ($1, $2)`, [id, a1.id]); return id; });
  await assert.rejects(db.query(`INSERT INTO du_expense_parties (expense_id, application_borrower_id) VALUES ($1, $2)`, [expenseId, b1.id]), refusedWith("DU_GRAPH_CROSSES_APPLICATIONS"));
  const { propertyId } = await db.tx((q) => insertOwnedProperty(q, appA, v, a1.id));
  const vB = await newVerification(appB);
  await assert.rejects(db.tx((q) => insertLiability(q, appB, vB, b1.id, { liability_type: "MortgageLoan", unpaid_balance_cents: 1n, secured_by: propertyId })), refusedWith("DU_GRAPH_CROSSES_APPLICATIONS"));
  // A non-borrowing party on the SAME application is refused too: it never becomes a DU Borrower element.
  const spouse = await newBorrower(appA, "non_borrowing_spouse");
  await assert.rejects(db.query(`INSERT INTO du_asset_parties (asset_id, application_borrower_id) VALUES ($1, $2)`, [assetId, spouse.id]), refusedWith("DU_GRAPH_OWNER_NOT_A_BORROWER"));
  // The employer arc (rule 2) is a foreign key on the income item and stays inside the application AND the borrower:
  // an item naming another borrower's employer, or another application's, is refused the same way.
  const a2 = await newBorrower(appA, "co_borrower");
  const employer = (await db.query<{ id: string }>(`INSERT INTO employers (application_id, application_borrower_id, identity_key, derived_from, name_key, display_name) VALUES ($1, $2, 'name:fake-payroll-co', 'name', 'name:fake-payroll-co', 'FAKE Payroll Co') RETURNING id`, [appA, a1.id]))[0]!.id;
  const income = (app: string, ab: string, emp: string | null, employment: boolean) => db.query(`INSERT INTO application_income (application_id, application_borrower_id, source_kind, monthly_amount_cents, employer_id, employment_income) VALUES ($1, $2, 'base', 650000, $3, $4)`, [app, ab, emp, employment]);
  await assert.rejects(income(appA, a2.id, employer, true), refusedWith("DU_GRAPH_CROSSES_APPLICATIONS"));
  await assert.rejects(income(appB, b1.id, employer, true), refusedWith("DU_GRAPH_CROSSES_APPLICATIONS"));
  // The indicator DU reads and the arc DU reads are one fact: employment_income = (employer_id IS NOT NULL), both directions.
  await assert.rejects(income(appA, a1.id, null, true), refusedBy("application_income_employment_income_names_an_employer"));
  await assert.rejects(income(appA, a1.id, employer, false), refusedBy("application_income_employment_income_names_an_employer"));
  await income(appA, a1.id, employer, true);
  // And the employer cannot be deleted from under the item: RESTRICT, seen by the deleter as the foreign key — never
  // a SET NULL, which that CHECK would refuse from inside the referential update as an error on application_income.
  // A merge repoints every item naming the loser to the survivor in the same transaction, then deletes the loser.
  await assert.rejects(db.query(`DELETE FROM employers WHERE id = $1`, [employer]), refusedBy("application_income_employer_id_fkey", "23503"));
  assert.equal(await count(`FROM application_income WHERE employer_id = $1 AND employment_income`, [employer]), 1);
});

test("23.5-T5: Given a borrower whose `du_declarations` row has `bankruptcy = Yes`, when the transaction commits with no `du_bankruptcy_filings` row, then COMMIT is refused; given the row has `bankruptcy = No`, when a filing is inserted, then COMMIT is refused.", { skip }, async () => {
  const app = await newApplication(); const b = await newBorrower(app, "borrower");
  await assert.rejects(db.tx((q) => insertDeclaration(q, b.id, ownActor(b.party_id), { bankruptcy: "Yes" })), refusedWith("DU_DECLARATION_BANKRUPTCY_CHAPTERS"));
  assert.equal(await count(`FROM du_declarations WHERE application_borrower_id = $1`, [b.id]), 0);
  // Yes with its chapter(s) in the same transaction commits.
  const declId = await db.tx(async (q) => {
    const id = await insertDeclaration(q, b.id, ownActor(b.party_id), { bankruptcy: "Yes", bankruptcy_explanation: "Chapter 7 discharged in 2021 after a medical bankruptcy." });
    await q.query(`INSERT INTO du_bankruptcy_filings (declaration_id, chapter) VALUES ($1, 'ChapterSeven')`, [id]);
    return id;
  });
  // Deleting the last chapter in a later transaction is the same hole, reached from the other side.
  await assert.rejects(db.tx((q) => q.query(`DELETE FROM du_bankruptcy_filings WHERE declaration_id = $1`, [declId])), refusedWith("DU_DECLARATION_BANKRUPTCY_CHAPTERS"));
  assert.equal(await count(`FROM du_bankruptcy_filings WHERE declaration_id = $1`, [declId]), 1);
  // bankruptcy = No, then a filing: refused at COMMIT.
  const b2 = await newBorrower(app, "co_borrower");
  const noId = await db.tx((q) => insertDeclaration(q, b2.id, ownActor(b2.party_id), { bankruptcy: "No" }));
  await assert.rejects(db.tx((q) => q.query(`INSERT INTO du_bankruptcy_filings (declaration_id, chapter) VALUES ($1, 'ChapterThirteen')`, [noId])), refusedWith("DU_DECLARATION_BANKRUPTCY_CHAPTERS"));
  assert.equal(await count(`FROM du_bankruptcy_filings WHERE declaration_id = $1`, [noId]), 0);
  // Flipping the answer to No while a chapter stands is refused too — both directions, from either table.
  await assert.rejects(db.query(`UPDATE du_declarations SET bankruptcy = 'No' WHERE id = $1`, [declId]), refusedWith("DU_DECLARATION_BANKRUPTCY_CHAPTERS"));
});

test("23.5-T6: Given a declarations write whose `asserted_by_actor` is an agent actor, then it is refused with `DU_DECLARATION_NOT_SELF_ATTESTED`; given it is another borrower's actor on the same application, then it is refused with the same code.", { skip }, async () => {
  const app = await newApplication(); const b1 = await newBorrower(app, "borrower"); const b2 = await newBorrower(app, "co_borrower");
  // The borrower app's own agent actor (src/runtime/borrower/commands.ts BORROWER_APP_ACTOR), the underwriter agent,
  // the platform and a human officer: none is the borrower, and all are refused outright.
  for (const actor of [{ kind: "agent", id: "borrower-app" }, { kind: "agent", id: "underwriter" }, { kind: "system", id: "platform" }, { kind: "human", id: "u-officer-1", role: "officer" }]) {
    await assert.rejects(db.tx((q) => insertDeclaration(q, b1.id, actor)), refusedWith("DU_DECLARATION_NOT_SELF_ATTESTED"));
  }
  // Another borrower's own actor on the same application: one borrower does not answer section 5 for another.
  await assert.rejects(db.tx((q) => insertDeclaration(q, b1.id, ownActor(b2.party_id))), refusedWith("DU_DECLARATION_NOT_SELF_ATTESTED"));
  assert.equal(await count(`FROM du_declarations WHERE application_borrower_id = $1`, [b1.id]), 0);
  // The borrower's own actor — kind human, role borrower, id the party behind the row — is accepted, and a later
  // re-assertion by somebody else is refused the same way.
  const id = await db.tx((q) => insertDeclaration(q, b1.id, ownActor(b1.party_id)));
  await assert.rejects(db.query(`UPDATE du_declarations SET asserted_by_actor = $2::jsonb WHERE id = $1`, [id, JSON.stringify(ownActor(b2.party_id))]), refusedWith("DU_DECLARATION_NOT_SELF_ATTESTED"));
  const [back] = await db.query<{ asserted_by_actor: Record<string, unknown> }>(`SELECT asserted_by_actor FROM du_declarations WHERE id = $1`, [id]);
  assert.deepEqual(back!.asserted_by_actor, ownActor(b1.party_id));
  // A borrower row with no party behind it has nobody who could have signed: refused rather than trusted.
  const orphan = (await db.query<{ id: string }>(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name) VALUES ($1, 'co_borrower', 'No session yet') RETURNING id`, [app]))[0]!.id;
  await assert.rejects(db.tx((q) => insertDeclaration(q, orphan, ownActor(b1.party_id))), refusedWith("DU_DECLARATION_NOT_SELF_ATTESTED"));
});

test("23.5-T7: Given a borrower's written bankruptcy explanation submitted on the declarations card, when the row is read back, then `bankruptcy_explanation` holds it verbatim.", { skip }, async () => {
  // The command path the card resolves through: the API executes 32.2's application.answerDeclarations AS the signed-in party's human actor
  // (src/runtime/borrower/commands.ts runCommand — kind human, role borrower, id the session's party; never the borrower-app agent, never the
  // client's claim), and it runs 23.5's assertDeclarations on the bus as that same actor (duTool inherits the command's actor and refuses a caller
  // naming one); the write lands in the command's transaction and du_declarations_are_self_attested judges the actor there. Every other actor
  // is refused at the bus before a row can exist — the input's `party_id` (the API's stamp, or a forged one) never says who declares.
  const app = await newApplication(); const b = await newBorrower(app, "borrower");
  const runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock: new FixedClock("2026-09-14T12:00:00.000Z") });
  const explanation = "Chapter 7 in 2021 after my spouse's medical bills — discharged 2022-03-04; every account since has been paid on time.\n  Second line, with \"quotes\", a tab\tand an em dash — kept exactly as I typed it. ";
  const answers = { intent_to_occupy: "Yes", undisclosed_borrowed_funds: "No", undisclosed_mortgage_application: "No", undisclosed_credit_application: "No", property_proposed_clean_energy_lien: "No", undisclosed_comaker_of_note: "No", outstanding_judgments: "No", presently_delinquent: "No", party_to_lawsuit: "No", prior_property_deed_in_lieu_conveyed: "No", prior_property_short_sale_completed: "No", prior_property_foreclosure_completed: "No", bankruptcy: "Yes", special_borrower_seller_relationship: "No" };
  const input = { application_id: app, party_id: b.party_id, application_borrower_id: b.id, borrower_id: b.id, answers, follow_ups: { homeowner_past_three_years: "No" }, bankruptcy_chapters: ["ChapterSeven"], bankruptcy_explanation: explanation, card_instance_id: randomUUID() };
  const run = (actor: { kind: string; id: string; role?: string }, extra: Record<string, unknown> = {}) => runtime.execute({ process: "32.2", name: "application.answerDeclarations", loanId: "", applicationId: app, actor: actor as Actor, input: { ...input, ...extra } });
  const busRefused = (code: string) => (e: unknown): boolean => { assert.equal((e as Error).name, "CommandRefused", (e as Error).message); assert.equal((e as { code?: string }).code, code, (e as Error).message); return true; };
  // Not the borrower: the app's own agent (allowlisted for the command, which is still a human act), the platform's sweep and an ops analyst —
  // each carrying the borrower's party_id in the input as a forged claim — are refused at the bus, and no row exists afterwards.
  await assert.rejects(run({ kind: "agent", id: "borrower-app" }), busRefused("HUMAN_ONLY"));
  await assert.rejects(run({ kind: "system", id: "sweep" }), busRefused("DU_DECLARATION_NOT_SELF_ATTESTED"));
  await assert.rejects(run({ kind: "human", id: "ops-1", role: "ops_analyst" }), busRefused("ROLE_DENIED"));
  await assert.rejects(run({ kind: "human", id: "u-officer-1", role: "officer" }), busRefused("ROLE_DENIED"));
  assert.equal(await count(`FROM du_declarations WHERE application_borrower_id = $1`, [b.id]), 0, "nothing of a refused command reached the table");
  assert.equal(await count(`FROM loan_events WHERE application_id = $1 AND type = 'du.graph.declaration.asserted'`, [app]), 0, "and no event says otherwise");
  // The borrower's own session: the command's actor is the row's actor, and every command.executed of the path — the nested 23.5 one included — names the borrower.
  const r = await run(ownActor(b.party_id));
  const out = r.output as Record<string, unknown>;
  assert.equal(out["asserted_in_du_graph"], true); assert.equal(out["none_apply"], false);
  assert.deepEqual(out["asserted_by"], ownActor(b.party_id), "the row's actor is the command's own — the borrower's session, not anything the input said");
  assert.ok(r.events.some((e) => e.type === "du.graph.declaration.asserted" && e.actor.kind === "human" && e.actor.id === b.party_id), "du.graph.declaration.asserted by the borrower's own actor");
  assert.ok(r.events.filter((e) => e.type === "command.executed").length >= 2 && r.events.filter((e) => e.type === "command.executed").every((e) => e.actor.kind === "human" && e.actor.id === b.party_id && e.actor.role === "borrower"), "the examiner's record (who asserted each declaration) shows the borrower because the borrower executed it — the outer 32.2 command and the nested 23.5 one");
  assert.ok(r.events.some((e) => e.type === "application.declarations.answered"), "the flows' own event still follows (the demographics card)");
  const row = (await db.query<{ bankruptcy_explanation: string; bankruptcy: string; asserted_by_actor: Record<string, unknown>; intent_to_occupy: string; homeowner_past_three_years: string | null }>(`SELECT bankruptcy_explanation, bankruptcy, asserted_by_actor, intent_to_occupy, homeowner_past_three_years FROM du_declarations WHERE application_borrower_id = $1`, [b.id]))[0]!;
  assert.equal(row.bankruptcy_explanation, explanation, "verbatim — every character, the newline, the tab and the trailing space");
  assert.equal(row.bankruptcy, "Yes"); assert.equal(row.intent_to_occupy, "Yes"); assert.equal(row.homeowner_past_three_years, "No");
  assert.deepEqual(row.asserted_by_actor, ownActor(b.party_id));
  assert.deepEqual((await db.query<{ chapter: string }>(`SELECT f.chapter FROM du_bankruptcy_filings f JOIN du_declarations d ON d.id = f.declaration_id WHERE d.application_borrower_id = $1`, [b.id])).map((x) => x.chapter), ["ChapterSeven"]);
  assert.equal(await count(`FROM agent_decisions WHERE application_id = $1 AND agent = 'underwriter'`, [app]), 0, "no decision row of the 23.5 tool's own (23.5 AI agent design: the write cites the producing decision)");
  // Re-asserting (the card answered again) rewrites the one row per borrower as the whole section 5 of this request: bankruptcy Yes → No sheds its
  // chapters, 5a.A Yes → No sheds the follow-up it carried (written NULL — du_declarations_homeowner_follows_intent would refuse the row otherwise),
  // and the new explanation is kept verbatim.
  const again = "Second statement: nothing to add.";
  await run(ownActor(b.party_id), { answers: { ...answers, bankruptcy: "No", intent_to_occupy: "No" }, follow_ups: {}, bankruptcy_chapters: [], bankruptcy_explanation: again, card_instance_id: randomUUID() });
  assert.deepEqual((await db.query<{ e: string; n: string; i: string; h: string | null }>(`SELECT d.bankruptcy_explanation AS e, (SELECT count(*) FROM du_bankruptcy_filings f WHERE f.declaration_id = d.id)::text AS n, d.intent_to_occupy AS i, d.homeowner_past_three_years AS h FROM du_declarations d WHERE d.application_borrower_id = $1`, [b.id])), [{ e: again, n: "0", i: "No", h: null }]);
  assert.equal(await count(`FROM du_declarations WHERE application_borrower_id = $1`, [b.id]), 1, "one row per borrower");
  // The underwriter agent may not assert a declaration at all: the bus refuses it as a human act before any row is written (T6 is the database's own refusal of an agent actor).
  await assert.rejects(runtime.execute({ process: "23.5", name: "assertDeclarations", loanId: "", applicationId: app, actor: { kind: "agent", id: "underwriter" }, input: { application_id: app, application_borrower_id: b.id, answers, bankruptcy_chapters: ["ChapterSeven"] } }), busRefused("HUMAN_ONLY"));
  // And another borrower's own session naming this borrower's row is refused by the database with the spec's code (the same trigger T6 exercises), through the
  // same command path — the borrower's party_id in the input (the forged claim) changes nothing, because the actor is what the trigger judges.
  const other = await newBorrower(app, "co_borrower");
  await assert.rejects(run(ownActor(other.party_id), { party_id: b.party_id }), refusedWith("DU_DECLARATION_NOT_SELF_ATTESTED"));
  assert.equal((await db.query<{ e: string }>(`SELECT bankruptcy_explanation AS e FROM du_declarations WHERE application_borrower_id = $1`, [b.id]))[0]!.e, again, "nothing of the refused command reached the row");
});

test("23.5-T8: Given a borrower with a Prior residence and no Current one, when the transaction commits, then it is refused; given `residency_basis = Rent` and `monthly_rent_cents IS NULL`, then the CHECK refuses the row.", { skip }, async () => {
  const app = await newApplication(); const b = await newBorrower(app, "borrower");
  const prior = `INSERT INTO du_residences (application_borrower_id, residency_type, residency_basis, monthly_rent_cents, address_line_text, city_name, state_code, postal_code, duration_months) VALUES ($1, 'Prior', 'Rent', 120000, '9 Old Rd', 'Peoria', 'IL', '61602', 18)`;
  await assert.rejects(db.tx((q) => q.query(prior, [b.id])), refusedWith("DU_RESIDENCE_NO_CURRENT_HOME"));
  assert.equal(await count(`FROM du_residences WHERE application_borrower_id = $1`, [b.id]), 0);
  // Rent with no amount: the CHECK refuses the row at the statement (required iff Rent — so an amount on an Own basis is refused too).
  await assert.rejects(db.query(`INSERT INTO du_residences (application_borrower_id, residency_type, residency_basis, monthly_rent_cents, duration_months) VALUES ($1, 'Current', 'Rent', NULL, 6)`, [b.id]), refusedBy("du_residences_rent_iff_rent_basis"));
  await assert.rejects(db.query(`INSERT INTO du_residences (application_borrower_id, residency_type, residency_basis, monthly_rent_cents, duration_months) VALUES ($1, 'Current', 'Own', 100, 6)`, [b.id]), refusedBy("du_residences_rent_iff_rent_basis"));
  // A Current Rent with its amount and the Prior one together commit; a second Current is a unique-index violation.
  await db.tx(async (q) => {
    await q.query(`INSERT INTO du_residences (application_borrower_id, residency_type, residency_basis, monthly_rent_cents, address_line_text, city_name, state_code, postal_code, duration_months) VALUES ($1, 'Current', 'Rent', 185000, '12 New St', 'Springfield', 'IL', '62701', 6)`, [b.id]);
    await q.query(prior, [b.id]);
  });
  await assert.rejects(db.query(`INSERT INTO du_residences (application_borrower_id, residency_type, residency_basis, duration_months) VALUES ($1, 'Current', 'Own', 1)`, [b.id]), refusedBy("du_residences_one_current_per_borrower", "23505"));
  // Deleting the Current row while a Prior remains is refused at COMMIT; deleting the whole set is not (the borrower has not answered).
  await assert.rejects(db.tx((q) => q.query(`DELETE FROM du_residences WHERE application_borrower_id = $1 AND residency_type = 'Current'`, [b.id])), refusedWith("DU_RESIDENCE_NO_CURRENT_HOME"));
  await db.tx((q) => q.query(`DELETE FROM du_residences WHERE application_borrower_id = $1`, [b.id]));
  assert.equal(await count(`FROM du_residences WHERE application_borrower_id = $1`, [b.id]), 0);
  // A residence on a non-borrowing party has nowhere to go on the wire.
  const spouse = await newBorrower(app, "non_borrowing_spouse");
  await assert.rejects(db.query(`INSERT INTO du_residences (application_borrower_id, residency_type, residency_basis, duration_months) VALUES ($1, 'Current', 'LivingRentFree', 24)`, [spouse.id]), refusedWith("DU_GRAPH_OWNER_NOT_A_BORROWER"));
});

test("23.5-T9: Given an application with Borrower 1, when three more borrowing parties are appended concurrently, then they receive ordinals 2, 3 and 4 with no duplicate; when a fifth is appended, then it is refused.", { skip }, async () => {
  const app = await newApplication();
  const first = await newBorrower(app, "borrower");
  assert.equal(first.borrower_ordinal, 1, "Borrower 1 is allocated on insert");
  // Three connections, three concurrent appends: the allocator takes a row lock on the application and hands out the
  // smallest free position, so the three serialize on the lock rather than each reading the same free position.
  const clients = [new pg.Client({ connectionString: DB_URL }), new pg.Client({ connectionString: DB_URL }), new pg.Client({ connectionString: DB_URL })];
  try {
    await Promise.all(clients.map((c) => c.connect()));
    const ordinals = await Promise.all(clients.map(async (c, i) => {
      const r = await c.query(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name) VALUES ($1, $2, $3) RETURNING borrower_ordinal`, [app, i === 2 ? "non_occupant_co_borrower" : "co_borrower", `Concurrent ${i + 1}`]);
      return Number((r.rows[0] as { borrower_ordinal: number }).borrower_ordinal);
    }));
    assert.deepEqual([...ordinals].sort(), [2, 3, 4]);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  }
  const [all] = await db.query<{ ordinals: number[]; n: string }>(`SELECT array_agg(borrower_ordinal ORDER BY borrower_ordinal) AS ordinals, count(DISTINCT borrower_ordinal)::text AS n FROM application_borrowers WHERE application_id = $1`, [app]);
  assert.deepEqual(all!.ordinals, [1, 2, 3, 4]); assert.equal(Number(all!.n), 4, "no duplicate");
  // A fifth borrowing party: the allocator finds no free position and the CHECK refuses the row — DU permits four.
  await assert.rejects(db.query(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name) VALUES ($1, 'co_borrower', 'Fifth')`, [app]), refusedBy("application_borrowers_borrower_ordinal_is_one_to_four"));
  // A non-borrowing spouse holds no position and is not one of the four.
  const spouse = await newBorrower(app, "non_borrowing_spouse");
  assert.equal(spouse.borrower_ordinal, null);
  // A second Borrower 1 stated by a caller is refused by the one-first-borrower index, not by a position collision.
  await assert.rejects(db.query(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name, borrower_ordinal) VALUES ($1, 'co_borrower', 'Another first', 1)`, [app]), refusedBy("application_borrowers_one_first_borrower", "23505"));

  // Borrower 1 is the `borrower` role — the primary applicant — regardless of the order the rows were written in.
  const positions = async (appId: string) => db.query<{ legal_name: string; borrower_role: string; borrower_ordinal: number | null }>(`SELECT legal_name, borrower_role, borrower_ordinal FROM application_borrowers WHERE application_id = $1 ORDER BY borrower_ordinal NULLS LAST, legal_name`, [appId]);
  // (a) The backfill the migration ran over rows that existed before it (seeded in test.before, before *_du_graph.sql
  // was applied): two borrowers inserted in ONE transaction share a created_at, the co-borrower's uuid sorts first,
  // and the `borrower` role still holds 1 — the backfill orders by role before created_at and id.
  const [tie] = await db.query<{ n: string }>(`SELECT count(DISTINCT created_at)::text AS n FROM application_borrowers WHERE application_id = $1`, [backfill.tied.app]);
  assert.equal(Number(tie!.n), 1, "one transaction, one created_at for both rows");
  assert.ok(backfill.tied.co < backfill.tied.borrower, "the co-borrower's uuid sorts first");
  assert.deepEqual(await positions(backfill.tied.app), [{ legal_name: "Primary Pat", borrower_role: "borrower", borrower_ordinal: 1 }, { legal_name: "Co Chris", borrower_role: "co_borrower", borrower_ordinal: 2 }]);
  assert.deepEqual(await positions(backfill.coFirst.app), [{ legal_name: "Primary Pam", borrower_role: "borrower", borrower_ordinal: 1 }, { legal_name: "Co Cam", borrower_role: "co_borrower", borrower_ordinal: 2 }], "a co-borrower who joined first is still Borrower 2");
  assert.deepEqual(await positions(backfill.spouseOnly.app), [{ legal_name: "Spouse Sam", borrower_role: "non_borrowing_spouse", borrower_ordinal: null }]);
  // (b) The runtime allocator agrees: PgApplicationRepository.create inserts every borrower in the caller's
  // transaction, in input order — a refinance copies the prior application's rows in (created_at, id) order, so the
  // co-borrower may well come first — and the `borrower` role is handed 1 whenever it arrives, the others 2 upward.
  const repo = new PgApplicationRepository(db);
  const created = await db.tx((q) => repo.create({ partner_party_id: partnerPartyId, channel: "refi_trigger", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ legal_name: "Co Cam", borrower_role: "co_borrower" }, { legal_name: "Primary Pam", borrower_role: "borrower" }, { legal_name: "Spouse Sam", borrower_role: "non_borrowing_spouse" }] }, q));
  assert.deepEqual(await positions(created.id), [{ legal_name: "Primary Pam", borrower_role: "borrower", borrower_ordinal: 1 }, { legal_name: "Co Cam", borrower_role: "co_borrower", borrower_ordinal: 2 }, { legal_name: "Spouse Sam", borrower_role: "non_borrowing_spouse", borrower_ordinal: null }]);

  // The unit of work's shape: a command's loan_events row (application_id → applications, which holds FOR KEY SHARE
  // on the application) lands BEFORE its deferred `commit` hook appends the borrower (32.2 inviteParty, Phase 4
  // appendBorrower). Two such commands at once must serialize on the allocator's lock and nothing else: a FOR UPDATE
  // allocator conflicts with the KEY SHARE the other command's event holds — the two deadlock, and any append waits
  // behind every open command that merely references the application; FOR NO KEY UPDATE conflicts only with itself.
  const app2 = await newApplication(); await newBorrower(app2, "borrower");
  const A = await client(); const B = await client();
  try {
    const event = (c: pg.Client, who: string) => c.query(`INSERT INTO loan_events (type, application_id, actor_kind, actor_id, payload) VALUES ('application.party.invited', $1, 'agent', 'borrower-app', $2::jsonb)`, [app2, JSON.stringify({ command: who })]);
    const append = async (c: pg.Client, name: string): Promise<number> => Number(((await c.query(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name) VALUES ($1, 'co_borrower', $2) RETURNING borrower_ordinal`, [app2, name])).rows[0] as { borrower_ordinal: number }).borrower_ordinal);
    await A.query("BEGIN"); await B.query("BEGIN");
    // A FOR UPDATE allocator would make A's append wait for B's whole command; a lock_timeout turns that regression
    // into a refusal (55P03) here rather than a hung test.
    await A.query("SET LOCAL lock_timeout = '5s'"); await B.query("SET LOCAL lock_timeout = '5s'");
    await event(A, "A"); await event(B, "B");
    assert.equal(await append(A, "Command A"), 2, "A's append is not blocked by the KEY SHARE B's event holds");
    const pb = append(B, "Command B"); pb.catch(() => undefined);
    assert.equal(await settled(pb), "pending", "B's append waits for A's allocator lock — and does not deadlock with it");
    await A.query("COMMIT");
    assert.equal(await pb, 3, "B sees A's committed position and takes the next");
    await B.query("COMMIT");
  } finally {
    await Promise.all([A, B].map((c) => c.end().catch(() => undefined)));
  }
  assert.deepEqual((await positions(app2)).map((r) => r.borrower_ordinal), [1, 2, 3]);
});

test("23.5-T10: Given `applications.du_casefile_id` set to `1234567890`, when the same value is written again, then it is a no-op; when `0987654321` is written, then the update raises `DU_CASEFILE_ID_WRITE_ONCE`.", { skip }, async () => {
  const app = await newApplication();
  const read = async (): Promise<string | null> => (await db.query<{ du_casefile_id: string | null }>(`SELECT du_casefile_id FROM applications WHERE id = $1`, [app]))[0]!.du_casefile_id;
  assert.equal(await read(), null, "null until a submission has been answered");
  await db.query(`UPDATE applications SET du_casefile_id = '1234567890' WHERE id = $1`, [app]);
  assert.equal(await read(), "1234567890");
  await db.query(`UPDATE applications SET du_casefile_id = '1234567890' WHERE id = $1`, [app]);   // the same value again: a no-op, not an error
  assert.equal(await read(), "1234567890");
  await assert.rejects(db.query(`UPDATE applications SET du_casefile_id = '0987654321' WHERE id = $1`, [app]), refusedWith("DU_CASEFILE_ID_WRITE_ONCE"));
  await assert.rejects(db.query(`UPDATE applications SET du_casefile_id = NULL WHERE id = $1`, [app]), refusedWith("DU_CASEFILE_ID_WRITE_ONCE"));
  assert.equal(await read(), "1234567890");
  // Unique where not null: a second application cannot carry the case DU named for the first.
  const other = await newApplication();
  await assert.rejects(db.query(`UPDATE applications SET du_casefile_id = '1234567890' WHERE id = $1`, [other]), refusedBy("applications_du_casefile_id_key", "23505"));
});

test("23.5-T11: Given each of the 22 DU `AssetType` values, when written under a `kind` whose URLA section does not admit it, then the per-kind CHECK refuses the row; when written under the admitting kind, then it is accepted — and the three admitted lists partition the 22 with no overlap.", { skip }, async () => {
  const KINDS: Record<string, { section: keyof typeof DU_ASSET_TYPES_BY_SECTION; constraint: string }> = {
    DEPOSIT_ACCOUNT: { section: "2a.1", constraint: "du_assets_deposit_account_shape" },
    OTHER_ASSET: { section: "2b.1", constraint: "du_assets_other_asset_shape" },
    GIFT_OR_GRANT: { section: "4d.1", constraint: "du_assets_gift_or_grant_shape" },
  };
  const all: readonly string[] = DU_ENUMERATIONS.DuAssetType ?? [];
  assert.equal(all.length, 22, "enums.ts carries DuAssetType");
  // The partition: pairwise disjoint, and their union is the 22.
  const lists = Object.values(KINDS).map((k) => [...(DU_ASSET_TYPES_BY_SECTION[k.section] as readonly string[])]);
  assert.deepEqual(lists.map((l) => l.length), [13, 6, 3]);
  const union = new Set(lists.flat());
  assert.equal(union.size, 22, "no overlap"); assert.deepEqual([...union].sort(), [...all].sort());
  const app = await newApplication(); const v = await newVerification(app); const b = await newBorrower(app, "borrower");
  let accepted = 0; let refused = 0;
  for (const value of all) {
    for (const [kind, k] of Object.entries(KINDS)) {
      const admits = (DU_ASSET_TYPES_BY_SECTION[k.section] as readonly string[]).includes(value);
      const row: AssetRow = { kind, asset_type: value, cash_or_market_value_cents: 100n, identity_key: `manual:${kind}:${value}`,
        asset_type_other_description: value === "Other" ? "OtherLiquidAsset" : null,
        institution_name: kind === "DEPOSIT_ACCOUNT" ? "FAKE Bank" : null,
        funds_source_type: kind === "GIFT_OR_GRANT" ? "Relative" : null };
      const write = db.tx(async (q) => { const id = await insertAsset(q, app, v, row); await q.query(`INSERT INTO du_asset_parties (asset_id, application_borrower_id) VALUES ($1, $2)`, [id, b.id]); });
      if (admits) { await write; accepted += 1; }
      else { await assert.rejects(write, (e: unknown) => { const err = e as PgError; assert.equal(err.code, "23514", `${kind}/${value}: ${err.message}`); assert.equal(err.constraint, k.constraint, `${kind}/${value} is refused by its kind's own CHECK`); return true; }); refused += 1; }
    }
  }
  assert.equal(accepted, 22); assert.equal(refused, 44);
  assert.equal(await count(`FROM du_assets WHERE application_id = $1 AND retired_at IS NULL`, [app]), 22);
  // An OWNED_PROPERTY row carries no AssetType at all (it has no ASSET_DETAIL), and a row of the other three kinds
  // cannot leave the type blank: NULL IN (…) is NULL and the CHECKs spell `asset_type IS NOT NULL` beside each list.
  await assert.rejects(db.tx((q) => insertAsset(q, app, v, { kind: "OWNED_PROPERTY", asset_type: "CheckingAccount" })), refusedBy("du_assets_owned_property_carries_no_asset_detail"));
  await assert.rejects(db.tx((q) => insertAsset(q, app, v, { kind: "DEPOSIT_ACCOUNT", asset_type: null, institution_name: "FAKE Bank", cash_or_market_value_cents: 1n })), refusedBy("du_assets_deposit_account_shape"));
  // And a value in no DU enumeration at all is refused by the same CHECKs — the list is the whole vocabulary.
  await assert.rejects(db.tx((q) => insertAsset(q, app, v, { kind: "OTHER_ASSET", asset_type: "SecuredBorrowedFundsNotDeposited", cash_or_market_value_cents: 1n })), refusedBy("du_assets_other_asset_shape"));
});

test("23.5-T12: Given two borrowers linked by `du_joint_credit_report_links`, when a third is linked to the same primary, then the group has one primary; when a link is written whose `to_` borrower already belongs to another group, then it is refused.", { skip }, async () => {
  const app = await newApplication();
  const b1 = await newBorrower(app, "borrower"); const b2 = await newBorrower(app, "co_borrower"); const b3 = await newBorrower(app, "co_borrower"); const b4 = await newBorrower(app, "non_occupant_co_borrower");
  const link = (from: string, to: string) => db.query(`INSERT INTO du_joint_credit_report_links (application_id, from_application_borrower_id, to_application_borrower_id) VALUES ($1, $2, $3)`, [app, from, to]);
  await link(b2.id, b1.id);                      // b2 shares b1's report: b1 is the group's primary (`to`)
  await link(b3.id, b1.id);                      // a third borrower joins the same group
  const [group] = await db.query<{ primaries: string; members: string }>(`SELECT count(DISTINCT to_application_borrower_id)::text AS primaries, count(*)::text AS members FROM du_joint_credit_report_links WHERE application_id = $1`, [app]);
  assert.equal(Number(group!.primaries), 1, "one primary"); assert.equal(Number(group!.members), 2);
  // b2 is an additional borrower in b1's group; a link naming b2 as a `to_` (primary) is two contradictory groups.
  await assert.rejects(link(b4.id, b2.id), refusedWith("DU_JOINT_CREDIT_GROUP"));
  // b1 is a group primary; a link making b1 somebody's additional borrower is refused the same way.
  await assert.rejects(link(b1.id, b4.id), refusedWith("DU_JOINT_CREDIT_GROUP"));
  // One group per additional borrower: b2 cannot also share b4's report.
  await assert.rejects(link(b2.id, b4.id), refusedBy("du_joint_credit_links_one_group_per_additional_borrower", "23505"));
  // Reflexive links, another application's borrower and non-borrowing parties are refused before any group question.
  await assert.rejects(link(b4.id, b4.id), refusedBy("du_joint_credit_links_are_not_reflexive"));
  const elsewhere = await newBorrower(await newApplication(), "borrower");
  await assert.rejects(link(elsewhere.id, b1.id), refusedWith("DU_GRAPH_CROSSES_APPLICATIONS"));
  const spouse = await newBorrower(app, "non_borrowing_spouse");
  await assert.rejects(link(spouse.id, b1.id), refusedWith("DU_GRAPH_OWNER_NOT_A_BORROWER"));
  assert.equal(await count(`FROM du_joint_credit_report_links WHERE application_id = $1`, [app]), 2);
});

test("23.5-T13: Given a `du_owned_properties` row, when a caller writes `application_id` different from its asset's, then the trigger overwrites it with the asset's; when a caller writes `lien_upb_cents`, then the value is discarded and re-derived.", { skip }, async () => {
  const app = await newApplication(); const other = await newApplication(); const v = await newVerification(app); const b = await newBorrower(app, "borrower");
  const read = async (id: string) => (await db.query<{ application_id: string; lien_upb_cents: bigint | null; asset_kind: string }>(`SELECT application_id, lien_upb_cents, asset_kind FROM du_owned_properties WHERE id = $1`, [id]))[0]!;
  const { propertyId } = await db.tx((q) => insertOwnedProperty(q, app, v, b.id, { application_id: other }));
  assert.equal((await read(propertyId)).application_id, app, "the caller's application_id was overwritten with the asset's");
  await db.query(`UPDATE du_owned_properties SET application_id = $2 WHERE id = $1`, [propertyId, other]);
  assert.equal((await read(propertyId)).application_id, app);
  // lien_upb_cents: a caller's value is discarded and re-derived — NULL with no live liability, the live total with one.
  await db.query(`UPDATE du_owned_properties SET lien_upb_cents = 99999 WHERE id = $1`, [propertyId]);
  assert.equal((await read(propertyId)).lien_upb_cents, null);
  await db.tx((q) => insertLiability(q, app, v, b.id, { liability_type: "MortgageLoan", unpaid_balance_cents: 12_345_600n, secured_by: propertyId }));
  await db.query(`UPDATE du_owned_properties SET lien_upb_cents = 1 WHERE id = $1`, [propertyId]);
  assert.equal((await read(propertyId)).lien_upb_cents, 12_345_600n);
  // The composite foreign key: an owned property hangs only off an OWNED_PROPERTY asset (asset_kind is generated).
  assert.equal((await read(propertyId)).asset_kind, "OWNED_PROPERTY");
  const deposit = await db.tx(async (q) => { const id = await insertAsset(q, app, v, { kind: "DEPOSIT_ACCOUNT", asset_type: "SavingsAccount", institution_name: "FAKE Bank", cash_or_market_value_cents: 1n }); await q.query(`INSERT INTO du_asset_parties (asset_id, application_borrower_id) VALUES ($1, $2)`, [id, b.id]); return id; });
  await assert.rejects(db.query(`INSERT INTO du_owned_properties (asset_id, application_id, address_line_text, city_name, state_code, postal_code, disposition) VALUES ($1, $2, '1 A St', 'X', 'IL', '60000', 'Sold')`, [deposit, app]), refusedBy("du_owned_properties_attach_to_an_reo_asset", "23503"));
  // One subject property per application.
  await db.tx((q) => insertOwnedProperty(q, app, v, b.id, { is_subject: true }));
  await assert.rejects(db.tx((q) => insertOwnedProperty(q, app, v, b.id, { is_subject: true })), refusedBy("du_owned_properties_one_subject_per_application", "23505"));
});

test("23.5-T14: Given a borrowing party demoted to `non_borrowing_spouse` while sole owner of a live asset, then the role change is refused until the asset is repointed or retired.", { skip }, async () => {
  const app = await newApplication(); const v = await newVerification(app); const b1 = await newBorrower(app, "borrower"); const b2 = await newBorrower(app, "co_borrower");
  const assetId = await db.tx(async (q) => { const id = await insertAsset(q, app, v, { kind: "DEPOSIT_ACCOUNT", asset_type: "CheckingAccount", institution_name: "FAKE Bank", cash_or_market_value_cents: 250000n }); await q.query(`INSERT INTO du_asset_parties (asset_id, application_borrower_id) VALUES ($1, $2)`, [id, b2.id]); return id; });
  const demote = () => db.query(`UPDATE application_borrowers SET borrower_role = 'non_borrowing_spouse' WHERE id = $1`, [b2.id]);
  await assert.rejects(demote(), refusedWith("DU_GRAPH_BORROWER_ROLE_IN_USE"));
  const role = async (id: string) => (await db.query<{ borrower_role: string; borrower_ordinal: number | null }>(`SELECT borrower_role, borrower_ordinal FROM application_borrowers WHERE id = $1`, [id]))[0]!;
  assert.deepEqual(await role(b2.id), { borrower_role: "co_borrower", borrower_ordinal: 2 });
  // Repoint: a second owner arc and the first one removed — the asset is b1's now, and b2 may be demoted.
  await db.tx(async (q) => { await q.query(`INSERT INTO du_asset_parties (asset_id, application_borrower_id) VALUES ($1, $2)`, [assetId, b1.id]); await q.query(`DELETE FROM du_asset_parties WHERE asset_id = $1 AND application_borrower_id = $2`, [assetId, b2.id]); });
  await demote();
  assert.deepEqual(await role(b2.id), { borrower_role: "non_borrowing_spouse", borrower_ordinal: null }, "a non-borrowing role holds no position; ordinal 2 is freed");
  // Retire is the other way out: a third borrower, sole owner of a live asset, is demotable once the asset is retired.
  const b3 = await newBorrower(app, "co_borrower");
  assert.equal(b3.borrower_ordinal, 2, "the freed position is reused; survivors are never renumbered");
  const soleId = await db.tx(async (q) => { const id = await insertAsset(q, app, v, { kind: "OTHER_ASSET", asset_type: "CashOnHand", cash_or_market_value_cents: 1000n }); await q.query(`INSERT INTO du_asset_parties (asset_id, application_borrower_id) VALUES ($1, $2)`, [id, b3.id]); return id; });
  await assert.rejects(db.query(`UPDATE application_borrowers SET borrower_role = 'trustee' WHERE id = $1`, [b3.id]), refusedWith("DU_GRAPH_BORROWER_ROLE_IN_USE"));
  await db.query(`UPDATE du_assets SET retired_by_verification_id = $2 WHERE id = $1`, [soleId, v]);
  await db.query(`UPDATE application_borrowers SET borrower_role = 'trustee' WHERE id = $1`, [b3.id]);
  assert.deepEqual(await role(b3.id), { borrower_role: "trustee", borrower_ordinal: null });
  // A declaration or a residence pins the role the same way.
  const b4 = await newBorrower(app, "co_borrower");
  await db.tx((q) => insertDeclaration(q, b4.id, ownActor(b4.party_id)));
  await assert.rejects(db.query(`UPDATE application_borrowers SET borrower_role = 'non_borrowing_spouse' WHERE id = $1`, [b4.id]), refusedWith("DU_GRAPH_BORROWER_ROLE_IN_USE"));
});
