// 3.5 Surplus refund
// spec/sections/03-escrow-administration/3-5-surplus-refund.md
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
import { refundDecision, payoffRefundDue, needsDualApproval } from "./refund.ts";
import { scheduleRefund, issueRefund, approveRefund, ledgerBalanced, returnedRefund, staleRefund, creditToNewLoan, retainedSurplus, EscrowEventLedger, type Refund } from "./ops.ts";
import { escrowBus, ESCROW_AGENT, OFFICER_A, OFFICER_B } from "./spec-harness.ts";
import { SYSTEM } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { finalDisbursementHold, payoffRefundCents, unsettledItems, settleFinalDisbursements, inFlight, type InFlightDisbursement } from "./ops-3-5.ts";

test("3.5-T1: Given surplus $143.32, current borrower, as_of 2027-05-16, then timer due 2027-06-15 and a check is issued with ledger entries balanced.", async () => {
  const d = refundDecision(14_332n, 0, D("2027-05-16")); assert.deepEqual(d, { action: "refund", due_on: "2027-06-15" });
  const r = issueRefund(scheduleRefund("L-1", 14_332n, d.due_on!), D("2027-05-22"), "100234");
  assert.equal(r.status, "issued"); assert.deepEqual(r.ledger, [{ dr: "loan.escrow", cr: "custodial_ti_cash", amount_cents: 14_332n }]); assert.equal(ledgerBalanced(r), true);
  // Through the bus with the 3.5 registry timers: the engine's refund decision (surplus $143.32, current) is approved, which arms REGX_1024_17F2_SURPLUS_REFUND_30 on as_of 2027-05-16 → due 2027-06-15; the agent issues the engine's amount and the `disbursement.issued{kind=surplus_refund}` fact satisfies it.
  const bus = escrowBus("L-1", "2027-05-22T15:00:00.000Z", ["3.5"]);
  await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-2027-0516", items: A, year_start: "2027-07-01", as_of: "2027-05-16", projected_actual_cents: 125_000n });
  await bus.run("3.1", "approveAnalysis", ESCROW_AGENT, { analysis_id: "EA-2027-0516" });
  const approved = bus.events.ofType("escrow.analysis.approved")[0]!; assert.deepEqual([approved.payload.decision, approved.payload.surplus_cents, approved.payload.borrower_current, approved.payload.as_of], ["refund", "14332", true, "2027-05-16"]);
  const timer = bus.ctx.timers.byCode("REGX_1024_17F2_SURPLUS_REFUND_30")[0]!; assert.equal(timer.status, "armed"); assert.equal(timer.dueDate, "2027-06-15");
  assert.equal((await bus.refusal("3.5", "issueRefund", ESCROW_AGENT, { analysis_id: "EA-2027-0516", amount_cents: 14_000n, due_on: d.due_on, check_no: "100234", payee_kind: "borrower" }))?.code, "ENGINE_AMOUNT");     // the agent cannot reduce it
  assert.equal((await bus.refusal("3.5", "issueRefund", ESCROW_AGENT, { analysis_id: "EA-2027-0516", amount_cents: 14_332n, due_on: d.due_on, check_no: "100234" }))?.code, "PAYEE_IS_BORROWER");                     // payee must be stated
  assert.equal((await bus.refusal("3.5", "issueRefund", ESCROW_AGENT, { analysis_id: "EA-2027-0516", amount_cents: 14_332n, due_on: d.due_on, check_no: "100234", payee_kind: "third_party" }))?.code, "PAYEE_IS_BORROWER");
  const out = (await bus.run("3.5", "issueRefund", ESCROW_AGENT, { analysis_id: "EA-2027-0516", amount_cents: 14_332n, due_on: d.due_on, check_no: "100234", payee_kind: "borrower" })) as Refund;
  assert.equal(out.status, "issued"); const ev = bus.events.ofType("disbursement.issued"); assert.equal(ev.length, 1); assert.equal(ev[0]!.payload.kind, "surplus_refund"); assert.equal(ev[0]!.payload.amount_cents, "14332");
  assert.equal(timer.status, "satisfied");
  // A shortage decision arms nothing, and a payoff refund of any amount never satisfies the surplus row.
  const short = escrowBus("L-1", "2027-05-22T15:00:00.000Z", ["3.5"]);
  await short.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-S", items: A, year_start: "2027-07-01", as_of: "2027-05-16", projected_actual_cents: 70_000n }); await short.run("3.1", "approveAnalysis", ESCROW_AGENT, { analysis_id: "EA-S" });
  assert.equal(short.ctx.timers.byCode("REGX_1024_17F2_SURPLUS_REFUND_30").length, 0); assert.equal((await short.refusal("3.5", "issueRefund", ESCROW_AGENT, { amount_cents: 1n, payee_kind: "borrower" }))?.code, "ENGINE_AMOUNT");
  const payoff = escrowBus("L-1", "2027-05-22T15:00:00.000Z", ["3.5"]); payoff.events.append({ type: "escrow.analysis.approved", loanId: "L-1", actor: ESCROW_AGENT, payload: { analysis_id: "EA-X", as_of: "2027-05-16", decision: "refund", borrower_current: true, surplus_cents: "14332" } });
  await payoff.run("3.5", "issueRefund", ESCROW_AGENT, { kind: "payoff_refund", amount_cents: 1n, payee_kind: "borrower", state: "TX" });
  assert.equal(payoff.ctx.timers.byCode("REGX_1024_17F2_SURPLUS_REFUND_30")[0]!.status, "armed");
});
test("3.5-T2: Given surplus exactly $50.00, then refund is mandatory; given $49.99, then credit path.", () => {
  assert.equal(refundDecision(5_000n, 0, D("2027-05-16")).action, "refund"); assert.equal(refundDecision(4_999n, 0, D("2027-05-16")).action, "credit");
});
test("3.5-T3: Given `regx_days_delinquent=31` at analysis, then status `retained`, no timer; on reinstatement an interim analysis re-decides.", () => {
  assert.deepEqual(retainedSurplus(30_000n, 31, null), { status: "retained", timer: null, interim_analysis_on: null });
  assert.deepEqual(retainedSurplus(30_000n, 47, D("2027-08-03")), { status: "decided", timer: { due_on: "2027-09-03" }, interim_analysis_on: "2027-08-04" });
});
test("3.5-T4: Given payoff posted Thu 2027-02-11, then due date = 2027-03-12 (Presidents' Day excluded).", async () => {
  assert.equal(payoffRefundDue(D("2027-02-11")), "2027-03-12");
  // Through the bus with the 3.5 registry timers: the 16.2 `loan.paid_in_full{escrowed=true, payoff_date}` arms REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD due Fri 2027-03-12 (20 federal BD; Presidents' Day Mon 2/15 excluded)
  // and the policy gate ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD anchored on the posting date (5 servicer BD → Fri 2027-02-19).
  const bus = escrowBus("L-1", "2027-02-18T15:00:00.000Z", ["3.5"]);
  bus.events.append({ type: "loan.paid_in_full", loanId: "L-1", actor: SYSTEM, payload: { payoff_date: "2027-02-11", escrowed: true, settlement_id: "S-1" } });
  const deadline = bus.ctx.timers.byCode("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD")[0]!; assert.equal(deadline.status, "armed"); assert.equal(deadline.dueDate, "2027-03-12");
  const gate = bus.ctx.timers.byCode("ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2027-02-11"); assert.equal(gate.dueDate, "2027-02-19");
  // Example (b): escrow balance after payoff $612.40, no bills due before payoff. A county-tax item due after the payoff is still `scheduled` → the refund waits (gate unsatisfied, 20-BD deadline not reached).
  const TAX: InFlightDisbursement = { id: "D-tax", kind: "tax", amount_cents: 52_000n, due_on: D("2027-03-01"), status: "scheduled" };
  const input = { kind: "payoff_refund", amount_cents: 61_240n, escrow_balance_after_payoff_cents: 61_240n, payee_kind: "borrower", check_no: "100301" };
  const waiting = await bus.refusal("3.5", "issueRefund", ESCROW_AGENT, { ...input, in_flight: [TAX] });
  assert.equal(waiting?.code, "FINAL_DISBURSEMENTS_UNSETTLED"); assert.match(waiting!.message, /D-tax/); assert.equal(gate.status, "armed");
  assert.equal(bus.events.ofType("escrow.final_disbursements.settled").length, 0); assert.equal(bus.events.ofType("disbursement.issued").length, 0);
  // Cancelled (due on/after payoff) → settled; the engine's refund is the balance (a cancelled item stays in it) and the agent cannot state another amount.
  assert.equal((await bus.refusal("3.5", "issueRefund", ESCROW_AGENT, { ...input, amount_cents: 61_000n, in_flight: [{ ...TAX, status: "cancelled" }] }))?.code, "ENGINE_AMOUNT");
  const out = (await bus.run("3.5", "issueRefund", ESCROW_AGENT, { ...input, in_flight: [{ ...TAX, status: "cancelled" }] })) as Refund;
  assert.equal(out.status, "issued"); assert.equal(out.issued_on, "2027-02-18"); assert.equal(out.amount_cents, 61_240n);           // refund $612.40 issued 2027-02-18
  const settled = bus.events.ofType("escrow.final_disbursements.settled"); assert.equal(settled.length, 1);
  assert.deepEqual([settled[0]!.payload.payoff_date, settled[0]!.payload.cancelled, settled[0]!.payload.released, settled[0]!.payload.refund_cents, settled[0]!.payload.gate_opens_on, settled[0]!.payload.must_issue_by], ["2027-02-11", ["D-tax"], [], "61240", "2027-02-19", "2027-03-12"]);
  assert.equal(eventMatches(loadOverriddenRegistry().get("ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD")!.satisfiedPattern!, settled[0]!), true);
  assert.equal(gate.status, "satisfied"); assert.equal(deadline.status, "satisfied");                   // the hold by the settlement fact, the deadline by `disbursement.issued{kind=payoff_refund}`
  assert.deepEqual(bus.events.ofType("disbursement.issued").map((e) => [e.payload.kind, e.payload.amount_cents]), [["payoff_refund", "61240"]]);
  assert.ok(bus.events.all().findIndex((e) => e.type === "escrow.final_disbursements.settled") < bus.events.all().findIndex((e) => e.type === "disbursement.issued"));   // settled before issued
  // Rule 1 directly: a bill due before payoff must be paid (never cancelled) and, once paid, reduces the refund; a balance short of the paid items is never refunded.
  const INS: InFlightDisbursement = { id: "D-ins", kind: "insurance", amount_cents: 10_000n, due_on: D("2027-02-01"), status: "cancelled" };
  assert.deepEqual(unsettledItems(D("2027-02-11"), [INS, { ...TAX, status: "cancelled" }]).map((d) => d.id), ["D-ins"]);
  assert.equal(payoffRefundCents(61_240n, [{ ...INS, status: "released" }, { ...TAX, status: "cancelled" }]), 51_240n);
  assert.throws(() => payoffRefundCents(5_000n, [{ ...INS, status: "released" }]), /short/);
  assert.throws(() => inFlight([{ id: "x", kind: "tax", amount_cents: 0n, due_on: "2027-03-01" }]), /positive/);
  // Breach column: the refund waits, but never beyond the 20-BD deadline — on 2027-03-12 the still-open item no longer holds it, and no settlement fact is claimed.
  const hold = finalDisbursementHold({ payoff_date: D("2027-02-11"), today: D("2027-03-11"), in_flight: [TAX] });
  assert.deepEqual([hold.gate_opens_on, hold.must_issue_by, hold.settled, hold.hold_elapsed, hold.refund_may_issue, hold.reason, hold.unsettled], ["2027-02-19", "2027-03-12", false, true, false, "waiting", ["D-tax"]]);
  assert.equal(finalDisbursementHold({ payoff_date: D("2027-02-11"), today: D("2027-03-12"), in_flight: [TAX] }).reason, "deadline");
  const late = escrowBus("L-1", "2027-03-12T15:00:00.000Z", ["3.5"]);
  assert.throws(() => settleFinalDisbursements(late.events, { loan_id: "L-1", payoff_date: D("2027-02-11"), today: D("2027-03-11"), escrow_balance_after_payoff_cents: 61_240n, in_flight: [TAX], actor: SYSTEM }), /waits/);
  const forced = settleFinalDisbursements(late.events, { loan_id: "L-1", payoff_date: D("2027-02-11"), today: D("2027-03-12"), escrow_balance_after_payoff_cents: 61_240n, in_flight: [TAX], actor: SYSTEM });
  assert.deepEqual([forced.event_type, forced.forced_by_deadline, forced.refund_cents], [null, true, 61_240n]); assert.equal(late.events.ofType("escrow.final_disbursements.settled").length, 0);
});
test("3.5-T5: Given payoff posted Fri 2027-12-24 (Christmas observed 12/24? — federal holiday 12/25 falls on Saturday, observed Fri 12/24), then day count starts Mon 12/27 and excludes 2028-01-17 (MLK); due date computed by the calendar service equals the hand-count.", () => {
  assert.equal(payoffRefundDue(D("2027-12-24")), "2028-01-25");                     // count starts Mon 12/27, excludes MLK 2028-01-17
});
test("3.5-T6: Given borrower oral consent (recorded call) to credit $612.40 to a new same-servicer loan settling 2027-03-01, then no check is issued and the inter-loan ledger transfer posts on settlement.", () => {
  const r = scheduleRefund("L-1", cents("612.40"), D("2027-03-12"));
  const c = creditToNewLoan(r, { recorded_call_id: "call-77", given_on: D("2027-02-15") }, { id: "L-2", settles_on: D("2027-03-01") });
  assert.deepEqual(c, { check_issued: false, posts_on: "2027-03-01", ledger: { dr: "L-1.escrow", cr: "L-2.escrow", amount_cents: 61_240n } }); assert.equal(r.status, "credited_to_new_loan");
  assert.throws(() => creditToNewLoan(scheduleRefund("L-1", 1n, D("2027-03-12")), { recorded_call_id: "c", given_on: D("2027-03-05") }, { id: "L-3", settles_on: D("2027-03-01") }), /on\/after the consent date/);
});
test("3.5-T7: Given a check returned undeliverable on day 25, then address verification and reissue occur before day 30 or the breach is logged with evidence of attempts.", () => {
  const ok = issueRefund(scheduleRefund("L-1", 14_332n, D("2027-06-15")), D("2027-05-22"), "1");
  const a = returnedRefund(ok, D("2027-06-10"), D("2027-06-12"), D("2027-06-14"));       // day 25 → verified → reissued before day 30
  assert.equal(a.status, "reissued"); assert.equal(a.breach_logged, false); assert.deepEqual(a.evidence.map((e) => e.kind), ["check", "returned", "address_verified", "reissued"]);
  const late = returnedRefund(issueRefund(scheduleRefund("L-1", 14_332n, D("2027-06-15")), D("2027-05-22"), "2"), D("2027-06-10"), D("2027-06-12"), null);
  assert.equal(late.breach_logged, true); assert.equal(late.evidence.length, 3);
});
test("3.5-T8: Given a check uncashed at 180 days, then outreach notice is sent and the state escheat timer starts.", () => {
  const r = issueRefund(scheduleRefund("L-1", 14_332n, D("2027-06-15")), D("2027-05-22"), "3");
  assert.equal(staleRefund(r, D("2027-11-17"), 3).outreach_notice, false);
  const s = staleRefund(r, D("2027-11-18"), 3);
  assert.deepEqual(s, { status: "outreach", outreach_notice: true, escheat_starts_on: "2027-11-18", escheat_due_on: "2030-11-18" });
});
test("3.5-T9: Given refund $30,000 (large overfunded account), then `officer` dual approval is required before issuance and the 30-day timer still governs.", async () => {
  assert.equal(needsDualApproval(cents("30000")), true); assert.equal(needsDualApproval(cents("25000")), false); assert.equal(needsDualApproval(cents("100"), true), true);   // > $25,000, or a newly changed address
  const r = scheduleRefund("L-1", cents("30000"), D("2027-06-15"));
  assert.throws(() => issueRefund(r, D("2027-05-22"), "9"), /dual approval/);
  approveRefund(r, OFFICER_A); assert.throws(() => approveRefund(r, OFFICER_A), /same officer/); approveRefund(r, OFFICER_B);
  assert.equal(issueRefund(r, D("2027-05-22"), "9").status, "issued"); assert.equal(r.due_on, "2027-06-15");
  // Through the bus (3.5 guardrail DUAL_APPROVAL): the agent's approvals are actors; two non-officers, one officer, or the same officer twice are refused before anything runs.
  const bus = escrowBus("L-1", "2027-05-22T15:00:00.000Z"); const input = { analysis_id: "EA-30K", amount_cents: cents("30000"), due_on: "2027-06-15", check_no: "9", payee_kind: "borrower" };
  bus.events.append({ type: "escrow.analysis.approved", loanId: "L-1", actor: ESCROW_AGENT, payload: { analysis_id: "EA-30K", as_of: "2027-05-16", decision: "refund", borrower_current: true, surplus_cents: "3000000" } });   // the engine's $30,000 surplus
  for (const approvals of [[{ kind: "human", id: "anyone-a" }, { kind: "human", id: "anyone-b" }], [OFFICER_A], [OFFICER_A, OFFICER_A], [{ kind: "agent", id: "escrow", role: "officer" }, OFFICER_B]]) {
    const refused = await bus.refusal("3.5", "issueRefund", ESCROW_AGENT, { ...input, approvals });
    assert.equal(refused?.code, "DUAL_APPROVAL", JSON.stringify(approvals)); assert.equal(bus.rt.store.get("refunds", "L-1:2027-06-15"), undefined); assert.equal(bus.events.ofType("disbursement.issued").length, 0);
  }
  const issued = (await bus.run("3.5", "issueRefund", ESCROW_AGENT, { ...input, approvals: [OFFICER_A, OFFICER_B] })) as Refund;
  assert.equal(issued.status, "issued"); assert.deepEqual(issued.approvals, [{ by: "u-officer-a", role: "officer" }, { by: "u-officer-b", role: "officer" }]); assert.equal(issued.due_on, "2027-06-15");
  assert.equal(bus.events.ofType("disbursement.issued").length, 1); assert.equal(bus.events.ofType("command.refused").length, 4);
  const small = escrowBus("L-1", "2027-05-22T15:00:00.000Z");                                                   // ≤ $25,000 to an unchanged address needs no dual approval
  small.events.append({ type: "escrow.analysis.approved", loanId: "L-1", actor: ESCROW_AGENT, payload: { analysis_id: "EA-25K", as_of: "2027-05-16", decision: "refund", borrower_current: true, surplus_cents: "2500000" } });
  assert.equal(((await small.run("3.5", "issueRefund", ESCROW_AGENT, { analysis_id: "EA-25K", amount_cents: cents("25000"), due_on: "2027-06-15", check_no: "10", payee_kind: "borrower" })) as Refund).status, "issued");
});
test("3.5-T10: Given a Fannie Mae escrow disbursement event rejected for balance mismatch, then the event is corrected and resubmitted before 3:00 a.m. ET next BD (3.7).", () => {
  const led = new EscrowEventLedger(110_668n);
  const e = led.emit("Loan Taxes and Insurance refund", -14_332n, D("2027-05-22")); e.status = "rejected";
  const fixed = led.correct(e.sequence, { balance_cents: 96_336n }, D("2027-05-24"));
  assert.equal(e.status, "corrected"); assert.equal(fixed.sequence, e.sequence); assert.equal(fixed.corrects, e.sequence); assert.equal(fixed.status, "queued");
  assert.equal(fixed.deadline_at, "2027-05-25");                                   // before 03:00 ET next Fannie Mae BD (3.7)
});
