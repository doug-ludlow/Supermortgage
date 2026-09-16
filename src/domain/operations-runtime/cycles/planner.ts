/**
 * §35.3 rules 1, 3, 4, 10, 11 — the planner. `planCycles(rt, { as_of, planned_by })` takes `pg_try_advisory_lock(35_003)`
 * on a dedicated client (rule 1: refused → `cycles.plan.skipped{holder}` and return; the lock dies with the client), refreshes
 * the demo clock (rule 10), upserts the code registry into `cycle_registry` (rule 2), and for every active def derives the
 * window's period keys and units: one `cycle_runs` row per (cycle, period) `ON CONFLICT DO NOTHING` (+ `cycle.run.opened`,
 * arming SM_CYCLE_RUN_STALLED_1D on the run), one `jobs` row per unit `ON CONFLICT (idempotency_key) DO NOTHING`, `blocked`
 * when a dependency is unmet (rule 3, PLAN_IS_IDEMPOTENT — the same window planned twice adds no row and no event). A run
 * with no unit is completed in the same pass with a receipt of zeros (the `month_end` def's receipt is `ledger.month.ended`,
 * rule 4). Then: expired leases reclaimed (`job.lease.expired`), blocked jobs whose dependencies arrived unblocked, `failed`
 * jobs past `run_after` re-queued, receipts reconciled (rule 5's crash window), `next_expected_by` / `overdue_since` on every
 * active row (rule 11, NO_SILENT_CYCLE), and one `cycles.plan.run_completed` (SM_CYCLE_PLANNER_DAILY). Each step is its own
 * global unit of work and idempotent, so a pass killed mid-way leaves consistent rows for the next minute.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { plainDate as D, addDays, type PlainDate } from "../../../kernel/calendar/date.ts";
import { fannieEt } from "../../../kernel/calendar/business.ts";
import { wallClock, zonedEpochMs } from "../../../kernel/calendar/zoned.ts";
import { CYCLES_VERSION, EV, OPS_STEWARD, PLANNER_LOCK_KEY, defaultPeriods, idempotencyKey, periodEnd, priorMonthKey, type CycleDef, type CycleWindow, type Dependency, type Unit } from "./cycles.ts";
import { jobEvent, type JobRow, JOB_COLS } from "./jobs.ts";
import { emitReceipt } from "./receipt.ts";

const ET = "America/New_York";

export interface PlanOptions {
  /** The planned instant (rule 10's `as_of`, never `clock.now()` read twice); default the runtime clock. */
  readonly as_of?: string;
  /** `sweep:<sweep_run_id>` | `demo:<advance_id>` | `human:<staff_user_id>` | `agent:<id>`. */
  readonly planned_by: string;
  readonly cycle_codes?: readonly string[] | null;
  readonly holder?: string;
}
export interface PlanReport {
  readonly run_id: string; readonly as_of: string; readonly as_of_date: PlainDate; readonly holder: string; readonly planned_by: string;
  readonly skipped: boolean; readonly skipped_reason: string | null;
  readonly period_keys: string[]; readonly runs_opened: number; readonly jobs_planned: number; readonly jobs_blocked: number; readonly runs_completed_empty: number;
  readonly leases_reclaimed: number; readonly unblocked: number; readonly requeued: number; readonly receipts_reconciled: number; readonly overdue: string[]; readonly month_ended: string | null;
  readonly errors: { cycle_code: string; error_class: string; error: string }[]; readonly duration_ms: number;
}

/** The n-th Fannie Mae business day after `d` (IRM 2-01: BD1 is the first business day of the following month). */
export function nextBusinessDay(d: PlainDate, n: number): PlainDate { let x = d; for (let k = n; k > 0; k--) { x = addDays(x, 1); while (!fannieEt.isBusinessDay(x)) x = addDays(x, 1); } return x; }
/** Rule 11 / the registry's `expected_by_rule`: `same_day HH:MM ET` (the period's day at HH:MM), `BDn HH:MM ET` (n Fannie business days after the period end), `+n calendar_days` (23:59 ET); anything else reads as `same_day 23:59 ET`. */
export function expectedByMs(rule: string, periodKey: string): number {
  const end = periodEnd(periodKey);
  let m = /^same_day\s+(\d{2}:\d{2})\s*ET$/i.exec(rule.trim());
  if (m) return zonedEpochMs(end, m[1]!, ET);
  m = /^BD(\d+)\s+(\d{2}:\d{2})\s*ET$/i.exec(rule.trim());
  if (m) return zonedEpochMs(nextBusinessDay(end, Number(m[1])), m[2]!, ET);
  m = /^\+(\d+)\s+calendar_days$/i.exec(rule.trim());
  if (m) return zonedEpochMs(addDays(end, Number(m[1])), "23:59", ET);
  return zonedEpochMs(end, "23:59", ET);
}

/** A dependency is present when the named cycle's run for the mapped period has a receipt, or when an event of the named type names the unit's period (its first `:`-segment). */
export async function dependencySatisfied(q: Queryable, dep: Dependency, unit: { period_key: string }, w: CycleWindow): Promise<boolean> {
  if ("event" in dep) {
    const head = unit.period_key.split(":")[0]!;
    return (await q.query(`SELECT 1 FROM loan_events WHERE type = $1 AND payload->>$2 = $3 LIMIT 1`, [dep.event, dep.key, head])).length > 0;
  }
  const period = dep.period === "as_of_date" ? w.as_of_date : dep.period === "period_end" ? periodEnd(unit.period_key) : dep.period === "bd1_next" ? nextBusinessDay(periodEnd(unit.period_key), 1) : unit.period_key.split(":")[0]!;
  return (await q.query(`SELECT 1 FROM cycle_receipts WHERE cycle_code = $1 AND (period_key = $2 OR period_key LIKE $2 || ':%') LIMIT 1`, [dep.cycle_code, period])).length > 0;
}
async function depsSatisfied(q: Queryable, def: CycleDef, unit: { period_key: string }, w: CycleWindow): Promise<boolean> {
  for (const d of def.depends_on) if (!(await dependencySatisfied(q, d, unit, w))) return false;
  return true;
}

/** Rule 2: the code registry's projection — upsert every def (runtime counters untouched); a code no longer exported goes `retired`. */
export async function upsertRegistry(q: Queryable, defs: readonly CycleDef[], now: string): Promise<void> {
  for (const d of defs) {
    await q.query(`INSERT INTO cycle_registry (cycle_code, owner_process, owner_agent, unit_scope, schedule, period_grammar, unit_selector, unit_runner, receipt_event, depends_on, serves_timer, escalation_role, expected_by_rule, registry_version, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
      ON CONFLICT (cycle_code) DO UPDATE SET owner_process = EXCLUDED.owner_process, owner_agent = EXCLUDED.owner_agent, unit_scope = EXCLUDED.unit_scope, schedule = EXCLUDED.schedule, period_grammar = EXCLUDED.period_grammar, unit_selector = EXCLUDED.unit_selector, unit_runner = EXCLUDED.unit_runner, receipt_event = EXCLUDED.receipt_event, depends_on = EXCLUDED.depends_on, serves_timer = EXCLUDED.serves_timer, escalation_role = EXCLUDED.escalation_role, expected_by_rule = EXCLUDED.expected_by_rule, registry_version = EXCLUDED.registry_version, updated_at = EXCLUDED.updated_at,
        status = CASE WHEN cycle_registry.status = 'retired' THEN 'active' ELSE cycle_registry.status END`,
      [d.cycle_code, d.owner_process, d.owner_agent, d.unit_scope, d.schedule, d.period_grammar, d.selector, d.runner, d.receipt_event, JSON.stringify(d.depends_on), d.serves_timer, d.escalation_role, d.expected_by, CYCLES_VERSION, now]);
  }
  await q.query(`UPDATE cycle_registry SET status = 'retired', updated_at = $2 WHERE status <> 'retired' AND NOT (cycle_code = ANY($1::text[]))`, [defs.map((d) => d.cycle_code), now]);
}

/** Rule 3: unblock every `blocked` job whose dependencies are now present; returns the count. */
export async function unblockJobs(rt: Runtime, w: CycleWindow, defs: readonly CycleDef[]): Promise<number> {
  let n = 0;
  await rt.uow.run({}, async (ctx) => {
    const q = ctx.q!;
    const blocked = await q.query<JobRow>(`SELECT ${JOB_COLS} FROM jobs WHERE status = 'blocked' ORDER BY created_at FOR UPDATE SKIP LOCKED`);
    for (const j of blocked) {
      const def = defs.find((d) => d.cycle_code === j.cycle_code); if (!def) continue;
      if (!(await depsSatisfied(q, def, j, w))) continue;
      await q.query(`UPDATE jobs SET status = 'queued', depends_on_satisfied = true WHERE id = $1`, [j.id]);
      await jobEvent(q, j.id, "unblocked", { actor: OPS_STEWARD, detail: { as_of: w.as_of } });
      n += 1;
    }
  }, { clock: rt.clock });
  return n;
}

export async function planCycles(rt: Runtime, o: PlanOptions): Promise<PlanReport> {
  const t0 = Date.now();
  const holder = o.holder ?? `${rt.instanceId}:planner`;
  const runId = randomUUID();
  // rule 10: refresh the demo clock first so the sweep job never plans a day the API has advanced past
  const clock = rt.clock as { refresh?: (db: Queryable) => Promise<unknown> };
  if (typeof clock.refresh === "function") await clock.refresh(rt.db);
  const asOf = o.as_of ?? rt.clock.now();
  const wc = wallClock(Date.parse(asOf), ET);
  const w: CycleWindow = { as_of: asOf, as_of_date: wc.date };
  const hhmm = `${String(wc.hour).padStart(2, "0")}:${String(wc.minute).padStart(2, "0")}`;
  const base = { run_id: runId, as_of: asOf, as_of_date: w.as_of_date, holder, planned_by: o.planned_by, period_keys: [] as string[], runs_opened: 0, jobs_planned: 0, jobs_blocked: 0, runs_completed_empty: 0, leases_reclaimed: 0, unblocked: 0, requeued: 0, receipts_reconciled: 0, overdue: [] as string[], month_ended: null as string | null, errors: [] as PlanReport["errors"] };
  // rule 1: one planner at a time — the session-level lock on a dedicated client, never a table row
  const client = await rt.db.dedicated();
  let got = false;
  try {
    got = (await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [PLANNER_LOCK_KEY]))[0]?.ok === true;
    if (!got) {
      await rt.uow.run({}, (ctx) => ctx.events.append({ type: EV.plan_skipped, aggregate: { kind: "planner_run", id: runId }, actor: OPS_STEWARD, payload: { run_id: runId, holder, as_of_date: w.as_of_date, planned_by: o.planned_by, lock_key: PLANNER_LOCK_KEY, reason: "lock_held" } }), { clock: rt.clock });
      return { ...base, skipped: true, skipped_reason: "lock_held", duration_ms: Date.now() - t0 };
    }
    const defs = rt.cycles.defs.filter((d) => !o.cycle_codes || o.cycle_codes.includes(d.cycle_code));
    const now = rt.clock.now();
    // the demo offset the run is planned under (0 in production); the table is absent before 0120
    const demoOffset = await rt.db.query<{ offset_ms: string }>(`SELECT offset_ms::text AS offset_ms FROM demo_clock ORDER BY id DESC LIMIT 1`).then((r) => r[0]?.offset_ms ?? "0").catch(() => "0");
    await rt.db.tx((q) => upsertRegistry(q, rt.cycles.defs, now));
    const active = new Set((await rt.db.query<{ cycle_code: string }>(`SELECT cycle_code FROM cycle_registry WHERE status = 'active'`)).map((r) => r.cycle_code));
    const priorityOf = new Map(rt.cycles.defs.map((d, i) => [d.cycle_code, 100 + i]));
    // the first planner pass on this database: a month grammar (month_end, metro2_monthly, …) never back-fills a month the planner never saw — rule 4's "first pass whose as_of civil date is in a new month" presumes a pass in the old one (a fresh October deploy closes September only if a pass ran on or before its last day)
    const firstPassDate = (await rt.db.query<{ d: string | null }>(`SELECT min(payload->>'as_of_date') AS d FROM loan_events WHERE type = $1`, [EV.plan_completed]))[0]?.d ?? w.as_of_date;
    // rule 3: plan every active def — one run per (cycle, period), one job per unit, idempotent
    for (const def of defs) {
      if (!active.has(def.cycle_code)) continue;
      if (def.not_before && hhmm < def.not_before) continue;
      // a def whose runner has not landed (35.2, 35.4–35.12's) is registered, visible and named `runner_missing` on its row — never planned into a unit that could only die; `overdue_since` names it (NO_SILENT_CYCLE)
      if (def.runner !== "none" && !rt.cycles.runners[def.runner]) { await rt.db.query(`UPDATE cycle_registry SET last_error_class = 'runner_missing', updated_at = $2 WHERE cycle_code = $1 AND last_error_class IS DISTINCT FROM 'runner_missing'`, [def.cycle_code, now]); continue; }
      let units: Unit[];
      try {
        const selector = rt.cycles.selectors[def.selector];
        if (!selector) throw new RangeError(`no selector ${def.selector}`);
        units = await Promise.race([selector(rt.db, w), new Promise<Unit[]>((_r, rej) => setTimeout(() => rej(new RangeError("selector_timeout")), 30_000).unref())]);
      } catch (e) {
        // edge case: a selector that fails is skipped for this pass; the registry row names the class and `overdue_since` will name the cycle if it keeps failing
        const msg = e instanceof Error ? e.message : String(e); const cls = msg === "selector_timeout" ? "selector_timeout" : "selector_error";
        base.errors.push({ cycle_code: def.cycle_code, error_class: cls, error: msg.slice(0, 500) });
        await rt.db.query(`UPDATE cycle_registry SET last_error_class = $2, updated_at = $3 WHERE cycle_code = $1`, [def.cycle_code, cls, now]).catch(() => undefined);
        continue;
      }
      const periods = [...new Set([...defaultPeriods(def, w).filter((k) => def.period_grammar !== "month" || periodEnd(k) >= D(firstPassDate)), ...units.map((u) => u.period_key)])];
      for (const periodKey of periods) {
        const emptyRun = await rt.uow.run({}, async (ctx) => {
          const q = ctx.q!;
          const inserted = await q.query<{ id: string }>(`INSERT INTO cycle_runs (id, cycle_code, period_key, as_of_date, planned_by, opened_at, units_total, status, demo_offset_ms) VALUES ($1, $2, $3, $4::date, $5, $6, 0, 'planned', $7) ON CONFLICT (cycle_code, period_key) DO NOTHING RETURNING id`, [randomUUID(), def.cycle_code, periodKey, w.as_of_date, o.planned_by, now, demoOffset]);
          const [run] = await q.query<{ id: string; status: string; units_total: number }>(`SELECT id, status, units_total FROM cycle_runs WHERE cycle_code = $1 AND period_key = $2 FOR UPDATE`, [def.cycle_code, periodKey]);
          if (!run || run.status === "completed" || run.status === "cancelled") return null;
          let added = 0;
          for (const u of units.filter((x) => x.period_key === periodKey)) {
            const blocked = !(await depsSatisfied(q, def, u, w));
            const row = await q.query<{ id: string }>(`INSERT INTO jobs (id, run_id, cycle_code, period_key, unit_id, loan_id, application_id, priority, depends_on_satisfied, status, idempotency_key, input) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
              [randomUUID(), run.id, def.cycle_code, periodKey, u.unit_id, u.loan_id ?? null, u.application_id ?? null, u.priority ?? priorityOf.get(def.cycle_code) ?? 100, !blocked, blocked ? "blocked" : "queued", idempotencyKey(def.cycle_code, periodKey, u.unit_id), JSON.stringify(u.input ?? {})]);
            if (!row.length) continue;
            added += 1; if (blocked) base.jobs_blocked += 1;
            await jobEvent(q, row[0]!.id, "planned", { actor: OPS_STEWARD, detail: { period_key: periodKey, as_of: asOf, planned_by: o.planned_by, blocked } });
            if (blocked) await jobEvent(q, row[0]!.id, "blocked", { actor: OPS_STEWARD, detail: { depends_on: def.depends_on } });
          }
          base.jobs_planned += added;
          const [total] = await q.query<{ c: number }>(`SELECT count(*)::int AS c FROM jobs WHERE run_id = $1`, [run.id]);
          if (added) await q.query(`UPDATE cycle_runs SET units_total = $2 WHERE id = $1`, [run.id, total!.c]);
          if (inserted.length) {
            base.runs_opened += 1; base.period_keys.push(`${def.cycle_code}:${periodKey}`);
            ctx.events.append({ type: EV.run_opened, aggregate: { kind: "cycle_run", id: run.id }, actor: OPS_STEWARD, payload: { run_id: run.id, cycle_code: def.cycle_code, period_key: periodKey, as_of_date: w.as_of_date, units_total: total!.c, opened_at: now, planned_by: o.planned_by, demo_offset_ms: Number(demoOffset) } });
          }
          return total!.c === 0 ? run.id : null;
        }, { clock: rt.clock });
        // edge case: units_total = 0 → the run is opened and completed in the same planner pass with a receipt of zeros (the day's evidence that the cycle looked)
        if (emptyRun.result && (await emitReceipt(rt, emptyRun.result, `planner:${emptyRun.result}`))) { base.runs_completed_empty += 1; if (def.cycle_code === "month_end") base.month_ended = periodKey; }
      }
    }
    // rule 3: reclaim expired leases (wall clock) — the attempt already counted at the claim
    await rt.uow.run({}, async (ctx) => {
      const q = ctx.q!;
      const expired = await q.query<{ id: string; lease_holder: string | null; lease_until: string; attempts: number }>(`WITH x AS (SELECT id, lease_holder, lease_until, attempts FROM jobs WHERE status = 'running' AND lease_until < now() FOR UPDATE SKIP LOCKED) UPDATE jobs j SET status = 'queued', lease_holder = NULL, lease_until = NULL FROM x WHERE j.id = x.id RETURNING x.id, x.lease_holder, x.lease_until::text AS lease_until, x.attempts`);
      for (const j of expired) {
        await jobEvent(q, j.id, "lease_expired", { attempt: j.attempts, holder: j.lease_holder, actor: OPS_STEWARD });
        ctx.events.append({ type: EV.lease_expired, aggregate: { kind: "job", id: j.id }, actor: OPS_STEWARD, payload: { job_id: j.id, holder: j.lease_holder, lease_until: j.lease_until, attempt: j.attempts } });
      }
      base.leases_reclaimed = expired.length;
      // rule 7: a `failed` job whose run_after has passed is queued again
      base.requeued = (await q.query(`UPDATE jobs SET status = 'queued' WHERE status = 'failed' AND run_after <= now() RETURNING id`)).length;
    }, { clock: rt.clock });
    base.unblocked = await unblockJobs(rt, w, rt.cycles.defs);
    // rule 5: reconcile — every open run whose counters are full and no receipt row (the crash between the unit's commit and the receipt transaction)
    const full = await rt.db.query<{ id: string }>(`SELECT r.id FROM cycle_runs r WHERE r.status IN ('planned', 'running') AND r.units_done + r.units_dead + r.units_skipped >= r.units_total AND r.units_dead = 0 AND NOT EXISTS (SELECT 1 FROM cycle_receipts c WHERE c.run_id = r.id) ORDER BY r.opened_at`);
    for (const r of full) if (await emitReceipt(rt, r.id, `planner:${r.id}`)) base.receipts_reconciled += 1;
    // rule 11: next_expected_by / overdue_since on every active row (NO_SILENT_CYCLE). The expectation is the grammar's own period (a day cycle's day, a month cycle's prior month — whatever units the day held), so a unit-driven cycle (remittance, ledger_period_close, …) is measured on its calendar too; a receipt for the period or for any of its `<period>:<unit>` keys counts. A cycle whose grammar has no calendar (billing_cycle, tax_year, event) is clocked by its owner's timer, not here. A paused row is never overdue (open question 5); a def whose runner has not landed is the registry's `runner_missing` finding, not an overdue clock.
    const nowMs = Date.parse(asOf);
    const firstPass = (await rt.db.query<{ d: string | null }>(`SELECT min(payload->>'as_of_date') AS d FROM loan_events WHERE type = $1`, [EV.plan_completed]))[0]?.d ?? null;
    const grammarPeriods = (def: CycleDef, win: CycleWindow): string[] => (def.period_grammar === "day" ? [win.as_of_date] : def.period_grammar === "month" ? [priorMonthKey(win.as_of_date)] : []);
    const yesterday: CycleWindow = { as_of: asOf, as_of_date: addDays(w.as_of_date, -1) };
    for (const def of rt.cycles.defs) {
      if (!active.has(def.cycle_code)) continue;
      const current = grammarPeriods(def, w)[0] ?? null;
      const runnerMissing = def.runner !== "none" && !rt.cycles.runners[def.runner];
      const candidates = runnerMissing || !firstPass ? [] : [...new Set([...grammarPeriods(def, w), ...grammarPeriods(def, yesterday)])].filter((k) => periodEnd(k) >= D(firstPass));
      const due = candidates.filter((k) => expectedByMs(def.expected_by, k) <= nowMs).sort((a, b) => expectedByMs(def.expected_by, b) - expectedByMs(def.expected_by, a))[0] ?? null;
      let overdue = false;
      if (due) overdue = (await rt.db.query(`SELECT 1 FROM cycle_receipts WHERE cycle_code = $1 AND (period_key = $2 OR period_key LIKE $2 || ':%') LIMIT 1`, [def.cycle_code, due])).length === 0;
      await rt.db.query(`UPDATE cycle_registry SET next_period_key = $2, next_expected_by = $3, overdue_since = CASE WHEN $4::boolean THEN coalesce(overdue_since, $5::timestamptz) ELSE NULL END, updated_at = $5 WHERE cycle_code = $1`, [def.cycle_code, current, current ? new Date(expectedByMs(def.expected_by, current)).toISOString() : null, overdue, asOf]);
      if (overdue) base.overdue.push(def.cycle_code);
    }
    const durationMs = Date.now() - t0;
    await rt.uow.run({}, (ctx) => ctx.events.append({ type: EV.plan_completed, aggregate: { kind: "planner_run", id: runId }, actor: OPS_STEWARD, payload: { run_id: runId, as_of_date: w.as_of_date, as_of: asOf, planned_by: o.planned_by, holder, period_keys: base.period_keys, runs_opened: base.runs_opened, jobs_planned: base.jobs_planned, leases_reclaimed: base.leases_reclaimed, receipts_reconciled: base.receipts_reconciled, unblocked: base.unblocked, overdue: base.overdue, month_ended: base.month_ended, errors: base.errors.map((e) => e.cycle_code), duration_ms: durationMs } }), { clock: rt.clock });
    return { ...base, skipped: false, skipped_reason: null, duration_ms: durationMs };
  } finally {
    if (got) await client.query("SELECT pg_advisory_unlock($1)", [PLANNER_LOCK_KEY]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

export { D as plainDate };
