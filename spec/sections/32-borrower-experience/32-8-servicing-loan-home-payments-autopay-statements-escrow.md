# 32.8 — Servicing: loan home, payments, autopay, statements, escrow

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | c — the borrower pays, enrolls, elects and asks by card; the `cashiering` and `escrow` agents post and compute; `officer` waivers on money fields |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | On `loan.boarded`; on every payment, autodraft, statement-cycle and escrow-analysis event |
| Governing source | Projection of sections 2.1–2.7 (cashiering), 7.1 (periodic statements), 7.4 (E-SIGN), 7.x (1098), 3.1–3.8 (escrow); 6.x and 5.x are invisible |
| Key deadlines | renders payment due date, `due_date + grace_days`, `next_draft_on`, `REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45`, `REGX_1024_17I_ANNUAL_STMT_30`, `REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10` (owned by 2.x / 3.x) |
| Timers | — |

### Blueprint row
Projection of sections 2.1–2.7 (cashiering), 7.1 (periodic statements), 7.4 (E-SIGN), 7.x (1098), 3.1–3.8 (escrow); 6.x and 5.x are invisible. Owner specs: 2.1–2.7 (cashiering: posting, partial payments, autodraft, curtailments, biweekly arrangements, trial overlays, late charges), 7.1 (periodic statements), 7.4 (E-SIGN), 7.x (1098), 3.1–3.8 (escrow), 6.x (custodial — invisible), 5.x (investor reporting — invisible). The servicing Record layout (32.1 §4 §10) applies from `loan.boarded`. (Imported from docs/ux/08a-servicing-payments-statements-escrow.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 08a is 32.8 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections 2.1–2.7 (cashiering), 7.1 (periodic statements), 7.4 (E-SIGN), 7.x (1098), 3.1–3.8 (escrow); 6.x and 5.x are invisible** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: (1) `payments.reversed` is the platform's `payment.reversed` (2.x). (2) `autodraft.change.requested` is the `autodraft.enrollment.*` family (2.x). (3) NTC_STATE_ANNUAL_ESCROW_STMT_UT is not in the notice registry (3.3 names the Utah escrow statements differently) — docs/ux/BACKEND-DELTAS.md.

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- On `loan.boarded`; on every payment, autodraft, statement-cycle and escrow-analysis event. Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.

#### Data model
No UI-owned table is declared here (32.2 declares the seven UI-owned tables).
- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): `escrow_lines`, `jurisdiction_rules`.
- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.

Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list's): `NOTE_6A_LATE_CHARGE_GRACE_GATE` (2.7), `FNMA_D2203_PAYMENT_REMINDER_CD20` (2.7), `SM_AUTODRAFT_COPY_DELIVERY_1BD` (2.3), `REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10` (2.3), `REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45` (3.2), `REGX_1024_17I_ANNUAL_STMT_30` (3.3), `REGZ_1026_35B1_HPML_ESCROW_GATE` (23.4).

Jurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### 1. The loan home

Record header "Your loan · {{address}}"; Status = the account state (§2); Next = the earliest of: next payment due, next autopay draft, escrow analysis, PMI end, ARM change; Numbers (post-funding set, 32.2 §1.1); Loan section (autopay, escrow lines, MI, ARM, year-end). The Thread's default content is system-initiated (32.1 §0 principle 6); the borrower's typed requests route through the `borrower-comms` agent and the Intake Router (4.1) — any question about the account is at least an oral RFI answered live, any assertion of an error is a notice of error (32.9 §5).

##### 2. Account states (badge)

Derived per 2.x from the installment `late_charge_state` and the delinquency counters (`regx_days_delinquent` per §1024.31 FIFO; `fnma_delinquency_status` only for reporting):

| Badge | Condition | One-liner |
|---|---|---|
| **Current** | no unpaid installment past due; next due in the future | "Next payment {{money}} due {{date}} · autopay on {{date}}" or "…pay by {{due_date + grace_days}}" |
| **Payment due** | due date reached, inside the grace period (`not_due → evaluating` not yet passed; `NOTE_6A_LATE_CHARGE_GRACE_GATE`) | "Due {{date}} — no late charge if received by {{grace end}}" |
| **Past due** | grace passed, `late_charge_state = assessed | accrued_suspended`, < 30 days | "Past due. Late charge {{money}} applied {{date}}." |
| **Behind {{n}} days** | `regx_days_delinquent ≥ 30` | 08c takes over (early intervention, plans) |
| **On a plan** | `workout_plans.active`, `trial_active` | "Forbearance through {{date}}" / "Trial payment {{n}} of 3 due {{date}}" |
| **Paused** | bankruptcy stay, SCRA relief, disaster forbearance | 08c |
| **Paid off / Closed** | 10 | — |

`FNMA_D2203_PAYMENT_REMINDER_CD20` / `NTC_FNMA_D2_2_03_PAYMENT_REMINDER` (7.1): the Fannie Mae payment reminder issues automatically when no payment has arrived by the Guide's day; the Thread renders it as a `NoticeCard` and the badge is already "Past due".

##### 3. Payments (2.1, 2.2, 2.5, 2.6, 2.7)

###### 3.1 Make a payment
`PaymentCard`: default amount = the installment due (P&I + escrow + any late charge if elected), editable; date options = today through `due_date + grace_days` (2.x rule 3), never later; account = a saved account (masked last 4) or **Add account** (routing + account + type → instant verification API, fallback micro-deposits with a `ConfirmCard` for the two amounts, or a $0 prenote wait — 2.x rule 2). Fresh L1 within 10 minutes required (32.1 §5). `payment.makeOneTime` → `payments.received → identified → allocated → posted`; the Thread shows *received* immediately and *posted* on `payment.posted` with the allocation (interest, principal, escrow, fees — C-1.1-01 order) as a collapsed receipt; Numbers update.

###### 3.2 Extra principal
`PaymentCard{mode=extra_principal}`: amount only; explains the effect in one line from the ledger projection ("brings your balance to {{money}}"); `payment.extraPrincipal` → curtailment `received → applied` (same day if current; `redirected_to_cure` when delinquent — the card says so before submission). Re-amortization (Form 181) is a request the borrower can make ("recalculate my payment") → 2.x re-amortization `requested → computed → offered → executed → effective` with a `NoticeCard` and a `ChoiceCard` to accept.

###### 3.3 Partial payments and suspense (2.2)
A payment less than the installment shows *received — held until the rest arrives* with the amount still needed and the 30-day rule in plain words ("if the rest doesn't arrive within 30 days we'll return this"); `suspense_items{reason=partial_payment}`: `open → applied | returned | refunded`. The borrower can always ask for the funds back (`refunded`). The statement carries the same explanation (7.1).

###### 3.4 Returned payments (2.x rule 7)
`ach.return.received{R01|R09}` → `payments.reversed`; `NoticeCard{AUTODRAFT-RETURN-v1}`; the platform retries once automatically in 3–5 banking days ("we'll try again on {{date}} — no action needed unless you want to pay another way") → a second return → `suspended_returns` and a `PaymentCard` with a different account. NSF fee only where permitted (2.7), shown on the card. Administrative returns (R02/R03/R04/R20) → "that account can't be used — add a new one".

###### 3.5 Biweekly / semimonthly (2.5)
Third-party arrangements are recognized (`reported → verified → active`); the platform's own half-payment plan is offered as a `ChoiceCard` with the schedule and the rule that halves accumulate without a 30-day return clock while the arrangement is active.

###### 3.6 Late charges (2.7)
`late_charge_state`: `not_due → evaluating → assessed | accrued_suspended | not_assessed`; `assessed → collected | waived | reversed`. The Thread posts a `StatusCard` at assessment; a courtesy waiver request is a typed ask handled by the `cashiering` agent within policy (`fee.waived{reason}`); the outcome is a one-line receipt.

##### 4. Autopay (2.x autodraft)

`autodraft_enrollments.status`: `requested → authorized → validating → active ⇄ paused → revoked | terminated | suspended_returns`.

- **Enroll** — `ConsentCard{autodraft_authorization}` (every Nacha/Reg E element: borrower name; masked loan number; account; amount rule — fixed installment or variable with the ≥10-day change-notice statement; draft day 1–16 or the due date; first draft date; company name "SUPERMORTGAGE" as it appears on the bank statement; revocation instructions incl. the 3-business-day rule; "enrollment is optional"; E-SIGN consent for the copy). `checkbox_with_text` + typed name → `authorized` → `validating` → `active`; copy delivered within 1 BD (`AUTODRAFT-CONFIRM-v1`, `SM_AUTODRAFT_COPY_DELIVERY_1BD`). Voice enrollment is a `ConsentCard` link, never spoken consent (32.1 §3.5).
- **Change** — draft day, account, extra principal: `autodraft.change` → re-validation for a new account; the Loan section shows the next draft.
- **Amount change notice** — `NoticeCard{AUTODRAFT-AMOUNT-CHANGE-v1}` ≥ 10 calendar days before a changed debit (`REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10`) unless the escrow/ARM notice already stated the exact new amount and date; the borrower may elect range notices (`ChoiceCard`).
- **Pause / revoke** — any channel; effective for unsent files; ≥ 3 business days before a debit stops it; `NoticeCard` confirmation. The assistant never argues against a revocation.
- **Paused by the platform** — forbearance/trial re-baselining, bankruptcy hold, death of borrower (`terminated`; successor enrolls anew), payoff/transfer (`terminated` at cutover — 10).
- **Returns** — §3.4; `suspended_returns` requires the borrower to re-activate (`ChoiceCard`).

##### 5. Statements and year-end (7.1, 7.x)

Cycle: `scheduled → snapshot_taken → variant_selected → rendered → checked → channel_decided → sent → delivered | bounced → fallback_mailed | returned → re_sent`. Variants: `NTC_REGZ_41_STMT_STD`, `_DELQ` (delinquency block), `_TPP` (trial period), `_BK7_11`, `_BK12_13`, `NTC_REGZ_41E3IV_COUPON_DELQ_NOTICE`; e-delivery uses `NTC_REGZ_41_STMT_AVAIL_EMAIL` (availability e-mail with link — comment 41(c)-3).

- Electronic: `DocumentCard{statement, requires_ack=false}` on `sent`; Documents lists every cycle; a hard bounce → `fallback_mailed` and consent `suspect` (7.4 rule 8) with the re-verification `ConsentCard`; the Record shows *Mailed*.
- Paper: *Mailed {{date}}* rows only.
- Exempt cycles (`exempt_bk`, `exempt_charged_off`, `suppressed_transfer`) render nothing; bankruptcy variants follow 14.x election rules (32.10).
- **Form 1098** — `NTC_IRS_1098` by January 31 (electronic only with the separate `consents{kind=irs_estatement}` and its `NTC_IRS_ESTATEMENT_CONSENT_DISCLOSURE`; the `ConsentCard` is offered in December); corrected forms `NTC_IRS_1098_CORRECTED`. The Loan section's year-end block shows status and a link.
- Privacy annual notice (`NTC_REGP_1016_5_ANNUAL` / website-only under 1016.9(c)(1)) and opt-out confirmations render as `NoticeCard`s.

##### 6. Escrow (3.1–3.8)

###### 6.1 Steady state
Loan section escrow block: balance, monthly escrow portion, lines (`escrow_lines`: county tax, hazard, flood, MI, HOA where escrowed) with payee, frequency, next disbursement and last paid. Each disbursement `sent → confirmed` posts a `StatusCard` ("we paid {{payee}} {{money}} for {{line}}"). Shortage plans (`escrow_shortage_plans`) show remaining installments. `NTC_SM_ESCROW_ADVANCE` / `NTC_SM_ESCROW_HAZARD_ADVANCE` render when the platform advances funds.

###### 6.2 Annual analysis (3.2, 3.3)
`scheduled → computing → computed → (anomaly_review) → approved → statement_sent → effective`. Dates: `REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45` ("escrow review starts {{date}}"); statement within 30 days of the computation year end (`REGX_1024_17I_ANNUAL_STMT_30`).
- `statement_sent` → `NoticeCard{NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT}` with the template's plain-language block: new monthly escrow, effective date, surplus/shortage/deficiency.
- **Shortage** (`NTC_REGX_1024_17F_SHORTAGE`): `ChoiceCard` **Spread over 12 months (+{{money}}/month)** · **Pay {{money}} now** (the `NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT` election) → `escrow.electShortage` → plan `active` or `paid_lump`; the autopay amount-change notice follows automatically.
- **Surplus** ≥ $50: `NTC_SM_ESCROW_SURPLUS_REFUND` — refund `scheduled → issued → cleared` within 30 days; loan not current → `retained` with the explanation; < $50 → credited to payments (`credited_to_payments`).
- Short-year statements (`NTC_REGX_1024_17I4_SHORT_YEAR_RESET`, `_TRANSFEROR`) on transfer/payoff; state statements (NTC_STATE_ANNUAL_ESCROW_STMT_UT, interest-on-escrow statements `NTC_STATE_ESCROW_INTEREST_STATEMENT_*`) per `jurisdiction_rules`; `NTC_IL_765_910_15_TAX_PAID` (IL tax-paid notice), `NTC_MN_47_20_9_DISCONTINUE_RIGHT` where applicable.
- Bankruptcy Chapter 13: the `effective` transition waits for the 14.2 gate; the Thread says the new amount "takes effect once the plan allows".

###### 6.3 Waiver and revocation (3.x)
`escrowed → evaluating → approved → waived | denied`; `waived → revoking → escrowed`. `escrow.requestWaiver` from a typed ask; eligibility explained (LTV ≤ 80% and program rules; HPML loans stay escrowed ≥ 5 years — `REGZ_1026_35B1_HPML_ESCROW_GATE`; flood and MI lines can't be waived); `NTC_SM_ESCROW_WAIVER_DECISION`; on `waived` the final short-year statement and balance refund/credit; `NTC_SM_NONESCROW_TAX_DELINQUENCY` if a non-escrowed tax goes delinquent; `NTC_SM_ESCROW_WAIVER_REVOCATION` when re-established (initial statement within 45 days).

#### Integrations
- **`FAKE` vendors** — Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console. Adapters this process touches: the ones its cards name (ConnectCard vendors, the RON platform, telephony, e-mail/SMS, print/mail); each is direction in/out through the owning process's adapter, idempotent on `card_instance_id` / vendor session id, and on outage the card shows `failed` with the upload or paper fallback (32.1 §10).
- **`api`** — the borrower endpoints of 32.2 §7; errors carry {code, gate, copy_key}; the SSE stream of 32.2 §3.

#### Outputs and artifacts
- Rows written: `card_instances` (+ `card_instance_events`), `messages`, `ui_events`, `deep_links`; domain evidence rows through the owning handler (32.1 §9). Documents produced: none — every disclosure and notice rendered here is the owning process's rendered document (`notices.rendered_document_id`, `disclosures.rendered_document_id`), shown with its template version and delivery evidence; a notice delivered by mail shows *Mailed* and no receipt action.

##### 7. Proactive message catalogue (this file)

payment posted · payment received (held) · payment returned · autopay confirmation · autopay amount changing · autopay draft tomorrow (opt-in) · payment due in 5 days (autopay off) · late charge assessed · statement available · 1098 ready · escrow review starting · escrow statement · shortage choice · surplus refund sent · tax paid · insurance paid · MI paid · escrow advance · nothing needed this month.

#### AI agent design (AI-first)
`borrower-comms` agent owns the post-funding thread for this process; it sends and resolves cards through the card-sending capabilities named in 32.1 (send_card, resolve_card_by_evidence, create_deep_link) and issues every borrower command through the 32.2 command surface; it names no tool of its own here. End-to-end: on each event this process subscribes to, the agent puts the typed card in front of the borrower with the copy key named, keeps the Record in step, and reminds on the owning process's cadence; the borrower commits by card; the owning process decides. Decision record schema: {card_instance_id, party_id, subject, event, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}. Guardrails: never a decline, "you don't qualify", "guaranteed" or an investor reference in copy (32.1 §7.3); never a personal rate before `mlo.review.completed{approved}`; never a consent by voice or chat; never a money-field change without `officer` approval; never a date the Timer Engine did not compute. Escalations: `human_agent` on "human" or distress; the human roles the owning process names (`mlo_of_record`, `underwriting_reviewer`, `officer`) for their acts.

#### Edge cases and failure modes
- Vendor down → `ConnectCard` `failed` with the `UploadCard` fallback; AI path off → `human_agent` turns, cards and Record unchanged; DU / Fannie Mae outage → no borrower-visible error, timers still render; offline → cards queue *unsent* and nothing shows as done until the server acknowledges; E-SIGN suspect → the document flips to *Mailed* and re-verification is offered (32.1 §10).

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 32.8-T1 | Given due Oct 1 with 15-day grace, then the badge is "Payment due" Oct 1–15 with the grace end shown, "Past due" from Oct 16 with the assessed late charge, and "Current" on posting. |
| 32.8-T2 | Given a `PaymentCard` submitted without a fresh L1 code in the last 10 minutes, then the API refuses and the card requests the code. |
| 32.8-T3 | Given a payment of $1,000 against a $2,400 installment, then the Thread shows *held*, the remaining $1,400 and the 30-day rule; `suspense_items.open` exists; a request for refund resolves to `refunded`. |
| 32.8-T4 | Given `ach.return.received{R01}`, then `AUTODRAFT-RETURN-v1` renders, one retry is scheduled in 3–5 banking days, and a second R01 moves the enrollment to `suspended_returns` with a re-activation `ChoiceCard`. |
| 32.8-T5 | Given an autopay `ConsentCard`, then it contains every 2.x rule-1 element and the optional statement; `authorized` is never set from voice. |
| 32.8-T6 | Given an escrow analysis raising the payment on Jan 1, then `AUTODRAFT-AMOUNT-CHANGE-v1` is sent ≥ 10 days before the Jan draft unless the escrow statement stated the exact amount and date. |
| 32.8-T7 | Given a hard bounce on the statement availability e-mail, then a paper statement is mailed the same day, consent is `suspect`, and a re-verification card appears. |
| 32.8-T8 | Given a shortage of $600, then the `ChoiceCard` shows +$50/month or $600 now; choosing spread creates a 12-installment plan and no lump-sum insert is rendered afterwards. |
| 32.8-T9 | Given a surplus of $75 on a current loan, then a refund is scheduled and `NTC_SM_ESCROW_SURPLUS_REFUND` renders; given $40, then `credited_to_payments`. |
| 32.8-T10 | Given an HPML loan consummated Nov 6, 2026, then `escrow.requestWaiver` before Nov 6, 2031 is refused with the escrow-period copy (23.4-T5). |
| 32.8-T11 | Given no `irs_estatement` consent, then the 1098 shows *Mailed* and the December `ConsentCard` was offered. |

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**

### Sources
- docs/ux/08a-servicing-payments-statements-escrow.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections 2.1–2.7 (cashiering), 7.1 (periodic statements), 7.4 (E-SIGN), 7.x (1098), 3.1–3.8 (escrow); 6.x and 5.x are invisible (spec/sections/)
