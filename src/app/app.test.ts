/**
 * Application-layer tests: role gates, allowlists, the kill switch / AI-off
 * path, automatic decision records, refusals that write nothing, the
 * evaluator registry (every evaluator ref the timer overrides name resolves),
 * and escalations.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CommandBus, CommandRefused } from "./commands.ts";
import { AgentRegistry } from "./agents.ts";
import { requireOfficer, requireDualControl, assertNoAgentMoneyChange, RoleDenied } from "./roles.ts";
import { EVALUATORS, evaluateGate, assertGate, GateClosed, UnknownEvaluator } from "./evaluators.ts";
import { EscalationService } from "./escalations.ts";
import { boardingProposeWaiver, cashieringPostPayment, officerCertify, lossmitCreateForbearanceTerm, registerCommands, WaiverRefused } from "./catalog.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../kernel/events/index.ts";
import { MemoryLedger } from "../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../kernel/timers/index.ts";
import type { UowContext } from "../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../infra/db/decisions.ts";
import { BoardingService } from "../domain/boarding/service.ts";
import { CashieringService } from "../domain/cashiering/service.ts";
import { plainDate as D, addMonths } from "../kernel/calendar/date.ts";
import type { LoanCashState } from "../domain/cashiering/types.ts";

const AGENT: Actor = { kind: "agent", id: "cashiering" };
const BOARDING: Actor = { kind: "agent", id: "boarding" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const ANALYST: Actor = { kind: "human", id: "u-analyst", role: "ops_analyst" };

function uow(loanId = "L-1"): UowContext & { decisions: DecisionInput[] } {
  const clock = new FixedClock("2026-09-03T09:00:00.000Z");
  const events = new MemoryEventStore(clock);
  const decisions: DecisionInput[] = [];
  return { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: (d) => { decisions.push({ loanId, ...d }); }, decisions };
}
function loanL1(loanId: string): LoanCashState {
  return { loan_id: loanId, instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: 24_977_400n, lpi_date: D("2026-08-01"),
    installments: Array.from({ length: 4 }, (_, i) => ({ due_date: addMonths(D("2026-09-01"), i), pi_cents: 158_017n, escrow_cents: 61_240n, status: "due" as const })), late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false };
}
function cashiering(ctx: UowContext) {
  const store = new Map([["L-1", loanL1("L-1")]]);
  const svc = new CashieringService({ events: ctx.events, ledger: ctx.ledger, clock: ctx.clock, custodial: { clearing: "C-CL", pi: "C-PI", ti: "C-TI" }, loans: { get: (id) => store.get(id), put: (s) => { store.set(s.loan_id, s); } } });
  const { payment } = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T09:00:00.000Z", settlement_date: D("2026-09-03"), loan_id: "L-1", trace_number: "PPD-1" });
  return { svc, payment };
}

test("agent registry: 20 agents from the spec, every process has an owner, allowlists carry the spec's tools plus registered commands", () => {
  const agents = new AgentRegistry();
  assert.equal(agents.agents().length, 20);
  const processes = JSON.parse(readFileSync(new URL("../../spec/registry/processes.json", import.meta.url), "utf8")) as { id: string }[];
  const orphan = processes.map((p) => p.id).filter((id) => !agents.ownerOf(id));
  assert.deepEqual(orphan, []);
  assert.equal(agents.ownerOf("2.1"), "cashiering"); assert.equal(agents.ownerOf("11.1"), "default-collections"); assert.equal(agents.ownerOf("12.7"), "lossmit-underwriter");
  assert.ok(agents.get("cashiering").tools.includes("ledger.post"), agents.get("cashiering").tools.join(","));
  assert.equal(agents.allows("cashiering", "cashiering.postPayment"), false);
  registerCommands(agents);
  assert.equal(agents.allows("cashiering", "cashiering.postPayment"), true);
  assert.equal(agents.allows("boarding", "cashiering.postPayment"), false);
});

test("command bus: agent posts a payment through its allowlist with a decision record; a boarding agent is refused (not allowlisted) and the refusal is an event", async () => {
  const agents = new AgentRegistry(); registerCommands(agents);
  const bus = new CommandBus(agents);
  const ctx = uow(); const { svc, payment } = cashiering(ctx);
  const run = { runId: "run-1", modelVersion: "claude-fable-5-1", promptVersion: "cashiering@7", confidence: 0.99 };
  const r = await bus.execute(cashieringPostPayment, AGENT, { service: svc, paymentId: payment.id, loanId: "L-1", identificationConfidence: 0.99 }, ctx, { run });
  assert.equal(r.output.plan.outcome, "applied");
  assert.equal(ctx.decisions.length, 1);
  assert.equal(ctx.decisions[0]!.agent, "cashiering"); assert.equal(ctx.decisions[0]!.modelVersion, "claude-fable-5-1"); assert.equal(ctx.decisions[0]!.confidence, 0.99); assert.equal(ctx.decisions[0]!.ruleSetVersion, "2.1@1");
  assert.equal(ctx.events.ofType("command.executed").length, 1);
  const ctx2 = uow(); const c2 = cashiering(ctx2);
  await assert.rejects(bus.execute(cashieringPostPayment, BOARDING, { service: c2.svc, paymentId: c2.payment.id, loanId: "L-1", identificationConfidence: 0.99 }, ctx2), (e: unknown) => e instanceof CommandRefused && e.code === "NOT_ALLOWLISTED");
  assert.equal(ctx2.events.ofType("command.refused").length, 1); assert.equal(ctx2.decisions.length, 0); assert.equal(ctx2.events.ofType("payment.posted").length, 0);
});

test("guardrails (2.1): agent cannot change received_on, cannot post below 0.97 identification confidence without borrower confirmation; posting backlog gate refuses", async () => {
  const agents = new AgentRegistry(); registerCommands(agents); const bus = new CommandBus(agents);
  const ctx = uow(); const { svc, payment } = cashiering(ctx);
  await assert.rejects(bus.execute(cashieringPostPayment, AGENT, { service: svc, paymentId: payment.id, loanId: "L-1", identificationConfidence: 0.99, changes: { received_on: "2026-09-01" } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "MONEY_FIELD");
  await assert.rejects(bus.execute(cashieringPostPayment, AGENT, { service: svc, paymentId: payment.id, loanId: "L-1", identificationConfidence: 0.9 }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "IDENTIFICATION_CONFIDENCE");
  await assert.rejects(bus.execute(cashieringPostPayment, AGENT, { service: svc, paymentId: payment.id, loanId: "L-1", identificationConfidence: 0.99, postingBacklogFacts: { items_received_or_identified_on_or_before_gate_date: 3 } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "POSTING_BACKLOG");
  assert.equal(ctx.events.ofType("command.refused").length, 3);
  // borrower confirmation lifts the confidence guardrail; an ops analyst may post
  const ok = await bus.execute(cashieringPostPayment, ANALYST, { service: svc, paymentId: payment.id, loanId: "L-1", identificationConfidence: 0.9, borrowerConfirmed: true }, ctx);
  assert.equal(ok.output.payment.status, "posted"); assert.equal(ctx.decisions[0]!.approvedRole, "ops_analyst");
});

test("human acts: officer certification refuses agents and non-officers; waivers need a human approver and money-field waivers an officer (1.1); dual control needs two distinct officers", async () => {
  const agents = new AgentRegistry(); registerCommands(agents); const bus = new CommandBus(agents);
  const ctx = uow();
  const qc: Actor = { kind: "agent", id: "qc-audit" };
  await assert.rejects(bus.execute(officerCertify, qc, { kind: "form_582", packageDocumentId: "doc-1" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "HUMAN_ONLY");
  await assert.rejects(bus.execute(officerCertify, ANALYST, { kind: "form_582", packageDocumentId: "doc-1" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "ROLE_DENIED");
  const r = await bus.execute(officerCertify, OFFICER, { kind: "form_582", packageDocumentId: "doc-1" }, ctx);
  assert.equal(r.output.certified, true); assert.equal(ctx.decisions[0]!.approvedBy, "u-officer"); assert.deepEqual(ctx.decisions[0]!.evidenceDocumentIds, ["doc-1"]);
  // boarding waiver: the agent may propose with a human approver attached; an agent approver is refused before the service runs
  const boarding = new BoardingService({ events: ctx.events, ledger: ctx.ledger, clock: ctx.clock } as unknown as ConstructorParameters<typeof BoardingService>[0]);
  await assert.rejects(bus.execute(boardingProposeWaiver, BOARDING, { service: boarding, batchLoanId: "bl-1", ruleCode: "W-004", reason: "county verified", approver: BOARDING }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "WAIVER_NEEDS_HUMAN");
  await assert.rejects(bus.execute(boardingProposeWaiver, BOARDING, { service: boarding, batchLoanId: "bl-1", ruleCode: "W-004", reason: "county verified", approver: OFFICER }, ctx), (e: unknown) => e instanceof WaiverRefused && e.code === "NOT_FOUND");
  assert.throws(() => requireOfficer(ANALYST, "write-off"), RoleDenied);
  assert.throws(() => requireDualControl([OFFICER, OFFICER], "officer", "wire > $250,000"), /two distinct officers/);
  requireDualControl([OFFICER, { kind: "human", id: "u-officer-2", role: "officer" }], "officer", "wire > $250,000");
  assert.throws(() => assertNoAgentMoneyChange(AGENT, ["upb_cents", "address"], ["upb_cents"], "boarding correction"), /money field upb_cents/);
  assertNoAgentMoneyChange(AGENT, ["address"], ["upb_cents"], "boarding correction");
});

test("kill switch (18.1) and AI-off: two consecutive days of override rate outside [2%, 15%] on a T1 agent routes its commands to the human path with the same rule codes", async () => {
  const agents = new AgentRegistry(); registerCommands(agents); const bus = new CommandBus(agents);
  assert.equal(agents.recordOverrideRate("cashiering", "2026-09-01", 0.20).tripped, false);
  assert.equal(agents.recordOverrideRate("cashiering", "2026-09-02", 0.01).tripped, true);
  assert.match(agents.aiState("cashiering").why!, /kill switch/);
  const ctx = uow(); const { svc, payment } = cashiering(ctx);
  await assert.rejects(bus.execute(cashieringPostPayment, AGENT, { service: svc, paymentId: payment.id, loanId: "L-1", identificationConfidence: 0.99 }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "AI_OFF");
  const human = await bus.execute(cashieringPostPayment, ANALYST, { service: svc, paymentId: payment.id, loanId: "L-1", identificationConfidence: 0.99 }, ctx);
  assert.equal(human.output.plan.outcome, "applied");
  agents.setAiOff("cashiering", null);
  assert.equal(agents.aiState("cashiering").off, false);
  agents.setAiOff("boarding", "ops: AI path disabled for the 2026-10 batch");
  assert.equal(agents.aiState("boarding").why, "ops: AI path disabled for the 2026-10 batch");
});

test("evaluators: every evaluator ref named by the section timer overrides is registered; gates open/close on their facts", async () => {
  const { loadOverriddenRegistry } = await import("../domain/timer-overrides.ts");
  const refs = loadOverriddenRegistry().unique().filter((t) => t.offsetParsed.kind === "evaluator").map((t) => (t.offsetParsed as { ref: string }).ref);
  assert.ok(refs.length >= 100);
  const missing = refs.filter((r) => !EVALUATORS[r]);
  assert.deepEqual(missing, []);
  assert.ok(Object.keys(EVALUATORS).every((k) => refs.includes(k)), "no evaluator without a registry row");
  assert.equal(evaluateGate("2.4.routeToPayoff", { amount_cents: 26_000_000n, interest_bearing_upb_cents: 24_977_400n, nib_cents: 0n }).open, false);
  assert.equal(evaluateGate("2.4.routeToPayoff", { amount_cents: 100_000n, interest_bearing_upb_cents: 24_977_400n, nib_cents: 0n }).open, true);
  assert.equal(evaluateGate("11.1.callCap7in7", { now: "2026-09-10T15:00:00.000Z", counted_call_attempts_at: Array.from({ length: 6 }, (_, i) => `2026-09-0${4 + (i % 6)}T10:00:00.000Z`) }).open, true);
  assert.equal(evaluateGate("11.1.callCap7in7", { now: "2026-09-10T15:00:00.000Z", counted_call_attempts_at: Array.from({ length: 7 }, (_, i) => `2026-09-0${4 + (i % 6)}T1${i}:00:00.000Z`) }).open, false);
  assert.equal(evaluateGate("11.1.quietHours", { mode: "voice", consumer_local_time: "20:31" }).open, false);
  assert.equal(evaluateGate("11.1.quietHours", { mode: "voice", consumer_local_time: "08:00" }).open, true);
  assert.equal(evaluateGate("12.5.paymentCap150", { expected_total_cents: 450_000n, contractual_cents: 300_000n }).open, true);
  assert.equal(evaluateGate("12.5.paymentCap150", { expected_total_cents: 450_001n, contractual_cents: 300_000n }).open, false);
  assert.match(evaluateGate("12.6.eligibilityCriteria4to11", { months_delinquent: 7, seasoning_months: 24, months_since_prior_deferral: 24, cumulative_deferred_months: 0, months_to_maturity: 200 }).reason!, /delinquency 7 months not in 2–6/);
  assert.equal(evaluateGate("1.2.transferDateIsFirstFannieBusinessDay", { transfer_date: "2026-10-01", first_fannie_business_day_of_month: "2026-10-01" }).open, true);
  assert.equal(evaluateGate("6.1.activeAccountsForEveryRemittanceType", { remittance_types: ["A/A", "S/S"], active_pi_account_types: ["A/A", "S/S"], active_ti_account_types: ["A/A"] }).reason, "no active P&I + T&I account for S/S");
  assert.throws(() => assertGate("12.4.incrementMax3Months", { term_months: 4 }), GateClosed);
  assert.throws(() => evaluateGate("9.9.nope", {}), UnknownEvaluator);
  // through the bus: a forbearance term breaching a gate is refused with the gate's code
  const agents = new AgentRegistry(); registerCommands(agents); const bus = new CommandBus(agents);
  const ctx = uow();
  const lm: Actor = { kind: "agent", id: "lossmit-underwriter" };
  await assert.rejects(bus.execute(lossmitCreateForbearanceTerm, lm, { facts: { term_months: 3, cumulative_months: 10, projected_months_delinquent_at_term_end: 6 }, create: () => ({ termId: "t1", termEnd: "2026-12-31" }) }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "12.4.cumulativeMax12Months");
  const ok = await bus.execute(lossmitCreateForbearanceTerm, lm, { facts: { term_months: 3, cumulative_months: 6, projected_months_delinquent_at_term_end: 6 }, create: () => ({ termId: "t1", termEnd: "2026-12-31" }) }, ctx);
  assert.equal(ok.output.termId, "t1");
});

test("escalations: opened with the role the kind implies, completed only by that role, both as events", () => {
  const clock = new FixedClock("2026-09-03T09:00:00.000Z"); const events = new MemoryEventStore(clock);
  const esc = new EscalationService(events, clock);
  const e = esc.open({ kind: "officer", loanId: "L-1", severity: "sev-2", payload: { command: "cashiering.writeOff", amount_cents: "1200" } }, AGENT);
  assert.equal(e.ownerRole, "officer");
  assert.throws(() => esc.complete(e.id, ANALYST, "doc-9"), /completed by role officer/);
  esc.complete(e.id, OFFICER, "doc-9");
  assert.equal(e.status, "completed"); assert.equal(e.evidenceDocumentId, "doc-9");
  assert.deepEqual(events.all().map((x) => x.type), ["escalation.created", "escalation.completed"]);
  assert.equal(esc.open({ kind: "human_portal_task" }, AGENT).ownerRole, "fnma_portal_operator");
});
