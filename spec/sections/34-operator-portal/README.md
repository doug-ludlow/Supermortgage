# Section 34 — The operator portal: staff sign-in, the account directory, partner book operations and evidence

## Overview

The operator portal is where Supermortgage's own staff run the platform: the same `/ops` host the console lives on today, behind a real sign-in with roles instead of self-asserted headers. It is internal only — no partner users, no tenancy — and every action a person takes in it is a bus command with the person as the actor, so the agents' guardrails and the decision records apply to a human exactly as to an agent.

Five processes. 34.1 puts staff accounts, the doors (an e-mail code, then a password or passkey), roles (`ops_analyst`, `officer`, `compliance`, `admin`) and the action log in place, and retires the header actor. 34.2 is the account directory: every person on the platform — homegrown or from a partner's tape — found by name, e-mail, phone or loan number, with their sessions, subjects, the thread, the cards, the assistant's turns, the events, the decisions and the notices, masked by role. 34.3 is partner book operations: the tape and supplement upload with the row report, the import history with what each upload changed, the monitored loans with their latest facts, the loans on hold because the latest tape dropped them (33.1 rule 8) and their resolution, each morning's review and the readiness checklist per loan, offers out and expired, the examiner's daily report per partner, and the next tape expected. 34.4 is evidence and controls: the clocks due and breached, escalations, the outbox, the AI systems and their versions and kill switch, and the evidence pack export. 34.5 is the portal's information architecture and the accounts list: eight areas in a fixed order — Home, People & accounts, Pipeline, Loans, Partner book, Operations, Oversight, Staff — each a landing that never refuses the account that can see it, the role chosen per read and per act (34.1 rule 3), and a browse over every person from every door, newest first, with counts, filters and paging, masked and logged exactly as the search is, beside a tab for the people who are not yet an account.

Capacity: Supermortgage as platform operator. Nothing in this section changes a money field, a decision or a borrower record on its own; the portal shows and it dispatches the owning processes' commands with the staff member as actor. Consumers: sections 1–33 (their commands and records); 18.1 and 31.x (AI governance, records, security) for the action log and the access review.

Dependencies: 32.2/32.14 (the door mechanics reused for staff), 19.x (records, security, retention), 33.x (the partner book rows), 18.1 (the kill switch and AI systems).

## Processes

| Process | Title | Automation class |
|---|---|---|
| 34.1 | Staff sign-in and roles: accounts, the doors, the action log, the access review | c |
| 34.2 | The account directory: every person, their activity and their record, masked by role | c |
| 34.3 | Partner book operations: uploads, import history, the book, reviews, readiness, the daily report | c |
| 34.4 | Evidence and controls: clocks, escalations, the outbox, AI systems, the evidence pack | c |
| 34.5 | The portal's information architecture and the accounts list | c |

## Closing

Build order: 34.1 (nothing else is safe without a real actor) → 34.3 (the partner book is the operational need) → 34.2 → 34.4 → 34.5 (the areas and the list project the four; its T8 is the first test that loads the portal's screen). Section-level acceptance: a staff member signs in with a code and a password, uploads the fixture tape and supplement, watches the import report, opens a homeowner's account from the directory and reads the thread and the daily review, resolves a loan the latest tape dropped, completes an escalation, and every one of those actions is on the action log with their identity and role.
