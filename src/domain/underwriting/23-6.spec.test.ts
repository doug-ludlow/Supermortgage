// 23.6 Assemble and emit the DU Specification document (MISMO 3.4 B324 + DU/ULAD extensions)
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-6-assemble-and-emit-the-du-specification-document.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGeneratedOrder, schemaOrderProblems } from "../../../tools/build-du.mjs";

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
test("23.6-T10: Given `du:verify` run on a checkout with no `DU_SPEC_DIR`, then it re-derives every child sequence from the vendored chain, re-counts the arcs the samples exercise, checks every `Du*` CHECK constraint in the migrations against `DU_ENUMERATIONS`, reports the workbook check as skipped by name, and fails on any drift in `order.ts` or `arcroles.ts`.", { todo: true });
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
