// 35.3 — the pieces the G1 review added or reshaped, exercised end to end through the bus (not T-id tests; those live in 35-3.spec.test.ts):
//   jobs.requeue{op: requeue | abandon}: an agent is refused ROLE_REQUIRED, an ops_analyst resolves a dead unit — `job.unit.resolved`
//   satisfies SM_JOB_DEAD_2H, a requeue resets the attempts and the run's dead counter, an abandonment completes the run with a
//   receipt whose `units_dead` records the death (OQ3) and satisfies the stall clock;
//   the planner elects a zero-unit run's receipt and reconciles a full run on its own command batch (no nested unit of work);
//   a cycle whose owner emits its receipt literal gets `cycle.run.completed` only (rule 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createLogger } from "../../runtime/log.ts";
import { CommandRefused } from "../../app/commands.ts";
import { PgStaffRepository, emailHash, encryptEmail, staffEmailKey } from "../../runtime/staff/repo.ts";
import { EVT, def as cycleDef, selectors, type CycleDef, type NamedRunner } from "./cycles.ts";
import { CyclesRefused, OPS_STEWARD, cyclesOf, installCycles, runClaimed, runExecutor } from "./service.ts";
import { claimJobs, wallClockOf } from "./jobs.ts";

const probe = await testDatabase(import.meta.url, { provision: false });
const skip = probe.skip;
type Row = Record<string, unknown>;
let db: Db; let DB_URL = "";
const open = async (suffix: string): Promise<void> => { const t = await testDatabase(import.meta.url, { suffix }); DB_URL = t.url; db = connect(DB_URL); };
const logger = createLogger("json", () => undefined);
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))[0]!.n);
const events = async (type: string, where = "", params: unknown[] = []): Promise<{ id: string; aggregate_id: string | null; actor_id: string; actor_kind: string; payload: Row }[]> =>
  db.query(`SELECT id::text AS id, aggregate_id, actor_id, actor_kind::text AS actor_kind, payload FROM loan_events WHERE type = $1 ${where} ORDER BY sequence`, [type, ...params]);
const runtimeAt = (iso: string, defs: readonly CycleDef[]): { rt: Runtime; clock: FixedClock } => {
  const clock = new FixedClock(iso);
  const rt = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: null, reviewers: null, analystLlm: null, databaseUrl: DB_URL });
  installCycles(rt, { defs });
  return { rt, clock };
};
const staff = async (clock: FixedClock, email: string, role: "ops_analyst" | "officer"): Promise<Actor> => {
  const repo = new PgStaffRepository(db);
  const u = await repo.createUser({ email_hash: emailHash(email), email_encrypted: encryptEmail(email, staffEmailKey()), legal_name: email.split("@")[0]!, roles: [role], invited_by: null, now: clock.now() });
  await repo.markEnrolled(u.id, clock.now());
  return { kind: "human", id: u.id, role };
};
const noop: NamedRunner = { name: "noop", runner: { mode: "in_command", run: () => ({ outcome: "noop" }) } };
const refused = async (p: Promise<unknown>, code: string): Promise<void> => { await assert.rejects(p, (e: unknown) => (e instanceof CommandRefused || e instanceof CyclesRefused) && e.code === code, `expected ${code}`); };

test("35.3 jobs.requeue: an agent is refused ROLE_REQUIRED; an ops_analyst's requeue resolves the dead unit (SM_JOB_DEAD_2H satisfied, attempts 0, units_dead back to 0); an abandonment completes the run with a receipt recording the death and satisfies the stall clock", { skip }, async () => {
  await open("requeue");
  try {
    // a cycle whose runner has not landed: its one global unit dies on the first claim with error_class runner_missing (edge case 3)
    const dies = cycleDef({ cycle_code: "test_runner_missing", owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "daily", period_grammar: "day", selector: selectors.global, receipt_event: "test_runner_missing.run_completed", escalation_role: "officer", expected_by_rule: "same_day 23:59 ET" });
    const { rt, clock } = runtimeAt("2026-10-05T14:00:00.000Z", [dies]);
    const svc = cyclesOf(rt);
    const planned = await svc.plan({ cycle_codes: ["test_runner_missing"] });
    assert.equal(planned.runs_opened, 1); assert.equal(planned.jobs_planned, 1);
    const ex = await runExecutor(rt, { holder: "h1", drain: "all" });
    assert.equal(ex.claimed, 1); assert.equal(ex.dead, 1); assert.equal(ex.receipts, 0);
    const job = (await db.query<Row>(`SELECT id::text AS id, run_id::text AS run_id, status, attempts, last_error_class FROM jobs WHERE cycle_code = 'test_runner_missing'`))[0]!;
    assert.equal(job["status"], "dead"); assert.equal(job["attempts"], 1); assert.equal(job["last_error_class"], "runner_missing");
    const runId = String(job["run_id"]); const jobId = String(job["id"]);
    assert.equal(await count(`cycle_runs WHERE id = $1 AND status = 'running' AND units_dead = 1 AND units_done = 0`, [runId]), 1);
    // the death armed SM_JOB_DEAD_2H on the job (2 hours from dead_at) and opened one escalation to the registry row's role with the standard payload
    const armed = (await db.query<Row>(`SELECT id::text AS id, status, due_at, subject_kind, subject_id, loan_id FROM timers WHERE code = 'SM_JOB_DEAD_2H' ORDER BY armed_at`));
    assert.equal(armed.length, 1); assert.equal(armed[0]!["status"], "armed"); assert.equal(armed[0]!["subject_kind"], "job"); assert.equal(armed[0]!["subject_id"], jobId); assert.equal(armed[0]!["loan_id"], null); assert.equal(armed[0]!["due_at"], "2026-10-05T16:00:00.000Z");
    assert.equal(await count(`escalations WHERE kind = 'sev3' AND owner_role = 'officer' AND payload->>'job_id' = $1 AND payload->>'cycle_code' = 'test_runner_missing' AND payload->>'period_key' = '2026-10-05' AND payload->>'unit_id' = 'global' AND payload->>'error_class' = 'runner_missing'`, [jobId]), 1);
    const dead = await events(EVT.DEAD); assert.equal(dead.length, 1); assert.equal(dead[0]!.payload["attempts"], 1); assert.equal(dead[0]!.payload["origination"], true);
    // an agent is refused ROLE_REQUIRED naming ops_analyst by the guardrail (not HUMAN_ONLY); the job stays dead and nothing was written
    await assert.rejects(rt.execute({ process: "35.3", name: "jobs.requeue", loanId: "", actor: OPS_STEWARD, input: { job_id: jobId, op: "requeue", reason: "an agent tries" } }), (e: unknown) => e instanceof CommandRefused && e.code === "ROLE_REQUIRED" && /ops_analyst/.test(e.message));
    // a human without the role is refused by the bus; a missing reason by the guardrail; a job that is not dead by the service
    const officer = await staff(clock, "officer@example.test", "officer");
    await refused(rt.execute({ process: "35.3", name: "jobs.requeue", loanId: "", actor: officer, input: { job_id: jobId, op: "requeue", reason: "wrong role" } }), "ROLE_DENIED");
    const analyst = await staff(clock, "analyst@example.test", "ops_analyst");
    await refused(rt.execute({ process: "35.3", name: "jobs.requeue", loanId: "", actor: analyst, input: { job_id: jobId, op: "requeue" } }), "REASON_REQUIRED");
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'dead'`, [jobId]), 1); assert.equal((await events(EVT.RESOLVED)).length, 0);
    // the ops_analyst requeues with a reason: queued, attempts 0, units_dead 0, job.unit.resolved{disposition: requeued} satisfies the 2 h clock, the decision names the person and the reason
    const rq = await rt.execute({ process: "35.3", name: "jobs.requeue", loanId: "", actor: analyst, input: { job_id: jobId, op: "requeue", reason: "vendor restored" } });
    assert.equal((rq.output as Row)["status"], "queued");
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'queued' AND attempts = 0 AND max_attempts = 3 AND run_after IS NULL AND lease_holder IS NULL`, [jobId]), 1);
    assert.equal(await count(`cycle_runs WHERE id = $1 AND status = 'running' AND units_dead = 0 AND units_skipped = 0`, [runId]), 1);
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'requeued' AND actor_kind = 'human' AND actor_id = $2 AND actor_role = 'ops_analyst' AND detail->>'reason' = 'vendor restored'`, [jobId, analyst.id]), 1);
    let resolved = await events(EVT.RESOLVED);
    assert.equal(resolved.length, 1); assert.equal(resolved[0]!.aggregate_id, jobId); assert.equal(resolved[0]!.payload["disposition"], "requeued"); assert.equal(resolved[0]!.payload["by"], analyst.id); assert.equal(resolved[0]!.payload["reason"], "vendor restored"); assert.equal(resolved[0]!.actor_kind, "human");
    assert.equal(await count(`timers WHERE id = $1 AND status = 'satisfied' AND satisfied_by_event_id = $2`, [armed[0]!["id"], resolved[0]!.id]), 1);
    assert.equal(await count(`agent_decisions WHERE action = 'jobs.requeue:requeue' AND agent = 'ops-steward' AND approved_by = $1 AND approved_role = 'ops_analyst' AND subject_kind = 'test_runner_missing' AND subject_id = 'global' AND rule_set_version = 'cycles.v1' AND rationale LIKE '%vendor restored%'`, [analyst.id]), 1);
    // the requeued series: the runner is still missing, so the unit dies again on attempt 1 of the new series and a second 2 h clock is armed
    const ex2 = await runExecutor(rt, { holder: "h2", drain: "all" });
    assert.equal(ex2.claimed, 1); assert.equal(ex2.dead, 1);
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'dead' AND attempts = 1`, [jobId]), 1);
    assert.equal(await count(`timers WHERE code = 'SM_JOB_DEAD_2H' AND subject_id = $1 AND status = 'armed'`, [jobId]), 1);
    assert.equal(await count(`timers WHERE code = 'SM_JOB_DEAD_2H' AND subject_id = $1`, [jobId]), 2);
    // abandoned: terminal, counted skipped toward the total; the run is full → its receipt is elected on the command's own batch with units_dead 1 (the unit that died), the stall clock satisfied, job.unit.resolved{abandoned} satisfying the second 2 h clock
    const ab = await rt.execute({ process: "35.3", name: "jobs.requeue", loanId: "", actor: analyst, input: { job_id: jobId, op: "abandon", reason: "runner never lands this quarter" } });
    assert.equal((ab.output as Row)["status"], "abandoned"); assert.ok((ab.output as Row)["receipt_id"]);
    assert.equal(await count(`jobs WHERE id = $1 AND status = 'abandoned' AND finished_at IS NOT NULL`, [jobId]), 1);
    assert.equal(await count(`job_events WHERE job_id = $1 AND kind = 'abandoned' AND actor_id = $2`, [jobId, analyst.id]), 1);
    assert.equal(await count(`cycle_runs WHERE id = $1 AND status = 'completed' AND units_total = 1 AND units_done = 0 AND units_dead = 0 AND units_skipped = 1 AND receipt_id = $2`, [runId, (ab.output as Row)["receipt_id"]]), 1);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1 AND units_total = 1 AND units_done = 0 AND units_dead = 1 AND units_skipped = 1 AND emitted_by = $2 AND receipt_event_id IS NOT NULL AND generic_event_id IS NOT NULL`, [runId, `unit:${jobId}`]), 1);
    resolved = await events(EVT.RESOLVED); assert.equal(resolved.length, 2); assert.equal(resolved[1]!.payload["disposition"], "abandoned");
    assert.equal(await count(`timers WHERE code = 'SM_JOB_DEAD_2H' AND subject_id = $1 AND status = 'satisfied'`, [jobId]), 2);
    assert.equal(await count(`timers WHERE code = 'SM_CYCLE_RUN_STALLED_1D' AND subject_kind = 'cycle_run' AND subject_id = $1 AND status = 'satisfied'`, [runId]), 1);
    assert.equal((await events("test_runner_missing.run_completed", `AND aggregate_id = $2`, [runId])).length, 1);
    const completed = await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [runId]);
    assert.equal(completed.length, 1); assert.equal(completed[0]!.payload["units_dead"], 1); assert.equal(completed[0]!.payload["units_skipped"], 1);
    assert.equal(await count(`agent_decisions WHERE action = 'jobs.requeue:abandon' AND approved_by = $1`, [analyst.id]), 1);
    // terminal: a second requeue or abandonment is refused JOB_NOT_DEAD
    await refused(rt.execute({ process: "35.3", name: "jobs.requeue", loanId: "", actor: analyst, input: { job_id: jobId, op: "requeue", reason: "again" } }), "JOB_NOT_DEAD");
    assert.equal(await count(`cycle_registry WHERE cycle_code = 'test_runner_missing' AND last_run_id = $1 AND last_receipt_at IS NOT NULL AND overdue_since IS NULL`, [runId]), 1);
  } finally { await db.end(); }
});

test("35.3 the planner's receipts ride its own command batch: a zero-unit run is opened and receipted in one pass (stall clock armed then satisfied), a run whose last unit committed without its receipt is reconciled by the next pass with emitted_by planner:<run_id>, and a cycle whose owner emits the receipt literal gets cycle.run.completed only", { skip }, async () => {
  await open("reconcile");
  try {
    const empty = cycleDef({ cycle_code: "test_zero_units", owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "loan", schedule: "daily", period_grammar: "day", selector: selectors.active_loans, runner: noop, receipt_event: "test_zero_units.run_completed", expected_by_rule: "same_day 23:59 ET" });
    const owned = cycleDef({ cycle_code: "test_owner_receipt", owner_process: "35.1", owner_agent: "security-records", unit_scope: "global", schedule: "daily", period_grammar: "day", selector: selectors.global, runner: noop, receipt_event: "test_owner.run_completed", receipt_emitted_by: "owner", expected_by_rule: "same_day 23:59 ET" });
    const later = cycleDef({ cycle_code: "test_reconciled", owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "daily", period_grammar: "day", selector: selectors.global, runner: noop, receipt_event: "test_reconciled.run_completed", expected_by_rule: "same_day 23:59 ET" });
    const dependent = cycleDef({ cycle_code: "test_dependent", owner_process: "35.3", owner_agent: "ops-steward", unit_scope: "global", schedule: "daily", period_grammar: "day", selector: selectors.global, runner: noop, receipt_event: "test_dependent.run_completed", depends_on: [{ cycle_code: "test_zero_units" }], expected_by_rule: "same_day 23:59 ET" });
    const { rt } = runtimeAt("2026-10-05T14:00:00.000Z", [empty, owned, later, dependent]);
    const svc = cyclesOf(rt);
    // one pass: the zero-unit run (no boarded loan) is opened and completed in the same pass with a receipt of zeros; its stall clock was armed in planCycle's transaction and satisfied on the command's batch; the dependent's job was unblocked in the receipt's transaction (D11)
    const p1 = await svc.plan();
    assert.equal(p1.skipped, false); assert.equal(p1.runs_opened, 4); assert.equal(p1.receipts_reconciled, 1);
    const zero = (await db.query<Row>(`SELECT id::text AS id, status, units_total, receipt_id::text AS receipt_id FROM cycle_runs WHERE cycle_code = 'test_zero_units'`))[0]!;
    assert.equal(zero["status"], "completed"); assert.equal(zero["units_total"], 0); assert.ok(zero["receipt_id"]);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1 AND emitted_by = $2 AND units_total = 0 AND units_done = 0`, [zero["id"], `planner:${String(zero["id"])}`]), 1);
    assert.equal(await count(`timers WHERE code = 'SM_CYCLE_RUN_STALLED_1D' AND subject_id = $1 AND status = 'satisfied'`, [zero["id"]]), 1);
    assert.equal(await count(`timers WHERE code = 'SM_CYCLE_RUN_STALLED_1D' AND subject_id = $1`, [zero["id"]]), 1);
    assert.equal((await events(EVT.RUN_OPENED, `AND aggregate_id = $2`, [zero["id"]])).length, 1);
    assert.equal((await events("test_zero_units.run_completed", `AND aggregate_id = $2`, [zero["id"]])).length, 1);
    assert.equal((await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [zero["id"]])).length, 1);
    assert.equal(await count(`jobs WHERE cycle_code = 'test_dependent' AND status = 'queued'`), 1);
    assert.equal(await count(`job_events e JOIN jobs j ON j.id = e.job_id WHERE j.cycle_code = 'test_dependent' AND e.kind IN ('blocked', 'unblocked')`), 2);
    // the executor completes the owner-emitted cycle's unit: its receipt row exists, `cycle.run.completed` is appended, the owner's literal is NOT (rule 2 — 35.1's, 35.2's and 35.12's cycles keep their own)
    const ex = await runExecutor(rt, { holder: "h1", drain: "all", electReceipt: true });
    assert.equal(ex.done, 3);
    const own = (await db.query<Row>(`SELECT id::text AS id FROM cycle_runs WHERE cycle_code = 'test_owner_receipt'`))[0]!;
    assert.equal(await count(`cycle_receipts WHERE run_id = $1 AND receipt_event_id IS NULL AND generic_event_id IS NOT NULL`, [own["id"]]), 1);
    assert.equal((await events("test_owner.run_completed")).length, 0);
    const ownCompleted = await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [own["id"]]);
    assert.equal(ownCompleted.length, 1); assert.equal(ownCompleted[0]!.payload["receipt_emitted_by"], "owner");
    // a run whose last unit committed but whose receipt transaction never ran (the executor stopped between the two): the next planner pass reconciles it on its own batch, emitted_by planner:<run_id>, the stall clock (armed the pass before) satisfied
    const p2 = await svc.plan({ as_of: "2026-10-06T14:00:00.000Z" });
    assert.equal(p2.runs_opened, 4);
    const claimed = await claimJobs(rt.db, "h2", 20, wallClockOf(rt).now());
    const last = claimed.find((j) => j.cycle_code === "test_reconciled")!;
    assert.equal(await runClaimed(rt, last, "h2", { electReceipt: false }), "done");
    assert.equal(await count(`cycle_runs WHERE id = $1 AND status = 'running' AND units_done = 1 AND units_total = 1`, [last.run_id]), 1);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1`, [last.run_id]), 0);
    const p3 = await svc.plan({ as_of: "2026-10-06T14:30:00.000Z" });
    assert.equal(p3.runs_opened, 0); assert.ok(p3.receipts_reconciled >= 1);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1 AND emitted_by = $2 AND units_done = 1`, [last.run_id, `planner:${last.run_id}`]), 1);
    assert.equal(await count(`cycle_runs WHERE id = $1 AND status = 'completed'`, [last.run_id]), 1);
    assert.equal((await events("test_reconciled.run_completed", `AND aggregate_id = $2`, [last.run_id])).length, 1);
    assert.equal((await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [last.run_id])).length, 1);
    assert.equal(await count(`timers WHERE code = 'SM_CYCLE_RUN_STALLED_1D' AND subject_id = $1 AND status = 'satisfied'`, [last.run_id]), 1);
    // a fourth pass adds nothing: one row, one pair
    const p4 = await svc.plan({ as_of: "2026-10-06T15:00:00.000Z" });
    assert.equal(p4.receipts_reconciled, 0);
    assert.equal(await count(`cycle_receipts WHERE run_id = $1`, [last.run_id]), 1);
    assert.equal((await events(EVT.RUN_COMPLETED, `AND aggregate_id = $2`, [last.run_id])).length, 1);
  } finally { await db.end(); }
});
