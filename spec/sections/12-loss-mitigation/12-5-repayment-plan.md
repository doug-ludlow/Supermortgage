# 12.5 — Repayment plan

| Attribute | Value |
|---|---|
| Section | 12 — Loss Mitigation |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On cure path (hardship resolved; borrower cannot reinstate in full but can pay more than the contractual payment for a period) |
| Governing source | FNMA D2-3.2-02 |
| Key deadlines | Per plan |
| Timers | `CA_CIV_2924_11D_LATE_FEE_BAR`, `FNMA_D2205_EVAL_NOTICE_REPAY`, `FNMA_D23201_FORB_COMBINED_36M`, `FNMA_D23202_REPAY_BRP_REQUIRED`, `FNMA_D23202_REPAY_PAYMENT_CAP_150`, `FNMA_D23202_REPAY_PAYMENT_EOM`, `FNMA_D23202_REPAY_TERM_MAX_12`, `FNMA_D23204_POSTREPAY_DEFERRAL_SOLICIT_15TH`, `FNMA_D23206_POSTREPAY_FLEX_SOLICIT_15TH`, `FNMA_F121_STATUS_12_BD2`, `FNMA_F202_REPAY_INCENTIVE_CLAIM`, `REGX_1024_41C2III_PERFORMANCE_HOLD`, `REGX_1024_41C2III_SHORTTERM_NOTICE_5` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Loss Mit |
| Trigger & frequency | On cure path (hardship resolved; borrower cannot reinstate in full but can pay more than the contractual payment for a period) |
| Governing source (blueprint) | FNMA D2-3.2-02 |
| Key deadlines (blueprint) | Per plan |
| Data/artifacts | Plan |
| Systems | SMDU |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Sub (Supermortgage offers, documents and reports the plan; Fannie Mae's prior written approval only for plans >12 months or extensions) |
| Nuances (blueprint) | "Wa[ive late] cha[rges] acc[rued] dur[ing plan] if mai[ntained] … Fan[nie Mae]" [cropped in source]; reconstructed from D2-3.2-02 (08/13/2025): "The servicer must waive late charges accrued during the repayment plan period as long as the terms of the repayment plan are maintained by the borrower"; late charges accrued before the plan may be included in the arrangement; plans longer than 12 months (or extensions) require Fannie Mae's prior written approval (F-1-16) |

### Verified requirement (as of 2026-09-09)

**Sources verified:** Fannie Mae D2-3.2-02 Repayment Plan (08/13/2025), F-1-16 Processing a Repayment Plan (05/10/2017), F-1-21 status code 12, F-2-02 ($500 incentive), F-2-10, D2-3.2-04/-06 post-failure solicitation clocks, A1-3-06 (MBS reclassification), C-3-01 (buydown funds); 12 CFR 1024.41(c)(2)(iii) and comments 41(c)(2)(iii)-4..-6; Cal. Civ. Code §2924.11(a)–(d); 3 NYCRR 419.7(j).

**Eligibility and documentation (D2-3.2-02).** The borrower must demonstrate the financial capacity to bring the loan current during the plan term. For loans **≤90 days delinquent with a plan not exceeding 6 months**, a complete BRP is **not** required — capacity is verified through QRPC; for loans **>90 days delinquent or plans exceeding 6 months**, a complete BRP **is** required. Plans **exceeding 12 months require Fannie Mae's written approval** (F-1-16: submit the plan, the complete BRP and any MI approval). When combined with a forbearance plan the total must not exceed **36 months** (D2-3.2-01).

**Terms.** "The total monthly repayment plan payment must not exceed 150% of the full monthly contractual payment." Standard maximum term **12 months**. **Late charges:** "The servicer must waive late charges accrued during the repayment plan period as long as the terms of the repayment plan are maintained by the borrower"; charges accrued at plan establishment may be included in the arrangement. Temporary buydown loans: the plan payment is computed on the buydown payment amount while the buydown is active (full contractual payment after it ends); remaining buydown funds are returned to Fannie Mae per C-3-01 after expiry. MBS loans: identify the pool issue date and reclassification rules (A1-3-06) — a repayment plan does not itself trigger reclassification.

**Written terms (D2-3.2-02, F-1-16).** Provided through an **Evaluation Notice** that discloses the monthly payment amounts and any scheduled changes; the written agreement must contain the repayment schedule (additional payment with each resumed regular payment), the specific **cure date**, a provision permitting the servicer to initiate or resume foreclosure if the terms are not satisfied, and, for unsigned agreements, language that by making a payment or acting under the agreement the borrower confirms it.

**Failure.** If the borrower fails to make the total monthly repayment-plan payment **by month-end** and QRPC is not achieved, the servicer must evaluate for a **payment deferral** (or disaster payment deferral) and solicit by the **15th day of the following month** if eligible (D2-3.2-04), otherwise evaluate for a **Flex Modification** and solicit by the 15th of the following month (D2-3.2-06).

**Reg X interplay.** A *short-term repayment plan* (comment 41(c)(2)(iii)-4) is one that repays **no more than three months of past-due payments over no more than six months**; offered on an incomplete application it triggers the written terms notice within 5 federal business days (specific amounts, due dates, whether the loan will be current at the end — for a repayment plan the answer is yes at the cure date; estimated escrow/rate changes flagged) and the (c)(2)(iii) foreclosure protections while performing. Longer plans on incomplete applications need a (c)(2)(ii) or comment 41(c)(2)(i)-1 basis, or a complete application. CA §2924.11(a)–(b): no NOD/NOS/sale while the borrower complies with a written repayment plan; (d) no late fees while a foreclosure-prevention alternative is being evaluated or exercised (broader than Fannie Mae's rule — CA loans have late charges suppressed from evaluation, not only from plan start). NY 419.7(j): no waiver of claims/defenses as a condition of a repayment plan.

**Reporting and incentive.** Status code **12 (Repayment Plan)** with effective and completion dates (F-1-21) monthly at BD2; from Q1 2027 an SMDU repayment-plan case (`smdu.plan_cases`). F-2-02: **$500** incentive when the loan was 60+ days delinquent and is brought current in a month separate from the status-code month, with a 12-month waiting period before another repayment-plan fee; retention incentives capped at $1,000 per loan.

**Discrepancies vs. blueprint row.** (1) "Per plan" hides hard rules: 150% payment cap, 12-month maximum, 36-month combined cap, BRP threshold (>90 days or >6 months), month-end payment deadline, and the 15th-of-following-month solicitation after failure. (2) The cropped nuance is the late-charge waiver conditioned on performance, plus Fannie Mae approval for >12-month plans (reconstructed above). (3) "Systems: SMDU" is future-dated (Q1 2027). (4) Class "a" upgraded to AI-first with calculator-enforced guards.

### Operational prerequisites
- **Partner policy:** whether to offer plans up to 12 months by default or cap at 6 without a BRP; "mitigating circumstances" for late month-end payments; late-charge waiver mechanics (suppress vs. waive at completion — Guide requires waiver "as long as maintained"; default: suppress during plan, permanently waive at completion, reinstate accrual from the failure month on default).
- **Templates:** `NTC_FNMA_D23202_REPAY_PLAN` (Evaluation Notice + agreement text per F-1-16; dual-cited §1024.41(c)(2)(iii) when on an incomplete application), `NTC_FNMA_D23202_REPAY_COMPLETED`, `NTC_FNMA_D23202_REPAY_FAILED`.
- **F-1-16 extension package** template for >12-month plans (BRP + plan + MI approval) — `fnma_portal_operator` if portal-only.
- **Cashiering rule** for plan payments (2.x): plan installments applied to the oldest unpaid installment first (loan-term order), never to fees before P&I/escrow; late-charge suppression flag.

### Build spec
#### Inputs and triggers
- 12.2 hierarchy result `repayment_plan` (hardship resolved; cannot reinstate; can afford ≤150%) from QRPC (≤90 days delinquent, ≤6 months) or from a complete BRP.
- `workout_plan.expired{forbearance}` with QRPC and resolved hardship → combined/sequential plan.
- `payment.received` (2.x) → schedule performance; `workout_plan.payment.missed` at month-end.
- `escrow.analysis.completed` / `rate.change.scheduled` → schedule re-estimate.
- `disaster.declared` overlay (disaster deferral path on failure).

#### Data model
- `workout_plans` (12.4) with `plan_type='repayment'`, `arrears_at_start_cents`, `late_charges_included_cents`, `term_months` (≤12; >12 with `fnma_approval_id`), `installment_cents`, `contractual_payment_cents` (PITI or buydown payment), `payment_cap_cents` (=150%), `cure_date`, `brp_required bool`, `brp_application_id?`, `regx_short_term bool` (≤3 months arrears over ≤6 months), `regx_basis`.
- `workout_plan_schedule` rows: `due_date`, `contractual_cents`, `installment_cents`, `expected_total_cents`, `received_cents`, `status`, `estimate_flags` (escrow/rate).
- `fees` rows for late charges during the plan carry `suppressed_by_case_id` and are written off (`waived`) at completion.

#### State machine
`offered` → `active` (acceptance by verbal/written/first payment; notice sent) → `completed` (cure date reached; loan current) | `failed` (month-end miss without QRPC/mitigation) → deferral/Flex Mod solicitation path | `terminated{borrower_request, ineligible}`; `active` → `extension_pending` (Fannie Mae approval) → `active`. Guards: `assertPaymentLe150`, `assertTermLe12OrApproved`, `assertBrpIfRequired`, `assertCombinedLe36`, `assertRegxBasis`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_D23202_REPAY_PAYMENT_CAP_150` | not_before_gate | plan create/modify | — | `expected_total ≤ 1.5 × contractual` | — | refused |
| `FNMA_D23202_REPAY_TERM_MAX_12` | not_before_gate | plan create/extend | — | term ≤12 `months` unless `fnma_approval` | — | refused → F-1-16 package |
| `FNMA_D23202_REPAY_BRP_REQUIRED` | not_before_gate | plan create | — | BRP complete if `fnma_delinquency_status` >90 days or term >6 months | — | refused; 12.1 diligence |
| `FNMA_D23201_FORB_COMBINED_36M` | not_before_gate | plan with forbearance component | — | ≤36 `months` | — | refused |
| `FNMA_D2205_EVAL_NOTICE_REPAY` | deadline | `workout_plan.offered` | offer date | 5 `calendar_days` | `notice.sent{NTC_FNMA_D23202_REPAY_PLAN}` | `officer` sev-2 |
| `REGX_1024_41C2III_SHORTTERM_NOTICE_5` | deadline | short-term plan on incomplete application | offer date | 5 `business_days_federal` | same notice | `officer` sev-1 |
| `FNMA_D23202_REPAY_PAYMENT_EOM` | deadline (per month) | schedule row | due date | last day of month 23:59 servicer-local | `received ≥ expected_total` | `workout_plan.payment.missed` |
| `FNMA_D23204_POSTREPAY_DEFERRAL_SOLICIT_15TH` | deadline | `workout_plan.failed{qrpc=false, deferral_eligible=true}` | month of failure | 15th of the following month | `notice.sent{NTC_FNMA_D23204_SOLICIT_POST_REPAY}` | sev-2 |
| `FNMA_D23206_POSTREPAY_FLEX_SOLICIT_15TH` | deadline | `workout_plan.failed{qrpc=false, deferral_eligible=false, flex_eligible=true}` | same | 15th of the following month | `notice.sent{NTC_FNMA_D23206_SOLICIT_STREAMLINED}` | sev-2 |
| `REGX_1024_41C2III_PERFORMANCE_HOLD` | not_before_gate | `workout_plan.active` | — | while performing | plan end | 13.x refuses referral/motion/sale (`foreclosure_holds{kind=fnma_plan_performing}`) |
| `CA_CIV_2924_11D_LATE_FEE_BAR` | not_before_gate | CA loan under evaluation/plan | — | — | — | `fees.assess_late_charge` refused |
| `FNMA_F121_STATUS_12_BD2` | recurring | month-end with active plan | BD2 | 2 `business_days_fannie_et` | investor event accepted (5.x) | sev-2 |
| `FNMA_F202_REPAY_INCENTIVE_CLAIM` | deadline (policy) | `workout_plan.completed` (60+ days delinquent at start) | completion month | claim in the following month's cycle | `investor_events{incentive}` | sev-3 |

#### Business rules and calculations
1. **Arrears at start** = unpaid contractual installments (P&I + escrow) + late charges accrued before the plan (optional inclusion, default include) + unpaid NSF/other fees the borrower agrees to include; excludes corporate advances not yet billed.
2. **Installment** = ceil-to-cent(arrears ÷ term_months); last installment absorbs rounding (`bigint` cents; residual ≤ term_months−1 cents).
3. **Cap:** `contractual + installment ≤ 1.5 × contractual` (contractual = full PITI, or the buydown payment while a buydown is active). Term = smallest number of months (≤12) satisfying the cap and the borrower's stated capacity; if no term ≤12 satisfies the cap → repayment plan **ineligible** ("cannot afford a repayment plan") → payment deferral path (F-2-10).
4. **Worked example:** PITI $2,100.00; 3 installments unpaid ($6,300.00) + 2 late charges of $63.00 ($126.00; 4% of P&I $1,580.17 = $63.21 → assume $63.00 per note) = $6,426.00. 6-month plan: installment $1,071.00 → total $3,171.00 = 151.0% of PITI → **exceeds the cap → not allowed**. 8-month plan: installment $803.25 → total $2,903.25 = 138.25% → allowed; cure date = 8th installment month. If the borrower can pay only $2,500 (119%), a 12-month plan gives $535.50 + $2,100 = $2,635.50 → still above capacity → **repayment plan ineligible**, evaluate deferral (3 months delinquent → eligible if other 12.6 criteria hold).
5. **Reg X short-term flag:** `regx_short_term = (months_of_arrears ≤ 3) AND (term ≤ 6)`; the 8-month example is *not* short-term → on an incomplete application it needs a (c)(2)(ii)/(c)(2)(i)-1 basis or a complete application (which Fannie Mae requires anyway for >6-month plans — the two rules align).
6. **Late charges:** suppressed from plan start; on completion, all plan-period charges are permanently waived (`fees.waive` with reason `D2-3.2-02`); on failure, charges accrue from the failed month forward (never for months in which the plan was maintained). CA: suppression from the start of evaluation (§2924.11(d)).
7. **Escrow/rate changes mid-plan:** on `escrow.analysis.completed` or ARM change, recompute `contractual_cents` prospectively; the installment is unchanged; the cap is re-tested — if breached, offer a re-cast (extend within 12) with a new notice.
8. **Application of funds:** each plan payment posts as a full contractual installment (oldest first) plus the extra to the next oldest unpaid installment; partial receipts sit in suspense until a full expected_total accumulates (2.x rule), unless the borrower directs otherwise in writing.
9. **Completion:** loan current when all unpaid installments are satisfied; `workout_plan.completed`, status 12 completion date reported, incentive claim.

#### Integrations
- **Fannie Mae reporting:** status 12 with effective/completion dates (F-1-21) monthly; SMDU repayment-plan case from Q1 2027 (`smdu.plan_cases`); LAR/payment events flow normally (5.x).
- **F-1-16 approvals** (>12 months/extensions): package prepared by the agent; submitted via SMDU/servicing solutions system if supported, else `human_portal_task`.
- **Cashiering (2.x):** schedule and application rules; late-charge suppression.
- **Credit bureaus (8.x):** Metro 2 repayment-plan reporting.
- **Print/mail/e-delivery:** plan notice and completion letter.

#### Outputs and artifacts
- `NTC_FNMA_D23202_REPAY_PLAN` (D2-3.2-02; F-1-16; §1024.41(c)(2)(iii)): schedule table (due dates, contractual, installment, total), cure date, estimate flags and reason (escrow analysis/rate change), foreclosure-resumption provision, unsigned-agreement acceptance language, late-charge waiver statement, "application incomplete / other options / may complete" statements when applicable, SPOC/counselor blocks, NY no-waiver-of-claims statement.
- `NTC_FNMA_D23202_REPAY_COMPLETED` (loan current; late charges waived), `NTC_FNMA_D23202_REPAY_FAILED` (next steps; deferral/Flex Mod solicitation follows).
- Records: `workout_plans`, `workout_plan_schedule`, fees waivers, investor events (12; incentive), `agent_decisions{kind=lossmit.repayment}`, `foreclosure_holds{kind=fnma_plan_performing}`.
- Ledger: normal payment postings; `late_charges` write-offs at completion (contra entry, never edits).

#### AI agent design (AI-first)
- **Agent:** `lossmit-underwriter` sub-role `plans`. Tools: `workout_plan.*`, `ledger.arrears`, `calc.repayment_schedule`, `fees.suppress/waive`, `notice.render_send`, `fnma.status_code.report`, `fnma.f116_package.prepare`, `timers.*`.
- **Decision record:** `{plan_id, basis, qrpc_or_brp, arrears breakdown, capacity_stated, candidate terms[{months, installment, total, pct}], chosen, cap_check, brp_check, regx_short_term, regx_basis, notices}`.
- **Guardrails:** calculator is deterministic; the agent cannot alter installment math; cannot set a term >12 without an approval id; cannot waive late charges outside the rule; must re-test the cap on every contractual change.
- **Escalations:** >12-month plans → `fnma_portal_operator`/`officer` package; borrower asks for a human → `human_agent`; suspected inability to perform (capacity < cap) → deferral path, not escalation.
- **AI-off:** human collectors use the same calculator/templates.

#### Edge cases and failure modes
- **Borrower pays ahead / reinstates:** early completion; incentive eligibility unaffected (brought current in a separate month).
- **ARM/escrow change mid-plan:** recast per rule 7; new notice.
- **Buydown active:** contractual = buydown payment; funds not applied to arrears unless the agreement requires (C-3-01).
- **Transfer-in/out:** plan and schedule carried; CA §2924.11(e) honor rule; incentive claim by the completing servicer.
- **Bankruptcy filed:** plan may be superseded by a Chapter 13 plan; coordinate with `bankruptcy-ops`.
- **Disaster mid-plan:** failure routes to the disaster deferral solicitation (12.7) by the 15th of the following month.
- **Payment returned NSF after month-end:** treated as missed for that month (reversal), with mitigating-circumstances review before termination.
- **Retro-correction:** erroneous failure → reinstate the plan, reverse late charges.

#### Test cases and acceptance criteria
- **12.5-T1:** Given PITI $2,100.00 and arrears $6,426.00, when terms are computed, then 6 months is rejected (151.0%) and 8 months accepted ($2,903.25; 138.25%); the schedule sums exactly to $6,426.00 with rounding in the last installment.
- **12.5-T2 (BRP gate):** loan 95 days delinquent → plan creation refused until the BRP is complete; 85 days + 6-month term → allowed on QRPC.
- **12.5-T3 (>12 months):** 14-month request → F-1-16 package generated; plan stays `extension_pending` until approval id recorded.
- **12.5-T4 (late charges):** charges during the plan are suppressed; at completion they are written off with reason; on failure in month 5, charges accrue from month 5 only.
- **12.5-T5 (failure clock):** payment missed at 2026-11-30 month-end, no QRPC, 4 months delinquent → deferral solicitation sent by 2026-12-15; if deferral-ineligible → Flex Mod solicitation by 2026-12-15.
- **12.5-T6 (Reg X short-term):** 3 months arrears over 6 months on an incomplete application → `regx_short_term=true`; terms notice within 5 federal BD; foreclosure hold active while performing.
- **12.5-T7 (CA):** late fee assessment refused from the evaluation start date, not only from plan start.
- **12.5-T8 (reporting):** status 12 with effective date reported at BD2; completion date reported in the completion month; $500 incentive claimed when the start delinquency was ≥60 days.
- **12.5-T9 (recast):** escrow analysis raises PITI to $2,250 in month 3 → total $3,053.25 = 135.7% (still under cap) → no recast; a rise to $2,050 P&I-only edge case handled by the cap re-test.

#### Audit and evidence
Capacity evidence (QRPC record/BRP), calculator inputs/outputs, notice with proof, schedule and payment postings, late-charge suppression/waiver entries, status-code submissions and acks, F-1-16 approval evidence, hold history.

### Open questions / decisions
1. **Include pre-plan late charges in arrears by default.** Default: yes (Guide permits), disclosed in the schedule.
2. **Default plan-length policy without BRP.** Default: up to 6 months on QRPC; longer only with a complete BRP.
3. **Capacity test:** borrower-stated affordable amount vs. computed surplus. Default: stated amount on QRPC (≤6 months), computed from the BRP otherwise.

### Sources
- Fannie Mae D2-3.2-02: https://servicing-guide.fanniemae.com/svc/d2-3.2-02/repayment-plan (08/13/2025; verified 2026-09-09)
- Fannie Mae F-1-16: https://servicing-guide.fanniemae.com/svc/f-1-16/processing-repayment-plan (05/10/2017; verified 2026-09-09)
- Fannie Mae F-1-21, F-2-02, F-2-10 (see 12.4/12.2 sources; verified 2026-09-09)
- 12 CFR 1024.41(c)(2)(iii); comments 41(c)(2)(iii)-4..-6 (verified 2026-09-09)
- Cal. Civ. Code §2924.11: https://law.justia.com/codes/california/code-civ/division-3/part-4/title-14/chapter-2/article-1/section-2924-11/ (verified 2026-09-09)
- 3 NYCRR 419.7(j) (verified 2026-09-09)
