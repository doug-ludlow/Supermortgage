// 28.4 Fraud, misrepresentation, AML/SAR, OFAC, and Fannie Mae fraud reporting
// spec/sections/28-quality-control-hmda-and-fraud-aml-reporting/28-4-fraud-misrepresentation-aml-sar-ofac-and-fannie-mae-fraud-re.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_28_4 } from "../../app/tools/section28-4.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { render } from "../../notices/render.ts";
import { ADVERSE_ACTION_SOURCE, ADVERSE_ACTION_SAMPLE } from "../../notices/authored/section21-6.ts";
import { FakeOfacScreener, assertNoFraudHold, logRedFlag, sarDeadlines, ofacReportDue, ofacRecordsRetainedUntil, selfReportDue, FraudHoldBlocked, type OfacCandidate } from "../verification/ops-22-6.ts";
import {
  ScreeningRefused, RULE_SET_VERSIONS, CASE_THRESHOLD, aggregateSignals, signalFromEvent, openFraudCase, applyProductionHold, assertNoProductionHold, releaseProductionHold, recordStep, recordTriage, triageDue, subjectIdentifiedFileBy, notifyLawEnforcement, closeCase,
  draftNarrative, draftSar, officerSarDecision, fileSar, acknowledgeSar, scheduleContinuingReview, continuingReviewDates, officerDecisionDue, sarRetentionUntil, sarAccessAllowed, querySars, subpoenaForSarMaterial, sarRetentionGate,
  recordOfacHit, dispositionOfacHit, unblockProperty, submitOfacReport, blockedFundsPosting, annualBlockedReportDue, annualReportRequired, ofacRetentionGate, ofacClearBeforeFundingGate, assertOfacGateOpen, ofacListRefresh, programScheduleTick,
  fnmaReportChannel, fnmaSubmitByPolicy, openFnmaFraudReport, approveFnmaReport, submitFnmaReport, receiveIdentityTheftRequest, fulfilIdentityTheftRequest,
  recordIndependentTest, recordTraining, reviewProgram, bumpProgramForFinalRule, issueBoardReport, screenCounterparty, denialReasonsForCase, scanForSarTerms, fraudRiskDecisionRecord, monthlyFraudFlagRate, computeAmount, interviewQuestionAllowed,
  type FraudCase, type Sar, type Signal, type BsaProgram, type OfacHit,
} from "./ops-28-4.ts";

const AGENT: Actor = { kind: "agent", id: "fraud-risk" };
const BSA: Actor = { kind: "human", id: "u-bsa", role: "bsa_officer" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const OPERATOR: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
const QC_REVIEWER: Actor = { kind: "human", id: "u-qc", role: "qc_officer" };
const PRODUCTION_AGENT: Actor = { kind: "agent", id: "underwriting" };
const APP = "app-28-4", PARTNER = "partner-1";
/** Purchase fixture (Columbus OH — Eastern) and refinance fixture (Phoenix — MST all year). */
const et = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/New_York"));
const mst = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/Phoenix"));
const SIGNALS_EX1: Signal[] = [{ source_process: "28.1", signal_code: "qc_fraud_misrepresentation", evidence_refs: ["doc-bonus-stmt"], score: 70 }, { source_process: "22.1", signal_code: "document_integrity_fail", evidence_refs: ["dic-1"], score: 40 }, { source_process: "22.6", signal_code: "fraud_tool_alert", evidence_refs: ["DRIVE-1:voip_employer_phone"], score: 30 }];

/** The 28.4 tools on the bus over the overridden registry (28.4 rows), the escalation service and an entity store seeded with the open application. */
function harness(nowIso: string, o: { ofac?: FakeOfacScreener; app?: Record<string, unknown> | null } = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId: APP });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["28.4"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: "", applicationId: APP, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: { ofac_screener: o.ofac ?? new FakeOfacScreener() }, ports: {} };
  if (o.app !== null) rt.store.put("applications", APP, { status: "processing", occupancy: "primary", borrower_ids: ["B-A"], ...(o.app ?? {}) }, AGENT, nowIso);
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_28_4); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("28.4", name))!, actor, { application_id: APP, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): readonly DomainEvent[] => events.ofType(type);
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  const escalations = (kind: string) => rt.escalations.opened.filter((e) => e.kind === kind);
  /** Worked example 1's case: opened on the open purchase application with the prefunding-QC signals. */
  const openCase = async (extra: ToolInput = {}) => run("openCase", { partner_id: PARTNER, opened_by: "qc-audit run 28.1", signals: SIGNALS_EX1, scheme_hypotheses: ["document_forgery", "employment_fabrication", "income_fabrication"], amount_cents: 41_200_000n, subjects: [{ party_id: "B-A", role: "borrower" }], ...extra });
  return { clock, events, timers, rt, run, at, timer, ofType, refused, escalations, decisions, openCase, uow };
}
const caseRow = (h: ReturnType<typeof harness>, id: string): FraudCase => ({ ...(h.rt.store.require("fraud_cases", id).data as unknown as FraudCase), amount_cents: BigInt(String(h.rt.store.require("fraud_cases", id).data.amount_cents)) });
const sarRow = (h: ReturnType<typeof harness>, id: string): Sar => h.rt.store.require("sars", id).data as unknown as Sar;
const program = (o: Partial<BsaProgram> = {}): BsaProgram => ({ program_id: "prog-sm", owner: "sm", version: "2026.1", compliance_date: null, approved_by_senior_management_at: D("2026-01-15"), board_approved_at: D("2026-01-20"), risk_assessment_document_id: "doc-ra-2026", risk_assessment_date: D("2026-01-10"), compliance_officer_id: "u-bsa", training: [], independent_tests: [], red_flags_itpp_document_id: "doc-itpp", red_flags_board_report_at: null, next_review_due_on: D("2027-01-15"), ...o });

test("28.4-T1: Given `fraud.suspicious.determined` with `initial_detection_at = 2026-10-19` and a subject identified, then `BSA_1029_320_SAR_30` is due Wed Nov 18, 2026 and is satisfied only by an officer-executed `sar.filed`; the `fraud-risk` agent's attempt to call the filing tool is refused.", async () => {
  const h = harness(et("2026-10-19", "09:52"));
  const opened = await h.openCase(); const id = String(opened.case_id);
  assert.equal(opened.production_hold, true); assert.equal(h.timer("SM_FRAUD_TRIAGE_SLA_10")?.dueDate, "2026-10-29");
  // Wed Oct 21 15:10 MST: the bsa_officer records suspicious_determined with the facts first assembled Mon Oct 19 → the conservative anchor
  h.at(mst("2026-10-21", "15:10"));
  const t = await h.run("recommendTriage", { op: "record", case_id: id, decision: "suspicious_determined", subject_identified: true, facts_first_assembled_on: "2026-10-19", rationale: "forged bonus statement; VOIP employer line; payroll-vendor VOE contradicts" }, BSA);
  assert.equal(t.initial_detection_at, "2026-10-19"); assert.equal(t.triage_status, "suspicious_determined");
  const det = h.ofType("fraud.suspicious.determined")[0]!; assert.equal(det.payload.initial_detection_at, "2026-10-19"); assert.equal(det.payload.subject_identified, true);
  const sar30 = h.timer("BSA_1029_320_SAR_30")!; assert.equal(sar30.status, "armed"); assert.equal(sar30.dueDate, "2026-11-18"); assert.equal(sar30.anchorDate, "2026-10-19");
  assert.equal(h.timer("BSA_1029_320_SAR_60_NO_SUBJECT"), undefined, "the 60-day track does not arm with a subject identified");
  assert.deepEqual(sarDeadlines(D("2026-10-19"), true), { filing_due_on: "2026-11-18", outer_limit_on: "2026-12-18", policy_file_by: "2026-11-18" });
  // the agent drafts (Mon Oct 26); the officer decides (Thu Oct 29); the agent's attempt to file is refused before anything runs
  h.at(mst("2026-10-26", "10:00"));
  const narrative = draftNarrative(caseRow(h, id), { who: "borrower", what: "fabricated bonus statement", when: "application Oct 19; documents Oct 20", where: "Columbus, OH", why: "forged document; VOIP employer line; vendor verification contradicts", how: "uploaded through the borrower app" });
  const d = await h.run("draftSarPackage", { case_id: id, filer: "partner", filing_org_ein_ref: "ein-ref-partner", narrative_document_id: "doc-sar-narrative", narrative_hash: narrative.narrative_hash, supporting_documents: ["doc-bonus-stmt", "doc-voe-written"] });
  const sarId = String(d.sar_id); assert.equal(d.due_on, "2026-11-18"); assert.equal(d.officer_decision_due_on, "2026-10-31"); assert.equal(h.timer("SM_BSA_OFFICER_SAR_DECISION_SLA_5")?.dueDate, "2026-10-31");
  h.at(mst("2026-10-29", "11:00"));
  await h.refused(h.run("draftSarPackage", { op: "decide", sar_id: sarId, decision: "file", rationale: "facts support a SAR" }), "FILING_IS_HUMAN_ACT");
  await h.refused(h.run("draftSarPackage", { op: "decide", sar_id: sarId, decision: "file", rationale: "facts support a SAR" }, BSA), "NARRATIVE_NOT_OFFICER_EDITED");
  const dec = await h.run("draftSarPackage", { op: "decide", sar_id: sarId, decision: "file", rationale: "facts support a SAR", narrative_edited: true }, BSA);
  assert.equal(dec.status, "approved"); assert.equal(h.timer("SM_BSA_OFFICER_SAR_DECISION_SLA_5")?.status, "satisfied");
  h.at(mst("2026-10-30", "09:00"));
  await h.refused(h.run("draftSarPackage", { op: "file", sar_id: sarId }), "FILING_IS_HUMAN_ACT");                        // the agent's attempt
  await h.refused(h.run("draftSarPackage", { op: "file", sar_id: sarId }, OFFICER), "SAR_FILING_IS_BSA_OFFICER_ACT");   // a human who is not the bsa_officer
  assert.throws(() => fileSar(h.events, caseRow(h, id), sarRow(h, sarId), { at: h.clock.now() }, AGENT), (e: unknown) => e instanceof ScreeningRefused && e.code === "SAR_FILING_IS_BSA_OFFICER_ACT");
  assert.equal(h.timer("BSA_1029_320_SAR_30")?.status, "armed"); assert.equal(h.ofType("sar.filed").length, 0);
  const filed = await h.run("draftSarPackage", { op: "file", sar_id: sarId }, BSA);
  assert.equal(filed.status, "filed"); assert.equal(filed.filed_on, "2026-10-30"); assert.equal(filed.late, false); assert.equal(filed.retention_until, "2031-10-30");
  const ev = h.ofType("sar.filed")[0]!; assert.equal(ev.actor.kind, "human"); assert.equal(ev.actor.role, "bsa_officer"); assert.equal(ev.payload.officer_act, true);
  assert.equal(h.timer("BSA_1029_320_SAR_30")?.status, "satisfied");
  assert.equal(sarRetentionUntil(D("2026-10-30")), "2031-10-30");
});

test("28.4-T2: Given `subject_identified = false` on the same date, then `BSA_1029_320_SAR_60_NO_SUBJECT` is due Fri Dec 18, 2026; when a subject is identified Tue Nov 24, the SAR is filed no later than Wed Nov 25 (policy: next business day) and never after Dec 18.", async () => {
  const h = harness(et("2026-10-19", "09:52"));
  const opened = await h.openCase(); const id = String(opened.case_id);
  h.at(mst("2026-10-19", "16:00"));
  const t = await h.run("recommendTriage", { op: "record", case_id: id, decision: "suspicious_determined", subject_identified: false, rationale: "impostor application; the subject is not yet identified" }, BSA);
  assert.equal(t.initial_detection_at, "2026-10-19"); assert.equal(t.subject_identified, false);
  const sar60 = h.timer("BSA_1029_320_SAR_60_NO_SUBJECT")!; assert.equal(sar60.status, "armed"); assert.equal(sar60.dueDate, "2026-12-18"); assert.equal(sar60.anchorDate, "2026-10-19");
  assert.equal(h.timer("BSA_1029_320_SAR_30"), undefined, "the 30-day track does not arm without a subject");
  const dl = sarDeadlines(D("2026-10-19"), false); assert.equal(dl.filing_due_on, "2026-12-18"); assert.equal(dl.outer_limit_on, "2026-12-18");
  // a subject identified Tue Nov 24 → filed no later than Wed Nov 25 (next business day); identified late in the window → never after Fri Dec 18
  assert.equal(subjectIdentifiedFileBy(D("2026-11-24"), dl.outer_limit_on), "2026-11-25");
  assert.equal(subjectIdentifiedFileBy(D("2026-12-17"), dl.outer_limit_on), "2026-12-18");
  assert.equal(subjectIdentifiedFileBy(D("2026-12-18"), dl.outer_limit_on), "2026-12-18");
  assert.equal(subjectIdentifiedFileBy(D("2026-11-25"), dl.outer_limit_on), "2026-11-27", "Thanksgiving Thu Nov 26 is not a business day");
  // the SAR drafted on the 60-day track is due Dec 18; filed Wed Nov 25 by the bsa_officer → satisfied, on time
  h.at(mst("2026-11-24", "10:00"));
  const d = await h.run("draftSarPackage", { case_id: id, filer: "partner", filing_org_ein_ref: "ein-ref-partner", narrative_document_id: "doc-sar-2", narrative_hash: "h2", subjects: [{ party_id: "B-A", role: "subject identified Nov 24" }] });
  assert.equal(d.due_on, "2026-12-18"); assert.equal(d.officer_decision_due_on, "2026-11-29");
  await h.run("draftSarPackage", { op: "decide", sar_id: String(d.sar_id), decision: "file", rationale: "subject identified; file now", narrative_edited: true }, BSA);
  h.at(mst("2026-11-25", "15:00"));
  const filed = await h.run("draftSarPackage", { op: "file", sar_id: String(d.sar_id) }, BSA);
  assert.equal(filed.filed_on, "2026-11-25"); assert.equal(filed.late, false); assert.equal(h.timer("BSA_1029_320_SAR_60_NO_SUBJECT")?.status, "satisfied");
  // filed after the outer limit is a breach: the timer breaches at the end of Dec 18 and a later filing is satisfied_late with a late-filing memo
  const h2 = harness(et("2026-10-19", "09:52")); const o2 = await h2.openCase(); const id2 = String(o2.case_id);
  await h2.run("recommendTriage", { op: "record", case_id: id2, decision: "suspicious_determined", subject_identified: false, rationale: "no subject" }, BSA);
  h2.at(et("2026-12-19", "00:01")); const breaches = h2.timers.evaluate(h2.clock.now()); assert.equal(breaches.find((b) => b.instance.code === "BSA_1029_320_SAR_60_NO_SUBJECT")?.severity, 1);
  const d2 = await h2.run("draftSarPackage", { case_id: id2, filer: "partner", filing_org_ein_ref: "ein-ref-partner", narrative_document_id: "doc-sar-3", narrative_hash: "h3" });
  await h2.run("draftSarPackage", { op: "decide", sar_id: String(d2.sar_id), decision: "file", rationale: "file immediately", narrative_edited: true }, BSA);
  const late = await h2.run("draftSarPackage", { op: "file", sar_id: String(d2.sar_id) }, BSA);
  assert.equal(late.late, true); assert.equal(late.late_filing_memo_required, true); assert.equal(h2.timer("BSA_1029_320_SAR_60_NO_SUBJECT")?.status, "satisfied_late");
});

test("28.4-T3: Given a case opened Mon Oct 19, 2026 with no triage decision by Thu Oct 29, then `SM_FRAUD_TRIAGE_SLA_10` breaches at sev 1 to the `bsa_officer`, who must record `suspicious_determined` or `not_suspicious` with a rationale.", async () => {
  const h = harness(et("2026-10-19", "09:52"));
  const opened = await h.openCase(); const id = String(opened.case_id);
  assert.equal(triageDue(D("2026-10-19")), "2026-10-29");
  const sla = h.timer("SM_FRAUD_TRIAGE_SLA_10")!; assert.equal(sla.status, "armed"); assert.equal(sla.dueDate, "2026-10-29"); assert.equal(sla.anchorDate, "2026-10-19");
  // the agent investigates (steps with evidence) and recommends; no officer-reviewed triage lands by Thu Oct 29 end of day
  h.at(et("2026-10-22", "10:00"));
  await h.run("reexamineDocuments", { case_id: id, document_ids: ["doc-bonus-stmt"], result: "producer string from a consumer PDF editor; fonts inconsistent with the payroll system" });
  await h.refused(h.run("orderIndependentVerification", { case_id: id, kind: "voe", channel: "third_party_direct", result: "x", evidence_refs: ["y"] }), "NO_UNDOCUMENTED_THIRD_PARTY_CONTACT");
  await h.run("orderIndependentVerification", { case_id: id, kind: "written_voe", channel: "payroll_vendor", result: "no bonus on the payroll record", evidence_refs: ["doc-voe-written"] });
  const rec = await h.run("recommendTriage", { case_id: id, recommendation: "suspicious_determined", rationale: "employment fabrication supported by two independent sources" });
  assert.equal(h.escalations("bsa_officer").length, 1); assert.equal(rec.triage_due_on, "2026-10-29");
  assert.equal(h.timer("SM_FRAUD_TRIAGE_SLA_10")?.status, "armed", "a recommendation is not the officer-reviewed triage");
  h.at(et("2026-10-30", "00:30"));
  const breaches = h.timers.evaluate(h.clock.now());
  const b = breaches.find((x) => x.instance.code === "SM_FRAUD_TRIAGE_SLA_10")!; assert.equal(b.severity, 1); assert.ok(b.escalateTo.includes("bsa_officer"), b.escalateTo.join(","));
  assert.equal(h.timer("SM_FRAUD_TRIAGE_SLA_10")?.status, "breached");
  // the agent cannot set the determination itself; the officer must record it — with a rationale
  await h.refused(h.run("recommendTriage", { op: "record", case_id: id, decision: "suspicious_determined", subject_identified: true, rationale: "agent decides" }), "TRIAGE_NEEDS_OFFICER_REVIEW");
  await assert.rejects(h.run("recommendTriage", { op: "record", case_id: id, decision: "not_suspicious" }, BSA), RangeError);
  assert.throws(() => recordTriage(h.events, caseRow(h, id), { decision: "not_suspicious", rationale: "", at: h.clock.now() }, BSA), RangeError);
  const t = await h.run("recommendTriage", { op: "record", case_id: id, decision: "not_suspicious", rationale: "post-closing job transfer explains the discrepancy; no intent at application" }, BSA);
  assert.equal(t.triage_status, "not_suspicious"); assert.equal(t.within_sla, false); assert.equal(t.production_hold, false);
  assert.equal(h.timer("SM_FRAUD_TRIAGE_SLA_10")?.status, "satisfied_late"); assert.equal(h.timer("SM_FRAUD_PRODUCTION_HOLD")?.status, "satisfied");
  assert.equal(h.rt.store.get("applications", APP)!.data.fraud_hold, false);
  const triaged = h.ofType("fraud.case.triaged")[0]!; assert.equal(triaged.payload.officer_reviewed, true); assert.equal(triaged.payload.rationale, "post-closing job transfer explains the discrepancy; no intent at application");
});

test("28.4-T4: Given property blocked Thu Nov 12, 2026, then `OFAC_501_603_BLOCKED_REPORT_10BD` is due Fri Nov 27, 2026 (Thanksgiving excluded); given a rejected transaction Fri Oct 9, 2026, then the report is due Mon Oct 26, 2026 (Columbus Day excluded); the rejected-transaction record is retained until Oct 9, 2036, and the blocked-property record for as long as the property stays blocked plus 10 years after the unblocking date (`retention_until` is set only when `ofac.report.submitted{unblocking}` is recorded).", async () => {
  const h = harness(et("2026-11-12", "09:00"));
  const hit = recordOfacHit(h.events, { screening_id: "scr-payee-2", party_id: "payee-second-lien", application_id: APP, list: "sdn", entry_uid: "SDN-12345", match_score: 96, match_fields: ["name", "city", "country_of_registration"], at: h.clock.now() });
  h.rt.store.put("ofac_hits", hit.hit.hit_id, { ...hit.hit } as unknown as Record<string, unknown>, AGENT, h.clock.now());
  await h.refused(h.run("analyzeOfacMatch", { hit_id: hit.hit.hit_id, disposition: "false_positive", analysis: "name only" }), "OFAC_CLEAR_NEEDS_BSA_OFFICER");
  await h.refused(h.run("analyzeOfacMatch", { hit_id: hit.hit.hit_id, disposition: "confirmed_match", analysis: "name + city + country match", blocked_property: { description: "second-lien payoff", value_cents: 4_125_000n, location: "settlement flow", account_ref: "blocked-acct-1" } }), "OFAC_CONFIRM_NEEDS_BSA_OFFICER");
  const blocked = await h.run("analyzeOfacMatch", { hit_id: hit.hit.hit_id, disposition: "confirmed_match", analysis: "beneficiary name, city and country of registration match the SDN entry", blocked_property: { description: "second-lien payoff", value_cents: 4_125_000n, location: "settlement flow", account_ref: "blocked-acct-1" } }, BSA);
  assert.equal(blocked.report_kind, "blocked_initial"); assert.equal(blocked.report_due_on, "2026-11-27"); assert.equal(blocked.retention_until, null, "blocked property: no retention_until until unblocked");
  assert.equal(ofacReportDue(D("2026-11-12")), "2026-11-27");
  const bt = h.timer("OFAC_501_603_BLOCKED_REPORT_10BD")!; assert.equal(bt.status, "armed"); assert.equal(bt.dueDate, "2026-11-27"); assert.equal(bt.anchorDate, "2026-11-12");
  const annual = h.timer("OFAC_501_603_ANNUAL_BLOCKED_0930")!; assert.equal(annual.status, "armed"); assert.equal(annual.dueDate, "2027-09-30");
  assert.equal(annualBlockedReportDue(D("2026-11-12")), "2027-09-30"); assert.equal(annualBlockedReportDue(D("2027-06-30")), "2027-09-30"); assert.equal(annualBlockedReportDue(D("2027-07-01")), "2028-09-30");
  assert.equal(blocked.ledger_posted, true); assert.equal(h.uow.ledger.sets().length, 1);
  assert.equal(ofacRetentionGate({ record_kind: "blocked_property", unblocked_on: null, today: "2040-01-01" }).open, false, "closed for as long as the property stays blocked");
  // the ORS report submitted Wed Nov 18 by the bsa_officer (the agent's submit is refused)
  h.at(et("2026-11-18", "10:00"));
  await h.refused(h.run("draftOfacReport", { op: "submit", hit_id: hit.hit.hit_id, kind: "blocked_initial", ors_reference: "ORS-1", content_document_id: "doc-ors-1" }), "FILING_IS_HUMAN_ACT");
  const sub = await h.run("draftOfacReport", { op: "submit", hit_id: hit.hit.hit_id, kind: "blocked_initial", ors_reference: "ORS-1", content_document_id: "doc-ors-1" }, BSA);
  assert.equal(sub.due_on, "2026-11-27"); assert.equal(sub.late, false); assert.equal(sub.retention_until, null); assert.equal(h.timer("OFAC_501_603_BLOCKED_REPORT_10BD")?.status, "satisfied");
  // unblocked under an OFAC licence Mon Mar 1, 2027 → unblocking report due +10 federal business days; only that report sets retention_until (unblocking + 10 years)
  h.at(et("2027-03-01", "10:00"));
  const un = await h.run("draftOfacReport", { op: "unblock", hit_id: hit.hit.hit_id, kind: "unblocking", unblocked_on: "2027-03-01", authority: "OFAC specific licence" }, BSA);
  assert.equal(un.report_due_on, "2027-03-15"); const ut = h.timer("OFAC_501_603_UNBLOCKING_REPORT_10BD")!; assert.equal(ut.status, "armed"); assert.equal(ut.dueDate, "2027-03-15"); assert.equal(ut.anchorDate, "2027-03-01");
  const unsub = await h.run("draftOfacReport", { op: "submit", hit_id: hit.hit.hit_id, kind: "unblocking", ors_reference: "ORS-2", content_document_id: "doc-ors-2" }, BSA);
  assert.equal(unsub.retention_until, "2037-03-01"); assert.equal(h.timer("OFAC_501_603_UNBLOCKING_REPORT_10BD")?.status, "satisfied");
  assert.equal((h.ofType("ofac.report.submitted").at(-1)!.payload as { kind: string }).kind, "unblocking");
  assert.equal(ofacRetentionGate({ record_kind: "blocked_property", unblocked_on: "2027-03-01", today: "2037-02-28" }).open, false);
  assert.equal(ofacRetentionGate({ record_kind: "blocked_property", unblocked_on: "2027-03-01", today: "2037-03-01" }).open, true);
  // rejected transaction Fri Oct 9, 2026 → report due Mon Oct 26 (Columbus Day Oct 12 excluded); record retained until Oct 9, 2036
  const h2 = harness(et("2026-10-09", "14:00"));
  const rej = recordOfacHit(h2.events, { screening_id: "scr-wire-1", party_id: "wire-sender", application_id: APP, list: "sdn", entry_uid: "SDN-777", match_score: 98, match_fields: ["name", "date_of_birth"], at: h2.clock.now() });
  const r = dispositionOfacHit(h2.events, rej.hit, { disposition: "confirmed_match", analysis: "name and DOB match", at: h2.clock.now(), rejected_transaction: { description: "incoming wire refused", value_cents: 1_500_000n, counterparties: ["wire-sender"] } }, BSA);
  assert.equal(r.report_kind, "rejected_transaction"); assert.equal(r.report_due_on, "2026-10-26"); assert.equal(r.hit.retention_until, "2036-10-09"); assert.equal(ofacRecordsRetainedUntil(D("2026-10-09")), "2036-10-09");
  const rt2 = h2.timer("OFAC_501_604_REJECTED_REPORT_10BD")!; assert.equal(rt2.status, "armed"); assert.equal(rt2.dueDate, "2026-10-26"); assert.equal(rt2.anchorDate, "2026-10-09");
  assert.equal(ofacRetentionGate({ record_kind: "rejected_transaction", transaction_on: "2026-10-09", today: "2036-10-08" }).open, false);
  assert.equal(ofacRetentionGate({ record_kind: "rejected_transaction", transaction_on: "2026-10-09", today: "2036-10-09" }).open, true);
  assert.equal(annualReportRequired(r.hit, D("2027-06-30")), false);
});

test("28.4-T5: Given `fnma.fraud.reasonable_basis` on Wed Nov 25, 2026 for a delivered loan, then `FNMA_A3_4_03_FRAUD_SELF_REPORT_30` is due Fri Dec 25, 2026, the LQC self-report is submitted by Thu Dec 24 by the `fnma_portal_operator` after partner `officer` approval, and the LQC reference is stored; a submission on Mon Dec 28 is a breach.", async () => {
  const submitOn = async (submitIso: string) => {
    const h = harness(et("2026-11-25", "09:00"));
    const opened = await h.openCase({ loan_id: "loan-refi-1", application_open: false }); const id = String(opened.case_id);
    await h.run("recommendTriage", { op: "record", case_id: id, decision: "suspicious_determined", subject_identified: true, rationale: "occupancy misrepresentation at application (lease dated before the note)" }, BSA);
    await assert.rejects(h.run("draftFnmaReport", { case_id: id, reasonable_basis_on: "2026-11-25", delivered_or_committed: true, synopsis_document_id: "doc-lqc-synopsis" }), RangeError, "the LQC self-report needs a Fannie Mae loan number");
    const d = await h.run("draftFnmaReport", { case_id: id, reasonable_basis_on: "2026-11-25", delivered_or_committed: true, fnma_loan_number: "1234567890", synopsis_document_id: "doc-lqc-synopsis", documents: ["doc-lease", "doc-insurance-change"] });
    assert.equal(d.channel, "lqc_self_report"); assert.equal(d.due_on, "2026-12-25"); assert.equal(d.submit_by_policy, "2026-12-24"); assert.equal(h.escalations("officer").length, 1);
    const ft = h.timer("FNMA_A3_4_03_FRAUD_SELF_REPORT_30")!; assert.equal(ft.status, "armed"); assert.equal(ft.dueDate, "2026-12-25"); assert.equal(ft.anchorDate, "2026-11-25");
    const rb = h.ofType("fnma.fraud.reasonable_basis")[0]!; assert.equal(rb.payload.reasonable_basis_at, "2026-11-25"); assert.equal(rb.payload.delivered_or_committed, true);
    const reportId = String(d.report_id);
    await h.refused(h.run("draftFnmaReport", { op: "submit", report_id: reportId, reference: "LQC-1" }), "FILING_IS_HUMAN_ACT");
    await h.refused(h.run("draftFnmaReport", { op: "submit", report_id: reportId, reference: "LQC-1" }, OPERATOR), "FNMA_REPORT_NOT_APPROVED");
    await h.refused(h.run("draftFnmaReport", { op: "approve", report_id: reportId }, BSA), "ROLE_DENIED");   // the partner officer approves, not the bsa_officer
    assert.throws(() => approveFnmaReport(h.events, caseRow(h, id), h.rt.store.require("fnma_fraud_reports", reportId).data as unknown as Parameters<typeof approveFnmaReport>[2], { at: h.clock.now() }, BSA), (e: unknown) => e instanceof ScreeningRefused && e.code === "FNMA_REPORT_NEEDS_PARTNER_OFFICER");
    h.at(et("2026-12-10", "10:00"));
    const ap = await h.run("draftFnmaReport", { op: "approve", report_id: reportId }, OFFICER); assert.equal(ap.status, "approved"); assert.equal(h.escalations("human_portal_task").length, 1);
    await h.refused(h.run("draftFnmaReport", { op: "submit", report_id: reportId, reference: "LQC-1" }, OFFICER), "FNMA_SUBMISSION_IS_OPERATOR_ACT");
    h.at(submitIso);
    const s = await h.run("draftFnmaReport", { op: "submit", report_id: reportId, reference: "LQC-2026-000123" }, OPERATOR);
    h.at(et("2026-12-26", "00:01")); const breaches = h.timers.evaluate(h.clock.now());
    return { h, s, breached: breaches.some((b) => b.instance.code === "FNMA_A3_4_03_FRAUD_SELF_REPORT_30"), reportId };
  };
  assert.equal(selfReportDue(D("2026-11-25")), "2026-12-25"); assert.equal(fnmaSubmitByPolicy(D("2026-12-25")), "2026-12-24"); assert.equal(fnmaReportChannel({ delivered_or_committed: true, third_party_scheme: false, partner_elects: false }), "lqc_self_report");
  assert.equal(fnmaReportChannel({ delivered_or_committed: false, third_party_scheme: true, partner_elects: true }), "suspected_fraud_form"); assert.equal(fnmaReportChannel({ delivered_or_committed: false, third_party_scheme: false, partner_elects: false }), null);
  // submitted Thu Dec 24: the reference is stored, no breach (the Dec 26 evaluation finds the timer already satisfied)
  const ok = await submitOn(et("2026-12-24", "15:00"));
  assert.equal(ok.s.status, "submitted"); assert.equal(ok.s.reference, "LQC-2026-000123"); assert.equal(ok.s.late, false); assert.equal(ok.s.submitted_on, "2026-12-24");
  assert.equal(ok.h.rt.store.get("fnma_fraud_reports", ok.reportId)!.data.reference, "LQC-2026-000123");
  assert.equal(ok.h.timer("FNMA_A3_4_03_FRAUD_SELF_REPORT_30")?.status, "satisfied"); assert.equal(ok.breached, false);
  // a submission on Mon Dec 28: the timer breached (sev 1 → partner officer) at the end of Fri Dec 25 and the late submission is satisfied_late
  const h = harness(et("2026-11-25", "09:00"));
  const opened = await h.openCase({ loan_id: "loan-refi-1", application_open: false }); const id = String(opened.case_id);
  await h.run("recommendTriage", { op: "record", case_id: id, decision: "suspicious_determined", subject_identified: true, rationale: "occupancy misrepresentation" }, BSA);
  const d = await h.run("draftFnmaReport", { case_id: id, reasonable_basis_on: "2026-11-25", delivered_or_committed: true, fnma_loan_number: "1234567890", synopsis_document_id: "doc-lqc-synopsis" });
  await h.run("draftFnmaReport", { op: "approve", report_id: String(d.report_id) }, OFFICER);
  h.at(et("2026-12-26", "00:01")); const breaches = h.timers.evaluate(h.clock.now());
  const b = breaches.find((x) => x.instance.code === "FNMA_A3_4_03_FRAUD_SELF_REPORT_30")!; assert.equal(b.severity, 1); assert.ok(b.escalateTo.includes("officer"));
  h.at(et("2026-12-28", "10:00"));
  const s = await h.run("draftFnmaReport", { op: "submit", report_id: String(d.report_id), reference: "LQC-2026-000124" }, OPERATOR);
  assert.equal(s.late, true); assert.equal(s.submitted_on, "2026-12-28"); assert.equal(h.timer("FNMA_A3_4_03_FRAUD_SELF_REPORT_30")?.status, "satisfied_late");
  assert.equal((h.ofType("fnma.fraud.report.submitted")[0]!.payload as { late: boolean }).late, true);
});

test("28.4-T6: Given a SAR filed Wed Nov 18, 2026 and activity continuing, then a 90-day review is scheduled to Tue Feb 16, 2027 and `BSA_1029_320_SAR_CONTINUING_120` is due Thu Mar 18, 2027.", async () => {
  const h = harness(et("2026-10-19", "09:52"));
  const opened = await h.openCase({ loan_id: "loan-refi-1", application_open: false }); const id = String(opened.case_id);
  await h.run("recommendTriage", { op: "record", case_id: id, decision: "suspicious_determined", subject_identified: true, rationale: "repeated third-party payments" }, BSA);
  const d = await h.run("draftSarPackage", { case_id: id, filer: "sm", filing_org_ein_ref: "ein-ref-sm", narrative_document_id: "doc-sar-1", narrative_hash: "h1" });
  await h.run("draftSarPackage", { op: "decide", sar_id: String(d.sar_id), decision: "file", rationale: "file", narrative_edited: true }, BSA);
  h.at(et("2026-11-18", "11:00"));
  const filed = await h.run("draftSarPackage", { op: "file", sar_id: String(d.sar_id) }, BSA); assert.equal(filed.filed_on, "2026-11-18");
  await assert.rejects(h.run("scheduleContinuingReview", { sar_id: String(d.sar_id) }), (e: unknown) => e instanceof CommandRefused && e.code === "CONTINUING_REVIEW_NEEDS_ACKNOWLEDGED_SAR");
  h.at(et("2026-11-20", "09:00"));
  const ack = await h.run("draftSarPackage", { op: "acknowledge", sar_id: String(d.sar_id), bsa_id: "31000000000042", activity_continues: true }, BSA);
  assert.equal(ack.status, "acknowledged");
  const ct = h.timer("BSA_1029_320_SAR_CONTINUING_120")!; assert.equal(ct.status, "armed"); assert.equal(ct.dueDate, "2027-03-18"); assert.equal(ct.anchorDate, "2026-11-18");
  const sched = await h.run("scheduleContinuingReview", { sar_id: String(d.sar_id) });
  assert.equal(sched.review_due_on, "2027-02-16"); assert.equal(sched.continuing_due_on, "2027-03-18");
  assert.deepEqual(continuingReviewDates(D("2026-11-18")), { review_due_on: "2027-02-16", continuing_due_on: "2027-03-18" });
  const decision = h.rt.store.get("sar_decisions", String(sched.decision_id))!.data; assert.equal(decision.decision, "continuing_review"); assert.equal(decision.review_period_days, 90); assert.equal(decision.next_review_due_at, "2027-02-16");
  // the continuing SAR is due 120 days after the prior filing; filing it concludes the cycle
  h.at(et("2027-02-16", "10:00"));
  const d2 = await h.run("draftSarPackage", { case_id: id, filer: "sm", filing_org_ein_ref: "ein-ref-sm", narrative_document_id: "doc-sar-cont", narrative_hash: "hc", continuing_activity_of: String(d.sar_id) });
  assert.equal(d2.due_on, "2027-03-18"); assert.equal(d2.continuing_activity_of, String(d.sar_id)); assert.equal(d2.officer_decision_due_on, "2027-02-21");
  await h.run("draftSarPackage", { op: "decide", sar_id: String(d2.sar_id), decision: "file", rationale: "activity continued through the review", narrative_edited: true }, BSA);
  h.at(et("2027-03-10", "10:00"));
  const f2 = await h.run("draftSarPackage", { op: "file", sar_id: String(d2.sar_id) }, BSA); assert.equal(f2.late, false);
  assert.equal(h.timer("BSA_1029_320_SAR_CONTINUING_120")?.status, "satisfied");
  assert.equal((h.ofType("sar.continuing_review.concluded")[0]!.payload as { outcome: string }).outcome, "filed");
  // a documented no_file on the continuing review concludes it too
  const h2 = harness(et("2026-10-19", "09:52")); const o2 = await h2.openCase({ loan_id: "loan-refi-1", application_open: false }); const id2 = String(o2.case_id);
  await h2.run("recommendTriage", { op: "record", case_id: id2, decision: "suspicious_determined", subject_identified: true, rationale: "r" }, BSA);
  const e1 = await h2.run("draftSarPackage", { case_id: id2, filer: "sm", filing_org_ein_ref: "ein-ref-sm", narrative_document_id: "n1", narrative_hash: "h" });
  await h2.run("draftSarPackage", { op: "decide", sar_id: String(e1.sar_id), decision: "file", rationale: "file", narrative_edited: true }, BSA);
  h2.at(et("2026-11-18", "11:00")); await h2.run("draftSarPackage", { op: "file", sar_id: String(e1.sar_id) }, BSA);
  await h2.run("draftSarPackage", { op: "acknowledge", sar_id: String(e1.sar_id), bsa_id: "31000000000043", activity_continues: true }, BSA);
  h2.at(et("2027-02-16", "10:00"));
  const e2 = await h2.run("draftSarPackage", { case_id: id2, filer: "sm", filing_org_ein_ref: "ein-ref-sm", narrative_document_id: "n2", narrative_hash: "h", continuing_activity_of: String(e1.sar_id) });
  await h2.run("draftSarPackage", { op: "decide", sar_id: String(e2.sar_id), decision: "no_file", rationale: "the activity stopped after the first filing" }, BSA);
  assert.equal(h2.timer("BSA_1029_320_SAR_CONTINUING_120")?.status, "satisfied");
});

test("28.4-T7: Given a denial caused by a fraud case, then the 21.6 notice contains only taxonomy reasons (\"Unable to verify income\"/\"Unable to verify employment\"/\"Unable to verify identity\") and no string from the SAR compartment; a content scan of the notice for \"SAR,\" \"suspicious,\" \"FinCEN\" or \"investigation\" returns nothing.", () => {
  const r = denialReasonsForCase({ scheme_hypotheses: ["document_forgery", "employment_fabrication", "income_fabrication"] });
  assert.deepEqual(r.reasons.map((x) => x.statement_text), ["Unable to verify income", "Unable to verify employment"]);
  assert.deepEqual(r.reasons.map((x) => x.hmda_denial_code), [6, 6]);
  assert.deepEqual(denialReasonsForCase({ scheme_hypotheses: ["identity_theft"] }).reasons.map((x) => x.statement_text), ["Unable to verify identity"]);
  assert.deepEqual(denialReasonsForCase({ scheme_hypotheses: ["synthetic_identity", "asset_fabrication"] }).reasons.map((x) => x.statement_text), ["Unable to verify identity", "Unable to verify assets or source of funds"]);
  // the 21.6 adverse-action notice rendered with these reasons: only taxonomy text, and the scan for the four words finds nothing
  const principal_reasons = r.reasons.map((x) => ({ statement_text: x.statement_text, reason_code: x.code, hmda_denial_code: x.hmda_denial_code }));
  const notice = render(ADVERSE_ACTION_SOURCE, { ...ADVERSE_ACTION_SAMPLE, notice_date: "2026-10-23", decided_on: "2026-10-23", principal_reasons, reasons_count: principal_reasons.length, reasons_text_lc: principal_reasons.map((p) => p.statement_text.toLowerCase()).join(" | ") });
  assert.ok(notice.text.includes("Unable to verify income") && notice.text.includes("Unable to verify employment"));
  const scan = scanForSarTerms(notice.text); assert.equal(scan.clean, true, scan.findings.join(","));
  for (const word of ["SAR", "suspicious", "FinCEN", "investigation"]) assert.doesNotMatch(notice.text, new RegExp(`\\b${word}\\b`, word === "SAR" ? "" : "i"));
  // any string from the SAR compartment is caught before rendering
  for (const bad of ["Unable to verify income (SAR filed)", "suspicious activity noted", "referred to FinCEN", "pending investigation"]) { const s = scanForSarTerms(bad); assert.equal(s.clean, false, bad); }
  assert.deepEqual(denialReasonsForCase({ scheme_hypotheses: ["other"] }).reasons.map((x) => x.statement_text), ["Unable to verify identity"], "an unmapped scheme still yields only a taxonomy reason");
});

test("28.4-T8: Given a user outside `sar_confidentiality_acl` (a production agent, a QC reviewer, or the other organization's staff without a joint filing) queries `sars`, then access is denied and logged; given a subpoena for SAR material, then the workflow produces a \"decline to produce\" response and a FinCEN notification task for the `bsa_officer`.", async () => {
  const h = harness(et("2026-11-02", "09:00"));
  const opened = await h.openCase(); const id = String(opened.case_id);
  await h.run("recommendTriage", { op: "record", case_id: id, decision: "suspicious_determined", subject_identified: true, rationale: "r" }, BSA);
  await h.run("draftSarPackage", { case_id: id, filer: "sm", filing_org_ein_ref: "ein-ref-sm", narrative_document_id: "n1", narrative_hash: "h" });
  // a production agent: not on the tool's allowlist — refused and logged as command.refused
  const before = h.events.all().length;
  await h.refused(h.run("draftSarPackage", { op: "query", actor_org: "sm" }, PRODUCTION_AGENT), "NOT_ALLOWLISTED");
  assert.deepEqual(h.events.all().slice(before).map((e) => e.type), ["command.refused"]);
  // a QC reviewer (qc_officer): outside the compartment's roles — denied by the role gate and, through the ops boundary, logged as sar.access.denied
  await h.refused(h.run("draftSarPackage", { op: "query", actor_org: "sm" }, QC_REVIEWER), "ROLE_DENIED");
  assert.equal(sarAccessAllowed(QC_REVIEWER, { filing_orgs: ["sm"], actor_org: "sm" }).allowed, false);
  assert.throws(() => querySars(h.events, QC_REVIEWER, { filing_orgs: ["sm"], actor_org: "sm" }, [], h.clock.now()), (e: unknown) => e instanceof ScreeningRefused && e.code === "SAR_ACCESS_DENIED");
  // the other organization's bsa_officer without a joint filing: denied and logged; with a joint filing: allowed
  const PARTNER_BSA: Actor = { kind: "human", id: "u-partner-bsa", role: "bsa_officer" };
  await h.refused(h.run("draftSarPackage", { op: "query", filing_orgs: ["sm"], actor_org: "partner" }, PARTNER_BSA), "SAR_ACCESS_DENIED");
  const denied = h.ofType("sar.access.denied"); assert.equal(denied.length, 2); assert.equal(denied.at(-1)!.payload.actor_org, "partner"); assert.equal(denied.at(-1)!.payload.logged, true);
  const joint = await h.run("draftSarPackage", { op: "query", filing_orgs: ["sm"], actor_org: "partner", joint_filing: true }, PARTNER_BSA); assert.equal((joint.sars as unknown[]).length, 1);
  const own = await h.run("draftSarPackage", { op: "query", filing_orgs: ["sm"], actor_org: "sm" }, BSA); assert.equal((own.sars as unknown[]).length, 1);
  assert.equal(sarAccessAllowed(AGENT, { filing_orgs: ["sm"], actor_org: "sm" }).allowed, true, "the fraud-risk SAR-preparation identity");
  assert.equal(sarAccessAllowed(PRODUCTION_AGENT, { filing_orgs: ["sm"], actor_org: "sm" }).allowed, false);
  // a subpoena for SAR material: decline to produce + a FinCEN notification task for the bsa_officer (with counsel)
  const sub = await h.run("openOfficerEscalation", { op: "subpoena", subpoena_id: "SUB-2026-17", issuer: "county court" }, BSA);
  assert.equal(sub.response, "decline to produce"); assert.equal(sub.owner_role, "bsa_officer"); assert.equal(sub.with_counsel, true);
  const task = h.escalations("bsa_officer").find((e) => e.id === sub.fincen_notification_task_id)!; assert.equal(task.payload.task, "notify_fincen"); assert.equal(task.payload.citation, "31 CFR 1029.320(d)");
  const s2 = subpoenaForSarMaterial(h.events, { subpoena_id: "SUB-2026-18", issuer: "civil litigant", received_at: h.clock.now() }, BSA); assert.equal(s2.response, "decline to produce"); assert.equal(s2.tasks[0]!.kind, "bsa_officer"); assert.equal(s2.tasks[0]!.task, "notify_fincen");
});

test("28.4-T9: Given a verified §609(e) request received Mon Nov 2, 2026 with a police report, then the application and transaction records are provided without charge by Wed Dec 2, 2026 or a documented (e)(5) decline is recorded.", async () => {
  const h = harness(et("2026-11-02", "10:00"));
  const r = await h.run("draftVictimRecordsPackage", { requester: "victim", received_on: "2026-11-02", identity_proof: "doc-victim-id", claim_proof: "police_report" });
  assert.equal(r.verified, true); assert.equal(r.due_on, "2026-12-02");
  const t = h.timer("FCRA_609E_VICTIM_RECORDS_30")!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2026-12-02"); assert.equal(t.anchorDate, "2026-11-02");
  await h.refused(h.run("draftVictimRecordsPackage", { op: "fulfil", request_id: String(r.request_id), outcome: "records_provided", document_ids: ["doc-app-1003", "doc-txn-ledger"], charge_cents: 2_500n }), "VICTIM_RECORDS_WITHOUT_CHARGE");
  h.at(et("2026-11-20", "10:00"));
  const f = await h.run("draftVictimRecordsPackage", { op: "fulfil", request_id: String(r.request_id), outcome: "records_provided", document_ids: ["doc-app-1003", "doc-txn-ledger"] });
  assert.equal(f.status, "records_provided"); assert.equal(f.on_time, true); assert.equal(h.timer("FCRA_609E_VICTIM_RECORDS_30")?.status, "satisfied");
  const ev = h.ofType("identity_theft.request.fulfilled")[0]!; assert.equal(ev.payload.without_charge, true); assert.equal(ev.payload.outcome, "records_provided");
  assert.equal(h.rt.store.get("identity_theft_requests", String(r.request_id))!.data.charge_cents, "0");
  // an unverified request (no police report / affidavit) does not start the clock and cannot be fulfilled; a decline needs its (e)(5) ground
  const u = await h.run("draftVictimRecordsPackage", { requester: "victim", received_on: "2026-11-02", identity_proof: "doc-victim-id", claim_proof: "none" });
  assert.equal(u.verified, false); assert.equal(h.timers.byCode("FCRA_609E_VICTIM_RECORDS_30").length, 1);
  await h.refused(h.run("draftVictimRecordsPackage", { op: "fulfil", request_id: String(u.request_id), outcome: "records_provided", document_ids: ["x"] }), "VICTIM_REQUEST_NOT_VERIFIED");
  const r2 = receiveIdentityTheftRequest(h.events, { requester: "law_enforcement", application_id: APP, received_on: D("2026-11-02"), identity_proof: "badge", claim_proof: "ftc_affidavit", at: h.clock.now() });
  assert.throws(() => fulfilIdentityTheftRequest(h.events, r2.request, { outcome: "declined_e5", at: h.clock.now() }), (e: unknown) => e instanceof ScreeningRefused && e.code === "DECLINE_NEEDS_E5_GROUND");
  const dec = fulfilIdentityTheftRequest(h.events, r2.request, { outcome: "declined_e5", declined_reason: "request_based_on_misrepresentation", at: h.clock.now() });
  assert.equal(dec.request.status, "declined"); assert.equal(dec.request.declined_reason, "request_based_on_misrepresentation"); assert.equal(dec.event.payload.citation, "15 U.S.C. 1681g(e)(5)");
  assert.equal(h.timers.byCode("FCRA_609E_VICTIM_RECORDS_30").at(-1)?.status, "satisfied");
});

test("28.4-T10: Given the daily OFAC list refresh fails on Thu Nov 12, 2026, then `SM_OFAC_CLEAR_BEFORE_FUNDING_GATE` stays closed for every disbursement that day until a successful screen dated within 1 day exists; the funder cannot bypass the gate.", async () => {
  const h = harness(et("2026-11-12", "05:00"));
  programScheduleTick(h.events, { owner: "sm", job: "ofac_list_refresh", date: D("2026-11-12"), at: h.clock.now() });
  const daily = h.timer("SM_OFAC_LIST_REFRESH_DAILY")!; assert.equal(daily.status, "armed"); assert.equal(daily.dueDate, "2026-11-13");
  const failed = await h.run("screenParty", { op: "refresh", owner: "sm", date: "2026-11-12", succeeded: false, error: "SLS download timed out" });
  assert.equal(failed.type, "ofac.list.refresh.failed"); assert.equal(h.timer("SM_OFAC_LIST_REFRESH_DAILY")?.status, "armed");
  h.events.append({ type: "funding.requested", applicationId: APP, actor: { kind: "agent", id: "funding" }, payload: { application_id: APP, funding_id: "F-1" } });
  assert.equal(h.timer("SM_OFAC_CLEAR_BEFORE_FUNDING_GATE")?.status, "armed");
  const yesterday = [{ party_id: "B-A", screened_on: "2026-11-11", result: "clear", list_refreshed: true }, { party_id: "payee-1", screened_on: "2026-11-11", result: "clear", list_refreshed: true }];
  const facts = { disbursement_on: "2026-11-12", parties: ["B-A", "payee-1"], screens: yesterday, refresh_failed_dates: ["2026-11-12"] };
  const g = evaluateGate("28.4.ofacClearBeforeFundingGate", facts); assert.equal(g.open, false); assert.match(g.reason ?? "", /list refresh failed/);
  assert.equal(evaluateGate("28.4.ofacClearBeforeFundingGate", { ...facts, disbursement_on: "2026-11-13", refresh_failed_dates: [] }).open, false, "a Nov 11 screen is stale for a Nov 13 disbursement");
  assert.equal(evaluateGate("28.4.ofacClearBeforeFundingGate", { ...facts, refresh_failed_dates: [] }).open, true, "without the failure a screen dated within 1 day opens the gate");
  assert.throws(() => assertOfacGateOpen(facts, "disburse"), (e: unknown) => e instanceof ScreeningRefused && e.code === "SM_OFAC_CLEAR_BEFORE_FUNDING_GATE");
  // the funder cannot bypass: the fact and the tool flag both refuse
  assert.equal(evaluateGate("28.4.ofacClearBeforeFundingGate", { ...facts, refresh_failed_dates: [], bypass: true }).open, false);
  assert.equal(evaluateGate("28.4.ofacClearBeforeFundingGate", { ...facts, refresh_failed_dates: [], funder_override: true }).open, false);
  await h.refused(h.run("applyHold", { case_id: "none", op: "check", command: "disburse", bypass: true }, { kind: "human", id: "u-funder", role: "funding_approver" }), "NO_HOLD_BYPASS");
  // a successful re-run later that day (screens dated Nov 12 against the refreshed list) opens it for that disbursement; a potential hit keeps that payee closed
  h.at(et("2026-11-12", "11:30"));
  const ok = await h.run("screenParty", { op: "refresh", owner: "sm", date: "2026-11-12", succeeded: true, list_versions: { ofac_sdn: "SLS-2026-11-12" }, open_applications: 14, parties_rescreened: 61 });
  assert.equal(ok.type, "ofac.list.refreshed"); assert.equal(h.timers.byCode("SM_OFAC_LIST_REFRESH_DAILY")[0]?.status, "satisfied");
  const today = [{ party_id: "B-A", screened_on: "2026-11-12", result: "clear", list_refreshed: true }, { party_id: "payee-1", screened_on: "2026-11-12", result: "clear", list_refreshed: true }];
  assert.equal(evaluateGate("28.4.ofacClearBeforeFundingGate", { ...facts, screens: today }).open, true);
  const hit = evaluateGate("28.4.ofacClearBeforeFundingGate", { ...facts, screens: [today[0]!, { ...today[1]!, result: "potential" }] }); assert.equal(hit.open, false); assert.match(hit.reason ?? "", /payee-1: potential/);
  assert.equal(ofacClearBeforeFundingGate({ ...facts, screens: today, parties: ["B-A"] }).open, true, "the first-lien payoff and the borrower's proceeds are unaffected by another payee's hit");
});

test("28.4-T11: Given the independent test for 2026 is performed by the compliance officer, then the record is rejected (`independent_of_officer = false`) and `BSA_1029_210_INDEPENDENT_TEST` remains unsatisfied.", () => {
  const h = harness(et("2026-01-15", "06:00"));
  programScheduleTick(h.events, { owner: "sm", job: "bsa_independent_test", date: D("2026-01-15"), at: h.clock.now() });
  const t = h.timer("BSA_1029_210_INDEPENDENT_TEST")!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2027-01-15");
  const p = program();
  h.at(et("2026-11-30", "10:00"));
  const byOfficer = recordIndependentTest(h.events, p, { tester_id: "u-bsa", tester: "the compliance officer", period: "2026", report_document_id: "doc-test-2026", findings: [], at: h.clock.now() });
  assert.equal(byOfficer.accepted, false); assert.equal(byOfficer.independent_of_officer, false); assert.equal(byOfficer.event.type, "bsa.independent_test.rejected"); assert.equal(byOfficer.event.payload.independent_of_officer, false);
  assert.equal(byOfficer.program.independent_tests.length, 0, "the record is rejected");
  assert.equal(h.timer("BSA_1029_210_INDEPENDENT_TEST")?.status, "armed", "remains unsatisfied");
  const byAudit = recordIndependentTest(h.events, p, { tester_id: "u-internal-audit", tester: "internal audit", period: "2026", report_document_id: "doc-test-2026b", findings: ["training coverage gap"], remediation_due: D("2027-01-31"), at: h.clock.now() });
  assert.equal(byAudit.accepted, true); assert.equal(byAudit.program.independent_tests[0]!.independent_of_officer, true);
  assert.equal(h.timers.byCode("BSA_1029_210_INDEPENDENT_TEST")[0]?.status, "satisfied"); assert.equal(h.timers.byCode("BSA_1029_210_INDEPENDENT_TEST").at(-1)?.status, "armed", "the recurring row re-arms for the next year");
  // the other annual pillars run the same way: training for all appropriate persons; the officer-approved program review; the Red Flags board report
  programScheduleTick(h.events, { owner: "sm", job: "bsa_training", date: D("2026-11-30"), at: h.clock.now() });
  const tr = recordTraining(h.events, p, { appropriate_persons: ["u-bsa", "u-portal", "u-qc", "u-funder", "dev-fraud-risk"], completions: [{ person: "u-bsa", course: "BSA/AML 2026", completed_at: D("2026-02-01") }, { person: "u-portal", course: "BSA/AML 2026", completed_at: D("2026-02-01") }], as_of: D("2026-11-30"), at: h.clock.now() });
  assert.equal(tr.all_appropriate_persons, false); assert.deepEqual(tr.missing, ["u-qc", "u-funder", "dev-fraud-risk"]); assert.equal(h.timer("BSA_1029_210_TRAINING_ANNUAL")?.status, "armed");
  const tr2 = recordTraining(h.events, tr.program, { appropriate_persons: ["u-bsa", "u-portal", "u-qc", "u-funder", "dev-fraud-risk"], completions: ["u-qc", "u-funder", "dev-fraud-risk"].map((person) => ({ person, course: "BSA/AML 2026", completed_at: D("2026-11-30") })), as_of: D("2026-11-30"), at: h.clock.now() });
  assert.equal(tr2.all_appropriate_persons, true); assert.equal(h.timers.byCode("BSA_1029_210_TRAINING_ANNUAL")[0]?.status, "satisfied");
  programScheduleTick(h.events, { owner: "sm", job: "bsa_program_review", date: D("2026-11-30"), at: h.clock.now() });
  assert.throws(() => reviewProgram(h.events, p, { version: "2026.2", risk_assessment_document_id: "doc-ra-2026-11", risk_assessment_date: D("2026-11-15"), approved_by_senior_management_at: D("2026-11-30"), at: h.clock.now() }, AGENT), (e: unknown) => e instanceof ScreeningRefused && e.code === "PROGRAM_APPROVAL_IS_OFFICER_ACT");
  const rev = reviewProgram(h.events, p, { version: "2026.2", risk_assessment_document_id: "doc-ra-2026-11", risk_assessment_date: D("2026-11-15"), approved_by_senior_management_at: D("2026-11-30"), board_approved_at: D("2026-12-05"), at: h.clock.now() }, OFFICER);
  assert.equal(rev.program.next_review_due_on, "2027-11-30"); assert.equal(h.timers.byCode("BSA_1029_210_PROGRAM_REVIEW_ANNUAL")[0]?.status, "satisfied");
  programScheduleTick(h.events, { owner: "sm", job: "itpp_board_report", date: D("2026-11-30"), at: h.clock.now() });
  assert.throws(() => issueBoardReport(h.events, p, { period: "2026", content: { effectiveness: "x" }, report_document_id: "doc-board-2026", at: h.clock.now() }, OFFICER), (e: unknown) => e instanceof ScreeningRefused && e.code === "BOARD_REPORT_INCOMPLETE");
  issueBoardReport(h.events, p, { period: "2026", content: { effectiveness: "effective", service_provider_oversight: "SM controls reviewed", significant_incidents: "one impostor application", recommendations: "none" }, report_document_id: "doc-board-2026", at: h.clock.now() }, OFFICER);
  assert.equal(h.timers.byCode("FCRA_681_ITPP_BOARD_REPORT_ANNUAL")[0]?.status, "satisfied");
});

test("28.4-T12: Given a new appraiser onboarded Mon Oct 26, 2026 who appears on the FHFA SCP list, then the onboarding is blocked, `red_flag_events`/case records are created as applicable, and the A3-4-03 screening record shows the list version checked.", async () => {
  const h = harness(et("2026-10-26", "09:00"));
  const versions = { fhfa_scp: "SCP-2026-10-01", gsa_sam: "SAM-2026-10-24", hud_ldp: "LDP-2026-10-20" };
  const s = await h.run("screenParty", { op: "counterparty", party_id: "appraiser-77", party_kind: "appraiser", list_versions: versions, hits: [{ list: "fhfa_scp", entry: "SCP-0419" }] });
  assert.equal(s.blocked, true); assert.deepEqual(s.list_versions, versions); assert.deepEqual(s.red_flag, { category: "vendor_alert", red_flag_code: "EXCLUSION_LIST_HIT" });
  const ev = h.ofType("counterparty.screened")[0]!; assert.equal(ev.payload.onboarding, "blocked"); assert.equal(ev.payload.citation, "A3-4-03"); assert.deepEqual(ev.payload.list_versions, versions); assert.deepEqual(ev.payload.lists, ["fhfa_scp", "gsa_sam", "hud_ldp"]);
  assert.equal(h.rt.store.get("counterparty_screenings", String(s.screening_id))!.data.blocked, true);
  // the Red Flags row (22.6's table) and the fraud case open from the screening's signal
  const rf = logRedFlag(h.events, { application_id: APP, red_flag_code: "EXCLUSION_LIST_HIT", detected_at: h.clock.now(), detected_by: "fraud-risk", category: "vendor_alert", detail: { party_id: "appraiser-77", list: "fhfa_scp" } });
  assert.equal(rf.row.category, "vendor_alert"); assert.equal(h.ofType("red_flag.detected").length, 1);
  const signal = (s.case_signal as Signal); assert.equal(signal.signal_code, "exclusion_list_hit"); assert.equal(aggregateSignals([signal]).opens_case, true);
  const c = await h.run("openCase", { partner_id: PARTNER, opened_by: "fraud-risk onboarding screen", signals: [signal], scheme_hypotheses: ["appraisal_fraud"], amount_cents: 0n, subjects: [{ party_id: "appraiser-77", role: "appraiser" }] });
  assert.equal(c.triage_status, "open"); assert.equal(h.rt.store.get("cases", String(c.case_id))!.data.case_type, "fraud");
  // a clean appraiser is not blocked; a missing list version is refused (the record must show every list checked)
  const clean = screenCounterparty(h.events, { party_id: "appraiser-78", party_kind: "appraiser", list_versions: versions, hits: [], at: h.clock.now() }); assert.equal(clean.screening.blocked, false); assert.equal(clean.red_flag, null);
  assert.throws(() => screenCounterparty(h.events, { party_id: "appraiser-79", party_kind: "appraiser", list_versions: { fhfa_scp: "SCP-2026-10-01", gsa_sam: "", hud_ldp: "LDP-2026-10-20" }, hits: [], at: h.clock.now() }), RangeError);
});

test("28.4-T13: Given any `fraud-risk` agent decision record, then it contains investigation steps with evidence refs, `rule_set_versions`, `model_version`, `prompt_version`, `inputs_hash`, the officer review, and no `applicant_demographics` reads; 31.2 receives the monthly fraud-flag rate by channel and product.", async () => {
  const h = harness(et("2026-10-22", "10:00"));
  const base = { case_id: "case-1", signals: SIGNALS_EX1, investigation_steps: [{ tool: "orderIndependentVerification", source: "payroll vendor written VOE", result: "no bonus", evidence_refs: ["doc-voe-written"], at: h.clock.now() }], scheme_assessment: { hypotheses: ["employment_fabrication" as const], support: { employment_fabrication: 30 } }, amount_cents: 41_200_000n, triage_recommendation: "suspicious_determined" as const, rationale: "two independent sources contradict the bonus statement", confidence: 0.91, officer_review: { escalation_id: "esc-1", decision: "suspicious_determined", at: h.clock.now() }, sar: null, timers: ["BSA_1029_320_SAR_30"], model_version: "fraud-risk-2026.09", prompt_version: "p-2026-09-10", inputs: { documents: 3, voe: "written" }, reads: ["applications", "documents", "verifications"] };
  const rec = fraudRiskDecisionRecord(base);
  assert.deepEqual(rec.rule_set_versions, { bsa: "bsa.1029", ofac: "ofac.501", fnma: "fnma.selling.2026-09-02", fcra: "fcra.681" }); assert.deepEqual(rec.rule_set_versions, RULE_SET_VERSIONS);
  assert.match(rec.inputs_hash, /^[0-9a-f]{64}$/); assert.equal(rec.model_version, "fraud-risk-2026.09"); assert.equal(rec.prompt_version, "p-2026-09-10"); assert.equal(rec.officer_review?.escalation_id, "esc-1"); assert.equal(rec.investigation_steps[0]!.evidence_refs[0], "doc-voe-written");
  assert.throws(() => fraudRiskDecisionRecord({ ...base, reads: [...base.reads, "restricted_fl.applicant_demographics"] }), (e: unknown) => e instanceof ScreeningRefused && e.code === "NO_DEMOGRAPHIC_READS");
  assert.throws(() => fraudRiskDecisionRecord({ ...base, inputs: { ethnicity: "x" } }), ScreeningRefused);
  assert.throws(() => fraudRiskDecisionRecord({ ...base, officer_review: null }), (e: unknown) => e instanceof ScreeningRefused && e.code === "DECISION_NEEDS_OFFICER_REVIEW");
  assert.throws(() => fraudRiskDecisionRecord({ ...base, investigation_steps: [{ ...base.investigation_steps[0]!, evidence_refs: [] }] }), (e: unknown) => e instanceof ScreeningRefused && e.code === "DECISION_NEEDS_EVIDENCE");
  assert.throws(() => fraudRiskDecisionRecord({ ...base, model_version: "" }), RangeError);
  // through the bus: the decision row is queued with model/prompt versions; demographic inputs are refused before anything runs
  const w = await h.run("writeDecision", { ...base, amount_cents: "41200000" });
  assert.equal(w.recorded, true); assert.equal(h.decisions.length, 1); assert.equal(h.decisions[0]!.modelVersion, "fraud-risk-2026.09"); assert.equal(h.decisions[0]!.promptVersion, "p-2026-09-10"); assert.equal(h.decisions[0]!.ruleSetVersion, "bsa.1029;ofac.501;fnma.selling.2026-09-02;fcra.681");
  await h.refused(h.run("writeDecision", { ...base, reads: ["applicant_demographics"] }), "NO_DEMOGRAPHIC_INPUTS");
  await h.refused(h.run("aggregateSignals", { signals: SIGNALS_EX1, race: "x" }), "NO_DEMOGRAPHIC_INPUTS");
  // 31.2 receives the monthly fraud-flag rate by channel and product (no demographic joins)
  const m = monthlyFraudFlagRate(h.events, { period: "2026-10", applications: [{ application_id: "a1", channel: "retail_ai", product: "FNMA30", flagged: true }, { application_id: "a2", channel: "retail_ai", product: "FNMA30", flagged: false }, { application_id: "a3", channel: "retail_ai", product: "FNMA15", flagged: false }, { application_id: "a4", channel: "broker", product: "FNMA30", flagged: false }], at: h.clock.now() });
  assert.deepEqual(m.by_channel, { retail_ai: { flagged: 1, total: 3, rate_bps: 3333 }, broker: { flagged: 0, total: 1, rate_bps: 0 } });
  assert.deepEqual(m.by_product, { FNMA30: { flagged: 1, total: 3, rate_bps: 3333 }, FNMA15: { flagged: 0, total: 1, rate_bps: 0 } });
  assert.equal(m.event.type, "fraud.flag_rate.reported"); assert.equal(m.event.payload.consumer, "31.2"); assert.equal(m.event.payload.demographic_joins, false);
});

test("28.4-T14: Given the FinCEN April 10, 2026 NPRM is finalized with a compliance date, then `bsa_program` shows a risk assessment dated within 12 months and board approval, and only the version and compliance-date fields change.", () => {
  const p = program({ risk_assessment_date: D("2026-11-15"), board_approved_at: D("2026-12-05"), version: "2026.2" });
  const r = bumpProgramForFinalRule(p, { compliance_date: D("2028-01-01"), version: "2027.1-final-rule", as_of: D("2027-03-01") });
  assert.equal(r.ready, true); assert.deepEqual(r.gaps, []); assert.deepEqual(r.changed_fields, ["version", "compliance_date"]);
  assert.equal(r.program.version, "2027.1-final-rule"); assert.equal(r.program.compliance_date, "2028-01-01");
  assert.equal(r.program.risk_assessment_date, "2026-11-15"); assert.equal(r.program.board_approved_at, "2026-12-05"); assert.equal(r.program.compliance_officer_id, "u-bsa"); assert.equal(r.program.risk_assessment_document_id, "doc-ra-2026");
  // a stale risk assessment or a missing board approval is a gap the compliance date exposes
  const stale = bumpProgramForFinalRule(program({ risk_assessment_date: D("2026-01-10"), board_approved_at: null }), { compliance_date: D("2028-01-01"), version: "2027.1", as_of: D("2027-03-01") });
  assert.equal(stale.ready, false); assert.deepEqual(stale.gaps, ["risk assessment not dated within 12 months", "no board approval"]);
});

test("28.4 worked figures: example 1 (detection Mon Oct 19, 2026 → SAR due Wed Nov 18; drafted Oct 26 → officer decision by Oct 31; filed Fri Oct 30 → retained to Oct 30, 2031; no self-report on an undelivered loan), example 2 (not_suspicious Dec 18 → no_file; counterfactual Dec 18 → SAR and LQC due Sun Jan 17, 2027, filed by Fri Jan 15; OFAC block Fri Nov 13 with $41,250.00 held → blocked account posting, ORS report due Mon Nov 30, retained to Nov 13, 2036; sanctions-nexus SAR due Sun Dec 13 filed by Fri Dec 11)", async () => {
  // example 1: the $412,000 purchase application (the $5,000 test is met by the loan amount); the $14,600 bonus statement is the fabricated document
  const amt = computeAmount({ kind: "origination", loan_amount_cents: 41_200_000n }); assert.equal(amt.amount_cents, 41_200_000n); assert.equal(amt.sar_mandatory, true);
  assert.equal(computeAmount({ kind: "aml", transaction_amount_cents: 1_460_000n }).sar_mandatory, true); assert.equal(computeAmount({ kind: "aml", transaction_amount_cents: 499_999n, subject_identified: true, activity_is_crime: true }).sar_voluntary_policy, true);
  assert.equal(aggregateSignals(SIGNALS_EX1).score, 100); assert.ok(aggregateSignals(SIGNALS_EX1).score >= CASE_THRESHOLD);
  assert.deepEqual(sarDeadlines(D("2026-10-19"), true), { filing_due_on: "2026-11-18", outer_limit_on: "2026-12-18", policy_file_by: "2026-11-18" });
  assert.equal(officerDecisionDue(D("2026-10-26"), D("2026-11-18")), "2026-10-31");
  assert.equal(officerDecisionDue(D("2026-11-14"), D("2026-11-18")), "2026-11-15", "never past the SAR deadline − 3 days");
  assert.equal(sarRetentionUntil(D("2026-10-30")), "2031-10-30");
  assert.equal(fnmaReportChannel({ delivered_or_committed: false, third_party_scheme: false, partner_elects: false }), null, "never delivered or committed; no third party implicated");
  assert.equal(interviewQuestionAllowed("Can you help us understand the bonus shown on the statement you uploaded?").allowed, true);
  assert.equal(interviewQuestionAllowed("Did you forge the bonus statement? This is under investigation.").allowed, false);
  // example 2(a): triage not_suspicious Fri Dec 18 → sar_decisions{no_file}; the counterfactual anchors Dec 18 → due Sun Jan 17, 2027 → filed by Fri Jan 15; LQC due the same day
  assert.deepEqual(sarDeadlines(D("2026-12-18"), true), { filing_due_on: "2027-01-17", outer_limit_on: "2027-02-16", policy_file_by: "2027-01-15" });
  assert.equal(selfReportDue(D("2026-12-18")), "2027-01-17"); assert.equal(fnmaSubmitByPolicy(D("2027-01-17")), "2027-01-15");
  const h = harness(mst("2026-12-09", "09:00"));
  const o = await h.openCase({ loan_id: "loan-refi-1", application_open: false, signals: [{ source_process: "28.2", signal_code: "qc_fraud_misrepresentation", evidence_refs: ["qc-review-nov"], score: 70 }], scheme_hypotheses: ["occupancy_misrep"] });
  assert.equal(o.production_hold, false, "a purchased loan carries no production hold");
  h.at(mst("2026-12-18", "15:00"));
  const t = await h.run("recommendTriage", { op: "record", case_id: String(o.case_id), decision: "not_suspicious", rationale: "occupancy changed after closing: lease signed Nov 20, transfer offer Nov 30" }, BSA);
  assert.equal(t.triage_status, "not_suspicious"); assert.equal(t.initial_detection_at, null);
  const c = caseRow(h, String(o.case_id)); assert.equal(c.decision_reasons_for_no_sar, "occupancy changed after closing: lease signed Nov 20, transfer offer Nov 30");
  assert.throws(() => closeCase(h.events, c, { sar_decision: null, at: h.clock.now(), outcome: "occupancy-watch item (28.2)" }, BSA), (e: unknown) => e instanceof ScreeningRefused && e.code === "CLOSE_NEEDS_SAR_DECISION");
  const noFile = { decision_id: "dec-nofile", case_id: c.case_id, sar_id: null, decision: "no_file" as const, rationale: c.decision_reasons_for_no_sar!, decided_by: "u-bsa", decided_at: h.clock.now(), review_period_days: null, next_review_due_at: null };
  h.rt.store.put("sar_decisions", noFile.decision_id, noFile, BSA, h.clock.now());
  const closed = await h.run("recommendTriage", { op: "close", case_id: c.case_id, decision_id: "dec-nofile", rationale: "closed with no_file; 28.2 occupancy-watch item" }, BSA); assert.equal(closed.triage_status, "closed");
  assert.equal(h.ofType("fnma.fraud.reasonable_basis").length, 0, "no Fannie Mae report without a reasonable basis");
  // example 2(b): the payee blocked Fri Nov 13 → $41,250.00 to the blocked interest-bearing account; report due Mon Nov 30; retained to Nov 13, 2036; sanctions-nexus SAR due Sun Dec 13 → filed by Fri Dec 11
  const posting = blockedFundsPosting({ value_cents: 4_125_000n, effective_on: D("2026-11-13"), account_ref: "blocked-acct-1", hit_id: "hit-1" });
  assert.equal(posting.lines[0]!.amountCents, 4_125_000n); assert.equal(posting.lines[1]!.amountCents, -4_125_000n); assert.equal(posting.lines.reduce((a, l) => a + l.amountCents, 0n), 0n);
  assert.equal(posting.lines[0]!.account.scope, "custodial"); assert.match(posting.lines[0]!.ruleRef, /501\.603/); assert.match(posting.lines[1]!.memo ?? "", /blocked_property_liability/);
  assert.throws(() => blockedFundsPosting({ value_cents: 0n, effective_on: D("2026-11-13"), account_ref: "x", hit_id: "h" }), RangeError);
  assert.equal(ofacReportDue(D("2026-11-13")), "2026-11-30"); assert.equal(ofacRecordsRetainedUntil(D("2026-11-13")), "2036-11-13");
  assert.deepEqual(sarDeadlines(D("2026-11-13"), true), { filing_due_on: "2026-12-13", outer_limit_on: "2027-01-12", policy_file_by: "2026-12-11" });
  const h2 = harness(et("2026-11-13", "10:00"));
  const hit = recordOfacHit(h2.events, { screening_id: "scr-payee-2", party_id: "payee-second-lien", application_id: APP, list: "sdn", entry_uid: "SDN-12345", match_score: 96, match_fields: ["name", "city", "country_of_registration"], at: h2.clock.now() });
  const conf = dispositionOfacHit(h2.events, hit.hit, { disposition: "confirmed_match", analysis: "name + city + country of registration", at: h2.clock.now(), blocked_property: { description: "second-lien payoff payee", value_cents: 4_125_000n, location: "settlement flow", account_ref: "blocked-acct-1" } }, BSA);
  assert.equal(conf.report_due_on, "2026-11-30"); assert.equal(conf.ledger?.lines[0]!.amountCents, 4_125_000n); assert.equal(h2.timer("OFAC_501_603_BLOCKED_REPORT_10BD")?.dueDate, "2026-11-30");
  assert.equal((h2.ofType("ofac.property.blocked")[0]!.payload as { value_cents: string }).value_cents, "4125000");
  assert.equal(annualReportRequired(conf.hit, D("2027-06-30")), true, "still blocked as of June 30, 2027 → annual report by Sept 30, 2027");
  const sub = submitOfacReport(h2.events, conf.hit, { kind: "blocked_initial", ors_reference: "ORS-2026-11-18", content_document_id: "doc-ors", at: et("2026-11-18", "10:00") }, BSA);
  assert.equal(sub.report.late, false); assert.equal(sub.hit.retention_until, null);
  // the hold state 22.6's assertNoFraudHold reads and 28.4's wider block list
  const h3 = harness(et("2026-10-19", "09:52")); const o3 = await h3.openCase();
  assert.equal(h3.rt.store.get("applications", APP)!.data.fraud_hold, true);
  assert.throws(() => assertNoFraudHold(h3.rt.store.get("applications", APP)!.data as { fraud_hold: boolean }, "issueCD"), FraudHoldBlocked);
  for (const cmd of ["issueCD", "consummate", "disburse", "submitDelivery"]) await h3.refused(h3.run("applyHold", { case_id: String(o3.case_id), op: "check", command: cmd }), "FRAUD_HOLD");
  assert.throws(() => assertNoProductionHold(caseRow(h3, String(o3.case_id)), "submitDelivery"), (e: unknown) => e instanceof ScreeningRefused && e.code === "FRAUD_HOLD");
  await h3.refused(h3.run("applyHold", { case_id: String(o3.case_id), op: "release", path: "decision_path_chosen", rationale: "x" }), "HOLD_RELEASE_NEEDS_TRIAGE");
  assert.equal(signalFromEvent(h3.events.append({ type: "qc.fraud_referral.requested", applicationId: APP, actor: { kind: "agent", id: "qc-audit" }, payload: { application_id: APP, finding_id: "f-1" } }))?.signal_code, "qc_fraud_misrepresentation");
  assert.equal(signalFromEvent(h3.events.append({ type: "funding.fraud_case.requested", applicationId: APP, actor: { kind: "agent", id: "funding" }, payload: { application_id: APP, funding_id: "F-1" } }))?.source_process, "26.3");
  assert.equal(recordStep(h3.events, caseRow(h3, String(o3.case_id)), { tool: "screenParty", source: "OFAC SLS", result: "clear", evidence_refs: ["scr-1"], at: h3.clock.now() }).fraud_case.triage_status, "under_review");
  // the immediate-attention protocol: same-day notice; the agent alone is refused, the agent with the officer paged is not
  const h4 = harness(et("2026-10-19", "09:52")); const o4 = await h4.openCase();
  await h4.run("recommendTriage", { op: "record", case_id: String(o4.case_id), decision: "suspicious_determined", subject_identified: true, requires_immediate_attention: true, rationale: "ongoing wire theft" }, BSA);
  const le = h4.timer("BSA_1029_320_IMMEDIATE_LE_NOTICE")!; assert.equal(le.status, "armed"); assert.equal(le.dueDate, "2026-10-19");
  await h4.refused(h4.run("openOfficerEscalation", { op: "notify_le", case_id: String(o4.case_id), agency: "FBI field office" }), "LE_CONTACT_NEEDS_OFFICER");
  assert.throws(() => notifyLawEnforcement(h4.events, { ...caseRow(h4, String(o4.case_id)), requires_immediate_attention: false }, { agency: "FBI", method: "telephone", at: h4.clock.now(), officer_paged: true }, AGENT), (e: unknown) => e instanceof ScreeningRefused && e.code === "LE_CONTACT_NEEDS_OFFICER");
  const n = await h4.run("openOfficerEscalation", { op: "notify_le", case_id: String(o4.case_id), agency: "FBI field office", officer_paged: true });
  assert.ok(n.notified_at); assert.equal(h4.timer("BSA_1029_320_IMMEDIATE_LE_NOTICE")?.status, "satisfied"); assert.equal(h4.escalations("bsa_officer").length, 1);
  // the case's hold releases on a chosen decision path; the OFAC screening path records hits through 22.6's screener
  const rel = releaseProductionHold(h4.events, caseRow(h4, String(o4.case_id)), { rationale: "denial via 21.6 chosen", at: h4.clock.now(), path: "decision_path_chosen" }, BSA); assert.equal(rel.fraud_case.production_hold, false);
  const cand: OfacCandidate = { list: "ofac_sdn", sdn_name: "X", program: "SDGT", date_of_birth: null, nationality: null, id_numbers: [], score: 91 };
  const h5 = harness(et("2026-11-12", "10:00"), { ofac: new FakeOfacScreener({ "payee-2": [cand] }) }); const o5 = await h5.openCase();
  const scr = await h5.run("screenParty", { case_id: String(o5.case_id), party_id: "payee-2", party_role: "settlement_agent", name: "Payee Two", lists: [{ list: "ofac_sdn", version: "SLS-2026-11-12", published_on: "2026-11-12" }] });
  assert.equal(scr.result, "potential_match"); assert.equal((scr.hits as { match_score: number }[])[0]!.match_score, 91); assert.equal(h5.rt.store.list("ofac_hits").length, 1);
  assert.throws(() => applyProductionHold(h5.events, { ...caseRow(h5, String(o5.case_id)), application_id: null }, h5.clock.now()), (e: unknown) => e instanceof ScreeningRefused && e.code === "HOLD_NEEDS_OPEN_APPLICATION");
});
