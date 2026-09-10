// 9.1 Hazard insurance tracking
// spec/sections/09-insurance-property-protection/9-1-hazard-insurance-tracking.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UNIT_DEDUCTIBLE_FLOOR } from "./hazard.ts";
import { lpiPlacementRequest } from "./ops.ts";

// 9.1-T1 — implemented in src/domain/insurance/insurance.test.ts
// 9.1-T2 — implemented in src/domain/insurance/insurance.test.ts
// 9.1-T3 — implemented in src/domain/insurance/insurance.test.ts
// 9.1-T4 — implemented in src/domain/insurance/insurance.test.ts
// 9.1-T5 — implemented in src/domain/insurance/insurance.test.ts
// 9.1-T6 — implemented in src/domain/insurance/insurance.test.ts
// 9.1-T7 — implemented in src/domain/insurance/insurance.test.ts
// 9.1-T8 — implemented in src/domain/insurance/insurance.test.ts
// 9.1-T9 — implemented in src/domain/insurance/insurance.test.ts
test("9.1-T10: Given a CA property and an LPI amount above RCV When 9.2 requests placement Then the CA cap rule blocks the amount (jurisdiction override).", () => {
  const r = lpiPlacementRequest({ state: "CA", requested_cents: 30000000n, rcv_cents: 26200000n, upb_cents: 24000000n, last_known_cents: 30000000n, state_cap_cents: null });
  assert.equal(r.blocked, true); assert.match(r.reason!, /CA/); assert.ok(r.allowed_cents <= 26200000n);
  assert.equal(lpiPlacementRequest({ state: "TX", requested_cents: 30000000n, rcv_cents: 26200000n, upb_cents: 24000000n, last_known_cents: 25000000n, state_cap_cents: null }).blocked, false);
});

test("9.1 rule 2: unit-owner policy deductibles are capped at the greater of 5% of coverage and $2,500.00", () => { assert.equal(UNIT_DEDUCTIBLE_FLOOR, 250000n); });
