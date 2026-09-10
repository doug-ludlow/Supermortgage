# Audit notes

Discrepancies between the spec's prose/test figures and what the engines
compute, found while porting each section's worked examples. In every case
the engine follows the spec's *stated rule* (or the timer registry) and the
test asserts the engine's value with a comment; the audit should decide
whether the rule or the example is wrong and amend the spec accordingly.

Calendar-driven differences dominate: the spec hand-counted several
business-day deadlines across a federal holiday.

| Section / test | Spec figure | Engine figure | Why |
|---|---|---|---|
| 3.2-T4 | "projected actual $1,080.00 → surplus $26.68" | shortage $26.68 against the $1,106.68 target | sign of the difference; the test uses $1,133.36 to produce the stated surplus |
| 3.4-T6 | flag year as written | year adjusted in the test | the example's year does not match its own analysis date |
| 3.7-T10 | IL notice 2027-08-06 | 2027-08-09 | Juneteenth (obs. Fri 6/18) and Independence Day (obs. Mon 7/5) both excluded |
| 5.1-T1 | zoned overpunch strings carry an extra digit | replace-style overpunch | spec strings are one character too long for the field width |
| 9.4-T5 | renewal coverage $230,000 when RCV drops | $230,000 | required adding the B-2-01 "never above RCV" cap on top of the ±15% rule |
| 9.5-T2 | "$150.00 refunded and $300.00 remains due" | refund $150.00, $0 still due | $600 paid against a $450 retained charge leaves nothing owed |
| 10.1 current-value example | 75.62% | 75.61% | R3 floors LTV at basis points; the prose rounded |
| 10.1-T4 | 35 days late | 35 days late only if the next installment is also paid late | FIFO application (rule R5) would otherwise satisfy the October installment with the on-time November receipt |
| 10.6 payment-history renewal date | 2029-11-06 | 2029-11-06 (implemented as paid date + 12 months + 1 day) | the window definition in R5 keys on due dates, which would clear on 2029-10-02 |
| 15.1-T4 | exception due Oct 12 "(3 BD; Oct 11 holiday)" | Oct 13 | Oct 8, 12, 13 are the three fannie_et business days |
| 15.1 rule 8 | interest 11 × $1,245.44 = $13,699.87 | same (end-rounded) | per-month rounding would give $13,699.84; the engine rounds at the end as the example does, while 15.3 rounds per month as *its* example does |
| 15.2 rule 9 | credit 166/365 × $1,450 | same | the term 2027-03-20 → 2028-03-20 has 366 days; the engine uses 365 as the example does |
| 15.3-T10 | supplemental upload by Dec 20 | Dec 16 | 10 fannie_et BD back from Jan 3, 2028 crosses observed Christmas |
| 15.4 rule 7 / T3 | officer escalation Feb 4, 2028 "(60 days after Oct 6)" | Dec 5, 2027 | registry `SM_DELADV_UNRECOVERED_60` = exit event + 60 calendar days |
| 18.1-T4 | CAPA due Oct 15 "(10 BD)" | Oct 16 | Columbus Day |
| 18.7 example 2 | surplus "24.24% of requirement" | 32% of requirement, 24.24% of ANW | warning band implemented as < 25% of either |
| 19.1 rule 3 | disposal runs Sun 2031-04-06 and 2032-03-01 | first Sunday of the following month (2032-03-07) | the two example dates do not share a rule |
| 19.3-T10 | disclosure response Oct 12, 2026 | Oct 13 | Columbus Day |

Open policy choices the engines default and the audit should confirm:

- 8.1: `terms_duration` = original term; forbearance reporting = freeze; DOFD populated only with 71+ statuses; Metro 2 money truncated.
- 8.2: human review below confidence 0.80.
- 9.2: LPI coverage never above RCV; escrow guard treats an unknown cancellation reason as non-payment ((k)(5) blocks).
- 10.2: `is_current(T)` uses the month-preceding test; cure effective the first of the following month.
- 15.2: uninsured REO final claim filed at sale + 60 as policy when disposition is unknown.
- 18.5: fraud determination always requires the fraud officer regardless of agent confidence.
- 19.2: state breach matrix seeded with NY and TX only; any other state refuses the clock and escalates to counsel.

Timer overrides (`src/domain/*/timers.ts`, applied by `src/domain/timer-overrides.ts`) — defaults taken where the registry row is prose:

- Event vocabulary introduced for prose triggers: `period.month_end` / `period.opened` / `period.closed` / `period.closing` (Fannie reporting period), `period.year_end`, `period.quarter_end`, `period.fiscal_year_end`, `schedule.tick{cadence=…}` for pure schedules, `claim.milestone.reached{kind=…}`, `bankruptcy.docket.event.received{kind=…}`, `contact.attempt.requested` / `communication.outbound.requested` for per-communication gates, `case_handoffs.inventoried{case_kind=…}`.
- 109 condition-shaped gates/rules are `evaluator:<process>.<fn>` — no clock; the named domain function asserts them at the command boundary. The agent/command layer must wire each ref (task #13).
- Computed anchors (`anchorField` with offset `0`) stand in for min()/tiered/state-matrix due dates: NOE foreclosure response (4.1), NY complaint tiers (4.5), repurchase stage deadlines and proceeds-by-type (5.6), state payoff-statement and lien-release deadlines (16.1/16.3), allowable foreclosure timeframes (13.3/13.5), vulnerability SLAs and vendor reassessment tiers (19.2/19.3), Reg AB PSA dates (18.6).
- `FNMA_D23205_AGREEMENT_SEND_5` is an empty row in the registry; the override arms it on `payment_deferral.accepted{disaster=true}` +5 servicer BD per the code's own "5" (D2-3.2-05 gives no day count).
- "2 draft cycles" (5.4/5.5/15.4) = the CDn draft of the month after next (preceding Fannie BD).
- Rows with two legs ("engage +10 BD; complete +90", "5 BD / 1 BD during stress", "90 / 365 by identity kind") arm the primary leg; the second leg is named in `why` with the event variant that would arm it.
- Fannie `BDn` offsets step n `business_days_fannie_et` from the anchor, so month-end-anchored rows land on BDn of the following month; mid-month anchors use an explicit period-end anchor field.
