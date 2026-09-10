// 18.3 STAR performance measurement
// spec/sections/18-qc-audit-regulatory-reporting/18-3-star-performance-measurement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { rateBps, metricResult, includedInMetric, composite } from "./star.ts";
import { transferInExclusion, distributionFilter } from "./ops.ts";
import { transfereeIncluded, transfereeExclusionWindow, confidentialityGate, screenDistributionList, partnerReportClock, partnerReportRelease, STAR_METRICS } from "./ops-18-3.ts";

// 18.3-T1 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.3-T2 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.3-T3: Given a loan transferred in on 2027-02-01, then it is excluded from T60/C60/RET_EFF for Feb and Mar 2027 but included in MOD6/PD6.", () => {
  const w = transfereeExclusionWindow(D("2027-02-01"));
  assert.deepEqual(w.excluded_months, ["2027-02", "2027-03"]); assert.equal(w.first_full_month, "2027-04");
  assert.deepEqual(w.excluded_metrics, ["T60", "C60", "RET_EFF", "BEYOND_TF"]); assert.deepEqual(w.always_included, ["MOD6", "PD6"]);
  for (const base of [D("2027-02-01"), D("2027-03-01")]) {
    for (const m of ["T60", "C60", "RET_EFF"] as const) assert.equal(transfereeIncluded(m, base, D("2027-02-01")), false, `${m} ${base}`);
    for (const m of ["MOD6", "PD6"] as const) assert.equal(transfereeIncluded(m, base, D("2027-02-01")), true, `${m} ${base}`);
  }
  for (const m of STAR_METRICS) assert.equal(transfereeIncluded(m, D("2027-04-01"), D("2027-02-01")), true, m);
  // the shared calculator agrees on a first-of-month transfer
  assert.deepEqual(transferInExclusion(D("2027-02-01"), D("2027-03-01")).excluded_from, ["T60", "C60", "RET_EFF", "BEYOND_TF"]);
  assert.deepEqual(transferInExclusion(D("2027-02-01"), D("2027-03-01")).included_in, ["MOD6", "PD6"]);
  assert.equal(includedInMetric("T60", D("2027-04-01"), D("2027-02-01"), null), true);
  // "two months following transfer" is a month rule: a 2027-02-15 transfer-in is back in T60 for April, not May
  assert.equal(transfereeIncluded("T60", D("2027-04-01"), D("2027-02-15")), true);
  assert.deepEqual(transfereeExclusionWindow(D("2027-02-15")).excluded_months, ["2027-02", "2027-03"]);
  // transferor: out of everything in the transfer month only
  assert.equal(transfereeIncluded("MOD6", D("2027-02-01"), null, D("2027-02-10")), false);
  assert.equal(transfereeIncluded("MOD6", D("2027-03-01"), null, D("2027-02-10")), true);
});
// 18.3-T4 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.3-T5 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.3-T6 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.3-T7 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.3-T8 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.3-T9: Given a vendor newsletter draft citing \"STAR-level performance,\" then the confidentiality filter blocks it.", () => {
  const draft = "Vendor update: Supermortgage delivers STAR-level performance for its partners this quarter.";
  const r = confidentialityGate({ audience: "vendor", kind: "newsletter", text: draft });
  assert.equal(r.allowed, false); assert.equal(r.mentions_star_results, true);
  assert.equal(r.refusal!.code, "STAR_CONFIDENTIALITY"); assert.match(r.refusal!.matched, /STAR-level performance/);
  assert.match(r.refusal!.citation, /may not disclose STAR Scorecard results to any third parties by any means/);
  assert.deepEqual(r.refusal!.escalation, { kind: "officer", reason: "third-party newsletter draft cited STAR results; blocked by the confidentiality filter" });
  assert.equal(distributionFilter({ audience: "vendor", text: draft }).blocked, true);
  assert.equal(confidentialityGate({ audience: "marketing", kind: "marketing_material", text: "We ranked in the STAR scorecard top three" }).allowed, false);
  // the same words are fine internally and to Fannie Mae; the partner only under the confidentiality clause
  assert.equal(confidentialityGate({ audience: "internal", kind: "internal_report", text: draft }).allowed, true);
  assert.equal(confidentialityGate({ audience: "fnma", kind: "fnma_inquiry", text: "our STAR results show C60 at 2,864 bps" }).allowed, true);
  assert.equal(confidentialityGate({ audience: "partner", kind: "partner_report", text: draft, partner_confidentiality_clause: true }).allowed, true);
  assert.equal(confidentialityGate({ audience: "partner", kind: "partner_report", text: draft, partner_confidentiality_clause: false }).allowed, false);
  // a vendor newsletter that does not cite STAR passes
  assert.deepEqual(confidentialityGate({ audience: "vendor", kind: "newsletter", text: "Vendor update: new document upload portal goes live in October." }), { allowed: true, mentions_star_results: false, refusal: null });
  // distribution-list screen on a STAR-bearing report
  const dl = screenDistributionList({ text: "Monthly STAR results attached", recipients: [{ id: "ops@sm", audience: "internal" }, { id: "news@vendor", audience: "vendor" }, { id: "partner-ops", audience: "partner" }], partner_confidentiality_clause: true });
  assert.deepEqual(dl.allowed.map((x) => x.id), ["ops@sm", "partner-ops"]); assert.deepEqual(dl.dropped.map((x) => x.id), ["news@vendor"]);
});

test("18.3 worked figures (Select weights, base month Jan 2027): T60 87/6,210 → 140 bps; C60 435 − 23 = 412, 118 cures → 2,864 bps (119 → 2,888); RET_EFF 61/190 → 3,211 bps; PD6 denominator 27 suppressed and out of the composite; partner report due 5 BD after reconciliation 2027-03-08 → 2027-03-15", () => {
  assert.equal(rateBps(87, 6210), 140);
  assert.equal(435 - 23, 412); assert.equal(rateBps(118, 412), 2864); assert.equal(rateBps(119, 412), 2888);
  assert.equal(rateBps(61, 190), 3211);
  const t60 = metricResult("T60", 87, 6210), c60 = metricResult("C60", 118, 412), ret = metricResult("RET_EFF", 61, 190), pd6 = metricResult("PD6", 9, 27);
  assert.deepEqual([t60.rate_bps, c60.rate_bps, ret.rate_bps], [140, 2864, 3211]);
  assert.equal(pd6.suppressed, true); assert.equal(pd6.rate_bps, null);
  const selectWeights = { T60: 45, C60: 40, RET_EFF: 15 } as const;
  const live = [{ ...t60, weight: selectWeights.T60, percentile: 80 }, { ...c60, weight: selectWeights.C60, percentile: 60 }, { ...ret, weight: selectWeights.RET_EFF, percentile: 50 }];
  const expected = Math.round(((45 * 80 + 40 * 60 + 15 * 50) / 100) * 100) / 100;
  assert.equal(composite(live), expected);
  assert.equal(composite([...live, { ...pd6, weight: 10, percentile: 0 }]), expected);
  const clock = partnerReportClock({ reconciled_at: D("2027-03-08"), carries_star_data: true });
  assert.equal(clock.due, "2027-03-15"); assert.equal(clock.satisfied_by, "star.partner_report.delivered"); assert.equal(clock.officer_signoff_required, true);
  assert.equal(partnerReportRelease({ carries_star_data: true, partner_confidentiality_clause: true, officer_signoff: null }).refusal!.code, "OFFICER_SIGNOFF_REQUIRED");
  assert.equal(partnerReportRelease({ carries_star_data: true, partner_confidentiality_clause: false, officer_signoff: { officer_id: "off-1", signed_at: "2027-03-10T15:00:00Z" } }).refusal!.code, "STAR_CONFIDENTIALITY");
  assert.equal(partnerReportRelease({ carries_star_data: true, partner_confidentiality_clause: true, officer_signoff: { officer_id: "off-1", signed_at: "2027-03-10T15:00:00Z" } }).event, "star.partner_report.delivered");
});
