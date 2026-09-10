# 9.9 — Property preservation (vacant)

| Attribute | Value |
|---|---|
| Section | 9 — Insurance & Property Protection |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | On vacancy |
| Governing source | FNMA Property Preservation Matrix |
| Key deadlines | Per matrix |
| Timers | `FNMA_F105_PRESERVATION_CLAIM_60`, `FNMA_PPM_AUDIT_RESPONSE_7`, `FNMA_PPM_BID_RECONSIDER_7`, `FNMA_PPM_INITIAL_SECURE_14`, `FNMA_PPM_OVER_ALLOWABLE_BID_15`, `FNMA_PPM_POST_NOTICE_SECURE_7`, `FNMA_PPM_ROOF_TARP_60`, `FNMA_PPM_WINDOW_DOOR_REPAIR_3`, `FNMA_PPM_YARD_REBID_15`, `INS_VACANCY_CARRIER_NOTIFY_5BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Property |
| Trigger & frequency | On vacancy |
| Governing source (blueprint) | FNMA Property Preservation Matrix |
| Key deadlines (blueprint) | Per matrix |
| Data/artifacts | Preservation record |
| Systems | Property 360 vendor |
| Automation class (blueprint) | b |
| SoR / Sub | [cropped in source] — reconstructed: Sub orders/monitors under the partner's servicer number; Fannie Mae's vendor performs for PFPIP loans; partner liable; over-allowable approvals from Fannie Mae |
| Nuances (blueprint) | [cropped in source] — reconstructed: 14-day initial securing from first-time-vacant; 7 days after posting expiry; clear boarding; year-round winterization; 10-CY debris cap with BATF 11–20 CY and bid > 20 CY; HomeTracker bids within 15 days; 7-day reconsideration/audit; registration ordinances; code violations; roof tarp 60 days; insurance vacancy notification; E-3.2-12; REO handoff |

### Verified requirement (as of 2026-09-09)

**Property Preservation Matrix and Reference Guide (June 2025)** (https://singlefamily.fanniemae.com/media/document/pdf/property-maintenance-and-management-property-preservation-matrix-and-reference-guide, verified 2026-09-09): 17 sections (technology/photos, inspections, registrations, initial securing and services, ongoing services, utilities, damaged/disaster properties, specialty inspections, code violations, loans in bankruptcy and/or loss mitigation, bid-after-the-fact, completion, hazard claims, occupancy/loan-status changes, reimbursement, addendums). Key rules: "Complete initial securing and initial services within **fourteen (14) calendar days** from the first time vacant (FTV)"; with a posted vacancy notice, within **7 calendar days** of the notice's expiration and still within 14 days of FTV; the notice must show clear contact information and a projected securing date ≤ 14 days from FTV, and old contractor postings must be replaced. **Securing**: one lock change on the main dwelling (secondary door preferred), one lockbox per loan life, deadbolts on replaced doors, Door Armor-type jamb/hinge protection, garages/outbuildings padlocked, slider/window locks on the main level; **clear boarding** (polycarbonate — SecureView/InvisiBoard or 3/16″ equivalent) for windows where plywood would have been used; plywood only for crawl spaces, pet doors and fire-damaged/pre-demolition structures; broken windows reglazed/repaired/clear-boarded within the 14 days, then within **3 days** of discovery; exterior-rated doors only, 3-day post-initial repair; pools covered with anchored safety covers (above-ground poor-condition pools removed as debris), mosquito treatment, ≥ 4-ft intact fence with padlock. **Winterization**: year-round ("There is not a winterization season") except HI/GU/PR/VI; curb and interior shut-off, drain systems, antifreeze in traps, pressure test, thermostat 55° where shared utilities/sprinklers; re-winterize when compromised. **Yard**: one Initial Yard Service allowable per loan life, then bids within **15 calendar days** of discovery; grass < 12″ within the allowable; 12–36″ complete and bid-after-the-fact; > 36″ bid first via HomeTracker; over-one-acre perimeter rule; tree/shrub trimming with 1-ft/3-ft clearances; snow removal at ≥ 3″ or ice. **Debris**: combined **10 cubic yards** (3′×3′×3′) for raw garbage, perishables, debris and personal property; 11–20 CY complete and BATF; > 20 CY stop and bid; hazardous items excluded (paint, chemicals, tires, medicine, propane). **Health/safety**: cap wires and gas/water/sewer lines, remove dead animals, OTC extermination, discoloration, moisture control, sump pump, emergency water pumping. **Damaged/disaster**: patch/repair roof within the allowable; otherwise tarp (allowable) and bid; tarps not > **60 days**; two roof bids; more frequent inspections; flood water removal; demolition bids for unstable structures. **Registrations**: "Upon delinquency, the servicer must determine any requirements imposed by municipal, county, or state authorities for property registration," register and pay fees under the Property Registration allowable (actual cost — F-1-05); fines/penalties for failure to register are **not reimbursable**. **Code violations**: F-1-05 caps $1,000 per fine/fee/lien, $3,000 life of loan; REO code violations go to the AMN REO agent. **Bids**: work within the F-1-05 Defined Expense Reimbursement Limits needs no prior approval; **HomeTracker "is the required method of submission for all over allowable bids"** (Form 1095 by e-mail to property_preservation@fanniemae.com only if the loan is not in HomeTracker); over-allowable bids within **15 calendar days** of discovery; **7 calendar days** to respond to a bid decision with more information; **7 calendar days** to answer an audit request; date-stamped color before/during/after photos (≤ 30 days old for bids); specialty work by licensed contractors; local ordinance/association standards prevail where stricter. **Hazard claims** section ties into B-5-01 (9.7). **F-1-05 (06/11/2025) Defined Expense Reimbursement Limits** (as extracted 2026-09-09; confirm against the live table before coding): locks $60/$40/$25; boarding $0.90 per united inch; clearboarding $185/$285; windows $150/$200 ($600 life); security door $250; exterior door $500 life; door jamb $300 life; dryer vent $25; garage door $100; pool cover $1,200 life; fence/gate/lanai $300 life each; initial grass cut $125–$250 by lot size (life of loan); re-cut $80–$175; trimming $500/yr; winterization dry $150 / wet-steam $220 / radiant $260 first unit, $100 additional unit, re-winterize $50/yr; refrigerator/freezer cleaning $100; moisture control $30/product, $360/yr; discoloration $400 life; toilet cleaning $75 ($375 life); capping wires $1; capping lines $25; extermination $100/yr; deck $300; handrails $400; steps $150; debris $50/CY and personal property $20/CY (10 CY combined life); dead animal $75; roof cleaning $100/yr; aerial imagery $75; address posting $50; chimney cap $250 (2/unit); gutters clean $100/yr, repair $300/yr; snow $100 per clearing ($1,000/yr); sump pump $300; utility transfer/shut-off $100; utility service $2,000 initial + $200/service/month; police/fire report $50; emergency pump water $500; graffiti $200; fascia $160; soffits $200; plumbing $150; vacancy notice posting $50/unit; roof patch $1,250 life; tarp $1,000 life; code violations $1,000 each/$3,000 life; registration actual cost.

**Servicing Guide E-3.2-12, Performing Property Preservation During Foreclosure Proceedings (07/14/2021)** (https://servicing-guide.fanniemae.com/svc/e-3.2-12/performing-property-preservation-during-foreclosure-proceedings, verified 2026-09-09): "the servicer must perform all property maintenance functions as necessary to ensure that the condition and appearance of the property are satisfactorily maintained" until conveyance or Fannie Mae reassigns responsibility; for vacant/abandoned delinquent properties, follow the Matrix, "take whatever action is necessary to protect the value of the property," ensure no apparent illegal activity, protect against vandals and the elements; over-allowable requests via HomeTracker (F-1-08 otherwise). **D2-2-10** (9.8): on vacancy confirmation, "make immediate arrangements to protect the property from vandalism and the elements to the extent that local laws allow," locate the borrower, contact other lienholders, **notify the property insurance carrier**. **B-5-01/B-5-02**: damaged vacant properties (9.7). **F-1-05**: preservation reimbursed at the limits; servicer must "validate fees and costs prior to submitting" and retain invoices; claims within 60 days of milestones (15.2). **PFPIP** (9.8): for enrolled loans with "Do insp and preserv," Fannie Mae's vendor secures and preserves once vacancy is established, with 24/7 contact and posting; program expenses are not borrower-recoverable. **Consolidated Technology Guide**: HomeTracker/P360 UI steps are not automatable.

**Other law**: entry and securing of a property before foreclosure is governed by the security instrument (uniform instrument §9: lender may "do and pay for whatever is reasonable or appropriate to protect" its interest, including "entering the Property to make repairs, change locks, replace or board up doors and windows…") and state law — some states restrict pre-foreclosure entry or require notice/posting, and many municipalities have vacant/foreclosure registration ordinances with fees and renewal periods; New York RPAPL §1308 imposes maintenance duties and a DFS registry **[PARTIALLY VERIFIED]**; bankruptcy stay (11 U.S.C. 362) — preservation of estate property requires counsel guidance (Matrix §11 addresses BK/loss-mit loans **[content not extracted — PARTIALLY VERIFIED]**); FDCPA/Reg F not implicated by preservation contacts unless debt is discussed; Fair Housing/UDAAP for postings (neutral language). All modeled as `jurisdiction_rules` (`vacant_property_registration`, `prefc_entry_rules`, `posting_rules`).

**Discrepancies vs blueprint**: "per matrix" hides hard dates (14/7/3/15/7/60 days) and the 10-CY/12″/36″ thresholds; "Property 360 vendor" conflates two things — Fannie Mae's PFPIP vendor (program loans) and Supermortgage's own field-services vendor (non-program loans, emergencies, REO handoff); automation class "b" is right because over-allowable bids and program submissions are portal-only human steps.

### Operational prerequisites
- Field-services vendor(s) (Safeguard, MCS, Five Brothers or regional — 00b N13) with work-order API/portal, Matrix-compliant materials (clear boarding, Door Armor), licensed specialty subcontractors, photo standards, invoice detail by allowable code — Supermortgage; 6–10 weeks.
- HomeTracker access for Supermortgage employees under the partner's servicer number (`fnma_portal_operator`); Form 1095 fallback; property_preservation@fanniemae.com channel — Partner + Supermortgage.
- PFPIP enrollment and permission settings (9.8).
- `jurisdiction_rules` seeded with registration ordinances (initial list from the vendor's ordinance database **[UNVERIFIED coverage]**), entry/posting rules, and state maintenance statutes — legal + vendor; ongoing maintenance job.
- Utility account procedures (transfer/shut-off; $2,000 initial/$200 per service per month caps) and a corporate-advance facility for preservation costs (15.2 reimbursement).
- Insurance vacancy notification workflow (9.1 rule 6) and LPI vacancy forms.

### Build spec
#### Inputs and triggers
- `property.vacancy_confirmed` (9.8; FTV = date of the signed vacancy certification or, if earlier, the date vacancy was first indicated by an inspection — recorded as `ftv_date`) → open `preservation_cases`.
- `property.abandonment_confirmed`, `property.vacancy_suspected` (posting decision), inspection condition flags (broken window/door, roof damage, standing water, grass > 12″, debris, pool), code-violation notices, utility shut-off notices, HOA complaints, police/fire reports, disaster events, hazard-claim events (9.7), bankruptcy/loss-mit status changes, foreclosure milestones, `reo.acquired` (handoff), reinstatement/payoff (close).
- PFPIP program data (Loan Search API/reports) showing Fannie Mae vendor activity.

#### Data model
- `preservation_cases` (new; `cases.case_type='preservation'` — new enum value, defined here): `id`, `loan_id`, `property_id`, `ftv_date`, `mode` ∈ {servicer, pfpip, hybrid}, `posting_expires_at`, `initial_due` (= ftv + 14), `initial_completed_at`, `occupancy_status`, `bk_lossmit_constraints jsonb`, `entry_permitted bool` (jurisdiction), `status`.
- `preservation_work_orders` (new): `id`, `case_id`, `vendor_party_id`, `kind` ∈ {initial_secure, initial_services, ongoing, emergency, damage, code_violation, registration, utility, specialty}, `items jsonb` ([{allowable_code, description, qty, unit, unit_cost_cents, allowable_cap_cents, life_of_loan_used_cents, over_allowable bool}]), `ordered_at`, `due_by`, `completed_at`, `photos document_id[]`, `invoice_document_id`, `total_cents`, `within_allowable bool`, `bid_id?`, `batf bool`, `claim_id?` (15.2), `status` ∈ {ordered, in_progress, completed, cancelled, rejected}.
- `preservation_bids` (new): `id`, `case_id`, `work_order_id?`, `discovery_date`, `submit_due` (= discovery + 15), `submitted_at`, `channel` ∈ {hometracker, form_1095_email}, `human_task_id`, `amount_cents`, `fnma_decision` ∈ {pending, approved, modified, denied}, `decision_at`, `reconsider_due` (= decision + 7), `status`.
- `property_registrations` (new): `id`, `loan_id`, `jurisdiction_rule_id`, `registration_type` ∈ {vacant, default, foreclosure, blight, contact_change}, `trigger_event`, `due_date`, `filed_at`, `fee_cents`, `renewal_every`, `next_renewal_due`, `confirmation_document_id`, `status`.
- `allowable_matrix` (new, versioned reference table keyed by `rule_set='fnma.ppm.2025-06'`): `code`, `description`, `cap_cents`, `cap_unit` ∈ {each, per_ui, per_cy, per_unit, per_year, life_of_loan, per_month}, `life_of_loan bool`, `notes`.
- Ledger: preservation costs → `corporate_advances` (loan) when recoverable from the borrower under the contract/state law, else corporate expense; Fannie Mae reimbursement receivable via 15.2. Retention `life_of_loan_plus_4y`.

#### State machine
`opened` (FTV) → `posted` (optional vacancy posting; expiry ≤ FTV + 7) → `initial_ordered` → `initial_completed` (≤ FTV + 14) → `ongoing` (recurring services: yard, winterization checks, snow, utilities, inspections per 9.8) ↔ `bid_pending` (over-allowable) → `bid_decided` → `work_ordered` … → `closed_reinstated` | `closed_paid_off` | `closed_reo_handoff` (E-4.3 — 15.x) | `closed_transferred` | `suspended_bk` (counsel) | `program_managed` (PFPIP vendor active — platform monitors only). Actors: agent; vendor (work); `fnma_portal_operator` (HomeTracker/P360); `attorney` (BK/entry disputes).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_PPM_INITIAL_SECURE_14` | deadline | `property.vacancy_confirmed` | ftv_date | 14 calendar_days | `preservation.initial.completed` (securing + initial services) | sev-1; emergency order; reason documented |
| `FNMA_PPM_POST_NOTICE_SECURE_7` | deadline | `preservation.posting.placed` | posting expiry | 7 calendar_days (and ≤ FTV + 14) | initial completed | sev-1 |
| `FNMA_PPM_WINDOW_DOOR_REPAIR_3` | deadline | unsecured window/door discovered after initial securing | discovery | 3 calendar_days | repair/clear-board completed | sev-2 |
| `FNMA_PPM_OVER_ALLOWABLE_BID_15` | deadline | over-allowable condition discovered | discovery | 15 calendar_days | `preservation.bid.submitted` | sev-2 (reimbursement risk) |
| `FNMA_PPM_BID_RECONSIDER_7` | deadline | Fannie Mae bid decision (denied/modified) | decision | 7 calendar_days | reconsideration submitted or accepted | sev-3 |
| `FNMA_PPM_AUDIT_RESPONSE_7` | deadline | Fannie Mae audit request | request | 7 calendar_days | documents provided | sev-1 → `officer` |
| `FNMA_PPM_ROOF_TARP_60` | deadline | tarp installed | install date | 60 calendar_days | permanent repair completed/approved | sev-2; re-tarp bid |
| `FNMA_PPM_YARD_REBID_15` | deadline | grass > 12″ discovered after the initial service | discovery | 15 calendar_days | bid submitted (or BATF filed for 12–36″) | sev-3 |
| `JUR_VACANT_REGISTRATION_<id>` | deadline (jurisdiction) | trigger per ordinance (vacancy/default/referral) | trigger date | ordinance days (e.g., 10/30) **[per rule]** | `property.registration.filed` | sev-2; fines non-reimbursable |
| `JUR_VACANT_REGISTRATION_RENEWAL_<id>` | recurring (jurisdiction) | filing | filed_at | ordinance period (e.g., 6/12 months) | renewal filed | sev-2 |
| `FNMA_F105_PRESERVATION_CLAIM_60` | deadline (15.2) | milestone | milestone | 60 calendar_days | claim filed | sev-2 |
| `INS_VACANCY_CARRIER_NOTIFY_5BD` | deadline (policy on D2-2-10 "notify the carrier") | `property.vacancy_confirmed` | confirmation | 5 business_days_servicer | `insurance.carrier.vacancy_notified` | sev-2 |
| Jurisdiction overrides | | entry restrictions, posting text, registration; NY RPAPL 1308 registry 21 BD **[UNVERIFIED]** | | | | |

#### Business rules and calculations
1. **Mode**: PFPIP loan with permission "Do insp and preserv" → `pfpip` (Fannie Mae's vendor secures/preserves; the platform monitors program data, updates occupancy/claim/HOA/stop-work flags, and orders only emergency work not covered by the program — open decision 9.9-Q1); permission-restricted or non-program loans → `servicer`.
2. **Initial scope** (servicer mode): from the vacancy inspection's condition flags build the initial work order: lock change (+ lockbox), deadbolt/door protection as needed, window securing (clear boarding), outbuilding padlocks, pool cover, initial yard service, debris (≤ 10 CY), winterization (year-round except HI/GU/PR/VI), utilities decision (shut-off vs. keep-on for sump/heat), health/safety capping, posting with servicer + vendor contacts, aerial imagery if useful ($75). Due ≤ FTV + 14.
3. **Allowable check**: each item's `qty × unit_cost` ≤ `cap` after subtracting life-of-loan usage; anything over → split: complete-and-BATF where the Matrix allows (debris 11–20 CY; grass 12–36″; snow overage) else **stop and bid** (debris > 20 CY; grass > 36″; roof beyond patch; doors/windows beyond caps; specialty work). Bid due 15 days from discovery; submission via HomeTracker (`human_portal_task` package: Form 1095 fields, itemized bid, ≤ 30-day-old dated photos, completion dates for initial services in the Incurred section); denied/modified → 7-day reconsideration.
4. **Worked example**: FTV **2027-03-05**; initial due **2027-03-19**. Vacancy inspection (2027-03-08) shows: rear door lock change, two broken basement windows (small, ≤ 72 UI each), lawn 10″ on a 6,000 sq ft lot, 8 CY of exterior debris, wet-system winterization needed, no pool. Work order: lock change $60 (cap $60 ✓); clear boarding 2 × $185 = $370 (cap $185 each ✓); initial yard service $150 (cap tier for < 10,000 sq ft **[tier boundaries UNVERIFIED — use table]** ✓); debris 8 CY × $50 = $400 (≤ 10 CY ✓); wet winterization $220 ✓; posting $50 ✓ → total **$1,250.00**, all within allowables → no prior approval; completed 2027-03-16 (✓ ≤ 03-19). Variant: debris measured at 25 CY → stop at the allowable, submit a HomeTracker bid for 25 CY by **2027-03-23** (15 days from 2027-03-08 discovery); Fannie Mae approves 20 CY on 2027-03-30 → work ordered; reconsideration for the remaining 5 CY by 2027-04-06 if warranted. Reimbursement claim within 60 days of the milestone (15.2).
5. **Ongoing**: yard as needed year-round (re-cuts $80–$175 per instance by lot size), snow at ≥ 3″, re-winterization on compromise ($50/yr), utilities $200/service/month, periodic interior inspections (9.8), gutters, moisture control; each order re-checked against life-of-loan and annual caps.
6. **Damage/disaster**: patch ≤ $1,250 else tarp ($1,000) + two bids; tarp timer 60 days; hazard claim opened (9.7) when the peril is insurable; flood water removal; demolition bids for unsafe structures; more frequent inspections.
7. **Registrations**: on `delinquency.day*`/vacancy/referral triggers, evaluate `jurisdiction_rules.vacant_property_registration` for the property's state/county/city; file (vendor or direct), pay fee (actual cost reimbursable), schedule renewals; keep proof; fines from missed filings are servicer cost.
8. **Code violations**: pay/cure within caps ($1,000 per, $3,000 life); beyond → bid; REO → AMN agent (15.x); never ignore a citation (liens can prime).
9. **Insurance**: notify the carrier of vacancy within 5 business days (policy SLA on D2-2-10); expect vacancy exclusions after 30–60 days — request a vacancy endorsement or move to LPI vacant-property coverage (9.1/9.2 coverage adjustment).
10. **Handoff**: at foreclosure sale/REO acquisition, preservation responsibility passes per E-4.3 and the REOgram process (15.x); final photos/keys/lockbox code delivered; open work orders closed.

#### Integrations
- **`preservation` adapter**: work-order create/update/cancel, bids, photos, invoices (vendor API/portal/SFTP — vendor-specific **[UNVERIFIED]**); idempotent by order id; SLA tracking; secondary vendor on outage.
- **`fnma-p360`**: PFPIP monitoring (Loan Search API or reports), status updates (9.8); **HomeTracker** (portal-only) → `human_portal_task` packages for bids/BATF/reconsiderations; **Form 1095** e-mail fallback; **Expense Reimbursement** (15.2) bulk upload with itemized preservation lines.
- **Utilities/municipalities/registration services**: vendor-mediated; payments via corporate AP with loan-level tagging.
- **Sections 9.1/9.2** (vacancy coverage), **9.7** (claims), **13.x** (foreclosure status/attorney coordination; HOA), **14.x** (bankruptcy constraints), **15.x** (REO handoff, claims).

#### Outputs and artifacts
- Notices/postings: `PROP_VACANCY_POSTING` (neutral text; servicer + vendor 24/7 contacts; projected securing date ≤ FTV + 14; ordinance-compliant), `PROP_PRESERVATION_NOTICE` (policy/jurisdiction: written notice to the borrower's last known address that the property was found vacant and will be/was secured, how to regain access — where state law or the contract requires), `PROP_REGISTRATION_FILING` (jurisdiction forms).
- Records: `preservation_cases`, `preservation_work_orders`, `preservation_bids`, `property_registrations`, `allowable_matrix`; events `preservation.case.opened/posting.placed/initial.ordered/initial.completed/work.ordered/work.completed/bid.submitted/bid.decided/registration.filed/renewed/code_violation.received/resolved/utility.changed/handoff.completed/closed`; ledger postings for costs/advances; 15.2 claim lines.

#### AI agent design (AI-first)
- `insurance-property` agent: `buildInitialScope` (from inspection photos/flags via vision + checklist), `checkAllowables` (deterministic against `allowable_matrix` and life-of-loan usage), `orderWork`, `reviewCompletion` (photo QC: before/during/after, date stamps, haul-away evidence), `prepareBid` (Form 1095/HomeTracker package), `fileRegistration`, `notifyCarrierVacancy`, `openClaim`, `escalate`. Decision record: {case, FTV basis, scope rationale, allowable computations, vendor, photos hashes, bid decisions, jurisdiction rules applied}.
- Guardrails: no entry unless vacancy is confirmed (signed certification) and `entry_permitted` for the jurisdiction; no over-allowable work without a Fannie Mae approval record except Matrix-permitted BATF; no hazardous-material handling outside the allowable list; costs never charged to the borrower on PFPIP loans or where the contract/state law prohibits; neutral postings. **Human touchpoints**: `fnma_portal_operator` (HomeTracker bids, P360 updates), `attorney` (bankruptcy stay, occupant/tenant disputes, state entry restrictions, Form 20 litigation), `officer` (audit responses to Fannie Mae), `human_agent` on request.
- AI-off: deterministic scope templates by condition flags; staff review photos and prepare bids.

#### Edge cases and failure modes
- Occupant returns after securing (or property was never vacant — tenant on vacation): immediate re-entry access, lock re-key at servicer cost, apology/complaint handling (4.5), occupancy reset to occupied; root-cause record; potential wrongful-entry claim → `attorney`.
- Bankruptcy: stay considerations — preservation may be allowed to protect collateral but counsel decides; Matrix §11 rules **[PARTIALLY VERIFIED]**.
- Loss-mit in progress on a vacant property (rare): Matrix §11; coordinate with 12.x; do not interfere with a pending sale/short sale.
- Hazardous conditions (meth lab, biohazard, asbestos): specialty bids; police/fire report ($50); safety first; `attorney` if legal exposure.
- Winter freeze damage found after a failed winterization: emergency work; vendor chargeback where the vendor failed; claim (9.7) if insured.
- Vendor fraud indicators (reused photos, impossible timestamps): reject, audit, vendor management.
- PFPIP vendor and servicer vendor both dispatched: reconcile via program data; cancel duplicate; no double claim.
- Transfer-out mid-preservation: open orders completed or handed over per transfer agreement; registration transfers/contact-change filings (ordinance trigger).
- Sale/REO: handoff; do not perform post-sale work unless Fannie Mae assigns (E-4.3).
- Disaster: FEMA/insurer access restrictions; document attempts; Fannie Mae disaster guidance.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 9.9-T1 | Given FTV 2027-03-05 Then initial securing/services due 2027-03-19; a 2027-03-16 completion satisfies; 2027-03-20 breaches with reason required. |
| 9.9-T2 | Given the worked scope Then total $1,250.00 all within allowables; no bid; work ordered same day. |
| 9.9-T3 | Given 25 CY debris discovered 2027-03-08 Then work stops at the allowable, bid due 2027-03-23, `human_portal_task` for HomeTracker created with photos ≤ 30 days old. |
| 9.9-T4 | Given 15 CY debris Then complete and BATF with before/after photos. |
| 9.9-T5 | Given grass at 40″ Then bid before work; at 20″ complete and BATF. |
| 9.9-T6 | Given a property in Hawaii Then winterization not ordered; in Minnesota in July Then winterization ordered (year-round rule). |
| 9.9-T7 | Given a city ordinance requiring vacant registration within 30 days and semi-annual renewal Then registration filed by the deadline, fee claimed at actual cost, renewal timer set. |
| 9.9-T8 | Given a tarp installed 2027-04-01 Then permanent repair or re-bid required by 2027-05-31. |
| 9.9-T9 | Given a PFPIP loan with "Do insp and preserv" Then mode `pfpip`; no servicer securing order; program activity monitored; occupancy/claim/HOA updates sent. |
| 9.9-T10 | Given an active Chapter 13 case Then preservation suspended pending `attorney` guidance; PFPIP permissions restricted. |
| 9.9-T11 | Given a Fannie Mae audit request on 2027-05-03 Then documents delivered by 2027-05-10. |

#### Audit and evidence
Vacancy certifications, FTV basis, scope/allowable computations, work orders, dated photos (hashed), invoices, bid packages and Fannie Mae decisions, registration filings and receipts, carrier notifications, jurisdiction rule versions, claim linkages; retention `life_of_loan_plus_4y`; the `allowable_matrix` is versioned with the Matrix/F-1-05 edition dates for exam traceability.

### Open questions / decisions
1. Division of labor on PFPIP loans — **default: Fannie Mae's vendor performs all inspection/preservation for loans submitted with full permissions; Supermortgage performs only emergency securing discovered outside program activity and registrations/code items not covered by the program** (confirm program scope for registrations with the PFPIP team).
2. Whether preservation costs are charged to borrowers on non-program loans — **default: no borrower charge until reinstatement/payoff quote, and only where the contract and state law permit; Fannie Mae reimbursement is the primary recovery**.
3. Vendor strategy — **default: one national vendor plus one regional backup**, both on the same work-order API.
4. `jurisdiction_rules` sourcing for ordinances — **default: vendor ordinance database with quarterly legal review**.

### Sources
- Property Preservation Matrix and Reference Guide (June 2025): https://singlefamily.fanniemae.com/media/document/pdf/property-maintenance-and-management-property-preservation-matrix-and-reference-guide — verified 2026-09-09
- Fannie Mae Pre-Foreclosure Property Preservation page: https://singlefamily.fanniemae.com/servicing/property-preservation — verified 2026-09-09
- Servicing Guide E-3.2-12 (07/14/2021): https://servicing-guide.fanniemae.com/svc/e-3.2-12/performing-property-preservation-during-foreclosure-proceedings — verified 2026-09-09
- Servicing Guide D2-2-10 (05/10/2023), F-1-05 (06/11/2025), B-5-01/B-5-02 — URLs above — verified 2026-09-09
- PFPIP job aid (June 2023) and Property 360 page — URLs in 9.8 — verified 2026-09-09
- research/00b-integration-landscape.md F5/F6/N13 — 2026-09-09
