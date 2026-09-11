# 32.4 — Disclosures, intent to proceed, lock, revised LEs

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | c — the borrower confirms receipt, proceeds and locks by card; `mlo_of_record` approves LEs and locks |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | On `application.trid_received`; on every `disclosure.*`, `intent.*`, `lock.*`, `changed_circumstance.*` event |
| Governing source | Projection of sections 21.2 (LE), 21.3 (companion disclosures), 21.4 (intent, fees, locks), 21.5 (changed circumstances, revised LEs, tolerances, cures), 25.1 (compliance gates that can delay an LE) |
| Key deadlines | renders `REGZ_1026_19E1_LE_3BD`, `REGZ_1026_37A13_COSTS_EXPIRE_10BD`, `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD`, `SM_LOCK_EXPIRY_WARN_7` (owned by 21.x) |
| Timers | — |

### Blueprint row
Projection of sections 21.2 (LE), 21.3 (companion disclosures), 21.4 (intent, fees, locks), 21.5 (changed circumstances, revised LEs, tolerances, cures), 25.1 (compliance gates that can delay an LE). Owner specs: 21.2 (LE), 21.3 (companion disclosures), 21.4 (intent, fees, locks), 21.5 (changed circumstances, revised LEs, tolerances, cures), 25.1 (compliance gates that can delay an LE). This file completes what 03 R9–R11 introduced and adds every branch. (Imported from docs/ux/04-disclosures-intent-lock.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 04 is 32.4 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections 21.2 (LE), 21.3 (companion disclosures), 21.4 (intent, fees, locks), 21.5 (changed circumstances, revised LEs, tolerances, cures), 25.1 (compliance gates that can delay an LE)** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: none — the process renders the 21.2–21.5 states as they are; the "What changed" diff is computed by `api` from two figure snapshots, never free text.

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- On `application.trid_received`; on every `disclosure.*`, `intent.*`, `lock.*`, `changed_circumstance.*` event. Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.
##### 6. Reads · Commands · Events · Roles (summary for this file)

- **Reads:** `disclosures` (all kinds), `fee_items` (for the What-changed diff), `pricing_quotes`, `locks`, `intent_records`, `changed_circumstances`, `tolerance_tests`, `timers` (allow-list).
- **Commands:** `disclosure.acknowledgeReceipt`, `intent.record`, `lock.request`, `lock.requestExtension`, `mi.selectPlan` (revised LE trigger — 06), `application.confirmField` (borrower-requested changes).
- **Events:** `disclosure.le.delivered|mailed|received|revised`, `disclosure.companion.delivered{kind}`, `intent.to_proceed.received`, `lock.executed|extended`, `locks.status=expired`, `changed_circumstance.recorded`, `disclosure.cd.*` (hand-off to 07).
- **Roles:** `mlo_of_record` (LE terms and lock approvals; visible), `officer` (never visible here).

#### Data model
No UI-owned table is declared here (32.2 declares the seven UI-owned tables).
- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): `changed_circumstances`, `disclosures`, `fee_items`, `intent_records`, `jurisdiction_rules`, `locks`, `pricing_quotes`, `timers`, `tolerance_tests`.
- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.

Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list's): `SM_O61_COMPLIANCE_PASS_LE_GATE` (25.1), `REGZ_1026_19E1_LE_3BD` (20.3), `REGZ_1026_37A13_COSTS_EXPIRE_10BD` (21.2), `REGZ_1026_19E1III_LE_7SBD_GATE` (21.2), `REGX_1024_20_HCL_3BD` (21.3), `REGX_1024_15_AFBA_REFERRAL_GATE` (21.3), `REGB_1002_14_APPRAISAL_NOTICE_3BD` (21.3), `FCRA_609G_SCORE_NOTICE_1BD` (21.3), `REGZ_1026_19B_ARM_DISCLOSURE_GATE` (21.3), `GLBA_1016_4_INITIAL_PRIVACY_GATE` (25.4), `TX_50A6_12DAY_CLOSING_GATE` (26.1), `REGZ_1026_19E2_INTENT_FEE_GATE` (21.4), `SM_O71_DOC_GEN_GATE` (26.1), `SM_LOCK_MLO_APPROVAL_SLA_30MIN` (21.4), `SM_LOCK_EXPIRY_DEADLINE` (21.4), `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD` (20.4), `SM_LOCK_EXPIRY_WARN_7` (21.4), `NY_3NYCRR_38_6B4_LOCK_EXPIRY_NOTICE_12_20BD` (21.4), `SM_QUOTE_VALIDITY_GATE` (20.4), `REGZ_1026_19E4_REVISED_LE_4SBD_GATE` (21.5), `REGZ_1026_19F2V_TOLERANCE_REFUND_60` (21.5).

Jurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### 1. Loan Estimate lifecycle as the borrower sees it

`disclosures{kind=le}`: `assembling → rendered → pending_mlo → approved → delivered | mailed → received | deemed_received → superseded`. Application-level: `trid_received → le_issued → le_received`.

| LE state | Thread | Record |
|---|---|---|
| `assembling`, `rendered` | `StatusCard` "Preparing your Loan Estimate" — Next: `REGZ_1026_19E1_LE_3BD.due_at` | Status "Application received"; Next "Loan Estimate arrives by" |
| `pending_mlo` (`assisted`) | `StatusCard` "Being reviewed by {{mlo.name}}, NMLSR ID {{mlo.nmlsr_id}} — expected by {{SM_O21_MLO_REVIEW_SLA_1BD.due_at}}" + `PersonCard{mlo_of_record}` | People: loan officer |
| `approved → delivered` (esign_portal) | `DocumentCard{NTC_REGZ_1026_37_LE, requires_ack=true}` | Documents: *Delivered {{ts}} — confirm receipt*; Numbers flip to `le_v1` |
| `approved → mailed` (no active E-SIGN) | `StatusCard` "Mailed today to {{mailing address}}. If you'd like future documents electronically, finish the e-delivery step" + E-SIGN `ConsentCard` re-offered | Documents: *Mailed {{date}}*; Numbers flip to `le_v1` (the numbers are not a disclosure) |
| `received` | collapsed receipt line | Documents: *Received {{ts}}* |
| `deemed_received` (mailbox rule, 3 specific business days after mailing/e-mailing without confirmation) | nothing new | Documents: *Received (deemed) {{date}}* |
| `superseded` | the newer version's card | older version listed under *Earlier versions* |

Rules: the LE carries the partner as Lender with `partner.nmlsr_id` and `mlo_of_record` as Loan Officer (21.2); a change of any term after `approved` returns the LE to `rendered` and (`assisted`) `pending_mlo` again — the Thread says so plainly. The `SM_O61_COMPLIANCE_PASS_LE_GATE` can block `issueLE`; the borrower never sees a compliance failure — only "still preparing" — and 21.2's `REGZ_1026_19E1_LE_3BD` keeps running (the breach is internal).

**Timers shown:** `REGZ_1026_19E1_LE_3BD` (until delivery), `REGZ_1026_37A13_COSTS_EXPIRE_10BD` ("estimated closing costs are good through {{date}} — after that we may need to re-issue"), `REGZ_1026_19E1III_LE_7SBD_GATE` (feeds "earliest closing date" once a closing is contemplated: not before the seventh specific business day after LE delivery).

##### 2. Companion disclosures (21.3)

Each is its own `disclosures` row and `DocumentCard{requires_ack per rule}`; states `planned → generated → delivered | mailed → received → acknowledged | satisfied_by_le | exempt | superseded | cancelled`.

| Disclosure | Code | When | Ack? | Borrower copy key |
|---|---|---|---|---|
| Homeownership counseling list | `NTC_REGX_1024_20_HCL` | ≤ 3 business days after the Reg B application (`REGX_1024_20_HCL_3BD`); list snapshot ≤ 30 days old | no | `companion.hcl` |
| Your Home Loan Toolkit (purchase) | `NTC_REGX_1024_6_TOOLKIT` | with the LE or ≤ 3 business days after application | no | `companion.toolkit` |
| Affiliated business arrangement | `NTC_REGX_1024_15_AFBA` | at referral to an affiliated provider (`REGX_1024_15_AFBA_REFERRAL_GATE`) | yes (signature) | `companion.afba` |
| Reg B appraisal notice | `NTC_REGB_1002_14_APPRAISAL_NOTICE` (or `satisfied_by_le`) | ≤ 3 business days after application (`REGB_1002_14_APPRAISAL_NOTICE_3BD`) | no | `companion.appraisal_notice` |
| Credit score notice / risk-based pricing | `NTC_FCRA_609G_CREDIT_SCORE`, `NTC_REGV_1022_74_RBP_EXCEPTION` | ≤ 1 business day after the report (`FCRA_609G_SCORE_NOTICE_1BD`); before consummation gate | no | `companion.score_notice` |
| ARM program disclosure + CHARM booklet | `NTC_REGZ_1026_19B_ARM_PROGRAM`, `NTC_REGZ_1026_19B_CHARM` | when an ARM is selected (`REGZ_1026_19B_ARM_DISCLOSURE_GATE`); re-issued if the program changes | no | `companion.arm` |
| Privacy notice | `NTC_GLBA_1016_4_PRIVACY_INITIAL` | at E6; must be delivered before consummation (`GLBA_1016_4_INITIAL_PRIVACY_GATE`) | ack when posted electronically (7.4 rule 10) | `companion.privacy` |
| State early disclosures | `NTC_state:XX` per `jurisdiction_rules` (NY/NJ pre-application gates; AZ fee agreement; TX/MA/CA at-application notices) | per matrix | per matrix | `companion.state.XX` |
| Colorado AI pre-use notice | `NTC_CO_SB26_189_ADMT_NOTICE` | before any pricing output for CO consumers (Dec 1, 2026 policy start) | no | `companion.co_admt` |
| Texas 50(a)(6) 12-day notice | `NTC_TX_50A6_12DAY` | at application for TX home-equity cash-out; closing not before day 12 (`TX_50A6_12DAY_CLOSING_GATE`) | yes | `companion.tx_12day` |

Thread rule: companions render as a **single grouped message** with the LE ("Your Loan Estimate and four related documents"), each its own card, to avoid five separate pings. Cancelled companions (denial or withdrawal inside the window) never render.

##### 3. Intent to proceed (21.4)

- `ChoiceCard` **Proceed** · **Not yet** appears only after the LE is `received | deemed_received` (its `valid` computation: `received_at::date ≥ le_effective_receipt_date`). A tap before that stores an invalid record and re-offers the card when the LE is received (32.3-T23).
- Any channel counts — a spoken "proceed" on a call resolves the pending card server-side through the `borrower-comms` agent's tool with the transcript as evidence (intent is not a consent; 21.4 permits any manner other than silence). The Thread shows the resolved card with *by phone*.
- On `intent.to_proceed.received`: `REGZ_1026_19E2_INTENT_FEE_GATE` opens; the `StatusCard` lists what the platform is now doing (title, flood, payoff demand, valuation method) as receipts, not asks.
- **Not yet** path: the Record keeps "Ready to proceed"; reminder cadence 32.1 §6.4 uses `NTC_SM_NEEDS_LIST_REMINDER`; after the policy window, 21.6 issues `NTC_REGB_1002_9_NOIA` (32.6 §1.4) — the assistant explains that the application closes on the date in the notice unless they proceed.

##### 4. Lock (21.4)

`locks.status`: `requested → pending_mlo_approval → executed → confirmed → {extended, superseded, expired, cancelled, consummated}`.

###### 4.1 Offer
`ComparisonCard{columns = pricing_quotes for the eligible lock periods}`: rate, APR, P&I, points/credits (as "cost" or "credit" in dollars), expiry date computed from `locked_at`; `recommended_id` = shortest period covering the projected closing date + 7 days (purchase: the contract closing date). Always includes **Keep floating** with one sentence on what floating means and that a lock is required before closing documents (`SM_O71_DOC_GEN_GATE` requires `locks.status=active` with expiry ≥ closing date — rendered as "you'll need to lock before we can prepare closing documents").

###### 4.2 Execution
`lock.request{quote_id, period_days}` → `pending_mlo_approval` (`SM_LOCK_MLO_APPROVAL_SLA_30MIN` — Thread: "{{mlo.name}} is confirming your lock — usually within 30 minutes"; `autonomous`: skipped) → `executed` (`lock.executed`, `locked_at`) → `confirmed` (lock confirmation document as `DocumentCard{requires_ack=false}`). Numbers: "Locked {{rate}} through {{expires_at}}". Dates: `SM_LOCK_EXPIRY_DEADLINE`. Revised LE within 3 business days (`REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD`) → §5.

###### 4.3 Extension, relock, float-down
- **Expiry warning** `SM_LOCK_EXPIRY_WARN_7`: Dates row turns caution; Thread `StatusCard` "Your lock expires {{date}}. If closing is later, we can extend — here's the cost" + `ChoiceCard` **Extend {{n}} days ({{cost}})** · **Wait**. `lock.requestExtension` → `lock.extended` (child row; status stays `confirmed`).
- **Expired** without consummation: `locks.status=expired`; Thread `StatusCard` "Your lock expired {{date}}. Your loan can still close; the rate will be set again when you relock — currently {{worst-case rule in one sentence}}"; `ComparisonCard` relock options (a relock is a new version with `supersedes_lock_id`).
- **Float-down** (where the program allows): offered by the platform when `pricing_quotes` improve by the policy threshold; `ChoiceCard`; results in a superseding lock and a revised LE.
- New York: `NY_3NYCRR_38_6B4_LOCK_EXPIRY_NOTICE_12_20BD` — the state lock-expiry notice renders as a `NoticeCard` in the window.
- Cancelled (withdrawal, denial, ineligible product): Numbers drop the lock block; a one-line receipt in the Thread.

###### 4.4 Never
The UI never quotes a rate that is not a `pricing_quotes` row within `SM_QUOTE_VALIDITY_GATE`; never implies a lock exists before `executed`; never shows a lock to a party other than a borrower on the application.

##### 5. Revised Loan Estimates and changed circumstances (21.5)

`changed_circumstances`: `detected → evaluated_valid | evaluated_invalid → revised_le_scheduled → revised_le_delivered | reflected_on_cd → closed`. Kinds: `extraordinary_event, inaccurate_info, new_info, borrower_request, rate_lock, le_expired, construction_delay`.

- Every revised LE is a new `disclosures{kind=le, version=n}` and a `DocumentCard` with a **What changed** block (the diff of rows between `le_v{n-1}` and `le_v{n}`: rate, points, payment, cash to close, specific fees) — computed by `api` from the two figure snapshots, never free-text.
- Borrower-caused changes (`borrower_request` — a product switch, a different loan amount, adding a borrower) show "because you asked us to…"; lender-side changes show the changed-circumstance kind in plain language ("the title company's quote changed after we learned the property is in a trust").
- Timing: delivered ≤ 3 business days after the change is known; a revised LE cannot be issued within 4 specific business days of consummation (`REGZ_1026_19E4_REVISED_LE_4SBD_GATE`) — the change then appears on the CD (`reflected_on_cd`), and the Thread says "this change will show on your Closing Disclosure instead".
- Tolerance cures: if a fee increased beyond its tolerance class, the CD shows a lender credit; `refund_required` post-consummation → a refund within 60 days (`REGZ_1026_19F2V_TOLERANCE_REFUND_60`) with a `NoticeCard` and the payment shown in the servicing ledger. The borrower never has to ask.

#### Integrations
- **`FAKE` vendors** — Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console. Adapters this process touches: the ones its cards name (ConnectCard vendors, the RON platform, telephony, e-mail/SMS, print/mail); each is direction in/out through the owning process's adapter, idempotent on `card_instance_id` / vendor session id, and on outage the card shows `failed` with the upload or paper fallback (32.1 §10).
- **`api`** — the borrower endpoints of 32.2 §7; errors carry {code, gate, copy_key}; the SSE stream of 32.2 §3.

#### Outputs and artifacts
- Rows written: `card_instances` (+ `card_instance_events`), `messages`, `ui_events`, `deep_links`; domain evidence rows through the owning handler (32.1 §9). Documents produced: none — every disclosure and notice rendered here is the owning process's rendered document (`notices.rendered_document_id`, `disclosures.rendered_document_id`), shown with its template version and delivery evidence; a notice delivered by mail shows *Mailed* and no receipt action.

#### AI agent design (AI-first)
`intake` agent owns the pre-funding thread for this process; it sends and resolves cards through the card-sending capabilities named in 32.1 (send_card, resolve_card_by_evidence, create_deep_link) and issues every borrower command through the 32.2 command surface; it names no tool of its own here. End-to-end: on each event this process subscribes to, the agent puts the typed card in front of the borrower with the copy key named, keeps the Record in step, and reminds on the owning process's cadence; the borrower commits by card; the owning process decides. Decision record schema: {card_instance_id, party_id, subject, event, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}. Guardrails: never a decline, "you don't qualify", "guaranteed" or an investor reference in copy (32.1 §7.3); never a personal rate before `mlo.review.completed{approved}`; never a consent by voice or chat; never a money-field change without `officer` approval; never a date the Timer Engine did not compute. Escalations: `human_agent` on "human" or distress; the human roles the owning process names (`mlo_of_record`, `underwriting_reviewer`, `officer`) for their acts.

#### Edge cases and failure modes
- Vendor down → `ConnectCard` `failed` with the `UploadCard` fallback; AI path off → `human_agent` turns, cards and Record unchanged; DU / Fannie Mae outage → no borrower-visible error, timers still render; offline → cards queue *unsent* and nothing shows as done until the server acknowledges; E-SIGN suspect → the document flips to *Mailed* and re-verification is offered (32.1 §10).

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 32.4-T1 | Given `consents{esign}` inactive at LE approval, then `disclosure.le.mailed` and the Documents row reads *Mailed {{date}}*; given consent becomes active later, then a re-delivered electronic copy appears as a new row, and the original mailing evidence remains. |
| 32.4-T2 | Given an e-mailed LE with no confirmation, then `deemed_received` is set on the third specific business day and the Record shows *(deemed)*. |
| 32.4-T3 | Given a companion `hcl` planned with `hud_snapshot_at` 31 days old, then the card is not created until a fresh snapshot exists (21.3 gate). |
| 32.4-T4 | Given an ARM selected in R7, then `NTC_REGZ_1026_19B_ARM_PROGRAM` and `NTC_REGZ_1026_19B_CHARM` cards exist before the LE receipt card is shown. |
| 32.4-T5 | Given a spoken "proceed" on an in-app call after LE receipt, then the pending intent `ChoiceCard` resolves with evidence `{channel=voice, transcript_ref}` and `intent_records.valid=true`. |
| 32.4-T6 | Given a lock executed Tue Oct 27, 2026 for 45 days, then Numbers show expiry Fri Dec 11, 2026; `SM_LOCK_EXPIRY_WARN_7` styles the Dates row caution on Fri Dec 4. |
| 32.4-T7 | Given a lock expired, then no closing slot `ScheduleCard` can be created until a relock (`SM_O71_DOC_GEN_GATE`), and the Thread explains why. |
| 32.4-T8 | Given `changed_circumstances.evaluated_valid{kind=new_info}` 2 specific business days before consummation, then no revised LE issues; the change is `reflected_on_cd` and the Thread message uses `revised_le.on_cd_instead`. |
| 32.4-T9 | Given `le_v2` differs from `le_v1` in the appraisal fee, then the What-changed block lists exactly that row with both amounts and the kind label. |
| 32.4-T10 | Given `tolerance_tests.refund_required` after consummation, then a `NoticeCard` and a ledger refund appear within 60 days and the borrower took no action. |

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**

### Sources
- docs/ux/04-disclosures-intent-lock.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections 21.2 (LE), 21.3 (companion disclosures), 21.4 (intent, fees, locks), 21.5 (changed circumstances, revised LEs, tolerances, cures), 25.1 (compliance gates that can delay an LE) (spec/sections/)
