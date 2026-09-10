/**
 * Registry overrides for Section 11 (early intervention, collections, FDCPA)
 * timers whose spec rows are prose. Per-communication rules (call caps,
 * quiet hours, disclosure fragments) are evaluator-backed: they are asserted
 * on each outbound attempt rather than clocked.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyEarlyInterventionTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 11.1 contact cadence ------------------------------------------------
  o("FNMA_A42104_VARY_TIMES_CYCLE", { trigger: "`contact.plan.cycle_closed`", evaluator: "11.1.variedAttemptTimes", why: "§11.1 timer table: per 3 consecutive cycles ≥1 evening (after 17:00 local) or weekend attempt and ≥2 distinct daypart slots (A4-2.1-04)." });
  o("FNMA_D2202_CONTINUE_AFTER_210", { offset: "every 7 calendar_days", why: "§11.1 timer table: after day 210 attempts continue every 7 days (policy = Guide 'authorized', D2-2-02)." });
  o("FNMA_D2202_OUTBOUND_START_36", { anchorField: "due_date", offset: "+36 calendar_days (rolled to the next servicer business day)", why: "§11.1 timer table: day 36 = due_date + 36, next open day if closed (A4-2.1-04)." });
  o("REGF_1006_14_CALL_CAP_7IN7", { trigger: "`contact.attempt.requested{mode=voice, direction=outbound, fdcpa_debt_collector_flag=true}`", evaluator: "11.1.callCap7in7", why: "§11.1 timer table: max 7 counted calls per person per debt in trailing 7 days (Reg F §1006.14(b))." });
  o("REGF_1006_6B1_QUIET_HOURS", { trigger: "`contact.attempt.requested{direction=outbound}`", evaluator: "11.1.quietHours", why: "§11.1 timer table: allowed 08:00–21:00 consumer-local (policy voice 08:00–20:30, SMS/email 08:00–20:00) (Reg F §1006.6(b)(1))." });
  o("REGX_1024_39A_RESUME_AFTER_BK_NEXT_DUE", { trigger: "`bankruptcy.status.changed{to∈{dismissed, closed, reaffirmed}}`", anchorField: "next_due_date", why: "§11.1 timer table: `bankruptcy.dismissed/closed/reaffirmed` → windows re-open from the next payment due date (§1024.39(a))." });
  o("SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD", { trigger: "`loan.delinquency.window_opened{ai_voice_counts=false}`", anchorField: "live_due_at", why: "§11.1 timer table: AI voice doesn't count in jurisdiction, or AI-only efforts ≥3 without live contact by day 28 (`contact.ai_only.escalated`) → human task due 5 calendar days before `live_due_at`." });
  o("TCPA_64_1200_A1_CELL_CONSENT_GATE", { trigger: "`contact.attempt.requested{mode∈{ai_voice, sms}, line_type∈{mobile, voip, unknown}}`", evaluator: "11.1.tcpaConsentUnrevoked", why: "§11.1 timer table: requires unrevoked `tcpa_voice`/`tcpa_sms` consent (47 CFR 64.1200(a)(1))." });
  o("TCPA_64_1200_A3_LANDLINE_AI_3IN30", { trigger: "`contact.attempt.requested{mode=ai_voice, line_type=landline, written_consent=false}`", evaluator: "11.1.landlineAi3in30", why: "§11.1 timer table: max 3 AI-voice attempts per landline number in trailing 30 days without written consent (47 CFR 64.1200(a)(3))." });
  // ---- 11.2 early intervention notices ------------------------------------
  o("FNMA_D2101_NO_SOLICIT_LT30", { trigger: "`solicitation_packages.send_requested`", evaluator: "11.2.delinquentAtLeast30OrImminentDefault", why: "§11.2 timer table: `regx_days_delinquent ≥ 30` (or imminent-default request by the borrower, 11.5) before any solicitation package (D2-1-01)." });
  o("REGX_1024_39B_TRANSFEREE_45_AFTER_FIRST_DUE", { trigger: "`loan.boarded{transferor_ei_notice_recent=true}`", anchorField: "first_post_transfer_due_date", why: "§11.2 timer table: transferor notice sent within 45 days of transfer → written notice +45 calendar days after first post-transfer due date if still delinquent (§1024.39(b))." });
  o("REGX_1024_39C_RESUME_NEXT_DUE", { trigger: "`bankruptcy.status.changed{to∈{dismissed, closed, reaffirmed}}`", anchorField: "next_due_date", why: "§11.2 timer table: `bankruptcy.dismissed/closed/reaffirmed` → windows from the next due date follow the standard rules (§1024.39(c))." });
  o("REGX_1024_39C2II_DISCHARGE_PAYMENT_REARM", { offset: "until payment.applied", why: "§11.2 timer table: (b) re-arms on the first `payment.applied` with `received_on ≥ petition_date`; (a) never re-arms (§1024.39(c)(2)(ii))." });
  o("REGX_1024_39D_FDCPA_NOTICE_190", { anchorField: "fdcpa_next_notice_due", offset: "0", why: "§11.2 timer table: at +180: if ≥45 days delinquent → due +190; else later of (45 days after the due date for which the borrower remains delinquent) and +190 — computed by `11.2.fdcpaNoticeDue` (§1024.39(d))." });
  o("SM_EI_NOTICE_CONTENT_CHECKLIST", { trigger: "`notice.render_requested{template=NTC_REGX_1024_39B_EARLY_INTERVENTION}`", evaluator: "11.2.checklistComplete", why: "§11.2 timer table: all checklist items true for the variant before render." });
  // ---- 11.3 QRPC / promises -----------------------------------------------
  o("FNMA_D2202_CESSATION_ON_QRPC", { evaluator: "11.3.cessationOnQrpc", why: "§11.3 timer table: `contact.qrpc.established` → plan ceased{qrpc_workout | qrpc_no_interest} (D2-2-02)." });
  o("FNMA_D2202_PTP_MAX_30", { evaluator: "11.3.promiseWithin30Days", why: "§11.3 timer table: cadence-ceasing promise must have `due_on ≤ +30 calendar_days` (D2-2-02)." });
  o("FNMA_LL202605_QRPC_REASON_REQUIRED", { trigger: "`investor_events.building{family=qrpc}`", evaluator: "11.3.qrpcReasonPresent", why: "§11.3 timer table: QRPC action event build (5.7) requires reason type (LL-2026-05)." });
  o("SM_LICENSED_NEGOTIATION_GATE", { trigger: "`contact.modification_terms.discussed`", evaluator: "11.3.licensedNegotiator", why: "§11.3 timer table: `jurisdiction_rules.mlo_licensing_for_lossmit=false` or `licensed_specialist` on the call." });
  o("SM_THIRD_PARTY_AUTH_GATE", { trigger: "`contact.started{party_role∈{trusted_advisor, authorized_third_party}}`", evaluator: "11.3.thirdPartyAuthorized", why: "§11.3 timer table: valid unexpired authorization or in-call recorded consent." });
  // ---- 11.4 FDCPA ----------------------------------------------------------
  o("REGF_1006_100_RETENTION_3Y", { trigger: "`collection.activity.last`", offset: "+3 years", why: "§11.4 timer table: retain 3 years after last collection activity (recordings 3 years after the call) — subsumed by `life_of_loan_plus_4y` (Reg F §1006.100)." });
  o("REGF_1006_18E_DISCLOSURE_GATE", { trigger: "`communication.outbound.requested{fdcpa_debt_collector=true}`", evaluator: "11.4.disclosureFragmentPresent", why: "§11.4 timer table: disclosure fragment present (initial vs subsequent variant) on every DC-loan communication (Reg F §1006.18(e))." });
  o("REGF_1006_2_LCM_ONLY_VOICEMAIL", { trigger: "`communication.outbound.requested{fdcpa_debt_collector=true, channel=voicemail}`", evaluator: "11.4.limitedContentMessageOnly", why: "§11.4 timer table: voicemail on DC loan uses the limited-content message template only (Reg F §1006.2(j))." });
  o("REGF_1006_30A_FURNISH_GATE_14", { trigger: "`fdcpa.validation_notice.sent`", anchorField: "sent_on", offset: "+14 calendar_days", why: "§11.4 timer table: +14 calendar days with no undeliverability notice, or any telephone/in-person conversation, opens furnishing (Reg F §1006.30(a))." });
  o("REGF_1006_38_DISPUTE_CEASE_GATE", { trigger: "`fdcpa.dispute.received{written=true, within_validation_period=true}`", why: "§11.4 timer table: written dispute within the period → collection ceases until `verification_sent` (Reg F §1006.38(c))." });
  o("REGF_1006_38_OC_REQUEST_GATE", { trigger: "`fdcpa.original_creditor.requested{written=true, within_validation_period=true}`", why: "§11.4 timer table: written original-creditor request within the period → until `oc_sent` (Reg F §1006.38(d))." });
  o("REGF_1006_38_OVERSHADOW_GATE", { trigger: "`communication.outbound.requested{fdcpa_debt_collector=true, within_validation_period=true}`", evaluator: "11.4.noOvershadowing", why: "§11.4 timer table: no demand inconsistent with dispute rights; no 'pay within X days' shorter than the period (Reg F §1006.38(b))." });
  o("REGF_1006_42_ESIGN_GATE", { trigger: "`notice.channel_decision{template=NTC_REGF_1006_34_VALIDATION, channel=electronic}`", evaluator: "11.4.esignConsentForValidation", why: "§11.4 timer table: valid E-SIGN consent for class `regf_validation` (Reg F §1006.42)." });
  o("REGF_1006_6B3_WORKPLACE_GATE", { trigger: "`contact.attempt.requested{workplace_flag=true, employer_prohibits=true}`", evaluator: "11.4.workplaceProhibited", why: "§11.4 timer table: number/email flagged workplace + employer prohibits → no contact (Reg F §1006.6(b)(3))." });
  o("REGF_1006_6C_CEASE_GATE", { offset: "until fdcpa.cease.withdrawn", why: "§11.4 timer table: written cease is permanent unless withdrawn in writing (Reg F §1006.6(c))." });
  o("REGF_1006_6D5_SMS_RND_60", { trigger: "`contact.attempt.requested{mode=sms, fdcpa_debt_collector=true}`", evaluator: "11.4.reassignedNumberCheckFresh", why: "§11.4 timer table: last RND check ≤60 calendar days old, or consumer texted from the number ≤60 days ago (Reg F §1006.6(d)(5))." });
  o("REGF_1006_6E_OPTOUT_PRESENT", { trigger: "`communication.outbound.requested{fdcpa_debt_collector=true, channel∈{email, sms}}`", evaluator: "11.4.optOutPresent", why: "§11.4 timer table: opt-out statement present; no fee (Reg F §1006.6(e))." });
  o("SM_REGF_VERIFICATION_RESPONSE_30", { trigger: "`fdcpa.dispute.received`", why: "§11.4 timer table: dispute received → verification sent within 30 calendar days (policy)." });
  // ---- 11.5 imminent default ----------------------------------------------
  o("CO_AI_ACT_PRE_DECISION_NOTICE", { trigger: "`imminent_default.evaluating{state=CO, ai_influenced=true}`", evaluator: "11.5.preDecisionNoticeDelivered", why: "§11.5 timer table: pre-decision notice delivered before any AI-influenced adverse determination (Colorado SB 24-205)." });
  o("FNMA_D2101_CASH_RESERVE_25000", { trigger: "`imminent_default.evaluating`", evaluator: "11.5.cashReserveBelow25000", why: "§11.5 timer table: `cash_reserves_cents < 2,500,000` (waived for PCS >50 mi on liquidation track) (D2-1-01)." });
  o("FNMA_D2101_ELIGIBILITY_WINDOW_60", { trigger: "`imminent_default.evaluating`", evaluator: "11.5.delinquentUnder60", why: "§11.5 timer table: `regx_days_delinquent(evaluation_date) < 60` (D2-1-01)." });
  o("FNMA_D2101_FICO_AGE_90", { trigger: "`imminent_default.evaluating{path=credit}`", anchorField: "fico_date", evaluator: "11.5.ficoFresh", why: "§11.5 timer table: `evaluation_date − fico_date ≤ 90 calendar_days` (D2-1-01)." });
  o("FNMA_D2205_ACCEPT_14", { trigger: "`lossmit.offer.sent{kind∈{offer, counteroffer}}`", why: "§11.5 timer table: offer/counteroffer sent → acceptance within 14 calendar days (D2-2-05)." });
  o("FNMA_D2205_DECISION_5D_30D", { trigger: "`lossmit.evaluation.decided`", why: "§11.5 timer table: decision made → Evaluation Notice within 5 days, and ≤30 days after complete BRP (D2-2-05); the 30-day leg is `REGX_1024_41C1_EVALUATE_30`." });
  o("FNMA_D2205_INCOME_DOC_90", { trigger: "`lossmit.application.completed`", anchorField: "oldest_income_document_date", why: "§11.5 timer table: ≤90 calendar days at `brp_complete_at` (180 for disaster-impacted per D2-2-05)." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("REGX_1024_39A_LIVE_CONTACT_36_WARN_28", { trigger: "`loan.delinquency.window_opened{principal_residence=true}`", anchorField: "due_date", why: "§11.1 timer table: 'same' as REGX_1024_39A_LIVE_CONTACT_36; warning at due_date + 28." });
  o("REGF_1006_14_POST_CONVERSATION_7", { trigger: "`contact.completed{outcome∈{conversation, qrpc}, fdcpa_debt_collector=true}`", why: "§11.1 timer table: `contacts{outcome ∈ conversation,qrpc}` on a DC loan → no call for 7 calendar days (Reg F §1006.14(b)(2)(ii))." });
  o("SM_QRPC_HUMAN_VERIFY_1BD", { trigger: "`contact.qrpc.established{ai_voice_counts=false}`", anchorField: "achieved_at", why: "§11.3 timer table: `qrpc_complete` while AI voice doesn't count (or sampled ≥10 %, `contact.qrpc.established{sampled=true}`) → human verification within 1 `business_days_servicer`." });
  o("REGF_1006_34_ASSUMED_RECEIPT_5D", { trigger: "`fdcpa.validation_notice.sent`", anchorField: "sent_on", why: "§11.4 timer table: `validation_sent_at` → +5 `business_days_federal` = `assumed_receipt_on` (Reg F §1006.34(b)(3))." });
  o("REGF_1006_34_VALIDATION_PERIOD_30", { trigger: "`fdcpa.validation_notice.assumed_received`", anchorField: "assumed_receipt_on", why: "§11.4 timer table: `assumed_receipt_on` + 30 calendar days = `validation_period_end_on` (Reg F §1006.34(b)(5))." });
  o("SM_ID_SMDU_SUBMIT_2BD", { trigger: "`imminent_default.eligible`", why: "§11.5 timer table: `eligible` → SMDU submission within 2 `business_days_servicer`." });
  o("SM_ID_REVIEWER_SLA_2BD", { trigger: "`imminent_default.reviewer_pending`", why: "§11.5 timer table: `reviewer_pending` → reviewer decision within 2 `business_days_servicer`." });
  o("FNMA_D2101_FORM182_ADVERSE_30", { trigger: "`smdu.case.declined{current_at_evaluation=true, counteroffer_accepted=false}`", why: "§11.5 timer table: `smdu_declined` for a borrower current at evaluation (no accepted counteroffer) → Form 182 within 30 calendar days (D2-1-01)." });
  o("REGB_1002_9_ADVERSE_ACTION_30", { trigger: "`lossmit.application.completed{outcome=adverse}`", anchorField: "brp_complete_at", why: "§11.5 timer table: completed application (`brp_complete_at`) with an adverse outcome → adverse action notice within 30 calendar days (Reg B §1002.9)." });
  applyEarlyInterventionSatisfiedOverrides(reg);
}

/** Satisfaction events / evaluators for the §11 rows whose "Satisfied by" column is prose or empty. */
export function applyEarlyInterventionSatisfiedOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 11.1
  o("FNMA_D2202_CEASE_PRE_SALE_30NJ", { evaluator: "11.1.preSaleContactAllowed", why: "§11.1 timer table: outbound attempts blocked from sale − 30 (non-judicial) unless `jurisdiction_rules.contact_required_through_sale` (D2-2-02)." });
  o("FNMA_D2202_CONTINUE_AFTER_210", { satisfied: "`contact.attempted{direction=outbound}`", why: "§11.1 timer table: 'same as EVERY_7' — the next outbound attempt." });
  o("REGF_1006_14_POST_CONVERSATION_7", { evaluator: "11.1.postConversationCooloff", why: "§11.1 timer table: consent-based callback exception (`regf_exclusion=consent_within_7d`) or 7 days elapsed (Reg F §1006.14(b)(2)(ii))." });
  o("REGX_1024_39A_LIVE_CONTACT_36_WARN_28", { satisfied: "`contact.live.established`", why: "§11.1 timer table: 'same' as REGX_1024_39A_LIVE_CONTACT_36 — live contact in the window." });
  o("REGX_1024_39A_RESUME_AFTER_BK_NEXT_DUE", { satisfied: "`loan.delinquency.window_opened{after_bk_resume=true}`", why: "§11.1 timer table: 'windows re-open from that due date' (§1024.39(c)(2)(i))." });
  o("SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD", { satisfied: "`contact.attempted{mode=human_voice}`", why: "§11.1 timer table: 'human attempt logged (`mode=human_voice`)'." });
  o("TCPA_64_1200_A10_REVOCATION_HONOR_10BD", { satisfied: "`consent.revocation.honored`", why: "§11.1 timer table: 'channel blocked for that number/address' — honored at commit (47 CFR 64.1200(a)(10))." });
  // ---- 11.2
  o("FNMA_D2204_BSP_AFTER_QRPC_3BD", { satisfied: "`solicitation_package.sent{kind=bsp}`", why: "§11.2/11.3 timer tables: '`solicitation_packages{kind=bsp}.sent_at`' (D2-2-04)." });
  o("REGX_1024_39C2II_DISCHARGE_PAYMENT_REARM", { satisfied: "`payment.applied{received_after_petition=true}`", why: "§11.2 timer table: (b) re-arms on the first post-petition `payment.applied` (§1024.39(c)(2)(ii))." });
  o("REGX_1024_39C_ONCE_PER_CASE_GATE", { evaluator: "11.2.onceBkNoticePerCase", why: "§11.2 timer table: a second bk notice for the same case (reopened included) is refused (comment 39(c)(2)-1)." });
  o("REGX_1024_39C_RESUME_NEXT_DUE", { satisfied: "`loan.delinquency.window_opened{after_bk_resume=true}`", why: "§11.2 timer table: 'windows from that due date follow the standard rules' (§1024.39(c)(2)(i))." });
  // ---- 11.3
  o("FNMA_D2210_INSPECTION_SUSPEND_30", { evaluator: "11.3.qrpcWithin30Days", why: "§11.3 timer table: informational gate read by the inspection scheduler — QRPC within the last 30 days on an occupied property (D2-2-10)." });
  o("SM_QRPC_HUMAN_VERIFY_1BD", { satisfied: "`contact.qrpc.reviewed{outcome∈{qrpc_verified, qrpc_rejected}}`", why: "§11.3 timer table: '`qrpc_verified` or `qrpc_rejected` (with human call task)'." });
  o("SM_QRPC_STALE_30", { satisfied: "`contact.qrpc.established`", why: "§11.3 timer table: 'new QRPC, plan active, or resolution' — a fresh QRPC re-arms the recurring policy clock." });
  // ---- 11.4
  o("REGF_1006_100_RETENTION_3Y", { satisfied: "`records.retention.expired{class=regf_3y}`", why: "§11.4 timer table: retention rule — subsumed by `life_of_loan_plus_4y` (Reg F §1006.100)." });
  o("REGF_1006_30A_FURNISH_GATE_14", { satisfied: "`fdcpa.furnishing_gate.opened`", why: "§11.4 timer table: '`furnishing_gate_open_at` set' (Reg F §1006.30(a))." });
  o("REGF_1006_34_ASSUMED_RECEIPT_5D", { satisfied: "`fdcpa.validation_notice.assumed_received`", why: "§11.4 timer table: rule row — `assumed_receipt_on` computed (Reg F §1006.34(b)(5))." });
  o("REGF_1006_34_VALIDATION_PERIOD_30", { satisfied: "`fdcpa.validation_period.ended`", why: "§11.4 timer table: 'period end' (Reg F §1006.34(b)(5))." });
  o("REGF_1006_38_OC_REQUEST_GATE", { satisfied: "`notice.sent{code=NTC_REGF_1006_38_ORIGINAL_CREDITOR}`", why: "§11.4 timer table: '`NTC_REGF_1006_38_ORIGINAL_CREDITOR` sent' (Reg F §1006.38(c))." });
  o("REGF_1006_6B2_ATTORNEY_GATE", { satisfied: "`fdcpa.attorney_gate.released{reason∈{consent, nonresponse_30d}}`", why: "§11.4 timer table: 'until attorney consents or fails to respond for 30 calendar days' (Reg F §1006.6(b)(2))." });
  o("REGF_1006_6C_CEASE_GATE", { satisfied: "`fdcpa.cease.withdrawn{written=true}`", why: "§11.4 timer table: 'permanent (unless withdrawn in writing)' (Reg F §1006.6(c))." });
  o("SM_REGF_VERIFICATION_RESPONSE_30", { satisfied: "`notice.sent{code=NTC_REGF_1006_38_VERIFICATION}`", why: "§11.4 timer table: 'verification sent'." });
  // ---- 11.5
  o("FNMA_D2101_FORM182_ADVERSE_30", { satisfied: "`notice.sent{code=NTC_FNMA_A42106_FORM182_ADVERSE_ACTION}`", why: "§11.5 timer table: '`NTC_FNMA_A42106_FORM182_ADVERSE_ACTION` sent' (D2-1-01)." });
  o("FNMA_D2205_ACCEPT_14", { satisfied: "`lossmit.offer.accepted`", why: "§11.5 timer table (12.2 owns): 'acceptance (verbal/written/payment)' (D2-2-05)." });
  o("FNMA_D2205_DECISION_5D_30D", { satisfied: "`lossmit.evaluation_notice.sent`", why: "§11.5 timer table (12.2 owns): 'Evaluation Notice' (D2-2-05)." });
  o("FNMA_D2205_INCOME_DOC_90", { evaluator: "11.5.incomeDocsFresh", why: "§11.5 timer table: validation — oldest income document ≤90 days at `brp_complete_at` (180 disaster) (D2-2-05)." });
  o("FNMA_SMDU_PORTAL_TASK_1BD", { satisfied: "`human_portal_task.completed{kind=smdu}`", why: "§11.5 timer table: 'task completed with decision attached'." });
  o("REGB_1002_9_ADVERSE_ACTION_30", { satisfied: "`notice.sent{code=NTC_FNMA_A42106_FORM182_ADVERSE_ACTION}`", why: "§11.5 timer table: 'adverse-action notice (combined with Form 182 / 12.2 denial notice)' (Reg B §1002.9)." });
  o("REGX_1024_41B2_LM_ACK_5", { satisfied: "`notice.sent{code∈{NTC_REGX_41B2_ACK_COMPLETE, NTC_REGX_41B2_ACK_INCOMPLETE}}`", why: "§11.5 timer table (12.1 owns): 'acknowledgment sent' (§1024.41(b)(2))." });
  o("REGX_1024_41C1_EVALUATE_30", { satisfied: "`lossmit.evaluation_notice.sent`", why: "§11.5 timer table (12.2 owns): 'evaluation notice sent' (§1024.41(c)(1))." });
  o("SM_ID_SMDU_SUBMIT_2BD", { satisfied: "`smdu.submission.acknowledged`", why: "§11.5 timer table: 'SMDU ack / portal task complete'." });
}
