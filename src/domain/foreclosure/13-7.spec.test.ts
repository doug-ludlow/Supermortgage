// 13.7 Environmental hazard / non-routine litigation
// spec/sections/13-foreclosure/13-7-environmental-hazard-non-routine-litigation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Each T-id runs twice: through the pure calculators (./ops.ts, ./litigation.ts) and through the process's tools on the
// bus (`litigation.classify` / `attorney.message.send` ops from src/app/tools/section13-7.ts) with a TimerEngine over the
// 13.7 registry rows (section + process overrides), so the timers the T-id names arm on the events the handlers append
// and are satisfied by them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { assertGate, GateClosed } from "../../app/evaluators.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { SECTION_13_TOOLS } from "../../app/tools/section13.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { maLeadPaintItem, appealFilingGate, pleadingReviewGate, quatroOutage, workoutCounselGate, litigationIntake, form20ExceptionTrigger, environmentalHazard, leadPaintNotification } from "./ops.ts";
import { classify } from "./litigation.ts";

const LOAN = "L-137";
const AGENT: Actor = { kind: "agent", id: "foreclosure-ops" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const ATTORNEY: Actor = { kind: "human", id: "u-attorney", role: "attorney" };
const PORTAL_OP: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
const REP = "servicing.rep@fanniemae.com";

/** The §13 tools on the bus, an event store the TimerEngine (13.7 rows, section + process overrides) listens to, and a movable clock. */
function harness(now: string, loanId = LOAN) {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["13.7"] });
  const ctx: UowContext = { loanId, events, ledger: new MemoryLedger(), timers, clock, decide: () => {} };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, SECTION_13_TOOLS); const bus = new CommandBus(agents);
  const run = async <T = Record<string, unknown>>(tool: "litigation.classify" | "attorney.message.send", input: ToolInput, actor: Actor = AGENT, at?: string): Promise<T> => {
    if (at) clock.set(at); return (await bus.execute(cmds.get(toolKey("13.7", tool))!, actor, { loan_id: loanId, ...input }, ctx, at ? { now: at } : {})).output as T;
  };
  const inst = (code: string) => timers.byCode(code);
  const last = (code: string) => { const all = inst(code); assert.ok(all.length, `${code} armed`); return all[all.length - 1]!; };
  const emitted = (type: string) => events.ofType(type);
  const hold = (kind: "litigation" | "environmental") => rt.store.get("foreclosure_holds", `hold-${loanId}-${kind}`)?.data ?? null;
  return { clock, events, timers, rt, run, inst, last, emitted, hold };
}
const refused = (code: string) => (e: unknown) => e instanceof CommandRefused && e.code === code;
const gateClosed = (code: string) => (e: unknown) => e instanceof GateClosed && e.ref === code;
type Intake = { classification: string; category: number | null; notice_received_at: string; hold: { code: string; steps: string[]; opened_on: string } | null; hold_id: string | null; form20: { required: boolean; deferred_to_trigger: boolean; due: string | null; task_due: string | null; kind: string }; escalation_ids: string[] };
type Submission = { id: string; submitted_on: string; due: string | null; on_time: boolean | null; channel: string; emailed_at?: string; portal_filed_at: string | null; outage_note?: boolean };

test("13.7-T1: Given a complaint served Thursday Sept. 10, 2026 alleging a quiet-title claim, Then classification non-routine (category 2), Form 20 task due, submission recorded by Monday Sept. 14; `LITIGATION_HOLD` opened on judgment/sale.", async () => {
  const r = litigationIntake({ served_on: D("2026-09-10"), damages_against_fnma: false, attacks_validity_priority_enforceability: true, enumerated_risk: false, damages_claim: false, confidence: 0.92, form20_submitted_on: D("2026-09-14") });
  assert.equal(r.classification, "non_routine"); assert.equal(r.category, 2); assert.equal(r.form20.required, true); assert.equal(r.form20.due, "2026-09-14"); assert.equal(r.form20.task, "human_portal_task{kind=form20}"); assert.equal(r.form20.on_time, true);
  assert.deepEqual(r.hold, { code: "LITIGATION_HOLD", steps: ["judgment_motion", "sale_conduct"], opened_on: "2026-09-10" }); assert.equal(r.status_code, "33"); assert.equal(r.escalation, null);
  assert.equal(litigationIntake({ served_on: D("2026-09-10"), damages_against_fnma: false, attacks_validity_priority_enforceability: true, enumerated_risk: false, damages_claim: false, confidence: 0.92, form20_submitted_on: D("2026-09-15") }).form20.on_time, false);
  assert.equal(litigationIntake({ served_on: D("2026-09-10"), damages_against_fnma: true, attacks_validity_priority_enforceability: false, enumerated_risk: false, damages_claim: true, confidence: 0.92, damages_only: true }).hold, null, "damages-only claims do not hold the foreclosure");

  // On the bus: the complaint served Thu 2026-09-10 (quiet title = category 2) arms FNMA_E1302_FORM20_2BD from
  // notice_received_at (+2 servicer BD = Mon 09-14), opens the portal task (due 1 BD after the package) and the hold.
  const h = harness("2026-09-10T15:00:00.000Z");
  const c = await h.run<Intake>("litigation.classify", { source: "service_of_process", served_on: "2026-09-10", attacks_validity_priority_enforceability: true, confidence: 0.92, documents: ["doc-complaint-1"], court: "Harris County District Court", docket_no: "2026-CV-1234" });
  assert.equal(c.classification, "non_routine"); assert.equal(c.category, 2); assert.equal(c.notice_received_at, "2026-09-10");
  assert.deepEqual(c.form20, { required: true, deferred_to_trigger: false, due: "2026-09-14", task_due: "2026-09-11", kind: "non_routine_litigation" });
  assert.deepEqual(c.hold, { code: "LITIGATION_HOLD", steps: ["judgment_motion", "sale_conduct"], opened_on: "2026-09-10" }); assert.ok(c.hold_id);
  assert.deepEqual(h.hold("litigation")!.scope, ["judgment_motion", "sale_conduct"]); assert.equal(h.hold("litigation")!.status, "active");
  assert.deepEqual(h.events.all().map((e) => e.type).filter((t) => t.startsWith("litigation.")), ["litigation.notice.received", "litigation.matter.opened", "litigation.hold.opened"]);
  const notice = h.emitted("litigation.notice.received")[0]!; assert.equal(notice.payload.classification, "non_routine"); assert.equal(notice.payload.exception_category, "none"); assert.equal(notice.payload.form20_due, "2026-09-14");
  const task = h.emitted("escalation.created").find((e) => e.payload.kind === "form20")!; assert.match(String(task.payload.reason), /quatro\.fanniemae\.com by 2026-09-14 — task due 2026-09-11/);
  const clock = h.last("FNMA_E1302_FORM20_2BD"); assert.equal(clock.anchorDate, "2026-09-10"); assert.equal(clock.dueDate, "2026-09-14"); assert.equal(clock.status, "armed");
  assert.equal(h.last("LITIGATION_HOLD").note, "evaluator:13.7.litigationHoldReleased"); assert.equal(h.last("SM_LITIGATION_STATUS_UPDATE_MONTHLY").status, "armed");
  assert.throws(() => assertGate("13.7.litigationHoldReleased", { litigation_hold: true, fnma_direction: "" }), gateClosed("13.7.litigationHoldReleased"));
  // the agent never files: the portal operator records the quatro submission on Mon 09-14 — the clock is satisfied on time
  await assert.rejects(h.run("litigation.classify", { op: "form20_submitted", kind: "non_routine_litigation", package_document_id: "doc-f20-pkg", channel: "quatro", quatro_reference: "Q-2026-0911" }), refused("FORM20_FILED_BY_PORTAL_OPERATOR"));
  const s = await h.run<Submission>("litigation.classify", { op: "form20_submitted", kind: "non_routine_litigation", package_document_id: "doc-f20-pkg", channel: "quatro", quatro_reference: "Q-2026-0911" }, PORTAL_OP, "2026-09-14T14:00:00.000Z");
  assert.equal(s.submitted_on, "2026-09-14"); assert.equal(s.due, "2026-09-14"); assert.equal(s.on_time, true);
  assert.equal(clock.status, "satisfied"); assert.equal(h.emitted("timer.satisfied").filter((e) => e.payload.code === "FNMA_E1302_FORM20_2BD").length, 1);
  assert.equal(h.last("SM_FORM20_RESPONSE_FOLLOWUP_10BD").dueDate, "2026-09-28");   // +10 Fannie Mae ET business days from Mon 09-14
  // Fannie Mae's direction to proceed releases the hold only over the officer's acknowledgment (the servicer of record's)
  const d0 = await h.run<{ hold_released: boolean; escalation_ids: string[] }>("litigation.classify", { op: "form20_responded", submission_id: s.id, direction: "proceed", response_document_id: "doc-fnma-dir" }, AGENT, "2026-09-21T14:00:00.000Z");
  assert.equal(d0.hold_released, false); assert.equal(d0.escalation_ids.length, 1); assert.equal(h.last("SM_FORM20_RESPONSE_FOLLOWUP_10BD").status, "satisfied");
  const d1 = await h.run<{ hold_released: boolean }>("litigation.classify", { op: "form20_responded", submission_id: s.id, direction: "proceed", response_document_id: "doc-fnma-dir" }, OFFICER, "2026-09-21T15:00:00.000Z");
  assert.equal(d1.hold_released, true); assert.equal(h.hold("litigation")!.status, "released"); assert.equal(h.emitted("litigation.hold.released").length, 1);
  // Late: nothing filed by Mon 09-14 ⇒ sev 1 to the officer; the Tue 09-15 filing is recorded late and documented
  const late = harness("2026-09-10T15:00:00.000Z", "L-137-late");
  await late.run("litigation.classify", { served_on: "2026-09-10", attacks_validity_priority_enforceability: true, confidence: 0.92 });
  const breaches = late.timers.evaluate("2026-09-15T12:00:00.000Z"); const b = breaches.find((x) => x.def.code === "FNMA_E1302_FORM20_2BD")!;
  assert.equal(b.severity, 1); assert.deepEqual(b.escalateTo, ["officer"]);
  const ls = await late.run<Submission>("litigation.classify", { op: "form20_submitted", kind: "non_routine_litigation", package_document_id: "doc-f20-pkg", channel: "quatro", quatro_reference: "Q-2" }, PORTAL_OP, "2026-09-15T14:00:00.000Z");
  assert.equal(ls.on_time, false); assert.equal(late.last("FNMA_E1302_FORM20_2BD").status, "satisfied_late");
});
test("13.7-T2: Given a standing defense raised in an answer only, Then no Form 20; when the borrower moves for summary judgment on standing, Then Form 20 within 2 BD.", async () => {
  const answer = form20ExceptionTrigger({ matter: "standing", event: "answer", on: D("2026-10-01") }); assert.equal(answer.form20_required, false); assert.equal(answer.due, null); assert.equal(answer.timer, null);
  const msj = form20ExceptionTrigger({ matter: "standing", event: "summary_judgment_motion", on: D("2026-10-07") }); assert.equal(msj.form20_required, true); assert.equal(msj.due, "2026-10-09"); assert.equal(msj.timer, "FNMA_E1302_FORM20_EXCEPTION_TRIGGER");
  assert.equal(form20ExceptionTrigger({ matter: "mers", event: "briefing", on: D("2026-10-07") }).form20_required, true); assert.equal(form20ExceptionTrigger({ matter: "hamp", event: "trial", on: D("2026-10-07") }).form20_required, true);

  // On the bus: the E-1.3-02 exception — a standing matter is non-routine but reports only on its trigger, so the
  // 2-BD notice clock does not arm; the answer is no trigger; the summary-judgment motion (Wed 10-07) arms
  // FNMA_E1302_FORM20_EXCEPTION_TRIGGER from trigger_on (+2 servicer BD = Fri 10-09).
  const h = harness("2026-10-01T15:00:00.000Z");
  const c = await h.run<Intake>("litigation.classify", { source: "firm", firm_notice_on: "2026-10-01", enumerated_risk: true, exception_category: "standing", confidence: 0.9 });
  assert.equal(c.classification, "non_routine"); assert.deepEqual(c.form20, { required: false, deferred_to_trigger: true, due: null, task_due: null, kind: "non_routine_litigation" });
  assert.equal(h.inst("FNMA_E1302_FORM20_2BD").length, 0, "the exception category never arms the notice clock"); assert.equal(h.emitted("escalation.created").filter((e) => e.payload.kind === "form20").length, 0);
  const a = await h.run<{ form20_required: boolean; form20_due: string | null; timer: string | null }>("litigation.classify", { op: "trigger", event: "answer", on: "2026-10-01" });
  assert.equal(a.form20_required, false); assert.equal(a.timer, null); assert.equal(h.emitted("litigation.trigger").length, 0); assert.equal(h.inst("FNMA_E1302_FORM20_EXCEPTION_TRIGGER").length, 0);
  const m = await h.run<{ form20_required: boolean; form20_due: string | null; timer: string | null; exception_trigger: string }>("litigation.classify", { op: "trigger", event: "summary_judgment_motion", on: "2026-10-07", source: "docket" }, AGENT, "2026-10-07T16:00:00.000Z");
  assert.equal(m.form20_required, true); assert.equal(m.form20_due, "2026-10-09"); assert.equal(m.timer, "FNMA_E1302_FORM20_EXCEPTION_TRIGGER"); assert.equal(m.exception_trigger, "summary_judgment");
  assert.equal(h.emitted("litigation.trigger")[0]!.payload.trigger_on, "2026-10-07"); assert.equal(h.emitted("escalation.created").filter((e) => e.payload.kind === "form20").length, 1);
  const t = h.last("FNMA_E1302_FORM20_EXCEPTION_TRIGGER"); assert.equal(t.anchorDate, "2026-10-07"); assert.equal(t.dueDate, "2026-10-09"); assert.equal(t.status, "armed");
  const s = await h.run<Submission>("litigation.classify", { op: "form20_submitted", kind: "non_routine_litigation", package_document_id: "doc-f20-msj", channel: "quatro", quatro_reference: "Q-3" }, PORTAL_OP, "2026-10-09T14:00:00.000Z");
  assert.equal(s.due, "2026-10-09"); assert.equal(s.on_time, true); assert.equal(t.status, "satisfied");
});
test('13.7-T3: Given an inspection noting "possible meth contamination," Then `suspected` → confirmation task; confirmed ⇒ gate closed, Servicing Representative report within 2 BD, referral refused.', async () => {
  const suspected = environmentalHazard({ state: "suspected", on: D("2026-09-10") });
  assert.deepEqual(suspected.confirmation_task, { due: "2026-09-20" }); assert.equal(suspected.gate_closed, false); assert.equal(suspected.referral_allowed, true); assert.equal(suspected.report_by, null);
  const confirmed = environmentalHazard({ state: "confirmed", on: D("2026-09-10"), report: { value: 18_500_000n, debt: 21_000_000n, occupancy: "vacant", children_under_8: false, documentation: ["doc-lab-1"], recommendation: "hold" } });
  assert.equal(confirmed.gate, "FNMA_F108_ENV_NO_FORECLOSURE_GATE"); assert.equal(confirmed.gate_closed, true); assert.equal(confirmed.referral_allowed, false); assert.equal(confirmed.report_by, "2026-09-14"); assert.deepEqual(confirmed.report_elements_missing, []); assert.match(confirmed.refusal!, /foreclosure\.refer refused/);
  assert.deepEqual(environmentalHazard({ state: "confirmed", on: D("2026-09-10"), report: null }).report_elements_missing, ["value", "debt", "occupancy", "children_under_8", "documentation", "recommendation"]);

  // On the bus: the inspection note opens the confirmation task (10 days, policy) and — decision 3 — the environmental
  // hold immediately; confirmation closes the F-1-08 gate, arms SM_ENV_SERVICING_REP_REPORT_2BD from confirmed_on
  // (Thu 09-10 → Mon 09-14) and the complete report satisfies it; only Fannie Mae's direction to proceed, recorded by
  // the officer, reopens the gate.
  const h = harness("2026-09-10T15:00:00.000Z");
  const s = await h.run<{ confirmation_task: { due: string; escalation_id: string | null }; gate_closed: boolean; referral_allowed: boolean; hold_policy: string; severity: string }>("litigation.classify", { op: "hazard_suspected", hazard_id: "hz-meth-1", kind: "meth_lab", source: "inspection", detected_on: "2026-09-10", note: "possible meth contamination", inspection_id: "insp-2026-09-10" });
  assert.equal(s.severity, "suspected"); assert.equal(s.confirmation_task.due, "2026-09-20"); assert.ok(s.confirmation_task.escalation_id); assert.equal(s.gate_closed, false); assert.equal(s.referral_allowed, false); assert.equal(s.hold_policy, "hold_on_suspicion");
  assert.deepEqual(h.hold("environmental")!.scope, ["refer", "first_notice", "judgment_motion", "sale_conduct"]); assert.equal(h.inst("FNMA_F108_ENV_NO_FORECLOSURE_GATE").length, 0, "the gate row arms on confirmation");
  const c = await h.run<{ gate: string; gate_closed: boolean; referral_allowed: boolean; refusal: string; report_by: string; lead_paint_notification_due: string | null; severity: string }>("litigation.classify", { op: "hazard_confirmed", hazard_id: "hz-meth-1", kind: "meth_lab", source: "inspection", confirmed_on: "2026-09-10", evidence_document_id: "doc-lab-1", referred: false });
  assert.equal(c.severity, "confirmed"); assert.equal(c.gate, "FNMA_F108_ENV_NO_FORECLOSURE_GATE"); assert.equal(c.gate_closed, true); assert.equal(c.referral_allowed, false); assert.match(c.refusal, /foreclosure\.refer refused: FNMA_F108_ENV_NO_FORECLOSURE_GATE/); assert.equal(c.report_by, "2026-09-14"); assert.equal(c.lead_paint_notification_due, null);
  assert.equal(h.last("FNMA_F108_ENV_NO_FORECLOSURE_GATE").note, "evaluator:13.7.environmentalDirectionToProceed");
  assert.throws(() => assertGate("13.7.environmentalDirectionToProceed", { environmental_hazard_confirmed: true, fnma_direction: "" }), gateClosed("13.7.environmentalDirectionToProceed"));
  const rep = h.last("SM_ENV_SERVICING_REP_REPORT_2BD"); assert.equal(rep.anchorDate, "2026-09-10"); assert.equal(rep.dueDate, "2026-09-14"); assert.equal(rep.status, "armed");
  await assert.rejects(h.run("litigation.classify", { op: "servicing_rep_report", hazard_id: "hz-meth-1", servicing_rep: REP, report: { value: 18_500_000n, documentation: ["doc-lab-1"] } }), /missing debt, occupancy, children_under_8, recommendation/);
  const r = await h.run<{ due: string; sent_on: string; on_time: boolean; servicing_rep_reported_at: string }>("litigation.classify", { op: "servicing_rep_report", hazard_id: "hz-meth-1", servicing_rep: REP, report: { value: 18_500_000n, debt: 21_000_000n, occupancy: "vacant", children_under_8: false, documentation: ["doc-lab-1"], recommendation: "hold" } }, AGENT, "2026-09-11T14:00:00.000Z");
  assert.equal(r.due, "2026-09-14"); assert.equal(r.sent_on, "2026-09-11"); assert.equal(r.on_time, true); assert.equal(r.servicing_rep_reported_at, "2026-09-11T14:00:00.000Z");
  const sent = h.emitted("fnma.servicing_rep.notified")[0]!; assert.equal(sent.payload.kind, "environmental_hazard"); assert.equal(sent.payload.property_value_cents, 18_500_000n); assert.equal(sent.payload.outstanding_debt_cents, 21_000_000n);
  assert.equal(rep.status, "satisfied"); assert.equal(h.emitted("environmental.report.sent").length, 1);
  await assert.rejects(h.run("litigation.classify", { op: "hazard_direction", hazard_id: "hz-meth-1", direction: "proceed", document_id: "doc-fnma-env" }), refused("FNMA_DIRECTION_ACKNOWLEDGED_BY_OFFICER"));
  const d = await h.run<{ status: string; hold_released: boolean; fnma_direction: string }>("litigation.classify", { op: "hazard_direction", hazard_id: "hz-meth-1", direction: "proceed", document_id: "doc-fnma-env" }, OFFICER, "2026-09-18T14:00:00.000Z");
  assert.equal(d.status, "fnma_directed_proceed"); assert.equal(d.hold_released, true); assert.equal(h.hold("environmental")!.status, "released");
  assertGate("13.7.environmentalDirectionToProceed", { environmental_hazard_confirmed: true, fnma_direction: d.fnma_direction });
});
test(`13.7-T4: Given a lead-paint citation on a referred 1–4 unit property, Then the notification with value/debt/children-under-8/documentation is sent within 30 days of referral.`, async () => {
  const r = leadPaintNotification({ referral_on: D("2026-06-30"), units: 2, notification: { property_value_cents: 18_500_000n, total_debt_cents: 21_000_000n, children_under_8: true, documentation_ids: ["doc-citation-1"] }, sent_on: D("2026-07-20") });
  assert.equal(r.applies, true); assert.equal(r.due, "2026-07-30"); assert.equal(r.timer, "FNMA_F108_LEAD_PAINT_NOTIFY_30"); assert.equal(r.complete, true); assert.deepEqual(r.elements_missing, []); assert.equal(r.on_time, true);
  assert.deepEqual(leadPaintNotification({ referral_on: D("2026-06-30"), units: 2, notification: { property_value_cents: 18_500_000n, documentation_ids: [] } }).elements_missing, ["total_debt_cents", "children_under_8", "documentation_ids"]);
  assert.equal(leadPaintNotification({ referral_on: D("2026-06-30"), units: 2, notification: null, sent_on: D("2026-07-31") }).on_time, false); assert.equal(leadPaintNotification({ referral_on: D("2026-06-30"), units: 6, notification: null }).applies, false);

  // On the bus: the citation confirmed on a loan referred 2026-06-30 (2 units) arms FNMA_F108_LEAD_PAINT_NOTIFY_30
  // from the referral date (+30 calendar days = 2026-07-30), not from the confirmation; the complete notification
  // satisfies it; an incomplete one is refused; a 6-unit property is outside F-1-08's 1–4 unit rule.
  const h = harness("2026-07-06T15:00:00.000Z");
  const c = await h.run<{ lead_paint_notification_due: string | null; report_by: string }>("litigation.classify", { op: "hazard_confirmed", hazard_id: "hz-lp-1", kind: "lead_paint", source: "code_violation", confirmed_on: "2026-07-06", evidence_document_id: "doc-citation-1", citation_document_id: "doc-citation-1", referred: true, referral_on: "2026-06-30", units: 2 });
  assert.equal(c.lead_paint_notification_due, "2026-07-30"); assert.equal(c.report_by, "2026-07-08");
  const t = h.last("FNMA_F108_LEAD_PAINT_NOTIFY_30"); assert.equal(t.anchorDate, "2026-06-30"); assert.equal(t.dueDate, "2026-07-30"); assert.equal(t.status, "armed");
  await assert.rejects(h.run("litigation.classify", { op: "lead_paint_notification", hazard_id: "hz-lp-1", servicing_rep: REP, notification: { property_value_cents: 18_500_000n, documentation_ids: [] } }), /missing total_debt_cents, children_under_8, documentation_ids/);
  const n = await h.run<{ due: string; sent_on: string; on_time: boolean; timer: string; children_under_8: boolean }>("litigation.classify", { op: "lead_paint_notification", hazard_id: "hz-lp-1", servicing_rep: REP, notification: { property_value_cents: 18_500_000n, total_debt_cents: 21_000_000n, children_under_8: true, documentation_ids: ["doc-citation-1"] } }, AGENT, "2026-07-20T14:00:00.000Z");
  assert.equal(n.due, "2026-07-30"); assert.equal(n.sent_on, "2026-07-20"); assert.equal(n.on_time, true); assert.equal(n.timer, "FNMA_F108_LEAD_PAINT_NOTIFY_30"); assert.equal(n.children_under_8, true);
  const sent = h.emitted("fnma.servicing_rep.notified").find((e) => e.payload.kind === "lead_paint")!; assert.equal(sent.payload.referral_on, "2026-06-30"); assert.equal(sent.payload.outstanding_debt_cents, 21_000_000n); assert.deepEqual(sent.payload.documentation_ids, ["doc-citation-1"]);
  assert.equal(t.status, "satisfied"); assert.equal(h.emitted("lead_paint.notification.sent").length, 1);
  await h.run("litigation.classify", { op: "hazard_confirmed", hazard_id: "hz-lp-6", kind: "lead_paint", source: "code_violation", confirmed_on: "2026-07-06", evidence_document_id: "doc-citation-6", referred: true, referral_on: "2026-06-30", units: 6 });
  assert.equal(h.inst("FNMA_F108_LEAD_PAINT_NOTIFY_30").length, 1, "6 units: no lead-paint notification clock");
  await assert.rejects(h.run("litigation.classify", { op: "lead_paint_notification", hazard_id: "hz-lp-6", servicing_rep: REP, notification: { property_value_cents: 1n, total_debt_cents: 1n, children_under_8: false, documentation_ids: ["d"] } }), /1–4 unit properties \(units=6\)/);
});
test("13.7-T5: Given MA property without a citation search, Then prereferral review fails (13.4-T6).", async () => {
  assert.equal(maLeadPaintItem({ state: "MA" }).passed, false); assert.equal(maLeadPaintItem({ state: "MA", citation_search_document_id: "doc-lp" }).passed, true);
  // the completed search is the evidence the 13.4 checklist item reads (`environmental.ma_citation_search.completed`)
  const h = harness("2026-09-10T15:00:00.000Z");
  await assert.rejects(h.run("litigation.classify", { op: "ma_citation_search", state: "TX", search_document_id: "doc-lp", completed_on: "2026-09-09" }), /Massachusetts pre-referral requirement/);
  const r = await h.run<{ ma_lead_paint_citation_search_completed: boolean; citation_search_document_id: string }>("litigation.classify", { op: "ma_citation_search", state: "MA", search_document_id: "doc-lp", completed_on: "2026-09-09", citations_found: 0 });
  assert.equal(r.ma_lead_paint_citation_search_completed, true); assert.equal(maLeadPaintItem({ state: "MA", citation_search_document_id: r.citation_search_document_id }).passed, true);
  assert.equal(h.emitted("environmental.ma_citation_search.completed")[0]!.payload.ma_lead_paint_citation_search_completed, true);
});
test("13.7-T6: Given a proposed appeal of an adverse judgment, Then the `attorney` cannot file until Fannie Mae's written approval is stored.", async () => {
  const r = appealFilingGate({}); assert.equal(r.allowed, false); assert.match(r.refusal!, /written approval is not stored/); assert.equal(r.gate, "FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE");
  assert.equal(appealFilingGate({ fnma_written_approval_document_id: "doc-appr" }).allowed, true);

  // On the bus: the proposal arms FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE and routes the request through the partner
  // officer; the attorney's filing is refused (trail: foreclosure.gate.refused) until the officer stores the approval.
  const h = harness("2026-11-02T15:00:00.000Z");
  await h.run("litigation.classify", { served_on: "2026-09-10", attacks_validity_priority_enforceability: true, confidence: 0.92 });
  await assert.rejects(h.run("attorney.message.send", { kind: "removal_or_appeal_proposed", proposal: "appeal", basis: "adverse judgment 2026-10-30" }), /judgment_document_id/);
  const p = await h.run<{ status: string; pending_approval: string; escalation_ids: string[] }>("attorney.message.send", { kind: "removal_or_appeal_proposed", proposal: "appeal", basis: "adverse judgment 2026-10-30", judgment_document_id: "doc-judgment" }, ATTORNEY);
  assert.equal(p.status, "appeal"); assert.equal(p.pending_approval, "appeal"); assert.equal(h.emitted("escalation.created").filter((e) => e.payload.kind === "officer").length, 1);
  assert.equal(h.last("FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE").note, "evaluator:13.7.fannieMaePriorWrittenApproval"); assert.equal(h.emitted("litigation.approval.requested")[0]!.payload.transmitted_by_role, "officer");
  await assert.rejects(h.run("attorney.message.send", { kind: "file_removal_or_appeal", proposal: "appeal" }, AGENT), refused("ATTORNEY_FILES"));
  await assert.rejects(h.run("attorney.message.send", { kind: "file_removal_or_appeal", proposal: "appeal" }, ATTORNEY), gateClosed("FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE"));
  assert.equal(h.emitted("foreclosure.gate.refused")[0]!.payload.code, "FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE");
  await assert.rejects(h.run("attorney.message.send", { kind: "approval_granted", proposal: "appeal", document_id: "doc-appr" }, ATTORNEY), refused("APPROVAL_RECORDED_BY_OFFICER"));
  await h.run("attorney.message.send", { kind: "approval_granted", proposal: "appeal", document_id: "doc-appr" }, OFFICER, "2026-11-10T15:00:00.000Z");
  const f = await h.run<{ allowed: boolean; approval_document_id: string }>("attorney.message.send", { kind: "file_removal_or_appeal", proposal: "appeal" }, ATTORNEY, "2026-11-12T15:00:00.000Z");
  assert.equal(f.allowed, true); assert.equal(f.approval_document_id, "doc-appr"); assert.equal(h.emitted("litigation.removal_or_appeal.filed").length, 1);
});
test(`13.7-T7: Given a substantive motion due in 12 days, Then the draft must be given to Fannie Mae ≥5 BD before; the gate refuses filing otherwise.`, async () => {
  const due = D("2026-10-19");   // 12 days out from 2026-10-07
  const r = pleadingReviewGate({ filing_due: due, draft_given_on: D("2026-10-13") }); assert.equal(r.draft_due, "2026-10-09"); assert.equal(r.allowed, false); assert.match(r.refusal!, /PLEADING_REVIEW_GATE/);   // 5 servicer BD before Mon 10-19 skip Columbus Day
  assert.equal(pleadingReviewGate({ filing_due: due, draft_given_on: D("2026-10-09") }).allowed, true);

  // On the bus: the deadline arms FNMA_E1301_PLEADING_REVIEW_GATE on filing_deadline; a draft given Tue 10-13 leaves
  // Fannie Mae 4 servicer BD (14, 15, 16, 19) — the attorney's filing is refused; a draft given Fri 10-09 leaves exactly 5.
  const h = harness("2026-10-07T15:00:00.000Z");
  await h.run("litigation.classify", { served_on: "2026-09-10", attacks_validity_priority_enforceability: true, confidence: 0.92 });
  const p = await h.run<{ draft_due_to_fnma: string; gate: string }>("attorney.message.send", { kind: "pleading_due", pleading_id: "pl-1", pleading_kind: "motion", filing_deadline: "2026-10-19" }, ATTORNEY);
  assert.equal(p.draft_due_to_fnma, "2026-10-09"); assert.equal(p.gate, "FNMA_E1301_PLEADING_REVIEW_GATE");
  const g = h.last("FNMA_E1301_PLEADING_REVIEW_GATE"); assert.equal(g.anchorDate, "2026-10-19"); assert.equal(g.note, "evaluator:13.7.pleadingDraftGivenInTime");
  await assert.rejects(h.run("attorney.message.send", { kind: "file_pleading", pleading_id: "pl-1" }, AGENT), refused("ATTORNEY_FILES"));
  await assert.rejects(h.run("attorney.message.send", { kind: "file_pleading", pleading_id: "pl-1" }, ATTORNEY), gateClosed("FNMA_E1301_PLEADING_REVIEW_GATE"));
  const d = await h.run<{ business_days_before_deadline: number; in_time: boolean }>("attorney.message.send", { kind: "draft_to_fnma", pleading_id: "pl-1", document_id: "doc-draft-1" }, ATTORNEY, "2026-10-13T15:00:00.000Z");
  assert.equal(d.business_days_before_deadline, 4); assert.equal(d.in_time, false);
  await assert.rejects(h.run("attorney.message.send", { kind: "file_pleading", pleading_id: "pl-1" }, ATTORNEY, "2026-10-16T15:00:00.000Z"), gateClosed("FNMA_E1301_PLEADING_REVIEW_GATE"));
  assert.deepEqual(h.emitted("foreclosure.gate.refused").map((e) => [e.payload.code, e.payload.draft_due]), [["FNMA_E1301_PLEADING_REVIEW_GATE", "2026-10-09"], ["FNMA_E1301_PLEADING_REVIEW_GATE", "2026-10-09"]]);
  // Fannie Mae's comments received close the window on the short lead (attorney justification); a second motion drafted on time files without them
  await h.run("attorney.message.send", { kind: "review_closed", pleading_id: "pl-1", result: "comments_received", comments_document_id: "doc-fnma-comments" }, ATTORNEY, "2026-10-16T18:00:00.000Z");
  assert.equal((await h.run<{ allowed: boolean }>("attorney.message.send", { kind: "file_pleading", pleading_id: "pl-1" }, ATTORNEY, "2026-10-19T15:00:00.000Z")).allowed, true);
  await h.run("attorney.message.send", { kind: "pleading_due", pleading_id: "pl-2", pleading_kind: "brief", filing_deadline: "2026-10-19" }, ATTORNEY, "2026-10-07T15:00:00.000Z");
  const d2 = await h.run<{ business_days_before_deadline: number; in_time: boolean }>("attorney.message.send", { kind: "draft_to_fnma", pleading_id: "pl-2", document_id: "doc-draft-2" }, ATTORNEY, "2026-10-09T15:00:00.000Z");
  assert.equal(d2.business_days_before_deadline, 5); assert.equal(d2.in_time, true);   // 13, 14, 15, 16, 19 (Columbus Day 10-12 is a servicer holiday)
  const f = await h.run<{ allowed: boolean }>("attorney.message.send", { kind: "file_pleading", pleading_id: "pl-2" }, ATTORNEY, "2026-10-19T15:00:00.000Z");
  assert.equal(f.allowed, true); assert.equal(h.emitted("litigation.pleading.filed").length, 2);
});
test("13.7-T8: Given quatro is down, Then package emailed to Legal with an outage note and the portal filing completed when restored; both timestamps kept.", async () => {
  const r = quatroOutage({ notice_received_on: D("2026-10-07"), outage: true, restored_on: D("2026-10-08") });
  assert.equal(r.form20_due, "2026-10-09"); assert.deepEqual(r.email_sent, { on: "2026-10-07", outage_note: true }); assert.equal(r.portal_filed_on, "2026-10-08"); assert.deepEqual(r.timestamps, { email: "2026-10-07", portal: "2026-10-08" });

  // On the bus: the outage email to Legal is the Form 20 submission (it carries the outage note; without it email is
  // refused) and satisfies FNMA_E1302_FORM20_2BD; the portal filing when quatro is restored keeps both timestamps.
  const h = harness("2026-10-07T15:00:00.000Z");
  await h.run("litigation.classify", { served_on: "2026-10-07", attacks_validity_priority_enforceability: true, confidence: 0.92 });
  assert.equal(h.last("FNMA_E1302_FORM20_2BD").dueDate, "2026-10-09");
  await assert.rejects(h.run("litigation.classify", { op: "form20_submitted", kind: "non_routine_litigation", package_document_id: "doc-f20-pkg", channel: "email" }, PORTAL_OP), /outage_note is required/);
  await assert.rejects(h.run("litigation.classify", { op: "form20_submitted", kind: "non_routine_litigation", package_document_id: "doc-f20-pkg", channel: "quatro" }, PORTAL_OP), /quatro_reference/);
  const e = await h.run<Submission>("litigation.classify", { op: "form20_submitted", kind: "non_routine_litigation", package_document_id: "doc-f20-pkg", channel: "email", outage_note: true, submitted_at: "2026-10-07T16:05:00.000Z" }, PORTAL_OP, "2026-10-07T16:05:00.000Z");
  assert.equal(e.channel, "email"); assert.equal(e.outage_note, true); assert.equal(e.emailed_at, "2026-10-07T16:05:00.000Z"); assert.equal(e.portal_filed_at, null); assert.equal(e.on_time, true);
  assert.equal(h.last("FNMA_E1302_FORM20_2BD").status, "satisfied"); assert.equal(h.emitted("form20.submitted")[0]!.payload.outage_note, true);
  const f = await h.run<{ emailed_at: string; portal_filed_at: string; quatro_reference: string; timestamps: { email: string; portal: string } }>("litigation.classify", { op: "form20_portal_filed", submission_id: e.id, quatro_reference: "Q-2026-1008", filed_at: "2026-10-08T14:30:00.000Z" }, PORTAL_OP, "2026-10-08T14:30:00.000Z");
  assert.deepEqual(f.timestamps, { email: "2026-10-07T16:05:00.000Z", portal: "2026-10-08T14:30:00.000Z" }); assert.equal(f.emailed_at, "2026-10-07T16:05:00.000Z"); assert.equal(f.portal_filed_at, "2026-10-08T14:30:00.000Z"); assert.equal(f.quatro_reference, "Q-2026-1008");
  assert.equal(h.emitted("form20.portal_filed")[0]!.payload.emailed_at, "2026-10-07T16:05:00.000Z"); assert.equal(h.inst("FNMA_E1302_FORM20_2BD").length, 1);
});
test("13.7-T9: Given a payment-deferral offer on a litigated loan, Then counsel is notified before the offer leaves (gate).", async () => {
  const r = workoutCounselGate({ litigated: true, counsel_notified_on: null, counsel_acknowledged: false }); assert.equal(r.allowed, false); assert.equal(r.gate, "FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE");
  assert.equal(workoutCounselGate({ litigated: true, counsel_notified_on: D("2026-10-07"), counsel_acknowledged: true }).allowed, true); assert.equal(workoutCounselGate({ litigated: false, counsel_notified_on: null, counsel_acknowledged: false }).allowed, true);

  // On the bus: the offer is held (trail: foreclosure.gate.refused{command=lossmit.offer.send}) until counsel is notified
  // with the policy 5 BD and acknowledges — counsel's own acknowledgment, never the agent's.
  const h = harness("2026-10-07T15:00:00.000Z");
  await h.run("litigation.classify", { served_on: "2026-09-10", attacks_validity_priority_enforceability: true, confidence: 0.92 });
  await assert.rejects(h.run("attorney.message.send", { kind: "workout_offer_release", option: "payment_deferral" }), gateClosed("FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE"));
  assert.equal(h.emitted("foreclosure.gate.refused")[0]!.payload.command, "lossmit.offer.send");
  const n = await h.run<{ counsel_window_ends: string; gate: string }>("attorney.message.send", { kind: "workout_notice", firm_id: "F-1", option: "payment_deferral", evaluation_id: "ev-1" });
  assert.equal(n.counsel_window_ends, "2026-10-15");   // Wed 10-07 + 5 servicer BD: 8, 9, 13, 14, 15 (Columbus Day 10-12 skipped) assert.equal(n.gate, "FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE"); assert.equal(h.emitted("litigation.counsel.notified")[0]!.payload.kind, "workout_notice");
  await assert.rejects(h.run("attorney.message.send", { kind: "workout_offer_release", option: "payment_deferral" }), gateClosed("FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE"));
  await assert.rejects(h.run("attorney.message.send", { kind: "counsel_ack", firm_id: "F-1" }, AGENT), refused("COUNSEL_ACK_IS_COUNSELS"));
  await h.run("attorney.message.send", { kind: "counsel_ack", firm_id: "F-1", position: "no objection" }, ATTORNEY, "2026-10-09T15:00:00.000Z");
  const rel = await h.run<{ allowed: boolean; litigated: boolean; counsel_acknowledged: boolean }>("attorney.message.send", { kind: "workout_offer_release", option: "payment_deferral" }, AGENT, "2026-10-09T16:00:00.000Z");
  assert.deepEqual(rel, { allowed: true, gate: "FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE", litigated: true, counsel_acknowledged: true }); assert.equal(h.emitted("litigation.workout_offer.released").length, 1);
  // an unlitigated loan is never held
  const u = harness("2026-10-07T15:00:00.000Z", "L-137-clean");
  assert.equal((await u.run<{ allowed: boolean; litigated: boolean }>("attorney.message.send", { kind: "workout_offer_release", option: "payment_deferral" })).litigated, false);
});
test('13.7-T10: Given a model classification "routine" with confidence 0.7 and a damages claim present, Then `attorney` confirmation required before "routine" is accepted.', async () => {
  assert.deepEqual(classify({ damages_against_fnma: false, attacks_validity_priority_enforceability: false, enumerated_risk: false, damages_claim: true, confidence: 0.7 }), { classification: "attorney_confirmation_required", category: null });
  const r = litigationIntake({ served_on: D("2026-09-10"), damages_against_fnma: false, attacks_validity_priority_enforceability: false, enumerated_risk: false, damages_claim: true, confidence: 0.7 });
  assert.equal(r.classification, "attorney_confirmation_required"); assert.equal(r.hold, null); assert.equal(r.escalation!.kind, "attorney"); assert.match(r.escalation!.reason, /confirmation required before "routine" is accepted/);
  assert.equal(classify({ damages_against_fnma: false, attacks_validity_priority_enforceability: false, enumerated_risk: false, damages_claim: false, confidence: 0.7 }).classification, "attorney_confirmation_required", "confidence < 0.8 alone");
  assert.equal(classify({ damages_against_fnma: false, attacks_validity_priority_enforceability: false, enumerated_risk: false, damages_claim: false, confidence: 0.9 }).classification, "routine");

  // On the bus: "routine" is not accepted from the model — the matter waits for the attorney (escalation), no hold, and
  // the conservative Form 20 clock runs (rule 1: when in doubt, file); only the attorney's routine confirmation ends it.
  const h = harness("2026-09-10T15:00:00.000Z");
  const c = await h.run<Intake>("litigation.classify", { served_on: "2026-09-10", damages_claim: true, confidence: 0.7 });
  assert.equal(c.classification, "attorney_confirmation_required"); assert.equal(c.category, null); assert.equal(c.hold, null); assert.equal(c.hold_id, null);
  assert.match(String(h.emitted("escalation.created").find((e) => e.payload.kind === "attorney")!.payload.reason), /confirmation required before "routine" is accepted \(confidence 0\.7, damages claim present\)/);
  const clock = h.last("FNMA_E1302_FORM20_2BD"); assert.equal(clock.dueDate, "2026-09-14"); assert.equal(h.inst("LITIGATION_HOLD").length, 0);
  await assert.rejects(h.run("litigation.classify", { op: "confirm", classification: "routine" }, AGENT), refused("ROUTINE_NEEDS_ATTORNEY_CONFIRMATION"));
  await assert.rejects(h.run("litigation.classify", { op: "confirm", classification: "routine" }, OFFICER), refused("ROUTINE_NEEDS_ATTORNEY_CONFIRMATION"));
  assert.equal(clock.status, "armed");
  const ok = await h.run<{ classification: string; form20_required: boolean; confirmed_by_role: string; cancelled_timer_ids: string[] }>("litigation.classify", { op: "confirm", classification: "routine" }, ATTORNEY, "2026-09-11T15:00:00.000Z");
  assert.equal(ok.classification, "routine"); assert.equal(ok.form20_required, false); assert.equal(ok.confirmed_by_role, "attorney"); assert.deepEqual(ok.cancelled_timer_ids, [clock.id]); assert.equal(clock.status, "cancelled");
  assert.equal(h.emitted("litigation.classification.confirmed")[0]!.payload.classification, "routine");
  // the attorney confirming non-routine instead keeps the clock and its due date
  const n = harness("2026-09-10T15:00:00.000Z", "L-137-nr");
  await n.run("litigation.classify", { served_on: "2026-09-10", damages_claim: true, confidence: 0.7 });
  const nr = await n.run<{ classification: string; category: number; form20_due_at: string; cancelled_timer_ids: string[] }>("litigation.classify", { op: "confirm", classification: "non_routine", category: 1 }, ATTORNEY, "2026-09-11T15:00:00.000Z");
  assert.equal(nr.classification, "non_routine"); assert.equal(nr.category, 1); assert.equal(nr.form20_due_at, "2026-09-14"); assert.deepEqual(nr.cancelled_timer_ids, []); assert.equal(n.last("FNMA_E1302_FORM20_2BD").status, "armed");
});
