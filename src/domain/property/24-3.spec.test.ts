// 24.3 Property and project eligibility (property types, condo/PUD project review incl. CPM and deferred-maintenance rules, manufactured housing, ADUs, condition ratings, escrow holdbacks, new construction, zoning/environmental)
// spec/sections/24-property-valuation-eligibility-title-hazard-flood-insurance/24-3-property-and-project-eligibility-property-types-condo-pud-pr.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandContext } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_24_3 } from "../../app/tools/section24-3.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { resolveRules, selectReviewType, projectStatus, runProjectTests, startProjectReview, runProjectEligibility, recordCpmStatus, reservePct, requiredReserveCents, classifyInspection, consummateGate, writeDecision, routeCondition, planRepairs, assertHoldbackEligible, computeHoldback, establishHoldback, fundHoldback, acceptCompletionEvidence, releaseFinalDraw, finalDrawDueOn, sweepHoldbacks, runPropertyEligibility, acceptRepairCompletion, leaseTermTest, verifyMhFacts, verifyMh, aduRentUsable, cpmCertValidGate, holdbackEscrowAccount, ceilDiv, SA_CRITICAL_REASON, SFC_MH_ADVANTAGE, HoldbackRefused, FNMA_SELLING_2026_09_02,
  type ProjectFacts, type Deficiency, type ValuationRatings, type EscrowHoldback } from "./ops-24-3.ts";
import { prepurchaseTiCash } from "../orig-boarding/ops-30-2.ts";

const AGENT: Actor = { kind: "agent", id: "valuation" };
const OPERATOR: Actor = { kind: "human", id: "u-cpm", role: "fnma_portal_operator" };
const APPRAISER: Actor = { kind: "external", id: "appraiser-1", role: "appraiser" };
const APP = "app-phx-condo";

/** 24.3 ops over a fresh event store, the overridden timer registry (24.3 rows only), a ledger and the escalation service; the bus runs the 24.3 tools for the role checks. */
function harness(nowIso: string, applicationId: string = APP) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["24.3"] });
  const ledger = new MemoryLedger(); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_24_3); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("24.3", name))!, actor, { application_id: applicationId, ...input }, uow)).output as Record<string, unknown>;
  const timer = (code: string) => timers.byCode(code).at(-1);
  const at = (iso: string) => clock.set(iso);
  return { clock, events, timers, ledger, decisions, rt, run, timer, at, uow };
}

// R4 worked example A: 40-unit Phoenix condo, $2,400/unit re-roof special assessment, engineer's report May 4, 2026.
const PHOENIX = (branch: "A" | "B", o: { cpm?: ProjectFacts["cpm"]; reserve_study?: ProjectFacts["reserve_study"] } = {}): ProjectFacts => ({
  project_type: "condo", project_name: "Camelback Terrace Condominiums", project_id: "proj-phx-1", units_total: 40, units_conveyed: 38, complete: true, hoa_control_transferred: true, unit_detached: false, part_of_master_association: false,
  special_assessments: [{ purpose: "re-roof Buildings A-D", approved_on: D("2026-08-12"), planned_or_executing: "executing", original_cents: 9_600_000n, remaining_cents: 9_600_000n, per_unit_cents: 240_000n, paid_in_full_by: D("2027-09-30"), related_to_critical_repair: false, delinquency_pct_bp: 1250, monthly_installment_cents: 20_000n }],
  inspection_reports: [{ date: D("2026-05-04"), kind: "engineer's report", reviewed: true, findings: branch === "A" ? "roofs at end of service life, no active leaks, no water intrusion, no structural findings" : "roof membrane failure with active water intrusion into three units" }],
  delinquent_60_units: 3, single_entity_max_units: 4, commercial_pct_bp: 0, litigation: [], annual_assessment_income_cents: 28_800_000n, reserve_allocation_cents: 3_000_000n, reserve_study: o.reserve_study === undefined ? { date: D("2025-03-15"), highest_recommended_cents: 3_000_000n, method: "component", highest_recommended_budgeted: true } : o.reserve_study,
  questionnaire_date: D("2026-09-22"), budget_date: D("2026-07-01"), questionnaire_kind: "form_1076_2016_addendum_2021", evacuation_order: false, regulatory_action: false, lien_priority_months: 6, cpm: o.cpm ?? null,
});
// R5 fixture: Columbus, OH purchase, C5 with a safety deck item and a weather-delayed paint item (in the sales contract).
const DECK: Deficiency = { item: "rear deck rotted support posts", safety_related: true, estimate_cents: 450_000n, in_sales_contract: true, delay_reason: null };
const PAINT: Deficiency = { item: "peeling exterior paint, south elevation", safety_related: false, estimate_cents: 320_000n, in_sales_contract: true, delay_reason: "November weather", occupancy_permit_affected: false };
const R5_RATINGS: ValuationRatings = { condition_rating: "C5", quality_rating: "Q4", as_is_or_subject_to: "subject_to", valuation_id: "val-cmh-1", deficiencies: [DECK, PAINT] };

test("24.3-T1: Given the 40-unit Phoenix project (Branch A) with an application date of Oct 5, 2026, then all Full Review tests pass, `reserve_pct = 0.1042`, `project_type_code = S`, and `expires_at = 2027-10-09` after CPM certification on Oct 9, 2026.", () => {
  const h = harness("2026-10-05T16:00:00.000Z");
  const rules = resolveRules(D("2026-10-05"));
  assert.equal(rules.limited_review_allowed, false); assert.equal(rules.reserve_min_bp, 1000); assert.equal(rules.rule_set_version, "fnma.selling.2026-09-02[limited_review_retired=true@2026-08-03, reserve_study_baseline_prohibited=true@2026-08-03]");
  const facts = PHOENIX("A");
  assert.equal(projectStatus(facts), "established");                                  // 38/40 = 95% ≥ 90%, complete, control transferred
  const sel = selectReviewType(facts, rules);
  assert.equal(sel.review_type, "full_cpm"); assert.equal(sel.project_type_code, "S"); assert.equal(sel.cpm_required, true);
  const started = startProjectReview(h.events, { application_id: APP, facts, rules, started_at: h.clock.now() });
  assert.equal(started.event?.type, "project.review.started"); assert.equal(started.event?.payload.lookback_from, "2023-10-05");
  const r = runProjectEligibility(h.events, started.review, facts, rules, h.clock.now());
  const t = r.tests;
  assert.deepEqual(t.tests.filter((x) => x.outcome === "fail"), [], "every Full Review test passes");
  assert.equal(t.result, "eligible"); assert.equal(t.critical_repairs.length, 0);
  assert.equal(classifyInspection(facts.inspection_reports![0]!).critical, false);       // Branch A: end of service life, no leaks → normal capital replacement
  assert.equal(t.tests.find((x) => x.rule === "delinquency_60")!.inputs.pct_bp, 750);        // 3/40 = 7.5% ≤ 15%
  assert.equal(t.tests.find((x) => x.rule === "single_entity")!.inputs.pct_bp, 1000);        // 4 units = 10% ≤ 20%
  assert.deepEqual(reservePct(3_000_000n, 28_800_000n), { reserve_pct: 0.1042, bp10k: 1042 });
  assert.equal(r.review.reserve_pct, 0.1042); assert.equal(t.reserve!.required_cents, 2_880_000n);
  assert.equal(t.docs_fresh, true); assert.equal(t.docs_as_of, "2026-07-01");
  assert.equal(r.review.status, "cpm_entry_pending", "CPM-required review waits for the operator");
  assert.equal(h.events.ofType("project.inspection.reviewed").at(-1)!.payload.all_in_window, true);
  // Fri Oct 9, 2026: the fnma_portal_operator certifies in CPM → the review completes; one-year validity → Oct 9, 2027; note date Fri Nov 6, 2026 inside.
  h.at("2026-10-09T18:00:00.000Z");
  const c = recordCpmStatus(h.events, r.review, { cpm_status: "lender_certified", cpm_project_id: "123456", cpm_certification_id: "CERT-77", cpm_cert_expires_on: D("2027-10-09"), note_date: D("2026-11-06") }, OPERATOR, h.clock.now());
  assert.equal(c.review.status, "certified"); assert.equal(c.review.project_type_code, "S"); assert.equal(c.review.expires_at, "2027-10-09"); assert.equal(c.review.cpm_recorded_by, "human:u-cpm");
  const completed = h.events.ofType("project.review.completed").at(-1)!;
  assert.equal(completed.payload.established, true); assert.equal(completed.payload.new, false); assert.equal(completed.payload.reviewed_at, "2026-10-09"); assert.equal(completed.payload.docs_fresh, true);
  const validity = h.timer("FNMA_B4_2_1_01_PROJECT_REVIEW_ESTABLISHED_1Y")!;
  assert.equal(validity.dueDate, "2027-10-09"); assert.equal(validity.status, "armed");
  assert.equal(h.timer("SM_PROJECT_DOCS_AGE_120"), undefined, "no docs intake event in this run → the policy gate never armed");
  assert.equal(cpmCertValidGate({ cpm_status: "lender_certified", cpm_cert_expires_on: "2027-10-09", note_date: "2026-11-06" }).open, true);
  assert.equal(consummateGate({ property_result: "eligible", project_review: c.review, note_date: D("2026-11-06") }).open, true);
  h.events.append({ type: "closing.consummated", applicationId: APP, actor: AGENT, occurredAt: "2026-11-06T20:00:00.000Z", payload: { application_id: APP, note_date: "2026-11-06" } });
  assert.equal(validity.status, "satisfied");
  const d = writeDecision({ application_id: APP, project: c.review, rules, model_version: "m1", prompt_version: "p1" });
  assert.equal(d.project!.reserve_pct, 0.1042); assert.equal(d.project!.cpm.project_id, "123456"); assert.equal(d.rule_set_version, rules.rule_set_version);
});

test("24.3-T2: Given the same project with an application date of Jan 4, 2027 and no reserve study, then the review fails on reserves (10.42% < 15%) and the decision cites LL-2026-03.", () => {
  const h = harness("2027-01-08T16:00:00.000Z");
  const rules = resolveRules(D("2027-01-04"));
  assert.equal(rules.reserve_min_bp, 1500); assert.ok(rules.switches_applied.some((s) => s.key === "reserve_min_bp" && s.effective_from === "2027-01-04"));
  assert.equal(rules.rule_set_version, "fnma.selling.2026-09-02[limited_review_retired=true@2026-08-03, reserve_min_bp=1500@2027-01-04, reserve_study_baseline_prohibited=true@2026-08-03, adu_rental_rules_mandatory=true@2026-11-01]");
  assert.equal(resolveRules(D("2027-01-03")).reserve_min_bp, 1000, "the day before the switch keeps 10%");
  const facts = PHOENIX("A", { reserve_study: null });
  const started = startProjectReview(h.events, { application_id: APP, facts, rules, started_at: h.clock.now() });
  const r = runProjectEligibility(h.events, started.review, facts, rules, h.clock.now());
  const reserves = r.tests.tests.find((x) => x.rule === "reserves")!;
  assert.equal(reserves.outcome, "fail"); assert.equal(reserves.inputs.reserve_pct, 0.1042); assert.equal(reserves.inputs.minimum_bp, 1500);
  assert.equal(requiredReserveCents(28_800_000n, 1500), 4_320_000n); assert.equal(reserves.inputs.required_allocation_cents, 4_320_000n);
  assert.match(reserves.reason!, /10\.42% < 15% minimum \(4320000 cents required\) — LL-2026-03/); assert.match(reserves.reason!, /no reserve study/);
  assert.match(reserves.citation, /LL-2026-03 \(03\/18\/2026\)/);
  assert.equal(r.tests.result, "ineligible"); assert.equal(r.review.status, "ineligible");
  assert.equal(h.events.ofType("project.ineligible.determined").length, 1);
  const d = writeDecision({ application_id: APP, project: r.review, rules });
  assert.ok(d.citations.includes("LL-2026-03 (03/18/2026)"), `decision cites LL-2026-03: ${d.citations.join("; ")}`);
  assert.match(d.rule_set_version, /reserve_min_bp=1500@2027-01-04/);
  // The same project with a ≤ 3-year reserve study whose highest recommended allocation is budgeted clears the 15% floor through the study exception.
  const withStudy = runProjectTests(PHOENIX("A", { reserve_study: { date: D("2025-03-15"), highest_recommended_cents: 3_000_000n, method: "component", highest_recommended_budgeted: true } }), rules, D("2027-01-08"));
  assert.equal(withStudy.tests.find((x) => x.rule === "reserves")!.outcome, "pass"); assert.equal(withStudy.reserve!.via_reserve_study, true);
  const baseline = runProjectTests(PHOENIX("A", { reserve_study: { date: D("2025-03-15"), highest_recommended_cents: 3_000_000n, method: "baseline", highest_recommended_budgeted: true } }), rules, D("2027-01-08"));
  assert.match(baseline.tests.find((x) => x.rule === "reserves")!.reason!, /baseline funding methodology not permitted/);
});

test("24.3-T3: Given Branch B (engineer's report with active water intrusion) and the $2,400/unit assessment, then `project.ineligible.determined` fires with reason \"special assessment associated with unremediated critical repair\", and the application cannot pass `consummate`.", async () => {
  const h = harness("2026-10-05T16:00:00.000Z");
  const rules = resolveRules(D("2026-10-05"));
  const facts = PHOENIX("B");
  assert.equal(classifyInspection(facts.inspection_reports![0]!).critical, true);
  const started = startProjectReview(h.events, { application_id: APP, facts, rules, started_at: h.clock.now() });
  const r = runProjectEligibility(h.events, started.review, facts, rules, h.clock.now());
  assert.equal(r.tests.result, "ineligible");
  const sa = r.tests.tests.find((x) => x.rule.startsWith("special_assessment:"))!;
  assert.equal(sa.outcome, "fail"); assert.equal(sa.inputs.per_unit_cents, 240_000n); assert.equal(sa.inputs.related_to_critical_repair, true);
  const det = h.events.ofType("project.ineligible.determined").at(-1)!;
  assert.equal(det.payload.reason, SA_CRITICAL_REASON); assert.equal(det.payload.reason, "special assessment associated with unremediated critical repair");
  assert.equal(det.applicationId, APP);
  assert.equal(r.review.status, "ineligible");
  const gate = consummateGate({ property_result: "eligible", project_review: r.review, note_date: D("2026-11-06") });
  assert.equal(gate.open, false); assert.match(gate.reason!, /special assessment associated with unremediated critical repair/);
  // through the bus: the tool's consummate guard reads the stored review; the routine-override flag is refused outright.
  h.rt.store.put("project_reviews", r.review.project_review_id, r.review as unknown as Record<string, unknown>, AGENT, h.clock.now());
  const viaBus = await h.run("runProjectEligibility", { op: "consummate", note_date: "2026-11-06" });
  assert.equal(viaBus.open, false);
  await assert.rejects(h.run("runProjectEligibility", { facts, treat_assessment_as_routine: true }), (e: unknown) => e instanceof CommandRefused && e.code === "SPECIAL_ASSESSMENT_NEVER_ROUTINE");
  // Branch B remediated: the same assessment with the re-roof complete and documented is routine again.
  const fixed: ProjectFacts = { ...facts, questionnaire_date: D("2026-11-20"), budget_date: D("2026-11-01"), inspection_reports: [{ date: D("2026-12-01"), kind: "updated engineer's report", findings: "re-roof complete; no active leaks, no water intrusion", reviewed: true }], special_assessments: [{ ...facts.special_assessments![0]!, remediated: true }] };
  assert.equal(runProjectTests(fixed, rules, D("2026-12-02")).result, "eligible");
});

test("24.3-T4: Given a 6-unit attached project not in a master association, then `review_type = waived`, `project_type_code = V`, and the B2-3/ineligible-characteristics checks still run; given the same project inside a master association, then Full Review is required.", () => {
  const rules = resolveRules(D("2026-10-05"));
  const six: ProjectFacts = { project_type: "condo", units_total: 6, units_conveyed: 6, complete: true, hoa_control_transferred: true, unit_detached: false, part_of_master_association: false, questionnaire_kind: "equivalent" };
  const sel = selectReviewType(six, rules);
  assert.equal(sel.review_type, "waived"); assert.equal(sel.project_type_code, "V"); assert.equal(sel.cpm_required, false);
  const t = runProjectTests(six, rules, D("2026-10-05"), sel);
  assert.equal(t.result, "eligible");
  assert.ok(t.tests.some((x) => x.rule === "ineligible_characteristics" && x.outcome === "pass"), "B4-2.1-02 basic requirements still run");
  assert.ok(!t.tests.some((x) => x.rule === "reserves"), "no Full Review tests on a waived project");
  const condotel = runProjectTests({ ...six, ineligible_characteristics: { condotel: true } }, rules, D("2026-10-05"));
  assert.equal(condotel.result, "ineligible"); assert.match(condotel.ineligible_reasons[0]!, /condo hotel or motel/);
  const master = selectReviewType({ ...six, part_of_master_association: true }, rules);
  assert.equal(master.review_type, "full_cpm"); assert.equal(master.project_type_code, "S"); assert.equal(master.cpm_required, true);
  assert.match(master.reason, /part of a Master Association, the project must be reviewed under the Full Review process/);
  assert.equal(selectReviewType({ ...six, units_total: 11, units_conveyed: 11 }, rules).review_type, "full_cpm", "eleven attached units → Full Review");
  assert.equal(selectReviewType({ ...six, units_total: 40, unit_detached: true }, rules).review_type, "waived", "detached unit → waiver");
});

test("24.3-T5: Given an application dated Jul 31, 2026 in a Limited-Review-eligible project, then `limited_legacy` is allowed; dated Aug 3, 2026 → not allowed.", () => {
  const facts: ProjectFacts = { ...PHOENIX("A"), requested_review_type: "limited_legacy" };
  const before = resolveRules(D("2026-07-31"));
  assert.equal(before.limited_review_allowed, true); assert.deepEqual(before.switches_applied, []); assert.equal(before.rule_set_version, "fnma.selling.2026-09-02");
  const legacy = selectReviewType(facts, before);
  assert.equal(legacy.review_type, "limited_legacy"); assert.equal(legacy.cpm_required, false); assert.match(legacy.reason, /2026-07-31 < 2026-08-03/);
  const on = resolveRules(D("2026-08-03"));
  assert.equal(on.limited_review_allowed, false); assert.equal(on.switches_applied.find((s) => s.key === "limited_review_retired")!.effective_from, "2026-08-03");
  const retired = selectReviewType(facts, on);
  assert.equal(retired.review_type, "full_cpm"); assert.match(retired.reason, /application dates on or after August 3, 2026, are not eligible for sale to Fannie Mae under the Limited Review process/);
  assert.equal(FNMA_SELLING_2026_09_02.switches.find((s) => s.key === "limited_review_retired")!.effective_from, "2026-08-03", "the date is rule-set data");
});

test("24.3-T6: Given the C5 appraisal in R5 with a safety-related deck item, then the deck cannot enter a holdback, delivery is blocked until the Completion Report (received Nov 16, 2026) is accepted, and the paint item produces `escrow_cents = 384,000` with `completion_due_on = 2027-05-17`.", () => {
  const h = harness("2026-10-30T15:00:00.000Z", "app-cmh-purchase");
  const rules = resolveRules(D("2026-10-19"));
  const route = routeCondition({ condition_rating: "C5", quality_rating: "Q4", as_is_or_subject_to: "subject_to", deficiencies: [DECK, PAINT] });
  assert.equal(route.result, "eligible_with_conditions");
  assert.equal(route.repairs.find((r) => r.item === DECK.item)!.path, "complete_before_sale");
  assert.equal(route.repairs.find((r) => r.item === PAINT.item)!.path, "holdback");
  assert.throws(() => assertHoldbackEligible([DECK]), (e: unknown) => e instanceof HoldbackRefused && e.code === "SAFETY_ITEM_NOT_POSTPONABLE");
  assert.deepEqual(planRepairs([{ ...PAINT, in_sales_contract: false }], { subject_to: true }).map((r) => r.path), ["complete_before_sale"], "a non-contract item is not a postponed improvement");
  // 24.1's valuation.received carries the ratings; R1+R2 → property.repair.required{safety_related=true} arms the delivery gate.
  h.events.append({ type: "valuation.received", applicationId: "app-cmh-purchase", actor: APPRAISER, payload: { application_id: "app-cmh-purchase", order_id: "val-cmh-1", condition_rating: "C5", quality_rating: "Q4", as_is_or_subject_to: "subject_to", deficiencies: [DECK, PAINT] } });
  const pe = runPropertyEligibility(h.events, { application_id: "app-cmh-purchase", facts: { units: 1, property_type: "sfr" }, transaction_type: "purchase", rules }, h.clock.now());
  assert.equal(pe.review.condition_rating, "C5"); assert.equal(pe.review.valuation_id, "val-cmh-1"); assert.equal(pe.review.result, "eligible_with_conditions");
  const safetyGate = h.timer("FNMA_B4_1_3_06_SAFETY_REPAIR_BEFORE_SALE_GATE")!, deliveryGate = h.timer("FNMA_B4_1_2_05_COMPLETION_BEFORE_DELIVERY_GATE")!;
  assert.equal(safetyGate.status, "armed"); assert.equal(deliveryGate.status, "armed");
  const facts = { subject_to: true, repairs: pe.review.repairs.filter((r) => r.path === "complete_before_sale").map((r) => ({ ...r, completed: false })) };
  assert.equal(evaluateGate("24.3.safetyRepairBeforeSaleGate", facts).open, false);
  assert.match(evaluateGate("24.3.completionBeforeDeliveryGate", facts).reason!, /delivery blocked \(29\.4\)/);
  // Seller repairs the deck Fri Nov 13; the UAD 3.6 Completion Report arrives Mon Nov 16 → both gates satisfied.
  h.at("2026-11-16T15:00:00.000Z");
  const done = acceptRepairCompletion(h.events, { application_id: "app-cmh-purchase", item: DECK.item, safety_related: true, evidence: { kind: "uad36_completion_report", document_id: "doc-1004d-1", received_at: "2026-11-16T15:00:00.000Z", resulting_condition_rating: "C5" } }, h.clock.now());
  assert.equal(done.accepted, true); assert.equal(safetyGate.status, "satisfied"); assert.equal(deliveryGate.status, "satisfied");
  assert.equal(evaluateGate("24.3.safetyRepairBeforeSaleGate", { repairs: [{ item: DECK.item, safety_related: true, completed: true, evidence_accepted: true }] }).open, true);
  // Paint: estimate 320,000 cents, no fixed-price contract → 120% = 384,000; note date Wed Nov 18, 2026 + 180 days = Mon May 17, 2027.
  const calc = computeHoldback({ estimate_cents: 320_000n, fixed_price_contract: false, note_date: D("2026-11-18") });
  assert.equal(calc.escrow_cents, 384_000n); assert.equal(calc.completion_due_on, "2027-05-17"); assert.equal(ceilDiv(320_000n * 12_000n, 10_000n), 384_000n);
  assert.equal(computeHoldback({ estimate_cents: 320_000n, fixed_price_contract: true, contract_cents: 350_000n, note_date: D("2026-11-18") }).escrow_cents, 350_000n, "guaranteed fixed price → the contract price");
  h.at("2026-11-18T21:00:00.000Z");
  const est = establishHoldback(h.events, { application_id: "app-cmh-purchase", loan_id: "loan-cmh-1", kind: "postponed_existing_minor", items: [PAINT], estimate_cents: 320_000n, fixed_price_contract: false, note_date: D("2026-11-18"), custodial_account_id: "cust-holdback-1", funded_at: "2026-11-18T21:00:00.000Z", rules }, h.clock.now());
  assert.equal(est.holdback.escrow_cents, 384_000n); assert.equal(est.holdback.completion_due_on, "2027-05-17"); assert.equal(est.holdback.status, "established");
  const set = fundHoldback(h.ledger, est.holdback, "loan-cmh-1", "cust-ti-prepurchase", D("2026-11-18"), h.clock.now(), est.event.id);
  assert.equal(set.lines.length, 2); assert.equal(h.ledger.balance(holdbackEscrowAccount("loan-cmh-1")), -384_000n); assert.equal(h.ledger.balance(prepurchaseTiCash("cust-ti-prepurchase")), 384_000n);
  const clock180 = h.timer("FNMA_B4_1_2_05_HOLDBACK_COMPLETION_180")!;
  assert.equal(clock180.dueDate, "2027-05-17"); assert.equal(clock180.anchorDate, "2026-11-18");
  // Fri Apr 9, 2027: borrower attestation with geocoded, time-stamped photos → holdback.completed; final draw due by Fri Apr 16 (5 business_days_servicer); released Apr 16.
  h.at("2027-04-09T16:00:00.000Z");
  assert.throws(() => releaseFinalDraw(h.events, est.holdback, { released_at: h.clock.now() }), (e: unknown) => e instanceof HoldbackRefused && e.code === "RELEASE_WITHOUT_EVIDENCE");
  assert.throws(() => acceptCompletionEvidence(h.events, est.holdback, { kind: "attestation_letter_with_evidence", document_id: "doc-att-0", received_at: h.clock.now(), exhibits_geocoded: false }, h.clock.now()), (e: unknown) => e instanceof HoldbackRefused && e.code === "EVIDENCE_NOT_ACCEPTABLE");
  const comp = acceptCompletionEvidence(h.events, est.holdback, { kind: "attestation_letter_with_evidence", document_id: "doc-att-1", received_at: "2027-04-09T16:00:00.000Z", exhibits_geocoded: true, exhibits_metadata: true }, h.clock.now());
  assert.equal(comp.holdback.status, "completed"); assert.equal(comp.final_draw_due_on, "2027-04-16"); assert.equal(finalDrawDueOn(D("2027-04-09")), "2027-04-16");
  assert.equal(clock180.status, "satisfied");
  const draw = h.timer("SM_HOLDBACK_FINAL_DRAW_5BD")!; assert.equal(draw.dueDate, "2027-04-16");
  h.at("2027-04-16T16:00:00.000Z");
  const rel = releaseFinalDraw(h.events, comp.holdback, { released_at: h.clock.now(), ledger: h.ledger, prepurchase_ti_account_id: "cust-ti-prepurchase" });
  assert.equal(rel.holdback.status, "released"); assert.equal(rel.entry_set!.lines[0]!.amountCents, 384_000n); assert.equal(h.ledger.balance(holdbackEscrowAccount("loan-cmh-1")), 0n);
  assert.equal(draw.status, "satisfied");
});

test("24.3-T7: Given a C6 rating, then `result = ineligible` until a \"subject to\" appraisal and completion evidence show ≥ C5; given Q6 with no safety items, then eligible.", () => {
  const c6 = routeCondition({ condition_rating: "C6", quality_rating: "Q3", as_is_or_subject_to: "as_is", deficiencies: [{ item: "collapsed porch roof", safety_related: true }] });
  assert.equal(c6.result, "ineligible"); assert.match(c6.reasons[0]!, /condition rating of C6 are not eligible for sale to Fannie Mae/); assert.equal(c6.subject_to_required, true);
  const partial = routeCondition({ condition_rating: "C6", as_is_or_subject_to: "subject_to", deficiencies: [{ item: "collapsed porch roof", safety_related: true }], completion: { subject_to_appraisal_received: true, completion_evidence_accepted: false, resulting_condition_rating: null } });
  assert.equal(partial.result, "ineligible", "a 'subject to' appraisal alone does not lift C6");
  const repaired = routeCondition({ condition_rating: "C6", as_is_or_subject_to: "subject_to", deficiencies: [{ item: "collapsed porch roof", safety_related: true }], completion: { subject_to_appraisal_received: true, completion_evidence_accepted: true, resulting_condition_rating: "C5" } });
  assert.equal(repaired.result, "eligible");
  const stillC6 = routeCondition({ condition_rating: "C6", as_is_or_subject_to: "subject_to", deficiencies: [], completion: { subject_to_appraisal_received: true, completion_evidence_accepted: true, resulting_condition_rating: "C6" } });
  assert.equal(stillC6.result, "ineligible", "completion evidence must show ≥ C5");
  const q6 = routeCondition({ condition_rating: "C4", quality_rating: "Q6", as_is_or_subject_to: "as_is", deficiencies: [] });
  assert.equal(q6.result, "eligible"); assert.match(q6.reasons[0]!, /Q6 'eligible for sale to Fannie Mae provided any items affecting safety, soundness, or structural integrity are repaired'/);
  const q6Safety = routeCondition({ condition_rating: "C4", quality_rating: "Q6", as_is_or_subject_to: "subject_to", deficiencies: [{ item: "exposed wiring", safety_related: true }] });
  assert.equal(q6Safety.result, "eligible_with_conditions"); assert.equal(q6Safety.repairs[0]!.path, "complete_before_sale");
  const c5 = routeCondition({ condition_rating: "C5", as_is_or_subject_to: "as_is", deficiencies: [{ item: "worn carpet", safety_related: false }] });
  assert.equal(c5.result, "eligible", "C5 is eligible as-is when the deficiencies are minor"); assert.equal(c5.repairs[0]!.path, "none");
});

test("24.3-T8: Given a leasehold with lease expiry Dec 31, 2061 and loan maturity Dec 1, 2056, then the lease-term test passes (≥ 5 years); expiry Nov 30, 2061 → fails.", () => {
  const pass = leaseTermTest(D("2061-12-31"), D("2056-12-01"));
  assert.equal(pass.pass, true); assert.equal(pass.required_through, "2061-12-01"); assert.equal(pass.margin_years, 5);
  const fail = leaseTermTest(D("2061-11-30"), D("2056-12-01"));
  assert.equal(fail.pass, false);
  assert.equal(leaseTermTest(D("2061-12-01"), D("2056-12-01")).pass, true, "exactly five years passes ('five (5) years or more')");
  const rules = resolveRules(D("2026-10-05"));
  const h = harness("2026-10-05T16:00:00.000Z", "app-leasehold");
  const good = runPropertyEligibility(h.events, { application_id: "app-leasehold", facts: { units: 1, property_type: "sfr", leasehold: { lease_expiry: D("2061-12-31"), recorded: true, assignable_unlimited: true, lender_cure_rights_30d: true }, loan_maturity_date: D("2056-12-01") }, ratings: null, rules }, h.clock.now());
  assert.equal(good.review.property_class, "leasehold"); assert.equal(good.review.result, "eligible"); assert.equal(good.review.checks.find((c) => c.rule === "leasehold_term")!.outcome, "pass");
  const bad = runPropertyEligibility(h.events, { application_id: "app-leasehold", facts: { units: 1, property_type: "sfr", leasehold: { lease_expiry: D("2061-11-30"), recorded: true, assignable_unlimited: true, lender_cure_rights_30d: true }, loan_maturity_date: D("2056-12-01") }, ratings: null, rules }, h.clock.now());
  assert.equal(bad.review.result, "ineligible"); assert.match(bad.review.ineligible_reasons[0]!, /less than five years after loan maturity/);
});

test("24.3-T9: Given a manufactured home built May 1, 1976, then ineligible; built Jul 1, 1976 with labels reported and affidavit of affixture, MH Advantage sticker verified → eligible with SFC 859.", () => {
  const base = { hud_label_numbers: ["PFS0123456", "PFS0123457"], data_plate_document_id: "doc-plate-1", width: "multi" as const, occupancy: "primary" as const, real_property_evidence_document_id: "doc-affixture-1", foundation_cert_document_id: "doc-found-1", mh_advantage: true, mh_advantage_sticker_verified: true, site_built_features_verified: true, alta_7: true };
  const old = verifyMhFacts({ ...base, built_on: D("1976-05-01") });
  assert.equal(old.result, "ineligible"); assert.match(old.ineligible_reasons[0]!, /built 1976-05-01 — before the HUD Code \(1976-06-15\)/);
  const ok = verifyMhFacts({ ...base, built_on: D("1976-07-01") });
  assert.equal(ok.result, "eligible"); assert.deepEqual(ok.special_feature_codes, [SFC_MH_ADVANTAGE]); assert.deepEqual(ok.special_feature_codes, ["859"]);
  assert.deepEqual(verifyMhFacts({ ...base, built_on: D("1976-07-01"), mh_advantage_sticker_verified: false, choicehome_label: false }).special_feature_codes, [], "no sticker → standard MH (no SFC 859)");
  assert.equal(verifyMhFacts({ ...base, built_on: D("1976-07-01"), hud_label_numbers: [], data_plate_document_id: null }).result, "ineligible", "labels missing and no verification letter");
  assert.equal(verifyMhFacts({ ...base, built_on: D("1976-07-01"), hud_label_numbers: [], data_plate_document_id: null, label_verification_letter_document_id: "doc-ibts-1" }).result, "eligible");
  assert.equal(verifyMhFacts({ ...base, built_on: D("1976-07-01"), width: "single", occupancy: "second_home" }).result, "ineligible", "second home requires multi-width");
  // Gate: an MH property arms SM_MH_LABEL_VERIFICATION_GATE; mh.verification.completed{result=eligible} satisfies it.
  const h = harness("2026-10-05T16:00:00.000Z", "app-mh");
  const rules = resolveRules(D("2026-10-05"));
  runPropertyEligibility(h.events, { application_id: "app-mh", facts: { units: 1, property_type: "manufactured", mh_advantage: true }, ratings: null, rules }, h.clock.now());
  const gate = h.timer("SM_MH_LABEL_VERIFICATION_GATE")!; assert.equal(gate.status, "armed");
  assert.equal(evaluateGate("24.3.mhLabelVerificationGate", { hud_label_numbers: [], data_plate_document_id: null }).open, false);
  const v = verifyMh(h.events, "app-mh", { ...base, built_on: D("1976-07-01") }, h.clock.now(), rules);
  assert.equal(v.event.payload.result, "eligible"); assert.deepEqual(v.event.payload.special_feature_codes, ["859"]); assert.equal(gate.status, "satisfied");
  assert.equal(evaluateGate("24.3.mhLabelVerificationGate", { hud_label_numbers: base.hud_label_numbers, data_plate_document_id: "doc-plate-1", real_property_evidence_document_id: "doc-affixture-1" }).open, true);
});

test("24.3-T10: Given a 1-unit purchase with a permitted ADU leased at 150,000 cents/month and total qualifying income of 1,000,000 cents/month, then usable ADU rent = min(112,500, 300,000) = 112,500 cents; on a cash-out refinance, ADU rent is not usable.", () => {
  const purchase = aduRentUsable({ transaction_type: "purchase", adu_permitted: true, lease_cents: 150_000n, total_qualifying_income_cents: 1_000_000n, form_1007_or_1025: true, lease_executed: true });
  assert.equal(purchase.usable, true); assert.equal(purchase.net_rent_cents, 112_500n); assert.equal(purchase.cap_cents, 300_000n); assert.equal(purchase.usable_cents, 112_500n);
  const capped = aduRentUsable({ transaction_type: "limited_cash_out", adu_permitted: true, lease_cents: 500_000n, total_qualifying_income_cents: 1_000_000n });
  assert.equal(capped.usable_cents, 300_000n, "75% × 500,000 = 375,000 is capped at 30% of qualifying income");
  const cashOut = aduRentUsable({ transaction_type: "cash_out", adu_permitted: true, lease_cents: 150_000n, total_qualifying_income_cents: 1_000_000n });
  assert.equal(cashOut.usable, false); assert.equal(cashOut.usable_cents, 0n); assert.match(cashOut.reason, /Purchase or limited cash-out refinance transactions only/);
  const h = harness("2026-11-02T16:00:00.000Z", "app-adu");
  const rules = resolveRules(D("2026-11-02"));
  assert.equal(rules.adu_rental_rules_mandatory, true);
  const kitchen = { cabinets: true, countertop: true, sink_running_water: true, stove_or_hookup: true };
  const pe = runPropertyEligibility(h.events, { application_id: "app-adu", facts: { units: 1, property_type: "sfr", adu: { count: 1, kitchen, permitted: true } }, ratings: null, transaction_type: "purchase", rules }, h.clock.now());
  assert.equal(pe.review.property_class, "sfr", "a one-unit property with an ADU is a one-unit property"); assert.equal(pe.review.adu_rent_usable, true); assert.equal(pe.review.result, "eligible");
  const co = runPropertyEligibility(h.events, { application_id: "app-adu", facts: { units: 1, property_type: "sfr", adu: { count: 1, kitchen, permitted: true } }, ratings: null, transaction_type: "cash_out", rules }, h.clock.now());
  assert.equal(co.review.adu_rent_usable, false);
  const duplex = runPropertyEligibility(h.events, { application_id: "app-adu", facts: { units: 2, property_type: "2_4_unit", adu: { count: 1, kitchen, permitted: true } }, ratings: null, transaction_type: "purchase", rules }, h.clock.now());
  assert.equal(duplex.review.result, "ineligible"); assert.match(duplex.review.ineligible_reasons[0]!, /ADU with a two- to four-unit dwelling/);
});

test("24.3-T11: Given a holdback established Nov 18, 2026 with no completion by May 17, 2027, then `holdback.overdue` fires May 18, 2027 with an `officer` escalation.", () => {
  const h = harness("2026-11-18T21:00:00.000Z", "app-cmh-purchase");
  const est = establishHoldback(h.events, { application_id: "app-cmh-purchase", loan_id: "loan-cmh-1", kind: "postponed_existing_minor", items: [PAINT], estimate_cents: 320_000n, fixed_price_contract: false, note_date: D("2026-11-18") }, h.clock.now());
  assert.equal(est.holdback.completion_due_on, "2027-05-17");
  const holdbacks: EscrowHoldback[] = [est.holdback];
  h.at("2027-05-17T23:00:00.000Z");
  const onDue = sweepHoldbacks(h.events, h.rt.escalations, holdbacks, D("2027-05-17"), h.clock.now());
  assert.equal(onDue.overdue.length, 0, "day 180 itself is not overdue"); assert.equal(h.timers.evaluate("2027-05-17T23:00:00.000Z").length, 0);
  h.at("2027-05-18T09:00:00.000Z");
  const sweep = sweepHoldbacks(h.events, h.rt.escalations, holdbacks, D("2027-05-18"), h.clock.now());
  assert.equal(sweep.overdue.length, 1); assert.equal(sweep.overdue[0]!.status, "overdue");
  const ev = h.events.ofType("holdback.overdue").at(-1)!;
  assert.equal(ev.payload.overdue_on, "2027-05-18"); assert.equal(ev.payload.completion_due_on, "2027-05-17"); assert.equal(ev.payload.days_overdue, 1); assert.equal(ev.payload.qc_self_report_assessment, "28.4"); assert.equal(ev.loanId, "loan-cmh-1");
  const esc = h.rt.escalations.list().find((e) => e.id === sweep.escalation_ids[0])!;
  assert.equal(esc.kind, "officer"); assert.equal(esc.ownerRole, "officer"); assert.equal(esc.severity, "sev1"); assert.equal(esc.applicationId, "app-cmh-purchase");
  // The registry deadline breaches the same morning: sev 1 → officer.
  const breaches = h.timers.evaluate("2027-05-18T09:00:00.000Z");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "FNMA_B4_1_2_05_HOLDBACK_COMPLETION_180"); assert.equal(breaches[0]!.severity, 1); assert.deepEqual(breaches[0]!.escalateTo, ["officer"]);
  assert.equal(sweepHoldbacks(h.events, h.rt.escalations, sweep.overdue, D("2027-05-19"), h.clock.now()).overdue.length, 0, "an overdue holdback is not re-escalated");
});

test("24.3-T12: Given CPM status \"Unavailable\" recorded by the operator, then `result = ineligible` regardless of the lender's own analysis.", async () => {
  const h = harness("2026-10-05T16:00:00.000Z");
  const rules = resolveRules(D("2026-10-05"));
  const facts = PHOENIX("A");
  const r = await h.run("runProjectEligibility", { facts, application_date: "2026-10-05" });
  assert.equal(r.result, "eligible", "the lender's own analysis passes every test"); assert.equal((r.review as { status: string }).status, "cpm_entry_pending");
  await assert.rejects(h.run("recordCpmResult", { cpm_status: "unavailable" }, AGENT), (e: unknown) => e instanceof CommandRefused && e.code === "HUMAN_ONLY", "the agent never keys or records CPM");
  await assert.rejects(h.run("recordCpmResult", { cpm_status: "unavailable" }, { kind: "human", id: "u-uw", role: "underwriting_reviewer" }), (e: unknown) => e instanceof CommandRefused && e.code === "ROLE_DENIED");
  h.at("2026-10-09T18:00:00.000Z");
  const rec = await h.run("recordCpmResult", { cpm_status: "unavailable", cpm_project_id: "123456", comments: "Unavailable — see CPM comments", note_date: "2026-11-06" }, OPERATOR);
  assert.equal(rec.result, "ineligible"); assert.equal(rec.status, "ineligible");
  const snap = h.events.ofType("project.cpm.status.recorded").at(-1)!;
  assert.equal(snap.payload.cpm_status, "unavailable"); assert.equal(snap.payload.recorded_by, "human:u-cpm"); assert.equal(snap.actor.role, "fnma_portal_operator");
  assert.match(String(h.events.ofType("project.ineligible.determined").at(-1)!.payload.reason), /CPM status Unavailable — B4-2.1-03: ineligible for purchase regardless of the lender's own analysis/);
  const gate = h.timer("FNMA_B4_2_1_01_CPM_CERT_VALID_GATE")!; assert.equal(gate.status, "armed");
  assert.equal(evaluateGate("24.3.cpmCertValidGate", { cpm_status: "unavailable", cpm_cert_expires_on: null, note_date: "2026-11-06" }).open, false);
  assert.equal(evaluateGate("24.3.cpmCertValidGate", { cpm_status: "lender_certified", cpm_cert_expires_on: "2026-11-05", note_date: "2026-11-06" }).open, false, "expired before the note date");
  const consummate = await h.run("runProjectEligibility", { op: "consummate", note_date: "2026-11-06" });
  assert.equal(consummate.open, false); assert.match(String(consummate.reason), /CPM status Unavailable/);
  // The officer may request PERS; the agent's fileEscalation routes it to the officer only.
  const esc = await h.run("fileEscalation", { kind: "officer", reason: "pers_submission" });
  assert.equal(esc.owner_role, "officer"); assert.equal(esc.sla, "+5 business_days_creditor");
  await assert.rejects(h.run("fileEscalation", { kind: "human_agent", reason: "pers_submission" }), (e: unknown) => e instanceof CommandRefused && e.code === "PERS_IS_OFFICER_REQUEST");
  await assert.rejects(h.run("prepareCpmSheet", { facts, submit_to_cpm: true }), (e: unknown) => e instanceof CommandRefused && e.code === "CPM_NEVER_KEYED_BY_AGENT");
  // The decision record carries the ineligibility with the dated rule set.
  const d = await h.run("writeDecision", { application_date: "2026-10-05", model_version: "m1", prompt_version: "p1", confidence: 0.99 });
  assert.equal((d.project as { status: string }).status, "ineligible"); assert.equal(h.decisions.find((x) => x.action === "24.3.eligibility")!.ruleSetVersion, rules.rule_set_version); assert.equal(h.decisions.find((x) => x.action === "24.3.eligibility")!.modelVersion, "m1");
});

test("24.3 worked figures: R4 Phoenix special assessment and reserves, R5 Columbus holdback", () => {
  // R4: 40 × 240,000 = 9,600,000 cents; 12 installments of 20,000 from Oct 1, 2026; annual income 40 × 72,000 = 28,800,000; allocation 3,000,000 → 10.42%; 15% floor = 4,320,000; $10,000/unit unfunded trigger.
  const sa = PHOENIX("A").special_assessments![0]!;
  assert.equal(sa.original_cents, 9_600_000n); assert.equal(40n * sa.per_unit_cents, 9_600_000n); assert.equal(sa.per_unit_cents, 240_000n); assert.equal(12n * sa.monthly_installment_cents!, 240_000n); assert.equal(sa.monthly_installment_cents, 20_000n);
  // Spec discrepancy: R4 writes "40 × 72,000 = 28,800,000 cents" — 40 × 72,000 is 2,880,000; the 10.42% ratio the spec carries through needs 28,800,000 cents ($288,000/yr = $7,200 = 720,000 cents per unit), so the per-unit figure is the typo.
  assert.equal(40n * 720_000n, 28_800_000n); assert.notEqual(40n * 72_000n, 28_800_000n);
  assert.deepEqual(reservePct(3_000_000n, 28_800_000n), { reserve_pct: 0.1042, bp10k: 1042 });
  assert.equal(requiredReserveCents(28_800_000n, 1000), 2_880_000n); assert.equal(requiredReserveCents(28_800_000n, 1500), 4_320_000n);
  assert.equal(FNMA_SELLING_2026_09_02.constants.unfunded_repair_per_unit_cents, 1_000_000n);
  const unfunded = runProjectTests({ ...PHOENIX("A"), unfunded_repairs_per_unit_cents: 1_000_001n }, resolveRules(D("2026-10-05")), D("2026-10-05"));
  assert.equal(unfunded.critical_repairs.length, 1); assert.equal(unfunded.result, "ineligible");
  // R5: $412,000 loan; estimate 320,000 → escrow 384,000; due 2027-05-17; final draw by 2027-04-16 after Apr 9 evidence.
  assert.equal(41_200_000n, 412_000n * 100n);
  const calc = computeHoldback({ estimate_cents: 320_000n, fixed_price_contract: false, note_date: D("2026-11-18") });
  assert.equal(calc.escrow_cents, 384_000n); assert.equal(calc.completion_due_on, "2027-05-17"); assert.equal(finalDrawDueOn(D("2027-04-09")), "2027-04-16");
  assert.equal(computeHoldback({ estimate_cents: 100_001n, fixed_price_contract: false, note_date: D("2026-11-18") }).escrow_cents, 120_002n, "ceil(100,001 × 1.20) = 120,001.2 → 120,002");
  // T10: 75% × 150,000 = 112,500; 30% × 1,000,000 = 300,000.
  const adu = aduRentUsable({ transaction_type: "purchase", adu_permitted: true, lease_cents: 150_000n, total_qualifying_income_cents: 1_000_000n });
  assert.equal(adu.net_rent_cents, 112_500n); assert.equal(adu.cap_cents, 300_000n);
});
