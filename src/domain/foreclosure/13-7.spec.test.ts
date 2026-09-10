// 13.7 Environmental hazard / non-routine litigation
// spec/sections/13-foreclosure/13-7-environmental-hazard-non-routine-litigation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { maLeadPaintItem, appealFilingGate, pleadingReviewGate, quatroOutage, workoutCounselGate } from "./ops.ts";

// 13.7-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.7-T2 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.7-T3 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.7-T4 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.7-T5: Given MA property without a citation search, Then prereferral review fails (13.4-T6).", () => {
  assert.equal(maLeadPaintItem({ state: "MA" }).passed, false); assert.equal(maLeadPaintItem({ state: "MA", citation_search_document_id: "doc-lp" }).passed, true);
});
test("13.7-T6: Given a proposed appeal of an adverse judgment, Then the `attorney` cannot file until Fannie Mae's written approval is stored.", () => {
  const r = appealFilingGate({}); assert.equal(r.allowed, false); assert.match(r.refusal!, /written approval is not stored/); assert.equal(r.gate, "FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE");
  assert.equal(appealFilingGate({ fnma_written_approval_document_id: "doc-appr" }).allowed, true);
});
test("13.7-T7: Given a substantive motion due in 12 days, Then the draft must be given to Fannie Mae \u22655 BD before; the gate refuses filing otherwise.", () => {
  const due = D("2026-10-19");   // 12 days out from 2026-10-07
  const r = pleadingReviewGate({ filing_due: due, draft_given_on: D("2026-10-13") }); assert.equal(r.draft_due, "2026-10-09"); assert.equal(r.allowed, false); assert.match(r.refusal!, /PLEADING_REVIEW_GATE/);   // 5 servicer BD before Mon 10-19 skip Columbus Day
  assert.equal(pleadingReviewGate({ filing_due: due, draft_given_on: D("2026-10-09") }).allowed, true);
});
test("13.7-T8: Given quatro is down, Then package emailed to Legal with an outage note and the portal filing completed when restored; both timestamps kept.", () => {
  const r = quatroOutage({ notice_received_on: D("2026-10-07"), outage: true, restored_on: D("2026-10-08") });
  assert.equal(r.form20_due, "2026-10-09"); assert.deepEqual(r.email_sent, { on: "2026-10-07", outage_note: true }); assert.equal(r.portal_filed_on, "2026-10-08"); assert.deepEqual(r.timestamps, { email: "2026-10-07", portal: "2026-10-08" });
});
test("13.7-T9: Given a payment-deferral offer on a litigated loan, Then counsel is notified before the offer leaves (gate).", () => {
  const r = workoutCounselGate({ litigated: true, counsel_notified_on: null, counsel_acknowledged: false }); assert.equal(r.allowed, false); assert.equal(r.gate, "FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE");
  assert.equal(workoutCounselGate({ litigated: true, counsel_notified_on: D("2026-10-07"), counsel_acknowledged: true }).allowed, true); assert.equal(workoutCounselGate({ litigated: false, counsel_notified_on: null, counsel_acknowledged: false }).allowed, true);
});
// 13.7-T10 — implemented in src/domain/foreclosure/foreclosure.test.ts
