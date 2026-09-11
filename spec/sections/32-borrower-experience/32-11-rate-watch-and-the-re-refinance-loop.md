# 32.11 — Rate-watch and the re-refinance loop

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | c — the borrower answers the offer and re-confirms the compressed application by card; `mlo_of_record` reviews terms; the `pricing` and `intake` agents run 20.x |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | Standing from `loan.boarded`; on `refi.opportunity.offered`; on `refi.request` |
| Governing source | Projection of sections 20.1 (portfolio rate monitoring and refinance-opportunity detection), 20.2 (solicitation and consent), 20.3 (lead intake — conversion), 20.4 (pricing), §21–§26 (the compressed origination), 16.1/16.2 (same-servicer payoff), 3.5/3.x (escrow transfer on payoff to a new loan with the same servicer — §1024.34(b)), §30 (boarding the new loan), 2.x (autopay on the new loan), 7.4 (consents). |
| Key deadlines | renders `SM_REFI_OPPORTUNITY_EXPIRY_30`, `FNMA_C1_1_01_PREMIUM_RECAPTURE_120`, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` (owned by 20.1 / 20.2 / 16.x / 3.5) |
| Timers | — |

### Blueprint row
Projection of sections 20.1 (portfolio rate monitoring and refinance-opportunity detection), 20.2 (solicitation and consent), 20.3 (lead intake — conversion), 20.4 (pricing), §21–§26 (the compressed origination), 16.1/16.2 (same-servicer payoff), 3.5/3.x (escrow transfer on payoff to a new loan with the same servicer — §1024.34(b)), §30 (boarding the new loan), 2.x (autopay on the new loan), 7.4 (consents).. Owner specs: 20.1 (portfolio rate monitoring and refinance-opportunity detection), 20.2 (solicitation and consent), 20.3 (lead intake — conversion), 20.4 (pricing), §21–§26 (the compressed origination), 16.1/16.2 (same-servicer payoff), 3.5/3.x (escrow transfer on payoff to a new loan with the same servicer — §1024.34(b)), §30 (boarding the new loan), 2.x (autopay on the new loan), 7.4 (consents). (Imported from docs/ux/09-rate-watch-and-re-refinance.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 09 is 32.11 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections 20.1 (portfolio rate monitoring and refinance-opportunity detection), 20.2 (solicitation and consent), 20.3 (lead intake — conversion), 20.4 (pricing), §21–§26 (the compressed origination), 16.1/16.2 (same-servicer payoff), 3.5/3.x (escrow transfer on payoff to a new loan with the same servicer — §1024.34(b)), §30 (boarding the new loan), 2.x (autopay on the new loan), 7.4 (consents).** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: (1) DELTA-05: the `standing` flag on `consents` (db/migrations/0112). (2) DELTA-10: the per-listing estimate under an approved quote id.

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- Standing from `loan.boarded`; on `refi.opportunity.offered`; on `refi.request`. Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.

#### Data model
No UI-owned table is declared here (32.2 declares the seven UI-owned tables).
- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): `consents`, `payoff_demands`, `pricing_quotes`, `refi_opportunities`.
- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.

Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list's): `FNMA_C1_1_01_PREMIUM_RECAPTURE_120` (20.1), `MA_183_28C_BORROWER_INTEREST_60M` (20.1), `SM_REFI_OFFER_FREQUENCY_CAP` (20.1), `SM_REFI_RESOLICIT_COOLDOWN_90` (20.1), `SM_LICENSE_STATE_GATE` (31.1), `SM_REFI_TRIGGER_DAILY` (20.1), `SM_REFI_OFFER_SLA_2BD` (20.1), `TCPA_64_1200_A2_PEWC_GATE` (20.2), `TCPA_64_1200_C2_DNC_SCRUB_31` (20.2), `SM_MLO_PREAPP_TERMS_REVIEW_1BH` (20.3), `TCPA_64_1200_F5_EBR_INQUIRY_3M` (20.2), `SM_IDENTITY_IAL2_GATE` (22.6), `SM_FLOOD_LOL_SERVICING_LINK_2BD` (30.4), `FNMA_B3_3_1_04_VVOE_10BD` (22.3), `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` (3.5).

Jurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### 1. Rate-watch — the standing state

Every serviced loan is in rate-watch from `loan.boarded`. `refi_opportunities.status`: `detected → offer_ready → offered → converted | declined | expired | suppressed`; borrower-initiated `requested → offer_ready`.

**Record (Loan section, "Rate-watch" block):** "Your rate {{note_rate}} · best rate available for your loan today {{rate_sheet_rate}} · we'll tell you when a change is worth it." Below it, one line on what "worth it" means from the program parameters: at least 25 bps lower and a positive 84-month net benefit with $0 borrower-paid costs (20.1 default; configuration, not law). No "watching" message is ever sent proactively — the block is passive until an opportunity exists. Suppressed opportunities are invisible.

**Suppression reasons (never rendered as rejections; the block simply stays passive):** inside 120 days of Fannie Mae purchase (`FNMA_C1_1_01_PREMIUM_RECAPTURE_120`), cash-out seasoning (`FNMA_B2_1_3_03_*`), Massachusetts 60-month borrower-interest test (`MA_183_28C_BORROWER_INTEREST_60M`), frequency cap (`SM_REFI_OFFER_FREQUENCY_CAP`), 90-day quiet after a decline (`SM_REFI_RESOLICIT_COOLDOWN_90`), unlicensed state (`SM_LICENSE_STATE_GATE`), the daily run not yet complete (`SM_REFI_TRIGGER_DAILY`).

**Borrower-initiated:** "Can I refinance?" / "What would a refinance look like?" → `refi.request` → `requested → offer_ready` (skips the solicitation gates; pricing still passes eligibility) → §2 with the same `OfferCard` and no consent requirement beyond the conversation itself (a response to a borrower's own inquiry is not a solicitation).

##### 2. The offer (20.2)

`offer_ready → offered` within `SM_REFI_OFFER_SLA_2BD`. Channel per consent: in-app card and e-mail (CAN-SPAM footer: advertisement, opt-out link, `partner` postal address) by default; **AI voice or SMS only with `consents{kind=tcpa_voice|tcpa_sms, purpose=marketing}`** (`TCPA_64_1200_A2_PEWC_GATE`); a human click-to-dial under the established business relationship where allowed; quiet hours 09:00–20:00 borrower local; national and company DNC scrubs (`TCPA_64_1200_C2_DNC_SCRUB_31`) are internal.

`OfferCard` content (all fields from `refi_opportunities` and `pricing_quotes`; structure = the 20.2 creative):
- "Your current rate {{current_rate}} → offered rate {{offered_rate}} ({{apr}} APR)"
- "{{term}} monthly principal-and-interest payments of {{money(new_pi)}}; payments do not include taxes and insurance, so your actual payment will be higher" (the LE-style statement 20.2 uses)
- "Saves about {{money(monthly_savings)}} a month"
- "No lender fees and no third-party closing costs charged to you — Supermortgage pays them and they're reflected in the rate" (`costs_to_borrower_cents = 0` program default; if a program ever charges, the line changes to the amount)
- "This is not a commitment to lend; rates change daily"
- "{{partner.legal_name}}, NMLSR ID {{partner.nmlsr_id}}, is your lender; Supermortgage services your loan for {{partner.legal_name}}"
- personalized-terms attribution: `{{mlo.name}}, NMLSR ID {{mlo.nmlsr_id}}` (the offer's terms passed `SM_MLO_PREAPP_TERMS_REVIEW_1BH` under `assisted`)
- "Offer good through {{SM_REFI_OPPORTUNITY_EXPIRY_30.due_at}}"
- Options: **Yes, let's do it** · **Not now** · **Never** (proactive offers)

Responses:
- **Yes** → `lead.created` linked to the opportunity; `refi_opportunities.converted`; `marketing.response.received`; the established-business-relationship inquiry window opens internally (`TCPA_64_1200_F5_EBR_INQUIRY_3M`) → §3.
- **Not now** → `refi.opportunity.declined` → `SM_REFI_RESOLICIT_COOLDOWN_90` (the card says "we'll stay quiet for 90 days; ask any time"); the block stays passive.
- **Never** → `consents{purpose=marketing}` revoked for proactive offers (the card says exactly what stops — proactive offers — and what doesn't — the borrower can still ask; servicing messages continue).
- **Expired** (30 days) → `expired`; re-detection allowed on the next run; nothing is sent about expiry.

The **marketing consent** itself is offered once, after the first funding, as a `ConsentCard{tcpa_voice|tcpa_sms, purpose=marketing}` with the exact consent text ("Yes, {{partner.legal_name}} and Supermortgage on its behalf may call or text me at {{number}} using an automated system or an artificial or prerecorded voice about refinance offers. I understand consent is not a condition of any purchase or loan.") — 20.2 worked example. Without it, offers arrive by e-mail and in-app only.

##### 3. Conversion — the compressed application (20.3, 21.1, 21.2)

The conversation continues in the same thread; the Record adds a second subject ("Refinance in progress") beside "Your loan". What still must happen, and what doesn't:

| Item | Happy path (serviced loan) | Why |
|---|---|---|
| Automation disclosure | already delivered in this session | 20.3 |
| Identity | L1 fresh code; L3 already on file (`SM_IDENTITY_IAL2_GATE` satisfied at the prior origination; re-run only if the vendor's assurance has expired per 22.6 policy) | 22.6 |
| Property | `ConfirmCard` (source=servicing_record): address, occupancy ("still your primary home?") | TRID item; 21.2 rule 2 |
| Existing loan | prefilled from the servicing ledger — no card; the payoff figure is computed internally (16.1) | same servicer |
| Value | `ConfirmCard` (AVM) — accept or state | TRID item |
| Loan amount | `ConfirmCard` payoff-based | TRID item |
| Income | **must be re-stated** — `ConfirmCard` from the standing payroll connection if the borrower kept it (§5), else `ConnectCard{truv_income}` | 21.2 rule 2: income is never taken from the origination file |
| Credit | `ConsentCard{credit_authorization, hard_pull}` — a new hard tri-merge; the servicing ledger's score is only an estimate for benefit modelling | 20.1 design; FCRA |
| Liabilities | `ConfirmCard` from the new report | 22.5 |
| ProfileCard | citizenship/marital/dependents/military re-confirmed as a `ConfirmCard` (source=prior_application) | URLA |
| Declarations | asked again (13 items; one tap) | URLA per application |
| DemographicsCard | asked again | Reg C per application |
| Consents | E-SIGN already active for the servicing scopes → extended to `origination_disclosures` (one tap on the scope statement; 7.4 class rule); no demonstration test repeat unless `suspect` | 7.4 |
| Assets | none unless DU asks | 22.4 |
| Co-borrower | invited if on the existing loan (`InviteCard`); their own confirmations | 21.1 |

→ six items → `application.trid_received` → LE within 3 business days (32.4) → proceed → lock (32.4). Borrower time: about three minutes.

##### 4. The compressed pipeline (differences from 03–07)

- **Valuation** — value acceptance is common (`offer_recorded`); the Record says "No appraisal needed" or schedules access (32.6 §2).
- **Title** — a new title order; the existing lien is the platform's own (`payoff_demands` internal); any second lien → SQ-10.
- **Insurance** — the servicing policy record (9.x `verified`) satisfies `evidence_received`; the mortgagee clause is unchanged (same lender of record); nothing to upload unless the policy is `expiring`.
- **Flood** — the life-of-loan determination is reused (`SM_FLOOD_LOL_SERVICING_LINK_2BD`); a new notice only if the status changed.
- **Escrow** — 30.3 same-servicer refinance netting: the existing escrow balance is credited to the new account (`credited_to_new_loan`, §1024.34(b)(2)); the CD shows the transfer; the Thread says "your escrow balance moves to the new loan — no refund to wait for".
- **MI** — new LTV decides; a serviced loan below 80% drops MI (the offer already priced it).
- **Employment re-verification** — standing connection satisfies the VVOE window (`FNMA_B3_3_1_04_VVOE_10BD` via the DU close-by date).
- **CD, closing, rescission, funding** — as 07. **Rescission**: applies to a refinance of a principal dwelling by a different creditor; where the partner was the original creditor and the new loan adds no new money beyond costs, 25.3 may set `not_applicable` (§1026.23(f)(2)) — the UI renders whatever the rescission state says (README §7). Funding: `disbursed` pays off the old loan internally (16.2 `funds_received → paid_in_full`); no wire to a third party.

##### 5. Standing connections (DELTA-05)

After the first funding the platform offers `ConsentCard{blanket_verification_authorization, standing=true}`: "Keep my payroll and bank connections active so a future refinance takes minutes." Effect: the Truv/Plaid connections stay live under the borrower's authorization; data is refreshed only when an opportunity is `offer_ready` and the borrower has said **Yes** (20.1: no consumer reports for selection; connections are not consumer reports but the same restraint applies — no pulls for selection). Revocable any time from the Loan section. Without it, conversion asks for the connections again. The backend delta is the `standing` flag on `consents` and a retention/refresh policy in 31.3 terms (README §Deltas).

##### 6. New loan live, old loan closed

- `loan.funded` (new) → `StatusCard` `refi.same_servicer.funded`: "Done. Your new rate {{rate}} is live. Your old loan is paid off; your escrow balance moved over; your new payment is {{money}} starting {{date}}. Autopay: {{carried over / please re-authorize}}."
- Old loan: `paid_in_full → remitted → housekeeping_complete → closed` (16.2); lien release and MERS deactivation (16.3/16.4) run; `NTC_PAYOFF_PAID_IN_FULL` and `NTC_LIEN_RELEASE_RECORDED` render on the old loan's Documents; the old loan's final 1098 issues in January.
- Autopay: the old enrollment is `terminated` at payoff; a new `ConsentCard{autodraft_authorization}` for the new loan (32.7 §6) — the card prefills the same account and day so it is one signature.
- Record: the header switcher shows both loans; the old one is read-only under *Earlier loans*; the new one becomes "Your loan" and re-enters rate-watch, passive for 120 days (`FNMA_C1_1_01_PREMIUM_RECAPTURE_120`).
- Both threads (if a co-borrower) receive the completion message.

##### 7. Rules carried through the loop

No promise of future terms at any point (B2-1.3-04: a "self-improving" contractual promise is a prohibited prearranged refinancing agreement — the block's copy describes monitoring and offers, never a guarantee); each refinance is a new application with its own LE and CD; "best possible rate", never "guaranteed"; cash-out is never solicited (a borrower may ask); the AI never negotiates — it presents approved terms and takes a yes or no; personalized terms always name the MLO of record; no investor-aware logic or copy anywhere (no "because Fannie Mae owns your loan").

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
| 32.11-T1 | Given `loan.purchased` on Nov 19, 2026, then no `OfferCard` exists before Mar 19, 2027 regardless of rates (`FNMA_C1_1_01_PREMIUM_RECAPTURE_120`); a borrower-initiated `refi.request` in that window produces `offer_ready` with the recapture acknowledgment internal only. |
| 32.11-T2 | Given `offer_ready` and no marketing consent, then delivery is e-mail + in-app only; no `tcpa_voice` call or SMS is attempted; a human click-to-dial is permitted under the EBR (20.2 worked example 1). |
| 32.11-T3 | Given the `OfferCard`, then it contains every field in §2 and no "guarantee"; the MLO attribution is present; the expiry equals `SM_REFI_OPPORTUNITY_EXPIRY_30.due_at`. |
| 32.11-T4 | Given **Not now**, then `refi.opportunity.declined` and no proactive offer for 90 days; a typed "can I refinance?" on day 10 still yields `offer_ready`. |
| 32.11-T5 | Given **Never**, then `consents{purpose=marketing}` is revoked, servicing informational consent remains, and the Rate-watch block stays passive. |
| 32.11-T6 | Given **Yes**, then the compressed application asks income (fresh statement), hard-pull authorization, declarations and demographics again, and does not re-ask address (ConfirmCard from `servicing_record`) or identity documents; `application.trid_received` fires on the sixth confirmation. |
| 32.11-T7 | Given the same-servicer funding, then the old loan reaches `paid_in_full` without a third-party wire, the escrow balance is `credited_to_new_loan`, and the Thread message says so; `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` is satisfied by the credit. |
| 32.11-T8 | Given the partner was the original creditor and the new loan is rate/term, then the rescission state is whatever 25.3 computes and the UI renders no cancel window when `not_applicable`. |
| 32.11-T9 | Given a standing connection consent revoked from the Loan section, then the next conversion creates `ConnectCard{truv_income}` again. |
| 32.11-T10 | Given any Rate-watch copy, then it contains no reference to the investor and no future-terms promise (string tests on the copy library). |

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**

### Sources
- docs/ux/09-rate-watch-and-re-refinance.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections 20.1 (portfolio rate monitoring and refinance-opportunity detection), 20.2 (solicitation and consent), 20.3 (lead intake — conversion), 20.4 (pricing), §21–§26 (the compressed origination), 16.1/16.2 (same-servicer payoff), 3.5/3.x (escrow transfer on payoff to a new loan with the same servicer — §1024.34(b)), §30 (boarding the new loan), 2.x (autopay on the new loan), 7.4 (consents). (spec/sections/)
