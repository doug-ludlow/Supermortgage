// 21.6 Application-status decisions: notice of incompleteness, withdrawal, counteroffer, denial/adverse action (ECOA + FCRA), and HMDA action-taken recording
// spec/sections/21-application-urla-initial-disclosures-intent-to-proceed-rate/21-6-application-status-decisions-notice-of-incompleteness-withdr.md
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
import { TOOLS_21_6 } from "../../app/tools/section21-6.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { newIntakeApplication, receiveApplication } from "./ops-21-1.ts";
import type { Lock } from "./ops-21-4.ts";
import { scoreDisclosurePayloads, type CreditReport } from "../verification/ops-22-2.ts";
import { type DecisionFile, type DecisionFactor, type ScoreInput, newDecisionFile, decisionClock, reviewerSlaDue, counterofferClock, coExplanationDue, selectPrincipalReasons, hmdaDenialReasons, assembleFcraBlock, adverseNoticePayloads, hmdaActionFor, discouragementCheck, silenceAssessment, isExpressWithdrawal, recordWithdrawal, closeIncomplete, loanAmountAtLtv, ltvPercent, valueNeededForLtv, adverseNoticePolicyDue, ECOA_REASONS, FEDERAL_AGENCY_BLOCKS, NOTICE_CODES_21_6, CO_SB26_189_EFFECTIVE_FROM } from "./ops-21-6.ts";

const UW: Actor = { kind: "agent", id: "underwriter" };
const REVIEWER: Actor = { kind: "human", id: "u-uwr-1", role: "underwriting_reviewer" };
const REVIEWER_2: Actor = { kind: "human", id: "u-uwr-2", role: "underwriting_reviewer" };
const toolKey = (process: string, name: string): string => `${process} ${name}`;
const noticeReg = buildRegistry(); publishAuthored(noticeReg);
const MST = "America/Phoenix", EST = "America/New_York";
/** The 21.6 bus alone: TOOLS_21_6 bound to the `underwriter` agent over the overridden registry (21.6 rows + 20.3's registry row for REGB_1002_9_DECISION_30), escalations and the Notice Registry; the application-scoped unit of work stamps `applicationId` on every event. */
function harness(applicationId: string, nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["21.6", "20.3"] });
  const escalations = new EscalationService(events, clock); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, ports: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }) };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const agents = new AgentRegistry(); const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_21_6) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = UW): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("21.6", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  const file = (): DecisionFile => rt.store.get("application_decisions", applicationId)!.data as unknown as DecisionFile;
  const text = (noticeId: string): string => rt.notices!.get(noticeId).rendered.text;
  /** The opened escalation as its `escalation.created` event records it (kind, owner role, payload, opener). */
  const esc = (id: string) => { const e = events.all().find((x) => x.type === "escalation.created" && x.payload.escalation_id === id); if (!e) throw new RangeError(`no escalation ${id}`); const p = e.payload as Record<string, unknown>; return { kind: p.kind as string, ownerRole: p.owner_role as string, payload: p, openedBy: `${e.actor.kind}:${e.actor.id}` }; };
  return { clock, events, timers, escalations, rt, uow, run, at, timer, ofType, file, text, esc, decisions };
}
const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
/** Worked example 1: Phoenix refinance, Reg B application Mon Oct 5, 2026 (21.1's `application.received{application_date}` arms the 30-day clock). */
const REFI = { partner_name: "Partner Bank", partner_address: "100 Partner Plaza, Phoenix, AZ 85004", creditor_time_zone: MST, application_date: "2026-10-05", property_state: "AZ", applicants: [{ id: "B1", name: "R. Borrower", mailing_address: "1 Palm Ln, Phoenix AZ 85001", email: "r@example.com", esign_consent: true, primary: true }], lock_id: "LK-1", original_terms: { loan_amount_cents: 56_000_000n, note_rate: "6.125", product_code: "FNMA30", ltv: "70.0" } };
/** Worked example 2: Columbus OH purchase, application Mon Oct 19, 2026, two borrowers (one self-employed), contract $457,780, appraisal $445,000. */
const PURCHASE = { partner_name: "Partner Bank", partner_address: "100 Partner Plaza, Columbus, OH 43215", creditor_time_zone: EST, application_date: "2026-10-19", property_state: "OH", applicants: [{ id: "A", name: "A. Applicant", mailing_address: "10 High St, Columbus OH 43215", esign_consent: true, primary: true }, { id: "B", name: "B. Applicant", mailing_address: "10 High St, Columbus OH 43215", esign_consent: false, primary: false }], original_terms: { loan_amount_cents: 41_200_000n, note_rate: "6.125", product_code: "FNMA30_HOMEREADY", ltv: "92.6" } };
function received(h: ReturnType<typeof harness>, o: { id: string; tz: string; state: string; at: string; channel?: string; transaction_type?: string }): void {
  const app = newIntakeApplication({ id: o.id, partner_name: "Partner Bank", partner_nmlsr_id: "123456", intake_channel: (o.channel as "voice" | "web") ?? "voice", started_at: o.at, creditor_time_zone: o.tz, property_state: o.state, borrowers: [{ id: "B1", legal_name: "R. Borrower", marital_status: "married" }] });
  receiveApplication(h.events, app, { at: o.at, transaction_type: o.transaction_type ?? "limited_cash_out", occupancy: "primary", identity_verified: true });
}
/** The rules component after the Oct 22 resubmission: `dti_max_50` failed at 51.3 % (the $1,150/month auto lease) and `credit_delinquent` (a 30-day late on a revolving account in June 2026). */
const FACTORS: DecisionFactor[] = [
  { rule_id: "dti_max_50", description: "Debt-to-income ratio above the program maximum", threshold: "50.0", observed: "51.3", applicant_ids: ["B1"], evidence_document_ids: ["doc-paystub-1020", "doc-udm-lease"], failed: true, source: "rules" },
  { rule_id: "credit_delinquent", description: "30-day late payment on a revolving account in June 2026 on the refreshed report", threshold: "0", observed: "1", applicant_ids: ["B1"], evidence_document_ids: ["doc-credit-refresh"], failed: true, source: "credit_report" },
  { rule_id: "ltv_max", description: "Loan-to-value within the program maximum", threshold: "97.0", observed: "70.0", applicant_ids: ["B1"], evidence_document_ids: ["doc-appraisal"], failed: false, source: "valuation" },
];
/** 22.2's tri-merge for the sole applicant: representative (middle) score 712 from Experian/Fair Isaac Risk Model V2, created 2026-10-05. */
const SCORES_B1: ScoreInput = { borrower_id: "B1", score_model: "classic_fico", date: D("2026-10-05"), range: { min: 300, max: 850 }, applicable_score: 712,
  scores: [{ repository: "efx", bureau: "Equifax", score: 705, model_version: "Equifax Beacon 5.0", key_factors: ["Serious delinquency", "Too many accounts with balances"], inquiries_key_factor: false },
    { repository: "exp", bureau: "Experian", score: 712, model_version: "Experian/Fair Isaac Risk Model V2", key_factors: ["Proportion of balances to credit limits on revolving accounts is too high", "Serious delinquency", "Too many accounts with balances", "Length of time accounts have been established", "Too many inquiries in the last 12 months"], inquiries_key_factor: false },
    { repository: "tu", bureau: "TransUnion", score: 720, model_version: "TransUnion FICO Risk Score, Classic 04", key_factors: ["Serious delinquency"], inquiries_key_factor: false }] };
/** Runs worked example 1 through the reviewer's approval (Mon Oct 26 11:05 MST): recommendation Fri Oct 23 09:40 MST → underwriting_reviewer escalation. */
async function deniedRefi(h: ReturnType<typeof harness>, o: { reviewAt?: string } = {}) {
  received(h, { id: "APP-REFI-1", tz: MST, state: "AZ", at: "2026-10-05T17:16:00.000Z" });
  h.at("2026-10-23T16:40:00.000Z");
  const rec = await h.run("recommendDisposition", { ...REFI, decision_id: "D-1", factors: FACTORS, du_recommendation: "refer_with_caution", data_verified_and_resubmitted: true });
  h.at(o.reviewAt ?? "2026-10-26T18:05:00.000Z");
  const rev = await h.run("openReviewerEscalation", { op: "decide", decision_id: "D-1", outcome: "approved" }, REVIEWER);
  return { rec, rev };
}
const minimalLock = (application_id: string, lock_id = "LK-1"): Lock => ({ lock_id, application_id, lineage_id: "LN-1", version: 1, kind: "initial", supersedes_lock_id: null, status: "locked", requested_at: "2026-10-07T17:19:00.000Z", quote: {} as Lock["quote"], quote_id: "Q-1", quote_id_fnma: null, mlo_approval_escalation_id: null, approved_at: "2026-10-07T17:19:00.000Z", mlo_nmlsr_id: "1234567", locked_at: "2026-10-07T17:19:00.000Z", rate_set_date: D("2026-10-07"), note_rate: "6.125", price: "100.000", points_cents: 0n, lender_credit_cents: 0n, lock_period_days: 45, expires_on: D("2026-11-23"), expires_at: "2026-11-24T00:00:00.000Z", expiry_roll_applied: true, time_zone: MST, product_code: "FNMA30", loan_amount_cents: 56_000_000n, worst_case_pricing_applied: false, extension_fee_cents: 0n, extension_payer: null, float_down_fee_cents: 0n, commitment_id: "CMT-1", revised_le_disclosure_id: null, state_agreement_variant: null, property_state: "AZ", cancelled_reason: null, ny_expiry_notice_required: false, borrower_statement: "lock it", superseded_quote_ids: [], recorded_by: "pricing" } as unknown as Lock);

test("21.6-T1: Given `application_date` Mon Oct 5, 2026, then `REGB_1002_9_DECISION_30` is due Wed Nov 4, 2026 23:59 MST; a denial notice sent Mon Oct 26 satisfies it; a notice sent Thu Nov 5 breaches and is logged as an incident.", async () => {
  const clock = decisionClock(D("2026-10-05"), MST);
  assert.equal(clock.decision_due_on, "2026-11-04"); assert.equal(clock.decision_due_at, "2026-11-05T06:59:00.000Z", "23:59 MST on Wed Nov 4 (UTC−7)"); assert.equal(clock.at_risk_on, "2026-11-01");
  // (a) the denial notice sent Mon Oct 26 satisfies the clock
  const h = harness("APP-REFI-1", "2026-10-05T17:14:00.000Z");
  await deniedRefi(h);
  const t = h.timer("REGB_1002_9_DECISION_30")!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2026-11-04", "Mon Oct 5 + 30 calendar days");
  assert.equal((await h.run("trackDecisionClock", { now: "2026-10-26T18:05:00.000Z" })).status, "open");
  const r = await h.run("renderNotice", { decision_id: "D-1", score_payloads: [SCORES_B1], notice_date: "2026-10-26" });
  h.at("2026-10-26T18:30:00.000Z"); const sent = await h.run("deliverNotice", { decision_id: "D-1", notice_ids: r.notice_ids, score_payloads: [SCORES_B1] });
  assert.equal(sent.sent, true); assert.equal(h.timer("REGB_1002_9_DECISION_30")!.status, "satisfied"); assert.equal(h.timer("REGB_1002_9_DECISION_30")!.satisfiedAt, "2026-10-26T18:30:00.000Z");
  assert.equal(h.ofType("decision.issued")[0]!.payload.kind, "denial"); assert.equal((await h.run("trackDecisionClock", { now: "2026-10-27T00:00:00.000Z" })).status, "notified");
  assert.equal(h.ofType("timer.breached").length, 0);
  // (b) a notice sent Thu Nov 5 breaches the clock: sev 1 to compliance-sentinel + the partner officer, an incident record; the notice still issues (satisfied_late)
  const late = harness("APP-REFI-1", "2026-10-05T17:14:00.000Z");
  await deniedRefi(late, { reviewAt: "2026-11-05T16:00:00.000Z" });
  const breaches = late.timers.evaluate("2026-11-05T16:00:00.000Z");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "REGB_1002_9_DECISION_30"); assert.equal(late.timer("REGB_1002_9_DECISION_30")!.status, "breached");
  const inc = await late.run("trackDecisionClock", { op: "breach", now: "2026-11-05T16:00:00.000Z" });
  assert.equal(inc.incident_id, "INC-REGB30-APP-REFI-1"); assert.deepEqual(inc.escalated_to, ["compliance-sentinel", "officer"]);
  const esc = late.esc(inc.escalation_id as string); assert.equal(esc.kind, "sev1"); assert.equal(esc.payload.qc_self_identification, true);
  const r2 = await late.run("renderNotice", { decision_id: "D-1", score_payloads: [SCORES_B1], notice_date: "2026-11-05" });
  late.at("2026-11-05T17:00:00.000Z"); await late.run("deliverNotice", { decision_id: "D-1", notice_ids: r2.notice_ids, score_payloads: [SCORES_B1] });
  assert.equal(late.timer("REGB_1002_9_DECISION_30")!.status, "satisfied_late"); assert.equal(late.ofType("decision.clock.breached").length, 1);
});

test("21.6-T2: Given a Refer with Caution recommendation with `decision_factors` `dti_max_50` failed (51.3 %) and `credit_delinquent` failed, when the agent selects reasons, then the notice states \"Excessive obligations in relation to income\" and \"Delinquent past or present credit obligations with others\" and never the string \"Refer with Caution\"; HMDA denial codes 1 and 3.", async () => {
  const reasons = selectPrincipalReasons(FACTORS);
  assert.deepEqual(reasons.map((r) => r.statement_text), ["Excessive obligations in relation to income", "Delinquent past or present credit obligations with others"], "ordered by materiality: the DTI factor's distance beyond its threshold ((51.3 − 50) / 50) ranks before the binary delinquency factor");
  assert.deepEqual(hmdaDenialReasons(reasons).codes, [1, 3]);
  assert.ok(reasons.every((r) => !/Refer with Caution/i.test(r.statement_text)));
  assert.throws(() => selectPrincipalReasons([{ rule_id: "du_recommendation", description: "DU Refer with Caution", threshold: null, observed: "refer_with_caution", applicant_ids: ["B1"], evidence_document_ids: [], failed: true, reason_code: "other_specific", other_text: "DU returned Refer with Caution" }], { reviewer_signed_other_text: true }), /not a permissible reason/);
  const h = harness("APP-REFI-1", "2026-10-05T17:14:00.000Z"); await deniedRefi(h);
  const sel = await h.run("selectPrincipalReasons", { factors: FACTORS });
  assert.deepEqual(sel.hmda_denial_codes, [1, 3]); assert.equal(sel.count, 2);
  await refused(h.run("selectPrincipalReasons", { factors: FACTORS, free_text: "Refer with Caution" }), "REASON_OUTSIDE_TAXONOMY");
  await refused(h.run("selectPrincipalReasons", { factors: FACTORS, free_text: "DU Refer with Caution", reviewer_signed_other_text: true }), "PROHIBITED_REASON");
  const r = await h.run("renderNotice", { decision_id: "D-1", score_payloads: [SCORES_B1], notice_date: "2026-10-26" });
  const text = h.text((r.notice_ids as Record<string, string>).B1!);
  assert.match(text, /Excessive obligations in relation to income/); assert.match(text, /Delinquent past or present credit obligations with others/); assert.doesNotMatch(text, /Refer with Caution/i); assert.doesNotMatch(text, /internal standards|qualifying score/i);
  assert.equal(r.checklist_passed, true);
  h.at("2026-10-26T18:30:00.000Z"); const sent = await h.run("deliverNotice", { decision_id: "D-1", notice_ids: r.notice_ids, score_payloads: [SCORES_B1] });
  assert.deepEqual((sent.hmda as { action_taken: number; denial_reasons: number[] }).denial_reasons, [1, 3]); assert.equal((sent.hmda as { action_taken: number }).action_taken, 3);
  assert.deepEqual(h.file().adverse_actions[0]!.principal_reasons.map((x) => x.reason_code), ["dti_excessive", "credit_delinquent"]);
});

test("21.6-T3: Given a denial recommendation without a reviewer decision, when `deliverNotice` is called, then it is refused; after `underwriting_reviewer` approval the notice sends and `adverse_actions.approved_by_reviewer_at` is set before `sent_at`.", async () => {
  const h = harness("APP-REFI-1", "2026-10-05T17:14:00.000Z");
  received(h, { id: "APP-REFI-1", tz: MST, state: "AZ", at: "2026-10-05T17:16:00.000Z" });
  h.at("2026-10-23T16:40:00.000Z"); const rec = await h.run("recommendDisposition", { ...REFI, decision_id: "D-1", factors: FACTORS, du_recommendation: "refer_with_caution", data_verified_and_resubmitted: true });
  assert.equal(rec.kind, "denial"); assert.equal(rec.sla_due_on, "2026-10-27", "Fri Oct 23 + 2 creditor business days"); assert.ok(rec.escalation_id);
  assert.equal(h.timer("SM_UNDERWRITING_REVIEWER_SLA_2BD")!.dueDate, "2026-10-27"); assert.equal(h.esc(rec.escalation_id as string).ownerRole, "underwriting_reviewer");
  // without the reviewer's decision the send is refused (and the guardrail form of the same rule)
  await assert.rejects(h.run("deliverNotice", { decision_id: "D-1", notice_id: "N-early", score_payloads: [SCORES_B1] }), /REVIEWER_REQUIRED/);
  await refused(h.run("deliverNotice", { decision_id: "D-1", notice_id: "N-early", reviewer_decided_at: null }), "REVIEWER_REQUIRED");
  assert.equal(h.ofType("notice.adverse_action.sent").length, 0); assert.equal(h.file().adverse_actions.length, 0);
  // the agent may not decide the review; the underwriting_reviewer does (Mon Oct 26 11:05 MST)
  await refused(h.run("openReviewerEscalation", { op: "decide", decision_id: "D-1", outcome: "approved" }), "REVIEWER_DECIDES");
  h.at("2026-10-26T18:05:00.000Z"); const rev = await h.run("openReviewerEscalation", { op: "decide", decision_id: "D-1", outcome: "approved" }, REVIEWER);
  assert.equal(rev.reviewer_decided_at, "2026-10-26T18:05:00.000Z"); assert.equal(rev.reviewer_id, "u-uwr-1"); assert.equal(h.timer("SM_UNDERWRITING_REVIEWER_SLA_2BD")!.status, "satisfied");
  const r = await h.run("renderNotice", { decision_id: "D-1", score_payloads: [SCORES_B1], notice_date: "2026-10-26" });
  h.at("2026-10-26T18:30:00.000Z"); const sent = await h.run("deliverNotice", { decision_id: "D-1", notice_ids: r.notice_ids, score_payloads: [SCORES_B1] });
  assert.equal(sent.approved_by_reviewer_at, "2026-10-26T18:05:00.000Z"); assert.equal(sent.sent_at, "2026-10-26T18:30:00.000Z");
  const aa = h.rt.store.get("adverse_actions", "AA-D-1")!.data as { approved_by_reviewer_at: string; sent_at: string; approving_reviewer_id: string };
  assert.ok(Date.parse(aa.approved_by_reviewer_at) < Date.parse(aa.sent_at)); assert.equal(aa.approving_reviewer_id, "u-uwr-1");
  assert.equal(h.ofType("notice.sent").length, 1); assert.equal(sent.lock_cancellation_reason, "lender_declination"); assert.equal(h.file().disposition, "denied");
});

test("21.6-T4: Given two applicants with representative scores 712 (Experian/Fair Isaac V2) and 688, then two notices issue, each with only that applicant's score, range 300–850, ≤ 4 key factors (5 if inquiries), score date and provider, the three CRAs' contact blocks, and the FTC address in the ECOA notice.", async () => {
  // 22.2's tri-merge report → scoreDisclosurePayloads: one payload per borrower (only that borrower's scores); B's representative score 688 carries inquiries as a key factor
  const report = { report_id: "CR-1", application_id: "APP-PURCH-1", score_model: "classic_fico", report_date: D("2026-10-20"), borrower_applicable_scores: { A: 712, B: 688 }, cra: { name: "Reseller", address: "x", phone: "y" },
    borrowers: [{ borrower_id: "A", returned: ["efx", "exp", "tu"], frozen: [], scores: { efx: { score: 705, model_version: "Equifax Beacon 5.0", key_factors: ["Serious delinquency"] }, exp: { score: 712, model_version: "Experian/Fair Isaac Risk Model V2", key_factors: ["Proportion of balances to credit limits on revolving accounts is too high", "Serious delinquency", "Too many accounts with balances", "Length of time accounts have been established"] }, tu: { score: 720, model_version: "TransUnion FICO Risk Score, Classic 04", key_factors: ["Serious delinquency"] } } },
      { borrower_id: "B", returned: ["efx", "exp", "tu"], frozen: [], scores: { efx: { score: 688, model_version: "Equifax Beacon 5.0", key_factors: ["Too many inquiries in the last 12 months", "Length of time accounts have been established", "Too few accounts currently paid as agreed", "Amount owed on accounts is too high", "Proportion of loan balances to loan amounts is too high", "Sixth factor never disclosed"], inquiries_key_factor: true }, exp: { score: 671, model_version: "Experian/Fair Isaac Risk Model V2", key_factors: ["Serious delinquency"] }, tu: { score: 690, model_version: "TransUnion FICO Risk Score, Classic 04", key_factors: ["Serious delinquency"] } } }] } as unknown as CreditReport;
  const payloads = scoreDisclosurePayloads(report);
  const blocks = payloads.map((p) => assembleFcraBlock({ ...p, scores: p.scores.map((s) => ({ ...s, key_factors: (report.borrowers.find((b) => b.borrower_id === p.borrower_id)!.scores as Record<string, { key_factors: string[] }>)[s.repository]!.key_factors })) }));
  const a = blocks.find((b) => b.applicant_id === "A")!, b = blocks.find((x) => x.applicant_id === "B")!;
  assert.equal(a.score, 712); assert.equal(a.score_provider, "Classic FICO — Experian/Fair Isaac Risk Model V2"); assert.equal(a.bureau, "Experian"); assert.equal(a.score_date, "2026-10-05".replace("05", "20")); assert.equal(a.key_factor_count, 4); assert.equal(a.score_range_low, 300); assert.equal(a.score_range_high, 850);
  assert.equal(b.score, 688); assert.equal(b.bureau, "Equifax"); assert.equal(b.inquiries_key_factor, true); assert.equal(b.key_factor_count, 5, "5 key factors when the number of inquiries is one (§1681g(f)(9))"); assert.ok(!b.key_factors.includes("Sixth factor never disclosed"));
  assert.deepEqual(a.cra.map((c) => c.name), ["Equifax", "Experian", "TransUnion"]); assert.ok(a.cra.every((c) => /P\.O\. Box/.test(c.address) && /^1-8/.test(c.toll_free)));
  // two notices, each with only that applicant's score
  const h = harness("APP-PURCH-1", "2026-10-19T22:40:00.000Z");
  received(h, { id: "APP-PURCH-1", tz: EST, state: "OH", at: "2026-10-19T22:45:00.000Z", channel: "web", transaction_type: "purchase" });
  h.at("2026-11-02T15:00:00.000Z"); await h.run("recommendDisposition", { ...PURCHASE, decision_id: "D-P1", factors: [{ ...FACTORS[0]!, applicant_ids: ["A", "B"] }], data_verified_and_resubmitted: true });
  h.at("2026-11-03T15:00:00.000Z"); await h.run("openReviewerEscalation", { op: "decide", decision_id: "D-P1", outcome: "approved" }, REVIEWER);
  await refused(h.run("assembleFcraBlock", { score_payloads: payloads, include_other_applicants: true }), "ONE_APPLICANTS_SCORE");
  const r = await h.run("renderNotice", { decision_id: "D-P1", fcra_blocks: blocks, notice_date: "2026-11-03" });
  const ids = r.notice_ids as Record<string, string>; assert.equal(Object.keys(ids).length, 2); assert.equal(r.per_applicant, 2); assert.equal(r.checklist_passed, true);
  const ta = h.text(ids.A!), tb = h.text(ids.B!);
  assert.match(ta, /Your credit score: 712\./); assert.doesNotMatch(ta, /688/); assert.match(tb, /Your credit score: 688\./); assert.doesNotMatch(tb, /712/);
  for (const t of [ta, tb]) { assert.match(t, /Scores range from a low of 300 to a high of 850/); assert.match(t, /Date the score was created: October 20, 2026/); assert.match(t, /Equifax, P\.O\. Box 740241[\s\S]*Experian, P\.O\. Box 2002[\s\S]*TransUnion, P\.O\. Box 1000/); assert.match(t, /Federal Trade Commission, Consumer Response Center, 600 Pennsylvania Avenue NW, Washington, DC 20580/); assert.match(t, /Federal Equal Credit Opportunity Act prohibits creditors from discriminating/); }
  assert.match(ta, /Score provider: Classic FICO — Experian\/Fair Isaac Risk Model V2/); assert.match(tb, /Score provider: Classic FICO — Equifax Beacon 5\.0/);
  assert.equal((tb.match(/Key factors that adversely affected your credit score: ((?:[^;]+; ){5})/) ?? [])[1]?.split("; ").filter(Boolean).length, 5);
  h.at("2026-11-03T16:00:00.000Z"); const sent = await h.run("deliverNotice", { decision_id: "D-P1", notice_ids: ids, fcra_blocks: blocks });
  assert.equal(sent.sent, true); assert.deepEqual(h.file().adverse_actions[0]!.per_applicant.map((p) => [p.applicant_id, p.fcra_block!.score]), [["A", 712], ["B", 688]]);
  assert.equal(FEDERAL_AGENCY_BLOCKS.ftc.address, "Consumer Response Center, 600 Pennsylvania Avenue NW, Washington, DC 20580");
});

test("21.6-T5: Given an NOIA sent Tue Oct 27, 2026 with a 14-day period, then `response_due_on` = Tue Nov 10, 2026; with no response, on Wed Nov 11 the file closes with HMDA code 5 and `action_taken_date` 2026-11-11 and no Reg B notice is required.", async () => {
  const h = harness("APP-PURCH-1", "2026-10-19T22:40:00.000Z");
  received(h, { id: "APP-PURCH-1", tz: EST, state: "OH", at: "2026-10-19T22:45:00.000Z", channel: "web", transaction_type: "purchase" });
  assert.equal(h.timer("REGB_1002_9_DECISION_30")!.dueDate, "2026-11-18", "Mon Oct 19 + 30");
  // 22.1's needs_list.noia.recommended payload (the 2025 returns and YTD P&L outstanding after two reminders and an oral request Oct 23) → NOIA recommendation Mon Oct 26
  h.at("2026-10-26T14:00:00.000Z");
  const rec = await h.run("recommendDisposition", { ...PURCHASE, decision_id: "D-N1", factors: [], noia_recommendation: { missing: [{ request_id: "R-1", doc_class: "tax_returns_2025", reason_text: "Signed 2025 federal tax returns for the self-employed co-borrower (all schedules)" }, { request_id: "R-2", doc_class: "ytd_pl", reason_text: "Year-to-date profit and loss statement for the co-borrower's business" }], hand_off: "21.6", response_period_days: 14 } });
  assert.equal(rec.kind, "incomplete"); assert.ok(rec.escalation_id);
  h.at("2026-10-27T14:00:00.000Z"); await h.run("openReviewerEscalation", { op: "decide", decision_id: "D-N1", outcome: "approved" }, REVIEWER);
  const items = [{ item: "tax_returns_2025", description: "Signed 2025 federal tax returns for the self-employed co-borrower (all schedules)" }, { item: "ytd_pl", description: "Year-to-date profit and loss statement for the co-borrower's business" }];
  const r = await h.run("renderNotice", { decision_id: "D-N1", noia_id: "NOIA-1", items_needed: items, designated_period_days: 14, oral_request_at: "2026-10-23T15:00:00.000Z", notice_date: "2026-10-27" });
  assert.equal(r.template, NOTICE_CODES_21_6.noia); assert.match(h.text((r.notice_ids as Record<string, string>).A!), /will result in no further consideration being given to the application/); assert.match(h.text((r.notice_ids as Record<string, string>).A!), /by November 10, 2026/);
  h.at("2026-10-27T15:00:00.000Z"); const sent = await h.run("deliverNotice", { op: "noia", decision_id: "D-N1", noia_id: "NOIA-1", notice_ids: r.notice_ids, items_needed: items, designated_period_days: 14, oral_request_at: "2026-10-23T15:00:00.000Z" });
  assert.equal(sent.sent_on, "2026-10-27"); assert.equal(sent.response_due_on, "2026-11-10"); assert.equal(sent.disposition, "incomplete_noia_sent");
  assert.equal(h.timer("REGB_1002_9C2_NOIA_RESPONSE")!.dueDate, "2026-11-10"); assert.equal(h.timer("REGB_1002_9_DECISION_30")!.status, "satisfied", "the written NOIA is the §1002.9(c)(1) notification");
  assert.equal((h.rt.store.get("noias", "NOIA-1")!.data as { response_due_on: string }).response_due_on, "2026-11-10");
  // the period runs through Nov 10; closing on Nov 10 is refused, Wed Nov 11 closes the file: HMDA 5 / 2026-11-11, no Reg B notice
  await assert.rejects(h.run("writeDecision", { op: "close_incomplete", noia_id: "NOIA-1", at: "2026-11-10T20:00:00.000Z" }), /designated period runs through 2026-11-10/);
  h.at("2026-11-11T14:00:00.000Z"); const closed = await h.run("writeDecision", { op: "close_incomplete", noia_id: "NOIA-1" });
  assert.equal(closed.closed_on, "2026-11-11"); assert.deepEqual(closed.hmda, { action_taken: 5, action_taken_date: "2026-11-11", denial_reasons: [], denial_reason_other_text: null, basis: "file closed for incompleteness: §1002.9(c)(2) notice sent, no response within the period; date = closure (comment 4(a)(8)(i)-6)" });
  assert.equal(closed.regb_notice_required, false); assert.equal(closed.disposition, "closed_incomplete"); assert.equal(h.ofType("notice.adverse_action.sent").length, 0);
  assert.equal(h.ofType("application.closed_incomplete")[0]!.payload.lock_cancellation_reason, "borrower_withdrawal"); assert.equal((h.rt.store.get("hmda_records", "APP-PURCH-1")!.data as { action_taken: number }).action_taken, 5);
  assert.equal(h.timers.evaluate("2026-11-11T14:00:00.000Z").some((b) => b.def.code === "REGB_1002_9C2_NOIA_RESPONSE"), true, "the borrower's clock breaches into the closure");
  // (a) alternative: returns arrive Thu Oct 29 → the re-anchored due (Nov 28) never extends the conservative Nov 18 clock
  const h2 = harness("APP-PURCH-1", "2026-10-19T22:40:00.000Z"); received(h2, { id: "APP-PURCH-1", tz: EST, state: "OH", at: "2026-10-19T22:45:00.000Z", channel: "web", transaction_type: "purchase" });
  h2.at("2026-10-26T14:00:00.000Z"); await h2.run("recommendDisposition", { ...PURCHASE, decision_id: "D-N1", factors: [], missing_items: items });
  h2.at("2026-10-27T14:00:00.000Z"); await h2.run("openReviewerEscalation", { op: "decide", decision_id: "D-N1", outcome: "approved" }, REVIEWER);
  h2.at("2026-10-27T15:00:00.000Z"); await h2.run("deliverNotice", { op: "noia", decision_id: "D-N1", noia_id: "NOIA-1", notice_id: "N-noia", items_needed: items });
  h2.at("2026-10-29T15:00:00.000Z"); const resp = await h2.run("writeDecision", { op: "noia_response", noia_id: "NOIA-1" });
  assert.equal(resp.decision_due_on, "2026-11-18"); assert.equal(h2.timer("REGB_1002_9C2_NOIA_RESPONSE")!.status, "satisfied"); assert.equal(h2.ofType("noia.responded")[0]!.payload.reanchored_due_on, "2026-11-28");
});

test("21.6-T6: Given a C-4 combined counteroffer notice sent Tue Nov 3, 2026 expiring Wed Nov 18 with no acceptance, then no second notice is sent, HMDA code 3 on the original terms with date 2026-11-18 and reason 4; `REGB_1002_9_COUNTEROFFER_90` (due Mon Feb 1, 2027) is marked satisfied by the combined notice.", async () => {
  assert.deepEqual(counterofferClock(D("2026-11-03"), D("2026-11-18")), { adverse_notice_due_on: D("2027-02-01"), policy_send_on: D("2026-11-18"), expires_on: D("2026-11-18") });
  const h = harness("APP-PURCH-1", "2026-10-19T22:40:00.000Z");
  received(h, { id: "APP-PURCH-1", tz: EST, state: "OH", at: "2026-10-19T22:45:00.000Z", channel: "web", transaction_type: "purchase" });
  // appraisal Mon Nov 2 at $445,000: LTV on $412,000 = 92.6 % > the 90 % structure → counteroffer at $400,500 (90 % of $445,000), same rate
  const collateral: DecisionFactor = { rule_id: "ltv_max", description: "Loan-to-value above the 90 % structure the borrower qualified for", threshold: "90.0", observed: ltvPercent(41_200_000n, 44_500_000n), applicant_ids: ["A", "B"], evidence_document_ids: ["doc-appraisal-1102"], failed: true, source: "valuation" };
  h.at("2026-11-02T20:00:00.000Z");
  const rec = await h.run("recommendDisposition", { ...PURCHASE, decision_id: "D-C1", factors: [collateral], counteroffer_terms: { loan_amount_cents: loanAmountAtLtv(44_500_000n, 90), note_rate: "6.125", product_code: "FNMA30_HOMEREADY", ltv: "90.0", conditions: ["Mortgage insurance at 25 % coverage"], expires_on: "2026-11-18" } });
  assert.equal(rec.kind, "counteroffer");
  h.at("2026-11-03T14:00:00.000Z"); await h.run("openReviewerEscalation", { op: "decide", decision_id: "D-C1", outcome: "approved" }, REVIEWER);
  const r = await h.run("renderNotice", { decision_id: "D-C1", score_payloads: [{ ...SCORES_B1, borrower_id: "A" }], notice_date: "2026-11-03", combined_notice: true });
  assert.equal(r.template, NOTICE_CODES_21_6.counteroffer); const text = h.text((r.notice_ids as Record<string, string>).A!);
  assert.match(text, /\$400,500\.00 at a note rate of 6\.125 %/); assert.match(text, /expires on November 18, 2026/); assert.match(text, /no further notice will be sent/); assert.match(text, /Value or type of collateral not sufficient/);
  h.at("2026-11-03T15:00:00.000Z"); const sent = await h.run("deliverNotice", { decision_id: "D-C1", notice_ids: r.notice_ids, score_payloads: [{ ...SCORES_B1, borrower_id: "A" }], combined_notice: true, expires_on: "2026-11-18" });
  assert.equal(sent.combined_notice, true); assert.equal(sent.disposition, "counteroffer_pending"); assert.equal(sent.hmda, null, "a pending counteroffer has no action taken yet");
  const t = h.timer("REGB_1002_9_COUNTEROFFER_90")!; assert.equal(t.dueDate, "2027-02-01", "Nov 3 + 90"); assert.equal(t.status, "satisfied", "satisfied by the combined C-4 notice (comment 9(a)(1)-6)");
  assert.equal(h.ofType("counteroffer.resolved")[0]!.payload.outcome, "combined_notice_sent"); assert.equal(h.ofType("notice.adverse_action.sent").length, 1);
  // no acceptance by Nov 18: no second notice, HMDA 3 on the original terms, date = the expiry, reason 4
  await assert.rejects(h.run("writeDecision", { op: "counteroffer_expire", decision_id: "D-C1", at: "2026-11-17T15:00:00.000Z" }), /open until 2026-11-18/);
  h.at("2026-11-18T22:00:00.000Z"); const exp = await h.run("writeDecision", { op: "counteroffer_expire", decision_id: "D-C1" });
  assert.equal(exp.second_notice_required, false); assert.deepEqual(exp.hmda, { action_taken: 3, action_taken_date: "2026-11-18", denial_reasons: [4], denial_reason_other_text: null, basis: "denied on the original terms: combined C-4 notice; date = counteroffer expiry (comment 4(a)(8)(i)-9)" });
  assert.equal(exp.disposition, "denied"); assert.equal(h.ofType("notice.adverse_action.sent").length, 1, "no second notice"); assert.equal(h.ofType("notice.sent").length, 1);
  assert.equal(h.file().adverse_actions[0]!.kind, "counteroffer_not_accepted");
  // (a) alternative: express acceptance Wed Nov 4 by e-signature → the application proceeds on $400,500
  const h2 = harness("APP-PURCH-1", "2026-10-19T22:40:00.000Z"); received(h2, { id: "APP-PURCH-1", tz: EST, state: "OH", at: "2026-10-19T22:45:00.000Z", channel: "web", transaction_type: "purchase" });
  h2.at("2026-11-02T20:00:00.000Z"); await h2.run("recommendDisposition", { ...PURCHASE, decision_id: "D-C1", factors: [collateral], counteroffer_terms: { loan_amount_cents: 40_050_000n, note_rate: "6.125", product_code: "FNMA30_HOMEREADY", ltv: "90.0", conditions: [], expires_on: "2026-11-18" } });
  h2.at("2026-11-03T14:00:00.000Z"); await h2.run("openReviewerEscalation", { op: "decide", decision_id: "D-C1", outcome: "approved" }, REVIEWER);
  h2.at("2026-11-03T15:00:00.000Z"); await h2.run("deliverNotice", { decision_id: "D-C1", notice_id: "N-c4", score_payloads: [{ ...SCORES_B1, borrower_id: "A" }], combined_notice: true });
  h2.at("2026-11-04T15:00:00.000Z"); const acc = await h2.run("writeDecision", { op: "counteroffer_accept", decision_id: "D-C1", method: "esignature" });
  assert.equal(acc.disposition, "counteroffer_accepted"); assert.equal(h2.file().original_terms!.loan_amount_cents, 40_050_000n); assert.equal(h2.ofType("counteroffer.accepted").length, 1);
});

test("21.6-T7: Given a counteroffer notice without combined content sent Fri Oct 30, 2026 and no acceptance, then an adverse action notice must be sent by Thu Jan 28, 2027 (policy: at the counteroffer's own expiry) and HMDA code 3 is recorded with that notice date.", async () => {
  assert.equal(counterofferClock(D("2026-10-30"), null).adverse_notice_due_on, "2027-01-28", "Oct 30 + 90"); assert.equal(counterofferClock(D("2026-10-30"), null).expires_on, "2026-11-14", "policy default 15 days");
  const h = harness("APP-PURCH-1", "2026-10-19T22:40:00.000Z");
  received(h, { id: "APP-PURCH-1", tz: EST, state: "OH", at: "2026-10-19T22:45:00.000Z", channel: "web", transaction_type: "purchase" });
  const collateral: DecisionFactor = { rule_id: "ltv_max", description: "Loan-to-value above the 90 % structure", threshold: "90.0", observed: "92.6", applicant_ids: ["A"], evidence_document_ids: ["doc-appraisal"], failed: true, source: "valuation" };
  h.at("2026-10-29T20:00:00.000Z"); await h.run("recommendDisposition", { ...PURCHASE, decision_id: "D-C2", factors: [collateral], counteroffer_terms: { loan_amount_cents: 40_050_000n, note_rate: "6.125", product_code: "FNMA30_HOMEREADY", ltv: "90.0", conditions: [], expires_on: "2026-11-14" } });
  h.at("2026-10-30T14:00:00.000Z"); await h.run("openReviewerEscalation", { op: "decide", decision_id: "D-C2", outcome: "approved" }, REVIEWER);
  const r = await h.run("renderNotice", { decision_id: "D-C2", notice_date: "2026-10-30", combined_notice: false }); assert.match(h.text((r.notice_ids as Record<string, string>).A!), /we will send you a separate notice/);
  h.at("2026-10-30T15:00:00.000Z"); const sent = await h.run("deliverNotice", { decision_id: "D-C2", notice_ids: r.notice_ids, combined_notice: false });
  assert.equal(sent.combined_notice, false); assert.equal(h.timer("REGB_1002_9_COUNTEROFFER_90")!.dueDate, "2027-01-28"); assert.equal(h.timer("REGB_1002_9_COUNTEROFFER_90")!.status, "armed", "not satisfied without the combined content");
  assert.equal(h.ofType("decision.issued")[0]!.payload.adverse_notice_due_on, "2027-01-28");
  // the counteroffer expires by its own terms Sat Nov 14: a second (adverse action) notice is required — due by Jan 28, sent at the expiry by policy
  h.at("2026-11-14T15:00:00.000Z"); const exp = await h.run("writeDecision", { op: "counteroffer_expire", decision_id: "D-C2" });
  assert.equal(exp.second_notice_required, true); assert.equal(exp.adverse_notice_due_on, "2027-01-28"); assert.equal(exp.policy_send_on, "2026-11-14"); assert.equal(exp.hmda, null); assert.equal(exp.disposition, "counteroffer_pending");
  const r2 = await h.run("renderNotice", { decision_id: "D-C2", notice_date: "2026-11-14", combined_notice: false });
  h.at("2026-11-14T16:00:00.000Z"); const aa = await h.run("deliverNotice", { op: "after_counteroffer", decision_id: "D-C2", notice_ids: r2.notice_ids });
  assert.deepEqual(aa.hmda, { action_taken: 3, action_taken_date: "2026-11-14", denial_reasons: [4], denial_reason_other_text: null, basis: "denied on the original terms: date = adverse action notice (comment 4(a)(8)(i)-9)" });
  assert.equal(aa.disposition, "denied"); assert.equal(h.timer("REGB_1002_9_COUNTEROFFER_90")!.status, "satisfied"); assert.equal(h.ofType("counteroffer.resolved").at(-1)!.payload.outcome, "adverse_action_sent");
  assert.equal(h.ofType("notice.adverse_action.sent").length, 2); assert.equal(h.file().adverse_actions[0]!.kind, "denial_after_counteroffer");
  // the legal outer bound: a notice after Jan 28, 2027 is refused
  const late = newDecisionFile({ ...PURCHASE, application_id: "APP-PURCH-1" });
  assert.throws(() => hmdaActionFor({ kind: "counteroffer_not_accepted", combined_notice: false, expires_on: D("2026-11-14"), adverse_notice_sent_on: null, reasons: [] }), /needs the adverse action notice date/); void late;
});

test("21.6-T8: Given the borrower says \"I'm going with another lender\" by voice on Fri Oct 16, 2026 before any decision, then `withdrawals.express=true`, HMDA code 4 with date 2026-10-16, no Reg B notice, and 21.4 cancels the lock as `borrower_withdrawal`.", async () => {
  assert.equal(isExpressWithdrawal("I'm going with another lender"), true); assert.equal(isExpressWithdrawal("I'll think about it"), false);
  const h = harness("APP-REFI-1", "2026-10-05T17:14:00.000Z");
  received(h, { id: "APP-REFI-1", tz: MST, state: "AZ", at: "2026-10-05T17:16:00.000Z" });
  h.rt.store.put("locks", "LK-1", minimalLock("APP-REFI-1") as unknown as Record<string, unknown>, UW, "2026-10-07T17:19:00.000Z");
  h.at("2026-10-16T17:30:00.000Z");
  const w = await h.run("writeDecision", { ...REFI, op: "withdrawal", withdrawal_id: "W-1", statement_text: "I'm going with another lender", channel: "voice", evidence_document_id: null });
  assert.equal(w.express, true); assert.equal(w.received_on, "2026-10-16"); assert.equal(w.regb_notice_required, false); assert.equal(w.lock_cancellation_reason, "borrower_withdrawal"); assert.equal(w.disposition, "withdrawn");
  assert.deepEqual(w.hmda, { action_taken: 4, action_taken_date: "2026-10-16", denial_reasons: [], denial_reason_other_text: null, basis: "withdrawn by applicant: express withdrawal before a credit decision; date = received (comment 4(a)(8)(ii)-3)" });
  const row = h.rt.store.get("withdrawals", "W-1")!.data as { express: boolean; statement_text: string; channel: string; after_decision: boolean }; assert.equal(row.express, true); assert.equal(row.statement_text, "I'm going with another lender"); assert.equal(row.channel, "voice"); assert.equal(row.after_decision, false);
  assert.equal(h.ofType("application.withdrawn")[0]!.payload.express, true); assert.equal(h.ofType("notice.adverse_action.sent").length, 0); assert.equal(h.ofType("noia.sent").length, 0);
  assert.equal(h.timer("REGB_1002_9_DECISION_30")!.status, "satisfied", "`application.withdrawn` closes the 30-day clock (decision.issued{kind=withdrawal})");
  assert.equal((h.rt.store.get("hmda_records", "APP-REFI-1")!.data as { action_taken: number; action_taken_date: string }).action_taken_date, "2026-10-16");
  // 21.4's cancelLock: `lock.cancelled{reason=borrower_withdrawal}`, no pair-off
  const c = await h.run("cancelLock", {});
  assert.equal(c.reason, "borrower_withdrawal"); assert.equal(c.status, "cancelled"); assert.equal(c.pair_off, false);
  const lc = h.ofType("lock.cancelled")[0]!; assert.equal(lc.payload.reason, "borrower_withdrawal"); assert.equal(lc.payload.lock_id, "LK-1"); assert.equal(lc.applicationId, "APP-REFI-1");
  // a second withdrawal or a later decision is refused: exactly one terminal disposition
  await assert.rejects(h.run("writeDecision", { op: "withdrawal", withdrawal_id: "W-2", statement_text: "withdraw", channel: "chat" }), /one terminal disposition/);
});

test("21.6-T9: Given 21 days of silence on an incomplete file with no NOIA sent, then the agent may not record a withdrawal; it must send the NOIA by day 30 or deny for incompleteness (only if data is insufficient).", async () => {
  const h = harness("APP-REFI-1", "2026-10-05T17:14:00.000Z");
  received(h, { id: "APP-REFI-1", tz: MST, state: "AZ", at: "2026-10-05T17:16:00.000Z" });
  // day 21 (Mon Oct 26): only the credit report is in; the completion checkpoint arms REGB_1002_9_NOIA (due Nov 4)
  h.at("2026-10-26T17:00:00.000Z");
  const c = await h.run("computeCompletion", { ...REFI, received: { credit_report: "2026-10-05T18:00:00.000Z" } });
  assert.equal(c.completed_application_at, null); assert.equal(c.checkpoint_day, 21); assert.equal(c.noia_checkpoint_reached, true); assert.ok((c.outstanding as string[]).includes("income_verification"));
  assert.equal(h.timer("REGB_1002_9_NOIA")!.dueDate, "2026-11-04"); assert.equal(h.timer("REGB_1002_9_NOIA")!.status, "armed");
  const s = await h.run("trackDecisionClock", { op: "silence", now: "2026-10-26T17:00:00.000Z" });
  assert.equal(s.days_silent, 21); assert.equal(s.withdrawal_permitted, false); assert.equal(s.required_action, "send_noia"); assert.equal(s.send_noia_by, "2026-11-04"); assert.equal(s.deny_for_incompleteness_allowed, true, "data insufficient for a decision (comment 9(a)(1)-3)");
  // silence is never a withdrawal — the guardrail, the rule and the HMDA mapping all refuse
  await refused(h.run("writeDecision", { op: "withdrawal", withdrawal_id: "W-x", statement_text: "no response for 21 days", channel: "system", silence: true }), "SILENCE_NOT_WITHDRAWAL");
  await assert.rejects(h.run("writeDecision", { op: "withdrawal", withdrawal_id: "W-x", statement_text: "no response for 21 days", channel: "system" }), /not an express withdrawal/);
  assert.throws(() => recordWithdrawal(h.events, h.file(), { withdrawal_id: "W-x", statement_text: "", channel: "system", received_at: "2026-10-26T17:00:00.000Z" }), /statement_text/);
  assert.throws(() => hmdaActionFor({ kind: "withdrawal", express: false, received_on: D("2026-10-26"), after_decision: false }), /requires an express withdrawal/);
  await refused(h.run("recordHmdaAction", { case: { kind: "withdrawal", express: false, received_on: "2026-10-26", after_decision: false } }), "HMDA_4_NEEDS_EXPRESS_WITHDRAWAL");
  await refused(h.run("recommendDisposition", { decision_id: "D-x", factors: [], silence_as_withdrawal: true }), "SILENCE_NOT_A_DISPOSITION");
  assert.equal(h.file().withdrawals.length, 0); assert.equal(h.file().disposition, "open");
  // the written NOIA (reviewer-approved) by day 30 satisfies REGB_1002_9_NOIA; a denial for incompleteness is allowed only while the data are insufficient
  h.at("2026-10-27T17:00:00.000Z"); await h.run("recommendDisposition", { decision_id: "D-N", factors: [], missing_items: [{ item: "income_verification", description: "Two most recent paystubs and the 2025 W-2" }] });
  h.at("2026-10-28T17:00:00.000Z"); await h.run("openReviewerEscalation", { op: "decide", decision_id: "D-N", outcome: "approved" }, REVIEWER);
  h.at("2026-10-28T18:00:00.000Z"); const n = await h.run("deliverNotice", { op: "noia", decision_id: "D-N", noia_id: "NOIA-R", notice_id: "N-noia", items_needed: [{ item: "income_verification", description: "Two most recent paystubs and the 2025 W-2" }] });
  assert.equal(n.response_due_on, "2026-11-11"); assert.equal(h.timer("REGB_1002_9_NOIA")!.status, "satisfied"); assert.equal(h.timer("REGB_1002_9_DECISION_30")!.status, "satisfied");
  const complete = newDecisionFile({ ...REFI, application_id: "APP-REFI-1" });
  assert.equal(silenceAssessment({ ...complete, completed_application_at: "2026-10-20T00:00:00.000Z" }, "2026-10-26T17:00:00.000Z").deny_for_incompleteness_allowed, false, "comment 9(a)(1)-4: with sufficient data, incompleteness cannot be the reason");
  assert.equal(ECOA_REASONS.incomplete!.hmda_denial_code, 7);
});

test("21.6-T10: Given a Colorado property and a denial decided Tue Jan 12, 2027 materially influenced by the underwriting ADMT, then `CO_SB26_189_1704_ADVERSE_EXPLANATION_30` is due Thu Feb 11, 2027, the notice sent Jan 14 carries the ADMT role description, human-review and correction instructions, and a human-review request on Jan 20 is completed by a different reviewer by Fri Feb 19, 2027.", async () => {
  assert.equal(coExplanationDue(D("2027-01-12")), "2027-02-11"); assert.equal(CO_SB26_189_EFFECTIVE_FROM, "2027-01-01");
  const CO = { ...REFI, partner_address: "100 Partner Plaza, Denver, CO 80202", creditor_time_zone: "America/Denver", application_date: "2026-12-14", property_state: "CO", admt_materially_influenced: true };
  const h = harness("APP-CO-1", "2026-12-14T17:00:00.000Z");
  received(h, { id: "APP-CO-1", tz: "America/Denver", state: "CO", at: "2026-12-14T17:16:00.000Z" });
  assert.equal(h.timer("CO_SB26_189_1704_PREUSE_NOTICE_GATE")!.status, "armed", "the pre-use gate arms on the Colorado application");
  h.at("2027-01-11T17:00:00.000Z"); await h.run("recommendDisposition", { ...CO, decision_id: "D-CO", factors: FACTORS, du_recommendation: "refer_with_caution", data_verified_and_resubmitted: true });
  h.at("2027-01-12T17:05:00.000Z"); const rev = await h.run("openReviewerEscalation", { op: "decide", decision_id: "D-CO", outcome: "approved" }, REVIEWER);
  assert.equal(rev.decided_at, "2027-01-12T17:05:00.000Z");
  const t = h.timer("CO_SB26_189_1704_ADVERSE_EXPLANATION_30")!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2027-02-11", "Jan 12 + 30");
  assert.equal(h.timer("CO_SB26_189_1703_RECORDS_3Y"), undefined, "the records gate arms on the issued decision");
  const ov = await h.run("assembleStateOverlays", { decided_on: "2027-01-12" });
  assert.equal(ov.co_duties_apply, true); assert.equal(ov.explanation_due_on, "2027-02-11"); assert.match(ov.admt_role_description as string, /An automated underwriting system evaluated your application against Partner Bank's credit standards; a licensed underwriter reviewed and approved the decision\./);
  const r = await h.run("renderNotice", { decision_id: "D-CO", score_payloads: [SCORES_B1], notice_date: "2027-01-14" });
  const text = h.text((r.notice_ids as Record<string, string>).B1!);
  assert.match(text, /Colorado notice \(C\.R\.S\. 6-1-1704 and 6-1-1705\)/); assert.match(text, /automated underwriting system evaluated your application/); assert.match(text, /request meaningful human review and reconsideration of this decision by a different underwriter/); assert.match(text, /correct any factually incorrect or materially inaccurate personal data/);
  h.at("2027-01-14T17:00:00.000Z"); const sent = await h.run("deliverNotice", { decision_id: "D-CO", notice_ids: r.notice_ids, score_payloads: [SCORES_B1] });
  assert.equal(sent.co_explanation_sent_at, "2027-01-14T17:00:00.000Z"); assert.equal(h.timer("CO_SB26_189_1704_ADVERSE_EXPLANATION_30")!.status, "satisfied"); assert.equal(h.ofType("co_admt.explanation.sent")[0]!.payload.embedded, true);
  assert.equal(h.timer("CO_SB26_189_1703_RECORDS_3Y")!.status, "armed"); assert.deepEqual(h.file().adverse_actions[0]!.retention_class, ["regb_25m", "co_admt_3y", "fnma_loan_file_life_plus_4y"]);
  // human-review request Wed Jan 20 → due Fri Feb 19, 2027; the approving reviewer may not perform it; a different reviewer completes it with a written outcome
  h.at("2027-01-20T16:00:00.000Z"); const req = await h.run("assembleStateOverlays", { op: "human_review_request", decision_id: "D-CO", request_text: "Please have a person look at my income calculation." });
  assert.equal(req.due_on, "2027-02-19"); assert.equal(h.timer("CO_SB26_189_1705_HUMAN_REVIEW_30")!.dueDate, "2027-02-19");
  await refused(h.run("assembleStateOverlays", { op: "human_review_complete", decision_id: "D-CO", outcome: "Decision affirmed" }), "SECOND_REVIEWER_IS_HUMAN");
  await assert.rejects(h.run("assembleStateOverlays", { op: "human_review_complete", decision_id: "D-CO", outcome: "Decision affirmed" }, REVIEWER), /different reviewer/);
  h.at("2027-02-10T16:00:00.000Z"); const done = await h.run("assembleStateOverlays", { op: "human_review_complete", decision_id: "D-CO", outcome: "Decision affirmed: DTI 51.3 % recomputed from the verified lease" }, REVIEWER_2);
  assert.equal(done.reviewer_id, "u-uwr-2"); assert.equal(h.timer("CO_SB26_189_1705_HUMAN_REVIEW_30")!.status, "satisfied");
  const co = h.file().adverse_actions[0]!.co_admt!; assert.equal(co.human_review_reviewer_id, "u-uwr-2"); assert.equal(co.human_review_completed_at, "2027-02-10T16:00:00.000Z"); assert.equal(co.explanation_due_on, "2027-02-11");
  // the pre-use gate: closed for a Colorado interaction on/after 2027-01-01 until the notice is delivered
  h.at("2027-01-05T16:00:00.000Z"); await h.run("assembleStateOverlays", { op: "preuse_delivered", application_id: "APP-CO-1", notice_id: "N-preuse", state: "CO" });
  assert.equal(h.timer("CO_SB26_189_1704_PREUSE_NOTICE_GATE")!.status, "satisfied");
});

test("21.6-T11: Given the same facts with a decision dated Tue Dec 15, 2026, then no Colorado timer is created (act applies to decisions on or after Jan 1, 2027) while the ECOA/FCRA notice is unchanged.", async () => {
  const CO = { ...REFI, partner_address: "100 Partner Plaza, Denver, CO 80202", creditor_time_zone: "America/Denver", application_date: "2026-11-16", property_state: "CO", admt_materially_influenced: true };
  const h = harness("APP-CO-2", "2026-11-16T17:00:00.000Z");
  received(h, { id: "APP-CO-2", tz: "America/Denver", state: "CO", at: "2026-11-16T17:16:00.000Z" });
  h.at("2026-12-14T17:00:00.000Z"); await h.run("recommendDisposition", { ...CO, decision_id: "D-CO2", factors: FACTORS, du_recommendation: "refer_with_caution", data_verified_and_resubmitted: true });
  h.at("2026-12-15T17:05:00.000Z"); await h.run("openReviewerEscalation", { op: "decide", decision_id: "D-CO2", outcome: "approved" }, REVIEWER);
  assert.equal(h.timer("CO_SB26_189_1704_ADVERSE_EXPLANATION_30"), undefined, "no Colorado timer for a decision before 2027-01-01"); assert.equal(h.ofType("decision.reviewed")[0]!.payload.co_admt_applies, false);
  const ov = await h.run("assembleStateOverlays", { decided_on: "2026-12-15" }); assert.equal(ov.co_duties_apply, false); assert.equal(ov.explanation_due_on, null); assert.equal(ov.colorado_consumer, true);
  const r = await h.run("renderNotice", { decision_id: "D-CO2", score_payloads: [SCORES_B1], notice_date: "2026-12-17" });
  const text = h.text((r.notice_ids as Record<string, string>).B1!);
  // the ECOA/FCRA content is the uniform template's: reasons, ECOA notice, FTC, FCRA block, and (by policy) the human-review statement
  assert.match(text, /Excessive obligations in relation to income/); assert.match(text, /Federal Equal Credit Opportunity Act prohibits creditors from discriminating/); assert.match(text, /Federal Trade Commission, Consumer Response Center/); assert.match(text, /Your credit score: 712\./); assert.match(text, /request meaningful human review/);
  const payloadCo = adverseNoticePayloads({ ...newDecisionFile({ ...CO, application_id: "APP-CO-2" }), decisions: h.file().decisions }, { decision_id: "D-CO2", notice_date: D("2026-12-17"), fcra_blocks: [assembleFcraBlock(SCORES_B1)] })[0]!.payload;
  const payload2027 = adverseNoticePayloads({ ...newDecisionFile({ ...CO, application_id: "APP-CO-2" }), decisions: h.file().decisions.map((d) => ({ ...d, decided_at: "2027-01-12T17:05:00.000Z" })) }, { decision_id: "D-CO2", notice_date: D("2027-01-14"), fcra_blocks: [assembleFcraBlock(SCORES_B1)] })[0]!.payload;
  assert.deepEqual(payloadCo.principal_reasons, payload2027.principal_reasons); assert.deepEqual(payloadCo.fcra, payload2027.fcra); assert.equal(payloadCo.ecoa_notice, payload2027.ecoa_notice); assert.equal(payloadCo.federal_agency_address, payload2027.federal_agency_address);
  assert.equal((payloadCo.co_admt as { duties_apply: boolean }).duties_apply, false); assert.equal((payload2027.co_admt as { duties_apply: boolean }).duties_apply, true);
  h.at("2026-12-17T17:00:00.000Z"); const sent = await h.run("deliverNotice", { decision_id: "D-CO2", notice_ids: r.notice_ids, score_payloads: [SCORES_B1] });
  assert.equal(sent.co_explanation_sent_at, null); assert.equal(h.ofType("co_admt.explanation.sent").length, 0); assert.equal(h.timers.byCode("CO_SB26_189_1704_ADVERSE_EXPLANATION_30").length, 0);
  assert.equal(h.timer("REGB_1002_9_DECISION_30")!.status, "satisfied"); assert.equal((sent.hmda as { action_taken: number }).action_taken, 3);
});

test("21.6-T12: Given an LLM-drafted borrower explanation containing \"applicants from your area usually don't qualify\", then the discouragement check blocks the send and routes to `compliance-sentinel`; the notice text (taxonomy only) is unaffected.", async () => {
  const check = discouragementCheck("Unfortunately applicants from your area usually don't qualify for this program.");
  assert.equal(check.blocked, true); assert.ok(check.findings.some((f) => f.kind === "discouragement")); assert.ok(check.findings.some((f) => f.kind === "prohibited_basis"));
  assert.equal(discouragementCheck("Your application was denied because your monthly debts are too high relative to your income; you may request the specific reasons or a human review.").blocked, false);
  const h = harness("APP-REFI-1", "2026-10-05T17:14:00.000Z"); await deniedRefi(h);
  const r = await h.run("renderNotice", { decision_id: "D-1", score_payloads: [SCORES_B1], notice_date: "2026-10-26" }); const before = h.text((r.notice_ids as Record<string, string>).B1!);
  h.at("2026-10-26T18:30:00.000Z");
  const blocked = await h.run("deliverNotice", { decision_id: "D-1", notice_ids: r.notice_ids, score_payloads: [SCORES_B1], borrower_explanation: "applicants from your area usually don't qualify", prompt_version: "uw-explain-2.1" });
  assert.equal(blocked.sent, false); assert.equal(blocked.blocked, true); assert.equal(blocked.routed_to, "compliance-sentinel"); assert.equal(blocked.notice_text_affected, false);
  const esc = h.esc(blocked.escalation_id as string); assert.equal(esc.kind, "sev1"); assert.equal(esc.ownerRole, "compliance"); assert.equal(esc.openedBy, "agent:compliance-sentinel"); assert.equal(esc.payload.citation, "12 CFR 1002.4(b)");
  assert.equal(h.ofType("explanation.discouragement.blocked").length, 1); assert.equal(h.ofType("notice.sent").length, 0); assert.equal(h.ofType("notice.adverse_action.sent").length, 0); assert.equal(h.file().disposition, "open");
  await refused(h.run("deliverNotice", { decision_id: "D-1", notice_ids: r.notice_ids, discouraging_statement: true }), "NEVER_DISCOURAGE");
  // the taxonomy notice is unaffected: the same rendered notice sends once the explanation is dropped
  assert.equal(h.text((r.notice_ids as Record<string, string>).B1!), before); assert.doesNotMatch(before, /your area/);
  const sent = await h.run("deliverNotice", { decision_id: "D-1", notice_ids: r.notice_ids, score_payloads: [SCORES_B1], borrower_explanation: "Your application was denied because your monthly debts are too high relative to your income. You may request the specific reasons or a human review." });
  assert.equal(sent.sent, true); assert.equal(h.ofType("notice.sent").length, 1);
});

test("21.6-T13: Given a conditional approval whose only open condition is a clear title that the seller cannot deliver by the contract deadline and the borrower cancels, then HMDA code 2 with `action_taken_date` = the approval expiration date, not code 3.", async () => {
  const h = harness("APP-PURCH-1", "2026-10-19T22:40:00.000Z");
  received(h, { id: "APP-PURCH-1", tz: EST, state: "OH", at: "2026-10-19T22:45:00.000Z", channel: "web", transaction_type: "purchase" });
  h.at("2026-11-02T20:00:00.000Z"); await h.run("recommendDisposition", { ...PURCHASE, decision_id: "D-A1", factors: [{ ...FACTORS[2]!, applicant_ids: ["A", "B"] }] });
  assert.equal(h.file().disposition, "conditional_approval"); assert.equal(h.timer("REGB_1002_9_DECISION_30")!.status, "satisfied", "an approval needs no human and is notified at once");
  const ca = await h.run("writeDecision", { op: "conditional_approval", approved_on: "2026-11-02", expires_on: "2026-12-02", open_conditions: [{ condition_id: "clear_title", description: "Seller to deliver clear title (release of the mechanic's lien)" }] });
  assert.equal(ca.disposition, "approved", "all creditworthiness conditions met; only a customary closing condition remains"); assert.deepEqual((ca.open_conditions as { kind: string }[]).map((c) => c.kind), ["customary_closing"]);
  h.at("2026-11-25T20:00:00.000Z");
  const out = await h.run("writeDecision", { op: "fallout", reason: "seller cannot deliver clear title by the contract deadline; borrower cancels", express_withdrawal: true, withdrawal_statement: "We're cancelling the purchase, please cancel my application" });
  assert.deepEqual(out.hmda, { action_taken: 2, action_taken_date: "2026-12-02", denial_reasons: [], denial_reason_other_text: null, basis: "approved but not accepted: only customary commitment/closing conditions unmet; date = approval expiration (policy; comment 4(a)(8)(ii)-4)" });
  assert.equal(out.disposition, "approved_not_accepted"); assert.notEqual((out.hmda as { action_taken: number }).action_taken, 3);
  assert.equal((h.rt.store.get("hmda_records", "APP-PURCH-1")!.data as { action_taken: number }).action_taken, 2); assert.equal(h.ofType("notice.adverse_action.sent").length, 0);
  // the contrast (comment 4(a)(8)(i)-13): an unmet creditworthiness condition is a denial; an express withdrawal before it is met is code 4
  const reasons = selectPrincipalReasons([FACTORS[0]!]);
  assert.equal(hmdaActionFor({ kind: "conditional_approval_fallout", open_conditions: [{ condition_id: "dti", kind: "creditworthiness", description: "DTI within 50 %" }], approval_expires_on: D("2026-12-02"), express_withdrawal: false, withdrawal_on: null, reasons }).action_taken, 3);
  assert.equal(hmdaActionFor({ kind: "conditional_approval_fallout", open_conditions: [{ condition_id: "dti", kind: "creditworthiness", description: "DTI within 50 %" }], approval_expires_on: D("2026-12-02"), express_withdrawal: true, withdrawal_on: D("2026-11-25"), reasons: [] }).action_taken, 4);
  assert.equal(hmdaActionFor({ kind: "conditional_approval_fallout", open_conditions: [{ condition_id: "clear_title", kind: "customary_closing", description: "clear title" }], approval_expires_on: D("2026-12-02"), express_withdrawal: false, withdrawal_on: null, reasons: [] }).action_taken_date, "2026-12-02");
});

test("21.6 worked figures: decision clocks Oct 5 → Nov 4 and Oct 19 → Nov 18, 2026; reviewer SLA Fri Oct 23 → Tue Oct 27 (cap Nov 1); counteroffer Nov 3 → Feb 1, 2027 and Oct 30 → Jan 28, 2027; Colorado Jan 12 → Feb 11, 2027; $400,500 = 90 % of $445,000, LTV 92.6 % on $412,000, $457,778 needed at 90 %; $1,150 lease → DTI 51.3 %; $832,750 limit as other_specific (HMDA 9); regb_25m to Nov 26, 2028", () => {
  assert.equal(decisionClock(D("2026-10-05"), MST).decision_due_on, "2026-11-04"); assert.equal(decisionClock(D("2026-10-19"), EST).decision_due_on, "2026-11-18");
  assert.deepEqual(reviewerSlaDue(D("2026-10-23"), D("2026-11-04")), { sla_due_on: D("2026-10-27"), cap_on: D("2026-11-01"), capped: false });
  assert.deepEqual(reviewerSlaDue(D("2026-10-30"), D("2026-11-04")), { sla_due_on: D("2026-11-01"), cap_on: D("2026-11-01"), capped: true }, "Fri Oct 30 + 2 BD = Tue Nov 3 > cap Nov 1");
  assert.equal(adverseNoticePolicyDue(D("2026-11-06")), "2026-11-16", "5 creditor business days from Fri Nov 6 over Veterans Day (Wed Nov 11): Nov 9, 10, 12, 13, 16");
  assert.equal(counterofferClock(D("2026-11-03"), D("2026-11-18")).adverse_notice_due_on, "2027-02-01"); assert.equal(counterofferClock(D("2026-10-30"), null).adverse_notice_due_on, "2027-01-28");
  assert.equal(coExplanationDue(D("2027-01-12")), "2027-02-11");
  assert.equal(loanAmountAtLtv(44_500_000n, 90), 40_050_000n, "$400,500.00 = 90 % of $445,000.00"); assert.equal(ltvPercent(41_200_000n, 44_500_000n), "92.6"); assert.equal(ltvPercent(40_050_000n, 44_500_000n), "90.0");
  assert.equal(valueNeededForLtv(41_200_000n, 90), 45_777_778n, "$457,777.78 — the spec's $457,778 rounds to the dollar"); assert.ok(45_777_778n > 44_500_000n && 45_777_778n < 45_778_000n);
  assert.equal(ltvPercent(41_200_000n, 45_778_000n), "90.0", "the $457,780 contract supports 90 % on $412,000");
  // the $1,150/month auto lease lifts DTI from 38 % to 51.3 % — the failed factor's materiality is (51.3 − 50) / 50
  const dti = selectPrincipalReasons([FACTORS[0]!])[0]!; assert.equal(dti.materiality, (51.3 - 50) / 50); assert.equal(115_000n, 1_150n * 100n);
  const limit = selectPrincipalReasons([{ rule_id: "loan_amount_limit", description: "Loan amount above the 2026 conforming limit", threshold: "83275000", observed: "85000000", applicant_ids: ["B1"], evidence_document_ids: [], failed: true, other_text: "Loan amount exceeds the maximum for this program" }], { reviewer_signed_other_text: true })[0]!;
  assert.equal(limit.hmda_denial_code, 9); assert.equal(limit.statement_text, "Loan amount exceeds the maximum for this program"); assert.equal(83_275_000n, BigInt(FACTORS.length ? "83275000" : "0"));
  assert.deepEqual(hmdaDenialReasons([limit]), { codes: [9], other_text: "Loan amount exceeds the maximum for this program" });
  assert.equal(D("2028-11-26"), "2028-11-26"); // regb_25m: Oct 26, 2026 + 25 months
});
