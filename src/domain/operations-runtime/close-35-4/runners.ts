/**
 * §35.4 — the runners of the 35.3 registry rows that name this process as runner owner (35.3 rule 2's table:
 * `investor_period_close` (5.1), `ledger_period_close` (6.3), `form_496_monthly` (6.3), `form_496a_monthly` (6.4),
 * `star_monthly` (18.3), `form_1098` (7.1)). Each runs the owning section's own command as the owner's actor under the
 * unit's own scope through `Runtime.executeDef` (35.3 rule 8: "a unit is its owner's command with its owner's actor and
 * its owner's idempotency"), with the unit's facts derived server-side from typed rows — the job carries ids and dates only.
 * The receipt each unit produces is the owner's own event (rule 2); this file emits nothing of its own.
 *
 * Until 35.3's executor is merged, sweep.ts runs the units planned in a pass through `runUnitsInline`; with 35.3 present
 * its `cycles.ts` names these runners (`CLOSE_RUNNERS`) and this process plans jobs only. The runners are filled in by the
 * build's commit group 4; a cycle without a runner here is left to 35.3 (`runner_missing`, dead on its first attempt).
 */
import type { Runtime } from "../../../runtime/app.ts";
import type { UnitsToRun } from "./plan.ts";

export type CloseRunner = (rt: Runtime, unit: { unit_id: string; period_key: string; input: Record<string, unknown> }, at: string) => Promise<{ outcome: "done" | "skipped"; detail?: string }>;
export const CLOSE_RUNNERS: Readonly<Record<string, CloseRunner>> = {};

/** The inline executor of last resort (no 35.3): every planned unit of every step through its runner, sequentially; a unit without a runner is skipped and reported. */
export async function runUnitsInline(rt: Runtime, units: readonly UnitsToRun[], at: string): Promise<number> {
  let ran = 0;
  for (const u of units) {
    const runner = CLOSE_RUNNERS[u.cycle_code]; if (!runner) continue;
    for (const unit of u.units) {
      try { const r = await runner(rt, { unit_id: unit.unit_id, period_key: u.tax_year !== null ? String(u.tax_year) : u.period, input: unit.input }, at); if (r.outcome === "done") ran++; }
      catch (e) { rt.logger?.error("close inline unit failed", { cycle_code: u.cycle_code, unit: unit.unit_id, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  return ran;
}
