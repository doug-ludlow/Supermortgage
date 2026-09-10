// 6.5 Unidentified/unapplied funds management
// spec/sections/06-custodial-account-management/6-5-unidentified-unapplied-funds-management.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { SECTION_06_TOOLS } from "../../app/tools/section06.ts";
import { TOOLS_6_5 } from "../../app/tools/section6-5.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { NoticeRegistry } from "../../notices/registry.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist, publishCheck } from "../../notices/checklist.ts";
import { publishSection06, registerSection06, SECTION_06_VERSIONS, SECTION_06_NOTICE_CODES } from "../../notices/authored/section06.ts";
import { identify, escheat, writeOffAllowed, researchDeadlines, refundDeadlines, suspenseWriteOff, unidentifiedReceiptTrack, isSuspenseTerminal } from "./suspense.ts";
import { partialAccumulation, partialReturnSweep, fiftyDollarRule, applyOnAccumulation, suspenseAging, aiOutreachContact } from "./ops.ts";
import { weeklyRegisterTick, reviewSuspenseRegister, sendDueDiligenceNotice, reportUnclaimedProperty, WEEKLY_REGISTER_JOB } from "./ops-6-5.ts";

const RECON: Actor = { kind: "agent", id: "custodial-recon" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
function uow(nowIso = "2026-10-03T14:00:00.000Z", processes = ["6.5"]): UowContext & { decisions: DecisionInput[]; clock: FixedClock } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  return { loanId: "L-1", events, ledger: new MemoryLedger(), timers: new TimerEngine(loadOverriddenRegistry(), events, { processes }), clock, decide: (d) => { decisions.push({ loanId: "L-1", ...d }); }, decisions };
}
function bus(ctx: UowContext) { const agents = new AgentRegistry(); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; const cmds = bindTools(rt, agents, [...SECTION_06_TOOLS, ...TOOLS_6_5]); return { bus: new CommandBus(agents), cmds, rt }; }
const tool = (b: ReturnType<typeof bus>, name: string) => b.cmds.get(toolKey("6.5", name))!;

test("6.5-T1: Given P = $1,842.17, receipts $1,500.00 (10/03) and $342.17 (10/20) with conditions met, then one payment is applied `credited_as_of` 2026-10-20, suspense = $0.00, both notices/statement lines produced; timer `FNMA_C1102_PARTIAL_BALANCE_30` satisfied.", async () => {
  const r = partialAccumulation({ periodic_payment_cents: 184217n, receipts: [{ on: D("2026-10-03"), amount_cents: 150000n, rail: "ach_credit", originating_account_last4: "8831" }, { on: D("2026-10-20"), amount_cents: 34217n, rail: "ach_credit", originating_account_last4: "8831" }], conditions_met: true });
  assert.equal(r.applied, true); assert.equal(r.credited_as_of, "2026-10-20"); assert.equal(r.suspense_cents, 0n); assert.equal(r.partial_commitment_due_on, "2026-11-02"); assert.equal(r.action, "apply");
  assert.deepEqual(r.statement_lines, [{ on: "2026-10-03", held_cents: 150000n }, { on: "2026-10-20", held_cents: 0n }]);
  assert.deepEqual(r.notices, [{ template: "SUSP-PARTIAL-HOLD-v1", on: "2026-10-03", amount_cents: 150000n, balance_due_cents: 34217n, commitment_due_on: "2026-11-02" }], "the held receipt gets the registry's hold notice; the completing receipt is disclosed on the statement");
  assert.equal(r.timer_satisfied, "FNMA_C1102_PARTIAL_BALANCE_30"); assert.equal(r.satisfied_by, "suspense.accumulation.sufficient");
  // the hold notice renders from the registry template with the amount, balance due and 30-day date
  const reg = new NoticeRegistry(); publishSection06(reg); const v = reg.activeVersion("SUSP-PARTIAL-HOLD-v1", D("2026-10-03"))!;
  const payload = { ...v.samplePayload, received_on: r.notices[0]!.on, amount_cents: r.notices[0]!.amount_cents, balance_due_cents: r.notices[0]!.balance_due_cents, commitment_due_on: r.notices[0]!.commitment_due_on, commitment_days: daysBetween(D("2026-10-03"), r.partial_commitment_due_on!) };
  const rendered = render(v.source, payload); assert.match(rendered.text, /we received \$1,500\.00 toward your monthly payment of \$1,842\.17 .* The balance needed to complete the payment is \$342\.17\. If we receive the balance by November 2, 2026/); assert.equal(evaluateChecklist(v, payload, rendered).passed, true);
  // on the bus: the register write arms FNMA_C1102_PARTIAL_BALANCE_30 (30 days from 10/03) and the accumulation satisfies it; the item closes `applied`
  const ctx = uow(); const b = bus(ctx);
  await b.bus.execute(tool(b, "suspense.read/write"), RECON, { op: "write", id: "S-1", data: { loan_id: "L-1", status: "open", reason_code: "partial_payment", source: "ach", amount_cents: 150000n, received_on: "2026-10-03", partial_commitment_due_on: "2026-11-02" } }, ctx);
  const t = ctx.timers.byCode("FNMA_C1102_PARTIAL_BALANCE_30")[0]!; assert.equal(t.dueDate, "2026-11-02"); assert.equal(ctx.timers.byCode("SM_SUSPENSE_TRIAGE_1BD")[0]!.dueDate, "2026-10-05");
  ctx.clock.set("2026-10-20T16:00:00.000Z");
  await b.bus.execute(tool(b, "ledger.apply_via_cashiering"), RECON, { loan_id: "L-1", amount_cents: 184217n, suspense_item_id: "S-1", held_cents: 184217n, periodic_payment_cents: 184217n, credited_as_of: "2026-10-20", confidence: 1 }, ctx);
  assert.equal(t.status, "satisfied"); assert.equal(ctx.timers.byCode("SM_SUSPENSE_TRIAGE_1BD")[0]!.status, "satisfied");
  assert.equal(b.rt.store.get("suspense_items", "S-1")!.data.status, "applied"); assert.equal(b.rt.store.get("suspense_items", "S-1")!.data.credited_as_of, "2026-10-20");
  assert.deepEqual(ctx.events.all().filter((e) => e.type.startsWith("suspense.item.")).map((e) => e.type), ["suspense.item.written", "suspense.item.created", "suspense.item.status_changed", "suspense.item.matched", "suspense.item.closed"]);
});
test("6.5-T2: Given the same first receipt and nothing by 2026-11-02, then on 2026-11-03 the $1,500.00 is returned by ACH to the originating account, `SUSP-PARTIAL-RETURN-v1` sent, status `returned`.", async () => {
  const base = { received_on: D("2026-10-03"), amount_cents: 150000n, rail: "ach_credit" as const, originating_account_last4: "8831", held_cents: 150000n, periodic_payment_cents: 184217n, active_lossmit_case: false };
  assert.equal(partialReturnSweep({ ...base, today: D("2026-11-02") }).status, "open");
  const r = partialReturnSweep({ ...base, today: D("2026-11-03") });
  assert.equal(r.due_on, "2026-11-02"); assert.equal(r.returned, true); assert.equal(r.returned_on, "2026-11-03"); assert.equal(r.rail, "ach_credit"); assert.match(r.destination!, /8831/); assert.equal(r.notice, "SUSP-PARTIAL-RETURN-v1"); assert.equal(r.status, "returned");
  assert.equal(partialReturnSweep({ ...base, today: D("2026-11-03"), active_lossmit_case: true }).status, "lossmit_hold");
  // the return rail moves the register item to `returned` (terminal) and closes the aging timer; a destination that is not the verified originator is refused
  const ctx = uow(); const b = bus(ctx);
  await b.bus.execute(tool(b, "suspense.read/write"), RECON, { op: "write", id: "S-2", data: { loan_id: "L-1", status: "open", reason_code: "partial_payment", amount_cents: 150000n, received_on: "2026-10-03" } }, ctx);
  ctx.clock.set("2026-11-03T14:00:00.000Z");
  await assert.rejects(b.bus.execute(tool(b, "nacha.originate_credit"), RECON, { amount_cents: 150000n, destination_last4: "9999", suspense_item_id: "S-2" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "RETURN_TO_ORIGINATOR_ONLY");
  await b.bus.execute(tool(b, "nacha.originate_credit"), RECON, { amount_cents: 150000n, destination_last4: "8831", destination_is_verified_originator: true, destination_is_borrower: true, suspense_item_id: "S-2", notice: "SUSP-PARTIAL-RETURN-v1" }, ctx);
  assert.equal(b.rt.store.get("suspense_items", "S-2")!.data.status, "returned"); assert.equal(b.rt.store.list("suspense_actions").filter((a) => a.data.action === "return_initiated").length, 1);
  assert.equal(ctx.timers.byCode("SM_SUSPENSE_AGE_90_ESCALATE")[0]!.status, "satisfied", "a terminal status closes the 90-day escalation timer");
  assert.equal(ctx.events.ofType("suspense.item.closed")[0]!.payload.status, "returned");
});
test("6.5-T3: Given a payment $1,800.00 vs P $1,842.17 (deficiency $42.17), instrument dated 2005, `partial_count_12m = 2`, then the $50 rule applies (escrow reduced by $42.17, payment applied as of receipt) and the count becomes 3; a fourth such payment within 12 months is treated as an ordinary partial.", () => {
  const r = fiftyDollarRule({ amount_cents: 180000n, periodic_payment_cents: 184217n, instrument_date: D("2005-06-01"), partial_count_12m: 2, received_on: D("2026-10-05") });
  assert.equal(r.applies, true); assert.equal(r.deficiency_cents, 4217n); assert.equal(r.escrow_reduction_cents, 4217n); assert.equal(r.credited_as_of, "2026-10-05"); assert.equal(r.partial_count_12m_after, 3); assert.equal(r.treatment, "fifty_dollar_rule");
  const fourth = fiftyDollarRule({ amount_cents: 180000n, periodic_payment_cents: 184217n, instrument_date: D("2005-06-01"), partial_count_12m: 3, received_on: D("2026-11-05") });
  assert.equal(fourth.applies, false); assert.equal(fourth.treatment, "ordinary_partial"); assert.equal(fourth.escrow_reduction_cents, 0n);
  assert.equal(fiftyDollarRule({ amount_cents: 180000n, periodic_payment_cents: 184217n, instrument_date: D("1998-06-01"), partial_count_12m: 0, received_on: D("2026-10-05") }).applies, false);
});
test('6.5-T4: Given the "J SMITH" $1,250.00 ACH credit with a 0.99 unique candidate, then auto-applied same day; given two candidates at 0.85/0.83, then `contact_pending` and no application.', async () => {
  const cands = [{ loan_id: "4471", borrower_names: ["John Smith"], ach_last4: "8831", periodic_payment_cents: 125_000n }, { loan_id: "9001", borrower_names: ["Jane Smith"], periodic_payment_cents: 99_000n }, { loan_id: "9002", borrower_names: ["J Smithers"], periodic_payment_cents: 140_000n }];
  const r = identify({ amount_cents: 125_000n, memo: "J SMITH", payer_name: "J SMITH", ach_last4: "8831" }, cands);
  assert.equal(r.decision, "auto_apply"); assert.equal(r.loan_id, "4471"); assert.ok(r.scores[0]!.score >= 0.97); assert.ok(r.scores[1]!.score < 0.8);
  const two = identify({ amount_cents: 99_000n, payer_name: "J Smith" }, [{ loan_id: "a", borrower_names: ["J Smith"], periodic_payment_cents: 99_000n, ach_last4: "1111" }, { loan_id: "b", borrower_names: ["J Smith"], periodic_payment_cents: 99_000n }]);
  assert.equal(two.decision, "contact_pending"); assert.equal(two.loan_id, null); assert.ok(two.scores.every((s) => s.score < 0.97 && s.score >= 0.6));
  // on the bus: the same-day application to loan 4471 needs a ≥ 0.97 confidence (or the borrower's confirmation) — a lower or omitted confidence is refused
  const ctx = uow("2026-10-07T18:00:00.000Z"); const b = bus(ctx);
  await assert.rejects(b.bus.execute(tool(b, "ledger.apply_via_cashiering"), RECON, { loan_id: "a", amount_cents: 99_000n, confidence: 0.85 }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "APPLY_CONFIDENCE_097");
  await assert.rejects(b.bus.execute(tool(b, "ledger.apply_via_cashiering"), RECON, { loan_id: "a", amount_cents: 99_000n }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "APPLY_CONFIDENCE_097", "omitting the confidence does not bypass the rule");
  await b.bus.execute(tool(b, "ledger.apply_via_cashiering"), RECON, { loan_id: "a", amount_cents: 99_000n, confidence: 0.85, borrower_confirmed: true }, ctx);
  const ok = await b.bus.execute(tool(b, "ledger.apply_via_cashiering"), RECON, { loan_id: "4471", amount_cents: 125_000n, confidence: r.scores[0]!.score, credited_as_of: "2026-10-07" }, ctx);
  assert.equal((ok.output as { payload: { credited_as_of: string } }).payload.credited_as_of, "2026-10-07");
});
test("6.5-T5: Given an unidentified check receipt on 10/07 with remitter address on the image and no match by 11/06 (30 days), then a refund check to the remitter is issued by 12/06 (60 days) at the latest; given no remitter data, then `escheat_pending` with `dormancy_start_on` = 10/07.", async () => {
  assert.deepEqual(researchDeadlines(D("2026-10-07")), { research_by: "2026-11-06", return_by: "2026-12-06" });
  const known = unidentifiedReceiptTrack({ received_on: D("2026-10-07"), matched_on: null, remitter_known: true, rail: "check", today: D("2026-11-07") });
  assert.equal(known.status, "returned"); assert.equal(known.return_rail, "refund_check_to_remitter_address"); assert.equal(known.return_by, "2026-12-06"); assert.equal(known.research_by, "2026-11-06");
  assert.equal(unidentifiedReceiptTrack({ received_on: D("2026-10-07"), matched_on: null, remitter_known: true, rail: "check", today: D("2026-11-06") }).status, "researching");
  const unknown = unidentifiedReceiptTrack({ received_on: D("2026-10-07"), matched_on: null, remitter_known: false, rail: "check", today: D("2026-11-07") });
  assert.equal(unknown.status, "escheat_pending"); assert.equal(unknown.dormancy_start_on, "2026-10-07"); assert.equal(unknown.unclaimed_property_item, true);
  // the register: SM_UNIDENTIFIED_RESEARCH_30 (11/06) and SM_UNIDENTIFIED_RETURN_60 (12/06) arm on the unidentified item; the refund check issued to the verified remitter satisfies both
  const ctx = uow("2026-10-07T18:00:00.000Z"); const b = bus(ctx);
  await b.bus.execute(tool(b, "suspense.read/write"), RECON, { op: "write", id: "S-5", data: { status: "open", reason_code: "unidentified_payer", source: "lockbox", amount_cents: 125_000n, received_on: "2026-10-07", payer_name: "J. Smith" } }, ctx);
  const research = ctx.timers.byCode("SM_UNIDENTIFIED_RESEARCH_30")[0]!, ret = ctx.timers.byCode("SM_UNIDENTIFIED_RETURN_60")[0]!;
  assert.equal(research.dueDate, "2026-11-06"); assert.equal(ret.dueDate, "2026-12-06"); assert.equal(ctx.timers.byCode("FNMA_C1102_PARTIAL_BALANCE_30").length, 0, "not a partial");
  await b.bus.execute(tool(b, "suspense.read/write"), RECON, { op: "write", id: "S-5", data: { status: "researching" } }, ctx);
  assert.equal(ctx.timers.byCode("SM_SUSPENSE_TRIAGE_1BD")[0]!.status, "satisfied"); assert.equal(research.status, "armed");
  ctx.clock.set("2026-11-20T18:00:00.000Z");
  await assert.rejects(b.bus.execute(tool(b, "check.issue"), RECON, { amount_cents: 125_000n, payee: "Somebody Else", suspense_item_id: "S-5" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "REMITTER_ONLY");
  await b.bus.execute(tool(b, "check.issue"), RECON, { amount_cents: 125_000n, payee: "J. Smith, address on the image", payee_is_verified_remitter: true, suspense_item_id: "S-5", notice: "SUSP-UNIDENTIFIED-RETURN-v1" }, ctx);
  assert.equal(research.status, "satisfied"); assert.equal(ret.status, "satisfied"); assert.equal(b.rt.store.get("suspense_items", "S-5")!.data.status, "returned");
  // no remitter data: the item goes `escheat_pending` and the unclaimed-property row opens with dormancy_start_on = received_on (10/07); STATE_UUPA_DORMANCY_3Y arms on it → 2029-10-07
  await b.bus.execute(tool(b, "suspense.read/write"), RECON, { op: "write", id: "S-5b", data: { status: "open", reason_code: "unidentified_payer", source: "lockbox", amount_cents: 125_000n, received_on: "2026-10-07" } }, ctx);
  await b.bus.execute(tool(b, "suspense.read/write"), RECON, { op: "write", id: "S-5b", data: { status: "escheat_pending", reason_code: "unidentified_payer", source: "lockbox", amount_cents: 125_000n, received_on: "2026-10-07", dormancy_start_on: unknown.dormancy_start_on } }, ctx);
  const up = await b.bus.execute(tool(b, "unclaimed_property.compute"), RECON, { op: "open", suspense_item_id: "S-5b", state: "TX", amount_cents: 125_000n, dormancy_start_on: unknown.dormancy_start_on! }, ctx);
  assert.equal((up.output as { presumed_abandoned_on: string; owner_known: boolean }).presumed_abandoned_on, "2029-10-07"); assert.equal((up.output as { owner_known: boolean }).owner_known, false);
  const dormancy = ctx.timers.byCode("STATE_UUPA_DORMANCY_3Y")[0]!; assert.equal(dormancy.dueDate, "2029-10-07"); assert.deepEqual(dormancy.subject, { kind: "unclaimed_property_item", id: "up-S-5b" });
});
test("6.5-T6: Given Σ unapplied on a loan reaches P on a Friday, then the application is posted with `credited_as_of` Friday even if the job runs Monday (Reg Z), and the `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD` timer is satisfied.", () => {
  const r = applyOnAccumulation({ accumulated_on: D("2026-10-16"), job_run_on: D("2026-10-19"), periodic_payment_cents: 184217n, held_cents: 184217n });
  assert.equal(r.apply, true); assert.equal(r.credited_as_of, "2026-10-16"); assert.equal(r.due_on, "2026-10-19"); assert.equal(r.on_time, true);
  assert.equal(r.timer, "REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD"); assert.equal(r.satisfied_by, "payment.applied{credited_as_of=2026-10-16}");
  assert.equal(applyOnAccumulation({ accumulated_on: D("2026-10-16"), job_run_on: D("2026-10-19"), periodic_payment_cents: 184217n, held_cents: 150000n }).apply, false);
  const ctx = uow("2026-10-16T21:00:00.000Z", ["6.5", "2.5"]);   // the registry row is owned by 2.5's table (cross-referenced from 6.5)
  ctx.events.append({ type: "suspense.accumulation.sufficient", loanId: "L-1", actor: SYSTEM, payload: { accumulated_on: "2026-10-16" } });
  const t = ctx.timers.byCode("REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD")[0]!; assert.equal(t.dueDate, "2026-10-19");
  // 2.1's CashieringService posts the application as `payment.posted{outcome=applied, credited_as_of}` (the row is 2.5's; the spec's `payment.applied` is that outcome)
  ctx.events.append({ type: "payment.posted", loanId: "L-1", aggregate: { kind: "payment", id: "P-1016" }, actor: { kind: "agent", id: "cashiering" }, occurredAt: "2026-10-19T14:00:00.000Z", payload: { payment_id: "P-1016", outcome: "applied", credited_as_of: r.credited_as_of, received_on: "2026-10-16", channel: "suspense_accumulation" } });
  assert.equal(t.status, "satisfied"); assert.equal(ctx.events.ofType("payment.posted")[0]!.payload.credited_as_of, "2026-10-16", "credited Friday although posted Monday (Reg Z §1026.36(c)(1)(ii)(B))");
});
test("6.5-T7: Given a stale refund check (issued 2026-03-01, Texas), then dormancy 2029-03-01, cycle FY2029, report due before 2029-11-01, due-diligence window 2029-05-05 to 2029-09-02, officer verification task created 2029-09-15 (policy lead), NAUPA II file generated.", async () => {
  const e = escheat(D("2026-03-01"), "TX");
  assert.deepEqual([e.presumed_abandoned_on, e.cycle, e.report_due_on, e.due_diligence_window, e.officer_verification_on], ["2029-03-01", "FY2029", "2029-11-01", ["2029-05-05", "2029-09-02"], "2029-09-15"]);
  // the stale check (issued 2026-03-01, stale 2026-08-28, voided by 6.4) opens the unclaimed-property row: STATE_UUPA_DORMANCY_3Y arms on dormancy_start_on → 2029-03-01
  const ctx = uow("2026-08-28T14:00:00.000Z"); const b = bus(ctx); const up = tool(b, "unclaimed_property.compute"), timers = tool(b, "timer.*");
  const opened = await b.bus.execute(up, RECON, { op: "open", outstanding_check_id: "chk-1001", state: "TX", amount_cents: 21_455n, dormancy_start_on: "2026-03-01", owner_name: "Texas Borrower", owner_last_address: "1 Main St, Austin TX" }, ctx);
  const o = opened.output as { id: string; dormancy_years: number; presumed_abandoned_on: string; cycle: string; report_due_on: string; due_diligence_window: [string, string]; officer_verification_on: string };
  assert.deepEqual([o.id, o.dormancy_years, o.presumed_abandoned_on, o.cycle, o.report_due_on, o.due_diligence_window, o.officer_verification_on], ["up-chk-1001", 3, "2029-03-01", "FY2029", "2029-11-01", ["2029-05-05", "2029-09-02"], "2029-09-15"]);
  const dormancy = ctx.timers.byCode("STATE_UUPA_DORMANCY_3Y")[0]!; assert.equal(dormancy.dueDate, "2029-03-01"); assert.equal(dormancy.status, "armed");
  // the per-state cycle sweep: a day early nothing is presumed; on 2029-03-01 the item is presumed abandoned → the due-diligence window (anchor: the 2029-11-01 filing) and the Nov 1 report deadline (anchor: cycle end 2029-06-30) arm
  ctx.clock.set("2029-02-28T06:00:00.000Z");
  assert.deepEqual((await b.bus.execute(timers, RECON, { op: "cycle_sweep", date: "2029-02-28" }, ctx)).output, { today: "2029-02-28", presumed: [], officer_tasks: [], tick: ctx.events.ofType("schedule.tick")[0] });
  assert.equal(ctx.timers.byCode("STATE_UUPA_DUE_DILIGENCE_NOTICE_60_180").length, 0);
  ctx.clock.set("2029-03-01T06:00:00.000Z");
  const sweep = (await b.bus.execute(timers, RECON, { op: "cycle_sweep", date: "2029-03-01" }, ctx)).output as { presumed: string[]; officer_tasks: string[] };
  assert.deepEqual([sweep.presumed, sweep.officer_tasks], [["up-chk-1001"], []]);
  const pa = ctx.events.ofType("unclaimed_property.presumed_abandoned")[0]!; assert.equal(pa.payload.cycle_end_on, "2029-06-30"); assert.equal(pa.payload.filing_date, "2029-11-01"); assert.equal(pa.payload.due_diligence_required, true);
  const dd = ctx.timers.byCode("STATE_UUPA_DUE_DILIGENCE_NOTICE_60_180")[0]!; assert.equal(dd.dueDate, "2029-09-02"); assert.equal(dd.note, "window opens 2029-05-05");
  const report = ctx.timers.byCode("STATE_UUPA_REPORT_NOV1")[0]!; assert.equal(report.dueDate, "2029-11-01");
  // RUUPA §501(a): the notice is refused outside the −180…−60 window and below $50; mailed first-class inside it, `notice.sent{template=UP-DUE-DILIGENCE-v1}` satisfies the window row
  ctx.clock.set("2029-05-04T14:00:00.000Z");
  await assert.rejects(b.bus.execute(up, RECON, { op: "due_diligence_notice", id: "up-chk-1001", sent_on: "2029-05-04" }, ctx), /outside the §501\(a\) window 2029-05-05…2029-09-02/);
  await assert.rejects(b.bus.execute(up, RECON, { op: "due_diligence_notice", id: "up-chk-1001", sent_on: "2029-06-01", channel: "email" }, ctx), /always mailed first-class/);
  ctx.clock.set("2029-06-01T14:00:00.000Z");
  const sent = (await b.bus.execute(up, RECON, { op: "due_diligence_notice", id: "up-chk-1001", sent_on: "2029-06-01" }, ctx)).output as { notice_id: string; contact_by: string; template: string };
  assert.deepEqual([sent.template, sent.contact_by], ["UP-DUE-DILIGENCE-v1", "2029-07-01"]); assert.equal(dd.status, "satisfied"); assert.equal(dd.satisfiedByEventId, ctx.events.ofType("notice.sent")[0]!.id);
  // the officer verification task is created on the policy lead date 2029-09-15 (filing − 47 days), not before
  ctx.clock.set("2029-09-14T06:00:00.000Z");
  assert.deepEqual(((await b.bus.execute(timers, RECON, { op: "cycle_sweep", date: "2029-09-14" }, ctx)).output as { officer_tasks: string[] }).officer_tasks, []);
  ctx.clock.set("2029-09-15T06:00:00.000Z");
  assert.deepEqual(((await b.bus.execute(timers, RECON, { op: "cycle_sweep", date: "2029-09-15" }, ctx)).output as { officer_tasks: string[] }).officer_tasks, ["up-chk-1001"]);
  const task = b.rt.escalations.opened.find((x) => x.kind === "officer" && x.payload.task === "unclaimed_property_verification")!;
  assert.equal(task.payload.created_on, "2029-09-15"); assert.equal(task.payload.verify_by, "2029-11-01"); assert.equal(task.severity, "high");
  assert.equal(b.rt.store.get("unclaimed_property_items", "up-chk-1001")!.data.officer_task_id, task.id);
  // the NAUPA II file is generated only with the officer's verification; the filing is a human act under it, and only with the remittance
  await assert.rejects(b.bus.execute(tool(b, "naupa.generate"), RECON, { state: "TX", cycle: "FY2029", items: [{ id: "up-chk-1001", amount_cents: 21_455n }] }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "OFFICER_VERIFICATION");
  const file = await b.bus.execute(tool(b, "naupa.generate"), OFFICER, { state: "TX", cycle: "FY2029", items: [{ id: "up-chk-1001", amount_cents: 21_455n }], officer_verification_id: "ver-2029-09-15" }, ctx);
  assert.deepEqual(file.output, { id: "TX-FY2029", state: "TX", cycle: "FY2029", item_count: 1, total_cents: 21_455n, officer_verification: "ver-2029-09-15" });
  ctx.clock.set("2029-10-15T14:00:00.000Z");
  const filing = { op: "report", state: "TX", cycle: "FY2029", file_id: "TX-FY2029", filed_on: "2029-10-15", item_ids: ["up-chk-1001"], remittance_cents: 21_455n, state_confirmation_ref: "TX-UP-2029-000123" };
  await assert.rejects(b.bus.execute(up, RECON, { ...filing, remitted: true }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "OFFICER_FILES");
  await assert.rejects(b.bus.execute(up, OFFICER, { ...filing, remitted: false }, ctx), /satisfied only with the remittance/);
  assert.deepEqual(ctx.timers.evaluate(ctx.clock.now()).map((x) => x.instance.code), ["STATE_UUPA_DORMANCY_3Y"], "at the filing date only the dormancy row (due 2029-03-01) has passed; the report row (2029-11-01) has not");
  assert.equal(report.status, "armed"); assert.equal(dormancy.status, "breached", "the dormancy row is a date computation (breach action: none) — it closes on the report");
  const filed = (await b.bus.execute(up, OFFICER, { ...filing, remitted: true }, ctx)).output as { report_id: string; item_count: number; remittance_cents: bigint };
  assert.deepEqual([filed.report_id, filed.item_count, filed.remittance_cents], ["TX-FY2029", 1, 21_455n]);
  assert.equal(report.status, "satisfied"); assert.equal(dormancy.status, "satisfied_late");
  assert.equal(b.rt.store.get("unclaimed_property_items", "up-chk-1001")!.data.status, "reported"); assert.equal(b.rt.store.get("unclaimed_property_reports", "TX-FY2029")!.data.verification_signed_by, "ver-2029-09-15");
  assert.equal(ctx.events.ofType("unclaimed_property.reported")[0]!.payload.remitted, true);
});
test("6.5-T8: Given an item aged 90 days in `researching`, then `officer` high escalation and the partner aging report line.", () => {
  const r = suspenseAging({ item_id: "S-77", loan_id: null, amount_cents: 125000n, status: "researching", received_on: D("2026-07-10"), today: D("2026-10-08") });
  assert.equal(r.aging_days, 90); assert.equal(r.terminal, false); assert.deepEqual(r.escalation, { role: "officer", severity: "high" }); assert.match(r.partner_report_line!, /S-77 .* researching .* 90 days/);
  assert.equal(suspenseAging({ item_id: "S-78", loan_id: "L-1", amount_cents: 1n, status: "applied", received_on: D("2026-07-10"), today: D("2026-10-08") }).escalation, null);
  assert.equal(suspenseAging({ item_id: "S-79", loan_id: null, amount_cents: 1n, status: "researching", received_on: D("2026-07-11"), today: D("2026-10-08") }).escalation, null);
  assert.ok(isSuspenseTerminal("written_off") && isSuspenseTerminal("escheated") && !isSuspenseTerminal("escheat_pending"));
});
test("6.5-T9: Given a borrower on an AI outreach call asks for a person, then warm transfer to `human_agent` and the contact record shows `mode = ai_voice`, disclosure given, transfer time.", () => {
  const c = aiOutreachContact({ utterance: "I want to talk to a real person about this", at: "2026-10-08T14:05:00-04:00", disclosure_given: true });
  assert.equal(c.mode, "ai_voice"); assert.equal(c.disclosure_given, true); assert.equal(c.human_transfer_requested, true); assert.equal(c.transfer_to, "human_agent"); assert.equal(c.transfer_time, "2026-10-08T14:05:00-04:00");
  assert.equal(aiOutreachContact({ utterance: "yes I sent the second half on Friday", at: "2026-10-08T14:06:00-04:00", disclosure_given: true }).transfer_to, null);
});
test("6.5-T10: Given a write-off attempt of $7.25, then rejected (limit $5.00) unless `officer` overrides with reason.", async () => {
  assert.equal(writeOffAllowed(725n, false), false); assert.equal(writeOffAllowed(725n, true), true);
  assert.match(suspenseWriteOff({ amount_cents: 725n, actor_is_officer: false, override_reason: "" }).refusal!, /officer act/);
  assert.match(suspenseWriteOff({ amount_cents: 725n, actor_is_officer: true, override_reason: "" }).refusal!, /rejected \(limit \$5\.00\)/);
  assert.deepEqual(suspenseWriteOff({ amount_cents: 725n, actor_is_officer: true, override_reason: "rounding residual after a duplicate refund" }), { allowed: true, refusal: null, limit_cents: 500n, officer_override: true });
  assert.equal(suspenseWriteOff({ amount_cents: 499n, actor_is_officer: true, override_reason: "" }).allowed, true);
  const ctx = uow(); const b = bus(ctx); const rw = tool(b, "suspense.read/write");
  const wo = (id: string, amount: bigint, reason?: string) => ({ op: "write", id, data: { status: "written_off", amount_cents: amount, loan_id: "L-1" }, ...(reason ? { reason } : {}) });
  await assert.rejects(b.bus.execute(rw, RECON, wo("S-9", 725n, "rounding"), ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_WRITE_OFF_OVER_500");
  await assert.rejects(b.bus.execute(rw, RECON, wo("S-9", 499n), ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_WRITE_OFF_OVER_500", "written_off is an officer act even under the limit");
  await assert.rejects(b.bus.execute(rw, OFFICER, wo("S-9", 725n), ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_WRITE_OFF_OVER_500", "the officer override needs a reason");
  assert.equal(b.rt.store.get("suspense_items", "S-9"), undefined, "refusals write nothing");
  await b.bus.execute(rw, OFFICER, wo("S-9", 725n, "rounding residual after a duplicate refund"), ctx);
  assert.equal(b.rt.store.get("suspense_items", "S-9")!.data.status, "written_off"); assert.equal(b.rt.store.list("suspense_actions").filter((a) => a.data.action === "written_off").length, 1);
  assert.equal(ctx.events.ofType("suspense.item.closed")[0]!.payload.status, "written_off");
  await b.bus.execute(rw, OFFICER, wo("S-10", 499n), ctx);
  assert.equal(b.rt.store.get("suspense_items", "S-10")!.data.status, "written_off");
});

test("6.5 notices: SUSP-PARTIAL-HOLD/RETURN, SUSP-UNIDENTIFIED-RETURN, SUSP-REFUND and UP-DUE-DILIGENCE (RUUPA §502(a) heading, first-class mail only, ≥ $50, −180…−60 days before filing, state variants) publish through the 7.1 gate", () => {
  const reg = new NoticeRegistry(); registerSection06(reg);
  assert.deepEqual(SECTION_06_NOTICE_CODES, ["CUST-DEP-INELIG-v1", "CUST-TI-INT-DISP-v1", "SUSP-PARTIAL-HOLD-v1", "SUSP-PARTIAL-RETURN-v1", "SUSP-UNIDENTIFIED-RETURN-v1", "SUSP-REFUND-v1", "UP-DUE-DILIGENCE-v1"]);
  for (const v of SECTION_06_VERSIONS) assert.deepEqual(publishCheck(reg.versionsOf(v.templateCode)[0]!), [], v.templateCode);
  publishSection06(reg);
  assert.equal(reg.template("UP-DUE-DILIGENCE-v1").channelPolicy, "mail_only"); assert.equal(reg.template("UP-DUE-DILIGENCE-v1").separateDocument, true); assert.equal(reg.template("SUSP-UNIDENTIFIED-RETURN-v1").channelPolicy, "mail_only"); assert.equal(reg.template("SUSP-PARTIAL-HOLD-v1").channelPolicy, "esign_or_mail");
  assert.equal(reg.bySection("6.5").length, 5);
  // worked example C through the template: TX refund check $214.55, notice mailed 2029-06-01 inside the window before the 2029-11-01 filing
  const e = escheat(D("2026-03-01"), "TX"); const v = reg.activeVersion("UP-DUE-DILIGENCE-v1", D("2029-06-01"))!;
  const noticeDate = D("2029-06-01"); const contactBy = addDays(noticeDate, 30);
  const payload = { ...v.samplePayload, notice_date: noticeDate, contact_by: contactBy, days_to_contact_by: 30, days_before_filing: daysBetween(noticeDate, e.report_due_on), amount_cents: 21_455n, dormancy_start_on: "2026-03-01" };
  assert.ok(noticeDate >= e.due_diligence_window[0] && noticeDate <= e.due_diligence_window[1]);
  const r = render(v.source, payload);
  assert.match(r.text, /may be transferred to the custody of the Texas Comptroller of Public Accounts, Unclaimed Property Division if you do not contact us before July 1, 2029/);
  assert.match(r.text, /in the amount of \$214\.55/); assert.match(r.text, /Sent by first-class mail/);
  assert.equal(evaluateChecklist(v, payload, r).passed, true);
  assert.deepEqual(evaluateChecklist(v, { ...payload, amount_cents: 4_999n }, render(v.source, { ...payload, amount_cents: 4_999n })).blocking.map((b) => b.rule_id), ["501a-threshold"]);
  assert.deepEqual(evaluateChecklist(v, { ...payload, days_before_filing: 30 }, r).blocking.map((b) => b.rule_id), ["501a-window"]);
  assert.deepEqual(evaluateChecklist(v, { ...payload, days_to_contact_by: 14 }, r).blocking.map((b) => b.rule_id), ["contact-by-30"]);
  const ny = { ...payload, state_name: "New York", state_administrator: "New York State Comptroller, Office of Unclaimed Funds", state_supplement_required: true };
  assert.deepEqual(evaluateChecklist(v, ny, render(v.source, ny)).blocking.map((b) => b.rule_id), ["state-variant"]);
  assert.equal(evaluateChecklist(v, { ...ny, state_supplement: "Under New York Abandoned Property Law §1422 you may also contact the Comptroller directly." }, render(v.source, { ...ny, state_supplement: "Under New York Abandoned Property Law §1422 you may also contact the Comptroller directly." })).passed, true);
  const ret = reg.activeVersion("SUSP-PARTIAL-RETURN-v1", D("2026-11-03"))!; assert.match(render(ret.source, ret.samplePayload).text, /The balance of \$342\.17 was not received by November 2, 2026, so on November 3, 2026 we returned \$1,500\.00 by ACH credit/);
  const refund = reg.activeVersion("SUSP-REFUND-v1", D("2026-10-09"))!; assert.match(render(refund.source, refund.samplePayload).text, /we received \$2,500\.00\. The amount due on your loan was \$1,842\.17\. The overpayment of \$657\.83/);
});

test("6.5 weekly register (SM_SUSPENSE_REGISTER_WEEKLY): the Monday 06:00 tick arms the recurring row; the reviewer run lists Section III (> 30 days), overdue research and the 90-day officer escalation, and `suspense.register.reviewed` satisfies and re-arms it", async () => {
  assert.throws(() => weeklyRegisterTick(D("2026-10-20")), /is not a Monday/);
  const tick = weeklyRegisterTick(D("2026-10-19")); assert.deepEqual(tick.payload, { cadence: "weekly", weekday: "monday", at: "06:00", tz: "servicer_local", job: WEEKLY_REGISTER_JOB, date: "2026-10-19" }); assert.equal(tick.occurredAt, "2026-10-19T10:00:00.000Z");
  const ctx = uow("2026-10-19T10:00:00.000Z"); const b = bus(ctx); const rw = tool(b, "suspense.read/write"), timers = tool(b, "timer.*");
  assert.equal(ctx.timers.byCode("SM_SUSPENSE_REGISTER_WEEKLY").length, 0);
  await b.bus.execute(timers, RECON, { op: "tick_weekly_register", date: "2026-10-19" }, ctx);
  const weekly = ctx.timers.byCode("SM_SUSPENSE_REGISTER_WEEKLY")[0]!; assert.equal(weekly.status, "armed"); assert.equal(weekly.dueDate, "2026-10-26"); assert.deepEqual(weekly.subject, { kind: "global", id: "*" });
  // the register: S-77 unidentified, researching 90 days (7/21 → 10/19); S-78 unidentified 39 days past research; S-79 a 4-day partial; S-80 applied (terminal, not listed)
  for (const [id, data] of [["S-77", { status: "researching", reason_code: "unidentified_payer", amount_cents: 125_000n, received_on: "2026-07-21" }], ["S-78", { status: "researching", reason_code: "unidentified_loan", amount_cents: 40_000n, received_on: "2026-09-10" }], ["S-79", { loan_id: "L-1", status: "open", reason_code: "partial_payment", amount_cents: 150_000n, received_on: "2026-10-15" }], ["S-80", { loan_id: "L-2", status: "applied", reason_code: "overpayment", amount_cents: 9_900n, received_on: "2026-06-01" }]] as const)
    await b.bus.execute(rw, RECON, { op: "write", id, data }, ctx);
  ctx.clock.set("2026-10-19T14:00:00.000Z");
  const r = (await b.bus.execute(timers, RECON, { op: "review_register", reviewer: "qc-audit" }, ctx)).output as ReturnType<typeof reviewSuspenseRegister>;
  assert.deepEqual([r.reviewed_on, r.week_of, r.open_count, r.total_open_cents], ["2026-10-19", "2026-10-19", 3, 315_000n]);
  assert.deepEqual(r.section_iii.map((l) => [l.id, l.aging_days]), [["S-77", 90], ["S-78", 39]]);
  assert.deepEqual(r.research_overdue.map((l) => l.id), ["S-77", "S-78"], "both unidentified items are past the 30-day research deadline without a match (the officer is notified in the register); S-79 is a 4-day partial");
  assert.equal(r.escalations.length, 1); assert.match(r.escalations[0]!.partner_report_line, /S-77 .* researching .* 90 days/);
  const esc = b.rt.escalations.opened.find((x) => x.id === r.escalations[0]!.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.severity, "high"); assert.equal(esc.payload.suspense_item_id, "S-77");
  assert.equal(weekly.status, "satisfied"); assert.equal(weekly.satisfiedByEventId, r.event.id); assert.equal(r.event.payload.officer_notified, true);
  const rearmed = ctx.timers.byCode("SM_SUSPENSE_REGISTER_WEEKLY")[1]!; assert.equal(rearmed.status, "armed"); assert.equal(rearmed.dueDate, "2026-10-26");
  assert.throws(() => reviewSuspenseRegister({ events: ctx.events, actor: RECON, now: ctx.clock.now() }, { items: [], reviewer: "" }), RangeError);
});

test("6.5 overpayment refund (SM_OVERPAYMENT_REFUND_10BD): the register write arms 10 business days from receipt; the ACH refund to the recorded originator closes the item `refunded` and satisfies it", async () => {
  const ctx = uow("2026-10-08T14:00:00.000Z"); const b = bus(ctx);
  await b.bus.execute(tool(b, "suspense.read/write"), RECON, { op: "write", id: "S-6", data: { loan_id: "L-1", status: "open", reason_code: "overpayment", source: "ach", amount_cents: 65_783n, received_on: "2026-10-08", payer_account_last4: "8831" } }, ctx);
  const t = ctx.timers.byCode("SM_OVERPAYMENT_REFUND_10BD")[0]!; assert.equal(t.dueDate, refundDeadlines(D("2026-10-08")).overpayment_by); assert.equal(t.dueDate, "2026-10-23", "10 servicer business days from Thu 10/08: Columbus Day 10/12 is observed");
  ctx.clock.set("2026-10-09T14:00:00.000Z");
  const out = (await b.bus.execute(tool(b, "nacha.originate_credit"), RECON, { amount_cents: 65_783n, destination_last4: "8831", destination_is_verified_originator: true, destination_is_borrower: true, suspense_item_id: "S-6", notice: "SUSP-REFUND-v1" }, ctx)).output as { suspense_item_status: string };
  assert.equal(out.suspense_item_status, "refunded"); assert.equal(b.rt.store.get("suspense_items", "S-6")!.data.status, "refunded");
  assert.equal(b.rt.store.list("suspense_actions").filter((a) => a.data.action === "refund_issued").length, 1);
  const closed = ctx.events.ofType("suspense.item.closed")[0]!; assert.equal(closed.payload.status, "refunded");
  assert.ok(eventMatches(loadOverriddenRegistry().unique().find((d) => d.code === "SM_OVERPAYMENT_REFUND_10BD")!.satisfiedPattern!, closed));
  assert.equal(t.status, "satisfied"); assert.equal(ctx.timers.byCode("SM_SUSPENSE_AGE_90_ESCALATE")[0]!.status, "satisfied");
});

test("6.5 guardrails on the register: a money field is officer-only however it is written; the return rails compare the destination with the item's recorded originator/remitter; contact needs consent and disclosure on file", async () => {
  const ctx = uow("2026-10-08T14:00:00.000Z"); const b = bus(ctx); const rw = tool(b, "suspense.read/write");
  const item = { loan_id: "L-1", status: "open", reason_code: "unidentified_payer", source: "lockbox", amount_cents: 65_783n, received_on: "2026-10-08", payer_account_last4: "8831", payer_name: "J. Smith" };
  await b.bus.execute(rw, RECON, { op: "write", id: "S-7", data: item }, ctx);
  await assert.rejects(b.bus.execute(rw, RECON, { op: "write", id: "S-7", data: { ...item, amount_cents: 1n } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "MONEY_FIELD");
  assert.equal(b.rt.store.get("suspense_items", "S-7")!.data.amount_cents, 65_783n, "the refused rewrite changed nothing");
  assert.equal(ctx.events.ofType("command.refused").at(-1)!.payload.code, "MONEY_FIELD");
  await b.bus.execute(rw, RECON, { op: "write", id: "S-7", data: { ...item, status: "researching" } }, ctx);   // same amount: an ordinary status write
  await b.bus.execute(rw, OFFICER, { op: "write", id: "S-7", data: { ...item, status: "researching", amount_cents: 65_784n }, reason: "bank confirmed the credit at $657.84" }, ctx);
  assert.equal(b.rt.store.get("suspense_items", "S-7")!.data.amount_cents, 65_784n);
  // a self-asserted flag does not make a different account the originator, nor a different payee the remitter
  await assert.rejects(b.bus.execute(tool(b, "nacha.originate_credit"), RECON, { amount_cents: 65_784n, destination_last4: "0000", destination_is_verified_originator: true, destination_is_borrower: true, suspense_item_id: "S-7" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "RETURN_TO_ORIGINATOR_ONLY" && /…0000 is not the item's originating account …8831/.test(e.message));
  await assert.rejects(b.bus.execute(tool(b, "check.issue"), RECON, { amount_cents: 65_784n, payee: "Somebody Else", payee_is_verified_remitter: true, suspense_item_id: "S-7" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "REMITTER_ONLY");
  assert.equal(b.rt.store.get("suspense_items", "S-7")!.data.status, "researching", "nothing left T&I");
  assert.equal(ctx.events.ofType("suspense.return.initiated").length, 0);
  await b.bus.execute(tool(b, "nacha.originate_credit"), RECON, { amount_cents: 65_784n, destination_last4: "8831", destination_is_verified_originator: true, destination_is_borrower: true, suspense_item_id: "S-7" }, ctx);
  assert.equal(b.rt.store.get("suspense_items", "S-7")!.data.status, "returned");
  // TCPA / AI disclosure: omitted facts are not consent
  const contact = tool(b, "contact.request");
  await assert.rejects(b.bus.execute(contact, RECON, { reason: "confirm intent", loan_id: "L-1" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "TCPA_CONSENT_QUIET_HOURS");
  await assert.rejects(b.bus.execute(contact, RECON, { reason: "confirm intent", loan_id: "L-1", consent: true, automation_disclosed: true, quiet_hours: true }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "TCPA_CONSENT_QUIET_HOURS");
  const handoff = await b.bus.execute(contact, RECON, { reason: "confirm intent", loan_id: "L-1", consent: true, automation_disclosed: true }, ctx);
  assert.equal((handoff.output as { kind: string }).kind, "human_agent");
  // the unclaimed-property track's own guards: the notice below $50 is not required; a report on an unverified file is refused before anything is written
  const up = tool(b, "unclaimed_property.compute");
  await b.bus.execute(up, RECON, { op: "open", id: "up-small", suspense_item_id: "S-8", state: "TX", amount_cents: 4_999n, dormancy_start_on: "2023-05-01" }, ctx);
  await b.bus.execute(up, RECON, { op: "presume_abandoned", id: "up-small" }, ctx);
  assert.throws(() => sendDueDiligenceNotice({ events: ctx.events, actor: RECON, now: ctx.clock.now(), store: b.rt.store }, { id: "up-small", sent_on: D("2026-06-01") }), /below the threshold/);
  await assert.rejects(b.bus.execute(up, OFFICER, { op: "report", state: "TX", cycle: "FY2026", file_id: "TX-FY2026", filed_on: "2026-10-08", item_ids: ["up-small"], remitted: true, remittance_cents: 4_999n }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NAUPA_FILE");
  assert.throws(() => reportUnclaimedProperty({ events: ctx.events, actor: OFFICER, now: ctx.clock.now() }, { state: "TX", cycle: "FY2026", file_id: "f", filed_on: D("2026-10-08"), remitted: true, remittance_cents: 1n, items: [{ id: "up-small", state: "TX", amount_cents: 4_999n, dormancy_start_on: D("2023-05-01"), status: "presumed_abandoned" }] }), /remittance_cents 1 must equal the items' total 4999/);
  assert.equal(b.rt.store.get("unclaimed_property_reports", "TX-FY2026"), undefined);
});
