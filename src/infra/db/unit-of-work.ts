/**
 * Loan-scoped unit of work. Domain services are synchronous and talk to the
 * kernel's in-memory stores; persistence wraps one command as:
 *
 *   hydrate (events, ledger sets, open timers for the loan)
 *     → run the domain code against MemoryEventStore / MemoryLedger / TimerEngine
 *     → persist everything new in ONE transaction (events, entry sets, timer
 *       upserts, decisions) — or nothing, if the command threw.
 *
 * The database is the truth: event sequences and balances read back from it,
 * and its triggers re-assert append-only and balanced-set invariants.
 */
import { MemoryEventStore, type DomainEvent, type Clock, systemClock } from "../../kernel/events/index.ts";
import { MemoryLedger, type EntrySet } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, type TimerInstance, type TimerRegistry, type TimerEngineOptions } from "../../kernel/timers/index.ts";
import type { Db } from "./client.ts";
import { PgEventRepository } from "./events.ts";
import { PgLedgerRepository } from "./ledger.ts";
import { PgTimerRepository } from "./timers.ts";
import { PgDecisionRepository, type DecisionInput, type DecisionRecord } from "./decisions.ts";

export interface UowContext {
  readonly loanId: string;
  readonly events: MemoryEventStore;
  readonly ledger: MemoryLedger;
  readonly timers: TimerEngine;
  readonly clock: Clock;
  /** Queue an agent decision; persisted with the rest of the command. */
  decide(d: DecisionInput): void;
}

export interface UowResult<T> {
  readonly result: T;
  readonly events: readonly DomainEvent[];        // persisted, with database sequences
  readonly entrySets: readonly EntrySet[];
  readonly timers: readonly TimerInstance[];      // instances inserted or updated
  readonly decisions: readonly DecisionRecord[];
}

export interface UowOptions {
  readonly clock?: Clock;
  readonly timerOptions?: Omit<TimerEngineOptions, "calendars"> & { calendars?: TimerEngineOptions["calendars"] };
}

export class PgUnitOfWork {
  private readonly db: Db;
  private readonly registry: TimerRegistry;
  readonly events: PgEventRepository;
  readonly ledger: PgLedgerRepository;
  readonly timers: PgTimerRepository;
  readonly decisions: PgDecisionRepository;

  constructor(db: Db, registry: TimerRegistry) {
    this.db = db; this.registry = registry;
    this.events = new PgEventRepository(db); this.ledger = new PgLedgerRepository(db); this.timers = new PgTimerRepository(db); this.decisions = new PgDecisionRepository(db);
  }

  async run<T>(loanId: string, fn: (ctx: UowContext) => T | Promise<T>, opts: UowOptions = {}): Promise<UowResult<T>> {
    const clock = opts.clock ?? systemClock;
    // 1. hydrate
    const [history, sets, openTimers] = await Promise.all([this.events.byLoan(loanId), this.ledger.setsForLoan(loanId), this.timers.open(loanId)]);
    const events = new MemoryEventStore(clock);
    events.seed(history);
    const ledger = new MemoryLedger();
    ledger.seed(sets);
    const timers = new TimerEngine(this.registry, events, { ...(opts.timerOptions ?? {}) } as TimerEngineOptions);
    timers.restore(openTimers);
    const priorSeq = events.lastSequence();
    const knownSets = new Set(sets.map((s) => s.id));
    const priorTimerState = new Map(openTimers.map((t) => [t.id, `${t.status}|${t.satisfiedAt ?? ""}|${t.breachedAt ?? ""}|${t.cancelledReason ?? ""}`]));
    const queued: DecisionInput[] = [];

    // 2. run the command
    const result = await fn({ loanId, events, ledger, timers, clock, decide: (d) => { queued.push({ loanId, ...d }); } });

    // 3. persist atomically
    const newEvents = events.since(priorSeq);
    const newSets = ledger.sets().filter((s) => !knownSets.has(s.id));
    const changedTimers = timers.all().filter((t) => priorTimerState.get(t.id) !== `${t.status}|${t.satisfiedAt ?? ""}|${t.breachedAt ?? ""}|${t.cancelledReason ?? ""}`);
    return this.db.tx(async (q) => {
      const persisted = await this.events.append(newEvents, q);
      for (const s of newSets) await this.ledger.post(s, q);
      await this.timers.save(changedTimers, q);
      const decisions: DecisionRecord[] = [];
      for (const d of queued) decisions.push(await this.decisions.record(d, q));
      return { result, events: persisted, entrySets: newSets, timers: changedTimers, decisions };
    });
  }
}
