/** Acceptance tests from spec §2.1 (2.1-T1 … T6, T8, T9) and the 2.2 $50 rule. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryEventStore, FixedClock, SYSTEM } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadRegistry, TimerEngine } from "../../kernel/timers/index.ts";
import { plainDate as D, addMonths } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { CashieringService } from "./service.ts";
import { receiptDates, DEFAULT_CHANNELS, assertCreditedAsOfPermitted } from "./receipt.ts";
import { servicer } from "../../kernel/calendar/business.ts";
import type { LoanCashState } from "./types.ts";

/** Fixture L-1 from 2.1 rule 11: 6.500% fixed, P&I 158,017¢, escrow 61,240¢, LPI 2026-08-01, UPB 24,977,400¢, instrument 07/2021. */
function fixtureL1(o: Partial<LoanCashState> = {}): LoanCashState {
  const installments = Array.from({ length: 4 }, (_, i) => ({ due_date: addMonths(D("2026-09-01"), i), pi_cents: 158_017n, escrow_cents: 61_240n, status: "due" as const }));
  return { loan_id: "L-1", instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: 24_977_400n, lpi_date: D("2026-08-01"),
    installments, late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false, ...o };
}

function harness(nowIso: string, loan: LoanCashState = fixtureL1()) {
  const clock = new FixedClock(nowIso);
  const events = new MemoryEventStore(clock);
  const ledger = new MemoryLedger();
  const timers = new TimerEngine(loadRegistry(), events, { processes: ["2.1"] });
  const store = new Map<string, LoanCashState>([[loan.loan_id, loan]]);
  const svc = new CashieringService({ events, ledger, clock, loans: { get: (id) => store.get(id), put: (s) => store.set(s.loan_id, s) }, custodial: { clearing: "C-CLR", pi: "C-PI", ti: "C-TI" } });
  return { clock, events, ledger, timers, svc, state: () => store.get(loan.loan_id)! };
}
const loanAcct = (id: string, account: "principal" | "interest_due" | "escrow" | "suspense_unapplied" | "late_charges") => ({ scope: "loan" as const, loanId: id, account });
const cust = (id: string, account: "clearing_cash" | "custodial_pi_cash" | "custodial_ti_cash" | "custodial_ti_unapplied_cash") => ({ scope: "custodial" as const, custodialAccountId: id, account });

test("2.1-T1: L-1 autodraft 219,257¢ settling 2026-09-03 → 135,294 / 22,723 / 61,240; LPI 2026-09-01; UPB 24,954,677¢; credited 2026-09-03; one payment.contractual", () => {
  const { svc, events, ledger, state } = harness("2026-09-03T09:00:00.000Z");
  const { payment } = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T09:00:00.000Z", settlement_date: D("2026-09-03"), loan_id: "L-1", trace_number: "PPD-1" });
  svc.identify(payment.id, "L-1");
  const { plan } = svc.post(payment.id);
  assert.equal(plan.outcome, "applied");
  assert.equal(plan.installments.length, 1);
  assert.deepEqual([plan.installments[0]!.interest_cents, plan.installments[0]!.principal_cents, plan.installments[0]!.escrow_cents], [135_294n, 22_723n, 61_240n]);
  assert.equal(state().upb_cents, 24_954_677n);
  assert.equal(state().lpi_date, "2026-09-01");
  assert.equal(state().installments[0]!.status, "satisfied");
  assert.equal(state().installments[0]!.credited_as_of, "2026-09-03");
  assert.equal(payment.credited_as_of, "2026-09-03");
  assert.equal(payment.status, "posted");
  // Bucket order for a 1999+ instrument: interest, principal, escrow
  assert.deepEqual(plan.allocations.map((a) => a.bucket), ["interest", "principal", "escrow"]);
  assert.equal(plan.allocations[0]!.rule_ref, "F-1-09:order_1999plus:interest");
  // Ledger (worked example A): direct deposit lands in custodial P&I; escrow moves to T&I; loan accounts credited
  assert.equal(ledger.balance(cust("C-PI", "custodial_pi_cash")), 219_257n - 61_240n);
  assert.equal(ledger.balance(cust("C-TI", "custodial_ti_cash")), 61_240n);
  assert.equal(ledger.balance(loanAcct("L-1", "interest_due")), -135_294n);
  assert.equal(ledger.balance(loanAcct("L-1", "principal")), -22_723n);
  assert.equal(ledger.balance(loanAcct("L-1", "escrow")), -61_240n);
  assert.equal(ledger.balance(loanAcct("L-1", "suspense_unapplied")), 0n);
  // Events + investor contract (rule 10): figures identical to the allocation payload, seq 1
  const inv = events.ofType("investor_events.created");
  assert.equal(inv.length, 1);
  assert.equal(inv[0]!.payload.type, "payment.contractual");
  assert.equal(inv[0]!.payload.sequence, 1);
  assert.equal(inv[0]!.payload.upb_cents, "24954677");
  assert.equal(inv[0]!.payload.interest_cents, "135294");
  assert.equal(inv[0]!.payload.lpi_date, "2026-09-01");
  for (const t of ["payment.received", "payment.applied", "payment.posted", "escrow.deposit"]) assert.equal(events.ofType(t).length, 1, t);
});

test("2.1-T2: lockbox item scanned 2026-09-16 at 17:30 local is dated 2026-09-17 and records the requirements version", () => {
  const scanned = toIso(zonedEpochMs(D("2026-09-16"), "17:30", "America/Chicago"));
  const d = receiptDates({ channel: "lockbox", instrument: "check", amount_cents: 1n, received_at: scanned }, DEFAULT_CHANNELS.lockbox, servicer);
  assert.equal(d.received_on, "2026-09-17");
  assert.equal(d.requirements_version, "PAYREQ-2026-01");
  // Before cut-off keeps the scan date; a Friday-evening scan rolls to Monday.
  assert.equal(receiptDates({ channel: "lockbox", instrument: "check", amount_cents: 1n, received_at: toIso(zonedEpochMs(D("2026-09-16"), "16:59", "America/Chicago")) }, DEFAULT_CHANNELS.lockbox, servicer).received_on, "2026-09-16");
  assert.equal(receiptDates({ channel: "lockbox", instrument: "check", amount_cents: 1n, received_at: toIso(zonedEpochMs(D("2026-09-18"), "17:30", "America/Chicago")) }, DEFAULT_CHANNELS.lockbox, servicer).received_on, "2026-09-21");
});

test("2.1-T3: nonconforming office check credits as of receipt under policy 0, +5 under policy 5, and +6 is rejected", () => {
  const received = toIso(zonedEpochMs(D("2026-09-11"), "16:10", "America/New_York"));   // worked example B
  const d0 = receiptDates({ channel: "mail_office", instrument: "check", amount_cents: 219_257n, received_at: received }, DEFAULT_CHANNELS.mail_office, servicer);
  assert.deepEqual([d0.received_on, d0.credited_as_of, d0.conforming], ["2026-09-11", "2026-09-11", false]);
  const d5 = receiptDates({ channel: "mail_office", instrument: "check", amount_cents: 219_257n, received_at: received }, { ...DEFAULT_CHANNELS.mail_office, nonconforming_credit_days: 5 }, servicer);
  assert.equal(d5.credited_as_of, "2026-09-16");
  assert.throws(() => assertCreditedAsOfPermitted(D("2026-09-11"), D("2026-09-17"), false), /REGZ_1026_36C1III_NONCONFORMING_5CD/);
  // Posting the office check queues PAY-NONCONFORMING-v1 and allocates identically to A.
  const { svc, events } = harness("2026-09-11T20:10:00.000Z");
  const { payment } = svc.receive({ channel: "mail_office", instrument: "check", amount_cents: 219_257n, received_at: received, loan_id: "L-1", check_number: "1044" });
  assert.equal(events.ofType("notice.queued")[0]!.payload.template, "PAY-NONCONFORMING-v1");
  svc.identify(payment.id, "L-1");
  const { plan } = svc.post(payment.id);
  assert.deepEqual([plan.installments[0]!.interest_cents, plan.installments[0]!.principal_cents], [135_294n, 22_723n]);
});

test("2.1-T4: two 219,257¢ payments the same day satisfy two installments in due-date order with two investor events in receipt order", () => {
  const { svc, events, state } = harness("2026-09-03T09:00:00.000Z");
  const a = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T13:00:00.000Z", loan_id: "L-1", source_item_id: "s1" }).payment;
  const b = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T15:00:00.000Z", loan_id: "L-1", source_item_id: "s2" }).payment;
  svc.identify(a.id, "L-1"); svc.post(a.id);
  svc.identify(b.id, "L-1"); const r = svc.post(b.id);
  assert.equal(state().installments[0]!.status, "satisfied");
  assert.equal(state().installments[1]!.status, "prepaid");                // Oct 1 is not yet due on Sep 3
  assert.equal(r.plan.installments[0]!.due_date, "2026-10-01");
  assert.equal(r.plan.outcome, "prepaid");
  // second installment's interest is on the reduced UPB: 24,954,677 × 6.5% / 12 = 135,171.17 → 135,171
  assert.equal(r.plan.installments[0]!.interest_cents, 135_171n);
  const inv = events.ofType("investor_events.created");
  assert.deepEqual(inv.map((e) => [e.payload.type, e.payload.sequence]), [["payment.contractual", 1], ["payment.prepaid", 2]]);
  assert.equal(state().lpi_date, "2026-10-01");
  // Duplicate submission of the same item is idempotent.
  assert.equal(svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T13:00:00.000Z", loan_id: "L-1", source_item_id: "s1" }).duplicate, true);
});

test("2.1-T5: lockbox batch received Friday; custodial deposit Tuesday (2 BD) satisfies, Wednesday breaches sev-1", () => {
  for (const [landing, expectBreach] of [["2026-09-15", false], ["2026-09-16", true]] as const) {
    const clock = new FixedClock("2026-09-11T15:00:00.000Z");                 // Friday
    const events = new MemoryEventStore(clock);
    const timers = new TimerEngine(loadRegistry(), events, { processes: ["2.1"] });
    events.append({ type: "lockbox.batch.received", aggregate: { kind: "lockbox_batch", id: "LB1" }, actor: SYSTEM, payload: { batch_id: "LB1" } });
    const t = timers.byCode("FNMA_C1101_LOCKBOX_CUSTODIAL_2BD")[0]!;
    assert.equal(t.dueDate, "2026-09-15");
    const breaches = timers.evaluate(`${landing}T18:00:00.000Z`).filter((b) => b.def.code === "FNMA_C1101_LOCKBOX_CUSTODIAL_2BD");
    if (expectBreach) { assert.equal(breaches.length, 1); assert.equal(breaches[0]!.severity, 1); }
    else assert.equal(breaches.length, 0);
    events.append({ type: "custodial_deposits.custodial_deposited_at", aggregate: { kind: "lockbox_batch", id: "LB1" }, actor: SYSTEM, payload: {} });
    assert.equal(t.status, expectBreach ? "satisfied_late" : "satisfied");
  }
});

test("2.1-T6: 'apply to my second mortgage' is refused, funds apply per default, decision cites C-1.1-01", () => {
  const { svc, events } = harness("2026-09-03T09:00:00.000Z");
  const p = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T13:00:00.000Z", loan_id: "L-1", borrower_instruction_text: "apply to my second mortgage", instruction_source: "portal_field" }).payment;
  svc.identify(p.id, "L-1");
  const { plan } = svc.post(p.id);
  assert.equal(plan.outcome, "applied");
  assert.ok(plan.refused_instruction);
  assert.equal(plan.refused_instruction!.cite, "Servicing Guide C-1.1-01");
  const d = events.ofType("agent.decision")[0]!;
  assert.equal(d.payload.action, "instruction_refused");
  assert.equal(d.payload.cite, "Servicing Guide C-1.1-01");
  assert.equal(p.decision_ids.length, 1);
});

test("2.1-T8: ACH R01 return reverses with mirror entries restoring UPB/LPI and emits payment.reversal", () => {
  const { svc, events, ledger, state, clock } = harness("2026-09-03T09:00:00.000Z");
  const p = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T09:00:00.000Z", settlement_date: D("2026-09-03"), loan_id: "L-1", trace_number: "PPD-9" }).payment;
  svc.identify(p.id, "L-1"); svc.post(p.id);
  assert.equal(state().upb_cents, 24_954_677n);
  clock.set("2026-09-05T14:00:00.000Z");
  svc.reverse(p.id, "returned_item", { return_code: "R01" });
  assert.equal(p.status, "reversed");
  assert.equal(state().upb_cents, 24_977_400n);
  assert.equal(state().lpi_date, "2026-08-01");
  assert.equal(state().installments[0]!.status, "due");
  for (const a of [cust("C-PI", "custodial_pi_cash"), cust("C-TI", "custodial_ti_cash"), loanAcct("L-1", "principal"), loanAcct("L-1", "interest_due"), loanAcct("L-1", "escrow")]) assert.equal(ledger.balance(a), 0n);
  assert.equal(ledger.sets().length, 6);                                     // 3 original + 3 mirror; both transactions stay on the statement
  const rev = events.ofType("payment.reversed")[0]!;
  assert.equal(rev.payload.return_code, "R01");
  assert.equal(rev.payload.restored_upb_cents, "24977400");
  const inv = events.ofType("investor_events.created");
  assert.deepEqual(inv.map((e) => e.payload.type), ["payment.contractual", "payment.reversal"]);
  assert.throws(() => svc.reverse(p.id, "duplicate"), /terminal/);
});

test("2.1-T9: pre-1999 instrument allocates escrow before interest and principal", () => {
  const { svc } = harness("2026-09-03T09:00:00.000Z", fixtureL1({ instrument_date: D("1997-04-01") }));
  const p = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T09:00:00.000Z", settlement_date: D("2026-09-03"), loan_id: "L-1" }).payment;
  svc.identify(p.id, "L-1");
  const { plan } = svc.post(p.id);
  assert.deepEqual(plan.allocations.map((a) => a.bucket), ["escrow", "interest", "principal"]);
  assert.equal(plan.allocations[0]!.rule_ref, "F-1-09:order_pre1999:escrow");
});

test("remainder goes to outstanding late charges, then suspense; suspense accumulates into the next installment (2.2 rule 4)", () => {
  const { svc, state, ledger } = harness("2026-09-03T09:00:00.000Z", fixtureL1({ late_charges_due_cents: 6_321n }));
  // $2,192.57 + $63.21 late charge + $10.00 extra → one installment, late charge cleared, $10 to suspense
  const p = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n + 6_321n + 1_000n, received_at: "2026-09-03T09:00:00.000Z", settlement_date: D("2026-09-03"), loan_id: "L-1" }).payment;
  svc.identify(p.id, "L-1");
  const { plan } = svc.post(p.id);
  assert.equal(plan.late_charge_cents, 6_321n);
  assert.equal(plan.to_suspense_cents, 1_000n);
  assert.equal(state().late_charges_due_cents, 0n);
  assert.equal(state().suspense_unapplied_cents, 1_000n);
  assert.equal(ledger.balance({ scope: "corporate", account: "corporate_cash" }), 6_321n);
  // A later short payment plus the $10 in suspense completes the October installment.
  const q = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n - 1_000n, received_at: "2026-10-02T09:00:00.000Z", settlement_date: D("2026-10-02"), loan_id: "L-1" }).payment;
  svc.identify(q.id, "L-1");
  const r = svc.post(q.id);
  assert.equal(r.plan.outcome, "applied");
  assert.equal(r.plan.installments[0]!.due_date, "2026-10-01");
  assert.ok(r.plan.rule_path.includes("suspense.accumulated:1000"));
  assert.equal(state().suspense_unapplied_cents, 0n);
});

test("2.2 $50 rule: a $40 short payment on an escrowed 1999+ first lien applies in full with escrow reduced; a $60 short one is held", () => {
  const { svc, state, events } = harness("2026-09-03T09:00:00.000Z");
  const p = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n - 4_000n, received_at: "2026-09-03T09:00:00.000Z", settlement_date: D("2026-09-03"), loan_id: "L-1" }).payment;
  svc.identify(p.id, "L-1");
  const { plan } = svc.post(p.id);
  assert.equal(plan.outcome, "applied_with_50_rule");
  assert.deepEqual([plan.installments[0]!.interest_cents, plan.installments[0]!.principal_cents, plan.installments[0]!.escrow_cents], [135_294n, 22_723n, 61_240n - 4_000n]);
  assert.equal(plan.installments[0]!.fifty_rule_shortfall_cents, 4_000n);
  assert.equal(state().partial_count_12m, 1);
  assert.equal(state().installments[0]!.status, "satisfied");
  assert.equal(events.ofType("payment.applied")[0]!.payload.applied_with_50_rule, true);
  const q = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n - 6_000n, received_at: "2026-10-02T09:00:00.000Z", settlement_date: D("2026-10-02"), loan_id: "L-1" }).payment;
  svc.identify(q.id, "L-1");
  const r = svc.post(q.id);
  assert.equal(r.plan.outcome, "unapplied");
  assert.equal(state().suspense_unapplied_cents, 219_257n - 6_000n);
  assert.equal(state().installments[1]!.status, "due");
  assert.equal(q.status, "posted");                                          // cash is always posted the day it is received
});

test("holds route funds to suspense with the hold-specific outcome and the payment state machine records it", () => {
  const { svc, state, events } = harness("2026-09-03T09:00:00.000Z", fixtureL1({ holds: ["bankruptcy"] }));
  const p = svc.receive({ channel: "bk_trustee", instrument: "check", amount_cents: 100_000n, received_at: "2026-09-03T14:00:00.000Z", loan_id: "L-1" }).payment;
  svc.identify(p.id, "L-1");
  const { plan } = svc.post(p.id);
  assert.equal(plan.outcome, "held_bk");
  assert.equal(state().suspense_unapplied_cents, 100_000n);
  assert.equal(state().upb_cents, 24_977_400n);
  assert.equal(events.ofType("payment.held")[0]!.payload.hold, "bankruptcy");
  assert.equal(p.status, "posted");
});
