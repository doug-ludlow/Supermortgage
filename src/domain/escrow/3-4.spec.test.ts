// 3.4 Cushion enforcement
// spec/sections/03-escrow-administration/3-4-cushion-enforcement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths, addDays } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import { eventMatches, type DomainEvent } from "../../kernel/events/index.ts";
import { project, decide, newPayment, cushion, effectiveDate, anomalies } from "./analysis.ts";
const E = [{ line_type: "school_tax", amount_cents: cents("360"), disburse_on: D("2026-09-15") }, { line_type: "county_tax", amount_cents: cents("500"), disburse_on: D("2026-07-15") }, { line_type: "county_tax", amount_cents: cents("700"), disburse_on: D("2026-12-15") }];
const A = [{ line_type: "county_tax", amount_cents: cents("520"), disburse_on: D("2027-07-15") }, { line_type: "county_tax", amount_cents: cents("760"), disburse_on: D("2027-12-15") }, { line_type: "school_tax", amount_cents: cents("380"), disburse_on: D("2027-09-15") }];
void E; void A; void addMonths; void addDays; void project; void decide; void newPayment; void cushion; void effectiveDate; void anomalies;
import { reviewStatus, multiYearContribution } from "./ops.ts";
import { recordCushionCheck, cushionCheckReasons, beginAnalysisComputation } from "./ops-3-4.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { escrowBus, ESCROW_AGENT, type EscrowBus } from "./spec-harness.ts";

const BOARDING = { kind: "agent", id: "boarding" } as const;
const CAP_GATE = "REGX_1024_17C5_CUSHION_CAP_GATE", PREACCRUAL_GATE = "REGX_1024_17C6_PREACCRUAL_GATE", INHERITED_10BD = "ESC_INHERITED_CUSHION_CHECK_10BD";
const pay = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const loanTimers = (bus: EscrowBus, code: string, loanId = "L-1") => bus.ctx.timers.byCode(code).filter((t) => t.loanId === loanId);
/** 1.1's `loan.boarded` fact for an escrowed loan — the ESC_INHERITED_CUSHION_CHECK_10BD trigger, anchored on `boarded_at`. */
const board = (bus: EscrowBus, loanId: string, boardedAt: string, escrowed = true) =>
  bus.events.append({ type: "loan.boarded", loanId, aggregate: { kind: "transfer_batch", id: "TB-1" }, actor: BOARDING, payload: { loan_id: loanId, transfer_date: boardedAt.slice(0, 10), boarded_at: boardedAt, escrowed, regx_days_delinquent: 0 } });

test("3.4-T1: Given annual $1,660.00 and policy 2 months, then cushion $276.66 and lowest target ≤ $276.66.", async () => {
  const c = cushion(166_000n, { policy_months: 2 }); assert.equal(c.cents, 27_666n);
  const p = project(A, D("2027-07-01"), { policy_months: 2 }); assert.ok(p.targets.reduce((a, b) => (b < a ? b : a)) <= 27_666n); assert.equal(p.cap_ok, true);
  // Inside the engine: `escrow.analysis.computing` arms the cap gate; the module's `escrow.cushion.validated{cap_check_passed=true}` (cushion $276.66, low point ≤ cap) satisfies it.
  const bus = escrowBus("L-1", "2027-05-16T15:00:00.000Z", ["3.4"]);
  const run = (await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-T1", items: A, year_start: "2027-07-01", as_of: "2027-05-16", projected_actual_cents: 110_668n, cushion: { policy_months: 2 } })) as { status: string; projection: { cushion_cents: bigint; cap_cents: bigint } };
  assert.equal(run.status, "computed"); assert.equal(run.projection.cushion_cents, 27_666n); assert.equal(run.projection.cap_cents, 27_666n);
  const computing = bus.events.ofType("escrow.analysis.computing"); assert.equal(computing.length, 1); assert.equal(pay(computing[0]!).analysis_id, "EA-T1"); assert.equal(pay(computing[0]!).reason, "annual");
  const validated = bus.events.ofType("escrow.cushion.validated"); assert.equal(validated.length, 1); assert.equal(bus.events.ofType("escrow.cushion.cap_failed").length, 0);
  assert.equal(pay(validated[0]!).cushion_cents, "27666"); assert.equal(pay(validated[0]!).cushion_cap_cents, "27666"); assert.equal(pay(validated[0]!).cushion_cap_source, "policy"); assert.equal(pay(validated[0]!).cushion_months, 2);
  assert.equal(pay(validated[0]!).cap_check_passed, true); assert.equal(pay(validated[0]!).preaccrual_check_passed, true); assert.ok(BigInt(String(pay(validated[0]!).lowest_target_cents)) <= 27_666n);
  const reg = loadOverriddenRegistry(); assert.equal(eventMatches(reg.get(CAP_GATE)!.triggerPattern!, computing[0]!), true); assert.equal(eventMatches(reg.get(CAP_GATE)!.satisfiedPattern!, validated[0]!), true);
  for (const code of [CAP_GATE, PREACCRUAL_GATE]) { const t = loanTimers(bus, code); assert.equal(t.length, 1); assert.equal(t[0]!.status, "satisfied"); assert.equal(t[0]!.armedByEventId, computing[0]!.id); assert.equal(t[0]!.satisfiedByEventId, validated[0]!.id); assert.equal(t[0]!.dueAt, undefined); }
});
test("3.4-T2: Given instrument cushion 1 month, then cushion $138.33 and `cushion_cap_source='instrument'`.", () => {
  const c = cushion(166_000n, { instrument_months: 1 }); assert.equal(c.cents, 13_833n); assert.equal(c.source, "instrument");
  assert.equal(project(A, D("2027-07-01"), { instrument_months: 1 }).target_at_start_cents, 96_835n);   // $830.02 + $138.33 = $968.35
});
test("3.4-T3: Given a state override 1.5 months, then cushion floor(1,660 × 1.5/12) = $207.50 and source `state`.", () => {
  const c = cushion(166_000n, { state_max_months: 1.5 }); assert.equal(c.cents, 20_750n); assert.equal(c.source, "state");
});
test("3.4-T4: Given a projected disbursement dated before the bill's availability date, then `preaccrual_check_passed=false` and approval is blocked.", async () => {
  const early = [{ ...A[0]!, available_on: D("2027-08-01") }, A[1]!, A[2]!];   // the $520 county bill is projected 2027-07-15, before it is even available
  const p = project(early, D("2027-07-01"));
  assert.equal(p.preaccrual_ok, false);
  const r = reviewStatus(p.preaccrual_ok ? [] : ["preaccrual_check_failed"]); assert.equal(r.status, "anomaly_review"); assert.equal(r.decision_record.approval_blocked_until_reviewed, true);
  // Through the engine: computing → anomaly_review; `escrow.cushion.cap_failed{reason=preaccrual_check_failed}`; the cap gate closes (cap_check_passed=true) but the pre-accrual gate stays armed and approveAnalysis is refused — even "reviewed" (a hard block).
  const bus = escrowBus("L-1", "2027-05-16T15:00:00.000Z", ["3.4"]);
  const run = (await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-T4", items: early, year_start: "2027-07-01", as_of: "2027-05-16", projected_actual_cents: 110_668n })) as { status: string; anomalies: string[] };
  assert.equal(run.status, "anomaly_review"); assert.deepEqual(run.anomalies, ["preaccrual_check_failed"]);
  const validated = bus.events.ofType("escrow.cushion.validated"); const failed = bus.events.ofType("escrow.cushion.cap_failed");
  assert.equal(validated.length, 1); assert.equal(pay(validated[0]!).preaccrual_check_passed, false); assert.equal(pay(validated[0]!).cap_check_passed, true);
  assert.equal(failed.length, 1); assert.equal(pay(failed[0]!).reason, "preaccrual_check_failed"); assert.equal(failed[0]!.causationId, validated[0]!.id);
  assert.equal(loanTimers(bus, CAP_GATE)[0]!.status, "satisfied"); assert.equal(loanTimers(bus, PREACCRUAL_GATE)[0]!.status, "armed");
  assert.equal((await bus.refusal("3.1", "approveAnalysis", ESCROW_AGENT, { analysis_id: "EA-T4" }))?.code, "3.4.preaccrual");
  assert.equal((await bus.refusal("3.1", "approveAnalysis", ESCROW_AGENT, { analysis_id: "EA-T4", reviewed: true }))?.code, "3.4.preaccrual");
  // Fixed lines (the bill is available before its projected date) re-run under the same id: a second computing arms fresh gates, the passing validation closes every open one, approval proceeds.
  const fixed = (await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-T4", items: [{ ...A[0]!, available_on: D("2027-07-01") }, A[1]!, A[2]!], year_start: "2027-07-01", as_of: "2027-05-16", projected_actual_cents: 110_668n })) as { status: string };
  assert.equal(fixed.status, "computed"); assert.equal(bus.events.ofType("escrow.cushion.cap_failed").length, 1);
  assert.deepEqual(loanTimers(bus, PREACCRUAL_GATE).map((t) => t.status), ["satisfied", "satisfied"]);
  assert.equal(((await bus.run("3.1", "approveAnalysis", ESCROW_AGENT, { analysis_id: "EA-T4" })) as { status: string }).status, "approved");
});
test("3.4-T5: Given a transferor target implying a 3-month cushion, then the transfer-in analysis produces a surplus and a refund/credit decision.", async () => {
  const p = project(A, D("2027-07-01"));
  const transferorTarget = p.required_start_cents + 3n * p.base_payment_cents;   // a 3-month cushion
  const d = decide({ projection: p, projected_actual_cents: transferorTarget, as_of: D("2026-11-01"), regx_days_delinquent: 0 });
  assert.equal(d.kind, "refund"); if (d.kind === "refund") { assert.equal(d.surplus_cents, 3n * 13_833n - 27_666n); assert.equal(d.due_on, "2026-12-01"); }
  // Boarding (Thu 2026-10-01) arms ESC_INHERITED_CUSHION_CHECK_10BD: 10 servicer business days, skipping Columbus Day 2026-10-12 → Fri 2026-10-16. A non-escrowed boarding has no cushion to check.
  const bus = escrowBus("L-1", "2026-10-01T14:00:00.000Z", ["3.4"]);
  const boarded = board(bus, "L-1", "2026-10-01T14:00:00.000Z"); board(bus, "L-2", "2026-10-01T14:00:00.000Z", false);
  const armed = loanTimers(bus, INHERITED_10BD); assert.equal(armed.length, 1); assert.equal(armed[0]!.status, "armed"); assert.equal(armed[0]!.anchorDate, "2026-10-01"); assert.equal(armed[0]!.dueDate, "2026-10-16"); assert.equal(armed[0]!.armedByEventId, boarded.id);
  assert.equal(loanTimers(bus, INHERITED_10BD, "L-2").length, 0);
  // The boarding validator: the transferor's target implies a $414.99 cushion against a $276.66 cap → over the cap; its `escrow.cushion.validated` satisfies the check and the transfer_in analysis recomputes.
  const v = (await bus.run("3.4", "validateCushion", ESCROW_AGENT, { loan_id: "L-1", items: A, year_start: "2027-07-01", transferor_target_cents: transferorTarget })) as { cents: bigint; cap_check_passed: boolean; event_type: string; inherited: { implied_cushion_cents: bigint; over_cap: boolean; transfer_in_analysis_required: boolean } };
  assert.equal(v.cents, 27_666n); assert.equal(v.cap_check_passed, true); assert.equal(v.event_type, "escrow.cushion.validated");
  assert.deepEqual(v.inherited, { transferor_target_cents: transferorTarget, implied_cushion_cents: 41_499n, over_cap: true, transfer_in_analysis_required: true });
  const validated = bus.events.ofType("escrow.cushion.validated"); assert.equal(validated.length, 1); assert.equal(pay(validated[0]!).source, "boarding_validator"); assert.equal(pay(validated[0]!).analysis_id, null);
  const done = loanTimers(bus, INHERITED_10BD)[0]!; assert.equal(done.status, "satisfied"); assert.equal(done.satisfiedByEventId, validated[0]!.id);
  assert.equal(bus.events.ofType("timer.satisfied").filter((e) => pay(e).code === INHERITED_10BD).length, 1);
  const run = (await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-TI", analysis_type: "transfer_in", items: A, year_start: "2027-07-01", as_of: "2026-11-01", projected_actual_cents: transferorTarget })) as { decision: { kind: string; surplus_cents?: bigint; due_on?: string }; status: string };
  assert.equal(run.status, "computed"); assert.equal(run.decision.kind, "refund"); assert.equal(run.decision.surplus_cents, 13_833n); assert.equal(run.decision.due_on, "2026-12-01");
  assert.equal(((await bus.run("3.1", "approveAnalysis", ESCROW_AGENT, { analysis_id: "EA-TI" })) as { status: string }).status, "approved");
});
test("3.4-T6: Given a 3-year flood premium $1,800 due in year 2, then monthly share $50.00, cushion base includes $600.00, and the statement flag `low_point_not_reached` is set for years 1 and 3.", () => {
  const flood = { line_type: "flood", amount_cents: cents("1800"), cycle_years: 3 };
  assert.equal(multiYearContribution(flood.amount_cents, 3), 5_000n);                                                                       // $50.00 per month
  const year2 = project([...A, { ...flood, disburse_on: D("2028-03-01") }], D("2027-07-01"));                                              // the bill falls in this year
  assert.equal(year2.annual_for_cushion_cents, 166_000n + 60_000n); assert.equal(year2.cap_cents, 37_666n); assert.equal(year2.multi_year_low_point_flag, false);
  const year1 = project([...A, { ...flood, disburse_on: D("2028-03-01") }], D("2026-07-01"));                                              // the year before the bill
  const year3 = project([...A, { ...flood, disburse_on: D("2028-03-01") }], D("2028-07-01"));                                              // the year after it
  assert.equal(year1.multi_year_low_point_flag, true); assert.equal(year3.multi_year_low_point_flag, true);
  assert.equal(year1.annual_for_cushion_cents - project(A, D("2026-07-01")).annual_for_cushion_cents, 60_000n);                            // the cushion base carries the $600.00 share every year
});
test("3.4-T7: Given the agent sets cushion 0 months for a hardship request, then target start = required start and the decision record carries the reason.", async () => {
  const p = project(A, D("2027-07-01"), { policy_months: 0 });
  assert.equal(p.cushion_cents, 0n); assert.equal(p.target_at_start_cents, p.required_start_cents); assert.equal(p.target_at_start_cents, 83_002n);
  // The agent lowers the cushion on the bus (validateCushion carries the setCushionPolicy override — the manifest lists no separate tool); the bus writes the agent_decisions row with the reason.
  const bus = escrowBus("L-1", "2027-05-16T15:00:00.000Z"); const reason = "hardship request (borrower letter 2027-05-02)";
  const out = (await bus.run("3.4", "validateCushion", ESCROW_AGENT, { loan_id: "L-1", annual_cents: 166_000n, cushion: { policy_months: 0 }, reason })) as { cents: bigint; months: number; cap_check_passed: boolean; policy_override: { months: number; reason: string } | null };
  assert.deepEqual([out.cents, out.months, out.cap_check_passed, out.policy_override?.months, out.policy_override?.reason], [0n, 0, true, 0, reason]);
  assert.equal(bus.ctx.decisions.length, 1); assert.equal(bus.ctx.decisions[0]!.action, "cushion.override"); assert.match(bus.ctx.decisions[0]!.rationale, /hardship request/); assert.deepEqual(bus.ctx.decisions[0]!.subject, { kind: "loan", id: "L-1" });
  const validated = bus.events.ofType("escrow.cushion.validated"); assert.equal(validated.length, 1); assert.equal(pay(validated[0]!).cushion_months, 0); assert.equal(pay(validated[0]!).cushion_cents, "0"); assert.equal(pay(validated[0]!).preaccrual_check_passed, null);
  // No reason → no override (a lowered cushion is only a recorded policy override); above the cap → no discretion; the engine then runs and approves with the 0-month cushion.
  assert.equal((await bus.refusal("3.4", "validateCushion", ESCROW_AGENT, { annual_cents: 166_000n, cushion: { policy_months: 0 } }))?.code, "OVERRIDE_NEEDS_REASON");
  assert.equal((await bus.refusal("3.4", "validateCushion", ESCROW_AGENT, { annual_cents: 166_000n, cushion: { policy_months: 3 }, reason: "more cushion" }))?.code, "NO_DISCRETION_OVER_CAP");
  assert.equal(bus.ctx.decisions.length, 1); assert.equal(bus.events.ofType("escrow.cushion.validated").length, 1);
  const run = (await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-H", items: A, year_start: "2027-07-01", as_of: "2027-05-16", projected_actual_cents: 83_002n, cushion: { policy_months: 0 } })) as { projection: { target_at_start_cents: bigint; cushion_cents: bigint }; decision: { kind: string } };
  assert.equal(run.projection.cushion_cents, 0n); assert.equal(run.projection.target_at_start_cents, 83_002n); assert.equal(run.decision.kind, "balanced");
  const approved = (await bus.run("3.1", "approveAnalysis", ESCROW_AGENT, { analysis_id: "EA-H" })) as { status: string; projection: { cushion_cents: bigint } };
  assert.equal(approved.status, "approved"); assert.equal(approved.projection.cushion_cents, 0n);
});

// 3.4 worked example: a 3-year flood premium of $1,800.00 raises the cushion base by $600.00 and the cap to $376.66.
test("3.4 worked example: $1,800.00 three-year flood premium → annual for cushion $2,260.00, cap $376.66", () => {
  const p = project([...A, { line_type: "flood", amount_cents: cents("1800"), disburse_on: D("2028-03-01"), cycle_years: 3 }], D("2027-07-01"));
  assert.equal(p.annual_for_cushion_cents, 226_000n); assert.equal(p.cap_cents, 37_666n);
});

// 3.4 timer table: ESC_INHERITED_CUSHION_CHECK_10BD breaches at sev-3 when no validation lands within 10 servicer business days of boarding; a later validation satisfies it late.
test("3.4 timers: ESC_INHERITED_CUSHION_CHECK_10BD — 10 servicer business days from boarded_at, sev-3 breach, late validation", async () => {
  const bus = escrowBus("L-1", "2026-10-01T14:00:00.000Z", ["3.4"]);
  board(bus, "L-1", "2026-10-01T14:00:00.000Z");
  assert.deepEqual(bus.ctx.timers.evaluate("2026-10-16T20:00:00.000Z"), []);                                 // still due on the 16th
  const breaches = bus.ctx.timers.evaluate("2026-10-17T12:00:00.000Z");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, INHERITED_10BD); assert.equal(breaches[0]!.severity, 3); assert.match(breaches[0]!.breachText, /transfer_in/);
  await bus.run("3.4", "validateCushion", ESCROW_AGENT, { loan_id: "L-1", annual_cents: 166_000n });
  const t = loanTimers(bus, INHERITED_10BD)[0]!; assert.equal(t.status, "satisfied_late"); assert.equal(pay(bus.events.ofType("timer.satisfied")[0]!).late, true);
  // A Friday boarding after Veterans Day: Fri 2026-11-13 + 10 servicer BD (Thanksgiving 2026-11-26 closed) → Mon 2026-11-30.
  const bus2 = escrowBus("L-3", "2026-11-13T14:00:00.000Z", ["3.4"]); board(bus2, "L-3", "2026-11-13T14:00:00.000Z");
  assert.equal(loanTimers(bus2, INHERITED_10BD, "L-3")[0]!.dueDate, "2026-11-30");
});

// 3.4 Outputs: the module's loan_events — `escrow.cushion.validated` always carries both check fields; `escrow.cushion.cap_failed` names the reason(s).
test("3.4 ops: recordCushionCheck reasons and events; beginAnalysisComputation marks a workout for 3.6", () => {
  const bus = escrowBus("L-1", "2027-05-16T15:00:00.000Z");
  assert.deepEqual(cushionCheckReasons({ cap_check_passed: false, preaccrual_check_passed: false }), ["cushion_cap_failed", "preaccrual_check_failed"]);
  assert.deepEqual(cushionCheckReasons({ cap_check_passed: true, preaccrual_check_passed: null }), []);
  const over = recordCushionCheck(bus.events, { loan_id: "L-1", analysis_id: "EA-X", source: "engine", cushion_months: 2, cushion_cents: 41_499n, cushion_cap_source: "policy", cushion_cap_cents: 27_666n, lowest_target_cents: 41_499n, cap_check_passed: false, preaccrual_check_passed: false, actor: ESCROW_AGENT });
  assert.equal(over.passed, false); assert.equal(over.cap_failed?.type, "escrow.cushion.cap_failed"); assert.equal(pay(over.cap_failed!).reason, "cushion_cap_failed+preaccrual_check_failed"); assert.deepEqual(pay(over.cap_failed!).reasons, ["cushion_cap_failed", "preaccrual_check_failed"]);
  assert.equal(pay(over.validated).cushion_cents, "41499"); assert.equal(pay(over.validated).cap_check_passed, false);
  assert.throws(() => recordCushionCheck(bus.events, { loan_id: "", analysis_id: null, source: "engine", cushion_months: 2, cushion_cents: 0n, cushion_cap_source: "policy", cushion_cap_cents: 0n, lowest_target_cents: null, cap_check_passed: true, preaccrual_check_passed: null, actor: ESCROW_AGENT }), RangeError);
  assert.throws(() => beginAnalysisComputation(bus.events, { loan_id: "L-1", analysis_id: "", analysis_type: "annual", as_of: D("2027-05-16"), year_start: D("2027-07-01"), actor: ESCROW_AGENT }), RangeError);
  const w = beginAnalysisComputation(bus.events, { loan_id: "L-1", analysis_id: "EA-W", analysis_type: "interim", workout: true, as_of: D("2027-05-16"), year_start: D("2027-07-01"), actor: ESCROW_AGENT });
  assert.equal(w.type, "escrow.analysis.computing"); assert.equal(pay(w).reason, "workout"); assert.equal(pay(w).analysis_type, "interim");
});
