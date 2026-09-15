/**
 * §35.1 rule 11 — the outbox is drained by every sweep: "After the lease and before the passes, `outbox.dispatch` claims due
 * rows per adapter with `SELECT … FOR UPDATE SKIP LOCKED LIMIT 100` (PgOutbox.due gains the locking clause), runs the existing
 * `OutboxDispatcher` with `DEFAULT_RETRY` (5 attempts, 60 s base, 30 min cap — unchanged), writes one `outbox_dispatches` row
 * per attempt and emits `integration.message.sent{message_id, adapter, attempt}` or `integration.message.dead{message_id,
 * adapter, attempts, error, dead_at}`." The dead event arms SM_OUTBOX_DEAD_LETTER_REVIEW_1BD on the `integration_message`
 * aggregate (a global subject, so a global command — the sweep, `outbox.dispatch` by hand, an `ops_analyst`'s abandonment —
 * satisfies or cancels it); the sent event satisfies it. 34.4's requeue (`outbox.requeued`) is picked up by the next drain
 * like any queued row.
 *
 * Adapters: the FAKE ports of every build stage (printMail, edelivery, lsdu, smdu, p360, connect, mers, custodian, metro2,
 * eoscar, nacha — app.ts fakePorts) behind one `OutboundAdapter` each; a message whose adapter no port answers is an outage
 * (`AdapterUnavailable` → `fallback`: dead at once with the human portal task, the dispatcher's own rule). A runtime may
 * register adapters of its own (`RuntimeDeps.outboxAdapters` — a test scripts a failing one).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db, Queryable } from "../../../infra/db/client.ts";
import { toJson } from "../../../infra/db/client.ts";
import { PgEventRepository } from "../../../infra/db/events.ts";
import { PgTimerRepository } from "../../../infra/db/timers.ts";
import { PgOutbox, PgPortalTasks } from "../../../infra/integrations/pg-outbox.ts";
import { Dispatcher, DEFAULT_RETRY, type DispatchOutcome, type OutboundAdapter, type OutboxMessage } from "../../../infra/integrations/outbox.ts";
import { AdapterUnavailable } from "../../../infra/integrations/failures.ts";
import { LsduOutboundAdapter } from "../../../infra/integrations/fnma.ts";
import type { Ports } from "../../../app/tools.ts";
import { MemoryEventStore, type Actor, type Clock, type DomainEvent } from "../../../kernel/events/index.ts";
import { TimerEngine } from "../../../kernel/timers/engine.ts";
import type { TimerRegistry } from "../../../kernel/timers/registry.ts";

export const DEAD_LETTER_CODE = "SM_OUTBOX_DEAD_LETTER_REVIEW_1BD";
const SWEEP_ACTOR: Actor = { kind: "system", id: "sweep" };

/** A FAKE port behind the dispatcher's adapter contract: a payload that names a port method (`{method, args}`) is delivered through it; any other payload is acknowledged with a FAKE receipt (the build stage's vendor). */
export function fakePortAdapter(name: string, port: unknown, fallbackKind = `${name}_manual`): OutboundAdapter {
  return {
    name, fallbackKind,
    async send(payload: unknown, m: OutboxMessage): Promise<unknown> {
      const p = payload as { method?: unknown; args?: unknown } | null;
      if (p && typeof p === "object" && typeof p.method === "string") {
        const fn = (port as Record<string, unknown> | null)?.[p.method];
        if (typeof fn !== "function") throw new AdapterUnavailable(name, fallbackKind, `${name} has no ${p.method}`);
        return (fn as (...a: unknown[]) => unknown).call(port, ...(Array.isArray(p.args) ? p.args : [p.args ?? payload]), m.lastAttemptAt ?? m.createdAt);
      }
      return { delivered: true, fake: true, adapter: name, message_id: m.id, at: m.lastAttemptAt ?? m.createdAt };
    },
  };
}

/** The adapter registry over the runtime's ports (INTEGRATIONS=fake): one per FAKE port, with the spellings the sections use (`mail` and `email` are 16.3's channels). */
export function portAdapters(ports: Partial<Ports>): Map<string, OutboundAdapter> {
  const out = new Map<string, OutboundAdapter>();
  const add = (names: readonly string[], a: OutboundAdapter): void => { for (const n of names) out.set(n, a); };
  if (ports.printMail) add(["printMail", "print-mail", "print_mail", "mail"], fakePortAdapter("printMail", ports.printMail, "print_mail_secondary_vendor"));
  if (ports.edelivery) add(["edelivery", "e-delivery", "email"], fakePortAdapter("edelivery", ports.edelivery));
  if (ports.lsdu) add(["fnma-lsdu", "lsdu"], new LsduOutboundAdapter(ports.lsdu));
  if (ports.smdu) add(["fnma-smdu", "smdu"], fakePortAdapter("smdu", ports.smdu, "smdu_web_app"));
  if (ports.p360) add(["fnma-p360", "p360"], fakePortAdapter("p360", ports.p360, "p360_web_app"));
  if (ports.connect) add(["fnma-connect", "connect"], fakePortAdapter("connect", ports.connect, "connect_portal"));
  if (ports.mers) add(["mers"], fakePortAdapter("mers", ports.mers, "mers_online"));
  if (ports.custodian) add(["custodian"], fakePortAdapter("custodian", ports.custodian, "custodian_portal"));
  if (ports.metro2) add(["metro2", "crs"], fakePortAdapter("metro2", ports.metro2, "crs_batch_upload"));
  if (ports.eoscar) add(["eoscar", "e-oscar"], fakePortAdapter("eoscar", ports.eoscar, "eoscar_web_app"));
  if (ports.nacha) add(["nacha", "odfi"], fakePortAdapter("nacha", ports.nacha, "bank_portal"));
  return out;
}

export interface DrainCounts { claimed: number; sent: number; retried: number; dead: number; rejected: number; fallback: number; }
export interface DrainReport extends DrainCounts { readonly at: string; readonly adapters: { adapter: string; claimed: number; sent: number; retried: number; dead: number; rejected: number; fallback: number }[]; readonly events: DomainEvent[]; }
export interface DrainDeps { readonly db: Db; readonly registry: TimerRegistry; readonly clock: Clock; readonly ports: Partial<Ports>; readonly adapters?: ReadonlyMap<string, OutboundAdapter>; readonly notify?: (events: readonly DomainEvent[]) => void; }
export interface DrainOptions { readonly adapter?: string | null; readonly limit?: number; readonly runId?: string | null; }

const sha = (v: unknown): string | null => (v === undefined ? null : createHash("sha256").update(toJson(v)).digest("hex"));

/** Every adapter with a due queued row at `now` (or the one named). */
async function dueAdapters(db: Queryable, now: string, only: string | null | undefined): Promise<string[]> {
  if (only) return [only];
  return (await db.query<{ adapter: string }>(`SELECT DISTINCT adapter FROM integration_messages WHERE status = 'queued' AND coalesce(next_attempt_at, created_at) <= $1 ORDER BY adapter`, [now])).map((r) => r.adapter);
}

/** The drain: per adapter, one transaction — claim, deliver through the dispatcher, one outbox_dispatches row per attempt, the events (the dead-letter clock armed / satisfied through the engine), commit. */
export async function drainOutbox(deps: DrainDeps, nowIso: string, o: DrainOptions = {}): Promise<DrainReport> {
  const adapters = deps.adapters ?? portAdapters(deps.ports);
  const limit = Math.max(1, Math.min(1000, o.limit ?? 100));
  const totals: DrainCounts = { claimed: 0, sent: 0, retried: 0, dead: 0, rejected: 0, fallback: 0 };
  const perAdapter: DrainReport["adapters"] = []; const allEvents: DomainEvent[] = [];
  for (const name of await dueAdapters(deps.db, nowIso, o.adapter)) {
    const adapter = adapters.get(name) ?? { name, fallbackKind: "adapter_not_wired", async send(): Promise<never> { throw new AdapterUnavailable(name, "adapter_not_wired", `no adapter is wired for ${name} (INTEGRATIONS=fake wires the FAKE ports; a message for another counterparty needs a person)`); } };
    const counts: DrainCounts = { claimed: 0, sent: 0, retried: 0, dead: 0, rejected: 0, fallback: 0 };
    const persisted = await deps.db.tx(async (q) => {
      const outbox = new PgOutbox(q); const tasks = new PgPortalTasks(q);
      // the claim: PgOutbox.due with the locking clause — two drains never deliver the same message
      const claimed = await outbox.due(name, nowIso, limit, true);
      counts.claimed = claimed.length;
      if (!claimed.length) return [] as DomainEvent[];
      // the dead-letter clocks in play: restored into an engine so `integration.message.dead` arms and `integration.message.sent` satisfies
      const events = new MemoryEventStore(deps.clock);
      const engine = new TimerEngine(deps.registry, events);
      const timerRepo = new PgTimerRepository(q);
      engine.restore((await timerRepo.openGlobal()).filter((t) => t.code === DEAD_LETTER_CODE));
      const priorTimers = new Map(engine.all().map((t) => [t.id, t.status]));
      const dispatcher = new Dispatcher(outbox, tasks, DEFAULT_RETRY);
      for (const m of claimed) {
        const startedAt = deps.clock.now();
        // one row per attempt at every message: the number continues from the rows already written (34.4's requeue resets the row's `attempts` to 0)
        const prior = (await q.query<{ n: number }>(`SELECT coalesce(max(attempt_no), 0)::int AS n FROM outbox_dispatches WHERE message_id = $1`, [m.id]))[0]?.n ?? 0;
        const attemptNo = Math.max(prior, m.attempts) + 1;
        const r: DispatchOutcome = await dispatcher.deliver(adapter, m, nowIso);
        const finishedAt = deps.clock.now();
        await q.query(`INSERT INTO outbox_dispatches (id, message_id, attempt_no, run_id, adapter, started_at, finished_at, outcome, failure_kind, error, response_sha256, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [randomUUID(), m.id, attemptNo, o.runId ?? null, name, startedAt, finishedAt, r.outcome, r.failure ?? null, r.message.error ?? null, sha(r.message.response), r.message.nextAttemptAt ?? null]);
        const aggregate = { kind: "integration_message", id: m.id };
        if (r.outcome === "acked") { counts.sent++; events.append({ type: "integration.message.sent", aggregate, actor: SWEEP_ACTOR, payload: { message_id: m.id, adapter: name, attempt: attemptNo, loan_id: m.loanId ?? null, idempotency_key: m.idempotencyKey, sent_at: nowIso } }); }
        else if (r.outcome === "retry") counts.retried++;
        else if (r.outcome === "rejected") { counts.rejected++; events.append({ type: "integration.message.rejected", aggregate, actor: SWEEP_ACTOR, payload: { message_id: m.id, adapter: name, attempts: attemptNo, error: r.message.error ?? null, loan_id: m.loanId ?? null } }); }
        else { if (r.outcome === "dead") counts.dead++; else counts.fallback++; events.append({ type: "integration.message.dead", aggregate, actor: SWEEP_ACTOR, payload: { message_id: m.id, adapter: name, attempts: attemptNo, error: r.message.error ?? null, dead_at: nowIso, failure: r.failure ?? null, outcome: r.outcome, human_portal_task_id: r.task?.id ?? null, loan_id: m.loanId ?? null } }); }
      }
      const persisted = await new PgEventRepository(q).append(events.all(), q);
      await timerRepo.save(engine.all().filter((t) => priorTimers.get(t.id) !== t.status), q);
      return persisted;
    });
    perAdapter.push({ adapter: name, ...counts });
    for (const k of Object.keys(totals) as (keyof DrainCounts)[]) totals[k] += counts[k];
    allEvents.push(...persisted);
    if (persisted.length) deps.notify?.(persisted);
  }
  return { at: nowIso, ...totals, adapters: perAdapter, events: allEvents };
}

/** An `ops_analyst` abandons a dead letter (rule 8 of the timers note: "a dead letter is resolved by a send or by a named person's abandonment, never by time"): the event is appended on the caller's unit of work, which cancels the armed clock. */
export function abandonDeadLetter(ctx: { events: { append(e: { type: string; aggregate?: { kind: string; id: string }; actor: Actor; payload: Record<string, unknown> }): DomainEvent }; timers: TimerEngine; actor: Actor; now: string }, i: { message_id: string; reason: string }): { event: DomainEvent; cancelled: string[] } {
  const event = ctx.events.append({ type: "integration.message.abandoned", aggregate: { kind: "integration_message", id: i.message_id }, actor: ctx.actor, payload: { message_id: i.message_id, by: `${ctx.actor.kind}:${ctx.actor.id}`, reason: i.reason, abandoned_at: ctx.now } });
  const cancelled: string[] = [];
  for (const t of ctx.timers.forSubject("integration_message", i.message_id)) if (t.code === DEAD_LETTER_CODE && (t.status === "armed" || t.status === "breached")) { ctx.timers.cancel(t.id, `abandoned by ${ctx.actor.id}: ${i.reason}`, ctx.actor); cancelled.push(t.id); }
  return { event, cancelled };
}
