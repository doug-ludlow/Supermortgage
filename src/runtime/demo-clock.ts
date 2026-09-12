/**
 * The demo clock (docs/DEPLOY.md "The demo clock"): the hosted demo advances through days and months in minutes, so the
 * timers, statements, late charges, the daily refinance run and the borrower flows fire as they would on the wall clock.
 *
 *   OffsetClock         a kernel `Clock` = the base (system) clock + a persisted offset. The offset's history is the
 *                       append-only `demo_clock` table (0120); the current offset is the latest row. `loadDemoClock(db)`
 *                       builds it in main.ts for every mode but production, and it is the clock the Runtime is constructed
 *                       with — so the borrower API, the unit of work, the sweeps, the flows and the console all read one
 *                       instant. The clock only moves forward: a row's offset is never below the one before it.
 *                       `follow(db)` keeps a long-lived instance current: the API service runs 1..10 instances and only
 *                       the one that took the POST steps the clock, so every `serve` instance re-reads the latest row
 *                       every FOLLOW_INTERVAL_MS (one indexed `LIMIT 1` query) and the instances agree on the instant
 *                       within that interval. The one-shot modes (`sweep`, `seed-demo`) read the row once at start.
 *   advanceDemoClock    POST /v1/demo/advance { to?: ISO instant | days?: number, budget_ms?: number }. For every
 *                       America/New_York calendar day the advance crosses the clock steps to that day (noon ET, so the
 *                       UTC, ET and Phoenix civil dates agree) and runs the sweep minute — the passes in the order the
 *                       wall clock runs them (what main.ts `sweep` and POST /v1/sweep run): the borrower flows' `tick`
 *                       (every flow's scheduled pass — 4-disclosures' originationDailySweep, 8-servicing's
 *                       servicingDailySweep and the December irs_estatement ask, 10-hardship's delinquencyDailySweep,
 *                       the card expiries) and `settle`, then `Runtime.sweep()` — which itself runs the daily refinance run
 *                       (src/runtime/refi-daily.ts, when a rate feed is wired; read back through `refiDailyOutcome`, a
 *                       hook that tolerates the run's absence) and the FAKE reviewers before the breach pass — then
 *                       `settle` again, so the reactions the breaches queued have run before the step is reported; and
 *                       last steps to the target instant and runs it once more. A caller without flows (a script, a test)
 *                       gets the three runtime-level daily sweeps directly, in the flows' order; the flow-level passes
 *                       (the cards) need the flows and are reported `absent`.
 *                       Each step is one `demo_clock` row written BEFORE its passes run, so the persisted offset never
 *                       runs ahead of a day that was swept: a crash leaves the clock on the last completed day and the
 *                       next advance carries on from there. At most 400 days per advance, and at most `budget_ms` of
 *                       stepping per request (DEFAULT_ADVANCE_BUDGET_MS, under Cloud Run's default 300 s request
 *                       timeout — the deploy sets none): when the budget is spent the advance stops between steps and
 *                       answers `complete: false` with the clock on the last swept step; re-POST the same target to carry
 *                       on. A target at or before now is a no-op (no row, no pass), so a second advance to the same
 *                       instant changes nothing. Every pass is idempotent by construction (a due timer breaches once; the
 *                       daily runs re-read their facts), so a day the sweep job also happened to visit — or that two
 *                       instances stepped at once — is not double-counted.
 *   demoClockStatus     GET /v1/demo/clock: what the clock reads, the offset, the latest row.
 *
 * Nothing here hard-codes a deadline: the advance only moves the instant the registry-driven engine and the daily passes
 * already read from `runtime.clock`.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "../infra/db/client.ts";
import { systemClock, type Clock } from "../kernel/events/index.ts";
import { addDays, daysBetween, type PlainDate } from "../kernel/calendar/date.ts";
import { wallClock, zonedEpochMs } from "../kernel/calendar/zoned.ts";
import type { Runtime, SweepReport } from "./app.ts";
import { servicingDailySweep } from "./servicing.ts";
import { originationDailySweep } from "./origination.ts";
import { delinquencyDailySweep } from "./delinquency.ts";
import type { Logger } from "./log.ts";

/** The zone whose calendar days an advance crosses (the engine's own: src/kernel/timers/engine.ts). */
export const DEMO_ZONE = "America/New_York";
/** The wall time a crossed day's sweep minute runs at: its UTC date, ET date and Phoenix date are the same day. */
export const DAY_STEP_TIME = "12:00";
/** The most one advance may cover. */
export const MAX_ADVANCE_DAYS = 400;
/** How often a following instance (serve mode) re-reads the latest row. */
export const FOLLOW_INTERVAL_MS = 1_000;
/** The stepping time one POST /v1/demo/advance spends before it stops and answers `complete: false` (Cloud Run's default request timeout is 300 s). */
export const DEFAULT_ADVANCE_BUDGET_MS = 240_000;

export type DemoClockRow = { readonly id: bigint; readonly advance_id: string; readonly step: number; readonly steps: number; readonly kind: "day" | "target"; readonly offset_ms: bigint; readonly demo_now: string; readonly real_now: string; readonly actor: string; readonly created_at: string }

const LATEST = `SELECT id, advance_id, step, steps, kind, offset_ms, demo_now, real_now, actor, created_at FROM demo_clock ORDER BY id DESC LIMIT 1`;
const isUndefinedTable = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "42P01";

/** The system clock plus the persisted demo offset. `now()` is synchronous (a kernel Clock); the offset is cached in memory and re-read from the table by `refresh` (once) or `follow` (periodically). */
export class OffsetClock implements Clock {
  readonly base: Clock;
  private offsetMs: number;
  private latest: DemoClockRow | null;
  private chain: Promise<unknown> = Promise.resolve();
  private follower: ReturnType<typeof setInterval> | null = null;
  constructor(base: Clock = systemClock, latest: DemoClockRow | null = null) { this.base = base; this.latest = latest; this.offsetMs = latest ? Number(latest.offset_ms) : 0; }
  now(): string { return new Date(Date.parse(this.base.now()) + this.offsetMs).toISOString(); }
  /** Milliseconds the demo runs ahead of the base clock. */
  get offset(): number { return this.offsetMs; }
  /** The latest `demo_clock` row this instance has seen (null: the table is empty — the system clock). */
  get latestRow(): DemoClockRow | null { return this.latest; }
  /** Whether `follow` is running. */
  get following(): boolean { return this.follower !== null; }
  /** Re-read the latest row: another instance or the sweep job may have advanced the clock. Only ever moves forward. */
  async refresh(db: Queryable): Promise<DemoClockRow | null> {
    const [row] = await db.query<DemoClockRow>(LATEST);
    if (row && (this.latest === null || row.id > this.latest.id)) this.adopt(row);
    return row ?? null;
  }
  /**
   * Keep this instance current (serve mode, main.ts): every `everyMs` re-read the latest row and adopt an advance another
   * instance made, so the 1..10 API instances agree on the instant within the interval. One read at a time; a failed read
   * is logged and the next interval tries again; the timer never keeps the process alive. `stop` ends it (shutdown).
   */
  follow(db: Queryable, opts: { readonly everyMs?: number | undefined; readonly logger?: Logger | undefined } = {}): { stop(): void } {
    this.unfollow();
    let inFlight = false;
    const read = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      const before = this.latest?.id ?? null;
      try {
        const row = await this.refresh(db);
        if (row && row.id !== before && this.latest === row) opts.logger?.info("demo clock: followed", { offset_ms: this.offsetMs, demo_now: this.now(), advance_id: row.advance_id, step: row.step, of: row.steps, kind: row.kind, actor: row.actor });
      } catch (e) { opts.logger?.warn("demo clock: follow read failed", { error: e instanceof Error ? e.message : String(e) }); }
      finally { inFlight = false; }
    };
    const timer = setInterval(() => { void read(); }, opts.everyMs ?? FOLLOW_INTERVAL_MS);
    timer.unref();
    this.follower = timer;
    return { stop: () => this.unfollow() };
  }
  /** Stop following (a no-op when not following). */
  unfollow(): void { if (this.follower) { clearInterval(this.follower); this.follower = null; } }
  private adopt(row: DemoClockRow): void { this.latest = row; this.offsetMs = Math.max(this.offsetMs, Number(row.offset_ms)); }
  /** Persist one step (the row is the receipt) and apply it: from here `now()` reads `atIso` (and moves on with the base clock). */
  async step(db: Queryable, atIso: string, meta: { advance_id: string; step: number; steps: number; kind: "day" | "target"; actor: string }): Promise<DemoClockRow> {
    const realNow = this.base.now();
    const offsetMs = Math.max(this.offsetMs, Date.parse(atIso) - Date.parse(realNow));
    const [row] = await db.query<DemoClockRow>(`INSERT INTO demo_clock (advance_id, step, steps, kind, offset_ms, demo_now, real_now, actor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, advance_id, step, steps, kind, offset_ms, demo_now, real_now, actor, created_at`,
      [meta.advance_id, meta.step, meta.steps, meta.kind, String(offsetMs), new Date(Date.parse(realNow) + offsetMs).toISOString(), realNow, meta.actor]);
    this.adopt(row!);
    return row!;
  }
  /** One advance at a time per instance: a concurrent call waits, then finds the target at or before now and is a no-op. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> { const next = this.chain.then(fn, fn); this.chain = next.catch(() => undefined); return next; }
}

/** The demo clock over `db`: the latest `demo_clock` row's offset, or zero when the table is empty (or, before 0120 has been applied, absent — logged). */
export async function loadDemoClock(db: Queryable, opts: { readonly base?: Clock; readonly logger?: Logger } = {}): Promise<OffsetClock> {
  try {
    const [row] = await db.query<DemoClockRow>(LATEST);
    const clock = new OffsetClock(opts.base ?? systemClock, row ?? null);
    if (row) opts.logger?.info("demo clock", { offset_ms: Number(row.offset_ms), demo_now: clock.now(), advance_id: row.advance_id, set_at: row.created_at });
    return clock;
  } catch (e) {
    if (!isUndefinedTable(e)) throw e;
    opts.logger?.warn("demo clock: demo_clock table missing (db/migrations/0120 not applied) — running on the system clock");
    return new OffsetClock(opts.base ?? systemClock, null);
  }
}

// ---------------------------------------------------------------- the plan: one step per calendar day crossed, then the target
export interface PlannedStep { readonly at: string; readonly date: PlainDate; readonly kind: "day" | "target" }

/** The instants an advance from `fromIso` to `toIso` visits: noon ET of every ET calendar day strictly between the two dates plus the target itself; empty when the target is at or before `fromIso`. Throws past `MAX_ADVANCE_DAYS`. */
export function planSteps(fromIso: string, toIso: string): PlannedStep[] {
  const fromMs = Date.parse(fromIso); const toMs = Date.parse(toIso);
  if (!Number.isFinite(toMs)) throw new RangeError(`to must be an ISO instant, got ${JSON.stringify(toIso)}`);
  if (toMs <= fromMs) return [];
  const from = wallClock(fromMs, DEMO_ZONE).date; const to = wallClock(toMs, DEMO_ZONE).date;
  const days = daysBetween(from, to);
  if (days > MAX_ADVANCE_DAYS) throw new RangeError(`a single advance covers at most ${MAX_ADVANCE_DAYS} days (${from} → ${to} is ${days})`);
  const steps: PlannedStep[] = [];
  for (let i = 1; i < days; i++) { const date = addDays(from, i); steps.push({ at: new Date(zonedEpochMs(date, DAY_STEP_TIME, DEMO_ZONE)).toISOString(), date, kind: "day" }); }
  steps.push({ at: new Date(toMs).toISOString(), date: to, kind: "target" });
  return steps;
}

/** The request body of POST /v1/demo/advance: exactly one of `to` (an ISO instant) and `days` (a positive number of 24-hour days from the demo's now). */
export function targetOf(nowIso: string, input: { readonly to?: unknown; readonly days?: unknown }): string {
  const hasTo = input.to !== undefined && input.to !== null; const hasDays = input.days !== undefined && input.days !== null;
  if (hasTo === hasDays) throw new RangeError("give exactly one of to (an ISO instant) or days (a positive number)");
  if (hasTo) { if (typeof input.to !== "string" || !Number.isFinite(Date.parse(input.to))) throw new RangeError(`to must be an ISO instant, got ${JSON.stringify(input.to)}`); return new Date(Date.parse(input.to)).toISOString(); }
  const days = typeof input.days === "string" ? Number(input.days) : input.days;
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) throw new RangeError(`days must be a positive number, got ${JSON.stringify(input.days)}`);
  if (days > MAX_ADVANCE_DAYS) throw new RangeError(`a single advance covers at most ${MAX_ADVANCE_DAYS} days, got ${days}`);
  return new Date(Date.parse(nowIso) + Math.round(days * 86_400_000)).toISOString();
}

/** The body's optional `budget_ms`: a non-negative number of milliseconds of stepping (absent → DEFAULT_ADVANCE_BUDGET_MS; 0 → exactly one step). */
export function budgetOf(input: { readonly budget_ms?: unknown }): number {
  if (input.budget_ms === undefined || input.budget_ms === null) return DEFAULT_ADVANCE_BUDGET_MS;
  const ms = typeof input.budget_ms === "string" ? Number(input.budget_ms) : input.budget_ms;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw new RangeError(`budget_ms must be a non-negative number of milliseconds, got ${JSON.stringify(input.budget_ms)}`);
  return ms;
}

// ---------------------------------------------------------------- the passes one step runs (the sweep minute)
/** What the borrower router hands over: its BorrowerFlows (`tick` runs every flow's scheduled pass; `settle` waits for the reactions it queued). */
export interface TickableFlows { tick(nowIso: string): Promise<void>; settle?(): Promise<void> }
export interface DemoAdvanceDeps {
  readonly runtime: Runtime;
  readonly clock: OffsetClock;
  /** The 32.x flows when the borrower router is wired (server.ts); undefined runs the three runtime-level daily sweeps directly. */
  readonly flows?: TickableFlows | undefined;
  readonly logger?: Logger | undefined;
  /** Recorded on every `demo_clock` row, as `kind:id`. */
  readonly actor?: string | undefined;
}
export interface StepReport {
  readonly at: string; readonly date: PlainDate; readonly kind: "day" | "target";
  readonly refi_daily: HookOutcome;
  /** "ticked": the flows' tick ran and its reactions settled; "absent": no flows (the sweeps below ran directly); "failed": the tick or the settle threw (logged). */
  readonly flows: "ticked" | "absent" | "failed";
  readonly servicing_sweep: { loans: number; posted: number; late_charge_runs: number; errors: number } | null;
  readonly origination_sweep: { deemed: number; warned: number; expired: number } | null;
  readonly delinquency_sweep: { loans: number; windows_opened: number } | null;
  readonly sweep: { due: number; breaches: number } | { error: string };
  readonly ms: number;
}
export interface AdvanceReport {
  readonly advanced: boolean;
  /** Every planned step ran. false: the budget ran out first — the clock stands on the last swept step; re-POST the same target to carry on. */
  readonly complete: boolean;
  readonly advance_id: string | null;
  readonly from: string;
  readonly requested_to: string;
  /** What the clock reads when the advance returns (the target, unless the budget stopped it earlier or the demo clock had already passed it). */
  readonly to: string;
  /** Calendar days (ET) actually crossed. */
  readonly days_crossed: number;
  readonly steps: readonly StepReport[];
  /** Planned steps the budget left unrun (0 when complete). */
  readonly steps_remaining: number;
  readonly budget_ms: number;
  readonly due: number;
  readonly breaches: number;
  readonly offset_ms: number;
}

/**
 * HOOK — the daily refinance run. src/runtime/refi-daily.ts (`refiDailyRun`: 20.4's rate sheet for the day, then 20.1's
 * trigger, once per calendar day at/after 06:30 ET) is run by `Runtime.sweep()` itself when a rate feed is wired
 * (src/runtime/app.ts), so a step never calls it twice; this reads its report back off the sweep's answer without a
 * static dependency on that field, so the advance works whether or not the run exists in the tree: "absent" when the
 * sweep reports no such pass at all, "not_wired" when no rate feed is configured, "ran" when the day's run completed,
 * "skipped" / "failed" with the run's own reason otherwise.
 */
export type HookOutcome = "ran" | "absent" | "not_wired" | `skipped: ${string}` | `failed: ${string}`;
export function refiDailyOutcome(sweep: SweepReport): HookOutcome {
  const refi = (sweep as { refi?: { ran?: unknown; reason?: unknown } | null }).refi;
  if (refi === undefined) return "absent";
  if (refi === null) return "not_wired";
  if (refi.ran === true) return "ran";
  const reason = typeof refi.reason === "string" ? refi.reason : "no reason given";
  return reason.startsWith("failed") ? `failed: ${reason.replace(/^failed:?\s*/, "")}` : `skipped: ${reason}`;
}

/**
 * One sweep minute at `step.at`, in the order the wall clock runs it (main.ts `sweep`, POST /v1/sweep): the flows' tick and
 * settle (or, without flows, the three runtime-level daily sweeps in the flows' order), then Runtime.sweep (the refinance
 * daily run and the FAKE reviewers when wired, then the breach pass), then settle again so the reactions the breaches
 * queued post-commit have run before the step is reported.
 */
async function runSweepMinute(deps: DemoAdvanceDeps, step: PlannedStep): Promise<StepReport> {
  const started = Date.now(); const { runtime, logger } = deps;
  let flows: StepReport["flows"] = "absent"; let servicing: StepReport["servicing_sweep"] = null; let origination: StepReport["origination_sweep"] = null; let delinquency: StepReport["delinquency_sweep"] = null;
  const failed = (what: string, e: unknown): "failed" => { logger?.error(`demo clock: flows ${what} failed`, { at: step.at, error: e instanceof Error ? e.message : String(e) }); return "failed"; };
  if (deps.flows) {
    try { await deps.flows.tick(step.at); await deps.flows.settle?.(); flows = "ticked"; } catch (e) { flows = failed("tick", e); }
  } else {
    const o = await originationDailySweep(runtime, step.at); origination = { deemed: o.deemed.length, warned: o.warned.length, expired: o.expired.length };
    const s = await servicingDailySweep(runtime, step.at); servicing = { loans: s.loans, posted: s.posted.length, late_charge_runs: s.late_charge_runs.length, errors: s.errors.length };
    for (const err of s.errors) logger?.warn("demo clock: servicing sweep error", { at: step.at, ...err });
    const d = await delinquencyDailySweep(runtime, step.at); delinquency = { loans: d.loans.length, windows_opened: d.loans.reduce((a, l) => a + l.windows_opened.length, 0) };
  }
  let sweep: StepReport["sweep"]; let refi: HookOutcome = "absent";
  try { const r: SweepReport = await runtime.sweep(step.at); sweep = { due: r.due, breaches: r.breaches.length }; refi = refiDailyOutcome(r); }
  catch (e) { sweep = { error: e instanceof Error ? e.message : String(e) }; logger?.error("demo clock: sweep failed", { at: step.at, error: sweep.error }); }
  if (deps.flows?.settle && flows !== "failed") { try { await deps.flows.settle(); } catch (e) { flows = failed("settle", e); } }
  return { at: step.at, date: step.date, kind: step.kind, refi_daily: refi, flows, servicing_sweep: servicing, origination_sweep: origination, delinquency_sweep: delinquency, sweep, ms: Date.now() - started };
}

/** POST /v1/demo/advance — see the header. Throws RangeError on a bad body or an advance past the cap; a target at or before now returns `advanced: false`. */
export async function advanceDemoClock(deps: DemoAdvanceDeps, input: { readonly to?: unknown; readonly days?: unknown; readonly budget_ms?: unknown }): Promise<AdvanceReport> {
  const { runtime, clock, logger } = deps;
  return clock.exclusive(async () => {
    await clock.refresh(runtime.db);
    const from = clock.now();
    const requested = targetOf(from, input);
    const budgetMs = budgetOf(input);
    const plan = planSteps(from, requested);
    if (!plan.length) return { advanced: false, complete: true, advance_id: null, from, requested_to: requested, to: from, days_crossed: 0, steps: [], steps_remaining: 0, budget_ms: budgetMs, due: 0, breaches: 0, offset_ms: clock.offset };
    const advanceId = randomUUID(); const actor = deps.actor ?? "system:demo-clock";
    const fromDate = wallClock(Date.parse(from), DEMO_ZONE).date;
    logger?.info("demo clock: advancing", { advance_id: advanceId, from, to: requested, days: daysBetween(fromDate, plan[plan.length - 1]!.date), steps: plan.length, budget_ms: budgetMs, actor });
    const started = Date.now();
    const steps: StepReport[] = []; let due = 0; let breaches = 0;
    for (let i = 0; i < plan.length; i++) {
      // the budget: stop between steps (never inside one) once it is spent — the first step always runs, so a request always makes progress
      if (i > 0 && Date.now() - started >= budgetMs) { logger?.info("demo clock: budget spent", { advance_id: advanceId, budget_ms: budgetMs, elapsed_ms: Date.now() - started, ran: i, of: plan.length, at: clock.now(), requested_to: requested }); break; }
      const planned = plan[i]!;
      // the base clock kept moving while the earlier passes ran: never step backwards
      const at = Date.parse(planned.at) > Date.parse(clock.now()) ? planned.at : clock.now();
      await clock.step(runtime.db, at, { advance_id: advanceId, step: i + 1, steps: plan.length, kind: planned.kind, actor });
      const report = await runSweepMinute(deps, { ...planned, at });
      steps.push(report);
      if ("due" in report.sweep) { due += report.sweep.due; breaches += report.sweep.breaches; }
      logger?.info("demo clock: step", { advance_id: advanceId, step: i + 1, of: plan.length, at, kind: planned.kind, refi_daily: report.refi_daily, flows: report.flows, sweep: report.sweep, ms: report.ms });
    }
    const daysCrossed = daysBetween(fromDate, steps[steps.length - 1]!.date);
    return { advanced: true, complete: steps.length === plan.length, advance_id: advanceId, from, requested_to: requested, to: clock.now(), days_crossed: daysCrossed, steps, steps_remaining: plan.length - steps.length, budget_ms: budgetMs, due, breaches, offset_ms: clock.offset };
  });
}

export interface DemoClockStatus { readonly now: string; readonly real_now: string; readonly offset_ms: number; readonly offset_days: number; readonly date: PlainDate; readonly zone: string; readonly rows: number; readonly latest: DemoClockRow | null; readonly following: boolean; readonly max_advance_days: number; readonly default_budget_ms: number }
/** GET /v1/demo/clock — refreshed from the table first, so an advance another instance wrote is reported. */
export async function demoClockStatus(db: Db, clock: OffsetClock): Promise<DemoClockStatus> {
  const latest = await clock.refresh(db);
  const [c] = await db.query<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM demo_clock`);
  const now = clock.now();
  return { now, real_now: clock.base.now(), offset_ms: clock.offset, offset_days: Math.round((clock.offset / 86_400_000) * 100) / 100, date: wallClock(Date.parse(now), DEMO_ZONE).date, zone: DEMO_ZONE, rows: Number(c?.c ?? 0n), latest, following: clock.following, max_advance_days: MAX_ADVANCE_DAYS, default_budget_ms: DEFAULT_ADVANCE_BUDGET_MS };
}
