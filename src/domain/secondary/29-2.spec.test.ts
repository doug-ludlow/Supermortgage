// 29.2 Pipeline and interest-rate-risk management (fallout/pull-through, hedge for mandatory execution, mark-to-market, best-efforts operations)
// spec/sections/29-secondary-marketing-and-delivery-to-fannie-mae-whole-loan-se/29-2-pipeline-and-interest-rate-risk-management-fallout-pull-thro.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { defaultCalendars } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_29_2 } from "../../app/tools/section29-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { etInstant, fannieSifma, mandatoryTolerance } from "./ops-29-1.ts";
import {
  PipelineService, PipelineRefused, PULL_THROUGH_MODEL_V1, analyzeFalloutCohort, commitmentPairOffOrExtend, computeCoverage, defaultRateShockLimitCents, dualControlSatisfied, estimateDurationFactor, expectedDeliverableCents,
  extensionInsuranceQuote, hedgeFairValue, hedgeProgramEligibility, irlcFairValue, marginCallAmount, marginCallDue, nextFalloutReviewOn, nthBusinessDayOfMonth, policyReviewDueOn, pullThroughProbability, rateShockTable, recommendRebalance,
  rollDueOn, sifmaDates, tbaPairOffPl, tradeDescription, uncommittedExposureCents, uncommittedPositionDue, type PolicyInput,
} from "./ops-29-2.ts";

const AGENT: Actor = { kind: "agent", id: "secondary" };
const OFFICER: Actor = { kind: "human", id: "partner-officer", role: "officer" };
const ET = (date: string, hhmm: string): string => etInstant(D(date), hhmm);
const APP = "app-refi-560k";
/** 29.2 on the event store: PipelineService (the process's command surface), the TimerEngine arming the 29.2 rows on the fannie_sifma calendar, and the partner's policy adopted at `nowIso` (the program's prerequisite — it arms the daily clocks). */
function harness(nowIso: string, o: { flags?: Record<string, unknown>; policy?: Partial<PolicyInput> | null } = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["29.2"], calendars: { ...defaultCalendars, business_days_fannie_et: fannieSifma } });
  const escalations = new EscalationService(events, clock);
  const svc = new PipelineService({ events, clock, escalations, flags: o.flags ?? {} });
  if (o.policy !== null) svc.adoptPolicy({ effective_from: D("2026-10-01"), execution_mode: "best_efforts", ...(o.policy ?? {}), at: nowIso, approved_by: "partner-officer" });
  const emitted = (type: string): readonly DomainEvent[] => events.all().filter((e) => e.type === type);
  const armed = (code: string) => timers.open().filter((t) => t.code === code && t.status === "armed");
  /** 21.4's `lock.executed` (application context) fed to the service as the runtime would. */
  const lockExecuted = (i: { lock_id: string; application_id?: string; locked_at: string; amount_cents: bigint; note_rate?: string; price?: string; product_code?: string; expires_on?: string; transaction_type?: string }): DomainEvent => {
    const e = events.append({ type: "lock.executed", applicationId: i.application_id ?? APP, actor: { kind: "agent", id: "pricing" }, payload: { lock_id: i.lock_id, lineage_id: `lin-${i.lock_id}`, locked_at: i.locked_at, loan_amount_cents: String(i.amount_cents), note_rate: i.note_rate ?? "6.125", price: i.price ?? "100.875", product_code: i.product_code ?? "30yr_fixed_conforming", expires_on: i.expires_on ?? "2026-11-21", transaction_type: i.transaction_type ?? "refinance" } });
    svc.ingest(e); return e;
  };
  /** 29.1's `commitment.executed` on the same application. */
  const committed = (lockId: string, price: string, expiresOn: string, at: string, applicationId = APP): DomainEvent => { clock.set(at); const e = events.append({ type: "commitment.executed", applicationId, actor: AGENT, payload: { commitment_id: `c-${lockId}`, lock_id: lockId, lineage_id: `lin-${lockId}`, type: "best_efforts", price, expires_on: expiresOn, amount_cents: String(svc.lock(lockId).amount_cents), source: "origination" } }); svc.ingest(e); return e; };
  const tick = (iso: string) => { clock.set(iso); return timers.evaluate(iso); };
  return { clock, events, timers, escalations, svc, emitted, armed, lockExecuted, committed, tick };
}
type H = ReturnType<typeof harness>;
/** Worked example 2: mandatory mode, $5,000,000 of 30-year locks at p = 0.80 on Wed Oct 7, 2026; the $4,000,000 UMBS 30-yr 6.0 Dec short executed at 100.500 (2:05 p.m. ET) and recorded from dealer A's confirmation. */
function mandatoryHarness(nowIso = ET("2026-10-07", "13:00")) {
  const h = harness(nowIso, { flags: { "execution.mandatory_enabled": true }, policy: { execution_mode: "mandatory", instruments: ["tba_umbs_30", "fnma_mandatory_commitment"], rate_shock_limit_cents: { "-100": defaultRateShockLimitCents(500_000_000n), "100": defaultRateShockLimitCents(500_000_000n) } } });
  for (let k = 1; k <= 5; k++) h.lockExecuted({ lock_id: `M${k}`, application_id: `app-m${k}`, locked_at: ET("2026-10-07", "10:00"), amount_cents: 100_000_000n, transaction_type: "purchase", expires_on: "2026-12-06" });
  for (let k = 1; k <= 5; k++) h.svc.patchLock(`M${k}`, { probability_override: "0.80" });
  return h;
}
function openHedge(h: H) {
  const pkg = h.svc.prepareTradePackage({ side: "sell", instrument: "tba_umbs_30", face_cents: 400_000_000n, coupon: "6.000", settlement_month: D("2026-12-01"), price_expectation: "100.500", at: ET("2026-10-07", "13:30"), rationale: "coverage 0 → target $4,000,000 (expected deliverable $4,000,000 ÷ duration factor 1.00)" });
  h.svc.authorizeTradePackage({ package_id: pkg.package_id, at: ET("2026-10-07", "13:45"), authorized_by: OFFICER });
  const r = h.svc.recordTradeConfirmation({ kind: "open", package_id: pkg.package_id, face_cents: 400_000_000n, price: "100.500", executed_at: ET("2026-10-07", "14:05"), executed_by: "partner-trader", confirmation_document_id: "doc-dealer-a-conf-1", counterparty_id: "dealer-a" });
  return { pkg, ...r };
}
function bus29_2(h: H) {
  const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations: h.escalations, services: { secondary_pipeline: h.svc } };
  const agents = new AgentRegistry(); const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_29_2) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(d.name, cmd); }
  const ctx: UowContext = { loanId: "", events: h.events, ledger: new MemoryLedger(), timers: h.timers, clock: h.clock, decide: () => {} };
  const bus = new CommandBus(agents);
  return { rt, cmds, ctx, run: (name: string, input: ToolInput, actor: Actor = AGENT) => bus.execute(cmds.get(name)!, actor, input, ctx) };
}

test("29.2-T1: Given best-efforts mode and three locks executed after 5:00 p.m. ET Wed Oct 7, 2026 totaling $1,500,000, when the 7:00 a.m. ET snapshot runs Thu Oct 8, then `locked_uncommitted_cents = 150,000,000`, the +25 bp shock shows −$15,000 (duration 4.0), and the 12:00 p.m. snapshot after 29.1's commits shows `locked_uncommitted_cents = 0`.", async () => {
  // Worked example 1: three locks executed after 5:00 p.m. ET Wed Oct 7 (queued for the 8:15 a.m. ET window); the fixture's $560,000 lock committed at 12:25 p.m. ET Oct 7 is already in the committed bucket.
  const h = harness(ET("2026-10-07", "12:00"));
  h.lockExecuted({ lock_id: "L-fixture", locked_at: ET("2026-10-07", "12:19"), amount_cents: 56_000_000n });
  h.committed("L-fixture", "101.375", "2026-12-07", ET("2026-10-07", "12:25"));
  h.lockExecuted({ lock_id: "L-a", application_id: "app-a", locked_at: ET("2026-10-07", "17:30"), amount_cents: 60_000_000n });
  h.lockExecuted({ lock_id: "L-b", application_id: "app-b", locked_at: ET("2026-10-07", "18:10"), amount_cents: 50_000_000n });
  h.lockExecuted({ lock_id: "L-c", application_id: "app-c", locked_at: ET("2026-10-07", "19:45"), amount_cents: 40_000_000n });
  h.clock.set(ET("2026-10-08", "07:00"));
  const seven = h.svc.takeSnapshot({ at: ET("2026-10-08", "07:00"), whole_loan_price: "101.375", price_source: "pewl_live 07:00" });
  assert.equal(seven.execution_mode, "best_efforts"); assert.equal(seven.locked_uncommitted_cents, 150_000_000n); assert.equal(seven.committed_be_cents, 56_000_000n);
  assert.equal(seven.hedge_face_cents, 0n, "best-efforts mode: no hedge exists");
  assert.equal(seven.residual_shocks["25"], -1_500_000n, "+25 bp on $1,500,000 uncommitted at duration 4.0 → −$15,000");
  assert.equal(seven.residual_shocks["100"], -6_000_000n); assert.equal(seven.residual_shocks["-25"], 1_500_000n);
  assert.equal(uncommittedExposureCents(150_000_000n, 25, "4.0"), -1_500_000n);
  // The three uncommitted locks each carry an SM_UNCOMMITTED_POSITION_5BD clock (Oct 14); the snapshot satisfied the 07:00 daily row and re-armed it for Oct 9.
  assert.equal(h.armed("SM_UNCOMMITTED_POSITION_5BD").length, 3);
  assert.equal(h.emitted("timer.satisfied").filter((e) => e.payload.code === "SM_PIPELINE_POSITION_DAILY_0700ET").length, 1);
  assert.deepEqual(h.armed("SM_PIPELINE_POSITION_DAILY_0700ET").map((t) => t.dueDate), ["2026-10-09"]);
  // 8:15 a.m. ET: 29.1 commits the three loans (prices rose overnight); the 12:00 p.m. snapshot shows $0 uncommitted.
  h.committed("L-a", "101.500", "2026-12-07", ET("2026-10-08", "08:15"), "app-a"); h.committed("L-b", "101.500", "2026-12-07", ET("2026-10-08", "08:15"), "app-b"); h.committed("L-c", "101.500", "2026-12-07", ET("2026-10-08", "08:16"), "app-c");
  const noon = h.svc.takeSnapshot({ at: ET("2026-10-08", "12:00"), intraday: true, whole_loan_price: "101.500" });
  assert.equal(noon.locked_uncommitted_cents, 0n); assert.equal(noon.committed_be_cents, 206_000_000n); assert.equal(noon.residual_shocks["25"], 0n);
  assert.equal(h.armed("SM_UNCOMMITTED_POSITION_5BD").length, 0, "commitment.executed on each application satisfied the uncommitted clock");
  assert.equal(h.emitted("pipeline.snapshot.taken").length, 2); assert.equal(h.emitted("pipeline.snapshot.taken")[1]!.payload.locked_uncommitted_cents, "0");
});
test("29.2-T2: Given the fixture loan committed at 101.375 with a borrower base price of 100.875, stage `locked` (p = 0.80), servicing multiple 4.5×, then the Oct 7 mark reports `irlc_sale_price_component_cents = 224,000` and `irlc_servicing_component_cents = 504,000` separately, `irlc_fv_cents = 728,000`.", async () => {
  // Rule 6 (SAB 105/109): sale-price and servicing components reported separately.
  const v = irlcFairValue({ amount_cents: 56_000_000n, market_price: "101.375", lock_base_price: "100.875", probability: "0.80", servicing_value_multiple: "4.5", servicing_fee_bps: 25 });
  assert.equal(v.irlc_sale_price_component_cents, 224_000n, "(101.375 − 100.875)/100 × $560,000 × 0.80 = $2,240.00");
  assert.equal(v.irlc_servicing_component_cents, 504_000n, "4.5 × 0.0025 × $560,000 × 0.80 = $5,040.00");
  assert.equal(v.irlc_fv_cents, 728_000n);
  // The Oct 7 5:00 p.m. mark through the service: once committed best efforts the sale-price component is locked against Fannie Mae (the commitment price is the market) and only p moves it.
  const h = harness(ET("2026-10-07", "08:00"));
  h.lockExecuted({ lock_id: "L-fixture", locked_at: ET("2026-10-07", "12:19"), amount_cents: 56_000_000n, price: "100.875" });
  h.committed("L-fixture", "101.375", "2026-12-07", ET("2026-10-07", "12:25"));
  h.svc.patchLock("L-fixture", { stage: "locked", probability_override: "0.80" });
  h.clock.set(ET("2026-10-07", "17:00")); h.svc.takeSnapshot({ whole_loan_price: "101.250" });
  const run = h.svc.runMarkToMarket({ at: ET("2026-10-07", "17:05"), whole_loan_price: "101.250", whole_loan_price_id: "pewl-mark-2026-10-07-1700" });
  assert.equal(run.irlc_sale_price_component_cents, 224_000n); assert.equal(run.irlc_servicing_component_cents, 504_000n); assert.equal(run.irlc_fv_cents, 728_000n);
  assert.equal(run.hedge_fv_cents, 0n); assert.equal(run.net_fv_cents, 728_000n);
  const ev = h.emitted("mtm.run.completed")[0]!; assert.equal(ev.payload.irlc_fv_cents, "728000"); assert.equal(ev.payload.gl_exported, true);
  // The stage lookup itself (rule 2 v1): locked 0.72, DU-approved 0.80, refinance 5 points lower, a 25 bp rally −0.04.
  assert.equal(pullThroughProbability({ stage: "du_approved" }).probability, "0.8000"); assert.equal(pullThroughProbability({ stage: "locked" }).probability, "0.7200");
  assert.equal(pullThroughProbability({ stage: "du_approved", transaction_type: "refinance" }).probability, "0.7500"); assert.equal(pullThroughProbability({ stage: "du_approved", rate_move_bps: -25 }).probability, "0.7600");
  assert.equal(pullThroughProbability({ stage: "du_approved", rate_move_bps: 25 }).probability, "0.8200"); assert.equal(pullThroughProbability({ stage: "locked", rate_move_bps: -200 }).probability, "0.5000");
});
test("29.2-T3: Given mandatory mode with $5,000,000 of locks at p = 0.80 and duration factor 1.00, then `target_hedge_face_cents = 400,000,000` and a trade package \"sell $4,000,000 UMBS 30-yr 6.0 Dec\" is opened as an `officer` escalation; no trade is recorded until a confirmation document is attached.", async () => {
  const h = mandatoryHarness();
  // Rule 3: expected deliverable $5,000,000 × 0.80 = $4,000,000; duration factor 1.00 → target face $4,000,000.
  assert.equal(expectedDeliverableCents([{ amount_cents: 500_000_000n, probability: "0.80" }]), 400_000_000n);
  const cov = computeCoverage({ hedge_face_cents: 0n, duration_factor: "1.00", expected_deliverable_cents: 400_000_000n });
  assert.equal(cov.target_hedge_face_cents, 400_000_000n); assert.equal(cov.within_band, false); assert.equal(cov.delta_face_cents, 400_000_000n);
  const snap = h.svc.takeSnapshot({ at: ET("2026-10-07", "12:00"), whole_loan_price: "101.250", tba_price: "100.500", duration_factor: "1.0000" });
  assert.equal(snap.execution_mode, "mandatory"); assert.equal(snap.mandatory_pipeline_cents, 500_000_000n); assert.equal(snap.expected_deliverable_cents, 400_000_000n); assert.equal(snap.hedge_face_cents, 0n);
  assert.equal(tradeDescription({ side: "sell", face_cents: 400_000_000n, instrument: "tba_umbs_30", coupon: "6.000", settlement_month: D("2026-12-01") }), "sell $4,000,000 UMBS 30-yr 6.0 Dec");
  // The package is an officer escalation; no position exists until the confirmation document is attached.
  const pkg = h.svc.prepareTradePackage({ side: "sell", instrument: "tba_umbs_30", face_cents: 400_000_000n, coupon: "6.000", settlement_month: D("2026-12-01"), price_expectation: "100.500", at: ET("2026-10-07", "13:30") });
  assert.equal(pkg.description, "sell $4,000,000 UMBS 30-yr 6.0 Dec at 100.500"); assert.equal(pkg.status, "recommended");
  const esc = h.escalations.list().find((e) => e.id === pkg.escalation_id)!;
  assert.equal(esc.kind, "officer"); assert.equal(esc.payload.task, "officer_trade_authorization"); assert.equal(esc.payload.description, pkg.description);
  assert.ok(pkg.policy_checks.every((c) => c.passed)); assert.equal(h.emitted("hedge.rebalance.recommended").length, 1);
  assert.equal(h.svc.positions.length, 0); assert.equal(h.emitted("hedge.trade.executed").length, 0);
  assert.throws(() => h.svc.recordTradeConfirmation({ kind: "open", package_id: pkg.package_id, face_cents: 400_000_000n, price: "100.500", executed_by: "partner-trader", confirmation_document_id: null }), (e: unknown) => e instanceof PipelineRefused && e.code === "CONFIRMATION_REQUIRED");
  assert.throws(() => h.svc.recordTradeConfirmation({ kind: "open", package_id: pkg.package_id, face_cents: 400_000_000n, price: "100.500", executed_by: "partner-trader", confirmation_document_id: "doc-1" }), (e: unknown) => e instanceof PipelineRefused && e.code === "TRADE_NOT_AUTHORIZED");
  assert.throws(() => h.svc.authorizeTradePackage({ package_id: pkg.package_id, authorized_by: AGENT }), (e: unknown) => e instanceof PipelineRefused && e.code === "OFFICER_AUTHORIZATION");
  assert.equal(h.svc.positions.length, 0);
  h.svc.authorizeTradePackage({ package_id: pkg.package_id, at: ET("2026-10-07", "13:45"), authorized_by: OFFICER });
  const r = h.svc.recordTradeConfirmation({ kind: "open", package_id: pkg.package_id, face_cents: 400_000_000n, price: "100.500", executed_at: ET("2026-10-07", "14:05"), executed_by: "partner-trader", confirmation_document_id: "doc-dealer-a-conf-1", counterparty_id: "dealer-a" });
  assert.equal(r.position.status, "open"); assert.equal(r.position.face_cents, 400_000_000n); assert.equal(r.position.roll_due_on, "2026-12-03"); assert.equal(r.position.notification_date, "2026-12-08"); assert.equal(r.position.confirmation_document_id, "doc-dealer-a-conf-1");
  assert.equal(h.svc.package(pkg.package_id).status, "executed"); assert.equal(h.emitted("hedge.trade.executed").length, 1);
  assert.equal(h.svc.lastSnapshot()!.coverage_ratio, "1.0000", "coverage 100% after the confirmation's coverage check");
});
test("29.2-T4: Given the $4,000,000 short at 100.500 and a Nov 2 mark of 101.500 with p falling to 0.72, then `hedge_fv_cents = −4,000,000`, `coverage_ratio = 1.1111`, `SM_HEDGE_COVERAGE_BAND_GATE` breaches the 1.10 band, and a rebalance package to buy back $400,000 is issued the same day with `realized_pl_cents = −400,000` after execution at 101.500.", async () => {
  const h = mandatoryHarness(); openHedge(h);
  // Mon Nov 2: 25 bp rally — TBA 6.0 Dec marks 101.500; p falls to 0.72 → expected deliverable $3,600,000.
  assert.equal(hedgeFairValue(400_000_000n, "100.500", "101.500"), -4_000_000n, "$4,000,000 × (100.500 − 101.500)/100 = −$40,000.00");
  const cov = computeCoverage({ hedge_face_cents: 400_000_000n, duration_factor: "1.00", expected_deliverable_cents: 360_000_000n });
  assert.equal(cov.coverage_ratio, "1.1111"); assert.equal(cov.within_band, false); assert.equal(cov.band.high, "1.10"); assert.equal(cov.delta_face_cents, -40_000_000n);
  for (let k = 1; k <= 5; k++) h.svc.patchLock(`M${k}`, { probability_override: "0.72", rate_move_bps: -25 });
  h.clock.set(ET("2026-11-02", "07:00"));
  const snap = h.svc.takeSnapshot({ whole_loan_price: "102.250", tba_price: "101.500", duration_factor: "1.0000" });
  assert.equal(snap.expected_deliverable_cents, 360_000_000n); assert.equal(snap.coverage_ratio, "1.1111"); assert.equal(snap.within_band, false); assert.equal(snap.hedge_value_cents, -4_000_000n);
  // SM_HEDGE_COVERAGE_BAND_GATE: the out-of-band snapshot instantiates the gate; the evaluator refuses 1.1111 against the 1.10 band.
  assert.equal(h.armed("SM_HEDGE_COVERAGE_BAND_GATE").length, 1);
  const gate = evaluateGate("29.2.coverageBand", { coverage_ratio: "1.1111", coverage_band_low: "0.85", coverage_band_high: "1.10" }); assert.equal(gate.open, false); assert.match(gate.reason!, /1\.1111 outside \[0\.85, 1\.10\]/);
  assert.equal(evaluateGate("29.2.coverageBand", { hedge_face_cents: 360_000_000n, duration_factor: "1.00", expected_deliverable_cents: 360_000_000n }).open, true);
  // The rebalance package the same day: buy back $400,000 at 101.500 (pair-off cost of the over-hedge −$4,000.00), authorized by the officer, executed by the trader.
  const r = h.svc.recommendRebalance({ at: ET("2026-11-02", "09:30"), mark_price: "101.500" });
  assert.equal(r.action, "buy_back"); assert.equal(r.face_cents, 40_000_000n); assert.equal(r.realized_pl_estimate_cents, -400_000n); assert.ok(r.package); assert.equal(r.package!.prepared_at.slice(0, 10), "2026-11-02"); assert.equal(r.package!.description, "buy $400,000 UMBS 30-yr 6.0 Dec at 101.500");
  assert.equal(recommendRebalance({ hedge_face_cents: 400_000_000n, duration_factor: "1.00", expected_deliverable_cents: 360_000_000n, instrument: "tba_umbs_30", trade_price: "100.500", mark_price: "101.500" }).realized_pl_estimate_cents, -400_000n);
  h.svc.authorizeTradePackage({ package_id: r.package!.package_id, at: ET("2026-11-02", "10:40"), authorized_by: OFFICER });
  const x = h.svc.recordTradeConfirmation({ kind: "pair_off", package_id: r.package!.package_id, face_cents: 40_000_000n, price: "101.500", executed_at: ET("2026-11-02", "10:52"), executed_by: "partner-trader", confirmation_document_id: "doc-dealer-a-conf-2" });
  assert.equal(x.trade.realized_pl_cents, -400_000n); assert.equal(tbaPairOffPl(40_000_000n, "100.500", "101.500"), -400_000n);
  assert.equal(x.position.face_cents, 360_000_000n, "the residual $3,600,000 short stays"); assert.equal(x.position.status, "open"); assert.equal(x.position.realized_pl_cents, -400_000n);
  assert.equal(h.svc.lastSnapshot()!.coverage_ratio, "1.0000"); assert.equal(h.armed("SM_HEDGE_COVERAGE_BAND_GATE").length, 0, "the trade restoring the band closed the gate");
  assert.equal(h.emitted("hedge.trade.executed").at(-1)!.payload.realized_pl_cents, "-400000");
});
test("29.2-T5: Given a Dec 2026 Class A TBA position, then `roll_due_on = 2026-12-03` (three business days before the Dec 8 notification) and `SIFMA_TBA_ROLL_GATE_3BD` breaches at 12:00 p.m. ET Dec 3 if the position is still open; a January position computes `roll_due_on = 2027-01-07` (Jan 11, Jan 8, Jan 7 before the Jan 12 notification).", async () => {
  // Rule 9: Class A Dec 2026 notification Tue Dec 8 → roll_due_on Thu Dec 3 (Dec 7, 4, 3); January: Jan 12 → Jan 7 (Jan 11, 8, 7).
  assert.equal(sifmaDates(D("2026-12-01"), "A").notification_date, "2026-12-08"); assert.equal(sifmaDates(D("2026-12-01"), "A").settlement_date, "2026-12-10");
  assert.equal(rollDueOn(D("2026-12-08")).roll_due_on, "2026-12-03"); assert.equal(rollDueOn(D("2026-12-08")).roll_due_at, ET("2026-12-03", "12:00"));
  assert.equal(sifmaDates(D("2027-01-01"), "A").notification_date, "2027-01-12"); assert.equal(rollDueOn(D("2027-01-12")).roll_due_on, "2027-01-07");
  assert.equal(rollDueOn(D("2026-11-13"), 3).roll_due_on, "2026-11-09", "Class B Nov: Nov 12, Nov 10 (Wed Nov 11 Veterans Day is a SIFMA close), Nov 9");
  const h = mandatoryHarness(); const { position } = openHedge(h);
  assert.equal(position.roll_due_on, "2026-12-03");
  const roll = h.svc.scheduleRoll({ position_id: position.position_id, at: ET("2026-11-30", "09:00") });
  assert.equal(roll.roll_due_on, "2026-12-03"); assert.equal(roll.back_month.settlement_month, "2027-01-01"); assert.equal(roll.back_month.notification_date, "2027-01-12"); assert.equal(roll.recommendation, "roll");
  // SIFMA_TBA_ROLL_GATE_3BD armed by the open confirmation, anchored on the notification date, due 12:00 p.m. ET Dec 3; still open → breach (sev 1) → trader and officer the same hour.
  const gate = h.armed("SIFMA_TBA_ROLL_GATE_3BD"); assert.equal(gate.length, 1); assert.equal(gate[0]!.dueDate, "2026-12-03"); assert.equal(new Date(gate[0]!.dueAt!).toISOString(), ET("2026-12-03", "12:00"));
  assert.equal(h.tick(ET("2026-12-03", "11:59")).filter((b) => b.def.code === "SIFMA_TBA_ROLL_GATE_3BD").length, 0);
  const breaches = h.tick(ET("2026-12-03", "12:01")).filter((b) => b.def.code === "SIFMA_TBA_ROLL_GATE_3BD");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.severity, 1);
  const escId = h.svc.handleBreach(breaches[0]!); const esc = h.escalations.list().find((e) => e.id === escId)!; assert.equal(esc.kind, "officer"); assert.equal(esc.severity, "sev1"); assert.equal(esc.payload.task, "officer_tba_roll_breach");
  // Rolled to January (close Dec, open Jan at the roll price): the Dec position is flat before Dec 8 and the January position computes its own roll_due_on = Jan 7.
  const rolled = h.svc.recordTradeConfirmation({ kind: "roll_close", position_id: position.position_id, face_cents: 400_000_000n, price: "101.250", executed_at: ET("2026-12-03", "12:30"), executed_by: "partner-trader", confirmation_document_id: "doc-roll-close", roll_open: { price: "101.000", settlement_month: D("2027-01-01"), confirmation_document_id: "doc-roll-open" } });
  assert.equal(rolled.position.status, "rolled"); assert.equal(rolled.next_position!.status, "open"); assert.equal(rolled.next_position!.roll_due_on, "2027-01-07"); assert.equal(rolled.next_position!.notification_date, "2027-01-12");
  assert.equal(h.emitted("hedge.position.rolled").length, 1); assert.equal(h.armed("SIFMA_TBA_ROLL_GATE_3BD").map((t) => t.dueDate).join(","), "2027-01-07");
});
test("29.2-T6: Given a dealer margin call of $15,000 received Mon Nov 2, 2026 3:10 p.m. ET under a margin annex with a next-business-day due time, then `FINRA_4210_VARIATION_MARGIN_1BD` is due Tue Nov 3 close of business; a wire released at 11:30 a.m. ET Nov 3 under `funding_approver` dual control satisfies it; a call received Tue Nov 10 is due Thu Nov 12 (Wed Nov 11 Veterans Day is a SIFMA close).", async () => {
  // FINRA 4210: the dealer's excess net MTM loss of $40,000 exceeds the modeled $25,000 annex threshold → a $15,000 call (below the rule's $250,000 de minimis).
  assert.deepEqual(marginCallAmount(4_000_000n), { call_cents: 1_500_000n, above_de_minimis: false });
  assert.equal(marginCallDue(ET("2026-11-02", "15:10")).due_on, "2026-11-03"); assert.equal(marginCallDue(ET("2026-11-02", "15:10")).due_at, ET("2026-11-03", "17:00"));
  assert.equal(marginCallDue(ET("2026-11-10", "15:10")).due_on, "2026-11-12", "Wed Nov 11 Veterans Day is a SIFMA close");
  assert.equal(marginCallDue(ET("2026-11-25", "10:00")).due_at, ET("2026-11-27", "14:00"), "Thanksgiving skipped; Fri Nov 27 early close → wire before 2:00 p.m. ET");
  const h = mandatoryHarness(); openHedge(h);
  h.clock.set(ET("2026-11-02", "15:10"));
  const call = h.svc.recordMarginCall({ counterparty_id: "dealer-a", amount_cents: 1_500_000n, basis: { excess_net_mtm_loss_cents: "4000000", threshold_cents: "2500000" } });
  assert.equal(call.due_on, "2026-11-03"); assert.equal(call.due_at, ET("2026-11-03", "17:00")); assert.equal(call.status, "open");
  const t = h.armed("FINRA_4210_VARIATION_MARGIN_1BD"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-11-03"); assert.equal(new Date(t[0]!.dueAt!).toISOString(), ET("2026-11-03", "17:00"));
  // The wire under funding_approver dual control at 11:30 a.m. ET Nov 3 satisfies it; a single approver or no funding_approver is refused.
  assert.deepEqual(dualControlSatisfied([{ actor_id: "ops-1", role: "ops_analyst" }]), { satisfied: false, reason: "dual control needs two distinct approvers" });
  assert.throws(() => h.svc.fundMarginCall({ call_id: call.call_id, wire_id: "wire-1", released_at: ET("2026-11-03", "11:30"), approvals: [{ actor_id: "ops-1", role: "ops_analyst" }, { actor_id: "ops-2", role: "ops_analyst" }] }), (e: unknown) => e instanceof PipelineRefused && e.code === "DUAL_CONTROL");
  const funded = h.svc.fundMarginCall({ call_id: call.call_id, wire_id: "wire-1", released_at: ET("2026-11-03", "11:30"), approvals: [{ actor_id: "ops-1", role: "ops_analyst" }, { actor_id: "fa-1", role: "funding_approver" }] });
  assert.equal(funded.status, "funded"); assert.equal(funded.funded_at, ET("2026-11-03", "11:30"));
  assert.equal(h.armed("FINRA_4210_VARIATION_MARGIN_1BD").length, 0); assert.equal(h.emitted("margin.call.funded")[0]!.payload.late, false);
  assert.equal(h.emitted("timer.satisfied").filter((e) => e.payload.code === "FINRA_4210_VARIATION_MARGIN_1BD").length, 1);
  h.clock.set(ET("2026-11-10", "15:10")); const second = h.svc.recordMarginCall({ counterparty_id: "dealer-a", amount_cents: 800_000n });
  assert.equal(second.due_on, "2026-11-12"); assert.equal(h.armed("FINRA_4210_VARIATION_MARGIN_1BD")[0]!.dueDate, "2026-11-12");
  const breach = h.tick(ET("2026-11-12", "17:01")).filter((b) => b.def.code === "FINRA_4210_VARIATION_MARGIN_1BD"); assert.equal(breach.length, 1); assert.equal(breach[0]!.severity, 1);
});
test("29.2-T7: Given the Nov 2 position, when the rate-shock report runs, then the −100 bp row shows hedge −$144,000, pipeline +$115,200 (p = 0.64 on $3,600,000 short), projected margin call $104,000 net of margin already posted, and the row is compared to `rate_shock_limit_cents`; the +100 bp row shows an $800,000 under-hedge and −$14,400 net.", async () => {
  // Rule 7 on the Nov 2 position: $3,600,000 short (after the buy-back), expected deliverable $3,600,000 on $5,000,000 covered, p_base 0.80, duration 4.0, $40,000 already margined.
  const rows = rateShockTable({ covered_amount_cents: 500_000_000n, expected_deliverable_cents: 360_000_000n, p_base: "0.80", hedge_face_cents: 360_000_000n, hedge_trade_price: "100.500", hedge_mark_price: "101.500", duration: "4.0", duration_factor: "1.00", margin_posted_cents: 4_000_000n, rate_shock_limit_cents: { "-100": defaultRateShockLimitCents(500_000_000n), "100": defaultRateShockLimitCents(500_000_000n) } });
  const minus = rows.find((r) => r.shock_bps === -100)!, plus = rows.find((r) => r.shock_bps === 100)!;
  assert.equal(minus.price_change, "4.000"); assert.equal(minus.hedge_value_cents, -14_400_000n, "from 101.500 to 105.500 on $3.6M → −$144,000"); assert.equal(minus.probability, "0.6400"); assert.equal(minus.pipeline_value_cents, 11_520_000n, "+$115,200 at p = 0.64");
  assert.equal(minus.projected_margin_call_cents, 10_400_000n, "$144,000 − $40,000 already margined = $104,000"); assert.equal(minus.limit_cents, 7_500_000n, "1.5% of the $5,000,000 hedged pipeline"); assert.equal(minus.limit_breached, false); assert.equal(minus.net_value_cents, -2_880_000n);
  assert.equal(plus.probability, "0.8800"); assert.equal(plus.expected_deliverable_cents, 440_000_000n); assert.equal(plus.under_hedge_cents, 80_000_000n, "$4.4M deliverable against the $3.6M short → under-hedged by $800,000");
  assert.equal(plus.hedge_value_cents, 14_400_000n); assert.equal(plus.pipeline_value_cents, -15_840_000n); assert.equal(plus.net_value_cents, -1_440_000n, "−$14,400 net"); assert.equal(plus.projected_margin_call_cents, 0n);
  assert.deepEqual(rows.map((r) => r.shock_bps), [-100, -50, -25, 0, 25, 50, 100]); assert.equal(rows.find((r) => r.shock_bps === 0)!.net_value_cents, 0n);
  // Through the service: the report is published (SM_RATE_SHOCK_REPORT_DAILY) with every row compared to the policy's limit.
  const h = mandatoryHarness(); openHedge(h); h.clock.set(ET("2026-11-02", "17:30"));
  const report = h.svc.runRateShock({ covered_amount_cents: 500_000_000n, expected_deliverable_cents: 360_000_000n, p_base: "0.80", hedge_face_cents: 360_000_000n, hedge_trade_price: "100.500", hedge_mark_price: "101.500", margin_posted_cents: 4_000_000n });
  assert.equal(report.shocks.find((r) => r.shock_bps === -100)!.projected_margin_call_cents, 10_400_000n); assert.deepEqual(report.limits_checked.find((l) => l.shock_bps === -100), { shock_bps: -100, limit_cents: 7_500_000n, breached: false });
  assert.equal(h.emitted("rate_shock.report.published").length, 1); assert.deepEqual(h.emitted("rate_shock.report.published")[0]!.payload.limits_breached, []);
  assert.equal(h.armed("SM_RATE_SHOCK_REPORT_DAILY").map((t) => t.dueDate).join(","), "2026-11-03");
});
test("29.2-T8: Given a Fannie Mae mandatory commitment of $4,000,000 at 101.250 expiring Mon Dec 7, 2026 with $3,600,000 expected deliverable and a live price of 102.250 on Fri Dec 4, then the package prices a $300,000 partial pair-off at `fee_cents = 300,000` and a 10-day extension of $400,000 at `fee_cents = 62,500`, recommends the extension when both late loans are at stage `cd_delivered`, and requires an `officer` decision before 5:00 p.m. ET Dec 7; with a live price of 100.250 the pair-off row shows `cash_back_cents = 300,000`.", async () => {
  // Worked example 3: tolerance max($10,000, 2.5% × $4,000,000) = $100,000 → the $400,000 shortfall pairs off $300,000 and leaves $100,000 inside the tolerance.
  assert.equal(mandatoryTolerance(400_000_000n).tolerance_cents, 10_000_000n);
  const base = { commitment_id: "c-mand-1", original_amount_cents: 400_000_000n, commitment_price: "101.250", expires_on: D("2026-12-07"), expected_deliverable_cents: 360_000_000n, late_balance_cents: 40_000_000n, extension_days: 10, min_ptr: "5.625", as_of: ET("2026-12-04", "09:00") };
  const d = commitmentPairOffOrExtend({ ...base, live_price: "102.250", late_loan_stages: ["cd_delivered", "cd_delivered"] });
  assert.equal(d.pair_off.amount_cents, 30_000_000n); assert.equal(d.pair_off.fee_cents, 300_000n, "$300,000 × (102.250 − 101.250)/100 = $3,000.00"); assert.equal(d.pair_off.cash_back_cents, 0n); assert.equal(d.pair_off.remaining_undelivered_cents, 10_000_000n); assert.equal(d.pair_off.inside_tolerance, true);
  assert.equal(d.extension.fee_cents, 62_500n, "$400,000 × 0.05625/360 × 10 = $625.00"); assert.equal(d.extension.amount_cents, 40_000_000n); assert.equal(d.extension.days, 10);
  assert.equal(d.recommendation, "extension"); assert.equal(d.officer_decision_required, true); assert.equal(d.decide_by, ET("2026-12-07", "17:00"));
  assert.equal(commitmentPairOffOrExtend({ ...base, live_price: "102.250", late_loan_stages: ["ctc", "cd_delivered"] }).recommendation, "pair_off");
  const up = commitmentPairOffOrExtend({ ...base, live_price: "100.250", late_loan_stages: ["ctc", "ctc"] });
  assert.equal(up.pair_off.cash_back_cents, 300_000n, "rates rose 25 bp: cash back $3,000.00 (C2-1.1-04)"); assert.equal(up.pair_off.fee_cents, 0n); assert.equal(up.recommendation, "pair_off");
  // The service opens the officer decision (the fnma_portal_operator executes in PE–WL through 29.1) before 5:00 p.m. ET on the expiration date.
  const h = mandatoryHarness(); h.clock.set(ET("2026-12-04", "09:00"));
  const pkg = h.svc.prepareCommitmentDecision({ ...base, live_price: "102.250", late_loan_stages: ["cd_delivered", "cd_delivered"] });
  const esc = h.escalations.list().find((e) => e.id === pkg.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.payload.task, "officer_commitment_decision"); assert.equal(esc.payload.decide_by, ET("2026-12-07", "17:00")); assert.equal(esc.payload.recommendation, "extension");
});
test("29.2-T9: Given the September cohort of 118 locks with 21 fallouts, when the monthly review runs on the 3rd business day of October (Mon Oct 5, 2026), then realized pull-through 82.2% is compared with the predicted 80.5%, no recalibration is proposed, and the fallout reasons are published to 21.4; given a cohort realized at 68% against 80.5%, a recalibration proposal opens an `officer` escalation and 31.2 review, and hedge ratios move to the conservative band edge until approved.", async () => {
  // The 3rd fannie_sifma business day of October 2026 is Mon Oct 5 (Oct 1, 2, 5).
  assert.equal(nthBusinessDayOfMonth(2026, 10, 3), "2026-10-05"); assert.equal(nextFalloutReviewOn(D("2026-09-04")), "2026-10-05"); assert.equal(nthBusinessDayOfMonth(2026, 11, 3), "2026-11-04");
  const reasons = [{ reason: "borrower_withdrawal" as const, count: 8 }, { reason: "lender_declination" as const, count: 6 }, { reason: "relock_elsewhere" as const, count: 4, note: "all after ≥ 25 bp rallies" }, { reason: "ineligible" as const, count: 3 }];
  const sep = analyzeFalloutCohort({ cohort: "2026-09", locks: 118, fallouts: 21, predicted_pct: "80.5", reasons });
  assert.equal(sep.realized_pct, "82.2"); assert.equal(sep.fallout_rate_pct, "17.8"); assert.equal(sep.difference_points, "1.7"); assert.equal(sep.within_tolerance, true); assert.equal(sep.recalibration_proposed, false); assert.equal(sep.hedge_ratio_mode, "model");
  const h = harness(ET("2026-10-05", "08:00"));
  const review = h.svc.analyzeFallout({ cohort: "2026-09", locks: 118, fallouts: 21, predicted_pct: "80.5", reasons, review_on: D("2026-10-05"), at: ET("2026-10-05", "09:00") });
  assert.equal(review.review_on, "2026-10-05"); assert.equal(review.realized_pct, "82.2"); assert.equal(review.predicted_pct, "80.5"); assert.equal(review.recalibration_proposed, false); assert.equal(review.escalation_id, null); assert.equal(review.next_review_on, "2026-11-04");
  const pub = h.emitted("fallout.report.published")[0]!; assert.deepEqual(pub.payload.consumers, ["21.4"]); assert.deepEqual((pub.payload.reasons as { reason: string; count: number }[]).map((r) => [r.reason, r.count]), [["borrower_withdrawal", 8], ["lender_declination", 6], ["relock_elsewhere", 4], ["ineligible", 3]]);
  assert.equal(h.armed("SM_BE_FALLOUT_REVIEW_MONTHLY").map((t) => t.dueDate).join(","), "2026-11-04", "the published review re-arms the monthly row on the next 3rd business day");
  assert.equal(h.svc.hedgeRatioModeNow(), "model");
  // A cohort realized at 68% against 80.5%: −12.5 points → recalibration proposal, officer escalation and 31.2 review; hedge ratios move to the conservative band edge until a version is approved.
  const drift = h.svc.analyzeFallout({ cohort: "2026-09b", locks: 100, fallouts: 32, predicted_pct: "80.5", review_on: D("2026-10-05"), at: ET("2026-10-05", "09:30") });
  assert.equal(drift.realized_pct, "68.0"); assert.equal(drift.difference_points, "-12.5"); assert.equal(drift.recalibration_proposed, true); assert.equal(drift.o12_2_review_requested, true); assert.equal(drift.hedge_ratio_mode, "conservative_band_edge");
  const esc = h.escalations.list().find((e) => e.id === drift.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.payload.task, "officer_pull_through_recalibration");
  assert.equal(h.svc.hedgeRatioModeNow(), "conservative_band_edge"); assert.equal(h.svc.models.at(-1)!.status, "proposed");
  assert.throws(() => h.svc.recalibratePullThrough({ version: "v2", approved_by: AGENT, o12_2_review_id: "o12.2-42" }), (e: unknown) => e instanceof PipelineRefused && e.code === "MODEL_OFFICER_APPROVAL");
  assert.throws(() => h.svc.recalibratePullThrough({ version: "v2", approved_by: OFFICER, o12_2_review_id: null }), (e: unknown) => e instanceof PipelineRefused && e.code === "MODEL_O12_2_REVIEW");
  const v2 = h.svc.recalibratePullThrough({ version: "v2", approved_by: OFFICER, o12_2_review_id: "o12.2-42", at: ET("2026-10-06", "10:00") });
  assert.equal(v2.status, "approved"); assert.equal(h.svc.model().version, "v2"); assert.equal(h.svc.hedgeRatioModeNow(), "model");
  assert.equal(h.armed("SM_PULL_THROUGH_MODEL_RECALIBRATION_90").map((t) => t.dueDate).join(","), "2027-01-04", "+90 calendar days from the approved recalibration");
});
test("29.2-T10: Given `execution.mandatory_enabled=false`, when any tool attempts `prepareTradePackage` or `requestMandatoryCommitment`, then the call is refused and logged; the daily position and MTM still run.", async () => {
  const h = harness(ET("2026-10-08", "07:00"), { flags: { "execution.mandatory_enabled": false } });
  h.lockExecuted({ lock_id: "L-a", locked_at: ET("2026-10-07", "17:30"), amount_cents: 60_000_000n });
  const b = bus29_2(h); const before = h.events.all().length;
  await assert.rejects(b.run("prepareTradePackage", { side: "sell", instrument: "tba_umbs_30", face_cents: 400_000_000n, coupon: "6.000", settlement_month: "2026-12-01", flags: { "execution.mandatory_enabled": false } }), (e: unknown) => e instanceof CommandRefused && e.code === "MANDATORY_DISABLED");
  await assert.rejects(b.run("requestMandatoryCommitment", { amount_cents: 400_000_000n, product: "30yr_fixed_conforming", ptr_range_low: "5.625", ptr_range_high: "6.125", period_days: 60, flags: { "execution.mandatory_enabled": false } }), (e: unknown) => e instanceof CommandRefused && e.code === "MANDATORY_DISABLED");
  const refused = h.events.all().slice(before).filter((e) => e.type === "command.refused");
  assert.deepEqual(refused.map((e) => [e.payload.command, e.payload.code]), [["prepareTradePackage", "MANDATORY_DISABLED"], ["requestMandatoryCommitment", "MANDATORY_DISABLED"]], "refused and logged");
  assert.equal(h.svc.packages.length, 0); assert.equal(h.emitted("hedge.commitment.requested").length, 0);
  // The service refuses the same calls on the stored flag (no `flags` input) — the handler never reaches the escalation.
  assert.throws(() => h.svc.prepareTradePackage({ side: "sell", instrument: "tba_umbs_30", face_cents: 400_000_000n }), (e: unknown) => e instanceof PipelineRefused && e.code === "MANDATORY_DISABLED");
  assert.throws(() => h.svc.requestMandatoryCommitment({ amount_cents: 400_000_000n, product: "30yr_fixed_conforming", ptr_range: { low: "5.625", high: "6.125" }, period_days: 60, officer_authorization: null }), (e: unknown) => e instanceof PipelineRefused && e.code === "MANDATORY_DISABLED");
  assert.equal(h.escalations.list().filter((e) => e.payload.task === "officer_trade_authorization").length, 0);
  // The daily position and the MTM still run.
  const snap = (await b.run("takePipelineSnapshot", { whole_loan_price: "101.375" })).output as { snapshot_id: string; execution_mode: string; locked_uncommitted_cents: bigint };
  assert.equal(snap.execution_mode, "best_efforts"); assert.equal(snap.locked_uncommitted_cents, 60_000_000n); assert.ok(b.rt.store.get("pipeline_positions", snap.snapshot_id));
  const mtm = (await b.run("runMarkToMarket", { whole_loan_price: "101.375", whole_loan_price_id: "pewl-mark-1", at: ET("2026-10-08", "17:05") })).output as { run_id: string; gl_export_document_id: string; irlc_fv_cents: bigint };
  assert.ok(mtm.gl_export_document_id.startsWith("gl-export-")); assert.equal(h.emitted("mtm.run.completed").length, 1); assert.ok(b.rt.store.get("mark_to_market_runs", mtm.run_id));
  assert.equal(hedgeProgramEligibility({ product_code: "30yr_fixed_conforming", flags: { "execution.mandatory_enabled": false }, policy: h.svc.policy(), as_of: D("2026-10-08") }).execution, "best_efforts");
});
test("29.2-T11: Given a lock executed Wed Oct 7, 2026 that remains uncommitted (PE–WL outage), then `SM_UNCOMMITTED_POSITION_5BD` is due Wed Oct 14, 2026 (Oct 8, 9, 13, 14 — Mon Oct 12 Columbus Day is a SIFMA close) and breaches sev 2 to the `officer` if still uncommitted.", async () => {
  // +5 fannie_sifma business days from Wed Oct 7 (Mon Oct 12 Columbus Day is a SIFMA close): Oct 8, 9, 13, 14, 15 → Thu Oct 15, 5:00 p.m. ET. The spec's "Wed Oct 14 (Oct 8, 9, 13, 14)" lists only four business days — the engine's calendar-correct fifth day is asserted (reported as a discrepancy).
  assert.equal(uncommittedPositionDue(ET("2026-10-07", "12:19")).due_on, "2026-10-15"); assert.equal(uncommittedPositionDue(ET("2026-10-07", "12:19")).due_at, ET("2026-10-15", "17:00"));
  assert.equal(uncommittedPositionDue(ET("2026-10-07", "12:19"), 4).due_on, "2026-10-14", "the spec's four listed days");
  const h = harness(ET("2026-10-07", "08:00"));
  h.lockExecuted({ lock_id: "L-fixture", locked_at: ET("2026-10-07", "12:19"), amount_cents: 56_000_000n });
  const t = h.armed("SM_UNCOMMITTED_POSITION_5BD"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-15"); assert.equal(new Date(t[0]!.dueAt!).toISOString(), ET("2026-10-15", "17:00")); assert.equal(t[0]!.applicationId, APP);
  assert.equal(h.svc.lock("L-fixture").state, "locked_uncommitted");
  // PE–WL outage: no commitment.executed by 5:00 p.m. ET on the due day → sev 2 breach → partner officer; the daily snapshots keep quantifying the exposure.
  h.clock.set(ET("2026-10-14", "07:00")); assert.equal(h.svc.takeSnapshot({ whole_loan_price: "101.250" }).locked_uncommitted_cents, 56_000_000n);
  assert.equal(h.tick(ET("2026-10-15", "16:59")).filter((b) => b.def.code === "SM_UNCOMMITTED_POSITION_5BD").length, 0);
  const breaches = h.tick(ET("2026-10-15", "17:01")).filter((b) => b.def.code === "SM_UNCOMMITTED_POSITION_5BD");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.severity, 2); assert.deepEqual(breaches[0]!.escalateTo, ["officer"]);
  const escId = h.svc.handleBreach(breaches[0]!); const esc = h.escalations.list().find((e) => e.id === escId)!;
  assert.equal(esc.kind, "officer"); assert.equal(esc.severity, "sev2"); assert.equal(esc.applicationId, APP); assert.equal(esc.payload.task, "officer_uncommitted_position");
  // A lock committed on Oct 9 closes its clock on time.
  h.lockExecuted({ lock_id: "L-2", application_id: "app-2", locked_at: ET("2026-10-15", "17:05"), amount_cents: 41_200_000n }); assert.equal(h.armed("SM_UNCOMMITTED_POSITION_5BD")[0]!.dueDate, "2026-10-22");
  h.committed("L-2", "101.000", "2026-12-14", ET("2026-10-16", "08:20"), "app-2"); assert.equal(h.armed("SM_UNCOMMITTED_POSITION_5BD").length, 0);
});
test("29.2-T12: Given the 5:00 p.m. ET mark completes at 5:20 p.m. ET Mon Nov 2, then the GL export file for the partner exists by 7:00 p.m. ET with `irlc_fv`, `hfs_fv`, `hedge_fv`, `net_fv`, `day_change` and the price sources; a rerun with the same snapshot and price ids reproduces identical numbers.", async () => {
  const h = mandatoryHarness(); openHedge(h);
  h.svc.patchLock("M1", { stage: "funded", state: "funded_unsold", funded_on: D("2026-10-30"), upb_cents: 100_000_000n, cost_basis_cents: 100_000_000n });
  h.clock.set(ET("2026-11-02", "16:00")); const snap = h.svc.takeSnapshot({ whole_loan_price: "102.250", tba_price: "101.500" });
  const inputs = { snapshot_id: snap.snapshot_id, whole_loan_price: "102.250", whole_loan_price_id: "pewl-mark-2026-11-02-1700", tba_price: "101.500", tba_price_id: "dealer-a-run-2026-11-02-1700", hfs_net_price_market: "102.000" };
  const run = h.svc.runMarkToMarket({ ...inputs, at: ET("2026-11-02", "17:20") });
  assert.equal(run.exported_at, ET("2026-11-02", "17:20")); assert.ok(run.exported_at <= ET("2026-11-02", "19:00"), "the GL export exists by 7:00 p.m. ET");
  assert.deepEqual(Object.keys(run.gl_export).filter((k) => ["irlc_fv", "hfs_fv", "hedge_fv", "net_fv", "day_change", "price_sources"].includes(k)).sort(), ["day_change", "hedge_fv", "hfs_fv", "irlc_fv", "net_fv", "price_sources"]);
  assert.deepEqual(run.price_sources, { whole_loan: "pewl-mark-2026-11-02-1700", tba: "dealer-a-run-2026-11-02-1700" });
  assert.equal(run.hedge_fv_cents, -4_000_000n, "$4,000,000 short from 100.500 to 101.500"); assert.equal(run.hfs_loans_fv_cents, 102_000_000n); assert.equal(run.hfs_loans_cost_basis_cents, 100_000_000n);
  assert.equal(run.irlc_fv_cents, run.irlc_sale_price_component_cents + run.irlc_servicing_component_cents); assert.equal(run.net_fv_cents, run.irlc_fv_cents + run.hfs_loans_fv_cents + run.hedge_fv_cents); assert.equal(run.day_change_cents, run.net_fv_cents, "first run: no prior day");
  assert.equal(run.gl_export.net_fv, String(run.net_fv_cents)); assert.equal(run.gl_export.day_change, String(run.day_change_cents));
  const ev = h.emitted("mtm.run.completed").at(-1)!; assert.equal(ev.payload.gl_exported, true); assert.equal(ev.payload.export_hash, run.export_hash); assert.equal(ev.payload.gl_export_document_id, run.gl_export_document_id);
  assert.equal(h.emitted("timer.satisfied").filter((e) => e.payload.code === "SM_MTM_DAILY_1700ET").length, 1); assert.equal(h.armed("SM_MTM_DAILY_1700ET").map((t) => t.dueDate).join(","), "2026-11-03");
  // A rerun with the same snapshot and price ids reproduces identical numbers and the same export hash.
  const rerun = h.svc.runMarkToMarket({ ...inputs, at: ET("2026-11-02", "17:20") });
  assert.equal(rerun.export_hash, run.export_hash); assert.equal(rerun.gl_export_document_id, run.gl_export_document_id);
  assert.deepEqual([rerun.irlc_fv_cents, rerun.hfs_loans_fv_cents, rerun.hedge_fv_cents, rerun.net_fv_cents, rerun.day_change_cents], [run.irlc_fv_cents, run.hfs_loans_fv_cents, run.hedge_fv_cents, run.net_fv_cents, run.day_change_cents]);
  assert.throws(() => h.svc.runMarkToMarket({ ...inputs, whole_loan_price_id: "pewl-cob-display", close_of_business: true, at: ET("2026-11-02", "18:00") }), (e: unknown) => e instanceof PipelineRefused && e.code === "COB_PRICE_UNFLAGGED");
});
test("29.2-T13: Given the partner's `hedge_policies.review_due_on = 2027-10-01` and no new version by then, then `SM_HEDGE_POLICY_REVIEW_1Y` breaches and new locks are excluded from the hedge program (committed best efforts) until a version is approved.", async () => {
  assert.equal(policyReviewDueOn(D("2026-10-01")), "2027-10-01");
  const h = harness(ET("2026-10-01", "09:00"), { flags: { "execution.mandatory_enabled": true }, policy: { execution_mode: "mandatory", instruments: ["tba_umbs_30", "fnma_mandatory_commitment"] } });
  const v1 = h.svc.policy()!; assert.equal(v1.version, 1); assert.equal(v1.review_due_on, "2027-10-01");
  const t = h.armed("SM_HEDGE_POLICY_REVIEW_1Y"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2027-10-01");
  assert.equal(h.svc.eligibility({ product_code: "30yr_fixed_conforming", amortization: "fixed" }, ET("2027-09-30", "10:00")).execution, "mandatory_pipeline");
  // No new version by 2027-10-01 → breach; new locks are excluded from the hedge program (committed best efforts) until a version is approved.
  const breaches = h.tick(ET("2027-10-02", "00:01")).filter((b) => b.def.code === "SM_HEDGE_POLICY_REVIEW_1Y"); assert.equal(breaches.length, 1);
  const escId = h.svc.handleBreach(breaches[0]!); assert.equal(h.escalations.list().find((e) => e.id === escId)!.payload.task, "officer_hedge_policy_review");
  const state = h.svc.policyState(D("2027-10-02")); assert.equal(state.review_overdue, true); assert.equal(state.mandatory_suspended_for_new_locks, true);
  const late = hedgeProgramEligibility({ product_code: "30yr_fixed_conforming", flags: { "execution.mandatory_enabled": true }, policy: v1, as_of: D("2027-10-02") });
  assert.equal(late.eligible, false); assert.equal(late.execution, "best_efforts"); assert.match(late.reason, /SM_HEDGE_POLICY_REVIEW_1Y/);
  h.lockExecuted({ lock_id: "L-late", application_id: "app-late", locked_at: ET("2027-10-02", "10:00"), amount_cents: 50_000_000n, transaction_type: "purchase" });
  assert.equal(h.svc.lock("L-late").hedge_program, false); assert.equal(h.svc.lock("L-late").state, "locked_uncommitted", "excluded from the hedge program → 29.1 commits it best efforts");
  // The officer approves version 2: the review row is satisfied (late) and re-armed a year out; new locks enter the program again.
  const v2 = h.svc.adoptPolicy({ effective_from: D("2027-10-05"), execution_mode: "mandatory", instruments: ["tba_umbs_30", "fnma_mandatory_commitment"], at: ET("2027-10-05", "09:00"), approved_by: "partner-officer" });
  assert.equal(v2.version, 2); assert.equal(v2.review_due_on, "2028-10-05"); assert.equal(h.emitted("hedge.policy.updated").at(-1)!.payload.initial, false);
  assert.equal(h.emitted("timer.satisfied").filter((e) => e.payload.code === "SM_HEDGE_POLICY_REVIEW_1Y" && e.payload.late === true).length, 1);
  assert.equal(h.armed("SM_HEDGE_POLICY_REVIEW_1Y").map((x) => x.dueDate).join(","), "2028-10-05");
  h.lockExecuted({ lock_id: "L-after", application_id: "app-after", locked_at: ET("2027-10-05", "10:00"), amount_cents: 50_000_000n, transaction_type: "purchase" });
  assert.equal(h.svc.lock("L-after").hedge_program, true); assert.equal(h.svc.lock("L-after").state, "mandatory_pipeline");
});

test("29.2 worked figures: $2,240.00 / $5,040.00 / $7,280.00 IRLC components, $497.74 extension insurance, −$40,000.00 hedge mark, −$4,000.00 pair-off cost, $3,000.00 fee or cash back, $625.00 extension", () => {
  // Worked example 1 (Oct 7 mark of the fixture loan): sale-price component $2,240.00, servicing component $5,040.00, IRLC fair value $7,280.00.
  const fv = irlcFairValue({ amount_cents: 56_000_000n, market_price: "101.375", lock_base_price: "100.875", probability: "0.80" });
  assert.equal(fv.irlc_sale_price_component_cents, 224_000n); assert.equal(fv.irlc_servicing_component_cents, 504_000n); assert.equal(fv.irlc_fv_cents, 728_000n);
  // Worked example 1: the 5-day extension quote recommended as insurance on the Oct 13 closing — $610,000 × 5.875%/360 × 5 = $497.74.
  const ins = extensionInsuranceQuote(61_000_000n, "5.875", 5); assert.equal(ins.fee_cents, 49_774n); assert.equal(ins.per_diem_cents, "9954.86");
  // Worked example 1: +25 bp → −$15,000; +100 bp → −$60,000; −25 bp → +$15,000 on the uncommitted $1,500,000.
  assert.equal(uncommittedExposureCents(150_000_000n, 25), -1_500_000n); assert.equal(uncommittedExposureCents(150_000_000n, 100), -6_000_000n); assert.equal(uncommittedExposureCents(150_000_000n, -25), 1_500_000n);
  // Worked example 2 (Nov 2): hedge $4,000,000 × (100.500 − 101.500)/100 = −$40,000.00; buy-back of $400,000 at 101.500 realizes −$4,000.00; coverage 4,000,000 ÷ 3,600,000 = 1.1111.
  assert.equal(hedgeFairValue(400_000_000n, "100.500", "101.500"), -4_000_000n); assert.equal(tbaPairOffPl(40_000_000n, "100.500", "101.500"), -400_000n);
  assert.equal(computeCoverage({ hedge_face_cents: 400_000_000n, duration_factor: "1.00", expected_deliverable_cents: 360_000_000n }).coverage_ratio, "1.1111");
  assert.equal(computeCoverage({ hedge_face_cents: 0n, duration_factor: "1.00", expected_deliverable_cents: 400_000_000n }).target_hedge_face_cents, 400_000_000n);
  // Worked example 2: the $2,240,000 closed balance's mandatory commitment tolerance max($10,000, 2.5%) = $56,000; margin: $40,000 excess loss − $25,000 threshold = $15,000 call.
  assert.equal(mandatoryTolerance(224_000_000n).tolerance_cents, 5_600_000n); assert.equal(marginCallAmount(4_000_000n).call_cents, 1_500_000n);
  // Worked example 2 rate-shock table: −100 bp hedge −$144,000, pipeline +$115,200, projected call $104,000; +100 bp under-hedge $800,000, net −$14,400.
  const rows = rateShockTable({ covered_amount_cents: 500_000_000n, expected_deliverable_cents: 360_000_000n, p_base: "0.80", hedge_face_cents: 360_000_000n, hedge_trade_price: "100.500", hedge_mark_price: "101.500", margin_posted_cents: 4_000_000n });
  assert.deepEqual([rows[0]!.hedge_value_cents, rows[0]!.pipeline_value_cents, rows[0]!.projected_margin_call_cents], [-14_400_000n, 11_520_000n, 10_400_000n]); assert.deepEqual([rows[6]!.under_hedge_cents, rows[6]!.net_value_cents], [80_000_000n, -1_440_000n]);
  // Worked example 3 (Dec 4): tolerance $100,000; pair-off of $300,000 at 102.250 → fee $3,000.00; at 100.250 → cash back $3,000.00; 10-day extension of $400,000 at 5.625% → $625.00.
  assert.equal(mandatoryTolerance(400_000_000n).tolerance_cents, 10_000_000n);
  const d = commitmentPairOffOrExtend({ commitment_id: "c", original_amount_cents: 400_000_000n, commitment_price: "101.250", live_price: "102.250", expires_on: D("2026-12-07"), expected_deliverable_cents: 360_000_000n, late_balance_cents: 40_000_000n, late_loan_stages: ["cd_delivered", "cd_delivered"], extension_days: 10, min_ptr: "5.625", as_of: ET("2026-12-04", "09:00") });
  assert.equal(d.pair_off.fee_cents, 300_000n); assert.equal(d.extension.fee_cents, 62_500n);
  assert.equal(commitmentPairOffOrExtend({ commitment_id: "c", original_amount_cents: 400_000_000n, commitment_price: "101.250", live_price: "100.250", expires_on: D("2026-12-07"), expected_deliverable_cents: 360_000_000n, late_balance_cents: 40_000_000n, late_loan_stages: ["ctc"], extension_days: 10, min_ptr: "5.625", as_of: ET("2026-12-04", "09:00") }).pair_off.cash_back_cents, 300_000n);
  // Rule 3: the duration factor from paired price moves (whole loan +1.000 against TBA +1.000 → 1.0000; +0.900 against +1.000 → 0.9000).
  assert.equal(estimateDurationFactor([{ whole_loan_price: "101.250", hedge_price: "100.500" }, { whole_loan_price: "102.250", hedge_price: "101.500" }]).duration_factor, "1.0000");
  assert.equal(estimateDurationFactor([{ whole_loan_price: "101.250", hedge_price: "100.500" }, { whole_loan_price: "102.150", hedge_price: "101.500" }]).duration_factor, "0.9000");
  assert.equal(estimateDurationFactor([]).method, "default"); assert.equal(PULL_THROUGH_MODEL_V1.parameters.stage_base.cd_delivered, "0.97");
});
