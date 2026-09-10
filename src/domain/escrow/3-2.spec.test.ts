// 3.2 Annual escrow analysis
// spec/sections/03-escrow-administration/3-2-annual-escrow-analysis.md
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
import { multiYearContribution, miLines, chapter13EffectiveDate, nhDeficiencyOffer, reviewStatus, buildHistory } from "./ops.ts";
import { buildPlan } from "./shortage.ts";
import { ingestTrialPlanOfferPrepared, workoutAnalysisBeforeTrialOffer, recordTrialPlanOffered } from "./ops-3-2.ts";
import { escrowBus, ESCROW_AGENT } from "./spec-harness.ts";
import { eventMatches } from "../../kernel/events/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
const AS_OF = D("2027-05-16");
const annual = (projectedActual: bigint, extra: Partial<Parameters<typeof decide>[0]> = {}) => { const p = project(A, D("2027-07-01")); return { p, d: decide({ projection: p, projected_actual_cents: projectedActual, as_of: AS_OF, regx_days_delinquent: 0, ...extra }) }; };
/** The example loan's ledger year (start $1,040.00; 12 × $130.00; actual bills Jul $520, Sep $360, Dec $760, Mar $260 supplemental). */
const LEDGER_YEAR = buildHistory(104_000n, Array.from({ length: 12 }, (_, i) => ({ month: addMonths(D("2026-07-01"), i), deposits_cents: 13_000n, disbursements: i === 0 ? [{ line: "county_tax", amount_cents: 52_000n, projected_cents: 50_000n }] : i === 2 ? [{ line: "school_tax", amount_cents: 36_000n, projected_cents: 36_000n }] : i === 5 ? [{ line: "county_tax", amount_cents: 76_000n, projected_cents: 70_000n }] : i === 8 ? [{ line: "supplemental tax", amount_cents: 26_000n, projected_cents: null }] : [] })));

test("3.2-T1: Given Appendix E lines, when the initial analysis runs, then required start = $780.00, cushion = $260.00, target start = $1,040.00, and the monthly table matches Appendix E Step 3 exactly.", () => {
  const p = project(E, D("2026-07-01"));
  assert.equal(p.required_start_cents, 78_000n); assert.equal(p.cushion_cents, 26_000n); assert.equal(p.target_at_start_cents, 104_000n);
  assert.deepEqual(p.step1.map(Number), [-37000, -24000, -47000, -34000, -21000, -78000, -65000, -52000, -39000, -26000, -13000, 0]);                    // Step 1
  assert.deepEqual(p.targets.map(Number), [67000, 80000, 57000, 70000, 83000, 26000, 39000, 52000, 65000, 78000, 91000, 104000]);                      // Step 3 (Jul … Jun)
});
test("3.2-T2: Given the annual example (county $520/$760, school $380; projected actual $700.00), when run 2027-05-16, then base $138.33, target $1,106.68, shortage $406.68, installment $33.89, new payment $172.22 effective 2027-07-01.", () => {
  const { p, d } = annual(cents("700"));
  assert.equal(p.base_payment_cents, 13_833n); assert.equal(p.required_start_cents, 83_002n); assert.equal(p.cushion_cents, 27_666n); assert.equal(p.target_at_start_cents, 110_668n);
  assert.equal(d.kind, "shortage"); if (d.kind === "shortage") { assert.equal(d.shortage_cents, 40_668n); assert.equal(d.months, 12); assert.equal(d.installment_cents, 3_389n); assert.equal(d.final_installment_cents, 3_389n); assert.equal(d.lump_sum_option_offered, false); }
  assert.equal(newPayment(p, d).payment_cents, 17_222n); assert.equal(effectiveDate(D("2027-07-01"), D("2027-05-20")), "2027-07-01");   // statement sent 05-20 ≥ 30 days before
});
test("3.2-T3: Given projected actual $1,250.00, then surplus $143.32 → refund decision with due 2027-06-15 and payment $138.33.", () => {
  const { p, d } = annual(cents("1250"));
  assert.deepEqual(d, { kind: "refund", surplus_cents: 14_332n, due_on: "2027-06-15" }); assert.equal(newPayment(p, d).payment_cents, 13_833n);
});
test("3.2-T4: Given projected actual $1,080.00, then surplus $26.68 → monthly credit $2.22, first-month extra credit $0.04, payment $136.11.", () => {
  // Spec discrepancy: $1,080.00 is $26.68 *below* the $1,106.68 target, so the engine reports a shortage of $26.68 (kept calendar/arithmetic-correct);
  // the surplus branch the test describes needs a projected actual of $1,133.36.
  const short = annual(cents("1080")).d; assert.equal(short.kind, "shortage"); if (short.kind === "shortage") assert.equal(short.shortage_cents, 2_668n);
  const { p, d } = annual(cents("1133.36"));
  assert.deepEqual(d, { kind: "credit", surplus_cents: 2_668n, credit_monthly_cents: 222n, first_month_extra_cents: 4n });
  assert.equal(newPayment(p, d).payment_cents, 13_611n); assert.equal(newPayment(p, d).first_month_cents, 13_607n);
});
test("3.2-T5: Given projected actual −$150.00, then deficiency $150.00 (12 × $12.50), shortage $1,106.68 (11 × $92.22 + $92.26), payment $243.05, final month $243.09.", () => {
  const { p, d } = annual(-cents("150"));
  assert.equal(d.kind, "shortage"); if (d.kind === "shortage") assert.deepEqual([d.deficiency_cents, d.deficiency_installment_cents, d.shortage_cents, d.installment_cents, d.final_installment_cents], [15_000n, 1_250n, 110_668n, 9_222n, 9_226n]);
  assert.equal(newPayment(p, d).payment_cents, 24_305n); assert.equal(newPayment(p, d).final_month_cents, 24_309n);
});
test("3.2-T6: Given shortage exactly equal to one month's payment ($138.33), then the 30-day lump-sum option is not offered (≥ one month branch).", () => {
  const { p } = annual(0n);
  const exact = decide({ projection: p, projected_actual_cents: p.target_at_start_cents - 13_833n, as_of: AS_OF, regx_days_delinquent: 0 });
  assert.equal(exact.kind, "shortage"); if (exact.kind === "shortage") { assert.equal(exact.shortage_cents, 13_833n); assert.equal(exact.lump_sum_option_offered, false); }
  const small = decide({ projection: p, projected_actual_cents: p.target_at_start_cents - 13_832n, as_of: AS_OF, regx_days_delinquent: 0 });
  if (small.kind === "shortage") assert.equal(small.lump_sum_option_offered, true);                                // one cent under a month → the 30-day option exists
});
test("3.2-T7: Given surplus exactly $50.00 and borrower current, then refund is mandatory (≥ $50).", () => {
  const { p } = annual(0n);
  const d = decide({ projection: p, projected_actual_cents: p.target_at_start_cents + 5_000n, as_of: AS_OF, regx_days_delinquent: 0 });
  assert.deepEqual(d, { kind: "refund", surplus_cents: 5_000n, due_on: "2027-06-15" });
  assert.equal(decide({ projection: p, projected_actual_cents: p.target_at_start_cents + 4_999n, as_of: AS_OF, regx_days_delinquent: 0 }).kind, "credit");
});
test("3.2-T8: Given `regx_days_delinquent = 31` at as_of_date and surplus $300, then decision = retain; given 30, then refund.", () => {
  const { p } = annual(0n);
  assert.deepEqual(decide({ projection: p, projected_actual_cents: p.target_at_start_cents + 30_000n, as_of: AS_OF, regx_days_delinquent: 31 }), { kind: "retain", surplus_cents: 30_000n });
  assert.equal(decide({ projection: p, projected_actual_cents: p.target_at_start_cents + 30_000n, as_of: AS_OF, regx_days_delinquent: 30 }).kind, "refund");
});
test("3.2-T9: Given `instrument_shortage_max_months = 12` and policy 12, then spread = 12; given a workout analysis, then spread = 60 unless a recorded borrower election shortens it (≥ 12).", () => {
  const capped = annual(cents("700"), { instrument_shortage_max_months: 12 }).d; assert.equal(capped.kind, "shortage"); if (capped.kind === "shortage") { assert.equal(capped.months, 12); assert.equal(capped.installment_cents, 3_389n); }
  const w = annual(0n, { regx_days_delinquent: 90, workout: true }).d; if (w.kind === "shortage") assert.equal(w.months, 60);
  const we = annual(0n, { regx_days_delinquent: 90, workout: true, borrower_election_months: 24 }).d; if (we.kind === "shortage") assert.equal(we.months, 24);
  const short = annual(0n, { regx_days_delinquent: 90, workout: true, borrower_election_months: 6 }).d; if (short.kind === "shortage") assert.equal(short.months, 12);   // an election below 12 is floored
  assert.ok("error" in buildPlan("shortage", cents("2400"), D("2027-07-01"), { workout: true, election_months: 6 }));                                    // and the plan builder rejects it outright
});
test("3.2-T10: Given annual $1,660.00, then cushion = $276.66 (floor) and December target ≤ $276.66.", () => {
  const p = project(A, D("2027-07-01"));
  assert.equal(p.annual_cents, 166_000n); assert.equal(p.cushion_cents, 27_666n); assert.equal(cushion(166_000n, {}).cents, 27_666n);   // floor(1,660 × 2 / 12)
  assert.ok(p.targets[5]! <= 27_666n); assert.equal(p.targets[5], 27_666n); assert.equal(p.cap_ok, true);
});
test("3.2-T11: Given a 3-year flood premium of $1,800 due 2028-03-01, then the line contributes $50.00/month and the statement flags the (c)(9) explanation.", () => {
  const flood = { line_type: "flood", amount_cents: cents("1800"), disburse_on: D("2028-03-01"), cycle_years: 3 };
  assert.equal(multiYearContribution(flood.amount_cents, 3), 5_000n);            // $50.00 per month
  const p = project([...A, flood], D("2027-07-01"));
  assert.equal(p.annual_cents, 166_000n + 60_000n); assert.ok(p.items.some((i) => i.cycle_years === 3));   // (c)(9) explanation flagged on the statement
  assert.equal(project([...A, { ...flood, disburse_on: D("2029-03-01") }], D("2027-07-01")).multi_year_low_point_flag, true);
});
test("3.2-T12: Given PMI terminates 2027-11-01, then MI installments after that date are excluded and the payment drops accordingly.", () => {
  const mi = miLines(5_000n, D("2027-07-01"), D("2027-11-01"));
  assert.deepEqual(mi.map((m) => m.disburse_on), ["2027-07-01", "2027-08-01", "2027-09-01", "2027-10-01"]);   // installments on/after 2027-11-01 excluded
  const withMi = project([...A, ...miLines(5_000n, D("2027-07-01"), null)], D("2027-07-01")); const after = project([...A, ...mi], D("2027-07-01"));
  assert.equal(withMi.base_payment_cents, 18_833n); assert.equal(after.base_payment_cents, 15_500n); assert.ok(after.base_payment_cents < withMi.base_payment_cents);
});
test("3.2-T13: Given an open Chapter 13 case, when the analysis is approved 2027-05-20, then `new_payment_effective_date` ≥ 21 days after the 3002.1 notice filing date.", () => {
  assert.equal(chapter13EffectiveDate(D("2027-07-01"), D("2027-05-20")), "2027-07-01");   // ≥ 21 days after the 3002.1 filing (2027-06-10)
  assert.equal(chapter13EffectiveDate(D("2027-07-01"), D("2027-06-15")), "2027-08-01");
});
test("3.2-T14: Given a NH property and a servicer-advanced deficiency, then the statement offers ≥ 12 months at 0% and no lump-sum demand.", () => {
  const o = nhDeficiencyOffer(cents("150"));
  assert.deepEqual([o.months, o.installment_cents, o.interest_rate_pct, o.lump_sum_demand], [12, 1_250n, "0", false]); assert.match(o.option_text, /RSA 397-A:9/); assert.match(o.option_text, /not required to pay it in a lump sum/);
});
test("3.2-T15: Given a payment change of 40%, then status = `anomaly_review` and the agent decision record lists the trigger before approval.", () => {
  const p = project(A, D("2027-07-01")); const d = decide({ projection: p, projected_actual_cents: cents("700"), as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  const t = anomalies(13_000n, 18_200n, d);                                     // +40%
  assert.ok(t.includes("payment_change_gt_25pct"));
  const r = reviewStatus(t); assert.equal(r.status, "anomaly_review"); assert.deepEqual(r.decision_record.triggers, t); assert.equal(r.decision_record.approval_blocked_until_reviewed, true);
});
test("3.2-T16: Given a biweekly loan, then 26 periods, base = round_half_up(annual/26), cushion still ≤ 1/6 of annual.", () => {
  const bw = project(A, D("2027-07-01"), {}, { biweekly: true });
  assert.equal(bw.periods, 26); assert.equal(bw.base_payment_cents, 6_385n);   // round_half_up(166,000 / 26)
  assert.ok(bw.cushion_cents <= bw.annual_cents / 6n); assert.equal(bw.cap_ok, true);
});
test("3.2-T17: Given a leap-year February disbursement dated 02-29, then the projection places it in the February period without error.", () => {
  const p = project([...A, { line_type: "hazard", amount_cents: cents("300"), disburse_on: D("2028-02-29") }], D("2027-07-01"));
  assert.equal(p.items.some((i) => i.disburse_on === "2028-02-29"), true);
  assert.equal(p.step1[7]! - p.step1[6]!, p.base_payment_cents - cents("300"));   // placed in the February period (index 7 from July)
});

// 3.2 worked example figures: Appendix E annual $1,560.00 (school $360.00), the annual analysis school line $380.00, the $1,250.00 and $570.00 variants.
test("3.2 worked example: annual $1,560.00 with school $360.00; school $380.00 next year; projected actual $1,250.00 refunds $143.32; ledger $570.00 + June deposit = $700.00", () => {
  const e = project(E, D("2026-07-01")); assert.equal(e.annual_cents, 156_000n);
  assert.equal(e.step1[2]! - e.step1[1]!, e.base_payment_cents - 36_000n);                                     // the September period absorbs the $360.00 school tax
  const a = project(A, D("2027-07-01")); assert.equal(a.annual_cents, 166_000n);
  assert.equal(a.step1[2]! - a.step1[1]!, a.base_payment_cents - 38_000n);                                     // next year's school line is $380.00
  assert.deepEqual(decide({ projection: a, projected_actual_cents: 125_000n, as_of: D("2027-05-16"), regx_days_delinquent: 0 }), { kind: "refund", surplus_cents: 14_332n, due_on: "2027-06-15" });
  const may = LEDGER_YEAR.find((r) => r.month === "2027-05-01")!; const june = LEDGER_YEAR.find((r) => r.month === "2027-06-01")!;
  assert.equal(may.balance_cents, 57_000n); assert.equal(june.balance_cents, 70_000n);                          // ledger $570.00 on 5/16 + the assumed June deposit = $700.00
  assert.equal(june.balance_cents - may.balance_cents, 13_000n);
  const d = decide({ projection: a, projected_actual_cents: june.balance_cents, as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  assert.equal(d.kind, "shortage"); if (d.kind === "shortage") assert.equal(d.shortage_cents, 40_668n);
});
// 3.2 timer table: the annual-analysis deadline and its −45 lead arm from the analysis that starts the computation year and are satisfied by the next `escrow.analysis.completed`.
test("3.2 timers: REGX_1024_17C3_ANNUAL_ANALYSIS_0 arms on the approval that starts the year (due 2028-06-30) and _LEAD_45 on establishment (due 2028-05-16); the next annual analysis satisfies both", async () => {
  const bus = escrowBus("L-1", "2027-05-18T15:00:00.000Z", ["3.2"]); const timer = (code: string) => bus.ctx.timers.byCode(code);
  await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-0", analysis_type: "initial", items: A, year_start: "2027-07-01", as_of: "2027-05-16", projected_actual_cents: 110_668n });
  assert.equal(timer("REGX_1024_17C3_ANNUAL_ANALYSIS_0").length, 0);                                                                     // completion satisfies; approval arms
  const approved = (await bus.run("3.1", "approveAnalysis", ESCROW_AGENT, { analysis_id: "EA-0" })) as { status: string };
  assert.equal(approved.status, "approved");
  const ev = bus.events.ofType("escrow.analysis.approved")[0]!; assert.deepEqual([ev.payload.starts_computation_year, ev.payload.computation_year_end, ev.payload.next_computation_year_end], [true, "2027-06-30", "2028-06-30"]);
  assert.deepEqual([timer("REGX_1024_17C3_ANNUAL_ANALYSIS_0")[0]!.status, timer("REGX_1024_17C3_ANNUAL_ANALYSIS_0")[0]!.dueDate], ["armed", "2028-06-30"]);
  assert.deepEqual([timer("REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45")[0]!.status, timer("REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45")[0]!.dueDate], ["armed", "2028-05-16"]);   // `escrow.account.established` on the initial approval
  // An interim analysis does not start a year (no new deadline) but does satisfy the (c)(3) deadline; only the annual satisfies (and re-arms) the −45 lead.
  await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-i", analysis_type: "interim", items: A, year_start: "2027-07-01", as_of: "2027-11-27", projected_actual_cents: 70_000n }); await bus.run("3.1", "approveAnalysis", ESCROW_AGENT, { analysis_id: "EA-i" });
  assert.equal(timer("REGX_1024_17C3_ANNUAL_ANALYSIS_0").length, 1); assert.equal(timer("REGX_1024_17C3_ANNUAL_ANALYSIS_0")[0]!.status, "satisfied"); assert.equal(timer("REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45")[0]!.status, "armed");
  // The annual analysis's `escrow.analysis.completed{analysis_type=annual}` is the fact the −45 lead is satisfied by (and, recurring, re-armed from on `next_computation_year_end`); proved against the registry pattern on a timer-less bus.
  const next = escrowBus("L-1", "2028-05-16T15:00:00.000Z"); const lead = loadOverriddenRegistry().get("REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45")!;
  await next.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-1", analysis_type: "annual", items: A, year_start: "2028-07-01", as_of: "2028-05-16", projected_actual_cents: 70_000n });
  const completed = next.events.ofType("escrow.analysis.completed")[0]!; assert.equal(lead.kindNorm, "recurring"); assert.equal(eventMatches(lead.satisfiedPattern!, completed), true); assert.equal(completed.payload.next_computation_year_end, "2029-06-30");
  assert.equal(eventMatches(lead.satisfiedPattern!, bus.events.ofType("escrow.analysis.completed")[1]!), false);   // the interim completion never satisfies the annual lead
  await next.run("3.1", "approveAnalysis", ESCROW_AGENT, { analysis_id: "EA-1" });
  assert.deepEqual([next.events.ofType("escrow.analysis.approved")[0]!.payload.starts_computation_year, next.events.ofType("escrow.analysis.approved")[0]!.payload.next_computation_year_end], [true, "2029-06-30"]);
});
// 3.2 timer table: `lossmit.trial_plan.offer_prepared` → offer date + 0 days; satisfied by the workout `escrow.analysis.completed`; breach blocks the trial offer command (sev-2; D2-3.2-06).
test("3.2 timers: FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL arms on the ingested `lossmit.trial_plan.offer_prepared` (due the offer date), blocks the trial offer until the workout `escrow.analysis.completed`, and only that completion satisfies it", async () => {
  const bus = escrowBus("L-1", "2027-05-18T15:00:00.000Z", ["3.2"]); const timer = () => bus.ctx.timers.byCode("FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL");
  const LOSSMIT: Parameters<typeof ingestTrialPlanOfferPrepared>[2] = { kind: "agent", id: "lossmit-underwriter" };
  assert.throws(() => ingestTrialPlanOfferPrepared(bus.events, { loan_id: "L-1", offer_id: "", program: "flex_modification", offer_date: D("2027-05-25") }, LOSSMIT), RangeError);   // the hand-off is validated
  assert.throws(() => ingestTrialPlanOfferPrepared(bus.events, { loan_id: "L-1", offer_id: "TPP-1", program: "flex_modification", offer_date: "2027-13-01" as never }, LOSSMIT), RangeError);
  const handoff = ingestTrialPlanOfferPrepared(bus.events, { loan_id: "L-1", offer_id: "TPP-1", program: "flex_modification", offer_date: D("2027-05-25"), trial_payment_cents: 145_000n, source: "smdu" }, LOSSMIT);
  assert.deepEqual([handoff.event.type, handoff.event.payload.offer_date, handoff.analysis_due_on, handoff.timer], ["lossmit.trial_plan.offer_prepared", "2027-05-25", "2027-05-25", "FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL"]);
  assert.equal(timer().length, 1); assert.deepEqual([timer()[0]!.status, timer()[0]!.dueDate, timer()[0]!.anchorDate], ["armed", "2027-05-25", "2027-05-25"]);   // anchored on the offer date, 0 calendar days
  assert.throws(() => ingestTrialPlanOfferPrepared(bus.events, { loan_id: "L-1", offer_id: "TPP-1", program: "flex_modification", offer_date: D("2027-05-25") }, LOSSMIT), /already prepared/);   // idempotent hand-off
  // Blocked: no workout analysis since the offer was prepared → the trial offer command is refused (breach action, sev-2).
  const blocked = workoutAnalysisBeforeTrialOffer(bus.events, "L-1", "TPP-1"); assert.equal(blocked.allowed, false); assert.equal(blocked.severity, 2); assert.match(blocked.reason!, /D2-3\.2-06/);
  assert.throws(() => recordTrialPlanOffered(bus.events, { loan_id: "L-1", offer_id: "TPP-1", offered_on: D("2027-05-25") }, LOSSMIT), /blocked/);
  assert.equal(bus.events.ofType("lossmit.trial_plan.offered").length, 0);
  // An annual completion is not the workout analysis: the registry pattern rejects it and the row stays armed.
  await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-annual", analysis_type: "annual", items: A, year_start: "2027-07-01", as_of: "2027-05-16", projected_actual_cents: 70_000n });
  const def = loadOverriddenRegistry().get("FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL")!; const annualDone = bus.events.ofType("escrow.analysis.completed")[0]!;
  assert.equal(eventMatches(def.satisfiedPattern!, annualDone), false); assert.equal(timer()[0]!.status, "armed"); assert.equal(workoutAnalysisBeforeTrialOffer(bus.events, "L-1", "TPP-1").allowed, false);
  // The workout analysis (B-1-01: 60-month spread; regx_days_delinquent 90 → not current) satisfies the row and opens the offer.
  const w = (await bus.run("3.1", "runEscrowAnalysis", ESCROW_AGENT, { analysis_id: "EA-workout", analysis_type: "workout", workout: true, items: A, year_start: "2027-07-01", as_of: "2027-05-20", regx_days_delinquent: 90, projected_actual_cents: 70_000n })) as { decision: { kind: string; months?: number } };
  assert.equal(w.decision.kind, "shortage"); assert.equal(w.decision.months, 60);
  const workoutDone = bus.events.ofType("escrow.analysis.completed")[1]!; assert.equal(workoutDone.payload.analysis_type, "workout"); assert.equal(eventMatches(def.satisfiedPattern!, workoutDone), true);
  assert.deepEqual([timer()[0]!.status, timer()[0]!.satisfiedByEventId], ["satisfied", workoutDone.id]);
  const gate = workoutAnalysisBeforeTrialOffer(bus.events, "L-1", "TPP-1"); assert.equal(gate.allowed, true); assert.equal(gate.analysis!.id, workoutDone.id);
  const offered = recordTrialPlanOffered(bus.events, { loan_id: "L-1", offer_id: "TPP-1", offered_on: D("2027-05-25") }, LOSSMIT);
  assert.deepEqual([offered.event.type, offered.analysis_id, offered.event.payload.offered_on, offered.event.causationId], ["lossmit.trial_plan.offered", "EA-workout", "2027-05-25", workoutDone.id]);
  assert.ok(offered.event.sequence > workoutDone.sequence);                                                                                   // the analysis precedes `lossmit.trial_plan.offered`
  // Breach: the offer date passes with no workout analysis → sev-2 and the offer stays blocked.
  const late = escrowBus("L-2", "2027-05-18T15:00:00.000Z", ["3.2"]); ingestTrialPlanOfferPrepared(late.events, { loan_id: "L-2", offer_id: "TPP-2", program: "payment_deferral", offer_date: D("2027-05-25") }, LOSSMIT);
  const breaches = late.ctx.timers.evaluate("2027-05-26T12:00:00.000Z"); assert.equal(breaches.length, 1); assert.deepEqual([breaches[0]!.instance.code, breaches[0]!.severity], ["FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL", 2]);
  assert.throws(() => recordTrialPlanOffered(late.events, { loan_id: "L-2", offer_id: "TPP-2", offered_on: D("2027-05-26") }, LOSSMIT), /blocked/);
});
