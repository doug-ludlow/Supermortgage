/**
 * Loan-scoped unit of work. Domain services are synchronous and talk to the
 * kernel's in-memory stores; persistence wraps one command as (35.1 rules 6–8):
 *
 *   BEGIN → pg_advisory_xact_lock on the scope (the loan, then the application; `uow:global` for neither — rule 7)
 *     → hydrate (events, ledger sets, open timers for the loan) on the same connection, inside the transaction
 *     → `opts.hydrated(ctx)` (the runtime loads the bounded entity store and checks `expected_versions` — rule 8)
 *     → run the domain code against MemoryEventStore / MemoryLedger / TimerEngine
 *     → persist everything new (events, entry sets, timer upserts, decisions, `before` / `commit` hooks) and COMMIT
 *       — or nothing, if the command threw. A unique violation on entity_records' primary key (a concurrent
 *       writer's version + 1) is refused as STALE_RECORD and the transaction rolls back whole.
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
import { takeScopeLocks } from "../../domain/operations-runtime/seam/lock.ts";
import { mapEntityRecordsCollision } from "../../domain/operations-runtime/seam/guard.ts";

/** The scope of one command: a loan, an application (before funding), or both (30.2 creates the loan for the application). */
export interface UowScope { readonly loanId?: string; readonly applicationId?: string; }

export interface UowContext {
  readonly loanId: string;
  readonly applicationId?: string;
  readonly events: MemoryEventStore;
  readonly ledger: MemoryLedger;
  readonly timers: TimerEngine;
  readonly clock: Clock;
  /** The command's own transaction (35.1 rule 7: everything a command reads or writes is inside it, after the lock); absent in a unit harness without a database. */
  readonly q?: Queryable;
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

/** What the persist hooks see: the command's new events (ids assigned in memory; sequences after `append`). */
export interface PersistInfo { readonly events: readonly DomainEvent[]; readonly firstEventId: string | null; }

export interface UowOptions {
  readonly clock?: Clock;
  readonly timerOptions?: Omit<TimerEngineOptions, "calendars"> & { calendars?: TimerEngineOptions["calendars"] };
  /** Runs after the lock and the hydration, before the command (35.1: the bounded entity load and the expected-version guard). */
  readonly hydrated?: (ctx: UowContext) => Promise<void>;
  /** A global command (no loan, no application) takes `uow:global` before it reads (a declared read-then-bump); otherwise the runtime takes it at persist time when the command wrote a global row (src/domain/operations-runtime/seam/lock.ts). */
  readonly globalLock?: boolean;
  /** Writes that must precede the command's events in the same transaction (a new application row the events reference; 35.1's row projectors). */
  readonly before?: (q: Queryable, info: PersistInfo) => Promise<void>;
  /** Extra writes committed in the same transaction as the command's events, ledger sets, timers and decisions (the runtime's entity records, escalations and fact projectors). */
  readonly commit?: (q: Queryable, info: PersistInfo) => Promise<void>;
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
    const committed = await this.db.tx(async (q) => {
      // 0. the lock: one loan, one writer (rule 7) — before anything is read
      await takeScopeLocks(q, { ...(loanId ? { loanId } : {}), ...(applicationId ? { applicationId } : {}) }, { globalAtStart: opts.globalLock === true });
      const events = new PgEventRepository(q), ledgerRepo = new PgLedgerRepository(q), timerRepo = new PgTimerRepository(q), decisionRepo = new PgDecisionRepository(q), loanRepo = new PgLoanRepository(q);
      // 1. hydrate — a loan's record, an application's record, or both (deduplicated: the hand-off events carry both keys), on the transaction's connection
      const loanHistory = loanId ? await events.byLoan(loanId) : [];
      const appHistory = applicationId ? await events.byApplication(applicationId) : [];
      // the loan's listed sets plus the custodial-only sets its own commands posted (a settlement's cash split / investor share — 16.2's reversal reverses them too)
      const sets = loanId ? [...await ledgerRepo.setsForLoan(loanId), ...await ledgerRepo.setsPostedByLoan(loanId)] : [];
      // a global command (no loan, no application) hydrates the timers armed on global subjects — a transfer batch's clocks are satisfied by the batch-level events 17.x tools emit (32.12 backend delta; additive)
      const loanTimers = loanId ? await timerRepo.open(loanId) : applicationId ? [] : await timerRepo.openGlobal();
      const appTimers = applicationId ? await timerRepo.forApplication(applicationId) : [];
      const seen = new Set<string>();
      const history = [...loanHistory, ...appHistory].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).sort((a, b) => a.sequence - b.sequence);
      const tseen = new Set<string>();
      const openTimers = [...loanTimers, ...appTimers].filter((t) => (t.status === "armed" || t.status === "breached") && (tseen.has(t.id) ? false : (tseen.add(t.id), true)));
      const memEvents = new MemoryEventStore(clock, { ...(loanId ? { loanId } : {}), ...(applicationId ? { applicationId } : {}) });
      memEvents.seed(history);
      const ledger = new MemoryLedger();
      ledger.seed(sets);
      const timers = new TimerEngine(this.registry, memEvents, { ...(opts.timerOptions ?? {}) } as TimerEngineOptions);
      timers.restore(openTimers);
      const priorSeq = memEvents.lastSequence();
      const knownSets = new Set(sets.map((s) => s.id));
      const priorTimerState = new Map(openTimers.map((t) => [t.id, `${t.status}|${t.satisfiedAt ?? ""}|${t.breachedAt ?? ""}|${t.cancelledReason ?? ""}`]));
      const queued: DecisionInput[] = [];
      const ctx: UowContext = { loanId, ...(applicationId ? { applicationId } : {}), events: memEvents, ledger, timers, clock, q, decide: (d) => { queued.push({ ...(loanId ? { loanId } : {}), ...(applicationId ? { applicationId } : {}), ...d }); } };
      if (opts.hydrated) await opts.hydrated(ctx);

      // 2. run the command
      const result = await fn(ctx);

      // 3. persist atomically
      const newEvents = memEvents.since(priorSeq);
      const newSets = ledger.sets().filter((s) => !knownSets.has(s.id));
      const changedTimers = timers.all().filter((t) => priorTimerState.get(t.id) !== `${t.status}|${t.satisfiedAt ?? ""}|${t.breachedAt ?? ""}|${t.cancelledReason ?? ""}`);
      const info: PersistInfo = { events: newEvents, firstEventId: newEvents[0]?.id ?? null };
      if (opts.before) await opts.before(q, info);
      const persisted = await events.append(newEvents, q);
      await loanRepo.projectStatus(persisted, q);   // `loan.paid_in_full` → loans.status = paid_off (16.2 rule 3); `payoff.reversed` → active
      for (const s of newSets) await ledgerRepo.post(s, q, loanId || null);
      await timerRepo.save(changedTimers, q);
      const decisions: DecisionRecord[] = [];
      for (const d of queued) decisions.push(await decisionRepo.record(d, q));
      if (opts.commit) await opts.commit(q, { events: persisted, firstEventId: persisted[0]?.id ?? null });
      return { result, events: persisted, entrySets: newSets, timers: changedTimers, decisions };
    }).catch((e: unknown) => { throw mapEntityRecordsCollision(e); });
    this.notifyCommitted(committed.events);
    return committed;
  }
}
