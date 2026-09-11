# 05 — Verification, the needs list, conditions, and the second borrower

Owner specs: O3.1 (documents and the needs-list loop), O3.2 (credit refresh, inquiries, undisclosed debt), O3.3 (income), O3.4 (assets), O3.5 (liabilities), O3.6 (identity/fraud), O4.2–O4.3 (conditions lifecycle), O2.1 (co-borrowers, joint intent). The happy path (03) made most of this invisible; this file specifies what the borrower sees when something is actually needed.

## 1. One list, one owner per item

The borrower has exactly one list: **Needed from you** (Record §4) rendered from `borrower_record.needed_from_you[]` and mirrored by a single `ChecklistCard` pinned in the Thread. Sources:

- `conditions` (O4.2 opens from DU messages; O4.3 owns the lifecycle) — `open → waiting_borrower | waiting_third_party → satisfied_pending_review → cleared`; `waived`, `reopened`, `superseded`. Only `waiting_borrower` items are actionable by the borrower; `waiting_third_party` and `open` items appear under **What we're doing** with the owner label (*us* / *the title company* / *the appraiser* / *your current servicer*).
- `document_requests` (O3.1) — created from DU/underwriter conditions that need a document; each carries `document_class`, `freshness_hint`, `due_at` (`SM_NEEDS_LIST_BORROWER_RESPONSE_5`).
- Pending consents, confirmations, connectors, acknowledgments, schedules (02 §1.3).

Rendering rules: one line per item, verb first ("Connect your bank", "Upload your homeowners policy", "Explain the Capital One inquiry from Sept 30"), due date if any, an action chip that opens the card. The count in the status strip is `count(owner=you)`. Zero items renders the **nothing needed** state ("Nothing needed from you. We'll message you when something is.").

## 2. Documents and the needs-list loop (O3.1)

### 2.1 Requests
`NTC_SM_NEEDS_LIST` is the notice of record for a new set of borrower items; the Thread renders it as the `ChecklistCard` (not a separate letter) and the Documents section keeps the rendered notice. Reminders (`NTC_SM_NEEDS_LIST_REMINDER`) follow 01 §6.4 cadence; each reminder repeats the deep link to the checklist. Internal review SLA `SM_NEEDS_LIST_REVIEW_1BD` is invisible.

### 2.2 Upload
`UploadCard{document_class, accepted_examples, freshness_hint}`: camera or file; multi-page; PDF/JPG/PNG/HEIC. On `document.classified`:
- class matches → item `satisfied_pending_review` → the assistant confirms in one line; `cleared` when O4.3's auto-clear rule passes or the `underwriting_reviewer` clears.
- class mismatch → the card re-opens: "This looks like a {{detected}}; we need a {{expected}}" with examples.
- integrity failure (O3.1 integrity battery) → the item stays open with neutral copy ("we couldn't read this one — try a clearer photo or a PDF"); fraud-suspected documents route to O3.6 silently (never "this looks altered" to the borrower).
- freshness failure (`FNMA_B1_1_03_CREDIT_DOCS_4M`; paystub floor 30 days at application `FNMA_B3_3_2_01_PAYSTUB_30D_GATE`) → "this one is dated {{date}}; we need one from the last {{n}} days".

### 2.3 Freshness re-asks
When a closing date moves, O3.1's nightly sweep recomputes freshness against the new note date; items that will expire raise `SM_DOC_EXPIRY_WARN_14` → the Record's Dates row "a document is about to go out of date" and, at expiry, a new request with the reason ("closing moved to {{date}}, so we need a paystub from the last 30 days"). Connected sources (Truv, Plaid) refresh without asking; the borrower only hears when a connection has broken (`ConnectCard` → `failed` → reconnect).

### 2.4 Verbal verification of employment and the credit refresh
Invisible when connections are live: `FNMA_B3_3_1_04_VVOE_10BD` is satisfied inside the DU validation close-by window (`FNMA_B3_2_02_DU_CLOSE_BY_GATE`); the pre-closing credit refresh and undisclosed-debt monitoring (O3.2) run silently. Visible only on a finding:
- **New debt found** → `ConfirmCard` "We see a new account with {{creditor}} opened {{date}} (source: credit refresh). Is this yours?" → yes → liability added, DU resubmission (O4.1 tolerances) and the assistant states whether anything changes; no → O3.2 dispute/fraud path (SQ-14/15).
- **Employment change** → `ConnectCard` reconnect or `UploadCard{employment_offer|paystub}`; the copy never speculates about the decision.

## 3. Letters of explanation (SQ-02)

`ExplanationCard{subject, prompt, min_length}` per item; dictation allowed; rendered to `explanation_letter` / `inquiry_explanation` (O3.1 classes) with a typed-name attestation. Triggers: credit inquiries ≤ 90 days (O3.2), large deposits > 50% of monthly qualifying income (O3.4), employment gaps, address discrepancies, occupancy questions (O3.6). The prompt names the fact and asks one question ("Did this inquiry result in a new account? If so, what's the payment?"). Never asks *why* in a way that touches a prohibited basis (O2.1 rule 5).

## 4. Assets, gifts, earnest money (O3.4)

- `ConnectCard{plaid_assets}` when DU asks ("Funds Required to Close", "Reserves Required to be Verified") or on purchase from P7; `ConfirmCard` of accounts/balances; large-deposit `ExplanationCard`s; `UploadCard{gift_letter, gift_transfer_evidence}` for gifts; `UploadCard{emd_evidence}` once the contract exists.
- The Record's Numbers show **Verified funds** vs **Cash to close + reserves required** only as a pass/fail line ("verified funds cover your cash to close") — amounts appear in the LE/CD, not as an internal worksheet.
- Interested-party contribution limits (3/6/9%; 2% investment) and the LCOR cash-back cap are explained only when they bind (the assistant states the limit and the number).

## 5. Liabilities and DTI (O3.5)

The borrower never sees a DTI figure as a decision variable except inside a decision notice's specific reason ("debt-to-income of 53% exceeds the 50% maximum"). Debts to be paid at closing are a `ChoiceCard` per debt when the restructure loop proposes it ("paying off the {{creditor}} balance of {{money}} at closing changes your monthly obligations by {{money}} — include it?") → `debt_payoff_plans`; the settlement statement will show the payoff (O3.5 rule).

## 6. Identity and fraud follow-ups (O3.6)

Borrower-visible only as neutral requests: a second identity step (`ConnectCard{stripe_identity}` re-run or `UploadCard{passport|state_id}`), an occupancy confirmation (`ConfirmCard` "You'll live here as your primary home — correct?"), a fraud-alert contact confirmation (`FCRA_605A_H_ALERT_CONTACT_GATE`: the assistant calls or texts the number on the alert and asks the borrower to confirm the application). Never: "fraud", "red flag", "SAR".

## 7. The second borrower (SQ-19) — a first-class parallel flow

- `InviteCard{co_borrower}` from either party at any point before `intake_complete`. Creates the invitee's `parties` row, their own `conversations` row and a deep link; the inviter's Record shows People: "{{first name}} — invited, waiting".
- The invitee runs E2 (disclosure), E4 (L1), E5 (L3), E6 (their own consents), then **joint intent** first: `ConsentCard{joint_intent}` — "Do you intend to apply for this loan jointly with {{other first name}}?" — captured before any credit is ordered for them (`SM_O21_JOINT_INTENT_GATE`; O2.1 rule 4). Then R2–R6 for themselves (their income, their liabilities confirm, their ProfileCard, their declarations, their DemographicsCard). Assets can be shared accounts (Plaid connection by whichever party holds the login; the account is attributed to both when the statement shows both names).
- A **non-borrowing spouse** who only signs the security instrument is invited with `party_role=non_borrowing_spouse`, receives no credit questions (O2.1 rule 4), and appears at closing (07) with their own signing session.
- DU runs when every borrower's items are present; one score model for all (O3.2/O4.1 T11).
- Both threads receive the LE/CD `DocumentCard`s; a disclosure is electronic only to parties with active E-SIGN — the Record shows per-party delivery status (7.4 rule 4: mail to the non-consenting party satisfies the timer).
- The Record is shared; each party sees only `progress` booleans and first name for the other (02 §1.1).

## 8. Human agent

`human.request` from any card → `human.transfer.requested` → warm transfer with the full context; the Thread shows `PersonCard{human_agent}` and subsequent turns carry the human's name. Cards remain the only way to commit; a human agent can *send* cards but not resolve them for the borrower (baseline: "borrowers can self-serve on the portal regardless"; humans use the ops-console with the same validators).

## 9. Tests

- **T-05-01** Given a DU verification message opens a `conditions` row, then within `SM_DU_CONDITIONS_SLA_4H` it appears in Needed-from-you with owner *you* and a verb-first label.
- **T-05-02** Given an `UploadCard{paystub}` receives a W-2, then the item stays `waiting_borrower` and the card shows the mismatch copy with the detected class.
- **T-05-03** Given a paystub dated 40 days before the application date, then the freshness copy renders the 30-day rule and the request stays open.
- **T-05-04** Given the closing date moves from Nov 6 to Dec 15, 2026 and an asset statement would exceed 4 months at the new note date, then `SM_DOC_EXPIRY_WARN_14` shows in Dates and a re-request is created on expiry with the reason text.
- **T-05-05** Given the pre-closing credit refresh finds a new tradeline, then a `ConfirmCard` renders naming creditor and open date and nothing about the decision; a yes adds `application_liabilities` and triggers DU resubmission per O4.1 tolerances.
- **T-05-06** Given a large deposit of $9,000 against $8,200 monthly qualifying income, then an `ExplanationCard` is created for that deposit only.
- **T-05-07** Given a co-borrower invite, then a `credit.authorize` for the invitee is refused until `joint_intent` is affirmed by that invitee (`SM_O21_JOINT_INTENT_GATE`).
- **T-05-08** Given a non-borrowing spouse party, then no `ProfileCard`, `DemographicsCard`, income or liability card is ever created for that party.
- **T-05-09** Given borrower A has active E-SIGN and borrower B does not, then the LE is electronic to A (`DocumentCard`) and mailed to B; the Record shows both statuses; the LE timer is satisfied by the mailing to B.
- **T-05-10** Given a human agent is engaged, when the agent attempts to resolve a `ConsentCard` on the borrower's behalf, then the API refuses (`party_id` mismatch).
- **T-05-11** Given zero `owner=you` items, then the Record shows the nothing-needed state and the status strip count is 0.
