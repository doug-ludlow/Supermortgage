// 10.6 Denial notice
// spec/sections/10-pmi-administration/10-6-denial-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { ltvBps } from "./cancellation.ts";
import { infoRequest, qcSample } from "./ops.ts";

// 10.6-T1 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T2 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T3 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T4 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T5 — implemented in src/domain/pmi/pmi.test.ts
test("10.6-T6: Given an MN loan and a request missing the property-occupancy confirmation, then `NTC_MI_INFO_REQUEST` is sent within 30 days of receipt and the MN timer is satisfied.", () => {
  const r = infoRequest({ state: "MN", received_on: D("2026-09-01"), missing: ["property occupancy confirmation"] });
  assert.equal(r.notice, "NTC_MI_INFO_REQUEST"); assert.equal(r.send_by, D("2026-10-01")); assert.equal(r.satisfies, "MN_47_207_RESPONSE_30"); assert.equal(r.closes_after_days, 60);
  assert.equal(infoRequest({ state: "TX", received_on: D("2026-09-01"), missing: ["x"] }).satisfies, null);
  assert.equal(infoRequest({ state: "MN", received_on: D("2026-09-01"), missing: [] }).notice, null);
});
// 10.6-T7 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T8 — implemented in src/domain/pmi/pmi.test.ts
// 10.6-T9 — implemented in src/domain/pmi/pmi.test.ts
test("10.6-T10: Given 10% monthly QC sampling, then sampled denials are marked and the QC findings feed `qc_finding` cases.", () => {
  const denials = Array.from({ length: 20 }, (_, i) => ({ id: `den-${String(i + 1).padStart(2, "0")}`, reason: "LTV_ABOVE_THRESHOLD" }));
  const r = qcSample(denials);
  assert.equal(r.sampled_ids.length, 2); assert.equal(r.marked.filter((d) => d.qc_sampled).length, 2);
  assert.ok(r.cases.every((c) => c.case_type === "qc_finding" && c.status === "open" && r.sampled_ids.includes(c.denial_id)));
  assert.deepEqual(qcSample(denials).sampled_ids, r.sampled_ids);
});

test("10.6 worked figure: current-value denial UPB $370,522.40 at BPO $490,000 → 75.62% > 75%", () => { assert.equal(ltvBps(37052240n, 49000000n), 7561); /* R3 floors: 75.61% (the spec prints the rounded 75.62%) */ });
