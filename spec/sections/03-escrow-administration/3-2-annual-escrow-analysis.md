# 3.2 — Annual escrow analysis

| Attribute | Value |
|---|---|
| Section | 3 — Escrow Administration |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | Each computation year end |
| Governing source | Reg X 1024.17(c)(3) |
| Key deadlines | Analysis at completion of computation year |
| Timers | `BK_3002_1_PAYMENT_CHANGE_21`, `ESC_NEW_PAYMENT_NOTICE_MIN_30`, `FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL`, `REGX_1024_17C3_ANNUAL_ANALYSIS_0`, `REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45`, `REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Escrow |
| Trigger & frequency | Each computation year end |
| Governing source (blueprint) | Reg X 1024.17(c)(3) |
| Key deadlines (blueprint) | Analysis at completion of computation year |
| Data/artifacts | Analysis worksheet |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Sub performs; SoR liable |
| Nuances (blueprint) | [cropped in source] — reconstructed: aggregate method mandatory; disbursement estimation rules; interim/transfer/workout/payoff analyses; 60-month workout spread; Chapter 13 payment-change gate |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.17** (eCFR current as of Sept. 4, 2026):
- (c)(3): "at the completion of the escrow account computation year, the servicer shall conduct an escrow account analysis to determine the borrower's monthly escrow account payments for the next computation year, subject to the limitations of paragraph (c)(1)(ii)"; the servicer estimates disbursements per (c)(7), uses the deadline dates in (k), determines surplus/shortage/deficiency, adjusts per (f), and submits the annual statement per (i).
- (c)(1)(ii) ceiling during the life of the account: a monthly sum "equal to one-twelfth (1/12) of the total annual escrow payments which the servicer reasonably anticipates paying from the account," plus an amount to maintain a cushion "no greater than one-sixth (1/6) of the estimated total annual payments"; shortage/deficiency deposits are additional per (f).
- (c)(4): "All servicers must use the aggregate accounting method." (c)(5): cushion ≤ 1/6. (c)(6): "A servicer must not practice pre-accrual." (c)(7): if the servicer "knows the charge for an escrow item in the next computation year, then the servicer shall use that amount"; otherwise the preceding year's charge, or that charge "as modified by an amount not exceeding the most recent year's change in the national Consumer Price Index"; new construction may use a comparable property's assessment. (c)(8): examine the loan documents — a lower cushion in the instrument controls; a higher one is overridden by this section. (c)(9): multi-year items (e.g., a 3-year flood premium) are collected as 36 equal monthly amounts and the annual statement must explain why the low point is not reached.
- (d)(1): the steps in (d)(2) yield maximum target balances; "a servicer may use accounting procedures that result in lower target balances"; the cushion is optional. (d)(2)(i)(A)–(C): project the trial balance for the next year assuming disbursements "on or before the earlier of the deadline to take advantage of discounts, if available, or the deadline to avoid a penalty," no pre-accrual, and monthly payments of 1/12 of anticipated annual disbursements; add to the first balance the amount that brings the lowest monthly trial balance to zero; then add the cushion. (d)(2)(ii): the lowest target balance "shall be less than or equal to one-sixth" of estimated annual disbursements. Appendix E ("Arithmetic Steps") shows the three steps — reproduced numerically in the Business rules below.
- (f)(1)(ii): "The servicer may conduct an escrow account analysis at other times during the escrow computation year. If a servicer advances funds in paying a disbursement, which is not the result of a borrower's payment default … then the servicer shall conduct an escrow account analysis to determine the extent of the deficiency before seeking repayment."
- (i)(1): "In preparing the statement, the servicer may assume scheduled payments and disbursements will be made for the final 2 months of the escrow account computation year."
- (e)(1)–(2) transfer: analysis and treatment of shortages/surpluses/deficiencies per (f) at transfer; (i)(4) short-year statements reset the computation year (3.3).
- CFPB Mortgage Servicing FAQs (Escrow — Analysis, updated Apr. 12, 2023; Deficiencies/Shortages/Surpluses, June 2, 2021): a servicer "can conduct another escrow account analysis" when costs change mid-year and "can then provide a short year escrow account statement to reset the escrow account computation year"; a known terminating charge (e.g., PMI termination) must be reflected — "the servicer must consider the PMI termination date … and adjust the charges to the borrower."

**Fannie Mae** (Servicing Guide Aug 12, 2026 edition): B-1-01 (09/11/2024) — for a Payment Deferral or a mortgage loan modification "the servicer must analyze the escrow account to estimate the periodic escrow deposit needed" (considering T&I due during processing/trial) and "must spread any escrow shortage repayment amount in equal monthly payments over a period of 60 months, unless the borrower decides to pay" the shortage in a lump sum or over a shorter period "of not less than 12 months"; subsequent annual shortages are spread over the remaining initial period or up to 60 months. D2-3.2-06 (04/08/2026): the servicer must "perform an escrow analysis prior to offering a Trial Period Plan"; "Any escrow account shortage that is identified at the time of the mortgage loan modification must not be capitalized and the servicer is not required to fund any existing escrow account shortage." F-1-27 (08/13/2025): capitalized arrearages include "out-of-pocket escrow advances to third parties" — the 60-month rule is **not** in F-1-27 (blueprint task note corrected: it is in B-1-01).

**Other law**: Uniform security instrument Section 3 — the 2001-vintage instrument required shortage/deficiency repayment "in accordance with RESPA, but in no more than 12 monthly payments"; the 2021 instrument (mandatory for note dates on/after Jan 1, 2023 per Freddie Mac's uniform-instrument page) states repayment "in accordance with RESPA" and lets the lender retain a surplus when the periodic payment is "delinquent by more than 30 days." **[PARTIALLY VERIFIED — instrument text not retrievable today (Fannie/Freddie document hosts blocked); confirm against the loan's recorded instrument at boarding.]** Bankruptcy Rule 3002.1(b): payment changes in Chapter 13 need notice ≥ 21 days before the new payment date (Section 14.2). NH RSA 397-A:9, III: after a licensee advances for a deficiency it must "give the mortgagor the option of paying the deficiency over a period of not less than 12 months" with no interest (verified 2026-09-09, gencourt.state.nh.us).

**Discrepancies with the blueprint row**: the row cites only (c)(3); the operative math is (c)(1), (c)(7), (d)(2), Appendix E, and (f); the row omits interim, transfer, workout and payoff analyses; "analysis at completion" is legally the trigger, but operationally the analysis must run ~45 days early (using the (i)(1) two-month assumption) so the new payment can start on the first due date of the new computation year and appear on the periodic statement (Section 7.1).

### Operational prerequisites
- Tax service contract with bill/amount/due/penalty ("economic loss date") feeds and delinquency monitoring (00b N16) — Supermortgage; 4–12 weeks; layouts contract-gated [vendor-specific].
- Insurance tracker/LPI vendor feed of renewal premiums and due dates (00b N6; Section 9.1); MI adapters for borrower-paid monthly/annual premiums and termination dates (Section 10).
- CPI series ingestion (BLS CPI-U, annual change) for (c)(7) estimates — Supermortgage; 1 week.
- `loan_terms.security_instrument_version` populated at boarding with `instrument_cushion_months` and `instrument_shortage_max_months` — Section 1.1.
- Counsel-approved policy parameters: cushion months (default 2), default shortage spread (12), deficiency spread (12; min 2), analysis lead days (45), minimum notice before the new payment (30 calendar days), "one month's payment" basis — owner: Supermortgage compliance; before go-live.
- Rule sets registered: `regx.escrow.2013` (current 1024.17) and `fnma.escrow.b101.2024-09`.

### Build spec
#### Inputs and triggers
- Recurring: `timer-sweep` fires `escrow.analysis.due` when `today = computation_year_end − analysis_lead_days` (default 45) for every `escrow_accounts.status='active'`.
- Event-driven `analysis_type`: `initial` (3.1), `interim` (`escrow.bill.variance_detected` beyond tolerance, `escrow.advance.posted` not caused by borrower default, `pmi.termination.scheduled`, borrower request via `rfi` case, line added/removed), `transfer_in` (`transfer.in.completed`), `workout` (`lossmit.trial_plan.offer_prepared`, `lossmit.deferral.approved`, `lossmit.modification.effective`, `forbearance.exit`), `payoff` (`payoff.funds_received` → 3.3 short-year + 3.5 refund), `reinstatement` (`loan.reinstated` after (i)(2) exemption).
- Inbound data: `escrow_bills` (tax service, insurers, MI, HOA), `ledger_entries` on the `escrow` account, `loan_terms` (P&I, payment frequency, instrument caps), `jurisdiction_rules`, `pmi_termination_date`, `flood_policy_term_years`.

#### Data model
- `escrow_lines` (baseline; fixed): `id`, `escrow_account_id`, `line_type` ∈ {tax_county, tax_city, tax_school, tax_special, tax_supplemental, tax_personal_property_mh, hazard, flood, wind, earthquake, other_insurance, mi_borrower_paid, hoa, ground_rent, other}, `payee_id → parties`, `payee_reference` (APN/parcel, policy no., MI cert), `frequency` ∈ {annual, semiannual, quarterly, monthly, triennial, biennial}, `installment_count int`, `estimate_basis` ∈ {known_bill, prior_year, prior_year_cpi, comparable, quote, contract}, `estimated_annual_cents bigint`, `cycle_years int default 1` ((c)(9)), `terminates_on date null` (PMI/flood), `source` ∈ {tax_service, insurance_tracker, mi_adapter, hoa_manual, boarding}, `active bool`, `effective_from/to`.
- `escrow_bills` (new): `id`, `escrow_line_id`, `tax_year/policy_term`, `installment_no`, `amount_cents`, `due_date`, `penalty_date` (economic loss date), `discount_date null`, `discount_amount_cents null`, `status` ∈ {projected, received, scheduled, paid, delinquent, supplemental, corrected, void}, `vendor_ref`, `received_at`.
- `escrow_analyses` (baseline; fixed): `id`, `escrow_account_id`, `analysis_type` ∈ {initial, annual, interim, transfer_in, workout, payoff, reinstatement}, `run_at timestamptz`, `as_of_date date`, `projection_start date`, `projection_end date`, `lines_snapshot jsonb`, `annual_disbursements_cents`, `base_payment_cents` (1/12), `cushion_months`, `cushion_cents`, `low_point_month date`, `low_point_uncorrected_cents` (negative), `required_start_balance_cents`, `target_at_start_cents`, `projected_actual_at_start_cents`, `surplus_cents`, `shortage_cents`, `deficiency_cents`, `borrower_current bool` (regx_days_delinquent ≤ 30 at as_of_date), `decision jsonb` {surplus_action, shortage_months, shortage_installment_cents, deficiency_months, deficiency_installment_cents, credit_cents, lump_sum_allowed}, `new_payment_cents`, `new_payment_effective_date`, `instrument_cap_applied bool`, `state_overlay_codes text[]`, `status` ∈ {computed, anomaly_review, approved, statement_sent, effective, superseded, cancelled}, `rule_set_version`, `agent_decision_id`, `supersedes_analysis_id`.
- `escrow_analysis_lines` (new): `analysis_id`, `period_index`, `period_date`, `deposit_cents`, `disbursement_cents`, `description`, `running_balance_uncorrected_cents`, `running_balance_zeroed_cents`, `target_balance_cents`.
- `loan_terms` additions: `security_instrument_version` ∈ {uniform_2001, uniform_2021, other}, `instrument_cushion_months numeric null`, `instrument_shortage_max_months int null`, `hpml_flag bool`, `flood_escrow_mandatory bool`.
- Retention: `life_of_loan_plus_4y`; PII: none beyond loan linkage.

#### State machine
`scheduled` → `computing` → `computed` → (anomaly rules hit) `anomaly_review` → `approved` (agent) → `statement_sent` (3.3 or 3.1) → `effective` (new payment date reached; `loan_terms` escrow payment versioned) → `superseded` (a later analysis) | `cancelled` (payoff/transfer-out/waiver before effective). Guards: `approved` requires all lines to have `estimate_basis` set, cushion ≤ cap, no negative target, and for `workout` type a 60-month spread unless borrower election recorded; `effective` requires the Chapter 13 gate (Section 14.2) if `bankruptcy` case open. Actors: engine (`computing`→`computed`), `escrow` agent (`approved`), Notice Registry (`statement_sent`), timer-sweep (`effective`).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45` | recurring (internal, supports the 30-day statement deadline) | `escrow.account.established` / prior `escrow.analysis.effective` | `computation_year_end` | −45 calendar_days | `escrow.analysis.completed` (type annual) | sev-3 to `escrow` agent; if unresolved by year end, sev-2 |
| `REGX_1024_17C3_ANNUAL_ANALYSIS_0` | deadline | computation year end | `computation_year_end` | 0 calendar_days | `escrow.analysis.completed` | sev-2; statement timer (3.3) will also run |
| `REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE` | not_before_gate | `escrow.advance.posted` (non-default cause) | advance posted | gate opens on `escrow.analysis.completed` (interim) | — | command `demandDeficiencyRepayment` refused until analysis exists |
| `FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL` | deadline | `lossmit.trial_plan.offer_prepared` | offer date | 0 calendar_days (must precede `lossmit.trial_plan.offered`) | `escrow.analysis.completed` (workout) | blocks the trial offer command; sev-2 |
| `BK_3002_1_PAYMENT_CHANGE_21` (Section 14.2) | not_before_gate | `escrow.analysis.approved` with open Ch.13 case | notice filed date | 21 calendar_days | `bankruptcy.payment_change_notice.filed` | new payment effective date is pushed to the first due date ≥ 21 days after filing |
| `ESC_NEW_PAYMENT_NOTICE_MIN_30` | not_before_gate (policy) | `escrow.statement.sent` | sent date | 30 calendar_days | — | effective date cannot precede sent + 30. **Exceptions (gate bypassed):** `payoff`, `transfer`, and **`mi_termination`** — on MI termination 12 U.S.C. 4902(e) bars the servicer from requiring "further payments" of PMI after the termination date, so the MI line must come out of the payment immediately; Section 10's finalization rule R-F2 requires the decrease with the first installment due after the interim-analysis notice and no later than the installment due ≥ 31 days after the termination effective date. The 30-day lead time is a borrower-protection window against *increases*; a decrease never needs it |
| Jurisdiction overrides | | NH (`RSA_397A_9_III`): deficiency repayment option ≥ 12 months at 0% for licensee-advanced deficiencies; instrument cap (`uniform_2001`: max 12 months for shortage and deficiency) | | | | |

#### Business rules and calculations
**R1 — Line projection (per `escrow_line`)**: build the projection-year installment list. Amount: `known_bill` if the payee/vendor has issued the next-cycle amount; else `prior_year` × (1 + CPI change) only when `estimate_basis='prior_year_cpi'` is enabled for the line type (default: taxes yes, insurance no — insurers quote renewals); comparable assessment for new construction; MI uses the contractual premium and drops installments after `terminates_on` (Section 10 termination date); multi-year items ((c)(9)) spread the full-cycle premium over `12 × cycle_years` months. Disbursement date in the projection = `scheduled_pay_date` from 3.7 (earlier of discount deadline (if `capture_discount=true`) or the penalty-avoidance date, never before bill availability, never pre-accrued).

**R2 — Base payment**: `annual_cents = Σ installment amounts in the projection year`; `base_payment_cents = round_half_up(annual_cents / 12)` (biweekly: `/ 26`).

**R3 — Trial running balance (Appendix E Step 1)**: start at 0 on the day before the first projected payment; for each period: `balance += base_payment` on the due date, `balance −= disbursements` scheduled in that period; record period-end balance.

**R4 — Zeroing (Step 2)**: `required_start = −min(period_end_balances)` if min < 0 else 0; add `required_start` to every period balance.

**R5 — Cushion (Step 3)**: `cushion_months = min(policy 2.00, instrument_cushion_months, state cap)`; `cushion_cents = floor_cents(annual_cents × cushion_months / 12)`; `target_balance[p] = zeroed_balance[p] + cushion_cents`; assert `min(target) ≤ floor(annual_cents / 6)` ((d)(2)(ii)).

**R6 — Target vs. actual at the start of the new year**: `target_at_start = required_start + cushion_cents`. `projected_actual_at_start = ledger escrow balance at run date + scheduled deposits through year end − scheduled disbursements through year end` ((i)(1) permits assuming the final two months). Then: `surplus = max(projected_actual − target_at_start, 0)`; if `projected_actual < 0`: `deficiency = −projected_actual` and `shortage = target_at_start`; else `shortage = max(target_at_start − projected_actual, 0)`.

**R7 — "One month's escrow account payment"** = `base_payment_cents` of the new projection (policy; see Open question 1).

**R8 — Decision matrix** (borrower_current = `regx_days_delinquent ≤ 30` at `as_of_date`; rule set `regx.escrow.2013`):

| Condition | Options under 1024.17(f) | Platform default | Notes |
|---|---|---|---|
| surplus ≥ $50.00 and current | must refund within 30 days of analysis | refund (3.5) | credit not allowed |
| surplus < $50.00 and current | refund, or credit against next year's payments | credit: `credit_monthly = floor_cents(surplus/12)`; residual cents credited to the first payment | payment = base − credit_monthly |
| surplus and not current | may retain per loan documents | retain in escrow; re-evaluate at next analysis or reinstatement | uniform instrument allows retention when > 30 days delinquent |
| shortage < one month and current | allow; repay within 30 days; or ≥ 12 equal monthly payments | spread over 12 months | 30-day lump option is never *required* by us (borrower may volunteer) |
| shortage ≥ one month and current | allow; or ≥ 12 equal monthly payments | spread over 12 months (instrument cap 12 for `uniform_2001`) | lump sum accepted only if unsolicited (CFPB FAQ) |
| shortage and not current | (f) not restricted; per instrument | spread over 12 months (no lump-sum demand) | conservative |
| deficiency < one month and current | allow; within 30 days; or ≥ 2 equal monthly payments | spread over 12 months | analysis required first if servicer-advanced ((f)(1)(ii)) |
| deficiency ≥ one month and current | allow; or ≥ 2 equal monthly payments | spread over 12 months (NH: offer ≥ 12 months at 0%) | |
| deficiency and not current | recover per loan documents | spread over 12 months upon reinstatement; no interest | |
| workout analysis (deferral/modification) | Fannie Mae B-1-01 overrides defaults | spread over **60 months**; borrower may elect lump sum or ≥ 12 months | subsequent shortages: remaining period or up to 60 |

Installment arithmetic: `installment = round_half_up(amount / months)`; the final installment absorbs the residual so Σ installments = amount exactly; installments are tracked in `escrow_accounts.shortage_installments_remaining` and stop automatically.

**R9 — New payment**: `new_payment = base_payment + shortage_installment + deficiency_installment − credit_monthly`; effective on the first payment due date of the new computation year, or the first due date ≥ 30 days after the statement is sent if later; versioned into `loan_terms` (effective-dated) so cashiering (2.1) and the periodic statement (7.1) pick it up.

**R10 — Anomaly review thresholds** (route to `anomaly_review`): payment change > 25% or > $150/month; any line with `estimate_basis='prior_year'` older than 2 years; projected negative balance after zeroing (bug guard); missing penalty date; PMI line without termination date; bill amount variance > 20% vs. prior year (possible parcel mismatch); surplus > $2,500.

**Worked example (Appendix E replay, then annual analysis)**
*Initial year (Appendix E)*: lines — school tax $360.00 (Sep), county tax $500.00 (Jul) + $700.00 (Dec); annual $1,560.00; base = $130.00; Step 1 balances from a $0 start: Jul −370, Aug −240, Sep −470, Oct −340, Nov −210, Dec −780, Jan −650, Feb −520, Mar −390, Apr −260, May −130, Jun 0; Step 2 required start $780; Step 3 cushion floor(1,560/6) = $260 → target start $1,040; December target $260 (= 1/6, cap satisfied).

*Annual analysis (run 2027-05-16 for the year Jul 2027–Jun 2028)*: next-year bills from the tax service: county Jul $520.00, county Dec $760.00, school Sep $380.00 → annual $1,660.00; base = round_half_up(1,660/12) = **$138.33**. Step 1 (start $0): Jul −381.67, Aug −243.34, Sep −485.01, Oct −346.68, Nov −208.35, **Dec −830.02**, Jan −691.69, Feb −553.36, Mar −415.03, Apr −276.70, May −138.37, Jun −0.04. Step 2: required start **$830.02** (Dec → $0.00). Step 3: cushion floor(1,660/6 = 276.666…) = **$276.66**; target start **$1,106.68**; December target $276.66 ≤ 1/6 ✓. Projected actual at 2027-06-30: ledger balance on 5/16 **$570.00** (start $1,040.00 + 11 deposits of $130.00 through May − actual disbursements $520.00 Jul, $360.00 Sep, $760.00 Dec, and an unprojected $260.00 supplemental tax bill paid 2027-03-15) + the assumed June deposit $130.00 = **$700.00** (no May/June disbursements). Shortage = 1,106.68 − 700.00 = **$406.68** ≥ one month ($138.33) → 12-month spread: installment round_half_up(406.68/12) = **$33.89** (12 × 33.89 = 406.68, residual 0). New escrow payment = 138.33 + 33.89 = **$172.22**, effective 2027-07-01 (statement sent 2027-05-20 ≥ 30 days before). Variants: projected actual $1,250.00 → surplus $143.32 → refund by 2027-06-15 (30 days after 5/16) and payment $138.33; projected actual $1,080.00 → surplus $26.68 → credit $2.22/month, first payment credit residual $0.04, payment $136.11; projected actual −$150.00 (servicer advance) → deficiency $150.00 (12 × $12.50) + shortage $1,106.68 (11 × $92.22 + final $92.26) → payment $243.05 (final month $243.09).

#### Integrations
- **Tax service** (00b N16; Cotality DigitalTax/LERETA [vendor-specific]): inbound bill feed → `escrow_bills`; fields consumed: parcel/APN, taxing agency, tax year, installment, amount, due date, "economic loss date" (penalty), discount data, payment status; idempotency on (vendor_ref, parcel, tax_year, installment); rejects → `escrow_line.status='exception'` and anomaly review; outage → fall back to `prior_year_cpi` estimates and re-analyze on receipt.
- **Insurance tracker / MI adapters / HOA** (Sections 9–10): renewal premium and due date feeds; same idempotency pattern.
- **CPI**: BLS CPI-U annual change stored in `rule_sets` parameters (yearly).
- **Fannie Mae**: none for the analysis itself; the resulting payment change is visible through the periodic statement and, after Dec 1, 2026, through the "Loan Escrow Contractual Payment Amount" attribute on escrow deposit events (3.7). Modification/deferral analyses feed SMDU case data (Section 12).
- **Ledger**: read-only for balances; no postings from the analysis (postings occur in 3.5 refunds and 2.1 deposits).

#### Outputs and artifacts
- `escrow_analyses` + `escrow_analysis_lines` (the "analysis worksheet"), `loan_terms` version with `escrow_payment_cents`, `shortage_installment_cents`, effective date; `loan_events`: `escrow.analysis.scheduled/completed/approved/effective/superseded`; statements per 3.1/3.3; refund per 3.5; `agent_decisions` record; Chapter 13 payment-change package to Section 14.2 when applicable; SMDU escrow fields to Section 12 for workouts.

#### AI agent design (AI-first)
- Agent: `escrow`. Pipeline: gather lines → validate bill provenance → run engine → inspect anomalies with tools (`compareBillToPriorYear`, `lookupParcel`, `readPolicyDeclarations`) → correct line data with cited evidence or accept → approve → hand to 3.3. Tools: `runEscrowAnalysis`, `approveAnalysis`, `overrideLineEstimate(reason, evidence_doc)`, `scheduleShortYear`, `openCase`, `escalate`, `recordBorrowerElection` (lump sum / ≥12 months in workouts).
- Decision record: {analysis_id, type, inputs hash, anomalies[], overrides[], decision matrix row, instrument caps applied, state overlays, rationale, model/prompt/rule-set versions, confidence}.
- Guardrails: the engine is deterministic TypeScript; the agent may not change base payment, cushion, or the Reg X option set; borrower elections must be evidenced (recorded call, e-signed form). Escalations: `human_agent` on request; `lossmit_reviewer` is *not* required for escrow math, but a workout analysis that changes the trial payment after the offer is routed to the `lossmit-underwriter` agent to re-issue the offer; `licensed_specialist` not applicable. Chapter 13 changes go to `bankruptcy-ops` for the 3002.1 filing (attorney signature where the district requires).
- AI-off path: `ops-console` "Run analysis" with the same commands and checklists.

#### Edge cases and failure modes
- Bill received after the analysis with > tolerance variance → `interim` analysis + short-year statement (3.3) rather than silently absorbing.
- Supplemental/corrected tax bills (e.g., California supplemental assessments): treated as new installments; if the account cannot cover, advance (3.7) and run an interim analysis before seeking repayment ((f)(1)(ii)).
- PMI termination mid-year (Section 10): line ends on the termination date; a re-analysis is triggered so the borrower stops paying MI escrow the month after termination (CFPB FAQ).
- Multi-year flood premium ((c)(9)): 36-month collection; annual statement explains the low point.
- Transfer-in: if the transferor's analysis is < 60 days old and the payment/method are unchanged, adopt it; otherwise run `transfer_in` and issue the (e)(1) initial statement within 60 days.
- Transfer-out: cancel scheduled analyses; the transferor short-year statement (3.3) uses a `payoff`-style history.
- Bankruptcy Chapter 13: analysis runs on schedule; the payment change is held for the 3002.1 notice; Chapter 7 with stay: analysis and statement proceed as informational (Section 14.3).
- SCRA/disaster forbearance: during forbearance the escrow deposits stop but disbursements continue; the `forbearance.exit` workout analysis spreads the resulting deficiency/shortage (B-1-01 60-month rule applies to deferral/modification; for repayment plans use the 12-month default unless the plan absorbs it).
- Successor in interest: no change to math; statements go to the confirmed successor.
- Partial data (no penalty date from vendor): use the statutory due date and flag anomaly; never skip the disbursement.
- Vendor outage at analysis time: use last known/CPI basis; schedule a verification interim analysis in 60 days.
- Reversal of a posted deposit after analysis (NSF): the analysis stands; the account balance simply falls; no re-analysis unless a disbursement fails.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 3.2-T1 | Given Appendix E lines, when the initial analysis runs, then required start = $780.00, cushion = $260.00, target start = $1,040.00, and the monthly table matches Appendix E Step 3 exactly. |
| 3.2-T2 | Given the annual example (county $520/$760, school $380; projected actual $700.00), when run 2027-05-16, then base $138.33, target $1,106.68, shortage $406.68, installment $33.89, new payment $172.22 effective 2027-07-01. |
| 3.2-T3 | Given projected actual $1,250.00, then surplus $143.32 → refund decision with due 2027-06-15 and payment $138.33. |
| 3.2-T4 | Given projected actual $1,080.00, then surplus $26.68 → monthly credit $2.22, first-month extra credit $0.04, payment $136.11. |
| 3.2-T5 | Given projected actual −$150.00, then deficiency $150.00 (12 × $12.50), shortage $1,106.68 (11 × $92.22 + $92.26), payment $243.05, final month $243.09. |
| 3.2-T6 | Given shortage exactly equal to one month's payment ($138.33), then the 30-day lump-sum option is not offered (≥ one month branch). |
| 3.2-T7 | Given surplus exactly $50.00 and borrower current, then refund is mandatory (≥ $50). |
| 3.2-T8 | Given `regx_days_delinquent = 31` at as_of_date and surplus $300, then decision = retain; given 30, then refund. |
| 3.2-T9 | Given `instrument_shortage_max_months = 12` and policy 12, then spread = 12; given a workout analysis, then spread = 60 unless a recorded borrower election shortens it (≥ 12). |
| 3.2-T10 | Given annual $1,660.00, then cushion = $276.66 (floor) and December target ≤ $276.66. |
| 3.2-T11 | Given a 3-year flood premium of $1,800 due 2028-03-01, then the line contributes $50.00/month and the statement flags the (c)(9) explanation. |
| 3.2-T12 | Given PMI terminates 2027-11-01, then MI installments after that date are excluded and the payment drops accordingly. |
| 3.2-T13 | Given an open Chapter 13 case, when the analysis is approved 2027-05-20, then `new_payment_effective_date` ≥ 21 days after the 3002.1 notice filing date. |
| 3.2-T14 | Given a NH property and a servicer-advanced deficiency, then the statement offers ≥ 12 months at 0% and no lump-sum demand. |
| 3.2-T15 | Given a payment change of 40%, then status = `anomaly_review` and the agent decision record lists the trigger before approval. |
| 3.2-T16 | Given a biweekly loan, then 26 periods, base = round_half_up(annual/26), cushion still ≤ 1/6 of annual. |
| 3.2-T17 | Given a leap-year February disbursement dated 02-29, then the projection places it in the February period without error. |

#### Audit and evidence
Immutable `escrow_analyses` + line tables (never edited; superseded by new rows), inputs snapshot hash, bill documents with hashes, `agent_decisions`, timer history, `loan_terms` version chain, borrower election evidence documents, and the rendered statement (3.3). Reconstructs any payment change for MORA, state exams, and RESPA/UDAAP litigation.

### Open questions / decisions
1. "One month's escrow account payment" basis — new base payment vs. current payment. **Default: new base payment** (conservative for the borrower because it usually makes the ≥-one-month branch apply, removing the 30-day lump-sum option).
2. Default shortage spread 12 vs. 24 months for non-workout analyses. **Default: 12** (matches the 2001 instrument cap; allow 24 by policy flag where the instrument permits).
3. Deficiency spread default (2 minimum). **Default: 12 months.**
4. Cushion policy — 2 months everywhere vs. state/instrument minima. **Default: 2 months capped by instrument/state.**
5. CPI modification for tax estimates. **Default: on for tax lines without a known bill; off for insurance.**
6. Analysis lead days. **Default: 45**, with the (i)(1) two-month assumption.

### Sources
- 12 CFR 1024.17 and Appendix E (see 3.1 sources); Supplement I to Part 1024 (comments 17(k)(5)) — https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Supplement%20I%20to%20Part%201024
- CFPB Mortgage Servicing FAQs (Escrow) — https://www.consumerfinance.gov/compliance/compliance-resources/mortgage-resources/mortserv/mortgage-servicing-faqs/
- Fannie Mae B-1-01 (09/11/2024): https://servicing-guide.fanniemae.com/svc/b-1-01/administering-escrow-account-and-paying-expenses
- Fannie Mae D2-3.2-06 (04/08/2026): https://servicing-guide.fanniemae.com/svc/d2-3.2-06/fannie-mae-flex-modification
- Fannie Mae F-1-27 (08/13/2025): https://servicing-guide.fanniemae.com/svc/f-1-27/processing-fannie-mae-flex-modification
- Freddie Mac 2021 Updated Uniform Instruments page (mandatory-use date): https://sf.freddiemac.com/tools-learning/uniform-instruments/2021-updated-instruments
- NH RSA 397-A:9: https://gc.nh.gov/rsa/html/XXXV/397-A/397-A-9.htm
