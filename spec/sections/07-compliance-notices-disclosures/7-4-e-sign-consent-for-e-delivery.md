# 7.4 — E-SIGN consent for e-delivery

| Attribute | Value |
|---|---|
| Section | 7 — Compliance Notices & Disclosures |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | On enrollment |
| Governing source | E-SIGN Act (15 USC 7001) |
| Key deadlines | Before any e-delivery |
| Timers | `ESIGN_7001C1D_RECONSENT_GATE`, `ESIGN_7001C_CONSENT_GATE`, `IRS_1098_ECONSENT_GATE`, `SM_CONSENT_REVALIDATION_12M`, `SM_EMAIL_BOUNCE_SUSPECT_1BD`, `SM_ESIGN_VERIFY_EXPIRY_7`, `SM_ESIGN_WITHDRAWAL_EFFECT_1BD`, `TCPA_REVOCATION_HONOR_10BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Compliance |
| Trigger & frequency | On enrollment |
| Governing source (blueprint) | E-SIGN Act (15 USC 7001) |
| Key deadlines (blueprint) | Before any e-delivery |
| Data/artifacts | Consent record |
| Systems | e-delivery |
| Automation class (blueprint) | b |
| SoR / Sub | Sub |
| Nuances (blueprint) | (none) — reconstructed: pre-consent disclosures; consent that "reasonably demonstrates" access; hardware/software change re-consent; withdrawal; record retention; consent classes per notice type; Reg Z/Reg X/Reg P/IRS cross-references; state UETA/ESRA nuances; interplay with TCPA and AI-disclosure consents |

### Verified requirement (as of 2026-09-09)

**15 U.S.C. 7001(c) (Cornell LII, verified today).** Where a statute or regulation "requires that information relating to a transaction ... be provided or made available to a consumer in writing," an electronic record satisfies the requirement only if: **(c)(1)(A)** "the consumer has affirmatively consented to such use and has not withdrawn such consent"; **(c)(1)(B)** before consenting the consumer receives "a clear and conspicuous statement" informing the consumer of (i) the option to have the record provided on paper and the right to withdraw consent, with any conditions, consequences or fees of withdrawal, (ii) whether the consent applies "only to the particular transaction" or "to identified categories of records that may be provided or made available during the course of the parties' relationship," (iii) "the procedures the consumer must use to withdraw consent and to update information needed to contact the consumer electronically," and (iv) how, after consenting, the consumer may obtain a paper copy and any fee; **(c)(1)(C)** the consumer, before consenting, "is provided with a statement of the hardware and software requirements for access to and retention of the electronic records" and "consents electronically, or confirms his or her consent electronically, in a manner that reasonably demonstrates that the consumer can access information in the electronic form that will be used to provide the information that is the subject of the consent"; **(c)(1)(D)** if a change in hardware/software requirements "creates a material risk that the consumer will not be able to access or retain a subsequent electronic record," the provider must give a statement of the revised requirements and of the right to withdraw consent without fees or undisclosed consequences, and "again complies with subparagraph (C)." **(c)(2)** other consumer-protection law is unaffected; **(c)(3)** a contract's validity is not denied solely for failure to obtain the (C)(ii) demonstration; **(c)(4)** withdrawal does not affect records already provided; **(c)(6)** "an oral communication or a recording of an oral communication shall not qualify as an electronic record" — voice consent is not E-SIGN consent. **7001(d)–(e):** retained electronic records must accurately reflect the information and "remain accessible to all persons who are entitled to access ... in a form that is capable of being accurately reproduced for later reference"; a record that cannot be retained by the recipient does not satisfy a writing requirement. **7002:** states may modify E-SIGN only by adopting UETA (1999 text) or consistent alternatives; New York uses ESRA (State Technology Law art. 3) rather than UETA; Illinois (2021) and Washington (2020) adopted UETA **[PARTIALLY VERIFIED — state adoption dates from general knowledge]**. Practical reading: federally required notices (Reg X/Reg Z/Reg P/IRS) follow 7001(c) regardless of state; state-law-required notices (state payoff statements, state privacy notices, pre-foreclosure notices) follow the state's UETA/ESRA "agreement to conduct transactions electronically" plus any statute that requires mail (UETA §8(b)/(d) preserves "send by mail" and retention-format requirements) — those notices default to mail in `notice_templates.channel_policy`.

**Federal rule cross-references verified today.** Reg X §1024.32(a)(1): "The disclosures required by this subpart may be provided in electronic form, subject to compliance with the consumer consent and other applicable provisions of the E-Sign Act, as set forth in § 1024.3" (early-intervention, escrow, force-placed, transfer, NoE/RFI and loss-mitigation notices). Reg Z §1026.17(a)(1): subpart C disclosures (1026.20(c)/(d) ARM notices) "may be provided ... in electronic form, subject to compliance with the consumer consent and other applicable provisions of the E-Sign Act." Reg Z §1026.41(c) and comments 41(c)-3/-4: periodic statements "electronically if the consumer agrees" with "affirmative consent," a link-notification permitted, and a presumption of consent for consumers already receiving electronic disclosures — the CFPB's 2013 preamble position that full E-SIGN choreography is not required for statements is **[PARTIALLY VERIFIED — preamble not retrieved]**; the platform applies 7001(c) to statements anyway (conservative, single flow). Reg P §1016.9(a): privacy notices "in writing or, if the consumer agrees, electronically," with posting-plus-acknowledgment for customers who obtain services online ((b)(1)(iii)) and the website-only annual-notice alternative ((c)). IRS: electronic Form 1098 statements need the recipient's affirmative electronic consent demonstrating access, specified disclosures, posting by Jan 31 and access through Oct 15 (General Instructions; Treas. Reg. §1.6050H-2) — a **separate consent scope** with its own disclosure text.

**Adjacent consents (research/00a §1.4, §5.6).** TCPA: AI-generated voice is "artificial or prerecorded" (FCC 24-17), so outbound AI-voice calls and autodialed/prerecorded texts to cell phones require prior express consent (written consent for marketing); revocation "by any reasonable means" must be honored within a reasonable time not exceeding 10 business days (FCC 2024 revocation order, effective April 2025) **[PARTIALLY VERIFIED]**. State AI-disclosure norms (Colorado, Utah, California baseline) require disclosing automation at the start of AI interactions. Fannie Mae A4-2.1-04 allows email/text "as permitted by applicable law." Nacha WEB/PPD authorizations are handled in 2.3.

**Discrepancies with the blueprint row:** (1) automation class should be **(a)** for the servicer side — the borrower performs the consent act, but capture, verification, disclosure versioning, revocation and re-consent are fully automatable; (2) "on enrollment" understates the lifecycle (verification test, bounce-driven suspension, hardware/software re-consent, withdrawal, transfer-in inheritance rules); (3) consent must be **class-scoped** because different regulations (Reg Z statements, Reg X notices, IRS 1098, Reg P) have different standards; (4) voice consent is legally insufficient (7001(c)(6)) — relevant to an AI-voice-first platform.

### Operational prerequisites
- Borrower portal + identity verification (Supermortgage; 8–12 weeks): authenticated enrollment, email verification, device/browser capability check, PDF-render verification token, consent audit log.
- Counsel-approved **E-SIGN disclosure** (`NTC_ESIGN_7001C_DISCLOSURE` v1: paper option, withdrawal procedure and consequences (none/no fee), scope = listed categories, update-contact procedure, paper-copy procedure and fee (none), hardware/software requirements) and the separate **IRS e-statement consent** text; Reg P electronic-delivery language.
- Email/SMS provider with bounce/complaint webhooks; SMS short code registration (10DLC) **[vendor-specific]**; `tcpa_sms` consent language reviewed.
- `consents` schema in place (baseline) and 1.1/17.3 mapping rules for inherited consents (default: not inherited — see rules).
- Partner sign-off on the consent policy (scope, no fees, re-consent cadence).

### Build spec
#### Inputs and triggers
- `borrower.portal.enrolled`, `consent.esign.requested` (portal, AI chat/voice referral link, paper form with QR), `consent.esign.verification_completed`, `consent.esign.withdrawn` (portal, written request, call), `email.bounced`/`email.complaint`, `hw_sw_requirements.changed` (release management event when the portal's minimum browser/PDF requirements change), `party.email.changed`, `loan.boarded` (transfer-in consent evidence), `sii.confirmed` (4.4), `borrower.deceased`, `consent.tcpa.*`, `consent.ai_disclosure.acknowledged`, `tax_year.closed` (IRS consent check before e-furnishing).

#### Data model
- `consents` (baseline, extended): `id`, `party_id`, `loan_ids uuid[]` (consent is per party across that party's loans; classes may be restricted per loan), `kind` ∈ {esign, irs_estatement, tcpa_voice, tcpa_sms, autodraft, ai_disclosure_ack}, `scope text[]` (E-SIGN classes: `periodic_statements`, `escrow_statements`, `regx_correspondence`, `arm_notices`, `privacy_notices`, `lossmit_notices`, `early_intervention_notices`, `insurance_notices`, `pmi_notices`, `payoff_statements`, `general_correspondence`; `tax_statements` only under `irs_estatement`), `status` ∈ {pending_verification, active, suspect, withdrawn, expired, superseded}, `disclosure_version_id`, `captured_via` ∈ {portal, ai_chat_link, ai_voice_link, paper_form, api_transfer_in}, `email_address_id`, `evidence jsonb` {ip, user_agent, screen, pdf_token_verified_at, link_clicked_at, checkbox_text_hash, session_id, voice_call_id?}, `hw_sw_version`, `granted_at`, `verified_at`, `withdrawn_at`, `withdrawal_channel`, `withdrawal_reason`, `reconsent_of`, `retention_class` (`esign_consent_life_of_loan_plus_4y`; TCPA `tcpa_consent_4y` minimum). Append-only (status changes are new rows with `supersedes`).
- `consent_disclosure_versions`: `kind`, `version`, `text_hash`, `hw_sw_requirements jsonb`, `effective_from/to`, `approved_by`.
- `delivery_addresses`: `party_id`, `type` ∈ {email, mobile}, `value` (encrypted), `verified_at`, `bounce_count`, `last_bounce_at`, `status`.
- `edelivery_events`: `notice_id`, `party_id`, `posted_at`, `notified_at`, `notification_message_id`, `viewed_at`, `downloaded_at`, `mail_fallback_notice_id`.
- Retention: consent records and disclosure versions for the life of the loan + 4 years and at least as long as any notice delivered under them; TCPA consents ≥ 4 years after last use.

#### State machine
`invited` → `disclosed` (pre-consent statement displayed; version logged) → `consented_pending_verification` (checkbox + typed name; email verification link sent) → `active` (verification: link opened from the email address **and** PDF token read back — proves access to both the email channel and the PDF format) | `expired` (7 days without verification) → `suspect` (hard bounce/complaint/undeliverable notification) → `active` (re-verified) | `withdrawn` → `superseded` (re-consent after hw/sw change; new row). Withdrawal is effective on receipt for records generated after receipt; already-provided records stand (7001(c)(4)). Actors: borrower; `borrower-comms` (invitations, explanations); `disclosures` agent (state transitions on evidence); ops for paper-form intake.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `ESIGN_7001C_CONSENT_GATE` | not_before_gate | any `notice.channel_decision` requesting electronic | — | requires `consents(kind=esign, scope ∋ class, status=active)` for every intended recipient | electronic send allowed | fall back to mail (no breach; logged) |
| `IRS_1098_ECONSENT_GATE` | not_before_gate | `tax_form.1098.furnish_requested` (electronic) | — | requires `consents(kind=irs_estatement, status=active)` | electronic furnish | paper 1098 |
| `ESIGN_7001C1D_RECONSENT_GATE` | not_before_gate | `hw_sw_requirements.changed` (material) | change effective date | all E-SIGN consents flagged `reconsent_required`; electronic delivery blocked until (C) re-demonstrated | `consent.esign.reconsented` | mail fallback; sev-3 if > 30 days |
| `SM_ESIGN_VERIFY_EXPIRY_7` | deadline | `consent.esign.pending` | consent click | +7 calendar_days | `consent.esign.verified` | status `expired`; re-invite |
| `SM_ESIGN_WITHDRAWAL_EFFECT_1BD` | deadline (policy) | `consent.esign.withdrawal_received` | receipt | +1 business_days_servicer | `consent.esign.withdrawn` applied to all classes; confirmation sent | sev-3 |
| `SM_EMAIL_BOUNCE_SUSPECT_1BD` | deadline (policy) | `email.bounced` (hard) on a notice | bounce time | +1 business_days_servicer | paper copy mailed; consent `suspect`; re-verification invite | sev-2 (the underlying notice timer is at risk) |
| `TCPA_REVOCATION_HONOR_10BD` | deadline | `consent.tcpa.revocation_received` | receipt | +10 business_days_servicer (FCC; policy target 1 BD) **[PARTIALLY VERIFIED]** | `consent.tcpa.revoked` applied to dialer/SMS lists | sev-1 |
| `SM_CONSENT_REVALIDATION_12M` | recurring (policy, optional) | `consent.esign.active` | verified_at | 12 months | `consent.esign.revalidated` (any notice viewed in the portal in the last 12 months counts) | none — informational |
| Jurisdiction overrides | | `jurisdiction_rules.esign_state_notice_rule` ∈ {ueta, esra, mail_required_list}; state-mandated-mail notices remain `mail_only` | | | | |

#### Business rules and calculations
1. **Scope and disclosure:** one E-SIGN flow presents the (c)(1)(B)/(C) statement listing the categories (classes) of records; the borrower may consent to all or a subset; each class maps to `notice_templates.notice_class`. A class not covered → mail.
2. **Demonstration test (C)(ii):** the verification email contains a link and an attached PDF (same format as future notices) with a 6-character token; the borrower must open the link from the email and enter the token from the PDF within 7 days. Both events, IP/user-agent, and the disclosure version are stored. Portal-only "checkbox" consent without the demonstration is `pending_verification` and never used for delivery.
3. **Voice/AI channels:** the AI voice or chat agent may explain e-delivery and send an invitation link by email or (with `tcpa_sms` consent) SMS; it may not record voice consent as E-SIGN consent (7001(c)(6)). Chat consent is acceptable only through the authenticated portal flow (the chat cannot substitute for the demonstration test).
4. **Joint borrowers/parties:** consent is per party; a notice is electronic only if every recipient party has active consent for that class; otherwise mail to the non-consenting party and electronic to the consenting party (both deliveries logged; the mail delivery satisfies the regulatory timer).
5. **Transfer-in:** consents from a transferor are **not** inherited by default (`captured_via=api_transfer_in` rows are stored as `evidence_only`); the hello notice (1.3) invites enrollment; open question 2 allows inheritance where the transferor's evidence meets our standard (checkbox text + demonstration proof).
6. **Hardware/software change:** a "material" change (e.g., dropping support for a PDF viewer version or browser family) sets `reconsent_required`; borrowers are notified (`NTC_ESIGN_HWSW_CHANGE_RECONSENT`) and re-demonstrate access; until then their notices go by mail.
7. **Withdrawal:** accepted via portal, written request, email, or a call (voice withdrawal is fine — it is the *consent* that cannot be oral); applied within 1 business day; confirmation sent (`NTC_ESIGN_WITHDRAWAL_CONFIRMATION`) by mail; all classes revert to mail unless the borrower withdraws only some classes.
8. **Bounce/undeliverable:** hard bounce → same-day mail of the affected notice, consent `suspect`, re-verification invitation; three soft bounces in 30 days → same handling; complaint → `withdrawn`.
9. **Reg Z statements:** an availability email with a link satisfies delivery (comment 41(c)-3); the timer is satisfied at the email send time, but rule 8 governs bounces.
10. **Reg P:** privacy notices may be posted with an acknowledgment requirement for portal users (1016.9(b)(1)(iii)); annual notices may be website-only for e-consented customers ((c)(1)).
11. **IRS 1098:** separate `irs_estatement` consent with IRS-specified disclosures; posted by Jan 31; accessible through Oct 15; withdrawal restores paper.
12. **TCPA ledger:** `tcpa_voice`/`tcpa_sms` consents record the number, the consent language, the channel and the date; revocation by any reasonable means (STOP, verbal, email, portal) is applied to all outbound dialer/SMS lists within the policy SLA; AI-voice outbound campaigns (11.1) read this ledger before dialing.
13. **AI disclosure acknowledgment:** `ai_disclosure_ack` records that the automation disclosure was given at the start of each AI interaction (not a consent to AI; evidence for state law).

**Worked example.** Borrower A (primary) enrolls in the portal on Oct 2, 2026: disclosure v1.3 shown (hash logged), consents to all classes, receives the verification email at 10:14 ET, opens the link at 10:20 from IP x, enters token "K7Q2MD" from the attached PDF at 10:21 → `active` for A. Co-borrower B does not enroll. The Nov 1 cycle statement (7.1) on Oct 17: A's copy is posted to the portal and an availability email is sent 09:05 Oct 17; B's copy is mailed Oct 19. On Dec 3 A's email hard-bounces on the Dec statement notification: by Dec 4 a paper statement is mailed to A, A's consent becomes `suspect`, and a re-verification invitation is sent by mail. On Jan 12, 2027 A updates the email address in the portal and completes the demonstration again → `active` (new row, `reconsent_of` the prior). The 2026 Form 1098 is furnished on paper to A and B (no `irs_estatement` consent) by Jan 31, 2027.

#### Integrations
| Counterparty | Direction | Interface | Notes |
|---|---|---|---|
| Email provider | out/in | API send; webhooks (delivered, bounce, complaint) | message ids stored on `edelivery_events` |
| SMS provider (10DLC) | out/in | API; STOP/HELP keyword webhooks | STOP → `tcpa_sms` revoked immediately |
| Borrower portal | internal | consent UI, PDF token verification, document vault | authenticated (MFA) |
| Print/mail | out | fallback mailings and consent confirmations | as 7.1 |
| Transfer files (1.1/17.3) | in/out | consent evidence exchange (MISMO-aligned `consents` projection) | inherited only as evidence |
| Fannie Mae | none | — | — |

#### Outputs and artifacts
- Notices: `NTC_ESIGN_7001C_DISCLOSURE` (pre-consent statement; checklist = the seven (c)(1)(B)/(C) items), `NTC_ESIGN_CONSENT_CONFIRMATION` (electronic, with a paper copy on request), `NTC_ESIGN_VERIFICATION_EMAIL` (link + token PDF), `NTC_ESIGN_HWSW_CHANGE_RECONSENT` ((c)(1)(D) statement: revised requirements; right to withdraw without fee), `NTC_ESIGN_WITHDRAWAL_CONFIRMATION` (mail), `NTC_EDELIVERY_BOUNCE_PAPER_RESUME` (mail), `NTC_IRS_ESTATEMENT_CONSENT_DISCLOSURE`, `NTC_TCPA_CONSENT_CONFIRMATION` (SMS/email double opt-in).
- Records: `consents`, `consent_disclosure_versions`, `delivery_addresses`, `edelivery_events`, `loan_events` `consent.esign.disclosed/pending/verified/active/suspect/withdrawn/reconsented`, `consent.tcpa.granted/revoked`, `consent.ai_disclosure.acknowledged`. No ledger or investor events.

#### AI agent design (AI-first)
- **Agents:** `borrower-comms` conducts enrollment conversations (portal chat, AI voice) with the automation disclosure first, explains the paper option and withdrawal rights in plain language, and issues invitation links; `disclosures` agent owns state transitions strictly from evidence events (no LLM judgment on whether consent "happened"), the hw/sw change campaign, bounce handling and the annual revalidation. Decision record: `{party_id, consent_id, transition, evidence_ids, disclosure_version, channel, model_version}`.
- **Guardrails:** an LLM cannot create an `active` consent; only the verification service can; the agent cannot mark a TCPA consent from a call transcript unless the recorded call contains the scripted consent language and the number was confirmed (stored as evidence with the recording id); revocations recognized from free text are applied immediately (over-recognition preferred).
- **Escalations:** `human_agent` on request; `officer` approves disclosure versions and hw/sw "material change" determinations (policy); `attorney` review of state-specific mail-required lists annually. AI-off: portal flows continue unchanged (they are deterministic); invitations become email campaigns.
- **Consent interplay:** outbound AI-voice enrollment calls require `tcpa_voice` consent for cell numbers; enrollment texts require `tcpa_sms`; the AI must not condition servicing on e-consent; Colorado AI Act — consent capture is not a consequential decision, but the automation disclosure is logged per interaction.

#### Edge cases and failure modes
- **Transfer-in with transferor "e-statement" flags but no evidence:** treat as no consent; mail; invite.
- **Transfer-out:** consents and evidence travel in the transfer file as information; the transferee decides.
- **Bankruptcy:** e-delivery continues if consent is active and counsel/trustee addressing (14.3) permits; a debtor's attorney may request paper — treat as withdrawal for that borrower.
- **Deceased borrower / successor:** the decedent's consent is closed; the successor enrolls separately after confirmation (4.4).
- **Shared email between co-borrowers:** each party must complete their own demonstration; the same address may serve both only after both verifications.
- **Confidential-address/DV flags:** mail-only for location-sensitive notices unless the borrower elects electronic.
- **Portal outage during a statement cycle:** notices for e-consented borrowers are mailed if the portal cannot post within the timer window; consent status unaffected.
- **Email provider outage:** same-day mail fallback for timer-bound notices; non-timer notices retry 24 hours.
- **Language access:** the disclosure is offered in Spanish (and other languages as added — 2024 NPRM readiness); consent language versions are tracked separately.
- **Minor/incapacitated party or POA:** consent by an authorized representative is accepted only with the authority documented in `parties` (4.x).

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 7.4-T1 | Given a borrower views disclosure v1.3 and clicks consent, when the verification link is opened and the PDF token entered within 7 days, then the consent row is `active` with both evidence items; without the token, it stays `pending_verification` and no electronic notice is sent. |
| 7.4-T2 | Given an AI voice call in which the borrower says "yes, email me my statements," then no E-SIGN consent is created; an invitation email/SMS (with `tcpa_sms` consent) is sent and the call is logged with the automation disclosure. |
| 7.4-T3 | Given only the primary borrower has active consent, then the statement is posted/emailed to the primary and mailed to the co-borrower, and the timer is satisfied by the mail delivery. |
| 7.4-T4 | Given a hard bounce on a statement notification Dec 3, then a paper statement is mailed by Dec 4, consent = `suspect`, and a re-verification invitation is issued. |
| 7.4-T5 | Given the portal drops support for an old PDF viewer (material change) effective Feb 1, then all E-SIGN consents show `reconsent_required`, `NTC_ESIGN_HWSW_CHANGE_RECONSENT` is sent, and electronic delivery is blocked until re-demonstration. |
| 7.4-T6 | Given a withdrawal by phone on Mar 3 10:00, then by Mar 4 all classes are mail, a mailed confirmation issues, and notices already posted remain accessible. |
| 7.4-T7 | Given a `tcpa_sms` STOP reply, then the number is suppressed immediately and the revocation is applied to all lists within 1 business day (≤ 10 BD). |
| 7.4-T8 | Given a transfer-in file with `estatement_flag=Y` and no evidence, then the loan boards with mail delivery and an invitation is included with the hello notice. |
| 7.4-T9 | Given `irs_estatement` consent is absent, then the 1098 is furnished on paper even if `periodic_statements` consent is active. |
| 7.4-T10 | Given a state-mandated-mail notice (e.g., NY RPAPL 1304 pre-foreclosure notice), then the channel is mail regardless of consent. |
| 7.4-T11 | Given a consent record, when queried for exam, then the disclosure text version, hash, timestamps, IP/user-agent and verification proof are reproducible (7001(d)). |

#### Audit and evidence
`consents` (append-only with evidence), `consent_disclosure_versions` (text hashes), `delivery_addresses` history, `edelivery_events` (posted/notified/viewed), `notice_deliveries` fallbacks, `contacts` for TCPA consent/revocation with recording ids, `agent_decisions`. Exam pack: per-borrower consent timeline and per-notice channel justification.

### Open questions / decisions
1. Apply full 7001(c) choreography to Reg Z periodic statements (where "affirmative consent" may suffice)? **Default: yes** — one flow, stronger evidence.
2. Inherit transferor consents when the transfer file carries adequate evidence? **Default: no** (invite instead); revisit after the first two transfers.
3. Annual revalidation of dormant consents (no portal activity in 12 months)? **Default: informational only; no forced re-consent.**
4. Offer SMS-only notice availability alerts? **Default: SMS as a secondary alert only; email remains the notification of record.**
5. Charge for paper copies after e-consent? **Default: no fee** (simplifies the (c)(1)(B) disclosure).

### Sources
- 15 U.S.C. 7001 (E-SIGN): https://www.law.cornell.edu/uscode/text/15/7001 — verified 2026-09-09
- 12 CFR 1024.32(a)(1): https://www.consumerfinance.gov/rules-policy/regulations/1024/32/ — verified 2026-09-09
- 12 CFR 1026.17(a)(1): https://www.consumerfinance.gov/rules-policy/regulations/1026/17/ ; 12 CFR 1026.41(c) and comments 41(c)-3/-4: https://www.consumerfinance.gov/rules-policy/regulations/1026/interp-41/ — verified 2026-09-09
- 12 CFR 1016.9: https://www.consumerfinance.gov/rules-policy/regulations/1016/9/ — verified 2026-09-09
- IRS General Instructions for Certain Information Returns (electronic recipient statements): https://www.irs.gov/instructions/i1099gi — verified 2026-09-09
- FCC AI-voice ruling (FCC 24-17) and revocation rule — research/00a §1.4 (secondary); state AI-disclosure laws — research/00a §5.6
- Fannie Mae A4-2.1-04 (12/16/2015): https://servicing-guide.fanniemae.com/svc/a4-2.1-04/establishing-contact-borrower — verified 2026-09-09
