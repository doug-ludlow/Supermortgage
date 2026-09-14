/**
 * The generator's promises, tested against rows this file makes up.
 *
 * Every fixture below is synthetic on purpose. Fannie Mae's workbook and
 * MISMO's reference model are not in this repository and must not be, so a test
 * that reads them would only run on a machine that happens to have them — which
 * is no test at all. What these assert is the machinery: that an unrecognized
 * phrase stops the build, that a blank cell nobody named stops the build, that
 * a child the schema does not declare stops the build, that a CHECK member the
 * spec has no row for stops the build. The facts derived FROM the spec are
 * asserted in generated.test.ts, against the committed tables.
 *
 * Ported from Homestead's vitest suite. Two of its cases are not here, by
 * name: the one that read a comment out of a deploy workflow (`npm test` is
 * how `du:verify` is reached in this tree, and that is asserted instead), and
 * the one that read form-field ids out of `schema.prisma` doc comments (there
 * is no Prisma schema; the migration convention is the `DU <DataPoint>`
 * column comment, tested below). The cases that read Homestead's committed
 * asset migration run against a fixture in the shape Phase 3 will write, and
 * the one that diffs the committed migration reports itself skipped by name
 * until `db/migrations/*_du_graph.sql` exists.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ARCROLE_SECTIONS,
  ASSET_TYPE_SECTIONS,
  BLANK_ENUMERATION_CELLS,
  COLUMN_NAME_ALIASES,
  DU_DATA_POINT_FOR_ENUM,
  DU_GRAPH_MIGRATION_GLOB,
  TAB_DISAGREEMENTS,
  UNPARSEABLE_STATEMENTS,
  arcRoleColumnNamesFor,
  arcRolesInCorpus,
  assetTypeListsInMigration,
  buildOrderTable,
  checkTabDisagreements,
  deriveArcRoles,
  deriveAssetTypeSections,
  deriveEnumerations,
  diffAssetTypeChecks,
  diffDuEnumChecks,
  duEnumChecksInMigrations,
  duGraphMigrationPaths,
  migrationSources,
  parseCardinality,
  parseConditionality,
  parseFormat,
  parseGeneratedArcRoles,
  parseGeneratedAssetTypeSections,
  parseGeneratedEnums,
  parseGeneratedOrder,
  resolveSpecFiles,
  splitSqlStatements,
  type EndpointRow,
  type EnumerationRow,
  type MapRow,
  type RelationshipRow,
} from "../../../../tools/build-du.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT = resolve(ROOT, "tools/build-du.mjs");
const GENERATED = resolve(ROOT, "src/domain/underwriting/du/generated");

/** One row of the DU Enumerations tab. */
function enumerationRow(
  dataPoint: string,
  formFieldId: string,
  value: string,
  extra: Partial<EnumerationRow> = {},
): EnumerationRow {
  return {
    rowNumber: 1,
    formFieldId,
    formFieldName: "Test Field",
    dataPoint,
    value,
    ediCode: "",
    ...extra,
  };
}

/** One row of the DU Map. */
function mapRow(dataPoint: string, formFieldId: string, extra: Partial<MapRow> = {}): MapRow {
  return {
    rowNumber: 1,
    formFieldId,
    formFieldName: "Test Field",
    xpath: "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL",
    dataPoint,
    attribute: "",
    format: "Enumerated",
    du: "R",
    conditionality: "",
    ...extra,
  };
}

/** Run the generator the way a developer or CI does, with the env it is given. */
function runScript(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

describe("the spec directory", () => {
  it("says what to do when DU_SPEC_DIR is unset", () => {
    assert.throws(() => resolveSpecFiles({}), /DU_SPEC_DIR is not set/);
    assert.throws(() => resolveSpecFiles({}), /DU_SPEC_DIR='\/path\/to\/DU Integration'/);
  });

  it("names the files it cannot find", () => {
    assert.throws(
      () => resolveSpecFiles({ DU_SPEC_DIR: "/nonexistent" }),
      /DU_Specification v1\.9\.3\.xlsx/,
    );
  });

  it("asks for the workbook and not for the vendored XSDs", () => {
    // The variable named five files once. Four of them are now in
    // src/infra/integrations/du-schema/xsd, and a message still demanding them
    // would send somebody hunting for a corpus to satisfy a check that no
    // longer reads it.
    const message = (() => {
      try {
        resolveSpecFiles({});
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    assert.match(message, /DU_Specification v1\.9\.3\.xlsx/);
    assert.doesNotMatch(message, /\.xsd/);
  });

  it("separates an unset variable from one pointing somewhere wrong", () => {
    // Two different events wearing one error class. Unset is a machine without
    // the licensed workbook; set-but-wrong is somebody who asked for the check
    // and typo'd the path, and reporting that as an absent workbook is how a
    // green build comes to have verified less than it looked like.
    assert.throws(() => resolveSpecFiles({}), { unset: true });
    assert.throws(() => resolveSpecFiles({ DU_SPEC_DIR: "/nonexistent" }), { unset: false });
  });
});

describe("--verify without the workbook", () => {
  it("still checks the vendored chain and the vendored samples, and says what it skipped", () => {
    // The vendored corpus is what makes this more than a skip: element order
    // comes back out of the XSDs and the arcs' corpus column out of the
    // eighteen samples, both on a machine with no workbook at all. So the
    // message names what did NOT get checked rather than calling the whole
    // regeneration check skipped.
    const result = runScript(["--verify"], {});
    assert.match(result.stdout, /child sequences in order\.ts match the vendored MISMO chain/);
    assert.match(result.stdout, /arcroles in arcroles\.ts are exercised by the vendored samples/);
    assert.match(
      result.stdout,
      /skipped the workbook check \(enums, lengths, cardinality, conditionality, and the arcroles' endpoints\): DU_SPEC_DIR is not set/,
    );
    assert.equal(result.status, 0, result.stderr);
  });

  it("names the two migration-reading checks it skipped, until the graph migration exists", () => {
    // A skipped check is reported by name and never as passed: a green line
    // over a diff that read nothing is the failure this script exists to
    // refuse. Once db/migrations/*_du_graph.sql lands, the same two lines have
    // to turn into checks that ran.
    const result = runScript(["--verify"], {});
    if (duGraphMigrationPaths().length === 0) {
      assert.match(
        result.stdout,
        /^- skipped the du_\* enum CHECK diff: no db\/migrations\/\*_du_graph\.sql yet \(Phase 3\)$/m,
      );
      assert.match(
        result.stdout,
        /^- skipped the per-kind asset CHECK diff: no db\/migrations\/\*_du_graph\.sql yet \(Phase 3\)$/m,
      );
      assert.doesNotMatch(result.stdout, /enum CHECK\(s\) in db\/migrations match/);
      assert.doesNotMatch(result.stdout, /per-kind asset CHECK\(s\) admit/);
    } else {
      assert.match(result.stdout, /^✓ \d+ du_\* enum CHECK\(s\) in db\/migrations match the DU Spec$/m);
      assert.match(result.stdout, /^✓ 3 per-kind asset CHECK\(s\) admit exactly their section's 22 AssetType values$/m);
      assert.doesNotMatch(result.stdout, /skipped the du_\* enum CHECK diff/);
      assert.doesNotMatch(result.stdout, /skipped the per-kind asset CHECK diff/);
    }
    assert.equal(result.status, 0, result.stderr);
  });

  it("is what `npm test` ends with", () => {
    // Homestead ran this step under a comment in its deploy workflow and tested
    // the comment against the output. Here the step is the tail of `npm test`,
    // so what is pinned is the tail: the audit ratchet and the name lint run
    // first, unchanged, and du:verify is the last thing that can fail a build.
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.equal(pkg.scripts["du:build"], "node tools/build-du.mjs");
    assert.equal(pkg.scripts["du:verify"], "node tools/build-du.mjs --verify");
    assert.ok(pkg.scripts.test?.endsWith(" && npm run du:verify"), pkg.scripts.test);
    assert.match(
      pkg.scripts.test ?? "",
      /python3 tools\/audit\.py --check && python3 tools\/spec_lint_names\.py && npm run du:verify$/,
    );
  });

  it("fails, and lists the files, when DU_SPEC_DIR points somewhere wrong", () => {
    const result = runScript(["--verify"], { DU_SPEC_DIR: "/nonexistent" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DU_SPEC_DIR is set to "\/nonexistent"/);
    // The whole message, not its first line: the list of what is missing is
    // the only part that says what to do about it.
    assert.match(result.stderr, /DU_Specification v1\.9\.3\.xlsx/);
    assert.match(result.stderr, /unset DU_SPEC_DIR to skip/);
  });
});

describe("the workbook's own column list", () => {
  it("names the two headings the two places spell differently", () => {
    // An alias is a hole in the check that stops a renamed or reordered column
    // from being read as the column beside it, so the count is part of the
    // promise: two headings need one, and a third arriving needs a reader.
    assert.deepEqual(Object.entries(COLUMN_NAME_ALIASES), [
      ["DU, Credit, Early Check Cardinality MIN:MAX", "DU, EC Cardinality MIN:MAX"],
      ["ArcRole", "ArcRoles"],
    ]);
  });

  it("splits the ArcRoles tab's two column lists rather than concatenating them", () => {
    // That tab is two tables under one heading. Read as one list, the second
    // table's headings would be compared against the first table's columns, and
    // the check that stops a reordered column would be checking nothing.
    const description = [
      { number: 1, cells: ["", "ArcRoles Tab", ""] },
      { number: 2, cells: ["", "Establishing Endpoints in the Relationship", ""] },
      { number: 3, cells: ["", "Column Name", "Column Definition"] },
      { number: 4, cells: ["", "ArcRoles", "The name of the ArcRole."] },
      { number: 5, cells: ["", "Source", "The source container."] },
      { number: 6, cells: ["", "Relationships Container", ""] },
      { number: 7, cells: ["", "Column Name", "Column Definition"] },
      { number: 8, cells: ["", "Value", "The name of the ArcRole."] },
      { number: 9, cells: ["", "DU Removals Tab*", ""] },
      { number: 10, cells: ["", "Field ID", "The reference number."] },
    ];
    assert.deepEqual(arcRoleColumnNamesFor(description, ARCROLE_SECTIONS), {
      endpoints: ["ArcRoles", "Source"],
      relationships: ["Value"],
    });
  });
});

describe("conditionality", () => {
  it("parses the statement shapes the sheet uses", () => {
    assert.deepEqual(parseConditionality("IF exists"), { kind: "self_exists" });
    assert.deepEqual(parseConditionality('IF LiabilityType = "Other"'), {
      kind: "compare",
      dataPoint: "LiabilityType",
      operator: "=",
      value: "Other",
    });
    assert.deepEqual(parseConditionality("IF PurchaseCreditType does not exist"), {
      kind: "absent",
      dataPoint: "PurchaseCreditType",
    });
    assert.deepEqual(parseConditionality('IF AssetType = "GiftOfCash" OR "Grant"'), {
      kind: "in",
      dataPoint: "AssetType",
      values: ["GiftOfCash", "Grant"],
    });
    // A bare data point in an OR chain is an existence test, and a lower-case
    // "and" is the same keyword as an upper-case one.
    assert.deepEqual(parseConditionality("IF NoteAmount OR HELOCMaximumBalanceAmount exists"), {
      kind: "or",
      terms: [
        { kind: "exists", dataPoint: "NoteAmount" },
        { kind: "exists", dataPoint: "HELOCMaximumBalanceAmount" },
      ],
    });
    assert.deepEqual(parseConditionality('IF ConstructionMethodType = "Manufactured" and exists'), {
      kind: "and",
      terms: [
        {
          kind: "compare",
          dataPoint: "ConstructionMethodType",
          operator: "=",
          value: "Manufactured",
        },
        { kind: "self_exists" },
      ],
    });
  });

  it("reads the sheet's curly quotes and trailing full stops", () => {
    assert.deepEqual(parseConditionality("IF RefinanceCashOutDeterminationType = “CashOut”"), {
      kind: "compare",
      dataPoint: "RefinanceCashOutDeterminationType",
      operator: "=",
      value: "CashOut",
    });
    assert.deepEqual(parseConditionality('IF LoanPurposeType = "Purchase" AND exists.'), {
      kind: "and",
      terms: [
        { kind: "compare", dataPoint: "LoanPurposeType", operator: "=", value: "Purchase" },
        { kind: "self_exists" },
      ],
    });
  });

  it("throws on a phrase nobody has written down", () => {
    // The prose in the sheet's one unparseable statement, on its own: a range
    // written as English rather than as an expression.
    assert.throws(
      () => parseConditionality("IF FinancedUnitCount > 1 but <5"),
      /Unrecognized conditionality phrase/,
    );
    assert.throws(
      () => parseConditionality("IF BorrowerAgeYears BETWEEN 18 AND 65"),
      /Unrecognized conditionality phrase/,
    );
    // A character the lexer has no token for, rather than a word it cannot
    // place: the two are different refusals and both have to happen.
    assert.throws(() => parseConditionality("IF Borrower% = 3"), /Unrecognized conditionality phrase/);
    assert.throws(
      () => parseConditionality('BorrowerResidencyType = "Current"'),
      /does not start with IF/,
    );
  });

  it("takes the one statement the grammar cannot, from the named list", () => {
    const named = UNPARSEABLE_STATEMENTS[0]!;
    assert.match(named.statement, /but <5/);
    assert.deepEqual(parseConditionality(named.statement), named.condition);
  });
});

describe("enumerations", () => {
  it("strips footnote markers and never corrects a spelling", () => {
    const rows = [
      enumerationRow("ExpenseType", "2d.1", "Alimony"),
      enumerationRow("ExpenseType", "2d.1", "ChildSupport**"),
      // Double lowercase i. Canonical in MISMOEnumeratedTypesB324.xsd itself.
      enumerationRow("ExpenseType", "2d.1", "AccessoryUnitIincome*"),
    ];
    const { enumerations } = deriveEnumerations(rows, {
      table: { DuExpenseType: { dataPoints: [{ name: "ExpenseType", formFields: ["2d.1"] }] } },
      disagreements: [],
      blanks: [],
      notInScope: [],
    });
    assert.deepEqual(enumerations.DuExpenseType, ["Alimony", "ChildSupport", "AccessoryUnitIincome"]);
  });

  it("derives DuAssetType to 22 members from 23 rows", () => {
    // The AssetType block of the tab: thirteen rows at 2a.1, seven at 2b.1 —
    // two of them the same "Other" — and three at 4d.1.
    const values: Array<[string, string]> = [
      ["2a.1", "Bond"],
      ["2a.1", "BridgeLoanNotDeposited"],
      ["2a.1", "CertificateOfDepositTimeDeposit"],
      ["2a.1", "CheckingAccount"],
      ["2a.1", "IndividualDevelopmentAccount**"],
      ["2a.1", "LifeInsurance"],
      ["2a.1", "MoneyMarketFund"],
      ["2a.1", "MutualFund"],
      ["2a.1", "RetirementFund"],
      ["2a.1", "SavingsAccount"],
      ["2a.1", "Stock"],
      ["2a.1", "StockOptions**"],
      ["2a.1", "TrustAccount"],
      ["2b.1", "CashOnHand"],
      ["2b.1", "Other"],
      ["2b.1", "Other"],
      ["2b.1", "PendingNetSaleProceedsFromRealEstateAssets"],
      ["2b.1", "ProceedsFromSaleOfNonRealEstateAsset**"],
      ["2b.1", "ProceedsFromSecuredLoan"],
      ["2b.1", "ProceedsFromUnsecuredLoan**"],
      ["4d.1", "GiftOfCash"],
      ["4d.1", "GiftOfPropertyEquity"],
      ["4d.1", "Grant"],
    ];
    assert.equal(values.length, 23);
    const { enumerations } = deriveEnumerations(
      values.map(([formField, value]) => enumerationRow("AssetType", formField, value)),
      {
        table: { DuAssetType: { dataPoints: [{ name: "AssetType", formFields: [] }] } },
        disagreements: [],
        blanks: [],
        notInScope: [],
      },
    );
    assert.equal(enumerations.DuAssetType?.length, 22);
    assert.deepEqual(
      enumerations.DuAssetType?.filter((v) => v === "Other"),
      ["Other"],
    );
  });

  it("throws on a blank cell outside the named exception list", () => {
    const table = {
      DuPropertyUsage: { dataPoints: [{ name: "PropertyCurrentUsageType", formFields: [] }] },
    };
    const rows = [
      enumerationRow("PropertyCurrentUsageType", "", "Investment"),
      enumerationRow("PropertyCurrentUsageType", "", "", { rowNumber: 412, ediCode: "R = Rental" }),
    ];
    assert.throws(
      () => deriveEnumerations(rows, { table, disagreements: [], blanks: [], notInScope: [] }),
      /Blank enumeration cell for PropertyCurrentUsageType at row 412/,
    );
    assert.throws(
      () => deriveEnumerations(rows, { table, disagreements: [], blanks: [], notInScope: [] }),
      /BLANK_ENUMERATION_CELLS/,
    );
  });

  it("takes the four blanks that are named, and gives both questions Yes and No", () => {
    // Read verbatim, IntentToOccupyType has only No and
    // HomeownerPastThreeYearsType has only Yes. The EDI Code Values column is
    // what says which blank stands for which answer.
    const rows = [
      enumerationRow("IntentToOccupyType", "5a.1", "No", { ediCode: "N = No" }),
      enumerationRow("IntentToOccupyType", "5a.1", "", { ediCode: "U = Unknown" }),
      enumerationRow("IntentToOccupyType", "5a.1", "", { ediCode: "Y = Yes" }),
      enumerationRow("HomeownerPastThreeYearsType", "5a.1.1", "", { ediCode: "N = No" }),
      enumerationRow("HomeownerPastThreeYearsType", "5a.1.1", "", { ediCode: "U = Unknown" }),
      enumerationRow("HomeownerPastThreeYearsType", "5a.1.1", "Yes", { ediCode: "Y = Yes" }),
    ];
    const { enumerations } = deriveEnumerations(rows, {
      table: {
        DuYesNo: {
          dataPoints: [
            { name: "IntentToOccupyType", formFields: ["5a.1"] },
            { name: "HomeownerPastThreeYearsType", formFields: ["5a.1.1"] },
          ],
        },
      },
      disagreements: [],
      blanks: BLANK_ENUMERATION_CELLS,
      notInScope: [],
    });
    assert.deepEqual(enumerations.DuYesNo, ["No", "Yes"]);
  });

  it("throws when a corrected workbook makes a named blank stale", () => {
    const rows = [enumerationRow("IntentToOccupyType", "5a.1", "No", { ediCode: "N = No" })];
    assert.throws(
      () =>
        deriveEnumerations(rows, {
          table: { DuYesNo: { dataPoints: [{ name: "IntentToOccupyType", formFields: ["5a.1"] }] } },
          disagreements: [],
          blanks: BLANK_ENUMERATION_CELLS,
          notInScope: [],
        }),
      /no longer blank/,
    );
  });

  it("throws when two data points behind one enum disagree", () => {
    const rows = [
      enumerationRow("IntentToOccupyType", "5a.1", "Yes"),
      enumerationRow("IntentToOccupyType", "5a.1", "No"),
      enumerationRow("HomeownerPastThreeYearsType", "5a.1.1", "Yes"),
    ];
    assert.throws(
      () =>
        deriveEnumerations(rows, {
          table: {
            DuYesNo: {
              dataPoints: [
                { name: "IntentToOccupyType", formFields: ["5a.1"] },
                { name: "HomeownerPastThreeYearsType", formFields: ["5a.1.1"] },
              ],
            },
          },
          disagreements: [],
          blanks: [],
          notInScope: [],
        }),
      /do not agree/,
    );
  });

  it("throws when narrowing an enum leaves a value behind unnamed", () => {
    const rows = [
      enumerationRow("FundsSourceType", "4d.3", "Relative"),
      enumerationRow("FundsSourceType", "", "PropertySeller"),
    ];
    const table = {
      DuFundsSourceType: { dataPoints: [{ name: "FundsSourceType", formFields: ["4d.3"] }] },
    };
    assert.throws(
      () => deriveEnumerations(rows, { table, disagreements: [], blanks: [], notInScope: [] }),
      /leaves PropertySeller behind/,
    );
    const { enumerations } = deriveEnumerations(rows, {
      table,
      disagreements: [],
      blanks: [],
      notInScope: [{ enumName: "DuFundsSourceType", values: ["PropertySeller"] }],
    });
    assert.deepEqual(enumerations.DuFundsSourceType, ["Relative"]);
  });
});

describe("the two tabs disagreeing about a form field", () => {
  // Each of the four is reproduced with two rows: the DU Map's id, and the DU
  // Enumerations tab's different id for the same named field.
  const cases = TAB_DISAGREEMENTS.map((entry) => ({
    entry,
    map: [mapRow(entry.dataPoint, entry.mapFormField)],
    enumerations: [
      enumerationRow(entry.dataPoint, entry.enumerationFormField, "SomeValue"),
      enumerationRow("SomethingElse", entry.mapFormField, "SomeValue"),
    ],
  }));

  for (const { entry, map, enumerations } of cases) {
    it(`reconciles ${entry.dataPoint} ${entry.mapFormField}`, () => {
      assert.doesNotThrow(() =>
        checkTabDisagreements(map, enumerations, {
          table: {
            Anything: {
              dataPoints: [{ name: map[0]!.dataPoint, formFields: [map[0]!.formFieldId] }],
            },
          },
          disagreements: [entry],
        }),
      );
    });
  }

  for (const { entry, map, enumerations } of cases) {
    it(`throws on ${entry.dataPoint} ${entry.mapFormField} when it is not on the list`, () => {
      assert.throws(
        () =>
          checkTabDisagreements(map, enumerations, {
            table: {
              Anything: {
                dataPoints: [{ name: map[0]!.dataPoint, formFields: [map[0]!.formFieldId] }],
              },
            },
            disagreements: TAB_DISAGREEMENTS.filter((d) => d !== entry),
          }),
        /has no such row/,
      );
    });
  }

  it("refuses to reconcile two ids the tabs give different names", () => {
    const entry = TAB_DISAGREEMENTS[0]!;
    assert.throws(
      () =>
        checkTabDisagreements(
          [mapRow(entry.dataPoint, entry.mapFormField, { formFieldName: "Type" })],
          [
            enumerationRow(entry.dataPoint, entry.enumerationFormField, "FHA", {
              formFieldName: "Mortgage Type Applied For",
            }),
          ],
          {
            table: { Anything: { dataPoints: [{ name: entry.dataPoint, formFields: [] }] } },
          },
        ),
      /disagree about more than the number/,
    );
  });
});

describe("child order", () => {
  // A schema stub in the shape parseSchemas produces: a type name, and its
  // children in the order the sequence declares them.
  const schema = {
    childrenOf(type: string) {
      const types: Record<string, Array<{ name: string; type: string; prefix: string }>> = {
        MESSAGE: [{ name: "DEAL_SETS", type: "DEAL_SETS", prefix: "" }],
        DEAL_SETS: [{ name: "DEAL_SET", type: "DEAL_SET", prefix: "" }],
        DEAL_SET: [
          { name: "PARTIES", type: "PARTIES", prefix: "" },
          { name: "DEALS", type: "DEALS", prefix: "" },
          { name: "EXTENSION", type: "DEAL_SET_EXTENSION", prefix: "" },
        ],
        DEALS: [],
        DEAL_SET_EXTENSION: [],
        PARTIES: [{ name: "PARTY", type: "PARTY", prefix: "" }],
        PARTY: [
          { name: "REFERENCE", type: "REFERENCE", prefix: "" },
          { name: "INDIVIDUAL", type: "INDIVIDUAL", prefix: "" },
          { name: "ROLES", type: "ROLES", prefix: "" },
          { name: "EXTENSION", type: "PARTY_EXTENSION", prefix: "" },
        ],
        REFERENCE: [],
        INDIVIDUAL: [],
        ROLES: [],
        PARTY_EXTENSION: [],
      };
      return types[type] ?? null;
    },
  };

  it("reads the order out of the schema rather than sorting it", () => {
    const { order } = buildOrderTable(schema, ["MESSAGE/DEAL_SETS/DEAL_SET/PARTIES/PARTY"]);
    // PARTY is where the walk ends and DEAL_SET is one it passes through. Both
    // orders are recorded, and neither is sorted.
    assert.deepEqual(order.get("PARTY"), ["REFERENCE", "INDIVIDUAL", "ROLES", "EXTENSION"]);
    assert.deepEqual(order.get("DEAL_SET"), ["PARTIES", "DEALS", "EXTENSION"]);
  });

  it("throws on a child name the complex type does not declare", () => {
    assert.throws(
      () => buildOrderTable(schema, ["MESSAGE/DEAL_SETS/DEAL_SET/PARTIES/PARTY/BORROWER"]),
      /PARTY does not declare a child named "BORROWER"/,
    );
  });

  it("throws on a path that does not start at MESSAGE", () => {
    assert.throws(() => buildOrderTable(schema, ["DEAL_SETS/DEAL_SET"]), /does not start at/);
  });
});

describe("reading the committed order table back", () => {
  // The XPath list the schema-order check walks comes out of the committed
  // file, because the workbook that named those XPaths is not on every machine.
  // That is what makes the check runnable in CI, and parsing is where it can
  // quietly stop working.
  const source = readFileSync(resolve(GENERATED, "order.ts"), "utf8");

  it("recovers both tables from the file the script writes", () => {
    const { childOrder, typeForPath } = parseGeneratedOrder(source);
    assert.deepEqual(childOrder["ABOUT_VERSIONS"], ["ABOUT_VERSION", "EXTENSION"]);
    assert.equal(typeForPath["MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL"], "DEAL");
  });

  it("stops rather than reading a hand-edited file as an empty table", () => {
    // An empty table would make the diff vacuous, and a vacuous diff is a green
    // tick over a file nobody checked.
    assert.throws(
      () => parseGeneratedOrder("export const CHILD_ORDER = {\n} as const;"),
      /no TYPE_FOR_PATH in the shape this script writes/,
    );
    assert.throws(() => parseGeneratedOrder("// nothing"), /no CHILD_ORDER in the shape this script writes/);
  });
});

describe("arc roles", () => {
  /**
   * One arc, described the way the ArcRoles tab describes every arc: once in
   * the endpoints section and once as a RELATIONSHIP block. The helpers below
   * bend one field at a time, which is the only way to tell the machinery from
   * the facts the real tab happens to carry.
   */
  const NS = "urn:fdc:mismo.org:2009:residential";
  const RELATIONSHIP = "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/RELATIONSHIPS/RELATIONSHIP";

  function endpointRow(extra: Partial<EndpointRow> = {}): EndpointRow {
    return {
      rowNumber: 4,
      arcRole: "ASSET is associated with LIABILITY",
      fromXPath: "DEAL/ASSETS/ASSET",
      source: "ASSET",
      verbPhrase: "IsAssociatedWith",
      toXPath: "DEAL/LIABILITIES/LIABILITY",
      target: "LIABILITY",
      ...extra,
    };
  }

  function relationshipRows(
    extra: { name?: string; declaration?: string; from?: string; to?: string } = {},
  ): RelationshipRow[] {
    const name = extra.name ?? "ASSET_IsAssociatedWith_LIABILITY";
    const blank = { arcRole: "", xpath: "", attribute: "", label: "", value: "", notes: "" };
    return [
      { ...blank, rowNumber: 23, arcRole: "ASSET to LIABILITY", xpath: RELATIONSHIP, notes: "If." },
      { ...blank, rowNumber: 24, attribute: "Sequence Number" },
      {
        ...blank,
        rowNumber: 25,
        label: extra.declaration ?? `arcrole="${NS}/${name}"`,
        value: name,
      },
      { ...blank, rowNumber: 26, label: "from", value: extra.from ?? "ASSET" },
      { ...blank, rowNumber: 27, label: "to", value: extra.to ?? "LIABILITY" },
    ];
  }

  const sections = (endpoints: EndpointRow[], relationships: RelationshipRow[]) => ({
    endpoints,
    relationships,
  });
  const corpus = (...uris: string[]) => new Map(uris.map((u) => [u, 1]));

  it("joins the tab's two sections into one arc", () => {
    const { table, relationshipXPath } = deriveArcRoles(
      sections([endpointRow()], relationshipRows()),
      corpus(`${NS}/ASSET_IsAssociatedWith_LIABILITY`),
      { disagreements: [] },
    );
    assert.equal(relationshipXPath, RELATIONSHIP);
    assert.deepEqual(table.ASSET_IsAssociatedWith_LIABILITY, {
      arcrole: `${NS}/ASSET_IsAssociatedWith_LIABILITY`,
      name: "ASSET_IsAssociatedWith_LIABILITY",
      verbPhrase: "IsAssociatedWith",
      from: {
        xpath: "DEAL/ASSETS/ASSET",
        container: "ASSET",
        relationshipEnd: "ASSET",
        arcroleTerm: "ASSET",
        disputed: false,
      },
      to: {
        xpath: "DEAL/LIABILITIES/LIABILITY",
        container: "LIABILITY",
        relationshipEnd: "LIABILITY",
        arcroleTerm: "LIABILITY",
        disputed: false,
      },
      note: "If.",
      exercised: true,
    });
  });

  it("assembles the URI from the namespace whether the cell holds all of it or not", () => {
    // Four of the eleven blocks type the namespace in the label cell and stop,
    // leaving the name in the cell beside it; the other seven type the whole
    // URI. A generator that copied the cell would emit four URIs ending at
    // ":residential".
    const short = deriveArcRoles(
      sections([endpointRow()], relationshipRows({ declaration: `arcrole="${NS}` })),
      corpus(),
      { disagreements: [] },
    );
    assert.equal(
      short.table.ASSET_IsAssociatedWith_LIABILITY?.arcrole,
      `${NS}/ASSET_IsAssociatedWith_LIABILITY`,
    );
    assert.throws(
      () =>
        deriveArcRoles(
          sections([endpointRow()], relationshipRows({ declaration: 'arcrole="urn:example:2020' })),
          corpus(),
          { disagreements: [] },
        ),
      /is neither/,
    );
  });

  it("marks an arc no sample carries, and refuses one no sample could", () => {
    // The corpus column is the half of this table that is checkable without the
    // workbook, so both directions have to be real.
    const unexercised = deriveArcRoles(sections([endpointRow()], relationshipRows()), corpus(), {
      disagreements: [],
    });
    assert.equal(unexercised.table.ASSET_IsAssociatedWith_LIABILITY?.exercised, false);
    assert.throws(
      () =>
        deriveArcRoles(
          sections([endpointRow()], relationshipRows()),
          corpus(`${NS}/INVENTED_IsAssociatedWith_ROLE`),
          { disagreements: [] },
        ),
      /The vendored samples carry .*INVENTED.*and the ArcRoles tab does not describe it/,
    );
  });

  it("names an end the tab disagrees with itself about, and does not pick one", () => {
    // The trap this table exists for. An emitter handed one name would arc to
    // the wrong element and validate anyway, because nothing in the XSD checks
    // where an arc lands.
    const disputed = deriveArcRoles(
      sections(
        [endpointRow({ target: "OWNED_PROPERTY_DETAIL" })],
        relationshipRows({ to: "LIABILITY" }),
      ),
      corpus(),
      { disagreements: [{ arcrole: "ASSET_IsAssociatedWith_LIABILITY", end: "to" }] },
    ).table.ASSET_IsAssociatedWith_LIABILITY!;
    assert.deepEqual(disputed.to, {
      xpath: "DEAL/LIABILITIES/LIABILITY",
      container: "OWNED_PROPERTY_DETAIL",
      relationshipEnd: "LIABILITY",
      arcroleTerm: "LIABILITY",
      disputed: true,
    });
  });

  it("stops on a disagreement nobody has read, and on one that healed", () => {
    assert.throws(
      () =>
        deriveArcRoles(
          sections([endpointRow({ target: "OWNED_PROPERTY_DETAIL" })], relationshipRows()),
          corpus(),
          { disagreements: [] },
        ),
      /ASSET_IsAssociatedWith_LIABILITY to[\s\S]*Do not pick one/,
    );
    assert.throws(
      () =>
        deriveArcRoles(sections([endpointRow()], relationshipRows()), corpus(), {
          disagreements: [{ arcrole: "ASSET_IsAssociatedWith_LIABILITY", end: "from" }],
        }),
      /names ends the tab now agrees about/,
    );
  });

  it("reads a prefix and a predicate as the element they name", () => {
    // DU:UNDERWRITING_VERIFICATION and ROLE[PartyRoleType = "Borrower"] are the
    // same elements the other three columns spell bare, and comparing them
    // verbatim would report nine of the eleven arcs as disputed.
    const arc = deriveArcRoles(
      sections(
        [
          endpointRow({
            arcRole: "LOAN is associated with ROLE",
            fromXPath: 'DEAL/LOANS/LOAN[LoanRoleType="RelatedLoan"]',
            source: "LOAN",
            toXPath: 'DEAL/PARTIES/PARTY/ROLE[PartyRoleType = "NotePayTo"]',
            target: "ROLE",
          }),
        ],
        relationshipRows({ name: "LOAN_IsAssociatedWith_ROLE", from: "LOAN", to: "ROLE" }),
      ),
      corpus(),
      { disagreements: [] },
    ).table.LOAN_IsAssociatedWith_ROLE!;
    assert.equal(arc.from.disputed, false);
    assert.equal(arc.to.disputed, false);
    assert.equal(arc.from.xpath, 'DEAL/LOANS/LOAN[LoanRoleType="RelatedLoan"]');
  });

  it("throws on a verb phrase, an attribute and a label it does not recognize", () => {
    // The generator's rule, applied to this tab: an arc the spec grows a new
    // vocabulary for stops the build rather than landing as a default.
    assert.throws(
      () =>
        deriveArcRoles(
          sections([endpointRow({ verbPhrase: "IsOwnedBy" })], relationshipRows()),
          corpus(),
          { disagreements: [] },
        ),
      /unrecognized Verb Phrase "IsOwnedBy"/,
    );
    const withAttribute = relationshipRows();
    withAttribute[1] = { ...withAttribute[1]!, attribute: "Label Number" };
    assert.throws(
      () => deriveArcRoles(sections([endpointRow()], withAttribute), corpus(), { disagreements: [] }),
      /unrecognized Attribute "Label Number"/,
    );
    const withLabel = relationshipRows();
    withLabel[3] = { ...withLabel[3]!, label: "through" };
    assert.throws(
      () => deriveArcRoles(sections([endpointRow()], withLabel), corpus(), { disagreements: [] }),
      /unrecognized xLink:label row "through"/,
    );
  });

  it("stops when the two sections do not cover the same arcs", () => {
    // Either section can grow a row the other does not have, and each is a
    // different kind of half-described arc. Neither may be dropped quietly.
    assert.throws(
      () => deriveArcRoles(sections([], relationshipRows()), corpus(), { disagreements: [] }),
      /has a RELATIONSHIP block and no endpoints row/,
    );
    assert.throws(
      () =>
        deriveArcRoles(
          sections([endpointRow({ arcRole: "EXPENSE is associated with ROLE" })], relationshipRows()),
          corpus(),
          { disagreements: [] },
        ),
      /describes the endpoints of EXPENSE_IsAssociatedWith_ROLE/,
    );
    const noTo = relationshipRows().slice(0, -1);
    assert.throws(
      () => deriveArcRoles(sections([endpointRow()], noTo), corpus(), { disagreements: [] }),
      /ASSET_IsAssociatedWith_LIABILITY has no to row/,
    );
  });

  it("stops when the prose and the Verb Phrase column disagree", () => {
    // The prose is what joins the two sections, and it is the only column that
    // names the same element the arcrole URI does. Reading it loosely is how a
    // row joins an arc that is not its own.
    assert.throws(
      () =>
        deriveArcRoles(
          sections([endpointRow({ arcRole: "ASSET belongs to LIABILITY" })], relationshipRows()),
          corpus(),
          { disagreements: [] },
        ),
      /spells the verb phrase "belongsto"/,
    );
  });

  it("recovers the committed table, and stops rather than reading a hand-edit as empty", () => {
    const source = readFileSync(resolve(GENERATED, "arcroles.ts"), "utf8");
    const table = parseGeneratedArcRoles(source);
    assert.equal(table.ASSET_IsAssociatedWith_ROLE?.arcrole, `${NS}/ASSET_IsAssociatedWith_ROLE`);
    assert.throws(
      () => parseGeneratedArcRoles("// nothing"),
      /no DU_ARCROLES in the shape this script writes/,
    );
  });

  it("finds the arcroles the vendored samples carry", () => {
    const counts = arcRolesInCorpus();
    assert.ok((counts.get(`${NS}/ASSET_IsAssociatedWith_ROLE`) ?? 0) > 0);
    assert.equal(counts.has(`${NS}/UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET`), false);
  });
});

describe("formats and cardinality", () => {
  it("parses the widths the sheet writes", () => {
    assert.deepEqual(parseFormat("String 35"), { kind: "string", maxLength: 35 });
    assert.deepEqual(parseFormat("Amount 9.2"), { kind: "amount", digits: 9, decimals: 2 });
    assert.deepEqual(parseFormat("Numeric 9"), { kind: "numeric", digits: 9 });
    assert.deepEqual(parseFormat("String  (DU Enumerated)"), { kind: "string_enumerated" });
  });

  it("throws rather than guessing a width", () => {
    assert.throws(() => parseFormat("String"), /Unrecognized DU Data Point Format/);
    assert.throws(() => parseFormat("Text 35"), /Do not guess a width/);
  });

  it("reads MIN:MAX and N/A", () => {
    assert.deepEqual(parseCardinality("0:50", "MESSAGE"), { min: 0, max: 50 });
    assert.equal(parseCardinality("N/A", "MESSAGE"), null);
    assert.throws(() => parseCardinality("0-50", "MESSAGE"), /Unrecognized cardinality/);
    assert.throws(() => parseCardinality("5:1", "MESSAGE"), /minimum above its maximum/);
  });
});

describe("cutting a migration into statements", () => {
  it("keeps a `;` inside a literal, an E-string and a dollar-quoted body out of the cut", () => {
    const sql = [
      "COMMENT ON TABLE t IS 'one; with ''quotes'' inside';",
      "SELECT E'back\\'slash; escaped';",
      "CREATE FUNCTION f() RETURNS trigger AS $body$ BEGIN IF NEW.x IN ('a') THEN RAISE 'no;'; END IF; END; $body$ LANGUAGE plpgsql;",
      "-- a comment; with a semicolon",
      "/* and a block; comment */ ALTER TABLE t ADD CHECK (x IN ('b'))",
    ].join("\n");
    const statements = splitSqlStatements(sql);
    assert.equal(statements.length, 4);
    assert.equal(statements[0], "COMMENT ON TABLE t IS 'one; with ''quotes'' inside'");
    assert.equal(statements[1], "SELECT E'back\\'slash; escaped'");
    assert.doesNotMatch(statements[2]!, /IN \('a'\)/);
    assert.equal(statements[3], "ALTER TABLE t ADD CHECK (x IN ('b'))");
  });

  it("stops on a literal or a body that never closes", () => {
    assert.throws(() => splitSqlStatements("SELECT 'open"), /unterminated string literal/);
    assert.throws(() => splitSqlStatements("CREATE FUNCTION f() AS $$ BEGIN"), /unterminated \$\$ body/);
    assert.throws(() => splitSqlStatements("/* open"), /unterminated \/\* comment/);
  });

  it("cuts every migration in the tree", () => {
    // The enum CHECK diff reads all of db/migrations once the graph migration
    // lands, so the reader has to take every file that is already there.
    const sources = migrationSources();
    assert.ok(sources.length > 100);
    for (const { file, sql } of sources) {
      const statements = splitSqlStatements(sql);
      assert.ok(statements.length > 0, file);
    }
  });
});

describe("the du_* enum CHECK diff", () => {
  /**
   * A graph migration in the shape the convention at the top of the generator
   * states, with one of everything the reader has to ignore: a comment that
   * looks like an IN list, a NOT IN list, a column that is ours, a trigger body
   * naming a value, and a table that is not du_* wearing a DU comment.
   */
  const GRAPH_SQL = `
-- the borrower's expenses; a comment that says IN ('Decoy') is prose
CREATE TABLE du_expenses (
  id            uuid PRIMARY KEY,
  expense_type  text NOT NULL CHECK (expense_type IN ('Alimony', 'ChildSupport', 'JobRelatedExpenses', 'Other', 'SeparateMaintenanceExpense')),
  kind          text NOT NULL CHECK (kind IN ('OURS', 'ALSO_OURS')),
  status        text NOT NULL CHECK (status NOT IN ('retired'))
);
COMMENT ON COLUMN du_expenses.expense_type IS 'DU ExpenseType';
COMMENT ON COLUMN du_expenses.kind IS 'Ours; a discriminator with no DU data point behind it';
CREATE TABLE du_liabilities (
  liability_type text NOT NULL,
  mortgage_type  text
);
ALTER TABLE du_liabilities
  ADD CONSTRAINT du_liabilities_type CHECK (liability_type IN ('CollectionsJudgmentsAndLiens', 'Installment', 'LeasePayment', 'Open30DayChargeAccount', 'Other', 'Revolving', 'Taxes', 'TaxLien', 'HELOC', 'MortgageLoan')),
  ADD CONSTRAINT du_liabilities_mortgage_type_needs_a_mortgage CHECK (mortgage_type IS NULL OR liability_type IN ('MortgageLoan', 'HELOC'));
COMMENT ON COLUMN du_liabilities.liability_type IS 'DU LiabilityType. 2c.1 and 3a.11 share the column';
CREATE OR REPLACE FUNCTION du_liabilities_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.liability_type IN ('Fabricated') THEN RAISE EXCEPTION 'no'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TABLE not_du_table (
  flavor text CHECK (flavor IN ('Vanilla'))
);
COMMENT ON COLUMN not_du_table.flavor IS 'DU AssetType';
`;

  const found = duEnumChecksInMigrations([{ file: "db/migrations/9999_du_graph.sql", sql: GRAPH_SQL }]);

  it("reads the commented du_* columns and their IN lists, and nothing the convention excludes", () => {
    assert.deepEqual(
      [...found.comments.entries()].map(([column, { dataPoint }]) => [column, dataPoint]),
      [
        ["du_expenses.expense_type", "ExpenseType"],
        ["du_liabilities.liability_type", "LiabilityType"],
      ],
    );
    assert.deepEqual(
      found.lists.get("du_expenses.expense_type")?.map((l) => l.values),
      [["Alimony", "ChildSupport", "JobRelatedExpenses", "Other", "SeparateMaintenanceExpense"]],
    );
    // A column that is ours is read but never diffed; a NOT IN list is not read.
    assert.deepEqual(found.lists.get("du_expenses.kind")?.map((l) => l.values), [["OURS", "ALSO_OURS"]]);
    assert.equal(found.lists.has("du_expenses.status"), false);
    // The trigger body's IN list and the non-du_* table are invisible.
    assert.equal(found.lists.has("not_du_table.flavor"), false);
    for (const lists of found.lists.values()) {
      for (const list of lists) assert.ok(!list.values.includes("Fabricated"));
    }
  });

  it("unions every list that names a column", () => {
    assert.deepEqual(
      found.lists.get("du_liabilities.liability_type")?.map((l) => l.values.length),
      [10, 2],
    );
  });

  it("passes when the migrations agree with enums.ts", () => {
    const generated = parseGeneratedEnums(readFileSync(resolve(GENERATED, "enums.ts"), "utf8"));
    assert.deepEqual(diffDuEnumChecks(found, generated.enumerations), []);
  });

  it("fails on a member with no row in the spec", () => {
    // The shape of the defect this check exists for: a value in a block that
    // claimed to be generated, and in no tab of the spec.
    const fabricated = duEnumChecksInMigrations([
      {
        file: "db/migrations/9999_du_graph.sql",
        sql:
          "CREATE TABLE du_assets (asset_type text CHECK (asset_type IN ('CheckingAccount', 'SecuredBorrowedFundsNotDeposited')));\n" +
          "COMMENT ON COLUMN du_assets.asset_type IS 'DU AssetType';",
      },
    ]);
    assert.deepEqual(diffDuEnumChecks(fabricated, { DuAssetType: ["CheckingAccount"] }), [
      "du_assets.asset_type admits SecuredBorrowedFundsNotDeposited, which has no row in the DU " +
        "Enumerations tab for AssetType (DuAssetType).",
    ]);
  });

  it("fails in the other direction too", () => {
    const narrow = duEnumChecksInMigrations([
      {
        file: "db/migrations/9999_du_graph.sql",
        sql:
          "CREATE TABLE du_assets (asset_type text CHECK (asset_type IN ('CheckingAccount')));\n" +
          "COMMENT ON COLUMN du_assets.asset_type IS 'DU AssetType';",
      },
    ]);
    assert.deepEqual(diffDuEnumChecks(narrow, { DuAssetType: ["CheckingAccount", "SavingsAccount"] }), [
      "du_assets.asset_type is missing SavingsAccount, which the DU Enumerations tab carries for " +
        "AssetType (DuAssetType).",
    ]);
  });

  it("fails on a comment naming a data point DU_DATA_POINT_FOR_ENUM does not map", () => {
    const invented = duEnumChecksInMigrations([
      {
        file: "db/migrations/9999_du_graph.sql",
        sql:
          "CREATE TABLE du_assets (kind text CHECK (kind IN ('Whatever')));\n" +
          "COMMENT ON COLUMN du_assets.kind IS 'DU InventedType';",
      },
    ]);
    const problems = diffDuEnumChecks(invented, {});
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /du_assets\.kind is commented "DU InventedType"/);
    assert.match(problems[0]!, /is not a data point DU_DATA_POINT_FOR_ENUM maps/);
  });

  it("fails on a commented column with no IN list to diff", () => {
    const bare = duEnumChecksInMigrations([
      {
        file: "db/migrations/9999_du_graph.sql",
        sql: "CREATE TABLE du_assets (asset_type text);\nCOMMENT ON COLUMN du_assets.asset_type IS 'DU AssetType';",
      },
    ]);
    assert.deepEqual(diffDuEnumChecks(bare, { DuAssetType: ["CheckingAccount"] }), [
      "du_assets.asset_type is commented \"DU AssetType\" and no CHECK on du_assets names the values it admits.",
    ]);
  });

  it("refuses one column commented with two data points across migrations", () => {
    assert.throws(
      () =>
        duEnumChecksInMigrations([
          { file: "db/migrations/0001_a.sql", sql: "COMMENT ON COLUMN du_assets.asset_type IS 'DU AssetType';" },
          { file: "db/migrations/0002_b.sql", sql: "COMMENT ON COLUMN du_assets.asset_type IS 'DU LiabilityType';" },
        ]),
      /One column, one data point/,
    );
  });

  it("reads double-quoted identifiers the way Prisma spells them", () => {
    const quoted = duEnumChecksInMigrations([
      {
        file: "db/migrations/9999_du_graph.sql",
        sql:
          'CREATE TABLE "du_expenses" ("expense_type" TEXT NOT NULL);\n' +
          'ALTER TABLE "du_expenses" ADD CONSTRAINT "du_expenses_type" CHECK ("expense_type" IN (\'Alimony\'));\n' +
          'COMMENT ON COLUMN "du_expenses"."expense_type" IS \'DU ExpenseType\';',
      },
    ]);
    assert.deepEqual(diffDuEnumChecks(quoted, { DuExpenseType: ["Alimony"] }), []);
  });
});

describe("DU_DATA_POINT_FOR_ENUM", () => {
  it("gives every enum either a data point or a declaration that it is ours", () => {
    for (const [name, spec] of Object.entries(DU_DATA_POINT_FOR_ENUM)) {
      assert.match(name, /^Du[A-Z]/);
      if (spec.local) {
        assert.equal(spec.dataPoints, undefined);
        continue;
      }
      assert.ok((spec.dataPoints?.length ?? 0) > 0, name);
      for (const dataPoint of spec.dataPoints ?? []) {
        assert.equal(typeof dataPoint.name, "string");
        assert.ok(Array.isArray(dataPoint.formFields));
      }
    }
  });

  it("maps each data point to one enum, so a column comment names one member list", () => {
    // The enum CHECK diff joins a column's `DU <DataPoint>` comment to an enum
    // through this table, and throws if the join is not a function. The
    // committed table has to pass that join with nothing to diff.
    assert.deepEqual(diffDuEnumChecks({ comments: new Map(), lists: new Map() }, {}), []);
  });
});

describe("the AssetType partition, and the CHECKs that carry it", () => {
  /** The AssetType block of the tab: thirteen at 2a.1, six at 2b.1, three at 4d.1. */
  const ASSET_TYPE_ROWS: Array<[string, string]> = [
    ["2a.1", "Bond"],
    ["2a.1", "BridgeLoanNotDeposited"],
    ["2a.1", "CertificateOfDepositTimeDeposit"],
    ["2a.1", "CheckingAccount"],
    ["2a.1", "IndividualDevelopmentAccount**"],
    ["2a.1", "LifeInsurance"],
    ["2a.1", "MoneyMarketFund"],
    ["2a.1", "MutualFund"],
    ["2a.1", "RetirementFund"],
    ["2a.1", "SavingsAccount"],
    ["2a.1", "Stock"],
    ["2a.1", "StockOptions**"],
    ["2a.1", "TrustAccount"],
    ["2b.1", "CashOnHand"],
    ["2b.1", "Other"],
    ["2b.1", "PendingNetSaleProceedsFromRealEstateAssets"],
    ["2b.1", "ProceedsFromSaleOfNonRealEstateAsset**"],
    ["2b.1", "ProceedsFromSecuredLoan"],
    ["2b.1", "ProceedsFromUnsecuredLoan**"],
    ["4d.1", "GiftOfCash"],
    ["4d.1", "GiftOfPropertyEquity"],
    ["4d.1", "Grant"],
  ];

  const rowsFor = (values: Array<[string, string]>) =>
    values.map(([formField, value]) => enumerationRow("AssetType", formField, value));

  /**
   * The three per-kind CHECKs in the shape Phase 3's `*_du_graph.sql` writes
   * them: bare identifiers, a `--` comment with a parenthesis inside a CHECK,
   * and the list beside the columns each kind requires. Homestead's committed
   * migration is not in this tree, so this stands in for it until the real one
   * does — and the last test below reads the real one once it exists.
   */
  const ASSET_SHAPE_SQL = `
ALTER TABLE du_assets
  ADD CONSTRAINT du_assets_deposit_account_shape CHECK (
    kind <> 'DEPOSIT_ACCOUNT' OR (
      asset_type IS NOT NULL
      -- the thirteen at 2a.1 (accounts)
      AND asset_type IN ('Bond','BridgeLoanNotDeposited','CertificateOfDepositTimeDeposit',
                         'CheckingAccount','IndividualDevelopmentAccount','LifeInsurance',
                         'MoneyMarketFund','MutualFund','RetirementFund','SavingsAccount',
                         'Stock','StockOptions','TrustAccount')
      AND cash_or_market_value_cents IS NOT NULL
      AND holder_name IS NOT NULL
    )
  ),
  ADD CONSTRAINT du_assets_other_asset_shape CHECK (
    kind <> 'OTHER_ASSET' OR (
      asset_type IS NOT NULL
      AND asset_type IN ('CashOnHand','Other','PendingNetSaleProceedsFromRealEstateAssets',
                         'ProceedsFromSaleOfNonRealEstateAsset','ProceedsFromSecuredLoan',
                         'ProceedsFromUnsecuredLoan')
      AND cash_or_market_value_cents IS NOT NULL
    )
  ),
  ADD CONSTRAINT du_assets_gift_or_grant_shape CHECK (
    kind <> 'GIFT_OR_GRANT' OR (
      asset_type IS NOT NULL
      AND asset_type IN ('GiftOfCash','GiftOfPropertyEquity','Grant')
      AND funds_source_type IS NOT NULL
    )
  );
`;

  it("splits AssetType the way the tab files it, footnote markers and all", () => {
    const sections = deriveAssetTypeSections(rowsFor(ASSET_TYPE_ROWS));
    assert.deepEqual(Object.keys(sections), ["2a.1", "2b.1", "4d.1"]);
    assert.equal(sections["2a.1"]?.length, 13);
    assert.equal(sections["2b.1"]?.length, 6);
    assert.deepEqual(sections["4d.1"], ["GiftOfCash", "GiftOfPropertyEquity", "Grant"]);
    // The marker is the tab's "new for DU" footnote and not part of the value.
    assert.ok(sections["2a.1"]?.includes("StockOptions"));
    assert.doesNotMatch(sections["2a.1"]?.join(" ") ?? "*", /\*/);
  });

  it("stops on a fourth section rather than dropping its values", () => {
    // A spec revision that files a value under a section no kind reads is a
    // value that would silently belong to no CHECK.
    assert.throws(
      () => deriveAssetTypeSections(rowsFor([...ASSET_TYPE_ROWS, ["2b.2", "Cryptocurrency"]])),
      /files AssetType under 2b\.2/,
    );
  });

  it("stops on a section the tab no longer carries", () => {
    assert.throws(
      () => deriveAssetTypeSections(rowsFor(ASSET_TYPE_ROWS.filter(([field]) => field !== "4d.1"))),
      /no members at form field 4d\.1/,
    );
  });

  it("reads the three lists out of the migration that carries them", () => {
    const lists = assetTypeListsInMigration(ASSET_SHAPE_SQL);
    assert.equal(lists.du_assets_deposit_account_shape?.length, 13);
    assert.equal(lists.du_assets_other_asset_shape?.length, 6);
    assert.deepEqual(lists.du_assets_gift_or_grant_shape, ["GiftOfCash", "GiftOfPropertyEquity", "Grant"]);
    // Prisma double-quotes the constraint name; the reader takes both spellings.
    const quoted = ASSET_SHAPE_SQL.replace(
      "ADD CONSTRAINT du_assets_other_asset_shape",
      'ADD CONSTRAINT "du_assets_other_asset_shape"',
    );
    assert.equal(assetTypeListsInMigration(quoted).du_assets_other_asset_shape?.length, 6);
  });

  it("fails a shape CHECK that constrains the columns and not the type", () => {
    const sql = ASSET_SHAPE_SQL.replace(
      /asset_type IN \('CashOnHand',[\s\S]*?'ProceedsFromUnsecuredLoan'\)\n\s+AND /,
      "",
    );
    assert.notEqual(sql, ASSET_SHAPE_SQL);
    assert.throws(
      () => assetTypeListsInMigration(sql),
      /du_assets_other_asset_shape does not name the AssetType values it admits/,
    );
  });

  it("names the migration it looked in when a CHECK is missing", () => {
    assert.throws(
      () => assetTypeListsInMigration("ALTER TABLE du_assets ADD COLUMN x text;"),
      new RegExp(`${DU_GRAPH_MIGRATION_GLOB.replace(/[.*]/g, "\\$&")} has no CHECK named du_assets_deposit_account_shape`),
    );
    assert.throws(
      () => assetTypeListsInMigration("ALTER TABLE du_assets ADD COLUMN x text;", { path: "db/migrations/0127_du_graph.sql" }),
      /db\/migrations\/0127_du_graph\.sql has no CHECK named/,
    );
  });

  it("names the value a CHECK admits from the wrong section, and the one it drops", () => {
    const sections = deriveAssetTypeSections(rowsFor(ASSET_TYPE_ROWS));
    const members = Object.values(sections).flat();
    const widened = {
      du_assets_deposit_account_shape: [...(sections["2a.1"] ?? []), "CashOnHand"],
      du_assets_other_asset_shape: (sections["2b.1"] ?? []).filter((v) => v !== "CashOnHand"),
      du_assets_gift_or_grant_shape: sections["4d.1"] ?? [],
    };
    assert.deepEqual(diffAssetTypeChecks(sections, widened, members), [
      "du_assets_deposit_account_shape admits CashOnHand, which the DU Enumerations tab does " +
        "not file under 2a.1.",
      "du_assets_other_asset_shape is missing CashOnHand, which the tab files under 2b.1; " +
        "no OTHER_ASSET row could hold it.",
    ]);
  });

  it("names a member no kind's CHECK admits", () => {
    const sections = deriveAssetTypeSections(rowsFor(ASSET_TYPE_ROWS));
    const lists = Object.fromEntries(
      ASSET_TYPE_SECTIONS.map((s) => [s.constraint, sections[s.formField] ?? []]),
    );
    assert.deepEqual(
      diffAssetTypeChecks(sections, lists, [...Object.values(sections).flat(), "Bullion"]),
      ["DuAssetType.Bullion is admitted by no kind's CHECK, so no row can carry it."],
    );
  });

  it("agrees with the fixture on the committed spec, with no spec directory", () => {
    // Both sides are committed files (enums.ts here; the migration once Phase 3
    // writes it), which is what makes a widened CHECK catchable on a machine
    // that has no DU_SPEC_DIR — and a widened CHECK has no other local symptom.
    const generated = readFileSync(resolve(GENERATED, "enums.ts"), "utf8");
    const sections = parseGeneratedAssetTypeSections(generated);
    const members = parseGeneratedEnums(generated).enumerations.DuAssetType ?? [];
    assert.deepEqual(diffAssetTypeChecks(sections, assetTypeListsInMigration(ASSET_SHAPE_SQL), members), []);
  });

  it("agrees with the graph migration on the committed spec, once it exists", (t) => {
    const paths = duGraphMigrationPaths();
    if (paths.length === 0) {
      t.skip(`no ${DU_GRAPH_MIGRATION_GLOB} yet (Phase 3)`);
      return;
    }
    const generated = readFileSync(resolve(GENERATED, "enums.ts"), "utf8");
    const sections = parseGeneratedAssetTypeSections(generated);
    const members = parseGeneratedEnums(generated).enumerations.DuAssetType ?? [];
    const lists = assetTypeListsInMigration(readFileSync(resolve(ROOT, paths[0]!), "utf8"), {
      path: paths[0]!,
    });
    assert.deepEqual(diffAssetTypeChecks(sections, lists, members), []);
  });
});
