# 23.6 — Assemble and emit the DU Specification document (MISMO 3.4 B324 + DU/ULAD extensions)

| Attribute | Value |
|---|---|
| Section | 23 — Desktop Underwriter and the credit decision |
| Automation class | a (fully automated) |
| Capacity | Lender (partner is the seller; SM assembles as TSP). The emitted document is Fannie Mae-confidential loan-file material, retention `fnma_loan_file_life_plus_4y` |
| Trigger & frequency | On every 23.1 submission (`buildDuRequest`); the document replaces the canonical-JSON `xml_document` 23.1 carries today |
| Governing source | DU Specification v1.9.3 (DU Map tab: every data point, its XPath, its conditionality); `DU_Wrapper_3.4.0_B324.xsd` chain; DU Specification Test Case Suite (18 samples, June 2026) |
| Key deadlines | none of its own; 23.1's clocks govern when a document must exist |
| Timers | none |

### Blueprint row
23.1 builds a `DuRequest` whose `xml_document` field is sorted-key JSON and whose `request_hash` covers it. This process makes that field a real DU Specification document: a MISMO 3.4 Build 324 XML message with the DU and ULAD extension namespaces, every container in the child order the XSD sequence dictates, every `xlink:label` unique, every `RELATIONSHIP` arc emitted from the 23.5 graph, and every enumeration value one DU accepts (the DU Enumerations tab, not the wider MISMO set). It is written against six generated tables derived from Fannie's own specification — `order.ts`, `cardinality.ts`, `conditionality.ts`, `lengths.ts`, `enums.ts`, `arcroles.ts` — which a CI verify step re-derives on every run so a hand-edited table fails the build. The eighteen shipped samples are the golden files: the emitter must reproduce each of them, container for container, from a graph loaded from that sample.

### Verified requirement (as of 2026-09-14)
**Element order is `xsd:sequence` order, not alphabetical** — a serializer that sorts produces a document that fails schema validation. `generated/order.ts` (`CHILD_ORDER`, 227 sequences; `TYPE_FOR_PATH`) is read from the vendored chain, not typed. **[VERIFIED — re-derived by `du:verify` on every run.]**

**DU's enumerations are a subset of MISMO's** — emitting a value MISMO allows but DU does not is a document that validates locally and fails at Fannie Mae. `generated/enums.ts` holds the DU tab's members per data point. **[VERIFIED against the Enumerations tab of v1.9.3; the workbook is not in tree — see 23.5 Open question 3.]**

**Conditionality** — the DU Map marks each data point required / optional / conditional, and a conditional one carries one of 85 condition statements verbatim (e.g. "Required when LoanPurposeType = Refinance"). `generated/conditionality.ts` keys them by statement. **[VERIFIED against the workbook; the statements are Fannie's words — see 23.5 for whether spec text may remain in tree.]**

**Schema validity is necessary and nowhere near sufficient.** All of the following validate against the full chain: a dangling `xlink:to`, a duplicate `xlink:label`, an invented arcrole URI, duplicate `SequenceNumber`s, five borrowers, a deleted `RELATIONSHIPS` container, and a document with no `LOANS` and no `PARTY`. Each is a test in `src/infra/integrations/du-schema/schema.test.ts`, so nobody later promotes `xmllint` to a gate. **[VERIFIED — the tests exist and pass.]**

**Discrepancies vs blueprint**: (1) 23.1's `mismo_version: "3.4-B324"` and `xml_document` names claimed an XML document that did not exist — this process makes the name true; `request_hash` becomes the SHA-256 of the emitted bytes. (2) 23.1's Integrations paragraph names "DU Spec request (MISMO 3.4 Build 324 with the DU extension data points)" — this process is that request; the transport stays in 23.1/23.7. (3) Rule 4 says a missing required point is a refusal, and the Trigger is every 23.1 submission; the runtime's 23.1 `buildDuRequest` (src/app/tools/section23-1.ts) assembles with `conditionality = report` instead, because the borrower flow does not yet collect every DU Map required point (the full TIN — `application_borrowers` keeps `tin_last4` — the current residence's basis, the subject's estate type: the section 32 amendments the hand-off's Phase 7 names), so a strict build would refuse every live application at the DU moment. The document is written with the point omitted, the gaps ride on the request (`document.gaps`), `du_documents.required_missing` and `du.document.emitted`, and 23.7's gate holds it (T5). The deviation ends when those amendments land and the runtime default becomes `refuse`.

### Operational prerequisites
- `src/infra/integrations/du-schema/` vendored in tree (nine XSDs, eighteen samples, README naming provenance); `xmllint` on every runner.
- `DU_SPEC_DIR` on the machine that regenerates the four workbook-derived tables (not on CI).
- The MISMO EULA question (23.5) — blocks a production submission, not this build.

### Build spec
#### Inputs and triggers
- `du.request.requested{application_id, casefile_id, submission_type, submission_number}` from 23.1's `buildDuRequest` — replaces the in-function JSON body.
- Reads: the 23.5 graph (`readDuGraph`), `applications`, `application_borrowers`, `application_properties`, `application_income`, `credit_reports` (22.2 reference numbers for reissue), `du_casefiles` (seller number, System ID, prior `du_casefile_id` for a resubmission).

#### Data model
- **`du_documents`** (new; append-only): `id uuid pk`, `application_id`, `casefile_id` → `du_casefiles`, `submission_id` → `du_submissions` (nullable until 23.1 records the row), `document_id` → `documents` (the XML bytes, retention `fnma_loan_file_life_plus_4y`, Fannie Mae-confidential), `sha256 bytea`, `spec_version text` (`1.9.3`), `mismo_build text` (`B324`), `container_count int`, `relationship_count int`, `borrower_count int`, `emitted_at`. One row per emission; a re-emission with identical bytes is a new row with the same hash (23.1's duplicate suppression reads the hash).
- Baseline tables written: `du_submissions` (`request_document_id` now references the row's `documents` id; `request_hash` = `du_documents.sha256`), `loan_events` (`du.document.emitted{sha256, container_count, relationship_count}`, `du.document.refused{code, path}`).

#### State machine
None. A document is emitted or refused; refusal is 23.7's preflight speaking before any bytes are written.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|

Jurisdiction overrides: none.

#### Business rules and calculations
1. **Containers, then arcs.** Emit every container with a deterministic `xlink:label` (`ASSET_1`, `PARTY_2_ROLE`, `LIABILITY_7` — numbered by the row's position in a stable sort on `created_at, id`), then the `RELATIONSHIPS` block, one `RELATIONSHIP` per arc in the 23.5 graph, `xlink:from`/`xlink:to` naming labels that exist in this document, `xlink:arcrole` from `generated/arcroles.ts`. The two `disputed` arcs are never emitted (23.5 Open question 2).
2. **Order from the schema.** Children of every container are written in `CHILD_ORDER[xpath]`. A child the table does not list for its parent is a build error, not a warning.
3. **Values from DU's tab.** Every enumerated data point is checked against `DU_ENUMERATIONS[point]` at emission; a value outside it is refused with the XPath. Lengths are checked against `DU_FORMATS`.
4. **Conditionality at emission.** A data point marked required, or conditional with its condition true for this loan, that has no value is a refusal naming the XPath and the condition statement — not an empty element and not an omission. The runtime assembles with `conditionality = report` until the section 32 amendments land (Discrepancy 3): the point is still never an empty element, the gap is recorded on `du_documents.required_missing` and the `du.document.emitted` payload, and 23.7's `SM_DU_PREFLIGHT_GATE` holds the document; the `underwriter` agent's own `assembleDuDocument` tool, and any caller passing `conditionality: "refuse"`, refuse.
5. **Money and rates.** `bigint` cents → MISMO `MISMOAmount` as a decimal string with two places; percentages as `MISMOPercent` with the precision `DU_FORMATS` names; dates as `MISMODate` (`YYYY-MM-DD`) from `PlainDate`. No rounding occurs here — the kernel's `Decimal` did it upstream.
6. **The hash is the bytes.** `request_hash` = SHA-256 of the UTF-8 document exactly as transmitted; canonical JSON of the snapshot is retired from 23.1.
7. **Golden files.** For each of the eighteen samples: parse the sample into a 23.5 graph (the loader is test-only), emit it, and compare to the sample container-by-container and arc-by-arc after normalizing whitespace and label names. A divergence names the first differing XPath.
8. **Casefile identifiers.** `AutomatedUnderwritingCaseIdentifier` is DU's own `applications.du_casefile_id` on a resubmission and absent on a first submission; our `aus_casefile_id` never goes on the wire as DU's.

#### Integrations
- None outbound. 23.1's `fnma-du` port consumes the emitted document; 23.7 gates it.

#### Outputs and artifacts
- The XML document as a `documents` row (Fannie Mae-confidential; never borrower-deliverable), the `du_documents` row, `du.document.emitted`.

#### AI agent design (AI-first)
`underwriter` agent (package `agents/underwriter`; this process uses tools `assembleDuDocument`, `validateDuDocumentAgainstSchema`, `diffDuDocumentAgainstSample`, `readDuDocument`). End-to-end: assembles on 23.1's request; never edits a document by hand; never emits a disputed arc; never fills a required data point with a default. Decision record: `{application_id, casefile_id, submission_number, sha256, spec_version, container_count, relationship_count, rule_set_version, model_version: null}` — no model is involved in assembly. Guardrails: the agent cannot write to `documents` except through `assembleDuDocument`; a document that fails schema validation is never persisted.

#### Edge cases and failure modes
- A borrower with wage income and two current employments → the income item's employer FK names one; the arc goes to that one; `EmploymentIncomeIndicator` true. A wage item with no employer → indicator false and no arc (23.5 rule 2) — and 23.7's preflight refuses the document as DI-C04 shows this shape is a rejection.
- A joint account still held as two rows (22.4 not yet reconciled) → two `ASSET` containers, each with one arc; the document is legal and the reserves double-count is 23.7's `DU_PREFLIGHT_DUPLICATE_ASSET` refusal.
- Sample DI-C09 (three borrowers, two assets each with two owners, two liabilities each with two obligors, each of those owned properties securing one of those liabilities, income items to employers) must round-trip exactly — it is the first golden file to make pass.
- A PARTY with two `ROLE` containers → refused `DU_LABEL_DUPLICATE` naming the second ROLE's XPath: a ROLE's label is its PARTY's (`PARTY_n_ROLE`), the XSD accepts a duplicate label, and 23.5 gives a borrowing party one role — a second is a data-model question, never a document with two containers under one label.
- A `du_casefile_id` present but `submission_number = 1` → refused: the identifier can only have come from a prior submission.
- An enumeration value that the MISMO XSD admits and the DU tab does not → refused before validation, with the XPath and the DU-admitted list.

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 23.6-T1 | Given each of the eighteen samples in `src/infra/integrations/du-schema/samples/`, when it is loaded into a 23.5 graph and re-emitted, then the emitted document validates against the vendored chain and matches the sample container-for-container and arc-for-arc after label normalization. |
| 23.6-T2 | Given sample DI-C09, when re-emitted, then the `RELATIONSHIPS` block carries exactly its arcs: the two two-owner assets each yield two `ASSET_IsAssociatedWith_ROLE` arcs, the two two-obligor liabilities each two `LIABILITY_IsAssociatedWith_ROLE` arcs, two `ASSET_IsAssociatedWith_LIABILITY` (each of those owned properties securing one of those liabilities), and one `CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER` per employed income item. |
| 23.6-T3 | Given the refinance fixture (23.1-T1), when the document is emitted, then every container's children appear in `CHILD_ORDER` sequence, and moving any one child breaks schema validation. |
| 23.6-T4 | Given a data point whose value is in the MISMO enumeration but not in `DU_ENUMERATIONS`, when emitted, then the emission is refused with `DU_ENUM_NOT_SUPPORTED` naming the XPath, and no `documents` row is written. |
| 23.6-T5 | Given a required data point with no value, when emitted, then the emission is refused with `DU_REQUIRED_MISSING` naming the XPath; given a conditional data point whose condition statement is false for this loan, then its absence is accepted; given the same missing point on 23.1's `buildDuRequest` (the runtime's `conditionality = report`, Discrepancy 3), then the document is written without the point — never an empty element — and the gap names the XPath in `required_missing` on the request, the `du_documents` row and `du.document.emitted`. |
| 23.6-T6 | Given a first submission, when emitted, then `AutomatedUnderwritingCaseIdentifier` is absent; given `applications.du_casefile_id = 1234567890` and `submission_number = 2`, then it is present with that value. |
| 23.6-T7 | Given the same graph emitted twice, then the two documents are byte-identical and `du_documents.sha256` is equal; given one asset's balance changes by one cent, then the hashes differ. |
| 23.6-T8 | Given the 23.5 graph for the refinance fixture, when emitted, then `xlink:label` values are unique across the document and every `xlink:from`/`xlink:to` names a label the document contains. |
| 23.6-T9 | Given a wage income item with no employer, when emitted, then `EmploymentIncomeIndicator` is false and no employer arc is written for it. |
| 23.6-T10 | Given `du:verify` run on a checkout with no `DU_SPEC_DIR`, then it re-derives every child sequence from the vendored chain, re-counts the arcs the samples exercise, checks every `Du*` CHECK constraint in the migrations against `DU_ENUMERATIONS`, reports the workbook check as skipped by name, and fails on any drift in `order.ts` or `arcroles.ts`. |
| 23.6-T11 | Given a hand edit to `generated/order.ts` that swaps two children, when `npm test` runs, then `du:verify` fails the build naming the container. |
| 23.6-T12 | Given a request built from the refinance fixture, then `request_hash` equals the SHA-256 of the transmitted bytes and 23.1's duplicate-suppression test (23.1-T1's second identical build) still passes. |

#### Audit and evidence
Per submission: the XML document bytes and their hash, the schema-validation result, the golden-diff (test-only), and the `du.document.emitted` event — exportable with the 23.1 submission record.

### Open questions / decisions
1. Where does the test-only sample loader live — `src/domain/underwriting/fixtures/du-sample-loader.ts`? **Default: yes, test-only, never imported by runtime.**
2. Is the workbook vendored so CI can verify `enums.ts`, `lengths.ts`, `cardinality.ts` and `conditionality.ts`? **Default: no (23.5 Q3).**

### Sources
- Fannie Mae, DU Specification v1.9.3 — DU Map tab.
- MISMO Reference Model v3.4 B324; xlink usage per `xlinkMISMOB324.xsd`.
- Fannie Mae, DU Specification Test Case Suite, June 2026.
- Homestead-Mortgages `docs/du-generation.md`, `scripts/build-du.mjs`, `packages/du/src/generated/`.
