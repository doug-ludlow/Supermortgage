// 23.3 The credit decision: comprehensive risk assessment, conditional approval, condition clearing (PTD/PTF), and final underwriting sign-off
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-3-the-credit-decision-comprehensive-risk-assessment-conditiona.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_23_3 } from "../../app/tools/section23-3.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { newDecisionFile, type DecisionFile } from "../application/ops-21-6.ts";
import { DU_MESSAGE_RULES_2026_09_25, openCondition, openRedFlagInvestigation, closeInvestigation, pitiaFor, type Condition, type Investigation23, type RestructureProposal } from "./ops-23-2.ts";
import { piCents } from "./ops-23-1.ts";
import { dtiBps } from "../verification/ops-22-5.ts";
import { assessRisk, validUntil, conditionalApprovalGuard, issueConditionalApproval, approvalLetterPayload, inputsHash, ageCheck, evaluateClearance, clearCondition, reopenCondition, waiveCondition, ptdStatus, recordPtdCleared, ptdClearedGate, runCtcChecklist, issueClearToClose, ctcGate, ctcLatencyMinutes, reopenDecision, supersedeDecision,
  prepareAdverseDecision, reviewAdverseDecision, handOffToRegB, counterofferExpiry, expireCounterofferProposal, prefundingQcGate, prefundingReviewStatus, evaluateReliefLedger, recordReliefLedger, loseEmploymentRelief, openPaymentHistoryRelief, decisionRecord23_3, assertNoDemographics, validityExpired, DecisionRefused, RULE_SETS_23_3, VVOE_PTF_TEMPLATE, SM_QC_PREFUNDING_HOLD,
  type CreditDecision, type RiskInput, type CtcFacts, type CtcItemCode, type ReliefFacts, type EvidenceDoc } from "./ops-23-3.ts";

const UW: Actor = { kind: "agent", id: "underwriter" };
const REVIEWER: Actor = { kind: "human", id: "u-uwr-1", role: "underwriting_reviewer" };
const QC: Actor = { kind: "human", id: "u-qc-1", role: "qc_officer" };
const REFI = "APP-REFI-560K", PURCHASE = "APP-PURCH-412K";
const MST = "America/Phoenix";
const toolKey = (process: string, name: string): string => `${process} ${name}`;
const noticeReg = buildRegistry(); publishAuthored(noticeReg);
/** An entity store that logs every read by kind — the access log the spec's T12 audits (zero `applicant_demographics` reads by the agent). */
class LoggedStore extends EntityStore {
  readonly reads: string[] = [];
  override get(kind: string, id: string) { this.reads.push(kind); return super.get(kind, id); }
  override list(kind: string, where?: (d: Record<string, unknown>) => boolean) { this.reads.push(kind); return where ? super.list(kind, where) : super.list(kind); }
}
/** The 23.3 bus: TOOLS_23_3 bound to the `underwriter` agent over the overridden registry, escalations and the Notice Registry; the application-scoped unit of work stamps `applicationId` on every event. */
function harness(applicationId: string, nowIso: string, processes: string[] = ["23.3"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes });
  const escalations = new EscalationService(events, clock); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const store = new LoggedStore();
  const rt: ToolRuntime = { store, escalations, services: {}, ports: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }) };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const agents = new AgentRegistry(); const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_23_3) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = UW): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("23.3", name))!, actor, { application_id: applicationId, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  const append = (type: string, payload: Record<string, unknown>, actor: Actor = UW) => events.append({ type, applicationId, actor, payload: { application_id: applicationId, ...payload } });
  return { clock, events, timers, escalations, rt, store, uow, run, at, timer, ofType, append, decisions };
}
const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
const refusedBy = (fn: () => unknown, code: string): void => { try { fn(); } catch (e) { assert.ok(e instanceof DecisionRefused, `expected DecisionRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return; } assert.fail(`expected DecisionRefused ${code}`); };

/** Worked example 1 (refinance fixture): Reg B application Mon Oct 5, 2026 in Phoenix; the partner is the creditor. */
const refiFile = (): DecisionFile => newDecisionFile({ application_id: REFI, partner_name: "Partner Bank", partner_address: "100 Partner Plaza, Phoenix, AZ 85004", creditor_time_zone: MST, application_date: "2026-10-05", property_state: "AZ", applicants: [{ id: "B1", name: "R. Borrower", mailing_address: "1 Palm Ln, Phoenix AZ 85001", email: "r@example.com", esign_consent: true, primary: true }] });
/** 23.2's interpretation opens the PTD conditions from the DU 12.1 Sept 25, 2026 catalog (14 on the refinance fixture). */
const openPtdConditions = (h: ReturnType<typeof harness>, application_id: string, at: string, n = 14): Condition[] =>
  DU_MESSAGE_RULES_2026_09_25.filter((r) => r.action === "open_condition" && r.stage === "ptd").slice(0, n).map((r) => openCondition(h.events, { application_id, submission_id: "SUB-1", template_code: r.condition_template_code!, category: r.category, stage: "ptd", text: r.borrower_text!, internal_text: `DU ${r.message_id}`, du_message_id: r.message_id, evidence_kinds: r.evidence_kinds, auto_clear_rule: r.auto_clear_rule, requires_role: r.requires_role ?? null, opened_at: at, message_ids: [r.message_id] }).condition);
const condition = (h: ReturnType<typeof harness>, application_id: string, template: string, at: string): Condition => {
  const r = DU_MESSAGE_RULES_2026_09_25.find((x) => x.condition_template_code === template)!;
  return openCondition(h.events, { application_id, submission_id: "SUB-1", template_code: template, category: r.category, stage: r.stage ?? "ptd", text: r.borrower_text!, internal_text: `DU ${r.message_id}`, du_message_id: r.message_id, evidence_kinds: r.evidence_kinds, auto_clear_rule: r.auto_clear_rule, opened_at: at, message_ids: [r.message_id] }).condition;
};
/** 23.4's preliminary determination on the refinance fixture: general_safe_harbor, not HOEPA, no state high-cost test failing. */
const QM_OPEN = { qm_type: "general_safe_harbor", apr_test_pass: true, pf_pass: true, product_tests_pass: true, consider_verify_complete: true, consider_verify_missing: [], stage: "le", apor_stale: false, blocked_reason: null, computed_from_final_cd: false };
const GUARD = { policy_outcome: "proceed" as const, qm_facts: QM_OPEN, is_hoepa: false, is_state_high_cost: false, open_red_flag_investigations: 0 };
const RISK: RiskInput = { credit: { score_model: "classic_fico", representative_score: 712, history_summary: "no 30-day lates in 24 months; revolving utilization 31%" }, capacity: { dti_bps: 3800, residual_income_cents: 744_000n, income_sources: ["base_salary"], income_reconciled_to_22_3: true }, capital: { funds_to_close_cents: 0n, reserves_months: 6, assets_reconciled_to_22_4: true },
  collateral: { ltv_x100: 7000, cltv_x100: 7000, hcltv_x100: 7000, valuation_method: "value_acceptance", cu_score: null }, du_risk_factors: ["limited_cash_out_refinance"], eligibility_outside_du_confirmed: true, legal_compliance_confirmed: true };
/** Refinance fixture validity inputs: credit expiry Fri Feb 5, 2027; lock expiry Sat Nov 21, 2026 (45 days from Oct 7); value-acceptance offer expiry Sat Feb 6, 2027; DU close-by (employment validated) Mon Dec 7, 2026. */
const VALIDITY = { credit_expires_at: D("2027-02-05"), lock_expires_at: D("2026-11-21"), valuation_expires_at: D("2027-02-06"), du_close_by_date: D("2026-12-07") };
const INPUTS = { ulad_snapshot_hash: "ulad:refi:v3", verification_ids: ["ver-inc-1", "ver-emp-1", "ver-ast-1"], findings_hash: "findings:sub1" };
/** The conditional approval of record on the refinance fixture, issued Wed Oct 7, 2026 over the 14 PTD conditions. */
function conditionallyApprove(h: ReturnType<typeof harness>, conditions: Condition[], decision_id = "D-REFI-CA-1", issuedIso = "2026-10-07T15:00:00.000Z") {
  h.at(issuedIso);
  return issueConditionalApproval(h.events, h.escalations, { decision_id, file: refiFile(), guard: GUARD, validity: VALIDITY, risk_assessment: assessRisk(RISK), inputs: INPUTS, du_submission_id: "SUB-1", interpretation_id: "INT-1", conditions, evidence_document_ids: ["doc-cr-1"], rationale: "Approve/Eligible loan within policy; verified income, assets and liabilities reconcile to DU; no layering.", confidence: 0.94, model_version: "underwriter-2026.09", prompt_version: "23.3-v1", at: issuedIso, issued_on: D(issuedIso.slice(0, 10)) });
}
const allPass = (except: Partial<Record<CtcItemCode, { status: "pass" | "fail" | "waived" | "n/a"; evidence_ref?: string }>> = {}): CtcFacts => {
  const codes: CtcItemCode[] = ["CTC_DU_FINAL_MATCH", "CTC_PTD_ALL_CLEARED", "CTC_NO_OPEN_INVESTIGATION", "CTC_CREDIT_VALID", "CTC_DU_CLOSE_BY", "CTC_ASSETS_CASH_TO_CLOSE", "CTC_VALUATION", "CTC_PROPERTY_PROJECT", "CTC_TITLE", "CTC_INSURANCE_FLOOD", "CTC_MI", "CTC_COMPLIANCE", "CTC_EDUCATION", "CTC_LOCK", "CTC_IDENTITY_OFAC", "CTC_QC_PREFUNDING", "CTC_MLO_APPROVALS", "CTC_REGB_TIMING", "CTC_DECISION_VALID"];
  return Object.fromEntries(codes.map((c) => [c, except[c] ?? { status: c === "CTC_MI" || c === "CTC_EDUCATION" ? "n/a" : "pass" }])) as CtcFacts;
};
const clearAll = (cs: Condition[]): Condition[] => cs.map((c) => ({ ...c, status: "cleared" as const, cleared_at: "2026-10-29T20:00:00.000Z", cleared_by: "underwriter" }));
/** Relief facts on the refinance fixture at CTC: Approve/Eligible, every message resolved, SFC 127, employment validated with Close by Date Mon Dec 7, 2026, value-acceptance offer Oct 6. */
const RELIEF: ReliefFacts = { recommendation: "approve_eligible", all_messages_resolved: true, sfc_127: true, data_accurate: true, validated: { income: { close_by_date: null }, employment: { close_by_date: D("2026-12-07") }, assets: { close_by_date: null } }, undisclosed_debt_message: true, credit_expiration_date: D("2027-02-05"), income_calculator: null, value_acceptance: { offer_on_final_submission: true, offer_date: D("2026-10-06"), sfc: "801" }, cu_score: null, units: 1 };

test("23.3-T1: Given `du.findings.interpreted{proceed}` at 09:12 Tue Oct 6, 2026 and 23.4 preliminary `qm/not_high_cost`, when the agent runs, then `decision.issued{conditional_approval}` and `notice.sent{NTC_REGB_1002_9_APPROVAL}` occur by Wed Oct 7, 2026 (`SM_UW_CONDITIONAL_APPROVAL_SLA_1BD`), with `valid_until = 2026-11-21` and 14 borrower-facing conditions listed.", async () => {
  const h = harness(REFI, "2026-10-06T16:12:00.000Z");   // 09:12 MST Tue Oct 6, 2026
  h.append("du.findings.interpreted", { submission_id: "SUB-1", recommendation: "approve_eligible", policy_outcome: "proceed", conditions_materialized: true });
  const sla = h.timer("SM_UW_CONDITIONAL_APPROVAL_SLA_1BD")!; assert.equal(sla.status, "armed"); assert.equal(sla.dueDate, "2026-10-07");   // +1 business_days_creditor
  const conditions = openPtdConditions(h, REFI, "2026-10-06T16:12:00.000Z"); assert.equal(conditions.length, 14);
  // guards: proceed + 23.4 preliminary qm / not_high_cost + no open investigation
  assert.equal(conditionalApprovalGuard(GUARD).open, true);
  assert.deepEqual(conditionalApprovalGuard({ ...GUARD, qm_facts: { ...QM_OPEN, qm_type: "not_qm", apr_test_pass: false } }).blocking_codes, ["QM_PRELIMINARY_NOT_QM"]);
  assert.deepEqual(conditionalApprovalGuard({ ...GUARD, policy_outcome: "restructure_required" }).blocking_codes, ["POLICY_OUTCOME_RESTRUCTURE_REQUIRED"]);
  assert.deepEqual(validUntil({ ...VALIDITY, issued_on: D("2026-10-07") }), { valid_until: "2026-11-21", component: "lock_expiration" });   // min(Feb 5, Nov 21, Feb 6, Dec 7, Jan 5 (90 days))
  const r = conditionallyApprove(h, conditions);
  assert.equal(r.decision.kind, "conditional_approval"); assert.equal(r.decision.valid_until, "2026-11-21"); assert.equal(r.decision.conditions_snapshot.length, 14); assert.equal(r.decision.regb_notice_kind, "approval"); assert.equal(r.decision.status, "active");
  assert.deepEqual(r.events.map((e) => e.type), ["decision.issued", "credit_decision.recorded"]);
  assert.equal(r.events[0]!.payload.kind, "conditional_approval"); assert.equal(r.events[0]!.applicationId, REFI); assert.equal(r.row.kind, "conditional_approval"); assert.equal(r.file.disposition, "conditional_approval");
  assert.equal(r.file.conditional_approval!.expires_on, "2026-11-21"); assert.equal(r.file.conditional_approval!.open_conditions.length, 14);
  const validity = h.timer("SM_UW_DECISION_VALIDITY")!; assert.equal(validity.status, "armed"); assert.equal(validity.anchorDate, "2026-11-21"); assert.equal(validity.dueDate, "2026-11-21");
  // the letter: express approval in the partner's name, 14 borrower-facing conditions, valid until Nov 21; e-delivered under the E-SIGN consent → notice.sent closes the SLA on Oct 7
  const payload = approvalLetterPayload(r.decision, { creditor_name: "Partner Bank", creditor_nmlsr_id: "123456", creditor_address: "100 Partner Plaza, Phoenix, AZ 85004", mlo_name: "M. Originator", mlo_nmlsr_id: "987654", applicant_name: "R. Borrower", property_address: "1 Palm Ln, Phoenix, AZ 85001", terms: { loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, product: "30-year fixed, limited cash-out refinance" }, notice_date: D("2026-10-07") });
  assert.equal(payload.conditions_count, 14); assert.equal(payload.valid_until, "2026-11-21");
  for (const t of payload.conditions as string[]) assert.doesNotMatch(t, /\bDU\b|Desktop Underwriter|V10\d\d/);
  const n = h.rt.notices!.render({ templateCode: "NTC_REGB_1002_9_APPROVAL", recipients: [{ partyId: "B1", name: "R. Borrower", mailingAddress: "1 Palm Ln, Phoenix AZ 85001", email: "r@example.com", consent: { party_id: "B1", classes: ["origination_decisions"], disclosure_version: "esign-2026-09", status: "active", consented_on: D("2026-10-05"), soft_bounces_30d: 0 } }], payload, asOf: D("2026-10-07") });
  assert.match(n.rendered.text, /Partner Bank has approved your application/); assert.match(n.rendered.text, /valid until 2026-11-21|valid until .*Nov/); assert.match(n.rendered.text, /Lender \(creditor\): Partner Bank, NMLSR ID 123456/);
  const sent = await h.rt.notices!.send(n.id, {});
  const ns = h.ofType("notice.sent"); assert.equal(ns.length, 1); assert.equal(ns[0]!.payload.template, "NTC_REGB_1002_9_APPROVAL"); assert.equal((ns[0]!.payload.channels as { channel: string }[])[0]!.channel, "email_link"); assert.equal(sent.templateCode, "NTC_REGB_1002_9_APPROVAL");
  assert.equal(h.timer("SM_UW_CONDITIONAL_APPROVAL_SLA_1BD")!.status, "satisfied"); assert.ok(h.timer("SM_UW_CONDITIONAL_APPROVAL_SLA_1BD")!.satisfiedAt!.slice(0, 10) <= "2026-10-07");
  // the same act through the bus (store-backed): a restructure_required outcome never reaches an approval
  await refused(h.run("issueConditionalApproval", { decision_id: "D-X", guard: { ...GUARD, policy_outcome: "restructure_required" }, validity: VALIDITY, inputs: INPUTS, rationale: "x", risk_assessment: assessRisk(RISK) }), "APPROVAL_NEEDS_PROCEED_AND_QM");
});
test("23.3-T2: Given a `COND_DU_VERIFY_INCOME_BASE` condition and a paystub dated Sept 28, 2026 plus a 2025 W-2 classified Oct 8, 2026, when `evaluateClearance` runs, then the condition is `cleared` by the agent with `standard_ref = B3-3.2-01/DU:paystub_30d_w2_1y` and `age_check` passing for a Nov 6 note date; given the paystub is dated June 1, 2026 (> 4 months at note date), then it stays `satisfied_pending_review` with reason `B1_1_03_AGE`.", async () => {
  const h = harness(REFI, "2026-10-08T16:00:00.000Z");
  const cond = condition(h, REFI, "COND_DU_VERIFY_INCOME_BASE", "2026-10-06T16:12:00.000Z");
  assert.deepEqual([...cond.evidence_kinds], ["paystub", "w2"]); assert.equal(cond.auto_clear_rule, "B3-3.2-01/DU:paystub_30d_w2_1y");
  const evidence: EvidenceDoc[] = [{ document_id: "doc-pay-1", kind: "paystub", document_date: D("2026-09-28"), classified_at: "2026-10-08T16:00:00.000Z", is_credit_document: true, verification_id: "ver-inc-1" }, { document_id: "doc-w2-2025", kind: "w2", document_date: D("2026-01-31"), tax_year: 2025, classified_at: "2026-10-08T16:00:00.000Z", is_credit_document: true }];
  h.append("document.classified", { document_id: "doc-w2-2025", doc_class: "w2", is_credit_document: true, pass: true }, { kind: "agent", id: "document-intake" });
  const sla = h.timer("SM_UW_CONDITION_CLEAR_SLA_1BD")!; assert.equal(sla.status, "armed"); assert.equal(sla.dueDate, "2026-10-09");
  // B1-1-03 at the Nov 6 note date: paystub Sept 28 + 4 months = Jan 28, 2027 ≥ Nov 6 → pass; the 2025 W-2 is the most recent year
  assert.deepEqual(ageCheck(evidence[0]!, D("2026-11-06")), { document_id: "doc-pay-1", kind: "paystub", document_date: "2026-09-28", expires_on: "2027-01-28", note_date: "2026-11-06", pass: true, rule: "B1_1_03_AGE" });
  assert.equal(ageCheck(evidence[1]!, D("2026-11-06")).pass, true);
  const ev = evaluateClearance(cond, evidence, { note_date: D("2026-11-06"), du_used: { qualifying_income_cents: 1_200_000n }, verified: { income_cents: 1_200_000n } });
  assert.equal(ev.outcome, "cleared"); assert.equal(ev.standard_ref, "B3-3.2-01/DU:paystub_30d_w2_1y"); assert.deepEqual(ev.reasons, []); assert.ok(ev.age_check.every((a) => a.pass)); assert.deepEqual(ev.evidence_verification_ids, ["ver-inc-1"]);
  const out = await h.run("clearCondition", { condition: cond, evaluation: ev });
  const cleared = out.condition as Condition; assert.equal(cleared.status, "cleared"); assert.equal(cleared.cleared_by, "underwriter"); assert.deepEqual([...cleared.clear_evidence_document_ids], ["doc-pay-1", "doc-w2-2025"]);
  const clr = out.clearance as { cleared_by_kind: string; standard_ref: string; age_check: { pass: boolean }[] }; assert.equal(clr.cleared_by_kind, "agent"); assert.equal(clr.standard_ref, "B3-3.2-01/DU:paystub_30d_w2_1y"); assert.equal(clr.age_check.length, 2);
  const ce = h.ofType("condition.cleared"); assert.equal(ce.length, 1); assert.equal(ce[0]!.payload.standard_ref, "B3-3.2-01/DU:paystub_30d_w2_1y"); assert.equal(ce[0]!.applicationId, REFI);
  assert.equal(h.timer("SM_UW_CONDITION_CLEAR_SLA_1BD")!.status, "satisfied");
  // the June 1, 2026 paystub: Oct 1 < Nov 6 → age fails → satisfied_pending_review with B1_1_03_AGE; the agent may not clear it, the reviewer may (with a recorded basis)
  const stale: EvidenceDoc[] = [{ ...evidence[0]!, document_id: "doc-pay-old", document_date: D("2026-06-01") }, evidence[1]!];
  const ev2 = evaluateClearance(cond, stale, { note_date: D("2026-11-06") });
  assert.equal(ev2.outcome, "satisfied_pending_review"); assert.deepEqual(ev2.reasons, ["B1_1_03_AGE"]); assert.equal(ev2.age_check[0]!.expires_on, "2026-10-01"); assert.equal(ev2.age_check[0]!.pass, false);
  refusedBy(() => clearCondition(h.events, cond, ev2, { at: h.clock.now() }, UW), "CLEAR_NEEDS_UNDERWRITING_REVIEWER");
  const byReviewer = clearCondition(h.events, cond, ev2, { at: h.clock.now(), notes: "Employer pay frequency change documented; supplemental paystub ordered as PTF" }, REVIEWER);
  assert.equal(byReviewer.clearance.cleared_by_kind, "underwriting_reviewer");
  refusedBy(() => clearCondition(h.events, cond, ev, { at: h.clock.now() }, QC), "QC_OFFICER_CANNOT_CLEAR");
  const none = evaluateClearance(cond, [], { note_date: D("2026-11-06") }); assert.equal(none.outcome, "insufficient");
  await refused(h.run("clearCondition", { condition: cond, evaluation: none }), "CLEAR_WITHOUT_EVIDENCE_AT_DU_LEVEL");
});
test("23.3-T3: Given all PTD conditions cleared but an open `investigation{kind=du_red_flag}` (Occupancy Modified), then `ptd_cleared` is not emitted and `SM_UW_PTD_CLEARED_GATE` blocks `issueCD` on Mon Nov 2, 2026 with `blocking_codes = {CTC_NO_OPEN_INVESTIGATION}`.", async () => {
  const h = harness(REFI, "2026-11-02T16:00:00.000Z");
  const conditions = clearAll(openPtdConditions(h, REFI, "2026-10-06T16:12:00.000Z"));
  const inv = openRedFlagInvestigation(h.events, { application_id: REFI, submission_id: "SUB-2", message_id: "PRF2001", red_flag: "occupancy_modified", du_text: "Occupancy Modified", at: "2026-10-20T18:00:00.000Z" }).investigation;
  const s = ptdStatus(conditions, [inv]);
  assert.equal(s.cleared, false); assert.deepEqual(s.blocking_codes, ["CTC_NO_OPEN_INVESTIGATION"]);
  refusedBy(() => recordPtdCleared(h.events, REFI, s, h.clock.now()), "PTD_NOT_CLEARED"); assert.equal(h.ofType("ptd.cleared").length, 0);
  // Mon Nov 2: 25.2 requests the CD → the gate arms and blocks issueCD listing the blocking code
  h.append("disclosure.cd.requested", { cd_version: 1 }, { kind: "agent", id: "disclosures" });
  const gate = h.timer("SM_UW_PTD_CLEARED_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:23.3.ptdClearedGate");
  const g = ptdClearedGate({ ptd_cleared: s.cleared, blocking_codes: s.blocking_codes, final_match_gate_open: true, command: "issueCD" });
  assert.equal(g.open, false); assert.deepEqual(g.blocking_codes, ["CTC_NO_OPEN_INVESTIGATION"]); assert.match(g.reason!, /blocks issueCD/);
  const ev = evaluateGate("23.3.ptdClearedGate", { ptd_cleared: false, blocking_codes: ["CTC_NO_OPEN_INVESTIGATION"], final_match_gate_open: true, command: "issueCD" }); assert.equal(ev.open, false); assert.match(ev.reason!, /CTC_NO_OPEN_INVESTIGATION/);
  const viaBus = await h.run("runCtcChecklist", { op: "ptd", conditions, investigations: [inv], command: "issueCD" });
  assert.equal(viaBus.cleared, false); assert.deepEqual((viaBus.gate as { blocking_codes: string[] }).blocking_codes, ["CTC_NO_OPEN_INVESTIGATION"]); assert.equal(viaBus.event, null);
  // the investigation closes with rationale (22.6) → ptd_cleared is emitted and the gate closes
  const closed = closeInvestigation(h.events, inv, "Occupancy verified: borrower's driver's licence, utility bills and employer within 12 miles of the subject", "2026-11-02T18:00:00.000Z", REVIEWER).investigation;
  const s2 = ptdStatus(conditions, [closed]); assert.equal(s2.cleared, true);
  const e = recordPtdCleared(h.events, REFI, s2, "2026-11-02T18:05:00.000Z"); assert.equal(e.type, "ptd.cleared"); assert.deepEqual(e.payload.blocking_codes, []);
  assert.equal(h.timer("SM_UW_PTD_CLEARED_GATE")!.status, "satisfied");
  assert.equal(ptdClearedGate({ ptd_cleared: true, blocking_codes: [], final_match_gate_open: false }).blocking_codes[0], "CTC_DU_FINAL_MATCH");
});
test("23.3-T4: Given the CTC checklist on Fri Oct 30, 2026 with every item `pass` except `CTC_INSURANCE_FLOOD` (declaration page missing), then no CTC; when the declaration page is classified at 09:20, then `clear_to_close.issued` at ≤ 10:20 the same day.", async () => {
  const h = harness(REFI, "2026-10-30T16:00:00.000Z");   // 09:00 MST Fri Oct 30, 2026
  const conditions = clearAll(openPtdConditions(h, REFI, "2026-10-06T16:12:00.000Z"));
  const r = conditionallyApprove(h, conditions); h.at("2026-10-30T16:00:00.000Z");
  h.append("closing.scheduled", { closing_date: "2026-11-06" }, { kind: "agent", id: "closing" });
  assert.equal(h.timer("SM_UW_CTC_GATE")!.status, "armed");
  const failing = runCtcChecklist({ application_id: REFI, decision_id: r.decision.decision_id, evaluated_at: "2026-10-30T16:00:00.000Z", facts: allPass({ CTC_INSURANCE_FLOOD: { status: "fail", evidence_ref: "hoi_declaration_page:missing" } }) });
  assert.equal(failing.passed, false); assert.deepEqual(failing.blocking_codes, ["CTC_INSURANCE_FLOOD"]); assert.equal(failing.items.length, 19);
  refusedBy(() => issueClearToClose(h.events, r.decision, failing, "2026-10-30T16:05:00.000Z"), "CTC_CHECKLIST_FAILING");
  await refused(h.run("issueClearToClose", { decision: r.decision, checklist: failing }), "CTC_CHECKLIST_FAILING");
  assert.equal(h.ofType("clear_to_close.issued").length, 0);
  // an unevaluated item fails; CTC_REGB_TIMING never blocks; a waived item needs the reviewer
  assert.deepEqual(runCtcChecklist({ application_id: REFI, decision_id: r.decision.decision_id, evaluated_at: "2026-10-30T16:00:00.000Z", facts: allPass({ CTC_REGB_TIMING: { status: "fail" } }) }).blocking_codes, []);
  assert.deepEqual(runCtcChecklist({ application_id: REFI, decision_id: r.decision.decision_id, evaluated_at: "2026-10-30T16:00:00.000Z", facts: allPass({ CTC_TITLE: { status: "waived" } }) }).blocking_codes, ["CTC_TITLE"]);
  assert.equal(runCtcChecklist({ application_id: REFI, decision_id: r.decision.decision_id, evaluated_at: "2026-10-30T16:00:00.000Z", facts: allPass({ CTC_TITLE: { status: "waived" } }), waived_by: REVIEWER }).passed, true);
  // 09:20 the declaration page is classified → the checklist re-runs and CTC issues at 09:20 (≤ 10:20)
  h.at("2026-10-30T16:20:00.000Z");
  h.append("document.classified", { document_id: "doc-hoi-1", doc_class: "hoi_declaration", is_credit_document: false, pass: true }, { kind: "agent", id: "document-intake" });
  const passing = (await h.run("runCtcChecklist", { op: "ctc", decision: r.decision, facts: allPass({ CTC_INSURANCE_FLOOD: { status: "pass", evidence_ref: "doc-hoi-1" } }) })) as unknown as ReturnType<typeof runCtcChecklist>;
  assert.equal(passing.passed, true); assert.deepEqual(passing.blocking_codes, []);
  const ctc = await h.run("issueClearToClose", { decision: r.decision, checklist: passing });
  const d = ctc.decision as CreditDecision; assert.equal(d.ctc_at, "2026-10-30T16:20:00.000Z"); assert.equal(d.ctc_checklist_id, passing.checklist_id);
  const issued = h.ofType("clear_to_close.issued"); assert.equal(issued.length, 1); assert.equal(issued[0]!.payload.passed, true); assert.equal(issued[0]!.occurredAt, "2026-10-30T16:20:00.000Z");
  assert.ok(ctcLatencyMinutes("2026-10-30T16:20:00.000Z", issued[0]!.occurredAt) <= 60); assert.ok(issued[0]!.occurredAt <= "2026-10-30T17:20:00.000Z");   // ≤ 10:20 MST
  assert.equal(h.timer("SM_UW_CTC_GATE")!.status, "satisfied");
  assert.equal(ctcGate({ ctc_issued: true, checklist_passed: true, decision_status: d.status, command: "consummate" }).open, true);
});
test("23.3-T5: Given a DTI recalculated at 51.75% on Wed Nov 4, 2026 for a Fri Nov 6 consummation, then `decision.reopened` and an `escalation{underwriting_reviewer}` with same-business-day SLA; `SM_UW_CTC_GATE` blocks `consummate` until re-issued.", async () => {
  const h = harness(REFI, "2026-11-04T17:00:00.000Z");   // Wed Nov 4, 2026
  const conditions = clearAll(openPtdConditions(h, REFI, "2026-10-06T16:12:00.000Z"));
  const r = conditionallyApprove(h, conditions); h.at("2026-10-30T16:30:00.000Z");
  const ctc = issueClearToClose(h.events, r.decision, runCtcChecklist({ application_id: REFI, decision_id: r.decision.decision_id, evaluated_at: "2026-10-30T16:30:00.000Z", facts: allPass() }), "2026-10-30T16:30:00.000Z").decision;
  h.at("2026-11-04T17:00:00.000Z");
  h.append("closing.scheduled", { closing_date: "2026-11-06" }, { kind: "agent", id: "closing" });
  // 22.2's refresh shows the $1,200/month HELOC draw (mortgage-related) → 22.5 recomputes DTI 51.75 % > 50 % → ineligible_change → decision.reopened two business days before the Fri Nov 6 consummation
  const dti_bps = dtiBps(621_000n, 1_200_000n); assert.equal(dti_bps, 5175);
  const re = reopenDecision(h.events, h.escalations, ctc, { cause: "ineligible_change", at: "2026-11-04T17:00:00.000Z", today: D("2026-11-04"), consummation_date: D("2026-11-06"), detail: { dti_bps, dti_display_pct: "51.75", new_liability: "HELOC draw $1,200/month on the departing property's second lien", relief: "mortgage-related debt — no undisclosed-debt relief" } });
  assert.equal(re.decision.status, "reopened"); assert.equal(re.decision.ctc_at, null); assert.equal(re.sla, "same_business_day"); assert.equal(re.sla_due_on, "2026-11-04");
  assert.equal(re.escalation.kind, "underwriting_reviewer"); assert.equal(re.escalation.ownerRole, "underwriting_reviewer"); assert.equal(re.escalation.payload.sla, "same_business_day"); assert.equal(re.escalation.payload.business_days_to_closing, 2);
  const ev = h.ofType("decision.reopened"); assert.equal(ev.length, 1); assert.equal(ev[0]!.payload.cause, "ineligible_change"); assert.equal(ev[0]!.payload.ctc_revoked, true); assert.equal(ev[0]!.payload.next_state, "underwriting_pending");
  // SM_UW_CTC_GATE blocks consummate until the decision is re-issued and CTC re-run
  const g = ctcGate({ ctc_issued: false, checklist_passed: false, decision_status: re.decision.status, command: "consummate" }); assert.equal(g.open, false); assert.deepEqual(g.blocking_codes, ["CTC_NOT_ISSUED", "CTC_CHECKLIST_FAILING", "DECISION_REOPENED"]);
  assert.equal(evaluateGate("23.3.ctcGate", { ctc_issued: true, checklist_passed: true, decision_status: "reopened", command: "consummate" }).open, false);
  refusedBy(() => issueClearToClose(h.events, re.decision, runCtcChecklist({ application_id: REFI, decision_id: re.decision.decision_id, evaluated_at: h.clock.now(), facts: allPass() }), h.clock.now()), "DECISION_NOT_ACTIVE");
  // re-issue: the borrower pays the HELOC down before closing (PTF condition) → new decision supersedes; CTC re-issued → the gate opens
  const sup = supersedeDecision(h.events, re.decision, "D-REFI-CA-2", "2026-11-04T22:00:00.000Z"); assert.equal(sup.decision.status, "superseded"); assert.equal(sup.event.type, "decision.superseded");
  const r2 = conditionallyApprove(h, conditions, "D-REFI-CA-2", "2026-11-04T22:05:00.000Z");
  const ctc2 = issueClearToClose(h.events, r2.decision, runCtcChecklist({ application_id: REFI, decision_id: "D-REFI-CA-2", evaluated_at: "2026-11-04T22:10:00.000Z", facts: allPass() }), "2026-11-04T22:10:00.000Z").decision;
  assert.equal(ctcGate({ ctc_issued: true, checklist_passed: true, decision_status: ctc2.status, command: "consummate" }).open, true);
  // a reopen 5+ business days out is a 1-BD SLA
  const far = reopenDecision(h.events, h.escalations, ctc2, { cause: "contradictory_information", at: "2026-11-04T23:00:00.000Z", today: D("2026-11-04"), consummation_date: D("2026-11-13") }); assert.equal(far.sla, "1_business_day"); assert.equal(far.sla_due_on, "2026-11-05");
});
test("23.3-T6: Given a `decline_candidate` outcome, when the agent prepares the record with reasons `[\"debt-to-income ratio of 53.32% exceeds the 50% maximum\"]`, then 21.6 is not invoked until `reviewer_action = approved`; a reason text containing \"DU\" or \"Refer with Caution\" fails validation.", async () => {
  const h = harness(PURCHASE, "2026-10-28T16:00:00.000Z");
  const file = newDecisionFile({ application_id: PURCHASE, partner_name: "Partner Bank", partner_address: "100 Partner Plaza, Columbus, OH 43215", creditor_time_zone: "America/New_York", application_date: "2026-10-19", property_state: "OH", applicants: [{ id: "A", name: "A. Applicant", mailing_address: "10 High St, Columbus OH 43215", esign_consent: true, primary: true }] });
  const reasons = [{ code: "dti_excessive", text: "debt-to-income ratio of 53.32% exceeds the 50% maximum", principal: true, source_fact: "dti_calculations:DTI-PUR-3:dti_bps=5332", threshold: "50.00%", observed: "53.32%" }];
  const prep = prepareAdverseDecision(h.events, h.escalations, { decision_id: "D-PUR-DEN-1", application_id: PURCHASE, kind: "denial", reasons, counteroffer_terms: null, du_recommendation: "refer_with_caution", inputs_hash: inputsHash({ ulad_snapshot_hash: "ulad:pur:v2", verification_ids: [], findings_hash: "findings:pur:3" }), model_version: "underwriter-2026.09", prompt_version: "23.3-v1", rationale: "No lawful restructure keeps DTI ≤ 50%; decline candidate per 23.2.", confidence: 0.91, at: "2026-10-28T16:00:00.000Z", sla_due_on: D("2026-10-29") });
  assert.equal(prep.record.reviewer_action, null); assert.equal(prep.record.regb_handoff_at, null); assert.equal(prep.escalation.kind, "underwriting_reviewer"); assert.equal(prep.event.payload.regb_invoked, false);
  assert.deepEqual(prep.record.factors.map((f) => [f.rule_id, f.failed, f.reason_code]), [["dti_excessive", true, "dti_excessive"]]);
  // 21.6 is not invoked before the reviewer approves
  refusedBy(() => handOffToRegB(h.events, h.escalations, file, prep.record, "2026-10-28T17:00:00.000Z"), "ADVERSE_NEEDS_REVIEWER_APPROVAL");
  assert.equal(h.ofType("decision.recommended").length, 0); assert.equal(h.ofType("decision.reviewed").length, 0);
  // reason text naming DU or the recommendation fails validation (§1002.9(b)(2); B3-2-11)
  for (const text of ["DU returned Refer with Caution", "Desktop Underwriter did not approve the loan", "does not meet internal standards"])
    refusedBy(() => prepareAdverseDecision(h.events, h.escalations, { decision_id: "D-PUR-DEN-X", application_id: PURCHASE, kind: "denial", reasons: [{ code: "dti_excessive", text, principal: true, source_fact: "du_submissions:SUB-3" }], counteroffer_terms: null, du_recommendation: null, inputs_hash: "h", model_version: "m", prompt_version: "p", rationale: "r", confidence: 0.9, at: h.clock.now(), sla_due_on: D("2026-10-29") }), "REASON_TEXT_NOT_PERMISSIBLE");
  await refused(h.run("prepareAdverseDecision", { decision_id: "D-PUR-DEN-Y", kind: "denial", reasons: [{ code: "dti_excessive", text: "Refer with Caution from DU", principal: true, source_fact: "x" }], inputs_hash: "h", rationale: "r", sla_due_on: "2026-10-29" }), "REASON_TEXT_NOT_PERMISSIBLE");
  refusedBy(() => prepareAdverseDecision(h.events, h.escalations, { decision_id: "D-PUR-DEN-Z", application_id: PURCHASE, kind: "denial", reasons: [{ code: "dti_excessive", text: "debt-to-income ratio of 53.32% exceeds the 50% maximum", principal: true, source_fact: "" }], counteroffer_terms: null, du_recommendation: null, inputs_hash: "h", model_version: "m", prompt_version: "p", rationale: "r", confidence: 0.9, at: h.clock.now(), sla_due_on: D("2026-10-29") }), "REASON_WITHOUT_SOURCE_FACT");
  // the agent cannot approve its own record; the reviewer approves → 21.6 records the denial (decision.recommended + decision.reviewed) with the frozen reasons
  refusedBy(() => reviewAdverseDecision(h.events, h.escalations, prep.record, { action: "approved", reviewer: UW, at: h.clock.now() }), "ADVERSE_NEEDS_UNDERWRITING_REVIEWER");
  const rv = reviewAdverseDecision(h.events, h.escalations, prep.record, { action: "approved", reviewer: REVIEWER, at: "2026-10-28T20:00:00.000Z", notes: "Reasons specific and sourced; no restructure available" });
  assert.equal(rv.record.reviewer_action, "approved"); assert.equal(rv.record.reviewer_id, "u-uwr-1");
  refusedBy(() => reviewAdverseDecision(h.events, h.escalations, rv.record, { action: "modified", reviewer: REVIEWER, at: h.clock.now(), reasons }), "REASONS_FROZEN_AFTER_APPROVAL");
  const off = handOffToRegB(h.events, h.escalations, file, rv.record, "2026-10-28T20:05:00.000Z");
  assert.deepEqual(off.events.map((e) => e.type), ["decision.recommended", "decision.reviewed", "adverse_decision.handed_off"]);
  assert.equal(off.decision.kind, "denial"); assert.equal(off.decision.reviewer_outcome, "approved"); assert.equal(off.decision.reviewer_id, "u-uwr-1"); assert.equal(off.decision.decision_factors[0]!.description, "debt-to-income ratio of 53.32% exceeds the 50% maximum");
  assert.equal(off.record.regb_handoff_at, "2026-10-28T20:05:00.000Z");
});
test("23.3-T7: Given a counteroffer notice sent Thu Oct 29, 2026 that the borrower neither accepts nor uses, then 21.6's `REGB_1002_9_COUNTEROFFER_90` expires Wed Jan 27, 2027 and `restructure_proposals.status = expired` (23.2); no second adverse-action notice is required when the combined notice was used (comment 9(a)(1)-6).", async () => {
  const h = harness(PURCHASE, "2026-10-29T18:00:00.000Z", ["23.3", "21.6"]);
  // 21.6's clock: sent Thu Oct 29, 2026 + 90 calendar days → Wed Jan 27, 2027 (§1002.9(a)(1)(iv))
  const x = counterofferExpiry({ sent_on: D("2026-10-29"), combined_notice: true });
  assert.equal(x.expires_on, "2027-01-27"); assert.equal(x.second_notice_required, false); assert.equal(x.timer, "REGB_1002_9_COUNTEROFFER_90");
  assert.equal(counterofferExpiry({ sent_on: D("2026-10-29"), combined_notice: false }).second_notice_required, true);
  h.append("decision.issued", { decision_id: "D-PUR-CO-1", kind: "counteroffer", decided_on: "2026-10-29", sent_on: "2026-10-29", combined_notice: true }, UW);
  const t = h.timer("REGB_1002_9_COUNTEROFFER_90")!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2027-01-27");
  // 23.2's proposal row (the $360,000.00 counteroffer) expires with the clock
  const proposal: RestructureProposal = { proposal_id: "rp:APP-PURCH-412K:loan_amount:2026-10-28", application_id: PURCHASE, trigger_submission_id: "SUB-3", kind: "loan_amount", from: { loan_amount_cents: "38000000" }, to: { loan_amount_cents: "36000000", ltv_display: "78.60", mi_coverage_pct: null }, expected_recommendation: "approve_eligible", expected_dti_bps: 4673, expected_dti_display: "46.73", arithmetic: {}, regb_treatment: "counteroffer", changed_circumstance_id: null, status: "proposed", proposed_at: "2026-10-28T16:00:00.000Z", decided_at: null, reviewer_id: "u-uwr-1", initiated_by: "sm" };
  h.at("2027-01-28T15:00:00.000Z");
  const viaBus = await h.run("prepareAdverseDecision", { op: "counteroffer_expiry", sent_on: "2026-10-29", combined_notice: true, proposal });
  assert.equal(viaBus.expires_on, "2027-01-27"); assert.equal(viaBus.second_notice_required, false); assert.equal(viaBus.proposal_status, "expired"); assert.equal(viaBus.event, "restructure.expired");
  const exp = h.ofType("restructure.expired"); assert.equal(exp.length, 1); assert.equal(exp[0]!.payload.cause, "REGB_1002_9_COUNTEROFFER_90");
  const direct = expireCounterofferProposal(h.events, { ...proposal, proposal_id: "rp:2" }, h.clock.now()); assert.equal(direct.proposal.status, "expired");
  // before the clock runs out the proposal stays proposed
  h.at("2026-12-01T15:00:00.000Z");
  assert.equal((await h.run("prepareAdverseDecision", { op: "counteroffer_expiry", sent_on: "2026-10-29", proposal: { ...proposal, proposal_id: "rp:3" } })).proposal_status, "proposed");
});
test("23.3-T8: Given `qc.review.opened{kind=prefunding}` on Wed Oct 28, 2026 for the refinance fixture, then 28.1's `FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE` (checklist item `SM_QC_PREFUNDING_HOLD`) blocks CTC until `qc.review.closed`; a review closed Thu Oct 29 with no defects allows CTC Fri Oct 30.", async () => {
  const h = harness(REFI, "2026-10-28T16:00:00.000Z");
  const conditions = clearAll(openPtdConditions(h, REFI, "2026-10-06T16:12:00.000Z"));
  const r = conditionallyApprove(h, conditions); h.at("2026-10-28T16:00:00.000Z");
  h.append("qc.review.opened", { review_id: "QCR-1", kind: "prefunding", selected_on: "2026-10-28" }, { kind: "agent", id: "qc-audit" });
  const gate = h.timer("FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:23.3.prefundingQcGate");
  assert.equal(prefundingReviewStatus(h.events.all()), "open");
  assert.equal(prefundingQcGate({ review_status: "open" }).open, false); assert.deepEqual(prefundingQcGate({ review_status: "open" }).blocking_codes, [SM_QC_PREFUNDING_HOLD]);
  assert.equal(evaluateGate("23.3.prefundingQcGate", { review_status: "open", command: "clear_to_close" }).open, false);
  const held = (await h.run("runCtcChecklist", { op: "ctc", decision: r.decision, facts: allPass(), derive_prefunding_status: true })) as unknown as ReturnType<typeof runCtcChecklist>;
  const item = held.items.find((x) => x.code === "CTC_QC_PREFUNDING")!;
  assert.equal(item.status, "fail"); assert.equal(item.item_alias, SM_QC_PREFUNDING_HOLD); assert.equal(item.evidence_ref, `${SM_QC_PREFUNDING_HOLD}:open`); assert.equal(item.owner_process, "28.1"); assert.deepEqual(held.blocking_codes, ["CTC_QC_PREFUNDING"]);
  await refused(h.run("issueClearToClose", { decision: r.decision, checklist: held }), "CTC_CHECKLIST_FAILING");
  // Thu Oct 29: the review closes with no defects → the gate opens; Fri Oct 30 CTC
  h.at("2026-10-29T21:00:00.000Z");
  h.append("qc.review.closed", { review_id: "QCR-1", kind: "prefunding", outcome: "no_defect", defects_open: false }, { kind: "agent", id: "qc-audit" });
  assert.equal(h.timer("FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE")!.status, "satisfied");
  assert.equal(prefundingReviewStatus(h.events.all()), "closed_no_defect"); assert.equal(prefundingQcGate({ review_status: "closed_no_defect" }).open, true); assert.equal(prefundingQcGate({ review_status: "unable_to_complete" }).open, true); assert.equal(prefundingQcGate({ review_status: "defect_open" }).open, false);
  h.at("2026-10-30T16:30:00.000Z");
  const ok = (await h.run("runCtcChecklist", { op: "ctc", decision: r.decision, facts: allPass(), derive_prefunding_status: true })) as unknown as ReturnType<typeof runCtcChecklist>;
  assert.equal(ok.passed, true); assert.equal(ok.items.find((x) => x.code === "CTC_QC_PREFUNDING")!.status, "pass");
  const ctc = await h.run("issueClearToClose", { decision: r.decision, checklist: ok });
  assert.equal((ctc.decision as CreditDecision).ctc_at, "2026-10-30T16:30:00.000Z"); assert.equal(h.ofType("clear_to_close.issued")[0]!.occurredAt.slice(0, 10), "2026-10-30");
  // a hold applied after CTC (defect found) closes the gate again
  h.append("qc.hold.applied", { review_id: "QCR-1", kind: "prefunding", finding_ids: ["F1"] }, { kind: "agent", id: "qc-audit" });
  assert.equal(prefundingReviewStatus(h.events.all()), "defect_open");
  await refused(h.run("issueClearToClose", { decision: r.decision, checklist: ok, prefunding_hold_open: true }), "CTC_WITH_OPEN_PREFUNDING_HOLD");
});
test("23.3-T9: Given employment validated with close-by date Mon Dec 7, 2026 and consummation Fri Nov 6, 2026, then `rep_warrant_relief{employment_validated}.status = eligible`; given the closing slips to Tue Dec 8, 2026 without a new validation, then `lost` and a PTF VVOE condition is opened (22.3).", async () => {
  const h = harness(REFI, "2026-10-30T16:30:00.000Z");
  const ctx = { application_id: REFI, stage: "ctc" as const, closing_date: D("2026-11-06"), as_of: D("2026-10-30"), evaluated_at: "2026-10-30T16:30:00.000Z" };
  const ledger = evaluateReliefLedger(RELIEF, ctx);
  const by = Object.fromEntries(ledger.map((e) => [e.component, e]));
  assert.equal(by.employment_validated!.status, "eligible"); assert.equal(by.employment_validated!.close_by_date, "2026-12-07"); assert.equal(by.employment_validated!.conditions_met, true);
  assert.equal(by.limited_waiver_du!.status, "eligible"); assert.equal(by.income_validated!.status, "eligible"); assert.equal(by.assets_validated!.status, "eligible"); assert.equal(by.value_acceptance!.status, "eligible"); assert.equal(by.undisclosed_debt!.credit_expiration_date, "2027-02-05");
  assert.equal(by.income_calculator!.status, "not_applicable"); assert.equal(by.cu_score_2_5!.status, "not_applicable");
  const rec = recordReliefLedger(h.events, ledger, ctx); assert.equal(rec.type, "rep_warrant_relief.evaluated"); assert.equal(rec.applicationId, REFI);
  // at funding (consummated Fri Nov 6 ≤ Close by Mon Dec 7) still eligible
  assert.equal(Object.fromEntries(evaluateReliefLedger(RELIEF, { ...ctx, stage: "funding", as_of: D("2026-11-12") }).map((e) => [e.component, e.status])).employment_validated, "eligible");
  // the closing moves to Tue Dec 8 without a new validation: at_risk while the date is ahead, lost once it passes
  assert.equal(Object.fromEntries(evaluateReliefLedger(RELIEF, { ...ctx, closing_date: D("2026-12-08"), as_of: D("2026-11-20") }).map((e) => [e.component, e.status])).employment_validated, "at_risk");
  const slipped = evaluateReliefLedger(RELIEF, { ...ctx, closing_date: D("2026-12-08"), as_of: D("2026-12-08"), evaluated_at: "2026-12-08T15:00:00.000Z" });
  const emp = slipped.find((e) => e.component === "employment_validated")!; assert.equal(emp.status, "lost");
  // 22.3's close-by reassessment (cure options; rep_warrant_relief.updated) and the PTF VVOE condition
  h.at("2026-12-08T15:00:00.000Z");
  const lost = loseEmploymentRelief(h.events, { ...emp, status: "eligible" }, { borrower_id: "B1", report_reference_id: "DUV-EMP-1", scheduled_note_date: D("2026-12-08"), at: "2026-12-08T15:00:00.000Z" });
  assert.equal(lost.entry.status, "lost"); assert.equal(lost.condition.stage, "ptf"); assert.equal(lost.condition.template_code, VVOE_PTF_TEMPLATE); assert.equal(lost.condition.source, "underwriter"); assert.deepEqual([...lost.condition.evidence_kinds], ["vvoe_record"]); assert.equal(lost.condition.status, "open");
  assert.deepEqual(lost.events.map((e) => e.type), ["du.close_by.missed", "du.resubmission.requested", "rep_warrant_relief.updated", "condition.opened"]);
  assert.equal(lost.events[2]!.payload.status, "lost_unless_cured"); assert.equal(lost.events[2]!.payload.component, "employment");
  // the same through the bus, persisted on rep_warrant_relief
  const viaBus = await h.run("evaluateReliefLedger", { facts: RELIEF, stage: "funding", closing_date: "2026-12-08", as_of: "2026-12-08" });
  assert.equal((viaBus.entries as { component: string; status: string }[]).find((e) => e.component === "employment_validated")!.status, "lost");
  await refused(h.run("evaluateReliefLedger", { facts: RELIEF, stage: "funding", as_of: "2026-12-08", confirm: true }), "RELIEF_CONFIRMED_ONLY_BY_FNMA");
});
test("23.3-T10: Given an `underwriting_reviewer` attempts to waive `COND_DU_VERIFY_ASSETS`, then the waiver is refused (`WAIVER_NOT_PERMITTED_DU_MESSAGE`); waiving an SM-added `COND_SM_LETTER_OF_EXPLANATION` succeeds with a recorded reason.", async () => {
  const h = harness(REFI, "2026-10-20T16:00:00.000Z");
  const du = condition(h, REFI, "COND_DU_VERIFY_ASSETS", "2026-10-06T16:12:00.000Z"); assert.equal(du.source, "du"); assert.equal(du.du_message_id, "V1004");
  refusedBy(() => waiveCondition(h.events, du, { reason: "assets sufficient per DU", at: h.clock.now() }, REVIEWER), "WAIVER_NOT_PERMITTED_DU_MESSAGE");
  assert.equal(h.ofType("condition.waived").length, 0);
  const sm = openCondition(h.events, { application_id: REFI, submission_id: null, template_code: "COND_SM_LETTER_OF_EXPLANATION", category: "credit", stage: "ptd", source: "underwriter", text: "Your lender needs a short letter explaining the credit inquiries in the last 90 days.", internal_text: "LOE for 3 inquiries (22.2)", evidence_kinds: ["letter_of_explanation"], opened_at: "2026-10-08T16:00:00.000Z" }).condition;
  refusedBy(() => waiveCondition(h.events, sm, { reason: "inquiries explained on the call", at: h.clock.now() }, UW), "WAIVER_NEEDS_UNDERWRITING_REVIEWER");
  await refused(h.run("clearCondition", { op: "waive", condition: sm, reason: "inquiries explained on the call" }), "WAIVER_NEEDS_UNDERWRITING_REVIEWER");
  const w = await h.run("clearCondition", { op: "waive", condition: sm, reason: "Inquiries were rate shopping for this mortgage (22.2 explainInquiry); no new debt opened" }, REVIEWER);
  const waived = w.condition as Condition; assert.equal(waived.status, "waived"); assert.equal(waived.cleared_by, "u-uwr-1");
  const ev = h.ofType("condition.waived"); assert.equal(ev.length, 1); assert.equal(ev[0]!.payload.reason, "Inquiries were rate shopping for this mortgage (22.2 explainInquiry); no new debt opened"); assert.equal(ev[0]!.payload.waived_by_role, "underwriting_reviewer");
  // eligibility items are never waived; a waiver needs a reason
  const elig = openCondition(h.events, { application_id: REFI, submission_id: null, template_code: "COND_SM_PROJECT_ELIGIBILITY", category: "project", stage: "ptd", source: "underwriter", text: "Your lender is reviewing the condominium project.", internal_text: "B4-2 project review", opened_at: "2026-10-08T16:00:00.000Z" }).condition;
  refusedBy(() => waiveCondition(h.events, elig, { reason: "x", at: h.clock.now() }, REVIEWER), "WAIVER_NOT_PERMITTED_ELIGIBILITY");
  await refused(h.run("clearCondition", { op: "waive", condition: elig, reason: "x" }, REVIEWER), "WAIVER_NOT_PERMITTED_ELIGIBILITY");
  assert.throws(() => waiveCondition(h.events, { ...sm, condition_id: "c2" }, { reason: "", at: h.clock.now() }, REVIEWER), RangeError);
  // a waived / cleared condition can be reopened on contradictory information (also by qc_officer)
  const re = reopenCondition(h.events, waived, { reason: "paystub shows a garnishment not in the credit report", at: h.clock.now() }, QC); assert.equal(re.condition.status, "reopened"); assert.equal(re.event.payload.reason, "paystub shows a garnishment not in the credit report");
});
test("23.3-T11: Given the loan is purchased Thu Nov 19, 2026 with first payment due Fri Jan 1, 2027, then `rep_warrant_relief{payment_history_36}` opens with a target of the 36th payment due Dec 1, 2029 and status `eligible` pending Fannie Mae's relief report (28.2/30.4).", async () => {
  const h = harness(REFI, "2026-11-19T20:00:00.000Z");
  const r = openPaymentHistoryRelief(h.events, { application_id: REFI, loan_id: "LN-REFI-1", purchase_date: D("2026-11-19"), first_payment_due: D("2027-01-01"), at: "2026-11-19T20:00:00.000Z" });
  assert.equal(r.entry.component, "payment_history_36"); assert.equal(r.entry.target_date, "2029-12-01"); assert.equal(r.entry.status, "eligible"); assert.equal(r.entry.confirmed_at, null); assert.equal(r.entry.basis_ref, "A2-3.2-02"); assert.equal(r.entry.loan_id, "LN-REFI-1");
  assert.match(r.entry.notes, /36 monthly payments/); assert.match(r.entry.notes, /28\.2\/30\.4/);
  assert.equal(r.event.type, "rep_warrant_relief.evaluated"); assert.deepEqual((r.event.payload.components as { component: string; status: string; target_date: string }[])[0], { component: "payment_history_36", status: "eligible", target_date: "2029-12-01", purchase_date: "2026-11-19", first_payment_due: "2027-01-01" });
  const viaBus = await h.run("evaluateReliefLedger", { op: "payment_history", loan_id: "LN-REFI-1", purchase_date: "2026-11-19", first_payment_due: "2027-01-01" });
  assert.equal(viaBus.target_date, "2029-12-01"); assert.equal(h.store.get("rep_warrant_relief", "rwr:APP-REFI-560K:payment_history_36")!.data.status, "eligible");
  await refused(h.run("evaluateReliefLedger", { op: "payment_history", loan_id: "LN-REFI-1", purchase_date: "2026-11-19", first_payment_due: "2027-01-01", status: "confirmed_by_fnma" }), "RELIEF_CONFIRMED_ONLY_BY_FNMA");
  assert.throws(() => openPaymentHistoryRelief(h.events, { application_id: REFI, loan_id: "LN-REFI-1", purchase_date: D("2026-11-19"), first_payment_due: D("2026-11-01"), at: h.clock.now() }), RangeError);
});
test("23.3-T12: Given any decision record, then it contains `rule_set_versions`, `model_version`, `prompt_version`, `inputs_hash` and `reasons[].source_fact`, and no field derived from `applicant_demographics` (access log shows zero reads by the `underwriter` agent).", async () => {
  const h = harness(REFI, "2026-10-07T15:00:00.000Z");
  const conditions = openPtdConditions(h, REFI, "2026-10-06T16:12:00.000Z");
  const r = conditionallyApprove(h, conditions);
  const rec = decisionRecord23_3(r.decision, { du: { casefile_id: "CF-1", submission_number: 1, recommendation: "approve_eligible", policy_generation: "2026_09_26", findings_hash: "findings:sub1" }, evidence: [{ document_id: "doc-cr-1", kind: "credit_report" }] });
  for (const k of ["rule_set_versions", "model_version", "prompt_version", "inputs_hash", "reasons", "risk_assessment", "reviewer", "outcome", "confidence", "rationale", "du", "evidence"]) assert.ok(k in rec, `record carries ${k}`);
  assert.deepEqual(rec.rule_set_versions, RULE_SETS_23_3); assert.equal(rec.model_version, "underwriter-2026.09"); assert.equal(rec.prompt_version, "23.3-v1"); assert.equal(rec.inputs_hash, inputsHash(INPUTS)); assert.match(rec.inputs_hash, /^[0-9a-f]{64}$/);
  // adverse records: every reason carries its source_fact
  const prep = prepareAdverseDecision(h.events, h.escalations, { decision_id: "D-REFI-CO-1", application_id: REFI, kind: "counteroffer", reasons: [{ code: "dti_excessive", text: "requested loan amount produces a debt-to-income ratio of 53.32%, above the 50% maximum", principal: true, source_fact: "dti_calculations:DTI-3:dti_bps=5332" }], counteroffer_terms: { loan_amount_cents: 36_000_000n, note_rate: "6.375", product_code: "FRM30", ltv: "78.60", conditions: [], expires_on: D("2027-01-27") }, du_recommendation: "refer_with_caution", inputs_hash: rec.inputs_hash, model_version: "underwriter-2026.09", prompt_version: "23.3-v1", rationale: "restructure to $360,000 keeps DTI at 46.73%", confidence: 0.9, at: h.clock.now(), sla_due_on: D("2026-10-08") });
  const adv = decisionRecord23_3(prep.record, { du: rec.du }); assert.ok(adv.reasons.every((x) => typeof x.source_fact === "string" && x.source_fact.length > 0)); assert.equal(adv.outcome, "counteroffer_pending_reviewer");
  // no field derived from applicant_demographics — the guard walks the graph; the bus refuses demographic inputs
  assert.ok(!JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).match(/race|ethnicity|marital_status|applicant_demographics/));
  refusedBy(() => assertNoDemographics({ credit: { score: 712 }, borrower: { applicant_demographics: { race: "x" } } }), "PROTECTED_CLASS_DATA_IN_ASSESSMENT");
  refusedBy(() => assessRisk({ ...RISK, credit: { ...RISK.credit, age: 41 } as never }), "PROTECTED_CLASS_DATA_IN_ASSESSMENT");
  await refused(h.run("assessRisk", { risk_input: RISK, applicant_demographics: { ethnicity: "x" } }), "PROTECTED_CLASS_DATA_IN_ASSESSMENT");
  await refused(h.run("writeDecision", { decision: r.decision, marital_status: "married" }), "PROTECTED_CLASS_DATA_IN_ASSESSMENT");
  // the access log: the underwriter agent's tool runs read decisions, conditions, checklists — never applicant_demographics
  await h.run("assessRisk", { risk_input: RISK, decision_id: r.decision.decision_id });
  h.store.put("credit_decisions", r.decision.decision_id, r.decision as unknown as Record<string, unknown>, UW, h.clock.now());
  const via = await h.run("writeDecision", { decision_id: r.decision.decision_id, du: rec.du, action: "23.3 conditional approval" });
  assert.equal((via as { decision_id: string }).decision_id, r.decision.decision_id); const row = h.decisions.find((d) => d.subject?.kind === "decision" && d.subject.id === r.decision.decision_id); assert.ok(row, "writeDecision records the agent_decisions row"); assert.equal(row!.confidence, 0.94); assert.match(row!.ruleSetVersion, /fnma\.selling@2026-09-02/);
  await h.run("runCtcChecklist", { op: "ctc", decision_id: r.decision.decision_id, facts: allPass() });
  assert.ok(h.store.reads.length > 0); assert.equal(h.store.reads.filter((k) => k === "applicant_demographics").length, 0);
  assert.equal(validityExpired(r.decision, D("2026-11-22")).expired, true); assert.equal(validityExpired(r.decision, D("2026-11-21")).component, "lock_expiration");
});

test("23.3 worked figures: $360,000.00 at 6.375% → P&I $2,245.93; taxes $520.00, insurance $95.00, other debts $410.00 → DTI 46.73% at $7,000.00 income (counteroffer arithmetic, rule 10); 53.32% on the requested terms", () => {
  // proposed $360,000.00 at 6.375 % / 360: P&I $2,245.93 (23.1's P&I, half-up)
  assert.equal(piCents(36_000_000n, "6.375", 360), 224_593n);
  // 23.2's PITIA on the purchase fixture ($458,000.00 price → LTV 78.60 %, no MI): taxes $520.00 + insurance $95.00 + other debts $410.00
  const f = { monthly_income_cents: 700_000n, loan_amount_cents: 38_000_000n, value_cents: 45_800_000n, purchase_price_cents: 45_800_000n, transaction_type: "purchase" as const, note_rate_pct: "6.375", term_months: 360, taxes_monthly_cents: 52_000n, insurance_monthly_cents: 9_500n, other_debts_monthly_cents: 41_000n, mi_annual_rate_pct: "0.40", product: "standard" as const };
  const p = pitiaFor(f, 36_000_000n);
  assert.equal(p.pi_cents, 224_593n); assert.equal(p.mi_cents, 0n); assert.equal(p.taxes_cents, 52_000n); assert.equal(p.insurance_cents, 9_500n); assert.equal(p.debts_cents, 41_000n);
  assert.equal(p.obligations_cents, 327_093n);                       // $2,245.93 + $520.00 + $95.00 + $410.00 = $3,270.93
  assert.equal(p.dti_bps, 4673); assert.equal(p.dti_display, "46.73"); assert.equal(p.over_du_cap, false); assert.equal(p.ltv_display, "78.60");
  // the requested terms: obligations $3,732.67 / $7,000.00 → 53.32 % > 50 % (the counteroffer reason text)
  assert.equal(dtiBps(373_267n, 700_000n), 5332); assert.equal(dtiBps(327_093n, 700_000n), 4673);
  const reason = `requested loan amount produces a debt-to-income ratio of ${(5332 / 100).toFixed(2)}%, above the 50% maximum`;
  assert.equal(reason, "requested loan amount produces a debt-to-income ratio of 53.32%, above the 50% maximum");
});
