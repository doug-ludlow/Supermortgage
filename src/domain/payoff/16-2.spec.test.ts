// 16.2 Remit payoff proceeds to Fannie Mae
// spec/sections/16-payoff-lien-release/16-2-remit-payoff-proceeds-to-fannie-mae.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { loadRegistry } from "../../kernel/timers/registry.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger, type AccountRef } from "../../kernel/ledger/ledger.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_16_2 } from "../../app/tools/section16-2.ts";
import { NoticeService, buildRegistry, publishAuthored } from "../../notices/index.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { interest, quote } from "./quote.ts";
import { fnmaShare, housekeeping } from "./remit.ts";
import { advanceSpecialRemittance, crsBatch, missedCrsCutoff, autodraftStop, postPayoffReceipt, statementShortageNoe, saInterestDeficit, applyToZero, housekeepingTasks, exactFigure, disposeVariance, applyUncuredPerNote, fnmaPayoffShare, fnmaDraftDate, finalityAtMs, payoffActivityPeriod, lar60DueMs, ssBd1Bd2Exception, acceptRemovalAck, refundOverage, reversePayoff, lar60Removal, escrowRefund, payoffLedgerSets, goodFundsClearing, payoffDate, matchFunds } from "./ops-16-2.ts";

const ET = "America/New_York";
const EX = { upb_cents: 19_950_000n, rate_pct: "6.250", lpi_due: D("2026-09-01"), good_through: D("2026-10-16") };
const SHARE = { type: "AA" as const, upb_cents: 19_950_000n, nib_cents: 0n, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: D("2026-09-01"), payoff_on: D("2026-10-16") };
const EXACT = 20_105_147n;                                            // $201,051.47 = UPB $199,500.00 + $1,551.47 interest at the note rate
const BUCKETS = { accrued_interest: 155_147n, principal: 19_950_000n, escrow_balance: 241_290n };
const AGENT: Actor = { kind: "agent", id: "payoff-release" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const REG = loadOverriddenRegistry();
const QUOTES = [{ quote_id: "Q-1187", loan_id: "L-1", total_cents: EXACT, good_through: D("2026-10-16") }];
const BORROWER = [{ partyId: "P-B", name: "A. Borrower", mailingAddress: "1 Test St, Columbus OH 43215" }];
const CLOSING_AGENT = [{ partyId: "P-TC", name: "Title Company of Columbus", mailingAddress: "10 High St, Columbus OH 43215" }];
const LETTER = { release_county: "Franklin", release_days: 90, release_cite: "Ohio R.C. §5301.36", release_by: "2027-01-14", property_address: "1 Test St, Columbus OH 43215" };
const loanAcct = (account: string): AccountRef => ({ scope: "loan", loanId: "L-1", account: account as "principal" });
const custAcct = (id: string, account: string): AccountRef => ({ scope: "custodial", custodialAccountId: id, account: account as "custodial_pi_cash" });   // the spec's payoff accounts sit outside the kernel's fixed union
const acctName = (l: { account: AccountRef }): string => String(l.account.account);
const WIRE_AT = "2026-10-16T15:40:00.000Z";                            // Fri 10/16/2026 11:40 ET

/** The 16.2 tools on the bus with a real timer engine (16.2 plus the sibling rows 16.2's table lists: 5.1/5.2/5.3 remittance, AC 60 and the correction clock, 3.3/3.5 escrow, 6.5 suspense, 4.1 NoE) and the Notice Registry with the authored 16.2 letters. */
function harness(nowIso = WIRE_AT) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(REG, events, { processes: ["16.2", "5.1", "5.2", "5.3", "3.3", "3.5", "6.5", "4.1"] });
  const ctx: UowContext = { loanId: "L-1", events, ledger, timers, clock, decide: () => {} };
  const store = new EntityStore(); const escalations = new EscalationService(events, clock);
  const noticeReg = buildRegistry(); publishAuthored(noticeReg); const printMail = new FakePrintMail();
  const notices = new NoticeService({ registry: noticeReg, events, clock, printMail, edelivery: new FakeEdelivery() });
  const agents = new AgentRegistry(); const cmds = bindTools({ store, ports: {}, escalations, services: {}, notices }, agents, TOOLS_16_2); const bus = new CommandBus(agents);
  const run = async (name: string, input: Record<string, unknown>, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("16.2", name))!, actor, input, ctx)).output as Record<string, unknown>;
  // opening balances: the loan's UPB and accrued interest, the escrow liability
  ledger.post({ effectiveDate: D("2026-10-01"), description: "opening position", lines: [{ account: loanAcct("principal"), amountCents: 19_950_000n, ruleRef: "test.opening" }, { account: loanAcct("interest_due"), amountCents: 155_147n, ruleRef: "test.opening" }, { account: { scope: "corporate", account: "fnma_payable" }, amountCents: -20_105_147n, ruleRef: "test.opening" }] }, nowIso);
  ledger.post({ effectiveDate: D("2026-10-01"), description: "escrow balance", lines: [{ account: { scope: "custodial", custodialAccountId: "C-TI", account: "custodial_ti_cash" }, amountCents: 241_290n, ruleRef: "test.opening" }, { account: loanAcct("escrow"), amountCents: -241_290n, ruleRef: "test.opening" }] }, nowIso);
  /** 2.1's receipt of funds into clearing / suspense. */
  const receive = (cents: bigint, on = D("2026-10-16")) => ledger.post({ effectiveDate: on, description: "2.1 receipt", lines: [{ account: { scope: "custodial", custodialAccountId: "C-CLR", account: "clearing_cash" }, amountCents: cents, ruleRef: "2.1 receipt" }, { account: loanAcct("suspense_unapplied"), amountCents: -cents, ruleRef: "2.1 receipt" }] }, clock.now());
  const timer = (code: string) => timers.byCode(code)[0];
  const types = () => events.all().map((e) => e.type);
  const sent = (template: string) => events.all().filter((e) => e.type === "notice.sent" && e.payload.template === template);
  return { clock, events, ledger, timers, store, escalations, notices, printMail, run, ctx, timer, types, sent, receive };
}
type H = ReturnType<typeof harness>;
/** Receipt → posting → share → CRS 001 → LAR 60 → housekeeping for the worked example (A/A portfolio, 100% participation). */
async function workedPayoff(h: H, o: { remittance_type?: "AA" | "SA" | "SS"; instructed_at?: string; autodraft?: boolean; mi_active?: boolean; fnma_advance_repay_cents?: bigint; amount?: bigint } = {}) {
  const type = o.remittance_type ?? "AA"; const amount = o.amount ?? EXACT; const repay = o.fnma_advance_repay_cents ?? 0n;
  h.receive(amount);
  const funds = await h.run("matchPayoffFunds", { loan_id: "L-1", amount_cents: amount, method: "wire", received_at: WIRE_AT, bank_reference: "Q-1187", remittance_type: type, quotes: QUOTES });
  const posted = await h.run("postPayoff", { loan_id: "L-1", funds_id: funds.funds_id, amount_cents: amount, payoff_date: "2026-10-16", buckets: BUCKETS, remittance_type: type, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: "2026-09-01", escrowed: true, autodraft: o.autodraft ?? true, mi_active: o.mi_active ?? true, fnma_advance_repay_cents: repay });
  const share = await h.run("computeFnmaPayoffShare", { settlement_id: posted.settlement_id, type, upb_cents: 19_950_000n, nib_cents: 0n, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: "2026-09-01", payoff_on: "2026-10-16", fnma_advance_repay_cents: repay });
  const batch = type === "AA" ? await h.run("buildCrsBatch", { lender_id: "123456789", instructed_at: o.instructed_at ?? "2026-10-16T19:00:00.000Z", settlements: [{ loan_id: "L-1", settlement_id: posted.settlement_id, fnma_loan_number: "1234567890", remittance_type: "AA", fnma_share_cents: share.total_cents, fnma_advance_repay_cents: repay, payoff_on: D("2026-10-16") }] }) : null;
  const removal = await h.run("projectRemovalPayoff", { loan_id: "L-1", funds_id: funds.funds_id, settlement_id: posted.settlement_id, fnma_loan_number: "1234567890", principal_cents: 19_950_000n, nib_cents: 0n, interest_cents: share.interest_cents, payoff_date: "2026-10-16", processed_at: WIRE_AT });
  const tasks = await h.run("createHousekeepingTasks", { settlement_id: posted.settlement_id, loan_id: "L-1", payoff_date: "2026-10-16", escrowed: true, mi_active: o.mi_active ?? true, autodraft: o.autodraft ?? true, fnma_advance_repay_cents: repay });
  return { funds, posted, share, batch, removal, tasks };
}
/** A short wire received Fri 10/16 through the intake (cleared on receipt) so the good-funds gate, the 1-BD posting clock and 5.3's LAR 60 clock are all live before the variance is disposed. */
async function shortReceipt(h: H, amount: bigint) {
  h.receive(amount);
  return h.run("matchPayoffFunds", { loan_id: "L-1", amount_cents: amount, method: "wire", received_at: WIRE_AT, bank_reference: "Q-1187", quotes: QUOTES });
}

test("16.2-T1: Given the worked example, when the $201,051.47 wire clears Fri 10/16/2026, then the loan posts to zero on 10/16, Fannie Mae's share is $200,989.42 (interest $1,489.42), the CRS 001 batch is built the same day for 10/19 settlement, and the LAR 60 is due Mon 10/19 20:00 ET.", async () => {
  const h = harness(); const r = await workedPayoff(h);
  // the wire is final on receipt: payoff.funds.received → payoff.funds.cleared the same instant; the good-funds gate opens and closes
  assert.equal(r.funds.status, "cleared"); assert.equal(r.funds.basis, "reference"); assert.equal(r.funds.payoff_date, "2026-10-16");
  assert.deepEqual(h.types().filter((t) => t.startsWith("payoff.funds")), ["payoff.funds.received", "payoff.funds_received", "payoff.funds.cleared"]);
  assert.equal(h.timer("SM_PAYOFF_GOODFUNDS_GATE")!.status, "satisfied");
  // posts to zero on 10/16: every loan account reads zero except escrow (refund pending) — in the ledger, not just the calculator
  assert.equal(r.posted.zero, true); assert.equal(h.store.get("payoff_settlements", String(r.posted.settlement_id))!.data.payoff_date, "2026-10-16"); assert.equal(r.posted.activity_period, "2026-10");
  assert.equal(h.ledger.balance(loanAcct("principal")), 0n); assert.equal(h.ledger.balance(loanAcct("interest_due")), 0n); assert.equal(h.ledger.balance(loanAcct("suspense_unapplied")), 0n); assert.equal(h.ledger.balance(loanAcct("escrow")), -241_290n);
  assert.equal(h.ledger.balance({ scope: "custodial", custodialAccountId: "C-CLR", account: "clearing_cash" }), 0n); assert.equal(h.ledger.balance({ scope: "custodial", custodialAccountId: "C-PI", account: "custodial_pi_cash" }), EXACT);
  assert.ok(h.ledger.sets().every((s) => s.lines.every((l) => l.ruleRef.length > 0)));
  assert.equal(h.timer("SM_PAYOFF_POST_TO_ZERO_1BD")!.status, "satisfied");
  // Fannie Mae's share $200,989.42 with interest at PTR $1,489.42; the settlement row carries it for the CRS guardrail
  assert.equal(r.share.total_cents, 20_098_942n); assert.equal(r.share.interest_cents, 148_942n); assert.equal(r.share.servicing_fee_cents, 6_205n); assert.equal(r.share.scheduled_cycle_interest_cents, 0n, "A/A: the payoff interest already runs from the LPI date");
  assert.equal(h.ledger.balance(custAcct("C-PI", "fnma_remittance_payable")), -20_098_942n); assert.equal(h.ledger.balance(custAcct("C-PI", "servicing_fee_withdrawable")), -6_205n);
  assert.equal(h.store.get("payoff_settlements", String(r.posted.settlement_id))!.data.fnma_share_cents, 20_098_942n);
  // CRS 001 batch built the same day (15:00 ET batch, before the 16:00 ET cut-off) for 10/19 settlement; FNMA_F120_PAYOFF_AA_IMMEDIATE armed on the payoff date and satisfied by the instruction
  assert.equal(r.batch!.batch_on, "2026-10-16"); assert.equal(r.batch!.settlement_on, "2026-10-19"); assert.equal(r.batch!.before_cutoff, true);
  assert.deepEqual((r.batch!.lines as { code: string; amount_cents: bigint }[]).map((l) => [l.code, l.amount_cents]), [["001", 20_098_942n]]);
  const aa = h.timer("FNMA_F120_PAYOFF_AA_IMMEDIATE")!; assert.equal(aa.dueAt, zonedEpochMs(D("2026-10-16"), "16:00", ET)); assert.equal(aa.status, "satisfied");
  assert.equal(h.escalations.opened.find((e) => e.kind === "human_portal_task")!.ownerRole, "fnma_portal_operator");
  // LAR 60 due Mon 10/19 20:00 ET — the calculator's clock, the stored investor event and the FNMA_IRM_PAYOFF_AC60_NEXTBD_2000 instance agree
  const due = zonedEpochMs(D("2026-10-19"), "20:00", ET);
  assert.equal(r.removal.lar60_due_at, toIso(due)); assert.equal(h.store.get("investor_events", String(r.removal.event_id))!.data.due_at, toIso(due)); assert.equal(h.timer("FNMA_IRM_PAYOFF_AC60_NEXTBD_2000")!.dueAt, due);
  assert.equal(r.removal.activity_period, "2026-10"); assert.equal(r.removal.correction_close_at, toIso(zonedEpochMs(D("2026-11-03"), "17:00", ET)), "period close = BD2 17:00 ET of November");
  // IRM §2-04: a payoff processed on BD1 (Mon 11/02) reports by BD2 17:00 ET (Tue 11/03), not 20:00 ET — the same clock 5.3's period close enforces
  assert.equal(toIso(lar60DueMs(zonedEpochMs(D("2026-11-02"), "12:00", ET))), toIso(zonedEpochMs(D("2026-11-03"), "17:00", ET)));
  assert.equal(toIso(lar60DueMs(zonedEpochMs(D("2026-11-03"), "12:00", ET))), toIso(zonedEpochMs(D("2026-11-04"), "20:00", ET)));
  // spec discrepancy: the worked example prints the LAR fields as `0019950000{` / `0000148942{`, which decode to $1,995,000.00 / $14,894.20 — one digit position off; the 5.1 zone-signed layout (11 digits, cents, sign on the last digit) gives 19,950,000 cents and 148,942 cents
  assert.equal((r.removal.lar60 as { principal_field: string }).principal_field, "0001995000{"); assert.equal((r.removal.lar60 as { interest_field: string }).interest_field, "0000014894B");
  await h.run("projectRemovalPayoff", { op: "submit", loan_id: "L-1", event_id: r.removal.event_id }); assert.equal(h.timer("FNMA_IRM_PAYOFF_AC60_NEXTBD_2000")!.status, "satisfied", "5.3's row closes on investor_events.submitted{event_type=removal.payoff}");
  h.clock.set("2026-10-19T13:10:00.000Z"); const ack = await h.run("projectRemovalPayoff", { op: "accept", loan_id: "L-1", event_id: r.removal.event_id, ack_reference: "LSDU-ACK-7781" });
  assert.equal(ack.status, "accepted"); assert.equal(ack.supersedes_event_id, null); assert.equal(h.store.get("investor_events", String(r.removal.event_id))!.data.status, "accepted"); assert.ok(h.types().includes("investor_events.accepted"));
  await assert.rejects(h.run("projectRemovalPayoff", { op: "accept", loan_id: "L-1", event_id: r.removal.event_id, ack_reference: "" }), /ack_reference is required/);
});
test("16.2-T2: Given an S/S loan with the same facts, then `ss_interest_gap_cents` = 50558 and the November 18 draft matches UPB + $997.50; given the payoff is processed Mon 11/02 and reported 11/03, then no November interest is due.", async () => {
  const ss = fnmaPayoffShare({ ...SHARE, type: "SS" });
  assert.equal(ss.ss_interest_gap_cents, 50_558n); assert.equal(ss.interest_cents, 99_750n); assert.equal(ss.total_cents, 19_950_000n + 99_750n);
  assert.equal(ss.scheduled_cycle_interest_cents, 99_750n, "September at PTR goes through the regular 10/18 draft, not the payoff draft"); assert.equal(ss.servicing_fee_cents, 6_205n, "rule 4: fee = collected at the note rate − due at PTR, for S/S too");
  assert.equal(fnmaDraftDate("SS", D("2026-10-16")), "2026-11-18");
  const h = harness(); const r = await workedPayoff(h, { remittance_type: "SS" });
  assert.equal(r.posted.servicer_funded_cents, 50_558n); assert.ok(h.ledger.sets().some((s) => s.lines.some((l) => acctName(l) === "payoff_interest_shortfall_expense" && l.amountCents === 50_558n)));
  // the November 18 payoff draft = UPB + $997.50 (the settlement's fnma_share_cents); the custodial payable also carries September's $997.50 scheduled interest for the regular October-cycle draft; the fee is $62.05, not the September interest
  assert.equal(h.store.get("payoff_settlements", String(r.posted.settlement_id))!.data.fnma_share_cents, 19_950_000n + 99_750n);
  assert.equal(h.ledger.balance(custAcct("C-PI", "fnma_remittance_payable")), -(19_950_000n + 99_750n + 99_750n)); assert.equal(h.ledger.balance(custAcct("C-PI", "servicing_fee_withdrawable")), -6_205n);
  const t = h.timer("FNMA_F120_PAYOFF_SS_CD18")!; assert.equal(t.dueDate, "2026-11-18"); assert.equal(t.status, "armed");
  await h.run("buildCrsBatch", { op: "confirm", loan_id: "L-1", settlement_id: r.posted.settlement_id, amount_cents: 19_950_000n + 99_750n, settled_on: "2026-11-18", remittance_type: "SS" });
  assert.equal(h.timer("FNMA_F120_PAYOFF_SS_CD18")!.status, "satisfied"); assert.equal(h.store.get("payoff_settlements", String(r.posted.settlement_id))!.data.status, "remitted");
  await assert.rejects(h.run("buildCrsBatch", { op: "confirm", loan_id: "L-1", settlement_id: r.posted.settlement_id, amount_cents: 19_950_000n, settled_on: "2026-11-18" }), /≠ payoff_settlements/);
  // processed Mon 11/02 (BD1 of November on the fannie_et calendar) and reported Tue 11/03 (BD2): no November interest — derived from the calendar, never from a caller's flag
  assert.equal(ssBd1Bd2Exception({ type: "SS", processed_on: D("2026-11-02"), reported_on: D("2026-11-03") }), true); assert.equal(ssBd1Bd2Exception({ type: "SS", processed_on: D("2026-11-03"), reported_on: D("2026-11-03") }), false); assert.equal(ssBd1Bd2Exception({ type: "SS", processed_on: D("2026-11-02"), reported_on: D("2026-11-04") }), false);
  const bd1 = fnmaPayoffShare({ ...SHARE, type: "SS", payoff_on: D("2026-11-02"), processed_on: D("2026-11-02"), reported_on: D("2026-11-03") }); assert.equal(bd1.interest_cents, 0n); assert.equal(bd1.ss_interest_gap_cents, 0n); assert.equal(bd1.ss_bd1_bd2_exception, true);
  assert.equal(fnmaPayoffShare({ ...SHARE, type: "SS", payoff_on: D("2026-11-02"), processed_on: D("2026-11-03"), reported_on: D("2026-11-03") }).interest_cents, 99_750n, "processed on BD2: the full November month at PTR is due");
  const b = harness("2026-11-02T15:00:00.000Z");
  const viaBus = await b.run("computeFnmaPayoffShare", { type: "SS", upb_cents: 19_950_000n, nib_cents: 0n, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: "2026-09-01", payoff_on: "2026-11-02", reported_on: "2026-11-03" });
  assert.equal(viaBus.interest_cents, 0n); assert.equal(viaBus.ss_bd1_bd2_exception, true);
  await assert.rejects(b.run("computeFnmaPayoffShare", { type: "SS", upb_cents: 19_950_000n, nib_cents: 0n, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: "2026-09-01", payoff_on: "2026-11-16", processed_bd1_reported_bd2: true }), (e: unknown) => e instanceof CommandRefused && e.code === "LLM_NEVER_COMPUTES_MONEY");
});
test("16.2-T3: Given an S/A loan, then Fannie Mae's interest is $498.75 and the draft is monitored for Fri 11/20/2026.", async () => {
  assert.equal(fnmaPayoffShare({ ...SHARE, type: "SA" }).interest_cents, 49_875n); assert.equal(fnmaDraftDate("SA", D("2026-10-16")), "2026-11-20");
  const h = harness(); const r = await workedPayoff(h, { remittance_type: "SA" });
  assert.equal(r.share.interest_cents, 49_875n); assert.equal(r.share.draft_on, "2026-11-20"); assert.equal(r.share.rail, "fnma_initiated_draft_from_lar"); assert.equal(r.share.servicing_fee_cents, 6_205n); assert.equal(r.share.scheduled_cycle_interest_cents, 99_750n);
  const t = h.timer("FNMA_F120_PAYOFF_SA_CD20")!; assert.equal(t.dueDate, "2026-11-20"); assert.equal(t.status, "armed"); assert.match(REG.get("FNMA_F120_PAYOFF_SA_CD20")!.kind, /monitored/);
  assert.equal(r.posted.servicer_funded_cents, 683n, "the $6.83 deficit against the $491.92 collected is servicer-funded");
  assert.equal(h.ledger.balance(custAcct("C-PI", "fnma_remittance_payable")), -(19_950_000n + 49_875n + 99_750n));
  await h.run("buildCrsBatch", { op: "confirm", loan_id: "L-1", settlement_id: r.posted.settlement_id, amount_cents: 19_950_000n + 49_875n, settled_on: "2026-11-20" });
  assert.equal(h.timer("FNMA_F120_PAYOFF_SA_CD20")!.status, "satisfied");
});
test("16.2-T4: Given funds $30.00 short of the exact figure, then the loan is paid in full and $30.00 posts to `payoff_tolerance_expense`; given $221.10 short in Ohio, then a demand issues within 1 BD, funds sit in `suspense_items{short_payoff}`, and at day 30 uncured the funds are applied per the note.", async () => {
  // $30.00 short: within the $50 tolerance → paid in full, the difference to payoff_tolerance_expense
  const tol = disposeVariance({ amount_cents: EXACT - 3_000n, exact_total_cents: EXACT, reliance_state: false, within_good_through: true, received_on: D("2026-10-16") });
  assert.equal(tol.outcome, "paid_in_full_tolerance"); assert.equal(tol.shortage_disposition, "waived_tolerance"); assert.equal(tol.expense_account, "payoff_tolerance_expense"); assert.equal(tol.demand, false);
  const a = applyToZero(BUCKETS, EXACT - 3_000n); assert.equal(a.zero, true); assert.equal(a.tolerance_expense_cents, 3_000n); assert.equal(a.applied_cents, EXACT - 3_000n);
  const h = harness(); const wire = await shortReceipt(h, EXACT - 3_000n);
  const posted = await h.run("postPayoff", { loan_id: "L-1", funds_id: wire.funds_id, amount_cents: EXACT - 3_000n, payoff_date: "2026-10-16", buckets: BUCKETS, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: "2026-09-01" });
  assert.equal(posted.zero, true); assert.equal(h.store.get("payoff_settlements", String(posted.settlement_id))!.data.status, "paid_in_full"); assert.equal(h.store.get("payoff_settlements", String(posted.settlement_id))!.data.shortage_disposition, "waived_tolerance");
  assert.ok(h.ledger.sets().some((s) => s.lines.some((l) => l.account.scope === "corporate" && acctName(l) === "payoff_tolerance_expense" && l.amountCents === 3_000n)));
  assert.equal(h.ledger.balance(loanAcct("principal")), 0n); assert.equal(h.ledger.balance(loanAcct("interest_due")), 0n); assert.equal(h.ledger.balance(loanAcct("suspense_unapplied")), 0n); assert.ok(h.types().includes("loan.paid_in_full"));
  // $221.10 short in Ohio (no reliance): the cleared wire armed the 1-BD posting clock and 5.3's LAR 60 clock; the demand within 1 BD, funds in suspense_items{short_payoff}, never applied during the cure window
  const s = harness(); const amount = EXACT - 22_110n; const short = await shortReceipt(s, amount);
  assert.equal(s.timer("SM_PAYOFF_POST_TO_ZERO_1BD")!.status, "armed"); assert.equal(s.timer("FNMA_IRM_PAYOFF_AC60_NEXTBD_2000")!.status, "armed");
  const d = await s.run("disposeVariance", { loan_id: "L-1", amount_cents: amount, exact_total_cents: EXACT, reliance_state: false, within_good_through: true, received_on: "2026-10-16", state: "OH", remitter: "closing_agent" });
  assert.equal(d.demand, true); assert.equal(d.disposition, "short_payoff_demand_1bd"); assert.equal(d.demand_by, "2026-10-19"); assert.equal(d.uncured_on, "2026-11-15"); assert.equal(d.suspense_reason, "short_payoff");
  const si = s.store.get("suspense_items", "si-L-1-short_payoff")!; assert.equal(si.data.reason, "short_payoff"); assert.equal(si.data.status, "held"); assert.equal(si.data.amount_cents, amount); assert.equal(si.data.never_applied_during_cure, true);
  assert.equal(s.timer("SM_PAYOFF_SHORTAGE_DEMAND_1BD")!.dueDate, "2026-10-19"); assert.equal(s.timer("SM_PAYOFF_SHORTAGE_UNCURED_30")!.dueDate, "2026-11-15");
  // the timer table satisfies the 1-BD posting clock by `payoff.funds.short` too, and nothing is due to Fannie Mae until the shortage is cured (rule 5): neither clock breaches on Tue 10/20
  assert.deepEqual([...(d.timers_cancelled as string[])].sort(), ["FNMA_IRM_PAYOFF_AC60_NEXTBD_2000", "SM_PAYOFF_POST_TO_ZERO_1BD"]); assert.equal(s.timer("SM_PAYOFF_POST_TO_ZERO_1BD")!.status, "cancelled"); assert.match(String(s.timer("SM_PAYOFF_POST_TO_ZERO_1BD")!.cancelledReason), /payoff\.funds\.short/);
  assert.deepEqual(s.timers.evaluate("2026-10-20T23:00:00.000Z").map((b) => b.instance.code), ["SM_PAYOFF_SHORTAGE_DEMAND_1BD"], "only the demand clock is overdue on 10/20 before the letter goes");
  await assert.rejects(s.run("postPayoff", { loan_id: "L-1", funds_id: short.funds_id, amount_cents: amount, payoff_date: "2026-10-16", buckets: BUCKETS }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_SHORT_APPLICATION");
  assert.equal(s.ledger.balance(loanAcct("principal")), 19_950_000n, "nothing applied as a curtailment during the cure window");
  // the demand letter to the party that remitted, rendered through the Notice Registry with the exact shortfall and per diem: satisfies SM_PAYOFF_SHORTAGE_DEMAND_1BD (late, on 10/21) and arms SM_PAYOFF_SHORTAGE_CURE_5BD (+5 BD → 10/28)
  s.clock.set("2026-10-21T14:00:00.000Z");
  const demand = await s.run("disposeVariance", { op: "demand", loan_id: "L-1", amount_cents: amount, exact_total_cents: EXACT, received_on: "2026-10-16", recipients: CLOSING_AGENT, addressee_role: "closing_agent", per_diem_cents: 3_416n, state: "OH", borrower_name: "A. Borrower", property_address: "1 Test St, Columbus OH 43215" });
  assert.equal(demand.template, "NTC_PAYOFF_SHORTAGE_DEMAND"); assert.equal(demand.shortage_cents, 22_110n); assert.equal(demand.cure_by, "2026-10-28"); assert.equal(demand.uncured_on, "2026-11-15");
  const letter = s.notices.all().find((n) => n.templateCode === "NTC_PAYOFF_SHORTAGE_DEMAND")!; assert.equal(letter.status, "sent"); assert.match(letter.rendered.text, /shortfall of \$221\.10/); assert.match(letter.rendered.text, /\$34\.16 per day/); assert.match(letter.rendered.text, /remit the shortfall by October 28, 2026/);
  assert.equal(s.timer("SM_PAYOFF_SHORTAGE_DEMAND_1BD")!.status, "satisfied_late"); assert.equal(s.timer("SM_PAYOFF_SHORTAGE_CURE_5BD")!.dueDate, "2026-10-28"); assert.equal(s.timer("SM_PAYOFF_SHORTAGE_CURE_5BD")!.status, "armed");
  assert.equal(s.store.get("suspense_items", "si-L-1-short_payoff")!.data.demand_sent_on, "2026-10-21");
  // day 30 uncured: applied per the note — the installment due first (interest then principal), the rest as a curtailment capped at the principal, the remainder to the interest still due; the loan stays active with the $221.10 shortage due
  s.clock.set("2026-11-15T15:00:00.000Z");
  const ap = await s.run("disposeVariance", { op: "apply_per_note", loan_id: "L-1", received_on: "2026-10-16", today: "2026-11-15", funds_cents: amount, installments: [{ due_on: "2026-11-01", amount_cents: 219_257n, interest_cents: 103_906n }], reliance_state: false });
  assert.equal(ap.eligible, true); assert.equal(ap.outcome, "applied_per_note"); assert.deepEqual(ap.installments_paid, ["2026-11-01"]); assert.equal(ap.installments_cents, 219_257n); assert.equal(ap.loan_status, "active");
  assert.equal(ap.curtailment_cents, 19_950_000n - 115_351n); assert.equal(ap.extra_interest_cents, 29_131n); assert.equal(ap.unapplied_cents, 0n);
  assert.equal(s.ledger.balance(loanAcct("suspense_unapplied")), 0n); assert.equal(s.ledger.balance(loanAcct("principal")), 0n); assert.equal(s.ledger.balance(loanAcct("interest_due")), 22_110n, "the shortage remains due under the note");
  assert.equal(ap.borrower_notified, true, "derived from the NTC_PAYOFF_SHORTAGE_DEMAND in the loan's log, which stated the day-30 consequence");
  assert.equal(s.store.get("suspense_items", "si-L-1-short_payoff")!.data.status, "applied_per_note"); assert.equal(s.timer("SM_PAYOFF_SHORTAGE_UNCURED_30")!.status, "satisfied");
  assert.equal(applyUncuredPerNote({ received_on: D("2026-10-16"), today: D("2026-11-14"), funds_cents: amount, installments: [], reliance_state: false }).eligible, false, "the cure window runs to day 30");
  // no demand in the log → no application per the note (rule 5: the application follows an uncured demand)
  const n = harness(); await shortReceipt(n, amount); await n.run("disposeVariance", { loan_id: "L-1", amount_cents: amount, exact_total_cents: EXACT, reliance_state: false, within_good_through: true, received_on: "2026-10-16" }); n.clock.set("2026-11-15T15:00:00.000Z");
  await assert.rejects(n.run("disposeVariance", { op: "apply_per_note", loan_id: "L-1", received_on: "2026-10-16", today: "2026-11-15", funds_cents: amount, installments: [], reliance_state: false }), /no NTC_PAYOFF_SHORTAGE_DEMAND/);
});
test("16.2-T5: Given a Florida estoppel figure relied upon and a $221.10 shortage caused by late arrival within the good-through date, then disposition is `reliance_absorbed`, no demand issues, and the loan is paid in full.", async () => {
  const h = harness(); const amount = EXACT - 22_110n; const wire = await shortReceipt(h, amount);
  const d = await h.run("disposeVariance", { loan_id: "L-1", amount_cents: amount, exact_total_cents: EXACT, reliance_state: true, within_good_through: true, received_on: "2026-10-16", state: "FL" });
  assert.equal(d.shortage_disposition, "reliance_absorbed"); assert.equal(d.disposition, "reliance_absorbed"); assert.equal(d.demand, false); assert.equal(d.outcome, "absorbed"); assert.equal(d.approval, "agent"); assert.equal(d.paid_in_full_as_of, "2026-10-16"); assert.equal(d.expense_account, "payoff_shortfall_expense");
  assert.ok(!h.types().includes("payoff.funds.short")); assert.equal(h.timers.byCode("SM_PAYOFF_SHORTAGE_DEMAND_1BD").length, 0); assert.equal(h.store.get("suspense_items", "si-L-1-short_payoff"), undefined); assert.deepEqual(d.timers_cancelled, []);
  assert.deepEqual(h.events.all().filter((e) => e.type === "payoff.shortage.resolved").map((e) => [e.payload.outcome, e.payload.disposition]), [["absorbed", "reliance_absorbed"]]);
  await assert.rejects(h.run("disposeVariance", { loan_id: "L-1", amount_cents: amount, exact_total_cents: EXACT, reliance_state: true, within_good_through: true, force_demand: true }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_DEMAND_OVER_RELIANCE_FIGURE");
  await assert.rejects(h.run("disposeVariance", { op: "demand", loan_id: "L-1", amount_cents: amount, exact_total_cents: EXACT, reliance_state: true, within_good_through: true, received_on: "2026-10-16", recipients: CLOSING_AGENT }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_DEMAND_OVER_RELIANCE_FIGURE", "no demand letter for a reliance-protected figure");
  // the servicer funds the $221.10 and the loan is paid in full as of the original payoff date; the 1-BD posting clock closes on loan.paid_in_full
  const posted = await h.run("postPayoff", { loan_id: "L-1", funds_id: wire.funds_id, amount_cents: amount, absorbed_shortage_cents: 22_110n, shortage_disposition: "reliance_absorbed", payoff_date: "2026-10-16", buckets: BUCKETS, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: "2026-09-01" });
  assert.equal(posted.zero, true); assert.equal(h.store.get("payoff_settlements", String(posted.settlement_id))!.data.shortage_disposition, "reliance_absorbed"); assert.equal(h.store.get("payoff_settlements", String(posted.settlement_id))!.data.shortage_cents, 22_110n);
  assert.ok(h.ledger.sets().some((s) => s.lines.some((l) => l.account.scope === "corporate" && acctName(l) === "payoff_shortfall_expense" && l.amountCents === 22_110n)));
  assert.equal(h.ledger.balance(loanAcct("principal")), 0n); assert.ok(h.types().includes("loan.paid_in_full")); assert.equal(h.timer("SM_PAYOFF_POST_TO_ZERO_1BD")!.status, "satisfied");
  // absorbed shortages > $500 need the officer: the agent is refused, the officer is not
  await assert.rejects(h.run("disposeVariance", { loan_id: "L-1", amount_cents: EXACT - 60_000n, exact_total_cents: EXACT, reliance_state: true, within_good_through: true }), (e: unknown) => e instanceof CommandRefused && e.code === "OFFICER_ABSORBS_OVER_500");
  assert.equal((await h.run("disposeVariance", { loan_id: "L-1", amount_cents: EXACT - 60_000n, exact_total_cents: EXACT, reliance_state: true, within_good_through: true }, OFFICER)).approval, "officer");
});
test("16.2-T6: Given the escrow refund with payoff posted Fri 10/16/2026, then `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD.due_at` = Mon 11/16/2026 and the short-year statement is due Tue 12/15/2026.", async () => {
  const h = harness(); const w = await workedPayoff(h);
  const refund = h.timer("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD")!; assert.equal(refund.dueDate, "2026-11-16"); assert.equal(toIso(refund.dueAt!).slice(0, 10), "2026-11-17", "23:59 ET on Mon 11/16/2026 (Veterans Day 11/11 excluded from the 20 federal business days)");
  assert.equal(refund.dueAt, zonedEpochMs(D("2026-11-16"), "23:59", ET));
  const stmt = h.timer("REGX_1024_17I4_SHORT_YEAR_PAYOFF_60")!; assert.equal(stmt.dueDate, "2026-12-15");
  const r = escrowRefund({ loan_id: "L-1", custodial_ti: "C-TI", payoff_on: D("2026-10-16"), escrow_balance_cents: 241_290n });
  assert.deepEqual([r.hold_until, r.issue_on, r.due_by, r.short_year_statement_by], ["2026-10-23", "2026-10-26", "2026-11-16", "2026-12-15"]);
  assert.deepEqual([housekeeping(D("2026-10-16")).escrow_refund_by, housekeeping(D("2026-10-16")).short_year_statement_by], ["2026-11-16", "2026-12-15"]);
  h.ledger.post(r.entry_set!, h.clock.now()); assert.equal(h.ledger.balance(loanAcct("escrow")), 0n);
  // the housekeeping rows close the Reg X clocks: the refund disbursement issued 10/26 after the 5-BD in-flight hold, the short-year statement sent with it
  h.clock.set("2026-10-26T15:00:00.000Z");
  await h.run("createHousekeepingTasks", { op: "complete", settlement_id: w.posted.settlement_id, loan_id: "L-1", task: "escrow_refund", disbursement_id: "disb-refund-1", amount_cents: 241_290n, evidence_document_id: "doc-refund-1" });
  await h.run("createHousekeepingTasks", { op: "complete", settlement_id: w.posted.settlement_id, loan_id: "L-1", task: "short_year_statement", statement_document_id: "doc-sys-1" });
  assert.equal(h.timer("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD")!.status, "satisfied"); assert.equal(h.timer("REGX_1024_17I4_SHORT_YEAR_PAYOFF_60")!.status, "satisfied");
  // the paid-in-full letter states the same dates, derived from the settlement row and the calculator (never the caller's); SM_PAYOFF_PIF_LETTER_5BD (due Fri 10/23) closes late on the Notice Registry's notice.sent
  h.timers.evaluate(h.clock.now());
  const pif = h.timer("SM_PAYOFF_PIF_LETTER_5BD")!; assert.equal(pif.dueDate, "2026-10-23"); assert.equal(pif.status, "breached");
  const done = await h.run("createHousekeepingTasks", { op: "complete", settlement_id: w.posted.settlement_id, loan_id: "L-1", task: "paid_in_full_letter", recipients: BORROWER, letter: LETTER, mi_active: true, autodraft: true });
  assert.equal(done.escrow_refund_by, "2026-11-16"); assert.equal(done.short_year_statement_by, "2026-12-15");
  const letter = h.notices.all().find((n) => n.templateCode === "NTC_PAYOFF_PAID_IN_FULL")!; assert.equal(letter.status, "sent"); assert.match(letter.rendered.text, /no later than November 16, 2026/); assert.match(letter.rendered.text, /no later than December 15, 2026/); assert.match(letter.rendered.text, /paid in full as of October 16, 2026/); assert.match(letter.rendered.text, /balance is now \$0\.00/);
  assert.equal(h.timer("SM_PAYOFF_PIF_LETTER_5BD")!.status, "satisfied_late");
  // a non-escrowed payoff owes no refund: the 20-BD clock never arms (rule 9; §1024.34(b)(1))
  const n = harness(); n.receive(EXACT); const f = await n.run("matchPayoffFunds", { loan_id: "L-1", amount_cents: EXACT, method: "wire", received_at: WIRE_AT, bank_reference: "Q-1187", quotes: QUOTES });
  await n.run("postPayoff", { loan_id: "L-1", funds_id: f.funds_id, amount_cents: EXACT, payoff_date: "2026-10-16", buckets: { accrued_interest: 155_147n, principal: 19_950_000n }, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: "2026-09-01" });
  assert.equal(n.timers.byCode("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD").length, 0); assert.equal(n.timers.byCode("SM_PAYOFF_PIF_LETTER_5BD").length, 1);
});
test("16.2-T7: Given a returned payoff check on Wed 10/28 (before the 11/03 close), then a correcting removal event is projected, the ledger reopens as of 10/16, the refund is stop-paid and the MI/insurance/tax tasks are reversed; given the return on Wed 11/04, then `fnma_liquidated_in_error` is set and an `officer` escalation opens.", async () => {
  assert.equal(toIso(finalityAtMs(D("2026-10-16"))), toIso(zonedEpochMs(D("2026-11-03"), "17:00", ET)), "BD2 17:00 ET of November");
  assert.deepEqual(payoffActivityPeriod(D("2026-10-16")), { activity_period: "2026-10", period_end: "2026-10-31", correction_close_ms: zonedEpochMs(D("2026-11-03"), "17:00", ET) });
  const h = harness(); const r = await workedPayoff(h);
  await h.run("projectRemovalPayoff", { op: "submit", loan_id: "L-1", event_id: r.removal.event_id }); await h.run("projectRemovalPayoff", { op: "accept", loan_id: "L-1", event_id: r.removal.event_id, ack_reference: "LSDU-ACK-1" });
  const armedBefore = h.timers.open().map((t) => t.code); assert.ok(armedBefore.includes("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD") && armedBefore.includes("SM_PAYOFF_MI_NOTIFY_2BD"));
  h.clock.set("2026-10-28T14:00:00.000Z");
  const rev = await h.run("postPayoff", { op: "reverse", loan_id: "L-1", settlement_id: r.posted.settlement_id, returned_at: "2026-10-28T14:00:00.000Z", cause: "returned_item", refund_disbursement_id: "disb-refund-1" });
  assert.equal(rev.branch, "reversed_pre_close"); assert.equal(rev.returned_on, "2026-10-28"); assert.equal(rev.fnma_liquidated_in_error, false); assert.equal(rev.loan_status, "active");
  const corr = h.store.get("investor_events", String(rev.correcting_event_id))!; assert.equal(corr.data.kind, "payoff_correction"); assert.equal(corr.data.correction, true); assert.equal(corr.data.corrects_event_id, r.removal.event_id); assert.equal(corr.data.status, "projected"); assert.equal(corr.data.activity_period, "2026-10"); assert.ok(h.types().includes("removal.payoff.correction.projected"));
  assert.equal(rev.ledger_reopen_as_of, "2026-10-16"); assert.equal(h.ledger.balance(loanAcct("principal"), D("2026-10-16")), 19_950_000n); assert.equal(h.ledger.balance(loanAcct("interest_due")), 155_147n);
  assert.ok((rev.ledger_reversal_set_ids as string[]).length >= 3); assert.ok(h.ledger.sets().filter((s) => s.reversesSetId).every((s) => s.effectiveDate === "2026-10-16"));
  assert.equal(rev.refund_stop_pay, true); assert.equal(h.store.get("disbursements", "disb-refund-1")!.data.status, "stop_payment_requested"); assert.ok(h.types().includes("disbursement.stop_pay.requested"));
  const task = (t: string) => h.store.get("payoff_housekeeping_tasks", `${String(r.posted.settlement_id)}-${t}`)!.data;
  assert.deepEqual([task("mi_notify").status, task("mi_notify").reversal_action], ["reversed", "mi_reinstatement_request"]); assert.deepEqual([task("insurance_interest_remove").status, task("insurance_interest_remove").reversal_action], ["reversed", "tracker_re_add"]); assert.deepEqual([task("tax_authority_notify").reversal_action, task("tax_service_delete").reversal_action], ["tax_authority_re_notify", "tax_service_re_add"]);
  assert.equal(h.store.get("payoff_settlements", String(r.posted.settlement_id))!.data.status, "reversed_pre_close"); assert.equal(h.store.get("payoff_funds", String(r.funds.funds_id))!.data.status, "reversed");
  assert.ok(!h.escalations.opened.some((e) => e.kind === "officer"));
  // rule 6: every timer the payoff armed is cancelled with the tasks — no refund / MI / tax / credit / letter breach on a reopened loan
  const cancelled = rev.timers_cancelled as string[];
  for (const code of ["REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD", "REGX_1024_17I4_SHORT_YEAR_PAYOFF_60", "SM_PAYOFF_MI_NOTIFY_2BD", "SM_PAYOFF_INSURANCE_INTEREST_REMOVE_5BD", "SM_PAYOFF_TAX_AUTHORITY_NOTIFY_5BD", "SM_PAYOFF_CREDIT_REPORT_NEXT_CYCLE", "SM_PAYOFF_PIF_LETTER_5BD", "SM_PAYOFF_AUTODRAFT_STOP_T0"]) { assert.ok(cancelled.includes(code), code); assert.equal(h.timer(code)!.status, "cancelled", code); }
  await assert.rejects(h.run("createHousekeepingTasks", { op: "complete", settlement_id: r.posted.settlement_id, loan_id: "L-1", task: "mi_notify", evidence_document_id: "doc-x" }), /reversed/);
  // the exception on the reported LAR 60 arms FNMA_IRM_REMOVAL_CORRECTION_BD2_1700 on the October period end → Tue 11/03/2026 17:00 ET (BD2 of November), the same instant the payoff becomes final
  const exception = h.events.all().find((e) => e.type === "investor_event_exceptions.detected")!; assert.equal(exception.payload.family, "removal"); assert.equal(exception.payload.period_end, "2026-10-31"); assert.equal(exception.payload.event_id, corr.id); assert.equal(exception.payload.activity_period, "2026-10");
  assert.ok(eventMatches(REG.get("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700")!.triggerPattern!, exception));
  const clock = h.timer("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700")!; assert.equal(clock.status, "armed"); assert.equal(clock.anchorDate, "2026-10-31"); assert.equal(clock.dueAt, zonedEpochMs(D("2026-11-03"), "17:00", ET)); assert.equal(clock.dueAt, finalityAtMs(D("2026-10-16")));
  assert.deepEqual(h.timers.evaluate("2026-11-02T12:00:00.000Z").map((b) => b.instance.code), ["FNMA_IRM_REJECT_TRIAGE_4H"], "nothing else is overdue on the reopened loan (the 4-hour triage clock belongs to 5.1's exception queue)");
  // the correcting LAR 60 submitted and acknowledged by LSDU on Thu 10/29 supersedes the original: `investor_events.resolved{status=superseded, family=removal}` closes the correction clock
  h.clock.set("2026-10-29T13:00:00.000Z");
  await h.run("projectRemovalPayoff", { op: "submit", loan_id: "L-1", event_id: corr.id });
  const ack = await h.run("projectRemovalPayoff", { op: "accept", loan_id: "L-1", event_id: corr.id, ack_reference: "LSDU-ACK-CORR-1" });
  assert.equal(ack.supersedes_event_id, r.removal.event_id); assert.equal(h.store.get("investor_events", String(r.removal.event_id))!.data.status, "superseded"); assert.equal(h.store.get("investor_events", corr.id)!.data.status, "accepted");
  const resolved = h.events.all().find((e) => e.type === "investor_events.resolved")!; assert.deepEqual([resolved.payload.status, resolved.payload.family, resolved.payload.event_id, resolved.payload.superseded_by], ["superseded", "removal", r.removal.event_id, corr.id]);
  assert.ok(eventMatches(REG.get("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700")!.satisfiedPattern!, resolved));
  assert.equal(h.timer("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700")!.status, "satisfied"); assert.deepEqual(h.timers.evaluate("2026-11-17T12:00:00.000Z"), []);
  // a correction not acknowledged by the close breaches sev-1 (qc_finding) and can no longer be accepted: the action code 60 is final (IRM §4-08)
  const late = harness(); const l = await workedPayoff(late); await late.run("projectRemovalPayoff", { op: "submit", loan_id: "L-1", event_id: l.removal.event_id }); late.clock.set("2026-10-28T14:00:00.000Z");
  const lrev = await late.run("postPayoff", { op: "reverse", loan_id: "L-1", settlement_id: l.posted.settlement_id, returned_at: "2026-10-28T14:00:00.000Z", cause: "returned_item" });
  await late.run("projectRemovalPayoff", { op: "submit", loan_id: "L-1", event_id: lrev.correcting_event_id }); late.clock.set("2026-11-04T14:00:00.000Z");
  const breaches = late.timers.evaluate(late.clock.now()).filter((b) => b.instance.code !== "FNMA_IRM_REJECT_TRIAGE_4H"); assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity, [...b.escalateTo]]), [["FNMA_IRM_REMOVAL_CORRECTION_BD2_1700", 1, ["qc_finding"]]]);
  await assert.rejects(late.run("projectRemovalPayoff", { op: "accept", loan_id: "L-1", event_id: lrev.correcting_event_id, ack_reference: "LSDU-ACK-LATE" }), /after the period close .* the action code 60 is final/);
  assert.throws(() => acceptRemovalAck({ event_status: "submitted", correction: true, corrects_event_id: "x", ack_reference: "a", accepted_at_ms: zonedEpochMs(D("2026-11-03"), "17:01", ET), finality_at_ms: zonedEpochMs(D("2026-11-03"), "17:00", ET) }), /IRM §4-08/);
  // the return on Wed 11/04, after the BD2 17:00 ET close: fnma_liquidated_in_error, officer escalation, the ledger is not reopened and the loan is not reactivated
  const p = harness(); const r2 = await workedPayoff(p); p.clock.set("2026-11-04T14:00:00.000Z");
  const post = await p.run("postPayoff", { op: "reverse", loan_id: "L-1", settlement_id: r2.posted.settlement_id, returned_at: "2026-11-04T14:00:00.000Z", cause: "returned_item" });
  assert.equal(post.branch, "reversed_post_close"); assert.equal(post.fnma_liquidated_in_error, true); assert.equal(post.amount_due_to_fnma_cents, 20_098_942n); assert.equal(post.correcting_removal_event, null); assert.equal(post.ledger_reopen_as_of, null); assert.deepEqual(post.timers_cancelled, []);
  assert.equal(p.store.get("payoff_settlements", String(r2.posted.settlement_id))!.data.fnma_liquidated_in_error, true); assert.equal(p.ledger.balance(loanAcct("principal")), 0n); assert.equal(p.timers.byCode("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700").length, 0, "no correction clock after the close");
  const officer = p.escalations.opened.find((e) => e.kind === "officer")!; assert.equal(officer.ownerRole, "officer"); assert.match(String(officer.payload.reason), /fnma_liquidated_in_error/);
  await assert.rejects(p.run("postPayoff", { op: "reverse", loan_id: "L-1", settlement_id: r2.posted.settlement_id, returned_at: "2026-11-04T14:00:00.000Z", finality_at: "2026-11-03T22:00:00.000Z", cause: "returned_item", reopen_ledger: true }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_REVERSAL_AFTER_CLOSE");
  // a wire recall is a fraud signal for security-records; funds are not returned without the sending bank's indemnity and officer approval
  const w = reversePayoff({ payoff_on: D("2026-10-16"), returned_at_ms: Date.parse("2026-10-28T14:00:00.000Z"), finality_at_ms: finalityAtMs(D("2026-10-16")), cause: "wire_recall", tasks: [], fnma_share_cents: 20_098_942n });
  assert.deepEqual(w.escalations.map((e) => [e.kind, e.owner_role]), [["fraud_officer", "security-records"], ["officer", "officer"]]); assert.equal(w.funds_returnable, false);
});
test("16.2-T8: Given a deferral loan (UPB $180,000 + NIB $12,000), then the LAR 60 principal is $192,000.00 and local validation blocks submission if NIB is omitted.", async () => {
  const lar = lar60Removal({ upb_cents: 18_000_000n, nib_cents: 1_200_000n, interest_cents: 46_849n });
  assert.equal(lar.principal_cents, 19_200_000n); assert.equal(lar.principal_field, "0001920000{", "$192,000.00 = 19,200,000 cents in the 11-digit zone-signed field"); assert.equal(lar.action_code, "60");
  assert.throws(() => lar60Removal({ upb_cents: 18_000_000n, nib_cents: null, interest_cents: 46_849n }), /NIB omitted/);
  assert.equal(lar60Removal({ upb_cents: 18_000_000n, nib_cents: 1_200_000n, interest_cents: 46_849n, participation_pct: "50" }).principal_cents, 9_600_000n, "NIB is included before the participation percentage (IRM §2-04)");
  assert.equal(fnmaShare({ type: "AA", upb_cents: 18_000_000n, nib_cents: 1_200_000n, note_rate_pct: "5", ptr_pct: "4.75", lpi_due: D("2026-11-01"), payoff_on: D("2026-11-20") }).principal_cents, 19_200_000n);
  // through the bus: the wire that cleared Fri 11/20 opens the good-funds gate; the removal is projected only from that payoff_funds row
  const h = harness("2026-11-20T16:00:00.000Z"); const total = 19_200_000n + 46_849n; h.receive(total, D("2026-11-20"));
  const wire = await h.run("matchPayoffFunds", { loan_id: "L-1", amount_cents: total, method: "wire", received_at: "2026-11-20T16:00:00.000Z", quotes: [] });
  await assert.rejects(h.run("projectRemovalPayoff", { loan_id: "L-1", funds_id: wire.funds_id, fnma_loan_number: "1234567890", principal_cents: 18_000_000n, interest_cents: 46_849n, payoff_date: "2026-11-20" }), /NIB omitted/);
  assert.equal(h.store.list("investor_events").length, 0, "nothing projected without NIB");
  const ok = await h.run("projectRemovalPayoff", { loan_id: "L-1", funds_id: wire.funds_id, fnma_loan_number: "1234567890", principal_cents: 18_000_000n, nib_cents: 1_200_000n, interest_cents: 46_849n, payoff_date: "2026-11-20" });
  assert.equal((ok.lar60 as { principal_cents: bigint }).principal_cents, 19_200_000n); assert.equal((ok.lar96 as { record: string }).record.replace(/\r?\n?$/, "").length, 80); assert.equal(ok.lar60_due_at, toIso(zonedEpochMs(D("2026-11-23"), "20:00", ET)));
  await assert.rejects(h.run("projectRemovalPayoff", { loan_id: "L-1", fnma_loan_number: "1234567890", principal_cents: 18_000_000n, nib_cents: 1_200_000n, interest_cents: 46_849n, payoff_date: "2026-11-20" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_REMOVAL_WITHOUT_CLEARED_FUNDS");
  await assert.rejects(h.run("projectRemovalPayoff", { loan_id: "L-1", funds_cleared: true, fnma_loan_number: "1234567890", principal_cents: 18_000_000n, nib_cents: 1_200_000n, interest_cents: 46_849n, payoff_date: "2026-11-20" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_REMOVAL_WITHOUT_CLEARED_FUNDS", "a caller's funds_cleared attestation is not the good-funds gate");
  const held = await h.run("matchPayoffFunds", { loan_id: "L-1", funds_id: "pf-check", amount_cents: total, method: "check", received_at: "2026-11-20T16:00:00.000Z", quotes: [] }); assert.equal(held.status, "held");
  await assert.rejects(h.run("projectRemovalPayoff", { loan_id: "L-1", funds_id: held.funds_id, fnma_loan_number: "1234567890", principal_cents: 18_000_000n, nib_cents: 1_200_000n, interest_cents: 46_849n, payoff_date: "2026-11-20" }), /needs payoff.funds.cleared/);
});
test("16.2-T9: Given Fannie Mae advanced $1,250.00 of taxes recovered in the payoff, then a special remittance for $1,250.00 is instructed by 11/15/2026 and excluded from the CRS 001 amount.", async () => {
  const share = fnmaShare(SHARE);
  const r = advanceSpecialRemittance({ payoff_on: D("2026-10-16"), fnma_share_cents: share.total_cents, fnma_advance_repay_cents: 125_000n });
  assert.equal(r.crs_352_cents, 125_000n); assert.equal(r.special_remit_by, "2026-11-15"); assert.equal(r.crs_001_cents, share.total_cents); assert.equal(r.crs_001_cents, 20_098_942n);
  const b = crsBatch({ lender_id: "123456789", instructed_at_ms: zonedEpochMs(D("2026-10-16"), "15:00", ET), settlements: [{ loan_id: "L-1", fnma_loan_number: "1234567890", remittance_type: "AA", fnma_share_cents: share.total_cents, fnma_advance_repay_cents: 125_000n, payoff_on: D("2026-10-16") }] });
  assert.deepEqual(b.lines.map((l) => [l.code, l.amount_cents]), [["001", 20_098_942n], ["352", 125_000n]]); assert.equal(b.control_total_cents, 20_098_942n + 125_000n);
  assert.equal(housekeepingTasks({ payoff_on: D("2026-10-16"), escrowed: true, mi_active: false, autodraft: false, fnma_advance_repay_cents: 125_000n, buydown_remit_cents: 0n, enote: false }).find((t) => t.task === "fnma_advance_repay")!.due_on, "2026-11-15");
  assert.equal(housekeeping(D("2026-10-16")).fnma_advance_special_remit_by, "2026-11-15");
  // through the bus: the batch carries the 001 for the share and a separate 352 for the advance; FNMA_F109_ADVANCE_REPAY_30 arms on loan.paid_in_full{fnma_advance_repay_cents > 0} for 11/15 and closes when the 352 settles
  const h = harness(); const w = await workedPayoff(h, { fnma_advance_repay_cents: 125_000n });
  assert.deepEqual((w.batch!.lines as { code: string; amount_cents: bigint }[]).map((l) => [l.code, l.amount_cents]), [["001", 20_098_942n], ["352", 125_000n]]);
  assert.deepEqual(h.events.all().filter((e) => e.type === "payoff.remittance.instructed").map((e) => [e.payload.crs_code, e.payload.amount_cents]), [["001", 20_098_942n]], "the 001 instruction excludes the advance");
  assert.deepEqual(h.events.all().filter((e) => e.type === "remittances.instructed").map((e) => [e.payload.crs_code, e.payload.amount_cents]), [["352", 125_000n]]);
  const t = h.timer("FNMA_F109_ADVANCE_REPAY_30")!; assert.equal(t.dueDate, "2026-11-15"); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-16");
  await assert.rejects(h.run("buildCrsBatch", { lender_id: "123456789", include_advances_in_001: true, settlements: [] }), (e: unknown) => e instanceof CommandRefused && e.code === "ADVANCES_NEVER_IN_PROCEEDS");
  await assert.rejects(h.run("buildCrsBatch", { op: "confirm", loan_id: "L-1", settlement_id: w.posted.settlement_id, crs_code: "352", amount_cents: 20_098_942n + 125_000n, settled_on: "2026-11-13" }), /≠ payoff_settlements/, "the 352 confirmation must equal the stored advance");
  await h.run("buildCrsBatch", { op: "confirm", loan_id: "L-1", settlement_id: w.posted.settlement_id, crs_code: "352", amount_cents: 125_000n, settled_on: "2026-11-13", bank_reference: "CRS-352-9" });
  assert.equal(h.timer("FNMA_F109_ADVANCE_REPAY_30")!.status, "satisfied"); assert.equal(h.store.get("payoff_housekeeping_tasks", `${String(w.posted.settlement_id)}-fnma_advance_repay`)!.data.status, "completed");
  const none = harness(); await workedPayoff(none); assert.equal(none.timers.byCode("FNMA_F109_ADVANCE_REPAY_30").length, 0, "no advance, no special-remittance clock");
});
test("16.2-T10: Given the CRS batch missed the 16:00 ET cut-off on 10/16, then the draft settles 10/20, the timer breaches with sev-1, and the late-fee exposure is logged for the 6.3 reconciliation.", async () => {
  const r = missedCrsCutoff({ payoff_on: D("2026-10-16"), instructed_at_ms: zonedEpochMs(D("2026-10-16"), "16:30", ET), remittance_cents: 20_098_942n, prime_pct: "7.50" });
  assert.equal(r.missed, true); assert.equal(r.instruct_on, "2026-10-19"); assert.equal(r.settlement_on, "2026-10-20"); assert.equal(r.expected_settlement_on, "2026-10-19"); assert.equal(r.days_late, 1);
  assert.deepEqual(r.breach, { timer: "FNMA_F120_PAYOFF_AA_IMMEDIATE", severity: "sev1" }); assert.equal(loadRegistry().get("FNMA_F120_PAYOFF_AA_IMMEDIATE")!.severity.level, 1);
  assert.equal(r.late_fee_exposure!.cite, "A1-4.2-01"); assert.equal(r.late_fee_exposure!.logged_for, "6.3"); assert.equal(r.late_fee_exposure!.fee_cents, 25_000n, "one day late on $200,989.42 at prime + 3% is below the $250 ladder minimum");
  const onTime = missedCrsCutoff({ payoff_on: D("2026-10-16"), instructed_at_ms: zonedEpochMs(D("2026-10-16"), "15:00", ET), remittance_cents: 20_098_942n, prime_pct: "7.50" });
  assert.equal(onTime.missed, false); assert.equal(onTime.settlement_on, "2026-10-19"); assert.equal(onTime.breach, null); assert.equal(onTime.late_fee_exposure, null);
  // the registry timer itself: armed on the payoff date for 16:00 ET, breached sev-1 at 16:30 ET, satisfied late by the next-BD instruction that settles 10/20
  const h = harness(); const p = await workedPayoff(h, { instructed_at: "2026-10-16T19:00:00.000Z" });
  const late = harness(); late.receive(EXACT); const funds = await late.run("matchPayoffFunds", { loan_id: "L-1", amount_cents: EXACT, method: "wire", received_at: WIRE_AT, bank_reference: "Q-1187", quotes: QUOTES });
  const posted = await late.run("postPayoff", { loan_id: "L-1", funds_id: funds.funds_id, amount_cents: EXACT, payoff_date: "2026-10-16", buckets: BUCKETS, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: "2026-09-01" });
  late.clock.set("2026-10-16T20:30:00.000Z");
  const breaches = late.timers.evaluate(late.clock.now()); assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity]), [["FNMA_F120_PAYOFF_AA_IMMEDIATE", 1]]); assert.match(breaches[0]!.breachText, /sev-1/);
  const batch = await late.run("buildCrsBatch", { lender_id: "123456789", instructed_at: "2026-10-16T20:30:00.000Z", settlements: [{ loan_id: "L-1", settlement_id: posted.settlement_id, fnma_loan_number: "1234567890", remittance_type: "AA", fnma_share_cents: 20_098_942n, payoff_on: D("2026-10-16") }] });
  assert.equal(batch.before_cutoff, false); assert.equal(batch.batch_on, "2026-10-19"); assert.equal(batch.settlement_on, "2026-10-20"); assert.equal(late.timer("FNMA_F120_PAYOFF_AA_IMMEDIATE")!.status, "satisfied_late");
  assert.equal(h.timer("FNMA_F120_PAYOFF_AA_IMMEDIATE")!.status, "satisfied"); assert.equal(p.batch!.settlement_on, "2026-10-19");
  // "(else next BD)": a payoff date deemed Sun 11/01 (rule 1, F-1-09) is due the next fannie BD, Mon 11/02 16:00 ET — not a Sunday breach before the funds are even in
  const sun = harness("2026-11-02T15:00:00.000Z"); sun.receive(EXACT, D("2026-11-02"));
  const f = await sun.run("matchPayoffFunds", { loan_id: "L-1", amount_cents: EXACT, method: "wire", received_at: "2026-11-02T15:00:00.000Z", bank_reference: "Q-1187", due_on: "2026-11-01", quotes: QUOTES }); assert.deepEqual([f.payoff_date, f.payoff_date_basis], ["2026-11-01", "f109_non_business_day"]);
  await sun.run("postPayoff", { loan_id: "L-1", funds_id: f.funds_id, amount_cents: EXACT, payoff_date: "2026-11-01", buckets: BUCKETS, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: "2026-09-01" });
  const t = sun.timer("FNMA_F120_PAYOFF_AA_IMMEDIATE")!; assert.equal(t.anchorDate, "2026-11-01"); assert.equal(t.dueDate, "2026-11-02"); assert.equal(t.dueAt, zonedEpochMs(D("2026-11-02"), "16:00", ET)); assert.deepEqual(sun.timers.evaluate(sun.clock.now()), []);
});
test("16.2-T11: Given an autodraft scheduled 10/20 on a loan paid off 10/16, then the authorization is terminated 10/16 and, if a debit still occurs, the funds are refunded within 10 BD as `post_payoff_receipt`.", async () => {
  const stop = autodraftStop({ payoff_on: D("2026-10-16"), next_draft_on: D("2026-10-20"), enrollment_status: "active" });
  assert.equal(stop.terminate_on, "2026-10-16"); assert.equal(stop.status, "terminated"); assert.equal(stop.termination_reason, "payoff"); assert.equal(stop.next_draft_on, null); assert.equal(stop.stop_entry, true); assert.equal(stop.debit_risk, false); assert.equal(stop.timer, "SM_PAYOFF_AUTODRAFT_STOP_T0");
  assert.deepEqual(stop.transition, { ok: true, from: "active", to: "terminated", on: "terminate" }, "2.3's enrollment machine drives the termination");
  const transmitted = autodraftStop({ payoff_on: D("2026-10-16"), next_draft_on: D("2026-10-20"), enrollment_status: "active", file_transmitted_on: D("2026-10-15") });
  assert.equal(transmitted.stop_entry, false); assert.equal(transmitted.debit_risk, true);
  // through the bus: the housekeeping task closes with the 2.3 enrollment terminated and the T0 timer satisfied by `autodraft.enrollment.terminated{reason=payoff}`
  const h = harness(); const r = await workedPayoff(h, { autodraft: true });
  h.store.put("autodraft_enrollments", "E-1", { loan_id: "L-1", status: "active", next_draft_on: "2026-10-20", draft_day: 20 }, AGENT, h.clock.now());
  const t0 = h.timer("SM_PAYOFF_AUTODRAFT_STOP_T0")!; assert.equal(t0.dueDate, "2026-10-16"); assert.equal(t0.status, "armed");
  const done = await h.run("createHousekeepingTasks", { op: "complete", settlement_id: r.posted.settlement_id, loan_id: "L-1", task: "autodraft_stop", enrollment_id: "E-1", evidence_document_id: "doc-stop-1" });
  assert.equal(done.status, "completed"); const e = h.store.get("autodraft_enrollments", "E-1")!.data; assert.deepEqual([e.status, e.terminated_on, e.termination_reason, e.next_draft_on], ["terminated", "2026-10-16", "payoff", null]);
  assert.equal(h.timer("SM_PAYOFF_AUTODRAFT_STOP_T0")!.status, "satisfied"); assert.ok(h.types().includes("autodraft.enrollment.terminated"));
  const pr = postPayoffReceipt({ received_on: D("2026-10-20"), amount_cents: 142_011n, remitter: "borrower", source: "autodraft" });
  assert.equal(pr.suspense_reason, "post_payoff_receipt"); assert.equal(pr.refund_by, "2026-11-03"); assert.equal(pr.timer, "SM_OVERPAYMENT_REFUND_10BD");
  assert.equal(housekeepingTasks({ payoff_on: D("2026-10-16"), escrowed: false, mi_active: false, autodraft: true, fnma_advance_repay_cents: 0n, buydown_remit_cents: 0n, enote: false }).find((t) => t.task === "autodraft_stop")!.due_on, "2026-10-16");
  // the debit that still occurs on Tue 10/20: suspense_items{post_payoff_receipt} arms 6.5's SM_OVERPAYMENT_REFUND_10BD for Tue 11/03; the refund on 10/27 (5 BD) closes it on suspense.item.closed{status=refunded} with the overage advice, nothing to fees
  h.clock.set("2026-10-20T13:00:00.000Z"); h.receive(142_011n, D("2026-10-20"));
  const rcpt = await h.run("disposeVariance", { op: "post_payoff_receipt", loan_id: "L-1", amount_cents: 142_011n, received_on: "2026-10-20", remitter: "A. Borrower", source: "autodraft" });
  assert.equal(rcpt.refund_by, "2026-11-03"); assert.equal(h.store.get("suspense_items", String(rcpt.suspense_item_id))!.data.reason_code, "post_payoff_receipt");
  const created = h.events.all().find((e) => e.type === "suspense.item.created" && e.payload.reason_code === "post_payoff_receipt")!; assert.ok(eventMatches(REG.get("SM_OVERPAYMENT_REFUND_10BD")!.triggerPattern!, created));
  const ref = h.timer("SM_OVERPAYMENT_REFUND_10BD")!; assert.equal(ref.anchorDate, "2026-10-20"); assert.equal(ref.dueDate, "2026-11-03"); assert.equal(ref.status, "armed");
  assert.equal(h.ledger.balance({ scope: "custodial", custodialAccountId: "C-CLR", account: "clearing_cash" }), 0n); assert.equal(h.ledger.balance(custAcct("C-TI", "custodial_ti_cash")), 241_290n + 142_011n);
  await assert.rejects(h.run("disposeVariance", { op: "refund", loan_id: "L-1", suspense_item_id: rcpt.suspense_item_id, issued_on: "2026-10-27", apply_to_fees_cents: 2_500n }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_FEES_FROM_POST_PAYOFF_RECEIPT");
  h.clock.set("2026-10-27T15:00:00.000Z");
  const refund = await h.run("disposeVariance", { op: "refund", loan_id: "L-1", suspense_item_id: rcpt.suspense_item_id, issued_on: "2026-10-27", settlement_id: r.posted.settlement_id, recipients: BORROWER, refund_payee: "A. Borrower", refund_method: "check" });
  assert.equal(refund.refund_cents, 142_011n); assert.equal(refund.on_time, true); assert.equal(refund.bd_after_receipt, 5); assert.equal(refund.applied_to_fees_cents, 0n);
  assert.equal(h.timer("SM_OVERPAYMENT_REFUND_10BD")!.status, "satisfied"); assert.equal(h.store.get("suspense_items", String(rcpt.suspense_item_id))!.data.status, "refunded"); assert.equal(h.store.get("disbursements", String(refund.disbursement_id))!.data.kind, "payoff_overage_refund");
  assert.equal(h.ledger.balance(loanAcct("suspense_unapplied")), 0n); assert.equal(h.ledger.balance(custAcct("C-TI", "custodial_ti_cash")), 241_290n, "the T&I custodial is back to the escrow balance: the receipt went out in full");
  const advice = h.notices.all().find((n) => n.templateCode === "NTC_PAYOFF_OVERAGE_REFUND_ADVICE")!; assert.equal(advice.status, "sent"); assert.match(advice.rendered.text, /refund of \$1,420\.11/); assert.match(advice.rendered.text, /5 business days after receipt/);
  assert.equal(refundOverage({ loan_id: "L-1", custodial_ti: "C-TI", received_on: D("2026-10-20"), issued_on: D("2026-11-04"), amount_cents: 1n }).on_time, false, "11/04 is the 11th servicer business day");
  // an overage on the payoff itself takes the same rail: suspense.item.created{reason_code=overpayment} arms the clock
  const o = harness(); await shortReceipt(o, EXACT + 26_500n);
  const over = await o.run("disposeVariance", { loan_id: "L-1", amount_cents: EXACT + 26_500n, exact_total_cents: EXACT, reliance_state: false, within_good_through: true, received_on: "2026-10-16" });
  assert.equal(over.outcome, "overage_refund"); assert.equal(o.timer("SM_OVERPAYMENT_REFUND_10BD")!.dueDate, "2026-10-30");
});
test("16.2-T12: Given a NoE alleging the payoff statement understated the balance and caused a shortage, then 4.1's clocks run, the shortage is `servicer_absorbed`, and the response cites the statement hash.", async () => {
  const exact = exactFigure(EX, D("2026-10-16")).total_cents;
  const r = statementShortageNoe({ noe_received_on: D("2026-10-21"), statement_hash: "sha256:9f2c1e", statement_total_cents: 20_083_037n, exact_total_cents: exact, amount_cents: 20_083_037n, loan_id: "L-1" });
  assert.equal(r.assertion, "b6"); assert.equal(r.clocks.profile, "payoff_7"); assert.equal(r.clocks.ack_due, "2026-10-28"); assert.equal(r.clocks.response_due, "2026-10-30"); assert.equal(r.clocks.extendable, false);
  assert.equal(r.shortage_cents, 22_110n); assert.equal(r.shortage_disposition, "servicer_absorbed"); assert.equal(r.demand, false); assert.equal(r.expense_account, "payoff_shortfall_expense"); assert.equal(r.officer_approval_required, false);
  assert.equal(r.response.cites_statement_hash, true); assert.equal(r.response.statement_hash, "sha256:9f2c1e"); assert.match(r.response.text, /content hash sha256:9f2c1e/); assert.match(r.response.text, /paid in full/);
  assert.deepEqual([r.noe.payoff_assertion, r.noe.ack_required, r.noe.payment_related, r.noe.receipt_date], [true, true, false, "2026-10-21"]);   // 4.1: a (b)(6) payoff-statement assertion is not payment-related (no §1024.35(i) suppression)
  assert.equal(statementShortageNoe({ noe_received_on: D("2026-10-21"), statement_hash: "h", statement_total_cents: 20_000_000n, exact_total_cents: exact, amount_cents: 20_000_000n }).officer_approval_required, true, "absorbed shortages > $500 need the officer");
  assert.throws(() => statementShortageNoe({ noe_received_on: D("2026-10-21"), statement_hash: " ", statement_total_cents: 20_083_037n, exact_total_cents: exact, amount_cents: 20_083_037n }), /content hash is required/);
  // through the bus: the NoE received Wed 10/21 opens the 4.1 case — ack by Wed 10/28 (5 federal BD), the b6 response by Fri 10/30 (7 federal BD), credit reporting suppressed 60 days — and the shortage is absorbed, never demanded
  const h = harness(); await shortReceipt(h, 20_083_037n);
  await h.run("disposeVariance", { loan_id: "L-1", amount_cents: 20_083_037n, exact_total_cents: exact, reliance_state: false, within_good_through: true, received_on: "2026-10-16", remitter: "closing_agent" });
  h.clock.set("2026-10-21T14:00:00.000Z");
  const noe = await h.run("disposeVariance", { op: "statement_noe", loan_id: "L-1", noe_received_on: "2026-10-21", statement_hash: "sha256:9f2c1e", statement_total_cents: 20_083_037n, exact_total_cents: exact, amount_cents: 20_083_037n });
  const opened = h.events.all().find((e) => e.type === "case.noe.opened")!; assert.equal(opened.payload.payoff_assertion, true); assert.equal(opened.payload.case_id, noe.case_id); assert.equal(h.store.get("cases", String(noe.case_id))!.data.case_type, "noe");
  assert.deepEqual([h.timer("REGX_1024_35D_NOE_ACK_5")!.dueDate, h.timer("REGX_1024_35E_NOE_PAYOFF_RESPONSE_7")!.dueDate, h.timer("REGX_1024_35I_CREDIT_SUPPRESS_60")], ["2026-10-28", "2026-10-30", undefined]);   // 4.1: the (b)(6) assertion is not payment-related, so no §1024.35(i) suppression clock
  assert.deepEqual(h.events.all().filter((e) => e.type === "payoff.shortage.resolved").map((e) => [e.payload.outcome, e.payload.disposition, e.payload.statement_hash]), [["absorbed", "servicer_absorbed", "sha256:9f2c1e"]]);
  assert.equal(h.store.get("suspense_items", "si-L-1-short_payoff")!.data.status, "absorbed"); assert.equal(h.timer("SM_PAYOFF_SHORTAGE_UNCURED_30")!.status, "satisfied"); assert.equal(h.timer("SM_PAYOFF_SHORTAGE_DEMAND_1BD")!.status, "armed", "no demand issues on a statement error; the letter clock is left to the absorbed disposition");
  assert.match(String((noe.response as { text: string }).text), /content hash sha256:9f2c1e/);
  await assert.rejects(h.run("disposeVariance", { op: "statement_noe", loan_id: "L-1", noe_received_on: "2026-10-21", statement_hash: "sha256:aa", statement_total_cents: 20_000_000n, exact_total_cents: exact, amount_cents: 20_000_000n }), (e: unknown) => e instanceof CommandRefused && e.code === "OFFICER_ABSORBS_OVER_500");
  const d = disposeVariance({ amount_cents: 20_083_037n, exact_total_cents: exact, reliance_state: false, within_good_through: true, statement_error: true, received_on: D("2026-10-16") });
  assert.equal(d.shortage_disposition, "servicer_absorbed"); assert.equal(d.demand, false); assert.equal(d.outcome, "absorbed");
});

test("16.2 worked figures: UPB $199,500.00 at 6.250% from LPI 09/01/2026 to payoff 10/16/2026 → September $1,039.06 + October 15 days $512.41 = $1,551.47 collected, total $201,051.47; at PTR 6.000% $997.50 + $491.92 = $1,489.42, fee $62.05, CRS 001 $200,989.42; S/S gap $505.58; S/A half month $498.75 vs $491.92 collected → $6.83 deficit; escrow $2,412.90 refunded by 11/16/2026", () => {
  const note = interest(19_950_000n, "6.250", D("2026-09-01"), D("2026-10-16"));
  assert.deepEqual([note.months_full, note.days_partial, note.full_cents, note.partial_cents, note.total_cents], [1, 15, 103_906n, 51_241n, 155_147n]);
  const q = quote(EX); assert.equal(q.total_cents, 20_105_147n); assert.equal(q.total_cents - q.interest.total_cents, 19_950_000n);
  const ptr = interest(19_950_000n, "6.000", D("2026-09-01"), D("2026-10-16"));
  assert.deepEqual([ptr.full_cents, ptr.partial_cents, ptr.total_cents], [99_750n, 49_192n, 148_942n]);
  const aa = fnmaPayoffShare(SHARE); assert.deepEqual([aa.interest_cents, aa.servicing_fee_cents, aa.total_cents], [148_942n, 6_205n, 20_098_942n]); assert.equal(aa.collected_interest_cents - aa.interest_cents, 6_205n);
  assert.equal(fnmaPayoffShare({ ...SHARE, participation_pct: "50" }).total_cents, 10_049_471n, "principal_due = (UPB + NIB) × participation_pct (rule 4)");
  const ss = fnmaPayoffShare({ ...SHARE, type: "SS" }); assert.equal(ss.interest_cents, 99_750n); assert.equal(ss.ss_interest_gap_cents, 50_558n); assert.equal(ss.interest_cents - ptr.partial_cents, 50_558n);
  assert.deepEqual([ss.servicing_fee_cents, ss.scheduled_cycle_interest_cents, ss.interest_deficit_cents], [6_205n, 99_750n, 50_558n], "S/S: the fee is still note rate − PTR on the days collected; September at PTR is scheduled-cycle interest");
  const sa = saInterestDeficit({ upb_cents: 19_950_000n, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: D("2026-09-01"), payoff_on: D("2026-10-16") });
  assert.deepEqual([sa.fnma_half_month_cents, sa.collected_ptr_equivalent_cents, sa.deficit_cents, sa.servicer_funds], [49_875n, 49_192n, 683n, true]);
  assert.deepEqual([fnmaPayoffShare({ ...SHARE, type: "SA" }).servicing_fee_cents, fnmaPayoffShare({ ...SHARE, type: "SA" }).interest_deficit_cents], [6_205n, 683n]);
  const posted = applyToZero({ accrued_interest: note.total_cents, principal: 19_950_000n, escrow_balance: 241_290n }, 20_105_147n);
  assert.equal(posted.zero, true); assert.equal(posted.unapplied_cents, 0n); assert.equal(posted.total_due_cents, 20_105_147n); assert.equal(posted.tolerance_expense_cents, 0n);
  const sets = payoffLedgerSets({ loan_id: "L-1", custodial: { pi: "C-PI", ti: "C-TI", clearing: "C-CLR" }, payoff_on: D("2026-10-16"), received_cents: 20_105_147n, application: posted, buydown_cents: 0n, share: aa, remittance_type: "AA" });
  assert.equal(sets.balanced, true); assert.equal(sets.fnma_payable_cents, 20_098_942n); assert.equal(sets.servicing_fee_withdrawable_cents, 6_205n); assert.equal(sets.servicer_funded_cents, 0n); assert.equal(sets.scheduled_cycle_interest_cents, 0n);
  const ssSets = payoffLedgerSets({ loan_id: "L-1", custodial: { pi: "C-PI", ti: "C-TI", clearing: "C-CLR" }, payoff_on: D("2026-10-16"), received_cents: 20_105_147n, application: posted, buydown_cents: 0n, share: ss, remittance_type: "SS" });
  assert.equal(ssSets.balanced, true); assert.deepEqual([ssSets.fnma_payable_cents, ssSets.scheduled_cycle_interest_cents, ssSets.servicing_fee_withdrawable_cents, ssSets.servicer_funded_cents], [19_950_000n + 99_750n, 99_750n, 6_205n, 50_558n]);
  // the escrow balance is refunded — issued 10/26 after the 5-BD in-flight hold, never later than Mon 11/16/2026 (20 federal BD; Veterans Day 11/11 excluded) — and the refund set zeroes the escrow account
  const ledger = new MemoryLedger(); ledger.post({ effectiveDate: D("2026-10-01"), description: "escrow", lines: [{ account: { scope: "custodial", custodialAccountId: "C-TI", account: "custodial_ti_cash" }, amountCents: 241_290n, ruleRef: "test" }, { account: loanAcct("escrow"), amountCents: -241_290n, ruleRef: "test" }] });
  const refund = escrowRefund({ loan_id: "L-1", custodial_ti: "C-TI", payoff_on: D("2026-10-16"), escrow_balance_cents: -ledger.balance(loanAcct("escrow")) });
  assert.equal(refund.refund_cents, 241_290n); assert.deepEqual([refund.issue_on, refund.due_by], ["2026-10-26", "2026-11-16"]); ledger.post(refund.entry_set!); assert.equal(ledger.balance(loanAcct("escrow")), 0n); assert.equal(ledger.balance({ scope: "custodial", custodialAccountId: "C-TI", account: "custodial_ti_cash" }), 0n);
  const hk = housekeepingTasks({ payoff_on: D("2026-10-16"), escrowed: true, mi_active: true, autodraft: true, fnma_advance_repay_cents: 0n, buydown_remit_cents: 0n, enote: false });
  const due = (t: string) => hk.find((r) => r.task === t)!.due_on;
  assert.equal(due("escrow_refund"), "2026-11-16"); assert.equal(due("short_year_statement"), "2026-12-15"); assert.equal(due("mi_notify"), "2026-10-20"); assert.equal(due("insurance_interest_remove"), "2026-10-23"); assert.equal(due("tax_service_delete"), "2026-10-23"); assert.equal(due("paid_in_full_letter"), "2026-10-23"); assert.equal(due("autodraft_stop"), "2026-10-16");
});

test("16.2 rule 1 and the good-funds policy: payoff date = credited_as_of / closing-agent settlement date for S/S / F-1-09 non-business-day rule; wire final on receipt, cashier's 1 BD, personal 7 BD, ACH credit at settlement, ACH debit ≤ $25,000 with a 5-BD hold; unmatched wire within ± tolerance applies", async () => {
  assert.deepEqual(payoffDate({ received_on: D("2026-10-16"), remittance_type: "AA", paid_by: "borrower" }), { payoff_date: "2026-10-16", basis: "credited_as_of" });
  assert.deepEqual(payoffDate({ received_on: D("2026-10-19"), remittance_type: "SS", paid_by: "closing_agent", settlement_date: D("2026-10-16") }), { payoff_date: "2026-10-16", basis: "closing_agent_settlement_date" });
  assert.deepEqual(payoffDate({ received_on: D("2026-11-02"), remittance_type: "AA", paid_by: "borrower", due_on: D("2026-11-01") }), { payoff_date: "2026-11-01", basis: "f109_non_business_day" });
  const at = zonedEpochMs(D("2026-10-16"), "11:40", ET);
  assert.equal(goodFundsClearing({ method: "wire", amount_cents: EXACT, received_at_ms: at }).status, "cleared");
  const cc = goodFundsClearing({ method: "cashiers_check", amount_cents: EXACT, received_at_ms: at }); assert.deepEqual([cc.status, cc.cleared_on], ["held", "2026-10-19"]); assert.equal(goodFundsClearing({ method: "cashiers_check", amount_cents: EXACT, received_at_ms: at, bank_verified: true }).status, "cleared");
  assert.equal(goodFundsClearing({ method: "check", amount_cents: EXACT, received_at_ms: at }).cleared_on, "2026-10-27"); assert.equal(goodFundsClearing({ method: "ach_credit", amount_cents: EXACT, received_at_ms: at, settlement_date: D("2026-10-19") }).cleared_on, "2026-10-19");
  assert.equal(goodFundsClearing({ method: "ach_debit", amount_cents: 2_000_000n, received_at_ms: at }).cleared_on, "2026-10-23"); assert.equal(goodFundsClearing({ method: "ach_debit", amount_cents: EXACT, received_at_ms: at }).status, "refused");
  assert.equal(matchFunds({ amount_cents: EXACT + 200n, bank_reference: null, received_on: D("2026-10-16"), quotes: QUOTES }).basis, "amount_within_tolerance", "unreferenced wire $2 over the open quote applies (edge case: ± tolerance)");
  const h = harness();
  await assert.rejects(h.run("matchPayoffFunds", { loan_id: "L-1", amount_cents: EXACT, method: "ach_debit", received_at: WIRE_AT }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_ACH_DEBIT_PAYOFF_OVER_25K");
  const held = await h.run("matchPayoffFunds", { loan_id: "L-1", amount_cents: EXACT, method: "cashiers_check", received_at: WIRE_AT, quotes: [] });
  assert.equal(held.status, "held"); assert.equal(h.timer("SM_PAYOFF_GOODFUNDS_GATE")!.status, "armed"); assert.ok(!h.types().includes("payoff.funds.cleared"));
  await assert.rejects(h.run("postPayoff", { loan_id: "L-1", funds_id: held.funds_id, amount_cents: EXACT, payoff_date: "2026-10-16", buckets: BUCKETS }), /needs payoff.funds.cleared/);
  await assert.rejects(h.run("postPayoff", { loan_id: "L-1", funds_cleared: true, amount_cents: EXACT, payoff_date: "2026-10-16", buckets: BUCKETS }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_POST_BEFORE_CLEARED", "a caller's attestation never opens the gate");
  h.clock.set("2026-10-19T14:00:00.000Z"); await h.run("matchPayoffFunds", { op: "clear", loan_id: "L-1", funds_id: held.funds_id });
  assert.equal(h.timer("SM_PAYOFF_GOODFUNDS_GATE")!.status, "satisfied"); assert.equal(h.timer("SM_PAYOFF_POST_TO_ZERO_1BD")!.dueDate, "2026-10-20");
});
