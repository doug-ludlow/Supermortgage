/**
 * Database-backed acceptance tests. They run against TEST_DATABASE_URL
 * (default postgresql://sm:sm@localhost/supermortgage_test) with every
 * migration applied, and skip cleanly when no Postgres answers — `npm test`
 * must pass on a laptop without one; `npm run test:db` insists on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "./client.ts";
import { PgEventRepository } from "./events.ts";
import { PgLedgerRepository } from "./ledger.ts";
import { PgTimerRepository } from "./timers.ts";
import { PgDecisionRepository } from "./decisions.ts";
import { PgLoanRepository, type Fixture } from "./loans.ts";
import { PgUnitOfWork } from "./unit-of-work.ts";
import { SYSTEM, FixedClock, MemoryEventStore } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { plainDate as D, addMonths } from "../../kernel/calendar/date.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { CashieringService } from "../../domain/cashiering/service.ts";
import type { LoanCashState } from "../../domain/cashiering/types.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;

let db: Db;
let n = 0;
const uniq = () => `${Date.now() % 1_000_000}${(n++).toString().padStart(3, "0")}`.padStart(10, "0");

async function fixture(db: Db): Promise<Fixture> {
  return new PgLoanRepository(db).createFixture({ fnmaLoanNumber: uniq(), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 26_000_000n, originalTermMonths: 360, firstPaymentDate: D("2021-09-01"), maturityDate: D("2051-08-01") });
}

test("migrations: every file under db/migrations is applied to the test database (748 tables: public + restricted_fl)", { skip }, async () => {
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  const [m] = await db.query<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM schema_migrations`);
  assert.equal(m!.c, BigInt(readdirSync(fileURLToPath(new URL("../../../db/migrations", import.meta.url))).filter((f) => f.endsWith(".sql")).length));
  const [t] = await db.query<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM information_schema.tables WHERE table_schema IN ('public', 'restricted_fl') AND table_type = 'BASE TABLE'`);
  assert.equal(t!.c, 748n);   // the count a fresh `db/migrate.sh` run produces through 0118 (public + restricted_fl base tables; 0116 oidc_identities, 0117 lead_tokens, 0118 party_credentials)
});

test("loan_events is append-only: rows persist with database sequences and refuse UPDATE/DELETE", { skip }, async () => {
  const f = await fixture(db);
  const repo = new PgEventRepository(db);
  const persisted = await repo.append([
    { id: randomUUID(), type: "loan.boarded", occurredAt: "2026-09-10T15:00:00.000Z", loanId: f.loanId, actor: SYSTEM, payload: { escrowed: true }, sequence: 1 },
    { id: randomUUID(), type: "payment.received", occurredAt: "2026-09-11T15:00:00.000Z", loanId: f.loanId, actor: { kind: "agent", id: "cashiering" }, payload: { amount_cents: 219_257n }, sequence: 2 },
  ]);
  assert.ok(persisted[1]!.sequence > persisted[0]!.sequence);
  assert.equal(persisted[1]!.payload["amount_cents"], "219257", "bigint payloads serialize as strings");
  const back = await repo.byLoan(f.loanId);
  assert.deepEqual(back.map((e) => e.type), ["loan.boarded", "payment.received"]);
  await assert.rejects(db.query(`UPDATE loan_events SET type = 'x' WHERE id = $1`, [persisted[0]!.id]), /append-only/);
  await assert.rejects(db.query(`DELETE FROM loan_events WHERE id = $1`, [persisted[0]!.id]), /append-only/);
});

test("ledger: balanced sets post, balances read back in cents, an unbalanced set is refused at COMMIT, reversals net to zero", { skip }, async () => {
  const f = await fixture(db);
  const repo = new PgLedgerRepository(db);
  const mem = new MemoryLedger();
  const set = mem.post({ effectiveDate: D("2026-09-03"), description: "receipt", lines: [
    { account: { scope: "custodial", custodialAccountId: f.custodial.pi, account: "custodial_pi_cash" }, amountCents: 219_257n, ruleRef: "2.1:r8:cash_in" },
    { account: { scope: "loan", loanId: f.loanId, account: "suspense_unapplied" }, amountCents: -219_257n, ruleRef: "2.1:r8:suspense" },
  ] }, "2026-09-03T09:00:00.000Z");
  await db.tx((q) => repo.post(set, q));
  assert.equal(await repo.balance({ scope: "custodial", custodialAccountId: f.custodial.pi, account: "custodial_pi_cash" }), 219_257n);
  assert.equal(await repo.balance({ scope: "loan", loanId: f.loanId, account: "suspense_unapplied" }), -219_257n);
  assert.equal(await repo.balance({ scope: "loan", loanId: f.loanId, account: "suspense_unapplied" }, D("2026-09-02")), 0n);
  // The database re-asserts what MemoryLedger asserts: a set whose lines don't sum to zero cannot commit.
  const bad = { ...set, id: randomUUID(), lines: set.lines.map((l, i) => ({ ...l, id: randomUUID(), setId: "", amountCents: i === 0 ? 219_257n : -1n })) };
  await assert.rejects(db.tx((q) => repo.post({ ...bad, lines: bad.lines.map((l) => ({ ...l, setId: bad.id })) }, q)), /does not balance/);
  const rev = mem.reverse(set.id, D("2026-09-04"), "NSF R01", "2026-09-04T09:00:00.000Z");
  await db.tx((q) => repo.post(rev, q));
  assert.equal(await repo.balance({ scope: "loan", loanId: f.loanId, account: "suspense_unapplied" }), 0n);
  const sets = await repo.setsForLoan(f.loanId);
  assert.deepEqual(sets.map((s) => s.reversesSetId ?? null), [null, set.id]);
  await assert.rejects(db.query(`DELETE FROM ledger_lines WHERE set_id = $1`, [set.id]), /append-only/);
});

/** Fixture L-1 from 2.1 rule 11, keyed by the database loan id. */
function loanL1(loanId: string): LoanCashState {
  const installments = Array.from({ length: 4 }, (_, i) => ({ due_date: addMonths(D("2026-09-01"), i), pi_cents: 158_017n, escrow_cents: 61_240n, status: "due" as const }));
  return { loan_id: loanId, instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: 24_977_400n, lpi_date: D("2026-08-01"),
    installments, late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false };
}

test("2.1-T1 through the unit of work: one command persists events, balanced ledger sets, armed timers and a decision atomically; a second command hydrates them", { skip }, async () => {
  const f = await fixture(db);
  const uow = new PgUnitOfWork(db, loadOverriddenRegistry());
  const clock = new FixedClock("2026-09-03T09:00:00.000Z");
  const store = new Map<string, LoanCashState>([[f.loanId, loanL1(f.loanId)]]);
  const r1 = await uow.run(f.loanId, (ctx) => {
    const svc = new CashieringService({ events: ctx.events, ledger: ctx.ledger, clock: ctx.clock, custodial: f.custodial, loans: { get: (id) => store.get(id), put: (s) => { store.set(s.loan_id, s); } } });
    const { payment } = svc.receive({ channel: "ach_debit_origin", instrument: "ach", amount_cents: 219_257n, received_at: "2026-09-03T09:00:00.000Z", settlement_date: D("2026-09-03"), loan_id: f.loanId, trace_number: "PPD-1" });
    svc.identify(payment.id, f.loanId);
    const { plan } = svc.post(payment.id);
    ctx.decide({ agent: "cashiering", action: "payment.post", ruleCode: "F-1-09:order_1999plus", ruleSetVersion: "2.1@1", rationale: "conforming autodraft applied to the 2026-09-01 installment", confidence: 1 });
    return plan;
  }, { clock, timerOptions: { processes: ["2.1"] } });
  assert.equal(r1.result.outcome, "applied");
  assert.deepEqual([r1.result.installments[0]!.interest_cents, r1.result.installments[0]!.principal_cents, r1.result.installments[0]!.escrow_cents], [135_294n, 22_723n, 61_240n]);
  // Events landed with database sequences, in order
  const types = r1.events.map((e) => e.type);
  assert.ok(types.includes("payment.received") && types.includes("payment.posted") && types.includes("investor_events.created"), types.join(","));
  assert.ok(r1.events.every((e, i) => i === 0 || e.sequence > r1.events[i - 1]!.sequence));
  // Ledger truth is in Postgres: worked example A figures
  const L = uow.ledger;
  assert.equal(await L.balance({ scope: "custodial", custodialAccountId: f.custodial.pi, account: "custodial_pi_cash" }), 219_257n - 61_240n);
  assert.equal(await L.balance({ scope: "custodial", custodialAccountId: f.custodial.ti, account: "custodial_ti_cash" }), 61_240n);
  assert.equal(await L.balance({ scope: "loan", loanId: f.loanId, account: "interest_due" }), -135_294n);
  assert.equal(await L.balance({ scope: "loan", loanId: f.loanId, account: "principal" }), -22_723n);
  assert.equal(await L.balance({ scope: "loan", loanId: f.loanId, account: "escrow" }), -61_240n);
  assert.equal(await L.balance({ scope: "loan", loanId: f.loanId, account: "suspense_unapplied" }), 0n);
  // Timers armed by 2.1 rows on payment events are persisted with their due dates and satisfied-by links
  const open = await uow.timers.open(f.loanId);
  assert.ok(r1.timers.length > 0, "2.1 registry rows armed");
  assert.ok(r1.timers.every((t) => t.armedByEventId && r1.events.some((e) => e.id === t.armedByEventId)));
  // Decision is on the audit trail and immutable
  assert.equal(r1.decisions.length, 1);
  assert.equal((await uow.decisions.byLoan(f.loanId))[0]!.ruleCode, "F-1-09:order_1999plus");
  await assert.rejects(db.query(`UPDATE agent_decisions SET rationale = 'x' WHERE id = $1`, [r1.decisions[0]!.id]), /append-only/);

  // Second command on the same loan sees the persisted history and balances before it runs, and its own events continue the sequence.
  const r2 = await uow.run(f.loanId, (ctx) => {
    assert.equal(ctx.events.all().length, r1.events.length);
    assert.equal(ctx.ledger.balance({ scope: "loan", loanId: f.loanId, account: "principal" }), -22_723n);
    assert.equal(ctx.timers.open().length, open.length);
    ctx.events.append({ type: "statement.cycle.opened", loanId: f.loanId, actor: SYSTEM, payload: { due_date: "2026-10-01" } });
    return "ok";
  }, { clock: new FixedClock("2026-09-04T09:00:00.000Z") });
  // The statement event arms 7.x statement timers (no process filter this time), so its `timer.armed` events ride along.
  assert.equal(r2.events[0]!.type, "statement.cycle.opened");
  assert.ok(r2.events.slice(1).every((e) => e.type === "timer.armed"));
  assert.ok(r2.events[0]!.sequence > r1.events.at(-1)!.sequence);
  assert.equal((await uow.events.byLoan(f.loanId)).length, r1.events.length + r2.events.length);
});

test("unit of work is atomic: a command that throws persists nothing", { skip }, async () => {
  const f = await fixture(db);
  const uow = new PgUnitOfWork(db, loadOverriddenRegistry());
  await assert.rejects(uow.run(f.loanId, (ctx) => {
    ctx.events.append({ type: "loan.boarded", loanId: f.loanId, actor: SYSTEM, payload: {} });
    ctx.ledger.post({ effectiveDate: D("2026-09-03"), description: "x", lines: [
      { account: { scope: "loan", loanId: f.loanId, account: "principal" }, amountCents: 100n, ruleRef: "t" },
      { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -100n, ruleRef: "t" },
    ] });
    throw new Error("command failed after producing events");
  }), /command failed/);
  assert.equal((await uow.events.byLoan(f.loanId)).length, 0);
  assert.equal(await uow.ledger.balance({ scope: "loan", loanId: f.loanId, account: "principal" }), 0n);
});

test("timers: persisted instances reload as the engine's TimerInstance shape and the due sweep finds overdue rows", { skip }, async () => {
  const f = await fixture(db);
  const ev = (await new PgEventRepository(db).append([{ id: randomUUID(), type: "loan.boarded", occurredAt: "2026-09-10T15:00:00.000Z", loanId: f.loanId, actor: SYSTEM, payload: {}, sequence: 1 }]))[0]!;
  const repo = new PgTimerRepository(db);
  const inst = { id: randomUUID(), code: "SM_BOARD_FIRST_CYCLE", subject: { kind: "loan", id: f.loanId }, loanId: f.loanId, armedAt: ev.occurredAt, armedByEventId: ev.id, anchorDate: D("2026-09-10"), dueDate: D("2026-09-15"), dueAt: Date.parse("2026-09-16T03:59:00.000Z"), status: "armed" as const };
  await repo.save([inst]);
  const [back] = await repo.forSubject("loan", f.loanId);
  assert.deepEqual(back, inst);
  assert.equal((await repo.due("2026-09-16T04:00:00.000Z")).some((t) => t.id === inst.id), true);
  assert.equal((await repo.due("2026-09-15T04:00:00.000Z")).some((t) => t.id === inst.id), false);
  await repo.save([{ ...inst, status: "satisfied", satisfiedAt: "2026-09-12T00:00:00.000Z", satisfiedByEventId: ev.id }]);
  assert.equal((await repo.open(f.loanId)).length, 0);
});

test("decisions: recorded with rule set version, evidence and approver; readable by loan", { skip }, async () => {
  const f = await fixture(db);
  const repo = new PgDecisionRepository(db);
  const d = await repo.record({ agent: "boarding", loanId: f.loanId, action: "waive", ruleCode: "W-004", ruleSetVersion: "1.1@3", rationale: "parcel verified by county site", confidence: 0.97, approvedBy: "u-officer-1", approvedRole: "officer" });
  const back = await repo.get(d.id);
  assert.equal(back?.approvedRole, "officer");
  assert.equal(back?.confidence, 0.97);
  assert.equal((await repo.byLoan(f.loanId)).length, 1);
});

test.after(async () => { if (db) await db.end(); });

test("outbox on Postgres: integration_messages dedupes by (adapter, direction, key), tracks attempts, and human_portal_tasks open on fallback", { skip }, async () => {
  const { PgOutbox, PgPortalTasks } = await import("../integrations/pg-outbox.ts");
  const { Dispatcher } = await import("../integrations/outbox.ts");
  const { FakeFnmaLsdu, LsduOutboundAdapter } = await import("../integrations/fnma.ts");
  const outbox = new PgOutbox(db); const tasks = new PgPortalTasks(db);
  const key = `k-${randomUUID()}`;
  const a = await outbox.enqueue({ adapter: "fnma-lsdu", idempotencyKey: key, payload: [{ fnmaLoanNumber: "1234567890", eventId: "e1", sequence: 1, record: "9".repeat(80) }], payloadSummary: { records: 1 } }, "2026-09-03T14:00:00.000Z");
  const b = await outbox.enqueue({ adapter: "fnma-lsdu", idempotencyKey: key, payload: [] }, "2026-09-03T14:00:00.000Z");
  assert.equal(a.duplicate, false); assert.equal(b.duplicate, true); assert.equal(a.message.id, b.message.id);
  const lsdu = new FakeFnmaLsdu(); lsdu.controls.setOutage(true);
  const d = new Dispatcher(outbox, tasks);
  const [r] = await d.drain(new LsduOutboundAdapter(lsdu), "2026-09-03T14:05:00.000Z");
  assert.equal(r!.outcome, "fallback"); assert.equal(r!.task?.kind, "lsdu_file_upload");
  const back = (await outbox.get(a.message.id))!;
  assert.equal(back.status, "dead"); assert.equal(back.attempts, 1);
  const open = await tasks.open_("fnma_portal_operator");
  assert.ok(open.some((t) => t.integrationMessageId === a.message.id));
  await tasks.complete(r!.task!.id, "operator-1", null, "2026-09-03T15:00:00.000Z");
  assert.ok(!(await tasks.open_("fnma_portal_operator")).some((t) => t.id === r!.task!.id));
});

test("notice registry on Postgres: templates and approved versions persist; a notice row's content is immutable and its checklist and deliveries are recorded", { skip }, async () => {
  const { buildRegistry, publishAuthored } = await import("../../notices/catalog.ts");
  const { NoticeService } = await import("../../notices/service.ts");
  const { PgNoticeRepository } = await import("./notices.ts");
  const { FakePrintMail, FakeEdelivery } = await import("../integrations/delivery.ts");
  const reg = buildRegistry(); publishAuthored(reg);
  const repo = new PgNoticeRepository(db);
  await db.tx(async (q) => { for (const t of reg.all()) await repo.upsertTemplate(t, q); for (const t of reg.all()) for (const v of reg.versionsOf(t.code)) await repo.saveVersion(v, q); });
  const [c] = await db.query<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM notice_templates`);
  assert.ok(c!.c >= 248n);
  const f = await fixture(db);
  const clock = new FixedClock("2026-10-17T05:00:00.000Z");
  const svc = new NoticeService({ registry: reg, events: new MemoryEventStore(clock), clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const v = reg.activeVersion("INS_FPI_FIRST_MS3A", D("2026-10-05"))!;
  const n = svc.render({ templateCode: "INS_FPI_FIRST_MS3A", loanId: f.loanId, recipients: [{ partyId: f.partnerPartyId, name: "B", mailingAddress: "1 Test St" }], payload: v.samplePayload, asOf: D("2026-10-05") });
  await svc.send(n.id);
  await db.tx((q) => repo.saveNotice(n, q));
  assert.equal((await repo.statusOf(n.id))?.status, "sent");
  await assert.rejects(db.query(`UPDATE notices SET payload = '{}'::jsonb WHERE id = $1`, [n.id]), /append-only; supersede/);
  await assert.rejects(db.query(`DELETE FROM notices WHERE id = $1`, [n.id]), /append-only/);
  const [d] = await db.query<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM notice_deliveries WHERE notice_id = $1`, [n.id]);
  assert.equal(d!.c, 1n);
});

test("ops console on Postgres: queues, loan record and dashboard read the same tables the agents write; completion is role-checked", { skip }, async () => {
  const { PgConsoleStore } = await import("../../console/pg-store.ts");
  const { PgEscalationRepository, EscalationService } = await import("../../app/escalations.ts");
  const { AgentRegistry } = await import("../../app/agents.ts");
  const { loadOverriddenRegistry } = await import("../../domain/timer-overrides.ts");
  const f = await fixture(db);
  const clock = new FixedClock("2026-10-17T15:00:00.000Z");
  const esc = new EscalationService(new MemoryEventStore(clock), clock);
  const e = esc.open({ kind: "officer", loanId: f.loanId, severity: "sev-2", payload: { command: "cashiering.writeOff" } }, { kind: "agent", id: "cashiering" });
  await new PgEscalationRepository(db).save(e);
  const store = new PgConsoleStore(db, loadOverriddenRegistry(), new AgentRegistry());
  const q = await store.queue({ role: "officer", now: clock.now(), loanId: f.loanId });
  assert.equal(q.length, 1); assert.equal(q[0]!.kind, "escalation"); assert.equal(q[0]!.ownerRole, "officer");
  assert.equal((await store.queue({ role: "attorney", now: clock.now(), loanId: f.loanId })).length, 0);
  const l = (await store.loan(f.loanId, clock.now()))!;
  assert.equal(l.fnmaLoanNumber.length, 10); assert.ok(Array.isArray(l.events));
  assert.equal((await store.searchLoans(l.fnmaLoanNumber)).length, 1);
  const d = await store.dashboard(clock.now());
  assert.ok(d.queues.escalation >= 1); assert.ok(d.agents.length >= 20);
  const denied = await store.completeEscalation(e.id, { kind: "human", id: "u-att", role: "attorney" }, null, clock.now());
  assert.equal(denied.ok, false);
  const badEvidence = await store.completeEscalation(e.id, { kind: "human", id: "u-off", role: "officer" }, "doc-1", clock.now());
  assert.equal(badEvidence.ok, false);
  const ok = await store.completeEscalation(e.id, { kind: "human", id: "u-off", role: "officer" }, null, clock.now());
  assert.equal(ok.ok, true);
  assert.equal((await store.queue({ role: "officer", now: clock.now(), loanId: f.loanId })).length, 0);
  const examiner = `examiner-${randomUUID()}`;
  await store.logAccess({ at: clock.now(), actor: { kind: "human", id: examiner, role: "examiner" }, method: "GET", path: "/api/dashboard" });
  const [a] = await db.query<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM access_log WHERE actor_id = $1 AND table_name = 'ops_console'`, [examiner]);
  assert.equal(a!.c, 1n);
});
