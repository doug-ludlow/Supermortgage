# 5.4 — Stop Delinquency Advance handling

| Attribute | Value |
|---|---|
| Section | 5 — Investor Reporting & Remittance (Fannie Mae) |
| Automation class | a |
| Trigger & frequency | 4 consecutive missed payments (S/S special servicing) |
| Governing source | FNMA LL-2020-08; F-1-20 |
| Key deadlines | Fannie Mae suspends drafting delinquency advances after the 4th consecutive advance |
| Timers | `FNMA_A1306_RECLASS_SELECTION_6M`, `FNMA_C301_SDA_PREDICT_EOM`, `FNMA_F120_SDA_EXIT_RESUME_DRAFT`, `FNMA_F120_SDA_FUNDING_HOLD`, `FNMA_F120_SDA_STATUS_RECONCILE_BD3`, `FNMA_F125_RECLASS_DESELECT_CD15`, `FNMA_IRM_SDA_CONTRACTUAL_LAR_NEXTBD_2000`, `SM_SDA_RECOVERY_MATCH_2_CYCLES`, `SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Investor Reporting |
| Trigger & frequency | 4 consecutive missed payments (S/S special servicing) |
| Governing source (blueprint) | FNMA LL-2020-08; F-1-20 |
| Key deadlines (blueprint) | Fannie Mae suspends drafting delinquency advances after the 4th consecutive advance |
| Data/artifacts | Advance receivable tracking |
| Systems | Investor reporting system |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Fannie Mae sets the Stop Advance status; Supermortgage predicts it, reconciles the draft credits, tracks both receivables and keeps reporting; the partner (or Supermortgage) funds the four advances |
| Nuances (blueprint) | [cropped in source] — reconstructed: applies to S/S special servicing option MBS and portfolio S/S special servicing loans; regular servicing option loans keep advancing until removal (reclass selection at six months); recovery order (Fannie Mae first, then servicer); exits (current, deferral, reclass, payoff, repurchase, liquidation); no g-fee advance since SVC-2026-02 |

### Verified requirement (as of 2026-09-09)

**C-3-01 (03/11/2026):** for MBS special servicing option loans and portfolio S/S special servicing loans the servicer remits scheduled P&I "until the mortgage loan becomes four consecutive months delinquent"; regular servicing option loans "until the mortgage loan is removed from Fannie Mae's active accounting records." At four consecutive months "Fannie Mae will suspend drafting scheduled P&I amounts from the servicer's custodial account until the mortgage loan becomes current or a full contractual payment is made." Portfolio S/A loans advance scheduled interest only through the third month (IRM p. 26: recovered by a negative three-month interest entry in month four).

**F-1-20 (03/11/2026), "Stop Delinquency Advance process":** when an S/S loan is four or more months delinquent Fannie Mae "will place it in the Stop Delinquency Advance process and suspend drafting delinquency advances from the servicer's custodial account." While in the process the servicer "must continue to report mortgage loan activity to Fannie Mae; and advance excess servicing fees, as applicable" (SVC-2026-02, Mar. 11, 2026, removed "the requirement for servicers to advance guaranty fees for loans in the Stop Delinquency Advance process"). If the servicer "collects one or more full contractual payments while the mortgage loan remains in the Stop Delinquency Advance process, Fannie Mae will draft these funds and first apply them to recover advances made by Fannie Mae on behalf of the servicer. Once Fannie Mae has recovered all its advances, the servicer may then retain subsequent contractual payments to recover delinquent P&I advances it has made." Exits: removed from the trust/reclassified to A/A → "servicer is no longer required to advance P&I. Fannie Mae will reimburse the servicer for any outstanding delinquency advances"; becomes current → resume scheduled P&I, Fannie Mae drafts each month; brought current through a completed payment deferral → Fannie Mae reimburses delinquency advances up to that point; paid off or repurchased → Fannie Mae drafts any outstanding P&I; liquidated → Fannie Mae reimburses outstanding delinquency advances.

**Mechanics (Fannie Mae SDA webinar deck, 2020; SDA Form 496 job aid 10/4/2023; LL-2020-08 historical):** FHFA directed Fannie Mae "to cease requiring servicers to advance any payments of principal and interest on eligible loans serviced under S/S … after 120 days of delinquency"; the servicer advances months 1–4 and stops with month 5; Fannie Mae places eligible loans in Stop Advance status at BD2 with a Stop Advance Start Date of the 1st of that month; the draft notification shows expected P&I offset by a "Stop Advance Principal/Interest Credit" (net draft $0 for the loan) and Fannie Mae carries an "Outstanding Fannie Mae P&I Receivable"; on a reported contractual payment Fannie Mae drafts "Stop Advance Principal/Interest Recovery" amounts; reports: Fannie Mae Connect "Remittance Detail – P&I" (Stop Advance Status, Start Date, Adjusted Start Date, Expiration Date, outstanding advances), "Remittance Detail – Cash Adjustments" (B2B), LSDU "Cash Position P&I Summary," "Cash Position P&I Details Download," "Cash Position Adjustment Details Download"; Form 496 Section II line 12 carries an offsetting adjustment equal to the aggregate outstanding P&I receivable with an explanation. The deck's guidance that g-fees continue to be drafted is superseded by SVC-2026-02 and by Guaranty Fee Relief (5.5).

**Reclassification interplay (A1-3-06, 10/13/2021; F-1-25, 12/20/2023):** special servicing option MBS loans are automatically reclassified at 24 months past due (earlier on payoff, repurchase, permanent modification, short sale/Mortgage Release, foreclosure referral); regular servicing option MBS loans are selected at six consecutive months of delinquency; deferral loans are not selected; the "Eligible for Deselection" report posts about CD11 and the servicer must act by the 15th; after reclass the remittance type is A/A from the 1st of the reclass month and Fannie Mae reimburses outstanding delinquency advances (purchase advice).

**Discrepancies with the blueprint row:** LL-2020-08 is historical (policy now lives in C-3-01/F-1-20); the trigger is "four consecutive months delinquent" as determined by Fannie Mae from reported LPI at BD2 (≈120 days), after which the fifth and later drafts are credited — consistent with "after the 4th consecutive advance" but the exact boundary month is set by Fannie Mae's Stop Advance Start Date **[PARTIALLY VERIFIED — the 2020 deck's transition example is ambiguous on whether the period in which the loan becomes four months delinquent is itself advanced]**; the row omits regular-servicing-option loans (advance until removal, reclass at 6 months), the recovery order, the exits and the g-fee change.

### Operational prerequisites
- Servicing option per loan (special vs regular servicing option; Fannie Mae loss-risk flag) and pool issue date boarded (Section 1.1) — drives whether SDA applies or reclass-at-6-months applies.
- Fannie Mae Connect access to Remittance Detail – P&I and Remittance Detail – Cash Adjustments; LSDU Cash Position downloads (5.2 prerequisites).
- Advance funding facility and dual-control transfer policy (5.2).
- Section 6.3 Form 496 template with the Section II line 12 SDA offset line.

### Build spec
#### Inputs and triggers
- Daily `fnma_delinquency_status` computation (baseline §3; LPI-based month buckets) and accepted `payment.none`/`payment.contractual` events (5.1).
- BD3 draft notification and Remittance Detail – P&I report (5.2) carrying Stop Advance Status/Start/Expiration and outstanding receivables.
- `payment.applied` events that constitute one or more **full contractual payments** (Section 2 rule: partial funds sit in suspense until a full installment accrues), `lossmit.deferral.completed`, `lossmit.modification.completed`, `reclass.purchase_advice.received`, `payoff.funds.cleared`, `repurchase.approved`, `liquidation.recorded`.

#### Data model
- `advances` (baseline) rows of `kind = delinquency_pi` per loan per activity period with `amount_cents`, `funded_from` (partner_line | supermortgage_corporate), `drafted_at`, `status` ∈ {outstanding, recovered_from_borrower, reimbursed_by_fnma, written_off}.
- `sda_status` (new, per loan): `status` ∈ {not_applicable, predicted, active, exited}, `predicted_entry_period`, `fnma_start_date`, `fnma_adjusted_start_date`, `fnma_expiration_date`, `fm_pi_receivable_cents` (Fannie Mae's outstanding receivable per report), `servicer_advances_outstanding_cents`, `exit_reason` ∈ {current, deferral, reclass, payoff, repurchase, liquidation}, `last_reconciled_report_id`.
- `draft_adjustments`: parsed rows from Cash Adjustment reports: `loan_id`, `period`, `type` ∈ {sda_principal_credit, sda_interest_credit, sda_principal_recovery, sda_interest_recovery, reclass_reimbursement, other}, `amount_cents`, `report_document_id`.
- Ledger: `servicer_advance_receivable` (per custodial account), memo `fnma_pi_receivable_sda`.

#### State machine
`sda_status.status`: `not_applicable` (A/A, S/A, regular servicing option) → `predicted` (special-servicing S/S loan reaches four consecutive months delinquent at period end per our LPI) → `active` (Fannie Mae report shows Stop Advance status; credits observed) → `exited` (Fannie Mae removes status; reason recorded) → may return to `predicted`/`active` on a later delinquency (new consecutive-month count starts after the loan is current). Guard: `active` is set only from Fannie Mae data; a `predicted` loan whose draft still shows a full draft at BD3 → variance triage (our delinquency count vs Fannie Mae's).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_C301_SDA_PREDICT_EOM` | recurring | period end | last calendar day 23:59 ET | 0 | `sda_status.predicted` set/cleared for every special-servicing S/S loan | sev-3 |
| `FNMA_F120_SDA_STATUS_RECONCILE_BD3` | deadline | BD3 report available | BD3 12:00 ET | 0 | every predicted/active loan reconciled to Fannie Mae's status | sev-2 |
| `FNMA_F120_SDA_FUNDING_HOLD` | not_before_gate | `sda_status.active` | — | — | — | blocks advance transfers for the loan; funding gate (5.2) excludes it |
| `FNMA_IRM_SDA_CONTRACTUAL_LAR_NEXTBD_2000` | deadline | full contractual payment(s) applied on an SDA loan | processed_at | next BD 20:00 ET (5.1 clock) | contractual-payment event accepted with updated LPI | sev-2 |
| `SM_SDA_RECOVERY_MATCH_2_CYCLES` | deadline | contractual payment reported on SDA loan | acceptance | 2 draft cycles | recovery adjustment matched (Fannie Mae recovery, then servicer retention) | sev-2 |
| `FNMA_F120_SDA_EXIT_RESUME_DRAFT` | deadline | loan becomes current | period end | next draft date (CD18) | scheduled P&I funded | sev-1 |
| `SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES` | deadline | exit by reclass/deferral/liquidation | exit event | 2 draft cycles | `advances.status = reimbursed_by_fnma` for all outstanding | sev-2 → Investor Reporting Representative package |
| `FNMA_A1306_RECLASS_SELECTION_6M` | informational | regular servicing option loan six consecutive months delinquent | period end | 0 | reclass purchase advice received | sev-3 |
| `FNMA_F125_RECLASS_DESELECT_CD15` | deadline | Eligible for Deselection report (~CD11) | CD11 | by CD15 | deselection decision recorded (`human_portal_task` if deselecting) | sev-2 |

#### Business rules and calculations
1. **Applicability:** SDA applies to `remittance_type = SS` loans with `servicing_option = special` (MBS or portfolio). Regular servicing option S/S loans: advance until removal; expect Fannie Mae reclass selection at six consecutive months (A1-3-06) and reimbursement at reclass. S/A portfolio: IRM three-month interest rule (5.2). A/A: nothing advanced.
2. **Consecutive-month count:** uses `fnma_delinquency_status` — number of unpaid installments as of the period's last calendar day based on the LPI date (a loan with LPI 11/01 and installments due 12/01, 01/01, 02/01, 03/01 unpaid is four consecutive months delinquent at Mar 31). Prediction: `predicted_entry_period` = that period; Fannie Mae's Start Date (1st of the month after BD2 of the following month) is authoritative.
3. **Advance schedule and worked example (5.2 loan):** activity periods at 1, 2, 3 and 4 months delinquent are drafted and advanced: $1,476.00, $1,476.10, $1,476.19, $1,476.29 → `servicer_advances_outstanding = $5,904.58`. Fannie Mae sets Stop Advance at BD2 of the next month; the following draft shows expected P&I $1,476.38 (interest $1,245.44 + principal $230.94 on scheduled UPB $249,088.61) with Stop Advance credits of −$1,245.44/−$230.94 → net $0; Fannie Mae's `fm_pi_receivable` grows by $1,476.38 that month and by $1,476.48 the next (scheduled UPB $248,857.67). No corporate transfer is made for the loan; guaranty fee drafts for the loan also stop (5.5).
4. **Borrower pays during SDA:** only full contractual payments count (partials → suspense). Two contractual payments of $1,580.17 each ($3,160.34) collected → the cashiering ledger applies them (interest at note rate, principal, escrow); the engine reports a contractual-payment LAR with LPI advanced two months by the next BD 20:00 ET; Fannie Mae then drafts recovery amounts equal to its outstanding receivable for those periods ($1,476.38 + $1,476.48 = $2,952.86) from the custodial account — the collected P&I must remain in `custodial_pi_cash` until that draft; the servicer keeps the servicing-fee component of each payment (interest at the note rate − PTR interest − g-fee ≈ $51.90 on a $249,088.61 balance) and, once `fm_pi_receivable` is zero, retains subsequent contractual payments' P&I against `servicer_advances_outstanding` ($5,904.58) via Fannie Mae's recovery credits on the draft; each credit is matched to an `advances` row (FIFO) and posts Dr `custodial_pi_cash`/corporate Cr `servicer_advance_receivable`.
5. **Exits:** (a) current (all installments paid, including through a repayment plan completion) → status removed; scheduled drafts resume from the month after; any remaining servicer advances are recovered from the contractual payments received (they were the payments that brought the loan current) — reconcile to zero; (b) payment deferral completed (Section 12.6) → Fannie Mae reimburses outstanding delinquency advances up to that point (expect adjustment code/report line; CRS code 208 "S/S Cash DelMod/PD P&I Advance Reimbursement" for portfolio cash loans); (c) reclassification to A/A (24 months special servicing; earlier on permanent modification, foreclosure referral, short sale/Mortgage Release, repurchase) → reimbursement on the purchase advice; (d) payoff/repurchase → Fannie Mae drafts any outstanding P&I (i.e., its receivable) from the payoff/repurchase proceeds — payoff calculator (5.2/16.2) must include it; (e) liquidation (5.3) → Fannie Mae reimburses outstanding advances after LAR acceptance.
6. **Form 496 (Section 6.3):** Section II line 12 offsetting adjustment = Σ `fm_pi_receivable` across SDA loans, with the explanation text, sourced from the Remittance Detail – P&I report / LSDU Cash Position P&I Details Download, not from our prediction.
7. **Excess servicing fee:** loans with an excess servicing strip continue to have the strip advanced during SDA ("advance excess servicing fees, as applicable") — `remittance_calculations.excess_servicing_cents` remains due **[PARTIALLY VERIFIED — mechanics of the strip draft to be confirmed at onboarding]**.
8. **Compliance Sentinel checks:** any special-servicing S/S loan with ≥5 consecutive months delinquent and a full draft (no SDA credit) → sev-2 (we are advancing money Fannie Mae should not be drafting); any SDA loan with advances still outstanding 2 cycles after an exit → package to the Investor Reporting Representative.

#### Integrations
- Inbound only: Fannie Mae Connect Remittance Detail – P&I and Cash Adjustments (API where available, else `fnma_portal_operator` pull by BD3 12:00 ET); LSDU Cash Position downloads; purchase advices (reclass). Outbound: none beyond 5.1 reporting and 5.2 funding; the Eligible-for-Deselection decision (F-1-25) is a `human_portal_task` when we deselect.

#### Outputs and artifacts
- `sda_status`, `advances`, `draft_adjustments`, reconciliation report per cycle (predicted vs Fannie Mae status; receivable roll-forward), Form 496 line-12 support schedule, decision records.
- Ledger postings per rule 3–5; investor events: contractual-payment LARs (5.1); delinquency status (5.7) unaffected.
- No borrower notices.

#### AI agent design (AI-first)
`custodial-recon` agent (roll-forward and matching) with `investor-reporting` (LAR timing) and `default-collections` (status inputs). Tools: `predictSdaEntry`, `parseRemittanceDetail`, `matchAdjustments`, `rollForwardReceivables`, `buildForm496Line12`, `openPortalTask`, `recordDecision`. Decision record: `{loan_id, period, predicted_status, fnma_status, fm_receivable_reported, fm_receivable_computed, servicer_advances_outstanding, adjustments_matched[], variance, action}`. Guardrails: never fund an advance for a loan Fannie Mae has flagged Stop Advance; never release custodial P&I collected on an SDA loan before Fannie Mae's recovery draft settles; escalate to `officer` when unreimbursed advances exceed $25,000 per loan or 60 days after an exit. Escalations: `fnma_portal_operator` for report pulls and deselection entries; `officer` for reimbursement disputes (agent drafts the Investor Reporting Representative package). Toggle-off: same roll-forward computed; human approves matches.

#### Edge cases and failure modes
- **Partial payments during SDA:** stay in suspense; no LAR movement; if a repayment plan is agreed (Section 12.5), the LAR moves only when a full installment accrues.
- **Forbearance (LL-2026-01) during months 1–4:** advances continue; SDA entry unaffected.
- **Deferral vs SDA timing:** IRM 4-01 — the contractual payment required before a deferral in the solicitation month must be reported at least 1 BD before month-end; the deferral exit reimburses advances.
- **Reclass while SDA active:** reimbursement of all outstanding advances; remittance type flips; SDA status removed.
- **Loan brought current then re-defaults:** new consecutive count starts at the first missed installment after being current; advances resume for four months.
- **Transfer-in of an SDA loan:** board Fannie Mae's Stop Advance status and receivables from the transferor's Remittance Detail – P&I (transfer file field), not from our prediction.
- **Fannie Mae report unavailable at BD3:** proceed on prediction for funding, reconcile when the report arrives, document.
- **Regular servicing option loan (not eligible):** advances continue; watch the six-month reclass selection and the deselection window.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 5.4-T1 | Given the S/S special-servicing loan with installments due Dec 1, 2026–Mar 1, 2027 unpaid, then `predicted_entry_period = 2027-03`, four advances totalling $5,904.58 are booked (drafts Jan 15, Feb 18, Mar 18 and Apr 16, 2027 — Apr 18 is a Sunday), and the funding gate excludes the loan from the first draft after Fannie Mae's report shows `active` (expected Tue May 18, 2027 under the four-advance model; if Fannie Mae instead credits the Apr 16 draft, the reconciliation flags the boundary and the advance for that period is reversed). |
| 5.4-T2 | Given the BD3 Remittance Detail shows Stop Advance credits of −$1,245.44/−$230.94, then `fm_pi_receivable = $1,476.38`, no corporate transfer occurs, and the variance classifier labels `sda_credit`. |
| 5.4-T3 | Given two full contractual payments collected during SDA, then a contractual-payment LAR with LPI +2 months is submitted by next BD 20:00 ET, Fannie Mae's recovery draft of $2,952.86 is matched, and `fm_pi_receivable` returns to zero before any servicer retention is booked. |
| 5.4-T4 | Given a completed payment deferral on an SDA loan, then all `advances` rows move to `reimbursed_by_fnma` within two cycles or an IRR package is escalated. |
| 5.4-T5 | Given a regular servicing option S/S loan six consecutive months delinquent, then no SDA is predicted, advances continue, and the deselection decision task is created on CD11 and due CD15. |
| 5.4-T6 | Given Fannie Mae's report shows Stop Advance for a loan we predicted as three months delinquent, then a sev-2 variance opens comparing LPI dates and the 5.1 reporting history. |
| 5.4-T7 | Given month-end Form 496 preparation, then Section II line 12 equals Σ Fannie Mae-reported outstanding P&I receivables for SDA loans with the standard explanation. |
| 5.4-T8 | Given a payoff of an SDA loan, then the payoff remittance includes Fannie Mae's outstanding P&I receivable and the servicer's advances are recovered from the payoff proceeds/borrower per the payoff calculator. |

#### Audit and evidence
Per-loan SDA timeline (prediction, Fannie Mae status dates, credits, recoveries, exits), `advances` ledger trail with funding source, matched report lines (document hashes), Form 496 line-12 schedule, decision records — retained `life_of_loan_plus_4y`; supports STAR custodial reviews and any FHFA/partner liquidity reporting on advance exposure.

### Open questions / decisions
1. **Boundary month for SDA entry** (is the period in which the loan becomes four months delinquent advanced?) — default: model four advanced periods (months 1–4) and treat Fannie Mae's Start Date as authoritative; confirm at onboarding.
2. **Advance funding source and cost allocation** — default: partner's advance line; Supermortgage tracks and reconciles.
3. **Excess servicing strip during SDA** — default: continue to compute and remit; confirm draft mechanics.

### Sources
- C-3-01 (03/11/2026): https://servicing-guide.fanniemae.com/svc/c-3-01/responsibilities-related-remitting-pi-funds-fannie-mae (verified 2026-09-09)
- F-1-20 (03/11/2026): https://servicing-guide.fanniemae.com/svc/f-1-20/remitting-and-accounting-fannie-mae (verified 2026-09-09)
- SVC-2026-02 (Mar. 11, 2026): https://singlefamily.fanniemae.com/news-events/announcement-svc-2026-02-servicing-guide-update ; TENA summary: https://www.tenaco.com/fannie-mae-issues-servicing-guide-announcement-svc-2026-02/ (verified 2026-09-09)
- SDA webinar deck (2020): https://singlefamily.fanniemae.com/media/23301/display ; SDA Form 496 job aid (10/4/2023): https://singlefamily.fanniemae.com/media/document/pdf/principal-and-interest-pi-custodial-reconciliation-form-496-stop-delinquency-advance-process (verified 2026-09-09)
- LL-2020-08 (historical): https://servicing-guide.fanniemae.com/THE-SERVICING-GUIDE/Lender-Letter/1966859241/LL-2020-08-Changes-to-Servicer-Principal-and-Interest-Advance-Requirements.htm (verified 2026-09-09 via research/00a §3.7)
- A1-3-06 (10/13/2021): https://servicing-guide.fanniemae.com/svc/a1-3-06/automatic-reclassification-mbs-mortgage-loans ; F-1-25 (12/20/2023): https://servicing-guide.fanniemae.com/svc/f-1-25/reclassifying-or-voluntary-repurchasing-mbs-mortgage-loan (verified 2026-09-09)
- Investor Reporting Manual (Apr. 8, 2026) pp. 26–27, 37 (verified 2026-09-09)
