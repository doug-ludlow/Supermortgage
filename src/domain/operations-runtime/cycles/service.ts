/**
 * §35.3 — the tool-facing handlers behind `cycles.registry`, `cycles.receipt`, `cycles.retry`, `cycles.escalate`,
 * `jobs.list` and `jobs.requeue` (src/app/tools/section35-3.ts), every write on the command's own transaction (`ctx.q`).
 * Rule 12: nothing here moves money or edits a clock — the registry's status, a run's cancellation, a job's requeue or
 * abandonment, their `job_events`, events, decisions and escalations, and nothing else. The one timer act is the cited
 * cancellation of SM_CYCLE_RUN_STALLED_1D on `cycle.run.cancelled` ("state machine: a cancelled run has nothing left to
 * complete" — the registry's override grammar cannot express it, timers-35-3.ts).
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { CommandContext } from "../../../app/commands.ts";
import type { ToolRuntime } from "../../../app/tools.ts";
import { EV } from "./cycles.ts";
import { jobEvent, loadJob, JOB_COLS, RUN_COLS, type JobRow } from "./jobs.ts";

const byOf = (ctx: CommandContext): string => `${ctx.actor.kind}:${ctx.actor.id}`;

/** `cycles.registry{op: list}` — every row, the overdue ones first (rule 11: 35.11 reads `overdue_since`). */
export async function registryList(q: Queryable, cycleCode: string | null = null): Promise<Record<string, unknown>[]> {
  return q.query(`SELECT cycle_code, owner_process, owner_agent, unit_scope, schedule, period_grammar, unit_selector, unit_runner, receipt_event, depends_on, serves_timer, escalation_role, expected_by_rule, status, paused_by, paused_reason, last_period_key, last_run_id, last_receipt_at::text AS last_receipt_at, next_period_key, next_expected_by::text AS next_expected_by, overdue_since::text AS overdue_since, last_error_class, registry_version, updated_at::text AS updated_at
    FROM cycle_registry WHERE ($1::text IS NULL OR cycle_code = $1) ORDER BY overdue_since ASC NULLS LAST, cycle_code`, [cycleCode]);
}

/** `cycles.registry{op: pause}` (an `ops_analyst` act): the row goes `paused`; every open run of the cycle is cancelled — planned and queued jobs `skipped`, running ones finish, `cycle.run.cancelled{run_id, by, reason}`, the stall clock cancelled. */
export async function pauseCycle(ctx: CommandContext, code: string, reason: string): Promise<{ cycle_code: string; status: "paused"; runs_cancelled: string[]; jobs_skipped: number }> {
  const q = ctx.q!;
  const [row] = await q.query<{ cycle_code: string }>(`UPDATE cycle_registry SET status = 'paused', paused_by = $2, paused_reason = $3, updated_at = $4 WHERE cycle_code = $1 AND status <> 'retired' RETURNING cycle_code`, [code, byOf(ctx), reason, ctx.now]);
  if (!row) throw new RangeError(`no active registry row ${code}`);
  const runs = await q.query<{ id: string; period_key: string }>(`SELECT id, period_key FROM cycle_runs WHERE cycle_code = $1 AND status IN ('planned', 'running') ORDER BY opened_at FOR UPDATE`, [code]);
  let skipped = 0;
  for (const r of runs) {
    const jobs = await q.query<{ id: string }>(`UPDATE jobs SET status = 'skipped', finished_at = now() WHERE run_id = $1 AND status IN ('blocked', 'queued', 'failed') RETURNING id`, [r.id]);
    for (const j of jobs) await jobEvent(q, j.id, "skipped", { actor: ctx.actor, detail: { reason, run_cancelled: true } });
    skipped += jobs.length;
    await q.query(`UPDATE cycle_runs SET status = 'cancelled', cancelled_by = $2, cancelled_reason = $3, units_skipped = units_skipped + $4 WHERE id = $1`, [r.id, byOf(ctx), reason, jobs.length]);
    ctx.events.append({ type: EV.run_cancelled, aggregate: { kind: "cycle_run", id: r.id }, actor: ctx.actor, payload: { run_id: r.id, cycle_code: code, period_key: r.period_key, by: byOf(ctx), reason, jobs_skipped: jobs.length } });
    for (const t of ctx.timers.forSubject("cycle_run", r.id)) if (t.status === "armed" || t.status === "breached") ctx.timers.cancel(t.id, "35.3 state machine: a cancelled run has nothing left to complete", ctx.actor);
  }
  return { cycle_code: code, status: "paused", runs_cancelled: runs.map((r) => r.id), jobs_skipped: skipped };
}
export async function resumeCycle(ctx: CommandContext, code: string): Promise<{ cycle_code: string; status: "active" }> {
  const [row] = await ctx.q!.query<{ cycle_code: string }>(`UPDATE cycle_registry SET status = 'active', paused_by = NULL, paused_reason = NULL, updated_at = $2 WHERE cycle_code = $1 AND status = 'paused' RETURNING cycle_code`, [code, ctx.now]);
  if (!row) throw new RangeError(`registry row ${code} is not paused`);
  return { cycle_code: code, status: "active" };
}

/** `cycles.receipt{run_id}` — the receipt and its unit outcomes. */
export async function readReceipt(q: Queryable, runId: string): Promise<Record<string, unknown> | null> {
  const [run] = await q.query(`SELECT ${RUN_COLS} FROM cycle_runs WHERE id = $1`, [runId]);
  if (!run) return null;
  const [receipt] = await q.query(`SELECT id, run_id, cycle_code, period_key, as_of_date::text AS as_of_date, units_total, units_done, units_dead, units_skipped, outcomes_sha256, receipt_event_id, generic_event_id, emitted_by, created_at::text AS created_at FROM cycle_receipts WHERE run_id = $1`, [runId]);
  const outcomes = await q.query(`SELECT id AS job_id, unit_id, loan_id, status, attempts, decision_id, last_error_class, finished_at::text AS finished_at FROM jobs WHERE run_id = $1 ORDER BY unit_id`, [runId]);
  return { run, receipt: receipt ?? null, outcomes };
}

/** `cycles.retry{job_id}` — an agent's early retry of a `failed` unit before its `run_after` (rule 7: consumes no extra attempt beyond the one it runs). */
export async function retryJob(ctx: CommandContext, jobId: string): Promise<{ job_id: string; status: "queued"; attempts: number }> {
  const q = ctx.q!;
  const job = await loadJob(q, jobId, true); if (!job) throw new RangeError(`no job ${jobId}`);
  if (job.status !== "failed") throw new RangeError(`job ${jobId} is ${job.status}; cycles.retry re-queues a failed unit`);
  await q.query(`UPDATE jobs SET status = 'queued', run_after = NULL WHERE id = $1`, [jobId]);
  await jobEvent(q, jobId, "requeued", { attempt: job.attempts, actor: ctx.actor, detail: { early_retry: true } });
  return { job_id: jobId, status: "queued", attempts: job.attempts };
}

/** `cycles.escalate{run_id | job_id, reason}` — the steward's own flag to an `ops_analyst` (a dead unit's escalation is opened by the executor; this is the discretionary one). */
export function escalateCycle(ctx: CommandContext, rt: ToolRuntime, i: { run_id?: string; job_id?: string; reason: string }): { escalation_id: string; owner_role: string } {
  const e = rt.escalations.open({ kind: "sev3", ownerRole: "ops_analyst", severity: "3", payload: { source: "35.3", ...(i.run_id ? { run_id: i.run_id } : {}), ...(i.job_id ? { job_id: i.job_id } : {}), reason: i.reason, by: byOf(ctx) } }, ctx.actor);
  return { escalation_id: e.id, owner_role: e.ownerRole };
}

export interface JobsFilter { readonly cycle_code?: string | null; readonly status?: string | null; readonly period_key?: string | null; readonly loan_id?: string | null; readonly run_id?: string | null; readonly limit?: number | null; }
export async function listJobs(q: Queryable, f: JobsFilter): Promise<JobRow[]> {
  return q.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs WHERE ($1::text IS NULL OR cycle_code = $1) AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR period_key = $3) AND ($4::uuid IS NULL OR loan_id = $4) AND ($5::uuid IS NULL OR run_id = $5) ORDER BY created_at DESC, id LIMIT $6`,
    [f.cycle_code ?? null, f.status ?? null, f.period_key ?? null, f.loan_id ?? null, f.run_id ?? null, Math.max(1, Math.min(1000, f.limit ?? 200))]);
}

/** `jobs.requeue{job_id, op: requeue | abandon, reason}` — an `ops_analyst`'s act on a `dead` unit (rule 7): requeue resets the attempts (`units_dead − 1`); abandon is terminal and counts as skipped toward the total (`units_dead − 1`, `units_skipped + 1`). `job.unit.resolved{job_id, by, disposition, reason}` satisfies SM_JOB_DEAD_2H on the job. */
export async function requeueJob(ctx: CommandContext, jobId: string, op: "requeue" | "abandon", reason: string): Promise<{ job_id: string; status: "queued" | "abandoned"; disposition: string; run_id: string }> {
  const q = ctx.q!;
  const job = await loadJob(q, jobId, true); if (!job) throw new RangeError(`no job ${jobId}`);
  if (job.status !== "dead") throw new RangeError(`job ${jobId} is ${job.status}; jobs.requeue acts on a dead unit`);
  if (op === "requeue") {
    await q.query(`UPDATE jobs SET status = 'queued', attempts = 0, max_attempts = 3, run_after = NULL, finished_at = NULL WHERE id = $1`, [jobId]);
    await q.query(`UPDATE cycle_runs SET units_dead = greatest(units_dead - 1, 0) WHERE id = $1`, [job.run_id]);
    await jobEvent(q, jobId, "requeued", { attempt: 0, actor: ctx.actor, detail: { reason, by: byOf(ctx) } });
  } else {
    await q.query(`UPDATE jobs SET status = 'abandoned', finished_at = now() WHERE id = $1`, [jobId]);
    await q.query(`UPDATE cycle_runs SET units_dead = greatest(units_dead - 1, 0), units_skipped = units_skipped + 1 WHERE id = $1`, [job.run_id]);
    await jobEvent(q, jobId, "abandoned", { attempt: job.attempts, actor: ctx.actor, detail: { reason, by: byOf(ctx) } });
  }
  const disposition = op === "requeue" ? "requeued" : "abandoned";
  ctx.events.append({ type: EV.unit_resolved, aggregate: { kind: "job", id: jobId }, actor: ctx.actor, payload: { job_id: jobId, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, by: byOf(ctx), by_role: ctx.actor.role ?? null, disposition, reason } });
  return { job_id: jobId, status: op === "requeue" ? "queued" : "abandoned", disposition, run_id: job.run_id };
}
