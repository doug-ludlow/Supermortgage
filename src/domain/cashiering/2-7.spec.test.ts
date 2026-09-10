// 2.7 Late charge assessment
// spec/sections/02-payment-processing-cashiering/2-7-late-charge-assessment.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { CashieringService } from "./service.ts";
import type { LoanCashState } from "./types.ts";
const AGENT = { kind: "agent" as const, id: "cashiering" };
function L1(o: Partial<LoanCashState> = {}, firstDue = D("2026-09-01"), n = 4): LoanCashState {
  const installments = Array.from({ length: n }, (_, i) => ({ due_date: addMonths(firstDue, i), pi_cents: 158_017n, escrow_cents: 61_240n, status: "due" as const }));
  return { loan_id: "L-1", instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: 24_977_400n, lpi_date: D("2026-08-01"), installments,
    late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false, late_charge_pct: "5", late_charge_grace_days: 15, fees: [], overlays: [], ...o };
}
function harness(nowIso: string, loan: LoanCashState) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const store = new Map<string, LoanCashState>([[loan.loan_id, loan]]);
  const svc = new CashieringService({ events, ledger, clock, loans: { get: (id) => store.get(id), put: (s) => store.set(s.loan_id, s) }, custodial: { clearing: "C-CLR", pi: "C-PI", ti: "C-TI" } });
  const pay = (amount: bigint, on: string, extra: Record<string, unknown> = {}) => {
    const p = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: amount, received_at: `${on}T14:00:00.000Z`, loan_id: loan.loan_id, source_item_id: `${on}-${amount}`, ...extra }).payment;
    svc.identify(p.id, loan.loan_id); return svc.post(p.id);
  };
  return { clock, events, ledger, svc, pay, state: () => store.get(loan.loan_id)! };
}
void AGENT; void harness; void L1;
import { lateChargeTerms, collectedForPeriod, assessLateCharge, graceEndFor, lateFeeDisclosure, nsfFee, recordFee, reverseOnRedate } from "./latecharges.ts";
import type { Fee } from "./types.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { CashieringOps } from "./ops.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { NoticeRegistry } from "../../notices/registry.ts";
import { publishSection02 } from "../../notices/authored/section02.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
const OFFICER = { kind: "human" as const, id: "u-officer", role: "officer" };
import { receivedTowardBasis } from "./latecharges.ts";
import { LateChargeOps } from "./ops-2-7.ts";
import { eventMatches } from "../../kernel/events/match.ts";
/** Engine harness without payments: the 2.7 timers armed from the overridden registry, the process ops over one loan state. */
function lc(nowIso: string, state: LoanCashState, processes: readonly string[] = ["2.7"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes });
  return { clock, events, timers, ops: new LateChargeOps({ events, clock }), state };
}

test("2.7-T1: Given fixture L-1 unpaid at 2026-09-16 23:59, when the run executes 2026-09-17, then a 7,901¢ late charge is assessed once with `grace_end_on` 2026-09-16 and appears on the reminder by 09-20.", () => {
  const clock = new FixedClock("2026-09-17T05:30:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.7"] });
  const lcOps = new LateChargeOps({ events, clock }); const ops = lcOps.ops;
  const s = L1();
  // 2026-09-01: the installment reaches its due date → `installment.due_date_reached{grace_end_on}` arms the note's grace gate anchored on the 09-16 grace end (Wednesday, no roll)
  lcOps.installmentDue(s, D("2026-09-01"), D("2026-09-01"));
  const grace = timers.byCode("NOTE_6A_LATE_CHARGE_GRACE_GATE")[0]!; assert.equal(grace.status, "armed"); assert.equal(grace.anchorDate, "2026-09-16"); assert.equal(grace.note, "evaluator:2.7.graceGateOpen");
  assert.equal(events.ofType("installment.due_date_reached")[0]!.payload.late_fee_amount_if_unpaid, "7901");
  // unpaid at 2026-09-16 23:59: the 00:30 run on 09-17 (the day after the grace end) derives the credited-funds test from the state (nothing credited) and assesses
  const day = lcOps.dailyRun(s, D("2026-09-17")); assert.equal(day.decisions.length, 1); assert.deepEqual(day.due_reached, []);
  const a = day.decisions[0]!;
  assert.equal(events.ofType("late_charge.assessment.run")[0]!.payload.received_toward_basis_cents, "0"); assert.equal(events.ofType("late_charge.assessment.run")[0]!.payload.received_derived_from_state, true);
  assert.equal(a.outcome, "assessed"); if (a.outcome === "assessed") { assert.equal(a.fee.amount_cents, 7_901n); assert.equal(a.fee.grace_end_on, "2026-09-16"); assert.equal(a.fee.assessed_on, "2026-09-17"); }   // round_half_up(0.05 × 158,017) = 7,901¢
  assert.equal(s.late_charges_due_cents, 7_901n); assert.equal(s.fees!.length, 1);
  assert.equal(events.ofType("fee.assessed").length, 1); assert.equal(events.ofType("late_charge.assessment.decided")[0]!.payload.outcome, "assessed");
  // once only: the next day's run records not_assessed and adds no fee (NOTE_6A_ONLY_ONCE_GATE)
  const again = ops.runAssessment({ state: s, installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-18"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(again.outcome, "not_assessed"); assert.equal(s.fees!.length, 1); assert.equal(s.late_charges_due_cents, 7_901n);
  assert.equal(evaluateGate("2.7.onlyOnePerInstallment", { late_charges_for_installment_not_reversed: 1 }).open, false);
  // the internal 1-CD assessment clock opened with the grace gate and closed with the decision; the D2-2-03 reminder is due by the 20th and states the $79.01
  const assess = timers.byCode("SM_LATE_CHARGE_ASSESS_1CD")[0]!; assert.equal(assess.dueDate, "2026-09-17"); assert.equal(assess.status, "satisfied");
  const reminder = timers.byCode("FNMA_D2203_PAYMENT_REMINDER_CD20")[0]!; assert.equal(reminder.dueDate, "2026-09-20"); assert.equal(reminder.status, "armed");
  assert.equal(events.ofType("payment.cycle.unpaid_day16")[0]!.payload.late_charges_due_cents, "7901");
  assert.deepEqual(lateFeeDisclosure(L1(), D("2026-09-01")), { late_fee_amount_if_unpaid: 7_901n, late_fee_date: D("2026-09-17") });
});
test("2.7-T2: Given a lockbox item received 2026-09-16 16:45 (before cut-off) but posted 2026-09-18, when the run executes, then the backlog gate defers assessment and, after posting, `not_assessed` is recorded.", async () => {
  const h = harness("2026-09-16T21:45:00.000Z", L1());                              // 16:45 America/Chicago
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.1", "2.7"] });
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const { payment } = h.svc.receive({ channel: "lockbox", instrument: "check", amount_cents: 219_257n, received_at: "2026-09-16T21:45:00.000Z", loan_id: "L-1", source_batch_id: "LB-0916", source_item_id: "17" });
  assert.equal(payment.received_on, "2026-09-16"); assert.equal(payment.status, "received");
  // the 2026-09-17 00:30 run: one item dated ≤ the grace end is unposted → SM_CASHIERING_POSTING_BACKLOG_GATE defers
  h.clock.set("2026-09-17T05:30:00.000Z");
  const unposted = h.svc.all().filter((p) => (p.status === "received" || p.status === "identified") && p.received_on <= D("2026-09-16")).length; assert.equal(unposted, 1);
  assert.equal(evaluateGate("2.1.noPostingBacklog", { items_received_or_identified_on_or_before_gate_date: unposted }).open, false);
  const deferred = ops.runAssessment({ state: h.state(), installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: unposted });
  assert.equal(deferred.outcome, "deferred_backlog"); assert.equal(h.state().fees!.length, 0);
  assert.deepEqual(timers.byCode("SM_LATE_CHARGE_ASSESS_1CD").map((t) => t.status), ["armed"]);   // a deferral is not a decision: the 1-CD clock stays open
  // the same gate on the fees.assess tool: the guard names the fact key the evaluator reads, and a stated backlog refuses the command before anything runs
  const agents = new AgentRegistry(); const cmds = bindTools({ store: new EntityStore(), ports: {}, escalations: new EscalationService(h.events, h.clock), services: {} }, agents); const bus = new CommandBus(agents);
  const ctx: UowContext = { loanId: "L-1", events: h.events, ledger: h.ledger, timers, clock: h.clock, decide: () => {} };
  const cmd = cmds.get(toolKey("2.7", "fees.assess"))!;
  await assert.rejects(bus.execute(cmd, AGENT, { state: h.state(), installment_due_date: "2026-09-01", run_on: "2026-09-17", received_toward_basis_cents: 0n, unposted_receipts_on_or_before_grace: 1, facts: { items_received_or_identified_on_or_before_gate_date: 1 } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "POSTING_BACKLOG_GATE" && /items_received_or_identified_on_or_before_gate_date/.test(e.message));
  await assert.rejects(bus.execute(cmd, AGENT, { state: h.state(), installment_due_date: "2026-09-01", run_on: "2026-09-17", received_toward_basis_cents: 0n, unposted_receipts_on_or_before_grace: 0 }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "POSTING_BACKLOG_GATE");   // an omitted backlog fact never opens the gate
  // posted 2026-09-18 with credited_as_of = received_on 2026-09-16 (inside the grace) → the run after posting records not_assessed
  h.clock.set("2026-09-18T14:00:00.000Z"); h.svc.identify(payment.id, "L-1"); const posted = h.svc.post(payment.id);
  assert.equal(posted.payment.credited_as_of, "2026-09-16"); assert.equal(h.state().installments[0]!.credited_as_of, "2026-09-16");
  const r = await bus.execute(cmd, AGENT, { state: h.state(), installment_due_date: "2026-09-01", run_on: "2026-09-18", received_toward_basis_cents: 158_017n, unposted_receipts_on_or_before_grace: 0, facts: { items_received_or_identified_on_or_before_gate_date: 0 } }, ctx);
  assert.equal((r.output as { outcome: string }).outcome, "not_assessed");
  assert.ok(timers.byCode("SM_LATE_CHARGE_ASSESS_1CD").every((t) => t.status === "satisfied"));   // the decision closes it
  const decided = h.events.ofType("late_charge.assessment.decided"); assert.deepEqual(decided.map((e) => e.payload.outcome), ["deferred_backlog", "not_assessed"]); assert.equal(decided[1]!.payload.reason, "paid within grace");
  assert.equal(h.state().fees!.length, 0); assert.equal(h.state().late_charges_due_cents, 0n);
});
test("2.7-T3: Given the $79.01 outstanding and an on-time 219,257¢ October payment, when the 2026-10-17 run executes, then no October late charge is assessed (no pyramiding) and the $79.01 remains disclosed.", async () => {
  const h = harness("2026-09-17T05:30:00.000Z", L1());
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.7"] });
  const ops = new LateChargeOps({ events: h.events, clock: h.clock });
  // example K: the September installment unpaid through the 09-16 grace end → 7,901¢ assessed 2026-09-17
  const k = ops.assess({ state: h.state(), installment_due_date: D("2026-09-01"), run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(k.outcome, "assessed"); assert.equal(h.state().late_charges_due_cents, 7_901n);
  // September paid late on 09-20: the periodic payment goes to the installment, nothing to the $79.01 (2.1 rule 5 — the Allocation Engine never diverts a periodic payment to fees)
  h.clock.set("2026-09-20T14:00:00.000Z"); const sep = h.pay(219_257n, "2026-09-20");
  assert.equal(sep.payment.allocation_outcome, "applied"); assert.equal(sep.payment.allocations.some((a) => a.bucket === "late_charge"), false); assert.equal(h.state().late_charges_due_cents, 7_901n);
  // the on-time October payment of exactly 219,257¢: applied in full to the October installment, credited 2026-10-01
  h.clock.set("2026-10-01T14:00:00.000Z"); const oct = h.pay(219_257n, "2026-10-01");
  assert.deepEqual(oct.payment.allocations.map((a) => [a.bucket, a.installment_due_date]), [["interest", "2026-10-01"], ["principal", "2026-10-01"], ["escrow", "2026-10-01"]]);
  assert.equal(oct.payment.allocations.reduce((s, a) => s + a.amount_cents, 0n), 219_257n);
  assert.equal(h.state().installments[1]!.status, "satisfied"); assert.equal(h.state().installments[1]!.credited_as_of, "2026-10-01"); assert.equal(h.state().late_charges_due_cents, 7_901n);
  assert.equal(h.events.ofType("fee.collected").length, 0);
  // the 2026-10-17 run: the engine's own credited-funds test (rule 1) finds the October P&I credited by the 10-16 grace end → not_assessed, no second fee
  h.clock.set("2026-10-17T05:30:00.000Z");
  assert.equal(receivedTowardBasis(h.state(), D("2026-10-01")), 158_017n);
  const r = ops.assess({ state: h.state(), installment_due_date: D("2026-10-01"), run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(r.outcome, "not_assessed"); if (r.outcome === "not_assessed") assert.match(r.reason, /no pyramiding on prior fees, §1026\.36\(c\)\(2\)/);
  assert.equal(h.state().fees!.length, 1); assert.equal(h.events.ofType("fee.assessed").length, 1);
  assert.equal(h.events.ofType("late_charge.assessment.run")[1]!.payload.received_derived_from_state, true);
  const decided = h.events.ofType("late_charge.assessment.decided"); assert.deepEqual(decided.map((e) => [e.payload.installment_due_date, e.payload.outcome]), [["2026-09-01", "assessed"], ["2026-10-01", "not_assessed"]]);
  assert.deepEqual(timers.byCode("SM_LATE_CHARGE_ASSESS_1CD").map((t) => [t.dueDate, t.status]), [["2026-09-17", "satisfied"], ["2026-10-17", "satisfied"]]);
  // the §1026.36(c)(2) gate on the agent's command: its facts are derived from the state (periodic payment credited; only shortfall is the prior fee) — closed, refused; an omitted fact never opens it
  const agents = new AgentRegistry(); const cmds = bindTools({ store: new EntityStore(), ports: {}, escalations: new EscalationService(h.events, h.clock), services: {} }, agents); const bus = new CommandBus(agents);
  const ctx: UowContext = { loanId: "L-1", events: h.events, ledger: h.ledger, timers, clock: h.clock, decide: () => {} };
  await assert.rejects(bus.execute(cmds.get(toolKey("2.7", "fees.assess"))!, AGENT, { state: h.state(), installment_due_date: "2026-10-01", run_on: "2026-10-17", facts: { items_received_or_identified_on_or_before_gate_date: 0 } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_PYRAMIDING" && /§1026\.36\(c\)\(2\)/.test(e.message));
  assert.equal(evaluateGate("2.7.noPyramiding", {}).open, false); assert.equal(evaluateGate("2.7.noPyramiding", { periodic_payment_credited_by_grace_end: false }).open, true);
  // the $79.01 remains disclosed: the fee stays open and the statement/reminder data (rule 9) carry it
  assert.equal(h.state().fees![0]!.state, "assessed"); assert.equal(h.state().fees![0]!.amount_cents, 7_901n);
  assert.deepEqual(ops.reminderData(h.state(), D("2026-11-01")), { late_fee_amount_if_unpaid: 7_901n, late_fee_date: D("2026-11-17"), late_charges_due_cents: 7_901n });
});
test("2.7-T4: Given a transfer-in with RESPA date 2026-09-01 and a payment received by the transferor 2026-09-14 and forwarded 09-22, then no late charge is assessed and `credited_as_of` = 2026-09-14.", () => {
  const h = harness("2026-09-17T05:30:00.000Z", L1({ transfer_shield_until: D("2026-10-30") }));   // 60-day window from the 2026-09-01 RESPA effective date
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const shielded = ops.runAssessment({ state: h.state(), installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(shielded.outcome, "not_assessed"); if (shielded.outcome === "not_assessed") assert.match(shielded.reason, /transfer_window_60 shield/);
  h.clock.set("2026-09-22T14:00:00.000Z");
  const { payment } = h.svc.receive({ channel: "transferor_forward", instrument: "check", amount_cents: 219_257n, received_at: "2026-09-22T14:00:00.000Z", transferor_received_on: D("2026-09-14"), loan_id: "L-1", payer_type: "transferor", source_item_id: "fwd-1" });
  assert.equal(payment.received_on, "2026-09-22"); assert.equal(payment.credited_as_of, "2026-09-14");   // §1024.33(c): credited as of the transferor's receipt
  assert.equal(h.events.ofType("payment.received")[0]!.payload.received_by, "transferor");
  h.svc.identify(payment.id, "L-1"); h.svc.post(payment.id);
  assert.equal(h.state().installments[0]!.status, "satisfied"); assert.equal(h.state().installments[0]!.credited_as_of, "2026-09-14"); assert.equal(h.state().installments[0]!.satisfied_on, "2026-09-22");
  // re-evaluated with the true credited_as_of (≤ grace end 2026-09-16): not assessed, nothing to reverse, no negative reporting
  const after = ops.runAssessment({ state: h.state(), installment_due_date: D("2026-09-01"), received_toward_basis_cents: 158_017n, run_on: D("2026-09-23"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(after.outcome, "not_assessed"); assert.equal(h.state().fees!.length, 0);
  assert.deepEqual(reverseOnRedate(h.state(), D("2026-09-01"), D("2026-09-14")), { reversed: null, refund_cents: 0n, credit_reporting_correction: false });
});
test("2.7-T5: Given a forbearance plan defaulted 2026-11-20, then installments due 10/01 and 11/01 carry no charge and 12/01 is assessed 2026-12-17.", async () => {
  const h = lc("2026-09-28T14:00:00.000Z", L1({ lpi_date: D("2026-09-01") }, D("2026-10-01"), 3));
  const def = loadOverriddenRegistry().get("FNMA_D23201_FORBEARANCE_NO_ACCRUAL_GATE")!;
  // 12.x opens the plan 2026-10-01 → 2026-12-31: `case.forbearance.opened{plan_start}` arms the no-accrual gate anchored on the plan start (D2-3.2-01)
  const row = h.ops.forbearanceOpened(h.state, { case_id: "FB-1", plan_start: D("2026-10-01"), plan_end: D("2026-12-31") });
  assert.deepEqual(row, { loan_id: "L-1", reason: "forbearance_active", source_case_id: "FB-1", starts_on: "2026-10-01", ends_on: "2026-12-31", mode: "no_accrual" });
  assert.ok(eventMatches(def.triggerPattern!, h.events.ofType("case.forbearance.opened")[0]!));
  const gate = h.timers.byCode("FNMA_D23201_FORBEARANCE_NO_ACCRUAL_GATE")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2026-10-01"); assert.equal(gate.note, "evaluator:2.7.forbearanceNoAccrual");
  // 10/01 (grace end 10-16 → run 10-17) and 11/01 (grace end 11-16 → run 11-17): no accrual while the plan is active
  h.clock.set("2026-10-17T05:30:00.000Z"); const oct = h.ops.assess({ state: h.state, installment_due_date: D("2026-10-01"), run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(oct.outcome, "not_assessed"); if (oct.outcome === "not_assessed") assert.match(oct.reason, /forbearance_active: no accrual \(D2-3\.2-01\)/);
  h.clock.set("2026-11-17T05:30:00.000Z"); const nov = h.ops.assess({ state: h.state, installment_due_date: D("2026-11-01"), run_on: D("2026-11-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(nov.outcome, "not_assessed"); assert.equal(h.state.fees!.length, 0);
  // the borrower defaults on the plan's terms 2026-11-20: accrual resumes "from the date the borrower defaulted on the plan" — a re-run for 11/01 (due before the default date) still carries no charge
  h.clock.set("2026-11-20T14:00:00.000Z"); const o = h.ops.forbearanceDefaulted(h.state, "FB-1", D("2026-11-20")); assert.equal(o.defaulted_on, "2026-11-20");
  assert.equal(h.events.ofType("case.forbearance.defaulted")[0]!.payload.accrual_resumes_for_installments_due_on_or_after, "2026-11-20");
  h.clock.set("2026-11-21T05:30:00.000Z"); assert.equal(h.ops.assess({ state: h.state, installment_due_date: D("2026-11-01"), run_on: D("2026-11-21"), unposted_receipts_on_or_before_grace: 0 }).outcome, "not_assessed");
  assert.equal(evaluateGate("2.7.forbearanceNoAccrual", { forbearance_active: true, defaulted_on: "2026-11-20", installment_due_date: "2026-11-01" }).open, false);
  assert.equal(evaluateGate("2.7.forbearanceNoAccrual", { forbearance_active: true, defaulted_on: "2026-11-20", installment_due_date: "2026-12-01" }).open, true);
  // 12/01: grace end 12-16 (Wednesday) → the 2026-12-17 run assesses 7,901¢ — through the agent's fees.assess command (the OVERLAYS guardrail reads the default date)
  h.clock.set("2026-12-17T05:30:00.000Z");
  const agents = new AgentRegistry(); const cmds = bindTools({ store: new EntityStore(), ports: {}, escalations: new EscalationService(h.events, h.clock), services: {} }, agents); const bus = new CommandBus(agents);
  const ctx: UowContext = { loanId: "L-1", events: h.events, ledger: new MemoryLedger(), timers: h.timers, clock: h.clock, decide: () => {} };
  const r = await bus.execute(cmds.get(toolKey("2.7", "fees.assess"))!, AGENT, { state: h.state, installment_due_date: "2026-12-01", run_on: "2026-12-17", facts: { items_received_or_identified_on_or_before_gate_date: 0 } }, ctx);
  const out = r.output as { outcome: string; fee: Fee }; assert.equal(out.outcome, "assessed"); assert.equal(out.fee.amount_cents, 7_901n); assert.equal(out.fee.assessed_on, "2026-12-17"); assert.equal(out.fee.grace_end_on, "2026-12-16");
  assert.equal(h.state.fees!.length, 1); assert.equal(h.state.late_charges_due_cents, 7_901n);
  assert.deepEqual(h.events.ofType("late_charge.assessment.decided").map((e) => [e.payload.installment_due_date, e.payload.outcome]), [["2026-10-01", "not_assessed"], ["2026-11-01", "not_assessed"], ["2026-11-01", "not_assessed"], ["2026-12-01", "assessed"]]);
  // the same command for the 11/01 installment is refused by the overlay guardrail even after the default
  await assert.rejects(bus.execute(cmds.get(toolKey("2.7", "fees.assess"))!, AGENT, { state: h.state, installment_due_date: "2026-11-01", run_on: "2026-12-17", facts: { items_received_or_identified_on_or_before_gate_date: 0 } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "OVERLAYS");
});
test("2.7-T6: Given an SCRA period starting 2026-10-15, when installments fall due, then no charges are assessed and the pre-service charge is not collected during the period.", async () => {
  const h = lc("2026-09-17T05:30:00.000Z", L1());
  const def = loadOverriddenRegistry().get("FNMA_C1102_MILITARY_INDULGENCE_LC_WAIVER_GATE")!;
  // example K's pre-service charge (assessed 2026-09-17) and the October charge assessed 10-17, before 13.9's notice is processed
  const k = h.ops.assess({ state: h.state, installment_due_date: D("2026-09-01"), run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 }); assert.equal(k.outcome, "assessed"); const kFee = (k as { fee: Fee }).fee;
  h.clock.set("2026-10-17T05:30:00.000Z"); assert.equal(h.ops.assess({ state: h.state, installment_due_date: D("2026-10-01"), run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "assessed");
  assert.equal(h.state.late_charges_due_cents, 15_802n);
  // 13.9: active duty from 2026-10-15 → `scra.period.started` arms the waiver gate; the charge assessed after 10-15 is waived (`fee.waived{scra}`), K's pre-service charge is held no_collection
  h.clock.set("2026-10-20T14:00:00.000Z");
  const r = h.ops.scraPeriodStarted(h.state, { case_id: "SCRA-1", service_begin_on: D("2026-10-15") });
  assert.deepEqual(r.waived.map((f) => [f.installment_due_date, f.state, f.waived_reason]), [["2026-10-01", "waived", "scra"]]); assert.deepEqual(r.held.map((f) => f.id), [kFee.id]);
  assert.equal(kFee.state, "assessed"); assert.equal(kFee.collection_hold, "scra_reduced_rate"); assert.equal(h.state.late_charges_due_cents, 7_901n);
  assert.ok(eventMatches(def.triggerPattern!, h.events.ofType("scra.period.started")[0]!));
  const waived = h.events.ofType("fee.waived"); assert.equal(waived.length, 1); assert.ok(eventMatches(def.satisfiedPattern!, waived[0]!)); assert.equal(waived[0]!.payload.scra, true);
  const gate = h.timers.byCode("FNMA_C1102_MILITARY_INDULGENCE_LC_WAIVER_GATE")[0]!; assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedByEventId, waived[0]!.id);
  assert.equal(evaluateGate("2.7.scraLateChargeWaiver", { scra_reduced_rate_period_active: true }).open, false);
  // installments falling due in the period (11/01, 12/01): no charges assessed
  h.clock.set("2026-11-17T05:30:00.000Z"); const nov = h.ops.assess({ state: h.state, installment_due_date: D("2026-11-01"), run_on: D("2026-11-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(nov.outcome, "not_assessed"); if (nov.outcome === "not_assessed") assert.equal(nov.reason, "scra_reduced_rate");
  h.clock.set("2026-12-17T05:30:00.000Z"); assert.equal(h.ops.assess({ state: h.state, installment_due_date: D("2026-12-01"), run_on: D("2026-12-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "not_assessed");
  assert.equal(h.state.fees!.length, 2); assert.equal(h.events.ofType("fee.assessed").length, 2);
  // the pre-service $79.01 is not collected during the period: a collection attempt is refused (C-1.1-02; 50 U.S.C. 3937(d)(1)); 2.7-Q6 default after the period: waive
  const c = h.ops.collect(h.state, kFee.id, 7_901n, D("2026-12-17"), { payment_id: "p-dec", from: "remainder" });
  assert.equal(c.ok, false); if (!c.ok) { assert.equal(c.code, "COLLECTION_HOLD"); assert.match(c.reason, /scra_reduced_rate/); }
  assert.equal(kFee.collected_cents, 0n); assert.equal(h.state.late_charges_due_cents, 7_901n); assert.equal(h.events.ofType("fee.collected").length, 0);
  assert.equal(h.events.ofType("fee.collection.held")[0]!.payload.post_period_default, "waive (2.7-Q6)");
  // the agent's fees.assess is refused for an installment in the period (OVERLAYS guardrail)
  const agents = new AgentRegistry(); const cmds = bindTools({ store: new EntityStore(), ports: {}, escalations: new EscalationService(h.events, h.clock), services: {} }, agents); const bus = new CommandBus(agents);
  const ctx: UowContext = { loanId: "L-1", events: h.events, ledger: new MemoryLedger(), timers: h.timers, clock: h.clock, decide: () => {} };
  await assert.rejects(bus.execute(cmds.get(toolKey("2.7", "fees.assess"))!, AGENT, { state: h.state, installment_due_date: "2026-12-01", run_on: "2026-12-17", facts: { items_received_or_identified_on_or_before_gate_date: 0 } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "OVERLAYS");
});
test("2.7-T7: Given a repayment plan completed on schedule, when `case.repayment.completed` fires, then all charges accrued during the plan are waived the same day.", () => {
  const h = lc("2026-08-25T14:00:00.000Z", L1());
  const def = loadOverriddenRegistry().get("FNMA_D23202_REPAYMENT_WAIVE_ON_COMPLETION_0")!;
  // a charge due when the plan is established is not a plan-period charge (D2-3.2-02: it may be included in the plan) — it stays assessed
  recordFee(h.state, { id: "pre", fee_type: "late_charge", installment_due_date: D("2026-08-01"), amount_cents: 7_901n, state: "assessed", assessed_on: D("2026-08-17"), collected_cents: 0n });
  h.ops.repaymentOpened(h.state, { case_id: "RP-1", plan_start: D("2026-09-01"), plan_end: D("2026-11-30") });
  for (const [due, run] of [["2026-09-01", "2026-09-17"], ["2026-10-01", "2026-10-17"], ["2026-11-01", "2026-11-17"]] as const) {
    h.clock.set(`${run}T05:30:00.000Z`);
    const a = h.ops.assess({ state: h.state, installment_due_date: D(due), run_on: D(run), unposted_receipts_on_or_before_grace: 0 });
    assert.equal(a.outcome, "accrued_suspended"); if (a.outcome === "accrued_suspended") { assert.equal(a.fee.suppression, "repayment_plan_pending_waiver"); assert.equal(a.fee.amount_cents, 7_901n); assert.equal(a.fee.assessed_on, run); }
  }
  assert.equal(h.state.late_charges_due_cents, 7_901n); assert.equal(h.ops.billableLateCharges(h.state), 7_901n);   // suspended charges are not billed
  assert.equal(h.timers.byCode("FNMA_D23202_REPAYMENT_WAIVE_ON_COMPLETION_0").length, 0);
  // the plan completes on schedule 2026-11-30: `case.repayment.completed{completed_on}` arms the same-day deadline, and the same call waives the three plan-period charges
  h.clock.set("2026-11-30T20:00:00.000Z");
  const r = h.ops.repaymentCompleted(h.state, "RP-1", D("2026-11-30"));
  assert.equal(r.waived.length, 3); assert.equal(r.total_cents, 23_703n);   // 3 × 7,901¢
  assert.ok(eventMatches(def.triggerPattern!, h.events.ofType("case.repayment.completed")[0]!));
  const t = h.timers.byCode("FNMA_D23202_REPAYMENT_WAIVE_ON_COMPLETION_0")[0]!; assert.equal(t.anchorDate, "2026-11-30"); assert.equal(t.dueDate, "2026-11-30"); assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedAt!.slice(0, 10), "2026-11-30");
  const waivers = h.events.ofType("fee.waived"); assert.equal(waivers.length, 3);
  assert.ok(waivers.every((e) => eventMatches(def.satisfiedPattern!, e) && e.payload.reason === "workout_completion" && e.payload.waived_on === "2026-11-30" && e.payload.waived_cents === "7901"));
  assert.equal(t.satisfiedByEventId, waivers[0]!.id);
  assert.deepEqual(h.state.fees!.map((f) => [f.installment_due_date, f.state]), [["2026-08-01", "assessed"], ["2026-09-01", "waived"], ["2026-10-01", "waived"], ["2026-11-01", "waived"]]);
  assert.equal(h.state.late_charges_due_cents, 7_901n); assert.equal(h.state.overlays![0]!.to, "2026-11-30");
  assert.equal(h.events.ofType("late_charge.suppression.closed")[0]!.payload.waived_cents, "23703");
  // a waiver for some other reason is not what closes the plan deadline
  assert.equal(h.ops.ops.waive(h.state, "pre", "error_correction", AGENT, D("2026-12-01")).ok, true);
  assert.equal(eventMatches(def.satisfiedPattern!, h.events.ofType("fee.waived").at(-1)!), false);
  assert.throws(() => h.ops.repaymentCompleted(h.state, "RP-9", D("2026-11-30")), RangeError);
});
test("2.7-T8: Given a Chapter 13 filing, when installments fall due, then charges are `accrued_suspended{bankruptcy_active}`, no statement bills them, and the 14.2 exposure list contains them with incurred dates.", async () => {
  const h = lc("2026-08-20T14:00:00.000Z", L1(), ["2.7", "14.2"]);
  const row = h.ops.bankruptcyFiled(h.state, { case_id: "BK-1", chapter: 13, petition_date: D("2026-08-20") });
  assert.deepEqual(row, { loan_id: "L-1", reason: "bankruptcy_active", source_case_id: "BK-1", starts_on: "2026-08-20", ends_on: null, mode: "accrue_suspended" });
  // installments due 09/01 and 10/01 fall due and pass their grace ends: charges accrue suspended, nothing billed
  const fees: Fee[] = [];
  for (const [due, run] of [["2026-09-01", "2026-09-17"], ["2026-10-01", "2026-10-17"]] as const) {
    h.clock.set(`${run}T05:30:00.000Z`);
    const a = h.ops.assess({ state: h.state, installment_due_date: D(due), run_on: D(run), unposted_receipts_on_or_before_grace: 0 });
    assert.equal(a.outcome, "accrued_suspended"); if (a.outcome === "accrued_suspended") { assert.equal(a.fee.state, "accrued_suspended"); assert.equal(a.fee.suppression, "bankruptcy_active"); assert.equal(a.fee.assessed_on, run); assert.equal(a.fee.amount_cents, 7_901n); fees.push(a.fee); }
  }
  assert.equal(h.state.late_charges_due_cents, 0n); assert.equal(h.ops.billableLateCharges(h.state), 0n);
  assert.deepEqual(h.ops.reminderData(h.state, D("2026-11-01")), { late_fee_amount_if_unpaid: 7_901n, late_fee_date: D("2026-11-17"), late_charges_due_cents: 0n });   // 14.3: no statement bills a post-petition charge
  assert.ok(h.events.ofType("fee.assessed").every((e) => e.payload.state === "accrued_suspended" && e.payload.suppression === "bankruptcy_active"));
  // no collection post-petition
  const c = h.ops.collect(h.state, fees[0]!.id, 7_901n, D("2026-10-20"), { payment_id: "p-oct", from: "remainder" });
  assert.equal(c.ok, false); if (!c.ok) assert.equal(c.code, "NOT_COLLECTIBLE"); assert.equal(h.events.ofType("fee.collected").length, 0);
  // the 14.2 exposure list carries each charge with its incurred date; each was exposed as `fee.incurred_postpetition{incurred_on}` — 14.2's BK_3002_1C_FEE_NOTICE_180 arms 180 CD from it (Rule 3002.1(c))
  const list = h.ops.bkExposureList(h.state);
  assert.deepEqual(list.map((r) => [r.fee_id, r.incurred_on, r.amount_cents, r.case_id]), [[fees[0]!.id, "2026-09-17", 7_901n, "BK-1"], [fees[1]!.id, "2026-10-17", 7_901n, "BK-1"]]);
  assert.deepEqual(h.events.ofType("fee.incurred_postpetition").map((e) => e.payload.incurred_on), ["2026-09-17", "2026-10-17"]);
  assert.deepEqual(h.timers.byCode("BK_3002_1C_FEE_NOTICE_180").map((t) => [t.anchorDate, t.dueDate, t.status]), [["2026-09-17", "2027-03-16", "armed"], ["2026-10-17", "2027-04-15", "armed"]]);   // +180 calendar days: Tue 2027-03-16, Thu 2027-04-15
  assert.equal(h.events.ofType("bk.postpetition_fees.exposure_listed")[0]!.payload.total_cents, "15802");
  // the agent's fees.assess is refused post-petition (OVERLAYS guardrail)
  const agents = new AgentRegistry(); const cmds = bindTools({ store: new EntityStore(), ports: {}, escalations: new EscalationService(h.events, h.clock), services: {} }, agents); const bus = new CommandBus(agents);
  const ctx: UowContext = { loanId: "L-1", events: h.events, ledger: new MemoryLedger(), timers: h.timers, clock: h.clock, decide: () => {} };
  h.clock.set("2026-11-17T05:30:00.000Z");
  await assert.rejects(bus.execute(cmds.get(toolKey("2.7", "fees.assess"))!, AGENT, { state: h.state, installment_due_date: "2026-11-01", run_on: "2026-11-17", facts: { items_received_or_identified_on_or_before_gate_date: 0 } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "OVERLAYS");
  assert.throws(() => h.ops.bankruptcyFiled(L1(), { case_id: "BK-2", chapter: 9 as unknown as 13, petition_date: D("2026-08-20") }), RangeError);
});
test("2.7-T9: Given a note with 4% and 10-day grace boarded in a state capping at 5%/15 days, then the loan's terms (4%/10) apply; given a note with 5%/15 in a state capping at 4%/… **[UNVERIFIED state]**, then boarding flags the conflict and the lower cap is applied.", () => {
  assert.deepEqual(lateChargeTerms({ pct: "4", grace_days: 10 }, { max_pct: "5", min_grace_days: 15, state: "TX" }), { pct: "4", grace_days: 10, conflict: null });
  const c = lateChargeTerms({ pct: "5", grace_days: 15 }, { max_pct: "4", min_grace_days: 15, state: "XX" });
  assert.equal(c.pct, "4"); assert.equal(c.grace_days, 15); assert.equal(c.conflict!.applied, "lower_cap"); assert.equal(c.conflict!.state, "XX");
  assert.equal(lateChargeTerms({ pct: "5", grace_days: 15 }, null).conflict, null);
});
test("2.7-T10: Given an R01 return on a loan in a state where NSF fees are allowed with a $30 cap, when processed, then a 2,500¢ fee is assessed once with `LC-NSF-FEE-v1`; in a state with `allowed=false`, none.", () => {
  const clock = new FixedClock("2027-02-03T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const ops = new CashieringOps({ events, clock });
  const s = L1();
  const fee = ops.assessNsf(s, { allowed: true, cap_cents: 3_000n }, { our_error: false, returned_on: D("2027-02-03"), return_code: "R01", payment_id: "p-feb" });
  assert.equal(fee!.amount_cents, 2_500n); assert.equal(s.nsf_fees_due_cents, 2_500n); assert.equal(fee!.returned_payment_id, "p-feb");
  const q = events.ofType("notice.queued").find((e) => e.payload.template === "LC-NSF-FEE-v1")!; assert.equal(q.payload.amount_cents, "2500"); assert.equal(q.payload.with, "AUTODRAFT-RETURN-v1");
  assert.equal(ops.assessNsf(s, { allowed: true, cap_cents: 3_000n }, { our_error: false, returned_on: D("2027-02-03"), return_code: "R01", payment_id: "p-feb" }), null);   // once per returned item
  assert.equal(events.ofType("fee.assessed").filter((e) => e.payload.fee_type === "nsf_fee").length, 1); assert.equal(s.nsf_fees_due_cents, 2_500n);
  assert.equal(ops.assessNsf(L1(), { allowed: false, cap_cents: null }, { our_error: false, returned_on: D("2027-02-03"), return_code: "R01" }), null);
  assert.deepEqual(events.ofType("nsf_fee.not_assessed").map((e) => e.payload.reason), ["already assessed once for this returned item", "jurisdiction does not allow NSF fees"]);
  assert.equal(nsfFee(L1(), { allowed: true, cap_cents: 1_500n }, { our_error: false, returned_on: D("2027-02-03") })!.amount_cents, 1_500n);   // the lower state cap
  assert.equal(nsfFee(L1(), { allowed: true, cap_cents: null }, { our_error: true, returned_on: D("2027-02-03") }), null);   // an R11 caused by our error never carries a fee
  const reg = new NoticeRegistry(); publishSection02(reg); const v = reg.activeVersion("LC-NSF-FEE-v1", D("2027-02-03"))!;
  const payload = { ...v.samplePayload, fee_cents: fee!.amount_cents, fee_over_cap: 0, fees_for_this_item: 1 }; const r = render(v.source, payload);
  assert.match(r.text, /returned-payment fee of \$25\.00 has been charged as authorized by/); assert.match(r.text, /How to avoid this fee/); assert.equal(evaluateChecklist(v, payload, r).passed, true);
  const twice = { ...payload, fees_for_this_item: 2 }; assert.ok(evaluateChecklist(v, twice, render(v.source, twice)).blocking.some((b) => b.rule_id === "once-per-item"));
});
test("2.7-T11: Given a courtesy waiver already granted within 12 months, when the agent tries a second, then the command requires `officer` approval.", async () => {
  const clock = new FixedClock("2026-10-20T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const ctx: UowContext = { loanId: "L-1", events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} };
  const agents = new AgentRegistry(); const cmds = bindTools({ store: new EntityStore(), ports: {}, escalations: new EscalationService(events, clock), services: {} }, agents); const bus = new CommandBus(agents);
  const cmd = cmds.get(toolKey("2.7", "fees.waive"))!;
  const s = L1({ courtesy_waivers_12m: 0 });
  for (const [id, due, on] of [["f1", "2026-09-01", "2026-09-17"], ["f2", "2026-10-01", "2026-10-17"], ["f3", "2026-11-01", "2026-11-17"]] as const) recordFee(s, { id, fee_type: "late_charge", installment_due_date: D(due), amount_cents: 7_901n, state: "assessed", assessed_on: D(on), collected_cents: 0n });
  const first = await bus.execute(cmd, AGENT, { state: s, fee_id: "f1", reason: "courtesy" }, ctx);
  assert.equal((first.output as { ok: boolean }).ok, true); assert.equal(s.courtesy_waivers_12m, 1); assert.equal(s.fees![0]!.state, "waived");
  await assert.rejects(bus.execute(cmd, AGENT, { state: s, fee_id: "f2", reason: "courtesy" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "COURTESY_LIMIT" && /requires officer/.test(e.message));
  assert.equal(s.fees![1]!.state, "assessed");                                      // refused before anything ran
  assert.equal(evaluateGate("2.7.courtesyWaiverLimit", { courtesy_waivers_rolling_12m: 1 }).open, false);
  await assert.rejects(bus.execute(cmd, AGENT, { fee_id: "f2", reason: "courtesy" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "COURTESY_LIMIT");   // no state and no facts: the counter is unknown, the gate stays closed
  const officer = await bus.execute(cmd, OFFICER, { state: s, fee_id: "f2", reason: "courtesy" }, ctx);
  assert.equal((officer.output as { ok: boolean }).ok, true); assert.equal(s.fees![1]!.state, "waived"); assert.equal(s.late_charges_due_cents, 7_901n);
  assert.equal(events.ofType("fee.waived").length, 2); assert.equal(events.ofType("late_charge.waive").filter((e) => e.payload.courtesy === true).length, 2);
  assert.ok(events.ofType("notice.queued").some((e) => e.payload.template === "LC-WAIVER-CONFIRM-v1"));
  // an automatic reason never counts against the courtesy limit
  const auto = await bus.execute(cmd, AGENT, { state: s, fee_id: "f3", reason: "error_correction" }, ctx); assert.equal((auto.output as { ok: boolean }).ok, true); assert.equal(s.courtesy_waivers_12m, 2);
});
test("2.7 decision 2 / NOTE_6A_LATE_CHARGE_GRACE_GATE: a grace end on a non-business day rolls to the next servicer business day (Sat 2027-01-16 → Tue 2027-01-19 after MLK Day); strict calendar days only where the jurisdiction requires it", () => {
  const jan = L1({ lpi_date: D("2026-12-01") }, D("2027-01-01"), 2);
  assert.equal(graceEndFor(jan, D("2027-01-01")), "2027-01-19");
  const at = (state: typeof jan, run: string) => assessLateCharge({ state, installment_due_date: D("2027-01-01"), received_toward_basis_cents: 0n, run_on: D(run), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(at(jan, "2027-01-17").outcome, "not_assessed"); assert.equal(at(jan, "2027-01-19").outcome, "not_assessed");
  const a = at(jan, "2027-01-20"); assert.equal(a.outcome, "assessed"); assert.equal(a.grace_end_on, "2027-01-19");
  assert.equal(evaluateGate("2.7.graceGateOpen", { run_on: "2027-01-17", grace_end_on: "2027-01-19" }).open, false); assert.equal(evaluateGate("2.7.graceGateOpen", { run_on: "2027-01-20", grace_end_on: "2027-01-19" }).open, true);
  assert.equal(lateFeeDisclosure(jan, D("2027-01-01")).late_fee_date, "2027-01-20");
  const strict = L1({ lpi_date: D("2026-12-01"), late_charge_grace_business_day_extension: false }, D("2027-01-01"), 2);
  assert.equal(graceEndFor(strict, D("2027-01-01")), "2027-01-16"); assert.equal(at(strict, "2027-01-17").outcome, "assessed");
});
test("2.7-T12: Given a 4.1 correction re-dating a payment to 2026-09-01, when applied, then the 2026-09-17 charge is `reversed`, any collected amount refunded/credited, and 8.1 receives a correction.", async () => {
  const h = harness("2026-09-17T05:30:00.000Z", L1());
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.7"] });
  const ops = new LateChargeOps({ events: h.events, clock: h.clock });
  const k = ops.assess({ state: h.state(), installment_due_date: D("2026-09-01"), run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 }); assert.equal(k.outcome, "assessed"); const kFee = (k as { fee: Fee }).fee;
  // September paid 09-25 (credited 09-25) with 7,901¢ designated for fees: the charge is collected (`fee.collected{late_charge}` arms the A2-3-04 monthly reporting row)
  h.clock.set("2026-09-25T14:00:00.000Z"); h.pay(219_257n, "2026-09-25"); assert.equal(h.state().installments[0]!.credited_as_of, "2026-09-25");
  const fee = () => h.state().fees!.find((f) => f.id === kFee.id)!;   // the posting wrote a new state version; read the fee from it
  const c = ops.collect(h.state(), kFee.id, 7_901n, D("2026-09-25"), { payment_id: "fees-0925", from: "fees_only" });
  assert.equal(c.ok, true); assert.equal(fee().state, "collected"); assert.equal(fee().collected_cents, 7_901n); assert.equal(h.state().late_charges_due_cents, 0n);
  assert.equal(timers.byCode("FNMA_A2304_LC_COLLECTED_REPORT_MONTHLY")[0]!.status, "armed");
  assert.equal(ops.collect(h.state(), kFee.id, 1n, D("2026-09-26"), { payment_id: "x", from: "pi" }).ok, false);   // never from P&I/escrow (rule 4)
  // the 4.1 correction re-dates the payment to 2026-09-01 — the agent's fees.reverse command runs the engine's rule 6
  h.clock.set("2026-10-05T14:00:00.000Z");
  const agents = new AgentRegistry(); const cmds = bindTools({ store: new EntityStore(), ports: {}, escalations: new EscalationService(h.events, h.clock), services: {} }, agents); const bus = new CommandBus(agents);
  const ctx: UowContext = { loanId: "L-1", events: h.events, ledger: h.ledger, timers, clock: h.clock, decide: () => {} };
  const r = await bus.execute(cmds.get(toolKey("2.7", "fees.reverse"))!, AGENT, { state: h.state(), installment_due_date: "2026-09-01", credited_as_of: "2026-09-01", correction_ref: "NOE-41-7" }, ctx);
  const out = r.output as { reversed: { id: string; state: string } | null; refund_cents: string; credit_reporting_correction: boolean };
  assert.equal(out.reversed!.id, kFee.id); assert.equal(out.reversed!.state, "reversed"); assert.equal(out.refund_cents, "7901"); assert.equal(out.credit_reporting_correction, true);
  assert.equal(fee().state, "reversed"); assert.equal(h.state().installments[0]!.credited_as_of, "2026-09-01"); assert.equal(h.state().late_charges_due_cents, 0n);
  const rev = h.events.ofType("fee.reversed")[0]!; assert.equal(rev.payload.fee_id, kFee.id); assert.equal(rev.payload.refund_cents, "7901"); assert.equal(rev.payload.credited_as_of, "2026-09-01"); assert.equal(rev.payload.correction_ref, "NOE-41-7");
  assert.equal(h.events.ofType("fee.refund.due")[0]!.payload.refund_cents, "7901");
  const corr = h.events.ofType("credit.correction.requested")[0]!; assert.equal(corr.payload.for, "8.1"); assert.equal(corr.payload.correction_ref, "NOE-41-7"); assert.equal(corr.payload.credited_as_of, "2026-09-01");
  assert.equal(h.events.ofType("payment.reapplied")[0]!.payload.credited_as_of, "2026-09-01");
  // the once-only gate keys on the installment (state ≠ reversed): the re-run after the reversal finds the payment credited within grace → not_assessed, no new fee
  const again = ops.assess({ state: h.state(), installment_due_date: D("2026-09-01"), run_on: D("2026-10-06"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(again.outcome, "not_assessed"); if (again.outcome === "not_assessed") assert.equal(again.reason, "paid within grace"); assert.equal(h.state().fees!.length, 1);
  assert.equal(evaluateGate("2.7.onlyOnePerInstallment", { late_charges_for_installment_not_reversed: 0 }).open, true);
  // a re-dating that is still after the grace end reverses nothing and corrects nothing
  const late = L1(); recordFee(late, { id: "f-late", fee_type: "late_charge", installment_due_date: D("2026-09-01"), amount_cents: 7_901n, state: "assessed", assessed_on: D("2026-09-17"), collected_cents: 0n });
  assert.deepEqual(new LateChargeOps({ events: new MemoryEventStore(h.clock), clock: h.clock }).redate(late, D("2026-09-01"), D("2026-09-20"), { correction_ref: "NOE-41-8" }), { reversed: null, refund_cents: 0n, credit_reporting_correction: false });
  assert.equal(late.fees![0]!.state, "assessed");
});
test("2.7-T13: Given late charges collected in September, when 5.1 builds the period's LAR/event, then `fees.collected` equals Σ `collected_cents` for the period.", () => {
  const h = lc("2026-09-05T14:00:00.000Z", L1());
  const def = loadOverriddenRegistry().get("FNMA_A2304_LC_COLLECTED_REPORT_MONTHLY")!;
  for (const [id, due, on] of [["a", "2026-06-01", "2026-06-17"], ["b", "2026-07-01", "2026-07-17"], ["c", "2026-08-01", "2026-08-17"]] as const) recordFee(h.state, { id, fee_type: "late_charge", installment_due_date: D(due), amount_cents: 7_901n, state: "assessed", assessed_on: D(on), collected_cents: 0n });
  recordFee(h.state, { id: "d", fee_type: "nsf_fee", installment_due_date: null, amount_cents: 2_500n, state: "assessed", assessed_on: D("2026-09-03"), collected_cents: 0n });
  // collections from funds beyond the periodic payment: two late charges in September, one in October, and an NSF fee in September
  for (const [id, on] of [["a", "2026-09-05"], ["b", "2026-09-28"], ["d", "2026-09-10"], ["c", "2026-10-02"]] as const) { h.clock.set(`${on}T14:00:00.000Z`); const r = h.ops.collect(h.state, id, id === "d" ? 2_500n : 7_901n, D(on), { payment_id: `p-${on}`, from: "remainder" }); assert.equal(r.ok, true); }
  assert.deepEqual(h.state.fees!.map((f) => [f.id, f.state, f.collected_on]), [["a", "collected", "2026-09-05"], ["b", "collected", "2026-09-28"], ["c", "collected", "2026-10-02"], ["d", "collected", "2026-09-10"]]);
  assert.equal(h.state.late_charges_due_cents, 0n); assert.equal(h.state.nsf_fees_due_cents, 0n);
  assert.equal(collectedForPeriod(h.state.fees!, "2026-09"), 15_802n);   // Σ collected_cents for September's late charges (the NSF fee is not a late charge)
  assert.equal(collectedForPeriod(h.state.fees!, "2026-10"), 7_901n);
  // 5.1 builds September's LAR/event: `fees.collected` = 15,802¢
  const rep = h.ops.reportCollected(h.state, "2026-09"); assert.equal(rep.fees_collected_cents, 15_802n);
  const ev = h.events.ofType("investor_events.created").find((e) => e.payload.type === "fees.collected")!; assert.equal(ev.payload.fees_collected_cents, "15802"); assert.equal(ev.payload.period, "2026-09");
  assert.throws(() => h.ops.reportCollected(h.state, "September"), RangeError);
  // FNMA_A2304_LC_COLLECTED_REPORT_MONTHLY: each `fee.collected{late_charge}` arms the monthly reporting row; the NSF collection does not; 5.1's acceptance closes it
  const collected = h.events.ofType("fee.collected"); assert.equal(collected.length, 4);
  assert.deepEqual(collected.map((e) => eventMatches(def.triggerPattern!, e)), [true, true, false, true]);
  assert.equal(h.timers.byCode("FNMA_A2304_LC_COLLECTED_REPORT_MONTHLY").filter((t) => t.status === "armed").length, 3);
  h.events.append({ type: "investor_events.acked", loanId: "L-1", actor: AGENT, payload: { type: "fees.collected", period: "2026-09", fees_collected_cents: "15802" } });
  assert.equal(h.timers.byCode("FNMA_A2304_LC_COLLECTED_REPORT_MONTHLY").filter((t) => t.status === "satisfied").length, 3);
});
