/**
 * §35.3 rule 9 — the paged breach pass. After the executor budget the sweep breaches every armed timer past due in pages:
 * `SELECT * FROM timers WHERE status = 'armed' AND due_at <= $1 ORDER BY due_at LIMIT 500 FOR UPDATE SKIP LOCKED`
 * (src/infra/db/timers.ts duePage — 35.1's clause plus the LIMIT), one `db.tx` per page until a page comes back short. A
 * page's transaction is the body Runtime.sweep ran over every due timer at once before this process (src/runtime/app.ts):
 * restore the page into a fresh engine, evaluate, append `timer.breached`, save the breached rows, open one escalation per
 * breach to the registry's escalation role. 10,000 due timers are 20 transactions of 500 and exactly the breaches a single
 * pass would have produced, each once: a second pass started concurrently skips the rows the first holds and takes disjoint
 * pages (T7). The final probe — the page that comes back empty after a full one — is a read-only transaction, reported apart.
 *
 * The escalation's role is the registry row's breach column's first backticked token (`resolveBreachRole`), unless that
 * token is the placeholder `escalation_role` — 35.3's SM_JOB_DEAD_2H, whose role lives on the dead unit's `cycle_registry`
 * row (timers-35-3.ts breachRoleFor_35_3: `jobs → cycle_registry.escalation_role`). A 35.3 clock's payload is enriched from
 * its subject (timers-35-3.ts enrichBreach_35_3: the run's `cycle_code, period_key, units_done, units_total`; the job's
 * `cycle_code, period_key, unit_id, error_class`) so the escalation names what stalled (T12). A 35.11 clock's payload, severity
 * and owner come from its enricher (stewardship.ts BREACH_ENRICHERS: the adapter and D15 for SM_OPS_ADAPTER_DOWN_1H; the cycle,
 * the period and `consecutive_misses` for SM_OPS_CYCLE_MISSED_2H, sev 1 → `compliance` on a second consecutive miss — 35.11 T3, T5).
 * Every other clock's payload is what it always was: `timer_code, timer_id, due_at, breach`.
 *
 * 35.9 rule 7 ("Every breach runs its registered action in the breach transaction"): after a page's escalations are saved, the
 * page's transaction runs `breach.execute{timer_id}` for each breach it evaluated, on a command view of that transaction
 * (src/domain/operations-runtime/default-35-9/sweep.ts executeBreachActions) — the executor's own row records the outcome, a
 * throw is logged and the page still commits; the post-commit listeners hear the page's breaches and the executors' events
 * together once the page lands.
 *
 * 35.1 edge case 7: `SM_SWEEP_HEARTBEAT_DAILY` can only breach inside a sweep, so a run in progress on the clock's due day is
 * the day's sweep and satisfies it minutes later (`sweep.run_completed`, app.ts); the clock breaches when its due day passed
 * with no run at all (a demo advance that sweeps once a day at noon is not an outage). A page leaves that instance armed
 * (`deferred`) and it is not counted as due.
 */
import { breachPayloadOf } from "./closeout-35-10/breach.ts";
type Row = Record<string, unknown>;
import type { DomainEvent } from "../../kernel/events/index.ts";
import { MemoryEventStore } from "../../kernel/events/index.ts";
import { TimerEngine, type TimerInstance } from "../../kernel/timers/engine.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { Runtime } from "../../runtime/app.ts";
import { breachRoleFor_35_3, enrichBreach_35_3 } from "./timers-35-3.ts";
// 35.11: a process may enrich the escalation of its own clock's breach when it is opened — SM_OPS_ADAPTER_DOWN_1H names the adapter and D15, SM_OPS_CYCLE_MISSED_2H the cycle, the period and consecutive_misses (and the row's second clause: sev 1 → compliance) — reads only, in the page's transaction
import { BREACH_ENRICHERS } from "./stewardship.ts";
import { executeBreachActions } from "./default-35-9/sweep.ts";

/** Rule 9's page: 500 due timers per transaction. */
export const BREACH_PAGE_SIZE = 500;
export const CYCLES_PROCESS_ID = "35.3";

export interface BreachSummary { readonly loan_id: string | null; readonly code: string; readonly severity: number | null; readonly escalate_to: readonly string[]; readonly timer_id: string; }
export interface PagedBreachReport {
  readonly at: string;
  readonly page_size: number;
  /** Pages that returned rows (each one transaction that breached them). */
  readonly pages: number;
  /** The empty probe after a full last page (a read-only transaction that found nothing left). */
  readonly probes: number;
  /** Due timers evaluated over every page (the deferred heartbeat instance excluded). */
  readonly due: number;
  readonly by_page: readonly number[];
  /** 35.1 edge case 7: SM_SWEEP_HEARTBEAT_DAILY instances due on the run's own day, left armed for this run's receipt. */
  readonly deferred: number;
  readonly breaches: readonly BreachSummary[];
  /** 35.9 rule 7: `breach.execute` calls the pages made (one per breach evaluated, minus the loans whose lock was held). */
  readonly actions: number;
}

/** 35.1 edge case 7: the heartbeat clock on its own due day is this run's to satisfy, never to breach — true when the page must leave it armed. */
export function deferredToThisRun(t: TimerInstance, asOfDate: PlainDate, nowIso: string): boolean {
  return t.code === "SM_SWEEP_HEARTBEAT_DAILY" && !((t.dueDate ?? wallClock(t.dueAt ?? Date.parse(nowIso), "America/New_York").date) < asOfDate);
}

/**
 * The breach escalation's owner role from the registry row's breach column: its first backticked token, unless that token is
 * the placeholder `escalation_role` (35.3's SM_JOB_DEAD_2H: "sev 3 → the registry row's `escalation_role`" — the role lives on the
 * `cycle_registry` row, not in the column; src/kernel/timers/registry.ts parseSeverity collects every backticked token, so the
 * generic fallback would otherwise open the escalation to a literal `escalation_role`). Undefined → the caller's default.
 */
export function resolveBreachRole(b: { readonly escalateTo: readonly string[] }): string | undefined {
  const first = b.escalateTo[0];
  return first === undefined || first === "escalation_role" ? undefined : first;
}

/** One page: the due rows locked for this transaction, breached, persisted, escalated — `rows: 0` when nothing was left; `deferred` counts the heartbeat instance a page leaves armed (35.1 edge case 7). */
async function breachPage(rt: Runtime, nowIso: string, pageSize: number, asOfDate: PlainDate, executeActions: boolean): Promise<{ rows: number; deferred: number; breaches: BreachSummary[]; persisted: DomainEvent[]; actions: number }> {
  return rt.db.tx(async (q) => {
    const claimed = await rt.uow.timers.duePage(nowIso, pageSize, q);
    const due = claimed.filter((t) => !deferredToThisRun(t, asOfDate, nowIso));
    const deferred = claimed.length - due.length;
    if (!due.length) return { rows: 0, deferred, breaches: [], persisted: [], actions: 0 };
    // the due instances (any loan, or global) restored into a fresh engine: evaluate breaches them and appends timer.breached under each timer's own loan
    const events = new MemoryEventStore(rt.clock);
    const engine = new TimerEngine(rt.registry, events);
    engine.restore(due);
    const escalations = new EscalationService(events, rt.clock);
    const breaches: BreachSummary[] = [];
    for (const b of engine.evaluate(nowIso)) {
      const fallback = resolveBreachRole(b) ?? "ops_analyst";
      const cycles = b.def.process === CYCLES_PROCESS_ID;
      // 35.11: the steward's own clocks — the enricher may raise the severity and name the owner (the registry row's second clause); a failing enricher is logged and the breach opens on the row's first clause
      const enrich = BREACH_ENRICHERS.get(b.instance.code);
      const enriched = enrich ? await enrich(q, { id: b.instance.id, code: b.instance.code, subject: b.instance.subject }, nowIso).catch((e: unknown) => { rt.logger?.error("breach enricher failed", { code: b.instance.code, timer_id: b.instance.id, error: e }); return null; }) : null;
      const sev = enriched?.severity ?? b.severity ?? 4;
      const owner = enriched?.ownerRole ?? (cycles ? await breachRoleFor_35_3(q, b.instance, fallback) : fallback);
      // 35.10 T13: a closeout clock's escalation names its closeout (the arming step event's application_id, prior_loan_id, step, waiting_on)
      const refi = !cycles && b.instance.code.startsWith("SM_REFI_") ? breachPayloadOf((await q.query<{ payload: Row }>(`SELECT payload FROM loan_events WHERE id = $1`, [b.instance.armedByEventId]))[0]?.payload ?? null) : null;
      const extra = cycles ? await enrichBreach_35_3(q, b.instance) : (refi ?? enriched?.payload ?? {});
      escalations.open({ kind: `sev${sev}`, ownerRole: owner, ...(b.instance.loanId ? { loanId: b.instance.loanId } : {}), severity: String(sev), slaTimerId: b.instance.id,
        payload: { timer_code: b.instance.code, timer_id: b.instance.id, due_at: b.instance.dueAt !== undefined ? new Date(b.instance.dueAt).toISOString() : null, breach: b.breachText, ...extra } }, { kind: "system", id: "sweep" });
      breaches.push({ loan_id: b.instance.loanId ?? null, code: b.instance.code, severity: b.severity, escalate_to: [...b.escalateTo], timer_id: b.instance.id });
    }
    const persisted = await rt.uow.events.append(events.since(0), q);
    await rt.uow.timers.save(engine.all().filter((t) => t.status === "breached"), q);
    for (const e of escalations.list()) await rt.escalationRepo.save(e, q);
    // 35.9 rule 7: the registered action of every breach on this page, in this transaction, after the escalation the pass opened
    const nested: DomainEvent[] = [];
    const actions = executeActions ? await executeBreachActions(rt, q, nowIso, breaches, escalations.list(), nested) : 0;
    return { rows: due.length, deferred, breaches, persisted: [...persisted, ...nested], actions };
  });
}

/** Rule 9: the breach pass in pages of `pageSize` (500), one transaction per page, until a page comes back short; the post-commit listeners hear each page as it lands. */
export async function pagedBreachPass(rt: Runtime, nowIso: string = rt.clock.now(), opts: { readonly pageSize?: number; /** `false`: no `breach.execute` per breach (a 35.3 test of the pages alone) */ readonly executeActions?: boolean } = {}): Promise<PagedBreachReport> {
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? BREACH_PAGE_SIZE));
  const asOfDate = wallClock(Date.parse(nowIso), "America/New_York").date;
  const byPage: number[] = []; const breaches: BreachSummary[] = []; let probes = 0; let deferred = 0; let actions = 0;
  for (;;) {
    const page = await breachPage(rt, nowIso, pageSize, asOfDate, opts.executeActions !== false);
    actions += page.actions;
    if (page.persisted.length) rt.uow.notifyCommitted(page.persisted);
    deferred = Math.max(deferred, page.deferred);   // the same armed instance comes back on every page; count it once
    if (page.rows === 0) { probes += 1; break; }
    byPage.push(page.rows); breaches.push(...page.breaches);
    // the page's rows and the engine's breaches select on the same predicate (`status = 'armed' AND due_at <= now`); a page that breached nothing would come back again forever, so it ends the pass loudly instead
    if (!page.breaches.length) { rt.logger?.error("breach pass: a page of due timers breached nothing — stopping", { at: nowIso, rows: page.rows, page: byPage.length }); break; }
    if (page.rows + page.deferred < pageSize) break;
  }
  return { at: nowIso, page_size: pageSize, pages: byPage.length, probes, due: byPage.reduce((a, n) => a + n, 0), by_page: byPage, deferred, breaches, actions };
}
