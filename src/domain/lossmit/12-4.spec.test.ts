// 12.4 Forbearance plan
// spec/sections/12-loss-mitigation/12-4-forbearance-plan.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { preExpiryOutreach, postForbearanceDisposition, disasterForbearanceOffer, reducedPaymentMiss, referralGate, planCaseRouting, forbearanceActivation, forbearanceBasisGate } from "./ops.ts";
import { forbearanceTerm, forbearanceTermDates, regxShortTermForbearance, preExpiryOutreachStart } from "./plans.ts";
import { mbsMonthsToMaturity, termComputation, preExpiryPrescreen, liftLateChargeSuppression } from "./ops-12-4.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, type TimerInstance } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput, type ToolDef } from "../../app/tools.ts";
import { SECTION_12_TOOLS } from "../../app/tools/section12.ts";
import { TOOLS_12_4 } from "../../app/tools/section12-4.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeFnmaSmdu } from "../../infra/integrations/fnma.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";

// ---- the §12.4 tools on the command bus with a TimerEngine over the overridden registry: every 12.4 timer is armed by the event a tool appends and satisfied by the event the responding tool (or the inbound ingestion) appends.
const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const LOAN = "L-124";
const RECIPIENTS = [{ partyId: "b1", name: "Borrower", mailingAddress: "1 Test St, Testville TX 75001" }];
const toolKey = (process: string, name: string): string => `${process} ${name}`;
function harness(nowIso = "2026-09-15T14:00:00.000Z") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  // COMBINED_36M is registered under 12.5 and the (c)(2)(iii) terms-notice row under 12.1 (shared rows); both arm on 12.4's events.
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["12.1", "12.4", "12.5"] });
  const uow: UowContext = { loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const noticeReg = buildRegistry(); publishAuthored(noticeReg);
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }), ports: { smdu: new FakeFnmaSmdu(), printMail: new FakePrintMail(), edelivery: new FakeEdelivery() } };
  const agents = new AgentRegistry(); const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of [...SECTION_12_TOOLS, ...TOOLS_12_4] as readonly ToolDef[]) if (d.process === "12.4") { const c = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, c.name); cmds.set(toolKey(d.process, d.name), c); }
  const bus = new CommandBus(agents);
  const run = async <O = Record<string, unknown>>(name: string, input: ToolInput, opts: { actor?: Actor; now?: string } = {}): Promise<O> => { if (opts.now) clock.set(opts.now); return (await bus.execute(cmds.get(toolKey("12.4", name))!, opts.actor ?? AGENT, { loan_id: LOAN, ...input }, uow)).output as O; };
  const refused = (name: string, input: ToolInput, code: string, actor: Actor = AGENT) => assert.rejects(bus.execute(cmds.get(toolKey("12.4", name))!, actor, { loan_id: LOAN, ...input }, uow), (e: unknown) => e instanceof CommandRefused && e.code === code);
  const rejects = (name: string, input: ToolInput, re: RegExp, opts: { actor?: Actor; now?: string } = {}) => { if (opts.now) clock.set(opts.now); return assert.rejects(bus.execute(cmds.get(toolKey("12.4", name))!, opts.actor ?? AGENT, { loan_id: LOAN, ...input }, uow), (e: unknown) => e instanceof RangeError && re.test(e.message)); };
  const emitted = (type: string): readonly DomainEvent[] => events.all().filter((e) => e.type === type);
  const armed = (code: string, due?: string): TimerInstance => { const t = timers.byCode(code).at(-1); assert.ok(t, `${code} armed`); assert.equal(t.status, "armed", `${code} status`); if (due !== undefined) assert.equal(t.dueDate, due, `${code} due`); return t; };
  const satisfied = (code: string, byType: string, status: "satisfied" | "satisfied_late" = "satisfied"): TimerInstance => { const t = timers.byCode(code).find((x) => x.status === status); assert.ok(t, `${code} ${status}`); assert.equal(events.all().find((e) => e.id === t.satisfiedByEventId)!.type, byType, `${code} satisfied by ${byType}`); return t; };
  const notice = (code: string, extra: ToolInput = {}) => run("notice.render_send", { template_code: code, recipients: RECIPIENTS, payload: noticeReg.activeVersion(code, D(clock.now().slice(0, 10)))!.samplePayload, ...extra });
  return { clock, events, timers, rt, run, refused, rejects, emitted, armed, satisfied, notice, decisions, noticeReg };
}
type H = ReturnType<typeof harness>;
/** T1's plan: QRPC 2026-09-15 (2 months delinquent), offered the same day, term 1 = 2026-10-01..2026-12-31 through the 12.4 term op. */
async function offerAndActivate(h: H, extra: ToolInput = {}) {
  await h.run("workout_plan.*", { op: "offer", id: "wp-1", offered_on: "2026-09-15", requested_months: 3, regx_short_term: true, application_complete: false });
  return h.run("workout_plan.*", { op: "term", id: "wp-1", requested_months: 3, cumulative_months: 0, months_delinquent_at_start: 2, start_on: "2026-10-01", initial_start_date: "2026-10-01", ...extra }, { now: "2026-09-16T14:00:00.000Z" });
}
/** The "3+3+3" extensions of rule 2 on top of T1's term 1. */
async function extendTwice(h: H) {
  const t2 = await h.run("workout_plan.*", { op: "term", id: "wp-1", term_months: 3, cumulative_months: 3, months_delinquent_at_start: 5, start_on: "2027-01-01" }, { now: "2026-12-15T14:00:00.000Z" });
  const t3 = await h.run("workout_plan.*", { op: "term", id: "wp-1", term_months: 3, cumulative_months: 6, months_delinquent_at_start: 8, start_on: "2027-04-01", regx_basis: "c2ii_discretionary" }, { now: "2027-03-15T14:00:00.000Z" });
  return { t2, t3 };
}
const payload = (e: DomainEvent | undefined): Record<string, unknown> => { assert.ok(e); return e.payload as Record<string, unknown>; };

test("12.4-T1: Given QRPC on 2026-09-15 (temporary, unresolved hardship; 2 months delinquent), when a plan is offered, then term 1 = 2026-10-01..2026-12-31, Evaluation Notice within 5 days, status 09 reported at BD2 of November, late charges suppressed.", async () => {
  const t1 = forbearanceTerm({ requested_months: 3, cumulative_months: 0, months_delinquent_at_start: 2 }); assert.equal(t1.months, 3); assert.equal(t1.exception_required, false);
  assert.deepEqual(forbearanceTermDates(D("2026-10-01"), 3), { start: "2026-10-01", end: "2026-12-31" });
  const a = forbearanceActivation({ offered_on: D("2026-09-15"), term_start: D("2026-10-01"), term_end: D("2026-12-31") });
  assert.equal(a.evaluation_notice, "NTC_FNMA_D23201_FORB_PLAN"); assert.equal(a.evaluation_notice_by, "2026-09-20"); assert.equal(a.status_code, "09"); assert.equal(a.status_report_by, "2026-11-03"); assert.equal(a.late_charges_suppressed, true);
  assert.deepEqual(a.preexpiry_outreach, { timer: "FNMA_D23201_FORB_PREEXPIRY_CONTACT_30", anchor: "2026-12-31", begin_by: "2026-12-01" }); assert.deepEqual(a.holds.map((h) => [h.kind, h.from, h.to]), [["fnma_plan_performing", "2026-10-01", "2026-12-31"]]);
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_FNMA_D23201_FORB_PLAN", D("2026-09-20"))!; const out = render(v.source, v.samplePayload);
  assert.equal(evaluateChecklist(v, v.samplePayload, out).passed, true); assert.match(out.text, /will not be current when the plan ends/); assert.match(out.text, /No late charges will be assessed/);
  // On the bus: the offer arms the D2-2-05 clock (5 calendar days from the offer date) and, on an incomplete application, the (c)(2)(iii) terms-notice clock (5 federal business days: 2026-09-22); term 1 emits the gate trigger and the activation.
  const h = harness(); const rec = await offerAndActivate(h);
  h.armed("FNMA_D2205_EVAL_NOTICE_FORB", "2026-09-20"); h.armed("REGX_1024_41C2III_SHORTTERM_NOTICE_5", "2026-09-22");
  assert.equal(rec.term_start, "2026-10-01"); assert.equal(rec.term_end, "2026-12-31"); assert.equal(rec.status, "active"); assert.equal(rec.late_charges_suppressed, true); assert.equal(rec.regx_short_term, true);
  const tc = payload(h.emitted("workout_plan.term.create")[0]); assert.equal(tc.term_months, 3); assert.equal(tc.projected_months_delinquent_at_term_end, 5); assert.equal(tc.forbearance_component, true); assert.equal(tc.combined_months, 3);
  for (const code of ["FNMA_D23201_FORB_INCREMENT_MAX_3M", "FNMA_LL202601_FORB_CUMULATIVE_12M", "FNMA_LL202601_FORB_DELQ_12M", "FNMA_D23201_FORB_COMBINED_36M"]) assert.match(h.armed(code).note ?? "", /^evaluator:/, `${code} is an evaluator gate armed by workout_plan.term.create`);
  assert.deepEqual(rec.gates, { "12.4.incrementMax3Months": { open: true }, "12.4.cumulativeMax12Months": { open: true }, "12.4.projectedDelinquencyMax12Months": { open: true }, "12.5.combinedMax36Months": { open: true } });
  h.armed("FNMA_D23201_FORB_PREEXPIRY_CONTACT_30", "2026-12-01"); h.armed("FNMA_D23201_FORB_EXPIRY_DISPOSITION", "2026-12-31"); h.armed("REGX_1024_41C2III_PERFORMANCE_HOLD");
  // Evaluation Notice with the plan terms, sent 2026-09-18: satisfies both notice clocks (dual-cited template).
  await h.notice("NTC_FNMA_D23201_FORB_PLAN", { as_of: "2026-09-18" });
  h.satisfied("FNMA_D2205_EVAL_NOTICE_FORB", "notice.sent"); h.satisfied("REGX_1024_41C2III_SHORTTERM_NOTICE_5", "notice.sent");
  // Late charges suppressed for the plan (fees engine flag; rule 3).
  const sup = await h.run("fees.suppress", { id: "sup-1", from: "2026-10-01", case_id: "case-forb-1" }); assert.equal(sup.kind, "late_charge"); assert.equal(sup.from, "2026-10-01"); assert.equal(sup.status, "active"); assert.equal(h.emitted("fees.late_charge.suppressed").length, 1);
  // October month-end with an active plan → status 09 due at BD2 of November (2026-11-03, F-1-21); reported in the legacy file; the 5.x acknowledgement satisfies the clock.
  const me = await h.run<{ plan_id: string; period: string; status_code: string; report_by: string; event_type: string }[]>("workout_plan.*", { op: "month_end", period_end: "2026-10-31" }, { now: "2026-10-31T23:00:00.000Z" });
  assert.deepEqual(me.map((r) => [r.plan_id, r.period, r.status_code, r.report_by, r.event_type]), [["wp-1", "2026-10", "09", "2026-11-03", "workout_plan.month_end"]]);
  h.armed("FNMA_F121_STATUS_09_BD2", "2026-11-03");
  const rep = await h.run("fnma.status_code.report", { status_code: "09", reason_code: "016", reporting_month: "2026-10", plan_id: "wp-1" }, { now: "2026-11-02T15:00:00.000Z" }); assert.equal(rep.type, "investor.status_code.reported");
  await h.run("fnma.status_code.report", { op: "ack", period: "2026-10", status_code: "09", accepted: true, ack_id: "ack-1", source: "lsdu", accepted_on: "2026-11-02" });
  h.satisfied("FNMA_F121_STATUS_09_BD2", "investor.event.accepted");
  await h.rejects("fnma.status_code.report", { op: "ack", period: "2026-10", status_code: "9", accepted: true, ack_id: "ack-2", source: "lsdu", accepted_on: "2026-11-02" }, /two-digit/);
});
test("12.4-T2: (3+3+3 caps) extensions to 2027-03-31 and 2027-06-30 succeed; a 3-month fourth extension is refused (14 months delinquent); a 1-month extension to 2027-07-31 succeeds; a 2-month request generates an exception package.", async () => {
  const t2 = forbearanceTerm({ requested_months: 3, cumulative_months: 3, months_delinquent_at_start: 5 }); assert.equal(t2.months, 3); assert.deepEqual(forbearanceTermDates(D("2027-01-01"), 3), { start: "2027-01-01", end: "2027-03-31" });
  const t3 = forbearanceTerm({ requested_months: 3, cumulative_months: 6, months_delinquent_at_start: 8 }); assert.equal(t3.months, 3); assert.deepEqual(forbearanceTermDates(D("2027-04-01"), 3), { start: "2027-04-01", end: "2027-06-30" });
  const t4 = forbearanceTerm({ requested_months: 3, cumulative_months: 9, months_delinquent_at_start: 11 }); assert.equal(t4.months, 1); assert.ok(t4.capped_by.includes("delinquency_12")); assert.equal(t4.exception_required, true);
  assert.deepEqual(forbearanceTermDates(D("2027-07-01"), 1), { start: "2027-07-01", end: "2027-07-31" });
  assert.equal(forbearanceTerm({ requested_months: 1, cumulative_months: 9, months_delinquent_at_start: 11 }).exception_required, false);
  assert.equal(forbearanceTerm({ requested_months: 2, cumulative_months: 9, months_delinquent_at_start: 11 }).exception_required, true);
  // Worked example: payments due 2026-08-01 and 2026-09-01 unpaid; term 1 Oct–Dec 2026 (T1); the extensions run through the term op and its gates.
  const h = harness(); await offerAndActivate(h); const { t2: e2, t3: e3 } = await extendTwice(h);
  assert.equal(e2.term_end, "2027-03-31"); assert.equal((e2.term as { term_no: number }).term_no, 2); assert.equal(e2.cumulative_months, 6);
  assert.equal(e3.term_end, "2027-06-30"); assert.equal(e3.cumulative_months, 9); assert.equal(e3.projected_delinquency_at_end, 11, "Aug 2026 … Jun 2027 = 11 months (fnma_delinquency_status)");
  assert.equal(h.emitted("workout_plan.term.create").length, 3); assert.equal(h.timers.byCode("FNMA_LL202601_FORB_DELQ_12M").length, 3, "each term creation arms the delinquency gate");
  // A 3-month fourth extension would reach cumulative 12 (allowed) but 14 months delinquent → the command is refused (FNMA_LL202601_FORB_DELQ_12M); the engine offers 1 month.
  await h.rejects("workout_plan.*", { op: "term", id: "wp-1", term_months: 3, cumulative_months: 9, months_delinquent_at_start: 11, start_on: "2027-07-01", regx_basis: "c2ii_discretionary" }, /FNMA_LL202601_FORB_DELQ_12M.*14 at term end.*Forbearance Exception Request Template/, { now: "2027-06-15T14:00:00.000Z" });
  assert.equal(evaluateGate("12.4.projectedDelinquencyMax12Months", { projected_months_delinquent_at_term_end: 14 }).open, false); assert.equal(evaluateGate("12.4.cumulativeMax12Months", { cumulative_months: 9, term_months: 3 }).open, true);
  assert.equal(h.emitted("workout_plan.term.create").length, 3, "a refused term emits nothing"); assert.equal(h.rt.store.get("workout_plans", "wp-1")!.data.term_end, "2027-06-30");
  const e4 = await h.run("workout_plan.*", { op: "term", id: "wp-1", term_months: 1, cumulative_months: 9, months_delinquent_at_start: 11, start_on: "2027-07-01", regx_basis: "c2ii_discretionary" });
  assert.equal(e4.term_start, "2027-07-01"); assert.equal(e4.term_end, "2027-07-31"); assert.equal(e4.cumulative_months, 10); assert.equal(e4.projected_delinquency_at_end, 12); assert.equal((e4.term as { term_no: number }).term_no, 4);
  assert.deepEqual((e4.computation as { chosen: number; capped_by: string[] }).capped_by, ["delinquency_12"]);
  // A 2-month request beyond the caps → the Forbearance Exception Request package (loan data, hardship, delinquency projection, prior terms, recommendation) for officer / fnma_portal_operator.
  await h.rejects("exception_request.prepare", { id: "exc-1", basis: "delinquency_12", plan_id: "wp-1", requested_months: 1, cumulative_months: 9, months_delinquent_at_start: 11, start_on: "2027-07-01" }, /within the caps.*no Forbearance Exception Request/);
  const pkg = await h.run<{ id: string; status: string; package: { computation: { requested: number; chosen: number; capped_by: string[]; exception_required: boolean }; delinquency_projection: Record<string, number>; prior_terms: { term_no: number }[] }; escalation_owner_role: string }>("exception_request.prepare", { id: "exc-1", basis: "delinquency_12", hardship: "unemployment (Form 710 hardship 003)", plan_id: "wp-1", requested_months: 2, cumulative_months: 10, months_delinquent_at_start: 12, start_on: "2027-08-01", submit_via: "fnma_portal_operator" }, { now: "2027-07-02T14:00:00.000Z" });
  assert.equal(pkg.status, "prepared"); assert.deepEqual(pkg.package.computation, { requested: 2, cap_increment: 3, cap_cumulative: 2, cap_delinquency: 0, mbs_cap: null, cap_combined: 26, chosen: 0, capped_by: ["delinquency_12"], exception_required: true });
  assert.deepEqual(pkg.package.delinquency_projection, { months_delinquent_at_start: 12, at_requested_term_end: 14, cap: 12 }); assert.deepEqual(pkg.package.prior_terms.map((t) => t.term_no), [1, 2, 3, 4]); assert.equal(pkg.escalation_owner_role, "fnma_portal_operator");
  // Submission is a human act (officer / fnma_portal_operator): `fnma_exception_request.submitted` arms the 10-business-day follow-up (2027-07-06 → 2027-07-20, fannie_et; 2027-07-05 observed holiday precedes it); Fannie Mae's written decision satisfies it and lifts the cap for the approved months only.
  await h.refused("exception_request.prepare", { op: "submit", id: "exc-1", channel: "email", package_document_id: "doc-exc-1", submitted_on: "2027-07-06" }, "EXCEPTION_SUBMIT_AUTHORITY");
  const sub = await h.run("exception_request.prepare", { op: "submit", id: "exc-1", channel: "email", package_document_id: "doc-exc-1", submitted_on: "2027-07-06" }, { actor: OFFICER, now: "2027-07-06T15:00:00.000Z" });
  assert.equal(sub.status, "submitted"); assert.equal(sub.follow_up_by, "2027-07-20"); h.armed("FNMA_LL202601_FORB_EXCEPTION_RESPONSE", "2027-07-20");
  await h.rejects("exception_request.prepare", { op: "decide", id: "exc-1", decision: "approved", decided_on: "2027-07-14" }, /evidence_document_id/, { actor: OFFICER });
  const dec = await h.run("exception_request.prepare", { op: "decide", id: "exc-1", decision: "approved", decided_on: "2027-07-14", evidence_document_id: "doc-fnma-approval-1", approved_months: 2 }, { actor: OFFICER, now: "2027-07-14T15:00:00.000Z" });
  assert.equal(dec.decision, "approved"); h.satisfied("FNMA_LL202601_FORB_EXCEPTION_RESPONSE", "fnma_exception_request.decided");
  const e5 = await h.run("workout_plan.*", { op: "term", id: "wp-1", term_months: 2, cumulative_months: 10, months_delinquent_at_start: 12, start_on: "2027-08-01", regx_basis: "c2ii_discretionary", exception_request_id: "exc-1" }, { now: "2027-07-20T14:00:00.000Z" });
  assert.equal(e5.term_end, "2027-09-30"); assert.deepEqual(e5.term, { term_no: 5, months: 2, term_start: "2027-08-01", term_end: "2027-09-30", approved_by: "fnma_exception" }); assert.equal(e5.exception_request_id, "exc-1");
  assert.equal(payload(h.emitted("workout_plan.term.create").at(-1)).approved_by, "fnma_exception");
});
test("12.4-T3: (short-term boundary) term 3 flagged `regx_short_term=false`; the engine requires a recorded basis (complete application / (c)(2)(ii) / servicer-initiated) before activation.", async () => {
  assert.equal(regxShortTermForbearance(6), true); assert.equal(regxShortTermForbearance(9), false);
  const term2 = forbearanceBasisGate({ forborne_months_before: 3, term_months: 3 }); assert.equal(term2.regx_short_term, true); assert.equal(term2.allowed, true);
  const refused = forbearanceBasisGate({ forborne_months_before: 6, term_months: 3 });
  assert.equal(refused.regx_short_term, false); assert.equal(refused.forborne_months_after, 9); assert.equal(refused.basis_required, true); assert.equal(refused.allowed, false); assert.match(refused.refusal!, /record regx_basis/);
  for (const b of ["complete_application", "c2ii_discretionary", "servicer_initiated"] as const) assert.equal(forbearanceBasisGate({ forborne_months_before: 6, term_months: 3, regx_basis: b }).allowed, true);
  // On the bus: forborne payments after term 2 = 6 (the boundary); term 3 forbears months 7–9 → not short-term → activation refused until a basis is recorded, then recorded on the term and its events.
  const h = harness(); await offerAndActivate(h);
  const e2 = await h.run("workout_plan.*", { op: "term", id: "wp-1", term_months: 3, cumulative_months: 3, months_delinquent_at_start: 5, start_on: "2027-01-01" }, { now: "2026-12-15T14:00:00.000Z" });
  assert.equal(e2.regx_short_term, true); assert.equal(e2.regx_basis, null);
  await h.rejects("workout_plan.*", { op: "term", id: "wp-1", term_months: 3, cumulative_months: 6, months_delinquent_at_start: 8, start_on: "2027-04-01" }, /9 forborne payments exceed the §1024\.41\(c\)\(2\)\(iii\) short-term boundary \(6\) — record regx_basis/, { now: "2027-03-15T14:00:00.000Z" });
  assert.equal(h.emitted("workout_plan.activated").length, 2, "no activation without the basis"); assert.equal(h.rt.store.get("workout_plans", "wp-1")!.data.term_end, "2027-03-31");
  for (const [b, start] of [["complete_application", "2027-04-01"], ["c2ii_discretionary", "2027-04-01"], ["servicer_initiated", "2027-04-01"]] as const) {
    const g = harness(); await offerAndActivate(g); await g.run("workout_plan.*", { op: "term", id: "wp-1", term_months: 3, cumulative_months: 3, months_delinquent_at_start: 5, start_on: "2027-01-01" }, { now: "2026-12-15T14:00:00.000Z" });
    const e3 = await g.run("workout_plan.*", { op: "term", id: "wp-1", term_months: 3, cumulative_months: 6, months_delinquent_at_start: 8, start_on: start, regx_basis: b }, { now: "2027-03-15T14:00:00.000Z" });
    assert.equal(e3.regx_short_term, false); assert.equal(e3.regx_basis, b); assert.equal(e3.term_end, "2027-06-30");
    assert.equal(g.rt.store.get("workout_plan_terms", "wp-1-t3")!.data.regx_basis, b); assert.equal(payload(g.emitted("workout_plan.activated").at(-1)).regx_basis, b); assert.equal(payload(g.emitted("workout_plan.term.create").at(-1)).regx_short_term, false);
  }
});
test("12.4-T4: (pre-expiry) outreach begins by 2026-12-01 for a 2026-12-31 term end and continues at least every 3 days; QRPC on 2026-12-10 → hierarchy pre-screen executed the same day.", async () => {
  const r = preExpiryOutreach({ term_end: D("2026-12-31"), attempts: [D("2026-12-01"), D("2026-12-04"), D("2026-12-07"), D("2026-12-10")], qrpc_on: D("2026-12-10") });
  assert.equal(r.begin_by, "2026-12-01"); assert.equal(r.began_on_time, true); assert.equal(r.cadence_ok, true); assert.equal(r.max_gap_days, 3); assert.equal(r.prescreen_on, "2026-12-10");
  assert.equal(preExpiryOutreach({ term_end: D("2026-12-31"), attempts: [D("2026-12-01"), D("2026-12-06")] }).cadence_ok, false);
  // On the bus: the −30-day clock is armed at term creation (due 2026-12-01); the expiry sweep on 2026-12-01 flags the plan and arms the 3-day cadence; each contact attempt with purpose=forb_preexpiry re-arms it; QRPC on 2026-12-10 ends the cadence and runs the rule 4 pre-screen the same day.
  const h = harness(); await offerAndActivate(h); h.armed("FNMA_D23201_FORB_PREEXPIRY_CONTACT_30", "2026-12-01");
  assert.deepEqual(await h.run("workout_plan.*", { op: "expiry_sweep", as_of: "2026-11-30" }, { now: "2026-11-30T14:00:00.000Z" }), [], "nothing before day −30");
  const flagged = await h.run<Record<string, unknown>[]>("workout_plan.*", { op: "expiry_sweep", as_of: "2026-12-01" }, { now: "2026-12-01T14:00:00.000Z" });
  assert.deepEqual(flagged, [{ plan_id: "wp-1", term_end: "2026-12-31", days_before: 30, begin_by: "2026-12-01", cadence_days: 3, as_of: "2026-12-01", purpose: "forb_preexpiry" }]);
  assert.deepEqual(await h.run("workout_plan.*", { op: "expiry_sweep", as_of: "2026-12-02" }, { now: "2026-12-02T14:00:00.000Z" }), [], "flagged once per term");
  h.armed("FNMA_D23201_FORB_PREEXPIRY_CADENCE", "2026-12-04");
  const attempts = ["2026-12-01", "2026-12-04", "2026-12-07"];
  for (const d of attempts) await h.run("contacts.*", { id: `ct-${d}`, mode: "phone", purpose: "forb_preexpiry", result: "no_answer" }, { now: `${d}T16:00:00.000Z` });
  h.satisfied("FNMA_D23201_FORB_PREEXPIRY_CONTACT_30", "contact.attempted"); assert.equal(h.emitted("contact.attempted").length, 3);
  assert.equal(preExpiryOutreach({ term_end: D("2026-12-31"), attempts: h.emitted("contact.attempted").map((e) => D(String(e.payload.attempted_on))) }).began_on_time, true);
  const qrpc = await h.run<{ qrpc_achieved: boolean; prescreen: { result: string; next_process: string; on: string; extension_months: number | null } }>("contacts.*", { id: "ct-2026-12-10", mode: "phone", purpose: "forb_preexpiry", result: "qrpc", qrpc_achieved: true, hardship_resolved: false, intent: "retain", brp_needed: true, months_delinquent: 5, cumulative_months: 3, months_delinquent_at_next_start: 5, start_on: "2027-01-01" }, { now: "2026-12-10T16:00:00.000Z" });
  assert.equal(qrpc.qrpc_achieved, true); assert.deepEqual([qrpc.prescreen.result, qrpc.prescreen.next_process, qrpc.prescreen.on, qrpc.prescreen.extension_months], ["extension", "12.4", "2026-12-10", 3]);
  h.satisfied("FNMA_D23201_FORB_PREEXPIRY_CADENCE", "contact.qrpc.established");
  const pre = payload(h.emitted("workout_plan.prescreen.completed")[0]); assert.equal(pre.on, "2026-12-10"); assert.equal(pre.qrpc_contact_id, "ct-2026-12-10"); assert.equal(payload(h.emitted("contact.qrpc.established")[0]).achieved_on, "2026-12-10");
  // Rule 4 branches: resolved + reinstate → reinstatement; resolved + affordable → repayment (12.5); resolved, 4 months delinquent → deferral (12.6); resolved, 8 months → Flex Mod (12.8); unresolved at the cap → exception template.
  assert.equal(preExpiryPrescreen({ hardship_resolved: true, can_reinstate: true, months_delinquent: 5, cumulative_months: 3, months_delinquent_at_next_start: 5 }).result, "reinstatement");
  assert.equal(preExpiryPrescreen({ hardship_resolved: true, can_afford_repayment: true, months_delinquent: 5, cumulative_months: 3, months_delinquent_at_next_start: 5 }).next_process, "12.5");
  assert.equal(preExpiryPrescreen({ hardship_resolved: true, months_delinquent: 4, cumulative_months: 3, months_delinquent_at_next_start: 4 }).result, "payment_deferral");
  assert.equal(preExpiryPrescreen({ hardship_resolved: true, months_delinquent: 8, cumulative_months: 6, months_delinquent_at_next_start: 8 }).result, "flex_mod");
  assert.equal(preExpiryPrescreen({ hardship_resolved: false, months_delinquent: 12, cumulative_months: 10, months_delinquent_at_next_start: 12 }).result, "exception_required");
});
test("12.4-T5: (no QRPC at expiry) deferral-eligible (4 months delinquent) → post-forbearance deferral solicitation by 2027-01-15; if deferral-ineligible → Flex Mod solicitation by 2027-01-15.", async () => {
  const a = postForbearanceDisposition({ term_end: D("2026-12-31"), qrpc: false, months_delinquent: 4, deferral_eligible: true });
  assert.deepEqual(a, { solicitation: "payment_deferral", notice: "NTC_FNMA_D23204_SOLICIT_POST_FORB", by: "2027-01-15" });
  const b = postForbearanceDisposition({ term_end: D("2026-12-31"), qrpc: false, months_delinquent: 4, deferral_eligible: false });
  assert.deepEqual(b, { solicitation: "flex_mod", notice: "NTC_FNMA_D23206_SOLICIT_STREAMLINED", by: "2027-01-15" });
  // On the bus: expiry without QRPC arms the 15-day solicitation from term_end; the solicitation notice satisfies it; the expiry releases the performance hold; closing the plan into the deferral satisfies the disposition clock.
  const h = harness(); await offerAndActivate(h);
  await h.run("workout_plan.*", { op: "expire", id: "wp-1", qrpc: false, deferral_eligible: true }, { now: "2027-01-01T14:00:00.000Z" });
  h.armed("FNMA_D23204_POSTFORB_DEFERRAL_SOLICIT_15", "2027-01-15"); assert.equal(h.timers.byCode("FNMA_D23206_POSTFORB_FLEX_SOLICIT_15").length, 0); h.satisfied("REGX_1024_41C2III_PERFORMANCE_HOLD", "workout_plan.ended");
  await h.notice("NTC_FNMA_D23204_SOLICIT_POST_FORB", { option: "payment_deferral", as_of: "2027-01-08" }); h.satisfied("FNMA_D23204_POSTFORB_DEFERRAL_SOLICIT_15", "notice.sent");
  await h.run("workout_plan.*", { op: "close", id: "wp-1", closed_reason: "converted_deferral" }); h.satisfied("FNMA_D23201_FORB_EXPIRY_DISPOSITION", "workout_plan.closed");
  const g = harness(); await offerAndActivate(g);
  await g.run("workout_plan.*", { op: "expire", id: "wp-1", qrpc: false, deferral_eligible: false, flex_eligible: true }, { now: "2027-01-01T14:00:00.000Z" });
  g.armed("FNMA_D23206_POSTFORB_FLEX_SOLICIT_15", "2027-01-15"); assert.equal(g.timers.byCode("FNMA_D23204_POSTFORB_DEFERRAL_SOLICIT_15").length, 0);
  await g.notice("NTC_FNMA_D23206_SOLICIT_STREAMLINED", { option: "flex_modification", as_of: "2027-01-08" }); g.satisfied("FNMA_D23206_POSTFORB_FLEX_SOLICIT_15", "notice.sent");
});
test("12.4-T6: (disaster) FEMA IA area, current at disaster, 1 month delinquent → 3-month plan without QRPC; QRPC attempts logged every ≤7 days.", async () => {
  const r = disasterForbearanceOffer({ fema_ia: true, current_at_disaster: true, months_delinquent: 1, attempts: [D("2026-10-01"), D("2026-10-08"), D("2026-10-15")] });
  assert.equal(r.months, 3); assert.equal(r.qrpc_required, false); assert.equal(r.attempt_cadence_ok, true); assert.equal(r.max_gap_days, 7);
  assert.match(disasterForbearanceOffer({ fema_ia: false, current_at_disaster: true, months_delinquent: 1, attempts: [] }).refusal!, /FEMA/);
  // On the bus: the disaster plan activates without a QRPC contact; the attempts during the term are logged through `contacts.*` (D2-2-02 every ≤7 days) and the expiry carries `disaster=true`.
  const h = harness("2026-09-25T14:00:00.000Z");
  await h.run("workout_plan.*", { op: "offer", id: "wp-d", offered_on: "2026-09-25", requested_months: 3, regx_short_term: true, application_complete: false, disaster: true });
  const rec = await h.run("workout_plan.*", { op: "term", id: "wp-d", requested_months: 3, cumulative_months: 0, months_delinquent_at_start: 1, start_on: "2026-10-01", disaster: true });
  assert.equal(rec.term_end, "2026-12-31"); assert.equal(rec.disaster, true); assert.equal(payload(h.emitted("workout_plan.activated")[0]).disaster, true);
  for (const d of ["2026-10-01", "2026-10-08", "2026-10-15"]) await h.run("contacts.*", { id: `ct-${d}`, mode: "phone", purpose: "disaster_qrpc", result: "no_answer" }, { now: `${d}T16:00:00.000Z` });
  assert.equal(disasterForbearanceOffer({ fema_ia: true, current_at_disaster: true, months_delinquent: 1, attempts: h.emitted("contact.attempted").map((e) => D(String(e.payload.attempted_on))) }).attempt_cadence_ok, true);
  await h.run("workout_plan.*", { op: "expire", id: "wp-d", qrpc: false, deferral_eligible: true }, { now: "2027-01-01T14:00:00.000Z" }); assert.equal(payload(h.emitted("workout_plan.ended")[0]).disaster, true);
});
test("12.4-T7: (reduced payment miss) reduced payment not received by month-end → mitigating-circumstances check; termination notice; late charges from the default date only.", async () => {
  const r = reducedPaymentMiss({ due_on: D("2026-11-01"), received_cents: 0n, reduced_payment_cents: 100_000n, mitigating_circumstances: false, plan_start: D("2026-10-01") });
  assert.equal(r.missed, true); assert.equal(r.mitigating_check, "performed"); assert.equal(r.terminated, true); assert.equal(r.termination_notice, "NTC_FNMA_D23201_FORB_TERMINATION"); assert.equal(r.late_charges_from, "2026-12-01"); assert.equal(r.late_charges_before_default, 0n);
  assert.equal(reducedPaymentMiss({ due_on: D("2026-11-01"), received_cents: 0n, reduced_payment_cents: 100_000n, mitigating_circumstances: true, plan_start: D("2026-10-01") }).terminated, false);
  assert.deepEqual(liftLateChargeSuppression({ suppressed_from: D("2026-10-01"), late_charges_from: D("2026-12-01") }), { suppressed_from: "2026-10-01", suppressed_to: "2026-11-30", late_charges_from: "2026-12-01", retroactive_assessment: false });
  // On the bus: a reduced-payment plan ($1,000.00/month) schedules three rows; each arms the month-end clock (last calendar day of the month); October's receipt satisfies it; November's miss → mitigating-circumstances check → `workout_plan.payment.missed` (diligence resumes the same day) → termination, notice, suppression lifted from 2026-12-01.
  const h = harness(); await offerAndActivate(h, { payment_mode: "reduced", reduced_amount_cents: 100_000n });
  await h.run("fees.suppress", { id: "sup-1", from: "2026-10-01" });
  const sched = await h.run<{ rows: { due_date: string; expected_amount_cents: string; status: string }[] }>("workout_plan.*", { op: "schedule", id: "wp-1" });
  assert.deepEqual(sched.rows.map((x) => [x.due_date, x.expected_amount_cents, x.status]), [["2026-10-01", "100000", "due"], ["2026-11-01", "100000", "due"], ["2026-12-01", "100000", "due"]]);
  assert.deepEqual(h.timers.byCode("FNMA_D23201_FORB_REDUCED_PAYMENT_EOM").map((t) => [t.subject.id, t.anchorDate, t.dueDate, t.status]), [["wp-1:2026-10-01", "2026-10-01", "2026-10-31", "armed"], ["wp-1:2026-11-01", "2026-11-01", "2026-11-30", "armed"], ["wp-1:2026-12-01", "2026-12-01", "2026-12-31", "armed"]]);
  const short = await h.run("workout_plan.*", { op: "payment", id: "wp-1", due_date: "2026-10-01", amount_cents: 60_000n, payment_id: "pay-1" }, { now: "2026-10-12T14:00:00.000Z" }); assert.equal(short.met, false); assert.equal(short.received_amount_cents, "60000");
  const met = await h.run("workout_plan.*", { op: "payment", id: "wp-1", due_date: "2026-10-01", amount_cents: 40_000n, payment_id: "pay-2" }, { now: "2026-10-20T14:00:00.000Z" }); assert.equal(met.met, true); assert.equal(met.status, "met");
  assert.equal(payload(h.emitted("workout_plan_schedule.met")[0]).application, "suspense/unapplied"); assert.deepEqual(h.timers.byCode("FNMA_D23201_FORB_REDUCED_PAYMENT_EOM").map((t) => t.status), ["satisfied", "armed", "armed"], "October's receipt satisfies October's clock only");
  // November: nothing received by 2026-11-30 23:59 → the clock breaches; the month-end check logs the mitigating-circumstances check first.
  h.timers.evaluate("2026-12-01T12:00:00.000Z"); assert.equal(h.timers.byCode("FNMA_D23201_FORB_REDUCED_PAYMENT_EOM")[1]!.status, "breached"); assert.equal(h.timers.byCode("FNMA_D23201_FORB_REDUCED_PAYMENT_EOM")[2]!.status, "armed");
  await h.rejects("workout_plan.*", { op: "month_end_check", id: "wp-1", as_of: "2026-11-30" }, /mitigating_check_id is required/, { now: "2026-12-01T14:00:00.000Z" });
  const excused = await h.run<{ due_date: string; missed: boolean; excused: boolean; termination_review: boolean }[]>("workout_plan.*", { op: "month_end_check", id: "wp-1", as_of: "2026-11-30", mitigating_circumstances: true, mitigating_check_id: "mit-0" });
  assert.deepEqual(excused.map((x) => [x.due_date, x.missed, x.excused, x.termination_review]), [["2026-11-01", true, true, false]]); assert.equal(h.emitted("workout_plan.payment.missed").length, 0, "mitigating circumstances → no termination review");
  const g = harness(); await offerAndActivate(g, { payment_mode: "reduced", reduced_amount_cents: 100_000n }); await g.run("fees.suppress", { id: "sup-1", from: "2026-10-01" }); await g.run("workout_plan.*", { op: "schedule", id: "wp-1" });
  await g.run("workout_plan.*", { op: "payment", id: "wp-1", due_date: "2026-10-01", amount_cents: 100_000n, payment_id: "pay-1" }, { now: "2026-10-20T14:00:00.000Z" });
  const missed = await g.run<{ due_date: string; status: string; missed: boolean; termination_review: boolean; termination_notice: string; late_charges_from: string }[]>("workout_plan.*", { op: "month_end_check", id: "wp-1", as_of: "2026-11-30", mitigating_circumstances: false, mitigating_check_id: "mit-1" }, { now: "2026-12-01T14:00:00.000Z" });
  assert.deepEqual(missed.map((x) => [x.due_date, x.status, x.missed, x.termination_review, x.termination_notice, x.late_charges_from]), [["2026-11-01", "missed", true, true, "NTC_FNMA_D23201_FORB_TERMINATION", "2026-12-01"]]);
  const miss = payload(g.emitted("workout_plan.payment.missed")[0]); assert.equal(miss.mitigating_check, "performed"); assert.equal(miss.mitigating_check_id, "mit-1"); assert.equal(miss.late_charges_from, "2026-12-01"); assert.equal(miss.late_charges_before_default_cents, "0");
  g.armed("REGX_1024_41B1_DILIGENCE_RESUME", "2026-12-01");
  await g.run("contacts.*", { id: "ct-dil", mode: "phone", purpose: "lossmit_diligence", result: "left_message" }, { now: "2026-12-01T18:00:00.000Z" }); g.satisfied("REGX_1024_41B1_DILIGENCE_RESUME", "contact.attempted");
  // Termination for failed terms needs the logged check (guardrail), then the termination notice (reviewer-approved) and late charges from the default date only.
  await g.refused("workout_plan.*", { op: "terminate", id: "wp-1", status: "terminated", terminated_reason: "failed_terms", terminated_on: "2026-12-01" }, "MITIGATING_CHECK_BEFORE_TERMINATION");
  const ended = await g.run("workout_plan.*", { op: "terminate", id: "wp-1", status: "terminated", terminated_reason: "failed_terms", terminated_on: "2026-12-01", mitigating_circumstances_checked: true });
  assert.equal(ended.status, "terminated"); g.satisfied("REGX_1024_41C2III_PERFORMANCE_HOLD", "workout_plan.ended");
  await g.refused("notice.render_send", { template_code: "NTC_FNMA_D23201_FORB_TERMINATION", recipients: RECIPIENTS, payload: g.noticeReg.activeVersion("NTC_FNMA_D23201_FORB_TERMINATION", D("2026-12-01"))!.samplePayload }, "DENIAL_NEEDS_REVIEWER");
  const n = await g.notice("NTC_FNMA_D23201_FORB_TERMINATION", { reviewer_approval_id: "rev-5" }); assert.equal(n.status, "sent"); assert.equal(payload(g.emitted("notice.sent").at(-1)).template, "NTC_FNMA_D23201_FORB_TERMINATION");
  const lifted = await g.run("fees.suppress", { op: "lift", id: "sup-1", late_charges_from: "2026-12-01" }); assert.equal(lifted.to, "2026-11-30"); assert.equal(lifted.late_charges_from, "2026-12-01"); assert.equal(lifted.status, "lifted");
  assert.equal(payload(g.emitted("fees.late_charge.suppression_lifted")[0]).retroactive_assessment, false);
});
test("12.4-T8: (MBS maturity) loan maturing 2027-02-01 → term capped at 2027-01-31.", async () => {
  const t = forbearanceTerm({ requested_months: 3, cumulative_months: 0, months_delinquent_at_start: 2, mbs_months_to_maturity: 1 });
  assert.equal(t.months, 1); assert.ok(t.capped_by.includes("mbs_maturity")); assert.deepEqual(forbearanceTermDates(D("2027-01-01"), t.months), { start: "2027-01-01", end: "2027-01-31" });
  assert.equal(preExpiryOutreachStart(D("2027-01-31")), "2027-01-01");
  assert.equal(mbsMonthsToMaturity(D("2027-01-01"), D("2027-02-01")), 1); assert.equal(mbsMonthsToMaturity(D("2027-01-01"), D("2027-02-28")), 2); assert.equal(mbsMonthsToMaturity(D("2027-01-01"), D("2027-06-01")), 3 + 2);
  const c = termComputation({ requested_months: 3, cumulative_months: 0, months_delinquent_at_start: 2, start_on: D("2027-01-01"), last_scheduled_payment_date: D("2027-02-01"), mbs: true }); assert.equal(c.mbs_cap, 1); assert.equal(c.chosen, 1); assert.deepEqual(c.capped_by, ["mbs_maturity"]);
  // On the bus: offer construction caps a 3-month request at the last scheduled payment date; the MBS gate arms on `workout_plan.term.create{mbs=true}` and is open for 2027-01-31; an explicit 2-month term is refused.
  const h = harness("2026-12-15T14:00:00.000Z");
  await h.run("workout_plan.*", { op: "offer", id: "wp-m", offered_on: "2026-12-15", requested_months: 3, regx_short_term: true, application_complete: true });
  const rec = await h.run("workout_plan.*", { op: "term", id: "wp-m", requested_months: 3, cumulative_months: 0, months_delinquent_at_start: 2, start_on: "2027-01-01", mbs: true, last_scheduled_payment_date: "2027-02-01" });
  assert.equal(rec.term_start, "2027-01-01"); assert.equal(rec.term_end, "2027-01-31"); assert.equal(rec.months, 1); assert.deepEqual(rec.capped_by, ["mbs_maturity"]); assert.equal(rec.preexpiry_outreach_begin_by, "2027-01-01");
  const tc = payload(h.emitted("workout_plan.term.create")[0]); assert.equal(tc.mbs, true); assert.equal(tc.last_scheduled_payment_date, "2027-02-01"); assert.equal(tc.term_end, "2027-01-31");
  assert.match(h.armed("FNMA_D23201_FORB_MBS_MATURITY").note ?? "", /12\.4\.termEndBeforeLastScheduledPayment/);
  assert.deepEqual((rec.gates as Record<string, { open: boolean }>)["12.4.termEndBeforeLastScheduledPayment"], { open: true }); assert.equal(evaluateGate("12.4.termEndBeforeLastScheduledPayment", { ...tc, term_end: "2027-02-28" }).open, false);
  h.armed("FNMA_D23201_FORB_PREEXPIRY_CONTACT_30", "2027-01-01"); h.armed("FNMA_D23201_FORB_EXPIRY_DISPOSITION", "2027-01-31");
  const g = harness("2026-12-15T14:00:00.000Z"); await g.run("workout_plan.*", { op: "offer", id: "wp-m", offered_on: "2026-12-15", requested_months: 2 });
  await g.rejects("workout_plan.*", { op: "term", id: "wp-m", term_months: 2, cumulative_months: 0, months_delinquent_at_start: 2, start_on: "2027-01-01", mbs: true, last_scheduled_payment_date: "2027-02-01" }, /FNMA_D23201_FORB_MBS_MATURITY.*breaches mbs_maturity \(engine offers 1\)/);
  assert.equal(g.emitted("workout_plan.term.create").length, 0);
});
test("12.4-T9: (holds) 13.3 referral command refused while the plan is active; allowed 1 BD after `terminated{failed_terms}` (subject to 13.1).", async () => {
  assert.equal(referralGate({ plan_status: "active", today: D("2026-11-15") }).allowed, false);
  const early = referralGate({ plan_status: "terminated", terminated_reason: "failed_terms", terminated_on: D("2026-12-01"), today: D("2026-12-01") }); assert.equal(early.allowed, false); assert.equal(early.allowed_from, "2026-12-02");
  const ok = referralGate({ plan_status: "terminated", terminated_reason: "failed_terms", terminated_on: D("2026-12-01"), today: D("2026-12-02") }); assert.equal(ok.allowed, true);
  // On the bus: the performance hold arms on activation and is released only by the plan's end; the referral check reads the same gate.
  const h = harness(); await offerAndActivate(h); const hold = h.armed("REGX_1024_41C2III_PERFORMANCE_HOLD"); assert.equal(hold.dueDate, undefined, "an until-performing gate has no due date");
  const refusedRef = await h.run<{ allowed: boolean; refusal: string | null }>("workout_plan.*", { op: "referral_check", plan_status: "active" }, { now: "2026-11-15T14:00:00.000Z" }); assert.equal(refusedRef.allowed, false); assert.match(refusedRef.refusal!, /REGX_1024_41C2III_PERFORMANCE_HOLD/);
  await h.run("workout_plan.*", { op: "terminate", id: "wp-1", status: "terminated", terminated_reason: "failed_terms", terminated_on: "2026-12-01", mitigating_circumstances_checked: true }, { now: "2026-12-01T14:00:00.000Z" });
  h.satisfied("REGX_1024_41C2III_PERFORMANCE_HOLD", "workout_plan.ended"); assert.equal(payload(h.emitted("workout_plan.ended")[0]).terminated_reason, "failed_terms");
  assert.equal((await h.run<{ allowed: boolean }>("workout_plan.*", { op: "referral_check", plan_status: "terminated", terminated_reason: "failed_terms", terminated_on: "2026-12-01" })).allowed, false);
  assert.equal((await h.run<{ allowed: boolean }>("workout_plan.*", { op: "referral_check", plan_status: "terminated", terminated_reason: "failed_terms", terminated_on: "2026-12-01" }, { now: "2026-12-02T14:00:00.000Z" })).allowed, true);
});
test("12.4-T10: (Q1 2027 flag) with `smdu.plan_cases=on`, the plan creates an SMDU forbearance case and stops emitting code 09 in the legacy file.", async () => {
  assert.deepEqual(planCaseRouting({ smdu_plan_cases: "on", plan_kind: "forbearance" }), { smdu_case_created: true, legacy_status_code_emitted: null });
  assert.deepEqual(planCaseRouting({ smdu_plan_cases: "off", plan_kind: "forbearance" }), { smdu_case_created: false, legacy_status_code_emitted: "09" });
  // On the bus: flag off → the month-end fan-out arms the BD2 clock and the legacy line reports 09; flag on → an SMDU forbearance case (once), no `workout_plan.month_end`, and the legacy 09 report is refused.
  const h = harness(); await offerAndActivate(h);
  const off = await h.run<{ status_code: string | null; smdu_case_created: boolean }[]>("workout_plan.*", { op: "month_end", period_end: "2026-10-31", smdu_plan_cases: "off" }, { now: "2026-10-31T23:00:00.000Z" }); assert.deepEqual(off.map((r) => [r.status_code, r.smdu_case_created]), [["09", false]]); h.armed("FNMA_F121_STATUS_09_BD2", "2026-11-03");
  const g = harness(); await offerAndActivate(g);
  const on = await g.run<{ status_code: string | null; smdu_case_created: boolean; event_type: string | null }[]>("workout_plan.*", { op: "month_end", period_end: "2026-10-31", smdu_plan_cases: "on" }, { now: "2026-10-31T23:00:00.000Z" });
  assert.deepEqual(on.map((r) => [r.status_code, r.smdu_case_created, r.event_type]), [[null, true, "smdu.plan_case.created"]]); assert.equal(g.emitted("workout_plan.month_end").length, 0); assert.equal(g.timers.byCode("FNMA_F121_STATUS_09_BD2").length, 0);
  assert.equal(g.rt.store.get("smdu_plan_cases", "smdu-wp-1")!.data.workout, "forbearance"); assert.equal(g.rt.store.get("workout_plans", "wp-1")!.data.smdu_case_id, "smdu-wp-1");
  const again = await g.run<{ smdu_case_created: boolean; event_type: string | null }[]>("workout_plan.*", { op: "month_end", period_end: "2026-11-30", smdu_plan_cases: "on" }, { now: "2026-11-30T23:00:00.000Z" }); assert.deepEqual(again.map((r) => [r.smdu_case_created, r.event_type]), [[false, null]]);
  await g.rejects("fnma.status_code.report", { status_code: "09", reporting_month: "2026-10", plan_id: "wp-1" }, /status code 09 is not reported in the legacy F-1-21 file.*smdu-wp-1/);
  assert.equal(g.emitted("investor.status_code.reported").length, 0);
});
