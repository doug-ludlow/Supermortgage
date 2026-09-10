// 18.1 Internal QC plan
// spec/sections/18-qc-audit-regulatory-reporting/18-1-internal-qc-plan.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { CommandBus, CommandRefused, type CommandContext } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { TOOLS_18_1 } from "../../app/tools/section18-1.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { newPayment, computeArmAdjustment } from "../notices/arm.ts";
import { cushion } from "../escrow/analysis.ts";
import { runCycle, rederiveEscrowCushion, appendixECushion, rederivePaymentAllocation, rederiveArmAdjustment, remediationLedgerDraft, capaCompletion, completeCapa, nextCycleCloseOn, effectivenessCheck, consumerRemediation, qcResultsRequest, qcResultsDelivered, csbsExternalAudit, afsReceived, aiEvalGateFacts, replayInvestorEvents, timerHistory, findingValidateDue,
  drawSample, regenerateDraw, populationHash, monthlyCycleWindow, moneyRederiveFinding, populationFinding, findingTransition, capaDueOn, signCycle, reportDelivered, vendorAnnualClock, vendorTestCompleted, approveVersion, deployVersion, fairnessTest, fairnessDistribution, twoProportionZ, aiDisclosureRequest, aiDisclosurePackage, sendAiDisclosure, qcAuditWriteAttempt, MemoryAccessLog, QC_AUDIT_DB_GRANTS, killSwitchEvaluation, verifyHumanPath, monitoringReviewed, annualPolicyReview, planApproved, isbrAttestationSigned, impactAssessmentClock, impactAssessmentCompleted,
  appendQcEvent, qcScheduleTicks, emitQcScheduleTicks, businessDayOfMonth, onboardVendor, recordVendorTestCompleted, openFinding, validateFinding, rejectFinding, proposeVersion, recordEvaluations, recordVersionApproved, approvePolicy, recordPolicyReviewed, qcResultsRequestReceived, recordIsbrAttestationSigned, recordAfsReceived, findingSubject, vendorSubject, versionSubject, policySubject, requestSubject, fiscalYearSubject, type AiVersion, type FindingActor, type VendorOnboarding } from "./ops-18-1.ts";
import { cyclePlan, sha256 } from "./ops.ts";
import { sampleSize, seededDraw, targeted, errorRate } from "./sampling.ts";
import { moneyFinding, seniorReportDue, vendorAnnualTest, fairnessScreen, killSwitch, disclosurePackageDue, evalGate, qcAuditMayWrite } from "./findings.ts";

const QC_OFFICER: FindingActor = { kind: "human", id: "u-qc-officer", role: "officer", designation: "qc_officer" };
const AI_OWNER: FindingActor = { kind: "human", id: "u-ai-gov-owner", role: "officer", designation: "ai_governance_owner" };
const PLAIN_OFFICER: FindingActor = { kind: "human", id: "u-officer", role: "officer" };
const ANALYST: FindingActor = { kind: "human", id: "u-analyst", role: "ops_analyst" };
const QC_AGENT: FindingActor = { kind: "agent", id: "qc-audit" };
const reg = loadOverriddenRegistry();
const ev = (type: string, payload: Record<string, unknown>) => ({ id: "e", type, occurredAt: "2026-09-01T00:00:00.000Z", actor: { kind: "system" as const, id: "s" }, payload, sequence: 1 });
/** The real TimerEngine over the overridden registry, filtered to the processes owning `codes`; `emit` appends one of the process's own events (payload = the event minus `type`) at noon ET on `on`. */
const drive = (codes: readonly string[]) => {
  const events = new MemoryEventStore(new FixedClock("2026-09-01T16:00:00.000Z"));
  const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: [...new Set(codes.map((c) => reg.get(c)!.process))] });
  const emit = (e: ({ type: string } & Record<string, unknown>) | (object & { type: string }), on: string) => { const { type, ...payload } = e as { type: string } & Record<string, unknown>; return events.append({ type, occurredAt: `${on}T16:00:00.000Z`, actor: { kind: "agent", id: "qc-audit" }, payload }); };
  const armed = (code: string) => { const xs = engine.byCode(code); assert.equal(xs.length, 1, `${code} armed once`); return xs[0]!; };
  return { events, engine, emit, armed };
};
/** The August 2026 loss-mitigation population of T1: 4,000 decisions, every 12th a denial and every 97th an appeal. */
const AUGUST_LOSSMIT = Array.from({ length: 4000 }, (_, k) => ({ id: `lm-2026-08-${k + 1}`, flags: { denial: k % 12 === 0, appeal: k % 97 === 0 } }));

test("18.1-T1: Given 4,000 loss-mit decisions in August 2026, when the monthly cycle opens on BD3 of September, then `QC_LOSSMIT_ELIGIBILITY_RECOMPUTE` samples 351 random + 100% of denials/appeals, records a seed, and the population hash regenerates the same list.", () => {
  // the September cycle covers August and opens on BD3 (Tue 2026-09-01 is BD1 → Thu 2026-09-03); the registry arms it from the BD3 tick
  const win = monthlyCycleWindow(2026, 9);
  assert.equal(win.period_start, D("2026-08-01")); assert.equal(win.period_end, D("2026-08-31")); assert.equal(win.opens_on, D("2026-09-03")); assert.equal(win.close_by, D("2026-09-29"));
  assert.equal(reg.get("FNMA_A4101_QC_CYCLE_MONTHLY")!.triggerPattern!.raw, "schedule.tick{cadence=monthly, business_day=3}");
  const draw = drawSample({ rule_code: "QC_LOSSMIT_ELIGIBILITY_RECOMPUTE", population: AUGUST_LOSSMIT, selection_seed: 20260903 });
  assert.equal(draw.population_n, 4000); assert.equal(draw.n, 351); assert.equal(draw.n, sampleSize(4000)); assert.equal(draw.random_ids.length, 351);
  // 100% of denials and appeals ride on top of the random draw
  const mustHave = AUGUST_LOSSMIT.filter((p) => targeted(p.flags)).map((p) => p.id);
  assert.deepEqual(draw.targeted_ids, mustHave); assert.ok(mustHave.length > 351);
  assert.ok(mustHave.every((id) => draw.sample_ids.includes(id))); assert.ok(draw.random_ids.every((id) => draw.sample_ids.includes(id)));
  assert.equal(new Set(draw.sample_ids).size, draw.sample_ids.length); assert.equal(draw.sample_n, draw.sample_ids.length);
  // the seed is recorded and the population hash is the SHA-256 of the ordered id list
  assert.equal(draw.selection_seed, 20260903); assert.equal(draw.selection_method, "random");
  const ids = AUGUST_LOSSMIT.map((p) => p.id);
  assert.equal(draw.population_hash, sha256(ids.join("\n"))); assert.equal(draw.population_hash, populationHash(ids)); assert.match(draw.population_hash, /^[0-9a-f]{64}$/);
  // examiner reproducibility: seed + hash regenerate the identical list; a shuffled or changed population cannot be replayed
  const again = regenerateDraw({ population_ids: ids, selection_seed: draw.selection_seed, population_hash: draw.population_hash, n: draw.n });
  assert.equal(again.result, "identical"); assert.deepEqual(again.sample_ids, draw.random_ids); assert.deepEqual(again.sample_ids, seededDraw(ids, 351, 20260903));
  assert.notDeepEqual(seededDraw(ids, 351, 20260904), draw.random_ids);
  assert.equal(regenerateDraw({ population_ids: [...ids].reverse(), selection_seed: draw.selection_seed, population_hash: draw.population_hash, n: draw.n }).result, "inconclusive");
  assert.equal(regenerateDraw({ population_ids: ids.slice(0, 3999), selection_seed: draw.selection_seed, population_hash: draw.population_hash, n: draw.n }).result, "inconclusive");
});

test("18.1-T2: Given an escrow analysis with cushion 120,000¢ where the recompute yields 80,000¢, when tested, then a `qc_finding` sev-2 opens with `variance_cents = 40000`, a CAPA `refund` with 30-day timer, and the corrected statement is issued by `escrow` (not by `qc-audit`).", () => {
  // $4,800/yr line = 480,000¢: Appendix E cushion 1/6 = 80,000¢; the analysis used 1/4 = 120,000¢
  const row = rederiveEscrowCushion({ subject_id: "ea-1", annual_disbursements_cents: 480_000n, observed_cushion_cents: 120_000n });
  assert.equal(row.result, "fail"); assert.equal(row.expected_cushion.cents, 80_000n); assert.equal(row.variance_cents, 40_000n);
  // the recompute is the QC module's own Appendix E arithmetic (not the escrow engine's `cushion()`, which is what the analysis under test ran); the two agree on the worked line, and the independent one would still say 80,000¢ if the engine said 120,000¢
  assert.deepEqual(appendixECushion(480_000n), { cents: 80_000n, months: 2, source: "policy", cap_cents: 80_000n }); assert.deepEqual(appendixECushion(480_000n), cushion(480_000n, {}));
  assert.deepEqual(appendixECushion(480_000n, { policy_months: 3 }), { cents: 80_000n, months: 3, source: "policy", cap_cents: 80_000n });   // 1/4 asked for, 1/6 cap applied
  const f = moneyRederiveFinding({ row, finding_id: "F-2026-10-001", validated_on: D("2026-10-01"), refunded_before_payment_change: true, notice_affected: true, owning_agent: "escrow", owner_role: "escrow_analyst", from_account: "escrow_shortage_collected", to_account: "escrow" });
  assert.equal(f.finding.case_type, "qc_finding"); assert.equal(f.finding.severity, "sev2_rule_breach_no_harm"); assert.equal(f.finding.status, "open"); assert.equal(f.finding.opened_by, "qc-audit");
  assert.equal(f.finding.variance_cents, 40_000n); assert.equal(f.finding.remediation_cents_total, 40_000n); assert.equal(f.finding.rule_code, "QC_ESCROW_ANALYSIS_RECOMPUTE");
  // "opens": the subject-level money finding emits `qc.finding.opened{level=subject, opened_at}` — the trigger of SM_QC_FINDING_VALIDATE_5BD — and the real engine arms the QC officer's 5-BD clock from it (opened Thu 2026-10-01 → Thu 2026-10-08)
  assert.deepEqual(f.event, { type: "qc.finding.opened", finding_code: "QC_ESCROW_ANALYSIS_RECOMPUTE:ea-1", level: "subject", rule_code: "QC_ESCROW_ANALYSIS_RECOMPUTE", severity: "sev2_rule_breach_no_harm", opened_at: D("2026-10-01"), subject_type: "escrow_analysis", subject_id: "ea-1", variance_cents: 40_000n });
  const vt = reg.get("SM_QC_FINDING_VALIDATE_5BD")!; assert.ok(eventMatches(vt.triggerPattern!, ev(f.event!.type, { ...f.event }))); assert.equal(f.validate_due, D("2026-10-08")); assert.equal(f.validate_due, findingValidateDue(D("2026-10-01")));
  const eng = drive(["SM_QC_FINDING_VALIDATE_5BD"]); openFinding(eng.events, "F-2026-10-001", f.event!);
  const inst = eng.armed("SM_QC_FINDING_VALIDATE_5BD"); assert.equal(inst.status, "armed"); assert.equal(inst.anchorDate, D("2026-10-01")); assert.equal(inst.dueDate, D("2026-10-08")); assert.deepEqual(inst.subject, findingSubject("F-2026-10-001"));
  // the QC officer validates on 2026-10-01 (the date the dossier's clocks run from): `qc.finding.validated{remediation_cents_total=40000}` satisfies the 5-BD clock and arms the 30-day consumer-remediation clock the CAPA `refund` names — the engine's due date is the dossier's
  const record = { finding_id: "F-2026-10-001", status: "open" as const, severity: f.finding.severity, root_cause: null, remediation_cents_total: f.finding.remediation_cents_total };
  assert.match(validateFinding(eng.events, record, QC_AGENT, D("2026-10-01")).refusal!, /officer:qc_officer/); assert.equal(inst.status, "armed");
  const validated = validateFinding(eng.events, record, QC_OFFICER, D("2026-10-01")); assert.equal(validated.ok, true); assert.equal(validated.event!.type, "qc.finding.validated"); assert.equal(validated.event!.payload.remediation_cents_total, 40_000n);
  assert.equal(inst.status, "satisfied"); assert.deepEqual(eng.events.all().map((e) => e.type), ["qc.finding.opened", "timer.armed", "qc.finding.validated", "timer.satisfied", "timer.armed"]);   // validation also arms the 30-day consumer clock
  const rem = eng.armed("SM_QC_CONSUMER_REMEDIATION_30"); assert.equal(rem.anchorDate, D("2026-10-01")); assert.equal(rem.dueDate, D("2026-10-31")); assert.equal(rem.dueDate, f.remediation_timer.due); assert.equal(rem.dueDate, f.capas[0]!.due); assert.deepEqual(rem.subject, findingSubject("F-2026-10-001"));
  assert.equal(eng.engine.byCode("SM_QC_CAPA_SEV1_10BD").length, 0);   // sev-2: no sev-1 CAPA clock
  assert.throws(() => moneyRederiveFinding({ row: { ...row, variance_cents: 0n }, finding_id: "F-0", validated_on: D("2026-10-01"), refunded_before_payment_change: true, notice_affected: false, owning_agent: "escrow", owner_role: "escrow_analyst", from_account: "a", to_account: "b" }), RangeError);
  // CAPA `refund` on the 30-day consumer-remediation clock (validated 2026-10-01 → 2026-10-31), owned by escrow
  assert.equal(f.capas[0]!.action_kind, "refund"); assert.equal(f.capas[0]!.timer, "SM_QC_CONSUMER_REMEDIATION_30"); assert.equal(f.capas[0]!.due, D("2026-10-31")); assert.equal(f.capas[0]!.owner_agent, "escrow");
  assert.equal(f.remediation_timer.due, D("2026-10-31")); assert.deepEqual(reg.get("SM_QC_CONSUMER_REMEDIATION_30")!.offsetParsed, { kind: "step", n: 30, unit: "calendar_days" });
  assert.equal(reg.get("SM_QC_CONSUMER_REMEDIATION_30")!.triggerPattern!.raw, "qc.finding.validated{remediation_cents_total>0}");
  // the corrected statement comes from the owning section (escrow) through the Notice Registry, never from qc-audit; the ledger credit is drafted by qc-audit and posted by escrow
  assert.equal(f.capas[1]!.action_kind, "re_notice"); assert.equal(f.corrected_statement!.issued_by, "escrow"); assert.equal(f.corrected_statement!.never_by, "qc-audit"); assert.equal(f.corrected_statement!.source, "notice_registry");
  assert.equal(f.ledger_draft.posted_by, "escrow"); assert.equal(f.ledger_draft.drafted_by, "qc-audit"); assert.equal(f.ledger_draft.balanced, true); assert.deepEqual(f.ledger_draft.entry_set.lines.map((l) => [l.account, l.amountCents]), [["escrow", 40_000n], ["escrow_shortage_collected", -40_000n]]);
  // not refunded before the payment-change date → consumer harm → sev-1 (rule C); the first-cut calculator agrees
  assert.equal(moneyRederiveFinding({ row, finding_id: "F-2", validated_on: D("2026-10-01"), refunded_before_payment_change: false, notice_affected: false, owning_agent: "escrow", owner_role: "escrow_analyst", from_account: "escrow_shortage_collected", to_account: "escrow" }).finding.severity, "sev1_consumer_harm_or_fnma_breach");
  assert.deepEqual([moneyFinding(80_000n, 120_000n, D("2026-10-01"), false, true).severity, moneyFinding(80_000n, 120_000n, D("2026-10-01"), false, true).remediation_due], ["sev2", D("2026-10-31")]);
  // the escrow.recompute_analysis tool refuses to issue the statement or correct the analysis itself — every actor, no override
  const rail = TOOLS_18_1.find((t) => t.name === "escrow.recompute_analysis")!.guardrails!.find((g) => g.code === "STATEMENT_ISSUED_BY_ESCROW")!;
  for (const actor of [QC_AGENT, ANALYST, PLAIN_OFFICER] as Actor[]) { assert.match(rail.refuse({ subject_id: "ea-1", issue_statement: true }, { actor } as CommandContext)!, /escrow agent .* corrected annual statement/); assert.ok(rail.refuse({ subject_id: "ea-1", correct_analysis: true }, { actor } as CommandContext)); }
  assert.equal(rail.refuse({ subject_id: "ea-1", annual_disbursements_cents: 480_000n, observed_cushion_cents: 120_000n }, { actor: QC_AGENT } as CommandContext), undefined);
});

test("18.1-T3: Given a rederive rule with 2.4% failures (tolerance 2%), then a population-level finding opens with root cause required before `capa_assigned`.", () => {
  const pf = populationFinding({ rule_code: "QC_PAY_ALLOCATION_RECOMPUTE", cycle_id: "C-2026-09", fails: 24, passes: 976, family: "rederive", opened_on: D("2026-09-10") });
  assert.equal(pf.breached, true); assert.equal(pf.error_rate.rate, 0.024); assert.equal(pf.tolerance, 0.02); assert.ok(pf.error_rate.wilson_low < 0.024 && pf.error_rate.wilson_high > 0.024);
  const f = pf.finding!;
  assert.equal(f.level, "population"); assert.equal(f.status, "open"); assert.equal(f.root_cause, null); assert.equal(f.root_cause_required, true); assert.equal(f.affected_count, 24); assert.match(f.affected_population_query, /result = 'fail'/);
  assert.equal(f.severity, "sev2_rule_breach_no_harm"); assert.equal(f.event.type, "qc.finding.opened"); assert.equal(f.event.type, reg.get("SM_QC_FINDING_VALIDATE_5BD")!.triggerPattern!.type);
  // 1.9% stays within tolerance; a sev-1 consumer-harm rule breaches on a single failure
  assert.equal(populationFinding({ rule_code: "QC_PAY_ALLOCATION_RECOMPUTE", cycle_id: "C-2026-09", fails: 19, passes: 981, family: "rederive", opened_on: D("2026-09-10") }).finding, null);
  assert.equal(populationFinding({ rule_code: "QC_LOSSMIT_DENIAL_NOTICE", cycle_id: "C-2026-09", fails: 1, passes: 999, family: "sev1_consumer_harm", opened_on: D("2026-09-10") }).finding!.severity, "sev1_consumer_harm_or_fnma_breach");
  // state machine: the QC officer validates (qc-audit cannot); capa_assigned is refused until a root cause is recorded
  const base = { severity: f.severity, root_cause: null };
  assert.match(findingTransition({ ...base, status: "open" }, "validated", QC_AGENT).refusal!, /officer:qc_officer/);
  const validated = findingTransition({ ...base, status: "open", finding_id: f.finding_code }, "validated", QC_OFFICER, D("2026-09-14")); assert.equal(validated.status, "validated");
  // the validation event satisfies the 5-BD validate clock and (sev-2, no remediation) arms neither the sev-1 CAPA clock nor the consumer-remediation clock
  const vt = reg.get("SM_QC_FINDING_VALIDATE_5BD")!;
  assert.ok(eventMatches(vt.satisfiedPattern!, ev(validated.event!.type, { ...validated.event }))); assert.equal(validated.event!.validated_at, D("2026-09-14")); assert.equal(validated.event!.decided_by, "human:u-qc-officer");
  assert.equal(eventMatches(vt.satisfiedPattern!, ev(f.event.type, { ...f.event, status: "open" })), false);
  assert.equal(eventMatches(reg.get("SM_QC_CAPA_SEV1_10BD")!.triggerPattern!, ev(validated.event!.type, { ...validated.event })), false); assert.equal(eventMatches(reg.get("SM_QC_CONSUMER_REMEDIATION_30")!.triggerPattern!, ev(validated.event!.type, { ...validated.event })), false);
  const noRoot = findingTransition({ ...base, status: "validated" }, "capa_assigned", QC_AGENT);
  assert.equal(noRoot.ok, false); assert.equal(noRoot.status, "validated"); assert.equal(noRoot.event, null); assert.match(noRoot.refusal!, /root cause required before capa_assigned/);
  const assigned = findingTransition({ ...base, status: "validated", root_cause: "rule_defect", finding_id: f.finding_code }, "capa_assigned", QC_AGENT);
  assert.equal(assigned.ok, true); assert.equal(assigned.status, "capa_assigned"); assert.equal(assigned.event!.type, "qc.finding.capa_assigned"); assert.equal(assigned.event!.root_cause, "rule_defect");
  assert.match(findingTransition({ ...base, status: "open" }, "capa_assigned", QC_AGENT).refusal!, /no transition open → capa_assigned/);
  assert.match(findingTransition({ ...base, status: "open" }, "rejected", QC_OFFICER).refusal!, /rationale/);
  const rejected = findingTransition({ ...base, status: "open", rationale: "duplicate of F-1" }, "rejected", QC_OFFICER); assert.equal(rejected.ok, true); assert.ok(eventMatches(vt.satisfiedPattern!, ev(rejected.event!.type, { ...rejected.event })));
  assert.equal(errorRate(24, 976).n, 1000);
});

test("18.1-T4: Given a sev-1 finding validated on 2026-10-01, when no CAPA completes by 2026-10-15 (10 BD), then `SM_QC_CAPA_SEV1_10BD` breaches and the partner is notified.", () => {
  const capas = [{ id: "c1", action_kind: "refund", status: "open" as const, completed_on: null }];
  const at = (today: string) => capaCompletion({ finding_id: "F-1", severity: "sev1_consumer_harm_or_fnma_breach", validated_on: D("2026-10-01"), capas, today: D(today) });
  // spec says 2026-10-15 "(10 BD)"; Columbus Day 2026-10-12 makes the 10th servicer business day 2026-10-16 (docs/AUDIT-NOTES.md) — the clock is still open on the 15th
  assert.equal(at("2026-10-15").timer.due, D("2026-10-16")); assert.equal(at("2026-10-15").timer.code, "SM_QC_CAPA_SEV1_10BD"); assert.equal(at("2026-10-15").breached, false); assert.equal(at("2026-10-16").breached, false);
  assert.equal(at("2026-10-15").timer.due, capaDueOn(D("2026-10-01"), "sev1_consumer_harm_or_fnma_breach").due); assert.equal(at("2026-10-15").timer.due, addBusinessDays(D("2026-10-01"), 10, servicer));
  const late = at("2026-10-17");
  assert.equal(late.breached, true); assert.equal(late.all_completed, false); assert.deepEqual(late.open_capa_ids, ["c1"]); assert.equal(late.event, null);
  assert.deepEqual(late.escalations.map((e) => e.kind), ["officer", "partner"]); assert.match(late.escalations[1]!.reason, /partner notified/);
  // the registry row: armed by the sev-1 validation event (validated_at 2026-10-01, remediation > 0 also arms the 30-day consumer clock), +10 BD, satisfied only by the last CAPA completing
  const t = reg.get("SM_QC_CAPA_SEV1_10BD")!;
  assert.equal(t.triggerPattern!.type, "qc.finding.validated"); assert.equal(t.anchorField, "validated_at"); assert.deepEqual(t.offsetParsed, { kind: "step", n: 10, unit: "business_days_servicer" });
  const validated = findingTransition({ status: "open", severity: "sev1_consumer_harm_or_fnma_breach", root_cause: null, finding_id: "F-1", remediation_cents_total: 40_000n }, "validated", QC_OFFICER, D("2026-10-01"));
  assert.ok(eventMatches(t.triggerPattern!, ev(validated.event!.type, { ...validated.event }))); assert.equal(validated.event!.validated_at, D("2026-10-01"));
  assert.ok(eventMatches(reg.get("SM_QC_CONSUMER_REMEDIATION_30")!.triggerPattern!, ev(validated.event!.type, { ...validated.event })));
  const done = capaCompletion({ finding_id: "F-1", severity: "sev1_consumer_harm_or_fnma_breach", validated_on: D("2026-10-01"), capas: [{ ...capas[0]!, status: "completed", completed_on: D("2026-10-09") }], today: D("2026-10-09") });
  assert.ok(eventMatches(t.satisfiedPattern!, ev(done.event!.type, { ...done.event }))); assert.equal(done.breached, false); assert.deepEqual(done.escalations, []);
  // sev-2 / sev-3 clocks are 30 / 90 calendar days
  assert.deepEqual(capaDueOn(D("2026-10-01"), "sev2_rule_breach_no_harm"), { code: "SM_QC_CAPA_SEV2_30", due: D("2026-10-31") }); assert.deepEqual(capaDueOn(D("2026-10-01"), "sev3_documentation"), { code: "SM_QC_CAPA_SEV3_90", due: D("2026-12-30") });
});

test("18.1-T5: Given a cycle closed on a Friday before a Monday holiday, then the senior-management report timer (5 BD) lands on the following Monday+7 and satisfies on delivery evidence.", () => {
  // Fri 2026-09-04, Labor Day Mon 2026-09-07: BD 09-08, 09-09, 09-10, 09-11, 09-14 → Mon 2026-09-14 (the Monday + 7)
  assert.match(signCycle({ cycle_id: "C-2026-08", signed_on: D("2026-09-04"), signer: QC_AGENT }).refusal!, /officer:qc_officer/);
  const signed = signCycle({ cycle_id: "C-2026-08", signed_on: D("2026-09-04"), signer: QC_OFFICER });
  assert.equal(signed.event!.type, "qc.cycle.signed"); assert.equal(signed.event!.signed_at, D("2026-09-04")); assert.equal(signed.report_due, D("2026-09-14")); assert.equal(signed.report_due, seniorReportDue(D("2026-09-04")));
  const sm = reg.get("FNMA_A4101_QC_REPORT_SENIOR_MGMT_MONTHLY")!;
  assert.ok(eventMatches(sm.triggerPattern!, ev(signed.event!.type, { ...signed.event }))); assert.equal(sm.anchorField, "signed_at"); assert.deepEqual(sm.offsetParsed, { kind: "step", n: 5, unit: "business_days_servicer" });
  // no delivery evidence → not satisfied; delivered with evidence → the satisfaction event, on time; delivered after the Monday → late
  const pending = reportDelivered({ cycle_id: "C-2026-08", audience: "senior_management", signed_on: D("2026-09-04"), delivered_on: D("2026-09-11"), delivery_evidence: null });
  assert.equal(pending.due, D("2026-09-14")); assert.equal(pending.event, null); assert.match(pending.refusal!, /delivery is evidenced/);
  const delivered = reportDelivered({ cycle_id: "C-2026-08", audience: "senior_management", signed_on: D("2026-09-04"), delivered_on: D("2026-09-11"), delivery_evidence: "board-portal receipt 2026-09-11T15:02Z" });
  assert.equal(delivered.on_time, true); assert.equal(delivered.event!.type, "qc.report.delivered"); assert.equal(delivered.event!.audience, "senior_management");
  assert.ok(eventMatches(sm.satisfiedPattern!, ev(delivered.event!.type, { ...delivered.event })));
  assert.equal(eventMatches(reg.get("SM_QC_REPORT_PARTNER_MONTHLY")!.satisfiedPattern!, ev(delivered.event!.type, { ...delivered.event })), false);
  const partner = reportDelivered({ cycle_id: "C-2026-08", audience: "partner", signed_on: D("2026-09-04"), delivered_on: D("2026-09-14"), delivery_evidence: "sftp manifest sha256:…" });
  assert.equal(partner.on_time, true); assert.ok(eventMatches(reg.get("SM_QC_REPORT_PARTNER_MONTHLY")!.satisfiedPattern!, ev(partner.event!.type, { ...partner.event })));
  assert.equal(reportDelivered({ cycle_id: "C-2026-08", audience: "senior_management", signed_on: D("2026-09-04"), delivered_on: D("2026-09-15"), delivery_evidence: "receipt" }).on_time, false);
});

test("18.1-T6: Given a vendor onboarded 2026-03-15, then `FNMA_A4101_VENDOR_QC_TEST_ANNUAL` warns 2026-12-15 and breaches 2027-03-15 without a completed test.", () => {
  const clock = (today: string, completed: { completed_on: ReturnType<typeof D> }[] = []) => vendorAnnualClock({ vendor_id: "V-print-mail", onboarded_on: D("2026-03-15"), completed_tests: completed, today: D(today) });
  assert.equal(clock("2026-12-14").warn_on, D("2026-12-15")); assert.equal(clock("2026-12-14").breach_on, D("2027-03-15")); assert.equal(clock("2026-12-14").warned, false);
  assert.equal(clock("2026-12-15").warned, true); assert.equal(clock("2026-12-15").breached, false);
  const breached = clock("2027-03-15");
  assert.equal(breached.breached, true); assert.equal(breached.satisfied, false); assert.deepEqual(breached.escalation, { kind: "officer", severity: "sev1", reason: "vendor V-print-mail: annual QC test not completed by 2027-03-15 (A4-1-01)" });
  // a completed test inside the year satisfies the clock and moves the anniversary
  const done = clock("2027-03-15", [{ completed_on: D("2027-02-01") }]);
  assert.equal(done.satisfied, true); assert.equal(done.breached, false); assert.equal(done.breach_on, D("2028-02-01")); assert.equal(done.escalation, null);
  assert.deepEqual(vendorAnnualTest(D("2026-03-15")), { warn: D("2026-12-15"), breach: D("2027-03-15") });   // the first-cut calculator agrees on the spec's dates
  // the anniversary is month arithmetic: onboarded 2027-03-15 breaches 2028-03-15 across the leap day (the first cut's 365-day add would give 2028-03-14)
  assert.equal(vendorAnnualClock({ vendor_id: "V", onboarded_on: D("2027-03-15"), completed_tests: [], today: D("2027-04-01") }).breach_on, D("2028-03-15"));
  // the registry row: armed on `vendor.onboarded` at onboarded_on + 12 months, satisfied per vendor by `qc.vendor_test.completed` — which needs the Vendor QC Test Report
  const t = reg.get("FNMA_A4101_VENDOR_QC_TEST_ANNUAL")!;
  assert.equal(t.triggerPattern!.type, "vendor.onboarded"); assert.equal(t.anchorField, "onboarded_on"); assert.deepEqual(t.offsetParsed, { kind: "step", n: 12, unit: "months" });
  assert.equal(vendorTestCompleted({ vendor_id: "V-print-mail", completed_on: D("2027-02-01"), report_document_id: null }).event, null);
  const completed = vendorTestCompleted({ vendor_id: "V-print-mail", completed_on: D("2027-02-01"), report_document_id: "doc-vqt-2027" });
  assert.ok(eventMatches(t.satisfiedPattern!, ev(completed.event!.type, { ...completed.event })));
  // through the real engine: the vendor-management onboarding record (contract + clear SCP/SAM/LDP screening) is what emits `vendor.onboarded`; without it nothing arms
  const v: VendorOnboarding = { vendor_id: "V-print-mail", name: "Print & mail vendor", kind: "print_mail", onboarded_on: D("2026-03-15"), contract_document_id: "doc-msa-print-mail", scp_screening: { screened_on: D("2026-03-10"), clear: true, document_id: "doc-scp-2026-03-10" } };
  const eng = drive(["FNMA_A4101_VENDOR_QC_TEST_ANNUAL"]);
  assert.match(onboardVendor(eng.events, { ...v, scp_screening: null }).refusal!, /Suspended Counterparty Program/); assert.match(onboardVendor(eng.events, { ...v, scp_screening: { ...v.scp_screening!, clear: false } }).refusal!, /screening hit/);
  assert.match(onboardVendor(eng.events, { ...v, contract_document_id: null }).refusal!, /no executed contract/); assert.match(onboardVendor(eng.events, { ...v, kind: "ai_vendor" }).refusal!, /flow-down attestation/);
  assert.throws(() => onboardVendor(eng.events, { ...v, vendor_id: "" }), RangeError); assert.equal(eng.engine.all().length, 0); assert.equal(eng.events.all().length, 0);
  const on = onboardVendor(eng.events, v); assert.equal(on.refusal, null); assert.equal(on.event!.type, "vendor.onboarded"); assert.equal(on.event!.payload.onboarded_on, D("2026-03-15")); assert.deepEqual([on.annual_test!.warn_on, on.annual_test!.breach_on], [D("2026-12-15"), D("2027-03-15")]);
  const inst = eng.armed("FNMA_A4101_VENDOR_QC_TEST_ANNUAL"); assert.equal(inst.anchorDate, D("2026-03-15")); assert.equal(inst.dueDate, D("2027-03-15")); assert.deepEqual(inst.subject, vendorSubject("V-print-mail"));
  // still open during 2027-03-15; breached once the day ends — the registry's sev-1 → officer escalation; the late report closes it as satisfied_late and the anniversary moves to the completion date
  assert.deepEqual(eng.engine.evaluate("2027-03-15T20:00:00.000Z"), []); assert.equal(inst.status, "armed");
  assert.deepEqual(eng.engine.evaluate("2027-03-16T04:00:00.000Z").map((b) => [b.instance.code, b.severity, [...b.escalateTo]]), [["FNMA_A4101_VENDOR_QC_TEST_ANNUAL", 1, ["officer"]]]); assert.equal(inst.status, "breached");
  assert.equal(recordVendorTestCompleted(eng.events, { vendor_id: "V-print-mail", completed_on: D("2027-03-20"), report_document_id: null }).event, null); assert.equal(inst.status, "breached");
  const late = recordVendorTestCompleted(eng.events, { vendor_id: "V-print-mail", completed_on: D("2027-03-20"), report_document_id: "doc-vqt-2027" }); assert.deepEqual(late.event!.aggregate, vendorSubject("V-print-mail"));
  assert.deepEqual(eng.engine.byCode("FNMA_A4101_VENDOR_QC_TEST_ANNUAL").map((x) => [x.anchorDate, x.dueDate, x.status]), [[D("2026-03-15"), D("2027-03-15"), "satisfied_late"], [D("2027-03-20"), D("2028-03-20"), "armed"]]);
  assert.deepEqual(eng.events.all().map((e) => e.type), ["vendor.onboarded", "timer.armed", "timer.breached", "qc.vendor_test.completed", "timer.satisfied", "timer.armed"]);
});

test("18.1-T7: Given a proposed `lossmit-underwriter` prompt version failing the prompt-injection suite, when deploy is attempted, then `SM_AI_EVAL_GATE` refuses and the version stays `evaluated`.", () => {
  const suites = [{ suite_code: "golden_t1_lossmit", mandatory: true, pass: true }, { suite_code: "prompt_injection", mandatory: true, pass: false }, { suite_code: "latency", mandatory: false, pass: false }];
  // the proposal (AI-GOV-003 change management) is the gate's trigger: `ai.version.proposed` on the version subject arms SM_AI_EVAL_GATE as an evaluator-backed gate with no due date
  const eng = drive(["SM_AI_EVAL_GATE"]);
  assert.throws(() => proposeVersion(eng.events, { system_code: "lossmit-underwriter", version: "prompt-2026.09.2", tier: "T1_consequential", change_kind: "minor", proposed_on: D("2026-09-09"), proposed_by: QC_AGENT }), RangeError);   // a proposal names what changed
  const proposed = proposeVersion(eng.events, { system_code: "lossmit-underwriter", version: "prompt-2026.09.2", tier: "T1_consequential", change_kind: "minor", prompt_hash: "sha256:7c1e", proposed_on: D("2026-09-09"), proposed_by: QC_AGENT });
  assert.equal(proposed.version.status, "proposed"); assert.equal(proposed.event.type, "ai.version.proposed"); assert.deepEqual(proposed.event.aggregate, versionSubject("lossmit-underwriter", "prompt-2026.09.2"));
  const gate = eng.armed("SM_AI_EVAL_GATE"); assert.equal(gate.dueDate, undefined); assert.equal(gate.note, "evaluator:18.1.aiEvalGatePassed"); assert.deepEqual(gate.subject, versionSubject("lossmit-underwriter", "prompt-2026.09.2"));
  assert.match(deployVersion(proposed.version, D("2026-09-10")).refusal!, /stays proposed/);
  const v: AiVersion = recordEvaluations(proposed.version, suites).version; assert.equal(v.status, "evaluated"); assert.match(recordEvaluations(proposed.version, []).refusal!, /no evaluation suites/);
  const attempt = deployVersion(v, D("2026-09-10"));
  assert.equal(attempt.allowed, false); assert.equal(attempt.gate, "SM_AI_EVAL_GATE"); assert.equal(attempt.version.status, "evaluated"); assert.equal(attempt.event, null); assert.match(attempt.refusal!, /prompt_injection/); assert.match(attempt.refusal!, /stays evaluated/);
  // the gate evaluator the deploy command asserts, and the registry row it backs
  const gateEval = evaluateGate("18.1.aiEvalGatePassed", { tier: v.tier, suites, approved_by: null });
  assert.equal(gateEval.open, false); assert.match(gateEval.reason!, /prompt_injection/); assert.deepEqual(reg.get("SM_AI_EVAL_GATE")!.offsetParsed, { kind: "evaluator", ref: "18.1.aiEvalGatePassed" }); assert.equal(reg.get("SM_AI_EVAL_GATE")!.triggerPattern!.type, "ai.version.proposed");
  assert.deepEqual(aiEvalGateFacts({ tier: v.tier, suites, approved_by: "u-ai-gov-owner" }).failed_mandatory, ["prompt_injection"]);
  // the owner cannot approve around a failed mandatory suite either; rule D.3's threshold: prompt-injection suite 100% blocked
  assert.match(approveVersion(v, AI_OWNER).refusal!, /prompt_injection/); assert.equal(approveVersion(v, AI_OWNER).version.status, "evaluated");
  assert.deepEqual(evalGate({ tier: "T1", outcome_agreement: 0.995, unexplained_adverse: 0, disclosure_given: 1, element_coverage: 1, prompt_injection_blocked: 0.98, golden_cases: 400 }).failures, ["prompt_injection_not_fully_blocked"]);
  // once every mandatory suite passes: approval is the AI governance owner's act (a plain officer or qc-audit cannot), then deploy opens
  const fixed: AiVersion = { ...v, suites: suites.map((s) => ({ ...s, pass: s.mandatory ? true : s.pass })) };
  assert.equal(deployVersion(fixed, D("2026-09-11")).allowed, false); assert.match(deployVersion(fixed, D("2026-09-11")).refusal!, /no officer:ai_governance_owner approval/);
  assert.match(approveVersion(fixed, PLAIN_OFFICER).refusal!, /officer:ai_governance_owner/); assert.match(approveVersion(fixed, QC_AGENT).refusal!, /officer:ai_governance_owner/);
  assert.equal(gate.status, "armed");   // nothing so far closed the gate
  const approved = recordVersionApproved(eng.events, fixed, AI_OWNER, D("2026-09-11"));
  assert.equal(approved.version.status, "approved"); assert.equal(approved.version.approved_by, "u-ai-gov-owner"); assert.ok(eventMatches(reg.get("SM_AI_EVAL_GATE")!.satisfiedPattern!, ev(approved.event!.type, { ...approved.event })));
  assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedByEventId, approved.appended!.id); assert.deepEqual(eng.events.all().map((e) => e.type), ["ai.version.proposed", "timer.armed", "ai.version.approved", "timer.satisfied"]);
  const deployed = deployVersion(approved.version, D("2026-09-11"), { current_impact_assessment_due: D("2027-06-30") });
  assert.equal(deployed.allowed, true); assert.equal(deployed.version.status, "deployed"); assert.deepEqual(deployed.event, { type: "ai_system.deployed", system_code: "lossmit-underwriter", version: "prompt-2026.09.2", risk_tier: "T1_consequential", change_kind: "minor", deployed_at: D("2026-09-11"), impact_assessment_due: D("2027-06-30"), impact_assessment_basis: "carried_forward" });
  // a minor change carries the open Colorado clock forward and does not arm a new one; a `new` T1 deployment carries impact_assessment_due = deployed_at + 12 months, and the real engine arms CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL on that anchor
  const co = reg.get("CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL")!; assert.equal(eventMatches(co.triggerPattern!, ev(deployed.event!.type, { ...deployed.event })), false);
  const fresh = deployVersion({ ...approved.version, change_kind: "new" }, D("2026-09-11"));
  assert.equal(fresh.event!.impact_assessment_due, D("2027-09-11")); assert.equal(fresh.event!.impact_assessment_basis, "12_months_from_deployment"); assert.ok(eventMatches(co.triggerPattern!, ev(fresh.event!.type, { ...fresh.event })));
  const coEng = drive(["CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL"]); coEng.emit(fresh.event!, "2026-09-11");
  assert.equal(coEng.armed("CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL").dueDate, D("2027-09-11")); assert.equal(coEng.armed("CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL").anchorDate, D("2027-09-11"));
  // a T3 internal version needs no officer approval, and carries no Colorado anchor
  assert.equal(deployVersion({ ...fixed, tier: "T3_internal" }, D("2026-09-11")).allowed, true); assert.equal(deployVersion({ ...fixed, tier: "T3_internal" }, D("2026-09-11")).event!.impact_assessment_due, null);
});

test("18.1-T8: Given quarterly fairness data with denial rates 12% (reference) vs 16% (protected class), then the ratio 0.75 < 0.80 triggers a finding routed to `attorney` before distribution.", () => {
  const r = fairnessTest({ rule_code: "QC_AI_FAIRNESS_LOSSMIT", period: "2026-Q3", reference: { denials: 120, decisions: 1000 }, protected: { class: "hispanic_or_latino", denials: 48, decisions: 300 } });
  assert.equal(r.reference_denial_rate, 0.12); assert.equal(r.protected_denial_rate, 0.16); assert.equal(r.ratio, 0.75); assert.ok(r.ratio < 0.8);
  assert.equal(r.finding, true); assert.equal(r.route, "attorney"); assert.equal(r.matched_pair_review, true); assert.equal(r.proxy, false);
  assert.deepEqual(r.distribution, { status: "withheld_pending_counsel_review", partner: "summary_statistics_only", privileged: true });
  assert.deepEqual(fairnessScreen(0.12, 0.16), { ratio: 0.75, finding: true, route: "attorney" });
  // the two-proportion z-test on these counts is not itself significant (p ≈ 0.07) — the 0.80 ratio rule alone triggers
  assert.deepEqual(twoProportionZ(120, 1000, 48, 300), { z: 1.811, p: 0.0701 });
  // nothing leaves before counsel's review; afterwards the partner sees summary statistics only (open decision 18.1-Q4)
  const held = fairnessDistribution(r, false); assert.equal(held.allowed, false); assert.equal(held.contents, "none"); assert.match(held.refusal!, /routed to attorney/);
  assert.deepEqual(fairnessDistribution(r, true), { allowed: true, refusal: null, contents: "summary_statistics" });
  // 12% vs 13% (ratio 0.923, p 0.64) is no finding and needs no counsel route
  const ok = fairnessTest({ rule_code: "QC_AI_FAIRNESS_LOSSMIT", period: "2026-Q3", reference: { denials: 120, decisions: 1000 }, protected: { class: "black_or_african_american", denials: 39, decisions: 300 } });
  assert.equal(ok.ratio, 0.923); assert.equal(ok.finding, false); assert.equal(ok.route, null); assert.equal(ok.distribution.status, "summary_statistics"); assert.equal(fairnessDistribution(ok, false).allowed, true);
  // a large but proportionally small gap still triggers through the z-test (p < 0.05)
  const z = fairnessTest({ rule_code: "QC_AI_FAIRNESS_FEES", period: "2026-Q3", reference: { denials: 1200, decisions: 10000 }, protected: { class: "asian", denials: 435, decisions: 3000, proxy: true } });
  assert.ok(z.ratio >= 0.8); assert.ok(z.p < 0.05); assert.equal(z.finding, true); assert.equal(z.route, "attorney"); assert.equal(z.proxy, true);
});

test("18.1-T9: Given a Fannie Mae letter requesting AI/ML types/purposes/safeguards received 2026-11-02, then the package is generated, signed by `officer:ai_governance_owner` and delivered by 2026-11-09 (5 BD).", () => {
  const req = aiDisclosureRequest({ request_id: "FNMA-AI-2026-11-02", requester: "fnma", received_on: D("2026-11-02"), requested: ["types of AI/ML used", "purpose and manner of use", "safeguards"] });
  assert.equal(req.code, "FNMA_LL202604_AI_DISCLOSURE_REQUEST_5BD"); assert.equal(req.due, D("2026-11-09")); assert.equal(req.due, disclosurePackageDue(D("2026-11-02")));
  const t = reg.get("FNMA_LL202604_AI_DISCLOSURE_REQUEST_5BD")!;
  assert.ok(eventMatches(t.triggerPattern!, ev(req.event.type, { ...req.event }))); assert.equal(t.anchorField, "received_at"); assert.equal(t.offsetParsed.kind, "step");
  // the package is generated from the inventory: types, purpose and manner per system, safeguards, policy versions, last annual review
  const pkg = aiDisclosurePackage({ request_id: req.event.request_id,
    inventory: [{ code: "lossmit-underwriter", name: "Loss-mitigation underwriter", kind: "agent", purpose: "loss-mitigation eligibility and denial drafting", manner_of_use: "drafts decisions from the deterministic engines; human touchpoints before any denial", risk_tier: "T1_consequential", human_touchpoints: ["denial reviewed by lossmit_reviewer", "appeal decided by a different reviewer"], vendor: "Anthropic" },
      { code: "voice-collections", name: "Collections voice assistant", kind: "vendor_model", purpose: "early-intervention outbound calls", manner_of_use: "TCPA-consented calls with disclosure of AI use", risk_tier: "T2_borrower_facing", human_touchpoints: ["ask for human transfers to an agent"], vendor: "telephony-ai-vendor" },
      { code: "escrow-engine", name: "Escrow analysis engine", kind: "deterministic_engine", purpose: "Appendix E analysis", manner_of_use: "rule engine, no model", risk_tier: "T0_deterministic", human_touchpoints: [], vendor: null }],
    policies: [{ code: "AI-GOV-001", version: "2026.1", approved_on: D("2026-07-15"), last_reviewed_on: D("2026-07-15") }, { code: "AI-GOV-006", version: "2026.1", approved_on: D("2026-07-15"), last_reviewed_on: null }],
    vendor_attestations: [{ vendor: "Anthropic", expires_on: D("2027-07-01") }] });
  assert.equal(pkg.assembled_by, "qc-audit"); assert.equal(pkg.signed_by, null); assert.match(pkg.document_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(pkg.contents, ["types of AI/ML used", "purpose and manner of use per system", "safeguards: tiering, human touchpoints, evaluations, monitoring, vendor flow-down, security", "current policy versions", "last annual review"]);
  assert.deepEqual(pkg.types, ["agent", "vendor_model", "deterministic_engine"]); assert.equal(pkg.systems.length, 3); assert.equal(pkg.last_annual_review, D("2026-07-15"));
  assert.deepEqual(pkg.systems[0]!.safeguards, ["tier T1_consequential", "human touchpoint: denial reviewed by lossmit_reviewer", "human touchpoint: appeal decided by a different reviewer", "evaluation gate SM_AI_EVAL_GATE", "daily monitoring + kill-switch", "vendor flow-down: Anthropic (2027-07-01)", "ISBR Supplement security program"]);
  assert.deepEqual(pkg.policy_versions[1], { code: "AI-GOV-006", version: "2026.1", last_reviewed_on: null });
  // signature: officer:ai_governance_owner only; delivery: fnma_portal_operator only; sent 2026-11-06 → on time, event satisfies the clock
  const send = (o: Partial<Parameters<typeof sendAiDisclosure>[0]>) => sendAiDisclosure({ request_id: req.event.request_id, due: req.due, signer: AI_OWNER, delivered_by: "fnma_portal_operator", sent_on: D("2026-11-06"), package_document_id: "doc-ai-disclosure-2026-11", ...o });
  assert.match(send({ signer: PLAIN_OFFICER }).refusal!, /officer:ai_governance_owner/); assert.match(send({ signer: QC_AGENT }).refusal!, /officer:ai_governance_owner/); assert.match(send({ signer: null }).refusal!, /officer:ai_governance_owner/);
  assert.match(send({ delivered_by: "qc-audit" }).refusal!, /fnma_portal_operator/); assert.match(send({ sent_on: null }).refusal!, /not sent/); assert.match(send({ master_servicer_asked: true }).refusal!, /partner's officer/);
  const sent = send({});
  assert.equal(sent.refusal, null); assert.equal(sent.on_time, true); assert.equal(sent.event!.type, "ai.disclosure.sent"); assert.equal(sent.event!.signed_by, "u-ai-gov-owner"); assert.equal(sent.event!.signed_by_designation, "ai_governance_owner"); assert.equal(sent.event!.sent_at, D("2026-11-06"));
  assert.ok(eventMatches(t.satisfiedPattern!, ev(sent.event!.type, { ...sent.event })));
  assert.equal(send({ sent_on: D("2026-11-09") }).on_time, true); assert.equal(send({ sent_on: D("2026-11-10") }).on_time, false);
  assert.equal(send({ master_servicer_asked: true, partner_officer_signed: true }).refusal, null);
});

test("18.1-T10: Given `qc-audit` attempts `INSERT` into `ledger_entries`, then the DB role denies it and the attempt is logged.", async () => {
  // the role: db/migrations/0046_qc_audit_db_role.sql creates `qc_audit` with SELECT everywhere and no INSERT on the ledger pair
  const sql = readFileSync(new URL("../../../db/migrations/0046_qc_audit_db_role.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE ROLE qc_audit NOLOGIN/); assert.match(sql, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO qc_audit/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ledger_entry_sets, ledger_lines, ledger_accounts FROM qc_audit/); assert.doesNotMatch(sql, /GRANT INSERT ON[^;]*ledger_/); assert.doesNotMatch(sql, /CREATE TABLE/);
  for (const t of QC_AUDIT_DB_GRANTS.insert) assert.ok(new RegExp(`GRANT INSERT ON[^;]*\\b${t}\\b`).test(sql), `${t} insert grant is in the migration`);
  for (const t of QC_AUDIT_DB_GRANTS.denied) assert.ok(new RegExp(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON[^;]*\\b${t}\\b`).test(sql), `${t} denial is in the migration`);
  // the attempt: INSERT into ledger_entries (ledger_entry_sets + ledger_lines) → SQLSTATE 42501, and the attempt is logged — an access_log row inserted and a security.access_denied event appended to the append-only event store
  const clock = new FixedClock("2026-10-02T14:00:00.000Z"); const events = new MemoryEventStore(clock); const access_log = new MemoryAccessLog();
  const a = qcAuditWriteAttempt({ table: "ledger_entries", op: "INSERT", principal: "qc-audit", at: "2026-10-02T14:00:00.000Z", statement: "INSERT INTO ledger_entry_sets (effective_date, description) VALUES ('2026-10-02', 'QC remediation F-2026-10-001')" }, { events, access_log });
  assert.equal(a.denied, true); assert.equal(a.sqlstate, "42501"); assert.equal(a.role, "qc_audit"); assert.deepEqual(a.physical_tables, ["ledger_entry_sets", "ledger_lines"]);
  assert.deepEqual(a.log!.access_log, { table_name: "ledger_entries", row_id: null, actor_kind: "agent", actor_id: "qc-audit", purpose: "write_denied:INSERT:42501", accessed_at: "2026-10-02T14:00:00.000Z" });   // the 0001_baseline.sql column set: table_name, row_id, actor_kind, actor_id, purpose, accessed_at
  assert.equal(a.log!.event.type, "security.access_denied"); assert.equal(a.log!.event.op, "INSERT"); assert.equal(a.log!.event.sqlstate, "42501"); assert.equal(a.log!.event.statement_hash, sha256("INSERT INTO ledger_entry_sets (effective_date, description) VALUES ('2026-10-02', 'QC remediation F-2026-10-001')")); assert.equal(a.log!.event.at, "2026-10-02T14:00:00.000Z");
  assert.deepEqual(access_log.rows, [a.log!.access_log]); assert.deepEqual(a.logged!.access_log_row, a.log!.access_log);
  const denied = events.ofType("security.access_denied"); assert.equal(denied.length, 1); assert.equal(denied[0]!.id, a.logged!.event_id); assert.equal(denied[0]!.occurredAt, "2026-10-02T14:00:00.000Z");
  assert.deepEqual(denied[0]!.actor, { kind: "agent", id: "qc-audit" }); assert.deepEqual(denied[0]!.aggregate, { kind: "db_role", id: "qc_audit" });
  assert.deepEqual(denied[0]!.payload, { role: "qc_audit", principal: "qc-audit", table: "ledger_entries", physical_tables: ["ledger_entry_sets", "ledger_lines"], op: "INSERT", sqlstate: "42501", statement_hash: sha256("INSERT INTO ledger_entry_sets (effective_date, description) VALUES ('2026-10-02', 'QC remediation F-2026-10-001')"), at: "2026-10-02T14:00:00.000Z" });
  // what the role may do: its own records and the two status columns; never an update or delete of an immutable row — permitted writes log nothing
  assert.equal(qcAuditWriteAttempt({ table: "qc_tests", op: "INSERT", principal: "qc-audit", at: "t" }, { events, access_log }).denied, false); assert.equal(qcAuditWriteAttempt({ table: "cases", op: "INSERT", principal: "qc-audit", at: "t" }, { events, access_log }).denied, false);
  assert.equal(qcAuditWriteAttempt({ table: "qc_findings", op: "UPDATE", column: "status", principal: "qc-audit", at: "t" }, { events, access_log }).denied, false); assert.equal(qcAuditWriteAttempt({ table: "qc_findings", op: "UPDATE", column: "finding_code", principal: "qc-audit", at: "2026-10-02T14:01:00.000Z" }, { events, access_log }).denied, true);
  assert.equal(access_log.rows.length, 2); assert.equal(events.ofType("security.access_denied").length, 2);
  for (const [table, op] of [["qc_tests", "UPDATE"], ["qc_tests", "DELETE"], ["loan_events", "INSERT"], ["notices", "INSERT"], ["qc_rules", "INSERT"], ["loans", "UPDATE"]] as const) assert.equal(qcAuditWriteAttempt({ table, op, principal: "qc-audit", at: "t" }).sqlstate, "42501", `${op} ${table}`);
  assert.equal(qcAuditMayWrite("ledger_entries"), false);
  // the tool bus refuses the same use before it reaches the database, and the refusal is itself logged on the append-only event store
  const ctx: UowContext = { loanId: "L-1", events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const cmd = toolCommand(TOOLS_18_1.find((t) => t.name === "ledger.recompute")!, rt, ["attorney", "fnma_portal_operator", "officer"]); agents.registerTool("qc-audit", cmd.name);
  const before = events.all().length;
  await assert.rejects(bus.execute(cmd, { kind: "agent", id: "qc-audit" }, { subject_id: "P-1", post: true, entry_set: { lines: [] } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_LEDGER_POST");
  assert.deepEqual(events.all().slice(before).map((e) => e.type), ["command.refused"]); assert.equal(ctx.ledger.sets().length, 0);
  assert.deepEqual(events.all().map((e) => e.type), ["security.access_denied", "security.access_denied", "command.refused"]);   // the DB-role denials and the bus refusal share the append-only log
  assert.ok(TOOLS_18_1.every((t) => t.kind === "read"), "every 18.1 tool is a read");
});

test("18.1-T11: Given a T1 agent's override rate of 18% for two consecutive days, then the kill-switch flag flips and human path routing is verified by a synthetic case.", () => {
  const daily = [{ day: D("2026-10-01"), value: 0.05 }, { day: D("2026-10-02"), value: 0.18 }, { day: D("2026-10-03"), value: 0.18 }];
  const ks = killSwitchEvaluation({ system_code: "lossmit-underwriter", risk_tier: "T1_consequential", metric: "override_rate", daily });
  assert.deepEqual(ks.band, { low: 0.02, high: 0.15 }); assert.equal(ks.consecutive_breach_days, 2); assert.equal(ks.tripped, true);
  assert.deepEqual(ks.flag, { key: "lossmit-underwriter.enabled", value: false }); assert.equal(ks.human_path, "human_agent");
  assert.deepEqual(ks.event, { type: "ai.kill_switch.tripped", system_code: "lossmit-underwriter", metric: "override_rate", days: [D("2026-10-02"), D("2026-10-03")], flag: "lossmit-underwriter.enabled=false" });
  assert.equal(killSwitch(daily.map((d) => d.value), "T1"), true);
  // one breaching day, or a T2 system, does not trip; below 2% (rubber-stamping) trips like above 15%
  assert.equal(killSwitchEvaluation({ system_code: "lossmit-underwriter", risk_tier: "T1_consequential", metric: "override_rate", daily: [daily[0]!, daily[1]!, { day: D("2026-10-03"), value: 0.1 }] }).tripped, false);
  assert.equal(killSwitchEvaluation({ system_code: "voice-collections", risk_tier: "T2_borrower_facing", metric: "override_rate", daily }).flag.value, true);
  assert.equal(killSwitchEvaluation({ system_code: "lossmit-underwriter", risk_tier: "T1_consequential", metric: "override_rate", daily: [{ day: D("2026-10-02"), value: 0.01 }, { day: D("2026-10-03"), value: 0.015 }] }).tripped, true);
  // the synthetic case: with the flag off it must reach the human path without the agent being invoked
  const synthetic = { id: "SYN-2026-10-03-001", kind: "synthetic" as const, subject_kind: "lossmit_application" };
  const ok = verifyHumanPath({ system_code: "lossmit-underwriter", flag: ks.flag, synthetic_case: synthetic, routing: { invoked: "human_agent", queue: "ops_console_lossmit_human_path", decided_by_kind: "human" } });
  assert.equal(ok.verified, true); assert.equal(ok.routed_to, "human_agent"); assert.equal(ok.agent_invoked, false); assert.deepEqual(ok.failures, []); assert.deepEqual(ok.evidence, { case_id: "SYN-2026-10-03-001", synthetic: true, flag: "lossmit-underwriter.enabled=false", routed_to: "human_agent" });
  const bad = verifyHumanPath({ system_code: "lossmit-underwriter", flag: ks.flag, synthetic_case: synthetic, routing: { invoked: "agent", queue: null, decided_by_kind: "agent" } });
  assert.equal(bad.verified, false); assert.equal(bad.agent_invoked, true); assert.deepEqual(bad.failures, ["the agent was invoked with the flag off", "no human queue on the synthetic case", "the synthetic case was not decided by a human"]);
  assert.deepEqual(verifyHumanPath({ system_code: "lossmit-underwriter", flag: { key: "lossmit-underwriter.enabled", value: true }, synthetic_case: synthetic, routing: { invoked: "human_agent", queue: "q", decided_by_kind: "human" } }).failures, ["flag lossmit-underwriter.enabled is not false"]);
});

test("18.1-T12: Given the AI-off flag, when the cycle runs, then census rederive results are identical and judgment samples appear in the human workbench with unchanged n.", () => {
  // August 2026 population from T1: 4,000 loss-mitigation decisions; the census rederive rows are the T2 escrow analyses.
  const population_ids = Array.from({ length: 4000 }, (_, k) => `lm-2026-08-${k + 1}`);
  const rederive = [{ subject_id: "ea-1", expected: 80_000n, observed: 120_000n }, { subject_id: "ea-2", expected: 80_000n, observed: 80_000n }, { subject_id: "ea-3", expected: 55_000n, observed: 55_000n }];
  const on = runCycle({ ai_off: false, population_ids, selection_seed: 20260903, rederive });
  const off = runCycle({ ai_off: true, population_ids, selection_seed: 20260903, rederive });
  // census rederives are engine-only either way — identical rows, identical variances
  assert.deepEqual(off.rederive_results, on.rederive_results);
  assert.ok(off.rederive_results.every((r) => r.reviewer_kind === "engine"));
  assert.deepEqual(off.rederive_results.map((r) => [r.subject_id, r.result, r.variance_cents]), [["ea-1", "fail", 40_000n], ["ea-2", "pass", 0n], ["ea-3", "pass", 0n]]);
  // judgment samples: unchanged n (351 of 4,000), the same seeded members, routed to the human workbench
  assert.equal(on.judgment.n, 351); assert.equal(off.judgment.n, on.judgment.n); assert.equal(off.judgment.population_n, 4000);
  assert.deepEqual(off.judgment.sample_ids, on.judgment.sample_ids); assert.equal(off.judgment.sample_ids.length, 351);
  assert.deepEqual(off.judgment.sample_ids, seededDraw(population_ids, 351, 20260903));
  assert.equal(off.judgment.queue, "ops_console_qc_workbench"); assert.equal(off.judgment.reviewer_kind, "human");
  assert.equal(on.judgment.queue, "llm_judgment"); assert.equal(on.judgment.reviewer_kind, "llm");
  assert.equal(off.judgment.human_review_below_confidence, 0.85);
  // the first-cut plan agrees, and targeted additions (100% of denials/appeals) are unaffected by the flag
  const plan = cyclePlan({ ai_off: true, population_n: 4000, rederive });
  assert.equal(plan.judgment.n, 351); assert.equal(plan.judgment.queue, "ops_console_qc_workbench"); assert.deepEqual(plan.rederive_results, off.rederive_results);
  assert.ok(targeted({ denial: true })); assert.ok(targeted({ appeal: true }));
});

test("18.1 worked figures: N = 4,000 loss-mit decisions → n = 351 (n0 = 384.16, floor 30, ceiling N); $4,800/yr escrow line → cushion 80,000¢ expected vs 120,000¢ observed (1/4 instead of 1/6) → variance 40,000¢ over-collected, sev-2, ledger credit 40,000¢ to escrow posted by `escrow`", () => {
  assert.equal(sampleSize(4000), 351);
  assert.equal(sampleSize(20), 20); assert.equal(sampleSize(30), 30); assert.equal(sampleSize(10_000_000), 385);   // ceiling N; n → ceil(n0) as N → ∞
  // rule C example: $4,800/yr line = 480,000¢; Appendix E cushion = 2 months = 1/6 = 80,000¢; the analysis used 1/4 = 120,000¢
  const esc = rederiveEscrowCushion({ subject_id: "ea-1", annual_disbursements_cents: 480_000n, observed_cushion_cents: 120_000n });
  assert.equal(esc.expected_cushion.cents, 80_000n); assert.equal(esc.expected_cushion.months, 2); assert.equal(esc.expected_cushion.cap_cents, 80_000n);
  assert.equal(esc.variance_cents, 40_000n); assert.equal(esc.result, "fail"); assert.equal(esc.rule_code, "QC_ESCROW_ANALYSIS_RECOMPUTE"); assert.equal(esc.reviewer_kind, "engine");
  assert.equal(esc.observed.fraction_of_annual, 0.25);
  assert.equal(rederiveEscrowCushion({ subject_id: "ea-2", annual_disbursements_cents: 480_000n, observed_cushion_cents: 80_000n }).result, "pass");
  // a state 1-month cap lowers the expected cushion to 40,000¢ — the 120,000¢ analysis is then 80,000¢ over
  assert.equal(rederiveEscrowCushion({ subject_id: "ea-3", annual_disbursements_cents: 480_000n, observed_cushion_cents: 120_000n, cushion: { state_max_months: 1 } }).variance_cents, 80_000n);
  const f = moneyFinding(80_000n, 120_000n, D("2026-10-01"), false, true);
  assert.equal(f.variance_cents, 40_000n); assert.equal(f.severity, "sev2"); assert.equal(f.corrected_notice, true); assert.equal(f.ledger_action, "reversing_entry_set"); assert.equal(f.remediation_due, D("2026-10-31"));
  assert.equal(moneyFinding(80_000n, 120_000n, D("2026-10-01"), true, true).severity, "sev1");   // not refunded before the payment change date
  const draft = remediationLedgerDraft({ finding_id: "F-2026-10-001", rule_code: "QC_ESCROW_ANALYSIS_RECOMPUTE", variance_cents: esc.variance_cents, from_account: "escrow_shortage_collected", to_account: "escrow", effective_date: D("2026-10-02"), owning_agent: "escrow" });
  assert.equal(draft.balanced, true); assert.equal(draft.posted_by, "escrow"); assert.equal(draft.drafted_by, "qc-audit");
  assert.deepEqual(draft.entry_set.lines.map((l) => [l.account, l.amountCents]), [["escrow", 40_000n], ["escrow_shortage_collected", -40_000n]]);
  assert.ok(draft.entry_set.lines.every((l) => l.ruleRef.includes("QC_ESCROW_ANALYSIS_RECOMPUTE")));
});

test("18.1 rederive engines: C-1.1-01 allocation order, the 7.2 second engine on a cap-bound adjustment ($250,000 at 6.500%/300 → $1,688.02), investor-event replay and timer history", () => {
  // $2,192.57 payment against interest $1,041.67 / principal $650.90 / escrow $500.00 — the production engine put $100 of escrow into principal
  const due = { interest_cents: 104_167n, principal_cents: 65_090n, escrow_cents: 50_000n, late_charge_cents: 0n };
  const good = rederivePaymentAllocation({ subject_id: "P-1", amount_cents: 219_257n, due, observed: { ...due, suspense_cents: 0n } });
  assert.equal(good.result, "pass"); assert.equal(good.variance_cents, 0n); assert.deepEqual(good.expected_allocation, { ...due, suspense_cents: 0n });
  const bad = rederivePaymentAllocation({ subject_id: "P-2", amount_cents: 219_257n, due, observed: { interest_cents: 104_167n, principal_cents: 75_090n, escrow_cents: 40_000n, late_charge_cents: 0n, suspense_cents: 0n } });
  assert.equal(bad.result, "fail"); assert.equal(bad.variance_cents, 10_000n); assert.deepEqual(bad.misapplied.map((m) => m.bucket), ["principal", "escrow"]);
  // a short payment ($2,000.00) under the uniform order fills interest, then principal, leaves escrow short and nothing in suspense
  const short = rederivePaymentAllocation({ subject_id: "P-3", amount_cents: 200_000n, due, observed: { interest_cents: 104_167n, principal_cents: 65_090n, escrow_cents: 30_743n, late_charge_cents: 0n, suspense_cents: 0n } });
  assert.equal(short.result, "pass"); assert.deepEqual(short.expected_allocation, { interest_cents: 104_167n, principal_cents: 65_090n, escrow_cents: 30_743n, late_charge_cents: 0n, suspense_cents: 0n });
  // pre-1999 instruments take escrow first
  assert.deepEqual(rederivePaymentAllocation({ subject_id: "P-4", profile: "pre_1999", amount_cents: 200_000n, due, observed: { ...due, suspense_cents: 0n } }).expected_allocation, { escrow_cents: 50_000n, interest_cents: 104_167n, principal_cents: 45_833n, late_charge_cents: 0n, suspense_cents: 0n });
  // ARM: index 4.30 + margin 2.75 = 7.05 → 7.000 (1/8 rounding) but the periodic 2% cap binds at 6.500 on a 4.500 prior rate;
  // the second engine is 7.2's engine B (BigInt fixed-point `verifyArmAdjustment`), not engine A that production ran: the level payment on $250,000 over 300 months at 6.500% is 250000·r·(1+r)^300/((1+r)^300−1), r = 0.065/12 → $1,688.02
  const rate = { index_pct: "4.30", margin_pct: "2.75", prior_rate_pct: "4.500", initial_note_rate_pct: "4.500", initial_cap_pct: "5.000", periodic_cap_pct: "2.000", lifetime_cap_pct: "5.000", first_change: false };
  const arm = rederiveArmAdjustment({ subject_id: "L-ARM", rate, expected_upb_cents: 25_000_000n, remaining_term: 300, observed: { new_rate_pct: "6.500", payment_cents: 168_802n } });
  assert.equal(arm.expected_rate.engine, "B"); assert.equal(arm.expected.engine, "B"); assert.equal(arm.expected_rate.midpoint_flag, false);
  assert.equal(arm.expected_rate.new_rate_pct, "6.500"); assert.equal(arm.expected_rate.unrounded_pct, "7.05000"); assert.equal(arm.expected_rate.bound, "periodic"); assert.equal(arm.cap_bound, true); assert.equal(arm.rate_matches, true);
  assert.equal(arm.expected.cents, 168_802n); assert.equal(arm.variance_cents, 0n); assert.equal(arm.result, "pass");
  // engine A (what 7.2's production `computeArmAdjustment` posts) agrees to the cent on this adjustment — the census compares production's figure with B, so an A defect surfaces as a variance instead of being reproduced
  assert.equal(newPayment(25_000_000n, "6.500", 300), 168_802n); assert.deepEqual(computeArmAdjustment({ ...rate, expected_upb_cents: 25_000_000n, remaining_term_months: 300 }), { new_rate_pct: "6.500", unrounded_pct: "7.05000", bound: "periodic", new_pi_cents: 168_802n, engine: "A" });
  // an exact 1/16 midpoint (index 4.3125 + margin 2.75 = 7.0625) is flagged for QC and rounds half-down to 7.000 (B2-1.4-02 default); the observed "7.0" is the same rate written differently
  const mid = rederiveArmAdjustment({ subject_id: "L-MID", rate: { ...rate, index_pct: "4.3125", prior_rate_pct: "6.000" }, expected_upb_cents: 25_000_000n, remaining_term: 300, observed: { new_rate_pct: "7.0", payment_cents: 176_695n } });
  assert.equal(mid.expected_rate.midpoint_flag, true); assert.equal(mid.expected_rate.new_rate_pct, "7.000"); assert.equal(mid.rate_matches, true); assert.equal(mid.result, "pass");
  const uncapped = rederiveArmAdjustment({ subject_id: "L-ARM", rate, expected_upb_cents: 25_000_000n, remaining_term: 300, observed: { new_rate_pct: "7.000", payment_cents: 176_695n } });
  assert.equal(uncapped.rate_matches, false); assert.equal(uncapped.result, "fail"); assert.equal(uncapped.variance_cents, 7_893n);   // the production engine skipped the periodic cap: $1,766.95 charged vs $1,688.02 due
  const shortPay = rederiveArmAdjustment({ subject_id: "L-ARM", rate, expected_upb_cents: 25_000_000n, remaining_term: 300, observed: { new_rate_pct: "6.500", payment_cents: 168_702n } });
  assert.equal(shortPay.rate_matches, true); assert.equal(shortPay.variance_cents, -100n); assert.equal(shortPay.result, "fail");
  // investor events: a rejected LAR that was never corrected fails the replay; corrected → pass
  const iev = (id: string, type: string, seq: number, ref: string) => ({ id, type, occurredAt: `2026-09-0${seq}T10:00:00.000Z`, sequence: seq, payload: { event_id: ref } });
  const replay = replayInvestorEvents({ loan_id: "L-1", events: [iev("e1", "investor_event.sent", 1, "lar-1"), iev("e2", "investor_event.rejected", 2, "lar-1"), iev("e3", "loan.payment.posted", 3, "x")] });
  assert.equal(replay.result, "fail"); assert.deepEqual(replay.open_rejections, ["e2"]); assert.equal(replay.timeline.length, 2); assert.equal(replay.counts.rejected, 1);
  assert.equal(replayInvestorEvents({ loan_id: "L-1", events: [iev("e1", "investor_event.sent", 1, "lar-1"), iev("e2", "investor_event.rejected", 2, "lar-1"), iev("e4", "investor_event.corrected", 4, "lar-1"), iev("e5", "investor_event.accepted", 5, "lar-1")] }).result, "pass");
  // timer history: satisfied before due is on time; satisfied after due is late; breached is a fail
  // SM_QC_FINDING_VALIDATE_5BD armed Tue 2026-09-01 → 5 servicer BD = Wed 2026-09-09 (Labor Day 09-07)
  assert.equal(findingValidateDue(D("2026-09-01")), D("2026-09-09"));
  const h = timerHistory([
    { id: "t1", code: "SM_QC_FINDING_VALIDATE_5BD", status: "satisfied", armedAt: "2026-09-01T00:00:00.000Z", armedByEventId: "a1", dueAt: Date.parse("2026-09-09T23:59:00.000Z"), dueDate: findingValidateDue(D("2026-09-01")), satisfiedAt: "2026-09-04T12:00:00.000Z", satisfiedByEventId: "s1" },
    { id: "t2", code: "SM_QC_CAPA_SEV1_10BD", status: "breached", armedAt: "2026-10-01T00:00:00.000Z", armedByEventId: "a2", dueAt: Date.parse("2026-10-16T23:59:00.000Z"), dueDate: capaDueOn(D("2026-10-01"), "sev1_consumer_harm_or_fnma_breach").due, breachedAt: "2026-10-17T00:00:00.000Z" },
  ], [{ id: "s1", type: "timer.satisfied", occurredAt: "2026-09-04T12:00:00.000Z", payload: { timer_id: "t1" } }]);
  assert.deepEqual(h.rows.map((r) => [r.id, r.due_date, r.on_time]), [["t1", D("2026-09-09"), true], ["t2", D("2026-10-16"), false]]); assert.deepEqual(h.late_or_breached, ["t2"]); assert.equal(h.result, "fail"); assert.equal(h.rows[0]!.events.length, 1);
});

test("18.1 timers: every satisfaction event the registry names is one the process emits; sev-1 CAPA due 2026-10-16; effectiveness at the next cycle close; QC-results request 10 BD; CSBS audit FYE + 12 months; annual governance clocks; Colorado impact assessment", () => {
  const capas = [{ id: "c1", action_kind: "refund", status: "completed" as const, completed_on: D("2026-10-09") }, { id: "c2", action_kind: "re_notice", status: "completed" as const, completed_on: D("2026-10-12") }];
  const done = capaCompletion({ finding_id: "F-1", severity: "sev1_consumer_harm_or_fnma_breach", validated_on: D("2026-10-01"), capas, today: D("2026-10-12") });
  assert.equal(done.timer.code, "SM_QC_CAPA_SEV1_10BD"); assert.equal(done.timer.due, D("2026-10-16"));
  assert.equal(done.all_completed, true); assert.equal(done.event!.type, reg.get("SM_QC_CAPA_SEV1_10BD")!.satisfiedPattern!.type); assert.equal(done.event!.completed_on, D("2026-10-12"));
  assert.equal(capaCompletion({ finding_id: "F-2", severity: "sev2_rule_breach_no_harm", validated_on: D("2026-10-01"), capas, today: D("2026-10-12") }).timer.due, D("2026-10-31"));
  // a single CAPA completing (with evidence) arms the effectiveness clock at the next cycle close: completed 2026-10-12 → the November cycle closes BD20 = 2026-12-01 (Veterans Day, Thanksgiving)
  const eff0 = reg.get("SM_QC_CAPA_EFFECTIVENESS_NEXT_CYCLE")!;
  assert.equal(completeCapa({ finding_id: "F-1", capa_id: "c1", completed_on: D("2026-10-12"), evidence_document_ids: [] }).event, null);
  const cc = completeCapa({ finding_id: "F-1", capa_id: "c1", completed_on: D("2026-10-12"), evidence_document_ids: ["doc-refund-batch-1"] });
  assert.ok(eventMatches(eff0.triggerPattern!, ev(cc.event!.type, { ...cc.event }))); assert.equal(eff0.anchorField, "next_cycle_close_on"); assert.equal(cc.event!.next_cycle_close_on, D("2026-12-01")); assert.equal(nextCycleCloseOn(D("2026-10-12")), addBusinessDays(D("2026-10-31"), 20, servicer));
  // effectiveness: a re-test within tolerance closes; above tolerance reopens and does not satisfy
  const eff = effectivenessCheck({ finding_id: "F-1", capa_id: "c1", completed_on: D("2026-10-12"), next_cycle_close_on: cc.event!.next_cycle_close_on, retest: { fails: 1, passes: 999, family: "rederive" } });
  assert.ok(eventMatches(eff0.satisfiedPattern!, ev(eff.event.type, { ...eff.event }))); assert.equal(eff.result, "pass"); assert.equal(eff.finding_status, "closed");
  const failed = effectivenessCheck({ finding_id: "F-1", capa_id: "c1", completed_on: D("2026-10-12"), next_cycle_close_on: cc.event!.next_cycle_close_on, retest: { fails: 24, passes: 976, family: "rederive" } });
  assert.equal(failed.finding_status, "reopened"); assert.equal(eventMatches(eff0.satisfiedPattern!, ev(failed.event.type, { ...failed.event })), false);
  // consumer remediation: refunds posted + notices sent within 30 days of validation
  const rem = consumerRemediation({ finding_id: "F-1", validated_on: D("2026-10-01"), remediation_cents_total: 40_000n, refunds: [{ loan_id: "L-1", cents: 40_000n, posted_on: D("2026-10-09") }], notices: [{ loan_id: "L-1", template_code: "NTC_REGX_1024_17_ANNUAL_STMT", sent_on: D("2026-10-12") }], today: D("2026-10-12") });
  assert.equal(rem.due, D("2026-10-31")); assert.equal(rem.complete, true); assert.ok(eventMatches(reg.get("SM_QC_CONSUMER_REMEDIATION_30")!.satisfiedPattern!, ev(rem.event!.type, { ...rem.event }))); assert.equal(rem.officer_required, false);
  const half = consumerRemediation({ finding_id: "F-1", validated_on: D("2026-10-01"), remediation_cents_total: 40_000n, refunds: [{ loan_id: "L-1", cents: 40_000n, posted_on: D("2026-10-09") }], notices: [{ loan_id: "L-1", template_code: "NTC_REGX_1024_17_ANNUAL_STMT", sent_on: null }], today: D("2026-11-02") });
  assert.equal(half.event, null); assert.equal(half.breached, true); assert.equal(half.refunds_posted, true); assert.equal(half.notices_sent, false);
  assert.equal(consumerRemediation({ finding_id: "F-3", validated_on: D("2026-10-01"), remediation_cents_total: 2_600_000n, refunds: [], notices: [], today: D("2026-10-01") }).officer_required, true);   // > $25,000 aggregate → officer
  // Fannie Mae QC-results request: received Mon 2026-11-02 → 10 BD = 2026-11-17 (Veterans Day 11-11); as-stated date wins; delivery event needs officer signature + evidence
  const req = qcResultsRequest({ received_on: D("2026-11-02") });
  assert.equal(req.due, D("2026-11-17")); assert.equal(req.basis, "default_10bd"); assert.equal(req.delivery.kind, "human_portal_task");
  assert.equal(qcResultsRequest({ received_on: D("2026-11-02"), stated_due: D("2026-11-30") }).due, D("2026-11-30"));
  const dl = qcResultsDelivered({ request_id: "R-1", delivered_on: D("2026-11-10"), signed_by_role: "officer", delivery_evidence_document_id: "doc-lqc-1" });
  assert.ok(eventMatches(reg.get("FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD")!.satisfiedPattern!, ev(dl.event!.type, { ...dl.event })));
  assert.equal(qcResultsDelivered({ request_id: "R-1", delivered_on: D("2026-11-10"), signed_by_role: "ops_analyst", delivery_evidence_document_id: "doc-lqc-1" }).event, null);
  assert.equal(qcResultsDelivered({ request_id: "R-1", delivered_on: D("2026-11-10"), signed_by_role: "officer", delivery_evidence_document_id: null }).event, null);
  // CSBS external audit: ≥2,000 loans in ≥2 states → AFS with audit opinion within 12 months of FYE; only an AFS carrying the opinion satisfies
  const csbs = csbsExternalAudit({ fye: D("2026-12-31"), loan_count: 2_400, states: 3 });
  assert.equal(csbs.applicable, true); assert.equal(csbs.due, D("2027-12-31")); assert.equal(csbsExternalAudit({ fye: D("2026-12-31"), loan_count: 1_500, states: 3 }).applicable, false);
  const csbsRow = reg.get("CSBS_EXTERNAL_AUDIT_ANNUAL")!; assert.deepEqual(csbsRow.offsetParsed, { kind: "step", n: 12, unit: "months" });
  const afs = afsReceived({ fiscal_year_end: D("2026-12-31"), received_on: D("2027-03-10"), audit_opinion: "unqualified", auditor: "external-cpa-llp", document_id: "doc-afs-2026" });
  assert.ok(eventMatches(csbsRow.satisfiedPattern!, ev(afs.event!.type, { ...afs.event })));
  const noOpinion = afsReceived({ fiscal_year_end: D("2026-12-31"), received_on: D("2027-03-10"), audit_opinion: null, auditor: "internal", document_id: "doc-unaudited" });
  assert.equal(eventMatches(csbsRow.satisfiedPattern!, ev(noOpinion.event!.type, { ...noOpinion.event })), false);
  // annual governance clocks: policy review by the owner (warning 60 days out), plan re-approval, ISBR attestation by an officer, monthly monitoring review
  const pol = annualPolicyReview({ policy_code: "AI-GOV-001", version: "2026.1", approved_on: D("2026-07-15"), reviewed_on: D("2027-06-30"), reviewer: AI_OWNER });
  assert.equal(pol.due, D("2027-07-15")); assert.equal(pol.warn_on, D("2027-05-16")); assert.ok(eventMatches(reg.get("FNMA_LL202604_AI_POLICY_REVIEW_ANNUAL")!.satisfiedPattern!, ev(pol.event!.type, { ...pol.event }))); assert.equal(pol.event!.next_review_due, D("2028-06-30"));
  assert.equal(annualPolicyReview({ policy_code: "AI-GOV-001", version: "2026.1", approved_on: D("2026-07-15"), reviewed_on: D("2027-06-30"), reviewer: PLAIN_OFFICER }).event, null);
  const plan = planApproved({ version: "2026.1", approved_on: D("2026-08-01"), approved_by: PLAIN_OFFICER, partner_accepted_on: D("2026-08-05"), document_id: "doc-qc-plan-2026.1" });
  assert.equal(plan.reapproval_due, D("2027-08-01")); assert.ok(eventMatches(reg.get("FNMA_A4101_QC_PLAN_REAPPROVAL_ANNUAL")!.satisfiedPattern!, ev(plan.event!.type, { ...plan.event }))); assert.ok(eventMatches(reg.get("FNMA_A4101_QC_PLAN_REAPPROVAL_ANNUAL")!.triggerPattern!, ev(plan.event!.type, { ...plan.event })));
  assert.equal(planApproved({ version: "2026.1", approved_on: D("2026-08-01"), approved_by: PLAIN_OFFICER, partner_accepted_on: null, document_id: "d" }).event, null);
  const isbr = isbrAttestationSigned({ fiscal_year_end: D("2026-12-31"), signed_on: D("2027-03-20"), signer: PLAIN_OFFICER, document_id: "doc-isbr-2026" });
  assert.equal(isbr.due, D("2027-03-31")); assert.ok(eventMatches(reg.get("FNMA_ISBR_ANNUAL_ATTESTATION")!.satisfiedPattern!, ev(isbr.event!.type, { ...isbr.event })));
  assert.equal(isbrAttestationSigned({ fiscal_year_end: D("2026-12-31"), signed_on: D("2027-03-20"), signer: ANALYST, document_id: "doc-isbr-2026" }).event, null);
  // the monthly monitoring review (spec anchor BD5) is due BD5 of the month after the metrics month: month-end 2026-09-30 → Wed 2026-10-07, the review date of the September metrics
  const mt = reg.get("SM_AI_MONITORING_REVIEW_MONTHLY")!; assert.equal(mt.triggerPattern!.raw, "period.month_end"); assert.deepEqual(mt.offsetParsed, { kind: "step", n: 5, unit: "business_days_servicer" }); assert.equal(mt.kindNorm, "recurring");
  assert.equal(addBusinessDays(D("2026-09-30"), 5, servicer), D("2026-10-07"));
  const mon = monitoringReviewed({ month: "2026-09", reviewed_on: D("2026-10-07"), reviewer: AI_OWNER, systems_reviewed: ["lossmit-underwriter", "voice-collections"] });
  assert.ok(eventMatches(mt.satisfiedPattern!, ev(mon.event!.type, { ...mon.event }))); assert.equal(monitoringReviewed({ month: "2026-09", reviewed_on: D("2026-10-07"), reviewer: ANALYST, systems_reviewed: ["x"] }).event, null);
  // Colorado impact assessment: a T1 deployment arms the clock 12 months out; a major change within 90 days; a minor change carries the date; the completed assessment satisfies and re-arms 12 months out
  const co = reg.get("CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL")!; assert.equal(co.anchorField, "impact_assessment_due");
  const first = impactAssessmentClock({ risk_tier: "T1_consequential", change_kind: "new", deployed_on: D("2026-09-11"), current_due: null });
  assert.deepEqual(first, { arms: true, impact_assessment_due: D("2027-09-11"), basis: "12_months_from_deployment" });
  const t1 = (change_kind: AiVersion["change_kind"], on: string, current?: string) => deployVersion({ system_code: "lossmit-underwriter", version: `v-${on}`, tier: "T1_consequential", change_kind, status: "approved", suites: [{ suite_code: "golden_t1", mandatory: true, pass: true }], approved_by: "u-ai-gov-owner" }, D(on), { current_impact_assessment_due: current ? D(current) : null }).event!;
  // the deployment event itself carries the anchor the row reads — the trigger matches the real event, not a hand-built payload
  const newDeploy = t1("new", "2026-09-11"); assert.equal(newDeploy.impact_assessment_due, first.impact_assessment_due); assert.ok(eventMatches(co.triggerPattern!, ev(newDeploy.type, { ...newDeploy })));
  assert.deepEqual(impactAssessmentClock({ risk_tier: "T1_consequential", change_kind: "major", deployed_on: D("2026-11-15"), current_due: D("2027-09-11") }), { arms: true, impact_assessment_due: D("2027-02-13"), basis: "90_days_from_major_change" });
  assert.deepEqual(impactAssessmentClock({ risk_tier: "T1_consequential", change_kind: "minor", deployed_on: D("2026-11-15"), current_due: D("2027-09-11") }), { arms: false, impact_assessment_due: D("2027-09-11"), basis: "carried_forward" });
  const major = t1("major", "2026-11-15", "2027-09-11"); assert.equal(major.impact_assessment_due, D("2027-02-13")); assert.ok(eventMatches(co.triggerPattern!, ev(major.type, { ...major })));
  const minor = t1("minor", "2026-11-15", "2027-09-11"); assert.equal(minor.impact_assessment_due, D("2027-09-11")); assert.equal(eventMatches(co.triggerPattern!, ev(minor.type, { ...minor })), false);
  assert.equal(eventMatches(co.triggerPattern!, ev("ai_system.deployed", { risk_tier: "T2_borrower_facing", change_kind: "new" })), false);
  assert.equal(impactAssessmentClock({ risk_tier: "T2_borrower_facing", change_kind: "new", deployed_on: D("2026-09-11"), current_due: null }).arms, false);
  // through the real engine: the new deployment arms at 2027-09-11 and the major change at 2027-02-13 — never on the deployment date
  const eng = drive(["CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL"]); eng.emit(newDeploy, "2026-09-11"); eng.emit(major, "2026-11-15"); eng.emit(minor, "2026-11-15");
  assert.deepEqual(eng.engine.byCode("CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL").map((t) => [t.anchorDate, t.dueDate, t.status]), [[D("2027-09-11"), D("2027-09-11"), "armed"], [D("2027-02-13"), D("2027-02-13"), "armed"]]);
  const ia = impactAssessmentCompleted({ system_code: "lossmit-underwriter", completed_on: D("2027-02-01"), document_id: "doc-co-ia-2027" });
  assert.ok(eventMatches(co.satisfiedPattern!, ev(ia.event!.type, { ...ia.event }))); assert.equal(ia.event!.impact_assessment_due, D("2028-02-01")); assert.equal(impactAssessmentCompleted({ system_code: "x", completed_on: D("2027-02-01"), document_id: null }).event, null);
  // SM_AI_EVAL_GATE: all suites + officer approval opens it; a T3 needs no approval
  const suites = [{ suite_code: "golden_t1", mandatory: true, pass: true }, { suite_code: "prompt_injection", mandatory: true, pass: true }];
  assert.equal(evaluateGate("18.1.aiEvalGatePassed", { tier: "T1_consequential", suites, approved_by: null }).open, false);
  assert.equal(evaluateGate("18.1.aiEvalGatePassed", { tier: "T1_consequential", suites, approved_by: "officer-ai-gov" }).open, true);
  assert.equal(evaluateGate("18.1.aiEvalGatePassed", { tier: "T3_internal", suites, approved_by: null }).open, true);
});

test("18.1 guardrails: the six tools are reads and every write-shaped use is refused for every actor — no ledger post, no statement, no rate change, no borrower communication, no timer arm, no resubmission or rule-set change", () => {
  const rail = (tool: string, code: string) => TOOLS_18_1.find((t) => t.name === tool)!.guardrails!.find((g) => g.code === code)!;
  const refusals = (tool: string, input: Record<string, unknown>, actor: Actor) => TOOLS_18_1.find((t) => t.name === tool)!.guardrails!.filter((g) => g.refuse(input, { actor } as CommandContext) !== undefined).map((g) => g.code);
  assert.deepEqual(TOOLS_18_1.map((t) => [t.process, t.agent, t.name, t.kind]), [["18.1", "qc-audit", "ledger.recompute", "read"], ["18.1", "qc-audit", "escrow.recompute_analysis", "read"], ["18.1", "qc-audit", "arm.second_engine", "read"], ["18.1", "qc-audit", "notice.checklist", "read"], ["18.1", "qc-audit", "timers.history", "read"], ["18.1", "qc-audit", "investor_events.replay", "read"]]);
  for (const actor of [QC_AGENT, ANALYST, PLAIN_OFFICER, QC_OFFICER] as Actor[]) {
    assert.deepEqual(refusals("ledger.recompute", { subject_id: "P-1", post: true }, actor), ["NO_LEDGER_POST"]); assert.deepEqual(refusals("ledger.recompute", { subject_id: "P-1", entry_set: {} }, actor), ["NO_LEDGER_POST"]); assert.deepEqual(refusals("ledger.recompute", { subject_id: "P-1", op: "write" }, actor), ["NO_LEDGER_POST"]);
    assert.deepEqual(refusals("escrow.recompute_analysis", { subject_id: "ea-1", issue_statement: true }, actor), ["STATEMENT_ISSUED_BY_ESCROW"]); assert.deepEqual(refusals("escrow.recompute_analysis", { subject_id: "ea-1", changes: { cushion_cents: 80_000n } }, actor), ["STATEMENT_ISSUED_BY_ESCROW"]);
    assert.deepEqual(refusals("arm.second_engine", { subject_id: "L-ARM", apply: true }, actor), ["SECOND_ENGINE_NEVER_APPLIES"]); assert.deepEqual(refusals("arm.second_engine", { subject_id: "L-ARM", correct_rate: true }, actor), ["SECOND_ENGINE_NEVER_APPLIES"]); assert.deepEqual(refusals("arm.second_engine", { subject_id: "L-ARM", op: "apply" }, actor), ["SECOND_ENGINE_NEVER_APPLIES"]);
    assert.deepEqual(refusals("notice.checklist", { template_code: "NTC_X", op: "send" }, actor), ["NO_BORROWER_COMMUNICATION"]); assert.deepEqual(refusals("notice.checklist", { template_code: "NTC_X", resend: true }, actor), ["NO_BORROWER_COMMUNICATION"]);
    assert.deepEqual(refusals("timers.history", { subject_id: "L-1", op: "arm" }, actor), ["TIMERS_READ_ONLY"]); assert.deepEqual(refusals("timers.history", { subject_id: "L-1", op: "satisfy" }, actor), ["TIMERS_READ_ONLY"]); assert.deepEqual(refusals("timers.history", { subject_id: "L-1", op: "cancel" }, actor), ["TIMERS_READ_ONLY"]);
    assert.deepEqual(refusals("investor_events.replay", { loan_id: "L-1", resubmit: true }, actor), ["REPLAY_NEVER_RESUBMITS"]); assert.deepEqual(refusals("investor_events.replay", { loan_id: "L-1", rule_set_version_override: "5.1@2" }, actor), ["REPLAY_NEVER_RESUBMITS"]); assert.deepEqual(refusals("investor_events.replay", { loan_id: "L-1", emit: true }, actor), ["REPLAY_NEVER_RESUBMITS"]);
    // the read uses pass
    assert.deepEqual(refusals("ledger.recompute", { subject_id: "P-1", amount_cents: 219_257n }, actor), []); assert.deepEqual(refusals("timers.history", { subject_id: "L-1", code: "SM_QC_FINDING_VALIDATE_5BD" }, actor), []); assert.deepEqual(refusals("investor_events.replay", { loan_id: "L-1", from: "2026-09-01" }, actor), []);
  }
  for (const [tool, code] of [["ledger.recompute", "NO_LEDGER_POST"], ["escrow.recompute_analysis", "STATEMENT_ISSUED_BY_ESCROW"], ["arm.second_engine", "SECOND_ENGINE_NEVER_APPLIES"], ["notice.checklist", "NO_BORROWER_COMMUNICATION"], ["timers.history", "TIMERS_READ_ONLY"], ["investor_events.replay", "REPLAY_NEVER_RESUBMITS"]] as const) assert.match(rail(tool, code).citation, /never write to operational tables, post ledger entries, send borrower communications, or change rule sets/);
});

test("18.1 timer engine: every armable row arms through the real TimerEngine from the process's own emitters with the spec's due date; the deadline rows and the eval gate satisfy (and breach) in-engine; the recurring rows satisfy in-engine and re-arm on the next period", () => {
  // ---- deadline rows and the gate: arm → satisfy end to end in one engine (no recurring row is armed in it)
  const dl = drive(["SM_QC_FINDING_VALIDATE_5BD", "SM_QC_CAPA_SEV1_10BD", "SM_QC_CONSUMER_REMEDIATION_30", "SM_QC_CAPA_EFFECTIVENESS_NEXT_CYCLE", "FNMA_A4101_QC_REPORT_SENIOR_MGMT_MONTHLY", "SM_QC_REPORT_PARTNER_MONTHLY", "FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD", "FNMA_LL202604_AI_DISCLOSURE_REQUEST_5BD", "SM_AI_EVAL_GATE"]);
  // a sev-1 population finding opened Thu 2026-09-24 → validate by Thu 2026-10-01; validated that day with 40,000¢ of remediation → CAPA by Fri 2026-10-16 (Columbus Day), refunds + notices by 2026-10-31
  const pf = populationFinding({ rule_code: "QC_LOSSMIT_DENIAL_NOTICE", cycle_id: "C-2026-09", fails: 1, passes: 999, family: "sev1_consumer_harm", opened_on: D("2026-09-24") }).finding!;
  dl.emit(pf.event, "2026-09-24");
  const validate = dl.armed("SM_QC_FINDING_VALIDATE_5BD"); assert.equal(validate.anchorDate, D("2026-09-24")); assert.equal(validate.dueDate, D("2026-10-01")); assert.deepEqual(validate.subject, { kind: "global", id: "*" });
  const validated = findingTransition({ status: "open", severity: pf.severity, root_cause: null, finding_id: pf.finding_code, remediation_cents_total: 40_000n }, "validated", QC_OFFICER, D("2026-10-01")).event!;
  dl.emit(validated, "2026-10-01");
  assert.equal(validate.status, "satisfied");
  const capa = dl.armed("SM_QC_CAPA_SEV1_10BD"); assert.equal(capa.dueDate, D("2026-10-16")); assert.equal(capa.dueDate, capaDueOn(D("2026-10-01"), "sev1_consumer_harm_or_fnma_breach").due);
  const rem = dl.armed("SM_QC_CONSUMER_REMEDIATION_30"); assert.equal(rem.dueDate, D("2026-10-31"));
  // no CAPA completes by the due date: the engine breaches the sev-1 clock (sev-1 → officer); the late completion then closes it as satisfied_late
  const breaches = dl.engine.evaluate("2026-10-17T04:00:00.000Z");
  assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity, [...b.escalateTo]]), [["SM_QC_CAPA_SEV1_10BD", 1, ["officer"]]]); assert.equal(capa.status, "breached");
  const capas = [{ id: "c1", action_kind: "refund", status: "completed" as const, completed_on: D("2026-10-19") }];
  dl.emit(capaCompletion({ finding_id: pf.finding_code, severity: pf.severity, validated_on: D("2026-10-01"), capas, today: D("2026-10-19") }).event!, "2026-10-19");
  assert.equal(capa.status, "satisfied_late");
  dl.emit(consumerRemediation({ finding_id: pf.finding_code, validated_on: D("2026-10-01"), remediation_cents_total: 40_000n, refunds: [{ loan_id: "L-1", cents: 40_000n, posted_on: D("2026-10-19") }], notices: [{ loan_id: "L-1", template_code: "NTC_X", sent_on: D("2026-10-20") }], today: D("2026-10-20") }).event!, "2026-10-20");
  assert.equal(rem.status, "satisfied");
  // the CAPA completing with evidence arms the effectiveness re-test at the computed anchor (next cycle close 2026-12-01); a failed re-test does not satisfy, a pass does
  dl.emit(completeCapa({ finding_id: pf.finding_code, capa_id: "c1", completed_on: D("2026-10-19"), evidence_document_ids: ["doc-1"] }).event!, "2026-10-19");
  const eff = dl.armed("SM_QC_CAPA_EFFECTIVENESS_NEXT_CYCLE"); assert.equal(eff.anchorDate, D("2026-12-01")); assert.equal(eff.dueDate, D("2026-12-01"));
  dl.emit(effectivenessCheck({ finding_id: pf.finding_code, capa_id: "c1", completed_on: D("2026-10-19"), next_cycle_close_on: D("2026-12-01"), retest: { fails: 24, passes: 976, family: "rederive" } }).event, "2026-12-01"); assert.equal(eff.status, "armed");
  dl.emit(effectivenessCheck({ finding_id: pf.finding_code, capa_id: "c1", completed_on: D("2026-10-19"), next_cycle_close_on: D("2026-12-01"), retest: { fails: 1, passes: 999, family: "rederive" } }).event, "2026-12-01"); assert.equal(eff.status, "satisfied");
  // the signed cycle (Fri 2026-09-04 before Labor Day) arms both 5-BD report clocks at Mon 2026-09-14; each audience's delivery satisfies its own row only
  dl.emit(signCycle({ cycle_id: "C-2026-08", signed_on: D("2026-09-04"), signer: QC_OFFICER }).event!, "2026-09-04");
  const sm = dl.armed("FNMA_A4101_QC_REPORT_SENIOR_MGMT_MONTHLY"), pr = dl.armed("SM_QC_REPORT_PARTNER_MONTHLY"); assert.equal(sm.dueDate, D("2026-09-14")); assert.equal(pr.dueDate, D("2026-09-14"));
  dl.emit(reportDelivered({ cycle_id: "C-2026-08", audience: "senior_management", signed_on: D("2026-09-04"), delivered_on: D("2026-09-11"), delivery_evidence: "board-portal receipt" }).event!, "2026-09-11");
  assert.equal(sm.status, "satisfied"); assert.equal(pr.status, "armed");
  dl.emit(reportDelivered({ cycle_id: "C-2026-08", audience: "partner", signed_on: D("2026-09-04"), delivered_on: D("2026-09-14"), delivery_evidence: "sftp manifest" }).event!, "2026-09-14"); assert.equal(pr.status, "satisfied");
  // Fannie Mae requests: QC results received Mon 2026-11-02 → 10 BD = 2026-11-17 (Veterans Day); AI disclosure → 5 BD = 2026-11-09
  assert.throws(() => qcResultsRequestReceived(dl.events, { request_id: "R-1", received_on: D("2026-11-02"), requested: [], channel: "letter" }), RangeError);   // the letter names what Fannie Mae asked for
  const qreq = qcResultsRequestReceived(dl.events, { request_id: "R-1", received_on: D("2026-11-02"), requested: ["results", "evidence of correction actions"], channel: "letter" });
  assert.equal(qreq.event.type, "fnma.request.received"); assert.equal(qreq.event.payload.kind, "qc_results"); assert.equal(qreq.event.payload.received_at, D("2026-11-02")); assert.equal(qreq.basis, "default_10bd"); assert.equal(qreq.due, D("2026-11-17"));
  const qr = dl.armed("FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD"); assert.equal(qr.anchorDate, D("2026-11-02")); assert.equal(qr.dueDate, D("2026-11-17")); assert.deepEqual(qr.subject, requestSubject("R-1"));
  appendQcEvent(dl.events, qcResultsDelivered({ request_id: "R-1", delivered_on: D("2026-11-10"), signed_by_role: "officer", delivery_evidence_document_id: "doc-lqc-1" }).event!, "2026-11-10", { aggregate: requestSubject("R-1") }); assert.equal(qr.status, "satisfied");
  const req = aiDisclosureRequest({ request_id: "FNMA-AI-1", requester: "fnma", received_on: D("2026-11-02"), requested: ["types"] }); dl.emit(req.event, "2026-11-02");
  const ad = dl.armed("FNMA_LL202604_AI_DISCLOSURE_REQUEST_5BD"); assert.equal(ad.dueDate, D("2026-11-09"));
  dl.emit(sendAiDisclosure({ request_id: "FNMA-AI-1", due: req.due, signer: AI_OWNER, delivered_by: "fnma_portal_operator", sent_on: D("2026-11-06"), package_document_id: "doc-ai" }).event!, "2026-11-06"); assert.equal(ad.status, "satisfied");
  // the eval gate: armed as an evaluator-backed gate on `ai.version.proposed`, closed by the owner's approval
  const proposed = proposeVersion(dl.events, { system_code: "lossmit-underwriter", version: "v2", tier: "T1_consequential", change_kind: "minor", prompt_hash: "sha256:v2", proposed_on: D("2026-09-09"), proposed_by: QC_AGENT });
  const gate = dl.armed("SM_AI_EVAL_GATE"); assert.equal(gate.dueDate, undefined); assert.equal(gate.note, "evaluator:18.1.aiEvalGatePassed"); assert.deepEqual(gate.subject, versionSubject("lossmit-underwriter", "v2"));
  const v: AiVersion = recordEvaluations(proposed.version, [{ suite_code: "prompt_injection", mandatory: true, pass: true }]).version; assert.equal(v.status, "evaluated");
  const approved = recordVersionApproved(dl.events, v, AI_OWNER, D("2026-09-10")); assert.equal(approved.appended!.type, "ai.version.approved"); assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedByEventId, approved.appended!.id);
  assert.ok(dl.engine.all().every((t) => t.status === "satisfied" || t.status === "satisfied_late"), "every deadline row and the gate closed in-engine");
  assert.equal(dl.events.ofType("timer.armed").length, 9); assert.equal(dl.events.ofType("timer.satisfied").length, 9); assert.equal(dl.events.ofType("timer.breached").length, 1);

  // ---- recurring rows: armed in-engine from the process's own emitters (the scheduler's ticks, vendor onboarding, the owner's policy approval,
  // a T1 deployment, the plan's first approval) at the spec's due dates; satisfied in-engine by the process's evidence events; and re-armed by the
  // kernel on the *next period* — the anchor field each satisfying event carries (next BD3 / month-end / FYE), never the signature or review date.
  const rc = drive(["FNMA_A4101_QC_CYCLE_MONTHLY", "FNMA_A4101_VENDOR_QC_TEST_ANNUAL", "FNMA_LL202604_AI_POLICY_REVIEW_ANNUAL", "SM_AI_MONITORING_REVIEW_MONTHLY", "CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL", "FNMA_ISBR_ANNUAL_ATTESTATION", "FNMA_A4101_QC_PLAN_REAPPROVAL_ANNUAL", "CSBS_EXTERNAL_AUDIT_ANNUAL"]);
  const inst = (code: string, i: number) => { const xs = rc.engine.byCode(code); assert.ok(xs.length > i, `${code}[${i}] exists`); return xs[i]!; };
  assert.deepEqual(emitQcScheduleTicks(D("2026-09-02"), rc.events).map((e) => e.type), []);                                   // BD2: nothing opens
  const bd3 = emitQcScheduleTicks(D("2026-09-03"), rc.events); assert.deepEqual(bd3.map((e) => e.type), ["schedule.tick"]); assert.equal(bd3[0]!.payload.business_day, 3); assert.equal(bd3[0]!.payload.cycle_clock_opens_on, D("2026-09-03"));
  assert.deepEqual(emitQcScheduleTicks(D("2026-09-30"), rc.events).map((e) => e.type), ["period.month_end"]);
  const vendor: VendorOnboarding = { vendor_id: "V-print-mail", name: "Print & Mail Co", kind: "print_mail", onboarded_on: D("2026-03-15"), contract_document_id: "doc-msa", scp_screening: { screened_on: D("2026-03-10"), clear: true, document_id: "doc-scp" } };
  assert.equal(onboardVendor(rc.events, vendor).refusal, null);
  assert.match(approvePolicy(rc.events, { policy_code: "AI-GOV-001", version: "2026.1", approved_on: D("2026-07-15"), owner: PLAIN_OFFICER, document_id: "doc-pol" }).refusal!, /officer:ai_governance_owner/);
  assert.match(approvePolicy(rc.events, { policy_code: "AI-GOV-001", version: "2026.1", approved_on: D("2026-07-15"), owner: AI_OWNER, document_id: null }).refusal!, /signed policy document/);
  assert.throws(() => approvePolicy(rc.events, { policy_code: "QC-PLAN-1", version: "1", approved_on: D("2026-07-15"), owner: AI_OWNER, document_id: "d" }), RangeError);
  const pol = approvePolicy(rc.events, { policy_code: "AI-GOV-001", version: "2026.1", approved_on: D("2026-07-15"), owner: AI_OWNER, document_id: "doc-pol" }); assert.equal(pol.event!.type, "ai.policy.approved"); assert.equal(pol.next_review_due, D("2027-07-15")); assert.equal(pol.warn_on, D("2027-05-16"));
  rc.emit(deployVersion({ system_code: "lossmit-underwriter", version: "v1", tier: "T1_consequential", change_kind: "new", status: "approved", suites: [{ suite_code: "golden_t1", mandatory: true, pass: true }], approved_by: "u-ai-gov-owner" }, D("2026-09-11")).event!, "2026-09-11");
  rc.emit(planApproved({ version: "2026.1", approved_on: D("2026-08-01"), approved_by: PLAIN_OFFICER, partner_accepted_on: D("2026-08-05"), document_id: "doc-plan" }).event!, "2026-08-01");
  const due = (code: string) => inst(code, 0).dueDate;
  assert.equal(due("FNMA_A4101_QC_CYCLE_MONTHLY"), D("2026-09-29")); assert.equal(due("FNMA_A4101_QC_CYCLE_MONTHLY"), monthlyCycleWindow(2026, 9).close_by);
  assert.equal(due("FNMA_A4101_VENDOR_QC_TEST_ANNUAL"), D("2027-03-15")); assert.deepEqual(inst("FNMA_A4101_VENDOR_QC_TEST_ANNUAL", 0).subject, vendorSubject("V-print-mail"));
  assert.equal(due("FNMA_LL202604_AI_POLICY_REVIEW_ANNUAL"), D("2027-07-15")); assert.deepEqual(inst("FNMA_LL202604_AI_POLICY_REVIEW_ANNUAL", 0).subject, policySubject("AI-GOV-001"));
  assert.equal(due("SM_AI_MONITORING_REVIEW_MONTHLY"), D("2026-10-07"));   // September's review by BD5 of October
  assert.equal(due("CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL"), D("2027-09-11")); assert.equal(due("FNMA_A4101_QC_PLAN_REAPPROVAL_ANNUAL"), D("2027-08-01"));
  assert.ok(rc.engine.all().every((t) => t.status === "armed")); assert.equal(rc.engine.all().length, 6);
  // satisfy each in-engine; the kernel re-arms the recurring row from the satisfying event's anchor field
  rc.emit(signCycle({ cycle_id: "C-2026-08", signed_on: D("2026-09-25"), signer: QC_OFFICER }).event!, "2026-09-25");
  assert.equal(inst("FNMA_A4101_QC_CYCLE_MONTHLY", 0).status, "satisfied"); assert.equal(inst("FNMA_A4101_QC_CYCLE_MONTHLY", 1).anchorDate, D("2026-10-05")); assert.equal(inst("FNMA_A4101_QC_CYCLE_MONTHLY", 1).dueDate, D("2026-10-29"));   // October's cycle: BD3 Mon 2026-10-05 → BD20 Thu 2026-10-29 (Columbus Day), not 17 BD after the signature
  assert.equal(rc.engine.byCode("FNMA_A4101_QC_CYCLE_MONTHLY").length, 2);
  const vt = recordVendorTestCompleted(rc.events, { vendor_id: "V-print-mail", completed_on: D("2027-02-01"), report_document_id: "doc-vqt" }); assert.equal(vt.refusal, null);
  assert.equal(inst("FNMA_A4101_VENDOR_QC_TEST_ANNUAL", 0).status, "satisfied"); assert.equal(inst("FNMA_A4101_VENDOR_QC_TEST_ANNUAL", 0).satisfiedByEventId, vt.event!.id);
  assert.equal(inst("FNMA_A4101_VENDOR_QC_TEST_ANNUAL", 1).dueDate, D("2028-02-01")); assert.deepEqual(inst("FNMA_A4101_VENDOR_QC_TEST_ANNUAL", 1).subject, vendorSubject("V-print-mail"));   // the next annual test: 12 months from the completed one
  const rv = recordPolicyReviewed(rc.events, { policy_code: "AI-GOV-001", version: "2026.1", approved_on: D("2026-07-15"), reviewed_on: D("2027-06-30"), reviewer: AI_OWNER }); assert.equal(rv.appended!.type, "ai.policy.reviewed");
  assert.equal(inst("FNMA_LL202604_AI_POLICY_REVIEW_ANNUAL", 0).status, "satisfied"); assert.equal(inst("FNMA_LL202604_AI_POLICY_REVIEW_ANNUAL", 1).dueDate, D("2028-06-30")); assert.equal(inst("FNMA_LL202604_AI_POLICY_REVIEW_ANNUAL", 1).dueDate, rv.event!.next_review_due);
  const mr = monitoringReviewed({ month: "2026-09", reviewed_on: D("2026-10-07"), reviewer: AI_OWNER, systems_reviewed: ["lossmit-underwriter"] }).event!; assert.equal(mr.monitoring_clock_month_end, D("2026-10-31"));
  rc.emit(mr, "2026-10-07");
  assert.deepEqual(rc.engine.byCode("SM_AI_MONITORING_REVIEW_MONTHLY").map((t) => [t.status, t.dueDate]), [["satisfied", D("2026-10-07")], ["armed", D("2026-11-06")]]);   // month-end 2026-10-31 + 5 BD = Fri 2026-11-06, BD5 of November — not 5 BD after the review
  rc.emit(impactAssessmentCompleted({ system_code: "lossmit-underwriter", completed_on: D("2027-02-01"), document_id: "doc-ia" }).event!, "2027-02-01");
  assert.equal(inst("CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL", 0).status, "satisfied"); assert.equal(inst("CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL", 1).dueDate, D("2028-02-01"));
  // the fiscal year-end tick (also a month-end) arms the ISBR attestation at FYE + 90, the CSBS external audit at FYE + 12 months (2,500 loans in 3 states) and December's monitoring review at BD5 of January 2027 (New Year's Day)
  const fye = emitQcScheduleTicks(D("2026-12-31"), rc.events, { csbs: { loan_count: 2_500, states: 3 } }); assert.deepEqual(fye.map((e) => e.type), ["period.month_end", "period.fiscal_year_end"]); assert.equal(fye[1]!.payload.csbs_audit_required, true);
  assert.equal(due("FNMA_ISBR_ANNUAL_ATTESTATION"), D("2027-03-31")); assert.deepEqual(inst("FNMA_ISBR_ANNUAL_ATTESTATION", 0).subject, fiscalYearSubject("supermortgage", D("2026-12-31")));
  assert.equal(due("CSBS_EXTERNAL_AUDIT_ANNUAL"), D("2027-12-31")); assert.equal(inst("SM_AI_MONITORING_REVIEW_MONTHLY", 2).dueDate, D("2027-01-08")); assert.equal(inst("SM_AI_MONITORING_REVIEW_MONTHLY", 2).status, "armed");
  const small = qcScheduleTicks(D("2026-12-31"), { csbs: { loan_count: 1_500, states: 3 } })[1]!; const smallPayload = (small.payload ?? {}) as Record<string, unknown>; assert.equal(smallPayload.csbs_audit_required, false); assert.equal(eventMatches(reg.get("CSBS_EXTERNAL_AUDIT_ANNUAL")!.triggerPattern!, ev(small.type, smallPayload)), false);   // below 2,000 loans the CSBS row does not arm (trigger `csbs_audit_required=true`)
  assert.equal(rc.engine.byCode("CSBS_EXTERNAL_AUDIT_ANNUAL").length, 1);
  const isbr = recordIsbrAttestationSigned(rc.events, { fiscal_year_end: D("2026-12-31"), signed_on: D("2027-03-20"), signer: PLAIN_OFFICER, document_id: "doc-isbr" }); assert.equal(isbr.appended!.type, "isbr.attestation.signed");
  assert.equal(inst("FNMA_ISBR_ANNUAL_ATTESTATION", 0).status, "satisfied"); assert.equal(inst("FNMA_ISBR_ANNUAL_ATTESTATION", 1).anchorDate, D("2027-12-31")); assert.equal(inst("FNMA_ISBR_ANNUAL_ATTESTATION", 1).dueDate, D("2028-03-30"));   // next FYE + 90 (2028 is a leap year), not 90 days after the signature
  assert.equal(recordIsbrAttestationSigned(rc.events, { fiscal_year_end: D("2026-12-31"), signed_on: D("2027-03-20"), signer: ANALYST, document_id: "doc-isbr" }).appended, null);
  const re = planApproved({ version: "2027.1", approved_on: D("2027-07-20"), approved_by: PLAIN_OFFICER, partner_accepted_on: D("2027-07-25"), document_id: "doc-plan-2", supersedes_version: "2026.1" }).event!; assert.equal(re.initial, false);
  rc.emit(re, "2027-07-20");
  assert.deepEqual(rc.engine.byCode("FNMA_A4101_QC_PLAN_REAPPROVAL_ANNUAL").map((t) => [t.status, t.dueDate]), [["satisfied", D("2027-08-01")], ["armed", D("2028-07-20")]]);   // the re-approval satisfies and re-arms once; `initial=false` does not trigger a second clock
  const afs = recordAfsReceived(rc.events, { fiscal_year_end: D("2026-12-31"), received_on: D("2027-03-10"), audit_opinion: "unqualified", auditor: "cpa", document_id: "doc-afs" }); assert.equal(afs.appended!.payload.audit_opinion, true);
  assert.equal(inst("CSBS_EXTERNAL_AUDIT_ANNUAL", 0).status, "satisfied"); assert.equal(inst("CSBS_EXTERNAL_AUDIT_ANNUAL", 1).anchorDate, D("2027-12-31")); assert.equal(inst("CSBS_EXTERNAL_AUDIT_ANNUAL", 1).dueDate, D("2028-12-31"));
  const unaudited = recordAfsReceived(rc.events, { fiscal_year_end: D("2026-12-31"), received_on: D("2028-03-10"), audit_opinion: null, auditor: "cpa", document_id: "doc-afs-2" }); assert.equal(unaudited.appended!.payload.audit_opinion, false);
  assert.equal(inst("CSBS_EXTERNAL_AUDIT_ANNUAL", 1).status, "armed"); assert.equal(rc.engine.byCode("CSBS_EXTERNAL_AUDIT_ANNUAL").length, 2);   // statements without the auditor's opinion are recorded but satisfy nothing (`afs.received{audit_opinion=true}`)
  for (const code of ["FNMA_A4101_QC_CYCLE_MONTHLY", "FNMA_A4101_VENDOR_QC_TEST_ANNUAL", "FNMA_LL202604_AI_POLICY_REVIEW_ANNUAL", "SM_AI_MONITORING_REVIEW_MONTHLY", "CO_AI_ACT_IMPACT_ASSESSMENT_ANNUAL", "FNMA_ISBR_ANNUAL_ATTESTATION", "FNMA_A4101_QC_PLAN_REAPPROVAL_ANNUAL", "CSBS_EXTERNAL_AUDIT_ANNUAL"]) {
    assert.equal(reg.get(code)!.kindNorm, "recurring"); assert.equal(inst(code, 0).status, "satisfied", `${code} satisfied in-engine`); assert.equal(rc.engine.byCode(code).at(-1)!.status, "armed", `${code} re-armed for the next period`);
  }
  // the two 5-BD report clocks the signature arms are the deadline rows already driven above; nothing else armed
  assert.deepEqual(rc.engine.all().filter((t) => !["FNMA_A4101_QC_REPORT_SENIOR_MGMT_MONTHLY", "SM_QC_REPORT_PARTNER_MONTHLY"].includes(t.code) && t.status !== "satisfied" && t.status !== "armed"), []);
});
