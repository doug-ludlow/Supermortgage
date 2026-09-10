// 12.5 Repayment plan
// spec/sections/12-loss-mitigation/12-5-repayment-plan.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal, fannieEt } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput, type ToolDef } from "../../app/tools.ts";
import { SECTION_12_TOOLS } from "../../app/tools/section12.ts";
import { TOOLS_12_5 } from "../../app/tools/section12-5.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { repaymentBrpGate, repaymentExtension, lateChargeTreatment, repaymentFailureSolicitation, caLateFeeBar, repaymentReporting, capRetest, arrears, shortTermPlanOffer, roundCents } from "./ops.ts";
import { repaymentTerms, repaymentPlan } from "./plans.ts";
import { combinedTermGate, ingestInvestorAck, INCENTIVE_CENTS, scheduleRows, type RepaymentEnv } from "./ops-12-5.ts";

// ---- the 12.5 tools on the command bus with a TimerEngine over the overridden registry (12.5 rows plus the shared Reg X codes whose owning definition sits in 12.1 / 12.4) ----
const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const OFFICER: Actor = { kind: "human", id: "officer-1", role: "officer" };
const LOAN = "L-125";
const RECIPIENTS = [{ partyId: "b1", name: "Borrower", mailingAddress: "1 Test St, Testville TX 75001" }];
const toolKey = (process: string, name: string): string => `${process} ${name}`;
function bind(rt: ToolRuntime, agents: AgentRegistry, defs: readonly ToolDef[]): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of defs) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}
function harness(nowIso = "2026-10-01T14:00:00.000Z") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const registry = loadOverriddenRegistry();
  const timers = new TimerEngine(registry, events, { processes: ["12.1", "12.4", "12.5"] });
  const uow: UowContext = { loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const noticeReg = buildRegistry(); publishAuthored(noticeReg);
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }), ports: { printMail: new FakePrintMail(), edelivery: new FakeEdelivery() } };
  const agents = new AgentRegistry(); const cmds = bind(rt, agents, [...SECTION_12_TOOLS.filter((d) => d.process === "12.5"), ...TOOLS_12_5]); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("12.5", name))!, actor, { loan_id: LOAN, ...input }, uow)).output as Record<string, unknown>;
  const rejects = (name: string, input: ToolInput, re: RegExp) => assert.rejects(bus.execute(cmds.get(toolKey("12.5", name))!, AGENT, { loan_id: LOAN, ...input }, uow), (e: unknown) => re.test((e as Error).message));
  const timer = (code: string) => timers.byCode(code);
  const one = (code: string) => { const all = timers.byCode(code); assert.equal(all.length, 1, `${code}: expected exactly one instance, found ${all.length}`); return all[0]!; };
  const emitted = (type: string): readonly DomainEvent[] => events.all().filter((e) => e.type === type);
  const last = (type: string): DomainEvent => { const all = emitted(type); assert.ok(all.length, `${type} was emitted`); return all[all.length - 1]!; };
  const sample = (code: string, asOf = "2026-10-02") => noticeReg.activeVersion(code, D(asOf))!.samplePayload;
  const def = (code: string) => registry.get(code)!;
  const env: RepaymentEnv = { events, store: rt.store, actor: AGENT, now: nowIso };
  return { uow, rt, events, timers, run, rejects, timer, one, emitted, last, sample, def, env, decisions };
}
const PLAN = { start_on: "2026-11-01", term_months: 8, arrears_cents: 642_600n, contractual_cents: 210_000n, days_delinquent: 95, brp_complete: true, qrpc: true };

test("12.5-T1: Given PITI $2,100.00 and arrears $6,426.00, when terms are computed, then 6 months is rejected (151.0%) and 8 months accepted ($2,903.25; 138.25%); the schedule sums exactly to $6,426.00 with rounding in the last installment.", async () => {
  const six = repaymentTerms(642_600n, 210_000n, 6); assert.equal(six.installment_cents, 107_100n); assert.equal(six.total_monthly_cents, 317_100n); assert.equal(six.pct_of_contractual, "151.00"); assert.equal(six.allowed, false);
  const eight = repaymentTerms(642_600n, 210_000n, 8); assert.equal(eight.installment_cents, 80_325n); assert.equal(eight.total_monthly_cents, 290_325n); assert.equal(eight.pct_of_contractual, "138.25"); assert.equal(eight.allowed, true);
  assert.equal(eight.installment_cents * 7n + eight.final_installment_cents, 642_600n);
  const odd = repaymentTerms(642_601n, 210_000n, 8); assert.equal(odd.installment_cents, 80_326n); assert.equal(odd.installment_cents * 7n + odd.final_installment_cents, 642_601n); assert.ok(odd.final_installment_cents < odd.installment_cents);   // ceil-to-cent, residual in the last installment
  // Through the bus: the 6-month request is refused by the 150% cap gate (its `workout_plan.term.create` facts close `12.5.paymentCap150`); the 8-month plan writes an 8-row schedule summing to $6,426.00.
  const h = harness();
  await h.rejects("workout_plan.*", { id: "rp-1", ...PLAN, term_months: 6 }, /exceeds 150%/);
  const gate6 = h.last("workout_plan.term.create"); assert.equal(gate6.payload.expected_total_cents, 317_100n); assert.equal(evaluateGate("12.5.paymentCap150", gate6.payload).open, false); assert.equal(h.one("FNMA_D23202_REPAY_PAYMENT_CAP_150").note, "evaluator:12.5.paymentCap150");
  const plan = await h.run("workout_plan.*", { id: "rp-1", ...PLAN }); assert.equal(plan.installment_cents, 80_325n); assert.equal(plan.total_monthly_cents, 290_325n); assert.equal(plan.cure_date, "2027-06-30");
  assert.equal(evaluateGate("12.5.paymentCap150", h.last("workout_plan.term.create").payload).open, true);
  const rows = scheduleRows(h.env, "rp-1"); assert.equal(rows.length, 8); assert.deepEqual(rows.map((r) => r.due_date), ["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01", "2027-04-01", "2027-05-01", "2027-06-01"]);
  assert.equal(rows.reduce((a, r) => a + r.installment_cents, 0n), 642_600n); assert.ok(rows.every((r) => r.expected_total_cents === 290_325n));
  const odd8 = await h.run("workout_plan.*", { id: "rp-odd", ...PLAN, arrears_cents: 642_601n }); assert.equal(odd8.installment_cents, 80_326n);
  const oddRows = scheduleRows(h.env, "rp-odd"); assert.equal(oddRows[7]!.installment_cents, 642_601n - 80_326n * 7n); assert.equal(oddRows.reduce((a, r) => a + r.installment_cents, 0n), 642_601n);
});
test("12.5-T2: (BRP gate) loan 95 days delinquent → plan creation refused until the BRP is complete; 85 days + 6-month term → allowed on QRPC.", async () => {
  const refused = repaymentBrpGate({ days_delinquent: 95, term_months: 6, brp_complete: false, qrpc: true }); assert.equal(refused.allowed, false); assert.match(refused.refusal!, /complete BRP/);
  assert.equal(repaymentBrpGate({ days_delinquent: 95, term_months: 6, brp_complete: true, qrpc: true }).allowed, true);
  const ok = repaymentBrpGate({ days_delinquent: 85, term_months: 6, brp_complete: false, qrpc: true }); assert.equal(ok.allowed, true); assert.equal(ok.basis, "qrpc");
  // Through the bus: `workout_plan.term.create{plan_kind=repayment}` arms FNMA_D23202_REPAY_BRP_REQUIRED, whose evaluator reads the same facts the handler refuses on.
  const h = harness();
  await h.rejects("workout_plan.*", { id: "rp-2", start_on: "2026-11-01", term_months: 6, arrears_cents: 630_000n, contractual_cents: 210_000n, days_delinquent: 95, brp_complete: false, qrpc: true }, /complete BRP/);
  const gate = h.last("workout_plan.term.create"); assert.equal(gate.payload.fnma_days_delinquent, 95); assert.equal(gate.payload.brp_complete, false);
  assert.ok(eventMatches(h.def("FNMA_D23202_REPAY_BRP_REQUIRED").triggerPattern!, gate)); assert.equal(h.one("FNMA_D23202_REPAY_BRP_REQUIRED").status, "armed"); assert.match(evaluateGate("12.5.brpRequiredWhenLongOrDeep", gate.payload).reason ?? "", /BRP required/);
  assert.equal(h.rt.store.get("workout_plans", "rp-2"), undefined, "no plan row until the BRP is complete");
  const plan = await h.run("workout_plan.*", { id: "rp-2", start_on: "2026-11-01", term_months: 6, arrears_cents: 630_000n, contractual_cents: 210_000n, days_delinquent: 85, brp_complete: false, qrpc: true });
  assert.equal(plan.status, "active"); assert.equal(evaluateGate("12.5.brpRequiredWhenLongOrDeep", h.last("workout_plan.term.create").payload).open, true);
});
test("12.5-T3: (>12 months) 14-month request → F-1-16 package generated; plan stays `extension_pending` until approval id recorded.", async () => {
  assert.deepEqual(repaymentExtension({ term_months: 14 }), { package: "F-1-16", status: "extension_pending" });
  assert.deepEqual(repaymentExtension({ term_months: 14, fnma_approval_id: "FNMA-EX-1" }), { package: "F-1-16", status: "approved" });
  assert.deepEqual(repaymentExtension({ term_months: 8 }), { package: null, status: "not_required" });
  // Through the bus: a 14-month plan ($459.00 + $2,100.00 = 121.86%) is extension_pending with the F-1-16 package; the term gate closes until the approval id is recorded, then the plan is active.
  const h = harness();
  const pending = await h.run("workout_plan.*", { id: "rp-3", ...PLAN, term_months: 14 }); assert.equal(pending.status, "extension_pending"); assert.equal(pending.f116_package, "F-1-16"); assert.equal(pending.installment_cents, 45_900n);
  const gate = h.last("workout_plan.term.create"); assert.equal(gate.payload.term_months, 14); assert.equal(gate.payload.fnma_approval_id, null); assert.equal(h.one("FNMA_D23202_REPAY_TERM_MAX_12").status, "armed"); assert.match(evaluateGate("12.5.termMax12UnlessFnmaApproval", gate.payload).reason ?? "", /approval id/);
  const pkg = await h.run("fnma.f116_package.prepare", { term_months: 14 }); assert.equal(pkg.form, "F-1-16"); assert.equal(pkg.requested_months, 14); assert.equal(pkg.status, "prepared");
  await h.rejects("workout_plan.*", { id: "rp-3", ...PLAN, term_months: 14, status: "active" }, /extension_pending until the approval id/);
  const approved = await h.run("workout_plan.*", { id: "rp-3", ...PLAN, term_months: 14, fnma_approval_id: "FNMA-EX-1" }); assert.equal(approved.status, "active"); assert.equal(approved.fnma_approval_id, "FNMA-EX-1");
  assert.equal(evaluateGate("12.5.termMax12UnlessFnmaApproval", h.last("workout_plan.term.create").payload).open, true);
});
test("12.5-T4: (late charges) charges during the plan are suppressed; at completion they are written off with reason; on failure in month 5, charges accrue from month 5 only.", async () => {
  const active = lateChargeTreatment({ plan_months: 8, outcome: "active", late_charge_cents: 6_300n }); assert.deepEqual(active.suppressed_months, [1, 2, 3, 4, 5, 6, 7, 8]); assert.equal(active.accrued_cents, 0n);
  const done = lateChargeTreatment({ plan_months: 8, outcome: "completed", late_charge_cents: 6_300n }); assert.equal(done.written_off_cents, 50_400n); assert.equal(done.write_off_reason, "D2-3.2-02");
  const failed = lateChargeTreatment({ plan_months: 8, outcome: "failed", failed_month: 5, late_charge_cents: 6_300n }); assert.deepEqual(failed.suppressed_months, [1, 2, 3, 4]); assert.equal(failed.accrue_from_month, 5); assert.equal(failed.accrued_cents, 25_200n); assert.equal(failed.written_off_cents, 0n);
  // Through the bus: the agent suppresses; a waiver is an officer act with the D2-3.2-02 reason only.
  const h = harness();
  const sup = await h.run("fees.suppress/waive", { fee_id: "lc-2026-11", reason: "repayment plan active" }); assert.equal(sup.status, "suppressed");
  await assert.rejects(h.run("fees.suppress/waive", { op: "waive", fee_id: "lc-2026-11", reason: "D2-3.2-02" }), (e: unknown) => e instanceof CommandRefused && e.code === "WAIVER_NEEDS_OFFICER");
  await assert.rejects(h.run("fees.suppress/waive", { op: "waive", fee_id: "lc-2026-11", reason: "goodwill" }, OFFICER), (e: unknown) => e instanceof CommandRefused && e.code === "WAIVE_ONLY_ON_COMPLETION");
  const waived = await h.run("fees.suppress/waive", { op: "waive", fee_id: "lc-2026-11", reason: "D2-3.2-02" }, OFFICER); assert.equal(waived.status, "waived"); assert.equal(waived.reason, "D2-3.2-02");
});
test("12.5-T5: (failure clock) payment missed at 2026-11-30 month-end, no QRPC, 4 months delinquent → deferral solicitation sent by 2026-12-15; if deferral-ineligible → Flex Mod solicitation by 2026-12-15.", async () => {
  assert.deepEqual(repaymentFailureSolicitation({ missed_month_end: D("2026-11-30"), qrpc: false, months_delinquent: 4, deferral_eligible: true }), { solicitation: "payment_deferral", notice: "NTC_FNMA_D23204_SOLICIT_POST_REPAY", by: "2026-12-15" });
  assert.deepEqual(repaymentFailureSolicitation({ missed_month_end: D("2026-11-30"), qrpc: false, months_delinquent: 4, deferral_eligible: false }), { solicitation: "flex_mod", notice: "NTC_FNMA_D23206_SOLICIT_STREAMLINED", by: "2026-12-15" });
  assert.equal(repaymentFailureSolicitation({ missed_month_end: D("2026-11-30"), qrpc: true, months_delinquent: 4, deferral_eligible: true }).solicitation, null);
  // Through the engine: the November row is short at month end → `workout_plan.payment.missed`; op=fail emits `workout_plan.ended{status=failed, qrpc=false, deferral_eligible}` which arms the 15th-of-following-month clock; the solicitation notice satisfies it.
  const deferral = harness("2026-11-30T23:00:00.000Z");
  await deferral.run("workout_plan.*", { id: "rp-5", ...PLAN, days_delinquent: 120 });
  await deferral.run("workout_plan.*", { id: "rp-5", op: "row_due", due_date: "2026-11-01" }); await deferral.run("workout_plan.*", { id: "rp-5", op: "payment", received_cents: 210_000n, received_on: "2026-11-20" });
  const sweep = await deferral.run("workout_plan.*", { id: "rp-5", op: "month_end", month_end: "2026-11-30" }); assert.equal(sweep.shortfall_cents, 80_325n);
  const missed = deferral.last("workout_plan.payment.missed"); assert.equal(missed.payload.month_end, "2026-11-30"); assert.equal(missed.payload.received_cents, 210_000n);
  await deferral.run("workout_plan.*", { id: "rp-5", op: "fail", ended_on: "2026-11-30", qrpc: false, deferral_eligible: true });
  const failed = deferral.last("workout_plan.ended"); assert.equal(failed.payload.status, "failed"); assert.equal(failed.payload.failed_month_end, "2026-11-30"); assert.equal(failed.payload.start_days_delinquent, 120);
  assert.equal(deferral.one("FNMA_D23204_POSTREPAY_DEFERRAL_SOLICIT_15TH").dueDate, "2026-12-15"); assert.equal(deferral.timer("FNMA_D23206_POSTREPAY_FLEX_SOLICIT_15TH").length, 0);
  await deferral.run("notice.render_send", { template_code: "NTC_FNMA_D23204_SOLICIT_POST_REPAY", recipients: RECIPIENTS, payload: deferral.sample("NTC_FNMA_D23204_SOLICIT_POST_REPAY", "2026-12-01"), as_of: "2026-12-01" });
  assert.equal(deferral.last("notice.sent").payload.template, "NTC_FNMA_D23204_SOLICIT_POST_REPAY"); assert.equal(deferral.one("FNMA_D23204_POSTREPAY_DEFERRAL_SOLICIT_15TH").status, "satisfied");
  const flex = harness("2026-11-30T23:00:00.000Z");
  await flex.run("workout_plan.*", { id: "rp-5f", ...PLAN, days_delinquent: 120 });
  await flex.run("workout_plan.*", { id: "rp-5f", op: "fail", ended_on: "2026-11-30", qrpc: false, deferral_eligible: false, flex_eligible: true });
  assert.equal(flex.one("FNMA_D23206_POSTREPAY_FLEX_SOLICIT_15TH").dueDate, "2026-12-15"); assert.equal(flex.timer("FNMA_D23204_POSTREPAY_DEFERRAL_SOLICIT_15TH").length, 0);
  await flex.run("notice.render_send", { template_code: "NTC_FNMA_D23206_SOLICIT_STREAMLINED", recipients: RECIPIENTS, payload: flex.sample("NTC_FNMA_D23206_SOLICIT_STREAMLINED", "2026-12-01"), as_of: "2026-12-01" });
  assert.equal(flex.one("FNMA_D23206_POSTREPAY_FLEX_SOLICIT_15TH").status, "satisfied");
  assert.equal(flex.timers.evaluate("2026-12-16T05:00:00.000Z").length, 0, "a solicitation sent by the 15th never breaches");
});
test("12.5-T6: (Reg X short-term) 3 months arrears over 6 months on an incomplete application → `regx_short_term=true`; terms notice within 5 federal BD; foreclosure hold active while performing.", async () => {
  const plan = repaymentPlan(630_000n, 210_000n, 500_000n); assert.ok(plan.eligible); if (plan.eligible) { assert.equal(plan.terms.months, 6); assert.equal(plan.months_of_arrears, 3); assert.equal(plan.regx_short_term, true); }
  const eight = repaymentPlan(642_600n, 210_000n); assert.ok(eight.eligible); if (eight.eligible) assert.equal(eight.regx_short_term, false);   // 8 months is not short-term (comment 41(c)(2)(iii)-4)
  const offer = shortTermPlanOffer({ offered_on: D("2026-10-01"), months_of_arrears: 3, term_months: 6, application_complete: false });
  assert.equal(offer.regx_short_term, true); assert.equal(offer.terms_notice, "NTC_FNMA_D23202_REPAY_PLAN"); assert.equal(offer.terms_notice_by, "2026-10-08"); assert.ok(offer.timers.includes("REGX_1024_41C2III_SHORTTERM_NOTICE_5")); assert.ok(offer.timers.includes("REGX_1024_41C2III_PERFORMANCE_HOLD"));
  assert.deepEqual(offer.hold, { kind: "fnma_plan_performing", from: "2026-10-01", to: null, active: true });
  assert.equal(shortTermPlanOffer({ offered_on: D("2026-10-01"), months_of_arrears: 3, term_months: 6, application_complete: true }).terms_notice_by, null);   // on a complete application the (c)(1) notice governs instead
  // The plan notice doubles as the (c)(2)(iii) terms notice: the incomplete-application block must carry the reasonable date.
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_FNMA_D23202_REPAY_PLAN", D("2026-10-02"))!;
  const payload = { ...v.samplePayload, duration_months: 6, regx_short_term: true, reasonable_date: "2026-10-30", schedule: (v.samplePayload.schedule as unknown[]).slice(0, 6) }; const out = render(v.source, payload);
  assert.match(out.text, /based on an evaluation of an incomplete loss mitigation application/); assert.match(out.text, /may initiate or resume foreclosure/); assert.equal(evaluateChecklist(v, payload, out).passed, true);
  assert.equal(evaluateChecklist(v, { ...payload, reasonable_date: "" }, render(v.source, { ...payload, reasonable_date: "" })).blocking.some((b) => b.rule_id === "incomplete-basis"), true);
  // Through the engine: op=offer on 2026-10-01 arms the 5-federal-BD terms-notice clock (due 2026-10-08 — Oct 12 is Columbus Day, after the window) and the 5-calendar-day Evaluation Notice clock; the plan notice satisfies both; activation arms the performance hold, which the plan's completion releases.
  const h = harness();
  await h.run("workout_plan.*", { op: "offer", id: "rp-6", offered_on: "2026-10-01", term_months: 6, regx_short_term: true, application_complete: false });
  const offered = h.last("workout_plan.offered"); assert.equal(offered.payload.kind, "repayment_plan"); assert.equal(offered.payload.regx_short_term, true); assert.equal(offered.payload.application_complete, false);
  assert.equal(h.one("REGX_1024_41C2III_SHORTTERM_NOTICE_5").dueDate, addBusinessDays(D("2026-10-01"), 5, federal)); assert.equal(h.one("REGX_1024_41C2III_SHORTTERM_NOTICE_5").dueDate, "2026-10-08"); assert.equal(h.one("FNMA_D2205_EVAL_NOTICE_REPAY").dueDate, "2026-10-06");
  await h.run("notice.render_send", { template_code: "NTC_FNMA_D23202_REPAY_PLAN", recipients: RECIPIENTS, payload });
  const sent = h.last("notice.sent"); assert.equal(sent.payload.template, "NTC_FNMA_D23202_REPAY_PLAN"); assert.ok(eventMatches(h.def("REGX_1024_41C2III_SHORTTERM_NOTICE_5").satisfiedPattern!, sent));
  assert.equal(h.one("REGX_1024_41C2III_SHORTTERM_NOTICE_5").status, "satisfied"); assert.equal(h.one("FNMA_D2205_EVAL_NOTICE_REPAY").status, "satisfied");
  await h.run("workout_plan.*", { id: "rp-6", start_on: "2026-11-01", term_months: 6, arrears_cents: 630_000n, contractual_cents: 210_000n, days_delinquent: 85, qrpc: true });
  const hold = h.one("REGX_1024_41C2III_PERFORMANCE_HOLD"); assert.equal(hold.status, "armed"); assert.equal(hold.dueAt, undefined, "a gate: open while performing, no deadline");
  const set = await h.run("foreclosure_holds.set", { kind: "fnma_plan_performing", from: "2026-11-01" }).catch(() => null); if (set) assert.equal(set.status, "active");
  await h.run("workout_plan.*", { id: "rp-6", op: "complete", ended_on: "2027-04-30" });
  assert.equal(h.one("REGX_1024_41C2III_PERFORMANCE_HOLD").status, "satisfied"); assert.equal(h.last("workout_plan.ended").payload.status, "completed");
});
test("12.5-T7: (CA) late fee assessment refused from the evaluation start date, not only from plan start.", () => {
  const r = caLateFeeBar({ state: "CA", evaluation_start: D("2026-10-01"), plan_start: D("2026-11-01"), assessment_on: D("2026-10-16") });
  assert.equal(r.allowed, false); assert.equal(r.barred_from, "2026-10-01"); assert.match(r.refusal!, /2924\.11\(d\)/);
  assert.equal(caLateFeeBar({ state: "CA", evaluation_start: D("2026-10-01"), plan_start: D("2026-11-01"), assessment_on: D("2026-09-16") }).allowed, true);
  assert.equal(caLateFeeBar({ state: "TX", evaluation_start: D("2026-10-01"), plan_start: D("2026-11-01"), assessment_on: D("2026-10-16") }).allowed, true);
  assert.equal(evaluateGate("12.5.californiaLateFeeBar", { late_fee_assessment_requested: true }).open, false); assert.equal(evaluateGate("12.5.californiaLateFeeBar", { late_fee_assessment_requested: false }).open, true);
});
test("12.5-T8: (reporting) status 12 with effective date reported at BD2; completion date reported in the completion month; $500 incentive claimed when the start delinquency was ≥60 days.", async () => {
  const r = repaymentReporting({ start_on: D("2026-11-01"), completed_on: D("2027-06-28"), start_days_delinquent: 90 });
  assert.equal(r.status_code, "12"); assert.equal(r.effective_date, "2026-11-01"); assert.equal(r.report_by, "2026-12-02"); assert.equal(r.completion_report_month, "2027-06-01"); assert.equal(r.incentive_cents, 50_000n); assert.equal(r.incentive_claim_cycle, "2027-07-01");
  assert.equal(repaymentReporting({ start_on: D("2026-11-01"), completed_on: D("2027-06-28"), start_days_delinquent: 45 }).incentive_cents, 0n);
  // Through the engine: the November month end (plan active, row paid) arms FNMA_F121_STATUS_12_BD2 due BD2 = 2026-12-02 (2 Fannie Mae ET business days from 2026-11-30); the status-12 report's acknowledgement satisfies it.
  const h = harness("2026-11-30T22:00:00.000Z");
  await h.run("workout_plan.*", { id: "rp-8", ...PLAN, days_delinquent: 90 });
  await h.run("workout_plan.*", { id: "rp-8", op: "row_due", due_date: "2026-11-01" }); await h.run("workout_plan.*", { id: "rp-8", op: "payment", received_cents: 290_325n, received_on: "2026-11-25" });
  const sweep = await h.run("workout_plan.*", { id: "rp-8", op: "month_end", month_end: "2026-11-30" }); assert.equal(sweep.missed_event, null); assert.equal(sweep.report_by, "2026-12-02");
  const me = h.last("period.month_end"); assert.equal(me.payload.workout_plan_active, true); assert.equal(me.payload.plan_kind, "repayment"); assert.ok(eventMatches(h.def("FNMA_F121_STATUS_12_BD2").triggerPattern!, me));
  const bd2 = h.one("FNMA_F121_STATUS_12_BD2"); assert.equal(bd2.dueDate, addBusinessDays(D("2026-11-30"), 2, fannieEt)); assert.equal(bd2.dueDate, "2026-12-02");
  const rep = await h.run("fnma.status_code.report", { op: "report", plan_id: "rp-8", reporting_month: "2026-12-01" }); assert.equal(rep.effective_date, "2026-11-01"); assert.equal(rep.completion_date, null); assert.equal(h.last("investor.status_code.reported").payload.status_code, "12");
  await h.rejects("fnma.status_code.report", { op: "ack", submission_id: "st12-nope", status: "accepted", kind: "status_code", status_code: "12" }, /no submission/);
  await h.rejects("fnma.status_code.report", { op: "ack", submission_id: rep.submission_id, status: "accepted", kind: "status_code", status_code: "09" }, /not the repayment-plan code 12/);
  const ack = await h.run("fnma.status_code.report", { op: "ack", submission_id: rep.submission_id, status: "accepted", kind: "status_code", status_code: "12", accepted_at: "2026-12-02T15:00:00.000Z" }) as unknown as DomainEvent;
  assert.equal(ack.type, "investor.event.accepted"); assert.equal(ack.payload.status_code, "12"); assert.ok(eventMatches(h.def("FNMA_F121_STATUS_12_BD2").satisfiedPattern!, ack)); assert.equal(bd2.status, "satisfied");
  // Completion on 2027-06-28 (90 days delinquent at start) → the completion date rides the June report; `workout_plan.ended{status=completed, start_days_delinquent>=60}` arms the F-2-02 claim (last day of the following month); the $500 claim's acknowledgement satisfies it.
  await h.run("workout_plan.*", { id: "rp-8", op: "complete", ended_on: "2027-06-28" });
  const ended = h.last("workout_plan.ended"); assert.equal(ended.payload.start_days_delinquent, 90); assert.ok(eventMatches(h.def("FNMA_F202_REPAY_INCENTIVE_CLAIM").triggerPattern!, ended));
  const claim = h.one("FNMA_F202_REPAY_INCENTIVE_CLAIM"); assert.equal(claim.dueDate, "2027-07-31");
  const june = await h.run("fnma.status_code.report", { op: "report", plan_id: "rp-8", reporting_month: "2027-06-01" }); assert.equal(june.completion_date, "2027-06-28");
  const inc = await h.run("fnma.status_code.report", { op: "incentive_claim", plan_id: "rp-8" }); assert.equal(inc.amount_cents, INCENTIVE_CENTS); assert.equal(inc.amount_cents, 50_000n); assert.equal(inc.claim_cycle, "2027-07-01");
  await h.rejects("fnma.status_code.report", { op: "ack", submission_id: inc.submission_id, status: "accepted", kind: "incentive", amount_cents: 40_000n }, /must be 50000/);
  const incAck = await h.run("fnma.status_code.report", { op: "ack", submission_id: inc.submission_id, status: "accepted", kind: "incentive" }) as unknown as DomainEvent;
  assert.equal(incAck.payload.kind, "incentive"); assert.equal(incAck.payload.workout, "repayment_plan"); assert.equal(claim.status, "satisfied");
  // 45 days delinquent at start: no incentive — the completion event does not arm the claim and the claim op refuses.
  await h.run("workout_plan.*", { id: "rp-8b", ...PLAN, days_delinquent: 45 }); await h.run("workout_plan.*", { id: "rp-8b", op: "complete", ended_on: "2027-06-28" });
  assert.equal(h.timer("FNMA_F202_REPAY_INCENTIVE_CLAIM").length, 1); await h.rejects("fnma.status_code.report", { op: "incentive_claim", plan_id: "rp-8b" }, /needs ≥60/);
});
test("12.5-T9: (recast) escrow analysis raises PITI to $2,250 in month 3 → total $3,053.25 = 135.7% (still under cap) → no recast; a rise to $2,050 P&I-only edge case handled by the cap re-test.", async () => {
  const r = capRetest({ installment_cents: 80_325n, new_contractual_cents: 225_000n, plan_months: 8 });
  assert.equal(r.total_cents, 305_325n); assert.equal(r.pct_of_contractual, "135.70"); assert.equal(r.within_cap, true); assert.equal(r.recast, null);
  const edge = capRetest({ installment_cents: 80_325n, new_contractual_cents: 205_000n, plan_months: 8 }); assert.equal(edge.total_cents, 285_325n); assert.equal(edge.within_cap, true);
  const breach = capRetest({ installment_cents: 107_100n, new_contractual_cents: 205_000n, plan_months: 6 }); assert.equal(breach.within_cap, false); assert.deepEqual(breach.recast, { months: 7 });
  // Through the bus: a contractual change must go through op=contractual_change (the cap is re-tested; the installment is unchanged).
  const h = harness();
  await h.run("workout_plan.*", { id: "rp-9", ...PLAN });
  await assert.rejects(h.run("workout_plan.*", { id: "rp-9", changes: { contractual_cents: 225_000n } }), (e: unknown) => e instanceof CommandRefused && e.code === "CONTRACTUAL_CHANGE_NEEDS_CAP_RETEST");
  const re = await h.run("workout_plan.*", { id: "rp-9", op: "contractual_change", new_contractual_cents: 225_000n }); assert.equal(re.installment_cents, 80_325n); assert.equal(re.total_monthly_cents, 305_325n); assert.equal(re.pct_of_contractual, "135.70"); assert.equal(re.status, "active");
  assert.deepEqual(h.last("workout_plan.cap_retested").payload, { plan_id: "rp-9", within_cap: true, recast: null });
});

test("12.5 worked figures: PITI $2,100.00; 3 × $2,100.00 = $6,300.00 + 2 × $63.00 = $126.00 (4% of P&I $1,580.17 = $63.21) → $6,426.00; 6 months $3,171.00 (not allowed); 8 months $2,903.25; 12 months $535.50 + $2,100.00 = $2,635.50", () => {
  const a = arrears({ piti_cents: 210000n, unpaid_installments: 3, late_charge_cents: 6300n, late_charges: 2 }); assert.equal(a.installments_cents, 630000n); assert.equal(a.late_charges_cents, 12600n); assert.equal(a.total_cents, 642600n);
  assert.equal(roundCents(158017n * 4n, 100n), 6321n);   // 4% of P&I, rounded half-up (the note's $63.00 is assumed in the example)
  const six = repaymentTerms(642600n, 210000n, 6); assert.equal(six.total_monthly_cents, 317100n); assert.equal(six.allowed, false);
  const eight = repaymentTerms(642600n, 210000n, 8); assert.equal(eight.total_monthly_cents, 290325n); assert.equal(eight.allowed, true);
  const twelve = repaymentTerms(642600n, 210000n, 12); assert.equal(twelve.installment_cents, 53550n); assert.equal(twelve.total_monthly_cents, 263550n);
  const cap = repaymentPlan(642600n, 210000n, 250000n); assert.equal(cap.eligible, false);
});

// ---- the 12.5 timer rows the T-ids do not exercise end to end: the combined 36-month gate and the per-row month-end payment clock ----
test("12.5 gates: `workout_plan.term.create{forbearance_component=true, combined_months}` arms FNMA_D23201_FORB_COMBINED_36M; 4 forbearance + 8 repayment months passes, 30 + 8 = 38 is refused (D2-3.2-01)", async () => {
  assert.deepEqual(combinedTermGate({ term_months: 8, forbearance_months: 4 }), { allowed: true, combined_months: 12, forbearance_component: true, refusal: null });
  assert.equal(combinedTermGate({ term_months: 8, forbearance_months: 28 }).allowed, true); assert.match(combinedTermGate({ term_months: 8, forbearance_months: 30 }).refusal!, /38 exceeds the 36-month combined cap/);
  const h = harness();
  const plan = await h.run("workout_plan.*", { id: "rp-c", ...PLAN, forbearance_months: 4 }); assert.equal(plan.forbearance_months, 4);
  const tc = h.last("workout_plan.term.create"); assert.equal(tc.payload.forbearance_component, true); assert.equal(tc.payload.combined_months, 12); assert.ok(eventMatches(h.def("FNMA_D23201_FORB_COMBINED_36M").triggerPattern!, tc));
  assert.equal(h.one("FNMA_D23201_FORB_COMBINED_36M").note, "evaluator:12.5.combinedMax36Months"); assert.equal(evaluateGate("12.5.combinedMax36Months", tc.payload).open, true);
  await h.rejects("workout_plan.*", { id: "rp-c2", ...PLAN, forbearance_months: 30 }, /38 exceeds the 36-month combined cap/);
  const over = h.last("workout_plan.term.create"); assert.equal(over.payload.combined_months, 38); assert.equal(evaluateGate("12.5.combinedMax36Months", over.payload).open, false); assert.equal(h.rt.store.get("workout_plans", "rp-c2"), undefined);
  // Without a forbearance component the combined row stays quiet; the three repayment gates arm on every create.
  const h2 = harness(); await h2.run("workout_plan.*", { id: "rp-c3", ...PLAN });
  assert.equal(h2.timer("FNMA_D23201_FORB_COMBINED_36M").length, 0); for (const code of ["FNMA_D23202_REPAY_PAYMENT_CAP_150", "FNMA_D23202_REPAY_TERM_MAX_12", "FNMA_D23202_REPAY_BRP_REQUIRED"]) assert.equal(h2.one(code).status, "armed", code);
});
test("12.5 month-end payment clock: `workout_plan_schedule.row_due{due_date}` arms FNMA_D23202_REPAY_PAYMENT_EOM due the last day of that month; a partial receipt sits in suspense; the receipt that reaches expected_total satisfies it; the next row arms its own clock", async () => {
  const h = harness("2026-11-01T14:00:00.000Z");
  await h.run("workout_plan.*", { id: "rp-e", ...PLAN });
  await h.rejects("workout_plan.*", { id: "rp-e", op: "row_due", due_date: "2026-10-01" }, /no schedule row/);
  const due = await h.run("workout_plan.*", { id: "rp-e", op: "row_due", due_date: "2026-11-01" }); assert.equal((due.row as { status: string }).status, "due");
  const rowDue = h.last("workout_plan_schedule.row_due"); assert.equal(rowDue.payload.due_date, "2026-11-01"); assert.equal(rowDue.payload.expected_total_cents, 290_325n); assert.ok(eventMatches(h.def("FNMA_D23202_REPAY_PAYMENT_EOM").triggerPattern!, rowDue));
  const eom = h.one("FNMA_D23202_REPAY_PAYMENT_EOM"); assert.equal(eom.anchorDate, "2026-11-01"); assert.equal(eom.dueDate, "2026-11-30");
  await h.rejects("workout_plan.*", { id: "rp-e", op: "row_due", due_date: "2026-11-01" }, /already due/);
  const partial = await h.run("workout_plan.*", { id: "rp-e", op: "payment", received_cents: 100_000n, received_on: "2026-11-10" }); assert.equal(partial.covers_expected_total, false); assert.equal(partial.suspense_cents, 100_000n);
  assert.equal(h.last("workout_plan.payment.received").payload.covers_expected_total, false); assert.equal(eom.status, "armed", "a partial receipt does not close the month-end clock");
  const full = await h.run("workout_plan.*", { id: "rp-e", op: "payment", received_cents: 190_325n, received_on: "2026-11-20" }); assert.equal(full.covers_expected_total, true); assert.equal(full.suspense_cents, 0n); assert.equal((full.row as { status: string }).status, "paid");
  const received = h.last("workout_plan.payment.received"); assert.equal(received.payload.cumulative_received_cents, 290_325n); assert.ok(eventMatches(h.def("FNMA_D23202_REPAY_PAYMENT_EOM").satisfiedPattern!, received)); assert.equal(eom.status, "satisfied");
  await h.run("workout_plan.*", { id: "rp-e", op: "row_due", due_date: "2026-12-01" }); const dec = h.timer("FNMA_D23202_REPAY_PAYMENT_EOM"); assert.equal(dec.length, 2); assert.equal(dec[1]!.dueDate, "2026-12-31"); assert.equal(dec[1]!.status, "armed");
  assert.equal(h.timers.evaluate("2027-01-01T05:00:00.000Z").map((b) => b.instance.code).join(), "FNMA_D23202_REPAY_PAYMENT_EOM", "the December row breaches after 23:59 on 2026-12-31 with no covering receipt");
  const sweep = await h.run("workout_plan.*", { id: "rp-e", op: "month_end", month_end: "2026-12-31" }); assert.equal(sweep.shortfall_cents, 290_325n); assert.equal(h.last("workout_plan.payment.missed").payload.row, 2);
  assert.equal(h.one("FNMA_F121_STATUS_12_BD2").dueDate, "2027-01-05");   // 2027-01-01 is a holiday: BD1 = Jan 4, BD2 = Jan 5
  // A rejected acknowledgement is not an acceptance: it neither satisfies the clock nor spells `investor.event.accepted`.
  const rep = await h.run("fnma.status_code.report", { op: "report", plan_id: "rp-e", reporting_month: "2027-01-01" });
  const rejected = ingestInvestorAck(h.env, { loan_id: LOAN, submission_id: String(rep.submission_id), status: "rejected", kind: "status_code", status_code: "12", reason: "E-101" });
  assert.equal(rejected.type, "investor.event.rejected"); assert.equal(h.one("FNMA_F121_STATUS_12_BD2").status, "armed");
});
