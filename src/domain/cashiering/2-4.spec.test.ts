// 2.4 Additional principal / unscheduled payments
// spec/sections/02-payment-processing-cashiering/2-4-additional-principal-unscheduled-payments.md
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
import { reamortize, nextInstallmentSplit, applyCurtailment } from "./curtailment.ts";
import { newEnrollment, variableAmountNoticeStatus, draftAmount, type Authorization } from "./autodraft.ts";
import { SYSTEM } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CashieringOps } from "./ops.ts";
import { NoticeRegistry } from "../../notices/registry.ts";
import { publishSection02 } from "../../notices/authored/section02.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
const AUTH: Authorization = { borrower_name: "B", loan_number_masked: "******1234", routing: "021000021", account_last4: "9876", account_type: "checking", amount_rule: "full_periodic_payment", variable_amount_statement: true, frequency: "monthly", first_debit_on: D("2026-10-01"), authorized_on: D("2026-09-20"), company_name: "SUPERMORTGAGE", revocation_instructions: true, optional_statement: true, esign_consent: true, sec: "WEB" };
import { eventMatches } from "../../kernel/events/index.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { formatCents } from "../../kernel/money/cents.ts";
import { CashieringOps24, reapplyAmount } from "./ops-2-4.ts";
import { reapplicationGate } from "./curtailment.ts";
import type { AllocationPlan } from "./allocation.ts";

const split = (p: AllocationPlan) => p.installments.map((i) => ({ due: i.due_date, interest: i.interest_cents, principal: i.principal_cents, escrow: i.escrow_cents, upb_after: i.upb_after_cents }));
/** The IB/NIB ordering the Allocation Engine actually used, read off the plan's buckets (the `2.4.nibOrder` fact). */
const nibOrderOf = (p: AllocationPlan): "ib_only" | "nib_then_ib" => (p.allocations.some((a) => a.bucket === "deferred_principal" || a.bucket === "forborne_principal") ? "nib_then_ib" : "ib_only");
const unpaidCents = (s: LoanCashState): bigint => s.installments.filter((i) => i.status === "due").reduce((t, i) => t + i.pi_cents + i.escrow_cents, 0n);
const notices = () => { const reg = new NoticeRegistry(); publishSection02(reg); return reg; };
/** Worked example F on the posting path: fixture L-1 current, 319,257¢ online on 2026-09-03 with $1,000.00 marked "additional principal" (portal field → `curtailment_cents`). */
function exampleF() {
  const h = harness("2026-09-03T14:00:00.000Z", L1());
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.4", "2.1", "5.1"] });
  const r = h.pay(319_257n, "2026-09-03", { curtailment_cents: 100_000n });
  return { ...h, timers, r };
}
/** A current deferral/modification loan (2.4 rule 4): IB UPB 1,500,000¢, NIB (deferred principal) 2,000,000¢, next installment due 2026-10-01. */
const nibLoan = () => L1({ upb_cents: 1_500_000n, deferred_principal_cents: 2_000_000n, lpi_date: D("2026-09-01") }, D("2026-10-01"), 3);
function curtailNib(amount: bigint) {
  const h = harness("2026-09-03T14:00:00.000Z", nibLoan());
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.4"] });
  const r = h.pay(amount, "2026-09-03", { designation: "curtailment" });
  const received = h.events.ofType("payment.received")[0]!, applied = h.events.ofType("payment.curtailment.applied")[0]!;
  const inv = h.events.ofType("investor_events.created").find((e) => e.payload.type === "payment.curtailment")!;
  return { ...h, timers, r, received, applied, inv };
}

test("2.4-T1: Given fixture L-1 current, when 319,257¢ arrives 2026-09-03 with $1,000 designated principal, then the September installment applies first, the curtailment second, UPB = 24,854,677¢, LPI unchanged, and two investor events are emitted in that order.", () => {
  const { r, state, events, timers } = exampleF();
  // F-1-09: submitted with a scheduled payment → the scheduled installment first (2.1 example A split), then the curtailment
  assert.deepEqual(split(r.plan), [{ due: "2026-09-01", interest: 135_294n, principal: 22_723n, escrow: 61_240n, upb_after: 24_954_677n }]);
  assert.equal(r.plan.curtailment_cents, 100_000n); assert.equal(r.plan.curtailment_nib_cents, 0n);
  const buckets = r.plan.allocations.map((a) => a.bucket);
  assert.ok(buckets.includes("curtailment") && buckets.lastIndexOf("principal") < buckets.indexOf("curtailment"), `installment buckets precede the curtailment: ${buckets.join(",")}`);
  assert.equal(r.plan.allocations.find((a) => a.bucket === "curtailment")!.rule_ref, "2.4:curtailment");
  assert.equal(state().upb_cents, 24_854_677n);                                  // $248,546.77
  assert.equal(state().lpi_date, "2026-09-01");                                  // LPI stays 2026-09-01 — the curtailment advances nothing (Note §4)
  assert.equal(state().installments.find((i) => i.due_date === "2026-10-01")!.pi_cents, 158_017n);   // P&I unchanged
  assert.equal(state().installments.find((i) => i.due_date === "2026-10-01")!.status, "due");        // the curtailment never prepays October
  // investor events in order: seq n `payment.contractual` {LPI 2026-09-01, UPB 249,546.77}, seq n+1 `payment.curtailment` {UPB 248,546.77}
  const inv = events.ofType("investor_events.created");
  assert.deepEqual(inv.map((e) => [e.payload.type, e.payload.sequence, e.payload.upb_cents]), [["payment.contractual", 1, "24954677"], ["payment.curtailment", 2, "24854677"]]);
  assert.equal(inv[0]!.payload.lpi_date, "2026-09-01"); assert.equal(formatCents(BigInt(String(inv[0]!.payload.upb_cents)), { symbol: false }), "249,546.77"); assert.equal(formatCents(BigInt(String(inv[1]!.payload.upb_cents)), { symbol: false }), "248,546.77");
  assert.deepEqual(inv[1]!.payload.lar_codes, ["96"]); assert.equal(inv[1]!.payload.amount_cents, "100000");
  // FNMA_C1201_CURTAILMENT_APPLY_IMMEDIATE_0BD: armed by `payment.received{designation=curtailment, delinquent=false}`, due the same servicer BD, satisfied by `payment.curtailment.applied`
  const applied = events.ofType("payment.curtailment.applied")[0]!;
  assert.deepEqual([applied.payload.amount_cents, applied.payload.ib_applied_cents, applied.payload.upb_after_cents, applied.payload.with_scheduled_payment, applied.payload.applied_on, applied.payload.credited_as_of], ["100000", "100000", "24854677", true, "2026-09-03", "2026-09-03"]);
  const t0 = timers.byCode("FNMA_C1201_CURTAILMENT_APPLY_IMMEDIATE_0BD")[0]!;
  assert.equal(t0.anchorDate, "2026-09-03"); assert.equal(t0.dueDate, "2026-09-03"); assert.equal(t0.status, "satisfied"); assert.equal(t0.satisfiedByEventId, applied.id);
  const def = loadOverriddenRegistry().get("FNMA_C1201_CURTAILMENT_APPLY_IMMEDIATE_0BD")!;
  assert.equal(eventMatches(def.triggerPattern!, events.ofType("payment.received")[0]!), true); assert.equal(eventMatches(def.satisfiedPattern!, applied), true);
  // the curtailment is its own LL-2026-05 event: FNMA_LL202605_EVENT_NEXTBD_0300 arms per investor event, next fannie_et BD 03:00 ET (Fri 2026-09-04)
  const ll = timers.byCode("FNMA_LL202605_EVENT_NEXTBD_0300"); assert.equal(ll.length, 2); assert.equal(ll[1]!.armedByEventId, inv[1]!.id); assert.equal(ll[1]!.dueDate, "2026-09-04");
  // CURTAIL-CONFIRM-v1 (amount applied, new balance, due date/payment unchanged) queued from the posting; the authored template's checklist passes on those facts
  const q = events.ofType("notice.queued").find((e) => e.payload.template === "CURTAIL-CONFIRM-v1")!;
  assert.deepEqual([q.payload.amount_cents, q.payload.new_upb_cents, q.payload.due_date_unchanged, q.payload.pi_unchanged], ["100000", "24854677", true, true]);
  const v = notices().activeVersion("CURTAIL-CONFIRM-v1", D("2026-09-03"))!;
  const payload = { ...v.samplePayload, amount_cents: BigInt(String(q.payload.amount_cents)), applied_on: applied.payload.applied_on, new_upb_cents: state().upb_cents, expected_upb_cents: 24_954_677n - 100_000n };
  const out = render(v.source, payload); assert.match(out.text, /We applied \$1,000\.00 you designated as additional principal on September 3, 2026\. Your principal balance is now \$248,546\.77/); assert.equal(evaluateChecklist(v, payload, out).passed, true);
  const noConsent = { ...payload, esign_consent: false }; assert.ok(evaluateChecklist(v, noConsent, render(v.source, noConsent)).blocking.some((b) => b.rule_id === "electronic-with-consent-else-statement"));   // electronic with consent, else on the next statement
});
test("2.4-T2: Given 2.4-T1, when the October installment is computed, then interest = 134,630¢ and principal = 23,387¢.", () => {
  const { pay, state, clock } = exampleF();
  assert.equal(state().upb_cents, 24_854_677n);
  // 24,854,677 × 0.065 ÷ 12 = 134,629.5004 → 134,630¢ (round half-up at cents); principal = 158,017 − 134,630 = 23,387¢
  assert.deepEqual(nextInstallmentSplit(state(), 158_017n), { interest_cents: 134_630n, principal_cents: 23_387n });
  // versus 22,846¢ without the curtailment (24,954,677 × 0.065 ÷ 12 = 135,171.17 → 135,171): the borrower's principal share rises by 541¢
  const without = nextInstallmentSplit({ ...state(), upb_cents: 24_954_677n }, 158_017n);
  assert.deepEqual(without, { interest_cents: 135_171n, principal_cents: 22_846n }); assert.equal(23_387n - without.principal_cents, 541n);
  // and the October installment posted on its due date carries exactly that split (interest on the reduced UPB "as of the LPI date", F-1-09)
  clock.set("2026-10-01T14:00:00.000Z");
  const oct = pay(219_257n, "2026-10-01");
  assert.deepEqual(split(oct.plan), [{ due: "2026-10-01", interest: 134_630n, principal: 23_387n, escrow: 61_240n, upb_after: 24_831_290n }]);
  assert.equal(state().upb_cents, 24_854_677n - 23_387n); assert.equal(state().lpi_date, "2026-10-01");
});
test("2.4-T3: Given a loan with NIB 2,000,000¢ and IB UPB 1,500,000¢, when a 1,600,000¢ curtailment arrives (amount ≥ IB UPB), then the NIB is reduced first to 400,000¢ and the IB UPB is unchanged; the event payload shows NIB 4,000.00 and IB UPB 15,000.00.", () => {
  const { r, state, received, applied, inv, timers } = curtailNib(1_600_000n);
  assert.equal(r.plan.installments.length, 0);                                    // received separately on a current loan: curtailment first, no prepayment (F-1-09)
  assert.equal(r.plan.curtailment_cents, 1_600_000n); assert.equal(r.plan.curtailment_nib_cents, 1_600_000n);
  assert.deepEqual(r.plan.allocations.filter((a) => a.bucket !== "suspense").map((a) => [a.bucket, a.amount_cents, a.rule_ref]), [["deferred_principal", 1_600_000n, "2.4:r4:nib_first"]]);
  assert.equal(state().deferred_principal_cents, 400_000n); assert.equal(state().upb_cents, 1_500_000n);   // NIB first (2,000,000 − 1,600,000), IB untouched
  // `payment.curtailment.applied` {amount, ib_applied, nib_applied, new_upb, new_nib}
  assert.deepEqual([applied.payload.amount_cents, applied.payload.ib_applied_cents, applied.payload.nib_cents, applied.payload.upb_after_cents, applied.payload.nib_after_cents], ["1600000", "0", "1600000", "1500000", "400000"]);
  // the investor event reports the net interest-bearing UPB and the NIB balance separately (5.1): NIB 4,000.00, IB UPB 15,000.00
  assert.equal(formatCents(BigInt(String(inv.payload.nib_cents)), { symbol: false }), "4,000.00"); assert.equal(formatCents(BigInt(String(inv.payload.upb_cents)), { symbol: false }), "15,000.00");
  // FNMA_C1201_NIB_ORDER_GATE arms on `payment.received{designation=curtailment, non_interest_bearing_upb>0}` and its evaluator accepts only NIB-then-IB for amount ≥ IB UPB
  assert.equal(received.payload.non_interest_bearing_upb, 2_000_000); assert.equal(received.payload.interest_bearing_upb_cents, "1500000");
  const gate = timers.byCode("FNMA_C1201_NIB_ORDER_GATE")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:2.4.nibOrder");
  const facts = { amount_cents: r.plan.curtailment_cents, interest_bearing_upb_cents: received.payload.interest_bearing_upb_cents, allocation_order: nibOrderOf(r.plan) };
  assert.equal(evaluateGate("2.4.nibOrder", facts).open, true); assert.match(evaluateGate("2.4.nibOrder", { ...facts, allocation_order: "ib_only" }).reason!, /≥ IB UPB requires nib_then_ib/);
});
test("2.4-T4: Given a loan with NIB 2,000,000¢ and IB UPB 1,500,000¢, when a 100,000¢ curtailment arrives, then IB UPB → 1,400,000¢ and NIB unchanged.", () => {
  const { r, state, received, applied, inv, timers } = curtailNib(100_000n);
  assert.equal(r.plan.curtailment_cents, 100_000n); assert.equal(r.plan.curtailment_nib_cents, 0n);
  assert.deepEqual(r.plan.allocations.filter((a) => a.bucket !== "suspense").map((a) => [a.bucket, a.amount_cents, a.rule_ref]), [["curtailment", 100_000n, "2.4:curtailment"]]);
  assert.equal(state().upb_cents, 1_400_000n); assert.equal(state().deferred_principal_cents, 2_000_000n);   // amount < IB UPB → all to IB; NIB unchanged
  assert.deepEqual([applied.payload.ib_applied_cents, applied.payload.nib_cents, applied.payload.upb_after_cents, applied.payload.nib_after_cents], ["100000", "0", "1400000", "2000000"]);
  assert.equal(formatCents(BigInt(String(inv.payload.upb_cents)), { symbol: false }), "14,000.00"); assert.equal(formatCents(BigInt(String(inv.payload.nib_cents)), { symbol: false }), "20,000.00");
  assert.equal(timers.byCode("FNMA_C1201_NIB_ORDER_GATE")[0]!.note, "evaluator:2.4.nibOrder");
  const facts = { amount_cents: r.plan.curtailment_cents, interest_bearing_upb_cents: received.payload.interest_bearing_upb_cents, allocation_order: nibOrderOf(r.plan) };
  assert.equal(evaluateGate("2.4.nibOrder", facts).open, true); assert.match(evaluateGate("2.4.nibOrder", { ...facts, allocation_order: "nib_then_ib" }).reason!, /< IB UPB requires ib_only/);
});
test('2.4-T5: Given two unpaid installments, when a "principal only" 300,000¢ check arrives, then one installment is satisfied, the remainder is held toward the next, no principal reduction occurs, and `CURTAIL-REDIRECT-v1` is sent.', () => {
  // worked example G: installments 2026-09-01 and 2026-10-01 unpaid; on 2026-10-20 a $3,000.00 check marked "principal only" arrives
  const { pay, state, events } = harness("2026-10-20T14:00:00.000Z", L1());
  const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.4"] });
  const r = pay(300_000n, "2026-10-20", { instrument: "check", designation: "curtailment", borrower_instruction_text: "principal only" });
  const received = events.ofType("payment.received")[0]!; assert.equal(received.payload.designation, "curtailment"); assert.equal(received.payload.delinquent, true);
  // A = 300,000¢, P = 219,257¢ → one installment (2026-09-01) satisfied with credited_as_of 2026-10-20; remainder 80,743¢ held toward 2026-10-01
  assert.deepEqual(split(r.plan), [{ due: "2026-09-01", interest: 135_294n, principal: 22_723n, escrow: 61_240n, upb_after: 24_954_677n }]);
  assert.equal(state().installments.find((i) => i.due_date === "2026-09-01")!.credited_as_of, "2026-10-20");
  assert.equal(state().installments.find((i) => i.due_date === "2026-10-01")!.status, "due");
  assert.equal(r.plan.curtailment_cents, 0n); assert.equal(r.plan.redirected_curtailment, true); assert.ok(r.plan.rule_path.includes("2.4:r3:redirected_to_cure"));
  assert.equal(r.plan.to_suspense_cents, 300_000n - 219_257n); assert.equal(state().suspense_unapplied_cents, 80_743n);
  assert.equal(state().upb_cents, 24_977_400n - 22_723n);                        // scheduled principal only — no principal reduction
  assert.equal(events.ofType("payment.curtailment.applied").length, 0);
  assert.deepEqual(events.ofType("investor_events.created").map((e) => e.payload.type), ["payment.contractual"]);   // no `payment.curtailment` event
  // FNMA_C1201_DELINQUENT_CURE_FIRST_GATE armed by `payment.received{designation=curtailment, delinquent=true}`; the 0-BD apply clock does not arm on a delinquent loan
  const gate = engine.byCode("FNMA_C1201_DELINQUENT_CURE_FIRST_GATE")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:2.4.dueInstallmentsFirst");
  assert.equal(engine.byCode("FNMA_C1201_CURTAILMENT_APPLY_IMMEDIATE_0BD").length, 0);
  assert.equal(evaluateGate("2.4.dueInstallmentsFirst", { curtailment_cents: r.plan.curtailment_cents, unpaid_installments_cents: unpaidCents(state()) }).open, true);
  assert.match(evaluateGate("2.4.dueInstallmentsFirst", { curtailment_cents: 80_743n, unpaid_installments_cents: unpaidCents(state()) }).reason!, /must satisfy due installments first \(C-1\.2-01\)/);   // curtailing the remainder would bypass the gate
  // `CURTAIL-REDIRECT-v1` goes out with the held amount and the C-1.2-01 explanation
  const q = events.ofType("notice.queued").find((e) => e.payload.template === "CURTAIL-REDIRECT-v1")!;
  assert.equal(q.payload.held_cents, "80743"); assert.equal(q.payload.citation, "Servicing Guide C-1.2-01");
  const v = notices().activeVersion("CURTAIL-REDIRECT-v1", D("2026-10-20"))!;
  const payload = { ...v.samplePayload, amount_cents: 300_000n, received_on: "2026-10-20", applied_to_installments_cents: 219_257n, installment_due_date: "2026-09-01", held_cents: BigInt(String(q.payload.held_cents)), principal_reduced_cents: r.plan.curtailment_cents };
  const out = render(v.source, payload); assert.match(out.text, /We applied \$2,192\.57 to your September 1, 2026 installment and are holding \$807\.43 toward your next payment\. Principal reduction resumes once your loan is current/);
  assert.equal(evaluateChecklist(v, payload, out).passed, true);
});
test("2.4-T6: Given an MBS loan, when a reapplication of prepayments to cure delinquency is requested, then the gate refuses and a 12.x workout evaluation is suggested.", () => {
  const clock = new FixedClock("2026-10-20T15:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.4"] });
  const ops = new CashieringOps24({ events, clock });
  // an MBS pool loan two installments behind (2026-09-01, 2026-10-01) after a prior 100,000¢ curtailment; scheduled balance 24,954,677¢
  const req = { requested_on: D("2026-10-20"), original_curtailment_event_ids: ["evt-curtailment-2026-09-03"], prior_curtailments_cents: 100_000n, scheduled_balance_cents: 24_954_677n, delinquency_cents: 438_514n, maf_funds_received: false, borrower_supplement_agreed: true };
  const mbs = L1({ mbs_pool: true, remittance_type: "S/S", upb_cents: 24_854_677n });
  const res = ops.requestReapplication(mbs, req);
  assert.equal(res.ok, false);
  if (!res.ok) { assert.equal(res.suggest, "12.x_workout"); assert.deepEqual(res.failed, ["portfolio_or_nonmbs_participation"]); assert.match(res.reason, /MBS loans are ineligible/); }
  assert.deepEqual(res.eligibility, { portfolio_or_nonmbs_participation: false, balance_not_higher_than_schedule: true, no_maf_funds: true, borrower_supplement_agreed: true });
  // `curtailment.reapplication.requested` arms FNMA_C1201_REAPPLY_ELIGIBILITY_GATE; its evaluator reads the four C-1.2-01 conditions off the event and closes on the MBS one
  const requested = events.ofType("curtailment.reapplication.requested")[0]!;
  assert.equal(requested.payload.mbs_pool, true); assert.equal(requested.payload.portfolio_or_nonmbs_participation, false); assert.equal(requested.payload.amount_requested_cents, "100000");
  const gate = timers.byCode("FNMA_C1201_REAPPLY_ELIGIBILITY_GATE")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:2.4.reapplyEligible"); assert.equal(gate.armedByEventId, requested.id);
  const g = evaluateGate("2.4.reapplyEligible", requested.payload); assert.equal(g.open, false); assert.match(g.reason!, /portfolio_or_nonmbs_participation not satisfied/);
  assert.equal(reapplicationGate(mbs).ok, false);
  // the decision record carries the four tests and points to the 12.x workout path; the refusal event is emitted; nothing is reapplied
  const decision = events.ofType("agent.decision").find((e) => e.payload.action === "reapplication_evaluated")!;
  assert.deepEqual([decision.payload.outcome, decision.payload.suggest, decision.payload.failed, decision.payload.gate], ["refused", "12.x_workout", ["portfolio_or_nonmbs_participation"], "FNMA_C1201_REAPPLY_ELIGIBILITY_GATE"]);
  assert.match(String(decision.payload.cite), /C-1\.2-01/);
  const refused = events.ofType("curtailment.reapplication.refused")[0]!; assert.equal(refused.payload.suggest, "12.x_workout"); assert.equal(refused.payload.decision_id, decision.payload.decision_id);
  assert.equal(events.ofType("curtailment.reapplied").length, 0); assert.equal(events.ofType("curtailment_reapplications.created").length, 0);
  // contrast: the same request on a portfolio loan passes all four conditions; reapplied = min(100,000, 24,954,677 − 24,854,677, 438,514) = 100,000¢, each prior curtailment reversed and re-reported
  const portfolio = L1({ mbs_pool: false, remittance_type: "A/A", upb_cents: 24_854_677n });
  const okRes = ops.requestReapplication(portfolio, req);
  assert.equal(okRes.ok, true);
  if (okRes.ok) assert.equal(okRes.amount_reapplied_cents, 100_000n);
  assert.equal(reapplyAmount(100_000n, 24_954_677n, 24_854_677n, 438_514n), 100_000n); assert.equal(reapplyAmount(500_000n, 24_954_677n, 24_854_677n, 438_514n), 100_000n);   // capped by the schedule
  assert.equal(evaluateGate("2.4.reapplyEligible", events.ofType("curtailment.reapplication.requested")[1]!.payload).open, true);
  const reapplied = events.ofType("curtailment.reapplied")[0]!; assert.equal(reapplied.payload.amount_reapplied_cents, "100000"); assert.equal(reapplied.payload.correction, "reversal_plus_rereport");
  assert.deepEqual(events.ofType("investor_events.created").map((e) => [e.payload.type, e.payload.reverses_event_id]), [["payment.reversal", "evt-curtailment-2026-09-03"]]);
  assert.throws(() => ops.requestReapplication(portfolio, { ...req, original_curtailment_event_ids: [] }), RangeError);
});
test("2.4-T7: Given a re-amortization executed 2026-10-20 effective 2026-12-01, then a new `loan_terms` version exists, Form 181 is delivered to the custodian within 10 BD, LAR 83/`rate_payment.change` is submitted within 5 BD of the calculation date, and 12.8's eligibility check does not count it as a modification.", () => {
  const clock = new FixedClock("2026-10-20T15:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.4"] });
  const ops = new CashieringOps({ events, clock });
  const s = L1({ upb_cents: 19_854_677n }, D("2026-11-01"), 3);
  const re = reamortize(s, 346, D("2026-10-20")); assert.equal(re.effective_on, "2026-12-01"); assert.equal(re.new_pi_cents, 127_162n);
  const { reamortization_id } = ops.executeReamortization(s, re, { borrower_execution_required: false, signing_officer: "u-signing" });
  const f181 = timers.byCode("SM_REAMORT_FORM181_DELIVERY_10BD")[0]!; assert.equal(f181.dueDate, "2026-11-03"); assert.equal(f181.status, "armed");   // 10 servicer BD after 2026-10-20
  // the new loan_terms version: P&I 127,162¢ for installments due on/after 2026-12-01, the November installment unchanged
  const act = ops.activateReamortizedTerms(s, re, reamortization_id, D("2026-10-20"));
  assert.equal(act.loan_terms_version, 2); assert.equal(act.state.loan_terms_version, 2);
  assert.equal(act.state.installments.find((i) => i.due_date === "2026-12-01")!.pi_cents, 127_162n); assert.equal(act.state.installments.find((i) => i.due_date === "2026-11-01")!.pi_cents, 158_017n);
  assert.equal(events.ofType("loan_terms.activated")[0]!.payload.reason, "reamortization");
  // LAR 83 / rate_payment.change: emitted here, submitted by 5.1 within 5 fannie_et BD of the calculation date (20:00 ET 2026-10-27)
  const lar = timers.byCode("FNMA_IRM_LAR83_5BD_2000")[0]!; assert.equal(lar.dueDate, "2026-10-27"); assert.equal(act.lar83_due_by, "2026-10-27");
  const inv = events.ofType("investor_events.created").find((x) => x.payload.type === "rate_payment.change")!; assert.deepEqual(inv.payload.lar_codes, ["83"]); assert.equal(inv.payload.new_pi_cents, "127162");
  clock.set("2026-10-22T15:00:00.000Z"); events.append({ type: "investor_events.submitted", loanId: "L-1", actor: SYSTEM, causationId: inv.id, payload: { event_type: "rate_payment.change", type: "rate_payment.change", lar: "83", submitted_at: clock.now() } });   // 5.1's submission event (its timers.ts owns the row)
  assert.equal(lar.status, "satisfied");
  // Form 181 delivered to the custodian on 2026-10-28 (6 BD) closes the delivery clock
  clock.set("2026-10-28T15:00:00.000Z"); ops.recordForm181Delivery("L-1", reamortization_id, { delivered_on: D("2026-10-28"), custodian_id: "CUST-1", document_id: "doc-181" });
  assert.equal(f181.status, "satisfied"); assert.equal(events.ofType("custodian.delivery.evidenced")[0]!.payload.document, "form_181");
  // 12.8 reads `reamortizations`, not `modifications`
  assert.equal(re.counts_as_modification, false); assert.equal(events.ofType("reamortizations.executed")[0]!.payload.counts_as_modification, false); assert.equal(re.form, "181");
});
test("2.4-T8: Given an autodraft borrower re-amortized effective 2026-12-01, when `REAMORT-EFFECTIVE-v1` is sent 2026-11-10, then the Reg E 10-day notice timer is satisfied and the December draft uses the new amount.", () => {
  const clock = new FixedClock("2026-10-20T15:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.3", "2.4"] });
  const ops = new CashieringOps({ events, clock });
  // worked example H: a $50,000.00 curtailment received separately on the current loan (UPB 24,854,677¢ after example F) leaves 19,854,677¢
  const cur = applyCurtailment(L1({ upb_cents: 24_854_677n }, D("2026-11-01"), 3), 5_000_000n, D("2026-10-20"));
  assert.equal(cur.curtailment_cents, 5_000_000n); assert.equal(cur.upb_after_cents, 19_854_677n);
  const re = reamortize(cur.state, 346, D("2026-10-20"));
  assert.equal(re.new_pi_cents, 127_162n);                                     // $1,271.62
  assert.equal(re.effective_on, "2026-12-01");
  const e = newEnrollment("L-1", AUTH, 1); e.status = "active"; e.validation_status = "validated"; e.last_debit_cents = 219_257n;
  const newAmount = draftAmount(e, re.new_pi_cents + 61_240n, 0n); assert.equal(newAmount, 188_402n);   // 2.3 rule 4: new P&I + unchanged escrow
  const { reamortization_id } = ops.executeReamortization(cur.state, re, { borrower_execution_required: false, signing_officer: "u-signing" });
  ops.activateReamortizedTerms(cur.state, re, reamortization_id, D("2026-10-20"), D("2026-12-01"));
  const regE = timers.byCode("REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10")[0]!; assert.equal(regE.dueDate, "2026-11-21"); assert.equal(regE.status, "armed");   // −10 days before the 2026-12-01 debit
  const before = variableAmountNoticeStatus(e, newAmount, D("2026-12-01"), D("2026-11-10"));
  assert.equal(before.ok, false);
  clock.set("2026-11-10T15:00:00.000Z"); ops.sendVariableAmountNotice(e, newAmount, D("2026-12-01"), D("2026-11-10"), "REAMORT-EFFECTIVE-v1");
  assert.equal(regE.status, "satisfied");                                      // `notice.sent{kind=variable_amount_10d}` on 11-10 (deadline 11-21)
  const after = variableAmountNoticeStatus(e, newAmount, D("2026-12-01"), D("2026-11-20"));
  assert.deepEqual(after, { ok: true, satisfied_by: "REAMORT-EFFECTIVE-v1" });   // Reg E §1005.10(d) 10-day notice satisfied (deadline 11-21)
  assert.equal(draftAmount(e, re.new_pi_cents + 61_240n, 0n), 188_402n);      // the December draft uses the new amount
  assert.equal(ops.scheduleEntry(e, D("2026-12-01"), D("2026-12-01"), newAmount, { today: D("2026-11-25") }).ok, true);
  // the authored REAMORT-EFFECTIVE-v1 carries the exact debit amount and date ≥ 10 days ahead (Reg E §1005.10(d)(1))
  const reg = new NoticeRegistry(); publishSection02(reg); const v = reg.activeVersion("REAMORT-EFFECTIVE-v1", D("2026-11-10"))!;
  const payload = { ...v.samplePayload, new_total_payment_cents: newAmount, check_total_cents: re.new_pi_cents + 61_240n, new_pi_cents: re.new_pi_cents, next_debit_on: "2026-12-01", days_before_debit: 21 };
  const r = render(v.source, payload); assert.match(r.text, /\$1,884\.02 will be drafted on December 1, 2026/); assert.equal(evaluateChecklist(v, payload, r).passed, true);
  const late = { ...payload, days_before_debit: 9 }; assert.ok(evaluateChecklist(v, late, render(v.source, late)).blocking.some((b) => b.rule_id === "reg-e-ten-days"));
});
test("2.4-T9: Given a curtailment check returned NSF after posting, when reversed, then UPB/LPI restore, the investor reversal references the curtailment event, and the October interest is recomputed on the restored balance.", () => {
  const { pay, svc, state, events, clock } = harness("2026-09-03T14:00:00.000Z", L1());
  const r = pay(319_257n, "2026-09-03", { instrument: "check", curtailment_cents: 100_000n });
  assert.equal(r.plan.curtailment_cents, 100_000n); assert.equal(state().upb_cents, 24_854_677n);
  const curtailmentInv = events.ofType("investor_events.created").find((e) => e.payload.type === "payment.curtailment")!;
  clock.set("2026-09-08T14:00:00.000Z");
  svc.reverse(r.payment.id, "returned_item", { return_code: "R01" });
  assert.equal(state().upb_cents, 24_977_400n); assert.equal(state().lpi_date, "2026-08-01");   // UPB/LPI restored
  const reversals = events.ofType("investor_events.created").filter((e) => e.payload.type === "payment.reversal");
  assert.ok(reversals.some((e) => e.payload.reverses_event_id === curtailmentInv.id));          // references the curtailment event
  assert.deepEqual(nextInstallmentSplit(state(), 158_017n), { interest_cents: 135_294n, principal_cents: 22_723n });   // interest recomputed on the restored balance
});
test("2.4-T10: Given a designated curtailment equal to the full payoff amount, when received, then it is routed to 16.x and no curtailment event is emitted.", () => {
  // L-1 current after the September installment (UPB 24,954,677¢, LPI 2026-09-01); on 2026-09-10 a wire designated "additional principal"
  // arrives for the 16.x payoff figure: UPB + 9 days' per-diem interest (24,954,677 × 0.065 ÷ 365 × 9 = 39,995.85 → 39,996¢) = 24,994,673¢
  const { pay, state, events } = harness("2026-09-10T14:00:00.000Z", L1({ upb_cents: 24_954_677n, lpi_date: D("2026-09-01") }, D("2026-10-01"), 3));
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.4"] });
  const payoff = 24_954_677n + 39_996n;
  const r = pay(payoff, "2026-09-10", { instrument: "wire", designation: "curtailment" });
  const received = events.ofType("payment.received")[0]!;
  assert.equal(received.payload.designation, "curtailment"); assert.equal(received.payload.delinquent, false); assert.equal(received.payload.interest_bearing_upb_cents, "24954677"); assert.equal(received.payload.non_interest_bearing_upb, 0);
  // SM_CURTAILMENT_PAYOFF_ROUTE_GATE: amount ≥ interest-bearing UPB + NIB → route to payoff (16.1/16.2) instead of curtailment
  assert.equal(r.plan.outcome, "payoff_routed"); assert.ok(r.plan.rule_path.includes("2.4:payoff_route_gate→16.x"));
  assert.equal(r.plan.curtailment_cents, 0n); assert.equal(r.plan.installments.length, 0);
  assert.equal(state().upb_cents, 24_954_677n); assert.equal(state().lpi_date, "2026-09-01"); assert.equal(state().installments.find((i) => i.due_date === "2026-10-01")!.status, "due");   // nothing applied
  const routed = events.ofType("payment.payoff_routed")[0]!;
  assert.deepEqual([routed.payload.route, routed.payload.designation, routed.payload.amount_cents, routed.payload.curtailment_applied], ["16.2", "curtailment", payoff.toString(), false]);
  assert.match(String(routed.payload.reason), /SM_CURTAILMENT_PAYOFF_ROUTE_GATE/);
  // no curtailment event of any kind: no `payment.curtailment.applied`, no `payment.curtailment` investor event, no CURTAIL-CONFIRM-v1
  assert.equal(events.ofType("payment.curtailment.applied").length, 0);
  assert.equal(events.ofType("investor_events.created").length, 0);
  assert.equal(events.ofType("notice.queued").filter((e) => e.payload.template === "CURTAIL-CONFIRM-v1").length, 0);
  // the gate arms on `payment.received{designation=curtailment}` and its evaluator closes on the receipt's own facts
  const gate = timers.byCode("SM_CURTAILMENT_PAYOFF_ROUTE_GATE")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:2.4.routeToPayoff"); assert.equal(gate.armedByEventId, received.id);
  const facts = { amount_cents: received.payload.amount_cents, interest_bearing_upb_cents: received.payload.interest_bearing_upb_cents, nib_cents: String(received.payload.non_interest_bearing_upb) };
  const g = evaluateGate("2.4.routeToPayoff", facts); assert.equal(g.open, false); assert.match(g.reason!, /route to payoff \(16\.1\/16\.2\)/);
  assert.equal(evaluateGate("2.4.routeToPayoff", { ...facts, amount_cents: payoff - 39_996n - 1n }).open, true);   // one cent under the IB UPB + NIB threshold curtails
  // the 0-BD apply clock armed on receipt is closed by the route (no curtailment will ever satisfy it), not left to breach
  const t0 = timers.byCode("FNMA_C1201_CURTAILMENT_APPLY_IMMEDIATE_0BD")[0]!; assert.equal(t0.status, "armed");
  timers.cancel(t0.id, "routed to payoff (16.x): SM_CURTAILMENT_PAYOFF_ROUTE_GATE", AGENT);
  assert.equal(t0.status, "cancelled"); assert.match(t0.cancelledReason!, /16\.x/);
});
