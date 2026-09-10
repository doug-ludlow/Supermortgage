// 2.1 Accept & post periodic payment (P&I + escrow)
// spec/sections/02-payment-processing-cashiering/2-1-accept-post-periodic-payment-p-i-escrow.md
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
import { assessLateCharge } from "./latecharges.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { scheduledMonth } from "../investor/remittance.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { cashieringPostPayment } from "../../app/catalog.ts";
import { postingQueue } from "./queue.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";

// 2.1-T1 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T2 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T3 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T4 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T5 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T6 — implemented in src/domain/cashiering/cashiering.test.ts
test("2.1-T7: Given the posting sweep has an unposted item dated \u2264 Sep 16, when the 2.7 assessment job runs Sep 17, then it waits (gate) and no late charge is assessed until the item posts.", () => {
  const s = L1();
  const gated = assessLateCharge({ state: s, installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 1 });
  assert.equal(gated.outcome, "deferred_backlog"); assert.equal(gated.grace_end_on, "2026-09-16");
  assert.equal(evaluateGate("2.1.noPostingBacklog", { items_received_or_identified_on_or_before_gate: 1 }).open, false);   // SM_CASHIERING_POSTING_BACKLOG_GATE
  assert.equal(s.fees!.length, 0);
  const after = assessLateCharge({ state: s, installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(after.outcome, "assessed");
});
// 2.1-T8 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T9 — implemented in src/domain/cashiering/cashiering.test.ts
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
