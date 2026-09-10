# 9.5 — Force-placed cancellation/refund

| Attribute | Value |
|---|---|
| Section | 9 — Insurance & Property Protection |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On proof of coverage |
| Governing source | Reg X 1024.37(g) |
| Key deadlines | Cancel & refund overlapping premium within 15 days |
| Timers | `FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30`, `INS_FPI_CARRIER_REFUND_RECON_45`, `INS_FPI_EVIDENCE_EVAL_2BD`, `REGX_1024_37G_FPI_CANCEL_REFUND_15` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Insurance |
| Trigger & frequency | On proof of coverage |
| Governing source (blueprint) | Reg X 1024.37(g) |
| Key deadlines (blueprint) | Cancel & refund overlapping premium within 15 days |
| Data/artifacts | Cancellation |
| Systems | LPI carrier |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Sub cancels/refunds; partner liable; Fannie Mae reimbursement claims netted (15.2) |
| Nuances (blueprint) | [cropped in source] — reconstructed: "period of overlapping coverage" definition; refund what the borrower *paid* and remove what was *assessed*; related fees; carrier refund ≠ borrower refund; escrowed vs non-escrowed posting; flood track uses 30 days (9.6) |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.37(g)**: "Within 15 days of receiving, by a servicer, evidence demonstrating that the borrower has had in place hazard insurance coverage that complies with the loan contract's requirements, the servicer must: (1) cancel the force-placed insurance the servicer purchased … ; and (2) refund to such borrower all force-placed insurance premium charges and related fees paid by such borrower for any period of overlapping insurance coverage and remove from the borrower's account all force-placed insurance charges and related fees that the servicer assessed to the borrower for such overlapping period." **Comment 37(g)(2)-1**: a period of overlapping coverage is "the period of time during which the force-placed insurance purchased by a servicer and the hazard insurance purchased by a borrower were in effect at the same time"; the servicer must refund all charges/fees for that period and remove them from the account. **Comment 37(c)(1)(iii)-2 / 37(e)(1)-1** evidence standards (declarations page, certificate, policy, similar written confirmation; rejection only if unconfirmed by carrier/agent or non-compliant). **RESPA §6(l)(3)**: within 15 days of receipt of confirmation, terminate and refund premiums "paid during any period during which the borrower's insurance coverage and the force-placed insurance coverage were each in effect, and any related fees." **§6(l)(2)**: a servicer "shall accept any reasonable form of written confirmation … which shall include the existing insurance policy number along with the identity of, and contact information for, the insurance company or agent." **(h)** charges must be bona fide and reasonable (relevant to "related fees" — none are charged under this design). **Fannie Mae B-6-01**: terminate LPI and refund "all premiums and fees incurred during any period when insurance coverage overlapped," in accordance with applicable law; F-1-05: unearned-premium refunds received must be deducted from reimbursement requests (and, if received after reimbursement, remitted to Fannie Mae — Section 15.2 handles the 30-day remit rule stated for MI and applies the same control). Sources as in 9.2 (verified 2026-09-09). **Flood** LPI termination follows 42 U.S.C. 4012a(e)(3) — **30 days** (9.6), not 15.

**Discrepancies vs blueprint**: none on the 15-day rule; the blueprint's automation class "a" is right — this is fully deterministic; the row does not distinguish refund-of-paid vs removal-of-assessed, which drives the ledger design.

### Operational prerequisites
- LPI program cancellation terms: flat pro-rata cancellation to the borrower-policy effective date, refund advice within N days; no short-rate penalties passed to the borrower — Partner/Supermortgage.
- Refund payment rails: escrow credit (3.x), ACH credit to the borrower, or check via `print-mail`/custodial bank; state unclaimed-property handling for uncashed refunds (Section 16/19).
- Everything in 9.2.

### Build spec
#### Inputs and triggers
- `insurance.evidence.confirmed` for a loan with an open `fpi_case` in `lpi_bound`/`charged`/`renewed` state → `fpi.cancel_refund.started` (t_e = receipt date of the evidence, not the confirmation date — the 15-day clock runs from **receiving** evidence; confirmation must fit inside it).
- `loan.paid_in_full` with LPI in force → cancel LPI; refund unearned premium the borrower paid (policy; Fannie Mae/RESPA silent) — same calculator with overlap = post-payoff period.
- Carrier `refund_advice` (informational; does not gate the borrower refund).

#### Data model
- `fpi_refunds` (new): `id`, `fpi_case_id`, `placement_id`, `evidence_id`, `evidence_received_at date`, `borrower_coverage_start date`, `borrower_coverage_end date?`, `overlap_start date`, `overlap_end date` (exclusive), `overlap_days int`, `daily_rate_cents numeric(20,6)`, `overlap_premium_cents bigint`, `related_fees_cents bigint` (always 0 by design), `assessed_removed_cents`, `paid_refund_cents`, `refund_method` ∈ {escrow_credit, ach, check, account_credit}, `refund_sent_at`, `cancellation_effective date`, `carrier_refund_cents?`, `carrier_refund_received_at?`, `fnma_claim_adjustment_id?`, `status` ∈ {computed, cancel_requested, cancelled, refunded, closed}.
- Ledger: reversal entries linked to the original `lpi_charges` (never edits).

#### State machine
`open` → `evidence_received` (t_e) → `evaluated` (sufficient? if insufficient → back to 9.2/9.3 handling with reason) → `cancel_requested` (carrier) → `refund_computed` → `refund_posted` (ledger) → `refund_paid` (money out / escrow credit) → `closed` ; both cancellation and refund must complete by t_e + 15. Carrier ack lag does not extend the deadline (the servicer cancels on its books and refunds; the carrier reconciles).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_37G_FPI_CANCEL_REFUND_15` | deadline | `insurance.evidence.received` (later confirmed sufficient) | receipt date | 15 calendar_days | `fpi.lpi.cancelled` AND `fpi.refund.paid` (or credited) | sev-1; auto-escalate `officer`; NoE-equivalent case opened |
| `INS_FPI_EVIDENCE_EVAL_2BD` | deadline (policy) | `insurance.evidence.received` | receipt | 2 business_days_servicer | `insurance.evidence.confirmed/rejected` | sev-2 (protects the 15-day window) |
| `FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30` | deadline (flood track, 9.6) | evidence received | receipt | 30 calendar_days | cancellation + refund | sev-1 |
| `INS_FPI_CARRIER_REFUND_RECON_45` | deadline (internal) | `fpi.lpi.cancel_requested` | request | 45 calendar_days | `refund_advice` reconciled | sev-3; vendor follow-up |

#### Business rules and calculations
1. **Overlap** = [max(borrower_coverage_start, lpi_effective), min(borrower_coverage_end ?? ∞, lpi_expiration)) — half-open date interval, days counted as end − start.
2. **Daily rate** = `premium_cents ÷ term_days` (decimal.js, 6 dp), term_days = lpi_expiration − lpi_effective (365 or 366). `overlap_premium_cents = round_half_up(daily_rate × overlap_days)`. Multi-term overlaps are computed per placement term and summed.
3. **Two-sided correction**: (a) *remove* from the account every LPI charge/fee assessed for the overlap (reverse the receivable/escrow disbursement to the extent of `overlap_premium_cents`); (b) *refund* to the borrower whatever the borrower actually **paid** toward those charges (for non-escrowed: payments applied to `corporate_advances` for this charge, FIFO; for escrowed: the overlap amount is credited back to the escrow account, and any escrow shortage/payment increase caused by the LPI premium is re-analyzed — 3.2/3.6 — with a refund of any surplus ≥ $50 under 1024.17(f)(2)(ii) rules in 3.5). Related fees: none exist; the field is kept for audit.
4. **Carrier refund independence**: the borrower gets the full overlap refund by day 15 even if the carrier's refund is short-rated, delayed or netted on a later statement; the difference is a servicer cost (never Fannie Mae's, never the borrower's).
5. **Fannie Mae reimbursement hook**: if the LPI premium was claimed (or will be) under F-1-05, the unearned-premium refund reduces the claim; if already paid by Fannie Mae, remit within 30 days (15.2).
6. **Worked example** (continuing 9.2): LPI term 2026-10-01 → 2027-10-01 (365 days), premium $2,190.00 → daily 600.000000 cents. Evidence received **2027-01-12** (Tue): borrower's new policy effective **2026-12-15**. Overlap = [2026-12-15, 2027-10-01) = 17 + 273 = **290 days**. `overlap_premium` = 290 × 600 = 174,000 cents = **$1,740.00**. Charge retained for the uncovered gap [2026-10-01, 2026-12-15) = 75 days × 600 = **$450.00** (450.00 + 1,740.00 = 2,190.00 ✓). Cancellation effective 2026-12-15; deadline for cancel + refund = 2027-01-27 (Wed). Non-escrowed borrower had paid $600.00 toward the LPI charge by 2027-01-12 → remove $1,740.00 from the account (receivable reversal), refund the portion *paid* that exceeds the retained charge: paid 600 − retained 450 = **$150.00** refunded by ACH; the remaining $300.00 of the retained gap charge stays due on the statement (7.1). Ledger: Dr `corporate_advances` reversal −174,000 (Cr) … i.e., Cr `corporate_advances` 174,000 / Dr `lpi_refund_expense`(corporate) 174,000 pending carrier reimbursement; carrier later refunds $1,700.00 (short-rate) → Dr cash 170,000 / Cr `lpi_refund_expense` 170,000; net servicer cost $40.00. Escrowed variant: Dr loan `escrow` 174,000 / Cr `escrow_advances` or `custodial_ti_cash` per 3.7 reversal mechanics, then an interim analysis.
7. **Leap-year term**: a term 2027-05-01 → 2028-05-01 has 366 days; daily = 219,000 ÷ 366 = 598.360656 cents; a 100-day overlap → 59,836.0656 → **$598.36**.
8. **Payoff**: LPI in force at payoff → cancel effective payoff date; refund unearned premium the borrower paid (policy) within 15 days; unpaid unearned premium simply drops from the payoff figure (16.x).

#### Integrations
- `insurance-tracking/lpi`: `lpi_cancel_request` {placement, effective date, reason=borrower_coverage/payoff/error}, `lpi_cancel_ack`, `refund_advice`; idempotent per placement; ack timeout 2 business days → sev-2 but no effect on the borrower deadline.
- Refund rails: `nacha` (WEB/PPD credit with existing authorization or check), `custodial-bank` (escrow credit is a ledger move within T&I), `print-mail` (checks).
- Sections 3.2/3.5/3.6 (escrow re-analysis and surplus refund), 7.1 (statement), 15.2 (claim adjustment).

#### Outputs and artifacts
- Notice `INS_FPI_CANCEL_REFUND_CONFIRM` (policy; plain-language: LPI cancelled effective date, overlap period, amount removed, amount refunded and how, remaining balance if any, contact) — e-delivery permitted with consent, else mail.
- Records `fpi_refunds`; ledger reversals; events `fpi.evidence.received/evaluated`, `fpi.lpi.cancel_requested/cancelled`, `fpi.refund.computed/posted/paid`, `fpi.case.closed`; investor events: escrow deposit event for escrowed credits (3.7).

#### AI agent design (AI-first)
- `insurance-property` tools: `evaluateEvidence`, `computeOverlapRefund` (pure function, unit-tested), `requestLpiCancel`, `postRefund`, `payRefund`, `notifyBorrower`. The agent's only judgment call is evidence sufficiency; the calculator is deterministic. Guardrails: cannot reduce a refund below the calculator's figure; cannot wait for the carrier; cannot charge a cancellation fee. Escalations: `officer` at day 12 if unpaid (breach-risk report), `human_agent` on request. AI-off: the refund job runs on `insurance.evidence.confirmed`; staff evaluate evidence.

#### Edge cases and failure modes
- Evidence with a policy effective *before* the LPI effective date (borrower never lapsed): overlap = full term; remove all charges; refund all paid; record `servicer_error` if the lapse detection was wrong (NoE-style root cause).
- Evidence rejected then later confirmed (carrier confirmation arrives on day 10): clock still runs from original receipt — the 2-business-day evaluation SLA protects this.
- Borrower policy with a gap in the middle of the LPI term (two policies): two overlap intervals; retained charge for the gap.
- Escrowed borrower with the LPI premium capitalized into a modification (12.x): refund credits the escrow/deferred balance per the modification terms — coordinate with 12.x; never a cash refund of capitalized amounts without re-amortization review.
- Transfer-out between evidence and refund: transferee assumes the deadline; transferor documents evidence date in the transfer file (17.x).
- Bankruptcy: refunds to the borrower vs. trustee per counsel (Section 14) — the *account removal* happens regardless.
- Carrier insolvency: borrower still refunded; servicer pursues guaranty fund.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 9.5-T1 | Given LPI 2026-10-01→2027-10-01 at $2,190.00 and evidence received 2027-01-12 of coverage from 2026-12-15 Then overlap 290 days, $1,740.00 removed, retained $450.00, deadline 2027-01-27. |
| 9.5-T2 | Given the borrower paid $600.00 toward the charge Then $150.00 refunded and $300.00 remains due. |
| 9.5-T3 | Given carrier ack arrives on day 20 Then borrower refund still paid by day 15; sev-3 vendor follow-up only. |
| 9.5-T4 | Given a 366-day term and 100-day overlap Then $598.36. |
| 9.5-T5 | Given evidence received Friday 2027-01-15 Then deadline 2027-01-30 (Saturday) — refund must post by then; the sweep treats it as a calendar deadline. |
| 9.5-T6 | Given a Fannie Mae claim already paid for the LPI premium Then a 15.2 remittance task within 30 days of the carrier refund. |
| 9.5-T7 | Given evidence effective before the LPI effective date Then full removal, full refund, `servicer_error` root-cause record. |

#### Audit and evidence
Evidence receipt timestamp and channel, sufficiency decision, calculator inputs/outputs (stored JSON), ledger reversal ids, refund payment proof (ACH trace/check number/escrow credit event), carrier cancel/refund messages, notice proof; retained `life_of_loan_plus_4y`; the calculator is versioned and its unit tests are exam evidence.

### Open questions / decisions
1. Refund vehicle for non-escrowed borrowers — **default: ACH credit where an authorization exists, else check**; account credit only when a retained balance exceeds the refund (with borrower consent/notice).
2. Payoff unearned-premium refund policy — **default: refund what the borrower paid pro-rata from the payoff date**.

### Sources
- 12 CFR 1024.37(g), (h); comments 37(g)(2)-1, 37(c)(1)(iii)-2 — URLs in 9.2 — verified 2026-09-09
- 12 U.S.C. 2605(l)(2)–(3) — verified 2026-09-09
- Servicing Guide B-6-01, F-1-05 — URLs in 9.1/9.2 — verified 2026-09-09
- 42 U.S.C. 4012a(e)(3) (flood 30-day termination): https://www.law.cornell.edu/uscode/text/42/4012a — verified 2026-09-09
