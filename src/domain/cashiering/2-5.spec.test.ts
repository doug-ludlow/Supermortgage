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
import { newArrangement, lateChargeExplanation, contractorProgramAnswer, NON_ENDORSEMENT_STATEMENT, FREE_INHOUSE_OPTION, THIRDPARTY_INFO_TEMPLATE } from "./biweekly.ts";
import { assessLateCharge } from "./latecharges.ts";

// 2.5-T1 — implemented in src/domain/cashiering/section2.test.ts
// 2.5-T2 — implemented in src/domain/cashiering/section2.test.ts
// 2.5-T3 — implemented in src/domain/cashiering/section2.test.ts
test("2.5-T4: Given a contractor remittance settling 2026-10-20 for the 2026-10-01 installment, when 2.7 runs 2026-10-17, then a late charge is assessed and `THIRDPARTY-BIWEEKLY-INFO-v1` context is referenced in any borrower explanation.", () => {
  const a = newArrangement("L-1", "contractor-co");
  const oct = L1({ lpi_date: D("2026-09-01") }, D("2026-10-01"), 3);
  const r = assessLateCharge({ state: oct, installment_due_date: D("2026-10-01"), received_toward_basis_cents: 0n, run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(r.outcome, "assessed"); if (r.outcome !== "assessed") return;
  assert.equal(r.fee.amount_cents, 7_901n); assert.equal(r.grace_end_on, "2026-10-16");
  const x = lateChargeExplanation(a, { amount_cents: r.fee.amount_cents, installment_due_date: D("2026-10-01"), grace_end_on: r.grace_end_on }, D("2026-10-20"));
  assert.equal(x.context_template, THIRDPARTY_INFO_TEMPLATE); assert.match(x.text, /THIRDPARTY-BIWEEKLY-INFO-v1/); assert.match(x.text, /settled 2026-10-20, after the grace period ended 2026-10-16/);
});
// 2.5-T5 — implemented in src/domain/cashiering/section2.test.ts
// 2.5-T6 — implemented in src/domain/cashiering/section2.test.ts
test("2.5-T7: Given a borrower asks the voice agent about a contractor's program, when answered, then the transcript shows the non-endorsement statement and the free in-house option.", () => {
  const ans = contractorProgramAnswer("Is the biweekly program from XYZ worth it?", { contractor_fee_cents: 39_500n });
  assert.ok(ans.transcript.includes(`A: ${NON_ENDORSEMENT_STATEMENT}`)); assert.ok(ans.transcript.includes(`A: ${FREE_INHOUSE_OPTION}`));
  assert.equal(ans.non_endorsement, true); assert.equal(ans.free_inhouse_option, true);
  assert.ok(!ans.transcript.some((l) => /recommend|we endorse/i.test(l)));
});
