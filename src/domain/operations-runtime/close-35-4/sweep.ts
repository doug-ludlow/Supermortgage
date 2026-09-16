/**
 * §35.4 — the sweep's pass (src/runtime/app.ts Runtime.sweep, after the breach pass so a stall breached this minute is
 * labelled and named on its escalation in the same sweep):
 *   1. the trigger: every `ledger.month.ended{period_key, period_end}` on the bus without a close period opens one
 *      (`close.open`, idempotent); until 35.3's planner lands, the pass is the fallback emitter of that event — once per
 *      period, on the first pass whose ET civil date is in a new month (35.3 rule 4: the previous pass — the newest
 *      sweep_runs row — was in the month that ended), so a fresh install never opens a month it never lived through;
 *   2. one planning transaction (plan.ts) under the global lock — receipts, transitions, the roll-up;
 *   3. a December period's `tax_year_close` step that is due runs `close.tax_year` as its own command (this process's own unit);
 *   4. when 35.3's executor is absent (no `jobs` table), the units planned this pass run inline through runners.ts (the
 *      owning sections' commands under their own actors), then one more planning transaction records their receipts;
 *      with 35.3 present its executor runs the jobs and the next sweep records them.
 * Nothing here moves money or a section's clock (rule 12).
 */
import { EscalationService } from "../../../app/escalations.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { etDate, periodEndOf, periodStartOf, priorPeriodOf } from "./calendar.ts";
import { openClosePeriod } from "./open.ts";
import { planPeriods, type PlanReport, type UnitsToRun } from "./plan.ts";
import { closePorts } from "./ports.ts";
import { GLOBAL_AGG, PLANNER_ACTOR } from "./types.ts";
import { runUnitsInline } from "./runners.ts";
import { periodByKey } from "./store.ts";

export interface CloseSweepReport { readonly at: string; readonly as_of_date: string; readonly servicer_number: string; readonly month_ended_emitted: string | null; readonly opened: readonly string[]; readonly plan: PlanReport; readonly tax_year_closed: readonly number[]; readonly inline_units: number; readonly line: string }

export async function closeSweepPass(rt: Runtime, nowIso: string = rt.clock.now(), o: { runId?: string | null; inline?: boolean } = {}): Promise<CloseSweepReport> {
  const asOf = etDate(nowIso);
  const ports = closePorts(rt);
  const servicer = await ports.servicer.servicerNumber(rt.db);
  const plannedBy = o.runId ? `sweep:${o.runId}` : "sweep";
  // 1. the trigger
  let emitted: string | null = null; const opened: string[] = [];
  const prior = priorPeriodOf(asOf); const priorStart = periodStartOf(prior); const priorEnd = periodEndOf(prior);
  const pending = await rt.db.query<{ id: string; period_key: string; period_end: string }>(`SELECT e.id::text AS id, e.payload->>'period_key' AS period_key, e.payload->>'period_end' AS period_end FROM loan_events e WHERE e.type = 'ledger.month.ended' AND e.payload->>'period_key' IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM close_periods p WHERE p.kind = 'month' AND p.period = e.payload->>'period_key' AND p.servicer_number = $1) ORDER BY e.sequence`, [servicer]);
  const seen = new Set<string>();
  for (const e of pending) {
    if (seen.has(e.period_key)) continue; seen.add(e.period_key);
    await rt.uow.run({}, async (ctx) => { const r = await openClosePeriod({ ...ctx, actor: PLANNER_ACTOR, now: nowIso }, { period: e.period_key, period_end: periodEndOf(e.period_key), servicer_number: servicer, source_event_id: e.id }); if (r.created) opened.push(e.period_key); }, { clock: rt.clock, globalLock: true });
  }
  if (!seen.has(prior) && !(await periodByKey(rt.db, "month", prior, servicer))) {
    // 35.3 rule 4: "on its first pass whose `as_of` civil date (America/New_York) is in a new month" — the previous pass (the newest sweep_runs row before this one, or the demo clock's last step) was in an earlier month; a fresh install has no previous pass and opens nothing
    const alreadyEmitted = await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loan_events WHERE type = 'ledger.month.ended' AND payload->>'period_key' = $1`, [prior]);
    const previous = await rt.db.query<{ d: string | null }>(`SELECT max(as_of_date)::text AS d FROM sweep_runs WHERE started_at < $1::timestamptz AND as_of_date < $2::date`, [nowIso, periodStartOf(asOf.slice(0, 7))]).catch(() => [{ d: null }]);
    const firstPassOfMonth = previous[0]?.d !== null && previous[0]?.d !== undefined && previous[0].d >= priorStart;
    if (Number(alreadyEmitted[0]!.c) === 0 && firstPassOfMonth) {
      await rt.uow.run({}, async (ctx) => {
        const ev = ctx.events.append({ type: "ledger.month.ended", aggregate: GLOBAL_AGG, actor: PLANNER_ACTOR, payload: { period_key: prior, period_end: priorEnd, as_of_date: asOf, emitted_by: "35.4 close.plan (the fallback until 35.3's planner emits it — 35.3 rule 4)" } });
        emitted = prior;
        const r = await openClosePeriod({ ...ctx, actor: PLANNER_ACTOR, now: nowIso }, { period: prior, period_end: priorEnd, servicer_number: servicer, source_event_id: ev.id }); if (r.created) opened.push(prior);
      }, { clock: rt.clock, globalLock: true });
    }
  }
  // 2. the planning transaction
  const plan = await planOnce(rt, nowIso, servicer, plannedBy);
  // 3. the tax-year close that is due (this process's own unit, its own command)
  const taxYearClosed: number[] = [];
  for (const ty of [...new Set(plan.tax_year_closes_due)]) {
    const r = await rt.execute({ process: "35.4", name: "close.tax_year", loanId: "", actor: PLANNER_ACTOR, input: { tax_year: ty } });
    if ((r.output as { ran?: boolean } | null)?.ran) taxYearClosed.push(ty);
  }
  // 4. inline units while 35.3's executor is absent
  let inline = 0;
  if (o.inline !== false && plan.units_to_run.length && !(await ports.cycles.executorPresent(rt.db))) {
    inline = await runUnitsInline(rt, plan.units_to_run as UnitsToRun[], nowIso);
    if (inline > 0) { const again = await planOnce(rt, nowIso, servicer, plannedBy); mergeInto(plan, again); }
  }
  const line = `close ${asOf}: periods=${plan.periods} opened=[${opened.join(",")}] receipts=${plan.receipts} planned=[${plan.planned.join(",")}] started=[${plan.started.join(",")}] completed=[${plan.completed.join(",")}] stalled=[${plan.stalled.join(",")}] closed=[${plan.closed.join(",")}] tax_year_closed=[${taxYearClosed.join(",")}] inline_units=${inline}`;
  return { at: nowIso, as_of_date: asOf, servicer_number: servicer, month_ended_emitted: emitted, opened, plan, tax_year_closed: taxYearClosed, inline_units: inline, line };
}

/** One planning transaction: the global lock, the receipts, the transitions, the roll-up; escalations saved with it. */
export async function planOnce(rt: Runtime, nowIso: string, servicer: string, plannedBy: string): Promise<PlanReport> {
  let esc: EscalationService | undefined; let report: PlanReport | undefined;
  await rt.uow.run({}, async (ctx) => {
    esc = new EscalationService(ctx.events, ctx.clock);
    report = await planPeriods({ q: ctx.q!, events: ctx.events, now: nowIso, actor: PLANNER_ACTOR, escalations: esc, ports: closePorts(rt), servicer, plannedBy });
  }, { clock: rt.clock, globalLock: true, commit: async (q) => { for (const e of esc?.list() ?? []) await rt.escalationRepo.save(e, q); } });
  return report!;
}
function mergeInto(a: PlanReport, b: PlanReport): void {
  a.receipts += b.receipts; a.planned.push(...b.planned); a.started.push(...b.started); a.completed.push(...b.completed); a.stalled.push(...b.stalled); a.failed.push(...b.failed); a.closed.push(...b.closed); a.tax_year_closes_due.push(...b.tax_year_closes_due); a.units_to_run.push(...b.units_to_run);
}
