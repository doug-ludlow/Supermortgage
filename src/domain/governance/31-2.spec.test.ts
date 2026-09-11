// 31.2 AI governance, model risk, and fair-lending controls for AI underwriting, pricing, and adverse action
// spec/sections/31-cross-cutting-licensing-and-approvals-ai-governance-and-fair/31-2-ai-governance-model-risk-and-fair-lending-controls-for-ai-un.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_31_2 } from "../../app/tools/section31-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { type ReasonReplay, disparityTest, reasonAccuracy, reasonSampleSize, correctedStatementDue, driftReviewDue, partnerNoticeDue, reviewOpensOn, reviewDue, pricingExceptionReview, classifySystem, coDeveloperDocsGate, caAdmtReadinessGate, leakageTest, reviewerOverrideTest, policyReviewStatus, decisionRecord, systemState, originationDeployGate, inputsAttestation, poolingWindow, monthlyRunDue, governancePackDue, quarterlyRegressionDue } from "./ops-31-2.ts";

const QC: Actor = { kind: "agent", id: "qc-audit" };
const OFFICER: Actor = { kind: "human", id: "u-officer-1", role: "officer" };
const toolKey = (process: string, name: string): string => `${process} ${name}`;
/** The 31.2 bus alone: TOOLS_31_2 (`inventory.upsert`, `assess.draft` — every paragraph tool as an `op`) bound to `qc-audit` over the overridden registry (31.2 rows plus 19.3's referenced clocks), escalations and the entity store. */
function harness(nowIso: string, applicationId?: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, applicationId ? { applicationId } : {});
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["31.2", "19.3"] });
  const escalations = new EscalationService(events, clock); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", ...(applicationId ? { applicationId } : {}), events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, ports: {} };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const agents = new AgentRegistry(); const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_31_2) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = QC): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("31.2", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  /** Recurring rows re-arm on satisfaction, so the satisfied instance is never the last one: count them. */
  const satisfied = (code: string) => timers.byCode(code).filter((t) => t.status === "satisfied").length;
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  const sys = (id: string) => rt.store.get("ai_systems", id)!.data;
  const platform = (type: string, payload: Record<string, unknown>, extra: { applicationId?: string; aggregate?: { kind: string; id: string } } = {}) => events.append({ type, actor: { kind: "system", id: "platform" }, payload, ...extra });
  return { clock, events, timers, escalations, rt, uow, run, at, timer, satisfied, ofType, sys, platform, decisions };
}
const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
const PASS_TESTS = { leakage_clean: true, counterfactual_flip_rate: 0.004, directional_shift: false, outcome_parity_ok: true, explanation_consistent: true };
const CARD = { intended_uses: ["credit decision, counteroffer and NOIA recommendations under the partner's Selling Guide standards"], training_data_categories: ["provider's published training-data description", "SM evaluation datasets (synthetic)"], known_limitations: ["document-extraction error rates on handwritten statements", "variable-income coverage limited to Fannie Mae Income Calculator cases"], instructions_for_use_and_human_review: ["underwriting_reviewer approves every denial, counteroffer and NOIA", "second reviewer with reversal authority on request"] };
/** `underwriter` v3.0 in production, then v3.1 (prompt change, substantial) registered Mon Nov 9, 2026. */
async function underwriterV31(h: ReturnType<typeof harness>): Promise<void> {
  h.at("2026-09-15T12:00:00Z");
  await h.run("inventory.upsert", { id: "underwriter", agent_package: "underwriter", version: "3.0", prompt_version: "p3.0", model_version: "m-2026-08", change_date: "2026-09-15", substantial: true });
  h.at("2026-11-09T12:00:00Z");
  await h.run("inventory.upsert", { id: "underwriter", agent_package: "underwriter", version: "3.1", component: "prompt", prompt_version: "p3.1", model_version: "m-2026-08", change_date: "2026-11-09", substantial: true });
}

test("31.2-T1: Given `underwriter` v3.1 (prompt change, `substantial=true`) registered Mon Nov 9, 2026 with no approved `pre_deployment`/`material_modification` assessment, when deployment is requested, then `SM_O122_ORIGINATION_AI_DEPLOY_GATE` blocks and `ai_system.deploy.blocked` is emitted; given assessment approved Nov 12, eval pass Nov 13, bias tests pass Nov 13, partner notified Nov 13 and Colorado card delivered Nov 16, then deployment on Tue Nov 17, 2026 succeeds.", async () => {
  const h = harness("2026-09-15T12:00:00Z");
  await underwriterV31(h);
  const cls = classifySystem({ agent_package: "underwriter" });
  assert.equal(cls.materially_influences_consequential_decision, true); assert.equal(cls.co_admt_role, "developer"); assert.equal(cls.risk_tier, "high_consequential"); assert.equal(cls.ca_substantially_replaces_human, false);
  assert.equal(h.sys("underwriter").version, "3.1"); assert.equal(h.sys("underwriter").status, "registered");
  // the change arms the deploy gate (evaluator-backed), the 10-BD partner notice (Nov 9 → Tue Nov 24, 2026) and the Colorado material-update notice
  assert.equal(h.timer("SM_O122_ORIGINATION_AI_DEPLOY_GATE")?.status, "armed");
  assert.equal(h.timer("SM_O122_MODEL_CHANGE_NOTICE_TO_PARTNER_10BD")?.dueDate, "2026-11-24"); assert.equal(partnerNoticeDue(D("2026-11-09")), "2026-11-24");
  assert.equal(h.timer("CO_SB26_189_1702_MATERIAL_UPDATE_NOTICE")?.dueDate, "2026-11-24");
  // deployment is requested with nothing approved: blocked, `ai_system.deploy.blocked` emitted; the agent may never request it
  await refused(h.run("inventory.upsert", { op: "deploy", ai_system_id: "underwriter" }), "DEPLOY_APPROVAL_IS_THE_OFFICERS");
  const blocked = await h.run("inventory.upsert", { op: "deploy", ai_system_id: "underwriter", deploy_on: "2026-11-09" }, OFFICER);
  assert.equal(blocked.open, false); assert.equal(blocked.deployed, false);
  assert.ok((blocked.reasons as string[]).some((r) => r.includes("no approved pre_deployment/material_modification assessment")));
  assert.equal(h.ofType("ai_system.deploy.blocked").length, 1); assert.equal(h.ofType("ai_system.deploy.blocked")[0]!.payload.gate, "SM_O122_ORIGINATION_AI_DEPLOY_GATE");
  assert.equal(h.timer("SM_O122_ORIGINATION_AI_DEPLOY_GATE")?.status, "armed");
  // Nov 12: material-modification assessment drafted by qc-audit (inputs attested, proxy review) and approved by the officer with the partner officer's record
  h.at("2026-11-12T15:00:00Z");
  const draft = await h.run("assess.draft", { ai_system_id: "underwriter", kind: "material_modification", purpose: "prompt change v3.1: variable-income documentation ordering", inputs: ["monthly_income", "dti", "ltv", "representative_credit_score", "reserves"] });
  assert.equal(draft.inputs_attested, true); assert.deepEqual(draft.prohibited_inputs, []);
  await refused(h.run("assess.draft", { op: "approve", assessment_id: draft.assessment_id }), "ASSESSMENT_APPROVAL_IS_THE_OFFICERS");
  const approved = await h.run("assess.draft", { op: "approve", assessment_id: draft.assessment_id, completed_at: "2026-11-12", partner_officer_approved: true }, OFFICER);
  assert.equal(approved.approved, true); assert.equal(approved.next_due_at, "2027-11-12");
  assert.equal(h.ofType("ai_system.assessed")[0]!.payload.kind, "material_modification");
  assert.equal(h.timer("SM_O122_AI_ASSESSMENT_ANNUAL_365")?.dueDate, "2027-11-12");
  assert.equal(systemState(h.sys("underwriter")), "assessed");
  // Nov 13: eval pass, bias tests pass, partner notified
  h.at("2026-11-13T15:00:00Z");
  const ev = await h.run("inventory.upsert", { op: "eval", ai_system_id: "underwriter", suite: "uw-golden-v3", version: "3.1", metrics: { income_calc_accuracy: 0.99, du_condition_match: 0.97 }, pass: true, ran_on: "2026-11-13" });
  assert.equal(ev.pass, true); assert.equal(systemState(h.sys("underwriter")), "evaluated");
  const bias = await h.run("inventory.upsert", { op: "bias", ai_system_id: "underwriter", scope: "pre_deploy", tests: PASS_TESTS, ran_on: "2026-11-13", dataset_cases: 600 });
  assert.equal(bias.pass, true); assert.equal(systemState(h.sys("underwriter")), "bias_tested");
  await h.run("inventory.upsert", { op: "partner_notified", id: "underwriter", notified_at: "2026-11-13" });
  assert.equal(h.timer("SM_O122_MODEL_CHANGE_NOTICE_TO_PARTNER_10BD")?.status, "satisfied");
  // still blocked: the Colorado card is not delivered
  const stillBlocked = await h.run("inventory.upsert", { op: "deploy", ai_system_id: "underwriter", deploy_on: "2026-11-13" }, OFFICER);
  assert.deepEqual(stillBlocked.reasons, ["co_docs_delivered_to_deployer_at not set (CO_SB26_189_1702_MATERIAL_UPDATE_NOTICE / developer card)"]);
  // Nov 16: DOC_AI_SYSTEM_CARD delivered and the material-update notice sent to the deployer
  h.at("2026-11-16T15:00:00Z");
  const card = await h.run("inventory.upsert", { op: "card", ai_system_id: "underwriter", ...CARD, delivered_at: "2026-11-16", acknowledged_at: "2026-11-16" });
  assert.equal(card.complete, true); assert.equal(card.document_code, "DOC_AI_SYSTEM_CARD_underwriter_3.1"); assert.equal(card.retain_until, "2029-11-16");
  await h.run("inventory.upsert", { op: "material_update", ai_system_id: "underwriter", version: "3.1", notified_at: "2026-11-16" });
  assert.equal(h.timer("CO_SB26_189_1702_MATERIAL_UPDATE_NOTICE")?.status, "satisfied");
  assert.equal(systemState(h.sys("underwriter")), "partner_notified");
  // Tue Nov 17: deployment succeeds; the gate instance is satisfied by `ai_system.deploy.approved`
  h.at("2026-11-17T15:00:00Z");
  const deployed = await h.run("inventory.upsert", { op: "deploy", ai_system_id: "underwriter", deploy_on: "2026-11-17" }, OFFICER);
  assert.equal(deployed.open, true); assert.equal(deployed.deployed, true); assert.equal(deployed.deployed_on, "2026-11-17"); assert.equal(deployed.state, "deployed");
  assert.equal(h.ofType("ai_system.deploy.approved").length, 1);
  assert.equal(h.timer("SM_O122_ORIGINATION_AI_DEPLOY_GATE")?.status, "satisfied");
  assert.equal(originationDeployGate({ assessment_kind: "material_modification", assessment_approved: true, eval_pass: true, bias_tests_pass: true, risk_tier: "high_consequential", partner_notified_at: "2026-11-13", co_covered: true, co_docs_delivered_to_deployer_at: "2026-11-16", partner_officer_approved: true }).open, true);
});

test("31.2-T2: Given the October 2026 underwriting population (153/180 vs 558/620), when the monthly run executes on Nov 15, 2026, then the finding shows AIR 0.944, z −1.878, p ≈ 0.060, flag `screen`; given the pooled Aug–Oct population (470/540 vs 1,680/1,860), then z −2.200, p ≈ 0.028, flag `significant`, and with adjusted OR 0.91 and a 3.3-pp gap the flag is not `material` and no review clock opens.", async () => {
  const h = harness("2026-10-31T23:59:00Z");
  h.platform("period.month_end", { month: "2026-10", month_end: "2026-10-31", origination: true });
  assert.equal(h.timer("SM_O122_FAIR_LENDING_MONITOR_MONTHLY")?.dueDate, "2026-11-15"); assert.equal(monthlyRunDue(D("2026-10-31")), "2026-11-15");
  h.at("2026-11-15T12:00:00Z");
  const oct = await h.run("assess.draft", { op: "monitor", scope: "underwriting_outcomes", period: "2026-10", run_on: "2026-11-15", populations: [{ metric_code: "UW_APPROVAL_RATE", dimension: "ethnicity", group: "hispanic_or_latino", comparison_group: "not_hispanic_or_latino", n_group: 180, events_group: 153, n_comparison: 620, events_comparison: 558 }] });
  const f = (oct.findings as Record<string, unknown>[])[0]!;
  assert.equal(f.rate_group, 0.85); assert.equal(f.rate_comparison, 0.9);
  assert.equal(f.air, 0.944); assert.equal(f.screen_fails, false);     // passes the four-fifths screen
  assert.equal(f.z, -1.878); assert.equal(f.p_value, 0.06); assert.equal(f.significant, false); assert.equal(f.flag, "screen");
  assert.equal(h.ofType("fair_lending.finding.flagged")[0]!.payload.flag, "screen");
  assert.equal(h.ofType("fair_lending.run.completed")[0]!.payload.all_scopes, false);   // six of the seven monthly scopes still to run
  // pooled Aug–Oct with the logistic controls: significant, adjusted OR 0.91 inside 0.80–1.25 and a 3.3-pp gap → not material
  const pooled = await h.run("assess.draft", { op: "monitor", scope: "underwriting_outcomes", period: "2026-10", kind: "regression", controls: true, run_id: "uw-pooled-2026-08-10", run_on: "2026-11-15", populations: [{ metric_code: "UW_APPROVAL_RATE", dimension: "ethnicity", group: "hispanic_or_latino", comparison_group: "not_hispanic_or_latino", n_group: 540, events_group: 470, n_comparison: 1860, events_comparison: 1680, adjusted_or: 0.91, adjusted_or_ci: [0.72, 1.15], window_months: 3 }] });
  const p = (pooled.findings as Record<string, unknown>[])[0]!;
  assert.equal(p.air, 0.964); assert.equal(p.z, -2.2); assert.equal(p.p_value, 0.028); assert.equal(p.significant, true); assert.equal(p.flag, "significant");
  assert.equal(p.diff_pp, -3.3); assert.equal(p.material, false); assert.equal(p.review_clock, null);
  assert.deepEqual(pooled.reviews, []); assert.equal(h.rt.store.list("fair_lending_reviews").length, 0);
  assert.equal(h.timer("SM_O122_FAIR_LENDING_REVIEW_30D"), undefined);
  // the arithmetic itself (rule 5 worked example)
  const r = disparityTest({ n_group: 180, events_group: 153, n_comparison: 620, events_comparison: 558 });
  assert.equal(r.pooled_p, 0.88875); assert.ok(Math.abs(r.se - 0.026623) < 1e-6);
  const r2 = disparityTest({ n_group: 540, events_group: 470, n_comparison: 1860, events_comparison: 1680, adjusted_or: 0.91 });
  assert.ok(Math.abs(r2.se - 0.014932) < 1e-6); assert.ok(Math.abs(r2.pooled_p - 0.89583) < 1e-5);
  // small partner volume pools rather than reports false comfort
  assert.deepEqual(poolingWindow(12), { months: 3, power_limited: false }); assert.deepEqual(poolingWindow(4), { months: 12, power_limited: true });
  assert.equal(disparityTest({ n_group: 8, events_group: 6, n_comparison: 620, events_comparison: 558 }).flag, "suppressed");
  // row-level demographic data never leaves the enclave toward the agent
  await refused(h.run("assess.draft", { op: "monitor", scope: "underwriting_outcomes", period: "2026-10", populations: [{ n_group: 1, events_group: 1, n_comparison: 1, events_comparison: 1 }], rows: [{ application_id: "app-1", ethnicity: "hispanic_or_latino", approved: true }] }), "NO_ROW_LEVEL_DEMOGRAPHICS_TO_MODEL");
});

test("31.2-T3: Given the October 2026 counteroffer population (31/220 vs 52/610) with adjusted OR 1.48 (CI 1.05–2.09), then the finding is `material`, a `fair_lending_reviews` row opens Mon Nov 16, 2026 with `SM_O122_FAIR_LENDING_REVIEW_30D` due Wed Dec 16, 2026, and the review cannot close without a corrective action or a justification memo approved by an `officer`.", async () => {
  const h = harness("2026-11-15T12:00:00Z");
  const out = await h.run("assess.draft", { op: "monitor", scope: "steering_product_mix", period: "2026-10", run_on: "2026-11-15", populations: [{ metric_code: "UW_COUNTEROFFER_RATE", dimension: "ethnicity", group: "group_a", comparison_group: "comparison", n_group: 220, events_group: 31, n_comparison: 610, events_comparison: 52, adjusted_or: 1.48, adjusted_or_ci: [1.05, 2.09], adverse_direction: "higher" }] });
  const f = (out.findings as Record<string, unknown>[])[0]!;
  assert.equal(f.air, 1.653); assert.equal(f.z, 2.359); assert.equal(f.p_value, 0.018); assert.equal(f.diff_pp, 5.6); assert.equal(f.flag, "material");
  assert.equal(out.status, "flagged");
  // the review row opens the next creditor business day (Sun Nov 15 → Mon Nov 16) with the 30-day clock due Wed Dec 16, 2026
  const review = (out.reviews as Record<string, unknown>[])[0]!;
  assert.equal(review.opened_at, "2026-11-16"); assert.equal(review.due_on, "2026-12-16"); assert.equal(review.status, "open"); assert.equal(review.system_state, "monitored{remediation}");
  assert.equal(reviewOpensOn(D("2026-11-15")), "2026-11-16"); assert.equal(reviewDue(D("2026-11-16")), "2026-12-16");
  const t = h.timer("SM_O122_FAIR_LENDING_REVIEW_30D")!;
  assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-11-16"); assert.equal(t.dueDate, "2026-12-16");
  assert.equal(h.ofType("fair_lending.finding.flagged")[0]!.payload.flagged_at, "2026-11-16");
  assert.equal(h.escalations.list().filter((e) => e.kind === "officer" && e.payload.reason === "material_fair_lending_finding").length, 1);
  // closure: never by the agent; never by the officer without a corrective action or a legitimate justification
  await refused(h.run("assess.draft", { op: "close_review", finding_id: f.finding_id, corrective_actions: ["uw.counteroffer v2.1"] }), "FINDING_CLOSURE_IS_THE_OFFICERS");
  await assert.rejects(h.run("assess.draft", { op: "close_review", finding_id: f.finding_id, root_cause: "counteroffer logic proposed a lower loan amount before the B7-1 MI alternatives" }, OFFICER), (e: Error) => e instanceof RangeError && /corrective action or a documented legitimate justification/.test(e.message));
  assert.equal(h.timer("SM_O122_FAIR_LENDING_REVIEW_30D")?.status, "armed");
  // the agent never applies the rule-set change itself
  await refused(h.run("assess.draft", { op: "lda", subject: "uw.counteroffer", trigger: String(f.finding_id), alternatives: [{ description: "offer the least-restrictive eligible alternative first (B7-1 MI/coverage) before a lower amount", performance_delta: 0, disparity_delta: -0.04 }], apply_change: true }), "NO_RULE_CHANGE_ON_FINDING");
  const lda = await h.run("assess.draft", { op: "lda", subject: "uw.counteroffer", trigger: String(f.finding_id), finding_id: f.finding_id, alternatives: [{ description: "offer the least-restrictive eligible alternative first (B7-1 MI/coverage) before a lower amount", performance_delta: 0, disparity_delta: -0.04 }, { description: "drop counteroffers on Approve/Ineligible LTV", performance_delta: -0.05, disparity_delta: -0.06 }] });
  assert.equal(lda.selected, "offer the least-restrictive eligible alternative first (B7-1 MI/coverage) before a lower amount");
  h.at("2026-12-09T12:00:00Z");
  const closed = await h.run("assess.draft", { op: "close_review", finding_id: f.finding_id, root_cause: "counteroffer logic proposed a lower loan amount whenever DU returned Approve/Ineligible for LTV without first offering the B7-1 MI/coverage alternatives", corrective_actions: [{ rule_set: "uw.counteroffer", version: "2.1", deployed_on: "2026-12-09", re_gated: true }] }, OFFICER);
  assert.equal(closed.status, "closed"); assert.equal(closed.disposition, "corrective_action"); assert.equal(closed.lda_search_id, lda.search_id);
  assert.equal(h.timer("SM_O122_FAIR_LENDING_REVIEW_30D")?.status, "satisfied");
});

test("31.2-T4: Given 25 sampled October adverse actions with 24 matching replays, then `RA_REASON_ACCURACY` = 0.96, a corrective action is required, the mismatched borrower receives a corrected statement of reasons within 5 business days, and the November sample is 100 %.", async () => {
  const h = harness("2026-10-31T23:59:00Z");
  h.platform("period.month_end", { month: "2026-10", month_end: "2026-10-31", origination: true });
  assert.equal(h.timer("SM_O122_REASON_ACCURACY_SAMPLE_MONTHLY")?.dueDate, "2026-11-10");
  assert.equal(reasonSampleSize(31), 25); assert.equal(reasonSampleSize(20), 20);
  const matching = { issued_reasons: ["Excessive obligations in relation to income", "Delinquent past or present credit obligations"], replayed_reasons: ["Excessive obligations in relation to income", "Delinquent past or present credit obligations"] };
  const replays: ReasonReplay[] = Array.from({ length: 24 }, (_, k) => ({ adverse_action_id: `AA-2026-10-${k + 1}`, ...matching }));
  // the 21.6 fixture denial (Oct 26: DTI 51.3 % → reason 1; June 2026 30-day late → reason 2) replays exactly; one notice replays with the corrected income figure ranking "Insufficient income" first
  replays[0] = { adverse_action_id: "AA-2026-10-fixture", ...matching };
  replays.push({ adverse_action_id: "AA-2026-10-31", application_id: "app-mismatch", issued_reasons: ["Excessive obligations in relation to income", "Delinquent past or present credit obligations"], replayed_reasons: ["Insufficient income for amount of credit requested", "Delinquent past or present credit obligations"] });
  h.at("2026-11-10T12:00:00Z");
  const out = await h.run("assess.draft", { op: "reasons", period: "2026-10", population: 31, replays, ran_on: "2026-11-10" });
  assert.equal(out.accuracy, 0.96); assert.equal((out.population_counts as { sample: number }).sample, 25); assert.equal((out.population_counts as { matches: number }).matches, 24);
  assert.equal(out.corrective_action_required, true); assert.equal(out.full_rereview_required, false); assert.equal(out.next_month_sample_pct, 100);
  const corr = (out.corrections as Record<string, unknown>[])[0]!;
  assert.equal(corr.adverse_action_id, "AA-2026-10-31"); assert.equal(corr.corrected_statement_due, "2026-11-18");   // 5 creditor business days from Tue Nov 10 (Veterans Day Nov 11 excluded)
  assert.equal(correctedStatementDue(D("2026-11-10")), "2026-11-18");
  assert.equal(h.ofType("reason_accuracy.sample.completed")[0]!.payload.metric_code, "RA_REASON_ACCURACY");
  assert.equal(h.ofType("reason_accuracy.correction.required")[0]!.applicationId, "app-mismatch");
  assert.equal(h.timer("SM_O122_REASON_ACCURACY_SAMPLE_MONTHLY")?.status, "armed");   // 0.96 < 0.98 does not satisfy the clock
  assert.equal(h.escalations.list().filter((e) => e.kind === "officer" && e.payload.reason === "reason_accuracy_below_threshold").length, 1);
  await refused(h.run("assess.draft", { op: "reasons", period: "2026-10", population: 31, replays, notify_borrower: true }), "NO_BORROWER_CONTACT_ON_FL_REVIEW");
  // November at 100 %: every one of the month's 28 adverse actions replayed (rule-set uw.reasons v1.4 → v1.5 fixed the ordering)
  const nov = Array.from({ length: 28 }, (_, k) => ({ adverse_action_id: `AA-2026-11-${k + 1}`, ...matching }));
  assert.equal(reasonAccuracy({ population: 28, replays: nov.slice(0, 25) }).sample, 25);                        // the base rule: ≥ 25
  assert.throws(() => reasonAccuracy({ population: 28, replays: nov.slice(0, 25), sample_pct: 100 }), RangeError);   // November at 100 %: 25 < 28
  h.at("2026-12-10T12:00:00Z");
  const full = await h.run("assess.draft", { op: "reasons", period: "2026-11", population: 28, replays: nov, ran_on: "2026-12-10", sample_pct: 100 });
  assert.equal((full.population_counts as { sample: number }).sample, 28); assert.equal(full.accuracy, 1); assert.equal(full.corrective_action_required, false);
  assert.equal(h.satisfied("SM_O122_REASON_ACCURACY_SAMPLE_MONTHLY"), 1);
  // < 0.95 → 100 % re-review by underwriting_reviewer, sev 1
  const bad = reasonAccuracy({ population: 25, replays: replays.slice(0, 23).concat([replays[24]!, replays[24]!]) });
  assert.equal(bad.accuracy, 0.92); assert.equal(bad.full_rereview_required, true); assert.equal(bad.severity, "sev1");
});

test("31.2-T5: Given the Q3 2026 pricing-exception counts (22/140 vs 41/190), then AIR 0.728 → `screen`, z −1.340, p ≈ 0.180 → not `significant`; the finding is pooled to the 12-month window and every exception carries a reason code.", async () => {
  const h = harness("2026-09-30T23:59:00Z");
  h.platform("period.month_end", { month: "2026-09", month_end: "2026-09-30", origination: true });
  assert.equal(h.timer("SM_O122_PRICING_EXCEPTION_REVIEW_MONTHLY")?.dueDate, "2026-10-10");
  const codes = ["competitor_match_documented", "error_correction", "cure", "relationship_policy"];
  const exceptions = Array.from({ length: 63 }, (_, k) => ({ reason_code: codes[k % 4]!, discretionary: false }));
  h.at("2026-10-10T12:00:00Z");
  const out = await h.run("assess.draft", { op: "monitor", scope: "pricing_exceptions", period: "2026-09", run_on: "2026-10-10", populations: [{ metric_code: "PR_EXCEPTION_GRANT_RATE", dimension: "race", group: "group_a", comparison_group: "comparison", n_group: 140, events_group: 22, n_comparison: 190, events_comparison: 41, window_months: 3, exceptions }] });
  const f = (out.findings as Record<string, unknown>[])[0]!;
  assert.equal(f.air, 0.728); assert.equal(f.screen_fails, true); assert.equal(f.flag, "screen");
  assert.equal(f.z, -1.34); assert.equal(f.p_value, 0.18); assert.equal(f.significant, false); assert.equal(f.material, false);
  assert.equal(f.pooled_to_12m, true); assert.equal(f.all_exceptions_coded, true);
  assert.deepEqual(f.reason_mix, { competitor_match_documented: 16, error_correction: 16, cure: 16, relationship_policy: 15 });
  assert.deepEqual(out.reviews, []);
  assert.equal(h.satisfied("SM_O122_PRICING_EXCEPTION_REVIEW_MONTHLY"), 1);
  // an exception without a documented, non-discretionary reason code fails the coding check (25.1: discretionary pricing is not a legal value)
  const r = pricingExceptionReview({ exceptions: [...exceptions, { reason_code: "manager_discretion", discretionary: true }], counts: { n_group: 140, events_group: 22, n_comparison: 190, events_comparison: 41 } });
  assert.equal(r.all_coded, false); assert.equal(r.uncoded, 1); assert.equal(r.disposition, "screen_pooled_12m");
  assert.ok(Math.abs(r.result.se - 0.043775) < 1e-6); assert.ok(Math.abs(r.result.pooled_p - 0.19091) < 1e-5);
});

test("31.2-T6: Given a Colorado consumer's application on Tue Jan 5, 2027 and no acknowledged developer card for `underwriter` v3.1, then the application is routed to the human path and `CO_SB26_189_1702_DEVELOPER_DOCS_GATE` reports blocked; given cards acknowledged Dec 15, 2026, the gate is open and the 21.6 artifacts apply.", async () => {
  const h = harness("2026-09-15T12:00:00Z");
  await underwriterV31(h);
  h.at("2027-01-05T15:00:00Z");
  h.platform("application.received", { application_id: "app-co-1", application_date: "2027-01-05", property_state: "CO", consumer_state: "CO" }, { applicationId: "app-co-1" });
  assert.equal(h.timer("CO_SB26_189_1702_DEVELOPER_DOCS_GATE")?.status, "armed"); assert.equal(h.timer("CO_SB26_189_1702_DEVELOPER_DOCS_GATE")?.subject.id, "app-co-1");
  const blocked = await h.run("inventory.upsert", { op: "co_docs", application_id: "app-co-1", ai_system_id: "underwriter", consumer_state: "CO", on: "2027-01-05" });
  assert.equal(blocked.applies, true); assert.equal(blocked.blocked, true); assert.equal(blocked.route, "human_path"); assert.equal(blocked.gate, "CO_SB26_189_1702_DEVELOPER_DOCS_GATE");
  assert.deepEqual(blocked.reasons, ["DOC_AI_SYSTEM_CARD not delivered to the deployer (6-1-1702)"]);
  assert.equal(h.ofType("ai_governance.path.routed")[0]!.payload.path, "human_path"); assert.equal(h.ofType("ai_governance.path.routed")[0]!.applicationId, "app-co-1");
  assert.equal(h.escalations.list().filter((e) => e.kind === "sev1" && e.applicationId === "app-co-1").length, 1);
  assert.equal(h.timer("CO_SB26_189_1702_DEVELOPER_DOCS_GATE")?.status, "satisfied");   // the routing record answers the per-application gate
  // delivered but unacknowledged is still blocked; acknowledged Tue Dec 15, 2026 opens the gate
  assert.equal(coDeveloperDocsGate({ consumer_state: "CO", on: D("2027-01-05"), materially_influences_consequential_decision: true, co_admt_role: "developer", co_docs_delivered_to_deployer_at: "2026-12-15", co_docs_acknowledged_at: null }).reasons[0], "DOC_AI_SYSTEM_CARD delivered but not acknowledged by the deployer");
  assert.equal(coDeveloperDocsGate({ consumer_state: "CO", on: D("2026-12-15"), materially_influences_consequential_decision: true, co_admt_role: "developer", co_docs_delivered_to_deployer_at: null, co_docs_acknowledged_at: null }).applies, false);   // before 2027-01-01
  assert.equal(coDeveloperDocsGate({ consumer_state: "AZ", on: D("2027-01-05"), materially_influences_consequential_decision: true, co_admt_role: "developer", co_docs_delivered_to_deployer_at: null, co_docs_acknowledged_at: null }).applies, false);
  h.at("2026-12-15T15:00:00Z");
  await h.run("inventory.upsert", { op: "card", ai_system_id: "underwriter", ...CARD, delivered_at: "2026-12-15", acknowledged_at: "2026-12-15" });
  assert.equal(h.ofType("co_admt.developer_docs.delivered")[0]!.payload.acknowledged, true);
  h.at("2027-01-05T16:00:00Z");
  h.platform("application.received", { application_id: "app-co-2", application_date: "2027-01-05", property_state: "CO", consumer_state: "CO" }, { applicationId: "app-co-2" });
  const open = await h.run("inventory.upsert", { op: "co_docs", application_id: "app-co-2", ai_system_id: "underwriter", consumer_state: "CO", on: "2027-01-05" });
  assert.equal(open.open, true); assert.equal(open.blocked, false); assert.equal(open.route, "admt");
  assert.deepEqual(open.artifacts, ["NTC_CO_SB26_189_ADMT_NOTICE{pre_use}", "CO_SB26_189_1704_ADVERSE_EXPLANATION_30", "CO_SB26_189_1705_HUMAN_REVIEW_30"]);
  assert.equal(h.timers.byCode("CO_SB26_189_1702_DEVELOPER_DOCS_GATE").length, 2); assert.equal(h.timer("CO_SB26_189_1702_DEVELOPER_DOCS_GATE")?.status, "satisfied");
});

test("31.2-T7: Given an `agent_runs.inputs_manifest` containing `language_preference` for a pricing decision, then the leakage test fails, the run is quarantined, `pricing` is `restricted` for `pricing_quote` until re-tested, and a sev-1 review opens.", async () => {
  const h = harness("2026-11-20T12:00:00Z");
  await h.run("inventory.upsert", { id: "pricing", agent_package: "pricing", version: "2.4", prompt_version: "p2.4", model_version: "m-2026-08", change_date: "2026-10-01" });
  const r = leakageTest({ run_id: "run-77", ai_system_id: "pricing", decision_kind: "pricing_quote", inputs_manifest: { loan_amount_cents: 56_000_000n, ltv: "70.0", representative_credit_score: 742, lock_period_days: 45, language_preference: "es" } });
  assert.equal(r.pass, false); assert.deepEqual(r.fields, ["language_preference"]); assert.equal(r.quarantine, true); assert.deepEqual(r.restrict, { ai_system_id: "pricing", decision_kinds: ["pricing_quote"] }); assert.equal(r.severity, "sev1");
  assert.equal(leakageTest({ run_id: "run-78", ai_system_id: "pricing", decision_kind: "pricing_quote", inputs_manifest: ["loan_amount_cents", "ltv", "representative_credit_score", "state"] }).pass, true);
  const out = await h.run("inventory.upsert", { op: "leakage", run_id: "run-77", ai_system_id: "pricing", decision_kind: "pricing_quote", inputs_manifest: { loan_amount_cents: "56000000", ltv: "70.0", representative_credit_score: 742, language_preference: "es" } });
  assert.equal(out.pass, false); assert.equal(out.quarantine, true); assert.deepEqual(out.restricted_decision_kinds, ["pricing_quote"]); assert.deepEqual(out.review, { severity: "sev1", opened: true });
  assert.equal(h.ofType("agent_run.quarantined").length, 1); assert.equal(h.ofType("ai.bias_test.attribute_leakage")[0]!.payload.pass, false);
  assert.deepEqual(h.sys("pricing").restricted_decision_kinds, ["pricing_quote"]); assert.equal(h.sys("pricing").status, "restricted"); assert.equal(systemState(h.sys("pricing")), "restricted");
  assert.equal(h.ofType("ai_system.restricted")[0]!.payload.reason, "attribute leakage on run run-77: language_preference — restricted until re-tested");
  assert.equal(h.escalations.list().filter((e) => e.kind === "sev1" && e.payload.reason === "attribute_leakage").length, 1);
  assert.equal(h.rt.store.get("agent_runs", "run-77")!.data.quarantined, true);
  // "until re-tested": lifting the restriction needs the re-test's eval run
  await assert.rejects(h.run("inventory.upsert", { op: "unrestrict", id: "pricing", decision_kinds: ["pricing_quote"], reason: "manifest tokenized" }), RangeError);
  await h.run("inventory.upsert", { op: "eval", ai_system_id: "pricing", suite: "pricing-golden-v2", version: "2.4", metrics: { llpa_match: 1 }, pass: true, ran_on: "2026-11-21" });
  const lifted = await h.run("inventory.upsert", { op: "unrestrict", id: "pricing", decision_kinds: ["pricing_quote"], reason: "language_preference tokenized in the pricing packet; re-tested", eval_run_id: "pricing:2.4:pricing-golden-v2:2026-11-21" });
  assert.deepEqual(lifted.restricted_decision_kinds, []); assert.notEqual(lifted.status, "restricted");
  // the inputs attestation for the assessment classifies the same field as prohibited
  assert.deepEqual(inputsAttestation(["dti", "language_preference", "zip_code"]).prohibited, ["language_preference", "zip_code"]);
});

test("31.2-T8: Given the model provider ships a new model version on Wed Dec 2, 2026 without notice, then the golden-set eval detects drift, high-risk decision kinds are `restricted` within the `SM_O122_DRIFT_ALERT_REVIEW_2BD` window (due Fri Dec 4), and a 19.3 vendor-SLA breach is logged.", async () => {
  const h = harness("2026-11-17T12:00:00Z");
  await h.run("inventory.upsert", { id: "underwriter", agent_package: "underwriter", version: "3.1", prompt_version: "p3.1", model_version: "m-2026-08", change_date: "2026-11-09", substantial: true, vendor_id: "vendor-model-provider" });
  h.at("2026-12-02T12:00:00Z");
  const out = await h.run("inventory.upsert", { op: "eval", ai_system_id: "underwriter", suite: "uw-golden-v3", version: "3.1", ran_on: "2026-12-02", baseline: { income_calc_accuracy: 0.99, du_condition_match: 0.97 }, metrics: { income_calc_accuracy: 0.93, du_condition_match: 0.96 }, provider_model_version: "m-2026-12" });
  const drift = out.drift as Record<string, unknown>;
  assert.equal(drift.drift, true); assert.equal(drift.review_due, "2026-12-04"); assert.equal(driftReviewDue(D("2026-12-02")), "2026-12-04");
  assert.deepEqual(drift.restricted_decision_kinds, ["credit_decision", "counteroffer", "noia", "condition_waiver"]);
  assert.equal(drift.vendor_sla_breach_logged, true); assert.equal(out.state, "restricted"); assert.equal(out.pass, false);
  assert.equal(h.ofType("ai.monitor.drift_detected")[0]!.payload.metric, "income_calc_accuracy"); assert.equal(h.ofType("ai.monitor.drift_detected")[0]!.payload.silent_provider_update, true);
  assert.deepEqual(h.sys("underwriter").restricted_decision_kinds, ["credit_decision", "counteroffer", "noia", "condition_waiver"]); assert.equal(h.sys("underwriter").status, "restricted");
  const t = h.timer("SM_O122_DRIFT_ALERT_REVIEW_2BD")!;
  assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-12-02"); assert.equal(t.dueDate, "2026-12-04");
  const sla = h.ofType("vendor.sla_breach.logged")[0]!;
  assert.equal(sla.payload.clause, "VERSION_CHANGE_NOTICE"); assert.equal(sla.payload.vendor_id, "vendor-model-provider"); assert.equal(sla.payload.provider_model_version, "m-2026-12");
  assert.equal(h.escalations.list().filter((e) => e.kind === "sev1" && e.payload.reason === "drift_detected").length, 1);
  // disposition within the window closes the clock; a roll-back keeps the restriction until re-evaluated
  h.at("2026-12-03T12:00:00Z");
  const disposed = await h.run("inventory.upsert", { op: "drift_dispose", alert_id: drift.alert_id, disposition: "roll_back" });
  assert.equal(disposed.disposition, "roll_back"); assert.equal(h.timer("SM_O122_DRIFT_ALERT_REVIEW_2BD")?.status, "satisfied");
  assert.equal(h.sys("underwriter").status, "restricted");
  // a provider version change that was noticed is no SLA breach
  await h.run("inventory.upsert", { id: "pricing", agent_package: "pricing", version: "2.4", prompt_version: "p2.4", model_version: "m-2026-08", change_date: "2026-10-01" });
  const noticed = await h.run("inventory.upsert", { op: "eval", ai_system_id: "pricing", suite: "pricing-golden-v2", version: "2.4", ran_on: "2026-12-02", baseline: { llpa_match: 1 }, metrics: { llpa_match: 0.9 }, provider_model_version: "m-2026-12", provider_notice_received: true });
  assert.equal((noticed.drift as Record<string, unknown>).vendor_sla_breach_logged, false); assert.equal(h.ofType("vendor.sla_breach.logged").length, 1);
});

test("31.2-T9: Given `jurisdiction_rules.ai_governance.ca_admt.applicability_position = applies` and no live California pre-use notice on Jan 1, 2027, then California applications are routed to the human path until `CA_CPPA_7200_ADMT_READINESS_20270101` is satisfied.", async () => {
  const h = harness("2026-12-01T12:00:00Z");
  await h.run("inventory.upsert", { op: "jurisdiction", state: "CA", ai_governance: { ca_admt: { applies_from: "2027-01-01", applicability_position: "applies", pre_use_notice_template: "NTC_CA_CPPA_7220_ADMT_PRE_USE", optout_exception: "human_appeal" }, fair_lending_disparate_impact: "statutory_or_regulatory_verified", citations: ["2 CCR §12060", "11 CCR §7200"] } });
  assert.equal(h.timer("CA_CPPA_7200_ADMT_READINESS_20270101")?.status, "armed"); assert.equal(h.timer("CA_CPPA_7200_ADMT_READINESS_20270101")?.anchorDate, "2027-01-01");
  assert.equal(h.timer("CA_CPPA_7150_RISK_ASSESSMENT_20271231")?.dueDate, "2027-12-31"); assert.equal(h.timer("CA_CPPA_7157_ATTESTATION_20280401")?.dueDate, "2028-04-01");
  h.at("2027-01-01T15:00:00Z");
  const routed = await h.run("inventory.upsert", { op: "ca_readiness_gate", application_id: "app-ca-1", consumer_state: "CA", on: "2027-01-01" });
  assert.equal(routed.applies, true); assert.equal(routed.route, "human_path"); assert.equal(routed.blocked, true);
  assert.deepEqual(routed.reasons, ["NTC_CA_CPPA_7220_ADMT_PRE_USE not live (§7220)", "opt-out / human-appeal route not live (§7221(c)(1); human-appeal exception)", "access-request procedure (plain-language explanation) not live (§7222)"]);
  assert.equal(h.ofType("ai_governance.path.routed")[0]!.payload.gate, "CA_CPPA_7200_ADMT_READINESS_20270101");
  assert.equal(h.timer("CA_CPPA_7200_ADMT_READINESS_20270101")?.status, "armed");
  // not applicable before the compliance date, outside California, or while the position is exempt_glba / unresolved
  assert.equal(caAdmtReadinessGate({ applicability_position: "applies", on: D("2026-12-31"), consumer_state: "CA", preuse_notice_live: false, optout_route_live: false, access_procedure_live: false }).applies, false);
  assert.equal(caAdmtReadinessGate({ applicability_position: "exempt_glba", on: D("2027-01-01"), consumer_state: "CA", preuse_notice_live: false, optout_route_live: false, access_procedure_live: false }).route, "admt");
  assert.equal(caAdmtReadinessGate({ applicability_position: "applies", on: D("2027-01-01"), consumer_state: "AZ", preuse_notice_live: false, optout_route_live: false, access_procedure_live: false }).applies, false);
  // partial readiness stays closed; all three live satisfies the one-time gate
  await h.run("inventory.upsert", { op: "ca_readiness", preuse_notice_live: true, optout_route_live: true, access_procedure_live: false });
  assert.equal(h.ofType("ca_admt.readiness.confirmed").length, 0);
  h.at("2027-01-04T15:00:00Z");
  const live = await h.run("inventory.upsert", { op: "ca_readiness", preuse_notice_live: true, optout_route_live: true, access_procedure_live: true });
  assert.equal(live.live, true); assert.equal(h.timer("CA_CPPA_7200_ADMT_READINESS_20270101")?.status, "satisfied");
  const open = await h.run("inventory.upsert", { op: "ca_readiness_gate", application_id: "app-ca-2", consumer_state: "CA", on: "2027-01-04" });
  assert.equal(open.route, "admt"); assert.equal(open.blocked, false);
  // the CA opt-out is satisfied by the human-appeal exception: a rights request routes the file to the human path
  const req = await h.run("inventory.upsert", { op: "rights_request", application_id: "app-ca-2", kind: "ca_optout", received_at: "2027-01-05T10:00:00Z", channel: "web" });
  assert.equal(req.due_at, "2027-02-19"); assert.equal(req.routed_to, "ca_path"); assert.equal(h.ofType("ai_rights.request.received")[0]!.payload.kind, "ca_optout");
});

test("31.2-T10: Given a Fannie Mae LL-2026-04 disclosure request received Mon Oct 5, 2026, then the response package (types, purposes, manner, safeguards, inventory export) is compiled from the Q3 pack and an `officer` task exists with the 19.3 due date Mon Oct 12, 2026.", async () => {
  const h = harness("2026-10-02T12:00:00Z");
  await h.run("inventory.upsert", { id: "underwriter", agent_package: "underwriter", version: "3.0", prompt_version: "p3.0", model_version: "m-2026-08", change_date: "2026-09-15" });
  await h.run("inventory.upsert", { id: "compliance-tester", agent_package: "compliance-tester", version: "1.3", prompt_version: "n/a", model_version: "rules", model_class: "rules_deterministic", change_date: "2026-09-15" });
  h.platform("period.quarter_end", { quarter: "2026-Q3", quarter_end: "2026-09-30", origination: true });
  assert.equal(h.timer("SM_O122_GOVERNANCE_PACK_QUARTERLY")?.dueDate, "2026-10-30"); assert.equal(governancePackDue(D("2026-09-30")), "2026-10-30");
  assert.equal(h.timer("SM_O122_FAIR_LENDING_REGRESSION_QUARTERLY")?.dueDate, "2026-10-20"); assert.equal(quarterlyRegressionDue(D("2026-09-30")), "2026-10-20");
  const pack = await h.run("assess.draft", { op: "pack", period: "2026-Q3", issued_on: "2026-10-02" });
  assert.equal(pack.document_code, "PACK_AI_GOVERNANCE_2026-Q3"); assert.equal(h.satisfied("SM_O122_GOVERNANCE_PACK_QUARTERLY"), 1);
  assert.equal(((pack.contents as Record<string, unknown>).inventory_export as unknown[]).length, 2);
  // Mon Oct 5, 2026: the request arrives through 19.3 (`fnma.request.received{kind=ll2026_04_disclosure}` arms FNMA_LL2026_04_DISCLOSURE_PROMPT_5BD)
  h.at("2026-10-05T14:00:00Z");
  h.platform("fnma.request.received", { kind: "ll2026_04_disclosure", request_id: "FNMA-REQ-2026-10-05", received_at: "2026-10-05", due_at: "2026-10-13", transition_plan: false }, { aggregate: { kind: "fnma_information_requests", id: "FNMA-REQ-2026-10-05" } });
  const out = await h.run("assess.draft", { op: "fnma_disclosure", request_id: "FNMA-REQ-2026-10-05", received_on: "2026-10-05" });
  const resp = out.response as Record<string, unknown>;
  assert.deepEqual(resp.types, ["llm_agent", "rules_deterministic"]);
  assert.equal((resp.purposes as string[]).length, 2); assert.ok((resp.manner as string[])[0]!.includes("recommendations to underwriting_reviewer/mlo_of_record"));
  assert.ok((resp.safeguards as string[]).some((s) => s.includes("SM_O122_ORIGINATION_AI_DEPLOY_GATE")) && (resp.safeguards as string[]).some((s) => s.includes("no restricted demographic field")));
  assert.equal((resp.inventory_export as unknown[]).length, 2); assert.equal(resp.source_pack, "PACK_AI_GOVERNANCE_2026-Q3");
  const task = out.officer_task as Record<string, unknown>;
  assert.equal(task.kind, "officer");
  // The spec's "Mon Oct 12, 2026" ignores Columbus Day: 5 Fannie Mae ET business days from Mon Oct 5 land on Tue Oct 13, 2026 (19.3-T10, docs/AUDIT-NOTES.md) — the engine's date is asserted.
  assert.equal(task.due, "2026-10-13"); assert.equal(out.timer, "FNMA_LL2026_04_DISCLOSURE_PROMPT_5BD");
  assert.equal(h.timer("FNMA_LL2026_04_DISCLOSURE_PROMPT_5BD")?.dueDate, "2026-10-13");
  const esc = h.escalations.list().find((e) => e.kind === "officer" && e.payload.request_id === "FNMA-REQ-2026-10-05")!;
  assert.equal(esc.payload.due_on, "2026-10-13"); assert.equal(esc.payload.source_pack, "PACK_AI_GOVERNANCE_2026-Q3");
  await refused(h.run("assess.draft", { op: "fnma_disclosure", request_id: "FNMA-REQ-2026-10-05", received_on: "2026-10-05", send: true }), "FNMA_DISCLOSURE_SENT_BY_OFFICER");
});

test("31.2-T11: Given a reviewer approving 100 % of 40 denial recommendations with median review time 45 seconds in a month, then `UW_REVIEWER_OVERRIDE_RATE`/time metrics flag the reviewer, `ca_substantially_replaces_human` is set true for the affected system until retraining is evidenced, and the partner is notified in the pack.", async () => {
  const h = harness("2026-11-05T12:00:00Z");
  await h.run("inventory.upsert", { id: "underwriter", agent_package: "underwriter", version: "3.0", prompt_version: "p3.0", model_version: "m-2026-08", change_date: "2026-09-15" });
  assert.equal(h.sys("underwriter").ca_substantially_replaces_human, false);
  const m = reviewerOverrideTest({ reviewer_id: "u-uwr-9", recommendations: 40, approved: 40, median_review_seconds: 45 });
  assert.equal(m.metric_code, "UW_REVIEWER_OVERRIDE_RATE"); assert.equal(m.override_rate, 0); assert.equal(m.flagged, true); assert.equal(m.ca_substantially_replaces_human, true);
  assert.equal(reviewerOverrideTest({ reviewer_id: "u-uwr-2", recommendations: 40, approved: 37, median_review_seconds: 45 }).flagged, false);
  assert.equal(reviewerOverrideTest({ reviewer_id: "u-uwr-3", recommendations: 40, approved: 40, median_review_seconds: 240 }).flagged, false);
  const out = await h.run("assess.draft", { op: "reviewer_metrics", reviewer_id: "u-uwr-9", recommendations: 40, approved: 40, median_review_seconds: 45, ai_system_id: "underwriter", period: "2026-10" });
  assert.equal(out.flagged, true); assert.equal(out.partner_notified_in_pack, true);
  assert.equal(h.sys("underwriter").ca_substantially_replaces_human, true);
  assert.equal(h.ofType("ai_system.human_involvement.flagged")[0]!.payload.reviewer_id, "u-uwr-9");
  const pack = await h.run("assess.draft", { op: "pack", period: "2026-Q4", issued_on: "2027-01-15" });
  assert.deepEqual(pack.exceptions, ["underwriter: reviewer u-uwr-9: 2026-10 approval rate 100 % with median review 45 s — retraining"]);
  assert.deepEqual((pack.contents as Record<string, unknown>).reviewer_flags, ["u-uwr-9"]);
  assert.equal(((pack.contents as Record<string, unknown>).inventory_export as Record<string, unknown>[])[0]!.ca_substantially_replaces_human, true);
});

test("31.2-T12: Given the annual policy review not completed by the anniversary of the last review, then 19.3's `FNMA_LL2026_04_POLICY_REVIEW_365` breaches sev 2 and the next pack carries the exception.", async () => {
  const h = harness("2025-11-01T12:00:00Z");
  // 19.3's `ai_systems.upsert{policy}` appends `ai.policy.approved{approved_on}` — the referenced clock arms on it (never redefined here)
  h.platform("ai.policy.approved", { policy_code: "POL-AI-01", version: "1.0", owner: "chief_compliance_officer", approved_on: "2025-11-01" }, { aggregate: { kind: "ai_policy_documents", id: "POL-AI-01" } });
  const t = h.timer("FNMA_LL2026_04_POLICY_REVIEW_365")!;
  assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2026-11-01");
  const status = policyReviewStatus({ last_reviewed_on: D("2025-11-01"), today: D("2026-11-02"), reviewed_since: false });
  assert.equal(status.due, "2026-11-01"); assert.equal(status.breached, true); assert.equal(status.severity, 2);
  assert.equal(policyReviewStatus({ last_reviewed_on: D("2025-11-01"), today: D("2026-11-01"), reviewed_since: false }).breached, false);
  const breaches = h.timers.evaluate("2026-11-02T12:00:00Z");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "FNMA_LL2026_04_POLICY_REVIEW_365"); assert.equal(breaches[0]!.severity, 2); assert.deepEqual(breaches[0]!.escalateTo, ["officer"]);
  assert.equal(h.timer("FNMA_LL2026_04_POLICY_REVIEW_365")?.status, "breached");
  h.at("2027-01-15T12:00:00Z");
  const pack = await h.run("assess.draft", { op: "pack", period: "2026-Q4", issued_on: "2027-01-15", policy_last_reviewed_on: "2025-11-01", policy_reviewed_since: false });
  assert.deepEqual(pack.exceptions, ["FNMA_LL2026_04_POLICY_REVIEW_365 breached: annual review of POL-AI-01 due 2026-11-01 not completed"]);
  const reviewed = await h.run("assess.draft", { op: "pack", period: "2027-Q1", issued_on: "2027-04-15", policy_last_reviewed_on: "2025-11-01", policy_reviewed_since: true });
  assert.deepEqual(reviewed.exceptions, []);
});

test("31.2-T13: Given AI off, then the human path produces `agent_decisions` rows with `human_involvement_level = decided_by_human` and the monthly monitor runs on them unchanged.", async () => {
  const h = harness("2026-10-23T15:00:00Z", "app-1");
  const rec = decisionRecord({ ai_off: true, decision_kind: "credit_decision", principal_factors: ["dti_max_50", "credit_delinquent"], reviewer_action: "approved", inputs_manifest: ["monthly_income", "dti", "credit_report"], rationale: "dti_max_50 failed at 51.3 %; credit_delinquent (30-day late, June 2026)" });
  assert.equal(rec.ok, true); assert.equal(rec.human_involvement_level, "decided_by_human"); assert.equal(rec.co_material_influence, false);
  assert.deepEqual(rec.retention_classes, ["co_admt_3y", "regb_25m", "fnma_loan_file_life_plus_4y"]);
  assert.equal(decisionRecord({ ai_off: false, decision_kind: "credit_decision", principal_factors: ["dti_max_50"], reviewer_action: "approved", inputs_manifest: ["dti"], rationale: "dti_max_50" }).human_involvement_level, "review_authority");
  assert.deepEqual(decisionRecord({ ai_off: false, decision_kind: "credit_decision", principal_factors: ["dti_max_50"], reviewer_action: null, inputs_manifest: ["dti"], rationale: "dti_max_50" }).refusals, ["reviewer_action required on a denial/counteroffer/NOIA"]);
  const row = await h.run("assess.draft", { op: "decision_record", ai_off: true, application_id: "app-1", decision_kind: "credit_decision", outcome: "denial", principal_factors: ["dti_max_50", "credit_delinquent"], reviewer_action: "approved", reviewer_id: "u-uwr-1", inputs_manifest: ["monthly_income", "dti", "credit_report"], rationale: "dti_max_50 failed at 51.3 %; credit_delinquent (30-day late, June 2026)", rule_set_version: "uw.reasons v1.5" }, { kind: "human", id: "u-uwr-1", role: "underwriting_reviewer" });
  assert.equal(row.human_involvement_level, "decided_by_human"); assert.equal(row.agent, "human_path"); assert.equal(row.model_version, null); assert.equal(row.prompt_version, null);
  const dec = h.decisions.find((d) => d.action === "decision:credit_decision")!;   // the decision record itself (the bus adds its own command audit row)
  assert.equal(dec.agent, "human_path"); assert.equal(dec.applicationId, "app-1"); assert.equal(dec.ruleSetVersion, "uw.reasons v1.5"); assert.equal(dec.modelVersion, null);
  assert.equal(h.ofType("agent_decision.recorded")[0]!.payload.human_involvement_level, "decided_by_human");
  // the rationale guard refuses a prohibited basis or proxy in the rationale
  await refused(h.run("assess.draft", { op: "decision_record", ai_off: true, decision_kind: "credit_decision", principal_factors: ["dti_max_50"], reviewer_action: "approved", inputs_manifest: ["dti"], rationale: "applicant's language preference and zip code suggest higher risk" }), "RATIONALE_GUARD");
  // the monthly monitor runs on the human-path population unchanged (AI-vs-human split becomes human-only)
  h.at("2026-11-15T12:00:00Z");
  const out = await h.run("assess.draft", { op: "monitor", scope: "underwriting_outcomes", period: "2026-10", run_on: "2026-11-15", ai_off: true, populations: [{ metric_code: "UW_APPROVAL_RATE", dimension: "ethnicity", group: "hispanic_or_latino", comparison_group: "not_hispanic_or_latino", n_group: 180, events_group: 153, n_comparison: 620, events_comparison: 558, ai_vs_human_split: { human_only: true } }] });
  const f = (out.findings as Record<string, unknown>[])[0]!;
  assert.equal(out.human_only, true); assert.equal(f.air, 0.944); assert.equal(f.z, -1.878); assert.equal(f.p_value, 0.06); assert.equal(f.flag, "screen");
  assert.deepEqual(f.ai_vs_human_split, { human_only: true });
});

test("31.2 worked figures: rules 4–7 arithmetic (AIR, pooled p, SE, z, p-value, materiality) and the clocks the worked examples name", () => {
  // rule 5 — October 2026 approvals: AIR 0.850/0.900 = 0.944; pooled p 711/800 = 0.88875; SE 0.026623; z −1.878; p ≈ 0.060 → screen
  const oct = disparityTest({ n_group: 180, events_group: 153, n_comparison: 620, events_comparison: 558 });
  assert.equal(oct.air, 0.944); assert.equal(oct.pooled_p, 711 / 800); assert.ok(Math.abs(oct.se - 0.026623) < 1e-6); assert.equal(oct.z, -1.878); assert.equal(oct.p_value, 0.06); assert.equal(oct.flag, "screen");
  // pooled Aug–Oct: 470/540 (87.04 %) vs 1,680/1,860 (90.32 %): AIR 0.964; pooled p 0.89583; SE 0.014932; z −2.200; p ≈ 0.028 → significant; OR 0.91, gap 3.3 pp → not material
  const pooled = disparityTest({ n_group: 540, events_group: 470, n_comparison: 1860, events_comparison: 1680, adjusted_or: 0.91 });
  assert.equal(pooled.air, 0.964); assert.ok(Math.abs(pooled.se - 0.014932) < 1e-6); assert.equal(pooled.z, -2.2); assert.equal(pooled.p_value, 0.028); assert.equal(pooled.flag, "significant"); assert.equal(pooled.diff_pp, -3.3);
  // rule 7 — counteroffers 31/220 (14.09 %) vs 52/610 (8.52 %): AIR 1.653; pooled p 0.100; SE 0.023593; z 2.359; p ≈ 0.018; gap 5.6 pp; OR 1.48 → material; review Nov 16 → Wed Dec 16, 2026
  const co = disparityTest({ n_group: 220, events_group: 31, n_comparison: 610, events_comparison: 52, adjusted_or: 1.48, adverse_direction: "higher" });
  assert.equal(co.air, 1.653); assert.equal(co.pooled_p, 0.1); assert.ok(Math.abs(co.se - 0.023593) < 1e-6); assert.equal(co.z, 2.359); assert.equal(co.p_value, 0.018); assert.equal(co.diff_pp, 5.6); assert.equal(co.flag, "material");
  assert.equal(reviewDue(reviewOpensOn(D("2026-11-15"))), "2026-12-16");
  // the same counteroffer gap without a controls-adjusted OR outside 0.80–1.25 is significant, not material
  assert.equal(disparityTest({ n_group: 220, events_group: 31, n_comparison: 610, events_comparison: 52, adjusted_or: 1.1, adverse_direction: "higher" }).flag, "significant");
  // rule 6 — Q3 2026 exceptions 22/140 (15.71 %) vs 41/190 (21.58 %): AIR 0.728 → screen; pooled p 63/330 = 0.19091; SE 0.043775; z −1.340; p ≈ 0.180
  const ex = disparityTest({ n_group: 140, events_group: 22, n_comparison: 190, events_comparison: 41 });
  assert.equal(ex.air, 0.728); assert.equal(ex.pooled_p, 63 / 330); assert.ok(Math.abs(ex.se - 0.043775) < 1e-6); assert.equal(ex.z, -1.34); assert.equal(ex.p_value, 0.18); assert.equal(ex.screen_fails, true); assert.equal(ex.flag, "screen");
  // rule 4 — 24/25 = 0.96 < 0.98 → corrective action; corrected statement within 5 creditor business days
  const ra = reasonAccuracy({ population: 31, replays: Array.from({ length: 25 }, (_, k) => ({ adverse_action_id: `AA-${k}`, issued_reasons: ["a", "b"], replayed_reasons: k === 24 ? ["c", "b"] : ["a", "b"] })) });
  assert.equal(ra.accuracy, 0.96); assert.equal(ra.corrective_action_required, true); assert.equal(ra.next_month_sample_pct, 100);
  assert.equal(correctedStatementDue(D("2026-11-10")), "2026-11-18");
  // clocks: partner notice Nov 9 → Nov 24; drift Dec 2 → Dec 4; monthly run for October by Nov 15; pack for Q3 by Oct 30
  assert.equal(partnerNoticeDue(D("2026-11-09")), "2026-11-24"); assert.equal(partnerNoticeDue(D("2026-11-09"), true), "2026-11-10");
  assert.equal(driftReviewDue(D("2026-12-02")), "2026-12-04"); assert.equal(monthlyRunDue(D("2026-10-31")), "2026-11-15"); assert.equal(governancePackDue(D("2026-09-30")), "2026-10-30");
});
