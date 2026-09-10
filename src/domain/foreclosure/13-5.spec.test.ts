// 13.5 Allowable timeframes / compensatory fees
// spec/sections/13-foreclosure/13-5-allowable-timeframes-compensatory-fees.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { exhibitVersionFor, timeframeWarning, rescissionExposure, contestedCredits, billReceived, methodDeviation } from "./ops.ts";
import { exposure } from "./timeframes.ts";

// 13.5-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.5-T2 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.5-T3 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.5-T4: Given a sale on June 30, 2025 in a state whose days changed on July 1, 2025, Then the prior exhibit version applies; July 1 \u21d2 new version.", () => {
  const versions = [{ version: "2024-07", effective_on: D("2024-07-01"), days: 780 }, { version: "2025-07", effective_on: D("2025-07-01"), days: 810 }];
  assert.deepEqual(exhibitVersionFor(versions, D("2025-06-30")), { version: "2024-07", days: 780 }); assert.deepEqual(exhibitVersionFor(versions, D("2025-07-01")), { version: "2025-07", days: 810 });
});
test("13.5-T5: Given elapsed days reach 70% of (allowable + credits), Then `at_risk` event and a firm status demand instruction.", () => {
  const r = timeframeWarning({ lpi_due: D("2024-05-01"), today: D("2026-03-17"), allowable: 810, credited: 165 });
  assert.equal(r.threshold, 683); assert.equal(r.elapsed, 685); assert.equal(r.at_risk, true); assert.equal(r.event, "foreclosure.timeframe.at_risk"); assert.equal(r.instruction!.kind, "STATUS_DEMAND"); assert.equal(r.instruction!.to, "firm");
  assert.equal(timeframeWarning({ lpi_due: D("2024-05-01"), today: D("2026-03-10"), allowable: 810, credited: 165 }).at_risk, false);
});
test("13.5-T6: Given a rescinded sale due to a missed DMDC check, Then $1,000 + costs exposure and root cause `servicer:scra`.", () => {
  const r = rescissionExposure({ cause: "missed_dmdc_check", third_party_costs_cents: 62_500n });
  assert.equal(r.exposure_cents, 162_500n); assert.equal(r.root_cause, "servicer:scra"); assert.equal(r.servicer_error, true);
  assert.equal(rescissionExposure({ cause: "firm_error", third_party_costs_cents: 62_500n }).exposure_cents, 0n);
});
test("13.5-T7: Given a second contested period, Then no additional credit and a note for \"reasonable explanation.\"", () => {
  const r = contestedCredits([{ category: "contested", from: D("2026-03-02"), to: D("2026-04-11"), reported_timely: true }, { category: "contested", from: D("2026-06-01"), to: D("2026-07-01"), reported_timely: true }]);
  assert.equal(r.credited, 40); assert.equal(r.notes.length, 1); assert.match(r.notes[0]!, /reasonable explanation/);
});
test("13.5-T8: Given a bill received, Then `SM_COMP_FEE_BILL_REBUTTAL_30` starts, package drafted, `officer` escalation.", () => {
  const r = billReceived({ received_on: D("2027-03-01"), bill_cents: 84_082n, exposure_cents: 84_082n });
  assert.equal(r.timer, "SM_COMP_FEE_BILL_REBUTTAL_30"); assert.equal(r.due, "2027-03-31"); assert.equal(r.package.drafted, true); assert.equal(r.package.variance_cents, 0n); assert.equal(r.escalation.kind, "officer");
});
test("13.5-T9: Given a non-preferred method proposed without Form 20 approval, Then `FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE` refuses first-notice authorization.", () => {
  const r = methodDeviation({ preferred_method: false }); assert.equal(r.allowed, false); assert.equal(r.gate, "FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE"); assert.match(r.refusal!, /Form 20/);
  assert.equal(methodDeviation({ preferred_method: false, form20_approval_id: "F20-1" }).allowed, true); assert.equal(methodDeviation({ preferred_method: true }).allowed, true);
});

test("13.5 worked figures: NJ 810 allowable, LPI 2024-05-01 → sale 2027-01-19 = 993 days; credits 125 + 40 = 165; excess 18; UPB $310,000 at 5.50% → per-diem $46.71 → exposure $840.82", () => {
  const r = exposure({ lpi_due: D("2024-05-01"), sale_on: D("2027-01-19"), allowable: 810, delays: [{ category: "bankruptcy", from: D("2025-09-03"), to: D("2026-01-21"), reported_timely: true }, { category: "contested", from: D("2026-03-02"), to: D("2026-04-11"), reported_timely: true }], upb_cents: 31000000n, ptr_pct: "5.50" });
  assert.equal(r.actual_days, 993); assert.equal(r.credited_days, 165); assert.equal(r.excess_days, 18); assert.equal(r.exposure_cents, 84082n);
  assert.equal((31000000n * 550n + 365n * 5000n) / (365n * 10000n), 4671n);   // per-diem $46.71 (half-up)
});
