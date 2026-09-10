# 5.7 — Delinquent loan status reporting

| Attribute | Value |
|---|---|
| Section | 5 — Investor Reporting & Remittance (Fannie Mae) |
| Automation class | a |
| Trigger & frequency | Monthly |
| Governing source | FNMA D2-4-01; F-1-22 |
| Key deadlines | By reporting cycle |
| Timers | `FNMA_D2401_DQ_MGMT_ACTION_GATE`, `FNMA_F121_AW_ONE_MONTH`, `FNMA_F121_DQ_CORRECT_CD10`, `FNMA_F121_DQ_EXCEPTIONS_BD4`, `FNMA_F121_DQ_FINAL_CD11`, `FNMA_F121_DQ_REPORT_BD2`, `FNMA_F121_DQ_SNAPSHOT_EOM`, `FNMA_F125_RECLASS_DESELECT_CD15`, `FNMA_LL202605_DQ_EVENT_NEXTBD_0300`, `FNMA_LL202605_DQ_PMT_REMINDER_CD23`, `SM_DQ_SMDU_DRA_CONSISTENCY_BD1` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Investor Reporting |
| Trigger & frequency | Monthly |
| Governing source (blueprint) | FNMA D2-4-01; F-1-22 |
| Key deadlines (blueprint) | By reporting cycle |
| Data/artifacts | Delinquency status codes |
| Systems | Servicing Solutions System |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: file carries the partner's 9-digit servicer number; Supermortgage derives codes from its default/loss-mit/bankruptcy/foreclosure state and transmits by B2B; the partner is liable for accuracy (compensatory fees) |
| Nuances (blueprint) | [cropped in source] — reconstructed: BD2 deadline; loans with delinquency-management actions must be reported even if current; code hierarchy; effective/completion dates; exceptions BD4 and corrections through CD10; AMN replaced by the Servicing Platform delinquency event on Mar. 15, 2027 |

### Verified requirement (as of 2026-09-09)

**D2-4-01, Reporting a Delinquent Mortgage Loan to Fannie Mae (06/10/2020):** the servicer must "electronically transmit a file extract of its delinquent mortgage loans to Fannie Mae each month," including loans on which delinquency-management actions were taken even if the loan is current or less than 30 days delinquent, following **F-1-21** (workouts are reported per D2-4-02/F-1-22 through SMDU — the blueprint's "F-1-22" is the workout procedure, not the delinquency-status procedure).

**F-1-21, Reporting a Delinquent Mortgage Loan via Fannie Mae's Servicing Solutions System (10/11/2023):**
- *When:* "By the second business day of each month, the servicer must report delinquency status information … for any mortgage loan, including regular servicing option MBS mortgage loans, that was either 30 or more days delinquent as of the last day of the preceding month" or subject to delinquency-management actions during the prior month "even if the mortgage loan was current or less than 30 days delinquent."
- *What:* the status code "reflecting the latest action taken," its effective date (required for 09, 12, 15, 17, 80, BF, AW), the completion date (required for 09, 12, 15, 17, BF), workout program type where applicable, and the reason code — "the one that appears to be the primary reason"; data must agree with the servicer's records and stay unchanged when nothing changed.
- *How:* "through Fannie Mae's servicing solutions system or via business-to-business electronic file transfer" with identical layouts. **File layout:** pos 1–9 servicer number; 10 space; 11–20 Fannie Mae loan number; 21 space; 22–23 delinquency status code; 24 space; 25–27 reason code; 28 space; 29–36 default effective date (8N); 37 space; 38–45 default completion date (8N); 46 space; 47 forbearance program type code (0 = forbearance); 48 space; 49 imminent default indicator (1/0/space; required when pos 47 ≠ 0); 50 space; 51–61 forbearance program payment amount 9(8).99 ("the amount agreed to, not the actual amount received"); 62 space; 63–70 forbearance payment date; 71 space; 72–75 "Ninety Plus New Layout Indicator" (4 spaces); 76–80 spaces.
- *Hierarchy:* "when multiple delinquency status codes are applicable … use the appropriate delinquency status code in the highest priority": **Level 1** approved workouts — BF trial modification, 09 forbearance, 17 short sale approved/offer received, 12 repayment plan, 27 assumption, 28 modification, 29 charge-off, 32 military indulgence, 44 Mortgage Release; **Level 2** H5 complete BRP (only in the month received; a Level 1 code in the same cycle wins); **Level 3** bankruptcy — 3L Ch. 7 asset case, 3M property surrendered, 59 Ch. 12, 65 Ch. 7, 66 Ch. 11, 67 Ch. 13, 69 Ch. 13 plan post-petition; **Level 4** foreclosure-related — 20 reinstatement (partial reinstatement funds accepted in foreclosure), 24 drug seizure, 30 third-party sale, 31 probate, 33 contested/litigated foreclosure, 43 foreclosure (referred to attorney/trustee), 61 second-lien considerations, 63 VA refund, 71 foreclosure sale scheduled (effective = initially scheduled sale date), 94 judgment/decree entered, 95 foreclosure sale continued, BE title issue, BG pre-file mediation/mediation; **Level 5** collections — AW quality right party contact ("must only be reported for one month"; effective = QRPC date), 15 short sale approved/marketing, 42 delinquent no action (30+ days, no legal action, pre-QRPC), 80 breach letter sent (not yet referred; effective = letter date); **Level 6** 26 refinance, 49 assignment. Definitions: 09 effective = first month of suspension, completion = last month of forbearance; 12 effective = first scheduled plan payment, completion = last; BF effective = first day of the month the first trial payment is due, completion = last day of the month the trial ends; H5 effective = date the complete package was received.
- *Reason codes:* 001 death of borrower; 002 illness of borrower; 003 illness of family member; 004 death of family member; 005 marital difficulties; 006 curtailment of income; 007 excessive obligations/energy-environment costs; 008 abandonment of property; 009 distant employment transfer; 011 property problem; 012 inability to sell; 013 inability to rent; 014 military service; 015 other; 016 unemployment; 017 business failure; 019 casualty loss; 023 servicing problems; 026 payment adjustment; 027 payment dispute; 029 transfer of ownership pending; 030 fraud; 031 unable to contact borrower; INC incarceration.
- *Exceptions/corrections:* Delinquency Exception Summary/Details reports; "by the 10th calendar day of the month in which the exception report was issued, make corrections"; "on the 11th calendar day … receive … an updated final exception report." The 2026 Delinquency Reporting Calendar shows exception reports available on BD4–BD6 (e.g., Sept 4, Oct 5, Nov 5, Dec 4, 2026), final correction days CD10–12 (Sept 11, Oct 10, Nov 12, Dec 10) and final reports CD11–13 **[PARTIALLY VERIFIED — graphic calendar; load actual dates annually]**; reclass deselection windows CD11–15/16.

**System status (research/00a §2.3, §6.3; 00b F8):** HSSN workout functions retired Dec. 1, 2025 (SMDU); AMN remains the delinquency-status system until the **Servicing Platform Delinquency Reporting event** goes live **Mar. 15, 2027** (CIT Oct. 14, 2026–Feb. 12, 2027; cycles Oct 14–Nov 6, Nov 16–Dec 18, optional Jan 14–Feb 12; complete Cycle 1 or 2; B2B limited to existing B2B customers, API for direct integrations, UI for acting servicers). **LL-2026-05 / Reference Guide v1.0:** delinquency events are reported "the same day … no later than 3:00 a.m. ET on the next business day" for "loans that are past the late charge date, or loans with any delinquency-related activities"; each event carries one **Servicer Action Type** (Payment Reminder Notice, Outbound Contact Attempted, Quality Right Party Contact, Borrower Solicitation Package, Breach Letter Sent, Workout Option Solicitation, Borrower Response Package Received, Referred to Foreclosure, Modification Denial Under Appeal), up to five **Delinquency Status Types** (e.g., Assumption Exempt/Non-Exempt, Refinance, Assignment, Military Indulgence, bankruptcy chapters, Veterans Affairs–Refund, Partial Reinstatement, Drug Seizure, Probate, Contested/Litigated Foreclosure, Pre-file Mediation/Mediation, Title Issue in Progress) and up to five **Delinquency Reason Types** (e.g., Property Problem, Disaster Impact – FEMA-declared IA area, Casualty Loss, Borrower Declined to Provide a Reason; names, not numeric codes). Fatal rules: valid loan/servicer; reason conflicts (Property Problem/Disaster Impact/Casualty Loss mutually exclusive; "Borrower Declined" cannot pair); status conflicts (assumption/refinance/assignment set; Military Indulgence exclusions; foreclosure vs bankruptcy statuses); QRPC and Modification Denial Under Appeal require an existing reason type. Notifications (non-blocking): Payment Reminder Notice expected by CD23 at 1 period delinquent (2 for odd due dates); Outbound Contact/QRPC/Solicitation Package at 2 (3); Breach Letter at 3 (4); Workout Option Solicitation, BRP Received or Referred to Foreclosure at 5 (6) once the breach expiration has passed. Forbearance, repayment plan, trial modification, third-party sale, sale scheduled/continued and judgment are **no longer** reported in the delinquency event — they come from SMDU, Property 360 and DRA.

**Compensatory fees (A1-4.2-01):** delinquency status reporting is a separate monthly reporting activity subject to the late/inaccurate reporting ladder ($250/$50 per loan up to $5,000; $500 … $10,000; $1,000 … $15,000). Accurate status codes also underpin allowable-delay treatment in foreclosure timelines (A1-4.2-02/E-3.2-15 — Section 13.5).

**Discrepancies with the blueprint row:** the procedure is F-1-21 (F-1-22 is workouts); the deadline is BD2 with exceptions on BD4 and corrections through CD10, not merely "by reporting cycle"; loans with delinquency-management actions must be reported even when current; the "Servicing Solutions System" for this purpose is AMN (HSSN is retired) and will be replaced by the Servicing Platform delinquency event on Mar. 15, 2027 — build dual-rail.

Delinquency counter: this process uses **`fnma_delinquency_status`** (LPI-based, MBA convention: the installment due on the 1st unpaid at month-end makes the loan 30 days delinquent), not `regx_days_delinquent`.

### Operational prerequisites
- AMN access under the partner's servicer number (TM) and a System ID for B2B electronic file transfer of the delinquency file; the "Converting a Delinquent Reporting File for Bulk Submission" layout in the codec — Owner: partner CA / Supermortgage.
- Servicing Platform delinquency-event credentials and CIT enrollment (Delinquency Reporting UI CIT Environment access form; TSP Intake Form) by Oct. 14, 2026; Implementation Readiness Tracker entries; readiness checklists — Owner: Supermortgage.
- Section 11 (early intervention/collections), 12 (loss mitigation), 13 (foreclosure) and 14 (bankruptcy) state machines emitting the events the mapping consumes (QRPC, breach letter, referral, BRP received, trial/forbearance/repayment/deferral statuses, bankruptcy chapter/petition/plan events, sale scheduling from the attorney feed).
- SMDU reporting of forbearance/repayment/trial data (Section 12) so that AMN/SMDU views agree.

### Build spec
#### Inputs and triggers
- Month-end snapshot job (last calendar day 23:59 ET) computing `fnma_delinquency_status` per loan and collecting delinquency-management actions in the month: `contact.qrpc.established`, `notice.breach.sent`, `lossmit.brp.complete`, `lossmit.forbearance.started/ended`, `lossmit.repayment_plan.started/ended`, `lossmit.trial.started/ended`, `lossmit.modification.completed`, `lossmit.deferral.completed`, `shortsale.approved/offer.received/marketing`, `dil.approved`, `assumption.approved`, `scra.indulgence.granted`, `bankruptcy.petition.filed` (chapter), `bankruptcy.plan.confirmed`, `bankruptcy.surrender`, `foreclosure.referral.sent`, `foreclosure.sale.scheduled` (date), `foreclosure.sale.continued`, `foreclosure.judgment.entered`, `foreclosure.contested`, `foreclosure.mediation`, `title.issue`, `probate.opened`, `reinstatement.partial.accepted`, `chargeoff.approved`, `refinance.payoff.pending`, `assignment.to_insurer`.
- Daily (event mode): each of the above as it is processed → delinquency event by 03:00 ET next BD.
- Inbound: AMN exception reports (BD4), final reports (CD11), Servicing Platform responses/notifications, SMDU/DRA/P360 statuses for consistency checks.

#### Data model
- `delinquency_reports`: `servicer_number`, `period`, `channel` ∈ {amn_b2b, amn_upload, se_api, se_csv}, `document_id`, `record_count`, `submitted_at`, `ack_status`, `exception_report_document_id`, `critical_exceptions`, `noncritical_exceptions`, `corrections_submitted_at`, `final_report_document_id`, `status` ∈ {draft, submitted, exceptions_open, corrected, final}.
- `delinquency_report_lines`: `report_id`, `loan_id`, `fnma_loan_number`, `status_code` (2), `reason_code` (3), `effective_date`, `completion_date`, `forbearance_type`, `imminent_default_ind`, `forbearance_payment_cents`, `forbearance_payment_date`, `derivation` (jsonb: candidate codes with priority, chosen code, evidence event ids), `exception_code`, `superseded_by_line_id`.
- `delinquency_events` (event rail): `loan_id`, `per_loan_sequence`, `servicer_action_type`, `status_types[]` (≤5), `reason_types[]` (≤5), `processed_at`, `submission_id`, `status`, `exceptions` (jsonb) — a projection of `investor_events` with `event_type = delinquency.status`.
- `dq_status_code_map` / `dq_reason_code_map` (versioned in `rule_sets` `fnma.f121.codes.2023-10` and `fnma.se.delinquency.v1`): `internal_state` → `code`/`allowable value`, `priority_level`, `requires_effective`, `requires_completion`, `one_month_only`.

#### State machine
Report (legacy): `draft` (month-end snapshot built, validated) → `submitted` (B2B ack) → `exceptions_open` (BD4 report parsed) → `corrected` (corrections transmitted by CD10) → `final` (CD11 final report reconciled, zero critical exceptions) ; `late` flag if submitted after BD2. Event rail: each `delinquency_events` row follows the 5.1 event machine (`pending` → `submitted` → `accepted`/`accepted_with_warnings`/`rejected` → `superseded`).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_F121_DQ_SNAPSHOT_EOM` | recurring | month end | last calendar day 23:59 ET | 0 | snapshot built | sev-3 |
| `FNMA_F121_DQ_REPORT_BD2` | deadline | period end | BD2 17:00 ET (`fannie_et`) | 0 | `delinquency_reports.submitted` with ack | sev-1 (compensatory fee) |
| `FNMA_F121_DQ_EXCEPTIONS_BD4` | deadline (inbound) | BD4 | BD4 12:00 ET | 0 | exception report parsed | sev-2 → `human_portal_task` pull |
| `FNMA_F121_DQ_CORRECT_CD10` | deadline | exception report parsed | CD10 (per calendar) 17:00 ET | 0 | corrections transmitted and accepted | sev-1 |
| `FNMA_F121_DQ_FINAL_CD11` | deadline (inbound) | CD11 | CD11 12:00 ET | 0 | final report reconciled | sev-2 |
| `FNMA_D2401_DQ_MGMT_ACTION_GATE` | not_before_gate (validation) | snapshot | — | — | every loan with a management action in the month is in the file even if current | sev-1 if omitted |
| `FNMA_F121_AW_ONE_MONTH` | validation | AW reported | period | next period | AW not repeated | reject at build |
| `FNMA_LL202605_DQ_EVENT_NEXTBD_0300` (dual from CIT; live Mar. 15, 2027) | deadline | delinquency action processed | processed_at | next BD 03:00 ET | event submitted | sev-2 |
| `FNMA_LL202605_DQ_PMT_REMINDER_CD23` | informational | 1 period delinquent | CD23 | 0 | Payment Reminder Notice event accepted | notification only (Section 11 owns the notice by the 20th, SVC-2025-05) |
| `SM_DQ_SMDU_DRA_CONSISTENCY_BD1` | recurring | BD1 | BD1 12:00 ET | 0 | AMN codes consistent with SMDU (workouts) and DRA/P360 (sale/REO) statuses | sev-2 |
| `FNMA_F125_RECLASS_DESELECT_CD15` | (5.4) | | | | | |

#### Business rules and calculations
1. **Population:** every loan with `fnma_delinquency_status ≥ 30 days` at month-end **plus** every loan with a delinquency-management action in the month (forbearance/repayment/trial/deferral/modification, BRP received, QRPC, breach letter, bankruptcy filing/plan, referral, sale events, reinstatement, charge-off, assumption, refinance-pending, assignment), even if current.
2. **Code derivation (legacy):** evaluate all candidate codes from loan state, pick the highest priority level; within a level pick the "latest action taken to cure or liquidate" (most recent event timestamp); attach required dates. Mapping (excerpt): trial plan active → **BF** (eff. 1st of first-trial-payment month; compl. last day of trial end month); forbearance active → **09**; repayment plan active → **12**; short sale approved with offer → **17** (marketing without offer → **15**, Level 5); permanent modification completed this month → **28**; deferral completed → report the resulting status (no dedicated code; typically drops off next cycle if current) **[PARTIALLY VERIFIED — F-1-21 has no deferral code; confirm whether "28" or omission is expected]**; SCRA military indulgence → **32**; Mortgage Release approved → **44**; charge-off approved → **29**; assumption → **27**; complete BRP received this month and no Level 1 → **H5**; bankruptcy by chapter → 65/66/67/59, with 69 for post-petition Ch. 13, 3L Ch. 7 asset case, 3M surrender; referred → **43**; sale scheduled → **71** (eff. initial sale date); continued → **95**; judgment → **94**; contested → **33**; mediation → **BG**; title issue → **BE**; probate → **31**; partial reinstatement in foreclosure → **20**; third-party sale → **30**; QRPC this month with no solution → **AW** (once); breach letter sent, not referred → **80**; otherwise 30+ days → **42**; refinance pending → **26**; assignment → **49**.
3. **Reason code:** from the hardship captured in QRPC/loss-mit intake (Section 11/12) mapped to 001–031/INC; if none captured → **031** (unable to contact) when no contact was achieved, else **015** (other) with a decision note; never change a reason code between cycles unless the borrower gives a new primary reason.
4. **Forbearance fields:** when status 09, pos 47 = 0, pos 49 imminent-default indicator (1 if the forbearance was granted for imminent default), pos 51–61 agreed forbearance payment amount (may be 0.00), pos 63–70 date of the forbearance payment received in the reporting month (spaces if none), pos 72–75 four spaces.
5. **Worked example:** loan with installments due Sept 1 and Oct 1, 2026 unpaid at Oct 31 (LPI 08/01) → 60 days delinquent → in the November file due Tue Nov 3, 2026 17:00 ET. QRPC was achieved Oct 20 (borrower unemployed; no solution yet): candidates 42 (L5) and AW (L5) → AW is the latest action → line: status `AW`, reason `016`, effective `20261020`, completion spaces. In December (Nov 1 also missed; BRP complete received Nov 18; trial approved Dec 1 with first trial payment due Jan 1) → December file (due Wed Dec 2): H5 (L2) vs BF (L1, trial approved in the same cycle) → **BF**, effective `20270101`, completion `20270331` (3-month trial). AW is not repeated.
6. **Event rail derivation (from CIT):** each servicing action becomes one event with `servicer_action_type`; status types carry the concurrent conditions (e.g., Chapter 13 Bankruptcy + Contested Foreclosure is invalid — foreclosure vs bankruptcy conflict → only bankruptcy); reason types ≤5 without conflicts; QRPC and Modification Denial Under Appeal events require a reason type already reported.
7. **Consistency checks before submission:** SMDU case status for forbearance/repayment/trial matches the code and dates; DRA/P360 sale dates match 71/30/95; bankruptcy chapter matches PACER monitor; loans reported 43 must have `foreclosure.referral.sent` with the recorded referral date (E-1.2-02).
8. **Corrections:** BD4 exception report parsed (critical vs non-critical); critical exceptions corrected and retransmitted by CD10; the CD11 final report is reconciled line-by-line to `delinquency_report_lines` and stored.

#### Integrations
- **AMN B2B electronic file transfer** (fixed-length records per F-1-21; transport per Fannie Mae B2B onboarding **[UNVERIFIED transport]**); fallback AMN bulk upload UI (`human_portal_task` with file + count + deadline); exception/final reports via B2B or UI pull (`fnma_portal_operator`).
- **Servicing Platform Delinquency event** via `fnma-servicing-events` (API; CSV UI fallback; B2B if grandfathered) — CIT from Oct. 14, 2026 in `mode=dual`, production `mode=event` on Mar. 15, 2027, at which point the AMN file is retired.
- **SMDU** (Section 12 reporting of workouts), **DRA/P360** (5.3 signals), **pacer/bk-monitor** (Section 14) for consistency.

#### Outputs and artifacts
- Monthly delinquency file (document + hash), ack, exception and final reports, correction files, derivation records per line; event-rail events and responses.
- No ledger postings; no borrower notices (Section 11 owns the payment reminder by the 20th and early-intervention notices).
- Investor events: `delinquency.status` (event rail); records written to `delinquency_reports`/`_lines`.

#### AI agent design (AI-first)
`investor-reporting` agent builds and transmits the file/events; `default-collections` agent supplies reason codes and QRPC facts. Tools: `buildDqSnapshot`, `deriveStatusCode`, `validateF121Layout`, `submitAmnFile`, `parseExceptionReport`, `submitDqEvent`, `checkConsistency`, `recordDecision`. Decision record per line: `{loan_id, period, candidates[{code, level, evidence_event_id}], chosen_code, reason_code, reason_source, dates, consistency_checks[], confidence}`. Guardrails: a code is never chosen without an evidence event id; AW once; no Level 1 code without an SMDU case id (except 27/29/32/44 with their own approvals); reason code changes require a new borrower statement; confidence < 0.85 → line flagged for `human_agent` review before BD2 (file still transmits on time with the best code and a correction follows by CD10 if the review changes it). Escalations: `fnma_portal_operator` for UI uploads/pulls; `officer` for a missed BD2 (compensatory-fee instance). Toggle-off: deterministic mapping runs; humans review flagged lines.

#### Edge cases and failure modes
- **Loan current at month-end but in forbearance granted in the month:** report 09 with dates (D2-4-01).
- **Disaster forbearance under LL-2026-01 (3-month increments, 12-month cap):** 09 with completion date = current increment end; extend on renewal; reason 019 (casualty loss) or 011 — on the event rail use "Disaster Impact – FEMA-declared IA" (mutually exclusive with Property Problem/Casualty Loss).
- **Bankruptcy filed the day of a scheduled sale:** Level 3 outranks Level 4 — bankruptcy code; sale-scheduled status suppressed.
- **Successor in interest / probate:** 31 probate when an estate is open; reason 001 if death of borrower.
- **SCRA:** 32 military indulgence with reason 014.
- **Transfer-in mid-month:** transferee reports the loan for the month it is servicer at month-end; transfer files must carry prior codes/dates so AW is not duplicated.
- **Partner-servicer number split:** file per 9-digit servicer number; keep loans mapped to the correct number.
- **AMN outage on BD2:** fallback UI upload; if Fannie Mae is down, document the availability page and transmit at reopening.
- **Late DRA/attorney data:** sale-scheduled dates missing at BD2 → report the best-known status (43) and correct by CD10.
- **Event rail warnings (missing expected action by CD23/53/83):** informational; Section 11 timers govern the underlying obligations.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 5.7-T1 | Given the worked example loan at Oct 31, 2026, then the November file line is `AW`/`016`/`20261020` and it is transmitted with B2B ack before Tue Nov 3, 2026 17:00 ET. |
| 5.7-T2 | Given the same loan in the December cycle with trial approved, then the line is `BF`/`016`/`20270101`/`20270331` and AW does not recur. |
| 5.7-T3 | Given a loan current at Nov 30, 2026 that was granted a 3-month imminent-default forbearance on Nov 10 suspending the Dec 1, Jan 1 and Feb 1 installments at $0.00, then the December file (due Wed Dec 2) still includes the loan (management action in the month) with status `09`, effective `20261201` (first month of suspension), completion `20270228`, pos 47 `0`, pos 49 `1`, pos 51–61 `00000000.00`, pos 63–70 spaces. |
| 5.7-T4 | Given a Chapter 13 filed Oct 28 on a loan with a sale scheduled Nov 5, then the code is `67` (Level 3), not `71`. |
| 5.7-T5 | Given BD4 exception report lists 3 critical exceptions (invalid reason code), then corrections are transmitted by CD10 (the published calendar lists Sat Oct 10, 2026 for the October cycle; the engine targets the preceding business day, Fri Oct 9) and the CD11 final report reconciles to zero critical. |
| 5.7-T6 | Given `mode=dual` in CIT, when a breach letter is sent Wed Oct 21, 2026 14:00 ET, then a delinquency event with action "Breach Letter Sent" is submitted to `api-clve` by Thu Oct 22 03:00 ET and the November AMN line shows `80` with effective `20261021`. |
| 5.7-T7 | Given a loan reported 43 without a `foreclosure.referral.sent` event, then the consistency check blocks the line and escalates before BD2. |
| 5.7-T8 | Given the file is transmitted at BD2 18:30 ET, then the `late` flag is set, an `officer` escalation records a potential compensatory-fee instance and the Compliance Sentinel report lists it. |

#### Audit and evidence
Monthly files, acks, exception/final reports, per-line derivation records with evidence event ids, consistency-check results, correction history and timer records — retained `life_of_loan_plus_4y`; this is the evidence base for compensatory-fee disputes (A1-4.2-01/02) and STAR delinquency-reporting accuracy metrics.

### Open questions / decisions
1. **Deferral completion code** — default: no Level 1 code (loan becomes current and drops off), unless Fannie Mae's exception report asks otherwise.
2. **B2B transport for AMN** — default: obtain during onboarding; UI bulk upload fallback.
3. **Reason-code default when hardship unknown** — default: 031 if no contact; 015 with note if contact achieved but no reason given; on the event rail use "Borrower Declined to Provide a Reason."
4. **Dual-rail overlap window** — default: run AMN and Servicing Platform in parallel through Feb. 2027 CIT cycles; cut over to event-only on Mar. 15, 2027 with a one-cycle shadow file retained.

### Sources
- D2-4-01 (06/10/2020): https://servicing-guide.fanniemae.com/svc/d2-4-01/reporting-delinquent-mortgage-loan-fannie-mae (verified 2026-09-09)
- F-1-21 (10/11/2023): https://servicing-guide.fanniemae.com/svc/f-1-21/reporting-delinquent-mortgage-loan-fannie-maes-servicing-solutions-system (verified 2026-09-09)
- F-1-22 (10/11/2023) — workout reporting (scope check): https://servicing-guide.fanniemae.com/svc/f-1-22/reporting-workout-option-fannie-maes-servicing-solutions-system (verified 2026-09-09)
- 2026 Delinquency Reporting Calendar / Delinquent Loan Reporting and Reclassification Timeline: https://singlefamily.fanniemae.com/media/document/pdf/delinquent-loan-reporting-and-reclassification-timeline (verified 2026-09-09; graphic)
- Delinquency Reporting CIT Plan v1.1 (Sept. 1, 2026); Servicing Changes Reference Guide v1.0; LL-2026-05; FAQ v1.6 (URLs in 5.1) (verified 2026-09-09)
- A1-4.2-01 (12/21/2022) (URL in 5.1) (verified 2026-09-09)
- research/00a §2.3 (HSSN retirement), §3.1; research/00b F8 (verified 2026-09-09)
