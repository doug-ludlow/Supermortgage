# 10.3 — Final termination @ midpoint

| Attribute | Value |
|---|---|
| Section | 10 — PMI Administration |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | At amortization midpoint |
| Governing source | HPA 12 USC 4902 |
| Key deadlines | Month after midpoint (e.g., yr 15 of 30) even if >78% |
| Timers | `HPA_4902B2_CURE_TERMINATE_1ST`, `HPA_4902C_MIDPOINT_TERMINATE_0`, `HPA_4904A_TERMINATION_NOTICE_30`, `HPA_4904B2B_AUTO_NOT_CURRENT_NOTICE_30`, `SM_MI_MIDPOINT_PREVIEW_90` |

### Blueprint row
| Field | Value |
|---|---|
| Area | PMI |
| Trigger & frequency | At amortization midpoint |
| Governing source (blueprint) | HPA 12 USC 4902 |
| Key deadlines (blueprint) | Month after midpoint (e.g., yr 15 of 30) even if >78% |
| Artifacts | Termination |
| Systems | SMDU |
| Automation class (blueprint) | a |
| SoR / Sub | S[cropped in source] — reconstructed: "Sub performs; partner is servicer of record" |
| Nuances (blueprint) | [cropped in source] — reconstructed: "first day of the month following the midpoint of the amortization period established at consummation; only if current, otherwise when current; the only automatic rule Fannie Mae applies to 2–4 unit, investment and pre-July-29-1999 loans; midpoint recalculated after a modification (e.g., 480-month Flex Mod → 240 months after the modification); high-risk loans remain subject to it" |

### Verified requirement (as of 2026-09-09)

**12 U.S.C. 4902(c) (verified 2026-09-09).** "…in no case may such a requirement be imposed on residential mortgage transactions beyond the first day of the month immediately following the date that is the midpoint of the amortization period of the loan if the mortgagor is current" on the payments. *Midpoint of the amortization period* (4901(7)): "the point in time that is halfway through the period that begins upon the first day of the amortization period established at the time a residential mortgage transaction is consummated and ends upon the completion of the entire period over which the mortgage is scheduled to be amortized." 4902(d): recalculated after a modification. 4902(e)(3): no PMI payments "more than 30 days after the final termination date established under that subsection." 4902(g)(3): high-risk loans "shall terminate in accordance with subsection (c)" (the midpoint rule cannot be displaced by any high-risk designation). 4904(a) 30-day notice and 4902(f) 45-day refund apply. CFPB Bulletin 2015-03: for a 30-year loan the final termination occurs "the first day of the month following the 180th payment."

**Fannie Mae B-8.1-04 (05/15/2019).** For a one-unit principal residence or second home closed on/after July 29, 1999, the termination date is the 78% scheduled date "or the first day of the month following the date the mid-point of the mortgage loan amortization period is reached, if the scheduled LTV ratio for the mortgage loan does not reach 78% before the mid-point." For loans closed before July 29, 1999 (any property) and for "a one- to four-unit investment property or a two- to four-unit principal residence," MI terminates "on the first day of the month after the date that is the mid-point of the original amortization period, provided the borrower's payments are current on that date." The current test, the not-current notice, the "terminate immediately if… current at the time of a subsequent review" rule, the no-fee rule, the modified-loan recalculation, the 30-day collection stop, the 30-day notice, the 45-day refund and the LAR 89 report (action code **53** covers "the date that is the mid-point of the amortization period") are as in 10.2.

**Discrepancies with the blueprint row:** (1) "even if >78%" is right for HPA-covered loans, but for Fannie Mae 2–4 unit/investment/pre-1999 loans the midpoint is the *only* automatic rule, which the row does not say; (2) "yr 15 of 30" must be computed from the amortization period established at consummation, not from the note date — for a loan whose amortization period starts the first of the month after closing, the midpoint is the due date of payment 180 and termination is the first day of the following month; (3) the midpoint is recalculated after a modification (a 480-month Flex Mod moves it to 240 months after the modification effective date); (4) "Systems: SMDU" — SMDU is not used; the schedule engine is the trigger; (5) the row omits the current test and cure rule, the notices, the refund and the LAR 89 deadline.

### Operational prerequisites
- Same as 10.2, plus: `amortization_start` and `amortization_term_months` boarded for every MI loan (including pre-1999 loans, IO and balloon loans where the amortization term differs from the maturity term); modification data (`loan_terms` version with the modified amortization term and effective date) for Flex Mods and legacy modifications.
- A `jurisdiction_rules` flag for any state that requires earlier termination than the midpoint (none verified; 4908(a)(2) allows protected state laws that terminate "at a date earlier") **[UNVERIFIED — no state identified]**.

### Build spec
#### Inputs and triggers
- Nightly `mi-auto-termination-sweep` (shared with 10.2) selecting active BPMI policies with `midpoint_termination_date ≤ today` where the 78% rule has not already terminated the policy (`auto_status ∈ {pending, deferred_not_current, not_applicable_midpoint_only}`).
- `lossmit.modification.effective` → recompute `midpoint_date` from the modified amortization period; `mi.original_value.corrected` has no effect on the midpoint; `loan_terms.rate_changed` (ARM) has no effect on the midpoint (the period is fixed at consummation unless modified).
- Cure detection events as in 10.2.

#### Data model
`mi_policies.midpoint_date` (date; the midpoint itself), `midpoint_termination_date` (first day of the month immediately following `midpoint_date`), `midpoint_basis` ∈ {consummation, modification}, `midpoint_schedule_id`; `mi_terminations.type='automatic_midpoint'`. `mi_schedules.derived_midpoint_date` per version.

#### State machine
As 10.2 (`pending` → `terminated` | `deferred_not_current` → `terminated`), with `termination_type='automatic_midpoint'`. When both the 78% date and the midpoint date are in the future, the earlier of the two is the pending trigger; when the 78% date is deferred for non-currency and the midpoint arrives first, the midpoint governs the "becomes current" fallback identically (both yield the first day of the month after cure).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `HPA_4902C_MIDPOINT_TERMINATE_0` | deadline | `mi.schedule.updated` | `midpoint_termination_date` | 0 `calendar_days` | `mi.terminated` or `mi.auto.deferred_not_current` | `officer` sev-1 |
| `HPA_4904B2B_AUTO_NOT_CURRENT_NOTICE_30` | deadline | `mi.auto.deferred_not_current` (midpoint) | `midpoint_termination_date` | 30 `calendar_days` | `notice.sent` (`NTC_HPA_4904B_AUTO_NOT_CURRENT`) | `officer` sev-1 |
| `HPA_4902B2_CURE_TERMINATE_1ST` | deadline | `loan.became_current` | cure date | first day of next month | `mi.terminated` | `officer` sev-1 |
| `HPA_4904A_TERMINATION_NOTICE_30`, `HPA_4902E_STOP_PREMIUM_30`, `HPA_4902F1_REFUND_45`, `FNMA_IRM_LAR89_PERIOD_END` (5.1), `MI_INSURER_CANCEL_NOTICE_45`, `SM_MI_INSURER_CANCEL_TARGET_2BD` | as 10.2 | `mi.terminated` | effective date | as 10.2 | as 10.2 | as 10.2 |
| `SM_MI_MIDPOINT_PREVIEW_90` | deadline (policy) | — | `midpoint_termination_date − 90 days` | 0 | `mi.midpoint.preview.completed` (data completeness check: schedule, original value, insurer channel) | queue to `pmi` agent |

#### Business rules and calculations
- **R1 — Midpoint.** `amortization_start` = the first day of the amortization period established at consummation (the day interest begins accruing toward the first scheduled payment; for a loan with first payment due 2024-05-01 and interest paid at closing through 2024-03-31, `amortization_start = 2024-04-01`); `amortization_end = amortization_start + amortization_term_months` (the due date of the last scheduled payment); `midpoint_date = amortization_start + amortization_term_months/2 months` (odd terms: add `floor(term/2)` months plus 15 days, then take the first day of the month immediately following); `midpoint_termination_date = first day of the month immediately following midpoint_date`. Equivalent check for a standard 360-month loan: the due date of payment 180 is the midpoint; termination is the first day of the next month.
- **R2 — Applies regardless of LTV.** No balance test; no valuation; no fee. The termination date is a hard date subject only to the current test (10.2 R3) and the cure rule.
- **R3 — Modifications.** `midpoint_basis='modification'`: `amortization_start = modification effective date` (first day of the month in which the first modified payment period begins), `amortization_term_months = modified term`; e.g., a 480-month Flex Mod effective 2029-02-01 → midpoint 2049-01-01 → termination 2049-02-01. Legacy modifications boarded without a term → escalate.
- **R4 — Interaction with 78%.** For rule-78 loans, `pending_trigger_date = min(scheduled_78_date, midpoint_termination_date)`; for midpoint-only loans it is the midpoint date. Both produce `lar89_action_code=53`.
- **Worked example (1-unit).** Worked loan: `amortization_start 2024-04-01`, term 360 → `midpoint_date 2039-04-01` (payment 180 due 2039-04-01, scheduled UPB $275,724.30 = 68.9% LTV), `midpoint_termination_date 2039-05-01`. The 78% date (2035-07-01) comes first, so the midpoint only matters if the loan was never current at a 78% check; if the loan is first current on 2039-04-15, termination is effective 2039-05-01 either way.
- **Worked example (interest-only 10/20).** $380,000 at 6.50%, IO for 120 months then amortizing over 240 (P&I $2,833.18): the scheduled balance first reaches 78% ($312,000) with payment 192 due 2040-04-01, *after* the midpoint (2039-04-01); therefore `midpoint_termination_date = 2039-05-01` controls and the policy terminates 2039-05-01 if current (notice by 2039-05-31; refund by 2039-06-15; LAR 89 `050139`, code 53).
- **Worked example (2-unit).** 2-unit principal residence, first payment 2021-04-01, 360 months: midpoint = payment 180 due 2036-03-01 → termination **2036-04-01** if the 2036-02-01 installment was paid by 2036-02-29 (leap year) and nothing earlier is outstanding; no 78% rule applies; HPA does not apply (2 units) so only the Fannie Mae timers run (the HPA-coded timers are instantiated with `rule_set='fnma.mi.b8104.2019-05'` and identical offsets).
- **Worked example (pre-1999 loan).** 30-year loan consummated 1998-11-15 with first payment 1999-01-01: `amortization_start 1998-12-01`, midpoint 2013-12-01 → termination 2014-01-01 — already past; if such a loan boards with MI still active and current, terminate on boarding (effective the boarding date, with a self-identified exception logged for the prior servicer's period) and send 4903(b)-type communications; escalate `officer` for restitution analysis.

#### Integrations
Identical to 10.2 (insurer cancellation, LAR 89 code 53, escrow interim analysis, notices). No SMDU call.

#### Outputs and artifacts
`NTC_HPA_4904A_CANCELLED` (variant text: "reached the midpoint of the amortization period"), `NTC_HPA_4904B_AUTO_NOT_CURRENT` when deferred, LAR 89 code 53 with action date = effective date, refund (10.5), `mi_terminations` record, escrow analysis.

#### AI agent design (AI-first)
The `pmi` agent handles the 90-day preview: verifies `amortization_start`/term against the note and any modification agreement (`documents`), confirms the insurer channel and refund payee data, and pre-computes the refund estimate; on the termination date it runs the finalization pipeline; it explains the midpoint rule to borrowers who ask why MI ended despite LTV > 78% (script: statutory midpoint rule; no action needed; refund timing). Guardrails and escalations as 10.2; additionally, if `amortization_term_months` is missing or inconsistent with the note (e.g., balloon), the agent escalates to `officer` with the note image rather than guessing. AI-off path: sweep plus ops console queue.

#### Edge cases and failure modes
- Balloon loans: the amortization period is the amortization term in the note (e.g., 360) even when maturity is 84 months; the midpoint may fall after maturity — no action; payoff ends MI.
- Term shorter than 20 years (15-year loans): midpoint at 7.5 years; 78% is usually reached earlier; both computed.
- Modification with term reduction or re-amortization to the original maturity (e.g., recast): midpoint recomputed from the modified period; a recast without a modification agreement (curtailment recast) does not change the period.
- Deferred principal at midpoint: irrelevant to the midpoint test; balances carry to payoff.
- Not current for years: the not-current notice is sent once per trigger (78% and midpoint); subsequent reviews are daily; cure → termination the following first-of-month.
- Servicing transfer around the midpoint: the party servicing on `midpoint_termination_date` terminates; the transfer file carries the date and status.
- Bankruptcy/foreclosure in process: termination still occurs if the contractual current test is met; in foreclosure the borrower is not current — no termination; the MI stays in force for the claim (Section 15.3).
- Loans with MI cancelled by the insurer earlier (rescission): no midpoint action; status already `rescinded`.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 10.3-T1 | Given the IO 10/20 loan, then `midpoint_termination_date=2039-05-01` and `pending_trigger_date=2039-05-01` (78% date 2040-04-01 is later). |
| 10.3-T2 | Given the 2-unit loan current on 2036-04-01, then `mi.terminated` effective 2036-04-01, LAR 89 code 53 action date `040136`, notice by 2036-05-01, refund by 2036-05-16. |
| 10.3-T3 | Given the 2-unit loan with the February 2036 installment paid late on 2036-03-05 and the March 2036 installment paid 2036-03-28, when the sweep evaluates `is_current(2036-04-01)` (test month = March 2036; every installment due on or before 2036-03-01 must be paid by 2036-03-31), then the loan is current, termination is effective 2036-04-01 and no not-current notice is sent. Given instead the March installment paid 2036-04-09, then `deferred_not_current`, not-current notice by 2036-05-01, cure 2036-04-09 and termination effective 2036-05-01. |
| 10.3-T4 | Given the Flex Mod effective 2029-02-01 with a 480-month term, then `midpoint_termination_date=2049-02-01` and `midpoint_basis='modification'`. |
| 10.3-T5 | Given a boarded 1998 loan with active MI and current status, then termination on the boarding date, `officer` restitution escalation, and a Sentinel exception. |
| 10.3-T6 | Given a 15-year loan (first payment 2024-05-01), then midpoint = payment 90 due 2031-10-01 → `midpoint_termination_date=2031-11-01`; the 78% date is compared and the earlier date is the trigger. |
| 10.3-T7 | Given the midpoint termination date passes without a sweep decision, then `HPA_4902C_MIDPOINT_TERMINATE_0` breaches and `officer` sev-1 opens. |

#### Audit and evidence
As 10.2, plus the recorded `amortization_start`/term derivation with the note/modification document hashes, the preview checklist, and the monthly "loans past midpoint still insured" exception report (expected: only `deferred_not_current`).

### Open questions / decisions
1. **Odd-month terms and mid-month starts (10.3-Q1):** default — compute the midpoint by months and days from `amortization_start` and always terminate on the first day of the following month.
2. **Pre-1999 boarded loans with active MI (10.3-Q2):** default — terminate on boarding, escalate for restitution; coordinate with the transferor under the transfer agreement's indemnity.

### Sources
- 12 U.S.C. 4901(7), 4902(c)–(g): https://www.law.cornell.edu/uscode/text/12/4901 ; https://www.law.cornell.edu/uscode/text/12/4902 (verified 2026-09-09)
- Servicing Guide B-8.1-04 (05/15/2019): https://servicing-guide.fanniemae.com/svc/b-8.1-04/termination-conventional-mortgage-insurance
- Investor Reporting Manual §3-04 (Apr. 8, 2026): https://singlefamily.fanniemae.com/media/7816/display
- CFPB Bulletin 2015-03: https://files.consumerfinance.gov/f/201508_cfpb_compliance-bulletin_private-mortgage-insurance-cancellation-and-termination.pdf
