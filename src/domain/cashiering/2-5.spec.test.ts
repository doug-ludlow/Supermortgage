// 2.5 Biweekly third-party payments
// spec/sections/02-payment-processing-cashiering/2-5-biweekly-third-party-payments.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { CashieringService } from "./service.ts";
import type { LoanCashState } from "./types.ts";
const AGENT = { kind: "agent" as const, id: "cashiering" };
function L1(o: Partial<LoanCashState> = {}, firstDue = D("2026-09-01"), n = 4): LoanCashState {
  const installments = Array.from({ length: n }, (_, i) => ({ due_date: addMonths(firstDue, i), pi_cents: 158_017n, escrow_cents: 61_240n, status: "due" as const }));
  return { loan_id: "L-1", instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: 24_977_400n, lpi_date: D("2026-08-01"), installments,
    late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false, late_charge_pct: "5", late_charge_grace_days: 15, fees: [], overlays: [], ...o };
}
function harness(nowIso: string, loan: LoanCashState) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const store = new Map<string, LoanCashState>([[loan.loan_id, loan]]);
  const svc = new CashieringService({ events, ledger, clock, loans: { get: (id) => store.get(id), put: (s) => store.set(s.loan_id, s) }, custodial: { clearing: "C-CLR", pi: "C-PI", ti: "C-TI" } });
  const pay = (amount: bigint, on: string, extra: Record<string, unknown> = {}) => {
    const p = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: amount, received_at: `${on}T14:00:00.000Z`, loan_id: loan.loan_id, source_item_id: `${on}-${amount}`, ...extra }).payment;
    svc.identify(p.id, loan.loan_id); return svc.post(p.id);
  };
  return { clock, events, ledger, svc, pay, state: () => store.get(loan.loan_id)! };
}
void AGENT; void harness; void L1;
import { newArrangement, lateChargeExplanation, contractorProgramAnswer, NON_ENDORSEMENT_STATEMENT, FREE_INHOUSE_OPTION, THIRDPARTY_INFO_TEMPLATE, designatedPrincipalFromAddenda, biweeklyInterest, returnClockSuspended, type Arrangement } from "./biweekly.ts";
import { assessLateCharge, graceEndFor } from "./latecharges.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { CashieringOps } from "./ops.ts";
import { ContractorRemittanceIngest, type ContractorRemittance } from "./ops-2-5.ts";
import { newEnrollment, type Authorization } from "./autodraft.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
const TI_UNAPPLIED = { scope: "custodial" as const, custodialAccountId: "C-TI", account: "custodial_ti_unapplied_cash" as const };
const COMPANY = "1234567890";                                                       // the contractor's ACH company ID (parties{kind=payment_contractor})
const P = 158_017n + 61_240n;                                                       // L-1 periodic payment 219,257¢
/** A CTX credit from the contractor for L-1: one `payments` row via the 2.5 ingestion path (rule 1). */
function ctx(id: string, on: string, amount: bigint, addenda: string, extra: Partial<ContractorRemittance["items"][number]> = {}, company = COMPANY): ContractorRemittance {
  return { remittance_id: id, contractor_company_id: company, format: "ach_ctx", settlement_date: D(on), received_at: `${on}T14:00:00.000Z`, items: [{ loan_id: "L-1", amount_cents: amount, addenda, ...extra }] };
}
function contractorHarness(nowIso: string, loan: LoanCashState, a: Arrangement) {
  const h = harness(nowIso, loan);
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.5"] });
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const ingest = new ContractorRemittanceIngest({ svc: h.svc, ops, events: h.events, arrangements: { byLoan: (id) => (id === a.loan_id ? a : undefined) } });
  return { ...h, timers, ops, ingest };
}

test("2.5-T1: Given an active arrangement, when 219,257¢ arrives 2026-09-28 by CTX with the loan number in addenda, then the 2026-10-01 installment is applied as prepaid with `credited_as_of` 2026-09-28.", () => {
  const cur = L1(); cur.installments[0]!.status = "satisfied";
  const a = newArrangement("L-1", COMPANY); a.status = "active"; a.last_remittance_on = D("2026-08-28");
  const h = contractorHarness("2026-09-28T14:00:00.000Z", cur, a);
  const out = h.ingest.ingest(ctx("CTX-20260928-01", "2026-09-28", 219_257n, "LOAN 0087654321 PMT 219257"));
  assert.equal(out.postings.length, 1); assert.equal(out.escalations.length, 0); assert.deepEqual(out.duplicates, []);
  const r = out.postings[0]!;
  assert.equal(r.payment.channel, "third_party_contractor"); assert.equal(r.payment.payer_type, "contractor"); assert.equal(r.payment.received_on, "2026-09-28"); assert.equal(r.payment.credited_as_of, "2026-09-28");
  assert.equal(r.payment.curtailment_cents, undefined); assert.equal(designatedPrincipalFromAddenda("LOAN 0087654321 PMT 219257"), 0n);   // "PMT" addenda designate nothing as principal
  // C-1.1-04 gate, judged from the receipt itself: conforming (channel table), sufficient (219,257 = P), timely (09-28 ≤ grace end 10-16) → accepted like any other payment
  const graceEnd = graceEndFor(h.state(), D("2026-10-01")); assert.equal(graceEnd, "2026-10-16");
  const facts = { channel: r.payment.channel, conforming: r.payment.conforming, amount_cents: r.payment.amount_cents, periodic_payment_cents: P, received_on: r.payment.received_on, grace_end_on: graceEnd };
  assert.equal(evaluateGate("2.5.acceptConformingContractorPayment", facts).open, true);
  assert.match(evaluateGate("2.5.acceptConformingContractorPayment", { ...facts, amount_cents: 109_629n }).reason!, /insufficient: 109629¢ < periodic payment 219257¢.*not refused/);   // a half is held (2.2), never refused
  assert.match(evaluateGate("2.5.acceptConformingContractorPayment", { ...facts, received_on: "2026-10-20" }).reason!, /untimely: settled 2026-10-20, after the grace end 2026-10-16/);
  assert.equal(evaluateGate("2.5.acceptConformingContractorPayment", { ...facts, channel: "portal_onetime" }).open, false);
  assert.equal(r.plan.outcome, "prepaid"); assert.equal(r.plan.installments.length, 1); assert.equal(r.plan.installments[0]!.due_date, "2026-10-01"); assert.equal(r.plan.installments[0]!.kind, "prepaid"); assert.equal(r.plan.curtailment_cents, 0n);
  assert.equal(h.state().installments[1]!.status, "prepaid"); assert.equal(h.state().installments[1]!.credited_as_of, "2026-09-28"); assert.equal(h.state().lpi_date, "2026-10-01");
  assert.equal(h.state().upb_cents, 24_977_400n - (158_017n - 135_294n));         // October interest 24,977,400 × 6.5% ÷ 12 = 135,294 is unchanged by the early receipt
  const received = h.events.ofType("payment.received")[0]!; assert.equal(received.payload.channel, "third_party_contractor"); assert.equal(received.payload.arrangement, "third_party_contractor"); assert.equal(received.payload.received_on, "2026-09-28");
  assert.equal(h.timers.byCode("FNMA_C1104_ACCEPT_CONTRACTOR_PAYMENT_GATE")[0]!.status, "satisfied");   // `payment.posted` closes the accept gate
  const dormant = h.timers.byCode("SM_CONTRACTOR_DORMANT_60"); assert.equal(dormant.length, 1); assert.equal(dormant[0]!.dueDate, "2026-11-27"); assert.equal(dormant[0]!.status, "armed");
  assert.equal(h.events.ofType("investor_events.created")[0]!.payload.type, "payment.prepaid");
  const rem = h.events.ofType("third_party.remittance.received")[0]!; assert.equal(rem.payload.remittance_id, "CTX-20260928-01"); assert.equal(rem.payload.format, "ach_ctx"); assert.equal(rem.payload.total_cents, "219257");
  const upd = h.events.ofType("arrangement.updated")[0]!; assert.equal(upd.payload.status, "active"); assert.ok(upd.sequence < received.sequence);   // the prior 60-day clock closes before the receipt arms the next
  assert.equal(a.last_remittance_on, "2026-09-28");
});
test("2.5-T2: Given halves of 109,629¢ on 09-14 and 09-28, when the second arrives, then a periodic payment is applied `credited_as_of` 2026-09-28 and 1¢ remains unapplied; the statement shows the hold and application.", () => {
  const cur = L1(); cur.installments[0]!.status = "satisfied";
  const a = newArrangement("L-1", COMPANY); a.status = "active";
  const h = contractorHarness("2026-09-14T14:00:00.000Z", cur, a);
  const first = h.ingest.ingest(ctx("CTX-20260914-01", "2026-09-14", 109_629n, "LOAN 0087654321 HALF 109629", { cadence: "biweekly_half" })).postings[0]!;
  assert.equal(first.payment.designation, "biweekly_half"); assert.equal(first.plan.outcome, "unapplied"); assert.equal(first.plan.partial_hold, false);   // halves are disclosed on the statement, not by the SUSP-PARTIAL-HOLD letter
  assert.ok(!h.events.ofType("notice.queued").some((e) => e.payload.template === "SUSP-PARTIAL-HOLD-v1"));
  const item = h.ops.openPartial({ state: h.state(), days_delinquent: 0, commitment: { kind: "active_workout_case" }, received_on: D("2026-09-14"), amount_cents: 109_629n, payment_id: first.payment.id, rail: "ach_credit" }, { kind: "hold", due_on: D("2026-10-14"), rule_path: "2.5:r2:biweekly_accumulation", cite: "Servicing Guide C-1.1-04" }, "biweekly_accumulation");
  item.partial_commitment_due_on = null;                                            // no 30-day return clock while the arrangement is active
  assert.equal(h.ledger.balance(TI_UNAPPLIED), 109_629n);
  const stale = h.timers.byCode("SM_BIWEEKLY_HALF_STALE_45")[0]!; assert.equal(stale.dueDate, "2026-10-29");
  assert.equal(h.timers.byCode("REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD").length, 0);   // nothing has accumulated to P yet
  h.clock.set("2026-09-28T14:00:00.000Z");
  const second = h.ingest.ingest(ctx("CTX-20260928-01", "2026-09-28", 109_629n, "LOAN 0087654321 HALF 109629", { cadence: "biweekly_half" })).postings[0]!;
  assert.equal(second.plan.outcome, "prepaid"); assert.equal(second.plan.suspense_used_cents, 109_629n);
  assert.equal(h.state().installments[1]!.credited_as_of, "2026-09-28"); assert.equal(h.state().suspense_unapplied_cents, 1n);
  const acc = h.events.ofType("suspense.accumulation.sufficient")[0]!; assert.equal(acc.payload.accumulated_on, "2026-09-28"); assert.equal(acc.payload.sum_cents, "219258");
  // §1026.36(c)(1)(ii): apply within 1 BD of the accumulation date — Mon 09-28 → Tue 09-29; the accumulated periodic payment posted (prepaid, `payment.prepaid.applied`) the same day
  const regz = h.timers.byCode("REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD")[0]!; assert.equal(regz.dueDate, "2026-09-29"); assert.equal(regz.status, "satisfied");
  assert.equal(h.events.ofType("payment.prepaid.applied")[0]!.payload.credited_as_of, "2026-09-28"); assert.equal(h.events.ofType("payment.posted")[1]!.payload.outcome, "prepaid");
  h.ops.closeSuspenseItem(item, "applied", D("2026-09-28")); assert.equal(stale.status, "satisfied");
  assert.equal(h.ledger.balance(TI_UNAPPLIED), 1n); assert.equal(h.ledger.balance({ scope: "custodial", custodialAccountId: "C-PI", account: "custodial_pi_cash" }), 158_017n);
  // the statement shows the hold (09-14) and the application (09-28), the 1¢ still unapplied, and the (d)(5) instruction
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_REGZ_41_STMT_STD", D("2026-10-17"))!;
  const payload = { ...v.samplePayload, payments_since_last: { total_cents: 219_258n, principal_cents: 22_723n, interest_cents: 135_294n, escrow_cents: 61_240n, fees_cents: 0n, suspense_cents: 1n }, ytd: { total_cents: 219_258n, suspense_held_cents: 1n }, ytd_ledger_total_cents: 219_258n, late_fee_debits: 0,
    suspense_instructions: "We received $1,096.29 on September 14, 2026 and held it; with the $1,096.29 received September 28, 2026 a full payment was applied as of September 28, 2026. $0.01 remains unapplied and will apply with your next payment.",
    transactions: [{ date: "2026-09-14", description: "Payment received — held (biweekly half)", amount_cents: 109_629n }, { date: "2026-09-28", description: "Payment received — held (biweekly half)", amount_cents: 109_629n }, { date: "2026-09-28", description: "Payment applied to the October 1 installment", amount_cents: 219_257n }] };
  const r = render(v.source, payload); assert.match(r.text, /held \(biweekly half\)/); assert.match(r.text, /Payment applied to the October 1 installment/); assert.match(r.text, /unapplied \$0\.01/);
  assert.equal(evaluateChecklist(v, payload, r).passed, true);
});
test('2.5-T3: Given a remittance of 438,514¢ with "PRIN 219257" addenda, when posted, then one installment and one curtailment are applied in that order with two investor events.', () => {
  // Worked example I: the 2027-03-28 remittance for the 2027-04-01 installment plus the annual extra designated "principal" in the addenda.
  const a = newArrangement("L-1", COMPANY); a.status = "active"; a.last_remittance_on = D("2027-02-26");
  const h = contractorHarness("2027-03-28T14:00:00.000Z", L1({ lpi_date: D("2027-03-01") }, D("2027-04-01"), 3), a);
  const out = h.ingest.ingest(ctx("CTX-20270328-01", "2027-03-28", 438_514n, "PRIN 219257"));
  assert.equal(out.postings.length, 1); const { plan, payment } = out.postings[0]!;
  assert.equal(payment.channel, "third_party_contractor"); assert.equal(payment.curtailment_cents, 219_257n); assert.equal(payment.borrower_instruction_text, "PRIN 219257");
  // one installment — 2027-04-01, prepaid (received 03-28) — then one curtailment of exactly the designated 219,257¢; the 05-01 installment is not prepaid with it
  assert.equal(plan.installments.length, 1); assert.equal(plan.installments[0]!.due_date, "2027-04-01"); assert.equal(plan.installments[0]!.kind, "prepaid");
  assert.equal(plan.installments[0]!.interest_cents, 135_294n); assert.equal(plan.installments[0]!.principal_cents, 22_723n);   // 24,977,400 × 6.5% ÷ 12 = 135,294.25 → 135,294; 158,017 − 135,294
  assert.equal(plan.curtailment_cents, 219_257n); assert.equal(plan.to_suspense_cents, 0n); assert.equal(plan.redirected_curtailment, false);
  const installmentSeqs = plan.allocations.filter((x) => x.installment_due_date === "2027-04-01").map((x) => x.sequence);
  const curtailment = plan.allocations.filter((x) => x.bucket === "curtailment"); assert.equal(curtailment.length, 1); assert.equal(curtailment[0]!.amount_cents, 219_257n);
  assert.equal(installmentSeqs.length, 3); assert.ok(Math.max(...installmentSeqs) < curtailment[0]!.sequence);   // in that order: interest, principal, escrow of 04-01, then the curtailment
  assert.equal(h.state().upb_cents, 24_977_400n - 22_723n - 219_257n); assert.equal(h.state().upb_cents, 24_735_420n);
  assert.equal(h.state().installments[0]!.status, "prepaid"); assert.equal(h.state().installments[1]!.status, "due"); assert.equal(h.state().lpi_date, "2027-04-01"); assert.equal(h.state().suspense_unapplied_cents, 0n);
  // two investor events, the installment (payment.prepaid) before the curtailment (payment.curtailment), each caused by its own application event
  const inv = h.events.ofType("investor_events.created"); assert.deepEqual(inv.map((e) => e.payload.type), ["payment.prepaid", "payment.curtailment"]); assert.ok(inv[0]!.sequence < inv[1]!.sequence);
  const applied = h.events.ofType("payment.prepaid.applied")[0]!; assert.equal(applied.payload.installment_due_date, "2027-04-01"); assert.equal(inv[0]!.causationId, applied.id);
  const curt = h.events.ofType("payment.curtailment.applied")[0]!; assert.equal(curt.payload.amount_cents, "219257"); assert.equal(curt.payload.upb_after_cents, "24735420"); assert.ok(applied.sequence < curt.sequence); assert.equal(inv[1]!.causationId, curt.id);
  assert.equal(inv[1]!.payload.amount_cents, "219257"); assert.equal(inv[1]!.payload.effective_date, "2027-03-28");
  assert.ok(h.events.ofType("notice.queued").some((e) => e.payload.template === "CURTAIL-CONFIRM-v1" && e.payload.amount_cents === "219257"));
  assert.equal(h.events.ofType("third_party.remittance.received")[0]!.payload.total_cents, "438514");
  assert.equal(h.timers.byCode("FNMA_C1104_ACCEPT_CONTRACTOR_PAYMENT_GATE")[0]!.status, "satisfied"); assert.equal(a.last_remittance_on, "2027-03-28");
});
test("2.5-T4: Given a contractor remittance settling 2026-10-20 for the 2026-10-01 installment, when 2.7 runs 2026-10-17, then a late charge is assessed and `THIRDPARTY-BIWEEKLY-INFO-v1` context is referenced in any borrower explanation.", () => {
  const a = newArrangement("L-1", "contractor-co");
  const oct = L1({ lpi_date: D("2026-09-01") }, D("2026-10-01"), 3);
  const r = assessLateCharge({ state: oct, installment_due_date: D("2026-10-01"), received_toward_basis_cents: 0n, run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(r.outcome, "assessed"); if (r.outcome !== "assessed") return;
  assert.equal(r.fee.amount_cents, 7_901n); assert.equal(r.grace_end_on, "2026-10-16");
  const x = lateChargeExplanation(a, { amount_cents: r.fee.amount_cents, installment_due_date: D("2026-10-01"), grace_end_on: r.grace_end_on }, D("2026-10-20"));
  assert.equal(x.context_template, THIRDPARTY_INFO_TEMPLATE); assert.match(x.text, /THIRDPARTY-BIWEEKLY-INFO-v1/); assert.match(x.text, /settled 2026-10-20, after the grace period ended 2026-10-16/);
});
test("2.5-T5: Given a half held 46 days with no second half, when the sweep runs, then the item is reclassified `partial_payment`, the 30-day clock starts, and the borrower is contacted.", () => {
  const clock = new FixedClock("2026-09-14T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.2", "2.5", "6.5"] });
  const ops = new CashieringOps({ events, clock });
  const item = ops.openPartial({ state: L1(), days_delinquent: 0, commitment: { kind: "active_workout_case" }, received_on: D("2026-09-14"), amount_cents: 109_629n, payment_id: "p", rail: "ach_credit" }, { kind: "hold", due_on: D("2026-10-14"), rule_path: "2.5:r2:biweekly_accumulation", cite: "Servicing Guide C-1.1-04" }, "biweekly_accumulation");
  item.partial_commitment_due_on = null;
  const stale = timers.byCode("SM_BIWEEKLY_HALF_STALE_45")[0]!; assert.equal(stale.dueDate, "2026-10-29");
  assert.equal(timers.byCode("FNMA_C1102_PARTIAL_BALANCE_30").length, 0);            // no 30-day return clock while the arrangement is active and the loan ≤ 30 days delinquent
  assert.equal(returnClockSuspended({ ...newArrangement("L-1", "c"), status: "active" }, 20), true);
  assert.equal(ops.reclassifyStaleHalves([item], D("2026-10-29")).length, 0);        // day 45: still a half
  clock.set("2026-10-30T06:00:00.000Z");
  assert.ok(timers.evaluate("2026-10-30T06:00:00.000Z").some((b) => b.def.code === "SM_BIWEEKLY_HALF_STALE_45"));   // day 46: the deadline passed → the sweep reclassifies
  const out = ops.reclassifyStaleHalves([item], D("2026-10-30"));
  assert.equal(out.length, 1); assert.equal(item.reason_code, "partial_payment"); assert.equal(item.partial_commitment_due_on, "2026-11-29"); assert.equal(stale.status, "satisfied_late");
  const clock30 = timers.byCode("FNMA_C1102_PARTIAL_BALANCE_30")[0]!; assert.equal(clock30.dueDate, "2026-11-29");   // the 30-day clock starts at reclassification
  assert.equal(events.ofType("suspense.item.closed")[0]!.payload.outcome, "reclassified");
  const contact = events.ofType("borrower_comms.contact_requested").find((e) => e.payload.intent === "stale_biweekly_half")!; assert.equal(contact.payload.due_by, "2026-11-03");
});
test("2.5-T6: Given a true biweekly loan, when a biweekly payment posts, then interest uses the 14-day formula and LAR 96 + 97 (or the event equivalent) are emitted.", () => {
  const h = harness("2026-09-08T14:00:00.000Z", L1({ escrowed: false, note_frequency: "biweekly" }));
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.5"] });
  const r = h.pay(219_257n, "2026-09-08");
  const expected = biweeklyInterest(24_977_400n, "6.500"); assert.equal(expected, 62_272n);   // 24,977,400 × 0.065 × 14 ÷ 365 = 62,272.42
  assert.equal(r.plan.installments[0]!.interest_cents, expected); assert.equal(r.plan.installments[0]!.principal_cents, 158_017n - expected);
  assert.equal(h.events.ofType("payment.received")[0]!.payload.note_type, "biweekly");
  assert.equal(timers.byCode("NOTE_BIWEEKLY_INTEREST_14D_RULE").length, 1);          // the rule arms on `payment.received{note_type=biweekly}`
  // the rule's evaluator recomputes the 14-day interest from the UPB and rate; the monthly 30-day figure (135,294) is rejected
  const applied = h.events.ofType("payment.applied")[0]!;
  assert.equal(evaluateGate("2.5.biweeklyInterest", { upb_cents: 24_977_400n, rate_pct: "6.500", interest_cents: applied.payload.interest_cents }).open, true);
  assert.match(evaluateGate("2.5.biweeklyInterest", { upb_cents: 24_977_400n, rate_pct: "6.500", interest_cents: 135_294n }).reason!, /= 62272¢ .* got 135294¢/);
  const inv = h.events.ofType("investor_events.created")[0]!; assert.equal(inv.payload.type, "payment.contractual"); assert.deepEqual(inv.payload.lar_codes, ["96", "97"]); assert.equal(inv.payload.effective_date, "2026-09-08");
});
test("2.5 rule 4 (case 3): in-house split autodraft — halves on the 1st and 15th accumulate on the 15th and post that day (`SM_INHOUSE_SPLIT_APPLY_ON_DUE_DATE_0`), inside the grace end", () => {
  const cur = L1(); cur.installments[0]!.status = "satisfied";
  const h = harness("2026-10-01T14:00:00.000Z", cur);
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.5"] });
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const auth: Authorization = { borrower_name: "B", loan_number_masked: "******1234", routing: "021000021", account_last4: "9876", account_type: "checking", amount_rule: "full_periodic_payment", variable_amount_statement: true, frequency: "semimonthly", first_debit_on: D("2026-10-01"), authorized_on: D("2026-09-20"), company_name: "SUPERMORTGAGE", revocation_instructions: true, optional_statement: true, esign_consent: true, sec: "WEB" };
  const e = newEnrollment("L-1", auth, 1); e.status = "active"; e.validation_status = "validated";
  ops.settleSplitHalf(e, "first", D("2026-10-01"), 109_629n, D("2026-10-01"));
  const first = h.pay(109_629n, "2026-10-01", { channel: "ach_debit_origin", settlement_date: D("2026-10-01"), arrangement: "inhouse_split", split_half: "first", designation: "biweekly_half" });
  assert.equal(first.plan.outcome, "unapplied"); assert.equal(timers.byCode("SM_INHOUSE_SPLIT_APPLY_ON_DUE_DATE_0").length, 0);   // only the second half arms the rule
  h.clock.set("2026-10-15T14:00:00.000Z");
  ops.settleSplitHalf(e, "second", D("2026-10-15"), 109_629n, D("2026-10-01"));
  const rule = timers.byCode("SM_INHOUSE_SPLIT_APPLY_ON_DUE_DATE_0")[0]!; assert.equal(rule.dueDate, "2026-10-15"); assert.equal(rule.status, "armed");
  const second = h.pay(109_629n, "2026-10-15", { channel: "ach_debit_origin", settlement_date: D("2026-10-15"), arrangement: "inhouse_split", split_half: "second", designation: "biweekly_half" });
  assert.equal(second.plan.outcome, "applied"); assert.equal(h.state().installments[1]!.credited_as_of, "2026-10-15"); assert.equal(h.state().suspense_unapplied_cents, 1n);
  assert.equal(rule.status, "satisfied");                                           // `payment.posted{arrangement=inhouse_split}` the same day
  assert.equal(h.events.ofType("payment.posted")[1]!.payload.arrangement, "inhouse_split");
  const regz = timers.byCode("REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD")[0]!; assert.equal(regz.dueDate, "2026-10-16"); assert.equal(regz.status, "satisfied");   // accumulated Thu 10-15 → by Fri 10-16; posted (`payment.applied`) the same day
  assert.equal(assessLateCharge({ state: h.state(), installment_due_date: D("2026-10-01"), received_toward_basis_cents: 158_017n, run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "not_assessed");   // credited 10-15 ≤ grace end 10-16
});
test("2.5 SM_CONTRACTOR_DORMANT_60: no remittance for 60 days after the last one → the arrangement goes dormant and the borrower is told the contractor autopay appears to have stopped; the next remittance re-activates it and closes the clock", () => {
  const cur = L1(); cur.installments[0]!.status = "satisfied";
  const a = newArrangement("L-1", COMPANY); a.status = "active";
  const h = contractorHarness("2026-09-28T14:00:00.000Z", cur, a);
  h.ingest.ingest(ctx("CTX-20260928-01", "2026-09-28", 219_257n, "LOAN 0087654321 PMT 219257"));
  const clock = h.timers.byCode("SM_CONTRACTOR_DORMANT_60")[0]!; assert.equal(clock.dueDate, "2026-11-27"); assert.equal(clock.status, "armed");   // received_on 09-28 + 60 calendar days
  assert.ok(!h.timers.evaluate("2026-11-27T23:00:00.000Z").some((b) => b.def.code === "SM_CONTRACTOR_DORMANT_60"));
  h.clock.set("2026-11-28T06:00:00.000Z");
  assert.ok(h.timers.evaluate("2026-11-28T06:00:00.000Z").some((b) => b.def.code === "SM_CONTRACTOR_DORMANT_60"));   // day 61 without a remittance
  h.ops.markDormant(a, D("2026-11-28")); assert.equal(a.status, "dormant");
  assert.equal(h.events.ofType("arrangement.updated")[1]!.payload.status, "dormant"); assert.notEqual(clock.status, "satisfied");   // dormant is the breach action, not a close
  const told = h.events.ofType("borrower_comms.contact_requested").find((e) => e.payload.intent === "contractor_autopay_stopped")!; assert.equal(told.payload.arrangement_id, a.id);
  h.clock.set("2026-12-28T14:00:00.000Z");
  h.ingest.ingest(ctx("CTX-20261228-01", "2026-12-28", 219_257n, "LOAN 0087654321 PMT 219257"));
  assert.equal(a.status, "active"); assert.equal(a.last_remittance_on, "2026-12-28");
  assert.equal(clock.status, "satisfied_late");                                     // `arrangement.updated{status=active}` — a new remittance
  const next = h.timers.byCode("SM_CONTRACTOR_DORMANT_60"); assert.equal(next.length, 2); assert.equal(next[1]!.dueDate, "2027-02-26"); assert.equal(next[1]!.status, "armed");
});
test("2.5 guardrails: an undesignated extra is never principal (438,514¢ with no PRIN addenda prepays two installments); a remittance from a company other than the arrangement's is escalated to the officer and not posted; a resubmitted item is rejected as a duplicate", () => {
  const a = newArrangement("L-1", COMPANY); a.status = "active";
  const h = contractorHarness("2027-03-28T14:00:00.000Z", L1({ lpi_date: D("2027-03-01") }, D("2027-04-01"), 3), a);
  const { plan } = h.ingest.ingest(ctx("CTX-20270328-01", "2027-03-28", 438_514n, "LOAN 0087654321 PMT 438514")).postings[0]!;
  assert.equal(plan.curtailment_cents, 0n); assert.equal(plan.installments.length, 2); assert.deepEqual(plan.installments.map((i) => i.due_date), ["2027-04-01", "2027-05-01"]);
  assert.deepEqual(h.events.ofType("investor_events.created").map((e) => e.payload.type), ["payment.prepaid", "payment.prepaid"]); assert.equal(h.events.ofType("payment.curtailment.applied").length, 0);
  const dup = h.ingest.ingest(ctx("CTX-20270328-01", "2027-03-28", 438_514n, "LOAN 0087654321 PMT 438514"));
  assert.equal(dup.postings.length, 0); assert.equal(dup.duplicates.length, 1); assert.equal(h.events.ofType("payment.duplicate.rejected").length, 1);
  const bad = h.ingest.ingest(ctx("CTX-20270329-99", "2027-03-29", 219_257n, "LOAN 0087654321 PMT 219257", {}, "9999999999"));
  assert.equal(bad.postings.length, 0); assert.equal(bad.escalations.length, 1); assert.equal(bad.escalations[0]!.payload.to, "officer"); assert.match(String(bad.escalations[0]!.payload.reason), /mismatched contractor remittance/);
  assert.equal(h.events.ofType("payment.received").length, 1);
  assert.throws(() => h.ingest.ingest({ ...ctx("CTX-EMPTY", "2027-03-29", 1n, ""), items: [] }), RangeError);
  assert.throws(() => h.ingest.ingest(ctx("CTX-OVER", "2027-03-29", 100_000n, "PRIN 219257")), RangeError);   // addenda designate more than was remitted
});
test("2.5-T7: Given a borrower asks the voice agent about a contractor's program, when answered, then the transcript shows the non-endorsement statement and the free in-house option.", () => {
  const ans = contractorProgramAnswer("Is the biweekly program from XYZ worth it?", { contractor_fee_cents: 39_500n });
  assert.ok(ans.transcript.includes(`A: ${NON_ENDORSEMENT_STATEMENT}`)); assert.ok(ans.transcript.includes(`A: ${FREE_INHOUSE_OPTION}`));
  assert.equal(ans.non_endorsement, true); assert.equal(ans.free_inhouse_option, true);
  assert.ok(!ans.transcript.some((l) => /recommend|we endorse/i.test(l)));
});
