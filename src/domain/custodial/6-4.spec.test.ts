// 6.4 T&I custodial reconciliation (Form 496A)
// spec/sections/06-custodial-account-management/6-4-t-i-custodial-reconciliation-form-496a.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { ET, paidNotIssued, form496TimerOutcome, attestationTieOut } from "./ops.ts";

// 6.4-T1 — implemented in src/domain/custodial/custodial.test.ts
// 6.4-T2 — implemented in src/domain/custodial/custodial.test.ts
// 6.4-T3 — implemented in src/domain/custodial/custodial.test.ts
// 6.4-T4 — implemented in src/domain/custodial/custodial.test.ts
// 6.4-T5 — implemented in src/domain/custodial/custodial.test.ts
// 6.4-T6 — implemented in src/domain/custodial/custodial.test.ts
test("6.4-T7: Given a paid check on the bank's paid file with no matching issued record, then critical exception, `fraud` case, bank claim within 1 BD.", () => {
  const r = paidNotIssued({ paid: [{ check_number: "100231", amount_cents: 58200n, paid_on: D("2026-10-05") }, { check_number: "100232", amount_cents: 41000n, paid_on: D("2026-10-05") }], issued: [{ check_number: "100232", amount_cents: 41000n }] });
  assert.equal(r.exceptions.length, 1); assert.equal(r.exceptions[0]!.check_number, "100231"); assert.equal(r.exceptions[0]!.severity, "critical"); assert.equal(r.exceptions[0]!.fraud_case, true); assert.equal(r.exceptions[0]!.bank_claim_by, "2026-10-06");
});
test("6.4-T8: Given the 45-day deadline for 2026-09-30 \u2192 internal `due_at` 2026-11-13 17:00; on-time and breach behaviours as 6.3-T3.", () => {
  const ok = form496TimerOutcome({ kind: "monthly_form_496a", period_end: D("2026-09-30"), completed_at_ms: zonedEpochMs(D("2026-11-13"), "16:00", ET), now_ms: zonedEpochMs(D("2026-11-13"), "16:00", ET) });
  assert.equal(ok.due_on, "2026-11-13"); assert.equal(toIso(ok.due_at_ms), toIso(zonedEpochMs(D("2026-11-13"), "17:00", ET))); assert.equal(ok.status, "satisfied");
  const late = form496TimerOutcome({ kind: "monthly_form_496a", period_end: D("2026-09-30"), completed_at_ms: null, now_ms: zonedEpochMs(D("2026-11-13"), "17:01", ET) });
  assert.equal(late.status, "breached"); assert.deepEqual(late.escalation, { role: "officer", severity: "critical" }); assert.equal(late.partner_notice, true); assert.match(late.sentinel_line!, /monthly_form_496a/);
});

test("6.4 worked example: September attestation ties to the snapshot ($8,573,053.99 net, 4,210 loans, Σ contractual $1,911,432.50; loss drafts $121,500.00 over 9 loans, one aged 8 months)", () => {
  const snapshot = { ti_ending_cents: 857305399n, loan_count: 4210, contractual_escrow_sum_cents: 191143250n, loss_draft_cents: 12150000n, loss_draft_loans: 9 };
  const r = attestationTieOut({ snapshot, attestation: { ...snapshot }, loss_drafts: [{ loan_id: "L-LD1", received_on: D("2026-01-30"), explanation: "contractor final inspection pending; borrower notified" }, { loan_id: "L-LD2", received_on: D("2026-08-14"), explanation: null }], as_of: D("2026-09-30") });
  assert.equal(r.ties, true); assert.equal(r.answer, "Yes"); assert.deepEqual(r.aged_loss_drafts.map((l) => [l.loan_id, l.months]), [["L-LD1", 8]]);
  const off = attestationTieOut({ snapshot, attestation: { ...snapshot, contractual_escrow_sum_cents: 191143251n }, loss_drafts: [], as_of: D("2026-09-30") });
  assert.equal(off.answer, "No"); assert.deepEqual(off.variances, ["contractual_escrow_sum_cents"]);
});
