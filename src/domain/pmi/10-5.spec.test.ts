// 10.5 Unearned premium refund
// spec/sections/10-pmi-administration/10-5-unearned-premium-refund.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { unearnedEstimate } from "./refund.ts";
import { ET, escrowMiLineRelease, refundEscrowEvents, insurerRescission } from "./ops.ts";

// 10.5-T1 — implemented in src/domain/pmi/pmi.test.ts
// 10.5-T2 — implemented in src/domain/pmi/pmi.test.ts
// 10.5-T3 — implemented in src/domain/pmi/pmi.test.ts
test("10.5-T4: Given the escrow MI line balance $950.00 at E, then an interim analysis completes within 10 BD, the surplus is refunded within 30 days of the analysis, and the new payment excludes the $190.00 MI deposit effective 2031-09-01.", () => {
  const r = escrowMiLineRelease({ E: D("2031-08-01"), mi_line_balance_cents: 95000n, monthly_mi_deposit_cents: 19000n, old_payment_cents: 289186n, analysis_on: D("2031-08-06") });
  assert.equal(r.interim_analysis_due, D("2031-08-15")); assert.equal(r.surplus_cents, 95000n); assert.equal(r.surplus_refund_due, D("2031-09-05"));
  assert.equal(r.new_payment_cents, 270186n); assert.equal(r.new_payment_effective, D("2031-09-01")); assert.equal(r.refund_regardless_of_50_threshold, true);
});
// 10.5-T5 — implemented in src/domain/pmi/pmi.test.ts
// 10.5-T6 — implemented in src/domain/pmi/pmi.test.ts
// 10.5-T7 — implemented in src/domain/pmi/pmi.test.ts
// 10.5-T8 — implemented in src/domain/pmi/pmi.test.ts
test("10.5-T9: Given Dec. 2, 2026 or later, then the refund deposit and disbursement generate escrow events accepted before 03:00 ET the next business day.", () => {
  const r = refundEscrowEvents({ posted_on: D("2026-12-02"), legs: [{ kind: "deposit", amount_cents: 141173n }, { kind: "disbursement", amount_cents: 141173n }] });
  assert.equal(r.events.length, 2); assert.equal(r.accept_by_ms, zonedEpochMs(D("2026-12-03"), "03:00", ET));
  assert.ok(r.events.every((e) => e.type === "escrow.event" && e.category === "taxes_insurance" && e.accept_by_ms === r.accept_by_ms));
  assert.ok(zonedEpochMs(D("2026-12-03"), "02:59", ET) < r.accept_by_ms!);
  assert.deepEqual(refundEscrowEvents({ posted_on: D("2026-11-30"), legs: [{ kind: "deposit", amount_cents: 1n }] }).events, []);
});
test("10.5-T10: Given an insurer rescission notice received 2027-03-03, then LAR 89 action code 54 with action date 030327 is reported and a Fannie Mae notification is made within 30 days; the borrower refund leg is held for `officer` decision.", () => {
  const r = insurerRescission({ received_on: D("2027-03-03"), loan_active: true });
  assert.deepEqual(r.lar89, { code: "54", action_date: "030327", line_suffix: "54 030327" }); assert.deepEqual(r.fnma_notification, { due: D("2027-04-02"), channel: "lar89" });
  assert.deepEqual(r.borrower_refund_leg, { status: "held", decision_by: "officer", borrower_entitled_unless: "borrower misrepresentation" }); assert.equal(r.hpa_termination_notice, false); assert.equal(r.informational_letter, true);
  assert.equal(insurerRescission({ received_on: D("2027-03-03"), loan_active: false }).fnma_notification.channel, "email_liquidated");
});

test("10.5 worked figures: annual earned $868.27 of $2,280.00; monthly earned $76.00, unearned $114.00; MI line $950.00; payment $2,891.86 → $2,701.86", () => {
  assert.equal(228000n - unearnedEstimate({ kind: "annual", premium_cents: 228000n, anniversary_start: D("2031-03-15") }, D("2031-08-01")), 86827n);
  const monthly = unearnedEstimate({ kind: "monthly", premium_cents: 19000n, coverage_month_start: D("2031-08-01") }, D("2031-08-13"));
  assert.equal(monthly, 11400n); assert.equal(19000n - monthly, 7600n);
  assert.equal(escrowMiLineRelease({ E: D("2031-08-01"), mi_line_balance_cents: 95000n, monthly_mi_deposit_cents: 19000n, old_payment_cents: 289186n }).new_payment_cents, 270186n);
});
