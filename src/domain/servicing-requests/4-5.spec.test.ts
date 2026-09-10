// 4.5 Complaint handling / UDAAP
// spec/sections/04-customer-service-borrower-communications/4-5-complaint-handling-udaap.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
void cents;
import { texasCure, aiTranscriptMonitor, fairLendingRouting, wrongServicerResponse, complaintAnalytics, monetaryAuthority, AI_MONETARY_LIMIT_CENTS } from "./ops.ts";

// 4.5-T1 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.5-T2 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.5-T3 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.5-T4 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.5-T5: (Texas) Given a \u00a750(a)(6) loan and a letter alleging a constitutional defect, then `attorney`/`officer` escalation, Form 20 package prepared, and the 60-day cure timer started on the notice date.", () => {
  assert.deepEqual(texasCure(D("2026-09-10")), { escalate: ["attorney", "officer"], package: "form_20", cure_by: "2026-11-09", timer: "TX_50A6_CURE_60" });
});
// 4.5-T6 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.5-T7: (AI complaint) Given a chat transcript where the borrower asked for a human twice without transfer, then `AI_HUMAN_REQUEST_UNMET` fires, the case is `critical`, and the governance owner is notified the same day.", () => {
  const r = aiTranscriptMonitor([{ speaker: "borrower", text: "I want to speak to a person" }, { speaker: "ai", text: "I can help with that here." }, { speaker: "borrower", text: "No, get me a human" }, { speaker: "ai", text: "Let me look up your account." }], D("2026-09-10"));
  assert.deepEqual(r, { monitor: "AI_HUMAN_REQUEST_UNMET", severity: "critical", notify: { role: "ai_governance_owner", by: "2026-09-10" }, requests: 2 });
  assert.equal(aiTranscriptMonitor([{ speaker: "borrower", text: "I want a person" }, { speaker: "ai", text: "Transferring you now.", transferred: true }], D("2026-09-10")).monitor, null);
});
test("4.5-T8: (fair lending) Given a complaint alleging discrimination in a loss-mit denial, then `officer` review, 19.4 record, 12.3 appeal handling, no AI-only closure.", () => {
  assert.deepEqual(fairLendingRouting({ alleges_discrimination: true, concerns_lossmit_denial: true }), { officer_review: true, fair_lending_record: "19.4", appeal: "12.3", ai_only_closure_allowed: false });
  assert.equal(fairLendingRouting({ alleges_discrimination: false, concerns_lossmit_denial: true }).ai_only_closure_allowed, true);
});
test("4.5-T9: (wrong servicer) Given a state regulator complaint for a loan not on the platform, then a response within the state clock with no borrower data.", () => {
  assert.deepEqual(wrongServicerResponse(D("2026-09-10"), 30), { response_by: "2026-10-10", content: "not_serviced_here_refer_to_correct_servicer", borrower_data_disclosed: false });
});
// 4.5-T10 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.5-T11: (analytics) Given the monthly refresh, then complaints per 1,000 loans by category and by `preferred_language` are produced and monitor breaches create `officer` tasks.", () => {
  const a = complaintAnalytics([{ category: "fees", preferred_language: "en" }, { category: "fees", preferred_language: "es" }, { category: "escrow", preferred_language: "en" }], 1000, 1.5);
  assert.deepEqual(a.by_category, { fees: 2, escrow: 1 }); assert.deepEqual(a.by_language, { en: 2, es: 1 });
  assert.deepEqual(a.breaches, ["fees: 2 per 1,000 > 1.5"]); assert.equal(a.officer_tasks, 1);
});
test("4.5-T12: (monetary authority) Given an AI-proposed refund of 75,000\u00a2, then the correction is blocked pending `officer` approval and the borrower is told the review timeline.", () => {
  assert.equal(AI_MONETARY_LIMIT_CENTS, 50_000n);
  const r = monetaryAuthority(75_000n, { kind: "agent" });
  assert.equal(r.allowed, false); assert.equal(r.requires, "officer"); assert.match(r.borrower_message!, /under review by an officer/);
  assert.equal(monetaryAuthority(45_000n, { kind: "agent" }).allowed, true); assert.equal(monetaryAuthority(75_000n, { kind: "human", role: "officer" }).allowed, true);
});
