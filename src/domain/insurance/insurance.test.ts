import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as d } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import {
  evaluateAdequacy, renewalShortcut, confirmationRequired, masterPolicyDeficiencies, deficiencyNoticeDue, lapseDetectedOn, annualReminderDue, vendorFeedSeverity,
  type HazardPolicy,
  reasonableBasis, selectTrack, escrowGuard, lpiCoverage, tierDeductible, premiumFromRate, fpiClocks, reminderAllowed, chargeDecision, productionWindowOk,
  firstNoticeContent, noticeChecklist, reminderVariant, premiumQuote, renewalClocks, renewalNoticeAllowed, gapChargeDecision,
  cancellation, dailyRate, overlapDays, overlapPremium, fnmaRemittanceDue, servicerNetCost, type LpiTerm,
  floodRequired, floodRequiredAmount, floodAdequate, rcbap, privatePolicyAcceptable, floodNoticeClocks, placementAllowed, nfipEffectiveDate, fnmaEvidenceDue,
  lossDraftTrack, initialRelease, progressReleaseCurrent, progressReleaseDelinquent, custodialInterest, contentsReleaseDue, form176Due, reogramRemitDue, supplementalWireDue, notRebuildableDisposition, thirdPartyReleaseAllowed,
  fnmaDaysDelinquent, inspectionWindow, inspectionMode, inspectionSuspended, nextInspectionWindow, preSaleInspection, inspectionClaim, servicerBackstopOrder, pfpipPermission, inspectionType,
  preservationMode, initialServicesDue, evaluateScope, itemDisposition, bidDue, reconsiderationDue, winterizationRequired, tarpDeadline, registrationClocks, auditDocumentsDue,
} from "./index.ts";

const GOOD: HazardPolicy = {
  coverage_dwelling_cents: cents("250000"), coverage_basis: "replacement_cost", coverage_form: "special", deductible_cents: cents("8000"),
  per_peril_deductibles: [], ratings: [{ agency: "am_best", grade: "A" }],
  mortgagee_clause: { names_partner_isaoa: true, co_servicer: true, names_mers: false }, named_insureds: ["Jane Doe"], excludes_wind: false,
};

test("9.1-T1 dec page Special/RC/$8,000 on $250,000/AM Best A → PASS", () => {
  const r = evaluateAdequacy(GOOD, ["Jane Doe"]);
  assert.ok(r.pass); assert.deepEqual(r.deficiencies, []);
});

test("9.1-T2 $12,500 on $250,000 is exactly 5% → PASS; $12,501 → deductible_excess; notice within 5 servicer BD", () => {
  assert.ok(evaluateAdequacy({ ...GOOD, deductible_cents: cents("12500") }, ["Jane Doe"]).pass);
  const r = evaluateAdequacy({ ...GOOD, deductible_cents: cents("12501") }, ["Jane Doe"]);
  assert.deepEqual(r.deficiencies, ["deductible_excess"]);
  assert.equal(r.lpi_curable, false);
  assert.equal(deficiencyNoticeDue(d("2027-04-30")), d("2027-05-07"));
});

test("9.1 rule 8 worked example: $10,000 on $312,000 = 3.2051%, wind 2%, roof ACV → verified; decrease unconfirmed path", () => {
  const r = evaluateAdequacy({ ...GOOD, coverage_dwelling_cents: cents("312000"), deductible_cents: cents("10000"), roof_basis: "acv",
    per_peril_deductibles: [{ peril: "wind", pct: "2" }], ratings: [{ agency: "am_best", grade: "A-" }] }, ["Jane Doe"]);
  assert.ok(r.pass);
  assert.equal(r.deductible_pct.slice(0, 8), "0.032051");
  assert.equal(renewalShortcut(cents("312000"), cents("300000"), false), "verified");
  assert.equal(renewalShortcut(cents("280000"), cents("300000"), false), "coverage_decrease_unconfirmed");   // 9.1-T3
});

test("9.1-T4/T7/T8 confirmation on low confidence; master per-unit deductible; MERS mortgagee", () => {
  assert.deepEqual(confirmationRequired({ policy_number: 0.82, effective_date: 0.99, expiration_date: 0.99, coverage_amount: 0.95, deductible: 0.95, mortgagee_clause: 0.95, property_address: 0.95 }), ["policy_number"]);
  assert.deepEqual(masterPolicyDeficiencies(cents("60000"), false, true), ["master_lapse", "unit_policy_missing"]);
  assert.deepEqual(evaluateAdequacy({ ...GOOD, mortgagee_clause: { names_partner_isaoa: true, co_servicer: true, names_mers: true } }, ["Jane Doe"]).deficiencies, ["mortgagee_clause"]);
});

test("9.1-T5/T6/T9 lapse detection, annual reminder, vendor heartbeat", () => {
  assert.equal(lapseDetectedOn(d("2027-04-30"), false), d("2027-05-01"));
  assert.equal(lapseDetectedOn(d("2027-04-30"), true), null);
  assert.ok(annualReminderDue(d("2026-03-01"), d("2027-03-05")));
  assert.equal(annualReminderDue(d("2026-09-01"), d("2027-03-05")), false);
  assert.equal(vendorFeedSeverity(d("2027-03-01"), d("2027-03-04")), "sev2");
  assert.equal(vendorFeedSeverity(d("2027-03-01"), d("2027-03-03")), "ok");
});

// ---- 9.2 / 9.3 / 9.4 ------------------------------------------------------------

test("9.2 rule 8 worked example: t0 2026-10-05 → reminder ≥ 11-04, charge ≥ 11-19; day 44 refused; retro to 2026-10-01; 600 c/day", () => {
  const c0 = fpiClocks(d("2026-10-05"), null);
  assert.equal(c0.reminder_not_before, d("2026-11-04"));
  assert.equal(c0.earliest_charge, d("2026-11-19"));
  assert.equal(reminderAllowed(c0, d("2026-11-03")), false);                   // 9.3-T1
  assert.ok(reminderAllowed(c0, d("2026-11-04")));
  const c1 = fpiClocks(d("2026-10-05"), d("2026-11-04"));
  assert.equal(c1.earliest_charge, d("2026-11-19"));
  assert.equal(chargeDecision(c1, d("2026-11-18"), null, d("2026-10-01")).allowed, false);   // 9.2-T1
  const ok = chargeDecision(c1, d("2026-11-19"), null, d("2026-10-01"));
  assert.ok(ok.allowed && ok.effective === d("2026-10-01") && ok.expiration === d("2027-10-01"));   // 9.2-T2
  assert.equal(chargeDecision(c1, d("2026-11-19"), d("2026-11-19"), d("2026-10-01")).allowed, false);   // 9.2-T8 evidence on day 15 counts
  assert.equal(premiumFromRate(cents("250000"), "0.876"), cents("2190"));      // 9.3 rule 2
  assert.equal(dailyRate({ effective: d("2026-10-01"), expiration: d("2027-10-01"), premium_cents: cents("2190") }).toFixed(6), "600.000000");
  assert.equal(fpiClocks(d("2026-10-05"), d("2026-11-07")).earliest_charge, d("2026-11-22"));   // 9.3-T5
});

test("9.2-T3/T4 escrow guard; T6 wind type; T9 flood track; T5 checklist; T7 production window", () => {
  assert.equal(escrowGuard(true, 45, "nonpayment"), "k5_blocked");
  assert.equal(escrowGuard(true, 45, "underwriting"), "k5_inability_documented");
  assert.equal(escrowGuard(true, 10, "nonpayment"), "servicer_pays");
  assert.equal(escrowGuard(false, 0, null), "proceed");
  assert.equal(firstNoticeContent("expired", "wind").insurance_type, "windstorm");
  assert.equal(selectTrack("flood"), "fdpa_flood");
  assert.equal(noticeChecklist([{ kind: "required" }, { kind: "account_number" }, { kind: "other" }]).ok, false);
  assert.equal(productionWindowOk(d("2026-10-01"), d("2026-10-09")), false);
  assert.ok(productionWindowOk(d("2026-10-05"), d("2026-10-09")));
  assert.equal(productionWindowOk(d("2026-10-30"), d("2026-11-09")), false);   // 9.3-T4
  assert.ok(productionWindowOk(d("2026-10-30"), d("2026-11-06")));
  assert.equal(reasonableBasis("insufficient_coverage", "deductible_excess"), false);
  assert.ok(reasonableBasis("insufficient_coverage", "coverage_basis"));
});

test("9.2-T11 CA cap: RCV $310,000, last-known $360,000 → $310,000, deductible $2,500; tiers", () => {
  const r = lpiCoverage({ last_known_cents: cents("360000"), rcv_cents: cents("310000"), upb_cents: cents("200000"), state_cap_cents: cents("310000") });
  assert.equal(r.coverage_cents, cents("310000")); assert.equal(r.deductible_cents, cents("2500"));
  const w = lpiCoverage({ last_known_cents: cents("250000"), rcv_cents: cents("262000"), upb_cents: cents("200000"), state_cap_cents: null });
  assert.equal(w.coverage_cents, cents("250000")); assert.equal(w.deductible_cents, cents("2000"));
  assert.equal(tierDeductible(cents("250000.01")), cents("2500"));
});

test("9.3-T2/T3/T6 reminder variants and estimates", () => {
  assert.equal(reminderVariant([], d("2026-10-01"), d("2026-11-04")).variant, "b_no_info");
  const c = reminderVariant([{ received_on: d("2026-10-20"), effective: d("2026-10-15"), expiration: null, written: true }], d("2026-10-01"), d("2026-11-04"));
  assert.equal(c.variant, "c_insufficient");
  assert.deepEqual(c.gaps, [{ from: d("2026-10-01"), to: d("2026-10-14") }]);
  const q = premiumQuote(null, cents("250000"), "0.876");
  assert.equal(q.annual_premium_cents, cents("2190")); assert.ok(q.is_estimate);
});

test("9.4-T1/T2/T3/T4 renewal: A = 2027-10-01; notice 08-02 → chargeable 09-16; notice 09-10 → 10-25; once per year; gap charge", () => {
  const r = renewalClocks(d("2026-10-01"), d("2027-08-02"));
  assert.equal(r.anniversary, d("2027-10-01")); assert.equal(r.notice_target, d("2027-08-02")); assert.equal(r.chargeable, d("2027-09-16"));
  assert.equal(renewalClocks(d("2026-10-01"), d("2027-09-10")).charge_on, d("2027-10-25"));
  assert.equal(r.charge_on, d("2027-10-01"));
  assert.equal(renewalNoticeAllowed({ mailed: d("2027-08-02"), anniversary: d("2027-10-01") }, d("2027-10-01"), d("2028-02-18")), false);
  assert.ok(renewalNoticeAllowed({ mailed: d("2027-08-02"), anniversary: d("2027-10-01") }, d("2028-10-01"), d("2028-08-02")));
  const rate = dailyRate({ effective: d("2027-10-01"), expiration: d("2028-10-01"), premium_cents: cents("2250") });
  const g = gapChargeDecision(20, rate, false);
  assert.ok(g.action === "prompt_charge" && g.cents === cents("122.95"));      // 225000/366×20 = 12295.08 (leap term)
  assert.equal(gapChargeDecision(20, rate, true).action, "new_cycle");
  assert.equal(lpiCoverage({ last_known_cents: cents("250000"), rcv_cents: cents("230000"), upb_cents: cents("200000"), state_cap_cents: null }).coverage_cents, cents("230000"));   // 9.4-T5
});

// ---- 9.5 -------------------------------------------------------------------------

const TERM: LpiTerm = { effective: d("2026-10-01"), expiration: d("2027-10-01"), premium_cents: cents("2190") };

test("9.5-T1/T2 worked example: overlap 290 days, $1,740 removed, $450 retained, $150 refund, $300 due, deadline 2027-01-27", () => {
  assert.equal(overlapDays(TERM, d("2026-12-15"), null), 290);
  assert.equal(overlapPremium(TERM, 290), cents("1740"));
  const r = cancellation({ terms: [TERM], borrower_coverage_start: d("2026-12-15"), borrower_coverage_end: null, evidence_received_on: d("2027-01-12"), borrower_paid_cents: cents("600") });
  assert.equal(r.removed_cents, cents("1740")); assert.equal(r.retained_cents, cents("450"));
  assert.equal(r.refund_cents, cents("150"));
  // Spec 9.5-T2 says "$300.00 remains due" but $600 paid against a $450 retained charge leaves nothing due — audit note; engine reports 0.
  assert.equal(r.still_due_cents, 0n);
  assert.equal(r.deadline, d("2027-01-27")); assert.equal(r.cancellation_effective, d("2026-12-15")); assert.equal(r.root_cause, "borrower_evidence");
  assert.equal(servicerNetCost(cents("1740"), cents("1700")), cents("40"));
});

test("9.5-T4/T5/T6/T7 leap term $598.36; Saturday deadline stands; FNMA remittance; servicer_error full removal", () => {
  const leap: LpiTerm = { effective: d("2027-05-01"), expiration: d("2028-05-01"), premium_cents: cents("2190") };
  assert.equal(dailyRate(leap).toFixed(6), "598.360656");
  assert.equal(overlapPremium(leap, 100), cents("598.36"));
  assert.equal(cancellation({ terms: [TERM], borrower_coverage_start: d("2026-12-15"), borrower_coverage_end: null, evidence_received_on: d("2027-01-15"), borrower_paid_cents: 0n }).deadline, d("2027-01-30"));
  assert.equal(fnmaRemittanceDue(d("2027-02-10"), true), d("2027-03-12"));
  const e = cancellation({ terms: [TERM], borrower_coverage_start: d("2026-09-15"), borrower_coverage_end: null, evidence_received_on: d("2027-01-12"), borrower_paid_cents: cents("2190") });
  assert.equal(e.removed_cents, cents("2190")); assert.equal(e.refund_cents, cents("2190")); assert.equal(e.root_cause, "servicer_error");
});

// ---- 9.6 -------------------------------------------------------------------------

test("9.6-T1 remap 2027-02-03, notice 02-05 → deadline 03-22; Fannie 120-day 06-03; placement refused 03-21", () => {
  const c = floodNoticeClocks(d("2027-02-05"), d("2027-02-03"));
  assert.equal(c.borrower_deadline, d("2027-03-22")); assert.equal(c.fannie_120, d("2027-06-03"));
  assert.equal(placementAllowed(c, d("2027-03-21"), false), false);
  assert.ok(placementAllowed(c, d("2027-03-22"), false));
});

test("9.6-T2/T3/T4 required amount, private policy, RCBAP", () => {
  assert.equal(floodRequiredAmount(cents("310000"), cents("240000")), cents("240000"));
  assert.equal(floodAdequate(cents("200000"), cents("310000"), cents("240000"), cents("5000")).deficiency, "flood_insufficient");
  assert.ok(floodAdequate(cents("240000"), cents("310000"), cents("199500"), cents("5000")).ok);
  assert.ok(privatePolicyAcceptable({ compliance_aid_statement: true, b7_elements_verified: false, cancellation_clause_45_days: false, insurer_rating_ok: true }).accepted);
  assert.equal(privatePolicyAcceptable({ compliance_aid_statement: false, b7_elements_verified: true, cancellation_clause_45_days: false, insurer_rating_ok: true }).reason, "missing_45_day_cancellation_clause");
  const r = rcbap(20, cents("6000000"), cents("3000000"), cents("300000"), cents("180000"));
  assert.equal(r.required_rcbap_cents, cents("4800000")); assert.equal(r.allocation_cents, cents("150000")); assert.equal(r.supplement_cents, cents("30000"));
  assert.equal(rcbap(20, cents("6000000"), cents("4800000"), cents("300000"), cents("180000")).supplement_cents, 0n);
  assert.deepEqual(floodRequired({ principal_structure_in_sfha: false, detached_security_structure_in_sfha: false, cbrs_opa: false, participating_community: true }), { required: false, private_only: false });
});

test("9.6-T5 termination: NFIP bought 04-10 → effective 04-11; overlap 298 days → $938.90; deadline 05-14; 9.6-T9 fannie evidence 10 BD", () => {
  assert.equal(nfipEffectiveDate(d("2027-04-10"), d("2027-02-03")), d("2027-04-11"));
  assert.equal(nfipEffectiveDate(d("2028-04-10"), d("2027-02-03")), d("2028-05-10"));
  const term: LpiTerm = { effective: d("2027-02-03"), expiration: d("2028-02-03"), premium_cents: cents("1150") };
  assert.equal(dailyRate(term).toFixed(6), "315.068493");
  const r = cancellation({ terms: [term], borrower_coverage_start: d("2027-04-11"), borrower_coverage_end: null, evidence_received_on: d("2027-04-14"), borrower_paid_cents: cents("1150"), deadline_days: 30 });
  assert.equal(r.overlap_days, 298); assert.equal(r.removed_cents, cents("938.90")); assert.equal(r.deadline, d("2027-05-14"));
  assert.equal(fnmaEvidenceDue(d("2027-03-01")), d("2027-03-15"));   // Monday → 10 fannie_et BD
});

// ---- 9.7 -------------------------------------------------------------------------

test("9.7-T1/T2/T3 release sizing: $60,000 on $240,000 UPB → current $40,000; delinquent $10,000 then ≤ $15,000; $4,500 lump", () => {
  const base = { total_cents: cents("60000"), upb_cents: cents("240000"), accrued_interest_cents: cents("1000"), advances_cents: 0n };
  const cur = initialRelease({ ...base, track: "current_lt31" });
  assert.equal(cur.cents, cents("40000")); assert.equal(cur.final_inspection_required, false); assert.ok(cur.receipts_required);
  assert.equal(progressReleaseCurrent(cents("60000"), cents("40000"), cents("40000"), "0.70"), cents("14000"));
  const del = initialRelease({ ...base, track: "delinquent_31plus" });
  assert.equal(del.cents, cents("10000")); assert.ok(del.final_inspection_required); assert.equal(del.max_progress_cents, cents("15000"));
  assert.equal(progressReleaseDelinquent(cents("60000"), cents("10000"), true, false).cents, cents("15000"));
  assert.equal(progressReleaseDelinquent(cents("60000"), cents("55000"), true, false).refused, "FINAL_INSPECTION_REQUIRED");
  assert.equal(progressReleaseDelinquent(cents("60000"), cents("55000"), true, true).cents, cents("5000"));
  assert.equal(progressReleaseDelinquent(cents("60000"), cents("10000"), false, false).refused, "INSPECTION_REQUIRED");
  assert.equal(initialRelease({ ...base, total_cents: cents("4500"), track: "delinquent_31plus" }).cents, cents("4500"));
  assert.equal(lossDraftTrack({ fnma_days_delinquent: 45, abandoned: false, fc_sale_scheduled: false, rebuildable: "unknown" }), "delinquent_31plus");
});

test("9.7-T4/T5/T6/T7/T8/T9 clocks, interest, approvals, not rebuildable", () => {
  assert.equal(contentsReleaseDue(d("2027-03-08")), d("2027-03-10"));                 // Monday → Wednesday
  assert.equal(form176Due(d("2027-03-08")), d("2027-03-15"));
  assert.equal(reogramRemitDue(d("2027-05-03")), d("2027-06-02"));
  assert.equal(supplementalWireDue(d("2027-06-10")), d("2027-06-25"));                 // Juneteenth observed Fri 06-18 skipped
  assert.equal(custodialInterest(cents("20000"), "4.00", 60), cents("131.51"));
  assert.equal(thirdPartyReleaseAllowed(false), false);
  assert.deepEqual(notRebuildableDisposition(cents("60000"), cents("241000")), { curtailment_cents: cents("60000"), payoff: false });
  assert.deepEqual(notRebuildableDisposition(cents("260000"), cents("241000")), { curtailment_cents: cents("241000"), payoff: true });
});

// ---- 9.8 -------------------------------------------------------------------------

test("9.8-T1 due 2026-11-01 → order 2027-01-30, complete 03-01, vacancy exception 12-16", () => {
  const w = inspectionWindow(d("2026-11-01"));
  assert.equal(w.order_allowed, d("2027-01-30")); assert.equal(w.complete_by, d("2027-03-01")); assert.equal(w.vacancy_exception_by, d("2026-12-16"));
  assert.equal(fnmaDaysDelinquent(d("2026-11-01"), d("2027-01-30")), 90);
});

test("9.8-T2/T4/T6/T7/T8/T9 exceptions, pre-sale window, modes, claims", () => {
  const e = { occupied: true, last_qrpc_on: d("2027-02-10"), last_full_payment_on: null, performing_workout: false, performing_bk_plan: false };
  assert.ok(inspectionSuspended(e, d("2027-03-05")));
  assert.equal(inspectionSuspended(e, d("2027-03-13")), false);
  assert.equal(inspectionSuspended({ ...e, occupied: false }, d("2027-03-05")), false);
  assert.deepEqual(nextInspectionWindow(d("2027-02-20")), { from: d("2027-03-12"), to: d("2027-03-27") });
  const p = preSaleInspection(d("2027-06-15"));
  assert.equal(p.order_by, d("2027-05-25")); assert.equal(p.window_from, d("2027-05-11")); assert.equal(p.window_to, d("2027-06-14"));
  assert.equal(inspectionMode({ conventional_first_lien: true, recourse: true, enrolled: true, fnma_rejected: false }), "servicer");
  assert.equal(pfpipPermission({ bankruptcy_active: true, preserve_allowed: true }), "Do curbside inspection and no preserv.");
  assert.ok(servicerBackstopOrder("pfpip", false, 110));
  assert.deepEqual(inspectionClaim("servicer", "exterior", cents("55"), d("2027-04-01")), { claim_cents: cents("30"), due: d("2027-05-31") });   // F-1-05: exterior $30, interior $45
  assert.equal(inspectionClaim("pfpip", "exterior", cents("55"), d("2027-04-01")), null);
  assert.equal(inspectionType({ vacant: true, interior_entry_allowed: true, legal_constraint_reason: null }), "interior");
});

// ---- 9.9 -------------------------------------------------------------------------

test("9.9-T1/T2 FTV 2027-03-05 → due 03-19; worked scope $1,250 within allowables", () => {
  assert.equal(initialServicesDue(d("2027-03-05")), d("2027-03-19"));
  const s = evaluateScope([
    { kind: "lock_change", qty: 1, unit_cost_cents: cents("60") }, { kind: "boarding", qty: 2, unit_cost_cents: cents("185") },
    { kind: "yard_initial", qty: 1, unit_cost_cents: cents("150") }, { kind: "debris", qty: 8, unit_cost_cents: cents("50"), measure: 8 },
    { kind: "winterization", qty: 1, unit_cost_cents: cents("220") }, { kind: "posting", qty: 1, unit_cost_cents: cents("50") },
  ]);
  assert.equal(s.total_cents, cents("1250")); assert.equal(s.prior_approval_required, false);
});

test("9.9-T3/T4/T5/T6/T8 debris 25 CY → bid by 03-23; 15 CY BATF; grass 40″ bid / 20″ BATF; winterization; tarp", () => {
  assert.equal(itemDisposition({ kind: "debris", qty: 25, unit_cost_cents: cents("50"), measure: 25 }).disposition, "stop_and_bid");
  assert.equal(bidDue(d("2027-03-08")), d("2027-03-23"));
  assert.equal(reconsiderationDue(d("2027-03-30")), d("2027-04-06"));
  assert.equal(itemDisposition({ kind: "debris", qty: 15, unit_cost_cents: cents("50"), measure: 15 }).disposition, "complete_and_batf");
  assert.equal(itemDisposition({ kind: "grass_cut", qty: 1, unit_cost_cents: cents("120"), measure: 40 }).disposition, "stop_and_bid");
  assert.equal(itemDisposition({ kind: "grass_cut", qty: 1, unit_cost_cents: cents("120"), measure: 20 }).disposition, "complete_and_batf");
  assert.equal(winterizationRequired("HI"), false); assert.ok(winterizationRequired("MN"));
  assert.equal(tarpDeadline(d("2027-04-01")), d("2027-05-31"));
  assert.equal(preservationMode({ pfpip: true, permission: "Do insp and preserv", chapter13_active: false }), "pfpip");
  assert.equal(preservationMode({ pfpip: true, permission: "Do insp and preserv", chapter13_active: true }), "suspended");
  assert.equal(registrationClocks(d("2027-03-05"), { within_days: 30, renewal_months: 6 })!.file_by, d("2027-04-04"));
  assert.equal(auditDocumentsDue(d("2027-05-03")), d("2027-05-10"));
});
