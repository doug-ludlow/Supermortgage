/**
 * §35.3 — the unit runners that have landed, attached to the code registry's rows (cycles.ts CYCLE_ROWS → `CYCLES`).
 * A def whose runner another process supplies (35.2, 35.4–35.12) keeps `runner: null` and dies on its first claim with
 * `error_class: runner_missing` (edge case 3) — labelled, never silent (D14).
 *
 *   monthEndRunner   rule 4 (T15): the `month_end` cycle's single global unit, `in_command` — its `cycles.run_unit` command
 *                    appends `ledger.month.ended{period_key: <prior YYYY-MM>, period_end: <last day>, origination: true}` on the
 *                    global subject (no loan, no aggregate — the engine arms 35.4's SM_CLOSE_PERIOD_OPEN_BD1 on `{global, *}`,
 *                    anchor `period_end`); exactly once because the run / job unique keys admit one `month_end:<YYYY-MM>:global`.
 *
 * The remaining interim runners (statements, form_1098, delinquency_counters, metro2_monthly in_command; cashiering_daily,
 * form_496_monthly, the four sweep-body wrappers and `busToolRunner` as passes) land with the executor's second commit group.
 */
import type { CommandContext } from "../../app/commands.ts";
import type { ToolRuntime } from "../../app/tools.ts";
import { CYCLE_ROWS, EVT, type CycleDef, type NamedRunner, type UnitContext } from "./cycles.ts";

export const monthEndRunner: NamedRunner = { name: "monthEndRunner", runner: { mode: "in_command", run: (_toolRt: ToolRuntime, ctx: CommandContext, unit: UnitContext) => {
  // rule 4: on the global subject, exactly once per month (the job's idempotency key) — the trigger 35.4's SM_CLOSE_PERIOD_OPEN_BD1 arms on
  const e = ctx.events.append({ type: EVT.MONTH_ENDED, actor: unit.actor, payload: { period_key: unit.period_key, period_end: unit.period_end, run_id: unit.run_id, job_id: unit.job_id, origination: true } });
  return { period_key: unit.period_key, period_end: unit.period_end, event_id: e.id, outcome: "month_ended" };
} } };

const RUNNERS: Readonly<Record<string, NamedRunner>> = { month_end: monthEndRunner };

/** The registry at first commit: every row of rule 2's table plus `month_end`, each with the runner that has landed (or null). */
export const CYCLES: readonly CycleDef[] = CYCLE_ROWS.map((row) => ({ ...row, runner: RUNNERS[row.cycle_code] ?? row.runner }));
