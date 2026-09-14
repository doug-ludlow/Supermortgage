# 34.2 — The account directory: every person, their activity and their record, masked by role

| Attribute | Value |
|---|---|
| Section | 34 — The operator portal: staff sign-in, the account directory, partner book operations and evidence |
| Automation class | c — a staff member searches and reads; the platform projects, masks and logs |
| Capacity | Platform operator (the system of record for every account; the partner remains servicer of record for a monitored loan) |
| Trigger & frequency | On every directory request by a signed-in staff member (34.1) |
| Governing source | GLBA §1016.13 and 16 CFR §314.4(c) (customer information only to authorized users, least privilege); 19.1/19.2 (records, retention, access logging); 32.2 (sessions, assurance levels), 32.16 (agent turns as records), 18.1 (AI systems and their decision records); 33.1 (monitored loans, the partner's contact) |
| Key deadlines | None of its own; the export honours the owning records' retention classes |
| Timers | none |

### Blueprint row
Support and operations need one place to answer "who is this person and what has happened on their account": whether they came through the front door or a partner's tape, how they signed in and when, which loans and applications are theirs, what they and Michelle said, which cards were asked and answered, what the agents decided and why, and what was sent to them. Today those rows exist across a dozen tables and the console shows loans only. This process is the directory over all of it, with the person's sensitive fields shown only to the roles that need them, and every look logged.

### Verified requirement (as of 2026-09-14)
**Least privilege over customer information (16 CFR §314.4(c)(1); GLBA §1016.13).** A staff member sees a person's non-public information only as their role requires. Here `ops_analyst` sees names, masked contact (e-mail as `m…@example.com`, phone as `···0101`), loan and application identifiers, the thread and the cards; `compliance` and `officer` may unmask contact and see the SSN last four and the date of birth for a named case; nobody sees a full SSN, a password hash, a token or a vendor payload. Every unmask is its own logged action with a reason. **[VERIFIED against the rule text; the role split is this process's own policy.]**

**The record is what the sections wrote (19.1; 32.16; 18.1).** The directory projects — it never edits. The thread is `messages` and `card_instances`; the assistant's turns are `agent_turns` with model and prompt versions and the guard result; the decisions are `agent_decisions`; the notices are `notices`/`notice_deliveries`; the events are `loan_events`. What the borrower saw is reproduced from those rows, tokens resolved as the surface resolved them.

**Discrepancies vs blueprint**: (1) Search matches on hashed and normalized contact (the platform stores e-mail and phone on `parties.contact`; the directory indexes their normalized forms) — a partial e-mail or phone search is prefix-only on the normalized value. (2) An "activity" line for a borrower's own action is the event the section logged, never a synthetic audit row; a staff member's look at the record is the `staff_actions` row (34.1).

### Operational prerequisites
- 34.1 (a session with a role on every request).
- The copy library for the card and message rendering (the same loader the borrower app uses), so the thread reads as the borrower saw it.

### Build spec
#### Inputs and triggers
- `GET /ops/api/directory/search?q=` (name, e-mail, phone, servicer loan number, application id; ≥ 3 characters) → `directory.search`.
- `GET /ops/api/directory/accounts/{party_id}` → `directory.account` (the person, their subjects, sessions, credentials kinds, consents, the partner-book facts summary for a monitored loan, the readiness and review summaries).
- `GET /ops/api/directory/accounts/{party_id}/activity?from=&to=&kind=` → `directory.activity` (the thread, cards, turns, events, decisions, notices, staff looks — one time-ordered stream with a kind per row).
- `POST /ops/api/directory/accounts/{party_id}/unmask` `{fields, reason}` (compliance, officer) → `directory.unmask` (a time-boxed unmask for that session).
- `POST /ops/api/directory/accounts/{party_id}/export` (compliance) → `directory.export` (the person's records as the evidence pack lays them out; 34.4).
- Events: `directory.searched{staff_user_id, query_hash, results}`, `directory.viewed{staff_user_id, party_id, section}`, `directory.unmasked{staff_user_id, party_id, fields, reason}`, `directory.exported{staff_user_id, party_id, export_id}` (global; no destination, no name).

#### Data model
New tables (append-only; retention `security_logs_5y`):
- **`directory_unmasks`** (new; append-only): `id uuid pk`, `staff_user_id`, `session_id`, `party_id`, `fields text[]`, `reason text`, `granted_at`, `expires_at` (15 minutes), `created_at`.
- **`directory_exports`** (new; append-only): `id uuid pk`, `staff_user_id`, `party_id`, `document_id uuid` (the pack), `sha256 text`, `created_at`.
- Baseline tables read: `parties`, `party_credentials`, `sessions`, `application_borrowers`, `borrowers`, `loan_borrowers`, `loans`, `applications`, `conversations`, `messages`, `card_instances`, `card_instance_events`, `agent_turns`, `agent_decisions`, `loan_events`, `notices`, `notice_deliveries`, `consents`, `partner_book_facts`, `partner_book_reviews`, `readiness_checks`, `staff_actions`. A search index: a generated column or materialized index over normalized e-mail, E.164 phone and lower-cased legal name on `parties` (a migration adds it; no new table).

#### State machine
Per unmask: `granted —(15 minutes | sign-out)→ expired`. Per export: `requested → produced` (one pack, hashed, on the documents table) — nothing else has state; the directory is a projection.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|

Jurisdiction overrides: none.

#### Business rules and calculations
1. **One directory for every person.** A homegrown party and a partner-book party are the same row kind (`parties{borrower}`); the directory shows the origin (`front door`, `video door`, `partner book: <partner>`), the first session, and the doors used since. A person with no session yet (invited, never signed in) is listed as `invited` with the invitation and reminder dates.
2. **Masking by role.** Default view: name, masked e-mail and phone, city and state, subjects with last-four identifiers, session history (times, doors, levels, never tokens), consents with kinds and dates. Unmasked (compliance, officer, with a reason, 15 minutes): the full e-mail and phone, the SSN last four and the date of birth from the application or the partner's supplement. Never shown to anyone: full SSN, credential hashes, session tokens, vendor payloads, the model's raw tool inputs beyond what the turn recorded.
3. **The activity stream is the record's rows.** Each row: `at`, `kind` ∈ {message, card, turn, event, decision, notice, session, staff_look}, `actor` (borrower, agent name, staff id, system), a one-line summary rendered from the row (the message body with tokens resolved; the card kind and status; the turn's model and prompt versions and guard result; the event type; the decision action and rule; the notice template and channel), and the row id for drill-down. Filters by kind and date. The staff member's own looks appear in the stream like any other row (34.1's log).
4. **Search never leaks.** Results carry names and masked contact only; the query is logged as a hash; fewer than three characters is refused; more than 50 matches asks for a narrower query.
5. **Export is the evidence pack for one person** (34.4's layout restricted to the party): a document on `documents` with a hash, produced by `compliance`, logged, and retained with the records it copies.
6. **The directory writes nothing to a borrower's record.** Actions on the account (a callback, a case, an escalation, a resolution) are the owning sections' commands, dispatched from the account page with the staff actor (34.1 rule 3), and appear in the stream as their own events.

No money figure is computed here.

#### Integrations
- None new. The copy loader (`src/runtime/borrower/channels.ts`) renders message tokens for the stream.

#### Outputs and artifacts
- Rows: `directory_unmasks`, `directory_exports`, `staff_actions` (34.1), `documents` (the export).
- Events: `directory.searched`, `directory.viewed`, `directory.unmasked`, `directory.exported`.
- The portal's directory: search, the account page (identity, origin, subjects, sessions, consents, the partner-book summary, the review and readiness summaries), the activity stream, the unmask control, the export.

#### AI agent design (AI-first)
`security-records` agent (tools: `directory.search`, `directory.account`, `directory.activity`, `directory.unmask`, `directory.export`). End-to-end: `directory.search` finds people by normalized name, contact or loan number; `directory.account` and `directory.activity` project the record for the caller's role; `directory.unmask` grants a time-boxed unmask with a reason and logs it; `directory.export` produces the one-person evidence pack. Decision record schema (unmask and export only) `{party_id, action, fields, reason, by, rule_set_version: directory.mask.v1, model_version: deterministic, prompt_version: 34.2-v1, confidence: 1}`. Guardrails: `ROLE_MASK` (the projection is masked for the role before it leaves the tool), `NO_FULL_SSN`, `NO_SECRETS` (hashes, tokens, vendor payloads never projected), `REASON_REQUIRED` on unmask and export, `LOG_EVERY_LOOK`, `READ_ONLY` (the tools write only their own log rows). Escalations: `compliance` when one staff member unmasks more than 20 people in a day.

#### Edge cases and failure modes
- Two parties share an e-mail (a household) → both listed, each with their own subjects; the directory never merges.
- A party linked to a homegrown party at import (33.1 rule 3) → one row, the origin line names both doors.
- A search by a servicer loan number that matches a loan with no party (loaded before any supplement) → the loan is listed under "no account yet" with the partner and the last-four.
- An unmask expires mid-page → the fields re-mask on the next request; the page asks for the reason again.
- A monitored loan's homeowner asks support what the partner sees → the account page shows the partner's latest facts as of their date, labelled as the partner's.

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 34.2-T1 | Given the fixture book imported and one homegrown account, when an `ops_analyst` searches by the last four of loan 1's servicer loan number, by "Garcia", by the first six characters of the e-mail and by the phone's last four digits, then each search lists Maria Garcia once with masked contact, `directory.searched` is logged with a query hash and no query text, and a two-character query is refused. |
| 34.2-T2 | Given loan 1's homeowner signed in twice (code, then password), when the analyst opens the account, then the page shows origin `partner book`, both sessions with doors and levels and no token, the monitored loan as the subject with the partner's latest facts as of their date, the latest review verdict and the readiness summary, e-mail and phone masked, and no SSN or date of birth. |
| 34.2-T3 | Given the same account, when `compliance` unmasks contact and identity with a reason, then the full e-mail and phone and the supplement's SSN last four and date of birth are shown for 15 minutes, `directory.unmasked{fields, reason}` is logged with a decision record, and after 15 minutes the fields are masked again; given an `ops_analyst`, then `ROLE_REQUIRED{compliance}`. |
| 34.2-T4 | Given the homeowner's thread with a first turn, a question and a resolved card, when the analyst reads the activity stream, then it lists in time order the invitation notice, the activation event, the sessions, the assistant's turns (model and prompt versions, guard result), the borrower's messages with tokens resolved as displayed, the card and its resolution, the daily review decision, and the analyst's own look, each with its kind and actor; filtering by kind `turn` leaves the turns only. |
| 34.2-T5 | Given `compliance` exports the account, then a document exists on `documents` with a hash, `directory_exports` and `directory.exported` record it, and the pack carries the person's rows only (no other party's message, card or event appears). |
| 34.2-T6 | Given any directory response, then no field carries a full SSN, a credential hash, a session token or a vendor payload (contract test over every route with a fixture account whose rows carry each). |

#### Audit and evidence
What an examiner is shown: who searched for whom and when (hashes), who viewed which account and section, every unmask with its reason and expiry, every export with its hash. All of it from `staff_actions`, `directory_unmasks` and `directory_exports`; exported through the evidence pack.

### Open questions / decisions
1. Should `officer` unmask, or only `compliance`? **Default: both, with a reason; the log tells them apart.**
2. Should the activity stream include the model's tool calls? **Default: the turn row names the tools called; the inputs stay in `agent_turns` for compliance only.**

### Sources
- 16 CFR §314.4(c); 12 CFR §1016.13; spec/sections/19-*/19-1, 19-2; 32.2 §2; 32.16 §3 (agent turns); 18.1; db/migrations/0111 (sessions, cards, messages), 0119 (agent_turns), 0125 (partner_book_*, readiness_checks); src/runtime/borrower/record.ts (the projection this reuses).
