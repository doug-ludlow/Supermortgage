/**
 * §35.4 — the sweep's pass (src/runtime/app.ts Runtime.sweep, after the breach pass so a stall breached this minute is
 * labelled and named on its escalation in the same sweep):
 *   1. the trigger: every `ledger.month.ended{period_key, period_end}` on the bus without a close period opens one
 *      (`close.open`, idempotent); until 35.3's planner lands, the pass is the fallback emitter of that event — once per
 *      period, on the first pass whose ET civil date is in a new month (35.3 rule 4: the previous pass — the newest
 *      sweep_runs row — was in the month that ended), so a fresh install never opens a month it never lived through;
 *   2. one planning transaction (plan.ts) under the global lock — receipts, transitions, the roll-up;
 *   3. a December period's `tax_year_close` step that is due runs `close.tax_year` as its own command (this process's own unit);
 *   4. in rounds until a round moves nothing: this process's own steps (runners.ts STEP_RUNNERS — 6.3's day close of
 *      the month's last day while 35.3's executor is absent, and the balance attestation: prepare → qc-audit review →
 *      the officer's approval record → attest), the FAKE neighbours' stand-in receipts for owners not in this tree
 *      (fake-neighbours.ts; nonprod with the FAKE reviewers on, never production) and, when 35.3's executor is absent
 *      (no `jobs` table), the units planned this pass through runners.ts CLOSE_RUNNERS (the owning sections' commands
 *      under their own actors); each round ends with one more planning transaction that records the receipts. With
 *      35.3 present its executor runs the jobs and the next sweep records them. `CLOSE_SWEEP_RUNNERS=off` leaves all of
 *      it to the operators (the hand-driven acceptance scenarios).
 * Nothing here moves money or a section's clock (rule 12).
 */
import { EscalationService } from "../../../app/escalations.ts";
import type { Runtime } from "../../../runtime/app.ts";
import { etDate, periodEndOf, periodKeyOf, periodStartOf, priorPeriodOf } from "./calendar.ts";
import { addDays, type PlainDate } from "../../../kernel/calendar/date.ts";
import { openClosePeriod } from "./open.ts";
import { planPeriods, type PlanReport, type UnitsToRun } from "./plan.ts";
import { closePorts } from "./ports.ts";
import { GLOBAL_AGG, PLANNER_ACTOR } from "./types.ts";
import { runStepsInline, runUnitsInline } from "./runners.ts";
import { fakeNeighbourReceipts, fakeNeighbourRunners, fakeOfficer } from "./fake-neighbours.ts";
import { PERIOD_COLS, periodByKey } from "./store.ts";
import type { ClosePeriodRow } from "./types.ts";

/** Rounds per pass: the month chain is six deep (eod_cutoff → … → balance_attestation → form496), a reopen adds one. */
const MAX_ROUNDS = 8;

export interface CloseSweepReport { readonly at: string; readonly as_of_date: string; readonly servicer_number: string; readonly month_ended_emitted: string | null; readonly opened: readonly string[]; readonly plan: PlanReport; readonly tax_year_closed: readonly number[]; readonly inline_units: number; readonly rounds: number; readonly line: string }

export async function closeSweepPass(rt: Runtime, nowIso: string = rt.clock.now(), o: { runId?: string | null; inline?: boolean } = {}): Promise<CloseSweepReport> {
  const asOf = etDate(nowIso);
  const ports = closePorts(rt);
  const servicer = await ports.servicer.servicerNumber(rt.db);
  const plannedBy = o.runId ? `sweep:${o.runId}` : "sweep";
  // 1. the trigger
  let emitted: string | null = null; const opened: string[] = [];
  const prior = priorPeriodOf(asOf);
  const pending = await rt.db.query<{ id: string; period_key: string; period_end: string }>(`SELECT e.id::text AS id, e.payload->>'period_key' AS period_key, e.payload->>'period_end' AS period_end FROM loan_events e WHERE e.type = 'ledger.month.ended' AND e.payload->>'period_key' IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM close_periods p WHERE p.kind = 'month' AND p.period = e.payload->>'period_key' AND p.servicer_number = $1) ORDER BY e.sequence`, [servicer]);
  const seen = new Set<string>();
  for (const e of pending) {
    if (seen.has(e.period_key)) continue; seen.add(e.period_key);
    await rt.uow.run({}, async (ctx) => { const r = await openClosePeriod({ ...ctx, actor: PLANNER_ACTOR, now: nowIso }, { period: e.period_key, period_end: periodEndOf(e.period_key), servicer_number: servicer, source_event_id: e.id }); if (r.created) opened.push(e.period_key); }, { clock: rt.clock, globalLock: true });
  }
  // 35.3 rule 4: "on its first pass whose `as_of` civil date (America/New_York) is in a new month" — the previous pass (the newest sweep_runs row before this one) was in an earlier month; every month that ended between that pass and this one is emitted (an outage across a boundary loses no month); a fresh install has no previous pass and opens nothing
  const previous = await rt.db.query<{ d: string | null }>(`SELECT max(as_of_date)::text AS d FROM sweep_runs WHERE started_at < $1::timestamptz AND as_of_date < $2::date`, [nowIso, periodStartOf(asOf.slice(0, 7))]).catch(() => [{ d: null }]);
  if (previous[0]?.d) {
    for (let key = periodKeyOf(previous[0].d as PlainDate); key <= prior; key = periodKeyOf(addDays(periodEndOf(key), 1))) {
      if (seen.has(key) || (await periodByKey(rt.db, "month", key, servicer))) continue;
      const alreadyEmitted = await rt.db.query<{ c: string }>(`SELECT count(*)::text AS c FROM loan_events WHERE type = 'ledger.month.ended' AND payload->>'period_key' = $1`, [key]);
      if (Number(alreadyEmitted[0]!.c) > 0) continue;
      const end = periodEndOf(key);
      await rt.uow.run({}, async (ctx) => {
        const ev = ctx.events.append({ type: "ledger.month.ended", aggregate: GLOBAL_AGG, actor: PLANNER_ACTOR, payload: { period_key: key, period_end: end, as_of_date: asOf, emitted_by: "35.4 close.plan (the fallback until 35.3's planner emits it — 35.3 rule 4)" } });
        emitted = key;
        const r = await openClosePeriod({ ...ctx, actor: PLANNER_ACTOR, now: nowIso }, { period: key, period_end: end, servicer_number: servicer, source_event_id: ev.id }); if (r.created) opened.push(key);
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
  // 4. this process's own steps and, while 35.3's executor is absent, the planned units inline — in rounds, each followed by
  //    one more planning transaction, until a round moves nothing (a whole month's chain in one pass where the receipts
  //    allow; a step whose not_before or owner is still ahead waits for a later pass). Never in a pass that only verifies.
  let inline = 0; let rounds = 0;
  // `CLOSE_SWEEP_RUNNERS=off`: the operators (or the acceptance fixtures) run the owners by hand and the sweep only plans and records
  if (o.inline !== false && (rt.env["CLOSE_SWEEP_RUNNERS"] ?? "").trim().toLowerCase() !== "off") {
    const executorPresent = await ports.cycles.executorPresent(rt.db);
    const officer = await fakeOfficer(rt);
    const fakeRunners = await fakeNeighbourRunners(rt);
    let units: UnitsToRun[] = plan.units_to_run as UnitsToRun[];
    for (rounds = 1; rounds <= MAX_ROUNDS; rounds++) {
      const open = await rt.db.query<ClosePeriodRow>(`SELECT ${PERIOD_COLS} FROM close_periods WHERE servicer_number = $1 AND status <> 'closed' ORDER BY kind, period`, [servicer]);
      let moved = await fakeNeighbourReceipts(rt, open, nowIso);
      moved += await runStepsInline(rt, open, nowIso, { runId: o.runId ?? "sweep", officer, executorPresent });
      if (!executorPresent && units.length) moved += await runUnitsInline(rt, units, nowIso, fakeRunners);
      if (!moved) break;
      inline += moved;
      const again = await planOnce(rt, nowIso, servicer, plannedBy); mergeInto(plan, again);
      for (const ty of [...new Set(again.tax_year_closes_due)]) { const r = await rt.execute({ process: "35.4", name: "close.tax_year", loanId: "", actor: PLANNER_ACTOR, input: { tax_year: ty } }); if ((r.output as { ran?: boolean } | null)?.ran) taxYearClosed.push(ty); }
      units = again.units_to_run as UnitsToRun[];
    }
  }
  const line = `close ${asOf}: periods=${plan.periods} opened=[${opened.join(",")}] receipts=${plan.receipts} planned=[${plan.planned.join(",")}] started=[${plan.started.join(",")}] completed=[${plan.completed.join(",")}] stalled=[${plan.stalled.join(",")}] closed=[${plan.closed.join(",")}] tax_year_closed=[${taxYearClosed.join(",")}] inline_units=${inline} rounds=${rounds}`;
  return { at: nowIso, as_of_date: asOf, servicer_number: servicer, month_ended_emitted: emitted, opened, plan, tax_year_closed: taxYearClosed, inline_units: inline, rounds, line };
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
