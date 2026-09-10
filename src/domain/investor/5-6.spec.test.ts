// 5.6 Repurchase reporting
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-6-repurchase-reporting.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { ET, projectLar65, mbsExpressUnscheduledDraft, perDiemInterest } from "./ops.ts";

// 5.6-T1 — implemented in src/domain/investor/investor.test.ts
// 5.6-T2 — implemented in src/domain/investor/investor.test.ts
// 5.6-T3 — implemented in src/domain/investor/investor.test.ts
test("5.6-T4: Given the repurchase processed Mon Nov 2, 2026 (BD1), then LAR 65 is due Tue Nov 3 17:00 ET.", () => {
  const r = projectLar65({ approval_document_id: "doc-approval-1", processed_at_ms: zonedEpochMs(D("2026-11-02"), "15:10", ET), arm_modification_feature: false });
  assert.equal(r.blocked, false); assert.equal(r.event!.action_code, "65"); assert.equal(toIso(r.event!.due_ms), toIso(zonedEpochMs(D("2026-11-03"), "17:00", ET)));
});
test("5.6-T5: Given an approval document is missing, then the LAR 65 projection is blocked and an `officer` escalation exists; once attached, the event is created with the original processed timestamp.", () => {
  const processed = zonedEpochMs(D("2026-11-02"), "15:10", ET);
  const blocked = projectLar65({ approval_document_id: null, processed_at_ms: processed, arm_modification_feature: false });
  assert.equal(blocked.blocked, true); assert.equal(blocked.escalation, "officer"); assert.equal(blocked.event, null);
  const attached = projectLar65({ approval_document_id: "doc-approval-1", processed_at_ms: processed, arm_modification_feature: true });
  assert.equal(attached.blocked, false); assert.equal(attached.event!.processed_at_ms, processed); assert.equal(attached.event!.action_code, "67");
});
// 5.6-T6 — implemented in src/domain/investor/investor.test.ts
test("5.6-T7: Given an MBS Express pool repurchase reported in October, then unscheduled principal is funded for the BD4 November draft (Thu Nov 5, 2026).", () => {
  assert.equal(mbsExpressUnscheduledDraft(D("2026-10-15")), "2026-11-05");
});
