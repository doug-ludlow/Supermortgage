/**
 * The writer's signature discipline, against Postgres: a row and its owners together, inside a transaction or not at
 * all; a re-pull that matches in place and revives; a supersede that retires in the same transaction; the employer's
 * named rules (identity.ts EMPLOYER_IDENTITY_RULES) as the database sees them; and the borrower reference resolver.
 * The 23.5 T-ids (23-5.spec.test.ts) prove what the DATABASE refuses; this file proves what the writer refuses before
 * the database has to. Own database from src/infra/db/test-db.ts, dropped and created per run; skips without Postgres
 * (REQUIRE_DB=1 makes that a failure).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { connect, type Db, type Queryable } from "../../../infra/db/client.ts";
import { testDatabase } from "../../../infra/db/test-db.ts";
import { encodeEntityData } from "../../../infra/db/entities.ts";
import { writeAsset, writeLiability, writeExpense, writeOwnedProperty, writeEmployer, mergeEmployers, assertDeclarations, writeResidence, resolveBorrowerEdge, deterministicUuid, assertInsideTransaction, DU_DECLARATION_ANSWERS, type DuOwner, type NonEmpty } from "./writer.ts";
import { assetIdentityKeys } from "./identity.ts";
import { readDuGraph } from "./graph.ts";
import { Runtime } from "../../../runtime/app.ts";
import { loadOverriddenRegistry } from "../../timer-overrides.ts";
import { FixedClock } from "../../../kernel/events/index.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);

let db: Db; let partner = "";
test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  partner = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name) VALUES ('servicer', 'FAKE Partner du_writer') RETURNING id`))[0]!.id;
});
test.after(async () => { if (db) await db.end(); });

const newApplication = async (): Promise<string> => (await db.query<{ id: string }>(`INSERT INTO applications (partner_party_id, channel, transaction_type, occupancy) VALUES ($1, 'organic', 'purchase', 'primary') RETURNING id`, [partner]))[0]!.id;
const newBorrower = async (app: string, role = "co_borrower", legalName = `Borrower ${randomUUID().slice(0, 8)}`): Promise<{ id: string; party_id: string; legal_name: string }> => {
  const party = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name) VALUES ('borrower', $1) RETURNING id`, [legalName]))[0]!.id;
  const id = (await db.query<{ id: string }>(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name, party_id) VALUES ($1, $2, $3, $4) RETURNING id`, [app, role, legalName, party]))[0]!.id;
  return { id, party_id: party, legal_name: legalName };
};
const newVerification = async (app: string): Promise<string> => (await db.query<{ verification_id: string }>(`INSERT INTO verifications (application_id, kind, component, supplier_code, report_reference_id, vendor_data_as_of) VALUES ($1, 'assets', 'assets', 'FAKE', $2, CURRENT_DATE) RETURNING verification_id`, [app, `R-${randomUUID().slice(0, 8)}`]))[0]!.verification_id;
const owners = (...ids: string[]): NonEmpty<DuOwner> => ids.map((id) => ({ applicationBorrowerId: id })) as unknown as NonEmpty<DuOwner>;
const checking = (app: string, v: string, key: string, balance: bigint) => ({ application_id: app, kind: "DEPOSIT_ACCOUNT", asset_type: "CheckingAccount", institution_name: "First Federal", account_last4: "4455", cash_or_market_value_cents: balance, identity_key: key, source_verification_id: v, first_seen_verification_id: v, last_seen_verification_id: v });
const count = async (sql: string, params: unknown[]): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n ${sql}`, params))[0]!.n);

test("the writer refuses to run outside a transaction — the pool, and a bare client that autocommits", { skip }, async () => {
  const app = await newApplication(); const b = await newBorrower(app, "borrower"); const v = await newVerification(app);
  // The pool (Db) can open transactions, so it is not inside one: refused structurally, before any statement.
  await assert.rejects(writeAsset(db, { asset: checking(app, v, `manual:${randomUUID()}`, 1n), owners: owners(b.id) }), /DU_WRITER_OUTSIDE_TRANSACTION/);
  // A plain client with no BEGIN: every statement is its own transaction, so two reads of pg_current_xact_id() disagree.
  const c = new pg.Client({ connectionString: DB_URL }); await c.connect();
  const bare: Queryable = { query: async (sql, params = []) => (await c.query(sql, [...params])).rows };
  try {
    await assert.rejects(assertInsideTransaction(bare, "writeAsset"), /DU_WRITER_OUTSIDE_TRANSACTION.*two statements/);
    await assert.rejects(writeAsset(bare, { asset: checking(app, v, `manual:${randomUUID()}`, 1n), owners: owners(b.id) }), /DU_WRITER_OUTSIDE_TRANSACTION/);
    // The same client inside BEGIN … COMMIT is inside one.
    await c.query("BEGIN");
    const r = await writeAsset(bare, { asset: checking(app, v, `manual:${randomUUID()}`, 100n), owners: owners(b.id) });
    await c.query("COMMIT");
    assert.equal(await count(`FROM du_asset_parties WHERE asset_id = $1`, [r.id]), 1);
  } finally { await c.end(); }
  assert.equal(await count(`FROM du_assets WHERE application_id = $1`, [app]), 1, "only the transactional write landed");
});

test("a row and its owners are written together; no owner, a duplicate owner, prior keys without matching, and both replacements are refused before any statement", { skip }, async () => {
  const app = await newApplication(); const b1 = await newBorrower(app, "borrower"); const b2 = await newBorrower(app); const v = await newVerification(app);
  const r = await db.tx((q) => writeAsset(q, { asset: checking(app, v, `manual:${randomUUID()}`, 50_000n), owners: owners(b1.id, b2.id) }));
  assert.equal(r.matched, false); assert.equal(await count(`FROM du_asset_parties WHERE asset_id = $1`, [r.id]), 2);
  await assert.rejects(db.tx((q) => writeAsset(q, { asset: checking(app, v, `manual:${randomUUID()}`, 1n), owners: [] as unknown as NonEmpty<DuOwner> })), /DU_GRAPH_ORPHAN/);
  await assert.rejects(db.tx((q) => writeAsset(q, { asset: checking(app, v, `manual:${randomUUID()}`, 1n), owners: owners(b1.id, b1.id) })), /DU_GRAPH_DUPLICATE_OWNER/);
  await assert.rejects(db.tx((q) => writeAsset(q, { asset: checking(app, v, `manual:${randomUUID()}`, 1n), owners: owners(b1.id), priorIdentityKeys: ["p:x:acct"] })), /DU_WRITER_PRIOR_KEYS_UNUSED/);
  await assert.rejects(db.tx((q) => writeAsset(q, { asset: checking(app, v, `manual:${randomUUID()}`, 1n), owners: owners(b1.id), matchOnIdentity: true, supersedes: { id: r.id } })), /DU_WRITER_TWO_REPLACEMENTS/);
  await assert.rejects(db.tx((q) => writeAsset(q, { asset: { ...checking(app, v, `manual:${randomUUID()}`, 1n), not_a_column: 1 } as never, owners: owners(b1.id) })), /DU_WRITER_UNKNOWN_COLUMN/);
  assert.equal(await count(`FROM du_assets WHERE application_id = $1`, [app]), 1);
  // A liability and an expense, the same way.
  const l = await db.tx((q) => writeLiability(q, { liability: { application_id: app, liability_type: "Revolving", creditor_name: "Shoreline CU", monthly_payment_cents: 5_000n, unpaid_balance_cents: 120_000n, identity_key: `manual:${randomUUID()}`, source_verification_id: v }, obligors: owners(b1.id) }));
  const e = await db.tx((q) => writeExpense(q, { expense: { application_id: app, expense_type: "ChildSupport", monthly_payment_cents: 60_000n }, payers: owners(b2.id) }));
  assert.equal(await count(`FROM du_liability_parties WHERE liability_id = $1`, [l.id]), 1); assert.equal(await count(`FROM du_expense_parties WHERE expense_id = $1`, [e.id]), 1);
  const g = await readDuGraph(db, app);
  assert.equal(g.assets.length, 1); assert.equal(g.assets[0]!.owners.length, 2); assert.equal(g.liabilities.length, 1); assert.equal(g.expenses.length, 1); assert.equal(g.borrowers.map((x) => x.borrower_ordinal).join(","), "1,2");
});

test("matchOnIdentity: a re-pull updates the row in place, adds an owner it did not carry, revives a retired row and moves a row onto the vendor's key once", { skip }, async () => {
  const app = await newApplication(); const b1 = await newBorrower(app, "borrower"); const b2 = await newBorrower(app); const v1 = await newVerification(app); const v2 = await newVerification(app);
  const facts = { kind: "DEPOSIT_ACCOUNT", holderName: "First Federal", accountSubtype: "checking", accountIdentifier: "****4455" } as const;
  const first = assetIdentityKeys({ applicationBorrowerId: b1.id, provider: "plaid" }, facts);
  const a = await db.tx((q) => writeAsset(q, { asset: checking(app, v1, first.key, 1_000n), owners: owners(b1.id), matchOnIdentity: true }));
  assert.equal(a.matched, false);
  // The second pull: a new balance, a second owner (the co-borrower's pull of the same joint account under the SAME key would be a different subject prefix — here the same subject reports it again with the co-owner named).
  const again = await db.tx((q) => writeAsset(q, { asset: checking(app, v2, first.key, 2_000n), owners: owners(b1.id, b2.id), matchOnIdentity: true }));
  assert.equal(again.id, a.id); assert.equal(again.matched, true);
  const row = (await db.query<{ cash_or_market_value_cents: bigint; first_seen_verification_id: string; last_seen_verification_id: string; retired_at: string | null }>(`SELECT cash_or_market_value_cents, first_seen_verification_id, last_seen_verification_id, retired_at FROM du_assets WHERE id = $1`, [a.id]))[0]!;
  assert.equal(row.cash_or_market_value_cents, 2_000n); assert.equal(row.first_seen_verification_id, v1, "a first sighting that moves is not a first sighting"); assert.equal(row.last_seen_verification_id, v2);
  assert.equal(await count(`FROM du_asset_parties WHERE asset_id = $1`, [a.id]), 2, "arcs are added, never removed");
  // Retired between pulls, then reported again: revived in place, not twinned.
  await db.query(`UPDATE du_assets SET retired_at = now(), retired_by_verification_id = $2 WHERE id = $1`, [a.id, v2]);
  const revived = await db.tx((q) => writeAsset(q, { asset: checking(app, v2, first.key, 3_000n), owners: owners(b1.id), matchOnIdentity: true }));
  assert.equal(revived.id, a.id); assert.equal((await db.query<{ retired_at: string | null }>(`SELECT retired_at FROM du_assets WHERE id = $1`, [a.id]))[0]!.retired_at, null);
  // The vendor starts numbering the account: the pull carries the vendor key and the content key as a prior; the row moves onto the vendor key, once.
  const numbered = assetIdentityKeys({ applicationBorrowerId: b1.id, provider: "plaid", itemId: "acc_9f2" }, facts);
  const moved = await db.tx((q) => writeAsset(q, { asset: checking(app, v2, numbered.key, 4_000n), owners: owners(b1.id), matchOnIdentity: true, priorIdentityKeys: numbered.priorKeys }));
  assert.equal(moved.id, a.id); assert.equal((await db.query<{ identity_key: string }>(`SELECT identity_key FROM du_assets WHERE id = $1`, [a.id]))[0]!.identity_key, numbered.key);
  assert.equal(await count(`FROM du_assets WHERE application_id = $1`, [app]), 1, "one account, one row, through four pulls");
  // supersedes: the replacement and the retirement in one transaction.
  const replacement = await db.tx((q) => writeAsset(q, { asset: checking(app, v2, `manual:${randomUUID()}`, 5n), owners: owners(b1.id), supersedes: { id: a.id, retiredByVerificationId: v2 } }));
  assert.notEqual(replacement.id, a.id);
  assert.deepEqual((await db.query<{ id: string; live: boolean }>(`SELECT id, retired_at IS NULL AS live FROM du_assets WHERE application_id = $1 ORDER BY created_at`, [app])).map((r) => r.live), [false, true]);
});

test("an owned property: the OWNED_PROPERTY asset, its owners and its 3a row together; application_id and lien_upb_cents are refused as inputs", { skip }, async () => {
  const app = await newApplication(); const b = await newBorrower(app, "borrower");
  const r = await db.tx((q) => writeOwnedProperty(q, { applicationId: app, property: { address_line_text: "88 Foster Lane", city_name: "Austin", state_code: "TX", postal_code: "78745", disposition: "Retain", market_value_cents: 45_000_000n }, owners: owners(b.id) }));
  assert.equal(await count(`FROM du_owned_properties WHERE id = $1 AND asset_id = $2 AND application_id = $3`, [r.propertyId, r.assetId, app]), 1);
  await assert.rejects(db.tx((q) => writeOwnedProperty(q, { applicationId: app, property: { disposition: "Retain", lien_upb_cents: 1n } as never, owners: owners(b.id) })), /DU_OWNED_PROPERTY_DERIVED_FIELD/);
  await assert.rejects(db.tx((q) => writeOwnedProperty(q, { applicationId: app, property: { disposition: "Retain", application_id: app } as never, owners: owners(b.id) })), /DU_OWNED_PROPERTY_DERIVED_FIELD/);
  // Re-writing the same asset updates the 3a row rather than adding a second.
  const again = await db.tx((q) => writeOwnedProperty(q, { applicationId: app, assetId: r.assetId, identityKey: `manual:${r.assetId}`, matchOnIdentity: true, property: { address_line_text: "88 Foster Lane", city_name: "Austin", state_code: "TX", postal_code: "78745", disposition: "PendingSale" }, owners: owners(b.id) }));
  assert.equal(again.propertyId, r.propertyId); assert.equal(again.matched, true);
  assert.equal((await db.query<{ disposition: string }>(`SELECT disposition FROM du_owned_properties WHERE id = $1`, [r.propertyId]))[0]!.disposition, "PendingSale");
});

test("the employer under EMPLOYER_IDENTITY_RULES: name key, EIN wins, promotion once, per borrower, and a merge that repoints before it deletes", { skip }, async () => {
  const app = await newApplication(); const b1 = await newBorrower(app, "borrower"); const b2 = await newBorrower(app);
  const a = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b1.id, displayName: "Acme Manufacturing (FAKE payroll)" }));
  assert.equal(a.matched, null); assert.equal(a.identityKey, "name:acmemanufacturingfakepayroll");
  // NAME_KEY_OTHERWISE: one employer punctuated two ways is one row.
  const b = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b1.id, displayName: "acme manufacturing - FAKE payroll" }));
  assert.equal(b.id, a.id); assert.equal(b.matched, "identity_key");
  // EIN_WINS + PROMOTE_ONCE: a payroll pull that knows the EIN promotes the row it recognizes by name.
  const c = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b1.id, displayName: "Acme Manufacturing (FAKE payroll)", ein: "12-3456789" }));
  assert.equal(c.id, a.id); assert.equal(c.matched, "name_key"); assert.equal(c.promoted, true); assert.equal(c.identityKey, "ein:123456789");
  assert.deepEqual((await db.query<{ identity_key: string; derived_from: string; name_key: string; ein: string }>(`SELECT identity_key, derived_from, name_key, ein FROM employers WHERE id = $1`, [a.id]))[0], { identity_key: "ein:123456789", derived_from: "ein", name_key: "name:acmemanufacturingfakepayroll", ein: "123456789" });
  // NAME_KEY_WRITTEN_ONCE + MATCH_ORDER: a bank pull that only knows the name still finds the promoted row, and does not demote it.
  const d = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b1.id, displayName: "ACME MANUFACTURING FAKE PAYROLL" }));
  assert.equal(d.id, a.id); assert.equal(d.matched, "name_key"); assert.equal(d.promoted, false); assert.equal(d.identityKey, "ein:123456789");
  // PER_BORROWER: the co-borrower at the same employer is a second row.
  const e = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b2.id, displayName: "Acme Manufacturing (FAKE payroll)", ein: "123456789" }));
  assert.notEqual(e.id, a.id); assert.equal(e.matched, null);
  // MERGE_REPOINTS_FIRST: two rows for one borrower (a second trade name), an income item on the loser; the merge repoints then deletes — and a delete with an income item still attached is refused (ON DELETE RESTRICT).
  const loser = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b1.id, displayName: "Acme Mfg" }));
  const income = (await db.query<{ id: string }>(`INSERT INTO application_income (application_id, application_borrower_id, source_kind, monthly_amount_cents, employer_id, employment_income) VALUES ($1, $2, 'base', 820000, $3, true) RETURNING id`, [app, b1.id, loser.id]))[0]!.id;
  await assert.rejects(db.query(`DELETE FROM employers WHERE id = $1`, [loser.id]), (err: unknown) => (err as { code?: string }).code === "23503");
  const m = await db.tx((q) => mergeEmployers(q, a.id, loser.id));
  assert.equal(m.repointed, 1); assert.equal((await db.query<{ employer_id: string }>(`SELECT employer_id FROM application_income WHERE id = $1`, [income]))[0]!.employer_id, a.id);
  assert.equal(await count(`FROM employers WHERE id = $1`, [loser.id]), 0);
  // An income item naming an employer on another borrower's edge is refused (DU_GRAPH_CROSSES_APPLICATIONS).
  await assert.rejects(db.query(`INSERT INTO application_income (application_id, application_borrower_id, source_kind, monthly_amount_cents, employer_id, employment_income) VALUES ($1, $2, 'base', 1, $3, true)`, [app, b2.id, a.id]), /DU_GRAPH_CROSSES_APPLICATIONS/);
  assert.equal(await count(`FROM employers WHERE application_id = $1`, [app]), 2);
});

test("a borrower reference resolves to the edge: the row's id, the party, the intake record's id, the legal name — and nothing else", { skip }, async () => {
  const app = await newApplication(); const b1 = await newBorrower(app, "borrower", "Alex Borrower"); const b2 = await newBorrower(app, "co_borrower", "Blake Borrower");
  await db.query(`INSERT INTO entity_records (kind, id, version, loan_id, application_id, data, updated_at, updated_by) VALUES ('applications', $1, 1, NULL, $1, $2::jsonb, now(), 'test')`, [app, encodeEntityData({ id: app, borrowers: [{ id: "B1", legal_name: "Alex Borrower" }, { id: "B2", legal_name: "Blake Borrower" }] })]);
  await db.tx(async (q) => {
    assert.equal(await resolveBorrowerEdge(q, app, b2.id), b2.id);
    assert.equal(await resolveBorrowerEdge(q, app, b1.party_id), b1.id);
    assert.equal(await resolveBorrowerEdge(q, app, "B2"), b2.id, "21.1's intake id, by legal name");
    assert.equal(await resolveBorrowerEdge(q, app, "blake borrower"), b2.id);
    await assert.rejects(resolveBorrowerEdge(q, app, "B9"), /not an application_borrowers row/);
    await assert.rejects(resolveBorrowerEdge(q, app, randomUUID()), /not an application_borrowers row/);
  });
  assert.equal(deterministicUuid("verifications", "a:b:assets:R"), deterministicUuid("verifications", "a:b:assets:R"));
  assert.match(deterministicUuid("verifications", "x"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("EIN_WINS over the name key: one trade name under two EINs is two employers for one borrower; a name-only pull still finds the ein: row and a name-derived row is still promoted once", { skip }, async () => {
  const app = await newApplication(); const b = await newBorrower(app, "borrower");
  const r1 = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b.id, displayName: "Acme Inc", ein: "12-3456789" }));
  assert.equal(r1.matched, null); assert.equal(r1.identityKey, "ein:123456789");
  // The same trade name under another EIN: the name-key fallback does not hand an EIN pull an `ein:` row with a different EIN — it is another employer, inserted beside the first.
  const r2 = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b.id, displayName: "Acme, Inc.", ein: "98-7654321" }));
  assert.notEqual(r2.id, r1.id, "one name under two EINs is two"); assert.equal(r2.matched, null); assert.equal(r2.promoted, false); assert.equal(r2.identityKey, "ein:987654321");
  assert.deepEqual((await db.query<{ identity_key: string; ein: string; name_key: string; display_name: string }>(`SELECT identity_key, ein, name_key, display_name FROM employers WHERE application_borrower_id = $1 ORDER BY created_at, id`, [b.id])),
    [{ identity_key: "ein:123456789", ein: "123456789", name_key: "name:acmeinc", display_name: "Acme Inc" }, { identity_key: "ein:987654321", ein: "987654321", name_key: "name:acmeinc", display_name: "Acme, Inc." }]);
  // The first EIN again under a third spelling: identity_key wins, nothing is twinned.
  const r3 = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b.id, displayName: "ACME INC", ein: "123456789" }));
  assert.equal(r3.id, r1.id); assert.equal(r3.matched, "identity_key");
  // MATCH_ORDER's parenthetical holds: a name-only pull finds an `ein:` row (the first by creation) and does not demote it.
  const r4 = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b.id, displayName: "Acme Inc." }));
  assert.equal(r4.id, r1.id); assert.equal(r4.matched, "name_key"); assert.equal(r4.promoted, false); assert.equal(r4.identityKey, "ein:123456789");
  // PROMOTE_ONCE still: a name-derived row is promoted by the EIN pull that recognizes it — and a second EIN under that name afterwards is a second row, not a second promotion.
  const n1 = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b.id, displayName: "Beta Works" }));
  const n2 = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b.id, displayName: "Beta-Works", ein: "11-1111111" }));
  assert.equal(n2.id, n1.id); assert.equal(n2.matched, "name_key"); assert.equal(n2.promoted, true); assert.equal(n2.identityKey, "ein:111111111");
  const n3 = await db.tx((q) => writeEmployer(q, { applicationId: app, applicationBorrowerId: b.id, displayName: "Beta Works", ein: "22-2222222" }));
  assert.notEqual(n3.id, n1.id); assert.equal(n3.matched, null); assert.equal(n3.identityKey, "ein:222222222");
  assert.equal((await db.query<{ identity_key: string }>(`SELECT identity_key FROM employers WHERE id = $1`, [n1.id]))[0]!.identity_key, "ein:111111111", "promoted once; the second EIN did not move it");
  assert.equal(await count(`FROM employers WHERE application_borrower_id = $1`, [b.id]), 4, "two Acmes and two Betas; merging any pair stays the person's call (mergeEmployers)");
});

test("assertDeclarations: a rewrite is the whole section 5 — an answer moved from Yes to No sheds its follow-ups; the written explanation is kept unless the request names it", { skip }, async () => {
  const app = await newApplication(); const b = await newBorrower(app, "borrower"); const actor = { kind: "human", id: b.party_id, role: "borrower" } as const;
  const no = Object.fromEntries(DU_DECLARATION_ANSWERS.map((k) => [k, "No"])) as Record<(typeof DU_DECLARATION_ANSWERS)[number], "Yes" | "No">;
  const read = async () => (await db.query<{ intent_to_occupy: string; homeowner_past_three_years: string | null; property_usage: string | null; undisclosed_borrowed_funds: string; undisclosed_borrowed_funds_cents: bigint | null; bankruptcy: string; bankruptcy_explanation: string | null }>(`SELECT intent_to_occupy, homeowner_past_three_years, property_usage, undisclosed_borrowed_funds, undisclosed_borrowed_funds_cents, bankruptcy, bankruptcy_explanation FROM du_declarations WHERE application_borrower_id = $1`, [b.id]))[0]!;
  await db.tx((q) => assertDeclarations(q, { applicationBorrowerId: b.id, actor, answers: { ...no, intent_to_occupy: "Yes", undisclosed_borrowed_funds: "Yes", bankruptcy: "Yes" }, followUps: { homeowner_past_three_years: "Yes", property_usage: "PrimaryResidence", undisclosed_borrowed_funds_cents: 500_000n, bankruptcy_explanation: "Chapter 13 in 2019, completed 2022." }, bankruptcyChapters: ["ChapterThirteen"] }));
  assert.deepEqual(await read(), { intent_to_occupy: "Yes", homeowner_past_three_years: "Yes", property_usage: "PrimaryResidence", undisclosed_borrowed_funds: "Yes", undisclosed_borrowed_funds_cents: 500_000n, bankruptcy: "Yes", bankruptcy_explanation: "Chapter 13 in 2019, completed 2022." });
  // Every answer No and no follow-up named: the follow-ups are written NULL (du_declarations_homeowner_follows_intent and
  // du_declarations_borrowed_amount_follows_indicator hold, where a partial UPDATE would have been refused), the chapters go, the explanation stays.
  await db.tx((q) => assertDeclarations(q, { applicationBorrowerId: b.id, actor, answers: no, followUps: {}, bankruptcyChapters: [] }));
  assert.deepEqual(await read(), { intent_to_occupy: "No", homeowner_past_three_years: null, property_usage: null, undisclosed_borrowed_funds: "No", undisclosed_borrowed_funds_cents: null, bankruptcy: "No", bankruptcy_explanation: "Chapter 13 in 2019, completed 2022." });
  assert.equal(await count(`FROM du_bankruptcy_filings f JOIN du_declarations d ON d.id = f.declaration_id WHERE d.application_borrower_id = $1`, [b.id]), 0);
  // Back to Yes with its follow-up, then a request that names the explanation null: cleared. One row throughout.
  await db.tx((q) => assertDeclarations(q, { applicationBorrowerId: b.id, actor, answers: { ...no, intent_to_occupy: "Yes" }, followUps: { homeowner_past_three_years: "No", bankruptcy_explanation: null } }));
  assert.deepEqual(await read(), { intent_to_occupy: "Yes", homeowner_past_three_years: "No", property_usage: null, undisclosed_borrowed_funds: "No", undisclosed_borrowed_funds_cents: null, bankruptcy: "No", bankruptcy_explanation: null });
  assert.equal(await count(`FROM du_declarations WHERE application_borrower_id = $1`, [b.id]), 1);
});

test("writeResidence: re-confirming the Current home with another basis writes the whole row — Rent → Own sheds the rent — and a Prior row is added beside it", { skip }, async () => {
  const app = await newApplication(); const b = await newBorrower(app, "borrower");
  const address = { address_line_text: "12 Elm St", city_name: "Mesa", state_code: "AZ", postal_code: "85201" };
  const read = async () => (await db.query<{ residency_basis: string; monthly_rent_cents: bigint | null; address_unit: string | null; duration_months: number }>(`SELECT residency_basis, monthly_rent_cents, address_unit, duration_months FROM du_residences WHERE application_borrower_id = $1 AND residency_type = 'Current'`, [b.id]))[0]!;
  const r1 = await db.tx((q) => writeResidence(q, b.id, { residency_type: "Current", residency_basis: "Rent", monthly_rent_cents: 180_000n, address_unit: "4B", ...address, duration_months: 14 }));
  assert.equal(r1.replaced, false); assert.deepEqual(await read(), { residency_basis: "Rent", monthly_rent_cents: 180_000n, address_unit: "4B", duration_months: 14 });
  // Own, with no monthly_rent_cents key and no unit: both are NULL on the row, not left over from the Rent answer (du_residences_rent_iff_rent_basis would refuse the rent).
  const r2 = await db.tx((q) => writeResidence(q, b.id, { residency_type: "Current", residency_basis: "Own", ...address, duration_months: 15 }));
  assert.equal(r2.id, r1.id); assert.equal(r2.replaced, true); assert.deepEqual(await read(), { residency_basis: "Own", monthly_rent_cents: null, address_unit: null, duration_months: 15 });
  // LivingRentFree, then Rent again with its amount: the CHECK holds both ways.
  await db.tx((q) => writeResidence(q, b.id, { residency_type: "Current", residency_basis: "LivingRentFree", ...address, duration_months: 15 }));
  assert.deepEqual(await read(), { residency_basis: "LivingRentFree", monthly_rent_cents: null, address_unit: null, duration_months: 15 });
  await assert.rejects(db.tx((q) => writeResidence(q, b.id, { residency_type: "Current", residency_basis: "Rent", ...address, duration_months: 16 })), (e: unknown) => (e as { constraint?: string }).constraint === "du_residences_rent_iff_rent_basis");
  await db.tx((q) => writeResidence(q, b.id, { residency_type: "Current", residency_basis: "Rent", monthly_rent_cents: 190_000n, ...address, duration_months: 16 }));
  assert.deepEqual(await read(), { residency_basis: "Rent", monthly_rent_cents: 190_000n, address_unit: null, duration_months: 16 });
  // A Prior row beside it; still one Current.
  const p = await db.tx((q) => writeResidence(q, b.id, { residency_type: "Prior", residency_basis: "Rent", monthly_rent_cents: 120_000n, address_line_text: "9 Oak Ave", city_name: "Tempe", state_code: "AZ", postal_code: "85281", duration_months: 20 }));
  assert.equal(p.replaced, false); assert.notEqual(p.id, r1.id);
  assert.equal(await count(`FROM du_residences WHERE application_borrower_id = $1 AND residency_type = 'Current'`, [b.id]), 1); assert.equal(await count(`FROM du_residences WHERE application_borrower_id = $1`, [b.id]), 2);
});

test("the 23.5 tools report the row the deferred write lands on: a re-pull's output and its du.graph.*.written event name an existing id, with matched and identity_key on both", { skip }, async () => {
  const app = await newApplication(); const b = await newBorrower(app, "borrower"); const v = await newVerification(app);
  const runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock: new FixedClock("2026-09-14T12:00:00.000Z") });
  const underwriter = { kind: "agent", id: "underwriter" } as const;
  const exists = async (table: string, id: unknown): Promise<boolean> => (await count(`FROM ${table} WHERE id = $1`, [String(id)])) === 1;
  const facts = { kind: "DEPOSIT_ACCOUNT", holderName: "First Federal", accountSubtype: "checking", accountIdentifier: "****4455" } as const;
  const asset = (balance: string) => runtime.execute({ process: "23.5", name: "writeDuAsset", loanId: "", applicationId: app, actor: underwriter, input: { application_id: app, asset: { kind: "DEPOSIT_ACCOUNT", asset_type: "CheckingAccount", institution_name: "First Federal", account_last4: "4455", cash_or_market_value_cents: balance, source_verification_id: v, first_seen_verification_id: v, last_seen_verification_id: v }, owners: [{ application_borrower_id: b.id }], match_on_identity: true, identity: { provider: "plaid", facts } } });
  const a1 = await asset("100000"); const o1 = a1.output as Record<string, unknown>;
  assert.equal(o1["matched"], false); assert.equal(o1["identity_key"], assetIdentityKeys({ applicationBorrowerId: b.id, provider: "plaid" }, facts).key, "the key is on the output, computed before the transaction — not null");
  assert.ok(await exists("du_assets", o1["asset_id"]));
  const a2 = await asset("200000"); const o2 = a2.output as Record<string, unknown>;
  assert.equal(o2["asset_id"], o1["asset_id"], "the re-pull reports the row it matched, not a uuid no row carries"); assert.equal(o2["matched"], true); assert.equal(o2["identity_key"], o1["identity_key"]);
  const ev = a2.events.find((e) => e.type === "du.graph.asset.written")!;
  assert.equal(ev.payload["asset_id"], o1["asset_id"]); assert.equal(ev.payload["matched"], true); assert.equal(ev.payload["identity_key"], o1["identity_key"]); assert.equal(ev.aggregate?.id, o1["asset_id"]);
  assert.equal(await count(`FROM du_assets WHERE application_id = $1`, [app]), 1);
  assert.equal((await db.query<{ c: bigint }>(`SELECT cash_or_market_value_cents AS c FROM du_assets WHERE id = $1`, [o1["asset_id"]]))[0]!.c, 200_000n);
  // A liability, the same way.
  const lfacts = { holderName: "Shoreline CU", liabilityType: "Revolving", accountIdentifier: "****9001" } as const;
  const liability = (upb: string) => runtime.execute({ process: "23.5", name: "writeDuLiability", loanId: "", applicationId: app, actor: underwriter, input: { application_id: app, liability: { liability_type: "Revolving", creditor_name: "Shoreline CU", account_last4: "9001", monthly_payment_cents: "5000", unpaid_balance_cents: upb, source_verification_id: v, first_seen_verification_id: v, last_seen_verification_id: v }, obligors: [{ application_borrower_id: b.id }], match_on_identity: true, identity: { provider: "plaid", facts: lfacts } } });
  const l1 = (await liability("120000")).output as Record<string, unknown>; const l2r = await liability("110000"); const l2 = l2r.output as Record<string, unknown>;
  assert.equal(l1["matched"], false); assert.equal(l2["liability_id"], l1["liability_id"]); assert.equal(l2["matched"], true); assert.ok(await exists("du_liabilities", l2["liability_id"]));
  assert.equal(l2r.events.find((e) => e.type === "du.graph.liability.written")!.payload["liability_id"], l1["liability_id"]);
  assert.equal(await count(`FROM du_liabilities WHERE application_id = $1`, [app]), 1);
  // An owned property re-run for the same asset reports the existing asset and its 3a row.
  const property = (disposition: string, extra: Record<string, unknown> = {}) => runtime.execute({ process: "23.5", name: "writeDuOwnedProperty", loanId: "", applicationId: app, actor: underwriter, input: { application_id: app, property: { address_line_text: "88 Foster Lane", city_name: "Austin", state_code: "TX", postal_code: "78745", disposition, market_value_cents: "45000000" }, owners: [{ application_borrower_id: b.id }], ...extra } });
  const p1 = (await property("Retain")).output as Record<string, unknown>;
  assert.equal(p1["matched"], false); assert.ok(await exists("du_assets", p1["asset_id"])); assert.ok(await exists("du_owned_properties", p1["owned_property_id"]));
  const p2r = await property("PendingSale", { asset_id: p1["asset_id"], match_on_identity: true }); const p2 = p2r.output as Record<string, unknown>;
  assert.equal(p2["asset_id"], p1["asset_id"]); assert.equal(p2["owned_property_id"], p1["owned_property_id"]); assert.equal(p2["matched"], true); assert.equal(p2["identity_key"], `manual:${String(p1["asset_id"])}`);
  const pev = p2r.events.find((e) => e.type === "du.graph.owned_property.written")!;
  assert.equal(pev.payload["owned_property_id"], p1["owned_property_id"]); assert.equal(pev.payload["asset_id"], p1["asset_id"]); assert.equal(pev.payload["matched"], true);
  assert.equal((await db.query<{ d: string }>(`SELECT disposition AS d FROM du_owned_properties WHERE id = $1`, [p1["owned_property_id"]]))[0]!.d, "PendingSale");
  assert.equal(await count(`FROM du_owned_properties WHERE application_id = $1`, [app]), 1); assert.equal(await count(`FROM du_assets WHERE application_id = $1`, [app]), 2, "the deposit account and the owned property");
});
