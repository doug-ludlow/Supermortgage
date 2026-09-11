# Per-process spec template (v1 — identical to the subservicing spec structure)

Every origination process (`ON.M`) is written with exactly these headings, in this order. Section files begin with a `## Section overview` (scope, agents involved, partner/SM boundary for the section, dependencies on other origination and servicing processes, and the changes in flight that shape the build), then one `## ON.M — Title` block per process, then `## Section-level test plan and sequencing`, `## Section open questions`, `## Section sources`.

```
## ON.M — <Process title>

### Blueprint row
| Field | Value |
|---|---|
| Area | <section area> |
| Trigger & frequency | <from inventory> |
| Governing source (blueprint) | <from inventory> |
| Key deadlines (blueprint) | <from inventory> |
| Data/artifacts | <from inventory or reconstructed> |
| Systems | <from inventory> |
| Automation class (blueprint) | (a) fully automatable / (b) AI with human approval / (c) human-required — with the AI-first re-classification |
| LoR / SM | who is legally responsible vs who performs |
| Nuances (blueprint) | the subtleties the row hides |

### Verified requirement (as of 2026-09-1x)
Quote or closely paraphrase the operative text of each primary source with its edition/"current as of" date; give the exact citation (section, paragraph, comment number; Selling Guide topic + last-updated date). Cover: what the rule requires, who it binds (creditor / lender / seller / servicer / servicer's agent), the counting rule (unit and anchor), content requirements, exceptions, and interactions with other rules. End with **Discrepancies vs blueprint** (numbered) — where the inventory row is wrong, incomplete, superseded, or mis-cited — and mark anything not confirmed **[UNVERIFIED]** or **[PARTIALLY VERIFIED — reason]**.

### Operational prerequisites
Bulleted: contracts, approvals, credentials, vendor setups, licenses, rule-set versions, with owner (Partner / SM / both) and lead time.

### Build spec
#### Inputs and triggers
Events, inbound files/APIs, schedules, borrower actions that start or feed the process.
#### Data model
New tables/columns (snake_case, types, enums, retention class, PII flags); baseline tables written; events emitted (domain.entity.action, past tense). Define a name once, here, if it is new.
#### State machine
States, transitions, who/what performs each transition, terminal states, guards.
#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
One row per obligation; kind ∈ {deadline, not_before_gate, recurring}; unit stated; jurisdiction overrides noted below the table. Reuse a code defined elsewhere by reference — never redefine.
#### Business rules and calculations
The rules as executable logic, with worked arithmetic on concrete dates and amounts (cents; rounding stated; calendars stated). Include at least two worked examples per process using the fixture calendar (application Mon Oct 5, 2026; closing Fri Nov 6, 2026; funding Thu Nov 12, 2026 for a refinance; Columbus Day Oct 12, Veterans Day Nov 11, Thanksgiving Nov 26, 2026).
#### Integrations
Per counterparty: interface type, direction, payload, idempotency, acks/rejects, retry/outage handling, portal-only fallbacks.
#### Outputs and artifacts
Records, documents (with retention class), notices (template codes and channels), ledger postings, investor/delivery data, reports.
#### AI agent design (AI-first)
Agent name and tools; end-to-end behavior; decision-record schema; guardrails (what the agent may never do alone); escalation conditions and roles; borrower-facing disclosure/consent rules; the human-path fallback.
#### Edge cases and failure modes
Bulleted; each with the required behavior.
#### Test cases and acceptance criteria
`ON.M-T1` … numbered Given/When/Then, at least 8 per process, each with concrete dates/amounts.
#### Audit and evidence
What the platform can produce for Fannie Mae QC/MORA, CFPB/state exams, litigation, and the partner.

### Open questions / decisions
Numbered; each with a recommended default so the build proceeds.

### Sources
One line per primary source: title/citation, edition or "current as of" date, URL, and the date verified.
```

## Depth calibration (from the subservicing spec, process 1.3 — excerpt)

The excerpt below shows the expected density: every deadline is quoted from the rule with its unit, every rule becomes executable logic with worked dates, every timer has a code, and the discrepancies with the inventory row are called out rather than silently corrected.

**Verified requirement.** §1024.33(b)(1) (eCFR current as of Sept. 3, 2026): each transferor and transferee servicer "shall provide to the borrower a notice of transfer" for "any assignment, sale, or transfer of the servicing of the mortgage loan." (b)(2) excludes, "if there is no change in the payee, address to which payment must be delivered, account number, or amount of payment due": (A) transfers between affiliates; (B) transfers resulting "from mergers or acquisitions of servicers or subservicers"; (C) transfers "between master servicers without changing the subservicer." A change of subservicer that changes the payee or payment address is therefore not excluded. (b)(3)(i): transferor notice "not less than 15 days before the effective date of the transfer"; transferee notice "not more than 15 days after the effective date"; a single combined notice satisfies both if provided "not less than 15 days before the effective date." … "Effective date of transfer" is defined by 12 U.S.C. 2605(i)(1): "the date on which the mortgage payment of a borrower is first due to the transferee servicer." … **Discrepancies vs blueprint**: (1) the "~5 yrs" retention is policy — Reg X §1024.38(c)(1) requires one year post-transfer; (2) the blueprint omits the 30-day exception and the (b)(2) exclusions; (3) the 60-day rule is "on or before the due date including grace," not "60-day late-fee grace."

**Timers and gates.** `REGX_1024_33B3_GOODBYE_15` | deadline | `transfer.batch.approved` | `respa_effective_date` | −15 calendar_days | `notice.mailed{template=NTC_REGX_1024_33B_GOODBYE_MS2 or COMBINED}` for every loan | sev 1 → `officer`. `REGX_1024_33C1_LATE_FEE_PROTECTION_60` | not_before_gate (window) | `transfer.batch.cutover_completed` | `respa_effective_date` | window days 1–60 | expires day 61 | `assessLateCharge` and `reportDelinquency` commands must check `misdirected_payments.protected`.

**Business rules.** Date arithmetic is calendar-day: `goodbye_due = respa_effective_date − 15 days`; `hello_due = respa_effective_date + 15 days`; `window_end = respa_effective_date + 59 days` (day 1 = effective date). Worked example: effective date Thu Oct. 1, 2026 → goodbye by Wed Sept. 16, 2026; hello by Fri Oct. 16, 2026; protection window Oct. 1–Nov. 29, 2026. Example 2: effective date Mon Nov. 2, 2026 → goodbye by Sun Oct. 18 — the run is scheduled for Fri Oct. 16 because the vendor's last collection is Friday. Protected-payment rule: `protected = transferor_received_at ≤ due_date + grace_days AND transferor_received_at ∈ [respa_effective_date, window_end]`; a protected payment posts with `effective_date = transferor_received_at`, no late charge, delinquency counters treat it as received that day. Worked example: due Oct. 1, grace 15 → last protected receipt Oct. 16; check received by transferor Oct. 14, by Supermortgage Oct. 20 → posted as of Oct. 14; received by the transferor Oct. 20 → not protected.

**AI agent design.** `transfer` agent (tools: `planNoticeRun`, `renderNotice`, `runContentChecklist`, `validateAddress`, `releaseToVendor`, `ingestMailReturns`, `orderSkipTrace`, `writeDecision`) prepares and releases both runs end-to-end, monitors proofs, and drives skip-trace. Decision record: `{run_id, loans, checklist_results, release_decision, rationale}`. Escalations: `officer` (partner) for goodbye-run authorization and any corrective notice; `human_agent` on request. Human path: ops-console shows the same run with manual release.

**Test cases.** 1.3-T1 Given effective date Oct. 1, 2026 and combined mode, when the run is mailed Sept. 16, 2026, then `REGX_1024_33B3_COMBINED_15` is satisfied; mailed Sept. 17 → breached. 1.3-T5 Given a payment due Oct. 1 with 15-day grace received by the transferor Oct. 14 and by Supermortgage Oct. 20, then it posts as of Oct. 14 with no late charge and no delinquency day count. 1.3-T9 Given an ACP-enrolled borrower, then the notice is addressed to the ACP substitute address only.

## Writing rules
1. Research first: fetch the primary source (eCFR section, Official Interpretations, Selling Guide topic, Fannie Mae user guide/announcement, statute, MERS procedures) before writing the requirement; quote the operative words; record the edition/"current as of" date and the verification date.
2. Never assert a number you did not read; if a source is login-gated or unreachable, say so and mark **[UNVERIFIED]**.
3. Business days: name the unit every time (`business_days_creditor`, `business_days_regz_specific`, `business_days_federal`, `business_days_servicer`, `business_days_fannie_et`, `calendar_days`).
4. Money in cents; rates with stated precision; rounding stated at the step the rule specifies.
5. Names: tables/columns snake_case; events `domain.entity.action` past tense; timer codes `SOURCE_SECTION_SUBJECT_DAYS`; notice codes `NTC_` + citation + subject; process IDs `ON.M`; test IDs `ON.M-Tk`. Reuse names from the architecture baseline and its origination addendum; define a new name once in the Data model subsection of the process that owns it; reference (never redefine) names owned elsewhere.
6. AI-first: the agent does the work; humans appear only at the enumerated touchpoints (addendum §8); every human touchpoint is an `escalation` with an SLA timer.
7. Each process: ≥ 2 worked examples with real 2026 dates, ≥ 8 test cases, ≥ 5 sources, ≥ 3 open questions with defaults.
8. Keep the partner/SM boundary explicit in every process (who is legally bound; who performs; whose credentials; whose signature).
