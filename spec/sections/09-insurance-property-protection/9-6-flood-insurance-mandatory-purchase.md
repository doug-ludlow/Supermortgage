# 9.6 — Flood insurance / mandatory purchase

| Attribute | Value |
|---|---|
| Section | 9 — Insurance & Property Protection |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | On flood-zone determination |
| Governing source | Flood Disaster Protection Act; FEMA NFHL |
| Key deadlines | 45-day force-place notice |
| Timers | `FDPA_4012A_E2_FLOOD_PLACE_AFTER_45`, `FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30`, `FDPA_4012A_E_FLOOD_FPI_NOTICE_45`, `FLOOD_EVIDENCE_EVAL_2BD`, `FLOOD_LOL_HEARTBEAT_35`, `FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD`, `FNMA_B301_FLOOD_REMAP_COVERAGE_120`, `INS_FLOOD_NOTICE_SLA_3BD`, `NFIP_44CFR6111_MAP_REVISION_1DAY_13M` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Insurance |
| Trigger & frequency | On flood-zone determination |
| Governing source (blueprint) | Flood Disaster Protection Act; FEMA NFHL |
| Key deadlines (blueprint) | 45-day force-place notice |
| Data/artifacts | Flood determination |
| Systems | Flood vendor, FEMA NFHL |
| Automation class (blueprint) | b |
| SoR / Sub | [cropped in source] — reconstructed: Sub tracks, notices, places; partner is mortgagee/named insured; Fannie Mae imposes the FDPA regime contractually |
| Nuances (blueprint) | [cropped in source] — reconstructed: life-of-loan determination monitoring and map changes (Fannie Mae 120-day coverage rule); coverage = lesser of 100% RCV, NFIP max, UPB; NFIP vs private flood acceptance (Biggert-Waters (b)(7) + compliance aid); RCBAP 80% rule; 30-day termination/refund; NFIP 30-day wait with map-revision exception; NFIP lapses/shutdowns (LL-2026-02); escrow of premiums; flood excluded from Reg X 1024.37 |

### Verified requirement (as of 2026-09-09)

**Statute — 42 U.S.C. 4012a** (verified 2026-09-09 at https://www.law.cornell.edu/uscode/text/42/4012a): (b)(1) regulated lending institutions may not make/increase/extend/renew a loan secured by improved real estate in an SFHA where flood insurance is available unless the building is covered "for the term of the loan" in an amount at least equal to the lesser of the outstanding principal balance or the maximum available under the Act, and must accept qualifying private flood insurance; **(b)(3)** Fannie Mae and Freddie Mac "shall implement procedures reasonably designed to ensure" the loans they purchase are so covered (the hook for the Servicing Guide); **(b)(7)** "private flood insurance" — issued by a licensed/approved insurer, coverage "at least as broad as" the SFIP including deductibles, exclusions and conditions, **45 days' written notice** of cancellation/non-renewal to the insured and the lender/servicer, a mortgage-interest clause, legal recourse within one year of claim denial, and SFIP-equivalent cancellation provisions; **(d)** escrow of flood premiums for residential loans by regulated lenders (exceptions: < $1B lenders not escrowing on July 6, 2012; junior liens with senior coverage; association policies; business-purpose; HELOCs; nonperforming; ≤ 12-month terms); **(e)(1)–(2)**: "if … the lender or servicer for the loan determines" the building is not covered or is under-covered, the lender or servicer "shall notify the borrower" to obtain coverage; if the borrower fails to purchase within **45 days** after notification, "the lender or servicer for the loan shall purchase the insurance on behalf of the borrower and may charge the borrower for the cost of premiums and fees incurred … including premiums or fees incurred for coverage beginning on the date on which flood insurance coverage lapsed or did not provide a sufficient coverage amount"; **(e)(3)**: within **30 days** of receipt of confirmation of the borrower's existing coverage, terminate the force-placed policy and "refund to the borrower all premiums paid" for the overlap "and any related fees"; **(e)(4)**: a declarations page with policy number and insurer contact information must be accepted as confirmation; **(f)**: civil money penalties (regulated lenders; $2,000 per violation as adjusted) — a nonbank subservicer is not a "regulated lending institution," but (e) is addressed to "the lender or servicer" and Fannie Mae's Guide imposes the FDPA regime contractually.

**Interagency rule (OCC 12 CFR Part 22, current as of Sept. 4, 2026; FRB 208, FDIC 339, FCA 614, NCUA 760 parallel)** — used as the design standard: §22.2 definitions (designated loan; SFHA "one percent" annual-chance area; private flood insurance); §22.3 amount = lesser of outstanding principal or maximum available; **compliance-aid statement** "This policy meets the definition of private flood insurance contained in 42 U.S.C. 4012a(b)(7) and the corresponding regulation" satisfies verification; discretionary acceptance (c)(3) for non-qualifying private policies that provide the required amount, an approved insurer, mortgagor/mortgagee loss payees, and documented protection; §22.5 escrow (loans made/increased/extended/renewed on/after **Jan. 1, 2016**; exceptions as above); §22.6 use and retention of the **Standard Flood Hazard Determination Form** (FEMA FF-206-FY-21-116, OMB 1660-0040 — 00b N5) "for the period of time the bank … owns the loan"; §22.7 force placement (notice; 45 days; purchase; charge; 30-day termination/refund; declarations page); §22.9 notice of special flood hazards at origination and "as promptly as practicable" to the servicer; §22.10 notice of servicer identity to FEMA/its designee within **60 days** of a servicing transfer. Source: https://www.ecfr.gov/current/title-12/chapter-I/part-22 (verified 2026-09-09).

**NFIP limits — 44 CFR Part 61 (current as of Sept. 8, 2026)**: §61.6 Regular Program building maximum **$250,000** for 1–4 family, **$250,000 × number of units** for residential condominium buildings (RCBAP), $500,000 other residential/non-residential; contents $100,000 residential; §61.5 deductible options **up to $10,000** with minimums $1,000/$1,250 (post-FIRM/full-risk) and $1,500/$2,000 (pre-FIRM discounted); §61.11 coverage effective 12:01 a.m. on the **30th calendar day** after application, except at loan closing when purchased in connection with the loan, and **1 day** during the **13 months** after a map revision (also post-wildfire 60-day rule). Source: https://www.ecfr.gov/current/title-44/chapter-I/subchapter-B/part-61 (verified 2026-09-09).

**Fannie Mae B-3-01, Flood Insurance Requirements Applicable to All Property Types (02/14/2024)**: servicer must ensure continuous coverage "with no lapses of coverage"; pay premiums through escrow per B-1-01; "actively monitor all flood maps and community status changes and take appropriate action as changes occur"; when a property is remapped **into** an SFHA in a participating community "obtain the required coverage within **120 days** after the effective date of the remapping" regardless of borrower objections; in a non-participating community, work with the borrower to obtain private coverage within the same 120 days; when remapped **out**, stop requiring coverage and cancel on receipt of the borrower's FEMA letter (LOMA/LOMR), retained in the file; provide evidence of coverage within **10 business days** of Fannie Mae's request; during an NFIP lapse, keep collecting/remitting premiums, track affected policies and facilitate issuance once the lapse ends; renovation/energy-improvement loans per Selling Guide B7-3-05. Source: https://servicing-guide.fanniemae.com/svc/b-3-01/flood-insurance-requirements-applicable-all-property-types (verified 2026-09-09). **Selling Guide B7-3-06 (02/07/2024)**: coverage required for any principal or residential detached structure (serving as security) any part of which is in an SFHA (zones beginning with A or V) or in a CBRS/OPA; SFHDF required; non-participating community → loan ineligible for purchase (servicing consequence: private coverage required); **1–4 unit amount = lesser of 100% RCV of improvements, the NFIP maximum, or the UPB**; **RCBAP** must cover the unit's entire building and common elements for the lesser of **80% of RCV** or the NFIP per-unit maximum, and if the per-unit allocation falls short of the unit's requirement the unit owner must carry a supplemental policy; co-op General Property Form lesser of 100% RCV or NFIP max; PUD units per the 1–4 unit rule; **deductible** must not exceed the NFIP maximum for the applicable form; acceptable policies: NFIP SFIP, or a private policy whose "terms and amount of coverage are at least equal to" the NFIP policy from an insurer meeting Fannie Mae's rating requirements; a declarations page is acceptable evidence. Source: https://selling-guide.fanniemae.com/sel/b7-3-06/flood-insurance-requirements-all-property-types (verified 2026-09-09). **B-6-01**: LPI flood excluded from the deductible tiers; no-affiliate/no-commission rules apply. **F-1-05**: flood premium advances reimbursable on delinquent loans (15.2). **LL-2026-02** (Mar. 3, 2026) shutdown flexibilities are expired (00a §3.3).

**Reg X**: §1024.37(a)(2)(i) excludes FDPA-required flood insurance from "force-placed insurance," so MS-3 notices and the 45/30/15 sequence do not govern flood placement; §1024.17(k)(1)–(2) still require paying/advancing flood premiums for escrowed borrowers ≤ 30 days overdue (flood is "hazard insurance" under §1024.31); the (k)(5) purchase prohibition refers to §1024.37(a) force-placed insurance and therefore does not bar FDPA placement. RESPA §6(l)(4) permits a simultaneous flood notice with the hazard notice. **Interagency Flood Q&As (2022)** provide the accepted reading that the 45-day clock runs from the notice date and that the charge may start at the lapse date **[PARTIALLY VERIFIED — Q&A text not retrieved today]**.

**Discrepancies vs blueprint**: (1) the source is the FDPA as implemented through Fannie Mae's Guide, not "FEMA NFHL" (a screening layer, "not a determination" — 00b N5); (2) the 120-day Fannie Mae remap rule, the 30-day termination rule, the 10-business-day evidence rule and the 13-month one-day NFIP effective-date window are missing; (3) automation class "b" is conservative — the cycle is deterministic except for structure-location judgment on ambiguous determinations.

### Operational prerequisites
- Flood-determination vendor contract (Cotality/CoreLogic, ServiceLink, LERETA, First American — 00b N5) with SFHDF issuance, guarantee, **life-of-loan** monitoring, next-day map-change notifications, community-status changes, multiple-structure indicator and API/XML integration; assignment of transferor LOL contracts at boarding (else re-order) — Supermortgage; 4–8 weeks.
- LPI flood capacity: NFIP Mortgage Portfolio Protection Program (MPPP) via a WYO or private LPI flood through the LPI program (partner named insured) — Partner/Supermortgage.
- Notice Registry templates `INS_FLOOD_FPI_NOTICE_45`, `INS_FLOOD_MAP_CHANGE_NOTICE`, `INS_FLOOD_REMOVED_NOTICE`, `INS_FLOOD_FPI_PLACED_NOTICE` with counsel review — Supermortgage.
- Boarding: SFHDF images and LOL evidence per loan (W-007); NFIP/WYO mortgagee-clause updates for the partner/Supermortgage; FEMA servicer-identity notice handled by the transferor regulated lender within 60 days (22.10) — the transfer runbook (1.x/17.x) includes a confirmation step.
- Escrow lines for flood on escrowed loans (3.x); waiver/escrow-offer language for non-escrowed loans remapped into SFHAs (3.8).

### Build spec
#### Inputs and triggers
- `loan.boarded` → `flood_determinations` seeded (SFHDF from the transferor or vendor re-order) and LOL enrolment.
- Vendor messages (`flood` adapter): `determination_result` (SFHDF data + PDF), `map_change_notification` (in/out, effective date, new zone/panel), `community_status_change` (participation/suspension/probation), `lomr_loma_received`.
- Borrower/FEMA documents: LOMA/LOMR letters (remap out), elevation certificates (informational).
- `insurance.policy.*` events for `policy_kind ∈ {flood, rcbap}` (9.1 engine) → adequacy; `insurance.lapse_detected` with `insurance_type='flood'` → this process's FPI track.
- Fannie Mae requests for flood evidence; disaster events (D1-3-01) for claims (9.7).

#### Data model
- `flood_determinations` (new): `id`, `loan_id`, `property_id`, `vendor_party_id`, `vendor_ref`, `determination_date`, `sfhdf_document_id`, `zone text`, `sfha bool`, `cbrs_opa bool`, `community_number`, `community_name`, `participating bool`, `program_status` ∈ {regular, emergency, suspended, non_participating}, `map_panel`, `map_date`, `lol bool`, `multiple_structures bool`, `structures jsonb` (per structure: in_sfha, residential, security), `determination_type` ∈ {boarding, reorder, lol_update, map_change, manual_review, loma_lomr}, `previous_id`, `coverage_required bool`, `required_amount_cents`.
- `flood_map_changes` (new): `id`, `determination_id`, `received_at`, `effective_date`, `direction` ∈ {into_sfha, out_of_sfha, zone_change_within, community_change}, `old_zone`, `new_zone`, `fnma_deadline` (effective + 120), `status` ∈ {open, notified, covered, lpi_placed, released, closed}.
- `insurance_policies` with `policy_kind ∈ {flood, rcbap, lpi_flood}` plus flood fields: `nfip bool`, `private_flood_compliance_aid bool`, `b7_elements jsonb` (45-day cancellation notice, mortgage-interest clause, recourse, breadth), `building_coverage_cents`, `contents_coverage_cents`, `nfip_deductible_cents`.
- `fpi_cases` with `track='fdpa_flood'` and fields: `flood_notice_mailed_at`, `flood_earliest_placement_date` (= mailed + 45), `flood_required_amount_cents`, `flood_lpi_effective`.
- `jurisdiction_rules`: none specific; community participation is property-level data.

#### State machine
Determination: `ordered` → `received` → `in_sfha` | `not_in_sfha` ; `in_sfha` → `coverage_required` → `covered` (adequate policy) | `deficient` → FPI track ; map change: `open` → `borrower_notified` → `covered` | `lpi_placed` (day 45+) → `covered`; `out_of_sfha` (LOMA/LOMR or map change) → `released` (policy no longer required; borrower may keep it). FPI flood track: `deficiency` → `notice_sent` (t0) → `placement_eligible` (t0 + 45, no evidence) → `lpi_placed` (charge from lapse/requirement date) → `terminate_refund` on evidence (≤ 30 days) → `closed`. Actors: agent; vendor messages; `officer` only for Fannie Mae evidence responses; no portal step.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FDPA_4012A_E_FLOOD_FPI_NOTICE_45` | not_before_gate | `flood.fpi.notice.sent` | mailed date | +45 calendar_days | — | placement/charge refused before |
| `INS_FLOOD_NOTICE_SLA_3BD` | deadline (policy; statute says "shall notify") | `flood.deficiency.detected` | detection | 3 business_days_servicer | `flood.fpi.notice.sent` | sev-2 |
| `FDPA_4012A_E2_FLOOD_PLACE_AFTER_45` | deadline | gate opens | t0 + 45 | 0 (place on the first day allowed; Fannie "no lapses") | `flood.lpi.bound` | sev-1 (collateral uninsured) |
| `FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30` | deadline | `insurance.evidence.received` (flood, sufficient) | receipt | 30 calendar_days | `flood.lpi.terminated` AND refund paid | sev-1 |
| `FNMA_B301_FLOOD_REMAP_COVERAGE_120` | deadline | `flood.map_change.received` (into SFHA) | remap effective date | 120 calendar_days | `flood.coverage.verified` or `flood.lpi.bound` | sev-1 |
| `FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD` | deadline | `fnma.request.received` | request | 10 business_days_fannie_et | response sent | sev-1 → `officer` |
| `FLOOD_LOL_HEARTBEAT_35` | deadline (internal) | vendor LOL feed | last heartbeat | 35 calendar_days | any vendor message | sev-2 (monitoring blind) |
| `NFIP_44CFR6111_MAP_REVISION_1DAY_13M` | informational window | `flood.map_change.received` | effective date | 13 months | — | used in borrower guidance and expected-effective-date checks |
| `FLOOD_EVIDENCE_EVAL_2BD` | deadline (policy) | evidence received | receipt | 2 business_days_servicer | confirmed/rejected | sev-2 |

#### Business rules and calculations
1. **Requirement**: `coverage_required = sfha_any_security_structure OR cbrs_opa` (B7-3-06 table: principal structure any part in SFHA; residential detached structure serving as security; non-residential detached or non-security structures do not trigger). Non-participating community → private flood required (Fannie: work with borrower within 120 days).
2. **Required amount (1–4 unit/PUD)** = min(100% RCV of improvements, NFIP building max $250,000, UPB at evaluation). Worked: RCV $310,000, UPB $240,000 → **$240,000**; UPB later amortizes to $199,500 and the policy is $240,000 → still adequate (over-coverage is fine); the requirement is re-evaluated at each renewal so the borrower may reduce. Deductible ≤ NFIP maximum ($10,000 per 44 CFR 61.5 for the Dwelling Form). Private policy accepted if the compliance-aid statement is present or the (b)(7) elements are verified and the insurer meets B7-3-01 ratings; else discretionary acceptance is **not** used (open decision 9.6-Q2).
3. **Condo (RCBAP)**: building requirement = min(80% × RCV_building, $250,000 × units); per-unit allocation = RCBAP amount ÷ units; unit requirement = min(RCV_unit, $250,000, UPB); supplemental unit policy required for max(0, unit requirement − allocation). Worked: 20 units, RCV $6,000,000 → required RCBAP ≥ min(4,800,000, 5,000,000) = **$4,800,000**; allocation $240,000; unit UPB $180,000 → no supplement. RCBAP of $3,000,000 → allocation $150,000 → supplement **$30,000**.
4. **Notice**: `INS_FLOOD_FPI_NOTICE_45` states the SFHA determination (zone, map panel/date), that coverage is required in at least the stated amount for the remaining term, that the borrower has 45 days from the notice date to buy it (NFIP or qualifying private), that otherwise the servicer will purchase it "on behalf of the borrower" and charge premiums and fees "for coverage beginning on" the lapse/requirement date, the cost warning, how to send evidence (declarations page acceptable — (e)(4)), and contact; it may be mailed in the same transmittal as an MS-3(A) but on separate paper (RESPA §6(l)(4)); first-class mail (policy; the FDPA does not prescribe class).
5. **Placement**: on t0 + 45 with no sufficient evidence, bind LPI flood (MPPP/private) for the required amount, effective the **lapse date** (expiration/cancellation) or, for a remap, the **remap effective date** (default; open decision 9.6-Q1), charge to the borrower as in 9.2 rule 7 (escrowed → `disbursement_kind='flood'` via 3.7; non-escrowed → advance/receivable), and re-verify the Fannie 120-day timer (remap) is satisfied by the placement.
6. **Termination/refund**: overlap calculator from 9.5 with a **30-day** deadline; the refund covers premiums *paid* for the overlap and related fees; removal of assessed charges for the overlap.
7. **Remapped out / LOMA**: stop requiring coverage; cancel LPI flood effective the FEMA letter/map effective date and refund overlap (borrower-paid LPI premiums beyond the requirement end); the borrower's own NFIP policy is theirs to keep/cancel; file the FEMA letter (B-3-01).
8. **Escrow**: escrowed loans — add/adjust the flood line at the next analysis (3.2) or an interim analysis; non-escrowed loans remapped in — offer escrow (policy) and apply 3.8 waiver rules; HFIAA escrow applies to regulated lenders' designated loans from Jan. 1, 2016 and is assumed already implemented at origination.
9. **NFIP lapse/shutdown**: track policies that could not be issued/renewed; no force placement for NFIP unavailability alone during a lapse (private LPI or continue tracking per B-3-01 and any current Lender Letter); collect and remit premiums on reauthorization.
10. **Worked timeline**: map change effective **2027-02-03** (Wed) received 2027-02-04 → verified (principal structure in AE, participating community) → notice mailed **2027-02-05** (Fri) → borrower deadline **2027-03-22** (Mon) → no evidence → LPI flood bound 2027-03-22 (effective 2027-02-03, $240,000, premium $1,150.00/yr) → Fannie 120-day deadline **2027-06-03** satisfied. Borrower later buys NFIP coverage on 2027-04-10 (1-day effective date applies within 13 months of the 2027-02-03 revision → effective 2027-04-11); dec page received 2027-04-14 → terminate effective 2027-04-11; overlap [2027-04-11, 2028-02-03) computed by the 9.5 calculator (term 2027-02-03 → 2028-02-03 = 365 days; daily = 115,000 ÷ 365 = 315.068493 cents; 298 days → 93,890.4110 → **$938.90**); refund + termination by **2027-05-14**.

#### Integrations
- **`flood` adapter** (vendor API/XML; 00b N5): `order_determination`, `enroll_lol`, `transfer_lol`, inbound `determination_result`, `map_change_notification` (next-day), `community_status_change`; idempotency by vendor certificate id; PDF SFHDF stored in `documents`; sandbox = vendor test environment; outage → FEMA NFHL REST as a screening cross-check only (never a determination).
- **FEMA NFHL** (`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer`): read-only screening/QA; results never override a vendor SFHDF.
- **`insurance-tracking/lpi`**: flood policy snapshots (NFIP/WYO EOI), `lpi_flood_placement_request/bound/cancel/refund`.
- **Escrow 3.7 / 3.2**: flood premium disbursement and analysis; **Section 15.2**: F-1-05 claims for advanced premiums.
- **Fannie Mae**: evidence requests answered by document upload/e-mail (`fnma_portal_operator`); no API.

#### Outputs and artifacts
- Notices: `INS_FLOOD_FPI_NOTICE_45` (42 U.S.C. 4012a(e)(1); checklist per rule 4), `INS_FLOOD_MAP_CHANGE_NOTICE` (policy; may be combined with the 45-day notice when coverage is absent), `INS_FLOOD_FPI_PLACED_NOTICE` (policy: coverage bound, amount, premium, charge, how to replace), `INS_FLOOD_REMOVED_NOTICE` (remapped out; coverage no longer required), `INS_FLOOD_TERMINATION_REFUND_CONFIRM`.
- Records: `flood_determinations`, `flood_map_changes`, policies, `fpi_cases` (flood), `fpi_refunds`; events `flood.determination.ordered/received`, `flood.map_change.received/notified/closed`, `flood.coverage.required/not_required/verified`, `flood.deficiency.detected`, `flood.fpi.notice.sent`, `flood.lpi.bound/charged/terminated`, `flood.refund.paid`; ledger and escrow events as in 9.2/9.5.

#### AI agent design (AI-first)
- `insurance-property` tools: `orderDetermination`, `evaluateStructures` (compares SFHDF structure flags with property records/aerial imagery to confirm which structure is in the SFHA), `computeFloodRequirement`, `evaluatePrivateFloodPolicy` (compliance-aid/(b)(7) element check), `composeNotice(FLOOD_45)`, `mailNotice`, `requestFloodLpi`, `terminateFloodLpi`, `computeOverlapRefund`. Decision record: {determination ids, structure reasoning, requirement math, evidence evaluation, notice/mailing evidence, placement, refund}.
- Guardrails: no placement before t0 + 45; no reliance on FEMA NFHL alone; amount never exceeds the rule-2 minimum unless the borrower elects; termination/refund within 30 days regardless of carrier; automation disclosure and consent for any outreach call. Escalations: `officer` (Fannie Mae evidence requests; disputes over determinations — vendor guarantee claims), `human_agent` on request, `attorney` for borrower challenges to a determination (FEMA LOMA route explained to the borrower first).
- AI-off: deterministic cycle; staff evaluate evidence and structure questions.

#### Edge cases and failure modes
- Multiple structures: only the SFHA structure(s) serving as security need coverage; a detached garage in the SFHA with the house outside → no coverage (B7-3-06 table) — record the reasoning.
- Community suspended/non-participating after boarding → NFIP unavailable → private flood; Fannie eligibility issue is the partner's (loan already owned); document efforts within 120 days.
- Borrower disputes the zone: encourage a LOMA request; the 45-day clock does not pause (statute), but the placed policy is cancellable with refund on a LOMA (rule 7).
- Escrowed borrower > 30 days overdue with a flood lapse: (k)(5) does not bar FDPA placement; still notice-then-place; premiums advanced and reimbursable if delinquent (15.2).
- Transfer-in with no SFHDF: order a new determination at boarding (cost borne per transfer agreement); transfer-out mid-cycle: pass notice dates.
- Disaster: map revisions after floods trigger the 13-month 1-day window; NFIP claim handling in 9.7.
- Vendor outage/LOL gap: heartbeat timer; manual re-order for any loan with a pending map-change alert.
- Servicer error (wrong determination): cancel, refund everything, root-cause record.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 9.6-T1 | Given remap into AE effective 2027-02-03 and notice mailed 2027-02-05 When 2027-03-21 Then placement refused; 2027-03-22 allowed; Fannie 120-day timer satisfied on binding. |
| 9.6-T2 | Given RCV $310,000, UPB $240,000 Then required $240,000; a $200,000 policy → `flood_insufficient` deficiency. |
| 9.6-T3 | Given a private policy with the compliance-aid statement and an AM Best A insurer Then accepted; without the statement and lacking the 45-day cancellation clause → rejected with reason. |
| 9.6-T4 | Given RCBAP $3,000,000 on a 20-unit building with RCV $6,000,000 and unit UPB $180,000 Then supplemental requirement $30,000. |
| 9.6-T5 | Given evidence received 2027-04-14 of coverage effective 2027-04-11 Then termination and refund of $938.90 by 2027-05-14. |
| 9.6-T6 | Given a LOMA letter Then requirement cleared, LPI cancelled effective the letter date, refund of any borrower-paid overlap, `INS_FLOOD_REMOVED_NOTICE` sent. |
| 9.6-T7 | Given a hazard lapse and flood lapse on the same day Then MS-3(A) and the flood 45-day notice are mailed as separate documents in one transmittal; timers independent. |
| 9.6-T8 | Given no vendor heartbeat for 36 days Then sev-2 and a re-order queue for pending alerts. |
| 9.6-T9 | Given Fannie Mae requests flood evidence on a Monday Then response due 10 fannie_et business days later; package assembled by the agent. |

#### Audit and evidence
SFHDF images and vendor certificate ids, LOL enrolment proof, map-change messages, requirement calculations, private-policy element checks, notices with proof of mailing, placement/termination messages, refund calculator outputs, Fannie Mae evidence responses; `life_of_loan_plus_4y`.

### Open questions / decisions
1. Effective date of LPI flood on a remap — remap effective date (**default**) vs notice date; partner/counsel to confirm against the Interagency Q&As.
2. Use of discretionary acceptance (22.3(c)(3)) for non-qualifying private policies — **default: no** (Fannie Mae's own criterion — terms/amount at least equal to NFIP + rating — governs).
3. Pre-expiration flood notice (send the 45-day notice at −45 days when NFIP expiration data is known) — **default: send at lapse**, noting the NFIP 30-day grace period **[PARTIALLY VERIFIED]**.
4. Offering escrow to non-escrowed borrowers remapped into an SFHA — **default: offer, not require** (3.8 governs revocation).

### Sources
- 42 U.S.C. 4012a: https://www.law.cornell.edu/uscode/text/42/4012a — verified 2026-09-09
- 12 CFR Part 22: https://www.ecfr.gov/current/title-12/chapter-I/part-22 — verified 2026-09-09
- 44 CFR Part 61 (§§61.5, 61.6, 61.11): https://www.ecfr.gov/current/title-44/chapter-I/subchapter-B/part-61 — verified 2026-09-09
- Servicing Guide B-3-01 (02/14/2024): https://servicing-guide.fanniemae.com/svc/b-3-01/flood-insurance-requirements-applicable-all-property-types — verified 2026-09-09
- Selling Guide B7-3-06 (02/07/2024): https://selling-guide.fanniemae.com/sel/b7-3-06/flood-insurance-requirements-all-property-types — verified 2026-09-09
- 12 CFR 1024.37(a)(2)(i), 1024.31, 1024.17(k) — URLs in 9.1/9.2 — verified 2026-09-09
- FEMA NFHL services and SFHDF form reference — research/00b-integration-landscape.md N5 — 2026-09-09
