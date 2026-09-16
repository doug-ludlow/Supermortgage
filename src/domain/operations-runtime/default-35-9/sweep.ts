/**
 * §35.9 — the passes `Runtime.sweep` runs for this process (src/runtime/app.ts, `logged(...)` like every daily pass):
 *   breachReconPass  rule 7's `breach.recon{as_of_date}` once per calendar day, before the breach pass (the receipt
 *                    `breach_action.recon.run_completed` satisfies and re-arms SM_BREACH_ACTION_RECON_DAILY).
 * Both run on the bus (`rt.execute`, a global command) so the decision record and the receipt are the tool's own.
 */
import type { Runtime } from "../../../runtime/app.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { ET, PROCESS_35_9, SWEEP_ACTOR } from "../default-35-9.ts";

export async function breachReconPass(rt: Runtime, nowIso: string, o: { runId?: string | null } = {}): Promise<Record<string, unknown>> {
  const asOf = wallClock(Date.parse(nowIso), ET).date;
  const r = await rt.execute({ process: PROCESS_35_9, name: "breach.recon", loanId: "", actor: SWEEP_ACTOR, input: { as_of_date: asOf, sweep_run_id: o.runId ?? null } });
  return r.output as Record<string, unknown>;
}
