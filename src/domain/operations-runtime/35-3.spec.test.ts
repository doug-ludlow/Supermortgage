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
import { CYCLES } from "./runners.ts";
import { EVT, def as cycleDef, selectors, type CycleDef } from "./cycles.ts";
import { OPS_STEWARD, cyclesOf, cyclesSweepPass, installCycles } from "./service.ts";
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
const runtimeAt = (iso: string, defs?: readonly CycleDef[]): { rt: Runtime; clock: FixedClock } => {
  const clock = new FixedClock(iso);
  const rt = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: null, reviewers: null, analystLlm: null, databaseUrl: DB_URL });
  installCycles(rt, defs ? { defs } : {});
  return { rt, clock };
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
test("35.3-T3: Given one run of 100 queued units, when three executors claim concurrently with `FOR UPDATE SKIP LOCKED LIMIT 20` until the queue is empty, then every unit has exactly one `job_events{done}` row and one `agent_decisions` row naming the owner agent, no `unit_id` appears in two executors' claim logs, `cycle_runs.units_done = 100`, and one `cycle_receipts` row exists.", { todo: true });
test("35.3-T4: Given a unit whose runner throws on every call, when the planner and executor run across four sweeps, then the job records attempts 1, 2, 3 with `run_after` 60 s and 120 s after the first two failures, the third failure appends `job.unit.dead{attempts: 3}`, `SM_JOB_DEAD_2H` is armed on the job, one escalation exists to the registry row's `escalation_role` naming `cycle_code`, `period_key` and `unit_id`, `cycle_runs.status` is still `running`, and no receipt was emitted.", { todo: true });
test("35.3-T5: Given a run of 3 units, when the last unit's `UPDATE … RETURNING` reports the counters full, then one `cycle_receipts` row and one pair of events (the cycle's receipt literal and `cycle.run.completed`) exist; given the executor is stopped between the unit's commit and the receipt transaction, when the next planner pass reconciles, then the same single receipt row exists with `emitted_by = planner:<run_id>` and the events were appended once; given both race, then the unique key on `cycle_receipts.run_id` yields one row and one pair of events.", { todo: true });
test("35.3-T6: Given `ledger.period.closed{period_key: 2026-09}` has been appended and `investor_reporting_periods.closed{period_key: 2026-09}` has not, when the planner runs, then the `form_496_monthly` job for `2026-09:<account>:A/A` is `blocked` and never claimed; when `investor_reporting_periods.closed{period_key: 2026-09}` is appended, then the next pass unblocks it (`job_events{unblocked}`) and the unit runs 6.3's chain.", { todo: true });
test("35.3-T7: Given 10,000 armed timers due at or before `now`, when the breach pass runs, then it uses 20 transactions of at most 500 timers each, every one of the 10,000 has exactly one `timer.breached` event and one escalation, and a second pass started concurrently breaches none of them twice (the `FOR UPDATE SKIP LOCKED` page).", { todo: true });
test("35.3-T8: Given the demo clock at 2026-10-01 12:00 ET and the fixture book, when `POST /v1/demo/advance {days: 3}` runs, then `cycles.plan.run_completed` was appended three times with `as_of_date` 2026-10-02, 2026-10-03 and 2026-10-04, `cycle_runs` holds one `cashiering_daily` and one `delinquency_counters` run per day with `period_key` equal to that day and `demo_offset_ms` equal to the step's `demo_clock.offset_ms`, every receipt of day N precedes day N+1's `cycle.run.opened` in `loan_events.sequence`, and every `jobs.lease_until` written during the advance is within 5 minutes of the wall-clock `real_now`, not of `demo_now`.", { todo: true });
test("35.3-T9: Given loan L with UPB $248,310.55, note rate 6.500%, P&I $1,612.34, escrow payment $432.78, an installment due 2026-10-01 unpaid past the 15-day grace and a late charge assessed at 5% of P&I, when the `statements` unit for `(L, 2026-10-01)` runs through `cycles.run_unit` on 2026-10-17, then the statement's late charge is $80.62, its interest portion $1,345.02, its principal portion $267.32 and its amount due $2,125.74, `statement.sent` and `job.unit.done` share one transaction (one `loan_events` batch), the decision names `disclosures`, exactly one `notices` row exists for `(L, 2026-10-01)` after a second plan and a second `cycles.run_unit` of the same job (refused `JOB_NOT_CLAIMABLE`), and the receipt reads `units_total 1, units_done 1`.", { todo: true });
test("35.3-T10: Given a job claimed with `lease_until` 5 minutes ahead by an executor that then stops heartbeating, when `now()` passes `lease_until` and the planner runs, then the job is `queued` again, `job.lease.expired{holder, attempt: 1}` is appended, `attempts` is 1, and a second executor's claim runs it to `done` with `attempt: 2`; given the demo clock is advanced 30 days while the first lease is live, then the lease is not expired by the advance.", { todo: true });
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
test("35.3-T13: Given `cycles.run_unit` is called with an `input` carrying `state`, `custodial`, any `*_cents` key or `changes`, then it is refused `NO_CLIENT_STATE` before any row or event is written; given `jobs.requeue{op: requeue}` on a dead job by an actor `{kind: \"agent\"}`, then `ROLE_REQUIRED{ops_analyst}` and the job stays `dead`; given an `ops_analyst` requeues it with a reason, then `job.unit.resolved` is appended, the decision names the person and the reason, and the ledger and every money column are byte-identical before and after every 35.3 tool call in a contract test over all nine tools.", { todo: true });
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
    const { rt, clock } = runtimeAt("2026-09-30T16:00:00.000Z");   // the planner's last pass of September, 12:00 ET
    const monthEnded = (): ReturnType<typeof events> => events(EVT.MONTH_ENDED, `AND payload->>'period_key' = '2026-09'`);
    const sep = await cyclesSweepPass(rt, "2026-09-30T16:00:00.000Z", { drain: "all", cycle_codes: ["month_end"] });
    assert.equal(sep.skipped, false); assert.equal((await monthEnded()).length, 0, "September's own month end is not October's business");
    // the demo clock steps to 2026-10-01: the first pass of October plans month_end for 2026-09 and its single global unit appends ledger.month.ended exactly once
    clock.set("2026-10-01T16:00:00.000Z");
    const oct = await cyclesSweepPass(rt, "2026-10-01T16:00:00.000Z", { drain: "all", cycle_codes: ["month_end"] });
    assert.equal(oct.skipped, false); assert.equal(oct.runs_opened, 1); assert.equal(oct.jobs_planned, 1); assert.equal(oct.units_done, 1); assert.equal(oct.units_dead, 0);
    let ended = await monthEnded();
    assert.equal(ended.length, 1);
    assert.equal(ended[0]!.payload["period_end"], "2026-09-30"); assert.equal(ended[0]!.payload["origination"], true); assert.equal(ended[0]!.loan_id, null); assert.equal(ended[0]!.actor_id, "ops-steward");
    const run = (await db.query<Row>(`SELECT id::text AS id, status, units_total, units_done, receipt_id::text AS receipt_id FROM cycle_runs WHERE cycle_code = 'month_end' AND period_key = '2026-09'`))[0]!;
    assert.equal(run["status"], "completed"); assert.equal(run["units_total"], 1); assert.equal(run["units_done"], 1); assert.ok(run["receipt_id"]);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1 AND emitted_by LIKE 'unit:%'`, [run["id"]]), 1);
    assert.equal(await count(`jobs WHERE idempotency_key = 'month_end:2026-09:global' AND status = 'done' AND decision_id IS NOT NULL`), 1);
    assert.equal(await count(`agent_decisions WHERE agent = 'ops-steward' AND action = 'cycles.run_unit' AND subject_kind = 'month_end' AND subject_id = 'global' AND prompt_version = '35.3-v1' AND rule_set_version = 'cycles.v1' AND rationale LIKE 'month_end 2026-09 unit global:%'`), 1, "one decision for September's unit (the September-30 pass ran August's, the prior month of its own day)");
    assert.equal((await events("ledger.month_end.run_completed", `AND aggregate_id = $2`, [run["id"]])).length, 1);
    assert.equal((await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [run["id"]])).length, 1);
    // a second October pass appends none (the run and the job already exist)
    const again = await cyclesSweepPass(rt, "2026-10-01T16:05:00.000Z", { drain: "all", cycle_codes: ["month_end"] });
    assert.equal(again.skipped, false); assert.equal(again.runs_opened, 0); assert.equal(again.jobs_planned, 0); assert.equal(again.units_done, 0);
    ended = await monthEnded(); assert.equal(ended.length, 1);
    // 35.4's SM_CLOSE_PERIOD_OPEN_BD1 (anchor period_end, +1 business_days_fannie_et 17:00 ET) is armed on it, on the global subject: due 2026-10-01 17:00 ET
    const t = await db.query<Row>(`SELECT status, subject_kind, subject_id, loan_id, anchor_date::text AS anchor_date, due_at FROM timers WHERE code = 'SM_CLOSE_PERIOD_OPEN_BD1' AND armed_by_event_id = $1`, [ended[0]!.id]);
    assert.equal(t.length, 1); assert.equal(t[0]!["status"], "armed"); assert.equal(t[0]!["subject_kind"], "global"); assert.equal(t[0]!["loan_id"], null); assert.equal(t[0]!["anchor_date"], "2026-09-30"); assert.equal(t[0]!["due_at"], "2026-10-01T21:00:00.000Z");
  } finally { await close(); }
});
test("35.3-T16: Given the registered bus pair (`35.3`, `cycles.run_unit`) and a `metro2_monthly` job for `2026-09`, when it runs, then 8.1's snapshot builder is invoked with `as_of_date 2026-09-30` under the actor `{agent, credit-reporting}`, `credit.cycle.snapshot_completed` is appended by 8.1's own code (credit-reporting/ops.ts:214-218) in the same transaction as `job.unit.done`, no `(8.1, *)` bus pair was needed, and the decision record's `prompt_version` is `35.3-v1` with `subject_kind metro2_monthly`.", { todo: true });
