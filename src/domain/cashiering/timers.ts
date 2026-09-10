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
  o("SM_INHOUSE_SPLIT_APPLY_ON_DUE_DATE_0", { trigger: "`autodraft.entry.settled{arrangement=inhouse_split, half=second}`", anchorField: "due_date", offset: "same day",
    why: "§2.5 timer table: in-house split second half settles → apply on the due date (or last settlement) the same day." });
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
}
