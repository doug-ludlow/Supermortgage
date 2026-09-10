# 3.6 — Shortage repayment

| Attribute | Value |
|---|---|
| Section | 3 — Escrow Administration |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On analysis |
| Governing source | Reg X 1024.17(f)(3) |
| Key deadlines | Shortage < 1 mo payment: allow / 30-day / ≥12-mo; shortage ≥ 1 mo: allow or ≥12-mo spread. No $50 threshold (surplus-only) |
| Timers | `ESC_LUMPSUM_REANALYSIS_10BD`, `FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE`, `REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE`, `REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE`, `REGX_1024_17F4_DEFICIENCY_MIN_INSTALLMENTS_GATE`, `REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Escrow |
| Trigger & frequency | On analysis |
| Governing source (blueprint) | Reg X 1024.17(f)(3) |
| Key deadlines (blueprint) | Shortage < 1 mo payment: allow / 30-day / ≥12-mo; shortage ≥ 1 mo: allow or ≥12-mo spread. No $50 threshold (surplus-only) |
| Data/artifacts | Analysis |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Sub performs; SoR liable |
| Nuances (blueprint) | [cropped in source] — reconstructed: deficiency rules (f)(4) with 2-payment minimum; delinquent-borrower carve-outs; (f)(5) notice; unsolicited lump sums; Fannie Mae 60-month workout spread; instrument 12-month cap; NH 12-month/0% deficiency option |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.17(f)(3)–(5)** (eCFR current as of Sept. 4, 2026):
- (f)(3)(i) shortage < one month's escrow account payment: the servicer "may allow a shortage to exist and do nothing to change it," "may require the borrower to repay the shortage amount within 30 days," or "may require the borrower to repay the shortage amount in equal monthly payments over at least a 12-month period." (f)(3)(ii) shortage ≥ one month's payment: allow it, or "require the borrower to repay the shortage in equal monthly payments over at least a 12-month period."
- (f)(4): a confirmed deficiency lets the servicer "require the borrower to pay additional monthly deposits to the account to eliminate the deficiency"; (i) deficiency < one month: allow; "repay the deficiency within 30 days"; or "repay the deficiency in 2 or more equal monthly payments"; (ii) deficiency ≥ one month: allow, or "two or more equal monthly payments"; (iii) these provisions apply only if the borrower is current (payment received within 30 days of the due date); otherwise "the servicer may recover the deficiency pursuant to the terms of the federally related mortgage loan documents."
- (f)(1)(ii): analysis required before seeking repayment of a servicer advance not caused by borrower default. (f)(5): at least one shortage/deficiency notice per computation year (annual statement or separate).
- (k)(2): the servicer "must advance funds to make disbursements in a timely manner as long as the borrower's payment is not more than 30 days overdue. Upon advancing funds to pay a disbursement, the servicer may seek repayment from the borrower for the deficiency pursuant to paragraph (f)." (k)(5)(ii)(C): hazard-insurance advances may be recouped "pursuant to paragraph (f)" unless other law prohibits; comment 17(k)(5)(ii)(C)-1 allows month-to-month premium advances where the insurer accepts them.
- CFPB FAQ (June 2, 2021): a servicer "may accept an unsolicited lump sum repayment" for a ≥-one-month shortage/deficiency but may not require or offer it in the annual statement; a separate, clearly optional communication is permitted.

**Fannie Mae**: B-1-01 (09/11/2024) — payment deferral and modification shortages: "spread … in equal monthly payments over a period of 60 months, unless the borrower decides to pay" in a lump sum or a shorter period "of not less than 12 months"; later annual shortages: remaining initial period or up to 60 months. B-1-01 (Advancing Funds): "the servicer must promptly advance the funds"; "must require the borrower to reimburse it"; "Any funds the servicer advances must stay in the T&I custodial account until the borrower remits funds sufficient to cure the deficit." D2-3.2-06: escrow shortage at modification "must not be capitalized" and the servicer "is not required to fund" it. F-1-05 (06/11/2025): T&I advances are reimbursable by Fannie Mae only if the loan subsequently becomes delinquent, with recovery from reinstatement/workout proceeds remitted to Fannie Mae within 60 days (Section 15.2).

**Other law**: uniform instrument Section 3 (2001 vintage: "in no more than 12 monthly payments"; 2021: "in accordance with RESPA") **[PARTIALLY VERIFIED]**; NH RSA 397-A:9, III (verified): licensee-advanced deficiency → borrower option to repay over "not less than 12 months" with no interest; Bankruptcy Rule 3002.1 for Chapter 13 payment changes (Section 14.2).

**Discrepancies with the blueprint row**: none in the shortage text; the row omits deficiencies ((f)(4)), the Fannie Mae 60-month workout rule, the instrument cap, and the advance-recoupment rules.

### Operational prerequisites
- Analysis engine (3.2) live; `loan_terms` effective-dated escrow payment versioning; cashiering application rules (Section 2.1) treating the shortage installment as part of the escrow portion.
- Corporate advance funding line and T&I custodial funding procedure (Section 6.2); F-1-05 claim process (Section 15.2).
- Borrower election capture (recorded call with disclosure, portal e-form, or signed form) — Sections 4/7.4.
- Rule set parameters: default spreads (12/12), workout spread (60), NH overlay; counsel sign-off.

### Build spec
#### Inputs and triggers
- `escrow.analysis.approved` with `decision.shortage_cents > 0` or `deficiency_cents > 0` (any analysis type).
- `escrow.advance.posted` (3.7) → interim analysis gate → repayment plan.
- `payment.received` with `escrow_lump_sum_indicator` or borrower-designated "escrow shortage payment" → post to escrow → interim analysis within 10 BD → short-year statement.
- `lossmit.*` events (deferral approved, modification trial offered/effective) → workout spread rules.
- `escrow.repayment_plan.installment_due` (monthly, derived from payment due dates) → progress tracking; `loan.reinstated` → re-evaluate retained deficiencies.

#### Data model
- `escrow_repayment_plans` (new): `id`, `escrow_account_id`, `analysis_id`, `kind` ∈ {shortage, deficiency}, `basis` ∈ {regx_default, workout_60, borrower_election, instrument_cap, state_nh}, `total_cents`, `months int`, `installment_cents`, `final_installment_cents`, `start_due_date`, `end_due_date`, `collected_cents`, `remaining_cents`, `status` ∈ {active, completed, superseded, paid_lump, cancelled}, `election_evidence_document_id`, `interest_bearing bool default false`.
- `escrow_accounts.shortage_installment_cents`, `deficiency_installment_cents` (sum of active plans), used by `loan_terms` versioning.
- Ledger: loan `escrow` may carry a negative balance (deficiency); custodial `servicer_advance_receivable` and corporate `escrow_advances` per architecture baseline §5; no separate shortage receivable (a shortage is a projection gap, not a debt until billed).

#### State machine
Plan: `proposed` (in analysis decision) → `active` (analysis approved; first installment date set) → `completed` (remaining = 0) | `superseded` (a later analysis recomputes the gap; the new plan replaces it and never double-counts collected amounts) | `paid_lump` (borrower voluntarily paid ≥ remaining) | `cancelled` (payoff/transfer/foreclosure). Deficiency plans additionally have `retained_pending_reinstatement` when the borrower is not current at analysis (recovery per loan documents; no demand letter beyond the statement). Actors: engine; `escrow` agent (elections); cashiering (collected_cents updates); timer-sweep.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE` | not_before_gate | `escrow.analysis.computing` | — | plan.months ≥ 12 when shortage ≥ one month (or any spread option chosen) | analysis approval | approval refused |
| `REGX_1024_17F4_DEFICIENCY_MIN_INSTALLMENTS_GATE` | not_before_gate | `escrow.analysis.computing` | — | plan.months ≥ 2 | analysis approval | approval refused |
| `REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE` | not_before_gate | `escrow.advance.posted` | — | interim analysis completed | `escrow.analysis.completed` | `demandDeficiencyRepayment` refused |
| `FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE` | not_before_gate | workout analysis | — | plan.months = 60 unless borrower election (≥ 12) evidenced | analysis approval | approval refused; sev-2 |
| `ESC_LUMPSUM_REANALYSIS_10BD` | deadline (internal) | `escrow.lump_sum.received` | received date | 10 business_days_servicer | `escrow.analysis.completed` (interim) | sev-3 |
| `REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL` | (defined in 3.3) | | | | | |
| Jurisdiction overrides | | NH: deficiency plans `months ≥ 12`, `interest_bearing=false`, borrower option language on the notice; instrument `uniform_2001`: `months ≤ 12` for shortage and deficiency | | | | |

#### Business rules and calculations
1. **Plan construction**: `months` per the 3.2 decision matrix; `installment = round_half_up(total / months)`; `final_installment = total − installment × (months − 1)` (absorbs residual cents, may be ± a few cents); `start_due_date = new_payment_effective_date`; `end_due_date = start + (months − 1) months`.
2. **Instrument cap**: `months = min(months, instrument_shortage_max_months ?? ∞)`; if the cap (12) conflicts with the Fannie Mae 60-month workout rule, the modification agreement (Form 3179) governs the modified loan and the 60-month spread applies — record `basis='workout_60'` and the agreement document id.
3. **Borrower elections** (workouts): lump sum, or a shorter period ≥ 12 months, captured with evidence; an election reduces `months` and recomputes installments; elections for non-workout shortages are honored only as unsolicited lump sums (no shorter mandatory spreads below 12 months).
4. **Lump-sum receipt**: post to `escrow`; mark plan `paid_lump` when `received ≥ remaining`; run an interim analysis within 10 BD; new payment effective next due date ≥ 30 days after the short-year statement; the short-year statement resets the computation year (3.3).
5. **Collection tracking**: each posted full payment increments `collected_cents` by `installment_cents` (or the final amount); partial payments in suspense (2.2) do not increment; when `remaining_cents = 0` the plan completes and `loan_terms` escrow payment drops by the installment on the next due date (a new `loan_terms` version is created at plan creation with the step-down date so no re-analysis is needed).
6. **Deficiency from advances**: ledger on advance: Dr `custodial_ti_cash` / Cr `servicer_advance_receivable` (servicer funds deposited into T&I custodial per B-1-01), then the disbursement Dr loan `escrow` / Cr `custodial_ti_cash` leaving loan `escrow` negative; borrower deficiency deposits restore the balance; the servicer withdraws its advance only when the loan's escrow balance ≥ 0 (B-1-01 "stay in the T&I custodial account until the borrower remits funds sufficient to cure the deficit"). No interest is charged on deficiencies (policy; NH mandatory).
7. **Not-current borrowers**: no 30-day demand; plan created with `retained_pending_reinstatement` for deficiencies; statements (or the (f)(5) notice) still disclose; at reinstatement (Section 12/13 reinstatement quote) the reinstatement amount may include the deficiency per the instrument, and any remaining gap is spread on the post-reinstatement interim analysis.
8. **Notice**: the annual statement item (vii) states the plan ("$33.89 per month for 12 months beginning 07/01/2027"); for ≥-one-month gaps the statement never mentions a lump-sum option; the optional insert may (3.3).

Worked examples: (a) shortage $406.68 → 12 × $33.89 (final $33.89), start 2027-07-01, end 2028-06-01; payment $172.22, stepping down to $138.33 on 2028-07-01 automatically. (b) deficiency $150.00 + shortage $1,106.68 → deficiency 12 × $12.50; shortage 11 × $92.22 + $92.26; payment $243.05, final $243.09. (c) Flex Mod workout analysis shortage $2,400.00 → 60 × $40.00; borrower elects 24 months → 24 × $100.00 (evidence: e-signed election). (d) NH licensee advance $900.00 (tax) → deficiency plan 12 × $75.00 at 0% with the statutory option language. (e) Unsolicited lump sum $406.68 received 2027-09-10 → plan `paid_lump`; interim analysis 2027-09-15; short-year statement sent 2027-09-18; payment $138.33 effective 2027-11-01.

#### Integrations
- Cashiering (Section 2.1/2.2): reads the effective-dated escrow payment; reports `payment.received` with escrow portion; suspense rules unchanged.
- Loss mitigation (Section 12): workout analyses and elections; SMDU escrow data fields (trial payment includes escrow).
- Fannie Mae escrow events (3.7): deficiency deposits are ordinary "Loan Escrow Payment" deposits; negative T&I balances are allowed (Reference Guide rule).
- F-1-05 claims (Section 15.2) for advances after delinquency.

#### Outputs and artifacts
- `escrow_repayment_plans`; `loan_terms` versions (payment and step-down); notices via 3.3 (`NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT`, `NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR`/`_PAYOFF`/`_RESET`, `NTC_REGX_1024_17F_SHORTAGE`) and `NTC_SM_ESCROW_ADVANCE` (informational: "we advanced $X for [item] on [date]; an analysis will follow" — policy notice, no citation beyond (f)(1)(ii)); `loan_events`: `escrow.repayment_plan.created/completed/superseded/paid_lump/cancelled`, `escrow.deficiency.retained`, `escrow.lump_sum.received`.

#### AI agent design (AI-first)
- Agent: `escrow`. Creates plans from approved analyses; records elections; handles borrower calls about shortages via `borrower-comms` scripts (explains options accurately: for ≥ one month, only allow/spread — never demands a lump sum); triggers interim analyses on lump sums. Tools: `createRepaymentPlan`, `recordBorrowerElection`, `postEscrowLumpSum`, `runEscrowAnalysis(interim)`, `sendNotice`, `escalate`.
- Decision record: {plan id, basis, months, installment, caps applied, election evidence, rationale}.
- Guardrails: no plan < 12 months for ≥-one-month shortages; no deficiency plan < 2 installments; no interest; no fees; no lump-sum demand in statements; workout plans default to 60 months. Escalations: `human_agent` on request; disputes → 4.1; Chapter 13 → `bankruptcy-ops`.
- AI-off path: ops-console plan editor bound by the same gates.

#### Edge cases and failure modes
- New analysis before a plan ends: the new shortage already nets what was collected; the old plan is `superseded` — the engine must not add the old remaining balance to the new shortage.
- Escrow line removed mid-plan (e.g., PMI terminated): interim analysis; plan superseded by a smaller or zero plan.
- Transfer-out: plan cancelled here; the transferee inherits the gap via (e)(2).
- Payoff: remaining shortage is irrelevant (target no longer applies); deficiency (negative balance) is collected through the payoff figure (Section 16.1).
- Bankruptcy Chapter 13: post-petition escrow shortages are handled through 3002.1 payment changes; pre-petition deficiencies are claim items (Section 14.1) — never demanded directly.
- Disaster forbearance: disbursements during forbearance create deficiencies; the exit workout analysis spreads them under the 60-month rule when the exit is a deferral/modification; otherwise 12 months.
- Advance reimbursed by Fannie Mae (F-1-05) and later collected from the borrower → remit to Fannie Mae within 60 days (Section 15.2).
- Vendor bill errors causing over-advance → refund from payee credited to escrow; interim analysis if material.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 3.6-T1 | Given shortage $406.68 and base $138.33, then plan 12 × $33.89, final $33.89, and `loan_terms` shows $172.22 from 2027-07-01 stepping to $138.33 on 2028-07-01. |
| 3.6-T2 | Given shortage $100.00 (< one month), then options allow/30-day/12-month are available and the default plan is 12 × $8.33 with final $8.37. |
| 3.6-T3 | Given deficiency $150.00 with `regx_days_delinquent=0`, then plan 12 × $12.50; given 2 installments configured, then 2 × $75.00. |
| 3.6-T4 | Given a workout analysis shortage $2,400 with no election, then 60 × $40.00; with an evidenced 24-month election, 24 × $100.00; with a 6-month election, the election is rejected (≥ 12). |
| 3.6-T5 | Given `instrument_shortage_max_months=12` and policy 24, then months = 12. |
| 3.6-T6 | Given an unsolicited lump sum equal to remaining shortage, then plan `paid_lump`, interim analysis within 10 BD, short-year statement, and the payment steps down on the first due date ≥ 30 days after the statement. |
| 3.6-T7 | Given an advance of $900 on a NH property, then the deficiency plan is ≥ 12 months at 0% and the statement carries the RSA 397-A:9 option text. |
| 3.6-T8 | Given a servicer advance and `demandDeficiencyRepayment` called before the interim analysis, then the command is refused with gate `REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE`. |
| 3.6-T9 | Given a second analysis mid-plan with collected $203.34, then the new shortage reflects the actual balance and the old plan is `superseded` without double counting. |
| 3.6-T10 | Given the annual statement for a ≥-one-month shortage, then the rendered text contains no lump-sum wording (validator check). |

#### Audit and evidence
Plans with basis and evidence documents, `loan_terms` version chain, ledger entries for advances and cures, statements/notices, decision records, gate evaluations, borrower-comms transcripts for elections.

### Open questions / decisions
1. Spread deficiencies over 12 or a shorter default (e.g., 6)? **Default: 12.**
2. Send a standalone advance notice when the servicer advances? **Default: yes** (policy, reduces disputes).
3. Allow borrower-elected shorter spreads (≥ 12 → e.g., 12 when default is 24) for non-workout shortages? **Default: n/a (default is already 12).**

### Sources
- 12 CFR 1024.17(f), (k)(2), (k)(5)(ii)(C); Supplement I comment 17(k)(5)(ii)(C)-1 (see 3.1/3.2 sources)
- CFPB Mortgage Servicing FAQs (lump-sum communications): https://www.consumerfinance.gov/compliance/compliance-resources/mortgage-resources/mortserv/mortgage-servicing-faqs/
- Fannie Mae B-1-01, D2-3.2-06, F-1-27 (see 3.2 sources); F-1-05 (06/11/2025): https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement
- NH RSA 397-A:9: https://gc.nh.gov/rsa/html/XXXV/397-A/397-A-9.htm
