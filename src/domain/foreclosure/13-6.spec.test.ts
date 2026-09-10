// 13.6 Default-related law-firm management
// spec/sections/13-foreclosure/13-6-default-related-law-firm-management.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { suspensionGate, draPostponementCheck, feeApproval, scorecardReview } from "./ops.ts";
import { reviewInvoice, feeEarned } from "./firms.ts";

// 13.6-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.6-T2 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.6-T3 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.6-T4 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.6-T5: Given a proposed suspension, Then implementation blocked until 5 BD after Fannie Mae notice with plan.", () => {
  const blocked = suspensionGate({ proposed_on: D("2026-08-03"), fnma_notified_on: D("2026-08-03"), plan_attached: true, implement_on: D("2026-08-07") }); assert.equal(blocked.earliest, "2026-08-10"); assert.equal(blocked.allowed, false);
  assert.equal(suspensionGate({ proposed_on: D("2026-08-03"), fnma_notified_on: D("2026-08-03"), plan_attached: true, implement_on: D("2026-08-10") }).allowed, true);
  assert.match(suspensionGate({ proposed_on: D("2026-08-03"), fnma_notified_on: null, plan_attached: false, implement_on: D("2026-08-20") }).refusal!, /notified with the transition plan/);
});
// 13.6-T6 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.6-T7: Given a `POSTPONE_SALE` instruction acknowledged but no DRA \"sale postponed\" event after 2 BD, Then exception raised, firm call task, and 13.5 credit marked \"DRA unverified.\"", () => {
  const r = draPostponementCheck({ acknowledged_on: D("2026-10-21"), dra_event_on: null, today: D("2026-10-26") });
  assert.equal(r.expected_by, "2026-10-23"); assert.equal(r.exception, true); assert.equal(r.firm_call_task, true); assert.equal(r.credit_status, "DRA unverified");
  assert.equal(draPostponementCheck({ acknowledged_on: D("2026-10-21"), dra_event_on: D("2026-10-22"), today: D("2026-10-26") }).credit_status, "verified");
});
test("13.6-T8: Given a matter completed through confirmation, Then 100% fee approved; before confirmation the 95% cap holds (\"cannot be considered to be earned until ... confirmation\").", () => {
  const done = feeApproval({ method: "non_judicial", milestone: "confirmation", allowable_cents: 225_000n }); assert.equal(done.pct, 100); assert.equal(done.approved_cents, 225_000n); assert.equal(done.note, null);
  const held = feeApproval({ method: "non_judicial", milestone: "sale_held", allowable_cents: 225_000n }); assert.equal(held.pct, 95); assert.equal(held.approved_cents, 213_750n); assert.match(held.note!, /cannot be considered to be earned until/);
});
// 13.6-T9 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.6-T10: Given a firm scorecard in the bottom band two months running, Then risk-triggered review scheduled and `officer` informed.", () => {
  const r = scorecardReview([{ month: "2026-07", band: "middle" }, { month: "2026-08", band: "bottom" }, { month: "2026-09", band: "bottom" }]);
  assert.equal(r.trigger, true); assert.deepEqual(r.review, { kind: "risk_triggered", scheduled: true }); assert.equal(r.escalation!.kind, "officer");
  assert.equal(scorecardReview([{ month: "2026-08", band: "bottom" }, { month: "2026-09", band: "middle" }]).trigger, false);
});

test("13.6 worked figures: allowable A = $2,250.00; first legal 85% → $1,912.50 earned; 65% paid ($1,462.50) → approve $450.00; recording $38.00 and publication $412.75 approved; courier $22.00 rejected", () => {
  assert.equal(feeEarned("non_judicial", "first_legal", 225000n), 191250n); assert.equal((225000n * 65n) / 100n, 146250n);
  const r = reviewInvoice({ method: "non_judicial", milestone: "first_legal", allowable_cents: 225000n, previously_paid_cents: 146250n, costs: [{ kind: "recording", cents: 3800n, receipt: true }, { kind: "publication", cents: 41275n, receipt: true }, { kind: "courier", cents: 2200n, receipt: true }] });
  assert.equal(r.fee_approved_cents, 45000n); assert.equal(r.costs_approved_cents, 45075n); assert.deepEqual(r.rejected.map((x) => [x.kind, x.cents]), [["courier", 2200n]]);
});
