/**
 * Registry overrides for Section 13 (foreclosure) timers whose spec rows are
 * prose. State allowable timeframes and suspension ladders are computed
 * anchors; firm/pleading approvals are evaluator-backed gates.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyForeclosureTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 13.1 referral timing -----------------------------------------------
  o("FNMA_E1202_NONPR_REFER_BY_120", { trigger: "`loan.delinquency.day_reached{fnma_day=90, principal_residence=false}`", anchorField: "earliest_unpaid_due_date", why: "§13.1 timer table: non-principal-residence loan reaches day 90 → refer by earliest unpaid due date +120 calendar days; suspension ladder per E-1.2-02 / E-3.2-04 applied by `13.1.referralSuspension`." });
  o("REGX_1024_41F1_120_DAY_GATE", { evaluator: "13.1.preForeclosureReviewPeriodElapsed", why: "§13.1 timer table: `assertGateOpen` by `foreclosure.refer` / `foreclosure.first_notice.authorize` — condition-shaped over the §1024.31 delinquency counter (day 121; non-principal-residence and small-servicer exemptions)." });
  o("REGX_1024_41G_TRIAL_PERFORMING_FC_GATE", { trigger: "`lossmit.trial.started`", evaluator: "13.2.trialPerformingNoSale", why: "§13.2 timer table: trial active and performing → no FC sale/first notice until `lossmit.agreement.defaulted`; asserted by the sale/first-notice commands." });
  // ---- 13.2 holds ----------------------------------------------------------
  o("FNMA_E3207_MAF_NOTICE_7", { evaluator: "13.2.saleAtLeast7DaysAfterMafNotice", why: "§13.2 timer table: sale must be ≥7 days after MAF notice to permit postponement (E-3.2-07)." });
  o("FNMA_E3401_EXPEDITED_REVIEW_CERT", { anchorField: "certification_window_opens_on", offset: "−1 calendar_days", why: "§13.2 timer table: complete before `foreclosure.sale.certification_window.opened` (sale − 15 days) (E-3.4-01)." });
  o("FNMA_E3401_SHORTSALE_MARKETING_45", { anchorField: "shortsale_stage_deadline", offset: "0", why: "§13.2 timer table: +45 (marketing) / +15 (offer) / +60 (approved) calendar days by triggering event — computed by `13.2.shortSaleStageDeadline` (E-3.4-01)." });
  o("STATE_CA_2924_18_DUAL_TRACK_GATE", { trigger: "`lossmit.application.completed{state=CA, first_lien=true, owner_occupied=true}`", offset: "until lossmit.application.exited", why: "§13.2 timer table: complete first-lien application (owner-occupied) → NOD/NOS blocked while pending (Cal. Civ. Code §2924.18)." });
  o("STATE_MN_582_043_DUAL_TRACK_GATE", { trigger: "`lossmit.application.received{state=MN}`", offset: "until lossmit.application.exited", why: "§13.2 timer table: MN application pending → refer blocked; sale halted if received before midnight of the 7th business day before sale (Minn. Stat. 582.043)." });
  // ---- 13.3 preparation ----------------------------------------------------
  o("FNMA_E1102_CUSTODIAN_DOC_REQUEST_95", { trigger: "`loan.delinquency.day_reached{fnma_day=60}`", anchorField: "earliest_unpaid_due_date", why: "§13.3 timer table: delinquency day 60 → custodian document request by earliest unpaid due date +95 calendar days (E-1.1-02)." });
  o("FNMA_E1102_MORTGAGEE_OF_RECORD_ID_90", { trigger: "`loan.delinquency.day_reached{fnma_day=60}`", anchorField: "earliest_unpaid_due_date", why: "§13.3 timer table: delinquency day 60 → mortgagee of record identified by +90 calendar days (E-1.1-02)." });
  o("FNMA_E3206_OUTREACH_STOP_60_30", { anchorField: "outreach_stop_on", offset: "0", why: "§13.3 timer table: sale −60 (judicial) / −30 (non-judicial) calendar days — computed by `13.3.outreachStopDate` (E-3.2-06)." });
  o("FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE", { anchorField: "allowable_timeframe_ends_on", offset: "0", why: "§13.3 timer table: state allowable days (+credited delays) from `lpi_due_date` — computed by `13.5.allowableTimeframe` (E-3.2-15)." });
  o("FNMA_E3305_VALUATION_ORDER_WINDOW_90", { anchorField: "sale_at", offset: "opens −90 calendar_days, closes −10 calendar_days", why: "§13.3 timer table: order no earlier than sale −90 cd; result expected +10 cd from order (E-3.3-05)." });
  o("SM_FC_REFER_WITHIN_5CD_OF_ELIGIBLE", { trigger: "`foreclosure.referral.eligible`", anchorField: "eligibility_date", why: "§13.3 timer table: all gates open ∧ review complete → referral within 5 calendar days of eligibility." });
  // ---- 13.4 pre-referral review -------------------------------------------
  o("FNMA_E3201_PRECONDITIONS_GATE", { trigger: "`foreclosure.prereferral_review.started`", evaluator: "13.4.breachLetterAndSolicitationExpired", why: "§13.4 timer table: breach letter expiry ∧ solicitation deadline expiry (E-3.2-01)." });
  o("FNMA_E3201_PREREFERRAL_REVIEW_15", { trigger: "`loan.delinquency.day_reached{referral_minus_15=true}`", anchorField: "referral_required_on", why: "§13.4 timer table: window [−15, 0] calendar days before `referral_required_on`; must complete before referral (E-3.2-01)." });
  o("FNMA_E3204_NONPR_FIRST_PAYMENT_EOM", { anchorField: "first_payment_due_date", offset: "last day of that month", why: "§13.4 timer table: `lossmit.offer.accepted` → first payment by end of the month it is due, else referral resumes (E-3.2-04)." });
  o("FNMA_F108_MA_LEAD_PAINT_SEARCH_GATE", { trigger: "`foreclosure.prereferral_review.started{state=MA}`", evaluator: "13.4.maCitationSearchCompleted", why: "§13.4 timer table: MA — lead-paint citation search completed before referral (F-1-08)." });
  o("SM_DMDC_VERIFY_PRE_REFERRAL_30", { trigger: "`foreclosure.prereferral_review.started`", anchorField: "latest_dmdc_certificate_date", evaluator: "13.4.dmdcCertificateFresh", why: "§13.4 timer table: DMDC certificate ≤30 calendar days old at referral." });
  o("SM_PREREFERRAL_RE_REVIEW_DAILY", { trigger: "`foreclosure.prereferral_review.completed{outcome=hold}`", offset: "daily", why: "§13.4 timer table: any `hold_*` outcome → re-review daily 00:05 loan tz until release." });
  // ---- 13.5 timeframes -----------------------------------------------------
  o("FNMA_E3215_TIMEFRAME_WARNING_70", { trigger: "`foreclosure.referral.sent`", anchorField: "allowable_timeframe_warning_on", offset: "0", why: "§13.5 timer table: 70% of the allowable timeframe elapsed — computed by `13.5.allowableTimeframe` (E-3.2-15)." });
  o("FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE", { trigger: "`firm.method_deviation.proposed`", why: "§13.5 timer table: firm proposes a non-preferred method → hold until `form20.response{approved}` (13.7)." });
  o("FNMA_F121_STATUS_CODE_TIMELY_BD2", { trigger: "`period.month_end{foreclosure_status_changed=true}`", offset: "BD2 17:00 ET", why: "§13.5 timer table: month-end status change → BD2 (legacy) / 03:00 ET next BD (event mode, 2027) (F-1-21)." });
  o("SM_EXHIBIT_WATCH_MONTHLY", { trigger: "`schedule.tick{cadence=monthly, weekday=wednesday, ordinal=2}`", why: "§13.5 timer table: monthly (second Wednesday + LL feed) exhibit hash check." });
  // ---- 13.6 firms / DRA ----------------------------------------------------
  o("FNMA_A4201_RECORDS_7Y", { trigger: "`firm.selection.decided`", why: "§13.6 timer table: firm decision records retained 7 years (A4-2-01)." });
  o("FNMA_A4201_RETAINED_FIRM_GATE", { trigger: "`foreclosure.referral.requested`", evaluator: "13.6.firmRetainedAndCurrent", why: "§13.6 timer table: firm `retained` for that state ∧ LRA executed ∧ training done ∧ E&O unexpired (A4-2-01)." });
  o("FNMA_E1101_BULK_TRANSFER_NOTICE_5BD", { trigger: "`firm.matter_transfer.requested{bulk_threshold_reached=true}`", why: "§13.6 timer table: matter transfer making ≥30 in 6 months same state → Fannie Mae notice +5 `business_days_servicer` (E-1.1-01)." });
  o("FNMA_E1101_POST_SALE_TRANSFER_APPROVAL_GATE", { trigger: "`firm.matter_transfer.requested{post_sale=true}`", evaluator: "13.6.fannieMaePriorApproval", why: "§13.6 timer table: transfer of a matter after a sale requires Fannie Mae prior approval (E-1.1-01)." });
  o("FNMA_F105_EXPENSE_CLAIM_60", { trigger: "`claim.milestone.reached{kind∈{sale, reinstatement, payoff, workout}}`", why: "§13.6 timer table: claim milestone → P360 expense claim within +60 calendar days (F-1-05)." });
  o("SM_DRA_EVENT_EXPECTED_2BD", { trigger: "`foreclosure.milestone.recorded`", why: "§13.6 timer table: internal milestone/instruction → matching DRA event within +2 `business_days_servicer`." });
  o("SM_DRA_RECONCILE_DAILY", { trigger: "`schedule.tick{cadence=daily_business_servicer}`", offset: "same day, 07:00 ET", why: "§13.6 timer table: daily BD DRA import at 07:00 ET." });
  o("SM_FIRM_EO_EXPIRY_30", { trigger: "`firm.eo_policy.recorded`", anchorField: "eo_expires_on", offset: "−30 calendar_days", why: "§13.6 timer table: `eo_expires_on − 30` → renewal evidence; referrals paused at expiry." });
  // ---- 13.7 litigation -----------------------------------------------------
  o("FNMA_E1301_PLEADING_REVIEW_GATE", { trigger: "`litigation.pleading.due`", anchorField: "filing_deadline", offset: "−5 business_days_servicer", why: "§13.7 timer table: Fannie Mae given the draft ≥5 `business_days_servicer` before the filing deadline (policy for 'sufficient opportunity', E-1.3-01)." });
  o("FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE", { trigger: "`litigation.removal_or_appeal.proposed`", evaluator: "13.7.fannieMaePriorWrittenApproval", why: "§13.7 timer table: removal to federal court / appeal requires Fannie Mae prior written approval (E-1.3-01)." });
  o("FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE", { trigger: "`lossmit.offer.sent{litigated=true}`", offset: "+5 business_days_servicer", why: "§13.7 timer table: 12.x deferral/modification offer on a litigated loan → counsel notified with sufficient opportunity (policy 5 BD) (E-1.3-01)." });
  o("FNMA_E1302_FORM20_EXCEPTION_TRIGGER", { trigger: "`litigation.trigger{stage∈{summary_judgment, briefing, trial}, matter∈{standing, mers, hamp}}`", offset: "0", why: "§13.7 timer table: `litigation.trigger{summary_judgment, briefing, trial}` for standing/MERS/HAMP matters → Form 20 on the trigger date (E-1.3-02)." });
  o("LITIGATION_HOLD", { trigger: "`litigation.classified{routine=false}`", why: "§13.7 timer table: non-routine classification with a challenge to enforceability/standing, or Fannie Mae direction → hold until direction/resolution." });
  o("SM_FORM20_RESPONSE_FOLLOWUP_10BD", { trigger: "`form20.submitted`", why: "§13.7 timer table: Form 20 submitted → Fannie Mae direction recorded within +10 `business_days_fannie_et`." });
  o("SM_LITIGATION_STATUS_UPDATE_MONTHLY", { trigger: "`litigation.classified{routine=false}`", why: "§13.7 timer table: non-routine matter open → monthly update to Fannie Mae (E-1.3-01 'periodically')." });
  // ---- 13.8 SCRA -----------------------------------------------------------
  o("SCRA_3931_AFFIDAVIT_GATE", { trigger: "`firm.dispositive_motion.proposed{judicial=true}`", evaluator: "13.8.affidavitOnFreshCertificates", why: "§13.8 timer table: affidavit executed by `signing_officer` on certificates ≤30 days old (policy) and filed (50 U.S.C. §3931)." });
  o("SCRA_3931G_DEFAULT_JUDGMENT_REOPEN_90", { trigger: "`scra.status.verified{post_judgment_on_duty=true}`", anchorField: "service_end_date", why: "§13.8 timer table: judgment against an unlocated defendant later found on duty → reopening window +90 calendar days after service end (50 U.S.C. §3931(g))." });
  o("SM_DMDC_PERIODIC_ACTIVE_FC_90", { trigger: "`foreclosure.referral.sent`", why: "§13.8 timer table: foreclosure case open → DMDC verification every 90 calendar days." });
  o("SM_DMDC_VERIFY_DAY45", { trigger: "`loan.delinquency.day_reached{regx_day=45}`", anchorField: "due_date", why: "§13.8 timer table: delinquency day 45 → DMDC verification (due date +45 calendar days)." });
  o("SM_DMDC_VERIFY_PRE_EVICTION_30", { trigger: "`eviction.referral.scheduled`", anchorField: "eviction_referral_on", why: "§13.8 timer table: eviction referral → DMDC verification within the 30 calendar days before." });
  // ---- 13.9 SCRA subsidy / ARM ---------------------------------------------
  o("FNMA_F119_ARM_TXN83", { trigger: "`arm.adjustment.scheduled{scra_cap_active=true}`", offset: "next business_days_fannie_et at 20:00 ET", why: "§13.9 timer table: ARM scheduled adjustment during cap → LAR 83 per 5.1 timing (F-1-19)." });
  o("FNMA_F119_FORM1022_BD9", { trigger: "`scra.rate_reduction.applied`", anchorField: "following_month_start", offset: "BD9", why: "§13.9 timer table: rate reduction / payment change / restoration (portfolio, PFP) → Form 1022 by BD9 of the following month (F-1-19); `scra.rate.restored` arms the same code." });
  o("FNMA_F119_MBS_UPLOAD_CD15", { trigger: "`scra.rate_reduction.applied{mbs=true}`", offset: "CD15 of the following month", why: "§13.9 timer table: MBS — upload accepted by CD15 (F-1-19)." });
  o("FNMA_F119_MI_DISBURSEMENT_CHECK_M2", { trigger: "`scra.period.started`", offset: "monthly", why: "§13.9 timer table: period active/tail — monthly custodial receipt match at month-end − 2 days (F-1-19)." });
  o("FNMA_F119_SUBSIDY_ADJUST_12M", { trigger: "`scra.subsidy.activated`", why: "§13.9 timer table: subsidy method active → recalculated + letter every 12 months (F-1-19)." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("FNMA_E3215_TIMEFRAME_WARNING_70", { trigger: "`foreclosure.referral.sent`", anchorField: "allowable_timeframe_warning_on", offset: "0", why: "§13.5 timer table: 'same' as FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE → `foreclosure.referral.sent`; 70% elapsed (E-3.2-15)." });
  applyForeclosureSatisfiedOverrides(reg);
}

/** Satisfaction events / evaluators for the §13 rows whose "Satisfied by" column is prose, "same", or empty. */
export function applyForeclosureSatisfiedOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 13.1 gates
  o("REGX_1024_41F2_PRE_FILING_APP_GATE", { evaluator: "13.1.preFilingAppGateOpen", why: "§13.1 timer table: closed from a complete application received before the first notice until an (f)(2)(i)–(iii) exit event (§1024.41(f)(2))." });
  o("FNMA_D1301_DISASTER_FC_APPROVAL_GATE", { evaluator: "13.1.disasterApprovalOnFile", why: "§13.1/13.4 timer tables: 'until fnma.disaster_fc.approved' — the gate opens only on Fannie Mae's written approval (D1-3-01)." });
  o("SCRA_3953C_FC_PROTECTION_GATE", { evaluator: "13.8.protectionGateOpen", why: "§13.1/13.8 timer tables: service_end_on + 1 calendar year inclusive (or court order/§3918 agreement) — 13.8 owns the gate (50 U.S.C. 3953(c))." });
  // ---- 13.2 dual tracking
  o("REGX_1024_41G_DUAL_TRACK_GATE", { evaluator: "13.2.dualTrackGateOpen", why: "§13.2 timer table: closed until an (g)(1)–(3) exit; asserted by judgment_motion.authorize / sale.certify / sale.conduct.authorize (§1024.41(g))." });
  o("FNMA_E3401_EXPEDITED_REVIEW_CERT", { satisfied: "`notice.sent{code=NTC_FNMA_E3401_EXPEDITED_RESULT}`", why: "§13.2 timer table: 'determination sent' before the certification window opens (E-3.4-01)." });
  o("FNMA_E3401_SHORTSALE_MARKETING_45", { satisfied: "`liquidation.case.status_changed{status∈{approved, closed, listing_expired, declined}}`", why: "§13.2 timer table: '12.x events' — the short-sale case leaves the marketing/review window (E-3.4-01)." });
  o("STATE_MN_582_043_DUAL_TRACK_GATE", { evaluator: "13.2.mnDualTrackGateOpen", why: "§13.2 timer table: refer blocked while an MN application (complete or not) is pending; sale halted if received before the 7th business day before sale (Minn. Stat. §582.043)." });
  o("STATE_CA_2924_18_DUAL_TRACK_GATE", { evaluator: "13.2.caDualTrackGateOpen", why: "§13.2 timer table: NOD/NOS blocked while a complete first-lien application is pending on an owner-occupied loan (Cal. Civ. Code §2924.18)." });
  // ---- 13.3 referral
  o("FNMA_E1202_REFER_NO_EARLIER_121", { satisfied: "`foreclosure.referral.sent`", why: "§13.3 timer table: 'assertGateOpen by foreclosure.refer' — the referral itself, on or after day 121 (E-1.2-02)." });
  o("FNMA_E3205_ADVANCE_REQUEST_10BD", { satisfied: "`attorney.advance.decided{result∈{funded, declined}}`", why: "§13.3 timer table: '`attorney.advance.funded/declined`' (E-3.2-05)." });
  o("FNMA_E3206_OUTREACH_STOP_60_30", { satisfied: "`outreach.campaign.closed{reason=sale_proximity}`", why: "§13.3 timer table: 'outreach campaign closed' at sale − 60 (judicial) / − 30 (non-judicial) (E-3.2-06)." });
  o("FNMA_E3205_BID_INSTRUCTIONS_5BD", { satisfied: "`attorney.instruction.acknowledged{kind=BID_INSTRUCTIONS}`", why: "§13.3 timer table: 'bid_instructions.issued ∧ firm_ack' — the firm's acknowledgment of the bid instruction (E-3.3-05)." });
  o("FNMA_E3502_TPS_DEPOSIT_REMIT_5BD", { satisfied: "`remittance.sent{kind=tps_deposit}`", why: "§13.3 timer table: 'deposit remitted' (E-3.5-02)." });
  // ---- 13.4 prereferral review
  o("FNMA_E3204_NONPR_OFFER_14", { satisfied: "`lossmit.offer.responded{response∈{accepted, rejected, expired}}`", why: "§13.4 timer table: 'acceptance / expiry' of the retention offer (E-3.2-04)." });
  o("FNMA_E3204_NONPR_FIRST_PAYMENT_EOM", { satisfied: "`workout_plan.payment.received{first=true}`", why: "§13.4 timer table: 'first payment received → hold_performing' (E-3.2-04)." });
  o("SM_DISASTER_FC_RESPONSE_FOLLOWUP_10BD", { satisfied: "`fnma.disaster_fc.responded`", why: "§13.4 timer table: 'Fannie Mae response recorded' (D1-3-01; policy follow-up)." });
  o("SM_PREREFERRAL_RE_REVIEW_DAILY", { satisfied: "`prereferral.review.completed{outcome∈{refer, refer_expedited}}`", why: "§13.4 timer table: 'outcome changes' — the daily re-review ends when a hold resolves to refer." });
  // ---- 13.5 timeframes
  o("FNMA_E3215_TIMEFRAME_WARNING_70", { satisfied: "`foreclosure.sale.held`", why: "§13.5 timer table: the 70% warning is informational; the clock closes with the sale (E-3.2-15)." });
  o("FNMA_F121_STATUS_CODE_TIMELY_BD2", { satisfied: "`investor.event.accepted{kind=delinquency_status}`", why: "§13.5 timer table: 'accepted status event' (F-1-21)." });
  o("FNMA_A14202_RESCISSION_FEE_EXPOSURE", { trigger: "`foreclosure.sale.rescinded{cause=servicer_error}`", offset: "0 calendar_days", satisfied: "`comp_fee_exposure.booked{kind=rescission}`", why: "§13.5 timer table: informational — $1,000 + third-party costs booked as exposure on rescission (A1-4.2-02)." });
  o("FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE", { evaluator: "13.5.methodDeviationApproved", why: "§13.5 timer table: a non-preferred method needs Regional Counsel approval via Form 20 before first-notice authorization (Allowable Foreclosure Attorney Fees Exhibit)." });
  o("SM_COMP_FEE_BILL_REBUTTAL_30", { trigger: "`comp_fee_bill.received`", satisfied: "`comp_fee_bill.resolved{result∈{rebutted, accepted}}`", why: "§13.5 timer table: 'rebuttal submitted or bill accepted' (A1-4.2-02; 30-day window [UNVERIFIED])." });
  o("SM_EXHIBIT_WATCH_MONTHLY", { trigger: "`schedule.tick{cadence=monthly}`", offset: "monthly", satisfied: "`exhibit.checked{exhibit=allowable_timeframes}`", why: "§13.5 timer table: monthly exhibit hash check (second Wednesday + LL feed)." });
  // ---- 13.6 firms
  o("FNMA_A4201_FORM200_RESPONSE_15BD", { trigger: "`form200.submitted`", satisfied: "`form200.responded`", why: "§13.6 timer table: 'Fannie Mae response' — No Objection expected within 15 BD (A4-2.2-01)." });
  o("FNMA_A4202_FIRM_ESCALATION_2BD", { trigger: "`attorney_escalation.discovered`", satisfied: "`firm.escalation.sent{to=loanservicing}`", why: "§13.6 timer table: 'email to loanservicing@ sent (tracked)' (A4-2.2-02)." });
  o("FNMA_A4204_SUSPENSION_NOTICE_5BD", { trigger: "`firm.suspension.proposed`", satisfied: "`fnma.notified{kind=firm_suspension, plan_attached=true}`", why: "§13.6 timer table: 'Fannie Mae notified with plan' 5 BD before implementation (A4-2.2-04)." });
  o("FNMA_E1101_BULK_TRANSFER_NOTICE_5BD", { satisfied: "`fnma.notified{kind=bulk_matter_transfer}`", why: "§13.6 timer table: 'notified' (E-1.1-01)." });
  o("SM_FIRM_EO_EXPIRY_30", { trigger: "`firm.eo_policy.expiring`", anchorField: "eo_expires_on", offset: "-30 calendar_days", satisfied: "`firm.eo_policy.renewed`", why: "§13.6 timer table: 'renewal evidence'; referrals pause at expiry (F-2-04)." });
  o("SM_INVOICE_REVIEW_10BD", { trigger: "`firm.invoice.received`", satisfied: "`firm.invoice.reviewed`", why: "§13.6 timer table: 'review result' (E-5-05)." });
  o("SM_INVOICE_PAY_30", { trigger: "`firm.invoice.approved`", satisfied: "`firm.invoice.paid`", why: "§13.6 timer table: 'payment sent'." });
  o("FNMA_F105_EXPENSE_CLAIM_60", { trigger: "`claim.milestone.reached{kind∈{sale, reinstatement, payoff, workout}}`", satisfied: "`claim.filed{system=p360}`", why: "§13.6 timer table: 'claim filed in P360' within 60 days (F-1-05)." });
  o("SM_DRA_RECONCILE_DAILY", { trigger: "`schedule.tick{cadence=daily}`", offset: "daily", satisfied: "`dra.snapshot.imported`", why: "§13.6 timer table: 'snapshot imported' (07:00 ET business days)." });
  o("SM_DRA_EVENT_EXPECTED_2BD", { trigger: "`attorney.instruction.acknowledged`", satisfied: "`dra.event.matched`", why: "§13.6 timer table: 'matching DRA event' within 2 BD; absence raises the exception (13.6-T7)." });
  o("FNMA_A4201_RECORDS_7Y", { satisfied: "`records.retention.released{kind=firm_selection}`", why: "§13.6 timer table: 7-year retention of firm selection records — closes on the retention release (A4-2.2-01)." });
  // ---- 13.7 litigation / environmental
  o("FNMA_E1302_FORM20_EXCEPTION_TRIGGER", { trigger: "`litigation.trigger{event∈{summary_judgment_motion, briefing, trial}}`", offset: "0 calendar_days", satisfied: "`form20.submitted`", why: "§13.7 timer table: the Form 20 exception trigger for standing/MERS/HAMP matters is the trigger event itself (E-1.3-02)." });
  o("FNMA_F108_ENV_LITIGATION_FORM20_0", { trigger: "`litigation.notice.received{environmental=true}`", offset: "0 calendar_days", satisfied: "`form20.submitted{environmental=true}`", why: "§13.7 timer table: 'Form 20 submitted' the same day (F-1-08 'immediately')." });
  o("FNMA_F108_ENV_NO_FORECLOSURE_GATE", { evaluator: "13.7.environmentalDirectionToProceed", why: "§13.7 timer table: '`environmental_hazards.fnma_direction=proceed`' (F-1-08)." });
  o("FNMA_F108_LEAD_PAINT_NOTIFY_30", { satisfied: "`fnma.servicing_rep.notified{kind=lead_paint}`", why: "§13.7 timer table: Servicing Representative notified with value, debt, children <8 and documentation (F-1-08)." });
  o("SM_ENV_SERVICING_REP_REPORT_2BD", { satisfied: "`fnma.servicing_rep.notified{kind=environmental_hazard}`", why: "§13.7 timer table: 'report sent' (F-1-08)." });
  o("FNMA_E1301_PLEADING_REVIEW_GATE", { evaluator: "13.7.pleadingDraftGivenInTime", why: "§13.7 timer table: Fannie Mae given the draft ≥5 BD before the deadline (E-1.3-01; policy)." });
  o("FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE", { evaluator: "13.7.counselNotifiedOfWorkout", why: "§13.7 timer table: 'counsel ack' before a deferral/modification offer leaves on a litigated loan (E-1.3-01)." });
  o("LITIGATION_HOLD", { evaluator: "13.7.litigationHoldReleased", why: "§13.7 timer table: 'until direction/resolution' — the hold releases on Fannie Mae direction or resolution." });
  o("SM_FORM20_RESPONSE_FOLLOWUP_10BD", { trigger: "`form20.submitted`", satisfied: "`form20.responded`", why: "§13.7 timer table: 'Fannie Mae direction recorded' (policy follow-up)." });
  o("SM_LITIGATION_STATUS_UPDATE_MONTHLY", { trigger: "`litigation.matter.opened{routine=false}`", offset: "monthly", satisfied: "`litigation.status_update.sent`", why: "§13.7 timer table: 'update sent to Fannie Mae' (E-1.3-01 'periodically')." });
  // ---- 13.8 SCRA foreclosure protection
  o("SM_DMDC_VERIFY_DAY45", { trigger: "`loan.delinquency.day_reached{day=45}`", offset: "0 calendar_days", satisfied: "`dmdc.verification.completed`", why: "§13.8 timer table: 'verification' at delinquency day 45." });
  o("SM_DMDC_VERIFY_PRE_FIRST_NOTICE_30", { trigger: "`foreclosure.first_notice.authorize.requested`", offset: "0 calendar_days", satisfied: "`dmdc.verification.completed{age_days_le=30}`", why: "§13.8 timer table: a verification ≤30 days old before first-notice authorization." });
  o("SM_DMDC_VERIFY_PRESALE_30", { satisfied: "`dmdc.verification.completed{purpose=presale_30}`", why: "§13.8 timer table: 'verification' at sale − 30." });
  o("SM_DMDC_VERIFY_PRESALE_7", { satisfied: "`dmdc.verification.completed{purpose=presale_7}`", why: "§13.8 timer table: 'verification' at sale − 7, re-run on each reschedule." });
  o("SM_DMDC_VERIFY_PRE_EVICTION_30", { trigger: "`eviction.referral.requested`", offset: "-30 calendar_days", satisfied: "`dmdc.verification.completed{purpose=pre_eviction}`", why: "§13.8 timer table: 'verification' before eviction referral." });
  o("SCRA_3953_TAIL_1Y", { satisfied: "`timer.lapsed{code=SCRA_3953_TAIL_1Y}`", why: "§13.8 timer table: 'tail expiry → gate open on the following day' — the tail is satisfied only by lapse (50 U.S.C. 3953(c); Feb 29 clamps to Feb 28)." });
  o("SM_DMDC_PERIODIC_ACTIVE_FC_90", { trigger: "`foreclosure.case.opened`", offset: "90 calendar_days", satisfied: "`dmdc.verification.completed{purpose=periodic_90}`", why: "§13.8 timer table: 'verification' every 90 days while a case is open." });
  o("SCRA_3931G_DEFAULT_JUDGMENT_REOPEN_90", { satisfied: "`judgment.reopen.decided`", why: "§13.8 timer table: the §3931(g) reopening window closes on the court's decision or lapse (50 U.S.C. 3931(g))." });
  // ---- 13.9 SCRA interest cap
  o("SCRA_3937B1_NOTICE_WINDOW_180", { satisfied: "`scra.request.received`", why: "§13.9 timer table: 'request received' within 180 days after release (50 U.S.C. 3937(b)(1))." });
  o("SCRA_3937_FEES_IN_CAP_GATE", { evaluator: "13.9.feesInsideCap", why: "§13.9 timer table: fees and charges (other than bona fide insurance) count as interest through cap_ends_on (50 U.S.C. 3937(d))." });
  o("FNMA_F119_MBS_UPLOAD_CD15", { trigger: "`scra.rate_reduction.applied{mbs=true}`", satisfied: "`fnma.upload.accepted{kind=form_1022}`", why: "§13.9 timer table: 'upload accepted' by CD15 of the following month (F-1-19)." });
  o("FNMA_F119_ARM_TXN83", { satisfied: "`investor.event.accepted{kind=lar_83}`", why: "§13.9 timer table: 'LAR/event accepted' for the ARM adjustment during the cap (F-1-19; 5.1)." });
  o("FNMA_F119_SUBSIDY_ADJUST_12M", { satisfied: "`scra.subsidy.recalculated`", why: "§13.9 timer table: 'payment recalculated + letter' at least annually (F-1-19)." });
  o("FNMA_F119_MI_DISBURSEMENT_CHECK_M2", { satisfied: "`custodial.receipt.matched{kind=scra_subsidy}`", why: "§13.9 timer table: 'custodial receipt matched' monthly (F-1-19)." });
  o("SM_SCRA_OVERPAYMENT_ELECTION_30", { trigger: "`notice.sent{code=NTC_SCRA_3937_OVERPAYMENT_ELECTION}`", satisfied: "`scra.overpayment.election_recorded`", why: "§13.9 timer table: 'election recorded'; the default election applies at lapse (decision 13.9-3)." });
}
