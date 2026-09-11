# 32.7 — CD, closing, rescission, funding, boarding

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | c — the borrower confirms CD receipt, picks the signing slot, signs on the RON platform (L4, outside the app), may exercise rescission; `officer` accepts a rescission waiver; `funding_approver` authorizes funding |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | On `disclosure.cd.*`; on every `closings`, `signing_sessions`, rescission, `fundings` and boarding state change |
| Governing source | Projection of sections 25.2 (CD), 25.3 (rescission), 25.4 (closing-time and post-closing notices), 26.1 (closing documents), 26.2 (signing — RON/IPEN/hybrid/wet, eNote), 26.3 (funding), 26.4 (recording, MERS, custody, trailing documents), §27 (warehouse — invisible), 30.2 (boarding), 30.3 (escrow at closing), 30.4 (hand-off to servicing). |
| Key deadlines | renders `SM_O62_CD_TARGET_4SBD`, `REGZ_1026_19F1_CD_3SBD_GATE`, `REGZ_1026_19F1III_CD_MAILBOX_3SBD`, `REGZ_1026_23_RESCISSION_3SBD_GATE`, `SM_O73_POST_RESCISSION_FUNDING_1BD`, `FNMA_B2_1_5_FIRST_PAYMENT_2M`, `SM_O64_FIRST_PAYMENT_LETTER_5BD`, `REGX_1024_17G_INITIAL_STMT_45`, `REGZ_1026_39_OWNERSHIP_NOTICE_30` (owned by 25.x / 26.x / 30.x) |
| Timers | — |

### Blueprint row
Projection of sections 25.2 (CD), 25.3 (rescission), 25.4 (closing-time and post-closing notices), 26.1 (closing documents), 26.2 (signing — RON/IPEN/hybrid/wet, eNote), 26.3 (funding), 26.4 (recording, MERS, custody, trailing documents), §27 (warehouse — invisible), 30.2 (boarding), 30.3 (escrow at closing), 30.4 (hand-off to servicing).. Owner specs: 25.2 (CD), 25.3 (rescission), 25.4 (closing-time and post-closing notices), 26.1 (closing documents), 26.2 (signing — RON/IPEN/hybrid/wet, eNote), 26.3 (funding), 26.4 (recording, MERS, custody, trailing documents), §27 (warehouse — invisible), 30.2 (boarding), 30.3 (escrow at closing), 30.4 (hand-off to servicing). (Imported from docs/ux/07-cd-closing-rescission-funding-boarding.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 07 is 32.7 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections 25.2 (CD), 25.3 (rescission), 25.4 (closing-time and post-closing notices), 26.1 (closing documents), 26.2 (signing — RON/IPEN/hybrid/wet, eNote), 26.3 (funding), 26.4 (recording, MERS, custody, trailing documents), §27 (warehouse — invisible), 30.2 (boarding), 30.3 (escrow at closing), 30.4 (hand-off to servicing).** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: none beyond 32.2's list; the RON platform is a `FAKE` in every build stage.

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- On `disclosure.cd.*`; on every `closings`, `signing_sessions`, rescission, `fundings` and boarding state change. Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.

#### Data model
No UI-owned table is declared here (32.2 declares the seven UI-owned tables).
- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): `jurisdiction_rules`, `servicing_handoffs`.
- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.

Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list's): `REGZ_1026_19F1_CD_3SBD_GATE` (25.2), `REGZ_1026_19F2_CORRECTED_CD_30` (25.2), `REGZ_1026_19F4_SELLER_CD_GATE` (25.2), `TX_50A6_ITEMIZATION_1BD_GATE` (26.1), `SM_O72_RON_STATE_AUTH_GATE` (26.2), `SM_O72_ESIGN_CONSENT_CLOSING_GATE` (26.2), `TX_50A6_12DAY_CLOSING_GATE` (26.1), `TX_50A6_RESCISSION_3D_GATE` (26.1), `SM_O72_PAPER_FALLBACK_5BD` (26.2), `REGZ_1026_23_RESCISSION_3SBD_GATE` (25.3), `REGZ_1026_23D2_RESCISSION_REFUND_20` (25.3), `SM_O73_POST_RESCISSION_FUNDING_1BD` (26.3), `SM_O73_WET_FUNDS_AT_TABLE_GATE` (26.3), `FNMA_B2_1_5_FIRST_PAYMENT_2M` (26.3), `SM_ORIG_BOARD_T1BD` (30.2), `SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE` (30.2), `SM_O64_FIRST_PAYMENT_LETTER_5BD` (25.4), `SM_AUTODRAFT_COPY_DELIVERY_1BD` (2.3), `ESIGN_7001C_CONSENT_GATE` (7.4), `REGX_1024_17G_INITIAL_STMT_45` (3.1), `SM_ORIG_FIRST_STATEMENT_LEAD_15` (30.2), `REGZ_1026_39_OWNERSHIP_NOTICE_30` (25.4), `SM_ORIG_EPD_WATCH_P6_60` (30.4), `SM_ORIG_HANDOFF_CLOSE_90` (30.4).

Jurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### 1. Closing Disclosure (25.2)

CD version: `drafting → gated → delivered → received → waiting → consummation_ready → consummated → final | superseded`; post-consummation `corrected_post_consummation → delivered → final`.

| State | Thread | Record |
|---|---|---|
| `drafting`, `gated` | `StatusCard` "Preparing your Closing Disclosure — target {{SM_O62_CD_TARGET_4SBD.due_at}}" | Next: CD by |
| `delivered` (esign_portal) | `DocumentCard{NTC_REGZ_1026_38_CD, requires_ack=true, why: "Confirming receipt starts the three-business-day wait before you can sign (Sundays and federal holidays don't count)"}` + **What changed since your Loan Estimate** block (LE-vs-CD row diff, tolerance cures shown as lender credits) + the wire-fraud line (32.6 §4) | Documents; Numbers flip to `cd_v{n}`: rate, APR, payment, cash to close (purchase) or payoff/escrow/cash-out (refi) |
| `delivered` (mailed / e-mailed without confirmation) | `StatusCard` "Mailed {{date}}; it counts as received on {{REGZ_1026_19F1III_CD_MAILBOX_3SBD.due_at}} unless you confirm sooner" | Documents *Mailed*; Dates "counts as received on" |
| `received` (every required consumer) | receipt line | Dates: "earliest closing {{earliest_consummation_date}}" (`REGZ_1026_19F1_CD_3SBD_GATE`) |
| `waiting → consummation_ready` | closing `ScheduleCard` (§2) | badge "Clear to close" → "Closing scheduled" |
| `superseded` (redisclosure: APR beyond tolerance, product change, prepayment penalty added) | new `DocumentCard` with **What changed**; copy `cd.redisclosed_restart` ("this change restarts the three-day wait") | Dates recomputed |
| `corrected_post_consummation` (`REGZ_1026_19F2_CORRECTED_CD_30`, clerical `_60`) | `DocumentCard{NTC_REGZ_1026_38_CD_CORRECTED, requires_ack=false}` + refund line if any | Documents |

Rules: each consumer with a right to receive the CD gets their own card and receipt (co-borrower threads); a waiver of the three-day wait is offered **only** when the borrower states a bona fide personal financial emergency in their own words (25.2 `waiver` → `officer` acceptance) — never proposed by the assistant. Seller CD is the settlement agent's (`REGZ_1026_19F4_SELLER_CD_GATE`; invisible to the buyer beyond the settlement statement). The Texas 50(a)(6) itemization (`NTC_TX_50A6_ITEMIZATION`, `TX_50A6_ITEMIZATION_1BD_GATE`) rides with the CD.

##### 2. Scheduling the signing (26.2)

`closings.status`: `scheduled → package_released → pre_session_checks_passed → session_in_progress → signed → notarized → sealed → execution_reviewed → awaiting_funding → funded → recorded → complete`; `session_failed{reason} → rescheduled | converted_to_paper_path`; `voided`.

- **`ScheduleCard{ron_session}`** renders when: `clear_to_close`, `earliest_consummation_date` known, lock covers the date, flood notice (if any) delivered, appraisal copy delivered or waived. Slots come from the eClosing/RON platform; default `closing_type = ron` when `SM_O72_RON_STATE_AUTH_GATE` is open for the property state and the partner is eMortgage-approved; otherwise `ipen` (in-person electronic with the settlement agent), `hybrid` (paper note, electronic everything else) or `wet`. The card shows the type in one line and the fallback ("if the video session can't happen, you can sign on paper with the settlement agent").
- **Borrower declines electronic records** (A2-4.1-03) → `ChoiceCard` **Sign electronically** · **Sign on paper** → paper set, no eNote; loan still eligible.
- **Closing consent** — `closing.captureEsignConsent` (`SM_O72_ESIGN_CONSENT_CLOSING_GATE`) is a separate `ConsentCard{esign, scope=origination_esign_signatures + enote}` if the E6 consent did not include the eNote scope (26.2 owns eNote consent).
- **Pre-signing**: `HandoffCard{destination=ron_platform, what_to_expect}`: the non-notarized documents can be pre-signed from the day the package is released (`closing.documents.released`); the notarized set (note/eNote, security instrument, riders) is signed live with the notary; identity is proved inside the platform (credential analysis + KBA, or personal knowledge/credible witness where the state allows — SEL-2026-05); ~15–20 minutes; what to have ready (ID, a quiet room, the device requirements); who else must attend (co-borrower, non-borrowing spouse, POA signer). `PersonCard{notary}` and `PersonCard{settlement_agent}` when assigned.
- **Purchase**: the seller signs separately; cash to close goes to the settlement agent by wire with positive confirmation or cashier's check — never to Supermortgage, never from instructions received by e-mail (repeated on the card).
- **Texas 50(a)(6)**: wet-only at a title-company office; `TX_50A6_12DAY_CLOSING_GATE` and `TX_50A6_RESCISSION_3D_GATE` render as Dates; the FMV acknowledgment is in the package.

##### 3. The session and after (26.2)

`signing_sessions.status`: `created → consent_captured → identity_proofed → in_session → documents_signed → notarial_acts_complete → tamper_sealed → audit_trail_received → completed`; `failed{reason}`, `abandoned`.

| Event | Thread | Record |
|---|---|---|
| `pre_session_checks_passed` (T−1) | `StatusCard` "All set for {{time}} — join from this link" | badge "Closing scheduled" |
| `session_in_progress` | live status line | — |
| `signed` (`consummation_at` set when the note/eNote is fully signed) | `StatusCard` **signed**: refinance → "You have until midnight {{rescission.expires_at}} to cancel; funding on {{fundings.earliest_funding_date}}"; purchase → "Signed. Funds go out {{today/next business day}}" | badge "Signed"; Dates: cancel window ends · funding |
| `notarized → sealed → execution_reviewed` | nothing new | — |
| `session_failed{identity failure | outage | no-show | document defect}` | `StatusCard` neutral + `ScheduleCard` reschedule or `ChoiceCard` paper path (`SM_O72_PAPER_FALLBACK_5BD`) | badge unchanged |
| executed copies available | Documents section lists the executed note/eNote copy, security instrument, riders, CD final, rescission notice, HPA disclosure, initial escrow statement, first-payment letter, privacy (per 25.4 package) | Documents |

Package items the borrower can expect at signing (25.4 `gated`): the final CD, the rescission notice (refi — H-8/H-9), the HPA initial disclosure if MI, the initial escrow account statement (or its 45-day follow-up), the privacy notice if not yet delivered, state closing notices, the first-payment letter data (payee: Supermortgage, servicing on behalf of {{partner.legal_name}}). The assistant lists them the day before as a `StatusCard`, not as separate cards.

##### 4. Rescission (25.3)

States: `not_applicable | pending_consummation → running → expired_not_rescinded → funding_released`; `waived`; `rescinded → unwinding → closed`; `extended_3y`.

- `not_applicable` (purchase-money; not a principal dwelling; same creditor with no new advance): no cancel window anywhere. The Thread's signed message uses the purchase variant.
- `running`: `DocumentCard{NTC_REGZ_1026_23_H8 | H9, requires_ack=true}` (each consumer with the right receives two copies — the platform delivers the notice in the package and records receipt per consumer); badge "Cancel window"; Dates "cancel window ends midnight {{expires_at}}" (`REGZ_1026_23_RESCISSION_3SBD_GATE`; specific business days).
- **Cancel** — `rescission.exercise` is offered as a quiet link on the H-8/H-9 card ("How to cancel"), never as a primary button; it opens a `ChoiceCard` with a plain explanation of the consequences and a confirmation; on confirm → `rescinded → unwinding` (`REGZ_1026_23D2_RESCISSION_REFUND_20`: any money paid is returned within 20 calendar days) → the application becomes read-only with badge "Cancelled".
- **Waiver** (`waived`): only on the borrower's own written statement of a bona fide personal financial emergency; the assistant never suggests it.
- `expired_not_rescinded → funding_released` (`rescission.confirmed_not_rescinded`): `StatusCard` "Your cancel window ended. Funding is scheduled for {{date}}." `extended_3y` is internal unless a corrected notice must be delivered (then a `DocumentCard`).

##### 5. Funding (26.3)

`fundings.status`: `pending_conditions → conditions_met → authorized → advance_approved → wire_pending_release → wire_released → wire_accepted → funds_at_agent → disbursed`; `held{reason}`.

Borrower-visible: `authorized … funds_at_agent` collapse to badge "Funding" and a single `StatusCard` "Funding is in progress — expected {{fundings.earliest_funding_date}} (`SM_O73_POST_RESCISSION_FUNDING_1BD` for refinances)". `held{reason}` renders as "a final check is in progress" with the borrower asked something only if the hold is a borrower item (a re-signed document, a new insurance effective date). `disbursed` → `loan.funded`:

- **Refinance**: `StatusCard` `funded.refi` — "Funded. {{prior servicer}} is being paid off today. Your escrow balance with them is refunded by them within 20 days ({{REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD}} is their clock) — watch for it. Your first payment of {{money}} is due {{first_payment_date}}." (same-servicer refinances: 32.11 §6). Second lien: "your HELOC has been {{subordinated|paid off}}".
- **Purchase**: `StatusCard` `funded.purchase` — "Funded. Ownership is being recorded; keys through your settlement agent. First payment {{money}} on {{date}}." Wet-funded states (`SM_O73_WET_FUNDS_AT_TABLE_GATE`) show funding on closing day.
- Cash-out: the disbursement to the borrower is listed with the settlement agent as payer.
- First-payment rule: `FNMA_B2_1_5_FIRST_PAYMENT_2M` — the first payment date is never more than two months after disbursement; the assistant explains prepaid interest ("interest from {{disbursement}} to {{month end}} was collected at closing; there is no skipped payment").

Recording (`recording.submitted → recording.confirmed`), MERS registration, custody and trailing documents (26.4) are invisible; the recorded security instrument appears in Documents when `recording.confirmed`.

##### 6. Boarding and the first 90 days (30.2–30.4)

`loans.boarding_status`: `staged → validated → boarded → boarded_with_warnings → active` (`SM_ORIG_BOARD_T1BD`; `SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE`). On `loan.boarded` the Record switches to the servicing layout (32.8) with the label "Your loan"; the origination Record remains reachable under *Earlier* with all documents.

Sequence of borrower-facing items:
1. **First-payment letter** — `NoticeCard{NTC_SM_FIRST_PAYMENT_LETTER}` within 5 servicer business days of funding (`SM_O64_FIRST_PAYMENT_LETTER_5BD`) and ≥ 20 days before the first due date (`_PREDUE_20`): amount, due date, payee "Supermortgage, servicing on behalf of {{partner.legal_name}}", payment address and options, the FCRA §623(a)(7) model B-1 text (8.1), the E-SIGN enrollment invitation for servicing classes if not already active.
2. **Autopay** — `ConsentCard{autodraft_authorization}` (2.x rule 1 elements; draft day 1–16; fixed or variable; `SM_AUTODRAFT_COPY_DELIVERY_1BD`), preceded by the Reg E statement that autopay is optional and never a condition of the loan. Existing platform borrowers (32.11): the prior enrollment is `terminated` at payoff and a fresh authorization is required (2.x transfer rule applies to a new loan).
3. **E-delivery for servicing** — if E6's consent scoped servicing classes, `consents.boarded` carries it (`ESIGN_7001C_CONSENT_GATE`); otherwise the `ConsentCard{esign, servicing scopes}` is re-offered; statements are paper until `active`.
4. **Initial escrow statement** — `DocumentCard{NTC_REGX_1024_17G_INITIAL_ESCROW_STMT}` at settlement or within 45 days (`REGX_1024_17G_INITIAL_STMT_45`): monthly escrow, first-year disbursements, cushion; the Loan section shows escrow lines. Waived escrow: the election and state disclosures (`NTC_SM_ESCROW_ELECTION`, `NTC_UT_7_17_4_RESERVE_OPTIONS`, `NTC_CA_CIV_2954_IMPOUND_STMT` per `jurisdiction_rules`) as `DocumentCard`s.
5. **First statement** — before the first due date (`SM_ORIG_FIRST_STATEMENT_LEAD_15`), `NTC_REGZ_41_STMT_STD` as `DocumentCard` (electronic) or *Mailed*.
6. **Fannie Mae ownership letter** — `HandoffCard{destination=fannie_mae_letter}`: "Within about a month you'll get a letter from Fannie Mae saying it owns your loan. Nothing changes — you still pay Supermortgage." (`NTC_REGZ_1026_39_OWNERSHIP_TRANSFER` `expected → evidenced`; `REGZ_1026_39_OWNERSHIP_NOTICE_30`). If the borrower forwards the letter, `evidenced` is set from their upload.
7. **Nothing-needed state** — after items 1–6, the Record shows the servicing home; the first proactive message is "payment posted" on the first payment.

Invisible: investor setup (`investor_setup_status`), MI activation, tax/flood/insurance tracking activation, EPD watch (`SM_ORIG_EPD_WATCH_P6_60`), servicing hand-off checklist (`servicing_handoffs` → closed at `SM_ORIG_HANDOFF_CLOSE_90`). Boarding exceptions never surface; a payment received before `active` posts to suspense and the borrower's payment card shows *received* (2.2).

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
| 32.7-T1 | Given the CD e-mailed Mon Nov 2, 2026 without confirmation, then `deemed received` is Thu Nov 5 (specific business days) and `earliest_consummation_date` is Mon Nov 9; given confirmation Mon Nov 2, then `earliest_consummation_date` is Fri Nov 6 (25.2 fixture). |
| 32.7-T2 | Given an APR increase beyond tolerance after CD delivery, then a superseding CD card renders with `cd.redisclosed_restart` and Dates recompute. |
| 32.7-T3 | Given a co-borrower without active E-SIGN, then their CD is mailed and the `earliest_consummation_date` uses the later of the two receipt dates. |
| 32.7-T4 | Given `SM_O72_RON_STATE_AUTH_GATE` closed for the property state, then the `ScheduleCard` offers `ipen|hybrid|wet` and never `ron`. |
| 32.7-T5 | Given the borrower declines electronic records, then `closing_type = wet`, no eNote is built, and the Thread confirms the paper path. |
| 32.7-T6 | Given `signed` on a primary-residence refinance by a different creditor, then the H-8 card renders with `requires_ack`, Dates shows midnight of the third specific business day, and `disburse` is refused before `expires_at` (`REGZ_1026_23_RESCISSION_3SBD_GATE`). |
| 32.7-T7 | Given a purchase, then no rescission card or cancel window renders (`not_applicable`). |
| 32.7-T8 | Given the borrower opens "How to cancel" and confirms, then `rescinded → unwinding`, `REGZ_1026_23D2_RESCISSION_REFUND_20` is created, and the Record is read-only with badge "Cancelled". |
| 32.7-T9 | Given `fundings.status = held{reason=insurance_effective_date}`, then the borrower sees a single ask for the corrected effective date and no wire-status detail. |
| 32.7-T10 | Given `loan.funded` on Thu Nov 12, 2026 for a refinance, then the funded message names the prior servicer, the 20-day refund clock, and a first payment date ≤ Jan 12, 2027 (`FNMA_B2_1_5_FIRST_PAYMENT_2M`). |
| 32.7-T11 | Given `loan.boarded`, then `NTC_SM_FIRST_PAYMENT_LETTER` is sent within 5 servicer business days and the Record shows the servicing layout; the autopay `ConsentCard` includes every 2.x rule-1 element and the optional statement. |
| 32.7-T12 | Given E6 consent scoped only `origination_disclosures`, then the first statement is paper and a servicing-scope `ConsentCard` is offered. |
| 32.7-T13 | Given `loan.purchased`, then the `HandoffCard{fannie_mae_letter}` exists and, on the borrower's upload of the letter, `ownership_transfer_notices.evidenced` is set. |

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**

### Sources
- docs/ux/07-cd-closing-rescission-funding-boarding.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections 25.2 (CD), 25.3 (rescission), 25.4 (closing-time and post-closing notices), 26.1 (closing documents), 26.2 (signing — RON/IPEN/hybrid/wet, eNote), 26.3 (funding), 26.4 (recording, MERS, custody, trailing documents), §27 (warehouse — invisible), 30.2 (boarding), 30.3 (escrow at closing), 30.4 (hand-off to servicing). (spec/sections/)
