// 16.1 Payoff statement
// spec/sections/16-payoff-lien-release/16-1-payoff-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { levelPayment, ratePercent, monthlyInterest } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { interest as sharedInterest, perDiem, reconcile, statementDeadlines, validUntil, STATE_PAYOFF_RULES, type Components } from "./quote.ts";
import { fnmaShare } from "./remit.ts";
import { type MintedToken, interestF109, quote16, payoffQuoteRow, quoteHash, fundsReceived, segmentedInterest, rateChangeAfterStatement, perDiemTolerance, escrowParagraph, goodThroughPolicy, statutoryStatementDue, wireVerifyGate, mintVerificationToken, flCorrectedEstoppel, stateVariant, FL_DISCLAIMER_PATTERN, txTitleCompanyRequest, shortageDisposition, oralQuote, ctStatementDeadline, statementDeadlineBreach, nibMaturityNotices, nibNoticePayload, nibMaturitySweep, recomputeOnEvent, updatedStatementRecipients, payoffRequestIntake, quoteRequestIntake, thirdPartyStatementGuard, FIGURE_KEYS } from "./ops-16-1.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { TOOLS_16_1 } from "../../app/tools/section16-1.ts";

/** Worked example A (Ohio, fixed 6.500%, monthly accrual): UPB $248,310.55, LPI 09/01/2026, good-through 10/15/2026, late charge $82.17, recording fee $34.00. */
const A: Components = { upb_cents: 24_831_055n, rate_pct: "6.500", lpi_due: D("2026-09-01"), good_through: D("2026-10-15"), late_charges_cents: 8_217n, recording_fee_cents: 3_400n };
/** Example A as the computePayoffQuote input: the written request e-mailed by the borrower Mon 09/14 (the intake the engine records), the tool's clock is the 09/15 render day. */
const A_INPUT = { loan_id: "L-16", quote_id: "pq-1", request_id: "pr-1", channel: "email", received_on: "2026-09-14", requester_type: "borrower", upb_cents: 24_831_055n, rate_pct: "6.500", lpi_due: "2026-09-01", good_through: "2026-10-15", late_charges_cents: 8_217n, recording_fee_cents: 3_400n, state: "OH", ledger_snapshot_id: "ledger-hwm-88121" };
const ADDR = "1 Test St, Testville OH 43001";
const RECIPIENTS = [{ party_id: "borrower", channel: "portal", email: "bea@example.test", address: ADDR }, { party_id: "borrower", channel: "email", email: "bea@example.test", address: ADDR }, { party_id: "refi-lender", channel: "email", email: "payoffs@refilender.test", address: "9 Lender Way, Columbus OH 43215" }];
const SYS: Actor = { kind: "system", id: "16.1-test" };
const noticeReg = (() => { const reg = buildRegistry(); publishAuthored(reg); return reg; })();
const published = () => noticeReg;
const REG = loadOverriddenRegistry();
/** The caller's display fields for a statement send: the 7.6 sample payload minus every figure/engine key (those come from the rows). */
const DISPLAY = (code: string): Record<string, unknown> => Object.fromEntries(Object.entries(noticeReg.activeVersion(code, D("2026-09-01"))!.samplePayload).filter(([k]) => !(FIGURE_KEYS as readonly string[]).includes(k)));
/** The 16.1 tools on the bus with the overridden timer registry listening (16.1 rows and the 7.6-owned payoff rows — the federal 7-BD clock and the accuracy gate — arm) and the Notice Registry rendering for real. */
function harness(now = "2026-09-15T14:00:00.000Z", loanId = "L-16") {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock); const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["16.1", "7.6"] });
  const ctx: UowContext = { loanId, events, ledger: new MemoryLedger(), timers, clock, decide: () => {} };
  const notices = new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices, ports: {} };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents); const agent: Actor = { kind: "agent", id: "payoff-release" };
  const cmds = new Map(TOOLS_16_1.map((t) => { const c = toolCommand(t, rt, ["officer"]); agents.registerTool(t.agent, c.name); return [t.name, c] as const; }));
  const run = (name: string, input: Record<string, unknown>, actor: Actor = agent) => bus.execute(cmds.get(name)!, actor, input, ctx);
  return { ctx, rt, events, timers, clock, agent, run, notices };
}
/** Render + gate + statement for a computed quote on the bus (the vault's active version is wire-v4). */
async function issue(h: ReturnType<typeof harness>, loanId: string, quoteId: string, statementId: string, extra: Record<string, unknown> = {}) {
  const hash = String(h.rt.store.get("payoff_quotes", quoteId)!.data.hash);
  const tok = (await h.run("mintVerificationToken", { loan_id: loanId, statement_hash: hash, wire_instruction_version_id: "wire-v4" })).output as { token: string };
  await h.run("assertAccuracyGate", { loan_id: loanId, quote_id: quoteId, ledger_clean: true, rate_segments_final: true });
  const row = (await h.run("renderStatement", { loan_id: loanId, quote_id: quoteId, statement_id: statementId, wire_instruction_version_id: "wire-v4", active_wire_instruction_version_id: "wire-v4", verification_token: tok.token, ...extra })).output as Record<string, unknown>;
  return { token: tok.token, hash, row };
}
const last = (h: ReturnType<typeof harness>, type: string): DomainEvent => { const l = h.events.ofType(type); assert.ok(l.length > 0, `no ${type} event`); return l[l.length - 1]!; };

test("16.1-T1: Given example A, when the quote is computed for good-through 10/15/2026, then components are $1,345.02 / $619.08 / $82.17 / $34.00, per diem $44.22, total $250,390.82, and the hash is stable across two runs on the same ledger snapshot.", async () => {
  const row = payoffQuoteRow({ components: A, ledger_snapshot_id: "ledger-hwm-88121" });
  // September is a full month (248,310.55 × 0.065 ÷ 12 = 1,345.0155); October 1–14 = 14 days on 365 (619.0756); per diem 44.2197
  assert.deepEqual([row.figures.months_full, row.figures.days_partial], [1, 14]); assert.equal(row.figures.accrual_start, "2026-09-01");
  assert.deepEqual([row.figures.interest_full_months_cents, row.figures.interest_partial_cents, row.figures.late_charges_cents, row.figures.recording_fee_cents, row.figures.per_diem_cents], [134_502n, 61_908n, 8_217n, 3_400n, 4_422n]);
  assert.equal(row.figures.interest_full_months_cents, monthlyInterest(A.upb_cents, ratePercent("6.500"))); assert.equal(row.figures.interest_partial_cents, divRound(A.upb_cents * 6500n * 14n, 100_000n * 365n)); assert.equal(row.figures.per_diem_cents, divRound(A.upb_cents * 6500n, 100_000n * 365n));
  assert.equal(row.total_cents, A.upb_cents + 134_502n + 61_908n + 8_217n + 3_400n); assert.equal(row.total_cents, 25_039_082n); assert.equal(row.figures.prepayment_premium_cents, 0n); assert.equal(row.figures.nib_line_cents, 0n);
  // the hash: two runs on the same ledger snapshot are identical; another snapshot, or any changed figure, is a different hash
  const again = payoffQuoteRow({ components: { ...A }, ledger_snapshot_id: "ledger-hwm-88121" });
  assert.equal(again.hash, row.hash); assert.match(row.hash, /^[0-9a-f]{64}$/); assert.equal(quoteHash(row.figures as unknown as Record<string, unknown>), row.hash);
  assert.notEqual(payoffQuoteRow({ components: A, ledger_snapshot_id: "ledger-hwm-88122" }).hash, row.hash);
  assert.notEqual(payoffQuoteRow({ components: { ...A, late_charges_cents: 0n }, ledger_snapshot_id: "ledger-hwm-88121" }).hash, row.hash);
  // through the tool: the written request is recorded once (payoff.request.received starts the federal clock from the 09/14 receipt), then two computePayoffQuote runs on the same snapshot write two immutable payoff_quotes rows carrying the same hash and figures
  const h = harness();
  const r1 = (await h.run("computePayoffQuote", { ...A_INPUT, quote_id: "pq-1" })).output as { hash: string; total_cents: bigint; per_diem_cents: bigint; interest_cents: bigint; fees_waived_cents: bigint; request_id: string };
  const r2 = (await h.run("computePayoffQuote", { ...A_INPUT, quote_id: "pq-2" })).output as { hash: string; total_cents: bigint };
  assert.equal(r1.hash, row.hash); assert.equal(r2.hash, r1.hash); assert.equal(r1.total_cents, 25_039_082n); assert.equal(r1.per_diem_cents, 4_422n); assert.equal(r1.interest_cents, 134_502n + 61_908n); assert.equal(r1.fees_waived_cents, 0n); assert.equal(r1.request_id, "pr-1");
  assert.equal(h.rt.store.get("payoff_quotes", "pq-1")!.data.hash, h.rt.store.get("payoff_quotes", "pq-2")!.data.hash); assert.equal(h.rt.store.history("payoff_quotes", "pq-1").length, 1);
  assert.deepEqual(h.events.ofType("payoff.quote.computed").map((e) => [e.payload.quote_id, e.payload.total_cents, e.payload.hash === row.hash]), [["pq-1", "25039082", true], ["pq-2", "25039082", true]]);
  assert.equal(h.events.ofType("payoff.request.received").length, 1); assert.equal(h.rt.store.get("payoff_requests", "pr-1")!.data.quote_id, "pq-2");
  const fed = h.timers.byCode("REGZ_1026_36C3_PAYOFF_STMT_7BD"); assert.equal(fed.length, 1); assert.equal(fed[0]!.anchorDate, "2026-09-14"); assert.equal(fed[0]!.dueDate, "2026-09-23");   // day 7 = Wed 09/23 (servicer open weekdays); Ohio: no state clock
  assert.equal(h.timers.byCode("STATE_PAYOFF_STMT_DEADLINE").length, 0);
  // a fee waiver (2.7) changes the figure and the hash; over $100 it needs the officer, and it always carries its reason
  const waived = (await h.run("computePayoffQuote", { ...A_INPUT, quote_id: "pq-3", fee_waiver_cents: 8_217n, fee_waiver_reason: "August late charge waived under 2.7 (first-time courtesy)" })).output as { hash: string; total_cents: bigint; fees_waived_cents: bigint; late_charges_cents: bigint };
  assert.equal(waived.fees_waived_cents, 8_217n); assert.equal(waived.late_charges_cents, 0n); assert.equal(waived.total_cents, 25_039_082n - 8_217n); assert.notEqual(waived.hash, row.hash);
  await assert.rejects(h.run("computePayoffQuote", { ...A_INPUT, quote_id: "pq-4", fee_waiver_cents: 11_617n, fee_waiver_reason: "waive late charge and recording fee" }), (e: unknown) => e instanceof CommandRefused && e.code === "FEE_WAIVER_OVER_100_OFFICER");
  await assert.rejects(h.run("computePayoffQuote", { ...A_INPUT, quote_id: "pq-4", fee_waiver_cents: 8_217n }), (e: unknown) => e instanceof CommandRefused && e.code === "FEE_WAIVER_NEEDS_REASON");
  const officer = (await h.run("computePayoffQuote", { ...A_INPUT, quote_id: "pq-4", fee_waiver_cents: 11_617n, fee_waiver_reason: "officer-approved 2.7 waiver" }, { kind: "human", id: "u-officer", role: "officer" })).output as { fees_waived_cents: bigint; total_cents: bigint };
  assert.equal(officer.fees_waived_cents, 8_217n); assert.equal(officer.total_cents, 25_039_082n - 8_217n);   // only borrower-payable late charges/fees are waivable; the third-party recording fee is not
});
test("16.1-T2: Given example A and funds received 10/09, then exact interest is $353.76 and `payoff.funds.over{265.32}` is emitted; given funds received 10/20 at the statement amount, then `payoff.funds.short{221.10}`.", async () => {
  const q = quote16(A); const stmt = { components: A, statement_total_cents: q.total_cents, per_diem_cents: q.per_diem_cents, state: "OH" };
  // Fri 10/09 by wire, $250,390.82: interest through 10/08 = 8 partial days → $353.76; the statement carried $619.08 → over by 6 × $44.22
  const early = fundsReceived({ ...stmt, received_on: D("2026-10-09"), amount_received_cents: q.total_cents });
  assert.equal(early.payoff_date, "2026-10-09"); assert.deepEqual([early.exact_interest.months_full, early.exact_interest.days_partial, early.exact_interest.partial_cents], [1, 8, 35_376n]);
  assert.equal(early.exact_total_cents, q.total_cents - 61_908n + 35_376n); assert.equal(early.overage_cents, 26_532n); assert.equal(early.overage_cents, 6n * q.per_diem_cents); assert.equal(early.outcome, "over");
  assert.deepEqual(early.event, { type: "payoff.funds.over", payload: { overage_cents: 26_532n, refund_by: addBusinessDays(D("2026-10-09"), 10, servicer), timer: "SM_OVERPAYMENT_REFUND_10BD" } });
  assert.equal(early.paid_in_full_on, "2026-10-09"); assert.equal(early.disposition, "paid_in_full_overage_refund_10bd"); assert.equal(reconcile(A, q.total_cents, D("2026-10-09"), q.total_cents).variance_cents, 26_532n);
  // Tue 10/20, statement amount only: interest through 10/19 = 19 days → $840.17; the per-diem instruction (5 × $44.22 = $221.10) was not added → short $221.10 (exact Δ $221.09)
  const late = fundsReceived({ ...stmt, received_on: D("2026-10-20"), amount_received_cents: q.total_cents });
  assert.deepEqual([late.exact_interest.days_partial, late.exact_interest.partial_cents, late.days_after_good_through], [19, 84_017n, 5]);
  assert.equal(late.per_diem_instruction_cents, 22_110n); assert.equal(late.exact_extra_cents, 22_109n); assert.equal(late.variance_cents, -22_109n); assert.equal(late.shortage_cents, 22_110n);
  assert.equal(late.event.type, "payoff.funds.short"); assert.deepEqual(late.event.payload, { shortage_cents: 22_110n, exact_shortage_cents: 22_109n, demand_by: addBusinessDays(D("2026-10-20"), 5, servicer), disposition: "short_payoff_demand_1bd" });
  assert.equal(late.disposition, "short_payoff_demand_1bd"); assert.equal(late.paid_in_full_on, null); assert.equal(late.tolerance!.accepted, true); assert.equal(late.rounding_expense_cents, 1n);   // > 16.2 tolerance → short-payoff path; the closing agent is asked for $221.10 within 5 BD
  // the closing agent who adds the $221.10 is paid in full on 10/20; the cent above the exact Δ goes to payoff_rounding_expense
  const cured = fundsReceived({ ...stmt, received_on: D("2026-10-20"), amount_received_cents: q.total_cents + 22_110n });
  assert.equal(cured.event.type, "payoff.funds.matched"); assert.equal(cured.paid_in_full_on, "2026-10-20"); assert.equal(cured.rounding_expense_cents, 1n); assert.equal(cured.variance_cents, 1n);
  // emitted: openShortagePath reads the payoff_quotes row (figures only from payoff_quotes — an inline exact figure is refused) and emits the events with the cents
  const h = harness(); await h.run("computePayoffQuote", A_INPUT);
  await assert.rejects(h.run("openShortagePath", { loan_id: "L-16", quote_id: "pq-1", received_on: "2026-10-09", amount_received_cents: 25_039_082n, exact_total_cents: 1n }), (e: unknown) => e instanceof CommandRefused && e.code === "FIGURES_FROM_QUOTES_ONLY");
  const over = (await h.run("openShortagePath", { loan_id: "L-16", quote_id: "pq-1", received_on: "2026-10-09", amount_received_cents: 25_039_082n })).output as ReturnType<typeof fundsReceived>;
  assert.equal(over.overage_cents, 26_532n);
  const short = (await h.run("openShortagePath", { loan_id: "L-16", quote_id: "pq-1", received_on: "2026-10-20", amount_received_cents: 25_039_082n })).output as ReturnType<typeof fundsReceived>;
  assert.equal(short.shortage_cents, 22_110n);
  assert.deepEqual(h.events.ofType("payoff.funds.over").map((e) => [e.payload.overage_cents, e.payload.payoff_date, e.payload.timer]), [["26532", "2026-10-09", "SM_OVERPAYMENT_REFUND_10BD"]]);
  assert.deepEqual(h.events.ofType("payoff.funds.short").map((e) => [e.payload.shortage_cents, e.payload.exact_shortage_cents, e.payload.disposition, e.payload.demand_blocked]), [["22110", "22109", "short_payoff_demand_1bd", false]]);
  assert.deepEqual(h.events.ofType("loan.paid_in_full").map((e) => e.payload.payoff_date), ["2026-10-09"]);
});
test("16.1-T3: Given LPI 09/01, `accrual_start` 09/01 and payoff date 10/01 (installment due date), then interest = one full month at rate ÷ 12 and zero partial days; given the due date falls on Sunday 11/01/2026 and funds arrive Mon 11/02, then `payoff_date` is deemed 11/01 (F-1-09).", () => {
  const oneMonth = interestF109(A.upb_cents, A.rate_pct, D("2026-09-01"), D("2026-10-01"));
  assert.deepEqual([oneMonth.months_full, oneMonth.days_partial, oneMonth.partial_cents], [1, 0, 0n]);
  assert.equal(oneMonth.full_cents, monthlyInterest(A.upb_cents, ratePercent("6.500"))); assert.equal(oneMonth.full_cents, divRound(A.upb_cents * 6500n, 100_000n * 12n)); assert.equal(oneMonth.full_cents, 134_502n); assert.equal(oneMonth.total_cents, oneMonth.full_cents);
  // Sunday 11/01/2026 is the due date; funds on Mon 11/02 are deemed received 11/01: September + October full months, no partial day
  assert.equal(new Date("2026-11-01T12:00:00Z").getUTCDay(), 0); assert.equal(servicer.isBusinessDay(D("2026-11-01")), false); assert.equal(addBusinessDays(D("2026-11-01"), 1, servicer), "2026-11-02");
  const deemed = deemedPayoffDateOf(D("2026-11-02"), D("2026-11-01")); assert.equal(deemed, "2026-11-01");
  // rule 3: the two-month block is rounded once — 248,310.55 × 0.065 × 2 ÷ 12 = 2,690.0310 → $2,690.03 (the shared per-month rounding would give 2 × $1,345.02 = $2,690.04, a cent high)
  const twoMonths = interestF109(A.upb_cents, A.rate_pct, D("2026-09-01"), deemed); assert.deepEqual([twoMonths.months_full, twoMonths.days_partial, twoMonths.total_cents], [2, 0, 269_003n]);
  assert.equal(twoMonths.full_cents, divRound(A.upb_cents * 6500n * 2n, 100_000n * 12n)); assert.equal(sharedInterest(A.upb_cents, A.rate_pct, D("2026-09-01"), deemed).total_cents, 269_004n); assert.equal(twoMonths.full_cents, sharedInterest(A.upb_cents, A.rate_pct, D("2026-09-01"), deemed).total_cents - 1n);
  assert.equal(interestF109(A.upb_cents, A.rate_pct, D("2026-09-01"), D("2026-11-02")).days_partial, 1);   // without the rule the intervening day would accrue
  assert.equal(deemedPayoffDateOf(D("2026-11-03"), D("2026-11-01")), "2026-11-03"); assert.equal(deemedPayoffDateOf(D("2026-10-02"), D("2026-10-01")), "2026-10-02");   // only the next business day after a non-business due date
  // at funds receipt the deemed date drives the exact figure: a statement good through 11/01 paid Mon 11/02 is paid in full with no per-diem day
  const nov = { ...A, good_through: D("2026-11-01") }; const qn = quote16(nov); assert.equal(qn.interest.total_cents, 269_003n);
  const f = fundsReceived({ components: nov, statement_total_cents: qn.total_cents, per_diem_cents: qn.per_diem_cents, received_on: D("2026-11-02"), amount_received_cents: qn.total_cents, state: "OH", installment_due_on: D("2026-11-01") });
  assert.equal(f.payoff_date, "2026-11-01"); assert.equal(f.deemed_received_on_due_date, true); assert.equal(f.days_after_good_through, 0); assert.equal(f.exact_interest.total_cents, 269_003n); assert.equal(f.event.type, "payoff.funds.matched"); assert.equal(f.paid_in_full_on, "2026-11-01");
  assert.equal(fundsReceived({ components: nov, statement_total_cents: qn.total_cents, per_diem_cents: qn.per_diem_cents, received_on: D("2026-11-02"), amount_received_cents: qn.total_cents, state: "OH" }).days_after_good_through, 1);
});
/** F-1-09 non-business-day rule as the funds path applies it (quote.ts `deemedPayoffDate`, re-exported through fundsReceived's inputs). */
function deemedPayoffDateOf(receivedOn: ReturnType<typeof D>, dueOn: ReturnType<typeof D>) { return fundsReceived({ components: { ...A, good_through: dueOn }, statement_total_cents: 0n, per_diem_cents: 0n, received_on: receivedOn, amount_received_cents: 0n, state: "OH", installment_due_on: dueOn }).payoff_date; }
test("16.1-T4: Given a DSI loan (`daily_simple_365`), then interest = UPB × rate ÷ 365 × (payoff_date − accrual_start) with no 360-day full-month block.", () => {
  const dsi = interestF109(A.upb_cents, A.rate_pct, D("2026-09-01"), D("2026-10-15"), "daily_simple_365");
  assert.equal(dsi.days_partial, daysBetween(D("2026-09-01"), D("2026-10-15"))); assert.equal(dsi.days_partial, 44); assert.equal(dsi.months_full, 0); assert.equal(dsi.full_cents, 0n);
  // 248,310.55 × 0.065 ÷ 365 × 44 = 1,945.6662 → $1,945.67, one rounding
  assert.equal(dsi.partial_cents, divRound(A.upb_cents * 6500n * 44n, 100_000n * 365n)); assert.equal(dsi.partial_cents, 194_567n); assert.equal(dsi.total_cents, 194_567n);
  // the monthly 30/360 + partial 365 method on the same window: $1,345.02 + $619.08 = $1,964.10 — the DSI loan carries no 360-day block
  assert.equal(interestF109(A.upb_cents, A.rate_pct, D("2026-09-01"), D("2026-10-15")).total_cents, 134_502n + 61_908n); assert.notEqual(dsi.total_cents, 134_502n + 61_908n);
  const qd = quote16({ ...A, method: "daily_simple_365" }); assert.equal(qd.interest.total_cents, 194_567n); assert.equal(qd.total_cents, A.upb_cents + 194_567n + 8_217n + 3_400n); assert.equal(qd.per_diem_cents, 4_422n);
  assert.equal(interestF109(A.upb_cents, A.rate_pct, D("2026-09-01"), D("2026-10-01"), "daily_simple_365").partial_cents, divRound(A.upb_cents * 6500n * 30n, 100_000n * 365n));   // a due-date payoff is still 30 daily accruals
  const row = payoffQuoteRow({ components: { ...A, method: "daily_simple_365" }, ledger_snapshot_id: "snap-dsi" }); assert.equal(row.figures.months_full, 0); assert.equal(row.figures.days_partial, 44); assert.equal(row.figures.interest_cents, 194_567n);
});
test("16.1-T5: Given an ARM rate change effective inside the window (7.2 notice), then two segments are computed and the statement prints both rates; given the change is noticed after the statement, then an updated statement issues within 1 BD.", () => {
  // the 7.2 notice: 6.500% through 09/30, 7.000% effective 10/01 — inside the 09/01→10/15 accrual window
  const rates = [{ effective_from: D("2026-01-01"), rate_pct: "6.500", source: "note" as const }, { effective_from: D("2026-10-01"), rate_pct: "7.000", source: "arm_7_2" as const }];
  const seg = segmentedInterest(A.upb_cents, A.lpi_due, A.good_through, rates);
  assert.equal(seg.split, true); assert.equal(seg.segments.length, 2);
  assert.deepEqual(seg.segments.map((s) => [s.from, s.to, s.rate_pct, s.months_full, s.days_partial, s.interest_cents]), [["2026-09-01", "2026-10-01", "6.500", 1, 0, 134_502n], ["2026-10-01", "2026-10-15", "7.000", 0, 14, 66_670n]]);
  assert.equal(seg.total_cents, 134_502n + 66_670n); assert.deepEqual(seg.rates_printed, ["6.500%", "7.000%"]); assert.equal(seg.per_diem_after_cents, perDiem(A.upb_cents, "7.000"));
  assert.equal(segmentedInterest(A.upb_cents, A.lpi_due, A.good_through, [rates[0]!]).split, false);
  // the change is noticed Fri 10/09, after the 09/15 statement: Δ = the 7% October segment less the 6.5% one → updated statement to every prior recipient by Tue 10/13 (Mon 10/12 Columbus Day)
  const stmt = { id: "ps-1", sent_on: D("2026-09-15"), good_through: A.good_through, total_cents: quote16(A).total_cents, recipients: RECIPIENTS };
  const u = rateChangeAfterStatement({ statement: stmt, components: A, rates, noticed_on: D("2026-10-09"), today: D("2026-10-09") });
  assert.equal(u.recompute, true); assert.equal(u.event, "payoff.quote.recompute"); assert.equal(u.delta_cents, 66_670n - 61_908n); assert.equal(u.timer, "SM_PAYOFF_STMT_UPDATE_1BD");
  assert.equal(u.updated!.due_by, "2026-10-13"); assert.equal(u.updated!.due_by, addBusinessDays(D("2026-10-09"), 1, servicer));
  assert.equal(u.updated!.total_cents, stmt.total_cents + u.delta_cents); assert.equal(u.updated!.template, "NTC_PAYOFF_UPDATED_STMT"); assert.deepEqual(u.updated!.send_to, RECIPIENTS);
  assert.match(u.updated!.explanation, /changed to 7\.000% effective October 1, 2026 \(7\.2 notice\)/); assert.deepEqual(u.original, { id: "ps-1", status: "superseded", superseded_by: u.updated!.id, retained: true });
  assert.deepEqual(u.interest.rates_printed, ["6.500%", "7.000%"]);
  // the payoff_quotes row of the segmented figure carries both segments and the post-change per diem
  const row = payoffQuoteRow({ components: A, rates, ledger_snapshot_id: "snap-arm" }); assert.deepEqual(row.figures.rate_segments.map((s) => s.rate_pct), ["6.500", "7.000"]); assert.equal(row.figures.interest_cents, seg.total_cents); assert.equal(row.figures.per_diem_cents, perDiem(A.upb_cents, "7.000")); assert.equal(row.total_cents, u.updated!.total_cents);
});
test("16.1-T6: Given example B, then the NIB line shows $12,000.00, interest $468.49, total $192,468.49.", () => {
  const b: Components = { upb_cents: 18_000_000n, rate_pct: "5.000", lpi_due: D("2026-11-01"), good_through: D("2026-11-20"), nib_deferred_cents: 1_200_000n };
  const qb = quote16(b);
  // 11/01–11/19 = 19 days on the interest-bearing UPB only: 180,000 × 0.05 ÷ 365 × 19 = 468.4932 → $468.49; per diem $24.66
  assert.deepEqual([qb.interest.months_full, qb.interest.days_partial], [0, 19]); assert.equal(qb.interest.total_cents, divRound(b.upb_cents * 5000n * 19n, 100_000n * 365n)); assert.equal(qb.interest.total_cents, 46_849n); assert.equal(qb.per_diem_cents, 2_466n);
  assert.equal(qb.nib_line_cents, 1_200_000n); assert.equal(qb.total_cents, b.upb_cents + qb.nib_line_cents + qb.interest.total_cents); assert.equal(qb.total_cents, 19_246_849n);
  assert.notEqual(quote16({ ...b, upb_cents: b.upb_cents + 1_200_000n, nib_deferred_cents: 0n }).interest.total_cents, qb.interest.total_cents);   // the NIB balance never accrues interest (D2-3.2-04)
  const row = payoffQuoteRow({ components: b, ledger_snapshot_id: "snap-b" }); assert.equal(row.figures.nib_deferred_cents, 1_200_000n); assert.equal(row.figures.nib_line_cents, 1_200_000n); assert.equal(row.figures.total_cents, 19_246_849n);
  // the statement prints the NIB line separately from the UPB and the total
  const reg = published(); const v = reg.activeVersion("NTC_REGZ_36C3_PAYOFF_STMT", D("2026-09-01"))!;
  const payload = { ...v.samplePayload, good_through: "2026-11-20", paid_through: "2026-10-31", rate_pct: "5.000", days: 19, upb_cents: b.upb_cents, nib_cents: qb.nib_line_cents, interest_cents: qb.interest.total_cents, per_diem_cents: qb.per_diem_cents, total_cents: qb.total_cents };
  const out = render(v.source, payload); const check = evaluateChecklist(v, payload, out);
  assert.match(out.text, /unpaid principal balance \$180,000\.00/); assert.match(out.text, /non-interest-bearing deferred balance \$12,000\.00/); assert.match(out.text, /Total amount to pay your loan in full as of November 20, 2026: \$192,468\.49/); assert.match(out.text, /19 days at \$24\.66 per day/);
  assert.equal(check.passed, true, check.blocking.map((r) => r.rule_id).join(",")); assert.equal(check.results.find((r) => r.rule_id === "nib")!.passed, true);
  // 16.2 reports LAR principal $192,000.00 (5.3-T5): the interest-bearing UPB plus the NIB line
  assert.equal(fnmaShare({ type: "AA", upb_cents: b.upb_cents, nib_cents: 1_200_000n, note_rate_pct: "5.000", ptr_pct: "4.750", lpi_due: b.lpi_due, payoff_on: b.good_through }).principal_cents, 19_200_000n);
});
test("16.1-T7: Given a Massachusetts property and a written request Mon 09/14/2026, then `STATE_PAYOFF_STMT_DEADLINE` is Mon 09/21 (5 BD) and drives the 70% warning ahead of the federal 09/23 date; the statement's validity is ≥ 10/14.", async () => {
  const received = D("2026-09-14"); const ma = statementDeadlines("MA", received); const oh = statementDeadlines("OH", received);
  assert.equal(STATE_PAYOFF_RULES.MA!.deadline_days, 5); assert.equal(STATE_PAYOFF_RULES.MA!.deadline_calendar, "business_servicer");
  assert.equal(ma.state_due, "2026-09-21"); assert.equal(ma.state_due, addBusinessDays(received, 5, servicer)); assert.equal(ma.federal_due, "2026-09-23"); assert.equal(ma.governing, "state"); assert.equal(ma.governing_due, "2026-09-21");
  // the 70% warning runs off the earlier deadline: 7 calendar days × 0.7 → Fri 09/18, ahead of the federal clock's own warning (Sun 09/20) and its 09/23 due date
  assert.equal(ma.warning_on, "2026-09-18"); assert.equal(oh.warning_on, "2026-09-20"); assert.ok(daysBetween(ma.warning_on, oh.warning_on) > 0); assert.ok(daysBetween(ma.warning_on, ma.federal_due) > 0); assert.equal(oh.governing, "federal"); assert.equal(oh.state_due, null);
  // the anchor the engine arms on: statutory_statement_due in the payoff.request.received{written} payload the intake writes (null in Ohio → federal clock only)
  const due = statutoryStatementDue("MA", received); assert.equal(due.statutory_statement_due, "2026-09-21"); assert.equal(due.federal_statement_due, "2026-09-23"); assert.deepEqual(due.timers, ["REGZ_1026_36C3_PAYOFF_STMT_7BD", "STATE_PAYOFF_STMT_DEADLINE"]);
  assert.equal(statutoryStatementDue("OH", received).statutory_statement_due, null); assert.deepEqual(statutoryStatementDue("OH", received).timers, ["REGZ_1026_36C3_PAYOFF_STMT_7BD"]);
  const intake = payoffRequestIntake({ request_id: "pr-ma", loan_id: "L-MA", channel: "portal", written: true, received_on: received, state: "MA", requester_type: "borrower", authorization_evidence: false, requested_good_through: D("2026-10-01") });
  assert.equal(intake.event.type, "payoff.request.received"); assert.equal(intake.event.payload.written, true); assert.equal(intake.event.payload.statutory_statement_due, "2026-09-21"); assert.equal(intake.event.payload.federal_statement_due, "2026-09-23"); assert.equal(intake.event.payload.warning_on, "2026-09-18"); assert.equal(intake.event.payload.requester, "consumer");
  assert.equal(payoffRequestIntake({ ...intake, request_id: "pr-oh", loan_id: "L-OH", channel: "email", written: true, received_on: received, state: "OH", requester_type: "borrower", authorization_evidence: false, requested_good_through: D("2026-10-01") }).event.payload.statutory_statement_due, null);
  assert.throws(() => payoffRequestIntake({ request_id: "pr-x", loan_id: "L-MA", channel: "ai_voice", written: false, received_on: received, state: "MA", requester_type: "borrower", authorization_evidence: false, requested_good_through: null }), /not a written request/);
  // on the bus: the MA request (portal = written) recorded by computePayoffQuote arms the state clock on 09/21 and the federal clock on 09/23 from the 09/14 receipt; the statement's sending satisfies both
  const h = harness("2026-09-15T14:00:00.000Z", "L-MA");
  await h.run("computePayoffQuote", { ...A_INPUT, loan_id: "L-MA", quote_id: "pq-ma", request_id: "pr-ma", channel: "portal", state: "MA", good_through: "2026-10-01" });
  const ev = last(h, "payoff.request.received"); assert.equal(ev.payload.statutory_statement_due, "2026-09-21"); assert.equal(ev.payload.received_on, "2026-09-14"); assert.equal(ev.payload.written, true);
  assert.equal(eventMatches(REG.get("STATE_PAYOFF_STMT_DEADLINE")!.triggerPattern!, ev), true); assert.equal(eventMatches(REG.get("REGZ_1026_36C3_PAYOFF_STMT_7BD")!.triggerPattern!, ev), true);
  const st = h.timers.byCode("STATE_PAYOFF_STMT_DEADLINE"); const fed = h.timers.byCode("REGZ_1026_36C3_PAYOFF_STMT_7BD");
  assert.equal(st.length, 1); assert.equal(st[0]!.anchorDate, "2026-09-21"); assert.equal(st[0]!.dueDate, "2026-09-21"); assert.equal(fed.length, 1); assert.equal(fed[0]!.anchorDate, "2026-09-14"); assert.equal(fed[0]!.dueDate, "2026-09-23"); assert.ok(st[0]!.dueAt! < fed[0]!.dueAt!);
  const oh2 = harness("2026-09-15T14:00:00.000Z", "L-OH"); await oh2.run("computePayoffQuote", { ...A_INPUT, loan_id: "L-OH", quote_id: "pq-oh", request_id: "pr-oh" });
  assert.equal(oh2.timers.byCode("STATE_PAYOFF_STMT_DEADLINE").length, 0); assert.equal(oh2.timers.byCode("REGZ_1026_36C3_PAYOFF_STMT_7BD").length, 1);   // Ohio: no state deadline located → only the federal clock
  const { row } = await issue(h, "L-MA", "pq-ma", "ps-ma", { state: "MA" });
  assert.equal(row.state_variant, "NTC_REGZ_36C3_PAYOFF_STMT_MA_54D"); assert.ok((row.valid_until as string) >= "2026-10-14", `MA validity ≥ 10/14 (issue + 30 CD): ${row.valid_until}`); assert.equal(row.good_through, "2026-10-01");
  const sent = (await h.run("sendNotice", { loan_id: "L-MA", template_code: "NTC_REGZ_36C3_PAYOFF_STMT", statement_id: "ps-ma", recipients: RECIPIENTS.slice(0, 1), payload: DISPLAY("NTC_REGZ_36C3_PAYOFF_STMT") })).output as { checklist_passed: boolean };
  assert.equal(sent.checklist_passed, true); assert.equal(st[0]!.status, "satisfied"); assert.equal(fed[0]!.status, "satisfied"); assert.equal(eventMatches(REG.get("STATE_PAYOFF_STMT_DEADLINE")!.satisfiedPattern!, last(h, "payoff.statement.sent")), true);
  // sent Tue 09/22: the state timer breaches (sev-1; MA's greater-of-$500-or-actual-damages exposure) while the federal clock has a day left
  const breach = statementDeadlineBreach({ state: "MA", request_on: received, sent_on: D("2026-09-22"), today: D("2026-09-22"), upb_cents: A.upb_cents, rate_pct: A.rate_pct });
  assert.equal(breach.breached, true); assert.equal(breach.severity, "sev1"); assert.equal(breach.timer, "STATE_PAYOFF_STMT_DEADLINE"); assert.equal(breach.governing, "state"); assert.deepEqual(breach.timers_breached, ["STATE_PAYOFF_STMT_DEADLINE"]); assert.match(breach.exposure!, /\$500/); assert.equal(breach.case, null);
  assert.equal(statementDeadlineBreach({ state: "MA", request_on: received, sent_on: D("2026-09-21"), today: D("2026-09-21"), upb_cents: A.upb_cents, rate_pct: A.rate_pct }).breached, false);
  // validity: valid_until = good_through, never earlier than issue + 30 CD in Massachusetts (§54D) → ≥ 10/14 for a 09/14 issue; the amount certain is stated as of the good-through date the figure was computed for
  assert.equal(validUntil("MA", received, D("2026-10-15")), "2026-10-15"); assert.ok(validUntil("MA", received, D("2026-10-15")) >= "2026-10-14");
  assert.equal(validUntil("MA", received, D("2026-10-01")), "2026-10-14"); assert.equal(validUntil("OH", received, D("2026-10-01")), "2026-10-01");
  const p = goodThroughPolicy({ state: "MA", received_on: received, issued_on: received, requested_good_through: D("2026-10-01") }); assert.equal(p.good_through, "2026-10-01"); assert.equal(p.valid_until, "2026-10-14"); assert.equal(p.capped, false);
  const text = stateVariant("MA", { valid_until: p.valid_until, good_through: p.good_through }); assert.equal(text.variant, "NTC_REGZ_36C3_PAYOFF_STMT_MA_54D"); assert.equal(text.as_of, "2026-10-01"); assert.match(text.state_text!, /amount certain as of October 1, 2026, the payment date specified/); assert.match(text.state_text!, /valid for not less than 30 days from issuance, through October 14, 2026/);
  const rendered = h.notices.all().find((n) => n.templateCode === "NTC_REGZ_36C3_PAYOFF_STMT")!; assert.match(rendered.rendered.text, /amount certain as of October 1, 2026/); assert.match(rendered.rendered.text, /Total amount to pay your loan in full as of October 1, 2026/); assert.doesNotMatch(rendered.rendered.text, /amount certain as of October 14, 2026/);
});
test("16.1-T8: Given a Florida property, then the statement contains no disclaimer text (checklist assertion) and a corrected statement sent at 4 p.m. the business day before payment does not supersede the original for reliance purposes.", () => {
  const reg = published(); const v = reg.activeVersion("NTC_REGZ_36C3_PAYOFF_STMT", D("2026-09-01"))!;
  const fl = stateVariant("FL", { valid_until: D("2026-10-15") });
  assert.equal(fl.variant, "NTC_REGZ_36C3_PAYOFF_STMT_FL_701_04"); assert.equal(fl.disclaimer_free, true); assert.match(fl.state_text!, /Florida Statutes section 701\.04/); assert.match(fl.state_text!, /3 p\.m\. at least one business day before/);
  const payload = { ...v.samplePayload, state: "FL", property_address: "1 Test St, Testville FL 33101", state_text: fl.state_text };
  const out = render(v.source, payload); const check = evaluateChecklist(v, payload, out);
  assert.equal(check.passed, true); assert.equal(check.results.find((r) => r.rule_id === "fl-no-disclaimer")!.passed, true); assert.doesNotMatch(out.text, FL_DISCLAIMER_PATTERN);
  const tainted = { ...payload, state_text: "Figures are subject to change and we reserve the right to correct them." };
  const bad = evaluateChecklist(v, tainted, render(v.source, tainted)); assert.equal(bad.passed, false); assert.ok(bad.blocking.map((r) => r.rule_id).includes("fl-no-disclaimer"));
  // a corrected letter received 4 p.m. Wed 10/14 (the business day before a Thu 10/15 payment) misses the 3 p.m. cutoff: the original governs for reliance and the servicer absorbs the difference
  const original = { id: "ps-1", total_cents: quote16(A).total_cents }; const corrected = { id: "ps-1-u1", total_cents: quote16(A).total_cents + 41_200n, received_on: D("2026-10-14"), received_hhmm: "16:00" };
  const late = flCorrectedEstoppel({ original, corrected, payment_on: D("2026-10-15") });
  assert.equal(late.gate, "FL_701_04_CORRECTED_ESTOPPEL_CUTOFF"); assert.equal(late.cutoff_on, "2026-10-14"); assert.equal(late.cutoff_iso, "2026-10-14T19:00:00.000Z"); assert.equal(late.received_iso, "2026-10-14T20:00:00.000Z");
  assert.equal(late.supersedes, false); assert.equal(late.honored_statement_id, "ps-1"); assert.equal(late.reliance_figure_cents, original.total_cents); assert.equal(late.absorbed_cents, 41_200n); assert.equal(late.disposition, "servicer_absorbed"); assert.match(late.basis, /supersedes all prior estoppel letters only if received by 3 p\.m\./);
  const early = flCorrectedEstoppel({ original, corrected: { ...corrected, received_hhmm: "14:30" }, payment_on: D("2026-10-15") });
  assert.equal(early.supersedes, true); assert.equal(early.honored_statement_id, "ps-1-u1"); assert.equal(early.reliance_figure_cents, corrected.total_cents); assert.equal(early.absorbed_cents, 0n); assert.equal(early.disposition, "corrected_governs");
  // received on the payment date itself, however early, never supersedes
  assert.equal(flCorrectedEstoppel({ original, corrected: { ...corrected, received_on: D("2026-10-15"), received_hhmm: "08:00" }, payment_on: D("2026-10-15") }).supersedes, false);
  // the gate as the engine arms it: the Δ ≠ 0 recompute on a Florida statement (scheduleRecompute → payoff.statement.updated{state=FL, payment_date}) is due 3 p.m. ET the business day before the payment date; delivery evidence of the corrected letter satisfies it
  const clock = new FixedClock("2026-10-13T14:00:00.000Z"); const events = new MemoryEventStore(clock); const eng = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["16.1"] });
  events.append({ type: "payoff.statement.updated", loanId: "L-FL", actor: SYS, payload: { state: "FL", payment_date: "2026-10-15", statement_id: "ps-1", updated_statement_id: "ps-1-u1" } });
  const inst = eng.byCode("FL_701_04_CORRECTED_ESTOPPEL_CUTOFF"); assert.equal(inst.length, 1); assert.equal(inst[0]!.anchorDate, "2026-10-15"); assert.equal(inst[0]!.dueDate, "2026-10-14"); assert.equal(new Date(inst[0]!.dueAt!).toISOString(), late.cutoff_iso);
  events.append({ type: "payoff.statement.updated", loanId: "L-OH", actor: SYS, payload: { state: "OH", payment_date: "2026-10-15" } }); assert.equal(eng.byCode("FL_701_04_CORRECTED_ESTOPPEL_CUTOFF").length, 1);   // Florida only
  events.append({ type: "payoff.statement.sent", loanId: "L-FL", actor: SYS, payload: { updated: true, state: "FL", all_prior_recipients: true } }); assert.equal(inst[0]!.status, "armed");   // sending is not delivery evidence
  events.append({ type: "payoff.statement.delivered", loanId: "L-FL", actor: SYS, payload: { updated: true, state: "FL", evidence_document_id: "doc-fl-1", received_at: "2026-10-14T14:30:00-04:00" } }); assert.equal(inst[0]!.status, "satisfied");
});
test("16.1-T9: Given a Texas title-company request on the Finance Commission form with closing date 10/15, then the figure is valid through 10/15 and a later demand for more is blocked by the engine (shortage → `servicer_absorbed`).", async () => {
  const tx = txTitleCompanyRequest({ received_on: D("2026-10-05"), closing_date: D("2026-10-15"), on_finance_commission_form: true, requester: "title_company" });
  assert.equal(tx.form_ok, true); assert.equal(tx.required_form, "Texas Payoff Statement Form (Finance Commission)"); assert.equal(tx.valid_through, "2026-10-15"); assert.equal(tx.refusal, null); assert.match(tx.cite, /343\.106/);
  // binding through the closing date and the no-demand rule follow jurisdiction_rules.payoff.reliance_rule (TX = binding_through_good_through) and apply only to a request on the standard form
  assert.equal(tx.reliance_rule, "binding_through_good_through"); assert.equal(tx.binding_through_closing, STATE_PAYOFF_RULES.TX!.reliance_rule === "binding_through_good_through"); assert.equal(tx.demand_in_excess_blocked, true);
  assert.equal(tx.deadline.governing_due, "2026-10-15"); assert.equal(tx.deadline.state_due, "2026-10-15");   // 7 BD from Mon 10/05 (Mon 10/12 Columbus Day) = Thu 10/15, the statutory floor
  const offForm = txTitleCompanyRequest({ received_on: D("2026-10-05"), closing_date: D("2026-10-15"), on_finance_commission_form: false, requester: "title_company" });
  assert.match(offForm.refusal!, /Finance Commission's standard form/); assert.equal(offForm.binding_through_closing, false); assert.equal(offForm.demand_in_excess_blocked, false);
  const text = stateVariant("TX", { valid_until: D("2026-10-15"), closing_date: D("2026-10-15") }); assert.equal(text.variant, "NTC_REGZ_36C3_PAYOFF_STMT_TX_343106"); assert.match(text.state_text!, /Proposed closing date: October 15, 2026\. The payoff amount above is valid through that date; on or before that date we will not demand an amount in excess of it/);
  // funds arrive at the 10/15 closing for the statement amount; a second $82.17 late charge (the unpaid September installment, 2.7) was assessed after the statement issued → the calculator's exact figure is $82.17 higher → the later demand is blocked (rule 10): shortage servicer_absorbed
  const q = quote16(A); const afterAssessment: Components = { ...A, late_charges_cents: (A.late_charges_cents ?? 0n) + 8_217n }; const exact = quote16(afterAssessment);
  assert.equal(exact.total_cents - q.total_cents, 8_217n);
  const s = shortageDisposition({ state: "TX", received_on: D("2026-10-15"), good_through: D("2026-10-15"), exact_total_cents: exact.total_cents, amount_received_cents: q.total_cents });
  assert.equal(s.shortage_cents, 8_217n); assert.equal(s.within_good_through, true); assert.equal(s.reliance_state, true); assert.equal(s.disposition, "servicer_absorbed"); assert.equal(s.demand_blocked, true); assert.match(s.basis, /343\.106/);
  const f = fundsReceived({ components: afterAssessment, statement_total_cents: q.total_cents, per_diem_cents: q.per_diem_cents, received_on: D("2026-10-15"), amount_received_cents: q.total_cents, state: "TX" });
  assert.equal(f.event.type, "payoff.funds.short"); assert.equal(f.shortage_cents, 8_217n); assert.equal(f.disposition, "servicer_absorbed"); assert.equal(f.event.type === "payoff.funds.short" ? f.event.payload.demand_by : "x", null); assert.equal(f.paid_in_full_on, "2026-10-15");
  // Ohio has no binding-through-date rule → the 16.2 short-payoff demand; after the Texas closing date the figure no longer binds; within the 16.2 tolerance nothing is demanded anywhere
  assert.equal(shortageDisposition({ state: "OH", received_on: D("2026-10-15"), good_through: D("2026-10-15"), exact_total_cents: exact.total_cents, amount_received_cents: q.total_cents }).disposition, "short_payoff_demand_1bd");
  assert.equal(shortageDisposition({ state: "TX", received_on: D("2026-10-20"), good_through: D("2026-10-15"), exact_total_cents: exact.total_cents, amount_received_cents: q.total_cents }).demand_blocked, false);
  assert.equal(shortageDisposition({ state: "TX", received_on: D("2026-10-15"), good_through: D("2026-10-15"), exact_total_cents: q.total_cents + 3_000n, amount_received_cents: q.total_cents }).disposition, "paid_in_full_tolerance_expense");
  // on the bus: the title company's request on the form (verification portal, authorization evidence attached) is a verified third party — the 1-BD authorization clock is satisfied at intake; the statement is valid through the 10/15 closing
  const h = harness("2026-10-05T15:00:00.000Z", "L-TX");
  const quoted = (await h.run("computePayoffQuote", { ...A_INPUT, loan_id: "L-TX", quote_id: "pq-tx", request_id: "pr-tx", state: "TX", channel: "verification_portal", requester_type: "lender_or_title", authorization_evidence: true, received_on: "2026-10-05", good_through: "2026-10-15", requested_payoff_on: "2026-10-15" })).output as { valid_until: string; third_party: { third_party: boolean; action: string } };
  assert.equal(quoted.valid_until, "2026-10-15"); assert.equal(quoted.third_party.third_party, true); assert.equal(quoted.third_party.action, "verified");
  const tp = h.timers.byCode("SM_PAYOFF_THIRD_PARTY_AUTH_1BD"); assert.equal(tp.length, 1); assert.equal(tp[0]!.dueDate, "2026-10-06"); assert.equal(tp[0]!.status, "satisfied");
  assert.equal(eventMatches(REG.get("SM_PAYOFF_THIRD_PARTY_AUTH_1BD")!.triggerPattern!, last(h, "payoff.request.received")), true); assert.equal(eventMatches(REG.get("SM_PAYOFF_THIRD_PARTY_AUTH_1BD")!.satisfiedPattern!, last(h, "payoff.request.third_party.resolved")), true);
  assert.equal(h.timers.byCode("STATE_PAYOFF_STMT_DEADLINE")[0]!.dueDate, "2026-10-15"); assert.equal(h.timers.byCode("REGZ_1026_36C3_PAYOFF_STMT_7BD")[0]!.dueDate, "2026-10-15");
  // the closing funds (statement amount, $82.17 short of the exact figure) at the 10/15 closing: the engine refuses a demand and records the absorbed shortage; the guardrail refuses it on the input vocabulary too
  h.clock.set("2026-10-15T16:00:00.000Z");
  await assert.rejects(h.run("openShortagePath", { loan_id: "L-TX", quote_id: "pq-tx", received_on: "2026-10-15", amount_received_cents: q.total_cents - 8_217n, demand: true }), /NO_DEMAND_AFTER_RELIANCE: TX figure .* servicer_absorbed .* never demanded/);
  await assert.rejects(h.run("openShortagePath", { loan_id: "L-TX", quote_id: "pq-tx", received_on: "2026-10-15", good_through: "2026-10-15", amount_received_cents: q.total_cents - 8_217n, demand: true, state: "TX" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_DEMAND_AFTER_RELIANCE");
  assert.equal(h.events.ofType("payoff.funds.short").length, 0);
  const absorbed = (await h.run("openShortagePath", { loan_id: "L-TX", quote_id: "pq-tx", received_on: "2026-10-15", amount_received_cents: q.total_cents - 8_217n })).output as ReturnType<typeof fundsReceived> & { demand_blocked: boolean };
  assert.equal(absorbed.disposition, "servicer_absorbed"); assert.equal(absorbed.demand_blocked, true); assert.equal(absorbed.shortage_cents, 8_217n); assert.equal(absorbed.paid_in_full_on, "2026-10-15");
  assert.deepEqual(h.events.ofType("payoff.funds.short").map((e) => [e.payload.disposition, e.payload.demand_blocked, e.payload.shortage_cents, e.payload.state]), [["servicer_absorbed", true, "8217", "TX"]]);
  assert.deepEqual(h.events.ofType("loan.paid_in_full").map((e) => [e.payload.payoff_date, e.payload.absorbed_shortage_cents]), [["2026-10-15", "8217"]]);
});
test("16.1-T10: Given the request arrives while a $1,900 tax disbursement is scheduled for 10/20, then the escrow paragraph states the balance will be refunded and the tax bill will not be paid by the servicer after 10/15 (3.5 cut-off), and the borrower is told to pay it.", () => {
  const e = escrowParagraph({ escrow_balance_cents: 241_290n, good_through: D("2026-10-15"), scheduled_disbursements: [{ kind: "tax", payee: "Franklin County Treasurer", amount_cents: 190_000n, due_on: D("2026-10-20") }] });
  assert.equal(e.treatment, "refund_separately"); assert.equal(e.refund_cents, 241_290n); assert.equal(e.refund_within_business_days, 20); assert.equal(e.cutoff_on, "2026-10-15");
  assert.equal(e.not_paid_after_cutoff.length, 1); assert.equal(e.borrower_to_pay[0]!.amount_cents, 190_000n); assert.equal(e.borrower_to_pay[0]!.due_on, "2026-10-20");
  assert.match(e.text, /escrow balance of \$2,412\.90 is not deducted from the payoff and will be refunded within 20 business days after payoff/);
  assert.match(e.text, /property tax payment of \$1,900\.00 due October 20, 2026 will not be paid by us after October 15, 2026; you are responsible for paying it directly to Franklin County Treasurer/);
  // a disbursement due on or before the good-through date is paid by the servicer as scheduled and is not in the paragraph
  const before = escrowParagraph({ escrow_balance_cents: 241_290n, good_through: D("2026-10-15"), scheduled_disbursements: [{ kind: "hazard", payee: "Insurer", amount_cents: 120_000n, due_on: D("2026-10-10") }] });
  assert.equal(before.borrower_to_pay.length, 0); assert.doesNotMatch(before.text, /will not be paid/);
  // the 3.5 new-loan credit election changes the treatment, never the cut-off
  const credit = escrowParagraph({ escrow_balance_cents: 241_290n, good_through: D("2026-10-15"), scheduled_disbursements: [{ kind: "tax", payee: "Franklin County Treasurer", amount_cents: 190_000n, due_on: D("2026-10-20") }], new_loan_credit_elected: true });
  assert.equal(credit.treatment, "new_loan_credit"); assert.equal(credit.refund_cents, 0n); assert.equal(credit.borrower_to_pay.length, 1);
  // the statement template (7.6) carries the §1024.34(b)(1) sentence the checklist requires
  const reg = published(); const v = reg.activeVersion("NTC_REGZ_36C3_PAYOFF_STMT", D("2026-09-01"))!; const payload = { ...v.samplePayload, escrow_balance_cents: 241_290n }; const out = render(v.source, payload);
  assert.match(out.text, /\$2,412\.90 is not deducted from the payoff and will be refunded within 20 business days after payoff/); assert.equal(evaluateChecklist(v, payload, out).results.find((r) => r.rule_id === "escrow")!.passed, true);
});
test("16.1-T11: Given a Connecticut request specifying a payoff date 5 BD ahead, then the deadline is 7 BD (statutory floor) and the federal 7-BD timer governs; if breached, the `interest_forfeit_if_late` flag opens a `qc_finding`.", async () => {
  const received = D("2026-09-14"); const requested = addBusinessDays(received, 5, servicer); assert.equal(requested, "2026-09-21");
  const ct = ctStatementDeadline({ received_on: received, requested_payoff_on: requested });
  assert.equal(ct.requested_business_days_ahead, 5); assert.equal(ct.statutory_floor_on, "2026-09-23"); assert.equal(ct.deadline_on, "2026-09-23"); assert.equal(ct.federal_due, "2026-09-23"); assert.equal(ct.governing, "federal");
  assert.equal(ct.interest_forfeit_if_late, true); assert.deepEqual(ct.timers, ["REGZ_1026_36C3_PAYOFF_STMT_7BD", "STATE_PAYOFF_STMT_DEADLINE"]); assert.match(ct.cite, /49-10a/);
  // a requested date at least 7 BD out is the CT date, but the federal 7-BD clock is still the earlier one
  const far = statementDeadlines("CT", received, D("2026-10-05")); assert.equal(far.state_due, "2026-10-05"); assert.equal(far.governing_due, "2026-09-23"); assert.equal(far.governing, "federal");
  // breached (sent Fri 09/25): the federal timer is the governing breach (sev-1); the state floor fell on the same day, so its interest-forfeiture exposure logs too and a qc_finding case opens with the interest forfeited from the request date
  const breach = statementDeadlineBreach({ state: "CT", request_on: received, requested_payoff_on: requested, sent_on: D("2026-09-25"), today: D("2026-09-25"), upb_cents: A.upb_cents, rate_pct: A.rate_pct });
  assert.equal(breach.breached, true); assert.equal(breach.severity, "sev1"); assert.equal(breach.governing, "federal"); assert.equal(breach.timer, "REGZ_1026_36C3_PAYOFF_STMT_7BD"); assert.equal(breach.due_on, "2026-09-23");
  assert.deepEqual(breach.timers_breached, ["REGZ_1026_36C3_PAYOFF_STMT_7BD", "STATE_PAYOFF_STMT_DEADLINE"]); assert.match(breach.exposure!, /interest forfeiture after the request date/);
  assert.equal(breach.case!.case_type, "qc_finding"); assert.equal(breach.case!.interest_forfeited_from, "2026-09-14"); assert.equal(breach.case!.per_diem_cents, 4_422n); assert.match(breach.case!.reason, /49-10a/);
  assert.equal(statementDeadlineBreach({ state: "CT", request_on: received, requested_payoff_on: requested, sent_on: D("2026-09-23"), today: D("2026-09-23"), upb_cents: A.upb_cents, rate_pct: A.rate_pct }).breached, false);
  // a CT request 10 BD out: the federal clock (09/23) still governs; sent 09/24 breaches only the federal timer — no state breach, no forfeiture case
  const farBreach = statementDeadlineBreach({ state: "CT", request_on: received, requested_payoff_on: D("2026-09-28"), sent_on: D("2026-09-24"), today: D("2026-09-24"), upb_cents: A.upb_cents, rate_pct: A.rate_pct });
  assert.equal(farBreach.breached, true); assert.deepEqual(farBreach.timers_breached, ["REGZ_1026_36C3_PAYOFF_STMT_7BD"]); assert.equal(farBreach.timer, "REGZ_1026_36C3_PAYOFF_STMT_7BD");
  const oh = statementDeadlineBreach({ state: "OH", request_on: received, sent_on: D("2026-09-25"), today: D("2026-09-25"), upb_cents: A.upb_cents, rate_pct: A.rate_pct }); assert.equal(oh.breached, true); assert.equal(oh.case, null); assert.equal(oh.timer, "REGZ_1026_36C3_PAYOFF_STMT_7BD"); assert.deepEqual(oh.timers_breached, ["REGZ_1026_36C3_PAYOFF_STMT_7BD"]);
  // on the bus: the CT request arms both clocks on 09/23 (the state floor = the federal date); nothing sent by Fri 09/25 → the engine breaches both, and escalate{statement_deadline_breach} opens the sev-1 escalation and the qc_finding case carrying the forfeited interest
  const h = harness("2026-09-14T15:00:00.000Z", "L-CT");
  await h.run("computePayoffQuote", { ...A_INPUT, loan_id: "L-CT", quote_id: "pq-ct", request_id: "pr-ct", state: "CT", good_through: "2026-09-21", requested_payoff_on: "2026-09-21" });
  const fed = h.timers.byCode("REGZ_1026_36C3_PAYOFF_STMT_7BD")[0]!; const st = h.timers.byCode("STATE_PAYOFF_STMT_DEADLINE")[0]!; assert.equal(fed.dueDate, "2026-09-23"); assert.equal(st.dueDate, "2026-09-23"); assert.equal(last(h, "payoff.request.received").payload.governing, "federal");
  h.clock.set("2026-09-25T15:00:00.000Z"); const breaches = h.timers.evaluate(h.clock.now()); assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity]).filter((b) => String(b[0]).includes("PAYOFF_STMT")).sort(), [["REGZ_1026_36C3_PAYOFF_STMT_7BD", 1], ["STATE_PAYOFF_STMT_DEADLINE", 1]]);
  assert.equal(fed.status, "breached"); assert.equal(st.status, "breached");
  const esc = (await h.run("escalate", { loan_id: "L-CT", reason_kind: "statement_deadline_breach", state: "CT", request_on: "2026-09-14", requested_payoff_on: "2026-09-21", quote_id: "pq-ct" })).output as ReturnType<typeof statementDeadlineBreach> & { escalation_id: string; case_id: string };
  assert.equal(esc.breached, true); assert.equal(esc.timer, "REGZ_1026_36C3_PAYOFF_STMT_7BD"); assert.deepEqual(esc.timers_breached, ["REGZ_1026_36C3_PAYOFF_STMT_7BD", "STATE_PAYOFF_STMT_DEADLINE"]); assert.equal(esc.case_id, "qc-L-CT-REGZ_1026_36C3_PAYOFF_STMT_7BD-2026-09-23");
  const opened = h.rt.escalations.opened.find((x) => x.id === esc.escalation_id)!; assert.equal(opened.kind, "sev1"); assert.equal(opened.ownerRole, "officer"); assert.match(String(opened.payload.exposure), /interest forfeiture/);
  const c = h.rt.store.get("cases", esc.case_id)!.data; assert.equal(c.kind, "qc_finding"); assert.equal(c.interest_forfeited_from, "2026-09-14"); assert.equal(c.per_diem_cents, 4_422n); assert.equal(c.status, "open"); assert.equal(c.escalation_id, esc.escalation_id);
  assert.deepEqual(h.events.ofType("case.opened").map((e) => [e.payload.kind, e.payload.case_id, e.payload.per_diem_cents]), [["qc_finding", esc.case_id, "4422"]]);
  // the same escalation in Ohio (no forfeiture rule) opens the sev-1 breach but no qc_finding; before the deadline nothing opens
  const oh2 = harness("2026-09-25T15:00:00.000Z", "L-OH"); const noCase = (await oh2.run("escalate", { loan_id: "L-OH", reason_kind: "statement_deadline_breach", state: "OH", request_on: "2026-09-14", upb_cents: A.upb_cents, rate_pct: A.rate_pct })).output as { breached: boolean; case_id: string | null };
  assert.equal(noCase.breached, true); assert.equal(noCase.case_id, null); assert.equal(oh2.rt.escalations.opened.length, 1);
  assert.equal(((await oh2.run("escalate", { loan_id: "L-OH", reason_kind: "statement_deadline_breach", state: "CT", request_on: "2026-09-14", today: "2026-09-22", upb_cents: A.upb_cents, rate_pct: A.rate_pct })).output as { breached: boolean }).breached, false); assert.equal(oh2.rt.escalations.opened.length, 1);
});
test("16.1-T12: Given an oral AI-voice request after identity verification, then the figure equals the engine's and the call transcript shows the automation disclosure, good-through, per diem, and the offer of a written statement.", async () => {
  // the figure the voice agent may speak is an existing payoff_quotes row — the engine's example-A figure, never the model's arithmetic
  const row = payoffQuoteRow({ components: A, ledger_snapshot_id: "ledger-hwm-88121" }); const engineQuote = { total_cents: row.total_cents, per_diem_cents: row.per_diem_cents, good_through: A.good_through };
  const refused = oralQuote({ channel: "ai_voice", identity_verified: false, state: "OH", quote: engineQuote });
  assert.equal(refused.allowed, false); assert.equal(refused.total_cents, null); assert.equal(refused.event, null); assert.match(refused.refusal!, /no oral figure before identity verification/); assert.equal(refused.transcript[0], "This call is handled by an automated assistant.");
  assert.deepEqual(refused.disclosures, { automation: true, good_through: false, per_diem: false, escrow_separate: false, written_offer: false });   // read back from the transcript: nothing but the disclosure was said
  assert.throws(() => quoteRequestIntake({ request_id: "qr-1", mode: "oral", requested_at: "2026-09-14T14:40:00.000Z", identity_verified: false }), /no oral figure before identity verification/);
  // on the bus: the unverified caller is refused before any figure exists; after verification the oral quote request (payoff.quote.requested{mode=oral}) arms SM_PAYOFF_ORAL_QUOTE_SAME_SESSION and the figure computed in the same call satisfies it — the transcript is the engine's
  const h = harness("2026-09-14T14:40:00.000Z");
  await assert.rejects(h.run("computePayoffQuote", { ...A_INPUT, quote_id: "pq-oral", quote_type: "oral", channel: "ai_voice", identity_verified: false }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_ORAL_BEFORE_IDV");
  assert.equal(h.events.ofType("payoff.quote.requested").length, 0); assert.equal(h.events.ofType("payoff.quote.computed").length, 0);
  const spoken = (await h.run("computePayoffQuote", { ...A_INPUT, quote_id: "pq-oral", quote_type: "oral", channel: "ai_voice", identity_verified: true })).output as { total_cents: bigint; per_diem_cents: bigint; quote_type: string; oral: ReturnType<typeof oralQuote> };
  assert.equal(spoken.quote_type, "oral"); assert.equal(spoken.total_cents, 25_039_082n); assert.equal(spoken.oral.total_cents, spoken.total_cents); assert.equal(spoken.oral.per_diem_cents, 4_422n); assert.equal(spoken.oral.good_through, "2026-10-15"); assert.equal(spoken.oral.binding, false);
  const t = spoken.oral.transcript.join(" ");
  assert.match(t, /This call is handled by an automated assistant/); assert.match(t, /good through October 15, 2026, is \$250,390\.82/); assert.match(t, /after October 15, 2026, add \$44\.22 for each additional day/); assert.match(t, /refunded separately within 20 business days after payoff/); assert.match(t, /Would you like the written statement\? Say yes or press 1/);
  assert.deepEqual(spoken.oral.disclosures, { automation: true, good_through: true, per_diem: true, escrow_separate: true, written_offer: true }); assert.equal(spoken.oral.written_offer, "one_click_written_request"); assert.equal(spoken.oral.timer_started, false);
  const requested = last(h, "payoff.quote.requested"); const computed = last(h, "payoff.quote.computed");
  assert.equal(requested.payload.mode, "oral"); assert.equal(requested.payload.identity_verified, true); assert.equal(computed.payload.quote_type, "oral"); assert.equal(computed.payload.oral, true); assert.equal(computed.payload.total_cents, "25039082");
  assert.equal(eventMatches(REG.get("SM_PAYOFF_ORAL_QUOTE_SAME_SESSION")!.triggerPattern!, requested), true); assert.equal(eventMatches(REG.get("SM_PAYOFF_ORAL_QUOTE_SAME_SESSION")!.satisfiedPattern!, computed), true);
  const oral = h.timers.byCode("SM_PAYOFF_ORAL_QUOTE_SAME_SESSION"); assert.equal(oral.length, 1); assert.equal(oral[0]!.dueDate, "2026-09-14"); assert.equal(oral[0]!.status, "satisfied"); assert.equal(oral[0]!.satisfiedByEventId, computed.id);
  assert.equal(h.events.ofType("payoff.request.received").length, 0); assert.equal(h.timers.byCode("REGZ_1026_36C3_PAYOFF_STMT_7BD").length, 0);   // an oral quote starts no §1026.36(c)(3) clock
  assert.equal(h.rt.store.get("payoff_quotes", "pq-oral")!.data.quote_type, "oral");
  // the spoken figure tracks the row it was read from (a waived late charge changes both), never a recomputation of its own
  const waivedRow = payoffQuoteRow({ components: A, ledger_snapshot_id: "ledger-hwm-88121", fee_waiver_cents: 8_217n });
  assert.equal(oralQuote({ channel: "ai_voice", identity_verified: true, state: "OH", quote: { total_cents: waivedRow.total_cents, per_diem_cents: waivedRow.per_diem_cents, good_through: A.good_through } }).total_cents, 25_039_082n - 8_217n);
  // the one-click written request starts the §1026.36(c)(3) clock (7.6-T5); in Florida the transcript says only the written estoppel binds
  assert.equal(oralQuote({ channel: "ai_voice", identity_verified: true, state: "OH", quote: engineQuote, clicked_written_at: "2026-09-14T14:41:00-04:00" }).timer_started, true);
  assert.match(oralQuote({ channel: "chat", identity_verified: true, state: "FL", quote: engineQuote }).transcript.join(" "), /in Florida only the written estoppel letter is binding/);
  // the portal quote: payoff.quote.requested{mode=portal} arms the 60-second SLA (SM_PAYOFF_PORTAL_QUOTE_60S), satisfied by the portal figure computed in the same call
  await h.run("computePayoffQuote", { ...A_INPUT, quote_id: "pq-portal", quote_type: "portal", channel: "portal" });
  const portal = h.timers.byCode("SM_PAYOFF_PORTAL_QUOTE_60S"); assert.equal(portal.length, 1); assert.equal(new Date(portal[0]!.dueAt!).toISOString(), "2026-09-14T14:41:00.000Z"); assert.equal(portal[0]!.status, "satisfied");
  assert.equal(eventMatches(REG.get("SM_PAYOFF_PORTAL_QUOTE_60S")!.triggerPattern!, last(h, "payoff.quote.requested")), true); assert.equal(eventMatches(REG.get("SM_PAYOFF_PORTAL_QUOTE_60S")!.satisfiedPattern!, last(h, "payoff.quote.computed")), true);
  assert.equal(eventMatches(REG.get("SM_PAYOFF_PORTAL_QUOTE_60S")!.satisfiedPattern!, computed), false);   // the oral figure does not display the portal quote
});
test("16.1-T13: Given an agent attempts `renderStatement` with a wire-instruction version that is not the vault's active version, then the gate blocks and a `security-records` alert is raised.", async () => {
  const h = harness(); const { rt, events, run } = h;
  await run("computePayoffQuote", A_INPUT); const hash = String(rt.store.get("payoff_quotes", "pq-1")!.data.hash);
  const tok = (await run("mintVerificationToken", { loan_id: "L-16", statement_hash: hash, wire_instruction_version_id: "wire-v4" })).output as ReturnType<typeof mintVerificationToken>;
  assert.equal(tok.token.length, 12); assert.match(tok.token, /^[A-HJ-NP-Z2-9]{12}$/); assert.equal(tok.verify_path, `/verify/${tok.token}`); assert.equal(rt.store.get("payoff_verification_tokens", tok.token)!.data.statement_hash, hash);
  assert.equal(tok.token, mintVerificationToken({ statement_hash: hash, wire_instruction_version_id: "wire-v4", issued_at: h.clock.now() }).token); assert.notEqual(tok.token, mintVerificationToken({ statement_hash: hash, wire_instruction_version_id: "wire-v3", issued_at: h.clock.now() }).token);
  const minted = rt.store.get("payoff_verification_tokens", tok.token)!.data as unknown as MintedToken;
  const g = wireVerifyGate({ wire_instruction_version_id: "wire-v3", active_vault_version_id: "wire-v4", verification_token: tok.token, statement_hash: hash, minted });
  assert.equal(g.gate, "SM_PAYOFF_WIRE_VERIFY_GATE"); assert.equal(g.open, false); assert.deepEqual(g.alert, { to: "security-records", kind: "fraud_officer", severity: "sev1", signal: "stale_wire_instruction_version", never_approved: true });
  // the agent's attempt with the stale version: blocked, nothing rendered, the security-records alert opened as an escalation event
  const before = events.all().length;
  await assert.rejects(run("renderStatement", { loan_id: "L-16", quote_id: "pq-1", wire_instruction_version_id: "wire-v3", active_wire_instruction_version_id: "wire-v4", verification_token: tok.token }), /SM_PAYOFF_WIRE_VERIFY_GATE closed: wire instruction version wire-v3 is not the vault's active version wire-v4/);
  assert.equal(rt.escalations.opened.length, 1); const alert = rt.escalations.opened[0]!;
  assert.equal(alert.ownerRole, "security-records"); assert.equal(alert.kind, "fraud_officer"); assert.equal(alert.severity, "sev1"); assert.equal(alert.payload.signal, "stale_wire_instruction_version"); assert.equal(alert.payload.never_approved, true); assert.equal(alert.loanId, "L-16");
  assert.deepEqual(events.all().slice(before).filter((e) => e.type === "escalation.created" || e.type === "payoff.statement.render_blocked" || e.type === "command.executed" || e.type === "payoff.statement.rendered").map((e) => e.type), ["escalation.created", "payoff.statement.render_blocked"]);
  assert.equal(rt.store.get("payoff_statements", "ps-pq-1"), undefined);
  // "statement render" armed both gates (accuracy 7.6 + wire) before the block, with the facts their evaluators read on the arming event: the stale attempt evaluates closed
  const armed = last(h, "notice.render_requested"); assert.equal(armed.payload.template, "NTC_REGZ_36C3_PAYOFF_STMT"); assert.equal(h.timers.byCode("SM_PAYOFF_WIRE_VERIFY_GATE").length, 1); assert.equal(h.timers.byCode("SM_PAYOFF_STMT_ACCURACY_GATE").length, 1);
  assert.equal(eventMatches(REG.get("SM_PAYOFF_WIRE_VERIFY_GATE")!.triggerPattern!, armed), true); assert.equal(h.timers.byCode("SM_PAYOFF_WIRE_VERIFY_GATE")[0]!.note, "evaluator:16.1.wireInstructionsVerified");
  const stale = evaluateGate("16.1.wireInstructionsVerified", armed.payload); assert.equal(stale.open, false); assert.match(stale.reason!, /wire-v3 is not the vault's active version wire-v4 — fraud signal to security-records/);
  // e-mailed/inline wire instructions never reach the handler (guardrail); a token nobody minted for this statement is a fraud signal too
  await assert.rejects(run("renderStatement", { loan_id: "L-16", quote_id: "pq-1", wire_instruction_source: "email", wire_instruction_version_id: "wire-v4", active_wire_instruction_version_id: "wire-v4", verification_token: tok.token }), (e: unknown) => e instanceof CommandRefused && e.code === "WIRE_FROM_VAULT_ONLY");
  await assert.rejects(run("renderStatement", { loan_id: "L-16", quote_id: "pq-1", wire_instruction_version_id: "wire-v4", active_wire_instruction_version_id: "wire-v4", verification_token: "ABCDEFGHJKLM" }), /SM_PAYOFF_WIRE_VERIFY_GATE closed: verification token ABCDEFGHJKLM was not minted for statement hash/);
  assert.equal(rt.escalations.opened.length, 2); assert.equal(rt.escalations.opened[1]!.payload.signal, "unminted_verification_token");
  assert.equal(wireVerifyGate({ wire_instruction_version_id: "wire-v4", active_vault_version_id: "wire-v4", verification_token: null }).reason, "verification token not minted");
  assert.equal(wireVerifyGate({ wire_instruction_version_id: "wire-v4", active_vault_version_id: "wire-v4", verification_token: tok.token, statement_hash: "another-hash", minted }).alert!.signal, "unminted_verification_token");
  // the accuracy gate (7.6) is consulted too: with the active version and the minted token, an unasserted gate still blocks; asserted (ledger clean, no pending reversal, rates final) the statement renders
  await assert.rejects(run("renderStatement", { loan_id: "L-16", quote_id: "pq-1", wire_instruction_version_id: "wire-v4", active_wire_instruction_version_id: "wire-v4", verification_token: tok.token, state: "OH" }), /SM_PAYOFF_STMT_ACCURACY_GATE closed: not asserted for quote pq-1/);
  const gated = (await run("assertAccuracyGate", { loan_id: "L-16", quote_id: "pq-1", ledger_clean: true, pending_reversal: true, rate_segments_final: true })).output as { open: boolean; state: string }; assert.equal(gated.open, false); assert.equal(gated.state, "gated");
  await assert.rejects(run("renderStatement", { loan_id: "L-16", quote_id: "pq-1", wire_instruction_version_id: "wire-v4", active_wire_instruction_version_id: "wire-v4", verification_token: tok.token, state: "OH" }), /SM_PAYOFF_STMT_ACCURACY_GATE closed: hold: a reversal is pending/);
  assert.equal(evaluateGate("7.6.payoffStatementAccuracy", last(h, "notice.render_requested").payload).open, false);
  await run("assertAccuracyGate", { loan_id: "L-16", quote_id: "pq-1", ledger_clean: true, pending_reversal: false, rate_segments_final: true });
  const ok = await run("renderStatement", { loan_id: "L-16", quote_id: "pq-1", wire_instruction_version_id: "wire-v4", active_wire_instruction_version_id: "wire-v4", verification_token: tok.token, state: "OH" });
  const row = ok.output as { status: string; verification_token: string; wire_instruction_version_id: string; total_cents: bigint; hash: string; state_variant: string }; assert.equal(row.status, "rendered"); assert.equal(row.verification_token, tok.token); assert.equal(row.wire_instruction_version_id, "wire-v4"); assert.equal(row.total_cents, quote16(A).total_cents); assert.equal(row.hash, hash); assert.equal(row.state_variant, "NTC_REGZ_36C3_PAYOFF_STMT");
  assert.equal(rt.escalations.opened.length, 2); assert.equal(rt.store.get("payoff_statements", "ps-pq-1")!.data.status, "rendered");
  const good = last(h, "notice.render_requested"); assert.equal(evaluateGate("16.1.wireInstructionsVerified", good.payload).open, true); assert.equal(evaluateGate("7.6.payoffStatementAccuracy", good.payload).open, true);
  // a figure supplied to the render is refused outright — figures only from payoff_quotes
  await assert.rejects(run("renderStatement", { loan_id: "L-16", quote_id: "pq-1", wire_instruction_version_id: "wire-v4", active_wire_instruction_version_id: "wire-v4", verification_token: tok.token, total_cents: 1n }), (e: unknown) => e instanceof CommandRefused && e.code === "FIGURES_FROM_QUOTES_ONLY");
});
test("16.1-T14: Given a NIB loan maturing 06/01/2027, then `NTC_FNMA_NIB_BALANCE_NOTICE` is sent between 12/03/2026 and 01/02/2027 and, absent contact, a second between 03/18 and 04/02/2027.", () => {
  const n = nibMaturityNotices({ maturity_on: D("2027-06-01"), nib_cents: 1_200_000n });
  assert.equal(n.applies, true); assert.equal(n.contact_attempt_required, true); assert.equal(n.anchor_kind, "maturity"); assert.equal(n.anchor_on, "2027-06-01");
  assert.deepEqual([n.first!.window_open, n.first!.window_close, n.first!.timer, n.first!.template, n.first!.sequence], ["2026-12-03", "2027-01-02", "FNMA_A42107_NIB_MATURITY_NOTICE_180_150", "NTC_FNMA_NIB_BALANCE_NOTICE", "first"]);
  assert.deepEqual([n.second!.window_open, n.second!.window_close, n.second!.timer, n.second!.sequence, n.second!.required], ["2027-03-18", "2027-04-02", "FNMA_A42107_NIB_MATURITY_NOTICE_75_60", "second", true]); assert.match(n.second!.reason, /no contact established by maturity − 75/);
  const reached = nibMaturityNotices({ maturity_on: D("2027-06-01"), nib_cents: 1_200_000n, contact_established_on: D("2027-02-10") }); assert.equal(reached.second!.required, false); assert.match(reached.second!.reason, /contact established 2027-02-10/);
  assert.equal(nibMaturityNotices({ maturity_on: D("2027-06-01"), nib_cents: 0n }).applies, false);
  // "prior to the maturity date or the projected date of payoff": a projected 04/01/2027 payoff moves the first window to 10/03–11/02/2026; the second stays anchored on maturity
  const proj = nibMaturityNotices({ maturity_on: D("2027-06-01"), nib_cents: 1_200_000n, projected_payoff_on: D("2027-04-01") });
  assert.equal(proj.anchor_kind, "projected_payoff"); assert.deepEqual([proj.first!.window_open, proj.first!.window_close], ["2026-10-03", "2026-11-02"]); assert.equal(proj.second!.anchor_on, "2027-06-01"); assert.equal(proj.second!.window_open, "2027-03-18");
  // the nightly sweep emits the arming events on the window-open days only, for NIB loans only, and the second only absent contact
  const loans = [{ loan_id: "L-NIB", maturity_on: D("2027-06-01"), nib_cents: 1_200_000n }, { loan_id: "L-IB", maturity_on: D("2027-06-01"), nib_cents: 0n }, { loan_id: "L-NIB-REACHED", maturity_on: D("2027-06-01"), nib_cents: 500_000n, contact_established_on: D("2027-02-10") }];
  const first = nibMaturitySweep({ today: D("2026-12-03"), loans }); assert.deepEqual(first.map((e) => [e.loan_id, e.payload.days_before, e.payload.contact, e.payload.anchor_date, e.payload.timer]), [["L-NIB", 180, false, "2027-06-01", "FNMA_A42107_NIB_MATURITY_NOTICE_180_150"], ["L-NIB-REACHED", 180, true, "2027-06-01", "FNMA_A42107_NIB_MATURITY_NOTICE_180_150"]]);
  assert.equal(nibMaturitySweep({ today: D("2026-12-04"), loans }).length, 0);
  const second = nibMaturitySweep({ today: D("2027-03-18"), loans }); assert.deepEqual(second.map((e) => [e.loan_id, e.payload.days_before, e.payload.contact, e.payload.timer]), [["L-NIB", 75, false, "FNMA_A42107_NIB_MATURITY_NOTICE_75_60"]]);
  // in the engine: the 12/03 event arms the 180→150 window (due 01/02/2027) and the first notice satisfies it; the 03/18 event arms the 75→60 window (due 04/02/2027), satisfied by the second notice — or by contact established
  const clock = new FixedClock("2026-12-03T07:00:00.000Z"); const events = new MemoryEventStore(clock); const eng = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["16.1"] });
  for (const e of first) events.append({ type: e.type, loanId: e.loan_id, actor: SYS, payload: { ...e.payload, nib_cents: e.payload.nib_cents.toString() } });
  const w1 = eng.byCode("FNMA_A42107_NIB_MATURITY_NOTICE_180_150"); assert.equal(w1.length, 2); assert.equal(w1[0]!.anchorDate, "2027-06-01"); assert.equal(w1[0]!.dueDate, "2027-01-02"); assert.match(w1[0]!.note!, /window opens 2026-12-03/);
  events.append({ type: "notice.sent", loanId: "L-NIB", actor: SYS, payload: { template: "NTC_FNMA_NIB_BALANCE_NOTICE", sequence: "first" } }); assert.equal(w1[0]!.status, "satisfied"); assert.equal(w1[1]!.status, "armed");
  clock.set("2027-03-18T07:00:00.000Z"); for (const e of second) events.append({ type: e.type, loanId: e.loan_id, actor: SYS, payload: { ...e.payload, nib_cents: e.payload.nib_cents.toString() } });
  const w2 = eng.byCode("FNMA_A42107_NIB_MATURITY_NOTICE_75_60"); assert.equal(w2.length, 1); assert.equal(w2[0]!.loanId, "L-NIB"); assert.equal(w2[0]!.anchorDate, "2027-06-01"); assert.equal(w2[0]!.dueDate, "2027-04-02"); assert.match(w2[0]!.note!, /window opens 2027-03-18/);
  events.append({ type: "notice.sent", loanId: "L-NIB", actor: SYS, payload: { template: "NTC_FNMA_NIB_BALANCE_NOTICE", sequence: "first" } }); assert.equal(w2[0]!.status, "armed");   // a repeat first notice is not the second
  events.append({ type: "payoff.nib_maturity.resolved", loanId: "L-NIB", actor: SYS, payload: { outcome: "contact_established", contact_on: "2027-03-20" } }); assert.equal(w2[0]!.status, "satisfied");
  events.append({ type: "loan.maturity.approaching", loanId: "L-NIB-2", actor: SYS, payload: { days_before: 75, nib: true, contact: false, maturity_date: "2027-06-01", anchor_date: "2027-06-01" } });
  const w3 = eng.byCode("FNMA_A42107_NIB_MATURITY_NOTICE_75_60")[1]!; events.append({ type: "payoff.nib_maturity.resolved", loanId: "L-NIB-2", actor: SYS, payload: { outcome: "second_notice_sent" } }); assert.equal(w3.status, "satisfied");
  // the notice itself: the first on 12/03/2026 (180 days before) and the second on 03/18/2027 (75 days before) both pass the A4-2.1-07 checklist; a first notice at 140 days does not
  const reg = published(); const v = reg.activeVersion("NTC_FNMA_NIB_BALANCE_NOTICE", D("2026-09-01"))!;
  const p1 = { ...v.samplePayload, ...nibNoticePayload({ notice_date: D("2026-12-03"), maturity_on: D("2027-06-01"), nib_cents: 1_200_000n, ib_upb_cents: 18_000_000n, sequence: "first" }) };
  const o1 = render(v.source, p1); const c1 = evaluateChecklist(v, p1, o1);
  assert.equal(p1.days_before_maturity, 180); assert.equal(p1.days_before_anchor, 180); assert.equal(p1.anchor_kind, "maturity"); assert.equal(c1.passed, true, c1.blocking.map((r) => r.rule_id).join(","));
  assert.match(o1.text, /non-interest-bearing balance of \$12,000\.00/); assert.match(o1.text, /maturity date of your loan, June 1, 2027/); assert.match(o1.text, /does not accrue interest/); assert.match(o1.text, /total principal you would owe at maturity, before interest and other charges, is \$192,000\.00/); assert.match(o1.text, /sent 180 days before your maturity date/); assert.doesNotMatch(o1.text, /second notice/i); assert.doesNotMatch(o1.text, /projected date of payoff/);
  const p2 = { ...v.samplePayload, ...nibNoticePayload({ notice_date: D("2027-03-18"), maturity_on: D("2027-06-01"), nib_cents: 1_200_000n, ib_upb_cents: 18_000_000n, sequence: "second" }) };
  const o2 = render(v.source, p2); const c2 = evaluateChecklist(v, p2, o2); assert.equal(p2.days_before_maturity, 75); assert.equal(c2.passed, true, c2.blocking.map((r) => r.rule_id).join(",")); assert.match(o2.text, /Second notice: /); assert.match(o2.text, /This is our second notice/);
  const lateFirst = { ...p1, notice_date: "2027-01-12", days_before_maturity: 140, days_before_anchor: 140 }; assert.ok(evaluateChecklist(v, lateFirst, render(v.source, lateFirst)).blocking.map((r) => r.rule_id).includes("window-first"));
  const lateSecond = { ...p2, notice_date: "2027-04-10", days_before_maturity: 52 }; assert.ok(evaluateChecklist(v, lateSecond, render(v.source, lateSecond)).blocking.map((r) => r.rule_id).includes("window-second"));
  // a projected-payoff first notice on 10/03/2026 names the projected date and passes on the anchor window; a second notice anchored on the projected date is refused
  const p3 = { ...v.samplePayload, ...nibNoticePayload({ notice_date: D("2026-10-03"), maturity_on: D("2027-06-01"), nib_cents: 1_200_000n, ib_upb_cents: 18_000_000n, sequence: "first", projected_payoff_on: D("2027-04-01") }) };
  const o3 = render(v.source, p3); const c3 = evaluateChecklist(v, p3, o3); assert.equal(p3.anchor_kind, "projected_payoff"); assert.equal(p3.days_before_anchor, 180); assert.equal(p3.days_before_maturity, 241); assert.equal(c3.passed, true, c3.blocking.map((r) => r.rule_id).join(","));
  assert.match(o3.text, /projected date of payoff of your loan is April 1, 2027/); assert.match(o3.text, /sent 180 days before the projected date of payoff of your loan, April 1, 2027/);
  const wrongSecond = { ...p2, anchor_kind: "projected_payoff", anchor_date: "2027-04-01", projected_payoff_date: "2027-04-01" }; assert.ok(evaluateChecklist(v, wrongSecond, render(v.source, wrongSecond)).blocking.map((r) => r.rule_id).includes("second-anchor"));
  const t = reg.template("NTC_FNMA_NIB_BALANCE_NOTICE"); assert.equal(t.ownerSection, "16.1"); assert.equal(t.channelPolicy, "esign_or_mail"); assert.match(t.citation, /A4-2\.1-07/);
});
test("16.1-T15: Given a payment reversal on an active statement, then a recompute occurs, the updated statement goes to every prior recipient within 1 BD, and the original is retained with `superseded_by`.", async () => {
  const original = quote16(A); const stmt = { id: "ps-1", sent_on: D("2026-09-15"), good_through: D("2026-10-15"), total_cents: original.total_cents, recipients: RECIPIENTS };
  // Fri 10/09: the September installment is reversed (returned unpaid) → UPB back to the pre-payment balance, LPI 08/01, a second late charge (August + September full months: one rounding, rule 3)
  const reversed: Components = { ...A, upb_cents: 24_860_724n, lpi_due: D("2026-08-01"), late_charges_cents: 8_217n + 8_217n }; const recomputed = quote16(reversed);
  assert.deepEqual([recomputed.interest.months_full, recomputed.interest.days_partial], [2, 14]); assert.equal(recomputed.interest.full_cents, divRound(24_860_724n * 6500n * 2n, 100_000n * 12n));
  const r = recomputeOnEvent({ statement: stmt, trigger: { event: "payment.reversed", occurred_on: D("2026-10-09"), description: "the September 1, 2026 installment of $1,643.38 was reversed (returned unpaid)" }, today: D("2026-10-09"), new_total_cents: recomputed.total_cents });
  assert.equal(r.active, true); assert.equal(r.recompute, true); assert.equal(r.event, "payoff.quote.recompute"); assert.equal(r.delta_cents, recomputed.total_cents - original.total_cents); assert.ok(r.delta_cents > 0n);
  assert.equal(r.timer, "SM_PAYOFF_STMT_UPDATE_1BD"); assert.equal(r.updated!.template, "NTC_PAYOFF_UPDATED_STMT"); assert.equal(r.updated!.due_by, "2026-10-13"); assert.equal(r.updated!.due_by, addBusinessDays(D("2026-10-09"), 1, servicer));
  assert.deepEqual(r.updated!.send_to, RECIPIENTS); assert.equal(r.updated!.total_cents, recomputed.total_cents); assert.equal(r.updated!.previous_total_cents, original.total_cents);
  assert.match(r.updated!.explanation, /was reversed \(returned unpaid\) on October 9, 2026 \(payment\.reversed\); the total changed by \$/);
  assert.deepEqual(r.original, { id: "ps-1", status: "superseded", superseded_by: r.updated!.id, retained: true });
  // "to all prior recipients": a send that drops the refinancing lender's copy does not cover the prior recipients; one to all three does
  assert.deepEqual(updatedStatementRecipients({ prior: RECIPIENTS, proposed: RECIPIENTS.slice(0, 2) }), { all_prior_recipients: false, missing: [RECIPIENTS[2]!], prior_count: 3 });
  assert.deepEqual(updatedStatementRecipients({ prior: RECIPIENTS, proposed: [...RECIPIENTS].reverse() }), { all_prior_recipients: true, missing: [], prior_count: 3 });
  assert.equal(updatedStatementRecipients({ prior: [], proposed: RECIPIENTS }).all_prior_recipients, false);
  // an expired statement is not recomputed; a Δ = 0 recompute issues nothing and leaves the original active
  assert.equal(recomputeOnEvent({ statement: stmt, trigger: { event: "payment.reversed", occurred_on: D("2026-10-20"), description: "reversal" }, today: D("2026-10-20"), new_total_cents: recomputed.total_cents }).recompute, false);
  const same = recomputeOnEvent({ statement: stmt, trigger: { event: "fee.waived", occurred_on: D("2026-10-09"), description: "waiver" }, today: D("2026-10-09"), new_total_cents: original.total_cents }); assert.equal(same.updated, null); assert.equal(same.original.status, "active");
  // the 7.6 updated-statement template carries the explained Δ with the new and previous totals
  const reg = published(); const v = reg.activeVersion("NTC_PAYOFF_UPDATED_STMT", D("2026-09-01"))!;
  const payload = { ...v.samplePayload, original_statement_date: "2026-09-15", reason: r.updated!.explanation, change_date: "2026-10-09", good_through: "2026-10-15", total_cents: r.updated!.total_cents, previous_total_cents: original.total_cents, per_diem_cents: recomputed.per_diem_cents };
  const out = render(v.source, payload); assert.equal(evaluateChecklist(v, payload, out).passed, true); assert.match(out.text, /supersedes the statement dated September 15, 2026/); assert.match(out.text, /\(previously \$250,390\.82\)/); assert.match(out.text, /original statement is retained in our records/);
  // on the bus: statement rendered and sent to three recipients; the reversal's recompute runs the calculator on the post-reversal ledger (an `updated` payoff_quotes row — no total is ever supplied), arms SM_PAYOFF_STMT_UPDATE_1BD (due Tue 10/13); the update must name its reason, reach every prior recipient, and the original rows are superseded_by the update
  const h = harness(); const { rt, events, timers, run } = h;
  await run("computePayoffQuote", A_INPUT); await issue(h, "L-16", "pq-1", "ps-1", { state: "OH" });
  await run("sendNotice", { loan_id: "L-16", template_code: "NTC_REGZ_36C3_PAYOFF_STMT", statement_id: "ps-1", recipients: RECIPIENTS, payload: DISPLAY("NTC_REGZ_36C3_PAYOFF_STMT") });
  assert.equal(rt.store.get("payoff_statements", "ps-1")!.data.status, "sent"); assert.equal((rt.store.get("payoff_statements", "ps-1")!.data.delivered_to as unknown[]).length, 3);
  h.clock.set("2026-10-09T15:00:00.000Z");
  const ledger = { loan_id: "L-16", statement_id: "ps-1", trigger_event: "payment.reversed", occurred_on: "2026-10-09", upb_cents: 24_860_724n, lpi_due: "2026-08-01", late_charges_cents: 16_434n, ledger_snapshot_id: "ledger-hwm-88240" };
  await assert.rejects(run("scheduleRecompute", { ...ledger, new_total_cents: recomputed.total_cents, reason: "reversal" }), (e: unknown) => e instanceof CommandRefused && e.code === "FIGURES_FROM_QUOTES_ONLY");
  await assert.rejects(run("scheduleRecompute", ledger), (e: unknown) => e instanceof CommandRefused && e.code === "RECOMPUTE_DELTA_EXPLAINED");
  const rc = (await run("scheduleRecompute", { ...ledger, reason: "the September 1, 2026 installment of $1,643.38 was reversed (returned unpaid)" })).output as ReturnType<typeof recomputeOnEvent> & { quote_id: string; recomputed_total_cents: bigint };
  assert.equal(rc.quote_id, "pq-1-u1"); assert.equal(rc.recomputed_total_cents, recomputed.total_cents); assert.equal(rc.delta_cents, r.delta_cents); assert.equal(rc.updated!.id, r.updated!.id); assert.deepEqual(rc.updated!.send_to, RECIPIENTS); assert.equal(rc.updated!.due_by, "2026-10-13");
  const uq = rt.store.get("payoff_quotes", "pq-1-u1")!.data; assert.equal(uq.quote_type, "updated"); assert.equal(uq.total_cents, recomputed.total_cents); assert.equal(uq.supersedes_quote_id, "pq-1"); assert.equal(uq.ledger_snapshot_id, "ledger-hwm-88240"); assert.equal(uq.months_full, 2); assert.match(String(uq.reason), /returned unpaid/);
  assert.equal(rt.store.get("payoff_quotes", "pq-1")!.data.superseded_by_id, "pq-1-u1"); assert.equal(rt.store.get("payoff_quotes", "pq-1")!.data.total_cents, original.total_cents);   // the original figure is retained; only the back-link is set
  const upd = timers.byCode("SM_PAYOFF_STMT_UPDATE_1BD"); assert.equal(upd.length, 1); assert.equal(upd[0]!.dueDate, "2026-10-13"); assert.equal(upd[0]!.status, "armed");
  assert.deepEqual(rt.store.get("payoff_statements", "ps-1")!.data.superseded_by, r.updated!.id); assert.equal(rt.store.get("payoff_statements", "ps-1")!.data.status, "superseded"); assert.equal(rt.store.history("payoff_statements", "ps-1").length, 3);   // rendered → sent → superseded, every version retained
  assert.deepEqual(events.ofType("payoff.statement.updated").map((e) => [e.payload.state, e.payload.payment_date, e.payload.updated_statement_id, e.payload.quote_id]), [["OH", "2026-10-15", r.updated!.id, "pq-1-u1"]]);
  assert.deepEqual(events.ofType("payoff.quote.recompute").map((e) => [e.payload.quote_id, e.payload.delta]), [["pq-1-u1", r.delta_cents.toString()]]);
  await assert.rejects(run("sendNotice", { loan_id: "L-16", template_code: "NTC_PAYOFF_UPDATED_STMT", statement_id: r.updated!.id, recipients: RECIPIENTS.slice(0, 2), payload: DISPLAY("NTC_PAYOFF_UPDATED_STMT") }), /updated statement must go to every prior recipient \(SM_PAYOFF_STMT_UPDATE_1BD\); missing: refi-lender\/email/);
  assert.equal(upd[0]!.status, "armed");
  await assert.rejects(run("sendNotice", { loan_id: "L-16", template_code: "NTC_PAYOFF_UPDATED_STMT", statement_id: r.updated!.id, recipients: RECIPIENTS, payload: { ...DISPLAY("NTC_PAYOFF_UPDATED_STMT"), total_cents: 1n } }), (e: unknown) => e instanceof CommandRefused && e.code === "FIGURES_FROM_QUOTES_ONLY");
  const sent = (await run("sendNotice", { loan_id: "L-16", template_code: "NTC_PAYOFF_UPDATED_STMT", statement_id: r.updated!.id, recipients: RECIPIENTS, payload: DISPLAY("NTC_PAYOFF_UPDATED_STMT") })).output as { all_prior_recipients: boolean; checklist_passed: boolean };
  assert.equal(sent.all_prior_recipients, true); assert.equal(sent.checklist_passed, true); assert.equal(upd[0]!.status, "satisfied");
  assert.deepEqual(events.ofType("payoff.statement.sent").map((e) => [e.payload.updated, e.payload.all_prior_recipients]), [[false, false], [true, true]]);
  const notice = h.notices.all().find((n) => n.templateCode === "NTC_PAYOFF_UPDATED_STMT")!; assert.match(notice.rendered.text, /supersedes the statement dated September 15, 2026/); assert.match(notice.rendered.text, /\(previously \$250,390\.82\)/); assert.ok(notice.rendered.text.includes(`Updated total amount to pay your loan in full as of October 15, 2026: ${fmt(recomputed.total_cents)}`));
  assert.equal(rt.store.get("payoff_statement_updates", r.updated!.id)!.data.status, "sent");
  // a superseded statement is never re-sent
  await assert.rejects(run("sendNotice", { loan_id: "L-16", template_code: "NTC_REGZ_36C3_PAYOFF_STMT", statement_id: "ps-1", recipients: RECIPIENTS, payload: DISPLAY("NTC_REGZ_36C3_PAYOFF_STMT") }), /statement ps-1 is superseded/);
});
const fmt = (c: bigint): string => `$${(Number(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test("16.1 timers on the bus: every 16.1 row arms on an event the tools append and is satisfied by one they append — the Florida title-company request end to end, the NIB sweep, and the oral/portal quotes", async () => {
  const h = harness("2026-09-15T14:00:00.000Z", "L-FL"); const { rt, run, timers } = h;
  // 1. a title company's written request through the verification portal, received Mon 09/14, no authorization attached, good-through 10/15 (a 45-day request is capped to the 30-day window: good-through 10/15)
  const q = (await run("computePayoffQuote", { ...A_INPUT, loan_id: "L-FL", quote_id: "pq-fl", request_id: "pr-fl", state: "FL", channel: "verification_portal", requester_type: "lender_or_title", authorization_evidence: false, borrower_party_ids: ["borrower"] })).output as { third_party: { third_party: boolean; action: string; due_on: string } };
  assert.equal(q.third_party.third_party, true); assert.equal(q.third_party.action, "authorization_request_sent"); assert.equal(q.third_party.due_on, "2026-09-15");
  const received = last(h, "payoff.request.received");
  assert.deepEqual([received.payload.written, received.payload.requester, received.payload.requester_type, received.payload.received_on, received.payload.statutory_statement_due, received.payload.federal_statement_due, received.payload.governing, received.payload.good_through, received.payload.good_through_capped], [true, "third_party", "lender_or_title", "2026-09-14", "2026-09-24", "2026-09-23", "federal", "2026-10-15", false]);
  for (const code of ["REGZ_1026_36C3_PAYOFF_STMT_7BD", "STATE_PAYOFF_STMT_DEADLINE", "SM_PAYOFF_GOOD_THROUGH_MAX_30", "SM_PAYOFF_THIRD_PARTY_AUTH_1BD"]) { assert.equal(eventMatches(REG.get(code)!.triggerPattern!, received), true, code); assert.equal(timers.byCode(code).length, 1, code); }
  assert.deepEqual([timers.byCode("REGZ_1026_36C3_PAYOFF_STMT_7BD")[0]!.dueDate, timers.byCode("STATE_PAYOFF_STMT_DEADLINE")[0]!.dueDate, timers.byCode("SM_PAYOFF_THIRD_PARTY_AUTH_1BD")[0]!.dueDate], ["2026-09-23", "2026-09-24", "2026-09-15"]);
  assert.equal(timers.byCode("SM_PAYOFF_GOOD_THROUGH_MAX_30")[0]!.note, "evaluator:16.1.goodThroughWithin30Days"); assert.equal(evaluateGate("16.1.goodThroughWithin30Days", received.payload).open, true);
  const farOut = payoffRequestIntake({ request_id: "pr-far", loan_id: "L-FL", channel: "email", written: true, received_on: D("2026-09-14"), state: "FL", requester_type: "borrower", authorization_evidence: false, requested_good_through: D("2026-10-29") });
  assert.deepEqual([farOut.event.payload.good_through, farOut.event.payload.good_through_capped], ["2026-10-15", true]); assert.equal(evaluateGate("16.1.goodThroughWithin30Days", farOut.event.payload).open, true); assert.equal(evaluateGate("16.1.goodThroughWithin30Days", { received_on: "2026-09-14", good_through: "2026-10-29" }).open, false);
  // 2. the authorization request to the borrower of record resolves the third-party clock within 1 BD
  await run("sendNotice", { loan_id: "L-FL", template_code: "NTC_PAYOFF_AUTHORIZATION_REQUEST", request_id: "pr-fl", recipients: [{ party_id: "borrower", channel: "mail", address: "1 Test St, Testville FL 33101", email: "bea@example.test" }], payload: noticeReg.activeVersion("NTC_PAYOFF_AUTHORIZATION_REQUEST", D("2026-09-01"))!.samplePayload });
  const resolved = last(h, "payoff.request.third_party.resolved"); assert.equal(resolved.payload.outcome, "authorization_request_sent"); assert.equal(eventMatches(REG.get("SM_PAYOFF_THIRD_PARTY_AUTH_1BD")!.satisfiedPattern!, resolved), true); assert.equal(timers.byCode("SM_PAYOFF_THIRD_PARTY_AUTH_1BD")[0]!.status, "satisfied");
  assert.equal(rt.store.get("payoff_requests", "pr-fl")!.data.status, "authorization_requested");
  // 3. render (both gates armed with their facts) — then the statement to the title company alone is refused until the borrower of record is copied
  const { token, row } = await issue(h, "L-FL", "pq-fl", "ps-fl", { state: "FL", escrow_balance_cents: 241_290n, hsa_note_flag: true });
  assert.equal(row.state_variant, "NTC_REGZ_36C3_PAYOFF_STMT_FL_701_04"); assert.equal(row.requester_type, "lender_or_title");
  const armed = last(h, "notice.render_requested"); assert.equal(evaluateGate("16.1.wireInstructionsVerified", armed.payload).open, true); assert.equal(evaluateGate("7.6.payoffStatementAccuracy", armed.payload).open, true);
  assert.equal(timers.byCode("SM_PAYOFF_WIRE_VERIFY_GATE").length, 1); assert.equal(timers.byCode("SM_PAYOFF_STMT_ACCURACY_GATE").length, 1);
  const titleCo = { party_id: "title-co", channel: "email", email: "closings@titleco.test", address: "500 Closing Blvd, Miami FL 33131" }; const borrower = { party_id: "borrower", channel: "email", email: "bea@example.test", address: "1 Test St, Testville FL 33101" };
  await assert.rejects(run("sendNotice", { loan_id: "L-FL", template_code: "NTC_REGZ_36C3_PAYOFF_STMT", statement_id: "ps-fl", recipients: [titleCo], payload: DISPLAY("NTC_REGZ_36C3_PAYOFF_STMT") }), /NO_UNVERIFIED_THIRD_PARTY: requester lender_or_title is an unverified third party and no borrower of record/);
  await assert.rejects(run("sendNotice", { loan_id: "L-FL", template_code: "NTC_REGZ_36C3_PAYOFF_STMT", statement_id: "ps-fl", requester_type: "lender_or_title", recipients: [titleCo], payload: DISPLAY("NTC_REGZ_36C3_PAYOFF_STMT") }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_UNVERIFIED_THIRD_PARTY");
  assert.equal(thirdPartyStatementGuard({ requester_type: "lender_or_title", requester_verified: false, recipients: [titleCo], borrower_party_ids: ["borrower"] }).allowed, false); assert.equal(thirdPartyStatementGuard({ requester_type: "attorney", requester_verified: true, recipients: [titleCo], borrower_party_ids: ["borrower"] }).allowed, true); assert.equal(thirdPartyStatementGuard({ requester_type: "confirmed_successor", requester_verified: false, recipients: [titleCo], borrower_party_ids: ["borrower"] }).third_party, false);
  assert.equal(h.events.ofType("payoff.statement.sent").length, 0);
  const sent = (await run("sendNotice", { loan_id: "L-FL", template_code: "NTC_REGZ_36C3_PAYOFF_STMT", statement_id: "ps-fl", recipients: [titleCo, borrower], payload: DISPLAY("NTC_REGZ_36C3_PAYOFF_STMT") })).output as { checklist_passed: boolean; payload: Record<string, unknown> };
  assert.equal(sent.checklist_passed, true); assert.equal(sent.payload.total_cents, "25039082"); assert.equal(sent.payload.calc_source, "16.1"); assert.equal(sent.payload.business_days_after_request, 1); assert.equal(sent.payload.verification_token, token);
  const stmtSent = last(h, "payoff.statement.sent"); for (const code of ["REGZ_1026_36C3_PAYOFF_STMT_7BD", "STATE_PAYOFF_STMT_DEADLINE"]) { assert.equal(eventMatches(REG.get(code)!.satisfiedPattern!, stmtSent), true, code); assert.equal(timers.byCode(code)[0]!.status, "satisfied", code); }
  const text = h.notices.all().find((n) => n.templateCode === "NTC_REGZ_36C3_PAYOFF_STMT")!.rendered.text;
  assert.match(text, /Total amount to pay your loan in full as of October 15, 2026: \$250,390\.82/); assert.match(text, /Florida Statutes section 701\.04/); assert.doesNotMatch(text, FL_DISCLAIMER_PATTERN);
  assert.ok(text.includes(`Verification token ${token}`)); assert.match(text, /verify at the portal or by calling the number on your statement/); assert.match(text, /HomeSaver Advance note is due and payable in full on sale or transfer/); assert.match(text, /escrow balance of \$2,412\.90 is not deducted/);
  // 4. a fee assessed after issue: the recompute (calculator on the post-event ledger) arms the FL corrected-estoppel cutoff and the 1-BD update clock; the corrected letter with delivery evidence satisfies both
  h.clock.set("2026-10-09T15:00:00.000Z");
  const rc = (await run("scheduleRecompute", { loan_id: "L-FL", statement_id: "ps-fl", trigger_event: "fee.assessed", occurred_on: "2026-10-09", late_charges_cents: 16_434n, ledger_snapshot_id: "ledger-hwm-88300", payment_date: "2026-10-15", reason: "the October 1, 2026 late charge of $82.17 was assessed (2.7)" })).output as { updated: { id: string } | null; delta_cents: bigint };
  assert.equal(rc.delta_cents, 8_217n); const updatedEv = last(h, "payoff.statement.updated"); assert.equal(eventMatches(REG.get("FL_701_04_CORRECTED_ESTOPPEL_CUTOFF")!.triggerPattern!, updatedEv), true); assert.equal(eventMatches(REG.get("SM_PAYOFF_STMT_UPDATE_1BD")!.triggerPattern!, last(h, "payoff.quote.recompute")), true);
  const cutoff = timers.byCode("FL_701_04_CORRECTED_ESTOPPEL_CUTOFF"); assert.equal(cutoff.length, 1); assert.equal(cutoff[0]!.dueDate, "2026-10-14"); assert.equal(new Date(cutoff[0]!.dueAt!).toISOString(), "2026-10-14T19:00:00.000Z"); assert.equal(timers.byCode("SM_PAYOFF_STMT_UPDATE_1BD")[0]!.dueDate, "2026-10-13");
  await run("sendNotice", { loan_id: "L-FL", template_code: "NTC_PAYOFF_UPDATED_STMT", statement_id: rc.updated!.id, recipients: [titleCo, borrower], delivery_evidence_document_id: "doc-fl-1", received_at: "2026-10-13T14:00:00-04:00", payload: DISPLAY("NTC_PAYOFF_UPDATED_STMT") });
  assert.equal(eventMatches(REG.get("FL_701_04_CORRECTED_ESTOPPEL_CUTOFF")!.satisfiedPattern!, last(h, "payoff.statement.delivered")), true); assert.equal(eventMatches(REG.get("SM_PAYOFF_STMT_UPDATE_1BD")!.satisfiedPattern!, last(h, "payoff.statement.sent")), true);
  assert.equal(cutoff[0]!.status, "satisfied"); assert.equal(timers.byCode("SM_PAYOFF_STMT_UPDATE_1BD")[0]!.status, "satisfied");
  // 5. the A4-2.1-07 sweep events (the nightly schedule appends nibMaturitySweep's output) and the notices/contact that resolve them
  const loans = [{ loan_id: "L-NIB", maturity_on: D("2027-06-01"), nib_cents: 1_200_000n }];
  h.clock.set("2026-12-03T07:00:00.000Z"); for (const e of nibMaturitySweep({ today: D("2026-12-03"), loans })) h.events.append({ type: e.type, loanId: e.loan_id, actor: SYS, payload: { ...e.payload, nib_cents: e.payload.nib_cents.toString() } });
  const nib = noticeReg.activeVersion("NTC_FNMA_NIB_BALANCE_NOTICE", D("2026-09-01"))!.samplePayload;
  await run("sendNotice", { loan_id: "L-NIB", template_code: "NTC_FNMA_NIB_BALANCE_NOTICE", sequence: "first", recipients: [{ party_id: "borrower", channel: "mail", address: "1 Test St, Testville OH 43001" }], payload: { ...nib, ...nibNoticePayload({ notice_date: D("2026-12-03"), maturity_on: D("2027-06-01"), nib_cents: 1_200_000n, ib_upb_cents: 18_000_000n, sequence: "first" }) } });
  assert.equal(eventMatches(REG.get("FNMA_A42107_NIB_MATURITY_NOTICE_180_150")!.satisfiedPattern!, last(h, "notice.sent")), true); assert.equal(timers.byCode("FNMA_A42107_NIB_MATURITY_NOTICE_180_150")[0]!.status, "satisfied");
  h.clock.set("2027-03-18T07:00:00.000Z"); for (const e of nibMaturitySweep({ today: D("2027-03-18"), loans })) h.events.append({ type: e.type, loanId: e.loan_id, actor: SYS, payload: { ...e.payload, nib_cents: e.payload.nib_cents.toString() } });
  await run("recordDecision", { loan_id: "L-NIB", action: "nib_maturity.contact_established", contact_on: "2027-03-20", channel: "phone", rationale: "borrower reached; balloon affordable" });
  assert.equal(eventMatches(REG.get("FNMA_A42107_NIB_MATURITY_NOTICE_75_60")!.satisfiedPattern!, last(h, "payoff.nib_maturity.resolved")), true); assert.equal(timers.byCode("FNMA_A42107_NIB_MATURITY_NOTICE_75_60")[0]!.status, "satisfied");
  // 6. the oral and portal quotes (rule 11)
  h.clock.set("2027-03-18T08:00:00.000Z");
  await run("computePayoffQuote", { ...A_INPUT, loan_id: "L-FL", quote_id: "pq-fl-oral", quote_type: "oral", channel: "ai_voice", identity_verified: true }); await run("computePayoffQuote", { ...A_INPUT, loan_id: "L-FL", quote_id: "pq-fl-portal", quote_type: "portal", channel: "portal" });
  assert.equal(timers.byCode("SM_PAYOFF_ORAL_QUOTE_SAME_SESSION")[0]!.status, "satisfied"); assert.equal(timers.byCode("SM_PAYOFF_PORTAL_QUOTE_60S")[0]!.status, "satisfied");
  // every 16.1 row: armed by these tools' events; the deadlines satisfied by them, the evaluator gates armed with their facts
  const rows = REG.forProcess("16.1").map((t) => t.code);
  assert.equal(rows.length, 12);
  for (const code of rows) {
    const inst = timers.byCode(code); assert.ok(inst.length >= 1, `${code} never armed`);
    const def = REG.get(code)!;
    if (def.offsetParsed.kind === "evaluator") assert.equal(inst[0]!.status, "armed", code); else assert.equal(inst[0]!.status, "satisfied", code);
  }
});

test("16.1 worked figures: example A — P&I $1,643.38 on $260,000.00 at 6.500%, late charge $82.17, UPB $248,310.55, recording fee $34.00, escrow $2,412.90; early funds interest $353.76 → overage $265.32; late funds $840.17, per-diem $221.10 vs exact $221.09 within $0.01 × days; example B — UPB $180,000.00 + NIB $12,000.00, interest $468.49, per diem $24.66, total $192,468.49, LAR principal $192,000.00", () => {
  const pi = levelPayment(26_000_000n, ratePercent("6.500"), 360); assert.equal(pi, 164_338n);
  const lateCharge = divRound(pi * 5n, 100n); assert.equal(lateCharge, 8_217n);                                    // 5% × $1,643.38 (2.7)
  const a: Components = { upb_cents: 24_831_055n, rate_pct: "6.500", lpi_due: D("2026-09-01"), good_through: D("2026-10-15"), late_charges_cents: lateCharge, recording_fee_cents: 3_400n };
  const q = quote16(a); assert.deepEqual([q.interest.months_full, q.interest.days_partial, q.interest.full_cents, q.interest.partial_cents, q.per_diem_cents], [1, 14, 134_502n, 61_908n, 4_422n]);
  assert.equal(q.total_cents, 24_831_055n + 134_502n + 61_908n + 8_217n + 3_400n); assert.equal(q.total_cents, 25_039_082n); assert.equal(q.escrow_note, "refunded_separately_20bd");
  const escrow = escrowParagraph({ escrow_balance_cents: 241_290n, good_through: a.good_through, scheduled_disbursements: [] }); assert.equal(escrow.refund_cents, 241_290n); assert.equal(escrow.refund_within_business_days, 20);
  // funds arrive early, Fri 10/09 by wire: exact interest through 10/08 = 8 partial days → overage 6 × $44.22
  const early = interestF109(a.upb_cents, a.rate_pct, a.lpi_due, D("2026-10-09")); assert.equal(early.days_partial, 8); assert.equal(early.partial_cents, 35_376n);
  const over = reconcile(a, q.total_cents, D("2026-10-09"), q.total_cents); assert.equal(over.outcome, "over"); assert.equal(over.variance_cents, 26_532n); assert.equal(over.variance_cents, 6n * q.per_diem_cents);
  assert.equal(fundsReceived({ components: a, statement_total_cents: q.total_cents, per_diem_cents: q.per_diem_cents, received_on: D("2026-10-09"), amount_received_cents: q.total_cents, state: "OH" }).overage_cents, 26_532n);
  // funds arrive late, Tue 10/20 at the statement amount: exact interest through 10/19 = 19 days; the per-diem instruction (5 × $44.22) is within $0.01 × 5 of the exact Δ
  const late = interestF109(a.upb_cents, a.rate_pct, a.lpi_due, D("2026-10-20")); assert.equal(late.days_partial, 19); assert.equal(late.partial_cents, 84_017n);
  const short = reconcile(a, q.total_cents, D("2026-10-20"), q.total_cents); assert.equal(short.outcome, "short"); assert.equal(short.variance_cents, -22_109n);
  const tol = perDiemTolerance({ statement_interest_cents: q.interest.partial_cents, exact_interest_cents: late.partial_cents, per_diem_cents: q.per_diem_cents, extra_days: 5 });
  assert.equal(tol.per_diem_amount_cents, 22_110n); assert.equal(tol.exact_extra_cents, 22_109n); assert.equal(tol.difference_cents, 1n); assert.equal(tol.tolerance_cents, 5n); assert.equal(tol.accepted, true); assert.equal(tol.absorbed_to, "payoff_rounding_expense"); assert.equal(tol.absorbed_cents, 1n);
  assert.equal(fundsReceived({ components: a, statement_total_cents: q.total_cents, per_diem_cents: q.per_diem_cents, received_on: D("2026-10-20"), amount_received_cents: q.total_cents, state: "OH" }).shortage_cents, 22_110n);
  assert.equal(shortageDisposition({ state: "OH", received_on: D("2026-10-20"), good_through: a.good_through, exact_total_cents: q.total_cents + 22_110n, amount_received_cents: q.total_cents }).disposition, "short_payoff_demand_1bd");
  // example B (payment deferral): NIB printed separately, interest 19 days on the interest-bearing UPB only; 16.2 reports LAR principal IB + NIB
  const b: Components = { upb_cents: 18_000_000n, rate_pct: "5.000", lpi_due: D("2026-11-01"), good_through: D("2026-11-20"), nib_deferred_cents: 1_200_000n };
  const qb = quote16(b); assert.equal(qb.interest.days_partial, 19); assert.equal(qb.interest.total_cents, 46_849n); assert.equal(qb.per_diem_cents, 2_466n); assert.equal(qb.nib_line_cents, 1_200_000n); assert.equal(qb.total_cents, 19_246_849n); assert.equal(qb.total_cents, 18_000_000n + 1_200_000n + 46_849n);
  assert.equal(fnmaShare({ type: "AA", upb_cents: b.upb_cents, nib_cents: 1_200_000n, note_rate_pct: "5.000", ptr_pct: "4.750", lpi_due: b.lpi_due, payoff_on: b.good_through }).principal_cents, 19_200_000n);
});
