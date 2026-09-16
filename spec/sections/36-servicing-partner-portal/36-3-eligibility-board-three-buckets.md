# 36.3 — The eligibility board: three buckets projected from the daily review

| Attribute | Value |
|---|---|
| Section | 36 — The servicing partner portal: partner identity, the tape drop, the eligibility board, the refinance pipeline, home and reports, and the serviced pane contract |
| Automation class | c — a partner user reads; the platform projects 33.2's verdicts into three buckets, masks partner-grade, counts and logs |
| Capacity | Supermortgage as platform operator and, after board, as subservicer. Partner as master servicer / MSR owner / Fannie seller / program lender (pre-refi: GLBA service provider holding a monitored book — the partner is servicer of record of every loan on the board and lender of the refinance program, 20.1 rule 6; post-refi: Fannie subservicer of the new loan, V2 — a boarded loan is never on the board) |
| Trigger & frequency | On every `GET /v1/partner/eligibility` by a partner role (36.1); the board changes only when 33.2's 07:00 ET review writes the day's rows or a tape drop (36.2) changes the holds; nothing runs unprompted |
| Governing source | 33.2 (the state machine's verdict mapping, rule 3's `watch_rate_pct` and `reasons`, rule 7's words for a reason, `ANALYST_NEVER_DECIDES`), 33.1 rule 8 (the hold), 20.1 rules 7–8 (investor blindness; selection inputs limited to the allowlist — no ZIP, name, age, DTI or score), 34.3 rules 3 and 7 (the loans table this projects; nothing computed), 36.1 (the roles, the tenant rule, the partner-grade mask, the log); Reg B §1002.4 and §1002.5(b) (no prohibited-basis input); FCRA §604 (no consumer report to populate the board — the tape's FICO is a file fact, never a filter); GLBA §1016.13 |
| Key deadlines | None of its own; the board is as of the latest 33.2 review (by 07:30 ET each day on 33.2's `SM_PARTNER_BOOK_REVIEW_DAILY`) |
| Timers | none |

### Blueprint row
The partner wants to know, each morning, which of its members a refinance is worth attention for today: eligible now, likely soon, not near. 33.2 already writes that answer as one review row per monitored loan per day — a verdict, the engine's reasons, the engine's facts — and 34.3 shows it to staff as a loans table with a verdict filter. This process is the partner's view of the same rows and nothing more: three buckets that are a pure projection of the stored verdict, a fourth place (Holds, on the Book page) for the loans the latest tape dropped, counts that add up to the book, a row masked partner-grade, and a filter set that narrows the page without ever changing who is on the board. No score, no likelihood, no ranking, no credit pull, no control that writes.

### Verified requirement (as of 2026-09-16)
**The bucket is the verdict, projected (33.2 state machine and rule 3).** `partner_book_reviews.verdict` ∈ {candidate, watching, not_now, excluded} is the engine's answer of the day: `candidate` when the opportunity fired (or an open offer is continued), `watching` when the loan is current and eligible and the numbers are not there today (with `watch_rate_pct`, the current rate minus 25 basis points floored to the 0.125 grid, on the review's `facts`), `not_now` when a suppression stands (cooldown, frequency cap, recapture window, marketing suppression, an implausible or stale value, a hold) and `excluded` when the loan is not in the universe (not current, bankruptcy, foreclosure, loss mitigation, transfer pending). The board maps `candidate` to Eligible now, `watching` to Likely soon and `not_now` ∪ `excluded` to Not near, carries the watch rate and the reason codes across unchanged, and computes nothing: the analyst never decides and neither does the partner (`ANALYST_NEVER_DECIDES`). **[VERIFIED against src/runtime/partner-book-review.ts verdictOf, reviewFactsOf and reasonsInWords, and 33.2-T2 / T3.]**

**Membership cannot be re-selected on the partner's side (20.1 rules 7–8; Reg B §1002.4; 33.2).** The engine's universe row carries only the allowlisted facts and the fair-lending extract of every run stands behind every verdict; a filter that changed who appears on Eligible now would be a second selection, made from fields the engine never reads. This process therefore offers three query keys — `bucket`, `state` (the property state, itself an allowlisted selection input the engine's state rule already applies) and `on_hold` — and drops every other key unread; the counts are always the whole tenant book's, so a narrowed page never presents a narrowed book as the book. **[VERIFIED — 20.1 rule 8's allowlist and prohibited list; the brief's rules 6, 7 and 11.]**

**No consumer report populates the board (FCRA §604(a); 33.2; 20.1).** The tape's FICO is a fact of the partner's file for pricing after the homeowner's own Yes (20.4); the partner row carries no score, no DTI and no investor column at all — not merely no filter on them. **[VERIFIED — 33.1's and 33.2's verified requirements, unchanged.]**

**The partner sees its own book, masked partner-grade (36.1; 16 CFR §314.4(c)(1); GLBA §1016.13).** Every row is `partner_party_id = session.partner_party_id`; another partner's loans are absent from the list and its counts, never present as a refusal; a loan row shows the servicer loan number's last four, the homeowner's first name and last initial and the property state, with no e-mail, phone, SSN, DOB, ZIP or street. **[VERIFIED — the rule text; the mask is 36.1's, stricter than 34.2's staff mask.]**

**Discrepancies vs blueprint**: (1) The brief's mapping lists the hold last; this process tests it first — a held loan's review row of the day reads `not_now` with reason `not_on_latest_tape` (33.1 rule 8, 33.1-T11) and would otherwise land on Not near, and Holds wins. (2) The brief's answer carries four counts; 36.3-T1's arithmetic needs them unfiltered, so counts are the tenant book's on every answer and `loans` is the filtered list. (3) 34.3's loans table offers `verdict` and `ready` filters; here the verdict filter is the bucket and readiness is not a filter (it is a pipeline fact, 36.4). (4) The row's `bucket` field takes the three board values here; the values `in_refinance` and `serviced` the brief lists beside them belong to the pipeline item (36.4) and the loan page (36.5) for rows this board does not list — a member in motion stays on Eligible now with `pipeline_stage` set (open question 2).

### Operational prerequisites
- 36.1: a partner session under any of the three roles (the board is read by all three), the action log, the partner-grade mask.
- 33.1's book and at least one 33.2 review of it (before the first review every monitored loan is Not near with reason `review_pending`); 34.3's `book.loans`, the row this process projects, called with the tenant filter.
- 33.2's copy library for the reason codes in words, as it stands; no copy of this process's own.

### Build spec
#### Inputs and triggers
- `GET /v1/partner/eligibility?bucket=&state=&on_hold=` → `{ as_of_date, counts: { eligible_now, likely_soon, not_near, on_hold }, loans: PartnerLoanRow[] }`. `as_of_date` is the latest review date across the tenant book (null before the first review); `bucket ∈ eligible_now | likely_soon | not_near`; `state` a two-letter property state (upper-cased); `on_hold ∈ true | false`; every other key, and any value outside those sets, is dropped unread.
- The rows: 34.3's `book.loans` with `filter.partner = session.partner_party_id` (never null), then the partner-grade mask (36.1), then the pure projection bucketOf in `src/domain/servicing-partner-portal/buckets.ts` (rule 1) over each row's `on_hold`, `latest_review` and the review's `facts.watch_rate_pct`.
- Events: none of its own; 36.1's `partner_actions` row per request with `partner_portal.viewed`, `view = eligibility` and the applied query keys (no values that name a person).
- Nothing starts here: the board changes when 33.2 writes (`partner_book.review.written`) or 33.1 loads (`partner_book.import.completed`).

#### Data model
New tables: none — the bucket is computed on every read and stored nowhere (no `bucket` column on `loans`, brief §4.6); every row is 33.1's, 33.2's or 34.3's projection of them.
- Baseline tables read: `partner_book_reviews` (the latest row per loan: `verdict`, `reasons`, `as_of_date`, `facts.watch_rate_pct`), `partner_book_facts` (the latest facts through 34.3's row: UPB, note rate, P&I, next due, value and its date), `loans` (`status`, `servicer_loan_number`, `partner_party_id`), `loan_terms`, `properties` (the state), `parties`, `borrowers`, `loan_borrowers`, `partner_book_imports` (the hold, 33.1 rule 8), the `refi_opportunities` entity (`status ∈ offered | engaged` marks a member also on the pipeline, 36.4), `applications` (`prior_loan_id`: an open refinance application on the loan, 33.3), `partner_sessions` and `partner_users` (36.1).
- Baseline tables written: `partner_actions` (36.1; one row per request, `view = eligibility`, the applied keys, no PII). Nothing else.

#### State machine
None — a projection. Per loan the bucket follows the latest 33.2 verdict and the 33.1 hold: `review_pending → eligible_now | likely_soon | not_near` on the first review; `eligible_now ⇄ likely_soon ⇄ not_near` as the mornings' verdicts change (33.2's state machine); any → Holds when a later tape drops the loan and back to its verdict's bucket when the next tape carries it; off the board when `loans.status` leaves `monitored` (`paid_off` by the partner's tape, by `book.resolve` or by 35.10's closeout; `transferred_out`). A member in motion keeps `eligible_now` while its opportunity is `offered` or `engaged` or its application is open, and carries `pipeline_stage` (36.4). No transition is performed here; every one is 33.1's, 33.2's, 33.3's or 35.10's.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|

Jurisdiction overrides: none.

#### Business rules and calculations
1. **The bucket is the verdict.** bucketOf is a pure function of the row (no I/O, no date arithmetic, no figure), in this order of precedence:

| Row | Bucket | Label | On the row |
|---|---|---|---|
| `on_hold` (33.1 rule 8) | none of the three | Holds (Book page, 36.2) | `on_hold = true`, the hold's last as-of date |
| no `partner_book_reviews` row yet | `not_near` | Not near | reason `review_pending` |
| verdict `candidate` | `eligible_now` | Eligible now | `pipeline_stage` when the opportunity is `offered` or `engaged` or an application is open — the member is also on the pipeline (36.4) and stays here |
| verdict `watching` | `likely_soon` | Likely soon | `watch_rate_pct` from the review's `facts` |
| verdict `not_now` or `excluded` | `not_near` | Not near | the engine's `reasons[]` as codes, each with 33.2's words |

   The verdict is the latest review row's by `as_of_date`; the board's `as_of_date` is the latest across the tenant book. Nothing beyond the verdict, the hold and the watch rate enters the mapping; nothing enters it twice.
2. **Nothing beyond verdict and watch rate.** No score, likelihood, priority or ranking is computed or shown; the order within a bucket is 34.3's book order (by servicer loan number), never by a figure, a score or a name. Every figure on a row is a stored fact of the partner's file or the engine's own (34.3 rule 7); a value the platform cannot find is absent, never estimated.
3. **Filters narrow, never re-select.** `bucket` picks one of the three lists; `state` keeps the rows whose property state equals the value (an allowlisted selection input of 20.1 rule 8; the engine's state rule already ran); `on_hold=true` swaps the board for the held loans and `on_hold=false` is the board. Any other key (`fico`, `dti`, `zip`, `name`, `age`, `investor`, `score`, `ready` and every other spelling) is dropped unread, not applied and not an error; the query never widens membership, and the same loan is in the same bucket under every query. ZIP, city, county, street and the homeowner's name are not filters and not columns on the board.
4. **Counts add up.** `counts.eligible_now + counts.likely_soon + counts.not_near` = the tenant's `loans{status=monitored}` not on hold; adding `counts.on_hold` gives every monitored loan of the tenant; the counts are over the whole tenant book on every answer whatever the query, and the filtered `loans` list carries its own length. Loans that are `paid_off`, `transferred_out` or `active` are not counted and not listed — the board is the monitored book; the loan page (36.5) still opens them.
5. **The row is 34.3's, masked partner-grade.** PartnerLoanRow is 34.3's BookLoanRow with `servicer_loan_number` reduced to its last four (the full number only on the detail for `partner_admin` and `partner_ops`, 36.1), `homeowner.legal_name` reduced to first name and last initial, `email_masked` and `phone_masked` dropped, and `bucket`, `watch_rate_pct` (watching only), `pipeline_stage` (when an open opportunity or application exists, 36.4) and `banner` (36.5's three sentences) added. The board's columns: loan last four, masked name, state, UPB (cents, formatted by the page), note rate, next due, value and its as-of date, verdict, watch rate (Likely soon only), last review date. Never on the row: FICO or any score, DTI, ZIP, street, the investor columns (agency, remittance type, investor net rate, servicer-retained rate, MERS id), e-mail, phone, SSN, DOB. Money on the row is decimal-string cents as 34.3 returns it; rates are the tape's percent strings.
6. **Reasons are codes with the copy library's words.** Not near shows the engine's `reasons[]` — 33.2's exclusion and suppression codes and the fire rule's misses by prefix — each rendered through 33.2's words for it (`bankruptcy_active` → "an active bankruptcy"; a `rate_delta_bps … < 25` miss → "the rate reduction is under the program's floor"); never free text, never a figure the analyst did not tokenize, never the analyst's rationale on the board (the loan page renders the rationale's tokens, 36.5). `review_pending` is this board's one reason for a loan with no review row yet, rendered "the first review has not run".
7. **The partner cannot change a verdict.** No control on the board writes anything: no exclude, no bump, no note, no re-run, no "not interested" on the homeowner's behalf; `ANALYST_NEVER_DECIDES` holds for the partner as it holds for the analyst, and a homeowner's own "never" reaches the engine only through 20.1's marketing suppression (33.2).
8. **Tenant.** The row set is `partner_party_id = session.partner_party_id`; another partner's loans are absent from the list and the counts (36.3-T5); a `loan_id` under the detail paths that is not the tenant's is `404 NOT_FOUND` (36.1); a read is never `403`.

**Worked example A (loan 1 of the fixture after the first 33.2 review).** Note rate 7.250%, UPB **$441,366.13**, P&I **$3,069.79**, value **$605,000.00** (Current FMV, 2026-08-31), LTV 0.7295 (441,366.13 ÷ 605,000.00 at 4 dp), verdict `candidate` with a candidate rate of 6.375% and a rate delta of 87.5 basis points (33.2-T2; the engine's figures, never recomputed here) → bucket `eligible_now`; the row reads loan `0001`, `Maria G.`, `AZ`, `upb_cents` `44136613`, `note_rate_pct` `7.250`, `pi_cents` `306979`, next due 2026-10-01, value as of 2026-08-31, last review 2026-09-15 — no FICO (748 stays a fact of 33.1's file), no DTI, no investor column. Loan 9: verdict `watching`, `watch_rate_pct` 5.625 (33.2-T3) → `likely_soon`, the watch rate shown. Loan 11: verdict `excluded`, reason `bankruptcy_active` (33.2-T3) → `not_near`, the reason code shown with 33.2's words ("an active bankruptcy"), no free text. The counts on the 12-loan demo's first review, as 33.2-T1's harness sets them: `eligible_now` 2 (loans 1 and 2), `likely_soon` 7, `not_near` 3 (loans 8, 10 and 11), `on_hold` 0 — 12 in all, every monitored loan in exactly one place. The three dollar figures are 33.2-T2's, copied; each is asserted to the cent by this process's tests.

#### Integrations
- None. No vendor, no adapter; the FAKE rate sheet and the analyst's model are 33.2's and are never called from here.

#### Outputs and artifacts
- Rows: none of its own; `partner_actions` (36.1).
- Events: none of its own.
- No notice, no document, no export of its own (the daily report is 36.5's).
- The Eligibility page: three tabs or three stacked tables — Eligible now, Likely soon, Not near — with the columns of rule 5, the counts of rule 4 as tiles, the Holds count linking to Book > Holds (36.2), each row linking to the loan page (36.5); the `state` filter; no other filter control.

#### AI agent design (AI-first)
`portfolio` agent owns the projection and declares nothing of its own on the bus. End-to-end: on every read the runtime calls 34.3's `book.loans` with the tenant filter, masks each row partner-grade (36.1), applies the pure bucket mapping (rule 1) and the narrowing keys (rule 3), counts the whole tenant book (rule 4) and logs the look (36.1); the verdicts it projects are 33.2's review, written each morning by 33.2's own pass; nothing runs unprompted, nothing is proposed for a human, nothing is written but the log row. Decision record: none of its own — the verdict's decision is 33.2's `review.write`. Guardrails: `READ_ONLY` (34.3), `NO_COMPUTED_FIGURE` (34.3), `ANALYST_NEVER_DECIDES` (33.2 — a partner user cannot change a verdict either), `NO_CREDIT_PULL`, `NO_INVESTOR_FIELDS` and `NO_PROHIBITED_BASIS` (20.1 and 33.2 — inherited by the row: no score, DTI, ZIP, name, age or investor column and no query key on one), `ROLE_MASK` (34.2's principle at 36.1's partner grade), `NO_PII_IN_LOG` (34.1, reused by 36.1). Escalations: none of its own — a day with no review receipt is 33.2's escalation to its compliance sentinel, and the board shows the latest review's date meanwhile.

#### Edge cases and failure modes
- No review yet (the book was loaded after this morning's 07:00 ET pass) → every loan Not near with `review_pending`, `as_of_date` null, the page saying the first review is due by 07:30 ET tomorrow (33.2).
- The review was skipped today (no sheet in force, 33.2) → the latest review stands with its `as_of_date`; the board is as of that date; nothing is estimated.
- A candidate whose offer expired (33.2 rule 6) → the next review reads `not_now` with `cooldown` (or `expired`) → Not near with that code; the pipeline item is terminal `expired` (36.4).
- A held loan whose review row reads `not_now` / `not_on_latest_tape` → Holds, not Not near (rule 1's precedence); back to its verdict's bucket when the next tape carries it.
- A loan the partner's tape marks paid or transferred → `paid_off` / `transferred_out`, off the board and out of the counts; the loan page keeps it (36.5).
- The boarded new loan (`active`, 30.2 / 35.10) → never on the board; the old monitored loan pays off through 35.10 and leaves the board and the counts.
- `?bucket=serviced`, `?bucket=in_refinance` or any value outside the three → the key is dropped as an unknown value is: the whole board answers.
- `?state=ca` → `CA`; `?state=XX` → an empty list with the full counts.
- `?fico=700`, `?dti=40`, `?zip=85013` → dropped unread; the answer is the same as without them (36.3-T4).
- A homeowner with two loans in the book → two rows, each with its own verdict and bucket.
- `partner_auditor` → the same board, the same mask (the last four is already the list mask).
- Partner B's session → partner A's loans absent from the list and the counts, no refusal (36.3-T5).

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 36.3-T1 | Given the demo book after a 33.2 daily run, when eligibility is fetched as the partner, then every monitored loan appears in exactly one of the three buckets or Holds, and the sum of counts equals monitored-not-held + held. |
| 36.3-T2 | Given a loan whose review verdict is `watching` with `watch_rate_pct` set, then the partner row shows bucket `likely_soon` and that watch rate, and does not show investor, DTI, or score fields. |
| 36.3-T3 | Given a loan `excluded` for bankruptcy, then it is `not_near` with the engine reason code, not a free-text diagnosis. |
| 36.3-T4 | Given a query `?bucket=eligible_now&state=CA`, then only `candidate` loans in CA return. Adding `?fico=` or `?dti=` is ignored (unknown query keys dropped, not applied). |
| 36.3-T5 | Given partner A, when they request eligibility, then partner B’s loans are absent (not empty-with-403). |

#### Audit and evidence
What an examiner is shown: for any day, the board as it was — reproducible from the `partner_book_reviews` rows of that `as_of_date` and the holds as of then, because nothing is stored here; the projection's code (pure, unit-tested) and the allowlist of query keys; 36.1's action-log rows for every look with the applied keys and no PII; 20.1's fair-lending extract of the run behind every verdict (33.2) and 33.2's review row with the engine's facts and the analyst's rationale for any loan. Exported through 34.4's evidence pack (staff) and, for the partner, the daily report (36.5).

### Open questions / decisions
1. Should `state` be offered as a filter at all? **Default: yes — it is an allowlisted selection input of 20.1 rule 8 and the engine's state rule already ran; ZIP, city, county and street are not offered.**
2. Where do the row values `in_refinance` and `serviced` apply? **Default: never on this board — the board's `bucket` is one of the three; a member in motion stays on Eligible now with `pipeline_stage` set (36.4's first test); `in_refinance` (an open refinance application on the monitored loan) and `serviced` (the boarded `active` loan) are the pipeline item's and the loan page's values (36.4, 36.5) for rows this board does not list.**
3. Should the counts follow the filter? **Default: no — the counts are the tenant book's on every answer, so the arithmetic of the first test holds under any query; the filtered list carries its own length.**
4. Should the board show a "review pending" state distinct from Not near? **Default: no fourth bucket — `review_pending` is a reason under Not near, so a loan is always in one of three places or Holds.**

### Sources
- spec/sections/33-partner-book/33-2 (the state machine, rules 3, 6 and 7, worked example A, T1–T3), 33-1 (rule 8, T11), 33-3 (the application opened with `prior_loan_id`); spec/sections/34-operator-portal/34-3 (rules 3 and 7), 34-2 (the staff mask this tightens); spec/sections/20-*/20-1 (rules 1, 6, 7 and 8); spec/sections/36-servicing-partner-portal/36-1 (the roles, the tenant rule, the mask, the log).
- src/runtime/partner-book-review.ts (verdictOf, reviewFactsOf, reasonsInWords, the exclusion and not-now reason lists, the hold reason); src/runtime/book-ops/loans.ts (BookLoanRow, bookLoans, the row order); src/domain/partner-book/33-2.spec.test.ts (the figures and counts quoted); src/domain/partner-book/fixtures/partner-book-demo.ts (loans 1, 9 and 11).
- docs/partner-portal/00-CLAUDE-BUILD-INSTRUCTIONS.md §3 rules 6, 7 and 11, §4.4, §4.6, §5.3, §7 (the Eligibility page); docs/partner-portal/BACKEND-DELTAS.md ("Already named", the illegal-deltas list).
- 12 CFR §1002.4, §1002.5(b) (Reg B); 15 U.S.C. §1681b (FCRA permissible purpose); 12 CFR §1016.13 (GLBA service-provider exception); 16 CFR §314.4(c)(1) (access controls).
