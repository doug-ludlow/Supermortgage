// 7.2 ARM interest rate adjustment notice
// spec/sections/07-compliance-notices-disclosures/7-2-arm-interest-rate-adjustment-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { newConsent, verify } from "./esign.ts";
import { newPayment } from "./arm.ts";
import { armNoticeSelection, buydownStepNotice, marginErrorCorrection, scheduledUpbAfter, fdcpaCeaseArmNotice, indexCaptureFallback, ch13PaymentChange, armNoticeChannel, computeArmAdjustment, verifyArmAdjustment } from "./ops.ts";

// 7.2-T1 — implemented in src/domain/notices/notices.test.ts
// 7.2-T2 — implemented in src/domain/notices/notices.test.ts
// 7.2-T3 — implemented in src/domain/notices/notices.test.ts
// 7.2-T4 — implemented in src/domain/notices/notices.test.ts
// 7.2-T5 — implemented in src/domain/notices/notices.test.ts
// 7.2-T6 — implemented in src/domain/notices/notices.test.ts
// 7.2-T7 — implemented in src/domain/notices/notices.test.ts
test("7.2-T8: Given a rate change with an unchanged payment (payment-cap plan), then `NTC_FNMA_C2_1_02_RATE_CHANGE` is sent \u2265 25 days before the change date and no Reg Z (c) notice is generated.", () => {
  const s = armNoticeSelection({ rate_changed: true, payment_changed: false, change_date: D("2026-11-01") });
  assert.equal(s.regz_c_notice, false); assert.equal(s.fnma_notice, "NTC_FNMA_C2_1_02_RATE_CHANGE"); assert.equal(s.send_by, "2026-10-07");
  assert.equal(armNoticeSelection({ rate_changed: true, payment_changed: true, change_date: D("2026-11-01") }).regz_c_notice, true);
  assert.equal(armNoticeSelection({ rate_changed: false, payment_changed: false, change_date: D("2026-11-01") }).fnma_notice, null);
});
test("7.2-T9: Given a 2-1 temporary buydown stepping on 2027-01-01, then `NTC_FNMA_C2_1_02_BUYDOWN_STEP_90` is sent by 2026-10-03.", () => {
  assert.deepEqual(buydownStepNotice(D("2027-01-01")), { template: "NTC_FNMA_C2_1_02_BUYDOWN_STEP_90", send_by: "2026-10-03", timer: "FNMA_C2_1_02_BUYDOWN_STEP_NOTICE_90" });
});
test("7.2-T10: Given a boarding margin error discovered (2.750 booked as 3.250) after two adjustments, then re-amortization yields the overcharge, a cash refund is issued (combined error > $1.00), the correction notice is sent, the correction is reported only after `irr_discussed_at` is set, and both are complete within 60 days.", () => {
  const c = marginErrorCorrection({ discovered_on: D("2027-06-10"), upb_at_first_change_cents: 37104886n, segments: [{ correct_rate_pct: "6.375", booked_rate_pct: "6.875", months: 6, payment_cents: 259688n }, { correct_rate_pct: "6.375", booked_rate_pct: "6.875", months: 1, payment_cents: 259688n }], current: true, advances: false, irr_discussed_at: null });
  assert.ok(c.net_effect_cents > 100n, "overcharge above $1.00");                                    // booked rate too high → actual UPB too high
  assert.equal(c.treatment, "cash_refund"); assert.equal(c.correction_notice, "NTC_FNMA_C2_2_01_ARM_CORRECTION"); assert.equal(c.report_to_fnma, false); assert.equal(c.complete_by, "2027-08-09"); assert.equal(c.timer, "FNMA_C2_2_01_CORRECT_60");
  assert.equal(marginErrorCorrection({ discovered_on: D("2027-06-10"), upb_at_first_change_cents: 37104886n, segments: [{ correct_rate_pct: "6.375", booked_rate_pct: "6.875", months: 7, payment_cents: 259688n }], current: true, advances: false, irr_discussed_at: "2027-06-12T15:00:00Z" }).report_to_fnma, true);
});
test("7.2-T11: Given an FDCPA 805(c) notice on file, then no `NTC_REGZ_20C_ARM_ADJ` is generated and the Fannie Mae informational notice is sent instead, with the decision record citing (c)(1)(ii)(C).", () => {
  const r = fdcpaCeaseArmNotice({ fdcpa_cease_on_file: true, debt_collector: true });
  assert.equal(r.regz_c_notice, false); assert.equal(r.fnma_notice, "NTC_FNMA_C2_1_02_RATE_CHANGE"); assert.equal(r.marked_as, "required_by_contract_information"); assert.equal(r.decision_cite, "12 CFR 1026.20(c)(1)(ii)(C)");
  assert.equal(fdcpaCeaseArmNotice({ fdcpa_cease_on_file: true, debt_collector: false }).regz_c_notice, true);
});
test("7.2-T12: Given the NY Fed API returns HTTP 5xx for 2 days, then the capture timer alerts, the fallback source is used with dual-control evidence, and the calculation proceeds on the correct index date.", () => {
  const r = indexCaptureFallback({ index_date: D("2026-09-17"), api_failures: [{ on: D("2026-09-17"), status: 503 }, { on: D("2026-09-18"), status: 502 }], fallback: { source: "vendor_feed", value: "3.64883", effective_date: D("2026-09-17"), evidence_ids: ["screenshot-1"], approvers: ["ops-1", "officer-2"] } });
  assert.equal(r.alert, true); assert.equal(r.source, "fallback"); assert.equal(r.index_value, "3.64883"); assert.equal(r.index_date, "2026-09-17"); assert.equal(r.dual_control, true); assert.equal(r.qc_flag, true);
  assert.equal(indexCaptureFallback({ index_date: D("2026-09-17"), api_failures: [{ on: D("2026-09-17"), status: 503 }], fallback: null }).alert, false);
  assert.equal(indexCaptureFallback({ index_date: D("2026-09-17"), api_failures: [{ on: D("2026-09-17"), status: 503 }, { on: D("2026-09-18"), status: 500 }], fallback: { source: "manual", value: "3.6", effective_date: D("2026-09-17"), evidence_ids: [], approvers: ["ops-1"] } }).source, null);
});
test("7.2-T13: Given a Chapter 13 debtor, then `payment.change.scheduled` reaches 14.2 at least 60 days before the new payment and the 3002.1 notice is filed \u2265 21 days before.", () => {
  const r = ch13PaymentChange({ first_new_payment_due: D("2026-12-01"), verified_on: D("2026-09-18") });
  assert.equal(r.emit, "payment.change.scheduled"); assert.equal(r.emit_by, "2026-10-02"); assert.equal(r.on_time, true); assert.equal(r.rule_3002_1_file_by, "2026-11-10");
  assert.equal(ch13PaymentChange({ first_new_payment_due: D("2026-12-01"), verified_on: D("2026-10-05") }).on_time, false);
});
test("7.2-T14: Given e-delivery consent for `arm_notices`, then the notice is emailed/posted within the window; given no consent, then it is mailed; SMS-only is never used.", () => {
  const c = newConsent("A", ["arm_notices"], "v1.3", D("2026-10-02"), "portal"); if ("error" in c) throw new Error(c.error); verify(c, true, true, D("2026-10-02"));
  assert.deepEqual(armNoticeChannel({ consent: c }), { channel: "electronic", sms_only_allowed: false });
  assert.deepEqual(armNoticeChannel({ consent: null }), { channel: "mail", sms_only_allowed: false });
  const other = newConsent("B", ["periodic_statements"], "v1.3", D("2026-10-02"), "portal"); if ("error" in other) throw new Error(other.error); verify(other, true, true, D("2026-10-02"));
  assert.equal(armNoticeChannel({ consent: other }).channel, "mail");
});

test("7.2 worked example (Plan 4927): $400,000.00 at 5.750% → expected UPB $371,048.86 after 60 payments of $2,334.29; 6.375% → P&I $2,476.44 (total $3,088.94 with escrow $612.50 vs $2,946.79); a 5.100 index caps at 7.750% → $2,802.64; overcharges above $1.00 are refunded", () => {
  assert.equal(scheduledUpbAfter(40000000n, "5.750", 233429n, 60), 37104886n);
  const base = { index_pct: "3.64883", margin_pct: "2.750", prior_rate_pct: "5.750", initial_note_rate_pct: "5.750", initial_cap_pct: "2.000", periodic_cap_pct: "1.000", lifetime_cap_pct: "5.000", first_change: true, expected_upb_cents: 37104886n, remaining_term_months: 300 };
  const a = computeArmAdjustment(base); const b = verifyArmAdjustment(base, a);
  assert.equal(a.new_rate_pct, "6.375"); assert.equal(a.new_pi_cents, 247644n); assert.equal(b.agrees, true); assert.equal(b.discrepancy, null);
  assert.equal(247644n + 61250n, 308894n); assert.equal(233429n + 61250n, 294679n);
  const capped = computeArmAdjustment({ ...base, index_pct: "5.10000" }); assert.equal(capped.new_rate_pct, "7.750"); assert.equal(capped.bound, "initial"); assert.equal(capped.new_pi_cents, 280264n);
  assert.equal(verifyArmAdjustment({ ...base, index_pct: "5.10000" }, capped).agrees, true);
  assert.equal(newPayment(37104886n, "7.750", 300), 280264n);
  assert.equal(marginErrorCorrection({ discovered_on: D("2027-06-10"), upb_at_first_change_cents: 37104886n, segments: [{ correct_rate_pct: "6.375", booked_rate_pct: "6.375", months: 6, payment_cents: 247644n }], current: true, advances: false, irr_discussed_at: null }).net_effect_cents, 0n);   // no error → no refund; the $1.00 (100n) threshold is in arm.correction
});
