// 6.1 Establish P&I custodial account (Form 1013)
// spec/sections/06-custodial-account-management/6-1-establish-p-i-custodial-account-form-1013.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { verifyExecutedForm } from "./ops.ts";

// 6.1-T1 — implemented in src/domain/custodial/custodial.test.ts
// 6.1-T2 — implemented in src/domain/custodial/custodial.test.ts
// 6.1-T3 — implemented in src/domain/custodial/custodial.test.ts
// 6.1-T4 — implemented in src/domain/custodial/custodial.test.ts
// 6.1-T5 — implemented in src/domain/custodial/custodial.test.ts
// 6.1-T6 — implemented in src/domain/custodial/custodial.test.ts
test("6.1-T7: Given the executed PDF shows account number differing by one digit from the plan, then the form is not marked `in_effect` and the portal task reopens.", () => {
  const plan = { account_number: "123456789", title: "Supermortgage LLC, as servicer and/or agent for Fannie Mae and/or various owners of interest in mortgage loans, Principal and Interest Custodial Account", aba: "021000021", remittance_type: "S/S", effective_date: D("2026-11-01") };
  const v = verifyExecutedForm({ plan, executed: { ...plan, account_number: "123456780" }, executed_document_hash: "sha256:9f2c" });
  assert.equal(v.matches, false); assert.deepEqual(v.mismatches, ["account_number"]); assert.equal(v.in_effect, false); assert.equal(v.reopen_task, true);
  assert.equal(verifyExecutedForm({ plan, executed: plan, executed_document_hash: "sha256:9f2c" }).in_effect, true);
  assert.equal(verifyExecutedForm({ plan, executed: plan, executed_document_hash: null }).in_effect, false);              // never in_effect without the executed hash
});
// 6.1-T8 — implemented in src/domain/custodial/custodial.test.ts
