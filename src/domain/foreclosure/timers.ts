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
}
