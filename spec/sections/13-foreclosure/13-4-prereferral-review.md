# 13.4 — Prereferral review

| Attribute | Value |
|---|---|
| Section | 13 — Foreclosure |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | Before referral |
| Governing source | FNMA E-3.2-01 |
| Key deadlines | Before referral |
| Timers | `FNMA_D1301_DISASTER_FC_APPROVAL_GATE`, `FNMA_D1301_DISASTER_FC_REQUEST_5`, `FNMA_E1102_MORTGAGEE_OF_RECORD_ID_90`, `FNMA_E3201_PRECONDITIONS_GATE`, `FNMA_E3201_PREREFERRAL_REVIEW_15`, `FNMA_E3204_NONPR_EVAL_30`, `FNMA_E3204_NONPR_FIRST_PAYMENT_EOM`, `FNMA_E3204_NONPR_OFFER_14`, `FNMA_F108_MA_LEAD_PAINT_SEARCH_GATE`, `SM_DISASTER_FC_RESPONSE_FOLLOWUP_10BD`, `SM_DMDC_VERIFY_PRE_REFERRAL_30`, `SM_PREREFERRAL_RE_REVIEW_DAILY` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Foreclosure |
| Trigger & frequency | Before referral |
| Governing source (blueprint) | FNMA E-3.2-01 |
| Key deadlines (blueprint) | Before referral |
| Data/artifacts | Review |
| Systems | Core |
| Automation class (blueprint) | b |
| SoR / Sub | S[cropped in source] — read as Sub |
| Nuances (blueprint) | [cropped in source] — reconstructed below: review "within 15 days prior to the date the servicer is required to refer"; preconditions (breach letter and solicitation-package deadlines expired); QRPC procedures followed; no approved payment arrangement pending; complete BRP status; five principal-residence "must not refer" conditions; E-3.2-04 postponements for non-principal residences; E-3.1-02 occupancy/rental-income due diligence; LL-2026-01/D1-3-01 disaster prior-written-approval (5-day submission); SCRA/DMDC, bankruptcy, environmental, title and MI checks folded into the same evidence package |

### Verified requirement (as of 2026-09-09)

**E-3.2-01, Conducting Prereferral Review (07/14/2021, SVC-2021-04 — verified today).** Timing: the servicer must perform the review "within 15 days prior to the date the servicer is required to refer the mortgage loan to foreclosure." Preconditions: "the breach or acceleration letter and the Borrower Solicitation Package deadline must have expired without affirmative response from the borrower." For all loans the servicer must confirm that "all procedures relating to establishing QRPC as outlined in D2-2-01 ... were followed"; "an approved payment arrangement is not pending"; and "a complete BRP has not been received; or if a complete BRP has been received, the servicer has determined that either the borrower is not eligible for a workout option or the servicer has extended an offer for a workout option and the borrower has not accepted the offer within the required time frame." "The servicer must not delay referral to foreclosure if the time frame for the borrower to respond to an offer for a workout option has expired." Principal residence — the servicer must **not** refer if: "there is an approved payment arrangement for a workout option"; "a complete BRP has been received and the servicer is within the 30-day time period for evaluating the complete BRP"; "the servicer has extended an offer for a workout option ... and the borrower's response time period has not expired"; "the borrower has accepted an offer for a workout option and is performing in accordance with its terms"; or "the time period for the borrower to exercise any right of appeal ... has not expired." Procedures are in F-1-08 (which, as retrieved today, contains only environmental-hazard, HomeTracker preservation, auction-services and third-party-sale procedures — the Guide contains no separate prereferral checklist form).

**E-3.2-04, Postponing Foreclosure Referral for Mortgage Loans Not Secured by a Principal Residence (08/17/2016 — verified today).** "The servicer may postpone foreclosure referral of property not secured by a principal residence beyond the 120th day of delinquency upon receipt of a complete BRP": "must delay the foreclosure referral up to 30 days to complete an evaluation"; retention offer (incl. Trial Period Plan) — "must delay the foreclosure referral up to 14 days to allow the borrower to respond"; acceptance (verbal, written incl. email, or payment) within 14 days — "must delay the foreclosure referral until the last day of the month in which the first payment is due"; first TPP/repayment/forbearance payment received — "must delay the foreclosure referral until the borrower breaches"; "Verbal or written acceptance, without payment or execution of required documents, serves only to postpone foreclosure referral"; "The servicer must not postpone foreclosure referral due to the review of a borrower inquiry."

**E-3.1-02, Performing Due Diligence Prior to Considering Foreclosure (11/12/2014 — verified today).** "Inspect the property and analyze the individual circumstances of the delinquency"; "Diligently investigate mortgage loans originated as investment properties and attempt to determine whether or not the borrower is collecting rental income"; if tenant occupancy is suspected "take appropriate action to ascertain the actual occupancy status," including "detailed property inspections and conducting skip tracing"; after referral, promptly notify the firm of changes in occupancy, rental income, tenant and lease information.

**E-3.2-02 (11/12/2014):** expedited foreclosure (abandonment, written disclaimer/consent, unapplied rental income) "upon expiration of the breach letter ... to the greatest extent allowable under applicable law (and without exploring workout options)" — subject to 13.1 for principal residences and to "provided the borrower is not eligible for relief from foreclosure in accordance with D2-3.4-01, Military Indulgence."

**Disaster — D1-3-01 (04/08/2026; LL-2026-01 eff. May 1, 2026 — verified today).** "If the servicer determines a disaster event has impacted the borrower's property, it must obtain prior written approval from Fannie Mae before referring the mortgage loan to foreclosure, initiating any judicial or non-judicial foreclosure process, moving for a foreclosure judgement or order of sale, or executing a foreclosure sale, if such delays are permitted under applicable law." Submit "within five days after completing the prereferral review" (not yet referred) or "within five days after determining a disaster event has impacted the borrower's property" (already referred), with: the recommendation "to initiate or continue foreclosure proceedings" (and referral date if applicable), the disaster event date, "status of any repairs to the property," "Insurance loss claim date, status, and the amount of proceeds," and a "summary of any engagement with the borrower, including whether Quality Right Contact (QRPC) has been achieved" and the borrower's intent for the property. Channel: hazard_loss@fanniemae.com (F-4-02, 05/13/2026: "Request prior approval for foreclosure referral on disaster-impacted properties"). Neither the LL nor D1-3-01 defines "disaster-impacted" beyond the servicer's determination, nor a Fannie Mae response SLA **[policy gap — see decisions]**.

**Other checks that belong in the same review (sources in 13.3/13.8/13.7/14.x):** military status ("must attempt to ascertain the military status of the mortgagor(s) before initiating foreclosure proceedings," D2-3.4-01); bankruptcy scrub (E-2.1-02; PACER/vendor); environmental hazards ("must not begin foreclosure proceedings ... if it becomes aware of environmental hazards," F-1-08) and the Massachusetts lead-paint citation search; title/mortgagee-of-record by day 90 and custodian request by day 95 (E-1.1-02); MI notice-of-default status (Section 10; MI master policies require NOD by the 2nd–3rd missed payment — research/00b N7); hazard-insurance status and open claims (9.x); HOA super-lien exposure (E-3.2-10; Section 3/9); PFPIP submission at 90 days (11.x; research/00b F5); occupancy/vacancy (D2-2-10; E-3.1-02); Reg X 1024.41(f)(1)/(f)(2) and state gates (13.1); Fannie Mae E-1.2-02 referral window.

**Discrepancies with the blueprint row.** (1) The row's "Before referral" hides the Guide's specific window ("within 15 days prior to the date the servicer is required to refer") and the preconditions. (2) The disaster prior-written-approval requirement (May 1, 2026) and its 5-day submission rule post-date the blueprint's sources. (3) The five principal-residence prohibitions and the E-3.2-04 non-principal-residence postponement ladder are absent. (4) There is no Fannie Mae "review form"; the artifact is the servicer's documented review — built here as a machine-checked evidence package.

### Operational prerequisites
- Section 11 outputs with evidence: breach/acceleration letter (`notice.breach.sent{expires_on}`), Borrower Solicitation Package (`notice.solicitation.sent{respond_by}`), QRPC attempt log (D2-2-01/-02) and status code AW/H5 history.
- Section 12 exposing BRP completeness, evaluation clock, offers/response windows, acceptance/performance, appeal windows.
- DMDC account and batch/single-record process (13.8); bankruptcy scrub vendor (14.1); PFPIP enrolment (11.x); MI default-reporting feeds (10.x).
- `jurisdiction_rules.foreclosure` incl. `ma_lead_paint_citation_search=true` for Massachusetts; environmental-hazard indicators from inspections (11.x) and code-violation feeds.
- Disaster registry (`disaster_events` from FEMA declarations + property geocode, 11.x/9.x) with `disaster.impact.determined` logic and the hazard_loss@ mailbox integration (email adapter with tracked message ids).
- Partner sign-off on the review checklist version and on who may send disaster approval requests (default: `foreclosure-ops` agent under Supermortgage's name on the partner's behalf; `officer` copied).

### Build spec
#### Inputs and triggers
- Scheduler: `prereferral.review.due` fired at `referral_required_on − 15 calendar days`, where `referral_required_on` = earliest unpaid due date + 120 days (non-principal residence) or + 121 days (principal residence; the "required" date is the first permissible date under E-1.2-02 — decision 13.4-1), also re-fired whenever an input changes inside the window (payment, BRP, offer, bankruptcy, SCRA, disaster).
- Inputs read: 11.x notices/contacts, 12.x case state, 14.x bankruptcy status, 13.8 DMDC results, 9.x insurance/claims, 10.x MI NOD status, 11.x inspections/PFPIP, 13.3 assignment/note readiness, 13.1/13.2 gate evaluations, `disaster_events` overlay, environmental indicators, title status.
- Outputs feed 13.3 (`prereferral.review.completed{outcome}`) and 13.5 (timeline start).

#### Data model
- `prereferral_reviews` (new; one row per attempt, append-only): `id`, `loan_id`, `case_id` (foreclosure case in `prereferral`), `window_opens_on`, `referral_required_on`, `started_at`, `completed_at`, `outcome` ∈ {refer, refer_expedited, hold_lossmit, hold_bankruptcy, hold_scra, hold_disaster_approval, hold_environmental, hold_title, hold_litigation, hold_occupancy_unresolved, postpone_e3204, not_eligible_other}, `checklist jsonb` (array of `{item_code, result ∈ {pass, fail, n_a}, evidence_ids[], evaluated_at, evaluator ∈ {rule, model, human}}`), `evidence_package_document_id`, `decision_id`, `reviewer_role?`.
- `disaster_fc_approval_requests` (new): `id`, `loan_id`, `case_id`, `kind` ∈ {initiate, continue}, `submitted_at`, `channel` (email:hazard_loss), `message_id`, `payload jsonb` (recommendation, disaster date, repair status, claim date/status/proceeds, engagement summary, QRPC, borrower intent, referral date), `fnma_response` ∈ {pending, approved, denied, info_requested}, `responded_at?`, `response_document_id?`, `decision_id`.
- Checklist item codes (seed): `BREACH_EXPIRED`, `SOLICITATION_EXPIRED`, `QRPC_PROCEDURES_FOLLOWED`, `NO_PAYMENT_ARRANGEMENT_PENDING`, `BRP_STATUS_CLEAR`, `PR_NO_APPROVED_ARRANGEMENT`, `PR_NOT_IN_30_DAY_EVAL`, `PR_NO_OPEN_OFFER_WINDOW`, `PR_NOT_PERFORMING_ON_ACCEPTED_OFFER`, `PR_NO_OPEN_APPEAL`, `REGX_120_GATE`, `REGX_F2_GATE`, `REGX_K2_GATE`, `STATE_GATES`, `SCRA_DMDC_CURRENT`, `BK_SCRUB_CLEAR`, `DISASTER_CHECK`, `ENVIRONMENTAL_CLEAR`, `MA_LEAD_PAINT_SEARCH`, `TITLE_MORTGAGEE_OF_RECORD`, `CUSTODIAN_DOCS_REQUESTED`, `ASSIGNMENT_STATUS`, `OCCUPANCY_VERIFIED`, `RENTAL_INCOME_INVESTIGATED`, `PFPIP_SUBMITTED`, `MI_NOD_REPORTED`, `HAZARD_INSURANCE_IN_FORCE`, `OPEN_INSURANCE_CLAIM`, `HOA_STATUS`, `SII_STATUS`, `LITIGATION_HOLD`, `TRANSFER_WINDOW` (1.3), `EXPEDITE_CONDITION` (E-3.2-02).
- Retention `life_of_loan_plus_4y`; evidence package is a `documents` bundle with SHA-256 per item.

#### State machine
`prereferral_reviews`: `scheduled` → `in_progress` (window open) → `completed{outcome}`; `completed{refer}` → consumed by `foreclosure.refer` (13.3) within the policy SLA; `completed{hold_*}` → `re_review_scheduled` (on the hold's release event or daily while the hold persists) → `in_progress`; `completed{postpone_e3204}` (non-principal residence) → timers per the E-3.2-04 ladder → `in_progress` at ladder expiry/breach. Terminal: superseded by a referral, cure, workout completion, payoff, charge-off or transfer-out. Only the agent (rules + model for evidence extraction) and, on escalation, a `human_agent` verify items; nobody can mark a `fail` as `pass` without new evidence.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_E3201_PREREFERRAL_REVIEW_15` | deadline window | delinquency reaches `referral_required_on − 15` | `referral_required_on` | window [−15, 0] calendar_days; must complete before referral | `prereferral.review.completed` | sev 1; referral refused without a completed review inside the window |
| `FNMA_E3201_PRECONDITIONS_GATE` | not_before_gate | review start | — | breach letter expiry ∧ solicitation deadline expiry | 11.x events | review outcome `hold_lossmit` |
| `FNMA_E3204_NONPR_EVAL_30` | deadline (postponement) | `lossmit.application.completed` (non-principal residence) | receipt | +30 calendar_days | `lossmit.determination.sent` | referral deadline resumes |
| `FNMA_E3204_NONPR_OFFER_14` | deadline (postponement) | `lossmit.offer.sent{retention}` | offer date | +14 calendar_days | acceptance / expiry | referral resumes on expiry |
| `FNMA_E3204_NONPR_FIRST_PAYMENT_EOM` | deadline (postponement) | `lossmit.offer.accepted` | first payment due date | end of that month | first payment received → `hold_performing` | referral resumes the next day if unpaid |
| `FNMA_D1301_DISASTER_FC_REQUEST_5` | deadline | `prereferral.review.completed{disaster_impacted=true}` (or `disaster.impact.determined` after referral) | completion / determination | +5 calendar_days (Guide says "five days"; treat as calendar — decision 13.4-3) | `disaster_fc_approval_requests.submitted` | sev 1 |
| `FNMA_D1301_DISASTER_FC_APPROVAL_GATE` | not_before_gate (13.1) | `disaster.impact.determined` | — | until `fnma.disaster_fc.approved` | approval | refer/first-notice/judgment/sale refused |
| `SM_DISASTER_FC_RESPONSE_FOLLOWUP_10BD` | deadline (policy) | `disaster_fc_approval_requests.submitted` | submitted_at | +10 business_days_fannie_et | Fannie Mae response recorded | follow-up email + Servicing Representative call task |
| `SM_DMDC_VERIFY_PRE_REFERRAL_30` | not_before_gate (13.8) | review start | latest DMDC certificate date | certificate ≤30 calendar_days old at referral | `scra.status.verified` | refused |
| `FNMA_F108_MA_LEAD_PAINT_SEARCH_GATE` | not_before_gate | review start (MA) | — | citation search completed | `environmental.ma_citation_search.completed` | refused (MA) |
| `FNMA_E1102_MORTGAGEE_OF_RECORD_ID_90` / `FNMA_E1102_CUSTODIAN_DOC_REQUEST_95` | deadline (13.3) | — | — | — | — | checklist items |
| `SM_PREREFERRAL_RE_REVIEW_DAILY` | recurring | any `hold_*` outcome | — | daily 00:05 loan tz until release | outcome changes | — |

#### Business rules and calculations
1. **Window arithmetic.** Non-principal residence: `referral_required_on = D + 120`, window opens `D + 105` (D = earliest unpaid due date). Principal residence: `referral_required_on = D + 121` (first permissible day), window opens `D + 106`. Example: D = Mar. 1, 2026 → non-PR window June 14–29 (refer by June 29); PR window June 15–30 (refer no earlier than June 30). A review completed before the window (e.g., day 100) is not valid for referral; it must be re-run inside the window (inputs may have changed).
2. **Outcome logic (deterministic).** `refer` iff every mandatory item is `pass` or `n_a` and every gate for step `refer` is open. Any principal-residence prohibition item failing ⇒ `hold_lossmit`. Disaster-impacted ⇒ outcome `hold_disaster_approval` with the request generated in the same run (the review is "complete" for the 5-day clock even though referral is held). Non-principal residence with a complete BRP received ⇒ `postpone_e3204` with the ladder timers; an inquiry (not a BRP) never postpones.
3. **Expedited path** (E-3.2-02): if `EXPEDITE_CONDITION` is evidenced (abandonment confirmed by two inspections + utilities off + mail return; written disclaimer/consent; unapplied rental income with no arrangement), the review may skip the solicitation-expiry precondition ("without exploring workout options") but never skips Reg X gates for a principal residence, SCRA, bankruptcy, disaster or environmental checks.
4. **Disaster impact determination**: `disaster_events` (FEMA declaration with Individual Assistance for the property's county on/after the loan's delinquency or within the disaster look-back — 11.x rule) ∧ any of: inspection damage, borrower report, insurance claim, forbearance reason code disaster ⇒ `disaster_impacted=true`. Unknown damage in a declared county ⇒ order an inspection before concluding (policy) and set `hold_disaster_approval` if not resolved by the window end.
5. **Occupancy**: `OCCUPANCY_VERIFIED` requires an inspection ≤30 days old or borrower confirmation; investment property ⇒ `RENTAL_INCOME_INVESTIGATED` (tenant contact/lease/skip-trace evidence).
6. **Evidence package** = rendered PDF + JSON of the checklist with links/hashes to each evidence document (breach letter + proof of mailing, solicitation package + tracking, contact log excerpt, BRP timeline, DMDC certificate ids, bankruptcy scrub receipt, inspection report, title/assignment status, MI NOD confirmation, insurance status, disaster determination, gate snapshot). No money computation beyond reinstatement figure (13.3 rule 4) included for the firm.

#### Integrations
- **DMDC** (`dmdc`, portal/batch — research/00b N4): single-record request per borrower/co-borrower at window start (portal-only → `human_portal_task{kind=dmdc_batch}` for the daily batch; certificate PDFs stored); results parsed into `scra_verifications` (13.8).
- **Bankruptcy monitor** (`pacer/bk-monitor`): scrub by name/SSN; result stored; hit ⇒ 14.x.
- **Fannie Mae hazard_loss@ mailbox** (email adapter): disaster request as a structured email + PDF; tracked `message_id`; replies parsed into `fnma_response` (model-assisted; human confirm if ambiguous); no portal involved.
- **Property 360** (`fnma-p360`): PFPIP status read (11.x); inspection results via Property Preservation Loan Search API where enabled, else portal read by `fnma_portal_operator`.
- **MI** (`mi/*`): NOD acknowledgment status (10.x).
- Failure modes: DMDC unavailable ⇒ review outcome `hold_scra` (never refer without a current certificate); mailbox bounce ⇒ resend + Servicing Representative call task.

#### Outputs and artifacts
- Events: `prereferral.review.started/completed{outcome}`, `prereferral.hold.opened/released{kind}`, `disaster_fc_approval.requested/approved/denied/info_requested`, `occupancy.verified`, `environmental.hazard.suspected` (→ 13.7).
- Documents: `DOC_PREREFERRAL_REVIEW_<id>` (evidence package); `DOC_DISASTER_FC_REQUEST` (email body + attachments: recommendation, dates, claim status, QRPC summary).
- Notices: none required by the Guide; the 11.x solicitation and breach letters are the borrower-facing prerequisites. Optional courtesy "final opportunity" letter — not built (avoids implying a new cure period that could reset state clocks; decision 13.4-4).
- Investor events: status code 43 only on referral (13.3); disaster reason code and forbearance codes via 5.4; "Referred to Foreclosure"/solicitation action types under LL-2026-05 (5.4).
- Ledger: inspection/skip-trace costs → `corporate_advances` (reimbursable per F-1-05 limits).

#### AI agent design (AI-first)
`foreclosure-ops` performs the review end-to-end: deterministic checks for every item with structured inputs; the model reads unstructured evidence (inspection narratives, borrower correspondence, emails from Fannie Mae, code-violation notices) into item results with citations and a confidence score, and drafts the disaster recommendation narrative. Tools: `lossmit.case.get`, `contacts.search`, `notices.search`, `inspection.get`, `dmdc.verify` (queue), `bk.scrub`, `title.status.get`, `custodian.request`, `mi.status.get`, `insurance.status.get`, `disaster.lookup`, `email.send{fnma_hazard_loss}`, `documents.bundle`, `escalation.create`. Decision record: `{review_id, loan_id, window, items[{code, result, evidence_ids, evaluator, confidence}], outcome, gates_snapshot, disaster{impacted, request_id}, rationale, model_version, prompt_version, rule_set_version}`. Guardrails: an item may be `pass` only with attached evidence; model-evaluated items with confidence < 0.85 route to `human_agent` verification; the agent never sends a disaster request recommending foreclosure where QRPC was never achieved unless the outreach log shows the D2-2-02 cadence was met (Fannie Mae will ask). Escalations: `human_agent` (occupancy/evidence ambiguity), `attorney` (title/standing questions, environmental litigation), `officer` (Fannie Mae denial of a disaster request that the partner wishes to contest; expedited path on a principal residence), `fnma_portal_operator` (DMDC batch, P360 reads). Disclosure: none borrower-facing in this process. AI-off path: checklist rendered in the ops console for a `human_agent` to complete with the same evidence rules.

#### Edge cases and failure modes
- BRP received the day after the review completes but before referral: review invalidated (`SM_PREREFERRAL_RE_REVIEW_DAILY`), outcome recomputed; referral refused by 13.1's (f)(2) gate anyway.
- Fannie Mae's disaster response never arrives: gate stays closed; 13.5 delay credit requires status-code accuracy (report the correct reason code; no dedicated "awaiting disaster approval" code exists — decision 13.4-5).
- Fannie Mae denies referral: outcome `hold_disaster_approval{denied}`; re-request when repairs/claims progress; forbearance/deferral per 12.x.
- Loan already referred when the disaster hits: request within 5 days of determination; instruct the firm to hold judgment/sale (13.2 hold `disaster_approval`).
- Co-borrower on active duty but not the occupant: still protected (13.8) — review holds.
- Successor in interest not yet confirmed: `SII_STATUS` fails if a pending request exists (4.4) — hold until confirmation/denial (policy).
- Transfer-in inside the window: transferor's breach/solicitation evidence accepted if in the file; otherwise re-send (1.3) and shift the window.
- Vendor outage (DMDC/PACER): hold; never refer on stale data.
- Non-principal residence with "borrower inquiry" only: no postponement; referral by day 120.

#### Test cases and acceptance criteria
- 13.4-T1 Given D = Mar. 1, 2026 and a non-principal residence, Then the review window is June 14–29; a review completed June 10 is rejected for referral; one completed June 20 with all passes yields `refer`.
- 13.4-T2 Given a principal residence with an offer response window open until day 125, Then outcome `hold_lossmit`; on expiry without acceptance, re-review → `refer` (no delay beyond expiry per E-3.2-01).
- 13.4-T3 Given a complete BRP on day 119 for a non-principal residence, Then `postpone_e3204`; determination on day 140 (offer sent, 14-day window) → acceptance day 150 → first payment due Aug. 1 → referral held until Aug. 31 if unpaid; paid → held until breach.
- 13.4-T4 Given a FEMA IA declaration and inspection damage, Then outcome `hold_disaster_approval`, request emailed within 5 days with all five content elements, gate closed until approval; approval → `refer`.
- 13.4-T5 Given DMDC shows active duty, Then `hold_scra`; the referral command is refused even if all other items pass.
- 13.4-T6 Given MA property without the lead-paint citation search, Then refused; with search evidence, passes.
- 13.4-T7 Given an abandoned property (two vacant inspections, utilities off) on a non-principal residence at day 70, Then expedited outcome permitted at breach-letter expiry; on a principal residence the Reg X gate still blocks until day 121.
- 13.4-T8 Given a model-evaluated occupancy item with confidence 0.7, Then `human_agent` verification task; review cannot complete until resolved.
- 13.4-T9 Given a pending successor-in-interest request, Then `SII_STATUS` fails and the review holds.
- 13.4-T10 Given a bankruptcy hit in the scrub, Then `hold_bankruptcy` and 14.x case opened.

#### Audit and evidence
The evidence package (with item-level evidence hashes and evaluator/confidence), the decision record, the gate snapshot, the disaster request email (message id, attachments, Fannie Mae reply) and the timer history are appended to the foreclosure file; the Compliance Sentinel daily report lists reviews completed outside the window, holds older than 30 days, and disaster requests without a response after 10 BD.

### Open questions / decisions
1. "Date the servicer is required to refer" for principal residences (no Guide "must refer by") — default: the first permissible day (D+121) anchors the 15-day window; a later internal target is tracked by `SM_FC_REFER_WITHIN_5CD_OF_ELIGIBLE`.
2. Who signs the disaster approval request — default: the `foreclosure-ops` agent sends under Supermortgage's name "on behalf of [partner], servicer no. …"; `officer` copied; partner may require its own signature (contract).
3. "Five days" in D1-3-01 — default: calendar days.
4. Courtesy "final opportunity" letter before referral — default: not sent.
5. Status code while awaiting Fannie Mae's disaster response — default: report the underlying condition (09 forbearance / 12 plan / AW / H5 as applicable) and document the hold in the file; confirm with the Servicing Representative whether a delay credit will be honoured.

### Sources
- E-3.2-01 (07/14/2021): https://servicing-guide.fanniemae.com/svc/e-3.2-01/conducting-prereferral-review — verified 2026-09-09.
- E-3.2-04 (08/17/2016): https://servicing-guide.fanniemae.com/svc/e-3.2-04/postponing-foreclosure-referral-mortgage-loans-not-secured-principal-residence — verified 2026-09-09.
- E-3.1-02 (11/12/2014): https://servicing-guide.fanniemae.com/svc/e-3.1-02/performing-due-diligence-prior-considering-foreclosure — verified 2026-09-09.
- E-3.2-02 (11/12/2014): https://servicing-guide.fanniemae.com/svc/e-3.2-02/initiating-foreclosure-proceedings-first-lien-conventional-mortgage-loan — verified 2026-09-09.
- D1-3-01 (04/08/2026): https://servicing-guide.fanniemae.com/svc/d1-3-01/evaluating-impact-disaster-event-and-assisting-borrower ; LL-2026-01 (Feb. 11, 2026; eff. May 1, 2026): https://singlefamily.fanniemae.com/media/document/pdf/lender-letter-ll-2026-01-updates-retention-workout-options-and-disaster-related-foreclosure ; F-4-02 (05/13/2026): https://servicing-guide.fanniemae.com/svc/f-4-02/list-contacts — verified 2026-09-09.
- F-1-08 (05/10/2023): https://servicing-guide.fanniemae.com/svc/f-1-08/managing-foreclosure-proceedings ; D2-3.4-01 (06/13/2018): https://servicing-guide.fanniemae.com/svc/d2-3.4-01/military-indulgence — verified 2026-09-09.
