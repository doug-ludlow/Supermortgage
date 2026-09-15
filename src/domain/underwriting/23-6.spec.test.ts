// 23.6 Assemble and emit the DU Specification document (MISMO 3.4 B324 + DU/ULAD extensions)
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-6-assemble-and-emit-the-du-specification-document.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  arcRolesInCorpus, assetTypeListsInMigration, diffAssetTypeChecks, diffDuEnumChecks, duEnumChecksInMigrations, duGraphMigrationPaths,
  migrationSources, parseGeneratedArcRoles, parseGeneratedAssetTypeSections, parseGeneratedEnums, parseGeneratedOrder, schemaOrderProblems,
} from "../../../tools/build-du.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ORDER_TS = resolve(ROOT, "src/domain/underwriting/du/generated/order.ts");

test("23.6-T1: Given each of the eighteen samples in `corpus/samples/`, when it is loaded into a 23.5 graph and re-emitted, then the emitted document validates against the vendored chain and matches the sample container-for-container and arc-for-arc after label normalization.", { todo: true });
test("23.6-T2: Given sample DI-C09, when re-emitted, then the `RELATIONSHIPS` block carries exactly its arcs: the two-owner asset yields two `ASSET_IsAssociatedWith_ROLE` arcs, the two-obligor liability two `LIABILITY_IsAssociatedWith_ROLE` arcs, one `ASSET_IsAssociatedWith_LIABILITY`, and one `CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER` per employed income item.", { todo: true });
test("23.6-T3: Given the refinance fixture (23.1-T1), when the document is emitted, then every container's children appear in `CHILD_ORDER` sequence, and moving any one child breaks schema validation.", { todo: true });
test("23.6-T4: Given a data point whose value is in the MISMO enumeration but not in `DU_ENUMERATIONS`, when emitted, then the emission is refused with `DU_ENUM_NOT_SUPPORTED` naming the XPath, and no `documents` row is written.", { todo: true });
test("23.6-T5: Given a required data point with no value, when emitted, then the emission is refused with `DU_REQUIRED_MISSING` naming the XPath; given a conditional data point whose condition statement is false for this loan, then its absence is accepted.", { todo: true });
test("23.6-T6: Given a first submission, when emitted, then `AutomatedUnderwritingCaseIdentifier` is absent; given `applications.du_casefile_id = 1234567890` and `submission_number = 2`, then it is present with that value.", { todo: true });
test("23.6-T7: Given the same graph emitted twice, then the two documents are byte-identical and `du_documents.sha256` is equal; given one asset's balance changes by one cent, then the hashes differ.", { todo: true });
test("23.6-T8: Given the 23.5 graph for the refinance fixture, when emitted, then `xlink:label` values are unique across the document and every `xlink:from`/`xlink:to` names a label the document contains.", { todo: true });
test("23.6-T9: Given a wage income item with no employer, when emitted, then `EmploymentIncomeIndicator` is false and no employer arc is written for it.", { todo: true });
test("23.6-T10: Given `du:verify` run on a checkout with no `DU_SPEC_DIR`, then it re-derives every child sequence from the vendored chain, re-counts the arcs the samples exercise, checks every `Du*` CHECK constraint in the migrations against `DU_ENUMERATIONS`, reports the workbook check as skipped by name, and fails on any drift in `order.ts` or `arcroles.ts`.", () => {
  // The real verify, as `npm run du:verify` spawns it, with DU_SPEC_DIR absent from the environment: five lines, and
  // each names what it checked or what it skipped — never a green line over a diff that read nothing.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== "DU_SPEC_DIR" && v !== undefined) env[k] = v;
  const result = spawnSync(process.execPath, [resolve(ROOT, "tools/build-du.mjs"), "--verify"], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 5, result.stdout);
  assert.match(lines[0]!, /^✓ (\d+) du_\* enum CHECK\(s\) in db\/migrations match the DU Spec$/);
  assert.equal(lines[1], "✓ 227 child sequences in order.ts match the vendored MISMO chain");
  assert.equal(lines[2], "✓ 9 of 11 arcroles in arcroles.ts are exercised by the vendored samples, and no sample carries another");
  assert.equal(lines[3], "✓ 3 per-kind asset CHECK(s) admit exactly their section's 22 AssetType values");
  assert.equal(lines[4], "- skipped the workbook check (enums, lengths, cardinality, conditionality, and the arcroles' endpoints): DU_SPEC_DIR is not set");
  assert.doesNotMatch(result.stdout, /skipped the du_\* enum CHECK diff|skipped the per-kind asset CHECK diff/, "the two migration-reading checks ran");

  // "Every Du* CHECK constraint in the migrations": the count on the first line is the number of du_* columns whose
  // comment names a DU data point, and the migration reader finds them all — an IN list for each, no column with a
  // comment and no list, and the enum each maps to in DU_ENUMERATIONS.
  const found = duEnumChecksInMigrations(migrationSources(ROOT));
  const checked = Number(/^✓ (\d+) du_\*/.exec(lines[0]!)![1]);
  assert.equal(found.comments.size, checked);
  assert.ok(checked >= 17, `${checked} DU-commented columns`);
  for (const column of found.comments.keys()) assert.ok(found.lists.has(column), `${column} has an IN list`);
  const generated = parseGeneratedEnums(readFileSync(resolve(ROOT, "src/domain/underwriting/du/generated/enums.ts"), "utf8")).enumerations;
  assert.deepEqual(diffDuEnumChecks(found, generated), []);
  const columns = [...found.comments.keys()];
  for (const c of ["du_assets.asset_type", "du_liabilities.liability_type", "du_expenses.expense_type", "du_residences.residency_basis", "du_declarations.intent_to_occupy", "du_bankruptcy_filings.chapter", "du_owned_properties.disposition"]) assert.ok(columns.includes(c), c);

  // "Fails on any drift": a fabricated member in a du_* CHECK — the SecuredBorrowedFundsNotDeposited case, a value that
  // lived in a block labelled "generated" and was in no tab of the spec — is named, and so is a member dropped.
  const graph = duGraphMigrationPaths(ROOT);
  assert.equal(graph.length, 1, graph.join(", "));
  const sql = readFileSync(resolve(ROOT, graph[0]!), "utf8");
  const widened = sql.replace("'CashOnHand', 'Other', 'PendingNetSaleProceedsFromRealEstateAssets'", "'CashOnHand', 'Other', 'SecuredBorrowedFundsNotDeposited', 'PendingNetSaleProceedsFromRealEstateAssets'");
  assert.notEqual(widened, sql);
  const drift = diffDuEnumChecks(duEnumChecksInMigrations([{ file: graph[0]!, sql: widened }]), generated);
  assert.deepEqual(drift, ["du_assets.asset_type admits SecuredBorrowedFundsNotDeposited, which has no row in the DU Enumerations tab for AssetType (DuAssetType)."]);
  const narrowed = sql.replace("'LeasePayment', ", "");
  assert.notEqual(narrowed, sql);
  assert.deepEqual(diffDuEnumChecks(duEnumChecksInMigrations([{ file: graph[0]!, sql: narrowed }]), generated), ["du_liabilities.liability_type is missing LeasePayment, which the DU Enumerations tab carries for LiabilityType (DuLiabilityType)."]);
  // The per-kind partition: a value moved between kinds is a value admitted where the tab does not file it, and missing where it does.
  const sections = parseGeneratedAssetTypeSections(readFileSync(resolve(ROOT, "src/domain/underwriting/du/generated/enums.ts"), "utf8"));
  const moved = sql.replace("'GiftOfCash', 'GiftOfPropertyEquity', 'Grant'", "'GiftOfCash', 'GiftOfPropertyEquity', 'Grant', 'CashOnHand'");
  const problems = diffAssetTypeChecks(sections, assetTypeListsInMigration(moved, { path: graph[0]! }), generated.DuAssetType ?? []);
  assert.deepEqual(problems, ["du_assets_gift_or_grant_shape admits CashOnHand, which the DU Enumerations tab does not file under 4d.1."]);

  // Drift in order.ts: the committed table is clean; two children swapped in a copy is named by container (23.6-T11 drives the same edit end to end).
  const order = readFileSync(ORDER_TS, "utf8");
  assert.deepEqual(schemaOrderProblems(order).problems, []);
  const swapped = order.replace('    "INDIVIDUAL",\n    "LEGAL_ENTITY",', '    "LEGAL_ENTITY",\n    "INDIVIDUAL",');
  assert.notEqual(swapped, order);
  assert.ok(schemaOrderProblems(swapped).problems.length > 0);
  // Drift in arcroles.ts: the committed table's corpus column agrees with the eighteen samples arc for arc; flip one
  // arc's `exercised` and the re-count disagrees, which is what fails the run.
  const arcroles = parseGeneratedArcRoles(readFileSync(resolve(ROOT, "src/domain/underwriting/du/generated/arcroles.ts"), "utf8")) as Record<string, { arcrole: string; exercised: boolean }>;
  const corpus = arcRolesInCorpus() as Map<string, number>;
  assert.equal(Object.values(arcroles).filter((a) => a.exercised).length, 9);
  assert.equal(corpus.size, 9);
  for (const [name, arc] of Object.entries(arcroles)) assert.equal(arc.exercised, corpus.has(arc.arcrole), name);
  for (const uri of corpus.keys()) assert.ok(Object.values(arcroles).some((a) => a.arcrole === uri), uri);
  const flipped = { ...arcroles, ASSET_IsAssociatedWith_ROLE: { ...arcroles["ASSET_IsAssociatedWith_ROLE"]!, exercised: false } };
  assert.ok(Object.entries(flipped).some(([, arc]) => arc.exercised !== corpus.has(arc.arcrole)), "a flipped corpus column is drift the re-count sees");
});
test("23.6-T11: Given a hand edit to `generated/order.ts` that swaps two children, when `npm test` runs, then `du:verify` fails the build naming the container.", () => {
  // `npm test` reaches du:verify: it is the tail of the test script, after the audit ratchet and the name lint.
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts.test?.endsWith(" && npm run du:verify"), pkg.scripts.test);
  assert.equal(pkg.scripts["du:verify"], "node tools/build-du.mjs --verify");

  // The committed table is clean against the vendored chain, so any problem below is the hand edit's.
  const committed = readFileSync(ORDER_TS, "utf8");
  assert.deepEqual(schemaOrderProblems(committed).problems, []);

  // The hand edit, on a copy: PARTY's INDIVIDUAL and LEGAL_ENTITY swapped. The same pair sits adjacent under
  // EMPLOYER, so the swap is made inside the PARTY block alone — the failure has to name the container edited.
  const party = parseGeneratedOrder(committed).childOrder["PARTY"];
  assert.ok(party, "PARTY is in CHILD_ORDER");
  assert.equal(party.indexOf("LEGAL_ENTITY"), party.indexOf("INDIVIDUAL") + 1);
  const start = committed.indexOf('\n  "PARTY": [');
  assert.ok(start > 0, "the PARTY block is in order.ts");
  const end = committed.indexOf("\n  ]", start);
  const block = committed.slice(start, end);
  const swapped = block.replace('    "INDIVIDUAL",\n    "LEGAL_ENTITY",', '    "LEGAL_ENTITY",\n    "INDIVIDUAL",');
  assert.notEqual(swapped, block, "the edit matched the two children");
  const edited = committed.slice(0, start) + swapped + committed.slice(end);

  const scratch = mkdtempSync(join(tmpdir(), "du-order-"));
  try {
    const copy = join(scratch, "order.ts");
    writeFileSync(copy, edited);
    assert.deepEqual(parseGeneratedOrder(readFileSync(copy, "utf8")).childOrder["PARTY"], [
      "REFERENCE", "LEGAL_ENTITY", "INDIVIDUAL", "ADDRESSES", "LANGUAGES", "ROLES", "TAXPAYER_IDENTIFIERS", "EXTENSION",
    ]);
    const { problems } = schemaOrderProblems(readFileSync(copy, "utf8"));
    assert.ok(problems.length > 0, "du:verify fails on the edited copy");
    assert.ok(problems.some((p) => /^PARTY: the schema chain now declares REFERENCE, INDIVIDUAL, LEGAL_ENTITY/.test(p)), problems.join("\n"));
    assert.ok(problems.every((p) => !p.startsWith("EMPLOYER")), "only the container that was edited is named");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test("23.6-T12: Given a request built from the refinance fixture, then `request_hash` equals the SHA-256 of the transmitted bytes and 23.1's duplicate-suppression test (23.1-T1's second identical build) still passes.", { todo: true });
