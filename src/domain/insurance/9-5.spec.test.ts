// 9.5 Force-placed cancellation/refund
// spec/sections/09-insurance-property-protection/9-5-force-placed-cancellation-refund.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cancellation, servicerNetCost } from "./refund.ts";
import { refundTimeline } from "./ops.ts";

// 9.5-T1 — implemented in src/domain/insurance/insurance.test.ts
// 9.5-T2 — implemented in src/domain/insurance/insurance.test.ts
test("9.5-T3: Given carrier ack arrives on day 20 Then borrower refund still paid by day 15; sev-3 vendor follow-up only.", () => {
  const input = { terms: [{ effective: D("2026-10-01"), expiration: D("2027-10-01"), premium_cents: 219000n }], borrower_coverage_start: D("2026-12-15"), borrower_coverage_end: null, evidence_received_on: D("2027-01-12"), borrower_paid_cents: 60000n, deadline_days: 15 as const };
  const t = refundTimeline(input, D("2027-02-01"), D("2027-01-26"));
  assert.equal(t.borrower_refund_by, "2027-01-27"); assert.equal(t.refund_on_time, true); assert.equal(t.carrier_ack_late, true); assert.equal(t.vendor_followup, "sev3"); assert.equal(t.result.refund_cents, 15000n);
  assert.equal(refundTimeline(input, D("2027-01-20"), null).vendor_followup, null);
});
// 9.5-T4 — implemented in src/domain/insurance/insurance.test.ts
// 9.5-T5 — implemented in src/domain/insurance/insurance.test.ts
// 9.5-T6 — implemented in src/domain/insurance/insurance.test.ts
// 9.5-T7 — implemented in src/domain/insurance/insurance.test.ts

test("9.5 worked example: $2,190.00 LPI, evidence 2027-01-12 for coverage from 2026-12-15 → 290 days overlap, $1,740.00 removed, $450.00 retained, $150.00 refunded of the $600.00 paid; carrier short-rate $1,700.00 → servicer cost $40.00", () => {
  const r = cancellation({ terms: [{ effective: D("2026-10-01"), expiration: D("2027-10-01"), premium_cents: 219000n }], borrower_coverage_start: D("2026-12-15"), borrower_coverage_end: null, evidence_received_on: D("2027-01-12"), borrower_paid_cents: 60000n, deadline_days: 15 });
  assert.equal(r.overlap_days, 290); assert.equal(r.removed_cents, 174000n); assert.equal(r.retained_cents, 45000n); assert.equal(r.refund_cents, 15000n); assert.equal(r.still_due_cents, 0n); assert.equal(r.deadline, "2027-01-27");   // paid $600 > retained $450 → nothing remains due (the spec's "$300 stays due" remark contradicts its own 600 − 450 arithmetic)
  assert.equal(servicerNetCost(174000n, 170000n), 4000n); assert.equal(45000n + 174000n, 219000n);
});
