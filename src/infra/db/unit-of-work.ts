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
import type { Db, Queryable } from "./client.ts";
import { PgEventRepository } from "./events.ts";
import { PgLedgerRepository } from "./ledger.ts";
import { PgTimerRepository } from "./timers.ts";
import { PgDecisionRepository, type DecisionInput, type DecisionRecord } from "./decisions.ts";
import { PgLoanRepository } from "./loans.ts";

/** The scope of one command: a loan, an application (before funding), or both (30.2 creates the loan for the application). */
export interface UowScope { readonly loanId?: string; readonly applicationId?: string; }

export interface UowContext {
  readonly loanId: string;
  readonly applicationId?: string;
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
  /** Writes that must precede the command's events in the same transaction (a new application row the events reference). */
  readonly before?: (q: Queryable) => Promise<void>;
  /** Extra writes committed in the same transaction as the command's events, ledger sets, timers and decisions (the runtime's entity records and escalations). */
  readonly commit?: (q: Queryable) => Promise<void>;
}

/** A post-commit listener: the events one unit of work persisted, with their database sequences (docs/ux/02 §3: the borrower SSE stream is fed here). */
export type CommittedListener = (events: readonly DomainEvent[]) => void;

export class PgUnitOfWork {
  private readonly db: Db;
  private readonly registry: TimerRegistry;
  private readonly listeners = new Set<CommittedListener>();
  readonly events: PgEventRepository;
  readonly ledger: PgLedgerRepository;
  readonly timers: PgTimerRepository;
  readonly decisions: PgDecisionRepository;
  readonly loans: PgLoanRepository;

  constructor(db: Db, registry: TimerRegistry) {
    this.db = db; this.registry = registry;
    this.events = new PgEventRepository(db); this.ledger = new PgLedgerRepository(db); this.timers = new PgTimerRepository(db); this.decisions = new PgDecisionRepository(db); this.loans = new PgLoanRepository(db);
  }

  /** Called after every commit with the persisted events (never inside the transaction; a listener that throws is logged by nobody — it must not). */
  onCommitted(fn: CommittedListener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  /** Publish events persisted outside `run` (the sweep's breach pass) to the same listeners. */
  notifyCommitted(events: readonly DomainEvent[]): void { if (!events.length) return; for (const l of this.listeners) { try { l(events); } catch { /* a listener never fails the command */ } } }

  async run<T>(scope: string | UowScope, fn: (ctx: UowContext) => T | Promise<T>, opts: UowOptions = {}): Promise<UowResult<T>> {
    const clock = opts.clock ?? systemClock;
    const sc: UowScope = typeof scope === "string" ? { loanId: scope } : scope;
    const loanId = sc.loanId ?? ""; const applicationId = sc.applicationId;
    // 1. hydrate — a loan's record, an application's record, or both (deduplicated: the hand-off events carry both keys)
    const [loanHistory, appHistory, sets, loanTimers, appTimers] = await Promise.all([
      loanId ? this.events.byLoan(loanId) : Promise.resolve([] as DomainEvent[]),
      applicationId ? this.events.byApplication(applicationId) : Promise.resolve([] as DomainEvent[]),
      loanId ? this.ledger.setsForLoan(loanId) : Promise.resolve([] as EntrySet[]),
      loanId ? this.timers.open(loanId) : Promise.resolve([] as TimerInstance[]),
      applicationId ? this.timers.forApplication(applicationId) : Promise.resolve([] as TimerInstance[])]);
    const seen = new Set<string>();
    const history = [...loanHistory, ...appHistory].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).sort((a, b) => a.sequence - b.sequence);
    const tseen = new Set<string>();
    const openTimers = [...loanTimers, ...appTimers].filter((t) => (t.status === "armed" || t.status === "breached") && (tseen.has(t.id) ? false : (tseen.add(t.id), true)));
    const events = new MemoryEventStore(clock, { ...(loanId ? { loanId } : {}), ...(applicationId ? { applicationId } : {}) });
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
    const result = await fn({ loanId, ...(applicationId ? { applicationId } : {}), events, ledger, timers, clock, decide: (d) => { queued.push({ ...(loanId ? { loanId } : {}), ...(applicationId ? { applicationId } : {}), ...d }); } });

    // 3. persist atomically
    const newEvents = events.since(priorSeq);
    const newSets = ledger.sets().filter((s) => !knownSets.has(s.id));
    const changedTimers = timers.all().filter((t) => priorTimerState.get(t.id) !== `${t.status}|${t.satisfiedAt ?? ""}|${t.breachedAt ?? ""}|${t.cancelledReason ?? ""}`);
    const committed = await this.db.tx(async (q) => {
      if (opts.before) await opts.before(q);
      const persisted = await this.events.append(newEvents, q);
      await this.loans.projectStatus(persisted, q);   // `loan.paid_in_full` → loans.status = paid_off (16.2 rule 3); `payoff.reversed` → active
      for (const s of newSets) await this.ledger.post(s, q);
      await this.timers.save(changedTimers, q);
      const decisions: DecisionRecord[] = [];
      for (const d of queued) decisions.push(await this.decisions.record(d, q));
      if (opts.commit) await opts.commit(q);
      return { result, events: persisted, entrySets: newSets, timers: changedTimers, decisions };
    });
    this.notifyCommitted(committed.events);
    return committed;
  }
}
