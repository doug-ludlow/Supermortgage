// 3.7 Tax disbursement
// spec/sections/03-escrow-administration/3-7-tax-disbursement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import { schedule, fundsCheck, installmentChoice, hazardDecision, ilTaxPaidNoticeDue, leadHonored, LEAD_DAYS } from "./disbursement.ts";
import { EscrowEventLedger, attestationSchedule, setupEventsAtCutover, nonEscrowDelinquency, replanAfterReject, BillDeduper, releaseApproval, cancellationOverlay, advanceEntries } from "./ops.ts";
import { escrowEventHistory, periodAggregate, type ReceiveBillResult } from "./ops-3-7.ts";
import { eventDeadlineMs } from "../investor/period.ts";
import { monthEnd } from "../investor/ops-5-1.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { eventMatches, parseEventPattern, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { escrowBus, ESCROW_AGENT, OFFICER_A, OFFICER_B, type EscrowBus } from "./spec-harness.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
const ET = "America/New_York";
const BILL = { amount_cents: cents("760"), due_on: D("2027-12-10"), received_on: D("2027-11-01"), discount: { pct: "2", by: D("2027-11-30") } };
const PORTAL: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
const SERVICER = "123456789";
/** The worked example's county tax bill as the tax-service feed delivers it (escrowed loan, borrower current). */
const taxBill = (over: Record<string, unknown> = {}) => ({ kind: "tax", payee: "Travis County", parcel_or_policy: "123-45-678", period: "2027", amount_cents: 76_000n, due_on: "2027-12-10", penalty_on: "2027-12-10", received_on: "2027-11-01", discount: { pct: "2", by: "2027-11-30" }, feed: "tax_service", escrowed: true, regx_days_delinquent: 0, ...over });
const timer = (bus: EscrowBus, code: string, n = 0) => { const t = bus.ctx.timers.byCode(code)[n]; assert.ok(t, `${code} not armed`); return t; };
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const at = (d: string, hhmm: string) => toIso(zonedEpochMs(D(d), hhmm, ET));
/** The Notice Registry on the bus's event store, so a `notice.sent{template}` is the registry's own fact. */
const wireNotices = (bus: EscrowBus): NoticeService => { const reg = buildRegistry(); publishAuthored(reg); const svc = new NoticeService({ registry: reg, events: bus.events, clock: bus.ctx.clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }); Object.assign(bus.rt, { notices: svc }); return svc; };
const RECIPIENT = [{ partyId: "B1", name: "Borrower One", mailingAddress: "1 Test St, Chicago IL 60601" }];

test("3.7-T1: Given the $760 bill due 2027-12-10 with 2% discount to 11/30 and balance $810 on 11/24, then release 2027-11-26, amount $744.80, `confirmed` by 12/02, and no penalty.", async () => {
  assert.deepEqual(LEAD_DAYS, { tax_service_bulk: 10, check: 7, ach: 3, vendor_epay: 2, wire: 1 });                                        // ESC_RELEASE_LEAD_<METHOD>
  const s = schedule(BILL, "tax_service_bulk", cents("810"), 0n);                                                                            // the worked example's method (lead 10 BD)
  assert.deepEqual([s.release_on, s.amount_cents, s.discount_captured, s.must_pay_by, s.lead_business_days], ["2027-11-26", 74_480n, true, "2027-12-10", 10]);   // 10 servicer BD before 12/10 (Thanksgiving 11/25 skipped)
  assert.equal(cents("760") - s.amount_cents, cents("15.20"));                     // the 2% discount
  assert.equal(s.discount_release_warn_on, "2027-11-15");                          // FNMA_B101_DISCOUNT_CAPTURE_WARN: discount_date − lead
  assert.equal(leadHonored(s.release_on, s.must_pay_by, "tax_service_bulk"), true);
  assert.equal(schedule(BILL, "check", cents("810"), 0n).release_on, "2027-11-30");                                                         // 7 BD before 12/10 is 12/01 → pulled to the discount date to capture it
  assert.equal(schedule(BILL, "check", cents("500"), 0n).release_on, "2027-12-01");                                                         // no capture (would need an advance) → must-pay − 7 BD
  // Through the bus: the projected installment arms the expected-bill clock; the bill's arrival closes it and arms the two penalty deadlines (12/10) and the discount warning (11/30 − 10 BD).
  const bus = escrowBus("L-1", "2027-11-01T15:00:00.000Z", ["3.7"]);
  const line = (await bus.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { op: "project", line: { line_type: "county_tax", projected_due_on: "2027-12-10", projected_amount_cents: 76_000n, source: "analysis" } })) as { expected_bill_by: string };
  assert.equal(line.expected_bill_by, "2027-11-10"); assert.equal(timer(bus, "ESC_EXPECTED_BILL_MISSING_30").dueDate, "2027-11-10");
  const r = (await bus.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { bill: taxBill(), method: "tax_service_bulk", escrow_balance_cents: 81_000n })) as ReceiveBillResult;
  assert.equal(r.blocked, false); assert.deepEqual([r.schedule!.release_on, r.schedule!.amount_cents, r.schedule!.discount_captured, r.schedule!.must_pay_by], ["2027-11-26", 74_480n, true, "2027-12-10"]);
  assert.equal(timer(bus, "ESC_EXPECTED_BILL_MISSING_30").status, "satisfied");
  const bill = bus.events.ofType("escrow.bill.received")[0]!; assert.deepEqual([p(bill).penalty_date, p(bill).discount_date, p(bill).escrowed, p(bill).regx_days_delinquent], ["2027-12-10", "2027-11-30", true, 0]);
  assert.equal(timer(bus, "REGX_1024_17K_DISBURSE_BEFORE_PENALTY_0").dueDate, "2027-12-10"); assert.equal(timer(bus, "FNMA_B101_DISBURSE_BEFORE_PENALTY_0").dueDate, "2027-12-10"); assert.equal(timer(bus, "FNMA_B101_DISCOUNT_CAPTURE_WARN").dueDate, "2027-11-15");
  // Release 11/26 with the discount captured: `escrow.disbursement.released{discount_captured=true}` closes the warning, `disbursement.sent{lead_honored=true}` the penalty rows.
  const rel = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { kind: "tax", disbursement_id: r.disbursement_id, amount_cents: 74_480n, escrow_balance_cents: 81_000n, method: "tax_service_bulk", release_on: "2027-11-26", must_pay_by: "2027-12-10", discount_captured: true })) as { advance_cents: bigint; lead_honored: boolean };
  assert.deepEqual([rel.advance_cents, rel.lead_honored], [0n, true]);
  assert.deepEqual(["FNMA_B101_DISCOUNT_CAPTURE_WARN", "REGX_1024_17K_DISBURSE_BEFORE_PENALTY_0", "FNMA_B101_DISBURSE_BEFORE_PENALTY_0"].map((c) => timer(bus, c).status), ["satisfied", "satisfied", "satisfied"]);
  // Vendor confirmation 12/02 → `confirmed`, on time; nothing breaches through the penalty date — no penalty.
  const c = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "confirm", disbursement_id: r.disbursement_id, on: "2027-12-02", external_ref: "TS-CONF-20271202-1" })) as { status: string; payload: Record<string, unknown> };
  assert.deepEqual([c.status, c.payload.paid_on, c.payload.on_time, c.payload.amount_cents], ["confirmed", "2027-12-02", true, "74480"]);
  assert.ok(D("2027-12-02") <= r.schedule!.must_pay_by); assert.deepEqual(bus.ctx.timers.evaluate(at("2027-12-11", "12:00")), []);
});
test("3.7-T2: Given balance $500 on the funds check, then advance $260, disbursement $760 released on time, loan escrow −$260, event balance −260.00 accepted (T&I negative allowed).", async () => {
  assert.deepEqual(fundsCheck(cents("760"), cents("500"), 0n), { release: true, advance_cents: 26_000n, escrow_after_cents: -26_000n });
  assert.deepEqual(advanceEntries(76_000n, 26_000n), [{ dr: "custodial_ti_cash", cr: "servicer_advance_receivable", amount_cents: 26_000n }, { dr: "loan.escrow", cr: "custodial_ti_cash", amount_cents: 76_000n }]);
  const led = new EscrowEventLedger(50_000n); const e = led.emit("County Tax", -76_000n, D("2027-11-26")); e.status = "accepted";
  assert.equal(e.balance_cents, -26_000n);                                          // T&I negative allowed
  // Through the bus: the bill (escrowed, current) arms both penalty rows on the penalty date; the release never waits for funds.
  const bus = escrowBus("L-1", "2027-11-26T12:00:00.000Z", ["3.7"]);
  const r = (await bus.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { bill: taxBill(), method: "tax_service_bulk", escrow_balance_cents: 50_000n })) as ReceiveBillResult;
  assert.deepEqual([r.schedule!.discount_captured, r.schedule!.amount_cents, r.schedule!.discount_lost_reason], [false, 76_000n, "insufficient funds to capture without advance"]);   // never advance for a discount
  const before = (code: string) => timer(bus, code); assert.equal(before("REGX_1024_17K_DISBURSE_BEFORE_PENALTY_0").dueDate, "2027-12-10"); assert.equal(before("FNMA_B101_DISBURSE_BEFORE_PENALTY_0").status, "armed");
  // A release that misses the method lead (check, 7 BD, released 12/06) or has no must-pay date is `disbursement.sent` but satisfies neither penalty row.
  await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { kind: "tax", amount_cents: 76_000n, escrow_balance_cents: 50_000n, method: "check", release_on: "2027-12-06", must_pay_by: "2027-12-10" });
  await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { kind: "tax", amount_cents: 76_000n, escrow_balance_cents: 50_000n, method: "wire" });
  assert.deepEqual(bus.events.ofType("disbursement.sent").map((e) => e.payload.lead_honored), [false, null]); assert.equal(before("REGX_1024_17K_DISBURSE_BEFORE_PENALTY_0").status, "armed"); assert.equal(before("FNMA_B101_DISBURSE_BEFORE_PENALTY_0").status, "armed");
  const out = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { kind: "tax", disbursement_id: r.disbursement_id, amount_cents: 76_000n, escrow_balance_cents: 50_000n, reserved_within_5bd_cents: 0n, method: "tax_service_bulk", release_on: "2027-11-26", must_pay_by: "2027-12-10" })) as { advance_cents: bigint; lead_honored: boolean | null };
  assert.equal(out.advance_cents, 26_000n); assert.equal(out.lead_honored, true);
  const sent = bus.events.ofType("disbursement.sent"); assert.equal(sent.length, 3); assert.deepEqual([sent[2]!.payload.method, sent[2]!.payload.lead_honored, sent[2]!.payload.lead_business_days], ["tax_service_bulk", true, 10]);
  assert.equal(before("REGX_1024_17K_DISBURSE_BEFORE_PENALTY_0").status, "satisfied"); assert.equal(before("FNMA_B101_DISBURSE_BEFORE_PENALTY_0").status, "satisfied");   // lead honored → both rows
  // The ledger set (advance first, then the disbursement) and its escrow event: −760.00, balance −260.00, accepted (T&I may be negative).
  const ev = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "post", direction: "disbursement", item: "tax", amount_cents: 76_000n, advance_cents: 26_000n, opening_balance_cents: 50_000n, disbursement_id: r.disbursement_id })) as { sequence: number; amount_cents: bigint; balance_cents: bigint; processed_on: string; deadline_at: string };
  assert.deepEqual([ev.sequence, ev.amount_cents, ev.balance_cents, ev.processed_on, ev.deadline_at], [1, -76_000n, -26_000n, "2027-11-26", at("2027-11-29", "03:00")]);   // Fri → Mon 03:00 ET
  const posted = bus.events.ofType("ledger.entries.posted")[0]!;
  assert.deepEqual((p(posted).lines as { account: string; amount_cents: string }[]).map((l) => [l.account, l.amount_cents]), [["custodial_ti_cash", "26000"], ["advance_receivable", "-26000"], ["escrow", "76000"], ["custodial_ti_cash", "-76000"]]);
  assert.equal(bus.ctx.ledger.balance({ scope: "loan", loanId: "L-1", account: "escrow" }), 76_000n);   // the loan's escrow is debited for the full bill (the $260 advance is funded on the custodial side, never netted against the loan)
  assert.equal(timer(bus, "FNMA_LL2026_05_ESCROW_EVENT_0300ET").dueAt, zonedEpochMs(D("2027-11-29"), "03:00", ET));
  const ack = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "ack", sequence: 1, status: "accepted", fnma_response_id: "FNMA-ACK-1" })) as { status: string };
  assert.equal(ack.status, "accepted"); assert.equal(timer(bus, "FNMA_LL2026_05_ESCROW_EVENT_0300ET").status, "satisfied");
  await assert.rejects(bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "post", direction: "disbursement", item: "loss_draft", category: "loss_draft", amount_cents: 1_000n, opening_balance_cents: 0n }), /loss_draft balance may not be negative/);   // LD/BD/Renovation never negative
});
test("3.7-T3: Given a jurisdiction with no annual discount and no installment fee, then the scheduler pays installments; given a 3% annual discount and sufficient funds, then it pays annually unless a borrower preference says installments.", () => {
  assert.equal(installmentChoice({ annual_discount_pct: null, installment_fee: false }, true), "installments");
  assert.equal(installmentChoice({ annual_discount_pct: "3", installment_fee: false }, true), "annual");
  assert.equal(installmentChoice({ annual_discount_pct: "3", installment_fee: false }, true, "installments"), "installments");
  assert.equal(installmentChoice({ annual_discount_pct: "3", installment_fee: false }, false), "installments");                 // funds not available → no annual (never advance for a discount)
  assert.equal(installmentChoice({ annual_discount_pct: "0.5", installment_fee: false }, true), "installments");                // below the 1% policy threshold
});
test("3.7-T4: Given a hazard renewal due 2027-10-01 for a borrower 45 days overdue with no cancellation notice and no vacancy, then the premium is paid/advanced and the LPI gate remains closed.", async () => {
  assert.deepEqual(hazardDecision(45, null, false), { pay: true, inability_to_disburse: false, lpi_gate_open: false });
  // LPI gate on the bus: force-placing instead of paying is refused without a documented (k)(5)(ii)(A) inability; an insurer cancellation for "underwriting" opens it.
  const bus = escrowBus("L-1", "2027-09-28T12:00:00.000Z", ["3.7"]); const hazard = { kind: "hazard", amount_cents: 254_880n, escrow_balance_cents: 0n, regx_days_delinquent: 45, force_place_instead: true };
  assert.equal((await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, hazard))?.code, "LPI_GATE");
  assert.equal((await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, { ...hazard, cancellation_reason: "non_payment" }))?.code, "LPI_GATE");   // non-payment is not inability
  assert.equal(await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, { ...hazard, cancellation_reason: "underwriting" }), null);
  assert.equal((await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, { kind: "tax", amount_cents: 76_000n, bill_amount_cents: 76_000n, escrow_balance_cents: 0n, skip: true }))?.code, "NEVER_SKIP_LIEN_PAYMENT");
  assert.equal((await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, { kind: "tax", amount_cents: 50_000n, bill_amount_cents: 76_000n, escrow_balance_cents: 50_000n }))?.code, "NEVER_SKIP_LIEN_PAYMENT");   // short-paying is skipping
  // The renewal is paid: the whole premium is advanced (balance 0) on the ACH lead, and the bill's penalty rows close on the send.
  const r = (await bus.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { bill: taxBill({ kind: "hazard", payee: "Acme Insurance", parcel_or_policy: "HO-778", period: "2027-10", amount_cents: 254_880n, due_on: "2027-10-01", penalty_on: "2027-10-01", received_on: "2027-09-01", discount: null, feed: "insurer", regx_days_delinquent: 45 }), method: "ach", escrow_balance_cents: 0n })) as ReceiveBillResult;
  assert.deepEqual([r.schedule!.release_on, r.schedule!.must_pay_by, r.schedule!.method], ["2027-09-28", "2027-10-01", "ach"]);
  assert.equal(bus.ctx.timers.byCode("REGX_1024_17K_DISBURSE_BEFORE_PENALTY_0").length, 0);                                    // > 30 days overdue: Reg X (k)(1) no longer requires it …
  assert.equal(timer(bus, "FNMA_B101_DISBURSE_BEFORE_PENALTY_0").dueDate, "2027-10-01");                                          // … B-1-01 does regardless of delinquency
  const out = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { ...hazard, force_place_instead: false, disbursement_id: r.disbursement_id, method: "ach", release_on: "2027-09-28", must_pay_by: "2027-10-01" })) as { advance_cents: bigint; lead_honored: boolean };
  assert.deepEqual([out.advance_cents, out.lead_honored], [254_880n, true]); assert.equal(timer(bus, "FNMA_B101_DISBURSE_BEFORE_PENALTY_0").status, "satisfied");
});
test('3.7-T5: Given an insurer cancellation notice citing "underwriting" received 2027-09-15, then `inability_to_disburse=true` with the (k)(5)(ii)(A) reason recorded and the LPI gate opens for Section 9.2.', async () => {
  const o = cancellationOverlay("underwriting", D("2027-09-15"));
  assert.deepEqual(o, { inability_to_disburse: true, reason_code: "1024.17(k)(5)(ii)(A):underwriting", lpi_gate_open: true, recorded_on: "2027-09-15" });
  assert.equal(cancellationOverlay("non_payment", D("2027-09-15")).lpi_gate_open, false);
  // Through the bus: the Section 9 cancellation notice is evaluated and the (k)(5) record written on the loan for 9.2's gate.
  const bus = escrowBus("L-1", "2027-09-15T15:00:00.000Z", ["3.7"]);
  const r = (await bus.run("3.7", "postAdvance", ESCROW_AGENT, { op: "hazard_inability", notice: "insurance.policy.cancellation_notice", reason: "underwriting", received_on: "2027-09-15", regx_days_delinquent: 45 })) as { inability_to_disburse: boolean; reason_code: string; lpi_gate_open: boolean; recorded_on: string; pay_or_advance: boolean };
  assert.deepEqual([r.inability_to_disburse, r.reason_code, r.lpi_gate_open, r.recorded_on, r.pay_or_advance], [true, "1024.17(k)(5)(ii)(A):underwriting", true, "2027-09-15", false]);
  const rec = bus.events.ofType("escrow.hazard.inability_evaluated")[0]!; assert.deepEqual([p(rec).inability_to_disburse, p(rec).reason_code, p(rec).lpi_gate_open], [true, "1024.17(k)(5)(ii)(A):underwriting", true]);
  const np = (await bus.run("3.7", "postAdvance", ESCROW_AGENT, { op: "hazard_inability", notice: "insurance.policy.cancellation_notice", reason: "non_payment", received_on: "2027-09-15", regx_days_delinquent: 45 })) as { inability_to_disburse: boolean; lpi_gate_open: boolean; pay_or_advance: boolean };
  assert.deepEqual([np.inability_to_disburse, np.lpi_gate_open, np.pay_or_advance], [false, false, true]);                       // (k)(5)(ii)(B): non-payment / insufficient funds is never inability
  assert.equal(await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, { kind: "hazard", amount_cents: 254_880n, escrow_balance_cents: 0n, regx_days_delinquent: 45, force_place_instead: true, cancellation_reason: "underwriting" }), null);   // the gate is open for 9.2
});
test("3.7-T6: Given a deposit processed Thursday 2027-07-15 at 18:00 ET, then the event deadline is Friday 2027-07-16 03:00 ET; processed Friday 2027-07-16 → deadline Monday 2027-07-19 03:00 ET; processed Friday before a Fannie Mae Monday holiday → Tuesday 03:00 ET.", async () => {
  assert.equal(toIso(eventDeadlineMs(zonedEpochMs(D("2027-07-15"), "18:00", ET))), at("2027-07-16", "03:00"));
  assert.equal(toIso(eventDeadlineMs(zonedEpochMs(D("2027-07-16"), "10:00", ET))), at("2027-07-19", "03:00"));
  assert.equal(toIso(eventDeadlineMs(zonedEpochMs(D("2027-09-03"), "10:00", ET))), at("2027-09-07", "03:00"));   // Friday before Labor Day → Tuesday
  // Through the bus: each deposit's ledger set arms FNMA_LL2026_05_ESCROW_EVENT_0300ET on its processed date; the queued event carries the same deadline.
  const bus = escrowBus("L-1", "2027-07-15T22:00:00.000Z", ["3.7"]);
  const cases: [string, string, string, string][] = [["L-1", "2027-07-15", "18:00", "2027-07-16"], ["L-2", "2027-07-16", "10:00", "2027-07-19"], ["L-3", "2027-09-03", "10:00", "2027-09-07"]];
  for (const [loan, day, hhmm, due] of cases) {
    const r = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "post", loan_id: loan, direction: "deposit", item: "contractual_payment", amount_cents: 17_222n, contractual_payment_cents: 17_222n, opening_balance_cents: 70_000n, processed_at: at(day, hhmm) })) as { deadline_at: string; processed_on: string; balance_cents: bigint };
    assert.deepEqual([r.processed_on, r.deadline_at, r.balance_cents], [day, at(due, "03:00"), 87_222n]);                        // deposit example: +172.22 → 872.22
    const t = bus.ctx.timers.byCode("FNMA_LL2026_05_ESCROW_EVENT_0300ET").find((x) => x.loanId === loan)!; assert.deepEqual([t.dueDate, t.dueAt], [due, zonedEpochMs(D(due), "03:00", ET)]);
  }
  const q = bus.events.ofType("escrow.event.queued")[0]!; assert.deepEqual([p(q).item_type, p(q).amount_cents, p(q).contractual_payment_cents, p(q).sequence], ["Loan Escrow Payment", "17222", "17222", 1]);
});
test('3.7-T7: Given a rejected event "balance mismatch," then a corrected event is generated with the same sequence position and accepted before the period close; the rejected event shows `corrected`.', async () => {
  const led = new EscrowEventLedger(81_000n); const e = led.emit("County Tax", -74_480n, D("2027-11-26")); e.status = "rejected";
  const fixed = led.correct(e.sequence, { balance_cents: 6_520n }, D("2027-11-27"));
  assert.equal(fixed.sequence, e.sequence); assert.equal(e.status, "corrected"); assert.equal(fixed.status, "queued"); assert.equal(fixed.balance_cents, 6_520n);
  // Through the bus: the outbox event, the Fannie Mae rejection, the correction at the same sequence, its acceptance before BD2 17:00 ET.
  const bus = escrowBus("L-1", "2027-11-26T17:00:00.000Z", ["3.7"]);
  const posted = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "post", direction: "disbursement", item: "tax", amount_cents: 74_480n, opening_balance_cents: 81_000n })) as { sequence: number; balance_cents: bigint; period_key: string };
  assert.deepEqual([posted.sequence, posted.balance_cents, posted.period_key], [1, 6_520n, "2027-11"]);
  await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "ack", sequence: 1, status: "rejected", message: "balance mismatch", acked_at: at("2027-11-27", "09:00") });
  assert.equal(timer(bus, "FNMA_LL2026_05_ESCROW_EVENT_0300ET").status, "armed");
  const fix = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "correct", sequence: 1, fix: { balance_cents: 6_520n }, processed_at: at("2027-11-27", "10:00") })) as { rejected_event_id: string; corrected_event_id: string; balance_cents: bigint };
  const hist = escrowEventHistory(bus.events, "L-1", 1);
  assert.deepEqual(hist.map((h) => [h.event_id, h.status, h.corrects]), [[fix.rejected_event_id, "corrected", null], [fix.corrected_event_id, "queued", fix.rejected_event_id]]);   // same sequence position; the rejected one shows `corrected`
  await assert.rejects(bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "correct", sequence: 1, fix: { balance_cents: 1n } }), /not rejected/);   // only a rejected event is corrected
  await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "ack", sequence: 1, status: "accepted", acked_at: at("2027-11-29", "02:00") });
  assert.deepEqual(escrowEventHistory(bus.events, "L-1", 1).map((h) => h.status), ["corrected", "accepted"]); assert.equal(timer(bus, "FNMA_LL2026_05_ESCROW_EVENT_0300ET").status, "satisfied");
  const close = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "period_close", servicer_number: SERVICER, period_key: "2027-11", closed_at: at("2027-12-02", "17:00") })) as { all_accepted: boolean; pending: string[]; close_at: string; late: boolean };
  assert.deepEqual([close.all_accepted, close.pending, close.close_at, close.late], [true, [], at("2027-12-02", "17:00"), false]);   // accepted before the BD2 17:00 ET close (Dec 2 is BD2)
});
test("3.7-T8: Given the March 2027 period, then the attestation package is ready on BD3 (April) and the `human_portal_task` SLA is BD2 of May; a mismatch of one loan produces `attested_no_with_commentary` and a variance case.", async () => {
  const a = attestationSchedule(D("2027-03-01"), { ledger_loans: 5000, fnma_loans: 4999 });
  assert.deepEqual([a.package_ready_on, a.portal_task_sla_on, a.outcome, a.variance_case], ["2027-04-05", "2027-05-04", "attested_no_with_commentary", true]);
  assert.equal(attestationSchedule(D("2027-03-01"), { ledger_loans: 5000, fnma_loans: 5000 }).outcome, "attested_yes");
  // Through the bus: month end arms the BD2 17:00 ET close (Apr 2); the BD3 package (Apr 5) arms the attestation SLA (May 4, BD2 of the following month).
  const bus = escrowBus("L-1", "2027-04-05T13:00:00.000Z", ["3.7"]);
  monthEnd(bus.events, { month_of: D("2027-03-01"), servicer_number: SERVICER, now_ms: Date.parse(at("2027-03-31", "23:30")) });
  const close = timer(bus, "FNMA_LL2026_05_ESCROW_PERIOD_CLOSE_BD2_1700ET"); assert.deepEqual([close.dueDate, close.dueAt, close.subject], ["2027-04-02", zonedEpochMs(D("2027-04-02"), "17:00", ET), periodAggregate(SERVICER, "2027-03")]);
  const closed = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "period_close", servicer_number: SERVICER, period_key: "2027-03", closed_at: at("2027-04-02", "16:00") })) as { all_accepted: boolean; late: boolean };
  assert.deepEqual([closed.all_accepted, closed.late], [true, false]); assert.equal(timer(bus, "FNMA_LL2026_05_ESCROW_PERIOD_CLOSE_BD2_1700ET").status, "satisfied");
  const cat = (loans: number) => ({ category: "taxes_insurance", ledger: { loan_count: 5000, ending_balance_cents: 405_000_000n, aggregate_contractual_payment_cents: 86_110_000n }, fnma: { loan_count: loans, ending_balance_cents: 405_000_000n, aggregate_contractual_payment_cents: 86_110_000n } });
  const pkg = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "attestation_package", servicer_number: SERVICER, period_key: "2027-03", categories: [cat(4999)] })) as { package_ready_on: string; sla_on: string; variance: boolean; variances: string[]; owner_role: string };
  assert.deepEqual([pkg.package_ready_on, pkg.sla_on, pkg.variance, pkg.variances, pkg.owner_role], ["2027-04-05", "2027-05-04", true, ["taxes_insurance: loan count ledger 5000 vs Fannie Mae 4999"], "fnma_portal_operator"]);
  assert.equal(bus.rt.escalations.opened.filter((e) => e.kind === "human_portal_task" && e.payload.task === "escrow_attestation").length, 1);
  const sla = timer(bus, "FNMA_LL2026_05_ESCROW_ATTEST_BD2"); assert.deepEqual([sla.dueDate, sla.status], ["2027-05-04", "armed"]);
  // The attestation is a human UI act: the agent is refused; "No" needs commentary; the mismatch attests No with commentary and opens the variance case.
  assert.equal((await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "attestation_submitted", servicer_number: SERVICER, period_key: "2027-03", evidence_document_id: "doc-att-1", commentary: "one loan" }))?.code, "ATTESTATION_IS_HUMAN");
  await assert.rejects(bus.run("3.7", "releaseDisbursement", PORTAL, { op: "attestation_submitted", servicer_number: SERVICER, period_key: "2027-03", evidence_document_id: "doc-att-1" }), /attest No with commentary/);
  const sub = (await bus.run("3.7", "releaseDisbursement", PORTAL, { op: "attestation_submitted", servicer_number: SERVICER, period_key: "2027-03", evidence_document_id: "doc-att-1", commentary: "loan 4471 boarded 3/31 after the Fannie Mae snapshot", submitted_at: at("2027-04-20", "10:00") })) as { outcome: string; variance_case_id: string | null; on_time: boolean };
  assert.deepEqual([sub.outcome, sub.variance_case_id, sub.on_time], ["attested_no_with_commentary", `VAR-${SERVICER}-2027-03`, true]);
  assert.equal(timer(bus, "FNMA_LL2026_05_ESCROW_ATTEST_BD2").status, "satisfied"); assert.equal(bus.events.ofType("case.opened").filter((e) => p(e).kind === "escrow_attestation_variance").length, 1);
  // A reconciled package attests Yes without a case.
  await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "attestation_package", servicer_number: SERVICER, period_key: "2027-04", categories: [cat(5000)] });
  const yes = (await bus.run("3.7", "releaseDisbursement", PORTAL, { op: "attestation_submitted", servicer_number: SERVICER, period_key: "2027-04", evidence_document_id: "doc-att-2" })) as { outcome: string; variance_case_id: string | null };
  assert.deepEqual([yes.outcome, yes.variance_case_id], ["attested_yes", null]);
});
test("3.7-T9: Given cutover on 2026-11-16, then Setup events exist for every active and inactive escrowed loan per category before the first deposit event and 100% accepted by 2026-12-01.", async () => {
  const loans = [{ loan_id: "L-1", escrowed: true, active: true, categories: [{ category: "tax", balance_cents: 81_000n }, { category: "hazard", balance_cents: 40_000n }], first_deposit: { amount_cents: 13_833n, on: D("2026-12-01") } }, { loan_id: "L-2", escrowed: true, active: false, categories: [{ category: "tax", balance_cents: -26_000n }] }, { loan_id: "L-3", escrowed: false, active: true, categories: [] }];
  const acks = [{ loan_id: "L-1", category: "tax", status: "accepted" as const, accepted_on: D("2026-11-17") }, { loan_id: "L-1", category: "hazard", status: "accepted_warning" as const, accepted_on: D("2026-11-17") }, { loan_id: "L-2", category: "tax", status: "accepted" as const, accepted_on: D("2026-11-18") }];
  const r = setupEventsAtCutover(loans, D("2026-11-16"), acks);
  assert.equal(r.events.length, 3); assert.ok(r.events.every((e) => e.type === "EscrowSetup" && e.sequence === 1 && e.before_first_deposit)); assert.equal(r.events[0]!.deadline_at, "2026-11-17");   // sequence 1 in each (loan, category) ledger; next fannie_et BD 03:00 ET
  assert.deepEqual([r.accept_by, r.cutover_on_time, r.accepted_pct, r.all_accepted_by_deadline, r.covers_inactive, r.missing], ["2026-12-01", true, 100, true, true, []]);
  assert.equal(r.events.find((e) => e.loan_id === "L-2")!.balance_cents, -26_000n);                                                                   // inactive escrowed loan, negative T&I balance allowed
  // Acceptance and ordering are computed, not echoed: a missing ack drops the percentage; a deposit processed before the cutover precedes the Setup in the ledger.
  const partial = setupEventsAtCutover(loans, D("2026-11-16"), acks.slice(0, 2)); assert.deepEqual([partial.accepted_pct, partial.all_accepted_by_deadline, partial.missing], [66.67, false, ["L-2:tax"]]);
  const late = setupEventsAtCutover(loans, D("2026-11-16"), [...acks.slice(0, 2), { loan_id: "L-2", category: "tax", status: "accepted", accepted_on: D("2026-12-02") }]); assert.equal(late.all_accepted_by_deadline, false);
  const early = setupEventsAtCutover([{ ...loans[0]!, first_deposit: { amount_cents: 13_833n, on: D("2026-11-10") } }], D("2026-11-16"), acks); assert.ok(early.events.every((e) => !e.before_first_deposit && e.sequence === 2));
  assert.equal(setupEventsAtCutover(loans, D("2026-12-15"), acks).cutover_on_time, false);
  // Through the bus: the feature flag arms FNMA_LL2026_05_ESCROW_SETUP_CUTOVER on the configured cutover date; the Setup events go out per loan/category; only 100% accepted closes it.
  const bus = escrowBus("L-1", "2026-11-16T11:00:00.000Z", ["3.7"]);
  const cut = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "cutover", cutover_on: "2026-11-16", loans })) as { setups: DomainEvent[]; plan: { accept_by: string } };
  assert.deepEqual(cut.setups.map((e) => [e.loanId, p(e).category, p(e).sequence, p(e).balance_cents, p(e).before_first_deposit]), [["L-1", "tax", 1, "81000", true], ["L-1", "hazard", 1, "40000", true], ["L-2", "tax", 1, "-26000", true]]);
  assert.equal(cut.setups[0]!.payload.deadline_at, at("2026-11-17", "03:00"));
  const flag = bus.events.ofType("feature_flag.enabled")[0]!; assert.deepEqual([p(flag).flag, p(flag).cutover_on, p(flag).accept_by], ["investor_reporting.escrow_events", "2026-11-16", "2026-12-01"]);
  assert.deepEqual([timer(bus, "FNMA_LL2026_05_ESCROW_SETUP_CUTOVER").dueDate, timer(bus, "FNMA_LL2026_05_ESCROW_SETUP_CUTOVER").subject], ["2026-11-16", { kind: "global", id: "*" }]);
  const part = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "setup_acks", cutover_on: "2026-11-16", loans, acks: acks.slice(0, 2) })) as { plan: { accepted_pct: number } };
  assert.equal(part.plan.accepted_pct, 66.67); assert.equal(timer(bus, "FNMA_LL2026_05_ESCROW_SETUP_CUTOVER").status, "armed");
  const full = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "setup_acks", cutover_on: "2026-11-16", loans, acks, recorded_at: at("2026-11-18", "09:00") })) as { plan: { accepted_pct: number; all_accepted_by_deadline: boolean } };
  assert.deepEqual([full.plan.accepted_pct, full.plan.all_accepted_by_deadline], [100, true]); assert.equal(timer(bus, "FNMA_LL2026_05_ESCROW_SETUP_CUTOVER").status, "satisfied");
  assert.ok(eventMatches(parseEventPattern("`escrow.setup_events.accepted{pct=100}`")!, bus.events.ofType("escrow.setup_events.accepted")[1]!));
  await assert.rejects(bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "cutover", cutover_on: "2026-12-15", loans }), /after the LL-2026-05 mandate 2026-12-01/);
});
test("3.7-T10: Given an Illinois tax payment confirmed 2027-06-03, then `NTC_IL_765_910_15_TAX_PAID` is sent within 45 business days (by 2027-08-06 assuming no servicer holidays beyond federal).", async () => {
  // Spec discrepancy: the hand-count 2027-08-06 skips only one holiday; the servicer calendar excludes both Juneteenth (obs. Fri 2027-06-18) and
  // Independence Day (obs. Mon 2027-07-05), so 45 servicer business days after Thu 2027-06-03 is Mon 2027-08-09 (kept calendar-correct).
  const due = ilTaxPaidNoticeDue(D("2027-06-03"));
  assert.equal(due, "2027-08-09"); assert.ok(due >= D("2027-08-06"));
  assert.equal(ilTaxPaidNoticeDue(D("2027-01-04")), "2027-03-10");                // 45 BD over MLK (1/18) and Presidents' Day (2/15)
  // Through the bus: the confirmed IL tax payment arms the 45-BD row on the paid date; the registry's `notice.sent{template}` closes it.
  const bus = escrowBus("L-1", "2027-06-03T20:00:00.000Z", ["3.7"]); wireNotices(bus);
  const r = (await bus.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { bill: taxBill({ payee: "Cook County Treasurer", parcel_or_policy: "14-21-101-001", period: "2027-1", amount_cents: 74_480n, due_on: "2027-06-10", penalty_on: "2027-06-10", received_on: "2027-05-10", discount: null, state: "IL" }), method: "tax_service_bulk", escrow_balance_cents: 90_000n })) as ReceiveBillResult;
  await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { kind: "tax", disbursement_id: r.disbursement_id, amount_cents: 74_480n, escrow_balance_cents: 90_000n, method: "tax_service_bulk", release_on: "2027-05-26", must_pay_by: "2027-06-10" });
  const c = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "confirm", disbursement_id: r.disbursement_id, on: "2027-06-03", external_ref: "TS-CONF-IL-1", property_address: "1 Test St, Chicago IL 60601" })) as { il_notice_due_on: string; payload: Record<string, unknown> };
  assert.deepEqual([c.il_notice_due_on, c.payload.state, c.payload.kind, c.payload.paid_on], ["2027-08-09", "IL", "tax", "2027-06-03"]);
  const t = timer(bus, "STATE_IL_765ILCS910_15_TAX_PAID_NOTICE_45BD"); assert.deepEqual([t.anchorDate, t.dueDate, t.status], ["2027-06-03", "2027-08-09", "armed"]);
  assert.equal((await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "notify", template_code: "NTC_IL_765_910_15_TAX_PAID", recipients: RECIPIENT, payload: { paid_on: "2027-06-01" } }))?.code, "NOTICE_FACTS_FROM_LOAN");   // the facts come from the loan's confirmed payment
  const n = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "notify", template_code: "NTC_IL_765_910_15_TAX_PAID", recipients: RECIPIENT, payload: { servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" } })) as { status: string; payload: Record<string, unknown>; templateCode: string };
  assert.deepEqual([n.status, n.templateCode, n.payload.paid_on, n.payload.amount_cents, n.payload.parcel, n.payload.business_days_after_payment], ["sent", "NTC_IL_765_910_15_TAX_PAID", "2027-06-03", 74_480n, "14-21-101-001", 0]);
  const sent = bus.events.ofType("notice.sent")[0]!; assert.equal(p(sent).template, "NTC_IL_765_910_15_TAX_PAID"); assert.equal(sent.loanId, "L-1");
  assert.equal(timer(bus, "STATE_IL_765ILCS910_15_TAX_PAID_NOTICE_45BD").status, "satisfied");
  // A non-Illinois or non-tax confirmation never arms the Illinois row.
  const tx = escrowBus("L-2", "2027-06-03T20:00:00.000Z", ["3.7"]);
  const r2 = (await tx.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { bill: taxBill({ state: "TX", due_on: "2027-06-10", penalty_on: "2027-06-10", received_on: "2027-05-10", discount: null }), method: "tax_service_bulk", escrow_balance_cents: 90_000n })) as ReceiveBillResult;
  await tx.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "confirm", disbursement_id: r2.disbursement_id, on: "2027-06-03", external_ref: "TS-CONF-TX-1" });
  assert.equal(tx.ctx.timers.byCode("STATE_IL_765ILCS910_15_TAX_PAID_NOTICE_45BD").length, 0);
});
test("3.7-T11: Given a non-escrowed loan flagged delinquent by the tax service, then a borrower notice is sent, follow-up in 30 days, and if unpaid with a tax sale scheduled, an advance is posted and the waiver revocation (3.8) is triggered.", async () => {
  const r = nonEscrowDelinquency({ found_on: D("2027-10-01"), paid_by_followup: false, tax_sale_scheduled: true });
  assert.deepEqual(r, { notice: "NTC_SM_NONESCROW_TAX_DELINQUENCY", follow_up_on: "2027-10-31", action: "advance_and_revoke_waiver" });
  assert.equal(nonEscrowDelinquency({ found_on: D("2027-10-01"), paid_by_followup: true, tax_sale_scheduled: false }).action, "closed");
  // Through the bus: the tax service report opens the case and the 30-day clock (found_on + 30); the borrower notice goes through the registry.
  const bus = escrowBus("L-1", "2027-10-01T15:00:00.000Z", ["3.7"]); wireNotices(bus);
  const flagged = (await bus.run("3.7", "postAdvance", ESCROW_AGENT, { op: "nonescrow_tax_delinquent", escrowed: false, parcel: "123-45-678", delinquent_cents: 76_000n, found_on: "2027-10-01", tax_sale_date: "2027-12-15", source: "tax_service_delinquency_search" })) as { case_id: string; plan: { follow_up_on: string; action: string; notice: string } };
  assert.deepEqual([flagged.plan.follow_up_on, flagged.plan.action, flagged.plan.notice], ["2027-10-31", "advance_and_revoke_waiver", "NTC_SM_NONESCROW_TAX_DELINQUENCY"]);
  assert.deepEqual([timer(bus, "ESC_NONESCROW_TAX_DELINQ_FOLLOWUP_30").anchorDate, timer(bus, "ESC_NONESCROW_TAX_DELINQ_FOLLOWUP_30").dueDate], ["2027-10-01", "2027-10-31"]);
  await assert.rejects(bus.run("3.7", "postAdvance", ESCROW_AGENT, { op: "nonescrow_tax_delinquent", escrowed: true, parcel: "1", delinquent_cents: 1n, found_on: "2027-10-01", source: "x" }), /without an escrow account/);
  const n = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "notify", template_code: "NTC_SM_NONESCROW_TAX_DELINQUENCY", recipients: RECIPIENT, payload: { servicer_phone: "(800) 555-0100", exclusive_address: "PO Box 2, Testville TX 75001" } })) as { status: string; payload: Record<string, unknown> };
  assert.deepEqual([n.status, n.payload.delinquent_cents, n.payload.follow_up_on], ["sent", 76_000n, "2027-10-31"]);
  // Unpaid at follow-up with the tax sale scheduled: a bare "resolved" is refused; the advance on the waived loan revokes the waiver (3.8) and that fact closes the clock.
  await assert.rejects(bus.run("3.7", "postAdvance", ESCROW_AGENT, { op: "resolve", resolved_on: "2027-10-31" }), /cannot resolve: neither borrower proof of payment/);
  const adv = (await bus.run("3.7", "postAdvance", ESCROW_AGENT, { amount_cents: 76_000n, advance_cents: 76_000n, waived: true, item: "tax", advanced_on: "2027-10-31", cause: "nonescrow_tax_delinquency", penalty_cents: 3_800n })) as { revocation: { revoked_on: string; deficiency_cents: bigint } | null };
  assert.deepEqual([adv.revocation!.revoked_on, adv.revocation!.deficiency_cents], ["2027-10-31", 79_800n]);
  assert.deepEqual(bus.events.ofType("escrow.waiver.revoked").map((e) => p(e).reason), ["advance_for_unpaid_item"]);
  const res = (await bus.run("3.7", "postAdvance", ESCROW_AGENT, { op: "resolve", resolved_on: "2027-10-31" })) as { outcome: string; on_time: boolean };
  assert.deepEqual([res.outcome, res.on_time], ["advance_and_revocation", true]); assert.equal(timer(bus, "ESC_NONESCROW_TAX_DELINQ_FOLLOWUP_30").status, "satisfied");
  // Borrower proof of payment closes the same clock on another loan.
  const paid = escrowBus("L-2", "2027-10-01T15:00:00.000Z", ["3.7"]);
  await paid.run("3.7", "postAdvance", ESCROW_AGENT, { op: "nonescrow_tax_delinquent", escrowed: false, parcel: "9-9", delinquent_cents: 50_000n, found_on: "2027-10-01", source: "tax_sale_notice" });
  const pr = (await paid.run("3.7", "postAdvance", ESCROW_AGENT, { op: "resolve", resolved_on: "2027-10-20", proof_of_payment_document_id: "doc-receipt-1" })) as { outcome: string };
  assert.equal(pr.outcome, "proof_of_payment"); assert.equal(timer(paid, "ESC_NONESCROW_TAX_DELINQ_FOLLOWUP_30").status, "satisfied");
});
test("3.7-T12: Given a vendor reject on 2027-11-29 for wrong parcel, then re-planned by 2027-12-01 via ACH direct and paid before 12/10.", async () => {
  const r = replanAfterReject(D("2027-11-29"), D("2027-12-10"));
  assert.equal(r.replan_by, "2027-12-01"); assert.equal(r.method, "ach"); assert.ok(r.release_on < D("2027-12-10")); assert.equal(r.on_time, true);
  // Through the bus: the vendor reject arms ESC_PAYEE_REJECT_REPLAN_2BD (11/29 + 2 servicer BD = 12/01); the ACH re-plan closes it before the must-pay date.
  const bus = escrowBus("L-1", "2027-11-29T15:00:00.000Z", ["3.7"]);
  const sch = (await bus.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { bill: taxBill(), method: "tax_service_bulk", escrow_balance_cents: 90_000n })) as ReceiveBillResult;
  await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { kind: "tax", disbursement_id: sch.disbursement_id, amount_cents: 74_480n, escrow_balance_cents: 90_000n, method: "tax_service_bulk", release_on: "2027-11-26", must_pay_by: "2027-12-10", discount_captured: true });
  const rej = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "reject", disbursement_id: sch.disbursement_id, on: "2027-11-29", reason: "wrong parcel", external_ref: "TS-REJ-1" })) as { status: string; replan: { replan_by: string; method: string; release_on: string; on_time: boolean } };
  assert.deepEqual([rej.status, rej.replan.replan_by, rej.replan.method, rej.replan.on_time], ["rejected", "2027-12-01", "ach", true]);
  const t = timer(bus, "ESC_PAYEE_REJECT_REPLAN_2BD"); assert.deepEqual([t.anchorDate, t.dueDate, t.status], ["2027-11-29", "2027-12-01", "armed"]);
  // A fresh schedule of a different bill is `disbursement.scheduled` too, but not the re-plan.
  await bus.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { bill: taxBill({ kind: "hazard", payee: "Acme Insurance", parcel_or_policy: "HO-1", period: "2027-12", amount_cents: 100_000n, discount: null }), method: "ach", escrow_balance_cents: 90_000n });
  assert.equal(timer(bus, "ESC_PAYEE_REJECT_REPLAN_2BD").status, "armed");
  const re = (await bus.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { op: "replan", disbursement_id: sch.disbursement_id, replanned_on: "2027-11-30" })) as { plan: { replan_by: string; release_on: string; method: string }; event: DomainEvent };
  assert.deepEqual([re.plan.replan_by, re.plan.method, p(re.event).replanned, p(re.event).method, p(re.event).on_time], ["2027-12-01", "ach", true, "ach", true]); assert.ok(re.plan.release_on < D("2027-12-10"));
  assert.equal(timer(bus, "ESC_PAYEE_REJECT_REPLAN_2BD").status, "satisfied");
  // "`disbursement.rejected/returned`": a returned check arms the same code explicitly (one code, two triggers) and the reissue re-measures the lead.
  await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "return", disbursement_id: sch.disbursement_id, on: "2027-12-01", reason: "undeliverable", external_ref: "BANK-RET-1" });
  assert.deepEqual([timer(bus, "ESC_PAYEE_REJECT_REPLAN_2BD", 1).anchorDate, timer(bus, "ESC_PAYEE_REJECT_REPLAN_2BD", 1).dueDate], ["2027-12-01", "2027-12-03"]);
  const ri = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "reissue", disbursement_id: sch.disbursement_id, reissued_on: "2027-12-02", method: "wire" })) as { lead_honored: boolean };
  assert.equal(ri.lead_honored, true); assert.deepEqual(bus.events.ofType("escrow.disbursement.reissued").length, 1);
});
test("3.7-T13: Given a duplicate bill from two feeds, then the second is blocked and an anomaly is logged.", async () => {
  const d = new BillDeduper(); const bill = { payee: "Travis County", parcel_or_policy: "123-45-678", period: "2027", amount_cents: 76_000n };
  assert.equal(d.accept(bill, "tax_service"), true); assert.equal(d.accept(bill, "county_portal"), false); assert.equal(d.anomalies.length, 1); assert.match(d.anomalies[0]!, /duplicate bill/);
  // Through the bus: the same (payee, parcel, period, amount) from a second feed is blocked — one `escrow.bill.received`, one anomaly, one set of timers.
  const bus = escrowBus("L-1", "2027-11-01T15:00:00.000Z", ["3.7"]);
  const first = (await bus.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { bill: taxBill(), method: "tax_service_bulk", escrow_balance_cents: 81_000n })) as ReceiveBillResult;
  const second = (await bus.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { bill: taxBill({ feed: "county_portal", bill_id: "portal-77" }), method: "tax_service_bulk", escrow_balance_cents: 81_000n })) as ReceiveBillResult;
  assert.deepEqual([first.blocked, second.blocked, second.disbursement_id, second.schedule], [false, true, null, null]); assert.match(second.anomaly!, /duplicate bill .* from county_portal \(first seen from tax_service\)/);
  assert.equal(bus.events.ofType("escrow.bill.received").length, 1); assert.equal(bus.events.ofType("escrow.bill.duplicate_blocked").length, 1); assert.equal(bus.events.ofType("disbursement.scheduled").length, 1);
  assert.equal(bus.ctx.timers.byCode("FNMA_B101_DISBURSE_BEFORE_PENALTY_0").length, 1);
  assert.equal((await bus.run("3.7", "scheduleDisbursement", ESCROW_AGENT, { bill: taxBill({ amount_cents: 76_100n, feed: "county_portal" }), method: "tax_service_bulk", escrow_balance_cents: 81_000n }) as ReceiveBillResult).blocked, false);   // a different amount is a corrected bill, not a duplicate
});
test("3.7-T14: Given a payee ACH instruction changed yesterday and a $12,000 disbursement, then `officer` dual approval is required before release.", async () => {
  const r = releaseApproval({ amount_cents: cents("12000"), payee_instruction_changed_on: D("2027-11-25"), release_on: D("2027-11-26"), new_payee: false });
  assert.deepEqual(r, { dual_approval_required: true, reason: "payee remittance instruction changed yesterday", payee_change: true });
  assert.equal(releaseApproval({ amount_cents: cents("900"), release_on: D("2027-11-26"), new_payee: false }).dual_approval_required, false);
  assert.equal(releaseApproval({ amount_cents: cents("12000"), release_on: D("2027-11-26"), new_payee: false }).dual_approval_required, false);                                          // a routine > $10,000 bill to an unchanged payee
  assert.equal(releaseApproval({ amount_cents: cents("900"), payee_instruction_changed_on: D("2027-11-25"), release_on: D("2027-11-26"), new_payee: false }).dual_approval_required, false);   // a change ≤ $10,000 needs evidence, not dual approval
  assert.equal(releaseApproval({ amount_cents: cents("900"), release_on: D("2027-11-26"), new_payee: true }).reason, "new payee");
  // Through the bus: validated evidence first, then two distinct officers; a routine bill releases without either.
  const bus = escrowBus("L-1", "2027-11-26T12:00:00.000Z"); const changed = { kind: "tax", amount_cents: cents("12000"), escrow_balance_cents: cents("15000"), payee_instruction_changed_on: "2027-11-25", release_on: "2027-11-26", must_pay_by: "2027-12-10", method: "ach" };
  assert.equal((await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, changed))?.code, "PAYEE_CHANGE_EVIDENCE");
  assert.equal((await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, { ...changed, payee_evidence_document_id: "doc-77" }))?.code, "PAYEE_CHANGE_DUAL");
  assert.equal((await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, { ...changed, payee_evidence_document_id: "doc-77", approvals: [OFFICER_A, { kind: "human", id: "u-analyst", role: "ops_analyst" }] }))?.code, "PAYEE_CHANGE_DUAL");
  assert.equal(await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, { ...changed, payee_evidence_document_id: "doc-77", approvals: [OFFICER_A, OFFICER_B] }), null);
  assert.equal(await bus.refusal("3.7", "releaseDisbursement", ESCROW_AGENT, { kind: "tax", amount_cents: cents("12000"), escrow_balance_cents: cents("15000"), release_on: "2027-11-26", must_pay_by: "2027-12-10" }), null);
  assert.equal(bus.events.ofType("disbursement.sent").length, 2);
});
test("3.7-T15: Given a disbursement reversal (returned check) posted 2027-12-15, then an opposite-signed escrow event (+744.80) is emitted with the next sequence and balance restored.", async () => {
  const led = new EscrowEventLedger(81_000n); const e = led.emit("County Tax", -74_480n, D("2027-11-26")); e.status = "accepted";
  const rev = led.reverse(e.sequence, D("2027-12-15"));
  assert.equal(rev.amount_cents, 74_480n); assert.equal(rev.sequence, e.sequence + 1); assert.equal(rev.balance_cents, 81_000n); assert.equal(rev.processed_on, "2027-12-15");
  // Through the bus: the reversal is a new ledger set (never a deletion) — `ledger.entries.posted` arms the 03:00 ET clock again and the opposite-signed event takes the next sequence.
  const bus = escrowBus("L-1", "2027-11-26T17:00:00.000Z", ["3.7"]);
  await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "post", direction: "disbursement", item: "tax", amount_cents: 74_480n, opening_balance_cents: 81_000n, disbursement_id: "DSB-1" });
  await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "ack", sequence: 1, status: "accepted" });
  const r = (await bus.run("3.7", "releaseDisbursement", ESCROW_AGENT, { op: "reverse", sequence: 1, reason: "returned check", processed_at: at("2027-12-15", "12:00") })) as { sequence: number; amount_cents: bigint; balance_cents: bigint; processed_on: string; deadline_at: string; reversal_of: number; entry_set_id: string };
  assert.deepEqual([r.sequence, r.amount_cents, r.balance_cents, r.processed_on, r.deadline_at, r.reversal_of], [2, 74_480n, 81_000n, "2027-12-15", at("2027-12-16", "03:00"), 1]);
  const sets = bus.ctx.ledger.sets(); assert.equal(sets.length, 2); assert.equal(sets[1]!.reversesSetId, sets[0]!.id); assert.equal(bus.ctx.ledger.balance({ scope: "loan", loanId: "L-1", account: "escrow" }), 0n);   // the loan's escrow is back where it was
  const clocks = bus.ctx.timers.byCode("FNMA_LL2026_05_ESCROW_EVENT_0300ET"); assert.deepEqual(clocks.map((t) => [t.dueDate, t.status]), [["2027-11-29", "satisfied"], ["2027-12-16", "armed"]]);
  const q = bus.events.ofType("escrow.event.queued")[1]!; assert.deepEqual([p(q).item_type, p(q).amount_cents, p(q).balance_cents, p(q).reversal_of], ["County Tax (reversal)", "74480", "81000", 1]);
});

// 3.7 worked example: the 2% discount on the $760.00 bill is $15.20; balance $810.00 on 11/24 captures it.
test("3.7 worked example: $15.20 discount captured with an $810.00 balance", () => {
  const s = schedule(BILL, "tax_service_bulk", 81_000n, 0n); assert.equal(s.amount_cents, 76_000n - 1_520n); assert.equal(s.discount_captured, true); assert.equal(s.release_on, "2027-11-26");
  const noCapture = schedule(BILL, "tax_service_bulk", 50_000n, 0n); assert.equal(noCapture.discount_captured, false); assert.equal(noCapture.amount_cents, 76_000n); assert.equal(noCapture.discount_lost_reason, "insufficient funds to capture without advance");
});
