// 9.6 Flood insurance / mandatory purchase
// spec/sections/09-insurance-property-protection/9-6-flood-insurance-mandatory-purchase.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { lomaLetter, sameDayLapses, vendorHeartbeatCheck } from "./ops.ts";

// 9.6-T1 — implemented in src/domain/insurance/insurance.test.ts
// 9.6-T2 — implemented in src/domain/insurance/insurance.test.ts
// 9.6-T3 — implemented in src/domain/insurance/insurance.test.ts
// 9.6-T4 — implemented in src/domain/insurance/insurance.test.ts
// 9.6-T5 — implemented in src/domain/insurance/insurance.test.ts
test("9.6-T6: Given a LOMA letter Then requirement cleared, LPI cancelled effective the letter date, refund of any borrower-paid overlap, `INS_FLOOD_REMOVED_NOTICE` sent.", () => {
  const r = lomaLetter({ letter_date: D("2027-05-10"), received_on: D("2027-05-12"), lpi: [{ effective: D("2027-02-03"), expiration: D("2028-02-03"), premium_cents: 115000n }], borrower_paid_cents: 115000n });
  assert.equal(r.requirement, "cleared"); assert.equal(r.cancellation_effective, "2027-05-10"); assert.equal(r.notice, "INS_FLOOD_REMOVED_NOTICE"); assert.equal(r.file_letter, "B-3-01");
  assert.equal(r.refund.overlap_days, 269); assert.equal(r.refund.deadline, "2027-06-11"); assert.ok(r.refund.refund_cents > 0n);
});
test("9.6-T7: Given a hazard lapse and flood lapse on the same day Then MS-3(A) and the flood 45-day notice are mailed as separate documents in one transmittal; timers independent.", () => {
  const r = sameDayLapses({ mailed_on: D("2026-10-05"), hazard_lapse: true, flood_lapse: true });
  assert.equal(r.documents.length, 2); assert.equal(r.transmittals, 1); assert.equal(r.timers_independent, true);
  assert.deepEqual(r.documents.map((d) => [d.template, d.separate_document, d.deadline]), [["INS_FPI_FIRST_MS3A", true, "2026-11-19"], ["INS_FLOOD_FPI_NOTICE_45", true, "2026-11-19"]]);
});
test("9.6-T8: Given no vendor heartbeat for 36 days Then sev-2 and a re-order queue for pending alerts.", () => {
  const r = vendorHeartbeatCheck({ last_message_on: D("2027-01-01"), today: D("2027-02-06"), pending_alerts: [{ loan_id: "L-1", certificate_id: "C-1" }] });
  assert.equal(r.severity, "sev2"); assert.deepEqual(r.reorder_queue, [{ loan_id: "L-1", certificate_id: "C-1", action: "manual_reorder" }]);
  assert.equal(vendorHeartbeatCheck({ last_message_on: D("2027-01-01"), today: D("2027-02-05"), pending_alerts: [] }).severity, "ok");
});
// 9.6-T9 — implemented in src/domain/insurance/insurance.test.ts

test("9.6 worked timeline: $1,150.00 flood LPI premium over the 2027-02-03 term", () => { const premium = 115000n; assert.equal(lomaLetter({ letter_date: D("2027-05-10"), received_on: D("2027-05-12"), lpi: [{ effective: D("2027-02-03"), expiration: D("2028-02-03"), premium_cents: premium }], borrower_paid_cents: 0n }).refund.refund_cents, 0n); });
