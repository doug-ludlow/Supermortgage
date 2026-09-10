/** §1.2–1.7 and §17.1–17.4 acceptance tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { cents } from "../../kernel/money/cents.ts";
import * as B from "./batch.ts"; import * as R from "./respa.ts"; import * as CM from "./custody-mers.ts"; import * as RC from "./reconciliation.ts"; import * as LM from "./lossmit-inflight.ts";

test("1.2-T1/T2/T3 and 17.1-T1/T2/T3/T6/T7: transfer-date gate, Form 629 30/60-day clocks, Quick Exchange cadence, Form 101 termination", () => {
  assert.equal(B.firstFannieBusinessDay(D("2026-10-15")), "2026-10-01"); assert.equal(B.firstFannieBusinessDay(D("2026-11-15")), "2026-11-02"); assert.equal(B.transferDateGate(D("2026-10-02")).ok, false); assert.equal(B.transferDateGate(D("2026-12-01")).ok, true);
  const c = B.form629Clocks("master_to_sub", D("2026-10-01")); assert.deepEqual([c.deadline, c.internal_buffer, c.rule], ["2026-09-01", "2026-08-25", "30_day_subservicing"]);
  const s = B.form629Clocks("servicing_sale", D("2026-10-01"), D("2026-09-15")); assert.equal(s.deadline, "2026-07-17"); assert.equal(s.liability_start, "2026-09-15");
  const d = B.form629Clocks("sub_to_sub", D("2026-12-01")); assert.deepEqual([d.deadline, d.internal_buffer], ["2026-11-01", "2026-10-25"]); assert.equal(B.form629Clocks("servicing_sale", D("2026-12-01"), D("2026-11-16")).deadline, "2026-09-17");
  const qx = B.quickExchangeCadence(D("2026-12-01")); assert.deepEqual([qx.adds_by, qx.reconciliation_by, qx.attestation_by, qx.processing_on, qx.portal_task_on], ["2026-11-10", "2026-11-20", "2026-11-25", "2026-12-03", "2026-10-30"]);
  assert.equal(B.respaNoticeRequired("master_change_sub_retained", { payee: true, address: true, account: true, amount: true }), false); assert.equal(B.respaNoticeRequired("sub_to_sub", { payee: true, address: true, account: true, amount: true }), true);
  assert.equal(B.form101TerminationDue(D("2026-12-01")), "2026-12-08"); assert.equal(B.saleArrangementDue(D("2026-10-01")), "2026-12-30");
});

test("1.3-T1/T2/T3/T5/T6/T7 and 17.2-T1/T2/T4/T5/T7/T8: RESPA dates, effective-date override, protected payments, ACH cancel", () => {
  const n = R.noticeDates(D("2026-10-01")); assert.deepEqual([n.goodbye_due, n.hello_due, n.window_end, n.transferor_stops], ["2026-09-16", "2026-10-16", "2026-11-29", "2026-09-30"]);
  const n2 = R.noticeDates(D("2026-11-02")); assert.deepEqual([n2.goodbye_due, R.runScheduledOn(n2.goodbye_due), n2.hello_due, n2.window_end], ["2026-10-18", "2026-10-16", "2026-11-17", "2026-12-31"]);
  assert.equal(R.respaEffectiveDate(D("2026-11-02"), true), "2026-11-01"); assert.equal(R.respaEffectiveDate(D("2026-11-02"), false), "2026-11-02"); assert.equal(R.respaEffectiveDate(D("2026-12-01"), true), "2026-12-01");
  const n3 = R.noticeDates(R.respaEffectiveDate(D("2026-11-02"), true)); assert.equal(n3.goodbye_due, "2026-10-17"); assert.equal(R.runScheduledOn(n3.goodbye_due), "2026-10-16"); assert.equal(n3.window_end, "2026-12-30");
  const n4 = R.noticeDates(D("2026-12-01")); assert.deepEqual([n4.goodbye_due, n4.window_end, n4.short_year_statement_due, R.runScheduledOn(n4.short_year_statement_due)], ["2026-11-16", "2027-01-29", "2027-01-30", "2027-01-29"]);
  assert.deepEqual(R.protectedPayment(D("2026-10-14"), D("2026-10-01"), 15, D("2026-10-01")), { protected: true, credited_as_of: "2026-10-14" }); assert.equal(R.protectedPayment(D("2026-10-20"), D("2026-10-01"), 15, D("2026-10-01")).protected, false); assert.equal(R.protectedPayment(D("2026-11-30"), D("2026-12-01"), 15, D("2026-10-01")).protected, false); assert.equal(R.protectedPayment(D("2026-11-29"), D("2026-12-01"), 15, D("2026-10-01")).protected, true);   // day 61 vs day 60 (window_end Nov 29), same due date and grace
  assert.equal(R.protectedPayment(D("2026-12-14"), D("2026-12-01"), 15, D("2026-12-01")).protected, true); assert.equal(R.forwardBy(D("2026-12-20")), "2026-12-21");
  assert.deepEqual(R.contentCheck(["effective_date", "transferee_block", "transferor_block", "transferee_tollfree", "stop_start_dates", "insurance_paragraph", "servicing_terms_only", "ms2_60_day_sentence"]).missing, ["transferor_tollfree"]);
  assert.equal(R.achCancelBy(D("2026-12-01")), "2026-11-25"); assert.equal(R.correctiveNoticeDue(D("2026-11-20")), "2026-11-27"); assert.equal(R.skipTraceDue(D("2026-10-20")), "2026-10-27");
});

test("1.4-T1/T2/T3/T4/T5/T8/T9 and 1.5-T1/T3/T5/T6/T7: custody recert clocks, assignment logic, HF-018, Form 2009, MERS transactions and integrity", () => {
  assert.deepEqual(CM.recertDeadline(D("2026-10-01"), "D"), { deadline: "2027-04-01", extension_request_by: "2027-03-17" }); assert.equal(CM.recertDeadline(D("2026-10-01"), "I").deadline, "2026-10-31");
  const ck = CM.custodyClocks(D("2026-10-01"), D("2026-10-15")); assert.deepEqual([ck.trial_balance_by, ck.recert_start_by, ck.missing_docs_notice_by, ck.own_exception_review_by], ["2026-10-31", "2026-10-25", "2026-11-14", "2026-11-04"]);
  assert.equal(CM.assignmentAction({ mers_registered: true, assignment_to_fnma_recorded: false }), "min_update_only"); assert.equal(CM.assignmentAction({ mers_registered: false, assignment_to_fnma_recorded: false }), "record_assignment_to_transferee");
  assert.equal(CM.custodyOk({ custodian: null, certification_status: null, enote_controller: null }), false); assert.equal(CM.custodyOk({ custodian: null, certification_status: null, enote_controller: "FNMA" }), true);
  assert.equal(CM.form2009Overdue(D("2026-07-01"), D("2026-09-30"), false), true); assert.equal(CM.form2009Overdue(D("2026-07-01"), D("2026-09-29"), false), false);
  assert.equal(CM.mersTransaction("master_to_sub"), "min_update_subservicer"); assert.equal(CM.mersTransaction("servicing_sale_with_sub"), "tos_seller_initiated"); assert.equal(CM.mersTransaction("custodian_only"), "none");
  assert.deepEqual(CM.mersIntegrity({ borrower: "A", property: "1 Main", subservicer: "X" }, { borrower: "A", property: "2 Main", subservicer: "Y" }, ["subservicer"]), ["property"]);
  const mc = CM.mersClocks(D("2026-10-01")); assert.deepEqual([mc.batch_submit_on, mc.verify_by, mc.registration_due_for_unregistered], ["2026-09-30", "2026-10-06", "2026-10-08"]); assert.equal(CM.violationResponseDue(D("2026-11-10")), "2026-12-10");
});

test("1.6-T1/T2/T5/T6/T7/T8/T10 and 17.3-T1/T2: wires (276,265 / 238,300; out: 276,572 / 238,300 / 541,109), variances, escrow continuity, schedule", () => {
  const L1 = { upb_cents: 24_563_412n, escrow_cents: 184_250n, unapplied_cents: 32_500n, corporate_advances_cents: 15_000n, late_charges_cents: 6_464n };
  const L2 = { upb_cents: 18_020_000n, escrow_cents: -41_300n, unapplied_cents: 0n, corporate_advances_cents: 0n, late_charges_cents: 0n };
  const L3 = { upb_cents: 31_100_055n, escrow_cents: 92_015n, unapplied_cents: 0n, corporate_advances_cents: 0n, late_charges_cents: 0n, unremitted_pi_cents: 205_800n };
  const inb = RC.expectedWires([L1, L2, L3]); assert.deepEqual([inb.ti_wire_cents, inb.pi_wire_cents, inb.escrow_advances_receivable_cents], [276_265n, 238_300n, 41_300n]);
  const v = RC.wireVariance(238_300n, 238_000n, "pi", D("2026-10-02")); assert.equal(v.variance_cents, -300n); assert.equal(v.sla_due, "2026-10-09"); assert.equal(v.blocks_wires_matched, true);
  assert.equal(RC.absorbGate(500_100n, false), false); assert.equal(RC.absorbGate(500_100n, true), true); assert.equal(RC.absorbGate(499_900n, false), true); assert.equal(RC.absorbGate(500_000n, false), false); assert.equal(RC.absorbGate(2_500n, false, "loan"), false);
  assert.deepEqual(RC.escrowContinuity(true, true, D("2026-10-01")), { initial_statement_due: null, computation_year_start: "retained" }); assert.deepEqual(RC.escrowContinuity(false, true, D("2026-10-01")), { initial_statement_due: "2026-11-30", computation_year_start: "2026-10-01" });
  assert.equal(RC.finalAccountingDue(D("2026-10-01")), "2026-10-31"); assert.equal(RC.fnmaPositionLagDeadline(D("2026-10-01")), "2026-10-30"); assert.equal(RC.lateChargeReceivable(cents("1616.03"), "4"), 6_464n);
  const out = RC.expectedWires([{ ...L1, escrow_interest_rate_pct: "2" }, { ...L2, pi_advances_cents: 484_809n }, { upb_cents: 31_100_055n, escrow_cents: 92_015n, unapplied_cents: 0n, corporate_advances_cents: 0n, late_charges_cents: 0n, prepaid_next_period_pi_cents: 205_800n }], true);
  assert.deepEqual([out.ti_wire_cents, out.pi_wire_cents, out.final_accounting_receivable_cents], [276_572n, 238_300n, 541_109n]);
  const sch = RC.outboundSchedule(D("2026-12-01")); assert.deepEqual([sch.test_tape_by, sch.preliminary_by, sch.counterparties_by, sch.final_tape_by, sch.images_by, sch.final_period_close, sch.fnma_processes_on, sch.final_accounting_by, sch.mi_notice_by, sch.support_window_end, sch.noe_rfi_tail_end], ["2026-11-01", "2026-11-17", "2026-11-30", "2026-12-02", "2026-12-08", "2026-12-02 17:00 ET", "2026-12-03", "2026-12-31", "2027-01-30", "2027-03-01", "2027-12-01"]);
  assert.equal(toIso(RC.finalPeriodCloseMs(D("2026-12-01"))), toIso(zonedEpochMs(D("2026-12-02"), "17:00", "America/New_York"))); assert.equal(RC.transfereeRequestDue(D("2026-12-10")), "2026-12-17");
});

test("1.7-T1/T2/T3/T4/T5/T6/T8 and 17.4-T1/T2/T3/T6/T9: (k) clocks (Oct 16 / Oct 31 / Nov 4 / Oct 8), first-filing gate, offer honoring, forbearance carry-over", () => {
  assert.equal(LM.transfereeAckDue(D("2026-10-01"), true), "2026-10-16"); assert.equal(LM.transfereeAckDue(D("2026-10-01"), false), "2026-10-08"); assert.equal(LM.deemedReceived(D("2026-09-29"), false, D("2026-10-01")), "2026-10-01");
  assert.equal(LM.transfereeEvaluationDue(D("2026-10-01")), "2026-10-31"); assert.equal(LM.transfereeAppealDue(D("2026-10-01"), D("2026-10-05")), "2026-11-04");
  assert.equal(LM.honorTransferorOffer(D("2026-10-07"), D("2026-10-09")), "honor_no_reunderwrite"); assert.equal(LM.honorTransferorOffer(D("2026-10-10"), D("2026-10-09")), "expired");
  const g = LM.firstFilingGate(D("2026-10-24"), D("2026-10-20")); assert.equal(g.ok, false); assert.equal(g.allowed_from, "2026-10-25"); assert.equal(LM.firstFilingGate(D("2026-10-24"), D("2026-10-25")).ok, true);
  assert.deepEqual(LM.forbearanceCarryover(9, 3), { allowed_months: 3, exception_required: false }); assert.deepEqual(LM.forbearanceCarryover(12, 3), { allowed_months: 0, exception_required: true });
  const tc = LM.transferorClocks(D("2026-11-25"), D("2026-12-01")); assert.equal(tc.ack_due, "2026-12-03"); assert.equal(tc.ack_target, "2026-11-30"); assert.equal(tc.handoff_if_unsent, true); assert.equal(LM.transfereeAckDue(D("2026-12-01"), true), "2026-12-15");
  assert.equal(LM.transfereeEvaluationDue(D("2026-12-01")), "2026-12-31"); assert.equal(LM.transfereeAppealDue(D("2026-12-01"), D("2026-11-20")), "2026-12-31");
  assert.equal(LM.transferorContinuesGate("transfer_out").ok, false); assert.equal(LM.documentRequestOrder(false), "ask_transferor");
});
