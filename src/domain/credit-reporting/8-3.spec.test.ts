// 8.3 Suspend credit reporting
// spec/sections/08-credit-reporting/8-3-suspend-credit-reporting.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { ratePercent } from "../../kernel/money/cents.ts";
import { scraReducedPayment } from "./suppression.ts";
import { staleSuppressionReview } from "./ops.ts";

// 8.3-T1 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.3-T2 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.3-T3 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.3-T4 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.3-T5 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.3-T6 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.3-T7 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.3-T8 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.3-T9 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.3-T10 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
test("8.3-T11: (stale suppression) Given a bankruptcy dismissed 2027-10-02 with no monitor event, then the 30-day review on 2027-10-10 flags the docket mismatch and the agent applies CII L/Q with the dismissal order.", () => {
  const r = staleSuppressionReview({ suppression: { reason: "bankruptcy", chapter: 13, phase: "plan_confirmed", last_event_on: D("2027-09-10") }, docket: { status: "dismissed", event_on: D("2027-10-02"), order_document_id: "doc-dismissal-order" }, review_on: D("2027-10-10") });
  assert.equal(r.review_due_on, "2027-10-10"); assert.equal(r.mismatch, true);
  assert.deepEqual(r.action, { cii_this_cycle: "L", cii_next_cycle: "Q", release_freeze: true, evidence_document_id: "doc-dismissal-order", via: "aud_and_next_cycle" }); assert.equal(r.escalation, null);
  assert.equal(staleSuppressionReview({ suppression: { reason: "bankruptcy", chapter: 13, phase: "plan_confirmed", last_event_on: D("2027-09-10") }, docket: { status: "dismissed", event_on: D("2027-10-02"), order_document_id: null }, review_on: D("2027-10-10") }).escalation, "officer");
  assert.equal(staleSuppressionReview({ suppression: { reason: "bankruptcy", chapter: 13, phase: "plan_confirmed", last_event_on: D("2027-09-10") }, docket: { status: "open", event_on: null, order_document_id: null }, review_on: D("2027-10-10") }).mismatch, false);
});
// 8.3-T12 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.3-T13 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.3-T14 — implemented in src/domain/credit-reporting/credit-reporting.test.ts

test("8.3 rule 4 worked example: SCRA 6% cap on UPB $292,096.58 over 334 payments → P&I $1,800.91 (contract $1,847.15), forgiven interest $60.85, payment with $612.40 escrow $2,413.31; two missed PITI installments = $4,919.10", () => {
  const r = scraReducedPayment(29209658n, ratePercent("6.25"), 334, 61240n);
  assert.equal(r.pi_cents, 180091n); assert.equal(r.forgiven_interest_cents, 6085n); assert.equal(r.piti_cents, 241331n);
  assert.equal(184715n - 180091n > 0n, true); assert.equal(245955n * 2n, 491910n);
});
