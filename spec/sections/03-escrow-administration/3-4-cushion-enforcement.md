# 3.4 — Cushion enforcement

| Attribute | Value |
|---|---|
| Section | 3 — Escrow Administration |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On analysis |
| Governing source | Reg X 1024.17(c)(5) |
| Key deadlines | Cushion ≤ one-sixth (2 months) of estimated annual disbursements |
| Timers | `ESC_INHERITED_CUSHION_CHECK_10BD`, `REGX_1024_17C5_CUSHION_CAP_GATE`, `REGX_1024_17C6_PREACCRUAL_GATE` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Escrow |
| Trigger & frequency | On analysis |
| Governing source (blueprint) | Reg X 1024.17(c)(5) |
| Key deadlines (blueprint) | Cushion ≤ one-sixth (2 months) of estimated annual disbursements |
| Data/artifacts | Analysis |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Sub enforces; SoR liable |
| Nuances (blueprint) | [cropped in source] — reconstructed: instrument/state lower caps control; cushion optional; pre-accrual ban; aggregate low-point cap; multi-year items |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.17** (eCFR current as of Sept. 4, 2026):
- (c)(1)(i)–(ii): at settlement and during the life of the account the servicer may add "an amount to maintain a cushion no greater than one-sixth (1/6) of the estimated total annual payments from the account."
- (c)(5): "the cushion must be no greater than one-sixth (1/6) of the estimated total annual disbursements from the escrow account."
- (c)(6): "A servicer must not practice pre-accrual." (b) defines pre-accrual as requiring deposits "for a disbursement before the disbursement date" beyond what the trial-running-balance method allows.
- (c)(8): "The servicer must examine the federally related mortgage loan documents to determine the applicable cushion for each escrow account. If the loan documents provide for lower cushion limits, then the terms of the loan documents apply." If the documents allow greater payments than this section, "this section controls the applicable limits."
- (d)(1): the (d)(2) steps "result in maximum limits"; "a servicer may use accounting procedures that result in lower target balances"; "a servicer may use a cushion that is less than the permissible cushion or no cushion at all. This section does not require the use of a cushion."
- (d)(2)(i)(C): the cushion added in Step 3 is "two months of the borrower's escrow payments or a lesser amount specified by state law or the mortgage document (net of any increases or decreases because of prior year shortages or surpluses, respectively)." (d)(2)(ii): "the lowest monthly target balance … shall be less than or equal to one-sixth of the estimated total annual escrow account disbursements or a lesser amount specified by state law or the mortgage document."
- (c)(9): multi-year items — collect in equal monthly amounts across the cycle (36 for a 3-year premium); the low point will not be reached in some years and the statement must say so.
- 12 U.S.C. 2609(a)(1)–(2): statutory 1/6 reserve ceiling at settlement and monthly.

**Fannie Mae**: B-1-01 sets no cushion policy (defers to "applicable law" and the loan documents); the uniform security instrument Section 3 lets the lender hold Funds "up to, but not in excess of, the maximum amount a lender can require under RESPA" **[PARTIALLY VERIFIED — instrument text not retrievable today]**. Utah Code 7-17-7 mirrors RESPA (monthly deposits capped at 1/12 of annual charges plus a 1/6 buffer). No state with a cushion cap below two months was verified today; `jurisdiction_rules.escrow_cushion_max_months` stays null (= RESPA) until the licensing program's 50-state survey fills it **[UNVERIFIED for states not researched]**.

**Discrepancies with the blueprint row**: none in substance; the row's "2 months" shorthand is correct only as "1/6 of annual disbursements," which differs from two base payments by rounding (the engine uses the 1/6 figure computed in cents, floored, and separately checks the lowest target balance).

### Operational prerequisites
- `loan_terms.instrument_cushion_months` captured at boarding from the recorded security instrument or rider (Section 1.1); default null (= RESPA max).
- Policy parameter `escrow.cushion_months` (default 2.00) approved by compliance; jurisdiction table review by counsel.
- Engine unit-test suite (this section) run in CI on every rule-set change.

### Build spec
#### Inputs and triggers
- Every `escrow.analysis.computing` event (3.2) — the cushion module is called inside the engine.
- `loan.boarded` / `transfer.in.completed` — validation of the inherited cushion and the settlement deposit.
- `rule_sets.updated` (policy cushion change) → re-analysis is *not* automatic; applies at the next analysis (a lower cushion mid-year would only create a surplus to refund at the next analysis).

#### Data model
- `escrow_analyses.cushion_months`, `cushion_cents`, `cushion_cap_source` ∈ {regx, instrument, state, policy}, `cushion_cap_cents` (= floor(annual/6)), `lowest_target_cents`, `cap_check_passed bool`, `preaccrual_check_passed bool`.
- `jurisdiction_rules.escrow_cushion_max_months numeric null` (state override), `loan_terms.instrument_cushion_months`.
- No PII; retention with the analysis.

#### State machine
Not a separate lifecycle — the module returns `pass` or `fail(reason)` inside the analysis state machine: `computing` → `computed` only if `cap_check_passed && preaccrual_check_passed`; otherwise → `anomaly_review` with a hard block (`approved` is unreachable until fixed).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_17C5_CUSHION_CAP_GATE` | not_before_gate | `escrow.analysis.computing` | — | — | `cap_check_passed=true` | `approveAnalysis` refused; sev-2 if unresolved 5 BD before statement due |
| `REGX_1024_17C6_PREACCRUAL_GATE` | not_before_gate | `escrow.analysis.computing` | — | — | `preaccrual_check_passed=true` | same |
| `ESC_INHERITED_CUSHION_CHECK_10BD` | deadline (internal) | `loan.boarded` / `transfer.in.completed` | boarded_at | 10 business_days_servicer | `escrow.cushion.validated` | sev-3; schedule `transfer_in` analysis |
| Jurisdiction overrides | | `escrow_cushion_max_months` per state (none verified below 2) | | | | |

#### Business rules and calculations
1. **Effective cushion months** = `min(policy_cushion_months (2.00), instrument_cushion_months ?? ∞, state_cushion_max_months ?? ∞)`; if the instrument specifies a dollar cushion, convert to cents directly.
2. **Cushion cents** = `floor_cents(annual_disbursements_cents × cushion_months / 12)`; hard cap `floor_cents(annual_disbursements_cents / 6)`.
3. **Aggregate check** ((d)(2)(ii)): after Step 3, `min(target_balance[p]) ≤ floor_cents(annual/6)`; because Step 2 zeroes the low point and Step 3 adds exactly the cushion, this holds when rule 2 holds; the check remains as an invariant (guards multi-year items and rounding).
4. **Deposit ceiling check**: `new_payment − shortage_installment − deficiency_installment + credit_monthly = base_payment ≤ round_half_up(annual/12)`; violation impossible by construction; asserted in tests.
5. **Pre-accrual check**: every projected disbursement date ≥ the payee's earliest billing/availability date and ≤ its penalty date; deposits are never projected earlier than payment due dates; a line whose only purpose is to hold funds beyond the cycle (e.g., collecting a 2028 bill in 2026) fails.
6. **Multi-year items** ((c)(9)): a line with `cycle_years = N` contributes `amount / (12N)` per month and its low point is evaluated across the cycle; the annual-statement explanation flag is set in years where the low point is not reached.
7. **Net-of-prior-year rule** ((d)(2)(i)(C)): the cushion is computed on the projected disbursements only — shortage/deficiency installments and surplus credits are excluded from the cushion base.
8. **Inherited cushion** at transfer-in: if the transferor's target implied a cushion > cap, the `transfer_in` analysis recomputes and any resulting surplus is handled under (f) ((e)(2)); the (e)(1) initial statement is issued when the payment changes.

Worked example: annual disbursements $1,660.00 → cap floor(1,660 / 6) = **$276.66**; policy 2 months → $276.66 (same, since 2/12 = 1/6); instrument cushion 1 month → floor(1,660 × 1/12) = **$138.33** → target start $830.02 + $138.33 = $968.35 and December target $138.33; a 3-year flood premium of $1,800.00 added to the lines → annual for cushion purposes rises by $600.00 (its 1/12-of-cycle share), cap becomes floor(2,260 / 6) = $376.66.

#### Integrations
None external. Internal: engine module; boarding validator; rule-set service.

#### Outputs and artifacts
`escrow_analyses` cushion fields; `loan_events`: `escrow.cushion.validated`, `escrow.cushion.cap_failed` (with reason); analysis worksheet lines showing the cushion row; the initial/annual statement shows "cushion selected by servicer" (3.1/3.3).

#### AI agent design (AI-first)
- Agent: `escrow` — no discretion over the cap; may lower the cushion for a loan only via a policy override recorded in `agent_decisions` (e.g., hardship request; the reg permits a lower or no cushion). Tools: `setCushionPolicy(loan_id, months, reason)` (≤ cap), `validateCushion`.
- Escalations: none legally required; complaints alleging over-collection → 4.1 NoE process; no human approval needed to lower a cushion.
- AI-off path: cushion parameters are editable in ops-console within the cap; the gate is enforced by the engine regardless.

#### Edge cases and failure modes
- Instrument silent, escrow required by other law (HPML): RESPA limits apply unless the other law is lower ((c)(8)).
- Riders with dollar-denominated cushions (rare legacy instruments): convert; if the rider allows more than RESPA, RESPA controls.
- Biweekly: cushion still 1/6 of annual; per-period base = annual/26.
- Payment deferral/modification: the cushion is unaffected by the 60-month shortage spread (excluded from the cushion base).
- A payee changes billing from annual to installments mid-year: pre-accrual check re-run at the interim analysis.
- Negative annual disbursements (refund-only line) → line excluded from the cushion base.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 3.4-T1 | Given annual $1,660.00 and policy 2 months, then cushion $276.66 and lowest target ≤ $276.66. |
| 3.4-T2 | Given instrument cushion 1 month, then cushion $138.33 and `cushion_cap_source='instrument'`. |
| 3.4-T3 | Given a state override 1.5 months, then cushion floor(1,660 × 1.5/12) = $207.50 and source `state`. |
| 3.4-T4 | Given a projected disbursement dated before the bill's availability date, then `preaccrual_check_passed=false` and approval is blocked. |
| 3.4-T5 | Given a transferor target implying a 3-month cushion, then the transfer-in analysis produces a surplus and a refund/credit decision. |
| 3.4-T6 | Given a 3-year flood premium $1,800 due in year 2, then monthly share $50.00, cushion base includes $600.00, and the statement flag `low_point_not_reached` is set for years 1 and 3. |
| 3.4-T7 | Given the agent sets cushion 0 months for a hardship request, then target start = required start and the decision record carries the reason. |

#### Audit and evidence
Cushion fields and cap checks inside the immutable analysis record; rule-set version; instrument evidence document (recorded instrument page with Section 3) hash; decision records for any lowered cushion.

### Open questions / decisions
1. Default cushion 2 months vs. 1 month to reduce borrower friction? **Default: 2 months** (Fannie Mae allows; reduces advances), with a hardship-lowering tool.
2. Populate state cushion caps now or after the licensing survey? **Default: after** (RESPA cap in the meantime; no lower state cap verified).

### Sources
- 12 CFR 1024.17(c)(1), (c)(5)–(c)(9), (d): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-B/section-1024.17
- Appendix E: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Appendix%20E%20to%20Part%201024
- 12 U.S.C. 2609(a): https://www.law.cornell.edu/uscode/text/12/2609
- Utah Code 7-17-7 (via le.utah.gov chapter PDF): https://le.utah.gov/xcode/Title7/Chapter17/C7-17_1800010118000101.pdf
