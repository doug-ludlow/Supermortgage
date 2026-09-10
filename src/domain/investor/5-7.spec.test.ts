// 5.7 Delinquent loan status reporting
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-7-delinquent-loan-status-reporting.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { ET, dqExceptionCycle, reconcileFinalReport, dqEventForAction, amnTransmission, validateF121Layout } from "./ops.ts";

// 5.7-T1 — implemented in src/domain/investor/investor.test.ts
// 5.7-T2 — implemented in src/domain/investor/investor.test.ts
// 5.7-T3 — implemented in src/domain/investor/investor.test.ts
// 5.7-T4 — implemented in src/domain/investor/investor.test.ts
test("5.7-T5: Given BD4 exception report lists 3 critical exceptions (invalid reason code), then corrections are transmitted by CD10 (the published calendar lists Sat Oct 10, 2026 for the October cycle; the engine targets the preceding business day, Fri Oct 9) and the CD11 final report reconciles to zero critical.", () => {
  const c = dqExceptionCycle({ file_month: D("2026-10-01"), exceptions: [{ loan_id: "L1", code: "E-REASON", severity: "critical" }, { loan_id: "L2", code: "E-REASON", severity: "critical" }, { loan_id: "L3", code: "E-REASON", severity: "critical" }, { loan_id: "L4", code: "W-DATE", severity: "noncritical" }], published_cd10: D("2026-10-10") });
  assert.equal(c.critical.length, 3); assert.equal(c.corrections_due_on, "2026-10-09"); assert.equal(toIso(c.corrections_due_ms), toIso(zonedEpochMs(D("2026-10-09"), "17:00", ET)));
  assert.equal(c.final_report_on, "2026-10-11"); assert.equal(c.status, "exceptions_open");
  const lines = [{ loan_id: "L1", status_code: "42" }, { loan_id: "L2", status_code: "09" }, { loan_id: "L3", status_code: "43" }];
  const f = reconcileFinalReport({ lines, final: lines.map((l) => ({ ...l, exception: null })) });
  assert.equal(f.critical_remaining, 0); assert.deepEqual(f.mismatched, []); assert.equal(f.status, "final");
});
test("5.7-T6: Given `mode=dual` in CIT, when a breach letter is sent Wed Oct 21, 2026 14:00 ET, then a delinquency event with action \"Breach Letter Sent\" is submitted to `api-clve` by Thu Oct 22 03:00 ET and the November AMN line shows `80` with effective `20261021`.", () => {
  const e = dqEventForAction({ action: "breach_letter_sent", processed_at_ms: zonedEpochMs(D("2026-10-21"), "14:00", ET), mode: "dual" });
  assert.equal(e.servicer_action_type, "Breach Letter Sent"); assert.equal(e.env, "api-clve");
  assert.equal(toIso(e.submit_by_ms), toIso(zonedEpochMs(D("2026-10-22"), "03:00", ET)));
  assert.equal(e.amn_line.status, "80"); assert.equal(e.amn_line.effective, "20261021");
  assert.deepEqual(validateF121Layout({ status: e.amn_line.status, reason: "031", effective: e.amn_line.effective, completion: e.amn_line.completion }), []);
});
// 5.7-T7 — implemented in src/domain/investor/investor.test.ts
test("5.7-T8: Given the file is transmitted at BD2 18:30 ET, then the `late` flag is set, an `officer` escalation records a potential compensatory-fee instance and the Compliance Sentinel report lists it.", () => {
  const t = amnTransmission({ period_month: D("2026-10-01"), transmitted_at_ms: zonedEpochMs(D("2026-11-03"), "18:30", ET), record_count: 412 });
  assert.equal(toIso(t.due_ms), toIso(zonedEpochMs(D("2026-11-03"), "17:00", ET))); assert.equal(t.late, true); assert.equal(t.escalation, "officer");
  assert.deepEqual(t.compfee_instance, { kind: "late_delinquency_file", period: "2026-10", minutes_late: 90 }); assert.match(t.sentinel_line!, /compensatory-fee/);
  assert.equal(amnTransmission({ period_month: D("2026-10-01"), transmitted_at_ms: zonedEpochMs(D("2026-11-03"), "16:30", ET), record_count: 412 }).late, false);
});
