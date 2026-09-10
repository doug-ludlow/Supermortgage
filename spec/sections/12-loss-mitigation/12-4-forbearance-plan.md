# 12.4 — Forbearance plan

| Attribute | Value |
|---|---|
| Section | 12 — Loss Mitigation |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | On hardship (temporary, unresolved hardship after QRPC; disaster hardship without QRPC) |
| Governing source | FNMA D2-3.2-01 |
| Key deadlines | QRPC contact 10–45 days before plan end |
| Timers | `FNMA_D2205_EVAL_NOTICE_FORB`, `FNMA_D23201_FORB_COMBINED_36M`, `FNMA_D23201_FORB_EXPIRY_DISPOSITION`, `FNMA_D23201_FORB_INCREMENT_MAX_3M`, `FNMA_D23201_FORB_MBS_MATURITY`, `FNMA_D23201_FORB_PREEXPIRY_CADENCE`, `FNMA_D23201_FORB_PREEXPIRY_CONTACT_30`, `FNMA_D23201_FORB_REDUCED_PAYMENT_EOM`, `FNMA_D23204_POSTFORB_DEFERRAL_SOLICIT_15`, `FNMA_D23206_POSTFORB_FLEX_SOLICIT_15`, `FNMA_F121_STATUS_09_BD2`, `FNMA_LL202601_FORB_CUMULATIVE_12M`, `FNMA_LL202601_FORB_DELQ_12M`, `FNMA_LL202601_FORB_EXCEPTION_RESPONSE`, `REGX_1024_41B1_DILIGENCE_RESUME`, `REGX_1024_41C2III_PERFORMANCE_HOLD`, `REGX_1024_41C2III_SHORTTERM_NOTICE_5` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Loss Mit |
| Trigger & frequency | On hardship (temporary, unresolved hardship after QRPC; disaster hardship without QRPC) |
| Governing source (blueprint) | FNMA D2-3.2-01 |
| Key deadlines (blueprint) | QRPC contact 10–45 days before plan end |
| Data/artifacts | Plan doc; BRP not required |
| Systems | SMDU |
| Automation class (blueprint) | b |
| SoR / Sub | Sub |
| Nuances (blueprint) | (blank in source) |

### Verified requirement (as of 2026-09-09)

**Sources verified:** Fannie Mae D2-3.2-01 Forbearance Plan (04/08/2026, incorporating LL-2026-01 effective May 1, 2026); LL-2026-01 (Feb. 11, 2026); D1-3-01 (04/08/2026); F-1-21 (10/11/2023) status code 09; F-2-02 (no forbearance incentive); D2-3.2-04/-06 post-forbearance solicitation rules; 12 CFR 1024.41(c)(2)(iii) and comments 41(c)(2)(iii)-1..-6, 41(b)(1)-4.iii; Servicing Platform FAQ Q64 (SMDU forbearance case management Q1 2027).

**Eligibility (D2-3.2-01).** The servicer must achieve **QRPC** (D2-2-01) before offering a forbearance plan, except for disaster hardships (below). "The servicer is authorized to evaluate the borrower for a forbearance plan without receiving a complete BRP." Eligible hardships are those in Form 710. The property must be a **principal residence** (disaster-affected second homes and investment properties excepted) and must not be condemned or abandoned (vacant is acceptable).

**Terms (D2-3.2-01 / LL-2026-01).** "The borrower's monthly payment must be reduced or suspended during the forbearance plan term"; reduced payments must be received by the last day of the month unless mitigating circumstances justify late receipt. Plan terms must be **in increments of no greater than three months at a time**; the cumulative term must not **exceed 12 months as measured from the start date of the initial forbearance plan**; the plan must not be extended beyond a date that would result in the loan becoming **greater than 12 months delinquent**; extensions beyond these limits require Fannie Mae's **prior written approval** via the **Forbearance Exception Request Template** (each disaster extension beyond the limits is submitted case by case). For an MBS loan the plan must not extend beyond the last scheduled payment date. A combined forbearance-plus-repayment arrangement offered initially must not exceed **36 months**. **Late charges must not accrue or be collected during the plan**; if the borrower defaults on the plan, late charges may accrue from the date of default. Plan details are provided with an **Evaluation Notice** (D2-2-05).

**During the term.** "The servicer must begin attempts to contact the borrower no later than 30 days prior to the expiration of any forbearance plan term and must continue outreach attempts until either QRPC is achieved or the forbearance plan term has expired." If QRPC is achieved: determine whether the hardship is resolved, the borrower's intention regarding the property, and whether a complete BRP is needed for other options. If QRPC is not achieved: evaluate for a **Payment Deferral** (D2-3.2-04) and solicit if eligible (within **15 days after expiration**), otherwise evaluate for a **Flex Modification** (D2-3.2-06) and solicit (within 15 days). On completion one of the following must occur: reinstatement, approval for another workout, payoff, or referral to foreclosure. **Mandatory termination** if the borrower fails the plan terms, any eligibility criterion is no longer satisfied, the hardship is resolved, or the borrower requests termination.

**Disaster flexibilities (D2-3.2-01, D1-3-01, LL-2026-01).** Initial term of **up to 3 months without QRPC** if the property is in a FEMA-Declared Disaster Area eligible for Individual Assistance, the loan was current or less than two months delinquent when the disaster occurred, and the loan is at least one month delinquent; QRPC attempts must continue during that term; requests beyond the limits go through the exception template.

**Reg X interplay.** Comment 41(c)(2)(iii)-1: a *short-term* payment forbearance is one that forbears payments due over **no more than six months**, regardless of the repayment period; offered on an incomplete application it triggers the written terms notice within ≤5 federal business days (comment -6; content per comment -5: specific payment amounts and due dates, whether the loan will be current at the end, estimates flagged) and the (c)(2)(iii) foreclosure protection while the borrower performs; diligence may be suspended while the borrower performs and requests nothing further, but must resume on breach/request, and the servicer must contact a still-delinquent borrower near the end about completing the application (comment 41(b)(1)-4.iii). A forbearance that forbears **more than six months** of payments is not "short-term" — to offer it on an incomplete application the servicer must rely on (c)(2)(ii) (significant period without progress after diligence) or comment 41(c)(2)(i)-1 (offer not based on submitted information); on a complete application it is simply an offered option. §1024.39 early-intervention notices continue during forbearance under the current rule (the NPRM's partial exemption is flag-only). §1024.41(j): a borrower performing under a forbearance agreement may not be referred to foreclosure (small servicers) — the platform applies the same rule to all loans via the (c)(2)(iii)/(f)(2)(iii)/(g)(3) performance holds.

**Reporting.** Delinquency status code **09 (Forbearance)** in the monthly F-1-21 file (BD2) until forbearance case management moves into SMDU (Servicing Platform FAQ Q64: **Q1 2027**; no historical migration); LL-2026-05 expands forbearance attributes. No P&I remittance change for A/A; S/S loans enter Stop Delinquency Advance after four consecutive missed payments (C-3-01; 5.x). No incentive fee (F-2-02). Credit reporting per 8.x (CRRG forbearance conventions).

**Discrepancies vs. blueprint row.** (1) The Guide requires contact attempts to *begin no later than 30 days before* term expiration and continue to expiry — not "10–45 days". (2) The blueprint omits LL-2026-01's 3-month increments, 12-month cumulative cap, 12-months-delinquent cap and exception template; the late-charge prohibition; the post-forbearance deferral/Flex Mod solicitation clocks; and the Reg X six-month "short-term" boundary. (3) "Systems: SMDU" is future-dated (Q1 2027); today the plan is reported by status code.

### Operational prerequisites
- **Partner policy elections:** whether reduced-payment forbearance is offered (vs. suspension only); "mitigating circumstances" policy for late reduced payments; disaster policy; exception-request authority (who signs the Forbearance Exception Request Template — `officer` or `fnma_portal_operator`) — partner + Supermortgage.
- **Templates:** `NTC_FNMA_D23201_FORB_PLAN` (Evaluation Notice with plan terms; doubles as `NTC_REGX_41C2III_SHORTTERM_TERMS` when offered on an incomplete application), `NTC_FNMA_D23201_FORB_EXTENSION`, `NTC_FNMA_D23201_FORB_EXPIRY_OPTIONS`, `NTC_FNMA_D23201_FORB_TERMINATION`.
- **Fee engine flag** to suppress late-charge assessment during plans (2.x) and the QRPC data capture (11.3) feeding hardship/intent/ability fields.
- **Forbearance Exception Request Template** (Fannie Mae form; submission channel per current Fannie Mae instructions **[PARTIALLY VERIFIED — template exists per LL-2026-01; channel not confirmed]**).
- **Metro 2 forbearance reporting rules** loaded (8.x).

### Build spec
#### Inputs and triggers
- `contact.qrpc.achieved{hardship_temporary=true, resolved=false}` (11.3) or 12.2 hierarchy result `forbearance` → offer.
- `disaster.declared{fema_ia=true}` overlay (9.x/D1-3-01) + delinquency ≥1 month + loan current/<2 months delinquent at disaster date → offer without QRPC.
- `workout_plan.term.expiring{days=30}` (timer) → pre-expiry outreach.
- `payment.received` (2.x) → reduced-payment performance tracking; `workout_plan.payment.missed` → default handling.
- `workout_plan.extension.requested` (borrower) → extension evaluation.
- `lossmit.application.completed` during a plan → 12.2 full evaluation (plan continues).

#### Data model
- `workout_plans`: `id`, `loan_id`, `case_id` (case_type `forbearance`), `plan_type='forbearance'`, `basis` (12.2 basis enum), `hardship_code` (F-1-21 reason code), `disaster_event_id?`, `qrpc_contact_id?`, `start_date`, `current_term_end date`, `cumulative_months int`, `initial_start_date` (anchor for the 12-month cap), `delinquency_months_at_start`, `projected_delinquency_at_end`, `payment_mode` ∈ {suspended, reduced}, `reduced_amount_cents bigint?`, `status`, `exception_request_id?`, `evaluation_notice_id`, `regx_short_term bool` (forborne months ≤6), `regx_terms_notice_id?`, `smdu_case_id?` (post-Q1 2027).
- `workout_plan_terms`: `plan_id`, `term_no`, `term_start`, `term_end`, `months` (≤3), `approved_by` (agent/reviewer/fnma_exception), `notice_id`.
- `workout_plan_schedule`: `plan_id`, `due_date`, `expected_amount_cents` (0 if suspended), `received_amount_cents`, `received_at`, `status` ∈ {due, met, missed, excused}.
- `fnma_exception_requests`: `id`, `loan_id`, `kind='forbearance_extension'`, `package_document_id`, `submitted_at`, `channel`, `decision`, `decided_at`, `evidence_document_id`.
- Fees engine: `fees.late_charge_suppressed_by_case_id`.

#### State machine
`workout_plans.status`: `offered` → `active` (borrower acceptance: verbal/written/first reduced payment; Evaluation Notice sent) → `extension_pending` → `active` (new term) | `expired` → `disposition_pending` (reinstate / next workout / payoff / referral) → `closed{reinstated, converted_deferral, converted_flexmod, converted_repayment, liquidation, referred_foreclosure, paid_off}`; `active` → `terminated{failed_terms, ineligible, hardship_resolved, borrower_request}`; `offered` → `declined|expired_offer`. Guards: `assertIncrementLe3Months`, `assertCumulativeLe12Months`, `assertDelinquencyLe12MonthsAtEnd`, `assertMbsMaturity`, `assertCombinedLe36Months` (with repayment), `assertQrpcOrDisaster`, `assertRegxBasis` (short-term vs. complete application vs. (c)(2)(ii)).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_D23201_FORB_INCREMENT_MAX_3M` | not_before_gate (term guard) | `workout_plan.term.create` | — | term months ≤3 | — | command refused |
| `FNMA_LL202601_FORB_CUMULATIVE_12M` | not_before_gate | same | `initial_start_date` | cumulative ≤12 `months` | — | refused unless `fnma_exception_requests.decision=approved` |
| `FNMA_LL202601_FORB_DELQ_12M` | not_before_gate | same | — | projected `fnma_delinquency_status` at term end ≤12 months | — | same |
| `FNMA_D23201_FORB_MBS_MATURITY` | not_before_gate | same (MBS loans) | — | term_end ≤ last scheduled payment date | — | refused |
| `FNMA_D23201_FORB_COMBINED_36M` | not_before_gate | plan created with repayment component | — | combined ≤36 `months` | — | refused |
| `FNMA_D2205_EVAL_NOTICE_FORB` | deadline | `workout_plan.offered` | offer date | 5 `calendar_days` (D2-2-05 "within 5 days of decision") | `notice.sent{NTC_FNMA_D23201_FORB_PLAN}` | `officer` sev-2 |
| `REGX_1024_41C2III_SHORTTERM_NOTICE_5` | deadline | forbearance offered on an incomplete application (short-term) | offer date | 5 `business_days_federal` | same notice (dual-cited) | `officer` sev-1 |
| `FNMA_D23201_FORB_REDUCED_PAYMENT_EOM` | deadline (per month, reduced mode) | `workout_plan_schedule.due_date` | due date | last calendar day of the month, 23:59 servicer-local | `payment.received` ≥ expected | `workout_plan.payment.missed` → termination review |
| `FNMA_D23201_FORB_PREEXPIRY_CONTACT_30` | deadline | `workout_plan_terms.term_end` set | `term_end` | −30 `calendar_days` (attempts must have begun) | `contact` attempt logged with `purpose=forb_preexpiry` | sev-2; auto-dial/SMS per consents |
| `FNMA_D23201_FORB_PREEXPIRY_CADENCE` | recurring | from day −30 | — | every 3 `calendar_days` until QRPC or expiry (policy; D2-2-02 weekly minimum) | `contact.qrpc.achieved` or expiry | — |
| `FNMA_D23201_FORB_EXPIRY_DISPOSITION` | deadline | `term_end` | `term_end` | 0 (disposition decided by expiry; executed within 15 days) | `workout_plan.closed` or next-workout event | sev-2 |
| `FNMA_D23204_POSTFORB_DEFERRAL_SOLICIT_15` | deadline | `workout_plan.expired{qrpc=false, deferral_eligible=true}` | `term_end` | 15 `calendar_days` | `notice.sent{NTC_FNMA_D23204_SOLICIT_POST_FORB}` | sev-2 |
| `FNMA_D23206_POSTFORB_FLEX_SOLICIT_15` | deadline | `workout_plan.expired{qrpc=false, deferral_eligible=false, flex_eligible=true}` | `term_end` | 15 `calendar_days` | `notice.sent{NTC_FNMA_D23206_SOLICIT_STREAMLINED}` | sev-2 |
| `REGX_1024_41C2III_PERFORMANCE_HOLD` | not_before_gate | `workout_plan.active` (short-term on incomplete app) or any plan (policy) | — | while performing | `workout_plan.terminated/expired` | 13.x refuses referral/motion/sale (`foreclosure_holds{kind=fnma_plan_performing}`) |
| `REGX_1024_41B1_DILIGENCE_RESUME` | deadline | `workout_plan.payment.missed` or `lossmit.assistance.requested` during a plan | event | 0 (resume immediately) + 30-day pre-expiry contact | diligence contact logged | sev-3 |
| `FNMA_F121_STATUS_09_BD2` | recurring | month-end with active plan | BD2 | 2 `business_days_fannie_et` | investor event accepted (5.x) | sev-2 (5.x) |
| `FNMA_LL202601_FORB_EXCEPTION_RESPONSE` | deadline (SLA) | `fnma_exception_requests.submitted` | submission | 10 `business_days_fannie_et` (policy follow-up; Fannie Mae states no SLA) | decision recorded | follow-up task |

#### Business rules and calculations
1. **Offer construction:** term = min(3, months requested, months to the 12-month cumulative cap, months to the 12-months-delinquent cap, MBS remaining term); payment mode per QRPC ability (suspended if ability = 0; reduced otherwise, with the reduced amount = the borrower's stated affordable amount rounded down to whole dollars, applied per the 2.x partial-payment rule — reduced payments sit in `suspense/unapplied` until a full contractual installment accrues, unless the plan document specifies application; default: suspense).
2. **Caps (worked example "3+3+3"):** payments due 2026-08-01 and 2026-09-01 unpaid (2 months delinquent on 2026-09-15 QRPC). Term 1: 2026-10-01 → 2026-12-31 (3 months, suspended). Term 2: 2027-01-01 → 2027-03-31. Term 3: 2027-04-01 → 2027-06-30 (cumulative 9 months). Delinquency at 2027-06-30 = Aug 2026…Jun 2027 = **11 months** (`fnma_delinquency_status`). A fourth 3-month increment would reach cumulative 12 (allowed) but 14 months delinquent (not allowed) → the engine offers **1 month** (to 2027-07-31, 12 months delinquent) and requires the exception template for anything more. Reg X: forborne payments after term 2 = 6 (short-term boundary); term 3 forbears months 7–9 → `regx_short_term=false` → term 3 requires a complete-application basis, a (c)(2)(ii) discretionary basis (documented: diligence performed, no progress), or a servicer-initiated basis; the engine records which.
3. **Late charges:** `fees.assess_late_charge` is refused while `workout_plans.status='active'`; on `terminated{failed_terms}` late charges accrue from the default date only (no retroactive assessment for plan months).
4. **Pre-expiry evaluation:** at term_end −30, run the 12.2 hierarchy pre-screen (QRPC-dependent): hardship resolved + can reinstate → reinstatement; resolved + affordable plan → repayment (12.5); resolved + cannot afford plan → deferral (12.6) if 2–6 months delinquent … else Flex Mod (12.8); unresolved → extension within caps.
5. **Disaster:** initial term ≤3 months without QRPC when the three conditions hold; `hardship_code=019` (casualty loss) or other; QRPC attempts every 7 days minimum (D2-2-02).
6. **Escrow:** T&I continue to be advanced (3.x); no escrow analysis at forbearance start; shortage handled at exit workout.
7. **Combined offers:** an initial forbearance + repayment arrangement (e.g., 3 months forbearance then 6-month repayment) is one plan with two components and the 36-month combined guard.

#### Integrations
- **Fannie Mae reporting:** status 09 with reason code in the F-1-21 file (5.x); from Q1 2027, SMDU forbearance case (`smdu.plan_cases` flag; B2B fields **[UNVERIFIED — spec not yet published]**); LL-2026-05 forbearance attributes in the Delinquency Reporting event.
- **Exception requests:** Forbearance Exception Request Template prepared by the agent; submission channel per Fannie Mae instruction (email/portal) executed by `fnma_portal_operator` if portal-only.
- **Credit bureaus:** Metro 2 forbearance reporting (8.x).
- **Telephony/SMS/email:** pre-expiry outreach under TCPA consents.
- **Cashiering:** reduced-payment schedule to 2.x; `fees` suppression.

#### Outputs and artifacts
- `NTC_FNMA_D23201_FORB_PLAN` (Evaluation Notice; D2-2-05; §1024.41(c)(2)(iii) content when on an incomplete application): term dates, suspended/reduced amounts and due dates, that the loan will **not** be current at the end and the arrears will be addressed by a later option, estimates flagged, no late charges during the plan, credit-reporting statement, that the application was incomplete/other options may be available/may complete the application (when applicable), next steps 30 days before expiry, SPOC and counselor blocks.
- `NTC_FNMA_D23201_FORB_EXTENSION`, `NTC_FNMA_D23201_FORB_EXPIRY_OPTIONS` (what happens next; deferral/Flex Mod solicitations follow), `NTC_FNMA_D23201_FORB_TERMINATION` (reason; late charges from default date).
- Records: `workout_plans`, `workout_plan_terms`, `workout_plan_schedule`, `fnma_exception_requests`, `foreclosure_holds{kind=fnma_plan_performing}`, investor events (09), `agent_decisions{kind=lossmit.forbearance}`.
- Ledger: no capitalization; reduced payments to `suspense/unapplied` per 2.x; late-charge suppression.

#### AI agent design (AI-first)
- **Agent:** `lossmit-underwriter` sub-role `plans`, working with `borrower-comms` (QRPC dialog) and `default-collections`. Tools: `workout_plan.*`, `calendar.months`, `delinquency.project`, `notice.render_send`, `fees.suppress`, `fnma.status_code.report`, `exception_request.prepare`, `contacts.*`, `timers.*`.
- **Decision record:** `{plan_id, basis, qrpc_contact_id or disaster_conditions, hardship, ability, term computation{requested, cap_cumulative, cap_delinquency, mbs_cap, chosen}, payment_mode, regx_short_term, regx_basis, notices, rationale}`.
- **Guardrails:** cannot create a term breaching any gate; cannot suspend diligence unless the (c)(2)(iii) conditions are met; cannot terminate for a missed reduced payment without checking "mitigating circumstances" policy and logging; must schedule the −30-day outreach at term creation.
- **Escalations:** exception requests → `officer`/`fnma_portal_operator` (package: loan data, hardship, delinquency projection, prior terms, recommendation); borrower asks for human → `human_agent`; disaster foreclosure referral needs Fannie Mae approval (13.4).
- **Disclosure/consent:** AI voice disclosure; TCPA consents for outbound cell calls/SMS.
- **AI-off:** human collectors use the same plan builder and templates.

#### Edge cases and failure modes
- **Borrower pays more than expected or reinstates mid-plan:** plan closes `reinstated`; suppression lifted prospectively.
- **Application completes mid-plan:** 12.2 full evaluation runs inside 30 days; plan continues; holds continue.
- **Transfer-out mid-plan (17.4):** plan terms, schedule and cap anchors in the goodbye package; transferee must honor (CA §2924.11(e)).
- **Transfer-in (1.7):** import `initial_start_date` and cumulative months from the transferor (cap continuity).
- **Bankruptcy:** plan may continue with counsel/trustee awareness; Chapter 13 post-petition arrears interplay (E-2.x).
- **SCRA:** Military Indulgence preferred (12.9 note); 6% cap applies.
- **MBS loan near maturity:** term capped at last scheduled payment date.
- **Stop Delinquency Advance (S/S):** no effect on the plan; 5.x handles remittance.
- **Vendor/telephony outage during the −30-day window:** letters/SMS/email fallback; attempts logged.
- **Retro-correction:** an erroneously terminated plan is reinstated by a reversing case event; late charges assessed in error are reversed (2.x).

#### Test cases and acceptance criteria
- **12.4-T1:** Given QRPC on 2026-09-15 (temporary, unresolved hardship; 2 months delinquent), when a plan is offered, then term 1 = 2026-10-01..2026-12-31, Evaluation Notice within 5 days, status 09 reported at BD2 of November, late charges suppressed.
- **12.4-T2 (3+3+3 caps):** extensions to 2027-03-31 and 2027-06-30 succeed; a 3-month fourth extension is refused (14 months delinquent); a 1-month extension to 2027-07-31 succeeds; a 2-month request generates an exception package.
- **12.4-T3 (short-term boundary):** term 3 flagged `regx_short_term=false`; the engine requires a recorded basis (complete application / (c)(2)(ii) / servicer-initiated) before activation.
- **12.4-T4 (pre-expiry):** outreach begins by 2026-12-01 for a 2026-12-31 term end and continues at least every 3 days; QRPC on 2026-12-10 → hierarchy pre-screen executed the same day.
- **12.4-T5 (no QRPC at expiry):** deferral-eligible (4 months delinquent) → post-forbearance deferral solicitation by 2027-01-15; if deferral-ineligible → Flex Mod solicitation by 2027-01-15.
- **12.4-T6 (disaster):** FEMA IA area, current at disaster, 1 month delinquent → 3-month plan without QRPC; QRPC attempts logged every ≤7 days.
- **12.4-T7 (reduced payment miss):** reduced payment not received by month-end → mitigating-circumstances check; termination notice; late charges from the default date only.
- **12.4-T8 (MBS maturity):** loan maturing 2027-02-01 → term capped at 2027-01-31.
- **12.4-T9 (holds):** 13.3 referral command refused while the plan is active; allowed 1 BD after `terminated{failed_terms}` (subject to 13.1).
- **12.4-T10 (Q1 2027 flag):** with `smdu.plan_cases=on`, the plan creates an SMDU forbearance case and stops emitting code 09 in the legacy file.

#### Audit and evidence
QRPC transcript/record, plan decision record with cap computations, Evaluation Notice with proof, schedule and payment evidence, outreach attempts (dates/modes/results), exception request package and Fannie Mae decision, status-code submissions and acks, hold history, late-charge suppression log.

### Open questions / decisions
1. **Reduced-payment forbearance** (vs. suspension only). Default: offer reduced payments when the borrower states partial ability; funds to suspense until a full installment accrues (2.x), disclosed in the plan notice.
2. **Basis for month-7+ forbearance on incomplete applications.** Default: (c)(2)(ii) discretionary evaluation after documented diligence; counsel confirmation.
3. **Pre-expiry cadence.** Default: every 3 days from −30 (exceeds D2-2-02's weekly minimum).
4. **Disaster second-home/investor forbearance QRPC rule.** Default: QRPC required unless the three no-QRPC conditions hold.

### Sources
- Fannie Mae D2-3.2-01: https://servicing-guide.fanniemae.com/svc/d2-3.2-01/forbearance-plan (04/08/2026; verified 2026-09-09)
- LL-2026-01: https://singlefamily.fanniemae.com/media/document/pdf/lender-letter-ll-2026-01-updates-retention-workout-options-and-disaster-related-foreclosure (Feb. 11, 2026; verified 2026-09-09)
- Fannie Mae D1-3-01: https://servicing-guide.fanniemae.com/svc/d1-3-01/evaluating-impact-disaster-event-and-assisting-borrower (04/08/2026; verified 2026-09-09)
- Fannie Mae F-1-21 status codes: https://servicing-guide.fanniemae.com/svc/f-1-21/reporting-delinquent-mortgage-loan-fannie-maes-servicing-solutions-system (10/11/2023; verified 2026-09-09)
- Fannie Mae F-2-02: https://servicing-guide.fanniemae.com/svc/f-2-02/incentive-fees-workout-options (verified 2026-09-09)
- 12 CFR 1024.41(c)(2)(iii) and comments: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.41 ; https://www.consumerfinance.gov/rules-policy/regulations/1024/interp-41/ (verified 2026-09-09)
- Servicing Platform FAQ Q64–Q65: https://singlefamily.fanniemae.com/applications-technology/servicing-platform/faqs-upcoming-loan-management-changes (verified 2026-09-09)
