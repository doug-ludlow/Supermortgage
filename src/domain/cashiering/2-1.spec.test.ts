// 2.1 Accept & post periodic payment (P&I + escrow)
// spec/sections/02-payment-processing-cashiering/2-1-accept-post-periodic-payment-p-i-escrow.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, eventMatches } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { CashieringService } from "./service.ts";
import type { LoanCashState } from "./types.ts";
const AGENT = { kind: "agent" as const, id: "cashiering" };
function L1(o: Partial<LoanCashState> = {}, firstDue = D("2026-09-01"), n = 4): LoanCashState {
  const installments = Array.from({ length: n }, (_, i) => ({ due_date: addMonths(firstDue, i), pi_cents: 158_017n, escrow_cents: 61_240n, status: "due" as const }));
  return { loan_id: "L-1", instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: 24_977_400n, lpi_date: D("2026-08-01"), installments,
    late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false, late_charge_pct: "5", late_charge_grace_days: 15, fees: [], overlays: [], ...o };
}
/** Fixture L-1 (rule 11) over an event store, ledger and the timer engine (2.1's rows by default; 5.1's LAR/event rows when a test asserts the rule-10 contract). */
function harness(nowIso: string, loan: LoanCashState, processes: readonly string[] = ["2.1"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes });
  const store = new Map<string, LoanCashState>([[loan.loan_id, loan]]);
  const svc = new CashieringService({ events, ledger, clock, loans: { get: (id) => store.get(id), put: (s) => store.set(s.loan_id, s) }, custodial: { clearing: "C-CLR", pi: "C-PI", ti: "C-TI" } });
  const pay = (amount: bigint, on: string, extra: Record<string, unknown> = {}) => {
    const p = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: amount, received_at: `${on}T14:00:00.000Z`, loan_id: loan.loan_id, source_item_id: `${on}-${amount}`, ...extra }).payment;
    svc.identify(p.id, loan.loan_id); return svc.post(p.id);
  };
  return { clock, events, ledger, timers, svc, pay, state: () => store.get(loan.loan_id)! };
}
void AGENT; void harness; void L1;
import { assessLateCharge } from "./latecharges.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { scheduledMonth } from "../investor/remittance.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { cashieringPostPayment } from "../../app/catalog.ts";
import { postingQueue } from "./queue.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { receiptDates, DEFAULT_CHANNELS, assertCreditedAsOfPermitted } from "./receipt.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { servicer } from "../../kernel/calendar/business.ts";
import { NoticeRegistry } from "../../notices/registry.ts";
import { publishSection02 } from "../../notices/authored/section02.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { EntityStore } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { EscalationService } from "../../app/escalations.ts";
import { SYSTEM } from "../../kernel/events/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CashieringOps } from "./ops.ts";
import { LockboxIntake, batchesFromIngest, transactionActivity, statementPaymentBreakdown } from "./ops-2-1.ts";
import { LockboxIngestor } from "../../infra/integrations/banking.ts";

const loanAcct = (id: string, account: "principal" | "interest_due" | "escrow" | "suspense_unapplied" | "late_charges") => ({ scope: "loan" as const, loanId: id, account });
const cust = (id: string, account: "clearing_cash" | "custodial_pi_cash" | "custodial_ti_cash" | "custodial_ti_unapplied_cash") => ({ scope: "custodial" as const, custodialAccountId: id, account });
/** One-item BAI2 lockbox file as the bank posts it (01/02 as-of date + time, 03 account, 16 credit item with the OCR-A scanline, 49/98/99 control totals). */
const bai2 = (yymmdd: string, hhmm: string, fileId: string, amount: bigint, bankRef: string, scanline = "0012345678"): string =>
  [`01,121000248,SM,${yymmdd},${hhmm},${fileId},,,2/`, `02,SM,121000248,1,${yymmdd},${hhmm},USD,2/`, "03,4455667788,USD/", `16,165,${amount},0,${bankRef},${scanline},LOCKBOX PMT/`, `49,${amount},3/`, `98,${amount},1,5/`, `99,${amount},1,7/`].join("\n");
/** The lockbox intake over fixture L-1: the bank file → LockboxIngestor (idempotency) → LockboxIntake (batch event + item receipts); deposit evidence through CashieringOps. */
function lockboxRun(nowIso: string, loan = L1()) {
  const h = harness(nowIso, loan);
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const intake = new LockboxIntake({ events: h.events, clock: h.clock, service: h.svc, loanByScanline: (s) => (s.startsWith("0012345678") ? "L-1" : undefined) });
  return { ...h, ops, intake, ingestor: new LockboxIngestor() };
}

test("2.1-T1: Given fixture L-1, when a 219,257¢ ACH settles 2026-09-03, then allocations are 135,294/22,723/61,240, LPI 2026-09-01, UPB 24,954,677¢, `credited_as_of` 2026-09-03, one `payment.contractual` event with seq n.", () => {
  const { svc, events, ledger, state, timers } = harness("2026-09-03T09:00:00.000Z", L1());
  const { payment } = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T09:00:00.000Z", settlement_date: D("2026-09-03"), loan_id: "L-1", trace_number: "PPD-1" });
  svc.identify(payment.id, "L-1");
  const { plan } = svc.post(payment.id);
  assert.equal(plan.outcome, "applied"); assert.equal(plan.installments.length, 1);
  // worked example A: 24,977,400 × 0.065 ÷ 12 = 135,294.25 → 135,294; principal 158,017 − 135,294 = 22,723; escrow 61,240; Σ 219,257
  assert.deepEqual([plan.installments[0]!.interest_cents, plan.installments[0]!.principal_cents, plan.installments[0]!.escrow_cents], [135_294n, 22_723n, 61_240n]);
  assert.equal(135_294n + 22_723n + 61_240n, 219_257n);
  assert.equal(state().upb_cents, 24_954_677n); assert.equal(state().lpi_date, "2026-09-01");
  assert.equal(state().installments[0]!.status, "satisfied"); assert.equal(state().installments[0]!.credited_as_of, "2026-09-03");
  assert.equal(payment.credited_as_of, "2026-09-03"); assert.equal(payment.received_on, "2026-09-03"); assert.equal(payment.status, "posted");
  // 1999+ instrument order (F-1-09): interest, principal, escrow — with the rule references on the allocation rows
  assert.deepEqual(plan.allocations.map((a) => a.bucket), ["interest", "principal", "escrow"]);
  assert.deepEqual(plan.allocations.map((a) => a.rule_ref), ["F-1-09:order_1999plus:interest", "F-1-09:order_1999plus:principal", "F-1-09:order_1999plus:escrow"]);
  // rule 8 entries: direct deposit lands in custodial P&I, escrow moves to T&I, loan accounts credited, nothing left in suspense
  assert.equal(ledger.balance(cust("C-PI", "custodial_pi_cash")), 219_257n - 61_240n); assert.equal(ledger.balance(cust("C-TI", "custodial_ti_cash")), 61_240n);
  assert.equal(ledger.balance(loanAcct("L-1", "interest_due")), -135_294n); assert.equal(ledger.balance(loanAcct("L-1", "principal")), -22_723n); assert.equal(ledger.balance(loanAcct("L-1", "escrow")), -61_240n);
  assert.equal(ledger.balance(loanAcct("L-1", "suspense_unapplied")), 0n);
  // rule 10: exactly one `payment.contractual` investor event, seq n = 1 on a fresh loan, figures identical to the allocation payload
  const inv = events.ofType("investor_events.created");
  assert.equal(inv.length, 1);
  assert.equal(inv[0]!.payload.type, "payment.contractual"); assert.equal(inv[0]!.payload.family, "payment"); assert.equal(inv[0]!.payload.sequence, 1);
  assert.deepEqual([inv[0]!.payload.effective_date, inv[0]!.payload.lpi_date, inv[0]!.payload.upb_cents, inv[0]!.payload.interest_cents, inv[0]!.payload.principal_cents, inv[0]!.payload.rate_pct, inv[0]!.payload.pi_cents, inv[0]!.payload.suspense_balance_cents],
    ["2026-09-03", "2026-09-01", "24954677", "135294", "22723", "6.500", "158017", "0"]);
  for (const t of ["payment.received", "payment.applied", "payment.posted", "escrow.deposit"]) assert.equal(events.ofType(t).length, 1, t);
  assert.equal(events.ofType("escrow.deposit")[0]!.payload.amount_cents, "61240");                          // 612.40 to 3.x/5.x
  // the posting SLA closed the same day: REGZ_1026_36C1_CREDIT_AS_OF_RECEIPT_POST_1BD armed on `payment.received` (due 2026-09-04) and satisfied by `payment.posted`
  const sla = timers.byCode("REGZ_1026_36C1_CREDIT_AS_OF_RECEIPT_POST_1BD")[0]!;
  assert.equal(sla.dueDate, "2026-09-04"); assert.equal(sla.status, "satisfied");
});

test("2.1-T2: Given a lockbox item scanned 2026-09-16 at 17:30 local, when posted, then `received_on` = 2026-09-17 (post-cut-off) and the written requirement version is recorded.", () => {
  // rule 1: the lockbox agent's receipt date, items scanned after the 5:00 p.m. local cut-off dated the next business day
  const scanned = toIso(zonedEpochMs(D("2026-09-16"), "17:30", "America/Chicago"));
  const d = receiptDates({ channel: "lockbox", instrument: "check", amount_cents: 219_257n, received_at: scanned }, DEFAULT_CHANNELS.lockbox, servicer);
  assert.equal(d.received_on, "2026-09-17"); assert.equal(d.credited_as_of, "2026-09-17"); assert.equal(d.requirements_version, "PAYREQ-2026-01");
  assert.equal(receiptDates({ channel: "lockbox", instrument: "check", amount_cents: 1n, received_at: toIso(zonedEpochMs(D("2026-09-16"), "16:59", "America/Chicago")) }, DEFAULT_CHANNELS.lockbox, servicer).received_on, "2026-09-16");
  assert.equal(receiptDates({ channel: "lockbox", instrument: "check", amount_cents: 1n, received_at: toIso(zonedEpochMs(D("2026-09-18"), "17:30", "America/Chicago")) }, DEFAULT_CHANNELS.lockbox, servicer).received_on, "2026-09-21");   // Friday evening → Monday
  // the daily file (as-of 2026-09-16 17:30) arrives by SFTP the next morning; the intake dates the item from the scan, not from the file's arrival
  const r = lockboxRun("2026-09-17T06:30:00.000Z");
  const { batches, exception } = r.intake.ingest(r.ingestor.ingest(bai2("260916", "1730", "916", 219_257n, "BR916")), r.clock.now());
  assert.equal(exception, null); assert.equal(batches.length, 1);
  const [b] = batches; const payment = b!.payments[0]!;
  assert.equal(b!.event.payload.lockbox_receipt_date, "2026-09-16"); assert.equal(b!.event.payload.received_at, scanned); assert.equal(b!.event.payload.received_by, "lockbox_agent");
  assert.equal(payment.received_at, scanned); assert.equal(payment.received_on, "2026-09-17"); assert.equal(payment.credited_as_of, "2026-09-17"); assert.equal(payment.conforming, true);
  assert.equal(payment.requirements_version, "PAYREQ-2026-01"); assert.equal(payment.loan_id, "L-1"); assert.equal(payment.source_batch_id, "916:4455667788");
  const received = r.events.ofType("payment.received")[0]!;
  assert.equal(received.payload.requirements_version, "PAYREQ-2026-01"); assert.equal(received.payload.received_on, "2026-09-17"); assert.equal(received.payload.received_by, "lockbox_agent");
  // posting keeps the dated receipt: credited as of 2026-09-17, the requirements version on the payment record, allocation identical to A
  const { plan } = r.svc.post(payment.id);
  assert.equal(plan.outcome, "applied"); assert.deepEqual([plan.installments[0]!.interest_cents, plan.installments[0]!.principal_cents, plan.installments[0]!.escrow_cents], [135_294n, 22_723n, 61_240n]);
  const posted = r.events.ofType("payment.posted")[0]!;
  assert.equal(posted.payload.received_on, "2026-09-17"); assert.equal(posted.payload.credited_as_of, "2026-09-17"); assert.equal(r.state().installments[0]!.credited_as_of, "2026-09-17");
  assert.equal(r.svc.payment(payment.id).requirements_version, "PAYREQ-2026-01");
  // the deposit clocks run from the agent's receipt date (2026-09-16), not from the file's arrival; a lockbox receipt is not on the 24-hour custodial clock
  const clearing = r.timers.byCode("FNMA_C1101_LOCKBOX_CLEARING_1BD")[0]!, custodial = r.timers.byCode("FNMA_C1101_LOCKBOX_CUSTODIAL_2BD")[0]!;
  assert.deepEqual([clearing.anchorDate, clearing.dueDate, custodial.anchorDate, custodial.dueDate], ["2026-09-16", "2026-09-17", "2026-09-16", "2026-09-18"]);
  assert.equal(r.timers.byCode("FNMA_C1101_DEPOSIT_CUSTODIAL_24H").length, 0);
  assert.equal(r.timers.byCode("REGZ_1026_36C1_CREDIT_AS_OF_RECEIPT_POST_1BD")[0]!.status, "satisfied");
});

test("2.1-T3: Given a check received at the corporate office (nonconforming), when posted with channel policy `nonconforming_credit_days=0`, then `credited_as_of` = receipt date and `PAY-NONCONFORMING-v1` is queued; with policy 5, `credited_as_of` = receipt + 5 and any attempt to set +6 is rejected.", () => {
  const received = toIso(zonedEpochMs(D("2026-09-11"), "16:10", "America/New_York"));   // worked example B: Friday 2026-09-11 4:10 p.m. at the corporate office
  const d0 = receiptDates({ channel: "mail_office", instrument: "check", amount_cents: 219_257n, received_at: received }, DEFAULT_CHANNELS.mail_office, servicer);
  assert.deepEqual([d0.received_on, d0.credited_as_of, d0.conforming], ["2026-09-11", "2026-09-11", false]);
  assert.equal(receiptDates({ channel: "mail_office", instrument: "check", amount_cents: 219_257n, received_at: received }, { ...DEFAULT_CHANNELS.mail_office, nonconforming_credit_days: 5 }, servicer).credited_as_of, "2026-09-16");
  assert.throws(() => assertCreditedAsOfPermitted(D("2026-09-11"), D("2026-09-17"), false), /REGZ_1026_36C1III_NONCONFORMING_5CD/);
  const { svc, events, state } = harness("2026-09-11T20:10:00.000Z", L1());
  const { payment } = svc.receive({ channel: "mail_office", instrument: "check", amount_cents: 219_257n, received_at: received, loan_id: "L-1", check_number: "1044" });
  svc.identify(payment.id, "L-1"); const { plan } = svc.post(payment.id);
  assert.equal(plan.outcome, "applied"); assert.equal(state().installments[0]!.credited_as_of, "2026-09-11");
  // the queued notice carries the citation and the reason; the authored template restates the written requirements and never refuses the payment
  const q = events.ofType("notice.queued").find((e) => e.payload.template === "PAY-NONCONFORMING-v1")!;
  assert.equal(q.payload.citation, "12 CFR 1026.36(c)(1)(iii)"); assert.match(String(q.payload.nonconforming_reason), /mail_office is not a specified payment channel/);
  const reg = new NoticeRegistry(); publishSection02(reg);
  const v = reg.activeVersion("PAY-NONCONFORMING-v1", D("2026-09-11"))!;
  const payload = { ...v.samplePayload, amount_cents: payment.amount_cents, received_on: payment.received_on, credited_as_of: payment.credited_as_of, credited_days_after_receipt: 0, credited_on_receipt: true };
  const r = render(v.source, payload);
  assert.match(r.text, /credited it to your loan as of September 11, 2026/); assert.match(r.text, /12 CFR 1026\.36\(c\)\(1\)\(iii\)/);
  assert.equal(evaluateChecklist(v, payload, r).passed, true);
  const sixDays = { ...payload, credited_days_after_receipt: 6 }; assert.ok(evaluateChecklist(v, sixDays, render(v.source, sixDays)).blocking.some((b) => b.rule_id === "five-day-cap"));
  // the written requirements block itself (hello notice, statements, portal) carries the six-item checklist
  const req = reg.activeVersion("PAY-REQUIREMENTS-v1", D("2026-09-11"))!;
  const c = evaluateChecklist(req, req.samplePayload, render(req.source, req.samplePayload)); assert.equal(c.passed, true);
  assert.deepEqual(c.results.filter((x) => x.passed && !x.skipped).map((x) => x.rule_id).slice(0, 7), ["address", "cutoff-by-channel", "cutoff-reasonable", "instruments", "loan-number", "us-dollars", "curtailment-designation"]);
  const earlyCutoff = { ...req.samplePayload, mail_cutoff_hhmm: "15:00" }; assert.ok(evaluateChecklist(req, earlyCutoff, render(req.source, earlyCutoff)).blocking.some((b) => b.rule_id === "cutoff-reasonable"));
});

test("2.1-T4: Given two payments of 219,257¢ received the same day, when posted, then two installments are satisfied in due-date order and two separate investor events are emitted in receipt order.", () => {
  const { svc, events, state } = harness("2026-09-03T09:00:00.000Z", L1());
  const a = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T13:00:00.000Z", loan_id: "L-1", source_item_id: "s1" }).payment;
  const b = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T15:00:00.000Z", loan_id: "L-1", source_item_id: "s2" }).payment;
  assert.notEqual(a.id, b.id);                                                                             // rule 7: separate `payments` rows, applied separately
  svc.identify(a.id, "L-1"); const first = svc.post(a.id);
  svc.identify(b.id, "L-1"); const second = svc.post(b.id);
  // due-date order: the 2026-09-01 installment first (satisfied), then 2026-10-01 — not yet due on Sep 3, so applied as prepaid (LPI advances)
  assert.equal(first.plan.installments[0]!.due_date, "2026-09-01"); assert.equal(first.plan.outcome, "applied");
  assert.equal(second.plan.installments[0]!.due_date, "2026-10-01"); assert.equal(second.plan.outcome, "prepaid");
  assert.equal(state().installments[0]!.status, "satisfied"); assert.equal(state().installments[1]!.status, "prepaid"); assert.equal(state().installments[2]!.status, "due");
  assert.equal(state().lpi_date, "2026-10-01");
  // the second installment's interest is on the reduced UPB: 24,954,677 × 6.5% ÷ 12 = 135,171.17 → 135,171; UPB after both 24,931,831
  assert.equal(second.plan.installments[0]!.interest_cents, 135_171n); assert.equal(second.plan.installments[0]!.principal_cents, 158_017n - 135_171n);
  assert.equal(state().upb_cents, 24_954_677n - (158_017n - 135_171n));
  // two separate investor events in receipt order (LL-2026-05 "individual … events"), per-loan sequence 1 then 2
  const inv = events.ofType("investor_events.created");
  assert.deepEqual(inv.map((e) => [e.payload.type, e.payload.sequence, e.aggregate?.id]), [["payment.contractual", 1, a.id], ["payment.prepaid", 2, b.id]]);
  assert.deepEqual(inv.map((e) => e.payload.lpi_date), ["2026-09-01", "2026-10-01"]);
  assert.ok(inv[0]!.occurredAt <= inv[1]!.occurredAt && events.all().indexOf(inv[0]!) < events.all().indexOf(inv[1]!));
  assert.equal(events.ofType("payment.applied").length, 1); assert.equal(events.ofType("payment.prepaid.applied").length, 1);
  // a resubmission of the same item is idempotent (never a third installment)
  assert.equal(svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T13:00:00.000Z", loan_id: "L-1", source_item_id: "s1" }).duplicate, true);
  assert.equal(events.ofType("investor_events.created").length, 2);
});

test("2.1-T5: Given a lockbox batch received Friday, when the custodial deposit lands the following Tuesday (2 BD), then `FNMA_C1101_LOCKBOX_CUSTODIAL_2BD` is satisfied; landing Wednesday breaches with sev-1.", () => {
  const friday = bai2("260911", "1500", "911", 219_257n, "BR911");                                          // Friday 2026-09-11, scanned 15:00 local
  const subject = { kind: "lockbox_batch", id: "911:4455667788" };
  // (a) custodial deposit lands Tuesday 2026-09-15 — the 2nd servicer business day after the agent's receipt — on time
  const a = lockboxRun("2026-09-11T20:30:00.000Z");
  const ingestA = a.intake.ingest(a.ingestor.ingest(friday), a.clock.now());
  assert.equal(ingestA.batches[0]!.event.type, "lockbox.batch.received"); assert.equal(ingestA.batches[0]!.event.payload.lockbox_receipt_date, "2026-09-11");
  const clearingA = a.timers.byCode("FNMA_C1101_LOCKBOX_CLEARING_1BD")[0]!, custodialA = a.timers.byCode("FNMA_C1101_LOCKBOX_CUSTODIAL_2BD")[0]!;
  assert.deepEqual([clearingA.dueDate, custodialA.dueDate], ["2026-09-14", "2026-09-15"]); assert.deepEqual(clearingA.subject, subject);
  a.clock.set("2026-09-14T19:30:00.000Z"); a.ops.recordDepositEvidence(subject, { clearing_deposited_at: "2026-09-14T19:00:00.000Z", bank_reference: "DEP-CLR-911", custodial_account_id: "C-CLR", payment_ids: ingestA.batches[0]!.payments.map((p) => p.id) });
  assert.equal(clearingA.status, "satisfied"); assert.equal(custodialA.status, "armed");
  a.clock.set("2026-09-15T18:00:00.000Z");
  assert.equal(a.timers.evaluate(a.clock.now()).filter((b) => b.def.code === "FNMA_C1101_LOCKBOX_CUSTODIAL_2BD").length, 0);
  a.ops.recordDepositEvidence(subject, { custodial_deposited_at: "2026-09-15T17:45:00.000Z", bank_reference: "DEP-PI-911", custodial_account_id: "C-PI" });
  assert.equal(custodialA.status, "satisfied"); assert.equal(a.events.ofType("timer.breached").filter((e) => e.payload.code === "FNMA_C1101_LOCKBOX_CUSTODIAL_2BD").length, 0);
  // (b) the same batch landing Wednesday 2026-09-16 breaches the Guide deadline — sev-1 — and the later evidence closes it late
  const b = lockboxRun("2026-09-11T20:30:00.000Z");
  b.intake.ingest(b.ingestor.ingest(friday), b.clock.now());
  const custodialB = b.timers.byCode("FNMA_C1101_LOCKBOX_CUSTODIAL_2BD")[0]!;
  assert.equal(custodialB.dueDate, "2026-09-15");
  b.clock.set("2026-09-16T18:00:00.000Z");
  const breaches = b.timers.evaluate(b.clock.now()).filter((x) => x.def.code === "FNMA_C1101_LOCKBOX_CUSTODIAL_2BD");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.severity, 1); assert.match(breaches[0]!.breachText, /sev-1 \(Guide breach; partner notified\)/);
  assert.equal(custodialB.status, "breached"); assert.equal(b.events.ofType("timer.breached").find((e) => e.payload.code === "FNMA_C1101_LOCKBOX_CUSTODIAL_2BD")!.payload.severity, 1);
  b.ops.recordDepositEvidence(subject, { custodial_deposited_at: "2026-09-16T17:00:00.000Z", bank_reference: "DEP-PI-911-LATE", custodial_account_id: "C-PI" });
  assert.equal(custodialB.status, "satisfied_late");
});

test('2.1-T6: Given a payment with instruction "apply to my second mortgage", when allocated, then the instruction is refused, funds apply per default and a decision record cites C-1.1-01.', () => {
  const { svc, events, state } = harness("2026-09-03T09:00:00.000Z", L1());
  const p = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T13:00:00.000Z", loan_id: "L-1", borrower_instruction_text: "apply to my second mortgage", instruction_source: "portal_field" }).payment;
  svc.identify(p.id, "L-1");
  const { plan } = svc.post(p.id);
  // rule 6 / C-1.1-01: first-lien funds are never reallocated to a subordinate lien — the instruction is refused, the default allocation stands
  assert.ok(plan.refused_instruction); assert.equal(plan.refused_instruction!.text, "apply to my second mortgage"); assert.equal(plan.refused_instruction!.cite, "Servicing Guide C-1.1-01");
  assert.equal(plan.outcome, "applied");
  assert.deepEqual([plan.installments[0]!.interest_cents, plan.installments[0]!.principal_cents, plan.installments[0]!.escrow_cents], [135_294n, 22_723n, 61_240n]);
  assert.equal(state().installments[0]!.status, "satisfied"); assert.equal(state().upb_cents, 24_954_677n);
  // the decision record (agent_decisions) cites the Guide section and keeps the refused text and rationale
  const d = events.ofType("agent.decision");
  assert.equal(d.length, 1); assert.equal(d[0]!.payload.action, "instruction_refused"); assert.equal(d[0]!.payload.cite, "Servicing Guide C-1.1-01");
  assert.equal(d[0]!.payload.instruction, "apply to my second mortgage"); assert.equal(d[0]!.payload.agent, "cashiering"); assert.equal(typeof d[0]!.payload.rationale, "string");
  assert.deepEqual(p.decision_ids, [d[0]!.payload.decision_id]);
});

test("2.1-T7: Given the posting sweep has an unposted item dated ≤ Sep 16, when the 2.7 assessment job runs Sep 17, then it waits (gate) and no late charge is assessed until the item posts.", () => {
  const s = L1();
  const gated = assessLateCharge({ state: s, installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 1 });
  assert.equal(gated.outcome, "deferred_backlog"); assert.equal(gated.grace_end_on, "2026-09-16");
  // SM_CASHIERING_POSTING_BACKLOG_GATE reads `items_received_or_identified_on_or_before_gate_date`: one unposted item closes it, zero opens it
  const closed = evaluateGate("2.1.noPostingBacklog", { items_received_or_identified_on_or_before_gate_date: 1 }); assert.equal(closed.open, false); assert.match(closed.reason!, /posting backlog: 1 > 0/);
  assert.equal(evaluateGate("2.1.noPostingBacklog", { items_received_or_identified_on_or_before_gate_date: 0 }).open, true);
  assert.equal(evaluateGate("2.1.noPostingBacklog", {}).open, false);   // an unstated backlog count never opens the gate
  assert.equal(s.fees!.length, 0);
  const after = assessLateCharge({ state: s, installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(after.outcome, "assessed");
});

test("2.1-T8: Given a posted payment whose ACH returns R01, when reversed, then mirror entries restore UPB/LPI, `payment.reversal` is emitted (or the pending event cancelled), and the statement lists both transactions.", () => {
  const { svc, events, ledger, state, clock } = harness("2026-09-03T09:00:00.000Z", L1());
  const p = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T09:00:00.000Z", settlement_date: D("2026-09-03"), loan_id: "L-1", trace_number: "PPD-9" }).payment;
  svc.identify(p.id, "L-1"); svc.post(p.id);
  assert.equal(state().upb_cents, 24_954_677n); assert.equal(state().lpi_date, "2026-09-01");
  const originalSets = [...p.ledger_entry_set_ids]; assert.equal(originalSets.length, 3);
  const originalInv = events.ofType("investor_events.created")[0]!;
  clock.set("2026-09-05T14:00:00.000Z");
  svc.reverse(p.id, "returned_item", { return_code: "R01" });
  // rule 9: mirror entries restore UPB / LPI / the installment; the pre-payment state is exactly restored
  assert.equal(p.status, "reversed"); assert.equal(p.reversal!.return_code, "R01");
  assert.equal(state().upb_cents, 24_977_400n); assert.equal(state().lpi_date, "2026-08-01"); assert.equal(state().installments[0]!.status, "due"); assert.equal(state().installments[0]!.credited_as_of, undefined);
  for (const acct of [cust("C-PI", "custodial_pi_cash"), cust("C-TI", "custodial_ti_cash"), loanAcct("L-1", "principal"), loanAcct("L-1", "interest_due"), loanAcct("L-1", "escrow")]) assert.equal(ledger.balance(acct), 0n);
  const mirrors = ledger.sets().filter((s) => s.reversesSetId !== undefined);
  assert.equal(ledger.sets().length, 6); assert.deepEqual(mirrors.map((s) => s.reversesSetId), originalSets); assert.deepEqual(p.reversal!.entry_set_ids, mirrors.map((s) => s.id));
  for (const m of mirrors) { const o = ledger.sets().find((s) => s.id === m.reversesSetId)!; assert.deepEqual(m.lines.map((l) => l.amountCents), o.lines.map((l) => -l.amountCents)); assert.equal(m.effectiveDate, "2026-09-05"); }
  // `payment.reversed` + the `payment.reversal` investor event pointing at the submitted contractual event (rule 10)
  const rev = events.ofType("payment.reversed")[0]!;
  assert.equal(rev.payload.return_code, "R01"); assert.equal(rev.payload.restored_upb_cents, "24977400"); assert.equal(rev.payload.restored_lpi_date, "2026-08-01"); assert.equal(rev.payload.nsf_fee_assessed, true);
  const inv = events.ofType("investor_events.created");
  assert.deepEqual(inv.map((e) => [e.payload.type, e.payload.sequence]), [["payment.contractual", 1], ["payment.reversal", 2]]);
  assert.equal(inv[1]!.payload.reverses_event_id, originalInv.id); assert.equal(inv[1]!.payload.family, "payment");
  // §1026.41(d)(4): the statement lists both transactions — the payment and its reversal; (d)(3) breakdown of what the payment had been applied to
  const activity = transactionActivity(events, "L-1");
  assert.deepEqual(activity.map((t) => [t.kind, t.date, t.amount_cents]), [["payment", "2026-09-03", 219_257n], ["reversal", "2026-09-05", -219_257n]]);
  assert.match(activity[1]!.description, /returned_item R01/);
  assert.deepEqual(statementPaymentBreakdown(p), { payment_id: p.id, principal_cents: 22_723n, interest_cents: 135_294n, escrow_cents: 61_240n, fees_cents: 0n, suspense_cents: 0n });
  assert.throws(() => svc.reverse(p.id, "duplicate"), /terminal/);                                          // reversed is terminal
});

test("2.1-T9: Given a pre-1999 instrument, when a full payment posts, then escrow is allocated before interest and principal.", () => {
  const { svc, ledger, state } = harness("2026-09-03T09:00:00.000Z", L1({ instrument_date: D("1997-04-01") }));
  const p = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T09:00:00.000Z", settlement_date: D("2026-09-03"), loan_id: "L-1" }).payment;
  svc.identify(p.id, "L-1");
  const { plan } = svc.post(p.id);
  // F-1-09 pre-March-1999 order: deposits for insurance and taxes, (FHA service charge n/a), interest, principal, late charges
  assert.deepEqual(plan.allocations.map((a) => a.bucket), ["escrow", "interest", "principal"]);
  assert.deepEqual(plan.allocations.map((a) => a.rule_ref), ["F-1-09:order_pre1999:escrow", "F-1-09:order_pre1999:interest", "F-1-09:order_pre1999:principal"]);
  assert.deepEqual(plan.allocations.map((a) => a.amount_cents), [61_240n, 135_294n, 22_723n]);
  assert.equal(plan.outcome, "applied"); assert.equal(state().upb_cents, 24_954_677n); assert.equal(ledger.balance(loanAcct("L-1", "escrow")), -61_240n);
});

test("2.1 deposit evidence: `custodial_deposits` rows recorded through ops close the lockbox 1-BD / 2-BD clocks and the 24-hour custodial clock for a direct receipt (C-1.1-01)", () => {
  const clock = new FixedClock("2026-09-11T15:00:00.000Z"); const events = new MemoryEventStore(clock);   // Friday
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.1"] });
  const ops = new CashieringOps({ events, clock });
  events.append({ type: "lockbox.batch.received", aggregate: { kind: "lockbox_batch", id: "LB1" }, actor: SYSTEM, payload: { batch_id: "LB1" } });
  const clearing = timers.byCode("FNMA_C1101_LOCKBOX_CLEARING_1BD")[0]!, custodial = timers.byCode("FNMA_C1101_LOCKBOX_CUSTODIAL_2BD")[0]!;
  assert.deepEqual([clearing.dueDate, custodial.dueDate], ["2026-09-14", "2026-09-15"]);
  clock.set("2026-09-14T20:00:00.000Z"); ops.recordDepositEvidence({ kind: "lockbox_batch", id: "LB1" }, { clearing_deposited_at: "2026-09-14T19:30:00.000Z", bank_reference: "DEP-1", custodial_account_id: "C-CLR", payment_ids: ["p1"] });
  assert.deepEqual([clearing.status, custodial.status], ["satisfied", "armed"]);
  clock.set("2026-09-15T20:00:00.000Z"); ops.recordDepositEvidence({ kind: "lockbox_batch", id: "LB1" }, { custodial_deposited_at: "2026-09-15T18:00:00.000Z", bank_reference: "DEP-2", custodial_account_id: "C-PI" });
  assert.equal(custodial.status, "satisfied");
  // a wire received by the servicer runs the 24-hour clock (rolled to the next servicer business day 17:00 when it lands on a non-business day)
  const { svc } = harness("2026-09-11T20:10:00.000Z", L1());
  const h2events = new MemoryEventStore(clock); const t2 = new TimerEngine(loadOverriddenRegistry(), h2events, { processes: ["2.1"] }); const ops2 = new CashieringOps({ events: h2events, clock });
  void svc;
  clock.set("2026-09-11T20:10:00.000Z");
  h2events.append({ type: "payment.received", loanId: "L-1", aggregate: { kind: "payment", id: "w1" }, actor: SYSTEM, payload: { payment_id: "w1", channel: "wire", received_by: "servicer", received_at: "2026-09-11T20:10:00.000Z", received_on: "2026-09-11" } });
  const h24 = t2.byCode("FNMA_C1101_DEPOSIT_CUSTODIAL_24H")[0]!; assert.equal(h24.dueDate, "2026-09-14");   // 24h point Sat 2026-09-12 → Mon 2026-09-14 (worked example B)
  ops2.recordDepositEvidence({ kind: "payment", id: "w1" }, { custodial_deposited_at: "2026-09-11T21:00:00.000Z", bank_reference: "WIRE-1", custodial_account_id: "C-PI", payment_ids: ["w1"] }, "L-1");
  assert.equal(h24.status, "satisfied");
});

test("2.1 lockbox intake: the daily file is validated and appended as `lockbox.batch.received` (the FNMA_C1101_LOCKBOX_* trigger); a replayed file and a re-sent file with changed items are exceptions, never re-posts; an unreadable scanline routes to 6.5", () => {
  const r = lockboxRun("2026-09-03T12:00:00.000Z");
  const reg = loadOverriddenRegistry();
  const content = bai2("260903", "0930", "903", 219_257n, "BR903");
  const first = r.intake.ingest(r.ingestor.ingest(content), r.clock.now());
  assert.equal(first.exception, null); assert.equal(first.batches.length, 1);
  const ev = first.batches[0]!.event;
  assert.deepEqual([ev.type, ev.aggregate?.kind, ev.aggregate?.id], ["lockbox.batch.received", "lockbox_batch", "903:4455667788"]);
  assert.deepEqual([ev.payload.file_id, ev.payload.item_count, ev.payload.control_total_cents, ev.payload.bank_references, ev.payload.lockbox_receipt_date], ["903", 1, "219257", ["BR903"], "2026-09-03"]);
  assert.equal(first.batches[0]!.control_total_cents, 219_257n);
  for (const code of ["FNMA_C1101_LOCKBOX_CLEARING_1BD", "FNMA_C1101_LOCKBOX_CUSTODIAL_2BD"]) {
    const def = reg.get(code)!;
    assert.equal(eventMatches(def.triggerPattern!, ev), true, code); assert.equal(def.anchorField, "lockbox_receipt_date");
    assert.equal(r.timers.byCode(code).length, 1); assert.equal(r.timers.byCode(code)[0]!.anchorDate, "2026-09-03");
  }
  assert.deepEqual([r.timers.byCode("FNMA_C1101_LOCKBOX_CLEARING_1BD")[0]!.dueDate, r.timers.byCode("FNMA_C1101_LOCKBOX_CUSTODIAL_2BD")[0]!.dueDate], ["2026-09-04", "2026-09-08"]);   // Thu → Fri; Thu + 2 BD skips Labor Day 2026-09-07
  assert.equal(first.batches[0]!.payments.length, 1); assert.equal(first.batches[0]!.payments[0]!.received_on, "2026-09-03");
  // replayed file: exception, no second batch event, nothing received twice
  const replay = r.intake.ingest(r.ingestor.ingest(content), r.clock.now());
  assert.equal(replay.batches.length, 0); assert.equal(replay.exception!.type, "lockbox.batch.exception"); assert.equal(replay.exception!.payload.reason, "duplicate_file"); assert.equal(replay.exception!.payload.action, "exception_not_repost");
  // re-sent file with a changed item: exception with the changed key, no re-post
  const changed = content.replace("219257,0,BR903", "219258,0,BR903").replace("49,219257,3/", "49,219258,3/").replace("98,219257,1,5/", "98,219258,1,5/").replace("99,219257,1,7/", "99,219258,1,7/");
  const resent = r.intake.ingest(r.ingestor.ingest(changed), r.clock.now());
  assert.equal(resent.exception!.payload.reason, "changed_items"); assert.deepEqual(resent.exception!.payload.changed, ["903:4455667788#1"]); assert.equal(resent.batches.length, 0);
  assert.equal(r.events.ofType("lockbox.batch.received").length, 1); assert.equal(r.events.ofType("payment.received").length, 1);
  // an item whose scanline matches no loan is received (cash is posted regardless of identification, rule 4) and routed to 6.5
  const next = r.intake.ingest(r.ingestor.ingest(bai2("260904", "0930", "904", 100_000n, "BR904", "9999999999")), "2026-09-04T13:00:00.000Z");
  assert.equal(next.batches[0]!.payments[0]!.loan_id, undefined); assert.deepEqual(next.batches[0]!.unidentified, [next.batches[0]!.payments[0]!.id]);
  assert.equal(r.events.ofType("lockbox.item.unidentified")[0]!.payload.scanline, "9999999999");
  // the bank's as-of time is the scan instant in the lockbox's zone; a file without one falls back to its arrival
  const batches = batchesFromIngest(r.ingestor.ingest(bai2("260908", "", "908", 1_000n, "BR908")), "2026-09-09T06:00:00.000Z");
  assert.equal(batches[0]!.received_at, "2026-09-09T06:00:00.000Z"); assert.equal(batches[0]!.lockbox_receipt_date, "2026-09-08");
  // validation: an empty batch, a non-positive item and a duplicate sequence are refused
  assert.throws(() => r.intake.receiveBatch({ batch_id: "X", file_id: "x", file_hash: "h", lockbox_receipt_date: D("2026-09-03"), received_at: "2026-09-03T12:00:00.000Z", items: [] }), RangeError);
  assert.throws(() => r.intake.receiveBatch({ batch_id: "X", file_id: "x", file_hash: "h", lockbox_receipt_date: D("2026-09-03"), received_at: "2026-09-03T12:00:00.000Z", items: [{ sequence: 1, amount_cents: 0n, scanline: "", bank_reference: "b" }] }), /amount must be positive/);
  assert.throws(() => r.intake.receiveBatch({ batch_id: "X", file_id: "x", file_hash: "h", lockbox_receipt_date: D("2026-09-03"), received_at: "2026-09-03T12:00:00.000Z", items: [{ sequence: 1, amount_cents: 1n, scanline: "", bank_reference: "b" }, { sequence: 1, amount_cents: 1n, scanline: "", bank_reference: "c" }] }), /duplicate item sequence/);
});

test("2.1 rule 10 (contract with 5.1): `investor_events.created{family=payment}` from a posted payment arms FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000 (next fannie_et BD 20:00 ET) and FNMA_LL202605_EVENT_NEXTBD_0300 (03:00 ET); `investor_events.submitted` satisfies both", () => {
  const { pay, events, timers, clock } = harness("2026-09-03T14:00:00.000Z", L1(), ["2.1", "2.4", "5.1"]);   // Thursday 10:00 ET
  const reg = loadOverriddenRegistry();
  pay(219_257n, "2026-09-03");
  const created = events.ofType("investor_events.created")[0]!;
  assert.equal(created.payload.family, "payment"); assert.equal(created.payload.processed_at, "2026-09-03T14:00:00.000Z"); assert.equal(created.payload.mode, "event");
  const lar = reg.get("FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000")!, ll = reg.get("FNMA_LL202605_EVENT_NEXTBD_0300")!;
  assert.equal(eventMatches(lar.triggerPattern!, created), true); assert.equal(eventMatches(ll.triggerPattern!, created), true);
  assert.equal(eventMatches(lar.triggerPattern!, { ...created, payload: { ...created.payload, family: "removal" } }), false);   // removals run on their own row
  const larInst = timers.byCode("FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000")[0]!, llInst = timers.byCode("FNMA_LL202605_EVENT_NEXTBD_0300")[0]!;
  assert.deepEqual([larInst.anchorDate, larInst.dueDate, new Date(larInst.dueAt!).toISOString()], ["2026-09-03", "2026-09-04", "2026-09-05T00:00:00.000Z"]);   // Fri 2026-09-04 20:00 ET
  assert.deepEqual([llInst.dueDate, new Date(llInst.dueAt!).toISOString()], ["2026-09-04", "2026-09-04T07:00:00.000Z"]);                                       // Fri 2026-09-04 03:00 ET
  assert.equal(timers.evaluate("2026-09-04T06:00:00.000Z").length, 0);
  clock.set("2026-09-04T06:30:00.000Z");
  events.append({ type: "investor_events.submitted", loanId: "L-1", aggregate: { kind: "payment", id: created.aggregate!.id }, actor: SYSTEM, causationId: created.id,
    payload: { event_id: created.id, event_type: "payment.contractual", family: "payment", status: "submitted", submitted_at: clock.now(), sequence: created.payload.sequence } });
  assert.equal(larInst.status, "satisfied"); assert.equal(llInst.status, "satisfied");
  assert.equal(events.ofType("timer.satisfied").filter((e) => e.payload.code === "FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000" || e.payload.code === "FNMA_LL202605_EVENT_NEXTBD_0300").length, 2);
});

test("2.1 rule 1 / guardrails: `received_on` is immutable once set on both write paths of payments.read/write — an agent's `data.received_on` rewrite is refused, an officer's write leaves the date untouched and points to the reversal path", async () => {
  const clock = new FixedClock("2026-09-11T20:10:00.000Z"); const events = new MemoryEventStore(clock);
  const ctx: UowContext = { loanId: "L-1", events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} };
  const agents = new AgentRegistry(); const store = new EntityStore(); const cmds = bindTools({ store, ports: {}, escalations: new EscalationService(events, clock), services: {} }, agents); const bus = new CommandBus(agents);
  const cmd = cmds.get(toolKey("2.1", "payments.read/write"))!;
  await bus.execute(cmd, AGENT, { op: "write", id: "P-1", data: { received_on: "2026-09-11", credited_as_of: "2026-09-11", status: "received", amount_cents: "219257" } }, ctx);
  await assert.rejects(bus.execute(cmd, AGENT, { op: "write", id: "P-1", data: { received_on: "2026-09-10" } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "RECEIVED_ON_IMMUTABLE");
  await assert.rejects(bus.execute(cmd, AGENT, { op: "write", id: "P-1", changes: { received_on: "2026-09-10" } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "MONEY_FIELD");
  assert.equal(store.get("payments", "P-1")!.data.received_on, "2026-09-11");
  const officer = { kind: "human" as const, id: "u-officer", role: "officer" };
  const r = await bus.execute(cmd, officer, { op: "write", id: "P-1", changes: { received_on: "2026-09-10", note: "borrower says it arrived earlier" } }, ctx);
  assert.equal(store.get("payments", "P-1")!.data.received_on, "2026-09-11");   // never edited in place: corrections are reversals
  assert.deepEqual((r.output as { received_on_correction: unknown }).received_on_correction, { attempted: "2026-09-10", refused: true, path: "payment.reverse" });
  assert.equal(store.get("payments", "P-1")!.data.note, "borrower says it arrived earlier");
  assert.equal(events.ofType("payment.received_on.correction_refused").length, 2);
});

test("2.1 AI agent design: the agent's `ledger.post` runs only through the allocation/reversal commands (a human's manual adjustment keeps the officer threshold), and `payments.read/write` refuses a written allocation plan outside the instrument order", async () => {
  const clock = new FixedClock("2026-09-03T14:00:00.000Z"); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const ctx: UowContext = { loanId: "L-1", events, ledger, timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} };
  const agents = new AgentRegistry(); const store = new EntityStore(); const cmds = bindTools({ store, ports: {}, escalations: new EscalationService(events, clock), services: {} }, agents); const bus = new CommandBus(agents);
  const post = cmds.get(toolKey("2.1", "ledger.post"))!;
  const set = (amt: bigint) => ({ effectiveDate: "2026-09-03", description: "allocation", lines: [{ account: cust("C-PI", "custodial_pi_cash"), amountCents: amt, ruleRef: "2.1 rule 8" }, { account: loanAcct("L-1", "suspense_unapplied"), amountCents: -amt, ruleRef: "2.1 rule 8" }] });
  await assert.rejects(bus.execute(post, AGENT, { entry_set: set(219_257n) }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "LEDGER_VIA_COMMANDS");
  await assert.rejects(bus.execute(post, AGENT, { via: "manual", entry_set: set(219_257n) }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "LEDGER_VIA_COMMANDS");
  assert.equal(ledger.sets().length, 0);
  await bus.execute(post, AGENT, { via: "payment.post", entry_set: set(219_257n) }, ctx);
  assert.equal(ledger.sets().length, 1);
  const analyst = { kind: "human" as const, id: "u-analyst", role: "ops_analyst" };
  await bus.execute(post, analyst, { manual: true, entry_set: set(900_000n) }, ctx);                                                                    // ≤ $10,000: the analyst posts
  await assert.rejects(bus.execute(post, analyst, { manual: true, entry_set: set(1_500_000n) }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "MANUAL_ADJUSTMENT_10K");
  assert.equal(ledger.sets().length, 2);
  // INSTRUMENT_ORDER reads the plan itself: escrow before interest on a 07/2021 instrument is refused, the F-1-09 order (and pre-1999 escrow-first) is accepted
  const rw = cmds.get(toolKey("2.1", "payments.read/write"))!;
  const plan = (buckets: readonly string[]) => buckets.map((bucket, k) => ({ sequence: k + 1, installment_due_date: "2026-09-01", bucket }));
  await assert.rejects(bus.execute(rw, AGENT, { op: "write", id: "P-9", data: { instrument_date: "2021-07-15", allocations: plan(["escrow", "interest", "principal"]) } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "INSTRUMENT_ORDER");
  await bus.execute(rw, AGENT, { op: "write", id: "P-9", data: { instrument_date: "2021-07-15", allocations: plan(["interest", "principal", "escrow"]) } }, ctx);
  await bus.execute(rw, AGENT, { op: "write", id: "P-10", data: { instrument_profile: "pre_1999", allocations: plan(["escrow", "interest", "principal"]) } }, ctx);
  await bus.execute(rw, AGENT, { op: "write", id: "P-11", data: { instrument_date: "2021-07-15", allocations: [...plan(["interest", "principal", "escrow"]), ...plan(["interest", "principal", "escrow"]).map((a) => ({ ...a, installment_due_date: "2026-10-01" }))] } }, ctx);   // two installments restart the order
  assert.equal(store.get("payments", "P-9")!.data.allocations !== undefined, true);
});

test("2.1-T10: Given an S/S loan, when `payment.applied` fires, then 5.2's remittance calculation receives interest/principal figures equal to the allocation payload (no recomputation drift).", () => {
  const { pay, events } = harness("2026-09-03T14:00:00.000Z", L1({ remittance_type: "S/S" }));
  pay(219_257n, "2026-09-03");
  const applied = events.ofType("payment.applied")[0]!;
  assert.equal(applied.payload.interest_cents, "135294"); assert.equal(applied.payload.principal_cents, "22723");
  // 5.2 consumes the allocation payload: scheduled interest at the 6.000% PTR and the servicing strip on the same UPB — no recomputation drift
  const m = scheduledMonth(24_977_400n, "6.500", "6.000", 158_017n);
  assert.equal(m.gross_interest_cents, BigInt(String(applied.payload.interest_cents))); assert.equal(m.scheduled_principal_cents, BigInt(String(applied.payload.principal_cents)));
  assert.equal(m.fnma_interest_cents, 124_887n);                                 // $1,248.87
  assert.equal(m.servicing_fee_cents, 10_407n);                                  // $104.07 servicing strip
});
test("2.1-T11: Given the AI path is disabled, when an ambiguous instruction arrives, then the item appears in the Posting Queue and the human command path enforces identical validators.", async () => {
  const clock = new FixedClock("2026-09-03T09:00:00.000Z"); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const store = new Map<string, LoanCashState>([["L-1", L1()]]);
  const svc = new CashieringService({ events, ledger, clock, loans: { get: (id) => store.get(id), put: (s) => store.set(s.loan_id, s) }, custodial: { clearing: "C-CLR", pi: "C-PI", ti: "C-TI" } });
  const { payment } = svc.receive({ channel: "lockbox", instrument: "check", amount_cents: 219_257n, received_at: "2026-09-03T09:00:00.000Z", loan_id: "L-1", borrower_instruction_text: "apply to my other loan?", source_item_id: "LBX-1" });
  const ctx: UowContext = { loanId: "L-1", events, ledger, timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} };
  const agents = new AgentRegistry(); agents.setAiOff("cashiering", "operator switched the AI path off"); const bus = new CommandBus(agents);
  await assert.rejects(bus.execute(cashieringPostPayment, AGENT, { service: svc, paymentId: payment.id, loanId: "L-1", identificationConfidence: 0.99 }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "AI_OFF");
  const queue = postingQueue(events);
  assert.equal(queue.length, 1); assert.equal(queue[0]!.payment_id, payment.id); assert.equal(queue[0]!.validators, "identical_to_ai_path");
  // the human path enforces the same validators: below 0.97 without confirmation is refused for the analyst too
  const analyst = { kind: "human" as const, id: "u-analyst", role: "ops_analyst" };
  await assert.rejects(bus.execute(cashieringPostPayment, analyst, { service: svc, paymentId: payment.id, loanId: "L-1", identificationConfidence: 0.9 }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "IDENTIFICATION_CONFIDENCE");
  const r = await bus.execute(cashieringPostPayment, analyst, { service: svc, paymentId: payment.id, loanId: "L-1", identificationConfidence: 0.99 }, ctx);
  assert.equal(r.output.plan.outcome, "applied"); assert.equal(store.get("L-1")!.upb_cents, 24_954_677n);
});
