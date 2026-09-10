# 14.4 — Credit reporting suspension in BK

| Attribute | Value |
|---|---|
| Section | 14 — Bankruptcy |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On filing |
| Governing source | FNMA C-4.1-02; FCRA |
| Key deadlines | On filing |
| Timers | `BK_CII_APPLY_NEXT_CYCLE`, `SM_BK_CR_DISCHARGE_FINAL_RECORD`, `SM_BK_CR_DISMISSAL_RELEASE_NEXT_CYCLE`, `SM_BK_CR_REAFFIRM_HOLD`, `SM_BK_CR_STATE_SYNC_1BD`, `SM_CR_SUPPRESSION_REVIEW_30` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Bankruptcy |
| Trigger & frequency | On filing |
| Governing source (blueprint) | FNMA C-4.1-02; FCRA |
| Key deadlines (blueprint) | On filing |
| Data/artifacts | Flag |
| Systems | Bureaus |
| Automation class (blueprint) | a |
| SoR / Sub | Sub |
| Nuances (blueprint) | Note: research indicates C-4.1-02 has been retired; use C-4.1-01 + F-1-23 — reconstructed below as the bankruptcy feed into Section 8.3's overlay engine |

### Verified requirement (as of 2026-09-09)

**There is no Fannie Mae credit-reporting suspension for bankruptcy.** Servicing Guide topic C-4.1-02 ("Suspending Credit Bureau Reporting") was removed by SVC-2020-03 (July 15, 2020) and does not exist in the Aug. 12, 2026 edition; Section C-4.1 contains only **C-4.1-01 Notifying Credit Repositories (07/15/2020)** — report the status of every loan to the four repositories as of the last day of each month "in compliance with all applicable laws" — and procedure **F-1-23 Reporting to Third Parties (06/09/2021)**, which contains no bankruptcy language (verified 2026-09-09; Section 8.3's retirement analysis). E-2.1-01 through E-2.3-07 contain no credit-reporting instruction (verified today). The operative law is therefore: FCRA §1681s-2(a)(1)(A) (no furnishing of information the furnisher knows or has reasonable cause to believe is inaccurate) and (a)(2) (correct and update), Reg V §1022.41–.42 and Appendix E (accuracy = "correctly reflects the terms of and liability for the account" — liability changes at discharge; integrity = substantiated by records), the Bankruptcy Code's automatic stay (§362(a)(6)) and discharge injunction (§524(a)(2)) as they have been applied to furnishing used as leverage **[case-law characterization — UNVERIFIED]**, §1328(a)'s exception for §1322(b)(5) debts (a cured-and-maintained mortgage is not discharged), §1301 (co-debtor stay restricts collection, not accurate reporting), and the CDIA Metro 2/CRRG Consumer Information Indicators (CII) and Account Status conventions (CRRG 2026 revised its bankruptcy FAQs — **[UNVERIFIED — CRRG 2026 access-controlled]**). FCRA §1681c(a)(1): CRAs may not report bankruptcies older than 10 years (a CRA obsolescence rule, not a furnisher rule).

**What 14.4 therefore is.** Blueprint row 14.4 is redefined as the **bankruptcy feed into 8.3** — the `bankruptcy-ops` agent publishes a per-consumer `bankruptcy_reporting_state` (defined in 8.3's data model) on every case event within 1 BD, and 8.3's overlay engine turns it into CII codes, status freezes, balance treatment and Date Closed rules per its rule 3 matrix (petition CII A/B/C/D and status freeze; Chapter 13 confirmed → post-petition performance with CII D; Chapter 7 discharge without reaffirmation → CII E, zero balances, Date Closed, final record; reaffirmation → R (rescission → V); Chapter 13 completion → H if surrendered/discharged, Q if maintained under §1322(b)(5); dismissal → I/J/K/L then Q; withdrawal → M/N/O/P then Q; conversion 13 → 7 → A). No separate "suspension flag" exists; "suspension" is one of 8.3's mechanisms (`freeze_status`) applied per filing consumer, never to non-filing co-obligors. 8.3's open questions Q3 (pre-confirmation freeze vs contractual aging) and Q4 (post-Chapter-7 ride-through reporting) remain the controlling decisions.

**Discrepancies with the blueprint row.** (1) Governing source is not C-4.1-02 (retired) or "FCRA" generically, but C-4.1-01 + F-1-23 + FCRA §1681s-2(a)/Reg V + the Bankruptcy Code + CRRG. (2) "On filing" is right for the first overlay, but the feed has at least eight further state changes (plan confirmed, surrender, relief, dismissal, discharge, reaffirmation/rescission, conversion, closure, reopening) each with a next-cycle deadline. (3) "Flag" → a typed per-consumer state record with evidence, consumed by 8.3; the co-borrower is unaffected. (4) The blueprint's "suspension" would itself be an accuracy problem if applied to a dismissed case or a non-filing obligor — the design forbids courtesy or blanket suppression (8.3 guardrail).

### Operational prerequisites
- 8.1/8.3 built (Metro 2 generator, overlay engine, `credit_reporting_suppressions`, `bankruptcy_reporting_state`, urgent AUD path via e-OSCAR), CRRG 2026 license and counsel confirmation of the CII matrix (8.3 prerequisites).
- 14.1 case record with verified filer identity (which borrower(s) filed — `filer_borrower_ids`), chapter, phase dates, plan treatment (`plan_cures_arrears`), post-petition payment amount, discharge/reaffirmation facts, and the post-petition ledger (`bankruptcy_ledger_views`) for status derivation.
- 1.1 boarding capture of the transferor's last CII per consumer and open-case facts so the first cycle neither drops nor duplicates an indicator.
- Agreement on the 8.3-Q3/Q4 defaults (freeze at petition-date status; cease furnishing after the Chapter 7 discharge record) before the first bankruptcy cycle.

### Build spec
#### Inputs and triggers
Canonical 14.1 events: `bankruptcy.petition.filed` (chapter, petition_date, filer ids), `bankruptcy.plan.confirmed` (treatment, `plan_cures_arrears`, conduit), `bankruptcy.plan.modified`, `bankruptcy.surrender`, `bankruptcy.stay.relief_granted`, `bankruptcy.case.dismissed` (voluntary → "withdrawn" mapping per 8.3 when the debtor's own motion; else dismissed), `bankruptcy.case.discharged` (with `debt_discharged`), `bankruptcy.reaffirmation.filed/approved/rescinded`, `bankruptcy.case.converted`, `bankruptcy.case.closed`, `bankruptcy.case.reopened`, `bankruptcy.postpetition.payment.applied` / `.delinquency.*` (post-petition status), `bankruptcy.cramdown.confirmed`, plus `loan.boarded` with case facts; the 8.3 month-end snapshot `FNMA_C41_01_METRO2_SNAPSHOT_EOM` reads the state.

#### Data model
- `bankruptcy_reporting_state` (8.3; written by 14.4): `loan_id`, `borrower_id` (filer), `chapter`, `phase` ∈ {petition, confirmed, discharged, dismissed, withdrawn, closed, reaffirmed}, `petition_date`, `confirmation_date`, `discharge_date`, `dismissal_date`, `reaffirmation_date`, `reaffirmation_final bool` (after the §524(c)(4) window), `debt_discharged bool` (Ch. 7 no reaffirmation → true; Ch. 13 §1322(b)(5) maintained → false; Ch. 13 surrender/lien avoidance with discharge → true), `status_at_petition` (Metro 2 status on the petition date from 8.1's day-count rule), `post_petition_payment_cents`, `plan_cures_arrears bool`, `postpetition_days_delinquent`, `cramdown jsonb?` (secured balance for Current Balance under comment-style plan-terms reporting — 14.4-Q2), `evidence_document_id` (petition notice/order), `case_id`, `updated_at`.
- Mapping table (versioned rule set `bk.credit_feed.v1`): 14.1 event → `phase`/fields → 8.3 suppression row `{reason: bankruptcy_active | bankruptcy_discharged, mechanism, codes}` per 8.3 rule 3.

#### State machine
`petition` → `confirmed` (12/13) → {`discharged` | `dismissed` | `withdrawn` | `closed`} ; `petition` (7) → {`discharged` | `dismissed` | `reaffirmed` → `discharged`}; `converted` re-enters `petition` with the new chapter; `reopened` re-enters the prior phase. Each transition writes the state row and emits `bankruptcy.reporting_state.changed` to 8.3 within 1 BD; 8.3 applies it at the next month-end snapshot (`BK_CII_APPLY_NEXT_CYCLE`).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `SM_BK_CR_STATE_SYNC_1BD` | deadline (internal) | any 14.1 phase event | event | 1 `business_days_servicer` | `bankruptcy_reporting_state` row written | sev-3 |
| `BK_CII_APPLY_NEXT_CYCLE` (8.3) | deadline (policy) | `bankruptcy.reporting_state.changed` | event date | next `FNMA_C41_01_METRO2_SNAPSHOT_EOM` | snapshot carries the phase's CII/mechanism | `officer` sev-2 |
| `SM_CR_SUPPRESSION_REVIEW_30` (8.3) | recurring | suppression created | created_at | every 30 `calendar_days` | review with docket check (14.1 daily sync) | `human_agent` |
| `SM_BK_CR_DISMISSAL_RELEASE_NEXT_CYCLE` | deadline | `bankruptcy.case.dismissed/withdrawn` | event | next snapshot | CII I–P for one cycle then Q; freeze released | sev-2 (stale freeze = inaccuracy) |
| `SM_BK_CR_DISCHARGE_FINAL_RECORD` | deadline | `bankruptcy.case.discharged` with `debt_discharged=true` | discharge date | next snapshot | CII E/H record with zero balances and Date Closed; then `final_reported` | sev-2 |
| `SM_BK_CR_REAFFIRM_HOLD` | not_before_gate | `bankruptcy.reaffirmation.filed` | filing | until `USC_524C4_REAFFIRM_RESCISSION` expiry (14.1) | `reaffirmation_final=true` → CII R | — |

Jurisdiction overrides: none (federal).

#### Business rules and calculations
1. **Per-consumer scope.** Only `filer_borrower_ids` receive a state row; a joint petition creates one row per filer; a non-filing co-obligor keeps contractual reporting (8.3 rule 3 and edge case) — the §1301 co-debtor stay does not alter accurate reporting.
2. **Petition.** `phase=petition`, `status_at_petition` from 8.1's day count on the petition date, `debt_discharged=false`; 8.3 applies CII A/B/C/D and `freeze_status` (8.3-Q3 default). Fixture BK-13-A: petition 2026-09-08 with May 1 unpaid → 130 days → status **82** frozen; Sept-30 snapshot: CII `D`, Account Status 82, Amount Past Due = 5 × 2,699.22 = 13,496.10 → `000013496` (truncated, 8.1-Q2), DOFD `05012026`, Current Balance `000314415`, Scheduled Monthly Payment `000002699`; no Special Comment; the non-filing co-borrower's segment (if any) carries the contractual 152-day status **83** with no CII.
3. **Confirmation.** `phase=confirmed`, `plan_cures_arrears=true` when the plan cures the arrearage, `post_petition_payment_cents=280672` (after the 14.2 change); 8.3 reports post-petition performance: Dec-31-2026 snapshot in direct-pay example B: Dec 1 unpaid 30 days → status **71**, CII `D`, Amount Past Due `000002806`, Scheduled Monthly Payment `000002806`, DOFD `12012026` (a new post-petition delinquency; the frozen pre-petition DOFD does not carry), Current Balance = UPB per the plan-terms view (`000312279` after the Oct/Nov applications — or the contract-terms UPB if 8.1-Q9 chooses otherwise, 14.4-Q2); conduit example A on the same date shows the same 71 because the trustee's Dec disbursement arrived 2027-01-20 — accurate, and the trustee-timing explanation is available for disputes (8.2).
4. **Chapter 13 completion/discharge.** With `debt_discharged=false` (maintained mortgage) → 8.3 CII `Q` (indicator removed) and normal reporting from the discharge cycle; the 14.2 end-of-case response is the evidence that the pre-petition arrearage was cured (the cured installments are never re-aged). Surrender/lien avoidance with discharge → `debt_discharged=true` → CII `H`, zero balances, Date Closed.
5. **Chapter 7.** Discharge without reaffirmation → `debt_discharged=true` → CII `E`, Current Balance/Amount Past Due/Scheduled Payment 0, Date Closed = discharge date, Account Status frozen at the pre-discharge value (fixture example C: **82**), then `final_reported` (8.3-Q4 default — no positive-only ride-through reporting). Reaffirmation → `reaffirmed` only after the rescission window (`reaffirmation_final`), then CII `R` and normal reporting; rescission → `V`.
6. **Dismissal/withdrawal/closure without discharge.** `phase=dismissed` (or `withdrawn` when the debtor's own motion) → one cycle of CII I/J/K/L (or M/N/O/P) then `Q`; the freeze is released and the contractual status (contract-terms view) is reported — the 8.1 anomaly gate whitelists the jump with the dismissal order as evidence; DOFD reverts to the contractual first-unpaid date (fixture: still `05012026` if the May installment remains uncured; if cured amounts through the trustee cleared May–Jun, the DOFD moves to the earliest still-unpaid installment).
7. **Conversion 13 → 7.** New `petition` phase with chapter 7 (CII `A`), petition date retained, status frozen at the conversion-date status.
8. **Relief from stay.** No reporting change by itself (the case continues); foreclosure milestones later flow through 8.1's normal status/Special Comment rules.
9. **Cramdown.** Plan-terms secured balance and payment are the reported Current Balance/Scheduled Payment while the case is open (14.4-Q2), with CII D; the unsecured portion is not separately furnished.
10. **Corrections.** A case learned late (petition discovered after a cycle furnished a delinquent status without CII) → 8.3 AUD correction within 2 BD adding the CII and, where the freeze rule would have applied, correcting the status; a mis-identified filer (wrong consumer) → AUD removing the CII within 2 BD and `officer` notification.

#### Integrations
| Counterparty | Direction | Interface | Notes |
|---|---|---|---|
| 8.3 overlay engine | out | `bankruptcy_reporting_state` rows + `bankruptcy.reporting_state.changed` events | 8.3 owns codes, mechanisms, AUDs, e-OSCAR |
| 8.2 disputes | in | bankruptcy-related ACDVs/direct disputes need case facts (petition date, phase, plan) | 14.1 supplies the docket evidence within 1 BD |
| 14.1 docket monitor | in | phase events with document ids | evidence for every state row |
| Bureaus / e-OSCAR | none directly | — | via 8.1/8.2/8.3 only |

#### Outputs and artifacts
`bankruptcy_reporting_state` history with evidence document hashes; `bankruptcy.reporting_state.changed` events; decision records; no notices; no ledger postings; no investor events. The monthly overlay statistics 8.3 sends the partner include bankruptcy counts by chapter/phase.

#### AI agent design (AI-first)
- **Agent:** `bankruptcy-ops` (feed) → `credit-reporting` (overlay, 8.3). The feed is deterministic (event → state row); the only judgment is docket classification (14.1). Tools: `bk.reporting_state.write`, `bk.case.read`, `escalation.file`.
- **Decision record:** `{case_id, borrower_id, trigger_event_id, phase, fields_written, evidence_document_id, rule_set_version (bk.credit_feed.v1; crrg.2026), rationale}`.
- **Guardrails:** no state row without a verified case and evidence; non-filing obligors never receive a row; `debt_discharged=true` requires the discharge order document; reaffirmation is not `final` until the rescission window lapses; the agent cannot create suppressions directly (only 8.3 does, from the state row).
- **Escalations:** `attorney` (via 14.1) when a plan/order's effect on liability is unclear (e.g., §1322(c)(2) modifications, lien avoidance, hardship discharge); `officer` for corrections affecting > 25 consumers (systemic) or for any deletion; `human_agent` on request.
- **AI-off path:** 8.3's overlay worklist reads manually entered case facts from the ops console.

#### Edge cases and failure modes
- **Serial filings:** each petition creates a new row/freeze anchored at the new petition date; the prior dismissal cycle codes must have been reported first (ordering by event date).
- **Joint petition, one debtor later dismissed (severed case):** rows diverge per consumer.
- **Post-petition payment history disputes** ("trustee paid on time"): 8.2 uses the trustee vouchers; the platform reports post-petition performance by receipt, and the dispute response explains conduit timing.
- **Discharge order vacated / case reopened to revoke discharge:** correction with AUD (8.3), `debt_discharged` reset with the order as evidence.
- **Transfer-in with an open case and no transferor CII history:** first cycle applies the phase's CII from the boarded facts; no re-aging (Appendix E III(g)).
- **Monitor outage / late docket:** `SM_CR_SUPPRESSION_REVIEW_30` plus 14.1's daily sync; retroactive corrections via AUD.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 14.4-T1 | Given the fixture petition 2026-09-08, then the state row exists by 2026-09-09 with `status_at_petition=82`, and the Sept-30 snapshot for the filer shows CII D, status 82, Amount Past Due 000013496, DOFD 05012026, Current Balance 000314415; the non-filing co-borrower shows status 83 and no CII. |
| 14.4-T2 | Given confirmation 2026-12-10 (`plan_cures_arrears=true`, post-petition payment $2,806.72) and Dec 1 unpaid on Dec 31, then the Dec-31 snapshot shows 71, CII D, Amount Past Due 000002806, DOFD 12012026. |
| 14.4-T3 | Given Chapter 13 discharge 2031-08-20 after a cured/current end-of-case response, then `debt_discharged=false`, CII Q from the Aug-31-2031 snapshot and normal reporting thereafter. |
| 14.4-T4 | Given Chapter 7 discharge 2026-12-15 without reaffirmation, then the Dec-31 record carries CII E, zero balances, Date Closed 12152026, status 82, and January is not furnished. |
| 14.4-T5 | Given a reaffirmation filed 2026-11-20 and discharge 2026-12-15, then CII stays A until 2027-01-19 and becomes R on the Jan-31-2027 snapshot; a rescission on 2027-01-10 yields V. |
| 14.4-T6 | Given dismissal 2027-06-05 with May–Jun 2026 installments cured through the trustee, then the Jun-30-2027 snapshot shows CII L, the contractual status from the earliest unpaid installment (Jul 1, 2026), DOFD 07012026, and Jul-31 shows Q. |
| 14.4-T7 | Given a petition discovered on 2026-10-20 after the Sept-30 file was furnished without CII, then an AUD adding CII D and the frozen status is sent by 2026-10-22. |
| 14.4-T8 | Given a same-name false match reversed on 2026-09-15, then no state row survives, and if a file was already furnished with CII an AUD removes it within 2 BD with `officer` notified. |

#### Audit and evidence
State-row history with docket evidence hashes and the 14.1 decision records; 8.3's suppression rows, overlay decisions and AUD control numbers; reconciliation reports between `bankruptcy_cases` phases and furnished CII per cycle (any mismatch is an exception); retained `fcra_furnishing_5y` / life-of-loan + 4 years; exportable for FCRA disputes, stay/discharge-violation claims and exams.

### Open questions / decisions
1. **14.4-Q1 Freeze vs. contractual aging pre-confirmation and Chapter 7 ride-through** — governed by 8.3-Q3/Q4 (defaults: freeze; cease after the discharge record).
2. **14.4-Q2 Current Balance during a Chapter 13 plan / cramdown** — default: plan-terms secured UPB while the case is open (consistent with the 8.1 principal-type rule); alternative: contract-terms UPB. Confirm with the CRRG 2026 bankruptcy FAQs.
3. **14.4-Q3 "Withdrawn" mapping** — default: debtor's voluntary dismissal → M/N/O/P; court/trustee dismissal → I/J/K/L.

### Sources
- Fannie Mae Servicing Guide C-4.1-01 (07/15/2020): https://servicing-guide.fanniemae.com/svc/c-4.1-01/notifying-credit-repositories ; F-1-23 (06/09/2021): https://servicing-guide.fanniemae.com/svc/f-1-23/reporting-third-parties ; SVC-2020-03: https://singlefamily.fanniemae.com/media/document/pdf/announcement-svc-2020-03-servicing-guide-update ; Chapter E-2 (no credit-reporting text) (verified 2026-09-09)
- 15 U.S.C. 1681s-2(a), 1681c: https://www.law.cornell.edu/uscode/text/15/1681s-2 ; https://www.law.cornell.edu/uscode/text/15/1681c ; 12 CFR 1022.41–.42 and Appendix E: https://www.ecfr.gov/current/title-12/chapter-X/part-1022/appendix-Appendix%20E%20to%20Part%201022 (verified 2026-09-09 in Section 8)
- 11 U.S.C. §§ 362(a)(6), 524(a)(2), 1301, 1322(b)(5), 1328(a) — as in 14.1 (verified 2026-09-09)
- Section 8.3 (overlay matrix, CII codes, tests 8.3-T4/T5), Section 8.1 (rounding, status buckets)
