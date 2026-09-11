# 13 — Acceptance tests

Per-screen tests live in their files (03 §7, 04 §7, 05 §9, 06 §8, 07 §7, 08a §8, 08b §7, 08c §10, 09 §8, 10 §5). This file defines the harness, the fixtures, the cross-cutting tests, and the mapping to build-spec test IDs. Every test is Given/When/Then and runs against the `api` command handlers with the real Timer Engine and Notice Registry — no UI-only mocks of regulatory behavior.

## 1. Harness

- **Contract tests** (`api`): serializer allow-lists (no DU/credit/fraud/QC fields in any `/v1/borrower/*` response), gate errors (`{code, gate, copy_key}`), idempotency (`card_instance_id`), party scoping.
- **Component tests** (`borrower-app`): every card kind renders from its schema; state transitions update in place; keyboard operability; `aria-live` announcements; dark-token contrast checks (axe).
- **End-to-end** (Playwright): the three happy paths on the fixture calendar; the servicing scenarios; both breakpoints (1280 and 390 px); voice simulated through the telephony adapter's sandbox; SMS/e-mail through the adapters' sandboxes with deep-link resolution.
- **Copy tests**: string assertions over 12-message-copy-library (forbidden words: "guarantee", "pre-approved" outside `preapproval.*`, "you don't qualify", "denied" outside decision notices, "skip a payment", "Fannie Mae" outside `boarding.fannie_letter` and notice templates); reading-level check ≤ grade 8 on every non-template string.
- **Timer tests**: assert `timers.due_at` values from the fixture calendar; the UI renders exactly the allow-listed codes (02 §4) with their labels.

## 2. Fixtures (from the build specs)

- **Refinance fixture** — Phoenix, AZ (America/Phoenix, no DST); $560,000 limited cash-out; 30-year fixed 6.125%; 1-unit primary; escrowed; no MI; eNote-eligible; application Mon Oct 19–Tue Oct 20, 2026 window; CD delivered Mon Nov 2; consummation Fri Nov 6; disbursement Thu Nov 12 (O2–O7 worked examples).
- **Purchase fixture** — Franklin County; $457,800 price; $412,000 HomeReady 30-year fixed 6.375%; two borrowers; application Mon Oct 19, 2026; note date Wed Nov 18, 2026 (O3.5 R7).
- **Offer fixture** — O1.2 worked example: portal enrollment Oct 2025; e-mail offer Fri Oct 2, 2026 09:05 MST; PEWC captured Sat Oct 3 08:12; response Mon Oct 5 08:40 → `lead.created`.
- **Holidays** — Columbus Day Oct 12, Veterans Day Nov 11, Thanksgiving Nov 26, Christmas Dec 25, 2026; New Year's Day Jan 1, 2027 (observed) — creditor and servicer calendars; Reg Z specific calendar = all days except Sundays and federal holidays.
- **Servicing fixture** — payment due Sep 1, 2026; grace 15 days; delinquency day 1 = Sep 2 (4.3-T1); statement cycle 7.1 fixture (Oct 17 posting; Nov 1 due).

## 3. Cross-cutting tests

- **T-X-01 Disclosure first** — Given any new session on app, voice or SMS, then `lead.disclosure.delivered` precedes any other assistant content (03 T-03-01 generalized to servicing sessions: `consent.ai_disclosure.acknowledged` per session).
- **T-X-02 No invented dates** — Given any Dates row rendered, then its `timer_code` is in the 02 §4 allow-list and `due_at` equals `timers.due_at`.
- **T-X-03 Serializer allow-list** — Given every `/v1/borrower/*` response schema, then no field name from `du_findings_interpretations`, `risk_assessment`, `credit_reports.*` (except score-notice fields), `compliance_test_runs`, `qc_*`, `fraud_*`, `applicant_demographics` appears.
- **T-X-04 Consent precedes e-delivery** — Given any `DocumentCard` with `disclosure_id`, then a `consents{kind=esign, status=active}` row scoped to the disclosure class exists for that party at `delivered_at`.
- **T-X-05 Cards commit, chat doesn't** — Given a borrower message whose text matches a pending card's affirmative (e.g., "yes proceed", "lock it", "I agree"), then no command executes and the reply contains the deep link.
- **T-X-06 Party scoping** — Given a co-borrower session, then the Record shows the other party's first name and `progress` booleans only; `applicant_demographics`, income and liabilities of the other party never appear.
- **T-X-07 Voice never consents** — Given any `ConsentCard`, when a voice session affirms, then the card stays `pending` and the invitation link is sent.
- **T-X-08 Talk to a person** — Given any screen, then a control emitting `human.request` is visible without scrolling; after `human.transfer.completed`, a `PersonCard{human_agent}` exists.
- **T-X-09 Money and rates** — Given any rendered amount, then it is produced from cents via `Intl.NumberFormat` and any rate from a decimal string; no float arithmetic in the client.
- **T-X-10 Mobile parity** — Given every card kind at 390 px, then it is operable and the status strip shows badge, next event and the needed-from-you count.
- **T-X-11 Deep links** — Given an SMS deep link opened without a session, then L1 is required before any loan data renders; the token resolves to the card and expires at 7 days.
- **T-X-12 Degraded vendor** — Given Truv returns an error, then the `ConnectCard` shows `failed` with the upload fallback and no error code is shown to the borrower.
- **T-X-13 Reading level** — Given every string in 12 outside notice templates, then its Flesch-Kincaid grade ≤ 8.
- **T-X-14 Forbidden words** — Given every string in 12, then none of the forbidden words appears outside its allowed keys.
- **T-X-15 Nothing-needed** — Given zero `owner=you` items, then the nothing-needed state renders and no reminder is sent.
- **T-X-16 Read-only after terminal** — Given `denied | withdrawn | closed_incomplete | rescinded | paid_in_full → closed | transferred_out`, then no command except `case.open`, `human.request`, document download and contact update succeeds.

## 4. Index of per-file tests

| File | Tests | Count |
|---|---|---|
| 03 Entry and qualification | T-03-01 … T-03-30 | 30 |
| 04 Disclosures, intent, lock | T-04-01 … T-04-10 | 10 |
| 05 Verification, conditions, co-borrowers | T-05-01 … T-05-11 | 11 |
| 06 Decision, property, title, insurance, MI | T-06-01 … T-06-12 | 12 |
| 07 CD, closing, rescission, funding, boarding | T-07-01 … T-07-13 | 13 |
| 08a Payments, statements, escrow | T-08a-01 … T-08a-11 | 11 |
| 08b Insurance, PMI, ARM, life events, requests | T-08b-01 … T-08b-11 | 11 |
| 08c Hardship and delinquency | T-08c-01 … T-08c-11 | 11 |
| 09 Rate-watch and re-refinance | T-09-01 … T-09-10 | 10 |
| 10 Exits | T-10-01 … T-10-08 | 8 |
| 13 Cross-cutting | T-X-01 … T-X-16 | 16 |
| **Total** | | **143** |

## 5. Mapping to build-spec tests (the UI test must pass whenever the spec test passes)

| UI test | Build-spec test / rule |
|---|---|
| T-03-02, T-X-01 | O1.3-T11 (real-person answer), O1.3 `SM_AI_INTERACTION_DISCLOSURE_GATE` |
| T-03-05, T-03-11, T-03-17, T-03-18, T-03-29 | O2.1 rule 1 (prefilled counts at confirmation), O2.2 rule 2/5 (six-item detection) |
| T-03-06, T-X-07 | O1.3-T8 (voice yes ≠ E-SIGN), 7.4 rule 3 |
| T-03-07, T-04-01, T-X-04 | O2.2 guard (esign_consent_id), 7.4 channel rule |
| T-03-09 | O4.1-T11 (mixed score models) |
| T-03-15 | O1.3-T12 (no demographics pre-application) |
| T-03-21, T-03-28 | O1.3-T7 (MLO review before personalized terms) |
| T-03-23, T-04-05 | O2.4 `intent_records.valid` |
| T-03-25, T-04-06 | O2.4 lock → `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD`, `SM_LOCK_EXPIRY_WARN_7` |
| T-03-26 | O1.3-T5 (TBD address; LE clock on address) |
| T-04-08 | O2.5 `REGZ_1026_19E4_REVISED_LE_4SBD_GATE` |
| T-04-10 | O2.5 `REGZ_1026_19F2V_TOLERANCE_REFUND_60` |
| T-05-01 | O4.2 `SM_DU_CONDITIONS_SLA_4H` |
| T-05-03, T-05-04 | O3.1 freshness engines (`FNMA_B3_3_2_01_PAYSTUB_30D_GATE`, `FNMA_B1_1_03_CREDIT_DOCS_4M`, `SM_DOC_EXPIRY_WARN_14`) |
| T-05-05 | O3.2 undisclosed-debt monitoring; O4.1 tolerances |
| T-05-07 | O2.1 `SM_O21_JOINT_INTENT_GATE` |
| T-06-02 | O2.6 `REGB_1002_9_COUNTEROFFER_90`; O4.2-Q3 |
| T-06-05 | O5.2 `REGB_1002_14_APPRAISAL_COPY_3BD_GATE` |
| T-06-09 | O5.5 `FDPA_4104A_FLOOD_NOTICE_GATE` |
| T-06-11 | O4.3 `SM_UW_CTC_GATE` / `ctc_checklists` |
| T-07-01 | O6.2 fixture (`REGZ_1026_19F1III_CD_MAILBOX_3SBD`, `REGZ_1026_19F1_CD_3SBD_GATE`) |
| T-07-06, T-07-08 | O6.3 `REGZ_1026_23_RESCISSION_3SBD_GATE`, `REGZ_1026_23D2_RESCISSION_REFUND_20` |
| T-07-10 | O7.3 `FNMA_B2_1_5_FIRST_PAYMENT_2M` |
| T-07-11 | O11.2 `SM_O64_FIRST_PAYMENT_LETTER_5BD`; 2.x rule 1 |
| T-08a-01 | 2.7 `NOTE_6A_LATE_CHARGE_GRACE_GATE`, `SM_LATE_CHARGE_ASSESS_1CD` |
| T-08a-04 | 2.x `NACHA_NSF_REINITIATION_180_MAX2` |
| T-08a-06 | 2.x `REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10` |
| T-08a-07 | 7.4 rule 8; 7.1 `bounced → fallback_mailed` |
| T-08a-10 | O4.4-T5 (HPML escrow 5 years) |
| T-08b-01, T-08b-02 | 9.2 `REGX_1024_37C_FPI_FIRST_NOTICE_45`, `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15`, 9.5 `REGX_1024_37G_FPI_CANCEL_REFUND_15` |
| T-08b-06 | 7.2 ARM initial notice window |
| T-08b-08 | 4.1 NoE ack and 60-day suppression; 8.x |
| T-08b-10 | 7.6 `REGZ_1026_36C3_PAYOFF_STMT_7BD` (16.1 mirror) |
| T-08c-01 | 11.1 `REGX_1024_39A_LIVE_CONTACT_36`, 4.3-T1 |
| T-08c-04 | 12.1 protection tiers; 13 `REGX_1024_41G_DUAL_TRACK_GATE` |
| T-08c-05 | 12.2 `REGX_1024_41E1_ACCEPT_14` |
| T-08c-06 | 12.8 TPP acceptance by first payment |
| T-08c-07 | 12.4 LL-2026-01 increments/cap |
| T-08c-10 | 13 `REGX_1024_41F1_120_DAY_GATE`; `NTC_SM_FC_REFERRAL_ADVICE` |
| T-09-01 | O1.1 `FNMA_C1_1_01_PREMIUM_RECAPTURE_120` |
| T-09-02, T-09-03 | O1.2 worked example 1; `TCPA_64_1200_A2_PEWC_GATE` |
| T-09-07 | O11.3 same-servicer netting; 3.5 `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` |
| T-10-05, T-10-06 | 1.3-T1/-T5/-T7 mirrored for transfer out (17.x) |

## 6. Definition of "passing"
A file's screens are accepted when: all its tests pass; T-X-01…16 pass on the same build; no serializer leaks; axe reports no AA violations on the dark theme; and the copy tests pass on the committed 12-message-copy-library.
