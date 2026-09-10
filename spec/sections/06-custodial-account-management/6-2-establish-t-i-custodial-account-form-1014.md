# 6.2 — Establish T&I custodial account (Form 1014)

| Attribute | Value |
|---|---|
| Section | 6 — Custodial Account Management |
| Automation class | c |
| Trigger & frequency | On new arrangement (also: new sub-account for loss drafts / unapplied / buydown; depository change; entity-name change) |
| Governing source | FNMA A2-1-07 |
| Key deadlines | Before servicing |
| Timers | `FNMA_A4102_TI_INTEREST_DISBURSE_30`, `FNMA_C1101_DEPOSIT_CUSTODIAL_24H`, `FNMA_F103_BOARDING_ESCROW_DEPOSIT_1BD`, `FNMA_F103_FORM1014_IN_EFFECT_GATE`, `STATE_ESCROW_INTEREST_CREDIT_RECUR` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Custodial |
| Trigger & frequency | On new arrangement (also: new sub-account for loss drafts / unapplied / buydown; depository change; entity-name change) |
| Governing source (blueprint) | FNMA A2-1-07 |
| Key deadlines (blueprint) | Before servicing |
| Data/artifacts | Form 1014 |
| Systems | Custodial bank |
| Automation class (blueprint) | c |
| SoR / Sub | [cropped in source] — reconstructed: Supermortgage establishes; partner authorizes (Form 101) |
| Nuances (blueprint) | [cropped in source] — reconstructed: one T&I account may serve all remittance types; optional separate accounts for loss drafts, unapplied funds, buydown, rental income; interest on escrow to borrowers where state law requires; never commingle with P&I or corporate funds |

### Verified requirement (as of 2026-09-09)

**Structure and permitted contents (A4-1-02, 07/12/2023).** The servicer may "commingle T&I escrow for all Fannie Mae remittance types in single account, or establish multiple T&I accounts per remittance type," and may "establish separate accounts for insurance loss drafts, partial payments, rental income, or unapplied (suspense) funds." "T&I funds must not commingle with P&I, servicer's corporate funds, or funds for other investors." Eligible deposits: escrow deposits; servicer advances for foreclosure-related expenses and delinquent-loan T&I; buydown funds not yet scheduled for application; and "unapplied (suspense) payments pending proper application determination, including partial payments, insurance loss drafts, payment overages/shortages, rental income." The depository eligibility, on-demand availability, no-investment and clearing-account rules of 6.1 apply identically. F-1-03 (05/13/2026) titling for T&I, verbatim: "(Name of servicer), as agent and/or trustee for the benefit of Fannie Mae and payments of various mortgagors, respectively (Custodial Account)." Authorized withdrawals (F-1-03): pay taxes and insurance premiums when due; apply buydown funds when due; refund escrow surpluses or pay interest; remove erroneously deposited amounts; remove funds due borrowers; reimburse T&I servicing advances from subsequent payments once the loan becomes current; reduce arrearages for Flex Modifications; clear and terminate the account. Boarding: deposit borrower escrow balances and buydown funds "within one business day after receiving purchase proceeds" (Fannie Mae may waive for third-party collection agents with adequate controls). (URLs as in 6.1, verified 2026-09-09.)

**Interest (A4-1-02, verbatim).** "Within 30 days after interest is credited to the T&I account, the servicer must disburse it from the account, paying any interest related to escrowed funds (less administrative expenses related to maintenance of the account) to the borrower where required by applicable law and/or contract." "The servicer must pay any expenses, losses, damages, or withdrawal penalties sustained because the borrower's escrow funds were not in a demand deposit account." State interest-on-escrow statutes (NY, CA, MN, UT, ME, CT, MD, MA, OR, VT, RI and others per 00a §5.5) apply to a nonbank subservicer regardless of the OCC's 2026 preemption rules; Fannie Mae B-1-01 requires paying escrow interest where state law requires (cross-ref 3.9, which owns the rate computation). Note only: several states also require escrow funds to be held in trust/segregated accounts under their servicer-licensing laws; the Fannie Mae titling already satisfies a "trust for the benefit of borrowers" reading in most of them, but the licensing program (00a §5) must confirm state-by-state **[UNVERIFIED — state trust-account statutes not individually checked]**.

**Federal overlay.** Reg X §1024.34(a): "the servicer shall make payments from the escrow account in a timely manner, that is, on or before the deadline to avoid a penalty" (owned by 3.7); §1024.34(b)(1): "within 20 days (excluding legal public holidays, Saturdays, and Sundays) of a borrower's payment of a mortgage loan in full, a servicer shall return to the borrower any amounts remaining in an escrow account" (owned by 3.5; executed in **16.2**, not 12.x; the T&I account is the funding source). eCFR current as of 2026-09-03. Reg Z §1026.36(c)(1)(ii) (suspense funds disclosure and application) governs the unapplied sub-balance (6.5).

**Form 1014 mechanics (CBAM User Guide, 5.27.26).** Same workflow as Form 1013; "Form 1014 allows for selection of multiple remittance types," so one form covers a single T&I account serving A/A, S/A and S/S loans. Separate forms per account if separate loss-draft/unapplied/buydown accounts are opened (F-1-03: "separate Form 1013 or Form 1014 for each custodial account established"). Interest-bearing checkbox on the form. Mandatory via CBAM since Aug. 1, 2026.

**Servicing Guide escrow-event overlay (LL-2026-05; Escrow Reporting CIT Plan v2.2, 09/01/2026).** From Dec. 1, 2026 the acting servicer reports escrow setup/deposit/disbursement events by category (Taxes & Insurance, Loss Draft, Buy Down, Renovation) and attests monthly, through the UI only, to the "escrow ending balance, total loan count, and the sum of the escrow contractual payment amounts"; the window "will open on BD3 of Month 2 and close on BD2 of Month 3." The T&I custodial composition (6.4) must therefore be structured by these same categories so that custodial cash, the escrow trial balance and the attested Fannie Mae balance can be tied out.

**Discrepancies with the blueprint row.** (a) Source should be A4-1-02 + F-1-03 (+ A2-1-07); (b) "Systems: Custodial bank" omits CBAM (mandatory) and Technology Manager/Form 101; (c) the row does not mention the 30-day interest-disbursement rule, the multi-remittance-type option, or the optional sub-accounts that make 6.5 and 9.7 auditable.

### Operational prerequisites
- Everything in 6.1 (approval, Form 101, TM role, depository, signature authority).
- **Sub-account design decision** (see Open questions): default = one main T&I account + one `ti_unapplied` account + one `ti_loss_draft` account, all on one Form 1014 each.
- **State escrow-interest parameters** loaded in `jurisdiction_rules` (rate rule, accrual basis, payment frequency, exemptions) — Supermortgage compliance; before first boarding (3.9).
- **Disbursement rails** from the T&I account: positive-pay check issuance (tax/insurance payees), ACH credit origination (borrower refunds), wire (tax-service bulk payments) — treasury; 4–8 weeks (3.7, 9.x own the payees).
- **Bank interest statement** configured as a BAI2 type-code or camt.053 `BkTxCd` the parser can isolate (interest credit) — treasury.

### Build spec
#### Inputs and triggers
- `subservicing.arrangement.created` → plan T&I accounts (all remittance types on one Form 1014 unless the partner contract requires per-type separation).
- `custodial.form.in_effect` (1014) → activate; `escrow.account.boarded`/`loan.boarded` → gate check that a T&I account is active before the first escrow deposit.
- `custodial.interest.credited` (from statement parsing: BAI2 detail codes in the interest family or camt.053 `BkTxCd` `ACMT/…/INTR` **[bank-specific mapping; UNVERIFIED]**) → 30-day disbursement timer.
- `custodial.depository.ineligible_detected` → replacement workflow (as 6.1).
- `escrow.attestation.window_opened` (5.x; BD3 of M+1) → 6.4 tie-out must be complete first.

#### Data model
Reuses `depositories`, `custodial_accounts` (`account_kind` ∈ {ti, ti_unapplied, ti_loss_draft, ti_buydown}; `remittance_types text[]` for the form), `custodial_forms` (`form_type = 1014`). Adds:

| Table | Key fields |
|---|---|
| `custodial_interest_credits` | `id`, `custodial_account_id`, `bank_statement_line_id`, `credited_on date`, `amount_cents bigint`, `admin_expense_cents bigint` (documented bank fees attributable to the account in the period), `disposition` ∈ {pending, to_borrowers, to_corporate, mixed}, `disbursed_on`, `allocation_document_id`, `timer_id` |
| `escrow_interest_allocations` | `interest_credit_id?`, `loan_id`, `state`, `statutory_amount_cents`, `period_start`, `period_end`, `posted_ledger_entry_id` — produced by 3.9; referenced here to prove the 30-day disbursement |

Ledger accounts per T&I account: `custodial_ti_cash:<id>` (asset), with sub-ledger control accounts `escrow_liability` (sum of `escrow_accounts.balance`, positive and negative), `escrow_advances` (asset, corporate; negative escrow balances funded), `loss_draft_liability`, `buydown_liability`, `suspense_liability`, `interest_payable_borrowers`, `interest_due_corporate`. Retention `life_of_loan_plus_4y`; PII: none at the account level (loan-level joins carry PII under existing controls).

#### State machine
Identical to 6.1 for account and form. Additional guard on `active`: `remittance_types` on the executed Form 1014 must be a superset of the remittance types in the portfolio (a loan whose remittance type is not on the form cannot have escrow deposited — gate `FNMA_F103_FORM1014_IN_EFFECT_GATE`).

#### Timers and gates
| Code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_F103_FORM1014_IN_EFFECT_GATE` | not_before_gate | `custodial.account.planned` (ti) | n/a | opens on `custodial.form.in_effect` with matching remittance types | — | blocks `escrow.deposit.initiated`, `suspense.item.created` (cash side) |
| `FNMA_A4102_TI_INTEREST_DISBURSE_30` | deadline | `custodial.interest.credited` | bank credit date | 30 calendar_days, 17:00 local | `custodial.interest.disbursed` (all of the credit moved out: borrower allocations posted and/or corporate sweep) | `officer`, medium; the amount stays in the composition "Other" line with aging until cleared |
| `FNMA_F103_BOARDING_ESCROW_DEPOSIT_1BD` | deadline | `transfer_in.purchase_proceeds.received` / `transfer_in.funds.received` (1.6) | receipt date | 1 business_days_servicer | `custodial.deposit.confirmed` (T&I) | `officer`, high |
| `FNMA_C1101_DEPOSIT_CUSTODIAL_24H` (defined in 2.1; mirrored in 6.1) | deadline | `payment.received` escrow portion / `loss_draft.received` / `suspense.item.created` | receipt | 24 hours, rolled to the next servicer business day 17:00 local when the 24-hour point falls on a non-business day (see 6.1 for the C-1.1-01 text and the interpretation) | `custodial.deposit.confirmed` | exception in daily recon |
| `STATE_ESCROW_INTEREST_CREDIT_RECUR` | recurring | `escrow.account.opened` in an interest state | per `jurisdiction_rules.escrow_interest.frequency` (annual/quarterly/at analysis) | jurisdiction override | `escrow.interest.credited` (3.9) | `compliance-sentinel`; owned by 3.9, listed here because the cash leaves the T&I account |

Jurisdiction overrides: `STATE_ESCROW_INTEREST_CREDIT_RECUR` keyed by property state (e.g., NY GOL §5-601 2%; CA Civ. Code §2954.8 2%; MN Stat. §47.20 subd. 9 3%; per 00a §5.5 — rate details owned by 3.9).

#### Business rules and calculations
1. **Composition identity (enforced daily)**: `custodial_ti_cash` (ledger) = `escrow_liability` + `escrow_advances`(negative balances shown as advance) + `loss_draft_liability` + `buydown_liability` + `suspense_liability` + `interest_pending` + `other_reconciling`. Any residual ≠ 0 opens a reconciliation exception (6.4).
2. **Interest disposition**: on `custodial.interest.credited` with amount `I` cents: (a) compute `E` = documented administrative expenses for the account in the same statement period (bank analysis fees on that account only; never corporate overhead); (b) `to_borrowers` = Σ statutory escrow-interest obligations falling due in the window that the servicer elects to fund from `I` (3.9 computes the statutory amounts; those are owed whether or not `I` covers them); (c) `to_corporate = I − E − to_borrowers` if ≥ 0, else 0 with the shortfall funded from corporate (`servicer_advance_receivable` is *not* used — escrow interest is a servicer expense, ledger `corporate_expense_escrow_interest`). Round half-up to cents at each loan-level posting; the residual rounding difference (≤ 1 cent per loan) is absorbed by corporate.
3. **Worked example.** Bank credits `I = 123,456` cents ($1,234.56) on 2026-09-30 to the main T&I account; analysis fees for September on that account `E = 4,500` cents. 3.9 reports statutory interest due for the September accrual on 312 NY loans totaling 98,765 cents (each loan's amount computed as `round_half_up(avg_daily_balance × 0.02 × days/365)`; e.g., a $4,812.33 average balance for 30 days → 481,233 × 0.02 × 30 / 365 = 791.06… → 791 cents). Disposition: `to_borrowers = 98,765`, `to_corporate = 123,456 − 4,500 − 98,765 = 20,191` cents ($201.91). The agent posts 312 escrow credits (Dr `interest_payable_borrowers`/Cr `escrow_liability` per loan), transfers $45.00 to corporate for fees and $201.91 to corporate as interest, all by 2026-10-30 (`due_at = 2026-09-30 + 30 days = 2026-10-30T17:00 local`). Escrow event reporting (5.x) emits a deposit event of 791 cents (category Taxes & Insurance, "interest credit" reason) for each loan on the posting date.
4. **Loss drafts and buydown funds** are never netted against escrow shortages; they sit in their own control accounts (and, by default, own bank sub-accounts) so that Form 496A lines 3 and 5 are read straight from the ledger.
5. **Negative escrow balances** (advances) are reported as a positive "Advance to Cover Overdrafts" amount (Form 496A line 2) and the T&I Funds line is the *net* of positive and negative balances per the form instructions; the ledger keeps them separate and the projection nets them.

#### Integrations
- **CBAM** — `human_portal_task` package identical to 6.1 with `form_type = 1014`, `remittance_types = [A/A, S/A, S/S]`, sub-account purpose in the internal notes (the form has no purpose field; the title is the same for all T&I accounts, so the registry carries the purpose).
- **Depository** — sub-accounts opened under the same title; statement feed per account; positive pay for tax/insurance checks; ACH credit origination profile (borrower refunds, SEC code PPD) via the `nacha` adapter; wire template for tax-service bulk payments (dual approval: agent-prepared, `officer` releases above threshold — see 3.7).
- **Tax service / insurance tracking / LPI vendors** (3.7, 9.x) draw on the T&I account; this section only validates that every debit on the statement maps to a `disbursements` row within 1 BD.
- **Fannie Mae Servicing Platform (escrow events + attestation UI)** — owned by 5.x; 6.4 supplies the balances.

#### Outputs and artifacts
Executed Form 1014 PDF(s) in `documents`; `custodial_accounts` rows; interest-disposition memo per credit (`documents`, template `CUST-TI-INT-DISP-v1`, citation A4-1-02) listing the allocation and the 30-day evidence; per-loan escrow interest credits appear on the annual escrow statement (3.3) and periodic statement (7.1) — no separate notice. Partner notice `PARTNER_CUSTODIAL_ACCOUNT_ACTIVATED`.

#### AI agent design (AI-first)
`custodial-recon` agent (same tools as 6.1 plus `ledger.post`, `escrow.read_balances`, `jurisdiction.read`). End-to-end: plan, package, gate, activate, then own the interest-disposition cycle and the daily composition identity. Escalations: `fnma_portal_operator` (CBAM), `officer` (DocuSign; interest disposition when `to_borrowers > I − E`, i.e., corporate must fund; any sweep to corporate above $10,000 per credit — policy threshold), `human_agent` never (no borrower contact in this process). Decision record adds `{interest_credit_id, E, to_borrowers, to_corporate, loan_count, jurisdiction_rule_versions}`. Guardrail: the agent may not move T&I funds to any account that is not `custodial_ti_*`, a borrower's verified refund destination, a payee on an approved disbursement, or the corporate interest/fee account — enforced by the ledger's allowed-transfer matrix, not only by prompt.

#### Edge cases and failure modes
- Bank posts interest net of fees or as one combined line → parser flags `interest_ambiguous`; agent requests the analysis statement; 30-day timer still runs from the credit date.
- Interest credited to the wrong sub-account (loss-draft account) → treat as erroneous deposit (F-1-03 authorized withdrawal), move within 1 BD, keep the audit trail.
- Loan transfers out mid-period: escrow balance and accrued statutory interest go with the loan (1.x/17.x — transfer-out, not 12.x); the T&I composition drops the loan on the transfer date; interest credit received afterwards is corporate's (no borrower obligation).
- Bankruptcy/SCRA: no effect on custody; escrow interest obligations continue.
- Disaster loss drafts: large balances aged ≥ 7 months must be explained on Form 496A Section III (6.4).
- Vendor outage on the disbursement rail → cash stays in T&I; Reg X §1024.34(a) penalty risk handled by 3.7 (advance by wire from corporate if needed, then reimburse from T&I when rail restored).
- Escheatable refunds (uncashed escrow-refund checks) stay in T&I until remitted to the state (6.5).

#### Test cases and acceptance criteria
- 6.2-T1 Given a Form 1014 In Effect for {A/A, S/A} only, when an S/S loan boards with escrow, then the deposit is blocked by `FNMA_F103_FORM1014_IN_EFFECT_GATE` and a Change/Replace task is created.
- 6.2-T2 Given interest of $1,234.56 credited 2026-09-30 with $45.00 fees and $987.65 statutory interest, when disposed, then postings equal $987.65 to borrowers, $45.00 fees, $201.91 corporate, timer satisfied on the final posting; cashbook composition returns to zero "interest pending."
- 6.2-T3 Given the same credit but statutory interest of $1,300.00, then `to_corporate = 0`, corporate funds $110.44 (1,300.00 − (1,234.56 − 45.00)), and an `officer` escalation records the funding.
- 6.2-T4 Given no disposition by day 30, then breach → `officer` medium and the amount appears as an aged "Other" item on Form 496A.
- 6.2-T5 Given a NY loan with $4,812.33 average balance for 30 days, then the statutory credit is 791 cents (rounding half-up from 791.06).
- 6.2-T6 Given a debit on the T&I statement with no `disbursements` match within 1 BD, then exception `unmatched_debit` opens with severity high and the bank's positive-pay exception list is pulled.

#### Audit and evidence
As 6.1, plus: interest-credit ledger trail, allocation memo, jurisdiction rule versions, timer history for the 30-day rule; daily composition-identity results; evidence that loss-draft/unapplied/buydown funds are segregated (statement headers per sub-account).

### Open questions / decisions
1. Sub-account layout. Default: three T&I bank accounts (main, unapplied, loss drafts); buydown funds in main with a ledger control account (volumes are small).
2. Whether escrow interest owed under state law is paid from bank interest or always from corporate. Default: statutory obligations accrue regardless; bank interest is a funding source first, corporate second (rule 2).
3. Administrative-expense netting ("less administrative expenses") — take or waive? Default: take only bank analysis fees on the T&I account itself; never take where state law forbids netting **[state-by-state check owned by 3.9]**.
4. Whether to split T&I by remittance type for the partner's convenience. Default: no (single account, multiple remittance types on one Form 1014).

### Sources
- A4-1-02, F-1-03, A2-1-07, CBAM User Guide, SVC-2026-04 (as in 6.1) — verified 2026-09-09
- 12 CFR 1024.34: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.34 — eCFR current as of 2026-09-03, verified 2026-09-09
- 12 CFR 1026.36(c): https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-E/section-1026.36 — eCFR current as of 2026-09-04, verified 2026-09-09
- Escrow Reporting CIT Plan v2.2 (09/01/2026): https://singlefamily.fanniemae.com/media/44271/display — verified 2026-09-09
- Research 00a §5.5 (interest-on-escrow states, OCC preemption limits) and §1.3.
