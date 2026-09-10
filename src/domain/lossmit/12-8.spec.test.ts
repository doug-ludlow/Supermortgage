// 12.8 Fannie Mae Flex Modification
// spec/sections/12-loss-mitigation/12-8-fannie-mae-flex-modification.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { streamlinedSolicitationWindow, mbsExecutionGate, modDocumentClocks, conversionLedger, postConversionLedger, flexIncentive, flexEligibilityDenial, mirLookup, bindingConditions, form3179Changes, roundCents } from "./ops.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { waterfall, balanceAfter, accruedInterest, trialSchedule, trialCount, trialMonthMet, type WaterfallInputs, type WaterfallResult } from "./flexmod.ts";
import { newPayment } from "./deferral.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FlexModService, type MirVersion } from "./ops-12-8.ts";
import { CashieringOps } from "../cashiering/ops.ts";
import { newTrial } from "../cashiering/trial.ts";
import type { LoanCashState } from "../cashiering/types.ts";
import { CommandBus, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolDef, type ToolInput } from "../../app/tools.ts";
import { SECTION_12_TOOLS } from "../../app/tools/section12.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";

/** The worked example: $250,000 / 6.5% / 8 months delinquent, value $290,000, MIR 6.625%. */
const W: WaterfallInputs = { ib_upb_cents: 23_676_547n, accrued_interest_cents: 1_025_984n, escrow_advances_cents: 420_000n, servicing_advances_cents: 18_000n, prior_nib_cents: 0n, value_cents: 29_000_000n, contract_rate_pct: "6.500", is_arm_not_final: false, remaining_term_months: 309, pre_mod_pi_cents: 158_017n, mir_pct: "6.625", delinquent_31_plus: true };

const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const toolKey = (process: string, name: string): string => `${process} ${name}`;
/** The §12 bus alone (the 12-7 pattern): 12.8's `flexmod.waterfall` bound to its agent without importing every other section's tools. */
function bindSection12(rt: ToolRuntime, agents: AgentRegistry, defs: readonly ToolDef[] = SECTION_12_TOOLS): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of defs) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}
/** The Modification Interest Rate exhibit as the spec verifies it: 6.625% effective 2026-08-14, 6.750% effective 2026-09-15 — the evaluation-date (2026-09-09) rate is 6.625%. */
const MIR_TABLE: readonly MirVersion[] = [{ effective: D("2026-08-14"), rate_pct: "6.625" }, { effective: D("2026-09-15"), rate_pct: "6.750" }];
const VALUATION = { method: "smdu_avm", value_cents: 29_000_000n, as_of: D("2026-09-02"), confidence: "reliable" as const };
const { mir_pct: _mirOnW, ...EVAL_INPUTS } = W;   // `FlexModService.evaluate` looks the MIR up itself (rule 1)
void _mirOnW;
/** 2.6's view of the worked-example loan: eight unpaid installments 2026-02-01…2026-09-01 (P&I $1,580.17 + escrow $520.00), no funds in suspense. */
function cashState(loanId: string): LoanCashState {
  const installments = Array.from({ length: 8 }, (_, i) => ({ due_date: addMonths(D("2026-02-01"), i), pi_cents: 158_017n, escrow_cents: 52_000n, status: "due" as const }));
  return { loan_id: loanId, instrument_date: D("2021-09-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: 23_676_547n, lpi_date: D("2026-01-01"), installments, late_charges_due_cents: 50_568n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: true, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false };
}
/** The 12.8 lifecycle on the event store: `FlexModService` (the process's command/ingestion surface), cashiering's trial ledger (2.6) and the TimerEngine arming the 12.8 and 2.6 rows. */
function flexHarness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["12.8", "2.6"] });
  const svc = new FlexModService({ events, clock }); const cash = new CashieringOps({ events, clock });
  const evaluateLoan = (loanId: string, delinquent31Plus: boolean, extra: { imminent_default?: boolean; last_trial_failed_on?: PlainDate } = {}) =>
    svc.evaluate({ loan_id: loanId, case_id: `C-${loanId}`, basis: "brp", evaluation_on: D("2026-09-09"), inputs: { ...EVAL_INPUTS, delinquent_31_plus: delinquent31Plus }, mir_table: MIR_TABLE, valuation: VALUATION, mbs: false, recording_required: true, prior_modifications: 0, ...extra });
  const offer = (loanId: string, noticeSentOn: PlainDate) => svc.offerTpp({ loan_id: loanId, notice_sent_on: noticeSentOn, ti_monthly_cents: 52_000n, shortage_monthly_cents: 3_100n, escrow_analysis_on: D("2026-09-08"), escrow_established: true });
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  return { clock, events, timers, svc, cash, evaluateLoan, offer, emitted };
}

test("12.8-T1: (waterfall) Given the worked example, when the waterfall runs, then gross UPB $251,405.31, MTMLTV 86.69%, rate 6.500%, term 480, forbearance $35,483.32, IB UPB $215,921.99, P&I $1,264.13, reduction 20.0004%; step trace matches.", async () => {
  const w = waterfall(W);
  assert.equal(w.gross_upb_cents, 25_140_531n); assert.equal(w.mtmltv, "86.69"); assert.equal(w.rate_pct, "6.500"); assert.equal(w.term_months, 480);
  assert.equal(w.forborne_cents, 3_548_332n); assert.equal(w.ib_upb_cents, 21_592_199n); assert.equal(w.pi_cents, 126_413n); assert.equal(w.target_pi_cents, 126_413n); assert.equal(w.reduction_pct, "20.0004"); assert.equal(w.post_mod_ib_mtmltv, "74.46"); assert.equal(w.eligible, true);
  assert.deepEqual(w.trace.slice(0, 4), ["step1 gross=25140531 mtmltv=86.69%", "step2 rate=6.500", "step3 skipped (mtmltv<50 or rate≤MIR)", "step4 term→480 pi=147187"]);
  assert.match(w.trace[4]!, /^step5 a=3548332 b=10640531 c=7542159 forborne=3548332 ib=21592199 pi=126413$/);
  // The same run through the process's `flexmod.waterfall` bus tool (guardrail: the LLM never computes terms — it calls the waterfall); the MIR in effect on the 2026-09-09 evaluation date is the 2026-08-14 posting, not the 2026-09-15 one.
  const clock = new FixedClock("2026-09-09T15:00:00.000Z"); const events = new MemoryEventStore(clock);
  const ctx: UowContext = { loanId: "L-128-T1", events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} };
  const agents = new AgentRegistry(); const cmds = bindSection12({ store: new EntityStore(), ports: {}, escalations: new EscalationService(events, clock), services: {} }, agents); const bus = new CommandBus(agents);
  const out = (await bus.execute(cmds.get(toolKey("12.8", "flexmod.waterfall"))!, AGENT, { loan_id: "L-128-T1", inputs: W, mir_table: MIR_TABLE, evaluation_on: "2026-09-09" }, ctx)).output as WaterfallResult & { mir_version: MirVersion };
  assert.deepEqual(out.mir_version, { effective: "2026-08-14", rate_pct: "6.625" });
  assert.equal(out.gross_upb_cents, 25_140_531n); assert.equal(out.mtmltv, "86.69"); assert.equal(out.rate_pct, "6.500"); assert.equal(out.term_months, 480); assert.equal(out.forborne_cents, 3_548_332n); assert.equal(out.ib_upb_cents, 21_592_199n); assert.equal(out.pi_cents, 126_413n); assert.equal(out.reduction_pct, "20.0004");
  assert.deepEqual(out.trace, w.trace);
  // The step trace is the decision record's `waterfall_steps`: `FlexModService.evaluate` carries the terms on `lossmit.evaluation.decided{outcome=tpp_offer}` (the 5-day Evaluation Notice clock).
  const h = flexHarness("2026-09-09T15:00:00.000Z"); const m = h.evaluateLoan("L-128-T1", true);
  assert.equal(m.status, "eligible"); assert.deepEqual(m.waterfall!.trace, w.trace); assert.deepEqual(m.mod_interest_rate_version, { effective: "2026-08-14", rate_pct: "6.625" }); assert.equal(m.exhaustion_offer, false);
  const decided = h.emitted("lossmit.evaluation.decided")[0]!; assert.equal(decided.payload.outcome, "tpp_offer"); assert.deepEqual(decided.payload.terms, { rate_pct: "6.500", term_months: 480, ib_upb_cents: "21592199", forborne_cents: "3548332", pi_cents: "126413" });
  const five = h.timers.byCode("FNMA_D2205_EVAL_NOTICE_TPP_5")[0]!; assert.equal(five.status, "armed"); assert.equal(five.anchorDate, "2026-09-09"); assert.equal(five.dueDate, "2026-09-14");
});
test("12.8-T2: (cap c) value $200,000 → MTMLTV 125.70%; (a) $35,483.32, (b) $151,405.31, (c) $75,421.59 → forbearance (a) again; value $150,000 with a larger arrearage where (a) > (c) → forbearance = 30% cap and exhaustion-rule check applied.", () => {
  const w2 = waterfall({ ...W, value_cents: 20_000_000n });
  assert.equal(w2.mtmltv, "125.70"); assert.deepEqual(w2.forbearance_caps, { a: 3_548_332n, b: 15_140_531n, c: 7_542_159n }); assert.equal(w2.forborne_cents, 3_548_332n); assert.equal(w2.pi_cents, 126_413n);
  // $150,000 value and a $60,000 prior NIB rolled into the arrearage: (a) exceeds (c), so the 30% cap binds, the target is missed, and the exhaustion rule decides eligibility.
  const w3 = waterfall({ ...W, value_cents: 15_000_000n, prior_nib_cents: 6_000_000n });
  assert.equal(w3.gross_upb_cents, 31_140_531n); assert.equal(w3.mtmltv, "207.60"); assert.deepEqual(w3.forbearance_caps, { a: 9_548_332n, b: 23_640_531n, c: 9_342_159n });
  assert.ok(w3.forbearance_caps!.a > w3.forbearance_caps!.c); assert.equal(w3.forborne_cents, 9_342_159n); assert.equal(w3.forborne_cents, roundCents(w3.gross_upb_cents * 30n, 100n));
  assert.ok(w3.pi_cents > w3.target_pi_cents); assert.equal(w3.pi_cents, 127_620n); assert.ok(w3.pi_cents <= W.pre_mod_pi_cents); assert.equal(w3.eligible, true);   // exhausted, offered under the ≤ rule (31+ days delinquent)
  // The exhaustion offer is recorded as such by the service (`exhaustion_offer=true` on the decision) rather than silently offered as a target hit.
  const h = flexHarness("2026-09-09T15:00:00.000Z");
  const m = h.svc.evaluate({ loan_id: "L-128-T2", case_id: "C-T2", basis: "brp", evaluation_on: D("2026-09-09"), inputs: { ...EVAL_INPUTS, value_cents: 15_000_000n, prior_nib_cents: 6_000_000n }, mir_table: MIR_TABLE, valuation: { ...VALUATION, value_cents: 15_000_000n }, mbs: false, recording_required: true, prior_modifications: 0 });
  assert.equal(m.status, "eligible"); assert.equal(m.exhaustion_offer, true); assert.equal(m.waterfall!.forborne_cents, 9_342_159n); assert.equal(h.emitted("lossmit.evaluation.decided")[0]!.payload.exhaustion_offer, true);
});
test("12.8-T3: (exhaustion/P&I rule) current borrower (imminent default), terms exhausted with new P&I = pre-mod P&I → ineligible (must be strictly less); 31+ days delinquent → eligible (≤).", () => {
  // A current borrower (no accrued interest or advances) with a large prior NIB: every step is exhausted and the 30% cap binds, so the post-modification P&I is fixed at $1,380.13 whatever the target.
  const current: WaterfallInputs = { ...W, accrued_interest_cents: 0n, escrow_advances_cents: 0n, servicing_advances_cents: 0n, prior_nib_cents: 10_000_000n, value_cents: 15_000_000n, delinquent_31_plus: false };
  const probe = waterfall(current); assert.ok(probe.pi_cents > probe.target_pi_cents); assert.equal(probe.forborne_cents, probe.forbearance_caps!.c);
  const equal = waterfall({ ...current, pre_mod_pi_cents: probe.pi_cents });
  assert.equal(equal.pi_cents, probe.pi_cents); assert.equal(equal.pi_cents, 138_013n); assert.equal(equal.eligible, false); assert.equal(equal.reason, "INV_FNMA_F127_PI_RULE");
  const delinquent = waterfall({ ...current, pre_mod_pi_cents: probe.pi_cents, delinquent_31_plus: true });
  assert.equal(delinquent.pi_cents, probe.pi_cents); assert.equal(delinquent.eligible, true); assert.equal(delinquent.reason, undefined);
  assert.equal(waterfall({ ...current, pre_mod_pi_cents: probe.pi_cents + 1n }).eligible, true);   // strictly less by one cent → eligible for the current borrower
  // Rule 9: the P&I-rule failure is a modification denial — `lossmit.evaluation.decided{outcome=denied, reason_code=INV_FNMA_F127_PI_RULE}` to the `lossmit_reviewer` with appeal rights; the 31+ day loan is offered.
  const h = flexHarness("2026-09-09T15:00:00.000Z"); const { mir_pct: _m, ...cur } = { ...current, pre_mod_pi_cents: probe.pi_cents }; void _m;
  const denied = h.svc.evaluate({ loan_id: "L-128-T3", case_id: "C-T3", basis: "brp", evaluation_on: D("2026-09-09"), inputs: cur, mir_table: MIR_TABLE, valuation: { ...VALUATION, value_cents: 15_000_000n }, imminent_default: true, mbs: false, recording_required: true, prior_modifications: 0 });
  assert.equal(denied.status, "denied"); assert.deepEqual(denied.denial, { criterion: "the modified principal and interest payment must be less than (current or less than 31 days delinquent) or less than or equal to (31 or more days delinquent) the pre-modification payment when the waterfall steps are exhausted", reason_code: "INV_FNMA_F127_PI_RULE" });
  const d = h.emitted("lossmit.evaluation.decided").find((e) => e.loanId === "L-128-T3")!; assert.equal(d.payload.outcome, "denied"); assert.equal(d.payload.reviewer_required, true); assert.equal(d.payload.appeal_rights, true); assert.equal(d.payload.pi_cents, "138013"); assert.equal(d.payload.pre_mod_pi_cents, "138013");
  assert.equal(h.svc.evaluate({ loan_id: "L-128-T3b", case_id: "C-T3b", basis: "brp", evaluation_on: D("2026-09-09"), inputs: { ...cur, delinquent_31_plus: true }, mir_table: MIR_TABLE, valuation: { ...VALUATION, value_cents: 15_000_000n }, mbs: false, recording_required: true, prior_modifications: 0 }).status, "eligible");
});
test("12.8-T4: (trial timing) notice sent 2026-09-16 → first trial payment 2026-11-01; payment received 2026-11-30 = met; received 2026-12-01 = failed.", async () => {
  const ts = trialSchedule(D("2026-09-16"), 3, 52_000n, 3_100n, 126_413n);
  assert.deepEqual(ts.due_dates, ["2026-11-01", "2026-12-01", "2027-01-01"]); assert.equal(ts.effective, "2027-02-01");
  assert.equal(trialMonthMet(D("2026-11-30"), D("2026-11-01"), 181_513n, 181_513n), true); assert.equal(trialMonthMet(D("2026-12-01"), D("2026-11-01"), 181_513n, 181_513n), false);
  assert.equal(trialMonthMet(D("2026-11-30"), D("2026-11-01"), 181_512n, 181_513n), false);   // no de-minimis shortfall (open question 5 default: strict)
  assert.equal(trialSchedule(D("2026-09-15"), 3, 52_000n, 3_100n, 126_413n).due_dates[0], "2026-10-01");
  // On the engine: the Evaluation Notice sent 2026-09-16 (after the 15th) → `lossmit.tpp.offered{first_trial_due_date=2026-11-01}` arms FNMA_D23206_TPP_FIRST_DUE_15TH_RULE on that date; the schedule handed to cashiering satisfies it and arms one FNMA_D23206_TRIAL_PAYMENT_EOM (2.6) per trial month, due the last day of that month.
  const h = flexHarness("2026-09-16T15:00:00.000Z"); const A = "L-128-T4";
  h.evaluateLoan(A, true);
  const offer = await h.offer(A, D("2026-09-16"));
  assert.deepEqual(offer.trial.due_dates, ["2026-11-01", "2026-12-01", "2027-01-01"]); assert.equal(offer.trial.first_due, "2026-11-01"); assert.equal(offer.trial.trial_total_cents, 181_513n); assert.equal(offer.trial.effective, "2027-02-01");
  assert.equal(h.emitted("lossmit.tpp.offered")[0]!.payload.first_trial_due_date, "2026-11-01");
  const rule15 = h.timers.byCode("FNMA_D23206_TPP_FIRST_DUE_15TH_RULE")[0]!; assert.equal(rule15.status, "armed"); assert.equal(rule15.anchorDate, "2026-11-01"); assert.equal(rule15.dueDate, "2026-11-01");
  const escrow = h.timers.byCode("FNMA_B101_ESCROW_ESTABLISH_BEFORE_TRIAL")[0]!; assert.equal(escrow.dueDate, "2026-10-31");   // escrow established before the first trial due date
  const sched = h.svc.createTrialSchedule(A); assert.equal(rule15.status, "satisfied"); assert.equal(rule15.satisfiedByEventId, h.emitted("lossmit.trial.schedule_created")[0]!.id);
  const trialA = h.cash.startTrial(newTrial(sched.case_id, A, sched.months));
  const eomA = h.timers.byCode("FNMA_D23206_TRIAL_PAYMENT_EOM"); assert.deepEqual(eomA.map((t) => t.dueDate), ["2026-11-30", "2026-12-31", "2027-01-31"]); assert.deepEqual(eomA.map((t) => t.subject.id), [`${sched.case_id}:1`, `${sched.case_id}:2`, `${sched.case_id}:3`]);
  // Received 2026-11-30 = met: cashiering's `trial_payment.satisfied{trial_number=1}` closes the November deadline; the first payment is acceptance (`tpp_active`), which arms the E-3.4-01 foreclosure-suspension gate on the loan.
  h.clock.set("2026-11-30T20:00:00.000Z"); const r1 = h.cash.trialReceipt(trialA, cashState(A), 181_513n, D("2026-11-30"));
  assert.equal(r1.satisfied_now, true); assert.equal(r1.trial_month!.due_on, "2026-11-01"); assert.equal(eomA[0]!.status, "satisfied"); assert.equal(eomA[1]!.status, "armed");
  assert.equal(h.svc.get(A)!.status, "tpp_active"); assert.equal(h.emitted("lossmit.trial.first_payment_received")[0]!.payload.payment_date, "2026-11-30");
  const fc = h.timers.byCode("FNMA_E3401_FC_SUSPEND_DURING_TRIAL"); assert.equal(fc.length, 1); assert.equal(fc[0]!.status, "armed"); assert.equal(fc[0]!.loanId, A);
  // Received 2026-12-01 = failed: loan B's first payment lands in December, so November is unpaid at 23:59 on 2026-11-30 — the November deadline breaches, the month-end sweep emits `lossmit.trial.failed{failed_on=2026-11-30}`, 12.8 records the failure and the 12-month bar arms on it.
  const B = "L-128-T4b"; h.clock.set("2026-09-16T15:00:00.000Z"); h.evaluateLoan(B, true); await h.offer(B, D("2026-09-16"));
  const schedB = h.svc.createTrialSchedule(B); const trialB = h.cash.startTrial(newTrial(schedB.case_id, B, schedB.months));
  h.clock.set("2026-12-01T15:00:00.000Z"); const rB = h.cash.trialReceipt(trialB, cashState(B), 181_513n, D("2026-12-01"));
  assert.equal(rB.trial_month!.due_on, "2026-12-01"); assert.equal(trialB.months[0]!.status, "pending"); assert.equal(h.svc.get(B)!.status, "tpp_offered");
  const breached = h.timers.evaluate("2026-12-01T05:00:00.000Z").filter((b) => b.instance.code === "FNMA_D23206_TRIAL_PAYMENT_EOM");
  assert.deepEqual(breached.map((b) => b.instance.subject.id), [`${schedB.case_id}:1`]);
  const sweep = h.cash.trialMonthEnd(trialB, rB.state, D("2026-11-30")); assert.equal(sweep.failed, true); assert.equal(sweep.missed!.due_on, "2026-11-01");
  const failedB = h.emitted("lossmit.trial.failed").find((e) => e.loanId === B)!; assert.equal(failedB.payload.failed_on, "2026-11-30");
  assert.equal(h.svc.get(B)!.status, "tpp_failed"); assert.equal(h.svc.get(B)!.last_trial_failed_on, "2026-11-30");
  const bar = h.timers.byCode("FNMA_D23206_NO_NEW_TRIAL_12M").find((t) => t.loanId === B)!; assert.equal(bar.status, "armed"); assert.equal(bar.anchorDate, "2026-11-30");
  assert.equal(h.svc.evaluate({ loan_id: B, case_id: "C-B2", basis: "brp", evaluation_on: D("2027-03-01"), inputs: EVAL_INPUTS, mir_table: MIR_TABLE, valuation: { ...VALUATION, as_of: D("2027-02-20") }, mbs: false, recording_required: true, prior_modifications: 0, last_trial_failed_on: D("2026-11-30") }).denial!.reason_code, "FNMA_D23206_TRIAL_FAILED_12M");
  // The performing-trial gate closes only on the same loan's failure: loan A misses December → `lossmit.trial.failed` satisfies it (13.x may proceed); loan B's failure left it untouched.
  assert.equal(fc[0]!.status, "armed");
  const sweepA = h.cash.trialMonthEnd(trialA, r1.state, D("2026-12-31")); assert.equal(sweepA.failed, true); assert.equal(fc[0]!.status, "satisfied"); assert.equal(fc[0]!.satisfiedByEventId, h.emitted("lossmit.trial.failed").find((e) => e.loanId === A)!.id);
});
test("12.8-T5: (four-month trial) current borrower → 4 trial payments.", async () => {
  assert.equal(trialCount(false), 4); assert.equal(trialCount(true), 3);
  const ts = trialSchedule(D("2026-09-11"), trialCount(false), 52_000n, 3_100n, 126_413n);
  assert.deepEqual(ts.due_dates, ["2026-10-01", "2026-11-01", "2026-12-01", "2027-01-01"]); assert.equal(ts.effective, "2027-02-01"); assert.equal(ts.capitalization_date, "2027-01-01"); assert.equal(ts.incentive_deadline, "2027-03-31");
  // Through the service: a current borrower in imminent default (delinquent_31_plus=false) is offered four trial payments on the 2026-09-11 Evaluation Notice (≤15th → first due 2026-10-01); the schedule hands four rows to cashiering, each arming its own month-end deadline.
  const h = flexHarness("2026-09-11T15:00:00.000Z"); const A = "L-128-T5";
  const m = h.evaluateLoan(A, false, { imminent_default: true }); assert.equal(m.status, "eligible"); assert.equal(m.imminent_default, true); assert.equal(m.delinquent_31_plus, false);
  const offer = await h.offer(A, D("2026-09-11"));
  assert.equal(offer.trial.months, 4); assert.deepEqual(offer.trial.due_dates, ["2026-10-01", "2026-11-01", "2026-12-01", "2027-01-01"]); assert.equal(offer.trial.effective, "2027-02-01"); assert.equal(offer.trial.capitalization_date, "2027-01-01"); assert.equal(offer.trial.incentive_deadline, "2027-03-31");
  const offered = h.emitted("lossmit.tpp.offered")[0]!; assert.equal(offered.payload.trial_months, 4); assert.equal(offered.payload.first_trial_due_date, "2026-10-01"); assert.equal(offered.payload.effective_date, "2027-02-01");
  const sched = h.svc.createTrialSchedule(A); assert.equal(sched.months.length, 4); assert.ok(sched.months.every((r) => r.amount_cents === 181_513n));
  h.cash.startTrial(newTrial(sched.case_id, A, sched.months));
  assert.deepEqual(h.timers.byCode("FNMA_D23206_TRIAL_PAYMENT_EOM").map((t) => t.dueDate), ["2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31"]);
  assert.equal(h.timers.byCode("FNMA_D23206_TPP_FIRST_DUE_15TH_RULE")[0]!.status, "satisfied");
  // 31+ days delinquent on the same notice date → three (the worked example: 2026-10-01, 2026-11-01, 2026-12-01; effective 2027-01-01).
  const B = "L-128-T5b"; h.evaluateLoan(B, true); const three = await h.offer(B, D("2026-09-11"));
  assert.equal(three.trial.months, 3); assert.deepEqual(three.trial.due_dates, ["2026-10-01", "2026-11-01", "2026-12-01"]); assert.equal(three.trial.effective, "2027-01-01");
});
test("12.8-T6: (solicitation window) day 90 on 2026-11-02 with no BRP → solicitation by 2026-11-17; a non-judicial sale scheduled 2026-11-25 → solicitation refused.", () => {
  const ok = streamlinedSolicitationWindow({ day90_on: D("2026-11-02"), brp_complete: false, sale_on: null, judicial: false }); assert.equal(ok.solicit_by, "2026-11-17"); assert.equal(ok.allowed, true);
  const near = streamlinedSolicitationWindow({ day90_on: D("2026-11-02"), brp_complete: false, sale_on: D("2026-11-25"), judicial: false }); assert.equal(near.allowed, false); assert.match(near.refusal!, /SALE_PROXIMITY/);
});
test("12.8-T7: (MBS) MBS loan → servicer execution blocked until `smdu.case.reclassified`; effective date re-dated if needed.", () => {
  const blocked = mbsExecutionGate({ mbs: true, reclassified_on: null, effective: D("2027-01-01") }); assert.equal(blocked.execution_allowed, false); assert.match(blocked.refusal!, /smdu\.case\.reclassified/);
  const late = mbsExecutionGate({ mbs: true, reclassified_on: D("2027-01-05"), effective: D("2027-01-01") }); assert.equal(late.execution_allowed, true); assert.equal(late.effective, "2027-02-01"); assert.equal(late.redated, true);
  assert.equal(mbsExecutionGate({ mbs: false, reclassified_on: null, effective: D("2027-01-01") }).execution_allowed, true);
});
test("12.8-T8: (documents) Form 3179 sent 2026-12-01; borrower e-signs 2026-12-10; `signing_officer` executes 2026-12-28; recording required → certified copy of the executed agreement to the custodian by 2027-01-04 (25 days from 2026-12-10), e-recorded 2027-01-05, original to the custodian within 5 BD of receipt from the recorder; an unrecorded agreement instead goes as the fully executed original by 2027-01-04.", () => {
  const r = modDocumentClocks({ form_3179_sent_on: D("2026-12-01"), borrower_signed_on: D("2026-12-10"), servicer_executed_on: D("2026-12-28"), servicer_role: "signing_officer", recording_required: true, erecorded_on: D("2027-01-05"), recorded_original_received_on: D("2027-01-20") });
  assert.equal(r.allowed, true); assert.deepEqual(r.custodian_anchor, { basis: "executed_agreement_received", on: "2026-12-10" }); assert.equal(r.certified_copy_to_custodian_by, "2027-01-04"); assert.equal(r.erecorded_on, "2027-01-05"); assert.equal(r.original_to_custodian_by, "2027-01-27"); assert.equal(r.servicer_executed_on, "2026-12-28");
  const unrecorded = modDocumentClocks({ form_3179_sent_on: D("2026-12-01"), borrower_signed_on: D("2026-12-10"), servicer_executed_on: D("2026-12-28"), servicer_role: "signing_officer", recording_required: false }); assert.equal(unrecorded.unrecorded_original_by, "2027-01-04"); assert.equal(unrecorded.erecorded_on, null);
  // The three binding conditions (D2-3.2-06) hold only once the trial is complete and both parties have executed; Form 3179 leaves on the template with catalog riders only.
  assert.equal(bindingConditions({ tpp_completed: true, borrower_executed_on: D("2026-12-10"), servicer_executed_on: D("2026-12-28"), servicer_role: "signing_officer" }).binding, true);
  const notYet = bindingConditions({ tpp_completed: true, borrower_executed_on: D("2026-12-10") }); assert.equal(notYet.binding, false); assert.match(notYet.refusal!, /not executed and dated by the servicer/);
  assert.match(bindingConditions({ tpp_completed: false, borrower_executed_on: D("2026-12-10"), servicer_executed_on: D("2026-12-28"), servicer_role: "signing_officer" }).refusal!, /trial period plan not completed/);
  assert.equal(form3179Changes({ template: "DOC_FNMA_FORM_3179", riders: ["tx_50a6"] }).allowed, true);
  assert.match(form3179Changes({ template: "DOC_FNMA_FORM_3179", riders: ["custom_waiver"], free_text_edits: ["strike paragraph 4"] }).refusal!, /riders outside the catalog: custom_waiver; 1 free-text edit/);
});
test("12.8-T9: (conversion ledger) capitalization entries balance; late charges $505.68 waived; NIB $35,483.32 in `forborne_principal`; loan terms versioned effective 2027-01-01; delinquency reset; loan-data change acked.", () => {
  const r = conversionLedger({ ...W, late_charges_cents: 50_568n, effective: D("2027-01-01"), loan_data_change_acked: true });
  assert.equal(r.balanced, true); assert.equal(r.late_charges_waived_cents, 50_568n); assert.equal(r.forborne_principal_cents, 3_548_332n);
  assert.deepEqual(r.loan_terms_version, { effective: "2027-01-01", rate_pct: "6.500", term_months: 480, ib_upb_cents: 21_592_199n }); assert.equal(r.next_due, "2027-01-01"); assert.equal(r.delinquency_reset, true); assert.deepEqual(r.loan_data_change, { reported: true, acked: true });
  assert.ok(r.postings.every((p) => p.rule_ref.startsWith("12.8.capitalization")));
  assert.equal(r.capitalized_cents, 1_463_984n); assert.equal(r.ib_principal_after_cents, 21_592_199n); assert.equal(r.ib_principal_equals_waterfall, true);   // 236,765.47 + 14,639.84 − 35,483.32
  // F-1-27 step 1 also capitalizes a prior non-interest-bearing balance: the $60,000 prior NIB of 12.8-T2's third case is credited out of `deferred_principal`, and the ledger's IB principal still equals the waterfall's IB UPB.
  const nib = conversionLedger({ ...W, value_cents: 15_000_000n, prior_nib_cents: 6_000_000n, late_charges_cents: 50_568n, effective: D("2027-01-01"), loan_data_change_acked: true });
  assert.equal(nib.balanced, true); assert.equal(nib.prior_nib_cents, 6_000_000n); assert.equal(nib.postings.find((p) => p.account === "deferred_principal")!.credit, 6_000_000n); assert.equal(nib.capitalized_cents, 7_463_984n);
  assert.equal(nib.ib_principal_after_cents, waterfall({ ...W, value_cents: 15_000_000n, prior_nib_cents: 6_000_000n }).ib_upb_cents); assert.equal(nib.ib_principal_equals_waterfall, true); assert.equal(nib.forborne_principal_cents, 9_342_159n);
  // The posting runs through the kernel ledger under rule_ref 12.8.capitalization and emits `ledger.posted{rule_ref}` — the `FNMA_F127_CAPITALIZATION_DATE` satisfier — on the capitalization date (effective − 1 month).
  const clock = new FixedClock("2026-12-01T15:00:00.000Z"); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const posted = postConversionLedger({ ledger, events, actor: { kind: "agent", id: "lossmit-underwriter" }, now: clock.now() }, { ...W, loan_id: "L-1", late_charges_cents: 50_568n, effective: D("2027-01-01"), loan_data_change_acked: true });
  assert.equal(posted.capitalization_date, "2026-12-01"); assert.equal(posted.set.effectiveDate, "2026-12-01"); assert.equal(posted.set.lines.reduce((a, l) => a + l.amountCents, 0n), 0n);
  // The set moves `principal` by capitalization − forbearance (+$14,639.84 − $35,483.32); on the pre-mod IB UPB of $236,765.47 that lands on the waterfall's $215,921.99.
  const principalMove = ledger.balance({ scope: "loan", loanId: "L-1", account: "principal" }); assert.equal(principalMove, 1_463_984n - 3_548_332n); assert.equal(W.ib_upb_cents + principalMove, 21_592_199n);
  assert.equal(ledger.balance({ scope: "loan", loanId: "L-1", account: "forborne_principal" }), 3_548_332n); assert.equal(ledger.balance({ scope: "loan", loanId: "L-1", account: "late_charges" }), -50_568n); assert.equal(ledger.balance({ scope: "loan", loanId: "L-1", account: "interest_due" }), -1_025_984n);
  const ev = events.all().find((e) => e.type === "ledger.posted")!; assert.equal(ev.payload.rule_ref, "12.8.capitalization"); assert.equal(ev.payload.set_id, posted.set.id);
});
test("12.8-T10: (incentive) SMDU close by 2027-02-28 → $1,000 claimed; close on 2027-03-02 → no claim, sev-3 logged.", () => {
  // F-2-02: two months from the last day of the month in which the final trial payment (2026-12-01) is due → 2027-02-28, whether or not a January processing month re-dates the effective date.
  const ok = flexIncentive({ final_trial_due_on: D("2026-12-01"), smdu_closed_on: D("2027-02-28") }); assert.equal(ok.deadline, "2027-02-28"); assert.equal(ok.claim_cents, 100_000n); assert.equal(ok.claimed, true); assert.equal(ok.escalation, null);
  const late = flexIncentive({ final_trial_due_on: D("2026-12-01"), smdu_closed_on: D("2027-03-02") }); assert.equal(late.claim_cents, 0n); assert.equal(late.escalation!.severity, "sev3");
  assert.equal(trialSchedule(D("2026-09-11"), 3, 52_000n, 3_100n, 126_413n, true).incentive_deadline, "2027-02-28");   // processing month: effective 2027-02-01, incentive deadline unchanged
  assert.equal(flexIncentive({ final_trial_due_on: D("2026-12-01"), smdu_closed_on: D("2027-03-15") }).claimed, false);
});
test("12.8-T11: (three prior mods) denial with the specific Fannie Mae criterion; reviewer approval; appeal rights.", () => {
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_REGX_41C1_DENIAL", D("2026-11-02"))!;
  const criterion = "the mortgage loan has not been modified three or more times previously";
  const payload = { ...v.samplePayload, denied: [{ name: "Flex Modification", reason: criterion, investor_name: "Fannie Mae", investor_requirement: criterion }], not_evaluated_other_criteria: true }; const out = render(v.source, payload); assert.equal(evaluateChecklist(v, payload, out).passed, true);
  const r = flexEligibilityDenial({ prior_modifications: 3, reviewer_approval_id: "rev-9", tier: "ge_90", first_filing_made: false, rendered_text: out.text });
  assert.equal(r.denied, true); assert.equal(r.criterion, criterion); assert.equal(r.notice!.names_investor, true); assert.equal(r.notice!.quotes_criterion, true); assert.equal(r.notice!.content_ok, true); assert.equal(r.notice!.mailing_allowed, true); assert.equal(r.reviewer_required, true); assert.equal(r.appeal_rights, true);
  assert.equal(flexEligibilityDenial({ prior_modifications: 3, tier: "ge_90", first_filing_made: false, rendered_text: out.text }).notice!.mailing_allowed, false);
  assert.equal(flexEligibilityDenial({ prior_modifications: 2, tier: "ge_90", first_filing_made: false }).denied, false);
});
test("12.8-T12: (MIR feed) MIR table lacks a rate for the evaluation date → waterfall refuses to run; `officer` alert.", () => {
  const empty = mirLookup([{ effective: D("2026-09-15"), rate_pct: "6.625" }], D("2026-09-09"));
  assert.equal(empty.rate_pct, null); assert.match(empty.refusal!, /no Modification Interest Rate/); assert.equal(empty.escalation!.kind, "officer");
  const ok = mirLookup([{ effective: D("2026-08-14"), rate_pct: "6.625" }, { effective: D("2026-09-15"), rate_pct: "6.750" }], D("2026-09-09")); assert.equal(ok.rate_pct, "6.625"); assert.equal(ok.effective, "2026-08-14"); assert.equal(ok.refusal, null);
});

test("12.8 worked figures: IB UPB $236,765.47; interest $1,282.48 × 8 = $10,259.84; advances $4,200.00 + $180.00; gross $251,405.31; value $290,000.00; target P&I $1,264.13; 480-month P&I $1,471.87; IB UPB $215,921.99; forbearance $35,483.32 vs (b) $106,405.31 / (c) $75,421.59; trial $1,815.13 = $1,264.13 + $520.00 + $31.00 (shortage $1,860.00); late charges $505.68 (8 × $63.21)", () => {
  assert.equal(balanceAfter(25_000_000n, "6.500", 360, 51), 23676547n); assert.equal(accruedInterest(23676547n, "6.500", 1), 128248n); assert.equal(accruedInterest(23676547n, "6.500", 8), 1025984n);
  const w = waterfall(W); assert.equal(w.gross_upb_cents, 25140531n); assert.equal(w.gross_upb_cents - W.ib_upb_cents - W.accrued_interest_cents, 420000n + 18000n); assert.equal(w.target_pi_cents, 126413n); assert.equal(w.ib_upb_cents, 21592199n); assert.equal(w.forborne_cents, 3548332n); assert.equal(w.pi_cents, 126413n);
  assert.equal(w.forbearance_caps!.b, 10640531n); assert.equal(w.forbearance_caps!.b, w.gross_upb_cents - 29000000n / 2n); assert.equal(w.forbearance_caps!.c, 7542159n); assert.ok(w.trace.some((t) => t.includes("pi=147187")));
  const shortage = newPayment(126413n, 52000n, 186000n); assert.equal(shortage.shortage_monthly_cents, 3100n);
  const ts = trialSchedule(D("2026-09-11"), 3, 52000n, shortage.shortage_monthly_cents, w.pi_cents); assert.equal(ts.trial_payment_cents, 181513n);
  const lateCharge = roundCents(158017n * 4n, 100n); assert.equal(lateCharge, 6321n);
  const led = conversionLedger({ ...W, late_charges_cents: 8n * lateCharge, effective: D("2027-01-01"), loan_data_change_acked: true }); assert.equal(led.late_charges_waived_cents, 50568n);
  assert.equal(led.postings.find((p) => p.account === "escrow_advances")!.credit, 420000n); assert.equal(led.postings.find((p) => p.account === "corporate_advances")!.credit, 18000n);
});
