// 12.3 Appeal handling
// spec/sections/12-loss-mitigation/12-3-appeal-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { assignAppealReviewer, lateAppeal, appealExtendsAcceptance, appealAvailabilityBeforeFiling, appealDecisionBreach } from "./ops.ts";

// 12.3-T1 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.3-T2: (independence) assignment of the original approving reviewer is refused with a logged reason; assignment of an uninvolved supervisor is accepted.", () => {
  const refused = assignAppealReviewer({ candidate_id: "u-approver", evaluator_id: "u-eval", approver_id: "u-approver", candidate_role: "reviewer" });
  assert.equal(refused.accepted, false); assert.match(refused.reason, /original approving reviewer/);
  const ok = assignAppealReviewer({ candidate_id: "u-supervisor", evaluator_id: "u-eval", approver_id: "u-approver", candidate_role: "supervisor" });
  assert.equal(ok.accepted, true); assert.match(ok.reason, /took no part/);
});
test("12.3-T3: (late appeal) appeal received 2026-11-20 \u2192 ineligible notice; new pay stubs reviewed as new information; foreclosure holds released only after reviewer confirmation.", () => {
  const r = lateAppeal({ denial_provided_on: D("2026-10-20"), appeal_received_on: D("2026-11-20"), new_information: ["pay stubs 2026-11"], reviewer_confirmed_release: false });
  assert.equal(r.window_ends, "2026-11-03"); assert.equal(r.eligible, false); assert.equal(r.notice, "NTC_REGX_41H_APPEAL_INELIGIBLE"); assert.deepEqual(r.new_information_review, { items: ["pay stubs 2026-11"], as: "new_information" }); assert.equal(r.holds_released, false);
  assert.equal(lateAppeal({ denial_provided_on: D("2026-10-20"), appeal_received_on: D("2026-11-20"), new_information: [], reviewer_confirmed_release: true }).holds_released, true);
});
test("12.3-T4", () => {
  const r = appealExtendsAcceptance({ original_accept_by: D("2026-11-16"), appeal_filed_on: D("2026-11-10"), appeal_notice_provided_on: D("2026-12-05") });
  assert.equal(r.accept_by, "2026-12-19"); assert.equal(r.extended, true);
});
// 12.3-T5 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.3-T6 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.3-T7 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.3-T8: (before first filing) loan 100 days delinquent, no filing, denial \u2192 appeal available even though a hypothetical sale date is unknown.", () => {
  const r = appealAvailabilityBeforeFiling({ days_delinquent: 100, first_filing_made: false, sale_on: null, complete_on: D("2026-10-01"), denied_modification: true });
  assert.equal(r.appeal_available, true); assert.equal(r.tier, "ge_90"); assert.match(r.basis, /no first filing/);
});
// 12.3-T9 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.3-T10: (breach) decision not provided by day 30 \u2192 `officer` sev-1, borrower notified of status, holds maintained.", () => {
  const r = appealDecisionBreach({ appeal_received_on: D("2026-10-30"), decided_on: null, today: D("2026-11-30") });
  assert.equal(r.decision_due, "2026-11-29"); assert.equal(r.breached, true); assert.equal(r.escalation!.kind, "officer"); assert.equal(r.escalation!.severity, "sev1"); assert.equal(r.borrower_status_notice, true); assert.equal(r.holds_maintained, true);
  assert.equal(appealDecisionBreach({ appeal_received_on: D("2026-10-30"), decided_on: D("2026-11-20"), today: D("2026-11-30") }).breached, false);
});
