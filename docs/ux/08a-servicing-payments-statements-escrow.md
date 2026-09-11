# 08a — Servicing: the loan home, payments, autopay, statements, escrow

Owner specs: 2.1–2.7 (cashiering: posting, partial payments, autodraft, curtailments, biweekly arrangements, trial overlays, late charges), 7.1 (periodic statements), 7.4 (E-SIGN), 7.x (1098), 3.1–3.8 (escrow), 6.x (custodial — invisible), 5.x (investor reporting — invisible). The servicing Record layout (01 §4 §10) applies from `loan.boarded`.

## 1. The loan home

Record header "Your loan · {{address}}"; Status = the account state (§2); Next = the earliest of: next payment due, next autopay draft, escrow analysis, PMI end, ARM change; Numbers (post-funding set, 02 §1.1); Loan section (autopay, escrow lines, MI, ARM, year-end). The Thread's default content is system-initiated (01 §0 principle 6); the borrower's typed requests route through the `borrower-comms` agent and the Intake Router (4.1) — any question about the account is at least an oral RFI answered live, any assertion of an error is a notice of error (08b §5).

## 2. Account states (badge)

Derived per 2.x from the installment `late_charge_state` and the delinquency counters (`regx_days_delinquent` per §1024.31 FIFO; `fnma_delinquency_status` only for reporting):

| Badge | Condition | One-liner |
|---|---|---|
| **Current** | no unpaid installment past due; next due in the future | "Next payment {{money}} due {{date}} · autopay on {{date}}" or "…pay by {{due_date + grace_days}}" |
| **Payment due** | due date reached, inside the grace period (`not_due → evaluating` not yet passed; `NOTE_6A_LATE_CHARGE_GRACE_GATE`) | "Due {{date}} — no late charge if received by {{grace end}}" |
| **Past due** | grace passed, `late_charge_state = assessed | accrued_suspended`, < 30 days | "Past due. Late charge {{money}} applied {{date}}." |
| **Behind {{n}} days** | `regx_days_delinquent ≥ 30` | 08c takes over (early intervention, plans) |
| **On a plan** | `workout_plans.active`, `trial_active` | "Forbearance through {{date}}" / "Trial payment {{n}} of 3 due {{date}}" |
| **Paused** | bankruptcy stay, SCRA relief, disaster forbearance | 08c |
| **Paid off / Closed** | 10 | — |

`FNMA_D2203_PAYMENT_REMINDER_CD20` / `NTC_FNMA_D2_2_03_PAYMENT_REMINDER` (7.1): the Fannie Mae payment reminder issues automatically when no payment has arrived by the Guide's day; the Thread renders it as a `NoticeCard` and the badge is already "Past due".

## 3. Payments (2.1, 2.2, 2.5, 2.6, 2.7)

### 3.1 Make a payment
`PaymentCard`: default amount = the installment due (P&I + escrow + any late charge if elected), editable; date options = today through `due_date + grace_days` (2.x rule 3), never later; account = a saved account (masked last 4) or **Add account** (routing + account + type → instant verification API, fallback micro-deposits with a `ConfirmCard` for the two amounts, or a $0 prenote wait — 2.x rule 2). Fresh L1 within 10 minutes required (01 §5). `payment.makeOneTime` → `payments.received → identified → allocated → posted`; the Thread shows *received* immediately and *posted* on `payment.posted` with the allocation (interest, principal, escrow, fees — C-1.1-01 order) as a collapsed receipt; Numbers update.

### 3.2 Extra principal
`PaymentCard{mode=extra_principal}`: amount only; explains the effect in one line from the ledger projection ("brings your balance to {{money}}"); `payment.extraPrincipal` → curtailment `received → applied` (same day if current; `redirected_to_cure` when delinquent — the card says so before submission). Re-amortization (Form 181) is a request the borrower can make ("recalculate my payment") → 2.x re-amortization `requested → computed → offered → executed → effective` with a `NoticeCard` and a `ChoiceCard` to accept.

### 3.3 Partial payments and suspense (2.2)
A payment less than the installment shows *received — held until the rest arrives* with the amount still needed and the 30-day rule in plain words ("if the rest doesn't arrive within 30 days we'll return this"); `suspense_items{reason=partial_payment}`: `open → applied | returned | refunded`. The borrower can always ask for the funds back (`refunded`). The statement carries the same explanation (7.1).

### 3.4 Returned payments (2.x rule 7)
`ach.return.received{R01|R09}` → `payments.reversed`; `NoticeCard{AUTODRAFT-RETURN-v1}`; the platform retries once automatically in 3–5 banking days ("we'll try again on {{date}} — no action needed unless you want to pay another way") → a second return → `suspended_returns` and a `PaymentCard` with a different account. NSF fee only where permitted (2.7), shown on the card. Administrative returns (R02/R03/R04/R20) → "that account can't be used — add a new one".

### 3.5 Biweekly / semimonthly (2.5)
Third-party arrangements are recognized (`reported → verified → active`); the platform's own half-payment plan is offered as a `ChoiceCard` with the schedule and the rule that halves accumulate without a 30-day return clock while the arrangement is active.

### 3.6 Late charges (2.7)
`late_charge_state`: `not_due → evaluating → assessed | accrued_suspended | not_assessed`; `assessed → collected | waived | reversed`. The Thread posts a `StatusCard` at assessment; a courtesy waiver request is a typed ask handled by the `cashiering` agent within policy (`fee.waived{reason}`); the outcome is a one-line receipt.

## 4. Autopay (2.x autodraft)

`autodraft_enrollments.status`: `requested → authorized → validating → active ⇄ paused → revoked | terminated | suspended_returns`.

- **Enroll** — `ConsentCard{autodraft_authorization}` (every Nacha/Reg E element: borrower name; masked loan number; account; amount rule — fixed installment or variable with the ≥10-day change-notice statement; draft day 1–16 or the due date; first draft date; company name "SUPERMORTGAGE" as it appears on the bank statement; revocation instructions incl. the 3-business-day rule; "enrollment is optional"; E-SIGN consent for the copy). `checkbox_with_text` + typed name → `authorized` → `validating` → `active`; copy delivered within 1 BD (`AUTODRAFT-CONFIRM-v1`, `SM_AUTODRAFT_COPY_DELIVERY_1BD`). Voice enrollment is a `ConsentCard` link, never spoken consent (01 §3.5).
- **Change** — draft day, account, extra principal: `autodraft.change` → re-validation for a new account; the Loan section shows the next draft.
- **Amount change notice** — `NoticeCard{AUTODRAFT-AMOUNT-CHANGE-v1}` ≥ 10 calendar days before a changed debit (`REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10`) unless the escrow/ARM notice already stated the exact new amount and date; the borrower may elect range notices (`ChoiceCard`).
- **Pause / revoke** — any channel; effective for unsent files; ≥ 3 business days before a debit stops it; `NoticeCard` confirmation. The assistant never argues against a revocation.
- **Paused by the platform** — forbearance/trial re-baselining, bankruptcy hold, death of borrower (`terminated`; successor enrolls anew), payoff/transfer (`terminated` at cutover — 10).
- **Returns** — §3.4; `suspended_returns` requires the borrower to re-activate (`ChoiceCard`).

## 5. Statements and year-end (7.1, 7.x)

Cycle: `scheduled → snapshot_taken → variant_selected → rendered → checked → channel_decided → sent → delivered | bounced → fallback_mailed | returned → re_sent`. Variants: `NTC_REGZ_41_STMT_STD`, `_DELQ` (delinquency block), `_TPP` (trial period), `_BK7_11`, `_BK12_13`, `NTC_REGZ_41E3IV_COUPON_DELQ_NOTICE`; e-delivery uses `NTC_REGZ_41_STMT_AVAIL_EMAIL` (availability e-mail with link — comment 41(c)-3).

- Electronic: `DocumentCard{statement, requires_ack=false}` on `sent`; Documents lists every cycle; a hard bounce → `fallback_mailed` and consent `suspect` (7.4 rule 8) with the re-verification `ConsentCard`; the Record shows *Mailed*.
- Paper: *Mailed {{date}}* rows only.
- Exempt cycles (`exempt_bk`, `exempt_charged_off`, `suppressed_transfer`) render nothing; bankruptcy variants follow 14.x election rules (08c).
- **Form 1098** — `NTC_IRS_1098` by January 31 (electronic only with the separate `consents{kind=irs_estatement}` and its `NTC_IRS_ESTATEMENT_CONSENT_DISCLOSURE`; the `ConsentCard` is offered in December); corrected forms `NTC_IRS_1098_CORRECTED`. The Loan section's year-end block shows status and a link.
- Privacy annual notice (`NTC_REGP_1016_5_ANNUAL` / website-only under 1016.9(c)(1)) and opt-out confirmations render as `NoticeCard`s.

## 6. Escrow (3.1–3.8)

### 6.1 Steady state
Loan section escrow block: balance, monthly escrow portion, lines (`escrow_lines`: county tax, hazard, flood, MI, HOA where escrowed) with payee, frequency, next disbursement and last paid. Each disbursement `sent → confirmed` posts a `StatusCard` ("we paid {{payee}} {{money}} for {{line}}"). Shortage plans (`escrow_shortage_plans`) show remaining installments. `NTC_SM_ESCROW_ADVANCE` / `NTC_SM_ESCROW_HAZARD_ADVANCE` render when the platform advances funds.

### 6.2 Annual analysis (3.2, 3.3)
`scheduled → computing → computed → (anomaly_review) → approved → statement_sent → effective`. Dates: `REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45` ("escrow review starts {{date}}"); statement within 30 days of the computation year end (`REGX_1024_17I_ANNUAL_STMT_30`).
- `statement_sent` → `NoticeCard{NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT}` with the template's plain-language block: new monthly escrow, effective date, surplus/shortage/deficiency.
- **Shortage** (`NTC_REGX_1024_17F_SHORTAGE`): `ChoiceCard` **Spread over 12 months (+{{money}}/month)** · **Pay {{money}} now** (the `NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT` election) → `escrow.electShortage` → plan `active` or `paid_lump`; the autopay amount-change notice follows automatically.
- **Surplus** ≥ $50: `NTC_SM_ESCROW_SURPLUS_REFUND` — refund `scheduled → issued → cleared` within 30 days; loan not current → `retained` with the explanation; < $50 → credited to payments (`credited_to_payments`).
- Short-year statements (`NTC_REGX_1024_17I4_SHORT_YEAR_RESET`, `_TRANSFEROR`) on transfer/payoff; state statements (`NTC_STATE_ANNUAL_ESCROW_STMT_UT`, interest-on-escrow statements `NTC_STATE_ESCROW_INTEREST_STATEMENT_*`) per `jurisdiction_rules`; `NTC_IL_765_910_15_TAX_PAID` (IL tax-paid notice), `NTC_MN_47_20_9_DISCONTINUE_RIGHT` where applicable.
- Bankruptcy Chapter 13: the `effective` transition waits for the 14.2 gate; the Thread says the new amount "takes effect once the plan allows".

### 6.3 Waiver and revocation (3.x)
`escrowed → evaluating → approved → waived | denied`; `waived → revoking → escrowed`. `escrow.requestWaiver` from a typed ask; eligibility explained (LTV ≤ 80% and program rules; HPML loans stay escrowed ≥ 5 years — `REGZ_1026_35B1_HPML_ESCROW_GATE`; flood and MI lines can't be waived); `NTC_SM_ESCROW_WAIVER_DECISION`; on `waived` the final short-year statement and balance refund/credit; `NTC_SM_NONESCROW_TAX_DELINQUENCY` if a non-escrowed tax goes delinquent; `NTC_SM_ESCROW_WAIVER_REVOCATION` when re-established (initial statement within 45 days).

## 7. Proactive message catalogue (this file)
payment posted · payment received (held) · payment returned · autopay confirmation · autopay amount changing · autopay draft tomorrow (opt-in) · payment due in 5 days (autopay off) · late charge assessed · statement available · 1098 ready · escrow review starting · escrow statement · shortage choice · surplus refund sent · tax paid · insurance paid · MI paid · escrow advance · nothing needed this month.

## 8. Tests

- **T-08a-01** Given due Oct 1 with 15-day grace, then the badge is "Payment due" Oct 1–15 with the grace end shown, "Past due" from Oct 16 with the assessed late charge, and "Current" on posting.
- **T-08a-02** Given a `PaymentCard` submitted without a fresh L1 code in the last 10 minutes, then the API refuses and the card requests the code.
- **T-08a-03** Given a payment of $1,000 against a $2,400 installment, then the Thread shows *held*, the remaining $1,400 and the 30-day rule; `suspense_items.open` exists; a request for refund resolves to `refunded`.
- **T-08a-04** Given `ach.return.received{R01}`, then `AUTODRAFT-RETURN-v1` renders, one retry is scheduled in 3–5 banking days, and a second R01 moves the enrollment to `suspended_returns` with a re-activation `ChoiceCard`.
- **T-08a-05** Given an autopay `ConsentCard`, then it contains every 2.x rule-1 element and the optional statement; `authorized` is never set from voice.
- **T-08a-06** Given an escrow analysis raising the payment on Jan 1, then `AUTODRAFT-AMOUNT-CHANGE-v1` is sent ≥ 10 days before the Jan draft unless the escrow statement stated the exact amount and date.
- **T-08a-07** Given a hard bounce on the statement availability e-mail, then a paper statement is mailed the same day, consent is `suspect`, and a re-verification card appears.
- **T-08a-08** Given a shortage of $600, then the `ChoiceCard` shows +$50/month or $600 now; choosing spread creates a 12-installment plan and no lump-sum insert is rendered afterwards.
- **T-08a-09** Given a surplus of $75 on a current loan, then a refund is scheduled and `NTC_SM_ESCROW_SURPLUS_REFUND` renders; given $40, then `credited_to_payments`.
- **T-08a-10** Given an HPML loan consummated Nov 6, 2026, then `escrow.requestWaiver` before Nov 6, 2031 is refused with the escrow-period copy (O4.4-T5).
- **T-08a-11** Given no `irs_estatement` consent, then the 1098 shows *Mailed* and the December `ConsentCard` was offered.
