// 23.6 Assemble and emit the DU Specification document (MISMO 3.4 B324 + DU/ULAD extensions)
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-6-assemble-and-emit-the-du-specification-document.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

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
test("23.6-T11: Given a hand edit to `generated/order.ts` that swaps two children, when `npm test` runs, then `du:verify` fails the build naming the container.", { todo: true });
test("23.6-T12: Given a request built from the refinance fixture, then `request_hash` equals the SHA-256 of the transmitted bytes and 23.1's duplicate-suppression test (23.1-T1's second identical build) still passes.", { todo: true });
