// 10.2 Automatic termination @78% LTV
// spec/sections/10-pmi-administration/10-2-automatic-termination-78-ltv.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { ratePercent, levelPayment } from "../../kernel/money/cents.ts";
import { buildSchedule, armResetVersion, thresholdCents } from "./schedule.ts";
import { installmentLedger } from "./fixtures.ts";
import { ET, sweepTermination, sweepMissedCheck, lar89AckStatus, statementMiGuard, nyPremiumGate } from "./ops.ts";

test("10.2-T1: Given the worked loan current on 2035-07-01, when the sweep runs 2035-07-01 00:30, then `mi.terminated` effective 2035-07-01, LAR 89 `\u202689 0 <loan> 53 070135`, insurer message queued, escrow interim analysis requested, timers `HPA_4904A_TERMINATION_NOTICE_30` (due 2035-07-31) and `HPA_4902F1_REFUND_45` (due 2035-08-15) started.", () => {
  const r = sweepTermination({ loan_id: "1234567890", installments: installmentLedger(140, { "2035-06-01": "2035-06-12" }, D("2035-07-01")), scheduled_date: D("2035-07-01") });
  assert.equal(r.result.status, "terminated"); const a = r.actions!;
  assert.equal(a.event, "mi.terminated"); assert.equal(a.effective, D("2035-07-01"));
  assert.equal(a.lar89.line, "89 0 1234567890 53 070135");
  assert.equal(a.insurer_message.queued, true); assert.equal(a.escrow_interim_analysis.requested, true);
  assert.deepEqual(a.timers.find((t) => t.code === "HPA_4904A_TERMINATION_NOTICE_30"), { code: "HPA_4904A_TERMINATION_NOTICE_30", due: D("2035-07-31") });
  assert.deepEqual(a.timers.find((t) => t.code === "HPA_4902F1_REFUND_45"), { code: "HPA_4902F1_REFUND_45", due: D("2035-08-15") });
});
test("10.2-T2: Given the June 2035 installment unpaid on 2035-06-30, then status `deferred_not_current`, `NTC_HPA_4904B_AUTO_NOT_CURRENT` sent by 2035-07-31; when June and July are paid 2035-07-20, then termination effective 2035-08-01.", () => {
  const r = sweepTermination({ loan_id: "L1", installments: installmentLedger(140, { "2035-06-01": "2035-07-20", "2035-07-01": "2035-07-20" }, D("2035-07-01")), scheduled_date: D("2035-07-01") });
  assert.equal(r.result.status, "deferred_not_current");
  assert.equal(r.not_current_notice!.code, "NTC_HPA_4904B_AUTO_NOT_CURRENT"); assert.equal(r.not_current_notice!.send_by, D("2035-07-31")); assert.deepEqual(r.not_current_notice!.installments, [D("2035-06-01")]);
  assert.equal(r.result.status === "deferred_not_current" && r.result.cure_on, D("2035-07-20")); assert.equal(r.actions!.effective, D("2035-08-01")); assert.equal(r.actions!.lar89.action_date, "080135");
});
test("10.2-T3: Given July paid 2035-08-03 (Scenario C), then effective 2035-09-01 and the not-current notice referenced the June installment only.", () => {
  const r = sweepTermination({ loan_id: "L1", installments: installmentLedger(140, { "2035-06-01": "2035-07-08", "2035-07-01": "2035-08-03" }, D("2035-08-01")), scheduled_date: D("2035-07-01") });
  assert.equal(r.actions!.effective, D("2035-09-01"));
  assert.deepEqual(r.not_current_notice!.installments, [D("2035-06-01")]); assert.match(r.not_current_notice!.grounds_text, /^the June 2035 payment was not received by 2035-06-30$/);
});
// 10.2-T4 — implemented in src/domain/pmi/pmi.test.ts
// 10.2-T5 — implemented in src/domain/pmi/pmi.test.ts
test("10.2-T6: Given the sweep did not run (job failure) on the scheduled date, then `HPA_4902B_AUTO_TERMINATE_0` breaches next sweep and `officer` sev-1 opens with the affected loan list.", () => {
  const r = sweepMissedCheck({ policies: [{ loan_id: "A", scheduled_date: D("2035-07-01"), auto_status: "pending" }, { loan_id: "B", scheduled_date: D("2035-07-01"), auto_status: "pending" }, { loan_id: "C", scheduled_date: D("2035-07-01"), auto_status: "terminated" }], last_sweep_on: D("2035-06-30"), today: D("2035-07-02") });
  assert.equal(r.breached, true); assert.equal(r.timer, "HPA_4902B_AUTO_TERMINATE_0"); assert.equal(r.job_failure, true);
  assert.deepEqual(r.escalation, { role: "officer", severity: 1, affected_loans: ["A", "B"] });
  assert.equal(sweepMissedCheck({ policies: [{ loan_id: "C", scheduled_date: D("2035-07-01"), auto_status: "terminated" }], last_sweep_on: D("2035-07-01"), today: D("2035-07-02") }).breached, false);
});
test("10.2-T7: Given the effective date 2035-07-01 and LAR 89 not acked by BD2 Aug 2035 15:00 ET, then timer breach and a `human_portal_task` for single-LAR entry.", () => {
  const at1500 = zonedEpochMs(D("2035-08-02"), "15:00", ET);
  const r = lar89AckStatus({ effective: D("2035-07-01"), acked_at_ms: null, now_ms: at1500 });
  assert.equal(r.clocks.period_close_on, D("2035-08-02")); assert.equal(toIso(r.clocks.bulk_cutoff_ms), toIso(at1500)); assert.equal(toIso(r.clocks.period_close_ms), toIso(zonedEpochMs(D("2035-08-02"), "17:00", ET)));
  assert.equal(r.status, "bulk_channel_closed"); assert.equal(r.timer_breached, "SM_MI_LAR89_INTERNAL_TARGET_NEXTBD_2000");
  assert.deepEqual(r.human_portal_task, { kind: "single_lar_entry", owner_role: "fnma_portal_operator", by_ms: r.clocks.period_close_ms });
  assert.equal(lar89AckStatus({ effective: D("2035-07-01"), acked_at_ms: zonedEpochMs(D("2035-07-02"), "19:00", ET), now_ms: at1500 }).status, "acked");
  assert.equal(lar89AckStatus({ effective: D("2035-07-01"), acked_at_ms: null, now_ms: zonedEpochMs(D("2035-08-02"), "17:01", ET) }).status, "breached");
});
test("10.2-T8: Given a periodic statement generated for the 2035-08-01 installment still including the MI escrow component, then the statement command is blocked by `HPA_4902E_STOP_PREMIUM_30` and an alert opens.", () => {
  const r = statementMiGuard({ installment_due: D("2035-08-01"), effective: D("2035-07-01"), includes_mi: true });
  assert.equal(r.blocked, true); assert.equal(r.gate, "HPA_4902E_STOP_PREMIUM_30"); assert.equal(r.premium_stop_by, D("2035-07-31")); assert.deepEqual(r.alert, { role: "officer", severity: 1 });
  assert.equal(statementMiGuard({ installment_due: D("2035-08-01"), effective: D("2035-07-01"), includes_mi: false }).blocked, false);
  assert.equal(statementMiGuard({ installment_due: D("2035-07-01"), effective: D("2035-07-01"), includes_mi: true }).blocked, false);
});
// 10.2-T9 — implemented in src/domain/pmi/pmi.test.ts
// 10.2-T10 — implemented in src/domain/pmi/pmi.test.ts
test("10.2-T11: Given a NY loan whose actual UPB falls to 74.9% of original appraised value while its payment history fails the 30-day test, then the NY gate stops MI charges to the borrower and an `officer` escalation records the corporate premium carry.", () => {
  const r = nyPremiumGate({ state: "NY", upb_cents: 30709000n, original_appraised_value_cents: 41000000n, history_ok: false });
  assert.equal(r.ltv_bps, 7490); assert.equal(r.gate_open, true); assert.equal(r.stop_borrower_premium, true); assert.equal(r.premium_borne_by, "servicer_corporate");
  assert.deepEqual(r.escalation, { role: "officer", record: "corporate premium carry" }); assert.equal(r.reevaluate, "monthly_10_1");
  assert.equal(nyPremiumGate({ state: "TX", upb_cents: 30709000n, original_appraised_value_cents: 41000000n, history_ok: false }).gate_open, false);
  assert.equal(nyPremiumGate({ state: "NY", upb_cents: 31000000n, original_appraised_value_cents: 41000000n, history_ok: false }).gate_open, false);
});

test("10.2 worked figures: 78% threshold $312,000.00; ARM 5.50% P&I $2,157.60, scheduled balance $351,350.17 at the reset, 7.50% P&I $2,596.45; Flex Mod P&I $1,873.46", () => {
  assert.equal(thresholdCents(40000000n, 78), 31200000n);
  const s55 = buildSchedule({ upb_cents: 38000000n, annual_rate: ratePercent("5.5"), term_months: 360, first_due: D("2024-05-01") });
  assert.equal(s55.pi_cents, 215760n); assert.equal(s55.rows[59]!.upb_after_cents, 35135017n);
  assert.equal(armResetVersion(s55, 61, ratePercent("7.5"), 300).pi_cents, 259645n);
  assert.equal(levelPayment(32000000n, ratePercent("6.5"), 480), 187346n);
});
