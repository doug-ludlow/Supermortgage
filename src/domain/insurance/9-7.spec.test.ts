// 9.7 Loss draft / insurance claim handling
// spec/sections/09-insurance-property-protection/9-7-loss-draft-insurance-claim-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { initialRelease, progressReleaseCurrent, progressReleaseDelinquent, custodialInterest } from "./lossdraft.ts";
import { ET, lossDraftEscrowEvent } from "./ops.ts";

// 9.7-T1 — implemented in src/domain/insurance/insurance.test.ts
// 9.7-T2 — implemented in src/domain/insurance/insurance.test.ts
// 9.7-T3 — implemented in src/domain/insurance/insurance.test.ts
// 9.7-T4 — implemented in src/domain/insurance/insurance.test.ts
// 9.7-T5 — implemented in src/domain/insurance/insurance.test.ts
// 9.7-T6 — implemented in src/domain/insurance/insurance.test.ts
// 9.7-T7 — implemented in src/domain/insurance/insurance.test.ts
// 9.7-T8 — implemented in src/domain/insurance/insurance.test.ts
// 9.7-T9 — implemented in src/domain/insurance/insurance.test.ts
test("9.7-T10: Given a loss-draft deposit on 2026-12-15 Then an escrow event with category loss_draft is accepted by 03:00 ET 2026-12-16.", () => {
  const e = lossDraftEscrowEvent({ deposited_at_ms: zonedEpochMs(D("2026-12-15"), "14:00", ET), amount_cents: 6000000n, loan_id: "L-1" });
  assert.equal(e.event.escrow_category, "loss_draft"); assert.equal(e.event.type, "escrow.deposit");
  assert.equal(toIso(e.submit_by_ms), toIso(zonedEpochMs(D("2026-12-16"), "03:00", ET)));
});

test("9.7 worked example: $60,000.00 proceeds on a $240,000.00 UPB with $1,000.00 interest → current initial $40,000.00 then $20,000.00 by inspection; delinquent initial $10,000.00 then ≤ $15,000.00 increments; $131.51 custodial interest", () => {
  const cur = initialRelease({ total_cents: 6000000n, upb_cents: 24000000n, accrued_interest_cents: 100000n, advances_cents: 0n, track: "current_lt31" });
  assert.equal(cur.cents, 4000000n); assert.equal(6000000n - 4000000n, 2000000n); assert.equal(progressReleaseCurrent(6000000n, 4000000n, 4000000n, "0.70"), 1400000n);
  const del = initialRelease({ total_cents: 6000000n, upb_cents: 24000000n, accrued_interest_cents: 100000n, advances_cents: 0n, track: "delinquent_31plus" });
  assert.equal(del.cents, 1000000n); assert.equal(del.max_progress_cents, 1500000n); assert.equal(progressReleaseDelinquent(6000000n, 1000000n, true, false).cents, 1500000n);
  assert.equal(custodialInterest(2000000n, "4.00", 60), 13151n);
});
