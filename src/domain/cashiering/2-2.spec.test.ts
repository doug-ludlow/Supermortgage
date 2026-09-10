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

// 2.2-T1 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T2 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T3 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T4 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T5 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T6 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T7 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T8 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T9 — implemented in src/domain/cashiering/section2.test.ts
test("2.2-T10: Given any period end with \u03a3 unapplied > 0, when 7.1 renders the statement, then the (d)(3) amount and (d)(5) instruction text are present (template checklist passes).", () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGZ_41_STMT_STD", D("2026-10-17"))!;
  const payload = { ...v.samplePayload };                                        // Σ unapplied = $1,500.00 at period end
  const r = render(v.source, payload);
  assert.match(r.text, /Payments received since last statement: \$1,500\.00 .*unapplied \$1,500\.00/);   // (d)(3)
  assert.match(r.text, /We received \$1,500\.00, which is being held\. We need \$1,446\.79 more to apply a full payment\./);   // (d)(5)
  const c = evaluateChecklist(v, payload, r); assert.equal(c.passed, true);
  assert.ok(c.results.some((x) => x.rule_id === "d3-past-payments" && x.passed) && c.results.some((x) => x.rule_id === "d5-suspense" && x.passed));
  const without = { ...payload, suspense_instructions: null };
  assert.deepEqual(evaluateChecklist(v, without, render(v.source, without)).blocking.map((b) => b.rule_id), ["d5-suspense"]);
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
