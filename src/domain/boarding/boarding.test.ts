/**
 * Acceptance tests from spec §1.1 "Test cases and acceptance criteria" (1.1-T1 … 1.1-T10).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryEventStore, FixedClock, SYSTEM } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadRegistry, TimerEngine } from "../../kernel/timers/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { cents } from "../../kernel/money/cents.ts";
import { BoardingService } from "./service.ts";
import { applyBoardingTimerOverrides } from "./timers.ts";
import { stagedLoan, batchContext, FakePositions, history, PARTNER_ORG } from "./fixtures.ts";
import { makeMin, isValidMin, luhnCheckDigit } from "./min.ts";
import { applyFifo, regxDaysDelinquent, fnmaDelinquencyStatus } from "./delinquency.ts";

const OFFICER = { kind: "human" as const, id: "u-officer", role: "officer" };
const ANALYST = { kind: "human" as const, id: "u-analyst", role: "analyst" };
const AGENT = { kind: "agent" as const, id: "boarding" };

function harness(nowIso: string, transferDate = D("2026-10-01"), processes = ["1.1", "11.1", "11.2"]) {
  const clock = new FixedClock(nowIso);
  const events = new MemoryEventStore(clock);
  const ledger = new MemoryLedger();
  const registry = loadRegistry();
  applyBoardingTimerOverrides(registry);
  const timers = new TimerEngine(registry, events, { processes });
  const ext = new FakePositions();
  const svc = new BoardingService({ events, ledger, ext, clock, clearingAccountId: "CUST-CLEARING" });
  const batch = batchContext({ transfer_date: transferDate });
  svc.openBatch(batch);
  return { clock, events, ledger, timers, ext, svc, batch };
}

test("MERS MIN Mod-10 check digit", () => {
  assert.equal(luhnCheckDigit("7992739871"), 3);                 // canonical Luhn example → 79927398713
  const min = makeMin(PARTNER_ORG, "42");
  assert.equal(min.length, 18);
  assert.ok(isValidMin(min));
  const bad = min.slice(0, 17) + String((Number(min[17]) + 1) % 10);
  assert.ok(!isValidMin(bad));
  assert.ok(!isValidMin("12345"));
});

test("§1024.31 FIFO delinquency counter and MBA buckets", () => {
  const P = cents("2000");
  // 11.1 worked example: Nov 1 unpaid; $1,200 on Nov 20 (partial), Dec 1 unpaid, $1,200 on Dec 10 → Nov 1 satisfied credited_as_of Dec 10, $400 unapplied.
  const r = applyFifo([{ due_date: D("2026-11-01"), amount_cents: P }, { due_date: D("2026-12-01"), amount_cents: P }],
    [{ received_on: D("2026-11-20"), amount_cents: cents("1200") }, { received_on: D("2026-12-10"), amount_cents: cents("1200") }]);
  assert.equal(r.installments[0]!.satisfied_on, "2026-12-10");
  assert.equal(r.installments[1]!.satisfied_on, null);
  assert.equal(r.unapplied_cents, cents("400"));
  assert.equal(regxDaysDelinquent(r.installments, D("2026-12-11")), 10);      // 2026-12-11 − 2026-12-01
  assert.equal(fnmaDelinquencyStatus(r.installments, D("2026-12-31")), "30"); // LPI 11/01, Dec 1 unpaid → 30, not 60
  assert.equal(regxDaysDelinquent(r.installments, D("2026-11-30")), 29);
});

test("1.1-T1: a 5,000-loan preliminary tape with all hard rules satisfied validates 100% and produces a DQ scorecard", () => {
  const { svc, ext } = harness("2026-09-17T02:00:00.000Z");
  const rows = Array.from({ length: 5000 }, (_, i) => stagedLoan({ seq: i + 1 }));
  for (const r of rows) ext.agree(r);
  const receipt = svc.ingestTape("B1", "preliminary", `tape-bytes-${rows.length}`, rows.length);
  assert.equal(receipt.status, "accepted");
  svc.stage("B1", rows);
  const card = svc.validate("B1");
  assert.equal(card.loans.validated, 5000);
  assert.equal(card.loans.exception, 0);
  assert.deepEqual(card.hard, {});
  assert.equal(card.hard_fail_rate, 0);
  assert.equal(card.rule_set_version, "boarding.dq.v1");
});

test("1.1-T2: tape UPB $245,634.12 vs Fannie Mae position $245,634.13 → HF-003, exception, transferor query lists both values in cents", () => {
  const { svc, ext } = harness("2026-09-17T02:00:00.000Z");
  const loan = stagedLoan({ upb_cents: cents("245634.12") });
  ext.agree(loan);
  ext.fnmaRows.set(loan.fnma_loan_number!, { ...ext.fnmaRows.get(loan.fnma_loan_number!)!, upb_cents: cents("245634.13") });
  const [bl] = svc.stage("B1", [loan]);
  const card = svc.validate("B1");
  assert.equal(bl!.status, "exception");
  assert.equal(card.hard["HF-003"], 1);
  const q = svc.transferorQuery(bl!.id);
  assert.equal(q.items.length, 1);
  assert.deepEqual(q.items[0]!.expected, { fnma_position_cents: "24563413" });
  assert.deepEqual(q.items[0]!.actual, { tape_cents: "24563412" });
  assert.equal(q.items[0]!.money_field, true);
});

test("1.1-T3: fixed-rate 6.375% loan with tape P&I $1,616.03 recomputes within $0.01; monthly interest on $245,634.12 is $1,304.93", () => {
  const { svc, ext } = harness("2026-09-17T02:00:00.000Z");
  const loan = stagedLoan({ pi_cents: cents("1616.03") });
  ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]);
  svc.validate("B1");
  assert.equal(bl!.validations.find((v) => v.code === "HF-005")!.result, "pass");
  assert.equal(svc.scheduledInterest(bl!), cents("1304.93"));
  // and a P&I that is off by more than a cent fails HF-005 with both figures
  const off = stagedLoan({ seq: 2, pi_cents: cents("1616.10") });
  ext.agree(off);
  const [bl2] = svc.stage("B1", [off]);
  svc.validate("B1");
  const v = bl2!.validations.find((x) => x.code === "HF-005")!;
  assert.equal(v.result, "fail");
  assert.deepEqual(v.actual, { tape_pi_cents: "161610" });
});

test("1.1-T4: a MIN with a wrong check digit fails HF-008 and the loan cannot board", () => {
  const { svc, ext, clock } = harness("2026-09-17T02:00:00.000Z");
  const good = makeMin(PARTNER_ORG, "77");
  const loan = stagedLoan({ min: good.slice(0, 17) + String((Number(good[17]) + 5) % 10) });
  ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]);
  svc.validate("B1");
  assert.equal(bl!.status, "exception");
  assert.equal(bl!.validations.find((v) => v.code === "HF-008")!.result, "fail");
  clock.set("2026-10-01T14:00:00.000Z");
  const r = svc.board("B1", { finalTapeReconciled: true });
  assert.equal(r.boarded.length, 0);
  assert.equal(bl!.status, "exception");
});

test("1.1-T5: earliest unpaid due date Aug 1, 2026 and transfer Oct 1 → 61 days delinquent, FDCPA flag, 11.1/11.2 timers seeded already breached", () => {
  const { svc, ext, timers, clock } = harness("2026-10-01T14:00:00.000Z");
  const pi = stagedLoan().pi_cents!, esc = stagedLoan().escrow_payment_cents;
  const h = history(D("2026-06-01"), 5, pi + esc, 2);           // Jun, Jul paid; Aug 1, Sep 1, Oct 1 unpaid
  const loan = stagedLoan({ installments: h.installments, payments: h.payments });
  ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]);
  svc.validate("B1");
  const r = svc.board("B1", { finalTapeReconciled: true });
  assert.equal(r.boarded.length, 1);
  assert.equal(bl!.regx_days_delinquent_at_boarding, 61);
  assert.equal(bl!.fnma_delinquency_status_at_boarding, "60");
  assert.equal(bl!.fdcpa_debt_collector_flag, true);
  assert.equal(bl!.default_status_at_boarding, true);
  // Windows for Aug 1 and Sep 1 (Oct 1 is due today, not yet a window).
  const live = timers.byCode("REGX_1024_39A_LIVE_CONTACT_36").filter((t) => t.loanId === bl!.id);
  const notice = timers.byCode("REGX_1024_39B_WRITTEN_NOTICE_45").filter((t) => t.loanId === bl!.id);
  assert.deepEqual(live.map((t) => t.dueDate), ["2026-09-06", "2026-10-07"]);
  assert.deepEqual(notice.map((t) => t.dueDate), ["2026-09-15", "2026-10-16"]);
  const breaches = timers.evaluate(clock.now());
  const codes = breaches.map((b) => `${b.def.code}@${b.instance.dueDate}`).sort();
  assert.deepEqual(codes, ["REGX_1024_39A_LIVE_CONTACT_36@2026-09-06", "REGX_1024_39B_WRITTEN_NOTICE_45@2026-09-15"]);
  assert.ok(breaches.every((b) => b.severity === 1 && b.escalateTo.includes("officer")));
});

test("1.1-T6: transfer date Oct 1, 2026 (Thursday) with next due Oct 1 → SM_BOARD_FIRST_CYCLE due Oct 1; boarding on Oct 2 records a sev-1 breach", () => {
  const { svc, ext, timers, clock } = harness("2026-09-20T14:00:00.000Z");
  const loan = stagedLoan({ next_due_date: D("2026-10-01") });
  ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]);
  assert.equal(bl!.first_cycle_due, "2026-10-01");
  const fc = timers.byCode("SM_BOARD_FIRST_CYCLE")[0]!;
  assert.equal(fc.dueDate, "2026-10-01");
  assert.equal(toIso(fc.dueAt!), toIso(zonedEpochMs(D("2026-10-01"), "23:59", "America/New_York")));
  svc.validate("B1");
  clock.set("2026-10-02T12:00:00.000Z");
  const breaches = timers.evaluate(clock.now());
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0]!.def.code, "SM_BOARD_FIRST_CYCLE");
  assert.equal(breaches[0]!.severity, 1);
  svc.board("B1", { finalTapeReconciled: true });
  assert.equal(fc.status, "satisfied_late");
  // A loan whose next due date is later than T+3 BD anchors on T+3 BD instead (Oct 1 + 3 servicer BD = Oct 6).
  const later = stagedLoan({ seq: 2, next_due_date: D("2026-11-01") });
  ext.agree(later);
  assert.equal(svc.stage("B1", [later])[0]!.first_cycle_due, "2026-10-06");
});

test("1.1-T7: escrowed loan boarded Dec 2, 2026 16:00 ET → EscrowSetup due 03:00 ET Dec 3; a rejected event re-queues and breaches if not acked", () => {
  const boardedAt = toIso(zonedEpochMs(D("2026-12-02"), "16:00", "America/New_York"));
  const { svc, ext, timers, events, clock } = harness(boardedAt, D("2026-12-01"), ["1.1"]);
  const h = history(D("2026-09-01"), 4, stagedLoan().pi_cents! + stagedLoan().escrow_payment_cents, 4);
  const escrowed = stagedLoan({ escrowed: true, next_due_date: D("2027-01-01"), installments: h.installments, payments: h.payments });
  const nonEscrowed = stagedLoan({ seq: 2, escrowed: false, escrow_lines: [], escrow_balance_cents: 0n, escrow_payment_cents: 0n, next_due_date: D("2027-01-01"), installments: h.installments, payments: h.payments });
  ext.agree(escrowed); ext.agree(nonEscrowed);
  const [bl] = svc.stage("B1", [escrowed, nonEscrowed]);
  svc.validate("B1");
  const r = svc.board("B1", { finalTapeReconciled: true });
  assert.equal(r.boarded.length, 2);
  const setup = timers.byCode("LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1");
  assert.equal(setup.length, 1);                                  // only the escrowed loan
  assert.equal(setup[0]!.loanId, bl!.id);
  assert.equal(toIso(setup[0]!.dueAt!), "2026-12-03T08:00:00.000Z");
  // Fannie Mae rejects the event → re-queued; the timer stays armed and breaches at 03:00 ET.
  clock.set("2026-12-02T23:00:00.000Z");
  const rejected = events.append({ type: "investor_events.rejected", loanId: bl!.id, actor: { kind: "external", id: "fnma" }, payload: { type: "EscrowSetup", attempt: 1, reason: "invalid category" } });
  svc.requeueInvestorEvent(rejected);
  assert.equal(events.ofType("investor_events.queued").length, 1);
  assert.equal(setup[0]!.status, "armed");
  assert.equal(timers.evaluate("2026-12-03T07:59:00.000Z").length, 0);
  const breaches = timers.evaluate("2026-12-03T08:01:00.000Z");
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0]!.severity, 2);
  assert.ok(breaches[0]!.escalateTo.includes("investor-reporting"));
  // The ack, when it finally lands, closes it late.
  events.append({ type: "investor_events.acked", loanId: bl!.id, actor: { kind: "external", id: "fnma" }, payload: { type: "EscrowSetup" } });
  assert.equal(setup[0]!.status, "satisfied_late");
});

test("1.1-T8: a money-field hard failure cannot be waived without an officer approval record", () => {
  const { svc, ext } = harness("2026-09-17T02:00:00.000Z");
  const loan = stagedLoan();
  ext.agree(loan);
  ext.tb.set(loan.transferor_loan_number, cents("245600.00"));  // trial balance disagrees → HF-003 (money field)
  const [bl] = svc.stage("B1", [loan]);
  svc.validate("B1");
  assert.equal(bl!.status, "exception");
  const byAgent = svc.proposeWaiver(bl!.id, "HF-003", AGENT, "looks like a rounding difference");
  assert.equal(byAgent.ok, false); if (!byAgent.ok) assert.equal(byAgent.code, "ROLE_DENIED");
  const byAnalyst = svc.proposeWaiver(bl!.id, "HF-003", ANALYST, "transferor confirmed by phone");
  assert.equal(byAnalyst.ok, false); if (!byAnalyst.ok) assert.equal(byAnalyst.code, "ROLE_DENIED");
  assert.equal(bl!.status, "exception");
  const byOfficer = svc.proposeWaiver(bl!.id, "HF-003", OFFICER, "transferor correction letter received", ["doc-123"]);
  assert.equal(byOfficer.ok, true);
  if (byOfficer.ok) { assert.equal(byOfficer.decision.approved_by, "u-officer"); assert.equal(byOfficer.decision.approved_role, "officer"); assert.deepEqual(byOfficer.decision.evidence_document_ids, ["doc-123"]); }
  assert.equal(bl!.status, "validated");
  assert.equal(svc.decisionsFor(bl!.id).length, 1);
});

test("1.1-T9: a property in a state without a Supermortgage servicer license fails HF-020 and shows on the T-14 batch report", () => {
  const { svc, ext, clock } = harness("2026-09-17T02:00:00.000Z");      // T-14 for an Oct 1 transfer
  const loan = stagedLoan({ property: { address_line1: "1 Elm", city: "Burlington", state: "VT", postal_code: "05401", occupancy: "owner_occupied" } });
  ext.agree(loan);
  svc.ingestTape("B1", "preliminary", "prelim-tape", 1);
  svc.stage("B1", [loan]);
  const card = svc.validate("B1");
  assert.equal(card.hard["HF-020"], 1);
  assert.equal(card.generated_at, clock.now());
  assert.equal(card.loans.exception, 1);
});

test("1.1-T10: a duplicate file upload (same hash) is ignored with an idempotent receipt", () => {
  const { svc, events } = harness("2026-09-17T02:00:00.000Z");
  const bytes = new TextEncoder().encode("LOAN,UPB\nTR-1,24563412\n");
  const first = svc.ingestTape("B1", "preliminary", bytes, 1);
  const second = svc.ingestTape("B1", "preliminary", bytes, 1);
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "duplicate");
  assert.equal(second.tape_id, first.tape_id);
  assert.equal(second.sha256, first.sha256);
  assert.equal(events.ofType("transfer.tape.received").length, 1);
});

test("boarding posts balanced 1.6 opening entries against transfer-in clearing", () => {
  const { svc, ext, ledger, clock } = harness("2026-10-01T14:00:00.000Z");
  // 1.6 worked example L1: UPB 24,563,412; escrow +184,250; unapplied 32,500; corporate advances 15,000; late charges 6,464
  const l1 = stagedLoan({ upb_cents: 24_563_412n, escrow_balance_cents: 184_250n, unapplied_cents: 32_500n, corporate_advances_cents: 15_000n, late_charges_due_cents: 6_464n });
  // L2: UPB 18,020,000; escrow −41,300 (transferor advanced taxes) → escrow_advances receivable
  const l2 = stagedLoan({ seq: 2, upb_cents: 18_020_000n, escrow_balance_cents: -41_300n });
  ext.agree(l1); ext.agree(l2);
  const [b1, b2] = svc.stage("B1", [l1, l2]);
  svc.validate("B1");
  const r = svc.board("B1", { finalTapeReconciled: true });
  assert.equal(r.boarded.length, 2);
  const loan = (id: string, account: "principal" | "escrow" | "escrow_advance" | "suspense_unapplied" | "corporate_advance" | "late_charges") => ({ scope: "loan" as const, loanId: id, account });
  assert.equal(ledger.balance(loan(b1!.loan_id!, "principal")), 24_563_412n);
  assert.equal(ledger.balance(loan(b1!.loan_id!, "escrow")), -184_250n);           // liability
  assert.equal(ledger.balance(loan(b1!.loan_id!, "suspense_unapplied")), -32_500n);
  assert.equal(ledger.balance(loan(b1!.loan_id!, "corporate_advance")), 15_000n);
  assert.equal(ledger.balance(loan(b1!.loan_id!, "late_charges")), 6_464n);
  assert.equal(ledger.balance(loan(b2!.loan_id!, "escrow")), 0n);
  assert.equal(ledger.balance(loan(b2!.loan_id!, "escrow_advance")), 41_300n);      // receivable, not cash
  // Clearing carries the net of everything and every set balanced (the ledger would have thrown otherwise).
  const clearing = ledger.balance({ scope: "custodial", custodialAccountId: "CUST-CLEARING", account: "transfer_in_clearing" });
  assert.equal(clearing, -(24_563_412n + 15_000n + 6_464n - 184_250n - 32_500n) - (18_020_000n + 41_300n));
  assert.equal(ledger.sets().length, 2);
  assert.equal(ledger.sets()[0]!.effectiveDate, "2026-10-01");
  assert.equal(svc.scheduledInterest(b1!), 130_493n);                              // 1.6: 24,563,412 × 6.375% / 12 → 130,493
  void clock;
});

test("boarding is refused before the transfer date or without a reconciled final tape", () => {
  const { svc, ext, clock } = harness("2026-09-25T14:00:00.000Z");
  const loan = stagedLoan(); ext.agree(loan);
  svc.stage("B1", [loan]); svc.validate("B1");
  let r = svc.board("B1", { finalTapeReconciled: true });
  assert.equal(r.refused.length, 1); assert.match(r.refused[0]!.reason, /transfer date/);
  clock.set("2026-10-01T14:00:00.000Z");
  r = svc.board("B1", { finalTapeReconciled: false });
  assert.match(r.refused[0]!.reason, /final tape/);
  r = svc.board("B1", { finalTapeReconciled: true });
  assert.equal(r.boarded.length, 1);
  void SYSTEM;
});
