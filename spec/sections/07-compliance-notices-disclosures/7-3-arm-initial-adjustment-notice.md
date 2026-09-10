# 7.3 — ARM initial adjustment notice

| Attribute | Value |
|---|---|
| Section | 7 — Compliance Notices & Disclosures |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | First adjustment |
| Governing source | Reg Z 1026.20(d) |
| Key deadlines | 210–240 days before first adjusted payment |
| Timers | `REGZ_1026_20D_ESTIMATE_INDEX_15BD`, `REGZ_1026_20D_INITIAL_NOTICE_210`, `REGZ_1026_20D_INITIAL_NOTICE_NOT_BEFORE_240`, `SM_ARM_INITIAL_FILE_CHECK_T0`, `SM_ARM_INITIAL_SEPARATE_DOC_GATE` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Compliance |
| Trigger & frequency | First adjustment |
| Governing source (blueprint) | Reg Z 1026.20(d) |
| Key deadlines (blueprint) | 210–240 days before first adjusted payment |
| Data/artifacts | Notice |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | Sub |
| Nuances (blueprint) | (none) — reconstructed: separate document; estimate permitted and labeled, based on an index published within 15 business days before the disclosure date; content adds alternatives (refinance, sell, modify, forbearance) and counseling resources; exemption for terms ≤ 1 year; at-consummation delivery when the first adjusted payment is due within 210 days (originator's duty); H-4(D)(3)/(4) formats |

### Verified requirement (as of 2026-09-09)

**Reg Z 12 CFR 1026.20(d) (eCFR current Sept. 3, 2026; CFPB interactive regulation verified today).**
- **Coverage (d)(1)(i):** same ARM definition as (c); comment 20(d)-1: creditors, assignees and servicers owning the loan or the MSR are subject; comment 20(d)-2: loss-mitigation modifications are exempt, but an initial adjustment under a modified adjustable contract is covered; comment 20(d)-4: open-end accounts converted to closed-end ARMs need the notice only for the first post-conversion adjustment. **Exemption (d)(1)(ii):** "The requirements of this paragraph (d) do not apply to ARMs with terms of one year or less" — there is **no FDCPA exemption** in (d), unlike (c)(1)(ii)(C).
- **Timing (d)(2):** "at least 210, but no more than 240, days before the first payment at the adjusted level is due. If the first payment at the adjusted level is due within the first 210 days after consummation, the disclosures shall be provided at consummation." Comment 20(d)-3: delivery or mailing "between 210 and 240 days before the first payment at the adjusted level is due," excluding grace or courtesy periods; the disclosures "shall be provided as a separate document from other documents provided by the creditor, assignee, or servicer" (may share an envelope/email with other documents per comment 20(d)-3).
- **Estimates (d)(2):** "If the new interest rate (or the new payment calculated from the new interest rate) is not known as of the date of the disclosure, an estimate shall be disclosed and labeled as such. This estimate shall be based on the calculation of the index reported in the source of information described in paragraph (d)(2)(iv)(A) of this section within fifteen business days prior to the date of the disclosure." Comment 20(d)(2)(iii)(A)-1: "The new payment, if calculated from an estimated new interest rate, will also be an estimate." The notice must then state "that another disclosure containing the actual new interest rate and new payment will be provided to the consumer between two and four months before the first payment at the adjusted level is due." Comment 20(d)(2)(i)-1: the disclosure date is the date the servicer generates the notice.
- **Content (d)(2)(i)–(xi):** (i) date of the disclosure; (ii) a statement that under the loan terms the rate/payment period is ending and the rate and payment may change, the effective date and the schedule of future adjustments, and any other changes to terms or features taking effect at the same time; (iii) the table — current and new (possibly estimated) rates, current and new payments and the date the first new payment is due, allocation for IO/neg-am loans; (iv) how the rate is determined — the specific index/formula, "a source of information about the index," margin and any foregone-increase adjustments; (v) rate/payment limits and foregone increases; (vi) how the new payment is determined (index, adjustments, expected balance, remaining term and any term change); (vii) IO/neg-am amortization statements; (viii) prepayment-penalty disclosure; (ix) the servicer's telephone number; (x) alternatives — "Refinancing the loan with the current or another creditor or assignee; Selling the property and using the proceeds to pay the loan in full; Modifying the terms of the loan with the creditor, assignee, or servicer; and Arranging payment forbearance with the creditor, assignee, or servicer"; (xi) CFPB/HUD counseling website and HUD telephone number and the state housing finance authority contact. **Format (d)(3):** table "in the same order as, and with headings and format substantially similar to" H-4(D)(3) and (4); comment 20(d)(3)(i)-1 allows modification for payment-option ARMs.
- **Electronic delivery:** §1026.17(a)(1) — E-SIGN consent required (7.4, class `arm_notices`).

**Fannie Mae.** C-2.1-02 (08/13/2025) requires notice "before the effective date of any change ... in accordance with applicable law" — satisfied by the Reg Z (d) and (c) notices; no Fannie Mae-specific 210-day rule. C-2.1-01's "use its own funds to satisfy any shortage resulting from untimely ... adjustments" applies if a late (d) notice forces a deferral. Standard plans 4926–4929 have 19–150-month initial periods (Standard ARM Plan Matrix), so the (d) notice is always a servicer (not originator) event for boarded loans except Plan 4926 loans transferred late in year 3.

**Discrepancies with the blueprint row:** (1) the row does not say the notice must be a separate document; (2) the estimate/15-business-day index rule and the "actual notice will follow in 2–4 months" statement are missing; (3) the alternatives and counseling content is materially longer than (c); (4) "Systems: Core" — needs the same index feed and the state HFA contact table (`jurisdiction_rules.hfa_contact`); (5) the ≤1-year exemption and the absence of an FDCPA exemption are not noted.

### Operational prerequisites
- `arm_schedule` populated at boarding (7.2) with `first_change_date` and `initial_period_months`; for transfers-in, checklist item `ARM_INITIAL_NOTICE_SENT` (with a copy) in the transfer file (17.3/1.7) when the transfer date is inside or after the (d) window.
- Template `NTC_REGZ_20D_ARM_INITIAL` (H-4(D)(4) basis; estimate and actual variants; counsel approved) — Notice Registry.
- `jurisdiction_rules.hfa_contact` (state housing finance authority name/phone/URL for all 50 states + DC) — Supermortgage compliance; 2 weeks; **[data to be compiled and verified]**.
- `index-feed` (7.2) with a 15-business-day recency check on the `servicer` calendar.
- E-SIGN class `arm_notices` (7.4) for electronic delivery.

### Build spec
#### Inputs and triggers
- `arm_schedule` row for the first change date → `arm.initial_notice.window_opened` at `first_new_payment_due − 240`.
- `arm.index.captured` (daily) — estimate basis.
- `loan.boarded` inside/after the window → immediate assessment.
- `lossmit.modification.effective` (12.8) producing an adjustable modified note (rare) → new first change date.
- `loan.terms.corrected` (boarding error on first change date) → reschedule.

#### Data model
- `arm_schedule` (7.2) fields used: `is_initial bool`, `initial_notice_window_open date`, `initial_notice_due_by date`, `initial_notice_id`, `initial_notice_basis` ∈ {estimate, actual}.
- `arm_initial_estimates`: `loan_id`, `disclosure_date`, `index_effective_date`, `index_value`, `est_rate_bps`, `est_pi_cents`, `expected_upb_cents`, `remaining_term_months`, `is_estimate bool`, `notice_id`.
- `jurisdiction_rules.hfa_contact jsonb` {name, phone, url}.
- Retention `life_of_loan_plus_4y`.

#### State machine
`scheduled` → `window_open` (T−240) → `estimated` (index within 15 BD) → `rendered` → `checked` → `sent` (by T−210) → `awaiting_actual` → closed when the 7.2 (c) notice is sent. Exceptions: `originator_duty` (first adjusted payment within 210 days of consummation — verify the consummation disclosure in the file), `exempt_short_term` (≤ 1-year term), `transferor_sent` (evidence in transfer file), `late` (boarded after T−210 without evidence → send immediately, log breach source). Actors: `disclosures` agent; ops on holds.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGZ_1026_20D_INITIAL_NOTICE_NOT_BEFORE_240` | not_before_gate | `arm_schedule` (initial) | `first_new_payment_due` | −240 calendar_days | gate opens | send blocked before |
| `REGZ_1026_20D_INITIAL_NOTICE_210` | deadline | `arm_schedule` (initial) | `first_new_payment_due` | −210 calendar_days (deliver/mail by) | `notice.sent` (`NTC_REGZ_20D_ARM_INITIAL`) or `arm.initial_notice.transferor_evidenced` | sev-1; immediate send; C-2.1-01 shortage handling if the payment change must be deferred (7.2 decision 5) |
| `REGZ_1026_20D_ESTIMATE_INDEX_15BD` | not_before_gate (data recency) | `arm.initial_notice.render_requested` | disclosure date | index `effective_date` ≥ disclosure date − 15 business_days_servicer | render allowed | hold; refresh index |
| `SM_ARM_INITIAL_FILE_CHECK_T0` | deadline | `loan.boarded` (ARM within 300 days of first new payment due) | boarding date | +5 business_days_servicer | `arm.initial_notice.status_determined` | sev-2 |
| `SM_ARM_INITIAL_SEPARATE_DOC_GATE` | not_before_gate | render | — | `notice_templates.separate_document = true` enforced by the mail/e-delivery composer (own PDF; own first page; may share envelope) | — | block |

#### Business rules and calculations
1. **Applicability:** `term_months > 12` and `first_change_date` exists; if `first_new_payment_due − consummation_date ≤ 210 days`, the duty was the originator's at consummation — verify the file (`documents.kind = arm_initial_disclosure_consummation`) and record `originator_duty`; otherwise the servicer sends.
2. **Window:** `[first_new_payment_due − 240, first_new_payment_due − 210]`; send target = window open + 5 calendar days (`disclosure_date`), giving ~25 days of buffer.
3. **Estimate:** use the latest `index_value` with `effective_date` within 15 servicer business days before `disclosure_date`; `est_rate = cap_and_floor(round_to_eighth(index + margin))` using the 7.2 engine with `expected_upb` computed for the first change date and `remaining_term` from `first_new_payment_due`; both rate and payment labeled "estimate"; include the "actual notice between two and four months before" sentence. If, unusually, the index date has already passed at render (loans with look-back ≥ 210 days — none in standard plans), mark `actual`.
4. **Content assembly:** (ii) schedule sentence ("every 6 months thereafter"), (iv) index/source, (v) caps and floor, (vi) balance/term, (viii) "no prepayment penalty," (ix) toll-free number, (x) alternatives list verbatim, (xi) CFPB URL, HUD (800) 569-4287, state HFA contact from `jurisdiction_rules` by property state.
5. **Separate document:** rendered as its own PDF with its own envelope insert; may co-mail with the periodic statement but never inside it.
6. **Re-issue:** if the loan's terms are corrected after sending (e.g., wrong margin), send a corrected (d) notice if still ≥ 210 days out; otherwise rely on the (c) notice with the correct figures and document the discrepancy.

**Worked example (same loan as 7.2).** First new payment due Dec 1, 2026 → window **April 5 – May 5, 2026**; disclosure date April 20, 2026 (Monday). Index: 30-day Average SOFR published April 20, 2026 = **3.64381** (within 15 business days). Estimate: 3.64381 + 2.750 = 6.39381 → **6.375% (estimated)**; expected UPB at Nov 1, 2026 $371,048.86; 300 months → **$2,476.44 (estimated)** P&I vs current $2,334.29; "Your rate will change on Nov. 1, 2026 and every six months thereafter; the first payment at the new rate is due Dec. 1, 2026"; caps: "your rate cannot increase or decrease by more than 2.000% at this change, by more than 1.000% at later changes, or ever exceed 10.750%; it will never fall below 2.750%"; alternatives and counseling per (x)/(xi); footer: "the actual rate and payment will be sent between two and four months before Dec. 1, 2026." Mailed April 21, 2026 (T−224 ✓). The 7.2 (c) notice then follows between Aug 3 and Oct 2, 2026 with the actual Sept 17 index.

#### Integrations
Same as 7.2 (index feed, print/mail, e-delivery); no Fannie Mae reporting for the (d) notice. Transfer file (17.3/1.7): `arm_initial_notice` document and dates travel with the loan.

#### Outputs and artifacts
- Notice `NTC_REGZ_20D_ARM_INITIAL` (1026.20(d); checklist: disclosure date; (ii) statement with effective date and schedule; nested table with estimate labels when applicable; index/source; margin; caps/foregone increases; balance/term; amortization statements; prepayment penalty; phone; four alternatives; CFPB/HUD/HFA contacts; "actual notice in 2–4 months" sentence when estimated; H-4(D)(4) order; `separate_document`). Channel `esign_or_mail` (class `arm_notices`).
- `arm_initial_estimates`, `notices`, `documents`, `loan_events` `arm.initial_notice.window_opened/rendered/sent/originator_duty/transferor_evidenced/late`.

#### AI agent design (AI-first)
- **Agent:** `disclosures`; deterministic estimate via the 7.2 engines; the agent determines applicability (boarding evidence review — the LLM may read the transferor's document image to confirm a prior (d) notice, with a human QC sample), renders, checks, sends, and records `{loan_id, disclosure_date, index_effective_date, index_value, est_rate, est_pi, basis, window, sent_at, channel, consent_id, evidence_document_id}`.
- **Guardrails:** no send outside the window; no numbers from the LLM; the "transferor sent it" determination requires an attached document.
- **Escalations:** `human_agent` on request; `officer` for portfolio-wide index fallback; none otherwise. AI-off: ops-console batch.

#### Edge cases and failure modes
- **Boarded after T−210 with no transferor evidence:** send immediately; record breach attributable to the transferor (17.x/1.7 claim); if boarded after T−60 the (c) notice is sent immediately as well.
- **Plan 4926 (3/6) loans transferred in month 32–36:** the (d) window may straddle the transfer — 1.7 checklist forces status determination within 5 business days.
- **Index within 15 business days unavailable** (feed outage): hold until refreshed; the 25-day buffer absorbs outages; escalate at T−215.
- **Loan pays off/transfers before the first change date:** cancel with reason.
- **Borrower in bankruptcy/foreclosure:** notice still required (no exemption); addressing per 14.3 (counsel copy where required); a Chapter 13 plan modification of the rate does not change the note for (d) purposes unless the loan is modified.
- **FDCPA cease request:** no (d) exemption — send it (informational; counsel-reviewed wording).
- **SCRA cap:** notice shows contractual figures with a SCRA explanation insert.
- **Successor in interest:** as 7.2.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 7.3-T1 | Given first new payment due 2026-12-01, then the window is 2026-04-05..2026-05-05; a send on 2026-04-04 is blocked; a send on 2026-05-06 breaches. |
| 7.3-T2 | Given disclosure date 2026-04-20 and index 3.64381 published 2026-04-20, then the estimate is 6.375% / $2,476.44, both labeled "estimate," with the 2–4-month follow-up sentence. |
| 7.3-T3 | Given the latest index publication is 16 business days old, then rendering is held until a fresh value is captured. |
| 7.3-T4 | Given a loan boarded 2026-06-01 (T−183) with a transferor (d) notice image dated 2026-04-15 in the file, then status = `transferor_evidenced` and no duplicate is sent. |
| 7.3-T5 | Given the same boarding with no evidence, then the notice is sent within 5 business days and a transferor-breach record is created. |
| 7.3-T6 | Given an ARM with a 12-month term, then status = `exempt_short_term`. |
| 7.3-T7 | Given the notice is co-mailed with the periodic statement, then it is a separate PDF with its own first page and the composer log shows two documents in one envelope. |
| 7.3-T8 | Given a Texas property, then the (xi) block names the Texas state housing finance authority from `jurisdiction_rules`. |
| 7.3-T9 | Given the margin is corrected on 2026-04-28 after a 2026-04-21 send, then a corrected (d) notice is sent by 2026-05-05. |

#### Audit and evidence
`arm_initial_estimates`, `notices`/`notice_deliveries`, `documents` (PDF; transferor evidence), timer history (window vs send date), `agent_decisions`.

### Open questions / decisions
1. Send the (d) notice at the start of the window (T−235) or mid-window? **Default: T−235 (window open + 5 days)** to preserve buffer for vendor delays.
2. Attach a plain-language cover explaining the estimate and the later actual notice? **Default: yes** (additional information outside the mandated table; counsel to confirm "substantially similar").
3. Source of the state HFA contact list — compile in-house or license? **Default: compile from HUD/NCSHA listings and verify annually [UNVERIFIED data set].**

### Sources
- 12 CFR 1026.20(d) and interpretations (see 7.2 sources) — verified 2026-09-09
- Appendix H forms H-4(D)(3)/(4) — verified 2026-09-09
- Fannie Mae C-2.1-01, C-2.1-02, Standard ARM Plan Matrix (see 7.2) — verified 2026-09-09
- NY Fed SOFR Averages API (April 2026 values) — verified 2026-09-09
