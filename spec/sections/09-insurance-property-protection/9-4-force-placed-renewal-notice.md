# 9.4 — Force-placed renewal notice

| Attribute | Value |
|---|---|
| Section | 9 — Insurance & Property Protection |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | Before renewal |
| Governing source | Reg X 1024.37(e) |
| Key deadlines | ≥45 days before renewal charge |
| Timers | `INS_FPI_RENEWAL_COVERAGE_REVIEW_60`, `REGX_1024_37E1III_GAP_PROMPT_CHARGE`, `REGX_1024_37E5_FPI_RENEWAL_NOTICE_ANNUAL`, `REGX_1024_37E_FPI_RENEWAL_NOTICE_45` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Insurance |
| Trigger & frequency | Before renewal |
| Governing source (blueprint) | Reg X 1024.37(e) |
| Key deadlines (blueprint) | ≥45 days before renewal charge |
| Data/artifacts | Notice |
| Systems | LPI carrier |
| Automation class (blueprint) | b |
| SoR / Sub | [cropped in source] — reconstructed: Sub sends; partner liable |
| Nuances (blueprint) | [cropped in source] — reconstructed: one notice per year before each anniversary; (e)(1)(iii) prompt charge for a coverage gap discovered after the LPI expired; MS-3(D); B-2-01 over-insurance review at renewal; annual re-quote |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.37(e)(1)**: before assessing "any premium charge or fee related to renewing or replacing existing force-placed insurance," the servicer must (i) deliver or mail a written notice with the (e)(2) content "at least 45 days before assessing" the charge, and (ii) by the end of that 45-day period not have received evidence that the borrower purchased compliant hazard insurance; **(e)(1)(iii)**: "if not prohibited by State or other applicable law," where the servicer has renewed/replaced the LPI and later receives evidence that the borrower lacked coverage for some period after the prior LPI expired (including during the 45-day period), it "may promptly assess" the charge for that period (comment 37(e)(1)(iii)-1 illustrates). **(e)(2) content**: (i) date; (ii) servicer name/address; (iii) borrower name/address; (iv) a statement requesting the borrower to update the hazard insurance information, identifying the property by physical address; (v) that the servicer previously purchased insurance at the borrower's expense because it lacked evidence of coverage; (vi)(A) that the LPI has expired or is expiring, as applicable, and (B) that "because hazard insurance is required" the servicer intends to maintain it by renewing or replacing; (vii)(A) that the insurance may cost significantly more, (B) may not provide as much coverage, and (C) "the cost of the force-placed insurance, stated as an annual premium" or an identified reasonable estimate (comment 37(e)(2)(vii)-1); (viii) that if the borrower buys insurance the information should be provided promptly; (ix) description of the information and how to provide it, "in writing" if applicable; (x) telephone number; (xi) additional-information pointer. **(e)(3)** bold: (iv) (except the address), (vi)(B), (vii)(A)–(C); model **MS-3(D)**. **(e)(4)** account number only. **(e)(5)**: the notice must go "before each anniversary of the servicer's purchase" but "need not provide the notice … more than once a year." **Comment 37(e)(1)-1**: evidence standard as in comment 37(c)(1)(iii)-2. **(f)** first-class mail. Sources as in 9.2 (verified 2026-09-09). **Fannie Mae**: B-2-01's over-insurance adjustment and B-6-01's no-commission and documentation rules apply to each renewal; F-1-05 reimbursement of premiums on delinquent loans continues through the liquidation windows (Section 15.2).

**Discrepancies vs blueprint**: "before renewal" should be read as before *charging* for the renewal; the LPI carrier will typically renew coverage automatically on the anniversary regardless of the notice (collateral protection) — the notice governs the borrower charge, and the (e)(5) once-a-year rule means a single notice per cycle.

### Operational prerequisites
- Template `INS_FPI_RENEWAL_MS3D` with checklist; carrier renewal-quote feed ≥ 60 days before anniversary — Supermortgage; program clause that the carrier renews automatically with retroactive-gap billing where state law allows (e)(1)(iii) — Partner/Supermortgage.
- `jurisdiction_rules.lpi_prompt_charge_prohibited` populated **[UNVERIFIED]**.

### Build spec
#### Inputs and triggers
- `fpi.charge.assessed` → schedule the renewal cycle: anniversary A = `lpi_placements.effective_date + 1 year`; renewal notice target mailing at A − 60 days (window A − 60 … A − 45).
- Carrier `lpi_renewal_quote` (A − 60) → premium figure; `insurance.evidence.received/confirmed` → close/refund path (9.5).
- Coverage review trigger: occupancy/valuation changes (B-2-01 over-insurance) at A − 60.

#### Data model
- `fpi_cases.renewal_cycle` increments; `lpi_placements` new row per renewal term (linked `previous_placement_id`); `fpi_renewals` (new): `id`, `fpi_case_id`, `placement_id`, `anniversary_date`, `notice_id`, `notice_mailed_at`, `earliest_renewal_charge_date` (= mailed_at + 45), `quoted_premium_cents`, `premium_is_estimate`, `status` ∈ {scheduled, notice_sent, chargeable, charged, closed_evidence, closed_other}.

#### State machine
`charged` (9.2) → `renewal_scheduled` (A − 60) → `renewal_notice_sent` (t2) → `renewal_chargeable` (t2 + 45, no compliant evidence) → `renewal_charged` (on/after A, never before t2 + 45) → loops to `renewal_scheduled` for the next term; evidence at any point → 9.5. Gap discovered after the prior term expired → `prompt_gap_charge` (allowed where not prohibited) → back to the loop.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_37E5_FPI_RENEWAL_NOTICE_ANNUAL` | recurring deadline | `fpi.charge.assessed` / prior renewal | anniversary A | mail by A − 45 calendar_days (target A − 60) | `fpi.renewal_notice.sent` | sev-1: renewal charge date slips to mailed + 45; renewal coverage itself continues |
| `REGX_1024_37E_FPI_RENEWAL_NOTICE_45` | not_before_gate | `fpi.renewal_notice.sent` | t2 | +45 calendar_days | — | renewal charge refused before |
| `REGX_1024_37E1III_GAP_PROMPT_CHARGE` | policy flag | evidence of a post-expiration gap | — | immediate where `lpi_prompt_charge_prohibited=false` | charge or documented waiver | — |
| `INS_FPI_RENEWAL_COVERAGE_REVIEW_60` | deadline (policy; B-2-01) | A − 60 | A | −60 calendar_days | `fpi.renewal.coverage_reviewed` | sev-3 |

#### Business rules and calculations
1. **Once per year**: exactly one MS-3(D) per anniversary; if the previous cycle's notice was mailed < 365 days ago and the anniversary has not passed, do not send another ((e)(5)).
2. **Charge timing**: renewal charge date = max(A, t2 + 45); coverage renews on A regardless. Example: placement effective 2026-10-01 → A = **2027-10-01**; notice mailed **2027-08-02** (target A − 60) → chargeable 2027-09-16; renewal premium $2,250.00 charged on 2027-10-01. If the notice slipped to 2027-09-10, the charge waits until 2027-10-25 while coverage renewed 2027-10-01 (servicer carries 24 days).
3. **Coverage review** at A − 60: re-run 9.2 rule 4 (RCV estimate, occupancy, state cap) and adjust the renewal request; downward adjustments reduce the borrower's cost (B-2-01 over-insurance).
4. **Prompt gap charge**: if the borrower's own policy that ended the prior LPI (9.5) later lapses again after the LPI expired, and evidence of the gap arrives, the servicer may charge promptly for the gap period (no new 45-day cycle) where state law permits; otherwise a new 9.2 cycle is opened. Decision recorded either way.
5. **Estimate**: as in 9.3 rule 2 with the renewal quote.

#### Integrations
- `insurance-tracking/lpi`: `lpi_renewal_quote`, `lpi_renewal_bound`, `lpi_billing`; `print-mail` as 9.2.

#### Outputs and artifacts
- Notice `INS_FPI_RENEWAL_MS3D` (§1024.37(e)(2), model MS-3(D)); checklist per (e)(2)(i)–(xi) with bold (iv)/(vi)(B)/(vii)(A)–(C); first-class mail; always mailed.
- Events `fpi.renewal.scheduled/coverage_reviewed/notice.sent/chargeable/charged/gap_charge`; ledger postings as 9.2 rule 7; escrow disbursement event for escrowed cases.

#### AI agent design (AI-first)
- `insurance-property` tools: `reviewLpiCoverage`, `quoteLpiRenewal`, `composeNotice(MS3D)`, `mailNotice`, `assessRenewalCharge`, `assessGapCharge`; decision record includes the coverage-review rationale. Guardrails: one notice per year; no charge before the gate; gap charges only where the jurisdiction rule permits. Escalations: `attorney` for state-law prohibition questions; `human_agent` on request. AI-off: deterministic renewal job.

#### Edge cases and failure modes
- Borrower policy obtained mid-term of the LPI: 9.5 cancels; the renewal cycle is cancelled; if that policy later lapses, prompt gap charge/new cycle per rule 4.
- Payoff/transfer/REO before A: cancel the renewal; cancel LPI at payoff (refund unearned premium to the borrower where the borrower paid — 9.5 logic).
- Coverage amount changes at renewal (RCV drop): notice's cost figure reflects the new amount.
- Carrier replaced (program change): "replacing" notice uses the same MS-3(D) content.
- Bankruptcy overlay on notice language; no charge without counsel where the plan governs.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 9.4-T1 | Given placement effective 2026-10-01 When 2027-08-02 Then MS-3(D) mailed; renewal charge refused before 2027-09-16. |
| 9.4-T2 | Given the notice mailed 2027-09-10 Then renewal coverage binds 2027-10-01 but the charge posts 2027-10-25. |
| 9.4-T3 | Given a second MS-3(D) attempted 200 days after the first for the same anniversary Then refused ((e)(5)). |
| 9.4-T4 | Given evidence of a 20-day post-expiration gap in a state without a prohibition Then prompt gap charge for 20 days at the renewal daily rate; in a prohibited state a new 9.2 cycle opens. |
| 9.4-T5 | Given RCV estimate drops to $230,000 at review Then renewal coverage $230,000 and tier deductible $2,000. |

#### Audit and evidence
Renewal notice render/checklist/proof of mailing, quote basis, coverage-review decision record, gate timers, charge ledger entries; `life_of_loan_plus_4y`.

### Open questions / decisions
1. Notice target at A − 60 (**default**) vs A − 45 exactly (tighter, more breach risk).
2. Whether to apply (e)(1)(iii) prompt gap charges at all — **default: yes where permitted**, with a decision record; partner may opt for the conservative "always a new cycle."

### Sources
- 12 CFR 1024.37(e), (f); comments 37(e)(1)-1, 37(e)(1)(iii)-1, 37(e)(2)(vii)-1 — URLs in 9.2 — verified 2026-09-09
- Appendix MS-3(D) — https://www.consumerfinance.gov/rules-policy/regulations/1024/ms3/ — verified 2026-09-09
- Servicing Guide B-2-01 (over-insurance), B-6-01 — URLs in 9.1/9.2 — verified 2026-09-09
