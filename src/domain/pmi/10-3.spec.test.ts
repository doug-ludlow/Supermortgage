// 10.3 Final termination @ midpoint
// spec/sections/10-pmi-administration/10-3-final-termination-midpoint.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { ratePercent, levelPayment } from "../../kernel/money/cents.ts";
import { midpointSweepCheck } from "./ops.ts";

// 10.3-T1 — implemented in src/domain/pmi/pmi.test.ts
// 10.3-T2 — implemented in src/domain/pmi/pmi.test.ts
// 10.3-T3 — implemented in src/domain/pmi/pmi.test.ts
// 10.3-T4 — implemented in src/domain/pmi/pmi.test.ts
// 10.3-T5 — implemented in src/domain/pmi/pmi.test.ts
// 10.3-T6 — implemented in src/domain/pmi/pmi.test.ts
test("10.3-T7: Given the midpoint termination date passes without a sweep decision, then `HPA_4902C_MIDPOINT_TERMINATE_0` breaches and `officer` sev-1 opens.", () => {
  const r = midpointSweepCheck({ midpoint_termination_date: D("2039-05-01"), decided_on: null, today: D("2039-05-02") });
  assert.equal(r.timer, "HPA_4902C_MIDPOINT_TERMINATE_0"); assert.equal(r.status, "breached"); assert.deepEqual(r.escalation, { role: "officer", severity: 1 });
  assert.equal(midpointSweepCheck({ midpoint_termination_date: D("2039-05-01"), decided_on: null, today: D("2039-05-01") }).status, "open");
  assert.equal(midpointSweepCheck({ midpoint_termination_date: D("2039-05-01"), decided_on: D("2039-05-01"), today: D("2039-05-02") }).status, "satisfied");
});

test("10.3 worked figure: IO 10/20 amortizing P&I $2,833.18", () => { assert.equal(levelPayment(38000000n, ratePercent("6.5"), 240), 283318n); });
