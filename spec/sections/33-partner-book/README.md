# Section 33 — The partner book: monitored loans, real accounts and refinance readiness

## Overview

A servicer partner hands Supermortgage its book: a loan-level tape (the partner's own layout — the first partner's is an "M3" investor tape of 118 columns: servicer loan number, the primary borrower's name, the property, balances, rates, payments, pay strings, FICO, BPO and FMV, LTV, occupancy, ARM terms, foreclosure and bankruptcy flags, MERS id, PMI, DTI, agency and remittance type) and a supplement with each borrower's e-mail and phone. From the moment the file is loaded every homeowner on it is a real account on the platform: a party with their contact, their loan as the subject, sign-in by a code to the e-mail or phone the partner gave us, a password or passkey if they want one — the same thread, record and assistant every homegrown borrower has. Nothing is mailed; the invitation goes by e-mail (and by text where the partner's consent evidence allows).

The loans are **monitored, not serviced**. The partner keeps servicing them: no payment is taken, no statement, no escrow analysis, no delinquency clock, none of sections 2–19 turns on. The platform holds the partner's facts about each loan, refreshes them with every re-upload, and works the book every day with two agents: the refinance analyst (33.2) decides, loan by loan, whether a refinance is worth the homeowner's attention today and writes a reason an examiner and the homeowner can read; the readiness agent (33.3) keeps a checklist of what a refinance needs (identity, SSN, a usable credit report, a live payroll and assets connection, consents, a value, insurance) with the source and freshness of each item, and turns what is missing into the assistant's asks the moment the homeowner engages. When a homeowner refinances with us the new loan closes through sections 20–31 and boards through 30.x; only then does servicing begin.

Capacity: the partner is the lender of the refinance program (20.1 rule 6) and the servicer of record of the monitored loans; Supermortgage is the platform that holds the account and the relationship. The daily refinance engine is 20.1's (the selection rules, the investor-blind universe, the candidate and benefit math, the fair-lending extract); 33.2 feeds it the partner's facts and reads its answer. Every vendor is the in-repo FAKE in every build stage.

Dependencies: 1.1 (the tape grammar this section deliberately does not use for a monitored book), 20.1/20.2/20.3/20.4 (the refinance program, touches, leads, pricing), 21.1 (the refinance application opened from a monitored loan), 22.2/22.3/22.4/22.6 (the readiness signals), 32.2/32.14/32.16 (accounts, doors, the turn), 32.11 (the rate-watch surface), 32.18 (the DU moment the readiness agent hands to). Consumers: 30.x boards the refinanced loan; 18.1 governs the analyst's model versions.

Changes in flight that shape the build: the first partner's supplement carries e-mail and phone only (no TIN, DOB, mailing address or co-borrower); the tape's investor columns never reach the refinance universe (B2-1.3-04); credit is never pulled for selection (FCRA §604; 20.1 NO_CREDIT_PULL).

## Processes

| Process | Title | Automation class |
|---|---|---|
| 33.1 | The partner book import: the tape and the supplement become monitored loans and real accounts | a |
| 33.2 | The daily refinance review: every monitored loan reviewed each day by the refinance analyst | a |
| 33.3 | Refinance readiness: what a refinance needs, what is on file, what is asked for | a |

## Closing

Build order: 33.1 (the data path, the accounts, the invitation, the first sign-in) → 33.2 (the partner facts into 20.1's universe, the daily review and the analyst turn, the offer delivery and expiry passes) → 33.3 (the readiness checklist, the refinance application opened from a monitored loan, the asks, the hand-off to the DU moment). Shared fixtures: `src/domain/partner-book/fixtures/partner-book-demo.ts` (a deterministic 12-loan book in the first partner's 118-column layout with a matching supplement, loan 1 the worked example) and the demo seed, which imports it so the deployed demo carries a partner book. Section-level acceptance: a homeowner from the fixture signs in from the invitation, sees the monitored loan on the record, is reviewed the next morning, and — after a Yes on the offer — reaches `du.findings.received` through 32.18 with every readiness item present.
