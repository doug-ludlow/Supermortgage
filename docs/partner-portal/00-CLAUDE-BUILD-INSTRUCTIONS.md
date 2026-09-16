# Claude Code build instructions — Servicing Partner Portal (§36)

Read this file end to end before touching a file. Then follow **Session 0** exactly.

This is not a greenfield product. Supermortgage already originates, services, and daily-reviews a partner book. What is missing is a **tenanted B2B surface** for the servicer partner. You will author spec section 36, project the existing 33/34 engines through a new `/v1/partner/*` API, and ship `apps/partner`. You will not rebuild refinance scoring, tape parsing, invitations, or servicing.

If a name you need is not in these instructions, in `spec/sections/33-partner-book/`, in `spec/sections/34-operator-portal/`, or in the files listed under **Must-read before any code**, stop and write the gap into `docs/partner-portal/BACKEND-DELTAS.md`. Do not invent a table, timer, notice, command, role, verdict, or filter.

---

## 0. Mission

Build the **Servicing Partner Portal**: one tenanted portal whose unit is a **loan row with a state**, not two apps.

```
monitored  →  in_refinance  →  active          (SM subservicing the new loan)
                 ↘ paid_off / transferred_out / on_hold
```

Two modes on the same row:

| Mode | Loan status | Who services | What the partner sees |
|---|---|---|---|
| Pre-refi | `monitored` | Partner’s incumbent subservicer | Tape drop, eligibility buckets, live refinance feed |
| Post-refi | `active` (new loan boarded via 30.2 / 35.10) | Supermortgage | Same row flips banner; serviced pane is a **dark stub in V1** |

V1 shippable experience = recapture command center.

- Partner uploads their existing servicing book.
- Their current subservicer keeps servicing.
- We only receive the updated tape.
- Portal shows which loans are eligible now, likely soon, not near.
- Portal shows a feed of members actively in a refinance.
- After close + board, Super becomes the active subservicer of the **new** loan. Do not build those servicing widgets in V1. Design the banner and the stub so V2 attaches without a rewrite.

---

## 1. What this repo already is

Branch of record: `claude/mortgage-subservicer-builder-y9nr7e`.

Supermortgage is spec-first. `spec/` is the source of truth. A process is not done because you said so. It is done when `npm run audit` reports every unit of that process built, and `docs/audit/COVERAGE.md` shows the row at 100%. `npm test` ratchets `docs/audit/baseline.json` — totals may not fall.

Conventions that are not optional (`docs/ARCHITECTURE.md`, `CLAUDE.md`):

- Money is `bigint` cents. No `number` money. No floating-point rates in persisted rows (store bps / 10k-scale as the existing partner-book code already does).
- Civil dates are `PlainDate`. Calendars are named: `calendar_days`, `business_days_federal`, `business_days_servicer`, `business_days_fannie_et`. Do not mix them.
- Events, ledger sets, decisions, notices are append-only. Corrections are new rows.
- Every state change goes through `Runtime.execute` / the command bus. Humans and agents use the same tools and the same validators.
- Node 22 type-stripping: erasable syntax only. No `enum`, no parameter properties, no namespaces.
- Migrations are append-only. New file under `db/migrations/`. Never edit an applied migration.
- Fair lending and FCRA by construction. Refinance selection is investor-blind. No consumer report is pulled to decide who appears on the eligibility board.
- People only where the law puts them. Partner users cannot waive money fields, approve campaigns, or resolve holds in V1.

Surfaces that already exist — do not put partner users on them:

| Surface | Path | Who | Code |
|---|---|---|---|
| Borrower app | `/app` | Homeowner | `apps/borrower` |
| Video door | `/video` | Homeowner | borrower video routes |
| Operator portal | `/ops` | Super staff only | `src/console`, `src/runtime/portal`, `src/runtime/staff`, `src/domain/operator-portal` |
| Machine API | `/v1/*` | Bearer `API_TOKEN` / `api_principals` | `src/runtime/server.ts` |

§34 README is explicit: the operator portal is **internal only — no partner users, no tenancy**.

§35 is taken (`spec/sections/35-operations-runtime/`, processes 35.1–35.12). The partner portal is **section 36**.

---

## 2. Must-read before any code

Read these in this order. Do not skim.

### Product and law of the land

1. `CLAUDE.md`
2. `docs/ARCHITECTURE.md`
3. `README.md` — partner-book paragraph and Surfaces table
4. `spec/TEMPLATE-process.md` — headings are verbatim and counted
5. `spec/TEMPLATE-section-README.md`

### The engines you will project

6. `spec/sections/33-partner-book/README.md`
7. `spec/sections/33-partner-book/33-1-the-partner-book-import-monitored-loans-and-real-accounts.md`
8. `spec/sections/33-partner-book/33-2-the-daily-refinance-review-of-the-partner-book.md`
9. `spec/sections/33-partner-book/33-3-refinance-readiness-what-is-on-file-and-what-is-asked-for.md`
10. `spec/sections/34-operator-portal/README.md`
11. `spec/sections/34-operator-portal/34-1-staff-sign-in-and-roles-accounts-the-doors-the-action-log-the-access-review.md`
12. `spec/sections/34-operator-portal/34-3-partner-book-operations-uploads-import-history-the-book-reviews-readiness-the-daily-report.md`
13. `spec/sections/20-refinance-triggers-solicitation-lead-intake-and-pricing/20-1-portfolio-rate-monitoring-and-refinance-opportunity-detectio.md` — fire rule, investor-blind, `ANALYST_NEVER_DECIDES`
14. `spec/sections/30-post-purchase-servicing-setup-and-boarding-to-the-subservice/` — boarding that flips a loan to `active`
15. `spec/sections/35-operations-runtime/` process 35.10 — refinance closeout: `monitored_partner` mode, event `partner_book.loan.paid_off`, timer `SM_REFI_PARTNER_CONFIRM_21` (already owned by 35; do not re-trigger with a new event)

### Code you will call, not rewrite

16. `src/domain/partner-book/import.ts` — `parseBook`, `profileById`, `m3-v1`
17. `src/domain/partner-book/fixtures/partner-book-demo.ts` — 12-loan Northlight fixture
18. `src/domain/partner-book/33-1.spec.test.ts`, `33-2.spec.test.ts`, `33-3.spec.test.ts`
19. `src/runtime/partner-book.ts` — `importPartnerBook`, `partnerBookReport`, `listPartnerBookImports`, `seedPartnerBookDemo`, `holdsOf`, `isOnHold`, `resolvePartnerBookLoan`, `partnerBookStatus`
20. `src/runtime/partner-book-review.ts` — verdicts `candidate | watching | not_now | excluded`, `reviewsOfDay`
21. `src/runtime/partner-book-readiness.ts`
22. `src/runtime/partner-book-offers.ts` — `openOffersOf`, states `offer_ready | offered | engaged | expired`
23. `src/runtime/partner-book-analyst.ts` — explains; never decides
24. `src/runtime/book-ops/` — `bookLoans`, `bookLoan`, `bookHistory`, `bookDay`, `bookDailyReport`, `partnersOf`, `maskEmail`, `maskPhone`, `routes.ts`
25. `src/runtime/server.ts` — existing `/v1/partner-book/*` machine API
26. `src/runtime/staff/auth.ts` and `src/runtime/staff/roles.ts` — door mechanics to copy the *pattern* of, not the tables of
27. `apps/borrower/app/api/[...path]/route.ts` — cookie proxy pattern to copy
28. `Dockerfile.borrower` and `.github/workflows/deploy.yml` — deploy pattern to copy later, not in Session 0

If any of those files have moved, search the tree. Do not invent replacements.

---

## 3. Hard rules

Copy these into every session prompt.

1. **Markdown-first.** Author `spec/sections/36-servicing-partner-portal/` from the templates. Keep every template heading. Then `npm run spec:register && npm run spec:manifest && npm run spec:scaffold`. Scaffold writes `todo: true` tests. A T-id counts only when the `node:test` title is exactly `<pid>-T<n>: <spec text>` and `todo` is gone.
2. **Project, do not fork.** Tape parse = `import.ts`. Persist = `importPartnerBook`. Verdicts = 33.2 / `partner-book-review.ts`. Offers = `partner-book-offers.ts`. Readiness = `partner-book-readiness.ts`. List/detail/report shapes start from `src/runtime/book-ops/*`. Wrap those functions with a tenant filter. Do not copy their SQL into a new file and “clean it up.”
3. **One write in V1 for the partner: `book.import`.** Session partner identity is the partner. The request body must not choose a `partner_party_id`. `book.resolve` stays `ops_analyst` on `/ops`. Campaign approval stays `officer`. Invitations stay 33.1 system/portfolio agent.
4. **New roles, new tables, new actor.** Partner actor is `{ kind: "human", id: partner_user_id, role: "partner_admin" | "partner_ops" | "partner_auditor" }`. Register the roles where `spec_lint_names.py` and `tools/extract_agents.py` will see them (36.1 owns them). Do not reuse `ops_analyst`, `officer`, `compliance`, `admin`. Do not write to `staff_users` / `staff_sessions` / `staff_actions`.
5. **Tenant or 404.** Every query is `partner_party_id = session.partner_party_id`. A loan, import, or report that is not theirs is `404 NOT_FOUND`, never `403`. Existence is not a signal.
6. **Mask tighter than staff.** Partner list rows: servicer loan last-four, first name + last initial, state, no raw email, no raw phone, no SSN/TIN/DOB, no investor columns, no DTI, no FICO used as a filter. Staff `/ops` already masks; partner masking is stricter. Action-log payloads contain no PII.
7. **Do not change who is eligible.** No UI filter on ZIP, name, age, DTI, score, race, or investor. The three buckets are a **projection** of 33.2 `verdict`. Adding a filter that changes membership is a fair-lending defect.
8. **Monitored loans refuse servicing commands.** `LOAN_MONITORED` already exists. Do not arm sections 2–19 timers, ledgers, statements, or ACH on a monitored loan. The partner portal must not expose Pay / Escrow / Draft buttons on a monitored row.
9. **Pre-refi is not a Fannie transfer.** No Form 629, no Form 101, no RESPA goodbye/hello, no SM custodial accounts for monitored loans. Do not add those screens. Post-refi Fannie subservicing (A2-1-07, Forms 101/1013/1014) is V2.
10. **GLBA service provider.** Super may not market Super’s own products from the partner’s servicing data. The portal is the partner’s book, branded with the partner’s legal name and NMLSR, not a Super acquisition funnel.
11. **FCRA.** No credit pull to populate Eligible / Soon / Not near. Partner FICO on the tape is a file fact for pricing after Yes (20.4), not a selection input.
12. **No `/ops` clone.** Do not copy `src/console/ui/index.html`. Do not mount partner routes under `/ops`. Do not accept `x-staff-role`. New app `apps/partner`. New API prefix `/v1/partner/`.
13. **Audit ratchet.** Never lower `docs/audit/baseline.json`. Move it up with `npm run audit:baseline` in the same commit that earned the units. If the SessionStart hook says FAILED, fix that before anything else.
14. **INTEGRATIONS=fake** in every build stage. No live vendors.

---

## 4. Existing contracts you will reuse

### 4.1 Commands and tools (already on the bus)

From 33.1 / 34.3. Call these. Do not rename them.

| Tool | Process | Who may call it in V1 |
|---|---|---|
| `book.import` | 33.1 | today: staff via `/v1/partner-book/imports` and `/ops`. **New:** `partner_admin` via `/v1/partner/book/imports` with partner taken from session |
| `account.provision` | 33.1 | system, inside `importPartnerBook` |
| `account.invite` | 33.1 | system, inside `importPartnerBook` |
| `book.resolve` | 33.1 | `ops_analyst` only. Partner can **see** holds, cannot resolve |
| `book.report` | 33.1 | read of an import report |
| `book.history` | 34.3 | tenant-scoped read |
| `book.loans` | 34.3 | tenant-scoped read |
| `book.loan` | 34.3 | tenant-scoped read |
| `book.day` | 34.3 | tenant-scoped read |
| `book.daily_report` | 34.3 | tenant-scoped read; partner_auditor + partner_admin may export **their** report |

### 4.2 Tables you read (do not recreate)

`partner_book_imports`, `partner_book_facts`, `partner_book_reviews`, `readiness_checks`, `partner_book_invitations`, `partner_book_daily_reports`, `loans` (`status` ∈ `monitored | paid_off | transferred_out | active`), `loan_terms` (`source=partner_tape` while monitored), `refi_opportunities`, `applications` (`prior_loan_id` when a Yes opened a refi), `parties` (`party_type=servicer` is the partner), `properties`, `borrowers`, `loan_borrowers`, `timers` (`SM_PARTNER_BOOK_TAPE_EXPECTED_7`, `SM_PARTNER_BOOK_INVITATION_REMINDER_14`, `SM_PARTNER_BOOK_REVIEW_DAILY`, `SM_REFI_OPPORTUNITY_EXPIRY_30`, `SM_REFI_OFFER_SLA_2BD`).

### 4.3 Tables 36.1 may create (only these)

Append-only migration. Names must appear in the 36.1 Data model heading exactly.

- `partner_users` — `id`, `partner_party_id`, `email` (normalized), `name`, `roles` (`text[]` ⊆ `{partner_admin, partner_ops, partner_auditor}`), `status` (`invited | active | disabled`), `created_at`, `disabled_at`
- `partner_credentials` — password hash / passkey handles for a `partner_user_id`. Same shape as staff credentials if one exists; do not share the staff table.
- `partner_sessions` — `id`, `partner_user_id`, `partner_party_id`, `role` (the acting role), `created_at`, `last_seen_at`, `expires_at`, `revoked_at`
- `partner_actions` — append-only action log. `id`, `at`, `partner_user_id`, `partner_party_id`, `role`, `action` (view or command name), `subject_kind`, `subject_id`, `result` (`ok | refused`), `refusal_code`. Retention 5 years. **No PII columns. No raw email/phone/name of homeowners.**

Reuse `auth_challenges` with a new `subject_kind = 'partner'` if that column already discriminates staff vs borrower. If it does not, extend it in a new migration. Do not invent a third OTP table.

### 4.4 Verdicts and buckets (do not invent a score)

33.2 already writes one `partner_book_reviews` row per monitored loan per day.

| Partner label | Stored `verdict` | Also include |
|---|---|---|
| Eligible now | `candidate` ∩ opportunity status ∈ {`offer_ready`, `offered`} (a `candidate` with no open opportunity still sits here — the offer may not have been delivered yet) | also appears on the pipeline once `offered` or later |
| Likely soon | `watching` | show `watch_rate_pct` from the review `facts` |
| Not near | `not_now` ∪ `excluded` | show engine `reasons[]` from the copy library, never raw figures the analyst did not tokenize |

Worked figures — copy 33.2-T2, do not recompute:

- Loan 1: note **7.250%**, UPB **$441,366.13**, P&I **$3,069.79**, value **$605,000.00**, LTV **0.7295**, candidate **6.375%**, delta **87.5 bps** → Eligible now.
- Loan 9: `watching` at `watch_rate_pct` **5.625** → Likely soon.
- Loan 11: `excluded` `bankruptcy_active` → Not near.

If the fixture numbers in `33-2.spec.test.ts` differ from this paragraph, the test file wins. Quote the test file.

The live refinance feed is **not** a fourth static bucket. It is a pipeline over members who left the static board and entered motion.

### 4.5 Pipeline stages (project existing rows)

| Stage shown to partner | Source of truth |
|---|---|
| `offered` | `refi_opportunities.status = offered` |
| `engaged` | `refi_opportunities.status = engaged` (homeowner Yes) |
| `readiness` | 33.3 checklist not ready, application open |
| `du` | application has a DU run (section 23) |
| `disclosures` | LE/CD in flight (21 / 25) |
| `closing` | CTC / eClose / fund (25 / 26) |
| `boarded` | 30.2 / 35.10 emitted boarded; new loan `status=active` |
| terminal: `expired` | `refi_opportunities.status = expired` or `SM_REFI_OPPORTUNITY_EXPIRY_30` |
| terminal: `declined` / `withdrawn` | application terminal states that already exist — use those names, do not invent |

If a stage has no row yet, omit the member from the feed. Do not fake a stage.

### 4.6 Loan list projection (start from `BookLoanRow`)

`src/runtime/book-ops/loans.ts` already returns:

```
loan_id, servicer_loan_number, partner_party_id, partner_legal_name,
status, state, city,
homeowner { party_id, legal_name, email_masked, phone_masked },
facts_as_of, upb_cents, note_rate_pct, pi_cents, ti_cents,
next_due_date, last_payment_date,
value { value_cents, as_of },
servicing_status, account_activated, activated_at,
latest_review { as_of_date, verdict, reasons },
latest_readiness { as_of_date, ready, missing },
on_hold, hold
```

Partner projection (`PartnerLoanRow`) is that object with:

- `servicer_loan_number` → last four only on list views; full number on detail for `partner_admin` / `partner_ops`
- `homeowner.legal_name` → first + last initial
- drop `email_masked` / `phone_masked` from list views (detail may show masked, never raw)
- add `bucket`: `eligible_now | likely_soon | not_near | in_refinance | serviced`
- add `watch_rate_pct` when verdict is `watching`
- add `pipeline_stage` when an open opportunity or open application exists
- add `banner`: `Monitored — {partner_legal_name} remains servicer` | `In refinance — origination in progress` | `Active — Supermortgage subservicing`

`bucket` is computed. It is not stored. Do not add a `bucket` column to `loans`.

### 4.7 Machine API that already exists (staff/token, keep it)

In `src/runtime/server.ts`:

- `POST /v1/partner-book/imports` → `importPartnerBook` (actor from `x-actor-id` / `x-actor-role`, default `ops_analyst`)
- `GET /v1/partner-book/imports`
- `GET /v1/partner-book/imports/:id`
- `GET /v1/partner-book/holds`
- `POST /v1/partner-book/loans/:id/resolve`
- `POST /v1/partner-book/seed-demo` (non-prod)

Leave these. They are the operator/machine path. Partner users never hit them.

Staff UI path, leave it:

- `GET /ops/api/partner-book/{partners,imports,imports/:id,loans,loans/:id,reviews,readiness,daily-report}`
- `POST /ops/api/partner-book/loans/:id/resolve` (`ops_analyst`)
- `POST /ops/api/partner-book/daily-report/export` (`compliance`)

### 4.8 Fixture

`src/domain/partner-book/fixtures/partner-book-demo.ts` + `seedPartnerBookDemo`.

- Partner legal name in the fixture (Northlight in current code — if the fixture name differs, use whatever the file says; do not rename the partner).
- 12 monitored loans.
- Worked tape numbers already asserted in 33.1-T2 (example: rate 7.250% → 72500 bps-scale, P&I $3,069.79 → 306979 cents). Reuse those figures in 36.x worked examples. Do not invent new money.

---

## 5. Section 36 — what you will author

Create:

```
spec/sections/36-servicing-partner-portal/README.md
spec/sections/36-servicing-partner-portal/36-1-partner-identity-doors-roles-action-log-tenant-scope.md
spec/sections/36-servicing-partner-portal/36-2-partner-tape-drop-on-book-import.md
spec/sections/36-servicing-partner-portal/36-3-eligibility-board-three-buckets.md
spec/sections/36-servicing-partner-portal/36-4-refinance-pipeline-feed.md
spec/sections/36-servicing-partner-portal/36-5-partner-home-reports-two-mode-loan-page.md
spec/sections/36-servicing-partner-portal/36-6-post-refinance-serviced-pane-contract.md
```

Copy headings from `spec/TEMPLATE-process.md` verbatim. Automation class `c` (human-in-the-loop surface over existing engines) unless the template’s own language for “projection / portal” is already used in 34.x — match 34.x.

Capacity: **Supermortgage as platform operator and, after board, as subservicer. Partner as master servicer / MSR owner / Fannie seller / program lender.** Pre-refi capacity is GLBA service provider holding a monitored book. Post-refi capacity is Fannie subservicer of the new loan (V2).

### 5.1 Process 36.1 — Partner identity, doors, roles, action log, tenant scope

**Does:** partner users exist, sign in, act under a role, every look and act is logged, every query is tenant-scoped.

**Does not:** import a tape, score a loan, talk to a homeowner.

Doors — copy the *mechanics* of 34.1 / 32.2 / 32.14:

- Email code (6-digit, one open challenge per address, expiry, lockout after 5 failures / 15 minutes).
- Password (≥12, breached-list check). Password alone does not open a session.
- Passkey as possession factor. Same WebAuthn verifier the borrower/staff doors use.
- Session = password + recent possession. 30 minutes idle, 12 hours absolute. Revoke on sign-out, disable, role change.
- Do not invent OIDC in V1.

Roles:

| Role | Reads | Acts |
|---|---|---|
| `partner_admin` | everything in the tenant | `book.import`; invite/disable partner users; export daily report |
| `partner_ops` | book, eligibility, pipeline, loan page, home | none in V1 |
| `partner_auditor` | reports, eligibility, pipeline (no upload, no admin) | export daily report |

`chooseRole` pattern from `src/runtime/staff/roles.ts` may be copied into `src/runtime/partner-portal/roles.ts` with the three partner roles only. Reads fall back to the least-privileged accepted held role. Acts refuse if the acting role is not accepted (`403 ROLE_REQUIRED` with `act_as` offer).

First partner_admin: seeded against the demo partner in non-prod; in prod, provisioned by Super staff via a 36.1 command `partner.user.invite` that only `ops_analyst` / `admin` may call. That staff command is in-scope for 36.1 because otherwise no partner can sign in. It is not a partner-facing write.

Required T-ids (write these sentences into the spec Test cases heading; they must be reproducible verbatim):

- `36.1-T1` Given a seeded partner_admin bound to the demo partner, when they request an email code and verify it plus password, then a `partner_sessions` row exists with that `partner_party_id` and role `partner_admin`, and no `staff_sessions` row is written.
- `36.1-T2` Given a partner_ops session, when they `POST /v1/partner/book/imports`, then the command is refused `403 ROLE_REQUIRED`.
- `36.1-T3` Given partner A’s session, when they `GET /v1/partner/book/loans/:id` for a loan whose `partner_party_id` is partner B, then the response is `404 NOT_FOUND` and a `partner_actions` row is written with `result=refused` and no homeowner PII.
- `36.1-T4` Given a partner_admin, when they invite a partner_ops user, then that user can sign in and cannot upload.
- `36.1-T5` Given a disabled partner_user, when they present a valid code and password, then sign-in is refused and the session is not created.
- `36.1-T6` Given any successful partner GET, when the action log is read, then `partner_actions` contains `partner_portal.viewed` with `view`, `partner_user_id`, `partner_party_id`, and no email/phone/name of a homeowner.
- `36.1-T7` Given a staff session cookie, when it is sent to `/v1/partner/*` or `/partners`, then the request is unauthenticated (no staff fallback).
- `36.1-T8` Given a partner session, when it is sent to `/ops` or `/ops/api/*`, then the request is unauthenticated (no partner fallback).

Timers: none new. Reuse staff-style session expiry in application code the same way 34.1 does; do not register a new timer code unless 34.1 itself uses one for session expiry (it does not — idle/absolute are session columns).

Notices: `NTC_SM_PARTNER_USER_INVITE` (email to the new partner user). First process that names it owns it. Copy is: partner legal name, sign-in URL, no loan figures.

### 5.2 Process 36.2 — Partner tape drop on `book.import`

**Does:** `partner_admin` uploads tape + optional supplement. Runtime calls `importPartnerBook` with `partner` taken from the session, `profile: "m3-v1"` (or the partner’s registered profile — do not let the client pick an arbitrary profile in V1), `as_of_date` from the form.

**Does not:** reimplement `parseBook`. Does not let the client set `partner_party_id`. Does not resolve holds. Does not send a custom invitation.

Wire:

```
POST /v1/partner/book/imports
  multipart: tape (.xlsx|.csv), supplement? (.xlsx|.csv), as_of_date (YYYY-MM-DD)
  actor = session partner_admin
  → importPartnerBook({ partner: sessionPartner, as_of_date, profile: "m3-v1", tape, supplement })
  → same idempotency as 33.1 (file hashes → already_loaded)
```

Return the same report shape `partnerBookReport` already returns: rows loaded, exceptions, created/updated/unchanged, parties created/linked, invitations sent/held, loans now on hold.

`GET /v1/partner/book/imports` and `GET /v1/partner/book/imports/:id` wrap `listPartnerBookImports` / `partnerBookReport` filtered by session partner.

`GET /v1/partner/book/status` wraps `partnerBookStatus` (last as-of, next expected = as-of + 7 calendar days via existing `SM_PARTNER_BOOK_TAPE_EXPECTED_7`, hold count, late flag).

`GET /v1/partner/book/holds` wraps `holdsOf` for the session partner. No POST resolve.

Required T-ids:

- `36.2-T1` Given the demo fixture tape + supplement and a partner_admin session for that partner, when they POST the files, then `importPartnerBook` writes the same 12 `monitored` loans 33.1-T1 already asserts, and the actor on `book.import` is the partner_user, not `ops_analyst`.
- `36.2-T2` Given the same files posted a second time, then the response is `already_loaded` and no new `partner_book_facts` rows are written.
- `36.2-T3` Given a later `as_of_date` tape that drops one loan, then that loan is `not_on_latest_tape` / on hold, it is absent from the next 33.2 review, and the partner GET holds lists it. `POST .../resolve` as the partner is `403`.
- `36.2-T4` Given a partner_admin for partner A, when the multipart names partner B in a field, then that field is ignored and the import attaches to partner A.
- `36.2-T5` Given a header that does not match `m3-v1`, then no rows are written and the partner sees the same header-refusal 33.1 already emits.

Worked example: 36.2 owns no new money. Assert “12 monitored loans, 0 servicing clocks armed.” Dollar figures stay in 33.1 / 33.2.

### 5.3 Process 36.3 — Eligibility board

**Does:** project latest `partner_book_reviews.verdict` into three buckets. Read-only.

```
GET /v1/partner/eligibility
  query: bucket?=eligible_now|likely_soon|not_near
         state?=
         on_hold?=true|false
  → { as_of_date, counts: { eligible_now, likely_soon, not_near, on_hold }, loans: PartnerLoanRow[] }
```

Mapping function (pure, in `src/domain/servicing-partner-portal/buckets.ts`):

```
function bucketOf(row):
  if row has open opportunity in {offered, engaged} or open application → still listed
      on Eligible now if verdict is candidate, AND also appears on the pipeline (36.4)
  if verdict == "candidate" → eligible_now
  if verdict == "watching" → likely_soon
  if verdict == "not_now" or "excluded" → not_near
  if no review yet → not_near with reason "review_pending"
  if on_hold → not shown in the three buckets; shown on Book > Holds
```

Required T-ids:

- `36.3-T1` Given the demo book after a 33.2 daily run, when eligibility is fetched as the partner, then every monitored loan appears in exactly one of the three buckets or Holds, and the sum of counts equals monitored-not-held + held.
- `36.3-T2` Given a loan whose review verdict is `watching` with `watch_rate_pct` set, then the partner row shows bucket `likely_soon` and that watch rate, and does not show investor, DTI, or score fields.
- `36.3-T3` Given a loan `excluded` for bankruptcy, then it is `not_near` with the engine reason code, not a free-text diagnosis.
- `36.3-T4` Given a query `?bucket=eligible_now&state=CA`, then only `candidate` loans in CA return. Adding `?fico=` or `?dti=` is ignored (unknown query keys dropped, not applied).
- `36.3-T5` Given partner A, when they request eligibility, then partner B’s loans are absent (not empty-with-403).

### 5.4 Process 36.4 — Refinance pipeline feed

**Does:** the activity feed the user asked for — “which of their MSR portfolio members is actively going through a refinance.”

```
GET /v1/partner/pipeline
  → { items: PipelineItem[] }  // newest event first
GET /v1/partner/pipeline/:loan_id
  → { loan: PartnerLoanRow, stages: PipelineStage[], current: stage }
```

`PipelineItem`: `loan_id`, loan last-four, masked homeowner, `stage`, `entered_at`, `days_in_stage`, `opportunity_id?`, `application_id?`.

Stage transitions are events that already exist (`offer.deliver`, `offer.expire`, application received, DU run, disclosures issued, funded, boarded). Project them. Do not emit new origination events from 36.4.

Required T-ids:

- `36.4-T1` Given a monitored loan with `refi_opportunities.status=offered`, then it appears on the pipeline as `offered` and also remains on Eligible now.
- `36.4-T2` Given that homeowner’s Yes (`engaged`) and a 33.3 readiness row with missing items, then the pipeline stage is `readiness` and `missing` is the 33.3 item list.
- `36.4-T3` Given offer expiry via `expireOffers`, then the item’s current stage is `expired` and a subsequent 33.2 run is free to write `not_now` with cooldown.
- `36.4-T4` Given a boarded new loan linked from the old monitored loan (35.10 / `prior_loan_id`), then the pipeline item is `boarded`, the old loan banner is paid off / refinanced, and the new loan banner is `Active — Supermortgage subservicing`.
- `36.4-T5` Partner B cannot see partner A’s pipeline items (404 / absent).

### 5.5 Process 36.5 — Home, reports, two-mode loan page

**Does:** the IA landings.

```
GET /v1/partner/home
  → {
      partner: { legal_name, nmlsr_id },
      book: { loans_monitored, on_hold, last_as_of, next_tape_due, late },
      eligibility: { eligible_now, likely_soon, not_near },
      pipeline: { in_flight, boarded_mtd },
      latest_report_id
    }

GET /v1/partner/reports/daily?as_of=
  → bookDailyReport for session partner (34.3 shape)

GET /v1/partner/loans/:id
  → PartnerLoanDetail {
      banner, bucket, pipeline_stage,
      loan: PartnerLoanRow,
      facts_history: [{ as_of_date, change }],   // not raw PII facts
      reviews: [{ as_of_date, verdict, reasons, watch_rate_pct, analyst_rationale_tokens }],
      readiness: { ready, missing, items[] },
      offers: [{ status, delivered_at, expires_at }],
      serviced: null | { available: false, code: "SERVICED_PANE_NOT_BUILT" } | V2 pane
    }
```

Analyst rationale is already provenance-guarded (tokens only). Show the rendered rationale the way `/ops` does. Do not let the model write a new one from the partner portal.

Required T-ids:

- `36.5-T1` Home counts equal 36.3 counts + 36.4 in-flight for the same `as_of`.
- `36.5-T2` Daily report for the partner matches 34.3 `bookDailyReport` for that `partner_party_id` (same ids, same counts). No other partner’s report is listed.
- `36.5-T3` Loan page for a monitored loan shows banner `Monitored — {partner} remains servicer`, no Pay control, and `serviced.available === false`.
- `36.5-T4` Loan page for a boarded refinance shows banner `Active — Supermortgage subservicing` and `serviced.code === "SERVICED_PANE_NOT_BUILT"` in V1.
- `36.5-T5` A `partner_auditor` can GET home, eligibility, pipeline, reports, and loan pages, and cannot POST imports.

### 5.6 Process 36.6 — Post-refi serviced pane contract (dark)

**Does:** lock the V2 contract so the team does not invent a second product later.

**Does not:** render payments, escrow, insurance, LAR, or delinquency widgets.

State the modules and the sections they will read when V2 is built:

| Module | Reads (do not write) | Guide / spec |
|---|---|---|
| Payment history / next due | §2 cashiering ledger | Part C |
| Escrow | §3 | Part B-1 |
| Insurance / flood / LP | §9, §10 | Part B-2, B-3, B-6 |
| Delinquency / early intervention | §11 | D2-2 |
| Loss mit | §12 | D2-3 |
| Investor remittance / LAR | §5 | C-3, C-4 |
| Custodial P&I and T&I | §6 | A4-1-02, Forms 1013/1014 |
| Notices | §7 / notice registry | |
| QC exceptions | §18 | A1-1-03 STAR categories |
| Payoff | §16 | |

V1 acceptance: every module endpoint returns `409 SERVICED_PANE_NOT_BUILT` (or `404` if you prefer a single code — pick one, use it everywhere, document it in 36.6). Partner UI shows a single disabled “Serviced” tab with that copy. No empty charts.

Required T-ids:

- `36.6-T1` Given a monitored loan, `GET /v1/partner/loans/:id/serviced` is `409 SERVICED_PANE_NOT_BUILT`.
- `36.6-T2` Given an `active` boarded loan for this partner, the same endpoint is still `409 SERVICED_PANE_NOT_BUILT` in V1, and the loan page banner is already `Active`.
- `36.6-T3` 36.6 introduces **no** new money field, timer, or notice.

36.6 is a contract process. Keep its unit count small. Do not pretend servicing is built.

---

## 6. Code layout you will create

```
spec/sections/36-servicing-partner-portal/     # markdown first
src/domain/servicing-partner-portal/
  36-1.spec.test.ts … 36-6.spec.test.ts       # scaffolded, then implemented
  buckets.ts                                  # pure projection
  pipeline.ts                                 # pure projection
  mask.ts                                     # partner-grade mask
  evaluators-36-1.ts …
  timers-36-*.ts                              # only if 36.x actually adds a timer (prefer none)
src/app/tools/section36-1.ts … section36-6.ts
src/app/tools/index.ts                        # add to ALL_TOOLS
src/runtime/partner-portal/
  auth.ts                                     # doors, sessions; pattern from staff/auth.ts
  roles.ts                                    # three roles only
  scope.ts                                    # tenant filter → 404
  routes.ts                                   # /v1/partner/*
  home.ts
  eligibility.ts
  pipeline.ts
  book.ts                                     # wraps importPartnerBook + book-ops
src/runtime/server.ts                         # mount /v1/partner/* AFTER auth that resolves partner session
apps/partner/                                 # Next.js, parallel to apps/borrower
  app/api/[...path]/route.ts                  # HttpOnly cookie sm_partner_session, Path=/partners
  app/partners/sign-in/page.tsx
  app/partners/page.tsx                       # Home
  app/partners/book/page.tsx
  app/partners/eligibility/page.tsx
  app/partners/pipeline/page.tsx
  app/partners/loans/[id]/page.tsx
  app/partners/reports/page.tsx
  app/partners/admin/page.tsx
docs/partner-portal/
  00-CLAUDE-BUILD-INSTRUCTIONS.md             # this file
  BACKEND-DELTAS.md                           # empty except accepted gaps
db/migrations/0xxx_36_partner_portal.sql      # partner_users, credentials, sessions, actions only
```

Do not put partner UI in `src/console/ui`. Do not put partner tests under `src/domain/operator-portal/`.

Mount order in `src/runtime/server.ts`:

1. Existing `/v1/partner-book/*` (machine/staff token) unchanged.
2. New `/v1/partner/*` that **rejects** the staff header actor and requires a `partner_sessions` bearer.
3. Existing `/ops/api/*` unchanged.

Cookie proxy (`apps/partner/app/api/[...path]/route.ts`):

- Cookie name `sm_partner_session`
- `Path=/partners`
- `HttpOnly`, `Secure` in prod, `SameSite=Lax`
- Forward only to `/v1/partner/*` on the API origin
- Never forward to `/v1/partner-book/*`, `/ops`, or `/v1/borrower/*`

---

## 7. App IA (V1 screens)

Desktop-first. Partner users are ops people at a servicer. Visual language: **console density** (tables, tiles, chips, banners), not borrower cards, not Michelle, not the conversation thread. Do not copy `src/console/ui/index.html`. Do not start a design system rewrite.

Nav, fixed order:

1. Home
2. Book
3. Eligibility
4. Pipeline
5. Reports
6. Admin (`partner_admin` only)

Loan page is reachable from Eligibility, Pipeline, Book, and Home counts. It is not a top-nav item.

Each page:

- **Sign-in** — email code + password. Partner legal name on the door (from a public config or the invite). No loan list before auth.
- **Home** — last tape as-of, next tape due, late badge, three bucket counts, in-flight count, link to latest daily report.
- **Book** — upload dropzone (admin), last import report, history table, holds table (read-only). Copy: “Uploading refreshes monitored facts. It does not transfer servicing.”
- **Eligibility** — three tabs or three stacked tables: Eligible now / Likely soon / Not near. Columns: loan last-four, masked name, state, UPB (cents formatted), rate, next due, value as-of, verdict, watch rate (soon only), last review date.
- **Pipeline** — table newest first: loan last-four, masked name, stage, days in stage. Click through to loan page.
- **Loan page** — banner (the three sentences in 4.6), facts-as-of, review history, readiness missing items, offers. Serviced tab visible, disabled, copy from 36.6.
- **Reports** — daily examiner report, export.
- **Admin** — partner users list, invite, disable.

Empty states are specified: no “lorem”, no fake loans. If the book is empty, Home says “Upload a tape to open the book.”

---

## 8. Session plan (execute in order)

Plan in spec units, not vibes. A task is “36.1: T1–T6 verbatim; 4 new tables; 1 notice; roles registered,” never “finish auth.”

### Session 0 — Spec and scaffold (no product UI)

1. Copy templates into `spec/sections/36-servicing-partner-portal/`.
2. Write README + 36.1–36.6 markdown with every template heading. Paste the T-id sentences from this file into **Test cases and acceptance criteria**.
3. Declare roles `partner_admin`, `partner_ops`, `partner_auditor` in the 36.1 AI-agent / roles language so `spec_lint_names.py` will accept them. Add them to `KNOWN` in `tools/extract_agents.py` if that is how 34.1 registered staff roles — match that exact mechanism.
4. `npm run spec:register && npm run spec:manifest && npm run spec:scaffold`.
5. Confirm `src/domain/servicing-partner-portal/36-*.spec.test.ts` exist as todos.
6. Commit spec + registry + scaffolded tests only. Do **not** run `audit:baseline` yet.

Stop. Do not write runtime code in Session 0.

### Session 1 — 36.1 doors and tenancy

1. Migration for the four tables.
2. `src/runtime/partner-portal/auth.ts`, `roles.ts`, `scope.ts`.
3. Staff-only provision command so the demo partner gets a partner_admin in non-prod (wire it to `seedPartnerBookDemo` or a sibling `seedPartnerPortalDemo`).
4. Implement 36.1-T1…T6 as real `node:test`s. Titles exact.
5. `npm test` and `npm run typecheck` green for these files. If the ratchet fails because new processes exist at 0%, that is expected until tests exist — scaffolded todos do not count. Once T-ids are real, `npm run audit:baseline` in the same commit.

### Session 2 — 36.2 tape drop

1. `POST /v1/partner/book/imports` calls `importPartnerBook`. Partner from session.
2. GET imports, import detail, status, holds.
3. Implement 36.2-T1…T5 using the existing fixture files. Do not check in a second tape.
4. Prove a monitored loan still refuses a cashiering command (`LOAN_MONITORED`).

### Session 3 — 36.3 + 36.4 projections

1. `buckets.ts` + `pipeline.ts` pure functions with tests.
2. GET eligibility, GET pipeline.
3. T-ids 36.3-T1…T5 and 36.4-T1…T5.
4. Drive 33.2 / offer state by calling the existing runtime functions in the test harness the same way 33-2.spec.test.ts does. Do not stub verdicts by writing raw SQL that 33.2 would not write.

### Session 4 — 36.5 home/report/loan page API + 36.6 stub

1. GET home, reports, loan detail.
2. Serviced endpoint returns `409 SERVICED_PANE_NOT_BUILT`.
3. T-ids 36.5 and 36.6.

### Session 5 — `apps/partner` V1 UI

1. Scaffold Next.js app parallel to `apps/borrower` (same Next major if possible).
2. Cookie proxy.
3. Pages in §7 against the live `/v1/partner/*` API.
4. Playwright (or the borrower-walk style `node:test` + Playwright) for:
   - sign-in as seeded partner_admin
   - Home shows 12 monitored after seed
   - Eligibility has three buckets whose counts sum
   - Book upload of the fixture is `already_loaded` (seed already imported)
   - Loan page banner is Monitored
   - Serviced tab disabled
   - partner_ops cannot see the upload control
5. Do not add a production hostname or Dockerfile.partner until this walk is green.

### Session 6 — Harden and ratchet

1. `npm test && npm run typecheck`.
2. `npm run audit` — quote the §36 row.
3. `npm run audit:baseline` only if totals rose and no done process dropped.
4. Fill `docs/partner-portal/BACKEND-DELTAS.md` with anything you had to add that was not in this file. Each delta is a name, the reason, and the section that now owns it.
5. Stop. Do not start V2 servicing widgets.

---

## 9. Definition of done (V1)

Quote this when you claim progress. The only allowed progress sentence is an audit fraction plus this checklist.

A partner_admin of the demo partner can:

1. Sign in through `/partners/sign-in` without ever touching `/ops`.
2. See Home counts that match the latest 33.2 run.
3. See every monitored loan in exactly one of Eligible now / Likely soon / Not near / Holds.
4. See any member with an open offer or open application on Pipeline.
5. Upload a tape (or receive `already_loaded`) and see the 33.1 import report.
6. Open a monitored loan and read “Monitored — {partner} remains servicer.”
7. Not pay, draft, waive, resolve a hold, or pull credit.
8. Not see another partner’s loans.

And in code:

- Every 36.x T-id in this file exists as a non-todo `node:test` with the exact title.
- `LOAN_MONITORED` still refuses servicing commands on those 12 loans.
- `/ops` still refuses partner cookies.
- `/v1/partner-book/*` still works with `API_TOKEN` for staff/machine.
- No new timer codes unless 36.1–36.6 markdown declared them.
- `docs/audit/COVERAGE.md` section 36 processes are at 100% of *their* units, or you quote the actual fraction and do not say “done.”

---

## 10. Things you will be tempted to do. Don’t.

- Clone `/ops` and hide the staff nav. Tenancy, roles, masking, and write-set are different.
- Put partners on the borrower app behind a “workspace switcher.”
- Create `partner_book_v2_*` tables.
- Store `bucket` or `pipeline_stage` on `loans`.
- Let the partner pick `partner_party_id` or `profile`.
- Add a “score,” “priority,” or “likelihood %” that is not 33.2 `verdict` + `watch_rate_pct`.
- Filter eligibility by FICO, DTI, ZIP, name.
- Build payment / escrow / LAR screens “while we’re here.”
- Send borrower messages from the partner portal.
- Resolve holds from the partner portal.
- Approve 20.2 campaigns from the partner portal.
- Use `Date`, `number` dollars, or `enum`.
- Edit an applied migration.
- Lower the audit baseline.
- Mark a process complete in prose.

---

## 11. Suggested first message to yourself (Session 0)

Paste this when you start:

> Read `docs/partner-portal/00-CLAUDE-BUILD-INSTRUCTIONS.md` end to end. Then read every file in §2 of that document. Do not write runtime code. Author `spec/sections/36-servicing-partner-portal/` from the templates, using the process list, T-id sentences, roles, tables, and commands exactly as written. Register the three partner roles the same way section 34 registered staff roles. Run `npm run spec:register && npm run spec:manifest && npm run spec:scaffold`. Show me the new spec tree, the scaffolded test titles, and the `spec_lint_names` result. Stop.

---

## 12. Fannie / RESPA / GLBA reminder (put in 36 README Overview)

Pre-refi monitored book = GLBA service-provider data feed. Not a post-delivery servicing transfer. Not subservicing of the old loan. No Form 629, no Form 101, no RESPA hello/goodbye, no SM P&I or T&I custodial for those loans.

Post-refi (after 30.2 / 35.10 board of the **new** loan Super originated): partner remains master servicer / Fannie seller / MSR owner. Super is subservicer of the new loan. A2-1-07 then applies (both Fannie-approved, Form 101, separate 1013/1014 custodials, master remains fully liable). A2-7-03 applies if Super is later appointed onto already-delivered Fannie loans. V1 does not implement those forms. V1 must not claim they are done.

---

End of instructions. If anything in the tree contradicts this file, the **spec of the owning process** (33.x, 34.x, 20.1, 30.2) wins, and you record the contradiction in `BACKEND-DELTAS.md` instead of silently picking a side.
