// 4.3 Continuity of contact / assigned personnel
// spec/sections/04-customer-service-borrower-communications/4-3-continuity-of-contact-assigned-personnel.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
void cents;
import type { Episode } from "./continuity.ts";
import { assignmentTrigger, callbackRequest, handleUtterance, accuracyHarness, callMetrics, routeCall, closeForTransferOut } from "./ops.ts";

// 4.3-T1 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.3-T2: Given no EI notice by day 45 (e.g., \u00a71024.39 exemption), then assignment still occurs by 2026-10-16.", () => {
  assert.deepEqual(assignmentTrigger(D("2026-09-01"), true, null), { assign_by: "2026-10-16", basis: "day_45" });
  assert.deepEqual(assignmentTrigger(D("2026-09-01"), true, D("2026-10-09")), { assign_by: "2026-10-09", basis: "ei_notice" });
});
// 4.3-T3 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.3-T4: Given a borrower calls the direct line after hours, then a callback request is created and a live contact by the assigned team occurs within 1 servicer BD.", () => {
  const r = callbackRequest({ called_at_local: "2026-10-09T21:30", staffed_from: "08:00", staffed_to: "20:00" });
  assert.deepEqual(r, { callback: true, live_contact_due: "2026-10-13", same_day_target: false });                  // Fri after hours → Tue (Columbus Day closed)
  assert.equal(callbackRequest({ called_at_local: "2026-10-08T10:00", staffed_from: "08:00", staffed_to: "20:00" }).same_day_target, true);
});
test("4.3-T5: Given a borrower says \"I want a person,\" then a warm transfer to `human_agent` occurs within the call, logged with `human_transfer_requested=true`.", () => {
  assert.deepEqual(handleUtterance("I want a person"), { human_transfer_requested: true, action: "warm_transfer_now" });
  assert.deepEqual(handleUtterance("what is my balance"), { human_transfer_requested: false, action: "continue" });
});
// 4.3-T6 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.3-T7 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.3-T8: (accuracy) Given a scripted call asking the five (b)(1) facts, then every statement matches `lossmit_facts` for the loan (evaluation harness, 100% agreement required for release).", () => {
  const facts = { options_available: ["repayment plan", "Flex Modification"], missing_documents: ["pay stubs"], application_status: "incomplete", foreclosure_referral: "not before day 121", deadline: "2026-10-24" };
  const good = accuracyHarness([{ fact: "options_available", value: ["repayment plan", "Flex Modification"] }, { fact: "missing_documents", value: ["pay stubs"] }, { fact: "application_status", value: "incomplete" }, { fact: "foreclosure_referral", value: "not before day 121" }, { fact: "deadline", value: "2026-10-24" }], facts);
  assert.deepEqual(good, { agreement_pct: 100, release: true, mismatches: [] });
  const bad = accuracyHarness([{ fact: "deadline", value: "2026-10-31" }, { fact: "application_status", value: "incomplete" }], facts); assert.equal(bad.release, false); assert.deepEqual(bad.mismatches, ["deadline"]);
});
// 4.3-T9 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.3-T10: (metrics) Given a month of CDRs with ASA 75s, then the A4-2.1-04 report flags the miss and an `officer` remediation task opens.", () => {
  const m = callMetrics({ offered: 1000, answered_seconds: Array.from({ length: 900 }, () => 75), abandoned: 30, blocked: 5 });
  assert.equal(m.asa_seconds, 75); assert.deepEqual(m.misses, ["ASA 75s > 60s"]); assert.equal(m.officer_task, "a4_2_1_04_remediation");
  assert.equal(callMetrics({ offered: 1000, answered_seconds: [45, 50], abandoned: 30, blocked: 5 }).officer_task, null);
});
test("4.3-T11: (AI off) Given `continuity.ai_first=off` for state XX, then calls route to the human queue and the assignment record shows `human_team`.", () => {
  assert.deepEqual(routeCall("XX", new Set(["XX"])), { queue: "human", assignment_mode: "human_team" });
  assert.deepEqual(routeCall("TX", new Set(["XX"])), { queue: "ai_first", assignment_mode: "ai_first_named_human" });
});
test("4.3-T12: (transfer-out) Given transfer-out on 2026-11-01, then the episode closes with `transfer_out` and the transfer file includes the assignment and open callbacks.", () => {
  const e: Episode = { status: "assigned", consecutive_on_time: 1, mode: "ai_first_named_human", team: "default" };
  const r = closeForTransferOut(e, [{ id: "cb-1" }, { id: "cb-2" }], D("2026-11-01"));
  assert.equal(r.close_reason, "transfer_out"); assert.equal(e.status, "released"); assert.deepEqual(r.transfer_file.open_callbacks, ["cb-1", "cb-2"]); assert.equal(r.transfer_file.closed_on, "2026-11-01");
});
