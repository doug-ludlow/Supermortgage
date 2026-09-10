# 10.5 — Unearned premium refund

| Attribute | Value |
|---|---|
| Section | 10 — PMI Administration |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On cancellation/termination |
| Governing source | HPA 12 USC 4902(f) |
| Key deadlines | Within 45 days |
| Timers | `HPA_4902F1_REFUND_45`, `HPA_4902F2_INSURER_REFUND_30`, `LL_2026_05_ESCROW_EVENT_3AM`, `REGX_1024_17F2_SURPLUS_REFUND_30`, `SM_MI_ESCROW_INTERIM_ANALYSIS_10BD`, `SM_MI_REFUND_ADVANCE_40`, `SM_MI_REFUND_VARIANCE_5BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | PMI |
| Trigger & frequency | On cancellation/termination |
| Governing source (blueprint) | HPA 12 USC 4902(f) |
| Key deadlines (blueprint) | Within 45 days |
| Artifacts | Refund |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | S[cropped in source] — reconstructed: "Sub computes, collects from the insurer and pays the borrower; partner is the insured on the master policy and the custodial account holder" |
| Nuances (blueprint) | [cropped in source] — reconstructed: "the insurer must transfer unearned premium to the servicer within 30 days of notification (4902(f)(2)); refund goes directly to the borrower, not into escrow (CFPB 2015-03); insurer proration methods differ (monthly by days/30, annual by days/365, single-premium schedules; non-refundable plans partially refundable under HPA schedules; MGIC will not refund for periods more than 45 days before it receives the cancellation notice); escrow accumulations for the MI line are handled by an interim escrow analysis; LPMI refunds belong to the servicer; financed single premiums refund to the borrower" |

### Verified requirement (as of 2026-09-09)

**12 U.S.C. 4902(f) (verified 2026-09-09).** (1) "Not later than 45 days after the termination or cancellation of a private mortgage insurance requirement under this section, all unearned premiums for private mortgage insurance shall be returned to the mortgagor by the servicer." (2) "Not later than 30 days after notification by the servicer of termination or cancellation of private mortgage insurance coverage under this section, a mortgage insurer that is in possession of any unearned premiums of that mortgagor shall transfer to the servicer of the subject mortgage an amount equal to the amount of the unearned premiums for repayment in accordance with paragraph (1)." 4902(h): cancellation or termination does not affect the right "to enforce any obligation of such mortgagor for premium payments accrued prior to the date on which such cancellation or termination occurred." 4902(e): no PMI payments after the 30-day marks (10.1/10.2). 4907(e): a servicer is not liable for a failure caused by "a mortgage insurer or a mortgagee to comply with the requirements of this chapter" — this is the servicer's defense if an insurer transfers late, provided the servicer notified promptly. CFPB Bulletin 2015-03: examiners found servicers "retaining returned premiums indefinitely in escrow"; premiums must be "returned directly to the borrower within 45 days."

**Fannie Mae B-8.1-04 (05/15/2019), "Finalizing and Reporting the Mortgage Insurance Termination."** The servicer must "refund unearned MIP" by forwarding it "to the borrower as received from the insurer, no later than 45 days after MI termination date," reduce the payment by the MIP "unless financed into principal," and, on escrow, either let "escrow deposits accumulated to pay off the next MIP… be considered in the borrower's next escrow account analysis" or perform a new analysis in which "the resulting change in the mortgage loan payment must not equal the amount previously escrowed for the MIP, should other escrow items need to be adjusted." B-8.1-02 (05/20/2015): LPMI renewal premiums are "the servicer's corporate responsibility and must be paid from the servicer's own funds" (so LPMI refunds are corporate receipts, not borrower refunds); borrower-purchased MI premiums are escrow items (B-1-01). Reg X §1024.17(f)(2)(i) (Section 3.5): an escrow surplus ≥ $50 found at an analysis is refunded within 30 days when the borrower is current.

**Insurer mechanics (MGIC Servicing Guide, Mar. 2026 — representative; Enact/Radian/Essent/Arch/NMI [UNVERIFIED specifics]).** Annual premiums: "Prorated refund — Calculated based on the number of days of coverage in force divided by 365 days"; monthly premiums: "…divided by 30 days"; single premiums: "See Single Premium Refund Schedule"; "Our Borrower-paid non-refundable premium plans may be partially refundable if mortgage insurance is terminated under the Homeowners Protection Act. These refunds are based on our HPA refund schedules"; "We will not provide a refund for any period more than 45 days prior to our receipt of the required mortgage insurance cancellation notice"; refund by "Direct deposit — … within as few as 2 business days of processing your refund request" or USPS check; cancellation notice must include "Payee's name and address if a refund is due." Premium billing: monthly plans billed "the first month after closing, payment due the following month"; annual renewals due on the certificate anniversary; 60-day grace before cancellation for non-payment; reinstatement retroactive on approval.

**Investor reporting.** No LAR is generated by the refund itself (LAR 89 is in the termination pipeline). From Dec. 1, 2026 the insurer's refund deposited to the T&I custodial account and the disbursement to the borrower are escrow events (deposit/disbursement, category Taxes & Insurance) reported by 3:00 a.m. ET next business day (Section 5; LL-2026-05).

**Discrepancies with the blueprint row:** (1) the statute has two clocks — insurer 30 days after notification, servicer 45 days after termination — and the blueprint carries only one; (2) "Systems: Core" understates the insurer integration (refund advices/ACH) and the custodial-account path; (3) the 45-day clock runs from the termination/cancellation *effective date*, not from the insurer's refund; (4) escrow accumulations are a separate Reg X/Fannie Mae path; (5) financed single-premium and non-refundable plans have insurer-specific schedules; (6) the row does not exclude LPMI.

### Operational prerequisites
- Insurer refund ACH designation to the **T&I custodial account** (partner's account titled for the benefit of Fannie Mae; Section 6.2) and the "payee" convention on cancellation notices (refund to servicer for pass-through, not directly to the borrower — so the servicer controls the 45-day evidence) — Owner: partner/Supermortgage with each insurer; artifact: insurer ACH enrollment.
- Refund rails to the borrower: ACH credit (Nacha PPD/CCD credit to the borrower's verified account on file; Section 2) and check via `print-mail`; refund letter template `NTC_MI_REFUND_ADVICE`.
- Corporate advance authority and limits for refunds paid before insurer funds arrive (policy: up to $5,000 per loan without `officer` approval).
- Insurer premium plan/refund schedules loaded in `mi_refund_schedules` (single-premium and HPA schedules by insurer/plan) **[UNVERIFIED — schedules are insurer documents obtained under the master policy]**.
- Escrow interim-analysis capability (Section 3.2) and surplus refund rails (Section 3.5).

### Build spec
#### Inputs and triggers
- `mi.terminated` / `mi.cancelled` (10.1–10.3) → open `mi_refunds` with an estimate; `mi.insurer.cancel_acked`; `mi.insurer.refund_received` (custodial bank feed match, Section 6.4; or insurer refund advice file/ACH addenda); `escrow.analysis.completed` (interim, MI line closed); `payoff.completed` (Section 16 — payoff-driven MI cancellation refunds follow the same calculator, but the HPA 45-day timer is instantiated as a policy timer); `mi.rescinded` / `mi.insurer_cancelled` (insurer-initiated: refund handling per edge cases); `payment.reversed` affecting the refund payee account.

#### Data model
`mi_refunds` (append-only rows per refund leg): `id`, `loan_id`, `mi_policy_id`, `termination_id`, `effective_date`, `leg` ∈ {insurer_unearned, escrow_mi_line, lpmi_corporate}, `estimate_cents`, `method` ∈ {days_365, days_30, single_schedule, hpa_schedule, insurer_stated}, `coverage_paid_through`, `days_in_force`, `insurer_notified_at`, `insurer_amount_cents`, `insurer_received_at`, `variance_cents`, `payee_party_id`, `pay_channel` ∈ {ach_credit, check, escrow_credit_disallowed}, `paid_at`, `advance_ledger_entry_id`, `recovered_at`, `status` ∈ {estimated, awaiting_insurer, received, paid, advanced_paid, disputed, closed}. `mi_refund_schedules` (reference): `insurer_code`, `plan`, `months_in_force`, `refund_pct_bps`. Ledger accounts used: per-loan `escrow` (MI line sub-ledger), `corporate_advances`, custodial `custodial_ti_cash`; new sub-account `mi_refund_receivable` (per loan, memo).

#### State machine
`estimated` → `awaiting_insurer` (cancel notice acked) → `received` (funds matched) → `paid` → `closed`; `awaiting_insurer` → `advanced_paid` (day-40 corporate advance) → `received` (recovery) → `closed`; any → `disputed` (variance > tolerance) → resolves to `received`/`paid`; `escrow_mi_line` leg: `estimated` → `analysis_pending` → `paid` (surplus refund) or `absorbed` (applied in the next analysis when < $50 and borrower elects — default: refund regardless of amount) → `closed`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `HPA_4902F1_REFUND_45` | deadline | `mi.terminated` / `mi.cancelled` | effective date | 45 `calendar_days` | `mi.refund.paid` (all legs with amount > 0) | `officer` sev-1; Sentinel; self-identified HPA exception |
| `HPA_4902F2_INSURER_REFUND_30` | deadline | `mi.insurer.cancel_notified` | notification date | 30 `calendar_days` | `mi.insurer.refund_received` | insurer dispute letter; `officer` sev-2; corporate advance path |
| `SM_MI_REFUND_ADVANCE_40` | deadline (policy) | `mi.terminated` with insurer funds not received | effective date | 40 `calendar_days` | `mi.refund.paid` | auto-advance from corporate funds and pay |
| `SM_MI_REFUND_VARIANCE_5BD` | deadline (policy) | `mi.insurer.refund_received` with variance > $1.00 | received_at | 5 `business_days_servicer` | variance resolved | `officer` sev-3 |
| `SM_MI_ESCROW_INTERIM_ANALYSIS_10BD` | deadline (policy) | `mi.terminated` (escrowed loan) | effective date | 10 `business_days_servicer` | `escrow.analysis.completed` (interim) | `escrow` agent sev-2 (must precede the 30-day premium stop) |
| `REGX_1024_17F2_SURPLUS_REFUND_30` (Section 3.5) | deadline | `escrow.analysis.approved` (interim) | analysis date | 30 `calendar_days` | surplus disbursement | as Section 3.5 |
| `LL_2026_05_ESCROW_EVENT_3AM` (Section 5) | deadline | refund deposit/disbursement posted | posting date | next `business_days_fannie_et` 03:00 ET | escrow event acked | as Section 5 |

#### Business rules and calculations
- **R1 — Legs.** (a) *Insurer unearned premium*: premium remitted to the insurer for coverage beyond the effective date E; (b) *Escrow MI line*: borrower deposits held for MI not yet remitted — released by the interim escrow analysis (Section 3.2/3.5) and refunded regardless of the $50 threshold (policy; HPA "all unearned premiums"); (c) *LPMI*: any insurer refund is corporate income (B-8.1-02), no borrower refund; (d) *financed single premium*: insurer schedule refund is paid to the borrower (the borrower financed the premium); no principal write-down (open question 10.5-Q2).
- **R2 — Estimate calculator (for reconciliation; the insurer's computation governs the amount received).** Monthly plan: `unearned = premium × max(0, 30 − days_in_force_in_coverage_month) / 30`, `days_in_force = E − coverage_period_start`; annual plan: `unearned = premium × (365 − days_in_force) / 365`, `days_in_force = E − anniversary_start`; single/non-refundable: `premium × refund_pct(months_in_force)` from `mi_refund_schedules`. Rounding: half-up to cents at the final step; tolerance vs insurer amount ±$1.00; larger variances → dispute but pay the insurer's amount to the borrower on time and pursue the difference (pay the higher of the two if the dispute is unresolved by day 40 — policy).
- **R3 — Payment to the borrower.** Payee = all borrowers of record (joint check/ACH to the account used for autodraft with `autodraft` consent; otherwise check to the mailing address); never credited to escrow, principal or fees without a signed borrower election received after E (4902(f)(1) "returned to the mortgagor"; 4902(h) allows collection of premiums *accrued before* E only through normal billing, not by offset). Refund letter accompanies the payment.
- **R4 — Timing.** Insurer notified within 2 BD of E (10.1/10.2 timers); if funds are not received by E + 40, advance from corporate funds (`Dr corporate_advances / Cr custodial_ti_cash` on the loan) and pay by E + 45; recover on receipt. Insurer's failure past 30 days is documented for the 4907(e) defense.
- **R5 — Premium stop and clawback.** No MI premium may be remitted to the insurer for coverage after E; a premium remitted for the coverage month containing E is recovered as unearned; premiums that accrued before E remain collectible (4902(h)).
- **R6 — Escrow interaction.** Interim analysis within 10 BD after E: closes the MI line as of E, projects the remaining lines, sets the new payment (decrease) effective with the next installment feasible and no later than the installment due ≥ 31 days after E, and refunds the MI-line balance as surplus.
- **Worked example (annual plan, automatic termination).** Annual BPMI premium $2,280.00 (0.60% × $380,000) paid from escrow on the 2031-03-15 anniversary, coverage 2031-03-15 through 2032-03-14; termination effective E = 2031-08-01 (illustrative date; the same arithmetic applies to the 10.1 worked loan's 2035-07-01 termination). `days_in_force = 2031-08-01 − 2031-03-15 = 139`; earned = 2,280.00 × 139/365 = $868.27 (868.2739… half-up); **unearned estimate $1,411.73**. Insurer notified 2031-08-04 → insurer transfer due by 2031-09-03; ACH received 2031-08-12 for $1,411.73 (variance $0.00) → deposited to `custodial_ti_cash` as an MI-line escrow credit; borrower ACH credit issued 2031-08-13 with `NTC_MI_REFUND_ADVICE`; `HPA_4902F1_REFUND_45` (due 2031-09-15) satisfied. Escrow: the borrower's monthly MI escrow deposit was $190.00; the MI line balance at E after the 2031-08-01 deposit is $950.00 (5 deposits since the 2031-03-15 disbursement) → interim analysis 2031-08-06 shows a surplus of $950.00 (plus/minus other lines) → refunded by 2031-09-05 and the payment drops from $2,891.86 to $2,701.86 effective 2031-09-01. Escrow events (from Dec. 2026) report the $1,411.73 deposit, the $1,411.73 disbursement and the $950.00 surplus disbursement by 03:00 ET the next business day.
- **Worked example (monthly plan, borrower cancellation).** Monthly premium $190.00; coverage month August 2031 remitted 2031-07-25; cancellation effective E = 2031-08-13 → `days_in_force = 12`; earned = 190.00 × 12/30 = $76.00; **unearned $114.00** (insurer method); refund due by 2031-09-27; insurer notified 2031-08-14; if no funds by 2031-09-22 (E + 40), corporate advance $114.00 and pay; recover on receipt.
- **Worked example (insurer look-back).** Termination effective 2031-08-01 but the cancellation notice reaches the insurer 2031-09-20 (50 days later): MGIC refunds only for periods within 45 days before receipt (from 2031-08-06); the borrower is still owed the full unearned premium from 2031-08-01 → the 5-day difference is a corporate expense and a `SM_MI_INSURER_CANCEL_TARGET_2BD` breach is logged.

#### Integrations
- **Insurers** (`integrations/mi/*`): cancellation notice with payee = servicer (partner name/T&I account); refund advice (portal download, SFT report, or ACH addenda) → `mi.insurer.refund_received`; disputes via insurer servicing contacts; MGIC direct deposit within ~2 BD of processing.
- **Custodial bank** (Section 6.4): match incoming ACH credits by insurer originator ID + amount + certificate reference to `mi_refunds`; unmatched credits go to Section 6.5 unidentified funds with a 5-BD research SLA.
- **Borrower payment rails** (`nacha`, `print-mail`): ACH credit (PPD credit to the account with `autodraft` consent; account validated per Nacha WEB/PPD rules) or check.
- **Escrow** (Section 3.2/3.5) and **Fannie Mae escrow events** (Section 5) as above.
- Failure handling: insurer ACH returned/rejected → check reissue within 5 BD; borrower ACH return (R01–R04) → check within 5 BD; the 45-day timer is satisfied only by a completed disbursement (`disbursement.issued` with a cleared/mailed status).

#### Outputs and artifacts
- `NTC_MI_REFUND_ADVICE` (policy; accompanies the refund): amount, computation basis (plan, premium, days in force, insurer method), effective date, statement that no further MI premiums are due, escrow analysis reference. Channel: with the check, or e-delivery/mail for ACH credits.
- Ledger postings: (1) insurer refund received: `Dr custodial_ti_cash / Cr escrow(loan, mi_line)`; (2) refund to borrower: `Dr escrow(loan, mi_line) / Cr custodial_ti_cash`; (3) corporate advance path: `Dr corporate_advances(loan) / Cr custodial_ti_cash` at payment, reversed on recovery; (4) LPMI refund: `Dr corporate cash / Cr corporate MI expense` (outside custodial accounts).
- Investor events: escrow deposit/disbursement events (Section 5) after Dec. 1, 2026; none before (Form 496A reconciliation captures the flows, Section 6.4).
- Records: `mi_refunds`, `disbursements`, `integration_messages` (insurer), `documents` (refund advice, insurer statement).

#### AI agent design (AI-first)
The `pmi` agent owns the refund case: computes the estimate, ensures the insurer notice carried the refund payee, watches the custodial feed for the credit, reconciles amount vs estimate, releases the borrower payment (ACH or check) with the advice letter, triggers/monitors the interim escrow analysis with the `escrow` agent, and handles variances (drafts the insurer dispute; explains the computation to the borrower on request). Tools: `pmi.refund.estimate`, `ledger.post`, `disbursements.issue`, `custodial.match`, `mi_insurer.refund_status`, `escrow.interim_analysis.request`, `notices.*`. Decision record: `{refund_id, method, inputs, estimate, insurer_amount, variance, payee, channel, advance?, timers}`. Guardrails: cannot credit a refund to escrow/principal/fees without a post-E borrower election document; cannot withhold a refund for delinquency; corporate advances above $5,000 need `officer` approval (package: computation, insurer correspondence, timer status); LPMI refunds never go to the borrower. Escalations: insurer refuses cancellation/refund → `officer` (master-policy dispute); refund payee is a deceased borrower/estate or a confirmed successor → `human_agent` review of payee instructions; suspected identity/account change fraud on the ACH account → `security-records`. AI-off: scheduled jobs compute and pay; exceptions queue.

#### Edge cases and failure modes
- Insurer-initiated cancellation or rescission (misrepresentation): report to Fannie Mae within 30 days (B-8.1-01; F-1-02 action code 54 for active loans; email for liquidated loans), open the A1-3-02 exposure review (Section 5.6); premium refunds from the insurer are held pending `officer` decision on whether the borrower is entitled (borrower-paid premiums → borrower unless the rescission arises from the borrower's own misrepresentation) **[UNVERIFIED legal position]**; MI escrow line closed; no borrower "termination notice" under 4904(a) is sent — instead an informational letter that coverage was rescinded by the insurer and the escrow is adjusted (no HPA right is involved).
- Payoff: MI ends on payoff; unearned annual/single premiums are refunded to the borrower with the payoff escrow refund (Section 16); the 45-day timer is instantiated as policy (`SM_MI_PAYOFF_REFUND_45`).
- Servicing transfer after E but before the refund: the transferor remains responsible for refunds of premiums it collected; the transfer accounting (Section 1.6/F-1-11 "accruals on deposit") carries the MI line; the receiving servicer completes the borrower refund from transferred funds and the timer continues.
- Bankruptcy: refund is the debtor's property; pay to the debtor (Chapter 7 trustee notice if the case is open and the amount is material — `attorney` consult above $1,000).
- Deceased borrower: pay to the estate/confirmed successor per Section 4.4 rules.
- Insurer insolvency/run-off: no refund received → corporate advance and claim against the insurer; `officer` notification.
- Duplicate refunds (insurer pays the borrower directly and the servicer): reconcile; recover via the borrower with consent; do not offset the loan.
- Refund check returned undeliverable: address research (Section 4); reissue; escheat per state unclaimed-property rules after the dormancy period (`jurisdiction_rules.escheat_years`).
- Retro-correction: a termination date corrected earlier → additional refund of premiums collected between the true and the recorded date, with interest if state law requires (`jurisdiction_rules.refund_interest`).

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 10.5-T1 | Given the annual-plan example (E = 2031-08-01), then `estimate_cents = 141173`, insurer timer due 2031-09-03, borrower timer due 2031-09-15; when the $1,411.73 ACH lands 2031-08-12, then match, postings (1) and (2), borrower paid 2031-08-13, timer satisfied. |
| 10.5-T2 | Given the monthly example (E = 2031-08-13), then `estimate_cents = 11400`; given no insurer funds by 2031-09-22, then a corporate advance of $114.00 is posted and the borrower is paid by 2031-09-27; when the insurer's $114.00 arrives 2031-10-02, then the advance is reversed. |
| 10.5-T3 | Given an insurer amount of $1,380.00 vs estimate $1,411.73 (variance $31.73), then status `disputed`, dispute letter drafted within 5 BD, and the borrower still receives $1,411.73 by day 45 (policy: pay the higher amount when unresolved by day 40). |
| 10.5-T4 | Given the escrow MI line balance $950.00 at E, then an interim analysis completes within 10 BD, the surplus is refunded within 30 days of the analysis, and the new payment excludes the $190.00 MI deposit effective 2031-09-01. |
| 10.5-T5 | Given an LPMI policy terminated by payoff, then no borrower refund leg exists and the insurer refund posts to corporate accounts. |
| 10.5-T6 | Given the cancellation notice reaches the insurer 50 days after E, then the insurer's 45-day look-back shortfall (5 days of premium) is posted to corporate expense and the borrower receives the full unearned amount. |
| 10.5-T7 | Given an agent command to apply the refund to late charges without a borrower election, then the command is rejected and logged. |
| 10.5-T8 | Given a borrower ACH credit returned R03, then a check is issued within 5 BD and the 45-day timer is satisfied only on the check's mailing date. |
| 10.5-T9 | Given Dec. 2, 2026 or later, then the refund deposit and disbursement generate escrow events accepted before 03:00 ET the next business day. |
| 10.5-T10 | Given an insurer rescission notice received 2027-03-03, then LAR 89 action code 54 with action date 030327 is reported and a Fannie Mae notification is made within 30 days; the borrower refund leg is held for `officer` decision. |

#### Audit and evidence
`mi_refunds` history (estimate, insurer amount, variance, payee, channel, timestamps), `ledger_entries` per posting, custodial match records, `disbursements` with ACH trace numbers or check numbers and mailing evidence, insurer notification/ack messages with timestamps (4907(e) defense), timer history for the 30/40/45-day clocks, interim escrow analysis IDs, escrow events acks, and the refund advice document hash.

### Open questions / decisions
1. **Advance threshold (10.5-Q1):** default — automatic corporate advance at day 40 up to $5,000; `officer` approval above.
2. **Financed single premium refunds (10.5-Q2):** default — pay the insurer's scheduled refund to the borrower (no principal reduction) unless the note/MI agreement directs otherwise; confirm with counsel and the partner.
3. **Escrow MI-line refund below $50 (10.5-Q3):** default — refund regardless of amount (treat as unearned premium), not "consider in the next analysis."
4. **Rescission refunds (10.5-Q4):** default — hold for `officer` decision with counsel input; borrower entitled unless the rescission arises from the borrower's misrepresentation.

### Sources
- 12 U.S.C. 4902(f), (h), 4907: https://www.law.cornell.edu/uscode/text/12/4902 ; https://www.law.cornell.edu/uscode/text/12/4907 (verified 2026-09-09)
- Servicing Guide B-8.1-04 (05/15/2019), B-8.1-02 (05/20/2015), B-8.1-01 (11/17/2021), F-1-02 (05/13/2026): https://servicing-guide.fanniemae.com/svc/b-8.1-04/termination-conventional-mortgage-insurance ; https://servicing-guide.fanniemae.com/svc/b-8.1-02/paying-conventional-mortgage-insurance-premiums ; https://servicing-guide.fanniemae.com/svc/b-8.1-01/conventional-mortgage-insurance-servicer-responsibilities ; https://servicing-guide.fanniemae.com/svc/f-1-02/escrow-taxes-assessments-and-insurance
- MGIC Servicing Guide (Mar. 2026): https://www.mgic.com/-/media/mi/servicing/71-43444-guide-pdf-servicing-guide.pdf
- CFPB Bulletin 2015-03: https://files.consumerfinance.gov/f/201508_cfpb_compliance-bulletin_private-mortgage-insurance-cancellation-and-termination.pdf
- LL-2026-05 (escrow events): https://singlefamily.fanniemae.com/media/document/pdf/lender-letter-ll-2026-05-advance-notice-changes-servicing-processes-and-systems
- Sections 3.2, 3.5, 5.1, 6.4, 6.5 and 16 of this specification.
