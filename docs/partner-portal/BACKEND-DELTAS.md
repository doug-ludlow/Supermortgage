# Partner portal — backend deltas

This is a **gap log**, not a spec and not a license to add schema.

It is the partner-portal counterpart of [`docs/ux/BACKEND-DELTAS.md`](../ux/BACKEND-DELTAS.md). The borrower rule in [`docs/ux/14-claude-code-build-plan.md`](../ux/14-claude-code-build-plan.md) applies here unchanged:

> Never invent a state, timer, notice, command or table: if a name you need is not in the build specs, stop and append it to `BACKEND-DELTAS.md` with the reason.

Section 36 **projects** §33 / §34 / 20.1 / 30.2 / 35.10. Most names a partner surface will want already exist. Those names do **not** belong in this file. This file exists so a missing name becomes a numbered, reviewable `DELTA-NN` instead of a silent new table.

**Success case for V1: this file still has an empty deltas table.**

---

## How to use this file

1. Look for the name in §33, §34, 20.1, 30.2, 35.10, `src/runtime/partner-book*.ts`, `src/runtime/book-ops/`, or the “Already named — not a delta” list below.
2. If it exists, call it. Do not alias it. Do not wrap it in a parallel table.
3. If it does not exist and the portal cannot ship without it, append one row to the deltas table and **stop**. Do not create the object in the same session.
4. A delta becomes real only after it is accepted into `spec/sections/36-servicing-partner-portal/` (or the owning earlier section) and a migration / tool / timer / notice is registered the usual way.

A row is:

| Field | Meaning |
|---|---|
| `DELTA-NN` | Sequential id. Never reuse. |
| Needed | What the partner surface requires, in one sentence. |
| Have | The closest existing platform object, or `none`. |
| Decision | `reuse as-is` · `map this name` · `net-new` (owner section + why). |
| Owner | The spec process that will own the name. |
| Status | `proposed` · `accepted` · `built` · `rejected`. |

Illegal deltas (do not open these):

- a new eligibility score, likelihood %, or fourth bucket beside 33.2's `candidate` / `watching` / `not_now` / `excluded`
- a second tape parser or a second `partner_book_*` fact table
- putting partner users in `staff_users`
- re-triggering `SM_PARTNER_BOOK_TAPE_EXPECTED_7` or `SM_PARTNER_BOOK_INVITATION_REMINDER_14` from a different event
- sending borrower mail (`NTC_SM_PARTNER_BOOK_INVITATION`) from the partner portal in V1
- arming §2–19 on a `loans.status = monitored` row
- filters on name, ZIP, age, DTI, score, or investor columns that change who appears in Eligible now

---

## Already named — not a delta

These are declared for §36 V1. They are created by 36.1 (or reused from an earlier section). Do not log them here.

### Net-new in 36.1

| Name | Kind | Notes |
|---|---|---|
| `partner_users` | table | Bound to `parties.id` where `party_type = servicer`. `roles text[]` ⊆ `{partner_admin, partner_ops, partner_auditor}`. |
| `partner_credentials` | table | Password / passkey material. Same door pattern as 34.1, different subject. |
| `partner_sessions` | table | Cookie `sm_partner_session`. 30 min idle, 12 hr absolute. |
| `partner_actions` | table | Append-only, 5y, no PII. One row per request. |
| `partner_admin` · `partner_ops` · `partner_auditor` | roles | New union. Not `StaffRole`. Register where `spec_lint_names.py` expects roles. |
| `auth_challenges.subject_kind = partner` | reuse + extend | 34.1 already reused this table with `subject_kind = staff`. |
| `NTC_SM_PARTNER_USER_INVITE` | notice | Staff / first-admin invite of a partner user. Not a borrower notice. |
| `partner.user.invite` | command | Provisions a `partner_users` row. First admin is invited by staff. |
| `/v1/partner/*` | HTTP | Tenant wrapper. Every query scoped to `session.partner_party_id`. Cross-tenant read is **404**, not 403. |

### Reuse — call these, do not recreate

| Name | Owner | Use |
|---|---|---|
| `importPartnerBook` · `book.import` | 33.1 / `src/runtime/partner-book.ts` | Only partner V1 write. Actor from session. `partner_party_id` from session, never the body. |
| `parseBook` · profile `m3-v1` | 33.1 | Tape + supplement. |
| `partnerBookReport` · `listPartnerBookImports` | 33.1 | Import history. |
| `holdsOf` · `isOnHold` · `book.resolve` | 33.1 | Hold list is visible. Resolve stays `ops_analyst` on `/ops`. |
| `partnerBookStatus` · `SM_PARTNER_BOOK_TAPE_EXPECTED_7` | 33.1 | Next-tape clock. Do not mint a new timer code. |
| `seedPartnerBookDemo` | 33.1 / fixture | Northlight, 12 loans, `NL-100001` worked example. |
| `partner_book_imports` · `partner_book_facts` · `partner_book_invitations` | 33.1 | Source of the monitored book. |
| `partner_book_reviews` · verdict `candidate \| watching \| not_now \| excluded` | 33.2 | Eligibility board. |
| `ReviewFacts.watch_rate_pct` | 33.2 | The number on Likely soon. |
| `readiness_checks` | 33.3 | Pipeline gaps. |
| `refi_opportunities` statuses `offer_ready \| offered \| engaged \| expired` | 20.1 / `partner-book-offers.ts` | Pipeline motion. |
| `applications.prior_loan_id` | 33.3 / 21.1 | Links the refinance file to the monitored loan. |
| `bookLoans` · `bookLoan` · `bookHistory` · `bookDay` · `bookDailyReport` | 34.3 / `src/runtime/book-ops/` | Always call with `filter.partner = session.partner_party_id`. Never pass `null`. |
| `loans.status` `monitored \| paid_off \| transferred_out \| active` | 33.1 / 30.2 | Loan-page banner. |
| `LOAN_MONITORED` | 33.1 | §2–19 commands refuse on monitored rows. |
| `ANALYST_NEVER_DECIDES` | 33.2 | Partner cannot change a verdict. |
| 35.10 refinance closeout · `partner_book.loan.paid_off` | 35.10 | Old monitored loan pays off when the new loan boards. |
| `SERVICED_PANE_NOT_BUILT` | 36.6 contract | V1 GET of the serviced pane is `409` until `loans.status = active` **and** `origination_application_id IS NOT NULL`. |

Worked figures are already asserted by 33.2-T2. Do not recompute them:

- Loan 1 `NL-100001`: note **7.250%**, UPB **$441,366.13**, P&I **$3,069.79**, value **$605,000.00**, candidate **6.375%**, delta **87.5 bps** → Eligible now.
- Loan 9: `watching`, `watch_rate_pct` **5.625**.
- Loan 11: `excluded`, reason `bankruptcy_active`.

---

## Deltas

None yet. Append below; do not edit rows in place. A rejection is a new row with `Status = rejected` and the reason.

| Delta | Needed | Have | Decision | Owner | Status |
|---|---|---|---|---|---|
| — | — | — | — | — | — |
| DELTA-02 | 36.2-T3's sentence "it is absent from the next 33.2 review" for a loan on hold (`not_on_latest_tape`): the brief reads as if the held loan had no review row. | 33.1 rule 8 / 33.1-T11 / `src/runtime/partner-book-review.ts` `verdictOf({held})`: the daily review WRITES a row for the held loan — verdict `not_now`, reason `not_on_latest_tape`, the hold flag on `facts.flags` — so it is held out of candidacy (never `candidate` or `watching`, no offer delivered) and stays off the three buckets (36.3). No row of the day is skipped. | map this name: "absent from the review" on the partner surface means "held out of candidacy by the review": 36.2 rule 9 reads the row as 33.1 writes it, 36.2-T3 asserts `not_now` / `not_on_latest_tape`, no `candidate` / `watching` row and no `offered` / `engaged` opportunity for the held loan. No new verdict, reason, flag or column. | 33.1 (the hold), 33.2 (the row), 36.2 (the wording) | accepted (2026-09-16, 36.2 build: the wording of rule 9; nothing minted) |
| DELTA-03 | 36.4-T4's and 36.5's retired prior loan (`loans.status = paid_off` with `refinanced_by_loan_id` = the new loan, 35.10 `monitored_partner`) needs a banner sentence: the brief's §4.6 lists three (Monitored / In refinance / Active) and none for "paid off / refinanced". | `loans.status` (paid_off, transferred_out — 33.1 / 35.10), `loans.refinanced_by_loan_id` (35.10 rule 7), `loans.retired_reason`; the three sentences of 36.5 rule 4. | map this name: until a fourth sentence is accepted, the row's `banner` is null and the page shows `loans.status` and `refinanced_by_loan_id` as the link to the new loan (36.4 rule 7, 36.5 rule 4 — "paid off / refinanced" is read from those two fields); `bucket` null; `serviced` null. Never a sentence minted by 36.x. Accepting a sentence is a one-line change in `bannerOf` (src/domain/servicing-partner-portal/buckets.ts) and 36.5 rule 4. | 36.5 (the banner), 35.10 (the fields) | proposed (2026-09-16, 36.3/36.4 build: the null banner is what 36.4-T4 asserts) |

---

## Open follow-ups

None. When a session stops because a name is missing, the follow-up is the `DELTA-NN` row above, not a prose TODO in the code.
## Open follow-ups

None. When a session stops because a name is missing, the follow-up is the `DELTA-NN` row above, not a prose TODO in the code.
