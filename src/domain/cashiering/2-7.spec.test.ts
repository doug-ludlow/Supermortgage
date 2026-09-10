// 2.7 Late charge assessment
// spec/sections/02-payment-processing-cashiering/2-7-late-charge-assessment.md
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
import { lateChargeTerms, collectedForPeriod } from "./latecharges.ts";
import type { Fee } from "./types.ts";

// 2.7-T1 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T2 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T3 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T4 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T5 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T6 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T7 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T8 — implemented in src/domain/cashiering/section2.test.ts
test("2.7-T9: Given a note with 4% and 10-day grace boarded in a state capping at 5%/15 days, then the loan's terms (4%/10) apply; given a note with 5%/15 in a state capping at 4%/\u2026 **[UNVERIFIED state]**, then boarding flags the conflict and the lower cap is applied.", () => {
  assert.deepEqual(lateChargeTerms({ pct: "4", grace_days: 10 }, { max_pct: "5", min_grace_days: 15, state: "TX" }), { pct: "4", grace_days: 10, conflict: null });
  const c = lateChargeTerms({ pct: "5", grace_days: 15 }, { max_pct: "4", min_grace_days: 15, state: "XX" });
  assert.equal(c.pct, "4"); assert.equal(c.grace_days, 15); assert.equal(c.conflict!.applied, "lower_cap"); assert.equal(c.conflict!.state, "XX");
  assert.equal(lateChargeTerms({ pct: "5", grace_days: 15 }, null).conflict, null);
});
// 2.7-T10 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T11 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T12 — implemented in src/domain/cashiering/section2.test.ts
test("2.7-T13: Given late charges collected in September, when 5.1 builds the period's LAR/event, then `fees.collected` equals \u03a3 `collected_cents` for the period.", () => {
  const fee = (id: string, on: string, amt: bigint): Fee => ({ id, fee_type: "late_charge", installment_due_date: D("2026-08-01"), amount_cents: amt, state: "collected", assessed_on: D("2026-08-17"), collected_cents: amt, collected_on: D(on) });
  const fees = [fee("a", "2026-09-05", 7_901n), fee("b", "2026-09-28", 7_901n), fee("c", "2026-10-02", 7_901n), { ...fee("d", "2026-09-10", 2_500n), fee_type: "nsf_fee" as const }];
  assert.equal(collectedForPeriod(fees, "2026-09"), 15_802n);                     // Σ collected_cents for September's LAR/event `fees.collected`
  assert.equal(collectedForPeriod(fees, "2026-10"), 7_901n);
});
