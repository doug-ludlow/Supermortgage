/** Seeded in-memory scenario for `npm run console -- --demo` and the UI screenshot. */
import { MemoryConsoleStore } from "../src/console/memory-store.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../src/kernel/events/index.ts";
import { MemoryLedger } from "../src/kernel/ledger/ledger.ts";
import { TimerEngine } from "../src/kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../src/domain/timer-overrides.ts";
import { EscalationService } from "../src/app/escalations.ts";
import { AgentRegistry } from "../src/app/agents.ts";
import { MemoryOutbox, MemoryPortalTasks, Dispatcher } from "../src/infra/integrations/outbox.ts";
import { FakeFnmaLsdu, LsduOutboundAdapter } from "../src/infra/integrations/fnma.ts";
import { FakePrintMail, FakeEdelivery } from "../src/infra/integrations/delivery.ts";
import { NoticeService } from "../src/notices/service.ts";
import { buildRegistry, publishAuthored } from "../src/notices/catalog.ts";
import { CashieringService } from "../src/domain/cashiering/service.ts";
import { plainDate as D, addMonths } from "../src/kernel/calendar/date.ts";
import type { LoanCashState } from "../src/domain/cashiering/types.ts";

export async function demoStore(): Promise<MemoryConsoleStore> {
  const L1 = "8c2f6e0a-1b1e-4c0e-9a6b-000000000001", L2 = "8c2f6e0a-1b1e-4c0e-9a6b-000000000002";
  const clock = new FixedClock("2026-09-03T14:00:00.000Z");
  const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const registry = loadOverriddenRegistry();
  const timers = new TimerEngine(registry, events, { processes: ["2.1", "2.7", "7.1", "11.2", "9.2"] });
  const escalations = new EscalationService(events, clock); const agents = new AgentRegistry();
  const outbox = new MemoryOutbox(); const portalTasks = new MemoryPortalTasks();
  const noticeReg = buildRegistry(); publishAuthored(noticeReg);
  const pm = new FakePrintMail();
  const notices = new NoticeService({ registry: noticeReg, events, clock, printMail: pm, edelivery: new FakeEdelivery() });
  const decisions: (import("../src/infra/db/decisions.ts").DecisionInput & { id: string; createdAt: string })[] = [];
  const loanState = (id: string): LoanCashState => ({ loan_id: id, instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: 24_977_400n, lpi_date: D("2026-08-01"),
    installments: Array.from({ length: 4 }, (_, i) => ({ due_date: addMonths(D("2026-09-01"), i), pi_cents: 158_017n, escrow_cents: 61_240n, status: "due" as const })), late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false });
  const store = new Map([[L1, loanState(L1)], [L2, loanState(L2)]]);
  const svc = new CashieringService({ events, ledger, clock, custodial: { clearing: "C-CL", pi: "C-PI", ti: "C-TI" }, loans: { get: (id) => store.get(id), put: (s) => { store.set(s.loan_id, s); } } });
  const { payment } = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n, received_at: clock.now(), settlement_date: D("2026-09-03"), loan_id: L1, trace_number: "PPD-1" });
  svc.identify(payment.id, L1); svc.post(payment.id);
  decisions.push({ id: "d1", agent: "cashiering", action: "payment.post:applied", ruleCode: "F-1-09:order_1999plus:interest", ruleSetVersion: "2.1@1", rationale: "conforming autodraft applied to the 2026-09-01 installment", loanId: L1, createdAt: clock.now(), confidence: 0.99, modelVersion: "claude-fable-5-1", promptVersion: "cashiering@7" });
  // L2: delinquent — EI window opened in August, notice not sent → breached on Oct 17
  clock.set("2026-08-02T05:00:00.000Z");
  events.append({ type: "loan.delinquency.window_opened", loanId: L2, actor: SYSTEM, payload: { due_date: "2026-08-01", principal_residence: true } });
  events.append({ type: "statement.cycle.opened", loanId: L2, actor: SYSTEM, payload: { due_date: "2026-09-01" } });
  clock.set("2026-10-17T05:00:00.000Z");
  timers.evaluate(clock.now());
  const v = noticeReg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))!;
  notices.render({ templateCode: "NTC_REGZ_41_STMT_DELQ", loanId: L2, recipients: [{ partyId: "B", name: "Bea Borrower", mailingAddress: "1 Test St, Testville TX" }], payload: { ...v.samplePayload, delinquency: null }, asOf: D("2026-10-17") });
  const sent = notices.render({ templateCode: "NTC_REGZ_41_STMT_STD", loanId: L1, recipients: [{ partyId: "A", name: "Al Borrower", mailingAddress: "2 Test St, Testville TX" }], payload: noticeReg.activeVersion("NTC_REGZ_41_STMT_STD", D("2026-10-17"))!.samplePayload, asOf: D("2026-10-17") });
  await notices.send(sent.id);
  const fo: Actor = { kind: "agent", id: "foreclosure-ops" };
  escalations.open({ kind: "officer", loanId: L2, severity: "sev-2", payload: { command: "cashiering.writeOff", amount_cents: "1200", why: "shortage below $500 needs officer approval (16.2)" } }, { kind: "agent", id: "cashiering" });
  escalations.open({ kind: "attorney", loanId: L2, severity: "sev-1", payload: { command: "foreclosure.referral", why: "firm proposes a non-preferred method (13.5)" } }, fo);
  escalations.open({ kind: "lossmit_reviewer", loanId: L2, payload: { command: "lossmit.denial", why: "adverse determination needs reviewer (12.6)" } }, { kind: "agent", id: "lossmit-underwriter" });
  const lsdu = new FakeFnmaLsdu(); lsdu.controls.setOutage(true);
  const { message } = await outbox.enqueue({ adapter: "fnma-lsdu", idempotencyKey: "S1|L1|payment.contractual|2026-09-01|1", payload: [], loanId: L1, payloadSummary: { records: 1 } }, clock.now());
  await new Dispatcher(outbox, portalTasks).deliver(new LsduOutboundAdapter(lsdu), message, clock.now());
  await portalTasks.open({ kind: "crs_batch_upload", adapter: "fnma-crs", package: { files: ["CRS_123456789_2026-10-18_1.txt"], lines: 412, cutoff: "16:00 ET" }, dueAt: "2026-10-17T20:00:00.000Z" }, clock.now());
  agents.setAiOff("bankruptcy-ops", "counsel review of docket classifier (18.1)");
  return new MemoryConsoleStore({ events, ledger, timers, registry, escalations, portalTasks, outbox, notices, agents, decisions,
    loans: [{ id: L1, fnmaLoanNumber: "1234567890", servicerLoanNumber: "SM-000001", status: "active", boardedAt: "2026-08-01T00:00:00.000Z" }, { id: L2, fnmaLoanNumber: "2345678901", servicerLoanNumber: "SM-000002", status: "active", boardedAt: "2026-08-01T00:00:00.000Z" }] });
}
