/**
 * §35.3 — the cycle engine: the planner (rules 1, 3, 4, 10, 11), the executor and the unit command (rules 5–8), the receipt
 * election (rule 5) and the registry's operations, over the five tables of db/migrations/0146 and the code registry of
 * cycles.ts / runners.ts. Everything here writes `cycle_registry`, `cycle_runs`, `jobs`, `job_events`, `cycle_receipts`, their
 * events, decisions and escalations, and nothing else (rule 12): a money field changes only inside the owner's command.
 *
 *   plan / planIn        the `cycles.plan` command's body (D10): the planner lock on a dedicated client (planner-lock.ts), the
 *                        registry upsert, per active cycle the period keys due and one transaction per (cycle, period) —
 *                        `cycle_runs` ON CONFLICT DO NOTHING, `jobs` ON CONFLICT (idempotency_key) DO NOTHING (`blocked` when a
 *                        dependency is unmet), `job_events{planned}`, `cycle.run.opened` through a local TimerEngine restored with
 *                        `timers.openGlobal()` so SM_CYCLE_RUN_STALLED_1D arms in the same transaction (the breach pass's pattern,
 *                        app.ts) — then the reclaim, unblock, requeue, reconcile and overdue passes, and one
 *                        `cycles.plan.run_completed` on the command's own global batch (SM_CYCLE_PLANNER_DAILY's trigger and
 *                        satisfying event). A refused lock appends `cycles.plan.skipped{holder}` and returns. Nothing in the
 *                        command body opens another unit of work (D4 — under 35.1's rule 7 a nested global unit would wait on
 *                        its own `uow:global` lock): the receipts the pass elects (a zero-unit run's — edge case 6 — and rule 5's
 *                        reconciliation of a run whose counters are full with no row) ride the command's own batch
 *                        (`electReceiptIn`: the events on `ctx.events`, the rows through `deferWrite`; the stall clock a
 *                        `planCycle` armed after the command hydrated is restored into `ctx.timers` so the completion satisfies it).
 *   electReceipt         rule 5, exactly once, the executor's shape: one global unit of work whose body re-reads the run (early
 *                        return when a receipt exists), appends the cycle's receipt literal (unless the owner emits it — rule 2:
 *                        `receipt_emitted_by: "owner"` for 35.1's, 35.2's and 35.12's cycles, whose election emits `cycle.run.completed`
 *                        only) and `cycle.run.completed{…, receipt_id}` on the `cycle_run` aggregate (the hydrated stall clock is
 *                        satisfied by the engine) and whose commit hook inserts `cycle_receipts{run_id UNIQUE}` — a loser of a race
 *                        hits 23505, its transaction rolls back and it returns `{elected: false}` (D9); the hook also unblocks the
 *                        dependents the receipt satisfied (D11). `electReceiptIn` is the same body for a command that is already
 *                        a global unit of work (the planner's reconciliation, `jobs.requeue{op: abandon}` — OQ3).
 *   requeueJob /         `jobs.requeue{op: requeue | abandon}` (rule 7, the state machine): an `ops_analyst`'s act on a `dead` unit —
 *   abandonJob           `queued` again with `attempts 0` and `max_attempts 3`, or `abandoned` (counted `skipped` toward the run's
 *                        total, a receipt when the run is now full); `job.unit.resolved{job_id, by, disposition}` on the job's
 *                        aggregate is SM_JOB_DEAD_2H's satisfying event (the command is global, so the job's clock is hydrated).
 *   claimByHandIn /      `cycles.run_unit{job_id}` on the bus is the by-hand dispatcher (D6): the command reads the job, refuses
 *   runUnitByHand        JOB_NOT_CLAIMABLE unless it is `queued` with its `run_after` passed, claims it in the command's own
 *                        transaction (`lease_holder = byhand:<actor>`, a zero-row claim rolls the command back) and appends
 *                        `job.unit.claimed`; the unit runs AFTER the commit through `runClaimed` — never inside the dispatcher's
 *                        command (nothing nested, D4). The executor adopts a `byhand:%` lease before claiming new rows, so a
 *                        by-hand claim never waits for its lease to expire; the done write checks the holder (LEASE_LOST) so a
 *                        unit whose lease moved on commits nothing.
 *   retryFailed          `cycles.retry{job_id}` (rule 7): a `failed` job before its `run_after` is queued now — the attempt it then
 *                        runs is the only one consumed (`job_events{requeued, early: true}`).
 *   escalateByHand       `cycles.escalate{run_id | job_id, reason}`: one sev2 (run) / sev3 (job) escalation to the registry row's
 *                        role with the standard payload, on the command's own escalation service (saved in its commit).
 *   runExecutor          rule 6: claim `FOR UPDATE SKIP LOCKED LIMIT 20` by wall clock, `job.unit.claimed` per row, heartbeat every
 *                        30 s, stop claiming after the budget; `runClaimed` runs one unit — `in_command` through
 *                        `Runtime.executeDef(unitCommand)` under the unit's own scope so its events, ledger sets, timers, the
 *                        decision (pre-minted id, D7), the job's `done` write and the run's counters commit in ONE transaction;
 *                        `pass` un-nested, then one global bookkeeping unit of work — a throw → `failed` with rule 7's backoff or
 *                        `dead` (`job.unit.dead` arming SM_JOB_DEAD_2H, one sev3 escalation to the registry row's role).
 *   cyclesSweepPass      what Runtime.sweep and the demo step call: `cycles.plan` on the bus, then (when asked) the executor.
 *
 * Wall clock vs runtime clock (D8): `lease_until`, `heartbeat_at`, `run_after`, `finished_at`, `job_events.at`, `completed_at` and
 * `last_receipt_at` bind `wallClockOf(rt)`; `opened_at`, `dead_at`, `as_of` and every event's `occurredAt` are the runtime clock's
 * (the demo clock in a rehearsal) — the instants the registry-driven clocks measure.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson } from "../../infra/db/client.ts";
import { MemoryEventStore, type Actor, type Clock, type DomainEvent, type EventStore } from "../../kernel/events/index.ts";
import { TimerEngine, type TimerInstance } from "../../kernel/timers/engine.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { type PlainDate, plainDate as D } from "../../kernel/calendar/date.ts";
import { defaultCalendars } from "../../kernel/calendar/business.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { CommandContext } from "../../app/commands.ts";
import { PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../../app/tools.ts";
import { classify } from "../../infra/integrations/failures.ts";
import type { Runtime } from "../../runtime/app.ts";
import type { Logger } from "../../runtime/log.ts";
import { CYCLES_VERSION, ET, EVT, cycleByCode, dependencyMet, expectedBy, monthOf, periodEndOf, periodKeysDue, priorMonthOf, type CycleDef, type PeriodDue, type Unit, type UnitContext } from "./cycles.ts";
import { CYCLES } from "./runners.ts";
import { CLAIM_LIMIT, EXECUTOR_BUDGET_MS, HEARTBEAT_MS, JOB_COLS, LEASE_MS, appendJobEvent, backoff, claimJobs, errorClassOf, getJob, heartbeat, plusMs, wallClockOf, type JobRow } from "./jobs.ts";
import { PLANNER_LOCK_KEY, PgSessionLock, type SessionLock } from "./planner-lock.ts";
import { CANCEL_STALL_ON } from "./timers-35-3.ts";

export const CYCLES_PROCESS = "35.3";
export const OPS_STEWARD: Actor = { kind: "agent", id: "ops-steward" };
export const UNIT_RULE_SET_VERSION = "cycles.v1";
export const UNIT_MODEL_VERSION = "deterministic";
export const UNIT_PROMPT_VERSION = "35.3-v1";
export const UNIT_COMMAND = "cycles.run_unit";
export const PLAN_COMMAND = "cycles.plan";
/** A by-hand claim's `lease_holder` (`byhand:<actor.kind>:<actor.id>`) — what the executor adopts before claiming new rows (D6). */
export const BYHAND_PREFIX = "byhand:";
export const byHandHolder = (a: Actor): string => `${BYHAND_PREFIX}${a.kind}:${a.id}`;
/** Error classes that die on the first attempt (rule 7: an `unavailable` failure; edge case 3: a missing runner). */
export const DEAD_AT_ONCE = new Set(["runner_missing", "def_missing"]);

export class CyclesRefused extends Error {
  readonly code: string; readonly detail: Record<string, unknown>;
  constructor(code: string, detail: Record<string, unknown> = {}, message?: string) { super(message ?? `${code}${Object.keys(detail).length ? " " + toJson(detail) : ""}`); this.name = "CyclesRefused"; this.code = code; this.detail = detail; }
}
export class RunnerMissing extends Error { constructor(code: string) { super(`runner_missing: no runner has landed for cycle ${code}`); this.name = "RunnerMissing"; } }

type Row = Record<string, unknown>;
const isDup = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "23505";
const asOfDateOf = (iso: string): PlainDate => wallClock(Date.parse(iso), ET).date;
const isOffsetClock = (c: Clock): c is Clock & { refresh(q: Queryable): Promise<unknown>; latestRow: { offset_ms: bigint | number } | null; base: Clock } => typeof (c as { refresh?: unknown }).refresh === "function" && "base" in c;
const byOf = (a: Actor): string => (a.kind === "human" ? a.id : `${a.kind}:${a.id}`);
const outcomeOf = (out: unknown): string => { if (out && typeof out === "object" && typeof (out as Row)["outcome"] === "string") return String((out as Row)["outcome"]); if (typeof out === "string") return out.slice(0, 200); return "ok"; };
type Counters = { units_done: number; units_dead: number; units_skipped: number; units_total: number };
const countersOf = (run: Row): Counters => ({ units_total: Number(run["units_total"]), units_done: Number(run["units_done"]), units_dead: Number(run["units_dead"]), units_skipped: Number(run["units_skipped"]) });
/** Rule 5: `units_done + units_dead + units_skipped = units_total` and `units_dead = 0` — the run completes and the receipt is elected. */
const countersFull = (c: Partial<Counters>): boolean => typeof c.units_total === "number" && (c.units_done ?? 0) + (c.units_dead ?? 0) + (c.units_skipped ?? 0) === c.units_total && (c.units_dead ?? 0) === 0;
interface ReceiptPlan { readonly run_id: string; readonly cycle_code: string; readonly period_key: string; readonly as_of_date: string; readonly counters: Counters; readonly def: CycleDef | undefined }

// ───────────────────────────── installation per runtime
export interface CyclesHooks {
  /** T9's rollback probe: a job whose deferred write must throw inside the unit's transaction. */
  readonly failCommitFor?: (jobId: string) => boolean;
}
export interface InstallOptions { readonly defs?: readonly CycleDef[]; readonly hooks?: CyclesHooks; readonly lock?: SessionLock; }
const installed = new WeakMap<Runtime, CyclesService>();
/** Register the cycle defs a runtime plans and runs (a test's own subset, or the production `CYCLES`). */
export function installCycles(rt: Runtime, opts: InstallOptions = {}): CyclesService { const s = new CyclesService(rt, opts); installed.set(rt, s); return s; }
/** The runtime's cycle service — the production registry unless `installCycles` chose otherwise. */
export function cyclesOf(rt: Runtime): CyclesService { let s = installed.get(rt); if (!s) { s = new CyclesService(rt, {}); installed.set(rt, s); } return s; }
/** `cycle_runs.planned_by`: the caller's, else 35.1's `sweep_runs` id when the runtime carries one (`Runtime.sweepRunId`, duck-typed — A3), else a uuid per pass. */
export function plannedByOf(rt: Runtime, opts: { readonly planned_by?: string | undefined }): string {
  if (opts.planned_by) return opts.planned_by;
  const sweepRunId = (rt as unknown as { sweepRunId?: unknown }).sweepRunId;
  return `sweep:${typeof sweepRunId === "string" && sweepRunId ? sweepRunId : randomUUID()}`;
}

export interface PlanInput { readonly as_of?: string; readonly cycle_codes?: readonly string[]; readonly planned_by?: string; }
export interface PlanOutput {
  readonly skipped: boolean; readonly holder: string | null; readonly run_id: string; readonly as_of: string; readonly as_of_date: PlainDate; readonly planned_by: string;
  readonly period_keys: readonly string[]; readonly runs_opened: number; readonly jobs_planned: number; readonly leases_reclaimed: number; readonly unblocked: number; readonly requeued: number;
  readonly receipts_reconciled: number; readonly overdue: number; readonly errors: readonly { cycle_code: string; period_key: string | null; error: string }[]; readonly duration_ms: number;
}
export interface ExecutorReport { readonly holder: string; readonly claimed: number; readonly done: number; readonly failed: number; readonly dead: number; /** units whose lease moved on before they committed (LEASE_LOST) — the holder of record's run is the run */ readonly lost: number; readonly receipts: number; readonly budget_spent: boolean; readonly ms: number; }
export interface ReceiptResult { readonly elected: boolean; readonly run_id: string; readonly receipt_id: string | null; readonly reason: "elected" | "exists" | "raced" | "no_run" | "cancelled" | "not_full"; }

export class CyclesService {
  readonly rt: Runtime;
  readonly defs: readonly CycleDef[];
  readonly hooks: CyclesHooks;
  private readonly lock: SessionLock | null;
  constructor(rt: Runtime, opts: InstallOptions) { this.rt = rt; this.defs = opts.defs ?? CYCLES; this.hooks = opts.hooks ?? {}; this.lock = opts.lock ?? null; }
  def(code: string): CycleDef | undefined { return cycleByCode(this.defs, code); }
  private get log(): Logger | undefined { return this.rt.logger; }
  private wall(): string { return wallClockOf(this.rt).now(); }
  private sessionLock(): SessionLock {
    if (this.lock) return this.lock;
    if (!this.rt.databaseUrl) throw new PortUnavailable("databaseUrl");
    return new PgSessionLock(this.rt.databaseUrl);
  }

  // ───────────────────────────── the planner (rules 1, 3, 4, 10, 11)
  /** `cycles.plan` on the bus (D10) as the ops-steward — what the sweep, the demo step and the tests call. */
  async plan(input: PlanInput = {}, actor: Actor = OPS_STEWARD): Promise<PlanOutput> {
    const r = await this.rt.execute({ process: CYCLES_PROCESS, name: PLAN_COMMAND, loanId: "", actor, input: { ...(input.as_of !== undefined ? { as_of: input.as_of } : {}), ...(input.cycle_codes ? { cycle_codes: [...input.cycle_codes] } : {}), ...(input.planned_by ? { planned_by: input.planned_by } : {}) } });
    return r.output as PlanOutput;
  }
  /** The `cycles.plan` command's body: runs under the planner lock; appends to the command's own global batch. */
  async planIn(ctx: CommandContext, toolRt: ToolRuntime, input: ToolInput): Promise<PlanOutput> {
    const rt = this.rt; const started = Date.now();
    // rule 10: the planned instant — the input's, or the clock's after an OffsetClock re-read the persisted offset; never a day the API has advanced past
    let asOf = typeof input["as_of"] === "string" && Number.isFinite(Date.parse(input["as_of"])) ? new Date(Date.parse(input["as_of"])).toISOString() : rt.clock.now();
    let demoOffsetMs = 0;
    if (isOffsetClock(rt.clock)) { await rt.clock.refresh(rt.db); const now = rt.clock.now(); if (Date.parse(now) > Date.parse(asOf)) asOf = now; demoOffsetMs = rt.clock.latestRow ? Number(rt.clock.latestRow.offset_ms) : 0; }
    const asOfDate = asOfDateOf(asOf);
    const plannedBy = typeof input["planned_by"] === "string" && input["planned_by"] ? input["planned_by"] : ctx.actor.kind === "human" ? `human:${ctx.actor.id}` : plannedByOf(rt, {});
    const codes = Array.isArray(input["cycle_codes"]) ? new Set((input["cycle_codes"] as unknown[]).map(String)) : null;
    const planRunId = randomUUID();
    // rule 1: one planner at a time — refused → skipped, and the sweep's other passes run regardless
    const lock = await this.sessionLock().acquire(PLANNER_LOCK_KEY, plannedBy);
    if (!lock.held) {
      ctx.events.append({ type: EVT.PLAN_SKIPPED, actor: ctx.actor, payload: { holder: lock.holder, as_of_date: asOfDate, as_of: asOf, planned_by: plannedBy, origination: true } });
      return { skipped: true, holder: lock.holder, run_id: planRunId, as_of: asOf, as_of_date: asOfDate, planned_by: plannedBy, period_keys: [], runs_opened: 0, jobs_planned: 0, leases_reclaimed: 0, unblocked: 0, requeued: 0, receipts_reconciled: 0, overdue: 0, errors: [], duration_ms: Date.now() - started };
    }
    const errors: { cycle_code: string; period_key: string | null; error: string }[] = [];
    let runsOpened = 0, jobsPlanned = 0, receipts = 0; const periodKeys: string[] = [];
    let reclaimed = 0, unblocked = 0, requeued = 0, overdue = 0;
    try {
      const wall = this.wall();
      await rt.db.tx((q) => this.upsertRegistry(q, wall));
      const active = new Set((await rt.db.query<{ cycle_code: string }>(`SELECT cycle_code FROM cycle_registry WHERE status = 'active'`)).map((r) => r.cycle_code));
      for (const def of this.defs) {
        if (!active.has(def.cycle_code) || (codes && !codes.has(def.cycle_code))) continue;
        let periods: PeriodDue[];
        try { periods = await periodKeysDue(rt.db, def, asOfDate); }
        catch (e) { const msg = e instanceof Error ? e.message : String(e); errors.push({ cycle_code: def.cycle_code, period_key: null, error: msg }); await this.registryError(def.cycle_code, "selector_error", wall); this.log?.error("cycles.plan: period keys failed", { cycle_code: def.cycle_code, error: msg }); continue; }
        for (const period of periods) {
          try {
            const r = await this.planCycle(def, period, { asOf, asOfDate, plannedBy, demoOffsetMs });
            periodKeys.push(`${def.cycle_code}:${period.period_key}`);
            // the run's stall clock was armed and saved in planCycle's transaction, after this command hydrated: restored here so a completion appended below (a zero-unit run's receipt, edge case 6) satisfies it in this batch
            if (r.opened) { runsOpened += 1; jobsPlanned += r.jobs; ctx.timers.restore(r.timers); }
          } catch (e) { const msg = e instanceof Error ? e.message : String(e); errors.push({ cycle_code: def.cycle_code, period_key: period.period_key, error: msg }); await this.registryError(def.cycle_code, errorClassOf(e) === "error" ? "plan_error" : errorClassOf(e), wall); this.log?.error("cycles.plan: cycle failed", { cycle_code: def.cycle_code, period_key: period.period_key, error: msg }); }
        }
      }
      reclaimed = await this.reclaimLeases(ctx, toolRt);
      unblocked = await this.unblock(ctx, toolRt);
      requeued = await this.requeueFailed(ctx, toolRt);
      // rule 5's reconciliation and edge case 6's zero-unit receipts, on this command's own batch (never a nested unit of work — D4)
      receipts = await this.reconcileReceiptsIn(ctx, toolRt);
      overdue = await this.markOverdue(asOf, asOfDate);
    } finally { await lock.release(); }
    const out: PlanOutput = { skipped: false, holder: plannedBy, run_id: planRunId, as_of: asOf, as_of_date: asOfDate, planned_by: plannedBy, period_keys: periodKeys, runs_opened: runsOpened, jobs_planned: jobsPlanned, leases_reclaimed: reclaimed, unblocked, requeued, receipts_reconciled: receipts, overdue, errors, duration_ms: Date.now() - started };
    // rule 3's last line: one `cycles.plan.run_completed` — SM_CYCLE_PLANNER_DAILY's trigger and satisfying event, on the global subject
    ctx.events.append({ type: EVT.PLAN_COMPLETED, actor: ctx.actor, payload: { run_id: planRunId, as_of: asOf, as_of_date: asOfDate, planned_by: plannedBy, period_keys: periodKeys, runs_opened: runsOpened, jobs_planned: jobsPlanned, leases_reclaimed: reclaimed, unblocked, requeued, receipts_reconciled: receipts, overdue, errors: errors.length, duration_ms: out.duration_ms, demo_offset_ms: demoOffsetMs, origination: true } });
    return out;
  }

  /** Rule 2: the table is the code's projection — every def upserted (a paused row keeps its pause; a retired code comes back `active`); a code absent from the defs goes `retired`. */
  async upsertRegistry(q: Queryable, wall: string): Promise<void> {
    for (const d of this.defs) {
      await q.query(
        `INSERT INTO cycle_registry (cycle_code, owner_process, owner_agent, unit_scope, schedule, period_grammar, unit_selector, unit_runner, receipt_event, depends_on, serves_timer, escalation_role, expected_by_rule, status, registry_version, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, 'active', $14, $15::timestamptz)
           ON CONFLICT (cycle_code) DO UPDATE SET owner_process = EXCLUDED.owner_process, owner_agent = EXCLUDED.owner_agent, unit_scope = EXCLUDED.unit_scope, schedule = EXCLUDED.schedule, period_grammar = EXCLUDED.period_grammar,
             unit_selector = EXCLUDED.unit_selector, unit_runner = EXCLUDED.unit_runner, receipt_event = EXCLUDED.receipt_event, depends_on = EXCLUDED.depends_on, serves_timer = EXCLUDED.serves_timer, escalation_role = EXCLUDED.escalation_role,
             expected_by_rule = EXCLUDED.expected_by_rule, status = CASE WHEN cycle_registry.status = 'retired' THEN 'active' ELSE cycle_registry.status END, registry_version = EXCLUDED.registry_version, updated_at = EXCLUDED.updated_at`,
        [d.cycle_code, d.owner_process, d.owner_agent, d.unit_scope, d.schedule, d.period_grammar, d.selector.name, d.runner?.name ?? null, d.receipt_event, toJson(d.depends_on), d.serves_timer, d.escalation_role, d.expected_by_rule, CYCLES_VERSION, wall]);
    }
    // a retired cycle is never overdue and has no next expectation (its history — runs, receipts — stays)
    await q.query(`UPDATE cycle_registry SET status = 'retired', overdue_since = NULL, next_period_key = NULL, next_expected_by = NULL, updated_at = $2::timestamptz WHERE status <> 'retired' AND cycle_code <> ALL($1::text[])`, [this.defs.map((d) => d.cycle_code), wall]);
  }
  private async registryError(code: string, errorClass: string, wall: string): Promise<void> { await this.rt.db.query(`UPDATE cycle_registry SET last_error_class = $2, updated_at = $3::timestamptz WHERE cycle_code = $1`, [code, errorClass, wall]).catch(() => undefined); }

  /** Rule 3: one transaction per (cycle, period) — idempotent by the run's and the jobs' unique keys; a new run appends `cycle.run.opened` (arming the stall clock). */
  async planCycle(def: CycleDef, period: PeriodDue, meta: { asOf: string; asOfDate: PlainDate; plannedBy: string; demoOffsetMs: number }): Promise<{ opened: boolean; run_id: string; jobs: number; units_total: number; timers: readonly TimerInstance[] }> {
    const rt = this.rt; const wall = this.wall();
    const none = { persisted: [] as Awaited<ReturnType<typeof rt.uow.events.append>>, timers: [] as TimerInstance[] };
    const r = await rt.db.tx(async (q) => {
      const existing = (await q.query<{ id: string; units_total: number }>(`SELECT id::text AS id, units_total FROM cycle_runs WHERE cycle_code = $1 AND period_key = $2`, [def.cycle_code, period.period_key]))[0];
      if (existing) return { opened: false, run_id: existing.id, jobs: 0, units_total: existing.units_total, ...none };
      const units: Unit[] = await def.selector.select(q, { ...period, as_of_date: meta.asOfDate, as_of: meta.asOf });
      const runId = randomUUID();
      const inserted = await q.query<{ id: string }>(
        `INSERT INTO cycle_runs (id, cycle_code, period_key, as_of_date, planned_by, opened_at, units_total, status, demo_offset_ms) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, 'planned', $8) ON CONFLICT (cycle_code, period_key) DO NOTHING RETURNING id::text AS id`,
        [runId, def.cycle_code, period.period_key, meta.asOfDate, meta.plannedBy, meta.asOf, units.length, String(meta.demoOffsetMs)]);
      if (!inserted.length) return { opened: false, run_id: "", jobs: 0, units_total: units.length, ...none };
      let jobs = 0;
      for (const u of units) {
        const input = { ...(u.input ?? {}) };
        let met = true;
        for (const dep of def.depends_on) { if (!(await dependencyMet(q, dep, { period, input, as_of_date: meta.asOfDate }))) { met = false; break; } }
        const row = await q.query<{ id: string }>(
          `INSERT INTO jobs (run_id, cycle_code, period_key, unit_id, loan_id, application_id, priority, depends_on_satisfied, status, max_attempts, idempotency_key, input)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 3, $10, $11::jsonb) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id::text AS id`,
          [runId, def.cycle_code, period.period_key, u.unit_id, u.loan_id ?? null, u.application_id ?? null, u.priority ?? 100, met, met ? "queued" : "blocked", `${def.cycle_code}:${period.period_key}:${u.unit_id}`, toJson(input)]);
        if (!row.length) continue;
        jobs += 1;
        await appendJobEvent(q, { job_id: row[0]!.id, kind: "planned", actor: OPS_STEWARD, at: wall, detail: { run_id: runId, period_key: period.period_key, unit_id: u.unit_id, planned_by: meta.plannedBy } });
        if (!met) await appendJobEvent(q, { job_id: row[0]!.id, kind: "blocked", actor: OPS_STEWARD, at: wall, detail: { depends_on: def.depends_on } });
      }
      // `cycle.run.opened` through a local engine restored with the open global instances (the breach pass's pattern), so SM_CYCLE_RUN_STALLED_1D arms — and is saved — in this transaction
      const events = new MemoryEventStore(rt.clock);
      const engine = new TimerEngine(rt.registry, events);
      const open = await rt.uow.timers.openGlobal();
      engine.restore(open); const known = new Set(open.map((t) => t.id));
      events.append({ type: EVT.RUN_OPENED, aggregate: { kind: "cycle_run", id: runId }, actor: OPS_STEWARD, occurredAt: meta.asOf,
        payload: { run_id: runId, cycle_code: def.cycle_code, period_key: period.period_key, as_of_date: meta.asOfDate, units_total: units.length, opened_at: meta.asOf, planned_by: meta.plannedBy, demo_offset_ms: meta.demoOffsetMs, origination: true } });
      const persisted = await rt.uow.events.append(events.since(0), q);
      const armed = engine.all().filter((t) => !known.has(t.id));
      await rt.uow.timers.save(armed, q);
      return { opened: true, run_id: runId, jobs, units_total: units.length, persisted, timers: armed };
    });
    rt.uow.notifyCommitted(r.persisted);
    return { opened: r.opened, run_id: r.run_id, jobs: r.jobs, units_total: r.units_total, timers: r.timers };
  }

  /** Rule 3: `running` jobs whose wall-clock lease expired go back to `queued` (the claim already counted the attempt) — `job.lease.expired` on the job's aggregate, the rows in the command's transaction. */
  async reclaimLeases(ctx: CommandContext, toolRt: ToolRuntime): Promise<number> {
    const wall = this.wall();
    const rows = await this.rt.db.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < $1::timestamptz ORDER BY lease_until`, [wall]);
    if (!rows.length) return 0;
    for (const j of rows) ctx.events.append({ type: EVT.LEASE_EXPIRED, aggregate: { kind: "job", id: j.id }, actor: ctx.actor, payload: { job_id: j.id, holder: j.lease_holder, lease_until: j.lease_until, attempt: j.attempts, cycle_code: j.cycle_code, period_key: j.period_key, unit_id: j.unit_id } });
    this.deferWrite(toolRt, async (q) => {
      for (const j of rows) {
        const done = await q.query<{ id: string }>(`UPDATE jobs SET status = 'queued', lease_holder = NULL, lease_until = NULL WHERE id = $1 AND status = 'running' AND lease_until < $2::timestamptz RETURNING id::text AS id`, [j.id, wall]);
        if (done.length) await appendJobEvent(q, { job_id: j.id, kind: "lease_expired", attempt: j.attempts, holder: j.lease_holder, actor: ctx.actor, at: wall, detail: { lease_until: j.lease_until } });
      }
    });
    return rows.length;
  }
  /** Rule 3: `blocked` jobs whose dependencies are now present go `queued` (`job_events{unblocked}`). */
  async unblock(ctx: CommandContext, toolRt: ToolRuntime): Promise<number> {
    const wall = this.wall();
    const ready = await this.readyBlocked(this.rt.db);
    if (!ready.length) return 0;
    this.deferWrite(toolRt, async (q) => { for (const id of ready) await this.queueBlocked(q, id, ctx.actor, wall); });
    return ready.length;
  }
  private async readyBlocked(q: Queryable): Promise<string[]> {
    // the run's as_of_date is what a `same_day` receipt dependency names (cycles.ts dependencyPeriod)
    const blocked = await q.query<JobRow & { run_as_of: string }>(`SELECT ${JOB_COLS.split(", ").map((c) => `j.${c}`).join(", ")}, r.as_of_date::text AS run_as_of FROM jobs j JOIN cycle_runs r ON r.id = j.run_id WHERE j.status = 'blocked' ORDER BY j.created_at`);
    const ready: string[] = [];
    for (const j of blocked) {
      const def = this.def(j.cycle_code); if (!def) continue;
      const period: PeriodDue = { period_key: j.period_key, period_end: periodEndOf(def, j.period_key) };
      let met = true;
      for (const dep of def.depends_on) { if (!(await dependencyMet(q, dep, { period, input: j.input ?? {}, as_of_date: D(j.run_as_of) }))) { met = false; break; } }
      if (met) ready.push(j.id);
    }
    return ready;
  }
  private async queueBlocked(q: Queryable, id: string, actor: Actor, wall: string): Promise<boolean> {
    const r = await q.query<{ id: string }>(`UPDATE jobs SET status = 'queued', depends_on_satisfied = true WHERE id = $1 AND status = 'blocked' RETURNING id::text AS id`, [id]);
    if (r.length) await appendJobEvent(q, { job_id: id, kind: "unblocked", actor, at: wall });
    return r.length > 0;
  }
  /** Rule 3 / rule 7: `failed` jobs whose `run_after` has passed go `queued` (`job_events{requeued}`). */
  async requeueFailed(ctx: CommandContext, toolRt: ToolRuntime): Promise<number> {
    const wall = this.wall();
    const rows = await this.rt.db.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs WHERE status = 'failed' AND (run_after IS NULL OR run_after <= $1::timestamptz) ORDER BY run_after`, [wall]);
    if (!rows.length) return 0;
    this.deferWrite(toolRt, async (q) => {
      for (const j of rows) {
        const r = await q.query<{ id: string }>(`UPDATE jobs SET status = 'queued' WHERE id = $1 AND status = 'failed' RETURNING id::text AS id`, [j.id]);
        if (r.length) await appendJobEvent(q, { job_id: j.id, kind: "requeued", attempt: j.attempts, actor: ctx.actor, at: wall, detail: { run_after: j.run_after } });
      }
    });
    return rows.length;
  }
  /** Rule 5's reconciliation (and edge case 6's zero-unit runs, opened this pass with nothing to run): every `planned` / `running` run whose counters are full with no dead unit and no receipt row gets its receipt with `emitted_by = planner:<run_id>`, on the planner command's own batch. */
  async reconcileReceiptsIn(ctx: CommandContext, toolRt: ToolRuntime): Promise<number> {
    const rows = await this.rt.db.query<{ id: string }>(`SELECT r.id::text AS id FROM cycle_runs r LEFT JOIN cycle_receipts c ON c.run_id = r.id WHERE c.id IS NULL AND r.status IN ('planned', 'running') AND r.units_dead = 0 AND r.units_done + r.units_dead + r.units_skipped = r.units_total ORDER BY r.opened_at`);
    let n = 0;
    for (const r of rows) { const e = await this.electReceiptIn(ctx, toolRt, r.id, `planner:${r.id}`); if (e.elected) n += 1; }
    return n;
  }
  /** Rule 11: `next_expected_by` from `expected_by_rule` and the calendar; `overdue_since` when the previous expectation passed with no receipt for its period (not while paused — OQ5). */
  async markOverdue(asOf: string, asOfDate: PlainDate): Promise<number> {
    const rt = this.rt; const wall = this.wall(); let overdue = 0;
    const rows = await rt.db.query<{ cycle_code: string; status: string; next_period_key: string | null; next_expected_by: string | null; overdue_since: string | null }>(`SELECT cycle_code, status, next_period_key, next_expected_by, overdue_since FROM cycle_registry`);
    for (const def of this.defs) {
      const row = rows.find((r) => r.cycle_code === def.cycle_code); if (!row) continue;
      const next = this.expectedWindow(def, asOfDate);
      if (row.status === "active" && row.next_expected_by && row.next_period_key && Date.parse(row.next_expected_by) < Date.parse(asOf)) {
        const got = await rt.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM cycle_receipts WHERE cycle_code = $1 AND period_key = $2`, [def.cycle_code, row.next_period_key]);
        if (Number(got[0]?.n ?? "0") === 0) {
          if (!row.overdue_since) { await rt.db.query(`UPDATE cycle_registry SET overdue_since = $2::timestamptz, updated_at = $3::timestamptz WHERE cycle_code = $1 AND overdue_since IS NULL`, [def.cycle_code, asOf, wall]); }
          overdue += 1;
        }
      }
      if (next) await rt.db.query(`UPDATE cycle_registry SET next_period_key = $2, next_expected_by = $3::timestamptz, updated_at = $4::timestamptz WHERE cycle_code = $1`, [def.cycle_code, next.period_key, new Date(next.expected_by).toISOString(), wall]);
      else await rt.db.query(`UPDATE cycle_registry SET next_period_key = NULL, next_expected_by = NULL, updated_at = $2::timestamptz WHERE cycle_code = $1`, [def.cycle_code, wall]);
    }
    return overdue;
  }
  /** The period a pass at `asOfDate` expects the cycle to receipt, and by when (null: no rule, or a `day` cycle on a non-business day of its calendar). */
  expectedWindow(def: CycleDef, asOfDate: PlainDate): { period_key: string; expected_by: number } | null {
    if (!def.expected_by_rule) return null;
    let period: PeriodDue;
    switch (def.period_grammar) {
      case "day": if (def.calendar && !defaultCalendars[def.calendar].isBusinessDay(asOfDate)) return null; period = { period_key: asOfDate, period_end: asOfDate }; break;
      case "month": period = def.period_of === "current_month" ? monthOf(asOfDate) : priorMonthOf(asOfDate); break;
      default: period = { period_key: asOfDate, period_end: asOfDate };
    }
    const at = expectedBy(def.expected_by_rule, period.period_end, def.calendar);
    return at === null ? null : { period_key: period.period_key, expected_by: at };
  }
  private deferWrite(toolRt: ToolRuntime, fn: (q: Queryable) => Promise<void>): void {
    const defer = toolRt.services["deferWrite"] as ((f: (q: Queryable) => Promise<void>) => void) | undefined;
    if (!defer) throw new PortUnavailable("service:deferWrite");
    defer(fn);
  }

  // ───────────────────────────── the receipt (rule 5, RECEIPT_ONCE)
  /** Phase 2 of an election: the run as it stands (or `expect`, the counters a deferred write of the same command is about to leave — `abandonJob`), or why there is nothing to elect. */
  private async receiptPlan(q: Queryable, runId: string, expect?: Counters): Promise<{ ok: true; plan: ReceiptPlan } | { ok: false; reason: ReceiptResult["reason"] }> {
    const run = (await q.query<Row>(`SELECT id::text AS id, cycle_code, period_key, as_of_date::text AS as_of_date, units_total, units_done, units_dead, units_skipped, status FROM cycle_runs WHERE id = $1`, [runId]))[0];
    if (!run) return { ok: false, reason: "no_run" };
    if (run["status"] === "cancelled") return { ok: false, reason: "cancelled" };
    if ((await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM cycle_receipts WHERE run_id = $1`, [runId]))[0]!.n !== "0") return { ok: false, reason: "exists" };
    const counters = expect ?? countersOf(run);
    if (!countersFull(counters)) return { ok: false, reason: "not_full" };
    const cycleCode = String(run["cycle_code"]);
    return { ok: true, plan: { run_id: runId, cycle_code: cycleCode, period_key: String(run["period_key"]), as_of_date: String(run["as_of_date"]), counters, def: this.def(cycleCode) } };
  }
  /** `outcomes_sha256` over the ordered `(unit_id, status, decision_id)` triples, and the units that ever died (A3 / OQ3: the receipt's `units_dead` records every `job_events{dead}`; the run's counter is the current count that blocks completion). */
  private async receiptOutcomes(q: Queryable, runId: string): Promise<{ sha: string; ever_dead: number }> {
    const jobs = await q.query<{ unit_id: string; status: string; decision_id: string | null }>(`SELECT unit_id, status, decision_id::text AS decision_id FROM jobs WHERE run_id = $1 ORDER BY unit_id`, [runId]);
    const sha = createHash("sha256").update(jobs.map((j) => `${j.unit_id}|${j.status}|${j.decision_id ?? ""}`).join("\n")).digest("hex");
    const everDead = Number((await q.query<{ n: string }>(`SELECT count(DISTINCT e.job_id)::text AS n FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.run_id = $1 AND e.kind = 'dead'`, [runId]))[0]!.n);
    return { sha, ever_dead: everDead };
  }
  /** The receipt's events on the run's aggregate: the cycle's literal — unless its owner emits it (rule 2: 35.1's, 35.2's and 35.12's cycles keep their own; the election emits `cycle.run.completed` only) — then `cycle.run.completed{…, receipt_id}`; the hydrated stall clock is satisfied by the engine. */
  private appendReceiptEvents(ctx: { readonly events: EventStore; readonly clock: Clock }, plan: ReceiptPlan, outcomes: { sha: string; ever_dead: number }, receiptId: string, emittedBy: string): { receipt: DomainEvent | null; generic: DomainEvent } {
    const payload = { run_id: plan.run_id, cycle_code: plan.cycle_code, period_key: plan.period_key, as_of_date: plan.as_of_date, units_total: plan.counters.units_total, units_done: plan.counters.units_done, units_dead: outcomes.ever_dead, units_skipped: plan.counters.units_skipped, outcomes_sha256: outcomes.sha, completed_at: ctx.clock.now(), emitted_by: emittedBy, origination: true };
    const receipt = plan.def?.receipt_emitted_by === "owner" ? null : ctx.events.append({ type: plan.def?.receipt_event ?? `${plan.cycle_code}.run_completed`, aggregate: { kind: "cycle_run", id: plan.run_id }, actor: OPS_STEWARD, payload });
    const generic = ctx.events.append({ type: EVT.RUN_COMPLETED, aggregate: { kind: "cycle_run", id: plan.run_id }, actor: OPS_STEWARD, ...(receipt ? { causationId: receipt.id } : {}), payload: { ...payload, receipt_id: receiptId, receipt_event: plan.def?.receipt_event ?? null, receipt_emitted_by: plan.def?.receipt_emitted_by ?? "election" } });
    return { receipt, generic };
  }
  /** The receipt's rows, inside the electing transaction after its events were appended (so the row can reference them): `cycle_receipts` (UNIQUE run_id — the race's last line), the run `completed`, the registry's last receipt, and the dependents this receipt satisfies (D11). The run is re-read under lock: a counter that moved since phase 2 refuses the election, and a row another election committed meanwhile is the unique key's 23505 — in the executor's own unit of work that is `{elected: false}`; on a command's batch it rolls the command back (the next planner pass reconciles; under 35.1's rule 7 the `uow:global` lock serialises the two and neither happens). */
  private async receiptRows(q: Queryable, plan: ReceiptPlan, ids: { receipt: string | null; generic: string }, receiptId: string, emittedBy: string, wall: string): Promise<void> {
    const run = (await q.query<Row>(`SELECT status, units_total, units_done, units_dead, units_skipped FROM cycle_runs WHERE id = $1 FOR UPDATE`, [plan.run_id]))[0];
    if (!run || run["status"] === "cancelled" || !countersFull(countersOf(run))) throw new CyclesRefused("RECEIPT_NOT_FULL", { run_id: plan.run_id, ...(run ? countersOf(run) : {}) });
    const c = countersOf(run); const o = await this.receiptOutcomes(q, plan.run_id);
    await q.query(`INSERT INTO cycle_receipts (id, run_id, cycle_code, period_key, as_of_date, units_total, units_done, units_dead, units_skipped, outcomes_sha256, receipt_event_id, generic_event_id, emitted_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [receiptId, plan.run_id, plan.cycle_code, plan.period_key, plan.as_of_date, c.units_total, c.units_done, o.ever_dead, c.units_skipped, o.sha, ids.receipt, ids.generic, emittedBy]);
    await q.query(`UPDATE cycle_runs SET status = 'completed', completed_at = $2::timestamptz, receipt_id = $3 WHERE id = $1`, [plan.run_id, wall, receiptId]);
    await q.query(`UPDATE cycle_registry SET last_period_key = $2, last_run_id = $3, last_receipt_at = $4::timestamptz, overdue_since = NULL, last_error_class = NULL, updated_at = $4::timestamptz WHERE cycle_code = $1`, [plan.cycle_code, plan.period_key, plan.run_id, wall]);
    // D11: the dependents this receipt satisfies are unblocked in the same transaction, so a same-day chain drains within one executor budget
    for (const id of await this.readyBlocked(q)) await this.queueBlocked(q, id, OPS_STEWARD, wall);
  }
  /** The executor's election (rule 5's "second, global unit of work"): one global unit of work of its own, never nested; the unique key on `cycle_receipts.run_id` is the race's last line (D9). */
  async electReceipt(runId: string, emittedBy: string): Promise<ReceiptResult> {
    const rt = this.rt; const receiptId = randomUUID(); const wall = this.wall();
    const st: { plan: ReceiptPlan | null; ids: { receipt: string | null; generic: string } | null; reason: ReceiptResult["reason"] } = { plan: null, ids: null, reason: "no_run" };
    try {
      await rt.uow.run({}, async (ctx) => {
        const p = await this.receiptPlan(rt.db, runId);
        if (!p.ok) { st.reason = p.reason; return; }
        const ev = this.appendReceiptEvents(ctx, p.plan, await this.receiptOutcomes(rt.db, runId), receiptId, emittedBy);
        st.plan = p.plan; st.ids = { receipt: ev.receipt?.id ?? null, generic: ev.generic.id }; st.reason = "elected";
      }, { clock: rt.clock, commit: async (q) => { if (st.plan && st.ids) await this.receiptRows(q, st.plan, st.ids, receiptId, emittedBy, wall); } });
    } catch (e) {
      if (isDup(e)) { this.log?.info("cycles: receipt raced, unique key held", { run_id: runId, emitted_by: emittedBy }); return { elected: false, run_id: runId, receipt_id: null, reason: "raced" }; }
      throw e;
    }
    const elected = st.reason === "elected";
    return { elected, run_id: runId, receipt_id: elected ? receiptId : null, reason: st.reason };
  }
  /** The same election for a command that is itself a global unit of work (the planner's reconciliation; `jobs.requeue{op: abandon}`): the events on the command's batch, the rows through `deferWrite` — nothing nested (D4). A stall clock armed after the command hydrated (a run this very pass opened) is restored so the completion satisfies it here. */
  async electReceiptIn(ctx: CommandContext, toolRt: ToolRuntime, runId: string, emittedBy: string, opts: { readonly expect?: Counters } = {}): Promise<ReceiptResult> {
    const rt = this.rt; const receiptId = randomUUID(); const wall = this.wall();
    const p = await this.receiptPlan(rt.db, runId, opts.expect);
    if (!p.ok) return { elected: false, run_id: runId, receipt_id: null, reason: p.reason };
    const known = new Set(ctx.timers.forSubject("cycle_run", runId).map((t) => t.id));
    ctx.timers.restore((await rt.uow.timers.forSubject("cycle_run", runId)).filter((t) => (t.status === "armed" || t.status === "breached") && !known.has(t.id)));
    const ev = this.appendReceiptEvents(ctx, p.plan, await this.receiptOutcomes(rt.db, runId), receiptId, emittedBy);
    const plan = p.plan; const ids = { receipt: ev.receipt?.id ?? null, generic: ev.generic.id };
    this.deferWrite(toolRt, (q) => this.receiptRows(q, plan, ids, receiptId, emittedBy, wall));
    return { elected: true, run_id: runId, receipt_id: receiptId, reason: "elected" };
  }

  // ───────────────────────────── jobs.requeue (rule 7, the state machine — an ops_analyst's act on a dead unit)
  private async deadJob(jobId: string): Promise<JobRow> {
    const job = await getJob(this.rt.db, jobId);
    if (!job) throw new CyclesRefused("JOB_NOT_FOUND", { job_id: jobId });
    if (job.status !== "dead") throw new CyclesRefused("JOB_NOT_DEAD", { job_id: jobId, status: job.status });
    return job;
  }
  /** `dead —(jobs.requeue{op: requeue}, ops_analyst)→ queued`: `attempts` reset to 0 and `max_attempts` 3 again (rule 7), `units_dead − 1`; `job.unit.resolved{disposition: requeued}` on the job's aggregate satisfies SM_JOB_DEAD_2H. The dead unit's escalation stays the owner role's to complete through 34.4. */
  async requeueJob(ctx: CommandContext, toolRt: ToolRuntime, jobId: string, reason: string): Promise<Row> {
    if (!reason) throw new RangeError("a requeue needs a reason");
    const job = await this.deadJob(jobId); const by = byOf(ctx.actor); const wall = this.wall();
    ctx.events.append({ type: EVT.RESOLVED, aggregate: { kind: "job", id: job.id }, actor: ctx.actor, payload: { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, by, reason, disposition: "requeued", attempts_before: job.attempts, error_class: job.last_error_class } });
    this.deferWrite(toolRt, async (q) => {
      const r = await q.query<{ id: string }>(`UPDATE jobs SET status = 'queued', attempts = 0, max_attempts = 3, run_after = NULL, lease_holder = NULL, lease_until = NULL, heartbeat_at = NULL, finished_at = NULL WHERE id = $1 AND status = 'dead' RETURNING id::text AS id`, [job.id]);
      if (!r.length) throw new CyclesRefused("JOB_NOT_DEAD", { job_id: job.id });
      await appendJobEvent(q, { job_id: job.id, kind: "requeued", attempt: 0, actor: ctx.actor, at: wall, detail: { reason, by, from: "dead", attempts_before: job.attempts, error_class: job.last_error_class } });
      await q.query(`UPDATE cycle_runs SET units_dead = greatest(units_dead - 1, 0) WHERE id = $1`, [job.run_id]);
    });
    return { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, status: "queued", disposition: "requeued", by, reason };
  }
  /** `dead —(jobs.requeue{op: abandon}, ops_analyst)→ abandoned` (terminal): counted `skipped` toward the run's total (`units_dead − 1`, `units_skipped + 1`); `job.unit.resolved{disposition: abandoned}`; when the run is now full its receipt is elected on this command's batch (OQ3 — the receipt records `units_dead > 0`, evidence of what the cycle did not do). */
  async abandonJob(ctx: CommandContext, toolRt: ToolRuntime, jobId: string, reason: string): Promise<Row> {
    if (!reason) throw new RangeError("an abandonment needs a reason");
    const job = await this.deadJob(jobId); const by = byOf(ctx.actor); const wall = this.wall();
    ctx.events.append({ type: EVT.RESOLVED, aggregate: { kind: "job", id: job.id }, actor: ctx.actor, payload: { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, by, reason, disposition: "abandoned", attempts: job.attempts, error_class: job.last_error_class } });
    const run = (await this.rt.db.query<Row>(`SELECT status, units_total, units_done, units_dead, units_skipped FROM cycle_runs WHERE id = $1`, [job.run_id]))[0];
    this.deferWrite(toolRt, async (q) => {
      const r = await q.query<{ id: string }>(`UPDATE jobs SET status = 'abandoned', finished_at = $2::timestamptz, lease_holder = NULL, lease_until = NULL WHERE id = $1 AND status = 'dead' RETURNING id::text AS id`, [job.id, wall]);
      if (!r.length) throw new CyclesRefused("JOB_NOT_DEAD", { job_id: job.id });
      await appendJobEvent(q, { job_id: job.id, kind: "abandoned", attempt: job.attempts, actor: ctx.actor, at: wall, error_class: job.last_error_class, detail: { reason, by } });
      await q.query(`UPDATE cycle_runs SET units_dead = greatest(units_dead - 1, 0), units_skipped = units_skipped + 1 WHERE id = $1`, [job.run_id]);
    });
    let receipt: ReceiptResult | null = null;
    if (run && run["status"] !== "cancelled") {
      const c = countersOf(run); const expect: Counters = { ...c, units_dead: Math.max(c.units_dead - 1, 0), units_skipped: c.units_skipped + 1 };
      if (countersFull(expect)) receipt = await this.electReceiptIn(ctx, toolRt, job.run_id, `unit:${job.id}`, { expect });
    }
    return { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, status: "abandoned", disposition: "abandoned", by, reason, receipt_id: receipt?.receipt_id ?? null };
  }

  // ───────────────────────────── cycles.run_unit by hand (D6), cycles.retry (rule 7), cycles.escalate
  /**
   * The `cycles.run_unit{job_id}` command's body: the claim, in the command's own transaction. A job that is not `queued` with
   * its `run_after` passed is refused JOB_NOT_CLAIMABLE{status} (worked example A: a second run of a `done` job); the claim's
   * UPDATE is the deferred write — zero rows (another claimant got there first) throws the same refusal and rolls the command
   * back, so `job.unit.claimed` is never persisted for a job this actor does not hold. The unit itself runs after the commit
   * (`runUnitByHand`), never here.
   */
  async claimByHandIn(ctx: CommandContext, toolRt: ToolRuntime, jobId: string): Promise<Row> {
    if (!jobId) throw new RangeError("cycles.run_unit needs job_id");
    const job = await getJob(this.rt.db, jobId);
    if (!job) throw new CyclesRefused("JOB_NOT_FOUND", { job_id: jobId });
    const wall = this.wall();
    if (job.status !== "queued" || (job.run_after !== null && Date.parse(job.run_after) > Date.parse(wall))) throw new CyclesRefused("JOB_NOT_CLAIMABLE", { job_id: jobId, status: job.status, run_after: job.run_after });
    if (!this.def(job.cycle_code)) throw new CyclesRefused("UNKNOWN_CYCLE", { job_id: jobId, cycle_code: job.cycle_code });
    const holder = byHandHolder(ctx.actor); const leaseUntil = plusMs(wall, LEASE_MS); const attempt = job.attempts + 1;
    ctx.events.append({ type: EVT.CLAIMED, aggregate: { kind: "job", id: job.id }, actor: ctx.actor, payload: { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, holder, lease_until: leaseUntil, attempt, by_hand: true } });
    this.deferWrite(toolRt, async (q) => {
      const r = await q.query<{ id: string }>(`UPDATE jobs SET status = 'running', lease_holder = $2, lease_until = $3::timestamptz, heartbeat_at = $4::timestamptz, attempts = attempts + 1 WHERE id = $1 AND status = 'queued' AND (run_after IS NULL OR run_after <= $4::timestamptz) RETURNING id::text AS id`, [job.id, holder, leaseUntil, wall]);
      if (!r.length) throw new CyclesRefused("JOB_NOT_CLAIMABLE", { job_id: job.id, status: "claimed_elsewhere" });
      await appendJobEvent(q, { job_id: job.id, kind: "claimed", attempt, holder, actor: ctx.actor, at: wall, detail: { lease_until: leaseUntil, unit_id: job.unit_id, by_hand: true } });
      await q.query(`UPDATE cycle_runs SET status = 'running' WHERE id = $1 AND status = 'planned'`, [job.run_id]);
    });
    return { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, claimed: true, holder, lease_until: leaseUntil, attempt };
  }
  /** `cycles.retry{job_id}`: a `failed` job before its `run_after` goes `queued` now; `attempts` is untouched — the attempt it then runs is the only one consumed (rule 7). */
  async retryFailed(ctx: CommandContext, toolRt: ToolRuntime, jobId: string): Promise<Row> {
    if (!jobId) throw new RangeError("cycles.retry needs job_id");
    const job = await getJob(this.rt.db, jobId);
    if (!job) throw new CyclesRefused("JOB_NOT_FOUND", { job_id: jobId });
    if (job.status !== "failed") throw new CyclesRefused("JOB_NOT_FAILED", { job_id: jobId, status: job.status });
    if (job.attempts >= job.max_attempts) throw new CyclesRefused("JOB_RETRY_CAP_3", { job_id: jobId, attempts: job.attempts, max_attempts: job.max_attempts });
    const wall = this.wall(); const by = byOf(ctx.actor);
    this.deferWrite(toolRt, async (q) => {
      const r = await q.query<{ id: string }>(`UPDATE jobs SET status = 'queued', run_after = NULL WHERE id = $1 AND status = 'failed' RETURNING id::text AS id`, [job.id]);
      if (!r.length) throw new CyclesRefused("JOB_NOT_FAILED", { job_id: job.id });
      await appendJobEvent(q, { job_id: job.id, kind: "requeued", attempt: job.attempts, actor: ctx.actor, at: wall, detail: { early: true, by, run_after_was: job.run_after, error_class: job.last_error_class } });
    });
    return { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, status: "queued", attempts: job.attempts, max_attempts: job.max_attempts, early: true, run_after_was: job.run_after, by };
  }
  /** `cycles.escalate{run_id | job_id, reason}`: one escalation to the registry row's role — sev2 for a run (the stall clock's payload), sev3 for a job (the dead unit's payload); opened on the command's escalation service, saved in its commit. */
  async escalateByHand(ctx: CommandContext, toolRt: ToolRuntime, i: { readonly run_id?: string; readonly job_id?: string; readonly reason: string }): Promise<Row> {
    if (!i.reason) throw new RangeError("cycles.escalate needs a reason");
    const by = byOf(ctx.actor);
    if (i.job_id) {
      const job = await getJob(this.rt.db, i.job_id);
      if (!job) throw new CyclesRefused("JOB_NOT_FOUND", { job_id: i.job_id });
      const def = this.def(job.cycle_code);
      const e = toolRt.escalations.open({ kind: "sev3", ownerRole: def?.escalation_role ?? "ops_analyst", severity: "3", ...(job.loan_id ? { loanId: job.loan_id } : {}),
        payload: { cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, error_class: job.last_error_class, job_id: job.id, run_id: job.run_id, status: job.status, attempts: job.attempts, reason: i.reason, by, by_hand: true } }, ctx.actor);
      return { escalation_id: e.id, kind: e.kind, owner_role: e.ownerRole, job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, reason: i.reason, by };
    }
    if (!i.run_id) throw new RangeError("cycles.escalate needs run_id or job_id");
    const run = (await this.rt.db.query<Row>(`SELECT id::text AS id, cycle_code, period_key, status, units_total, units_done, units_dead, units_skipped FROM cycle_runs WHERE id = $1`, [i.run_id]))[0];
    if (!run) throw new CyclesRefused("RUN_NOT_FOUND", { run_id: i.run_id });
    const def = this.def(String(run["cycle_code"]));
    const e = toolRt.escalations.open({ kind: "sev2", ownerRole: def?.escalation_role ?? "ops_analyst", severity: "2",
      payload: { cycle_code: run["cycle_code"], period_key: run["period_key"], run_id: run["id"], status: run["status"], units_done: run["units_done"], units_total: run["units_total"], units_dead: run["units_dead"], units_skipped: run["units_skipped"], reason: i.reason, by, by_hand: true } }, ctx.actor);
    return { escalation_id: e.id, kind: e.kind, owner_role: e.ownerRole, run_id: run["id"], cycle_code: run["cycle_code"], period_key: run["period_key"], reason: i.reason, by };
  }

  // ───────────────────────────── the registry's operations (cycles.registry)
  async registryList(): Promise<Row[]> {
    return this.rt.db.query<Row>(`SELECT cycle_code, owner_process, owner_agent, unit_scope, schedule, period_grammar, unit_selector, unit_runner, receipt_event, depends_on, serves_timer, escalation_role, expected_by_rule, status, paused_by, paused_reason, last_period_key, last_run_id::text AS last_run_id, last_receipt_at, next_period_key, next_expected_by, overdue_since, last_error_class, registry_version, updated_at
      FROM cycle_registry ORDER BY (status = 'retired'), (overdue_since IS NULL), overdue_since, cycle_code`);
  }
  /** `cycles.registry{op: pause}`: the row goes `paused`; every planned / running run of the cycle is cancelled (blocked / queued jobs → `skipped`, running ones finish; `cycle.run.cancelled`; the stall clock cancelled — edge cases). */
  async pauseCycle(ctx: CommandContext, toolRt: ToolRuntime, code: string, reason: string): Promise<Row> {
    const def = this.def(code); if (!def) throw new CyclesRefused("UNKNOWN_CYCLE", { cycle_code: code });
    if (!reason) throw new RangeError("a pause needs a reason");
    const wall = this.wall(); const by = byOf(ctx.actor);
    const runs = await this.rt.db.query<Row>(`SELECT id::text AS id, period_key FROM cycle_runs WHERE cycle_code = $1 AND status IN ('planned', 'running') ORDER BY opened_at`, [code]);
    for (const r of runs) await this.cancelRun(ctx, toolRt, String(r["id"]), by, reason);
    this.deferWrite(toolRt, async (q) => { await q.query(`UPDATE cycle_registry SET status = 'paused', paused_by = $2, paused_reason = $3, updated_at = $4::timestamptz WHERE cycle_code = $1`, [code, by, reason, wall]); });
    return { cycle_code: code, status: "paused", paused_by: by, paused_reason: reason, runs_cancelled: runs.map((r) => String(r["id"])) };
  }
  async resumeCycle(ctx: CommandContext, toolRt: ToolRuntime, code: string, reason: string): Promise<Row> {
    const def = this.def(code); if (!def) throw new CyclesRefused("UNKNOWN_CYCLE", { cycle_code: code });
    const wall = this.wall(); const by = byOf(ctx.actor);
    this.deferWrite(toolRt, async (q) => { await q.query(`UPDATE cycle_registry SET status = 'active', paused_by = NULL, paused_reason = NULL, overdue_since = NULL, updated_at = $2::timestamptz WHERE cycle_code = $1 AND status = 'paused'`, [code, wall]); });
    return { cycle_code: code, status: "active", resumed_by: by, reason };
  }
  /** State machine: `planned | running —(pause then cycle.run.cancelled)→ cancelled`; the stall clock is cancelled with CANCEL_STALL_ON's citation, never satisfied. */
  async cancelRun(ctx: CommandContext, toolRt: ToolRuntime, runId: string, by: string, reason: string): Promise<void> {
    const wall = this.wall();
    const pending = await this.rt.db.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs WHERE run_id = $1 AND status IN ('blocked', 'queued')`, [runId]);
    ctx.events.append({ type: EVT.RUN_CANCELLED, aggregate: { kind: "cycle_run", id: runId }, actor: ctx.actor, payload: { run_id: runId, by, reason, units_skipped: pending.length } });
    for (const t of ctx.timers.forSubject("cycle_run", runId)) if (t.code === CANCEL_STALL_ON.code && (t.status === "armed" || t.status === "breached")) ctx.timers.cancel(t.id, CANCEL_STALL_ON.why, ctx.actor);
    this.deferWrite(toolRt, async (q) => {
      for (const j of pending) {
        const r = await q.query<{ id: string }>(`UPDATE jobs SET status = 'skipped', finished_at = $2::timestamptz WHERE id = $1 AND status IN ('blocked', 'queued') RETURNING id::text AS id`, [j.id, wall]);
        if (r.length) await appendJobEvent(q, { job_id: j.id, kind: "skipped", actor: ctx.actor, at: wall, detail: { reason, run_cancelled: true } });
      }
      await q.query(`UPDATE cycle_runs SET status = 'cancelled', cancelled_by = $2, cancelled_reason = $3, units_skipped = units_skipped + $4 WHERE id = $1 AND status IN ('planned', 'running')`, [runId, by, reason, pending.length]);
    });
  }

  // ───────────────────────────── reads (cycles.receipt, jobs.list)
  async readReceipt(runId: string): Promise<Row | null> {
    const receipt = (await this.rt.db.query<Row>(`SELECT id::text AS id, run_id::text AS run_id, cycle_code, period_key, as_of_date::text AS as_of_date, units_total, units_done, units_dead, units_skipped, outcomes_sha256, receipt_event_id::text AS receipt_event_id, generic_event_id::text AS generic_event_id, emitted_by, created_at FROM cycle_receipts WHERE run_id = $1`, [runId]))[0];
    const run = (await this.rt.db.query<Row>(`SELECT id::text AS id, cycle_code, period_key, as_of_date::text AS as_of_date, planned_by, opened_at, units_total, units_done, units_dead, units_skipped, status, completed_at, receipt_id::text AS receipt_id, cancelled_by, cancelled_reason, demo_offset_ms::text AS demo_offset_ms FROM cycle_runs WHERE id = $1`, [runId]))[0];
    if (!run) return null;
    const events = receipt ? await this.rt.db.query<Row>(`SELECT id::text AS id, sequence::text AS sequence, type, occurred_at FROM loan_events WHERE id = ANY($1::uuid[]) ORDER BY sequence`, [[receipt["receipt_event_id"], receipt["generic_event_id"]].filter(Boolean)]) : [];
    const units = await this.rt.db.query<Row>(`SELECT DISTINCT ON (e.job_id) e.job_id::text AS job_id, j.unit_id, j.status, j.attempts, j.decision_id::text AS decision_id, e.kind, e.attempt, e.holder, e.actor_kind::text AS actor_kind, e.actor_id, e.error_class, e.at FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.run_id = $1 ORDER BY e.job_id, e.id DESC`, [runId]);
    return { run, receipt: receipt ?? null, events, units };
  }
  async listJobs(f: { cycle_code?: string | null; status?: string | null; period_key?: string | null; loan_id?: string | null; run_id?: string | null; limit?: number }): Promise<JobRow[]> {
    const conds: string[] = []; const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); conds.push(sql.replace("?", `$${params.length}`)); };
    if (f.cycle_code) add("cycle_code = ?", f.cycle_code); if (f.status) add("status = ?", f.status); if (f.period_key) add("period_key = ?", f.period_key); if (f.loan_id) add("loan_id = ?", f.loan_id); if (f.run_id) add("run_id = ?", f.run_id);
    params.push(Math.min(Math.max(1, f.limit ?? 200), 1000));
    return this.rt.db.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY created_at, id LIMIT $${params.length}`, params);
  }
}

// ───────────────────────────── the executor (rules 5–8)
/** The internal `cycles.run_unit` command (D6): the unit's owner is the agent, the decision is 35.3's own with a pre-minted id (D7), the job's `done` write and the run's counters ride the command's transaction through `deferWrite`. */
export function unitCommand(svc: CyclesService, def: CycleDef, job: JobRow, holder: string, dispatchedBy?: Actor): ToolDef {
  const rt = svc.rt;
  const runner = def.runner;
  return { name: UNIT_COMMAND, process: CYCLES_PROCESS, agent: def.owner_agent, kind: "act", ruleSetVersion: UNIT_RULE_SET_VERSION, humanRoles: ["ops_analyst"], decision: () => null,
    handler: async (input, ctx, toolRt) => {
      if (!runner) throw new RunnerMissing(def.cycle_code);
      if (runner.runner.mode !== "in_command") throw new Error("pass_runner_in_command: a pass-shaped runner never runs inside the unit command");
      const unit = unitContextOf(def, job, ctx.actor);
      const decisionId = randomUUID(); const started = Date.now();
      const out = await runner.runner.run(toolRt, ctx, unit);
      const outcome = outcomeOf(out);
      const duration = Date.now() - started;
      // loan-keyed when the scope is a loan (withDefaultLoan stamps it — it arms nothing); the decision id is the one the deferred write records
      ctx.events.append({ type: EVT.DONE, aggregate: { kind: "job", id: job.id }, actor: ctx.actor, payload: { job_id: job.id, run_id: job.run_id, cycle_code: def.cycle_code, period_key: job.period_key, unit_id: job.unit_id, decision_id: decisionId, duration_ms: duration, attempt: job.attempts, outcome } });
      const counters: { units_done?: number; units_dead?: number; units_skipped?: number; units_total?: number } = {};
      const defer = toolRt.services["deferWrite"] as ((f: (q: Queryable) => Promise<void>) => void) | undefined;
      if (!defer) throw new PortUnavailable("service:deferWrite");
      // a human who dispatched the unit by hand approves the owner agent's decision (D7); the unit still runs as the owner
      const approver = dispatchedBy?.kind === "human" ? dispatchedBy : ctx.actor.kind === "human" ? ctx.actor : undefined;
      const wall = wallClockOf(rt).now();
      defer(async (q) => {
        if (svc.hooks.failCommitFor?.(job.id)) throw new Error("forced_commit_failure: the test asked this unit's transaction to fail");
        await rt.uow.decisions.record({ agent: def.owner_agent, action: UNIT_COMMAND, subject: { kind: def.cycle_code, id: job.unit_id }, ruleSetVersion: UNIT_RULE_SET_VERSION, modelVersion: UNIT_MODEL_VERSION, promptVersion: UNIT_PROMPT_VERSION, confidence: 1,
          rationale: `${def.cycle_code} ${job.period_key} unit ${job.unit_id}: ${outcome}`, ...(job.loan_id ? { loanId: job.loan_id } : {}), ...(job.application_id ? { applicationId: job.application_id } : {}), ...(approver ? { approvedBy: approver.id, ...(approver.role ? { approvedRole: approver.role } : {}) } : {}) }, q, decisionId);
        await markDone(q, job, holder, decisionId, wall);
        await appendJobEvent(q, { job_id: job.id, kind: "done", attempt: job.attempts, holder, actor: ctx.actor, at: wall, detail: { decision_id: decisionId, duration_ms: duration, outcome } });
        const [c] = await q.query<{ units_done: number; units_dead: number; units_skipped: number; units_total: number }>(`UPDATE cycle_runs SET units_done = units_done + 1, status = CASE WHEN status = 'planned' THEN 'running' ELSE status END WHERE id = $1 RETURNING units_done, units_dead, units_skipped, units_total`, [job.run_id]);
        Object.assign(counters, c);
      });
      return { job_id: job.id, unit_id: job.unit_id, decision_id: decisionId, outcome, output: out, counters };
    } };
}
export function unitContextOf(def: CycleDef, job: JobRow, actor: Actor): UnitContext {
  return { job_id: job.id, run_id: job.run_id, cycle_code: def.cycle_code, period_key: job.period_key, period_end: periodEndOf(def, job.period_key), unit_id: job.unit_id, loan_id: job.loan_id, application_id: job.application_id, as_of_date: D(String(job.period_key).slice(0, 10).length === 10 ? String(job.period_key).slice(0, 10) : periodEndOf(def, job.period_key)), input: job.input ?? {}, actor, attempt: job.attempts };
}

/** The job's `done` write, guarded by the lease: a job whose lease moved on (reclaimed by the planner and re-run, or adopted by an executor) commits nothing — the transaction rolls back with LEASE_LOST and the new holder's run is the run. */
async function markDone(q: Queryable, job: JobRow, holder: string, decisionId: string, wall: string): Promise<void> {
  const r = await q.query<{ id: string }>(`UPDATE jobs SET status = 'done', decision_id = $2, finished_at = $3::timestamptz, lease_holder = NULL, lease_until = NULL WHERE id = $1 AND status = 'running' AND lease_holder = $4 RETURNING id::text AS id`, [job.id, decisionId, wall, holder]);
  if (!r.length) throw new CyclesRefused("LEASE_LOST", { job_id: job.id, holder });
}
const isLeaseLost = (e: unknown): boolean => e instanceof CyclesRefused && e.code === "LEASE_LOST";

export interface RunClaimedOptions { readonly electReceipt?: boolean; readonly actor?: Actor; /** the human (or agent) who dispatched the unit by hand — the decision's approver when human (D7); the unit still runs as the owner agent. */ readonly dispatchedBy?: Actor; }
/** One claimed job through its runner (see the header) — returns the outcome for the executor's tally; never throws for a unit's own failure. */
export async function runClaimed(rt: Runtime, job: JobRow, holder: string, opts: RunClaimedOptions = {}): Promise<"done" | "failed" | "dead" | "lost"> {
  const svc = cyclesOf(rt); const def = svc.def(job.cycle_code);
  const hb = setInterval(() => { heartbeat(rt.db, job.id, holder, wallClockOf(rt).now()).catch(() => undefined); }, HEARTBEAT_MS); hb.unref();
  try {
    if (!def) throw new Error(`def_missing: no registered cycle ${job.cycle_code}`);
    if (!def.runner) throw new RunnerMissing(def.cycle_code);
    const owner: Actor = opts.actor ?? { kind: "agent", id: def.owner_agent };
    let counters: { units_done?: number; units_dead?: number; units_skipped?: number; units_total?: number } = {};
    if (def.runner.runner.mode === "in_command") {
      const r = await rt.executeDef(unitCommand(svc, def, job, holder, opts.dispatchedBy), { loanId: job.loan_id ?? "", ...(job.application_id ? { applicationId: job.application_id } : {}), actor: owner, input: { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, ...(job.input ?? {}) },
        run: { runId: job.id, modelVersion: UNIT_MODEL_VERSION, promptVersion: UNIT_PROMPT_VERSION, confidence: 1 } });
      counters = (r.output as { counters: typeof counters }).counters;
    } else {
      // a pass-shaped runner runs un-nested (D5), then one global unit of work writes the decision, `job.unit.done` and the rows
      const unit = unitContextOf(def, job, owner); const started = Date.now();
      const out = await def.runner.runner.run(rt, unit); const outcome = outcomeOf(out); const duration = Date.now() - started; const decisionId = randomUUID(); const wall = wallClockOf(rt).now();
      await rt.uow.run({}, (ctx) => { ctx.events.append({ type: EVT.DONE, aggregate: { kind: "job", id: job.id }, actor: owner, payload: { job_id: job.id, run_id: job.run_id, cycle_code: def.cycle_code, period_key: job.period_key, unit_id: job.unit_id, decision_id: decisionId, duration_ms: duration, attempt: job.attempts, outcome } }); }, { clock: rt.clock, commit: async (q) => {
        if (svc.hooks.failCommitFor?.(job.id)) throw new Error("forced_commit_failure: the test asked this unit's transaction to fail");
        const approver = opts.dispatchedBy?.kind === "human" ? opts.dispatchedBy : undefined;
        await rt.uow.decisions.record({ agent: def.owner_agent, action: UNIT_COMMAND, subject: { kind: def.cycle_code, id: job.unit_id }, ruleSetVersion: UNIT_RULE_SET_VERSION, modelVersion: UNIT_MODEL_VERSION, promptVersion: UNIT_PROMPT_VERSION, confidence: 1, rationale: `${def.cycle_code} ${job.period_key} unit ${job.unit_id}: ${outcome}`, ...(job.loan_id ? { loanId: job.loan_id } : {}), ...(approver ? { approvedBy: approver.id, ...(approver.role ? { approvedRole: approver.role } : {}) } : {}) }, q, decisionId);
        await markDone(q, job, holder, decisionId, wall);
        await appendJobEvent(q, { job_id: job.id, kind: "done", attempt: job.attempts, holder, actor: owner, at: wall, detail: { decision_id: decisionId, duration_ms: duration, outcome } });
        const [c] = await q.query<{ units_done: number; units_dead: number; units_skipped: number; units_total: number }>(`UPDATE cycle_runs SET units_done = units_done + 1, status = CASE WHEN status = 'planned' THEN 'running' ELSE status END WHERE id = $1 RETURNING units_done, units_dead, units_skipped, units_total`, [job.run_id]);
        counters = { ...c };
      } });
    }
    if (countersFull(counters) && opts.electReceipt !== false) await svc.electReceipt(job.run_id, `unit:${job.id}`);
    return "done";
  } catch (e) {
    // the lease moved on while the unit ran (reclaimed and re-run, or adopted): its transaction rolled back and the holder of record owns the job — no bookkeeping here
    if (isLeaseLost(e)) { rt.logger?.warn("cycles: unit lost its lease before committing", { job_id: job.id, cycle_code: job.cycle_code, unit_id: job.unit_id, holder }); return "lost"; }
    const errorClass = errorClassOf(e); const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    const deadNow = classify(e) === "unavailable" || DEAD_AT_ONCE.has(errorClass) || job.attempts >= job.max_attempts;
    rt.logger?.warn("cycles: unit threw", { job_id: job.id, cycle_code: job.cycle_code, unit_id: job.unit_id, attempt: job.attempts, error_class: errorClass, dead: deadNow, error: message });
    if (deadNow) { await markDead(rt, job, holder, errorClass, message, def); return "dead"; }
    await markFailed(rt, job, holder, errorClass, message);
    return "failed";
  } finally { clearInterval(hb); }
}
/** Rule 7: `failed` with `run_after = wall + backoff(attempt)` — `job.unit.failed` on the job's aggregate. */
async function markFailed(rt: Runtime, job: JobRow, holder: string, errorClass: string, message: string): Promise<void> {
  const wall = wallClockOf(rt).now(); const runAfter = plusMs(wall, backoff(job.attempts));
  await rt.uow.run({}, (ctx) => { ctx.events.append({ type: EVT.FAILED, aggregate: { kind: "job", id: job.id }, actor: OPS_STEWARD, payload: { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, attempt: job.attempts, error_class: errorClass, run_after: runAfter } }); },
    { clock: rt.clock, commit: async (q) => {
      await q.query(`UPDATE jobs SET status = 'failed', run_after = $2::timestamptz, last_error_class = $3, last_error = $4, lease_holder = NULL, lease_until = NULL WHERE id = $1 AND status = 'running'`, [job.id, runAfter, errorClass, message]);
      await appendJobEvent(q, { job_id: job.id, kind: "failed", attempt: job.attempts, holder, actor: OPS_STEWARD, error_class: errorClass, error: message, at: wall, detail: { run_after: runAfter } });
      await q.query(`UPDATE cycle_runs SET status = 'running' WHERE id = $1 AND status = 'planned'`, [job.run_id]);
    } });
}
/** Rule 7: `dead` — `job.unit.dead{…, dead_at}` on the job's aggregate (arming SM_JOB_DEAD_2H with `occurredAt = dead_at`), one sev3 escalation to the registry row's `escalation_role`, `units_dead + 1`; the run stays `running`. */
async function markDead(rt: Runtime, job: JobRow, holder: string, errorClass: string, message: string, def: CycleDef | undefined): Promise<void> {
  const wall = wallClockOf(rt).now(); const deadAt = rt.clock.now();
  let escalations: EscalationService | undefined;
  await rt.uow.run({}, (ctx) => {
    ctx.events.append({ type: EVT.DEAD, aggregate: { kind: "job", id: job.id }, actor: OPS_STEWARD, occurredAt: deadAt, payload: { job_id: job.id, run_id: job.run_id, cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, attempts: job.attempts, error_class: errorClass, dead_at: deadAt, origination: true } });
    escalations = new EscalationService(ctx.events, ctx.clock);
    escalations.open({ kind: "sev3", ownerRole: def?.escalation_role ?? "ops_analyst", severity: "3", ...(job.loan_id ? { loanId: job.loan_id } : {}), payload: { cycle_code: job.cycle_code, period_key: job.period_key, unit_id: job.unit_id, error_class: errorClass, job_id: job.id, run_id: job.run_id, attempts: job.attempts, choices: ["requeue", "abandon"] } }, OPS_STEWARD);
  }, { clock: rt.clock, commit: async (q) => {
    await q.query(`UPDATE jobs SET status = 'dead', last_error_class = $2, last_error = $3, finished_at = $4::timestamptz, lease_holder = NULL, lease_until = NULL WHERE id = $1 AND status = 'running'`, [job.id, errorClass, message, wall]);
    await appendJobEvent(q, { job_id: job.id, kind: "dead", attempt: job.attempts, holder, actor: OPS_STEWARD, error_class: errorClass, error: message, at: wall, detail: { dead_at: deadAt } });
    await q.query(`UPDATE cycle_runs SET units_dead = units_dead + 1, status = CASE WHEN status = 'planned' THEN 'running' ELSE status END WHERE id = $1`, [job.run_id]);
    for (const e of escalations?.list() ?? []) await rt.escalationRepo.save(e, q);
  } });
}

/** The by-hand dispatch (D6): `cycles.run_unit{job_id}` on the bus claims the job in its own command (the actor's allowlist, guardrails, `job.unit.claimed` and the claim row commit first), then the unit runs through `runClaimed` exactly as an executor's claim would — after the commit, never inside it. */
export async function runUnitByHand(rt: Runtime, i: { readonly job_id: string; readonly actor: Actor }): Promise<{ claimed: Row; result: "done" | "failed" | "dead" | "lost"; job: JobRow }> {
  const r = await rt.execute({ process: CYCLES_PROCESS, name: UNIT_COMMAND, loanId: "", actor: i.actor, input: { job_id: i.job_id } });
  const claimed = r.output as Row; const holder = String(claimed["holder"]);
  const job = await getJob(rt.db, i.job_id);
  if (!job || job.status !== "running" || job.lease_holder !== holder) throw new CyclesRefused("JOB_NOT_CLAIMABLE", { job_id: i.job_id, status: job?.status ?? "missing", lease_holder: job?.lease_holder ?? null });
  const result = await runClaimed(rt, job, holder, { dispatchedBy: i.actor });
  return { claimed, result, job };
}

export interface ExecutorOptions { readonly holder?: string; readonly budgetMs?: number; readonly claimLimit?: number; readonly drain?: "all" | "budget"; readonly electReceipt?: boolean; }
/** Rule 6: claim by wall clock until the queue is empty or the budget is spent; every claimed unit finishes (a claimed unit is never released early). */
export async function runExecutor(rt: Runtime, opts: ExecutorOptions = {}): Promise<ExecutorReport> {
  const holder = opts.holder ?? `sweep:${randomUUID()}`; const started = Date.now();
  const budget = opts.drain === "all" ? Number.POSITIVE_INFINITY : opts.budgetMs ?? EXECUTOR_BUDGET_MS;
  const limit = opts.claimLimit ?? CLAIM_LIMIT;
  let claimed = 0, done = 0, failed = 0, dead = 0, lost = 0; let budgetSpent = false;
  const before = async (): Promise<number> => Number((await rt.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM cycle_receipts`))[0]!.n);
  const receiptsBefore = await before();
  const tally = (r: Awaited<ReturnType<typeof runClaimed>>): void => { if (r === "done") done += 1; else if (r === "failed") failed += 1; else if (r === "dead") dead += 1; else lost += 1; };
  // D6: a job claimed by hand (`lease_holder = byhand:<actor>`) whose dispatcher has not run it yet is adopted under this holder before any new claim, so a by-hand claim never waits for its lease to expire
  {
    const wall = wallClockOf(rt).now();
    const adopted = await rt.db.query<JobRow>(`UPDATE jobs SET lease_holder = $1, lease_until = $2::timestamptz + interval '5 minutes', heartbeat_at = $2::timestamptz WHERE status = 'running' AND lease_holder LIKE $3 RETURNING ${JOB_COLS}`, [holder, wall, `${BYHAND_PREFIX}%`]);
    for (const j of adopted) {
      await rt.db.query(`INSERT INTO job_events (job_id, kind, attempt, holder, actor_kind, actor_id, detail, at) VALUES ($1, 'claimed', $2, $3, 'agent', 'ops-steward', $4::jsonb, $5::timestamptz)`, [j.id, j.attempts, holder, toJson({ adopted_by_hand_claim: true, unit_id: j.unit_id }), wall]);
      claimed += 1; tally(await runClaimed(rt, j, holder, { ...(opts.electReceipt !== undefined ? { electReceipt: opts.electReceipt } : {}) }));
    }
  }
  for (;;) {
    if (Date.now() - started >= budget) { budgetSpent = true; break; }
    const wall = wallClockOf(rt).now();
    const batch = await claimJobs(rt.db, holder, limit, wall);
    if (!batch.length) break;
    claimed += batch.length;
    await rt.uow.run({}, (ctx) => { for (const j of batch) ctx.events.append({ type: EVT.CLAIMED, aggregate: { kind: "job", id: j.id }, actor: OPS_STEWARD, payload: { job_id: j.id, run_id: j.run_id, cycle_code: j.cycle_code, period_key: j.period_key, unit_id: j.unit_id, holder, lease_until: j.lease_until, attempt: j.attempts } }); },
      { clock: rt.clock, commit: async (q) => { for (const j of batch) { await appendJobEvent(q, { job_id: j.id, kind: "claimed", attempt: j.attempts, holder, actor: OPS_STEWARD, at: wall, detail: { lease_until: j.lease_until, unit_id: j.unit_id } }); } await q.query(`UPDATE cycle_runs SET status = 'running' WHERE status = 'planned' AND id = ANY($1::uuid[])`, [[...new Set(batch.map((j) => j.run_id))]]); } });
    for (const j of batch) tally(await runClaimed(rt, j, holder, { ...(opts.electReceipt !== undefined ? { electReceipt: opts.electReceipt } : {}) }));
  }
  return { holder, claimed, done, failed, dead, lost, receipts: (await before()) - receiptsBefore, budget_spent: budgetSpent, ms: Date.now() - started };
}

// ───────────────────────────── the sweep's pass (Inputs and triggers; rule 10)
export interface CyclesSweepReport {
  readonly at: string;
  /** true: the pass planned nothing — the planner lock was held (`holder`), no `databaseUrl` is configured (`reason`), or the plan threw. */
  readonly skipped: boolean;
  readonly reason: string | null;
  readonly holder: string | null;
  readonly plan: PlanOutput | null;
  readonly executor: ExecutorReport | null;
  readonly runs_opened: number; readonly jobs_planned: number; readonly units_done: number; readonly units_dead: number; readonly receipts: number;
  readonly line: string;
}
export interface CyclesSweepOptions { readonly execute?: boolean; readonly drain?: "all" | "budget"; readonly planned_by?: string; readonly cycle_codes?: readonly string[]; readonly holder?: string; }
/** `cycles.plan` on the bus, then the executor when asked (`execute`, default true; `drain: "all"` for the demo step's inline drain) — never throws: a failure is logged and reported so the sweep's other passes run. */
export async function cyclesSweepPass(rt: Runtime, nowIso: string = rt.clock.now(), opts: CyclesSweepOptions = {}): Promise<CyclesSweepReport> {
  const zero = { runs_opened: 0, jobs_planned: 0, units_done: 0, units_dead: 0, receipts: 0 };
  if (!rt.databaseUrl) return { at: nowIso, skipped: true, reason: "no databaseUrl", holder: null, plan: null, executor: null, ...zero, line: "cycles: skipped (no databaseUrl for the planner lock)" };
  let plan: PlanOutput;
  try { plan = await cyclesOf(rt).plan({ as_of: nowIso, ...(opts.planned_by ? { planned_by: opts.planned_by } : {}), ...(opts.cycle_codes ? { cycle_codes: opts.cycle_codes } : {}) }); }
  catch (e) { const msg = e instanceof Error ? e.message : String(e); rt.logger?.error("cycles.plan failed", { at: nowIso, error: msg }); return { at: nowIso, skipped: true, reason: `failed: ${msg}`, holder: null, plan: null, executor: null, ...zero, line: `cycles: failed (${msg})` }; }
  if (plan.skipped) return { at: nowIso, skipped: true, reason: `planner lock held by ${plan.holder ?? "another pass"}`, holder: plan.holder, plan, executor: null, ...zero, line: `cycles ${plan.as_of_date}: skipped (planner lock held by ${plan.holder ?? "another pass"})` };
  let executor: ExecutorReport | null = null;
  if (opts.execute !== false) {
    try { executor = await runExecutor(rt, { ...(opts.holder ? { holder: opts.holder } : {}), ...(opts.drain ? { drain: opts.drain } : {}) }); }
    catch (e) { rt.logger?.error("cycles executor failed", { at: nowIso, error: e instanceof Error ? e.message : String(e) }); }
  }
  const receipts = plan.receipts_reconciled + (executor?.receipts ?? 0);
  return { at: nowIso, skipped: false, reason: null, holder: plan.holder, plan, executor, runs_opened: plan.runs_opened, jobs_planned: plan.jobs_planned, units_done: executor?.done ?? 0, units_dead: executor?.dead ?? 0, receipts,
    line: `cycles ${plan.as_of_date}: runs_opened=${plan.runs_opened} jobs_planned=${plan.jobs_planned} reclaimed=${plan.leases_reclaimed} unblocked=${plan.unblocked} requeued=${plan.requeued} overdue=${plan.overdue}${executor ? ` claimed=${executor.claimed} done=${executor.done} failed=${executor.failed} dead=${executor.dead}` : " (plan only)"} receipts=${receipts}${plan.errors.length ? ` errors=${plan.errors.length}` : ""}` };
}
