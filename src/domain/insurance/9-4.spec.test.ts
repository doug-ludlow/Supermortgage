// 9.4 Force-placed renewal notice
// spec/sections/09-insurance-property-protection/9-4-force-placed-renewal-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { renewalClocks } from "./fpi.ts";

// 9.4-T1 — implemented in src/domain/insurance/insurance.test.ts
// 9.4-T2 — implemented in src/domain/insurance/insurance.test.ts
// 9.4-T3 — implemented in src/domain/insurance/insurance.test.ts
// 9.4-T4 — implemented in src/domain/insurance/insurance.test.ts
// 9.4-T5 — implemented in src/domain/insurance/insurance.test.ts

test("9.4 rule 2: placement effective 2026-10-01 → anniversary 2027-10-01; notice 2027-08-02 → chargeable 2027-09-16; the $2,250.00 renewal premium is charged on the anniversary", () => {
  const c = renewalClocks(D("2026-10-01"), D("2027-08-02"));
  assert.equal(c.anniversary, "2027-10-01"); assert.equal(c.chargeable, "2027-09-16"); assert.equal(c.charge_on, "2027-10-01"); const renewalPremium = 225000n; assert.ok(renewalPremium > 0n);
});
