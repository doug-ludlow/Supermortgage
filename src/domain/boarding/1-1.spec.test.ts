// 1.1 Loan data intake & validation (note terms, remittance type A/A–S/A–S/S, escrow flags, MERS MIN)
// spec/sections/01-boarding-servicing-transfer-in/1-1-loan-data-intake-validation-note-terms-remittance-type-a-as.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "../../kernel/money/cents.ts";
import { principalPortion } from "./amortization.ts";

// 1.1-T1 — implemented in src/domain/boarding/boarding.test.ts
// 1.1-T2 — implemented in src/domain/boarding/boarding.test.ts
// 1.1-T3 — implemented in src/domain/boarding/boarding.test.ts
// 1.1-T4 — implemented in src/domain/boarding/boarding.test.ts
// 1.1-T5 — implemented in src/domain/boarding/boarding.test.ts
// 1.1-T6 — implemented in src/domain/boarding/boarding.test.ts
// 1.1-T7 — implemented in src/domain/boarding/boarding.test.ts
// 1.1-T8 — implemented in src/domain/boarding/boarding.test.ts
// 1.1-T9 — implemented in src/domain/boarding/boarding.test.ts
// 1.1-T10 — implemented in src/domain/boarding/boarding.test.ts

// 1.1 worked example (HF-005): tape P&I $1,616.03 less scheduled interest $1,304.93 → principal portion $311.10; a history showing $311.11 is a W-014 interest-method review, not a hard fail.
test("1.1 worked example: principal portion $311.10 and expected UPB 24,532,302 cents; $311.11 in history → W-014 review", () => {
  const r = principalPortion(24_563_412n, cents("1616.03"), cents("1304.93"));
  assert.equal(r.principal_portion_cents, cents("311.10"));
  assert.equal(r.expected_upb_after_next_payment_cents, 24_532_302n);
  assert.equal(r.review, null);
  const w = principalPortion(24_563_412n, cents("1616.03"), cents("1304.93"), cents("311.11"));
  assert.equal(w.review, "W-014");
  assert.match(w.review_reason!, /31111 vs computed 31110/);
});
