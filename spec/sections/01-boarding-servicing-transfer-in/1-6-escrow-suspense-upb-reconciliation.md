# 1.6 — Escrow/suspense/UPB reconciliation

| Attribute | Value |
|---|---|
| Section | 1 — Boarding / Servicing Transfer-In |
| Automation class | a |
| Trigger & frequency | On boarding |
| Governing source | Reg X 1024.17; 1024.35 |
| Key deadlines | Before first analysis |
| Timers | `FNMA_F1_11_FINAL_ACCOUNTING_30`, `LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1`, `REGX_1024_17E_INITIAL_ESCROW_STMT_60`, `REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60`, `SM_ADVANCE_REIMBURSE_TRANSFEROR_30`, `SM_ESCROW_COMPUTATION_YEAR_DECISION_30`, `SM_RECON_FNMA_POSITION_EOM`, `SM_RECON_LOAN_LEVEL_T0`, `SM_RECON_VARIANCE_SLA_5`, `SM_RECON_WIRE_MATCH_1`, `SM_UNAPPLIED_INHERITED_REVIEW_60` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Boarding |
| Trigger & frequency | On boarding |
| Governing source (blueprint) | Reg X 1024.17; 1024.35 |
| Key deadlines (blueprint) | Before first analysis |
| Data/artifacts | Recon reports |
| Systems | Core [cropped in source] |
| Automation class (blueprint) | [cropped in source] — treated as (a) with (b) for variance write-offs |
| SoR / Sub | [cropped in source] — Supermortgage performs; partner's servicer number and custodial titling |
| Nuances (blueprint) | [cropped in source] — reconstructed: F-1-11 funds transfer list, final accounting within 30 days, initial escrow statement if payment/method changes, Escrow Setup events, advances reimbursement |

### Verified requirement (as of 2026-09-09)

**F-1-11 (05/13/2026)**: "The transferor servicer must forward to the transferee servicer all P&I and T&I custodial account balances including, but not limited to, the following: unremitted P&I collections; escrow funds; unapplied funds; loss drafts; accruals on deposit—for example, for the payment of future renewal premiums for lender-purchased MI; and buydown funds." "If the transferor servicer has advanced delinquent interest or scheduled P&I to Fannie Mae, the transferee servicer must reimburse the transferor servicer once it receives a final accounting." The transferor delivers "trial balances, as of the close of business on the day immediately preceding the transfer date," "a copy of the custodial bank reconciliation for each custodial bank account maintained as of the cutoff date," "copies of all investor accounting reports that were filed with Fannie Mae for the three months that immediately precede the cutoff date," "a reconciliation of any outstanding shortage/surplus balance ... as of the last reporting period," and "escrow analyses." "In the month of the transfer date, the transferor servicer will be contractually responsible for reporting the monthly LAR for all mortgage loan activity ... and ensuring that sufficient funds to satisfy that month's remittance obligation are available"; "in the month following the transfer date, the transferee servicer will be responsible for reporting"; a shortage/surplus adjustment "must be requested within 30 days after the transfer date"; "the transferee servicer will be responsible for any Fannie Mae investor reporting system shortages related to mortgage loans included in the transfer that are not promptly resolved by the transferor servicer."

**A2-7-03**: the transferee must "understand borrower account histories (including the amount and nature of all servicing advances and fees assessed to the borrower) as of the transfer date" and "review its subsequent collection of funds from borrowers to ensure accurate accounting for recovery of advances charged to the borrower." **A2-1-07**: the subservicer's custodial accounts must be separate; MBS and portfolio funds not commingled; the master must ensure Fannie Mae receives the correct remittance regardless of subservicer remittance timing.

**Reg X §1024.17** (eCFR current as of Sept. 3, 2026): (c)(4) "All servicers must use the aggregate accounting method"; (e)(1) "If the new servicer changes either the monthly payment amount or the accounting method used by the transferor (old) servicer, then the new servicer shall provide the borrower with an initial escrow account statement within 60 days of the date of servicing transfer," using the transfer date to start a new computation year; otherwise the new servicer "may continue to use the escrow account computation year established by the transferor servicer or may choose to establish a different computation year using a short-year statement"; "the new servicer shall treat shortages, surpluses and deficiencies in the transferred escrow account according to the procedures set forth in §1024.17(f)"; (i)(4)(ii) "the transferor (old) servicer shall submit a short year statement to the borrower within 60 days of the effective date of transfer"; (f)(2) surplus ≥ $50 refunded within 30 days; (f)(3) shortage < 1 month may be collected in 30 days or spread over ≥12 months, ≥ 1 month spread over ≥12 months; (f)(4) deficiency rules. **§1024.35(b)**: covered errors include failure to apply an accepted payment (b)(2), failure to credit as of date of receipt (b)(3), failure to pay escrow items (b)(4), imposing fees without a reasonable basis (b)(5), and (b)(8) transfer-information failures. **§1024.38(c)(2)**: the servicing file must include "a schedule of all transactions credited or debited to the mortgage loan account, including any escrow account ... and any suspense account."

**LL-2026-05**: "Escrow Setup event for each applicable escrow item category type" for newly acquired loans (mandatory Dec. 1, 2026), then same-day deposit/disbursement events and monthly attestation. **Investor Reporting Manual (Apr. 8, 2026)** and research/00b F2/F3: LSDU Cash Position by servicer number × remittance type is the Form 496 source; A/A shortage/surplus (Form 472 Schedule 3) persists until the automatic P&I draft phase.

**Discrepancies vs blueprint**: (1) §1024.35 is a remedy, not a reconciliation rule — the operative reconciliation obligations are F-1-11 and A2-7-03; (2) "before first analysis" understates it: balances must be right at `loan.boarded` (cash) and before Supermortgage's first reporting cycle (Fannie Mae position), with the 60-day initial-statement clock only if the payment or method changes; (3) blueprint omits the 30-day final-accounting window and the transferee's liability for unresolved shortages.

### Operational prerequisites
- Supermortgage-owned P&I custodial accounts (one per remittance type; ≥2 for S/S) and T&I custodial account, titled "(Supermortgage) as subservicer for (Partner), as agent, trustee, and/or bailee for the benefit of Fannie Mae …," Forms 1013/1014 executed in CBAM (6.1/6.2) — established and owned by Supermortgage per A2-1-07, under the partner's servicer numbers and Form 101 authorization, with the partner executing where the form requires the servicer of record and remaining liable to Fannie Mae; before cutover. Transfer wires land in these Supermortgage accounts.
- Bank feeds (BAI2/camt.053) for custodial accounts and wire notification (research/00b N11) — Supermortgage; 2–4 weeks.
- Form 101 scope covering LSDU/Loan Position for the partner's servicer number (1.1) — both.
- Funds-transfer agreement with the transferor: wire dates (T+1 for balances as of T-1), interim payments forwarding, advances reimbursement mechanics and netting, interest on late wires — Partner (contract) / Supermortgage (operations).
- Escrow rule set: `jurisdiction_rules` interest-on-escrow parameters (3.9) and the platform's cushion policy (3.4) versioned before the first post-transfer analysis.

### Build spec
#### Inputs and triggers
- `transfer.tape.received{kind∈final,trial_balance,escrow_history,escrow_analysis,custodial_recon,investor_reports}` (1.1).
- `custodial.wire.received` (bank feed) with amount, sender, reference.
- `transfer.fnma_position.received` (LSDU/Loan Position) for UPB, LPI date, remittance type, cash position.
- `transfer.final_accounting.received` (transferor's post-transfer accounting incl. advances claimed and shortage/surplus).
- `payment.received{received_by='transferor'}` during the 60-day window (1.3) — affects in-transit reconciliation.
- Schedule: nightly reconciliation job until batch recon closes; monthly Form 496/496A (6.3/6.4).

#### Data model
- `reconciliations` (baseline) rows with `kind` enum {`boarding_loan_level`,`boarding_wire_pi`,`boarding_wire_ti`,`boarding_wire_other`,`boarding_fnma_position`,`boarding_final_accounting`}, `scope` (batch or loan), `source_a`, `source_b`, `difference_cents bigint`, `status` enum {open, balanced, balanced_with_variances, closed}.
- `recon_variances` (append-only): `reconciliation_id`, `loan_id null`, `field text` (upb, lpi_date, escrow_balance, unapplied, corporate_advances, escrow_advances, late_charges_due, nsf_fees, other_fees, deferred_principal, forborne_principal, buydown_balance, loss_draft_balance, mi_accrual, accrued_interest_dsi), `value_tape bigint`, `value_trial_balance bigint`, `value_fnma bigint null`, `value_wire bigint null`, `difference_cents bigint`, `category` enum {timing_in_transit, transferor_error, mapping_error, fnma_reporting_lag, unknown}, `owner`, `sla_timer_id`, `resolved_at`, `resolution` enum {transferor_corrected, adjusted_with_evidence, absorbed_by_transferor, absorbed_by_supermortgage, written_off_officer}, `evidence_document_id`.
- `transfer_funds_receipts`: `batch_id`, `custodial_account_id`, `kind` enum {`pi_unremitted`,`unapplied`,`escrow`,`loss_draft`,`buydown`,`mi_accrual`,`interim_forwarded_payments`,`advance_reimbursement_out`}, `expected_cents`, `received_cents`, `received_at`, `wire_reference`, `matched_at`, `variance_id null`.
- `escrow_analyses` seeded with `source='transferor'`, `analysis_date`, `computation_year_start`, `monthly_escrow_cents`, `cushion_cents`, `shortage_cents`, `surplus_cents`, `deficiency_cents`, `shortage_spread_months`.
- `ledger_accounts` additions: per batch `transfer_in_clearing` (memo/clearing); per custodial account `due_to_transferor` / `due_from_transferor`.
- Retention `life_of_loan_plus_4y` (Fannie Mae accounting records; Form 496 support retained per F-1-03).

#### State machine
Batch reconciliation: `awaiting_final_tape` → `loan_level_recon` → (`variances_open` ⇄) `loan_level_balanced` → `wires_expected` → `wires_matched` → `fnma_position_reconciled` → `final_accounting_received` → `advances_settled` → `closed`. Loan-level: `unreconciled` → `reconciled` / `variance` → `reconciled`. Boarding (`loan.boarded`) requires loan-level `reconciled` on all money fields between tape and trial balance; wires and the Fannie Mae position may close after boarding but before `active` (1.1). Transitions by the `custodial-recon` agent; `written_off_officer` requires `officer`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `SM_RECON_LOAN_LEVEL_T0` | not_before_gate | `loan.validated` | `transfer_date` | must be `reconciled` before `boardLoan` | `recon.loan.reconciled` | loan cannot board; `SM_BOARD_FIRST_CYCLE` pressure |
| `SM_RECON_WIRE_MATCH_1` | deadline | `transfer.batch.cutover_completed` | `transfer_date` | +1 business_days_servicer | `recon.wires.matched` (P&I by remittance type, T&I, other) | sev 1 → `officer`; shortfall demand to transferor |
| `SM_RECON_FNMA_POSITION_EOM` | deadline | `transfer.batch.cutover_completed` | last `business_days_fannie_et` of transfer month | 0 | `recon.fnma_position.balanced` | sev 1 → `investor-reporting`; first-cycle LAR/events at risk |
| `FNMA_F1_11_FINAL_ACCOUNTING_30` | deadline (transferor duty, monitored; transferee liable after) | `transfer.batch.cutover_completed` | `transfer_date` | +30 calendar_days | `transfer.final_accounting.received` and transferor's Fannie Mae adjustment request evidence | sev 1 → `officer`; Supermortgage prepares its own shortage analysis for Fannie Mae |
| `SM_ADVANCE_REIMBURSE_TRANSFEROR_30` | deadline | `transfer.final_accounting.received` | receipt | +30 calendar_days (contract default) | `ledger.posted{advance_reimbursement_out}` | sev 2 |
| `REGX_1024_17E_INITIAL_ESCROW_STMT_60` | deadline | `escrow.terms.changed_at_transfer` (payment amount or method changes) | `transfer_date` | +60 calendar_days | `notice.sent{NTC_REGX_1024_17G_INITIAL_ESCROW_STMT}` (3.1) | sev 1 → Compliance Sentinel |
| `SM_ESCROW_COMPUTATION_YEAR_DECISION_30` | deadline | `loan.boarded{escrowed}` | `transfer_date` | +30 calendar_days | `escrow.computation_year.decided` | sev 3 |
| `REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60` | deadline (transferor duty, monitored) | `transfer.batch.cutover_completed` | `respa_effective_date` | +60 calendar_days | `transfer.short_year_statement.copy_received` | sev 3; borrower inquiries routed with context |
| `LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1` | deadline | `loan.boarded` (defined in 1.1) | `boarded_at` | next business_days_fannie_et 03:00 ET | `investor_events.acked{type=EscrowSetup}` per category | sev 2 → `investor-reporting` |
| `SM_UNAPPLIED_INHERITED_REVIEW_60` | deadline | `loan.boarded{unapplied_cents>0}` | `transfer_date` | +60 calendar_days | `suspense.item.resolved` (6.5) | sev 3 |
| `SM_RECON_VARIANCE_SLA_5` | deadline | `recon.variance.raised` | raised_at | +5 business_days_servicer | `recon.variance.resolved` | sev 2 → `officer` if > $25/loan or > $5,000/batch |

Jurisdiction overrides: interest-on-escrow states — accrual restarts at the boarded balance from `transfer_date` using `jurisdiction_rules` (3.9).

#### Business rules and calculations
- Sources and precedence: loan-level balances come from the final tape and must equal the trial balance (exact, cents); the Fannie Mae position is authoritative for UPB/LPI date/remittance type as reported; wires must equal trial-balance totals by category; variances are categorized, never plugged.
- Escrow balance sign: positive balances are cash (T&I wire); negative balances are transferor escrow advances — receivables, not cash — recorded in `escrow_advances` and settled through the final accounting.
- Opening ledger postings at `loan.boarded` (per loan, balanced against `transfer_in_clearing`): Dr `principal` UPB / Cr clearing; Dr `deferred_principal`, `forborne_principal` / Cr clearing; Dr `corporate_advances`, `escrow_advances` / Cr clearing; Dr `late_charges` receivable, `nsf_fees`, `other_fees` / Cr clearing (memo receivables); Cr `escrow` (liability) / Dr `custodial_ti_cash` on wire match; Cr `suspense/unapplied` / Dr `custodial_pi_cash`; Cr `fnma_remittance_payable` for unremitted P&I collections / Dr `custodial_pi_cash`. Clearing must net to zero per batch when the position reconciliation closes.
- Worked example (three loans, cents): L1 UPB 24,563,412, escrow +184,250, unapplied 32,500, corporate advances 15,000, late charges due 6,464 (4% × 161,603 = 6,464.12 → round-half-up 6,464); L2 UPB 18,020,000, escrow −41,300 (transferor advanced taxes), unapplied 0; L3 UPB 31,100,055, escrow +92,015, unremitted P&I collected Sept. 29 of 205,800. Expected wires: T&I = 184,250 + 92,015 = **276,265** (L2's negative balance is a 41,300 `escrow_advances` receivable); P&I (A/A account) = unapplied 32,500 + unremitted P&I 205,800 = **238,300**. If the bank shows T&I 276,265 and P&I 238,000, a 300-cent P&I variance is raised (`unknown` → transferor query, SLA 5 business days). Scheduled interest check for L1 at 6.375%: 24,563,412 × 0.06375 / 12 = 130,493.13 → **130,493** cents.
- Fannie Mae position rule: Σ boarded UPB by servicer number and remittance type = LSDU position after the transferor's transfer-month LAR posts; timing lag is category `fnma_reporting_lag` and must clear by `SM_RECON_FNMA_POSITION_EOM`.
- Escrow continuity: if Supermortgage keeps the transferor's monthly escrow payment and aggregate method → no initial statement; keep the computation year (default) or issue a short-year statement (3.3). If the payment changes (e.g., Supermortgage's cushion policy differs, or a shortage spread is restarted) → initial escrow statement within 60 days and a new computation year from the transfer date. Shortages/surpluses inherited are treated under §1024.17(f): surplus ≥ $50 refunded within 30 days of the analysis that identifies it; shortage spread ≥ 12 months.
- Advances recovery: inherited `corporate_advances`/`escrow_advances` are recovered only per the note/security instrument and Fannie Mae reimbursement rules (15.2); the transferor is reimbursed only for amounts substantiated in the final accounting (F-1-11).
- Rounding: cents exact; percentages of P&I round half-up to cents at the fee-assessment step (2.7).

#### Integrations
- **Transferor SFTP** (final tape, trial balance, custodial recon, investor reports, final accounting) — 1.1 adapter.
- **`custodial-bank`** (BAI2/camt.053, wire advices) — inbound; idempotency by bank reference; unmatched wires go to 6.5.
- **`fnma-lsdu`** Loan Position/Cash Position (API where available; else LSDU CSV via `human_portal_task`) — read.
- **`fnma-servicing-events`** — Escrow Setup, and subsequently deposit/disbursement events (6.x/3.x).
- **Fannie Mae Connect** "Remittance Detail – P&I Report" for Form 496 (6.3).
- Failure: missing wire → demand letter to transferor drafted by the agent, `officer` signs; missing Fannie Mae position → escalate before first reporting cycle.

#### Outputs and artifacts
- Reconciliation reports (loan-level, wire, Fannie Mae position, final accounting) as `documents` with hashes; variance log; opening ledger entries; `escrow_analyses` seed; Escrow Setup investor events; initial escrow statement `NTC_REGX_1024_17G_INITIAL_ESCROW_STMT` (3.1) when required (mail or e-delivery only with Supermortgage-verified E-SIGN consent); first Form 496/496A including transferred balances (6.3/6.4).
- Records: `loan_events` `recon.loan.reconciled`, `recon.variance.raised/resolved`, `escrow.computation_year.decided`, `transfer.final_accounting.received`.

#### AI agent design (AI-first)
`custodial-recon` agent (tools: `loadTapeBalances`, `loadTrialBalance`, `loadBankFeed`, `queryFnmaPosition`, `matchWires`, `raiseVariance`, `classifyVariance`, `draftTransferorQuery`, `postOpeningEntries`, `writeDecision`) performs all matching and classification and posts opening entries when a loan reconciles; `escrow` agent decides computation-year treatment and triggers 3.1 when required; `investor-reporting` agent submits Escrow Setup events. Decision record: `{batch_id, loan_id?, field, values, difference_cents, category, action, confidence, rationale}`. Guardrails: the agent may adjust a balance only with transferor evidence (corrected tape/trial balance) or bank evidence; absorbing or writing off any variance requires `officer` approval (threshold: any amount for borrower-affecting fields; ≥ $25/loan or ≥ $5,000/batch for portfolio-level); no borrower contact from 1.6 (escrow statements are Notice Registry outputs). Human path: ops-console reconciliation workbench with the same variance queue.

#### Edge cases and failure modes
- Payments received by the transferor after the T-1 cutoff and before the wire: in-transit category; forwarded under 1.3 with receipt dates; must not double-count against the P&I wire.
- Transferor's transfer-month LAR rejects at Fannie Mae: position lag; Supermortgage cannot report until the transferor's data posts; escalate to partner; first-cycle events for the loans still due for activity from the transfer date.
- Loss drafts (open insurance claims): boarded as restricted escrow sub-ledger with the claim record (9.7); wire matched separately.
- Buydown funds: boarded to a buydown sub-account; Fannie Mae no longer holds temporary buydown funds (SVC-2026-02 per research/00a §2.2).
- Loans in bankruptcy: pre-/post-petition balances and trustee payments separated at boarding (14.1); unapplied funds may be post-petition suspense.
- SCRA 6% cap in effect: accrued interest recomputed from the cap effective date (13.9) before reconciliation is closed.
- Disaster forbearance: no late charges; suspense expectations adjusted.
- Successor in interest: no balance effect; contact routing only.
- Deferred/forborne balances not separated by the transferor: hard fail `HF-016`; loan cannot board until corrected (affects payoff and Fannie Mae reporting).
- Transferor insolvency (no final accounting): Supermortgage prepares the shortage analysis itself and files with Fannie Mae; transferee liability under F-1-11 noted to the partner.
- Retro corrections after close: reversal entries with reason, Fannie Mae loan-data-change/LAR corrections (5.1).

#### Test cases and acceptance criteria
- 1.6-T1 Given the three-loan example, when wires of 276,265 (T&I) and 238,300 (P&I) are received, then both wire reconciliations balance and L2 carries a 41,300 `escrow_advances` receivable.
- 1.6-T2 Given a P&I wire of 238,000, then a 300-cent variance is raised with SLA 5 business days and the batch cannot reach `wires_matched`.
- 1.6-T3 Given a tape UPB ≠ trial-balance UPB for a loan, then the loan cannot board (`SM_RECON_LOAN_LEVEL_T0`).
- 1.6-T4 Given Supermortgage keeps the transferor's escrow payment and method, then no initial escrow statement timer is created and the computation year is retained.
- 1.6-T5 Given Supermortgage changes the monthly escrow payment on Oct. 1, 2026, then `REGX_1024_17E_INITIAL_ESCROW_STMT_60` is due Nov. 30, 2026 and the new computation year starts Oct. 1, 2026.
- 1.6-T6 Given transfer date Oct. 1, 2026 and no final accounting by Oct. 31, then the timer breaches, an `officer` escalation exists and Supermortgage's own shortage analysis draft is produced.
- 1.6-T7 Given the Fannie Mae position still shows the transferor's pre-transfer UPB on Oct. 15 (LAR lag), then the variance is `fnma_reporting_lag` and must close by Oct. 30, 2026 (last Fannie Mae business day of October).
- 1.6-T8 Given a batch-level variance of $5,001 the agent proposes to absorb, then the command is refused without `officer` approval.
- 1.6-T9 Given an escrowed loan boarded after Dec. 1, 2026, then Escrow Setup events exist per category and are acked before `active`.
- 1.6-T10 Given L1's late charge of 4% on P&I $1,616.03, then the boarded receivable is $64.64.

#### Audit and evidence
All source files and hashes, matching results per loan and per wire, variance log with categories and evidence, opening ledger entries linked to `loan.boarded`, Fannie Mae position snapshots, final-accounting documents and reimbursement postings, escrow computation-year decisions, timers and `agent_decisions`; supports Form 496/496A, MORA and §1024.35(b)(2)–(5)/(b)(8) responses.

### Open questions / decisions
1. Variance materiality thresholds for `officer` approval (default: any borrower-affecting cent; $25/loan or $5,000/batch otherwise).
2. Default escrow continuity: keep the transferor's computation year and payment (default) vs re-analyze all loans at 90 days with short-year statements.
3. Advances reimbursement mechanics with the transferor: net against inherited unapplied/escrow-advance receivables (default) or gross settlement.
4. ~~Whether Supermortgage's custodial accounts or the partner's receive the transfer wires.~~ **Resolved (6.1; 1.2 decision 2): Supermortgage's**, matching Forms 1013/1014 as required by A2-1-07.

### Sources
- Reg X §1024.17 (eCFR current as of Sept. 3, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-B/section-1024.17
- Reg X §1024.35, §1024.38: see 1.1 sources.
- Servicing Guide F-1-11 (05/13/2026): https://servicing-guide.fanniemae.com/svc/f-1-11/post-delivery-servicing-transfers
- Servicing Guide A2-7-03 (05/13/2026); A2-1-07 (05/13/2026): see 1.2 sources.
- LL-2026-05 (June 24, 2026): see 1.1 sources.
- Investor Reporting Manual (Apr. 8, 2026): https://singlefamily.fanniemae.com/media/7816/display
- research/00b F2, F3, F10, N11; research/00a §2.2 (SVC-2026-02 buydown funds).
