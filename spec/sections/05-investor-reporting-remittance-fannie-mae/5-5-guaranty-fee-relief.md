# 5.5 — Guaranty fee relief

| Attribute | Value |
|---|---|
| Section | 5 — Investor Reporting & Remittance (Fannie Mae) |
| Automation class | a |
| Trigger & frequency | 4 months delinquent (S/S MBS) |
| Governing source | FNMA F-1-20 |
| Key deadlines | On trigger |
| Timers | `FNMA_F120_GFEE_BILL_RETRIEVE_CD5`, `FNMA_F120_GFEE_DRAFT_CD7`, `FNMA_F120_GFEE_RELIEF_RECONCILE_BILL`, `FNMA_F120_GFEE_RESUME_ON_CURRENT`, `SM_GFEE_RECOVERY_MATCH_2_CYCLES` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Investor Reporting |
| Trigger & frequency | 4 months delinquent (S/S MBS) |
| Governing source (blueprint) | FNMA F-1-20 |
| Key deadlines (blueprint) | On trigger |
| Data/artifacts | Records |
| Systems | CRS |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Fannie Mae places the loan in Guaranty Fee Relief and suspends the draft; Supermortgage reconciles the g-fee bill/draft, tracks g-fee advances and their recovery; the partner's custodial account is drafted |
| Nuances (blueprint) | [cropped in source] — reconstructed: g-fee draft on the 7th; relief for S/S MBS loans four or more months delinquent; recovery order on contractual payments; SVC-2026-02 also removed the g-fee advance for Stop Delinquency Advance loans; buy-up/buy-down adjustments; excess servicing strip is separate |

### Verified requirement (as of 2026-09-09)

**F-1-20 (03/11/2026), "Remitting MBS Guaranty Fees and Charges":** Fannie Mae initiates drafts for "guaranty fees, guaranty fee buydown charges, and deposits for guaranty fee buyup charges"; the servicer must designate a custodial bank account for the fees, "retrieve the electronic draft notice (or 'bill') from Fannie Mae's website," and "remit the fees and charges to the designated custodial account so they are available to Fannie Mae on the **seventh calendar day of the month, or on the preceding business day if the seventh is not a business day**." **Guaranty Fee Relief process:** for a scheduled/scheduled MBS loan that is four or more months delinquent Fannie Mae "will place the mortgage loan in the Guaranty Fee Relief process and suspend drafting guaranty fees from the servicer's custodial account"; the servicer "must continue to report mortgage loan activity"; if the servicer collects "one or more full contractual payments while the mortgage loan is in the Guaranty Fee Relief process, Fannie Mae will draft the guaranty fee amount associated with the contractual payment," applying it first "to recover the outstanding guaranty fees due to Fannie Mae"; once recovered, "the servicer may then retain subsequent guaranty fee amounts to recover delinquent guaranty fee advances it has made." Exits: removed from the trust/reclassified to A/A, paid off, repurchased or liquidated → "the servicer is no longer responsible for remitting guaranty fees"; loan becomes current → "the servicer must resume remitting guaranty fees … Fannie Mae will draft … each month, beginning with the applicable draft date."

**History and alignment:** Guaranty Fee Relief was announced Sept. 29, 2021 (LL-2021-12) and effective with the May 2022 cash remittance cycle (April 2022 activity) — Fannie Mae "eliminated the requirement for servicers to advance guaranty fees once an MBS mortgage loan becomes four consecutive months delinquent." SVC-2026-02 (Mar. 11, 2026) removed from C-3-01/F-1-20 the residual requirement to advance guaranty fees for loans in the Stop Delinquency Advance process, so the P&I and g-fee suspensions now share the four-consecutive-month trigger. The 2020 SDA webinar statement that "servicers will continue to be drafted guaranty fee … during the stop delinquency advance period" is superseded. **The relief still exists in the Aug. 12, 2026 Guide (verified in F-1-20 text).**

**Computation:** the guaranty fee is the annual g-fee rate on the MBS loan applied monthly to the prior period's scheduled UPB (÷12), with buy-up/buy-down adjustments from the pool's terms; the amount is presented on Fannie Mae's monthly g-fee bill (Fannie Mae Connect "MBS Guaranty Fee Draft Notifications," consolidated in the Loan-Level Draft Notifications API) — the exact bill algorithm is Fannie Mae's; our calculation is a check figure **[PARTIALLY VERIFIED — formula inferred from the PTR/g-fee relationship in the IRM and F-1-25 ("adjust PTR to include guaranty fee" at reclass); confirm bill mechanics at onboarding]**.

**Discrepancies with the blueprint row:** the system is not CRS (the g-fee draft is Fannie Mae-initiated against the designated custodial account; CRS is only used if a manual g-fee remittance is ever requested); the deadline is the 7th-calendar-day draft each month, not merely "on trigger"; the row omits the recovery order, exits and the SVC-2026-02 change; the relief is for S/S **MBS** loans (portfolio loans have no g-fee).

### Operational prerequisites
- Designated custodial account for guaranty fees (may be the S/S P&I custodial account or a consolidated account) with Form 1013 and CRS drafting instruction for the g-fee draft type — Owner: partner treasury + `fnma_portal_operator`.
- Fannie Mae Connect access to MBS Guaranty Fee Draft Notifications (and API product) — partner CA.
- Pool-level g-fee rate, buy-up/buy-down bps and servicing-fee bps boarded per loan (Section 1.1; from the purchase advice/MBS pool data).

### Build spec
#### Inputs and triggers
- Monthly g-fee bill/draft notification (inbound, expected between BD3 and CD5 **[UNVERIFIED timing]**); CD7 draft; accepted LARs (scheduled UPB); `sda_status` transitions (5.4); contractual payments on relief loans; reclass purchase advices; payoffs/repurchases/liquidations.

#### Data model
- `gfee_calculations`: `loan_id`, `period`, `scheduled_upb_cents`, `gfee_rate` (decimal 9,6), `buyup_bps`, `buydown_bps`, `amount_cents`, `bill_amount_cents`, `variance_cents`, `relief_flag`.
- `gfee_relief_status` (per loan): `status` ∈ {not_applicable, predicted, active, exited}, `fnma_start_date`, `outstanding_fnma_gfee_cents` (g-fees Fannie Mae has forgone), `servicer_gfee_advances_cents`, `exit_reason`.
- `advances` rows `kind = gfee` (only for pre-relief months where the borrower did not pay; the servicer's g-fee on a delinquent loan is an advance by nature).
- `draft_notifications` rows with `draft_type = mbs_gfee`; `remittances` rows `kind = gfee`, `initiator = fnma`, `draft_date = CD7 (preceding BD)`.

#### State machine
`gfee_relief_status.status` mirrors 5.4: `not_applicable` (non-MBS, A/A, S/A) → `predicted` (S/S MBS loan four consecutive months delinquent at period end) → `active` (bill shows the loan suspended / zero g-fee) → `exited` (current → drafting resumes; reclass/payoff/repurchase/liquidation → no further g-fee). `remittances` (g-fee) follow the 5.2 machine: `computed` → `notified` (bill parsed and matched) → `funded` (T−1 16:00 ET) → `drafted` → `matched`/`variance`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_F120_GFEE_DRAFT_CD7` | deadline | period open | CD7 (preceding `fannie_et` BD) | funding check −1 BD 16:00 ET | g-fee `remittances.funded` | sev-1 (late remittance compensatory fee) |
| `FNMA_F120_GFEE_BILL_RETRIEVE_CD5` | deadline | period open | CD5 12:00 ET | 0 | bill parsed into `draft_notifications` | sev-2 → `human_portal_task` pull from Connect |
| `FNMA_F120_GFEE_RELIEF_RECONCILE_BILL` | deadline | bill parsed | parse time | same BD | every predicted/active relief loan reconciled to the bill | sev-2 |
| `SM_GFEE_RECOVERY_MATCH_2_CYCLES` | deadline | contractual payment on a relief loan | LAR acceptance | 2 bill cycles | Fannie Mae recovery then servicer retention matched | sev-2 |
| `FNMA_F120_GFEE_RESUME_ON_CURRENT` | deadline | loan becomes current | period end | next CD7 | g-fee funded | sev-1 |

#### Business rules and calculations
1. **Monthly check figure:** `amount = round_half_up(prior_scheduled_upb × gfee_rate ÷ 12) ± buyup/buydown adjustment`. Worked example (5.1 loan, g-fee 0.250%): month 1 = 250,000 × 0.0025 ÷ 12 = **$52.08**; month 2 (scheduled UPB $249,774.00) $52.04; month 3 $51.99; month 4 $51.94. Bill vs check-figure tolerance $0.01 per loan; larger variances → triage (scheduled UPB mismatch usually means a LAR issue in 5.1).
2. **Funding:** g-fee draft amount per bill must be available in the designated account by CD7 (preceding BD); for delinquent loans not yet in relief the g-fee is funded as an `advances(kind=gfee)` row (the servicer has not collected the interest that carries the fee); for relief loans the bill shows zero.
3. **Relief entry:** predicted with the same consecutive-month logic as 5.4; authoritative when the bill omits/zeros the loan. Both P&I (SDA) and g-fee relief now start at four consecutive months (SVC-2026-02); the engine asserts consistency between `sda_status` and `gfee_relief_status` for S/S MBS special-servicing loans and flags divergence (regular servicing option MBS loans are in g-fee relief but still advance P&I until removal — expected divergence).
4. **Recovery on contractual payments:** for each full contractual payment reported during relief, Fannie Mae drafts the g-fee associated with that payment ($52.08-ish) first against `outstanding_fnma_gfee` (fees Fannie Mae forwent); once that is zero the servicer retains the g-fee component of later payments against `servicer_gfee_advances` (the months 1–4 advances). Each bill line is matched FIFO and posts Cr `servicer_advance_receivable(gfee)`.
5. **Exits:** current → resume from the next CD7 bill; reclass to A/A → g-fee ceases and the PTR is adjusted "to include guaranty fee" (F-1-25) so the fee is embedded in the A/A pass-through thereafter; payoff/repurchase/liquidation → no further g-fee; outstanding servicer g-fee advances on liquidated loans are claimed per Section 15 (expense reimbursement) **[PARTIALLY VERIFIED — whether g-fee advances are reimbursable through the 571 claim to be confirmed]**.
6. **Excess servicing strip (code 106)** is not a g-fee and is not relieved (5.2 rule 10).

#### Integrations
- Inbound: Loan-Level Draft Notifications API (`fnma-connect`) for the g-fee bill; fallback UI pull by `fnma_portal_operator`. Outbound: none (Fannie Mae-initiated draft). Custodial bank feed for funding and debit matching (Section 6).

#### Outputs and artifacts
- `gfee_calculations`, `gfee_relief_status`, g-fee `remittances` and matched bank debits, advance ledger rows, monthly g-fee reconciliation report (bill vs check figures; relief roll-forward).
- Ledger: funding Dr `servicer_advance_receivable(gfee)` Cr `custodial_pi_cash` transfer for delinquent non-relief loans; draft Dr `gfee_payable` Cr `custodial_pi_cash`; on collected interest the g-fee component is Cr `gfee_payable` from the payment split.

#### AI agent design (AI-first)
`custodial-recon` agent: `parseGfeeBill`, `computeGfeeCheckFigures`, `reconcileRelief`, `fundDraft`, `matchDebit`, `recordDecision`. Decision record: `{period, bill_total, computed_total, per-loan variances[], relief_predicted_vs_bill[], funding_transfer, confidence}`. Guardrails: never fund from T&I; escalate to `officer` if the bill total differs from the check-figure total by more than the greater of $500 or 0.5% (likely systemic PTR/UPB reporting error) or if a relief loan reappears on the bill without a contractual payment; `fnma_portal_operator` for Connect pulls. Toggle-off: human reviews the bill reconciliation in `ops-console` before the funding transfer.

#### Edge cases and failure modes
- **Buy-up/buy-down pools:** fixed bps adjustments change the check figure; boarding must carry them.
- **Loan reclassified mid-month:** bill excludes it; PTR change on the A/A side must match the purchase advice.
- **SCRA rate reduction on an MBS loan:** g-fee unaffected (Fannie Mae reimburses interest shortfall separately, F-1-19).
- **Relief loan pays off with delinquent g-fees outstanding:** Fannie Mae's forgone g-fees are settled from proceeds? — F-1-20 says the servicer "is no longer responsible"; do not add g-fees to the payoff figure unless Fannie Mae's payoff draft includes them (reconcile) **[PARTIALLY VERIFIED]**.
- **Bill late or unavailable:** fund on check figures; reconcile after.
- **Transfer-in/out:** g-fee obligations follow the servicer of record on CD7; transfer files must carry relief status and outstanding advances.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 5.5-T1 | Given the example loan current in October 2026, then the November bill line is $52.08 (check figure equal) and the draft is funded by Thu Nov 5, 2026 16:00 ET for the Fri Nov 6 draft (Nov 7 is a Saturday). |
| 5.5-T2 | Given the loan four consecutive months delinquent at Mar 31, 2027, then `gfee_relief_status.predicted` is set, the bill after Fannie Mae's status shows zero, and the engine asserts `sda_status` is also active (special servicing). |
| 5.5-T3 | Given two contractual payments during relief, then the next bill drafts two months of g-fee ($52.08 + $52.04) applied first to `outstanding_fnma_gfee`, and subsequent bills show servicer retention credits until $208.05 of servicer g-fee advances are recovered. |
| 5.5-T4 | Given a bill total $48,210.44 vs computed $47,600.10 (variance $610.34 > $500), then an `officer` escalation opens with the per-loan variance list. |
| 5.5-T5 | Given a regular servicing option MBS loan five months delinquent, then g-fee relief is active while P&I advances continue (documented expected divergence, no alert). |
| 5.5-T6 | Given the g-fee draft date Jan 7, 2027 (Thursday), then funding gate = Wed Jan 6 16:00 ET; for Feb 7, 2027 (Sunday) the draft date is Fri Feb 5 and the gate Thu Feb 4. |

#### Audit and evidence
Bills (hash), check-figure computations, relief roll-forward, matched debits, advance trail and decision records — retained `life_of_loan_plus_4y`; supports MBS trust-compliance inquiries and Form 496 reconciliation (Section 6.3).

### Open questions / decisions
1. **Bill availability date** — default: poll the API daily from BD3; escalate at CD5 noon.
2. **G-fee advance reimbursement on liquidation** — default: include in the Section 15.2 claim as "other advances" only if Fannie Mae confirms eligibility; otherwise expense.
3. **Consolidated vs per-remittance-type custodial account for g-fee drafts** — default: the S/S MBS P&I custodial account.

### Sources
- F-1-20 (03/11/2026) — Remitting MBS Guaranty Fees and Charges; Guaranty Fee Relief process: https://servicing-guide.fanniemae.com/svc/f-1-20/remitting-and-accounting-fannie-mae (verified 2026-09-09)
- Fannie Mae Capital Markets, "Guaranty Fee Relief after Four Months Delinquency" (Sept. 29, 2021; effective May 2022 cycle): https://capitalmarkets.fanniemae.com/mortgage-backed-securities/single-family-mbs/guaranty-fee-relief-after-four-months-delinquency (verified 2026-09-09)
- SVC-2026-02 (Mar. 11, 2026) and TENA summary (URLs in 5.4) (verified 2026-09-09)
- F-1-25 (12/20/2023) — PTR adjusted to include guaranty fee at reclass (URL in 5.4) (verified 2026-09-09)
- SDA webinar deck (2020) — superseded g-fee statement (URL in 5.2) (verified 2026-09-09)
- 2026 Investor Reporting and Remitting Calendar — guaranty fee 7th calendar day (URL in 5.1) (verified 2026-09-09; graphic)
