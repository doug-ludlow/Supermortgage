# 32.12 — Exits

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | c — the borrower requests a payoff, authorizes third parties and pays by card; the `payoff-release` and `transfer` agents run 16.x / 17.x |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | On a payoff request; on `funds_received`; on a transfer-out batch; on a successor confirmation; on liquidation |
| Governing source | Projection of sections 7.6 (payoff request), 16.1 (payoff engine), 16.2 (funds, paid in full, remittance), 16.3 (lien release), 16.4 (MERS), 3.5 (escrow on payoff), 7.x (final 1098), 17.x (servicing transfer out), 1.3 (hello/goodbye — mirrored), 4.4 (successors), 12.9/13/15 (liquidation), 31.3/19.x (records access after closure). |
| Key deadlines | renders `REGZ_1026_36C3_PAYOFF_STMT_7BD`, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD`, `REGX_1024_33B3_COMBINED_15`, `REGX_1024_33C1_LATE_FEE_PROTECTION_60` (owned by 7.6 / 16.x / 3.5 / 17.x) |
| Timers | — |

### Blueprint row
Projection of sections 7.6 (payoff request), 16.1 (payoff engine), 16.2 (funds, paid in full, remittance), 16.3 (lien release), 16.4 (MERS), 3.5 (escrow on payoff), 7.x (final 1098), 17.x (servicing transfer out), 1.3 (hello/goodbye — mirrored), 4.4 (successors), 12.9/13/15 (liquidation), 31.3/19.x (records access after closure).. Owner specs: 7.6 (payoff request), 16.1 (payoff engine), 16.2 (funds, paid in full, remittance), 16.3 (lien release), 16.4 (MERS), 3.5 (escrow on payoff), 7.x (final 1098), 17.x (servicing transfer out), 1.3 (hello/goodbye — mirrored), 4.4 (successors), 12.9/13/15 (liquidation), 31.3/19.x (records access after closure). (Imported from docs/ux/10-exits.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 10 is 32.12 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections 7.6 (payoff request), 16.1 (payoff engine), 16.2 (funds, paid in full, remittance), 16.3 (lien release), 16.4 (MERS), 3.5 (escrow on payoff), 7.x (final 1098), 17.x (servicing transfer out), 1.3 (hello/goodbye — mirrored), 4.4 (successors), 12.9/13/15 (liquidation), 31.3/19.x (records access after closure).** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: (1) FNMA_NIB_BALANCE_NOTICE is named as a timer but is not a registry code (16.2 renders the non-interest-bearing balance notice as a notice, not a clock).

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- On a payoff request; on `funds_received`; on a transfer-out batch; on a successor confirmation; on liquidation. Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.

#### Data model
No UI-owned table is declared here (32.2 declares the seven UI-owned tables).
- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): none named.
- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.

Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list's): `REGX_1024_33C1_LATE_FEE_PROTECTION_60` (1.3), `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` (3.5), `REGX_1024_33B3_COMBINED_15` (1.3).

Named as timers here but not registry codes (docs/ux/BACKEND-DELTAS.md): FNMA_NIB_BALANCE_NOTICE.

Jurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### 1. Payoff (sale, refinance elsewhere, lump sum)

###### 1.1 Quote
32.9 §5.3 governs the request. Quote engine states (16.1): `computing → gated → computed → rendered → active → superseded | expired | relied_upon | void`. The `NoticeCard{NTC_REGZ_36C3_PAYOFF_STMT}` shows: total payoff, good-through date, per-diem, components (principal, interest to the date, escrow handling, fees, any late charge/NSF, recording fee for the release where charged), wire instructions **with the positive-confirmation rule**: "call the number on your statement to confirm these instructions before sending; we never change wire instructions by e-mail." A refinancing lender or title company requesting on the borrower's behalf needs the borrower's authorization (`NTC_PAYOFF_AUTHORIZATION_REQUEST` → `ConsentCard`). Updates → `NTC_PAYOFF_UPDATED_STMT`. New Jersey: `NTC_NJ_CANCELLATION_RIGHT` where applicable.

###### 1.2 Funds and paid in full (16.2)
`funds_received → held | cleared → matched | unmatched → applied_full → paid_in_full → remitted → housekeeping_complete → closed`; branches `applied_short → shortage_demand → cured | absorbed | uncured_30d`, `applied_over → overage_refund_pending → refunded`, `reversed_pre_close`.

| Event | Thread | Record |
|---|---|---|
| `funds_received` | `StatusCard` "Payoff funds received {{date}} — {{money}}" | badge "Paying off" |
| `applied_short` | `NoticeCard{NTC_PAYOFF_SHORTAGE_DEMAND}`: the difference, the reason (per-diem past good-through; a fee), how to send it; `uncured_30d` → the funds are applied per the note and the loan stays open (the card says so at day 20) | Needed-from-you: shortage |
| `applied_over` | `NoticeCard{NTC_PAYOFF_OVERAGE_REFUND_ADVICE}`; refund posted | — |
| `paid_in_full` | `NoticeCard{NTC_PAYOFF_PAID_IN_FULL}`; autopay `terminated`; `FNMA_NIB_BALANCE_NOTICE` if a deferred non-interest-bearing balance was included | badge "Paid off"; Numbers: balance 0 |
| escrow refund (3.5) | `StatusCard` "Your escrow balance of {{money}} is being refunded — check mailed / deposited by {{REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD.due_at}}" (same-servicer refinance: credited instead — 09) | Dates |
| lien release (16.3) | `opened → (awaiting_custody_docs) → prepared → awaiting_execution → executed → notarized → submitted → recorded → borrower_notified → mers_deactivation_pending → closed`; `NoticeCard{NTC_LIEN_RELEASE_RECORDED}` with the recording reference; trustee/public-trustee paths (CA/WA/CO) explained in the notice; state deadline shown in Dates | Documents: recorded release |
| eNote | `NTC_ENOTE_PAPER_COPY` where a state requires a paper copy of the eNote marked paid; paper note → `NTC_NOTE_RETURNED` | Documents |
| final 1098 | January; `NTC_IRS_1098` | Documents |
| `closed` | `StatusCard` "Your loan is closed. Your documents stay here." | badge "Closed"; Record read-only; the Thread remains open for questions (RFI/NoE rights survive per 4.x) |

Rate-watch ends (`refi_opportunities.void`). Records remain accessible to the borrower for the retention period (31.3 / 19.x); the party's other loans are unaffected.

##### 2. Transfer out (17.x)

When the master servicer moves servicing to another subservicer or sells the MSR: `transfer_batches.status` and the goodbye run (`planned → rendered → qc_passed → released_to_vendor → mailed → complete`) are internal; the borrower sees:

| Timing | Thread | Record |
|---|---|---|
| ≥ 15 days before the transfer date | `NoticeCard{NTC_REGX_1024_33B_GOODBYE_MS2}` (or the combined notice `NTC_REGX_1024_33B_COMBINED_MS2` when the transferee joins in one letter): transfer date, the new servicer's name, address and toll-free number, the date Supermortgage stops accepting payments, the 60-day protection, that terms don't change | badge "Servicing moving to {{new servicer}} on {{date}}"; Dates: last Supermortgage payment date · new servicer's first date · protected window ends |
| autopay | `StatusCard`: enrollments `terminated` at cutover; the last debit is no later than the last pre-cutover due date; "set up autopay with {{new servicer}} after {{date}}" | Loan: autopay ends {{date}} |
| escrow | short-year statement `NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR` | Documents |
| during the 60 days after | payments sent to Supermortgage are forwarded (`NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN` when returned instead) and count as on time (`REGX_1024_33C1_LATE_FEE_PROTECTION_60`) — the Thread says "you're protected; but update your payments to {{new servicer}}" | badge "Transferred out"; Record read-only after cutover |
| corrective notice | `NTC_REGX_1024_33B_CORRECTIVE` if a date or address changes | — |

Open requests (RFI/NoE), loss-mitigation applications with their received dates, bankruptcy and SCRA statuses carry to the transferee in the transfer file (17.3); the Thread tells the borrower which items moved and that the new servicer owns them. The conversation stays available read-only; a party with another Supermortgage loan keeps the full thread for that loan.

##### 3. Successor (death of the last borrower) — 4.4

32.9 §4.2 governs confirmation. After `confirmed`: the successor may continue paying (full Record; autopay re-enrollment), assume the loan where offered (`NTC_FNMA_D1_4_1_02_ASSUMPTION_OFFER` → assumption flow), or pay off (§1). Communications choice from `NTC_REGX_32C_SII_ACK` is respected (a successor who declines borrower notices still gets §1024.36/.35 responses to their own requests).

##### 4. Liquidation (12.9, 13, 15)

Short sale → `closed → liquidated`: `NoticeCard` with the settlement outcome and relocation assistance where applicable; mortgage release → `deed_recorded → released → reo_conveyed`: the release of personal liability and any relocation payment (≤ 30 days) as `NoticeCard`s; foreclosure sale → the post-sale notices required by state law; in all cases the Record shows "Closed" and the documents stay accessible; credit reporting per 8.x is stated once. Eviction, REO and claims are invisible.

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
| 32.12-T1 | Given a typed payoff request, then `NTC_REGZ_36C3_PAYOFF_STMT` renders within 7 servicer business days with the components, good-through date and the positive-confirmation text; a rate change before funds → `NTC_PAYOFF_UPDATED_STMT`. |
| 32.12-T2 | Given funds $300 short of the good-through figure, then `NTC_PAYOFF_SHORTAGE_DEMAND` renders; cured → `paid_in_full`; uncured at day 30 → funds applied per the note and the loan stays open with a `StatusCard` explaining. |
| 32.12-T3 | Given `paid_in_full` on Mar 3, then the escrow refund is scheduled by Mar 23 (`REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD`), autopay is `terminated`, and rate-watch is `void`. |
| 32.12-T4 | Given a California trustee-path release, then the `NTC_LIEN_RELEASE_RECORDED` copy explains the reconveyance path and Dates shows the state deadline. |
| 32.12-T5 | Given a goodbye notice mailed Sep 16 for an Oct 1 transfer, then `REGX_1024_33B3_COMBINED_15` is satisfied, the badge and Dates update, and autopay shows its end date (1.3 T1). |
| 32.12-T6 | Given a payment received by Supermortgage on Oct 14 after an Oct 1 transfer, then the Thread states the payment is forwarded and protected; on day 61+ the protection text is absent. |
| 32.12-T7 | Given a confirmed successor who declined borrower notices, then no statements are sent to them, but an RFI they submit is acknowledged and answered on the 4.2 clocks. |
| 32.12-T8 | Given `closed`, then the Record is read-only, documents remain downloadable, and a new typed question still creates a case. |

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**

### Sources
- docs/ux/10-exits.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections 7.6 (payoff request), 16.1 (payoff engine), 16.2 (funds, paid in full, remittance), 16.3 (lien release), 16.4 (MERS), 3.5 (escrow on payoff), 7.x (final 1098), 17.x (servicing transfer out), 1.3 (hello/goodbye — mirrored), 4.4 (successors), 12.9/13/15 (liquidation), 31.3/19.x (records access after closure). (spec/sections/)
