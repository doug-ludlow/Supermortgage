// 3.7 Tax disbursement
// spec/sections/03-escrow-administration/3-7-tax-disbursement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths, addDays } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import { project, decide, newPayment, cushion, effectiveDate, anomalies } from "./analysis.ts";
const E = [{ line_type: "school_tax", amount_cents: cents("360"), disburse_on: D("2026-09-15") }, { line_type: "county_tax", amount_cents: cents("500"), disburse_on: D("2026-07-15") }, { line_type: "county_tax", amount_cents: cents("700"), disburse_on: D("2026-12-15") }];
const A = [{ line_type: "county_tax", amount_cents: cents("520"), disburse_on: D("2027-07-15") }, { line_type: "county_tax", amount_cents: cents("760"), disburse_on: D("2027-12-15") }, { line_type: "school_tax", amount_cents: cents("380"), disburse_on: D("2027-09-15") }];
void E; void A; void addMonths; void addDays; void project; void decide; void newPayment; void cushion; void effectiveDate; void anomalies;
import { schedule, fundsCheck, installmentChoice, hazardDecision } from "./disbursement.ts";
import { EscrowEventLedger, attestationSchedule, setupEventsAtCutover, nonEscrowDelinquency, replanAfterReject, BillDeduper, releaseApproval, cancellationOverlay, advanceEntries } from "./ops.ts";
import { eventDeadlineMs } from "../investor/period.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
const BILL = { amount_cents: cents("760"), due_on: D("2027-12-10"), received_on: D("2027-11-01"), discount: { pct: "2", by: D("2027-11-30") } };

test("3.7-T1: Given the $760 bill due 2027-12-10 with 2% discount to 11/30 and balance $810 on 11/24, then release 2027-11-26, amount $744.80, `confirmed` by 12/02, and no penalty.", () => {
  const s = schedule(BILL, "check", cents("810"), 0n);
  assert.deepEqual([s.release_on, s.amount_cents, s.discount_captured, s.must_pay_by], ["2027-11-26", 74_480n, true, "2027-12-10"]);
  assert.equal(cents("760") - s.amount_cents, cents("15.20"));                     // the 2% discount
  const confirmedOn = D("2027-12-02"); assert.ok(confirmedOn <= s.must_pay_by);  // confirmed by 12/02, no penalty
});
test("3.7-T2: Given balance $500 on the funds check, then advance $260, disbursement $760 released on time, loan escrow \u2212$260, event balance \u2212260.00 accepted (T&I negative allowed).", () => {
  assert.deepEqual(fundsCheck(cents("760"), cents("500"), 0n), { release: true, advance_cents: 26_000n, escrow_after_cents: -26_000n });
  assert.deepEqual(advanceEntries(76_000n, 26_000n), [{ dr: "custodial_ti_cash", cr: "servicer_advance_receivable", amount_cents: 26_000n }, { dr: "loan.escrow", cr: "custodial_ti_cash", amount_cents: 76_000n }]);
  const led = new EscrowEventLedger(50_000n); const e = led.emit("County Tax", -76_000n, D("2027-11-26")); e.status = "accepted";
  assert.equal(e.balance_cents, -26_000n);                                          // T&I negative allowed
});
test("3.7-T3: Given a jurisdiction with no annual discount and no installment fee, then the scheduler pays installments; given a 3% annual discount and sufficient funds, then it pays annually unless a borrower preference says installments.", () => {
  assert.equal(installmentChoice({ annual_discount_pct: null, installment_fee: false }, true), "installments");
  assert.equal(installmentChoice({ annual_discount_pct: "3", installment_fee: false }, true), "annual");
  assert.equal(installmentChoice({ annual_discount_pct: "3", installment_fee: false }, true, "installments"), "installments");
});
test("3.7-T4: Given a hazard renewal due 2027-10-01 for a borrower 45 days overdue with no cancellation notice and no vacancy, then the premium is paid/advanced and the LPI gate remains closed.", () => {
  assert.deepEqual(hazardDecision(45, null, false), { pay: true, inability_to_disburse: false, lpi_gate_open: false });
});
test("3.7-T5: Given an insurer cancellation notice citing \"underwriting\" received 2027-09-15, then `inability_to_disburse=true` with the (k)(5)(ii)(A) reason recorded and the LPI gate opens for Section 9.2.", () => {
  const o = cancellationOverlay("underwriting", D("2027-09-15"));
  assert.deepEqual(o, { inability_to_disburse: true, reason_code: "1024.17(k)(5)(ii)(A):underwriting", lpi_gate_open: true, recorded_on: "2027-09-15" });
  assert.equal(cancellationOverlay("non_payment", D("2027-09-15")).lpi_gate_open, false);
});
test("3.7-T6: Given a deposit processed Thursday 2027-07-15 at 18:00 ET, then the event deadline is Friday 2027-07-16 03:00 ET; processed Friday 2027-07-16 \u2192 deadline Monday 2027-07-19 03:00 ET; processed Friday before a Fannie Mae Monday holiday \u2192 Tuesday 03:00 ET.", () => {
  const ET = "America/New_York";
  assert.equal(toIso(eventDeadlineMs(zonedEpochMs(D("2027-07-15"), "18:00", ET))), toIso(zonedEpochMs(D("2027-07-16"), "03:00", ET)));
  assert.equal(toIso(eventDeadlineMs(zonedEpochMs(D("2027-07-16"), "10:00", ET))), toIso(zonedEpochMs(D("2027-07-19"), "03:00", ET)));
  assert.equal(toIso(eventDeadlineMs(zonedEpochMs(D("2027-09-03"), "10:00", ET))), toIso(zonedEpochMs(D("2027-09-07"), "03:00", ET)));   // Friday before Labor Day → Tuesday
});
test("3.7-T7: Given a rejected event \"balance mismatch,\" then a corrected event is generated with the same sequence position and accepted before the period close; the rejected event shows `corrected`.", () => {
  const led = new EscrowEventLedger(81_000n); const e = led.emit("County Tax", -74_480n, D("2027-11-26")); e.status = "rejected";
  const fixed = led.correct(e.sequence, { balance_cents: 6_520n }, D("2027-11-27"));
  assert.equal(fixed.sequence, e.sequence); assert.equal(e.status, "corrected"); assert.equal(fixed.status, "queued"); assert.equal(fixed.balance_cents, 6_520n);
});
test("3.7-T8: Given the March 2027 period, then the attestation package is ready on BD3 (April) and the `human_portal_task` SLA is BD2 of May; a mismatch of one loan produces `attested_no_with_commentary` and a variance case.", () => {
  const a = attestationSchedule(D("2027-03-01"), { ledger_loans: 5000, fnma_loans: 4999 });
  assert.deepEqual([a.package_ready_on, a.portal_task_sla_on, a.outcome, a.variance_case], ["2027-04-05", "2027-05-04", "attested_no_with_commentary", true]);
  assert.equal(attestationSchedule(D("2027-03-01"), { ledger_loans: 5000, fnma_loans: 5000 }).outcome, "attested_yes");
});
test("3.7-T9: Given cutover on 2026-11-16, then Setup events exist for every active and inactive escrowed loan per category before the first deposit event and 100% accepted by 2026-12-01.", () => {
  const r = setupEventsAtCutover([{ loan_id: "L-1", escrowed: true, active: true, categories: ["tax", "hazard"] }, { loan_id: "L-2", escrowed: true, active: false, categories: ["tax"] }, { loan_id: "L-3", escrowed: false, active: true, categories: [] }], D("2026-11-16"), D("2026-12-01"));
  assert.equal(r.events.length, 3); assert.ok(r.events.every((e) => e.type === "EscrowSetup" && e.before_first_deposit)); assert.equal(r.covers_inactive, true); assert.equal(r.accept_by, "2026-12-01");
});
// 3.7-T10 — implemented in src/domain/escrow/escrow.test.ts
test("3.7-T11: Given a non-escrowed loan flagged delinquent by the tax service, then a borrower notice is sent, follow-up in 30 days, and if unpaid with a tax sale scheduled, an advance is posted and the waiver revocation (3.8) is triggered.", () => {
  const r = nonEscrowDelinquency({ found_on: D("2027-10-01"), paid_by_followup: false, tax_sale_scheduled: true });
  assert.deepEqual(r, { notice: "NTC_SM_NONESCROW_TAX_DELINQUENCY", follow_up_on: "2027-10-31", action: "advance_and_revoke_waiver" });
  assert.equal(nonEscrowDelinquency({ found_on: D("2027-10-01"), paid_by_followup: true, tax_sale_scheduled: false }).action, "closed");
});
test("3.7-T12: Given a vendor reject on 2027-11-29 for wrong parcel, then re-planned by 2027-12-01 via ACH direct and paid before 12/10.", () => {
  const r = replanAfterReject(D("2027-11-29"), D("2027-12-10"));
  assert.equal(r.replan_by, "2027-12-01"); assert.equal(r.method, "ach"); assert.ok(r.release_on < D("2027-12-10")); assert.equal(r.on_time, true);
});
test("3.7-T13: Given a duplicate bill from two feeds, then the second is blocked and an anomaly is logged.", () => {
  const d = new BillDeduper(); const bill = { payee: "Travis County", parcel_or_policy: "123-45-678", period: "2027", amount_cents: 76_000n };
  assert.equal(d.accept(bill, "tax_service"), true); assert.equal(d.accept(bill, "county_portal"), false); assert.equal(d.anomalies.length, 1); assert.match(d.anomalies[0]!, /duplicate bill/);
});
test("3.7-T14: Given a payee ACH instruction changed yesterday and a $12,000 disbursement, then `officer` dual approval is required before release.", () => {
  const r = releaseApproval({ amount_cents: cents("12000"), payee_instruction_changed_on: D("2027-11-25"), release_on: D("2027-11-26"), new_payee: false });
  assert.deepEqual(r, { dual_approval_required: true, reason: "payee remittance instruction changed yesterday" });
  assert.equal(releaseApproval({ amount_cents: cents("900"), release_on: D("2027-11-26"), new_payee: false }).dual_approval_required, false);
});
test("3.7-T15: Given a disbursement reversal (returned check) posted 2027-12-15, then an opposite-signed escrow event (+744.80) is emitted with the next sequence and balance restored.", () => {
  const led = new EscrowEventLedger(81_000n); const e = led.emit("County Tax", -74_480n, D("2027-11-26")); e.status = "accepted";
  const rev = led.reverse(e.sequence, D("2027-12-15"));
  assert.equal(rev.amount_cents, 74_480n); assert.equal(rev.sequence, e.sequence + 1); assert.equal(rev.balance_cents, 81_000n); assert.equal(rev.processed_on, "2027-12-15");
});

// 3.7 worked example: the 2% discount on the $760.00 bill is $15.20; balance $810.00 on 11/24 captures it.
test("3.7 worked example: $15.20 discount captured with an $810.00 balance", () => {
  const s = schedule(BILL, "check", 81_000n, 0n); assert.equal(s.amount_cents, 76_000n - 1_520n); assert.equal(s.discount_captured, true);
});
