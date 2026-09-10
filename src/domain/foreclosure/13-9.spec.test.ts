// 13.9 SCRA 6% interest cap
// spec/sections/13-foreclosure/13-9-scra-6-interest-cap.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { form1022Schedule, lateChargeWaiver, overpaymentElection, defaultElection, assertedServiceWithoutEvidence, lateRequest, capTail, armAdjustment, feeInsideCap } from "./ops.ts";
import { recalculate, servicingFee, capEffectivePaymentDue, cappedRate, capEndsOn, restorationInstallment, endDateLetterDue, armCappedRate } from "./scra.ts";
import { cents } from "../../kernel/money/cents.ts";
import { daysBetween } from "../../kernel/calendar/date.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { SECTION_13_TOOLS } from "../../app/tools/section13.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, type TimerInstance } from "../../kernel/timers/engine.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

// ---- the §13 tools on the bus with a TimerEngine over the overridden registry (only 13.9 rows arm): each timer a T-id
// names is armed by the event a tool appends and satisfied by the event the responding tool appends — never by a literal.
// 13.9 names no tools of its own in agents.json, so its ops ride on the 13.8 tool `scra.case.get/open/close`.
const LOAN = "L-139";
const AGENT: Actor = { kind: "agent", id: "foreclosure-ops" };
const ATTORNEY: Actor = { kind: "human", id: "u-attorney", role: "attorney" };
const TOOL = "scra.case.get/open/close";
type Row = Record<string, unknown>;
function bus(startIso: string, loanId = LOAN, seed: { pool_type?: string; product?: string; next_due_on?: string; note_rate_pct?: string } = {}) {
  const clock = new FixedClock(startIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["13.9"] });
  const ledger = new MemoryLedger();
  const ctx: UowContext = { loanId, events, ledger, timers, clock, decide: (d) => { decisions.push({ loanId, ...d }); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>(); for (const d of SECTION_13_TOOLS) { const c = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, c.name); cmds.set(`${d.process} ${d.name}`, c); }
  const cb = new CommandBus(agents);
  const run = async <O = Row>(tool: string, actor: Actor, input: Record<string, unknown>, at?: string): Promise<O> => { if (at) clock.set(at); const cmd = cmds.get(`13.8 ${tool}`); assert.ok(cmd, `13.8 ${tool} is on the bus`); return (await cb.execute(cmd, actor, input, ctx, { now: clock.now() })).output as O; };
  const scra = async <O = Row>(op: string, input: Record<string, unknown>, at?: string, actor: Actor = AGENT): Promise<O> => run<O>(TOOL, actor, { loan_id: loanId, op, ...input }, at);
  const types = (from = 0) => events.all().slice(from).map((e) => e.type);
  const last = (type: string) => { const e = events.all().filter((x) => x.type === type && x.loanId === loanId).at(-1); assert.ok(e, `${type} appended`); return e; };
  const inst = (code: string) => timers.byCode(code).filter((x) => x.subject.id === loanId);
  const armed = (code: string, due: string | undefined): TimerInstance => { const t = inst(code).at(-1); assert.ok(t, `${code} armed for ${loanId}`); assert.equal(t.status, "armed", `${code} status`); assert.equal(t.dueDate, due, `${code} due`); return t; };
  const satisfied = (code: string, byType: string, status: "satisfied" | "satisfied_late" = "satisfied"): TimerInstance => { const t = inst(code).find((x) => x.status === status); assert.ok(t, `${code} ${status}`); const by = events.all().find((e) => e.id === t.satisfiedByEventId)!; assert.equal(by.type, byType, `${code} satisfied by ${byType}`); assert.ok(eventMatches(loadOverriddenRegistry().get(code)!.satisfiedPattern!, by), `${code}: the satisfying event carries every conditioned field`); return t; };
  const put = (kind: string, id: string, data: Row) => rt.store.put(kind, id, data, ATTORNEY, clock.now());
  // the worked example's loan: 30-year fixed 7.25%, $300,000, first payment Apr. 1, 2024, P&I $2,046.53; #25–#29 paid at the note rate (next due Sept. 1, 2026)
  put("loans", loanId, { loan_id: loanId, origination_date: "2024-03-01", next_due_on: seed.next_due_on ?? "2026-09-01", pool_type: seed.pool_type ?? "portfolio", product: seed.product ?? "fixed", borrower_party_id: "p1", borrower_name: "Alex Rivera", mailing_address: "1 Main St, Springfield" });
  put("loan_terms", `lt-${loanId}-1`, { loan_id: loanId, version: 1, original_principal_cents: 30_000_000n, note_rate_pct: seed.note_rate_pct ?? "7.25", term_months: 360, first_payment_due: "2024-04-01", pi_cents: 204_653n, status: "active" });
  return { clock, events, timers, ledger, rt, run, scra, types, last, inst, armed, satisfied, put, escalations: rt.escalations };
}
const refused = (code: string) => (e: unknown) => e instanceof CommandRefused && e.code === code;
const rangeError = (re: RegExp) => (e: unknown) => e instanceof RangeError && re.test(e.message);
const lines = (b: ReturnType<typeof bus>, setId: string) => { const set = b.ledger.sets().find((x) => x.id === setId); assert.ok(set, `ledger set ${setId}`); return set.lines.map((l) => ({ account: l.account.account, amount: l.amountCents })); };

test("13.9-T1: Given the worked example, Then forgiven interest = $1,528.30, new P&I (subsidy) = $1,741.73, standard alternative = $1,810.42, Fannie Mae differential for Sept. = $304.80, servicing fee $60.96 on UPB.", async () => {
  const upb24 = balanceAfter(cents("300000"), "7.25", 360, 24); assert.equal(upb24, cents("293975.18"));
  const r = recalculate({ upb_cents: upb24, note_rate_pct: "7.25", pi_cents: cents("2046.53"), first_capped_due: D("2026-04-01"), first_n: 25, paid_at_note_rate_count: 5, remaining_term_after: 331 });
  assert.deepEqual(r.rows.map((x) => [x.n, x.due, x.upb_before_cents, x.interest_note_cents, x.interest_capped_cents, x.forgiven_cents, x.principal_cents]), [[25, "2026-04-01", cents("293975.18"), cents("1776.10"), cents("1469.88"), cents("306.22"), cents("270.43")], [26, "2026-05-01", cents("293704.75"), cents("1774.47"), cents("1468.52"), cents("305.95"), cents("272.06")], [27, "2026-06-01", cents("293432.69"), cents("1772.82"), cents("1467.16"), cents("305.66"), cents("273.71")], [28, "2026-07-01", cents("293158.98"), cents("1771.17"), cents("1465.79"), cents("305.38"), cents("275.36")], [29, "2026-08-01", cents("292883.62"), cents("1769.51"), cents("1464.42"), cents("305.09"), cents("277.02")]]);
  assert.equal(r.forgiven_total_cents, cents("1528.30")); assert.equal(r.upb_after_cents, cents("292606.60"));
  assert.equal(r.next_payment_subsidy_cents, cents("1741.73")); assert.equal(r.next_payment_standard_cents, cents("1810.42")); assert.equal(r.fnma_differential_cents, cents("304.80")); assert.equal(servicingFee(r.upb_after_cents, "0.25"), cents("60.96"));
  // on the bus (MBS loan): the written notice with orders arrives Sept. 10, 2026; activation reproduces the figures from the baseline loan_terms — the caller supplies no amount
  const b = bus("2026-09-10T14:00:00.000Z", LOAN, { pool_type: "mbs" });
  const req = await b.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1", service_begin_on: "2026-03-15" });
  assert.equal(req.status, "requested"); assert.equal(req.basis, "orders"); assert.equal(req.sufficient_evidence, true); assert.equal(req.timer, "SM_SCRA_RATE_ACTIVATE_5BD");
  await assert.rejects(b.scra("rate_activate", { forgiven_cents: 1n }), rangeError(/money math is code/));
  const act = await b.scra<Row & { rows: { forgiven_cents: bigint }[]; postings: { account: string; debit: bigint; credit: bigint }[] }>("rate_activate", {});
  assert.equal(act.status, "active"); assert.equal(act.method, "interest_subsidy"); assert.equal(act.capped_rate, "6.000"); assert.equal(act.cap_effective_payment_due, "2026-04-01");
  assert.equal(act.upb_before_cap_cents, cents("293975.18")); assert.equal(act.rows.length, 5); assert.equal(act.forgiven_total_cents, cents("1528.30")); assert.equal(act.upb_after_cents, cents("292606.60"));
  assert.equal(act.new_payment_cents, cents("1741.73")); assert.equal(act.subsidy_payment_cents, cents("1741.73")); assert.equal(act.standard_payment_cents, cents("1810.42")); assert.equal(act.fnma_differential_cents, cents("304.80")); assert.equal(act.servicing_fee_cents, cents("60.96"));
  assert.equal(act.overpayment_cents, cents("1528.30")); assert.equal(act.sufficient_alone, false); assert.equal(act.shortfall_cents, cents("213.43")); assert.equal(act.new_payment_due, "2026-09-01");
  // rule 7: per installment Dr scra_interest_forgiven / Cr scra_overpayment_payable — balanced, five pairs, $1,528.30 in total; MBS: Dr fnma_military_indulgence_receivable / Cr interest_income $304.80
  const set = lines(b, String(act.ledger_set_id)); assert.equal(set.length, 10); assert.equal(set.reduce((s, l) => s + l.amount, 0n), 0n);
  assert.equal(set.filter((l) => (l.account as string) === "scra_interest_forgiven").reduce((s, l) => s + l.amount, 0n), cents("1528.30")); assert.equal(set.filter((l) => (l.account as string) === "scra_overpayment_payable").reduce((s, l) => s + l.amount, 0n), -cents("1528.30"));
  assert.deepEqual(lines(b, String(act.investor_entry_set_id)), [{ account: "fnma_military_indulgence_receivable", amount: cents("304.80") }, { account: "interest_income", amount: -cents("304.80") }]);
  assert.deepEqual(b.rt.store.list("scra_recalculations").map((r) => [r.data.installment_due_on, r.data.forgiven_cents]), [["2026-04-01", 30_622n], ["2026-05-01", 30_595n], ["2026-06-01", 30_566n], ["2026-07-01", 30_538n], ["2026-08-01", 30_509n]]);
  assert.equal(b.last("scra.recalculation.completed").payload.forgiven_cents, cents("1528.30")); assert.equal(b.last("scra.rate_reduction.applied").payload.mbs, true);
  const terms = b.rt.store.get("loan_terms", String(act.loan_terms_version_id))!.data; assert.equal(terms.rate_override_kind, "scra"); assert.equal(terms.rate, "6.000"); assert.equal(terms.pi_cents, cents("1741.73"));
});
test("13.9-T2: Given an active-duty start Mar. 15, 2026, Then `cap_effective_payment_due` = Apr. 1, 2026 (the whole April installment at 6%).", async () => {
  assert.equal(capEffectivePaymentDue(D("2026-03-15")), "2026-04-01", "the whole April installment at 6%"); assert.equal(capEffectivePaymentDue(D("2026-03-01")), "2026-04-01", "the installment due on the entry day is not after entry"); assert.equal(capEffectivePaymentDue(D("2026-02-28")), "2026-03-01");
  assert.equal(cappedRate("7.25"), "6.000"); assert.equal(cappedRate("5.50"), "5.50");
  const b = bus("2026-09-10T14:00:00.000Z");
  const req = await b.scra("rate_request", { received_on: "2026-09-10", channel: "portal", dmdc_certificate_id: "CERT-Y-1", service_begin_on: "2026-03-15" });
  assert.equal(req.cap_effective_payment_due, "2026-04-01"); assert.equal(req.statutory_effective_on, "2026-03-15", "statute: the call-up date; platform: the whole first installment due after entry"); assert.equal(req.basis, "dmdc");
  assert.equal(b.last("scra.request.received").payload.cap_effective_payment_due, "2026-04-01");
  await assert.rejects(b.scra("rate_request", { received_on: "2026-09-11", channel: "mail", orders_document_id: "doc-orders-1", service_begin_on: "2026-03-15" }), rangeError(/already has a requested SCRA rate period/));
  const b2 = bus("2026-09-10T14:00:00.000Z", "L-139-call");
  await assert.rejects(b2.scra("rate_request", { received_on: "2026-09-10", channel: "call", dmdc_certificate_id: "CERT-Y-1", service_begin_on: "2026-03-15" }), rangeError(/not written notice/));
  const b3 = bus("2026-09-10T14:00:00.000Z", "L-139-low", { note_rate_pct: "5.50" });
  await assert.rejects(b3.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-1", service_begin_on: "2026-03-15" }), rangeError(/does not exceed 6%/));
});
test("13.9-T3: Given service ends Feb. 28, 2027, Then the cap continues to Feb. 28, 2028 and restoration is the Mar. 1, 2028 installment at $2,046.53; the end-date letter goes out ~60 days before.", async () => {
  const t = capTail({ service_end_on: D("2027-02-28"), restored_payment_cents: cents("2046.53") });
  assert.equal(t.cap_ends_on, "2028-02-28"); assert.equal(t.timer, "SCRA_3937A1_CAP_TAIL_1Y"); assert.equal(t.restoration_due, "2028-03-01"); assert.equal(t.restored_payment_cents, cents("2046.53"));
  assert.equal(t.end_letter_due, "2027-12-30"); assert.equal(t.notice, "NTC_SCRA_3937_RATE_END"); assert.equal(daysBetween(t.end_letter_due, t.cap_ends_on), 60);
  assert.equal(capEndsOn(D("2027-02-28")), "2028-02-28"); assert.equal(restorationInstallment(D("2028-02-28")), "2028-03-01"); assert.equal(endDateLetterDue(D("2028-02-28")), "2027-12-30");
  assert.equal(t.capInForceOn(D("2028-02-28")), true); assert.equal(t.capInForceOn(D("2028-02-29")), false);
  // on the bus: the 13.8 case closes on orders showing service ended Feb. 28, 2027 → scra.period.ended arms SCRA_3937A1_CAP_TAIL_1Y (due 2028-02-28) and the rate period enters its tail
  const b = bus("2026-06-03T12:00:00.000Z");
  await b.run(TOOL, AGENT, { loan_id: LOAN, op: "open", dmdc_status: "Y", origination_on: "2024-03-01", service_begin_on: "2026-03-15", verified_on: "2026-06-03", orders_document_id: "doc-orders-1" });
  await b.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1" }, "2026-09-10T14:00:00.000Z");
  await b.scra("rate_activate", {});
  const closed = await b.run(TOOL, AGENT, { loan_id: LOAN, op: "close", service_end_on: "2027-02-28", orders_document_id: "doc-release-1" }, "2027-03-02T12:00:00.000Z");
  assert.equal(closed.rate_period_id, `srp-${LOAN}`); const period = await b.scra("rate_period", {});
  assert.equal(period.status, "tail"); assert.equal(period.cap_ends_on, "2028-02-28"); assert.equal(period.restoration_due, "2028-03-01"); assert.equal(period.end_letter_due, "2027-12-30");
  assert.equal(b.last("scra.rate_period.tail_started").payload.cap_ends_on, "2028-02-28"); b.armed("SCRA_3937A1_CAP_TAIL_1Y", "2028-02-28"); b.armed("SCRA_3937B1_NOTICE_WINDOW_180", "2027-08-27");
  // restoration is blocked through cap_ends_on; the end-date letter is not sent before 60 days out
  await assert.rejects(b.scra("restore", {}, "2028-02-28T12:00:00.000Z"), rangeError(/blocked through cap_ends_on 2028-02-28/));
  await assert.rejects(b.scra("rate_end_letter", {}, "2027-12-29T12:00:00.000Z"), rangeError(/due 2027-12-30/));
  const letter = await b.scra<{ letter: { template: string; sent: string } }>("rate_end_letter", {}, "2027-12-30T12:00:00.000Z"); assert.equal(letter.letter.template, "NTC_SCRA_3937_RATE_END"); assert.equal(letter.letter.sent, "2027-12-30");
  const sent = b.last("notice.sent"); assert.equal(sent.payload.template, "NTC_SCRA_3937_RATE_END"); assert.equal(sent.payload.restoration_due, "2028-03-01"); assert.equal(sent.payload.restored_payment_cents, cents("2046.53"));
  await assert.rejects(b.scra("rate_end_letter", {}, "2027-12-31T12:00:00.000Z"), rangeError(/already sent/));
  const restored = await b.scra("restore", {}, "2028-03-01T12:00:00.000Z");
  assert.equal(restored.status, "ended"); assert.equal(restored.restoration_due, "2028-03-01"); assert.equal(restored.restored_pi_cents, cents("2046.53")); assert.equal(restored.restored_rate_pct, "7.25");
  b.satisfied("SCRA_3937A1_CAP_TAIL_1Y", "scra.rate_reduction.ended"); assert.equal(b.last("scra.rate_reduction.ended").payload.restored_pi_cents, cents("2046.53"));
  assert.equal(b.rt.store.get("form_1022_submissions", `f1022-${LOAN}-2028-03-rate_restoration`)!.data.reason, "rate_restoration");
  assert.ok(b.rt.store.list("loan_terms").every((r) => r.data.rate_override_kind !== "scra" || r.data.status === "superseded"), "the SCRA loan_terms version is superseded at restoration");
});
test("13.9-T4: Given an ARM at 5.50% during the cap, Then the rate stays 5.50% (lower); at 7.00% ⇒ 6.00%; each adjustment emits 83/event.", async () => {
  const low = armAdjustment({ adjusted_rate_pct: "5.50", scheduled_on: D("2026-10-01"), cap_active: true }); assert.equal(low.applied_rate_pct, "5.50"); assert.equal(low.capped, false);
  assert.deepEqual(low.event, { type: "investor.event", kind: "lar_83", servicing_event: "rate_payment.change", on: "2026-10-01" }); assert.equal(low.timer, "FNMA_F119_ARM_TXN83");
  const high = armAdjustment({ adjusted_rate_pct: "7.00", scheduled_on: D("2027-04-01"), cap_active: true }); assert.equal(high.applied_rate_pct, "6.000"); assert.equal(high.capped, true); assert.equal(high.event.kind, "lar_83");
  assert.equal(armCappedRate("5.50"), "5.50"); assert.equal(armCappedRate("7.00"), "6.000"); assert.equal(armAdjustment({ adjusted_rate_pct: "7.00", scheduled_on: D("2028-04-01"), cap_active: false }).applied_rate_pct, "7.00");
  // on the bus (ARM loan under the cap): each scheduled adjustment appends arm.adjustment.scheduled{scra_cap_active=true} (arms FNMA_F119_ARM_TXN83, next Fannie Mae BD 20:00 ET) and the LAR 83; Fannie Mae's acknowledgement satisfies it
  const b = bus("2026-09-10T14:00:00.000Z", LOAN, { product: "arm" });
  await b.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1", service_begin_on: "2026-03-15" }); await b.scra("rate_activate", {});
  const lowB = await b.scra("arm_adjustment", { adjusted_rate_pct: "5.50", scheduled_on: "2026-10-01" }, "2026-10-01T12:00:00.000Z");
  assert.equal(lowB.applied_rate_pct, "5.50"); assert.equal(lowB.capped, false); assert.deepEqual(lowB.events, ["arm.adjustment.scheduled", "investor.event.submitted"]);
  const sched = b.last("arm.adjustment.scheduled"); assert.equal(sched.payload.scra_cap_active, true); assert.equal(sched.payload.scheduled_on, "2026-10-01"); assert.equal(b.last("investor.event.submitted").payload.kind, "lar_83");
  b.armed("FNMA_F119_ARM_TXN83", "2026-10-02");
  await assert.rejects(b.scra("fnma_ack", { submission_id: String(lowB.submission_id) }), rangeError(/ack_id is required/));
  const ack = await b.scra("fnma_ack", { submission_id: String(lowB.submission_id), ack_id: "FNMA-ACK-83-1", accepted_on: "2026-10-02" }, "2026-10-02T15:00:00.000Z");
  assert.equal(ack.event, "investor.event.accepted"); b.satisfied("FNMA_F119_ARM_TXN83", "investor.event.accepted"); assert.equal(b.last("investor.event.accepted").payload.kind, "lar_83");
  const highB = await b.scra("arm_adjustment", { adjusted_rate_pct: "7.00", scheduled_on: "2027-04-01" }, "2027-04-01T12:00:00.000Z");
  assert.equal(highB.applied_rate_pct, "6.000"); assert.equal(highB.capped, true); assert.equal(b.inst("FNMA_F119_ARM_TXN83").length, 2, "each adjustment arms its own 83 clock");
  assert.equal(b.rt.store.get("scra_rate_periods", `srp-${LOAN}`)!.data.capped_rate, "6.000");
  const fixed = bus("2026-09-10T14:00:00.000Z", "L-139-fixed");
  await fixed.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1", service_begin_on: "2026-03-15" });
  await assert.rejects(fixed.scra("arm_adjustment", { adjusted_rate_pct: "5.50", scheduled_on: "2026-10-01" }), rangeError(/not an ARM/));
});
test("13.9-T5: Given a portfolio loan, Then Form 1022 emailed by BD9 of the following month with the reduction; MBS loan ⇒ upload by CD15; both tracked with acks.", async () => {
  const portfolio = form1022Schedule({ reduction_month: D("2026-09-01"), mbs: false, acked_on: D("2026-10-05") }); assert.equal(portfolio.channel, "email_bd9"); assert.equal(portfolio.due, "2026-10-14");   // BD9 of October 2026 (Columbus Day excluded)
  assert.equal(portfolio.tracked, true); assert.equal(portfolio.acknowledged, true);
  const mbs = form1022Schedule({ reduction_month: D("2026-09-01"), mbs: true }); assert.equal(mbs.channel, "upload_cd15"); assert.equal(mbs.due, "2026-10-15"); assert.equal(mbs.acknowledged, false);
  // portfolio on the bus: scra.rate_reduction.applied arms FNMA_F119_FORM1022_BD9 (BD9 of October = 2026-10-14); form_1022.sent (email, message id) satisfies it; the Fannie Mae ack is tracked on the row
  const p = bus("2026-09-10T14:00:00.000Z", "L-139-pfp", { pool_type: "portfolio" });
  await p.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1", service_begin_on: "2026-03-15" }); const act = await p.scra("rate_activate", {});
  p.armed("FNMA_F119_FORM1022_BD9", "2026-10-14"); assert.equal(p.inst("FNMA_F119_MBS_UPLOAD_CD15").length, 0, "a portfolio loan arms no CD15 upload clock");
  assert.equal(p.rt.store.get("form_1022_submissions", String(act.form_1022_submission_id))!.data.channel, "email_form1022");
  await assert.rejects(p.scra("form_1022_sent", { reason: "rate_reduction", sent_on: "2026-10-05" }, "2026-10-05T12:00:00.000Z"), rangeError(/message_id is required/));
  const sent = await p.scra("form_1022_sent", { reason: "rate_reduction", sent_on: "2026-10-05", message_id: "msg-1022-1" }, "2026-10-05T12:00:00.000Z");
  assert.equal(sent.channel, "email_form1022"); assert.equal(sent.due_by, "2026-10-14"); assert.equal(sent.on_time, true); assert.equal(sent.month, "2026-09"); assert.equal(sent.timer, "FNMA_F119_FORM1022_BD9");
  p.satisfied("FNMA_F119_FORM1022_BD9", "form_1022.sent");
  const ack = await p.scra("fnma_ack", { submission_id: String(sent.submission_id), ack_id: "ETMU-ACK-1", accepted_on: "2026-10-06" }, "2026-10-06T12:00:00.000Z");
  assert.equal(ack.event, "form_1022.acknowledged"); assert.equal(p.rt.store.get("form_1022_submissions", String(sent.submission_id))!.data.fnma_ack, "ETMU-ACK-1");
  await assert.rejects(p.scra("fnma_ack", { submission_id: String(sent.submission_id), ack_id: "ETMU-ACK-2" }), rangeError(/already acknowledged/));
  // MBS on the bus: scra.rate_reduction.applied{mbs=true} arms FNMA_F119_MBS_UPLOAD_CD15 (2026-10-15); the upload's acceptance (fnma.upload.accepted{kind=form_1022}) satisfies it
  const m = bus("2026-09-10T14:00:00.000Z", "L-139-mbs", { pool_type: "mbs" });
  await m.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1", service_begin_on: "2026-03-15" }); await m.scra("rate_activate", {});
  m.armed("FNMA_F119_MBS_UPLOAD_CD15", "2026-10-15"); assert.equal(m.inst("FNMA_F119_FORM1022_BD9").length, 0, "an MBS loan arms no BD9 email clock");
  await assert.rejects(m.scra("form_1022_sent", { reason: "rate_reduction", sent_on: "2026-10-09" }, "2026-10-09T12:00:00.000Z"), rangeError(/file_id is required/));
  const up = await m.scra("form_1022_sent", { reason: "rate_reduction", sent_on: "2026-10-09", file_id: "lsdu-upload-77" }, "2026-10-09T12:00:00.000Z");
  assert.equal(up.channel, "mbs_upload"); assert.equal(up.due_by, "2026-10-15"); assert.equal(m.inst("FNMA_F119_MBS_UPLOAD_CD15")[0]!.status, "armed", "the upload alone does not satisfy — the acceptance does");
  const rejectedAck = await m.scra("fnma_ack", { submission_id: String(up.submission_id), ack_id: "LSDU-REJ-1", accepted: false, reason_code: "E014" }, "2026-10-10T12:00:00.000Z");
  assert.equal(rejectedAck.event, "fnma.upload.rejected"); assert.ok(rejectedAck.escalation_id, "a rejected upload goes to the portal operator"); assert.equal(m.inst("FNMA_F119_MBS_UPLOAD_CD15")[0]!.status, "armed");
  const up2 = await m.scra("form_1022_sent", { submission_id: "f1022-mbs-2", reason: "rate_reduction", sent_on: "2026-10-12", file_id: "lsdu-upload-78" }, "2026-10-12T12:00:00.000Z");
  const okAck = await m.scra("fnma_ack", { submission_id: String(up2.submission_id), ack_id: "LSDU-ACK-1", accepted_on: "2026-10-13" }, "2026-10-13T12:00:00.000Z");
  assert.equal(okAck.event, "fnma.upload.accepted"); m.satisfied("FNMA_F119_MBS_UPLOAD_CD15", "fnma.upload.accepted"); assert.equal(m.last("fnma.upload.accepted").payload.kind, "form_1022");
});
test("13.9-T6: Given late charges of $81.86 assessed May–Aug. 2026, Then waived/refunded with the recalculation; 2.7 gate blocks new ones.", async () => {
  const charges = [{ assessed_on: D("2026-05-17"), cents: 2_047n, paid: true }, { assessed_on: D("2026-06-17"), cents: 2_047n, paid: false }, { assessed_on: D("2026-07-17"), cents: 2_046n, paid: false }, { assessed_on: D("2026-08-17"), cents: 2_046n, paid: false }];
  const r = lateChargeWaiver({ charges, cap_effective_due: D("2026-04-01"), cap_ends_on: D("2028-02-28") });
  assert.equal(r.waived_cents + r.refunded_cents, 8_186n); assert.equal(r.refunded_cents, 2_047n); assert.equal(r.new_charges_blocked, true); assert.equal(r.gate, "SCRA_3937_FEES_IN_CAP_GATE");
  // on the bus: the 2.7 fees rows are the amounts (never the caller); the unpaid ones are waived (Dr late_charge_income / Cr late_charges), the paid one refunded into the overpayment
  const b = bus("2026-09-10T14:00:00.000Z");
  const fee = (id: string, on: string, amount: bigint, collected: bigint) => b.put("fees", id, { loan_id: LOAN, fee_type: "late_charge", assessed_on: on, amount_cents: amount, collected_cents: collected, waived_cents: 0n, state: collected >= amount ? "collected" : "assessed" });
  fee("lc-2026-05", "2026-05-17", 2_047n, 2_047n); fee("lc-2026-06", "2026-06-17", 2_047n, 0n); fee("lc-2026-07", "2026-07-17", 2_046n, 0n); fee("lc-2026-08", "2026-08-17", 2_046n, 0n); fee("lc-2026-03", "2026-03-17", 2_047n, 0n);   // March: before the cap — untouched
  await b.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1", service_begin_on: "2026-03-15" });
  const act = await b.scra<Row & { late_charge_fee_ids: string[] }>("rate_activate", {});
  assert.equal(act.late_charges_waived_cents, 6_139n); assert.equal(act.late_charges_refunded_cents, 2_047n); assert.deepEqual(act.late_charge_fee_ids, ["lc-2026-05", "lc-2026-06", "lc-2026-07", "lc-2026-08"]);
  assert.equal(act.overpayment_cents, 152_830n + 2_047n, "the refunded late charge joins the interest overpayment"); assert.equal(act.gate, "SCRA_3937_FEES_IN_CAP_GATE");
  const set = lines(b, String(act.ledger_set_id)); assert.equal(set.filter((l) => l.account === "late_charge_income").reduce((s, l) => s + l.amount, 0n), 8_186n); assert.equal(set.find((l) => l.account === "late_charges")!.amount, -6_139n); assert.equal(set.reduce((s, l) => s + l.amount, 0n), 0n);
  const waived = b.last("late_charges.waived"); assert.equal(waived.payload.cents, 8_186n); assert.equal(waived.payload.reason, "scra_rate_cap"); assert.equal(b.rt.store.get("fees", "lc-2026-06")!.data.state, "waived"); assert.equal(b.rt.store.get("fees", "lc-2026-03")!.data.state, "assessed");
  // the 2.7 gate: a new late charge inside the cap is refused unless forgiven under the cap; bona fide insurance passes (§3937(d))
  assert.equal(evaluateGate("13.9.feesInsideCap", { fee_cents: 2_046n, bona_fide_insurance: false, fee_forgiven_under_cap: false }).open, false);
  assert.equal(evaluateGate("13.9.feesInsideCap", { fee_cents: 2_046n, bona_fide_insurance: false, fee_forgiven_under_cap: true }).open, true); assert.equal(evaluateGate("13.9.feesInsideCap", { fee_cents: 12_000n, bona_fide_insurance: true }).open, true);
});
test("13.9-T7: Given the borrower elects refund, Then Dr `scra_overpayment_payable` 1,528.30 / Cr cash; election recorded; statement shows the refund transaction.", async () => {
  const r = overpaymentElection({ overpayment_cents: 152_830n, next_payment_cents: 174_173n, election: "refund", recorded_on: D("2026-09-20") });
  assert.deepEqual(r.postings, [{ account: "scra_overpayment_payable", debit: 152_830n, credit: 0n, rule_ref: "13.9.overpayment.refund" }, { account: "cash", debit: 0n, credit: 152_830n, rule_ref: "13.9.overpayment.refund" }]);
  assert.equal(r.balanced, true); assert.equal(r.election_recorded, true); assert.equal(r.statement_line, "SCRA interest refund"); assert.equal(r.sufficient_alone, false); assert.equal(r.shortfall_cents, 21_343n);
  // on the bus: the election letter at activation arms SM_SCRA_OVERPAYMENT_ELECTION_30 (2026-10-10); the recorded election posts the refund and satisfies it
  const b = bus("2026-09-10T14:00:00.000Z");
  await b.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1", service_begin_on: "2026-03-15" }); const act = await b.scra("rate_activate", {});
  assert.equal(act.election_id, `soe-srp-${LOAN}`); b.armed("SM_SCRA_OVERPAYMENT_ELECTION_30", "2026-10-10");
  await assert.rejects(b.scra("election", { election: "cheque" }), rangeError(/election must be one of/));
  const el = await b.scra("election", { election: "refund" }, "2026-09-20T12:00:00.000Z");
  assert.equal(el.election, "refund"); assert.equal(el.amount_cents, 152_830n); assert.equal(el.election_recorded, true); assert.equal(el.statement_line, "SCRA interest refund"); assert.equal(el.sufficient_alone, false); assert.equal(el.shortfall_cents, 21_343n);
  assert.deepEqual(lines(b, String(el.ledger_set_id)), [{ account: "scra_overpayment_payable", amount: 152_830n }, { account: "corporate_cash", amount: -152_830n }]);
  b.satisfied("SM_SCRA_OVERPAYMENT_ELECTION_30", "scra.overpayment.election_recorded"); assert.equal(b.last("scra.overpayment.elected").payload.election, "refund");
  assert.equal(b.rt.store.get("scra_overpayment_elections", `soe-srp-${LOAN}`)!.data.election, "refund"); assert.equal(b.rt.store.get("statement_lines", `stl-${LOAN}-soe-srp-${LOAN}`)!.data.description, "SCRA interest refund");
  await assert.rejects(b.scra("election", { election: "curtailment" }), rangeError(/already refund/));
});
test("13.9-T8: Given no election in 30 days, Then the default election (decision 13.9-3) applies and the borrower is told.", async () => {
  const r = defaultElection({ letter_sent_on: D("2026-09-15"), today: D("2026-10-16") });
  assert.equal(r.due, "2026-10-15"); assert.equal(r.applied, "curtailment"); assert.equal(r.defaulted, true); assert.equal(r.borrower_notice, "NTC_SCRA_3937_OVERPAYMENT_ELECTION");
  assert.equal(defaultElection({ letter_sent_on: D("2026-09-15"), today: D("2026-10-10") }).applied, null); assert.equal(defaultElection({ letter_sent_on: D("2026-09-15"), election: "refund", today: D("2026-10-20") }).defaulted, false);
  // on the bus: the letter goes out at activation (Sept. 10) → due Oct. 10; on Oct. 10 the lapse is refused, on Oct. 11 the timer has breached and the default curtailment applies with the borrower letter
  const b = bus("2026-09-10T14:00:00.000Z");
  await b.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1", service_begin_on: "2026-03-15" }); await b.scra("rate_activate", {});
  const t = b.armed("SM_SCRA_OVERPAYMENT_ELECTION_30", "2026-10-10");
  await assert.rejects(b.scra("election_lapse", {}, "2026-10-10T12:00:00.000Z"), rangeError(/open until 2026-10-10/));
  b.clock.set("2026-10-11T12:00:00.000Z"); const breaches = b.timers.evaluate("2026-10-11T12:00:00.000Z"); assert.ok(breaches.some((x) => x.instance.id === t.id), "the 30-day clock breaches on Oct. 11");
  const lapse = await b.scra("election_lapse", {}, "2026-10-11T12:00:00.000Z");
  assert.equal(lapse.applied, "curtailment"); assert.equal(lapse.defaulted, true); assert.equal(lapse.due, "2026-10-10"); assert.equal(lapse.borrower_notice, "NTC_SCRA_3937_OVERPAYMENT_ELECTION");
  assert.deepEqual(lines(b, String(lapse.ledger_set_id)), [{ account: "scra_overpayment_payable", amount: 152_830n }, { account: "principal", amount: -152_830n }]);
  const rec = b.last("scra.overpayment.election_recorded"); assert.equal(rec.payload.defaulted, true); assert.equal(rec.payload.election, "curtailment"); assert.equal(rec.payload.decision, "13.9-3");
  const told = b.last("notice.sent"); assert.equal(told.payload.template, "NTC_SCRA_3937_OVERPAYMENT_ELECTION"); assert.equal(told.payload.defaulted, true);
  b.satisfied("SM_SCRA_OVERPAYMENT_ELECTION_30", "scra.overpayment.election_recorded", "satisfied_late"); assert.equal(b.rt.store.get("scra_overpayment_elections", `soe-srp-${LOAN}`)!.data.election, "curtailment");
  await assert.rejects(b.scra("election_lapse", {}, "2026-10-12T12:00:00.000Z"), rangeError(/already curtailment/));
});
test("13.9-T9: Given the borrower asserts service but DMDC returns N and no orders, Then no denial without `attorney` review; a request for orders is sent.", async () => {
  const r = assertedServiceWithoutEvidence({ written_assertion: true, dmdc_status: "N" }); assert.equal(r.denial_allowed, false); assert.equal(r.escalation!.kind, "attorney"); assert.equal(r.request_orders, true);
  assert.equal(assertedServiceWithoutEvidence({ written_assertion: true, dmdc_status: "N", orders_document_id: "orders-1" }).request_orders, false);
  // on the bus: DMDC N on file, a written assertion and no orders → the request is recorded without evidence, orders are requested, the attorney is escalated to and no activation clock arms
  const b = bus("2026-09-10T14:00:00.000Z");
  b.put("scra_verifications", "scrav-1", { loan_id: LOAN, on_active_duty: "N", status_date: "2026-09-01", purpose: "request" });
  const req = await b.scra("rate_request", { received_on: "2026-09-10", channel: "mail", service_begin_on: "2026-03-15" });
  assert.equal(req.sufficient_evidence, false); assert.equal(req.denial_allowed, false); assert.equal(req.request_orders, true); assert.ok(req.escalation_id); assert.equal(req.timer, null); assert.equal(req.status, "requested");
  assert.equal(b.escalations.opened.find((e) => e.id === req.escalation_id)!.kind, "attorney"); assert.equal(b.last("scra.request.received").payload.sufficient_evidence, false); assert.ok(b.types().includes("scra.orders.requested"));
  assert.equal(b.inst("SM_SCRA_RATE_ACTIVATE_5BD").length, 0, "no activation clock without sufficient evidence");
  await assert.rejects(b.scra("rate_activate", {}), rangeError(/without sufficient evidence/), "no activation either");
  await assert.rejects(b.scra("rate_decline", { reason: "no qualifying service" }), rangeError(/denied only by the attorney/));
  const declined = await b.scra("rate_decline", { reason: "DMDC N confirmed; borrower produced no orders after two requests" }, undefined, ATTORNEY);
  assert.equal(declined.status, "declined"); assert.equal(b.last("scra.rate_request.declined").payload.reviewed_by, "attorney");
});
test("13.9-T10: Given a request 200 days after release with verified service, Then the cap is applied retroactively for the service period + tail (policy) and Form 1022 sent.", async () => {
  const r = lateRequest({ release_on: D("2027-02-28"), request_on: D("2027-09-16"), service_verified: true, service_begin_on: D("2026-03-15"), mbs: false });
  assert.equal(r.statutory, false); assert.equal(r.honored, true); assert.equal(r.cap_from_due, "2026-04-01"); assert.equal(r.cap_ends_on, "2028-02-28"); assert.equal(r.retroactive, true); assert.deepEqual(r.form_1022, { channel: "email_bd9" });
  assert.equal(lateRequest({ release_on: D("2027-02-28"), request_on: D("2027-09-16"), service_verified: false, service_begin_on: D("2026-03-15"), mbs: false }).honored, false);
  // on the bus: the 13.8 case (orders) closed on release Feb. 28, 2027 → SCRA_3937B1_NOTICE_WINDOW_180 (due 2027-08-27) breaches; the request on day 200 satisfies it late and is honoured on the verified service
  const b = bus("2026-06-03T12:00:00.000Z", LOAN, { next_due_on: "2027-10-01" });
  await b.run(TOOL, AGENT, { loan_id: LOAN, op: "open", dmdc_status: "Y", origination_on: "2024-03-01", service_begin_on: "2026-03-15", verified_on: "2026-06-03", orders_document_id: "doc-orders-1" });
  await b.run(TOOL, AGENT, { loan_id: LOAN, op: "close", service_end_on: "2027-02-28", orders_document_id: "doc-release-1" }, "2027-03-02T12:00:00.000Z");
  const w = b.armed("SCRA_3937B1_NOTICE_WINDOW_180", "2027-08-27"); assert.equal(daysBetween(D("2027-02-28"), D("2027-08-27")), 180);
  b.clock.set("2027-09-16T12:00:00.000Z"); b.timers.evaluate("2027-09-16T12:00:00.000Z"); assert.equal(b.inst("SCRA_3937B1_NOTICE_WINDOW_180").find((x) => x.id === w.id)!.status, "breached");
  const req = await b.scra("rate_request", { received_on: "2027-09-16", channel: "mail", orders_document_id: "doc-orders-1" }, "2027-09-16T12:00:00.000Z");
  assert.equal(daysBetween(D("2027-02-28"), D("2027-09-16")), 200); assert.equal(req.within_statutory_window, false); assert.equal(req.honored, true); assert.equal(req.sufficient_evidence, true); assert.equal(req.cap_ends_on, "2028-02-28");
  b.satisfied("SCRA_3937B1_NOTICE_WINDOW_180", "scra.request.received", "satisfied_late"); b.armed("SM_SCRA_RATE_ACTIVATE_5BD", "2027-09-23");
  const act = await b.scra<Row & { rows: unknown[] }>("rate_activate", {});
  assert.equal(act.status, "tail", "service already ended: the period activates straight into its tail"); assert.equal(act.cap_effective_payment_due, "2026-04-01"); assert.equal(act.cap_ends_on, "2028-02-28"); assert.equal(act.restoration_due, "2028-03-01");
  assert.equal(act.rows.length, 18, "#25 (Apr. 2026) through #42 (Sept. 2027) were paid at the note rate and are recalculated retroactively"); assert.ok((act.forgiven_total_cents as bigint) > 152_830n);
  b.satisfied("SM_SCRA_RATE_ACTIVATE_5BD", "scra.rate_reduction.applied"); b.armed("FNMA_F119_FORM1022_BD9", "2027-10-14");   // BD9 of October 2027 (Columbus Day Oct. 11 excluded)
  const sent = await b.scra("form_1022_sent", { reason: "rate_reduction", message_id: "msg-1022-late" }, "2027-10-05T12:00:00.000Z");
  assert.equal(sent.channel, "email_form1022"); assert.equal(sent.due_by, "2027-10-14"); b.satisfied("FNMA_F119_FORM1022_BD9", "form_1022.sent");
});
test("13.9-T11: **(leap-crossing fixture — mirrors 13.8-T11)** Given `service_end_on` = **2027-06-01**, Then `cap_ends_on` = **2028-06-01** (`SCRA_3937A1_CAP_TAIL_1Y`, calendar-year addition over a window containing Feb 29, 2028); the 6% cap and `SCRA_3937_FEES_IN_CAP_GATE` are **still in force on 2028-05-31** — the date a `+365 calendar_days` offset would have ended them — and restoration is the first installment due after 2028-06-01. Given instead `service_end_on` = **2028-02-29**, Then `cap_ends_on` = **2029-02-28** (Feb 29 clamp).", async () => {
  const t = capTail({ service_end_on: D("2027-06-01"), restored_payment_cents: cents("2046.53") });
  assert.equal(t.cap_ends_on, "2028-06-01"); assert.equal(t.timer, "SCRA_3937A1_CAP_TAIL_1Y"); assert.equal(daysBetween(D("2027-06-01"), D("2028-06-01")), 366);
  assert.equal(t.capInForceOn(D("2028-05-31")), true, "the date a +365 calendar_days offset would have ended the cap"); assert.equal(t.capInForceOn(D("2028-06-01")), true); assert.equal(t.capInForceOn(D("2028-06-02")), false);
  const fee = feeInsideCap({ assessed_on: D("2028-05-31"), cap_effective_due: D("2026-04-01"), cap_ends_on: t.cap_ends_on }); assert.equal(fee.inside, true); assert.equal(fee.gate, "SCRA_3937_FEES_IN_CAP_GATE"); assert.equal(fee.disposition, "forgive");
  assert.equal(feeInsideCap({ assessed_on: D("2028-06-02"), cap_effective_due: D("2026-04-01"), cap_ends_on: t.cap_ends_on }).disposition, "collectible");
  assert.equal(lateChargeWaiver({ charges: [{ assessed_on: D("2028-05-31"), cents: 2_046n, paid: false }], cap_effective_due: D("2026-04-01"), cap_ends_on: t.cap_ends_on }).waived_cents, 2_046n);
  assert.equal(t.restoration_due, "2028-07-01", "the first installment due after 2028-06-01");
  assert.equal(capEndsOn(D("2028-02-29")), "2029-02-28", "Feb 29 clamp"); assert.equal(capTail({ service_end_on: D("2028-02-29"), restored_payment_cents: 0n }).restoration_due, "2029-03-01");
  // on the bus: the engine's SCRA_3937A1_CAP_TAIL_1Y is due 2028-06-01 (calendar-year addition), restoration is refused on 2028-05-31 and on 2028-06-01 and allowed on 2028-06-02 with the July 1 installment
  const b = bus("2026-06-03T12:00:00.000Z");
  await b.run(TOOL, AGENT, { loan_id: LOAN, op: "open", dmdc_status: "Y", origination_on: "2024-03-01", service_begin_on: "2026-03-15", verified_on: "2026-06-03", orders_document_id: "doc-orders-1" });
  await b.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1" }, "2026-09-10T14:00:00.000Z"); await b.scra("rate_activate", {});
  await b.run(TOOL, AGENT, { loan_id: LOAN, op: "close", service_end_on: "2027-06-01", orders_document_id: "doc-release-1" }, "2027-06-03T12:00:00.000Z");
  b.armed("SCRA_3937A1_CAP_TAIL_1Y", "2028-06-01"); assert.equal(b.rt.store.get("scra_rate_periods", `srp-${LOAN}`)!.data.cap_ends_on, "2028-06-01");
  await assert.rejects(b.scra("restore", {}, "2028-05-31T12:00:00.000Z"), rangeError(/blocked through cap_ends_on 2028-06-01/)); await assert.rejects(b.scra("restore", {}, "2028-06-01T12:00:00.000Z"), rangeError(/blocked through cap_ends_on 2028-06-01/));
  const restored = await b.scra("restore", {}, "2028-06-02T12:00:00.000Z"); assert.equal(restored.restoration_due, "2028-07-01"); b.satisfied("SCRA_3937A1_CAP_TAIL_1Y", "scra.rate_reduction.ended");
  const leap = bus("2026-06-03T12:00:00.000Z", "L-139-leap");
  await leap.run(TOOL, AGENT, { loan_id: "L-139-leap", op: "open", dmdc_status: "Y", origination_on: "2024-03-01", service_begin_on: "2026-03-15", verified_on: "2026-06-03", orders_document_id: "doc-orders-1" });
  await leap.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1" }, "2026-09-10T14:00:00.000Z"); await leap.scra("rate_activate", {});
  await leap.run(TOOL, AGENT, { loan_id: "L-139-leap", op: "close", service_end_on: "2028-02-29", orders_document_id: "doc-release-1" }, "2028-03-01T12:00:00.000Z");
  leap.armed("SCRA_3937A1_CAP_TAIL_1Y", "2029-02-28"); assert.equal(leap.rt.store.get("scra_rate_periods", "srp-L-139-leap")!.data.restoration_due, "2029-03-01");
});

test("13.9 timers on the bus: SM_SCRA_RATE_ACTIVATE_5BD, FNMA_D23401_RATE_CONFIRMATION_LETTER_5BD, FNMA_F119_SUBSIDY_ADJUST_12M (recurring), FNMA_F119_MI_DISBURSEMENT_CHECK_M2 (recurring) and SCRA_3937_FEES_IN_CAP_GATE arm on the events the tools append and are satisfied by the events the responding ops append", async () => {
  const b = bus("2026-06-03T12:00:00.000Z", LOAN, { pool_type: "mbs" });
  b.put("custodial_accounts", "cust-mi-1", { purpose: "military_indulgence", bank: "designated" });
  await b.run(TOOL, AGENT, { loan_id: LOAN, op: "open", dmdc_status: "Y", origination_on: "2024-03-01", service_begin_on: "2026-03-15", verified_on: "2026-06-03", orders_document_id: "doc-orders-1" });
  // 13.8's scra.period.started arms the fee gate (evaluator-backed) and the monthly custodial disbursement check
  const gate = b.inst("SCRA_3937_FEES_IN_CAP_GATE").at(-1)!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:13.9.feesInsideCap");
  b.armed("FNMA_F119_MI_DISBURSEMENT_CHECK_M2", "2026-07-03");
  // the written notice with orders on Sept. 10 (Thu) → activation due +5 servicer business days = Sept. 17
  const req = await b.scra("rate_request", { received_on: "2026-09-10", channel: "mail", orders_document_id: "doc-orders-1" }, "2026-09-10T14:00:00.000Z");
  assert.equal(req.basis, "orders"); const activate = b.armed("SM_SCRA_RATE_ACTIVATE_5BD", "2026-09-17"); assert.equal(activate.anchorDate, "2026-09-10");
  const act = await b.scra("rate_activate", {}, "2026-09-10T15:00:00.000Z");
  b.satisfied("SM_SCRA_RATE_ACTIVATE_5BD", "scra.rate_reduction.applied");
  // D2-3.4-01 written correspondence: armed on activation (+5 BD = Sept. 17) and satisfied by the letter the same handler sends
  assert.equal(b.inst("FNMA_D23401_RATE_CONFIRMATION_LETTER_5BD").at(-1)!.dueDate, "2026-09-17"); const letter = b.satisfied("FNMA_D23401_RATE_CONFIRMATION_LETTER_5BD", "notice.sent");
  const sent = b.events.all().find((e) => e.id === letter.satisfiedByEventId)!; assert.equal(sent.payload.template, "NTC_SCRA_3937_RATE_CONFIRMATION"); assert.equal(sent.payload.new_payment_cents, cents("1741.73")); assert.equal(sent.payload.sum_cents, cents("1741.73")); assert.equal(sent.payload.principal_cents, cents("278.70")); assert.equal(sent.payload.interest_cents, cents("1463.03"));
  assert.deepEqual(act.timers, ["SM_SCRA_RATE_ACTIVATE_5BD", "FNMA_D23401_RATE_CONFIRMATION_LETTER_5BD", "FNMA_F119_MBS_UPLOAD_CD15", "FNMA_F119_SUBSIDY_ADJUST_12M", "SM_SCRA_OVERPAYMENT_ELECTION_30"]);
  assert.ok(b.types().includes("scra.relief.started"), "the §3919 umbrella for 8.x"); assert.equal(b.last("scra.relief.started").payload.kind, "interest_rate_cap"); assert.equal(b.last("delinquency.status_code.queued").payload.reason_code, "014");
  // the subsidy method re-adjusts at least annually: armed on scra.subsidy.activated (2027-09-10), satisfied by scra.subsidy.recalculated and re-armed
  const annual = b.armed("FNMA_F119_SUBSIDY_ADJUST_12M", "2027-09-10"); assert.equal(annual.anchorDate, "2026-09-10");
  b.put("loans", LOAN, { next_due_on: "2027-10-01" });
  const re = await b.scra("subsidy_recalc", {}, "2027-09-10T12:00:00.000Z");
  assert.equal(re.new_payment_cents, re.principal_cents as bigint + (re.interest_cents as bigint)); assert.equal(re.next_adjust_on, "2028-09-10");
  b.satisfied("FNMA_F119_SUBSIDY_ADJUST_12M", "scra.subsidy.recalculated"); assert.equal(b.inst("FNMA_F119_SUBSIDY_ADJUST_12M").at(-1)!.status, "armed", "recurring: re-armed"); assert.equal(b.inst("FNMA_F119_SUBSIDY_ADJUST_12M").at(-1)!.dueDate, "2028-09-10");
  assert.equal(b.last("notice.sent").payload.kind, "annual_readjustment");
  // the designated custodial account receives the month's differential ($304.80 for Sept. 2026): matched → Dr custodial_mi_cash / Cr fnma_military_indulgence_receivable, the monthly check satisfied and re-armed
  const ok = await b.scra("custodial_receipt", { receipt_id: "cust-rcpt-2026-09", month: "2026-09", amount_cents: 30_480n, received_on: "2026-09-28" }, "2026-09-28T12:00:00.000Z");
  assert.equal(ok.matched, true); assert.equal(ok.expected_cents, cents("304.80")); assert.equal(ok.officer_informed, false); assert.equal(ok.escalation_id, null);
  assert.deepEqual(lines(b, String(ok.ledger_set_id)), [{ account: "custodial_mi_cash", amount: 30_480n }, { account: "fnma_military_indulgence_receivable", amount: -30_480n }]);
  b.satisfied("FNMA_F119_MI_DISBURSEMENT_CHECK_M2", "custodial.receipt.matched"); assert.equal(b.last("custodial.receipt.matched").payload.kind, "scra_subsidy"); assert.equal(b.inst("FNMA_F119_MI_DISBURSEMENT_CHECK_M2").at(-1)!.status, "armed", "recurring: re-armed");
  // a short disbursement is a 6.x reconciliation exception with no borrower impact; the officer is informed once the aggregate shortfall passes $10,000
  const short = await b.scra("custodial_receipt", { receipt_id: "cust-rcpt-2026-10", month: "2026-10", amount_cents: 10_000n, received_on: "2026-10-29" }, "2026-10-29T12:00:00.000Z");
  assert.equal(short.matched, false); assert.equal(short.shortfall_cents, (short.expected_cents as bigint) - 10_000n); assert.ok(short.escalation_id); assert.equal(short.officer_informed, false); assert.equal(b.last("custodial.receipt.exception").payload.kind, "scra_subsidy");
  await assert.rejects(b.scra("custodial_receipt", { receipt_id: "cust-rcpt-2026-09-dup", month: "2026-09", amount_cents: 30_480n }), rangeError(/already matched/));
  const big = await b.scra("custodial_receipt", { receipt_id: "cust-rcpt-2026-11", month: "2026-11", amount_cents: 0n, received_on: "2026-11-27" }, "2026-11-27T12:00:00.000Z");
  assert.equal(big.officer_informed, (big.aggregate_shortfall_cents as bigint) > 1_000_000n);
  // the read op lists the period with its open timers
  const period = await b.scra<Row & { timers: { code: string }[] }>("rate_period", {});
  assert.equal(period.status, "active"); assert.ok(period.timers.some((t) => t.code === "FNMA_F119_MI_DISBURSEMENT_CHECK_M2")); assert.ok(period.timers.some((t) => t.code === "FNMA_F119_MBS_UPLOAD_CD15"));
  // guardrails carried by the shared tool still bind the 13.9 ops
  await assert.rejects(b.scra("rate_activate", { court_relief_request: true }), refused("NO_COURT_RELIEF_REQUEST"));
});

test("13.9 worked figures: P&I $2,046.53; UPB after #24 $293,975.18; forgiven $1,528.30; UPB after #29 $292,606.60; new payment $278.70 + $1,463.03 = $1,741.73 (standard $1,810.42); differential $1,767.83 − $1,463.03 = $304.80; MBS pool interest $1,645.91; shortfall $213.43", () => {
  const upb24 = balanceAfter(30000000n, "7.25", 360, 24); assert.equal(upb24, 29397518n);
  const r = recalculate({ upb_cents: upb24, note_rate_pct: "7.25", pi_cents: 204653n, first_capped_due: D("2026-04-01"), first_n: 25, paid_at_note_rate_count: 5, remaining_term_after: 331 });
  assert.equal(r.forgiven_total_cents, 152830n); assert.equal(r.upb_after_cents, 29260660n); assert.equal(r.next_interest_capped_cents, 146303n); assert.equal(r.next_interest_note_cents, 176783n);
  assert.equal(r.next_payment_subsidy_cents - r.next_interest_capped_cents, 27870n); assert.equal(r.next_payment_subsidy_cents, 174173n); assert.equal(r.next_payment_standard_cents, 181042n); assert.equal(r.fnma_differential_cents, 30480n);
  assert.equal((29260660n * 675n + 60000n) / 120000n, 164591n); assert.equal(servicingFee(r.upb_after_cents, "0.25"), 6096n); assert.equal(174173n - 152830n, 21343n);
});
