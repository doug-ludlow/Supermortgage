# 9.3 — Force-placed — reminder notice

| Attribute | Value |
|---|---|
| Section | 9 — Insurance & Property Protection |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | After first notice |
| Governing source | Reg X 1024.37(d) |
| Key deadlines | ≥30 days after first notice AND ≥15 days before charge |
| Timers | `INS_FPI_REMINDER_TARGET_30_35`, `REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15`, `REGX_1024_37D5_NOTICE_PRODUCTION_5BD`, `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15`, `REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Insurance |
| Trigger & frequency | After first notice |
| Governing source (blueprint) | Reg X 1024.37(d) |
| Key deadlines (blueprint) | ≥30 days after first notice AND ≥15 days before charge |
| Data/artifacts | Reminder notice |
| Systems | LPI carrier |
| Automation class (blueprint) | b |
| SoR / Sub | [cropped in source] — reconstructed: Sub sends; partner liable |
| Nuances (blueprint) | [cropped in source] — reconstructed: two content variants (MS-3(B) no information / MS-3(C) information but no continuous coverage); annual-premium cost or identified reasonable estimate; "second and final notice" statement; bold rules; production-window rule for updating with borrower information |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.37(d)(1)**: the reminder must be delivered or mailed "at least 15 days before" assessing any force-placed charge, and "not earlier than 30 days after" the first notice was delivered or mailed. **(d)(2)(i)** — when the servicer "has not received any hazard insurance information" after the first notice, the reminder contains: (A) the date; (B) a statement that it is "the second and final notice"; (C) the (c)(2)(ii)–(xi) content; and (D) "the cost of the force-placed insurance, stated as an annual premium, except if a servicer does not know the cost of force-placed insurance, a reasonable estimate shall be disclosed and identified as such." **(d)(2)(ii)** — when the servicer received information but not evidence of *continuous* compliant coverage, the reminder contains: the date; the (c)(2)(ii)–(iv) and (ix)–(xi) items; a statement that the servicer received the information the borrower provided; a request for the missing information; a statement that the borrower will be charged for insurance the servicer purchased for the period(s) it cannot verify coverage; and the (d)(2)(i)(B) "second and final" and (D) cost statements. **(d)(3)**: (d)(2)(i)(B) and (D) in bold; (c)(3) bold rules apply to the (c)(2) content carried in; model forms **MS-3(B)** and **MS-3(C)**. **(d)(4)**: no other information except the account number; separate sheets allowed. **(d)(5)/comment 37(d)(5)-1**: if information arrives after the notice was "put into production," the servicer need not update it provided production was a reasonable time before mailing — "no more than five days (excluding legal public holidays, Saturdays, and Sundays)." **Comment 37(d)(1)-1**: content varies with what was received. **Comment 37(d)(2)(i)(D)-1**: a difference between the estimate and the actual cost is permissible if the estimate used information reasonably available when disclosed (e.g., estimating on current delinquency status when status affects coverage amount/cost). **(f)**: first-class mail or better. **RESPA §6(l)(1)(B)–(C)**: second notice "at least 30 days after the mailing of the first"; no demonstration within 15 days after mailing of the second. Sources as in 9.2 (verified 2026-09-09).

**Discrepancies vs blueprint**: none on timing; the row omits the two content variants and the annual-premium disclosure, which is the operationally hardest element (the estimate must come from the carrier's rate table before placement).

### Operational prerequisites
- Carrier rate table / quote API for the annual premium estimate by coverage amount, deductible tier, occupancy and state (vendor contract clause: quote at t0 + 25 days) — Supermortgage.
- Templates `INS_FPI_REMINDER_NOINFO_MS3B` and `INS_FPI_REMINDER_INSUFF_MS3C` with counsel sign-off; production-to-mail SLA with the print vendor ≤ 5 federal business days (contractual) — Supermortgage.
- Everything in 9.2.

### Build spec
#### Inputs and triggers
- `REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30` gate opens (t0 + 30) → reminder job selects the variant from `insurance_evidence` state; policy target: mail on t0 + 30 (first business day on/after) so the charge date coincides with t0 + 45.
- `insurance.evidence.received` before production changes the variant; after production (≤ 5 federal business days before mailing) → no update required but the evidence is evaluated for the charge decision.
- `fpi.case.closed` cancels the reminder.

#### Data model
- `fpi_cases.reminder_variant`, `reminder_mailed_at`, `reminder_production_at timestamptz`, `annual_premium_cents`, `premium_is_estimate`, `estimate_basis` (rate-table version, coverage, tier, occupancy, delinquency status used), `unverified_ranges jsonb` (for MS-3(C): [{start, end}]).
- `notices` row with `template_code`, `variant`, `production_at`, `mailed_at`, `mail_class`, proof document.

#### State machine
`reminder_eligible` → `reminder_in_production` (render + checklist) → `reminder_sent` (mailed_at recorded; sets `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15` and the 15-day evidence window) → `evidence_window` → `chargeable` | `closed_evidence`. If evidence arrives between production and mailing and production was > 5 federal business days ago → `reminder_regenerate` → `reminder_in_production`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30` | not_before_gate | `fpi.first_notice.sent` | t0 | +30 calendar_days | — | reminder refused before |
| `INS_FPI_REMINDER_TARGET_30_35` | deadline (policy) | gate open | t0 | mail between +30 and +35 calendar_days | `fpi.reminder.sent` | sev-3; each day of delay pushes the charge date |
| `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15` | not_before_gate | `fpi.reminder.sent` | t1 | +15 calendar_days | — | charge refused before |
| `REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15` | deadline | `fpi.reminder.sent` | t1 | +15 calendar_days | evidence evaluation recorded | sev-2 |
| `REGX_1024_37D5_NOTICE_PRODUCTION_5BD` | not_before_gate | `notice.production` | production_at | 5 business_days_federal | mailing within window | regenerate |

#### Business rules and calculations
1. **Variant**: `b_no_info` when no `insurance_evidence` row exists for the case after t0 (any channel — a phone statement with policy details counts as "information" only if written per the loan contract/our (viii) statement; policy: an oral statement without written follow-up is recorded but treated as no information — open decision 9.3-Q1); `c_insufficient` when information was received but evidence of continuous compliant coverage from `lapse_start` is lacking (gaps computed as date ranges → [Date Range] placeholders).
2. **Annual premium**: `annual_premium_cents` = carrier quote for the case parameters (9.2 rule 4); if the carrier cannot quote, use the program rate table and mark `premium_is_estimate=true` with "estimated" wording; the estimate basis is stored. Example: coverage $250,000, tier deductible $2,000, occupied, state TX rate 0.876% → 25,000,000 × 0.00876 = 219,000 cents = **$2,190.00** (round-half-up to cents at the end).
3. **Timing**: mailing on t0 + 30 (2026-11-04 in the 9.2 example) makes t1 + 15 = t0 + 45 (2026-11-19); mailing on t0 + 33 moves the charge to t0 + 48 (2026-11-22). The engine always computes `earliest_charge_date = max(t0+45, t1+15)`.
4. **Content**: MS-3(B) carries the full (c)(2)(ii)–(xi) block and the bold "second and final notice" and cost statements; MS-3(C) carries the received-information acknowledgment, the request for the missing period(s), the will-be-charged-for-unverified-period statement, cost statement and warnings; account number is the only extra.
5. **Production window**: `reminder_production_at` stamped when the render is frozen; mailing more than 5 federal business days later requires regeneration (and re-selection of the variant).

#### Integrations
- `insurance-tracking/lpi`: `lpi_quote_request/response` (idempotent per case/cycle; 1-business-day SLA; fallback rate table).
- `print-mail`: same as 9.2 with `production_at` and `mailed_at` returned per piece.

#### Outputs and artifacts
- Notices `INS_FPI_REMINDER_NOINFO_MS3B` (§1024.37(d)(2)(i)) and `INS_FPI_REMINDER_INSUFF_MS3C` (§1024.37(d)(2)(ii)); checklists per rule 4 with bold verification; first-class mail; always mailed.
- Events: `fpi.reminder.produced/sent/regenerated`, `fpi.evidence_window.evaluated`; `fpi_cases` updates; decision record with quote basis.

#### AI agent design (AI-first)
- `insurance-property` tools: `selectReminderVariant`, `quoteLpi`, `composeNotice(MS3B|MS3C)`, `mailNotice`, `evaluateEvidenceWindow`. The agent also runs a courtesy outreach (SMS/e-mail/AI voice with disclosure and consent) at t0 + 30 explaining the final notice — the outreach is logged but never substitutes for the mailed notice.
- Guardrails: variant selection is deterministic from evidence records (the model cannot override); cost figure must trace to a quote/rate-table record; the checklist blocks rendering without the "second and final notice" sentence. Escalations: `human_agent` on request; `officer` if a quote is unavailable for > 2 business days (charge date slips).
- AI-off: deterministic reminder job; staff handle exceptions.

#### Edge cases and failure modes
- Borrower supplies a policy effective the day after the reminder was produced: no regeneration needed if within 5 federal business days; the gap up to the new effective date remains chargeable; refund logic (9.5) never applies to a period without borrower coverage.
- Address change after the first notice: mail the reminder to the new address; if the first notice went to a bad address, restart (9.2 policy).
- Print vendor outage > 3 days: fall back to in-house first-class mailing with manifest; do not e-mail as the sole channel.
- Quote unavailable: estimate from rate table (flagged); if the actual premium is materially different the difference is permissible (comment 37(d)(2)(i)(D)-1) but the servicer may only charge the actual bona fide premium (h).
- Case closed by payoff before mailing: cancel the reminder.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 9.3-T1 | Given t0 = 2026-10-05 When 2026-11-03 Then reminder command refused; 2026-11-04 allowed. |
| 9.3-T2 | Given no evidence rows When rendered Then MS-3(B) with "second and final notice" and "$2,190.00 annually" in bold. |
| 9.3-T3 | Given a dec page received 2026-10-20 effective 2026-10-15 When rendered Then MS-3(C) with [Date Range] 2026-10-01 to 2026-10-14. |
| 9.3-T4 | Given production 2026-10-30 (Fri) and mailing 2026-11-09 (Mon; 6 federal business days later) Then regeneration required; mailing 2026-11-06 allowed. |
| 9.3-T5 | Given reminder mailed 2026-11-07 Then `earliest_charge_date` = 2026-11-22. |
| 9.3-T6 | Given the quote API fails Then estimate from rate table, flagged "estimated," basis stored. |

#### Audit and evidence
Notice render + checklist, production and mailing timestamps, proof of mailing, quote/rate-table basis, variant decision record, evidence-window evaluation record; retained `life_of_loan_plus_4y`.

### Open questions / decisions
1. Treat oral-only insurance information as "information received" (→ MS-3(C)) — **default: yes if the borrower gives a policy number and carrier** (safer: acknowledges receipt) while still requiring written evidence for continuous coverage.
2. Mail the reminder on t0+30 exactly — **default: first business day on/after t0+30**, never later than t0+35.

### Sources
- 12 CFR 1024.37(d), (f); Supplement I comments 37(d)(1)-1, 37(d)(2)(i)(D)-1, 37(d)(5)-1 — URLs in 9.2 — verified 2026-09-09
- Appendix MS-3(B)/(C): https://www.consumerfinance.gov/rules-policy/regulations/1024/ms3/ — verified 2026-09-09
- 12 U.S.C. 2605(l)(1)(B)–(C) — verified 2026-09-09
