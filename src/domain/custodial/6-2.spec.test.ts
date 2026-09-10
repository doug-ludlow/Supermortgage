// 6.2 Establish T&I custodial account (Form 1014)
// spec/sections/06-custodial-account-management/6-2-establish-t-i-custodial-account-form-1014.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { ET, interestDispositionStatus, tiUnmatchedDebit } from "./ops.ts";

// 6.2-T1 — implemented in src/domain/custodial/custodial.test.ts
// 6.2-T2 — implemented in src/domain/custodial/custodial.test.ts
// 6.2-T3 — implemented in src/domain/custodial/custodial.test.ts
test("6.2-T4: Given no disposition by day 30, then breach \u2192 `officer` medium and the amount appears as an aged \"Other\" item on Form 496A.", () => {
  const s = interestDispositionStatus({ credited_on: D("2026-09-30"), amount_cents: 123456n, disposed_at_ms: null, now_ms: zonedEpochMs(D("2026-10-31"), "10:00", ET) });
  assert.equal(toIso(s.due_ms), toIso(zonedEpochMs(D("2026-10-30"), "17:00", ET))); assert.equal(s.status, "breached");
  assert.deepEqual(s.escalation, { role: "officer", severity: "medium" });
  assert.equal(s.form496a_item!.line, 6); assert.equal(s.form496a_item!.category, "Other"); assert.equal(s.form496a_item!.aging_days, 31); assert.equal(s.form496a_item!.amount_cents, 123456n);
  assert.equal(interestDispositionStatus({ credited_on: D("2026-09-30"), amount_cents: 123456n, disposed_at_ms: zonedEpochMs(D("2026-10-15"), "10:00", ET), now_ms: zonedEpochMs(D("2026-10-31"), "10:00", ET) }).status, "satisfied");
});
// 6.2-T5 — implemented in src/domain/custodial/custodial.test.ts
test("6.2-T6: Given a debit on the T&I statement with no `disbursements` match within 1 BD, then exception `unmatched_debit` opens with severity high and the bank's positive-pay exception list is pulled.", () => {
  const debit = { id: "D-1", amount_cents: 215000n, value_date: D("2026-10-06"), type_code: "475" };
  const x = tiUnmatchedDebit({ debit, disbursements: [], as_of: D("2026-10-07") });
  assert.deepEqual(x.exception, { code: "unmatched_debit", severity: "high", amount_cents: 215000n, debit_id: "D-1" }); assert.ok(x.actions.includes("pull_positive_pay_exception_list"));
  assert.deepEqual(tiUnmatchedDebit({ debit, disbursements: [], as_of: D("2026-10-06") }).actions, ["wait_1bd"]);
  assert.equal(tiUnmatchedDebit({ debit, disbursements: [{ id: "chk-9", amount_cents: 215000n, date: D("2026-10-05") }], as_of: D("2026-10-07") }).exception, null);
});
