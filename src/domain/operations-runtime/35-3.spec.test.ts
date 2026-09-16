// 35.3 Cycles, jobs and receipts: the planner, the jobs table, `cycles.run_unit` on the bus and the registry of every scheduled cycle
// spec/sections/35-operations-runtime/35-3-cycles-jobs-and-receipts.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id here runs against Postgres (operational prerequisite 3: "every T-id here runs against Postgres and skips
// without it" — REQUIRE_DB=1 in CI); the file has its own database (src/infra/db/test-db.ts) and the T-ids that sweep a
// whole book take a side database of their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { connect, type Db, type Queryable } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgLoanRepository } from "../../infra/db/loans.ts";
import { PgLedgerRepository } from "../../infra/db/ledger.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, systemClock, type Actor, type Clock } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { Runtime, type RuntimeDeps } from "../../runtime/app.ts";
import { OffsetClock, advanceDemoClock } from "../../runtime/demo-clock.ts";
import { completeEscalation } from "../../runtime/controls/escalations.ts";
import { boardTransferBatch } from "../../runtime/transfers.ts";
import { generateDemoBatch, DEMO_BATCH } from "../boarding/demo-batch.ts";
import { encodeTransferBatch } from "../boarding/tape-codec.ts";
import { CommandRefused } from "../../app/commands.ts";
import { CYCLES, SELECTORS, EV, PLANNER_LOCK_KEY, WORKED_EXAMPLE_A, type CycleDef, type Selector } from "./cycles/cycles.ts";
import { RUNNERS, type Runner, type CyclesConfig } from "./cycles/runners.ts";
import { planCycles } from "./cycles/planner.ts";
import { claimJobs, drainQueue, unitDefFor, RUN_UNIT_TOOL } from "./cycles/executor.ts";
import { emitReceipt } from "./cycles/receipt.ts";
import { breachPass, BREACH_PAGE } from "./cycles/breach.ts";
import { JOB_RETRY, heartbeatSql } from "./cycles/jobs.ts";
import { TOOLS_35_3 } from "../../app/tools/section35-3.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
/** 10:00 ET on a Monday — past every registered cycle's `not_before` hour. */
const NOW = "2026-10-05T14:00:00.000Z";
const OPS: Actor = { kind: "agent", id: "ops-steward" };
const ANALYST: Actor = { kind: "human", id: "u-ops-lee", role: "ops_analyst" };
const ET_NOON = (d: string): string => `${d}T16:00:00.000Z`;

let db: Db; let runtime: Runtime; const clock = new FixedClock(NOW);
test.before(async () => { if (skip) return; db = connect(DB_URL); runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, instanceId: "main" }); });
test.after(async () => { if (!skip) await db.end(); });

// ───────── helpers ─────────
interface Side { readonly url: string; readonly db: Db; readonly rt: Runtime; make(extra?: Partial<RuntimeDeps>): Runtime; close(): Promise<void>; }
/** A side database of this file's own with a runtime over it (a T-id that plans or sweeps a whole book gets a clean one). */
async function side(suffix: string, deps: Partial<RuntimeDeps> = {}, clk: Clock = new FixedClock(NOW)): Promise<Side> {
  const s = await testDatabase(import.meta.url, { suffix });
  const sdb = connect(s.url);
  const make = (extra: Partial<RuntimeDeps> = {}): Runtime => new Runtime({ db: sdb, registry: loadOverriddenRegistry(), clock: clk, instanceId: `side-${suffix}`, ...deps, ...extra });
  return { url: s.url, db: sdb, rt: make(), make, close: async () => { await sdb.end(); await s.close(); } };
}
const cfg = (defs: readonly CycleDef[], selectors: Record<string, Selector> = {}, runners: Record<string, Runner> = {}): CyclesConfig => ({ defs: [...CYCLES, ...defs], selectors: { ...SELECTORS, ...selectors }, runners: { ...RUNNERS, ...runners }, ports: {} });
const tdef = (code: string, o: Partial<CycleDef> = {}): CycleDef => ({ cycle_code: code, owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "test", period_grammar: "day", selector: code, runner: code, receipt_event: `${code}.run_completed`, depends_on: [], serves_timer: null, escalation_role: "ops_analyst", expected_by: "same_day 23:59 ET", ...o });
const noop: Runner = { kind: "unit", run: async () => ({ outcome: "done" }) };
const unitsOf = (n: number, prefix = "u"): Selector => async (_db, w) => Array.from({ length: n }, (_x, i) => ({ period_key: w.as_of_date, unit_id: `${prefix}${String(i + 1).padStart(3, "0")}` }));
const count = async (q: Queryable, sql: string, params: unknown[] = []): Promise<number> => Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]!.c);
type Ev = { id: string; sequence: string; payload: Record<string, unknown>; aggregate_kind: string | null; aggregate_id: string | null; actor_kind: string; actor_id: string; occurred_at: string; xid: string };
const evs = (q: Queryable, type: string, extra = "", params: unknown[] = []): Promise<Ev[]> => q.query<Ev>(`SELECT id, sequence::text AS sequence, payload, aggregate_kind, aggregate_id, actor_kind::text AS actor_kind, actor_id, occurred_at::text AS occurred_at, xmin::text AS xid FROM loan_events WHERE type = $1 ${extra} ORDER BY sequence`, [type, ...params]);
const appendGlobal = (rt: Runtime, type: string, payload: Record<string, unknown>, aggregate?: { kind: string; id: string }): Promise<unknown> => rt.uow.run({}, (ctx) => ctx.events.append({ type, actor: { kind: "system", id: "test" }, ...(aggregate ? { aggregate } : {}), payload }), { clock: rt.clock });
const jobOf = async (q: Queryable, code: string, unit?: string): Promise<{ id: string; run_id: string; status: string; attempts: number; lease_holder: string | null; lease_until: string | null; run_after: string | null; decision_id: string | null }> => (await q.query<{ id: string; run_id: string; status: string; attempts: number; lease_holder: string | null; lease_until: string | null; run_after: string | null; decision_id: string | null }>(`SELECT id, run_id, status, attempts, lease_holder, lease_until::text AS lease_until, run_after::text AS run_after, decision_id FROM jobs WHERE cycle_code = $1 AND ($2::text IS NULL OR unit_id = $2) ORDER BY created_at LIMIT 1`, [code, unit ?? null]))[0]!;
const runOf = async (q: Queryable, code: string, period?: string): Promise<{ id: string; status: string; units_total: number; units_done: number; units_dead: number; units_skipped: number; period_key: string }> => (await q.query<{ id: string; status: string; units_total: number; units_done: number; units_dead: number; units_skipped: number; period_key: string }>(`SELECT id, status, units_total, units_done, units_dead, units_skipped, period_key FROM cycle_runs WHERE cycle_code = $1 AND ($2::text IS NULL OR period_key = $2) ORDER BY opened_at DESC LIMIT 1`, [code, period ?? null]))[0]!;
/** A test holds the planner's key on its own session (T1, T14) — a session-level advisory lock on the file's database. */
async function holdPlannerLock(url: string): Promise<{ release(): Promise<void> }> {
  const c = new pg.Client({ connectionString: url }); await c.connect(); await c.query("SELECT pg_advisory_lock($1)", [PLANNER_LOCK_KEY]);
  return { release: async () => { await c.query("SELECT pg_advisory_unlock($1)", [PLANNER_LOCK_KEY]); await c.end(); } };
}
/** The 100-loan fixture book (src/domain/boarding/demo-batch.ts), boarded through 1.1's route as `seed-demo` does; every loan active and boarded. */
async function boardBook(rt: Runtime): Promise<string[]> {
  const demo = generateDemoBatch();
  await boardTransferBatch(rt, { ...DEMO_BATCH }, encodeTransferBatch(demo, demo.coborrowers), { kind: "system", id: "seed" });
  await rt.db.query(`UPDATE loans SET status = 'active', boarded_at = coalesce(boarded_at, now()) WHERE boarding_batch_id IS NOT NULL AND status IN ('staged', 'active')`);
  // the batch's exception loans (staged by 1.1's validation) get boarded terms too, so the book is 100 serviceable loans
  await rt.db.query(`INSERT INTO loan_terms (loan_id, effective_from, source, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, interest_method, remittance_type, late_charge_pct_bps, late_charge_grace_days, maturity_date, remaining_term_months) SELECT l.id, '2026-09-01', 'boarding', 'fixed', 65000, 150000, 0, false, '30_360', 'A/A', 5000, 15, l.maturity_date, 360 FROM loans l WHERE l.boarding_batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM loan_terms t WHERE t.loan_id = l.id)`);
  return (await rt.db.query<{ id: string }>(`SELECT id FROM loans WHERE status = 'active' AND boarded_at IS NOT NULL ORDER BY servicer_loan_number`)).map((r) => r.id);
}
/** Every money column the ledger and the typed rows carry, as one digest (T13: byte-identical before and after every 35.3 tool call). */
async function moneyDigest(q: Queryable): Promise<string> {
  const [r] = await q.query<{ d: string }>(`SELECT md5(coalesce((SELECT string_agg(id::text || ':' || amount_cents::text, ',' ORDER BY id) FROM ledger_lines), '') || '|' || coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM ledger_entry_sets), '') || '|' || coalesce((SELECT string_agg(id::text || ':' || pi_cents::text || ':' || escrow_payment_cents::text || ':' || coalesce(late_charge_max_cents::text, ''), ',' ORDER BY id) FROM loan_terms), '') || '|' || coalesce((SELECT string_agg(id::text || ':' || original_upb_cents::text, ',' ORDER BY id) FROM loans), '') || '|' || coalesce((SELECT string_agg(id::text || ':' || amount_cents::text, ',' ORDER BY id) FROM payments), '')) AS d`);
  return r!.d;
}
/** Worked example A's loan L on a side database: the fixture loan, its boarded terms, its borrower party and the opening principal on the ledger — every figure derived from these rows, never hand-fed to the unit. */
async function loanL(s: Side): Promise<string> {
  const f = await new PgLoanRepository(s.db).createFixture({ fnmaLoanNumber: `9${String(Date.now() % 1_000_000_000).padStart(9, "0")}`, servicerLoanNumber: `SM-L-${randomUUID().slice(0, 8)}`, instrumentDate: D("2026-08-15"), originalUpbCents: WORKED_EXAMPLE_A.upb_cents, originalTermMonths: 360, firstPaymentDate: D("2026-10-01"), maturityDate: D("2056-09-01"), status: "active" });
  await s.db.query(`UPDATE loans SET boarded_at = '2026-09-01T12:00:00Z' WHERE id = $1`, [f.loanId]);
  await s.db.query(`INSERT INTO loan_terms (loan_id, effective_from, source, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, interest_method, remittance_type, late_charge_pct_bps, late_charge_grace_days, maturity_date, remaining_term_months) VALUES ($1, '2026-09-01', 'boarding', 'fixed', 65000, $2, $3, true, '30_360', 'A/A', 5000, 15, '2056-09-01', 360)`, [f.loanId, WORKED_EXAMPLE_A.pi_cents, WORKED_EXAMPLE_A.escrow_cents]);
  const party = (await s.db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('borrower', 'Alex Borrower', '{}'::jsonb) RETURNING id`))[0]!.id;
  const b = (await s.db.query<{ id: string }>(`INSERT INTO borrowers (legal_name, tin_last4, party_id) VALUES ('Alex Borrower', '6789', $1) RETURNING id`, [party]))[0]!.id;
  await s.db.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, 'borrower', true)`, [f.loanId, b]);
  // the opening entries as 1.6 posts them: principal on the loan against the transfer-in clearing account (a balanced set with rule refs)
  const set = new MemoryLedger().post({ effectiveDate: D("2026-09-01"), description: "opening entries", lines: [
    { account: { scope: "loan", loanId: f.loanId, account: "principal" }, amountCents: WORKED_EXAMPLE_A.upb_cents, ruleRef: "1.6:opening:principal" },
    { account: { scope: "custodial", custodialAccountId: f.custodial.clearing, account: "transfer_in_clearing" }, amountCents: -WORKED_EXAMPLE_A.upb_cents, ruleRef: "1.6:opening:clearing" } ] }, "2026-09-01T12:00:00.000Z");
  await s.db.tx((q) => new PgLedgerRepository(q).post(set, q));
  return f.loanId;
}
const sweepPasses = (r: Awaited<ReturnType<Runtime["sweep"]>>): string[] => r.passes.map((p) => p.name);

test("35.3-T1: Given two sweeps started within the same minute against one database, when both call `cycles.plan`, then exactly one holds `pg_try_advisory_lock(35_003)` and appends `cycles.plan.run_completed`, the other appends `cycles.plan.skipped{holder}` and its remaining passes still run, and after the holder's dedicated client ends `pg_locks` shows no advisory lock with key 35003.", { skip }, async () => {
  const s = await side("t1");
  try {
    // two sweeps' planners within the same minute: exactly one holds pg_try_advisory_lock(35_003)
    const [a, b] = await Promise.all([planCycles(s.rt, { as_of: NOW, planned_by: "sweep:a", holder: "sweep-a" }), planCycles(s.rt, { as_of: NOW, planned_by: "sweep:b", holder: "sweep-b" })]);
    const held = [a, b].filter((r) => !r.skipped); const skipped = [a, b].filter((r) => r.skipped);
    assert.equal(held.length, 1, JSON.stringify([a.skipped, b.skipped])); assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.skipped_reason, "lock_held");
    const completed = await evs(s.db, EV.plan_completed); const skippedEvs = await evs(s.db, EV.plan_skipped);
    assert.equal(completed.length, 1); assert.equal(completed[0]!.payload["holder"], held[0]!.holder);
    assert.equal(skippedEvs.length, 1); assert.equal(skippedEvs[0]!.payload["holder"], skipped[0]!.holder); assert.equal(skippedEvs[0]!.payload["lock_key"], PLANNER_LOCK_KEY);
    // the other sweep's remaining passes still run: a sweep whose planner finds the key held completes every other pass
    const lock = await holdPlannerLock(s.url);
    let sweep: Awaited<ReturnType<Runtime["sweep"]>>;
    try { sweep = await s.rt.sweep(NOW); } finally { await lock.release(); }
    assert.equal(sweep.outcome, "completed"); assert.equal(sweep.cycles.plan?.skipped, true);
    const names = sweepPasses(sweep);
    for (const n of ["outbox.dispatch", "cycles.plan", "partner_book.review", "partner_book.readiness", "controls", "cycles.execute", "timers.breach"]) assert.ok(names.includes(n), `${n} ran: ${names.join(",")}`);
    assert.equal(await count(s.db, `FROM loan_events WHERE type = $1`, [EV.plan_skipped]), 2);
    // after the holder's dedicated client ends, pg_locks shows no advisory lock with key 35003
    const locks = await s.db.query(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`, [PLANNER_LOCK_KEY]);
    assert.equal(locks.length, 0, "no advisory lock with key 35003 remains");
  } finally { await s.close(); }
});

test("35.3-T2: Given a window with the `statements` cycle due for 12 loans and `cashiering_daily` due for the 100-loan fixture book, when `cycles.plan` runs twice for the same `as_of`, then `cycle_runs` has one row per `(cycle_code, period_key)`, `jobs` has exactly 112 rows with distinct `idempotency_key`s, `cycle.run.opened` was appended once per run, and the second pass appended no `cycle.run.opened` and inserted no row.", { skip }, async () => {
  const s = await side("t2", {}, new FixedClock(ET_NOON("2026-10-17")));
  try {
    const loans = await boardBook(s.rt);
    assert.equal(loans.length, 100, "the 100-loan fixture book");
    // the window: every loan's cycle due on the 1st; twelve loans' courtesy period (15 days) closed yesterday → a statement today; the rest closed on the 11th (grace 10) → no statement in this window
    const withTerms = new Set((await s.db.query<{ id: string }>(`SELECT DISTINCT loan_id AS id FROM loan_terms`)).map((r) => r.id));
    const twelve = loans.filter((id) => withTerms.has(id)).slice(0, 12);
    await s.db.query(`UPDATE loans SET first_payment_date = date_trunc('month', first_payment_date)::date WHERE id = ANY($1::uuid[])`, [loans]);
    await s.db.query(`UPDATE loans SET first_payment_date = '2021-10-01' WHERE id = ANY($1::uuid[])`, [twelve]);
    await s.db.query(`UPDATE loan_terms SET late_charge_grace_days = CASE WHEN loan_id = ANY($1::uuid[]) THEN 15 ELSE 10 END WHERE loan_id = ANY($2::uuid[])`, [twelve, loans]);
    const asOf = ET_NOON("2026-10-17");
    const first = await planCycles(s.rt, { as_of: asOf, planned_by: "test", cycle_codes: ["statements", "cashiering_daily"] });
    assert.equal(first.skipped, false); assert.equal(first.jobs_planned, 112, JSON.stringify(first));
    const runs = await s.db.query<{ cycle_code: string; period_key: string; units_total: number }>(`SELECT cycle_code, period_key, units_total FROM cycle_runs ORDER BY cycle_code`);
    assert.deepEqual(runs.map((r) => `${r.cycle_code}:${r.period_key}:${r.units_total}`), ["cashiering_daily:2026-10-17:100", "statements:2026-10-01:12"]);
    assert.equal(await count(s.db, `FROM (SELECT DISTINCT cycle_code, period_key FROM cycle_runs) x`), runs.length, "one row per (cycle_code, period_key)");
    assert.equal(await count(s.db, `FROM jobs`), 112); assert.equal(await count(s.db, `FROM (SELECT DISTINCT idempotency_key FROM jobs) x`), 112);
    const opened = await evs(s.db, EV.run_opened); assert.equal(opened.length, 2);
    assert.deepEqual(opened.map((e) => e.payload["cycle_code"]).sort(), ["cashiering_daily", "statements"]);
    // the same window planned twice adds no row and no event (PLAN_IS_IDEMPOTENT)
    const second = await planCycles(s.rt, { as_of: asOf, planned_by: "test", cycle_codes: ["statements", "cashiering_daily"] });
    assert.equal(second.runs_opened, 0); assert.equal(second.jobs_planned, 0);
    assert.equal(await count(s.db, `FROM cycle_runs`), 2); assert.equal(await count(s.db, `FROM jobs`), 112);
    assert.equal((await evs(s.db, EV.run_opened)).length, 2);
  } finally { await s.close(); }
});

test("35.3-T3: Given one run of 100 queued units, when three executors claim concurrently with `FOR UPDATE SKIP LOCKED LIMIT 20` until the queue is empty, then every unit has exactly one `job_events{done}` row and one `agent_decisions` row naming the owner agent, no `unit_id` appears in two executors' claim logs, `cycle_runs.units_done = 100`, and one `cycle_receipts` row exists.", { skip }, async () => {
  const def = tdef("t3_hundred", { owner_agent: "cashiering" });
  const s = await side("t3", { cycles: cfg([def], { t3_hundred: unitsOf(100) }, { t3_hundred: noop }) });
  try {
    const plan = await planCycles(s.rt, { as_of: NOW, planned_by: "test", cycle_codes: ["t3_hundred"] });
    assert.equal(plan.jobs_planned, 100);
    const run = await runOf(s.db, "t3_hundred"); assert.equal(run.units_total, 100);
    // three executors claim concurrently FOR UPDATE SKIP LOCKED LIMIT 20 until the queue is empty
    const reports = await Promise.all(["exec-1", "exec-2", "exec-3"].map((holder) => drainQueue(s.rt, { holder, deadlineMs: null, limit: 20 })));
    assert.equal(reports.reduce((a, r) => a + r.claimed, 0), 100, JSON.stringify(reports.map((r) => ({ holder: r.holder, claimed: r.claimed, done: r.done, failed: r.failed, dead: r.dead }))));
    assert.ok(reports.every((r) => r.failed === 0 && r.dead === 0));
    // every unit: exactly one job_events{done} row and one agent_decisions row naming the owner agent
    const perUnit = await s.db.query<{ unit_id: string; done: string; decisions: string; holders: string }>(`SELECT j.unit_id, (SELECT count(*) FROM job_events e WHERE e.job_id = j.id AND e.kind = 'done')::text AS done, (SELECT count(*) FROM agent_decisions d WHERE d.id = j.decision_id AND d.agent = 'cashiering' AND d.action = 'cycles.run_unit' AND d.subject_kind = 't3_hundred' AND d.subject_id = j.unit_id)::text AS decisions, (SELECT count(DISTINCT e.holder) FROM job_events e WHERE e.job_id = j.id AND e.kind = 'claimed')::text AS holders FROM jobs j WHERE j.run_id = $1 ORDER BY j.unit_id`, [run.id]);
    assert.equal(perUnit.length, 100);
    for (const u of perUnit) { assert.equal(u.done, "1", `${u.unit_id} done once`); assert.equal(u.decisions, "1", `${u.unit_id} one decision naming cashiering`); assert.equal(u.holders, "1", `${u.unit_id} claimed by one executor`); }
    assert.equal(await count(s.db, `FROM agent_decisions WHERE action = 'cycles.run_unit' AND subject_kind = 't3_hundred'`), 100);
    // no unit_id appears in two executors' claim logs
    const claimLogs = await s.db.query<{ unit_id: string; holders: string[] }>(`SELECT j.unit_id, array_agg(DISTINCT e.holder) AS holders FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE e.kind = 'claimed' AND j.run_id = $1 GROUP BY j.unit_id`, [run.id]);
    assert.ok(claimLogs.every((c) => c.holders.length === 1));
    const after = await runOf(s.db, "t3_hundred"); assert.equal(after.units_done, 100); assert.equal(after.status, "completed");
    assert.equal(await count(s.db, `FROM cycle_receipts WHERE run_id = $1`, [run.id]), 1);
  } finally { await s.close(); }
});

test("35.3-T4: Given a unit whose runner throws on every call, when the planner and executor run across four sweeps, then the job records attempts 1, 2, 3 with `run_after` 60 s and 120 s after the first two failures, the third failure appends `job.unit.dead{attempts: 3}`, `SM_JOB_DEAD_2H` is armed on the job, one escalation exists to the registry row's `escalation_role` naming `cycle_code`, `period_key` and `unit_id`, `cycle_runs.status` is still `running`, and no receipt was emitted.", { skip }, async () => {
  const def = tdef("t4_boom", { escalation_role: "officer" });
  const boom: Runner = { kind: "unit", run: async () => { throw new Error("fake_port_timeout: the FAKE bureau did not answer"); } };
  const clk = new FixedClock(NOW);
  const s = await side("t4", { cycles: cfg([def], { t4_boom: unitsOf(1, "global") }, { t4_boom: boom }) }, clk);
  try {
    const ageOut = () => s.db.query(`UPDATE jobs SET run_after = now() - interval '1 second' WHERE cycle_code = 't4_boom' AND status = 'failed'`);
    for (let i = 0; i < 4; i++) { clk.set(new Date(Date.parse(NOW) + i * 120_000).toISOString()); const r = await s.rt.sweep(clk.now()); assert.equal(r.outcome, "completed"); await ageOut(); }
    const job = await jobOf(s.db, "t4_boom");
    assert.equal(job.status, "dead"); assert.equal(job.attempts, JOB_RETRY.maxAttempts);
    // attempts 1, 2, 3 on the log; run_after 60 s and 120 s after the first two failures
    const failed = await s.db.query<{ attempt: number; delay: string; secs: string }>(`SELECT attempt, detail->>'delay_ms' AS delay, extract(epoch FROM ((detail->>'run_after')::timestamptz - at))::text AS secs FROM job_events WHERE job_id = $1 AND kind = 'failed' ORDER BY attempt`, [job.id]);
    assert.deepEqual(failed.map((f) => f.attempt), [1, 2]);
    assert.deepEqual(failed.map((f) => Number(f.delay)), [JOB_RETRY.baseDelayMs, JOB_RETRY.baseDelayMs * 2]);
    assert.ok(Math.abs(Number(failed[0]!.secs) - 60) < 2, `run_after 60 s after the first failure (${failed[0]!.secs})`); assert.ok(Math.abs(Number(failed[1]!.secs) - 120) < 2, `run_after 120 s after the second (${failed[1]!.secs})`);
    const deadRow = await s.db.query<{ attempt: number }>(`SELECT attempt FROM job_events WHERE job_id = $1 AND kind = 'dead'`, [job.id]); assert.deepEqual(deadRow.map((d) => d.attempt), [3]);
    const dead = await evs(s.db, EV.unit_dead, `AND aggregate_id = $2`, [job.id]);
    assert.equal(dead.length, 1); assert.equal(dead[0]!.payload["attempts"], 3); assert.equal(dead[0]!.payload["error_class"], "error");
    // SM_JOB_DEAD_2H armed on the job; one escalation to the registry row's escalation_role naming cycle_code, period_key and unit_id
    const timers = await s.db.query<{ status: string; subject_kind: string; subject_id: string }>(`SELECT status, subject_kind, subject_id FROM timers WHERE code = 'SM_JOB_DEAD_2H' AND subject_id = $1`, [job.id]);
    assert.deepEqual(timers, [{ status: "armed", subject_kind: "job", subject_id: job.id }]);
    const esc = await s.db.query<{ owner_role: string; payload: Record<string, unknown> }>(`SELECT owner_role, payload FROM escalations WHERE payload->>'job_id' = $1`, [job.id]);
    assert.equal(esc.length, 1); assert.equal(esc[0]!.owner_role, "officer");
    assert.equal(esc[0]!.payload["cycle_code"], "t4_boom"); assert.equal(esc[0]!.payload["period_key"], "2026-10-05"); assert.equal(esc[0]!.payload["unit_id"], "global001");
    const run = await runOf(s.db, "t4_boom"); assert.equal(run.status, "running"); assert.equal(run.units_dead, 1);
    assert.equal(await count(s.db, `FROM cycle_receipts WHERE run_id = $1`, [run.id]), 0);
    assert.equal((await evs(s.db, EV.run_completed, `AND aggregate_id = $2`, [run.id])).length, 0);
  } finally { await s.close(); }
});

test("35.3-T5: Given a run of 3 units, when the last unit's `UPDATE … RETURNING` reports the counters full, then one `cycle_receipts` row and one pair of events (the cycle's receipt literal and `cycle.run.completed`) exist; given the executor is stopped between the unit's commit and the receipt transaction, when the next planner pass reconciles, then the same single receipt row exists with `emitted_by = planner:<run_id>` and the events were appended once; given both race, then the unique key on `cycle_receipts.run_id` yields one row and one pair of events.", { skip }, async () => {
  const defs = [tdef("t5_last"), tdef("t5_crash"), tdef("t5_race")];
  const s = await side("t5", { cycles: cfg(defs, { t5_last: unitsOf(3), t5_crash: unitsOf(3), t5_race: unitsOf(3) }, { t5_last: noop, t5_crash: noop, t5_race: noop }) });
  try {
    const registered = s.rt.tool("35.3", RUN_UNIT_TOOL)!;
    const pair = async (runId: string, literal: string) => ({ literal: (await evs(s.db, literal, `AND aggregate_id = $2`, [runId])).length, generic: (await evs(s.db, EV.run_completed, `AND aggregate_id = $2`, [runId])).length, rows: await count(s.db, `FROM cycle_receipts WHERE run_id = $1`, [runId]) });
    // (a) the last unit's UPDATE … RETURNING reports the counters full → one receipt row and one pair of events
    await planCycles(s.rt, { as_of: NOW, planned_by: "test", cycle_codes: ["t5_last"] });
    const last = await runOf(s.db, "t5_last"); assert.equal(last.units_total, 3);
    const d = await drainQueue(s.rt, { holder: "e", deadlineMs: null });
    assert.equal(d.done, 3); assert.equal(d.receipts, 1, "the last unit elects the receipt");
    assert.deepEqual(await pair(last.id, "t5_last.run_completed"), { literal: 1, generic: 1, rows: 1 });
    assert.equal((await s.db.query<{ emitted_by: string }>(`SELECT emitted_by FROM cycle_receipts WHERE run_id = $1`, [last.id]))[0]!.emitted_by.startsWith("unit:"), true);
    // (b) the executor stopped between the unit's commit and the receipt transaction: the units commit (counters full), no receipt — the next planner pass reconciles it once
    await planCycles(s.rt, { as_of: NOW, planned_by: "test", cycle_codes: ["t5_crash"] });
    const crashDef = defs[1]!;
    const c = await claimJobs(s.rt, "crashing", 20); assert.equal(c.claimed.length, 3);
    for (const j of c.claimed) await s.rt.executeDef(unitDefFor(registered, crashDef), { loanId: "", actor: OPS, input: { job_id: j.id, holder: "crashing" } });
    const r2 = await runOf(s.db, "t5_crash"); assert.equal(r2.units_done, 3); assert.equal(await count(s.db, `FROM cycle_receipts WHERE run_id = $1`, [r2.id]), 0);
    const plan = await planCycles(s.rt, { as_of: NOW, planned_by: "test", cycle_codes: [] });
    assert.equal(plan.receipts_reconciled, 1);
    assert.deepEqual((await s.db.query<{ emitted_by: string }>(`SELECT emitted_by FROM cycle_receipts WHERE run_id = $1`, [r2.id])).map((r) => r.emitted_by), [`planner:${r2.id}`]);
    assert.deepEqual(await pair(r2.id, "t5_crash.run_completed"), { literal: 1, generic: 1, rows: 1 });
    await planCycles(s.rt, { as_of: NOW, planned_by: "test", cycle_codes: [] });
    assert.deepEqual(await pair(r2.id, "t5_crash.run_completed"), { literal: 1, generic: 1, rows: 1 }, "reconciled once");
    // (c) both race: the unique key on cycle_receipts.run_id yields one row and one pair of events
    await planCycles(s.rt, { as_of: NOW, planned_by: "test", cycle_codes: ["t5_race"] });
    const c3 = await claimJobs(s.rt, "racing", 20); assert.equal(c3.claimed.length, 3);
    for (const j of c3.claimed) await s.rt.executeDef(unitDefFor(registered, defs[2]!), { loanId: "", actor: OPS, input: { job_id: j.id, holder: "racing" } });
    const r3 = await runOf(s.db, "t5_race");
    const results = await Promise.all([emitReceipt(s.rt, r3.id, `unit:${c3.claimed[2]!.id}`), emitReceipt(s.rt, r3.id, `planner:${r3.id}`)]);
    assert.equal(results.filter((r) => r !== null).length, 1);
    assert.deepEqual(await pair(r3.id, "t5_race.run_completed"), { literal: 1, generic: 1, rows: 1 });
  } finally { await s.close(); }
});

test("35.3-T6: Given `ledger.period.closed{period_key: 2026-09}` has been appended and `investor_reporting_periods.closed{period_key: 2026-09}` has not, when the planner runs, then the `form_496_monthly` job for `2026-09:<account>:A/A` is `blocked` and never claimed; when `investor_reporting_periods.closed{period_key: 2026-09}` is appended, then the next pass unblocks it (`job_events{unblocked}`) and the unit runs 6.3's chain.", { skip }, async () => {
  const s = await side("t6");
  try {
    const f = await new PgLoanRepository(s.db).createFixture({ fnmaLoanNumber: `8${String(Date.now() % 1_000_000_000).padStart(9, "0")}`, servicerLoanNumber: `SM-T6-${randomUUID().slice(0, 8)}`, instrumentDate: D("2021-07-15"), originalUpbCents: 25_000_000n, originalTermMonths: 360, firstPaymentDate: D("2021-09-01"), maturityDate: D("2051-08-01") });
    await appendGlobal(s.rt, "ledger.period.closed", { period_key: "2026-09", period_end: "2026-09-30", custodial_account_id: f.custodial.pi }, { kind: "custodial_account", id: f.custodial.pi });
    // 6.3's statement of record for the account (the row bank.read_statement stores): Section I of the Form 496 draft is the bank's closing ledger, never the cashbook
    await s.rt.executeDef({ name: "t6.statement", process: "35.3", agent: "ops-steward", kind: "act", handler: (_i, ctx, trt) => { trt.store.put("bank_statements", `stmt-${f.custodial.pi}-2026-09-30`, { custodial_account_id: f.custodial.pi, format: "bai2", as_of_date: "2026-09-30", file_id: "FAKE-BAI2-2026-09-30", control_totals_ok: true, quarantined: false, closing_ledger_cents: 0n, closing_available_cents: 0n, parsed_at: ctx.now }, ctx.actor, ctx.now); return {}; } }, { loanId: "", actor: OPS, input: {} });
    const key = `2026-09:${f.custodial.pi}:A/A`;
    const plan = await planCycles(s.rt, { as_of: NOW, planned_by: "test", cycle_codes: ["form_496_monthly"] });
    assert.equal(plan.jobs_planned, 1, JSON.stringify(plan));
    const blocked = await s.db.query<{ status: string; period_key: string }>(`SELECT status, period_key FROM jobs WHERE cycle_code = 'form_496_monthly'`);
    assert.deepEqual(blocked, [{ status: "blocked", period_key: key }]);
    // never claimed: an executor finds nothing to claim
    const d0 = await drainQueue(s.rt, { holder: "e", deadlineMs: null });
    assert.equal(d0.claimed, 0); assert.equal(await count(s.db, `FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.cycle_code = 'form_496_monthly' AND e.kind = 'claimed'`), 0);
    assert.equal((await jobOf(s.db, "form_496_monthly")).status, "blocked");
    // the investor close arrives: the next pass unblocks it and the unit runs 6.3's chain
    await appendGlobal(s.rt, "investor_reporting_periods.closed", { period_key: "2026-09" }, { kind: "period", id: "2026-09" });
    const plan2 = await planCycles(s.rt, { as_of: NOW, planned_by: "test", cycle_codes: ["form_496_monthly"] });
    assert.equal(plan2.unblocked, 1);
    const job = await jobOf(s.db, "form_496_monthly"); assert.equal(job.status, "queued");
    assert.equal(await count(s.db, `FROM job_events WHERE job_id = $1 AND kind = 'unblocked'`, [job.id]), 1);
    const d1 = await drainQueue(s.rt, { holder: "e", deadlineMs: null });
    assert.equal(d1.done, 1, JSON.stringify(d1.results.map((r) => (r.status === "done" ? r.status : r.failure))));
    assert.equal((await jobOf(s.db, "form_496_monthly")).status, "done");
    const drafted = await evs(s.db, "custodial.reconciliation.drafted", `AND aggregate_id = $2`, [f.custodial.pi]);
    assert.equal(drafted.length, 1); assert.equal(drafted[0]!.actor_id, "custodial-recon"); assert.equal(drafted[0]!.payload["period"], "2026-09");
    assert.equal(await count(s.db, `FROM loan_events WHERE type = 'command.executed' AND payload->>'command' = 'form496.generate' AND payload->>'process' = '6.3'`), 1);
  } finally { await s.close(); }
});

test("35.3-T7: Given 10,000 armed timers due at or before `now`, when the breach pass runs, then it uses 20 transactions of at most 500 timers each, every one of the 10,000 has exactly one `timer.breached` event and one escalation, and a second pass started concurrently breaches none of them twice (the `FOR UPDATE SKIP LOCKED` page).", { skip }, async () => {
  const s = await side("t7");
  try {
    const seed = async (n: number): Promise<void> => {
      const [ev] = await s.db.query<{ id: string }>(`INSERT INTO loan_events (type, actor_kind, actor_id, payload) VALUES ('cycle.run.opened', 'system', 'test', '{}'::jsonb) RETURNING id`);
      await s.db.query(`INSERT INTO timers (id, code, subject_kind, subject_id, armed_at, armed_by_event_id, anchor_date, due_date, due_at, status) SELECT gen_random_uuid(), 'SM_CYCLE_RUN_STALLED_1D', 'cycle_run', gen_random_uuid()::text, $2::timestamptz - interval '2 days', $1, '2026-10-03', '2026-10-04', $2::timestamptz - interval '1 hour', 'armed' FROM generate_series(1, $3)`, [ev!.id, NOW, n]);
    };
    // 10,000 armed timers due at or before now: 20 transactions of at most 500 timers each, every one breached exactly once with one escalation
    await seed(10_000);
    let txs = 0;
    const counting: Db = { query: (sql, params) => s.db.query(sql, params), tx: (fn) => { txs += 1; return s.db.tx(fn); }, dedicated: () => s.db.dedicated(), end: async () => undefined };
    const single = await breachPass(s.make({ db: counting }), NOW);
    assert.equal(single.due, 10_000); assert.equal(single.breaches.length, 10_000); assert.equal(single.pages, 20); assert.equal(txs, 20); assert.equal(single.page_size, BREACH_PAGE);
    assert.equal(await count(s.db, `FROM timers WHERE code = 'SM_CYCLE_RUN_STALLED_1D' AND status = 'breached'`), 10_000);
    assert.equal(await count(s.db, `FROM loan_events WHERE type = 'timer.breached'`), 10_000);
    assert.equal(await count(s.db, `FROM (SELECT payload->>'timer_id' AS t FROM loan_events WHERE type = 'timer.breached' GROUP BY 1 HAVING count(*) > 1) x`), 0, "each timer breached once");
    assert.equal(await count(s.db, `FROM escalations WHERE payload->>'timer_code' = 'SM_CYCLE_RUN_STALLED_1D'`), 10_000);
    assert.equal(await count(s.db, `FROM (SELECT sla_timer_id FROM escalations GROUP BY 1 HAVING count(*) > 1) x`), 0, "one escalation per timer");
    // a second pass started concurrently breaches none of them twice (the FOR UPDATE SKIP LOCKED page): another 10,000, two passes at once
    await seed(10_000);
    const [a, b] = await Promise.all([breachPass(s.rt, NOW), breachPass(s.make(), NOW)]);
    assert.equal(a.breaches.length + b.breaches.length, 10_000, `disjoint pages: ${a.breaches.length} + ${b.breaches.length}`);
    assert.ok(a.pages + b.pages >= 20);
    assert.equal(await count(s.db, `FROM loan_events WHERE type = 'timer.breached'`), 20_000);
    assert.equal(await count(s.db, `FROM (SELECT payload->>'timer_id' AS t FROM loan_events WHERE type = 'timer.breached' GROUP BY 1 HAVING count(*) > 1) x`), 0);
    assert.equal(await count(s.db, `FROM timers WHERE code = 'SM_CYCLE_RUN_STALLED_1D' AND status = 'armed' AND due_at <= $1`, [NOW]), 0);
    const third = await breachPass(s.rt, NOW); assert.equal(third.due, 0); assert.equal(third.pages, 0);
  } finally { await s.close(); }
});

test("35.3-T8: Given the demo clock at 2026-10-01 12:00 ET and the fixture book, when `POST /v1/demo/advance {days: 3}` runs, then `cycles.plan.run_completed` was appended three times with `as_of_date` 2026-10-02, 2026-10-03 and 2026-10-04, `cycle_runs` holds one `cashiering_daily` and one `delinquency_counters` run per day with `period_key` equal to that day and `demo_offset_ms` equal to the step's `demo_clock.offset_ms`, every receipt of day N precedes day N+1's `cycle.run.opened` in `loan_events.sequence`, and every `jobs.lease_until` written during the advance is within 5 minutes of the wall-clock `real_now`, not of `demo_now`.", { skip }, async () => {
  const demoClock = new OffsetClock(systemClock);
  const s = await side("t8", {}, demoClock);
  try {
    // the demo clock at 2026-10-01 12:00 ET (a persisted step, as the deploy's first advance leaves it) and the fixture book
    await demoClock.step(s.db, ET_NOON("2026-10-01"), { advance_id: randomUUID(), step: 1, steps: 1, kind: "target", actor: "system:test" });
    const loans = await boardBook(s.rt); assert.ok(loans.length >= 90, `the fixture book boarded (${loans.length})`);
    const before = Date.now();
    const r = await advanceDemoClock({ runtime: s.rt, clock: demoClock, actor: "system:test" }, { days: 3 });
    assert.equal(r.complete, true); assert.equal(r.days_crossed, 3);
    const steps = r.steps.map((st) => st.cycles); assert.ok(steps.every((c) => !("error" in c)), JSON.stringify(steps));
    // cycles.plan.run_completed three times: 2026-10-02, 2026-10-03, 2026-10-04
    const plans = await evs(s.db, EV.plan_completed);
    assert.deepEqual(plans.map((e) => e.payload["as_of_date"]), ["2026-10-02", "2026-10-03", "2026-10-04"]);
    // one cashiering_daily and one delinquency_counters run per day, period_key = that day, demo_offset_ms = the step's demo_clock.offset_ms
    for (const code of ["cashiering_daily", "delinquency_counters"]) {
      const runs = await s.db.query<{ period_key: string; as_of_date: string; demo_offset_ms: string; status: string; units_total: number; units_done: number; units_dead: number }>(`SELECT period_key, as_of_date::text AS as_of_date, demo_offset_ms::text AS demo_offset_ms, status, units_total, units_done, units_dead FROM cycle_runs WHERE cycle_code = $1 ORDER BY period_key`, [code]);
      assert.deepEqual(runs.map((x) => x.period_key), ["2026-10-02", "2026-10-03", "2026-10-04"], code);
      for (const run of runs) {
        assert.equal(run.as_of_date, run.period_key);
        const [row] = await s.db.query<{ offset_ms: string }>(`SELECT offset_ms::text AS offset_ms FROM demo_clock WHERE (demo_now AT TIME ZONE 'America/New_York')::date = $1::date ORDER BY id DESC LIMIT 1`, [run.period_key]);
        assert.equal(run.demo_offset_ms, row!.offset_ms, `${code} ${run.period_key} planned under the step's offset`);
        const notDone = await s.db.query(`SELECT unit_id, status, attempts, last_error_class, last_error FROM jobs WHERE cycle_code = $1 AND period_key = $2 AND status <> 'done'`, [code, run.period_key]);
        assert.equal(run.status, "completed", `${code} ${run.period_key}: ${JSON.stringify(run)} ${JSON.stringify(notDone)}`);
      }
    }
    // every receipt of day N precedes day N+1's cycle.run.opened in loan_events.sequence
    for (const [n, next] of [["2026-10-02", "2026-10-03"], ["2026-10-03", "2026-10-04"]]) {
      const [last] = await s.db.query<{ s: string }>(`SELECT max(sequence)::text AS s FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = $2`, [EV.run_completed, n]);
      const [first] = await s.db.query<{ s: string }>(`SELECT min(sequence)::text AS s FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = $2`, [EV.run_opened, next]);
      assert.ok(Number(last!.s) < Number(first!.s), `${n}'s receipts (≤ ${last!.s}) precede ${next}'s opened (≥ ${first!.s})`);
    }
    // every lease written during the advance is wall clock: within 5 minutes of real_now, not of demo_now (400 days ahead would not expire it)
    const claims = await evs(s.db, EV.unit_claimed);
    assert.ok(claims.length >= loans.length * 3, `claims ${claims.length}`);
    const after = Date.now();
    for (const c of claims) {
      const leaseMs = Date.parse(String(c.payload["lease_until"]));
      assert.ok(leaseMs >= before && leaseMs <= after + 5 * 60_000 + 1_000, `lease_until ${String(c.payload["lease_until"])} within 5 minutes of the wall clock`);
      assert.ok(Math.abs(leaseMs - Date.parse(ET_NOON("2026-10-03"))) > 6 * 60 * 60_000, "not within 5 minutes of demo_now");
    }
  } finally { await s.close(); }
});

test("35.3-T9: Given loan L with UPB $248,310.55, note rate 6.500%, P&I $1,612.34, escrow payment $432.78, an installment due 2026-10-01 unpaid past the 15-day grace and a late charge assessed at 5% of P&I, when the `statements` unit for `(L, 2026-10-01)` runs through `cycles.run_unit` on 2026-10-17, then the statement's late charge is $80.62, its interest portion $1,345.02, its principal portion $267.32 and its amount due $2,125.74, `statement.sent` and `job.unit.done` share one transaction (one `loan_events` batch), the decision names `disclosures`, exactly one `notices` row exists for `(L, 2026-10-01)` after a second plan and a second `cycles.run_unit` of the same job (refused `JOB_NOT_CLAIMABLE`), and the receipt reads `units_total 1, units_done 1`.", { skip }, async () => {
  // worked example A — every bold figure, to the cent, against the section's own constants
  const UPB = 24_831_055n, PI = 161_234n, ESCROW = 43_278n, LATE_CHARGE = 8_062n, INTEREST = 134_502n, PRINCIPAL = 26_732n, AMOUNT_DUE = 212_574n;
  assert.deepEqual({ ...WORKED_EXAMPLE_A }, { upb_cents: UPB, pi_cents: PI, escrow_cents: ESCROW, late_charge_cents: LATE_CHARGE, interest_cents: INTEREST, principal_cents: PRINCIPAL, amount_due_cents: AMOUNT_DUE, note_rate_bps: 65000 });
  const clk = new FixedClock(ET_NOON("2026-10-17"));
  const s = await side("t9", {}, clk);
  try {
    const L = await loanL(s);
    const plan = await planCycles(s.rt, { as_of: clk.now(), planned_by: "test", cycle_codes: ["cashiering_daily", "statements"] });
    assert.equal(plan.jobs_planned, 2, JSON.stringify(plan));
    const stmtJob = await jobOf(s.db, "statements", L); assert.equal(stmtJob.status, "blocked", "the statement waits for the day's cashiering (the late charge is on the statement)");
    assert.deepEqual((await s.db.query<{ k: string; input: Record<string, unknown> }>(`SELECT idempotency_key AS k, input FROM jobs WHERE id = $1`, [stmtJob.id]))[0], { k: `statements:2026-10-01:${L}`, input: { cycle_due_date: "2026-10-01", statement_date: "2026-10-17", courtesy_period_end: "2026-10-16" } });
    // the executor: 2.7 assesses the late charge (grace ended yesterday) in the cashiering unit, whose receipt unblocks the statement unit through cycles.run_unit
    const d = await drainQueue(s.rt, { holder: "e", deadlineMs: null });
    assert.equal(d.done, 2, JSON.stringify(d.results.map((r) => (r.status === "done" ? r.report.outcome : r.failure))));
    const sent = await evs(s.db, "statement.sent", `AND loan_id = $2`, [L]); assert.equal(sent.length, 1);
    const [notice] = await s.db.query<{ payload: Record<string, unknown>; n: string }>(`SELECT payload, (SELECT count(*) FROM notices x WHERE x.loan_id = $1 AND x.template_code = 'NTC_REGZ_41_STMT_STD' AND x.payload->>'due_date' = '2026-10-01')::text AS n FROM notices WHERE id = $2`, [L, String(sent[0]!.payload["notice_id"])]);
    assert.equal(notice!.n, "1", "exactly one notices row for (L, 2026-10-01)");
    const p = notice!.payload; const cents = (k: string): bigint => BigInt(String(p[k]));
    assert.equal(cents("late_charges_due_cents"), LATE_CHARGE); assert.equal(cents("late_fee_cents"), LATE_CHARGE);
    assert.equal(cents("interest_cents"), INTEREST); assert.equal(cents("principal_cents"), PRINCIPAL); assert.equal(cents("escrow_cents"), ESCROW); assert.equal(cents("amount_due_cents"), AMOUNT_DUE); assert.equal(cents("upb_cents"), UPB);
    // statement.sent and job.unit.done share one transaction (one loan_events batch)
    const done = await evs(s.db, EV.unit_done, `AND aggregate_id = $2`, [stmtJob.id]); assert.equal(done.length, 1);
    assert.equal(done[0]!.xid, sent[0]!.xid, "one transaction"); assert.equal(done[0]!.actor_id, "disclosures");
    const [decision] = await s.db.query<{ agent: string; prompt_version: string; subject_kind: string }>(`SELECT agent, prompt_version, subject_kind FROM agent_decisions WHERE id = (SELECT decision_id FROM jobs WHERE id = $1)`, [stmtJob.id]);
    assert.deepEqual(decision, { agent: "disclosures", prompt_version: "35.3-v1", subject_kind: "statements" });
    // a second plan inserts nothing; a second cycles.run_unit of the same job is refused JOB_NOT_CLAIMABLE
    const plan2 = await planCycles(s.rt, { as_of: clk.now(), planned_by: "test", cycle_codes: ["cashiering_daily", "statements"] });
    assert.equal(plan2.jobs_planned, 0); assert.equal(plan2.runs_opened, 0);
    await assert.rejects(s.rt.execute({ process: "35.3", name: RUN_UNIT_TOOL, loanId: L, actor: OPS, input: { job_id: stmtJob.id } }), (e: unknown) => e instanceof CommandRefused && e.code === "JOB_NOT_CLAIMABLE");
    assert.equal(await count(s.db, `FROM notices WHERE loan_id = $1 AND template_code = 'NTC_REGZ_41_STMT_STD' AND payload->>'due_date' = '2026-10-01'`, [L]), 1);
    const [receipt] = await s.db.query<{ units_total: number; units_done: number }>(`SELECT units_total, units_done FROM cycle_receipts WHERE cycle_code = 'statements' AND period_key = '2026-10-01'`);
    assert.deepEqual(receipt, { units_total: 1, units_done: 1 });
  } finally { await s.close(); }
});

test("35.3-T10: Given a job claimed with `lease_until` 5 minutes ahead by an executor that then stops heartbeating, when `now()` passes `lease_until` and the planner runs, then the job is `queued` again, `job.lease.expired{holder, attempt: 1}` is appended, `attempts` is 1, and a second executor's claim runs it to `done` with `attempt: 2`; given the demo clock is advanced 30 days while the first lease is live, then the lease is not expired by the advance.", { skip }, async () => {
  const defs = [tdef("t10_unit"), tdef("t10_live")];
  const s = await side("t10", { cycles: cfg(defs, { t10_unit: unitsOf(1), t10_live: unitsOf(1) }, { t10_unit: noop, t10_live: noop }) });
  try {
    await planCycles(s.rt, { as_of: NOW, planned_by: "test", cycle_codes: ["t10_unit"] });
    const c = await claimJobs(s.rt, "exec-1", 20); assert.equal(c.claimed.length, 1);
    const claimed = await jobOf(s.db, "t10_unit"); assert.equal(claimed.status, "running"); assert.equal(claimed.attempts, 1);
    const [lease] = await s.db.query<{ ahead: string }>(`SELECT extract(epoch FROM (lease_until - now()))::text AS ahead FROM jobs WHERE id = $1`, [claimed.id]);
    assert.ok(Number(lease!.ahead) > 290 && Number(lease!.ahead) <= 300, `lease 5 minutes ahead (${lease!.ahead})`);
    // the executor stops heartbeating and now() passes lease_until: the planner reclaims it
    await s.db.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [claimed.id]);
    const plan = await planCycles(s.rt, { as_of: NOW, planned_by: "test", cycle_codes: [] });
    assert.equal(plan.leases_reclaimed, 1);
    const requeued = await jobOf(s.db, "t10_unit"); assert.equal(requeued.status, "queued"); assert.equal(requeued.attempts, 1); assert.equal(requeued.lease_holder, null);
    const expired = await evs(s.db, EV.lease_expired, `AND aggregate_id = $2`, [claimed.id]);
    assert.equal(expired.length, 1); assert.equal(expired[0]!.payload["holder"], "exec-1"); assert.equal(expired[0]!.payload["attempt"], 1);
    // a second executor's claim runs it to done with attempt 2
    const d = await drainQueue(s.rt, { holder: "exec-2", deadlineMs: null });
    assert.equal(d.done, 1);
    const doneJob = await jobOf(s.db, "t10_unit"); assert.equal(doneJob.status, "done"); assert.equal(doneJob.attempts, 2);
    const doneEv = await evs(s.db, EV.unit_done, `AND aggregate_id = $2`, [claimed.id]); assert.equal(doneEv[0]!.payload["attempt"], 2);
    assert.deepEqual((await s.db.query<{ holder: string; attempt: number }>(`SELECT holder, attempt FROM job_events WHERE job_id = $1 AND kind = 'claimed' ORDER BY id`, [claimed.id])), [{ holder: "exec-1", attempt: 1 }, { holder: "exec-2", attempt: 2 }]);
    // a live lease survives a 30-day demo advance: the lease is wall clock, never the demo clock
    await planCycles(s.rt, { as_of: NOW, planned_by: "test", cycle_codes: ["t10_live"] });
    const live = await claimJobs(s.rt, "exec-1", 20); assert.equal(live.claimed.length, 1);
    const liveBefore = await jobOf(s.db, "t10_live");
    const demoClock = new OffsetClock(systemClock);
    const demoRt = s.make({ clock: demoClock });
    // the first executor keeps heartbeating its live lease (rule 6: every 30 s) while the demo clock is advanced 30 days
    const beat = setInterval(() => { void heartbeatSql(s.db, "exec-1", [liveBefore.id]).catch(() => undefined); }, 5_000);
    let adv: Awaited<ReturnType<typeof advanceDemoClock>>;
    try { adv = await advanceDemoClock({ runtime: demoRt, clock: demoClock, actor: "system:test" }, { days: 30 }); } finally { clearInterval(beat); }
    assert.equal(adv.days_crossed, 30);
    const liveAfter = await jobOf(s.db, "t10_live", "u001");
    assert.equal(liveAfter.id, liveBefore.id);
    assert.equal(liveAfter.status, "running", JSON.stringify(liveAfter)); assert.equal(liveAfter.lease_holder, "exec-1", JSON.stringify({ liveAfter, liveBefore, adv: adv.steps.map((x) => x.cycles) })); assert.ok(Date.parse(liveAfter.lease_until!) >= Date.parse(liveBefore.lease_until!), "the lease was extended by the heartbeat, never expired"); assert.equal(liveAfter.attempts, 1);
    assert.equal((await evs(s.db, EV.lease_expired, `AND aggregate_id = $2`, [liveBefore.id])).length, 0, "not expired by the advance");
  } finally { await s.close(); }
});

test("35.3-T11: Given a def registered with `expected_by_rule: same_day 23:59 ET` and no run ever, when the planner runs the next morning, then no `timers` row names the cycle (the engine arms only on a trigger event), `cycle_registry.overdue_since` is set to the first pass after 23:59 ET, `cycles.registry{op: list}` returns the row first with `next_expected_by` and `overdue_since`, and no escalation was opened by this process (35.11 opens it).", { skip }, async () => {
  const def = tdef("t11_never", { expected_by: "same_day 23:59 ET" });
  const broken: Selector = async () => { throw new Error("selector: the typed rows are unreachable"); };
  const clk = new FixedClock(ET_NOON("2026-10-01"));
  const s = await side("t11", { cycles: cfg([def], { t11_never: broken }, { t11_never: noop }) }, clk);
  try {
    const p1 = await planCycles(s.rt, { as_of: clk.now(), planned_by: "test" });
    assert.deepEqual(p1.errors.map((e) => `${e.cycle_code}:${e.error_class}`), ["t11_never:selector_error"]);
    assert.deepEqual(p1.overdue, []);
    await drainQueue(s.rt, { holder: "e", deadlineMs: null });
    assert.equal(await count(s.db, `FROM cycle_runs WHERE cycle_code = 't11_never'`), 0, "no run ever");
    // the next morning: no timers row names the cycle (the engine arms only on a trigger event); overdue_since is the first pass after 23:59 ET
    clk.set("2026-10-02T12:00:00.000Z");   // 08:00 ET
    const p2 = await planCycles(s.rt, { as_of: clk.now(), planned_by: "test" });
    assert.deepEqual(p2.overdue, ["t11_never"]);
    assert.equal(await count(s.db, `FROM timers WHERE subject_id LIKE '%t11_never%' OR note LIKE '%t11_never%' OR code LIKE '%T11%'`), 0);
    const [row] = await s.db.query<{ overdue_since: string; next_expected_by: string; last_error_class: string }>(`SELECT overdue_since::text AS overdue_since, next_expected_by::text AS next_expected_by, last_error_class FROM cycle_registry WHERE cycle_code = 't11_never'`);
    assert.equal(Date.parse(row!.overdue_since), Date.parse(clk.now()), "set to the first pass after 23:59 ET"); assert.equal(row!.last_error_class, "selector_error");
    assert.equal(Date.parse(row!.next_expected_by), Date.parse("2026-10-03T03:59:00.000Z"), "today's 23:59 ET");
    // cycles.registry{op: list} returns the row first with next_expected_by and overdue_since
    const list = await s.rt.execute({ process: "35.3", name: "cycles.registry", loanId: "", actor: OPS, input: { op: "list" } });
    const rows = (list.output as { rows: Record<string, unknown>[] }).rows;
    assert.equal(rows[0]!["cycle_code"], "t11_never"); assert.ok(rows[0]!["next_expected_by"]); assert.ok(rows[0]!["overdue_since"]);
    // no escalation was opened by this process (35.11 opens it)
    assert.equal(await count(s.db, `FROM escalations WHERE payload->>'cycle_code' = 't11_never'`), 0);
    assert.equal(await count(s.db, `FROM escalations`), 0);
  } finally { await s.close(); }
});

test("35.3-T12: Given a run opened at 2026-10-01 12:00 ET with one unit `blocked` on an event that never arrives, when the sweep runs at 2026-10-02 12:01 ET, then `SM_CYCLE_RUN_STALLED_1D` breaches with one `ops_analyst` escalation whose payload names `cycle_code`, `period_key`, `units_done 0` and `units_total 1`; when the event arrives and the unit completes, then `cycle.run.completed` satisfies the clock as `satisfied_late` and the escalation is completable through 34.4 with the disposition `completed_late`.", { skip }, async () => {
  const def = tdef("t12_blocked", { depends_on: [{ event: "t12.event.arrived", key: "period_key" }] });
  const clk = new FixedClock(ET_NOON("2026-10-01"));
  const s = await side("t12", { cycles: cfg([def], { t12_blocked: async (_db, w) => (w.as_of_date === "2026-10-01" ? [{ period_key: "2026-10-01", unit_id: "global" }] : []) }, { t12_blocked: noop }) }, clk);
  try {
    const r1 = await s.rt.sweep(clk.now()); assert.equal(r1.outcome, "completed");
    const run = await runOf(s.db, "t12_blocked", "2026-10-01"); assert.equal(run.units_total, 1); assert.equal((await jobOf(s.db, "t12_blocked")).status, "blocked");
    const [armed] = await s.db.query<{ id: string; status: string; due_at: string }>(`SELECT id, status, due_at::text AS due_at FROM timers WHERE code = 'SM_CYCLE_RUN_STALLED_1D' AND subject_id = $1`, [run.id]);
    assert.equal(armed!.status, "armed"); assert.equal(Date.parse(armed!.due_at), Date.parse("2026-10-02T15:59:00.000Z"), "the calendar day's last sweep minute after the 12:00 ET opening");
    // the sweep at 2026-10-02 12:01 ET: the stall clock breaches with one ops_analyst escalation naming the run
    clk.set("2026-10-02T16:01:00.000Z");
    const r2 = await s.rt.sweep(clk.now());
    assert.ok(r2.breaches.some((b) => b.code === "SM_CYCLE_RUN_STALLED_1D" && b.timer_id === armed!.id), JSON.stringify(r2.breaches));
    const esc = await s.db.query<{ id: string; owner_role: string; payload: Record<string, unknown> }>(`SELECT id, owner_role, payload FROM escalations WHERE sla_timer_id = $1`, [armed!.id]);
    assert.equal(esc.length, 1); assert.equal(esc[0]!.owner_role, "ops_analyst");
    assert.equal(esc[0]!.payload["cycle_code"], "t12_blocked"); assert.equal(esc[0]!.payload["period_key"], "2026-10-01"); assert.equal(esc[0]!.payload["units_done"], 0); assert.equal(esc[0]!.payload["units_total"], 1);
    // the event arrives and the unit completes: cycle.run.completed satisfies the clock as satisfied_late
    await appendGlobal(s.rt, "t12.event.arrived", { period_key: "2026-10-01" });
    clk.set("2026-10-02T16:02:00.000Z");
    const r3 = await s.rt.sweep(clk.now()); assert.ok((r3.cycles.plan?.unblocked ?? 0) + (r3.cycles.execute?.unblocked ?? 0) >= 1, JSON.stringify(r3.cycles));
    assert.equal((await runOf(s.db, "t12_blocked", "2026-10-01")).status, "completed");
    const [late] = await s.db.query<{ status: string }>(`SELECT status FROM timers WHERE id = $1`, [armed!.id]); assert.equal(late!.status, "satisfied_late");
    // the escalation is completable through 34.4 with the disposition completed_late
    const staffId = (await s.db.query<{ id: string }>(`INSERT INTO staff_users (email_hash, email_encrypted, legal_name, roles, status, enrolled_at) VALUES ($1, $2, 'Ana Lyst', ARRAY['ops_analyst'], 'active', $3) RETURNING id::text AS id`, [`sha256:${randomUUID()}`, Buffer.from("FAKE-encrypted"), clk.now()]))[0]!.id;
    const done = await completeEscalation(s.rt, { id: esc[0]!.id, disposition: "completed_late", reason: "the run completed after the clock", actor: { kind: "human", id: staffId, role: "ops_analyst" } }, clk.now());
    assert.equal(done.disposition, "completed_late"); assert.equal(done.completed_by_role, "ops_analyst");
    assert.equal(await count(s.db, `FROM escalations WHERE id = $1 AND completed_at IS NOT NULL`, [esc[0]!.id]), 1);
  } finally { await s.close(); }
});

test("35.3-T13: Given `cycles.run_unit` is called with an `input` carrying `state`, `custodial`, any `*_cents` key or `changes`, then it is refused `NO_CLIENT_STATE` before any row or event is written; given `jobs.requeue{op: requeue}` on a dead job by an actor `{kind: \"agent\"}`, then `ROLE_REQUIRED{ops_analyst}` and the job stays `dead`; given an `ops_analyst` requeues it with a reason, then `job.unit.resolved` is appended, the decision names the person and the reason, and the ledger and every money column are byte-identical before and after every 35.3 tool call in a contract test over all nine tools.", { skip }, async () => {
  const unavailable: Runner = { kind: "unit", run: async () => { const e = new Error("the FAKE port is down"); e.name = "TransientFailure"; throw e; } };
  let flaky = 0; const flakyRunner: Runner = { kind: "unit", run: async () => { flaky += 1; if (flaky === 1) throw new Error("first attempt fails"); return { outcome: "done" }; } };
  const defs = [tdef("t13_dead"), tdef("t13_dead2"), tdef("t13_free"), tdef("t13_flaky")];
  const s = await side("t13", { cycles: cfg(defs, { t13_dead: unitsOf(1), t13_dead2: unitsOf(1), t13_free: unitsOf(1), t13_flaky: unitsOf(1) }, { t13_dead: unavailable, t13_dead2: unavailable, t13_free: noop, t13_flaky: flakyRunner }) });
  try {
    const rt = s.rt; const q = s.db;
    const exec = (name: string, input: Record<string, unknown>, actor: Actor = OPS) => rt.execute({ process: "35.3", name, loanId: "", actor, input });
    // NO_CLIENT_STATE: refused before any row or event is written
    const events0 = await count(q, `FROM loan_events`); const jobs0 = await count(q, `FROM jobs`);
    for (const input of [{ job_id: randomUUID(), state: { upb_cents: 1n } }, { job_id: randomUUID(), custodial: { pi: "x" } }, { job_id: randomUUID(), amount_cents: 5n }, { job_id: randomUUID(), changes: { pi_cents: 1n } }]) {
      await assert.rejects(exec(RUN_UNIT_TOOL, input), (e: unknown) => e instanceof CommandRefused && e.code === "NO_CLIENT_STATE");
    }
    assert.equal(await count(q, `FROM loan_events`), events0); assert.equal(await count(q, `FROM jobs`), jobs0);
    // a dead job (an unavailable-class failure goes dead at once)
    await planCycles(rt, { as_of: NOW, planned_by: "test", cycle_codes: ["t13_dead", "t13_dead2", "t13_flaky"] });
    const drained = await drainQueue(rt, { holder: "e", deadlineMs: null }); assert.equal(drained.dead, 2); assert.equal(drained.failed, 1); assert.equal(drained.done, 0);
    const dead = await jobOf(q, "t13_dead"); assert.equal(dead.status, "dead");
    // an agent actor is refused ROLE_REQUIRED{ops_analyst}; the job stays dead
    await assert.rejects(exec("jobs.requeue", { job_id: dead.id, op: "requeue", reason: "agent retry" }), (e: unknown) => e instanceof CommandRefused && e.code === "ROLE_REQUIRED" && /ops_analyst/.test(e.message));
    assert.equal((await jobOf(q, "t13_dead")).status, "dead");
    // an ops_analyst requeues it with a reason: job.unit.resolved, and the decision names the person and the reason
    const requeue = await exec("jobs.requeue", { job_id: dead.id, op: "requeue", reason: "the FAKE port is back" }, ANALYST);
    assert.equal((requeue.output as { status: string }).status, "queued");
    const resolved = await evs(q, EV.unit_resolved, `AND aggregate_id = $2`, [dead.id]);
    assert.equal(resolved.length, 1); assert.equal(resolved[0]!.payload["disposition"], "requeued"); assert.equal(resolved[0]!.payload["by"], "human:u-ops-lee");
    const [decision] = await q.query<{ approved_by: string; approved_role: string; rationale: string }>(`SELECT approved_by, approved_role, rationale FROM agent_decisions WHERE action = 'jobs.requeue' AND subject_id = $1`, [dead.id]);
    assert.equal(decision!.approved_by, "u-ops-lee"); assert.equal(decision!.approved_role, "ops_analyst"); assert.match(decision!.rationale, /the FAKE port is back/); assert.match(decision!.rationale, /u-ops-lee/);
    assert.equal((await jobOf(q, "t13_dead")).attempts, 0);
    // the contract: the ledger and every money column are byte-identical before and after every 35.3 tool call, over all nine tools
    await planCycles(rt, { as_of: NOW, planned_by: "test", cycle_codes: ["t13_free"] });
    const free = await jobOf(q, "t13_free"); assert.equal(free.status, "queued");
    const flakyJob = await jobOf(q, "t13_flaky"); assert.equal(flakyJob.status, "failed");
    const dead2 = await jobOf(q, "t13_dead2"); assert.equal(dead2.status, "dead");
    const calls: [string, Record<string, unknown>, Actor][] = [
      ["cycles.registry", { op: "list" }, OPS], ["cycles.plan", { as_of: NOW }, OPS], [RUN_UNIT_TOOL, { job_id: free.id }, OPS], ["cycles.receipt", { run_id: free.run_id }, OPS],
      ["cycles.retry", { job_id: flakyJob.id }, OPS], ["cycles.escalate", { job_id: dead2.id, reason: "a dead unit needs a person" }, OPS], ["jobs.list", { cycle_code: "t13_free" }, OPS],
      ["jobs.requeue", { job_id: dead2.id, op: "abandon", reason: "not worth a retry" }, ANALYST], ["writeDecision", { action: "cycles.plan", rationale: "contract test", subject: { kind: "planner_run", id: randomUUID() } }, OPS]];
    assert.equal(calls.length, 9); assert.deepEqual(calls.map((c) => c[0]).sort(), TOOLS_35_3.map((t) => t.name).sort());
    for (const [name, input, actor] of calls) {
      const before = await moneyDigest(q);
      const r = await exec(name, input, actor);
      assert.ok(r.event.type === "command.executed", name);
      assert.equal(await moneyDigest(q), before, `${name}: the ledger and every money column are byte-identical`);
    }
    assert.equal((await jobOf(q, "t13_free")).status, "done"); assert.equal((await jobOf(q, "t13_dead2")).status, "abandoned");
  } finally { await s.close(); }
});

test("35.3-T14: Given `SM_CYCLE_PLANNER_DAILY` armed on the global subject by the first `cycles.plan.run_completed`, when a day passes with `cycles.plan` never completing (every pass `cycles.plan.skipped` because a test holds key 35003), then the clock breaches at 23:59 ET with one `ops_analyst` escalation and 35.1's `SM_SWEEP_HEARTBEAT_DAILY` did not breach; when the lock is released and a pass completes, then the clock is satisfied and re-armed for the next day and only one armed global instance of the code exists.", { skip }, async () => {
  const clk = new FixedClock("2026-10-01T14:00:00.000Z");   // 10:00 ET
  const s = await side("t14", {}, clk);
  try {
    const r1 = await s.rt.sweep(clk.now()); assert.equal(r1.outcome, "completed"); assert.equal(r1.cycles.plan?.skipped, false);
    const armedFirst = await s.db.query<{ id: string; due_at: string; subject_kind: string }>(`SELECT id, due_at::text AS due_at, subject_kind FROM timers WHERE code = 'SM_CYCLE_PLANNER_DAILY' AND status = 'armed'`);
    assert.equal(armedFirst.length, 1); assert.equal(armedFirst[0]!.subject_kind, "global"); assert.equal(Date.parse(armedFirst[0]!.due_at), Date.parse("2026-10-03T03:59:00.000Z"), "2026-10-02 23:59 ET");
    // a day passes with every pass skipped: a test holds key 35003
    const lock = await holdPlannerLock(s.url);
    try {
      for (const at of ["2026-10-02T14:00:00.000Z", "2026-10-02T22:00:00.000Z", "2026-10-03T04:00:00.000Z"]) { clk.set(at); const r = await s.rt.sweep(clk.now()); assert.equal(r.outcome, "completed"); assert.equal(r.cycles.plan?.skipped, true, at); }
    } finally { await lock.release(); }
    assert.equal(await count(s.db, `FROM loan_events WHERE type = $1`, [EV.plan_skipped]), 3);
    const breached = await s.db.query<{ status: string }>(`SELECT status FROM timers WHERE id = $1`, [armedFirst[0]!.id]); assert.equal(breached[0]!.status, "breached");
    const esc = await s.db.query<{ owner_role: string }>(`SELECT owner_role FROM escalations WHERE sla_timer_id = $1`, [armedFirst[0]!.id]); assert.deepEqual(esc, [{ owner_role: "ops_analyst" }]);
    assert.equal(await count(s.db, `FROM timers WHERE code = 'SM_SWEEP_HEARTBEAT_DAILY' AND status = 'breached'`), 0, "35.1's heartbeat did not breach: the sweep ran every time");
    // the lock is released and a pass completes: the clock is satisfied and re-armed for the next day; one armed global instance of the code
    clk.set("2026-10-03T04:05:00.000Z");
    const r5 = await s.rt.sweep(clk.now()); assert.equal(r5.cycles.plan?.skipped, false);
    const late = await s.db.query<{ status: string }>(`SELECT status FROM timers WHERE id = $1`, [armedFirst[0]!.id]); assert.equal(late[0]!.status, "satisfied_late");
    const armedNow = await s.db.query<{ due_at: string; subject_kind: string }>(`SELECT due_at::text AS due_at, subject_kind FROM timers WHERE code = 'SM_CYCLE_PLANNER_DAILY' AND status = 'armed'`);
    assert.equal(armedNow.length, 1); assert.equal(armedNow[0]!.subject_kind, "global"); assert.equal(Date.parse(armedNow[0]!.due_at), Date.parse("2026-10-05T03:59:00.000Z"), "re-armed for 2026-10-04 23:59 ET");
  } finally { await s.close(); }
});

test("35.3-T15: Given the planner's last pass was on 2026-09-30 and the demo clock steps to 2026-10-01, when the first pass of October runs, then exactly one `ledger.month.ended{period_key: 2026-09, period_end: 2026-09-30}` exists on the global subject, a second October pass appends none, and 35.4's `SM_CLOSE_PERIOD_OPEN_BD1` is armed on it.", { skip }, async () => {
  const clk = new FixedClock(ET_NOON("2026-09-30"));
  const s = await side("t15", {}, clk);
  try {
    const sept = await planCycles(s.rt, { as_of: clk.now(), planned_by: "test" }); assert.equal(sept.skipped, false);
    assert.equal(await count(s.db, `FROM loan_events WHERE type = $1 AND payload->>'period_key' = '2026-09'`, [EV.month_ended]), 0);
    // the first pass of October closes September, exactly once
    clk.set(ET_NOON("2026-10-01"));
    const oct = await planCycles(s.rt, { as_of: clk.now(), planned_by: "test" }); assert.equal(oct.month_ended, "2026-09");
    const ended = await evs(s.db, EV.month_ended, `AND payload->>'period_key' = '2026-09'`);
    assert.equal(ended.length, 1); assert.equal(ended[0]!.payload["period_end"], "2026-09-30"); assert.equal(ended[0]!.aggregate_kind, "cycle_run");
    assert.equal(await count(s.db, `FROM loan_events WHERE type = $1 AND loan_id IS NULL AND application_id IS NULL AND payload->>'period_key' = '2026-09'`, [EV.month_ended]), 1, "on the global subject");
    // a second October pass appends none
    const oct2 = await planCycles(s.rt, { as_of: "2026-10-01T18:00:00.000Z", planned_by: "test" }); assert.equal(oct2.month_ended, null);
    assert.equal((await evs(s.db, EV.month_ended, `AND payload->>'period_key' = '2026-09'`)).length, 1);
    assert.equal(await count(s.db, `FROM cycle_runs WHERE cycle_code = 'month_end' AND period_key = '2026-09'`), 1);
    // 35.4's SM_CLOSE_PERIOD_OPEN_BD1 is armed on it
    const armed = await s.db.query<{ status: string; anchor_date: string; armed_by_event_id: string }>(`SELECT status, anchor_date::text AS anchor_date, armed_by_event_id FROM timers WHERE code = 'SM_CLOSE_PERIOD_OPEN_BD1' AND armed_by_event_id = $1`, [ended[0]!.id]);
    assert.deepEqual(armed, [{ status: "armed", anchor_date: "2026-09-30", armed_by_event_id: ended[0]!.id }]);
  } finally { await s.close(); }
});

test("35.3-T16: Given the registered bus pair (`35.3`, `cycles.run_unit`) and a `metro2_monthly` job for `2026-09`, when it runs, then 8.1's snapshot builder is invoked with `as_of_date 2026-09-30` under the actor `{agent, credit-reporting}`, `credit.cycle.snapshot_completed` is appended by 8.1's own code (credit-reporting/ops.ts:214-218) in the same transaction as `job.unit.done`, no `(8.1, *)` bus pair was needed, and the decision record's `prompt_version` is `35.3-v1` with `subject_kind metro2_monthly`.", { skip }, async () => {
  const clk = new FixedClock(ET_NOON("2026-09-30"));
  const s = await side("t16", {}, clk);
  try {
    assert.ok(s.rt.tool("35.3", RUN_UNIT_TOOL), "the registered bus pair (35.3, cycles.run_unit)");
    await planCycles(s.rt, { as_of: clk.now(), planned_by: "test", cycle_codes: ["cashiering_daily"] });
    await drainQueue(s.rt, { holder: "e", deadlineMs: null });
    clk.set("2026-10-01T04:06:00.000Z");   // 00:06 ET on the 1st
    const plan = await planCycles(s.rt, { as_of: clk.now(), planned_by: "test", cycle_codes: ["metro2_monthly"] });
    assert.equal(plan.jobs_planned, 1, JSON.stringify(plan));
    const job = await jobOf(s.db, "metro2_monthly"); assert.equal(job.status, "queued"); assert.equal(await count(s.db, `FROM jobs WHERE id = $1 AND period_key = '2026-09'`, [job.id]), 1);
    const d = await drainQueue(s.rt, { holder: "e", deadlineMs: null });
    assert.equal(d.done, 1, JSON.stringify(d.results.map((r) => (r.status === "done" ? r.report : r.failure))));
    // 8.1's snapshot builder ran as of 2026-09-30 under {agent, credit-reporting}; credit.cycle.snapshot_completed by 8.1's own code in the same transaction as job.unit.done
    const snap = await evs(s.db, "credit.cycle.snapshot_completed"); assert.equal(snap.length, 1);
    assert.equal(snap[0]!.payload["as_of_date"], "2026-09-30"); assert.equal(snap[0]!.actor_kind, "agent"); assert.equal(snap[0]!.actor_id, "credit-reporting"); assert.equal(snap[0]!.payload["cycle_id"], "metro2-2026-09");
    const done = await evs(s.db, EV.unit_done, `AND aggregate_id = $2`, [job.id]); assert.equal(done.length, 1); assert.equal(done[0]!.xid, snap[0]!.xid, "one transaction");
    // no (8.1, *) bus pair was needed
    assert.equal(await count(s.db, `FROM loan_events WHERE type = 'command.executed' AND payload->>'process' = '8.1'`), 0);
    const [decision] = await s.db.query<{ agent: string; prompt_version: string; subject_kind: string; subject_id: string; rule_set_version: string; model_version: string }>(`SELECT agent, prompt_version, subject_kind, subject_id, rule_set_version, model_version FROM agent_decisions WHERE id = (SELECT decision_id FROM jobs WHERE id = $1)`, [job.id]);
    assert.deepEqual(decision, { agent: "credit-reporting", prompt_version: "35.3-v1", subject_kind: "metro2_monthly", subject_id: "global", rule_set_version: "cycles.v1", model_version: "deterministic" });
  } finally { await s.close(); }
});
