# 32.9 — Servicing: insurance, PMI, ARM, life events, requests

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | c — the borrower supplies evidence, asks, disputes and updates by card; the `insurance-property`, `pmi`, `case` and `payoff-release` agents run the owning processes |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | On every insurance, PMI, ARM, successor, case and payoff event; on a typed message (Intake Router, 4.1) |
| Governing source | Projection of sections 9.1–9.x (insurance), 10.1–10.x (PMI), 7.2 (ARM notices), 4.4 (successors), 4.1/4.2 (NoE, RFI), 4.5 (complaints), 7.6/16.1 (payoff requests), 8.x (credit-reporting disputes), 7.x (privacy, contact changes) |
| Key deadlines | renders `REGX_1024_37C_FPI_FIRST_NOTICE_45`, `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15`, `HPA_4902B_AUTO_TERMINATE_0`, `REGZ_1026_36C3_PAYOFF_STMT_7BD`, RFI/NoE ack and response dates (owned by 9.x / 10.x / 7.6 / 4.x) |
| Timers | — |

### Blueprint row
Projection of sections 9.1–9.x (insurance), 10.1–10.x (PMI), 7.2 (ARM notices), 4.4 (successors), 4.1/4.2 (NoE, RFI), 4.5 (complaints), 7.6/16.1 (payoff requests), 8.x (credit-reporting disputes), 7.x (privacy, contact changes). Owner specs: 9.1–9.x (insurance tracking, force-placement, flood, loss drafts, inspections), 10.1–10.x (PMI), 7.2 (ARM notices), 4.4 (successors in interest), 4.1/4.2 (notices of error, requests for information), 4.5 (complaints), 7.6/16.1 (payoff requests), 8.x (credit reporting disputes), 7.x (privacy, contact changes). (Imported from docs/ux/08b-servicing-insurance-pmi-arm-life-events-requests.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 08b is 32.9 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections 9.1–9.x (insurance), 10.1–10.x (PMI), 7.2 (ARM notices), 4.4 (successors), 4.1/4.2 (NoE, RFI), 4.5 (complaints), 7.6/16.1 (payoff requests), 8.x (credit-reporting disputes), 7.x (privacy, contact changes)** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: none beyond 32.2's list.

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- On every insurance, PMI, ARM, successor, case and payoff event; on a typed message (Intake Router, 4.1). Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.

#### Data model
No UI-owned table is declared here (32.2 declares the seven UI-owned tables).
- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): none named.
- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.

Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list's): `REGX_1024_37G_FPI_CANCEL_REFUND_15` (9.5), `REGX_1024_37C_FPI_FIRST_NOTICE_45` (9.2), `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15` (9.2), `REGX_1024_37E_FPI_RENEWAL_NOTICE_45` (9.4), `REGZ_1026_36C3_PAYOFF_STMT_7BD` (7.6), `INS_FPI_FIRST_NOTICE_SLA_3BD` (9.2).

Jurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### 1. Insurance (9.x)

Policy states: `pending_verification → verified | deficient → verified; verified → expiring (−60 days) → verified | expired → 9.2; cancelled | nonrenewed → 9.2; replaced; superseded`. Force-placement (hazard track): `opened → first_notice_pending → first_notice_sent (t0) → reminder_eligible (t0+30) → reminder_sent (t1) → evidence_window → chargeable (≥ max(t0+45, t1+15)) → lpi_bound → charged → renewal_notice_due → …`; evidence at any point → `closed_evidence`; cure → cancellation and refund within 15 days (`REGX_1024_37G_FPI_CANCEL_REFUND_15`).

| Event | Thread | Loan section |
|---|---|---|
| `expiring` (−60) | `StatusCard` "Your homeowners policy renews {{date}} — if it renews automatically, nothing to do; if you switch carriers, send the new policy" + `ConnectCard{carrier_connect}` / `UploadCard{homeowners_policy}` (`INS_ANNUAL_REMINDER` where required) | Insurance: renews {{date}} |
| `deficient` | `NoticeCard{INS_DEFICIENCY_NOTICE}` naming the single failing element and the fix | Insurance: needs attention |
| `cancelled | nonrenewed | expired` → `first_notice_sent` | `NoticeCard` (Reg X §1024.37(c) first notice — `REGX_1024_37C_FPI_FIRST_NOTICE_45`): what we have, what we need, the 45-day rule, the cost of lender-placed coverage | badge caution |
| `reminder_sent` | `NoticeCard` (§1024.37(d) reminder — `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15`; variants `INS_FPI_REMINDER_NOINFO_MS3B` / `_INSUFF_MS3C`) | — |
| `lpi_bound → charged` | `NoticeCard` (`INS_FLOOD_FPI_PLACED_NOTICE` for flood; hazard placement notice) with the charge and how to cancel it by sending evidence | Insurance: lender-placed {{money}}/yr |
| evidence received → `closed_evidence` / refund | `StatusCard` "Coverage confirmed — the lender-placed policy is cancelled and {{money}} refunded to escrow" (`INS_FPI_CANCEL_REFUND_CONFIRM`) | Insurance: verified |
| renewal of an LPI (`REGX_1024_37E_FPI_RENEWAL_NOTICE_45`) | `NoticeCard` | — |

Flood: `in_sfha → coverage_required → covered | deficient → FPI flood track (notice t0 → placement_eligible t0+45 → lpi_placed → terminate_refund ≤ 30 days)`; map change (`INS_FLOOD_MAP_CHANGE_NOTICE`): "your property is now in a flood zone — coverage is required" with the coverage rule; out of SFHA (`INS_FLOOD_REMOVED_NOTICE`): "no longer required; you may keep it".

Loss draft (insured loss): `claim_reported → check endorsement → inspection(s) → staged disbursement → repairs_complete`. Borrower flow: `ChoiceCard` "Report damage" → the assistant collects the claim facts; `HandoffCard{signing_officer}` for endorsing the insurer's check (mail-in instructions); inspections scheduled with `ScheduleCard`; each disbursement posts a `StatusCard`; `INS_LOSS_DRAFT_UPB_APPLICATION_NOTICE` when funds are applied to the balance instead. Disaster in the area: proactive check-in and the 08c disaster options.

##### 2. PMI (10.x)

`mi_policies.auto_status`: `pending → terminated (78% scheduled date, loan current — HPA_4902B_AUTO_TERMINATE_0) | deferred_not_current → terminated on cure; midpoint termination`. `pmi_cancel` case: `received → (awaiting_written_confirmation) → evaluating_original_value → eligible → cancellation_issued → closed | value_check_needed → awaiting_fee → valuation_ordered → valuation_received → evaluating | ineligible → denial_issued → closed`.

- Loan section: "Mortgage insurance {{money}}/month · ends automatically {{scheduled date}} · you can ask to cancel from {{cancellation_eligible_on}}" (80% LTV on the original value and a good payment history).
- Annual disclosure `NTC_HPA_4903A3_ANNUAL` (+ CA/MN variants, legacy `_B_ANNUAL_LEGACY`, `NTC_FNMA_MI_ANNUAL_INFO`) as a `NoticeCard`.
- **Ask to cancel** — `ChoiceCard` "Cancel my PMI" → `pmi.requestCancellation` → `pmi_cancel` case; the assistant states the path: eligible on the original value → `NTC_HPA_4904A_CANCELLED` and the refund advice `NTC_MI_REFUND_ADVICE`; a current-value check needed → `ChoiceCard` to pay the valuation fee (`awaiting_fee`; refund if no order placed on withdrawal) → `valuation_ordered` → decision; ineligible → `NTC_HPA_4904B_DENIAL` with the reason and the next eligible date; not current → `NTC_HPA_4904B_AUTO_NOT_CURRENT`. Info requests `NTC_MI_INFO_REQUEST`; case closed `NTC_MI_CASE_CLOSED`.
- Proactive: 60 days before the scheduled termination, `StatusCard` "your PMI ends {{date}} — we'll remove it automatically"; on termination, `StatusCard` with the new payment and any escrow line change (10.5 refund leg `NTC_MI_REFUND_ADVICE`).
- LPMI loans: `NTC_HPA_4905C2_LPMI_OPTIONS` at the applicable date.

##### 3. ARM notices (7.2)

`scheduled → index_pending (T−45) → calculated → verified → notice_rendered → notice_sent → effective → reported → closed`; initial notice track `window_open (T−240) → estimated → rendered → sent (by T−210) → awaiting_actual`.

- `NTC_REGZ_20D_ARM_INITIAL` (210–240 days before the first payment at the new rate): `NoticeCard` + Numbers "rate changes {{date}} · estimated new payment {{money}}".
- `NTC_REGZ_20C_ARM_ADJ` (60–120 days before each later change; Fannie Mae `NTC_FNMA_C2_1_02_RATE_CHANGE`): `NoticeCard`; autopay amount change notice follows or is satisfied by the ARM notice (2.x rule 5).
- `NTC_ARM_INQUIRY_INTERIM_20` on a borrower question inside a cycle; corrections `NTC_FNMA_C2_2_01_ARM_CORRECTION`; temporary buydown step notices `NTC_FNMA_C2_1_02_BUYDOWN_STEP_90`.
- Loan section ARM block: index, margin, caps in plain words; next change date; the estimate once `calculated`.

##### 4. Life events

###### 4.1 Contact and address changes
`party.updateContact` (fresh L1). Address change on a mailing address is also a written request the platform records (`cases{case_type=address_change}` via the Intake Router). Confidential-address program flags (ACP) suppress the property address in notices (1.3 T9 pattern).

###### 4.2 Death of a borrower — successors in interest (4.4)
`opened → identifying_successor → documents_described → awaiting_documents → evaluating → (additional_documents_required)* → confirmed | not_successor | withdrawn`; post-confirmation `confirmed → ack_sent → (ack_returned | ack_declined) → (assumption_in_progress → assumed)?`.

- Anyone reporting a death opens the case; the reporter becomes a `potential_successor` party with a limited Record (correspondence only). The assistant describes the documents for the situation (`NTC_REGX_36I_SII_DOCS` / `NTC_REGX_38B1VI_SII_DOCS` — the matrix row for the state and transfer type; a generic list plus the §1024.36(i)(2) statement where no row exists) → `UploadCard`s → `evaluating` → `confirmed` (`NTC_REGX_38B1VI_SII_CONFIRMED` + `NTC_REGX_32C_SII_ACK`: the acknowledgment lets the successor choose whether to receive notices as a borrower) or `not_successor` (`NTC_REGX_38B1VI_SII_NOT_SUCCESSOR` with the reason). Additional documents → `NTC_REGX_38B1VI_SII_ADDL_DOCS`.
- A confirmed successor's Record becomes the full loan home; autopay of the deceased is `terminated` (2.x) and re-enrollment is offered; the assumption offer where applicable (`NTC_FNMA_D1_4_1_02_ASSUMPTION_OFFER`) renders as a `NoticeCard` + `ChoiceCard`.
- Copy is careful and short; no collection language to a potential successor.

###### 4.3 Other events
- **Add or remove a borrower / assumption**: typed ask → the `case` agent explains the assumption and release-of-liability path (Fannie Mae D1-4); documents via `UploadCard`s; a release is a `NoticeCard` on completion.
- **Divorce / quitclaim**: title change recorded → occupancy and vesting `ConfirmCard`; a refinance is offered only if the borrower asks (no solicitation from this signal — 20.1 fair-lending posture).
- **Occupancy change (renting the home)**: `ConfirmCard`; insurance requirement changes (landlord policy) flow from 9.x.
- **Disaster declaration** for the property area: proactive `StatusCard` check-in ("Are you and the home OK?") + the disaster options (32.10 §7); inspections per 9.x.
- **Military service (SCRA)**: `ChoiceCard` "I've been called to active duty" → `UploadCard{military_les|orders}` → SCRA relief applied (rate cap, protections) with a `NoticeCard`; badge "Protected".
- **Representation**: attorney, housing counselor, authorized third party → `InviteCard{party_role}` with the scope explained; `power of attorney` → `UploadCard{poa}`.

##### 5. Requests — questions, disputes, payoff, complaints (4.1, 4.2, 4.5, 7.6, 8.x)

Every typed message goes through the Intake Router (4.1): `{noe, rfi, complaint, lossmit_request, sii_inquiry, payoff_request, cease_communication, attorney_representation, bankruptcy_notice, address_change, general_inquiry, other}`; recall-tuned; confidence < 0.6 → `needs_human` (1 BD SLA, ack timer still runs). A message in the app is a **written** request. The assistant answers oral/general questions live from the same read tools and, when the question is about the account, adds the §1024.38(b)(5) line once per session ("if you'd like a formal written answer, I've logged this as a request — here's how that works": `NTC_REGX_38B5_PROCEDURES` link).

###### 5.1 Request for information (RFI) — 4.2
`received → triaged → (exception_pending | searching | early_response | awaiting_confirmation_sii) → (extended)? → responded → closed`. Thread: `NoticeCard{NTC_REGX_36C_ACK}` within 5 federal business days (weekends and holidays excluded) with the response date; owner/assignee identity questions answered in 10 (`NTC_REGX_36A2_OWNER_IDENTITY` with the Fannie Mae block); response `NTC_REGX_36D_RESPONSE` / `NTC_REGX_36D_NOT_AVAILABLE` within 30 (+15 with `NTC_REGX_36D_EXTENSION`); exceptions `NTC_REGX_36F2_EXCEPTION` state the basis. Dates: ack by · answer by. The exclusive address (`NTC_REGX_35C_ADDRESS`) is shown once in the Record's Documents and on statements — the app itself is a designated written channel.

###### 5.2 Notice of error (NoE) — 4.1
Any assertion that something was done wrong is an NoE even without the word "error". `received → triaged → (exception_pending | investigating | early_correction) → (extended)? → responded → (docs_requested → docs_provided)? → closed`. Thread: `NTC_REGX_35D_ACK` ≤ 5 federal BD (identifies the assertions as understood and the response date; optional helpful documents phrased as optional); response `NTC_REGX_35E_CORRECTION` / `NTC_REGX_35E_NO_ERROR` (with the statement of reasons and the right to request the documents relied on — `NTC_REGX_35E4_DOCS` within 15) / `NTC_REGX_35E_ADDITIONAL_ERRORS`; extension `NTC_REGX_35E_EXTENSION` with reasons; early correction `NTC_REGX_35F1_EARLY_CORRECTION`; exceptions `NTC_REGX_35G2_EXCEPTION`. No fee is ever mentioned as a condition. Credit reporting of the disputed item is suppressed for 60 days (8.x) — the Thread says so. Payoff-statement errors and foreclosure-related errors run on their shorter profiles; the Dates row shows the applicable response date.

###### 5.3 Payoff quote — 7.6, 16.1
`received → written_confirmed | oral_only → requester_verified | authorization_pending → calculating → rendered → checked → sent → superseded | closed`. A typed request is written (`REGZ_1026_36C3_PAYOFF_STMT_7BD` starts; Dates "payoff statement by"); a spoken request gets the figure live plus an offer to convert it to written (one tap). `NoticeCard{NTC_REGZ_36C3_PAYOFF_STMT}` (+ CA/FL variants): payoff amount, good-through date, per-diem, wire instructions with the positive-confirmation rule (never by e-mail alone), `NTC_PAYOFF_UPDATED_STMT` on changes, `NTC_PAYOFF_REQUEST_ACK_DELAY` on the reasonable-time path (bankruptcy, foreclosure, disaster). Third-party requesters (a title company, another lender) need the borrower's authorization (`NTC_PAYOFF_AUTHORIZATION_REQUEST` → `ConsentCard`). Continues in 10.

###### 5.4 Complaints — 4.5
`received → triaged → investigating → (regulator_interim_sent)? → resolved → responded → closed`. `NoticeCard{NTC_COMPLAINT_ACK}` and `NTC_COMPLAINT_RESPONSE`; a complaint that is also an NoE runs both; New York 419.6 disclosure; California SPOC `NTC_CA_2923_7_SPOC` where applicable. Regulator complaints are invisible to the app beyond the response.

###### 5.5 Credit reporting disputes — 8.x
Direct disputes: `NTC_FCRA_1022_43_ACK` → `NTC_FCRA_1022_43E_RESULTS` (or `_F_FRIVOLOUS` with the reason) within the FCRA windows; `NTC_FCRA_1681S2A7_B1/B2` (negative-information notices) render as `NoticeCard`s where required; address-discrepancy notice `NTC_FCRA_1681S2A1C_ADDRESS`.

###### 5.6 Cease communication, attorney representation, bankruptcy notice
Typed or spoken → routed; a cease request (FDCPA-covered loans, 11.4) suppresses outbound collection contact and the Thread confirms (`NTC_REGF_1006_6C_CEASE_ACK`); attorney representation reroutes correspondence; a bankruptcy notice opens 14.x (32.10 §9).

##### 6. Human handoff and continuity

Any of the above can start with "human" → `human.request`; complaints with `fair_lending` or `servicemember` flags carry reviewer sign-off internally; the borrower sees the same acknowledgment and response cadence.

#### Integrations
- **`FAKE` vendors** — Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console. Adapters this process touches: the ones its cards name (ConnectCard vendors, the RON platform, telephony, e-mail/SMS, print/mail); each is direction in/out through the owning process's adapter, idempotent on `card_instance_id` / vendor session id, and on outage the card shows `failed` with the upload or paper fallback (32.1 §10).
- **`api`** — the borrower endpoints of 32.2 §7; errors carry {code, gate, copy_key}; the SSE stream of 32.2 §3.

#### Outputs and artifacts
- Rows written: `card_instances` (+ `card_instance_events`), `messages`, `ui_events`, `deep_links`; domain evidence rows through the owning handler (32.1 §9). Documents produced: none — every disclosure and notice rendered here is the owning process's rendered document (`notices.rendered_document_id`, `disclosures.rendered_document_id`), shown with its template version and delivery evidence; a notice delivered by mail shows *Mailed* and no receipt action.

#### AI agent design (AI-first)
`borrower-comms` agent owns the post-funding thread for this process; it sends and resolves cards through the card-sending capabilities named in 32.1 (send_card, resolve_card_by_evidence, create_deep_link) and issues every borrower command through the 32.2 command surface; it names no tool of its own here. End-to-end: on each event this process subscribes to, the agent puts the typed card in front of the borrower with the copy key named, keeps the Record in step, and reminds on the owning process's cadence; the borrower commits by card; the owning process decides. Decision record schema: {card_instance_id, party_id, subject, event, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}. Guardrails: never a decline, "you don't qualify", "guaranteed" or an investor reference in copy (32.1 §7.3); never a personal rate before `mlo.review.completed{approved}`; never a consent by voice or chat; never a money-field change without `officer` approval; never a date the Timer Engine did not compute. Escalations: `human_agent` on "human" or distress; the human roles the owning process names (`mlo_of_record`, `underwriting_reviewer`, `officer`) for their acts.

#### Edge cases and failure modes
- Vendor down → `ConnectCard` `failed` with the `UploadCard` fallback; AI path off → `human_agent` turns, cards and Record unchanged; DU / Fannie Mae outage → no borrower-visible error, timers still render; offline → cards queue *unsent* and nothing shows as done until the server acknowledges; E-SIGN suspect → the document flips to *Mailed* and re-verification is offered (32.1 §10).

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 32.9-T1 | Given a policy `cancelled` on Mar 1, then the §1024.37(c) first notice renders no later than 3 federal BD (`INS_FPI_FIRST_NOTICE_SLA_3BD`), the reminder ≥ 30 days later, and no charge before max(t0+45, t1+15). |
| 32.9-T2 | Given evidence of continuous coverage uploaded on day 50 after placement, then the LPI is cancelled and the refund posted within 15 days with `INS_FPI_CANCEL_REFUND_CONFIRM`. |
| 32.9-T3 | Given a flood map change into an SFHA, then `INS_FLOOD_MAP_CHANGE_NOTICE` renders with the coverage rule and a 45-day placement date in Dates. |
| 32.9-T4 | Given `pmi.requestCancellation` on a loan at 79% LTV by amortization with a clean 12-month history, then the case reaches `cancellation_issued` without a valuation and `NTC_HPA_4904A_CANCELLED` renders. |
| 32.9-T5 | Given a value check is needed, then the fee `ChoiceCard` appears, `awaiting_fee` expires at 60 days, and withdrawal before an order refunds the fee. |
| 32.9-T6 | Given an ARM with the first change on Jul 1, 2028, then `NTC_REGZ_20D_ARM_INITIAL` is sent between Nov 3 and Dec 3, 2027 and Numbers show the estimated payment. |
| 32.9-T7 | Given a message "my mother passed away, I'm her son", then a 4.4 case opens, the sender becomes `potential_successor`, the documents card renders from the matrix, and no collection language appears in any message to them. |
| 32.9-T8 | Given a typed message "you charged me a late fee I don't owe", then a `noe` case opens, `NTC_REGX_35D_ACK` is sent within 5 federal BD, credit-reporting suppression is set for 60 days, and the Thread shows the response date. |
| 32.9-T9 | Given a spoken payoff request, then the quote is given live, no 7-BD clock starts, and the one-tap conversion starts it. |
| 32.9-T10 | Given a typed payoff request Fri Nov 6, 2026, then `NTC_REGZ_36C3_PAYOFF_STMT` is sent by Tue Nov 17 (servicer business days; Veterans Day closed) with wire instructions carrying the positive-confirmation text. |
| 32.9-T11 | Given a message that is both a complaint and an assertion of error, then both cases exist and the complaint cannot close before the NoE responds. |

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**

### Sources
- docs/ux/08b-servicing-insurance-pmi-arm-life-events-requests.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections 9.1–9.x (insurance), 10.1–10.x (PMI), 7.2 (ARM notices), 4.4 (successors), 4.1/4.2 (NoE, RFI), 4.5 (complaints), 7.6/16.1 (payoff requests), 8.x (credit-reporting disputes), 7.x (privacy, contact changes) (spec/sections/)
