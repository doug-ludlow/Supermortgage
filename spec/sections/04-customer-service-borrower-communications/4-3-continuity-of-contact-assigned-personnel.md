# 4.3 — Continuity of contact / assigned personnel

| Attribute | Value |
|---|---|
| Section | 4 — Customer Service & Borrower Communications |
| Automation class | c |
| SoR / Sub | Sub |
| Trigger & frequency | On delinquency (each delinquency episode; continuous availability thereafter) |
| Governing source | Reg X 1024.40(a) |
| Key deadlines | Assign personnel by written-EI-notice date, in any event by 45th day of delinquency |
| Timers | `CA_CIV_2923_7_SPOC_ASSIGN_PROMPT`, `CA_CIV_2923_7_SPOC_UNTIL_EXHAUSTED_OR_CURRENT`, `FNMA_A4_2_1_04_CALL_METRICS_MONTHLY`, `FNMA_A4_2_1_04_CHAT_5MIN`, `FNMA_A4_2_1_04_EMAIL_48H`, `REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE`, `REGX_1024_40A1_CONTACT_ASSIGN_45`, `REGX_1024_40A2_AVAILABILITY_UNTIL_RELEASE`, `REGX_1024_40A2_RELEASE_2_PERMANENT_PAYMENTS`, `REGX_1024_40A3_LIVE_RESPONSE_1BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Customer Service |
| Trigger & frequency | On delinquency (each delinquency episode; continuous availability thereafter) |
| Governing source (blueprint) | Reg X 1024.40(a) |
| Key deadlines (blueprint) | Assign personnel by written-EI-notice date, in any event by 45th day of delinquency |
| Data/artifacts | Contact log |
| Systems | Telephony |
| Automation class (blueprint) | c (live agent) |
| SoR / Sub | Sub |
| Nuances (blueprint) | (blank in source) |

### Verified requirement (as of 2026-09-09)

**Source verified:** 12 CFR 1024.40 (eCFR, current as of Aug. 20, 2026; source 78 FR 10876, unchanged since 2013); Supplement I comments 40(a)-1 (Delinquent borrower), 40(a)-2 (Assignment of personnel), 40(a)-3 (Delinquency) — the only comments under §1024.40; 12 CFR 1024.30(c)(2) (§§1024.39–.41 apply only to loans secured by the borrower's principal residence) and 1024.30(b) (small-servicer/reverse/qualified-lender exemptions — not applicable); Cal. Civ. Code §2923.7 (2025 code, as amended by Stats. 2025, ch. 200, effective Jan. 1, 2026); Fannie Mae A4-2.1-04 (12/16/2015), D2-2-01 (11/14/2018), D2-2-02 (11/14/2018).

**§1024.40(a) — objectives the servicer's policies and procedures must be "reasonably designed to achieve":** (1) "Assign personnel to a delinquent borrower by the time the servicer provides the written notice required by §1024.39(b), but in any event, not later than the 45th day of the borrower's delinquency"; (2) "Make available to a delinquent borrower, via telephone, personnel assigned to the borrower … to respond to the borrower's inquiries, and as applicable, assist the borrower with available loss mitigation options until the borrower has made, without incurring a late charge, two consecutive mortgage payments in accordance with the terms of a permanent loss mitigation agreement"; (3) "If a borrower contacts the personnel assigned … and does not immediately receive a live response from such personnel, ensure that the servicer can provide a live response in a timely manner."

**§1024.40(b) — functions the assigned personnel must be able to perform:** (1) provide the borrower with accurate information about (i) loss-mitigation options available from the owner or assignee, (ii) the actions the borrower must take to be evaluated, including how to complete an application or appeal, (iii) the status of any loss-mitigation application, (iv) "the circumstances under which the servicer may make a referral to foreclosure," and (v) applicable loss-mitigation deadlines; (2) "timely retrieve" a complete record of the borrower's payment history and all written information the borrower provided to the servicer "and if applicable, to prior servicers" in connection with a loss-mitigation application; (3) provide those documents and information "to other persons required to evaluate a borrower for loss mitigation options."

**Commentary.** 40(a)-1: a borrower is no longer delinquent (and the obligation ends) once the loan is refinanced, paid off, brought current, or title has transferred by deed-in-lieu, sale or foreclosure; "borrower" for loss-mitigation assistance includes an authorized agent, and the servicer may require documentation of authority. 40(a)-2: "A servicer has discretion to determine whether to assign a single person or a team of personnel"; personnel may be "single-purpose" (primary responsibility is delinquent-borrower inquiries/loss mitigation) or "multi-purpose"; bankruptcy specialists may be assigned when the borrower files. 40(a)-3: delinquency per §1024.31 (the platform's `regx_days_delinquent`). No comment defines "timely" for (a)(3) or "timely retrieve" for (b)(2); no CFPB guidance addresses automated personnel (00a §1.4). The 2024 NPRM proposed no substantive §1024.40 changes (00a §1.2 item 8). §1024.40 is a policies-and-procedures rule; unlike §§1024.35/.36/.41 it carries no express RESPA §6(f) hook (§1024.41(a) is the only subpart-C section that says a borrower may enforce it), but UDAAP, state law and Fannie Mae contract remedies apply.

**California Civil Code §2923.7 (single point of contact).** (a) "Upon request from a borrower who requests a foreclosure prevention alternative, the mortgage servicer shall promptly establish a single point of contact and provide to the borrower one or more direct means of communication"; (b) the SPOC is responsible for (1) communicating the application process, (2) coordinating receipt of all documents and notifying the borrower of missing documents, (3) "having access to current information and personnel sufficient to timely, accurately, and adequately inform the borrower of the current status," (4) ensuring the borrower is considered for all foreclosure-prevention alternatives offered by or through the servicer, and (5) "having access to individuals with the ability and authority to stop foreclosure proceedings when necessary"; (c) the SPOC "shall remain assigned to the borrower's account until the mortgage servicer determines that all loss mitigation options offered by, or through, the mortgage servicer have been exhausted or the borrower's account becomes current"; (d) the servicer must ensure the SPOC refers the borrower to a supervisor on request, if available; (e) "'single point of contact' means an individual or team of personnel each of whom has the ability and authority to perform the responsibilities described in subdivisions (b) to (d)," and the servicer must ensure each team member is knowledgeable about the borrower's situation and current status; (f) applies only to loans described in §2924.15 (first lien, owner-occupied principal residence, 1–4 units); (g) exemptions for entities foreclosing on ≤175 California properties or servicing ≤7 California loans annually — Supermortgage should assume it is not exempt (thresholds apply to the servicer's own activity **[UNVERIFIED whether counted at subservicer or master level]**).

**Fannie Mae.** No single-point-of-contact mandate exists in the current Guide (D2-2-01 QRPC speaks of communicating with "the borrower, co-borrower, or a trusted advisor"; the blueprint's "SPOC expectations in D2-2-01" are **not present** in the 11/14/2018 topic). A4-2.1-04 sets contact-center metrics: average speed of answer ≤60 seconds, monthly call blockage ≤1%, abandonment ≤5%, live chat initiated ≤5 minutes, email answered within 48 hours; foreclosure-prevention staff "must be available during inbound and outbound collection activity unless collections staff are also well-versed in workout options"; contact attempts must vary days/times and include evenings/weekends; every attempt is documented in the loan file. D2-2-02 governs outbound cadence (11.1/11.3).

**Discrepancies vs. blueprint row.** (1) The rule is scoped to principal-residence loans (§1024.30(c)(2)) — the row's "on delinquency" trigger must be gated on occupancy. (2) Assignment persists until two consecutive on-time payments under a *permanent* loss-mitigation agreement (or the delinquency ends per comment 40(a)-1) — the row has no release rule. (3) The row omits (a)(3) timely live response and the (b) functions, which are the substantive test. (4) Automation class "c (live agent)" is re-rated: the rule requires "personnel," which is the open legal question analyzed below; the recommended default is AI-first with a named human of record.

### Operational prerequisites
- **Human personnel roster** (Supermortgage; before first delinquent loan): `personnel` records for every human who can be assigned (name, role, licensing per state — MLO-type licensing where a state treats modification negotiation as licensed activity (baseline §8 item 7), languages, schedule); at least one `contact_team` per region/time zone with coverage 8 a.m.–8 p.m. borrower-local time, Monday–Saturday (policy), and after-hours voicemail with next-business-day callback.
- **Telephony** (00b telephony/voice adapter; 6–8 weeks): direct-dial/extension routing to the assigned team, queue callbacks, recording, IVR disclosure scripts, warm-transfer to `human_agent`, ASA/abandonment/blockage reporting for A4-2.1-04.
- **TCPA consent ledger** (`consents.tcpa_voice`, `tcpa_sms`) for outbound AI voice/SMS (00a §1.4); revocation handling.
- **Written legal opinion + partner sign-off** on the AI-as-personnel model (baseline §8; open decision 4.3-Q1) before `continuity.ai_only` may be enabled anywhere; a California-specific opinion on §2923.7(e) before any AI-only SPOC in CA.
- **Early-intervention templates** (11.2) carry the assigned-contact block (name/team, direct number, hours) — the §1024.40(a)(1) "by the time" test is satisfied by construction.
- **LL-2026-04 inventory entries** for `borrower-comms` continuity mode, with evaluation suites covering the (b)(1)(i)–(v) fact accuracy.

### Build spec
#### Inputs and triggers
- `loan.delinquency.started` (first day `regx_days_delinquent = 1`) — opens a `continuity_episode` if `properties.occupancy = principal_residence`.
- `notice.early_intervention_written.requested` (11.2) — the send command asserts an active assignment.
- `loan.delinquency.day_reached` with day 45 — hard deadline.
- Borrower actions: `contact.inbound` to the assigned line, `lossmit.assistance.requested` (CA §2923.7(a) trigger; also NPRM "request for loss mitigation assistance"), `borrower.human_requested`, `borrower.supervisor_requested` (CA (d)).
- Release triggers: `payment.received` sequences under `lossmit.permanent_agreement.effective`; `loan.paid_in_full`, `loan.refinanced`, `loan.current`, `title.transferred` (DIL/sale/foreclosure).
- `bankruptcy.filed` → optional reassignment to bankruptcy-specialist personnel (comment 40(a)-2).

#### Data model
- `personnel` — `id`, `kind` ∈ {human, ai_agent}, `display_name`, `employee_id`, `licenses jsonb` (state → license type/number), `languages text[]`, `time_zone`, `active bool`.
- `contact_teams` — `id`, `name`, `members uuid[]` (personnel), `direct_number`, `hours jsonb`, `states_served text[]`, `bankruptcy_specialist bool`.
- `continuity_episodes` — `id`, `loan_id`, `started_at` (delinquency day 1 date), `assignment_due_at` (day 45), `assigned_at`, `assignment_mode` ∈ {ai_first_named_human, human_team, human_individual, ai_only}, `team_id`, `named_human_id` (mandatory unless `ai_only`), `ca_spoc_required bool`, `ca_spoc_assigned_at`, `released_at`, `release_reason` ∈ {two_consecutive_permanent_payments, current, paid_off, refinanced, title_transferred, transfer_out}, `permanent_agreement_id`, `consecutive_on_time_payments int`.
- `callback_requests` — `episode_id`, `requested_at`, `channel`, `due_at` (policy 1 servicer BD), `completed_contact_id`.
- `contacts` (baseline) — add `episode_id`, `assigned_personnel_id`, `disclosure_given bool`, `human_transfer_requested bool`, `human_transfer_completed_at`.
- `lossmit_facts` view — the (b)(1) facts per loan: available options (from `rule_sets.fnma.workout_hierarchy`), required actions/missing documents (12.1/12.2), application status, foreclosure-referral circumstances (13.1–13.3 gates and dates), deadlines (12.x timers). Materialized from the same tables the loss-mit agent uses so the information the personnel give is by construction the system of record.
- Retention: `regx_1y_post_transfer` minimum, elevated to `life_of_loan_plus_4y` (Fannie Mae contact documentation, A4-2.1-04).

#### State machine
`not_required (non-principal-residence) | pending_assignment → assigned → (ca_spoc_assigned)? → released`; sub-state on `assigned`: `ai_first` ↔ `human_engaged` (toggled by a human request or a policy trigger) — the assignment of record does not change when the sub-state toggles. Guards: `pending_assignment → assigned` requires `named_human_id` (unless `ai_only` is enabled for the jurisdiction) and a reachable `direct_number`; `assigned → released` only on a release trigger; re-delinquency after release starts a new episode (reassign the same team where possible for continuity). Transfer-out ends the episode with reason `transfer_out` and the assignment appears in the transfer file (17.3).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_40A1_CONTACT_ASSIGN_45` | deadline | `loan.delinquency.started` (principal residence) | delinquency day 1 | day 45 = day-1 date + 44 `calendar_days` (23:59 loan-local) | `continuity.assigned` | auto-assign default team immediately; `officer` sev-2 |
| `REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE` | not_before_gate | `notice.early_intervention_written.requested` | — | — | `continuity.assigned` exists | 11.2 send command blocks until assignment (auto-assign then send) |
| `REGX_1024_40A2_AVAILABILITY_UNTIL_RELEASE` | recurring (daily check) | `continuity.assigned` | — | daily | active team with staffed hours | `officer` sev-2 if team inactive/unreachable |
| `REGX_1024_40A3_LIVE_RESPONSE_1BD` | deadline (policy interpretation of "timely") | `callback_requests.created` | requested_at | 1 `business_days_servicer` (target: same day if before 3 p.m. local) | `contact` with `live_contact=true` by assigned personnel | queue escalation; `human_agent` supervisor |
| `REGX_1024_40A2_RELEASE_2_PERMANENT_PAYMENTS` | not_before_gate | `lossmit.permanent_agreement.effective` | — | until 2 consecutive on-time payments | `continuity.released` | release command refused early |
| `CA_CIV_2923_7_SPOC_ASSIGN_PROMPT` | deadline (policy for "promptly") | `lossmit.assistance.requested` (CA, §2924.15 loan) | request date | 2 `business_days_servicer` | `continuity.ca_spoc_assigned` with a direct means of communication sent | `officer` sev-1 |
| `CA_CIV_2923_7_SPOC_UNTIL_EXHAUSTED_OR_CURRENT` | not_before_gate | `continuity.ca_spoc_assigned` | — | until options exhausted or current | release | release refused |
| `FNMA_A4_2_1_04_EMAIL_48H` | deadline | `communication.inbound.received` (email) | received_at | 48 `hours` (new unit: hours) | reply sent | ops alert |
| `FNMA_A4_2_1_04_CHAT_5MIN` | deadline | chat session start | start | 5 minutes | first response | ops alert |
| `FNMA_A4_2_1_04_CALL_METRICS_MONTHLY` | recurring | month-end | — | monthly | metrics report: ASA ≤60s, blockage ≤1%, abandonment ≤5% | `officer` report; remediation plan |

`jurisdiction_overrides`: CA rows above; NY 419 has no SPOC rule in 419.6 (other 419 sections **[UNVERIFIED]**); other states with SPOC statutes (e.g., Nevada, Minnesota homeowner bills of rights) **[UNVERIFIED — load via `jurisdiction_rules.spoc` after counsel review]**.

#### Business rules and calculations
1. **Day counting.** Delinquency per §1024.31: payment due 2026-09-01 unpaid → day 1 = 2026-09-02; day 36 (live contact, 11.1) = **2026-10-07**; day 45 = **2026-10-16**. If the EI written notice (11.2) is scheduled for 2026-10-09, assignment must exist on or before 2026-10-09 — the send command auto-assigns if needed. Calendar days, loan-local time zone; no business-day adjustment (the rule says "45th day").
2. **Assignment rule.** Default mode `ai_first_named_human`: the episode is assigned to a `contact_team` consisting of the `borrower-comms` AI agent (personnel kind `ai_agent`) **and** at least one named human (`named_human_id`) who is "multi-purpose personnel" under comment 40(a)-2. The EI notice, statements and portal show: team name, the named human's first name and title, a direct number that reaches the AI first line during staffed hours and can be transferred to the human, and hours. Bankruptcy filing → reassign to the bankruptcy-specialist team (comment 40(a)-2) without changing the episode.
3. **Release rule.** Under a permanent agreement effective 2027-03-01 with payments due the 1st and a 15-day grace, payments received 2027-03-12 and 2027-04-10 (both within grace, no late charge) → `consecutive_on_time_payments=2` on 2027-04-10 → release eligible 2027-04-10. A payment received 2027-04-17 (late charge assessed) resets the count to 0. Trial-period payments do not count (the agreement must be *permanent*). Independently, the episode releases when `regx_days_delinquent = 0` (brought current), payoff, refinance, or title transfer (comment 40(a)-1).
4. **CA SPOC.** For §2924.15 loans, a request for a foreclosure-prevention alternative (any channel, no magic words) triggers SPOC assignment within 2 servicer BD; the SPOC of record is a **human individual or human team** (`assignment_mode ∈ {human_team, human_individual}`) with the AI as assistant, until a CA-specific legal opinion permits otherwise; SPOC persists until "all loss mitigation options … have been exhausted" (12.x terminal determination incl. appeal) or the account is current — narrower than the Reg X release, so both rules run and the later release wins.
5. **Information accuracy.** Everything the personnel say about (b)(1)(i)–(v) is read from `lossmit_facts` at conversation time; the AI may not state a deadline or option not present in the view; foreclosure-referral circumstances are rendered from the 13.1/13.2 gate states ("we may refer to foreclosure no earlier than day 121, and not while a complete application is pending…").
6. **Record retrieval (b)(2)/(b)(3).** `payments.history` and `lossmit.documents.list` (including prior-servicer submissions boarded in 1.7) must return within the conversation; documents are pushed to the loss-mit evaluator (12.2) via the case file — never re-requested from the borrower when already held (see 12.1 for the §1024.41(b)(1) reasonable-diligence rule).
7. **Metrics.** ASA = mean (queue answer time) over the month for inbound calls; abandonment = abandoned/offered; blockage = busy/failed attempts ÷ offered; computed from telephony CDRs; chat first-response ≤5 minutes; email ≤48 hours from receipt.

#### Integrations
Telephony/voice provider (Twilio + real-time voice model): inbound routing by loan/ANI to the assigned team's line; disclosure prompt at call start ("automated assistant… say 'representative' at any time"); warm transfer API to the human queue; recording + transcript to `contacts`; CDR export for A4-2.1-04 metrics; outage → carrier failover number staffed by humans (the availability objective cannot pause). Chat/secure message: web widget with the same disclosure and escalation. Print/mail: EI notice with the contact block (11.2). Fannie Mae: none (QRPC/outbound attempts are reported in delinquency reporting, 5.7/11.3). Attorney network: SPOC's "ability and authority to stop foreclosure" (CA) is implemented as the foreclosure-ops `hold` command available to the named human and the AI (with the 13.2 dual-tracking gates enforcing the hold automatically).

#### Outputs and artifacts
Notices: `NTC_REGX_39B_EARLY_INTERVENTION` (owned by 11.2) must include the assigned-contact block (required-content checklist item `continuity_block_present`); `NTC_REGX_40_CONTACT_ASSIGNED` (optional standalone letter/e-message when assignment happens before the EI notice or changes); `NTC_CA_2923_7_SPOC` (CA: name/team, direct means of communication, responsibilities). Records: `continuity_episodes`, `contacts` with `assigned_personnel_id`, `callback_requests`, monthly A4-2.1-04 metrics report, the "contact log" (blueprint artifact) = `v_contact_log` per loan.

#### AI agent design (AI-first)
**Legal analysis — can "personnel" be an AI agent team?** The regulation does not define "personnel"; §1024.40 is framed as policies-and-procedures objectives, and comment 40(a)-2 gives the servicer "discretion" over a single person or a team and over single- vs. multi-purpose staff, focusing on *functions* (accurate information, record retrieval, hand-off to evaluators) rather than headcount. Read functionally, an AI agent that (i) is reachable by telephone, (ii) gives accurate (b)(1) information from the system of record, (iii) retrieves the payment history and application documents instantly and (iv) routes them to the evaluator satisfies (b) better than a rotating call center. Against that: (a) the ordinary meaning of "personnel" is people, and (a)(3)'s "live response from such personnel" presupposes a human-type responder; (b) the CFPB's 2023 chatbot spotlight warns that chatbots that fail to recognize requests or trap consumers in loops undermine the very obligations §1024.40 protects; (c) Cal. Civ. Code §2923.7(e) defines the SPOC as "an individual or team of personnel each of whom has the ability and authority" to perform the duties, including "access to individuals with the ability and authority to stop foreclosure" and referral "to a supervisor" — language that assumes humans; (d) no regulator has said an AI counts, and the 2024 NPRM left §1024.40 alone; (e) TCPA treats AI voice as artificial voice for *outbound* calls. **Recommended default:** `ai_first_named_human` — the assigned personnel of record is a *team* comprising the AI first line plus a named human; the borrower can reach the human on request (warm transfer or callback within 1 servicer BD); the AI performs the (b) functions end-to-end and logs them; CA loans get a human SPOC of record with the AI as assistant. `continuity.ai_only` is a feature flag, default **off**, enable-able per state only after the written legal opinion and partner sign-off. This design is compliant under either reading of "personnel" and gives the litigation-defense record (named human, callback SLA, disclosure) that a pure-AI model lacks.
- **Agent behavior (`borrower-comms` in continuity mode).** Tools: `lossmit_facts.get`, `payments.history`, `lossmit.documents.list`, `lossmit.application.status`, `timer.list` (loss-mit deadlines), `foreclosure.gates.get`, `callback.schedule`, `human.transfer`, `lossmit.intake.start` (12.1), `contact.log`. Every conversation: automation disclosure; identity verification; state the assigned team and human name; answer from `lossmit_facts`; offer to start/continue an application; never negotiate modification terms in states where that is licensed activity (`licensed_specialist` escalation, baseline §8 item 7); log `live_contact` and QRPC elements (11.3). Decision record: `{episode_id, contact_id, facts_version, statements_made[], documents_retrieved[], escalations[], disclosure_given, model_version}`.
- **Escalation conditions:** borrower asks for a person/supervisor → `human_agent` (CA: supervisor referral per (d)); bankruptcy → specialist team; language not supported by the voice model → human interpreter line; any (b)(1) fact missing from `lossmit_facts` → the AI says it will confirm and creates a callback (never guesses); detected distress/abuse keywords → human.
- **Human path when AI is off:** the named human/team receives the same tools in the ops console; the telephony routes directly to the human queue; metrics unchanged.
- **Disclosure/consent:** state chatbot disclosure baseline; outbound AI voice only with `tcpa_voice` consent, otherwise human dialer or mail.

#### Edge cases and failure modes
- **Non-principal-residence loans:** §1024.40 not required; policy still assigns the standard team (no `named_human` requirement) — flagged `not_required` for audit accuracy.
- **Transfer-in delinquent loans:** assignment on boarding day if `regx_days_delinquent ≥ 1` (the transferee inherits the day count); EI notice timing per 11.2/§1024.39 transfer rules.
- **Transfer-out:** episode ends; the transfer file carries assignment history and pending callbacks (17.3).
- **Bankruptcy:** assignment continues (§1024.39(d) exemptions apply to early-intervention *notices*, not §1024.40); specialist team; communications routed through counsel where required.
- **FDCPA cease request:** the assigned personnel remain available for *inbound* borrower contact; outbound limited per 11.4.
- **Successor in interest:** a confirmed successor is a borrower → assignment applies; a potential successor gets the 4.4 path and general information only.
- **Disaster/forbearance:** episode continues through forbearance (payments under a forbearance are not "permanent agreement" payments).
- **Staffing failure / telephony outage:** carrier failover; `REGX_1024_40A2_AVAILABILITY` breach if the line is unreachable > 1 hour in staffed time; incident ticket.
- **Named human leaves:** reassign within 1 BD; notify the borrower at the next contact and on the next statement; the team identity is continuous.
- **Re-delinquency after release:** new episode; prefer the same team.
- **Partial data (occupancy unknown):** treat as principal residence (conservative).

#### Test cases and acceptance criteria
- **4.3-T1:** Given a principal-residence loan with payment due 2026-09-01 unpaid, when day 1 = 2026-09-02, then `assignment_due_at = 2026-10-16`; when the EI notice is requested on 2026-10-09 without an assignment, then the command auto-assigns and the notice shows the team block.
- **4.3-T2:** Given no EI notice by day 45 (e.g., §1024.39 exemption), then assignment still occurs by 2026-10-16.
- **4.3-T3:** Given an investment property, then `not_required` and no timer breach.
- **4.3-T4:** Given a borrower calls the direct line after hours, then a callback request is created and a live contact by the assigned team occurs within 1 servicer BD.
- **4.3-T5:** Given a borrower says "I want a person," then a warm transfer to `human_agent` occurs within the call, logged with `human_transfer_requested=true`.
- **4.3-T6:** Given a permanent modification effective 2027-03-01 and on-time payments on 2027-03-12 and 2027-04-10, then release on 2027-04-10; given the second payment is late (late charge posted), then no release and the counter resets.
- **4.3-T7 (CA):** Given a §2924.15 loan and a chat message "can I get help with my payments," then a human SPOC is assigned and a direct means of communication is sent within 2 servicer BD; the SPOC persists after the borrower is denied a modification until the appeal is decided.
- **4.3-T8 (accuracy):** Given a scripted call asking the five (b)(1) facts, then every statement matches `lossmit_facts` for the loan (evaluation harness, 100% agreement required for release).
- **4.3-T9 (bankruptcy):** Given a Chapter 13 filing, then reassignment to the bankruptcy-specialist team without a new episode.
- **4.3-T10 (metrics):** Given a month of CDRs with ASA 75s, then the A4-2.1-04 report flags the miss and an `officer` remediation task opens.
- **4.3-T11 (AI off):** Given `continuity.ai_first=off` for state XX, then calls route to the human queue and the assignment record shows `human_team`.
- **4.3-T12 (transfer-out):** Given transfer-out on 2026-11-01, then the episode closes with `transfer_out` and the transfer file includes the assignment and open callbacks.

#### Audit and evidence
`continuity_episodes` history (assignment time vs. day-45 and vs. EI notice send time), `contacts` with personnel ids, disclosure flags and transcripts, `callback_requests` SLA evidence, `lossmit_facts` version referenced in each decision record (proves what the borrower was told), telephony CDR-based metrics with monthly reports, CA SPOC assignments and communications, legal-opinion and partner sign-off documents attached to the `continuity.ai_only` flag change record.

### Open questions / decisions
1. **4.3-Q1 AI as "personnel."** Default: `ai_first_named_human`; `ai_only` off pending written legal opinion and partner sign-off; CA human SPOC of record.
2. **4.3-Q2 "Timely" live response.** Default: same business day if requested before 3 p.m. borrower-local, otherwise next servicer business day.
3. **4.3-Q3 Staffed hours.** Default 8 a.m.–8 p.m. borrower-local Mon–Fri, 9 a.m.–1 p.m. Sat (aligns with A4-2.1-04 evening/weekend attempts).
4. **4.3-Q4 Non-principal-residence loans.** Default: assign the standard team anyway (no legal requirement).
5. **4.3-Q5 Other state SPOC statutes** to load in `jurisdiction_rules.spoc` **[UNVERIFIED list]**.

### Sources
- 12 CFR 1024.40 (eCFR, current as of Aug. 20, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.40 (verified 2026-09-09)
- Official interpretations §1024.40 (CFPB interactive regulations): https://www.consumerfinance.gov/rules-policy/regulations/1024/interp-40/ (verified 2026-09-09)
- 12 CFR 1024.30 (scope; principal-residence limit): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.30 (verified 2026-09-09)
- Cal. Civ. Code §2923.7 (2025 code, eff. Jan. 1, 2026 amendments): https://law.justia.com/codes/california/code-civ/division-3/part-4/title-14/chapter-2/article-1/section-2923-7/ (verified 2026-09-09)
- Fannie Mae Servicing Guide A4-2.1-04 (12/16/2015): https://servicing-guide.fanniemae.com/svc/a4-2.1-04/establishing-contact-borrower (verified 2026-09-09)
- Fannie Mae Servicing Guide D2-2-01 (11/14/2018): https://servicing-guide.fanniemae.com/svc/d2-2-01/achieving-quality-right-party-contact-borrower (verified 2026-09-09; no SPOC content)
- CFPB, Chatbots in consumer finance (June 6, 2023): https://www.consumerfinance.gov/data-research/research-reports/chatbots-in-consumer-finance/chatbots-in-consumer-finance/ (verified 2026-09-09)
- research/00a-regulatory-status.md §1.2 (NPRM: no §1024.40 changes), §1.4 (AI live contact/TCPA), §5.6 (state AI disclosure).
