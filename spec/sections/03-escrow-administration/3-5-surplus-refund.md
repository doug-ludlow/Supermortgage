# 3.5 — Surplus refund

| Attribute | Value |
|---|---|
| Section | 3 — Escrow Administration |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On analysis |
| Governing source | Reg X 1024.17(f)(2)(i) |
| Key deadlines | Refund within 30 days if surplus ≥ $50 (borrower current); < $50 may credit |
| Timers | `ESC_REFUND_CHECK_STALE_180`, `ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD`, `REGX_1024_17F2_SURPLUS_REFUND_30`, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Escrow |
| Trigger & frequency | On analysis |
| Governing source (blueprint) | Reg X 1024.17(f)(2)(i) |
| Key deadlines (blueprint) | Refund within 30 days if surplus ≥ $50 (borrower current); < $50 may credit |
| Data/artifacts | Refund |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Sub performs from the T&I custodial account; SoR liable |
| Nuances (blueprint) | [cropped in source] — reconstructed: delinquent-borrower retention; payoff refund within 20 days excluding legal public holidays, Saturdays and Sundays (1024.34(b)); credit to a new loan by agreement; netting comment; escheat of uncashed checks |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.17(f)(2)** (eCFR current as of Sept. 4, 2026): (i) "If an escrow account analysis discloses a surplus, the servicer shall, within 30 days from the date of the analysis, refund the surplus to the borrower if the surplus is greater than or equal to 50 dollars ($50). If the surplus is less than 50 dollars ($50), the servicer may refund such amount to the borrower, or credit such amount against the next year's escrow payments." (ii) "These provisions regarding surpluses apply if the borrower is current at the time of the escrow account analysis. A borrower is current if the servicer receives the borrower's payments within 30 days of the payment due date. If the servicer does not receive the borrower's payment within 30 days of the payment due date, then the servicer may retain the surplus in the escrow account pursuant to the terms of the federally related mortgage loan documents." (iii) a voluntary agreement for deposits above the (c) limits covers one year and "shall not alter how surpluses are to be treated when the next escrow analysis is performed."

**12 CFR 1024.34(b)** (eCFR current as of Sept. 3, 2026): (1) "within 20 days (excluding legal public holidays, Saturdays, and Sundays) of a borrower's payment of a mortgage loan in full, a servicer shall return to the borrower any amounts remaining in an escrow account that is within the servicer's control"; (2) instead, if the borrower agrees, the servicer may credit the remaining funds to the escrow account of a new federally related mortgage loan from the same lender/owner/assignee or serviced by the same servicer as of the new loan's settlement date. Supplement I (current as of Sept. 2, 2026): comment 34(b)(1)-1 — (b)(1) "does not prohibit a servicer from netting any remaining funds in an escrow account against the outstanding balance"; 34(b)(2)-1 — a refund is always permissible; 34(b)(2)-2 — the borrower "may agree either orally or in writing" to the credit.

**Fannie Mae**: B-1-01 has no surplus rule beyond law; F-1-11 requires escrow funds to move with the servicing at transfer (the transferee then applies (f) per 1024.17(e)(2)); at foreclosure/REO/short sale the remaining escrow balance is applied per Section 15 claim rules, not refunded (cross-ref 15.1–15.3). Escrow refunds are a disbursement from the T&I custodial account (Section 6.2/6.4 reconciliation) and, from Dec 1, 2026, an escrow disbursement event (3.7).

**Other law**: state unclaimed-property statutes govern uncashed refund checks (dormancy periods vary; **[UNVERIFIED per state]**); Nacha PPD credit authorization may be oral (00b N10) — policy below uses checks unless the borrower has elected ACH refunds.

**Discrepancies with the blueprint row**: the blueprint hard-timer table lists only the 30-day refund; the 20-day payoff refund (1024.34(b) — "20 days (excluding legal public holidays, Saturdays, and Sundays)") is a separate hard timer that must be in Section 16 as well as here; "may credit" applies only to surpluses under $50 for current borrowers.

### Operational prerequisites
- T&I custodial account disbursement rails: check printing (print vendor or bank check-issue file) and ACH credit origination (ODFI agreement; 00b N10) — Supermortgage/Partner; 4–8 weeks.
- Positive-pay setup and check-image return feed from the custodial bank (00b N11).
- Unclaimed-property program (dormancy calendar, due-diligence letters) — compliance; before first stale check.
- Borrower refund-preference capture (portal) and address verification service.

### Build spec
#### Inputs and triggers
- `escrow.analysis.approved` with `decision.surplus_action ∈ {refund, credit}` (3.2).
- `payoff.funds_received` / `loan.paid_in_full` (Section 16.2) → payoff refund of the remaining escrow balance after final scheduled disbursements are released or cancelled.
- `loan.reinstated` after a retained surplus → interim analysis (3.2) → refund if still surplus.
- Borrower agreement to credit a new loan (`consents.kind='escrow_credit_to_new_loan'`, oral or written) — Section 16 refinance flow.
- `disbursement.returned` (check returned/undeliverable) → re-issue flow; `check.stale` at 180 days → outreach then escheat.

#### Data model
- `disbursements` (baseline; fields fixed in 3.7) with `disbursement_kind='surplus_refund' | 'payoff_refund' | 'surplus_credit'`, `payee_type='borrower'`, `amount_cents`, `method` ∈ {check, ach_credit, credit_to_new_loan}, `due_at`, `issued_at`, `cleared_at`, `status` ∈ {scheduled, issued, cleared, returned, stopped, reissued, escheated, cancelled}, `check_number`, `positive_pay_sent_at`, `analysis_id`, `timer_id`, `investor_event_id`.
- `escrow_accounts.surplus_retained_cents` (when the borrower was not current), `surplus_retained_at`.
- Ledger accounts used: loan `escrow` (liability to borrower), custodial `custodial_ti_cash`; for a credit-to-new-loan: transfer between the two loans' `escrow` accounts.
- PII: payee name/address; bank account (encrypted) for ACH credits.

#### State machine
`decided` (from analysis) → `scheduled` (due_at set) → `issued` (check printed / ACH file sent; ledger posted) → `cleared` [terminal] | `returned` → `address_verified` → `reissued` → `issued` … | `stale` (180 days uncashed) → `outreach` → `reissued` | `escheat_pending` → `escheated` [terminal]. Alternative branch: `retained` (borrower not current) → `re_evaluated` at next analysis/reinstatement → `decided` or `absorbed` (surplus gone). `credit` branch: `decided` → `credited_to_payments` (the 3.2 payment credit) [terminal]. Payoff branch: `payoff_posted` → `final_disbursements_settled` → `scheduled` → … as above, or `credited_to_new_loan` [terminal]. Actors: `escrow` agent; custodial bank feed; print vendor; `payoff-release` agent for payoff triggers.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_17F2_SURPLUS_REFUND_30` | deadline | `escrow.analysis.approved` with surplus ≥ $50 and borrower current | `escrow_analyses.as_of_date` (date of the analysis) | 30 calendar_days | `disbursement.issued` (kind surplus_refund) | sev-2; auto-issue; RESPA exposure log |
| `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` | deadline | `loan.paid_in_full` | payoff posting date | 20 business_days_federal (excludes federal legal public holidays, Saturdays, Sundays) | `disbursement.issued` (kind payoff_refund) or `escrow.credit_to_new_loan.posted` | sev-1; auto-issue |
| `ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD` | not_before_gate (policy) | `loan.paid_in_full` | payoff posting date | 5 business_days_servicer | release of in-flight tax/insurance disbursements or their cancellation | refund waits for settlement of in-flight items but never beyond the 20-BD deadline |
| `ESC_REFUND_CHECK_STALE_180` | deadline (internal) | `disbursement.issued` (check) | issued_at | 180 calendar_days | `disbursement.cleared` | outreach + reissue; escheat clock per state |
| `STATE_UNCLAIMED_PROPERTY_<XX>` | deadline (jurisdiction) | `disbursement.stale` | last contact/issue date | state dormancy period **[UNVERIFIED per state]** | `disbursement.escheated` | compliance escalation |

#### Business rules and calculations
1. **Amount**: `refund_cents = escrow_analyses.surplus_cents` (already cents-exact). Payoff: `refund_cents = escrow balance after posting the payoff and after releasing/cancelling every scheduled disbursement whose due date is on/after the payoff date` (bills due before payoff and unpaid are paid first, since the lien-protection duty continues until release — Section 16.3).
2. **Eligibility**: surplus refund requires `borrower_current` at the analysis (`regx_days_delinquent ≤ 30`). Not current → `retained`; re-evaluate at reinstatement (interim analysis) or the next annual analysis; never charge fees for retention.
3. **$50 threshold**: ≥ 5000 cents → refund mandatory; < 5000 cents → credit (3.2 R8) unless the borrower requests a refund (honor it).
4. **Method**: default check to the mailing address of record; ACH credit if `consents.kind='refund_ach'` on file (validated account); credit-to-new-loan only with `escrow_credit_to_new_loan` consent and a same-servicer/same-owner new loan settling on/after the consent date (1024.34(b)(2)).
5. **Netting at payoff** (comment 34(b)(1)-1): permitted; **policy default: do not net** — refund separately; feature flag `escrow.payoff.net_against_shortfall` allows netting when payoff funds are short by ≤ the escrow balance and the payoff statement disclosed it.
6. **Ledger** (per loan and per custodial account): Dr `escrow` (liability) / Cr `custodial_ti_cash` for the refund; reversal on return: Dr `custodial_ti_cash` / Cr `escrow`; reissue posts again. Credit-to-new-loan: Dr old loan `escrow` / Cr new loan `escrow` (no cash movement; same custodial account) — if the new loan is in a different custodial account, book cash transfer.
7. **Escrow event** (3.7): disbursement event, category "Loan Taxes and Insurance", item type for refunds **[UNVERIFIED — confirm allowable value in the Business & Data Requirements]**, amount negative, balance = post-refund category balance (0 at payoff).
8. **Timer arithmetic**: 30 "days" = calendar; 20 days under 1024.34(b) exclude Saturdays, Sundays and federal legal public holidays (5 U.S.C. 6103 list in `holiday_calendars.federal`).

Worked examples: (a) analysis as_of 2027-05-16, surplus $143.32, borrower current → due 2027-06-15; check #100234 issued 2027-05-22 for $143.32; ledger Dr escrow 14332 / Cr custodial_ti_cash 14332; escrow event amount −143.32, balance 1,106.68 (target). (b) Payoff funds posted Thursday 2027-02-11; 20 days excluding Saturdays, Sundays and the legal public holiday Presidents' Day (Mon 2027-02-15) → due **Friday 2027-03-12**; escrow balance after payoff $612.40; no bills due before payoff → refund $612.40 issued 2027-02-18. (c) Surplus $26.68 → credit $2.22/month + $0.04 first month (3.2). (d) Surplus $300.00 with `regx_days_delinquent = 47` → retained; loan reinstated 2027-08-03 → interim analysis 2027-08-04 shows surplus $300.00 → refund due 2027-09-03.

#### Integrations
- **Custodial bank / check issue** (00b N11): check-issue file (positive pay) and paid-check return feed [bank-specific]; ACH PPD credit via the `nacha` adapter with prenote/validation; failures → retry, then check fallback within the deadline.
- **Print/mail** for check + `NTC_SM_ESCROW_SURPLUS_REFUND` insert.
- **Fannie Mae**: escrow disbursement event (3.7) via `fnma-servicing-events`; Form 496A reconciliation (6.4) sees the disbursement.
- **Section 16** payoff pipeline provides `loan.paid_in_full`, the new-loan credit consent and the refinance link.

#### Outputs and artifacts
- Notice `NTC_SM_ESCROW_SURPLUS_REFUND` (informational; accompanies check/ACH; explains the analysis reference) — mail with check or electronic with E-SIGN; the annual statement's item (vi) explains the handling (3.3).
- `disbursements` row; `ledger_entries`; `investor_events` escrow disbursement; `loan_events`: `escrow.surplus.refund_scheduled/issued/cleared/returned/reissued/escheated`, `escrow.surplus.retained`, `escrow.payoff_refund.issued`.

#### AI agent design (AI-first)
- Agent: `escrow` (analysis surpluses) and `payoff-release` (payoff refunds) using shared tools `issueRefund`, `verifyAddress`, `reissueDisbursement`, `stopCheck`, `recordConsent`, `emitEscrowEvent`, `escalate`. The agent confirms eligibility, chooses method, issues, and monitors clearing; on returned mail it verifies the address (USPS NCOA, borrower contact) before reissuing.
- Decision record: {analysis_id/payoff_id, surplus_cents, borrower_current, method, address source, timer due, issued_at, rationale}.
- Guardrails: refund amount is engine-computed; the agent cannot reduce it; payee must be a borrower/confirmed successor (no third-party payees without a `case` and human review); refunds > $25,000 or to a newly changed address require `officer` dual approval (policy control, not a legal touchpoint). `human_agent` on request.
- AI-off path: ops-console refund queue with the same validations.

#### Edge cases and failure modes
- Borrower dies / successor confirmed: refund payable to the estate or confirmed successor per 4.4.
- Bankruptcy: refunds to a Chapter 13 debtor may need trustee direction (Section 14) — hold and route via `bankruptcy-ops`.
- Foreclosure sale / DIL / short sale: no refund; balance applied per claim rules (Section 15).
- Transfer-out before issuance: surplus moves with the escrow funds; transferee applies (f) (1024.17(e)(2)); cancel our timer with reason.
- ACH credit returned (R03/R04): reissue by check within the remaining deadline.
- Refund issued, then a late bill arrives for a pre-payoff period: pay from corporate advance and bill the borrower per the payoff-statement terms (Section 16); do not claw back the refund without agreement.
- Disaster/SCRA: no special rule; refunds proceed.
- Netting disputes → NoE (4.1).

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 3.5-T1 | Given surplus $143.32, current borrower, as_of 2027-05-16, then timer due 2027-06-15 and a check is issued with ledger entries balanced. |
| 3.5-T2 | Given surplus exactly $50.00, then refund is mandatory; given $49.99, then credit path. |
| 3.5-T3 | Given `regx_days_delinquent=31` at analysis, then status `retained`, no timer; on reinstatement an interim analysis re-decides. |
| 3.5-T4 | Given payoff posted Thu 2027-02-11, then due date = 2027-03-12 (Presidents' Day excluded). |
| 3.5-T5 | Given payoff posted Fri 2027-12-24 (Christmas observed 12/24? — federal holiday 12/25 falls on Saturday, observed Fri 12/24), then day count starts Mon 12/27 and excludes 2028-01-17 (MLK); due date computed by the calendar service equals the hand-count. |
| 3.5-T6 | Given borrower oral consent (recorded call) to credit $612.40 to a new same-servicer loan settling 2027-03-01, then no check is issued and the inter-loan ledger transfer posts on settlement. |
| 3.5-T7 | Given a check returned undeliverable on day 25, then address verification and reissue occur before day 30 or the breach is logged with evidence of attempts. |
| 3.5-T8 | Given a check uncashed at 180 days, then outreach notice is sent and the state escheat timer starts. |
| 3.5-T9 | Given refund $30,000 (large overfunded account), then `officer` dual approval is required before issuance and the 30-day timer still governs. |
| 3.5-T10 | Given a Fannie Mae escrow disbursement event rejected for balance mismatch, then the event is corrected and resubmitted before 3:00 a.m. ET next BD (3.7). |

#### Audit and evidence
Refund decision inputs (analysis id, delinquency counter snapshot), disbursement record with check/ACH evidence, positive-pay confirmations, cleared-check images, return/reissue chain, consent evidence for credits, timer history, ledger entries, escrow event acks.

### Open questions / decisions
1. Net escrow against a short payoff? **Default: no** (flag available).
2. ACH refunds by default when a validated debit account exists? **Default: no — check**, unless the borrower opted into ACH refunds.
3. Officer dual-approval threshold. **Default: $25,000 or address changed within 30 days.**

### Sources
- 12 CFR 1024.17(f)(2): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-B/section-1024.17
- 12 CFR 1024.34: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.34
- Supplement I comments 34(b)(1)-1, 34(b)(2)-1, 34(b)(2)-2: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Supplement%20I%20to%20Part%201024
- Fannie Mae F-1-11 (custodial funds at transfer): https://servicing-guide.fanniemae.com/svc/f-1-11/post-delivery-servicing-transfers
