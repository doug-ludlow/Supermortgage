import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as d } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import {
  sampleSize, seededDraw, targeted, errorRate, toleranceBreached, moneyFinding, capaDue, seniorReportDue, vendorAnnualTest, qcAuditMayWrite, evalGate, fairnessScreen, killSwitch, disclosurePackageDue,
  examClocks, findingCapaDue, privilegeExcluded, legalConclusionGuardrail, extensionRequestNeeded,
  rateBps, metricResult, includedInMetric, beyondTimeframe, reconcile, inquiryAllowed, starClocks, confidentialityFilter, composite,
  form582Clocks, insuranceRequirement, insuranceAdequate, insuranceExpiryWarning, orgChangeClocks, form582SubmittedAllowed,
  caseScore, priority, protectiveActions, fraudClocks, ofacEmailDueMs, lawFirmFraudNoticeDue, protectiveHoldExpires, assignmentAllowed, breachSelfReportDue,
  regAbApplicable, assessmentClocks, reconItemException, assertionSignedAllowed,
  netWorth, form1002Due, capitalPlanDue, form1002SubmittedAllowed, serviceOneLoanBreach,
} from "./index.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";

test("18.1-T1 sample size: N=4,000 → 351; seeded draw reproducible; targeted additions", () => {
  assert.equal(sampleSize(4000), 351);
  assert.equal(sampleSize(20), 20); assert.equal(sampleSize(100000), 383);
  const items = Array.from({ length: 4000 }, (_, i) => i);
  assert.deepEqual(seededDraw(items, 5, 42), seededDraw(items, 5, 42));
  assert.notDeepEqual(seededDraw(items, 5, 42), seededDraw(items, 5, 43));
  assert.ok(targeted({ confidence: 0.79 })); assert.equal(targeted({ confidence: 0.85 }), false); assert.ok(targeted({ denial: true }));
});

test("18.1-T2/T3/T4/T5/T6/T10 money finding 40,000¢ sev-2; 2.4% breaches 2%; CAPA sev-1 10 BD; report 5 BD; vendor annual; role deny", () => {
  const f = moneyFinding(80_000n, 120_000n, d("2026-10-01"), false, true);
  assert.equal(f.variance_cents, 40_000n); assert.equal(f.severity, "sev2"); assert.equal(f.remediation_due, d("2026-10-31"));
  assert.ok(toleranceBreached(24, 976, "rederive")); assert.equal(toleranceBreached(19, 981, "rederive"), false); assert.ok(toleranceBreached(1, 999, "sev1_consumer_harm"));
  const er = errorRate(24, 976); assert.ok(er.wilson_low < 0.024 && er.wilson_high > 0.024);
  // Spec 18.1-T4 says Oct 15 "(10 BD)"; Columbus Day Oct 12 makes the 10th servicer BD Oct 16 (audit note).
  assert.equal(capaDue(d("2026-10-01"), "sev1"), d("2026-10-16"));
  assert.equal(seniorReportDue(d("2026-09-04")), d("2026-09-14"));    // Fri before Labor Day → Mon +7
  assert.deepEqual(vendorAnnualTest(d("2026-03-15")), { warn: d("2026-12-15"), breach: d("2027-03-15") });
  assert.equal(qcAuditMayWrite("ledger_entries"), false); assert.ok(qcAuditMayWrite("qc_findings"));
});

test("18.1-T7/T8/T9/T11 eval gate, fairness ratio 0.75, disclosure 5 BD, kill-switch", () => {
  assert.deepEqual(evalGate({ tier: "T1", outcome_agreement: 0.995, unexplained_adverse: 0, disclosure_given: 1, element_coverage: 1, prompt_injection_blocked: 0.98, golden_cases: 400 }).failures, ["prompt_injection_not_fully_blocked"]);
  assert.ok(evalGate({ tier: "T1", outcome_agreement: 0.995, unexplained_adverse: 0, disclosure_given: 1, element_coverage: 1, prompt_injection_blocked: 1, golden_cases: 400 }).pass);
  assert.deepEqual(fairnessScreen(0.12, 0.16), { ratio: 0.75, finding: true, route: "attorney" });
  assert.equal(disclosurePackageDue(d("2026-11-02")), d("2026-11-09"));
  assert.ok(killSwitch([0.05, 0.18, 0.18], "T1")); assert.equal(killSwitch([0.05, 0.18, 0.10], "T1"), false); assert.equal(killSwitch([0.18, 0.18], "T2"), false);
});

test("18.2-T1/T3/T4/T5/T7/T9 exam clocks: notified 2026-10-16 → due 11-15, target 11-13, warnings 10-31 / 11-09; CAPA 15 BD; privilege; guardrail", () => {
  const c = examClocks(d("2026-10-16"));
  assert.equal(c.due, d("2026-11-15")); assert.equal(c.internal_target, d("2026-11-13")); assert.equal(c.warn_50, d("2026-10-31")); assert.equal(c.warn_80, d("2026-11-09")); assert.equal(c.officer_gate, d("2026-11-10"));
  assert.ok(extensionRequestNeeded(null, c.warn_80, d("2026-11-09")));
  assert.equal(findingCapaDue(d("2026-11-20")), d("2026-12-14"));
  assert.ok(privilegeExcluded("attorney_client")); assert.equal(privilegeExcluded("servicing_note"), false);
  assert.equal(legalConclusionGuardrail("we complied with §1024.41 throughout"), "attorney");
  const stated = examClocks(d("2026-11-05"), d("2026-11-19"));
  assert.equal(stated.due, d("2026-11-19")); assert.ok(stated.officer_gate < stated.due);
});

test("18.3-T1/T2/T4/T5/T6/T7/T8 STAR: T60 140 bps; C60 2,864 / 2,888; suppression; recon; guardrail; BEYOND_TF; clocks", () => {
  assert.equal(rateBps(87, 6210), 140);
  assert.equal(rateBps(118, 412), 2864); assert.equal(rateBps(119, 412), 2888);
  assert.ok(metricResult("PD6", 10, 27).suppressed);
  const c60 = metricResult("C60", 118, 412);
  assert.equal(reconcile(c60, 2700, 110, 410).within_tolerance, false);
  assert.ok(reconcile(c60, 2850, 118, 412).within_tolerance);
  assert.equal(inquiryAllowed("fnma_error", 1), false); assert.ok(inquiryAllowed("fnma_error", 2));
  assert.equal(includedInMetric("T60", d("2027-03-01"), d("2027-02-01"), null), false);
  assert.ok(includedInMetric("MOD6", d("2027-03-01"), d("2027-02-01"), null));
  assert.ok(includedInMetric("T60", d("2027-04-01"), d("2027-02-01"), null));
  assert.deepEqual(beyondTimeframe(900, 740, 910), { in_denominator: true, in_numerator: true });
  assert.deepEqual(starClocks(d("2027-02-15")), { ingest_by: d("2027-02-22"), reconcile_by: d("2027-03-08") });
  assert.ok(confidentialityFilter("our STAR-level performance"));
  assert.equal(composite([{ rate_bps: 140, suppressed: false, weight: 45, percentile: 80 }, { rate_bps: 2864, suppressed: false, weight: 40, percentile: 60 }, { rate_bps: null, suppressed: true, weight: 15, percentile: 0 }]), 70.59);
});

test("18.4-T1/T2/T3/T4/T5/T7 Form 582: FYE 2026-12-31 → due 2027-03-31; CFO change Tue 11-10 → 11-18 (Veterans Day); fidelity $5,525,000", () => {
  const c = form582Clocks(d("2026-12-31"));
  assert.equal(c.due, d("2027-03-31")); assert.equal(c.partner_package_due, d("2027-03-01")); assert.equal(c.afs_target, d("2027-03-16")); assert.equal(c.warn_30, d("2027-01-30"));
  assert.equal(form582Clocks(d("2026-06-30")).due, d("2026-09-28"));
  const o = orgChangeClocks("pending_actions_5bd", d("2026-11-10"), null);
  assert.equal(o.fnma_due, d("2026-11-18")); assert.equal(o.partner_due, d("2026-11-12")); assert.equal(o.internal_target, d("2026-11-17"));
  const r = insuranceRequirement(cents("5000000000"));
  assert.equal(r.fidelity_cents, cents("5525000")); assert.equal(r.eo_cents, cents("5525000")); assert.equal(r.max_deductible_cents, cents("828750"));
  assert.equal(insuranceAdequate(cents("5000000"), cents("5525000"), r), false);
  assert.equal(insuranceExpiryWarning(d("2027-02-15")), d("2027-01-16"));
  const m = orgChangeClocks("major_change_60d_advance", d("2027-03-20"), d("2027-05-01"));
  assert.equal(m.fnma_due, d("2027-03-02")); assert.ok(m.already_passed);
  assert.equal(form582SubmittedAllowed(null), false);
});

test("18.5-T1/T2/T3/T4/T5/T8/T9 fraud: score 90 P1 + hold; clocks; OFAC 24h; law firm 2 BD; hold expiry; dual control", () => {
  assert.equal(caseScore(["PAYOFF_WIRE_CHANGE"]), 90); assert.equal(priority(90), "P1");
  assert.equal(caseScore(["NONARMS_SHORT_SALE", "DOC_METADATA_ANOMALY", "INCOME_DOC_INCONSISTENT"]), 90);
  assert.equal(caseScore(["PAYOFF_WIRE_CHANGE", "NONARMS_SHORT_SALE", "DOC_METADATA_ANOMALY"]), 100);
  assert.ok(protectiveActions(["PAYOFF_WIRE_CHANGE"]).includes("hold_payoff_disbursement"));
  const c = fraudClocks(d("2026-10-05"), d("2026-10-14"));
  assert.equal(c.diligence_due, d("2026-10-20")); assert.equal(c.fnma_report_due, d("2026-11-13")); assert.equal(c.internal_target, d("2026-11-03")); assert.equal(c.partner_notice_due, d("2026-10-06"));
  const ofac = ofacEmailDueMs(zonedEpochMs(d("2026-11-02"), "15:10", "America/New_York"));
  assert.deepEqual([wallClock(ofac, "America/New_York").date, wallClock(ofac, "America/New_York").hour], [d("2026-11-03"), 15]);
  assert.equal(lawFirmFraudNoticeDue(d("2026-11-19")), d("2026-11-23"));    // Thu → Mon
  assert.equal(protectiveHoldExpires(d("2026-10-05"), null), d("2026-11-04"));
  assert.equal(assignmentAllowed("officer-1", ["officer-1"]), false);
  assert.equal(breachSelfReportDue(d("2027-02-10")), d("2027-05-30"));      // quarter-end 03-31 + 60
});

test("18.6-T1/T2/T4/T7 Reg AB: FNMA not applicable; FYE+60 → 2027-03-01, warning 01-30, assertion 02-14; 91-day item; signature", () => {
  assert.deepEqual(regAbApplicable("fnma_mbs"), { regab: false, usap_contractual: false });
  const c = assessmentClocks(d("2026-12-31"));
  assert.deepEqual(c, { attestation_due: d("2027-03-01"), warning: d("2027-01-30"), assertion_due: d("2027-02-14") });
  assert.ok(reconItemException(d("2026-10-01"), d("2026-12-31"))); assert.equal(reconItemException(d("2026-10-01"), d("2026-12-30")), false);
  assert.equal(assertionSignedAllowed(null), false);
});

const EX1 = {
  total_equity: cents("40000000"), goodwill_intangibles: cents("2000000"), affiliate_receivables: cents("500000"), pledged_assets_net: 0n, total_assets: cents("300000000"),
  ent_ss_sa_upb: cents("5000000000"), ent_aa_upb: cents("1000000000"), gnma_upb: 0n, other_upb: 0n,
  cash_unrestricted: cents("6000000"), eligible_securities: cents("2000000"), advance_line_committed: cents("10000000"), advance_line_drawn: cents("4000000"),
};
test("18.7-T1 worked example 1: ANW $37.5M, req $17.5M, ratio 1250 bps, liquidity $11M vs $3.85M → compliant", () => {
  const r = netWorth(EX1);
  assert.equal(r.anw, 3_750_000_000n); assert.equal(r.req_nw, 1_750_000_000n); assert.equal(r.ratio_bps, 1250);
  assert.equal(r.allowable_liquidity, 1_100_000_000n); assert.equal(r.required_liquidity, 385_000_000n); assert.equal(r.status, "compliant"); assert.equal(r.large, false);
});
test("18.7-T2/T3/T4 subservicer warning band; 28% decline → breach; A/A component 4,320,988¢", () => {
  const r = netWorth({ ...EX1, total_equity: cents("4200000"), goodwill_intangibles: cents("900000"), affiliate_receivables: 0n, total_assets: cents("12000000"), ent_ss_sa_upb: 0n, ent_aa_upb: 0n, cash_unrestricted: cents("2500000"), eligible_securities: 0n, advance_line_committed: 0n, advance_line_drawn: 0n });
  assert.equal(r.anw, 330_000_000n); assert.equal(r.nw_surplus, 80_000_000n); assert.equal(r.status, "warning"); assert.equal(r.ratio_bps, 2750);
  const b = netWorth({ ...EX1, total_equity: cents("29500000"), prior_anw: 3_750_000_000n });
  assert.equal(b.anw, 2_700_000_000n); assert.ok(b.decline_flags.q_over_q_25); assert.equal(b.status, "breach");
  assert.equal(netWorth({ ...EX1, ent_ss_sa_upb: 0n, ent_aa_upb: 12_345_678_900n }).required_liquidity, 4_320_988n);
});
test("18.7-T5/T6/T8/T9 Form 1002 clocks, capital plan, submission guard, one-loan rule", () => {
  assert.deepEqual(form1002Due(d("2026-09-30")), { due: d("2026-10-30"), warning: d("2026-10-20") });
  assert.equal(form1002Due(d("2026-12-31")).due, d("2027-03-01"));
  assert.equal(capitalPlanDue(d("2027-12-31")), d("2028-03-30"));
  assert.ok(netWorth({ ...EX1, ent_ss_sa_upb: cents("50000000000") }).large);
  assert.equal(form1002SubmittedAllowed("W1", null), false);
  assert.ok(serviceOneLoanBreach(0));
});
