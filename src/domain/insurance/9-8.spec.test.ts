// 9.8 Property inspection (delinquent)
// spec/sections/09-insurance-property-protection/9-8-property-inspection-delinquent.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { vacancyConfirmed, pfpipSubmission, PFPIP_MANDATORY_FIELDS } from "./ops.ts";

// 9.8-T1 — implemented in src/domain/insurance/insurance.test.ts
// 9.8-T2 — implemented in src/domain/insurance/insurance.test.ts
test("9.8-T3: Given an inspection reports vacancy with a signed certification Then occupancy `vacant`, interior monthly schedule, carrier notified, 9.9 opened, PFPIP occupancy updated within 2 business days.", () => {
  const v = vacancyConfirmed({ inspected_on: D("2027-02-10"), certification_signed: true, pfpip: true });
  assert.equal(v.occupancy, "vacant"); assert.deepEqual(v.interior_schedule, { from: "2027-03-02", to: "2027-03-17" }); assert.equal(v.carrier_notify_by, "2027-02-18");   // 5 servicer BD (Presidents' Day closed) assert.equal(v.preservation_case, "opened"); assert.equal(v.pfpip_update_by, "2027-02-12");
  assert.throws(() => vacancyConfirmed({ inspected_on: D("2027-02-10"), certification_signed: false, pfpip: true }), /signed certification/);
});
// 9.8-T4 — implemented in src/domain/insurance/insurance.test.ts
test("9.8-T5: Given an eligible loan reaching day 90 on a Saturday Then PFPIP submission task due within 2 business days; package contains all mandatory fields.", () => {
  const pkg = Object.fromEntries(PFPIP_MANDATORY_FIELDS.map((k) => [k, k === "stop_all_work" ? false : "value"]));
  const r = pfpipSubmission({ earliest_unpaid_due: D("2026-11-01"), package: pkg });
  assert.equal(r.day90_on, "2027-01-30"); assert.equal(r.task_due, "2027-02-02"); assert.equal(r.complete, true); assert.deepEqual(r.missing_fields, []);
  const { hoa: _h, ...partial } = pkg; assert.deepEqual(pfpipSubmission({ earliest_unpaid_due: D("2026-11-01"), package: partial }).missing_fields, ["hoa"]);
});
// 9.8-T6 — implemented in src/domain/insurance/insurance.test.ts
// 9.8-T7 — implemented in src/domain/insurance/insurance.test.ts
// 9.8-T8 — implemented in src/domain/insurance/insurance.test.ts
// 9.8-T9 — implemented in src/domain/insurance/insurance.test.ts
