# 6.4 — T&I custodial reconciliation (Form 496A)

| Attribute | Value |
|---|---|
| Section | 6 — Custodial Account Management |
| Automation class | b |
| Trigger & frequency | Monthly per T&I account (daily three-way engine feeds it) |
| Governing source | FNMA F-1-20 |
| Key deadlines | 45 days after month-end |
| Timers | `FNMA_A4102_TI_INTEREST_DISBURSE_30`, `FNMA_F496A_LOSS_DRAFT_AGED_7M`, `FNMA_F496A_TI_RECON_45`, `FNMA_LL202605_ESCROW_ATTEST_BD2_M2`, `SM_F496A_BEFORE_ATTESTATION_GATE`, `SM_F496A_DRAFT_BD10`, `SM_STALE_CHECK_180`, `SM_TI_ESCROW_ADVANCE_FUND_1BD`, `SM_TI_OUTSTANDING_CHECK_90` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Custodial |
| Trigger & frequency | Monthly per T&I account (daily three-way engine feeds it) |
| Governing source (blueprint) | FNMA F-1-20 |
| Key deadlines (blueprint) | 45 days after month-end |
| Data/artifacts | Form 496A |
| Systems | Custodial bank |
| Automation class (blueprint) | b |
| SoR / Sub | [cropped in source] — reconstructed: Supermortgage prepares/reviews/retains; partner receives package; Fannie Mae on request |
| Nuances (blueprint) | [cropped in source] — reconstructed: one 496A per T&I account (incl. loss-draft/unapplied sub-accounts); composition lines: T&I funds (net), advances to cover overdrafts, loss drafts, unapplied funds, buydown, other; loss drafts aged ≥ 7 months must be explained; must tie to the escrow balances attested to Fannie Mae from Dec. 1, 2026 |

### Verified requirement (as of 2026-09-09)

**Guide.** F-1-03 (05/13/2026): use Form 496A for each T&I account to "reconcile each T&I custodial account, document unapplied funds that need resolution, and reflect the composition of the cash book balance"; retain each month's reconciliation for Fannie Mae's request. A4-1-01 (02/12/2025): written procedures for "actively identifying and monitoring all unapplied funds held in a T&I custodial account until resolution" (detailed in 6.5). A4-1-02: T&I may hold escrow deposits, T&I servicer advances, buydown funds not yet applied, and unapplied/suspense funds including partial payments, loss drafts, overages/shortages and rental income; interest disbursed within 30 days of credit (6.2).

**Form 496A instructions ("Completing the Taxes and Insurance (T&I) Custodial Account Reconciliation (Form 496A)," © 2026).** "within 45 days after month end"; separate form monthly per T&I custodial account; retain with accounting records and provide upon request; supporting documentation: bank statement, cashbook, trial balance. Section I lines 1–7 as Form 496 (Depository Balance = "ending custodial account bank statement balance"; Difference "should always total $0.00"). Section II, verbatim: 1 "Taxes & Insurance Funds: Enter the net total of positive and negative individual borrower escrow balances."; 2 "Advance to Cover Overdrafts: Enter the total funds advanced by the servicer to cover all individual borrowers' negative escrow balances."; 3 "Insurance Loss Drafts Funds: Enter the insurance loss draft funds maintained by the servicer."; 4 "Unapplied Funds: Enter the unapplied/suspense funds (partial payments, etc.) maintained by the servicer."; 5 "Buydown Funds: Enter the total buydown funds maintained by the servicer."; 6 "Other (Explain): Any adjustments made to the Composition of Cashbook must include loan number, root cause, amount, and aging."; 7 Total (matches system of record; feeds Section I). Section III: deposits in transit, disbursements in transit and depository adjustments with Fannie Mae loan numbers, root causes, aging and amounts; "Insurance loss drafts aged seven months or greater require loan number, age in months, amount, and explanation for non-disbursement." (URL: https://singlefamily.fanniemae.com/media/23536/display, verified 2026-09-09.)

**Escrow event reporting and attestation (LL-2026-05; CIT Plan v2.2, 09/01/2026).** From Dec. 1, 2026 the acting servicer reports escrow setup, deposit and disbursement events by category (Taxes & Insurance, Loss Draft, Buy Down, Renovation) with "prior balance + item = reported balance" validation (negative balances only for T&I) and attests monthly in the UI to "escrow ending balance, total loan count, and the sum of the escrow contractual payment amounts," indicating "No" with commentary where Fannie Mae's values don't align; window opens BD3 of Month 2 and closes BD2 of Month 3. The Form 496A composition and the attested balances derive from the same escrow trial balance; a variance between them is a reportable exception.

**Federal/state overlay (note only).** Reg X §1024.17(k) requires the servicer to make escrow disbursements on time even when the borrower's escrow balance is insufficient (advance) — owned by 3.7 and the reason "Advance to Cover Overdrafts" exists; §1024.34(b)(1) escrow refund after payoff within 20 days excluding legal public holidays, Saturdays and Sundays (**16.1/16.2**; timer defined in 3.5; compliance layer 7.6); Reg Z §1026.36(c)(1)(ii) suspense disclosure (7.1) and application on accumulation (2.2). State interest-on-escrow (3.9) and state unclaimed-property law for stale refund checks (6.5).

**Discrepancies with the blueprint row.** (a) Source is F-1-03 + Form 496A instructions (not F-1-20). (b) "Systems: Custodial bank" omits the escrow trial balance (3.x), suspense (6.5), loss drafts (9.7) and, from Dec. 1, 2026, the Servicing Platform attestation (5.x). (c) The 7-month loss-draft aging explanation and the requirement to "document unapplied funds that need resolution" are hard content requirements absent from the row. (d) Automation "b" → fully automatable except the attestation UI (`fnma_portal_operator`) and policy approvals.

### Operational prerequisites
- Active T&I accounts and executed Forms 1014 (6.2); statement feeds; positive pay with outstanding-check file returns (issued/paid/void) from the bank; check-image retrieval for exceptions — treasury.
- Escrow trial balance projection with per-loan balances by category and per-loan negative-balance flags (3.x); suspense register (6.5); loss-draft register (9.7); buydown register (2.x) — all as of the ledger period close.
- Servicing Platform escrow-event channel and attestation UI access (5.x CIT complete; attestation role in TM) — partner CA + Supermortgage; before Dec. 1, 2026.
- Form 496A Excel template registered in `form_templates` with validated cell map **[template URL/cell map UNVERIFIED]**.
- Corporate funding rail for escrow advances (daily) — treasury.

### Build spec
#### Inputs and triggers
- Daily: as 6.3 (statement, intraday, ledger day-close) plus `disbursement.issued` / `disbursement.cleared` / `disbursement.voided` (3.7, 9.x, 3.5 refunds), `positive_pay.file_received` (issued/paid/exception lists), `escrow.balance.negative_detected` (3.x), `loss_draft.received` / `loss_draft.disbursed` (9.7), `suspense.item.*` (6.5), `buydown.funds.received/applied`.
- Monthly: `ledger.period.closed`, `custodial.statement.month_end_received`, `escrow.trial_balance.snapshot_taken` (3.x), `escrow.attestation.window_opened` (5.x).

#### Data model
Reuses 6.3 tables with `kind = monthly_form_496a` and adds:

| Table | Key fields |
|---|---|
| `ti_composition_snapshots` | `custodial_account_id`, `period_end`, `positive_escrow_cents`, `negative_escrow_cents` (stored positive), `advances_funded_cents`, `loss_draft_cents`, `unapplied_cents`, `buydown_cents`, `interest_pending_cents`, `other_cents`, `loan_count`, `contractual_escrow_payment_sum_cents`, `by_category json` (T&I, loss_draft, buydown, renovation), `source_snapshot_ids` |
| `outstanding_checks` | `disbursement_id`, `custodial_account_id`, `check_number`, `payee`, `issued_on`, `amount_cents`, `status` ∈ {outstanding, paid, voided, stale, reissued, escheated}, `paid_on`, `stale_on` (issued_on + 180 days policy), `positive_pay_status` |
| `escrow_attestation_runs` (owned by 5.x; referenced) | `period`, `fnma_ending_balance_cents`, `servicer_ending_balance_cents`, `loan_count_fnma`, `loan_count_servicer`, `contractual_sum_fnma`, `contractual_sum_servicer`, `aligned boolean`, `commentary`, `submitted_by`, `submitted_at` |

Category enum additions for `reconciliation_items.category`: `outstanding_check`, `stale_check`, `escrow_advance_unfunded`, `attestation_variance`, `loss_draft_aged_7m`, `unapplied_aged`.

#### State machine
Same as 6.3 monthly state machine, with an additional guard on `approved`: `attestation_variance` items must be either zero or explained with commentary text that will be used on the attestation screen; and every `loss_draft_aged_7m` item carries loan number, age in months, amount and explanation.

#### Timers and gates
| Code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_F496A_TI_RECON_45` | deadline | `ledger.period.closed` (per T&I account) | month-end | 45 calendar_days, 17:00 local (preceding BD if non-business); `warning_at` day 30 | `custodial.reconciliation.completed` (kind monthly_form_496a) | `officer`, critical; partner notified |
| `SM_F496A_DRAFT_BD10` | deadline (internal) | `ledger.period.closed` | month-end | 10 business_days_servicer | `custodial.reconciliation.drafted` | `officer`, medium |
| `SM_F496A_BEFORE_ATTESTATION_GATE` | not_before_gate | `escrow.attestation.window_opened` | n/a | opens when the period's 496A is `under_review` or later with `attestation_variance` = 0 or explained | — | blocks the `human_portal_task` for attestation until the tie-out exists; `officer` if BD2 of M+2 − 3 BD is reached without it |
| `FNMA_LL202605_ESCROW_ATTEST_BD2_M2` | deadline (owned by 5.x; listed) | `escrow.attestation.window_opened` | BD3 of M+1 | closes BD2 of M+2 (business_days_fannie_et) | `escrow.attestation.submitted` | `officer`, critical |
| `FNMA_F496A_LOSS_DRAFT_AGED_7M` | deadline (flag) | `loss_draft.received` | receipt date | 7 months | `loss_draft.disbursed` (full) | item `loss_draft_aged_7m` with explanation required on Section III; `insurance-property` agent asked for status (9.7) |
| `SM_TI_ESCROW_ADVANCE_FUND_1BD` | deadline | `escrow.balance.negative_detected` (net new negative not covered by advances) | detection | 1 business_days_servicer | `custodial.advance.funded` | `officer`, high (other borrowers' escrow must not fund a shortfall) |
| `SM_TI_OUTSTANDING_CHECK_90` | deadline | `disbursement.issued` (check) | issued_on | 90 calendar_days | `disbursement.cleared` | research task (payee contact) |
| `SM_STALE_CHECK_180` | deadline | `disbursement.issued` (check) | issued_on | 180 calendar_days | `disbursement.cleared` or `disbursement.voided` | void via positive pay; reissue or route to 6.5 escheat workflow |
| `FNMA_A4102_TI_INTEREST_DISBURSE_30` | (from 6.2) | — | — | — | — | aged interest appears in "Other" |
| `SM_RECON_ITEM_AGE_30/60/90…`, `SM_CUSTODIAL_SHORTAGE_FUND_2BD` | (from 6.3) | — | — | — | — | — |

Jurisdiction overrides: `SM_STALE_CHECK_180` and downstream escheat timers take the property state / payee state dormancy rules (6.5).

#### Business rules and calculations
1. **Composition identity** (daily and at period close), all `bigint` cents: `cashbook = (P − N) + A + LD + U + BD + I + O` where P = Σ positive escrow balances, N = Σ |negative escrow balances|, A = advances funded by the servicer to cover negatives (A ≤ N; policy target A = N daily), LD = loss drafts held, U = unapplied/suspense, BD = buydown funds, I = interest pending disposition, O = other explained items. Section II: L1 = P − N; L2 = A; L3 = LD; L4 = U; L5 = BD; L6 = I + O (itemised); L7 = Σ. For sub-accounts (`ti_loss_draft`, `ti_unapplied`), the form for that account has only L3 or L4 populated plus L6.
2. **Advance rule**: negative escrow balances arise when 3.7 disburses beyond the borrower's balance (Reg X §1024.17(k)); corporate must fund `N − A` within 1 BD so that at any time cash ≥ P + LD + U + BD (no borrower's escrow funds another borrower's disbursement). Recovery of advances follows F-1-03 ("reimburse T&I servicing advances from subsequent payments once loan becomes current") via 3.6 shortage repayment.
3. **Outstanding checks** = disbursements in transit (Section I line 3) itemised with loan number (payee-level for bulk tax payments, with the loan list attached). Stale after 180 days (policy; state UCC §4-404 lets banks refuse checks > 6 months **[general knowledge; UNVERIFIED]**): void through positive pay, restore the funds to the originating balance (escrow, refund payable), then reissue (if the payee is confirmed) or enter 6.5's unclaimed-property track.
4. **Attestation tie-out**: `servicer_ending_balance` (by category) reported on the attestation must equal `by_category` in `ti_composition_snapshots`; any difference vs Fannie Mae's computed balance is `attestation_variance` with root cause (rejected events, late events, category misclassification) and is answered "No" + commentary on the UI (CIT plan). Loan count and Σ contractual escrow payments come from `escrow_accounts` active at period end.
5. **Worked example — main T&I account, September 2026** (loss drafts and unapplied held in sub-accounts). Escrow trial balance: P = $8,612,004.11 (861,200,411 cents) across 4,210 loans; N = $38,950.12 (23 loans); A = $38,950.12 (all funded); BD = $12,300.00; I = $201.91 (interest credited 9/30, disposition pending, aging 0); O = $0. Composition: L1 = 861,200,411 − 3,895,012 = 857,305,399; L2 = 3,895,012; L3 = 0; L4 = 0; L5 = 1,230,000; L6 = 20,191; L7 = 857,305,399 + 3,895,012 + 0 + 0 + 1,230,000 + 20,191 = 862,450,602 cents ($8,624,506.02). Bank: closing ledger $8,808,946.90; Section III deposits in transit $31,200.00 (ACH batch 9/30, 112 loans); disbursements in transit (outstanding checks) $215,640.88 (37 checks, oldest issued 8/14, none stale); adjustments $0. Adjusted depository = 880,894,690 + 3,120,000 − 21,564,088 = 862,450,602 cents → Difference $0.00. Attestation for September (window opens BD3 Oct = Mon 2026-10-05, closes BD2 Nov = Tue 2026-11-03): T&I category ending balance $8,573,053.99 (net), loan count 4,210, Σ contractual escrow payments $1,911,432.50 — must match the platform's values; Loss Draft category from the sub-account's 496A ($121,500.00, 9 loans, one aged 8 months → Section III explanation: "contractor final inspection pending; borrower notified 9/12"). Deadline: 9/30 + 45 = Sat 11/14 → internal `due_at` Fri 11/13 17:00.
6. **Rounding**: none in this process (sums of cent-exact balances); statutory escrow interest rounding is 3.9's.

#### Integrations
- Depository statement/intraday feeds and positive pay (issued/paid/void/exception files; check images on demand) — as 6.3, plus outbound "issued check" files daily and "void" instructions (bank-specific formats **[UNVERIFIED]**).
- `nacha` adapter for borrower refunds (PPD credits) and escrow-advance transfers from corporate (CCD/book transfer).
- Tax service / insurance vendors (3.7, 9.x) — this process only consumes `disbursements` and clears them against bank debits.
- Fannie Mae Servicing Platform (escrow events, API/B2B; attestation UI portal-only → `human_portal_task` with package: period, per-category balances, loan count, Σ contractual payments, variance commentary, screenshots to capture after submission) — owned by 5.x, gated here.
- Partner: monthly 496A package delivery; alerts for unfunded escrow advances > 1 BD and attestation variances.

#### Outputs and artifacts
Form 496A workbook + PDF per T&I account; Section II/III support (escrow trial balance by loan and category, negative-balance list with advance evidence, outstanding-check register, loss-draft aging with explanations, unapplied register from 6.5, interest disposition memo); ledger postings (advances, voids/reissues, reclasses, interest); attestation commentary text; MORA package as in 6.3 with the escrow attestation confirmation added. No borrower notices from this process (statements from 7.1/3.3 disclose escrow and suspense balances).

#### AI agent design (AI-first)
`custodial-recon` (preparer) with `escrow.read_trial_balance`, `suspense.read`, `loss_draft.read`, `positive_pay.read/void`, `ledger.post_advance` (corporate → T&I only), `form496a.generate`; `qc-audit` (reviewer) recomputes the composition from the escrow ledger independently and re-ages every loss draft and check. Escalations: `fnma_portal_operator` (attestation UI, positive-pay portal actions if the bank lacks file support), `officer` (funding tiers as 6.3; any month where P − N + A ≠ cash after in-transit; approval flag), `insurance-property` agent (not human) for aged loss drafts; `human_agent` is never needed. Decision record adds `{composition_snapshot_id, attestation_variance_cents, aged_loss_drafts[], stale_checks[]}`. Guardrail: the agent cannot move funds between borrowers' escrow balances; only corporate ↔ T&I and T&I → payee/borrower transfers exist in the allowed-transfer matrix. Human path when AI off: Reconciliation Workbench (6.3) with the 496A profile.

#### Edge cases and failure modes
- Bulk tax payment by wire for 1,900 loans issued 9/29, debited 10/1 → single disbursement-in-transit line with the loan list attached (Section III accepts a batch reference plus attachment; the instruction asks for loan numbers, so the attachment lists them).
- Escrow event rejected by Fannie Mae (5.x) after the 496A is drafted → attestation variance with root cause "rejected deposit event, resubmitted 10/09"; the 496A itself is unaffected (cash is right).
- Loss draft held > 7 months because of a contractor dispute → explanation required every month until disbursed; 9.7 owns borrower communication.
- Uncashed escrow-refund check to a borrower who moved → stale at 180 days → void, funds back to `refund_payable`, skip-trace via `borrower-comms` (6.5), then unclaimed-property track.
- Transfer-out mid-month: escrow balances, unapplied funds and loss drafts wire to the transferee on the transfer date (1.x/17.x — transfer-out, not 12.x); the 496A shows the outgoing wire as a disbursement; loans dropped from the trial balance at the same cutoff.
- Bankruptcy: escrow balances of Chapter 13 debtors remain in T&I; post-petition escrow analysis rules do not change custody.
- Disaster: surge of loss drafts → sub-account balance spikes; aging monitor flags; no change to the identity.
- Bank returns an ACH refund (R03 no account) → funds re-credit T&I; reclass to `refund_payable` and re-attempt via check; item cleared same day.
- Vendor outage on positive pay → checks may be paid without match; agent reconciles paid-check file next day; any paid-not-issued item is a critical exception (fraud path).

#### Test cases and acceptance criteria
- 6.4-T1 Given the worked-example balances, when the monthly job runs, then L7 = $8,624,506.02, adjusted depository = $8,624,506.02, difference $0.00, xlsx/pdf generated and hashed.
- 6.4-T2 Given 23 negative escrow balances totaling $38,950.12 and advances funded $30,000.00 at day close, then `escrow_advance_unfunded` item $8,950.12 and `SM_TI_ESCROW_ADVANCE_FUND_1BD` starts; when corporate funds next BD, then cleared.
- 6.4-T3 Given a loss draft received 2026-02-14 still held on 2026-09-30, then `loss_draft_aged_7m` item (age 7 months) requires loan number, age, amount, explanation before `approved`.
- 6.4-T4 Given a refund check issued 2026-03-01 unpaid on 2026-08-28 (180 days), then status `stale`, void instruction sent, funds restored to `refund_payable`, 6.5 workflow opened.
- 6.4-T5 Given the servicer's T&I ending balance $8,573,053.99 and Fannie Mae's computed $8,571,803.99 (one rejected $1,250.00 deposit event), then `attestation_variance` item with commentary and the attestation package marks "No" with that text; the gate opens because the variance is explained.
- 6.4-T6 Given the attestation window BD3 Oct–BD2 Nov for September activity (Oct 5–Nov 3, 2026), then `FNMA_LL202605_ESCROW_ATTEST_BD2_M2.due_at` = 2026-11-03 17:00 ET; given no 496A draft by Oct 29 (3 BD before), then `officer` escalation.
- 6.4-T7 Given a paid check on the bank's paid file with no matching issued record, then critical exception, `fraud` case, bank claim within 1 BD.
- 6.4-T8 Given the 45-day deadline for 2026-09-30 → internal `due_at` 2026-11-13 17:00; on-time and breach behaviours as 6.3-T3.

#### Audit and evidence
As 6.3, plus: escrow trial balance snapshot hash, negative-balance/advance evidence, outstanding-check and stale-check registers, loss-draft aging explanations, attestation submission evidence (screenshots/confirmation from the portal operator with timestamps) and the gate history. Provides the servicing-criteria evidence for Reg AB/USAP (18.6) and the MORA custodial module (18.2).

### Open questions / decisions
1. Stale-check threshold — default 180 days (policy); some states' unclaimed-property triggers count from issuance (3 years typical), so 180 days only starts the internal reissue/skip-trace path.
2. Daily vs. weekly funding of negative escrow balances — default daily (1 BD) to keep the "no borrower funds another borrower" invariant.
3. Whether loss drafts and unapplied funds get separate bank accounts (6.2 default: yes) — affects the number of 496A forms (three per month).
4. Attestation ownership — default: `investor-reporting` agent prepares, `custodial-recon` gates, `fnma_portal_operator` submits.

### Sources
- Form 496A instructions (© 2026): https://singlefamily.fanniemae.com/media/23536/display — verified 2026-09-09
- Form 496A (Excel, binary; not parsed): https://singlefamily.fanniemae.com/media/7546/display — retrieved 2026-09-09
- F-1-03 (05/13/2026); A4-1-01 (02/12/2025); A4-1-02 (07/12/2023) — as above, verified 2026-09-09
- Escrow Reporting CIT Plan v2.2 (09/01/2026): https://singlefamily.fanniemae.com/media/44271/display — verified 2026-09-09
- LL-2026-05 (June 24, 2026) — as above
- 12 CFR 1024.34: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.34 — eCFR current as of 2026-09-03; 12 CFR 1026.36(c): https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-E/section-1026.36 — current as of 2026-09-04; verified 2026-09-09
