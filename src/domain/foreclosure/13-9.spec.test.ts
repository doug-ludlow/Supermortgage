// 13.9 SCRA 6% interest cap
// spec/sections/13-foreclosure/13-9-scra-6-interest-cap.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { form1022Schedule, lateChargeWaiver, overpaymentElection, defaultElection, assertedServiceWithoutEvidence, lateRequest } from "./ops.ts";
import { recalculate, servicingFee } from "./scra.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";

// 13.9-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.9-T2 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.9-T3 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.9-T4 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.9-T5: Given a portfolio loan, Then Form 1022 emailed by BD9 of the following month with the reduction; MBS loan \u21d2 upload by CD15; both tracked with acks.", () => {
  const portfolio = form1022Schedule({ reduction_month: D("2026-09-01"), mbs: false, acked_on: D("2026-10-05") }); assert.equal(portfolio.channel, "email_bd9"); assert.equal(portfolio.due, "2026-10-14");   // BD9 of October 2026 (Columbus Day excluded) assert.equal(portfolio.tracked, true); assert.equal(portfolio.acknowledged, true);
  const mbs = form1022Schedule({ reduction_month: D("2026-09-01"), mbs: true }); assert.equal(mbs.channel, "upload_cd15"); assert.equal(mbs.due, "2026-10-15"); assert.equal(mbs.acknowledged, false);
});
test("13.9-T6: Given late charges of $81.86 assessed May\u2013Aug. 2026, Then waived/refunded with the recalculation; 2.7 gate blocks new ones.", () => {
  const charges = [{ assessed_on: D("2026-05-17"), cents: 2_047n, paid: true }, { assessed_on: D("2026-06-17"), cents: 2_047n, paid: false }, { assessed_on: D("2026-07-17"), cents: 2_046n, paid: false }, { assessed_on: D("2026-08-17"), cents: 2_046n, paid: false }];
  const r = lateChargeWaiver({ charges, cap_effective_due: D("2026-04-01"), cap_ends_on: D("2028-02-28") });
  assert.equal(r.waived_cents + r.refunded_cents, 8_186n); assert.equal(r.refunded_cents, 2_047n); assert.equal(r.new_charges_blocked, true); assert.equal(r.gate, "SCRA_3937_FEES_IN_CAP_GATE");
});
test("13.9-T7: Given the borrower elects refund, Then Dr `scra_overpayment_payable` 1,528.30 / Cr cash; election recorded; statement shows the refund transaction.", () => {
  const r = overpaymentElection({ overpayment_cents: 152_830n, next_payment_cents: 174_173n, election: "refund", recorded_on: D("2026-09-20") });
  assert.deepEqual(r.postings, [{ account: "scra_overpayment_payable", debit: 152_830n, credit: 0n, rule_ref: "13.9.overpayment.refund" }, { account: "cash", debit: 0n, credit: 152_830n, rule_ref: "13.9.overpayment.refund" }]);
  assert.equal(r.balanced, true); assert.equal(r.election_recorded, true); assert.equal(r.statement_line, "SCRA interest refund"); assert.equal(r.sufficient_alone, false); assert.equal(r.shortfall_cents, 21_343n);
});
test("13.9-T8: Given no election in 30 days, Then the default election (decision 13.9-3) applies and the borrower is told.", () => {
  const r = defaultElection({ letter_sent_on: D("2026-09-15"), today: D("2026-10-16") });
  assert.equal(r.due, "2026-10-15"); assert.equal(r.applied, "curtailment"); assert.equal(r.defaulted, true); assert.equal(r.borrower_notice, "NTC_SCRA_3937_OVERPAYMENT_ELECTION");
  assert.equal(defaultElection({ letter_sent_on: D("2026-09-15"), today: D("2026-10-10") }).applied, null); assert.equal(defaultElection({ letter_sent_on: D("2026-09-15"), election: "refund", today: D("2026-10-20") }).defaulted, false);
});
test("13.9-T9: Given the borrower asserts service but DMDC returns N and no orders, Then no denial without `attorney` review; a request for orders is sent.", () => {
  const r = assertedServiceWithoutEvidence({ written_assertion: true, dmdc_status: "N" }); assert.equal(r.denial_allowed, false); assert.equal(r.escalation!.kind, "attorney"); assert.equal(r.request_orders, true);
  assert.equal(assertedServiceWithoutEvidence({ written_assertion: true, dmdc_status: "N", orders_document_id: "orders-1" }).request_orders, false);
});
test("13.9-T10: Given a request 200 days after release with verified service, Then the cap is applied retroactively for the service period + tail (policy) and Form 1022 sent.", () => {
  const r = lateRequest({ release_on: D("2027-02-28"), request_on: D("2027-09-16"), service_verified: true, service_begin_on: D("2026-03-15"), mbs: false });
  assert.equal(r.statutory, false); assert.equal(r.honored, true); assert.equal(r.cap_from_due, "2026-04-01"); assert.equal(r.cap_ends_on, "2028-02-28"); assert.equal(r.retroactive, true); assert.deepEqual(r.form_1022, { channel: "email_bd9" });
  assert.equal(lateRequest({ release_on: D("2027-02-28"), request_on: D("2027-09-16"), service_verified: false, service_begin_on: D("2026-03-15"), mbs: false }).honored, false);
});
// 13.9-T11 — implemented in src/domain/foreclosure/foreclosure.test.ts

test("13.9 worked figures: P&I $2,046.53; UPB after #24 $293,975.18; forgiven $1,528.30; UPB after #29 $292,606.60; new payment $278.70 + $1,463.03 = $1,741.73 (standard $1,810.42); differential $1,767.83 − $1,463.03 = $304.80; MBS pool interest $1,645.91; shortfall $213.43", () => {
  const upb24 = balanceAfter(30000000n, "7.25", 360, 24); assert.equal(upb24, 29397518n);
  const r = recalculate({ upb_cents: upb24, note_rate_pct: "7.25", pi_cents: 204653n, first_capped_due: D("2026-04-01"), first_n: 25, paid_at_note_rate_count: 5, remaining_term_after: 331 });
  assert.equal(r.forgiven_total_cents, 152830n); assert.equal(r.upb_after_cents, 29260660n); assert.equal(r.next_interest_capped_cents, 146303n); assert.equal(r.next_interest_note_cents, 176783n);
  assert.equal(r.next_payment_subsidy_cents - r.next_interest_capped_cents, 27870n); assert.equal(r.next_payment_subsidy_cents, 174173n); assert.equal(r.next_payment_standard_cents, 181042n); assert.equal(r.fnma_differential_cents, 30480n);
  assert.equal((29260660n * 675n + 60000n) / 120000n, 164591n); assert.equal(servicingFee(r.upb_after_cents, "0.25"), 6096n); assert.equal(174173n - 152830n, 21343n);
});
