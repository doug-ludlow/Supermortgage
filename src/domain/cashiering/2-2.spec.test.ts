// 2.2 Partial payment / suspense handling
// spec/sections/02-payment-processing-cashiering/2-2-partial-payment-suspense-handling.md
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
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { LockboxIngestor } from "../../infra/integrations/banking.ts";
import { SYSTEM } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CashieringOps } from "./ops.ts";
import { decidePartial, openSuspenseItem } from "./partials.ts";
import { NoticeRegistry } from "../../notices/registry.ts";
import { publishSection02 } from "../../notices/authored/section02.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { recordPartialEvaluation, statementSuspenseSummary, statementDisclosureFacts } from "./ops-2-2.ts";
const TI_UNAPPLIED = { scope: "custodial" as const, custodialAccountId: "C-TI", account: "custodial_ti_unapplied_cash" as const };
const PI_CASH = { scope: "custodial" as const, custodialAccountId: "C-PI", account: "custodial_pi_cash" as const };
const TI_CASH = { scope: "custodial" as const, custodialAccountId: "C-TI", account: "custodial_ti_cash" as const };
const CLEARING = { scope: "custodial" as const, custodialAccountId: "C-CLR", account: "clearing_cash" as const };

test("2.2-T1: Given L-1 with no unapplied funds, when 200,000¢ arrives 2026-09-10 with a written commitment, then a `partial_payment` item is created with due 2026-10-10, funds land in `custodial_ti_unapplied_cash`, and `SUSP-PARTIAL-HOLD-v1` is sent within 1 BD.", () => {
  const h = harness("2026-09-10T14:00:00.000Z", L1());
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.2", "6.5"] });   // the 30-day balance clock is 6.5's row, enforced here
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const r = h.pay(200_000n, "2026-09-10", { channel: "lockbox", instrument: "check", borrower_instruction_text: "rest by 9/25", source_batch_id: "LB-0910" });
  assert.equal(r.plan.outcome, "unapplied"); assert.equal(r.plan.partial_hold, true); assert.equal(h.state().suspense_unapplied_cents, 200_000n);
  const ctx = { state: h.state(), days_delinquent: 9, commitment: { kind: "coupon_note" as const, stated_date: D("2026-09-25") }, received_on: D("2026-09-10"), amount_cents: 200_000n, payment_id: r.payment.id, rail: "check" as const };
  const d = decidePartial(ctx); assert.equal(d.kind, "hold"); if (d.kind === "hold") assert.equal(d.rule_path, "2.2:r3:four_conditions");
  const item = ops.openPartial(ctx, d);
  assert.equal(item.reason_code, "partial_payment"); assert.equal(item.status, "open"); assert.equal(item.partial_commitment_due_on, "2026-10-10");
  // rule 7: Dr clearing_cash / Cr suspense_unapplied, then Dr custodial_ti_unapplied_cash / Cr clearing_cash — the cash is parked in T&I unapplied
  assert.equal(h.ledger.balance(TI_UNAPPLIED), 200_000n); assert.equal(h.ledger.balance(CLEARING), 0n); assert.equal(h.ledger.balance({ scope: "loan", loanId: "L-1", account: "suspense_unapplied" }), -200_000n);
  // SUSP-PARTIAL-HOLD-v1 is queued with its 1-BD deadline (Fri 2026-09-11) and the (d)(5) facts: $2,000.00 held, send $192.57 to have the payment applied
  const q = h.events.ofType("notice.queued").find((e) => e.payload.template === "SUSP-PARTIAL-HOLD-v1")!;
  assert.equal(q.payload.due_by, "2026-09-11"); assert.equal(q.payload.send_within, "1 business_days_servicer"); assert.equal(q.payload.citation, "Servicing Guide C-1.1-02; 12 CFR 1026.41(d)(5)");
  const held = BigInt(String(q.payload.held_cents)), needed = BigInt(String(q.payload.balance_needed_cents));
  assert.equal(held, 200_000n); assert.equal(needed, 19_257n); assert.equal(held + needed, 219_257n);
  const reg = new NoticeRegistry(); publishSection02(reg);
  const v = reg.activeVersion("SUSP-PARTIAL-HOLD-v1", D("2026-09-10"))!;
  const payload = { ...v.samplePayload, received_cents: 200_000n, held_cents: held, balance_needed_cents: needed, check_sum_cents: held + needed, commitment_due_on: item.partial_commitment_due_on, business_days_since_hold: 1 };
  const rendered = render(v.source, payload);
  assert.match(rendered.text, /holding \$2,000\.00 in an unapplied funds account/); assert.match(rendered.text, /We need \$192\.57 more to apply a full payment/); assert.match(rendered.text, /send the balance by October 10, 2026/);
  assert.equal(evaluateChecklist(v, payload, rendered).passed, true);
  const late = { ...payload, business_days_since_hold: 2 }; assert.ok(evaluateChecklist(v, late, render(v.source, late)).blocking.some((b) => b.rule_id === "sent-within-1bd"));
  assert.equal(reg.template("SUSP-PARTIAL-HOLD-v1").channelPolicy, "esign_or_mail");   // channel per E-SIGN consent, else mail
  // the 30-day balance clock runs on the item from the receipt date (FNMA_C1102_PARTIAL_BALANCE_30 → 2026-10-10)
  const t30 = timers.byCode("FNMA_C1102_PARTIAL_BALANCE_30")[0]!; assert.equal(t30.dueDate, "2026-10-10"); assert.equal(t30.status, "armed");
  assert.equal(timers.byCode("SM_PARTIAL_COMMITMENT_CAPTURE_2BD").length, 0);   // the commitment was on the coupon: nothing to capture
});
test("2.2-T2: Given 2.2-T1, when 19,257¢ arrives 2026-09-24, then one periodic payment is applied with `credited_as_of` 2026-09-24, unapplied = 0, and the late charge assessed on 2026-09-17 remains.", () => {
  const h = harness("2026-09-10T14:00:00.000Z", L1());
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.2", "2.5", "6.5"] });
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const first = h.pay(200_000n, "2026-09-10", { channel: "lockbox", instrument: "check", source_batch_id: "LB-0910" });
  const item = ops.openPartial({ state: h.state(), days_delinquent: 9, commitment: { kind: "coupon_note", stated_date: D("2026-09-25") }, received_on: D("2026-09-10"), amount_cents: 200_000n, payment_id: first.payment.id, rail: "check" }, { kind: "hold", due_on: D("2026-10-10"), rule_path: "2.2:r3:four_conditions", cite: "Servicing Guide C-1.1-02" });
  h.clock.set("2026-09-17T05:30:00.000Z");
  const a = ops.runAssessment({ state: h.state(), installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(a.outcome, "assessed"); if (a.outcome === "assessed") { assert.equal(a.fee.amount_cents, 7_901n); assert.equal(a.grace_end_on, "2026-09-16"); }
  h.clock.set("2026-09-24T18:02:00.000Z");                                       // portal one-time ACH submitted 14:02 ET
  const r2 = h.pay(19_257n, "2026-09-24");
  assert.equal(r2.plan.outcome, "applied"); assert.equal(r2.plan.suspense_used_cents, 200_000n);
  assert.deepEqual([r2.plan.installments[0]!.interest_cents, r2.plan.installments[0]!.principal_cents, r2.plan.installments[0]!.escrow_cents], [135_294n, 22_723n, 61_240n]);
  assert.equal(h.state().installments[0]!.credited_as_of, "2026-09-24"); assert.equal(h.state().lpi_date, "2026-09-01"); assert.equal(h.state().suspense_unapplied_cents, 0n);
  assert.equal(h.state().late_charges_due_cents, 7_901n); assert.equal(h.state().fees![0]!.state, "assessed");   // the borrower did not include it; it remains outstanding
  // Reg Z (c)(1)(ii)(B): the receipt that made Σ ≥ P emits the accumulation event; the application closes the 30-day and the 1-BD clocks
  const acc = h.events.ofType("suspense.accumulation.sufficient")[0]!; assert.equal(acc.payload.accumulated_on, "2026-09-24"); assert.equal(acc.payload.sum_cents, "219257"); assert.equal(acc.payload.suspense_used_cents, "200000");
  assert.equal(timers.byCode("FNMA_C1102_PARTIAL_BALANCE_30")[0]!.status, "satisfied");
  const apply = timers.byCode("REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD")[0]!; assert.equal(apply.dueDate, "2026-09-25"); assert.equal(apply.status, "satisfied");
  ops.closeSuspenseItem(item, "applied", D("2026-09-24")); assert.equal(item.status, "applied");
  const inv = h.events.ofType("investor_events.created").find((e) => e.payload.type === "payment.contractual")!; assert.equal(inv.payload.effective_date, "2026-09-24"); assert.equal(inv.payload.suspense_balance_cents, "0");
  // rule 7 application: Dr custodial_pi_cash (P&I) & custodial_ti_cash (escrow) / Cr custodial_ti_unapplied_cash — the parked cash leaves T&I unapplied
  assert.equal(h.ledger.balance(TI_UNAPPLIED), 0n); assert.equal(h.ledger.balance(PI_CASH), 158_017n); assert.equal(h.ledger.balance(TI_CASH), 61_240n);
});
test("2.2-T3: Given 215,000¢ on an escrowed 07/2021 instrument with counter 2, when posted, then escrow receives 56,983¢, LPI advances, no late charge, counter = 3; a fourth ≤$50 short payment within 12 months is held as an ordinary partial.", () => {
  const h = harness("2026-09-08T14:00:00.000Z", L1({ partial_count_12m: 2 }));           // instrument 2021-07-15 ≥ 1999-03-01, escrowed, first lien
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.2", "6.5"] });
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const r = h.pay(215_000n, "2026-09-08");
  // rule 2 / example D: s = 219,257 − 215,000 = 4,257 ≤ 5,000 → a full periodic payment with the escrow bucket reduced by s (interest and principal in full)
  assert.equal(r.plan.outcome, "applied_with_50_rule"); assert.ok(r.plan.rule_path.includes("2.2:50_rule:shortfall=4257"));
  const inst = r.plan.installments[0]!;
  assert.deepEqual([inst.due_date, inst.interest_cents, inst.principal_cents, inst.escrow_cents, inst.fifty_rule_shortfall_cents], ["2026-09-01", 135_294n, 22_723n, 56_983n, 4_257n]);
  assert.equal(inst.interest_cents + inst.principal_cents + inst.escrow_cents, 215_000n); assert.equal(61_240n - inst.escrow_cents, 4_257n);
  assert.equal(h.state().lpi_date, "2026-09-01"); assert.equal(h.state().installments[0]!.status, "satisfied"); assert.equal(h.state().suspense_unapplied_cents, 0n); assert.equal(h.state().partial_count_12m, 3);
  // 2.1 rule 8 postings: the escrow ledger receives $569.83 (3.x sees the shortfall at analysis); nothing is parked in T&I unapplied
  assert.equal(h.ledger.balance({ scope: "loan", loanId: "L-1", account: "escrow" }), -56_983n); assert.equal(h.ledger.balance(TI_CASH), 56_983n); assert.equal(h.ledger.balance(PI_CASH), 158_017n); assert.equal(h.ledger.balance(TI_UNAPPLIED), 0n);
  const applied = h.events.ofType("payment.applied")[0]!;
  assert.equal(applied.payload.allocation_outcome, "applied_with_50_rule"); assert.equal(applied.payload.applied_with_50_rule, true); assert.equal(applied.payload.fifty_rule_shortfall_cents, "4257"); assert.equal(applied.payload.escrow_cents, "56983");
  // posting records the `partial_payment_evaluations` row (fifty_rule_escrow, shortfall 4,257, no conditions evaluated — the rule is deterministic and first), its decision record, and
  // the `suspense_items{partial_payment_50_rule}` counter row ("applied, not held — recorded for the 3-in-12 counter") in the same transaction (service.post → ops-2-2.recordFiftyRuleEvaluation)
  const row = h.events.ofType("partial_payment_evaluations.created")[0]!;
  assert.deepEqual([row.payload.payment_id, row.payload.rule_path, row.payload.shortfall_cents, row.payload.condition_commitment, row.payload.condition_no_nsf_history], [r.payment.id, "fifty_rule_escrow", "4257", null, null]);
  const dec = h.events.ofType("agent.decision").find((e) => e.payload.decision_id === row.payload.decision_id)!;
  assert.equal(dec.payload.action, "partial_payment.evaluated"); assert.equal(dec.payload.credited_as_of_if_applied, "2026-09-08"); assert.match(String(dec.payload.cite), /C-1\.1-02 \(\$50 rule/);
  const counter = h.events.ofType("suspense.item.created").find((e) => e.payload.reason_code === "partial_payment_50_rule")!;
  assert.deepEqual([counter.payload.status, counter.payload.amount_cents, counter.payload.held_cents, counter.payload.partial_count_12m, counter.payload.payment_id], ["applied", "4257", "0", 3, r.payment.id]);
  assert.equal(h.events.ofType("suspense.item.created").length, 1);                                    // the counter row is the only item: nothing was held
  // no late charge: the note's Monthly Payment (P&I 158,017) was received in full by the 2026-09-16 grace end (2.7)
  h.clock.set("2026-09-17T05:30:00.000Z");
  const a = ops.runAssessment({ state: h.state(), installment_due_date: D("2026-09-01"), received_toward_basis_cents: 158_017n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(a.outcome, "not_assessed"); if (a.outcome === "not_assessed") { assert.equal(a.reason, "paid within grace"); assert.equal(a.grace_end_on, "2026-09-16"); }
  assert.equal(h.state().late_charges_due_cents, 0n); assert.equal(h.events.ofType("fee.collected").length, 0);
  // FNMA_C1102_50_RULE_COUNT_12M: the counter row (`suspense.item.created{reason_code=partial_payment_50_rule}`, 6.5's spelling of `payment.applied{allocation_outcome=applied_with_50_rule}`) arms the gate — open at two prior applications, closed at three
  const gate = timers.byCode("FNMA_C1102_50_RULE_COUNT_12M")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:2.2.fiftyRuleCount");
  assert.equal(evaluateGate("2.2.fiftyRuleCount", { partial_count_12m: 2 }).open, true); assert.equal(evaluateGate("2.2.fiftyRuleCount", { partial_count_12m: h.state().partial_count_12m }).open, false);
  // a fourth ≤$50 short payment within 12 months: counter 3 → rule 3, held as an ordinary partial with the 30-day clock
  h.clock.set("2026-10-05T14:00:00.000Z");
  const r2 = h.pay(215_000n, "2026-10-05");                                              // October: s = 4,257 again, but partial_count_12m = 3
  assert.equal(r2.plan.outcome, "unapplied"); assert.equal(r2.plan.partial_hold, true); assert.ok(r2.plan.rule_path.includes("2.2:partial→suspense")); assert.ok(!r2.plan.rule_path.some((p) => p.startsWith("2.2:50_rule")));
  assert.equal(h.state().partial_count_12m, 3); assert.equal(h.state().suspense_unapplied_cents, 215_000n); assert.equal(h.state().installments[1]!.status, "due"); assert.equal(h.ledger.balance(TI_UNAPPLIED), 215_000n);
  const q = h.events.ofType("notice.queued").find((e) => e.payload.template === "SUSP-PARTIAL-HOLD-v1")!; assert.equal(q.payload.held_cents, "215000"); assert.equal(q.payload.balance_needed_cents, "4257");
  const ctx = { state: h.state(), days_delinquent: 4, commitment: { kind: "history_completes_partials" as const }, received_on: D("2026-10-05"), amount_cents: 215_000n, payment_id: r2.payment.id, rail: "ach_credit" as const };
  const d = decidePartial(ctx); assert.equal(d.kind, "hold");
  const item = ops.openPartial(ctx, d); assert.equal(item.reason_code, "partial_payment"); assert.equal(item.partial_commitment_due_on, "2026-11-04");
  assert.equal(recordPartialEvaluation({ events: h.events, clock: h.clock }, ctx, d).rule_path, "hold_four_conditions");
  const t30 = timers.byCode("FNMA_C1102_PARTIAL_BALANCE_30")[0]!; assert.equal(t30.dueDate, "2026-11-04"); assert.equal(t30.status, "armed");
});
test("2.2-T4: Given a non-escrowed loan, when a payment short by 3,000¢ arrives, then the $50 rule is not available and the four-condition path runs.", () => {
  const h = harness("2026-09-08T14:00:00.000Z", L1({ escrowed: false }));
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.2", "6.5"] });
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const r = h.pay(216_257n, "2026-09-08");                                               // s = 219,257 − 216,257 = 3,000 ≤ 5,000, but rule 2 needs `loan_terms.escrowed = true`
  assert.equal(r.plan.outcome, "unapplied"); assert.equal(r.plan.partial_hold, true);
  assert.ok(r.plan.rule_path.includes("2.2:partial→suspense")); assert.ok(!r.plan.rule_path.some((p) => p.startsWith("2.2:50_rule")));
  assert.equal(h.state().partial_count_12m, 0); assert.equal(h.state().suspense_unapplied_cents, 216_257n); assert.equal(h.state().installments[0]!.status, "due"); assert.equal(h.ledger.balance(TI_UNAPPLIED), 216_257n);
  assert.equal(h.events.ofType("payment.applied").length, 0);
  const twin = harness("2026-09-08T14:00:00.000Z", L1());                                // the same receipt on the escrowed twin is the $50 rule — escrow is the only difference
  assert.equal(twin.pay(216_257n, "2026-09-08").plan.outcome, "applied_with_50_rule");
  // rule 3: nothing on the coupon → the four-condition test needs the commitment: contact_pending, and SM_PARTIAL_COMMITMENT_CAPTURE_2BD runs from received_on (Tue 09-08 → Thu 09-10)
  const ctx = { state: h.state(), days_delinquent: 7, commitment: null, received_on: D("2026-09-08"), amount_cents: 216_257n, payment_id: r.payment.id, rail: "ach_credit" as const };
  const d0 = decidePartial(ctx); assert.equal(d0.kind, "contact_pending"); assert.equal(d0.rule_path, "2.2:r3:commitment_needed");
  const item = ops.openPartial(ctx, d0); assert.equal(item.status, "contact_pending"); assert.equal(item.partial_commitment_due_on, null);
  const created = h.events.ofType("suspense.item.created")[0]!; assert.equal(created.payload.condition_commitment, "unknown"); assert.equal(created.payload.partial_payment, true);
  const capture = timers.byCode("SM_PARTIAL_COMMITMENT_CAPTURE_2BD")[0]!; assert.equal(capture.status, "armed"); assert.equal(capture.dueDate, "2026-09-10");
  assert.equal(h.events.ofType("borrower_comms.contact_requested")[0]!.payload.due_by, "2026-09-10");
  const pending = recordPartialEvaluation({ events: h.events, clock: h.clock }, ctx, d0);
  assert.equal(pending.rule_path, "hold_four_conditions"); assert.equal(pending.condition_commitment, null); assert.equal(pending.condition_30day_commitment, null); assert.equal(pending.shortfall_cents, 3_000n);
  // borrower-comms captures the commitment on 09-09: `contact.completed{intent=partial_commitment}` satisfies the 2-BD clock and the item opens with the 30-day commitment
  h.clock.set("2026-09-09T15:00:00.000Z");
  ops.recordCommitmentContact(item, { channel: "voice", commitment: { kind: "contact_intent" }, transcript_ref: "call-0909" }, D("2026-09-09"));
  assert.equal(capture.status, "satisfied"); assert.equal(item.status, "open"); assert.equal(item.partial_commitment_due_on, "2026-10-08");
  const withCommitment = { ...ctx, commitment: { kind: "contact_intent" as const } };
  const d1 = decidePartial(withCommitment); assert.equal(d1.kind, "hold"); if (d1.kind === "hold") { assert.equal(d1.rule_path, "2.2:r3:four_conditions"); assert.equal(d1.due_on, "2026-10-08"); }
  const ev = recordPartialEvaluation({ events: h.events, clock: h.clock }, withCommitment, d1, { evidence_refs: ["call-0909"] });
  assert.deepEqual([ev.condition_commitment, ev.condition_not_habitual, ev.condition_no_nsf_history, ev.condition_30day_commitment], [true, true, true, true]);
  assert.equal(ev.rule_path, "hold_four_conditions"); assert.deepEqual(ev.evidence_refs, ["call-0909"]);
  assert.deepEqual(h.events.ofType("partial_payment_evaluations.created").map((e) => e.payload.condition_commitment), [null, true]);
});
test("2.2-T5: Given `nsf_count_12m = 1` and a loan 45 days delinquent with no referral, when a partial arrives, then `rule_path=hold_policy_override` with a 30-day return, and the decision record cites C-1.1-02's \"authorized to return.\"", () => {
  // 45 days delinquent on 2026-09-15: the 2026-08-01 installment is the first unpaid (LPI 2026-07-01); one returned item in 12 months; no foreclosure referral
  const h = harness("2026-09-15T14:00:00.000Z", L1({ nsf_count_12m: 1, lpi_date: D("2026-07-01") }, D("2026-08-01"), 4));
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.2", "6.5"] });
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const r = h.pay(100_000n, "2026-09-15"); assert.equal(r.plan.outcome, "unapplied"); assert.equal(h.state().suspense_unapplied_cents, 100_000n);
  const ctx = { state: h.state(), days_delinquent: 45, commitment: { kind: "contact_intent" as const }, received_on: D("2026-09-15"), amount_cents: 100_000n, payment_id: r.payment.id, rail: "ach_credit" as const };
  const d = decidePartial(ctx);
  assert.equal(d.kind, "hold_policy_override"); assert.equal(d.rule_path, "2.2:r3:hold_policy_override"); assert.match(d.cite, /authorized to return/);
  if (d.kind === "hold_policy_override") assert.equal(d.due_on, "2026-10-15");                          // the 30-day return: received_on + 30
  const item = ops.openPartial(ctx, d);
  assert.equal(item.reason_code, "partial_payment"); assert.equal(item.status, "open"); assert.equal(item.partial_commitment_due_on, "2026-10-15");
  const t30 = timers.byCode("FNMA_C1102_PARTIAL_BALANCE_30")[0]!; assert.equal(t30.dueDate, "2026-10-15"); assert.equal(t30.status, "armed");
  // the decision record: (iii) fails → the Guide's "authorized to return"; policy still holds at ≤ 60 days delinquent with no referral (2.2-Q3)
  const ev = recordPartialEvaluation({ events: h.events, clock: h.clock }, ctx, d);
  assert.equal(ev.rule_path, "hold_policy_override"); assert.equal(ev.shortfall_cents, 119_257n);
  assert.deepEqual([ev.condition_commitment, ev.condition_not_habitual, ev.condition_no_nsf_history, ev.condition_30day_commitment], [true, true, false, true]);
  assert.match(ev.cite, /C-1\.1-02.*"authorized to return"/); assert.match(ev.policy_override_reason!, /45 days delinquent \(≤ 60\) and no foreclosure referral/);
  const dec = h.events.ofType("agent.decision").find((e) => e.payload.decision_id === ev.decision_id)!;
  assert.equal(dec.payload.action, "partial_payment.evaluated"); assert.match(String(dec.payload.cite), /C-1\.1-02 "authorized to return"/); assert.equal(dec.payload.rule_path, "hold_policy_override");
  assert.deepEqual(dec.payload.conditions, { commitment: true, not_habitual: true, no_nsf_history: false, thirty_day_commitment: true });
  const row = h.events.ofType("partial_payment_evaluations.created")[0]!; assert.equal(row.payload.rule_path, "hold_policy_override"); assert.equal(row.payload.condition_no_nsf_history, false); assert.equal(row.payload.decision_id, ev.decision_id);
  // day 31 (rule 6): the balance was not completed → returned by the original rail; the installment stays unpaid
  h.clock.set("2026-10-16T06:00:00.000Z");
  assert.equal(ops.sweepReturns([item], D("2026-10-15"), () => 219_257n, () => 100_000n).length, 0);
  const returned = ops.sweepReturns([item], D("2026-10-16"), () => 219_257n, () => 100_000n);
  assert.equal(returned.length, 1); assert.equal(item.status, "returned"); assert.equal(item.return_rail, "ach_credit");
  assert.equal(h.events.ofType("suspense.item.returned")[0]!.payload.returned_on, "2026-10-16"); assert.equal(h.events.ofType("notice.queued").some((e) => e.payload.template === "SUSP-PARTIAL-RETURN-v1"), true);
  assert.equal(h.state().installments[0]!.status, "due");
});
test("2.2-T6: Given a referred foreclosure and `partial_payment_fc_risk=true`, when a partial arrives, then the item is `foreclosure_hold` and the foreclosure case owner's decision is recorded within 2 BD.", () => {
  const h = harness("2026-10-15T14:00:00.000Z", L1({ fc_referred: true, partial_payment_fc_risk: true }));
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const ctx = { state: h.state(), days_delinquent: 130, commitment: { kind: "contact_intent" as const }, received_on: D("2026-10-15"), amount_cents: 100_000n, payment_id: "p", rail: "ach_credit" as const };
  const d = decidePartial(ctx); assert.equal(d.kind, "foreclosure_hold");
  const item = ops.openPartial(ctx, d);
  assert.equal(item.reason_code, "foreclosure_hold"); assert.equal(item.fc_decision_due_on, "2026-10-19");   // 2 servicer business days after Thursday 2026-10-15
  assert.equal(h.events.ofType("suspense.item.created")[0]!.payload.fc_decision_due_on, "2026-10-19");
  const decided = ops.fcHoldDecision(item, "accept_and_apply", D("2026-10-19"), "foreclosure-ops");
  assert.deepEqual(decided.fc_decision, { decision: "accept_and_apply", decided_on: "2026-10-19", decided_by: "foreclosure-ops", on_time: true }); assert.equal(decided.status, "applied_to_oldest");
  const ev = h.events.ofType("suspense.fc_hold.decided")[0]!; assert.equal(ev.payload.on_time, true); assert.equal(ev.payload.due_on, "2026-10-19"); assert.equal(ev.payload.decided_by, "foreclosure-ops");
  // a decision on business day 3 is recorded as late against the same clock
  const late = ops.openPartial(ctx, d); ops.fcHoldDecision(late, "return", D("2026-10-20"), "foreclosure-ops");
  assert.equal(late.fc_decision!.on_time, false); assert.equal(late.status, "returned");
});
test("2.2-T7: Given the 30-day commitment lapses, when the sweep runs on day 31, then the funds return by the original rail and `SUSP-PARTIAL-RETURN-v1` is sent; the installment stays unpaid.", () => {
  const h = harness("2026-10-11T06:00:00.000Z", L1());
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const items = [openSuspenseItem({ state: h.state(), days_delinquent: 9, received_on: D("2026-09-10"), amount_cents: 200_000n, payment_id: "p", rail: "check" }, { kind: "hold", due_on: D("2026-10-10"), rule_path: "2.2:r3:four_conditions", cite: "Servicing Guide C-1.1-02" })];
  assert.equal(ops.sweepReturns(items, D("2026-10-10"), () => 219_257n, () => 200_000n).length, 0);                  // day 30: still within the commitment
  const returned = ops.sweepReturns(items, D("2026-10-11"), () => 219_257n, () => 200_000n);                           // day 31
  assert.equal(returned.length, 1); assert.equal(returned[0]!.status, "returned"); assert.equal(returned[0]!.return_rail, "check");
  const ret = h.events.ofType("suspense.item.returned")[0]!; assert.equal(ret.payload.rail, "check"); assert.equal(ret.payload.returned_on, "2026-10-11");
  const q = h.events.ofType("notice.queued").find((e) => e.payload.template === "SUSP-PARTIAL-RETURN-v1")!; assert.equal(q.payload.rail, "check"); assert.equal(q.payload.amount_cents, "200000");
  assert.equal(h.events.ofType("suspense.item.closed")[0]!.payload.outcome, "returned");
  assert.equal(h.state().installments[0]!.status, "due");   // funds returned are not "received" for any purpose
  const reg = new NoticeRegistry(); publishSection02(reg); const v = reg.activeVersion("SUSP-PARTIAL-RETURN-v1", D("2026-10-11"))!;
  const payload = { ...v.samplePayload, amount_cents: returned[0]!.amount_cents, returned_on: "2026-10-11", commitment_due_on: "2026-10-10", days_after_commitment_date: 1, return_rail_text: "by check to your mailing address" };
  const r = render(v.source, payload); assert.match(r.text, /we returned \$2,000\.00 to you by check to your mailing address/); assert.match(r.text, /remains unpaid/);
  assert.equal(evaluateChecklist(v, payload, r).passed, true);
});
test("2.2-T8: Given an open unapplied balance of 100,000¢ and P falling from 219,257¢ to 99,000¢ on `loan_terms.activated`, when re-evaluated, then a periodic payment is applied with `credited_as_of` = activation date.", () => {
  const h = harness("2026-10-05T14:00:00.000Z", L1());
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.2"] });
  const r = h.pay(100_000n, "2026-10-05");
  assert.equal(r.plan.outcome, "unapplied"); assert.equal(h.state().suspense_unapplied_cents, 100_000n); assert.equal(h.ledger.balance(TI_UNAPPLIED), 100_000n);
  // 3.2 activates new terms: P = 70,000 + 29,000 = 99,000 for every due installment
  const s = h.state(); s.installments = s.installments.map((i) => ({ ...i, pi_cents: 70_000n, escrow_cents: 29_000n }));
  h.clock.set("2026-11-01T14:00:00.000Z");
  h.events.append({ type: "loan_terms.activated", loanId: "L-1", actor: SYSTEM, payload: { reason: "escrow_analysis", effective_on: "2026-11-01", periodic_payment_cents: "99000" } });
  const t = timers.byCode("SM_SUSPENSE_REEVAL_ON_TERMS_CHANGE_0")[0]!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2026-11-01");
  const re = h.svc.reevaluateSuspense("L-1", D("2026-11-01"));
  assert.equal(re.applied, true); assert.equal(re.plan!.installments[0]!.due_date, "2026-09-01");
  assert.equal(h.state().installments[0]!.status, "satisfied"); assert.equal(h.state().installments[0]!.credited_as_of, "2026-11-01"); assert.equal(h.state().suspense_unapplied_cents, 1_000n);
  assert.equal(t.status, "satisfied");   // same transaction: `suspense.accumulation.reevaluated`
  const ev = h.events.ofType("suspense.accumulation.reevaluated")[0]!; assert.equal(ev.payload.sufficient, true); assert.equal(ev.payload.credited_as_of, "2026-11-01"); assert.equal(ev.payload.reason, "loan_terms.activated");
  assert.equal(h.events.ofType("suspense.accumulation.sufficient")[0]!.payload.accumulated_on, "2026-11-01");
  assert.equal(h.events.ofType("payment.applied")[0]!.payload.credited_as_of, "2026-11-01");
  assert.equal(h.ledger.balance(TI_UNAPPLIED), 1_000n); assert.equal(h.ledger.balance(PI_CASH), 70_000n); assert.equal(h.ledger.balance(TI_CASH), 29_000n);
  assert.deepEqual(h.svc.reevaluateSuspense("L-1", D("2026-11-02")).applied, false);   // 1,000¢ < P: nothing more to apply
});
test("2.2-T9: Given a PITI payment arrives while a $79.01 late charge is outstanding, when allocated, then the payment is applied in full, nothing is diverted to the late charge, and no new late charge accrues.", () => {
  // example C's tail: the 2026-09-01 installment was completed on 09-24; its $79.01 late charge (assessed 09-17) is still outstanding when the October autodraft settles on time
  const fee = { id: "lc-0901", fee_type: "late_charge" as const, installment_due_date: D("2026-09-01"), amount_cents: 7_901n, state: "assessed" as const, assessed_on: D("2026-09-17"), grace_end_on: D("2026-09-16"), collected_cents: 0n };
  const h = harness("2026-10-01T14:00:00.000Z", L1({ late_charges_due_cents: 7_901n, fees: [fee], lpi_date: D("2026-09-01") }));
  h.state().installments[0]!.status = "satisfied";
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const r = h.pay(219_257n, "2026-10-01", { channel: "ach_debit_origin", instrument: "ach" });
  // rule 5: never deduct a late charge from a payment that covers PITI; never treat it as partial because a late charge is outstanding
  assert.equal(r.plan.outcome, "applied"); assert.equal(r.plan.partial_hold, false); assert.equal(r.plan.installments.length, 1);
  const inst = r.plan.installments[0]!;
  assert.equal(inst.due_date, "2026-10-01"); assert.equal(inst.interest_cents + inst.principal_cents, 158_017n); assert.equal(inst.escrow_cents, 61_240n);
  assert.equal(inst.interest_cents + inst.principal_cents + inst.escrow_cents, 219_257n);
  assert.equal(r.plan.late_charge_cents, 0n); assert.equal(r.plan.to_suspense_cents, 0n); assert.ok(!r.plan.allocations.some((a) => a.bucket === "late_charge"));
  assert.equal(h.state().late_charges_due_cents, 7_901n); assert.equal(h.state().fees![0]!.state, "assessed"); assert.equal(h.state().fees![0]!.collected_cents, 0n);
  assert.equal(h.state().installments[1]!.status, "satisfied"); assert.equal(h.state().installments[1]!.credited_as_of, "2026-10-01"); assert.equal(h.state().lpi_date, "2026-10-01"); assert.equal(h.state().suspense_unapplied_cents, 0n);
  assert.equal(h.events.ofType("fee.collected").length, 0); assert.equal(h.ledger.balance({ scope: "corporate", account: "corporate_cash" }), 0n); assert.equal(h.ledger.balance({ scope: "loan", loanId: "L-1", account: "late_charges" }), 0n);
  assert.equal(h.ledger.balance(PI_CASH), 158_017n); assert.equal(h.ledger.balance(TI_CASH), 61_240n);
  const applied = h.events.ofType("payment.applied")[0]!; assert.equal(applied.payload.installment_due_date, "2026-10-01"); assert.equal(applied.payload.credited_as_of, "2026-10-01");
  // 2.7 on 2026-10-17: the October installment was credited in full by its 10-16 grace end — the only "delinquency" is the unpaid $79.01 (Reg Z §1026.36(c)(2): no pyramiding)
  h.clock.set("2026-10-17T05:30:00.000Z");
  const a = ops.runAssessment({ state: h.state(), installment_due_date: D("2026-10-01"), received_toward_basis_cents: 158_017n, run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(a.outcome, "not_assessed");
  if (a.outcome === "not_assessed") { assert.match(a.reason, /^paid within grace \(no pyramiding on prior fees, §1026\.36\(c\)\(2\)\)$/); assert.equal(a.grace_end_on, "2026-10-16"); }   // the engine names the prior $79.01 as the only shortfall
  const pyramid = evaluateGate("2.7.noPyramiding", { periodic_payment_credited_by_grace_end: true, only_shortfall_is_prior_fees: true });
  assert.equal(pyramid.open, false); assert.match(pyramid.reason!, /1026\.36\(c\)\(2\)/);                 // the gate closes on a new late charge
  assert.equal(h.state().late_charges_due_cents, 7_901n); assert.equal(h.state().fees!.length, 1);       // the October statement shows "late charge due $79.01"; nothing new accrued
});
test("2.2-T10: Given any period end with Σ unapplied > 0, when 7.1 renders the statement, then the (d)(3) amount and (d)(5) instruction text are present (template checklist passes).", () => {
  // example C at the 2026-09-17 period end: 200,000¢ held since 09-10 against P = 219,257 — the `statement_suspense_summary` read model 7.1 renders
  const h = harness("2026-09-10T14:00:00.000Z", L1());
  const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const r = h.pay(200_000n, "2026-09-10", { channel: "lockbox", instrument: "check", source_batch_id: "LB-0910" });
  const ctx = { state: h.state(), days_delinquent: 9, commitment: { kind: "coupon_note" as const, stated_date: D("2026-09-25") }, received_on: D("2026-09-10"), amount_cents: 200_000n, payment_id: r.payment.id, rail: "check" as const };
  const item = ops.openPartial(ctx, decidePartial(ctx));
  const summary = statementSuspenseSummary({ loan_id: "L-1", periodic_payment_cents: 219_257n, items: [item], since: D("2026-08-17"), period_end: D("2026-09-17") });
  assert.equal(summary.sum_unapplied_cents, 200_000n); assert.equal(summary.balance_needed_cents, 19_257n); assert.equal(summary.items_since_last_statement.length, 1); assert.equal(summary.items_since_last_statement[0]!.suspense_item_id, item.id);
  assert.equal(summary.instruction_text, "We received $2,000.00, which is being held. We need $192.57 more to apply a full payment.");
  // 7.1 renders NTC_REGZ_41_STMT_STD through the notice service (the real statement path): the (d)(3) past-payments line carries the unapplied amount, the (d)(5) block the instructions
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.2"] });
  const reg = buildRegistry(); publishAuthored(reg);
  const svc = new NoticeService({ registry: reg, events: h.events, clock: h.clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const v = reg.activeVersion("NTC_REGZ_41_STMT_STD", D("2026-09-17"))!;
  const sample = v.samplePayload as Record<string, unknown>;
  const payload = { ...sample, statement_date: "2026-09-17",
    payments_since_last: { total_cents: 200_000n, principal_cents: 0n, interest_cents: 0n, escrow_cents: 0n, fees_cents: 0n, suspense_cents: summary.sum_unapplied_cents },
    ytd: { ...(sample.ytd as Record<string, unknown>), suspense_held_cents: summary.sum_unapplied_cents }, suspense_instructions: summary.instruction_text,
    transactions: [{ date: "2026-09-10", description: "Payment received — held in suspense", amount_cents: 200_000n }, { date: "2026-09-17", description: "Late fee", amount_cents: 7_901n }], late_fee_debits: 1 };
  const BEA = { partyId: "A", name: "Bea Borrower", mailingAddress: "1 Test St, Testville TX 75001" };
  h.clock.set("2026-09-17T06:00:00.000Z");
  const n = svc.render({ templateCode: "NTC_REGZ_41_STMT_STD", loanId: "L-1", recipients: [BEA], payload, asOf: D("2026-09-17") });
  assert.equal(n.status, "rendered");
  assert.match(n.rendered.text, /Payments received since last statement: \$2,000\.00 \(principal .* unapplied \$2,000\.00\)/);   // (d)(3)
  assert.match(n.rendered.text, /unapplied funds currently held \$2,000\.00/);
  assert.match(n.rendered.text, /We received \$2,000\.00, which is being held\. We need \$192\.57 more to apply a full payment\./);   // (d)(5)
  assert.equal(n.checklist.passed, true); assert.ok(["d3-past-payments", "d3-ytd-suspense", "d5-suspense"].every((id) => n.checklist.results.some((x) => x.rule_id === id && x.passed)));
  // REGZ_1026_41D5_STATEMENT_SUSPENSE_DISCLOSURE arms on the rendered statement (`notice.rendered{template=NTC_REGZ_41_STMT_STD}`); the evaluator gate opens on the disclosure facts
  const rendered = h.events.ofType("notice.rendered")[0]!; assert.equal(rendered.payload.template, "NTC_REGZ_41_STMT_STD"); assert.equal(rendered.loanId, "L-1");
  const gate = timers.byCode("REGZ_1026_41D5_STATEMENT_SUSPENSE_DISCLOSURE"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.note, "evaluator:2.2.statementSuspenseDisclosure");
  const facts = statementDisclosureFacts(summary, n.checklist); assert.deepEqual(facts, { suspense_unapplied_cents: 200_000n, d3_amount_shown: true, d5_instructions_shown: true });
  assert.equal(evaluateGate("2.2.statementSuspenseDisclosure", facts).open, true);
  // without the (d)(5) text the checklist holds the statement (7.1 blocks it): `notice.held`, nothing arms, and the gate is closed
  const held = svc.render({ templateCode: "NTC_REGZ_41_STMT_STD", loanId: "L-1", recipients: [BEA], payload: { ...payload, suspense_instructions: null }, asOf: D("2026-09-17") });
  assert.equal(held.status, "held"); assert.match(held.heldReason!, /d5-suspense/); assert.equal(h.events.ofType("notice.held")[0]!.payload.template, "NTC_REGZ_41_STMT_STD");
  assert.equal(timers.byCode("REGZ_1026_41D5_STATEMENT_SUSPENSE_DISCLOSURE").length, 1);
  const closed = evaluateGate("2.2.statementSuspenseDisclosure", statementDisclosureFacts(summary, held.checklist)); assert.equal(closed.open, false); assert.match(closed.reason!, /\(d\)\(5\)/);
  assert.equal(evaluateGate("2.2.statementSuspenseDisclosure", { suspense_unapplied_cents: 0n, d3_amount_shown: false, d5_instructions_shown: false }).open, true);   // Σ unapplied = 0: nothing to disclose
});
test("2.2-T11: Given the same check image resubmitted, when ingested, then the second item is rejected as a duplicate and an exception is logged.", () => {
  const lockbox = new LockboxIngestor();
  const header = ["01,121000248,SM,260903,0700,1,,,2/", "02,SM,121000248,1,260903,,USD,2/", "03,4455667788,USD/"];
  const item = "16,165,219257,0,BR2,0087654321,LOCKBOX PMT/";
  const first = lockbox.ingest([...header, item, "49,219257,3/", "98,219257,1,5/", "99,219257,1,7/"].join("\n"));
  assert.equal(first.status, "ingested"); assert.equal(first.items.length, 1); assert.deepEqual(first.duplicates, []);
  const resubmitted = lockbox.ingest(["01,121000248,SM,260904,0700,2,,,2/", ...header.slice(1), item, "49,219257,3/", "98,219257,1,5/", "99,219257,1,7/"].join("\n"));   // the next day's file carrying the same image
  assert.equal(resubmitted.items.length, 0); assert.equal(resubmitted.duplicates.length, 1);
  // and the cashiering receipt rejects it as a duplicate with an exception logged
  const { svc, events } = harness("2026-09-03T14:00:00.000Z", L1());
  const a = svc.receive({ channel: "lockbox", instrument: "check", amount_cents: 219_257n, received_at: "2026-09-03T14:00:00.000Z", loan_id: "L-1", source_batch_id: first.items[0]!.batchId, source_item_id: "BR2" });
  const b = svc.receive({ channel: "lockbox", instrument: "check", amount_cents: 219_257n, received_at: "2026-09-03T14:00:00.000Z", loan_id: "L-1", source_batch_id: first.items[0]!.batchId, source_item_id: "BR2" });
  assert.equal(a.duplicate, false); assert.equal(b.duplicate, true); assert.equal(b.payment.id, a.payment.id);
  const ex = events.ofType("payment.duplicate.rejected"); assert.equal(ex.length, 1); assert.equal(ex[0]!.payload.exception, "duplicate_item");
});
