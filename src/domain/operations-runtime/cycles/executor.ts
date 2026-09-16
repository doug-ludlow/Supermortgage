/**
 * §35.3 rules 5–8 — the executor and `cycles.run_unit`. `drainQueue` claims (`claimJobs`: rule 6's UPDATE … FOR UPDATE SKIP
 * LOCKED LIMIT 20 on a unit of work that appends `job.unit.claimed` and the `job_events{claimed}` row), runs every claimed
 * job through `runClaimedJob`, heartbeats every 30 s and stops claiming at the deadline (240 s of the sweep's 300 s; the
 * demo advance passes none). `runClaimedJob` is rule 8: the unit is its owner's command — `Runtime.executeDef` with the
 * registered `cycles.run_unit` def re-agented to the owner (`{...RUN_UNIT_DEF, agent: owner_agent}`, so the decision row
 * names `cashiering`, `disclosures`, …) under the unit's own scope, actor `{kind: "agent", id: owner_agent}`; the handler
 * (`runUnitHandler`, also the registered tool's) refuses NO_CLIENT_STATE before anything is written, refuses a job that is
 * not claimable (`JOB_NOT_CLAIMABLE`), runs the named runner with the command's own context, appends `job.unit.done` and
 * defers the commit-phase writes (rule 5: `jobs.status = done`, `decision_id`, `job_events{done}`, `UPDATE cycle_runs …
 * RETURNING`) to the command's transaction. Full counters after the commit → `emitReceipt` in a second, global unit of work.
 * A throw rolls the unit back whole; `recordFailure` writes `failed` (rule 7's backoff) or `dead` (`job.unit.dead`, arming
 * SM_JOB_DEAD_2H on the job, one escalation to the registry row's role) in its own unit of work.
 */
import { randomUUID } from "node:crypto";
import type { Runtime } from "../../../runtime/app.ts";
import type { CommandContext } from "../../../app/commands.ts";
import { CommandRefused } from "../../../app/commands.ts";
import { EscalationService } from "../../../app/escalations.ts";
import { PortUnavailable, str, type ToolDef, type ToolInput, type ToolRuntime } from "../../../app/tools.ts";
import type { Actor } from "../../../kernel/events/index.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { CYCLES_VERSION, EV, OPS_STEWARD, PROMPT_VERSION, defOf, type CycleDef } from "./cycles.ts";
import { CLAIM_LIMIT, HEARTBEAT_MS, LEASE_MINUTES, RunnerMissing, classifyError, claimSql, heartbeatSql, jobEvent, loadJob, retryDelayMs, type JobRow, type RunCounters } from "./jobs.ts";
import { emitReceipt, type ReceiptResult } from "./receipt.ts";
import { unblockJobs } from "./planner.ts";
import type { Runner, UnitOutcome } from "./runners.ts";

export const RUN_UNIT_TOOL = "cycles.run_unit";
export const PROCESS = "35.3";
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const deferOf = (rt: ToolRuntime): ((fn: (q: import("../../../infra/db/client.ts").Queryable) => Promise<void>) => void) | null => { const f = rt.services["deferWrite"] as ((fn: (q: import("../../../infra/db/client.ts").Queryable) => Promise<void>) => void) | undefined; return f ?? null; };

/** The unit's decision record (AI agent design): {subject_kind: cycle_code, subject_id: unit_id, action: cycles.run_unit, period_key, attempt, outcome, rule_set_version: cycles.v1, model_version: deterministic, prompt_version: 35.3-v1, confidence: 1, rationale}. */
export function unitDecision(d: { id?: string; subject: { kind: string; id: string }; action: string; period_key?: string | null; attempt?: number | null; outcome: string; error_class?: string | null; by?: string | null; reason?: string | null; rationale: string; loanId?: string }): { id?: string; action: string; rationale: string; subject: { kind: string; id: string }; ruleCode: string; modelVersion: string; promptVersion: string; confidence: number } {
  const record = { subject_kind: d.subject.kind, subject_id: d.subject.id, action: d.action, period_key: d.period_key ?? null, attempt: d.attempt ?? null, outcome: d.outcome, ...(d.error_class ? { error_class: d.error_class } : {}), ...(d.by ? { by: d.by } : {}), ...(d.reason ? { reason: d.reason } : {}), rule_set_version: CYCLES_VERSION, model_version: "deterministic", prompt_version: PROMPT_VERSION, confidence: 1, rationale: d.rationale };
  return { ...(d.id ? { id: d.id } : {}), action: d.action, rationale: JSON.stringify(record), subject: d.subject, ruleCode: PROCESS, modelVersion: "deterministic", promptVersion: PROMPT_VERSION, confidence: 1 };
}

export interface UnitRunReport { readonly job_id: string; readonly run_id: string; readonly cycle_code: string; readonly period_key: string; readonly unit_id: string; readonly decision_id: string; readonly outcome: string; readonly detail: Record<string, unknown> | null; readonly duration_ms: number; readonly attempt: number; }

/** The `cycles.run_unit{job_id}` handler — the executor's own call, also runnable by hand for one job (a `queued` job is claimed inline). */
export const runUnitHandler = async (i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<UnitRunReport> => {
  const runtime = runtimeOf(rt); const q = ctx.q; if (!q) throw new RangeError("cycles.run_unit runs inside a database command (PgUnitOfWork): no transaction on this context");
  const jobId = str(i, "job_id"); if (!jobId) throw new RangeError("cycles.run_unit needs job_id");
  // no row lock across the unit: the claim (status running + holder) is the guard, so the executor's heartbeat can extend the lease while the unit runs (rule 6)
  const job = await loadJob(q, jobId, false); if (!job) throw new RangeError(`no job ${jobId}`);
  const holder = str(i, "holder") || `${ctx.actor.kind}:${ctx.actor.id}`;
  const def = defOf(runtime.cycles.defs, job.cycle_code); if (!def) throw new RunnerMissing(job.cycle_code);
  // rule 8: the unit runs as the owning section's agent — the executor's command already carries it; a hand-run command (ops-steward, a person) stamps the owner on the unit's events and its runner's acts
  const owner: Actor = ctx.actor.kind === "agent" && ctx.actor.id === def.owner_agent ? ctx.actor : { kind: "agent", id: def.owner_agent };
  let attempt = job.attempts;
  if (job.status === "queued" && (job.run_after === null || Date.parse(job.run_after) <= Date.now())) {
    // by hand: claim inline, atomically (the same lease as the executor's claim, wall clock); a concurrent claim wins the row and this call is refused
    const [claimed] = await q.query<{ attempts: number; lease_until: string }>(`UPDATE jobs SET status = 'running', lease_holder = $2, lease_until = now() + interval '${LEASE_MINUTES} minutes', heartbeat_at = now(), attempts = attempts + 1 WHERE id = $1 AND status = 'queued' RETURNING attempts, lease_until::text AS lease_until`, [jobId, holder]);
    if (!claimed) throw new CommandRefused(RUN_UNIT_TOOL, "JOB_NOT_CLAIMABLE", "35.3 rule 6: a queued job is claimed once", `job ${jobId} was claimed by another executor`);
    attempt = claimed.attempts;
    await jobEvent(q, jobId, "claimed", { attempt, holder, actor: owner });
    ctx.events.append({ type: EV.unit_claimed, aggregate: { kind: "job", id: jobId }, actor: owner, payload: { job_id: jobId, holder, lease_until: claimed.lease_until, attempt } });
    await q.query(`UPDATE cycle_runs SET status = 'running' WHERE id = $1 AND status = 'planned'`, [job.run_id]);
  } else if (job.status !== "running" || job.lease_holder !== holder) {
    // a job that is done, dead, blocked, failed before its run_after, or running under another executor's lease is not this call's to run
    throw new CommandRefused(RUN_UNIT_TOOL, "JOB_NOT_CLAIMABLE", "35.3 state machine / worked example A: a second `cycles.run_unit` of the same job is refused JOB_NOT_CLAIMABLE", `job ${jobId} is ${job.status}${job.lease_holder ? ` (held by ${job.lease_holder})` : ""}`);
  }
  const runner = runtime.cycles.runners[def.runner]; if (!runner) throw new RunnerMissing(def.runner);
  const asOfDate = wallClock(Date.parse(ctx.now), "America/New_York").date;
  const t0 = Date.now(); const decisionId = randomUUID();
  const outcome: UnitOutcome = runner.kind === "pass"
    ? (i["pass"] && typeof i["pass"] === "object" ? { outcome: String((i["pass"] as Record<string, unknown>)["outcome"] ?? "ran"), detail: i["pass"] as Record<string, unknown> } : await runner.pass(runtime.root, { def, job, as_of: ctx.now, as_of_date: asOfDate }))
    : await runner.run({ rt, ctx, runtime, def, job, owner, as_of: ctx.now, as_of_date: asOfDate });
  const durationMs = Date.now() - t0;
  ctx.events.append({ type: EV.unit_done, aggregate: { kind: "job", id: jobId }, actor: owner, payload: { job_id: jobId, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, decision_id: decisionId, attempt, outcome: outcome.outcome, duration_ms: durationMs } });
  // rule 5: the commit hook (35.1's fact-projector phase — the same transaction as the unit's events, ledger sets, timers and decision)
  const defer = deferOf(rt);
  const commitWrites = async (cq: import("../../../infra/db/client.ts").Queryable): Promise<void> => {
    // the lease is the guard here too: a job whose lease was reclaimed and taken by another executor while this unit ran is not marked done twice (done is terminal; no unit counts twice)
    const mine = await cq.query(`UPDATE jobs SET status = 'done', decision_id = $2, finished_at = now(), lease_holder = NULL, lease_until = NULL, last_error_class = NULL, last_error = NULL WHERE id = $1 AND status = 'running' AND lease_holder = $3 RETURNING id`, [jobId, decisionId, holder]);
    if (!mine.length) throw new CommandRefused(RUN_UNIT_TOOL, "JOB_NOT_CLAIMABLE", "35.3 rule 6: the lease expired and another executor took the unit; this run is rolled back whole", `job ${jobId} is no longer held by ${holder}`);
    const [c] = await cq.query<RunCounters>(`UPDATE cycle_runs SET units_done = units_done + 1, status = CASE WHEN status = 'planned' THEN 'running' ELSE status END WHERE id = $1 RETURNING units_total, units_done, units_dead, units_skipped, status, cycle_code, period_key, as_of_date::text AS as_of_date`, [job.run_id]);
    await jobEvent(cq, jobId, "done", { attempt, holder, actor: owner, detail: { decision_id: decisionId, duration_ms: durationMs, outcome: outcome.outcome, counters: c ? { units_total: c.units_total, units_done: c.units_done, units_dead: c.units_dead, units_skipped: c.units_skipped } : null } });
  };
  if (defer) defer(commitWrites); else await commitWrites(q);
  return { job_id: jobId, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, decision_id: decisionId, outcome: outcome.outcome, detail: outcome.detail ?? null, duration_ms: durationMs, attempt };
};
export const runUnitDecision = (i: ToolInput, output: unknown): ReturnType<typeof unitDecision> => {
  const o = (output ?? {}) as Partial<UnitRunReport>;
  return unitDecision({ ...(o.decision_id ? { id: o.decision_id } : {}), subject: { kind: o.cycle_code ?? "job", id: o.unit_id ?? str(i, "job_id") }, action: RUN_UNIT_TOOL, period_key: o.period_key ?? null, attempt: o.attempt ?? null, outcome: o.outcome ?? "done", rationale: `${o.cycle_code ?? "?"} ${o.period_key ?? "?"} unit ${o.unit_id ?? "?"}: ${o.outcome ?? "done"}` });
};

/** The registered def re-agented to the unit's owner (rule 8: the decision record and the events name the owning section's agent, never ops-steward). */
export const unitDefFor = (registered: ToolDef, def: CycleDef | undefined): ToolDef => ({ ...registered, agent: def?.owner_agent ?? OPS_STEWARD.id });

export interface ClaimReport { readonly claimed: JobRow[]; readonly holder: string; }
/** Rule 6's claim on a unit of work: the rows, their `job_events{claimed}` and `job.unit.claimed{job_id, holder, lease_until, attempt}`; the runs go `running`. */
export async function claimJobs(rt: Runtime, holder: string, limit: number = CLAIM_LIMIT, exclude: readonly string[] = []): Promise<ClaimReport> {
  let claimed: JobRow[] = [];
  await rt.uow.run({}, async (ctx) => {
    const q = ctx.q!;
    claimed = await claimSql(q, holder, limit, exclude);
    for (const j of claimed) {
      await jobEvent(q, j.id, "claimed", { attempt: j.attempts, holder, actor: OPS_STEWARD });
      ctx.events.append({ type: EV.unit_claimed, aggregate: { kind: "job", id: j.id }, actor: OPS_STEWARD, payload: { job_id: j.id, cycle_code: j.cycle_code, period_key: j.period_key, unit_id: j.unit_id, holder, lease_until: j.lease_until, attempt: j.attempts } });
    }
    if (claimed.length) await q.query(`UPDATE cycle_runs SET status = 'running' WHERE status = 'planned' AND id = ANY($1::uuid[])`, [[...new Set(claimed.map((j) => j.run_id))]]);
  }, { clock: rt.clock });
  return { claimed, holder };
}

export interface FailureReport { readonly job_id: string; readonly status: "failed" | "dead"; readonly attempt: number; readonly error_class: string; readonly error: string; readonly run_after: string | null; readonly escalation_id: string | null; /** the lease had been reclaimed and the job re-run elsewhere: nothing was booked */ readonly stale?: boolean; }
/** Rule 7: a throw → `failed` with `run_after = now() + 60 s · 2^(attempt−1)` (cap 15 min), or `dead` at the third attempt / an `unavailable` or `runner_missing` failure — `job.unit.dead` (SM_JOB_DEAD_2H on the job), `units_dead + 1`, one escalation to the registry row's `escalation_role`. The message is stored; the input payload is not. */
export async function recordFailure(rt: Runtime, job: JobRow, holder: string, e: unknown, def: CycleDef | undefined): Promise<FailureReport> {
  const c = classifyError(e);
  const dead = c.dead_now || job.attempts >= job.max_attempts;
  let escalations: EscalationService | undefined; let escalationId: string | null = null; let runAfter: string | null = null; let stale = false;
  await rt.uow.run({}, async (ctx) => {
    const q = ctx.q!;
    // only the job this executor still holds moves (done is terminal; a lease reclaimed and re-run elsewhere is not this failure's to book)
    const held = await q.query(`SELECT 1 FROM jobs WHERE id = $1 AND status = 'running' AND lease_holder = $2 FOR UPDATE`, [job.id, holder]);
    if (!held.length) { stale = true; return; }
    if (dead) {
      await q.query(`UPDATE jobs SET status = 'dead', last_error_class = $2, last_error = $3, finished_at = now(), lease_holder = NULL, lease_until = NULL WHERE id = $1`, [job.id, c.error_class, c.message]);
      await q.query(`UPDATE cycle_runs SET units_dead = units_dead + 1, status = CASE WHEN status = 'planned' THEN 'running' ELSE status END WHERE id = $1`, [job.run_id]);
      await jobEvent(q, job.id, "dead", { attempt: job.attempts, holder, actor: OPS_STEWARD, error_class: c.error_class, error: c.message });
      const deadAt = ctx.clock.now();
      ctx.events.append({ type: EV.unit_dead, aggregate: { kind: "job", id: job.id }, actor: OPS_STEWARD, payload: { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, attempts: job.attempts, error_class: c.error_class, dead_at: deadAt } });
      const role = (await q.query<{ escalation_role: string }>(`SELECT escalation_role FROM cycle_registry WHERE cycle_code = $1`, [job.cycle_code]))[0]?.escalation_role ?? def?.escalation_role ?? "ops_analyst";
      escalations = new EscalationService(ctx.events, ctx.clock);
      const esc = escalations.open({ kind: "sev3", ownerRole: role, ...(job.loan_id ? { loanId: job.loan_id } : {}), severity: "3", payload: { source: "35.3", job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, error_class: c.error_class, attempts: job.attempts, choices: ["requeue", "abandon"], dead_at: deadAt } }, OPS_STEWARD);
      escalationId = esc.id;
    } else {
      const delay = retryDelayMs(job.attempts);
      const [r] = await q.query<{ run_after: string }>(`UPDATE jobs SET status = 'failed', run_after = now() + ($2 || ' milliseconds')::interval, last_error_class = $3, last_error = $4, lease_holder = NULL, lease_until = NULL WHERE id = $1 RETURNING run_after::text AS run_after`, [job.id, String(delay), c.error_class, c.message]);
      runAfter = r?.run_after ?? null;
      await q.query(`UPDATE cycle_runs SET status = CASE WHEN status = 'planned' THEN 'running' ELSE status END WHERE id = $1`, [job.run_id]);
      await jobEvent(q, job.id, "failed", { attempt: job.attempts, holder, actor: OPS_STEWARD, error_class: c.error_class, error: c.message, detail: { run_after: runAfter, delay_ms: delay } });
      ctx.events.append({ type: EV.unit_failed, aggregate: { kind: "job", id: job.id }, actor: OPS_STEWARD, payload: { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, attempt: job.attempts, error_class: c.error_class, run_after: runAfter } });
    }
  }, { clock: rt.clock, commit: async (q) => { for (const e of escalations?.list() ?? []) await rt.escalationRepo.save(e, q); } });
  if (stale) rt.logger?.warn("cycles: a unit's failure arrived after its lease was reclaimed; not booked", { job_id: job.id, holder, error_class: c.error_class });
  return { job_id: job.id, status: dead ? "dead" : "failed", attempt: job.attempts, error_class: c.error_class, error: c.message, run_after: runAfter, escalation_id: escalationId, stale };
}

export type UnitResult = { readonly job_id: string; readonly status: "done"; readonly report: UnitRunReport; readonly receipt: ReceiptResult | null } | { readonly job_id: string; readonly status: "failed" | "dead"; readonly failure: FailureReport };

/** Rule 8: run one claimed job as its owner's command; rule 5: elect the receipt when the counters are full. */
export async function runClaimedJob(rt: Runtime, job: JobRow, holder: string): Promise<UnitResult> {
  const def = defOf(rt.cycles.defs, job.cycle_code);
  const registered = rt.tool(PROCESS, RUN_UNIT_TOOL);
  if (!registered) throw new RangeError(`the bus pair (${PROCESS}, ${RUN_UNIT_TOOL}) is not registered`);
  const actor: Actor = { kind: "agent", id: def?.owner_agent ?? OPS_STEWARD.id };
  try {
    const runner: Runner | undefined = def ? rt.cycles.runners[def.runner] : undefined;
    // a pass-kind runner (the sweep-body passes, 35.7's scan): the pass runs first on the root runtime — its own idempotent units of work — and the recording command carries its outcome (flags and counts only)
    const pass = runner?.kind === "pass" && def ? await runner.pass(rt.root, { def, job, as_of: rt.clock.now(), as_of_date: wallClock(Date.parse(rt.clock.now()), "America/New_York").date }) : null;
    const r = await rt.executeDef(unitDefFor(registered, def), { loanId: job.loan_id ?? "", ...(job.application_id ? { applicationId: job.application_id } : {}), actor, input: { job_id: job.id, holder, ...(pass ? { pass: { outcome: pass.outcome, ...(pass.detail ?? {}) } } : {}) } });
    const report = r.output as UnitRunReport;
    const [c] = await rt.db.query<RunCounters>(`SELECT units_total, units_done, units_dead, units_skipped, status, cycle_code, period_key, as_of_date::text AS as_of_date FROM cycle_runs WHERE id = $1`, [job.run_id]);
    const receipt = c && c.units_done + c.units_dead + c.units_skipped >= c.units_total && c.units_dead === 0 ? await emitReceipt(rt, job.run_id, `unit:${job.id}`) : null;
    return { job_id: job.id, status: "done", report, receipt };
  } catch (e) {
    const failure = await recordFailure(rt, job, holder, e, def);
    return { job_id: job.id, status: failure.status, failure };
  }
}

export interface ExecutorReport { readonly holder: string; readonly claimed: number; readonly done: number; readonly failed: number; readonly dead: number; readonly receipts: number; readonly unblocked: number; readonly rounds: number; readonly stopped: "empty" | "deadline"; readonly duration_ms: number; readonly results: UnitResult[]; }
export interface DrainOptions { readonly holder?: string; /** Cycle codes this drain leaves queued (the sweep's `verify: false` leaves `projection_verify` for 35.1's own clock to breach). */ readonly exclude?: readonly string[]; /** The wall-clock instant to stop claiming at (rule 6: the sweep's start + 240 s); null = drain to completion (the demo advance, rule 10). */ readonly deadlineMs?: number | null; readonly limit?: number; readonly heartbeatMs?: number; }

/** Rule 6: claim, run, heartbeat, stop in time — and between rounds unblock the jobs whose dependencies the round just satisfied (a day's chain completes in one execution). */
export async function drainQueue(rt: Runtime, o: DrainOptions = {}): Promise<ExecutorReport> {
  const t0 = Date.now(); const holder = o.holder ?? `${rt.instanceId}:executor`;
  const results: UnitResult[] = []; let claimed = 0; let unblocked = 0; let rounds = 0; let stopped: "empty" | "deadline" = "empty";
  const running = new Set<string>();
  const beat = setInterval(() => { void heartbeatSql(rt.db, holder, [...running]).catch(() => undefined); }, o.heartbeatMs ?? HEARTBEAT_MS); beat.unref();
  try {
    for (;;) {
      if (o.deadlineMs !== null && o.deadlineMs !== undefined && Date.now() >= o.deadlineMs) { stopped = "deadline"; break; }
      const c = await claimJobs(rt, holder, o.limit ?? CLAIM_LIMIT, o.exclude ?? []);
      rounds += 1;
      if (!c.claimed.length) {
        const w = { as_of: rt.clock.now(), as_of_date: wallClock(Date.parse(rt.clock.now()), "America/New_York").date };
        const n = await unblockJobs(rt, w, rt.cycles.defs); unblocked += n;
        if (n === 0) break; else continue;
      }
      claimed += c.claimed.length;
      for (const j of c.claimed) { running.add(j.id); try { results.push(await runClaimedJob(rt, j, holder)); } finally { running.delete(j.id); } }
    }
  } finally { clearInterval(beat); }
  return { holder, claimed, done: results.filter((r) => r.status === "done").length, failed: results.filter((r) => r.status === "failed").length, dead: results.filter((r) => r.status === "dead").length, receipts: results.filter((r) => r.status === "done" && r.receipt).length, unblocked, rounds, stopped, duration_ms: Date.now() - t0, results };
}
