/**
 * §18.7 timer satisfaction overrides: for every 18.7 registry row whose "Satisfied by"
 * column is prose, a `reg.override(code, { satisfied | evaluator, trigger?, offset?, anchorField?, why })`
 * (see src/domain/foreclosure/timers.ts applyForeclosureSatisfiedOverrides for the pattern).
 * Called from this section's timers.ts after the section-level overrides. The satisfaction
 * events are the strings src/domain/qc-audit/ops-18-7.ts (ELIG_EVENTS) emits — officerCertify,
 * form1002Submit, form1002aSubmit, capliqPlanSubmit, materialChangeNotified, breachNotified,
 * remediationPlanApproval, partnerUpbReportDelivered, csbsPrudentialApplicability — appended to the
 * event store by the src/app/tools/section18-7.ts handlers, so every row keeps its deadline offset and
 * none is evaluator-backed (FNMA_A4101_SERVICE_ONE_LOAN_DEC31 already resolves to
 * `18.7.servicesAtLeastOneFannieMaeLoan`, exercised by serviceOneLoanTest / 18.7-T9).
 *
 * Anchors. The section-level timers.ts arms the period rows on `period.month_end` / `period.quarter_end` /
 * `period.year_end` — the events `eligibility.period.close` (ops-18-7 periodCloseEvents) appends when a calendar
 * period closes, which happens on BD1 of the following month at the earliest. The spec anchors those rows on the
 * period itself ("quarter-end", "Dec 31", "month-end"), so each names `period_end` from the event payload as its
 * anchor field; the detection rows ("detection", "occurrence") anchor on the payload's `detected_on`.
 * `TimerRegistry.override` re-parses the anchor column when a later override omits `anchorField`, so the anchor
 * is stated on every row here.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";
import { ELIG_EVENTS as E } from "./ops-18-7.ts";

const ev = (pattern: string): string => `\`${pattern}\``;

export function applySatisfiedOverrides_18_7(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- quarterly test and Form 1002 / 1002A filings (A4-1-02) ------------------------------------------------------
  o("FHFA_ELIG_QUARTERLY_TEST", { anchorField: "period_end", satisfied: ev(E.computed_certified), why: "§18.7 timer table: trigger 'calendar quarter-end' = `period.quarter_end{period_end}` from `eligibility.period.close`, anchor 'quarter-end' = the payload's `period_end` (BD10 of the following month counts from the quarter-end, not from the close); '`eligibility.computed{quarter}` certified' — the quarterly computation with `eligibility_results.certified_by_officer_id` (state machine `computed → officer_certified`; `officerCertify` through `eligibility.certify`: certifications are CEO/CFO acts, the agent cannot certify, a stale run cannot be certified)." });
  o("FNMA_A4102_FORM1002_Q_30", { anchorField: "period_end", satisfied: ev(E.form1002_q_submitted), why: "§18.7 timer table: trigger 'quarter-end (Mar/Jun/Sep)' = `period.quarter_end{quarter∈{1, 2, 3}}`, anchor the payload's `period_end` (18.7-T5: 2026-09-30 → due 2026-10-30); 'WebMB submission evidence with CEO/CFO certification' — `form1002Submit` (`form1002.submit`) moves the `regulatory_filings` row for `form_1002` to `submitted (WebMB)` only with the confirmation and the certification record (18.7-T8; A4-1-02 'certified by the chief executive officer, the chief financial officer, or equivalent'); warning day 20 (`form1002Clock`)." });
  o("FNMA_A4102_FORM1002_YE_60", { anchorField: "period_end", satisfied: ev(E.form1002_ye_submitted), why: "§18.7 timer table: trigger 'Dec 31' = `period.year_end{period_end}`, anchor the payload's `period_end` (18.7-T5: 2026-12-31 → due 2027-03-01); 'WebMB submission evidence' for the December 31 Form 1002 ('within 60 days'; warning day 40 = Dec 31 + 40, `form1002Clock`) — same transition guard as the quarterly filing (A4-1-02)." });
  o("FNMA_A4102_FORM1002A_M_30", { anchorField: "period_end", satisfied: ev(E.form1002a_submitted), why: "§18.7 timer table: trigger 'month-end (months 1–2 of each quarter)' = `period.month_end{quarter_month∈{1, 2}}`, anchor the payload's `period_end` (18.7-T6: 2027-07-31 → due 2027-08-30); 'submission evidence' — `form1002aSubmit` (`form1002a.submit`): the `form_1002a` filing row submitted through WebMB (large non-depositories, months 1–2 of each quarter, no report for the third month; A4-1-02 'within 30 days of the end of each month')." });
  // ---- large seller/servicer obligations (A4-1-01) -------------------------------------------------------------------
  o("FNMA_A4101_LARGE_CAPLIQ_PLAN_90", { anchorField: "period_end", satisfied: ev(E.capliq_plan_submitted), why: "§18.7 timer table: trigger 'calendar year-end' = `period.year_end{large_servicer=true}` (large only), anchor 'Dec 31' = the payload's `period_end` (18.7-T6: 2027-12-31 + 90 = 2028-03-30); 'plan submitted' — `capliqPlanSubmit` (`capliq_plan.submit`): the `capliq_plan` filing row with governance, liquidity-risk monitoring, a contingency funding plan tested at least annually and the annual liquidity stress test including MSR valuation ('Within 90 days after the end of each calendar year'; A4-1-01)." });
  o("FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD", { trigger: ev(E.material_change_detected), anchorField: "detected_on", offset: "+5 business_days_servicer", satisfied: ev(E.material_change_notified), why: "§18.7 timer table: trigger 'material change to plan inputs / during stress' = the spec's `material_change.detected{decline_trigger}` event (large only; `material_change.detect` and a decline trigger found by `eligibility.compute` of a large servicer), anchor 'occurrence' = the payload's `detected_on`; 'notice evidenced' — `materialChangeNotified` (`material_change.notify`) records the Fannie Mae notice with its evidence document 'Within five business days following any material change' (the `_STRESS_1BD` variant, 'within one business day of any material changes during times of stress', is the 1-BD due `materialChangeNotice` computes when `stress=true`; A4-1-01)." });
  // ---- status ladder clocks (rules 6–7; worked examples 2–3) -------------------------------------------------------
  o("SM_ELIG_WARNING_REMEDIATION_30", { anchorField: "detected_on", satisfied: ev(E.remediation_plan_approved), why: "§18.7 timer table: anchor 'detection' = the `eligibility.threshold.warning` payload's `detected_on` (the compute date, `warningDetected`); 'board-approved remediation plan' within 30 calendar days (status ladder `warning → remediation_plan`; `remediationPlanApproval` through `remediation_plan.approve`: board only, plan document required; 18.7-T2)." });
  o("SM_ELIG_BREACH_NOTIFY_1BD", { anchorField: "detected_on", satisfied: ev(E.breach_notified), why: "§18.7 timer table: anchor 'detection' = the `eligibility.breach.detected` payload's `detected_on` (`breachDetected`); 'partner + `officer` notified' within 1 business day (`breachNotified` through `eligibility.breach.notify`); the Fannie Mae 'material adverse change' notice (5 BD, A4-1-02) is the 18.4 hand-off (18.7-T3)." });
  // ---- partner report and CSBS applicability -------------------------------------------------------------------------
  o("SM_PARTNER_UPB_REPORT_MONTHLY_BD5", { anchorField: "period_end", satisfied: ev(E.partner_upb_report_delivered), why: "§18.7 timer table: trigger 'month-end' = `period.month_end{period_end}`, anchor 'month-end' = the payload's `period_end` (BD5 counts from the month-end); 'subserviced UPB/remittance-type report delivered' — the monthly partner UPB report (ELIG-UPB-PARTNER-M-v1, `partnerUpbReportDelivered` through `partner_upb_report.deliver`) by BD5 so the partner can compute its own position (sev-2, contract)." });
  o("CSBS_PRUDENTIAL_APPLICABILITY_CHECK_Q", { anchorField: "period_end", satisfied: ev(E.csbs_applicability_recorded), why: "§18.7 timer table: trigger 'quarter-end' = `period.quarter_end{period_end}`, anchor the payload's `period_end`; 'loan-count/state test recorded' — `csbsPrudentialApplicability` (`csbs.applicability.record`): ≥ 2,000 loans in ≥ 2 states keys the CSBS prudential standards (research/00a §5.3); informs the Section 19 licensing program." });
  // ---- the one-loan rule (evaluator-backed; the section-level override names `18.7.servicesAtLeastOneFannieMaeLoan`) --
  o("FNMA_A4101_SERVICE_ONE_LOAN_DEC31", { anchorField: "period_end", why: "§18.7 timer table: trigger 'calendar year' = `period.year_end{period_end}`, anchor 'Dec 31' = the payload's `period_end`; 'position ≥ 1' is the evaluator `18.7.servicesAtLeastOneFannieMaeLoan` over `fnma_loans_serviced_dec31` (`serviceOneLoanTest` through `service_one_loan.test`: zero → sev-1 to `officer`, approval at risk; 18.7-T9; A4-1-01)." });
}
