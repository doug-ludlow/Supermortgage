/**
 * Registry overrides for Section 2 (cashiering) timers whose spec rows are
 * prose. Each override cites the row it encodes; condition-shaped gates and
 * rules name the domain evaluator that asserts them.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyCashieringTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 2.1 posting ---------------------------------------------------------
  o("SM_CASHIERING_POSTING_BACKLOG_GATE", { trigger: "`schedule.tick{job∈{late_charge.assessment.run, credit_reporting.cycle, payment.none}}`", evaluator: "2.1.noPostingBacklog",
    why: "§2.1 timer table: daily `late_charge.assessment.run` (2.7), `credit_reporting.cycle` (8.1), `payment.none` sweep (5.1) gate on zero items in `received/identified` with `received_on ≤ gate date`." });
  // ---- 2.2 suspense --------------------------------------------------------
  o("REGZ_1026_41D5_STATEMENT_SUSPENSE_DISCLOSURE", { trigger: "`statement.render_requested`", evaluator: "2.2.statementSuspenseDisclosure",
    why: "§2.2 timer table: statement generation must include (d)(3) amount and (d)(5) instructions whenever Σ unapplied > 0 (§1026.41(d)(5))." });
  o("SM_SUSPENSE_REEVAL_ON_TERMS_CHANGE_0", { offset: "same day", why: "§2.2 timer table: `loan_terms.activated` (P changes) re-evaluates accumulation in the same transaction." });
  // ---- 2.3 autodraft / ACH -------------------------------------------------
  o("FNMA_C1103_DRAFT_BY_PENALTY_FREE_DATE_GATE", { anchorField: "installment_due_date", evaluator: "2.3.settlementWithinGrace",
    why: "§2.3 timer table: settlement date must be ≤ due date + grace days (default 15) (C-1.1-03); file build validator." });
  o("NACHA_FRAUD_PROCEDURES_ANNUAL_REVIEW_365", { trigger: "`policy.adopted{policy=nacha_fraud}`", anchorField: "last_reviewed_on", offset: "every 365 calendar_days",
    why: "§2.3 timer table: policy adoption → annual review, 365 calendar days from last review (NACHA fraud procedures)." });
  o("NACHA_NSF_REINITIATION_180_MAX2", { trigger: "`ach.return.received{reason_code∈{R01, R09}}`", anchorField: "original_settlement_date", evaluator: "2.3.reinitiationLimit",
    why: "§2.3 timer table: `ach.return.received{R01,R09}`; ≤ 2 reinitiations within 180 calendar days of original settlement (NACHA)." });
  o("NACHA_RETURN_RATE_MONTHLY_WATCH", { trigger: "`period.month_end`", why: "§2.3 timer table: month end → monthly return-rate report." });
  o("NACHA_PRENOTE_WAIT_3BANKING_DAYS", { anchorField: "prenote_settlement_date", offset: "+3 business_days_federal",
    why: "§2.3 timer table: 'prenote settlement' + 3 banking days [PARTIALLY VERIFIED] — banking days proxied by the `federal` calendar; the registry's prose would otherwise parse as a calendar day." });
  o("REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10", { anchorField: "scheduled_settlement_date",
    why: "§2.3 timer table: anchor 'scheduled settlement date of the changed draft' — `loan_terms.activated` carries `scheduled_settlement_date` (2.4 re-amortization, 3.2 escrow change); −10 calendar days is the send-by date." });
  o("NACHA_WEB_ACCOUNT_VALIDATION_GATE", { trigger: "`autodraft.enrollment.authorized{sec_code∈{WEB, TEL}}`", evaluator: "2.3.accountValidated",
    why: "§2.3 timer table: `validation_status` ∈ validated_* before first live debit (NACHA WEB debit rule); account change re-arms." });
  o("REGE_1005_10C_STOP_PAYMENT_3BD_GATE", { anchorField: "scheduled_settlement_date", offset: "−3 business_days_federal",
    why: "§2.3 timer table: revocation received ≥ 3 business days (federal proxy) before settlement ⇒ entry must not be transmitted; later ⇒ best efforts (Reg E §1005.10(c))." });
  o("REGE_1005_10C_WRITTEN_CONFIRMATION_14", { trigger: "`autodraft.revocation.received{channel=oral}`", offset: "+14 calendar_days",
    why: "§2.3 timer table: oral revocation → 14 calendar days for written confirmation (only if elected; default not required)." });
  // ---- 2.4 curtailments ----------------------------------------------------
  o("FNMA_C1201_CURTAILMENT_APPLY_IMMEDIATE_0BD", { trigger: "`payment.received{designation=curtailment, delinquent=false}`", offset: "same day",
    why: "§2.4 timer table: curtailment on a current loan applied the same `business_days_servicer` day (C-1.2-01)." });
  o("FNMA_C1201_DELINQUENT_CURE_FIRST_GATE", { trigger: "`payment.received{designation=curtailment, delinquent=true}`", evaluator: "2.4.dueInstallmentsFirst",
    why: "§2.4 timer table: curtailment on a loan with any unpaid installment — funds satisfy due installments before principal reduction (C-1.2-01)." });
  o("FNMA_C1201_NIB_ORDER_GATE", { trigger: "`payment.received{designation=curtailment, non_interest_bearing_upb>0}`", evaluator: "2.4.nibOrder",
    why: "§2.4 timer table: amount < IB UPB → IB only; amount ≥ IB UPB → NIB first then IB (C-1.2-01)." });
  o("FNMA_C1201_REAPPLY_ELIGIBILITY_GATE", { evaluator: "2.4.reapplyEligible", why: "§2.4 timer table: all four C-1.2-01 reapplication conditions true; decision record." });
  o("SM_CURTAILMENT_PAYOFF_ROUTE_GATE", { trigger: "`payment.received{designation=curtailment}`", evaluator: "2.4.routeToPayoff",
    why: "§2.4 timer table: curtailment amount ≥ interest-bearing UPB + NIB routes to payoff (16.1/16.2)." });
  // ---- 2.5 third-party / biweekly -----------------------------------------
  o("FNMA_C1104_ACCEPT_CONTRACTOR_PAYMENT_GATE", { evaluator: "2.5.acceptConformingContractorPayment",
    why: "§2.5 timer table: conforming, sufficient, timely contractor payment must be accepted like any other payment (C-1.1-04)." });
  o("NOTE_BIWEEKLY_INTEREST_14D_RULE", { trigger: "`payment.received{note_type=biweekly}`", evaluator: "2.5.biweeklyInterest",
    why: "§2.5 timer table: true biweekly note installment interest = UPB × rate × 14 ÷ 365 (rule 5; day-count UNVERIFIED)." });
  o("REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD", { trigger: "`suspense.accumulation.sufficient`", anchorField: "accumulated_on", offset: "+1 business_days_servicer",
    why: "§2.5 timer table: halves accumulate to P → apply within 1 BD (§1026.36(c)(1)(ii))." });
  o("SM_CONTRACTOR_DORMANT_60", { trigger: "`payment.received{channel=third_party_contractor}`", anchorField: "received_on", offset: "+60 calendar_days",
    why: "§2.5 timer table: last remittance +60 calendar days without a new remittance → arrangement dormant." });
  o("SM_INHOUSE_SPLIT_APPLY_ON_DUE_DATE_0", { trigger: "`autodraft.entry.settled{arrangement=inhouse_split, half=second}`", anchorField: "settlement_date", offset: "same day",
    why: "§2.5 timer table: in-house split second half settles → apply the same day; anchor 'due date (or last settlement)' — the halves accumulate on the last settlement (rule 4: the 15th for a 1st/15th split)." });
  // ---- 2.6 trial payments --------------------------------------------------
  o("FNMA_C1102_TRIAL_RESIDUAL_BEFORE_EFFECTIVE_0", { anchorField: "modification_effective_date", offset: "−1 calendar_days",
    why: "§2.6 timer table: trial residual applied before the modification is booked (effective date − 1; 12.8 booking command asserts)." });
  o("FNMA_F127_LC_NOT_CAPITALIZED_GATE", { trigger: "`lossmit.modification.capitalization_computed`", evaluator: "2.6.lateChargesExcludedFromCapitalization",
    why: "§2.6 timer table: capitalized amount excludes `late_charges` (F-1-27)." });
  // ---- 2.7 late charges ----------------------------------------------------
  o("FNMA_A2304_LC_COLLECTED_REPORT_MONTHLY", { offset: "monthly", why: "§2.7 timer table: collected late charges reported with the loan's next LAR/event (5.1 `fees.collected`) — monthly cycle." });
  o("FNMA_C1102_MILITARY_INDULGENCE_LC_WAIVER_GATE", { evaluator: "2.7.scraLateChargeWaiver", why: "§2.7 timer table: no late-charge collection during the SCRA reduced-rate period; assessed amounts waived (C-1.1-02)." });
  o("FNMA_D2203_PAYMENT_REMINDER_CD20", { trigger: "`payment.cycle.unpaid_day16`", anchorField: "due_date", offset: "by the 20th, 23:59 local",
    why: "§2.7 timer table: unpaid installment → payment reminder by the 20th of the month (D2-2-03)." });
  o("NOTE_6A_LATE_CHARGE_GRACE_GATE", { anchorField: "grace_end_on", offset: "0 (rolled to the next servicer business day)",
    why: "§2.7 timer table: due date + `late_charge_grace_days` (default 15) end of day; opens next servicer business day if closed (Note ¶6(A); policy)." });
  o("NOTE_6A_ONLY_ONCE_GATE", { trigger: "`late_charge.assessment.run`", evaluator: "2.7.onlyOnePerInstallment",
    why: "§2.7 timer table: at most one late charge per installment (`unique(loan_id, installment_due_date, fee_type=late_charge, state≠reversed)`)." });
  o("REGZ_1026_36C2_NO_PYRAMID_GATE", { trigger: "`late_charge.assessment.run`", evaluator: "2.7.noPyramiding",
    why: "§2.7 timer table: no late charge if the periodic payment was credited by grace end and the only shortfall is prior fees (§1026.36(c)(2))." });
  o("SM_LATE_CHARGE_ASSESS_1CD", { trigger: "`late_charge.grace_gate.opened`", anchorField: "grace_end_on", offset: "+1 calendar_days, 00:30 local",
    why: "§2.7 timer table: grace gate opens → assess within 1 calendar day (run 00:30 next day)." });
  o("SM_LC_COURTESY_WAIVER_LIMIT_12M", { evaluator: "2.7.courtesyWaiverLimit", why: "§2.7 timer table: max 1 courtesy waiver per loan per rolling 12 months (policy)." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("NOTE_6A_LATE_CHARGE_GRACE_GATE", { trigger: "`installment.due_date_reached`", anchorField: "grace_end_on", offset: "0 (rolled to the next servicer business day)", why: "§2.7 timer table: trigger 'installment `due_date`' → `installment.due_date_reached`; grace end computed as due + `late_charge_grace_days`." });

  // ---- satisfaction: rows whose `satisfied` column is prose get the event the domain emits ----------
  // (registry.override re-parses the anchor column on every call, so an override below re-states any computed `anchorField` set above)
  o("REGZ_1026_36C1III_NONCONFORMING_5CD", { satisfied: "`payment.posted`", why: "§2.1 timer table: 'posting' — `payment.posted` closes the 5-day nonconforming-credit rule." });
  o("FNMA_LL202605_EVENT_NEXTBD_0300", { satisfied: "`investor_events.submitted`", why: "§2.1/5.1 timer table: 'submitted' — the LL-2026-05 event submission." });
  o("FNMA_C1102_50_RULE_COUNT_12M", { evaluator: "2.2.fiftyRuleCount", why: "§2.2 timer table: 'max 3' $50-rule applications in 12 months (C-1.1-02) — a counter gate." });
  o("SM_SUSPENSE_REEVAL_ON_TERMS_CHANGE_0", { satisfied: "`suspense.accumulation.reevaluated`", why: "§2.2 timer table: 'accumulation re-evaluated' in the same transaction as `loan_terms.activated`." });
  o("REGE_1005_10C_STOP_PAYMENT_3BD_GATE", { anchorField: "scheduled_settlement_date", satisfied: "`ach.entry.cancelled`", why: "§2.3 timer table: 'entry cancelled' (nacha.cancel_entry emits it)." });
  o("NACHA_PRENOTE_WAIT_3BANKING_DAYS", { anchorField: "prenote_settlement_date", satisfied: "`autodraft.validation.completed{status=validated_prenote}`", why: "§2.3 timer table: 'no return → validated_prenote'." });
  o("NACHA_R11_CORRECTED_REINITIATION_60", { satisfied: "`ach.r11.resolved{outcome∈{corrected_reinitiated, not_reinitiated}}`", why: "§2.3 timer table: 'corrected entry transmitted (or decision not to)'." });
  o("NACHA_AUTH_RETENTION_2Y_POST_REVOCATION", { satisfied: "`retention.class_applied{class=tpsc_2y_post_revocation}`", why: "§2.3 timer table: 'retention class applied' (19.1 applies `tpsc_2y_post_revocation`)." });
  o("NACHA_RETURN_RATE_MONTHLY_WATCH", { satisfied: "`report.produced{report=nacha_return_rate}`", why: "§2.3 timer table: 'report produced'." });
  o("REGE_1005_10C_WRITTEN_CONFIRMATION_14", { satisfied: "`autodraft.revocation.confirmed_in_writing`", why: "§2.3 timer table: optional written confirmation of an oral revocation (default not required)." });
  o("SM_REAMORT_FORM181_DELIVERY_10BD", { satisfied: "`custodian.delivery.evidenced{document=form_181}`", why: "§2.4 timer table: 'custodian (and eVault for eMortgages) delivery evidence'." });
  // FNMA_IRM_LAR83_5BD_2000: §5.1's timers.ts (applied after this file) owns the row — trigger `loan_terms.*`, anchor `calculation_date`, satisfied `investor_events.submitted{event_type=rate_payment.change}`; 2.4 emits the `loan_terms.activated` and the `rate_payment.change` investor event (ops.activateReamortizedTerms).
  o("SM_BIWEEKLY_HALF_STALE_45", { satisfied: "`suspense.item.closed{outcome∈{matched, applied, reclassified}}`", why: "§2.5 timer table: 'matched/applied' — the stale half is reclassified to partial_payment at day 45 (2.5-T5)." });
  o("SM_INHOUSE_SPLIT_APPLY_ON_DUE_DATE_0", { anchorField: "settlement_date", satisfied: "`payment.posted{arrangement=inhouse_split}`", why: "§2.5 timer table: `payment.applied{credited_as_of ≤ grace end}` — the posting of the accumulated halves." });
  o("SM_CONTRACTOR_DORMANT_60", { satisfied: "`arrangement.updated{status∈{active, ended}}`", why: "§2.5 timer table: 'new remittance or ended' — either re-activates or ends the arrangement." });
  o("FNMA_F122_TRIAL_PAYMENT_SMDU_REPORT_1BD", { satisfied: "`smdu.trial_payment.reported`", why: "§2.6 timer table: `smdu_reported_at` (B2B ack or human_portal_task.completed) — one event either way." });
  o("FNMA_D23206_LC_WAIVE_ON_CONVERSION_0", { satisfied: "`late_charges.all_waived{reason=trial_conversion}`", why: "§2.6 timer table: 'all late_charge fees on the loan waived' (waiveAll emits it)." });
  o("SM_TRIAL_FAILED_FUNDS_RESOLVE_30", { satisfied: "`trial.held_funds.resolved{outcome∈{applied, successor_workout, returned}}`", why: "§2.6 timer table: 'funds applied (if ≥ PITI), applied to a successor workout, or returned'." });
  o("NOTE_6A_LATE_CHARGE_GRACE_GATE", { anchorField: "grace_end_on", evaluator: "2.7.graceGateOpen", why: "§2.7 timer table: not-before gate on the grace period — condition-shaped (run_on > grace end)." });
  o("FNMA_D23201_FORBEARANCE_NO_ACCRUAL_GATE", { evaluator: "2.7.forbearanceNoAccrual", why: "§2.7 timer table: no accrual through plan end (or default date) — condition-shaped." });
  o("FNMA_A2304_LC_COLLECTED_REPORT_MONTHLY", { satisfied: "`investor_events.acked{type=fees.collected}`", why: "§2.7 timer table: 'accepted' — the LAR/event carrying `fees.collected` is accepted (5.1)." });
  o("FNMA_D2203_PAYMENT_REMINDER_CD20", { anchorField: "due_date", satisfied: "`notice.sent{template=NTC_FNMA_D2_2_03_PAYMENT_REMINDER}`", why: "§2.7 timer table: 'notice sent (states late charges due)' — the D2-2-03 payment reminder (7.1/11.x)." });
  o("SM_LATE_CHARGE_ASSESS_1CD", { anchorField: "grace_end_on", satisfied: "`late_charge.assessment.decided`", why: "§2.7 timer table: '`fee.assessed` or `not_assessed` decision' — the run records one decision event either way (ops.runAssessment)." });
}
