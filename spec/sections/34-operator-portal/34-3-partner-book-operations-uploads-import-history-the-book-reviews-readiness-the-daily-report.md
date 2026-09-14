# 34.3 — Partner book operations: uploads, import history, the book, reviews, readiness, the daily report

| Attribute | Value |
|---|---|
| Section | 34 — The operator portal: staff sign-in, the account directory, partner book operations and evidence |
| Automation class | c — a staff member uploads and resolves; the agents of section 33 do the work; the portal shows it |
| Capacity | Platform operator over the partner's book (the partner is servicer of record of every monitored loan; 33.1) |
| Trigger & frequency | On upload (weekly for the first partner); every morning after 33.2's and 33.3's passes; on demand |
| Governing source | 33.1 (the import, the report, regular tapes, `book.resolve`), 33.2 (the review and the examiner's daily report), 33.3 (readiness); GLBA §1016.13 (the partner's data used for the partner's program); 20.1 rule 8 (the fair-lending extract the report links) |
| Key deadlines | The next tape 7 calendar days after the last as-of date (33.1 `SM_PARTNER_BOOK_TAPE_EXPECTED_7`); the review by 07:30 ET and readiness by 07:30 ET each day (33.2, 33.3) |
| Timers | none of its own (33.1's and 33.2's clocks are shown) |

### Blueprint row
The partner's book arrives as a spreadsheet every week and someone has to load it, read what changed, notice what went wrong, see what the agents concluded about each loan and answer the partner's and the examiner's questions. 33.1–33.3 do the work; today the console shows an upload form and a loans table. This process is the whole operational view: the upload with its row report, the history of imports with what each changed, the book with the latest facts, the loans on hold because the latest tape dropped them and their resolution, each morning's review and readiness per loan, offers out and expired, the daily report per partner, and the next tape expected.

### Verified requirement (as of 2026-09-14)
**The rows are section 33's (33.1–33.3).** `partner_book_imports` (with `report`), `partner_book_facts`, `partner_book_invitations`, `partner_book_reviews`, `readiness_checks`, the `refi_opportunities` entities and the timers. This process projects them and dispatches 33.1's `book.import` and `book.resolve` with the staff actor; it computes nothing about a loan.

**The examiner's daily report per partner (33.2 Outputs).** Reviewed, candidates, watching, not now, excluded, offers delivered, expired, analyst turns and skips, the fair-lending extract id — from `partner_book.review.run_completed`, the reviews and 20.1's `refi_trigger_runs`/`fair_lending_extracts` rows of the day; readiness adds checked, ready, not ready by missing item, applications opened, DU runs reached (33.3 Outputs).

**Discrepancies vs blueprint**: (1) The upload is the same `book.import` the API offers; the portal adds no second import path. (2) "What changed" per upload is derived from the facts rows of that import against the previous ones (33.1 rule 2's `change`), not stored again.

### Operational prerequisites
- 34.1 (roles: `ops_analyst` uploads and resolves; `officer` for the campaign approval 33.2 needs once per program; `compliance` for the daily report export).
- The partner's profile and the demo partner as 33.1 registers them.

### Build spec
#### Inputs and triggers
- `POST /ops/api/partner-book/imports` (multipart: partner, as-of date, profile, tape, supplement) → 33.1 `book.import` with `actor = {human, staff_user_id, ops_analyst}`.
- `GET /ops/api/partner-book/partners` (each partner: legal name, loans monitored, last as-of, next expected, clock status), `GET …/imports?partner=` (the history), `GET …/imports/{id}` (the report and the per-row lines), `GET …/loans?partner=&status=&hold=` (the book), `GET …/loans/{id}` (facts history, terms history, invitations, reviews by day, readiness by day, offers), `GET …/reviews?as_of=` and `GET …/readiness?as_of=` (the day across the book), `GET …/daily-report?partner=&as_of=` → `book.daily_report`.
- `POST /ops/api/partner-book/loans/{id}/resolve` `{resolution, reason}` → 33.1 `book.resolve` (ops_analyst).
- Events: `book.viewed{staff_user_id, partner_id, view}` (global; 34.1's log carries the request).

#### Data model
- **`partner_book_daily_reports`** (new; append-only): `id uuid pk`, `partner_party_id`, `as_of_date`, `review jsonb` (reviewed, candidates, watching, not_now, excluded, offers_delivered, expired, analyst_turns, analyst_skipped_by_reason, fair_lending_extract_id, run_id), `readiness jsonb` (checked, ready, not_ready_by_item, applications_opened, du_runs), `book jsonb` (loans monitored, on_hold, paid_off, transferred_out, last_as_of_date, next_expected), `produced_by`, `document_id uuid` (the export when made), `created_at`. One row per partner per day, produced by the sweep after 33.3's pass and on demand.
- Baseline tables read: 33.1–33.3's tables, `refi_opportunities`/`refi_trigger_runs`/`fair_lending_extracts` entities, `timers`, `escalations`, `loans`, `loan_terms`, `parties`, `applications`, `du_casefiles`.

#### State machine
Per daily report: `produced` (append-only, one per partner-day; a re-run the same day appends a newer row). Everything else is section 33's state, shown.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|

Jurisdiction overrides: none.

#### Business rules and calculations
1. **Upload is `book.import`, with a person as actor.** The report page after an upload lists rows loaded, exceptions by code with the row number and the servicer loan number, the gap counts, loans created/updated/unchanged, parties created/linked, invitations sent and held, and the loans now on hold (`not_on_latest_tape`); an `already_loaded` answer links to the earlier import; a `rejected` answer lists the expected headers that were missing.
2. **History shows what changed.** Each import row: as-of date, uploaded by, rows, exceptions, created/updated/unchanged, parties, invitations, on hold; opening it lists the per-loan lines with the change and, for an updated loan, the facts that differed (UPB, rate, P&I, next due, status, value) as before/after.
3. **The book and the hold queue.** The loans table: servicer loan number, homeowner (masked as 34.2), state, UPB, note rate, next due, value and its date, status, account activated?, latest verdict, ready?; filters by partner, status, hold, verdict, ready. The hold queue lists loans absent from the latest tape with the last as-of they appeared on and the resolve control (paid off / transferred out / keep, with a reason) — 33.1 rule 8.
4. **A loan's page.** Facts by as-of date (every mapped column, the raw columns collapsed), terms history, the party and invitations (hashes and dates), reviews by day (verdict, reasons in words, the analyst's rationale and flags, the engine's facts), readiness by day (items with status, source and validity), offers (status, delivered how, expires), and the clocks on the loan.
5. **The day across the book.** Reviews and readiness for an as-of date: counts by verdict and by missing item, the list, and the run receipts (`partner_book.review.run_completed`, `partner_book.readiness.run_completed`) with their timestamps against the 07:30 ET expectations.
6. **The daily report per partner** is produced by the sweep once 33.3's pass has run (and on demand): the counts above, the fair-lending extract id, and the book summary with `last_as_of_date` and `next_expected`; exportable by `compliance` as a document with a hash.
7. **Nothing is computed about a loan here.** Every figure shown is a stored fact, a stored engine figure or a count of rows; a value the portal cannot find is shown as absent, never estimated.

No money figure is computed here.

#### Integrations
- None new. `readXlsx`/CSV through 33.1's import.

#### Outputs and artifacts
- Rows: `partner_book_daily_reports`, `documents` (the report export), `staff_actions`.
- Events: `book.viewed`; 33.1's `partner_book.import.completed`, `partner_book.loan.resolved` (dispatched with the staff actor).
- The portal's partner-book views: partners, upload, imports and reports, the book, the hold queue, a loan, the day, the daily report.

#### AI agent design (AI-first)
`portfolio` agent (tools: `book.history`, `book.loans`, `book.loan`, `book.day`, `book.daily_report`). End-to-end: the five read tools project section 33's rows for the portal (masked as 34.2 masks); `book.daily_report` also produces the per-partner-day row on the sweep. Uploads and resolutions are 33.1's own `book.import` and `book.resolve`, dispatched with the staff actor. Decision record schema (daily report only) `{partner_party_id, as_of_date, counts, fair_lending_extract_id, rule_set_version: partner_book.report.v1, model_version: deterministic, prompt_version: 34.3-v1, confidence: 1}`. Guardrails: `READ_ONLY` (the five tools write only the report row), `NO_COMPUTED_FIGURE`, `ROLE_MASK` (34.2), `NO_DESTINATION` (invitations shown as hashes and dates). Escalations: `ops_analyst` when a day has no review or readiness receipt by 07:45 ET (the clocks' own breaches are 33.2's and 33.3's).

#### Edge cases and failure modes
- An upload with the wrong profile → `rejected` with the missing headers listed; nothing written; the page keeps the files for a second try.
- The same file uploaded twice → `already_loaded` with a link; no second history row.
- A partner with two tapes on one day → two imports, two as-of rows; the later one is the book.
- The review ran but readiness did not (a sweep crash between passes) → the day view shows the missing receipt and the `ops_analyst` escalation; the daily report is produced with readiness marked absent.
- A loan resolved `keep` and still absent seven days later → back on the hold queue.

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 34.3-T1 | Given an `ops_analyst` session, when they upload the fixture tape and supplement, then the import runs with `actor = {human, <staff_user_id>, ops_analyst}` (the import's decision record and `partner_book.import.completed` name them), the report page lists 12 rows loaded, the exceptions and gap counts, and the `staff_actions` row carries the import id; given the same files again, then `already_loaded` linking the first import. |
| 34.3-T2 | Given a second upload with a later as-of date, loan 1's UPB one payment lower and loan 5 absent, then the history lists both imports, the second reads 1 updated / 10 unchanged / 1 on hold, its detail shows loan 1's UPB before and after, and the hold queue lists loan 5 with its last as-of date. |
| 34.3-T3 | Given loan 5 on hold, when the analyst resolves it `paid_off` with a reason, then 33.1's `book.resolve` ran with the staff actor, `loans.status = paid_off`, `partner_book.loan.resolved` is logged, the hold queue is empty and the loan's page shows the resolution. |
| 34.3-T4 | Given the 33.2 and 33.3 passes for a day, when the analyst opens the day view, then reviews count 2 candidates / 6 watching / 0 not now / 3 excluded (the fixture's 12-row tape with loan 5 paid off in T3: 11 monitored loans), readiness counts the candidates checked with not-ready by missing item, both run receipts show with their times, and loan 1's page shows its review (verdict, reasons in words, rationale, engine facts) and readiness (items with status and source). |
| 34.3-T5 | Given the sweep after the readiness pass, then one `partner_book_daily_reports` row exists for the partner and day with the review counts, the fair-lending extract id, the readiness counts, `last_as_of_date` and `next_expected`; given `compliance` exports it, then a hashed document exists and `staff_actions` records the export. |
| 34.3-T6 | Given every partner-book response, then homeowners' contact is masked as 34.2 masks it, invitations show hashes and dates only, and no figure on any page differs from the stored facts, the engine's opportunity row or a row count (contract test over the routes against the fixture). |

#### Audit and evidence
What an examiner is shown: the daily report per partner and day with the extract id; the import history with who uploaded what and each report; the hold queue's resolutions with reasons and actors; a loan's complete history. Exported through the evidence pack (34.4).

### Open questions / decisions
1. Should the portal accept the partner's tape by SFTP or API pull as well as upload? **Default: upload only in this process; an automated pull is a later 33.1 extension that lands in the same `book.import`.**
2. Should the hold queue auto-resolve after N tapes? **Default: never automatically; an operator decides (33.1 rule 8).**

### Sources
- spec/sections/33-partner-book/33-1, 33-2, 33-3; db/migrations/0125; src/runtime/partner-book.ts, partner-book-review.ts, partner-book-readiness.ts; src/console/server.ts (the partner_book view this replaces).
