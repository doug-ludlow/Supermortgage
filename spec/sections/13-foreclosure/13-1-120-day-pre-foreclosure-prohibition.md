# 13.1 — 120-day pre-foreclosure prohibition

| Attribute | Value |
|---|---|
| Section | 13 — Foreclosure |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | Before first filing |
| Governing source | Reg X 1024.41(f)(1) |
| Key deadlines | No first notice/filing until borrower >120 days delinquent |
| Timers | `BK_362_STAY_GATE`, `FNMA_D1301_DISASTER_FC_APPROVAL_GATE`, `FNMA_E1202_NONPR_REFER_BY_120`, `REGX_1024_41F1_120_DAY_GATE`, `REGX_1024_41F2_PRE_FILING_APP_GATE`, `REGX_1024_41K2_NO_FIRST_FILING_GATE`, `SCRA_3953C_FC_PROTECTION_GATE` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Foreclosure |
| Trigger & frequency | Before first filing |
| Governing source (blueprint) | Reg X 1024.41(f)(1) |
| Key deadlines (blueprint) | No first notice/filing until borrower >120 days delinquent |
| Data/artifacts | Compliance gate |
| Systems | Core |
| Automation class (blueprint) | b |
| SoR / Sub | S[cropped in source] — read as Sub (Supermortgage performs; partner liable) |
| Nuances (blueprint) | [cropped in source] — reconstructed below: applies only to principal-residence loans (1024.30(c)(2)); "first notice or filing" is defined by state procedure (comment 41(f)-1.i–iv); exceptions for due-on-sale and joining a lienholder's action; (f)(2) complete-application freeze before the first filing; referral to counsel is not itself prohibited; non-principal residences follow Fannie Mae's "refer by day 120" rule instead |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.41(f)(1) — eCFR current as of Sept. 8, 2026 (last amended May 16, 2025, 90 FR 20792; the amendment removed the COVID-era (f)(3) and did not touch (f)(1)/(f)(2)).** "A servicer shall not make the first notice or filing required by applicable law for any judicial or non-judicial foreclosure process unless: (i) A borrower's mortgage loan obligation is more than 120 days delinquent; (ii) The foreclosure is based on a borrower's violation of a due-on-sale clause; or (iii) The servicer is joining the foreclosure action of a superior or subordinate lienholder."

**Scope.** 1024.30(c)(2) (verified today): "The procedures set forth in §§ 1024.39 through 1024.41 of this subpart only apply to a mortgage loan that is secured by a property that is a borrower's principal residence." A confirmed successor in interest is a "borrower" for the subpart (1024.30(d); Section 4.4). Small-servicer, reverse-mortgage and qualified-lender exemptions (1024.30(b)) never apply to this platform (Fannie Mae is the assignee — Section 7.1).

**"First notice or filing" — comment 41(f)-1 (Official Interpretations, verified today on the CFPB interactive regulation):** whether a document is the first notice or filing "is determined on the basis of foreclosure procedure under the applicable State law": (i) where foreclosure requires a court action, it is "the earliest document required to be filed with a court or other judicial body to commence the action or proceeding" (e.g., "a complaint, petition, order to docket, or notice of hearing"); (ii) under a power of sale, "the earliest document required to be recorded or published to initiate the foreclosure process"; (iii) where nothing is filed, recorded or published, "the earliest document that establishes, sets, or schedules a date for the foreclosure sale"; (iv) a document provided to the borrower that is not required to be filed, recorded or published is not the first notice or filing "on the sole basis that the document must later be included as an attachment." **Consequences for the build:** a breach/acceleration letter (11.x), NY RPAPL §1304 notice, CA §2923.5 contact, NJ FFA notice of intention, MA §35A right-to-cure notice, TX §51.002(d) 20-day cure letter and MD §7-105.1 notice of intent are *not* first filings (they may be sent inside the 120 days where state law permits); the first filing is the complaint/lis pendens (judicial), the recorded notice of default (CA/NV/WA/AZ), the notice of sale posting/filing (TX §51.002(b)), the newspaper advertisement (GA), the order to docket (MD) — encoded per state in `jurisdiction_rules.foreclosure.first_notice_document`.

**Delinquency counting.** 1024.31: delinquency "begin[s] on the date a periodic payment sufficient to cover principal, interest, and, if applicable, escrow becomes due and unpaid, until such time as no periodic payment is due and unpaid" (FIFO crediting). Day counting per comment 39(a)-1 (research/00a §1.4; Section 11.1): the payment due Jan. 1 makes the 36th day Feb. 6, i.e., **day N = due date + N calendar days**. "More than 120 days delinquent" therefore means `regx_days_delinquent ≥ 121`, first true on the **121st day** (due Jan. 1 → May 2, 2026; due Mar. 1 → June 30, 2026). Fannie Mae's phrasing matches: E-1.2-02 (05/10/2023) "the servicer must refer the mortgage loan to foreclosure no earlier than the 121st day of delinquency unless applicable law permits earlier referral." Partial payments and rolling delinquencies advance the anchor only when a full periodic payment is credited (2.1/2.2); a trial-period plan does not cure delinquency (comment 39(a)-1.ii-style treatment; 12.x).

**Referral vs. filing.** Reg X regulates the first notice or filing, not the referral to counsel; the commentary contains no "no referral before day 120" rule. Fannie Mae's referral rule is the binding one (E-1.2-02 "no earlier than the 121st day" for principal residences; for non-principal residences the loan "must be referred to a law firm for foreclosure no later than the 120th day of delinquency, **except in circumstances where the borrower submits a BRP shortly before the foreclosure referral**" — E-1.2-02 (05/10/2023), the exception's terms being the E-3.2-04 postponement ladder set out in rule 5 below and in 13.4; 13.3). The platform still treats **referral of a principal-residence loan** as gated by 13.1, because a referred firm will file promptly and the servicer cannot rely on counsel's timing (comment 41(g)-3 logic).

**(f)(2) — application received before the first filing (verified today):** "If a borrower submits a complete loss mitigation application during the pre-foreclosure review period set forth in paragraph (f)(1) of this section or before a servicer has made the first notice or filing required by applicable law for any judicial or non-judicial foreclosure process, a servicer shall not make the first notice or filing" unless (i) the servicer has sent the (c)(1)(ii) notice that the borrower is not eligible for any loss mitigation option "and the appeal process in paragraph (h) ... is not applicable, the borrower has not requested an appeal within the applicable time period ..., or the borrower's appeal has been denied"; (ii) "The borrower rejects all loss mitigation options offered by the servicer"; or (iii) "The borrower fails to perform under an agreement on a loss mitigation option." The 2013/2016 rule contains no separate commentary under 41(f)(2). Transfer overlay: 1024.41(k)(2)–(5) carry the transferor's timelines and the transferee may not make the first filing while an acknowledged incomplete application's "reasonable date" is open (Section 1.3 `REGX_1024_41K2_NO_FIRST_FILING_GATE`).

**Reg X 1024.39/.40 interplay.** Early-intervention live contact (day 36) and written notice (day 45) continue through the 120 days and after referral (1024.39(a)/(b); Section 11); 1024.40(b)(1)(iv)–(v) (verified today) require assigned personnel able to tell the borrower "the circumstances under which the servicer may make a referral to foreclosure" and "applicable loss mitigation deadlines" — the `borrower-comms` agent reads them from `foreclosure.gates.get` (4.x). 1024.41(b)(3) (verified today): protections keyed to days-before-sale "shall be made as of the date a complete loss mitigation application is received"; comment 41(b)(3)-1: with no sale scheduled the application "is considered to have been received more than 90 days before any foreclosure sale" and (-2) later scheduling does not strip protections — this fixes the (e)(1) 14-day acceptance and (h) appeal rights for every pre-referral application.

**2024 NPRM (research/00a §1.2, not final as of today).** Would delete (f)(1)'s complete-application predicate in favour of a "loss mitigation review cycle" starting on any "request for loss mitigation assistance", keep a 120-day-style pre-foreclosure period, and permit the first notice or filing only when (i) all options were reviewed, notices sent and appeals exhausted, or (ii) the borrower has been unresponsive ≥90 days despite regular outreach; with a fee freeze during the cycle. Built as rule set `regx.lossmit.2024nprm` (flag off).

**Fannie Mae layer (Aug. 12, 2026 Guide).** E-1.2-02: foreclosure "is considered to have begun on the date when the servicer refers the matter to a law firm" and "the servicer must maintain a record of the date of the referral in the mortgage loan file." E-3.2-02 (11/12/2014) requires *expedited* foreclosure "to the greatest extent allowable under applicable law" when the property is abandoned, the borrower's written response disclaims interest or consents, or rental income is not being applied — still subject to 1024.41(f)(1) for principal residences and to Fannie Mae's day-120 rule otherwise. D1-3-01 (04/08/2026, LL-2026-01): disaster-impacted properties need Fannie Mae's prior written approval before "referring the mortgage loan to foreclosure, initiating any judicial or non-judicial foreclosure process, moving for a foreclosure judgement or order of sale, or executing a foreclosure sale" (13.4).

**State overlays (details in 13.3 matrix).** Several states impose their own pre-filing waiting periods that run inside or beyond the 120 days: NY RPAPL §1304 (90-day notice before commencing) and §1306 (DFS filing within 3 business days of mailing; condition precedent); CA Civ. Code §2923.5 (no NOD until 30 days after contact/due diligence; 2025 code year); NJ N.J.S.A. 2A:50-56 (notice of intention "at least 30 days, but not more than 180 days" before filing); MA c.244 §35A (90-day right to cure; once per 5 years); MD RP §7-105.1 (later of 90 days after default or 45 days after NOI); WA RCW 61.24.031 (30/90-day pre-NOD process); NV NRS 107.500 et seq. (30-day pre-NOD notice); MN §582.043 (no attorney referral while an application is pending). These are modelled as additional `not_before_gate`s evaluated with 13.1.

**Discrepancies with the blueprint row.** (1) The row omits the principal-residence scope (1024.30(c)(2)) — for second homes/investment properties the *only* 120-day rule is Fannie Mae's "refer by day 120", which runs the opposite direction. (2) The row says "first notice/filing" but not that *referral* is unregulated by Reg X and regulated by Fannie Mae. (3) The (f)(2) pre-filing application freeze and its three exits are absent. (4) The two statutory exceptions (due-on-sale; joining a lienholder's action) are absent. (5) The May 16, 2025 rescission removed (f)(3); no COVID logic remains.

### Operational prerequisites
- `regx_days_delinquent` and `fnma_delinquency_status` computed daily (baseline §3) with FIFO crediting and reversals (2.1/2.2) — Supermortgage, Stage 1.
- `jurisdiction_rules.foreclosure` seeded for every state in the partner's footprint (judicial/non-judicial, `first_notice_document`, pre-foreclosure notice rules, allowable days) — Supermortgage compliance + outside counsel review; 4–6 weeks; artifact: signed jurisdiction matrix v1 (13.3).
- Occupancy/principal-residence flag (`properties.occupancy_type`, `loans.principal_residence`) maintained from origination data, inspections (D2-2-10, 11.x) and borrower statements; rule: unknown ⇒ treat as principal residence.
- Loss-mitigation state machine (12.x) exposing `lossmit.application.state`, `offer.state`, `appeal.state`, `agreement.performing` to the gate evaluator.
- Successor-in-interest confirmation (4.4) and bankruptcy feed (14.1) live.
- Partner sign-off on the referral-gating policy (referral gated by 13.1 for principal residences) and on `regx.lossmit.2024nprm` switch governance.

### Build spec
#### Inputs and triggers
- Daily `delinquency.counters.updated` (00:05 loan timezone) recomputing `regx_days_delinquent`; `payment.applied/reversed` (anchor changes); `loan.boarded` (seeded counters, 1.3); `loan_terms.activated` (modification cures delinquency).
- Loss-mit events (12.x): `lossmit.application.completed`, `lossmit.determination.sent{eligible=false}`, `lossmit.appeal.received/denied/window_expired`, `lossmit.offer.sent/accepted/rejected/expired`, `lossmit.agreement.defaulted`, `lossmit.trial.started/failed`.
- Property/occupancy: `property.occupancy.changed`, `loan.principal_residence.changed`; `sii.confirmed` (4.4).
- Overlays: `bankruptcy.petition.filed/dismissed/discharged`, `bankruptcy.stay.relief.granted` (14.x); `scra.period.started/ended`, `scra.stay.granted` (13.8); `disaster.impact.determined` (11.x/D1-3-01); `litigation.hold.opened` (13.7).
- Commands that must call `assertGateOpen`: `foreclosure.refer` (13.3), `foreclosure.first_notice.authorize` (attorney instruction to file/record/publish), `foreclosure.due_on_sale.refer` (exception path), `foreclosure.join_lienholder_action` (exception path).

#### Data model
- `foreclosure_gate_definitions` (new; seeded): `code` PK, `citation`, `applies_to_steps text[]` ⊂ {refer, first_notice, judgment_motion, sale_schedule, sale_certify, sale_conduct, eviction}, `scope` ∈ {principal_residence_only, all}, `evaluator` (function name), `rule_set`.
- `foreclosure_gate_evaluations` (new; append-only): `id`, `loan_id`, `case_id?`, `gate_code`, `step`, `evaluated_at`, `result` ∈ {open, closed}, `reason_code`, `inputs jsonb` (counter values, application ids, dates), `rule_set_version`, `command_id?`, `decision_id?`. Retention `life_of_loan_plus_4y`; no PII beyond ids.
- `loans` (baseline) gains: `principal_residence bool`, `regx_lossmit_scope bool` (derived: principal_residence ∧ ¬reverse), `fc_120_day_open_on date?` (projection: earliest unpaid due date + 121 days), `fc_referral_deadline_on date?` (non-principal residence: earliest unpaid due date + 120 days).
- `timer_definitions` rows (below) with `kind=not_before_gate`.
- `rule_sets`: `regx.lossmit.2013` (production), `regx.lossmit.2024nprm` (shadow), keyed on `foreclosure_gate_definitions.rule_set`.

#### State machine
Gate `REGX_1024_41F1_120_DAY_GATE` (per loan, projection):
- `not_applicable` (¬`regx_lossmit_scope`) — transitions to `closed`/`open` if occupancy becomes principal residence (unknown ⇒ applicable).
- `closed` (`regx_days_delinquent < 121`) → `open` at 00:05 on the 121st day (`fc_120_day_open_on`); → `closed` again when a full periodic payment moves the anchor so that days < 121, or the loan becomes current, or a modification/deferral activates.
- `exception_open` — set only by an `officer`-approved (partner) `foreclosure.exception.recorded{kind ∈ {due_on_sale, join_lienholder}}` with counsel's memo; it opens `first_notice` for that ground only.
Gate `REGX_1024_41F2_PRE_FILING_APP_GATE`: `open` unless a complete application (12.x) was received while `first_notice` not yet made and none of exits (i)–(iii) has occurred; `closed` → `open` on `lossmit.determination.sent{ineligible} ∧ appeal not applicable/expired/denied`, `lossmit.offer.rejected{all}`, or `lossmit.agreement.defaulted`; re-`closed` on a new complete application unless 1024.41(i) (duplicative request: prior complete application fully processed and borrower delinquent at all times since) applies.
Terminal: gates are projections; they are never deleted, only recomputed with an evaluation row.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_41F1_120_DAY_GATE` | not_before_gate | `delinquency.counters.updated` (loan enters delinquency) | earliest unpaid periodic due date | +121 calendar_days (opens 00:05 loan tz on day 121) | `assertGateOpen` by `foreclosure.refer` (principal residence) and `foreclosure.first_notice.authorize` | command refused; attempt logged sev 1 → Compliance Sentinel |
| `REGX_1024_41F2_PRE_FILING_APP_GATE` | not_before_gate | `lossmit.application.completed` before `foreclosure.first_notice.filed` | receipt date | 0 (closed until an (f)(2)(i)–(iii) exit event) | exit events listed above | refused; sev 1 |
| `REGX_1024_41K2_NO_FIRST_FILING_GATE` | not_before_gate (1.3) | `loan.boarded{incomplete app with reasonable date}` | transferor reasonable date | +1 calendar_day | 1.3 | refused |
| `FNMA_E1202_NONPR_REFER_BY_120` | deadline (suspendable) | delinquency of a non-principal-residence loan reaches day 90 | earliest unpaid due date | +120 calendar_days | `foreclosure.referral.sent`, **or** suspension under the E-1.2-02 BRP exception / E-3.2-04 ladder (rule 5): complete BRP ⇒ +30d evaluation; retention offer ⇒ +14d response; accepted offer requiring payment ⇒ through the last day of the month the first payment is due; first plan payment ⇒ until breach. A borrower *inquiry* or an *incomplete* BRP does **not** suspend it (E-3.2-04) | sev 2 → `foreclosure-ops`; compensatory-fee exposure flag (13.5) |
| `STATE_PREFC_NOTICE_GATE:<XX>` (family; rows in 13.3) | not_before_gate | state pre-foreclosure notice sent / contact made | notice mailing date or contact date | state days (NY 90, NJ 30–180, MA 90, TX 20+21, MD 45/90, CA/WA 30, NV 30) | `assertGateOpen` by `foreclosure.first_notice.authorize` | refused |
| `FNMA_D1301_DISASTER_FC_APPROVAL_GATE` | not_before_gate (13.4) | `disaster.impact.determined` | — | until `fnma.disaster_fc.approved` | approval event | refused |
| `BK_362_STAY_GATE` | not_before_gate (14.x) | `bankruptcy.petition.filed` | — | until relief/dismissal/discharge without lien avoidance | 14.x | refused |
| `SCRA_3953C_FC_PROTECTION_GATE` | not_before_gate (13.8) | `scra.period.started` | service end | `service_end_on` + 1 calendar_year, inclusive (or court order/waiver) | 13.8 | refused |

`jurisdiction_overrides`: none for the federal gate; day counting is calendar days in the loan's `properties.state` timezone.

#### Business rules and calculations
1. `regx_days_delinquent(today) = today − earliest_unpaid_periodic_due_date` (calendar days; 0 on the due date). Gate open ⇔ value ≥ 121. Worked example: due date Jan. 1, 2026, unpaid; day 120 = May 1, 2026 (closed); **May 2, 2026** is the 121st day → open. Due Mar. 1, 2026 → open **June 30, 2026**. A leap-year February changes the calendar date, never the day count.
2. Anchor movement: a payment credited to the Jan. 1 installment on Apr. 10 (FIFO) makes Feb. 1 the earliest unpaid due date; days = Apr. 10 − Feb. 1 = 68 → gate closes; it re-opens June 2 (Feb. 1 + 121). Payments held in suspense do not move the anchor until applied (2.2).
3. Principal-residence determination: `loans.principal_residence` from origination occupancy, overridden by a verified change (borrower statement recorded in `contacts`, inspection showing tenant occupancy with lease, mailing-address evidence). Rule of construction: **if unknown or disputed, treat as principal residence** (Reg X scope favours the borrower; Fannie Mae's non-principal-residence day-120 deadline is then suspended with reason `occupancy_unresolved`).
4. Exceptions (f)(1)(ii)/(iii) are never inferred by the agent; they require an `officer` (partner) approval with counsel's memo and open only the `first_notice` step for that ground; the loan remains subject to (f)(2), (g), state and Fannie Mae gates.
5. **Non-principal residence — day-120 deadline and its BRP exception.** Reg X does not apply; Fannie Mae requires referral "no later than the 120th day of delinquency, **except in circumstances where the borrower submits a BRP shortly before the foreclosure referral**" (E-1.2-02, 05/10/2023). The exception is not open-ended discretion: its terms are the **E-3.2-04 ladder** (08/17/2016, verified 2026-09-10; full text at 13.4), which the deadline evaluator implements as suspension states on `FNMA_E1202_NONPR_REFER_BY_120` rather than as breaches. The servicer "may postpone foreclosure referral of property not secured by a principal residence beyond the 120th day of delinquency **upon receipt of a complete BRP**" — permissive at entry, mandatory once entered:
   - **(a) Complete BRP received** (before referral) ⇒ "must delay the foreclosure referral **up to 30 days** to complete an evaluation" — suspend the day-120 deadline for the 30-day evaluation window (`FNMA_E3204_NONPR_EVAL_30`, 13.4); resume on `lossmit.determination.sent` if no offer follows.
   - **(b) Retention offer made** (including a Trial Period Plan) on that complete BRP ⇒ "must delay the foreclosure referral **up to 14 days** to allow the borrower to respond"; acceptance may be verbal, written (including email), or by remitting the payment.
   - **(c) Acceptance within the 14 days** where the offer requires a payment ⇒ "must delay the foreclosure referral **until the last day of the month in which the first payment is due**."
   - **(d) First payment received** under a TPP, repayment plan or forbearance plan ⇒ "must delay the foreclosure referral **until the borrower breaches**" the plan; resume on the breach event (12.x), not on plan expiry.
   - **Limits.** "Verbal or written acceptance, without payment or execution of required documents, serves only to postpone foreclosure referral" (it does not cure the delinquency or close the deadline), and "the servicer **must not** postpone foreclosure referral due to the review of a **borrower inquiry**" — an inquiry, an incomplete BRP, or a BRP that is never completed is **not** an exception, so the day-120 deadline keeps running and breaches on schedule. E-3.2-01 likewise bars delay once "the time frame for the borrower to respond to an offer for a workout option has expired." An incomplete BRP is worked under 12.x's completeness cycle; only `lossmit.application.completed` (complete BRP) arms rung (a).
   Each rung writes a `foreclosure_deadline_suspensions` row with the E-3.2-04 rung, the arming event id and the resume condition, so the suspension is auditable against the compensatory-fee exposure in 13.5; the platform still sends 11.x early-intervention communications by policy (Reg X does not require them; Fannie Mae D2-2 does).
6. Rule-set swap: under `regx.lossmit.2024nprm`, `REGX_1024_41F2_PRE_FILING_APP_GATE` is replaced by `NPRM_REVIEW_CYCLE_GATE` (closed from any `lossmit.assistance.requested` until safeguard (i) or (ii)), the 120-day gate remains, and `SCRA_3937_FEES_IN_CAP_GATE`-style fee suppression (`late_charge_suppressions.reason=nprm_review_cycle`) engages — a versioned definition, not a code change.

#### Integrations
- None external; internal read APIs `foreclosure.gates.get(loan_id)` (used by `borrower-comms`, 4.x, and by the statement engine for the 1026.41(d)(8) "first notice or filing" flag, 7.1) and `foreclosure.gates.evaluate(loan_id, step)` (returns the ordered list of gate evaluations with reasons).
- Attorney network (13.6): every referral message carries `gates_snapshot` (all evaluations with timestamps) so the firm's file shows the servicer cleared 1024.41(f) before instruction; firm instruction `first_notice.authorized=false` until the platform emits `foreclosure.first_notice.authorized`.

#### Outputs and artifacts
- Events: `foreclosure.gate.opened{code}`, `foreclosure.gate.closed{code, reason}`, `foreclosure.gate.refused{command, code}` (each with an evaluation row), `foreclosure.first_notice.authorized`, `foreclosure.first_notice.filed` (from DRA/firm milestone; 13.6) — consumed by 7.1 (statement flag), 5.4 (status code 43/71), 8.x.
- No borrower notice is generated by 13.1 itself; the 1024.39(b) written notice (11.2) and 1024.40 personnel scripts (4.x) state the referral circumstances.
- Records: gate evaluations, `agent_decisions` for any exception recommendation, and the "gates cleared" snapshot appended to the foreclosure file (13.3).

#### AI agent design (AI-first)
`foreclosure-ops` runs the gate evaluator deterministically (rules code, not model judgment); the model is used only to (a) resolve occupancy/principal-residence ambiguity from unstructured evidence (inspection narratives, borrower statements) and (b) draft the exception memo for due-on-sale/joining cases. Tools: `loan.get`, `delinquency.counters.get`, `lossmit.case.get`, `contacts.search`, `inspection.get`, `foreclosure.gates.evaluate`, `escalation.create`. Decision record (`agent_decisions`): `{loan_id, step, gate_results[], occupancy_evidence[], principal_residence_conclusion, confidence, rule_set_version, model_version, rationale}`. Guardrails: the agent cannot open a closed gate; it can only add evidence that changes an input; any conclusion that a property is *not* a principal residence with confidence < 0.9 is escalated to `human_agent` (servicing specialist) for verification before the non-principal-residence path is used. Escalations: `officer` for (f)(1)(ii)/(iii) exceptions (package: counsel memo, deed/transfer evidence or lienholder pleading, gate snapshot); `compliance-sentinel` on any refused command. Human path when AI is off: the same evaluator runs; a `human_agent` reviews occupancy exceptions from a queue.

#### Edge cases and failure modes
- Transfer-in mid-delinquency (1.3): counters seeded from the transferor's earliest unpaid due date, never from the transfer date; transferor's first filing (if made) carries as `foreclosure.first_notice.filed` with evidence; K2 gate applies.
- Payment reversal (NSF) after the gate closed: re-evaluate — the gate re-opens immediately if days ≥ 121 (no fresh 120-day wait), because the delinquency never ended.
- Trial-period plan: delinquency continues (12.x); (f)(2) gate stays closed while the borrower performs; failure → exit (iii).
- Bankruptcy: the stay gate is independent; days keep counting.
- SCRA: `SCRA_3953C_FC_PROTECTION_GATE` closes `first_notice` regardless of the 120 days; the DMDC check is mandatory before referral (13.8).
- Successor in interest: a confirmed successor's application counts for (f)(2) (4.4; 1024.30(d)); a *potential* successor's request is logged and, under the NPRM rule set, honoured (research/00a §1.2 item 10).
- Mixed occupancy (2–4 units, borrower occupies one): principal residence.
- Due-on-sale exception used while the transferee is a confirmed successor who assumed: not available (no violation) — evaluator refuses.
- Rule-set flip mid-case: evaluations record `rule_set_version`; open gates are re-evaluated on the effective date and the difference reported.

#### Test cases and acceptance criteria
- 13.1-T1 Given due date Jan. 1, 2026 unpaid, When the sweep runs May 1, Then gate closed (day 120); When May 2, Then open and `foreclosure.gate.opened` emitted once.
- 13.1-T2 Given day 121 open and a full payment credited to Jan. 1 on May 3, Then gate closes (anchor Feb. 1, days 91) and re-opens June 2.
- 13.1-T3 Given non-principal residence, When `foreclosure.refer` at day 100, Then `REGX_1024_41F1_120_DAY_GATE=not_applicable`, `FNMA_E1202_NONPR_REFER_BY_120` due day 120, Fannie Mae/state gates still evaluated.
- 13.1-T3a **(E-1.2-02 BRP exception ladder)** Given a non-principal-residence loan at day 118 and a **complete** BRP received day 119, Then `FNMA_E1202_NONPR_REFER_BY_120` is **suspended** (not breached) for the 30-day evaluation; a retention offer on day 130 extends the suspension 14 days; acceptance with a first payment due Feb. 1 extends it to Feb. 28; the first TPP payment extends it until `lossmit.plan.breached`; each rung writes a `foreclosure_deadline_suspensions` row and no sev-2 fires while suspended.
- 13.1-T3b **(exception boundaries)** Given the same loan but the borrower sends only a **written inquiry**, or a BRP that is still **incomplete** at day 120, Then no suspension is written, the deadline breaches on day 120 with sev 2 and 13.5 exposure; and given an offer whose 14-day response window expires with no acceptance, Then the suspension ends that day (E-3.2-01: no delay once the response time frame has expired) rather than continuing.
- 13.1-T4 Given occupancy unknown, Then treated as principal residence; escalation to `human_agent` if the model concludes otherwise with confidence 0.85.
- 13.1-T5 Given complete application received day 100 and determination "ineligible" sent day 118 with 14-day appeal window, When referral attempted day 121, Then refused by `REGX_1024_41F2_PRE_FILING_APP_GATE` until day 133 (window expiry) or appeal denial.
- 13.1-T6 Given a due-on-sale violation recorded by `officer` with counsel memo at day 60, When `foreclosure.first_notice.authorize{ground=due_on_sale}`, Then allowed; When `{ground=default}`, Then refused.
- 13.1-T7 Given NY property, day 121 reached but §1304 notice mailed only 50 days ago, Then referral allowed (policy) but `first_notice.authorize` refused by `STATE_PREFC_NOTICE_GATE:NY` until day 90 after mailing and §1306 filing evidenced.
- 13.1-T8 Given a referral attempt while the gate is closed, Then command refused, `foreclosure.gate.refused` written, sev-1 escalation, and no message leaves for the attorney network.
- 13.1-T9 Given rule set flipped to `regx.lossmit.2024nprm` on an effective date, Then evaluations after that date reference the new gate codes and a diff report is produced.
- 13.1-T10 Given a transfer-in with transferor first filing evidenced, Then no second "first notice" is authorized and the 7.1 statement flag is true from boarding.

#### Audit and evidence
Every evaluation row (inputs, rule-set version, result) is immutable; the foreclosure file (13.3) includes the day-121 computation with the due-date history, occupancy evidence, application timeline from 12.x, and the `foreclosure.first_notice.authorized` event with the firm's acknowledgment — the exact chain a RESPA §6(f) plaintiff or a state examiner tests. Compliance Sentinel's daily report lists gate refusals and any exception approvals with the approving `officer`.

### Open questions / decisions
1. Gate referral (not only filing) for principal residences — **default: yes** (E-1.2-02 requires it anyway).
2. Unknown occupancy ⇒ principal residence — **default: yes**.
3. Whether to send Reg X-style early-intervention notices on non-principal residences — **default: yes** (Fannie Mae D2-2 outreach applies; no Reg X liability created).
4. Who approves (f)(1)(ii)/(iii) exceptions — **default: partner `officer` with Supermortgage counsel memo**.

### Sources
- 12 CFR 1024.41 (eCFR, current as of Sept. 8, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.41 — verified 2026-09-09.
- 12 CFR 1024.30 (scope; current as of Sept. 3, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.30 — verified 2026-09-09.
- 12 CFR 1024.40 (current as of Sept. 8, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.40 — verified 2026-09-09.
- Official Interpretations, comments 41(f)-1, 41(b)(3)-1/-2, 41(g)-1..5: https://www.consumerfinance.gov/rules-policy/regulations/1024/41/ — verified 2026-09-09.
- Fannie Mae Servicing Guide E-1.2-02 (05/10/2023): https://servicing-guide.fanniemae.com/svc/e-1.2-02/timing-foreclosure-referral-mortgage-loans-generally — verified 2026-09-09, re-verified 2026-09-10 for the non-principal-residence BRP exception (Aug. 12, 2026 edition).
- Fannie Mae Servicing Guide E-3.2-04, *Postponing Foreclosure Referral for Mortgage Loans Not Secured by a Principal Residence* (08/17/2016): https://servicing-guide.fanniemae.com/svc/e-3.2-04/postponing-foreclosure-referral-mortgage-loans-not-secured-principal-residence — verified 2026-09-10; supplies the operative terms of the E-1.2-02 exception (rule 5; full ladder in 13.4).
- E-3.2-02 (11/12/2014): https://servicing-guide.fanniemae.com/svc/e-3.2-02/initiating-foreclosure-proceedings-first-lien-conventional-mortgage-loan — verified 2026-09-09.
- D1-3-01 (04/08/2026): https://servicing-guide.fanniemae.com/svc/d1-3-01/evaluating-impact-disaster-event-and-assisting-borrower — verified 2026-09-09.
- research/00a §1.1–1.4 (NPRM status, live contact), research/00b (adapters).
