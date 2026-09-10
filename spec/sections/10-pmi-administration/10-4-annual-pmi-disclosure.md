# 10.4 — Annual PMI disclosure

| Attribute | Value |
|---|---|
| Section | 10 — PMI Administration |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | Annually |
| Governing source | HPA 12 USC 4903 |
| Key deadlines | Annual for life of PMI |
| Timers | `CA_2954_6_NOTICE_WITH_STATEMENT`, `HPA_4903A3_ANNUAL_DISCLOSURE_12M`, `HPA_4905C2_LPMI_OPTIONS_NOTICE_30`, `MN_47_207_ANNUAL_NOTICE_12M`, `SM_MI_DISCLOSURE_COMPOSE_LEAD_30`, `SM_MI_FIRST_DISCLOSURE_POST_BOARDING_60` |

### Blueprint row
| Field | Value |
|---|---|
| Area | PMI |
| Trigger & frequency | Annually |
| Governing source (blueprint) | HPA 12 USC 4903 |
| Key deadlines (blueprint) | Annual for life of PMI |
| Artifacts | Notice |
| Systems | Print/mail |
| Automation class (blueprint) | a |
| SoR / Sub | S[cropped in source] — reconstructed: "Sub sends in the servicer's name; partner is servicer of record" |
| Nuances (blueprint) | [cropped in source] — reconstructed: "may be combined with the RESPA annual escrow statement or the IRS Form 1098 (4903(c)); different text for pre-July 29, 1999 loans (4903(b)); not required for lender-paid MI (4905(b)); state overlays (Minnesota 12-point statutory language; California notice with each annual statement); must include an address and telephone number" |

### Verified requirement (as of 2026-09-09)

**12 U.S.C. 4903 (verified 2026-09-09).** (a)(3) *Annual disclosure*: "If private mortgage insurance is required in connection with a residential mortgage transaction, the servicer shall disclose to the mortgagor in each such transaction in an annual written statement—(A) the rights of the mortgagor under this chapter to cancellation or termination of the private mortgage insurance requirement; and (B) an address and telephone number that the mortgagor may use to contact the servicer to determine whether the mortgagor may cancel the private mortgage insurance." (a)(4): paragraphs (1)–(3) apply to transactions consummated on or after July 29, 1999. (b) *Existing mortgages*: for PMI required on a residential mortgage entered into before that date, the servicer shall disclose "in an annual written statement" that "the private mortgage insurance may, under certain circumstances, be canceled by the mortgagor (with the consent of the mortgagee or in accordance with applicable State law)" plus an address and telephone number. (c) *Inclusion in other annual notices*: the disclosures "may be provided on the annual disclosure relating to the escrow account made as required under the Real Estate Settlement Procedures Act of 1974, or as part of the annual disclosure of interest payments made pursuant to Internal Revenue Service regulations." (d) *Standardized forms* permitted. (a)(1)–(2) are the mortgagee's consummation disclosures (initial amortization schedule and notice for fixed-rate loans; ARM notice that the servicer will notify the mortgagor when the cancellation date is reached and of termination/non-termination) — origination artifacts the servicer should retain but need not re-issue. **4905(b):** "Sections 4902 through 4904 of this title do not apply in the case of lender paid mortgage insurance" — no annual statement is required for LPMI (the 4905(c)(2) notice is process 10.2). **4907:** individual liability up to $2,000 statutory damages plus actual damages, costs and fees; class actions capped at the lesser of $500,000 or 1% of net worth; 2-year discovery limitation. CFPB Bulletin 2015-03 cites servicers that "did not send the required annual disclosures" or omitted the contact information.

**Fannie Mae.** B-8.1-04 and B-8.1-01 impose no annual MI disclosure; the annual escrow statement (B-1-01; Section 3.3) is the natural carrier. F-1-11 transfer lists include MI premium data but not disclosure dates — the platform must request the last-sent date from the transferor (Section 1.1 tape field `pmi_last_annual_disclosure_on`) **[UNVERIFIED transferor data availability]**.

**State overlays.** Minn. Stat. §47.207 subd. 3: annual written notice "in 12-point type or greater" with the statute's language that the mortgagor "may have the right under federal law or Minnesota law to cancel the insurance" and that cancellation may be possible when the principal balance "is 80 percent or less" of current fair market value; the notice "may be included with other federal disclosures"; no separate notice is required for bond-pooled loans covered by the federal notice. Cal. Civ. Code §2954.6: notice in "at least 10-point bold type," "without cost to the borrower," within 30 days after close of escrow and with "each written statement required by Section 2954.2," containing identifying loan/insurance information, the cancellation conditions (stating the LTV ratio "between the remaining principal balance of the loan and the original or current value" and "whether or not an appraisal may be necessary"), and the cancellation procedure; excludes bond-funded, FHA and VA loans **[PARTIALLY VERIFIED — the §2954.2 statement type was not retrieved; treat as the annual statement]**. Other protected-law states (CO, MD, MA, MO, NY, CT) — no annual-notice requirement identified; placeholders in `jurisdiction_rules` **[UNVERIFIED]**.

**Discrepancies with the blueprint row:** (1) "life of PMI" is right for BPMI; the row does not exclude LPMI or distinguish pre-1999 loans; (2) the statute permits combining with the escrow statement or 1098 — the platform's default is the escrow statement; (3) the row omits the contact-information requirement, the E-SIGN channel question, and the MN/CA content and font rules.

### Operational prerequisites
- Notice templates `NTC_HPA_4903A3_ANNUAL` (post-1999 BPMI), `NTC_HPA_4903B_ANNUAL_LEGACY` (pre-July 29, 1999), MN and CA variants with font/size rules enforced in the template CSS and validated by the required-content checklist; plain-language review by compliance; partner sign-off on the servicer contact block (partner name where required by state law, Supermortgage's toll-free number and address).
- Section 3.3 annual escrow statement generator able to append a PMI page (composition contract `attachments[]`), and the 1098 job (Section 2/16 tax reporting) able to carry the disclosure for non-escrowed loans.
- E-SIGN consent records (`consents.kind='esign'`, class `annual_disclosures`) captured at boarding or in the portal; print/mail vendor return-mail handling (Section 4).
- Boarding field `pmi_last_annual_disclosure_on` (nullable) and `pmi_initial_disclosure_document_id` (origination notice/schedule image) in the transfer tape (Section 1.1).

### Build spec
#### Inputs and triggers
- Recurring timer `HPA_4903A3_ANNUAL_DISCLOSURE_12M` per active BPMI policy; anchor = the later of the last disclosure sent (transferor's date if boarded) or boarding date; due ≤ 365 days later; the platform schedules the send to ride the loan's annual escrow statement (3.3) when that statement falls within the window, otherwise standalone.
- `loan.boarded` with MI and unknown last-disclosure date → `SM_MI_FIRST_DISCLOSURE_POST_BOARDING_60`.
- `escrow.statement.scheduled` (Section 3.3) → composition hook to attach the PMI page when `next_annual_disclosure_due` is within 120 days.
- `mi.terminated`/`mi.cancelled`/`mi.rescinded` → cancel the recurring timer.
- `loan.occupancy_changed`, `loan_terms.rate_changed`, `mi.schedule.updated` → refresh the projected dates shown on the next disclosure (no resend).

#### Data model
`mi_disclosures` (append-only): `id`, `loan_id`, `mi_policy_id`, `kind` ∈ {annual_a3, annual_b_legacy, mn_47_207, ca_2954_6, lpmi_options, initial_origination_copy}, `period_start`, `period_end`, `due_on`, `notice_id`, `channel`, `included_with` ∈ {escrow_statement, form_1098, standalone}, `projected_80_date`, `projected_78_date`, `projected_midpoint_date`, `schedule_version_id`, `sent_at`, `delivery_evidence_document_id`. `mi_policies.last_annual_disclosure_on`, `next_annual_disclosure_due` (10.1 model). `notice_templates` entries with `required_content_checklist` items: rights statement (cancellation at 80% original value on written request with conditions; automatic termination at 78% scheduled if current; final termination at midpoint; Fannie Mae current-value path availability and fees; evidence types), address, telephone number, MN 12-point/CA 10-point bold flags, LPMI exclusion.

#### State machine
Per disclosure cycle: `scheduled` → `composed` (attached to the escrow statement or standalone) → `sent` (delivery evidence) → `closed`; `returned_undeliverable` → address-research subflow (Section 4) → `resent`; `cancelled` when MI ends before the due date. Cycle re-arms on `sent`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `HPA_4903A3_ANNUAL_DISCLOSURE_12M` | recurring deadline | `mi_policy.activated` / `mi.disclosure.sent` | last sent date (or boarding date) | 12 `months` (365 calendar days max) | `notice.sent` (`NTC_HPA_4903A3_ANNUAL` or legacy/state variant) | `officer` sev-2; auto-send standalone; Sentinel report |
| `SM_MI_FIRST_DISCLOSURE_POST_BOARDING_60` | deadline (policy) | `loan.boarded` with MI and null last-sent date | boarded_at | 60 `calendar_days` | `notice.sent` | auto-send; warning |
| `SM_MI_DISCLOSURE_COMPOSE_LEAD_30` | deadline (policy) | recurring timer at 70% elapsed | — | 30 `calendar_days` before due | `mi.disclosure.composed` | queue |
| `MN_47_207_ANNUAL_NOTICE_12M` | jurisdiction override (MN) | same as HPA timer | same | 12 `months` | MN-variant notice sent | `officer` sev-2 |
| `CA_2954_6_NOTICE_WITH_STATEMENT` | jurisdiction override (CA) | `escrow.statement.sent` / annual statement sent | statement date | 0 | CA-variant PMI notice attached | block statement release without the attachment |
| `HPA_4905C2_LPMI_OPTIONS_NOTICE_30` | (10.2) | — | — | — | — | — |

Jurisdiction overrides: MN font/text; CA font/text and per-statement cadence; loans outside HPA scope (2–4 units, second homes, investment): the HPA timer is not instantiated, but a policy disclosure (`NTC_FNMA_MI_ANNUAL_INFO`, same content framed as Fannie Mae's program) is sent on the same cadence — open question 10.4-Q2 (default: send).

#### Business rules and calculations
- **R1 — Applicability.** `send_annual = premium_plan ∈ BPMI plans ∧ status='active'`; template = `annual_b_legacy` if `consummation_date < 1999-07-29`, else `annual_a3`; state variant by property state; LPMI: none (10.2 notice only); financed single-premium BPMI: included (it is borrower-paid MI).
- **R2 — Cadence.** `next_due = last_sent + 12 months` (never more than 365 days); preferred send window = the annual escrow statement date if it lies in `[next_due − 120 days, next_due]`, else the 1098 mailing (by Jan 31) if in window, else standalone on `next_due − 15 days`. Boarded loans with unknown last-sent date: send within 60 days of boarding, then annual.
- **R3 — Content computation.** Projected dates from the active schedule version: `projected_80_date` (initial schedule), `projected_78_date` (schedule then in effect), `projected_midpoint_date`; actual-payment status: current LTV on original value (basis points → percent with two decimals, truncation) and "you may be able to request cancellation now" flag when `actual_ltv_bps ≤ 8000` (or 7000); payment-history status is not printed (privacy/accuracy) — the letter states the conditions. Evidence types and fees (SMDU AVM free; BPO $190; appraisal $450/$750) are listed to satisfy 4902(a)(4)(A) "established in advance." Contact block: servicer name (partner d/b/a rules per state), mailing address, toll-free number, portal URL.
- **R4 — Channel.** Electronic only with a valid, unrevoked `esign` consent covering the class; otherwise first-class mail; when attached to the escrow statement, follow the statement's channel (Section 3.3 rules). Returned mail → address research; re-send within 15 days of a new address.
- **Worked example.** Loan boarded 2026-10-01; transferor reports the last annual disclosure sent 2026-03-15 → `next_due = 2027-03-15`. The loan's escrow computation year ends 2027-01-31 and the annual escrow statement is scheduled 2027-02-20 (within `[2026-11-15, 2027-03-15]`) → the PMI page is attached and sent 2027-02-20 → `last_sent = 2027-02-20`, `next_due = 2028-02-20`; the 2027 page shows projected 80% date 2034-08-01, 78% date 2035-07-01, midpoint termination 2039-05-01 and current LTV 91.35% (UPB $365,400.00 / $400,000). Had the escrow statement been scheduled 2027-04-05 (outside the window), a standalone disclosure would go 2027-02-28.

#### Integrations
`print-mail`/`e-delivery` vendors (composition payload: template code/version, merge fields, attachment flag, channel, consent ID); Section 3.3 statement composer; tax-reporting (1098) job; no Fannie Mae or insurer integration.

#### Outputs and artifacts
- `NTC_HPA_4903A3_ANNUAL` (12 U.S.C. 4903(a)(3); checklist: rights to cancellation and termination described accurately — 80% original value on written request subject to good payment history/current/holder evidence; 78% automatic if current; midpoint final termination; modification recalculation note; Fannie Mae current-value option and fees; address; telephone number; ARM caveat that scheduled dates may change; AVM disclaimer not needed unless a value is quoted).
- `NTC_HPA_4903B_ANNUAL_LEGACY` (4903(b)): "may, under certain circumstances, be canceled… with the consent of the mortgagee or in accordance with applicable State law" + contact block.
- `NTC_HPA_4903A3_ANNUAL_MN` (12-point; statutory sentence), `NTC_HPA_4903A3_ANNUAL_CA` (10-point bold; ratio, appraisal statement, procedure), `NTC_FNMA_MI_ANNUAL_INFO` (non-HPA loans).
- Records: `mi_disclosures`, `notices` with delivery evidence, `documents` (rendered PDF hash).

#### AI agent design (AI-first)
The `pmi` agent runs the composition queue: selects the carrier (escrow statement/1098/standalone), verifies merge data (projected dates against the current schedule version; contact block against the partner's state-specific naming rules in `jurisdiction_rules`), runs the required-content checklist, releases to the vendor, and reconciles delivery evidence. It answers borrower questions triggered by the disclosure through `borrower-comms` (script bound to the same rule set; may quote the borrower's current LTV and projected dates; must not solicit a current-value request). Tools: `notices.compose/send`, `pmi.projection`, `consents.check`, `documents.store`. Guardrails: no template edits at run time; a failed checklist blocks release; any loan lacking a schedule version or original value gets the disclosure with dates replaced by "contact us" text plus an internal exception (never skipped). Escalations: returned mail without a forwarding address after two attempts → `human_agent` skip-trace review (Section 4); template legal changes → `officer` approval. AI-off: the scheduler still composes and sends using the last approved template.

#### Edge cases and failure modes
- MI terminated between composition and send: suppress the PMI page (send the 4904(a) notice instead) — composition re-checks status at release.
- Successor in interest confirmed: send to the confirmed successor as well as the borrower of record (Reg X 1024.30(d) treatment; HPA "mortgagor").
- Bankruptcy: send with the informational disclaimer; no collection language.
- Deceased borrower/estate: send to the estate contact on file.
- Disaster forbearance: still send; note that disaster-related lates may be excluded (Fannie Mae).
- Transfer-out mid-cycle: the transferee inherits the due date; the transfer tape carries `last_annual_disclosure_on`.
- Loan with MI flag but no certificate (W-006): send the disclosure anyway (rights exist regardless of the certificate record), escalate the data gap.
- E-SIGN consent revoked after e-delivery scheduled → fall back to mail before the due date.
- Vendor outage on the due date → standalone mail via the secondary vendor within 5 days; timer breach recorded if past 365 days.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 10.4-T1 | Given the worked boarding (last sent 2026-03-15, escrow statement 2027-02-20), then the PMI page is attached to the 2027-02-20 statement, `mi_disclosures.included_with='escrow_statement'`, and `next_annual_disclosure_due=2028-02-20`. |
| 10.4-T2 | Given no disclosure sent by 2027-03-15 23:59, then `HPA_4903A3_ANNUAL_DISCLOSURE_12M` breaches, a standalone notice is auto-sent and an `officer` sev-2 escalation opens. |
| 10.4-T3 | Given a pre-1999 loan, then the legacy template is used and the checklist verifies the "with the consent of the mortgagee or in accordance with applicable State law" sentence. |
| 10.4-T4 | Given an LPMI loan, then no annual disclosure is scheduled and the `HPA_4905C2_LPMI_OPTIONS_NOTICE_30` timer exists instead. |
| 10.4-T5 | Given an MN property, then the rendered PDF's body font size is ≥ 12 pt (template metadata check) and contains the statutory sentence; given CA, the notice is attached to every §2954.2 statement in ≥ 10 pt bold. |
| 10.4-T6 | Given `esign` consent revoked on 2027-02-18, then the 2027-02-20 disclosure is mailed, not e-delivered. |
| 10.4-T7 | Given MI terminated 2027-02-19, then the PMI page is suppressed at release and the termination notice is sent within 30 days. |
| 10.4-T8 | Given a loan boarded 2026-10-01 with null last-sent date, then a standalone disclosure is sent by 2026-11-30. |
| 10.4-T9 | Given an ARM reset that moved the 78% date, then the next disclosure shows the new date and the prior disclosure record retains the old projection. |

#### Audit and evidence
`mi_disclosures` rows tied to `notices` (template version, rendered PDF hash, channel, consent ID, mail-piece ID/e-delivery receipt), timer history (due/sent/breach), composition checklists, and an annual coverage report (active BPMI loans vs disclosures sent in the trailing 365 days = 100%) for MORA/state exams and HPA 4907 defense.

### Open questions / decisions
1. **Carrier preference (10.4-Q1):** default — annual escrow statement when in window, else standalone; 1098 only for non-escrowed loans.
2. **Non-HPA loans (10.4-Q2):** default — send a Fannie Mae-program information notice on the same cadence (good-faith transparency; low cost).
3. **Printing projected dates (10.4-Q3):** default — print with an "estimate" caveat; ARM/modified loans flagged "subject to change."

### Sources
- 12 U.S.C. 4903, 4905, 4907: https://www.law.cornell.edu/uscode/text/12/4903 ; https://www.law.cornell.edu/uscode/text/12/4905 ; https://www.law.cornell.edu/uscode/text/12/4907 (verified 2026-09-09)
- Federal Reserve Consumer Compliance Handbook, HPA (Nov. 2007): https://www.federalreserve.gov/boarddocs/supmanual/cch/hpa.pdf
- CFPB Bulletin 2015-03: https://files.consumerfinance.gov/f/201508_cfpb_compliance-bulletin_private-mortgage-insurance-cancellation-and-termination.pdf
- Minn. Stat. §47.207: https://www.revisor.mn.gov/statutes/cite/47.207 ; Cal. Civ. Code §2954.6: https://california.public.law/codes/ca_civ_code_section_2954.6
- Section 3.3 (annual escrow statement) and Section 1.1 (boarding tape) of this specification.
