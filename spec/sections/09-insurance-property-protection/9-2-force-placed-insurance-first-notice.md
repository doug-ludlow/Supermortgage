# 9.2 — Force-placed insurance — first notice

| Attribute | Value |
|---|---|
| Section | 9 — Insurance & Property Protection |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | On lapse w/ reasonable basis |
| Governing source | Reg X 1024.37(c) |
| Key deadlines | ≥45 days before charging |
| Timers | `FNMA_B601_LPI_AFTER_ATTEMPTS`, `INS_FPI_FIRST_NOTICE_SLA_3BD`, `REGX_1024_17K5_LPI_PURCHASE_GATE`, `REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15`, `REGX_1024_37C_FPI_FIRST_NOTICE_45`, `REGX_1024_37D5_NOTICE_PRODUCTION_5BD`, `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15`, `REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Insurance |
| Trigger & frequency | On lapse w/ reasonable basis |
| Governing source (blueprint) | Reg X 1024.37(c) |
| Key deadlines (blueprint) | ≥45 days before charging |
| Data/artifacts | MS-3A notice |
| Systems | LPI carrier |
| Automation class (blueprint) | b |
| SoR / Sub | [cropped in source] — reconstructed: Sub sends the notice as servicer; partner is named insured on the LPI program and liable |
| Nuances (blueprint) | [cropped in source] — reconstructed: escrowed-borrower prohibition (1024.17(k)(5)); flood excluded from 1024.37 (FDPA track, 9.6); retroactive charge to lapse date; content/format/bold rules; account number only; first-class mail; Fannie Mae B-6-01 (no affiliates, no commissions, deductible tiers) |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.37(c)(1)** (eCFR current as of Sept. 3, 2026): before assessing "any premium charge or fee related to force-placed insurance" the servicer must (i) deliver to the borrower or place in the mail a written notice with the (c)(2) content "at least 45 days before" assessing the charge; (ii) deliver or mail the (d)(1) reminder notice; and (iii) by the end of the **15-day period** beginning on the date the reminder was delivered or mailed, "not have received, from the borrower or otherwise, evidence demonstrating that the borrower has had in place, continuously, hazard insurance coverage that complies with the loan contract's requirements." **(c)(2) content**: (i) date of the notice; (ii) servicer's name and mailing address; (iii) borrower's name and mailing address; (iv) a statement requesting the borrower to provide hazard insurance information for the property, identified by **physical address**; (v)(A) a statement that the borrower's hazard insurance "is expiring, has expired, or provides insufficient coverage, as applicable," (B) that the servicer lacks evidence of coverage past the expiration date or of sufficient coverage, and (C) if applicable, the **type** of hazard insurance for which evidence is lacking (comment 37(c)(2)(v)-1: when both a homeowners policy and a separate hazard policy are required, say which); (vi) that hazard insurance is required and the servicer "has purchased or will purchase" it "at the borrower's expense"; (vii) a request to provide the information promptly; (viii) a description of the requested information and how to provide it, and, if applicable, that it "must be in writing"; (ix)(A) that the servicer's insurance "may cost significantly more than" and (B) "may not provide as much coverage as" the borrower's own; (x) the servicer's telephone number for inquiries; (xi) if applicable, a statement to review additional information in the same transmittal. **(c)(3) format**: (iv) (except the address itself), (vi), (ix)(A) and (B) in **bold**; model form **MS-3(A)** may be used. **(c)(4)**: the notice may contain no other information except the **mortgage loan account number**; other material must go on separate pieces of paper in the same transmittal. **(f)**: if mailed, "a class of mail not less than first-class mail." **(b)/comment 37(b)-1**: reasonable basis; following (c)(1)(i)–(ii) is deemed reasonable diligence. **Comment 37(c)(1)(i)-1**: the charge may be **retroactive to the first day of any period in which the borrower did not have hazard insurance in place.** **Comment 37(c)(1)(iii)-1**: a premium paid within a state-law or policy grace/extension period that the insurer accepts without a lapse counts as continuous coverage. **(a)(2)** exclusions: FDPA-required flood insurance (9.6), a borrower policy renewed by the servicer under §1024.17(k)(1), (2) or (5), or renewed with the borrower's agreement at the servicer's discretion (comment 37(a)(2)(iii)-1). Sources: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.37 ; Supplement I (current as of Sept. 2, 2026) https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Supplement%20I%20to%20Part%201024 ; model forms https://www.consumerfinance.gov/rules-policy/regulations/1024/ms3/ (verified 2026-09-09).

**RESPA §6(k)(1)(A), (l), (m)** (12 U.S.C. 2605, verified 2026-09-09 at https://www.law.cornell.edu/uscode/text/12/2605): the statute's own two-notice/30-day/15-day structure and the "bona fide and reasonable" charge rule; §6(l)(4) allows a simultaneous FDPA flood notice; §6(f) damages (actual damages; up to $2,000 additional for a pattern or practice; class cap of the lesser of $1,000,000 or 1% of net worth).

**§1024.17(k)(5)** (Section 3.7): for an escrowed borrower more than 30 days overdue, the servicer "may not purchase force-placed insurance … unless a servicer is unable to disburse funds from the borrower's escrow account" — inability exists only with a reasonable basis to believe the policy was cancelled/not renewed "for reasons other than nonpayment of premium charges" or the property is vacant; insufficient escrow funds are not inability; (k)(2) requires advancing while ≤ 30 days overdue. Comment 17(k)(5)(ii)(A)-1 examples (borrower notice without replacement coverage; insurer cancellation notice before the premium due date; no payment notice by expiration).

**Fannie Mae B-6-01, Lender-Placed Insurance Requirements (10/14/2015)**: obtain LPI only "after it makes unsuccessful attempts to obtain evidence of insurance in accordance with applicable law"; no affiliated-entity carrier, captive or reinsurance (affiliate = owned/controlled by, owning/controlling, or under common control with the servicer; <5% of a public company excepted); **exclude all commissions and incentive payments** (bonuses, loss-ratio payments, "regardless of designation") earned by the servicer, broker or affiliate "from the lender-placed insurance premiums charged to the borrower or submitted for reimbursement from Fannie Mae"; provide the LPI policy and carrier contracts on request and any LPI documentation within **30 days** of request; terminate LPI and refund overlapping premiums/fees "in accordance with applicable law"; **deductible tiers** for LPI property policies: coverage < $100,000 → $1,000; $100,000–$250,000 → $2,000; > $250,000 → $2,500 (flood LPI and wind/hail-only LPI excluded). LL-2026-03 restates the trigger — "in response to notification that coverage is being cancelled, non-renewed, or has lapsed" — with the servicer items mandatory Jan. 1, 2027. Source: https://servicing-guide.fanniemae.com/svc/b-6-01/lender-placed-insurance-requirements (verified 2026-09-09). **Coverage amount**: neither B-6-01 nor B-2-01 fixes an LPI amount; B-2-01 requires adjusting coverage "when lender-placed insurance causes over-insurance." **F-1-05** (06/11/2025): property/flood premiums advanced "when the escrow account has insufficient funds" are reimbursable once the loan is delinquent, through 14 days after foreclosure sale/mortgage release/short-sale closing/third-party sale, net of unearned-premium refunds (Section 15.2).

**Discrepancies vs blueprint**: the row's "≥45 days before charging" is right but incomplete — the reminder and the 15-day evidence window are co-equal gates; the escrowed-borrower prohibition is a hard code gate, not a nuance; flood is a different statute; and the servicer may bind LPI retroactively to the lapse date, so "first notice" is about when the *charge* may be assessed, not when coverage attaches.

### Operational prerequisites
- LPI master policy in the partner's name with an unaffiliated, rated carrier; program terms fixing coverage-amount methodology, retroactive binding, pro-rata cancellation and refund mechanics, no commissions/incentives to Supermortgage or the partner (B-6-01) — Partner + Supermortgage; the contract's "no commission" clause is exam evidence.
- Notice Registry templates `INS_FPI_FIRST_MS3A`, `INS_FPI_REMINDER_NOINFO_MS3B`, `INS_FPI_REMINDER_INSUFF_MS3C`, `INS_FPI_RENEWAL_MS3D` built from the Appendix MS-3 model forms with machine-checked bold/placeholder rules; counsel sign-off — Supermortgage.
- Print/mail vendor proof-of-mailing (USPS manifest / IMb tracking) with first-class class code on every FPI piece — Supermortgage (00b N9).
- The `REGX_1024_17K5_LPI_PURCHASE_GATE` (Section 3.7) live; `regx_days_delinquent` computed daily.
- State LPI rules loaded into `jurisdiction_rules` (NY Regulation 202; CA §2955.5 amount cap) **[UNVERIFIED]** — legal task before go-live in those states.
- LL-2026-04 inventory entry for the reminder-cost estimator and the evidence-sufficiency classifier.

### Build spec
#### Inputs and triggers
- `insurance.lapse_detected` (9.1) with `kind ∈ {expired, cancelled, nonrenewed, insufficient_coverage, perils_gap}` and `basis_evidence` → open `cases` (`case_type='fpi'`).
- Guards evaluated at open: escrowed? `regx_days_delinquent > 30`? inability documented? (3.7) ; flood? (→ 9.6 track) ; wind-only gap? (`insurance_type='wind'`).
- `insurance.evidence.received/confirmed/rejected` (9.1) advance or resolve the case.
- Timer events: `REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30` open → 9.3; charge gates open → placement/charge.
- `loan.paid_in_full`, `servicing.transfer_out.effective`, `reo.acquired`, `loan.charged_off` → close.

#### Data model
- `fpi_cases` (new; 1:1 with `cases`): `case_id`, `loan_id`, `deficiency_id`, `insurance_type` ∈ {hazard, wind, hail, flood}, `track` ∈ {regx_hazard, fdpa_flood}, `escrowed bool`, `k5_gate` ∈ {n/a, blocked_advance, open_inability}, `basis_summary text`, `first_notice_id`, `first_notice_mailed_at date`, `reminder_notice_id`, `reminder_mailed_at date`, `reminder_variant` ∈ {b_no_info, c_insufficient}, `evidence_window_end date`, `earliest_charge_date date` (computed), `lapse_start date`, `lpi_placement_id?`, `annual_premium_cents`, `premium_is_estimate bool`, `estimate_basis text`, `renewal_cycle int default 0`, `status`, `closed_reason`.
- `lpi_placements` (new): `id`, `fpi_case_id`, `lpi_policy_id` (→ `insurance_policies`, kind `lpi_*`), `carrier_party_id`, `coverage_amount_cents`, `coverage_method` ∈ {last_known, rcv_estimate, upb_cap, state_cap}, `deductible_cents` (B-6-01 tier), `effective_date`, `expiration_date`, `premium_cents`, `premium_is_estimate`, `bound_at`, `vendor_ref`, `cancelled_at`, `cancellation_effective`, `refund_cents`, `status` ∈ {requested, bound, billed, charged, cancel_requested, cancelled, refunded}.
- `lpi_charges` (new): `id`, `fpi_case_id`, `placement_id`, `period_start`, `period_end`, `amount_cents`, `assessed_at`, `ledger_entry_id`, `reversal_entry_id?`, `disbursement_id?` (escrowed rail), `borrower_paid_cents` (running).
- `jurisdiction_rules` keys: `lpi_state_regulation` (NY), `hazard_amount_cap_rule` (CA), `lpi_prompt_charge_prohibited` ((e)(1)(iii) "if not prohibited by State law").
- Baseline: `notices` (with `mail_class='first_class'`, `proof_of_mailing_document_id`), `timers`, `ledger_entries`, `disbursements` (`disbursement_kind='lpi_premium'`), `advances`.

#### State machine
`opened` → `k5_blocked` (escrowed, > 30 days overdue, no inability: premium advanced by 3.7; case closed `k5_advance`) | `first_notice_pending` → `first_notice_sent` (t0 = mailed_at) → `reminder_eligible` (t0 + 30) → `reminder_sent` (9.3; t1) → `evidence_window` (t1 … t1 + 15) → `chargeable` (date ≥ max(t0 + 45, t1 + 15) and no continuous-coverage evidence) → `lpi_bound` (placement effective retro to `lapse_start`) → `charged` (charge assessed) → `renewal_notice_due` (9.4; anniversary − 45) → `renewal_notice_sent` → `renewed` (loop) ; from any state on confirmed evidence: `evidence_sufficient` → `closed_evidence` (no charge if before `charged`) or → `cancel_refund` (9.5) → `closed_refunded` ; `closed_paid_off` / `closed_transferred` / `closed_reo` / `closed_error` (reversal path). Transitions are agent-driven; timers gate `reminder_eligible` and `chargeable`; no human ack is required except `human_agent` handoffs.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_37C_FPI_FIRST_NOTICE_45` | not_before_gate | `fpi.first_notice.sent` | `first_notice_mailed_at` | +45 calendar_days | gate opens; `fpi.charge.assessed` must be ≥ this date | code-enforced: charge command refused before open |
| `REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30` | not_before_gate | `fpi.first_notice.sent` | `first_notice_mailed_at` | +30 calendar_days | `fpi.reminder.sent` on/after | reminder command refused before open |
| `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15` | not_before_gate | `fpi.reminder.sent` | `reminder_mailed_at` | +15 calendar_days | gate opens | charge refused before open |
| `REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15` | deadline (evaluation) | `fpi.reminder.sent` | `reminder_mailed_at` | +15 calendar_days | evidence evaluation recorded at window end | sev-2 if evaluation missing |
| `INS_FPI_FIRST_NOTICE_SLA_3BD` | deadline (policy) | `fpi.case.opened` (not k5-blocked) | opened_at | 3 business_days_servicer | `fpi.first_notice.sent` | sev-2 (collateral unprotected longer) |
| `REGX_1024_37D5_NOTICE_PRODUCTION_5BD` | not_before_gate (evidence-refresh) | notice put into production | production timestamp | 5 business_days_federal (comment 37(d)(5)-1) | mailing | notices produced > 5 federal business days before mailing must be regenerated with current evidence |
| `REGX_1024_17K5_LPI_PURCHASE_GATE` | not_before_gate (3.7) | as in 9.1 | — | — | — | placement refused |
| `FNMA_B601_LPI_AFTER_ATTEMPTS` | not_before_gate | `fpi.case.opened` | — | opens only after `first_notice.sent` and `reminder.sent` events exist | — | placement refused (B-6-01 "only after unsuccessful attempts") |
| Jurisdiction overrides | | NY Reg 202 / CA amount cap alter placement parameters **[UNVERIFIED]** | | | | |

Calendar note: all §1024.37 offsets are **calendar days** anchored on the **date placed in the mail** (proof-of-mailing date) or hand-delivery date; a gate that opens on a weekend simply opens that day. The (d)(5) "reasonable time" uses `business_days_federal` (Section 4.1 unit: excludes legal public holidays, Saturdays and Sundays).

#### Business rules and calculations
1. **Reasonable basis** (must be recorded before the notice): one of — carrier/agent cancellation or non-renewal notice; vendor snapshot showing expiration passed with no renewal evidence after the 9.1 outreach; borrower statement; evidence rejected under comment 37(c)(1)(iii)-2; insufficient-coverage finding (9.1 adequacy FAIL of a kind LPI can cure — coverage amount/perils). Deductible-excess, rating and mortgagee-clause deficiencies are *not* LPI triggers (LPI cannot cure them) — they stay in 9.1 deficiency handling.
2. **Track selection**: `insurance_type='flood'` required by the FDPA → `fdpa_flood` (9.6). Wind-only gap → `regx_hazard` with `insurance_type='wind'` and the notice's [Insurance Type] = "windstorm"; comment 37(c)(2)(v)-1 identification.
3. **Escrow guard**: escrowed AND `regx_days_delinquent ≤ 30` → never FPI: the servicer pays/advances the renewal (3.7) or, on carrier non-renewal, may obtain a replacement policy *with the borrower's agreement* (comment 37(a)(2)(iii)-1) — outside §1024.37; escrowed AND > 30 → 3.7's (k)(5) gate; non-escrowed → proceed.
4. **LPI coverage amount** (policy; B-6-01 silent): `coverage = min(last_known_coverage_cents if within ±15% of RCV_estimate else RCV_estimate, state_cap)`; never below UPB unless RCV < UPB (then RCV — one cannot insure above replacement value in capped states); for vacant properties use the carrier's vacancy form and adjust to RCV (B-2-01 over-insurance rule). RCV estimate from the LPI carrier's valuation tool or the last verified policy. Deductible per B-6-01 tier (worked: coverage $250,000.00 → tier "$100,000 to $250,000" → $2,000; $250,000.01 → $2,500).
5. **Notice content assembly** from `fpi_cases` + `insurance_deficiencies`: [is expiring]/[expired]/[provides insufficient coverage] chosen from `kind`; "we bought"/"will buy" = "will purchase" until `lpi_bound` (placement happens after the cycle — B-6-01), so first notices always say "will purchase"; [Insurance Type] "hazard" unless wind; account number allowed; nothing else on the notice pages; any inserts (e.g., agent list, Spanish version) on separate sheets in the same envelope. Checklist enforces (c)(2)(i)–(xi) + bold items + first-class mail class + servicer phone.
6. **Earliest charge date** = max(t0 + 45, t1 + 15) where t0/t1 are mailing dates; `chargeable` only if no continuous-coverage evidence by end of t1 + 15 (evidence received on day 15 counts). Charge then covers `lapse_start` → placement expiration (retroactive per comment 37(c)(1)(i)-1), less any period the borrower proves was covered.
7. **Ledger** — non-escrowed loan: at binding, Dr `corporate_advances` (loan) / Cr corporate cash (vendor premium paid); at charge assessment, the borrower-owed amount is presented on the periodic statement as "Lender-placed insurance premium" (Section 7.1) with the advance receivable as the source; borrower payments applied per contract order (interest, principal, escrow, then charges — C-1.1-01). Escrowed loan (k(5) inability case): the charge is a `disbursements` row `disbursement_kind='lpi_premium'` executed by 3.7 (Dr loan `escrow` / Cr `custodial_ti_cash`; advance if negative), followed by an interim escrow analysis (3.2/3.6) — never a lump-sum demand. Fannie Mae reimbursement of advanced premiums on delinquent loans per F-1-05 through Section 15.2, net of commissions (none) and unearned-premium refunds.
8. **Worked example** (non-escrowed): borrower policy expired **2026-10-01** (Thu); vendor non-renewal notice received 2026-10-02 → reasonable basis; case opened 10/02; first notice `INS_FPI_FIRST_MS3A` mailed **2026-10-05** (Mon) = t0 → gates: reminder not before 2026-11-04; charge not before 2026-11-19. Reminder mailed 2026-11-04 (Wed) = t1 (9.3) → charge not before 2026-11-19 and evidence window ends 2026-11-19. No evidence → 2026-11-19 `chargeable`; placement bound 2026-11-19 effective **2026-10-01** to **2027-10-01** (365 days), coverage $250,000 (last known $250,000 within 15% of RCV $262,000), deductible $2,000, annual premium **$2,190.00** (the reminder disclosed "estimated $2,190" from the carrier's rate table — comment 37(d)(2)(i)(D)-1). Charge assessed 2026-11-20 for $2,190.00 covering 2026-10-01 → 2027-09-30. Daily rate for later refunds = 219,000 ÷ 365 = 600 cents/day (decimal.js; final cents round-half-up).
9. **State overlays**: `lpi_prompt_charge_prohibited` and NY Reg 202 constraints (rates, notice) applied from `jurisdiction_rules` **[UNVERIFIED specifics]**; CA amount cap enforced in rule 4.

#### Integrations
- **`insurance-tracking/lpi`**: outbound `lpi_placement_request` {loan, property, coverage, deductible tier, effective/expiration, occupancy}, inbound `lpi_bound` {policy no., premium, effective}, `lpi_billing`, later `lpi_cancel_request/ack` and `refund_advice` (9.5); idempotency key = `fpi_case_id + cycle`; ack timeout 2 business days → sev-2; vendor may not mail notices for us (default) — if the vendor prints, it must return the mailing date and first-class evidence per notice (open decision 9.2-Q1).
- **`print-mail`**: first-class only (`mail_class` locked); returns proof-of-mailing with date → `first_notice_mailed_at`; returned mail → address research (4.x) and re-mail (the 45-day clock is *not* restarted by re-mailing to the same address; a new address triggers a new first notice — conservative policy).
- **Escrow (3.7)**: `lpi_premium` disbursement command for escrowed cases; the (k)(5) gate.
- **Fannie Mae**: no system step; B-6-01 document requests via e-mail/upload by `fnma_portal_operator`/`officer`.

#### Outputs and artifacts
- Notice `INS_FPI_FIRST_MS3A` (§1024.37(c)(2), model MS-3(A)); checklist: date; servicer name/address; borrower name/address; bold request + physical address; expiring/expired/insufficient statement + lack-of-evidence + type; bold "required … at the borrower's expense … will purchase"; prompt request; description of information and delivery methods (mail address, e-mail, portal upload, fax; "in writing" if required); bold cost and coverage warnings; phone; additional-information pointer; only account number extra; first-class mail. Always mailed; an electronic duplicate may be sent with `esign` consent but the mailed copy anchors the timers (policy).
- Records: `fpi_cases`, `lpi_placements`, `lpi_charges`; `loan_events`: `fpi.case.opened/k5_blocked/first_notice.sent/reminder_eligible/chargeable/lpi_bound/charge.assessed/closed`; ledger postings per rule 7; investor events: escrow disbursement event for escrowed placements (3.7).

#### AI agent design (AI-first)
- `insurance-property` agent tools: `assessReasonableBasis`, `checkEscrowGuard` (calls 3.7 gate), `composeNotice(MS3A)`, `mailNotice`, `evaluateEvidence`, `requestPlacement`, `assessCharge`, `openHumanTask`, `escalate`; the `borrower-comms` agent handles inbound questions with a scripted explanation of the notice, cost warning and how to submit evidence, and warm-transfers to `human_agent` on request.
- Decision record: {case, basis evidence hashes, escrow/k5 evaluation, track, notice version, mailing evidence, gate dates, estimate basis, placement parameters, rationale, versions}.
- Guardrails (code, not prompt): no notice without a recorded basis; no charge before gates; no placement before both notices; no affiliate carrier (vendor id whitelist); no fees added to the premium; every cost figure traced to the carrier rate table. Escalations: `officer` for Fannie Mae LPI documentation requests and program certifications; `attorney` for state-law prohibitions flagged by `jurisdiction_rules`; `human_agent` on request.
- AI-off: ops-console queue; timers, gates and notices still generated by the deterministic engine.

#### Edge cases and failure modes
- Evidence arrives on day 44 showing coverage from a later date (gap remains): cycle continues; reminder variant switches to MS-3(C) (9.3) if not yet sent, or the charge is limited to the proven gap.
- Escrowed borrower becomes > 30 days overdue mid-cycle (started while current): placement remains permitted only if inability exists; otherwise the agent advances the renewal and closes the case — re-evaluate at each transition.
- Transfer-in with a prior servicer's notices: default restart (9.2-Q3); transfer-out mid-cycle: notify transferee of dates; no charge after transfer effective date.
- Bankruptcy: notices with BK overlay; no charges assessed post-petition without counsel review of the plan/stay (Section 14) — placement still allowed to protect collateral.
- Disaster: carriers' emergency moratoria; state plan as sole coverage; FEMA area tolerance (9.1-Q4) — placement still proceeds once the cycle ends.
- Vendor bind failure/outage: retry; if > 2 business days, alternate carrier per program; the borrower charge waits for a bound policy.
- Returned mail: research; new address → new first notice; same address → keep timers, document.
- Servicer error (wrong lapse): cancel, reverse all charges with refund (9.5 path), apology notice, NoE-style log.
- Successor in interest: confirmed successor receives notices; charges bind the loan account not the person.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 9.2-T1 | Given non-escrowed loan, lapse 2026-10-01, first notice mailed 2026-10-05 When day 44 (2026-11-18) Then charge command refused (`REGX_1024_37C_FPI_FIRST_NOTICE_45` closed). |
| 9.2-T2 | Given reminder mailed 2026-11-04 When 2026-11-19 Then both gates open; charge allowed; effective date retro 2026-10-01; premium $2,190.00 → 600 c/day. |
| 9.2-T3 | Given escrowed loan, borrower 45 days overdue, carrier cancelled for non-payment When lapse detected Then `k5_blocked`, premium advanced by 3.7, no FPI notice. |
| 9.2-T4 | Given escrowed loan, borrower 45 days overdue, insurer cancellation citing "underwriting" When lapse detected Then inability documented, gate open, cycle proceeds. |
| 9.2-T5 | Given a notice rendered with an extra marketing paragraph When checklist runs Then render fails ((c)(4)). |
| 9.2-T6 | Given a windstorm-only gap When notice composed Then [Insurance Type]="windstorm" and (v)(C) statement present. |
| 9.2-T7 | Given a notice produced 2026-10-01 and mailed 2026-10-09 (6 federal business days later; 2026-10-12 is Columbus Day but after) When mailing Then regeneration required per (d)(5) rule; produced 2026-10-05 → allowed. |
| 9.2-T8 | Given evidence received 2026-11-19 (day 15) When evaluated Then no charge; case closed `closed_evidence`. |
| 9.2-T9 | Given flood required by FDPA lapses When case opened Then track `fdpa_flood`, no MS-3A. |
| 9.2-T10 | Given LPI vendor offers a "servicer expense reimbursement" fee When placement configured Then rejected (B-6-01 commission exclusion). |
| 9.2-T11 | Given a CA property with RCV $310,000 and last-known $360,000 When coverage computed Then $310,000 (cap), deductible $2,500. |

#### Audit and evidence
Reasonable-basis evidence and decision record; notice render with checklist result, template version, bold-format proof (PDF), proof-of-mailing (date, class); timer history (gates opened/closed with timestamps); placement request/ack messages; charge ledger entries; borrower contacts about the notice; carrier rate table version used for estimates — all `life_of_loan_plus_4y`; NoE linkage (Section 4.1) for any dispute.

### Open questions / decisions
1. Who prints/mails FPI notices — platform Notice Registry vs. LPI vendor — **default: platform** (single evidence chain), vendor optional with per-piece evidence.
2. Bind timing — at cycle end with retroactive effective date (**default**) vs. binding at detection with deferred charging (higher premium cost for the servicer while notices run).
3. Transfer-in mid-cycle — **default: restart the cycle** (prior notices not adopted) unless transferor evidence meets our checklist and dates.
4. Pre-expiration "is expiring" first notice — **default: no**; first notice on expiration + 1 day after the −30-day courtesy request; revisit after 6 months of complaint data.
5. Electronic delivery — **default: always mail; e-copy additionally with consent.**
6. LPI coverage method and ±15% tolerance — confirm with the partner's LPI program and state counsel.

### Sources
- 12 CFR 1024.37; Supplement I comments 37(a)(2)(iii)-1, 37(b)-1, 37(c)(1)(i)-1, 37(c)(1)(iii)-1/-2, 37(c)(2)(v)-1, 37(d)(5)-1: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.37 ; https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Supplement%20I%20to%20Part%201024 — verified 2026-09-09
- Appendix MS-3 model forms (CFPB interactive): https://www.consumerfinance.gov/rules-policy/regulations/1024/ms3/ — verified 2026-09-09
- 12 U.S.C. 2605(k)–(m), (f): https://www.law.cornell.edu/uscode/text/12/2605 — verified 2026-09-09
- 12 CFR 1024.17(k)(5) and Section 3.7 of this specification — verified 2026-09-09
- Servicing Guide B-6-01 (10/14/2015): https://servicing-guide.fanniemae.com/svc/b-6-01/lender-placed-insurance-requirements — verified 2026-09-09
- Servicing Guide F-1-05 (06/11/2025): https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement — verified 2026-09-09
- LL-2026-03 (LPI item mandatory 2027-01-01) — URL in 9.1 sources — verified 2026-09-09
