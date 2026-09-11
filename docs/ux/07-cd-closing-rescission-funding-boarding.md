# 07 — Closing Disclosure, closing, rescission, funding, boarding, first 90 days

Owner specs: O6.2 (CD), O6.3 (rescission), O6.4 (closing-time and post-closing notices), O7.1 (closing documents), O7.2 (signing — RON/IPEN/hybrid/wet, eNote), O7.3 (funding), O7.4 (recording, MERS, custody, trailing documents), O8 (warehouse — invisible), O11.2 (boarding), O11.3 (escrow at closing), O11.4 (hand-off to servicing).

## 1. Closing Disclosure (O6.2)

CD version: `drafting → gated → delivered → received → waiting → consummation_ready → consummated → final | superseded`; post-consummation `corrected_post_consummation → delivered → final`.

| State | Thread | Record |
|---|---|---|
| `drafting`, `gated` | `StatusCard` "Preparing your Closing Disclosure — target {{SM_O62_CD_TARGET_4SBD.due_at}}" | Next: CD by |
| `delivered` (esign_portal) | `DocumentCard{NTC_REGZ_1026_38_CD, requires_ack=true, why: "Confirming receipt starts the three-business-day wait before you can sign (Sundays and federal holidays don't count)"}` + **What changed since your Loan Estimate** block (LE-vs-CD row diff, tolerance cures shown as lender credits) + the wire-fraud line (06 §4) | Documents; Numbers flip to `cd_v{n}`: rate, APR, payment, cash to close (purchase) or payoff/escrow/cash-out (refi) |
| `delivered` (mailed / e-mailed without confirmation) | `StatusCard` "Mailed {{date}}; it counts as received on {{REGZ_1026_19F1III_CD_MAILBOX_3SBD.due_at}} unless you confirm sooner" | Documents *Mailed*; Dates "counts as received on" |
| `received` (every required consumer) | receipt line | Dates: "earliest closing {{earliest_consummation_date}}" (`REGZ_1026_19F1_CD_3SBD_GATE`) |
| `waiting → consummation_ready` | closing `ScheduleCard` (§2) | badge "Clear to close" → "Closing scheduled" |
| `superseded` (redisclosure: APR beyond tolerance, product change, prepayment penalty added) | new `DocumentCard` with **What changed**; copy `cd.redisclosed_restart` ("this change restarts the three-day wait") | Dates recomputed |
| `corrected_post_consummation` (`REGZ_1026_19F2_CORRECTED_CD_30`, clerical `_60`) | `DocumentCard{NTC_REGZ_1026_38_CD_CORRECTED, requires_ack=false}` + refund line if any | Documents |

Rules: each consumer with a right to receive the CD gets their own card and receipt (co-borrower threads); a waiver of the three-day wait is offered **only** when the borrower states a bona fide personal financial emergency in their own words (O6.2 `waiver` → `officer` acceptance) — never proposed by the assistant. Seller CD is the settlement agent's (`REGZ_1026_19F4_SELLER_CD_GATE`; invisible to the buyer beyond the settlement statement). The Texas 50(a)(6) itemization (`NTC_TX_50A6_ITEMIZATION`, `TX_50A6_ITEMIZATION_1BD_GATE`) rides with the CD.

## 2. Scheduling the signing (O7.2)

`closings.status`: `scheduled → package_released → pre_session_checks_passed → session_in_progress → signed → notarized → sealed → execution_reviewed → awaiting_funding → funded → recorded → complete`; `session_failed{reason} → rescheduled | converted_to_paper_path`; `voided`.

- **`ScheduleCard{ron_session}`** renders when: `clear_to_close`, `earliest_consummation_date` known, lock covers the date, flood notice (if any) delivered, appraisal copy delivered or waived. Slots come from the eClosing/RON platform; default `closing_type = ron` when `SM_O72_RON_STATE_AUTH_GATE` is open for the property state and the partner is eMortgage-approved; otherwise `ipen` (in-person electronic with the settlement agent), `hybrid` (paper note, electronic everything else) or `wet`. The card shows the type in one line and the fallback ("if the video session can't happen, you can sign on paper with the settlement agent").
- **Borrower declines electronic records** (A2-4.1-03) → `ChoiceCard` **Sign electronically** · **Sign on paper** → paper set, no eNote; loan still eligible.
- **Closing consent** — `closing.captureEsignConsent` (`SM_O72_ESIGN_CONSENT_CLOSING_GATE`) is a separate `ConsentCard{esign, scope=origination_esign_signatures + enote}` if the E6 consent did not include the eNote scope (O7.2 owns eNote consent).
- **Pre-signing**: `HandoffCard{destination=ron_platform, what_to_expect}`: the non-notarized documents can be pre-signed from the day the package is released (`closing.documents.released`); the notarized set (note/eNote, security instrument, riders) is signed live with the notary; identity is proved inside the platform (credential analysis + KBA, or personal knowledge/credible witness where the state allows — SEL-2026-05); ~15–20 minutes; what to have ready (ID, a quiet room, the device requirements); who else must attend (co-borrower, non-borrowing spouse, POA signer). `PersonCard{notary}` and `PersonCard{settlement_agent}` when assigned.
- **Purchase**: the seller signs separately; cash to close goes to the settlement agent by wire with positive confirmation or cashier's check — never to Supermortgage, never from instructions received by e-mail (repeated on the card).
- **Texas 50(a)(6)**: wet-only at a title-company office; `TX_50A6_12DAY_CLOSING_GATE` and `TX_50A6_RESCISSION_3D_GATE` render as Dates; the FMV acknowledgment is in the package.

## 3. The session and after (O7.2)

`signing_sessions.status`: `created → consent_captured → identity_proofed → in_session → documents_signed → notarial_acts_complete → tamper_sealed → audit_trail_received → completed`; `failed{reason}`, `abandoned`.

| Event | Thread | Record |
|---|---|---|
| `pre_session_checks_passed` (T−1) | `StatusCard` "All set for {{time}} — join from this link" | badge "Closing scheduled" |
| `session_in_progress` | live status line | — |
| `signed` (`consummation_at` set when the note/eNote is fully signed) | `StatusCard` **signed**: refinance → "You have until midnight {{rescission.expires_at}} to cancel; funding on {{fundings.earliest_funding_date}}"; purchase → "Signed. Funds go out {{today/next business day}}" | badge "Signed"; Dates: cancel window ends · funding |
| `notarized → sealed → execution_reviewed` | nothing new | — |
| `session_failed{identity failure | outage | no-show | document defect}` | `StatusCard` neutral + `ScheduleCard` reschedule or `ChoiceCard` paper path (`SM_O72_PAPER_FALLBACK_5BD`) | badge unchanged |
| executed copies available | Documents section lists the executed note/eNote copy, security instrument, riders, CD final, rescission notice, HPA disclosure, initial escrow statement, first-payment letter, privacy (per O6.4 package) | Documents |

Package items the borrower can expect at signing (O6.4 `gated`): the final CD, the rescission notice (refi — H-8/H-9), the HPA initial disclosure if MI, the initial escrow account statement (or its 45-day follow-up), the privacy notice if not yet delivered, state closing notices, the first-payment letter data (payee: Supermortgage, servicing on behalf of {{partner.legal_name}}). The assistant lists them the day before as a `StatusCard`, not as separate cards.

## 4. Rescission (O6.3)

States: `not_applicable | pending_consummation → running → expired_not_rescinded → funding_released`; `waived`; `rescinded → unwinding → closed`; `extended_3y`.

- `not_applicable` (purchase-money; not a principal dwelling; same creditor with no new advance): no cancel window anywhere. The Thread's signed message uses the purchase variant.
- `running`: `DocumentCard{NTC_REGZ_1026_23_H8 | H9, requires_ack=true}` (each consumer with the right receives two copies — the platform delivers the notice in the package and records receipt per consumer); badge "Cancel window"; Dates "cancel window ends midnight {{expires_at}}" (`REGZ_1026_23_RESCISSION_3SBD_GATE`; specific business days).
- **Cancel** — `rescission.exercise` is offered as a quiet link on the H-8/H-9 card ("How to cancel"), never as a primary button; it opens a `ChoiceCard` with a plain explanation of the consequences and a confirmation; on confirm → `rescinded → unwinding` (`REGZ_1026_23D2_RESCISSION_REFUND_20`: any money paid is returned within 20 calendar days) → the application becomes read-only with badge "Cancelled".
- **Waiver** (`waived`): only on the borrower's own written statement of a bona fide personal financial emergency; the assistant never suggests it.
- `expired_not_rescinded → funding_released` (`rescission.confirmed_not_rescinded`): `StatusCard` "Your cancel window ended. Funding is scheduled for {{date}}." `extended_3y` is internal unless a corrected notice must be delivered (then a `DocumentCard`).

## 5. Funding (O7.3)

`fundings.status`: `pending_conditions → conditions_met → authorized → advance_approved → wire_pending_release → wire_released → wire_accepted → funds_at_agent → disbursed`; `held{reason}`.

Borrower-visible: `authorized … funds_at_agent` collapse to badge "Funding" and a single `StatusCard` "Funding is in progress — expected {{fundings.earliest_funding_date}} (`SM_O73_POST_RESCISSION_FUNDING_1BD` for refinances)". `held{reason}` renders as "a final check is in progress" with the borrower asked something only if the hold is a borrower item (a re-signed document, a new insurance effective date). `disbursed` → `loan.funded`:

- **Refinance**: `StatusCard` `funded.refi` — "Funded. {{prior servicer}} is being paid off today. Your escrow balance with them is refunded by them within 20 days ({{REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD}} is their clock) — watch for it. Your first payment of {{money}} is due {{first_payment_date}}." (same-servicer refinances: 09 §6). Second lien: "your HELOC has been {{subordinated|paid off}}".
- **Purchase**: `StatusCard` `funded.purchase` — "Funded. Ownership is being recorded; keys through your settlement agent. First payment {{money}} on {{date}}." Wet-funded states (`SM_O73_WET_FUNDS_AT_TABLE_GATE`) show funding on closing day.
- Cash-out: the disbursement to the borrower is listed with the settlement agent as payer.
- First-payment rule: `FNMA_B2_1_5_FIRST_PAYMENT_2M` — the first payment date is never more than two months after disbursement; the assistant explains prepaid interest ("interest from {{disbursement}} to {{month end}} was collected at closing; there is no skipped payment").

Recording (`recording.submitted → recording.confirmed`), MERS registration, custody and trailing documents (O7.4) are invisible; the recorded security instrument appears in Documents when `recording.confirmed`.

## 6. Boarding and the first 90 days (O11.2–O11.4)

`loans.boarding_status`: `staged → validated → boarded → boarded_with_warnings → active` (`SM_ORIG_BOARD_T1BD`; `SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE`). On `loan.boarded` the Record switches to the servicing layout (08a) with the label "Your loan"; the origination Record remains reachable under *Earlier* with all documents.

Sequence of borrower-facing items:
1. **First-payment letter** — `NoticeCard{NTC_SM_FIRST_PAYMENT_LETTER}` within 5 servicer business days of funding (`SM_O64_FIRST_PAYMENT_LETTER_5BD`) and ≥ 20 days before the first due date (`_PREDUE_20`): amount, due date, payee "Supermortgage, servicing on behalf of {{partner.legal_name}}", payment address and options, the FCRA §623(a)(7) model B-1 text (8.1), the E-SIGN enrollment invitation for servicing classes if not already active.
2. **Autopay** — `ConsentCard{autodraft_authorization}` (2.x rule 1 elements; draft day 1–16; fixed or variable; `SM_AUTODRAFT_COPY_DELIVERY_1BD`), preceded by the Reg E statement that autopay is optional and never a condition of the loan. Existing platform borrowers (09): the prior enrollment is `terminated` at payoff and a fresh authorization is required (2.x transfer rule applies to a new loan).
3. **E-delivery for servicing** — if E6's consent scoped servicing classes, `consents.boarded` carries it (`ESIGN_7001C_CONSENT_GATE`); otherwise the `ConsentCard{esign, servicing scopes}` is re-offered; statements are paper until `active`.
4. **Initial escrow statement** — `DocumentCard{NTC_REGX_1024_17G_INITIAL_ESCROW_STMT}` at settlement or within 45 days (`REGX_1024_17G_INITIAL_STMT_45`): monthly escrow, first-year disbursements, cushion; the Loan section shows escrow lines. Waived escrow: the election and state disclosures (`NTC_SM_ESCROW_ELECTION`, `NTC_UT_7_17_4_RESERVE_OPTIONS`, `NTC_CA_CIV_2954_IMPOUND_STMT` per `jurisdiction_rules`) as `DocumentCard`s.
5. **First statement** — before the first due date (`SM_ORIG_FIRST_STATEMENT_LEAD_15`), `NTC_REGZ_41_STMT_STD` as `DocumentCard` (electronic) or *Mailed*.
6. **Fannie Mae ownership letter** — `HandoffCard{destination=fannie_mae_letter}`: "Within about a month you'll get a letter from Fannie Mae saying it owns your loan. Nothing changes — you still pay Supermortgage." (`NTC_REGZ_1026_39_OWNERSHIP_TRANSFER` `expected → evidenced`; `REGZ_1026_39_OWNERSHIP_NOTICE_30`). If the borrower forwards the letter, `evidenced` is set from their upload.
7. **Nothing-needed state** — after items 1–6, the Record shows the servicing home; the first proactive message is "payment posted" on the first payment.

Invisible: investor setup (`investor_setup_status`), MI activation, tax/flood/insurance tracking activation, EPD watch (`SM_ORIG_EPD_WATCH_P6_60`), servicing hand-off checklist (`servicing_handoffs` → closed at `SM_ORIG_HANDOFF_CLOSE_90`). Boarding exceptions never surface; a payment received before `active` posts to suspense and the borrower's payment card shows *received* (2.2).

## 7. Tests

- **T-07-01** Given the CD e-mailed Mon Nov 2, 2026 without confirmation, then `deemed received` is Thu Nov 5 (specific business days) and `earliest_consummation_date` is Mon Nov 9; given confirmation Mon Nov 2, then `earliest_consummation_date` is Fri Nov 6 (O6.2 fixture).
- **T-07-02** Given an APR increase beyond tolerance after CD delivery, then a superseding CD card renders with `cd.redisclosed_restart` and Dates recompute.
- **T-07-03** Given a co-borrower without active E-SIGN, then their CD is mailed and the `earliest_consummation_date` uses the later of the two receipt dates.
- **T-07-04** Given `SM_O72_RON_STATE_AUTH_GATE` closed for the property state, then the `ScheduleCard` offers `ipen|hybrid|wet` and never `ron`.
- **T-07-05** Given the borrower declines electronic records, then `closing_type = wet`, no eNote is built, and the Thread confirms the paper path.
- **T-07-06** Given `signed` on a primary-residence refinance by a different creditor, then the H-8 card renders with `requires_ack`, Dates shows midnight of the third specific business day, and `disburse` is refused before `expires_at` (`REGZ_1026_23_RESCISSION_3SBD_GATE`).
- **T-07-07** Given a purchase, then no rescission card or cancel window renders (`not_applicable`).
- **T-07-08** Given the borrower opens "How to cancel" and confirms, then `rescinded → unwinding`, `REGZ_1026_23D2_RESCISSION_REFUND_20` is created, and the Record is read-only with badge "Cancelled".
- **T-07-09** Given `fundings.status = held{reason=insurance_effective_date}`, then the borrower sees a single ask for the corrected effective date and no wire-status detail.
- **T-07-10** Given `loan.funded` on Thu Nov 12, 2026 for a refinance, then the funded message names the prior servicer, the 20-day refund clock, and a first payment date ≤ Jan 12, 2027 (`FNMA_B2_1_5_FIRST_PAYMENT_2M`).
- **T-07-11** Given `loan.boarded`, then `NTC_SM_FIRST_PAYMENT_LETTER` is sent within 5 servicer business days and the Record shows the servicing layout; the autopay `ConsentCard` includes every 2.x rule-1 element and the optional statement.
- **T-07-12** Given E6 consent scoped only `origination_disclosures`, then the first statement is paper and a servicing-scope `ConsentCard` is offered.
- **T-07-13** Given `loan.purchased`, then the `HandoffCard{fannie_mae_letter}` exists and, on the borrower's upload of the letter, `ownership_transfer_notices.evidenced` is set.
