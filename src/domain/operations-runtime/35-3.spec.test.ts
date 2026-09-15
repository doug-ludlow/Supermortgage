// 35.3 Cycles, jobs and receipts: the planner, the jobs table, `cycles.run_unit` on the bus and the registry of every scheduled cycle
// spec/sections/35-operations-runtime/35-3-cycles-jobs-and-receipts.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgLoanRepository } from "../../infra/db/loans.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { NoticeService } from "../../notices/service.ts";
import { StatementCycleService } from "../notices/ops-7-1.ts";
import { Runtime } from "../../runtime/app.ts";
import { createLogger } from "../../runtime/log.ts";
import { loadDemoClock } from "../../runtime/demo-clock.ts";
import { CommandRefused } from "../../app/commands.ts";
import { AdapterUnavailable } from "../../infra/integrations/failures.ts";
import type { FakeCustodialBank } from "../../infra/integrations/banking.ts";
import { PgStaffRepository, emailHash, encryptEmail, staffEmailKey } from "../../runtime/staff/repo.ts";
import { moneyFingerprint } from "../../runtime/controls/common.ts";
import { CASHIERING_AGENT, loanCashState } from "../../runtime/servicing.ts";
import { advanceDemoClock } from "../../runtime/demo-clock.ts";
import { periodClosedEvent } from "../custodial/ops.ts";
import { lateChargeAmount } from "../cashiering/latecharges.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { CYCLES } from "./runners.ts";
import { EVT, def as cycleDef, selectors, type CycleDef, type NamedRunner } from "./cycles.ts";
import { CyclesRefused, OPS_STEWARD, cyclesOf, cyclesSweepPass, installCycles, runClaimed, runExecutor, runUnitByHand, type CyclesHooks } from "./service.ts";
import { claimJobs, wallClockOf } from "./jobs.ts";
import { PLANNER_LOCK_KEY } from "./planner-lock.ts";

// ───────── harness: one freshly provisioned database per test (src/infra/db/test-db.ts, suffixed — the executor drains a whole queue, so a test's world is its own), one Runtime per test over its own FixedClock
const probe = await testDatabase(import.meta.url, { provision: false });
const skip = probe.skip;
type Row = Record<string, unknown>;
let db: Db; let DB_URL = ""; let n = 0;
const open = async (suffix: string): Promise<void> => { const t = await testDatabase(import.meta.url, { suffix }); DB_URL = t.url; db = connect(DB_URL); };
const close = async (): Promise<void> => { await db.end(); };
const logLines: string[] = [];
const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error/i.test(line)) process.stderr.write(line + "\n"); });
const uniq = (): string => `${Date.now() % 1_000_000}${(n++).toString().padStart(3, "0")}`.padStart(10, "0");
const runtimeAt = (iso: string, defs?: readonly CycleDef[], hooks?: CyclesHooks): { rt: Runtime; clock: FixedClock } => {
  const clock = new FixedClock(iso);
  const rt = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: null, reviewers: null, analystLlm: null, databaseUrl: DB_URL });
  installCycles(rt, { ...(defs ? { defs } : {}), ...(hooks ? { hooks } : {}) });
  return { rt, clock };
};
const DISCLOSURES: Actor = { kind: "agent", id: "disclosures" };
const noop: NamedRunner = { name: "noop", runner: { mode: "in_command", run: () => ({ outcome: "noop" }) } };
/** A staff user with one role, enrolled (the controls.test.ts precedent) — the human actor of an ops_analyst's act. */
const staff = async (clock: FixedClock, email: string, role: "ops_analyst" | "officer"): Promise<Actor> => {
  const repo = new PgStaffRepository(db);
  const u = await repo.createUser({ email_hash: emailHash(email), email_encrypted: encryptEmail(email, staffEmailKey()), legal_name: email.split("@")[0]!, roles: [role], invited_by: null, now: clock.now() });
  await repo.markEnrolled(u.id, clock.now());
  return { kind: "human", id: u.id, role };
};
const jobOf = async (where: string, params: unknown[] = []): Promise<Row> => (await db.query<Row>(`SELECT id::text AS id, run_id::text AS run_id, cycle_code, period_key, unit_id, status, attempts, max_attempts, run_after, lease_holder, lease_until, last_error_class, decision_id::text AS decision_id, input, finished_at FROM jobs WHERE ${where} ORDER BY created_at, id`, params))[0]!;
/** A borrower party on the loan (`borrowers.party_id` → `loan_borrowers`, servicing.ts servicingParties reads them) with the property as the mailing address. */
const borrowerOn = async (loanId: string, name: string): Promise<string> => {
  const party = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('other', $1, '{}'::jsonb) RETURNING id`, [name]))[0]!.id;
  const b = (await db.query<{ id: string }>(`INSERT INTO borrowers (legal_name, tin_last4, party_id) VALUES ($1, '0001', $2) RETURNING id`, [name, party]))[0]!.id;
  await db.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, 'borrower', true)`, [loanId, b]);
  return party;
};
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
const events = async (type: string, where = "", params: unknown[] = []): Promise<{ id: string; sequence: bigint; loan_id: string | null; aggregate_kind: string | null; aggregate_id: string | null; actor_id: string; occurred_at: string; payload: Row }[]> =>
  db.query(`SELECT id::text AS id, sequence, loan_id::text AS loan_id, aggregate_kind, aggregate_id, actor_id, occurred_at, payload FROM loan_events WHERE type = $1 ${where} ORDER BY sequence`, [type, ...params]);
/** A boarded fixture loan with one `loan_terms` row (the plan's §4 shape: UPB 24,831,055 cents, note rate 6.500%, P&I 161,234 cents, escrow 43,278 cents, a 5% late charge with a 15-day grace). */
const boardedLoan = async (): Promise<string> => {
  const f = await new PgLoanRepository(db).createFixture({ fnmaLoanNumber: uniq(), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2026-08-15"), originalUpbCents: 24_831_055n, originalTermMonths: 360, firstPaymentDate: D("2026-10-01"), maturityDate: D("2056-09-01") });
  await db.query(`UPDATE loans SET boarded_at = now(), first_payment_date = '2026-10-01' WHERE id = $1`, [f.loanId]);
  await db.query(`INSERT INTO loan_terms (loan_id, effective_from, source, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, remittance_type, late_charge_pct_bps, late_charge_grace_days, maturity_date) VALUES ($1, '2026-09-01', 'boarding', 65000, 161234, 43278, true, 'A/A', 5000, 15, '2056-09-01')`, [f.loanId]);
  return f.loanId;
};
/** A dedicated client holding `pg_advisory_lock(35003)` on the application database — what a concurrently running planner looks like to the pass under test. */
const holdPlannerLock = async (holder: string): Promise<{ release(): Promise<void> }> => {
  const client = new pg.Client({ connectionString: DB_URL, application_name: `cycles.plan:${holder}` });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [PLANNER_LOCK_KEY]);
  let released = false;
  return { async release() { if (released) return; released = true; try { await client.query("SELECT pg_advisory_unlock($1)", [PLANNER_LOCK_KEY]); } finally { await client.end(); } } };
};
const advisoryLocks = (): Promise<number> => count(`pg_locks WHERE locktype = 'advisory' AND objid = ${PLANNER_LOCK_KEY} AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);


test("35.3-T1: Given two sweeps started within the same minute against one database, when both call `cycles.plan`, then exactly one holds `pg_try_advisory_lock(35_003)` and appends `cycles.plan.run_completed`, the other appends `cycles.plan.skipped{holder}` and its remaining passes still run, and after the holder's dedicated client ends `pg_locks` shows no advisory lock with key 35003.", { skip }, async () => {
  await open("t1");
  try {
    const { rt } = runtimeAt("2026-10-02T14:00:00.000Z");
    const svc = cyclesOf(rt);
    // (a) two sweeps within the same minute: exactly one holds pg_try_advisory_lock(35_003) and plans; the other is refused and skips — its remaining passes are its own business
    const [a, b] = await Promise.all([svc.plan(), svc.plan()]);
    const planned = [a, b].filter((r) => !r.skipped); const skipped = [a, b].filter((r) => r.skipped);
    assert.equal(planned.length, 1, `exactly one pass planned: ${JSON.stringify([a, b])}`); assert.equal(skipped.length, 1);
    const completed = await events(EVT.PLAN_COMPLETED); const refused = await events(EVT.PLAN_SKIPPED);
    assert.equal(completed.length, 1); assert.equal(refused.length, 1);
    assert.equal(completed[0]!.payload["as_of_date"], "2026-10-02"); assert.equal(completed[0]!.payload["origination"], true);
    // the skipped pass names the holder: the other planner's dedicated client (`application_name = cycles.plan:<planned_by>` read off pg_locks ⋈ pg_stat_activity)
    assert.equal(refused[0]!.payload["holder"], `cycles.plan:${planned[0]!.planned_by}`); assert.equal(skipped[0]!.holder, `cycles.plan:${planned[0]!.planned_by}`);
    assert.ok(planned[0]!.period_keys.length > 0, "the holder planned the day's cycles");
    assert.equal(await count(`cycle_registry WHERE registry_version = '1.0.0'`), CYCLES.length, "the code registry is projected into cycle_registry on the pass");
    assert.equal(await count(`agent_decisions WHERE agent = 'ops-steward' AND action = 'cycles.plan'`), 1, "one decision for the pass that planned, none for the refused one");
    // (b) a sweep while a test client holds key 35003: the cycles pass is skipped and the sweep's other passes still run
    const held = await holdPlannerLock("test-holder");
    const report = await rt.sweep();
    assert.equal(report.cycles?.skipped, true); assert.equal(report.cycles?.holder, "cycles.plan:test-holder");
    assert.equal(typeof report.partner_book_review.line, "string"); assert.equal(report.controls.kill_requests_expired, 0); assert.equal(typeof report.due, "number");
    assert.equal((await events(EVT.PLAN_SKIPPED)).length, 2);
    await held.release();
    const again = await svc.plan();
    assert.equal(again.skipped, false); assert.equal((await events(EVT.PLAN_COMPLETED)).length, 2);
    // after the holder's dedicated client ends, pg_locks shows no advisory lock with key 35003 (the lock is the session's, never a row's)
    assert.equal(await advisoryLocks(), 0);
  } finally { await close(); }
});
test("35.3-T2: Given a window with the `statements` cycle due for 12 loans and `cashiering_daily` due for the 100-loan fixture book, when `cycles.plan` runs twice for the same `as_of`, then `cycle_runs` has one row per `(cycle_code, period_key)`, `jobs` has exactly 112 rows with distinct `idempotency_key`s, `cycle.run.opened` was appended once per run, and the second pass appended no `cycle.run.opened` and inserted no row.", { skip }, async () => {
  await open("t2");
  try {
    const { rt } = runtimeAt("2026-10-17T16:00:00.000Z");
    const svc = cyclesOf(rt);
    const before = { runs: await count(`cycle_runs`), jobs: await count(`jobs`), opened: (await events(EVT.RUN_OPENED)).length };
    // the 100-loan fixture book, boarded, each with its loan_terms row; 12 of them with a 7.1 cycle whose statement date (courtesy_period_end 2026-10-16 + 1) is the as-of day
    const loans: string[] = []; for (let i = 0; i < 100; i++) loans.push(await boardedLoan());
    for (const loanId of loans.slice(0, 12)) {
      await rt.uow.run({ loanId }, (ctx) => {
        const notices = new NoticeService({ registry: rt.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: rt.ports.printMail!, edelivery: rt.ports.edelivery! });
        const row = new StatementCycleService({ events: ctx.events, clock: ctx.clock, notices }).openCycle(loanId, { prior_due_date: D("2026-09-01"), late_charge_grace_days: 15 });
        // 7.1's own arithmetic (statement.ts cycle(): courtesy = prior_due_date + grace; rule 1: the next cycle opens the day after the previous cycle's courtesy period ends): due 2026-10-01, courtesy period end 2026-09-16, statement date 2026-09-17 — due by the as-of day
      assert.equal(row.cycle_due_date, "2026-10-01"); assert.equal(row.courtesy_period_end, "2026-09-16");
      }, { clock: rt.clock });
    }
    const first = await svc.plan({ as_of: "2026-10-17T16:00:00.000Z", cycle_codes: ["cashiering_daily", "statements"] });
    assert.equal(first.skipped, false); assert.equal(first.runs_opened, 2); assert.equal(first.jobs_planned, 112);
    assert.deepEqual([...first.period_keys].sort(), ["cashiering_daily:2026-10-17", "statements:2026-10-01"]);
    const second = await svc.plan({ as_of: "2026-10-17T16:00:00.000Z", cycle_codes: ["cashiering_daily", "statements"] });
    assert.equal(second.skipped, false); assert.equal(second.runs_opened, 0); assert.equal(second.jobs_planned, 0);
    // one cycle_runs row per (cycle_code, period_key); exactly 112 jobs with distinct idempotency keys; cycle.run.opened once per run and none on the second pass
    assert.equal(await count(`cycle_runs WHERE (cycle_code, period_key) IN (('cashiering_daily', '2026-10-17'), ('statements', '2026-10-01'))`), 2);
    assert.equal((await count(`cycle_runs`)) - before.runs, 2);
    assert.equal(await count(`jobs WHERE cycle_code = 'cashiering_daily' AND period_key = '2026-10-17'`), 100);
    assert.equal(await count(`jobs WHERE cycle_code = 'statements' AND period_key = '2026-10-01'`), 12);
    assert.equal((await count(`jobs`)) - before.jobs, 112);
    assert.equal(Number((await db.query<{ n: string }>(`SELECT count(DISTINCT idempotency_key)::text AS n FROM jobs WHERE (cycle_code = 'cashiering_daily' AND period_key = '2026-10-17') OR (cycle_code = 'statements' AND period_key = '2026-10-01')`))[0]!.n), 112);
    assert.equal((await events(EVT.RUN_OPENED)).length - before.opened, 2);
    assert.equal((await events(EVT.RUN_OPENED, `AND payload->>'cycle_code' IN ('cashiering_daily', 'statements') AND payload->>'as_of_date' = '2026-10-17'`)).length, 2);
    // the statement jobs carry ids and dates only (statement_date = courtesy_period_end + 1, the planner's derivation) and wait on the day's cashiering receipt; the stall clock armed per run
    const job = (await db.query<Row>(`SELECT status, input FROM jobs WHERE cycle_code = 'statements' AND period_key = '2026-10-01' LIMIT 1`))[0]!;
    assert.equal(job["status"], "blocked"); assert.deepEqual(Object.keys(job["input"] as Row).sort(), ["cycle_due_date", "loan_id", "statement_date"]); assert.equal((job["input"] as Row)["statement_date"], "2026-09-17"); assert.equal((job["input"] as Row)["cycle_due_date"], "2026-10-01");
    assert.equal(await count(`timers WHERE code = 'SM_CYCLE_RUN_STALLED_1D' AND subject_kind = 'cycle_run' AND status = 'armed' AND subject_id IN (SELECT id::text FROM cycle_runs WHERE (cycle_code, period_key) IN (('cashiering_daily', '2026-10-17'), ('statements', '2026-10-01')))`), 2);
    assert.equal(await count(`job_events e JOIN jobs j ON j.id = e.job_id WHERE e.kind = 'planned' AND ((j.cycle_code = 'cashiering_daily' AND j.period_key = '2026-10-17') OR (j.cycle_code = 'statements' AND j.period_key = '2026-10-01'))`), 112);
  } finally { await close(); }
});
test("35.3-T3: Given one run of 100 queued units, when three executors claim concurrently with `FOR UPDATE SKIP LOCKED LIMIT 20` until the queue is empty, then every unit has exactly one `job_events{done}` row and one `agent_decisions` row naming the owner agent, no `unit_id` appears in two executors' claim logs, `cycle_runs.units_done = 100`, and one `cycle_receipts` row exists.", { skip }, async () => {
  await open("t3");
  try {
    // a loan-scoped in_command no-op owned by `cashiering`: each unit is its own loan command, so three executors hold three different loan locks (35.1 rule 7) and the units' decisions name the owner agent
    const def = cycleDef({ cycle_code: "test_noop", owner_process: "35.3", owner_agent: "cashiering", unit_scope: "loan", schedule: "daily, the 100-loan fixture book", period_grammar: "day", selector: selectors.active_loans, runner: noop, receipt_event: "test_noop.run_completed", expected_by_rule: "same_day 23:59 ET" });
    const { rt } = runtimeAt("2026-10-05T14:00:00.000Z", [def]);
    for (let i = 0; i < 100; i++) await boardedLoan();
    const planned = await cyclesOf(rt).plan();
    assert.equal(planned.runs_opened, 1); assert.equal(planned.jobs_planned, 100);
    const runId = String((await db.query<Row>(`SELECT id::text AS id FROM cycle_runs WHERE cycle_code = 'test_noop' AND period_key = '2026-10-05'`))[0]!["id"]);
    assert.equal(await count(`jobs WHERE run_id = $1 AND status = 'queued'`, [runId]), 100);
    // three executors over one queue, each claiming `FOR UPDATE SKIP LOCKED LIMIT 20` until nothing is left
    const reports = await Promise.all([runExecutor(rt, { holder: "h1", claimLimit: 20, drain: "all" }), runExecutor(rt, { holder: "h2", claimLimit: 20, drain: "all" }), runExecutor(rt, { holder: "h3", claimLimit: 20, drain: "all" })]);
    const sum = (k: "claimed" | "done" | "failed" | "dead" | "lost"): number => reports.reduce((a, r) => a + r[k], 0);
    assert.equal(sum("claimed"), 100, JSON.stringify(reports)); assert.equal(sum("done"), 100); assert.equal(sum("failed") + sum("dead") + sum("lost"), 0);
    assert.equal(reports.reduce((a, r) => a + r.receipts, 0), 1, "exactly one executor elected the receipt");
    // every unit: one done row, one claim, one decision naming the owner agent; no unit claimed by two holders
    assert.equal(await count(`job_events e JOIN jobs j ON j.id = e.job_id WHERE j.run_id = $1 AND e.kind = 'done'`, [runId]), 100);
    assert.equal(await count(`(SELECT e.job_id FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.run_id = $1 AND e.kind = 'done' GROUP BY e.job_id HAVING count(*) > 1) x`, [runId]), 0);
    assert.equal(await count(`job_events e JOIN jobs j ON j.id = e.job_id WHERE j.run_id = $1 AND e.kind = 'claimed'`, [runId]), 100);
    assert.equal(await count(`(SELECT e.job_id FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.run_id = $1 AND e.kind = 'claimed' GROUP BY e.job_id HAVING count(DISTINCT e.holder) > 1) x`, [runId]), 0, "no unit_id appears in two executors' claim logs");
    assert.equal(await count(`(SELECT DISTINCT e.holder FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.run_id = $1 AND e.kind = 'claimed') x`, [runId]), 3, "all three executors took rows");
    assert.equal(await count(`jobs WHERE run_id = $1 AND status = 'done' AND decision_id IS NOT NULL AND lease_holder IS NULL`, [runId]), 100);
    assert.equal(await count(`agent_decisions d JOIN jobs j ON j.decision_id = d.id WHERE j.run_id = $1 AND d.agent = 'cashiering' AND d.action = 'cycles.run_unit' AND d.subject_kind = 'test_noop' AND d.subject_id = j.unit_id AND d.rule_set_version = 'cycles.v1' AND d.prompt_version = '35.3-v1'`, [runId]), 100);
    assert.equal((await events(EVT.DONE)).length, 100); assert.equal((await events(EVT.CLAIMED)).length, 100);
    // the run: units_done 100, completed by the last unit's election — one receipt row, one pair of events
    const run = (await db.query<Row>(`SELECT status, units_total, units_done, units_dead, units_skipped, receipt_id::text AS receipt_id FROM cycle_runs WHERE id = $1`, [runId]))[0]!;
    assert.equal(run["units_done"], 100); assert.equal(run["units_total"], 100); assert.equal(run["units_dead"], 0); assert.equal(run["status"], "completed"); assert.ok(run["receipt_id"]);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1 AND units_total = 100 AND units_done = 100 AND emitted_by LIKE 'unit:%'`, [runId]), 1);
    assert.equal((await events("test_noop.run_completed", `AND aggregate_id = $2`, [runId])).length, 1);
    assert.equal((await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [runId])).length, 1);
    assert.equal(await count(`timers WHERE code = 'SM_CYCLE_RUN_STALLED_1D' AND subject_id = $1 AND status = 'satisfied'`, [runId]), 1);
  } finally { await close(); }
});
test("35.3-T4: Given a unit whose runner throws on every call, when the planner and executor run across four sweeps, then the job records attempts 1, 2, 3 with `run_after` 60 s and 120 s after the first two failures, the third failure appends `job.unit.dead{attempts: 3}`, `SM_JOB_DEAD_2H` is armed on the job, one escalation exists to the registry row's `escalation_role` naming `cycle_code`, `period_key` and `unit_id`, `cycle_runs.status` is still `running`, and no receipt was emitted.", { skip }, async () => {
  await open("t4");
  try {
    // a runner that throws a plain error on every call (`error_class` = the message's class token; an AdapterUnavailable would die at once — rule 7)
    const throws: NamedRunner = { name: "throws", runner: { mode: "in_command", run: () => { throw new Error("fake_port_timeout: the FAKE port did not answer in time"); } } };
    const def = cycleDef({ cycle_code: "test_throws", owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "daily", period_grammar: "day", selector: selectors.global, runner: throws, receipt_event: "test_throws.run_completed", escalation_role: "officer", expected_by_rule: "same_day 23:59 ET" });
    const { rt, clock } = runtimeAt("2026-10-05T14:00:00.000Z", [def]);   // the FixedClock is both the runtime clock and the wall clock (no demo offset)
    const sweepAt = async (iso: string) => { clock.set(iso); return cyclesSweepPass(rt, iso, { drain: "all", cycle_codes: ["test_throws"] }); };
    // sweep 1: planned, claimed (attempt 1), thrown → failed with run_after = wall + 60 s
    const s1 = await sweepAt("2026-10-05T14:00:00.000Z");
    assert.equal(s1.skipped, false); assert.equal(s1.executor?.claimed, 1); assert.equal(s1.executor?.failed, 1);
    let job = await jobOf(`cycle_code = 'test_throws'`);
    assert.equal(job["status"], "failed"); assert.equal(job["attempts"], 1); assert.equal(job["run_after"], "2026-10-05T14:01:00.000Z"); assert.equal(job["last_error_class"], "fake_port_timeout");
    // sweep 2 (before run_after): the planner re-queues nothing and the executor claims nothing
    const s1b = await sweepAt("2026-10-05T14:00:30.000Z");
    assert.equal(s1b.plan?.requeued, 0); assert.equal(s1b.executor?.claimed, 0);
    // sweep 2 at run_after: re-queued by the planner, claimed (attempt 2), thrown → failed with run_after = wall + 120 s
    const s2 = await sweepAt("2026-10-05T14:01:00.000Z");
    assert.equal(s2.plan?.requeued, 1); assert.equal(s2.executor?.claimed, 1); assert.equal(s2.executor?.failed, 1);
    job = await jobOf(`cycle_code = 'test_throws'`);
    assert.equal(job["status"], "failed"); assert.equal(job["attempts"], 2); assert.equal(job["run_after"], "2026-10-05T14:03:00.000Z");
    // sweep 3 at run_after: attempt 3 throws → dead
    const s3 = await sweepAt("2026-10-05T14:03:00.000Z");
    assert.equal(s3.plan?.requeued, 1); assert.equal(s3.executor?.claimed, 1); assert.equal(s3.executor?.dead, 1);
    // sweep 4: a dead unit is nobody's to retry — nothing re-queued, nothing claimed
    const s4 = await sweepAt("2026-10-05T14:04:00.000Z");
    assert.equal(s4.plan?.requeued, 0); assert.equal(s4.executor?.claimed, 0);
    job = await jobOf(`cycle_code = 'test_throws'`);
    const jobId = String(job["id"]); const runId = String(job["run_id"]);
    assert.equal(job["status"], "dead"); assert.equal(job["attempts"], 3); assert.equal(job["last_error_class"], "fake_port_timeout"); assert.equal(job["lease_holder"], null);
    // the job's chain: attempts 1, 2, 3; run_after 60 s and 120 s after the first two failures (both wall-clock instants off job_events.at — D8)
    const chain = await db.query<Row>(`SELECT kind, attempt, holder, error_class, detail, at FROM job_events WHERE job_id = $1 ORDER BY id`, [jobId]);
    assert.deepEqual(chain.map((e) => e["kind"]), ["planned", "claimed", "failed", "requeued", "claimed", "failed", "requeued", "claimed", "dead"]);
    assert.deepEqual(chain.filter((e) => e["kind"] === "claimed").map((e) => e["attempt"]), [1, 2, 3]);
    const failed = chain.filter((e) => e["kind"] === "failed");
    assert.deepEqual(failed.map((e) => e["attempt"]), [1, 2]);
    assert.equal((Date.parse(String((failed[0]!["detail"] as Row)["run_after"])) - Date.parse(String(failed[0]!["at"]))) / 1000, 60);
    assert.equal((Date.parse(String((failed[1]!["detail"] as Row)["run_after"])) - Date.parse(String(failed[1]!["at"]))) / 1000, 120);
    assert.ok(chain.every((e) => e["kind"] === "planned" || e["kind"] === "requeued" || e["error_class"] === "fake_port_timeout" || e["kind"] === "claimed"));
    const failedEvents = await events(EVT.FAILED, `AND aggregate_id = $2`, [jobId]);
    assert.deepEqual(failedEvents.map((e) => e.payload["attempt"]), [1, 2]); assert.deepEqual(failedEvents.map((e) => e.payload["run_after"]), ["2026-10-05T14:01:00.000Z", "2026-10-05T14:03:00.000Z"]);
    // the third failure: job.unit.dead{attempts: 3} arming SM_JOB_DEAD_2H on the job (2 hours from dead_at)
    const dead = await events(EVT.DEAD, `AND aggregate_id = $2`, [jobId]);
    assert.equal(dead.length, 1); assert.equal(dead[0]!.payload["attempts"], 3); assert.equal(dead[0]!.payload["error_class"], "fake_port_timeout"); assert.equal(dead[0]!.payload["dead_at"], "2026-10-05T14:03:00.000Z"); assert.equal(dead[0]!.payload["origination"], true);
    const timers = await db.query<Row>(`SELECT status, subject_kind, subject_id, due_at, armed_by_event_id::text AS armed_by FROM timers WHERE code = 'SM_JOB_DEAD_2H'`);
    assert.equal(timers.length, 1); assert.equal(timers[0]!["status"], "armed"); assert.equal(timers[0]!["subject_kind"], "job"); assert.equal(timers[0]!["subject_id"], jobId); assert.equal(timers[0]!["due_at"], "2026-10-05T16:03:00.000Z"); assert.equal(timers[0]!["armed_by"], dead[0]!.id);
    // one escalation to the registry row's escalation_role (officer here) naming cycle_code, period_key, unit_id, error_class and the job
    const esc = await db.query<Row>(`SELECT kind, owner_role, payload FROM escalations WHERE payload->>'job_id' = $1`, [jobId]);
    assert.equal(esc.length, 1); assert.equal(esc[0]!["owner_role"], "officer"); assert.equal(esc[0]!["kind"], "sev3");
    const payload = esc[0]!["payload"] as Row;
    assert.equal(payload["cycle_code"], "test_throws"); assert.equal(payload["period_key"], "2026-10-05"); assert.equal(payload["unit_id"], "global"); assert.equal(payload["error_class"], "fake_port_timeout"); assert.equal(payload["job_id"], jobId);
    assert.equal(await count(`cycle_registry WHERE cycle_code = 'test_throws' AND escalation_role = 'officer'`), 1);
    // the run stays running with one dead unit; no receipt
    assert.equal(await count(`cycle_runs WHERE id = $1 AND status = 'running' AND units_dead = 1 AND units_done = 0 AND units_total = 1`, [runId]), 1);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1`, [runId]), 0);
    assert.equal((await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [runId])).length, 0); assert.equal((await events("test_throws.run_completed")).length, 0);
    assert.equal(await count(`timers WHERE code = 'SM_CYCLE_RUN_STALLED_1D' AND subject_id = $1 AND status = 'armed'`, [runId]), 1);
  } finally { await close(); }
});
test("35.3-T5: Given a run of 3 units, when the last unit's `UPDATE … RETURNING` reports the counters full, then one `cycle_receipts` row and one pair of events (the cycle's receipt literal and `cycle.run.completed`) exist; given the executor is stopped between the unit's commit and the receipt transaction, when the next planner pass reconciles, then the same single receipt row exists with `emitted_by = planner:<run_id>` and the events were appended once; given both race, then the unique key on `cycle_receipts.run_id` yields one row and one pair of events.", { skip }, async () => {
  await open("t5");
  try {
    const def = cycleDef({ cycle_code: "test_three", owner_process: "35.3", owner_agent: "cashiering", unit_scope: "loan", schedule: "daily, three loans", period_grammar: "day", selector: selectors.active_loans, runner: noop, receipt_event: "test_three.run_completed", expected_by_rule: "same_day 23:59 ET" });
    const { rt, clock } = runtimeAt("2026-10-05T14:00:00.000Z", [def]);
    const svc = cyclesOf(rt);
    for (let i = 0; i < 3; i++) await boardedLoan();
    const runOf = async (day: string): Promise<Row> => (await db.query<Row>(`SELECT id::text AS id, status, units_total, units_done, receipt_id::text AS receipt_id FROM cycle_runs WHERE cycle_code = 'test_three' AND period_key = $1`, [day]))[0]!;
    const pair = async (runId: string): Promise<{ literal: number; generic: number; rows: number }> => ({ literal: (await events("test_three.run_completed", `AND aggregate_id = $2`, [runId])).length, generic: (await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [runId])).length, rows: await count(`cycle_receipts WHERE run_id = $1`, [runId]) });
    // (a) the executor runs all three; the last unit's RETURNING reports the counters full and its election writes one row and one pair
    const p1 = await svc.plan(); assert.equal(p1.runs_opened, 1); assert.equal(p1.jobs_planned, 3);
    const ex = await runExecutor(rt, { holder: "h1", drain: "all" });
    assert.equal(ex.done, 3); assert.equal(ex.receipts, 1);
    const r1 = await runOf("2026-10-05");
    assert.equal(r1["status"], "completed"); assert.equal(r1["units_done"], 3); assert.ok(r1["receipt_id"]);
    assert.deepEqual(await pair(String(r1["id"])), { literal: 1, generic: 1, rows: 1 });
    const receipt1 = (await db.query<Row>(`SELECT emitted_by, receipt_event_id::text AS receipt_event_id, generic_event_id::text AS generic_event_id, units_total, units_done FROM cycle_receipts WHERE run_id = $1`, [r1["id"]]))[0]!;
    assert.match(String(receipt1["emitted_by"]), /^unit:[0-9a-f-]{36}$/); assert.equal(receipt1["units_total"], 3); assert.equal(receipt1["units_done"], 3);
    assert.equal((await events("test_three.run_completed", `AND aggregate_id = $2`, [r1["id"]]))[0]!.id, receipt1["receipt_event_id"]);
    assert.equal((await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [r1["id"]]))[0]!.id, receipt1["generic_event_id"]);
    // (b) the next day: the executor stops between the last unit's commit and the receipt transaction (the injectable stop); the next planner pass reconciles with emitted_by planner:<run_id>, events once
    clock.set("2026-10-06T14:00:00.000Z");
    await svc.plan();
    const claimed = await claimJobs(rt.db, "h2", 20, wallClockOf(rt).now());
    assert.equal(claimed.length, 3);
    assert.equal(await runClaimed(rt, claimed[0]!, "h2"), "done"); assert.equal(await runClaimed(rt, claimed[1]!, "h2"), "done");
    assert.equal(await runClaimed(rt, claimed[2]!, "h2", { electReceipt: false }), "done");
    const r2 = await runOf("2026-10-06");
    assert.equal(r2["status"], "running"); assert.equal(r2["units_done"], 3); assert.equal(r2["receipt_id"], null);
    assert.deepEqual(await pair(String(r2["id"])), { literal: 0, generic: 0, rows: 0 });
    const p2 = await svc.plan({ as_of: "2026-10-06T14:30:00.000Z" });
    assert.equal(p2.receipts_reconciled, 1);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1 AND emitted_by = $2 AND units_done = 3`, [r2["id"], `planner:${String(r2["id"])}`]), 1);
    assert.equal((await runOf("2026-10-06"))["status"], "completed");
    assert.deepEqual(await pair(String(r2["id"])), { literal: 1, generic: 1, rows: 1 });
    await svc.plan({ as_of: "2026-10-06T15:00:00.000Z" });
    assert.deepEqual(await pair(String(r2["id"])), { literal: 1, generic: 1, rows: 1 }, "a later pass adds nothing");
    // (c) the third day: both the executor's election and a second election race on the same run — the unique key on cycle_receipts.run_id yields one row and one pair (D9)
    clock.set("2026-10-07T14:00:00.000Z");
    await svc.plan();
    const third = await claimJobs(rt.db, "h3", 20, wallClockOf(rt).now());
    for (const j of third) assert.equal(await runClaimed(rt, j, "h3", { electReceipt: false }), "done");
    const r3 = await runOf("2026-10-07");
    assert.equal(r3["units_done"], 3); assert.equal(r3["status"], "running");
    const race = await Promise.all([svc.electReceipt(String(r3["id"]), `unit:${third[2]!.id}`), svc.electReceipt(String(r3["id"]), `planner:${String(r3["id"])}`)]);
    assert.equal(race.filter((x) => x.elected).length, 1, JSON.stringify(race)); assert.equal(race.filter((x) => !x.elected).length, 1);
    assert.deepEqual(await pair(String(r3["id"])), { literal: 1, generic: 1, rows: 1 });
    assert.equal((await runOf("2026-10-07"))["status"], "completed");
    assert.equal(await count(`cycle_receipts`), 3);
    assert.equal(await count(`timers WHERE code = 'SM_CYCLE_RUN_STALLED_1D' AND status = 'satisfied'`), 3);
  } finally { await close(); }
});
test("35.3-T6: Given `ledger.period.closed{period_key: 2026-09}` has been appended and `investor_reporting_periods.closed{period_key: 2026-09}` has not, when the planner runs, then the `form_496_monthly` job for `2026-09:<account>:A/A` is `blocked` and never claimed; when `investor_reporting_periods.closed{period_key: 2026-09}` is appended, then the next pass unblocks it (`job_events{unblocked}`) and the unit runs 6.3's chain.", { skip }, async () => {
  await open("t6");
  try {
    const { rt } = runtimeAt("2026-10-01T05:00:00.000Z");   // 2026-10-01 01:00 ET, the production registry
    const svc = cyclesOf(rt);
    // the fixture custodial account (A/A P&I, loans.ts createFixture) and the FAKE bank's month-end statement for it (a BAI2 file the interim runner reads as section I)
    const f = await new PgLoanRepository(db).createFixture({ fnmaLoanNumber: uniq(), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2026-08-15"), originalUpbCents: 24_831_055n, originalTermMonths: 360, firstPaymentDate: D("2026-10-01"), maturityDate: D("2056-09-01") });
    const pi = f.custodial.pi;
    (rt.ports.custodialBank as FakeCustodialBank).post(pi, "2026-09-30", ["01,121000248,SM,260930,1700,1,,,2/", "02,SM,121000248,1,260930,,USD,2/", `03,${pi},USD,010,0,,,015,0,,/`, "49,0,2/", "98,0,1,4/", "99,0,1,6/"].join("\n"));
    // 6.3's own period close for the account (custodial/ops.ts periodClosedEvent: the payload carries period_end 2026-09-30 — the matcher derives 2026-09) — and no investor close yet
    const RECON: Actor = { kind: "agent", id: "custodial-recon" };
    await rt.uow.run({}, (ctx) => ctx.events.append({ ...periodClosedEvent({ period_end: D("2026-09-30"), account_kind: "pi", custodial_account_id: pi, remittance_type: "A/A" }), actor: RECON }), { clock: rt.clock });
    const p1 = await svc.plan({ cycle_codes: ["form_496_monthly"] });
    assert.equal(p1.skipped, false); assert.equal(p1.runs_opened, 1); assert.equal(p1.jobs_planned, 1); assert.deepEqual(p1.period_keys, ["form_496_monthly:2026-09"]);
    const key = `form_496_monthly:2026-09:${pi}:A/A`;
    let job = await jobOf(`idempotency_key = $1`, [key]);
    assert.equal(job["status"], "blocked"); assert.equal(job["unit_id"], `${pi}:A/A`); assert.deepEqual(job["input"], { custodial_account_id: pi, remittance_type: "A/A" });
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'blocked'`, [job["id"]]), 1);
    // the executor claims nothing blocked
    const ex1 = await runExecutor(rt, { holder: "h1", drain: "all" });
    assert.equal(ex1.claimed, 0);
    job = await jobOf(`idempotency_key = $1`, [key]);
    assert.equal(job["status"], "blocked"); assert.equal(job["attempts"], 0);
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'claimed'`, [job["id"]]), 0);
    assert.equal((await events(EVT.CLAIMED)).length, 0);
    // the investor close arrives (5.1/5.2's spelling, `period`); the next pass unblocks the job and the executor runs the unit: 6.3's own form496.generate command as custodial-recon
    await rt.uow.run({}, (ctx) => ctx.events.append({ type: "investor_reporting_periods.closed", aggregate: { kind: "period", id: `123456789:2026-09` }, actor: { kind: "agent", id: "investor-reporting" }, payload: { period: "2026-09", servicer_number: "123456789", checklist_complete: true, status: "closed" } }), { clock: rt.clock });
    const p2 = await svc.plan({ cycle_codes: ["form_496_monthly"] });
    assert.equal(p2.runs_opened, 0); assert.equal(p2.unblocked, 1);
    job = await jobOf(`idempotency_key = $1`, [key]);
    assert.equal(job["status"], "queued");
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'unblocked'`, [job["id"]]), 1);
    const ex2 = await runExecutor(rt, { holder: "h2", drain: "all" });
    assert.equal(ex2.claimed, 1); assert.equal(ex2.done, 1, JSON.stringify(ex2));
    job = await jobOf(`idempotency_key = $1`, [key]);
    assert.equal(job["status"], "done"); assert.ok(job["decision_id"]);
    const chain = (await events("command.executed", `AND payload->>'process' = '6.3' AND payload->>'command' = 'form496.generate'`));
    assert.equal(chain.length, 1); assert.equal(chain[0]!.actor_id, "custodial-recon"); assert.equal(chain[0]!.payload["agent"], "custodial-recon");
    assert.equal((await events("custodial.reconciliation.drafted", `AND payload->>'period' = '2026-09' AND aggregate_id = $2`, [pi])).length, 1);
    assert.equal(await count(`agent_decisions WHERE agent = 'custodial-recon' AND action = 'cycles.run_unit' AND subject_kind = 'form_496_monthly' AND subject_id = $1`, [`${pi}:A/A`]), 1);
    assert.equal(await count(`agent_decisions WHERE agent = 'custodial-recon' AND action = 'form496.generate'`), 1, "6.3's own decision beside the unit's");
    assert.equal(await count(`cycle_receipts WHERE cycle_code = 'form_496_monthly' AND period_key = '2026-09' AND units_done = 1`), 1);
    assert.equal((await events("custodial.form496.run_completed")).length, 1);
  } finally { await close(); }
});
test("35.3-T7: Given 10,000 armed timers due at or before `now`, when the breach pass runs, then it uses 20 transactions of at most 500 timers each, every one of the 10,000 has exactly one `timer.breached` event and one escalation, and a second pass started concurrently breaches none of them twice (the `FOR UPDATE SKIP LOCKED` page).", { todo: true });
test("35.3-T8: Given the demo clock at 2026-10-01 12:00 ET and the fixture book, when `POST /v1/demo/advance {days: 3}` runs, then `cycles.plan.run_completed` was appended three times with `as_of_date` 2026-10-02, 2026-10-03 and 2026-10-04, `cycle_runs` holds one `cashiering_daily` and one `delinquency_counters` run per day with `period_key` equal to that day and `demo_offset_ms` equal to the step's `demo_clock.offset_ms`, every receipt of day N precedes day N+1's `cycle.run.opened` in `loan_events.sequence`, and every `jobs.lease_until` written during the advance is within 5 minutes of the wall-clock `real_now`, not of `demo_now`.", { todo: true });
test("35.3-T9: Given loan L with UPB $248,310.55, note rate 6.500%, P&I $1,612.34, escrow payment $432.78, an installment due 2026-10-01 unpaid past the 15-day grace and a late charge assessed at 5% of P&I, when the `statements` unit for `(L, 2026-10-01)` runs through `cycles.run_unit` on 2026-10-17, then the statement's late charge is $80.62, its interest portion $1,345.02, its principal portion $267.32 and its amount due $2,125.74, `statement.sent` and `job.unit.done` share one transaction (one `loan_events` batch), the decision names `disclosures`, exactly one `notices` row exists for `(L, 2026-10-01)` after a second plan and a second `cycles.run_unit` of the same job (refused `JOB_NOT_CLAIMABLE`), and the receipt reads `units_total 1, units_done 1`.", { skip }, async () => {
  await open("t9");
  try {
    // T9's rollback probe (D7 / installCycles hook): the job ids whose deferred write must throw inside the unit's transaction
    const failing = new Set<string>();
    const { rt, clock } = runtimeAt("2026-10-17T16:00:00.000Z", undefined, { failCommitFor: (id) => failing.has(id) });   // 2026-10-17 12:00 ET, the production registry
    const svc = cyclesOf(rt);
    // loan L (plan §4): UPB $248,310.55 on the ledger, note rate 6.500%, P&I $1,612.34, escrow $432.78, a 5% late charge with a 15-day grace, first installment due 2026-10-01, one borrower party
    const L = await boardedLoan(); await borrowerOn(L, "Loan L Borrower");
    const clearing = (await db.query<{ id: string }>(`SELECT c.id::text AS id FROM custodial_accounts c JOIN loans l ON l.partner_party_id = c.partner_party_id WHERE l.id = $1 AND c.kind = 'clearing'`, [L]))[0]!.id;
    await rt.uow.run({ loanId: L }, (ctx) => ctx.ledger.post({ effectiveDate: D("2026-09-01"), description: "boarding: opening UPB", lines: [{ account: { scope: "loan", loanId: L, account: "principal" }, amountCents: 24_831_055n, ruleRef: "1.6 rule 6" }, { account: { scope: "custodial", custodialAccountId: clearing, account: "clearing_cash" }, amountCents: -24_831_055n, ruleRef: "1.6 rule 6" }] }, ctx.clock.now()), { clock: rt.clock });
    const terms = (await db.query<Row>(`SELECT pi_cents::text AS pi_cents, escrow_payment_cents::text AS escrow_payment_cents, note_rate_bps FROM loan_terms WHERE loan_id = $1`, [L]))[0]!;
    assert.equal(BigInt(String(terms["pi_cents"])), 161_234n); assert.equal(BigInt(String(terms["escrow_payment_cents"])), 43_278n); assert.equal(terms["note_rate_bps"], 65000);
    // 7.1's cycle for (L, 2026-10-01) as worked example A states it — courtesy_period_end 2026-10-16, so the statement date is 2026-10-17 (the spec's pairing; 7.1's openCycle derives courtesy = prior_due_date + grace)
    const cycleRow = { cycle_due_date: "2026-10-01", courtesy_period_end: "2026-10-16", statement_due_by: "2026-10-20", vendor_file_by: "2026-10-19", snapshot_at: "2026-10-17T05:00:00.000Z", status: "scheduled", prior_due_date: "2026-09-01", late_charge_grace_days: 15 };
    await rt.uow.run({ loanId: L }, (ctx) => ctx.events.append({ type: "statement.cycle.opened", loanId: L, actor: DISCLOSURES, payload: cycleRow }), { clock: rt.clock });
    // 2.7's daily run on 2026-10-17 (the day after the grace end 2026-10-16): the late charge at 5% of P&I — 1,612.34 × 0.05 = 80.617 → half-up → $80.62
    const facts = await loanCashState(rt, L, D("2026-10-17"));
    assert.equal(facts.state.upb_cents, 24_831_055n); assert.equal(facts.state.late_charge_pct, "5"); assert.equal(facts.state.installments[0]!.due_date, "2026-10-01"); assert.equal(facts.state.installments[0]!.status, "due");
    const lc = await rt.execute({ process: "2.7", name: "fees.assess", loanId: L, actor: CASHIERING_AGENT, input: { op: "daily_run", state: facts.state, run_on: "2026-10-17", facts: { items_received_or_identified_on_or_before_gate_date: 0, run_on: "2026-10-17" }, unposted_receipts_on_or_before_grace: 0 } });
    assert.deepEqual((lc.output as { decisions: Row[] }).decisions.map((d) => d["outcome"]), ["assessed"]);
    const fee = (await rt.entities.load({ loanId: L })).filter((r) => r.kind === "fees").at(-1)!;
    assert.equal(BigInt(String(fee.data["amount_cents"])), 8_062n);
    assert.equal(lateChargeAmount(161_234n, "5", null), 8_062n);
    assert.equal((await loanCashState(rt, L, D("2026-10-17"))).state.late_charges_due_cents, 8_062n);
    // a second loan L2 whose statement cycle (due 2026-09-01) is also due today — the rollback probe's unit
    const L2 = await boardedLoan(); await borrowerOn(L2, "Loan L2 Borrower");
    await db.query(`UPDATE loans SET first_payment_date = '2026-09-01' WHERE id = $1`, [L2]);   // its first installment is the September cycle's
    await rt.uow.run({ loanId: L2 }, (ctx) => ctx.events.append({ type: "statement.cycle.opened", loanId: L2, actor: DISCLOSURES, payload: { ...cycleRow, cycle_due_date: "2026-09-01", prior_due_date: "2026-08-01", courtesy_period_end: "2026-09-16", statement_due_by: "2026-09-20", vendor_file_by: "2026-09-18" } }), { clock: rt.clock });
    // the planner: the statement job for (L, 2026-10-01) — input {cycle_due_date, statement_date} and ids only — blocked on the day's cashiering receipt (cashiering_daily, 2026-10-17)
    const p1 = await svc.plan({ cycle_codes: ["cashiering_daily", "statements"] });
    assert.equal(p1.skipped, false); assert.equal(p1.runs_opened, 3); assert.equal(p1.jobs_planned, 4);
    let jobL = await jobOf(`cycle_code = 'statements' AND period_key = '2026-10-01' AND unit_id = $1`, [L]);
    assert.equal(jobL["status"], "blocked"); assert.deepEqual(jobL["input"], { loan_id: L, cycle_due_date: "2026-10-01", statement_date: "2026-10-17" });
    assert.ok(!Object.keys(jobL["input"] as Row).some((k) => /_cents$/.test(k) || k === "state"), "no cents, no state");
    assert.equal(await count(`jobs WHERE idempotency_key = $1`, [`statements:2026-10-01:${L}`]), 1);
    const runL = String(jobL["run_id"]);
    assert.equal(await count(`cycle_runs WHERE id = $1 AND units_total = 1`, [runL]), 1);
    // the executor's claim of the day's cashiering units (L and L2 are not originated → skipped_not_originated → done); the run's receipt unblocks both statement jobs in its transaction (D11)
    const cashiering = await claimJobs(rt.db, "h1", 20, wallClockOf(rt).now());
    assert.deepEqual(cashiering.map((j) => j.cycle_code), ["cashiering_daily", "cashiering_daily"]);
    for (const j of cashiering) assert.equal(await runClaimed(rt, j, "h1"), "done");
    assert.equal(await count(`cycle_receipts WHERE cycle_code = 'cashiering_daily' AND period_key = '2026-10-17' AND units_done = 2`), 1);
    assert.equal(await count(`job_events e JOIN jobs j ON j.id = e.job_id WHERE j.cycle_code = 'cashiering_daily' AND e.kind = 'done' AND e.detail->>'outcome' = 'skipped_not_originated'`), 2);
    jobL = await jobOf(`id = $1`, [jobL["id"]]);
    assert.equal(jobL["status"], "queued"); assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'unblocked'`, [jobL["id"]]), 1);
    // the statement unit through `cycles.run_unit` on 2026-10-17 (the by-hand dispatcher: the claim in its own command, the unit after the commit under L's scope — D6)
    const byHand = await runUnitByHand(rt, { job_id: String(jobL["id"]), actor: OPS_STEWARD });
    assert.equal(byHand.result, "done", JSON.stringify(byHand.claimed));
    assert.equal((byHand.claimed as Row)["claimed"], true); assert.equal((byHand.claimed as Row)["holder"], "byhand:agent:ops-steward");
    assert.equal((await events(EVT.CLAIMED, `AND aggregate_id = $2`, [jobL["id"]])).length, 1);
    // worked example A, to the cent, off the statement's notice row (bigint → string in the payload): UPB $248,310.55, P&I $1,612.34, escrow $432.78, late charge $80.62, interest $1,345.02, principal $267.32, amount due $2,125.74
    const notices = await db.query<Row>(`SELECT id::text AS id, payload, status FROM notices WHERE loan_id = $1 AND template_code = 'NTC_REGZ_41_STMT_STD'`, [L]);
    assert.equal(notices.length, 1);
    const payload = notices[0]!["payload"] as Row;
    assert.equal(payload["due_date"], "2026-10-01"); assert.equal(payload["statement_date"], "2026-10-17");
    assert.equal(BigInt(String(payload["upb_cents"])), 24_831_055n);
    assert.equal(BigInt(String(payload["escrow_cents"])), 43_278n);
    assert.equal(BigInt(String(payload["late_charges_due_cents"])), 8_062n);
    assert.equal(BigInt(String(payload["interest_cents"])), 134_502n);
    assert.equal(divRound(24_831_055n * 65_000n, 12_000_000n, "HALF_UP"), 134_502n);
    assert.equal(BigInt(String(payload["principal_cents"])), 26_732n);
    assert.equal(161_234n - 134_502n, 26_732n);
    assert.equal(BigInt(String(payload["amount_due_cents"])), 212_574n);
    assert.equal(161_234n + 43_278n + 8_062n, 212_574n);
    assert.equal(BigInt(String(payload["past_due_cents"])), 0n); assert.equal(payload["rate_pct"], "6.500");
    const stmtInstallment = (await loanCashState(rt, L, D("2026-10-17"))).state.installments.find((x) => x.due_date === "2026-10-01")!;
    assert.equal(stmtInstallment.pi_cents, 161_234n); assert.equal(stmtInstallment.escrow_cents, 43_278n);
    // `statement.sent` and `job.unit.done` share one transaction (one loan_events batch: the same xmin, the same occurred_at), and the decision names `disclosures`
    const sent = await events("statement.sent", `AND loan_id = $2`, [L]); const done = await events(EVT.DONE, `AND aggregate_id = $2`, [jobL["id"]]);
    assert.equal(sent.length, 1); assert.equal(done.length, 1); assert.equal(sent[0]!.payload["cycle_due_date"], "2026-10-01"); assert.equal(sent[0]!.payload["notice_id"], notices[0]!["id"]);
    const xmins = await db.query<{ type: string; xmin: string }>(`SELECT type, xmin::text AS xmin FROM loan_events WHERE id = ANY($1::uuid[])`, [[sent[0]!.id, done[0]!.id]]);
    assert.equal(xmins.length, 2); assert.equal(xmins[0]!.xmin, xmins[1]!.xmin, "one transaction"); assert.equal(sent[0]!.occurred_at, done[0]!.occurred_at);
    assert.equal(await count(`agent_decisions WHERE id = $1 AND agent = 'disclosures' AND action = 'cycles.run_unit' AND subject_kind = 'statements' AND subject_id = $2 AND prompt_version = '35.3-v1' AND rule_set_version = 'cycles.v1'`, [done[0]!.payload["decision_id"], L]), 1);
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'done' AND decision_id = $2`, [jobL["id"], done[0]!.payload["decision_id"]]), 1);
    assert.equal((await events("command.executed", `AND payload->>'command' = 'cycles.run_unit' AND payload->>'agent' = 'disclosures' AND loan_id = $2`, [L])).length, 1);
    // the rollback probe: L2's statement unit's deferred write is forced to throw — no statement.sent, no notices row, the job failed; nothing of the unit survived
    const jobL2 = await jobOf(`cycle_code = 'statements' AND unit_id = $1`, [L2]);
    assert.equal(jobL2["status"], "queued");
    failing.add(String(jobL2["id"]));
    const probe = await runUnitByHand(rt, { job_id: String(jobL2["id"]), actor: OPS_STEWARD });
    assert.equal(probe.result, "failed");
    const probed = (await db.query<Row>(`SELECT status, last_error_class, last_error, decision_id FROM jobs WHERE id = $1`, [jobL2["id"]]))[0]!;
    assert.equal(probed["status"], "failed"); assert.equal(probed["last_error_class"], "forced_commit_failure", String(probed["last_error"])); assert.equal(probed["decision_id"], null);
    assert.equal((await events("statement.sent", `AND loan_id = $2`, [L2])).length, 0); assert.equal((await events("statement.rendered", `AND loan_id = $2`, [L2])).length, 0, "the unit's own events rolled back with it");
    assert.equal(await count(`notices WHERE loan_id = $1`, [L2]), 0);
    assert.equal((await events(EVT.DONE, `AND aggregate_id = $2`, [jobL2["id"]])).length, 0);
    // a second plan inserts nothing; a second cycles.run_unit of the same job is refused JOB_NOT_CLAIMABLE (status done); exactly one notices row for (L, 2026-10-01)
    const p2 = await svc.plan({ cycle_codes: ["cashiering_daily", "statements"] });
    assert.equal(p2.runs_opened, 0); assert.equal(p2.jobs_planned, 0);
    await assert.rejects(rt.execute({ process: "35.3", name: "cycles.run_unit", loanId: "", actor: OPS_STEWARD, input: { job_id: String(jobL["id"]) } }), (e: unknown) => e instanceof CyclesRefused && e.code === "JOB_NOT_CLAIMABLE" && e.detail["status"] === "done");
    assert.equal(await count(`notices WHERE loan_id = $1 AND template_code = 'NTC_REGZ_41_STMT_STD' AND payload->>'due_date' = '2026-10-01'`, [L]), 1);
    assert.equal((await events("statement.sent", `AND loan_id = $2`, [L])).length, 1);
    assert.equal((await events(EVT.CLAIMED, `AND aggregate_id = $2`, [jobL["id"]])).length, 1, "the refused dispatch appended nothing");
    // the receipt reads units_total 1, units_done 1
    const receipt = (await db.query<Row>(`SELECT units_total, units_done, units_dead, units_skipped, emitted_by FROM cycle_receipts WHERE run_id = $1`, [runL]))[0]!;
    assert.equal(receipt["units_total"], 1); assert.equal(receipt["units_done"], 1); assert.equal(receipt["units_dead"], 0); assert.equal(receipt["emitted_by"], `unit:${String(jobL["id"])}`);
    assert.equal((await events("statement.cycle.run_completed", `AND aggregate_id = $2`, [runL])).length, 1);
    assert.equal(await count(`cycle_runs WHERE id = $1 AND status = 'completed'`, [runL]), 1);
    assert.equal(clock.now(), "2026-10-17T16:00:00.000Z");
  } finally { await close(); }
});
test("35.3-T10: Given a job claimed with `lease_until` 5 minutes ahead by an executor that then stops heartbeating, when `now()` passes `lease_until` and the planner runs, then the job is `queued` again, `job.lease.expired{holder, attempt: 1}` is appended, `attempts` is 1, and a second executor's claim runs it to `done` with `attempt: 2`; given the demo clock is advanced 30 days while the first lease is live, then the lease is not expired by the advance.", { skip }, async () => {
  await open("t10");
  try {
    // the demo clock over a fixed wall clock: the leases bind the base (rule 6, LEASE_IS_WALL_CLOCK — D8), the runtime clock carries the offset
    const base = new FixedClock("2026-10-05T14:00:00.000Z");
    const clock = await loadDemoClock(db, { base });
    const rt = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: null, reviewers: null, analystLlm: null, databaseUrl: DB_URL });
    const slow = cycleDef({ cycle_code: "test_slow", owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "daily", period_grammar: "day", selector: selectors.global, runner: noop, receipt_event: "test_slow.run_completed", expected_by_rule: "same_day 23:59 ET" });
    installCycles(rt, { defs: [slow] });
    const svc = cyclesOf(rt);
    await svc.plan();
    // executor A claims (attempt 1, lease_until = wall + 5 min) and then stops heartbeating
    const [job] = await claimJobs(rt.db, "A", 20, wallClockOf(rt).now());
    assert.ok(job); assert.equal(job.attempts, 1); assert.equal(job.lease_holder, "A"); assert.equal(job.lease_until, "2026-10-05T14:05:00.000Z"); assert.equal(job.heartbeat_at, "2026-10-05T14:00:00.000Z");
    // the wall clock passes lease_until: the planner reclaims — queued again, job.lease.expired{holder: A, attempt: 1}, attempts still 1
    base.set("2026-10-05T14:06:00.000Z");
    const p2 = await svc.plan();
    assert.equal(p2.leases_reclaimed, 1);
    let row = await jobOf(`id = $1`, [job.id]);
    assert.equal(row["status"], "queued"); assert.equal(row["attempts"], 1); assert.equal(row["lease_holder"], null); assert.equal(row["lease_until"], null);
    const expired = await events(EVT.LEASE_EXPIRED, `AND aggregate_id = $2`, [job.id]);
    assert.equal(expired.length, 1); assert.equal(expired[0]!.payload["holder"], "A"); assert.equal(expired[0]!.payload["attempt"], 1); assert.equal(expired[0]!.payload["lease_until"], "2026-10-05T14:05:00.000Z");
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'lease_expired' AND holder = 'A' AND attempt = 1`, [job.id]), 1);
    // executor B's claim runs it to done with attempt 2
    const ex = await runExecutor(rt, { holder: "B", drain: "all" });
    assert.equal(ex.claimed, 1); assert.equal(ex.done, 1);
    row = await jobOf(`id = $1`, [job.id]);
    assert.equal(row["status"], "done"); assert.equal(row["attempts"], 2); assert.ok(row["decision_id"]);
    assert.deepEqual((await db.query<Row>(`SELECT attempt, holder FROM job_events WHERE job_id = $1 AND kind = 'claimed' ORDER BY id`, [job.id])).map((e) => [e["attempt"], e["holder"]]), [[2, "B"]], "executor B's claim log; A's raw claim (no executor loop) left its mark on the row and the lease_expired event");
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'done' AND attempt = 2 AND holder = 'B'`, [job.id]), 1);
    assert.equal((await events(EVT.CLAIMED, `AND aggregate_id = $2 AND payload->>'attempt' = '2'`, [job.id])).length, 1);
    // second scenario: a live lease and a 30-day demo advance — the advance moves the runtime clock, never the wall clock the lease binds
    const slow2 = cycleDef({ cycle_code: "test_slow_2", owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "daily", period_grammar: "day", selector: selectors.global, runner: noop, receipt_event: "test_slow_2.run_completed", expected_by_rule: "same_day 23:59 ET" });
    installCycles(rt, { defs: [slow2] });
    await cyclesOf(rt).plan();
    const [job2] = await claimJobs(rt.db, "A2", 20, wallClockOf(rt).now());
    assert.ok(job2); assert.equal(job2.lease_until, "2026-10-05T14:11:00.000Z");
    const adv = await advanceDemoClock({ runtime: rt, clock, logger }, { days: 30 });
    assert.equal(adv.advanced, true); assert.equal(adv.complete, true); assert.equal(adv.days_crossed, 30); assert.equal(clock.now(), "2026-11-04T14:06:00.000Z");
    assert.ok((await events(EVT.PLAN_COMPLETED)).length >= 30, "the advance planned every crossed day");
    row = await jobOf(`id = $1`, [job2.id]);
    assert.equal(row["status"], "running"); assert.equal(row["lease_holder"], "A2"); assert.equal(row["attempts"], 1);
    assert.ok(Date.parse(String(row["lease_until"])) > Date.parse(wallClockOf(rt).now()), `the lease ${String(row["lease_until"])} is still live at wall ${wallClockOf(rt).now()}`);
    assert.equal((await events(EVT.LEASE_EXPIRED, `AND aggregate_id = $2`, [job2.id])).length, 0);
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'lease_expired'`, [job2.id]), 0);
    // every lease written during the advance binds the wall clock, not the demo clock
    assert.equal(await count(`jobs WHERE cycle_code = 'test_slow_2' AND lease_until IS NOT NULL AND lease_until > '2026-10-05T14:20:00.000Z'::timestamptz`), 0);
    assert.equal(await count(`job_events WHERE at > '2026-10-05T14:20:00.000Z'::timestamptz`), 0, "job_events.at is the wall clock's");
  } finally { await close(); }
});
test("35.3-T11: Given a def registered with `expected_by_rule: same_day 23:59 ET` and no run ever, when the planner runs the next morning, then no `timers` row names the cycle (the engine arms only on a trigger event), `cycle_registry.overdue_since` is set to the first pass after 23:59 ET, `cycles.registry{op: list}` returns the row first with `next_expected_by` and `overdue_since`, and no escalation was opened by this process (35.11 opens it).", { skip }, async () => {
  await open("t11");
  try {
    // a def registered on an event that never arrives (never planned — no run, no zero-unit receipt), and a control def with no expected_by rule so "first" means the overdue row leads
    const never = cycleDef({ cycle_code: "test_never_arrives", owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "on test.never_arrives", period_grammar: "event", event: "test.never_arrives", selector: selectors.global, receipt_event: "test.never_arrives.run_completed", expected_by_rule: "same_day 23:59 ET" });
    const control = cycleDef({ cycle_code: "test_control_no_rule", owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "daily", period_grammar: "day", selector: selectors.global, receipt_event: "test_control.run_completed", expected_by_rule: null });
    const { rt, clock } = runtimeAt("2026-10-05T12:00:00.000Z", [control, never]);   // D 08:00 ET
    const svc = cyclesOf(rt);
    const p1 = await svc.plan();
    assert.equal(p1.skipped, false); assert.ok(!p1.period_keys.some((k) => k.startsWith("test_never_arrives:")), "the event never arrived, so nothing was planned");
    const row = async (): Promise<Row> => (await db.query<Row>(`SELECT status, next_period_key, next_expected_by, overdue_since, last_receipt_at FROM cycle_registry WHERE cycle_code = 'test_never_arrives'`))[0]!;
    let r = await row();
    assert.equal(r["status"], "active"); assert.equal(r["next_period_key"], "2026-10-05"); assert.equal(r["next_expected_by"], "2026-10-06T03:59:00.000Z"); assert.equal(r["overdue_since"], null);
    assert.equal(await count(`cycle_runs WHERE cycle_code = 'test_never_arrives'`), 0);
    // the next morning (D+1 08:00 ET): the first pass after 23:59 ET sets overdue_since to that pass's as-of instant and moves the expectation to D+1
    clock.set("2026-10-06T12:00:00.000Z");
    const p2 = await svc.plan();
    assert.equal(p2.skipped, false); assert.equal(p2.overdue, 1);
    r = await row();
    assert.equal(r["overdue_since"], "2026-10-06T12:00:00.000Z"); assert.equal(r["next_expected_by"], "2026-10-07T03:59:00.000Z"); assert.equal(r["next_period_key"], "2026-10-06");
    // no timers row names the cycle (the engine arms only on a trigger event; a never-run cycle has emitted nothing)
    assert.equal(await count(`timers WHERE subject_id = 'test_never_arrives' OR armed_by_event_id IN (SELECT id FROM loan_events WHERE payload->>'cycle_code' = 'test_never_arrives')`), 0);
    // cycles.registry{op: list} returns it first, with next_expected_by and overdue_since
    const list = (await rt.execute({ process: "35.3", name: "cycles.registry", loanId: "", actor: OPS_STEWARD, input: { op: "list" } })).output as Row[];
    assert.equal(list[0]!["cycle_code"], "test_never_arrives"); assert.equal(list[0]!["overdue_since"], "2026-10-06T12:00:00.000Z"); assert.equal(list[0]!["next_expected_by"], "2026-10-07T03:59:00.000Z");
    assert.ok(list.some((x) => x["cycle_code"] === "test_control_no_rule" && x["overdue_since"] === null && x["next_expected_by"] === null));
    // no escalation was opened by this process — 35.11's steward reads overdue_since and opens it
    assert.equal(await count(`escalations WHERE payload->>'cycle_code' = 'test_never_arrives' OR opened_by = 'agent:ops-steward'`), 0);
  } finally { await close(); }
});
test("35.3-T12: Given a run opened at 2026-10-01 12:00 ET with one unit `blocked` on an event that never arrives, when the sweep runs at 2026-10-02 12:01 ET, then `SM_CYCLE_RUN_STALLED_1D` breaches with one `ops_analyst` escalation whose payload names `cycle_code`, `period_key`, `units_done 0` and `units_total 1`; when the event arrives and the unit completes, then `cycle.run.completed` satisfies the clock as `satisfied_late` and the escalation is completable through 34.4 with the disposition `completed_late`.", { todo: true });
test("35.3-T13: Given `cycles.run_unit` is called with an `input` carrying `state`, `custodial`, any `*_cents` key or `changes`, then it is refused `NO_CLIENT_STATE` before any row or event is written; given `jobs.requeue{op: requeue}` on a dead job by an actor `{kind: \"agent\"}`, then `ROLE_REQUIRED{ops_analyst}` and the job stays `dead`; given an `ops_analyst` requeues it with a reason, then `job.unit.resolved` is appended, the decision names the person and the reason, and the ledger and every money column are byte-identical before and after every 35.3 tool call in a contract test over all nine tools.", { skip }, async () => {
  await open("t13");
  try {
    // three global defs: one dies at once (an `unavailable` failure — rule 7), one fails with a run_after, one is a no-op — the jobs the nine tools act on
    const dies: NamedRunner = { name: "dies", runner: { mode: "in_command", run: () => { throw new AdapterUnavailable("FAKE-vendor", "vendor_portal_upload"); } } };
    const fails: NamedRunner = { name: "fails", runner: { mode: "in_command", run: () => { throw new Error("fake_timeout: the FAKE port did not answer"); } } };
    const mk = (code: string, runner: NamedRunner) => cycleDef({ cycle_code: code, owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "daily", period_grammar: "day", selector: selectors.global, runner, receipt_event: `${code}.run_completed`, expected_by_rule: "same_day 23:59 ET" });
    const { rt, clock } = runtimeAt("2026-10-05T14:00:00.000Z", [mk("test_dies", dies), mk("test_fails", fails), mk("test_noop", noop), mk("test_noop_2", noop)]);
    const svc = cyclesOf(rt);
    await svc.plan({ cycle_codes: ["test_dies", "test_fails", "test_noop"] });
    const ex = await runExecutor(rt, { holder: "h1", drain: "all" });
    assert.equal(ex.claimed, 3); assert.equal(ex.dead, 1); assert.equal(ex.failed, 1); assert.equal(ex.done, 1);
    const deadJob = await jobOf(`cycle_code = 'test_dies'`); const failedJob = await jobOf(`cycle_code = 'test_fails'`);
    assert.equal(deadJob["status"], "dead"); assert.equal(deadJob["last_error_class"], "adapterunavailable"); assert.equal(failedJob["status"], "failed"); assert.equal(failedJob["run_after"], "2026-10-05T14:01:00.000Z", "run_after ahead of the wall clock: cycles.retry's early retry");
    // a queued no-op unit for cycles.run_unit, planned after the executor ran
    await svc.plan({ cycle_codes: ["test_noop_2"] });
    const queued = await jobOf(`cycle_code = 'test_noop_2' AND period_key = '2026-10-05'`);
    assert.equal(queued["status"], "queued");
    const snapshot = async (): Promise<string> => JSON.stringify([await count(`loan_events`), await count(`job_events`), await count(`jobs`), (await db.query<Row>(`SELECT id::text AS id, status, attempts, lease_holder FROM jobs ORDER BY id`)), await count(`agent_decisions`), await count(`escalations`), await count(`timers`)]);
    // (a) NO_CLIENT_STATE: an input carrying state, custodial, a *_cents key or changes (nested under `input`) is refused before any row or event is written
    const before = await snapshot();
    for (const nested of [{ state: {} }, { custodial: {} }, { amount_cents: "1" }, { changes: {} }]) {
      await assert.rejects(rt.execute({ process: "35.3", name: "cycles.run_unit", loanId: "", actor: OPS_STEWARD, input: { job_id: String(queued["id"]), input: nested } }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_CLIENT_STATE", `refused for ${JSON.stringify(nested)}`);
    }
    for (const top of [{ state: {} }, { custodial: {} }, { upb_cents: "1" }]) {
      await assert.rejects(rt.execute({ process: "35.3", name: "cycles.run_unit", loanId: "", actor: OPS_STEWARD, input: { job_id: String(queued["id"]), ...top } }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_CLIENT_STATE", `refused for ${JSON.stringify(top)}`);
    }
    assert.equal(await snapshot(), before, "a refusal writes no row and no event (the guardrail refuses before the transaction opens)");
    assert.equal((await events("command.refused")).length, 0, "command.refused is never persisted");
    // (b) jobs.requeue{op: requeue} by an agent on the dead job → ROLE_REQUIRED naming ops_analyst; the job stays dead
    await assert.rejects(rt.execute({ process: "35.3", name: "jobs.requeue", loanId: "", actor: OPS_STEWARD, input: { job_id: String(deadJob["id"]), op: "requeue", reason: "an agent tries" } }), (e: unknown) => e instanceof CommandRefused && e.code === "ROLE_REQUIRED" && /ops_analyst/.test(e.message));
    await assert.rejects(rt.execute({ process: "35.3", name: "jobs.requeue", loanId: "", actor: { kind: "agent", id: "cashiering" }, input: { job_id: String(deadJob["id"]), op: "abandon", reason: "another agent tries" } }), (e: unknown) => e instanceof CommandRefused && (e.code === "ROLE_REQUIRED" || e.code === "NOT_ALLOWLISTED"));
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'dead'`, [deadJob["id"]]), 1); assert.equal((await events(EVT.RESOLVED)).length, 0);
    assert.equal(await snapshot(), before);
    // (c) + (d): one call of each of the nine tools — the ops_analyst's requeue among them — with the ledger and every money column byte-identical before and after each (moneyFingerprint plus 35.3's probe over payments.amount_cents and the fees entity versions' amount_cents)
    const analyst = await staff(clock, "analyst@example.test", "ops_analyst");
    const probe = async (): Promise<string> => {
      const pay = (await db.query<Row>(`SELECT count(*)::text AS n, coalesce(sum(amount_cents), 0)::text AS s FROM payments`))[0]!;
      const fees = (await db.query<Row>(`SELECT count(*)::text AS n, md5(coalesce(string_agg(kind || ':' || id || ':' || version::text || ':' || coalesce(data->>'amount_cents', ''), ',' ORDER BY id, version), '')) AS h FROM entity_records WHERE kind = 'fees'`))[0]!;
      const lines = (await db.query<Row>(`SELECT count(*)::text AS n, coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines`))[0]!;
      return `${await moneyFingerprint(db)}|${JSON.stringify(pay)}|${JSON.stringify(fees)}|${JSON.stringify(lines)}`;
    };
    const runId = String(queued["run_id"]);
    const calls: [string, () => Promise<unknown>][] = [
      ["cycles.registry", () => rt.execute({ process: "35.3", name: "cycles.registry", loanId: "", actor: OPS_STEWARD, input: { op: "list" } })],
      ["cycles.plan", () => rt.execute({ process: "35.3", name: "cycles.plan", loanId: "", actor: OPS_STEWARD, input: { cycle_codes: ["test_noop_2"] } })],
      ["cycles.run_unit", () => rt.execute({ process: "35.3", name: "cycles.run_unit", loanId: "", actor: OPS_STEWARD, input: { job_id: String(queued["id"]) } })],
      ["cycles.receipt", () => rt.execute({ process: "35.3", name: "cycles.receipt", loanId: "", actor: OPS_STEWARD, input: { run_id: runId } })],
      ["cycles.retry", () => rt.execute({ process: "35.3", name: "cycles.retry", loanId: "", actor: OPS_STEWARD, input: { job_id: String(failedJob["id"]) } })],
      ["cycles.escalate", () => rt.execute({ process: "35.3", name: "cycles.escalate", loanId: "", actor: OPS_STEWARD, input: { job_id: String(deadJob["id"]), reason: "the vendor is down; escalating by hand" } })],
      ["jobs.list", () => rt.execute({ process: "35.3", name: "jobs.list", loanId: "", actor: OPS_STEWARD, input: { status: "dead" } })],
      ["jobs.requeue", () => rt.execute({ process: "35.3", name: "jobs.requeue", loanId: "", actor: analyst, input: { job_id: String(deadJob["id"]), op: "requeue", reason: "vendor restored at 14:30" } })],
      ["writeDecision", () => rt.execute({ process: "35.3", name: "writeDecision", loanId: "", actor: OPS_STEWARD, input: { action: "cycles.note", rationale: "contract test", subject: { kind: "cycle", id: "test_noop" }, rule_set_version: "cycles.v1" } })],
    ];
    const outputs: Record<string, unknown> = {};
    for (const [name, call] of calls) {
      const fp = await probe();
      outputs[name] = (await call() as { output: unknown }).output;
      assert.equal(await probe(), fp, `${name} moved no money column`);
    }
    assert.equal(Object.keys(outputs).length, 9);
    // what the nine did: the by-hand claim, the early retry, the escalation, the requeue
    assert.equal((outputs["cycles.run_unit"] as Row)["claimed"], true); assert.equal(await count(`jobs WHERE id = $1 AND status = 'running' AND lease_holder = 'byhand:agent:ops-steward' AND attempts = 1`, [queued["id"]]), 1);
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'queued' AND run_after IS NULL AND attempts = 1`, [failedJob["id"]]), 1, "cycles.retry: queued now, the attempt already counted stays");
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'requeued' AND (detail->>'early')::boolean = true`, [failedJob["id"]]), 1);
    assert.equal(await count(`agent_decisions WHERE action = 'cycles.retry' AND agent = 'ops-steward' AND subject_kind = 'test_fails'`), 1);
    assert.equal(await count(`escalations WHERE kind = 'sev3' AND owner_role = 'ops_analyst' AND payload->>'job_id' = $1 AND payload->>'by_hand' = 'true' AND payload->>'reason' = 'the vendor is down; escalating by hand'`, [deadJob["id"]]), 1);
    assert.equal(await count(`agent_decisions WHERE action = 'cycles.escalate' AND subject_kind = 'test_dies'`), 1);
    assert.ok(Array.isArray(outputs["jobs.list"]) && (outputs["jobs.list"] as Row[]).some((j) => j["id"] === deadJob["id"]));
    assert.ok(Array.isArray(outputs["cycles.registry"]) && (outputs["cycles.registry"] as Row[]).some((r) => r["cycle_code"] === "test_noop_2"));
    assert.equal((outputs["cycles.receipt"] as Row)["run"] !== undefined, true);
    // (c): the ops_analyst's requeue — job.unit.resolved{disposition: requeued}, the decision names the person and the reason
    const resolved = await events(EVT.RESOLVED, `AND aggregate_id = $2`, [deadJob["id"]]);
    assert.equal(resolved.length, 1); assert.equal(resolved[0]!.payload["disposition"], "requeued"); assert.equal(resolved[0]!.payload["by"], analyst.id); assert.equal(resolved[0]!.payload["reason"], "vendor restored at 14:30"); assert.equal(resolved[0]!.actor_id, analyst.id);
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'queued' AND attempts = 0 AND max_attempts = 3`, [deadJob["id"]]), 1);
    assert.equal(await count(`agent_decisions WHERE action = 'jobs.requeue:requeue' AND agent = 'ops-steward' AND approved_by = $1 AND approved_role = 'ops_analyst' AND subject_kind = 'test_dies' AND subject_id = 'global' AND rationale LIKE '%vendor restored at 14:30%'`, [analyst.id]), 1);
    assert.equal(await count(`timers WHERE code = 'SM_JOB_DEAD_2H' AND subject_id = $1 AND status = 'satisfied' AND satisfied_by_event_id = $2`, [deadJob["id"], resolved[0]!.id]), 1);
    assert.equal(await count(`agent_decisions WHERE action = 'cycles.note' AND agent = 'ops-steward' AND subject_kind = 'cycle' AND subject_id = 'test_noop'`), 1);
    // JOB_RETRY_CAP_3 and UNIT_RUNS_AS_OWNER refuse before anything is written
    await assert.rejects(rt.execute({ process: "35.3", name: "cycles.retry", loanId: "", actor: OPS_STEWARD, input: { job_id: String(failedJob["id"]), max_attempts: 9 } }), (e: unknown) => e instanceof CommandRefused && e.code === "JOB_RETRY_CAP_3");
    await assert.rejects(rt.execute({ process: "35.3", name: "cycles.run_unit", loanId: "", actor: OPS_STEWARD, input: { job_id: String(failedJob["id"]), run_as: "officer" } }), (e: unknown) => e instanceof CommandRefused && e.code === "UNIT_RUNS_AS_OWNER");
  } finally { await close(); }
});
test("35.3-T14: Given `SM_CYCLE_PLANNER_DAILY` armed on the global subject by the first `cycles.plan.run_completed`, when a day passes with `cycles.plan` never completing (every pass `cycles.plan.skipped` because a test holds key 35003), then the clock breaches at 23:59 ET with one `ops_analyst` escalation and 35.1's `SM_SWEEP_HEARTBEAT_DAILY` did not breach; when the lock is released and a pass completes, then the clock is satisfied and re-armed for the next day and only one armed global instance of the code exists.", { skip }, async () => {
  await open("t14");
  try {
    const { rt, clock } = runtimeAt("2026-10-05T16:00:00.000Z");   // D 12:00 ET
    const svc = cyclesOf(rt);
    const armed = (): Promise<number> => count(`timers WHERE code = 'SM_CYCLE_PLANNER_DAILY' AND subject_kind = 'global' AND status = 'armed'`);
    const first = await svc.plan();
    assert.equal(first.skipped, false); assert.equal(first.as_of_date, "2026-10-05");
    // the first cycles.plan.run_completed arms the recurring global clock: due D+1 23:59 ET (the override's hour)
    const inst = (await db.query<Row>(`SELECT id::text AS id, due_at, anchor_date::text AS anchor_date, status FROM timers WHERE code = 'SM_CYCLE_PLANNER_DAILY' AND subject_kind = 'global' AND status = 'armed'`))[0]!;
    assert.equal(inst["status"], "armed"); assert.equal(inst["anchor_date"], "2026-10-05"); assert.equal(inst["due_at"], "2026-10-07T03:59:00.000Z");
    assert.equal(await armed(), 1);
    // a day passes with every pass refused (a test holds key 35003): each sweep appends cycles.plan.skipped and the sweep's other passes run
    const held = await holdPlannerLock("stuck-planner");
    const skippedBefore = (await events(EVT.PLAN_SKIPPED)).length;
    const s1 = await rt.sweep(); assert.equal(s1.cycles?.skipped, true); assert.equal(s1.breaches.some((b) => b.code === "SM_CYCLE_PLANNER_DAILY"), false);
    clock.set("2026-10-06T12:00:00.000Z");   // D+1 08:00 ET
    const s2 = await rt.sweep(); assert.equal(s2.cycles?.skipped, true); assert.equal(s2.breaches.some((b) => b.code === "SM_CYCLE_PLANNER_DAILY"), false);
    assert.equal((await events(EVT.PLAN_SKIPPED)).length - skippedBefore, 2);
    // 23:59:30 ET on D+1: the clock breaches with one ops_analyst escalation; 35.1's heartbeat did not breach
    clock.set("2026-10-07T03:59:30.000Z");
    const s3 = await rt.sweep();
    assert.equal(s3.cycles?.skipped, true);
    assert.deepEqual(s3.breaches.filter((b) => b.code === "SM_CYCLE_PLANNER_DAILY").map((b) => b.timer_id), [inst["id"]]);
    assert.equal(await count(`timers WHERE id = $1 AND status = 'breached'`, [inst["id"]]), 1);
    assert.equal((await events("timer.breached", `AND payload->>'timer_id' = $2`, [inst["id"]])).length, 1);
    assert.equal(await count(`escalations WHERE sla_timer_id = $1 AND owner_role = 'ops_analyst' AND kind = 'sev2' AND completed_at IS NULL`, [inst["id"]]), 1);
    assert.equal(await count(`timers WHERE code = 'SM_SWEEP_HEARTBEAT_DAILY' AND status = 'breached'`), 0);
    // the lock is released and a pass completes: the clock is satisfied (late) and re-armed for the next day — one armed global instance
    await held.release();
    const s4 = await rt.sweep();
    assert.equal(s4.cycles?.skipped, false); assert.equal(s4.cycles?.plan?.as_of_date, "2026-10-06");
    assert.equal(await count(`timers WHERE id = $1 AND status = 'satisfied_late'`, [inst["id"]]), 1);
    const next = (await db.query<Row>(`SELECT due_at, anchor_date::text AS anchor_date FROM timers WHERE code = 'SM_CYCLE_PLANNER_DAILY' AND subject_kind = 'global' AND status = 'armed'`));
    assert.equal(next.length, 1); assert.equal(next[0]!["anchor_date"], "2026-10-06"); assert.equal(next[0]!["due_at"], "2026-10-08T03:59:00.000Z");
    assert.equal(await armed(), 1);
    assert.equal(await advisoryLocks(), 0);
  } finally { await close(); }
});
test("35.3-T15: Given the planner's last pass was on 2026-09-30 and the demo clock steps to 2026-10-01, when the first pass of October runs, then exactly one `ledger.month.ended{period_key: 2026-09, period_end: 2026-09-30}` exists on the global subject, a second October pass appends none, and 35.4's `SM_CLOSE_PERIOD_OPEN_BD1` is armed on it.", { skip }, async () => {
  await open("t15");
  try {
    // the demo clock (src/runtime/demo-clock.ts OffsetClock) over a fixed wall clock: the planner's last pass of September ran at 2026-09-30 12:00 ET with no offset
    const base = new FixedClock("2026-09-30T16:00:00.000Z");
    const clock = await loadDemoClock(db, { base });
    const rt = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: null, reviewers: null, analystLlm: null, databaseUrl: DB_URL });
    installCycles(rt);
    const monthEnded = (): ReturnType<typeof events> => events(EVT.MONTH_ENDED, `AND payload->>'period_key' = '2026-09'`);
    const sep = await cyclesSweepPass(rt, clock.now(), { drain: "all", cycle_codes: ["month_end"] });
    assert.equal(sep.skipped, false); assert.equal(sep.plan?.as_of_date, "2026-09-30"); assert.equal((await monthEnded()).length, 0, "September's own month end is not October's business");
    // the demo clock steps to 2026-10-01 (one persisted demo_clock row — the offset the API instance advanced by; rule 10): the first pass of October re-reads it, plans month_end for 2026-09 and its single global unit appends ledger.month.ended exactly once
    const step = await clock.step(db, "2026-10-01T16:00:00.000Z", { advance_id: randomUUID(), step: 1, steps: 1, kind: "day", actor: "test" });
    assert.equal(Number(step.offset_ms), 86_400_000); assert.equal(clock.now(), "2026-10-01T16:00:00.000Z");
    const oct = await cyclesSweepPass(rt, "2026-10-01T16:00:00.000Z", { drain: "all", cycle_codes: ["month_end"] });
    assert.equal(oct.skipped, false); assert.equal(oct.plan?.as_of_date, "2026-10-01"); assert.equal(oct.runs_opened, 1); assert.equal(oct.jobs_planned, 1); assert.equal(oct.units_done, 1); assert.equal(oct.units_dead, 0);
    let ended = await monthEnded();
    assert.equal(ended.length, 1);
    assert.equal(ended[0]!.payload["period_end"], "2026-09-30"); assert.equal(ended[0]!.payload["origination"], true); assert.equal(ended[0]!.loan_id, null); assert.equal(ended[0]!.actor_id, "ops-steward");
    assert.equal(ended[0]!.occurred_at, "2026-10-01T16:00:00.000Z", "the unit's command runs on the demo clock");
    const run = (await db.query<Row>(`SELECT id::text AS id, status, units_total, units_done, receipt_id::text AS receipt_id, demo_offset_ms::text AS demo_offset_ms, opened_at FROM cycle_runs WHERE cycle_code = 'month_end' AND period_key = '2026-09'`))[0]!;
    assert.equal(run["status"], "completed"); assert.equal(run["units_total"], 1); assert.equal(run["units_done"], 1); assert.ok(run["receipt_id"]);
    assert.equal(run["demo_offset_ms"], "86400000", "the run records the persisted offset it was planned under"); assert.equal(run["opened_at"], "2026-10-01T16:00:00.000Z");
    // the job's lease and timestamps are the wall clock's (the base), never the demo clock's (rule 6, D8)
    assert.equal(await count(`jobs WHERE idempotency_key = 'month_end:2026-09:global' AND heartbeat_at = '2026-09-30T16:00:00.000Z'::timestamptz AND finished_at = '2026-09-30T16:00:00.000Z'::timestamptz`), 1);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1 AND emitted_by LIKE 'unit:%'`, [run["id"]]), 1);
    assert.equal(await count(`jobs WHERE idempotency_key = 'month_end:2026-09:global' AND status = 'done' AND decision_id IS NOT NULL`), 1);
    assert.equal(await count(`agent_decisions WHERE agent = 'ops-steward' AND action = 'cycles.run_unit' AND subject_kind = 'month_end' AND subject_id = 'global' AND prompt_version = '35.3-v1' AND rule_set_version = 'cycles.v1' AND rationale LIKE 'month_end 2026-09 unit global:%'`), 1, "one decision for September's unit (the September-30 pass ran August's, the prior month of its own day)");
    assert.equal((await events("ledger.month_end.run_completed", `AND aggregate_id = $2`, [run["id"]])).length, 1);
    assert.equal((await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [run["id"]])).length, 1);
    // a second October pass appends none (the run and the job already exist)
    base.set("2026-09-30T16:05:00.000Z");
    assert.equal(clock.now(), "2026-10-01T16:05:00.000Z");
    const again = await cyclesSweepPass(rt, clock.now(), { drain: "all", cycle_codes: ["month_end"] });
    assert.equal(again.skipped, false); assert.equal(again.runs_opened, 0); assert.equal(again.jobs_planned, 0); assert.equal(again.units_done, 0);
    ended = await monthEnded(); assert.equal(ended.length, 1);
    // 35.4's SM_CLOSE_PERIOD_OPEN_BD1 (anchor period_end, +1 business_days_fannie_et 17:00 ET) is armed on it, on the global subject: due 2026-10-01 17:00 ET
    const t = await db.query<Row>(`SELECT status, subject_kind, subject_id, loan_id, anchor_date::text AS anchor_date, due_at FROM timers WHERE code = 'SM_CLOSE_PERIOD_OPEN_BD1' AND armed_by_event_id = $1`, [ended[0]!.id]);
    assert.equal(t.length, 1); assert.equal(t[0]!["status"], "armed"); assert.equal(t[0]!["subject_kind"], "global"); assert.equal(t[0]!["loan_id"], null); assert.equal(t[0]!["anchor_date"], "2026-09-30"); assert.equal(t[0]!["due_at"], "2026-10-01T21:00:00.000Z");
  } finally { await close(); }
});
test("35.3-T16: Given the registered bus pair (`35.3`, `cycles.run_unit`) and a `metro2_monthly` job for `2026-09`, when it runs, then 8.1's snapshot builder is invoked with `as_of_date 2026-09-30` under the actor `{agent, credit-reporting}`, `credit.cycle.snapshot_completed` is appended by 8.1's own code (credit-reporting/ops.ts:214-218) in the same transaction as `job.unit.done`, no `(8.1, *)` bus pair was needed, and the decision record's `prompt_version` is `35.3-v1` with `subject_kind metro2_monthly`.", { skip }, async () => {
  await open("t16");
  try {
    const { rt, clock } = runtimeAt("2026-09-30T16:00:00.000Z");   // the production registry
    const svc = cyclesOf(rt);
    // the registered bus pair is 35.3's; 8.1 registers none (spec/registry/manifest.json: `8.1 tools: []`)
    assert.ok(rt.tool("35.3", "cycles.run_unit")); assert.equal(rt.tool("8.1", "cycles.run_unit"), undefined); assert.equal(rt.listTools().some((t) => t.process === "8.1"), false);
    // D11: the month's last cashiering day first — no fixture loan, so the run is zero-unit and receipts at planning — the dependency (cashiering_daily, 2026-09-30) the metro2 unit waits on
    const sep = await cyclesSweepPass(rt, "2026-09-30T16:00:00.000Z", { drain: "all", cycle_codes: ["cashiering_daily"] });
    assert.equal(sep.skipped, false); assert.equal(await count(`cycle_receipts WHERE cycle_code = 'cashiering_daily' AND period_key = '2026-09-30'`), 1);
    // 00:05 ET on the 1st: the metro2_monthly run for 2026-09 — one period unit, queued because the dependency is met
    clock.set("2026-10-01T04:05:00.000Z");
    const p = await svc.plan({ cycle_codes: ["metro2_monthly"] });
    assert.equal(p.runs_opened, 1); assert.equal(p.jobs_planned, 1); assert.deepEqual(p.period_keys, ["metro2_monthly:2026-09"]);
    const job = await jobOf(`idempotency_key = 'metro2_monthly:2026-09:2026-09'`);
    assert.equal(job["status"], "queued"); assert.equal(job["unit_id"], "2026-09"); assert.deepEqual(job["input"], { period_key: "2026-09", period_end: "2026-09-30" });
    const ex = await runExecutor(rt, { holder: "h1", drain: "all" });
    assert.equal(ex.claimed, 1); assert.equal(ex.done, 1, JSON.stringify(ex));
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'done'`, [job["id"]]), 1);
    // the command that ran it: (35.3, cycles.run_unit) as the credit-reporting agent — no (8.1, *) pair was needed
    const executed = await events("command.executed", `AND payload->>'command' = 'cycles.run_unit'`);
    assert.equal(executed.length, 1); assert.equal(executed[0]!.payload["process"], "35.3"); assert.equal(executed[0]!.payload["agent"], "credit-reporting"); assert.equal(executed[0]!.actor_id, "credit-reporting"); assert.equal(executed[0]!.payload["run_id"], job["id"]); assert.equal(executed[0]!.payload["prompt_version"], "35.3-v1");
    assert.equal((await events("command.executed", `AND payload->>'process' = '8.1'`)).length, 0);
    // 8.1's own code appended credit.cycle.snapshot_completed{as_of_date: 2026-09-30} under the credit-reporting actor, in the same transaction as job.unit.done
    const snap = await events("credit.cycle.snapshot_completed");
    assert.equal(snap.length, 1); assert.equal(snap[0]!.payload["as_of_date"], "2026-09-30"); assert.equal(snap[0]!.payload["cycle_id"], "2026-09"); assert.equal(snap[0]!.actor_id, "credit-reporting"); assert.equal(snap[0]!.aggregate_kind, "metro2_cycle"); assert.equal(snap[0]!.aggregate_id, "2026-09");
    const opened = await events("credit.cycle.opened", `AND aggregate_id = '2026-09'`); assert.equal(opened.length, 1); assert.equal(opened[0]!.payload["as_of_date"], "2026-09-30"); assert.equal(opened[0]!.actor_id, "credit-reporting");
    const done = await events(EVT.DONE, `AND aggregate_id = $2`, [job["id"]]);
    assert.equal(done.length, 1);
    const xmins = await db.query<{ type: string; xmin: string }>(`SELECT type, xmin::text AS xmin FROM loan_events WHERE id = ANY($1::uuid[])`, [[snap[0]!.id, done[0]!.id]]);
    assert.equal(xmins.length, 2); assert.equal(xmins[0]!.xmin, xmins[1]!.xmin, "one transaction"); assert.equal(snap[0]!.occurred_at, done[0]!.occurred_at);
    assert.ok((await events("credit.cycle.validated", `AND aggregate_id = '2026-09'`)).length + (await events("credit.cycle.held", `AND aggregate_id = '2026-09'`)).length === 1);
    // the decision record: prompt_version 35.3-v1, subject_kind metro2_monthly, subject_id the period, the owner agent
    const decision = (await db.query<Row>(`SELECT agent, action, subject_kind, subject_id, rule_set_version, model_version, prompt_version, confidence::text AS confidence, rationale FROM agent_decisions WHERE id = $1`, [done[0]!.payload["decision_id"]]))[0]!;
    assert.equal(decision["agent"], "credit-reporting"); assert.equal(decision["action"], "cycles.run_unit"); assert.equal(decision["prompt_version"], "35.3-v1"); assert.equal(decision["subject_kind"], "metro2_monthly"); assert.equal(decision["subject_id"], "2026-09"); assert.equal(decision["rule_set_version"], "cycles.v1"); assert.equal(decision["model_version"], "deterministic"); assert.match(String(decision["rationale"]), /^metro2_monthly 2026-09 unit 2026-09: /);
    assert.equal(await count(`jobs WHERE id = $1 AND decision_id = $2`, [job["id"], done[0]!.payload["decision_id"]]), 1);
    // the run's receipt: units_total 1, units_done 1, the cycle's literal and cycle.run.completed
    assert.equal(await count(`cycle_receipts WHERE run_id = $1 AND units_total = 1 AND units_done = 1`, [job["run_id"]]), 1);
    assert.equal((await events("credit.cycle.run_completed", `AND aggregate_id = $2`, [job["run_id"]])).length, 1);
    assert.equal((await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [job["run_id"]])).length, 1);
    assert.equal(await count(`cycle_registry WHERE cycle_code = 'metro2_monthly' AND unit_scope = 'period' AND owner_agent = 'credit-reporting' AND escalation_role = 'officer' AND last_period_key = '2026-09'`), 1);
  } finally { await close(); }
});
