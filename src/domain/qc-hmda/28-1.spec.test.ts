// 28.1 Prefunding quality control program (selection, review scope, reverifications, defect handling before closing, reporting)
// spec/sections/28-quality-control-hmda-and-fraud-aml-reporting/28-1-prefunding-quality-control-program-selection-review-scope-re.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_28_1 } from "../../app/tools/section28-1.ts";
import { TOOLS_23_3 } from "../../app/tools/section23-3.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { runCtcChecklist, reopenCondition, prefundingReviewStatus, prefundingQcGate, SM_QC_PREFUNDING_HOLD, DecisionRefused, type CtcFacts, type CtcItemCode } from "../underwriting/ops-23-3.ts";
import type { Condition } from "../underwriting/ops-23-2.ts";
import { buildPopulation, planSample, randomTarget, allocateStrata, acceptanceProbability, riskTriggers, reviewScope, selectLoan, openReview, completeReview, closeReview, consummatedWithOpenReview, deliveryGateFacts, assertGateOpen, reviewGateStatus, qcPrefundingStatus, recomputeDuInputs, recomputeIncome, checkVvoe, recomputeAssets, checkCollateral, checkMi, requiredMiCoveragePct, assessOccupancy, checkSsn, runComplianceSnapshot,
  orderReverification, reverificationFollowUp, officerDecideReverification, draftFinding, routeToOfficer, officerDecideFinding, releaseFindings, recordFindingResolution, correctFinding, resolveByDuResubmission, earliestConsummation, computeMetrics, sampleCompletion, reportDue, correctiveActionPlan, draftMonthlyReport, signReport, officerConcurrenceReview, decisionRecord28_1, assertQcIdentity, assertNotProductionCommand, variancePct, money, QcRefused, QC_AGENT, RULE_SETS_28_1, RULE_SET_VERSION_28_1,
  type QcReview, type QcFinding, type QcSamplePlan, type ChecklistTest, type MonthlyMetrics, type RiskFeatures } from "./ops-28-1.ts";

const UW: Actor = { kind: "agent", id: "underwriter" };
const OFFICER: Actor = { kind: "human", id: "u-qc-1", role: "qc_officer" };
const PARTNER_OFFICER: Actor = { kind: "human", id: "u-officer-1", role: "officer" };
const REFI = "APP-REFI-560K", PURCHASE = "APP-PURCH-412K", PARTNER = "PARTNER-1";
const toolKey = (process: string, name: string): string => `${process} ${name}`;
/** An entity store that logs every read by kind — the access log T13 audits (zero `applicant_demographics` reads by `qc-audit`). */
class LoggedStore extends EntityStore {
  readonly reads: string[] = [];
  override get(kind: string, id: string) { this.reads.push(kind); return super.get(kind, id); }
  override list(kind: string, where?: (d: Record<string, unknown>) => boolean) { this.reads.push(kind); return where ? super.list(kind, where) : super.list(kind); }
}
/** The 28.1 bus: TOOLS_28_1 bound to `qc-audit` (and TOOLS_23_3 to `underwriter`, for the identity tests) over the overridden registry; the application-scoped unit of work stamps `applicationId` on every event. */
function harness(applicationId: string, nowIso: string, processes: string[] = ["28.1", "23.3"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes });
  const escalations = new EscalationService(events, clock); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const store = new LoggedStore();
  const rt: ToolRuntime = { store, escalations, services: {}, ports: {} };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const agents = new AgentRegistry(); const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of [...TOOLS_28_1, ...TOOLS_23_3]) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = QC_AGENT, process = "28.1"): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey(process, name))!, actor, { application_id: applicationId, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  return { clock, events, timers, escalations, rt, store, uow, run, at, timer, ofType, decisions };
}
const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
const refusedBy = (fn: () => unknown, code: string): void => { try { fn(); } catch (e) { assert.ok(e instanceof QcRefused, `expected QcRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return; } assert.fail(`expected QcRefused ${code}`); };

/** October 2026 plan: 118 eligible closings; forecast 240 → random target 12 (worked example 1's "12-loan October target"). */
const octoberPlan = (h: ReturnType<typeof harness>): QcSamplePlan => planSample(h.events, { partner_id: PARTNER, period_month: D("2026-10-01"), eligible_population: 118, forecast_closings_month: 240, strata: [{ key: "refi_trigger|refinance|primary", volume: 70 }, { key: "organic|purchase|primary", volume: 40 }, { key: "referral|purchase|second_home", volume: 8 }], at: "2026-10-01T13:00:00.000Z" }).plan;
const novemberPlan = (h: ReturnType<typeof harness>): QcSamplePlan => planSample(h.events, { partner_id: PARTNER, period_month: D("2026-11-01"), eligible_population: 96, forecast_closings_month: 180, strata: [{ key: "organic|purchase|primary", volume: 60 }, { key: "refi_trigger|refinance|primary", volume: 36 }], at: "2026-11-01T13:00:00.000Z" }).plan;
const REFI_FEATURES: RiskFeatures = { dti_bps: 3800, ltv_x100: 7000, occupancy: "primary", transaction_type: "limited_cash_out", property_type: "sfr", credit_alerts: [] };
const PURCHASE_FEATURES: RiskFeatures = { du_red_flag_message: true, gift_funds_pct_of_funds_to_close: 62, ltv_x100: 9000, dti_bps: 4100, occupancy: "primary", transaction_type: "purchase" };
/** Worked example 1: the refinance fixture selected by the Oct 28 06:00 MST draw (13:00Z): 7 of 12 remaining, 96 expected → 0.073; draw 0.041. */
const selectRefi = (h: ReturnType<typeof harness>, plan: QcSamplePlan) => { h.at("2026-10-28T13:00:12.000Z"); return selectLoan(h.events, { plan, application_id: REFI, features: REFI_FEATURES, at: "2026-10-28T13:00:12.000Z", random_target_remaining: 7, expected_remaining_population: 96, draw: 0.041 }); };
/** Worked example 2: the purchase fixture selected Mon Nov 9 06:00 EST (11:00Z) by `du_red_flag_message` and `gift_funds_pct > 50%`. */
const selectPurchase = (h: ReturnType<typeof harness>, plan: QcSamplePlan) => { h.at("2026-11-09T11:00:00.000Z"); return selectLoan(h.events, { plan, application_id: PURCHASE, features: PURCHASE_FEATURES, at: "2026-11-09T11:00:00.000Z", random_target_remaining: 5, expected_remaining_population: 60, draw: 0.5 }); };
const RUN = { run_id: "qc-run-1", model_version: "qc-audit-2026.09", prompt_version: "28.1-v1" };
const inReview = (h: ReturnType<typeof harness>, review: QcReview, at: string): QcReview => openReview(h.events, h.escalations, review, { run: RUN, reviewer: QC_AGENT, application_agent_runs: [{ agent_id: "underwriter", run_id: "uw-run-1" }, { agent_id: "verification", run_id: "vf-run-3" }], at }).review;
const ctcAllPass = (except: Partial<Record<CtcItemCode, { status: "pass" | "fail" | "waived" | "n/a" }>> = {}): CtcFacts => {
  const codes: CtcItemCode[] = ["CTC_DU_FINAL_MATCH", "CTC_PTD_ALL_CLEARED", "CTC_NO_OPEN_INVESTIGATION", "CTC_CREDIT_VALID", "CTC_DU_CLOSE_BY", "CTC_ASSETS_CASH_TO_CLOSE", "CTC_VALUATION", "CTC_PROPERTY_PROJECT", "CTC_TITLE", "CTC_INSURANCE_FLOOD", "CTC_MI", "CTC_COMPLIANCE", "CTC_EDUCATION", "CTC_LOCK", "CTC_IDENTITY_OFAC", "CTC_QC_PREFUNDING", "CTC_MLO_APPROVALS", "CTC_REGB_TIMING", "CTC_DECISION_VALID"];
  return Object.fromEntries(codes.map((c) => [c, except[c] ?? { status: c === "CTC_MI" || c === "CTC_EDUCATION" ? "n/a" : "pass" }])) as CtcFacts;
};
const clearedCondition = (application_id: string, condition_id: string, template_code: string, category: Condition["category"]): Condition => ({ condition_id, application_id, borrower_id: "B1", source: "du", stage: "ptd", status: "cleared", template_code, du_message_id: "DU-MSG-1", du_submission_id: "SUB-2", text: "Please provide the requested documentation.", internal_text: `DU ${template_code}`, category, evidence_kinds: ["document"], auto_clear_rule: null, requires_role: null, opened_at: "2026-10-21T15:00:00.000Z", due_at: null, cleared_at: "2026-11-04T15:00:00.000Z", cleared_by: "verification", clear_evidence_document_ids: ["doc-old"], superseded_by_condition_id: null, superseded_by_submission_id: null, qc_sampled: false, borrower_visible: true });
/** Worked example 2's two findings on the purchase fixture: F1 gift letter incomplete (sev 2), F2 large deposit unsourced (sev 1). */
const purchaseFindings = (h: ReturnType<typeof harness>, review: QcReview, at: string): { review: QcReview; f1: QcFinding; f2: QcFinding } => {
  const assets = recomputeAssets({ funds_to_close_cents: 4_532_055n, verified_assets_cents: 4_532_055n, monthly_qualifying_income_cents: 700_000n, deposits: [{ amount_cents: 1_460_000n, on: D("2026-09-30"), sourced: false, note: "bonus" }], gift: { amount_cents: 2_800_000n, amount_stated: true, no_repayment_stated: true, donor_name: "M. Donor", donor_relationship: null, donor_contact: null, document_id: "doc-gift-1" }, integrity_checks_pass: true, evidence_refs: [{ document_id: "doc-stmt-sep" }] });
  const gift = assets.findings.find((f) => f.sub_category === "gift_letter_incomplete")!, dep = assets.findings.find((f) => f.sub_category === "large_deposit_unsourced")!;
  const d1 = draftFinding(h.events, review, { ...gift, at, finding_id: "F1" }); const d2 = draftFinding(h.events, d1.review, { ...dep, at, finding_id: "F2" });
  return { review: d2.review, f1: d1.finding, f2: d2.finding };
};
const officerReleases = (h: ReturnType<typeof harness>, fs: QcFinding[], at: string): QcFinding[] => fs.map((f) => (f.severity <= 2 ? officerDecideFinding(h.events, f, { decision: "released", officer: OFFICER, at, rationale: "concur: evidence supports the finding" }).finding : f));

test("28.1-T1: Given the refinance fixture reaches `ptd_cleared` Tue Oct 27, 2026 and the Oct 28 06:00 MST draw selects it, then a `qc_reviews{kind=prefunding, selection_basis=random}` row exists, `production_hold_applied = true`, 23.3's checklist item `qc_prefunding` fails, and `SM_QC_PREFUNDING_REVIEW_SLA_2BD` is due Fri Oct 30, 2026.", async () => {
  const h = harness(REFI, "2026-10-28T13:00:00.000Z");
  const plan = octoberPlan(h);
  assert.equal(plan.random_target, 12); assert.equal(plan.strata.reduce((a, s) => a + s.quota, 0), 12); assert.ok(plan.strata.every((s) => s.quota >= 1), "every channel represented");
  // rule 1: the population — ptd_cleared Tue Oct 27 16:30 MST is inside the run's trailing 24 hours; a withdrawn file and an already-selected file leave it
  const pop = buildPopulation([{ application_id: REFI, disposition: "conditional_approval", ptd_cleared_at: "2026-10-27T23:30:00.000Z", closing_scheduled_on: D("2026-11-06"), already_selected: false, channel: "refi_trigger", transaction_type: "refinance", occupancy: "primary" },
    { application_id: "APP-W", disposition: "conditional_approval", ptd_cleared_at: "2026-10-27T20:00:00.000Z", closing_scheduled_on: null, already_selected: false, withdrawn_or_denied: true, channel: "organic", transaction_type: "purchase", occupancy: "primary" },
    { application_id: "APP-S", disposition: "approved", ptd_cleared_at: "2026-10-20T20:00:00.000Z", closing_scheduled_on: D("2026-11-03"), already_selected: true, channel: "organic", transaction_type: "purchase", occupancy: "primary" }], "2026-10-28T13:00:00.000Z");
  assert.deepEqual(pop.population.map((p) => p.application_id), [REFI]); assert.equal(pop.population[0]!.reason, "ptd_cleared_24h"); assert.deepEqual(pop.excluded.map((x) => x.why), ["withdrawn_or_denied", "already_selected"]);
  // the draw: no triggers (DTI 38%, LTV 70%, primary), acceptance probability 7 / 96 = 0.073, seeded draw 0.041 < 0.073 → selected `random`, full-file
  assert.deepEqual(riskTriggers(REFI_FEATURES), []); assert.equal(acceptanceProbability(7, 96), 0.073);
  const sel = await h.run("selectLoans", { plan, candidates: [{ application_id: REFI, features: REFI_FEATURES, draw: 0.041 }], random_target_remaining: 7, expected_remaining_population: 96 });
  const s = (sel.selections as Record<string, unknown>[])[0]!;
  assert.equal(s.selected, true); assert.equal(s.basis, "random"); assert.equal(s.probability, 0.073); assert.equal(s.review_type, "full_file"); assert.equal(s.application_qc_status, "hold");
  const review = h.store.get("qc_reviews", s.review_id as string)!.data as unknown as QcReview;
  assert.equal(review.kind, "prefunding"); assert.equal(review.selection_basis, "random"); assert.equal(review.production_hold_applied, true); assert.equal(review.status, "selected"); assert.equal(review.hold_released_at, null); assert.equal(review.selected_at, "2026-10-28T13:00:00.000Z"); assert.equal(review.retention_class, "fnma_qc_3y");
  assert.equal(review.due_at, "2026-10-30"); assert.equal((sel.actuals as { selected: number }).selected, 1);
  // the events 23.3 consumes: qc.hold.applied{kind=prefunding} then qc.review.opened{kind=prefunding} → its derived status is `open`; the checklist item fails
  assert.deepEqual(h.ofType("qc.hold.applied").map((e) => e.payload.kind), ["prefunding"]); assert.equal(h.ofType("qc.review.opened")[0]!.payload.kind, "prefunding"); assert.equal(h.ofType("qc.review.opened")[0]!.applicationId, REFI);
  assert.equal(prefundingReviewStatus(h.events.all()), "open"); assert.equal(reviewGateStatus(review), "open"); assert.equal(assertGateOpen(review).open, false); assert.deepEqual(assertGateOpen(review).blocking_codes, [SM_QC_PREFUNDING_HOLD]);
  const ctc = runCtcChecklist({ application_id: REFI, decision_id: "D-REFI-CA-1", evaluated_at: "2026-10-28T14:00:00.000Z", facts: ctcAllPass(), prefunding_review_status: prefundingReviewStatus(h.events.all()) });
  const item = ctc.items.find((x) => x.code === "CTC_QC_PREFUNDING")!;
  assert.equal(item.status, "fail"); assert.equal(item.item_alias, SM_QC_PREFUNDING_HOLD); assert.equal(item.owner_process, "28.1"); assert.equal(ctc.passed, false); assert.deepEqual(ctc.blocking_codes, ["CTC_QC_PREFUNDING"]);
  // the timers: SM_QC_PREFUNDING_REVIEW_SLA_2BD +2 business_days_creditor from Wed Oct 28 → Fri Oct 30; the prior-to-closing gate armed on qc.review.opened
  const sla = h.timer("SM_QC_PREFUNDING_REVIEW_SLA_2BD")!; assert.equal(sla.status, "armed"); assert.equal(sla.anchorDate, "2026-10-28"); assert.equal(sla.dueDate, "2026-10-30"); assert.equal(sla.applicationId, REFI);
  const gate = h.timer("FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:23.3.prefundingQcGate");
  assert.equal(h.timer("SM_QC_PREFUNDING_SELECTION_DAILY"), undefined, "the daily row arms on the scheduler tick, not on a selection");
  // the daily row: the 06:00 MST tick arms it and the run's `qc.sample.planned` satisfies it
  await h.run("selectLoans", { op: "tick", partner_id: PARTNER, date: "2026-10-28", time_zone: "America/Phoenix" });
  assert.equal(h.ofType("schedule.tick")[0]!.occurredAt, "2026-10-28T13:00:00.000Z"); assert.equal(h.timer("SM_QC_PREFUNDING_SELECTION_DAILY")!.status, "armed");
  await h.run("selectLoans", { plan: h.store.get("qc_sample_plans", plan.sample_plan_id)!.data, candidates: [] });
  assert.equal(h.timers.byCode("SM_QC_PREFUNDING_SELECTION_DAILY")[0]!.status, "satisfied"); assert.equal(h.timer("SM_QC_PREFUNDING_SELECTION_DAILY")!.status, "armed", "recurring: re-armed for the next day");
  // a random draw that also hits a trigger is recorded `risk_trigger` with `random_hit = true`
  const both = selectLoan(h.events, { plan, application_id: "APP-X", features: { dti_bps: 4600 }, at: "2026-10-28T13:00:30.000Z", random_target_remaining: 6, expected_remaining_population: 95, draw: 0.01 });
  assert.equal(both.basis, "risk_trigger"); assert.equal(both.random_hit, true); assert.equal(both.review!.review_type, "component"); assert.deepEqual(both.review!.component_scope, ["aus_data", "ssn", "income"]);
});

test("28.1-T2: Given the review closes `no_defect` Thu Oct 29 10:42 MST with no severity ≤ 2 findings and the review is not in the officer sample, then `hold_released_at` is set by the agent, `qc.review.closed` is emitted and 23.3 can issue CTC Fri Oct 30.", async () => {
  const h = harness(REFI, "2026-10-28T13:00:12.000Z");
  const plan = octoberPlan(h); const sel = selectRefi(h, plan);
  let review = inReview(h, sel.review!, "2026-10-28T13:01:00.000Z");
  assert.equal(review.status, "in_review"); assert.equal(review.reviewer_agent_run_id, "qc-run-1");
  // the eight areas on the refinance fixture (worked example 1): every test passes; one severity-4 observation
  const du = recomputeDuInputs({ du_request: { monthly_income_cents: 1_485_000n, occupancy: "primary", loan_amount_cents: 56_000_000n }, recomputed: { monthly_income_cents: 1_485_000n, occupancy: "primary", loan_amount_cents: 56_000_000n }, evidence_refs: [{ document_id: "doc-ulad-snapshot" }], du_request_date: D("2026-10-22") });
  assert.equal(du.all_match, true); assert.equal(du.findings.length, 0);
  const income = recomputeIncome({ paystubs: [{ document_id: "doc-ps-1", gross_period_cents: 742_500n, pay_periods_per_year: 24, period_end: D("2026-10-15") }, { document_id: "doc-ps-2", gross_period_cents: 742_500n, pay_periods_per_year: 24, period_end: D("2026-09-30") }], w2_prior_year_cents: 17_820_000n, w2_document_id: "doc-w2-2025", underwriter_monthly_cents: 1_485_000n, monthly_debts_cents: 564_300n });
  assert.equal(income.monthly_cents, 1_485_000n); assert.equal(income.variance_cents, 0n); assert.equal(income.finding, null);
  const vvoe = checkVvoe({ vvoe_on: D("2026-10-27"), note_date: D("2026-11-06"), today: D("2026-10-28"), phone_independently_sourced: true, document_id: "doc-vvoe" });
  assert.equal(vvoe.business_days_before_note, 8); assert.equal(vvoe.test.result, "pass");
  const assets = recomputeAssets({ funds_to_close_cents: 421_280n, verified_assets_cents: 6_194_011n, monthly_qualifying_income_cents: 1_485_000n, deposits: [{ amount_cents: 600_000n, on: D("2026-10-02"), sourced: true }], gift: null, integrity_checks_pass: true, evidence_refs: [{ document_id: "doc-stmt-1" }] });
  assert.equal(assets.large_deposit_threshold_cents, 742_500n); assert.equal(assets.sufficient, true); assert.equal(assets.findings.length, 0);
  const coll = checkCollateral({ valuation_method: "value_acceptance", offer_date: D("2026-10-06"), note_date: D("2026-11-06"), evidence_refs: [{ document_id: "doc-du-findings" }] });
  assert.equal(coll.offer_age_days, 31); assert.equal(coll.offer_expires_on, "2027-02-06"); assert.equal(coll.findings.length, 0);
  assert.equal(checkMi({ ltv_x100: 7000, term_months: 360, coverage_pct: null, certificate_issued: false, evidence_refs: [] }).test.result, "na");
  assert.equal(assessOccupancy({ declared: "primary", mailing_address_is_subject: true, insurance_form: "HO-3", other_reo_primary: false, evidence_refs: [{ document_id: "doc-hoi" }] }).test.result, "pass");
  assert.equal(checkSsn({ borrowers: [{ borrower_id: "B1", cbsv_result: "match", cbsv_on: D("2026-10-06"), document_id: "doc-cbsv" }] }).findings.length, 0);
  const comp = runComplianceSnapshot({ compliance_tests_current: true, trid_clocks_ok: true, regb_decision_timer_satisfied: true, ofac_rescreen_on: D("2026-10-27"), today: D("2026-10-28"), identity_result: "pass", fraud_cases_open: 0, evidence_refs: [{ document_id: "doc-25-1" }] });
  assert.equal(comp.findings.length, 0);
  const obs = draftFinding(h.events, review, { category: "income_employment", sub_category: "employer_name_abbreviation", severity: 4, description: "2025 W-2 employer name abbreviated differently from the paystub (\"ACME Semicond.\" vs \"Acme Semiconductor LLC\") — recorded, no action", observed_value: "ACME Semicond.", expected_value: "Acme Semiconductor LLC", guide_citation: "B3-3.1-01", evidence_refs: [{ document_id: "doc-w2-2025" }], at: "2026-10-28T15:20:00.000Z" });
  review = obs.review; assert.equal(review.review_type, "full_file"); assert.equal(review.highest_severity, 4);
  // review complete inside the SLA (due Fri Oct 30) → SM_QC_PREFUNDING_REVIEW_SLA_2BD satisfied
  const done = completeReview(h.events, review, [obs.finding], "2026-10-29T17:40:00.000Z"); review = done.review;
  assert.equal(done.within_sla, true); assert.equal(h.timer("SM_QC_PREFUNDING_REVIEW_SLA_2BD")!.status, "satisfied");
  // not in the officer's 10% sample and no severity ≤ 2 finding → the agent alone closes no_defect Thu Oct 29 10:42 MST
  const route = routeToOfficer(h.events, h.escalations, review, [obs.finding], { at: "2026-10-29T17:41:00.000Z", officer_sample: false });
  assert.equal(route.required, false);
  const closed = closeReview(h.events, h.escalations, review, [obs.finding], { outcome: "no_defect", at: "2026-10-29T17:42:00.000Z", actor: QC_AGENT });
  assert.equal(closed.review.status, "closed"); assert.equal(closed.review.outcome, "no_defect"); assert.equal(closed.review.hold_released_at, "2026-10-29T17:42:00.000Z"); assert.equal(closed.review.hold_released_by, "agent:qc-audit"); assert.equal(closed.application_qc_status, "cleared");
  assert.deepEqual(closed.events.map((e) => e.type), ["qc.review.closed", "qc.hold.released"]); assert.equal(closed.events[0]!.payload.outcome, "no_defect"); assert.equal(closed.events[0]!.payload.defects_open, false);
  assert.equal(h.timer("FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE")!.status, "satisfied");
  // 23.3 can issue CTC Fri Oct 30: its derived status and the shared evaluator agree the gate is open
  assert.equal(prefundingReviewStatus(h.events.all()), "closed_no_defect"); assert.equal(reviewGateStatus(closed.review), "closed_no_defect");
  assert.equal(evaluateGate("23.3.prefundingQcGate", { review_status: reviewGateStatus(closed.review), command: "clear_to_close" }).open, true);
  const ctc = runCtcChecklist({ application_id: REFI, decision_id: "D-REFI-CA-1", evaluated_at: "2026-10-30T16:30:00.000Z", facts: ctcAllPass(), prefunding_review_status: prefundingReviewStatus(h.events.all()) });
  assert.equal(ctc.passed, true); assert.equal(ctc.items.find((x) => x.code === "CTC_QC_PREFUNDING")!.status, "pass");
  // the same review in the officer's sample cannot be closed no_defect by the agent; a severity-2 finding cannot be closed no_defect at all
  refusedBy(() => closeReview(h.events, h.escalations, { ...review, officer_sample: true }, [obs.finding], { outcome: "no_defect", at: "2026-10-29T17:42:00.000Z", actor: QC_AGENT }), "NO_DEFECT_IN_OFFICER_SAMPLE_NEEDS_OFFICER");
  refusedBy(() => closeReview(h.events, h.escalations, review, [{ ...obs.finding, severity: 2 }], { outcome: "no_defect", at: "2026-10-29T17:42:00.000Z", actor: QC_AGENT }), "NO_DEFECT_WITH_SEV12_FINDING");
});

test("28.1-T3: Given the purchase fixture is selected Mon Nov 9, 2026 by `du_red_flag_message` and `gift_funds_pct > 50%`, then `review_type = full_file`, and a severity-1 finding cannot reach `released` without a `qc_officer` decision (`SM_QC_OFFICER_FINDING_SLA_1BD` due Thu Nov 12 because Wed Nov 11 is a holiday).", async () => {
  const h = harness(PURCHASE, "2026-11-09T11:00:00.000Z");
  const plan = novemberPlan(h); const sel = selectPurchase(h, plan);
  assert.equal(sel.selected, true); assert.equal(sel.basis, "risk_trigger"); assert.equal(sel.random_hit, false);
  assert.deepEqual(sel.triggers.map((t) => t.code), ["du_red_flag_message", "gift_funds_pct_gt_50"]); assert.ok(sel.triggers.every((t) => t.fraud_family));
  assert.equal(sel.review!.review_type, "full_file"); assert.deepEqual(sel.review!.selection_reason_codes, ["du_red_flag_message", "gift_funds_pct_gt_50"]); assert.equal(sel.review!.due_at, "2026-11-12");   // +2 BD: Tue Nov 10, Thu Nov 12 (Veterans Day off)
  assert.equal(reviewScope("risk_trigger", [{ code: "ltv_gt_95", area: "collateral", fraud_family: false, basis: "risk_trigger" }]).review_type, "component");
  let review = inReview(h, sel.review!, "2026-11-09T11:05:00.000Z");
  const fs = purchaseFindings(h, review, "2026-11-10T14:00:00.000Z"); review = fs.review;
  assert.equal(fs.f2.severity, 1); assert.equal(fs.f2.defect_code, "assets/large_deposit_unsourced"); assert.equal(fs.f1.severity, 2); assert.equal(fs.f1.defect_code, "assets/gift_letter_incomplete");
  // no officer decision → release refused, and the bus refuses a self-approval flag
  refusedBy(() => releaseFindings(h.events, h.escalations, review, [fs.f1, fs.f2], { at: "2026-11-10T14:41:00.000Z" }), "SEV12_RELEASE_NEEDS_QC_OFFICER");
  h.store.put("qc_reviews", review.review_id, review as unknown as Record<string, unknown>, QC_AGENT, h.clock.now());
  await refused(h.run("releaseFindings", { review_id: review.review_id, findings: [fs.f1, fs.f2], self_approve: true }), "NO_SEV12_SELF_APPROVAL");
  // Tue Nov 10 09:30 EST → officer_review; SLA +1 business_days_creditor rolls over Veterans Day to Thu Nov 12
  h.at("2026-11-10T14:30:00.000Z");
  const route = routeToOfficer(h.events, h.escalations, review, [fs.f1, fs.f2], { at: "2026-11-10T14:30:00.000Z" }); review = route.review;
  assert.equal(route.required, true); assert.equal(review.status, "officer_review"); assert.equal(route.sla_due, "2026-11-12"); assert.equal(route.escalation!.kind, "qc_officer"); assert.equal(route.escalation!.severity, "sev1");
  const sla = h.timer("SM_QC_OFFICER_FINDING_SLA_1BD")!; assert.equal(sla.status, "armed"); assert.equal(sla.anchorDate, "2026-11-10"); assert.equal(sla.dueDate, "2026-11-12");
  assert.equal(addBusinessDays(D("2026-11-10"), 1, creditor), "2026-11-12");
  // an agent cannot take the officer's decision; the officer's `released` decision satisfies the SLA
  refusedBy(() => officerDecideFinding(h.events, fs.f2, { decision: "released", officer: QC_AGENT, at: "2026-11-10T14:35:00.000Z", rationale: "x" }), "FINDING_DECISION_NEEDS_QC_OFFICER");
  const decided = officerDecideFinding(h.events, fs.f2, { decision: "released", officer: OFFICER, at: "2026-11-10T14:35:00.000Z", rationale: "deposit exceeds the $3,500.00 threshold with no source" });
  assert.equal(decided.finding.reviewed_by_qc_officer_at, "2026-11-10T14:35:00.000Z"); assert.equal(decided.finding.officer_decision, "released");
  assert.equal(h.timer("SM_QC_OFFICER_FINDING_SLA_1BD")!.status, "satisfied");
  const f1 = officerDecideFinding(h.events, fs.f1, { decision: "released", officer: OFFICER, at: "2026-11-10T14:36:00.000Z", rationale: "B3-4.3-04 elements missing" }).finding;
  const rel = releaseFindings(h.events, h.escalations, review, [f1, decided.finding], { at: "2026-11-10T14:41:00.000Z" });
  assert.deepEqual(rel.findings.map((f) => f.status), ["released", "released"]); assert.equal(rel.review.status, "findings_released");
});

test("28.1-T4: Given findings F1 (sev 2) and F2 (sev 1) are released Tue Nov 10 09:41, then 23.3 reopens conditions within the same transaction, `applications.qc_prefunding_status = defect_open`, and `assertGateOpen(FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE)` returns closed until both findings are `corrected`.", async () => {
  const h = harness(PURCHASE, "2026-11-09T11:00:00.000Z");
  const plan = novemberPlan(h); let review = inReview(h, selectPurchase(h, plan).review!, "2026-11-09T11:05:00.000Z");
  const fs = purchaseFindings(h, review, "2026-11-10T14:00:00.000Z"); review = routeToOfficer(h.events, h.escalations, fs.review, [fs.f1, fs.f2], { at: "2026-11-10T14:30:00.000Z" }).review;
  const approved = officerReleases(h, [fs.f1, fs.f2], "2026-11-10T14:35:00.000Z");
  // production (23.3) reacts to `qc.finding.released` in the same store — conditions C-17 (gift letter) and C-18 (deposit source) reopen within the transaction
  const conditions = new Map<string, Condition>([["F1", clearedCondition(PURCHASE, "C-17", "COND_DU_GIFT_LETTER", "assets")], ["F2", clearedCondition(PURCHASE, "C-18", "COND_DU_LARGE_DEPOSIT", "assets")]]);
  const reopened: string[] = [];
  h.events.subscribe("qc.finding.released", (e) => { const c = conditions.get(e.payload.finding_id as string)!; const r = reopenCondition(h.events, c, { reason: `28.1 prefunding QC finding ${e.payload.finding_id}: ${e.payload.defect_code}`, at: e.occurredAt }, UW); conditions.set(e.payload.finding_id as string, r.condition); reopened.push(r.condition.condition_id); });
  h.at("2026-11-10T14:41:00.000Z");
  const rel = releaseFindings(h.events, h.escalations, review, approved, { at: "2026-11-10T14:41:00.000Z" }); review = rel.review;
  assert.deepEqual(reopened, ["C-17", "C-18"]); assert.equal(conditions.get("F1")!.status, "reopened"); assert.equal(conditions.get("F2")!.status, "reopened");
  const seq = h.events.all().filter((e) => ["qc.finding.released", "condition.reopened", "qc.hold.applied"].includes(e.type) && e.occurredAt === "2026-11-10T14:41:00.000Z").map((e) => e.type);
  assert.deepEqual(seq, ["qc.finding.released", "condition.reopened", "qc.finding.released", "condition.reopened", "qc.hold.applied"]);
  assert.equal(rel.application_qc_status, "defect_open"); assert.equal(qcPrefundingStatus(review, rel.findings), "defect_open");
  assert.equal(prefundingReviewStatus(h.events.all()), "defect_open");
  // the gate stays closed: released → F1 corrected → still closed → F2 corrected → closed until the review closes defect_corrected
  const gate = (fs2: QcFinding[]) => assertGateOpen(review, fs2, "clear_to_close");
  assert.equal(rel.gate.open, false); assert.deepEqual(rel.gate.blocking_codes, [SM_QC_PREFUNDING_HOLD]); assert.match(rel.gate.reason!, /FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE blocks clear_to_close: prefunding QC review defect_open/);
  assert.equal(evaluateGate("23.3.prefundingQcGate", { review_status: reviewGateStatus(review, rel.findings), command: "consummate" }).open, false);
  // the rebuttal window is closed by production's reaction, recorded on the finding
  const r1 = recordFindingResolution(h.events, rel.findings[0]!, { resolution: "condition_reopened", resolution_ref: "C-17", at: "2026-11-10T14:41:30.000Z" }).finding;
  const r2 = recordFindingResolution(h.events, rel.findings[1]!, { resolution: "condition_reopened", resolution_ref: "C-18", at: "2026-11-10T14:41:30.000Z" }).finding;
  assert.equal(h.timers.byCode("SM_QC_REBUTTAL_WINDOW_1BD").length, 2); assert.ok(h.timers.byCode("SM_QC_REBUTTAL_WINDOW_1BD").every((t) => t.status === "satisfied"));
  const c1 = correctFinding(h.events, r1, { retest_evidence_refs: [{ document_id: "doc-gift-2" }], at: "2026-11-10T22:00:00.000Z" }).finding;
  assert.equal(c1.status, "corrected"); assert.equal(gate([c1, r2]).open, false); assert.equal(qcPrefundingStatus(review, [c1, r2]), "defect_open");
  const c2 = correctFinding(h.events, r2, { retest_evidence_refs: [{ document_id: "doc-bonus-stmt" }], at: "2026-11-13T13:10:00.000Z" }).finding;
  assert.equal(gate([c1, c2]).open, false, "both corrected — the gate opens only when the review closes defect_corrected");
  const closed = closeReview(h.events, h.escalations, review, [c1, c2], { outcome: "defect_corrected", at: "2026-11-13T13:15:00.000Z", actor: QC_AGENT });
  assert.equal(assertGateOpen(closed.review, [c1, c2]).open, true); assert.equal(closed.application_qc_status, "cleared");
  // through the bus: the QC tool never calls 23.3's clearCondition / openCondition itself
  h.store.put("qc_reviews", review.review_id, review as unknown as Record<string, unknown>, QC_AGENT, h.clock.now());
  await refused(h.run("releaseFindings", { review_id: review.review_id, findings: approved, command: "clearCondition" }), "QC_NEVER_CALLS_PRODUCTION");
});

test("28.1-T5: Given F2 is corrected Fri Nov 13 08:10 and the review closes `defect_corrected`, then CTC may issue and the CD delivered Fri Nov 13 supports consummation Wed Nov 18 (three Reg Z specific business days: Nov 14, 16, 17).", async () => {
  const h = harness(PURCHASE, "2026-11-09T11:00:00.000Z");
  const plan = novemberPlan(h); let review = inReview(h, selectPurchase(h, plan).review!, "2026-11-09T11:05:00.000Z");
  const fs = purchaseFindings(h, review, "2026-11-10T14:00:00.000Z"); review = routeToOfficer(h.events, h.escalations, fs.review, [fs.f1, fs.f2], { at: "2026-11-10T14:30:00.000Z" }).review;
  const rel = releaseFindings(h.events, h.escalations, review, officerReleases(h, [fs.f1, fs.f2], "2026-11-10T14:35:00.000Z"), { at: "2026-11-10T14:41:00.000Z" }); review = rel.review;
  // corrected gift letter Tue Nov 10 (donor: mother; phone; bank) → F1 re-tested; the employer's bonus statement Thu Nov 12 → F2 re-tested Fri Nov 13 08:10 EST
  const f1 = correctFinding(h.events, recordFindingResolution(h.events, rel.findings[0]!, { resolution: "condition_reopened", resolution_ref: "C-17", at: "2026-11-10T14:41:30.000Z" }).finding, { retest_evidence_refs: [{ document_id: "doc-gift-2" }], at: "2026-11-13T13:10:00.000Z", observed_value: "donor: mother; phone; bank — complete" }).finding;
  refusedBy(() => closeReview(h.events, h.escalations, review, [f1, rel.findings[1]!], { outcome: "defect_corrected", at: "2026-11-13T13:12:00.000Z", actor: QC_AGENT }), "DEFECTS_STILL_OPEN");
  const f2 = correctFinding(h.events, recordFindingResolution(h.events, rel.findings[1]!, { resolution: "condition_reopened", resolution_ref: "C-18", at: "2026-11-10T14:41:30.000Z" }).finding, { retest_evidence_refs: [{ document_id: "doc-bonus-stmt" }], at: "2026-11-13T13:10:00.000Z" }).finding;
  assert.equal(f2.status, "corrected"); assert.equal(f2.resolved_at, "2026-11-13T13:10:00.000Z"); assert.equal(f2.resolution, "condition_reopened"); assert.equal(f2.resolution_ref, "C-18");
  h.at("2026-11-13T13:15:00.000Z");
  const closed = closeReview(h.events, h.escalations, review, [f1, f2], { outcome: "defect_corrected", at: "2026-11-13T13:15:00.000Z", actor: QC_AGENT });
  assert.equal(closed.review.outcome, "defect_corrected"); assert.equal(closed.review.hold_released_at, "2026-11-13T13:15:00.000Z"); assert.equal(closed.review.highest_severity, 1);
  assert.equal(h.timer("FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE")!.status, "satisfied");
  // CTC may issue (23.3's derivation and the shared evaluator both open)
  assert.equal(prefundingReviewStatus(h.events.all()), "closed_defect_corrected"); assert.equal(reviewGateStatus(closed.review, [f1, f2]), "closed_defect_corrected");
  assert.equal(prefundingQcGate({ review_status: "closed_defect_corrected" }).open, true);
  const ctc = runCtcChecklist({ application_id: PURCHASE, decision_id: "D-PURCH-CA-1", evaluated_at: "2026-11-16T14:00:00.000Z", facts: ctcAllPass({ CTC_MI: { status: "pass" } }), prefunding_review_status: prefundingReviewStatus(h.events.all()) });
  assert.equal(ctc.passed, true);
  // the CD delivered (e-sign confirmation) Fri Nov 13: Reg Z specific business days Sat Nov 14 (1), Mon Nov 16 (2), Tue Nov 17 (3) → consummation Wed Nov 18 (25.2's gate)
  const cd = earliestConsummation(D("2026-11-13"));
  assert.deepEqual(cd.counted, ["2026-11-14", "2026-11-16", "2026-11-17"]); assert.equal(cd.earliest, "2026-11-17"); assert.ok(D("2026-11-18") > cd.earliest, "Wed Nov 18 is on or after the third specific business day");
  // metrics on the file: selection Mon Nov 9 → release Tue Nov 10 = 1 business day
  const m = computeMetrics({ period_month: D("2026-11-01"), eligible_population: 96, reviews: [closed.review], findings: [f1, f2], officer: { findings_reviewed: 2, findings_concurred: 2, no_defect_sampled: 0, no_defect_concurred: 0 } });
  assert.equal(m.avg_selection_to_release_bd, 1); assert.equal(m.sustained_sev12_findings, 2); assert.deepEqual(m.by_defect_code, { "assets/gift_letter_incomplete": 1, "assets/large_deposit_unsourced": 1 }); assert.equal(m.officer_concurrence_pct, 100);
});

test("28.1-T6: Given a production agent run attempts `closeReview` or a QC agent run attempts `clearCondition`, then both are refused by role and identity checks and logged as sev 2 to `compliance-sentinel`.", async () => {
  const h = harness(REFI, "2026-10-28T13:00:12.000Z");
  const plan = octoberPlan(h); const review = inReview(h, selectRefi(h, plan).review!, "2026-10-28T13:01:00.000Z");
  h.store.put("qc_reviews", review.review_id, review as unknown as Record<string, unknown>, QC_AGENT, h.clock.now());
  // (1) the production `underwriter` run on the 28.1 bus: not allowlisted (role check); at the ops level the identity check refuses and logs sev 2
  await refused(h.run("closeReview", { review_id: review.review_id, outcome: "no_defect" }, UW), "NOT_ALLOWLISTED");
  refusedBy(() => closeReview(h.events, h.escalations, review, [], { outcome: "no_defect", at: "2026-10-29T17:42:00.000Z", actor: UW }), "QC_IDENTITY_REQUIRED");
  refusedBy(() => assertQcIdentity(h.escalations, { kind: "human", id: "u-uwr", role: "underwriting_reviewer" }, "releaseFindings", REFI), "QC_IDENTITY_REQUIRED");
  // (2) the `qc-audit` run on 23.3's clearCondition: not allowlisted; the mirror identity check refuses and logs sev 2
  await refused(h.run("clearCondition", { condition_id: "C-1", evaluation: {}, at: "2026-10-29T17:42:00.000Z" }, QC_AGENT, "23.3"), "NOT_ALLOWLISTED");
  refusedBy(() => assertNotProductionCommand(h.escalations, QC_AGENT, "clearCondition", REFI), "QC_NEVER_CALLS_PRODUCTION");
  refusedBy(() => assertNotProductionCommand(h.escalations, OFFICER, "issueClearToClose", REFI), "QC_NEVER_CALLS_PRODUCTION");
  assertNotProductionCommand(h.escalations, QC_AGENT, "draftFinding", REFI);   // a QC command from the QC identity is fine
  // the refusals are events; every identity refusal is a sev 2 escalation routed to compliance-sentinel
  assert.deepEqual(h.ofType("command.refused").map((e) => e.payload.code), ["NOT_ALLOWLISTED", "NOT_ALLOWLISTED"]);
  const sentinel = h.escalations.list().filter((e) => e.payload.route === "compliance-sentinel");
  assert.equal(sentinel.length, 4); assert.ok(sentinel.every((e) => e.severity === "sev2" && e.kind === "sev2" && e.ownerRole === "compliance_sentinel"));
  assert.deepEqual(sentinel.map((e) => e.payload.command), ["closeReview", "releaseFindings", "clearCondition", "issueClearToClose"]);
  assert.equal(h.store.get("qc_reviews", review.review_id)!.data.status, "in_review", "nothing was written");
  // the reviewer identity on the loan: an application whose agent_runs carry the QC identity cannot be reviewed by it (D1-2-01)
  refusedBy(() => openReview(h.events, h.escalations, selectLoan(h.events, { plan, application_id: "APP-Y", features: {}, at: "2026-10-28T13:02:00.000Z", random_target_remaining: 6, expected_remaining_population: 95, draw: 0.0 }).review!, { run: RUN, reviewer: QC_AGENT, application_agent_runs: [{ agent_id: "qc-audit", run_id: "qc-run-0" }], at: "2026-10-28T13:03:00.000Z" }), "REVIEWER_INVOLVED_IN_LOAN");
  refusedBy(() => openReview(h.events, h.escalations, selectLoan(h.events, { plan, application_id: "APP-Z", features: {}, at: "2026-10-28T13:02:00.000Z", random_target_remaining: 6, expected_remaining_population: 95, draw: 0.0 }).review!, { run: RUN, reviewer: UW, application_agent_runs: [], at: "2026-10-28T13:03:00.000Z" }), "QC_IDENTITY_REQUIRED");
});

test("28.1-T7: Given the DU request payload of Oct 22 shows monthly income $14,850.00 but the recomputation from the paystubs yields $13,900.00 (−6.4%), then a `data_integrity/du_input_variance` finding of severity 1 is drafted with both values and the evidence refs, and the loan cannot close until a DU resubmission (23.1) resolves it.", async () => {
  const h = harness(REFI, "2026-10-28T13:00:12.000Z");
  const plan = octoberPlan(h); let review = inReview(h, selectRefi(h, plan).review!, "2026-10-28T13:01:00.000Z");
  const evidence = [{ document_id: "doc-ps-1", page: 1 }, { document_id: "doc-ps-2", page: 1 }, { document_id: "doc-du-request-oct22", extraction_id: "ulad_snapshot" }];
  const du = recomputeDuInputs({ du_request: { monthly_income_cents: 1_485_000n }, recomputed: { monthly_income_cents: 1_390_000n }, evidence_refs: evidence, du_request_date: D("2026-10-22"), monthly_debts_cents: 564_300n });
  assert.equal(du.all_match, false); assert.equal(du.income_variance!.variance_cents, -95_000n); assert.equal(du.income_variance!.variance_pct, "−6.4%"); assert.equal(variancePct(1_485_000n, 1_390_000n), "−6.4%");
  const draft = du.findings[0]!;
  assert.equal(draft.category, "data_integrity"); assert.equal(draft.sub_category, "du_input_variance"); assert.equal(draft.severity, 1);
  assert.equal(draft.observed_value, "$13,900.00"); assert.equal(draft.expected_value, "$14,850.00"); assert.match(draft.description, /of 2026-10-22/); assert.match(draft.description, /−6\.4%/); assert.match(draft.description, /resubmit DU \(23\.1\)/);
  assert.deepEqual(draft.evidence_refs, evidence); assert.match(draft.guide_citation, /B3-2-10/);
  // inside tolerance (≤ 2%, no DTI crossing) → severity 3 with a data correction; an increase is no defect
  const small = recomputeDuInputs({ du_request: { monthly_income_cents: 1_485_000n }, recomputed: { monthly_income_cents: 1_470_000n }, evidence_refs: evidence, monthly_debts_cents: 564_300n });
  assert.equal(small.findings[0]!.severity, 3); assert.equal(small.findings[0]!.sub_category, "du_input_variance_in_tolerance"); assert.deepEqual(small.findings[0]!.data_correction, { field: "monthly_income_cents", from: "1485000", to: "1470000" });
  assert.equal(recomputeDuInputs({ du_request: { monthly_income_cents: 1_485_000n }, recomputed: { monthly_income_cents: 1_500_000n }, evidence_refs: evidence }).findings.length, 0);
  // drafted on the review through the bus: `data_integrity/du_input_variance` sev 1; the review is no longer closable no_defect; the gate stays closed
  h.store.put("qc_reviews", review.review_id, review as unknown as Record<string, unknown>, QC_AGENT, h.clock.now());
  const out = await h.run("draftFinding", { review_id: review.review_id, ...draft, finding_id: "F-DU" });
  const finding = out.finding as QcFinding; review = out.review as QcReview;
  assert.equal(finding.defect_code, "data_integrity/du_input_variance"); assert.equal(finding.status, "draft"); assert.equal(h.ofType("qc.finding.recorded")[0]!.payload.severity, 1);
  await refused(h.run("draftFinding", { review_id: review.review_id, ...draft, suppress_finding: true }), "NO_FINDING_SUPPRESSION");
  refusedBy(() => closeReview(h.events, h.escalations, review, [finding], { outcome: "no_defect", at: "2026-10-29T17:42:00.000Z", actor: QC_AGENT }), "NO_DEFECT_WITH_SEV12_FINDING");
  review = routeToOfficer(h.events, h.escalations, review, [finding], { at: "2026-10-28T16:00:00.000Z" }).review;
  const rel = releaseFindings(h.events, h.escalations, review, officerReleases(h, [finding], "2026-10-28T16:30:00.000Z"), { at: "2026-10-28T16:41:00.000Z" }); review = rel.review;
  assert.equal(rel.gate.open, false); assert.equal(rel.application_qc_status, "defect_open");
  // only a DU resubmission carrying the recomputed figure resolves it (A3-4-02: all data entered into DU must be verifiable)
  refusedBy(() => resolveByDuResubmission(h.events, rel.findings[0]!, { submission_id: "SUB-3", resubmitted_monthly_income_cents: 1_485_000n, recomputed_monthly_income_cents: 1_390_000n, at: "2026-10-29T15:00:00.000Z" }), "DU_RESUBMISSION_DOES_NOT_MATCH");
  const fixed = resolveByDuResubmission(h.events, rel.findings[0]!, { submission_id: "SUB-3", resubmitted_monthly_income_cents: 1_390_000n, recomputed_monthly_income_cents: 1_390_000n, at: "2026-10-29T15:00:00.000Z" });
  assert.equal(fixed.finding.status, "corrected"); assert.equal(fixed.finding.resolution, "data_corrected"); assert.equal(fixed.finding.resolution_ref, "SUB-3"); assert.equal(fixed.finding.observed_value, "$13,900.00");
  assert.deepEqual(fixed.events.map((e) => e.type), ["qc.finding.resolved", "qc.finding.corrected"]); assert.equal(h.timer("SM_QC_REBUTTAL_WINDOW_1BD")!.status, "satisfied");
  const closed = closeReview(h.events, h.escalations, review, [fixed.finding], { outcome: "defect_corrected", at: "2026-10-29T15:05:00.000Z", actor: QC_AGENT });
  assert.equal(assertGateOpen(closed.review, [fixed.finding]).open, true);
});

test("28.1-T8: Given a closing consummated Fri Nov 6 while a prefunding review is `in_review`, then `qc.breach.closed_with_open_review` fires at sev 1, the review continues as `post_closing_discretionary`, and 29.3's delivery gate reads the sustained-finding state.", async () => {
  const h = harness(REFI, "2026-10-28T13:00:12.000Z");
  const plan = octoberPlan(h); const review = inReview(h, selectRefi(h, plan).review!, "2026-10-28T13:01:00.000Z");
  assert.equal(review.status, "in_review"); assert.equal(assertGateOpen(review, [], "consummate").open, false);
  h.at("2026-11-06T17:00:00.000Z");
  const breach = consummatedWithOpenReview(h.events, h.escalations, review, { consummated_at: "2026-11-06T17:00:00.000Z", at: "2026-11-06T17:00:05.000Z" });
  assert.equal(breach.breach, true); assert.equal(breach.review.kind, "post_closing_discretionary"); assert.equal(breach.review.status, "in_review", "the review continues");
  assert.equal(breach.event!.type, "qc.breach.closed_with_open_review"); assert.equal(breach.event!.payload.severity, 1); assert.equal(breach.event!.payload.continues_as, "post_closing_discretionary"); assert.deepEqual(breach.event!.payload.blocking_codes, [SM_QC_PREFUNDING_HOLD]);
  assert.deepEqual(breach.escalations.map((e) => [e.kind, e.severity]), [["qc_officer", "sev1"], ["officer", "sev1"]]);
  assert.equal(h.timer("FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE")!.status, "armed", "the gate was never satisfied — the closing bypassed it");
  // 29.3's delivery gate: a sustained severity-1 finding blocks submitDelivery until corrected
  const f = draftFinding(h.events, breach.review, { category: "occupancy", sub_category: "declared_occupancy_contradicted", severity: 1, description: "landlord policy on a declared primary", observed_value: "DP-3", expected_value: "HO-3", guide_citation: "B2-1.1-01", evidence_refs: [{ document_id: "doc-hoi-2" }], at: "2026-11-09T15:00:00.000Z" });
  const r = releaseFindings(h.events, h.escalations, routeToOfficer(h.events, h.escalations, f.review, [f.finding], { at: "2026-11-09T15:10:00.000Z" }).review, officerReleases(h, [f.finding], "2026-11-09T16:00:00.000Z"), { at: "2026-11-09T16:30:00.000Z" });
  const sustained = { ...r.findings[0]!, status: "sustained" as const };
  const facts = deliveryGateFacts(r.review, [sustained]);
  assert.equal(facts.sustained_severity_1_open, true); assert.equal(facts.blocks_submit_delivery, true); assert.deepEqual(facts.open_finding_ids, [sustained.finding_id]); assert.equal(facts.review_kind, "post_closing_discretionary");
  const corrected = correctFinding(h.events, recordFindingResolution(h.events, sustained, { resolution: "decision_reversed", resolution_ref: "D-REFI-CA-1", at: "2026-11-12T15:00:00.000Z" }).finding, { retest_evidence_refs: [{ document_id: "doc-hoi-3" }], at: "2026-11-12T16:00:00.000Z" }).finding;
  assert.equal(deliveryGateFacts(r.review, [corrected]).blocks_submit_delivery, false);
  // through the bus
  h.store.put("qc_reviews", review.review_id, review as unknown as Record<string, unknown>, QC_AGENT, h.clock.now());
  const out = await h.run("closeReview", { op: "consummation_breach", review_id: review.review_id, consummated_at: "2026-11-06T17:00:00.000Z" });
  assert.equal(out.breach, true); assert.equal((out.review as QcReview).kind, "post_closing_discretionary"); assert.equal((out.delivery_gate as { blocks_submit_delivery: boolean }).blocks_submit_delivery, false);
  assert.equal(h.ofType("qc.breach.closed_with_open_review").length, 2);
});

/** A closed review of the October sample for the cycle statistics (worked example 3). */
const closedReview = (n: number, plan: QcSamplePlan, basis: QcReview["selection_basis"], review_type: QcReview["review_type"], closed_at: string, random_hit = false): QcReview => ({ review_id: `QCR-OCT-${n}`, application_id: `APP-OCT-${n}`, loan_id: null, partner_id: PARTNER, kind: "prefunding", selection_basis: basis, selection_reason_codes: basis === "random" ? [] : ["dti_ge_45"], random_hit, sample_plan_id: plan.sample_plan_id, review_type, component_scope: [], status: "closed", reviewer_agent_run_id: `run-${n}`, qc_officer_id: null, officer_signed_at: null, selected_at: "2026-10-05T13:00:00.000Z", due_at: D("2026-10-07"), opened_at: "2026-10-05T13:00:00.000Z", review_completed_at: closed_at, closed_at, outcome: "no_defect", highest_severity: null, production_hold_applied: true, hold_id: `qch:QCR-OCT-${n}`, hold_released_at: closed_at, hold_released_by: "agent:qc-audit", officer_sample: false, finding_ids: [], rule_set_version: RULE_SET_VERSION_28_1, model_version: "qc-audit-2026.09", prompt_version: "28.1-v1", retention_class: "fnma_qc_3y" });
const sustainedFinding = (review: QcReview, code: string, severity: 1 | 2): QcFinding => { const [category, sub_category] = code.split("/") as [QcFinding["category"], string]; return { finding_id: `F-${review.review_id}`, review_id: review.review_id, application_id: review.application_id, category, sub_category, defect_code: code, severity, description: code, evidence_refs: [{ document_id: `doc-${review.review_id}` }], observed_value: null, expected_value: null, guide_citation: "B3-3.1-01", law_citation: null, is_compliance: false, status: "corrected", recorded_at: "2026-10-06T15:00:00.000Z", released_at: "2026-10-06T16:00:00.000Z", rebuttal: null, resolution: "condition_reopened", resolution_ref: "C-1", resolved_at: "2026-10-08T15:00:00.000Z", reviewed_by_qc_officer_at: "2026-10-06T15:30:00.000Z", officer_decision: "released" }; };
/** October 2026 (worked example 3): 10 random + 23 risk-trigger (4 also random hits) = 33 reviews, 15 component / 18 full-file, last closed Fri Oct 30; 3 sustained severity-1/2 findings. */
const octoberSample = (plan: QcSamplePlan): { reviews: QcReview[]; findings: QcFinding[] } => {
  const reviews: QcReview[] = [];
  for (let n = 1; n <= 10; n++) reviews.push(closedReview(n, plan, "random", "full_file", "2026-10-2" + (n % 9) + "T17:00:00.000Z"));
  for (let n = 11; n <= 33; n++) reviews.push(closedReview(n, plan, "risk_trigger", n <= 25 ? "component" : "full_file", n === 33 ? "2026-10-30T17:42:00.000Z" : "2026-10-27T17:00:00.000Z", n <= 14));
  const findings = [sustainedFinding(reviews[11]!, "income/calculation_variance", 2), sustainedFinding(reviews[12]!, "income/calculation_variance", 2), sustainedFinding(reviews[30]!, "assets/large_deposit_unsourced", 1)];
  return { reviews, findings };
};
const monthMetrics = (period: string, completed: number, eligible: number, sustained: number): MonthlyMetrics => ({ period, eligible_population: eligible, reviews_completed: completed, reviews_cancelled: 0, sample_pct: Math.round((completed / eligible) * 1000) / 10, random_selected: 10, risk_trigger_selected: completed - 10, random_hits_in_triggers: 2, full_file: 15, component: completed - 15, sustained_sev12_findings: sustained, prefunding_defect_rate_pct: Math.round((sustained / completed) * 1000) / 10, by_defect_code: {}, by_category: {}, avg_selection_to_release_bd: 1, officer_concurrence_pct: 100, stratum_defect_rates: { random_pct: 0, model_monitoring_pct: 0 }, trends: [], watch_list: [] });

test("28.1-T9: Given the October 2026 sample's last review closes Fri Oct 30, then `FNMA_D1_1_03_PREFUNDING_REPORT_30` is due Sun Nov 29 and the report is issued and signed by Fri Nov 27 with a three-month trend (Aug–Oct) and the sample description (33 of 118 eligible; 28.0%).", async () => {
  const h = harness(REFI, "2026-10-30T17:42:00.000Z");
  const plan = octoberPlan(h); const { reviews, findings } = octoberSample(plan);
  assert.equal(randomTarget(118), 10);   // worked example 3: max(ceil(0.05 × 118), 10) = 10
  const done = sampleCompletion(h.events, plan, reviews, "2026-10-30T17:45:00.000Z");
  assert.equal(done.complete, true); assert.equal(done.completion_date, "2026-10-30"); assert.equal(done.report_due, "2026-11-29"); assert.equal(done.issue_target, "2026-11-27");
  assert.deepEqual(reportDue(D("2026-11-30")), { due: D("2026-12-30"), issue_target: D("2026-12-29") });   // November sample: last review Mon Nov 30 → due Wed Dec 30
  assert.equal(sampleCompletion(h.events, plan, [...reviews, { ...reviews[0]!, review_id: "QCR-OPEN", status: "in_review", closed_at: null }], "2026-10-30T17:45:00.000Z").complete, false);
  const due = h.timer("FNMA_D1_1_03_PREFUNDING_REPORT_30")!; assert.equal(due.status, "armed"); assert.equal(due.anchorDate, "2026-10-30"); assert.equal(due.dueDate, "2026-11-29");
  // the metrics: 33 of 118 (28.0%); 3 sustained severity-1/2 → 3 / 33 = 9.1%; income/calculation_variance in 2 loans → watch list, not a trend
  const m = computeMetrics({ period_month: D("2026-10-01"), eligible_population: 118, reviews, findings, officer: { findings_reviewed: 3, findings_concurred: 3, no_defect_sampled: 3, no_defect_concurred: 3 } });
  assert.equal(m.reviews_completed, 33); assert.equal(m.sample_pct, 28.0); assert.equal(m.random_selected, 10); assert.equal(m.risk_trigger_selected, 23); assert.equal(m.random_hits_in_triggers, 4); assert.equal(m.component, 15); assert.equal(m.full_file, 18);
  assert.equal(m.sustained_sev12_findings, 3); assert.equal(m.prefunding_defect_rate_pct, 9.1); assert.equal(m.officer_concurrence_pct, 100); assert.deepEqual(m.trends, []); assert.deepEqual(m.watch_list, [{ defect_code: "income/calculation_variance", loans: 2 }]);
  // the report issued Fri Nov 27 (last business day before Sun Nov 29) with the Aug–Oct trend and the sample description; signed the same day
  h.at("2026-11-27T15:00:00.000Z");
  const prior = [monthMetrics("2026-08", 28, 101, 2), monthMetrics("2026-09", 31, 110, 4)];
  const rep = draftMonthlyReport(h.events, { partner_id: PARTNER, plan, current: m, prior, corrective_action_plans: [], completion_date: D("2026-10-30"), at: "2026-11-27T15:00:00.000Z" });
  assert.equal(rep.report.kind, "prefunding_monthly"); assert.equal(rep.report.period, "2026-10"); assert.equal(rep.report.due_at, "2026-11-29"); assert.equal(rep.report.issued_late, false); assert.equal(rep.report.trend_window_months, 3);
  assert.deepEqual(rep.report.trend.map((t) => t.period), ["2026-08", "2026-09", "2026-10"]); assert.match(rep.report.sample_description, /^33 of 118 eligible loans reviewed \(28\.0%\)/); assert.equal(rep.report.retention_class, "fnma_qc_3y");
  refusedBy(() => draftMonthlyReport(h.events, { partner_id: PARTNER, plan, current: m, prior: [prior[1]!], corrective_action_plans: [], completion_date: D("2026-10-30"), at: "2026-11-27T15:00:00.000Z" }), "TREND_WINDOW_SHORT");
  const signoff = h.timer("SM_QC_REPORT_SIGNOFF_SLA_3BD")!; assert.equal(signoff.status, "armed"); assert.equal(signoff.dueDate, "2026-12-02");   // Fri Nov 27 + 3 BD (creditor)
  refusedBy(() => signReport(h.events, rep.report, { officer: QC_AGENT, at: "2026-11-27T16:00:00.000Z" }), "REPORT_SIGN_NEEDS_QC_OFFICER");
  const signed = signReport(h.events, rep.report, { officer: OFFICER, at: "2026-11-27T16:00:00.000Z" });
  assert.equal(signed.report.signed_by_qc_officer_at, "2026-11-27T16:00:00.000Z"); assert.equal(signed.event.payload.within_due, true);
  assert.equal(h.timer("FNMA_D1_1_03_PREFUNDING_REPORT_30")!.status, "satisfied"); assert.equal(h.timer("SM_QC_REPORT_SIGNOFF_SLA_3BD")!.status, "satisfied");
  // through the bus: sign is a human act (qc_officer)
  h.store.put("qc_reports", rep.report.report_id, rep.report as unknown as Record<string, unknown>, QC_AGENT, h.clock.now());
  await refused(h.run("draftMonthlyReport", { op: "sign", report_id: rep.report.report_id }), "REPORT_SIGN_NEEDS_QC_OFFICER");
  assert.equal(((await h.run("draftMonthlyReport", { op: "sign", report_id: rep.report.report_id }, OFFICER)) as unknown as { signed_by_qc_officer_at: string }).signed_by_qc_officer_at, "2026-11-27T15:00:00.000Z");
});

test("28.1-T10: Given the same defect code appears in 3 loans in one month, then the report contains a corrective-action plan with owner, expected resolution and due date, and `compliance-sentinel` tracks its completion.", async () => {
  const h = harness(REFI, "2026-11-27T15:00:00.000Z");
  const plan = octoberPlan(h); const { reviews, findings } = octoberSample(plan);
  const three = [...findings, sustainedFinding(reviews[13]!, "income/calculation_variance", 2)];
  const m = computeMetrics({ period_month: D("2026-10-01"), eligible_population: 118, reviews, findings: three, officer: null });
  assert.deepEqual(m.trends, [{ defect_code: "income/calculation_variance", loans: 3, share_pct: 9.1 }]); assert.deepEqual(m.watch_list, []);
  const prior = [monthMetrics("2026-08", 28, 101, 2), monthMetrics("2026-09", 31, 110, 4)];
  refusedBy(() => draftMonthlyReport(h.events, { partner_id: PARTNER, plan, current: m, prior, corrective_action_plans: [], completion_date: D("2026-10-30"), at: "2026-11-27T15:00:00.000Z" }), "TREND_NEEDS_CORRECTIVE_ACTION_PLAN");
  assert.throws(() => correctiveActionPlan({ defect_code: "income/calculation_variance", loans: 3, action: "tighten the verification agent's income prompt", owner: "", expected_resolution: "variance ≤ 2% on the December sample", due_date: D("2026-12-31") }), RangeError);
  const cap = correctiveActionPlan({ defect_code: "income/calculation_variance", loans: 3, action: "tighten the verification agent's income-calculation prompt; 31.2 change record", owner: "verification agent owner (SM origination ops)", expected_resolution: "income variance ≤ 2% on every December review", due_date: D("2026-12-31") });
  assert.equal(cap.trend, "income/calculation_variance in 3 loans"); assert.equal(cap.status, "open"); assert.equal(cap.tracker, "compliance-sentinel");
  const rep = draftMonthlyReport(h.events, { partner_id: PARTNER, plan, current: m, prior, corrective_action_plans: [cap], completion_date: D("2026-10-30"), at: "2026-11-27T15:00:00.000Z" });
  assert.deepEqual(rep.report.corrective_action_plans, [cap]); assert.equal(rep.report.corrective_action_plans[0]!.owner, "verification agent owner (SM origination ops)"); assert.equal(rep.report.corrective_action_plans[0]!.due_date, "2026-12-31");
  const tracked = h.ofType("qc.corrective_action.opened");
  assert.equal(tracked.length, 1); assert.equal(tracked[0]!.payload.tracker, "compliance-sentinel"); assert.equal(tracked[0]!.payload.owner, cap.owner); assert.equal(tracked[0]!.payload.expected_resolution, cap.expected_resolution); assert.equal(tracked[0]!.payload.due_date, "2026-12-31"); assert.equal(tracked[0]!.payload.status, "open");
  assert.equal(h.ofType("qc.report.issued")[0]!.payload.corrective_action_plans, 1);
  // a trend by share: 1 code in 10% of a 10-review month
  const small = computeMetrics({ period_month: D("2026-12-01"), eligible_population: 40, reviews: reviews.slice(0, 10), findings: [sustainedFinding(reviews[0]!, "collateral/cu_messages_unreconciled", 2)], officer: null });
  assert.deepEqual(small.trends, [{ defect_code: "collateral/cu_messages_unreconciled", loans: 1, share_pct: 10 }]);
});

test("28.1-T11: Given the officer's concurrence rate for a month is 85%, then 31.2 receives a model-review escalation and the officer sample rate for the next month is 20%.", async () => {
  const h = harness(REFI, "2026-12-01T15:00:00.000Z");
  const r = officerConcurrenceReview(h.events, h.escalations, { partner_id: PARTNER, period: "2026-11", officer: { findings_reviewed: 12, findings_concurred: 10, no_defect_sampled: 8, no_defect_concurred: 7 }, at: "2026-12-01T15:00:00.000Z" });
  assert.equal(r.concurrence_pct, 85); assert.equal(r.below_floor, true); assert.equal(r.next_month_sample_rate, 0.2);
  assert.equal(r.escalation!.severity, "sev2"); assert.equal(r.escalation!.payload.route, "31.2 model review"); assert.equal(r.escalation!.payload.next_month_officer_sample_rate, 0.2);
  assert.equal(r.event!.type, "qc.model_review.requested"); assert.equal(r.event!.payload.consumer, "31.2"); assert.equal(r.event!.payload.agent, "qc-audit"); assert.equal(r.event!.payload.concurrence_pct, 85); assert.equal(r.event!.payload.floor_pct, 90);
  // at or above 90% nothing happens; the doubled rate is the base for the following month
  const ok = officerConcurrenceReview(h.events, h.escalations, { partner_id: PARTNER, period: "2026-10", officer: { findings_reviewed: 3, findings_concurred: 3, no_defect_sampled: 3, no_defect_concurred: 3 }, at: "2026-12-01T15:00:00.000Z" });
  assert.equal(ok.concurrence_pct, 100); assert.equal(ok.below_floor, false); assert.equal(ok.next_month_sample_rate, 0.1); assert.equal(ok.escalation, null);
  assert.equal(officerConcurrenceReview(h.events, h.escalations, { partner_id: PARTNER, period: "2026-12", officer: { findings_reviewed: 10, findings_concurred: 8, no_defect_sampled: 10, no_defect_concurred: 9 }, current_sample_rate: 0.2, at: "2027-01-04T15:00:00.000Z" }).next_month_sample_rate, 0.4);
  const out = await h.run("computeMetrics", { op: "concurrence", partner_id: PARTNER, period: "2026-11", officer: { findings_reviewed: 12, findings_concurred: 10, no_defect_sampled: 8, no_defect_concurred: 7 } });
  assert.equal(out.below_floor, true); assert.equal(out.next_month_sample_rate, 0.2); assert.equal(h.ofType("qc.model_review.requested").length, 3);
});

test("28.1-T12: Given a reverification request sent Mon Nov 9 with no response by Thu Nov 12 (+3 BD) and Mon Nov 16 (+5 BD), then a second request is logged and the officer decides `unable_to_complete` or keeps the hold; the file records both request dates.", async () => {
  const h = harness(PURCHASE, "2026-11-09T11:00:00.000Z");
  const plan = novemberPlan(h); const review = inReview(h, selectPurchase(h, plan).review!, "2026-11-09T11:05:00.000Z");
  const o = orderReverification(h.events, review, { kind: "employment_written", source: "Acme Semiconductor LLC payroll", at: "2026-11-09T15:00:00.000Z", fee_cents: 2_500n });
  assert.equal(o.review.status, "awaiting_reverification"); assert.equal(o.reverification.purpose_code, "qc_prefunding"); assert.deepEqual(o.reverification.request_dates, ["2026-11-09"]);
  // +3 / +5 business_days_creditor from Mon Nov 9 with Wed Nov 11 (Veterans Day) off: Fri Nov 13 and Tue Nov 17 — the spec's Thu Nov 12 / Mon Nov 16 count the holiday as a business day (discrepancy reported)
  assert.equal(o.reverification.response_due_at, "2026-11-13"); assert.equal(o.reverification.escalate_at, "2026-11-17");
  const t = h.timer("SM_QC_REVERIFICATION_RESPONSE_3BD")!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-11-09"); assert.equal(t.dueDate, "2026-11-13");
  // before the due date nothing happens; at +3 BD with no response the second request is logged (both dates on the file); at +5 BD the officer decides
  assert.equal(reverificationFollowUp(h.events, h.escalations, o.reverification, { today: D("2026-11-12"), at: "2026-11-12T15:00:00.000Z" }).action, "none");
  const second = reverificationFollowUp(h.events, h.escalations, o.reverification, { today: D("2026-11-13"), at: "2026-11-13T15:00:00.000Z" });
  assert.equal(second.action, "second_request"); assert.deepEqual(second.reverification.request_dates, ["2026-11-09", "2026-11-13"]); assert.equal(second.event!.payload.attempt, 2);
  assert.equal(h.timers.byCode("SM_QC_REVERIFICATION_RESPONSE_3BD").length, 2, "the second request arms its own response clock");
  assert.equal(reverificationFollowUp(h.events, h.escalations, second.reverification, { today: D("2026-11-16"), at: "2026-11-16T15:00:00.000Z" }).action, "none");
  const esc = reverificationFollowUp(h.events, h.escalations, second.reverification, { today: D("2026-11-17"), at: "2026-11-17T15:00:00.000Z" });
  assert.equal(esc.action, "officer_decision"); assert.equal(esc.escalation!.kind, "qc_officer"); assert.deepEqual(esc.escalation!.payload.options, ["unable_to_complete", "keep_hold"]); assert.deepEqual(esc.escalation!.payload.request_dates, ["2026-11-09", "2026-11-13"]);
  // the agent cannot decide; the officer keeps the hold (review still waiting) or closes unable_to_complete (hold released by the officer only)
  refusedBy(() => officerDecideReverification(h.events, h.escalations, o.review, [], second.reverification, { decision: "unable_to_complete", officer: QC_AGENT, at: "2026-11-17T16:00:00.000Z", rationale: "x" }), "REVERIFICATION_DECISION_NEEDS_OFFICER");
  refusedBy(() => closeReview(h.events, h.escalations, o.review, [], { outcome: "unable_to_complete", at: "2026-11-17T16:00:00.000Z", actor: QC_AGENT }), "UNABLE_TO_COMPLETE_NEEDS_OFFICER");
  const keep = officerDecideReverification(h.events, h.escalations, o.review, [], second.reverification, { decision: "keep_hold", officer: OFFICER, at: "2026-11-17T16:00:00.000Z", rationale: "employer confirmed a reply is coming; hold persists" });
  assert.equal(keep.review.status, "awaiting_reverification"); assert.equal(keep.review.hold_released_at, null); assert.equal(keep.reverification.officer_decision, "keep_hold");
  const unable = officerDecideReverification(h.events, h.escalations, o.review, [], second.reverification, { decision: "unable_to_complete", officer: OFFICER, at: "2026-11-17T16:30:00.000Z", rationale: "two documented requests (Nov 9, Nov 13) unanswered; paystub + deposit pattern accepted as the alternative" });
  assert.equal(unable.review.status, "unable_to_complete"); assert.equal(unable.review.outcome, "unable_to_complete"); assert.equal(unable.review.hold_released_by, "human:u-qc-1"); assert.equal(unable.reverification.result, "unable");
  assert.deepEqual(unable.events.map((e) => e.type), ["qc.reverification.officer_decided", "qc.review.closed", "qc.hold.released"]);
  assert.equal(reviewGateStatus(unable.review), "unable_to_complete"); assert.equal(assertGateOpen(unable.review).open, true); assert.equal(prefundingReviewStatus(h.events.all()), "unable_to_complete");
  // a response satisfies the clock; borrower contact for QC only through an existing channel with the purpose disclosed
  h.store.put("qc_reverifications", o.reverification.reverification_id, o.reverification as unknown as Record<string, unknown>, QC_AGENT, h.clock.now());
  await h.run("orderReverification", { op: "receive", reverification_id: o.reverification.reverification_id, result: "match" });
  assert.equal(h.timers.byCode("SM_QC_REVERIFICATION_RESPONSE_3BD")[0]!.status, "satisfied");
  h.store.put("qc_reviews", review.review_id, review as unknown as Record<string, unknown>, QC_AGENT, h.clock.now());
  await refused(h.run("orderReverification", { review_id: review.review_id, kind: "gift_donor", source: "donor", borrower_contact: true }), "NO_BORROWER_CONTACT_OUTSIDE_VERIFICATION_CHANNEL");
  await h.run("orderReverification", { review_id: review.review_id, kind: "gift_donor", source: "donor", borrower_contact: true, existing_verification_channel: true, qc_purpose_disclosed: true });
});

test("28.1-T13: Given any QC review, then its `agent_decisions` row contains `rule_set_versions`, `model_version`, `prompt_version`, `inputs_hash`, per-test evidence refs, and no field derived from `applicant_demographics` (access log shows zero reads by `qc-audit`).", async () => {
  const h = harness(REFI, "2026-10-28T13:00:12.000Z");
  const plan = octoberPlan(h); const review = inReview(h, selectRefi(h, plan).review!, "2026-10-28T13:01:00.000Z");
  const tests: ChecklistTest[] = [...recomputeDuInputs({ du_request: { monthly_income_cents: 1_485_000n }, recomputed: { monthly_income_cents: 1_485_000n }, evidence_refs: [{ document_id: "doc-ulad-snapshot" }] }).tests,
    recomputeIncome({ paystubs: [{ document_id: "doc-ps-1", gross_period_cents: 742_500n, pay_periods_per_year: 24, period_end: D("2026-10-15") }], underwriter_monthly_cents: 1_485_000n }).test,
    ...recomputeAssets({ funds_to_close_cents: 421_280n, verified_assets_cents: 6_194_011n, monthly_qualifying_income_cents: 1_485_000n, deposits: [], gift: null, integrity_checks_pass: true, evidence_refs: [{ document_id: "doc-stmt-1" }] }).tests];
  const rec = decisionRecord28_1(review, { tests, findings: [], reverifications: [], inputs: { ulad_snapshot_hash: "abc", du_submission_id: "SUB-2", verification_ids: ["V-1", "V-2"] }, rationale: "all eight D1-2-01 areas pass; one severity-4 observation", confidence: 0.96 });
  assert.deepEqual(rec.rule_set_versions, RULE_SETS_28_1); assert.equal(rec.rule_set_versions["fnma.selling"], "2026-09-02"); assert.equal(rec.model_version, "qc-audit-2026.09"); assert.equal(rec.prompt_version, "28.1-v1");
  assert.match(rec.inputs_hash, /^[0-9a-f]{64}$/); assert.equal(rec.selection_basis, "random"); assert.equal(rec.review_id, review.review_id);
  assert.deepEqual(rec.checklist.map((a) => a.area), ["aus_data", "income", "assets"]); assert.ok(rec.checklist.every((a) => a.tests.every((t) => t.evidence_refs.length > 0)), "per-test evidence refs");
  assert.equal(rec.evidence_hashes.length, 3);
  assert.equal(JSON.stringify(rec).includes("applicant_demographics"), false);
  // a demographic field anywhere in the inputs is refused (23.3's assertNoDemographics, reused), on the ops path and on the bus
  assert.throws(() => decisionRecord28_1(review, { tests, findings: [], reverifications: [], inputs: { applicant_demographics: { ethnicity: "x" } }, rationale: "r", confidence: 0.9 }), (e: unknown) => e instanceof DecisionRefused && e.code === "PROTECTED_CLASS_DATA_IN_ASSESSMENT");
  h.store.put("qc_reviews", review.review_id, review as unknown as Record<string, unknown>, QC_AGENT, h.clock.now());
  await refused(h.run("writeDecision", { review_id: review.review_id, tests, rationale: "r", confidence: 0.9, inputs: { race: "x" } }), "APPLICANT_DEMOGRAPHICS_IN_QC_INPUT");
  await refused(h.run("selectLoans", { plan, candidates: [{ application_id: "APP-D", features: { ethnicity: "x" } }] }), "APPLICANT_DEMOGRAPHICS_IN_QC_INPUT");
  // the decision row through the bus carries the versions; the store's access log shows zero applicant_demographics reads by qc-audit across the run
  const out = await h.run("writeDecision", { review_id: review.review_id, tests, rationale: "all eight D1-2-01 areas pass", confidence: 0.96, inputs: { ulad_snapshot_hash: "abc" } }, QC_AGENT);
  assert.equal((out as { inputs_hash: string }).inputs_hash.length, 64);
  const d = h.decisions.at(-1)!;
  assert.equal(d.agent, "qc-audit"); assert.equal(d.ruleSetVersion, RULE_SET_VERSION_28_1); assert.equal(d.modelVersion, "qc-audit-2026.09"); assert.equal(d.promptVersion, "28.1-v1"); assert.equal(d.confidence, 0.96); assert.equal(d.applicationId, REFI); assert.deepEqual(d.subject, { kind: "qc_review", id: review.review_id }); assert.ok(d.evidenceDocumentIds!.includes("doc-ps-1"));
  assert.equal(h.store.reads.filter((k) => k === "applicant_demographics").length, 0); assert.ok(h.store.reads.length > 0);
  assert.equal(h.store.get("qc_decision_records", review.review_id)!.data.inputs_hash, (out as { inputs_hash: string }).inputs_hash);
});

test("28.1 worked figures: refinance fixture income $14,850.00/month from two $7,425.00 semi-monthly paystubs, funds to close $4,212.80 against verified assets $61,940.11 (large-deposit threshold $7,425.00), value-acceptance offer age 31 days, MI n/a at 70% LTV; purchase fixture gift $28,000 of $45,320.55 funds to close (62%), $14,600 unsourced deposit → $30,720.55 available, short $14,600, MI 25% at 90% LTV; acceptance probability 7/96 = 0.073; October random target max(ceil(0.05 × 118), 10) = 10; 3/33 = 9.1%, 33/118 = 28.0%; report Fri Oct 30 → due Sun Nov 29, issued Fri Nov 27", () => {
  // worked example 1
  const income = recomputeIncome({ paystubs: [{ document_id: "doc-ps-1", gross_period_cents: 742_500n, pay_periods_per_year: 24, period_end: D("2026-10-15") }, { document_id: "doc-ps-2", gross_period_cents: 742_500n, pay_periods_per_year: 24, period_end: D("2026-09-30") }], underwriter_monthly_cents: 1_485_000n });
  assert.equal(income.monthly_cents, 1_485_000n); assert.equal(income.annualized_cents, 17_820_000n); assert.equal(money(income.monthly_cents), "$14,850.00"); assert.equal(income.variance_bps, 0); assert.equal(income.variance_pct, "0.0%");
  const a1 = recomputeAssets({ funds_to_close_cents: 421_280n, verified_assets_cents: 6_194_011n, monthly_qualifying_income_cents: 1_485_000n, deposits: [{ amount_cents: 700_000n, on: D("2026-10-01"), sourced: false }], gift: null, integrity_checks_pass: true, evidence_refs: [{ document_id: "doc-stmt-1" }] });
  assert.equal(a1.large_deposit_threshold_cents, 742_500n); assert.equal(a1.unsourced_large_deposits_cents, 0n, "a $7,000.00 deposit is under the 50%-of-income threshold"); assert.equal(a1.available_excluding_unsourced_cents, 6_194_011n); assert.equal(a1.shortfall_cents, 0n); assert.equal(a1.sufficient, true);
  assert.equal(money(421_280n), "$4,212.80"); assert.equal(money(6_194_011n), "$61,940.11");
  assert.equal(checkCollateral({ valuation_method: "value_acceptance", offer_date: D("2026-10-06"), note_date: D("2026-11-06"), evidence_refs: [] }).offer_age_days, 31);
  assert.equal(requiredMiCoveragePct(7000, 360), 0);
  assert.equal(checkVvoe({ vvoe_on: D("2026-10-27"), note_date: D("2026-11-06"), today: D("2026-10-28") }).business_days_before_note, 8);
  // worked example 2
  const a2 = recomputeAssets({ funds_to_close_cents: 4_532_055n, verified_assets_cents: 4_532_055n, monthly_qualifying_income_cents: 700_000n, deposits: [{ amount_cents: 1_460_000n, on: D("2026-09-30"), sourced: false, note: "bonus" }], gift: { amount_cents: 2_800_000n, amount_stated: true, no_repayment_stated: true, donor_name: "M. Donor", donor_relationship: null, donor_contact: null, document_id: "doc-gift-1" }, integrity_checks_pass: true, evidence_refs: [{ document_id: "doc-stmt-sep" }] });
  assert.equal(a2.large_deposit_threshold_cents, 350_000n); assert.equal(a2.unsourced_large_deposits_cents, 1_460_000n); assert.equal(a2.available_excluding_unsourced_cents, 3_072_055n); assert.equal(a2.shortfall_cents, 1_460_000n); assert.equal(a2.gift_pct_of_funds_to_close, 62); assert.equal(a2.sufficient, false);
  assert.equal(money(a2.available_excluding_unsourced_cents), "$30,720.55"); assert.equal(money(4_532_055n), "$45,320.55");
  const f2 = a2.findings.find((f) => f.sub_category === "large_deposit_unsourced")!, f1 = a2.findings.find((f) => f.sub_category === "gift_letter_incomplete")!;
  assert.equal(f2.severity, 1); assert.match(f2.description, /\$30,720\.55 against funds to close \$45,320\.55 — short by \$14,600\.00/); assert.equal(f1.severity, 2); assert.match(f1.description, /donor relationship, donor contact information/);
  assert.equal(requiredMiCoveragePct(9000, 360), 25); assert.equal(requiredMiCoveragePct(9001, 360), 30); assert.equal(requiredMiCoveragePct(9000, 180), 12); assert.equal(requiredMiCoveragePct(9500, 360, "homeready"), 25);
  assert.equal(checkMi({ ltv_x100: 9000, term_months: 360, coverage_pct: 25, certificate_issued: true, evidence_refs: [] }).finding, null);
  assert.equal(checkMi({ ltv_x100: 9000, term_months: 360, coverage_pct: 12, certificate_issued: true, evidence_refs: [] }).finding!.severity, 1);
  assert.equal(riskTriggers(PURCHASE_FEATURES).length, 2); assert.equal(riskTriggers({ ...PURCHASE_FEATURES, gift_funds_pct_of_funds_to_close: 50 }).length, 1);
  // sampling and cycle statistics (worked example 3)
  assert.equal(acceptanceProbability(7, 96), 0.073); assert.equal(acceptanceProbability(0, 96), 0); assert.equal(acceptanceProbability(3, 0), 1);
  assert.equal(randomTarget(118), 10); assert.equal(randomTarget(240), 12); assert.equal(randomTarget(118, 15), 15);
  assert.deepEqual(allocateStrata(10, [{ key: "a", volume: 90 }, { key: "b", volume: 9 }, { key: "c", volume: 1 }, { key: "d", volume: 0 }]).map((s) => s.quota), [8, 1, 1, 0]);
  assert.deepEqual(reportDue(D("2026-10-30")), { due: D("2026-11-29"), issue_target: D("2026-11-27") });
  assert.deepEqual(earliestConsummation(D("2026-11-13")).counted, ["2026-11-14", "2026-11-16", "2026-11-17"]);
});
