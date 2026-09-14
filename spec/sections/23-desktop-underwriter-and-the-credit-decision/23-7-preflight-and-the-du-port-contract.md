# 23.7 — Preflight: what DU rejects that the schema accepts, and the port contract for a real submission

| Attribute | Value |
|---|---|
| Section | 23 — Desktop Underwriter and the credit decision |
| Automation class | a (fully automated); `fnma_portal_operator` only on the 23.1 outage path |
| Capacity | Lender (partner is the seller; SM is TSP) |
| Trigger & frequency | Between 23.6's emission and 23.1's `submit`; on every submission |
| Governing source | DU Specification v1.9.3 (Cardinality and ArcRoles tabs; DU Error Codes document **[UNVERIFIED — login-gated]**); DU Specification Test Case Suite; Selling Guide B3-2-01, B3-2-10 |
| Key deadlines | none of its own |
| Timers | `SM_DU_PREFLIGHT_GATE` |

### Blueprint row
The XSD proves a document is lexically legal. DU's own rejection — days later, with no local symptom — is the only other feedback loop unless something between the two refuses the documents DU would refuse. This process is that something: a set of checks on the emitted document and the graph behind it that encode what the corpus and the Cardinality/ArcRoles tabs say DU actually requires, run before any bytes reach the port, each refusal naming the XPath and the rule. It also fixes the `DuPort` contract so the FAKE and a real Direct Integration adapter are interchangeable: the port takes the emitted bytes, returns DU's own casefile identifier on the first acknowledgement, and the findings ingest writes that identifier once and only once.

### Verified requirement (as of 2026-09-14)
**What the XSD does not enforce (all VERIFIED by tests in `corpus/src/__tests__/schema.test.ts`)**: a dangling `xlink:to`; a duplicate `xlink:label`; an invented arcrole URI; duplicate `SequenceNumber`s within a container; five borrowers (DU allows four); a deleted `RELATIONSHIPS` container; a document with no `LOANS` and no `PARTY`. Each is a preflight refusal below.

**Cardinality tab** — container occurrence limits (171 XPaths), including four borrowers and 50 per `ASSETS`/`LIABILITIES`/`EXPENSES`. **[PARTIALLY VERIFIED — read from v1.9.3.]**

**Casefile identifier round-trip** — DU mints its own casefile identifier on the first submission; a resubmission must carry it; it is reported at delivery (A2-2-04; ULDD). Our `aus_casefile_id` is never DU's. **[VERIFIED against 23.1's own spec and B3-2-01.]**

**Discrepancies vs blueprint**: (1) 23.1 today persists our casefile id as `du_casefiles.casefile_id` and treats it as DU's; the build keeps `du_casefiles.casefile_id` as ours and adds DU's on `applications.du_casefile_id` (23.5), write-once. (2) 23.1's `DuPort.submit(req, n)` takes a `DuRequest` whose `xml_document` was JSON; the contract now takes the bytes and the hash, and the FAKE validates the bytes against the chain before answering so a FAKE run exercises the same path.

### Operational prerequisites
- The DU Error Codes document and the DI transport specification (login-gated) — owner: `fnma_portal_operator`; needed before a real adapter, not before this build.
- Whose credentials a submission goes in under: the partner's seller number with SM's TSP identity (23.1 already records this; 23.7 asserts both are present on the casefile before transmit).

### Build spec
#### Inputs and triggers
- `du.document.emitted` (23.6) → `runDuPreflight(document_id)`.
- On pass: `du.preflight.passed{document_id, checks}` opens `SM_DU_PREFLIGHT_GATE` and 23.1's `submit` proceeds. On refusal: `du.preflight.refused{document_id, code, xpath, rule}`; 23.1 does not transmit; 23.2's restructuring loop or the borrower rail (32.x) receives the ask.

#### Data model
- **`du_preflight_results`** (new; append-only): `id uuid pk`, `document_id` → `du_documents`, `application_id`, `passed boolean`, `checks jsonb` (one entry per check: `{code, passed, xpath, detail}`), `ran_at`. Every run is recorded, passing or not.
- Baseline tables written: `du_submissions` (`status` may move to `error` with `error_code = DU_PREFLIGHT_*` without a transmission), `loan_events` as above, `escalations` (none new).

#### State machine
None of its own; `SM_DU_PREFLIGHT_GATE` is the only state.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `SM_DU_PREFLIGHT_GATE` | not_before_gate | `du.document.emitted` | `emitted_at` | 0 | `du.preflight.passed` | hold; `du.submitted` cannot be emitted for the document |

Jurisdiction overrides: none.

#### Business rules and calculations
1. **Graph integrity.** Every `xlink:from`/`xlink:to` names a label in the document (`DU_PREFLIGHT_DANGLING_ARC`); labels are unique (`DU_PREFLIGHT_DUPLICATE_LABEL`); every arcrole is one of the eleven (`DU_PREFLIGHT_UNKNOWN_ARCROLE`); a disputed arcrole is never present (`DU_PREFLIGHT_DISPUTED_ARC`); a `RELATIONSHIPS` container exists when any owned container does (`DU_PREFLIGHT_NO_GRAPH`).
2. **Cardinality.** Borrowers ≤ 4 and ≥ 1 (`DU_PREFLIGHT_BORROWER_COUNT`); per-container limits from `DU_CARDINALITY` (`DU_PREFLIGHT_CARDINALITY`); `SequenceNumber` unique and contiguous from 1 within a container (`DU_PREFLIGHT_SEQUENCE`).
3. **Ownership on the wire.** Every `ASSET`, `LIABILITY`, `EXPENSE` has ≥ 1 arc to a `ROLE` (`DU_PREFLIGHT_ORPHAN`) — the database already guarantees this; the check exists so the guarantee is visible in the document, not only in the schema.
4. **Substance.** A `LOANS` container with one subject `LOAN`, a `PARTY` per borrower with a `ROLE` (`DU_PREFLIGHT_NOTHING_TO_UNDERWRITE`); a subject property; a credit reference per borrower for a non-`credit_only` submission (23.1 already refuses this — the check names the XPath).
5. **Duplicate assets.** Two `ASSET` containers with the same institution, subtype and last4 across two owners on one application (`DU_PREFLIGHT_DUPLICATE_ASSET`) — the joint-account double count; the fix is 22.4's reconciliation, not an emission tweak.
6. **Employer arcs.** A wage income item with `EmploymentIncomeIndicator = true` and no employer arc, or the reverse (`DU_PREFLIGHT_EMPLOYER_ARC`).
7. **Casefile identifier.** Absent on submission 1, present and equal to `applications.du_casefile_id` on submission > 1 (`DU_PREFLIGHT_CASEFILE_ID`).
8. **Credentials present.** `du_casefiles.seller_number`, `system_id_ref`, `tsp_product_ref` non-empty (`DU_PREFLIGHT_CREDENTIALS`).
9. **The port contract.** `DuPort.submit({document_bytes, sha256, casefile_id, submission_number, seller_number, system_id_ref}) → {du_casefile_id, acked_at}`; `DuPort.fetchFindings(du_casefile_id, submission_number) → DuFindings`. The FAKE validates `document_bytes` against the vendored chain with `xmllint` and refuses with `DuTransportError(400)` on failure, mints a deterministic ten-digit `du_casefile_id` on submission 1 and echoes it after, and answers findings as today. The ingest writes `applications.du_casefile_id` from the first ack (write-once trigger; a different value on a later ack is a `DU_CASEFILE_ID_CONFLICT` escalation to `fnma_portal_operator`, never an overwrite).

#### Integrations
- **`fnma-du`** (23.1's port; contract restated in rule 9). FAKE: `FakeDuPort` in `src/infra/integrations/du.ts` (moved out of the domain file), schema-validating. Real adapter: not built; **[UNVERIFIED transport]**.

#### Outputs and artifacts
- `du_preflight_results` rows; `du.preflight.passed` / `du.preflight.refused`; a refusal surfaces to 23.2 as a structural condition or to 32.x as a borrower ask (a missing declaration, a missing residence) — never as DU words to the borrower.

#### AI agent design (AI-first)
`underwriter` agent (package `agents/underwriter`; this process uses tools `runDuPreflight`, `readDuPreflight`, `explainDuRefusal`). End-to-end: runs preflight unprompted on every emission; on refusal maps the code to the 23.2 condition or the 32.x card that would clear it; never transmits a refused document; never edits the document to make a check pass. Decision record: `{document_id, passed, checks, rule_set_version}`. Guardrails: no bypass exists — there is no `officer` waiver for a preflight refusal, because every refusal is a document DU would reject. Escalations: `fnma_portal_operator` on `DU_CASEFILE_ID_CONFLICT`.

#### Edge cases and failure modes
- Preflight passes, DU rejects anyway (an error code the catalog does not know) → 23.1's error path; the code is added to preflight in the same commit as the triage, so the class of rejection is never seen twice.
- A document with zero assets on a refinance → legal; passes (reserves are DU's to judge).
- A `HomeReady` casefile → `COUNSELING_EVENT` absent → `DU_PREFLIGHT_COUNSELING_REQUIRED` until 23.5 rule 7 is built.
- FAKE port receives a document that fails `xmllint` → 400, and the test that produced it fails; the FAKE never silently accepts an invalid document.

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 23.7-T1 | Given each of the eighteen samples re-emitted (23.6-T1), when preflight runs, then every check passes and `SM_DU_PREFLIGHT_GATE` opens. |
| 23.7-T2 | Given a document whose `RELATIONSHIP` names an `xlink:to` label not in the document, when preflight runs, then it is refused with `DU_PREFLIGHT_DANGLING_ARC` naming the arc — and the same document validates against the XSD chain. |
| 23.7-T3 | Given a document with two containers labelled `ASSET_1`, then `DU_PREFLIGHT_DUPLICATE_LABEL`; given an arcrole URI not among the eleven, then `DU_PREFLIGHT_UNKNOWN_ARCROLE`; given `UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET`, then `DU_PREFLIGHT_DISPUTED_ARC` — each while the XSD chain validates the document. |
| 23.7-T4 | Given a document with five `PARTY` containers each holding a borrower `ROLE`, when preflight runs, then `DU_PREFLIGHT_BORROWER_COUNT`; given none, then `DU_PREFLIGHT_NOTHING_TO_UNDERWRITE`. |
| 23.7-T5 | Given a document whose `RELATIONSHIPS` container has been removed while `ASSET` containers remain, then `DU_PREFLIGHT_NO_GRAPH`. |
| 23.7-T6 | Given two `ASSET` containers with the same institution, subtype and last4 owned by different borrowers on one application, then `DU_PREFLIGHT_DUPLICATE_ASSET` naming both labels. |
| 23.7-T7 | Given `submission_number = 1` and an `AutomatedUnderwritingCaseIdentifier` present, then `DU_PREFLIGHT_CASEFILE_ID`; given `submission_number = 2` and the identifier absent or different from `applications.du_casefile_id`, then the same code. |
| 23.7-T8 | Given the FAKE port receives a document that fails `xmllint` against the chain, then it answers `DuTransportError` with status 400 and records no submission. |
| 23.7-T9 | Given the refinance fixture's first submission through the FAKE port, when the ack returns `du_casefile_id`, then `applications.du_casefile_id` holds it; when the second submission's ack returns the same value, then nothing changes; when it returns a different value, then an `escalation{fnma_portal_operator}` is opened with `DU_CASEFILE_ID_CONFLICT` and the column is unchanged. |
| 23.7-T10 | Given a preflight refusal, when 23.1's `submit` is invoked for that document, then it is refused with the preflight code and no `du.submitted` event exists. |
| 23.7-T11 | Given a wage income item whose `EmploymentIncomeIndicator` is true and which has no `CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER` arc, then `DU_PREFLIGHT_EMPLOYER_ARC` naming the income item's label. |
| 23.7-T12 | Given a casefile whose `seller_number` is empty, then `DU_PREFLIGHT_CREDENTIALS` before any other check runs. |

#### Audit and evidence
Per document: the `du_preflight_results` row with every check and its outcome, the event that opened or held the gate, and — on the FAKE — the `xmllint` result; exportable with the 23.1 submission record.

### Open questions / decisions
1. Does a preflight refusal that maps to a borrower ask (missing declaration, missing current residence) go to the rail directly, or through 23.2 as a condition? **Default: directly to 32.x as the card that collects it; 23.2 is for what DU said, and DU has not spoken yet.**
2. The 50-per-container cap and the four-borrower cap are read from the v1.9.3 Cardinality tab; are they DU-enforced rejections or guidance? **Default: treat as rejections until Fannie Mae says otherwise.**

### Sources
- Fannie Mae, DU Specification v1.9.3 — Cardinality, ArcRoles tabs.
- Fannie Mae, DU Specification Test Case Suite, June 2026.
- Fannie Mae Selling Guide B3-2-01, B3-2-10; A2-2-04.
- Homestead-Mortgages `corpus/src/__tests__/schema.test.ts`, `corpus/README.md`, `docs/du-graph.md` ("What schema validation does not buy you").
