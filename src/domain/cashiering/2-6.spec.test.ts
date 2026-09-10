// 2.6 Payment during modification pending (trial period)
// spec/sections/02-payment-processing-cashiering/2-6-payment-during-modification-pending-trial-period.md
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
import { newTrial, trialReceipt, trialReturn, trialMonthEnd, trialStatementDisclosure, bookingGate } from "./trial.ts";
import { TrialCashieringOps, BookingRefused, CapitalizationRefused } from "./ops-2-6.ts";
import { recordFee } from "./latecharges.ts";
import { CashieringOps } from "./ops.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { FakeFnmaSmdu } from "../../infra/integrations/fnma.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";

const TRIAL_MONTHS = () => [{ due_on: D("2026-10-01"), amount_cents: 195_900n }, { due_on: D("2026-11-01"), amount_cents: 195_900n }, { due_on: D("2026-12-01"), amount_cents: 195_900n }];
test("2.6-T1: Given a 3-month trial with amount 195,900¢, when 195,900¢ arrives 2026-10-01, then trial 1 is satisfied, funds are held, SMDU submission is made within 1 BD, and no contractual installment is applied.", () => {
  const clock = new FixedClock("2026-10-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.6"] });
  const ops = new CashieringOps({ events, clock });
  const trial = ops.startTrial(newTrial("SMDU-1", "L-1", TRIAL_MONTHS()));
  assert.deepEqual(timers.byCode("FNMA_D23206_TRIAL_PAYMENT_EOM").map((t) => t.dueDate), ["2026-10-31", "2026-11-30", "2026-12-31"]);   // one deadline per trial month, 23:59 on the month end
  const s = L1({ lpi_date: D("2026-06-01"), trial_active: true }, D("2026-07-01"), 6);
  const r = ops.trialReceipt(trial, s, 195_900n, D("2026-10-01"));
  assert.equal(r.trial_month!.status, "satisfied"); assert.equal(r.satisfied_now, true); assert.equal(r.contractual, null); assert.equal(trial.held_cents, 195_900n);
  assert.equal(events.ofType("trial_payment.satisfied")[0]!.payload.trial_number, 1);
  assert.deepEqual(timers.byCode("FNMA_D23206_TRIAL_PAYMENT_EOM").map((t) => t.status), ["satisfied", "armed", "armed"]);
  const smdu = timers.byCode("FNMA_F122_TRIAL_PAYMENT_SMDU_REPORT_1BD")[0]!; assert.equal(smdu.dueDate, "2026-10-02"); assert.equal(smdu.status, "satisfied");   // reported upon receipt (B2B), inside the 1 BD
  assert.equal(events.ofType("smdu.trial_payment.reported")[0]!.payload.via, "b2b"); assert.equal(r.smdu, "b2b");
  assert.equal(events.ofType("payment.applied").length, 0); assert.equal(s.installments[0]!.status, "due"); assert.equal(s.upb_cents, 24_977_400n);
  // with SMDU B2B down the same clock waits for the portal task's completion event
  const trial2 = newTrial("SMDU-9", "L-1", TRIAL_MONTHS()); const r2 = ops.trialReceipt(trial2, L1({ trial_active: true }, D("2026-07-01"), 6), 195_900n, D("2026-10-01"), { smduAvailable: false });
  assert.equal(r2.smdu, "human_portal_task"); assert.equal(events.ofType("human_portal_task.created")[0]!.payload.sla, "1 business_days_fannie_et");
});
test("2.6-T2: Given 2.6-T1, when 195,900¢ arrives 2026-11-02, then the 07/01 installment is applied with `credited_as_of` 2026-11-02, held = 172,543¢, and one `payment.contractual` event is emitted.", () => {
  const clock = new FixedClock("2026-10-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.5", "2.6"] });
  const ops = new CashieringOps({ events, clock });
  const trial = ops.startTrial(newTrial("SMDU-1", "L-1", TRIAL_MONTHS()));
  const r1 = ops.trialReceipt(trial, L1({ lpi_date: D("2026-06-01"), trial_active: true }, D("2026-07-01"), 6), 195_900n, D("2026-10-01"));
  clock.set("2026-11-02T14:00:00.000Z");
  const r = ops.trialReceipt(trial, r1.state, 195_900n, D("2026-11-02"));
  assert.equal(r.trial_month!.status, "satisfied"); assert.equal(r.contractual!.installments[0]!.due_date, "2026-07-01");
  assert.deepEqual([r.contractual!.installments[0]!.interest_cents, r.contractual!.installments[0]!.principal_cents, r.contractual!.installments[0]!.escrow_cents], [135_294n, 22_723n, 61_240n]);
  assert.equal(r.state.installments[0]!.credited_as_of, "2026-11-02"); assert.equal(r.state.lpi_date, "2026-07-01"); assert.equal(r.state.upb_cents, 24_954_677n); assert.equal(trial.held_cents, 172_543n); assert.equal(r.state.trial_active, true);
  const contractual = events.ofType("investor_events.created").filter((e) => e.payload.type === "payment.contractual"); assert.equal(contractual.length, 1); assert.equal(contractual[0]!.payload.effective_date, "2026-11-02");
  const applied = events.ofType("payment.applied"); assert.equal(applied.length, 1); assert.equal(applied[0]!.payload.credited_as_of, "2026-11-02"); assert.equal(applied[0]!.payload.source, "trial_held_funds");
  const acc = timers.byCode("REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD")[0]!; assert.equal(acc.dueDate, "2026-11-03"); assert.equal(acc.status, "satisfied");   // Σ held ≥ PITI → applied the same day
  assert.ok(events.ofType("notice.queued").some((e) => e.payload.template === "TRIAL-FUNDS-APPLIED-v1"));
  assert.equal(timers.byCode("FNMA_F122_TRIAL_PAYMENT_SMDU_REPORT_1BD")[1]!.status, "satisfied");
});
test("2.6-T3: Given trial 3 unpaid at 2026-12-31 23:59, when the month-end sweep runs, then `trial_payment.missed` fires, 12.8 fails the trial, the SMDU case is cancelled, suspended late charges become collectible, and held funds follow 2.2.", () => {
  const clock = new FixedClock("2026-10-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.2", "2.6", "6.5"] });
  const ops = new CashieringOps({ events, clock });
  const trial = ops.startTrial(newTrial("SMDU-2", "L-1", TRIAL_MONTHS()));
  let r = ops.trialReceipt(trial, L1({ lpi_date: D("2026-06-01"), trial_active: true, overlays: [{ kind: "trial_pending_waiver", from: D("2026-09-10") }] }, D("2026-07-01"), 6), 195_900n, D("2026-10-01"));
  clock.set("2026-10-17T05:30:00.000Z");
  const a = ops.runAssessment({ state: r.state, installment_due_date: D("2026-10-01"), received_toward_basis_cents: 0n, run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(a.outcome, "accrued_suspended"); assert.equal(r.state.late_charges_due_cents, 0n);
  clock.set("2026-11-02T14:00:00.000Z"); r = ops.trialReceipt(trial, r.state, 195_900n, D("2026-11-02")); assert.equal(trial.held_cents, 172_543n);
  // trial 3 never arrives: at 23:59 on 2026-12-31 the month-end deadline breaches and the sweep runs
  clock.set("2026-12-31T23:59:00.000Z");
  assert.ok(timers.evaluate("2027-01-01T05:00:00.000Z").some((b) => b.def.code === "FNMA_D23206_TRIAL_PAYMENT_EOM"));
  let cancelled: string | null = null;
  const me = ops.trialMonthEnd(trial, r.state, D("2026-12-31"), { cancelSmduCase: (id) => { cancelled = id; }, partial: { days_delinquent: 180, payment_id: "trial-held-funds", rail: "ach_credit" } });
  assert.equal(me.failed, true); assert.equal(me.missed!.due_on, "2026-12-01"); assert.equal(trial.status, "trial_failed");
  assert.equal(events.ofType("trial_payment.missed")[0]!.payload.trial_number, 3); assert.equal(events.ofType("lossmit.trial.failed")[0]!.payload.failed_on, "2026-12-31");
  assert.equal(cancelled, "SMDU-2"); assert.equal(events.ofType("smdu.case.cancelled")[0]!.payload.cite, "Servicing Guide F-1-22");
  assert.equal(me.released.length, 1); assert.equal(r.state.late_charges_due_cents, 7_901n); assert.equal(r.state.fees![0]!.state, "assessed");   // suspended charges become collectible (D2-3.2-06)
  // held 172,543¢ < P → an ordinary partial under 2.2 (contact pending) and the 30-day resolution clock from the failure date
  assert.equal(me.funds.outcome, "partial_payment_opened"); assert.equal(me.funds.item!.reason_code, "partial_payment"); assert.equal(me.funds.item!.amount_cents, 172_543n); assert.equal(me.funds.item!.status, "contact_pending");
  assert.equal(events.ofType("borrower_comms.contact_requested")[0]!.payload.intent, "partial_commitment");
  assert.equal(timers.byCode("SM_PARTIAL_COMMITMENT_CAPTURE_2BD")[0]!.dueDate, addBusinessDays(D("2026-12-31"), 2, servicer));
  assert.equal(timers.byCode("FNMA_C1102_PARTIAL_BALANCE_30")[0]!.dueDate, "2027-01-30");
  const resolve = timers.byCode("SM_TRIAL_FAILED_FUNDS_RESOLVE_30")[0]!; assert.equal(resolve.dueDate, "2027-01-30"); assert.equal(resolve.status, "armed");
  assert.ok(events.ofType("notice.queued").some((e) => e.payload.template === "TRIAL-FAILED-FUNDS-v1"));
  clock.set("2027-01-25T14:00:00.000Z"); ops.resolveFailedTrialFunds(trial, "returned", D("2027-01-25")); assert.equal(resolve.status, "satisfied"); assert.equal(trial.held_cents, 0n);
});
test("2.6-T4: Given all trial payments satisfied, when 12.8 books the modification, then the residual 149,186¢ has been applied to capitalizable arrears first and all late charges are waived; a booking attempt with an unwaived late charge is refused.", async () => {
  const clock = new FixedClock("2026-10-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.5", "2.6"] });
  const tops = new TrialCashieringOps({ events, clock }); const ops = tops.ops;
  const s = L1({ lpi_date: D("2026-06-01"), trial_active: true, overlays: [{ kind: "trial_pending_waiver", from: D("2026-09-10") }] }, D("2026-07-01"), 6);
  for (const d of ["2026-07-17", "2026-08-17", "2026-09-17"]) recordFee(s, { id: d, fee_type: "late_charge", installment_due_date: D(d.slice(0, 8) + "01"), amount_cents: 7_901n, state: "assessed", assessed_on: D(d), collected_cents: 0n });
  const trial = ops.startTrial(newTrial("SMDU-1", "L-1", TRIAL_MONTHS()));
  let r = ops.trialReceipt(trial, s, 195_900n, D("2026-10-01"));
  clock.set("2026-10-17T05:30:00.000Z"); assert.equal(ops.runAssessment({ state: r.state, installment_due_date: D("2026-10-01"), received_toward_basis_cents: 0n, run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "accrued_suspended");
  clock.set("2026-11-02T14:00:00.000Z"); r = ops.trialReceipt(trial, r.state, 195_900n, D("2026-11-02"));
  clock.set("2026-11-17T05:30:00.000Z"); assert.equal(ops.runAssessment({ state: r.state, installment_due_date: D("2026-11-01"), received_toward_basis_cents: 0n, run_on: D("2026-11-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "accrued_suspended");
  clock.set("2026-12-01T14:00:00.000Z"); r = ops.trialReceipt(trial, r.state, 195_900n, D("2026-12-01"));
  clock.set("2026-12-17T05:30:00.000Z"); assert.equal(ops.runAssessment({ state: r.state, installment_due_date: D("2026-12-01"), received_toward_basis_cents: 0n, run_on: D("2026-12-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "accrued_suspended");
  assert.equal(trial.held_cents, 149_186n); assert.equal(r.state.upb_cents, 24_931_831n); assert.equal(r.state.lpi_date, "2026-08-01");
  assert.deepEqual(trialMonthEnd(trial, D("2026-12-31")), { missed: null, failed: false });
  assert.equal(bookingGate(r.state).ok, false);                                     // three assessed + three suspended charges are open
  // booking before the residual is applied: refused on the residual gate (FNMA_C1102_TRIAL_RESIDUAL_BEFORE_EFFECTIVE_0)
  assert.throws(() => tops.bookModification(trial, r.state, D("2027-01-01")), (e: unknown) => e instanceof BookingRefused && e.code === "RESIDUAL_GATE_OPEN");
  clock.set("2026-12-31T14:00:00.000Z");
  // arrears to capitalize before the residual: 4 × (24,931,831 × 0.065 ÷ 12 = 135,047.4 → 135,047) = 540,188 (spec, illustrative)
  const done = tops.completeTrial(trial, r.state, { interest_cents: 4n * ((24_931_831n * 65n + 6_000n) / 12_000n), escrow_advances_cents: 0n }, D("2027-01-01"));
  assert.equal(done.residual.residual_cents, 149_186n); assert.equal(done.residual.applied_to_interest_cents, 149_186n); assert.equal(done.residual.capitalized_interest_cents, 391_002n); assert.equal(done.residual.curtailment_cents, 0n);
  const residual = timers.byCode("FNMA_C1102_TRIAL_RESIDUAL_BEFORE_EFFECTIVE_0")[0]!; assert.equal(residual.dueDate, "2026-12-31"); assert.equal(residual.status, "satisfied");   // applied the day before the effective date
  // 12.8's capitalization computation on what is left: 391,002¢ of interest, no late charges — the F-1-27 gate arms on it and its evaluator holds
  assert.deepEqual([done.capitalization.capitalized_total_cents, done.capitalization.capitalized_interest_cents, done.capitalization.late_charges_in_capitalization_cents, done.capitalization.late_charges_excluded_cents, done.capitalization.capitalization_date], [391_002n, 391_002n, 0n, 47_406n, "2026-12-31"]);
  const capEv = events.ofType("lossmit.modification.capitalization_computed"); assert.equal(capEv.length, 1); assert.equal(capEv[0]!.payload.late_charges_in_capitalization_cents, "0"); assert.equal(capEv[0]!.payload.capitalized_total_cents, "391002"); assert.deepEqual(capEv[0]!.payload.late_charge_fee_ids, ["2026-07-17", "2026-08-17", "2026-09-17", ...(r.state.fees ?? []).filter((f) => f.state === "accrued_suspended").map((f) => f.id)]);
  const f127 = timers.byCode("FNMA_F127_LC_NOT_CAPITALIZED_GATE"); assert.equal(f127.length, 1); assert.equal(f127[0]!.status, "armed"); assert.equal(f127[0]!.note, "evaluator:2.6.lateChargesExcludedFromCapitalization"); assert.equal(f127[0]!.armedByEventId, capEv[0]!.id);
  assert.equal(evaluateGate("2.6.lateChargesExcludedFromCapitalization", capEv[0]!.payload).open, true);
  // a computation that rolls the 47,406¢ of late charges into the capitalized amount is refused and never recorded
  assert.throws(() => tops.computeCapitalization(trial, r.state, { interest_cents: 391_002n, escrow_advances_cents: 0n, late_charges_cents: 47_406n }, D("2027-01-01")), (e: unknown) => e instanceof CapitalizationRefused && e.code === "FNMA_F127_LC_NOT_CAPITALIZED_GATE");
  const refusedCap = events.ofType("lossmit.modification.capitalization.refused")[0]!; assert.equal(refusedCap.payload.late_charges_in_capitalization_cents, "47406"); assert.equal(evaluateGate("2.6.lateChargesExcludedFromCapitalization", refusedCap.payload).open, false);
  assert.equal(events.ofType("lossmit.modification.capitalization_computed").length, 1); assert.equal(tops.capitalizationFor("SMDU-1")!.capitalized_total_cents, 391_002n);
  // booking with the six late charges still unwaived is refused (FNMA_D23206_LC_WAIVE_ON_CONVERSION_0)
  assert.throws(() => tops.bookModification(trial, r.state, D("2027-01-01")), (e: unknown) => e instanceof BookingRefused && e.code === "LATE_CHARGE_UNWAIVED" && /6 late charge\(s\) must be waived/.test(e.reason));
  assert.equal(events.ofType("lossmit.modification.booking.refused").length, 2); assert.equal(events.ofType("lossmit.modification.booked").length, 0);
  // the agent cannot waive one of them as a courtesy through the 2.6 tool (the counted 2.7 command); the refusal touches nothing
  const ctx: UowContext = { loanId: "L-1", events, ledger: new MemoryLedger(), timers, clock, decide: () => {} };
  const agents = new AgentRegistry(); const cmds = bindTools({ store: new EntityStore(), ports: {}, escalations: new EscalationService(events, clock), services: {} }, agents); const bus = new CommandBus(agents);
  const feesTool = cmds.get(toolKey("2.6", "fees.suspend/waive"))!;
  await assert.rejects(bus.execute(feesTool, AGENT, { op: "waive", fee_id: "2026-07-17", reason: "courtesy", state: r.state }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "COURTESY_VIA_2_7");
  assert.equal(r.state.fees!.find((f) => f.id === "2026-07-17")!.state, "assessed"); assert.equal(r.state.late_charges_due_cents, 23_703n); assert.equal(events.ofType("fee.waived").length, 0);
  clock.set("2027-01-01T14:00:00.000Z");
  const waived = tops.modificationEffective(trial, r.state, D("2027-01-01"));
  assert.equal(waived, 47_406n);                                                    // 23,703 pre-trial + 3 × 7,901 trial-period; none capitalized
  const lc = timers.byCode("FNMA_D23206_LC_WAIVE_ON_CONVERSION_0")[0]!; assert.equal(lc.dueDate, "2027-01-01"); assert.equal(lc.status, "satisfied");
  assert.equal(events.ofType("late_charges.all_waived")[0]!.payload.reason, "trial_conversion"); assert.equal(events.ofType("fee.waived").length, 6); assert.equal(r.state.late_charges_due_cents, 0n);
  assert.equal(bookingGate(r.state).ok, true); assert.equal(trial.status, "modification_effective");
  const booked = tops.bookModification(trial, r.state, D("2027-01-01"));
  assert.equal(booked.type, "lossmit.modification.booked"); assert.equal(booked.payload.late_charges_waived_cents, "47406"); assert.equal(booked.payload.capitalized_total_cents, "391002"); assert.equal(booked.payload.late_charges_in_capitalization_cents, "0"); assert.equal(booked.payload.capitalization_date, "2026-12-31");
  // the same tool waives for trial_conversion through the engine (state, receivable and event move together), and suspends an assessed charge into the trial overlay
  const s2 = L1({ trial_active: true }, D("2026-07-01"), 6);
  recordFee(s2, { id: "lc-a", fee_type: "late_charge", installment_due_date: D("2026-07-01"), amount_cents: 7_901n, state: "assessed", assessed_on: D("2026-07-17"), collected_cents: 0n });
  recordFee(s2, { id: "lc-b", fee_type: "late_charge", installment_due_date: D("2026-08-01"), amount_cents: 7_901n, state: "assessed", assessed_on: D("2026-08-17"), collected_cents: 0n });
  const suspended = await bus.execute(feesTool, AGENT, { op: "suspend", fee_id: "lc-b", case_id: "SMDU-1", state: s2 }, ctx);
  assert.deepEqual(suspended.output, { fee_id: "lc-b", state: "accrued_suspended", suppression: "trial_pending_waiver", late_charges_due_cents: "7901" }); assert.equal(events.ofType("fee.suspended")[0]!.payload.suppression, "trial_pending_waiver");
  const w = await bus.execute(feesTool, AGENT, { op: "waive", fee_id: "lc-a", reason: "trial_conversion", state: s2 }, ctx);
  assert.deepEqual(w.output, { fee_id: "lc-a", state: "waived", reason: "trial_conversion", waived_cents: "7901", late_charges_due_cents: "0" }); assert.equal(s2.fees![0]!.waived_reason, "trial_conversion"); assert.equal(events.ofType("fee.waived").length, 7);
  await assert.rejects(bus.execute(feesTool, AGENT, { op: "waive", fee_id: "lc-b", reason: "goodwill", state: s2 }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "WAIVER_REASON");
  await assert.rejects(bus.execute(feesTool, AGENT, { op: "waive", fee_id: "lc-b", reason: "trial_conversion", state: s2, collect_from_trial_funds: true }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_LC_FROM_TRIAL_FUNDS");
});
test("2.6-T5: Given a trial receipt on a loan whose statement cycle closes the next day, when 7.1 renders, then held trial funds are disclosed with instructions.", () => {
  const trial = newTrial("SMDU-1", "L-1", [{ due_on: D("2026-10-01"), amount_cents: 195_900n }, { due_on: D("2026-11-01"), amount_cents: 195_900n }]);
  trialReceipt(trial, L1({ trial_active: true }), 100_000n, D("2026-10-16"));      // statement cycle closes 10-17
  const d = trialStatementDisclosure(trial);
  assert.equal(d.suspense_held_cents, 100_000n); assert.match(d.suspense_instructions, /holding 100000 cents .* We need 95900 cents more to satisfy the trial payment due 2026-10-01/);
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGZ_41_STMT_TPP", D("2026-10-17")) ?? reg.activeVersion("NTC_REGZ_41_STMT_STD", D("2026-10-17"))!;
  const payload = { ...v.samplePayload, ytd: { total_cents: 100_000n, suspense_held_cents: d.suspense_held_cents }, payments_since_last: { total_cents: 100_000n, principal_cents: 0n, interest_cents: 0n, escrow_cents: 0n, fees_cents: 0n, suspense_cents: 100_000n }, suspense_instructions: d.suspense_instructions };
  const r = render(v.source, payload);
  assert.match(r.text, /holding 100000 cents/); assert.equal(evaluateChecklist(v, payload, r).passed, true);
});
test("2.6-T6: Given SMDU B2B is unavailable, when a trial payment is received, then a `human_portal_task` with the full package is created and its SLA timer is the same 1 BD.", async () => {
  const clock = new FixedClock("2026-10-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const ctx: UowContext = { loanId: "L-1", events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} };
  const smdu = new FakeFnmaSmdu(); smdu.controls.setOutage(true);
  const escalations = new EscalationService(events, clock);
  const agents = new AgentRegistry(); const cmds = bindTools({ store: new EntityStore(), ports: { smdu }, escalations, services: {} }, agents); const bus = new CommandBus(agents);
  const r = await bus.execute(cmds.get(toolKey("2.6", "smdu.submit_trial_payment"))!, AGENT, { case_id: "SMDU-1", due_date: "2026-10-01", received_on: "2026-10-01", amount_cents: 195_900n }, ctx);
  const out = r.output as { portal_task_id: string; fallback: string };
  assert.equal(out.fallback, "SMDU UI");
  const task = escalations.opened.find((e) => e.id === out.portal_task_id)!;
  assert.equal(task.kind, "human_portal_task"); assert.deepEqual(task.payload.package, { case_id: "SMDU-1", due_date: "2026-10-01", received_on: "2026-10-01", amount_cents: "195900" });
  assert.equal(task.payload.sla, "1 business_days_fannie_et");
  const def = loadOverriddenRegistry().get("FNMA_F122_TRIAL_PAYMENT_SMDU_REPORT_1BD")!;               // the same 1 BD SLA either way
  assert.match(def.offset, /1 `?business_days_fannie_et`?/); assert.equal(def.satisfiedPattern!.type, "smdu.trial_payment.reported");
});
test("2.6-T7: Given a returned trial payment on 2026-11-20, when processed, then `received_cents` for November decreases, the borrower is contacted the same day, and a replacement received 2026-11-30 satisfies the month.", () => {
  const trial = newTrial("SMDU-1", "L-1", [{ due_on: D("2026-10-01"), amount_cents: 195_900n }, { due_on: D("2026-11-01"), amount_cents: 195_900n }, { due_on: D("2026-12-01"), amount_cents: 195_900n }]);
  const s = L1({ trial_active: true, lpi_date: D("2026-06-01") }, D("2026-07-01"), 6);
  trialReceipt(trial, s, 195_900n, D("2026-10-01"));
  let r = trialReceipt(trial, s, 195_900n, D("2026-11-02")); assert.equal(r.trial_month!.status, "satisfied");
  const ret = trialReturn(trial, 195_900n, D("2026-11-20"));
  assert.equal(ret.trial_month!.received_cents, 0n); assert.equal(ret.trial_month!.status, "pending"); assert.equal(ret.contact_borrower_on, "2026-11-20"); assert.equal(ret.month_short_cents, 195_900n);
  r = trialReceipt(trial, r.state, 195_900n, D("2026-11-30")); assert.equal(r.trial_month!.status, "satisfied");
  assert.deepEqual(trialMonthEnd(trial, D("2026-11-30")), { missed: null, failed: false });
});
test("2.6-T8: Given the borrower pays 219,257¢ in a trial month, when posted, then the trial month is satisfied and a contractual installment is applied on accumulation.", () => {
  const clock = new FixedClock("2026-10-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.5", "2.6"] });
  const ops = new CashieringOps({ events, clock });
  const trial = ops.startTrial(newTrial("SMDU-8", "L-1", TRIAL_MONTHS()));
  const s = L1({ lpi_date: D("2026-06-01"), trial_active: true }, D("2026-07-01"), 6);
  const P = s.installments[0]!.pi_cents + s.installments[0]!.escrow_cents; assert.equal(P, 219_257n);        // pre-modification contractual PITI (158,017 + 61,240)
  const r = ops.trialReceipt(trial, s, P, D("2026-10-01"));
  // the full contractual PITI counts as the trial payment (219,257 ≥ 195,900) …
  assert.equal(r.trial_month!.status, "satisfied"); assert.equal(r.trial_month!.received_cents, 219_257n); assert.equal(r.satisfied_now, true);
  assert.equal(events.ofType("trial_payment.satisfied")[0]!.payload.trial_number, 1);
  assert.deepEqual(timers.byCode("FNMA_D23206_TRIAL_PAYMENT_EOM").map((t) => t.status), ["satisfied", "armed", "armed"]);
  assert.equal(timers.byCode("FNMA_F122_TRIAL_PAYMENT_SMDU_REPORT_1BD")[0]!.status, "satisfied");
  // … and Σ held 219,257 ≥ P → the oldest unpaid installment (07/01) is applied on accumulation, credited as of the accumulation date
  assert.equal(r.contractual!.installments.length, 1); assert.equal(r.contractual!.installments[0]!.due_date, "2026-07-01");
  assert.deepEqual([r.contractual!.installments[0]!.interest_cents, r.contractual!.installments[0]!.principal_cents, r.contractual!.installments[0]!.escrow_cents], [135_294n, 22_723n, 61_240n]);   // 24,977,400 × 0.065 ÷ 12 = 135,294; 158,017 − 135,294 = 22,723
  assert.equal(r.state.installments[0]!.credited_as_of, "2026-10-01"); assert.equal(r.state.lpi_date, "2026-07-01"); assert.equal(r.state.upb_cents, 24_954_677n); assert.equal(r.state.trial_active, true);
  assert.equal(trial.held_cents, 0n); assert.equal(trial.applied_cents, 219_257n);
  const acc = events.ofType("suspense.accumulation.sufficient"); assert.equal(acc.length, 1); assert.equal(acc[0]!.payload.accumulated_on, "2026-10-01"); assert.equal(acc[0]!.payload.source, "trial_held_funds"); assert.equal(acc[0]!.payload.sum_cents, "219257");
  const clock1bd = timers.byCode("REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD")[0]!; assert.equal(clock1bd.dueDate, addBusinessDays(D("2026-10-01"), 1, servicer)); assert.equal(clock1bd.dueDate, "2026-10-02"); assert.equal(clock1bd.status, "satisfied");   // Thu 10/01 + 1 BD = Fri 10/02; applied the same day
  const applied = events.ofType("payment.applied"); assert.equal(applied.length, 1); assert.equal(applied[0]!.payload.installment_due_date, "2026-07-01"); assert.equal(applied[0]!.payload.credited_as_of, "2026-10-01"); assert.equal(applied[0]!.payload.source, "trial_held_funds");
  const posted = events.ofType("payment.posted"); assert.equal(posted.length, 1); assert.deepEqual([posted[0]!.payload.outcome, posted[0]!.payload.credited_as_of, posted[0]!.payload.amount_cents, posted[0]!.payload.source], ["applied", "2026-10-01", "219257", "trial_held_funds"]);   // the posting that closes the 1-BD clock
  assert.equal(events.ofType("timer.satisfied").filter((e) => e.payload.code === "REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD")[0]!.causationId, posted[0]!.id);
  assert.equal(events.ofType("investor_events.created").filter((e) => e.payload.type === "payment.contractual").length, 1);
  assert.ok(events.ofType("notice.queued").some((e) => e.payload.template === "TRIAL-FUNDS-APPLIED-v1"));
  // below the trial amount nothing is satisfied and nothing applies (guardrail: cannot mark a trial month satisfied below the trial amount)
  const short = ops.trialReceipt(ops.startTrial(newTrial("SMDU-8b", "L-1", TRIAL_MONTHS())), L1({ lpi_date: D("2026-06-01"), trial_active: true }, D("2026-07-01"), 6), 195_899n, D("2026-10-01"));
  assert.equal(short.trial_month!.status, "pending"); assert.equal(short.satisfied_now, false); assert.equal(short.contractual, null); assert.equal(events.ofType("trial_payment.satisfied").length, 1);
});
