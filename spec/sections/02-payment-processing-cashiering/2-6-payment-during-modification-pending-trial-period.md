# 2.6 — Payment during modification pending (trial period)

| Attribute | Value |
|---|---|
| Section | 2 — Payment Processing & Cashiering |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | On receipt during trial |
| Governing source | FNMA C-1.1-02 |
| Key deadlines | Per trial plan |
| Timers | `FNMA_C1102_TRIAL_RESIDUAL_BEFORE_EFFECTIVE_0`, `FNMA_D23206_LC_WAIVE_ON_CONVERSION_0`, `FNMA_D23206_TRIAL_PAYMENT_EOM`, `FNMA_F122_TRIAL_PAYMENT_SMDU_REPORT_1BD`, `FNMA_F127_LC_NOT_CAPITALIZED_GATE`, `REGX_1024_41G_TRIAL_PERFORMING_FC_GATE`, `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD`, `SM_TRIAL_FAILED_FUNDS_RESOLVE_30` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Cashiering |
| Trigger & frequency | On receipt during trial |
| Governing source (blueprint) | FNMA C-1.1-02 |
| Key deadlines (blueprint) | Per trial plan |
| Data/artifacts | Trial ledger |
| Systems | SMDU |
| Automation class (blueprint) | b |
| SoR / Sub | Sub |
| Nuances (blueprint) | (blank in source) |

### Verified requirement (as of 2026-09-09)

**C-1.1-02 (08/13/2025), "Processing Funds Received When a Mortgage Loan Modification Is Pending":** "During any Trial Period Plan, and if permitted by the applicable loan documents, the servicer must accept and hold (as unapplied funds in a custodial account) trial period payments received which do not constitute a full monthly contractual payment." When held trial payments total a full PITI payment, "the servicer must apply all full payments to the mortgage loan." "Any unapplied funds remaining at the end of the Trial Period Plan which do not constitute a monthly, contractual PITI payment must be applied to reduce any amounts that would otherwise be capitalized onto the principal balance." The topic does not say what to do when a trial fails or when the borrower pays more than the trial amount. URL in 2.2 Sources (verified 2026-09-09).

**D2-3.2-06, Fannie Mae Flex Modification (04/08/2026):** trial length "three months long" for loans 31+ days delinquent, "four months long" if current or less than 31 days delinquent; first trial payment due "the first day of the following month" when the Evaluation Notice is sent on or before the 15th, otherwise "the first day of the month after the next month"; "If the borrower fails to make a Trial Period Plan payment by the last day of the month in which it is due, the borrower is considered to have failed the Trial Period Plan and the servicer must not grant the borrower a permanent Fannie Mae Flex Modification"; the modification is binding only when the borrower has satisfied all trial requirements, returned the executed Loan Modification Agreement (Form 3179) and the servicer/Fannie Mae has executed it. "Handling Fees and Late Charges": "The servicer must not charge the borrower administrative fees"; "The servicer is authorized to assess late charges during the Trial Period Plan"; "The servicer must waive all late charges, penalties, stop payment fees, or similar charges upon the borrower's conversion to a permanent mortgage loan modification." URL: https://servicing-guide.fanniemae.com/svc/d2-3.2-06/fannie-mae-flex-modification (verified 2026-09-09). **F-1-27 (08/13/2025):** "Late charges may not be capitalized and must be waived if the borrower satisfies all conditions of the Trial Period Plan"; the Loan Modification Agreement must be prepared so that "the mortgage loan modification becomes effective on the first day of the month following the Trial Period Plan." URL: https://servicing-guide.fanniemae.com/svc/f-1-27/processing-fannie-mae-flex-modification (verified 2026-09-09). **F-1-22 (10/11/2023):** "Report loan-level data in Fannie Mae's servicing solutions system upon receipt of the borrower's first Trial Period Plan payment and all subsequent Trial Period Plan payments under the Trial Period Plan"; if the borrower does not make all trial payments, "cancel the case in Fannie Mae's servicing solutions system"; on completion "update the Officer Signature Date … to close the mortgage loan modification." The "servicing solutions system" is SMDU since HSSN's retirement on Dec. 1, 2025 (research/00a §3.1). URL: https://servicing-guide.fanniemae.com/svc/f-1-22/reporting-workout-option-fannie-maes-servicing-solutions-system (verified 2026-09-09). LL-2026-01 (eff. May 1, 2026): post-evaluation payments reducing delinquency do not affect disaster Flex Mod eligibility if the loan was ≥30 days delinquent before the trial (00a §3.2). Payment Deferral (D2-3.2-04) has no trial; a deferral in process is a 12.6 hold, not a trial.

**Reg Z/Reg X.** Trial payments below the contractual PITI are partial payments under 1026.36(c)(1)(ii) — statement disclosure (1026.41(d)(3)/(d)(5); 7.1 renders the trial-payment "amount due" per its own rules) and application on accumulation as of the accumulation date. Holding them does not violate (c)(1)(i) so long as the delay "does not result in any charge to the consumer or in the reporting of negative information" — hence late charges are accrued-but-suspended and waived on conversion, and credit reporting carries the trial/plan status codes (8.1). Reg X 1024.41(g) bars foreclosure sale/first notice while the borrower is performing under an agreement on a loss-mitigation option (13.2 gate `REGX_1024_41G_*`); 1024.41(f)(3)'s NPRM fee restriction is behind the `regx.lossmit.2024nprm` flag (00a §1.2 item 4).

**Discrepancies with the blueprint row.** (a) "Per trial plan" resolves to concrete clocks: each trial payment by the last day of its month; SMDU reporting "upon receipt"; residual application before the modification's first-of-month effective date; late-charge waiver at conversion. (b) Automation class "b" (partial) is unnecessary for cashiering — every step here is deterministic; the human touchpoints belong to 12.8 (`lossmit_reviewer` on denials) and to `fnma_portal_operator` only if SMDU B2B is not yet onboarded. (c) "Trial ledger" is not a separate ledger: trial funds live in `suspense_unapplied`/`custodial_ti_unapplied_cash` with `reason_code=pending_modification_hold` and a `trial_payment_schedules` projection.

### Operational prerequisites
- SMDU B2B connectivity (`fnma-smdu`, System ID under Form 101) with the trial-payment data submission enabled — or the `human_portal_task` runbook for the SMDU UI; Supermortgage/partner; 2–6 months (00b F1).
- 12.8 Flex Mod engine producing `trial_payment_schedules` (trial P&I, escrow, due dates, count, first-due rule) and the Evaluation Notice with the trial terms; Form 3179 workflow.
- Statement template variant for trial periods (7.1) and credit-reporting code mapping for trial status (8.1).
- `ti_unapplied` custodial account (6.2).

### Build spec
#### Inputs and triggers
- `lossmit.trial.offered` / `lossmit.trial.started` (12.8) with schedule; `lossmit.trial.cancelled`, `lossmit.modification.effective` (Form 3179 executed; effective date), `lossmit.deferral.pending` (hold only).
- `payment.received` on a loan with an active trial (any channel, any amount).
- Month-end sweep `trial.payment.eom_check` (last day of each trial month, 23:59 servicer local); `trial.residual.apply` when the trial completes.
- SMDU acknowledgements (`fnma-smdu` responses) or `human_portal_task.completed`.

#### Data model
- `trial_payment_schedules` (new; owned by 12.8, consumed here): `case_id`, `loan_id`, `trial_number` (1..n), `due_date`, `trial_amount_cents` (modified P&I + escrow), `received_cents` (cumulative for that trial month), `satisfied_on`, `status` ∈ {due, satisfied, missed}, `smdu_reported_at`, `smdu_ack_ref`.
- `suspense_items.reason_code='pending_modification_hold'` items with `case_id`; `partial_payment_evaluations.rule_path='apply_trial'`.
- `trial_funds_summary` (projection): `case_id`, `held_cents`, `contractual_applied_cents`, `installments_satisfied[]`, `residual_at_end_cents`, `capitalization_reduction_cents`.
- `fees` rows with `fee_type=late_charge` and `state='accrued_suspended'` + `suppression_reason='trial_pending_waiver'` (2.7).
Retention `life_of_loan_plus_4y`.

#### State machine
Trial cashiering overlay (per case): `trial_active` → (each month: receipt ≥ trial amount by month-end → `trial_payment.satisfied`; else at month-end → `trial_payment.missed` → 12.8 `trial.failed`) → `trial_completed` (all satisfied; residual applied to capitalization; late charges waived) → `modification_effective` (overlay removed; new `loan_terms`) | `trial_failed` (overlay removed; unapplied funds resolved per rule 6; SMDU case cancelled). Actors: engine (receipts/month-end), `cashiering` agent (residual, waiver package), `lossmit-underwriter` agent (12.8 decisions), `investor-reporting`/`fnma_portal_operator` (SMDU).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_D23206_TRIAL_PAYMENT_EOM` | deadline (one per trial month) | `lossmit.trial.started` (schedule row) | trial `due_date` | last calendar day of that month, 23:59 servicer local (receipts by the channel cut-off count; grace beyond month-end: none) | `trial_payment.satisfied` (cumulative receipts in the month ≥ `trial_amount_cents`) | `trial_payment.missed` → 12.8 fails the trial; SMDU case cancelled (F-1-22) |
| `FNMA_F122_TRIAL_PAYMENT_SMDU_REPORT_1BD` | deadline | `trial_payment.satisfied` (and each trial receipt) | `received_on` | 1 `business_days_fannie_et` (Guide: "upon receipt"; policy 1 BD) | `smdu_reported_at` (B2B ack or `human_portal_task.completed`) | sev-2 → `fnma_portal_operator` package |
| `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD` | (6.5) | Σ held trial funds ≥ contractual PITI | accumulation date | 1 BD | contractual installment applied | `officer` |
| `FNMA_C1102_TRIAL_RESIDUAL_BEFORE_EFFECTIVE_0` | deadline | `lossmit.trial.completed` | modification effective date − 1 | before the modification is booked (12.8's booking command asserts this gate) | `trial.residual.applied` (capitalization reduced) | booking refused; sev-2 |
| `FNMA_D23206_LC_WAIVE_ON_CONVERSION_0` | deadline | `lossmit.modification.effective` | effective date | same day | all `late_charge` fees on the loan `waived` | booking blocked (12.8 asserts); sev-2 |
| `FNMA_F127_LC_NOT_CAPITALIZED_GATE` | not_before_gate | modification capitalization computation | — | capitalized amount excludes `late_charges` | 12.8 computation | refused |
| `REGX_1024_41G_TRIAL_PERFORMING_FC_GATE` | (13.2) | trial active and performing | — | no FC sale/first notice | — | (13.2) |
| `SM_TRIAL_FAILED_FUNDS_RESOLVE_30` | deadline | `lossmit.trial.failed` with held funds | failure date | 30 calendar days | funds applied (if ≥ PITI), applied to a successor workout, or returned | `custodial-recon` aging (6.5) |

Jurisdiction overrides: none.

#### Business rules and calculations
1. **Trial amount and count** come from 12.8 (`trial_payment_schedules`): trial P&I from the Flex Mod waterfall (F-1-27) plus the workout escrow payment (3.2 workout analysis, 60-month shortage spread); 3 payments (≥31 days delinquent) or 4 (current/<31 days).
2. **Receipts during the trial.** Every receipt on the loan is first credited to the current trial month's `received_cents` (cumulative) — a month is satisfied when cumulative receipts in that month ≥ `trial_amount_cents` (borrowers may pay in pieces; overpayments carry to the next trial month's count only if the borrower instructs, else remain held). Funds are held as `pending_modification_hold` unless Σ held ≥ contractual PITI (pre-modification P), in which case one contractual installment (oldest unpaid) is applied via the Allocation Engine with `credited_as_of` = accumulation date (C-1.1-02 "must apply all full payments"), keeping the remainder held.
3. **Late charges during the trial.** Installments falling due during the trial are assessed under the note into `fees{late_charge, state=accrued_suspended, suppression=trial_pending_waiver}` — not billed, not collected from trial funds, not reported as due; on conversion all late charges on the loan (pre-trial and trial-period) are waived (`fee.waived{reason=trial_conversion}`), none capitalized; on failure the suspended charges become collectible (D2-3.2-06 "authorized to assess").
4. **SMDU reporting.** Each trial receipt that satisfies (or contributes to) a trial month is reported "upon receipt" (target same day, deadline 1 BD) through `fnma-smdu` B2B (name/value XML, 00b F1) or, until onboarded, a `human_portal_task` package: loan number, case id, trial number, amount, receipt date, cumulative status. Delinquency status reporting continues through 5.7 with the trial status.
5. **Trial completion.** On the last trial month's satisfaction: compute `residual = Σ held − Σ applied`; `trial.residual.applied` reduces the amounts to be capitalized (arrearages: unpaid interest, escrow advances, servicing advances per F-1-27) in 12.8's capitalization computation — the residual is booked as a payment of arrears (interest first, then escrow advances) on the day before the effective date; if the residual exceeds the capitalizable amount, the excess is a curtailment of the modified UPB **[policy — Guide silent]**.
6. **Trial failure.** Overlay removed; SMDU case cancelled (F-1-22); held funds: if Σ ≥ contractual PITI → apply installments (C-1.1-02); remainder → `partial_payment` under 2.2 with borrower contact (12.x may re-solicit); at 30 days with no successor workout, return per 2.2/6.5; suspended late charges become collectible; 13.x gates re-evaluated (1024.41(g) protection ends only per 13.2 rules).
7. **Postings.** Hold: Dr `clearing_cash` / Cr `suspense_unapplied`; Dr `custodial_ti_unapplied_cash` / Cr `clearing_cash`. Contractual application: as 2.2 rule 7. Residual application at completion: Dr `suspense_unapplied` / Cr `interest_due` (arrears), Cr `escrow_advances`/`escrow` (advances recovered), cash moved to `custodial_pi_cash`/`custodial_ti_cash` accordingly; the investor event stream reports the contractual applications (`payment.contractual`) during the trial and the modification itself via SMDU/5.1 (IRM 4-03: one post-modification LAR).
8. **Worked example J.** Fixture L-1 variant: LPI 2026-06-01, UPB 24,977,400¢; installments 07/01, 08/01, 09/01 unpaid (P = 219,257¢); late charges assessed 07/17, 08/17, 09/17: 3 × 7,901¢ = 23,703¢. Evaluation Notice sent 2026-09-10 (≤ 15th) → trial payments due 2026-10-01, 11-01, 12-01 (three; loan 90+ days delinquent); trial amount = modified P&I 131,900¢ + workout escrow 64,000¢ = **195,900¢**. Receipts: 2026-10-01 195,900¢ → trial 1 satisfied; held Σ 195,900 < 219,257 → all held; SMDU reported 2026-10-01; late charge for the 10/01 installment assessed 10/17 as `accrued_suspended` (7,901¢). 2026-11-02 195,900¢ → trial 2 satisfied; Σ 391,800 ≥ 219,257 → apply the 07/01 installment: interest 24,977,400 × 0.065 ÷ 12 = 135,294¢, principal 22,723¢, escrow 61,240¢ (pre-mod escrow payment), `credited_as_of` 2026-11-02, LPI → 2026-07-01, UPB → 24,954,677¢; held → 172,543¢; `payment.contractual` emitted. 2026-12-01 195,900¢ → trial 3 satisfied; Σ 368,443 ≥ 219,257 → apply 08/01: interest 24,954,677 × 0.065 ÷ 12 = 135,171¢, principal 22,846¢, escrow 61,240¢; LPI → 2026-08-01; UPB → 24,931,831¢; held → **149,186¢**. 2026-12-31 trial complete; 2027-01-01 modification effective: residual 149,186¢ reduces capitalization — arrears to capitalize before residual = unpaid interest for 09/01–12/01 installments computed on 24,931,831¢: 4 × (24,931,831 × 0.065 ÷ 12 = 135,047.4 → 135,047¢) = 540,188¢ **[illustrative — F-1-27 computes interest on the UPB through the effective date]** plus escrow advances; after the residual: 391,002¢ of interest capitalized; late charges 23,703 + 3 × 7,901 (10/01, 11/01, 12/01) = **47,406¢ waived**, none capitalized; SMDU Officer Signature Date updated; new `loan_terms` effective 2027-01-01. Had the 2026-12-01 payment arrived 2027-01-02, trial 3 would be `missed` at 2026-12-31 23:59 → trial failed, case cancelled, held 172,543¢ < P → `partial_payment` path with borrower contact.

#### Integrations
- **SMDU** (`fnma-smdu`, 00b F1): B2B XML name/value submissions for trial-payment data and case status; responses parsed into `smdu_ack_ref`; sandbox: SMDU CIT/test environment via the Integration Team; failure → retry, then `human_portal_task` package {loan number, Fannie Mae loan number, case id, trial number, amount, receipt date, cumulative, screenshots not required}; **no browser automation**.
- **Loss-mit case** (12.8): schedule in, completion/failure out; **statements** (7.1): trial amount due, held funds, instructions; **credit reporting** (8.1): trial status; **delinquency reporting** (5.7): status/reason codes; **foreclosure** (13.2): performing-trial gate.
- **Custodial** (6.2/6.5): `ti_unapplied` balances and aging (trial items excluded from the 30-day return clock while active).

#### Outputs and artifacts
- Notices: `TRIAL-PAYMENT-RECEIVED-v1` (optional confirmation; electronic with consent), `TRIAL-FUNDS-APPLIED-v1` (explains contractual application during the trial), `TRIAL-COMPLETE-FUNDS-v1` (residual applied to reduce capitalization; late charges waived — may be part of 12.8's modification package), `TRIAL-FAILED-FUNDS-v1` (what happens to held funds). Citations: C-1.1-02; D2-3.2-06; F-1-27.
- Records/events: `trial_payment.received`, `trial_payment.satisfied`, `trial_payment.missed`, `trial.smdu.reported`, `trial.residual.applied`, `fee.waived{trial_conversion}`, plus 2.1/2.2 events; investor events for contractual applications; `human_portal_task` records when used.

#### AI agent design (AI-first)
`cashiering` agent applies the deterministic rules and handles judgment items: borrower instructions to apply overpayments, residual allocation questions, failed-trial fund disposition; `lossmit-underwriter` owns the trial decision itself; `investor-reporting` or `fnma_portal_operator` reports to SMDU. Tools: `trial_schedule.read`, `suspense.read/write`, `ledger.apply_via_cashiering`, `fees.suspend/waive`, `smdu.submit_trial_payment` (B2B) / `human_portal_task.create`, `notice.send`, `borrower_comms.request_contact`. Decision record: `{case_id, receipt_id, trial_month, cumulative, contractual_applied?, residual_calc, smdu_submission_ref, rationale}`. Guardrails: cannot mark a trial month satisfied below the trial amount; cannot apply late charges from trial funds; cannot book the modification while residual/waiver gates are open; cannot return trial funds during an active trial. Escalations: `fnma_portal_operator` (SMDU UI when B2B unavailable), `human_agent` on request, `lossmit_reviewer` only via 12.8 (denials/failures are adverse determinations reviewed there). Human path when AI off: Trial Queue with the same gates.

#### Edge cases and failure modes
- **Transfer-in mid-trial** (1.7): schedule and held funds inherited; SMDU case ownership moves with Form 629; month-end clocks continue.
- **Transfer-out mid-trial**: funds and schedule transferred; 17.4.
- **Bankruptcy filed during trial**: overlay `bankruptcy_hold` coexists; trial continues per 14.x/12.8 rules (Fannie Mae permits trials in bankruptcy with counsel involvement) **[UNVERIFIED specifics]**.
- **SCRA**: modified terms already reflect any cap; trial amounts from 12.8.
- **Disaster Flex Mod** (LL-2026-01): post-evaluation payments reducing delinquency do not affect eligibility — the engine does not cancel a trial because contractual installments were applied from held funds.
- **Borrower pays the full contractual PITI instead of the trial amount**: counts as the trial payment (≥ trial amount) and is applied as a contractual installment on accumulation.
- **Overpayment in a trial month**: held; the borrower may direct it to the next trial month.
- **Escrow payment change during the trial** (3.2 interim analysis): trial amount is fixed by the plan; differences settle at modification.
- **SMDU rejects the trial-payment submission**: retry; if data mismatch (LPI/UPB vs Fannie Mae), 5.1's position reconciliation; the Guide deadline is "upon receipt," so escalate within the same business day.
- **Trial month with a returned item**: the reversal reduces `received_cents`; if the month is then short at month-end, the trial fails — the agent contacts the borrower immediately on return to allow replacement funds before month-end.
- **Payment deferral pending** (12.6): no trial; funds follow normal allocation unless 12.6 places a hold.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 2.6-T1 | Given a 3-month trial with amount 195,900¢, when 195,900¢ arrives 2026-10-01, then trial 1 is satisfied, funds are held, SMDU submission is made within 1 BD, and no contractual installment is applied. |
| 2.6-T2 | Given 2.6-T1, when 195,900¢ arrives 2026-11-02, then the 07/01 installment is applied with `credited_as_of` 2026-11-02, held = 172,543¢, and one `payment.contractual` event is emitted. |
| 2.6-T3 | Given trial 3 unpaid at 2026-12-31 23:59, when the month-end sweep runs, then `trial_payment.missed` fires, 12.8 fails the trial, the SMDU case is cancelled, suspended late charges become collectible, and held funds follow 2.2. |
| 2.6-T4 | Given all trial payments satisfied, when 12.8 books the modification, then the residual 149,186¢ has been applied to capitalizable arrears first and all late charges are waived; a booking attempt with an unwaived late charge is refused. |
| 2.6-T5 | Given a trial receipt on a loan whose statement cycle closes the next day, when 7.1 renders, then held trial funds are disclosed with instructions. |
| 2.6-T6 | Given SMDU B2B is unavailable, when a trial payment is received, then a `human_portal_task` with the full package is created and its SLA timer is the same 1 BD. |
| 2.6-T7 | Given a returned trial payment on 2026-11-20, when processed, then `received_cents` for November decreases, the borrower is contacted the same day, and a replacement received 2026-11-30 satisfies the month. |
| 2.6-T8 | Given the borrower pays 219,257¢ in a trial month, when posted, then the trial month is satisfied and a contractual installment is applied on accumulation. |

#### Audit and evidence
Trial schedule versions, per-receipt cumulative computations, accumulation applications with `credited_as_of`, SMDU submissions/acks (or portal task evidence), residual computation and capitalization reduction, late-charge suspension/waiver records, month-end sweep logs, notices, and `agent_decisions` — the evidence set for Fannie Mae workout QC (F-1-27), MORA and 1024.41 litigation.

### Open questions / decisions
1. **Late charges during trial** — default: assess as `accrued_suspended` (never billed), waive on conversion, collectible on failure; alternative: do not assess at all (simpler, more generous).
2. **Residual exceeding capitalizable arrears** — default: curtail the modified UPB with the excess.
3. **Failed-trial funds** — default: apply installments if ≥ PITI, otherwise hold 30 days with borrower contact, then return.
4. **SMDU channel** — default: B2B from day one of Stage 2; `human_portal_task` fallback with a 1-BD SLA.

### Sources
- C-1.1-02 (08/13/2025) — 2.2 Sources; D2-3.2-06 (04/08/2026): https://servicing-guide.fanniemae.com/svc/d2-3.2-06/fannie-mae-flex-modification ; F-1-27 (08/13/2025): https://servicing-guide.fanniemae.com/svc/f-1-27/processing-fannie-mae-flex-modification ; F-1-22 (10/11/2023): https://servicing-guide.fanniemae.com/svc/f-1-22/reporting-workout-option-fannie-maes-servicing-solutions-system (all verified 2026-09-09)
- 12 CFR 1026.36(c)(1) and 1026.41(d) (2.1/2.2 Sources); research/00a §3.1–3.2, §3.8 (SMDU/HSSN, LL-2026-01, Flex Mod trial rules)
