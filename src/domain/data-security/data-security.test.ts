import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as d } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";
import {
  anniversary, retention, nextDisposalRun, holdReleaseAllowed, disposalAllowed, servicingFileDue, fnmaRecordsRequestDue, ftcDisposalDue, routeRecordsRequest, redactionRequired,
  incidentClocks, fnmaReportable, timerBreached, nydfsClocks, extortionClocks, countConsumers, ftcNotice, stateNotices, credentialRotation, vulnSlaMs, containmentAllowed, nydfsPackage, tlsCipherOk, restoreTestResult,
  regimeActive, earliestCutover, cutoverAllowed, contractCopiesDue, transitionPlanDue, form101TerminationDue, disclosureResponseDue, schemaDriftDisableOn, reassessment, vendorActivationGate, fnmaAdapterAllowed, promptPayloadOk,
  inScope, ageAtApplication, scifLanguage, rateTest, materialReviewDue, biasGate, leakageScan, transferOutExport, impactAssessmentDue, assumptionVersion, ccpaDeletionResponse, boardingFollowupDue,
} from "./index.ts";

const ET = "America/New_York";

test("19.1-T1 payoff example: gates 2028-03-15 / 2030-03-10 / 2030-03-24 / 2031-03-15 → eligible 2031-03-15; first run Sun 2031-04-06", () => {
  const g = retention({ liquidated_on: d("2027-03-15"), discharged_on: d("2027-03-15"), transferred_out_on: null, final_entry_on: d("2027-03-24"), state: "NY", fdcpa_debt_collector: true, last_collection_activity_on: d("2027-03-10"), reg_b_notified_on: d("2027-01-20"), hold_count: 0, loan_active: false }, d("2027-04-01"));
  assert.deepEqual([g.regx, g.regf, g.ny, g.fnma, g.reg_b], [d("2028-03-15"), d("2030-03-10"), d("2030-03-24"), d("2031-03-15"), d("2029-02-20")]);
  assert.equal(g.eligible_for_disposal_at, d("2031-03-15")); assert.equal(g.status, "retained");
  assert.equal(nextDisposalRun(d("2031-03-15")), d("2031-04-06"));
});

test("19.1-T2/T3/T7/T8/T11 transfer-out 2028-10-01 → Reg X 2029-10-01, effective 2032-10-01; permanent while active; holds; Feb 29", () => {
  const g = retention({ liquidated_on: null, discharged_on: null, transferred_out_on: d("2028-10-01"), final_entry_on: d("2028-10-31"), state: "NY", fdcpa_debt_collector: false, last_collection_activity_on: null, hold_count: 0, loan_active: true }, d("2028-11-01"));
  assert.equal(g.regx, d("2029-10-01")); assert.equal(g.ny, d("2031-10-31")); assert.equal(g.policy_transfer, d("2032-10-01")); assert.equal(g.eligible_for_disposal_at, d("2032-10-01"));
  const active = retention({ liquidated_on: null, discharged_on: null, transferred_out_on: null, final_entry_on: null, state: "TX", fdcpa_debt_collector: false, last_collection_activity_on: null, hold_count: 0, loan_active: true }, d("2028-11-01"));
  assert.equal(disposalAllowed(active, true, true).reason, "permanent_while_active");
  const held = retention({ liquidated_on: d("2027-03-15"), discharged_on: d("2027-03-15"), transferred_out_on: null, final_entry_on: null, state: "TX", fdcpa_debt_collector: false, last_collection_activity_on: null, hold_count: 1, loan_active: false }, d("2031-06-01"));
  assert.equal(held.status, "held"); assert.equal(disposalAllowed(held, true, true).reason, "legal_hold");
  assert.equal(holdReleaseAllowed(["officer"]), false); assert.ok(holdReleaseAllowed(["officer", "attorney"]));
  assert.equal(nextDisposalRun(d("2032-02-01")), d("2032-03-07"));
  assert.equal(anniversary(d("2028-02-29"), 4), d("2032-03-01"));
  const elig = retention({ liquidated_on: d("2027-03-15"), discharged_on: d("2027-03-15"), transferred_out_on: null, final_entry_on: null, state: "TX", fdcpa_debt_collector: false, last_collection_activity_on: null, hold_count: 0, loan_active: false }, d("2031-06-01"));
  assert.equal(disposalAllowed(elig, false, true).reason, "worm_integrity_failed_sev1");
  assert.ok(disposalAllowed(elig, true, true).allowed);
});

test("19.1-T4/T6/T10/T13 request clocks and routing", () => {
  assert.equal(servicingFileDue(d("2026-10-16")), d("2026-10-21"));
  assert.equal(fnmaRecordsRequestDue(d("2026-11-19")), d("2026-12-04"));
  assert.equal(ftcDisposalDue(d("2026-10-01"), false), d("2028-10-01")); assert.equal(ftcDisposalDue(d("2026-10-01"), true), null);
  assert.equal(routeRecordsRequest({ borrower_signed: true, requester: "borrower" }), "4.2_rfi");
  assert.equal(redactionRequired("fnma"), false); assert.ok(redactionRequired("borrower"));
});

test("19.2-T1/T2/T5/T9 incident clocks: Fri 10-16 14:30 → partner Sat 14:30, Fannie Sun 02:30; NYDFS Mon 10:00 → Thu 10:00; extortion", () => {
  const id = zonedEpochMs(d("2026-10-16"), "14:30", ET);
  const c = incidentClocks(id);
  const f = wallClock(c.fnma_due_ms, ET); assert.deepEqual([f.date, f.hour, f.minute], [d("2026-10-18"), 2, 30]);
  const p = wallClock(c.partner_due_ms, ET); assert.deepEqual([p.date, p.hour], [d("2026-10-17"), 14]);
  assert.equal(c.assessment_engage_by, d("2026-10-30")); assert.equal(c.assessment_complete_by, d("2027-01-14"));
  assert.ok(timerBreached(c.fnma_due_ms, zonedEpochMs(d("2026-10-18"), "03:00", ET)));
  assert.ok(fnmaReportable("S2"));
  const n = nydfsClocks(zonedEpochMs(d("2026-10-19"), "09:00", ET), zonedEpochMs(d("2026-10-19"), "10:00", ET));
  assert.deepEqual([wallClock(n.notice_due_ms!, ET).date, wallClock(n.notice_due_ms!, ET).hour], [d("2026-10-22"), 10]);
  const e = extortionClocks(zonedEpochMs(d("2026-10-20"), "16:00", ET));
  assert.equal(wallClock(e.nydfs_due_ms, ET).date, d("2026-10-21")); assert.equal(e.ftc_or_dfs_30d, d("2026-11-19"));
});

test("19.2-T3/T4/T6/T7 consumer counting, FTC anchor, state matrix", () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ id: `c${i}`, state: i < 100 ? "NY" : "TX", encrypted: i % 2 === 0, key_compromised_or_presumed: true }));
  const cc = countConsumers([...rows, rows[0]!]);
  assert.equal(cc.total, 600); assert.equal(cc.unencrypted_or_key_presumed, 600); assert.equal(cc.by_state.NY, 100);
  assert.deepEqual(ftcNotice(d("2026-10-16"), 12400), { required: true, due: d("2026-11-15"), internal_target: d("2026-11-13") });
  assert.equal(ftcNotice(d("2026-10-16"), 480).required, false);
  assert.equal(ftcNotice(d("2026-10-16"), 510).due, d("2026-11-15"));                       // corrected count keeps the original anchor
  const ny = stateNotices("NY", d("2026-10-16"), 3100);
  assert.ok(!("refused" in ny) && ny.consumer_due === d("2026-11-15") && ny.cra_due === null);
  const ny2 = stateNotices("NY", d("2026-10-16"), 5001);
  assert.ok(!("refused" in ny2) && ny2.cra_due !== null);
  const tx = stateNotices("TX", d("2026-10-16"), 2000);
  assert.ok(!("refused" in tx) && tx.consumer_due === d("2026-12-15") && tx.ag_due === d("2026-11-15"));
  assert.ok("refused" in stateNotices("ZZ", d("2026-10-16"), 10));
});

test("19.2-T10..T16 controls: credential rotation, vuln SLA 72h, containment cap, certification vs acknowledgment, TLS, restore", () => {
  assert.deepEqual(credentialRotation("system_id", d("2025-10-01")), { due: d("2026-10-01"), auto_disable: true });
  assert.equal(credentialRotation("human", d("2026-07-01")).due, d("2026-09-29"));
  const v = vulnSlaMs(zonedEpochMs(d("2026-11-02"), "09:00", ET), "critical", true);
  assert.deepEqual([wallClock(v, ET).date, wallClock(v, ET).hour], [d("2026-11-05"), 9]);
  assert.equal(containmentAllowed(51, false), false); assert.ok(containmentAllowed(51, true));
  assert.equal(nydfsPackage([{ id: "CTL-SEC-01", result: "fail", exception_approved: false }]).kind, "acknowledgment_of_noncompliance");
  assert.equal(nydfsPackage([{ id: "CTL-SEC-01", result: "fail", exception_approved: true }]).kind, "certification");
  assert.ok(tlsCipherOk("ECDHE-RSA-AES256-GCM-SHA384")); assert.equal(tlsCipherOk("AES256-SHA"), false);
  assert.equal(restoreTestResult(0, 5), "failed"); assert.equal(restoreTestResult(1, 5), "passed");
});

test("19.3-T1..T5/T9/T10/T11/T12 regime, 180-day gate, 5-BD copies (Thanksgiving / Christmas), plan 10 BD, Form 101, drift, reassessment", () => {
  const counts = [{ on: d("2027-01-01"), count: 19990 }, { on: d("2027-08-03"), count: 20300 }, { on: d("2027-11-01"), count: 18000 }];
  assert.equal(regimeActive(counts, d("2027-08-02")), false); assert.ok(regimeActive(counts, d("2027-08-03"))); assert.ok(regimeActive(counts, d("2027-12-31")));
  assert.equal(regimeActive(counts, d("2028-01-15")), false);
  assert.equal(earliestCutover(d("2026-11-02")), d("2027-05-01")); assert.equal(cutoverAllowed(d("2026-11-02"), d("2027-04-01")), false);
  assert.equal(contractCopiesDue(d("2026-11-20")), d("2026-11-30"));
  assert.equal(contractCopiesDue(d("2026-12-23")), d("2026-12-31"));
  assert.equal(transitionPlanDue(d("2027-01-12")), d("2027-01-27"));
  assert.equal(form101TerminationDue(d("2027-06-30")), d("2027-07-08"));
  // Spec 19.3-T10 says Oct 12, but Oct 12, 2026 is Columbus Day on the fannie_et calendar → Oct 13 (audit note).
  assert.equal(disclosureResponseDue(d("2026-10-05")), d("2026-10-13"));
  assert.equal(schemaDriftDisableOn(d("2026-10-01")), d("2027-01-29"));
  assert.deepEqual(reassessment(1, d("2026-03-01")), { due: d("2027-03-01"), escalate_on: d("2027-04-30") });
});

test("19.3-T6/T7/T8 clause gate, AI deviation, Form 101 adapter guard, prompt payload", () => {
  const full: Record<string, "present"> = {};
  for (const c of ["A2101_FNMA_OWNERSHIP_FILES_DATA", "A2101_FNMA_ACCESS_AUDIT", "A2101_TERMINATION_RETURN_DESTROY", "A2107_RESCISSION_ACK", "SUPPLEMENT_FLOWDOWN_NO_LESS_PROTECTIVE", "INCIDENT_NOTICE_24H", "AUDIT_RIGHTS", "DATA_USE_LIMITED_TG3", "RECORDS_RETURN_5BD", "US_ONLY_PROCESSING", "SUBPROCESSOR_NOTICE", "NO_UI_SCRAPING", "NO_TRAINING_ON_DATA", "LIMITED_RETENTION_30D", "NO_HUMAN_REVIEW_WITHOUT_NOTICE", "MODEL_VERSION_CHANGE_NOTICE", "ASSURANCE_REPORTS", "FNMA_DISCLOSURE_COOPERATION"]) full[c] = "present";
  assert.ok(vendorActivationGate(full, true, false, false).allowed);
  const { A2101_FNMA_OWNERSHIP_FILES_DATA: _drop, ...missingOne } = full;
  const g = vendorActivationGate(missingOne, false, false, false);
  assert.equal(g.allowed, false); assert.deepEqual(g.missing, ["A2101_FNMA_OWNERSHIP_FILES_DATA"]); assert.deepEqual(g.tasks, ["attorney"]);
  const dev = vendorActivationGate({ ...full, NO_TRAINING_ON_DATA: "deviation" }, true, true, false);
  assert.equal(dev.allowed, false); assert.ok(vendorActivationGate({ ...full, NO_TRAINING_ON_DATA: "deviation" }, true, true, true).allowed);
  assert.deepEqual(fnmaAdapterAllowed(false), { allowed: false, reason: "form101_inactive" });
  assert.deepEqual(promptPayloadOk({ loan_token: "L1", ssn: "x" }).violations, ["ssn"]);
});

test("19.4-T1/T2/T8/T9 scope, age 34, worked z-test: AIR 0.873, z −2.72, p ≈ 0.0065, material; suppression n=8", () => {
  assert.ok(inScope(d("2023-03-01"))); assert.equal(inScope(d("2023-02-28")), false);
  assert.equal(ageAtApplication(d("1988-06-15"), d("2023-02-10")), 34); assert.equal(scifLanguage("Spanish"), "spanish");
  const r = rateTest({ group_n: 250, group_events: 155, comparison_n: 900, comparison_events: 639, adjusted_or: 0.71 });
  assert.equal(r.air, 0.873); assert.equal(r.screen, false); assert.equal(r.z, -2.72); assert.ok(Math.abs(r.p - 0.0065) < 0.0005);
  assert.ok(r.significant && r.material); assert.equal(r.review_due_days, 30);
  assert.ok(rateTest({ group_n: 8, group_events: 3, comparison_n: 900, comparison_events: 639 }).suppressed);
  assert.ok(rateTest({ group_n: 25, group_events: 10, comparison_n: 900, comparison_events: 639 }).pooled);
  assert.equal(materialReviewDue(d("2027-04-01")), d("2027-05-01"));
});

test("19.4-T7/T10/T11/T12/T13/T15 export target, bias gate flip 1.4%, leakage, assumption, CCPA, impact assessment", () => {
  assert.deepEqual(transferOutExport(d("2027-04-01")), { target: d("2027-03-25"), breach_if_no_ack_by: d("2027-04-01") });
  assert.deepEqual(biasGate({ leakage_clean: true, counterfactual_flip_rate: 0.014, directional_shift: false, outcome_parity_ok: true, explanation_consistent: true }).failures, ["counterfactual_perturbation"]);
  assert.ok(biasGate({ leakage_clean: true, counterfactual_flip_rate: 0.004, directional_shift: false, outcome_parity_ok: true, explanation_consistent: true }).pass);
  assert.deepEqual(leakageScan({ loan_token: "L1", race_codes: [5] }), { clean: false, fields: ["race_codes"], action: "quarantine_sev1" });
  assert.equal(assumptionVersion(true), "new_version_assumption"); assert.equal(assumptionVersion(false), "unchanged_annotated");
  assert.deepEqual(ccpaDeletionResponse(), { deleted: false, basis: "GLBA_exemption" });
  assert.equal(impactAssessmentDue(d("2026-11-01")), d("2027-01-30"));
  assert.equal(boardingFollowupDue(d("2027-01-05")), d("2027-02-04"));
});
