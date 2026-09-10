# 9.8 — Property inspection (delinquent)

| Attribute | Value |
|---|---|
| Section | 9 — Insurance & Property Protection |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | 90+ days delinquent |
| Governing source | FNMA D2-2-10 |
| Key deadlines | Order on/after 90th day, complete by 120th; continue monthly while 90+ delinquent |
| Timers | `FNMA_D2210_INSPECT_COMPLETE_DAY120`, `FNMA_D2210_INSPECT_ORDER_DAY90`, `FNMA_D2210_INSPECT_RECUR_20_35`, `FNMA_D2210_VACANCY_INSPECT_ASAP_3BD`, `FNMA_D2210_VACANT_INTERIOR_MONTHLY_35`, `FNMA_E3303_PRESALE_INSPECT_35`, `FNMA_F105_INSPECTION_CLAIM_60`, `FNMA_P360_PFPIP_RECONCILE_MONTHLY`, `FNMA_P360_PFPIP_STATUS_SYNC_2BD`, `FNMA_P360_PFPIP_SUBMIT_DAY90`, `FNMA_P360_PFPIP_SUBMIT_EXCEPTION_DAY45` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Property |
| Trigger & frequency | 90+ days delinquent |
| Governing source (blueprint) | FNMA D2-2-10 |
| Key deadlines (blueprint) | Order on/after 90th day, complete by 120th; continue monthly while 90+ delinquent |
| Data/artifacts | Inspection report |
| Systems | Property 360, preservation vendor |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Sub schedules/orders (or submits to Fannie Mae's PFPIP under the partner's servicer number); partner liable |
| Nuances (blueprint) | [cropped in source] — reconstructed: 20–35-day cadence; occupancy-based exceptions (QRPC/full payment within 30 days, performing workout/bankruptcy plan); interior for vacant/abandoned, curbside only under legal constraint/danger; 35-day pre-sale inspection; Form 30; signed vacancy certification; PFPIP submission at 90 days (45 for exceptions) with monthly reconciliation; F-1-05 caps; disaster inspections |

### Verified requirement (as of 2026-09-09)

**Servicing Guide D2-2-10, Requirements for Performing Property Inspections (05/10/2023)** (https://servicing-guide.fanniemae.com/svc/d2-2-10/requirements-performing-property-inspections, verified 2026-09-09): the servicer "must order a property inspection on or after the 90th day of delinquency and complete the initial inspection no later than the 120th day of delinquency," then continue inspections "as long as the mortgage loan remains 90 or more days delinquent" until foreclosure sale, Mortgage Release execution or reinstatement. **Exception** — no monthly inspection is required while the loan is ≥ 90 days delinquent if the property is borrower- or tenant-occupied **and** one of: "QRPC has been established within the last 30 days"; "a full payment has been received within the last 30 days"; "a workout option has been approved and the borrower is performing under the plan"; or "the borrower is performing under the applicable bankruptcy plan." When required, inspections "must occur between 20 and 35 days apart" (more often if local ordinance or condition warrants); efforts and reasons for delays documented in the file. Use **Form 30 (Property Inspection Report)** or an equivalent. **Pre-sale**: a final inspection "within 35 days prior to the foreclosure sale date" or before the estimated court-order docket date where title passes by court order (E-3.3-03, 04/10/2019, same rule). **Type by occupancy**: vacant or abandoned → **interior** inspection "as allowed by applicable law"; unknown or occupied → **exterior**; a **curbside** (drive-by) counts as exterior only under legal constraints (e.g., active bankruptcy, applicable law) or if the inspector faces potential danger. Occupancy checklists/documentation must be available to Fannie Mae, which may prescribe forms or affidavits. **Disrepair**: remind the borrower of the maintenance obligation; follow the borrower-response table (repairs/reimbursement/legal action via **Form 20**); delinquent + vacant → vacant-property rules. **Vacant/abandoned**: inspect "as soon as possible" after learning of possible vacancy; on confirmation, immediately protect the property from vandalism and the elements as local law allows, attempt to locate the borrower, contact other lienholders, and **notify the property insurance carrier** of the vacancy; delinquent vacant loans get **monthly interior inspections regardless of QRPC**; the first vacancy determination needs a **signed inspection report** certifying personal observation (e-signature allowed), later confirmations need only checklist notes, and a re-vacated property needs a new signed report; confirmed abandonment → monthly interior inspections until sale/court order. **A4-2.1-02 (11/12/2014)**: inspection vendors chosen on cost-effectiveness/efficiency with no arrangement giving the servicer a benefit not passed to Fannie Mae. **D1-3-01 (04/08/2026)**: disaster inspections (Form 30; interior/exterior at servicer discretion; optional for loans current before and after; aerial/predictive tools allowed; reimbursable). **F-1-05 (06/11/2025)**: reimbursement of "all interior and exterior preforeclosure property inspections on delinquent mortgage loans" at the Defined Expense Reimbursement Limits — **interior $45, exterior $30, insured-loss repair $60 per inspection [as extracted today; confirm]** — plus disaster inspections on current and delinquent loans (claims within one year for current loans; delinquent-loan claims per E-5-01/15.2); invoices retained and produced on request.

**Property 360 Pre-Foreclosure Property Inspection & Preservation Program (PFPIP)** (job aid, June 2023; Property 360 page; API fact sheet 2021 — verified 2026-09-09 at https://singlefamily.fanniemae.com/media/36386/display, https://singlefamily.fanniemae.com/applications-technology/property-360, https://singlefamily.fanniemae.com/media/16356/display): servicers submit loans "at 90 days delinquent (calculated from first missed payment date)," or as early as **45 days** for exceptions such as vacancy; Fannie Mae "will wait to order the inspection closer to 120 days delinquent" and only if necessary (using other occupancy data); Fannie Mae's vendors run curbside (code 1) or exterior/occupancy (code 2) inspections and, when vacant and the servicer allowed "Do insp and preserv," secure and preserve with a 24/7 line; ineligible loan types: Lender-Risk, HECM, government, USDA/RD; submission data: program, property, loan, foreclosure (referral date, attorney), litigation/bankruptcy/loss-mit status with allowed interactions ("Do insp and preserv" / "Do exterior inspection and no preserv" / "Do curbside inspection and no preserv" / "No inspection and no preserv"), borrower occupancy status (default Unknown) and QRPC, hazard-claim information, HOA information, vacancy-posting contact preference (Servicer only / Fannie Mae's vendor only / Both — recommended), "Stop All Work"; **monthly reconciliation**; "Any changes made in Investor Reporting also need to be updated in the Pre-Foreclosure Program via Property 360"; loans set to "Liquidated-REO" leave the program; program expenses are **not borrower-recoverable** and are included by Fannie Mae in MICP-filed MI claims (servicer includes them only for non-MICP MI claims). The page states the program "eliminates inspection and preservation expenditures for servicers." Interfaces: UI roles `PREFCL_LOAN_SUBMISSION_USER` / `PREFCL_LOAN_PRSVN_REQUEST_USER`; **Property Preservation Initiation API**, **Loan Number List API** and **Loan Search API** for servicers ("Fannie Mae's TSPs are not using these APIs at this time" — 00b F5). **Consolidated Technology Guide**: no UI automation (00a §4.2).

**Other law**: entry onto occupied-looking property is trespass risk — interior inspections only when vacancy is confirmed and "as allowed by applicable law"; the bankruptcy automatic stay (11 U.S.C. 362) limits contact/entry — curbside exception; FDCPA/Reg F apply to inspector "door-knock" contacts only if they communicate about the debt (inspectors must not); state "zombie property" statutes (e.g., N.Y. RPAPL §1308: exterior inspection within 90 days of delinquency and every 25–35 days, secure/maintain vacant and abandoned property, DFS registry within 21 business days **[PARTIALLY VERIFIED — from general knowledge]**) — `jurisdiction_rules`.

**Discrepancies vs blueprint**: (1) "monthly" is really 20–35 days with four occupancy-based exceptions; (2) the row omits the pre-sale 35-day inspection, vacancy certification, carrier notification and the interior/exterior/curbside rules; (3) PFPIP changes the economics — for enrolled loans Fannie Mae orders and pays, and Supermortgage's job becomes timely submission and reconciliation — but D2-2-10 has not been amended to say program participation discharges the servicer's own inspection duty **[UNVERIFIED — confirm with the PFPIP team/FAQ]**; (4) automation class "a" holds only where the servicer-direct APIs are available to Supermortgage — otherwise P360 submissions are `human_portal_task` steps.

### Operational prerequisites
- PFPIP enrollment under the partner's servicer number (program team e-mail; TM roles for Supermortgage employees as authorized users; Form 101/TM authorization) — Partner + Supermortgage; 4–8 weeks. Decision whether Supermortgage can obtain the Property Preservation APIs as acting servicer (open question 9.8-Q1); otherwise UI per loan.
- Inspection vendor(s) for non-program loans, pre-sale, vacancy-confirmation, disaster and insured-loss inspections (A4-2.1-02 due diligence; Form 30-equivalent report; GPS/time-stamped photos; e-signed vacancy certification) — Supermortgage; 4–6 weeks.
- `jurisdiction_rules` for state inspection/registration statutes (NY RPAPL 1308 etc.) **[UNVERIFIED list]** — legal task.
- Delinquency counters (`fnma_days_delinquent`, `regx_days_delinquent`), QRPC/`contacts.qrpc`, workout and bankruptcy performance flags (11.x/12.x/14.x) available daily.
- Section 15.2 expense-claim pipeline for reimbursable inspections (Property 360 bulk upload; 60-day filing).

### Build spec
#### Inputs and triggers
- Daily `inspection_sweep`: for each loan compute `fnma_days_delinquent`, occupancy status, exception flags, program enrollment; create/advance `property_inspections` and `p360_pfpip_submissions`.
- Events: `delinquency.day90.reached`, `delinquency.day45.reached` with vacancy indicators, `contact.qrpc.established`, `payment.full.received`, `lossmit.plan.performing/broken`, `bankruptcy.plan.performing/dismissed`, `foreclosure.sale.scheduled` (date), `foreclosure.referral.sent`, `property.vacancy_suspected` (returned mail, utility shut-off notice, neighbor call, code notice, inspection result), `disaster.event.declared`, `insurance.claim.opened`, `loan.reinstated`, `reo.acquired`, `mortgage_release.executed`.
- Inbound: vendor inspection results (Form 30 data + photos); Fannie Mae program data (Loan Search API/reports: inspection status codes 8 = completed, type 1/2, occupancy 0/1/2).

#### Data model
- `property_inspections` (new): `id`, `loan_id`, `property_id`, `kind` ∈ {delinquency_exterior, delinquency_interior, curbside, vacancy_confirmation, occupancy_check, pre_sale_35, disaster, insured_loss_repair, disrepair, code_violation, other}, `ordered_by` ∈ {servicer, fnma_program}, `ordered_at`, `due_by`, `completed_at`, `vendor_party_id`, `inspector_ref`, `report_document_id` (Form 30 equivalent), `occupancy_result` ∈ {occupied_borrower, occupied_tenant, occupied_unknown, vacant, abandoned, unknown}, `signed_vacancy_cert bool`, `condition jsonb` (damage flags, code issues, utilities, securing needs), `photos document_id[]`, `legal_constraint_reason` (for curbside), `cost_cents`, `reimbursable bool`, `expense_claim_id?`.
- `inspection_schedules` (new): `loan_id`, `mode` ∈ {servicer, pfpip, suspended}, `next_due`, `last_completed_at`, `interval_min_days=20`, `interval_max_days=35`, `exception_reason?`, `interior_required bool`.
- `p360_pfpip_submissions` (new): `id`, `loan_id`, `fnma_loan_no`, `submitted_at`, `method` ∈ {api, human_portal_task}, `payload jsonb` (program/property/loan/foreclosure/litigation/BK/loss-mit permissions/occupancy/QRPC/hazard claim/HOA/posting preference/stop_all_work), `fnma_status`, `last_reconciled_at`, `last_fnma_activity jsonb`, `removed_at`, `removal_reason` ∈ {reinstated, liquidated_reo, paid_off, transferred, ineligible}.
- Baseline: `contacts` (qrpc), `cases` (foreclosure/bankruptcy/lossmit), `properties.occupancy_status`, `escalations` (`human_portal_task`).

#### State machine
Schedule: `not_required` (< 90 days or exception active) → `initial_due` (day 90 reached; order allowed) → `initial_ordered` → `initial_completed` (by day 120) → `recurring` (next due 20–35 days) → `suspended_exception` (occupied + QRPC/full payment/performing plan) → `recurring` (exception lapses) → `closed` (sale/Mortgage Release/reinstated/paid off/REO). Occupancy: `unknown` → `occupied` | `vacant` (signed certification) → `abandoned` (confirmed) → 9.9. PFPIP: `eligible` → `submitted` (day 90, or day 45 with exception) → `active` (monthly reconciliation) → `removed`. Pre-sale: `sale_scheduled` → `presale_ordered` (sale − 35 … sale − 7) → `presale_completed` → bidding instructions (13.x).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_D2210_INSPECT_ORDER_DAY90` | not_before_gate | `delinquency.day90.reached` | earliest unpaid due date | +90 calendar_days | order allowed | order refused before (unless vacancy suspected — vacancy inspections have no day-90 floor) |
| `FNMA_D2210_INSPECT_COMPLETE_DAY120` | deadline | `delinquency.day90.reached` | earliest unpaid due date | +120 calendar_days | `property.inspection.completed` (initial) or PFPIP inspection completed **[see 9.8-Q2]** | sev-1; expedite order; reason documented |
| `FNMA_D2210_INSPECT_RECUR_20_35` | recurring | `property.inspection.completed` | completed_at | next between +20 and +35 calendar_days | next completion | sev-2 at day 36 |
| `FNMA_D2210_VACANT_INTERIOR_MONTHLY_35` | recurring | `property.vacancy_confirmed` (delinquent) | last interior | +35 calendar_days max | interior inspection | sev-2 |
| `FNMA_D2210_VACANCY_INSPECT_ASAP_3BD` | deadline (policy on "as soon as possible") | `property.vacancy_suspected` | suspicion | 3 business_days_servicer | vacancy-confirmation inspection completed | sev-2 |
| `FNMA_E3303_PRESALE_INSPECT_35` | deadline window | `foreclosure.sale.scheduled` | sale date | between −35 and −1 calendar_days (target −14) | `property.inspection.completed` kind pre_sale_35 | sev-1 (bid instructions blocked — 13.x) |
| `FNMA_P360_PFPIP_SUBMIT_DAY90` | deadline | `delinquency.day90.reached` (eligible loan) | earliest unpaid due date | +90 calendar_days (SLA: within 2 business_days_servicer after) | `p360.pfpip.submitted` | sev-2; `human_portal_task` escalation |
| `FNMA_P360_PFPIP_SUBMIT_EXCEPTION_DAY45` | deadline | vacancy/exception at ≥ 45 days | — | +45 calendar_days | submitted | sev-2 |
| `FNMA_P360_PFPIP_RECONCILE_MONTHLY` | recurring | `p360.pfpip.submitted` | last reconciliation | 1 month (BD5 target) | `p360.pfpip.reconciled` | sev-2 |
| `FNMA_P360_PFPIP_STATUS_SYNC_2BD` | deadline | delinquency/foreclosure/BK/loss-mit/occupancy/claim/HOA change reported to Fannie Mae elsewhere | change date | 2 business_days_servicer | program record updated | sev-3 |
| `FNMA_F105_INSPECTION_CLAIM_60` | deadline (15.2) | milestone (reinstatement/workout/liquidation) | milestone | 60 calendar_days | claim filed | sev-2 (cost forfeited) |
| Jurisdiction overrides | | NY RPAPL 1308 (90-day exterior inspection, 25–35-day cadence, registry 21 BD) and similar **[UNVERIFIED]** | | | | |

#### Business rules and calculations
1. **Delinquency day count**: `fnma_days_delinquent = today − earliest_unpaid_due_date` (day 1 = due date + 1; consistent with the PFPIP "from first missed payment date"); example: due date 2026-11-01 unpaid → day 90 = **2027-01-30** (order allowed), day 120 = **2027-03-01** (complete by), day 45 = 2026-12-16 (vacancy exception submission). Reg X's `regx_days_delinquent` is not used here.
2. **Mode**: eligible conventional first liens (not Lender-Risk/recourse) → `pfpip` when enrolled; recourse loans and any loan Fannie Mae rejects → `servicer`. In `pfpip` mode the platform still tracks D2-2-10 dates against Fannie Mae's inspection data (Loan Search API/reports) and orders its own inspection only if Fannie Mae's data shows none by day 110 **(default; 9.8-Q2)**.
3. **Exception engine**: `suspend = occupied AND (qrpc_within_30d OR full_payment_within_30d OR performing_workout OR performing_bk_plan)`; re-evaluated daily; vacancy overrides all exceptions (interior monthly).
4. **Type**: vacant/abandoned → interior (if law allows — `jurisdiction_rules.interior_entry_allowed_prefc`); otherwise exterior; curbside only with a recorded legal-constraint/danger reason.
5. **Occupancy determination**: multiple indicators (utilities, mail, furnishings, neighbor statements, posting response) + photos; first vacancy requires the inspector's signed certification; `properties.occupancy_status` updated; carrier notified of vacancy (9.1 rule 6 coverage review); lienholders contacted; borrower-locate attempts (skip tracing via `borrower-comms`).
6. **Pre-sale**: order at sale − 21, complete by sale − 7 (window sale − 35 … sale − 1); results feed bid instructions and any Form 176 (9.7).
7. **Reimbursement**: servicer-ordered inspections on delinquent loans claimed at ≤ $30/$45/$60 caps via 15.2 within 60 days of the milestone; program inspections are not claimed (Fannie Mae pays); disaster inspections on current loans within one year.
8. **PFPIP payload assembly** from platform data (13.x referral date/attorney; 14.x BK; 12.x loss-mit; litigation flags; occupancy; QRPC date; hazard claim id/status (9.7); HOA name/contact/dues status (13.x/3.x); posting preference "Both"; stop-all-work only on documented reason). Monthly reconciliation compares Fannie Mae's Loan Status Portfolio report with platform state; deltas become updates.

#### Integrations
- **`fnma-p360` adapter**: Property Preservation Initiation API (submit/update), Loan Number List API (activity by date range), Loan Search API (real-time inspection/expense/preservation data) — OAuth ROPC per baseline §0, System ID under Supermortgage's identity with the partner's servicer number (Form 101) **[eligibility UNVERIFIED — 9.8-Q1]**; fallback `human_portal_task` with a per-loan package (all payload fields, screenshots to capture, SLA 2 business days) and the ZIP report downloads for reconciliation; no browser automation.
- **Inspection vendors** (`preservation` adapter): work orders (kind, due date, access instructions, occupancy questions), results (Form 30 data, photos, GPS, e-signed vacancy certification), invoices; idempotent by order id; SLA 10 calendar days for exterior, 5 for vacancy checks (policy); outage → secondary vendor.
- **Sections 11/12/13/14** for state inputs; **15.2** for expense claims (bulk upload); **9.9** for preservation hand-off; **9.7** for damage findings.

#### Outputs and artifacts
- Notices: `PROP_DISREPAIR_REMINDER` (D2-2-10 maintenance-obligation reminder; mail/e-delivery), `PROP_VACANCY_POSTING` (physical posting text supplied to the vendor — Matrix best practice; contact info, securing date ≤ 14 days), `PROP_INSPECTION_FEE_DISCLOSURE` (policy: inspection fees are not charged to the borrower on program loans; on servicer-ordered inspections the fee appears on the statement only if the contract allows and state law permits **[jurisdiction rule]**).
- Records: `property_inspections`, `inspection_schedules`, `p360_pfpip_submissions`; events `property.inspection.ordered/completed/failed`, `property.occupancy.updated`, `property.vacancy_confirmed`, `property.abandonment_confirmed`, `p360.pfpip.submitted/updated/reconciled/removed`, `property.disrepair.detected`; ledger: inspection costs to `corporate_advances` (loan) when borrower-recoverable per contract, else corporate expense; 15.2 claims.

#### AI agent design (AI-first)
- `insurance-property` agent with `default-collections` inputs: `computeInspectionSchedule`, `orderInspection`, `evaluateInspectionResult` (vision over photos + checklist → occupancy/condition classification with confidence), `updateOccupancy`, `notifyCarrierVacancy`, `submitPfpip`/`updatePfpip`/`reconcilePfpip`, `openPreservation` (9.9), `openClaim` (9.7), `sendNotice`, `escalate`. Decision record: {loan, day count, exception evaluation inputs, mode, order/result, occupancy reasoning, photo hashes, program payload}.
- Guardrails: no interior inspection without confirmed vacancy and a permitted-entry jurisdiction rule; no order before day 90 except vacancy checks; curbside only with a recorded reason; the agent cannot mark occupancy `vacant` without a signed certification; inspectors never discuss the debt. Escalations: `fnma_portal_operator` (P360 UI submissions/reconciliation when no API), `attorney` (entry during bankruptcy, occupant disputes, Form 20 litigation), `human_agent` on request.
- AI-off: deterministic scheduler and vendor orders; staff classify results.

#### Edge cases and failure modes
- Loan boards at day 95 delinquent (1.1): order immediately; document the transferor's inspections; PFPIP submit at boarding.
- QRPC established on day 118 with occupied property: initial inspection still required by day 120 (the exception applies to *monthly* inspections after the initial) — policy reading; record.
- Bankruptcy filed: curbside allowed; PFPIP permissions set to "curbside/no preserv" unless counsel approves more; stay lifted → resume.
- Foreclosure sale postponed: re-open the pre-sale window against the new date.
- Disaster: inspections may be required on current loans if delinquent later; claims flow to 9.7; reimbursable.
- Vendor no-access/danger: curbside with reason; retry cadence.
- PFPIP vendor and servicer vendor both inspect: avoid duplicates via Loan Search data; duplicates are not claimed.
- Reinstatement: schedule closed; PFPIP status "Current" with updated LPI date; claim inspection costs within 60 days.
- Transfer-out: PFPIP removal/transfer per program rules; inspection history in the transfer file.
- Successor/tenant occupancy: tenant-occupied counts as occupied; protecting-tenants (PTFA) considerations belong to 13.x/15.x.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 9.8-T1 | Given due date 2026-11-01 unpaid When 2027-01-29 Then order refused; 2027-01-30 allowed; completion deadline 2027-03-01. |
| 9.8-T2 | Given an occupied property with QRPC on 2027-02-10 When the recurring sweep runs on 2027-03-05 Then no inspection due (exception); QRPC ages past 30 days on 2027-03-13 → next inspection due within 20–35 days of the last. |
| 9.8-T3 | Given an inspection reports vacancy with a signed certification Then occupancy `vacant`, interior monthly schedule, carrier notified, 9.9 opened, PFPIP occupancy updated within 2 business days. |
| 9.8-T4 | Given a foreclosure sale on 2027-06-15 Then pre-sale inspection ordered by 2027-05-25 and completed within 2027-05-11 … 2027-06-14. |
| 9.8-T5 | Given an eligible loan reaching day 90 on a Saturday Then PFPIP submission task due within 2 business days; package contains all mandatory fields. |
| 9.8-T6 | Given a Lender-Risk (recourse) loan Then mode `servicer`, inspections ordered and claimed at caps. |
| 9.8-T7 | Given active bankruptcy Then curbside inspections with reason recorded; PFPIP permission "Do curbside inspection and no preserv." |
| 9.8-T8 | Given Fannie Mae's Loan Search shows no inspection by day 110 on a PFPIP loan Then a servicer-ordered inspection is placed (9.8-Q2 default). |
| 9.8-T9 | Given inspection costs on a reinstated loan Then a 15.2 claim within 60 days of reinstatement at ≤ caps. |

#### Audit and evidence
Schedule computations (daily snapshots), exception evaluations with source events, orders/results/photos (hashed), signed vacancy certifications, occupancy decision records, PFPIP submissions/reconciliations and Fannie Mae reports, vendor invoices, claims; retention `life_of_loan_plus_4y`; MORA/STAR evidence.

### Open questions / decisions
1. Can Supermortgage (acting servicer) use the Property Preservation APIs under the partner's servicer number? — **default: assume UI-only until the P360 team confirms**, design the adapter so the API path is a configuration change.
2. Does PFPIP participation satisfy D2-2-10 on its own? — **default: track D2-2-10 dates; order a servicer inspection at day 110 if Fannie Mae data shows none**; confirm with the program team (cost double-up risk is small: $30).
3. Whether to charge borrowers for servicer-ordered inspections — **default: no** (program loans are non-recoverable; consistency and UDAAP simplicity).
4. Pre-sale inspection targeting (−21/−7) — **default as stated**.

### Sources
- Servicing Guide D2-2-10 (05/10/2023): https://servicing-guide.fanniemae.com/svc/d2-2-10/requirements-performing-property-inspections — verified 2026-09-09
- Servicing Guide E-3.3-03 (04/10/2019): https://servicing-guide.fanniemae.com/svc/e-3.3-03/inspecting-properties-prior-foreclosure-sale — verified 2026-09-09
- Servicing Guide A4-2.1-02 (11/12/2014): https://servicing-guide.fanniemae.com/svc/a4-2.1-02/property-inspection-vendor-management-and-oversight — verified 2026-09-09
- Servicing Guide D1-3-01 (04/08/2026) and F-1-05 (06/11/2025) — URLs in 9.7 — verified 2026-09-09
- PFPIP job aid (June 2023): https://singlefamily.fanniemae.com/media/36386/display ; Property 360 page: https://singlefamily.fanniemae.com/applications-technology/property-360 ; Pre-Foreclosure Property Inspections and Preservation APIs: https://singlefamily.fanniemae.com/media/16356/display — verified 2026-09-09
- research/00b-integration-landscape.md F5/N13 — 2026-09-09
