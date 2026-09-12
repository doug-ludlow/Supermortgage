# 01 — Foundations

Applies to every screen in files 03–10. Package: `borrower-app` (Next.js App Router, TypeScript 5.x, Node 22 — architecture baseline §2 / origination addendum §2). Absorbs the baseline's `borrower-portal`; there is one borrower surface.

## 1. Shell and layout

### 1.1 Regions
The shell has two regions and one persistent bar.

- **Thread** (left) — the conversation. Messages from the `intake` agent (pre-funding) or `borrower-comms` agent (post-funding) and from the borrower. *Amended by docs/ux/17 §2.1 (DELTA-26):* no card renders in the thread — a card's one home is the rail (right), and the thread carries a one-line **reference chip** that focuses and expands it there, plus the **confirm chip** of a proposed value (17 §3.4); no sender label, badge or timestamp row on every line (provenance is an aria/hover detail); the automation disclosure is the footer of every screen (17 §1 principle 8), never a line in the log. The thread is still the navigation: the borrower never opens a menu to do something; the platform puts the card on the rail and references it, or they ask.
- **Record** (right) — *amended by docs/ux/17 §2.2 (DELTA-26): the rail* — where the cards live: Progress (`journey_progress`), Needed from you (every pending card, current ask first, expanding in place to its component and resolving there), Connections, Documents (with the viewer and Confirm receipt), What we're doing, People, then Numbers · Dates · Property · Loan read-only from `borrower_record` (02 §1). Each section collapsible; never hand-authored per screen; sections show or hide by state (§4).
- **Action bar** (bottom of Thread) — text input, Send, and attach (document upload → O3.1 intake). *Amended by docs/ux/17 §1 principle 8 and §2.4:* no **Talk to a person** control while no person exists (a borrower who asks is answered in words; `human.request` stays reachable by the word), and the microphone arrives with voice (17 Phase 3).

### 1.2 Breakpoints
| Width | Thread | Record |
|---|---|---|
| ≥ 1280 | 58% | 42%, fixed, independently scrollable |
| 1024–1279 | 60% | 40% |
| 768–1023 | 100% | Drawer from the right, opened by the status strip |
| < 768 (mobile) | 100% | **Status strip** pinned under the header (status badge · next event · "N needed from you") → tap opens the Record as a bottom sheet |

### 1.3 Thread behavior
- **Current ask.** *Amended by docs/ux/17 §2.1–2.2:* the current ask is the first row of the rail's Needed from you, expanded by default; a slim "Waiting on you: {{label}} →" line appears under the header only while the borrower has scrolled away from its reference in the thread. Over a 45-day purchase file the thread is long; the borrower must never scroll to find what is waiting on them.
- **Cards are stateful.** A card renders from `card_instances` (02 §1.6) and updates in place when its state changes (e.g., `ConnectCard` → `connected`; `DocumentCard` → `received`). Resolved cards collapse to a one-line receipt ("Loan Estimate received Oct 22, 2026 9:41 AM").
- **Grouping.** Consecutive system messages within 60 seconds group under one timestamp. Cards never group.
- **Day dividers** in the borrower's time zone.
- **Message provenance.** Every system message shows the sender: "Supermortgage" for the assistant (with the automation marker on the first message of each session — §7.1), the human's first name and role for `human_agent` / `mlo_of_record` turns, "Notice" for regulatory notice cards.
- **Streaming.** Assistant text streams; cards render only when complete and their evidence schema is satisfied.

### 1.4 Record behavior
- Sections render in a fixed order; a section with no data is hidden, not empty.
- Every dated item links to the thread message that produced it.
- Numbers update in place on the projecting event (`lock.executed`, `disclosure.cd.delivered`, `payment.posted` …) with a 300 ms highlight.
- The Record is read-only. Actions live in the Thread; a Record item that needs action deep-links to its pinned card.

### 1.5 Navigation
- Route `/` → the current conversation for the authenticated party. A party with multiple applications/loans (a purchase in progress and a serviced loan; both loans across a refinance) gets a switcher in the header keyed by `application_id` / `loan_id`; the Record follows the selection; the Thread is per party and shows all threads merged with the loan label on each message.
- Routes for external returns: `/return/{vendor}/{card_instance_id}` (Stripe, Plaid, Truv, RON), `/d/{deep_link_token}` (SMS/email deep links — §6.5), `/doc/{document_id}` (document viewer, authenticated).
- No dashboard, no settings tree. Preferences (contact permissions, e-delivery, language, autopay) are cards the borrower can request ("change my autopay day") and that the platform offers when relevant.

## 2. Theme — dark (default)

Design tokens (CSS variables; Tailwind theme extension). Light theme is a second token set only.

```
--sm-bg:            #0A0A0B   /* app background */
--sm-surface:       #141416   /* thread, record panels */
--sm-surface-2:     #1C1C1F   /* cards */
--sm-surface-3:     #24242A   /* card inner blocks, inputs */
--sm-border:        #2A2A2E
--sm-border-strong: #3A3A40
--sm-text:          #F5F5F7
--sm-text-2:        #C7C7CC   /* secondary */
--sm-text-3:        #8E8E93   /* muted, timestamps */
--sm-accent:        #FF3B30   /* brand; primary actions */
--sm-accent-hover:  #FF544A
--sm-accent-press:  #E0342A
--sm-on-accent:     #FFFFFF
--sm-positive:      #34C759   /* completed, in your favor */
--sm-caution:       #FF9F0A   /* needs attention, deadlines within 3 days */
--sm-info:          #0A84FF   /* neutral status */
--sm-focus:         #FF3B30 with 3px outline offset 2px
```

Rules:
- Primary CTA = accent fill, `--sm-on-accent` text. One primary action per card.
- Money and rates in `font-variant-numeric: tabular-nums`; type scale 13/15/17/22/28/36; system font stack (Inter if bundled).
- Status colors are never the only carrier of meaning: every status has an icon and a text label.
- Contrast: all text ≥ 4.5:1 against its surface; `--sm-text-3` is used only for timestamps and helper text ≥ 15px.
- The pixel-art neighborhood motif from the brand work is reserved for empty states and the marketing landing; never on cards that carry numbers or legal content.
- Motion: 150–250 ms ease-out; respects `prefers-reduced-motion`.

## 3. Component library — cards

Every card is a typed message block with the shape below. Cards are the **only** way the borrower commits anything. A card's `evidence` object is persisted to `ui_events` (§9) and, where the build spec requires, to the domain table named in `commits_to`.

```ts
type CardBase = {
  card_instance_id: uuid;
  conversation_id: uuid;            // per party (§6.1)
  party_id: uuid;                   // the borrower this card is for
  subject: { application_id?: uuid; loan_id?: uuid };
  kind: CardKind;
  status: 'pending' | 'resolved' | 'expired' | 'superseded' | 'cancelled';
  created_by: 'agent:intake' | 'agent:borrower-comms' | 'agent:disclosure' | 'agent:verification' | 'agent:underwriter' | 'agent:title-closing' | 'agent:escrow' | 'agent:cashiering' | 'agent:pmi' | 'agent:insurance-property' | 'agent:default-collections' | 'agent:lossmit-underwriter' | 'agent:payoff-release' | 'human:{role}' | 'system';
  copy_key: string;                 // 12-message-copy-library
  expires_at?: timestamptz;         // rendered as a countdown when < 72h
  evidence?: object;                // persisted on resolve
};
```

### 3.1 StatusCard
Purpose: tell the borrower what just happened and what happens next. Props: `state_label`, `next_event_label`, `next_event_at?` (from `timers.due_at`, allow-listed codes only), `detail`. No action. Emitted on state transitions listed in each file's **Events** table.

### 3.2 ChoiceCard
Purpose: a decision with 2–4 mutually exclusive options. Props: `options[{id, label, sublabel?, is_primary?}]`, `command`, `command_args_by_option`. Resolves on tap → issues the command → `evidence = {option_id, tapped_at, disclosure_version_shown}`. Used for: proceed (04), lock/float (04), offer response (09), escrow shortage election (08a), MI plan (06), counteroffer accept/decline (06). A ChoiceCard **never** captures a consent (see ConsentCard).

### 3.3 ConfirmCard
Purpose: present a fact the platform already holds and take the borrower's explicit confirmation — the O2.1 rule-1 event that turns a prefilled item into a *submitted* item. Props: `fields[{path, label, value, source}]` where `source ∈ {stripe_identity, credit_report, payroll_connection, asset_report, public_records, avm, recorded_instrument, prior_application, servicing_record}`, `commits_to` (e.g., `application_income`, `application_properties.estimated_value`, `applications.loan_amount_sought`). Actions: **Confirm** (primary) / **Edit** (opens inline fields). Evidence: `{fields[{path, value_confirmed, source, confirmed_at}], edited: boolean}`. The confirm event is what O2.2's six-item detector reads (`trid_items[k].present = true` at confirmation).

### 3.4 ConnectCard
Purpose: launch a vendor SDK and report its outcome. Props: `vendor ∈ {stripe_identity, plaid_assets, truv_income, irs_ives, carrier_connect}`, `purpose_text`, `what_we_get[]` (plain-language list of the data classes), `fallback` (upload path — always present). States: `not_started → in_progress → connected | failed | fallback_chosen`. Resolves on the vendor webhook (`verification.received{kind}`, `credit.authorization.captured`, identity events) — never on the SDK's client callback alone. Evidence: `{vendor, vendor_session_id, started_at, completed_at, outcome}`. A ConnectCard for `truv_income` or `plaid_assets` is created only after `intent.to_proceed.received` **or** with `fee_paid_by=sm` and no fee to the borrower (O2.4 fee gate applies to fees, not to free data connections; documents may still not be *required* before the LE — the card copy says "optional now, saves paperwork later" pre-LE and becomes a needs-list item post-intent).

### 3.5 ConsentCard
Purpose: capture a legally sufficient consent or authorization. Props: `consent_kind ∈ {esign, credit_authorization, tcpa_voice, tcpa_sms, ai_disclosure_ack, irs_estatement, autodraft_authorization, joint_intent, blanket_verification_authorization}`, `disclosure_version_id` (from `consent_disclosure_versions`), `scope[]` (E-SIGN classes), `affirmation_method` per kind:
- `esign` → `checkbox_with_text` + typed name → status `consented_pending_verification`; then the **demonstration test** runs out-of-band (verification email with link + PDF token, 7.4 rule 2); the card shows `pending verification — check your email` until `consent.esign.verified` → `active`. The card explicitly says a spoken or chatted yes does not count.
- `credit_authorization` → `checkbox_with_text` + typed name; evidence includes the authorization text hash (O1.3 audit).
- `tcpa_voice` / `tcpa_sms` → `checkbox_with_text` with the exact PEWC language and the phone number; `purpose` recorded; SMS confirmed by double opt-in (`NTC_TCPA_CONSENT_CONFIRMATION`).
- `joint_intent` → per-borrower affirmation (§1002.7(d)) captured before any credit is ordered for that borrower; never inferred from the other borrower.
- `autodraft_authorization` → renders every Nacha/Reg E element (2.x rule 1), `checkbox_with_text` + typed name; a copy is delivered within 1 BD (`AUTODRAFT-CONFIRM-v1`).
- `ai_disclosure_ack` → single tap; logged per session (§7.1).
Evidence: `{consent_kind, disclosure_version_id, method, text_hash, ip, user_agent, affirmed_at, party_id}`. Voice channel: the card is *sent* (link) but never *resolved* by voice.

### 3.6 DocumentCard
Purpose: deliver a disclosure or document and capture receipt. Props: `document_id`, `disclosure_id?`, `notice_code?` (e.g., `NTC_REGZ_1026_37_LE`), `title`, `why_you_see_this` (one sentence), `requires_ack: boolean`, `esign_scope_required`. Renders a viewer (PDF, in-app, `/doc/{document_id}`) and, when `requires_ack`, **Confirm receipt** → `disclosure.*.received{receipt_evidence=esign_confirmed, received_at}`. Channel guard: the card is created only if `consents{kind=esign, scope∋class, status=active}` exists for this party; otherwise the platform emits a `StatusCard` "mailed on [date]" and the document appears in the Record only after `mailed_at` with the label *Mailed*. Post-consummation corrected CDs and adverse-action letters follow the same rule.

### 3.7 ComparisonCard
Purpose: a multi-option numeric choice rendered as columns. Props: `columns[{id, title, rows[{label, value, emphasis?}], footnote?}]`, `recommended_id?`, `command`. Rows carry pre-formatted values from the projection (APR, payment, total in 5 years, lock period, expiry, MI monthly, points). Used for: lock options (04), MI plans (06), escrow shortage (08a), refinance offer detail (09). Resolves like a ChoiceCard. Renders **in the Record** on ≥1024 (Thread shows a stub "see options →") and inline on mobile.

### 3.8 ChecklistCard
Purpose: the needs list / conditions with owners. Props: `items[{condition_id, label, owner ∈ {you, us, third_party}, status ∈ {open, waiting_borrower, waiting_third_party, satisfied_pending_review, cleared, waived, reopened}, due_at?, action?: {kind: 'upload'|'connect'|'explain'|'schedule', card_kind}}]`. Items with `owner=you` are actionable; each opens its own card. Source: `conditions` (O4.2/O4.3) plus `document_requests` (O3.1). Persistent in the Record as **Needed from you**.

### 3.9 UploadCard
Purpose: document upload when a connector is not available or a specific document is required. Props: `document_class` (O3.1 `document_classes.code`), `accepted_examples[]`, `why`, `freshness_hint` (e.g., "dated within the last 30 days"). Camera capture on mobile. Resolves on `document.classified` for the expected class; a mismatch re-opens with "this looks like a [class]; we need a [class]".

### 3.10 ExplanationCard
Purpose: letters of explanation (inquiries, large deposits, gaps, addresses). Props: `subject` (e.g., inquiry by creditor X on date Y; deposit of $Z on date), `prompt`, `min_length`. Text or dictated (transcribed) → rendered as a signed `explanation_letter` / `inquiry_explanation` document (O3.1 classes) with typed-name attestation. Evidence: text hash, attestation.

### 3.11 ScheduleCard
Purpose: pick a time window. Props: `purpose ∈ {appraisal_access, pdc_access, ron_session, callback}`, `slots[]` (from the AMC / RON platform / telephony), `constraints_text`. Resolves → `valuation.inspection.scheduled` / `closing.scheduled` / callback row.

### 3.12 PaymentCard (servicing)
Purpose: one-time payment, extra principal, or autopay change. Props: `amount_default_cents`, `amount_editable`, `date_options` (within `due_date + grace_days`, 2.x rule 3), `accounts[]` (masked last 4), `add_account` (routing/account fields + validation state). Never shows a full account number. One-time → `payment.receive{channel=portal}`; autopay → `autodraft.change.requested`. The "include late charge" option appears only when the enrollment elected it.

### 3.13 InviteCard
Purpose: add a second borrower or another party. Props: `party_role ∈ {co_borrower, non_borrowing_spouse, poa, authorized_third_party}`, contact fields. Creates the party's own conversation and sends their invitation; the Record shows "waiting on [name]". The inviter never answers for the invitee.

### 3.14 HandoffCard
Purpose: a step that happens outside the app. Props: `destination ∈ {ron_platform, settlement_agent, appraiser, notary_wet, prior_servicer, fannie_mae_letter}`, `what_to_expect`, `return_state`. Used for the RON session (07), the Fannie Mae ownership letter heads-up (07), the prior servicer's escrow refund (07).

### 3.15 OfferCard (servicing → origination)
Purpose: the refinance offer. Props (all from `refi_opportunities` and `pricing_quotes`): `current_rate`, `offered_rate`, `apr`, `new_pi_payment_cents`, `monthly_savings_cents`, `costs_to_borrower_cents` (program default 0), `lender_legal_name`, `mlo_name`, `mlo_nmlsr_id`, `expires_at` (`SM_REFI_OPPORTUNITY_EXPIRY_30`), `not_a_commitment_text`, `rates_change_daily_text`. Options: **Yes** → `lead.created` + conversion; **Not now** → `refi.opportunity.declined` (opens `SM_REFI_RESOLICIT_COOLDOWN_90`); **Never** → marketing consent revoked for proactive offers (`consents{purpose=marketing}` → revoked; borrower-initiated path stays open). Copy is the O1.2 creative verbatim structure (§7.4).

### 3.16 NoticeCard
Purpose: a regulatory notice that is not a disclosure in the TRID sense (adverse action, NOIA, counteroffer, early-intervention notice, escrow statement, ARM notice, force-placed insurance notice, PMI disclosures, payoff statement, RESPA acknowledgment). Always paired with the rendered document (`notices.rendered_document_id`) and the plain-language summary the build spec's template checklist requires. Never editable, never summarized by the assistant beyond the template's own plain-language block.

### 3.17 PersonCard
Purpose: introduce a human the borrower will deal with. Props: `role ∈ {mlo_of_record, human_agent, notary, settlement_agent, continuity_of_contact_team, appraiser}`, `name`, `credentials` (NMLSR ID for the MLO; commission state for the notary), `reach` (direct number for the 4.3 team). Emitted on `escalation.opened{role=mlo_of_record}` resolution, `human.transfer.completed`, `closing.scheduled`, `continuity.assigned`.

### 3.18 ProfileCard
Purpose: the URLA 1a facts that only the borrower can supply. Props: `fields[{path, label, options[] | input, required: true}]` — citizenship (U.S. citizen · permanent resident · non-permanent resident), marital status (married · unmarried · separated), dependents (count, ages), military service (URLA Section 7 as written), language preference (Form 1103 SCIF with the form's statement; blank → `not_answered`). No visual default counts as an answer; each field needs a tap. Evidence: per-field `{path, value, answered_at}`. Never asks anything §1002.5 prohibits (O2.1 rule 5). Commits to `application_borrowers`.

### 3.19 DemographicsCard
Purpose: the Reg C Appendix B / Reg B §1002.13 request. Props: `collection_method ∈ {internet, telephone, video}`, `statement_text` (the prescribed instruction-2 statement), sections ethnicity / race (multi-select with disaggregated sub-categories) / sex, each with **I do not wish to provide**. Available only when `applications.status ≥ started` (O1.3 T12). Commits to `applicant_demographics` (restricted; write-once; never read back into the UI). Evidence: `{collection_method, answered_at}` only — values are not copied to `ui_events`.

## 4. Record pane — sections and sources

Rendered from `borrower_record` (02 §1.1). Order fixed; sections hide when empty.

| # | Section | Content | Source |
|---|---|---|---|
| 1 | **Header** | Property address (or "Property to be determined"), purpose (Buying · Refinancing · Your loan), loan label | `application_properties`, `applications.transaction_type`, `loans` |
| 2 | **Status** | Badge + one line ("Approved with conditions — 3 things needed from you") | state catalogue per file |
| 3 | **Next** | Next event label + `due_at` for the earliest allow-listed timer (02 §4) | `timers` |
| 4 | **Needed from you** | Count + list; each item opens its pinned card | `conditions` (`waiting_borrower`), pending `ConsentCard`s, pending `ConfirmCard`s, `ConnectCard`s not connected, `document_requests` |
| 5 | **Numbers** | Pre-funding: rate, APR, payment (P&I; escrow when known), loan amount, cash to close (purchase) or monthly savings (refi), lock status and expiry. Post-funding: balance, next payment amount and date, escrow balance, rate | `pricing_quotes`, `locks`, `disclosures{le|cd}` figures, `loan_terms`, `escrow_accounts` |
| 6 | **Dates** | Allow-listed timers with labels: LE arrives by · CD in hand by · closing · cancel window ends · funding · first payment · lock expires · appraisal access · payment due · escrow analysis · PMI ends | `timers` |
| 7 | **Documents** | Every disclosure/notice/document with status (*Received Oct 22* · *Mailed Oct 22* · *Pending*); viewer links | `disclosures`, `notices`, `documents` |
| 8 | **People** | Each borrower with per-party progress (consents, confirmations, signatures); `mlo_of_record` name + NMLSR ID; notary; settlement agent; in servicing the 4.3 team with its direct number | `application_borrowers`, `parties`, `mlo_reviews`, `closings`, continuity assignment |
| 9 | **Property** | Type, units, occupancy, valuation status (*No appraisal needed* · *Appraisal scheduled Nov 3* · *Appraisal received*), flood zone status, insurance status, HOA | `application_properties`, `valuation_orders`, `appraisals`, flood/hazard states, `project_reviews` |
| 10 | **Loan** (servicing) | Autopay status and next draft, escrow lines (taxes, insurance, MI) with next disbursement, PMI status and projected end, ARM next change, year-end documents | `autodraft_enrollments`, `escrow_lines`, `mi_policies`, ARM notice states, 1098 status |

**Status badge catalogue** (label ← state): "Getting started" ← `leads.status ∈ {new, disclosed, authenticated, exploring}` · "Prequalified" ← `prequalified` · "Preapproved" ← preapproval letter issued (03) · "Application received" ← `applications.status = received | trid_received` · "Loan Estimate sent" ← `le_issued` · "Ready to proceed" ← `le_received` ∧ no `intent_records.valid` · "Rate locked" ← `locks.status ∈ {executed, confirmed}` · "Rate floating" ← no active lock after intent · "Verifying" ← decision sub-status `underwriting_pending` · "Approved with conditions" ← `conditionally_approved` · "Counteroffer" ← `counteroffered` · "What's missing" ← `suspended` · "Clear to close" ← `clear_to_close` · "Closing scheduled" ← `closings.status = scheduled | package_released | pre_session_checks_passed` · "Signed" ← `signed | notarized | sealed | execution_reviewed` · "Cancel window" ← rescission `running` · "Funding" ← `fundings.status ∈ {authorized … funds_at_agent}` · "Funded" ← `disbursed` · "Your loan" ← `loans.boarding_status = active` · "Current / Payment due / Past due / Behind" ← servicing account states (08a) · "Paid off" ← `paid_in_full` · "Closed" ← terminal · "Decision letter sent" ← `denied` · "Withdrawn" ← `withdrawn`.

## 5. Identity and authentication

| Level | How | Unlocks |
|---|---|---|
| **L1** | Phone or email one-time code; passkey optional after first login | Conversation, general information, published rate ranges, the marketing landing's numbers |
| **L2** | L1 + SSN last 4 + DOB matched to the credit header on the soft pull, **or** L3 | Personal terms (after MLO review), soft pull, existing-loan facts, the Record for an application |
| **L3** | Stripe Identity: government ID document + selfie; extracted name/DOB/address written to `application_borrowers` as `source=stripe_identity` pending confirmation; satisfies `SM_IDENTITY_IAL2_GATE` (O3.6) | Hard credit pull, DU, e-signature of the 1003, everything through funding |
| **L4** | Inside the RON platform: credential analysis + KBA per state RON statute (O7.2 `signing_sessions.identity_proofed`) | Notarial acts. Not performed by `borrower-app`; recorded from the platform's audit trail |

Rules: sessions expire after 30 minutes idle pre-funding, 7 days with passkey in servicing; any money movement (payment, autopay change, payoff wire instructions view) requires a fresh L1 code within 10 minutes; PII in the Record is masked (SSN ••••1234, account ••••4417) with a reveal that requires fresh L1. Deep links (§6.5) never reveal loan data before L1. A co-borrower's L1–L3 are their own; no party ever authenticates for another. Successors, POAs and authorized third parties are `parties` with their own credentials and a `party_role` that scopes the Record (4.4; 02 §6).

## 6. Channels and continuity

### 6.1 Conversation model
`conversations` (UI-owned, 02 §1.6): one per `party_id`; messages reference `subject.application_id | loan_id`. The same conversation continues across origination and servicing and across refinances (the old and new loan both appear, labeled). Origination interactions are also written to `lead_interactions` (O1.3) and, after funding, every borrower contact is a `contacts` row (4.x/11.x) — the UI writes both through the `borrower-comms` API, never directly.

### 6.2 Channels
- **In-app thread** (web/mobile web) — full card set.
- **SMS** — outbound only with `consents{kind=tcpa_sms}` (informational for servicing notices; marketing PEWC for offers — O1.2); inbound always accepted. Every outbound SMS carries a deep link (§6.5). STOP revokes immediately (7.4 rule; 11.1 `TCPA_64_1200_A10_REVOCATION_HONOR_10BD`).
- **Email** — CAN-SPAM footer on marketing; transactional emails for e-delivery availability (7.4 rule 9), E-SIGN verification, and deep links.
- **Voice, inbound** — phone number and in-app call button, both via the `telephony/voice` adapter; automation disclosure first; "human" at any time.
- **Voice, outbound AI** — only with `consents{kind=tcpa_voice}`; informational purpose for servicing (11.1 gate), marketing PEWC for offers (O1.2 `TCPA_64_1200_A2_PEWC_GATE`); quiet hours 09:00–20:00 borrower local (O1.2). Never for consents.
- **Mail** — the fallback for every disclosure and notice without active E-SIGN; the Record shows *Mailed [date]*.

### 6.3 In-app voice
WebRTC session to the same agent with the same memory; live transcript in the Thread (turns marked *voice*); cards sent during a call appear in the Thread and resolve by tap, never by speech. The call header shows the automation marker and **Talk to a person**.

### 6.4 Continuity rules
- Every outbound message (any channel) about a pending card includes the deep link to that card.
- A card resolved on one channel resolves everywhere (single `card_instances` row).
- If a borrower replies by SMS with content that answers a pending `ConfirmCard`, the assistant does **not** treat it as confirmation; it replies with the deep link ("tap to confirm so it counts").
- Reminders for `waiting_borrower` items: day 2 (in-app + email), day 5 (SMS if consented, else email), day 9 (voice if consented, else human callback offer) — cadence from O3.1 needs-list SLAs (`NTC_SM_NEEDS_LIST`, `NTC_SM_NEEDS_LIST_REMINDER`); servicing reminders follow 7.1/11.x cadences instead.

### 6.5 Deep links
`deep_links` (UI-owned): `{token, party_id, target: {card_instance_id | document_id | route}, expires_at (7 days), single_use: false}`. Resolution: `/d/{token}` → L1 code (or existing session) → route. Tokens never encode loan data.

## 7. Copy rules

### 7.1 Automation disclosure
First assistant message of every session, every channel: "I'm Supermortgage's automated assistant, working for {{partner.legal_name}}, your lender. You can reach a person at any time — just say *human*." Logged as `lead.disclosure.delivered` / `consent.ai_disclosure.acknowledged`. On "are you a real person?" → "No — I'm {{partner.legal_name}}'s automated assistant. I can bring a person in right now if you'd like." (O1.3 T11). Colorado consumers on/after Dec 1, 2026 receive the SB 26-189 pre-use notice line before any pricing output (O1.3 Q4).

### 7.2 Plain language
Grade-8 reading level (4.1 guardrail applies to responses; adopted UI-wide). One idea per sentence. Numbers before adjectives. Every legal term gets a parenthetical the first time in a session ("APR (the yearly cost including fees)").

### 7.3 Forbidden and required phrasings
- Never: "you don't qualify", "you would be denied", "you cannot get", "guaranteed", "pre-approved" (unless a preapproval letter has actually issued), "no cost" (say "no lender fees and no closing costs charged to you; Supermortgage pays them and they're reflected in the rate" — O1.2 worked example), "skip a payment".
- Never present a rate or payment as personal before `mlo.review.completed{approved}` (O1.3 `terms_review`); general ranges use the published rate sheet form: "today's 30-year fixed rates for this program range from X% to Y% (APR …) depending on credit and loan-to-value".
- Every personalized terms message names `mlo_of_record` and NMLSR ID; every rate-bearing message includes "not a commitment to lend; rates change daily" and the lender's legal name (Reg Z §1026.24; MAP).
- Business-day statements name the calendar: "3 business days (Sundays and federal holidays don't count)" for Reg Z specific; "business days" for creditor; "days, excluding weekends and holidays" for 4.1/4.2 federal.

### 7.4 Tokens
`{{partner.legal_name}}`, `{{partner.nmlsr_id}}`, `{{mlo.name}}`, `{{mlo.nmlsr_id}}`, `{{borrower.first_name}}`, `{{money(x)}}`, `{{rate(x)}}`, `{{date(x)}}`, `{{count}}`. All copy lives in 12-message-copy-library keyed by event; the UI never hard-codes sentences.

## 8. Accessibility and language

WCAG 2.2 AA. Every card is keyboard-operable with visible focus; cards announce state changes via `aria-live=polite`; timers render as text and `<time>`; PDFs have text layers (baseline: Handlebars → HTML → PDF). Language preference from `application_borrowers.language_preference` (Form 1103 SCIF) drives UI locale where available (English at launch); when the borrower's language isn't supported, the assistant offers a human interpreter line (4.3 escalation) and never machine-translates a disclosure.

## 9. Telemetry and evidence

`ui_events` (UI-owned, append-only): `{ui_event_id, party_id, session_id, conversation_id, card_instance_id?, kind ∈ {card_shown, card_resolved, document_opened, document_scrolled_to_end, consent_affirmed, connector_started, connector_completed, deep_link_opened, voice_started, human_requested}, at, ip, user_agent, disclosure_version_id?, payload}`. Domain evidence is written by the command handler into the owning table (`consents`, `intent_records`, `disclosures.receipt_evidence`, `credit_authorizations`, `condition_clearances`, `contacts`); `ui_events` is the corroborating trail. Retention follows the owning record's class (O12.3 / 19.x). No analytics vendor receives PII; product analytics use `party_id` hashes.

## 10. Degraded modes

- **Vendor down** (Stripe/Plaid/Truv): `ConnectCard` → `failed` with `UploadCard` fallback and the copy "we'll take documents instead"; retry offered on recovery.
- **AI path off** (`case.ai_path=off` or origination equivalent): the Thread continues with `human_agent` turns; cards unchanged; the Record unchanged.
- **DU / Fannie Mae outage**: no borrower-visible error; `StatusCard` "we're waiting on a system we don't control; nothing needed from you"; timers still render.
- **Offline / poor connection**: cards queue locally with an *unsent* marker; a consent or payment never shows as done until the server acknowledges.
- **E-SIGN suspect** (bounce): the Record flips the document to *Mailed*; the Thread offers re-verification (7.4 rule 8).
