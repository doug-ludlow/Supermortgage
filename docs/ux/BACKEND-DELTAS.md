# Backend deltas the borrower UX requires

DELTA-01…10 are the ten deltas `14-claude-code-build-plan.md` §3 declares; the reconciliation below is what the import of
this package as spec section 32 (`tools/import_ux.py`, `spec/sections/32-borrower-experience/`) found when every backticked
name in `docs/ux` was checked against `src/`, `db/migrations/` and the spec registries. Nothing here is invented: each row
names the platform object that exists, the UX name that differs, and the default the build takes. Section numbers are the
platform's (Origination O2.3 → 21.3; servicing 1–19 unchanged).

## 1. The ten declared deltas (14 §3)

| ID | Delta | Owner spec touched | State in this tree (2026-09-11) |
|---|---|---|---|
| DELTA-01 | Reg C **preapproval program**: `prequalifications{kind=preapproval, du_casefile_id, approved_amount_cents, valid_until}`; event `preapproval.letter.issued`; 21.6 adverse-action and 28.3 HMDA paths for denied preapproval requests | 20.3 (Q2 overridden), 21.6, 23.1 (TBD casefiles), 28.3 | **Open.** `db/migrations/0077_lead_intake.sql` created `prequalifications` for the soft-pull prequalification only: columns `prequal_id, lead_id, requested_at, basis ∈ {consumer_stated_only, soft_pull}, soft_pull_report_id, estimated_representative_score, score_source, stated_income_cents, stated_assets_cents, value_estimate_cents, loan_amount_range_cents, ltv_estimate, program_fit, quote_id, outcome, letter_document_id, retention_class, regb_decline_risk_flag`. Missing for the preapproval program: `kind`, `du_casefile_id`, `approved_amount_cents`, `valid_until`; the event `preapproval.letter.issued` is not emitted anywhere in `src/` (`prequal.letter.issued` is). |
| DELTA-02 | **UI-owned tables**: `conversations`, `messages`, `card_instances` (+ `card_instance_events`), `deep_links`, `ui_events`, `sessions` | none (new schema) | **In flight on this branch:** `db/migrations/0111_borrower_ui_tables.sql` creates all seven (plus `auth_challenges`, `passkey_credentials` for L1/passkeys). 32.2's Data model lists the seven as `(new)`; the audit counts them built. |
| DELTA-03 | **Property-data adapter** (`integrations/property-data`): public records, AVM; used by R1/P9/C1 | 20.3, 24.4, 30.3 | **Open** — a `FAKE` adapter in every build stage (README §Vendor fakes). |
| DELTA-04 | **Carrier connection** (`integrations/carrier-connect`), optional path for insurance evidence | 24.5, 9.1 | **Open** — `FAKE` adapter. |
| DELTA-05 | **Standing verification connections**: `consents{kind=blanket_verification_authorization, standing=true}` with refresh/retention policy | 22.3, 22.4, 31.3 | **In flight:** `db/migrations/0112_borrower_consent_kinds.sql` adds the kind and the `standing` column (and `party_id`). The refresh/retention policy (data refreshed only when an opportunity is `offer_ready` and the borrower said Yes) is still to be written in 20.1/31.3 terms. |
| DELTA-06 | **Record projection** `borrower_record`, the servicing history views, SSE stream | api | **In flight:** `src/runtime/borrower` (API seam) and `apps/borrower` (Next.js). |
| DELTA-07 | **Agent tools** `send_card`, `resolve_card_by_evidence`, `create_deep_link` on `borrower-comms` and `intake` | baseline §8 tool allowlists | **Declared:** 32.1's agent paragraph names them; `spec/registry/agents.json` carries them on `intake` (owner of 32.1) — bus registration in `src/app/tools/section32-1.ts` is the build's job (`0/3` in COVERAGE.md). |
| DELTA-08 | **Card-delivered notices**: Notice Registry channel `esign_portal` records `card_instance_id` as delivery evidence | baseline §6 | **In flight:** `src/notices/channel.ts` adds `esign_portal` to `Channel` and `cardInstanceId` to `ChannelDecision`; 0111 adds the channel and evidence columns to `notice_deliveries`. Before this branch the notice channels were `mail_first_class`, `mail_certified`, `email_link`, `portal_post`, `sms_link` only (the disclosures tables of 0064/0065/0070 already knew `esign_portal`). |
| DELTA-09 | **DemographicsCard `collection_method`** value `internet`; `video` treated as not in person | 21.1 rule 3 | **Open** — check the `applicant_demographics.collection_method` domain before the card writes it. |
| DELTA-10 | **Per-listing estimate** for preapproved borrowers under an approved quote id without a new MLO review while `SM_QUOTE_VALIDITY_GATE` is open | 20.4, 20.3 | **Open.** |

Open legal positions the UX carries as flags, not deltas: `origination.ai_mlo_intake` (20.3 Q3), `live_contact.ai_voice_counts` (11.1),
the same-creditor rescission exemption (25.3), Reg C preapproval adoption (DELTA-01).

## 2. Names the UX spells differently from the platform (reconciled by grep of every backticked dotted name in docs/ux against src/)

The UI maps at the SSE / command boundary; the spec files of section 32 keep the UX text and note the platform spelling in
their "Discrepancies vs blueprint" line. Default: **the platform spelling wins**; nothing is renamed in 1–31.

| UX name | Platform name (src) | Where the UX uses it | Note |
|---|---|---|---|
| `payments.reversed` | `payment.reversed` | 08a §3.4 (32.8), 02 §3 | 2.x return handling; the projection's `payments_view.status = reversed` is a column value, not an event. |
| `party.identity.verified` | `identity.verified` | 03 E5 (32.3) | 22.6 emits `identity.verified`; the UX's "O3.6 naming" is not the platform's. |
| `human.transfer.completed` | `human_transferred` | 01 §3.17, 02 §3, 11 SQ-30, 13 T-X-08 (32.1, 32.2, 32.13) | `human.transfer.requested` exists as spelled; only the completion event differs. |
| `autodraft.change.requested` | the `autodraft.enrollment.*` family (`autodraft.enrollment.requested → authorized → validating → active`, changes re-enter at `requested`) | 01 §3.12, 02 §2 (32.1, 32.2) | 2.x has no separate change event; a change is a new enrollment version. |
| `signing_sessions.consent_captured` | column state `signing_sessions.status = consent_captured` | 02 §2 `closing.captureEsignConsent` | Listed in the "Events emitted" column but it is a state, not an event (26.2). |
| `preapproval.letter.issued` | none — `prequal.letter.issued` exists | 02 §3, 03 P8 | DELTA-01. |
| `disclosure.*.received` (wildcard) | `disclosure.le.received`, `disclosure.cd.received`, `disclosure.companion.received` | 02 §1.3 | Each concrete name exists. |

Every other event name in 02 §2/§3 and in the **Events** bullets of 03–10 (`lead.disclosure.delivered`, `consent.ai_disclosure.acknowledged`,
`credit.report.received`, `terms.presentation.requested`, `mlo.review.completed`, `application.trid_received`, `disclosure.le.*`,
`intent.to_proceed.received`, `lock.executed`, `condition.*`, `decision.issued`, `valuation.*`, `flood.*`, `mi.*`, `closing.*`,
`rescission.*`, `funding.*`, `loan.funded`, `loan.boarded`, `loan.purchased`, `payment.posted`, `ach.return.received`,
`escrow.analysis.completed`, `loan.delinquency.day_reached`, `lossmit.*`, `refi.opportunity.*`, `contact.qrpc.achieved`,
`communication.inbound.received`, `human.transfer.requested`, `continuity.assigned`, `escalation.opened`, `fee.waived`,
`rov.requested`, `recording.*`, `marketing.response.received`, `changed_circumstance.recorded`) is spelled as the platform spells it.
The UX commands of 02 §2 (`lead.start` … `party.updateContact`, 45 with the four `autodraft.*` verbs) and the copy keys of 12 are
new by design — they are the `borrower-app` agent's tools in 32.2 and the copy library, not platform events.

## 3. Consent kinds and E-SIGN scope classes

`consent_kind` (0001) was `esign, tcpa_voice, tcpa_sms, email_marketing, autopay, ai_voice, language_preference`, extended by 0060
(`escrow_credit_to_new_loan`), 0077 (`ai_disclosure_ack`), 0089 (`esign_disclosures`). The ConsentCard (01 §3.5) captures
`esign, credit_authorization, tcpa_voice, tcpa_sms, ai_disclosure_ack, irs_estatement, autodraft_authorization, joint_intent,
blanket_verification_authorization`:

| UX kind | Platform | State |
|---|---|---|
| `credit_authorization` | missing before this branch | added by 0112 |
| `joint_intent` | missing | added by 0112 |
| `irs_estatement` | missing (7.4's `tax_statements` class was folded into `esign` scope) | added by 0112 |
| `blanket_verification_authorization` (+ `standing`) | missing | added by 0112 (kind + `standing` column) |
| `autodraft_authorization` | exists as `autopay` | UX maps to `autopay`; default: keep `autopay` |
| `tcpa_voice` / `tcpa_sms` with `purpose ∈ {informational, marketing}` | kinds exist; `purpose` lives on the 0076 solicitation consent rows | map at the command handler |
| E-SIGN scope classes `origination_disclosures`, `origination_esign_signatures`, `enote`, "servicing classes" | `consents.scope text[]` (0009) with the class vocabulary documented on the column by 0112: servicing — `periodic_statements, escrow_statements, regx_correspondence, arm_notices, privacy_notices, lossmit_notices, early_intervention_notices, insurance_notices, pmi_notices, payoff_statements, general_correspondence`; origination — `disclosures, notices`; closing — `esign_signatures, enote` | the UX class names map to the column vocabulary (`origination_disclosures` → `disclosures`, `origination_esign_signatures` → `esign_signatures`); default: the column's names |

## 4. Timers and notices the UX names that are not registry codes

| Name | UX use | Registry | Default |
|---|---|---|---|
| `FNMA_NIB_BALANCE_NOTICE` | 10 §1.2: "if a deferred non-interest-bearing balance was included" at `paid_in_full` (32.12) | not a timer code; 16.2's non-interest-bearing balance advice is a notice, not a clock | render the 16.2 notice; no new timer |
| `SM_QC_PREFUNDING_HOLD` | 06 §7 and T-06-12: "a final review is in progress" (32.6) | not a timer code; the pre-funding QC hold is a 28.1 state (`FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE` is the registry gate) | render from the 28.1 hold state; the T-id text keeps the UX name |
| `NTC_STATE_ANNUAL_ESCROW_STMT_UT` | 08a §6.2 state escrow statements (32.8) | not in `spec/registry/notices.json` (3.3 names the state escrow statements under other codes; `NTC_UT_7_17_4_RESERVE_OPTIONS` is the Utah code the registry has) | listed without backticks in 32.2 and 32.8 so no 32.x process becomes an owner; author under 3.3 if a Utah annual statement is required |

The 42 timer codes of 02 §4 (the borrower-visible allow-list) all exist; 32.2's "Timers and gates" table carries them as bare
reference rows (Kind `(N.M owns)`, empty trigger/anchor/offset/satisfied cells, label in Breach). The registry keeps the earlier
owner; the audit counts each row as a 32.2 unit that is built exactly when the owning definition is armable, satisfiable and emitted.

## 5. Ownership rules the import applied

- No `NTC_` code is owned by a 32.x process: `spec/registry/notices.json` lists 319 codes after the import, none with a 32.x
  `owner_process`; the 32.x files only mention codes an earlier section names.
- No timer is owned by a 32.x process: 42 reference rows in 32.2, none defined.
- Tables: the seven UI-owned tables are 32.2's; every other table the UX reads is named in prose as a read-only projection source.
- Tools: 32.1 → `send_card`, `resolve_card_by_evidence`, `create_deep_link` (agent `intake`, with `borrower-comms`); 32.2 → the 45
  UX commands (agent `borrower-app`, added to `tools/extract_agents.py` KNOWN).
- Figures: none — the UX quotes fixture amounts ($560,000; $8,200/month) without cents and bolds no money figure.
