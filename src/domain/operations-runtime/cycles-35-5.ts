/**
 * §35.5 — what this process supplies to 35.3's registry (35.5 Integrations: "`cycles.run_unit` (35.3; the four runners registered in
 * src/domain/operations-runtime/cycles.ts with owner_agent: cashiering …)"; 35.3 rule 2: "A cycle owned by … 35.5 is registered here
 * with its runner name; that process supplies the runner"):
 *
 *   cashieringDailyRunner        the `cashiering_daily` unit INSIDE `cycles.run_unit`'s command (35.3 rule 5; 35.5 rule 6: one unit of
 *                                work per loan per day — cashiering-cycle.ts cashieringUnitIn); a refusal (CONFIG_REQUIRED, CUSTODIAL_REQUIRED,
 *                                an engine's) rolls the command back and 35.3's retry policy (rule 7) records the failure, so a dead loan-day
 *                                is a labelled unit on the board, never a silent skip.
 *   cashieringDailyReceipt       the fields 35.5 rule 6 puts on `cashiering.daily.run_completed{as_of_date, loans, posted, late_charges_assessed,
 *                                amount_change_checks, units_dead}` beside 35.3 rule 5's standard payload — read from the run's own
 *                                `cashiering_unit_runs` rows at the election (35.3's last unit; the planner's reconciliation).
 *
 * `lockbox_ingest`, `ach_file_build` and `ach_returns_ingest` need no runner of their own: runners.ts's `busToolRunner("35.5", …)` runs
 * `lockbox.ingest{lockbox_id, as_of_date}`, `ach.file.build{as_of_date}` and `ach.returns.ingest{as_of_date}` as the cashiering agent
 * with the job's ids (their tools emit the receipt literal themselves — `receipt_emitted_by: owner`).
 */
import type { Queryable } from "../../infra/db/client.ts";
import type { CommandContext } from "../../app/commands.ts";
import type { ToolRuntime } from "../../app/tools.ts";
import type { CycleDef, NamedRunner, UnitContext } from "./cycles.ts";
import { cashieringUnitIn } from "./cashiering-cycle.ts";

const loanOf = (unit: UnitContext): string => { if (!unit.loan_id) throw new RangeError(`unit ${unit.cycle_code}:${unit.unit_id} carries no loan_id`); return unit.loan_id; };

export const cashieringDailyRunner: NamedRunner = { name: "cashieringDailyRunner", runner: { mode: "in_command", run: async (toolRt: ToolRuntime, ctx: CommandContext, unit: UnitContext) => {
  const o = await cashieringUnitIn(toolRt, ctx, { loan_id: loanOf(unit), as_of_date: unit.as_of_date, job_id: unit.job_id, run_id: unit.run_id });
  return { outcome: o.outcome, unit_run_id: o.unit_run_id, local_date: o.local_date, time_zone: o.time_zone, posted: o.posted, late_charge_run: o.late_charge_run, late_charge_fee_ids: o.late_charge_fee_ids, amount_change_checks: o.amount_change_checks, due_today: o.due_today, grace_ended_yesterday: o.grace_ended_yesterday, interest_variance_cents: o.interest_variance_cents.toString(), schedule_reprojected: o.schedule_reprojected };
} } };

/** 35.5 rule 6's receipt fields, from the run's unit rows: `loans` = the run's units, `posted` / `late_charges_assessed` / `amount_change_checks` = the cardinalities over the units that ran. */
export const cashieringDailyReceipt: NonNullable<CycleDef["receipt_payload"]> = async (q: Queryable, run) => {
  const r = (await q.query<{ posted: string; late: string; checks: string }>(`SELECT coalesce(sum(cardinality(payments_posted)), 0)::text AS posted, coalesce(sum(cardinality(late_charge_fee_ids)), 0)::text AS late, coalesce(sum(cardinality(amount_change_checks)), 0)::text AS checks FROM cashiering_unit_runs WHERE run_id = $1 AND outcome IN ('done', 'skipped_hold')`, [run.run_id]))[0]!;
  return { loans: run.units_total, posted: Number(r.posted), late_charges_assessed: Number(r.late), amount_change_checks: Number(r.checks) };
};
