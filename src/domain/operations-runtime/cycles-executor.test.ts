// 35.3 — the executor pieces the G2 review reshaped, exercised end to end (not T-id tests; those live in 35-3.spec.test.ts):
//   a stale attempt's throw records nothing: `markFailed` / `markDead` carry the lease guard `markDone` already had (LEASE_LOST), so an
//   executor whose lease the planner reclaimed (T10's given) and whose unit another holder ran to done appends no `job.unit.failed` /
//   `job.unit.dead`, arms no SM_JOB_DEAD_2H, opens no escalation and moves no counter on a job it no longer holds;
//   `ExecutorReport.receipts` is the tally of the receipts THIS executor elected, not a table-count delta (three executors over one
//   queue would each see the single receipt appear — T3's "exactly one executor elected" was timing-dependent);
//   the executor adopts a by-hand claim only once its heartbeat is stale (jobs.ts BYHAND_ADOPT_AFTER_MS): a fresh claim may be a
//   dispatcher mid-run (runUnitByHand heartbeats while it runs), and rule 6 says no unit runs twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createLogger } from "../../runtime/log.ts";
import { AdapterUnavailable } from "../../infra/integrations/failures.ts";
import { EVT, def as cycleDef, selectors, type CycleDef, type NamedRunner } from "./cycles.ts";
import { OPS_STEWARD, cyclesOf, installCycles, runClaimed, runExecutor } from "./service.ts";
import { BYHAND_ADOPT_AFTER_MS, claimJobs, wallClockOf } from "./jobs.ts";

const probe = await testDatabase(import.meta.url, { provision: false });
const skip = probe.skip;
type Row = Record<string, unknown>;
let db: Db; let DB_URL = "";
const open = async (suffix: string): Promise<void> => { const t = await testDatabase(import.meta.url, { suffix }); DB_URL = t.url; db = connect(DB_URL); };
const logger = createLogger("json", () => undefined);
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
const runtimeAt = (iso: string, defs: readonly CycleDef[]): { rt: Runtime; clock: FixedClock } => {
  const clock = new FixedClock(iso);
  const rt = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: null, reviewers: null, analystLlm: null, databaseUrl: DB_URL });
  installCycles(rt, { defs });
  return { rt, clock };
};
const globalDef = (code: string, runner: NamedRunner): CycleDef => cycleDef({ cycle_code: code, owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "daily", period_grammar: "day", selector: selectors.global, runner, receipt_event: `${code}.run_completed`, escalation_role: "officer", expected_by_rule: "same_day 23:59 ET" });
const noop: NamedRunner = { name: "noop", runner: { mode: "in_command", run: () => ({ outcome: "noop" }) } };
const plusSeconds = (iso: string, s: number): string => new Date(Date.parse(iso) + s * 1000).toISOString();
/** The job's status, attempts, holder and decision, plus everything a stale failure would have written for it. */
const footprint = async (jobId: string, runId: string): Promise<Row> => ({
  job: (await db.query<Row>(`SELECT status, attempts, lease_holder, last_error_class, decision_id::text AS decision_id FROM jobs WHERE id = $1`, [jobId]))[0]!,
  run: (await db.query<Row>(`SELECT status, units_total, units_done, units_dead, units_skipped FROM cycle_runs WHERE id = $1`, [runId]))[0]!,
  failed_events: await count(`loan_events WHERE type = $1 AND aggregate_id = $2`, [EVT.FAILED, jobId]),
  dead_events: await count(`loan_events WHERE type = $1 AND aggregate_id = $2`, [EVT.DEAD, jobId]),
  failed_rows: await count(`job_events WHERE job_id = $1 AND kind IN ('failed', 'dead')`, [jobId]),
  dead_clocks: await count(`timers WHERE code = 'SM_JOB_DEAD_2H' AND subject_id = $1`, [jobId]),
  escalations: await count(`escalations WHERE payload->>'job_id' = $1`, [jobId]),
  receipts: await count(`cycle_receipts WHERE run_id = $1`, [runId]),
});

test("35.3 a stale attempt's throw records nothing: the planner reclaimed its lease and another executor ran the unit to done — the late failure (a retryable throw, and an unavailable one) returns `lost`, appends no job.unit.failed / job.unit.dead, arms no SM_JOB_DEAD_2H, opens no escalation and leaves the run's counters and receipt as they were", { skip }, async () => {
  await open("stale");
  try {
    // two units whose runner throws only on the stale attempt (attempt 1 — the claim the planner reclaims) and succeeds on the re-run (attempt 2)
    const failsStale: NamedRunner = { name: "fails_stale", runner: { mode: "in_command", run: (_rt, _ctx, unit) => { if (unit.attempt === 1) throw new Error("fake_port_timeout: the stale attempt's port did not answer"); return { outcome: "ok" }; } } };
    const diesStale: NamedRunner = { name: "dies_stale", runner: { mode: "in_command", run: (_rt, _ctx, unit) => { if (unit.attempt === 1) throw new AdapterUnavailable("FAKE-vendor", "vendor_portal_upload"); return { outcome: "ok" }; } } };
    const { rt, clock } = runtimeAt("2026-10-05T14:00:00.000Z", [globalDef("test_stale_fails", failsStale), globalDef("test_stale_dies", diesStale)]);
    const svc = cyclesOf(rt);
    const planned = await svc.plan();
    assert.equal(planned.runs_opened, 2); assert.equal(planned.jobs_planned, 2);
    // executor A claims both (attempt 1) and stops heartbeating; the wall clock passes lease_until and the planner reclaims them (T10's given)
    const stale = await claimJobs(rt.db, "A", 20, wallClockOf(rt).now());
    assert.equal(stale.length, 2); assert.ok(stale.every((j) => j.attempts === 1 && j.lease_holder === "A"));
    clock.set(plusSeconds("2026-10-05T14:00:00.000Z", 6 * 60));
    const reclaimed = await svc.plan();
    assert.equal(reclaimed.leases_reclaimed, 2);
    // executor B runs both to done (attempt 2); both runs complete with their receipts
    const b = await runExecutor(rt, { holder: "B", drain: "all" });
    assert.equal(b.claimed, 2); assert.equal(b.done, 2); assert.equal(b.receipts, 2); assert.equal(b.lost, 0);
    const before = new Map<string, Row>();
    for (const j of stale) before.set(j.id, await footprint(j.id, j.run_id));
    for (const j of stale) { const f = before.get(j.id)!; assert.equal((f["job"] as Row)["status"], "done"); assert.equal((f["job"] as Row)["attempts"], 2); assert.equal((f["run"] as Row)["status"], "completed"); assert.equal(f["receipts"], 1); assert.equal(f["failed_rows"], 0); assert.equal(f["dead_clocks"], 0); assert.equal(f["escalations"], 0); }
    // A wakes up and runs its stale claims: the runner throws on attempt 1 (a retryable throw for one unit, an `unavailable` one for the other); both are `lost`, and nothing of the failure lands on the jobs B finished
    const late = new Map<string, string>();
    for (const j of stale) late.set(j.cycle_code, await runClaimed(rt, j, "A"));
    assert.deepEqual([...late.entries()].sort(), [["test_stale_dies", "lost"], ["test_stale_fails", "lost"]]);
    for (const j of stale) assert.deepEqual(await footprint(j.id, j.run_id), before.get(j.id), `${j.cycle_code}: the stale attempt wrote nothing`);
    assert.equal(await count(`loan_events WHERE type IN ($1, $2)`, [EVT.FAILED, EVT.DEAD]), 0);
    assert.equal(await count(`timers WHERE code = 'SM_JOB_DEAD_2H'`), 0);
    assert.equal(await count(`escalations`), 0);
    assert.equal(await count(`cycle_runs WHERE units_dead <> 0`), 0);
    assert.equal(await count(`cycle_receipts`), 2);
  } finally { await db.end(); }
});

test("35.3 ExecutorReport.receipts is the tally of the receipts this executor elected — a receipt the planner (or another executor) elected while a unit of this executor was running is not counted", { skip }, async () => {
  await open("receipts");
  try {
    // unit B blocks inside its (pass-shaped) runner until the test releases it; unit A is a no-op
    let release: () => void = () => undefined; let started: () => void = () => undefined;
    const gate = new Promise<void>((res) => { release = res; }); const running = new Promise<void>((res) => { started = res; });
    const blocks: NamedRunner = { name: "blocks", runner: { mode: "pass", run: async () => { started(); await gate; return { outcome: "released" }; } } };
    const { rt } = runtimeAt("2026-10-05T14:00:00.000Z", [globalDef("test_receipt_a", noop), globalDef("test_receipt_b", blocks)]);
    const svc = cyclesOf(rt);
    const planned = await svc.plan();
    assert.equal(planned.runs_opened, 2); assert.equal(planned.jobs_planned, 2);
    // X runs A's unit without electing (the executor's injectable stop, T5b): A's run is full with no receipt row yet; B's claim is put back the way a reclaim would (queued, attempts 0)
    const claimed = await claimJobs(rt.db, "X", 20, wallClockOf(rt).now());
    const a = claimed.find((j) => j.cycle_code === "test_receipt_a")!; const bJob = claimed.find((j) => j.cycle_code === "test_receipt_b")!;
    assert.equal(await runClaimed(rt, a, "X", { electReceipt: false }), "done");
    await db.query(`UPDATE jobs SET status = 'queued', lease_holder = NULL, lease_until = NULL, heartbeat_at = NULL, attempts = 0 WHERE id = $1`, [bJob.id]);
    assert.equal(await count(`cycle_runs WHERE id = $1 AND status = 'running' AND units_done = 1 AND units_total = 1`, [a.run_id]), 1);
    assert.equal(await count(`cycle_receipts`), 0);
    // executor Y claims B's unit and is inside its runner when A's receipt is elected by someone else (the planner's reconciliation shape)
    const y = runExecutor(rt, { holder: "Y", drain: "all" });
    await running;
    const other = await svc.electReceipt(a.run_id, `planner:${a.run_id}`);
    assert.equal(other.elected, true);
    assert.equal(await count(`cycle_receipts`), 1);
    release();
    const report = await y;
    // Y finished B's unit and elected B's receipt — one receipt of its own, although two appeared while it ran
    assert.equal(report.claimed, 1); assert.equal(report.done, 1); assert.equal(report.lost, 0);
    assert.equal(await count(`cycle_receipts`), 2);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1 AND emitted_by = $2`, [bJob.run_id, `unit:${bJob.id}`]), 1);
    assert.equal(report.receipts, 1, "the tally is this executor's elections, not the receipts that appeared while it ran");
  } finally { await db.end(); }
});

test("35.3 the executor adopts a by-hand claim only once its heartbeat is stale: a fresh `byhand:` lease (its dispatcher may be running the unit) is left alone by the next pass; after three missed heartbeats the pass adopts it under its own holder and runs it", { skip }, async () => {
  await open("adopt");
  try {
    const { rt, clock } = runtimeAt("2026-10-05T14:00:00.000Z", [globalDef("test_byhand", noop)]);
    const svc = cyclesOf(rt);
    const planned = await svc.plan();
    assert.equal(planned.jobs_planned, 1);
    const job = (await db.query<Row>(`SELECT id::text AS id, run_id::text AS run_id FROM jobs WHERE cycle_code = 'test_byhand'`))[0]!;
    // the by-hand dispatch on the bus: the claim commits under `byhand:agent:ops-steward` with the wall clock's heartbeat; the unit is not run here (the generic tools route's shape)
    const claim = await rt.execute({ process: "35.3", name: "cycles.run_unit", loanId: "", actor: OPS_STEWARD, input: { job_id: String(job["id"]) } });
    assert.equal((claim.output as Row)["claimed"], true); assert.equal((claim.output as Row)["holder"], "byhand:agent:ops-steward");
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'running' AND lease_holder = 'byhand:agent:ops-steward' AND heartbeat_at = $2::timestamptz`, [job["id"], "2026-10-05T14:00:00.000Z"]), 1);
    // an executor pass a moment later: the heartbeat is fresh, so the claim is not adopted — nothing claimed, nothing run, the lease untouched
    clock.set(plusSeconds("2026-10-05T14:00:00.000Z", 10));
    const e1 = await runExecutor(rt, { holder: "E1", drain: "all" });
    assert.equal(e1.claimed, 0); assert.equal(e1.done, 0);
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'running' AND lease_holder = 'byhand:agent:ops-steward'`, [job["id"]]), 1);
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'claimed'`, [job["id"]]), 1);
    // three missed heartbeats later (BYHAND_ADOPT_AFTER_MS): the next pass adopts the lease under its own holder, runs the unit to done and elects the receipt
    clock.set(plusSeconds("2026-10-05T14:00:00.000Z", BYHAND_ADOPT_AFTER_MS / 1000 + 1));
    const e2 = await runExecutor(rt, { holder: "E2", drain: "all" });
    assert.equal(e2.claimed, 1); assert.equal(e2.done, 1); assert.equal(e2.receipts, 1);
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'done' AND lease_holder IS NULL AND attempts = 1 AND decision_id IS NOT NULL`, [job["id"]]), 1);
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'claimed' AND holder = 'E2' AND (detail->>'adopted_by_hand_claim')::boolean = true`, [job["id"]]), 1);
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'done' AND holder = 'E2'`, [job["id"]]), 1);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1 AND emitted_by = $2`, [job["run_id"], `unit:${String(job["id"])}`]), 1);
    assert.equal(await count(`loan_events WHERE type = $1 AND aggregate_id = $2`, [EVT.CLAIMED, job["id"]]), 1, "the by-hand claim's event; the adoption is a job_events row under the executor's holder");
  } finally { await db.end(); }
});
