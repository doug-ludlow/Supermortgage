// 18.5 Mortgage fraud reporting
// spec/sections/18-qc-audit-regulatory-reporting/18-5-mortgage-fraud-reporting.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { servicerCalendar, addBusinessDays, defaultCalendars, type CalendarSet } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { reportDraftGate, breachSelfReportTrigger, quarterEndOf, fraudFlagFairness } from "./ops.ts";
import { caseScore, breachSelfReportDue, fraudClocks, ofacEmailDueMs, lawFirmFraudNoticeDue, protectiveHoldExpires, assignmentAllowed } from "./fraud.ts";
import {
  agentDeterminationProposal, breachSelfReportClock, selfReportRequiredEvent, quarterlyFlagFairnessReview, leReferralDecision, leReferralDecidedEvent, partnerNoticeLegs, LE_REFERRAL_EXPOSURE_THRESHOLD_CENTS, LE_REFERRAL_SCHEMES,
  payoffWireChangeFlag, openFraudCase, contactGuard, caseStatusChangedEvent, fraudPartnerNotifiedEvent, protectiveHold, payoffDisbursementGate, caseAssignment, employeeDishonestyFollowUp, coveredLossDiscoveredEvent,
  determinationRecordedEvent, determinationActor, reportSigner, diligenceBreach, breachEscalation, breachRoles, fraudReportFiledEvent, reportFilingOutcome, fnmaSelfReportPackage, FNMA_SELF_REPORT_ELEMENTS,
  ofacEthicsNotice, lawFirmFraudEscalation, cyberIncidentNoticeEvent, ofacMatchConfirmedEvent, OFAC_LISTS, OFAC_MATCH_FLAG_SCORE, aggregateCaseScore, type RedFlag,
} from "./ops-18-5.ts";
import { incidentNoticeSent } from "../data-security/ops-19-2.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import type { Actor } from "../../kernel/events/types.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { FRAUD_TOOLS_18_5, TOOLS_18_5 } from "../../app/tools/section18-5.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

const ET = "America/New_York";
const at = (d: string, hhmm: string): string => toIso(zonedEpochMs(D(d), hhmm, ET));
/** A registry with every section override applied and an engine arming only 18.5 rows. */
function engine(nowIso: string, calendars?: CalendarSet): { clock: FixedClock; events: MemoryEventStore; timers: TimerEngine } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  return { clock, events, timers: new TimerEngine(loadOverriddenRegistry(), events, { processes: ["18.5"], ...(calendars ? { calendars } : {}) }) };
}
const AGENT_ACTOR: Actor = { kind: "agent", id: "qc-audit" };
const FRAUD_OFFICER: Actor = { kind: "human", id: "officer:fraud_officer/jlee", role: "fraud_officer" };
const SIGNING_OFFICER: Actor = { kind: "human", id: "officer/mroe", role: "officer" };
const ATTORNEY: Actor = { kind: "human", id: "attorney/pnair", role: "attorney" };
const ANALYST: Actor = { kind: "human", id: "analyst/kwu", role: "ops_analyst" };
type Out = Record<string, unknown>;
/** A one-process bus over the 18.5 fraud tools with the overridden registry's 18.5 timers armed by the events the handlers append (the arrangement 18-4/18-6 use). */
function bus18_5(nowIso: string): { bus: CommandBus; clock: FixedClock; events: MemoryEventStore; timers: TimerEngine; rt: ToolRuntime; decisions: DecisionInput[]; run: (name: string, input: Record<string, unknown>, actor?: Actor) => Promise<Out>; refused: (name: string, input: Record<string, unknown>, actor?: Actor) => Promise<CommandRefused> } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["18.5"] });
  const ctx = { loanId: "", events, ledger: new MemoryLedger(), timers, clock, decide: (d: DecisionInput) => { decisions.push(d); } } as UowContext;
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const escalates = loadAgentsFile().processes.find((p) => p.process === "18.5")!.escalates_to;
  const cmds = new Map(FRAUD_TOOLS_18_5.map((d) => { const c = toolCommand(d, rt, escalates); agents.registerTool(d.agent, c.name); return [d.name, c] as const; }));
  const run = (name: string, input: Record<string, unknown>, actor: Actor = AGENT_ACTOR): Promise<Out> => { const c = cmds.get(name); if (!c) throw new RangeError(`no 18.5 tool ${name}`); return bus.execute(c, actor, input, ctx).then((r) => r.output as Out); };
  const refused = async (name: string, input: Record<string, unknown>, actor: Actor = AGENT_ACTOR): Promise<CommandRefused> => { try { await run(name, input, actor); } catch (e) { if (e instanceof CommandRefused) return e; throw e; } throw new Error(`${name} was not refused`); };
  return { bus, clock, events, timers, rt, decisions, run, refused };
}
const CASE = "FR-2026-0412";
const OFFICER = { determination: "reasonable_basis" as const, determined_by_officer_id: "officer:fraud_officer/jlee", determined_by_role: "officer:fraud_officer", determined_at: D("2026-10-14") };
const SIGNED = { signed_by_officer_id: "officer/mroe", signed_by_role: "officer" } as const;
/** T1 red flag: payoff request 2026-10-05, wire instructions changed 2026-10-02 (3 days earlier), no verified call-back. */
const FLAG: RedFlag = payoffWireChangeFlag({ loan_id: "L-16", payoff_requested_on: D("2026-10-05"), wire_changed_on: D("2026-10-02"), callback_verified: false }).flag!;
const RECORD = { case_id: CASE, flags: ["PAYOFF_WIRE_CHANGE"], score: caseScore(["PAYOFF_WIRE_CHANGE"]), hypotheses: ["third-party payoff diversion via business-email compromise"], evidence_refs: ["sha256:9f1c…wire-change", "sha256:4ab0…callback-log"], recommended_determination: "reasonable_basis" as const, confidence: 0.95, model_version: "fraud-model-2026.09", prompt_version: "fraud-memo-v3" };
const HOLD_REASON = "PAYOFF_WIRE_CHANGE: payoff disbursement held pending verified call-back (16.x)";

test("18.5-T1: Given a payoff request and a wire-instruction change 3 days earlier without verified call-back, then a P1 case opens with score 90, the payoff disbursement is held, the partner is notified within 1 BD, and a call-back task is created for a human agent.", () => {
  // rule 1 detector: change within 10 days of the request and not confirmed by call-back → PAYOFF_WIRE_CHANGE score 90
  const det = payoffWireChangeFlag({ loan_id: "L-16", payoff_requested_on: D("2026-10-05"), wire_changed_on: D("2026-10-02"), callback_verified: false });
  assert.equal(det.days_between, 3); assert.equal(det.within_window, true);
  assert.equal(det.flag?.flag_code, "PAYOFF_WIRE_CHANGE"); assert.equal(det.flag?.score, 90); assert.equal(det.flag?.source_event, "payoff.wire_instructions.changed"); assert.equal(det.flag?.detector, "RULE_PAYOFF_WIRE_CHANGE_10D_v1");
  assert.equal(payoffWireChangeFlag({ loan_id: "L-16", payoff_requested_on: D("2026-10-05"), wire_changed_on: D("2026-10-02"), callback_verified: true }).flag, null);      // confirmed by call-back to a number on file
  assert.equal(payoffWireChangeFlag({ loan_id: "L-16", payoff_requested_on: D("2026-10-05"), wire_changed_on: D("2026-09-24"), callback_verified: false }).flag, null);     // 11 days: outside the window
  assert.equal(payoffWireChangeFlag({ loan_id: "L-16", payoff_requested_on: D("2026-10-05"), wire_changed_on: D("2026-09-25"), callback_verified: false }).flag?.score, 90); // day 10 is within
  // the case: score 90 → P1; payoff disbursement held (30-day time box); partner within 1 BD (Tue 2026-10-06); call-back task to a human agent
  const c = openFraudCase({ case_id: CASE, loan_id: "L-16", flags: [det.flag!], opened_on: D("2026-10-05") });
  assert.equal(c.score, 90); assert.equal(c.priority, "P1"); assert.equal(c.status, "flagged"); assert.deepEqual(c.flags, ["PAYOFF_WIRE_CHANGE"]);
  assert.deepEqual(c.protective_actions.map((a) => [a.action, a.placed_on, a.expires_on, a.reversible, a.renewable_by]), [["hold_payoff_disbursement", "2026-10-05", "2026-11-04", true, "officer:fraud_officer"]]);
  // the hold is the `loans.fraud_hold` row (0050: flag, reason, expiry, case) and the `loan.fraud_hold.set` event; 16.x's payoff gate reads the row and holds the disbursement
  assert.deepEqual(c.loan_fraud_hold, { loan_id: "L-16", fraud_hold: true, fraud_hold_reason: HOLD_REASON, fraud_hold_expires_on: "2026-11-04", fraud_hold_case_id: CASE });
  assert.equal(c.loan_fraud_hold_event?.type, "loan.fraud_hold.set"); assert.equal(c.loan_fraud_hold_event?.loanId, "L-16"); assert.equal(c.loan_fraud_hold_event?.payload.expires_on, "2026-11-04");
  assert.deepEqual(payoffDisbursementGate({ loan: c.loan_fraud_hold!, today: D("2026-10-05") }), { gate: "SM_FRAUD_PAYOFF_HOLD", open: false, payoff_disbursement: "held", reason: `payoff disbursement held: ${HOLD_REASON} (expires 2026-11-04)`, expires_on: "2026-11-04" });
  assert.deepEqual(c.partner_notice, { required: true, timer: "SM_FRAUD_PARTNER_NOTIFY_1BD", due: "2026-10-06" });
  assert.deepEqual(c.tasks, [{ kind: "callback_verification", assigned_to: "human_agent", agent_may_call: false, numbers: "numbers_of_record", script_drafted_by: "qc-audit" }]);
  const cb = c.escalations.find((e) => e.kind === "human_agent")!; assert.match(cb.reason, /call-back verification/); assert.match(cb.reason, /never contacts suspected perpetrators/); assert.equal(cb.due, "2026-10-06");
  const p1 = c.escalations.find((e) => e.kind === "fraud_officer")!; assert.equal(p1.severity, "sev2"); assert.match(p1.reason, /same-day investigation/); assert.equal(p1.due, "2026-10-05");
  assert.deepEqual(c.timers, [{ code: "SM_FRAUD_TRIAGE_2BD", due: "2026-10-07" }, { code: "SM_FRAUD_DUE_DILIGENCE_15", due: "2026-10-20" }, { code: "SM_FRAUD_PARTNER_NOTIFY_1BD", due: "2026-10-06" }]);
  assert.equal(c.event.type, "fraud.case.opened"); assert.equal(c.event.payload.score, 90); assert.equal(c.event.payload.partner_notice_leg, "open"); assert.equal(c.event.payload.opened_at, "2026-10-05");
  // guardrail: the agent never contacts suspected perpetrators; call-backs are human acts
  const guard = contactGuard({ actor_kind: "agent", target: "suspected_perpetrator" }); assert.equal(guard.allowed, false); assert.match(guard.refusal!, /never contacts suspected perpetrators/); assert.equal(guard.route, "human_agent");
  assert.equal(contactGuard({ actor_kind: "agent", target: "number_of_record" }).route, "human_agent"); assert.equal(contactGuard({ actor_kind: "human", target: "number_of_record" }).allowed, true); assert.equal(contactGuard({ actor_kind: "agent", target: "partner" }).allowed, true);
  // registry: `fraud.case.opened{score=90, partner_notice_leg=open}` arms triage (2 BD → 2026-10-07), diligence (15 cd → 2026-10-20) and the partner leg (1 BD → 2026-10-06)
  const { clock, events, timers } = engine(at("2026-10-05", "10:00"));
  events.append({ ...c.event, occurredAt: at("2026-10-05", "10:00") });
  assert.deepEqual(Object.fromEntries(timers.all().map((t) => [t.code, t.dueDate])), { SM_FRAUD_TRIAGE_2BD: "2026-10-07", SM_FRAUD_DUE_DILIGENCE_15: "2026-10-20", SM_FRAUD_PARTNER_NOTIFY_1BD: "2026-10-06" });
  // an unevidenced partner notice is no notice; the evidenced one on 2026-10-06 satisfies the 1-BD row; triage satisfies its row
  assert.equal(fraudPartnerNotifiedEvent({ case_id: CASE, loan_id: "L-16", leg: "open", evidence_document_id: null, notified_on: D("2026-10-06") }), null);
  clock.set(at("2026-10-06", "09:00"));
  events.append({ ...fraudPartnerNotifiedEvent({ case_id: CASE, loan_id: "L-16", leg: "open", evidence_document_id: "doc-partner-notice-1", notified_on: D("2026-10-06") })!, occurredAt: at("2026-10-06", "09:00") });
  assert.equal(timers.byCode("SM_FRAUD_PARTNER_NOTIFY_1BD")[0]!.status, "satisfied");
  events.append({ ...caseStatusChangedEvent({ case_id: CASE, loan_id: "L-16", status: "triaged", score: 90, priority: "P1" }), occurredAt: at("2026-10-06", "09:30") });
  assert.equal(timers.byCode("SM_FRAUD_TRIAGE_2BD")[0]!.status, "satisfied"); assert.equal(timers.byCode("SM_FRAUD_DUE_DILIGENCE_15")[0]!.status, "armed");
  // a P3 flag (score 50) opens no partner leg, no hold and no call-back task
  const p3 = openFraudCase({ case_id: "FR-2026-0413", loan_id: "L-17", flags: [{ ...det.flag!, flag_code: "INCOME_DOC_INCONSISTENT", score: 50 }], opened_on: D("2026-10-05") });
  assert.equal(p3.score, 50); assert.equal(p3.priority, "P3"); assert.equal(p3.partner_notice.required, false); assert.equal(p3.event.payload.partner_notice_leg, undefined); assert.deepEqual(p3.protective_actions, []); assert.deepEqual(p3.tasks, []); assert.equal(p3.loan_fraud_hold, null); assert.equal(p3.loan_fraud_hold_event, null);
  // the BEC behind the payoff diversion is a Section 19 incident: `security.incident.identified` (identified_at) arms FNMA_ISBR_CYBER_INCIDENT_36H for 36 clock hours (Mon 14:00 ET → Wed 02:00 ET)
  const inc = engine(at("2026-10-05", "14:00"));
  inc.events.append({ type: "security.incident.identified", actor: SYSTEM, occurredAt: at("2026-10-05", "14:00"), aggregate: { kind: "security_incident", id: "INC-2026-77" }, payload: { incident_id: "INC-2026-77", severity: "S2", category: "bec", identified_at: at("2026-10-05", "14:00"), fraud_case_id: CASE } });
  const isbrT = inc.timers.byCode("FNMA_ISBR_CYBER_INCIDENT_36H")[0]!; assert.equal(toIso(isbrT.dueAt!), at("2026-10-07", "02:00"));
  // the notice to privacy_office@fanniemae.com is Section 19's send (incident_notices.recipient = fannie_mae_supplement): unevidenced or non-officer sends are refused
  assert.match(cyberIncidentNoticeEvent({ incident_id: "INC-2026-77", case_id: CASE, sent_at: null, sent_by_role: "officer", evidence_document_id: null, bec_payoff_diversion: true }).refusal!, /no notice to privacy_office@fanniemae.com/);
  assert.match(cyberIncidentNoticeEvent({ incident_id: "INC-2026-77", case_id: CASE, sent_at: at("2026-10-06", "12:00"), sent_by_role: "qc-audit", evidence_document_id: "doc-privacy-office-1", bec_payoff_diversion: true }).refusal!, /sent by an officer/);
  const cyber = cyberIncidentNoticeEvent({ incident_id: "INC-2026-77", case_id: CASE, sent_at: at("2026-10-06", "12:00"), sent_by_role: "officer", sent_by_id: "officer/mroe", evidence_document_id: "doc-privacy-office-1", bec_payoff_diversion: true });
  assert.equal(cyber.refusal, null); assert.equal(cyber.event!.type, "incident.notice.sent"); assert.equal(cyber.event!.payload.recipient, "fannie_mae_supplement"); assert.equal(cyber.event!.payload.template_code, "NTC_FNMA_INCIDENT_36H"); assert.equal(cyber.event!.payload.case_id, CASE); assert.equal(cyber.row!.recipient, "fannie_mae_supplement");
  // and it is the very event Section 19's own builder emits for that send — appended as 19.2 does, it closes the 18.5 row
  const s19 = incidentNoticeSent({ incident_id: "INC-2026-77", recipient: "fannie_mae_supplement", template_code: "NTC_FNMA_INCIDENT_36H", sent_ms: zonedEpochMs(D("2026-10-06"), "12:00", ET), sent_by_role: "officer", channel: "email", evidence_document_id: "doc-privacy-office-1" });
  assert.deepEqual({ type: s19.event.type, recipient: s19.event.payload.recipient, aggregate: s19.event.aggregate }, { type: cyber.event!.type, recipient: cyber.event!.payload.recipient, aggregate: cyber.event!.aggregate });
  inc.clock.set(at("2026-10-06", "12:00"));
  inc.events.append({ ...s19.event, actor: { kind: "human", id: "officer/mroe", role: "officer" } });
  assert.equal(isbrT.status, "satisfied");
  const isbr = loadOverriddenRegistry().get("FNMA_ISBR_CYBER_INCIDENT_36H")!; assert.equal(isbr.anchorField, "identified_at"); assert.deepEqual(isbr.offsetParsed, { kind: "step", n: 36, unit: "hours" });
  assert.deepEqual(isbr.satisfiedPattern!.conditions, [{ field: "recipient", op: "=", value: "fannie_mae_supplement" }]);
  assert.deepEqual(isbr.satisfiedPattern, loadOverriddenRegistry().get("FNMA_SUPP_INCIDENT_NOTICE_36H")!.satisfiedPattern);   // one send, both rows: the same pattern 19.2's row closes on
});
test("18.5-T2: Given a red flag on 2026-10-05 and a `reasonable_basis` determination on 2026-10-14, then `FNMA_A3403_FRAUD_REPORT_30` is due 2026-11-13 with internal target 2026-11-03; a filing on 2026-11-14 is recorded as breached.", () => {
  const c = fraudClocks(D("2026-10-05"), D("2026-10-14"));
  assert.equal(c.diligence_due, "2026-10-20"); assert.equal(c.fnma_report_due, "2026-11-13"); assert.equal(c.internal_target, "2026-11-03");
  // a filing on 2026-11-14 with the LQC reference is recorded as breached (satisfied_late, sev-1 → officer + partner); on 2026-11-03 it is on time; without the LQC reference it is no filing
  const late = reportFilingOutcome({ case_id: CASE, determination_at: D("2026-10-14"), filed_on: D("2026-11-14"), lqc_reference: "LQC-SR-2026-0042" });
  assert.equal(late.due, "2026-11-13"); assert.equal(late.internal_target, "2026-11-03"); assert.equal(late.breached, true); assert.equal(late.status, "satisfied_late"); assert.equal(late.satisfies_timer, true);
  assert.equal(late.escalations[0]?.kind, "officer"); assert.equal(late.escalations[0]?.severity, "sev1"); assert.match(late.escalations[0]!.reason, /due 2026-11-13, filed 2026-11-14/); assert.match(late.escalations[0]!.reason, /partner/);
  const onTime = reportFilingOutcome({ case_id: CASE, determination_at: D("2026-10-14"), filed_on: D("2026-11-03"), lqc_reference: "LQC-SR-2026-0042" });
  assert.equal(onTime.breached, false); assert.equal(onTime.status, "satisfied"); assert.deepEqual(onTime.escalations, []);
  const noRef = reportFilingOutcome({ case_id: CASE, determination_at: D("2026-10-14"), filed_on: D("2026-11-03"), lqc_reference: null });
  assert.equal(noRef.satisfies_timer, false); assert.equal(noRef.status, "open"); assert.match(noRef.refusal!, /no LQC reference/);
  assert.equal(reportFilingOutcome({ case_id: CASE, determination_at: D("2026-10-14"), filed_on: null, lqc_reference: null, today: D("2026-11-14") }).status, "breached");
  // registry: the fraud officer's reasonable_basis determination on 2026-10-14 arms the 30-day row (anchor determination_at) → due 2026-11-13
  const { clock, events, timers } = engine(at("2026-10-14", "15:00"));
  const det = determinationRecordedEvent({ case_id: CASE, loan_id: "L-16", officer: OFFICER, exposure_cents: 41_250_000n, flags: ["PAYOFF_WIRE_CHANGE"] })!;
  assert.equal(det.type, "fraud.determination.recorded"); assert.equal(det.payload.reasonable_basis, true); assert.equal(det.payload.determination_at, "2026-10-14"); assert.equal(det.payload.le_referral_candidate, true); assert.equal(det.payload.partner_notice_leg, "determination");
  assert.deepEqual(det.actor, { kind: "human", id: "officer:fraud_officer/jlee", role: "fraud_officer" }); assert.equal(det.payload.determined_by_role, "officer:fraud_officer");
  // role-checked, not presence-checked: the same record under the agent's own id/role or an analyst's arms nothing
  assert.equal(determinationRecordedEvent({ case_id: CASE, loan_id: "L-16", officer: { ...OFFICER, determined_by_officer_id: "agent:qc-audit", determined_by_role: "qc-audit" }, exposure_cents: 41_250_000n, flags: ["PAYOFF_WIRE_CHANGE"] }), null);
  assert.equal(determinationRecordedEvent({ case_id: CASE, loan_id: "L-16", officer: { ...OFFICER, determined_by_role: "ops_analyst" }, exposure_cents: 41_250_000n, flags: ["PAYOFF_WIRE_CHANGE"] }), null);
  events.append({ ...det, occurredAt: at("2026-10-14", "15:00") });
  const t = timers.byCode("FNMA_A3403_FRAUD_REPORT_30")[0]!; assert.equal(t.anchorDate, "2026-10-14"); assert.equal(t.dueDate, "2026-11-13");
  // the same event arms the determination leg of the partner notice (1 BD → 2026-10-15) and the attorney's referral decision (10 BD → 2026-10-28)
  const partner = timers.byCode("SM_FRAUD_PARTNER_NOTIFY_1BD")[0]!; assert.equal(partner.dueDate, "2026-10-15");
  const le = timers.byCode("SM_FRAUD_LE_REFERRAL_DECISION_10BD")[0]!; assert.equal(le.dueDate, "2026-10-28");
  clock.set(at("2026-10-15", "09:00"));
  events.append({ ...fraudPartnerNotifiedEvent({ case_id: CASE, loan_id: "L-16", leg: "determination", evidence_document_id: "doc-partner-notice-2", notified_on: D("2026-10-15") })!, occurredAt: at("2026-10-15", "09:00") });
  assert.equal(partner.status, "satisfied");
  assert.equal(leReferralDecidedEvent({ case_id: CASE, loan_id: "L-16", decision: "not_refer", decided_by_role: "attorney", attorney_id: "attorney/pnair", reason: null, decided_on: D("2026-10-20") }), null);   // not-refer needs a reason
  assert.equal(leReferralDecidedEvent({ case_id: CASE, loan_id: "L-16", decision: "refer", decided_by_role: "qc-audit", attorney_id: "qc-audit", reason: null, decided_on: D("2026-10-20") }), null);         // referrals are the attorney's act
  clock.set(at("2026-10-20", "09:00"));
  events.append({ ...leReferralDecidedEvent({ case_id: CASE, loan_id: "L-16", decision: "refer", decided_by_role: "attorney", attorney_id: "attorney/pnair", reason: "USPIS referral: BEC payoff diversion, $412,500 exposure", decided_on: D("2026-10-20") })!, occurredAt: at("2026-10-20", "09:00") });
  assert.equal(le.status, "satisfied");
  // nothing breaches on the due date; past 23:59 ET on 2026-11-13 the row breaches sev-1 → officer (+ partner, from the engine's own breach)
  assert.equal(timers.evaluate(at("2026-11-13", "17:00")).length, 0);
  const b = timers.evaluate(at("2026-11-14", "00:30")); assert.equal(b.length, 1); assert.equal(b[0]!.def.code, "FNMA_A3403_FRAUD_REPORT_30"); assert.equal(b[0]!.severity, 1); assert.ok(b[0]!.escalateTo.includes("officer")); assert.equal(t.status, "breached");
  const routed = breachEscalation(b[0]!, { case_id: CASE, due: t.dueDate! }); assert.equal(routed.kind, "officer"); assert.equal(routed.severity, "sev1"); assert.equal(routed.partner_notice, true);
  // the 2026-11-14 filing: an unsigned report is no filing, nor is one "signed" by the agent or the portal operator (external reports are the officer's act); a signed one without the LQC reference does not satisfy; with it the row closes satisfied_late — recorded as breached
  clock.set(at("2026-11-14", "10:00"));
  assert.equal(fraudReportFiledEvent({ case_id: CASE, loan_id: "L-16", channel: "lqc_self_report", signed_by_officer_id: null, signed_by_role: "officer", evidence_document_id: "doc-lqc-pkg", sent_on: D("2026-11-14"), lqc_reference: "LQC-SR-2026-0042" }), null);
  assert.equal(fraudReportFiledEvent({ case_id: CASE, loan_id: "L-16", channel: "lqc_self_report", signed_by_officer_id: "agent:qc-audit", signed_by_role: "qc-audit", evidence_document_id: "doc-lqc-pkg", sent_on: D("2026-11-14"), lqc_reference: "LQC-SR-2026-0042" }), null);
  assert.equal(fraudReportFiledEvent({ case_id: CASE, loan_id: "L-16", channel: "lqc_self_report", signed_by_officer_id: "portal/aray", signed_by_role: "fnma_portal_operator", evidence_document_id: "doc-lqc-pkg", sent_on: D("2026-11-14"), lqc_reference: "LQC-SR-2026-0042" }), null);
  assert.match(reportSigner("qc-audit").refusal!, /human acts/); assert.equal(reportSigner("officer").allowed, true);
  events.append({ ...fraudReportFiledEvent({ case_id: CASE, loan_id: "L-16", channel: "lqc_self_report", ...SIGNED, evidence_document_id: "doc-lqc-pkg", sent_on: D("2026-11-14") })!, occurredAt: at("2026-11-14", "10:00") });
  assert.equal(t.status, "breached");
  events.append({ ...fraudReportFiledEvent({ case_id: CASE, loan_id: "L-16", channel: "lqc_self_report", ...SIGNED, evidence_document_id: "doc-lqc-pkg", sent_on: D("2026-11-14"), lqc_reference: "LQC-SR-2026-0042" })!, occurredAt: at("2026-11-14", "10:05") });
  assert.equal(t.status, "satisfied_late"); assert.equal(t.satisfiedAt, at("2026-11-14", "10:05"));
  assert.ok(events.all().some((e) => e.type === "timer.breached" && e.payload.code === "FNMA_A3403_FRAUD_REPORT_30"));
  assert.ok(events.all().some((e) => e.type === "timer.satisfied" && e.payload.code === "FNMA_A3403_FRAUD_REPORT_30" && e.payload.late === true));
  // the registry row itself: 30 calendar days from determination_at, satisfied only by the LQC channel with a captured reference
  const def = loadOverriddenRegistry().get("FNMA_A3403_FRAUD_REPORT_30")!;
  assert.deepEqual(def.offsetParsed, { kind: "step", n: 30, unit: "calendar_days" }); assert.equal(def.anchorField, "determination_at");
  assert.deepEqual(def.satisfiedPattern!.conditions, [{ field: "channel", op: "=", value: "lqc_self_report" }, { field: "lqc_reference", op: "is not null" }]);
});
test("18.5-T3: Given no determination by 2026-10-20, then `SM_FRAUD_DUE_DILIGENCE_15` breaches to the fraud officer.", () => {
  // flag 2026-10-05 → diligence due 2026-10-20 (rule 4); open on the due date, breached the day after with no determination
  assert.equal(fraudClocks(D("2026-10-05"), null).diligence_due, "2026-10-20");
  const open = diligenceBreach({ case_id: CASE, opened_on: D("2026-10-05"), determination_on: null, today: D("2026-10-20") });
  assert.equal(open.timer, "SM_FRAUD_DUE_DILIGENCE_15"); assert.equal(open.due, "2026-10-20"); assert.equal(open.breached, false); assert.equal(open.escalation, null);
  const b = diligenceBreach({ case_id: CASE, opened_on: D("2026-10-05"), determination_on: null, today: D("2026-10-21") });
  assert.equal(b.breached, true); assert.equal(b.escalation?.kind, "fraud_officer"); assert.equal(b.escalation?.severity, "sev2"); assert.equal(b.escalation?.due, "2026-10-20");
  assert.match(b.escalation!.reason, /no determination by 2026-10-20/); assert.match(b.escalation!.reason, /protects the 30-day A3-4-03 window/);
  assert.equal(diligenceBreach({ case_id: CASE, opened_on: D("2026-10-05"), determination_on: D("2026-10-14"), today: D("2026-10-21") }).breached, false);
  assert.equal(diligenceBreach({ case_id: CASE, opened_on: D("2026-10-05"), determination_on: D("2026-10-22"), today: D("2026-10-22") }).breached, true);   // a late determination was still a breach
  // registry: opened 2026-10-05 → due 2026-10-20; nothing breaches on 2026-10-20; after 23:59 ET the row breaches sev-2, naming officer:fraud_officer
  const { clock, events, timers } = engine(at("2026-10-05", "10:00"));
  events.append({ ...openFraudCase({ case_id: CASE, loan_id: "L-16", flags: [FLAG], opened_on: D("2026-10-05") }).event, occurredAt: at("2026-10-05", "10:00") });
  const t = timers.byCode("SM_FRAUD_DUE_DILIGENCE_15")[0]!; assert.equal(t.anchorDate, "2026-10-05"); assert.equal(t.dueDate, "2026-10-20");
  clock.set(at("2026-10-06", "09:00"));
  events.append({ ...fraudPartnerNotifiedEvent({ case_id: CASE, loan_id: "L-16", leg: "open", evidence_document_id: "doc-partner-notice-1", notified_on: D("2026-10-06") })!, occurredAt: at("2026-10-06", "09:00") });
  events.append({ ...caseStatusChangedEvent({ case_id: CASE, loan_id: "L-16", status: "triaged", score: 90, priority: "P1" }), occurredAt: at("2026-10-06", "09:30") });
  assert.equal(timers.evaluate(at("2026-10-20", "18:00")).length, 0);
  const br = timers.evaluate(at("2026-10-21", "00:30"));
  assert.equal(br.length, 1); assert.equal(br[0]!.def.code, "SM_FRAUD_DUE_DILIGENCE_15"); assert.equal(br[0]!.severity, 2); assert.match(br[0]!.breachText, /officer:fraud_officer/); assert.match(br[0]!.breachText, /protects the 30-day window/); assert.equal(t.status, "breached");
  assert.ok(events.all().some((e) => e.type === "timer.breached" && e.payload.code === "SM_FRAUD_DUE_DILIGENCE_15" && e.payload.severity === 2));
  // the engine's breach is routed to the fraud officer: the colon-qualified role is read from the breach the engine raised (the kernel's role parser reads only bare `officer`-style tokens and leaves the row's escalateTo empty)
  assert.deepEqual(breachRoles(br[0]!.def), ["fraud_officer"]);
  const routed = breachEscalation(br[0]!, { case_id: CASE, due: t.dueDate! });
  assert.equal(routed.kind, "fraud_officer"); assert.equal(routed.severity, "sev2"); assert.deepEqual(routed.roles, ["fraud_officer"]); assert.equal(routed.due, "2026-10-20"); assert.equal(routed.partner_notice, false);
  assert.match(routed.reason, /SM_FRAUD_DUE_DILIGENCE_15 breached for case FR-2026-0412 \(due 2026-10-20\)/); assert.match(routed.reason, /officer:fraud_officer/);
  assert.equal(routed.kind, b.escalation!.kind); assert.equal(routed.severity, b.escalation!.severity);   // the pure clock and the engine agree on the route
  // the agent's memo records no determination (null event); the officer's determination on 2026-10-22 closes the row satisfied_late
  assert.equal(determinationRecordedEvent({ case_id: CASE, loan_id: "L-16", officer: null, exposure_cents: 41_250_000n, flags: ["PAYOFF_WIRE_CHANGE"] }), null);
  clock.set(at("2026-10-22", "11:00"));
  events.append({ ...determinationRecordedEvent({ case_id: CASE, loan_id: "L-16", officer: { ...OFFICER, determined_at: D("2026-10-22") }, exposure_cents: 41_250_000n, flags: ["PAYOFF_WIRE_CHANGE"] })!, occurredAt: at("2026-10-22", "11:00") });
  assert.equal(t.status, "satisfied_late");
});
test("18.5-T4: Given a confirmed OFAC match at 2026-11-02 15:10 ET, then the Ethics email must be sent by 2026-11-03 15:10 ET; the timer counts clock hours across the weekend when applicable.", async () => {
  const confirmed = at("2026-11-02", "15:10");
  const n = ofacEthicsNotice({ case_id: "FR-2026-0417", confirmed_at: confirmed, borrower_name: "Jane Q. Borrower", fnma_loan_number: "1234567890", servicer_contact: "fraud-officer@supermortgage.example / +1 555 0100" });
  assert.deepEqual(n.due_et, { date: "2026-11-03", hour: 15, minute: 10 }); assert.equal(n.due_at, at("2026-11-03", "15:10")); assert.equal(n.clock_hours, 24); assert.equal(n.counts_weekend, true);
  assert.equal(n.channel, "ethics_email_ofac"); assert.equal(n.template, "FRAUD-OFAC-24H-v1"); assert.equal(n.recipient, "fnma_ethics_division");
  assert.deepEqual(n.content, { borrower_name: "Jane Q. Borrower", fnma_loan_number: "1234567890", servicer_contact: "fraud-officer@supermortgage.example / +1 555 0100" });   // rule 5 OFAC email content
  assert.equal(n.escalation.kind, "officer"); assert.equal(n.escalation.severity, "sev1"); assert.match(n.escalation.reason, /by 2026-11-03 15:10 ET/);
  const ms = ofacEmailDueMs(zonedEpochMs(D("2026-11-02"), "15:10", ET)); assert.deepEqual([wallClock(ms, ET).date, wallClock(ms, ET).hour, wallClock(ms, ET).minute], ["2026-11-03", 15, 10]);
  // weekend: a Friday 2026-10-30 15:10 ET confirmation is due Saturday 2026-10-31 15:10 ET — clock hours, not business days (2 BD would land Tue 2026-11-03)
  assert.deepEqual(ofacEthicsNotice({ case_id: "FR-2026-0418", confirmed_at: at("2026-10-30", "15:10"), borrower_name: "x", fnma_loan_number: "1", servicer_contact: "y" }).due_et, { date: "2026-10-31", hour: 15, minute: 10 });
  // registry: `ofac.match.confirmed` at the confirmation instant → 24 clock hours; the officer-signed Ethics email (channel ethics_email_ofac) satisfies it
  const { clock, events, timers } = engine(confirmed);
  events.append({ type: "ofac.match.confirmed", loanId: "L-31", actor: SYSTEM, occurredAt: confirmed, payload: { case_id: "FR-2026-0417", list: "OFAC_SDN", match_score: 0.98 } });
  const t = timers.byCode("FNMA_A3201_OFAC_MATCH_24H")[0]!; assert.equal(t.dueDate, "2026-11-03"); assert.equal(toIso(t.dueAt!), at("2026-11-03", "15:10"));
  assert.equal(timers.evaluate(at("2026-11-03", "15:09")).length, 0);
  clock.set(at("2026-11-03", "15:09"));
  events.append({ ...fraudReportFiledEvent({ case_id: "FR-2026-0417", loan_id: "L-31", channel: "ethics_email_ofac", ...SIGNED, evidence_document_id: "doc-ethics-email-1", sent_on: D("2026-11-03") })!, occurredAt: at("2026-11-03", "15:09") });
  assert.equal(t.status, "satisfied"); assert.equal(timers.evaluate(at("2026-11-03", "15:11")).length, 0);
  // across the weekend: Friday 15:10 ET confirmation, no email by Saturday 15:10 ET → breached sev-1 → officer on Saturday
  const fri = engine(at("2026-10-30", "15:10"));
  fri.events.append({ type: "ofac.match.confirmed", loanId: "L-32", actor: SYSTEM, occurredAt: at("2026-10-30", "15:10"), payload: { case_id: "FR-2026-0418", list: "OFAC_SDN", match_score: 0.97 } });
  const ft = fri.timers.byCode("FNMA_A3201_OFAC_MATCH_24H")[0]!; assert.equal(ft.dueDate, "2026-10-31"); assert.equal(toIso(ft.dueAt!), at("2026-10-31", "15:10"));
  const b = fri.timers.evaluate(at("2026-10-31", "15:11")); assert.equal(b.length, 1); assert.equal(b[0]!.severity, 1); assert.ok(b[0]!.escalateTo.includes("officer")); assert.equal(ft.status, "breached");
  assert.equal(breachEscalation(b[0]!, { case_id: "FR-2026-0418", due: ft.dueDate! }).kind, "officer");
  const def = loadOverriddenRegistry().get("FNMA_A3201_OFAC_MATCH_24H")!; assert.deepEqual(def.offsetParsed, { kind: "step", n: 24, unit: "hours", note: "clock hours" }); assert.deepEqual(def.satisfiedPattern!.conditions, [{ field: "channel", op: "=", value: "ethics_email_ofac" }]);
  // the real emitter: the Section 19 screening result (subject, list, match score, disposition) ingested through `screening.ofac_match.ingest` — only a *confirmed* OFAC-list match is a valid sanctions-list match
  const result = { screening_result_id: "SR-2026-9001", subject: { kind: "borrower" as const, id: "B-31", name: "Jane Q. Borrower" }, list: "OFAC_SDN", match_score: 0.98, disposition: "confirmed" as const, confirmed_at: confirmed, confirmed_by_id: "analyst/kwu", loan_id: "L-31", fnma_loan_number: "1234567890" };
  const m = ofacMatchConfirmedEvent({ result, case_id: "FR-2026-0417" });
  assert.equal(m.refusal, null); assert.equal(m.event!.type, "ofac.match.confirmed"); assert.equal(m.event!.occurredAt, confirmed); assert.equal(m.event!.payload.confirmed_at, confirmed); assert.equal(m.event!.payload.list, "OFAC_SDN"); assert.equal(m.event!.payload.flag_code, "OFAC_MATCH"); assert.equal(m.event!.loanId, "L-31");
  assert.equal(m.due_at, at("2026-11-03", "15:10")); assert.deepEqual([m.flag!.flag_code, m.flag!.score, m.flag!.detected_on, m.flag!.source_event], ["OFAC_MATCH", OFAC_MATCH_FLAG_SCORE, "2026-11-02", "ofac.match.confirmed"]);
  assert.match(ofacMatchConfirmedEvent({ result: { ...result, disposition: "potential", confirmed_at: null, confirmed_by_id: null }, case_id: "x" }).refusal!, /only a confirmed \(valid\) match/);
  assert.match(ofacMatchConfirmedEvent({ result: { ...result, disposition: "false_positive" }, case_id: "x" }).refusal!, /disposition false_positive/);
  assert.match(ofacMatchConfirmedEvent({ result: { ...result, list: "GSA_SAM" }, case_id: "x" }).refusal!, /not an OFAC list .*SCREENING_HIT/);
  assert.match(ofacMatchConfirmedEvent({ result: { ...result, confirmed_at: "yesterday-ish" }, case_id: "x" }).refusal!, /no parseable confirmation timestamp/);
  assert.match(ofacMatchConfirmedEvent({ result: { ...result, match_score: 1.7 }, case_id: "x" }).refusal!, /match_score 1.7/);
  assert.equal(OFAC_LISTS.includes("OFAC_CONSOLIDATED"), true);
  // through the bus: ingesting the confirmed match appends `ofac.match.confirmed` at the confirmation instant and arms the row at 2026-11-03 15:10 ET; a potential hit or a SAM hit is refused and arms nothing
  const bus = bus18_5(at("2026-11-02", "16:00"));   // ingested 50 minutes after the confirmation: the clock still runs from 15:10
  const potential = await bus.refused("screening.ofac_match.ingest", { result: { ...result, disposition: "potential", confirmed_at: null, confirmed_by_id: null }, servicer_contact: "fraud-officer@supermortgage.example" });
  assert.equal(potential.code, "OFAC_MATCH_NOT_CONFIRMED"); assert.equal(bus.timers.byCode("FNMA_A3201_OFAC_MATCH_24H").length, 0);
  assert.equal((await bus.refused("screening.ofac_match.ingest", { result: { ...result, list: "GSA_SAM" } })).code, "OFAC_MATCH_NOT_CONFIRMED");
  const ing = await bus.run("screening.ofac_match.ingest", { result, case_id: "FR-2026-0417", servicer_contact: "fraud-officer@supermortgage.example / +1 555 0100" });
  assert.equal(ing.case_id, "FR-2026-0417"); assert.equal(ing.timer, "FNMA_A3201_OFAC_MATCH_24H"); assert.equal(ing.due_at, at("2026-11-03", "15:10")); assert.deepEqual(ing.due_et, { date: "2026-11-03", hour: 15, minute: 10 }); assert.equal(ing.template, "FRAUD-OFAC-24H-v1");
  const ofacEv = bus.events.all().find((e) => e.type === "ofac.match.confirmed")!;
  assert.equal(ofacEv.occurredAt, confirmed); assert.equal(ofacEv.payload.confirmed_at, confirmed); assert.equal(ofacEv.payload.case_id, "FR-2026-0417"); assert.equal(ofacEv.payload.screening_result_id, "SR-2026-9001"); assert.equal(ofacEv.loanId, "L-31");
  assert.equal(eventMatches(def.triggerPattern!, ofacEv), true);
  const bt = bus.timers.byCode("FNMA_A3201_OFAC_MATCH_24H")[0]!; assert.equal(bt.status, "armed"); assert.equal(toIso(bt.dueAt!), at("2026-11-03", "15:10"));
  assert.equal(bus.rt.store.get("fraud_red_flags", "FR-2026-0417:OFAC_MATCH:SR-2026-9001")!.data.score, 100); assert.equal(bus.rt.store.get("fraud_cases", "FR-2026-0417")!.data.status, "ofac_match_confirmed"); assert.equal(bus.rt.store.get("screening_results", "SR-2026-9001")!.data.fraud_case_id, "FR-2026-0417");
  const esc = bus.rt.escalations.opened.find((e) => e.kind === "officer")!; assert.equal(esc.severity, "sev1"); assert.match(String(esc.payload.reason), /by 2026-11-03 15:10 ET/); assert.deepEqual(esc.payload.content, { borrower_name: "Jane Q. Borrower", fnma_loan_number: "1234567890", servicer_contact: "fraud-officer@supermortgage.example / +1 555 0100" });
  // the Ethics email is the officer's act: the agent's filing is refused (human act), an analyst's is role-denied, an unevidenced one is no filing; the officer's signed, evidenced send satisfies the row at 2026-11-03 15:09 ET
  bus.clock.set(at("2026-11-03", "15:09"));
  const email = { case_id: "FR-2026-0417", loan_id: "L-31", channel: "ethics_email_ofac", evidence_document_id: "doc-ethics-email-1", sent_on: "2026-11-03" };
  assert.equal((await bus.refused("report.file", email, AGENT_ACTOR)).code, "HUMAN_ONLY");
  assert.equal((await bus.refused("report.file", email, ANALYST)).code, "ROLE_DENIED");
  assert.equal((await bus.refused("report.file", { ...email, evidence_document_id: null }, SIGNING_OFFICER)).code, "REPORT_UNEVIDENCED");
  assert.equal(bt.status, "armed");
  const filed = await bus.run("report.file", email, SIGNING_OFFICER);
  assert.equal(filed.channel, "ethics_email_ofac"); assert.equal(filed.sent_on, "2026-11-03");
  const filedEv = bus.events.all().find((e) => e.type === "fraud.report.filed")!; assert.equal(eventMatches(def.satisfiedPattern!, filedEv), true); assert.deepEqual(filedEv.actor, SIGNING_OFFICER);
  assert.equal(bt.status, "satisfied"); assert.equal(bus.timers.evaluate(at("2026-11-03", "15:11")).length, 0);
  assert.equal(bus.rt.store.get("fraud_cases", "FR-2026-0417")!.data.status, "ethics_notified"); assert.equal(bus.rt.store.get("fraud_cases", "FR-2026-0417")!.data.ofac_reported_at, "2026-11-03");   // state machine: ofac_match_confirmed → ethics_notified (24h)
  assert.ok(bus.decisions.some((d) => d.action === "report.file" && d.approvedBy === "officer/mroe"));
});
test("18.5-T5: Given an allegation of fraud by a retained law firm discovered Thursday, then the Fannie Mae Legal email is due by the following Monday (2 BD).", () => {
  // Thursday 2026-11-19 → Friday 11-20 (1), Monday 11-23 (2)
  const e = lawFirmFraudEscalation({ case_id: "FR-2026-0420", firm_id: "FIRM-77", discovered_on: D("2026-11-19") });
  assert.equal(e.timer, "FNMA_A4222_LAWFIRM_FRAUD_2BD"); assert.equal(e.due, "2026-11-23"); assert.equal(e.channel, "fnma_legal_email"); assert.equal(e.template, "FRAUD-LAWFIRM-2BD-v1"); assert.equal(e.co_owner, "13"); assert.equal(e.calendar, "business_days_fannie_et");
  assert.equal(e.escalation.kind, "officer"); assert.equal(e.escalation.severity, "sev1"); assert.equal(e.escalation.due, "2026-11-23"); assert.match(e.escalation.reason, /A4-2\.2-02, two business days/);
  assert.equal(lawFirmFraudNoticeDue(D("2026-11-19")), "2026-11-23");
  // a Thursday whose following Monday is a federal holiday: discovered Thu 2027-01-14 → Fri 01-15 (1), Mon 01-18 is MLK Day → Tue 2027-01-19 (2)
  assert.equal(lawFirmFraudEscalation({ case_id: "FR-2027-0002", firm_id: "FIRM-77", discovered_on: D("2027-01-14") }).due, "2027-01-19");
  // a Fannie Mae deadline counts on Fannie Mae's calendar: a servicer-only closure on Friday 2026-11-20 would push a servicer-day count to Tuesday 11-24, but the Legal email is still due Monday 11-23
  const closed = servicerCalendar({ closures: [D("2026-11-20")] });
  assert.equal(addBusinessDays(D("2026-11-19"), 2, closed), "2026-11-24"); assert.equal(e.due, "2026-11-23");
  // registry: `lawfirm.fraud.alleged{discovered_on}` on Thursday arms 2 Fannie Mae business days → Monday, even with the servicer closed on Friday; the officer-signed Fannie Mae Legal email satisfies it
  const { clock, events, timers } = engine(at("2026-11-19", "16:00"), { ...defaultCalendars, business_days_servicer: closed });
  events.append({ ...e.arms, occurredAt: at("2026-11-19", "16:00") });
  const t = timers.byCode("FNMA_A4222_LAWFIRM_FRAUD_2BD")[0]!; assert.equal(t.anchorDate, "2026-11-19"); assert.equal(t.dueDate, "2026-11-23");
  assert.equal(timers.evaluate(at("2026-11-23", "17:00")).length, 0);
  clock.set(at("2026-11-23", "17:30"));
  events.append({ ...fraudReportFiledEvent({ case_id: "FR-2026-0420", loan_id: null, channel: "fnma_legal_email", ...SIGNED, evidence_document_id: "doc-fnma-legal-email-1", sent_on: D("2026-11-23") })!, occurredAt: at("2026-11-23", "17:30") });
  assert.equal(t.status, "satisfied");
  // no email by Monday 23:59 ET → Tuesday breaches sev-1 (still Tuesday 00:30 under the closed servicer calendar — the closure buys no day)
  const silent = engine(at("2026-11-19", "16:00"), { ...defaultCalendars, business_days_servicer: closed });
  silent.events.append({ ...e.arms, occurredAt: at("2026-11-19", "16:00") });
  const b = silent.timers.evaluate(at("2026-11-24", "00:30")); assert.equal(b.length, 1); assert.equal(b[0]!.def.code, "FNMA_A4222_LAWFIRM_FRAUD_2BD"); assert.equal(b[0]!.severity, 1);
  const def = loadOverriddenRegistry().get("FNMA_A4222_LAWFIRM_FRAUD_2BD")!; assert.deepEqual(def.offsetParsed, { kind: "step", n: 2, unit: "business_days_fannie_et" }); assert.equal(def.anchorField, "discovered_on");
});
test("18.5-T6: Given the agent proposes a determination with confidence 0.95, then the case still requires the fraud officer's recorded determination before any report is drafted for signature.", () => {
  // the agent's 0.95 proposal is a memo for the fraud officer: no determination recorded, no report drafted, case stays investigating
  const proposed = agentDeterminationProposal({ record: RECORD, officer_determination: null });
  assert.equal(proposed.report_draft_allowed, false); assert.equal(proposed.determination, null); assert.equal(proposed.determined_by, null); assert.equal(proposed.case_status, "investigating");
  assert.equal(proposed.next_step, "officer:fraud_officer determination"); assert.equal(proposed.escalation?.kind, "fraud_officer"); assert.equal(proposed.package, "FRAUD-FILE-v1");
  assert.match(proposed.refusal!, /no recorded officer:fraud_officer determination/); assert.match(proposed.refusal!, /confidence 0\.95/); assert.match(proposed.refusal!, /human acts/);
  assert.equal(proposed.fnma_report_due, null); assert.equal(proposed.memo.confidence, 0.95); assert.equal(proposed.memo.model_version, "fraud-model-2026.09");
  assert.equal(reportDraftGate({ agent_recommendation: { determination: "reasonable_basis", confidence: 0.95 }, officer_determination: null }).allowed, false);
  assert.equal(determinationRecordedEvent({ case_id: CASE, loan_id: "L-16", officer: null, exposure_cents: 41_250_000n, flags: RECORD.flags }), null);   // nothing arms the 30-day row on the agent's say-so
  // a "determination" the agent records under its own id, or an analyst's, is no determination either — the act is role-checked, never presence-checked
  const agentSelf = agentDeterminationProposal({ record: RECORD, officer_determination: { determination: "reasonable_basis", determined_by_officer_id: "agent:qc-audit", determined_by_role: "qc-audit", determined_at: D("2026-10-14") } });
  assert.equal(agentSelf.report_draft_allowed, false); assert.equal(agentSelf.determination, null); assert.equal(agentSelf.determined_by, null); assert.equal(agentSelf.case_status, "investigating"); assert.equal(agentSelf.fnma_report_due, null); assert.equal(agentSelf.package, "FRAUD-FILE-v1");
  assert.match(agentSelf.refusal!, /determination by qc-audit refused/); assert.match(agentSelf.refusal!, /no recorded officer:fraud_officer determination/);
  assert.equal(agentDeterminationProposal({ record: RECORD, officer_determination: { ...OFFICER, determined_by_role: "ops_analyst" } }).report_draft_allowed, false);
  assert.deepEqual(determinationActor("officer:fraud_officer"), { allowed: true, refusal: null, actor_role: "fraud_officer" });
  assert.equal(determinationActor("officer:deputy_fraud_officer").allowed, true); assert.equal(determinationActor("board_designee").actor_role, "officer");   // rule 7 / T9 designees
  assert.equal(determinationActor("officer").allowed, false); assert.equal(determinationActor("qc-audit").allowed, false); assert.match(determinationActor("").refusal!, /human acts/);
  // the fraud officer's recorded reasonable_basis determination is what unlocks draft-for-signature and starts the 30-day clock (rule 4 dates)
  const determined = agentDeterminationProposal({ record: RECORD, officer_determination: OFFICER });
  assert.equal(determined.report_draft_allowed, true); assert.equal(determined.next_step, "draft_for_officer_signature"); assert.equal(determined.case_status, "determined");
  assert.equal(determined.determination, "reasonable_basis"); assert.equal(determined.determined_by, "officer:fraud_officer/jlee"); assert.equal(determined.package, "FRAUD-FNMA-SR-v1"); assert.equal(determined.escalation?.kind, "officer");
  assert.equal(determined.fnma_report_due, "2026-11-13"); assert.equal(determined.internal_target, "2026-11-03"); assert.equal(determined.partner_notice_due, "2026-10-15");
  // rule 5: the FRAUD-FNMA-SR-v1 package drafted for the officer's signature carries every content element — loan identifiers, parties, scheme, timeline, evidence with hashes, exposure (cents), actions, law-enforcement status, contact
  const hash = (seed: string): string => `sha256:${seed.padEnd(64, "0")}`;
  const content = {
    loan_identifiers: [{ fnma_loan_number: "1234567890", servicer_loan_number: "SM-000016" }], parties: [{ role: "borrower_victim", name: "Jane Q. Borrower" }, { role: "suspected_perpetrator", name: "unknown (BEC actor)" }],
    scheme_description: "payoff diversion via business-email compromise of the closing agent's wire instructions",
    timeline: [{ on: D("2026-10-02"), what: "wire instructions changed" }, { on: D("2026-10-05"), what: "payoff requested; PAYOFF_WIRE_CHANGE flagged; disbursement held" }, { on: D("2026-10-14"), what: "reasonable_basis determination" }],
    evidence: [{ document_id: "doc-wire-change", sha256: hash("9f1c") }, { document_id: "doc-callback-log", sha256: hash("4ab0") }], exposure_cents: 41_250_000n,
    actions_taken: ["payoff disbursement held (loans.fraud_hold to 2026-11-04)", "partner notified 2026-10-06 and 2026-10-15", "call-back verification by a human agent"], law_enforcement_status: "referral_pending_attorney" as const, contact_person: "J. Lee, fraud officer, fraud-officer@supermortgage.example",
  };
  const pkg = fnmaSelfReportPackage({ case_id: CASE, officer_determination: OFFICER, agent_recommendation: { determination: "reasonable_basis", confidence: 0.95 }, content });
  assert.equal(pkg.template, "FRAUD-FNMA-SR-v1"); assert.equal(pkg.channel, "lqc_self_report"); assert.equal(pkg.allowed, true); assert.equal(pkg.ready_for_signature, true); assert.deepEqual(pkg.missing, []); assert.equal(pkg.refusal, null);
  assert.equal(pkg.signer, "officer"); assert.equal(pkg.submitter, "fnma_portal_operator"); assert.equal(pkg.content!.exposure_cents, 41_250_000n); assert.equal(pkg.content!.evidence.length, 2);
  assert.deepEqual([...FNMA_SELF_REPORT_ELEMENTS], ["loan_identifiers", "parties", "scheme_description", "timeline", "evidence", "exposure_cents", "actions_taken", "law_enforcement_status", "contact_person"]);
  // an evidence item without its hash and a missing contact person: the package is not ready for signature
  const short = fnmaSelfReportPackage({ case_id: CASE, officer_determination: OFFICER, content: { ...content, evidence: [{ document_id: "doc-wire-change", sha256: "" }], contact_person: "" } });
  assert.equal(short.allowed, true); assert.equal(short.ready_for_signature, false); assert.deepEqual(short.missing, ["evidence", "contact_person"]); assert.equal(short.content, null); assert.match(short.refusal!, /not ready for signature: rule-5 content missing evidence, contact_person/);
  // and no package at all, however complete the content, before the officer's determination (0.95 or not) — or behind an unfounded one
  const noDet = fnmaSelfReportPackage({ case_id: CASE, officer_determination: null, agent_recommendation: { determination: "reasonable_basis", confidence: 0.95 }, content });
  assert.equal(noDet.allowed, false); assert.equal(noDet.ready_for_signature, false); assert.equal(noDet.content, null); assert.equal(noDet.missing.length, 9); assert.match(noDet.refusal!, /no recorded officer:fraud_officer determination/); assert.match(noDet.refusal!, /confidence 0\.95/);
  assert.match(fnmaSelfReportPackage({ case_id: CASE, officer_determination: { ...OFFICER, determined_by_officer_id: "agent:qc-audit", determined_by_role: "qc-audit" }, content }).refusal!, /determination by qc-audit refused/);
  assert.equal(fnmaSelfReportPackage({ case_id: CASE, officer_determination: { ...OFFICER, determination: "unfounded" }, content }).allowed, false);
  // an officer's unfounded determination overrides the agent's 0.95 recommendation outright: no Fannie Mae report, case closes unfounded
  const unfounded = agentDeterminationProposal({ record: RECORD, officer_determination: { ...OFFICER, determination: "unfounded" } });
  assert.equal(unfounded.report_draft_allowed, false); assert.equal(unfounded.next_step, "close_unfounded"); assert.equal(unfounded.case_status, "unfounded_closed"); assert.equal(unfounded.fnma_report_due, null);
  // an inconclusive determination is neither reportable nor an unfounded close: the case stays investigating for further diligence and a fresh determination
  const inconclusive = agentDeterminationProposal({ record: RECORD, officer_determination: { ...OFFICER, determination: "inconclusive" } });
  assert.equal(inconclusive.report_draft_allowed, false); assert.equal(inconclusive.case_status, "investigating"); assert.equal(inconclusive.next_step, "further_diligence"); assert.equal(inconclusive.determination, "inconclusive");
  assert.equal(inconclusive.fnma_report_due, null); assert.equal(inconclusive.package, null); assert.equal(inconclusive.escalation?.kind, "fraud_officer"); assert.match(inconclusive.refusal!, /no Fannie Mae report and no unfounded close/);
});
test("18.5-T7: Given a validated QC finding affecting 620 loans, then `FNMA_A3201_BREACH_SELF_REPORT_60` starts from the later of quarter-end or discovery.", () => {
  const q3 = { kind: "qc_finding" as const, affected_count: 620, prior_year_deliveries: 80_000, breach_quarter_end: D("2026-09-30") };
  // discovered after the quarter closed: discovery (2026-10-15) is the later date → due 2026-12-14
  const late = breachSelfReportClock({ ...q3, discovered_on: D("2026-10-15"), validated_on: D("2026-10-20") });
  assert.equal(late.required, true); assert.equal(late.basis, "count_over_500"); assert.equal(late.timer, "FNMA_A3201_BREACH_SELF_REPORT_60");
  assert.equal(late.anchor, "2026-10-15"); assert.equal(late.due, "2026-12-14"); assert.equal(late.channel, "lqc_self_report");
  assert.deepEqual(late.arms, { type: "fraud.self_report.required", basis: "count_over_500", self_report_anchor_on: "2026-10-15" });
  // discovered mid-quarter: quarter-end (2026-09-30) is the later date → due 2026-11-29
  const early = breachSelfReportClock({ ...q3, discovered_on: D("2026-09-10"), validated_on: D("2026-09-18") });
  assert.equal(early.anchor, "2026-09-30"); assert.equal(early.due, "2026-11-29"); assert.equal(early.arms?.self_report_anchor_on, "2026-09-30");
  assert.equal(quarterEndOf(D("2026-09-10")), "2026-09-30"); assert.equal(breachSelfReportDue(D("2026-09-10")), "2026-11-29");
  // 620 loans is 0.775% of 80,000 deliveries — the count leg alone carries it; 300 loans (0.375%) is neither leg, 300 of 25,000 (1.2%) is the percentage leg
  assert.equal(breachSelfReportTrigger({ ...q3, affected_count: 300, discovered_on: D("2026-10-15"), validated_on: D("2026-10-20") }).required, false);
  assert.equal(breachSelfReportTrigger({ ...q3, affected_count: 300, prior_year_deliveries: 25_000, discovered_on: D("2026-10-15"), validated_on: D("2026-10-20") }).basis, "pct_over_1");
  // boundary: A3-2-01 says "more than 500 loans or 1% of prior year deliveries" (the spec's verified-requirement quote), so exactly 500 is under the count leg and 501 is over — the timer row's "≥ 500" is the spec contradicting its own source; the percentage leg is "1%" and counts at exactly 1%
  assert.equal(breachSelfReportTrigger({ ...q3, affected_count: 500, discovered_on: D("2026-10-15"), validated_on: D("2026-10-20") }).required, false);
  assert.equal(breachSelfReportTrigger({ ...q3, affected_count: 501, discovered_on: D("2026-10-15"), validated_on: D("2026-10-20") }).basis, "count_over_500");
  assert.equal(breachSelfReportTrigger({ ...q3, affected_count: 800, prior_year_deliveries: 80_000, discovered_on: D("2026-10-15"), validated_on: D("2026-10-20") }).basis, "count_over_500");   // 1.0% exactly is also the pct leg; count wins the label
  // the percentage leg in isolation: 500 of 50,000 is exactly 1.0% and under the count leg (not "more than 500"), so the ≥ 1% leg alone carries it; 499 of 50,000 (0.998%) is neither
  assert.equal(breachSelfReportTrigger({ ...q3, affected_count: 500, prior_year_deliveries: 50_000, discovered_on: D("2026-10-15"), validated_on: D("2026-10-20") }).basis, "pct_over_1");
  assert.equal(breachSelfReportTrigger({ ...q3, affected_count: 499, prior_year_deliveries: 50_000, discovered_on: D("2026-10-15"), validated_on: D("2026-10-20") }).required, false);
  assert.equal(breachSelfReportClock({ ...q3, affected_count: 500, prior_year_deliveries: 50_000, discovered_on: D("2026-10-15"), validated_on: D("2026-10-20") }).arms?.basis, "pct_over_1");
  // the repurchase-risk leg anchors on the determination itself
  const rr = breachSelfReportClock({ kind: "repurchase_risk_breach", determined_on: D("2026-10-15") });
  assert.equal(rr.basis, "repurchase_risk_not_remediable_60"); assert.equal(rr.anchor, "2026-10-15"); assert.equal(rr.due, "2026-12-14");
  // the 18.1 `qc.finding.validated` payload → this process's `fraud.self_report.required` (null under both thresholds); the registry row arms on it with the computed anchor
  const ev = selfReportRequiredEvent({ source: "qc.finding.validated", finding_id: "F-2026-118", population: 620, prior_year_deliveries: 80_000, quarter_end: D("2026-09-30"), discovered_on: D("2026-10-15"), validated_on: D("2026-10-20") })!;
  assert.equal(ev.type, "fraud.self_report.required"); assert.deepEqual(ev.payload, { basis: "count_over_500", self_report_anchor_on: "2026-10-15", due: "2026-12-14", source: "qc.finding.validated", source_id: "F-2026-118", channel: "lqc_self_report" });
  assert.equal(selfReportRequiredEvent({ source: "qc.finding.validated", finding_id: "F-2026-119", population: 300, prior_year_deliveries: 80_000, quarter_end: D("2026-09-30"), discovered_on: D("2026-10-15"), validated_on: D("2026-10-20") }), null);
  assert.equal(selfReportRequiredEvent({ source: "repurchase_risk_breach.determined", breach_id: "RRB-7", determined_on: D("2026-10-15") })!.payload.basis, "repurchase_risk_not_remediable_60");
  const { clock, events, timers } = engine(at("2026-10-20", "12:00"));
  events.append({ ...ev, occurredAt: at("2026-10-20", "12:00") });
  const t = timers.byCode("FNMA_A3201_BREACH_SELF_REPORT_60")[0]!; assert.equal(t.anchorDate, "2026-10-15"); assert.equal(t.dueDate, "2026-12-14");
  const mid = engine(at("2026-09-18", "12:00"));
  mid.events.append({ ...selfReportRequiredEvent({ source: "qc.finding.validated", finding_id: "F-2026-101", population: 620, prior_year_deliveries: 80_000, quarter_end: D("2026-09-30"), discovered_on: D("2026-09-10"), validated_on: D("2026-09-18") })!, occurredAt: at("2026-09-18", "12:00") });
  assert.equal(mid.timers.byCode("FNMA_A3201_BREACH_SELF_REPORT_60")[0]!.dueDate, "2026-11-29");   // quarter-end anchor, not the validation date
  // satisfied only by the officer-signed LQC self-report of kind breach_self_report
  clock.set(at("2026-12-10", "12:00"));
  events.append({ ...fraudReportFiledEvent({ case_id: "F-2026-118", loan_id: null, subject: { kind: "self_report", id: "F-2026-118" }, channel: "lqc_self_report", kind: "case_report", ...SIGNED, evidence_document_id: "doc-lqc-sr-118", sent_on: D("2026-12-10"), lqc_reference: "LQC-SR-118" })!, occurredAt: at("2026-12-10", "12:00") });
  assert.equal(t.status, "armed");
  events.append({ ...fraudReportFiledEvent({ case_id: "F-2026-118", loan_id: null, subject: { kind: "self_report", id: "F-2026-118" }, channel: "lqc_self_report", kind: "breach_self_report", ...SIGNED, evidence_document_id: "doc-lqc-sr-118", sent_on: D("2026-12-10"), lqc_reference: "LQC-SR-118" })!, occurredAt: at("2026-12-10", "12:01") });
  assert.equal(t.status, "satisfied");
  // registry row: 60 calendar days from the computed anchor, armed by the process's self-report event, closed by the LQC filing
  const def = loadOverriddenRegistry().get("FNMA_A3201_BREACH_SELF_REPORT_60")!;
  assert.deepEqual(def.offsetParsed, { kind: "step", n: 60, unit: "calendar_days" }); assert.equal(def.anchorField, "self_report_anchor_on");
  assert.equal(def.triggerPattern?.type, late.arms!.type); assert.equal(def.satisfiedPattern?.type, "fraud.report.filed");
  assert.ok(def.satisfiedPattern!.conditions.some((c) => c.field === "channel" && c.value === "lqc_self_report"));
});
test("18.5-T8: Given a protective hold placed 2026-10-05 with no officer renewal, then it expires 2026-11-04 and the payoff proceeds.", () => {
  const base = { loan_id: "L-16", case_id: CASE, action: "hold_payoff_disbursement" as const, placed_on: D("2026-10-05"), reason: HOLD_REASON, renewals: [] };
  // the day before expiry the hold is live: loans.fraud_hold with reason and expiry (the 0050 row), payoff held; 16.x's gate reads the row and holds
  const held = protectiveHold({ ...base, today: D("2026-11-03") });
  assert.equal(held.time_box_days, 30); assert.equal(held.expires_on, "2026-11-04"); assert.equal(held.active, true); assert.equal(held.released_by, null); assert.equal(held.payoff_disbursement, "held");
  assert.deepEqual(held.loan_flag, { fraud_hold: true, reason: HOLD_REASON, expires_on: "2026-11-04" });
  assert.deepEqual(held.loan_row, { loan_id: "L-16", fraud_hold: true, fraud_hold_reason: HOLD_REASON, fraud_hold_expires_on: "2026-11-04", fraud_hold_case_id: CASE });
  assert.equal(held.event.type, "loan.fraud_hold.set"); assert.equal(held.event.loanId, "L-16"); assert.deepEqual(held.event.payload, { loan_id: "L-16", case_id: CASE, action: "hold_payoff_disbursement", fraud_hold: true, reason: HOLD_REASON, expires_on: "2026-11-04", released_by: null });
  assert.deepEqual(payoffDisbursementGate({ loan: held.loan_row, today: D("2026-11-03") }), { gate: "SM_FRAUD_PAYOFF_HOLD", open: false, payoff_disbursement: "held", reason: `payoff disbursement held: ${HOLD_REASON} (expires 2026-11-04)`, expires_on: "2026-11-04" });
  // on 2026-11-04 with no officer renewal it auto-expires: the row clears, `loan.fraud_hold.released{auto_expiry}`, and the payoff proceeds
  const expired = protectiveHold({ ...base, today: D("2026-11-04") });
  assert.equal(expired.active, false); assert.equal(expired.released_by, "auto_expiry"); assert.equal(expired.payoff_disbursement, "proceeds"); assert.deepEqual(expired.loan_flag, { fraud_hold: false, reason: null, expires_on: null });
  assert.deepEqual(expired.loan_row, { loan_id: "L-16", fraud_hold: false, fraud_hold_reason: null, fraud_hold_expires_on: null, fraud_hold_case_id: null });
  assert.equal(expired.event.type, "loan.fraud_hold.released"); assert.equal(expired.event.payload.released_by, "auto_expiry"); assert.equal(expired.event.payload.fraud_hold, false);
  assert.deepEqual(payoffDisbursementGate({ loan: expired.loan_row, today: D("2026-11-04") }), { gate: "SM_FRAUD_PAYOFF_HOLD", open: true, payoff_disbursement: "proceeds", reason: null, expires_on: null });
  assert.equal(payoffDisbursementGate({ loan: held.loan_row, today: D("2026-11-04") }).payoff_disbursement, "proceeds");   // a row not yet cleared on the expiry date: the expiry governs, the payoff proceeds
  assert.equal(protectiveHoldExpires(D("2026-10-05"), null), "2026-11-04");
  // an agent "renewal" is refused and does not extend the hold — the payoff still proceeds on 2026-11-04
  const agentRenew = protectiveHold({ ...base, renewals: [{ renewed_on: D("2026-11-01"), renewed_by_role: "qc-audit", officer_id: null, rationale: "still investigating" }], today: D("2026-11-04") });
  assert.equal(agentRenew.expires_on, "2026-11-04"); assert.equal(agentRenew.accepted_renewals.length, 0); assert.equal(agentRenew.refused_renewals.length, 1); assert.match(agentRenew.refused_renewals[0]!.refusal, /renewed only by the officer/); assert.equal(agentRenew.payoff_disbursement, "proceeds");
  // the fraud officer's renewal with a rationale on 2026-11-01 runs the hold to 2026-12-01; a renewal without a rationale is refused
  const officerRenew = protectiveHold({ ...base, renewals: [{ renewed_on: D("2026-11-01"), renewed_by_role: "officer:fraud_officer", officer_id: "officer:fraud_officer/jlee", rationale: "call-back still unverified; BEC confirmed by Section 19" }], today: D("2026-11-04") });
  assert.equal(officerRenew.expires_on, "2026-12-01"); assert.equal(officerRenew.active, true); assert.equal(officerRenew.payoff_disbursement, "held"); assert.equal(officerRenew.loan_row.fraud_hold_expires_on, "2026-12-01"); assert.equal(protectiveHoldExpires(D("2026-10-05"), D("2026-11-01")), "2026-12-01");
  assert.equal(protectiveHold({ ...base, renewals: [{ renewed_on: D("2026-11-01"), renewed_by_role: "officer:fraud_officer", officer_id: "officer:fraud_officer/jlee", rationale: null }], today: D("2026-11-04") }).expires_on, "2026-11-04");
  // the hold opened with the T1 case carries the same 30-day expiry, on the action and on the loan row
  const opened = openFraudCase({ case_id: CASE, loan_id: "L-16", flags: [FLAG], opened_on: D("2026-10-05") });
  assert.equal(opened.protective_actions[0]!.expires_on, "2026-11-04"); assert.equal(opened.loan_fraud_hold?.fraud_hold_expires_on, "2026-11-04");
});
test("18.5-T9: Given the fraud officer is a subject of an employee case, then the assignment is refused and routed to the deputy/board designee.", () => {
  const refused = caseAssignment({ case_id: "FR-2026-0431", subject_kind: "employee", officer_id: "officer:fraud_officer/jlee", subjects: ["employee/jlee", "officer:fraud_officer/jlee"], deputy_designee: "officer:deputy_fraud_officer/tkim" });
  assert.equal(refused.allowed, false); assert.match(refused.refusal!, /is a subject of employee case FR-2026-0431 \(dual control, rule 7\)/); assert.match(refused.refusal!, /routed to the deputy\/board designee/);
  assert.equal(refused.routed_to, "deputy_or_board_designee"); assert.equal(refused.assigned_to, "officer:deputy_fraud_officer/tkim"); assert.deepEqual(refused.route_chain, ["deputy_fraud_officer", "board_designee"]);
  assert.equal(refused.escalation?.kind, "officer"); assert.equal(refused.escalation?.severity, "sev2"); assert.match(refused.escalation!.reason, /deputy officer:deputy_fraud_officer\/tkim takes the determination/); assert.equal(refused.rescreen_required, true);
  assert.equal(assignmentAllowed("officer:fraud_officer/jlee", ["officer:fraud_officer/jlee"]), false);
  // the deputy's determination is a determination (rule 7 route), the subject officer's would be the same act by a subject — routed away before it is recorded
  assert.equal(determinationRecordedEvent({ case_id: "FR-2026-0431", loan_id: null, officer: { determination: "reasonable_basis", determined_by_officer_id: "officer:deputy_fraud_officer/tkim", determined_by_role: "officer:deputy_fraud_officer", determined_at: D("2026-10-14") }, exposure_cents: 1_200_000n, flags: ["CUSTODIAL_VARIANCE"], subject_kind: "employee" })?.payload.le_referral_candidate, true);
  // no deputy designated → the board designee takes it
  const board = caseAssignment({ case_id: "FR-2026-0431", subject_kind: "employee", officer_id: "officer:fraud_officer/jlee", subjects: ["officer:fraud_officer/jlee"], deputy_designee: null });
  assert.equal(board.allowed, false); assert.equal(board.assigned_to, "board_designee"); assert.match(board.escalation!.reason, /the board designee takes the determination/);
  // the officer is not a subject → the assignment stands (screening still re-runs on employee/vendor cases)
  const ok = caseAssignment({ case_id: "FR-2026-0432", subject_kind: "employee", officer_id: "officer:fraud_officer/jlee", subjects: ["employee/xdoe"], deputy_designee: "officer:deputy_fraud_officer/tkim" });
  assert.equal(ok.allowed, true); assert.equal(ok.refusal, null); assert.equal(ok.assigned_to, "officer:fraud_officer/jlee"); assert.equal(ok.routed_to, null); assert.equal(ok.escalation, null); assert.equal(ok.rescreen_required, true);
  assert.equal(caseAssignment({ case_id: "FR-2026-0433", subject_kind: "borrower", officer_id: "officer:fraud_officer/jlee", subjects: ["borrower/B-1"], deputy_designee: null }).rescreen_required, false);
  // rule 7 second half: an employee-dishonesty determination notifies the board/partner, re-runs the screening lists and discovers the covered loss — `fraud.covered_loss.discovered` arms SM_FRAUD_CARRIER_NOTICE_IMMEDIATE (Wed 2026-10-14 → 1 BD → Thu 2026-10-15)
  const fu = employeeDishonestyFollowUp({ case_id: "FR-2026-0431", loan_id: null, subject_kind: "employee", determination: "reasonable_basis", determined_at: D("2026-10-14"), exposure_cents: 1_200_000n });
  assert.deepEqual([fu.board_partner_notice, fu.rescreen, fu.carrier_notice], [true, true, true]);
  assert.equal(fu.carrier?.timer, "SM_FRAUD_CARRIER_NOTICE_IMMEDIATE"); assert.equal(fu.carrier?.due, "2026-10-15"); assert.equal(fu.carrier?.satisfied_by, "`fraud.report.filed{channel=carrier}`");
  assert.equal(fu.carrier?.event.type, "fraud.covered_loss.discovered"); assert.equal(fu.carrier?.event.payload.discovered_on, "2026-10-14"); assert.equal(fu.carrier?.event.payload.loss_kind, "employee_dishonesty"); assert.equal(fu.carrier?.event.payload.exposure_cents, 1_200_000n);
  assert.equal(fu.carrier?.escalation.kind, "officer"); assert.equal(fu.carrier?.escalation.severity, "sev1"); assert.match(fu.carrier!.escalation.reason, /A3-5-04/); assert.equal(fu.carrier?.escalation.due, "2026-10-15");
  const un = employeeDishonestyFollowUp({ case_id: "FR-2026-0431", loan_id: null, subject_kind: "employee", determination: "unfounded", determined_at: D("2026-10-14"), exposure_cents: 0n });
  assert.deepEqual([un.board_partner_notice, un.rescreen, un.carrier_notice, un.carrier], [false, false, false, null]);
  const bor = employeeDishonestyFollowUp({ case_id: CASE, loan_id: "L-16", subject_kind: "borrower", determination: "reasonable_basis", determined_at: D("2026-10-14"), exposure_cents: 41_250_000n });
  assert.deepEqual([bor.board_partner_notice, bor.rescreen, bor.carrier_notice, bor.carrier], [false, false, false, null]);
  assert.equal(coveredLossDiscoveredEvent({ case_id: "FR-2026-0440", loan_id: "L-40", discovered_on: D("2026-10-16"), loss_kind: "covered_loss", exposure_cents: 500_000n }).due, "2026-10-19");   // Fri → Mon
  // registry: the covered-loss event arms the row (anchor discovered_on); nothing breaches on the due day; the officer-signed carrier claim (channel carrier) satisfies it — an agent-signed one is no notice
  const { clock, events, timers } = engine(at("2026-10-14", "15:00"));
  events.append({ ...fu.carrier!.event, occurredAt: at("2026-10-14", "15:00") });
  const t = timers.byCode("SM_FRAUD_CARRIER_NOTICE_IMMEDIATE")[0]!; assert.equal(t.anchorDate, "2026-10-14"); assert.equal(t.dueDate, "2026-10-15");
  assert.equal(timers.evaluate(at("2026-10-15", "17:00")).length, 0);
  clock.set(at("2026-10-15", "17:30"));
  assert.equal(fraudReportFiledEvent({ case_id: "FR-2026-0431", loan_id: null, channel: "carrier", signed_by_officer_id: "agent:qc-audit", signed_by_role: "qc-audit", evidence_document_id: "doc-carrier-claim-1", sent_on: D("2026-10-15") }), null);
  events.append({ ...fraudReportFiledEvent({ case_id: "FR-2026-0431", loan_id: null, channel: "carrier", ...SIGNED, evidence_document_id: "doc-carrier-claim-1", sent_on: D("2026-10-15") })!, occurredAt: at("2026-10-15", "17:30") });
  assert.equal(t.status, "satisfied");
  // no carrier notice by Thursday 23:59 ET → Friday breaches sev-1 → officer
  const silent = engine(at("2026-10-14", "15:00"));
  silent.events.append({ ...fu.carrier!.event, occurredAt: at("2026-10-14", "15:00") });
  const b = silent.timers.evaluate(at("2026-10-16", "00:30")); assert.equal(b.length, 1); assert.equal(b[0]!.def.code, "SM_FRAUD_CARRIER_NOTICE_IMMEDIATE"); assert.equal(b[0]!.severity, 1);
  assert.equal(breachEscalation(b[0]!, { case_id: "FR-2026-0431", due: D("2026-10-15") }).kind, "officer");
  const def = loadOverriddenRegistry().get("SM_FRAUD_CARRIER_NOTICE_IMMEDIATE")!;
  assert.equal(def.triggerPattern?.type, "fraud.covered_loss.discovered"); assert.equal(def.anchorField, "discovered_on"); assert.deepEqual(def.offsetParsed, { kind: "step", n: 1, unit: "business_days_servicer" }); assert.deepEqual(def.satisfiedPattern!.conditions, [{ field: "channel", op: "=", value: "carrier" }]);
});
test("18.5-T10: Given quarterly fairness stats showing flag rates 4.1% vs 2.0% by protected class, then a finding opens for rule review (routed via counsel).", () => {
  const r = quarterlyFlagFairnessReview({ quarter: "2026-Q3", rates: [{ class: "reference", flag_rate: 0.020, reference: true }, { class: "protected_class_A", flag_rate: 0.041, reference: false }] });
  assert.equal(r.finding_opened, true); assert.equal(r.route, "attorney"); assert.equal(r.findings.length, 1);
  const f = r.findings[0]!;
  assert.equal(f.kind, "rule_review"); assert.equal(f.scope, "fraud_red_flag_rules"); assert.equal(f.route, "attorney"); assert.equal(f.privileged, true); assert.equal(f.quarter, "2026-Q3");
  assert.equal(f.protected_class, "protected_class_A"); assert.equal(f.protected_flag_rate, 0.041); assert.equal(f.reference_flag_rate, 0.02);
  assert.equal(f.ratio, 0.488);                                             // 2.0% / 4.1% adverse-impact ratio, below the 0.80 four-fifths line
  assert.equal(f.escalation.kind, "attorney"); assert.match(f.escalation.reason, /4\.1% for protected_class_A vs 2\.0% reference/); assert.match(f.escalation.reason, /privileged/);
  assert.deepEqual(fraudFlagFairness({ quarter: "2026-Q3", reference_flag_rate: 0.02, protected_flag_rate: 0.041 }).finding, { kind: "rule_review", scope: "fraud_red_flag_rules", route: "attorney", privileged: true, quarter: "2026-Q3" });
  // a class flagged at 2.4% (ratio 0.833) opens nothing; the review is per class, so only the breaching class is a finding
  const two = quarterlyFlagFairnessReview({ quarter: "2026-Q3", rates: [{ class: "reference", flag_rate: 0.02, reference: true }, { class: "protected_class_B", flag_rate: 0.024, reference: false }, { class: "protected_class_A", flag_rate: 0.041, reference: false }] });
  assert.deepEqual(two.results.map((x) => [x.class, x.finding]), [["protected_class_B", false], ["protected_class_A", true]]); assert.equal(two.findings.length, 1);
  assert.equal(quarterlyFlagFairnessReview({ quarter: "2026-Q3", rates: [{ class: "reference", flag_rate: 0.02, reference: true }, { class: "protected_class_B", flag_rate: 0.024, reference: false }] }).finding_opened, false);
  assert.throws(() => quarterlyFlagFairnessReview({ quarter: "2026-Q3", rates: [{ class: "protected_class_A", flag_rate: 0.041, reference: false }] }), RangeError);
});

test("18.5 worked figures: rule 4 clocks (flag 2026-10-05 → diligence 2026-10-20; determination 2026-10-14 → due 2026-11-13, target 2026-11-03; partner 2026-10-06 and 2026-10-15) and the $25,000 law-enforcement referral line", () => {
  const c = fraudClocks(D("2026-10-05"), D("2026-10-14"));
  assert.equal(c.diligence_due, "2026-10-20"); assert.equal(c.fnma_report_due, "2026-11-13"); assert.equal(c.internal_target, "2026-11-03"); assert.equal(c.partner_notice_due, "2026-10-06");
  const legs = partnerNoticeLegs({ opened_on: D("2026-10-05"), score: 90, determined_on: D("2026-10-14") });
  assert.equal(legs.priority, "P1"); assert.deepEqual(legs.legs.map((l) => [l.at, l.due]), [["open", "2026-10-06"], ["determination", "2026-10-15"]]);
  assert.deepEqual(partnerNoticeLegs({ opened_on: D("2026-10-05"), score: 50, determined_on: null }).legs, []);   // P3 case: no 1-BD partner leg at open
  // the same legs through the case and determination events: open leg due 2026-10-06, determination leg due 2026-10-15
  assert.equal(openFraudCase({ case_id: CASE, loan_id: "L-16", flags: [FLAG], opened_on: D("2026-10-05") }).partner_notice.due, "2026-10-06");
  assert.equal(agentDeterminationProposal({ record: RECORD, officer_determination: OFFICER }).partner_notice_due, "2026-10-15");
  // exposure > $25,000 (2,500,000¢) or identity theft / employee dishonesty → attorney decision within 10 BD of the 2026-10-14 determination (Columbus Day 10-12 precedes the anchor: 10/15,16,19,20,21,22,23,26,27,28)
  const over = leReferralDecision({ determination: "reasonable_basis", determined_at: D("2026-10-14"), exposure_cents: LE_REFERRAL_EXPOSURE_THRESHOLD_CENTS + 1n, flags: ["PAYOFF_WIRE_CHANGE"] });
  assert.equal(over.required, true); assert.equal(over.reason, "exposure_over_25000"); assert.equal(over.due, "2026-10-28"); assert.equal(over.decided_by, "attorney"); assert.equal(over.arms.le_referral_candidate, true);
  assert.equal(leReferralDecision({ determination: "reasonable_basis", determined_at: D("2026-10-14"), exposure_cents: 2_500_000n, flags: ["PAYOFF_WIRE_CHANGE"] }).required, false);   // exactly $25,000 is not "> $25,000"
  assert.equal(leReferralDecision({ determination: "reasonable_basis", determined_at: D("2026-10-14"), exposure_cents: 2_500_001n, flags: ["PAYOFF_WIRE_CHANGE"] }).required, true);
  // the scheme prongs are the determined scheme, not a red flag: identity theft (scheme_code, or the 8.3 IDENTITY_THEFT flag from `credit.identity_theft.reported`) and employee dishonesty (scheme_code, or an employee subject)
  assert.deepEqual([...LE_REFERRAL_SCHEMES], ["identity_theft", "employee_dishonesty"]);
  assert.equal(leReferralDecision({ determination: "reasonable_basis", determined_at: D("2026-10-14"), exposure_cents: 40_000n, flags: ["IDENTITY_MISMATCH"], scheme_code: "identity_theft" }).reason, "identity_theft");
  assert.equal(leReferralDecision({ determination: "reasonable_basis", determined_at: D("2026-10-14"), exposure_cents: 40_000n, flags: ["IDENTITY_THEFT"] }).reason, "identity_theft");
  assert.equal(leReferralDecision({ determination: "reasonable_basis", determined_at: D("2026-10-14"), exposure_cents: 40_000n, flags: ["DOC_METADATA_ANOMALY"], subject_kind: "employee" }).reason, "employee_dishonesty");
  assert.equal(leReferralDecision({ determination: "reasonable_basis", determined_at: D("2026-10-14"), exposure_cents: 40_000n, flags: [], scheme_code: "employee_dishonesty" }).required, true);
  // a vendor's SAM/LDP/SCP screening hit with $0 exposure (rule 2: freeze vendor payments) or an identity-mismatch flag alone is neither prong — nothing arms the attorney's 10-BD decision
  assert.equal(leReferralDecision({ determination: "reasonable_basis", determined_at: D("2026-10-14"), exposure_cents: 0n, flags: ["SCREENING_HIT"], subject_kind: "vendor" }).required, false);
  assert.equal(leReferralDecision({ determination: "reasonable_basis", determined_at: D("2026-10-14"), exposure_cents: 40_000n, flags: ["IDENTITY_MISMATCH"] }).required, false);
  assert.equal(leReferralDecision({ determination: "unfounded", determined_at: D("2026-10-14"), exposure_cents: 9_000_000n, flags: ["PAYOFF_WIRE_CHANGE"] }).required, false);
  // the determination event carries the candidate flag the registry row triggers on; a $25,000.00 exposure without an identity-theft/employee-dishonesty scheme does not
  assert.equal(determinationRecordedEvent({ case_id: CASE, loan_id: "L-16", officer: OFFICER, exposure_cents: 2_500_000n, flags: ["PAYOFF_WIRE_CHANGE"] })!.payload.le_referral_candidate, false);
  assert.equal(determinationRecordedEvent({ case_id: CASE, loan_id: "L-16", officer: OFFICER, exposure_cents: 2_500_000n, flags: ["SCREENING_HIT"], subject_kind: "vendor" })!.payload.le_referral_candidate, false);
  assert.equal(determinationRecordedEvent({ case_id: CASE, loan_id: "L-16", officer: OFFICER, exposure_cents: 2_500_000n, flags: ["IDENTITY_MISMATCH"], scheme_code: "identity_theft" })!.payload.le_referral_candidate, true);
  assert.equal(determinationRecordedEvent({ case_id: CASE, loan_id: "L-16", officer: OFFICER, exposure_cents: 41_250_000n, flags: ["PAYOFF_WIRE_CHANGE"] })!.payload.le_referral_candidate, true);
});

test("18.5 tool surface: the fraud module's acts append every event the timer table is armed and satisfied by, with the human acts held to their roles", async () => {
  // spec/registry/agents.json names no tools for 18.5, so the bus slice is empty; the surface is bound here exactly as index.ts would bind it
  assert.deepEqual(TOOLS_18_5, []);
  assert.deepEqual(FRAUD_TOOLS_18_5.map((t) => t.name), ["screening.ofac_match.ingest", "cases.create", "cases.triage", "cases.transition", "cases.assign", "loans.set_hold", "partner.notify", "determination.propose", "determination.record", "report.package", "report.file", "le_referral.decide", "lawfirm.fraud.record", "covered_loss.record", "self_report.require", "incident.notice.record", "fairness.review", "escalations.create", "human_portal_task.create"]);
  assert.ok(FRAUD_TOOLS_18_5.every((t) => t.process === "18.5" && t.agent === "qc-audit"));
  assert.deepEqual(FRAUD_TOOLS_18_5.filter((t) => t.humanOnly).map((t) => [t.name, t.humanRoles]), [["determination.record", ["fraud_officer", "deputy_fraud_officer", "board_designee"]], ["report.file", ["officer"]], ["le_referral.decide", ["attorney"]], ["incident.notice.record", ["officer"]]]);
  const b = bus18_5(at("2026-10-05", "10:00"));
  const codes = () => Object.fromEntries(b.timers.all().map((t) => [t.code, [t.dueDate, t.status]]));
  // T1 through the bus: cases.create on the PAYOFF_WIRE_CHANGE flag → `fraud.case.opened{score=90, partner_notice_leg=open}` + `loan.fraud_hold.set`; three rows armed; the loans row carries the hold; the call-back task and the P1 escalation open
  assert.rejects(() => b.run("cases.create", { case_id: CASE, loan_id: "L-16", flags: [], opened_on: "2026-10-05" }), RangeError);
  const opened = await b.run("cases.create", { case_id: CASE, loan_id: "L-16", flags: [FLAG], opened_on: "2026-10-05", subject_kind: "third_party", exposure_cents: "41250000" });
  assert.equal(opened.score, 90); assert.equal(opened.priority, "P1"); assert.deepEqual(opened.timers, [{ code: "SM_FRAUD_TRIAGE_2BD", due: "2026-10-07" }, { code: "SM_FRAUD_DUE_DILIGENCE_15", due: "2026-10-20" }, { code: "SM_FRAUD_PARTNER_NOTIFY_1BD", due: "2026-10-06" }]);
  assert.deepEqual(codes(), { SM_FRAUD_TRIAGE_2BD: ["2026-10-07", "armed"], SM_FRAUD_DUE_DILIGENCE_15: ["2026-10-20", "armed"], SM_FRAUD_PARTNER_NOTIFY_1BD: ["2026-10-06", "armed"] });
  assert.deepEqual(b.events.all().filter((e) => e.type.startsWith("fraud.") || e.type.startsWith("loan.")).map((e) => e.type), ["fraud.case.opened", "loan.fraud_hold.set"]);
  assert.deepEqual(b.rt.store.get("loans", "L-16")!.data, { loan_id: "L-16", fraud_hold: true, fraud_hold_reason: HOLD_REASON, fraud_hold_expires_on: "2026-11-04", fraud_hold_case_id: CASE });
  assert.deepEqual(b.rt.escalations.opened.map((e) => e.kind), ["human_agent", "fraud_officer"]); assert.equal(b.rt.store.get("fraud_cases", CASE)!.data.status, "flagged");
  // the agent never contacts suspected perpetrators: a portal/contact task aimed at one is refused; the call-back to a number of record goes to the human agent
  assert.equal((await b.refused("human_portal_task.create", { target: "suspected_perpetrator", reason: "ask the closing agent about the wire change" })).code, "AGENT_NEVER_CONTACTS_PERPETRATOR");
  await b.run("human_portal_task.create", { kind: "human_agent", target: "number_of_record", case_id: CASE, reason: "call-back verification" });
  // protective hold: an agent renewal is refused before the handler runs; the officer's renewal with a rationale extends it; on 2026-11-04 with no renewal `loan.fraud_hold.released{auto_expiry}` clears the loans row
  assert.equal((await b.refused("loans.set_hold", { loan_id: "L-16", case_id: CASE, action: "hold_payoff_disbursement", placed_on: "2026-10-05", reason: HOLD_REASON, renewals: [{ renewed_on: "2026-11-01", renewed_by_role: "qc-audit", officer_id: null, rationale: "still investigating" }], today: "2026-11-04" })).code, "HOLD_RENEWAL_OFFICER_ONLY");
  const renewed = await b.run("loans.set_hold", { loan_id: "L-16", case_id: CASE, action: "hold_payoff_disbursement", placed_on: "2026-10-05", reason: HOLD_REASON, renewals: [{ renewed_on: "2026-11-01", renewed_by_role: "officer:fraud_officer", officer_id: "officer:fraud_officer/jlee", rationale: "call-back still unverified" }], today: "2026-11-04" }, FRAUD_OFFICER);
  assert.equal(renewed.expires_on, "2026-12-01"); assert.equal(renewed.payoff_disbursement, "held"); assert.equal(b.rt.store.get("loans", "L-16")!.data.fraud_hold_expires_on, "2026-12-01");
  const expired = await b.run("loans.set_hold", { loan_id: "L-16", case_id: CASE, action: "hold_payoff_disbursement", placed_on: "2026-10-05", reason: HOLD_REASON, renewals: [], today: "2026-11-04" });
  assert.equal(expired.payoff_disbursement, "proceeds"); assert.equal(expired.released_by, "auto_expiry"); assert.equal(b.rt.store.get("loans", "L-16")!.data.fraud_hold, false); assert.equal(b.events.all().at(-2)!.type, "loan.fraud_hold.released");
  // partner notice (open leg) and triage: an unevidenced notice is refused and satisfies nothing; the evidenced one on 2026-10-06 closes the 1-BD row; triage is the flagged → triaged transition and closes the 2-BD row (a second triage is refused)
  b.clock.set(at("2026-10-06", "09:00"));
  assert.equal((await b.refused("partner.notify", { case_id: CASE, loan_id: "L-16", leg: "open", notified_on: "2026-10-06" })).code, "PARTNER_NOTICE_UNEVIDENCED");
  assert.equal(codes().SM_FRAUD_PARTNER_NOTIFY_1BD![1], "armed");
  await b.run("partner.notify", { case_id: CASE, loan_id: "L-16", leg: "open", evidence_document_id: "doc-partner-notice-1", notified_on: "2026-10-06" });
  assert.equal(codes().SM_FRAUD_PARTNER_NOTIFY_1BD![1], "satisfied"); assert.equal(b.rt.store.get("fraud_cases", CASE)!.data.partner_notified_at, "2026-10-06");
  await b.run("cases.triage", { case_id: CASE, rationale: "P1: BEC payoff diversion" });
  assert.equal(codes().SM_FRAUD_TRIAGE_2BD![1], "satisfied"); assert.equal(b.rt.store.get("fraud_cases", CASE)!.data.status, "triaged");
  assert.equal((await b.refused("cases.triage", { case_id: CASE })).code, "CASE_NOT_FLAGGED");
  await b.run("cases.transition", { case_id: CASE, status: "investigating" }); assert.equal(b.rt.store.get("fraud_cases", CASE)!.data.status, "investigating");
  assert.rejects(() => b.run("cases.transition", { case_id: CASE, status: "unfounded_closed" }), RangeError);   // an unfounded close needs its rationale
  // dual control: the fraud officer who is a subject is routed to the deputy
  const assign = await b.run("cases.assign", { case_id: CASE, subject_kind: "third_party", officer_id: "officer:fraud_officer/jlee", subjects: ["officer:fraud_officer/jlee"], deputy_designee: "officer:deputy_fraud_officer/tkim" });
  assert.equal(assign.allowed, false); assert.equal(assign.assigned_to, "officer:deputy_fraud_officer/tkim");
  // T6 through the bus: the agent's 0.95 proposal is a memo (no determination event, fraud_officer escalation); the agent's or an analyst's `determination.record` is refused at the bus; the fraud officer's arms the 30-day row on 2026-10-14
  b.clock.set(at("2026-10-14", "15:00"));
  const memo = await b.run("determination.propose", { record: RECORD });
  assert.equal(memo.report_draft_allowed, false); assert.equal(memo.package, "FRAUD-FILE-v1"); assert.equal(b.events.all().filter((e) => e.type === "fraud.determination.recorded").length, 0); assert.ok(b.events.all().some((e) => e.type === "fraud.determination.proposed" && e.payload.determination_recorded === false && e.payload.confidence === 0.95)); assert.equal(b.rt.escalations.opened.at(-1)!.kind, "fraud_officer");
  const det = { case_id: CASE, loan_id: "L-16", determination: "reasonable_basis", determined_at: "2026-10-14", exposure_cents: "41250000", flags: ["PAYOFF_WIRE_CHANGE"], subject_kind: "third_party", record: RECORD };
  assert.equal((await b.refused("determination.record", det, AGENT_ACTOR)).code, "HUMAN_ONLY");
  assert.equal((await b.refused("determination.record", det, ANALYST)).code, "ROLE_DENIED");
  assert.equal((await b.refused("determination.record", det, SIGNING_OFFICER)).code, "ROLE_DENIED");   // the signing officer is not the fraud officer
  assert.equal(codes().FNMA_A3403_FRAUD_REPORT_30, undefined);
  const recorded = await b.run("determination.record", det, FRAUD_OFFICER);
  assert.equal(recorded.reasonable_basis, true); assert.equal(recorded.le_referral_candidate, true); assert.equal(recorded.fnma_report_due, "2026-11-13"); assert.equal(recorded.internal_target, "2026-11-03"); assert.equal(recorded.partner_notice_due, "2026-10-15"); assert.equal(recorded.case_status, "determined"); assert.equal(recorded.package, "FRAUD-FNMA-SR-v1");
  const detEv = b.events.all().find((e) => e.type === "fraud.determination.recorded")!; assert.deepEqual(detEv.actor, { kind: "human", id: "officer:fraud_officer/jlee", role: "fraud_officer" }); assert.equal(detEv.payload.determined_by_role, "officer:fraud_officer");
  assert.deepEqual([codes().FNMA_A3403_FRAUD_REPORT_30, codes().SM_FRAUD_LE_REFERRAL_DECISION_10BD, codes().SM_FRAUD_DUE_DILIGENCE_15], [["2026-11-13", "armed"], ["2026-10-28", "armed"], ["2026-10-20", "satisfied"]]);
  assert.equal(b.timers.byCode("SM_FRAUD_PARTNER_NOTIFY_1BD").at(-1)!.dueDate, "2026-10-15");   // the determination leg
  assert.ok(b.decisions.some((d) => d.action === "determination.record" && d.approvedBy === "officer:fraud_officer/jlee" && d.approvedRole === "fraud_officer"));
  // the LQC package (rule 5) is drafted only behind the recorded determination and only complete; the officer files it with the LQC reference → the 30-day row is satisfied, the case is `reported`
  const short = await b.run("report.package", { case_id: CASE, content: { scheme_description: "BEC payoff diversion" } });
  assert.equal(short.allowed, true); assert.equal(short.ready_for_signature, false);
  const hash = (seed: string): string => `sha256:${seed.padEnd(64, "0")}`;
  const content = { loan_identifiers: [{ fnma_loan_number: "1234567890", servicer_loan_number: "SM-000016" }], parties: [{ role: "borrower_victim", name: "Jane Q. Borrower" }], scheme_description: "payoff diversion via BEC", timeline: [{ on: "2026-10-02", what: "wire instructions changed" }], evidence: [{ document_id: "doc-wire-change", sha256: hash("9f1c") }], exposure_cents: 41_250_000n, actions_taken: ["payoff disbursement held"], law_enforcement_status: "referral_pending_attorney", contact_person: "J. Lee, fraud officer" };
  const pkg = await b.run("report.package", { case_id: CASE, package_document_id: "doc-lqc-pkg", content });
  assert.equal(pkg.ready_for_signature, true); assert.equal(b.rt.store.get("documents", "doc-lqc-pkg")!.data.kind, "FRAUD-FNMA-SR-v1");
  b.clock.set(at("2026-10-15", "09:00"));
  await b.run("partner.notify", { case_id: CASE, loan_id: "L-16", leg: "determination", evidence_document_id: "doc-partner-notice-2", notified_on: "2026-10-15" });
  assert.equal(b.timers.byCode("SM_FRAUD_PARTNER_NOTIFY_1BD").at(-1)!.status, "satisfied");
  b.clock.set(at("2026-11-03", "10:00"));
  const noRef = await b.run("report.file", { case_id: CASE, loan_id: "L-16", channel: "lqc_self_report", evidence_document_id: "doc-lqc-pkg", package_document_id: "doc-lqc-pkg", sent_on: "2026-11-03" }, SIGNING_OFFICER);
  assert.equal((noRef.outcome as Out).satisfies_timer, false); assert.equal(codes().FNMA_A3403_FRAUD_REPORT_30![1], "armed");   // no LQC reference captured: no satisfaction
  const filed = await b.run("report.file", { case_id: CASE, loan_id: "L-16", channel: "lqc_self_report", evidence_document_id: "doc-lqc-pkg", package_document_id: "doc-lqc-pkg", sent_on: "2026-11-03", lqc_reference: "LQC-SR-2026-0042" }, SIGNING_OFFICER);
  assert.equal((filed.outcome as Out).status, "satisfied"); assert.equal(codes().FNMA_A3403_FRAUD_REPORT_30![1], "satisfied");
  assert.equal(b.rt.store.get("fraud_cases", CASE)!.data.status, "reported"); assert.equal(b.rt.store.get("fraud_cases", CASE)!.data.fnma_report_ref, "LQC-SR-2026-0042"); assert.equal(b.rt.store.get("fraud_reports", `${CASE}:lqc_self_report:2026-11-03`)!.data.lqc_reference, "LQC-SR-2026-0042");
  assert.rejects(() => b.run("report.file", { case_id: CASE, channel: "carrier_pigeon", evidence_document_id: "x" }, SIGNING_OFFICER), RangeError);
  // the attorney's referral decision: the agent is refused (human act); not-refer without a reason is refused; refer records `fraud.le_referral.decided` and `fraud.referral.sent{law_enforcement}` and satisfies the 10-BD row
  assert.equal((await b.refused("le_referral.decide", { case_id: CASE, decision: "refer" }, AGENT_ACTOR)).code, "HUMAN_ONLY");
  assert.equal((await b.refused("le_referral.decide", { case_id: CASE, decision: "not_refer", decided_on: "2026-10-20" }, ATTORNEY)).code, "REFERRAL_REASON_REQUIRED");
  await b.run("le_referral.decide", { case_id: CASE, loan_id: "L-16", decision: "refer", decided_on: "2026-10-20", reason: "USPIS referral", agency: "USPIS" }, ATTORNEY);
  assert.equal(codes().SM_FRAUD_LE_REFERRAL_DECISION_10BD![1], "satisfied"); assert.ok(b.events.all().some((e) => e.type === "fraud.referral.sent" && e.payload.to === "law_enforcement")); assert.equal(b.rt.store.get("fraud_cases", CASE)!.data.law_enforcement_referral_at, "2026-10-20");
  // T5 through the bus: `lawfirm.fraud.record` on Thursday 2026-11-19 arms the 2-BD (Fannie Mae calendar) row → Monday 11-23; the officer's Fannie Mae Legal email satisfies it
  b.clock.set(at("2026-11-19", "16:00"));
  const lf = await b.run("lawfirm.fraud.record", { case_id: "FR-2026-0420", firm_id: "FIRM-77", discovered_on: "2026-11-19" });
  assert.equal(lf.due, "2026-11-23"); assert.equal(lf.calendar, "business_days_fannie_et"); assert.deepEqual(codes().FNMA_A4222_LAWFIRM_FRAUD_2BD, ["2026-11-23", "armed"]);
  b.clock.set(at("2026-11-23", "17:30"));
  await b.run("report.file", { case_id: "FR-2026-0420", channel: "fnma_legal_email", evidence_document_id: "doc-fnma-legal-email-1", sent_on: "2026-11-23" }, SIGNING_OFFICER);
  assert.equal(codes().FNMA_A4222_LAWFIRM_FRAUD_2BD![1], "satisfied");
  // T9 through the bus: the deputy's employee-dishonesty determination discovers the covered loss (rule 7) → `fraud.covered_loss.discovered` arms the 1-BD carrier row; the officer's carrier claim satisfies it; `covered_loss.record` carries the non-employee leg
  b.clock.set(at("2026-10-14", "15:00"));
  const emp = await b.run("determination.record", { case_id: "FR-2026-0431", determination: "reasonable_basis", determined_at: "2026-10-14", exposure_cents: "1200000", flags: ["CUSTODIAL_VARIANCE"], subject_kind: "employee" }, { kind: "human", id: "officer:deputy_fraud_officer/tkim", role: "deputy_fraud_officer" });
  assert.deepEqual([(emp.employee_dishonesty as Out).board_partner_notice, (emp.employee_dishonesty as Out).rescreen, (emp.employee_dishonesty as Out).carrier_notice], [true, true, true]); assert.equal(emp.reasonable_basis, true);
  assert.deepEqual(b.timers.byCode("SM_FRAUD_CARRIER_NOTICE_IMMEDIATE").map((t) => [t.anchorDate, t.dueDate, t.status]), [["2026-10-14", "2026-10-15", "armed"]]);
  b.clock.set(at("2026-10-15", "17:30"));
  await b.run("report.file", { case_id: "FR-2026-0431", channel: "carrier", evidence_document_id: "doc-carrier-claim-1", sent_on: "2026-10-15" }, SIGNING_OFFICER);
  assert.equal(b.timers.byCode("SM_FRAUD_CARRIER_NOTICE_IMMEDIATE")[0]!.status, "satisfied"); assert.equal(b.rt.store.get("fraud_cases", "FR-2026-0431")!.data.carrier_claim_at, "2026-10-15");
  b.clock.set(at("2026-10-16", "11:00"));
  const cl = await b.run("covered_loss.record", { case_id: "FR-2026-0440", loan_id: "L-40", loss_kind: "covered_loss", discovered_on: "2026-10-16", exposure_cents: "500000" });
  assert.equal(cl.due, "2026-10-19"); assert.equal(b.timers.byCode("SM_FRAUD_CARRIER_NOTICE_IMMEDIATE").at(-1)!.dueDate, "2026-10-19");
  // T7 through the bus: the 18.1 finding of 620 loans → `fraud.self_report.required{basis=count_over_500, self_report_anchor_on=2026-10-15}` arms the 60-day row → 2026-12-14; 300 loans arms nothing; the officer's breach self-report satisfies it
  b.clock.set(at("2026-10-20", "12:00"));
  const sr = await b.run("self_report.require", { source: "qc.finding.validated", finding_id: "F-2026-118", population: 620, prior_year_deliveries: 80_000, quarter_end: "2026-09-30", discovered_on: "2026-10-15", validated_on: "2026-10-20" });
  assert.deepEqual([sr.required, sr.basis, sr.self_report_anchor_on, sr.due], [true, "count_over_500", "2026-10-15", "2026-12-14"]); assert.deepEqual(codes().FNMA_A3201_BREACH_SELF_REPORT_60, ["2026-12-14", "armed"]);
  assert.equal((await b.run("self_report.require", { source: "qc.finding.validated", finding_id: "F-2026-119", population: 300, prior_year_deliveries: 80_000, quarter_end: "2026-09-30", discovered_on: "2026-10-15" })).required, false);
  assert.rejects(() => b.run("self_report.require", { source: "somewhere.else" }), RangeError);
  b.clock.set(at("2026-12-10", "12:00"));
  await b.run("report.file", { case_id: "F-2026-118", subject: { kind: "self_report", id: "F-2026-118" }, channel: "lqc_self_report", kind: "breach_self_report", evidence_document_id: "doc-lqc-sr-118", sent_on: "2026-12-10", lqc_reference: "LQC-SR-118" }, SIGNING_OFFICER);
  assert.equal(codes().FNMA_A3201_BREACH_SELF_REPORT_60![1], "satisfied");
  // the Section 19 notice 18.5 co-files: the officer's evidenced send to privacy_office@fanniemae.com is `incident.notice.sent{recipient=fannie_mae_supplement}`; the agent's is refused
  b.clock.set(at("2026-10-05", "14:00"));
  b.events.append({ type: "security.incident.identified", actor: SYSTEM, aggregate: { kind: "security_incident", id: "INC-2026-77" }, payload: { incident_id: "INC-2026-77", severity: "S2", category: "bec", identified_at: at("2026-10-05", "14:00"), fraud_case_id: CASE } });
  assert.equal(toIso(b.timers.byCode("FNMA_ISBR_CYBER_INCIDENT_36H")[0]!.dueAt!), at("2026-10-07", "02:00"));
  assert.equal((await b.refused("incident.notice.record", { incident_id: "INC-2026-77", case_id: CASE, evidence_document_id: "doc-privacy-office-1", bec_payoff_diversion: true }, AGENT_ACTOR)).code, "HUMAN_ONLY");
  b.clock.set(at("2026-10-06", "12:00"));
  assert.equal((await b.refused("incident.notice.record", { incident_id: "INC-2026-77", case_id: CASE, bec_payoff_diversion: true }, SIGNING_OFFICER)).code, "INCIDENT_NOTICE_UNEVIDENCED");
  await b.run("incident.notice.record", { incident_id: "INC-2026-77", case_id: CASE, evidence_document_id: "doc-privacy-office-1", bec_payoff_diversion: true }, SIGNING_OFFICER);
  assert.equal(b.timers.byCode("FNMA_ISBR_CYBER_INCIDENT_36H")[0]!.status, "satisfied"); assert.equal(b.rt.store.get("incident_notices", "INC-2026-77:fannie_mae_supplement")!.data.recipient, "fannie_mae_supplement");
  // T10 through the bus: the quarterly review opens the privileged rule-review finding routed to the attorney
  const fair = await b.run("fairness.review", { quarter: "2026-Q3", rates: [{ class: "reference", flag_rate: 0.02, reference: true }, { class: "protected_class_A", flag_rate: 0.041, reference: false }] });
  assert.equal(fair.finding_opened, true); assert.equal(b.rt.store.get("qc_findings", "fairness:2026-Q3:protected_class_A")!.data.route, "attorney"); assert.equal(b.rt.escalations.opened.at(-1)!.kind, "attorney"); assert.ok(b.events.all().some((e) => e.type === "fraud.fairness.finding.opened" && e.payload.ratio === 0.488));
  await b.run("escalations.create", { case_id: CASE, reason: "determination memo ready" }); assert.equal(b.rt.escalations.opened.at(-1)!.kind, "fraud_officer");
  // every 18.5 registry row was armed by an event a handler appended and closed by one, on this one store
  const armed = new Set(b.timers.all().map((t) => t.code));
  for (const code of ["SM_FRAUD_TRIAGE_2BD", "SM_FRAUD_DUE_DILIGENCE_15", "FNMA_A3403_FRAUD_REPORT_30", "SM_FRAUD_PARTNER_NOTIFY_1BD", "FNMA_A4222_LAWFIRM_FRAUD_2BD", "FNMA_A3201_BREACH_SELF_REPORT_60", "SM_FRAUD_LE_REFERRAL_DECISION_10BD", "SM_FRAUD_CARRIER_NOTICE_IMMEDIATE", "FNMA_ISBR_CYBER_INCIDENT_36H"]) assert.ok(armed.has(code), `${code} armed`);
  // every row of the T1→T2 case (FR-2026-0412) closed on this one store — the engine keys a loan-linked row on the loan (subject `loan L-16`), a loan-less one on the case aggregate;
  // the employee case's (FR-2026-0431, no loan) own 30-day / referral / partner-determination rows and the FR-2026-0440 carrier row (loan L-40) stay armed (nothing filed for them here)
  const l16 = b.timers.all().filter((t) => t.subject.kind === "loan" && t.subject.id === "L-16");
  assert.deepEqual(l16.map((t) => t.code).sort(), ["FNMA_A3403_FRAUD_REPORT_30", "SM_FRAUD_DUE_DILIGENCE_15", "SM_FRAUD_LE_REFERRAL_DECISION_10BD", "SM_FRAUD_PARTNER_NOTIFY_1BD", "SM_FRAUD_PARTNER_NOTIFY_1BD", "SM_FRAUD_TRIAGE_2BD"]);
  assert.ok(l16.every((t) => t.status === "satisfied"), JSON.stringify(l16.map((t) => [t.code, t.status])));
  assert.equal(b.timers.all().filter((t) => t.subject.id === CASE).length, 0);   // no 18.5 row of this case was armed off the loan
  assert.deepEqual(b.timers.all().filter((t) => t.status !== "satisfied").map((t) => [t.code, t.subject.kind, t.subject.id]).sort(), [["FNMA_A3403_FRAUD_REPORT_30", "fraud_case", "FR-2026-0431"], ["SM_FRAUD_CARRIER_NOTICE_IMMEDIATE", "loan", "L-40"], ["SM_FRAUD_LE_REFERRAL_DECISION_10BD", "fraud_case", "FR-2026-0431"], ["SM_FRAUD_PARTNER_NOTIFY_1BD", "fraud_case", "FR-2026-0431"]]);
  // rule 1 aggregation over the red-flag rows: a catalog flag the shared table does not score (OFAC_MATCH) scores by its own row; two distinct flags add 10
  assert.equal(aggregateCaseScore([{ ...FLAG, flag_code: "OFAC_MATCH", score: OFAC_MATCH_FLAG_SCORE }]), 100); assert.equal(aggregateCaseScore([FLAG, { ...FLAG, flag_code: "DOC_METADATA_ANOMALY", score: 60 }]), 100); assert.equal(aggregateCaseScore([{ ...FLAG, flag_code: "INCOME_DOC_INCONSISTENT", score: 50 }, { ...FLAG, flag_code: "DOC_METADATA_ANOMALY", score: 60 }]), 70); assert.equal(aggregateCaseScore([FLAG]), caseScore(["PAYOFF_WIRE_CHANGE"]));
});
