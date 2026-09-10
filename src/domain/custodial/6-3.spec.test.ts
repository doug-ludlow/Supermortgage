// 6.3 Monthly P&I reconciliation (Form 496)
// spec/sections/06-custodial-account-management/6-3-monthly-p-i-reconciliation-form-496.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { shortageFunding, RECON_WRITE_OFF_LIMIT_CENTS } from "./reconciliation.ts";
import { ET, form496TimerOutcome, unidentifiedDebit, ingestStatement, reviewerRun, approvalReminder, retroCorrection, aaLine1Logic } from "./ops.ts";

// 6.3-T1 — implemented in src/domain/custodial/custodial.test.ts
// 6.3-T2 — implemented in src/domain/custodial/custodial.test.ts
test("6.3-T3: Given completion on 2026-11-13 16:00, then timer `satisfied`; given no completion by 2026-11-13 17:00, then `breached`, `officer` critical escalation, partner notice, Sentinel report line.", () => {
  const ok = form496TimerOutcome({ kind: "monthly_form_496", period_end: D("2026-09-30"), completed_at_ms: zonedEpochMs(D("2026-11-13"), "16:00", ET), now_ms: zonedEpochMs(D("2026-11-13"), "16:00", ET) });
  assert.equal(ok.status, "satisfied"); assert.equal(toIso(ok.due_at_ms), toIso(zonedEpochMs(D("2026-11-13"), "17:00", ET)));
  const late = form496TimerOutcome({ kind: "monthly_form_496", period_end: D("2026-09-30"), completed_at_ms: null, now_ms: zonedEpochMs(D("2026-11-13"), "17:01", ET) });
  assert.equal(late.status, "breached"); assert.deepEqual(late.escalation, { role: "officer", severity: "critical" }); assert.equal(late.partner_notice, true); assert.match(late.sentinel_line!, /45-day/);
});
// 6.3-T4 — implemented in src/domain/custodial/custodial.test.ts
test("6.3-T5: Given an unmatched bank debit of $8,500.00 (BAI2 451) not in Draft Notifications/CRS reports, then severity critical, `fraud` case opened, bank contacted same day, funding tier evaluated, `officer` escalation.", () => {
  const d = unidentifiedDebit({ amount_cents: 850000n, type_code: "451", in_draft_notifications: false, in_crs_reports: false, identified_on: D("2026-10-08") });
  assert.equal(d.severity, "critical"); assert.equal(d.fraud_case, true); assert.equal(d.bank_contact_by, "2026-10-08"); assert.equal(d.category, "ach_debit");
  assert.equal(d.funding!.tier, "officer_partner_fraud"); assert.equal(d.escalation, "officer");
  assert.equal(unidentifiedDebit({ amount_cents: 850000n, type_code: "451", in_draft_notifications: true, in_crs_reports: false, identified_on: D("2026-10-08") }).severity, null);
});
// 6.3-T6 — implemented in src/domain/custodial/custodial.test.ts
// 6.3-T7 — implemented in src/domain/custodial/custodial.test.ts
// 6.3-T8 — implemented in src/domain/custodial/custodial.test.ts
// 6.3-T9 — implemented in src/domain/custodial/custodial.test.ts
test("6.3-T10: Given the statement file's 49-record total \u2260 \u03a3 16 records, then `control_total_mismatch`, statement quarantined, bank re-request logged, daily recon closes with the item.", () => {
  const bad = ingestStatement({ file_id: "BAI2-1007", credit_lines: [100000n, 250000n], summary_credits: 350000n, debit_lines: [482103300n], summary_debits: 484103300n });
  assert.equal(bad.ok, false); assert.equal(bad.exception, "control_total_mismatch"); assert.equal(bad.quarantined, true); assert.equal(bad.bank_rerequest_logged, true); assert.match(bad.daily_close_item!, /quarantined/);
  assert.equal(ingestStatement({ file_id: "BAI2-1008", credit_lines: [100000n, 250000n], summary_credits: 350000n, debit_lines: [482103300n], summary_debits: 482103300n }).ok, true);
});
test("6.3-T11: Given the reviewer run detects an item without a loan number, then status `rework`, not `approved`.", () => {
  const good = { id: "it-1", category: "deposit_in_transit", amount_cents: 1245000n, loan_id: "L-1", root_cause: "lockbox batch LBX-0930-07 credited 10/1", first_seen_on: D("2026-09-30"), evidence_refs: ["doc-1"] };
  const r = reviewerRun([good, { ...good, id: "it-2", loan_id: null }], { difference_cents: 0n, preparer_run_id: "run-p", posting_run_ids: ["run-x"] });
  assert.equal(r.status, "rework"); assert.deepEqual(r.findings, ["it-2: no loan number"]);
  assert.equal(reviewerRun([good], { difference_cents: 0n, preparer_run_id: "run-p", posting_run_ids: ["run-x"] }).status, "approved");
});
test("6.3-T12: Given `custodial.form496.human_approval = on` and no officer action in 3 BD after review, then reminder escalation; the 45-day timer is unaffected (it is satisfied only by `completed`).", () => {
  const r = approvalReminder({ human_approval_on: true, reviewed_on: D("2026-11-02"), officer_action_on: null, today: D("2026-11-06") });
  assert.equal(r.reminder_due_on, "2026-11-05"); assert.equal(r.reminder, true); assert.equal(r.form_timer_affected, false); assert.equal(r.form_timer_satisfied_by, "custodial.reconciliation.completed");
  assert.equal(approvalReminder({ human_approval_on: true, reviewed_on: D("2026-11-02"), officer_action_on: null, today: D("2026-11-05") }).reminder, false);
  assert.equal(approvalReminder({ human_approval_on: false, reviewed_on: D("2026-11-02"), officer_action_on: null, today: D("2026-11-20") }).reminder, false);
});
test("6.3-T13: Given a payment reversal posted 11/20 for a 10/28 receipt after the October form is completed, then the October form is unchanged, the November Section III carries the item with `first_seen_on = 10/28` (aging 23+ days).", () => {
  const r = retroCorrection({ completed_period_end: D("2026-10-31"), original_receipt_on: D("2026-10-28"), reversal_posted_on: D("2026-11-20"), amount_cents: 150000n, completed_form_version: 1 });
  assert.equal(r.completed_form_changed, false); assert.equal(r.completed_form_version, 1); assert.equal(r.carried_in_period, "2026-11");
  assert.equal(r.item.first_seen_on, "2026-10-28"); assert.equal(r.item.aging_days, 23); assert.equal(r.item.amount_cents, -150000n);
});
test("6.3-T14: Given LL-2026-05 A/A auto-draft flag on, then L1 logic switches and Form 472 timers are not started for A/A.", () => {
  assert.deepEqual(aaLine1Logic({ autodraft_on: true }), { line1_basis: "events_processed_draft_pending_2bd", form472_timers_started: false, settle_up_category: "fnma_settle_up" });
  assert.deepEqual(aaLine1Logic({ autodraft_on: false }), { line1_basis: "collected_not_remitted", form472_timers_started: true, settle_up_category: null });
});

test("6.3 rule 5 funding tiers: ≤ $1,000.00 agent auto-funds; $1,000.01–$25,000.00 officer within 1 BD; above $25,000.00 officer + partner + fraud; write-offs only in the ≤ $25.00 rounding class", () => {
  assert.equal(shortageFunding(100000n, D("2026-10-08")).tier, "agent_auto");
  assert.equal(shortageFunding(100001n, D("2026-10-08")).tier, "officer_1bd");
  assert.equal(shortageFunding(2500000n, D("2026-10-08")).tier, "officer_1bd");
  assert.equal(shortageFunding(2500001n, D("2026-10-08")).tier, "officer_partner_fraud");
  assert.equal(RECON_WRITE_OFF_LIMIT_CENTS, 2500n);
});
