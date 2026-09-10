# 2.4 — Additional principal / unscheduled payments

| Attribute | Value |
|---|---|
| Section | 2 — Payment Processing & Cashiering |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On receipt |
| Governing source | FNMA C-1.2-01 |
| Key deadlines | Same cycle |
| Timers | `FNMA_C1201_CURTAILMENT_APPLY_IMMEDIATE_0BD`, `FNMA_C1201_DELINQUENT_CURE_FIRST_GATE`, `FNMA_C1201_NIB_ORDER_GATE`, `FNMA_C1201_REAPPLY_ELIGIBILITY_GATE`, `FNMA_IRM_LAR83_5BD_2000`, `FNMA_LL202605_EVENT_NEXTBD_0300`, `SM_CURTAILMENT_PAYOFF_ROUTE_GATE`, `SM_REAMORT_FORM181_DELIVERY_10BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Cashiering |
| Trigger & frequency | On receipt |
| Governing source (blueprint) | FNMA C-1.2-01 |
| Key deadlines (blueprint) | Same cycle |
| Data/artifacts | Ledger |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | Sub |
| Nuances (blueprint) | (blank in source) |

### Verified requirement (as of 2026-09-09)

**Fannie Mae C-1.2-01, Processing Additional Principal Payments (11/13/2024; Guide edition Aug. 12, 2026).** "The servicer must immediately accept and apply an additional principal payment (referred to as a principal curtailment) identified by the borrower as such for a current mortgage loan." For a current loan subject to a payment deferral or modification with a non-interest-bearing balance: a curtailment less than the interest-bearing UPB is applied "to the interest-bearing UPB"; a curtailment "greater than or equal to" the interest-bearing UPB is applied "1. to the non-interest bearing balance, if any; and 2. to the interest-bearing UPB." Delinquent loan: "any additional principal payments identified as such must first be applied toward curing the delinquency," with any remainder applied as for a current loan. Reapplication of prior principal prepayments to cure a delinquency is permitted only if the loan is a portfolio or non-MBS participation loan, "the reapplication … does not result in the mortgage loan balance being higher than it would have been had the original amortization schedule … been followed," the borrower has not received mortgage-assistance-fund program money, and the borrower agrees to supplement so the whole delinquency is cured (else combine with a workout per D2-3). On Fannie Mae's request (partial release, condemnation award, insurance proceeds) "the servicer must process the funds as an additional principal payment." Re-amortization after a substantial curtailment: complete Form 181 (Agreement for Modification, Re-Amortization, or Extension of a Mortgage), revise only as its instructions authorize, deliver to the borrower and the document custodian, determine whether borrower execution is required to keep first-lien priority and enforceability, send a copy to Fannie Mae's eVault via MERS eDelivery for eMortgages, "report the payment change as described in Reporting a Transaction Type 83," and "not consider a mortgage loan re-amortization to be a mortgage loan modification for the purpose of determining eligibility for a subsequent mortgage loan modification." Related: SVC-2024-06, SVC-2023-05, SVC-2021-04, SVC-2020-04; Selling Guide B2-1.5-05 (contractual terms). URL: https://servicing-guide.fanniemae.com/svc/c-1.2-01/processing-additional-principal-payments (verified 2026-09-09).

**F-1-09 (10/19/2016)**, "Processing a Principal Curtailment": submitted with a scheduled payment — "apply the scheduled monthly payment first, then apply the principal curtailment"; submitted separately — "apply the principal curtailment first, then apply the next scheduled monthly payment"; after a curtailment the servicer "may agree to reduce the P&I payment only based on re-amortization of current UPB using current interest rate" (Form 181 path). F-1-09 is silent on due-date effects, on interest for the month of the curtailment and on ARMs; the note governs those.

**Form 3200 (07/2021), Section 4:** "I have the right to make payments of principal at any time before they are due." "The Note Holder will use my Prepayments to reduce the amount of Principal that I owe." "The Note Holder may apply my Prepayment to the accrued and unpaid interest on the Prepayment amount, before applying my Prepayment to reduce the Principal amount." "If I make a partial Prepayment, there will be no changes in the due date or in the amount of my Monthly Payment unless the Note Holder agrees in writing to those changes." (Verified 2026-09-09; URL in 2.1 Sources.) ARM notes recompute the payment at each Change Date on the then-unpaid principal, so a curtailment on an ARM is reflected at the next scheduled payment change (7.2 owns that calculation) — **[PARTIALLY VERIFIED — ARM note (Form 3500-series) text not fetched; standard uniform ARM language]**.

**Investor reporting hooks (Section 5.1/5.2, verified there):** a curtailment is a separate LL-2026-05 "Loan Curtailment" event (same-day processing, 3:00 a.m. ET next-BD deadline), reported on the legacy LAR 96 as principal in the period; IRM Ch. 4 rules: curtailments on deferral/mod loans apply to interest-bearing UPB first unless ≥ interest-bearing UPB (matches C-1.2-01); same-month MBS curtailments reduce the balance and report as principal; S/S loans pass curtailments through at the next remittance and MBS Express drafts unscheduled principal on BD4 after the month collected; a curtailment can never be reported as a negative in a later period — corrections are reversals plus re-reporting.

**Reg Z/Reg X:** no curtailment-specific rule; crediting as of receipt (1026.36(c)(1)(i)) applies because the funds are a payment; a curtailment mis-posted as a periodic payment (or vice versa) is a 1024.35(b)(2) error. Prepayment penalties: Fannie Mae conventional loans in scope do not carry prepayment premiums absent a negotiated contract (F-1-09); Texas 50(a)(6) loans cannot (F-1-09) — the platform models `loan_terms.prepayment_premium` as null by default.

**Discrepancies with the blueprint row.** (a) "Same cycle" is weaker than the Guide's "immediately accept and apply" for a designated curtailment on a current loan; the platform applies same business day of receipt (or of identification). (b) The row omits the delinquency-first rule, the deferral/modification order, the Fannie Mae-requested reductions, and the Form 181/LAR 83 re-amortization path. (c) "Systems: Core" understates: investor events (Fannie Mae), the ARM engine (7.2), MERS eDelivery for eMortgage Form 181, and the document custodian are all touched.

### Operational prerequisites
- Boarding data (1.1): `deferred_principal`/`forborne_principal` balances, remittance type, MBS issue month (same-month rules), ARM parameters, `prepayment_premium` terms (expected null).
- Form 181 template (DOCX, https://singlefamily.fanniemae.com/media/document/docx/form-181) loaded as a versioned document template with its instructions; `signing_officer` designation for executed re-amortization agreements; custodian delivery channel (1.4); MERS eDelivery access for eMortgages (1.5).
- Portal/IVR/coupon designs that let a borrower designate "additional principal" unambiguously (the C-1.2-01 rule is triggered by borrower identification).
- Investor-reporting rails (5.1) live for `payment.curtailment` and `rate_payment.change` (LAR 83) events.

### Build spec
#### Inputs and triggers
- `payment.received{designation=curtailment}` or a remainder R after full-installment allocation with a borrower instruction to apply to principal (2.1 rule 5); Fannie Mae-directed reductions: `fnma.principal_reduction.requested` (partial release 16.x/insurance proceeds 9.7/condemnation) — processed as curtailments.
- `borrower.reamortization.requested` (portal/agent) after a substantial curtailment; `lossmit.deferral.completed` / `lossmit.modification.effective` (changes the interest-bearing/NIB split — fires when the modified terms begin to govern; 12.8 owns the canonical pair `lossmit.modification.effective` / `lossmit.modification.completed`, the latter meaning the executed agreement is returned, recorded where required and booked. **`loan.modification.completed` is a retired alias of `…effective`** — do not emit).
- Schedules: none beyond the same-day posting sweep; ARM change dates (7.2) read the post-curtailment UPB.

#### Data model
- `payments.designation = curtailment`, `payment_allocations.bucket ∈ {curtailment (interest-bearing), deferred_principal, forborne_principal}`; `loan_events`: `payment.curtailment.applied` {amount_cents, ib_applied_cents, nib_applied_cents, new_upb_cents, new_nib_cents, with_scheduled_payment bool, applied_on, credited_as_of}.
- `curtailment_reapplications` (new; C-1.2-01 reapplication to cure delinquency): `loan_id`, `original_curtailment_event_ids[]`, `amount_reapplied_cents`, `eligibility{portfolio_or_nonmbs_participation, balance_not_higher_than_schedule, no_maf_funds, borrower_supplement_agreed}`, `decision_id`, `investor_event_ids[]`.
- `reamortizations` (new): `loan_id`, `requested_on`, `basis_upb_cents`, `rate`, `remaining_term_months`, `new_pi_cents`, `effective_due_date`, `form_181_document_id`, `borrower_execution_required bool` (state-law determination), `executed_at`, `custodian_delivered_at`, `evault_delivered_at` (eMortgage), `lar83_event_id`, `status` ∈ {requested, computed, offered, executed, effective, declined}.
- `loan_terms` versions for re-amortized P&I (effective-dated); `fnma_principal_reduction_requests` for Fannie Mae-directed reductions (source document id, amount, applied event).
Retention `life_of_loan_plus_4y`; Form 181 executed copies are `documents` with hashes.

#### State machine
Curtailment (payment-level): `received` → `applied` (same day) | `redirected_to_cure` (delinquent loan: funds applied to due installments first, remainder curtailed) | `held` (hold reason: bankruptcy plan, foreclosure post-referral, payoff pending — the case owner releases) | `reversed`. Re-amortization: `requested` → `computed` → `offered` (Form 181 generated) → `executed` (signed where required; `signing_officer` for the servicer signature) → `effective` (new `loan_terms` version active; LAR 83/`rate_payment.change` accepted) | `declined`. Actors: Allocation Engine (application), `cashiering` agent (redirect/hold decisions, re-amortization computation), `signing_officer` (execution), `investor-reporting` (events).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_C1201_CURTAILMENT_APPLY_IMMEDIATE_0BD` | deadline | `payment.received{designation=curtailment}` on a current loan | `received_on` | same `business_days_servicer` day (0) | `payment.curtailment.applied` | sev-2; late application corrected by re-dating (`credited_as_of` = receipt) |
| `FNMA_C1201_DELINQUENT_CURE_FIRST_GATE` | gate | curtailment on a loan with any unpaid installment | — | funds must satisfy due installments before any principal reduction | allocation validator | curtailment bucket refused until installments are satisfied |
| `FNMA_C1201_NIB_ORDER_GATE` | gate | curtailment on a loan with `deferred_principal`/`forborne_principal` > 0 | — | amount < IB UPB → IB only; amount ≥ IB UPB → NIB first then IB | allocation validator | — |
| `FNMA_C1201_REAPPLY_ELIGIBILITY_GATE` | gate | `curtailment.reapplication.requested` | — | all four C-1.2-01 conditions true | decision record | refused → workout path (12.x) |
| `FNMA_IRM_LAR83_5BD_2000` | (Section 5) | re-amortization effective (`loan_terms.activated`) | scheduled calculation date | 5 `business_days_fannie_et` 20:00 ET | `rate_payment.change` submitted | (5.1) |
| `FNMA_LL202605_EVENT_NEXTBD_0300` | (Section 5) | `payment.curtailment.applied` | processed_at | next `fannie_et` BD 03:00 ET | submitted | (5.1) |
| `SM_REAMORT_FORM181_DELIVERY_10BD` | deadline (internal) | `reamortizations.executed` | executed_at | 10 `business_days_servicer` | custodian (and eVault for eMortgages) delivery evidence | sev-3 |
| `SM_CURTAILMENT_PAYOFF_ROUTE_GATE` | gate | curtailment amount ≥ interest-bearing UPB + NIB | — | route to payoff (16.1/16.2) instead of curtailment | — | — |

Jurisdiction overrides: `jurisdiction_rules.reamortization_requires_borrower_signature` (state enforceability determination per C-1.2-01) **[UNVERIFIED per state]**.

#### Business rules and calculations
1. **Designation.** A curtailment exists only when the borrower identifies it (portal "additional principal" field, coupon box, IVR option, written instruction) or Fannie Mae directs it. Undesignated overages follow 2.2 rule 10 (held, applied on instruction) — the platform does not auto-curtail undesignated funds (borrower-intent rule, C-1.1-01).
2. **Ordering with a scheduled payment.** Funds received together: allocate the scheduled installment(s) first, then the curtailment (F-1-09); received separately on a current loan: apply the curtailment immediately; the next scheduled installment's interest is computed on the reduced UPB "as of the LPI date" (F-1-09 interest rule) — i.e., the borrower's next installment reflects the curtailment in full. Due date and P&I are unchanged (note §4) unless re-amortized (rule 6).
3. **Delinquent loans.** Curtailment funds first satisfy unpaid installments in due-date order (Allocation Engine), then late charges only if the borrower included them, then principal; the decision record explains the redirection and the borrower is told (`CURTAIL-REDIRECT-v1`).
4. **NIB order.** With `deferred_principal`/`forborne_principal` > 0: amount < IB UPB → all to IB UPB; amount ≥ IB UPB → NIB first, then IB (C-1.2-01/IRM); the investor event reports the net (interest-bearing) UPB and the NIB balance separately (5.1).
5. **Reapplication to cure delinquency** (rare; portfolio/non-MBS participation only): compute the balance that would exist "had the original amortization schedule been followed"; the reapplied amount = min(prior curtailments, that balance − current balance, delinquency amount); requires the borrower's agreement to supplement; every prior curtailment reapplied is reversed and re-reported (5.1 correction events); MBS loans are ineligible → 12.x workout.
6. **Re-amortization (Form 181).** New P&I = `round_half_up(UPB × r / (1 − (1 + r)^−n))` with r = note rate ÷ 12, n = remaining term in months to the original maturity, UPB = current interest-bearing UPB; escrow unchanged; effective with the first installment due ≥ 30 days after execution **[policy]**; new `loan_terms` version; LAR 83/`rate_payment.change` reported (5.1); not a modification for Flex Mod eligibility (12.8 reads `reamortizations`, not `modifications`); no fee to the borrower unless permitted by A2-3-05 and law **[policy: no fee]**.
7. **Postings.** Dr `suspense_unapplied`/`clearing_cash` X / Cr `principal` (IB) X₁, Cr `deferred_principal`/`forborne_principal` X₂; cash to `custodial_pi_cash` X; remittance to Fannie Mae per 5.2 (A/A: with the next remittance; S/S: pass-through at the next scheduled draft or MBS Express BD4). Reversal mirrors.
8. **Worked example F — curtailment with the September payment.** Fixture L-1: on 2026-09-03 the borrower pays 319,257¢ ($3,192.57) online, marking $1,000.00 as additional principal. Allocation: installment 2026-09-01 as in 2.1 example A (135,294 / 22,723 / 61,240) → UPB 24,954,677¢; then curtailment 100,000¢ → **UPB 24,854,677¢ ($248,546.77)**; LPI stays 2026-09-01; P&I stays 158,017¢. Next installment (2026-10-01): interest = 24,854,677 × 0.065 ÷ 12 = 134,629.5004 → **134,630¢** (round half-up at cents); principal = 158,017 − 134,630 = **23,387¢** (versus 22,846¢ without the curtailment — the borrower's principal share rises by 541¢). Investor events in order: seq n `payment.contractual` {LPI 2026-09-01, UPB 249,546.77}, seq n+1 `payment.curtailment` {UPB 248,546.77}; for an S/S loan Fannie Mae's October scheduled interest is computed on the reduced scheduled UPB (5.2).
9. **Worked example G — curtailment received separately on a delinquent loan.** Same loan, installments 2026-09-01 and 2026-10-01 unpaid; on 2026-10-20 a $3,000.00 check marked "principal only" arrives. A = 300,000¢; P = 219,257¢ → one installment (2026-09-01) is satisfied (135,294/22,723/61,240) with `credited_as_of` 2026-10-20; remainder 80,743¢ < P → held as `remainder_under_p`? No — the borrower designated principal, but the loan is still delinquent (2026-10-01 unpaid), so C-1.2-01 requires curing first: the 80,743¢ is held in suspense toward the 2026-10-01 installment (`partial_payment`, commitment path per 2.2) and the borrower is notified that principal reduction resumes once the loan is current. Late charge for 2026-09-01: assessed 2026-09-17 (unpaid at grace end); for 2026-10-01: assessed 2026-10-17 unless paid by then.
10. **Worked example H — re-amortization.** After a 5,000,000¢ ($50,000.00) curtailment leaves UPB 19,854,677¢ with 346 months remaining at 6.500%: r = 0.065 ÷ 12 = 0.005416667 (decimal.js precision 20); (1+r)^−346 = 0.154261039; new P&I = 19,854,677 × 0.005416667 ÷ (1 − 0.154261039) = 107,546.17 ÷ 0.845738961 = 127,162.4… → **127,162¢ ($1,271.62)** vs. 158,017¢ — offered on Form 181, effective with the installment due 2026-12-01, LAR 83/`rate_payment.change` reported within 5 BD of the calculation date. Rounding: the P&I is rounded half-up to cents once, at the end.

#### Integrations
- **Fannie Mae**: `payment.curtailment` / LAR 96 principal and `rate_payment.change` / LAR 83 via 5.1; Fannie Mae-directed reductions arrive as letters/emails (partial release approvals) → `documents` → `fnma_principal_reduction_requests` (no API); MBS Express BD4 unscheduled-principal draft (5.2).
- **Document custodian** (`custodian` adapter, 1.4): executed Form 181 transmittal; eMortgages: MERS eDelivery to Fannie Mae's eVault (`mers` adapter).
- **ARM engine (7.2)**: reads UPB at each Change Date; **statements (7.1)**: show the curtailment as transaction activity and the new principal balance.
- **Credit reporting (8.1)**: balance updates.
- **Borrower channels**: designation capture; `CURTAIL-CONFIRM-v1` confirmation.

#### Outputs and artifacts
- Notices: `CURTAIL-CONFIRM-v1` (amount applied, new principal balance, statement that the due date/payment do not change; electronic with consent, else on the next statement), `CURTAIL-REDIRECT-v1` (delinquent-loan redirection explanation; C-1.2-01), `REAMORT-OFFER-v1` with Form 181 (executed copies to borrower/custodian; `signing_officer`), `REAMORT-EFFECTIVE-v1` (new payment and date; doubles as the Reg E 10-day notice for autodraft borrowers when sent ≥10 days ahead).
- Events: `payment.curtailment.applied`, `curtailment.redirected`, `curtailment.reapplied`, `reamortization.*`; investor events `payment.curtailment`, `rate_payment.change`; ledger postings per rule 7; `loan_terms` versions.

#### AI agent design (AI-first)
`cashiering` agent handles designation interpretation, delinquent-loan redirection messaging, re-amortization eligibility/quotes and the Form 181 package; `investor-reporting` emits events; `signing_officer` signs Form 181 (legally required human touchpoint for an executed instrument); `licensed_specialist` is consulted only where `jurisdiction_rules` flag re-amortization negotiation as a licensed activity (none expected — re-amortization changes no rate/term). Tools: `payments.read`, `ledger.apply_via_cashiering`, `amortization.compute`, `documents.render(form_181)`, `custodian.send`, `mers.edelivery`, `notice.send`, `escalation.create`. Decision record: `{payment_id, designation_evidence, loan_status, ordering_rule_applied, ib_nib_split, redirect_reason?, reamort{inputs, new_pi}, rationale}`. Guardrails: never curtail undesignated funds; never bypass the cure-first gate; never re-amortize on MBS loans without checking the Selling Guide/pool rules (**open question 2.4-Q2**); never treat a re-amortization as a modification. Human path when AI off: Posting Queue + Re-amortization Queue with the same validators.

#### Edge cases and failure modes
- **Transfer-in**: curtailments in the transferor's final period must be reflected in the boarding UPB/LPI (1.6); if the transferor reported a curtailment Fannie Mae has not accepted, 5.1's position diff catches it.
- **Transfer-out**: curtailments received after cutover are forwarded (17.x); nothing is posted locally.
- **Bankruptcy**: post-petition "principal-only" payments from a debtor are applied per plan/case rule (14.x); trustee disbursements are contractual/arrears payments, not curtailments.
- **SCRA**: no special rule; interest cap unaffected.
- **Forbearance/trial**: designated curtailments during a trial are held with trial funds (2.6) unless the case owner directs; a curtailment does not count as a trial payment.
- **Deferral/modification with NIB**: rule 4; IRM requires never reporting interest on the NIB and never reporting the initial deferral as a curtailment (5.1).
- **Same-month MBS**: first-cycle rules (IRM 4-05) — 5.1 projection handles; the ledger posts normally.
- **Curtailment ≥ UPB**: routed to payoff (16.x) with a payoff statement (Reg Z 1026.36(c)(3) 7-BD clock) rather than silently paying the loan off.
- **Reversal of a curtailment** (returned check): mirror entries; the investor `payment.reversal` references the curtailment event; interest for any installment computed on the reduced balance in the meantime is recomputed and the difference billed/collected per the note (or waived by policy if our reporting delay caused it).
- **Fannie Mae-directed reduction without funds in hand** (e.g., insurance proceeds held in T&I loss-draft): the transfer from `custodial_ti_cash` to `custodial_pi_cash` is part of the posting.
- **ARM at Change Date**: 7.2 reads the reduced UPB; no re-amortization agreement needed.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 2.4-T1 | Given fixture L-1 current, when 319,257¢ arrives 2026-09-03 with $1,000 designated principal, then the September installment applies first, the curtailment second, UPB = 24,854,677¢, LPI unchanged, and two investor events are emitted in that order. |
| 2.4-T2 | Given 2.4-T1, when the October installment is computed, then interest = 134,630¢ and principal = 23,387¢. |
| 2.4-T3 | Given a loan with NIB 2,000,000¢ and IB UPB 1,500,000¢, when a 1,600,000¢ curtailment arrives (amount ≥ IB UPB), then the NIB is reduced first to 400,000¢ and the IB UPB is unchanged; the event payload shows NIB 4,000.00 and IB UPB 15,000.00. |
| 2.4-T4 | Given a loan with NIB 2,000,000¢ and IB UPB 1,500,000¢, when a 100,000¢ curtailment arrives, then IB UPB → 1,400,000¢ and NIB unchanged. |
| 2.4-T5 | Given two unpaid installments, when a "principal only" 300,000¢ check arrives, then one installment is satisfied, the remainder is held toward the next, no principal reduction occurs, and `CURTAIL-REDIRECT-v1` is sent. |
| 2.4-T6 | Given an MBS loan, when a reapplication of prepayments to cure delinquency is requested, then the gate refuses and a 12.x workout evaluation is suggested. |
| 2.4-T7 | Given a re-amortization executed 2026-10-20 effective 2026-12-01, then a new `loan_terms` version exists, Form 181 is delivered to the custodian within 10 BD, LAR 83/`rate_payment.change` is submitted within 5 BD of the calculation date, and 12.8's eligibility check does not count it as a modification. |
| 2.4-T8 | Given an autodraft borrower re-amortized effective 2026-12-01, when `REAMORT-EFFECTIVE-v1` is sent 2026-11-10, then the Reg E 10-day notice timer is satisfied and the December draft uses the new amount. |
| 2.4-T9 | Given a curtailment check returned NSF after posting, when reversed, then UPB/LPI restore, the investor reversal references the curtailment event, and the October interest is recomputed on the restored balance. |
| 2.4-T10 | Given a designated curtailment equal to the full payoff amount, when received, then it is routed to 16.x and no curtailment event is emitted. |

#### Audit and evidence
Designation evidence (image/portal field/transcript reference), allocation plan with the F-1-09 ordering rule reference, IB/NIB split, decision records for redirects and reapplications (with the four C-1.2-01 eligibility tests), Form 181 executed copies and custodian/eVault delivery evidence, `loan_terms` version history, investor event ids/acks, and timer history for the 0-BD application and LAR 83 clocks.

### Open questions / decisions
1. **Auto-curtailment of undesignated overages** — default: no (hold and ask); some servicers auto-curtail overages ≥ $X; revisit after borrower-experience data.
2. **Re-amortization on MBS pool loans** — default: offer only where Fannie Mae's Selling/Servicing Guide permits for the loan's pool type; escalate the first cases to the Investor Reporting Representative (**[UNVERIFIED — MBS re-amortization constraints not researched]**).
3. **Re-amortization fee** — default: none.
4. **Effective date convention for re-amortized P&I** — default: first due date ≥ 30 days after execution.

### Sources
- C-1.2-01 (11/13/2024): https://servicing-guide.fanniemae.com/svc/c-1.2-01/processing-additional-principal-payments (verified 2026-09-09)
- F-1-09 (10/19/2016): https://servicing-guide.fanniemae.com/svc/f-1-09/processing-mortgage-loan-payments-and-payoffs (verified 2026-09-09)
- Form 3200 (07/2021) §4: https://singlefamily.fanniemae.com/media/document/pdf/legal-documents/form-3200 ; Form 181: https://singlefamily.fanniemae.com/media/document/docx/form-181 (link verified 2026-09-09; content not parsed)
- Section 5.1/5.2 (IRM Ch. 4 rules, LAR 83, MBS Express BD4), Servicing Changes Reference Guide v1.0 (curtailment as a separate event)
