/**
 * Registry overrides for Section 19 (records, security, vendors, fair
 * lending, AI governance) timers whose spec rows are prose.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";
import { applySatisfiedOverrides_19_1 } from "./timers-19-1.ts";
import { applySatisfiedOverrides_19_2 } from "./timers-19-2.ts";
import { applySatisfiedOverrides_19_3 } from "./timers-19-3.ts";
import { applySatisfiedOverrides_19_4 } from "./timers-19-4.ts";

export function applyDataSecurityTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 19.1 records --------------------------------------------------------
  o("FNMA_A2_4_1_02_RECORDS_DELIVERY_REQUESTED", { anchorField: "delivery_due_stated", offset: "0", why: "§19.1 timer table: time frame stated in the request; default +10 `business_days_fannie_et` if none stated (policy) — computed anchor `delivery_due_stated` (A2-4.1-02)." });
  o("SM_REGULATOR_RECORDS_REQUEST", { trigger: "`records.request.received{requester_type=regulator}`", anchorField: "delivery_due_stated", offset: "0", why: "§19.1 timer table: `records.request.received{regulator_*}` → per request; default +10 `business_days_servicer` (policy) — computed anchor." });
  // ---- 19.2 security -------------------------------------------------------
  o("FNMA_FORM101_DATA_INCIDENT_NOTICE_36H", { trigger: "`security.incident.identified{fnma_application_data=true}`", anchorField: "identified_at", why: "§19.2 timer table: incident where Fannie Mae application Data involved → notices to Fannie Mae and partner within +36 hours (Form 101)." });
  o("FNMA_SUPP_BCP_TEST_365", { trigger: "`bcp_exercise.completed`", offset: "annual", why: "§19.2 timer table: annual tabletop + DR failover from last exercise (Fannie Mae supplement; NYDFS 500.16(c))." });
  o("FNMA_SUPP_PENTEST_ANNUAL_365", { trigger: "`pen_test.completed`", offset: "annual", why: "§19.2 timer table: annual independent third-party penetration test from last report (also FTC 314.4(d)(2)(i), NYDFS 500.5(a)(1))." });
  o("FNMA_SUPP_POST_INCIDENT_ASSESSMENT", { offset: "+90 calendar_days", why: "§19.2 timer table: S1 incident → engage +10 `business_days_servicer` (`SM_POST_INCIDENT_ENGAGE_10BD` leg); complete +90 calendar days (policy)." });
  o("FNMA_SUPP_TRAINING_365", { trigger: "`personnel.training.completed{course=security_awareness}`", offset: "annual", why: "§19.2 timer table: annual security training from last completion; new hires within 30 days (`personnel.hired` arms the 30-day leg) (policy)." });
  o("FNMA_TECHGUIDE_CREDENTIAL_RESET_90D", { trigger: "`identity.credential.reset{fnma_credentials=true}`", anchorField: "reset_at", offset: "every 90 calendar_days", why: "§19.2 timer table: human Fannie Mae credentials reset every 90 calendar days (system IDs 365: `identity.credential.reset{kind=fnma_system_id}`) (Technology Guide)." });
  o("FNMA_TECHGUIDE_TLS_CIPHER_CUTOFF", { trigger: "`schedule.tick{cadence=daily}`", anchorField: "cutoff_date", offset: "0", why: "§19.2 timer table: fixed cutoff 2026-10-23 — CTL-SEC-03 must pass with the ECDHE-GCM-only profile before the date (Technology Guide)." });
  o("SM_VULN_REMEDIATION_SLA", { anchorField: "remediation_due", offset: "0", why: "§19.2 timer table: critical internet-facing 72 h; critical 7 d; high 30 d; medium 90 d; low 180 d (policy) — computed by `19.2.remediationDue`." });
  o("STATE_BREACH_CRA_NOTICE_NY_5000", { trigger: "`security.incident.scoped{ny_residents>5000}`", anchorField: "consumer_notice_due", offset: "0", why: "§19.2 timer table: NY residents > 5,000 → CRA notice with consumer notices (NY GBL §899-aa)." });
  o("STATE_BREACH_REGULATOR_NOTICE_NY", { anchorField: "consumer_notice_due", offset: "0", why: "§19.2 timer table: NY regulator notices (AG, DOS, State Police, DFS) with/before consumer notices (NY GBL §899-aa)." });
  // ---- 19.3 vendors / Fannie Mae relationship ------------------------------
  o("FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD", { trigger: "`contract_event.occurred{kind∈{termination, breach, impairment}, contract_kind=tech_provider}`", why: "§19.3 timer table: `contract_event.occurred{termination|breach|impairment; tech_provider}` → +5 `business_days_fannie_et` (A2-1-01)." });
  o("FNMA_A2107_FORM101_INCEPTION_GATE", { offset: "until form101.acknowledged", why: "§19.3 timer table: Form 101 `active` before any Fannie Mae application access (A2-1-07)." });
  o("FNMA_LL2026_04_POLICY_REVIEW_365", { trigger: "`ai.policy.approved`", offset: "annual", why: "§19.3 timer table: policy approval → annual review (LL-2026-04)." });
  o("FNMA_SUPP_PROGRAM_REQUEST_10BD", { trigger: "`fnma.request.received{kind∈{supplement_program, audit}}`", why: "§19.3 timer table: `fnma.request.received{supplement_program or audit}` → response +10 `business_days_fannie_et` (policy)." });
  o("FNMA_SUPP_VENDOR_REASSESSMENT", { anchorField: "reassessment_due", offset: "0", why: "§19.3 timer table: Tier 1: 365 days; Tier 2: 730; Tier 3: 1095 (policy, risk-based) — computed by `19.3.reassessmentDue`." });
  o("SM_AI_SYSTEM_EVAL_BEFORE_DEPLOY", { evaluator: "19.3.evalSuitePassedAndInventoryUpdated", why: "§19.3 timer table: eval suite pass + inventory updated before deploy." });
  o("SM_VENDOR_INCIDENT_NOTICE_SLA", { anchorField: "vendor_aware_at", offset: "+24 hours", why: "§19.3 timer table: contract SLA (24 h default) from the vendor's awareness as reported." });
  // ---- 19.4 fair lending / AI bias ----------------------------------------
  o("FNMA_A2101_FL_DATA_QUERYABLE_AT_BOARDING", { trigger: "`loan.boarded{note_date>=2023-03-01}`", evaluator: "19.4.fairLendingRowPresent", why: "§19.4 timer table: FL row exists (`validated` or `not_obtained` with evidence) for loans with note_date ≥ 2023-03-01 (A2-1-01)." });
  o("FNMA_F111_FL_DATA_TRANSFER_OUT_T0", { anchorField: "transfer_date", offset: "0", why: "§19.4 timer table: FL data delivered with the 17.3 file by T−0 (target T−5 business days) (F-1-11)." });
  o("SM_AI_BIAS_TEST_PRE_DEPLOY", { evaluator: "19.4.allFourBiasTestsPass", why: "§19.4 timer table: all four test kinds pass before deploy of a high-consequential system." });
  o("SM_AI_BIAS_TEST_QUARTERLY_90", { trigger: "`period.quarter_end`", offset: "quarterly", why: "§19.4 timer table: quarterly production bias tests at quarter end." });
  o("SM_FL_ACCESS_REVIEW_90", { trigger: "`period.quarter_end`", offset: "quarterly", why: "§19.4 timer table: quarterly certification of `fl_analytics` members and enclave jobs." });
  // ---- pseudo-trigger rows (schedules) --------------------------------------------
  o("SM_DISPOSAL_RUN_MONTHLY", { trigger: "`schedule.tick{cadence=monthly, weekday=sunday, ordinal=1}`", why: "§19.1 timer table: schedule → disposal run first Sunday monthly." });
  o("SM_RECORDS_INVENTORY_REVIEW_365", { trigger: "`period.year_end`", offset: "Jan 15", why: "§19.1 timer table: schedule → records inventory review by Jan 15 annually." });
  o("SM_SERVICING_FILE_DRILL_MONTHLY", { trigger: "`schedule.tick{cadence=monthly, day=1}`", why: "§19.1 timer table: schedule → monthly servicing-file drill on the 1st, 25 random loans." });
  o("STATE_BREACH_REGULATOR_NOTICE_NY", { trigger: "`security.incident.scoped{ny_residents>0}`", anchorField: "consumer_notice_due", offset: "0", why: "§19.2 timer table: 'same' as STATE_BREACH_CONSUMER_NOTICE_NY_30D → `security.incident.scoped{ny_residents>0}`; regulator notices with/before consumer notices (NY GBL §899-aa)." });
  o("FNMA_SUPP_INDEPENDENT_ASSESSMENT_365", { trigger: "`independent_assessment.completed`", why: "§19.2 timer table: schedule → annual independent assessment from last completion." });
  o("FTC_314_4D2_VULN_ASSESSMENT_180", { trigger: "`vulnerability_assessment.completed`", why: "§19.2 timer table: schedule → every 6 months from last report (+ after material change) (16 CFR 314.4(d)(2))." });
  o("FTC_314_4B_RISK_ASSESSMENT_365", { trigger: "`risk_assessment.approved`", why: "§19.2 timer table: schedule → annual from last approval (policy; rule says 'periodically') (16 CFR 314.4(b))." });
  o("FTC_314_4I_BOARD_REPORT_365", { trigger: "`board.report.delivered{kind=security}`", why: "§19.2 timer table: schedule → annual board report from last report (16 CFR 314.4(i); NYDFS 500.4)." });
  o("FNMA_SUPP_ATTESTATION_ANNUAL", { trigger: "`period.fiscal_year_end`", offset: "+60 calendar_days", why: "§19.2 timer table: annual attestation due partner's Form 582 due date (FYE + 90) − 30 days." });
  o("NYDFS_500_17B_ANNUAL_CERT_APR15", { trigger: "`period.year_end`", offset: "Apr 15", why: "§19.2 timer table: schedule → NYDFS annual certification by Apr 15 (23 NYCRR 500.17(b))." });
  o("FNMA_SUPP_ACCESS_CERT_365", { trigger: "`access_certification.completed`", why: "§19.2 timer table: schedule → annual access certification (all human and system accounts) from last completion." });
  o("SM_PRIV_ACCESS_REVIEW_90", { trigger: "`period.quarter_end`", why: "§19.2 timer table: schedule → quarterly privileged-access review (policy)." });
  o("NYDFS_500_16D_BACKUP_RESTORE_TEST_365", { trigger: "`backup_restore_test.completed`", why: "§19.2 timer table: schedule → annual backup restore test from last test (policy: quarterly automated restore) (23 NYCRR 500.16(d))." });
  o("FNMA_SUPP_FIREWALL_RULE_REVIEW_90", { trigger: "`period.quarter_end`", why: "§19.2 timer table: schedule → quarterly firewall rule review (policy 'defined frequency')." });
  o("FNMA_SUPP_WIRELESS_REVIEW_365", { trigger: "`wireless_review.completed`", why: "§19.2 timer table: schedule → annual wireless review." });
  o("NYDFS_500_12_MFA_COMPENSATING_REVIEW_365", { trigger: "`control_exceptions.approved{control=CTL-SEC-01}`", why: "§19.2 timer table: `control_exceptions{control=CTL-SEC-01}` approval → annual review (23 NYCRR 500.12)." });
  o("SM_PORTFOLIO_THRESHOLD_MONITOR_DAILY", { trigger: "`schedule.tick{cadence=daily, at=06:00}`", offset: "daily", why: "§19.3 timer table: schedule → daily 06:00 ET portfolio threshold monitor." });
  o("SM_FAIR_SERVICING_MONITOR_MONTHLY", { trigger: "`schedule.tick{cadence=monthly, day=10}`", why: "§19.4 timer table: schedule → monthly fair-servicing monitor on the 10th (prior month)." });
  o("SM_FAIR_SERVICING_REGRESSION_QUARTERLY", { trigger: "`period.quarter_end`", offset: "+20 calendar_days", why: "§19.4 timer table: schedule → quarterly regression at quarter end + 20 days." });
  o("SM_FAIR_SERVICING_BOARD_REPORT_365", { trigger: "`board.report.delivered{kind=security}`", offset: "annual", why: "§19.4 timer table: annual with the 19.2 board cycle." });
  o("SM_FL_DATA_QUALITY_MONTHLY", { trigger: "`period.month_end`", offset: "monthly", why: "§19.4 timer table: monthly FL data quality review." });
  // per-process satisfaction overrides (§19.x), applied last so they win the merge
  applySatisfiedOverrides_19_1(reg); applySatisfiedOverrides_19_2(reg); applySatisfiedOverrides_19_3(reg); applySatisfiedOverrides_19_4(reg);
}
