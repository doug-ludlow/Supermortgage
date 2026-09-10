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
import { reamortize, nextInstallmentSplit } from "./curtailment.ts";
import { newEnrollment, variableAmountNoticeStatus, draftAmount, type Authorization } from "./autodraft.ts";
const AUTH: Authorization = { borrower_name: "B", loan_number_masked: "******1234", routing: "021000021", account_last4: "9876", account_type: "checking", amount_rule: "full_periodic_payment", variable_amount_statement: true, frequency: "monthly", first_debit_on: D("2026-10-01"), authorized_on: D("2026-09-20"), company_name: "SUPERMORTGAGE", revocation_instructions: true, optional_statement: true, esign_consent: true, sec: "WEB" };

// 2.4-T1 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T2 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T3 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T4 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T5 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T6 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T7 — implemented in src/domain/cashiering/section2.test.ts
test("2.4-T8: Given an autodraft borrower re-amortized effective 2026-12-01, when `REAMORT-EFFECTIVE-v1` is sent 2026-11-10, then the Reg E 10-day notice timer is satisfied and the December draft uses the new amount.", () => {
  const re = reamortize(L1({ upb_cents: 19_854_677n }), 346, D("2026-10-20"));   // worked example H
  assert.equal(re.new_pi_cents, 127_162n);                                     // $1,271.62
  assert.equal(re.effective_on, "2026-12-01");
  const e = newEnrollment("L-1", AUTH, 1); e.status = "active"; e.last_debit_cents = 219_257n;
  const newAmount = re.new_pi_cents + 61_240n;                                 // 188,402¢ with escrow unchanged
  const before = variableAmountNoticeStatus(e, newAmount, D("2026-12-01"), D("2026-11-10"));
  assert.equal(before.ok, false);
  e.notices.push({ template: "REAMORT-EFFECTIVE-v1", sent_on: D("2026-11-10"), amount_cents: newAmount, debit_on: D("2026-12-01") });
  const after = variableAmountNoticeStatus(e, newAmount, D("2026-12-01"), D("2026-11-20"));
  assert.deepEqual(after, { ok: true, satisfied_by: "REAMORT-EFFECTIVE-v1" });   // Reg E §1005.10(d) 10-day notice satisfied (deadline 11-21)
  assert.equal(draftAmount(e, newAmount, 0n), 188_402n);                       // the December draft uses the new amount
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
// 2.4-T10 — implemented in src/domain/cashiering/section2.test.ts
