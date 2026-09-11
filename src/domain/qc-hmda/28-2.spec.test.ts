// 28.2 Post-closing QC program, Fannie Mae QC reviews (Loan Quality Connect), self-reporting, defect rates, and remedies/appeals
// spec/sections/28-quality-control-hmda-and-fraud-aml-reporting/28-2-post-closing-qc-program-fannie-mae-qc-reviews-loan-quality-c.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { ratePercent } from "../../kernel/money/cents.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_28_2 } from "../../app/tools/section28-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { runEpdDaily } from "../orig-boarding/ops-30-4.ts";
import { buildCyclePopulation, populationFor, cycleDueOn, cycleReportScheduledOn, selectionDueOn, tenPercentTarget, statisticalSample, chooseRandomMethod, drawRandomSample, stratumOf, selectDiscretionary, selectCycle, selectEpd, computeScope, applyScope, orderReverification, reconcileLiabilities, shadowReunderwrite, recordReunderwrite, incomeVarianceFinding, draftFinding, releaseFinding, evaluateRebuttal, sustainByDefault, closeReview, confirmIneligibleAsDelivered, selfReportDueOn, draftSelfReport, approveSelfReport, submitSelfReport, complianceSelfReportClock, confirmComplianceBreach,
  computeDefectRates, draftCycleReport, issueCycleReport, issueQuarterlyTargetSection, completeCycle, recordVendorReview, vendorReviewGapStatement, vendorReviewRequirement, cycleArrears, startArrearsTracking, draftArrearsNotice, sendArrearsNotice, emitPostClosingScheduleTicks, parseLqcNotification, openFnmaCase, caseDueOn, policySubmitBy, buildLqcPackage, operatorTaskFor, confirmSubmission, draftNopdResponse, resolveResolutionRequest, closeFnmaCase, lqcFileName,
  receiveDemand, draftAppeal, fileAppeal, ingestAppealResponse, declareImpasse, concludeImpasse, fileManagementEscalation, recordManagementEscalationDecision, initiateIdr, payRemedy, remedyLadder, computeRepurchasePrice, computePalAmount, openReliefTracking, trackRelief, confirmReliefFromReport, assessCollateral, assessOccupancy, reviewClosingDocuments, matchDuFinalData, decisionRecord28_2, QcRefusal, DU_DTI_TOLERANCE_PP, DU_MAX_DTI_PCT, TARGET_NET_SEV1_PCT,
  type FundedLoan, type QcReview, type QcCycle, type DiscretionarySignals, type FnmaQcCase, type PackageDocument, type ScopeFacts, type Tradeline } from "./ops-28-2.ts";

const AGENT: Actor = { kind: "agent", id: "qc-audit" };
const QC_OFFICER: Actor = { kind: "human", id: "u-qc-officer", role: "qc_officer" };
const OFFICER: Actor = { kind: "human", id: "u-partner-officer", role: "officer" };
const OPERATOR: Actor = { kind: "human", id: "u-lqc-operator", role: "fnma_portal_operator" };
const ANALYST: Actor = { kind: "human", id: "u-analyst", role: "ops_analyst" };
const LOAN = "L-REFI-1", APP = "APP-REFI-1", FNMA_NO = "1234567890";
/** The refinance fixture: $560,000 LCOR at 6.125 %, note date Fri Nov 6, 2026, disbursed Thu Nov 12, purchased Thu Nov 19, first payment Fri Jan 1, 2027. */
const REFI: FundedLoan = { loan_id: LOAN, application_id: APP, fnma_loan_number: FNMA_NO, disbursement_date: D("2026-11-12"), consummation_date: D("2026-11-06"), purchase_date: D("2026-11-19"), product: "fixed30", transaction: "lcor", occupancy: "primary", channel: "refi_trigger" };
/** The purchase fixture: consummated Wed Nov 18 (wet), funded/disbursed Thu Nov 19. */
const PURCHASE: FundedLoan = { loan_id: "L-PUR-1", application_id: "APP-PUR-1", fnma_loan_number: "1234567891", disbursement_date: D("2026-11-19"), consummation_date: D("2026-11-18"), product: "fixed30", transaction: "purchase", occupancy: "primary", channel: "organic" };
/** Consummated Nov 30, disbursed Dec 3 → December population. */
const DEC_LOAN: FundedLoan = { loan_id: "L-DEC-1", application_id: "APP-DEC-1", fnma_loan_number: null, disbursement_date: D("2026-12-03"), consummation_date: D("2026-11-30"), product: "fixed30", transaction: "purchase", occupancy: "primary", channel: "organic" };
/** The 118-loan November 2026 disbursement population with strata (section README fixtures): both fixtures included. */
function november118(): (FundedLoan & { signals?: DiscretionarySignals })[] {
  const out: (FundedLoan & { signals?: DiscretionarySignals })[] = [REFI, { ...PURCHASE, signals: { prefunding_max_severity: 2 } }];
  const mk = (n: number, transaction: FundedLoan["transaction"], occupancy: FundedLoan["occupancy"], channel: string, extra: Partial<FundedLoan & { signals: DiscretionarySignals }> = {}) => { for (let k = 0; k < n; k++) { const id = `L-${transaction}-${occupancy}-${channel}-${out.length + 1}`; out.push({ loan_id: id, application_id: `APP-${id}`, fnma_loan_number: null, disbursement_date: D(`2026-11-${String(2 + ((out.length * 7) % 27)).padStart(2, "0")}`), consummation_date: null, product: "fixed30", transaction, occupancy, channel, ...extra }); } };
  mk(70, "lcor", "primary", "refi_trigger"); mk(19, "purchase", "primary", "organic"); mk(10, "purchase", "primary", "referral"); mk(7, "cash_out", "primary", "organic"); mk(5, "purchase", "second_home", "organic"); mk(3, "purchase", "investment", "organic");
  mk(1, "cash_out", "primary", "organic", { tx_50a6: true }); mk(1, "purchase", "primary", "organic", { units: 2 });
  out[3]!.signals = { agent_version_stratum: true };
  return out;
}
const REFI_SCOPE: ScopeFacts = { income_source: "du_validated", employment_source: "du_validated", assets_source: "approved_vendor_automated", relief_conditions_met: true, consummation_date: D("2026-11-06"), close_by_date: D("2026-12-07"), tax_returns_relied_upon: false, credit_type: "traditional", cu_score: null, value_acceptance: true, collateral_assessment_completable: true };

/** The 28.2 clocks over the overridden registry (28.2 rows only), in-memory events, a fixed clock, the entity store and the 28.2 tools on the bus. */
function harness(nowIso: string, processes: readonly string[] = ["28.2"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: [...processes] });
  const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: LOAN, applicationId: APP, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_28_2); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("28.2", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (t: string): DomainEvent[] => events.all().filter((e) => e.type === t);
  return { clock, events, timers, uow, rt, run, at, timer, ofType, decisions };
}
const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
const qcRefused = (fn: () => unknown, code: string): void => { try { fn(); } catch (e) { assert.ok(e instanceof QcRefusal, `expected QcRefusal, got ${(e as Error).message}`); assert.equal(e.code, code); return; } assert.fail(`expected QcRefusal ${code}`); };
const noon = (d: string) => `${d}T17:00:00.000Z`;
/** The November 2026 cycle planned on Tue Dec 1 (1st business day) over the 118-loan population. */
function novemberCycle(h: ReturnType<typeof harness>) {
  const loans = november118(); h.at(noon("2026-12-01"));
  const built = buildCyclePopulation(h.events, { partner_id: "P1", production_month: "2026-11", loans, frozen_on: D("2026-12-01") });
  return { loans, ...built };
}
/** Selection Thu Dec 10: 12 random (seed 2026) + the discretionary set. */
function selectNovember(h: ReturnType<typeof harness>) {
  const c = novemberCycle(h); h.at(noon("2026-12-10"));
  const random = drawRandomSample(c.population, c.cycle.random_target, 2026);
  const disc = selectDiscretionary(c.loans, { exclude: new Set(random.selected.map((l) => l.loan_id)), seed: 2026 });
  const sel = selectCycle(h.events, c.cycle, random.selected, disc, { selected_on: D("2026-12-10") });
  return { ...c, random, disc, cycle: sel.cycle, reviews: sel.reviews };
}
/** Twelve random reviews closed for the report: two initial severity-1 findings, one corrected on rebuttal (final 3), one sustained (final 1); the rest no defect. */
function closeTwelve(h: ReturnType<typeof harness>, reviews: QcReview[]): QcReview[] {
  const random = reviews.filter((r) => r.kind === "post_closing_random"); assert.equal(random.length, 12);
  return reviews.map((r, k) => {
    if (r.kind !== "post_closing_random") return closeReview(h.events, r, { completed_on: D("2026-12-17"), outcome: "no_defect" }).review;
    const idx = random.indexOf(r);
    if (idx === 0) return closeReview(h.events, r, { completed_on: D("2027-01-19"), outcome: "defect", initial_severity: 1, final_severity: 3, defect_class: "underwriting_eligibility" }).review;   // cash-out: unsourced $9,000 deposit, corrected
    if (idx === 1) return closeReview(h.events, r, { completed_on: D("2027-01-20"), outcome: "defect", initial_severity: 1, final_severity: 1, defect_class: "underwriting_eligibility" }).review;   // self-employed income miscalculated, sustained
    if (idx === 2) return closeReview(h.events, r, { completed_on: D("2027-01-12"), outcome: "defect", initial_severity: 3, final_severity: 3, defect_class: "compliance" }).review;
    return closeReview(h.events, r, { completed_on: D(`2026-12-${String(14 + (k % 5)).padStart(2, "0")}`), outcome: "no_defect" }).review;
  });
}

test("28.2-T1: Given loans disbursed in November 2026, then `qc_cycles.cycle_due_on = 2027-02-28` and the population includes the refinance (disbursed Nov 12) and the purchase (funded Nov 18/19) fixtures; a loan consummated Nov 30 and disbursed Dec 3 is in the December cycle (due Mar 31, 2027).", () => {
  const h = harness(noon("2026-12-01"));
  // the scheduler's 1st-business-day tick (Tue Dec 1) arms the monthly selection clock on the policy 10th
  const ticks = emitPostClosingScheduleTicks(D("2026-12-01"), h.events); assert.deepEqual(ticks.map((e) => e.payload.job), ["qc_post_closing_select", "qc_post_closing_report"]);
  assert.equal(h.timer("FNMA_D1_3_01_QC_SELECT_MONTHLY")!.dueDate, D("2026-12-10")); assert.equal(h.timer("FNMA_D1_1_03_POST_CLOSING_REPORT_MONTHLY")!.dueDate, D("2026-12-31"));
  const loans = [...november118(), DEC_LOAN];
  const nov = buildCyclePopulation(h.events, { partner_id: "P1", production_month: "2026-11", loans, frozen_on: D("2026-12-01") });
  assert.equal(nov.cycle.cycle_due_on, D("2027-02-28")); assert.equal(nov.cycle.population, 118); assert.equal(nov.cycle.random_method, "ten_percent"); assert.equal(nov.cycle.random_target, 12);
  assert.equal(nov.cycle.period_start, D("2026-11-01")); assert.equal(nov.cycle.period_end, D("2026-11-30")); assert.equal(nov.cycle.status, "planned"); assert.equal(nov.cycle.kind, "monthly");
  const ids = nov.population.map((l) => l.loan_id); assert.ok(ids.includes(LOAN), "refinance disbursed Nov 12"); assert.ok(ids.includes("L-PUR-1"), "purchase funded Nov 18/19"); assert.ok(!ids.includes("L-DEC-1"), "consummated Nov 30, disbursed Dec 3 is not November's");
  // the engine arms the 90-day clock on the month's last day, not the planning date
  const cycle90 = h.timer("FNMA_D1_3_QC_CYCLE_90")!; assert.equal(cycle90.anchorDate, D("2026-11-30")); assert.equal(cycle90.dueDate, D("2027-02-28")); assert.equal(cycle90.status, "armed"); assert.deepEqual(cycle90.subject, { kind: "qc_cycle", id: nov.cycle.cycle_id });
  assert.equal(nov.event.payload.production_month_end, D("2026-11-30")); assert.equal(nov.event.payload.source, "origination");
  // the reporting step is scheduled for Fri Feb 26, 2027 (Sun Feb 28 → prior business day policy)
  assert.equal(nov.cycle.report_scheduled_on, D("2027-02-26")); assert.equal(cycleReportScheduledOn("2026-11"), D("2027-02-26"));
  // December: Dec 3 disbursement → due Wed Mar 31, 2027; October → Fri Jan 29, 2027 (rule 1 worked examples)
  assert.deepEqual(populationFor("2026-12", loans).map((l) => l.loan_id), ["L-DEC-1"]); assert.equal(cycleDueOn("2026-12"), D("2027-03-31")); assert.equal(cycleDueOn("2026-10"), D("2027-01-29"));
  assert.throws(() => buildCyclePopulation(h.events, { partner_id: "P1", production_month: "2026-12", loans, frozen_on: D("2026-12-15") }), /frozen after the month ends/);
  // selection Thu Dec 10 closes the monthly selection clock; the kernel re-arms it on Jan 10, 2027
  h.at(noon("2026-12-10")); const random = drawRandomSample(nov.population, 12, 7); const sel = selectCycle(h.events, nov.cycle, random.selected, [], { selected_on: D("2026-12-10") });
  assert.equal(sel.cycle.status, "selected"); assert.equal(sel.cycle.selected_at, D("2026-12-10")); assert.equal(selectionDueOn("2026-11"), D("2026-12-10"));
  const [first, rearmed] = h.timers.byCode("FNMA_D1_3_01_QC_SELECT_MONTHLY"); assert.equal(first!.status, "satisfied"); assert.equal(rearmed!.dueDate, D("2027-01-10"));
  assert.equal(h.timers.byCode("SM_QC_POST_CLOSING_REVIEW_SLA_45").length, 12); assert.equal(h.timer("SM_QC_POST_CLOSING_REVIEW_SLA_45")!.dueDate, D("2027-01-24"));
});

test("28.2-T2: Given a population of 118, then the `ten_percent` method selects 12 random loans stratified across every product/transaction/occupancy/channel present, and discretionary selections are tagged separately and excluded from the random defect-rate denominator.", () => {
  const h = harness(noon("2026-12-10"));
  const loans = november118(); assert.equal(loans.length, 118); assert.equal(tenPercentTarget(118), 12);
  const draw = drawRandomSample(loans, 12, 2026);
  assert.equal(draw.selected.length, 12); assert.equal(new Set(draw.selected.map((l) => l.loan_id)).size, 12);
  const strata = new Set(loans.map(stratumOf)); assert.equal(strata.size, 6); assert.ok(draw.every_stratum_represented); for (const s of strata) assert.ok((draw.strata[s] ?? 0) >= 1, `stratum ${s} represented`);
  assert.deepEqual(drawRandomSample(loans, 12, 2026).selected.map((l) => l.loan_id), draw.selected.map((l) => l.loan_id), "a recorded seed regenerates the draw");
  // the statistical method (95 % / 2 % / six months) at p = 0.08 over a six-month population of 700 is far larger than 10 % → ten_percent stays (rule 2)
  const stat = statisticalSample({ confidence: 0.95, precision: 0.02, statement_months: 6, expected_defect_rate: 0.08, six_month_population: 700 });
  assert.equal(stat.n0.toFixed(1), "706.9"); assert.equal(stat.n.toFixed(1), "352.0");   // spec rounds n₀ to 706.8 and the FPC result to 351.7; the exact arithmetic gives 706.85 → 351.96 (discrepancy reported)
  assert.deepEqual(chooseRandomMethod({ population: 118, history_months: 6, plan_adopts_statistical: true, params: { confidence: 0.95, precision: 0.02, statement_months: 6, expected_defect_rate: 0.08, six_month_population: 700 } }), { method: "ten_percent", ten_percent: 12, statistical: 352 });
  assert.equal(chooseRandomMethod({ population: 118, history_months: 3, plan_adopts_statistical: true, params: null }).method, "ten_percent");
  // discretionary: signalled loans plus ≥ 2 per high-risk stratum, never a loan already drawn at random, tagged separately
  const disc = selectDiscretionary(loans, { exclude: new Set(draw.selected.map((l) => l.loan_id)), seed: 2026 });
  const byId = new Map(disc.map((d) => [d.loan.loan_id, d.reasons]));
  if (!draw.selected.some((l) => l.loan_id === "L-PUR-1")) assert.deepEqual(byId.get("L-PUR-1"), ["prefunding_finding_sev_le_2"], "the purchase fixture survives prefunding QC (28.1 F2)");
  assert.ok(disc.filter((d) => d.reasons.includes("high_risk_stratum:investment")).length >= 2); assert.ok(disc.filter((d) => d.reasons.includes("high_risk_stratum:cash_out")).length >= 2);
  assert.ok(disc.some((d) => d.reasons.includes("high_risk_stratum:tx_50a6"))); assert.ok(disc.some((d) => d.reasons.includes("high_risk_stratum:2_4_units")));
  assert.ok(disc.every((d) => !draw.selected.some((l) => l.loan_id === d.loan.loan_id)), "no loan is both random and discretionary");
  const c = novemberCycle(h); h.at(noon("2026-12-10")); const sel = selectCycle(h.events, c.cycle, draw.selected, disc, { selected_on: D("2026-12-10") });
  assert.equal(sel.reviews.filter((r) => r.kind === "post_closing_random").length, 12); assert.equal(sel.reviews.filter((r) => r.kind === "post_closing_discretionary").length, disc.length); assert.equal(sel.cycle.discretionary_count, disc.length);
  assert.equal(h.ofType("qc.review.selected").length, 12 + disc.length); assert.ok(h.ofType("qc.review.selected").every((e) => e.applicationId && e.payload.selected_at === "2026-12-10"));
  // the random defect-rate denominator is the 12 random reviews; discretionary severity-1 results are reported separately
  const closed = closeTwelve(h, sel.reviews).map((r) => (r.kind === "post_closing_discretionary" ? { ...r, outcome: "defect" as const, initial_severity: 1, final_severity: 1 } : r));
  const rates = computeDefectRates(closed);
  assert.equal(rates.random_completed, 12); assert.equal(rates.gross_sev1, 2); assert.equal(rates.net_sev1, 1); assert.equal(rates.gross_pct, "16.7"); assert.equal(rates.net_pct, "8.3");
  assert.equal(rates.discretionary_completed, disc.length); assert.equal(rates.discretionary_sev1_final, disc.length); assert.ok(rates.above_target);
  // an EPD (30.4's sm_qc_p1_6_60 flag, first six installments 60+ days past due) is an immediate discretionary review outside the draw; the month-end monitor closes on the selections
  emitPostClosingScheduleTicks(D("2027-03-31"), h.events); assert.equal(h.timer("SM_QC_EPD_MONITOR_MONTHLY")!.dueDate, D("2027-04-30"));
  const epd = runEpdDaily(h.events, { loan_id: LOAN, application_id: APP, as_of: D("2027-03-05"), installments: [{ n: 1, due_date: D("2027-01-01"), paid_on: null }], flags: [] });
  assert.ok(epd.events.some((e) => e.payload.definition === "sm_qc_p1_6_60"));
  const e = selectEpd(h.events, epd.events, loans, { month_end: D("2027-03-31"), selected_on: D("2027-03-31") });
  assert.equal(e.reviews.length, 1); assert.equal(e.reviews[0]!.kind, "epd"); assert.ok(e.reviews[0]!.selection_basis.includes("epd"));
  const [epdFirst, epdRearm] = h.timers.byCode("SM_QC_EPD_MONITOR_MONTHLY"); assert.equal(epdFirst!.status, "satisfied"); assert.equal(epdFirst!.satisfiedByEventId, e.event.id); assert.equal(epdRearm!.dueDate, D("2027-04-30"), "the re-arm runs from the snapshot month-end the selections carry");
});

test("28.2-T3: Given the refinance fixture with DU-validated income/employment closed Nov 6 before the Close by Date Dec 7 and vendor-verified assets, then `review_scope` marks income, employment and assets as exempt, `credit_refresh_required = true`, `occupancy_required = true`, and no transcripts are ordered (no tax returns relied upon).", () => {
  const h = harness(noon("2026-12-10"));
  const scope = computeScope(REFI_SCOPE);
  assert.equal(scope.income_reverify_required, false); assert.equal(scope.employment_reverify_required, false); assert.equal(scope.assets_reverify_required, false);
  assert.equal(scope.credit_refresh_required, true); assert.equal(scope.occupancy_required, true); assert.equal(scope.collateral_assessment_required, true);
  assert.equal(scope.transcripts_required, false); assert.equal(scope.transcripts_reused_from_preclosing, false); assert.equal(scope.close_by_date_met, true); assert.deepEqual(scope.du_validation_components, ["income", "employment"]);
  assert.equal(scope.comps_reverify_required, false, "value acceptance → property eligibility check only"); assert.equal(scope.desk_or_field_review_ordered, false);
  assert.ok(scope.rationale.some((r) => /income: DU-validated.*Close by Date 2026-12-07/.test(r))); assert.ok(scope.rationale.some((r) => /assets: automated verification from an approved Fannie Mae vendor/.test(r))); assert.ok(scope.rationale.some((r) => /no tax returns relied upon/.test(r)));
  // closing after the Close by Date loses the DU-validation exemption; a manual verification is always reverified; tax returns relied upon → 4506-C unless pre-closing transcripts cover the years
  const late = computeScope({ ...REFI_SCOPE, consummation_date: D("2026-12-08") }); assert.equal(late.income_reverify_required, true); assert.equal(late.close_by_date_met, false); assert.deepEqual(late.du_validation_components, []);
  assert.equal(computeScope({ ...REFI_SCOPE, income_source: "manual" }).income_reverify_required, true);
  assert.equal(computeScope({ ...REFI_SCOPE, tax_returns_relied_upon: true, tax_years_required: [2024, 2025], preclosing_transcript_years: [2024, 2025] }).transcripts_reused_from_preclosing, true);
  assert.equal(computeScope({ ...REFI_SCOPE, tax_returns_relied_upon: true, tax_years_required: [2024, 2025], preclosing_transcript_years: [2024] }).transcripts_required, true);
  assert.equal(computeScope({ ...REFI_SCOPE, credit_type: "nontraditional" }).credit_references_reverify_required, true);
  // the scope is written on the review with its rationale; a transcript order against this scope is refused, the soft tri-merge is ordered with the QC purpose code and no trended data
  const c = selectNovember(h); const review = c.reviews.find((r) => r.loan_id === LOAN) ?? { ...c.reviews[0]!, loan_id: LOAN, application_id: APP };
  const applied = applyScope(h.events, review, REFI_SCOPE, noon("2026-12-10"));
  assert.equal(applied.review.status, "in_review"); assert.deepEqual(applied.review.review_scope, scope); assert.equal(applied.event.type, "qc.review.opened"); assert.deepEqual(applied.event.payload.scope_rationale, scope.rationale);
  assert.throws(() => orderReverification(h.events, applied.review, { kind: "transcripts_4506c", source: "IVES", requested_on: D("2026-12-11") }), /transcripts are not ordered/);
  const credit = orderReverification(h.events, applied.review, { kind: "credit_refresh", source: "credit-reseller", requested_on: D("2026-12-11") });
  assert.equal(credit.event.type, "qc.reverification.requested"); assert.equal(credit.event.payload.purpose_code, "qc_post_closing"); assert.equal(credit.event.payload.trended_data, false); assert.equal(credit.reverification.requested_on, D("2026-12-11"));
  assert.equal(h.ofType("qc.reverification.requested").filter((e) => e.payload.kind === "transcripts_4506c").length, 0);
});

test("28.2-T4: Given a self-employed borrower whose transcripts show 2025 net profit $61,200 versus $78,900 used, then a severity-1 finding is released, `reunderwrite_required = true`, the shadow re-underwrite yields DTI 54.1% and `eligible_as_delivered = false`, and after the officer's confirmation on Wed Jan 20, 2027 the self-report is due Fri Feb 19, 2027 and is submitted once via LQC with category/sub-category/defect and documents.", async () => {
  const h = harness(noon("2026-12-10")); const c = selectNovember(h);
  const review: QcReview = { ...c.reviews.find((r) => r.kind === "post_closing_random")!, fnma_loan_number: FNMA_NO };
  // the file used $78,900/yr of self-employment income (plus a co-borrower's W-2 income) against $6,165.00 of monthly debts → DTI 47.9 %; the transcripts show $61,200
  const shadow = shadowReunderwrite({ review_id: review.review_id, income_components: [{ name: "self_employment_2025", monthly_cents: 657_500n, source: "1040 Schedule C" }, { name: "co_borrower_w2", monthly_cents: 629_556n, source: "W-2/paystubs" }], variance: { component: "self_employment_2025", annual_used_cents: 7_890_000n, annual_verified_cents: 6_120_000n }, monthly_debts_cents: 616_500n });
  assert.equal(shadow.dti_before_pct, "47.9"); assert.equal(shadow.dti_after_pct, "54.1"); assert.equal(shadow.eligible_as_delivered, false); assert.equal(shadow.reunderwrite_required, true); assert.equal(shadow.production_touched, false);
  assert.equal(shadow.income_after_cents, 1_139_556n); assert.equal(shadow.variance_pct, "22.4"); assert.match(shadow.du_shadow_casefile, /^qc-shadow:/);
  h.at(noon("2027-01-07")); const ru = recordReunderwrite(h.events, review, shadow, noon("2027-01-07")); assert.equal(ru.review.reunderwrite_required, true); assert.equal(ru.review.eligible_as_delivered, false); assert.equal(ru.event.type, "qc.review.reunderwrite_required");
  // severity-1 finding (Income/Employment → Income Calculation → Income miscalculated), released Fri Jan 8 by the qc_officer → 10-day rebuttal window to Jan 18
  const draft = incomeVarianceFinding(shadow, ["doc-transcript-2025", "doc-income-worksheet"]); assert.equal(draft.severity, 1); assert.equal(draft.defect, "Income miscalculated");
  const f = draftFinding(h.events, ru.review, draft, noon("2027-01-07")); assert.equal(f.finding.status, "drafted");
  qcRefused(() => releaseFinding(h.events, f.finding, { released_on: D("2027-01-08"), actor: AGENT }), "FINDING_SEV_LE_2_NEEDS_QC_OFFICER");
  h.at(noon("2027-01-08")); const rel = releaseFinding(h.events, f.finding, { released_on: D("2027-01-08"), actor: QC_OFFICER });
  assert.equal(rel.finding.status, "released"); assert.equal(rel.finding.rebuttal_due_on, D("2027-01-18")); assert.equal(h.timer("SM_QC_REBUTTAL_WINDOW_10")!.dueDate, D("2027-01-18"));
  const sustained = evaluateRebuttal(h.events, rel.finding, { outcome: "sustained", on: D("2027-01-15") }); assert.equal(sustained.finding.final_severity, 1); assert.equal(h.timer("SM_QC_REBUTTAL_WINDOW_10")!.status, "satisfied");
  // the qc_officer's confirmation Wed Jan 20, 2027 is the D1-1-01 anchor: self-report due Fri Feb 19, 2027
  const loanIds = { fnma_loan_number: FNMA_NO, seller_loan_number: "000155001", borrower_last_name: "Fixture", note_date: D("2026-11-06") };
  qcRefused(() => confirmIneligibleAsDelivered(h.events, ru.review, { confirmed_at: "2027-01-20T16:00:00.000Z", actor: AGENT, sold_to_fnma: true, initial_severity: 1, final_severity: 1, defect_class: "underwriting_eligibility", loan: loanIds }), "INELIGIBLE_CONFIRMATION_NEEDS_QC_OFFICER");
  h.at("2027-01-20T16:00:00.000Z"); const conf = confirmIneligibleAsDelivered(h.events, ru.review, { confirmed_at: "2027-01-20T16:00:00.000Z", actor: QC_OFFICER, sold_to_fnma: true, initial_severity: 1, final_severity: 1, defect_class: "underwriting_eligibility", loan: loanIds });
  assert.equal(conf.review.eligible_as_delivered, false); assert.equal(conf.review.status, "closed"); assert.equal(conf.self_report!.confirmed_on, D("2027-01-20")); assert.equal(conf.self_report!.due_on, D("2027-02-19")); assert.equal(selfReportDueOn(D("2027-01-20")), D("2027-02-19"));
  assert.equal(conf.event.type, "qc.review.closed"); assert.equal(conf.event.payload.confirmed_by_role, "qc_officer"); assert.equal(h.timers.byCode("SM_QC_POST_CLOSING_REVIEW_SLA_45").find((t) => t.loanId === review.loan_id)!.status, "satisfied");
  const sr30 = h.timer("FNMA_D1_1_01_QC_SELF_REPORT_30")!; assert.equal(sr30.anchorDate, D("2027-01-20")); assert.equal(sr30.dueDate, D("2027-02-19")); assert.equal(sr30.status, "armed");
  // a loan never sold to Fannie Mae confirms without a self-report
  const unsold = confirmIneligibleAsDelivered(new MemoryEventStore(h.clock), ru.review, { confirmed_at: "2027-01-20T16:00:00.000Z", actor: QC_OFFICER, sold_to_fnma: false, initial_severity: 1, final_severity: 1, defect_class: "underwriting_eligibility", loan: loanIds }); assert.equal(unsold.self_report, null);
  // the agent drafts the LQC form (type, ids, synopsis, category → sub-category → defect, documents); the partner officer approves Jan 21; the operator submits Fri Jan 22 — once
  const drafted = draftSelfReport(h.events, conf.self_report!, { synopsis: "2025 net profit per IRS transcript $61,200 vs $78,900 used; shadow re-underwrite DTI 54.1%", deficiencies: [{ category: "Income/Employment", sub_category: "Income Calculation", defect: "Income miscalculated" }], documents: ["doc-transcript-2025", "doc-income-worksheet"], at: noon("2027-01-20") });
  assert.equal(drafted.lqc_form.report_type, "Self Report of Lender QC Findings"); assert.equal(drafted.lqc_form.fnma_loan_number, FNMA_NO); assert.equal(drafted.lqc_form.seller_loan_number, "000155001"); assert.deepEqual(drafted.lqc_form.deficiencies, [{ category: "Income/Employment", sub_category: "Income Calculation", defect: "Income miscalculated" }]);
  qcRefused(() => approveSelfReport(h.events, drafted.self_report, { actor: QC_OFFICER, at: noon("2027-01-21") }), "SELF_REPORT_NEEDS_PARTNER_OFFICER");
  const approved = approveSelfReport(h.events, drafted.self_report, { actor: OFFICER, at: noon("2027-01-21") }); assert.equal(approved.self_report.status, "approved");
  qcRefused(() => submitSelfReport(h.events, approved.self_report, { submitted_at: "2027-01-22T15:00:00.000Z", lqc_reference: "SR-2027-0122-01", actor: AGENT }), "LQC_SUBMISSION_IS_OPERATOR_ONLY");
  h.at("2027-01-22T15:00:00.000Z"); const sub = submitSelfReport(h.events, approved.self_report, { submitted_at: "2027-01-22T15:00:00.000Z", lqc_reference: "SR-2027-0122-01", actor: OPERATOR });
  assert.equal(sub.self_report.status, "submitted"); assert.equal(sub.self_report.submission_count, 1); assert.equal(sub.self_report.lqc_reference, "SR-2027-0122-01"); assert.equal(sub.response_case.case_type, "self_report_response");
  assert.equal(h.timer("FNMA_D1_1_01_QC_SELF_REPORT_30")!.status, "satisfied"); assert.equal(sub.event.payload.on_time, true);
  qcRefused(() => submitSelfReport(h.events, sub.self_report, { submitted_at: "2027-01-23T15:00:00.000Z", lqc_reference: "SR-dup", actor: OPERATOR }), "SELF_REPORT_ALREADY_SUBMITTED");
  // the same path on the bus: the shadow re-underwrite never touches the production casefile
  h.rt.store.put("qc_reviews", review.review_id, review as unknown as Record<string, unknown>, AGENT, h.clock.now());
  await refused(h.run("shadowReunderwrite", { review_id: review.review_id, income_components: [], variance: { component: "x", annual_used_cents: "1", annual_verified_cents: "1" }, monthly_debts_cents: "1", resubmit_production_casefile: true }), "AGENT_NEVER_ALTERS_PRODUCTION");
});

test("28.2-T5: Given an LQC file request notified Wed Dec 16, 2026, then `FNMA_D2_1_LQC_RESPONSE_30` is due Fri Jan 15, 2027; the package hash is frozen before the operator escalation; and the timer is satisfied only by an operator-confirmed `submitted_at` with an LQC reference.", async () => {
  const h = harness("2026-12-16T19:05:00.000Z");
  // the Loan Quality Connect e-mail "Loan file requested" arrives Wed Dec 16, 2026 14:05 ET
  const parsed = parseLqcNotification({ subject: "Loan Quality Connect: Loan file requested — task #LQC-88121", body: `Fannie Mae loan number ${FNMA_NO}. Please upload the complete loan file.`, received_at: "2026-12-16T19:05:00.000Z" });
  assert.equal(parsed.case_type, "file_request"); assert.equal(parsed.fnma_loan_number, FNMA_NO); assert.equal(parsed.lqc_task_id, "LQC-88121"); assert.equal(parsed.notified_on, D("2026-12-16"));
  const opened = openFnmaCase(h.events, { loan_id: LOAN, application_id: APP, fnma_loan_number: FNMA_NO, case_type: "file_request", notified_at: parsed.notified_at, lqc_task_id: parsed.lqc_task_id, parent_case_id: null }, []);
  assert.ok(opened.created); assert.equal(opened.case.due_on, D("2027-01-15")); assert.equal(opened.case.policy_submit_by, D("2027-01-13")); assert.equal(caseDueOn("file_request", D("2026-12-16")), D("2027-01-15")); assert.equal(policySubmitBy(D("2027-01-15")), D("2027-01-13"));
  const t = h.timer("FNMA_D2_1_LQC_RESPONSE_30")!; assert.equal(t.anchorDate, D("2026-12-16")); assert.equal(t.dueDate, D("2027-01-15")); assert.equal(t.status, "armed"); assert.equal(t.loanId, LOAN);
  assert.equal(openFnmaCase(h.events, { loan_id: LOAN, application_id: APP, fnma_loan_number: FNMA_NO, case_type: "file_request", notified_at: parsed.notified_at, lqc_task_id: parsed.lqc_task_id, parent_case_id: null }, [opened.case]).created, false, "a duplicate notification links to the existing case");
  // no operator escalation before the hash is frozen
  qcRefused(() => operatorTaskFor(opened.case, D("2026-12-16")), "PACKAGE_HASH_NOT_FROZEN");
  const docs: PackageDocument[] = [{ document_id: "d-note", kind: "note", pages: 6, bytes: 400_000, content_hash: "h1" }, { document_id: "d-1003f", kind: "application_1003_final", pages: 9, bytes: 600_000, content_hash: "h2" }, { document_id: "d-du", kind: "du_final_findings", pages: 12, bytes: 900_000, content_hash: "h3" }, { document_id: "d-dot", kind: "recorded_security_instrument", pages: 18, bytes: 2_000_000, content_hash: "h4" }, { document_id: "d-cd", kind: "le_cd_set", pages: 15, bytes: 1_000_000, content_hash: "h5" }, { document_id: "d-pfqc", kind: "prefunding_qc_record", pages: 3, bytes: 100_000, content_hash: "h6" }];
  h.at("2026-12-17T11:30:00.000Z"); const pkg = buildLqcPackage(h.events, opened.case, docs, "2026-12-17T11:30:00.000Z");
  assert.equal(pkg.package.file_name, lqcFileName(FNMA_NO)); assert.equal(pkg.package.file_name, "1234567890_LoanFile.pdf"); assert.deepEqual(pkg.package.order, ["application_1003_final", "du_final_findings", "le_cd_set", "note", "recorded_security_instrument", "prefunding_qc_record"]);
  assert.equal(pkg.case.status, "package_ready"); assert.equal(pkg.case.package_hash, pkg.package.hash); assert.equal(pkg.event.type, "fnma.qc.package.ready"); assert.equal(pkg.event.payload.frozen_at, "2026-12-17T11:30:00.000Z");
  assert.throws(() => buildLqcPackage(h.events, opened.case, [{ document_id: "big", kind: "note", pages: 3_001, bytes: 1, content_hash: "x" }], "2026-12-17T11:30:00.000Z"), /3000 pages/);
  const task = operatorTaskFor(pkg.case, D("2026-12-17")); assert.equal(task.package_hash, pkg.package.hash); assert.equal(task.sla_business_days, 2); assert.equal(task.sla_due_on, D("2026-12-21")); assert.equal(task.owner_role, "fnma_portal_operator"); assert.equal(task.deadline, D("2027-01-15"));
  assert.equal(operatorTaskFor(pkg.case, D("2027-01-11")).sla_business_days, 1, "1 business day when the Fannie Mae deadline is within 5 days");
  assert.ok(pkg.event.sequence > opened.event!.sequence); assert.equal(h.ofType("fnma.qc.package.ready").length, 1);
  // the escalation on the bus is refused until the package hash is frozen, then opens the operator's portal task
  h.rt.store.put("fnma_qc_cases", opened.case.case_id, opened.case as unknown as Record<string, unknown>, AGENT, h.clock.now());
  await assert.rejects(h.run("openOperatorEscalation", { case_id: opened.case.case_id, today: "2026-12-16" }), (e: Error) => e instanceof QcRefusal && e.code === "PACKAGE_HASH_NOT_FROZEN");
  h.rt.store.put("fnma_qc_cases", pkg.case.case_id, pkg.case as unknown as Record<string, unknown>, AGENT, h.clock.now());
  const esc = await h.run("openOperatorEscalation", { case_id: pkg.case.case_id, today: "2026-12-17" }); assert.equal(esc.owner_role, "fnma_portal_operator"); assert.equal(h.rt.escalations.opened.at(-1)!.kind, "human_portal_task"); assert.equal((h.rt.escalations.opened.at(-1)!.payload as { package_hash: string }).package_hash, pkg.package.hash);
  // only the operator's confirmed upload with an LQC reference satisfies the timer (uploaded Fri Dec 18 10:20 ET)
  qcRefused(() => confirmSubmission(h.events, pkg.case, { submitted_at: "2026-12-18T15:20:00.000Z", lqc_reference: "LQC-UP-5521", actor: AGENT }), "LQC_SUBMISSION_IS_OPERATOR_ONLY");
  qcRefused(() => confirmSubmission(h.events, pkg.case, { submitted_at: "2026-12-18T15:20:00.000Z", lqc_reference: "LQC-UP-5521", actor: OFFICER }), "LQC_SUBMISSION_IS_OPERATOR_ONLY");
  assert.throws(() => confirmSubmission(h.events, pkg.case, { submitted_at: "2026-12-18T15:20:00.000Z", lqc_reference: "", actor: OPERATOR }), /lqc_reference is required/);
  assert.equal(h.timer("FNMA_D2_1_LQC_RESPONSE_30")!.status, "armed");
  await refused(h.run("buildLqcPackage", { case_id: pkg.case.case_id, op: "confirm_submission", submitted_at: "2026-12-18T15:20:00.000Z", lqc_reference: "LQC-UP-5521" }), "LQC_SUBMISSION_IS_OPERATOR_ONLY");
  h.at("2026-12-18T15:20:00.000Z"); const sub = await h.run("buildLqcPackage", { case_id: pkg.case.case_id, op: "confirm_submission", submitted_at: "2026-12-18T15:20:00.000Z", lqc_reference: "LQC-UP-5521" }, OPERATOR);
  assert.equal(sub.status, "submitted"); assert.equal(sub.submitted_at, "2026-12-18T15:20:00.000Z"); assert.equal(sub.lqc_reference, "LQC-UP-5521");
  const done = h.timer("FNMA_D2_1_LQC_RESPONSE_30")!; assert.equal(done.status, "satisfied"); assert.equal(done.satisfiedByEventId, h.ofType("fnma.qc.package.submitted").at(-1)!.id); assert.equal(h.ofType("fnma.qc.package.submitted").at(-1)!.payload.submitted_by_role, "fnma_portal_operator");
  // worked example 2 continues: NOPD Fri Jan 29, 2027 (due Sun Feb 28 → policy Fri Feb 26), documents uploaded Tue Feb 2, closed no_defect Feb 11
  h.at("2027-01-29T20:00:00.000Z"); const nopd = openFnmaCase(h.events, { loan_id: LOAN, application_id: APP, fnma_loan_number: FNMA_NO, case_type: "nopd", notified_at: "2027-01-29T20:00:00.000Z", lqc_task_id: "LQC-NOPD-7", parent_case_id: pkg.case.case_id }, [pkg.case]).case;
  assert.equal(nopd.due_on, D("2027-02-28")); assert.equal(nopd.policy_submit_by, D("2027-02-26")); assert.equal(h.timer("FNMA_D2_1_NOPD_DOC_UPLOAD_30")!.dueDate, D("2027-02-28"));
  const resp = draftNopdResponse(nopd, { defect_text: "Missing evidence that the payoff of the prior lien was disbursed", evidence: [{ document_id: "wire-26-3", source: "26.3 fundings.wire_id", kind: "wire confirmation" }, { document_id: "ledger-24-4", source: "24.4 settlement agent", kind: "disbursement ledger" }] });
  assert.equal(resp.upload_by, D("2027-02-26")); assert.match(resp.response, /wire confirmation/);
  h.at("2027-02-02T16:00:00.000Z"); const nopdPkg = buildLqcPackage(h.events, nopd, [{ document_id: "wire-26-3", kind: "closing_instructions", pages: 2, bytes: 1000, content_hash: "w" }], "2027-02-02T15:00:00.000Z");
  confirmSubmission(h.events, nopdPkg.case, { submitted_at: "2027-02-02T16:00:00.000Z", lqc_reference: "LQC-UP-5600", actor: OPERATOR }); assert.equal(h.timer("FNMA_D2_1_NOPD_DOC_UPLOAD_30")!.status, "satisfied");
  const closed = closeFnmaCase(h.events, nopdPkg.case, { outcome: "no_defect", on: D("2027-02-11") }); assert.equal(closed.case.status, "closed"); assert.equal(closed.case.outcome, "no_defect");
  // the counterfactual Resolution Request Mon Mar 1, 2027 → 60 days → Fri Apr 30
  h.at("2027-03-01T15:00:00.000Z"); const rr = openFnmaCase(h.events, { loan_id: LOAN, application_id: APP, fnma_loan_number: FNMA_NO, case_type: "resolution_request", notified_at: "2027-03-01T15:00:00.000Z", lqc_task_id: "LQC-RR-1", parent_case_id: nopd.case_id }, []).case;
  assert.equal(rr.due_on, D("2027-04-30")); assert.equal(h.timer("FNMA_D2_1_RESOLUTION_REQUEST_60")!.dueDate, D("2027-04-30"));
  qcRefused(() => resolveResolutionRequest(h.events, rr, { resolution: "alternative_remedy_agreed", on: D("2027-04-01"), actor: AGENT }), "REMEDY_DECISION_NEEDS_PARTNER_OFFICER");
  resolveResolutionRequest(h.events, rr, { resolution: "correction_accepted", on: D("2027-04-01"), actor: AGENT }); assert.equal(h.timer("FNMA_D2_1_RESOLUTION_REQUEST_60")!.status, "satisfied");
});

test("28.2-T6: Given a repurchase demand received Mon May 3, 2027, then `FNMA_A2_3_2_01_REMEDY_PAYMENT_60` and `FNMA_A2_3_2_03_APPEAL1_60` are both due Fri Jul 2, 2027; filing appeal 1 on Thu Jun 10 suspends the payment timer; a denial received Mon Aug 9 makes appeal 2 due Tue Aug 24, 2027 and the console refuses an appeal-2 draft without a \"new information\" attachment.", async () => {
  const h = harness("2027-05-03T14:00:00.000Z");
  const demandCase = openFnmaCase(h.events, { loan_id: LOAN, application_id: APP, fnma_loan_number: FNMA_NO, case_type: "demand_repurchase", notified_at: "2027-05-03T14:00:00.000Z", lqc_task_id: "LQC-DEM-1", parent_case_id: null }, []).case;
  const dem = receiveDemand(h.events, demandCase, { demand_received_on: D("2027-05-03"), amount_cents: null });
  assert.equal(dem.ledger.payment_due_on, D("2027-07-02")); assert.equal(dem.ledger.appeal_1_due_on, D("2027-07-02")); assert.equal(dem.ledger.remedy_type, "repurchase"); assert.equal(dem.ledger.payment_timer, "running");
  const pay = h.timer("FNMA_A2_3_2_01_REMEDY_PAYMENT_60")!, ap1 = h.timer("FNMA_A2_3_2_03_APPEAL1_60")!;
  assert.equal(pay.dueDate, D("2027-07-02")); assert.equal(ap1.dueDate, D("2027-07-02")); assert.equal(pay.anchorDate, D("2027-05-03")); assert.equal(pay.armedByEventId, dem.event.id);
  // the partner officer authorizes appeal 1, filed Thu Jun 10 with the settlement ledger and title policy → the payment clock is suspended, Fannie Mae's response expected by Mon Aug 9
  const attachments = [{ document_id: "ledger-24-4", kind: "settlement ledger" }, { document_id: "title-policy", kind: "title policy" }];
  qcRefused(() => fileAppeal(h.events, dem.ledger, { stage: "appeal_1", filed_on: D("2027-06-10"), attachments, grounds: "the prior lien payoff was disbursed per the settlement ledger", actor: AGENT }, h.timers), "APPEAL_NEEDS_PARTNER_OFFICER");
  h.at(noon("2027-06-10")); const a1 = fileAppeal(h.events, dem.ledger, { stage: "appeal_1", filed_on: D("2027-06-10"), attachments, grounds: "the prior lien payoff was disbursed per the settlement ledger", actor: OFFICER }, h.timers);
  assert.equal(a1.ledger.payment_timer, "suspended"); assert.equal(a1.ledger.appeal_status, "appeal_1_filed"); assert.equal(a1.suspended_timer_id, pay.id); assert.equal(pay.status, "cancelled"); assert.match(pay.cancelledReason ?? "", /suspended: appeal 1 filed 2027-06-10/);
  assert.equal(ap1.status, "satisfied"); assert.equal(h.timer("FNMA_A2_3_2_03_FNMA_RESPONSE_60")!.dueDate, D("2027-08-09")); assert.equal(a1.ledger.appeals[0]!.response_expected_by, D("2027-08-09"));
  // Fannie Mae denies Mon Aug 9 → appeal 2 due Tue Aug 24, only with new information
  h.at(noon("2027-08-09")); const d1 = ingestAppealResponse(h.events, a1.ledger, { stage: "appeal_1", outcome: "denied", notified_on: D("2027-08-09") });
  assert.deepEqual(d1.next, { step: "appeal_2 (new information only)", due_on: D("2027-08-24") }); assert.equal(h.timer("FNMA_A2_3_2_03_FNMA_RESPONSE_60")!.status, "satisfied");
  const ap2 = h.timer("FNMA_A2_3_2_03_APPEAL2_15")!; assert.equal(ap2.anchorDate, D("2027-08-09")); assert.equal(ap2.dueDate, D("2027-08-24"));
  qcRefused(() => draftAppeal(d1.ledger, { stage: "appeal_2", grounds: "same grounds", attachments }), "APPEAL2_NEW_INFORMATION_REQUIRED");
  h.rt.store.put("remedy_ledger", d1.ledger.remedy_id, d1.ledger as unknown as Record<string, unknown>, AGENT, h.clock.now());
  await refused(h.run("draftAppeal", { remedy_id: d1.ledger.remedy_id, op: "draft", stage: "appeal_2", grounds: "same grounds", attachments }), "APPEAL2_NEW_INFORMATION_REQUIRED");
  const newInfo = [...attachments, { document_id: "recorded-reconveyance", kind: "recorded reconveyance of the prior lien", new_information: true }];
  const draft2 = await h.run("draftAppeal", { remedy_id: d1.ledger.remedy_id, op: "draft", stage: "appeal_2", grounds: "recorded reconveyance obtained", attachments: newInfo });
  assert.equal(draft2.new_information, true); assert.equal(draft2.file_by, D("2027-08-24")); assert.match(draft2.brief as string, /with new information/);
  h.at(noon("2027-08-20")); const a2 = fileAppeal(h.events, d1.ledger, { stage: "appeal_2", filed_on: D("2027-08-20"), attachments: newInfo, grounds: "recorded reconveyance obtained", actor: OFFICER }, h.timers);
  assert.equal(ap2.status, "satisfied"); assert.equal(a2.ledger.appeals.length, 2); assert.equal(h.timers.byCode("FNMA_A2_3_2_03_FNMA_RESPONSE_60").at(-1)!.dueDate, D("2027-10-19"));
  assert.throws(() => draftAppeal(a2.ledger, { stage: "appeal_2", grounds: "third", attachments: newInfo }), /appeal 2 follows a denied first appeal|maximum of two appeals/);
  // the rest of the A2-3.2-03 ladder: denial → impasse (15) → 30-day resolution window → management escalation (15) → Fannie Mae review (30) → IDR (15)
  h.at(noon("2027-09-01")); const d2 = ingestAppealResponse(h.events, a2.ledger, { stage: "appeal_2", outcome: "denied", notified_on: D("2027-09-01") }); assert.equal(h.timer("FNMA_A2_3_2_03_IMPASSE_15")!.dueDate, D("2027-09-16"));
  h.at(noon("2027-09-10")); const imp = declareImpasse(h.events, d2.ledger, { declared_on: D("2027-09-10"), actor: OFFICER }); assert.equal(h.timer("FNMA_A2_3_2_03_IMPASSE_15")!.status, "satisfied"); assert.equal(h.timer("FNMA_A2_3_2_03_IMPASSE_RESOLVE_30")!.dueDate, D("2027-10-10")); assert.equal(imp.ledger.impasse_resolve_by, D("2027-10-10"));
  h.at(noon("2027-10-10")); const exp = concludeImpasse(h.events, imp.ledger, { outcome: "expired", concluded_on: D("2027-10-10") }); assert.equal(h.timer("FNMA_A2_3_2_03_IMPASSE_RESOLVE_30")!.status, "satisfied"); assert.equal(h.timer("FNMA_A2_3_2_03_MGMT_ESCALATION_15")!.dueDate, D("2027-10-25"));
  h.at(noon("2027-10-20")); const me = fileManagementEscalation(h.events, exp.ledger, { filed_on: D("2027-10-20"), actor: OFFICER }); assert.equal(h.timer("FNMA_A2_3_2_03_MGMT_ESCALATION_15")!.status, "satisfied"); assert.equal(me.event.payload.fnma_review_by, D("2027-11-19"));
  h.at(noon("2027-11-15")); const md = recordManagementEscalationDecision(h.events, me.ledger, { notified_on: D("2027-11-15"), outcome: "upheld" }); assert.equal(h.timer("FNMA_A2_3_2_03_IDR_15")!.dueDate, D("2027-11-30"));
  h.at(noon("2027-11-25")); initiateIdr(h.events, md.ledger, { initiated_on: D("2027-11-25"), actor: OFFICER }); assert.equal(h.timer("FNMA_A2_3_2_03_IDR_15")!.status, "satisfied");
  // rule 9 worked example: demand Mar 15 → May 14 / Jun 15 (filed Apr 16) / Jun 30 / Aug 31 (denied Aug 16) / Sep 30 / Oct 15
  const ladder = remedyLadder(D("2027-03-15"), { appeal_1_filed_on: D("2027-04-16"), appeal_1_denied_on: D("2027-06-15"), appeal_2_denied_on: D("2027-08-16"), impasse_declared_on: D("2027-08-31"), management_escalation_filed_on: D("2027-10-15") });
  assert.equal(ladder.payment_due_on, D("2027-05-14")); assert.equal(ladder.appeal_1_due_on, D("2027-05-14")); assert.equal(ladder.fnma_response_1_by, D("2027-06-15")); assert.equal(ladder.appeal_2_due_on, D("2027-06-30")); assert.equal(ladder.impasse_declare_by, D("2027-08-31")); assert.equal(ladder.impasse_resolve_by, D("2027-09-30")); assert.equal(ladder.management_escalation_by, D("2027-10-15")); assert.equal(ladder.fnma_management_review_by, D("2027-11-14"));
  // a +15 landing on Christmas is filed Thu Dec 24 (policy: never the next business day)
  assert.equal(policySubmitBy(D("2026-12-25")), D("2026-12-23")); assert.ok(policySubmitBy(D("2026-12-25")) < D("2026-12-25"));
});

test("28.2-T7: Given the November 2026 cycle is not `reported` by Sun Feb 28, 2027, then `FNMA_D1_3_QC_CYCLE_90` breaches at sev 1; if still not reported by Tue Mar 30, 2027 (+30), then `FNMA_D1_3_01_QC_ARREARS_NOTICE` requires the officer's written notice to the QC Specialist and the agent has a draft ready.", () => {
  const h = harness(noon("2026-12-01")); const c = selectNovember(h);
  assert.equal(h.timers.evaluate("2027-02-28T22:00:00.000Z").filter((b) => b.instance.code === "FNMA_D1_3_QC_CYCLE_90").length, 0, "still inside Feb 28");
  const breaches = h.timers.evaluate("2027-03-01T05:00:00.000Z").filter((b) => b.instance.code === "FNMA_D1_3_QC_CYCLE_90");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.severity, 1); assert.deepEqual(breaches[0]!.escalateTo, ["qc_officer", "officer"]); assert.equal(h.timer("FNMA_D1_3_QC_CYCLE_90")!.status, "breached");
  const breachEvent = h.ofType("timer.breached").find((e) => e.payload.code === "FNMA_D1_3_QC_CYCLE_90")!;
  assert.deepEqual(cycleArrears(c.cycle, D("2027-03-01")), { overdue: true, days_overdue: 1, more_than_one_cycle: false, arrears_notice_due_on: D("2027-03-30"), status: "selected" });
  // arrears tracking starts from the breach; the written-notice clock runs +30 from cycle_due_on → Tue Mar 30, 2027
  const arr = startArrearsTracking(h.events, c.cycle, breachEvent, "2027-03-01T05:00:00.000Z");
  assert.equal(arr.cycle.status, "in_arrears"); assert.equal(arr.event.causationId, breachEvent.id); assert.equal(arr.event.payload.arrears_notice_due_on, D("2027-03-30"));
  const notice = h.timer("FNMA_D1_3_01_QC_ARREARS_NOTICE")!; assert.equal(notice.anchorDate, D("2027-02-28")); assert.equal(notice.dueDate, D("2027-03-30")); assert.deepEqual(notice.subject, { kind: "qc_cycle", id: c.cycle.cycle_id });
  assert.throws(() => startArrearsTracking(h.events, c.cycle, { id: "x", type: "timer.breached", payload: { code: "SM_QC_REBUTTAL_WINDOW_10" } }, "2027-03-01T05:00:00.000Z"), /90-day cycle breach/);
  // Tue Mar 30: more than one 30-day cycle behind → the agent's draft is ready for the partner officer to send the same day
  const a30 = cycleArrears(arr.cycle, D("2027-03-31")); assert.equal(a30.more_than_one_cycle, true); assert.equal(a30.status, "in_arrears");
  const draft = draftArrearsNotice({ cycles: [arr.cycle], recovery_plan: "December and January cycles reviewed in parallel; November report by Apr 9; QC staffing doubled", partner_name: "Partner Bank", recipient: "Fannie Mae QC Specialist (customer account team)", drafted_on: D("2027-03-30") });
  assert.equal(draft.ready, true); assert.deepEqual(draft.cycles_affected, ["2026-11"]); assert.match(draft.text, /D1-3-01/); assert.match(draft.text, /Cycles affected: 2026-11 \(due 2027-02-28, status in_arrears\)/); assert.match(draft.text, /Recovery plan:/);
  qcRefused(() => sendArrearsNotice(h.events, arr.cycle, { sent_on: D("2027-03-30"), actor: AGENT, notice_text: draft.text, recipient: draft.recipient }), "ARREARS_NOTICE_SENT_BY_PARTNER_OFFICER");
  qcRefused(() => sendArrearsNotice(h.events, arr.cycle, { sent_on: D("2027-03-30"), actor: QC_OFFICER, notice_text: draft.text, recipient: draft.recipient }), "ARREARS_NOTICE_SENT_BY_PARTNER_OFFICER");
  h.at(noon("2027-03-30")); const sent = sendArrearsNotice(h.events, arr.cycle, { sent_on: D("2027-03-30"), actor: OFFICER, notice_text: draft.text, recipient: draft.recipient });
  assert.equal(sent.cycle.arrears_notice_sent_at, D("2027-03-30")); assert.equal(sent.event.payload.sent_by_role, "officer"); assert.equal(notice.status, "satisfied");
  // without the notice the arrears row breaches sev 1 on Mar 31
  const h2 = harness(noon("2026-12-01")); const c2 = selectNovember(h2); h2.timers.evaluate("2027-03-01T05:00:00.000Z"); startArrearsTracking(h2.events, c2.cycle, h2.ofType("timer.breached")[0]!, "2027-03-01T05:00:00.000Z");
  const late = h2.timers.evaluate("2027-03-31T05:00:00.000Z").filter((b) => b.instance.code === "FNMA_D1_3_01_QC_ARREARS_NOTICE"); assert.equal(late.length, 1); assert.equal(late[0]!.severity, 1);
});

test("28.2-T8: Given 12 random reviews with 2 initial severity-1 findings and 1 corrected, then the report shows gross 16.7%, net 8.3%, a three-month trend, the quarterly comparison to the 3% target, the compliance-vs-underwriting split, the sample description (12 of 118 random = 10.2%) and a corrective-action plan.", () => {
  const h = harness(noon("2026-12-01")); const c = selectNovember(h);
  const reviews = closeTwelve(h, c.reviews);
  const prior = [{ production_month: "2026-09", gross_pct: "0.0", net_pct: "0.0" }, { production_month: "2026-10", gross_pct: "9.1", net_pct: "0.0" }];
  assert.throws(() => draftCycleReport({ cycle: c.cycle, reviews, prior_months: [], vendor_review: null, today: D("2027-02-25") }), /three months/);
  const report = draftCycleReport({ cycle: c.cycle, reviews, prior_months: prior, vendor_review: null, today: D("2027-02-25"), corrective_actions: [{ action: "Income Calculator use mandated for all self-employed files", owner: "22.3 income verification", due_on: D("2027-03-31"), process_ref: "22.3 change" }] });
  assert.equal(report.defect_rates.gross_pct, "16.7"); assert.equal(report.defect_rates.net_pct, "8.3"); assert.equal(report.defect_rates.random_completed, 12); assert.equal(report.defect_rates.target_pct, TARGET_NET_SEV1_PCT);
  assert.deepEqual(report.three_month_trend.map((t) => t.production_month), ["2026-09", "2026-10", "2026-11"]); assert.deepEqual(report.three_month_trend[2], { production_month: "2026-11", gross_pct: "16.7", net_pct: "8.3" });
  assert.deepEqual(report.quarterly_target_comparison, { highest_severity_rate_pct: "8.3", target_pct: "3.0", above_target: true, quarter_months: ["2026-09", "2026-10", "2026-11"] });
  assert.deepEqual(report.compliance_vs_underwriting, { compliance: 1, underwriting_eligibility: 2 });
  assert.equal(report.sample_description.random_selected, 12); assert.equal(report.sample_description.population, 118); assert.equal(report.sample_description.random_pct, "10.2"); assert.equal(report.sample_description.method, "ten_percent"); assert.equal(report.sample_description.discretionary_selected, c.disc.length);
  assert.equal(report.discretionary_results.reported_separately, true); assert.equal(report.discretionary_results.reviews, c.disc.length);
  assert.equal(report.corrective_action_plan.required, true); assert.equal(report.corrective_action_plan.actions[0]!.action, "Income Calculator use mandated for all self-employed files");
  assert.match(report.text, /Gross severity-1 defect rate 16\.7% \(2\/12\); net 8\.3% \(1\/12\)/); assert.match(report.text, /Random sample: 12 of 118 loans \(10\.2%\)/); assert.match(report.text, /ABOVE TARGET/); assert.match(report.text, /Three-month trend: 2026-09 .* 2026-10 .* 2026-11/);
  // within target → no corrective-action plan
  const calm = draftCycleReport({ cycle: c.cycle, reviews: reviews.map((r) => ({ ...r, initial_severity: r.initial_severity === 1 ? 3 : r.initial_severity, final_severity: r.final_severity === 1 ? 3 : r.final_severity })), prior_months: prior, vendor_review: null, today: D("2027-02-25") });
  assert.equal(calm.defect_rates.net_pct, "0.0"); assert.equal(calm.corrective_action_plan.required, false); assert.equal(calm.corrective_action_plan.actions.length, 0);
  // the monthly report row (Feb 1 tick, due Feb 28) closes on the qc_officer's signature Thu Feb 25; management acknowledgement Feb 26 completes the cycle before Sun Feb 28
  emitPostClosingScheduleTicks(D("2027-02-01"), h.events); assert.equal(h.timer("FNMA_D1_1_03_POST_CLOSING_REPORT_MONTHLY")!.dueDate, D("2027-02-28"));
  qcRefused(() => issueCycleReport(h.events, c.cycle, report, { issued_on: D("2027-02-25"), actor: AGENT }), "REPORT_SIGNATURE_NEEDS_QC_OFFICER");
  assert.throws(() => completeCycle(h.events, c.cycle, reviews, { completed_on: D("2027-02-26"), management_ack_on: D("2027-02-26") }), /signed monthly report is the final step/);
  h.at(noon("2027-02-25")); const issued = issueCycleReport(h.events, c.cycle, report, { issued_on: D("2027-02-25"), actor: QC_OFFICER });
  assert.equal(issued.cycle.status, "reported"); assert.equal(issued.cycle.report_issued_at, D("2027-02-25")); assert.equal(issued.event.payload.signed_by_role, "qc_officer"); assert.equal(issued.event.payload.kind, "post_closing_monthly");
  const [monthly, rearmed] = h.timers.byCode("FNMA_D1_1_03_POST_CLOSING_REPORT_MONTHLY"); assert.equal(monthly!.status, "satisfied"); assert.equal(rearmed!.dueDate, D("2027-03-31"));
  h.at(noon("2027-02-26")); const done = completeCycle(h.events, issued.cycle, reviews, { completed_on: D("2027-02-26"), management_ack_on: D("2027-02-26") });
  assert.equal(done.on_time, true); assert.equal(h.timer("FNMA_D1_3_QC_CYCLE_90")!.status, "satisfied"); assert.equal(h.timer("FNMA_D1_3_QC_CYCLE_90")!.satisfiedByEventId, done.event.id);
  // the quarterly target-rate section: Dec 31 tick → due Jan 30, 2027; issued by the qc_officer
  emitPostClosingScheduleTicks(D("2026-12-31"), h.events); assert.equal(h.timer("FNMA_D1_1_03_TARGET_RATE_QUARTERLY")!.dueDate, D("2027-01-30"));
  const q = issueQuarterlyTargetSection(h.events, { quarter_end: D("2026-12-31"), highest_severity_rate_pct: "8.3", target_pct: "3.0", issued_on: D("2027-01-20"), actor: QC_OFFICER });
  assert.equal(q.payload.above_target, true); const [qFirst, qRearm] = h.timers.byCode("FNMA_D1_1_03_TARGET_RATE_QUARTERLY"); assert.equal(qFirst!.status, "satisfied"); assert.equal(qFirst!.satisfiedByEventId, q.id); assert.equal(qRearm!.dueDate, D("2027-04-30"), "the re-arm runs from the next quarter-end the section carries");
});

test("28.2-T9: Given the partner performs no 10% re-review within 15 days of `qc.cycle.completed`, then `FNMA_D1_1_02_VENDOR_REVIEW_10PCT_MONTHLY` breaches at sev 1 to the partner `officer` and the monthly report states the gap.", () => {
  const h = harness(noon("2026-12-01")); const c = selectNovember(h); const reviews = closeTwelve(h, c.reviews);
  const report = draftCycleReport({ cycle: c.cycle, reviews, prior_months: [{ production_month: "2026-09", gross_pct: "0.0", net_pct: "0.0" }, { production_month: "2026-10", gross_pct: "9.1", net_pct: "0.0" }], vendor_review: null, today: D("2027-02-25") });
  h.at(noon("2027-02-25")); const issued = issueCycleReport(h.events, c.cycle, report, { issued_on: D("2027-02-25"), actor: QC_OFFICER });
  h.at(noon("2027-02-26")); const done = completeCycle(h.events, issued.cycle, reviews, { completed_on: D("2027-02-26"), management_ack_on: D("2027-02-26") });
  const vr = h.timer("FNMA_D1_1_02_VENDOR_REVIEW_10PCT_MONTHLY")!; assert.equal(vr.anchorDate, D("2027-02-26")); assert.equal(vr.dueDate, D("2027-03-13")); assert.equal(vr.armedByEventId, done.event.id);
  assert.equal(h.timers.evaluate("2027-03-13T22:00:00.000Z").filter((b) => b.instance.code === vr.code).length, 0);
  const breach = h.timers.evaluate("2027-03-14T05:00:00.000Z").filter((b) => b.instance.code === vr.code);
  assert.equal(breach.length, 1); assert.equal(breach[0]!.severity, 1); assert.deepEqual(breach[0]!.escalateTo, ["officer"]); assert.match(breach[0]!.breachText, /partner `officer`/);
  // the monthly report states the gap: D1-1-02 — the lender itself, never SM
  const gap = vendorReviewGapStatement(done.cycle, null, D("2027-03-14")); assert.match(gap, /^GAP — the partner has not performed the D1-1-02 monthly review of at least 10%/); assert.match(gap, /may not be contracted out — SM cannot perform it/);
  const withGap = draftCycleReport({ cycle: done.cycle, reviews, prior_months: report.three_month_trend.slice(0, 2), vendor_review: null, today: D("2027-03-14") }); assert.equal(withGap.vendor_review.performed, false); assert.match(withGap.text, /GAP — the partner has not performed/);
  // SM or a contractor cannot perform it in the partner's place; the partner officer's ≥ 10 % re-review with concurrence satisfies (late) and retires the kernel's re-arm
  const total = reviews.length; const required = vendorReviewRequirement(total); assert.equal(required, Math.ceil(total / 10));
  const ids = reviews.slice(0, required).map((r) => r.review_id); const concurrence = ids.map((review_id) => ({ review_id, concurs: true }));
  qcRefused(() => recordVendorReview(h.events, done.cycle, reviews, { reviewed_review_ids: ids, performed_by: "sm", concurrence, recorded_on: D("2027-03-16"), actor: OFFICER }, h.timers), "VENDOR_REVIEW_NOT_CONTRACTED_OUT");
  qcRefused(() => recordVendorReview(h.events, done.cycle, reviews, { reviewed_review_ids: ids, performed_by: "contractor", concurrence, recorded_on: D("2027-03-16"), actor: OFFICER }, h.timers), "VENDOR_REVIEW_NOT_CONTRACTED_OUT");
  qcRefused(() => recordVendorReview(h.events, done.cycle, reviews, { reviewed_review_ids: ids, performed_by: "partner", concurrence, recorded_on: D("2027-03-16"), actor: QC_OFFICER }, h.timers), "VENDOR_REVIEW_RECORDED_BY_PARTNER_OFFICER");
  const short = recordVendorReview(h.events, done.cycle, reviews, { reviewed_review_ids: ids.slice(0, 1), performed_by: "partner", concurrence: concurrence.slice(0, 1), recorded_on: D("2027-03-15"), actor: OFFICER }, h.timers);
  assert.equal(short.result.coverage_met, false); assert.equal(vr.status, "breached", "a review short of 10% does not satisfy");
  h.at(noon("2027-03-16")); const ok = recordVendorReview(h.events, done.cycle, reviews, { reviewed_review_ids: ids, performed_by: "partner", concurrence, recorded_on: D("2027-03-16"), actor: OFFICER }, h.timers);
  assert.equal(ok.result.coverage_met, true); assert.equal(ok.result.required_count, required); assert.equal(ok.result.concurrence_rate_pct, "100.0"); assert.equal(vr.status, "satisfied_late"); assert.ok(ok.retired_rearm_id); assert.equal(h.timers.byCode(vr.code).find((t) => t.id === ok.retired_rearm_id)!.status, "cancelled");
  assert.match(vendorReviewGapStatement(done.cycle, ok.result, D("2027-03-16")), /^Partner 10% re-review \(D1-1-02\)/);
});

test("28.2-T10: Given the refinance fixture purchased Nov 19, 2026 with first payment Jan 1, 2027, then `rep_warrant_relief{payment_history_36}.target_36th_due_on = 2029-12-01`; a third 30-day delinquency sets `at_risk = true`; `status = confirmed_by_fnma` is set only from a parsed Fannie Mae relief report.", () => {
  const h = harness("2026-11-19T20:00:00.000Z");
  // 29.4's `loan.purchased` (both ids during the hand-off) → the 28.2 tracker opens with the purchase as causation
  const purchased = h.events.append({ type: "loan.purchased", loanId: LOAN, applicationId: APP, actor: { kind: "system", id: "delivery" }, payload: { purchase_date: "2026-11-19", acquisition_date: "2026-11-19", fnma_loan_number: FNMA_NO, investor: "fnma", source: "origination" } });
  const opened = openReliefTracking(h.events, { application_id: APP, loan_id: LOAN, purchase_date: D("2026-11-19"), first_payment_due: D("2027-01-01"), at: "2026-11-19T20:00:00.000Z", purchased_event_id: purchased.id });
  assert.equal(opened.row.target_36th_due_on, D("2029-12-01")); assert.equal(opened.row.status, "eligible"); assert.equal(opened.row.component, "payment_history_36"); assert.equal(opened.row.relief_id, `rwr:${APP}:payment_history_36`); assert.equal(opened.event.causationId, purchased.id);
  assert.deepEqual(opened.row.excluded_matters, ["charter", "misrepresentation", "data_inaccuracy", "title_lien", "compliance_with_laws", "unacceptable_products"]);
  const t36 = h.timer("FNMA_A2_3_2_02_RELIEF_36_PAYMENTS")!; assert.equal(t36.anchorDate, D("2029-12-01")); assert.equal(t36.dueDate, D("2029-12-01")); assert.equal(t36.status, "armed");
  assert.throws(() => openReliefTracking(h.events, { application_id: APP, loan_id: LOAN, purchase_date: D("2027-01-01"), first_payment_due: D("2027-01-01"), at: "2026-11-19T20:00:00.000Z" }), /first payment due follows the acquisition date/);
  // servicing's payment history: two 30-day delinquencies keep `eligible`; the third sets at_risk (any 60-day does too)
  const hist = (lates: number[], sixty = 0) => Array.from({ length: 12 }, (_, k) => ({ installment_no: k + 1, due_date: addDays(D("2027-01-01"), 0) && D(`2027-${String(k + 1).padStart(2, "0")}-01`), paid_on: D(`2027-${String(k + 1).padStart(2, "0")}-15`), days_late: lates.includes(k + 1) ? 35 : k + 1 === sixty ? 62 : 14 }));
  const two = trackRelief(opened.row, hist([2, 5]), D("2027-12-31")); assert.equal(two.payments_made, 12); assert.equal(two.delinquencies_30, 2); assert.equal(two.at_risk, false); assert.equal(two.status, "eligible");
  const three = trackRelief(opened.row, hist([2, 5, 9]), D("2027-12-31")); assert.equal(three.delinquencies_30, 3); assert.equal(three.at_risk, true); assert.equal(three.status, "at_risk");
  const sixty = trackRelief(opened.row, hist([], 7), D("2027-12-31")); assert.equal(sixty.delinquencies_60_plus, 1); assert.equal(sixty.at_risk, true);
  // the platform's own count never confirms: only a parsed Fannie Mae relief report (Fannie Mae Connect, downloaded by the operator) listing the loan
  qcRefused(() => confirmReliefFromReport(h.events, two, FNMA_NO, null, "2029-12-15T15:00:00.000Z"), "RELIEF_REPORT_REQUIRED");
  qcRefused(() => confirmReliefFromReport(h.events, two, FNMA_NO, { relief_report_id: "RR-2029-12", source: "fannie_mae_connect", downloaded_by_role: "fnma_portal_operator", report_date: D("2029-12-10"), loans: [{ fnma_loan_number: "9999999999", relief_basis: "payment_history_36" }] }, "2029-12-15T15:00:00.000Z"), "LOAN_NOT_ON_RELIEF_REPORT");
  assert.throws(() => confirmReliefFromReport(h.events, two, FNMA_NO, { relief_report_id: "RR-2029-12", source: "fannie_mae_connect", downloaded_by_role: "qc-audit", report_date: D("2029-12-10"), loans: [{ fnma_loan_number: FNMA_NO, relief_basis: "payment_history_36" }] }, "2029-12-15T15:00:00.000Z"), /downloaded from Fannie Mae Connect by the fnma_portal_operator/);
  assert.equal(t36.status, "armed");
  // the 36th due date passes: the informational row breaches with no severity and no breach action, and waits for the report
  const b36 = h.timers.evaluate("2029-12-02T05:00:00.000Z").find((b) => b.instance.code === t36.code)!; assert.equal(b36.severity, null); assert.match(b36.breachText, /none \(informational\)/); assert.equal(t36.status, "breached");
  h.at("2029-12-15T15:00:00.000Z"); const conf = confirmReliefFromReport(h.events, two, FNMA_NO, { relief_report_id: "RR-2029-12", source: "fannie_mae_connect", downloaded_by_role: "fnma_portal_operator", report_date: D("2029-12-10"), loans: [{ fnma_loan_number: FNMA_NO, relief_basis: "payment_history_36" }] }, "2029-12-15T15:00:00.000Z");
  assert.equal(conf.row.status, "confirmed_by_fnma"); assert.equal(conf.row.relief_report_id, "RR-2029-12"); assert.equal(conf.row.confirmed_at, "2029-12-15T15:00:00.000Z"); assert.equal(conf.event.type, "rep_warrant_relief.confirmed"); assert.equal(conf.event.payload.fnma_report_id, "RR-2029-12");
  assert.equal(t36.status, "satisfied_late", "confirmed after the 36th due date passed (informational row, no breach action)"); assert.throws(() => trackRelief(conf.row, hist([]), D("2030-01-01")), /is confirmed_by_fnma/);
});

test("28.2-T11: Given a soft tri-merge in QC shows an $18,400 auto loan opened Nov 20, 2026 (after the Nov 6 note date), then the liability reconciliation records it as post-closing with no finding; an auto loan opened Oct 28 would trigger a DTI recomputation and, if outside B3-2-10 tolerance, `reunderwrite_required`.", () => {
  const underwritten: Tradeline[] = [{ creditor: "Card Co", kind: "revolving", opened_on: D("2019-03-01"), balance_cents: 420_000n, payment_cents: 12_600n }, { creditor: "Student Loans", kind: "installment", opened_on: D("2015-09-01"), balance_cents: 3_100_000n, payment_cents: 31_000n }];
  const auto = (opened_on: string, payment_cents: bigint): Tradeline => ({ creditor: "Auto Finance", kind: "auto", opened_on: D(opened_on), balance_cents: 1_840_000n, payment_cents });
  const base = { note_date: D("2026-11-06"), underwritten_tradelines: underwritten, qualifying_income_monthly_cents: 1_287_056n, underwritten_debts_monthly_cents: 616_500n };
  // opened Nov 20 — after the note date: post-closing, no finding, no DTI change
  const post = reconcileLiabilities({ ...base, refreshed_tradelines: [...underwritten, auto("2026-11-20", 41_200n)] });
  assert.equal(post.new_tradelines.length, 1); assert.equal(post.new_tradelines[0]!.classification, "post_closing"); assert.equal(post.new_tradelines[0]!.finding, false); assert.equal(post.new_tradelines[0]!.tradeline.balance_cents, 1_840_000n);
  assert.equal(post.undisclosed_payment_cents, 0n); assert.equal(post.dti_before_pct, "47.9"); assert.equal(post.dti_after_pct, "47.9"); assert.equal(post.within_tolerance, true); assert.equal(post.reunderwrite_required, false);
  // opened Oct 28 — before the note date: undisclosed debt → DTI recomputed; $412/mo pushes 47.9 % → 51.1 %, past the 50 % DU maximum (outside B3-2-10 tolerance) → re-underwrite
  const pre = reconcileLiabilities({ ...base, refreshed_tradelines: [...underwritten, auto("2026-10-28", 41_200n)] });
  assert.equal(pre.new_tradelines[0]!.classification, "undisclosed_pre_note"); assert.equal(pre.new_tradelines[0]!.finding, true); assert.equal(pre.undisclosed_payment_cents, 41_200n);
  assert.equal(pre.dti_after_pct, "51.1"); assert.equal(pre.within_tolerance, false); assert.equal(pre.reunderwrite_required, true);
  // a small undisclosed payment inside the 3-pp / 50 % tolerance recomputes without a re-underwrite
  const small = reconcileLiabilities({ ...base, refreshed_tradelines: [...underwritten, auto("2026-10-28", 10_000n)] });
  assert.equal(small.dti_after_pct, "48.7"); assert.equal(small.within_tolerance, true); assert.equal(small.reunderwrite_required, false); assert.equal(DU_DTI_TOLERANCE_PP, "3"); assert.equal(DU_MAX_DTI_PCT, "50");
  // a +3.1 pp rise below 50 % is still outside tolerance
  const rise = reconcileLiabilities({ ...base, qualifying_income_monthly_cents: 2_000_000n, underwritten_debts_monthly_cents: 800_000n, refreshed_tradelines: [...underwritten, auto("2026-10-28", 62_000n)] });
  assert.equal(rise.dti_before_pct, "40.0"); assert.equal(rise.dti_after_pct, "43.1"); assert.equal(rise.within_tolerance, false); assert.equal(rise.reunderwrite_required, true);
  // the tradeline already on the underwriting report is not "new"
  assert.equal(reconcileLiabilities({ ...base, refreshed_tradelines: underwritten }).new_tradelines.length, 0);
});

test("28.2-T12: Given the QC agent attempts to submit an LQC self-report or to pay a demand, then the action is refused; only an `fnma_portal_operator` escalation (submission) or a partner `officer` decision (payment) can satisfy the timers.", async () => {
  const h = harness("2027-01-20T16:00:00.000Z"); const c = selectNovember(h);
  // the self-report of T4, approved by the partner officer, waiting for submission
  const review: QcReview = { ...c.reviews.find((r) => r.kind === "post_closing_random")!, loan_id: LOAN, application_id: APP, reunderwrite_required: true, eligible_as_delivered: false, status: "reunderwrite" };
  h.at("2027-01-20T16:00:00.000Z"); const conf = confirmIneligibleAsDelivered(h.events, review, { confirmed_at: "2027-01-20T16:00:00.000Z", actor: QC_OFFICER, sold_to_fnma: true, initial_severity: 1, final_severity: 1, defect_class: "underwriting_eligibility", loan: { fnma_loan_number: FNMA_NO, seller_loan_number: "000155001", borrower_last_name: "Fixture", note_date: D("2026-11-06") } });
  const drafted = draftSelfReport(h.events, conf.self_report!, { synopsis: "income miscalculated", deficiencies: [{ category: "Income/Employment", sub_category: "Income Calculation", defect: "Income miscalculated" }], documents: ["doc-transcript-2025"], at: h.clock.now() });
  const approved = approveSelfReport(h.events, drafted.self_report, { actor: OFFICER, at: "2027-01-21T16:00:00.000Z" });
  h.rt.store.put("qc_self_reports", approved.self_report.self_report_id, approved.self_report as unknown as Record<string, unknown>, OFFICER, h.clock.now());
  const srTimer = h.timer("FNMA_D1_1_01_QC_SELF_REPORT_30")!; assert.equal(srTimer.status, "armed");
  const submit = { self_report_id: approved.self_report.self_report_id, op: "submit", submitted_at: "2027-01-22T15:00:00.000Z", lqc_reference: "SR-2027-0122-01" };
  await refused(h.run("draftSelfReport", submit, AGENT), "LQC_SUBMISSION_IS_OPERATOR_ONLY");
  await refused(h.run("draftSelfReport", submit, QC_OFFICER), "LQC_SUBMISSION_IS_OPERATOR_ONLY");
  await refused(h.run("draftSelfReport", submit, OFFICER), "LQC_SUBMISSION_IS_OPERATOR_ONLY");
  await refused(h.run("draftSelfReport", { ...submit, submit_to_fnma: true }, AGENT), "AGENT_NEVER_SUBMITS_TO_FNMA");
  assert.equal(srTimer.status, "armed"); assert.equal(h.ofType("qc.self_report.submitted").length, 0); assert.ok(h.ofType("command.refused").length >= 4);
  h.at("2027-01-22T15:00:00.000Z"); const sub = await h.run("draftSelfReport", submit, OPERATOR);
  assert.equal(sub.status, "submitted"); assert.equal(srTimer.status, "satisfied"); assert.equal(h.ofType("qc.self_report.submitted")[0]!.payload.submitted_by_role, "fnma_portal_operator");
  // a repurchase demand: the agent, the analyst and the QC officer cannot pay; the partner officer's payment satisfies the 60-day clock
  h.at("2027-05-03T14:00:00.000Z"); const dc = openFnmaCase(h.events, { loan_id: LOAN, application_id: APP, fnma_loan_number: FNMA_NO, case_type: "demand_repurchase", notified_at: "2027-05-03T14:00:00.000Z", lqc_task_id: "LQC-DEM-2", parent_case_id: null }, []).case;
  const dem = receiveDemand(h.events, dc, { demand_received_on: D("2027-05-03"), amount_cents: 55_987_657n }); h.rt.store.put("remedy_ledger", dem.ledger.remedy_id, dem.ledger as unknown as Record<string, unknown>, AGENT, h.clock.now());
  const payTimer = h.timer("FNMA_A2_3_2_01_REMEDY_PAYMENT_60")!; assert.equal(payTimer.dueDate, D("2027-07-02"));
  const pay = { remedy_id: dem.ledger.remedy_id, op: "pay", paid_at: "2027-06-25T18:00:00.000Z", wire_ref: "FED-2027-0625-77", amount_cents: 55_987_657n };
  await refused(h.run("draftAppeal", pay, AGENT), "REMEDY_PAYMENT_NEEDS_PARTNER_OFFICER");
  await refused(h.run("draftAppeal", pay, ANALYST), "REMEDY_PAYMENT_NEEDS_PARTNER_OFFICER");
  await refused(h.run("draftAppeal", pay, QC_OFFICER), "REMEDY_PAYMENT_NEEDS_PARTNER_OFFICER");
  qcRefused(() => payRemedy(h.events, dem.ledger, { paid_at: "2027-06-25T18:00:00.000Z", wire_ref: "FED-2027-0625-77", amount_cents: 55_987_657n, actor: AGENT }), "REMEDY_PAYMENT_NEEDS_PARTNER_OFFICER");
  assert.equal(payTimer.status, "armed"); assert.equal(h.ofType("remedy.paid").length, 0);
  h.at("2027-06-25T18:00:00.000Z"); const paid = await h.run("draftAppeal", pay, OFFICER);
  assert.equal((paid.ledger as { payment_timer: string }).payment_timer, "paid"); assert.equal(payTimer.status, "satisfied"); assert.equal(h.ofType("remedy.paid")[0]!.payload.paid_by_role, "officer"); assert.equal(h.ofType("remedy.paid")[0]!.payload.on_time, true);
  const set = paid.entry_set as { lines: { ruleRef: string; amountCents: bigint }[] }; assert.equal(set.lines.length, 2); assert.ok(set.lines.every((l) => l.ruleRef === "28.2 rule 9 / A2-3.2-01")); assert.equal(set.lines[0]!.amountCents + set.lines[1]!.amountCents, 0n);
  // the decision rows: the operator's submission and the officer's payment are recorded acts; every other refusal left only `command.refused`
  assert.ok(h.decisions.some((d) => d.action === "draftSelfReport:submit")); assert.ok(h.decisions.some((d) => d.action === "draftAppeal:pay"));
});

test("28.2-T13: Given a CU score of 2.5 on a one-unit appraisal with relief conditions met, then comparables are not reverified but property eligibility, unacceptable-practice checks and CU message reconciliation still run; with CU 3.4 the comparables are reverified and a desk review is ordered only if the assessment cannot be completed.", () => {
  const relief = assessCollateral({ cu_score: "2.5", units: 1, relief_conditions_met: true, assessment_completable: true, property_eligible: true, cu_messages: ["CU-101 comparable distance"] });
  assert.equal(relief.comps_reverify_required, false); assert.equal(relief.property_eligibility_checked, true); assert.equal(relief.unacceptable_practices_checked, true); assert.equal(relief.cu_messages_reconciled, true); assert.equal(relief.desk_or_field_review_ordered, false); assert.equal(relief.review_kind, null); assert.match(relief.basis, /CU 2\.5 ≤ 2\.5 with relief conditions met/);
  // the exemption needs the relief conditions and a one-unit property; 2.6 is over the line
  assert.equal(assessCollateral({ cu_score: "2.5", units: 1, relief_conditions_met: false, assessment_completable: true, property_eligible: true }).comps_reverify_required, true);
  assert.equal(assessCollateral({ cu_score: "2.5", units: 2, relief_conditions_met: true, assessment_completable: true, property_eligible: true }).comps_reverify_required, true);
  assert.equal(assessCollateral({ cu_score: "2.6", units: 1, relief_conditions_met: true, assessment_completable: true, property_eligible: true }).comps_reverify_required, true);
  // CU 3.4: comparables reverified; a desk review only when the assessment cannot be completed
  const cu34 = assessCollateral({ cu_score: "3.4", units: 1, relief_conditions_met: true, assessment_completable: true, property_eligible: true });
  assert.equal(cu34.comps_reverify_required, true); assert.equal(cu34.desk_or_field_review_ordered, false); assert.equal(cu34.cu_messages_reconciled, true);
  const stuck = assessCollateral({ cu_score: "3.4", units: 1, relief_conditions_met: true, assessment_completable: false, property_eligible: true, unacceptable_practice_findings: ["comparable selection favors a predetermined value"] });
  assert.equal(stuck.comps_reverify_required, true); assert.equal(stuck.desk_or_field_review_ordered, true); assert.equal(stuck.review_kind, "desk"); assert.deepEqual(stuck.issues, ["B4-1.1-04: comparable selection favors a predetermined value"]); assert.match(stuck.basis, /desk review ordered from a licensed appraiser/);
  // unscored appraisals reverify comps and reconcile no CU messages; value acceptance runs the eligibility check only
  const unscored = assessCollateral({ cu_score: null, units: 1, relief_conditions_met: true, assessment_completable: true, property_eligible: false }); assert.equal(unscored.comps_reverify_required, true); assert.equal(unscored.cu_messages_reconciled, false); assert.deepEqual(unscored.issues, ["property eligibility (LTV/CLTV/HCLTV or property type) not met"]);
  assert.equal(assessCollateral({ cu_score: null, relief_conditions_met: false, value_acceptance: true, assessment_completable: true, property_eligible: true }).comps_reverify_required, false);
  // the same rule inside the scope engine
  assert.equal(computeScope({ ...REFI_SCOPE, value_acceptance: false, cu_score: "2.5" }).comps_reverify_required, false); assert.equal(computeScope({ ...REFI_SCOPE, value_acceptance: false, cu_score: "3.4" }).comps_reverify_required, true);
  assert.equal(computeScope({ ...REFI_SCOPE, value_acceptance: false, cu_score: "3.4", collateral_assessment_completable: false }).desk_or_field_review_ordered, true);
  // the refinance's occupancy, closing documents and DU final match of worked example 1
  const occ = assessOccupancy({ documented_occupancy: "primary", insurance_policy_form: "HO-3", mailing_address_matches_subject: true, other_reo_claimed_primary: false }); assert.equal(occ.consistent, true); assert.deepEqual(occ.red_flags, []);
  const flag = assessOccupancy({ documented_occupancy: "primary", insurance_policy_form: "DP-3", mailing_address_matches_subject: false, lease_on_subject: true }); assert.equal(flag.further_investigation_required, true); assert.equal(flag.red_flags.length, 3);
  const docs = reviewClosingDocuments({ present: ["recorded_security_instrument", "note", "title_evidence", "final_settlement_statement"], mi_required: false, recorded_copy_reviewed: true, consistent_with_underwriting: true }); assert.equal(docs.complete, true); assert.equal(docs.mi_adequate, null);
  assert.deepEqual(reviewClosingDocuments({ present: ["note"], mi_required: true, mi_certificate_present: true, mi_coverage_pct: 25, mi_required_coverage_pct: 25, recorded_copy_reviewed: true, consistent_with_underwriting: true }).missing, ["recorded_security_instrument", "title_evidence", "final_settlement_statement"]);
  const du = matchDuFinalData({ du_final: { loan_amount_cents: 56_000_000, note_rate: "6.125", dti_pct: 47.9 }, closed_loan: { loan_amount_cents: 56_000_000, note_rate: "6.125", dti_pct: 47.9 } }); assert.equal(du.resubmission_required, false); assert.equal(du.limited_waiver_invalidated, false);
  const off = matchDuFinalData({ du_final: { dti_pct: 44.0 }, closed_loan: { dti_pct: 47.9 }, tolerances: { dti_pct: 3 } }); assert.equal(off.resubmission_required, true); assert.equal(off.limited_waiver_invalidated, true);
});

test("28.2 worked figures: the repurchase price on the spec's UPB of $556,143.55 (LLPAs excluded), the 10 %/statistical draw, the cycle and ladder dates", () => {
  // Rule 9 / worked example 2: the remedy_ledger computes the repurchase price on the payment date — UPB $556,143.55 after eight payments (the servicing ledger's figure is the input), accrued interest at 6.125 % from the last paid installment date through the repurchase date, no expenses, LLPAs excluded
  const price = computeRepurchasePrice({ upb_cents: 55_614_355n, note_rate_pct: "6.125", interest_from: D("2027-08-01"), through: D("2027-09-10"), expenses_cents: 0n, llpa_cents: 140_000n });
  assert.equal(price.upb_cents, 55_614_355n); assert.equal(price.interest_days, 40);
  // $556,143.55 × 6.125 % × 40 / 365 = $3,733.02 (actual/365 at the note rate)
  assert.equal(price.accrued_interest_cents, 373_302n);
  assert.equal(price.accrued_interest_cents, Decimal.parse("556143.55").mul(ratePercent("6.125")).mul(Decimal.fromInt(40)).div(Decimal.fromInt(365)).toCents());
  assert.equal(price.total_cents, 55_987_657n); assert.equal(price.total_cents, price.upb_cents + price.accrued_interest_cents + price.expenses_cents); assert.equal(price.llpa_excluded, true); assert.equal(price.llpa_cents_excluded, 140_000n);
  assert.equal(computeRepurchasePrice({ upb_cents: 55_614_355n, note_rate_pct: "6.125", interest_from: D("2027-08-01"), through: D("2027-08-01") }).total_cents, 55_614_355n, "repurchased on the installment date: UPB only");
  assert.equal(computeRepurchasePrice({ upb_cents: 55_614_355n, note_rate_pct: "6.125", interest_from: D("2027-08-01"), through: D("2027-09-10"), expenses_cents: 125_000n }).total_cents, 55_987_657n + 125_000n, "Fannie Mae's property-related expenses are added");
  // a PAL is the LLPA that should have been paid × UPB: 0.250 % of $556,143.55 = $1,390.36
  assert.equal(computePalAmount("0.250", 55_614_355n), 139_036n);
  // Rule 2: ceil(0.10 × 118) = 12; n₀ = 1.96² × 0.08 × 0.92 / 0.02² and the FPC over 700 (spec: 706.8 → 351.7; exact 706.85 → 351.96 — discrepancy reported)
  assert.equal(tenPercentTarget(118), 12); assert.equal(tenPercentTarget(120), 12); assert.equal(tenPercentTarget(121), 13);
  const s = statisticalSample({ confidence: 0.95, precision: 0.02, statement_months: 6, expected_defect_rate: 0.08, six_month_population: 700 }); assert.ok(Math.abs(s.n0 - 706.85) < 0.01); assert.ok(Math.abs(s.n - 351.96) < 0.01);
  // Rule 1 and rule 8/9 dates
  assert.equal(cycleDueOn("2026-11"), D("2027-02-28")); assert.equal(cycleDueOn("2026-12"), D("2027-03-31")); assert.equal(cycleDueOn("2026-10"), D("2027-01-29"));
  assert.equal(caseDueOn("file_request", D("2026-12-16")), D("2027-01-15")); assert.equal(policySubmitBy(D("2027-01-15")), D("2027-01-13")); assert.equal(policySubmitBy(D("2027-02-28")), D("2027-02-26"));
  assert.deepEqual([addDays(D("2027-05-03"), 60), addDays(D("2027-06-10"), 60), addDays(D("2027-08-09"), 15)], [D("2027-07-02"), D("2027-08-09"), D("2027-08-24")]);
  // Rule 7 / A3-2-01: the compliance self-report clock — Category 1 (above the lesser of 500 or 1 %, same quarter) from the later of quarter-end and discovery; Category 2 at any volume when a repurchase could follow and no remedy within 60 days
  const cat1 = complianceSelfReportClock({ affected_loans: 15, prior_year_deliveries: 1_200, all_delivered_same_quarter: true, delivery_quarter_end: D("2026-12-31"), discovery_on: D("2026-12-10"), could_warrant_repurchase: false, remedied_within_60: false });
  assert.equal(cat1.category, "category_1"); assert.equal(cat1.threshold, 12); assert.equal(cat1.clock_from, D("2026-12-31")); assert.equal(cat1.due_on, D("2027-03-01"));
  const cat2 = complianceSelfReportClock({ affected_loans: 1, prior_year_deliveries: 1_200, all_delivered_same_quarter: true, delivery_quarter_end: D("2026-12-31"), discovery_on: D("2027-01-20"), could_warrant_repurchase: true, remedied_within_60: false });
  assert.equal(cat2.category, "category_2"); assert.equal(cat2.clock_from, D("2027-01-20")); assert.equal(cat2.due_on, D("2027-03-21"));
  assert.equal(complianceSelfReportClock({ affected_loans: 1, prior_year_deliveries: 1_200, all_delivered_same_quarter: true, delivery_quarter_end: D("2026-12-31"), discovery_on: D("2027-01-20"), could_warrant_repurchase: true, remedied_within_60: true }).notice_required, false);
  const h = harness(noon("2027-01-20")); const b = confirmComplianceBreach(h.events, { breach_id: "cb-1", loan_ids: [LOAN], application_id: APP, description: "TRID tolerance cure not delivered", at: noon("2027-01-20"), affected_loans: 1, prior_year_deliveries: 1_200, all_delivered_same_quarter: true, delivery_quarter_end: D("2026-12-31"), discovery_on: D("2027-01-20"), could_warrant_repurchase: true, remedied_within_60: false });
  assert.equal(b.event!.payload.fnma_reporting_category, "category_2"); const t60 = h.timer("FNMA_A3_2_01_COMPLIANCE_SELF_REPORT_60")!; assert.equal(t60.anchorDate, D("2027-01-20")); assert.equal(t60.dueDate, D("2027-03-21"));
  // the decision record never carries a demographic read and hashes its inputs
  const rec = decisionRecord28_2({ review_id: "r", inputs: { review_id: "r", scope: "x" }, rationale: "scope applied", model_version: "qc-audit@1.2", prompt_version: "post-closing@3", confidence: 0.93 });
  assert.equal(rec.demographic_fields_read, 0); assert.deepEqual(rec.rule_set_versions, ["fnma.qc.post_closing.v1", "fnma.qc.taxonomy.v1"]); assert.match(rec.inputs_hash, /^[0-9a-f]{64}$/);
  assert.throws(() => decisionRecord28_2({ inputs: { table: "applicant_demographics" }, rationale: "x", model_version: "m", prompt_version: "p", confidence: 0.5 }), /never reads applicant_demographics/);
  // a sustained-by-default finding at the rebuttal breach keeps its initial severity
  const rel = releaseFinding(h.events, draftFinding(h.events, { review_id: "qcr-x", loan_id: LOAN, application_id: APP } as unknown as QcReview, { category: "Assets", sub_category: "Large Deposit", defect: "Unsourced deposit", severity: 1, defect_class: "underwriting_eligibility", description: "$9,000 deposit unsourced", evidence_document_ids: ["stmt"] }, noon("2027-01-07")).finding, { released_on: D("2027-01-08"), actor: QC_OFFICER });
  const def = sustainByDefault(h.events, rel.finding, D("2027-01-19")); assert.equal(def.finding.final_severity, 1); assert.equal(def.event.payload.outcome, "sustained_by_default"); assert.equal(def.event.payload.within_window, false);
  const corrected = evaluateRebuttal(h.events, rel.finding, { outcome: "corrected", on: D("2027-01-15"), evidence_document_ids: ["bank-statement-sourcing-deposit"] }); assert.equal(corrected.finding.final_severity, 3); assert.equal(corrected.finding.status, "corrected");
  void (0 as unknown as QcCycle); void (0 as unknown as FnmaQcCase);
});
