# 32.5 — Verification, needs list, conditions, second borrower

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | c — the borrower uploads, connects, explains and invites by card; `underwriting_reviewer` clears what auto-clear does not |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | On `condition.opened` / `document_requests` / `verification.received` / `document.classified`; on an invite |
| Governing source | Projection of sections 22.1 (documents and the needs-list loop), 22.2 (credit refresh, inquiries, undisclosed debt), 22.3 (income), 22.4 (assets), 22.5 (liabilities), 22.6 (identity/fraud), 23.2–23.3 (conditions lifecycle), 21.1 (co-borrowers, joint intent) |
| Key deadlines | renders `SM_NEEDS_LIST_BORROWER_RESPONSE_5`, `SM_DOC_EXPIRY_WARN_14`, `FNMA_B1_1_03_CREDIT_DOCS_4M` (owned by 22.x) |
| Timers | — |

### Blueprint row
Projection of sections 22.1 (documents and the needs-list loop), 22.2 (credit refresh, inquiries, undisclosed debt), 22.3 (income), 22.4 (assets), 22.5 (liabilities), 22.6 (identity/fraud), 23.2–23.3 (conditions lifecycle), 21.1 (co-borrowers, joint intent). Owner specs: 22.1 (documents and the needs-list loop), 22.2 (credit refresh, inquiries, undisclosed debt), 22.3 (income), 22.4 (assets), 22.5 (liabilities), 22.6 (identity/fraud), 23.2–23.3 (conditions lifecycle), 21.1 (co-borrowers, joint intent). The happy path (32.3) made most of this invisible; this file specifies what the borrower sees when something is actually needed. (Imported from docs/ux/05-verification-conditions-coborrowers.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 05 is 32.5 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections 22.1 (documents and the needs-list loop), 22.2 (credit refresh, inquiries, undisclosed debt), 22.3 (income), 22.4 (assets), 22.5 (liabilities), 22.6 (identity/fraud), 23.2–23.3 (conditions lifecycle), 21.1 (co-borrowers, joint intent)** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: none beyond 32.2's list.

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- On `condition.opened` / `document_requests` / `verification.received` / `document.classified`; on an invite. Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.

#### Data model
No UI-owned table is declared here (32.2 declares the seven UI-owned tables; this process writes `conversations` through the 32.2 command endpoints).
- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): `application_liabilities`, `conditions`, `debt_payoff_plans`, `document_requests`, `parties`.
- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.

Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list's): `SM_NEEDS_LIST_BORROWER_RESPONSE_5` (22.1), `SM_NEEDS_LIST_REVIEW_1BD` (22.1), `FNMA_B1_1_03_CREDIT_DOCS_4M` (22.1), `FNMA_B3_3_2_01_PAYSTUB_30D_GATE` (22.1), `SM_DOC_EXPIRY_WARN_14` (22.1), `FNMA_B3_3_1_04_VVOE_10BD` (22.3), `FNMA_B3_2_02_DU_CLOSE_BY_GATE` (22.3), `FCRA_605A_H_ALERT_CONTACT_GATE` (22.6), `SM_O21_JOINT_INTENT_GATE` (21.1), `SM_DU_CONDITIONS_SLA_4H` (23.2).

Jurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### 1. One list, one owner per item

The borrower has exactly one list: **Needed from you** (Record §4) rendered from `borrower_record.needed_from_you[]` and mirrored by a single `ChecklistCard` pinned in the Thread. Sources:

- `conditions` (23.2 opens from DU messages; 23.3 owns the lifecycle) — `open → waiting_borrower | waiting_third_party → satisfied_pending_review → cleared`; `waived`, `reopened`, `superseded`. Only `waiting_borrower` items are actionable by the borrower; `waiting_third_party` and `open` items appear under **What we're doing** with the owner label (*us* / *the title company* / *the appraiser* / *your current servicer*).
- `document_requests` (22.1) — created from DU/underwriter conditions that need a document; each carries `document_class`, `freshness_hint`, `due_at` (`SM_NEEDS_LIST_BORROWER_RESPONSE_5`).
- Pending consents, confirmations, connectors, acknowledgments, schedules (32.2 §1.3).

Rendering rules: one line per item, verb first ("Connect your bank", "Upload your homeowners policy", "Explain the Capital One inquiry from Sept 30"), due date if any, an action chip that opens the card. The count in the status strip is `count(owner=you)`. Zero items renders the **nothing needed** state ("Nothing needed from you. We'll message you when something is.").

##### 2. Documents and the needs-list loop (22.1)

###### 2.1 Requests
`NTC_SM_NEEDS_LIST` is the notice of record for a new set of borrower items; the Thread renders it as the `ChecklistCard` (not a separate letter) and the Documents section keeps the rendered notice. Reminders (`NTC_SM_NEEDS_LIST_REMINDER`) follow 32.1 §6.4 cadence; each reminder repeats the deep link to the checklist. Internal review SLA `SM_NEEDS_LIST_REVIEW_1BD` is invisible.

###### 2.2 Upload
`UploadCard{document_class, accepted_examples, freshness_hint}`: camera or file; multi-page; PDF/JPG/PNG/HEIC. On `document.classified`:
- class matches → item `satisfied_pending_review` → the assistant confirms in one line; `cleared` when 23.3's auto-clear rule passes or the `underwriting_reviewer` clears.
- class mismatch → the card re-opens: "This looks like a {{detected}}; we need a {{expected}}" with examples.
- integrity failure (22.1 integrity battery) → the item stays open with neutral copy ("we couldn't read this one — try a clearer photo or a PDF"); fraud-suspected documents route to 22.6 silently (never "this looks altered" to the borrower).
- freshness failure (`FNMA_B1_1_03_CREDIT_DOCS_4M`; paystub floor 30 days at application `FNMA_B3_3_2_01_PAYSTUB_30D_GATE`) → "this one is dated {{date}}; we need one from the last {{n}} days".

###### 2.3 Freshness re-asks
When a closing date moves, 22.1's nightly sweep recomputes freshness against the new note date; items that will expire raise `SM_DOC_EXPIRY_WARN_14` → the Record's Dates row "a document is about to go out of date" and, at expiry, a new request with the reason ("closing moved to {{date}}, so we need a paystub from the last 30 days"). Connected sources (Truv, Plaid) refresh without asking; the borrower only hears when a connection has broken (`ConnectCard` → `failed` → reconnect).

###### 2.4 Verbal verification of employment and the credit refresh
Invisible when connections are live: `FNMA_B3_3_1_04_VVOE_10BD` is satisfied inside the DU validation close-by window (`FNMA_B3_2_02_DU_CLOSE_BY_GATE`); the pre-closing credit refresh and undisclosed-debt monitoring (22.2) run silently. Visible only on a finding:
- **New debt found** → `ConfirmCard` "We see a new account with {{creditor}} opened {{date}} (source: credit refresh). Is this yours?" → yes → liability added, DU resubmission (23.1 tolerances) and the assistant states whether anything changes; no → 22.2 dispute/fraud path (SQ-14/15).
- **Employment change** → `ConnectCard` reconnect or `UploadCard{employment_offer|paystub}`; the copy never speculates about the decision.

##### 3. Letters of explanation (SQ-02)

`ExplanationCard{subject, prompt, min_length}` per item; dictation allowed; rendered to `explanation_letter` / `inquiry_explanation` (22.1 classes) with a typed-name attestation. Triggers: credit inquiries ≤ 90 days (22.2), large deposits > 50% of monthly qualifying income (22.4), employment gaps, address discrepancies, occupancy questions (22.6). The prompt names the fact and asks one question ("Did this inquiry result in a new account? If so, what's the payment?"). Never asks *why* in a way that touches a prohibited basis (21.1 rule 5).

##### 4. Assets, gifts, earnest money (22.4)

- `ConnectCard{plaid_assets}` when DU asks ("Funds Required to Close", "Reserves Required to be Verified") or on purchase from P7; `ConfirmCard` of accounts/balances; large-deposit `ExplanationCard`s; `UploadCard{gift_letter, gift_transfer_evidence}` for gifts; `UploadCard{emd_evidence}` once the contract exists.
- The Record's Numbers show **Verified funds** vs **Cash to close + reserves required** only as a pass/fail line ("verified funds cover your cash to close") — amounts appear in the LE/CD, not as an internal worksheet.
- Interested-party contribution limits (3/6/9%; 2% investment) and the LCOR cash-back cap are explained only when they bind (the assistant states the limit and the number).

##### 5. Liabilities and DTI (22.5)

The borrower never sees a DTI figure as a decision variable except inside a decision notice's specific reason ("debt-to-income of 53% exceeds the 50% maximum"). Debts to be paid at closing are a `ChoiceCard` per debt when the restructure loop proposes it ("paying off the {{creditor}} balance of {{money}} at closing changes your monthly obligations by {{money}} — include it?") → `debt_payoff_plans`; the settlement statement will show the payoff (22.5 rule).

##### 6. Identity and fraud follow-ups (22.6)

Borrower-visible only as neutral requests: a second identity step (`ConnectCard{stripe_identity}` re-run or `UploadCard{passport|state_id}`), an occupancy confirmation (`ConfirmCard` "You'll live here as your primary home — correct?"), a fraud-alert contact confirmation (`FCRA_605A_H_ALERT_CONTACT_GATE`: the assistant calls or texts the number on the alert and asks the borrower to confirm the application). Never: "fraud", "red flag", "SAR".

##### 7. The second borrower (SQ-19) — a first-class parallel flow

- `InviteCard{co_borrower}` from either party at any point before `intake_complete`. Creates the invitee's `parties` row, their own `conversations` row and a deep link; the inviter's Record shows People: "{{first name}} — invited, waiting".
- The invitee runs E2 (disclosure), E4 (L1), E5 (L3), E6 (their own consents), then **joint intent** first: `ConsentCard{joint_intent}` — "Do you intend to apply for this loan jointly with {{other first name}}?" — captured before any credit is ordered for them (`SM_O21_JOINT_INTENT_GATE`; 21.1 rule 4). Then R2–R6 for themselves (their income, their liabilities confirm, their ProfileCard, their declarations, their DemographicsCard). Assets can be shared accounts (Plaid connection by whichever party holds the login; the account is attributed to both when the statement shows both names).
- A **non-borrowing spouse** who only signs the security instrument is invited with `party_role=non_borrowing_spouse`, receives no credit questions (21.1 rule 4), and appears at closing (32.7) with their own signing session.
- DU runs when every borrower's items are present; one score model for all (22.2/23.1 T11).
- Both threads receive the LE/CD `DocumentCard`s; a disclosure is electronic only to parties with active E-SIGN — the Record shows per-party delivery status (7.4 rule 4: mail to the non-consenting party satisfies the timer).
- The Record is shared; each party sees only `progress` booleans and first name for the other (32.2 §1.1).

##### 8. Human agent

`human.request` from any card → `human.transfer.requested` → warm transfer with the full context; the Thread shows `PersonCard{human_agent}` and subsequent turns carry the human's name. Cards remain the only way to commit; a human agent can *send* cards but not resolve them for the borrower (baseline: "borrowers can self-serve on the portal regardless"; humans use the ops-console with the same validators).

#### Integrations
- **`FAKE` vendors** — Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console. Adapters this process touches: the ones its cards name (ConnectCard vendors, the RON platform, telephony, e-mail/SMS, print/mail); each is direction in/out through the owning process's adapter, idempotent on `card_instance_id` / vendor session id, and on outage the card shows `failed` with the upload or paper fallback (32.1 §10).
- **`api`** — the borrower endpoints of 32.2 §7; errors carry {code, gate, copy_key}; the SSE stream of 32.2 §3.

#### Outputs and artifacts
- Rows written: `card_instances` (+ `card_instance_events`), `messages`, `ui_events`, `deep_links`; domain evidence rows through the owning handler (32.1 §9). Documents produced: none — every disclosure and notice rendered here is the owning process's rendered document (`notices.rendered_document_id`, `disclosures.rendered_document_id`), shown with its template version and delivery evidence; a notice delivered by mail shows *Mailed* and no receipt action.

#### AI agent design (AI-first)
`intake` agent owns the pre-funding thread for this process; it sends and resolves cards through the card-sending capabilities named in 32.1 (send_card, resolve_card_by_evidence, create_deep_link) and issues every borrower command through the 32.2 command surface; it names no tool of its own here. End-to-end: on each event this process subscribes to, the agent puts the typed card in front of the borrower with the copy key named, keeps the Record in step, and reminds on the owning process's cadence; the borrower commits by card; the owning process decides. Decision record schema: {card_instance_id, party_id, subject, event, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}. Guardrails: never a decline, "you don't qualify", "guaranteed" or an investor reference in copy (32.1 §7.3); never a personal rate before `mlo.review.completed{approved}`; never a consent by voice or chat; never a money-field change without `officer` approval; never a date the Timer Engine did not compute. Escalations: `human_agent` on "human" or distress; the human roles the owning process names (`mlo_of_record`, `underwriting_reviewer`, `officer`) for their acts.

#### Edge cases and failure modes
- Vendor down → `ConnectCard` `failed` with the `UploadCard` fallback; AI path off → `human_agent` turns, cards and Record unchanged; DU / Fannie Mae outage → no borrower-visible error, timers still render; offline → cards queue *unsent* and nothing shows as done until the server acknowledges; E-SIGN suspect → the document flips to *Mailed* and re-verification is offered (32.1 §10).

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 32.5-T1 | Given a DU verification message opens a `conditions` row, then within `SM_DU_CONDITIONS_SLA_4H` it appears in Needed-from-you with owner *you* and a verb-first label. |
| 32.5-T2 | Given an `UploadCard{paystub}` receives a W-2, then the item stays `waiting_borrower` and the card shows the mismatch copy with the detected class. |
| 32.5-T3 | Given a paystub dated 40 days before the application date, then the freshness copy renders the 30-day rule and the request stays open. |
| 32.5-T4 | Given the closing date moves from Nov 6 to Dec 15, 2026 and an asset statement would exceed 4 months at the new note date, then `SM_DOC_EXPIRY_WARN_14` shows in Dates and a re-request is created on expiry with the reason text. |
| 32.5-T5 | Given the pre-closing credit refresh finds a new tradeline, then a `ConfirmCard` renders naming creditor and open date and nothing about the decision; a yes adds `application_liabilities` and triggers DU resubmission per 23.1 tolerances. |
| 32.5-T6 | Given a large deposit of $9,000 against $8,200 monthly qualifying income, then an `ExplanationCard` is created for that deposit only. |
| 32.5-T7 | Given a co-borrower invite, then a `credit.authorize` for the invitee is refused until `joint_intent` is affirmed by that invitee (`SM_O21_JOINT_INTENT_GATE`). |
| 32.5-T8 | Given a non-borrowing spouse party, then no `ProfileCard`, `DemographicsCard`, income or liability card is ever created for that party. |
| 32.5-T9 | Given borrower A has active E-SIGN and borrower B does not, then the LE is electronic to A (`DocumentCard`) and mailed to B; the Record shows both statuses; the LE timer is satisfied by the mailing to B. |
| 32.5-T10 | Given a human agent is engaged, when the agent attempts to resolve a `ConsentCard` on the borrower's behalf, then the API refuses (`party_id` mismatch). |
| 32.5-T11 | Given zero `owner=you` items, then the Record shows the nothing-needed state and the status strip count is 0. |

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**

### Sources
- docs/ux/05-verification-conditions-coborrowers.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections 22.1 (documents and the needs-list loop), 22.2 (credit refresh, inquiries, undisclosed debt), 22.3 (income), 22.4 (assets), 22.5 (liabilities), 22.6 (identity/fraud), 23.2–23.3 (conditions lifecycle), 21.1 (co-borrowers, joint intent) (spec/sections/)
