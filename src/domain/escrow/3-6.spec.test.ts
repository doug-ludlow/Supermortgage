// 3.6 Shortage repayment
// spec/sections/03-escrow-administration/3-6-shortage-repayment.md
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
import { buildPlan, lumpSum, recordInstallment, demandDeficiencyGate, supersedePlan, type Plan } from "./shortage.ts";
import { lumpSumWordingAllowed } from "./statement.ts";
import { nhDeficiencyOffer, planText, recordStatementSent } from "./ops.ts";
import { escrowBus, ESCROW_AGENT, type EscrowBus } from "./spec-harness.ts";
import type { RepaymentPlanRecord } from "./ops-3-6.ts";
import { buildRegistry } from "../../notices/catalog.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { render } from "../../notices/render.ts";

// ---- bus helpers: the engine's analysis (3.1 runEscrowAnalysis + approveAnalysis) the 3.6 plan follows; timers armed for the named processes.
const analyse = async (bus: EscrowBus, id: string, i: Record<string, unknown>) => { const r = await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: id, items: A, year_start: "2027-07-01", as_of: "2027-05-16", ...i }) as { decision: { kind: string }; status: string }; await bus.run("3.1", "approveAnalysis", ESCROW_AGENT, { analysis_id: id, reviewed: true }); return r; };
const plan = async (bus: EscrowBus, i: Record<string, unknown>) => (await bus.run("3.6", "createRepaymentPlan", ESCROW_AGENT, i)) as RepaymentPlanRecord & { superseded: string[]; gates: string[]; loan_terms: { version: number; escrow_payment_cents: bigint; escrow_step_down_on: string; escrow_step_down_to_cents: bigint } };
const timer = (bus: EscrowBus, code: string, n = 0) => { const t = bus.ctx.timers.byCode(code)[n]; assert.ok(t, `${code} not armed`); return t; };
const types = (bus: EscrowBus) => bus.events.all().map((e) => e.type).filter((t) => !t.startsWith("timer.") && !t.startsWith("command."));
/** 3.6 worked example (c): a workout analysis whose shortage is $2,400.00 (one $2,400 tax due right after the year start; balance $200). */
const W = [{ line_type: "county_tax", amount_cents: cents("2400"), disburse_on: D("2027-07-15") }];

test("3.6-T1: Given shortage $406.68 and base $138.33, then plan 12 × $33.89, final $33.89, and `loan_terms` shows $172.22 from 2027-07-01 stepping to $138.33 on 2028-07-01.", async () => {
  const p = buildPlan("shortage", 40_668n, D("2027-07-01"), {}) as Plan;
  assert.deepEqual([p.months, p.installment_cents, p.final_installment_cents, p.end_due_date], [12, 3_389n, 3_389n, "2028-06-01"]);
  const proj = project(A, D("2027-07-01")); const d = decide({ projection: proj, projected_actual_cents: cents("700"), as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  assert.equal(newPayment(proj, d).payment_cents, 17_222n); assert.equal(proj.base_payment_cents, 13_833n);
  // On the bus: the plan follows the approved analysis (base $138.33, shortage $406.68) and versions `loan_terms` with the step-down date at creation (rule 5).
  const bus = escrowBus("L-1", "2027-05-16T15:00:00.000Z", ["3.6"]);
  await analyse(bus, "EA-1", { projected_actual_cents: cents("700") });
  const rp = await plan(bus, { kind: "shortage", total_cents: 40_668n, start: "2027-07-01" });
  assert.deepEqual([rp.months, rp.installment_cents, rp.final_installment_cents, rp.start_due_date, rp.end_due_date, rp.step_down_on, rp.basis, rp.status], [12, 3_389n, 3_389n, "2027-07-01", "2028-06-01", "2028-07-01", "regx_12", "active"]);
  const terms = bus.rt.store.get("loan_terms", "L-1")!.data;
  assert.deepEqual([terms.escrow_payment_cents, terms.escrow_payment_effective_from, terms.escrow_step_down_on, terms.escrow_step_down_to_cents, terms.shortage_installment_cents], [17_222n, "2027-07-01", "2028-07-01", 13_833n, 3_389n]);   // $172.22 from 2027-07-01 stepping to $138.33 on 2028-07-01
  assert.equal(bus.rt.store.get("escrow_repayment_plans", rp.id)!.data.status, "active");
  assert.deepEqual(types(bus).filter((t) => t.startsWith("escrow.repayment_plan") || t.startsWith("loan_terms")), ["escrow.repayment_plan.created", "loan_terms.versioned"]);
  assert.equal(bus.ctx.decisions.at(-1)?.subject?.id, rp.id);
  // The gate rows armed by `escrow.analysis.computing` are satisfied by the analysis approval (approveAnalysis asserts 3.6.shortageMinSpread on the engine's decision).
  assert.deepEqual([timer(bus, "REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE").status, timer(bus, "REGX_1024_17F4_DEFICIENCY_MIN_INSTALLMENTS_GATE").status], ["satisfied", "satisfied"]);
  // The engine's figure is the plan's: an agent-stated total that differs is not accepted (3.1 guardrails: engine outputs are not editable).
  await assert.rejects(plan(bus, { kind: "shortage", total_cents: 40_000n, start: "2027-07-01" }), /not the engine's shortage of 40668/);
});
test("3.6-T2: Given shortage $100.00 (< one month), then options allow/30-day/12-month are available and the default plan is 12 × $8.33 with final $8.37.", async () => {
  const s = buildPlan("shortage", 10_000n, D("2027-07-01"), {}) as Plan; assert.deepEqual([s.installment_cents, s.final_installment_cents], [833n, 837n]);
  const proj = project(A, D("2027-07-01")); const d = decide({ projection: proj, projected_actual_cents: proj.target_at_start_cents - 10_000n, as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  assert.equal(d.kind, "shortage"); if (d.kind === "shortage") { assert.equal(d.lump_sum_option_offered, true); assert.equal(d.months, 12); }   // allow (the decision alone) / 30-day / 12-month options available
  const bus = escrowBus("L-1", "2027-05-16T15:00:00.000Z", ["3.6"]);
  await analyse(bus, "EA-1", { projected_actual_cents: proj.target_at_start_cents - 10_000n });
  const dflt = await plan(bus, { kind: "shortage", start: "2027-07-01" });                                    // default: 12 × $8.33, final $8.37
  assert.deepEqual([dflt.total_cents, dflt.months, dflt.installment_cents, dflt.final_installment_cents], [10_000n, 12, 833n, 837n]);
  const thirty = await plan(bus, { kind: "shortage", total_cents: 10_000n, start: "2027-07-01", option: "30_day" });   // (f)(3)(i) 30-day option: one installment (the stated total is checked against the engine's)
  assert.deepEqual([thirty.months, thirty.installment_cents, thirty.basis, thirty.end_due_date, thirty.superseded], [1, 10_000n, "regx_30day", "2027-07-01", [dflt.id]]);
  // A ≥-one-month shortage ($406.68 ≥ $138.33) has no 30-day option: the registry gate refuses it (§1024.17(f)(3)(ii)).
  const big = escrowBus("L-2", "2027-05-16T15:00:00.000Z", ["3.6"]); await analyse(big, "EA-2", { projected_actual_cents: cents("700") });
  const refused = await big.refusal("3.6", "createRepaymentPlan", ESCROW_AGENT, { kind: "shortage", start: "2027-07-01", months: 1 });
  assert.deepEqual([refused?.code, refused?.citation], ["3.6.shortageMinSpread", "REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE"]);
});
test("3.6-T3: Given deficiency $150.00 with `regx_days_delinquent=0`, then plan 12 × $12.50; given 2 installments configured, then 2 × $75.00.", () => {
  assert.equal((buildPlan("deficiency", 15_000n, D("2027-07-01"), {}) as Plan).installment_cents, 1_250n);
  assert.equal((buildPlan("deficiency", 15_000n, D("2027-07-01"), { deficiency_installments: 2 }) as Plan).installment_cents, 7_500n);
});
test("3.6-T4: Given a workout analysis shortage $2,400 with no election, then 60 × $40.00; with an evidenced 24-month election, 24 × $100.00; with a 6-month election, the election is rejected (≥ 12).", async () => {
  assert.equal((buildPlan("shortage", cents("2400"), D("2027-07-01"), { workout: true }) as Plan).installment_cents, 4_000n);
  assert.equal((buildPlan("shortage", cents("2400"), D("2027-07-01"), { workout: true, election_months: 24 }) as Plan).installment_cents, 10_000n);
  assert.ok("error" in buildPlan("shortage", cents("2400"), D("2027-07-01"), { workout: true, election_months: 6 }));
  // On the bus: the workout analysis (`escrow.analysis.computing{reason=workout}`) arms FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE; approval satisfies it; the plan is bound by the same evaluator.
  const bus = escrowBus("L-1", "2027-05-16T15:00:00.000Z", ["3.6"]);
  await analyse(bus, "EA-W", { items: W, workout: true, regx_days_delinquent: 90, projected_actual_cents: cents("200") });
  assert.equal(timer(bus, "FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE").status, "satisfied");
  const sixty = await plan(bus, { kind: "shortage", start: "2027-07-01" });
  assert.deepEqual([sixty.total_cents, sixty.months, sixty.installment_cents, sixty.basis, sixty.gates.includes("FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE")], [240_000n, 60, 4_000n, "workout_60", true]);
  // The caller's election_months is not evidence: with no `escrow.election.recorded` on the loan the gate refuses the shorter spread.
  const unevidenced = await bus.refusal("3.6", "createRepaymentPlan", ESCROW_AGENT, { kind: "shortage", start: "2027-07-01", election_months: 24 });
  assert.deepEqual([unevidenced?.code, unevidenced?.citation], ["3.6.workoutSpread60", "FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE"]);
  const el = (await bus.run("3.6", "recordBorrowerElection", ESCROW_AGENT, { election_id: "EL-1", months: 24, evidence_document_id: "DOC-esign-1" })) as { kind: string; months: number };
  assert.deepEqual([el.kind, el.months], ["shorter_period", 24]);
  const elected = await plan(bus, { kind: "shortage", start: "2027-07-01", election_months: 24 });                        // evidenced 24-month election → 24 × $100.00
  assert.deepEqual([elected.months, elected.installment_cents, elected.basis, elected.election_id, elected.election_evidence_document_id, elected.superseded], [24, 10_000n, "election", "EL-1", "DOC-esign-1", [sixty.id]]);
  assert.equal((await plan(bus, { kind: "shortage", start: "2027-07-01" })).months, 24);                                     // the recorded election is honored without restating it
  assert.equal(bus.ctx.decisions.filter((d) => d.subject?.id === elected.id)[0]?.evidenceDocumentIds?.[0], "DOC-esign-1");
  // A 6-month election is rejected (≥ 12): as an election, and as a plan.
  assert.equal((await bus.refusal("3.6", "recordBorrowerElection", ESCROW_AGENT, { election_id: "EL-2", months: 6, evidence_document_id: "DOC-esign-2" }))?.code, "ELECTION_MIN_12");
  assert.equal((await bus.refusal("3.6", "recordBorrowerElection", ESCROW_AGENT, { election_id: "EL-3", months: 18 }))?.code, "EVIDENCED");
  assert.equal((await bus.refusal("3.6", "createRepaymentPlan", ESCROW_AGENT, { kind: "shortage", start: "2027-07-01", election_months: 6 }))?.code, "3.6.workoutSpread60");
});
test("3.6-T5: Given `instrument_shortage_max_months=12` and policy 24, then months = 12.", async () => {
  const capped = buildPlan("shortage", cents("2400"), D("2027-07-01"), { policy_months: 24, instrument_max_months: 12 }) as Plan; assert.equal(capped.months, 12); assert.equal(capped.basis, "instrument_cap");
  // §1024.17(f)(3)(ii) / (c)(8): an instrument cap below 12 does not control — the ≥-one-month shortage still spreads over 12 months (deficiencies floor at 2).
  const six = buildPlan("shortage", 40_668n, D("2027-07-01"), { instrument_max_months: 6 }) as Plan; assert.deepEqual([six.months, six.installment_cents, six.basis], [12, 3_389n, "regx_12"]);
  assert.equal((buildPlan("deficiency", 15_000n, D("2027-07-01"), { instrument_max_months: 1 }) as Plan).months, 2);
  const bus = escrowBus("L-1", "2027-05-16T15:00:00.000Z", ["3.6"]);
  await analyse(bus, "EA-1", { projected_actual_cents: cents("700") });   // the plan follows the engine's analysis
  const viaBus = await plan(bus, { kind: "shortage", total_cents: 40_668n, start: "2027-07-01", months: 24, instrument_max_months: 12 });
  assert.deepEqual([viaBus.months, viaBus.basis], [12, "instrument_cap"]);
  assert.equal((await plan(bus, { kind: "shortage", total_cents: 40_668n, start: "2027-07-01", instrument_max_months: 6 })).months, 12);
  // A spread under 12 months for a ≥-one-month shortage is refused by the registry gate, not by a policy number.
  const refused = await bus.refusal("3.6", "createRepaymentPlan", ESCROW_AGENT, { kind: "shortage", total_cents: 40_668n, start: "2027-07-01", months: 6 });
  assert.deepEqual([refused?.code, refused?.citation], ["3.6.shortageMinSpread", "REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE"]);
});
test("3.6-T6: Given an unsolicited lump sum equal to remaining shortage, then plan `paid_lump`, interim analysis within 10 BD, short-year statement, and the payment steps down on the first due date ≥ 30 days after the statement.", async () => {
  const p = buildPlan("shortage", 40_668n, D("2027-07-01"), {}) as Plan;
  const ls = lumpSum(p, 40_668n, D("2027-09-10")); assert.equal(ls.paid, true); assert.equal(p.status, "paid_lump"); assert.equal(ls.interim_analysis_by, "2027-09-24");
  // On the bus: the receipt posts to escrow, marks the plan paid_lump and arms ESC_LUMPSUM_REANALYSIS_10BD from the received date (10 servicer BD: Fri 2027-09-10 → 2027-09-24).
  const bus = escrowBus("L-1", "2027-09-10T15:00:00.000Z", ["3.6"]);
  await analyse(bus, "EA-1", { projected_actual_cents: cents("700") });
  const rp = await plan(bus, { kind: "shortage", total_cents: 40_668n, start: "2027-07-01" });
  const paid = (await bus.run("3.6", "postEscrowLumpSum", ESCROW_AGENT, { plan_id: rp.id, amount_cents: 40_668n, received_on: "2027-09-10" })) as { paid: boolean; status: string; remaining_cents: bigint; interim_analysis_by: string };
  assert.deepEqual([paid.paid, paid.status, paid.remaining_cents, paid.interim_analysis_by], [true, "paid_lump", 0n, "2027-09-24"]);
  assert.equal(bus.rt.store.get("escrow_repayment_plans", rp.id)!.data.status, "paid_lump");
  const received = bus.events.ofType("escrow.lump_sum.received")[0]!; assert.deepEqual([received.payload.plan_id, received.payload.received_on, received.payload.paid], [rp.id, "2027-09-10", true]);
  assert.equal(bus.events.ofType("escrow.repayment_plan.paid_lump").length, 1);
  const t = timer(bus, "ESC_LUMPSUM_REANALYSIS_10BD"); assert.deepEqual([t.status, t.anchorDate, t.dueDate], ["armed", "2027-09-10", "2027-09-24"]);
  assert.equal((await bus.refusal("3.6", "postEscrowLumpSum", ESCROW_AGENT, { plan_id: rp.id, amount_cents: 1n, demanded: true }))?.code, "UNSOLICITED_ONLY");
  // The interim analysis (2027-09-15, within 10 BD) satisfies the timer; the short-year statement (09-18) resets the year and the payment steps down on the first due date ≥ 30 days later.
  const next = A.map((x) => ({ ...x, disburse_on: x.disburse_on < D("2027-10-01") ? addMonths(x.disburse_on, 12) : x.disburse_on }));   // the short year's projection: the same bills in the 2027-10-01 window
  const interim = await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-interim", analysis_type: "interim", reset: true, items: next, year_start: "2027-10-01", as_of: "2027-09-15", projected_actual_cents: project(next, D("2027-10-01")).target_at_start_cents }) as { decision: { kind: string }; payment: { payment_cents: bigint } };
  assert.deepEqual([t.status, interim.decision.kind, interim.payment.payment_cents], ["satisfied", "balanced", 13_833n]);
  recordStatementSent(bus.events, { loan_id: "L-1", template: "NTC_REGX_1024_17I4_SHORT_YEAR_RESET", statement_type: "short_year_reset", sent_on: D("2027-09-18"), due_on: D("2027-11-29"), actor: ESCROW_AGENT });
  assert.equal(bus.events.ofType("escrow.statement.sent")[0]!.payload.statement_type, "short_year_reset");
  assert.equal(effectiveDate(D("2027-10-01"), D("2027-09-18")), "2027-11-01");     // short-year statement 09-18 → $138.33 effective on the first due date ≥ 30 days later
});
test("3.6-T7: Given an advance of $900 on a NH property, then the deficiency plan is ≥ 12 months at 0% and the statement carries the RSA 397-A:9 option text.", () => {
  const nh = buildPlan("deficiency", cents("900"), D("2027-07-01"), { state: "NH", deficiency_installments: 6 }) as Plan;
  assert.equal(nh.months, 12); assert.equal(nh.basis, "nh_0pct"); assert.equal(nh.installment_cents, 7_500n); assert.equal(nh.interest_rate_pct, "0");
  assert.match(nhDeficiencyOffer(cents("900")).option_text, /RSA 397-A:9/);
});
test("3.6-T8: Given a servicer advance and `demandDeficiencyRepayment` called before the interim analysis, then the command is refused with gate `REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE`.", async () => {
  assert.deepEqual(demandDeficiencyGate(false), { ok: false, gate: "REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE" }); assert.deepEqual(demandDeficiencyGate(true), { ok: true });
  // The demand is the deficiency plan the agent creates from the advance; the registry gate (armed by `escrow.advance.posted{cause!=default}`, process 3.2) refuses it on the bus until the interim `escrow.analysis.completed`.
  const bus = escrowBus("L-1", "2027-11-27T15:00:00.000Z", ["3.2", "3.6"]); const demand = { kind: "deficiency", total_cents: 26_000n, start: "2028-01-01", cause: "advance" };
  assert.equal((await bus.refusal("3.6", "createRepaymentPlan", ESCROW_AGENT, demand))?.code, "ANALYSIS_REQUIRED");   // no advance and no analysis: not the (f)(1)(ii) gate — plans follow an approved analysis
  await analyse(bus, "EA-old", { analysis_type: "annual", projected_actual_cents: cents("700") });
  await bus.run("3.7", "postAdvance", ESCROW_AGENT, { amount_cents: 76_000n, advance_cents: 26_000n, cause: "insufficient_funds" });
  const gate = timer(bus, "REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE"); assert.deepEqual([gate.status, gate.note], ["armed", "evaluator:3.6.interimAnalysisBeforeDemand"]);
  const refused = await bus.refusal("3.6", "createRepaymentPlan", ESCROW_AGENT, { ...demand, facts: { analysis_done: true } });   // the caller's `analysis_done` is not evidence: the gate reads the loan's events
  assert.equal(refused?.code, "3.6.interimAnalysisBeforeDemand"); assert.equal(refused?.citation, "REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE"); assert.match(refused!.message, /interim analysis/);
  assert.equal(bus.events.all().filter((e) => e.type === "command.refused").length, 2); assert.equal(bus.rt.store.list("escrow_repayment_plans").length, 0);
  // The analysis completed *before* the advance does not open the gate; the interim analysis after it does (and satisfies the armed row).
  await analyse(bus, "EA-interim", { analysis_type: "interim", as_of: "2027-11-27", projected_actual_cents: -26_000n });
  assert.equal(gate.status, "satisfied");
  const plan = (await bus.run("3.6", "createRepaymentPlan", ESCROW_AGENT, demand)) as Plan;   // after the interim analysis
  assert.deepEqual([plan.kind, plan.months, plan.installment_cents, plan.interest_rate_pct], ["deficiency", 12, 2_167n, "0"]);
  // A default-caused advance does not arm the gate (registry: cause!=default): the demand is not refused by it — it fails only because the analysis carries no deficiency.
  const dflt = escrowBus("L-2", "2027-11-27T15:00:00.000Z", ["3.2", "3.6"]); await analyse(dflt, "EA-d", { projected_actual_cents: cents("700") });
  await dflt.run("3.7", "postAdvance", ESCROW_AGENT, { amount_cents: 76_000n, advance_cents: 26_000n, cause: "default" });
  assert.equal(dflt.ctx.timers.byCode("REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE").length, 0);
  await assert.rejects(dflt.run("3.6", "createRepaymentPlan", ESCROW_AGENT, demand), /carries no deficiency/);
});
test("3.6-T9: Given a second analysis mid-plan with collected $203.34, then the new shortage reflects the actual balance and the old plan is `superseded` without double counting.", () => {
  const proj = project(A, D("2027-07-01")); const first = decide({ projection: proj, projected_actual_cents: 70_000n, as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  const old = supersedePlan({ ...(buildPlan("shortage", 1n, D("2027-01-01"), {}) as Plan), status: "active" }, first, D("2027-07-01"));   // the plan the first analysis created: 12 × $33.89
  assert.equal(old.total_cents, 40_668n);
  for (let n = 1; n <= 6; n++) recordInstallment(old, n); assert.equal(old.collected_cents, 20_334n);
  // Mid-plan the ledger balance already holds the six installments, so the second analysis's gap nets them; the new plan is built from that decision.
  const second = decide({ projection: proj, projected_actual_cents: 70_000n + old.collected_cents, as_of: D("2027-12-16"), regx_days_delinquent: 0 });
  assert.equal(second.kind, "shortage"); if (second.kind === "shortage") assert.equal(second.shortage_cents, 20_334n);
  const next = supersedePlan(old, second, D("2028-01-01"));
  assert.equal(old.status, "superseded"); assert.equal(next.total_cents, 20_334n); assert.equal(old.collected_cents + next.total_cents, 40_668n);   // no double counting
  assert.deepEqual([next.months, next.installment_cents, next.final_installment_cents], [12, 1_695n, 1_689n]);
  assert.throws(() => supersedePlan(next, { kind: "balanced" }, D("2028-07-01")), /does not carry a repayment plan/);
});
test("3.6-T10: Given the annual statement for a ≥-one-month shortage, then the rendered text contains no lump-sum wording (validator check).", () => {
  assert.equal(lumpSumWordingAllowed(40_668n, 13_833n), false);
  const plan = buildPlan("shortage", 40_668n, D("2027-07-01"), {}) as Plan; const vii = planText(plan, 13_833n);
  assert.equal(vii, "$33.89 per month for 12 months beginning 07/01/2027");
  const v = buildRegistry().versionsOf("NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT")[0]!;
  const payload = { ...v.samplePayload, plan_text: vii, shortage_at_least_one_month: true };
  const rendered = render(v.source, payload); assert.doesNotMatch(rendered.text, /lump[- ]sum/i); assert.equal(evaluateChecklist(v, payload, rendered).passed, true);
  const bad = { ...payload, plan_text: `${vii}, or pay the lump sum of $406.68 now` };
  assert.deepEqual(evaluateChecklist(v, bad, render(v.source, bad)).blocking.map((b) => b.rule_id), ["no-lump-sum-text"]);   // the validator blocks the wording
});

// 3.6 worked example (c): a $2,400.00 workout shortage spreads 60 × $40.00.
test("3.6 worked example: $2,400.00 workout shortage → 60 × $40.00", () => {
  const p = buildPlan("shortage", 240_000n, D("2027-07-01"), { workout: true }) as Plan; assert.deepEqual([p.months, p.installment_cents, p.basis], [60, 4_000n, "workout_60"]);
});
