/**
 * §35.9 — the passes `Runtime.sweep` runs for this process (src/runtime/app.ts, `logged(...)` like every daily pass) and the
 * hook the paged breach pass calls (src/domain/operations-runtime/breach.ts):
 *   defaultCaseDailyPass   the day's cycles (daily-run.ts runDefaultCaseDay) once per calendar day at/after 05:30 ET, before the
 *                          reconciliation and the breach pass (the receipt `default_case.daily.run_completed` satisfies and re-arms
 *                          SM_DEFAULT_CASE_DAILY; a second sweep the same day finds the run row and writes nothing).
 *   breachReconPass        rule 7's `breach.recon{as_of_date}` once per calendar day, before the breach pass (the receipt
 *                          `breach_action.recon.run_completed` satisfies and re-arms SM_BREACH_ACTION_RECON_DAILY).
 *   executeBreachActions   rule 7's first sentence — "Every breach runs its registered action in the breach transaction": for each
 *                          breach a page of the breach pass evaluated, after the escalation the pass opened — a code with a
 *                          `breach_action_registry` row runs `breach.execute{timer_id}` on a command view of that page's transaction
 *                          (Runtime.commandView; the executor's own row records executed / deferred / escalated_only / refused /
 *                          failed, a throw is logged and the page still commits); a code with no row is `escalated_only` by rule 7's
 *                          default and is recorded in bulk (breach.ts recordEscalatedOnly: the row and the event, no tool, no
 *                          command). A loan whose 35.1 lock another command holds is only tried, never waited on (the page already
 *                          holds the due timer rows — the opposite lock order of a loan command that updates timers): its action
 *                          runs on the next sweep and the reconciliation lists the gap meanwhile.
 * The reconciliation runs on the bus (`rt.execute`, a global command) so the decision record and the receipt are the tool's own.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { DomainEvent } from "../../../kernel/events/index.ts";
import type { Escalation } from "../../../app/escalations.ts";
import type { Runtime } from "../../../runtime/app.ts";
import type { BreachSummary } from "../breach.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { DAILY_AT_ET, ET, PROCESS_35_9, SWEEP_ACTOR } from "../default-35-9.ts";
import { runDefaultCaseDay, type DailyRunOptions, type DailyRunReport } from "./daily-run.ts";
import { recordEscalatedOnly } from "./breach.ts";

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

/** Rule 7 on one page of the breach pass (see the header): returns the number of `breach.execute` calls made; `nested` receives the executors' committed events for the post-commit listeners. */
export async function executeBreachActions(rt: Runtime, q: Queryable, nowIso: string, breaches: readonly BreachSummary[], opened: readonly Escalation[], nested: DomainEvent[]): Promise<number> {
  if (!breaches.length) return 0;
  const escalationOf = (timerId: string): string | null => opened.find((e) => e.slaTimerId === timerId)?.id ?? null;
  // rule 7's default for every code without a registry row: `escalated_only`, recorded in bulk in this transaction
  const registered = new Set((await q.query<{ timer_code: string }>(`SELECT timer_code FROM breach_action_registry`)).map((r) => r.timer_code));
  const direct = breaches.filter((b) => !registered.has(b.code));
  nested.push(...await recordEscalatedOnly(rt, q, nowIso, direct.map((b) => ({ timer_id: b.timer_id, code: b.code, loan_id: b.loan_id, escalation_id: escalationOf(b.timer_id) }))));
  let n = direct.length;
  const viaBus = breaches.filter((b) => registered.has(b.code));
  if (!viaBus.length) return n;
  const view = rt.commandView(q, nested);
  for (const b of viaBus) {
    const esc = opened.find((e) => e.slaTimerId === b.timer_id);
    // lock order: this transaction already holds the due timer rows; a loan command holds the loan's lock and then updates timers — so the loan's lock is only tried, never waited on
    if (b.loan_id) {
      const [l] = await q.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext('uow'), hashtext($1)) AS ok`, [b.loan_id]);
      if (!l?.ok) { rt.logger?.warn("35.9 breach.execute deferred: loan lock held", { at: nowIso, timer_id: b.timer_id, code: b.code, loan_id: b.loan_id }); continue; }
    }
    try {
      await view.execute({ process: PROCESS_35_9, name: "breach.execute", loanId: b.loan_id ?? "", actor: SWEEP_ACTOR, input: { timer_id: b.timer_id, timer_code: b.code, loan_id: b.loan_id, escalation_id: esc?.id ?? null, breached_at: nowIso } });
      n += 1;
    } catch (e) { rt.logger?.error("35.9 breach.execute failed", { at: nowIso, timer_id: b.timer_id, code: b.code, error: e instanceof Error ? e.message : String(e) }); }
  }
  return n;
}
