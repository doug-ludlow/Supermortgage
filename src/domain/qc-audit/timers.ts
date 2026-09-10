/**
 * Registry overrides for Section 18 (QC, exams, STAR, Form 582, insurance,
 * Reg AB, eligibility) timers whose spec rows are prose. Fiscal-year and
 * quarter anchors are `period.fiscal_year_end` / `period.quarter_end` events.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyQcAuditTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 18.1 QC program -----------------------------------------------------
  o("CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL", { trigger: "`ai_system.deployed{risk_tier=high_consequential}`", anchorField: "deployed_at", offset: "every 12 months", why: "§18.1 timer table: T1 system deployed → impact assessment every 12 months, and within 90 days of a `major` change (`ai_system.changed{major=true}` arms the 90-day leg) (Colorado SB 24-205)." });
  o("CSBS_EXTERNAL_AUDIT_ANNUAL", { trigger: "`period.fiscal_year_end{csbs_audit_required=true}`", why: "§18.1 timer table: fiscal year-end (≥2,000 loans in ≥2 states) → AFS with audit opinion within 12 months (CSBS)." });
  o("FNMA_A4101_QC_CYCLE_MONTHLY", { trigger: "`schedule.tick{cadence=monthly, business_day=3}`", offset: "+17 business_days_servicer", why: "§18.1 timer table: cycle opens BD3 of month, close by BD20 (`business_days_servicer`) (A4-1-01)." });
  o("FNMA_A4101_QC_PLAN_REAPPROVAL_ANNUAL", { trigger: "`qc.plan.approved`", anchorField: "approved_at", why: "§18.1 timer table: plan approved → re-approval every 12 months (A4-1-01)." });
  o("FNMA_ISBR_ANNUAL_ATTESTATION", { trigger: "`period.fiscal_year_end`", offset: "+90 calendar_days", why: "§18.1 timer table: annual ISBR attestation aligned to the Form 582 window (FYE + 90)." });
  o("FNMA_LL202604_AI_POLICY_REVIEW_ANNUAL", { trigger: "`ai.policy.approved`", anchorField: "approved_at", why: "§18.1 timer table: policy approved → review every 12 months; warning 60 days (LL-2026-04)." });
  o("SM_QC_CAPA_EFFECTIVENESS_NEXT_CYCLE", { trigger: "`qc.capa.completed`", anchorField: "next_cycle_close_on", offset: "0", why: "§18.1 timer table: CAPA completed → effectiveness test at the next cycle close (computed anchor)." });
  o("SM_QC_CONSUMER_REMEDIATION_30", { trigger: "`qc.finding.validated{remediation_cents_total>0}`", anchorField: "validated_at", why: "§18.1 timer table: finding with `remediation_cents_total>0` validated → refunds posted + notices sent within 30 calendar days." });
  // ---- 18.2 exams ----------------------------------------------------------
  o("FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD", { trigger: "`fnma.request.received{kind=qc_results}`", why: "§18.2 timer table: QC results request → delivered within 10 BD default (A4-1-01)." });
  o("FNMA_SCR_FINDING_RESPONSE_AS_STATED", { anchorField: "response_due_stated", offset: "0", why: "§18.2 timer table: per Fannie Mae letter (default 30 calendar days UNVERIFIED) — computed anchor `response_due_stated` (letter date + 30 when none stated)." });
  o("SM_EXAM_INTERNAL_NOTIFY_2BD", { trigger: "`exam.contact.received`", why: "§18.2 timer table: any examiner contact → partner + officer notified within 2 business days." });
  o("SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD", { trigger: "`exam.package.assembled`", anchorField: "assembled_at", offset: "+3 business_days_servicer", why: "§18.2 timer table: package must sit ≥1 BD for review and be approved ≥1 BD before due; officer has 3 BD (`18.2.packageReviewWindow` asserts the ≥1 BD margins)." });
  // ---- 18.3 STAR -----------------------------------------------------------
  o("SM_STAR_COMPUTE_MONTHLY_BD5", { trigger: "`period.closed`", offset: "BD5", why: "§18.3 timer table: Fannie Mae period close (BD2) → metrics computed by BD5 `business_days_fannie_et`." });
  o("SM_STAR_CONFIG_ANNUAL_JAN", { trigger: "`period.year_end`", offset: "Jan 31", why: "§18.3 timer table: program year → config loaded by Jan 31 (Feb scorecard reflects changes)." });
  // ---- 18.4 Form 582 / corporate ------------------------------------------
  o("FNMA_A2101_TECH_PROVIDER_BREACH_5BD", { trigger: "`contract_event.occurred{kind∈{termination, breach, impairment}, contract_kind=tech_provider}`", why: "§18.4 timer table: termination/breach/impairment notice under a technology contract → Fannie Mae notice within 5 business days (A2-1-01)." });
  o("FNMA_A2101_TECH_PROVIDER_CHANGE_180", { trigger: "`tech_provider.change.intent_declared`", anchorField: "planned_effective_date", offset: "−180 calendar_days", why: "§18.4 timer table: planned replacement (≥ 20,000 loans) → notice 180 calendar days before the change (A2-1-01)." });
  o("FNMA_A3501_INSURANCE_EXPIRY_30", { trigger: "`corporate_insurance_policy.recorded`", anchorField: "expires_on", offset: "−30 calendar_days", why: "§18.4 timer table: policy expiry → renewal recorded 30 calendar days before (no lapse) (A3-5-01)." });
  o("FNMA_A4102_FORM582_FYE_90", { trigger: "`period.fiscal_year_end`", why: "§18.4 timer table: fiscal year-end (per entity) → Form 582 within 90 calendar days; warnings at day 30 and day 60 (A4-1-02)." });
  o("FNMA_A4103_MAJOR_CHANGE_ADVANCE_60", { trigger: "`org.change.planned{major=true}`", anchorField: "planned_effective_date", offset: "−60 calendar_days", why: "§18.4 timer table: planned major change → notice ≥ 60 calendar days before; prior approval where required (A4-1-03)." });
  o("FNMA_A42106_FORM183_ON_CHANGE", { trigger: "`notice_template.published{class=adverse_action}`", offset: "until form183.submitted", why: "§18.4 timer table: adverse-action notice template version change → Form 183 before first use (gate) (A4-2.1-06)." });
  o("SM_FORM582_PARTNER_PACKAGE_FYE_60", { trigger: "`period.fiscal_year_end{entity=partner}`", why: "§18.4 timer table: partner FYE → partner data package delivered within 60 calendar days." });
  o("SM_PARTNER_NOTIFY_SUB_EVENT_1BD", { trigger: "`partner.reportable_event.occurred`", why: "§18.4 timer table: any Supermortgage event reportable by the partner → partner notified within 1 business day." });
  // ---- 18.5 fraud / cyber --------------------------------------------------
  o("FNMA_ISBR_CYBER_INCIDENT_36H", { trigger: "`security.incident.identified`", anchorField: "identified_at", why: "§18.5 timer table: incident identified (incl. BEC behind a payoff-diversion) → notice to privacy_office@fanniemae.com within 36 hours (ISBR)." });
  o("SM_FRAUD_CARRIER_NOTICE_IMMEDIATE", { trigger: "`fraud.covered_loss.discovered`", offset: "+1 business_days_servicer", why: "§18.5 timer table: employee dishonesty / covered loss discovered → carrier notice within 1 business day (policy 'immediate' terms UNVERIFIED)." });
  // ---- 18.6 Reg AB ---------------------------------------------------------
  o("REGAB_1122_2VII_RECON_ITEMS_90", { trigger: "`reconciliation_item.opened`", anchorField: "item_date", why: "§18.6 timer table: custodial reconciling item aged → resolved within 90 calendar days (Reg AB Item 1122(d)(2)(vii))." });
  o("REGAB_1122_ASSESSMENT_PSA_DUE", { trigger: "`period.fiscal_year_end{regab_applicable=true}`", anchorField: "psa_assessment_due", offset: "0", why: "§18.6 timer table: per PSA (default FYE + 60 days UNVERIFIED); warning at FYE + 30 — computed anchor from the PSA." });
  o("REGAB_1123_STATEMENT_PSA_DUE", { trigger: "`period.fiscal_year_end{regab_applicable=true}`", anchorField: "psa_statement_due", offset: "0", why: "§18.6 timer table: FYE (partner as servicer) → officer statement per PSA (default FYE + 60)." });
  o("SM_SOC1_TYPE2_ANNUAL", { trigger: "`period.fiscal_year_end`", offset: "+75 calendar_days", why: "§18.6 timer table: SOC 1 Type 2 report issued by FYE + 75 days." });
  // ---- 18.7 eligibility ----------------------------------------------------
  o("FHFA_ELIG_QUARTERLY_TEST", { trigger: "`period.quarter_end`", offset: "BD10 of the following month", why: "§18.7 timer table: calendar quarter-end → eligibility computed by BD10 of the following month (FHFA seller/servicer eligibility)." });
  o("FNMA_A4101_LARGE_CAPLIQ_PLAN_90", { trigger: "`period.year_end{large_servicer=true}`", why: "§18.7 timer table: calendar year-end → capital/liquidity plan within 90 calendar days (A4-1-01)." });
  o("FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD", { trigger: "`eligibility.material_change.occurred`", offset: "+5 business_days_servicer", why: "§18.7 timer table: material change to plan inputs → notice within 5 BD (1 BD during stress: `eligibility.material_change.occurred{stress=true}`) (A4-1-01)." });
  o("FNMA_A4101_SERVICE_ONE_LOAN_DEC31", { trigger: "`period.year_end`", evaluator: "18.7.servicesAtLeastOneFannieMaeLoan", why: "§18.7 timer table: must service ≥ 1 Fannie Mae loan as of Dec 31 (A4-1-01)." });
  o("FNMA_A4102_FORM1002_Q_30", { trigger: "`period.quarter_end{quarter∈{1, 2, 3}}`", why: "§18.7 timer table: quarter-end (Mar/Jun/Sep) → Form 1002 within 30 calendar days; warning day 20 (A4-1-02)." });
  o("FNMA_A4102_FORM1002_YE_60", { trigger: "`period.year_end`", why: "§18.7 timer table: Dec 31 → Form 1002 within 60 calendar days; warning day 40 (A4-1-02)." });
  o("FNMA_A4102_FORM1002A_M_30", { trigger: "`period.month_end{quarter_month∈{1, 2}}`", why: "§18.7 timer table: month-end (months 1–2 of each quarter) → Form 1002A within 30 calendar days (A4-1-02)." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("SM_AI_MONITORING_REVIEW_MONTHLY", { trigger: "`schedule.tick{cadence=monthly, business_day=5}`", why: "§18.1 timer table: calendar → monthly AI monitoring review at BD5." });
  o("FNMA_A4102_AFS_FYE_90", { trigger: "`period.fiscal_year_end`", why: "§18.4 timer table: FYE → audited financial statements within 90 calendar days (A4-1-02)." });
  o("SM_AFS_AUDITOR_DELIVERY_FYE_75", { trigger: "`period.fiscal_year_end`", why: "§18.4 timer table: FYE → auditor delivery target 75 calendar days." });
  o("SM_FRAUD_LE_REFERRAL_DECISION_10BD", { trigger: "`fraud.determination.recorded{reasonable_basis=true}`", anchorField: "determination_at", why: "§18.5 timer table: `reasonable_basis` determination with loss/exposure > $25,000 or identity theft/employee dishonesty → law-enforcement referral decision within 10 business days." });
  o("SM_ATTEST_EVIDENCE_COMPILE_FYE_15", { trigger: "`period.fiscal_year_end`", why: "§18.6 timer table: FYE → attestation evidence compiled within 15 calendar days." });
  o("SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45", { trigger: "`period.fiscal_year_end`", why: "§18.6 timer table: FYE → management assertion within 45 calendar days." });
  o("SM_PARTNER_UPB_REPORT_MONTHLY_BD5", { trigger: "`period.month_end`", offset: "BD5", why: "§18.7 timer table: month-end → partner UPB report by BD5." });
  o("CSBS_PRUDENTIAL_APPLICABILITY_CHECK_Q", { trigger: "`period.quarter_end`", why: "§18.7 timer table: quarter-end → CSBS prudential standards applicability check." });
}
