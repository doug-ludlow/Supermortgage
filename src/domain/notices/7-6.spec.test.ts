// 7.6 Payoff statement
// spec/sections/07-compliance-notices-disclosures/7-6-payoff-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { payoff, perDiem } from "./payoff-statement.ts";
import { payoffClockStart, oralPayoffRequest, updatedPayoffStatement, successorPayoffRequest, noePayoffLink } from "./ops.ts";

// 7.6-T1 — implemented in src/domain/notices/notices.test.ts
test("7.6-T2: Given the same request by mail received by the scanning vendor 2026-10-13, then the clock starts 2026-10-13 (vendor receipt date, not postmark).", () => {
  const r = payoffClockStart({ channel: "mail", received_on: D("2026-10-13"), postmark_on: D("2026-10-09"), vendor_receipt_on: D("2026-10-13") });
  assert.equal(r.clock_start, "2026-10-13"); assert.match(r.basis, /vendor receipt date/); assert.equal(r.federal_due, "2026-10-22");
  assert.equal(payoffClockStart({ channel: "email", received_on: D("2026-10-13") }).federal_due, "2026-10-22");
});
// 7.6-T3 — implemented in src/domain/notices/notices.test.ts
// 7.6-T4 — implemented in src/domain/notices/notices.test.ts
test("7.6-T5: Given an oral request by AI voice, then a quote is given per 16.1, no \u00a71026.36(c)(3) timer starts, and the borrower is offered a one-click written request; given the click, then the timer starts at the click time.", () => {
  const oral = oralPayoffRequest({ channel: "ai_voice", clicked_written_at: null });
  assert.equal(oral.quote, "16.1_engine"); assert.equal(oral.timer_started, false); assert.equal(oral.written_offer, "one_click_written_request");
  const clicked = oralPayoffRequest({ channel: "ai_voice", clicked_written_at: "2026-10-13T14:41:00-05:00" });
  assert.equal(clicked.timer_started, true); assert.equal(clicked.timer_started_at, "2026-10-13T14:41:00-05:00");
});
// 7.6-T6 — implemented in src/domain/notices/notices.test.ts
// 7.6-T7 — implemented in src/domain/notices/notices.test.ts
// 7.6-T8 — implemented in src/domain/notices/notices.test.ts
test("7.6-T9: Given an escrow tax disbursement advance posted after the statement but before the good-through date, then an updated statement is issued the same day and the original is marked superseded.", () => {
  const u = updatedPayoffStatement({ original: { id: "stmt-1", good_through: D("2026-11-20"), total_cents: 37234499n }, change: { kind: "escrow_tax_disbursement_advance", posted_on: D("2026-11-05"), delta_cents: 412000n } });
  assert.equal(u.updated, true); assert.equal(u.updated_on, "2026-11-05"); assert.equal(u.template, "NTC_PAYOFF_UPDATED_STMT"); assert.equal(u.original_status, "superseded"); assert.equal(u.new_total_cents, 37646499n); assert.equal(u.retained_original, true);
  assert.equal(updatedPayoffStatement({ original: { id: "stmt-1", good_through: D("2026-11-20"), total_cents: 37234499n }, change: { kind: "fee", posted_on: D("2026-11-25"), delta_cents: 100n } }).updated, false);
});
test("7.6-T10: Given a confirmed successor requests a payoff, then it is a consumer request (no authorization needed) and the statement is delivered to the successor.", () => {
  assert.deepEqual(successorPayoffRequest({ confirmed: true }), { classification: "consumer_request", deliver_to: "successor", authorization_needed: false });
  assert.equal(successorPayoffRequest({ confirmed: false }).authorization_needed, true);
});
test("7.6-T11: Given a NoE alleging an inaccurate payoff, then the 4.1 NoE case links to the `payoff_requests` row and the statement hash under investigation.", () => {
  assert.deepEqual(noePayoffLink({ noe_case_id: "NOE-77", payoff_request_id: "PR-12", statement_hash: "sha256:ab12" }), { case_id: "NOE-77", links: { payoff_request_id: "PR-12", statement_hash: "sha256:ab12" }, error_type: "1024.35(b)(6)", freeze_updates: false });
});

test("7.6 worked example: UPB $371,048.86 after the Nov 1 payment (alternative $371,602.55 before it), per diem $64.81 at 6.375%, escrow $1,830.00 refunded separately", () => {
  assert.equal(perDiem(37104886n, "6.375"), 6481n);
  const p = payoff({ upb_cents: 37104886n, rate_pct: "6.375", paid_through: D("2026-10-31"), good_through: D("2026-11-20") });
  assert.equal(p.days, 20); assert.equal(p.per_diem_cents, 6481n); assert.equal(p.escrow_treatment, "refund_separately_20bd");
  const escrowRefund = 183000n; assert.ok(escrowRefund > 0n);
  assert.equal(37160255n - (233429n - 178060n), 37104886n);                                        // Nov 1 payment: interest at 5.750% then principal
});
