// 10.1 Borrower-requested cancellation @80% LTV
// spec/sections/10-pmi-administration/10-1-borrower-requested-cancellation-80-ltv.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { ltvBps } from "./cancellation.ts";
import { WORKED_LOAN } from "./fixtures.ts";
import { decisionClock, mnRequestOverlay, smduOutageFallback } from "./ops.ts";

// 10.1-T1 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T2 — implemented in src/domain/pmi/pmi.test.ts
test("10.1-T3: Given a request received 2029-07-10 and no decision or notice by 2029-08-09 23:59 servicer time, then timer `breached`, `officer` sev-1 escalation, Sentinel report line.", () => {
  const open = decisionClock({ received_on: D("2029-07-10"), decided_on: null, notice_sent_on: null, now: D("2029-08-09") });
  assert.equal(open.due, D("2029-08-09")); assert.equal(open.status, "open");
  const b = decisionClock({ received_on: D("2029-07-10"), decided_on: null, notice_sent_on: null, now: D("2029-08-10") });
  assert.equal(b.status, "breached"); assert.deepEqual(b.escalation, { role: "officer", severity: 1 }); assert.match(b.sentinel_line!, /HPA_4904B_DENIAL_NOTICE_30 breached: request received 2029-07-10; no decision or notice by 2029-08-09 23:59 servicer time/);
  assert.equal(decisionClock({ received_on: D("2029-07-10"), decided_on: D("2029-07-12"), notice_sent_on: D("2029-07-13"), now: D("2029-08-10") }).status, "satisfied");
});
// 10.1-T4 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T5 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T6 — implemented in src/domain/pmi/pmi.test.ts
test("10.1-T7: Given an MN owner-occupied loan, request received 2026-09-01, then `MN_47_207_RESPONSE_30` due 2026-10-01 and the ack offers the MN current-value (80% of appraisal within 90 days) path.", () => {
  const r = mnRequestOverlay({ state: "MN", owner_occupied: true, received_on: D("2026-09-01") });
  assert.deepEqual(r.timer, { code: "MN_47_207_RESPONSE_30", due: D("2026-10-01") });
  assert.ok(r.ack_paths.includes("mn_current_value")); assert.equal(r.mn_current_value!.threshold_bps, 8000); assert.equal(r.mn_current_value!.appraisal_max_age_days, 90);
  assert.ok(r.response_types.includes("request_additional_information"));
  assert.equal(mnRequestOverlay({ state: "MN", owner_occupied: false, received_on: D("2026-09-01") }).timer, null);
});
test("10.1-T8: Given SMDU 503 for 4 hours at case day 16, then a `human_portal_task` escalation opens with the prepared data set and the HPA timer unchanged.", () => {
  const r = smduOutageFallback({ outage_hours: 4, case_day: 16, hpa_due: D("2029-08-09"), data_set: { total_upb_cents: 31995095n, is_current: true, late30_12m: 0, late60_24m: 0 } });
  assert.equal(r.escalation!.kind, "human_portal_task"); assert.equal(r.escalation!.owner_role, "fnma_portal_operator"); assert.equal(r.escalation!.package.total_upb_cents, 31995095n);
  assert.deepEqual(r.hpa_timer, { code: "HPA_4904B_DENIAL_NOTICE_30", due: D("2029-08-09"), changed: false }); assert.equal(r.retry, false);
  assert.equal(smduOutageFallback({ outage_hours: 2, case_day: 16, hpa_due: D("2029-08-09"), data_set: {} }).retry, true);
  assert.equal(smduOutageFallback({ outage_hours: 6, case_day: 10, hpa_due: D("2029-08-09"), data_set: {} }).escalation, null);
});
// 10.1-T9 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T10 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T11 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T12 — implemented in src/domain/pmi/pmi.test.ts

test("10.1 worked figures: P&I $2,401.86; current-value request UPB $370,522.40 at BPO $500,000 → 74.10%", () => {
  assert.equal(WORKED_LOAN.pi_cents, 240186n); assert.equal(ltvBps(37052240n, 50000000n), 7410); assert.equal(ltvBps(37052240n, 49000000n), 7561);   // R3 floors: 75.61% (the spec prints the rounded 75.62%)
});
