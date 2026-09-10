# 12.6 — Payment Deferral

| Attribute | Value |
|---|---|
| Section | 12 — Loss Mitigation |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | Resolved hardship (borrower can resume the full contractual payment but cannot reinstate or afford a repayment plan; 2–6 months delinquent) |
| Governing source | FNMA D2-3.2-04 |
| Key deadlines | Solicit by 15th of following month if no QRPC; ≤12 mos cumulative deferred P&I over life |
| Timers | `FNMA_B101_ESCROW_ANALYSIS_BEFORE_OFFER`, `FNMA_D2205_EVAL_NOTICE_DEFERRAL_5`, `FNMA_D23204_AGREEMENT_SEND_5`, `FNMA_D23204_CONTRACTUAL_PAYMENT_GATE`, `FNMA_D23204_CUSTODIAN_25`, `FNMA_D23204_DEFERRAL_ELIGIBILITY_GATES`, `FNMA_D23204_DEFERRAL_SMDU_ENTRY_EOM`, `FNMA_D23204_PROCESSING_MONTH_ELECTION_15TH`, `FNMA_D23204_RECORDED_ORIGINAL_5BD`, `FNMA_D23206_POSTDEFERRAL_FLEX_SOLICIT_75`, `FNMA_F122_DEFERRAL_LAR_BEFORE_EOM_1BD`, `FNMA_F202_DEFERRAL_INCENTIVE_CLAIM`, `REGX_1024_41E1_ACCEPT_14`, `SM_DEFERRAL_SOLICIT_ACCEPT_WINDOW`, `TX_50A6_DEFERRAL_NOTICE_7BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Loss Mit |
| Trigger & frequency | Resolved hardship (borrower can resume the full contractual payment but cannot reinstate or afford a repayment plan; 2–6 months delinquent) |
| Governing source (blueprint) | FNMA D2-3.2-04 |
| Key deadlines (blueprint) | Solicit by 15th of following month if no QRPC; ≤12 mos cumulative deferred P&I over life |
| Data/artifacts | Deferral agreement |
| Systems | SMDU |
| Automation class (blueprint) | b |
| SoR / Sub | Sub |
| Nuances (blueprint) | (blank in source) |

### Verified requirement (as of 2026-09-09)

**Sources verified:** Fannie Mae D2-3.2-04 Payment Deferral (08/13/2025), F-1-22 (10/11/2023), F-2-02 ($500), F-2-06 (MI delegations), B-1-01 (09/11/2024), A1-3-06 (MBS), D2-3.2-01/-02 (post-plan solicitation), SMDU UI Payment Deferral Options User Guide (landing page only); 12 CFR 1024.41(c)(2)(i), (c)(2)(v), (e); comment 41(c)(2)(i)-1.

**Eligibility (D2-3.2-04, all required).** (1) QRPC achieved (D2-2-01); (2) hardship resolved and the borrower "is able to continue making the full monthly contractual payment" including repayment of any escrow shortage over 60 months; (3) unable to reinstate or afford a repayment plan; (4) conventional first lien (fixed, step-rate or ARM); property may be vacant or condemned; no principal-residence requirement; (5) originated **at least 12 months** before the evaluation date; (6) **equal to or greater than 2 months delinquent but less than or equal to 6 months delinquent as of the evaluation date**; (7) no prior payment deferral with an effective date **within 12 months** of the evaluation date (disaster deferrals excluded); (8) cumulative cap: **no more than 12 months of cumulative past-due P&I** deferred over the life of the loan by payment deferrals (disaster deferrals excluded); (9) not within **36 months** of maturity/projected payoff; (10) not subject to recourse/indemnification, an approved liquidation workout, an active repayment plan, a current retention offer, or an active Trial Period Plan; (11) no failed non-disaster modification trial within 12 months and no non-disaster modification within the previous 12 months; (12) a complete BRP is **not** required. Evaluation Notice per D2-2-05 required only when a complete BRP was submitted (otherwise optional).

**Terms.** Deferred (non-interest-bearing, due at maturity, payoff, sale/transfer or refinance; all other terms unchanged; no trial period): **at least 2 and up to 6 months of past-due P&I**; out-of-pocket **escrow advances** resulting from the delinquency and paid to third parties before the effective date; **servicing advances** paid to third parties in the ordinary course, not retained by the servicer, paid before the effective date (where state law permits). **Excluded:** late charges, penalties, stop-payment and similar fees — "the servicer must waive all late charges, penalties, stop payment fees, or similar charges upon completing a payment deferral"; no administrative fees; **escrow shortage must not be included** in the non-interest-bearing balance (repaid over 60 months; servicer need not fund it). Escrow analysis is required before offering (B-1-01); an escrow waiver need not be revoked if T&I are confirmed current. MBS loans are not reclassified and no manual reclassification may be requested (A1-3-06). MI: delegated insurers per F-2-06 need no separate approval. Temporary buydown: buydown funds are not applied to the delinquency unless the agreement requires; eligibility is tested on the full note payment; after completion the borrower resumes the buydown schedule until it expires.

**Solicitation without QRPC.** After a forbearance plan expires without QRPC → solicit **within 15 days after expiration**; after a repayment-plan payment is missed at month-end without QRPC → solicit **by the 15th day of the following month**; using the "Payment Deferral Post-Forbearance Plan Solicitation Cover Letter" or "Payment Deferral Post-Repayment Solicitation Cover Letter" with the payment deferral agreement (or equivalent) and acceptance instructions. Acceptance may be evidenced by the borrower contacting the servicer, returning an executed agreement, or any other method evidencing acceptance.

**Completion, agreement and delivery.** "Fannie Mae considers a payment deferral to be completed when the case is submitted into Fannie Mae's servicing solutions system, including entry of loan-level information such as the applicable campaign ID"; **the case must be entered by the last day of the month in which the evaluation took place**; if it cannot be completed by the **15th** of the evaluation month, the servicer may use a **processing month** under a written equal-treatment policy. The full monthly contractual payment must be reported via LAR **before** completing the deferral, at least one business day before month-end (F-1-22). **If the loan is 6 months delinquent as of the evaluation date, or the deferral would exceed the 12-month cumulative cap**, the borrower must make the full contractual payment during the solicitation and/or processing month and the deferral is completed after that payment is received. Send the payment deferral agreement (or equivalent — the Fannie Mae model is optional but sets the minimum content) **no later than five days after completion**; if the servicer requires a signature, the executed agreement must be received before completion. Document custodian: servicer-signed copy or fully executed copy **within 25 days** of the effective date; if recordable, certified copy within 25 days and the original from the recorder **within 5 business days** of receipt. Texas §50(a)(6): on notice of a violation, inform Fannie Mae Legal (Form 20) within **7 business days** and cure within **60 days**. Incentive: **$500** (F-2-02; retention cap $1,000/loan).

**Reg X interplay.** No BRP is needed for Fannie Mae, but Reg X still governs if a "loss mitigation application" exists (12.1). The 2020 (c)(2)(v) exception survives only for COVID "covered amounts" (revised by the 2025 IFR) — not usable for ordinary hardships. Design position (12.2 open question 2): deferral solicitations are servicer-initiated offers based on loan-level screens (comment 41(c)(2)(i)-1); on a complete application the deferral is an offered option with the (e) acceptance window. Deferral acceptance ends the delinquency, which satisfies (g)(2)/(f)(2) issues by mooting them (the loan is current).

**Discrepancies vs. blueprint row.** (1) The 15th-of-following-month solicitation applies after a *repayment-plan* failure; after *forbearance* the clock is 15 days after expiration. (2) The blueprint omits the 2–6-month delinquency window, 12-month seasoning, 12-month prior-deferral exclusion, 36-months-to-maturity rule, the trial-failure/modification exclusions, month-end SMDU entry, processing-month policy, the contractual-payment rule at 6 months/cap, agreement/custodian timing, the late-charge waiver and escrow-shortage exclusion. (3) "≤12 mos cumulative" is correct and excludes disaster deferrals.

### Operational prerequisites
- **Partner written policies:** processing-month election (equal treatment); signature requirement on the deferral agreement (default: no wet signature; e-acceptance/verbal with recorded confirmation where law permits — recorded instruments where state law requires signatures); recording policy where required for lien priority (state-by-state `jurisdiction_rules.deferral_recording`).
- **SMDU payment-deferral case access** (B2B/UI) with campaign IDs (Supermortgage/partner).
- **Templates:** `NTC_FNMA_D23204_DEFERRAL_OFFER` (Evaluation Notice variant), `NTC_FNMA_D23204_SOLICIT_POST_FORB`, `NTC_FNMA_D23204_SOLICIT_POST_REPAY`, `DOC_FNMA_PAYMENT_DEFERRAL_AGREEMENT` (Fannie Mae model content; e-sign enabled), `NTC_FNMA_D23204_DEFERRAL_COMPLETED`.
- **Escrow analysis engine** (3.x) able to run a pre-offer analysis with a 60-month shortage spread.
- **Custodian and e-recording** adapters (N8/N15) for recordable agreements; `signing_officer` roster.
- **Expense reimbursement path** for deferred servicer advances/P&I (5.x/15.2; Form 4828 advances 15.4) **[PARTIALLY VERIFIED — reimbursement mechanics per Investor Reporting Manual/P360 not re-verified here]**.

### Build spec
#### Inputs and triggers
- 12.2 hierarchy result `payment_deferral` (QRPC: resolved hardship, can afford contractual payment, cannot reinstate/afford plan) — with or without an application.
- `workout_plan.expired{forbearance, qrpc=false}` / `workout_plan.failed{repayment, qrpc=false}` → eligibility screen and solicitation (12.4/12.5 timers).
- `lossmit.offer.accepted{deferral}` (contact/executed agreement/other evidence).
- `payment.received{full_contractual}` in the solicitation/processing month (gate at 6 months/cap).
- `escrow.analysis.completed{purpose=workout}` (3.x).
- `smdu.case.decisioned{PAYMENT_DEFERRAL}`; `smdu.case.completed`.

#### Data model
- `payment_deferrals`: `id`, `loan_id`, `case_id` (case_type `deferral`), `kind='standard'`, `basis` (12.2 enum), `evaluation_date`, `delinquency_months_at_eval`, `months_deferred int` (2–6), `deferred_pi_cents bigint`, `deferred_escrow_adv_cents`, `deferred_servicing_adv_cents`, `nib_total_cents`, `cumulative_months_after int`, `prior_deferral_effective_dates[]`, `effective_date` (first day of the month after completion month; contractual due date resumes), `processing_month bool`, `contractual_payment_required bool`, `contractual_payment_received_at?`, `escrow_analysis_id`, `escrow_shortage_cents`, `shortage_monthly_cents` (÷60), `late_charges_waived_cents`, `smdu_case_id`, `campaign_id`, `smdu_entered_at`, `agreement_document_id`, `agreement_sent_at`, `agreement_executed_at?`, `recording_required bool`, `recorded_at?`, `custodian_delivered_at?`, `incentive_claim_id?`, `status`.
- `loan_terms` new version: `deferred_principal_nib_cents` (sum of NIB balances incl. prior deferrals/forbearance), `next_due_date` reset, `maturity_date` unchanged.
- Ledger accounts: `deferred_principal` (NIB), `escrow_advances`, `corporate_advances`, `late_charges` (waived via contra).

#### State machine
`screened_eligible` → `offered|solicited` → `accepted` → `awaiting_contractual_payment` (if required) → `pending_smdu_entry` → `completed` (SMDU case submitted with campaign ID; effective) → `agreement_sent` → `documented` (custodian/recording done) → `closed`; `screened_ineligible` → Flex Mod path (12.8); `offered` → `declined|expired`. Guards: all 12 eligibility criteria as assertions; `assertEscrowAnalysisFresh` (≤30 days); `assertContractualPaymentIfRequired`; `assertEntryByMonthEnd`; `assertLarBeforeCompletion` (5.x ack).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_D23204_DEFERRAL_ELIGIBILITY_GATES` | not_before_gate | offer/solicit command | — | criteria 4–11 (delinquency 2–6 `months` via `fnma_delinquency_status`; seasoning ≥12 `months`; prior deferral ≥12 `months`; cumulative ≤12 `months`; maturity >36 `months`) | — | refused with reason codes |
| `FNMA_B101_ESCROW_ANALYSIS_BEFORE_OFFER` | not_before_gate | offer/solicit | — | analysis completed ≤30 days (policy) | `escrow.analysis.completed` | offer blocked |
| `FNMA_D2205_EVAL_NOTICE_DEFERRAL_5` | deadline | `payment_deferral.offered` (BRP basis) | decision | 5 `calendar_days` | `notice.sent{NTC_FNMA_D23204_DEFERRAL_OFFER}` | `officer` sev-2 |
| `REGX_1024_41E1_ACCEPT_14` | deadline (borrower) | offer on a complete application | `provided_at` | 14 (or 7) `calendar_days` | acceptance | deemed rejection (12.2) |
| `SM_DEFERRAL_SOLICIT_ACCEPT_WINDOW` | deadline (borrower) | solicitation sent | send date | through the last day of the solicitation month (policy; ≥14 days) | acceptance | expire; re-screen next month |
| `FNMA_D23204_CONTRACTUAL_PAYMENT_GATE` | not_before_gate | 6 months delinquent at eval or cap-exceeding | — | full contractual payment received in solicitation/processing month | `payment.received{full}` | completion blocked; if not received by month-end → re-evaluate (may exceed window) |
| `FNMA_F122_DEFERRAL_LAR_BEFORE_EOM_1BD` | deadline | `payment_deferral.accepted` | last day of completion month | −1 `business_days_fannie_et` | contractual-payment LAR/event accepted (5.x `FNMA_IRM_DEFERRAL_LAR_BEFORE_EOM_1BD`) | sev-2; slips to processing month |
| `FNMA_D23204_DEFERRAL_SMDU_ENTRY_EOM` | deadline | `payment_deferral.accepted` | evaluation month (or processing month if elected by the 15th) | last calendar day of that month | `smdu.case.completed` | sev-1 `officer`; re-evaluate eligibility next month |
| `FNMA_D23204_PROCESSING_MONTH_ELECTION_15TH` | deadline | evaluation | evaluation month | 15th of the month | completion or `processing_month=true` | automatic election under the written policy |
| `FNMA_D23204_AGREEMENT_SEND_5` | deadline | `smdu.case.completed` | completion date | 5 `calendar_days` | `notice.sent{DOC_FNMA_PAYMENT_DEFERRAL_AGREEMENT}` | `officer` sev-2 |
| `FNMA_D23204_CUSTODIAN_25` | deadline | `effective_date` | effective date | 25 `calendar_days` | `custodian.delivery.confirmed` | sev-2 |
| `FNMA_D23204_RECORDED_ORIGINAL_5BD` | deadline | `erecording.recorded_document.received` | receipt | 5 `business_days_servicer` | custodian delivery of original | sev-2 |
| `TX_50A6_DEFERRAL_NOTICE_7BD` | deadline | borrower notice of §50(a)(6) violation (TX) | receipt | 7 `business_days_servicer` (Form 20 to Fannie Mae Legal) + 60-day cure | `fnma.legal.notified` | `officer` sev-1 |
| `FNMA_F202_DEFERRAL_INCENTIVE_CLAIM` | deadline (policy) | `smdu.case.completed` | completion | next claim cycle | `investor_events{incentive}` | sev-3 |
| `FNMA_D23206_POSTDEFERRAL_FLEX_SOLICIT_75` | deadline | loan 60+ days delinquent within 6 months of the deferral effective date, no QRPC | day 60 | by day 75 of delinquency | `notice.sent{NTC_FNMA_D23206_SOLICIT_STREAMLINED}` | sev-2 (12.8) |

#### Business rules and calculations
1. **Months deferred** = number of unpaid contractual installments at evaluation (2–6); the deferral covers *all* of them (the loan becomes current). If a partial payment sits in suspense, apply it first per 2.x (it may reduce the count).
2. **NIB amount** = Σ(P&I of each deferred installment) + escrow advances paid to third parties before the effective date (tax/insurance disbursements funded by the servicer because the escrow balance was insufficient, attributable to the delinquency) + servicing advances paid to third parties (inspection fees etc.) where state law permits. Late charges/NSF/stop-payment fees → **waived** (contra-posted). Escrow shortage → **not** included; spread over 60 months in the new escrow payment (borrower may prepay).
3. **Worked example (4 payments):** P&I $1,580.17 (30-yr fixed 6.5%, $250,000); installments due 2026-06-01 … 2026-09-01 unpaid (4 months delinquent on the 2026-09-20 evaluation; originated 2021-10, seasoning ✓; no prior deferral; 348 months to maturity ✓). Escrow advances: county tax $1,050.00 paid 2026-08-10 from servicer funds ✓ (third party, before the effective date). Servicing advances: $0. Late charges $63.00 × 4 = $252.00 → waived. **NIB = 4 × $1,580.17 + $1,050.00 = $7,370.68.** Escrow analysis (3.x) shows a shortage of $1,860.00 → $31.00/month for 60 months; T&I monthly $520.00 → new payment **$1,580.17 + $520.00 + $31.00 = $2,131.17** from the first post-deferral due date. Cumulative deferred months = 4 (≤12 ✓). Completion in SMDU by 2026-09-30 (evaluation month); LAR/contractual-payment reporting by 2026-09-29 (1 BD before month-end); effective date 2026-10-01 with next due date 2026-10-01; agreement sent by completion + 5 days; custodian by 2026-10-26.
4. **6-month/cap rule:** if `delinquency_months_at_eval = 6` or `cumulative_after > 12`, require the full contractual payment in the solicitation and/or processing month before completion; if not received by the processing-month end, re-screen (a 7-month-delinquent loan is ineligible → Flex Mod).
5. **Processing month:** if not completed by the 15th of the evaluation month, `processing_month=true` under the partner's written policy; entry by the last day of the processing month; the borrower is not required to make an additional payment in the processing month unless rule 4 applies (policy mirrors the Flex Mod processing-month language — **[PARTIALLY VERIFIED for deferrals]**).
6. **Effective date and due date:** effective the first day of the month following the completion month; `next_due_date` = effective date; delinquency counters reset to 0 (`regx_days_delinquent=0`); status codes cleared; credit reporting per 8.x (current, with the deferral comment code).
7. **Ledger:** on completion, post one balanced set per installment: debit `deferred_principal` (NIB) for the P&I amount; credit `interest_due`/`principal` receivables so the interest-bearing UPB equals the scheduled amortized balance as though the installments had been paid **[PARTIALLY VERIFIED — reported UPB mechanics per Investor Reporting Manual; confirm during SMDU/LAR CIT]**; debit `deferred_principal` / credit `escrow_advances` and `corporate_advances` for the advances rolled into the NIB; contra-post late charges as waived. Servicer P&I/advances reimbursement from Fannie Mae per the Investor Reporting Manual and expense-reimbursement process (5.x/15.2).
8. **Payoff/maturity:** the NIB is due at maturity/payoff/sale/refinance (16.x payoff statements show it as a separate line; 7.x periodic statements show the deferred balance).
9. **Reg X:** if a complete application exists, the offer notice carries the (c)(1) content and 14-day window; on solicitation (no application), the letter carries the D2-2-05 minimums and Fannie Mae's acceptance instructions.

#### Integrations
- **SMDU (`fnma-smdu`):** `PAYMENT_DEFERRAL` case with campaign ID and loan-level fields (delinquency, deferred amounts by type, escrow shortage, effective date, valuation not required) — B2B field names **[UNVERIFIED — spec behind login]**; decision with rep-and-warrant relief; completion = case submission. Portal fallback via `fnma_portal_operator` with the AI package (all fields + payment evidence) when B2B fails within 3 business days of month-end.
- **Investor reporting (5.x):** contractual payments reported (LAR 96 / payment events) before completion; loan-data change for the NIB/deferred amount per the Investor Reporting Manual **[PARTIALLY VERIFIED]**; delinquency status cleared.
- **Escrow (3.x):** pre-offer analysis; shortage spread; T&I current confirmation for waived-escrow loans.
- **E-sign / print-mail:** agreement delivery; `signing_officer` execution where a servicer signature is required; **e-recording (N15)** where `jurisdiction_rules.deferral_recording=true`; **custodian (N8)** delivery.
- **Credit bureaus (8.x), MI (F-2-06 delegation — no call), claims (15.2 incentive/expense reimbursement, 15.4 advance reimbursement).**

#### Outputs and artifacts
- `NTC_FNMA_D23204_DEFERRAL_OFFER` (Evaluation Notice; §1024.41(c)(1) content when on a complete application): deferred amount by component, that no interest accrues on it, that it is due at maturity/payoff/sale/refinance, new payment (incl. escrow shortage), late charges waived, no fees, acceptance methods and deadline, other-options/appeal statements as applicable, Colorado block if any adverse component.
- `NTC_FNMA_D23204_SOLICIT_POST_FORB` / `_POST_REPAY` (cover letters + agreement; acceptance instructions).
- `DOC_FNMA_PAYMENT_DEFERRAL_AGREEMENT` (Fannie Mae model minimum content): sent ≤5 days after completion; e-signable; recordable version where required.
- `NTC_FNMA_D23204_DEFERRAL_COMPLETED` (confirmation; new due date; payment amount; NIB balance).
- Records: `payment_deferrals`, `loan_terms` version, ledger postings, `smdu_cases`, investor events (payments; incentive claim), custodian/recording receipts, `agent_decisions{kind=lossmit.deferral}`.

#### AI agent design (AI-first)
- **Agent:** `lossmit-underwriter` sub-role `deferral`. Tools: `deferral.screen` (deterministic criteria), `ledger.arrears_breakdown`, `escrow.analysis.run`, `smdu.case.submit`, `investor.report_contractual_payments`, `notice.render_send`, `esign.send`, `erecording.submit`, `custodian.deliver`, `timers.*`.
- **Decision record:** `{deferral_id, basis, criteria[{code, value, pass}], months_deferred, nib_components, escrow{shortage, monthly}, contractual_payment_gate, processing_month, smdu_case_id, rep_warrant_relief, notices, rationale}`.
- **Guardrails:** ineligibility determinations go to `lossmit_reviewer` before any notice (adverse determination); NIB math is code; cannot complete without the LAR/event ack and, where required, the contractual payment; cannot include late charges or escrow shortage in the NIB.
- **Escalations:** `fnma_portal_operator` (SMDU UI fallback; F-1-24 mitigating-circumstances requests when a criterion fails but circumstances warrant), `signing_officer` (servicer-executed/recordable agreements), `officer` (Texas Form 20), `human_agent` on request.
- **AI-off:** human processors run the same screen/calculator.

#### Edge cases and failure modes
- **Delinquency changes between evaluation and completion** (payment received or month rolls): re-test the window at completion; a loan that becomes 7 months delinquent before entry is ineligible → Flex Mod solicitation by day 75/105 rules.
- **Partial payment in suspense:** apply per 2.x before counting months.
- **Escrow-waived loan with delinquent taxes:** escrow account must be established or T&I brought current (B-1-01) — the deferral cannot complete otherwise.
- **State law bars capitalizing/deferring advances:** exclude those components; servicer claims them separately.
- **Texas 50(a)(6):** Form 20 within 7 BD; cure within 60 days.
- **MBS pool:** no reclassification; remittance continues per remittance type (5.x).
- **Transfer-out after completion but before custodian delivery:** transferee completes delivery; artifacts in the goodbye package.
- **Bankruptcy:** deferral permitted with counsel/trustee coordination; Chapter 13 plans may need amendment.
- **Prior disaster deferral:** does not count toward the 12-month exclusion or the cumulative cap.
- **Borrower disputes NIB amount:** NoE (4.1); corrections re-post via reversing entries and an amended agreement.

#### Test cases and acceptance criteria
- **12.6-T1:** Given the 4-payment example, when accepted 2026-09-22, then NIB = $7,370.68, late charges $252.00 waived, new payment $2,131.17, SMDU entry by 2026-09-30, LAR/events by 2026-09-29, effective 2026-10-01, agreement sent by completion + 5 days, custodian by 2026-10-26.
- **12.6-T2 (window):** 1 month delinquent → ineligible (reason `INV_FNMA_D23204_DELQ_WINDOW`); 7 months → ineligible; 6 months → eligible with the contractual-payment gate.
- **12.6-T3 (prior deferral):** prior deferral effective 2025-11-01 → ineligible until 2026-11-01; prior *disaster* deferral 2025-11-01 → eligible.
- **12.6-T4 (cap):** cumulative 9 months deferred previously + 4 now = 13 → gate requires the contractual payment and the deferral is limited to 3 months (cap 12) with the 4th installment paid — engine offers the compliant structure or routes to Flex Mod (policy).
- **12.6-T5 (processing month):** evaluation 2026-09-18 (after the 15th) → `processing_month=true`; entry deadline 2026-10-31; borrower not required to pay in October unless the 6-month/cap rule applies.
- **12.6-T6 (solicitation clocks):** forbearance expired 2026-12-31 without QRPC → solicitation by 2027-01-15; repayment failure at 2026-11-30 → solicitation by 2026-12-15.
- **12.6-T7 (Reg X):** deferral offered on a complete application → notice carries (c)(1) content and a 14-day window; deemed rejection after the grace releases holds.
- **12.6-T8 (ledger):** postings balance; IB UPB equals the scheduled balance; `deferred_principal` = $7,370.68; payoff statement shows the NIB line.
- **12.6-T9 (SMDU outage):** B2B failure on 2026-09-28 → portal task filed; operator completes 2026-09-29; case evidence attached.
- **12.6-T10 (recording state):** `deferral_recording=true` → recordable agreement executed by `signing_officer`, e-recorded, certified copy to custodian ≤25 days, original ≤5 BD after receipt.

#### Audit and evidence
Eligibility record (each criterion with values), QRPC evidence, escrow analysis, NIB computation and ledger entries, SMDU case id/decision/completion timestamp (rep-and-warrant evidence), LAR/event acks, agreement with delivery/e-sign evidence, recording/custodian receipts, incentive claim, notices with proofs, timer history.

### Open questions / decisions
1. **Signature policy on the deferral agreement.** Default: no signature required except where recording/state law requires; acceptance evidenced by recorded verbal confirmation or e-acceptance.
2. **Processing-month policy.** Default: elect the processing month whenever acceptance lands after the 15th; written equal-treatment policy signed by the partner.
3. **Cap-exceeding structures (T4).** Default: offer the largest compliant deferral with the excess installment paid, else Flex Mod; confirm with Fannie Mae guidance.
4. **IB UPB reporting mechanics** (rule 7). Default as stated; validate in CIT.

### Sources
- Fannie Mae D2-3.2-04: https://servicing-guide.fanniemae.com/svc/d2-3.2-04/payment-deferral (08/13/2025; verified 2026-09-09)
- Fannie Mae F-1-22: https://servicing-guide.fanniemae.com/svc/f-1-22/reporting-workout-option-fannie-maes-servicing-solutions-system (10/11/2023; verified 2026-09-09)
- Fannie Mae B-1-01 (escrow in workouts): https://servicing-guide.fanniemae.com/svc/b-1-01/administering-escrow-account-and-paying-expenses (09/11/2024; verified 2026-09-09)
- Fannie Mae F-2-02, F-2-10, D2-3.2-01, D2-3.2-02, D2-3.2-06 (verified 2026-09-09; see other processes)
- SMDU UI Payment Deferral Options User Guide (landing): https://singlefamily.fanniemae.com/applications-technology/servicing-management-default-underwriter-smdu/smdu-ui-payment-deferral-options-user-guide (content gated)
- 12 CFR 1024.41(c)(2)(i), (c)(2)(v), (e); comment 41(c)(2)(i)-1 (verified 2026-09-09)
