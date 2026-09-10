// 2.6 Payment during modification pending (trial period)
// spec/sections/02-payment-processing-cashiering/2-6-payment-during-modification-pending-trial-period.md
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
import { newTrial, trialReceipt, trialReturn, trialMonthEnd, trialStatementDisclosure } from "./trial.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { CommandBus } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { FakeFnmaSmdu } from "../../infra/integrations/fnma.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";

// 2.6-T1 — implemented in src/domain/cashiering/section2.test.ts
// 2.6-T2 — implemented in src/domain/cashiering/section2.test.ts
// 2.6-T3 — implemented in src/domain/cashiering/section2.test.ts
// 2.6-T4 — implemented in src/domain/cashiering/section2.test.ts
test("2.6-T5: Given a trial receipt on a loan whose statement cycle closes the next day, when 7.1 renders, then held trial funds are disclosed with instructions.", () => {
  const trial = newTrial("SMDU-1", "L-1", [{ due_on: D("2026-10-01"), amount_cents: 195_900n }, { due_on: D("2026-11-01"), amount_cents: 195_900n }]);
  trialReceipt(trial, L1({ trial_active: true }), 100_000n, D("2026-10-16"));      // statement cycle closes 10-17
  const d = trialStatementDisclosure(trial);
  assert.equal(d.suspense_held_cents, 100_000n); assert.match(d.suspense_instructions, /holding 100000 cents .* We need 95900 cents more to satisfy the trial payment due 2026-10-01/);
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGZ_41_STMT_TPP", D("2026-10-17")) ?? reg.activeVersion("NTC_REGZ_41_STMT_STD", D("2026-10-17"))!;
  const payload = { ...v.samplePayload, ytd: { total_cents: 100_000n, suspense_held_cents: d.suspense_held_cents }, payments_since_last: { total_cents: 100_000n, principal_cents: 0n, interest_cents: 0n, escrow_cents: 0n, fees_cents: 0n, suspense_cents: 100_000n }, suspense_instructions: d.suspense_instructions };
  const r = render(v.source, payload);
  assert.match(r.text, /holding 100000 cents/); assert.equal(evaluateChecklist(v, payload, r).passed, true);
});
test("2.6-T6: Given SMDU B2B is unavailable, when a trial payment is received, then a `human_portal_task` with the full package is created and its SLA timer is the same 1 BD.", async () => {
  const clock = new FixedClock("2026-10-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const ctx: UowContext = { loanId: "L-1", events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} };
  const smdu = new FakeFnmaSmdu(); smdu.controls.setOutage(true);
  const escalations = new EscalationService(events, clock);
  const agents = new AgentRegistry(); const cmds = bindTools({ store: new EntityStore(), ports: { smdu }, escalations, services: {} }, agents); const bus = new CommandBus(agents);
  const r = await bus.execute(cmds.get(toolKey("2.6", "smdu.submit_trial_payment"))!, AGENT, { case_id: "SMDU-1", due_date: "2026-10-01", received_on: "2026-10-01", amount_cents: 195_900n }, ctx);
  const out = r.output as { portal_task_id: string; fallback: string };
  assert.equal(out.fallback, "SMDU UI");
  const task = escalations.opened.find((e) => e.id === out.portal_task_id)!;
  assert.equal(task.kind, "human_portal_task"); assert.deepEqual(task.payload.package, { case_id: "SMDU-1", due_date: "2026-10-01", received_on: "2026-10-01", amount_cents: "195900" });
  assert.equal(task.payload.sla, "1 business_days_fannie_et");
  const def = loadOverriddenRegistry().get("FNMA_F122_TRIAL_PAYMENT_SMDU_REPORT_1BD")!;               // the same 1 BD SLA either way
  assert.match(def.offset, /1 `?business_days_fannie_et`?/); assert.equal(def.satisfiedPattern!.type, "smdu.trial_payment.reported");
});
test("2.6-T7: Given a returned trial payment on 2026-11-20, when processed, then `received_cents` for November decreases, the borrower is contacted the same day, and a replacement received 2026-11-30 satisfies the month.", () => {
  const trial = newTrial("SMDU-1", "L-1", [{ due_on: D("2026-10-01"), amount_cents: 195_900n }, { due_on: D("2026-11-01"), amount_cents: 195_900n }, { due_on: D("2026-12-01"), amount_cents: 195_900n }]);
  const s = L1({ trial_active: true, lpi_date: D("2026-06-01") }, D("2026-07-01"), 6);
  trialReceipt(trial, s, 195_900n, D("2026-10-01"));
  let r = trialReceipt(trial, s, 195_900n, D("2026-11-02")); assert.equal(r.trial_month!.status, "satisfied");
  const ret = trialReturn(trial, 195_900n, D("2026-11-20"));
  assert.equal(ret.trial_month!.received_cents, 0n); assert.equal(ret.trial_month!.status, "pending"); assert.equal(ret.contact_borrower_on, "2026-11-20"); assert.equal(ret.month_short_cents, 195_900n);
  r = trialReceipt(trial, r.state, 195_900n, D("2026-11-30")); assert.equal(r.trial_month!.status, "satisfied");
  assert.deepEqual(trialMonthEnd(trial, D("2026-11-30")), { missed: null, failed: false });
});
// 2.6-T8 — implemented in src/domain/cashiering/section2.test.ts
