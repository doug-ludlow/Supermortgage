# 12.7 — Disaster Payment Deferral

| Attribute | Value |
|---|---|
| Section | 12 — Loss Mitigation |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | Disaster hardship (FEMA-declared disaster with Individual Assistance, insured loss, or employment in the disaster area; typically after a disaster forbearance) |
| Governing source | FNMA D2-3.2-05 |
| Key deadlines | Solicit within 15 days after forbearance expiration |
| Timers | `FNMA_D1301_DISASTER_FLEX_ROUTE`, `FNMA_D23205_12M_CONTRACTUAL_PAYMENT_GATE`, `FNMA_D23205_AGREEMENT_SEND_5`, `FNMA_D23205_DDEFERRAL_ELIGIBILITY_GATES`, `FNMA_D23205_DDEFERRAL_SMDU_ENTRY_EOM`, `FNMA_D23205_POSTFORB_SOLICIT_15`, `FNMA_D23205_POSTREPAY_SOLICIT_15TH`, `FNMA_LL202601_DISASTER_FC_PRIOR_APPROVAL_5` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Loss Mit |
| Trigger & frequency | Disaster hardship (FEMA-declared disaster with Individual Assistance, insured loss, or employment in the disaster area; typically after a disaster forbearance) |
| Governing source (blueprint) | FNMA D2-3.2-05 |
| Key deadlines (blueprint) | Solicit within 15 days after forbearance expiration |
| Data/artifacts | Agreement |
| Systems | SMDU |
| Automation class (blueprint) | b |
| SoR / Sub | Sub |
| Nuances (blueprint) | (blank in source) |

### Verified requirement (as of 2026-09-09)

**Sources verified:** Fannie Mae D2-3.2-05 Disaster Payment Deferral (08/13/2025), D1-3-01 (04/08/2026), D2-3.2-01 (disaster forbearance), LL-2026-01 (disaster foreclosure prior approval), F-1-22, F-2-02 ($500), F-2-06, B-1-01; 12 CFR 1024.41 as in 12.6.

**Eligibility (D2-3.2-05).** The borrower must have a financial hardship caused by the disaster (loss/reduction of income or increased expenses) **and** one of: the property experienced an **insured loss**, the property is in a **FEMA-Declared Disaster Area eligible for Individual Assistance**, or the borrower's **place of employment** is in such an area. The loan must have been **current or less than two months delinquent when the disaster occurred** (if 2+ months delinquent at the disaster, the servicer may request Fannie Mae's prior approval when the full payment is sustainable) and must be **equal to or greater than one month delinquent but less than or equal to 12 months delinquent** at evaluation. QRPC achieved; hardship resolved; borrower able to continue the full contractual payment including a 60-month escrow-shortage repayment; unable to reinstate or afford a repayment plan. Conventional first lien (fixed, step-rate, ARM); property may be vacant or condemned; **no prior disaster payment deferral for the same event** (prior non-disaster deferrals do not disqualify); not within **36 months** of maturity; not subject to recourse/indemnification, an approved liquidation option, an active repayment plan, a pending modification trial or a competing retention offer. No complete BRP required; no disaster forbearance prerequisite; no origination-seasoning criterion is listed (contrast 12.6) **[verified by absence in D2-3.2-05]**.

**Terms.** Defer (non-interest-bearing; due at maturity/sale/refinance/payoff) **up to 12 months of past-due P&I**, third-party escrow advances and (where state law permits) third-party servicing advances paid before the effective date; escrow analysis required before offering, shortage excluded from the NIB (servicer need not fund it); if law prohibits an escrow account, T&I must be current; no administrative fees; all late charges/penalties/similar fees waived on completion; all other terms unchanged. The disaster deferral **does not count** toward the 12-month cumulative cap on standard deferrals (D2-3.2-04). MBS: no reclassification; MI: delegated insurers per F-2-06; buydown rules as in 12.6.

**Timing, solicitation and documentation.** Case entered into the servicing solutions system by the **last day of the evaluation month** (processing month permitted under a written equal-treatment policy when not completed by the 15th); agreement sent within **five days** after completion; custodian delivery within **25 days** of the effective date (certified copy if recordable; original within **5 business days** of receipt from the recorder). If the loan is **12 months delinquent** at evaluation, the borrower must make the full contractual payment during the solicitation/processing month before completion. **Solicit within 15 days after expiration of a disaster-related forbearance plan** if QRPC was not achieved and the borrower is otherwise eligible ("Payment Deferral Post-Disaster Forbearance Plan Solicitation Cover Letter"); after a missed repayment-plan payment at month-end without QRPC, solicit **by the 15th of the following month** ("Disaster Payment Deferral Post-Repayment Plan Solicitation Cover Letter"); both paired with the payment deferral agreement and acceptance instructions. Acceptance: contact, executed agreement, or other servicer-determined evidence. Texas §50(a)(6): Form 20 within 7 business days; 60-day cure. Incentive: **$500** (F-2-02).

**Disaster hierarchy (D1-3-01).** With QRPC: disaster payment deferral → Flex Modification with reduced (disaster) criteria → standard Flex Modification → liquidation options; without QRPC during forbearance: solicit for the disaster deferral → Flex Mod (reduced criteria) → standard Flex Mod, continuing contact attempts; no forbearance: Flex Mod (reduced criteria) with solicitation at 90+ days delinquent. Property inspection (Form 30) and insurance-claim handling per 9.x. **LL-2026-01:** Fannie Mae's prior written approval is required before referring a disaster-impacted loan to foreclosure — submission to hazard_loss@fanniemae.com within **5 days** of completing the pre-referral review (13.4).

**Discrepancies vs. blueprint row.** The row is correct on the 15-day post-forbearance solicitation but omits the 1–12-month delinquency window, the current/<2-months-at-disaster condition, the insured-loss/FEMA/employment test, the 12-month P&I deferral limit, the same-event exclusion, the post-repayment-plan 15th-of-month clock, the 12-months-delinquent contractual-payment rule and the cumulative-cap carve-out.

### Operational prerequisites
- Same as 12.6 plus: **disaster event registry** (FEMA declarations with Individual Assistance designations by county; declaration/incident dates) maintained by `insurance-property`/`compliance-sentinel` (9.x) with daily refresh from FEMA's public API **[UNVERIFIED — FEMA OpenFEMA API assumed available]**; employment-address capture in QRPC; insured-loss linkage to loss-draft claims (9.x).
- Templates: `NTC_FNMA_D23205_DISASTER_DEFERRAL_OFFER`, `NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB`, `NTC_FNMA_D23205_SOLICIT_POST_REPAY`, agreement variant.
- Partner policy on requesting Fannie Mae prior approval for borrowers 2+ months delinquent at the disaster.

### Build spec
#### Inputs and triggers
- `disaster.event.linked{loan_id, event_id, basis ∈ {property_fema_ia, insured_loss, employment_fema_ia}}` (9.x) + QRPC with resolved hardship → screen.
- `workout_plan.expired{forbearance, disaster=true, qrpc=false}` → 15-day solicitation; `workout_plan.failed{repayment, disaster=true, qrpc=false}` → 15th-of-following-month solicitation.
- Acceptance, contractual payment (12-month rule), escrow analysis, SMDU events as in 12.6.

#### Data model
`payment_deferrals` (12.6) with `kind='disaster'`, `disaster_event_id`, `disaster_basis`, `delinquency_months_at_disaster`, `fnma_prior_approval_id?` (2+ months at disaster), `same_event_prior_deferral_check bool`, `months_deferred` (1–12). Cumulative-cap accounting stores disaster months separately (`cumulative_disaster_months`), never added to `cumulative_months_after` for standard deferrals.

#### State machine
Identical to 12.6 with an added `fnma_prior_approval_pending` state (borrower 2+ months delinquent at the disaster date) and the D1-3-01 next-step routing on ineligibility (`flex_mod_disaster_criteria`).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_D23205_DDEFERRAL_ELIGIBILITY_GATES` | not_before_gate | offer/solicit | — | disaster basis; current/<2 months at disaster (or approval); 1–12 `months` delinquent at eval; no same-event prior; maturity >36 `months`; no conflicting arrangements | — | refused with reason codes |
| `FNMA_D23205_POSTFORB_SOLICIT_15` | deadline | `workout_plan.expired{disaster forbearance, qrpc=false}` | `term_end` | 15 `calendar_days` | `notice.sent{NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB}` | sev-2 |
| `FNMA_D23205_POSTREPAY_SOLICIT_15TH` | deadline | `workout_plan.failed{repayment, disaster, qrpc=false}` | failure month | 15th of following month | `notice.sent{NTC_FNMA_D23205_SOLICIT_POST_REPAY}` | sev-2 |
| `FNMA_D23205_12M_CONTRACTUAL_PAYMENT_GATE` | not_before_gate | 12 months delinquent at eval | — | full contractual payment in solicitation/processing month | `payment.received{full}` | completion blocked |
| `FNMA_D23205_DDEFERRAL_SMDU_ENTRY_EOM` | deadline | acceptance | evaluation/processing month | last day of month | `smdu.case.completed` | `officer` sev-1 |
| `FNMA_D23205_AGREEMENT_SEND_5`, `FNMA_D23205_CUSTODIAN_25`, `FNMA_D23205_RECORDED_ORIGINAL_5BD`, `FNMA_B101_ESCROW_ANALYSIS_BEFORE_OFFER`, `FNMA_F122_DEFERRAL_LAR_BEFORE_EOM_1BD`, `TX_50A6_DEFERRAL_NOTICE_7BD`, `FNMA_F202_DEFERRAL_INCENTIVE_CLAIM` | as in 12.6 | | | | | |
| `FNMA_LL202601_DISASTER_FC_PRIOR_APPROVAL_5` | deadline | `foreclosure.prereferral_review.completed{disaster=true}` (13.4) | review completion | 5 `calendar_days` to submit to hazard_loss@fanniemae.com | `fnma.approval.received` | referral blocked (13.3 gate `LM_DISASTER_FNMA_APPROVAL`) |
| `FNMA_D1301_DISASTER_FLEX_ROUTE` | deadline (policy) | `payment_deferral.screened_ineligible{disaster}` | screen | 5 `business_days_servicer` to evaluate/solicit Flex Mod (reduced criteria) | 12.8 evaluation started | sev-3 |

#### Business rules and calculations
1. **Basis determination:** property county ∈ FEMA IA declaration with incident period covering the hardship start; or an insured-loss claim on file (9.x loss draft); or employer address in an IA county (QRPC-captured, documented by borrower statement — Form 710 hardship section suffices; no BRP).
2. **Delinquency at disaster** = `fnma_delinquency_status` as of the FEMA incident start date (or the insured-loss date): must be <2 months; else route to Fannie Mae prior approval (F-1-24-style package via SMDU/`fnma_portal_operator`).
3. **Months deferred** = all unpaid installments (1–12) → the loan becomes current; NIB = Σ P&I + eligible advances (same arithmetic as 12.6). Example: 9 unpaid installments of $1,580.17 = $14,221.53 + escrow advances $2,300.00 = **$16,521.53 NIB**; late charges waived; escrow shortage $2,400 → $40.00/month over 60 months.
4. **Cumulative caps:** disaster months tracked separately; a later standard deferral tests only `cumulative_months_after` (standard) and the 12-month prior-deferral exclusion ignores disaster deferrals.
5. **Next steps on ineligibility/decline:** D1-3-01 routing to Flex Mod with disaster criteria (≥3 months delinquent at evaluation; prior modifications not disqualifying; ≥30 days delinquent before the trial starts — LL-2026-01) → 12.8.
6. Everything else (processing month, effective date, ledger, agreement, custodian, recording, Reg X basis) as in 12.6.

#### Integrations
As 12.6 (SMDU `DISASTER_PAYMENT_DEFERRAL` case with campaign ID; investor reporting; escrow; e-sign; e-recording; custodian; credit bureaus) plus the FEMA declaration feed (9.x) and the hazard_loss@fanniemae.com submission (13.4; prepared by the agent, sent by `officer`/`fnma_portal_operator` per partner policy).

#### Outputs and artifacts
`NTC_FNMA_D23205_DISASTER_DEFERRAL_OFFER`, `NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB`, `NTC_FNMA_D23205_SOLICIT_POST_REPAY`, `DOC_FNMA_PAYMENT_DEFERRAL_AGREEMENT{disaster}`, completion confirmation; records as 12.6 with `kind='disaster'`; investor events; incentive claim.

#### AI agent design (AI-first)
Same agent/tools as 12.6 plus `disaster.registry.lookup` and `insurance.claim.get`; decision record adds `disaster_basis`, `delinquency_at_disaster`, `prior_approval`. Guardrails: cannot assert a FEMA basis without a registry match; ineligibility → `lossmit_reviewer` before notice; the disaster foreclosure-approval package is prepared but sent only by the human role. AI-off path identical to 12.6.

#### Edge cases and failure modes
- **Multiple disasters:** each event permits one disaster deferral; the same-event check keys on `disaster_event_id`.
- **Insured loss with pending claim funds:** loss-draft funds are not applied to arrears; the deferral proceeds (9.x coordinates).
- **Borrower relocated (employment basis):** documentation by statement; fraud checks via `qc-audit` sampling.
- **Disaster forbearance still running when QRPC is achieved:** evaluate immediately; forbearance terminates on approval (D2-3.2-01 "approved for another workout").
- **Loan >12 months delinquent:** ineligible → Flex Mod (disaster criteria) or liquidation.
- **Foreclosure already referred when disaster impact is identified:** LL-2026-01 continuation approval within 5 days of determining impact (13.4).
- Transfer/bankruptcy/SCRA/Texas as in 12.6.

#### Test cases and acceptance criteria
- **12.7-T1:** Given a FEMA IA county, incident 2026-05-10, loan current at incident, disaster forbearance 2026-06-01..2026-11-30 without QRPC, when the plan expires, then the solicitation is sent by 2026-12-15 and, on acceptance 2026-12-20, the case is entered by 2026-12-31 (or processing month January under policy).
- **12.7-T2 (delinquency at disaster):** 2 months delinquent at incident → prior-approval package; no offer until approval id recorded.
- **12.7-T3 (12-month rule):** 12 months delinquent at evaluation → contractual payment required before completion.
- **12.7-T4 (caps):** standard cumulative months unchanged after a 9-month disaster deferral; a standard deferral 8 months later is not blocked by the 12-month prior-deferral rule.
- **12.7-T5 (same event):** second disaster deferral request for the same `disaster_event_id` → refused; a new event → allowed.
- **12.7-T6 (routing):** ineligible (13 months delinquent) → Flex Mod disaster-criteria evaluation started within 5 BD.
- **12.7-T7 (foreclosure gate):** pre-referral review completed 2026-12-01 on a disaster loan → referral refused until Fannie Mae approval; submission by 2026-12-06.
- **12.7-T8 (ledger):** NIB $16,521.53 posted; IB UPB per schedule; late charges waived.

#### Audit and evidence
As 12.6 plus the disaster-basis evidence (FEMA declaration id/county/incident period, claim id or employment statement), prior-approval evidence, and the LL-2026-01 submission/approval trail.

### Open questions / decisions
1. **Employment-basis documentation.** Default: borrower statement in QRPC/Form 710 hardship section; no employer verification unless fraud indicators.
2. **Who sends hazard_loss@fanniemae.com submissions.** Default: `officer` (partner) signs; Supermortgage prepares — confirm the partner prefers `fnma_portal_operator`.
3. **FEMA registry source.** Default: OpenFEMA declarations API, daily; manual override by `compliance-sentinel`.

### Sources
- Fannie Mae D2-3.2-05: https://servicing-guide.fanniemae.com/svc/d2-3.2-05/disaster-payment-deferral (08/13/2025; verified 2026-09-09)
- Fannie Mae D1-3-01: https://servicing-guide.fanniemae.com/svc/d1-3-01/evaluating-impact-disaster-event-and-assisting-borrower (04/08/2026; verified 2026-09-09)
- LL-2026-01 (Feb. 11, 2026; effective May 1, 2026): https://singlefamily.fanniemae.com/media/document/pdf/lender-letter-ll-2026-01-updates-retention-workout-options-and-disaster-related-foreclosure (verified 2026-09-09)
- Fannie Mae D2-3.2-01, D2-3.2-04, F-1-22, F-2-02, F-2-06, B-1-01 (verified 2026-09-09; see 12.4/12.6)
