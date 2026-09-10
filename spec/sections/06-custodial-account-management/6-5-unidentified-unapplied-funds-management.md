# 6.5 — Unidentified/unapplied funds management

| Attribute | Value |
|---|---|
| Section | 6 — Custodial Account Management |
| Automation class | a |
| Trigger & frequency | Ongoing (event-driven on every unmatched or unapplied receipt; daily aging; weekly register review; monthly Form 496A line 4) |
| Governing source | FNMA custodial reqs |
| Key deadlines | Daily/weekly recon |
| Timers | `FNMA_C1102_50_RULE_COUNT_12M`, `FNMA_C1102_PARTIAL_BALANCE_30`, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD`, `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD`, `SM_OVERPAYMENT_REFUND_10BD`, `SM_STALE_CHECK_180`, `SM_SUSPENSE_AGE_90_ESCALATE`, `SM_SUSPENSE_REGISTER_WEEKLY`, `SM_SUSPENSE_TRIAGE_1BD`, `SM_UNIDENTIFIED_RESEARCH_30`, `SM_UNIDENTIFIED_RETURN_60`, `STATE_UUPA_DORMANCY_3Y`, `STATE_UUPA_DUE_DILIGENCE_NOTICE_60_180`, `STATE_UUPA_REPORT_NOV1` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Custodial |
| Trigger & frequency | Ongoing (event-driven on every unmatched or unapplied receipt; daily aging; weekly register review; monthly Form 496A line 4) |
| Governing source (blueprint) | FNMA custodial reqs |
| Key deadlines (blueprint) | Daily/weekly recon |
| Data/artifacts | Suspense records |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Supermortgage owns identification, application, return and escheat; partner receives aging reports; Fannie Mae sees unapplied funds on Form 496A |
| Nuances (blueprint) | [cropped in source] — reconstructed: unapplied funds must sit in a T&I custodial account (optionally its own); Fannie Mae sets no maximum age but requires written procedures to research, contact and return "in a timely manner"; partial-payment rules ($50 tolerance, 3 per 12 months, 30-day commitment); Reg Z suspense disclosure/application; state unclaimed-property for stale refunds |

### Verified requirement (as of 2026-09-09)

**Fannie Mae.** A4-1-02 (07/12/2023): T&I custodial accounts hold "unapplied (suspense) payments pending proper application determination, including partial payments, insurance loss drafts, payment overages/shortages, rental income," and the servicer may "establish separate accounts for … partial payments, rental income, or unapplied (suspense) funds." A4-1-01 (02/12/2025), verbatim: written procedures for "actively identifying and monitoring all unapplied funds held in a T&I custodial account until resolution, including conducting research to ensure unapplied funds are identified and applied as appropriate; attempting to contact the borrower, when appropriate, to determine the correct action needed and expected date of resolution; and determining whether any funds should be returned to the borrower and doing so in a timely manner." F-1-03: Form 496A must "document unapplied funds that need resolution." C-1.1-02 (08/13/2025): "The servicer must accept a partial payment and hold it as 'unapplied funds' in a T&I custodial account if all of the requirements in the following table are met": the borrower "has a commitment toward repayment," "is not habitually delinquent," "does not have a history of remitting checks that are returned for insufficient funds," and "commits to paying the balance of the payment within the next 30 days"; "When the total of the reduced payments held as unapplied funds is equal to a full PITI payment, the servicer must apply all full payments to the mortgage loan"; otherwise "the servicer is authorized to return the partial payment to the borrower"; a payment "deficient by $50 or less" may instead be applied by reducing escrow (instruments dated March 1999 or later), "for up to three monthly mortgage loan payments during a 12-month period." **Fannie Mae publishes no maximum age for unapplied funds** — the standard is "until resolution … in a timely manner"; the only numeric aging cue is the Form 496A 7-month loss-draft explanation. Freddie Mac (benchmark) requires clearing variances within 90 days. (URLs as in 6.1–6.4, verified 2026-09-09.)

**Federal.** Reg Z §1026.36(c)(1)(ii) (eCFR current as of 2026-09-04): a servicer that retains a partial payment "in a suspense or unapplied funds account shall: (A) Disclose to the consumer the total amount of funds held in such suspense or unapplied funds account on the periodic statement as required by § 1026.41(d)(3) …; and (B) On accumulation of sufficient funds to cover a periodic payment in any suspense or unapplied funds account, treat such funds as a periodic payment received in accordance with paragraph (c)(1)(i)" (credit as of the date of receipt). §1026.36(c)(1)(iii): non-conforming payments accepted must be credited "as of five days after receipt." Reg X §1024.34(b)(1): escrow balance returned "within 20 days (excluding legal public holidays, Saturdays, and Sundays)" of payoff. Reg X §1024.35 (notice of error for misapplied payments) and §1024.38(b)(1)(i) (policies to provide accurate information and credit payments) are the exam lens (4.1 owns NoE handling).

**State unclaimed property (note only).** Revised Uniform Unclaimed Property Act (2016) §201(13): property is presumed abandoned "the earlier of three years after the owner first has a right to demand the property or the obligation to pay or distribute the property arises"; §403(a): the report "must be filed before November 1 of each year and cover the 12 months preceding July 1 of that year"; §501(a): notice to the apparent owner when "the value of the property is $[50] or more," sent "not more than 180 days nor less than 60 days before filing the report"; §210(b): indications of owner interest (e.g., "activity directed by an apparent owner in the account"). States vary in dormancy periods (many 3 years, some 5), report dates and thresholds; the property type codes (NAUPA) and each state's portal/verification requirements must be configured per state **[PARTIALLY VERIFIED — uniform act text verified; state enactments/variations not individually checked]**. (URL: https://compacts.csg.org/wp-content/uploads/2024/03/Uniform-Unclaimed-Property-Act.pdf, verified 2026-09-09.)

**Discrepancies with the blueprint row.** (a) "FNMA custodial reqs" resolves to A4-1-02 + A4-1-01 + C-1.1-02 + F-1-03/Form 496A, with Reg Z §1026.36(c) as the federal driver; (b) "Daily/weekly recon" is a control cadence, not a Fannie Mae deadline — the binding clocks are Reg Z's accumulation rule (event-driven), Fannie Mae's 30-day partial-payment commitment, Reg X's 20-business-day escrow refund and the state dormancy/report calendars; (c) "Systems: Core" omits the lockbox images, ACH data, borrower-comms channel and the state unclaimed-property filings.

### Operational prerequisites
- `ti_unapplied` custodial account with Form 1014 In Effect (6.2) and ledger control `suspense_liability`.
- Lockbox contract delivering check/coupon images and remittance data with payer name, memo and MICR (2.1); ACH origination for returns/refunds (`nacha`, PPD credits); check issuance with positive pay (T&I).
- Written unapplied-funds policy (research, contact, return and escheat time limits; thresholds; segregation from posting) approved by the `officer`; partner copy.
- TCPA/consent and AI-disclosure configuration for borrower outreach by `borrower-comms` (baseline §8; consents table).
- State unclaimed-property configuration in `jurisdiction_rules.unclaimed_property` (dormancy years, report due date, cycle end, due-diligence window/threshold, portal, verification/officer signature requirement, NAUPA property codes) for every state where a payee may reside — compliance; before first escheat cycle (typically 3 years after go-live, but earlier for acquired stale items from transfer-in).
- Skip-trace/address vendor (NCOA link, LexisNexis-type) contract for lost payees **[vendor-specific]**.

### Build spec
#### Inputs and triggers
- `payment.received` with `allocation_outcome = unapplied` (2.1/2.2: partial, overpayment, post-payoff, pending-mod hold, bankruptcy hold, disputed), `bank_credit_unposted` items from 6.3/6.4 daily recon (`custodial.reconciliation.exception_opened` with that category), `lockbox.item.unmatched` (no loan match on the scanline), `loss_draft.received` (9.7, tracked here for aging only), `disbursement.stale` / `refund.returned` (6.4), `payoff.completed` with escrow/overpayment refund payable (**16.1/16.2**), `transfer_in.suspense.received` (1.6 — inherited suspense with the transferor's aging).
- Schedules: `suspense.aging.daily` (00:30 local), `suspense.register.weekly` (Monday), `unclaimed_property.cycle` (per state).
- Borrower actions: payment completing a partial (`payment.received` on a loan with open partial), borrower instruction via `borrower-comms` (`contact.completed` with intent), NoE (4.1) touching an unapplied item.

#### Data model
`suspense_items` (baseline) fixed as:

| Field | Type / constraint |
|---|---|
| `id`, `loan_id?` (null = unidentified), `custodial_account_id` (must be `ti` or `ti_unapplied`), `ledger_entry_id` | — |
| `source` | enum {lockbox, ach, wire, card, bank_credit_unposted, refund_returned, trustee, third_party, transfer_in, other} |
| `reason_code` | enum {partial_payment, partial_payment_50_rule, unidentified_loan, unidentified_payer, overpayment, duplicate_payment, post_payoff_receipt, pending_modification_hold (2.6), bankruptcy_hold, dispute_hold, foreclosure_hold, rental_income, third_party_unverified, returned_refund, transfer_in_inherited} |
| `amount_cents bigint`, `received_on date`, `credited_as_of date` (Reg Z crediting date once applied) | — |
| `payer_name`, `payer_account_last4`, `memo`, `image_document_id`, `bank_statement_line_id?` | PII (encrypted) |
| `status` | enum {open, researching, contact_pending, matched_pending, applied, returned, refunded, transferred, escheat_pending, escheated, written_off} |
| `resolution_due_on`, `aging_days` (computed daily), `resolved_on`, `resolution_event_id`, `decision_id`, `partial_commitment_due_on?`, `partial_count_12m?` | — |

`suspense_actions` (append-only): `suspense_item_id`, `action` ∈ {matched_candidate, contact_attempt, contact_result, return_initiated, refund_issued, applied, escheat_notice_sent, escheat_reported}, `payload json`, `actor`, `at`. `unclaimed_property_items`: `id`, `suspense_item_id? | outstanding_check_id?`, `owner_name`, `owner_last_address`, `state` (of last known address; holder's state if unknown), `naupa_property_code` **[UNVERIFIED codes]**, `dormancy_start_on`, `presumed_abandoned_on`, `due_diligence_notice_id`, `report_cycle`, `reported_on`, `remitted_on`, `state_confirmation_ref`, `status`. `unclaimed_property_reports`: `state`, `cycle`, `file_document_id` (NAUPA II), `verification_signed_by` (officer), `filed_on`, `remittance_cents`. Retention `life_of_loan_plus_4y` (and per-state unclaimed-property retention, commonly 10 years **[UNVERIFIED]**).

#### State machine
`open` → (deterministic match or AI match ≥ 0.97 with business-rule pass) `applied` (terminal) | (identified but rule requires borrower intent) `contact_pending` → (`contact.completed` with intent) `applied`/`refunded` | (no identification) `researching` → (return rail available) `returned` (terminal) | (payer unknown / return failed) `escheat_pending` → (state report filed and remitted) `escheated` (terminal); `open` → `transferred` (loan transferred out; funds wired with the loan — terminal); any non-terminal → `written_off` only by `officer` for ≤ $5.00 rounding items **[policy]**. Partial payments: `open(partial_payment)` → (accumulation ≥ periodic payment) `applied` | (`partial_commitment_due_on` passed without completion) → `returned` (default) or `applied` per the $50 rule/escrow reduction path where allowed. Guards: `applied` requires `loan_id`, an allocation per 2.1 rules and, for Reg Z, `credited_as_of` = receipt date of the completing payment (or the original receipt for a non-partial item). Actors: `custodial-recon` and `cashiering` agents; `borrower-comms` for contact; `officer` for write-offs, escheat verification and unusual returns (> $10,000 to a non-borrower payer).

#### Timers and gates
| Code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `SM_SUSPENSE_TRIAGE_1BD` | deadline | `suspense.item.created` | creation | 1 business_days_servicer | `suspense.item.matched` / `researching` / `contact_pending` | Sentinel; `officer` if > 20 items/day breach |
| `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD` | deadline | `suspense.accumulation.sufficient` (Σ unapplied on loan ≥ periodic payment) | accumulation date | 1 business_days_servicer (crediting date = accumulation date) | `payment.applied` with `credited_as_of` = accumulation date | `officer`, high (Reg Z violation risk; RESPA/NoE exposure) |
| `FNMA_C1102_PARTIAL_BALANCE_30` | deadline | `suspense.item.created` (reason partial_payment) | received_on | 30 calendar_days | `suspense.accumulation.sufficient` | agent executes policy: return the partial (C-1.1-02 authorization) unless `borrower-comms` obtained a documented new commitment; `officer` not required |
| `FNMA_C1102_50_RULE_COUNT_12M` | recurring counter (gate) | `suspense.item.created` (partial_payment_50_rule) | rolling 12 months | max 3 | — | blocks the escrow-reduction path on the 4th; item becomes ordinary partial |
| `SM_UNIDENTIFIED_RESEARCH_30` | deadline | `suspense.item.created` (unidentified_*) | received_on | 30 calendar_days | `suspense.item.matched` or `return_initiated` | `officer` notified in weekly register |
| `SM_UNIDENTIFIED_RETURN_60` | deadline | same | received_on | 60 calendar_days | `returned` | `officer`, medium; item moves to `escheat_pending` if payer unknown |
| `SM_SUSPENSE_AGE_90_ESCALATE` | deadline | `suspense.item.created` (any non-terminal) | received_on | 90 calendar_days | terminal status | `officer`, high; partner aging report line |
| `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` | deadline (defined by 3.5; executed in **16.2** — payoff, not 12.x; listed here for the custodial-cash impact) | `loan.paid_in_full` / `payoff.completed` | payoff posting date | 20 `business_days_federal` — §1024.34(b)(1)'s own wording is "20 days (excluding legal public holidays, Saturdays, and Sundays)", not "20 business days" | `refund.issued` | `officer`, critical |
| `SM_OVERPAYMENT_REFUND_10BD` | deadline (policy) | `suspense.item.created` (overpayment / post_payoff_receipt with no due amounts) | received_on | 10 business_days_servicer | `refunded` or `applied` (borrower elected curtailment) | `officer`, medium |
| `SM_STALE_CHECK_180` | (from 6.4) | — | — | — | — | feeds `unclaimed_property_items` |
| `STATE_UUPA_DORMANCY_3Y` | deadline | `unclaimed_property.item_opened` | `dormancy_start_on` (last indication of interest / check issue date per state rule) | 3 years (jurisdiction override, e.g., 5 years in some states **[UNVERIFIED]**) | `unclaimed_property.reported` or owner contact (`suspense.item.matched`) | none (date computation) |
| `STATE_UUPA_DUE_DILIGENCE_NOTICE_60_180` | deadline window | `unclaimed_property.presumed_abandoned` | planned filing date | send notice between −180 and −60 calendar_days (≥ $50) | `notice.sent` (`UP-DUE-DILIGENCE-v1`) | `officer`, high |
| `STATE_UUPA_REPORT_NOV1` | deadline | `unclaimed_property.presumed_abandoned` | cycle end (June 30 default) | file before Nov 1 (jurisdiction override for states with other dates) | `unclaimed_property.reported` + remitted | `officer`, critical |
| `SM_SUSPENSE_REGISTER_WEEKLY` | recurring | Monday 06:00 local | — | weekly | `suspense.register.reviewed` (reviewer run) | Sentinel |

Jurisdiction overrides: unclaimed-property parameters by owner's state of last known address (holder's state of domicile if unknown — RUUPA priority rules **[general knowledge]**).

#### Business rules and calculations
1. **Identification engine (deterministic first)**: candidate loans from (a) loan number / scanline in memo or coupon, (b) MICR/ACH account last4 matching `payments` history, (c) payer name fuzzy-match (Jaro-Winkler ≥ 0.92) to borrowers, co-borrowers, confirmed successors and authorized third parties, (d) amount equal to the loan's periodic payment, total due, or a prior recurring amount (±$0.00), (e) property address in memo. Score = weighted sum; auto-apply when a unique candidate scores ≥ 0.97 **and** no conflicting candidate ≥ 0.80; otherwise AI triage proposes and either applies (≥ 0.97 after evidence review) or routes to `contact_pending`/`researching`.
2. **Application rules** on match: run 2.1's allocation (uniform-instrument order; Fannie Mae C-1.1-01 "apply all funds as intended by the borrower"); a third-party payment is accepted unless a hold reason applies (bankruptcy plan, foreclosure post-referral rules, NoE dispute) — those go to their case owners.
3. **Partial payments**: on receipt of amount `a < periodic_payment P`: if the four C-1.1-02 conditions hold (commitment captured via `borrower-comms` or coupon note, not habitually delinquent — policy: < 3 × 30-day late in 12 months, no NSF history in 12 months), hold in `ti_unapplied` with `partial_commitment_due_on = received_on + 30`. When Σ held on the loan ≥ P, apply as one periodic payment with `credited_as_of` = the date the completing amount was received (Reg Z (c)(1)(ii)(B) + (c)(1)(i)); surplus above P stays unapplied (or applies to the next installment per borrower instruction). If `P − a ≤ 5,000` cents and the instrument is dated ≥ March 1999 and `partial_count_12m < 3`, the agent may instead apply the payment and reduce escrow by the deficiency (C-1.1-02), recording the count. On day-30 expiry with no completion, return the funds to the borrower by the original rail (ACH credit or check) unless the loan is in an active loss-mit case (2.6) — never keep partials indefinitely.
4. **Unidentified receipts**: research ≤ 30 days; return to the remitter ≤ 60 days when the remitter is known (ACH: originate a credit to the originating account **[or use the RDFI return window where still open — rail-specific]**; check: refund check to the remitter's address from the image); if the remitter is unknown, hold and start the unclaimed-property clock (`dormancy_start_on = received_on`).
5. **Overpayments/post-payoff receipts**: refund within 10 BD (policy) unless the borrower elects curtailment (2.4) — the crediting rules of 2.4 apply; escrow refunds after payoff within 20 business days (federal calendar) per §1024.34(b) — the funds leave T&I via `refund.issued`.
6. **Aging** = `current_date − received_on` (calendar days), computed daily; Form 496A line 4 = Σ open items at period end; Section III "unapplied funds that need resolution" lists items > 30 days with reason, loan number (if any), amount and aging.
7. **Escheat computation**: `presumed_abandoned_on = dormancy_start_on + dormancy_years(state)`; `report_cycle` = the cycle whose window (July 1–June 30 default) contains `presumed_abandoned_on`; `report_due_on` = Nov 1 of that cycle year (override per state); due-diligence window = [`filing_date − 180`, `filing_date − 60`] for amounts ≥ $50 (override). The NAUPA II file is generated per state with the officer's verification.
8. **Worked example A (partial)**: PITI P = 184,217 cents. 2026-10-03 receipt 150,000 cents; conditions met; `partial_commitment_due_on` = 2026-11-02. 2026-10-20 receipt 34,217 → Σ = 184,217 ≥ P → apply one payment with `credited_as_of` = 2026-10-20; 2.7 decides the late charge (due 10/01, grace to 10/16 → assessable, subject to 2.7's rules); periodic statement (7.1) for the cycle shows the $1,500.00 held on 10/03 and $0.00 after 10/20. Had nothing arrived by 11/02, the $1,500.00 returns to the borrower on 11/03 by ACH credit to the originating account, with a notice (`SUSP-PARTIAL-RETURN-v1`).
9. **Worked example B (unidentified ACH)**: 2026-10-07 BAI2 165 credit 125,000 cents, memo "J SMITH". Candidates: three borrowers named J. Smith; one (loan 4471) has P = 125,000 cents and ACH last4 "8831" matching the credit's originator account → score 0.99; the others score 0.41/0.38 → auto-apply to loan 4471 as of 10/07; decision record stores the evidence; the 6.3 item `bank_credit_unposted` is cleared the same day.
10. **Worked example C (escheat)**: refund check 21,455 cents issued 2026-03-01 to a Texas borrower; stale 2026-08-28; void; skip-trace fails; no indication of interest since 2026-03-01 → `dormancy_start_on` 2026-03-01; Texas dormancy assumed 3 years **[UNVERIFIED for TX]** → presumed abandoned 2029-03-01; cycle July 1 2028–June 30 2029 → report before 2029-11-01; due-diligence notice between 2029-05-05 and 2029-09-02 (≥ $50 threshold met); `officer` signs the verification; remittance with the report.

#### Integrations
- **Lockbox** (`lockbox` adapter): remittance data + images (BAI2 lockbox detail / bank CSV) for payer/memo/MICR **[bank-specific]**; OCR of check images for handwritten loan numbers/addresses.
- **ACH** (`nacha` adapter): inbound WEB/PPD credits with originator account data; outbound PPD/CCD credits for returns and refunds; return-code handling (R01–R29) for failed refunds.
- **Custodial bank** (`custodial-bank`): the 6.3/6.4 engine supplies `bank_credit_unposted` lines; refund checks through positive pay.
- **Borrower communications** (`borrower-comms` agent; telephony/SMS/email/mail vendors): outbound contact for intent/commitment with AI disclosure and TCPA consent gating; results logged as `contacts`.
- **Skip-trace / address vendor**: for lost payees before escheat **[vendor-specific]**.
- **State unclaimed-property programs**: NAUPA II file per state; upload/e-file by the `officer` (or ops staff under officer verification) through state portals; remittance by ACH/check; confirmations stored **[state-specific; no Fannie Mae constraint]**.
- **Fannie Mae**: none directly; Form 496A line 4 (6.4); no LSDU/Servicing Platform event for suspense (escrow events do not include unapplied funds — cross-check with 5.x category rules **[UNVERIFIED]**).

#### Outputs and artifacts
- Notices (Notice Registry): `SUSP-PARTIAL-HOLD-v1` (partial payment held; amount, balance due, 30-day date; channel per E-SIGN consent; citation C-1.1-02 + Reg Z §1026.41(d)(3) via 7.1), `SUSP-PARTIAL-RETURN-v1` (funds returned and why), `SUSP-UNIDENTIFIED-RETURN-v1` (to remitter), `SUSP-REFUND-v1` (overpayment refund with computation), `UP-DUE-DILIGENCE-v1` (state-mandated unclaimed-property notice: heading per RUUPA §502(a) "may be transferred to the custody of the [state administrator] if you do not contact us before (date 30 days after notice)"; always mailed first-class; state variants keyed by `jurisdiction_rules`).
- Periodic statement suspense disclosure (7.1) sourced from `suspense_items` (Reg Z §1026.41(d)(3)).
- Ledger: `suspense_liability` postings, applications (via 2.1), returns/refunds, escheat remittances; each linked to `loan_events` (`suspense.item.*`).
- Reports: daily aging, weekly register (reviewed by `qc-audit`), monthly Form 496A Section III unapplied list, annual unclaimed-property reports (NAUPA II files, officer verification, state confirmations).

#### AI agent design (AI-first)
`custodial-recon` agent (suspense module) with tools `suspense.read/write`, `payments.history`, `borrowers.search` (fuzzy), `lockbox.image_ocr`, `ledger.apply_via_cashiering` (calls 2.1's command — the agent never allocates directly), `nacha.originate_credit`, `check.issue`, `contact.request` (hands to `borrower-comms`), `unclaimed_property.compute`, `naupa.generate`, `escalation.create`, `timer.*`. Structured decision: `{item_id, candidates[{loan_id, score, evidence[]}], action ∈ {apply, hold_partial, contact, return, refund, escheat_track, escalate}, credited_as_of, rule_refs[], confidence}`. Guardrails: no application below 0.97 without borrower confirmation; no return of funds to a payer that is not the verified originator/remitter; no write-off above $5.00; any return > $10,000 to a non-borrower → `officer`; contact attempts respect `consents` (TCPA), quiet hours and AI disclosure (baseline §8(6)); borrower request for a human → `human_agent` warm transfer. Escalations: `officer` (write-offs, escheat verification/filing, large non-borrower returns, aged > 90 days), `human_agent` (borrower request), `attorney` only via the bankruptcy/foreclosure case owner when a hold reason involves litigation, `licensed_specialist` never. Human path when AI off: ops-console "Suspense Queue" with the same matching engine and command guards; humans cannot bypass Reg Z accumulation application (enforced in the ledger command).

#### Edge cases and failure modes
- Transfer-in with inherited suspense: keep the transferor's `received_on` for aging and dormancy; Reg Z crediting applies from the platform's receipt of the funds (1.6 reconciles).
- Transfer-out: open items wire with the loan; items without a loan stay with Supermortgage (return/escheat).
- Bankruptcy: trustee payments and post-petition payments follow the bankruptcy case rules; suspense `bankruptcy_hold` items are applied per plan — no 30-day return clock.
- Foreclosure: post-referral partial payments may be refused/returned under state law and Fannie Mae reinstatement rules — the foreclosure case owner decides; the item carries `foreclosure_hold`.
- Loss-mitigation trial (2.6): trial payments are not "partial payments"; they follow the trial rules — excluded from the 30-day return clock.
- Successor in interest: payments from a potential successor are third-party payments until confirmation (4.4); accepted and applied unless a hold applies.
- Disputed items (NoE 4.1): freeze return/refund until resolution; the NoE timer governs.
- Deceased borrower / estate refunds: refund payee = estate on documentation; else unclaimed-property track.
- Duplicate ACH debit by our own autodraft (2.3): refund within 10 BD (policy) and Nacha error-resolution rules; Reg E may apply to consumer electronic debits (note).
- Vendor outage (lockbox images unavailable): identification falls back to data fields; triage timer still runs; no auto-apply below threshold.
- Escheat filing rejected by a state (format) → resubmit; the report deadline is a state law deadline, so `officer` critical escalation on any rejection within 10 days of the due date.
- Interest on unapplied funds: none accrues to the borrower unless state law requires (rare) **[UNVERIFIED]**; bank interest on the `ti_unapplied` account follows 6.2.

#### Test cases and acceptance criteria
- 6.5-T1 Given P = $1,842.17, receipts $1,500.00 (10/03) and $342.17 (10/20) with conditions met, then one payment is applied `credited_as_of` 2026-10-20, suspense = $0.00, both notices/statement lines produced; timer `FNMA_C1102_PARTIAL_BALANCE_30` satisfied.
- 6.5-T2 Given the same first receipt and nothing by 2026-11-02, then on 2026-11-03 the $1,500.00 is returned by ACH to the originating account, `SUSP-PARTIAL-RETURN-v1` sent, status `returned`.
- 6.5-T3 Given a payment $1,800.00 vs P $1,842.17 (deficiency $42.17), instrument dated 2005, `partial_count_12m = 2`, then the $50 rule applies (escrow reduced by $42.17, payment applied as of receipt) and the count becomes 3; a fourth such payment within 12 months is treated as an ordinary partial.
- 6.5-T4 Given the "J SMITH" $1,250.00 ACH credit with a 0.99 unique candidate, then auto-applied same day; given two candidates at 0.85/0.83, then `contact_pending` and no application.
- 6.5-T5 Given an unidentified check receipt on 10/07 with remitter address on the image and no match by 11/06 (30 days), then a refund check to the remitter is issued by 12/06 (60 days) at the latest; given no remitter data, then `escheat_pending` with `dormancy_start_on` = 10/07.
- 6.5-T6 Given Σ unapplied on a loan reaches P on a Friday, then the application is posted with `credited_as_of` Friday even if the job runs Monday (Reg Z), and the `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD` timer is satisfied.
- 6.5-T7 Given a stale refund check (issued 2026-03-01, Texas), then dormancy 2029-03-01, cycle FY2029, report due before 2029-11-01, due-diligence window 2029-05-05 to 2029-09-02, officer verification task created 2029-09-15 (policy lead), NAUPA II file generated.
- 6.5-T8 Given an item aged 90 days in `researching`, then `officer` high escalation and the partner aging report line.
- 6.5-T9 Given a borrower on an AI outreach call asks for a person, then warm transfer to `human_agent` and the contact record shows `mode = ai_voice`, disclosure given, transfer time.
- 6.5-T10 Given a write-off attempt of $7.25, then rejected (limit $5.00) unless `officer` overrides with reason.

#### Audit and evidence
Full `suspense_items` history with actions, candidates and scores, decision records (model/prompt/rule-set versions), Reg Z crediting dates, notices with delivery proof, contact logs with consent evidence, return/refund rails and confirmations, weekly reviewer records, Form 496A Section III listings, unclaimed-property notices, reports, officer verifications and state confirmations, timer histories. Supports Reg X §1024.35 error-resolution defense, state exams (unclaimed property audits), Fannie Mae MORA (A4-1-01 unapplied-funds procedures) and Reg AB/USAP testing.

### Open questions / decisions
1. Unidentified-funds return horizon — default 60 days (30 research + 30 return); partner may prefer 90.
2. Auto-apply threshold — default 0.97 unique candidate; lower thresholds require borrower confirmation.
3. Refund horizon for overpayments/post-payoff receipts — default 10 BD (policy; no Fannie Mae/Reg X number except the 20-BD escrow refund).
4. Escheat filing execution — default: AI-prepared NAUPA II files, `officer` verifies and files via state portals; consider an unclaimed-property vendor above ~500 items/year.
5. Whether partial payments during the foreclosure process are accepted — default: follow the foreclosure case owner's state-rule decision; funds return when refused.

### Sources
- A4-1-02 (07/12/2023); A4-1-01 (02/12/2025); F-1-03 (05/13/2026); C-1.1-01 (04/12/2023); C-1.1-02 (08/13/2025): https://servicing-guide.fanniemae.com/svc/c-1.1-02/processing-payment-shortages-or-funds-received-when-mortgage-loan-modification-pending — verified 2026-09-09
- Form 496A instructions (© 2026): https://singlefamily.fanniemae.com/media/23536/display — verified 2026-09-09
- 12 CFR 1026.36(c): https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-E/section-1026.36 — eCFR current as of 2026-09-04; 12 CFR 1024.34: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.34 — current as of 2026-09-03; verified 2026-09-09
- Revised Uniform Unclaimed Property Act (2016) text: https://compacts.csg.org/wp-content/uploads/2024/03/Uniform-Unclaimed-Property-Act.pdf — verified 2026-09-09; ULC RUUPA page: https://www.uniformlaws.org/committees/community-home?CommunityKey=4b7c796a-f158-47bc-b5b1-f3f9a6e404fa
- Freddie Mac custodial guide (benchmark, Nov. 2023): https://sf.freddiemac.com/docs/pdf/fact-sheet/custodial.pdf — verified 2026-09-09
- Research 00a §1.4/§5.6 (TCPA, AI disclosure), 00b N10 (Nacha), N9 (print/mail).
