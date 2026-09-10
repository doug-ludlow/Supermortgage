// 9.3 Force-placed — reminder notice
// spec/sections/09-insurance-property-protection/9-3-force-placed-reminder-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { premiumFromRate } from "./fpi.ts";

// 9.3-T1 — implemented in src/domain/insurance/insurance.test.ts
// 9.3-T2 — implemented in src/domain/insurance/insurance.test.ts
// 9.3-T3 — implemented in src/domain/insurance/insurance.test.ts
// 9.3-T4 — implemented in src/domain/insurance/insurance.test.ts
// 9.3-T5 — implemented in src/domain/insurance/insurance.test.ts
// 9.3-T6 — implemented in src/domain/insurance/insurance.test.ts

test("9.3 rule 2: $250,000 coverage × 0.876% = $2,190.00 (round-half-up at the end)", () => { assert.equal(premiumFromRate(25000000n, "0.876"), 219000n); });
