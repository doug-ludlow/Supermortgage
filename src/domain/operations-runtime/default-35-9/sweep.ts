/**
 * §35.9 — the passes `Runtime.sweep` runs for this process (src/runtime/app.ts, `logged(...)` like every daily pass):
 *   defaultCaseDailyPass  the day's cycles (daily-run.ts runDefaultCaseDay) once per calendar day at/after 05:30 ET, before the
 *                    reconciliation and the breach pass (the receipt `default_case.daily.run_completed` satisfies and re-arms
 *                    SM_DEFAULT_CASE_DAILY; a second sweep the same day finds the run row and writes nothing).
 *   breachReconPass  rule 7's `breach.recon{as_of_date}` once per calendar day, before the breach pass (the receipt
 *                    `breach_action.recon.run_completed` satisfies and re-arms SM_BREACH_ACTION_RECON_DAILY).
 * The reconciliation runs on the bus (`rt.execute`, a global command) so the decision record and the receipt are the tool's own;
 * the daily pass runs each unit on the bus as its owner and elects the receipts in its own global units of work.
 */
import type { Runtime } from "../../../runtime/app.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { DAILY_AT_ET, ET, PROCESS_35_9, SWEEP_ACTOR } from "../default-35-9.ts";
import { runDefaultCaseDay, type DailyRunOptions, type DailyRunReport } from "./daily-run.ts";

/** True when the sweep's instant is at/after the cycle's planned time of day (05:30 America/New_York). */
export function dailyDue(nowIso: string): boolean {
  const wc = wallClock(Date.parse(nowIso), ET);
  return `${String(wc.hour).padStart(2, "0")}:${String(wc.minute).padStart(2, "0")}` >= DAILY_AT_ET;
}
export async function defaultCaseDailyPass(rt: Runtime, nowIso: string, o: DailyRunOptions = {}): Promise<DailyRunReport> {
  return runDefaultCaseDay(rt, nowIso, o);
}

export async function breachReconPass(rt: Runtime, nowIso: string, o: { runId?: string | null } = {}): Promise<Record<string, unknown>> {
  const asOf = wallClock(Date.parse(nowIso), ET).date;
  const r = await rt.execute({ process: PROCESS_35_9, name: "breach.recon", loanId: "", actor: SWEEP_ACTOR, input: { as_of_date: asOf, sweep_run_id: o.runId ?? null } });
  return r.output as Record<string, unknown>;
}
