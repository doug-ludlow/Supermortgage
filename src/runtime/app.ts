/**
 * The hosted runtime: every agent tool on the command bus, executed against
 * Postgres through the loan-scoped unit of work.
 *
 *   execute(tool, loan, actor, input)
 *     PgUnitOfWork.run: BEGIN, the scope's advisory lock (35.1 rule 7), hydrate the events, ledger sets, timers and the
 *     bounded entity store (rule 6: the scope's latest rows, HISTORY_KINDS in full, the global rows), the expected-version
 *     guard (rule 8) → run the tool through CommandBus (allowlists, roles, money fields, guardrails, decision record) →
 *     one transaction commits events, ledger sets, timers, decisions, entity versions, their typed projections (rule 2:
 *     row projectors before the events, fact projectors after) and escalations — or nothing.
 *
 *   sweep(now)
 *     the daily refinance check when a rate feed is wired (src/runtime/refi-daily.ts: once per calendar day at/after
 *     06:30 ET — the day's rate sheet through 20.4, the universe from `v_refi_universe`, `20.1 emitOfferReady{op=run}`
 *     per partner program, whose `refi.trigger.run_completed` satisfies SM_REFI_TRIGGER_DAILY before the breach pass
 *     below could breach it), then 33.2's daily review of the partner book (src/runtime/partner-book-review.ts: once per
 *     day at/after 07:00 ET over every monitored loan — the review rows, the analyst's turns, offer delivery and expiry,
 *     `partner_book.review.run_completed` satisfying SM_PARTNER_BOOK_REVIEW_DAILY), then 33.3's readiness pass (src/runtime/partner-book-readiness.ts:
 *     once per day at/after 07:15 ET over every candidate and every open refinance application from a monitored loan — one readiness_checks row each,
 *     `partner_book.readiness.run_completed` satisfying SM_PARTNER_BOOK_READINESS_DAILY), the FAKE reviewers when they are on (src/infra/integrations/reviewers.ts, DELTA-30: every
 *     pending human item older than the delay approved through its owning tool), then
 *     breach every armed timer whose due instant has passed (timer.breached
 *     events, an escalation per breach to the registry's escalation role) and
 *     report the integration outbox backlog. Cloud Scheduler runs it every
 *     minute as the `sweep` job; the API also exposes it on POST /v1/sweep.
 *
 * Section services: `originationServices` (src/runtime/origination.ts) constructs, per command, a fresh instance of every
 * stateful section service (25.2's ClosingDisclosureService, 21.2's LoanEstimateService, 21.3, 21.5, 29.1, 29.3, 29.4, 30.2,
 * and the servicing adapters `boarding`, `transfer`, `fpi`) hydrated from the record (35.1 rule 9: service_snapshots plus the
 * `service.state.changed` deltas on the log), plus the vendor fakes the ops files export (credit reseller, DU, identity/OFAC/fraud,
 * AMC, UCDP, EarlyCheck, PE–WL, warehouse bank, eRegistry, RON, title) and a 21.4 pricing port over 20.4's published sheets —
 * the same `services` keys the section tool files look up (`tolerance-21-5` is `tolerance`; rule 10), so the HTTP path and the
 * unit harnesses behave identically. A section service without an adapter (CashieringService, …) still answers 501 not_wired.
 */
import { randomUUID } from "node:crypto";
import { transactionDb, type Db, type Queryable } from "../infra/db/client.ts";
import { listDuDocuments, type DuDocumentSummary } from "../domain/underwriting/du/persist.ts";
import { listDuPreflight, type PreflightResultRow } from "../domain/underwriting/du/preflight.ts";
import { PgUnitOfWork, type UowResult, type CommittedListener } from "../infra/db/unit-of-work.ts";
import { PgEntityRepository, type EntityScope } from "../infra/db/entities.ts";
import { loadBoundedScoped, splitByScope } from "../domain/operations-runtime/seam/hydration.ts";
import { checkExpectedVersions, expectedVersionsOf } from "../domain/operations-runtime/seam/guard.ts";
import { takeGlobalLock } from "../domain/operations-runtime/seam/lock.ts";
import { projectVersions } from "../domain/operations-runtime/seam/project.ts";
import { PgApplicationRepository, type ApplicationInput, type ApplicationRecord } from "../infra/db/applications.ts";
import { AgentRegistry } from "../app/agents.ts";
import { CommandBus, type AgentRunInfo, type ExecuteResult } from "../app/commands.ts";
import { EntityStore, type Ports, type ToolDef, type ToolInput, type ToolRuntime } from "../app/tools.ts";
import { ALL_TOOLS, bindTools, toolKey } from "../app/tools/index.ts";
import { EscalationService, PgEscalationRepository } from "../app/escalations.ts";
import { NoticeService, type Notice } from "../notices/service.ts";
import { buildRegistry, publishAuthored } from "../notices/catalog.ts";
import { publishSection02 } from "../notices/authored/section02.ts";
import { registerPreapprovalLetter } from "../notices/authored/section20-3.ts";
import type { NoticeRegistry } from "../notices/registry.ts";
import type { TimerRegistry } from "../kernel/timers/registry.ts";
import { TimerEngine, type TimerInstance } from "../kernel/timers/engine.ts";
import { PgTimerRepository } from "../infra/db/timers.ts";
import type { Actor, Clock, DomainEvent } from "../kernel/events/index.ts";
import { MemoryEventStore, systemClock } from "../kernel/events/index.ts";
import { FakeLockbox, FakeCustodialBank, FakeOdfi } from "../infra/integrations/banking.ts";
import { FakeMetro2, FakeEoscar } from "../infra/integrations/credit.ts";
import { FakeCustodian, FakeEvault } from "../infra/integrations/custody.ts";
import { FakePrintMail, FakeEdelivery, FakeTelephony } from "../infra/integrations/delivery.ts";
import { FakeFnmaLsdu, FakeFnmaServicingEvents, FakeFnmaSmdu, FakeFnmaP360, FakeFnmaConnect } from "../infra/integrations/fnma.ts";
import { FakePacer, FakeDmdc, FakeErecording } from "../infra/integrations/legal.ts";
import { FakeMers } from "../infra/integrations/mers.ts";
import { FakeLpiTracking, FakeFlood, FakeTaxService, FakeMi } from "../infra/integrations/property.ts";
import { FakeGoogleOidc } from "../infra/integrations/oidc.ts";
import type { RateFeedPort } from "../infra/integrations/rates.ts";
import type { FakeReviewers, FakeReviewerReport } from "../infra/integrations/reviewers.ts";
import { originationServices, type OriginationServiceSet } from "./origination.ts";
import { acquireSweepLease, defaultHolder, type SweepPass } from "../domain/operations-runtime/seam/sweep.ts";
import { drainOutbox, type DrainReport, type OutboxCompletion } from "../domain/operations-runtime/seam/outbox.ts";
import { verifyRun, verifiedToday, recordFailedRun, type VerifyReport } from "../domain/operations-runtime/seam/verify.ts";
import type { OutboundAdapter } from "../infra/integrations/outbox.ts";
import { wallClock } from "../kernel/calendar/zoned.ts";
import { refiDailyRun, type RefiDailyReport } from "./refi-daily.ts";
import { partnerBookReviewRun, type ReviewRunReport } from "./partner-book-review.ts";
import { readinessRun, type ReadinessRunReport } from "./partner-book-readiness.ts";
import type { AnalystLlm } from "./partner-book-analyst.ts";
import { notifyPartnerBookTapeLate, sendPartnerBookReminders } from "./partner-book.ts";
import { sweepDailyReports, type SweepDailyReportsResult } from "./book-ops/routes.ts";
import { escalateLongTrips, expireKillSwitchRequests } from "./controls/ai.ts";
import { closeoutPass, closeoutBoardRun, closeoutBreachActions, closeoutPortsOf, withCloseoutAdapters, breachPayloadOf, type CloseoutPorts, type CloseoutPassReport, type BoardRunReport } from "./refinance-closeout.ts";
import type { Logger } from "./log.ts";

export interface RuntimeDeps {
  readonly db: Db;
  readonly registry: TimerRegistry;
  readonly agents?: AgentRegistry;
  readonly ports?: Partial<Ports>;
  readonly notices?: NoticeRegistry;
  readonly clock?: Clock;
  /** The daily rate source the sweep publishes through 20.4 and runs 20.1 against (src/infra/integrations/rates.ts); absent → the sweep runs no daily refinance check. */
  readonly rateFeed?: RateFeedPort | null;
  /** DELTA-30: the FAKE reviewers the sweep runs every pass (null / absent → off; `fakeReviewersFromEnv`). */
  readonly reviewers?: FakeReviewers | null;
  /** 33.2 rule 4: the refinance analyst's model (AnthropicLlm in deploy, the scripted client in tests; null / absent → the turn is skipped `model_off`, never the review). */
  readonly analystLlm?: AnalystLlm | null;
  readonly logger?: Logger;
  /** 35.1 rule 11: outbox adapters beside the FAKE ports' (a test scripts a failing one); keyed by the message's adapter name. */
  readonly outboxAdapters?: ReadonlyMap<string, OutboundAdapter>;
  /** 35.1 rule 12: the sweep lease holder's name (instance or job execution id); defaults to host:pid:random. */
  readonly instanceId?: string;
  /** 35.1 rule 11: per-adapter completion hooks, run inside the dispatch transaction when a message is acked (a section appends its own event and updates its own row); keyed by adapter name. */
  readonly outboxCompletions?: ReadonlyMap<string, OutboxCompletion>;
  /** The database's connection string (main.ts passes config.databaseUrl): a job that needs a dedicated client (35.3's planner lock) opens it here; the sweep lease uses the pool's own. */
  readonly databaseUrl?: string;
  /** 35.10: the closeout's ports on its neighbours (24.4's partner statement channel, 35.6's hand-off, the partner-book.notify adapter) — every default an in-repo FAKE (src/runtime/refinance-closeout.ts). */
  readonly closeoutPorts?: Partial<CloseoutPorts>;
}
/** A command is scoped to a loan (`loanId`), to an application before funding (`applicationId`), or to both during the 30.2 hand-off. */
export interface ExecuteRequest { readonly process: string; readonly name: string; readonly loanId: string; readonly applicationId?: string; readonly actor: Actor; readonly input: ToolInput; readonly run?: AgentRunInfo; readonly approvedBy?: Actor; }
export interface ExecuteResponse {
  readonly output: unknown;
  readonly decisionId?: string;
  readonly event: DomainEvent;
  readonly events: readonly DomainEvent[];
  readonly timers: readonly TimerInstance[];
  readonly decisions: readonly { id: string }[];
  readonly escalations: readonly { id: string; kind: string; ownerRole: string }[];
}
export interface SweepReport {
  readonly at: string;
  readonly due: number;
  readonly breaches: readonly { loan_id: string | null; code: string; severity: number | null; escalate_to: readonly string[]; timer_id: string }[];
  readonly outbox: readonly { adapter: string; status: string; count: number }[];
  /** The daily refinance check's report (null when no rate feed is wired). */
  readonly refi: RefiDailyReport | null;
  /** The FAKE reviewers' pass (null when they are off). */
  readonly reviewers: FakeReviewerReport | null;
  /** 33.2: the daily refinance review of the partner book (src/runtime/partner-book-review.ts partnerBookReviewRun) — after the refinance check, before the breach pass. */
  readonly partner_book_review: ReviewRunReport;
  /** 33.3: the daily refinance readiness pass over the candidates and the open refinance applications (src/runtime/partner-book-readiness.ts readinessRun) — after the review, before the breach pass. */
  readonly partner_book_readiness: ReadinessRunReport;
  /** 33.1: the reminders SM_PARTNER_BOOK_INVITATION_REMINDER_14's breach action sent on this pass (src/runtime/partner-book.ts sendPartnerBookReminders). */
  readonly partner_book_reminders: number;
  /** 33.1 rule 8: the late-tape notices SM_PARTNER_BOOK_TAPE_EXPECTED_7's breach action logged on this pass (`partner_book.tape.late`, one per breached clock — src/runtime/partner-book.ts notifyPartnerBookTapeLate). */
  readonly partner_book_tape_late: number;
  /** 34.3 rule 6: the daily report per partner-day once 33.3's receipt exists, and from 07:45 ET the ops_analyst escalation for a day without its receipts (src/runtime/book-ops/routes.ts sweepDailyReports) — after the readiness pass; null when the hook failed. */
  readonly partner_book_daily_reports: SweepDailyReportsResult | null;
  /** 35.10 rule 10: the refinance closeout pass (src/runtime/refinance-closeout.ts closeoutPass) — after the orchestration, before the breach pass; null when the pass failed. */
  readonly refinance_closeout: CloseoutPassReport | null;
  /** 35.10 rule 11: the Refinance board's daily receipt once a day at/after 06:45 ET (closeoutBoardRun). */
  readonly refinance_board: BoardRunReport | null;
  /** 35.10: the closeout clocks breached on this pass, journaled once each beside the sweep's escalation (closeoutBreachActions). */
  readonly refinance_breaches: number;
  /** 34.4 rule 4: kill-switch requests no admin confirmed within 10 minutes expired on this pass, and the compliance escalations opened for switches tripped more than 24 hours (src/runtime/controls/ai.ts). */
  readonly controls: { readonly kill_requests_expired: number; readonly long_trips_escalated: number };
  /** 35.1 rule 12: the run's `sweep_runs` row, its holder and outcome (`skipped{lease_held}` when another execution holds the lease; `failed{lease_unavailable}` when the dedicated client cannot connect). */
  readonly run_id: string;
  readonly holder: string;
  readonly outcome: "completed" | "skipped" | "failed";
  readonly skipped_reason: string | null;
  /** Every pass with its duration and counts, in the order it ran. */
  readonly passes: readonly SweepPass[];
  /** 35.1 rule 11: the outbox drain — after the lease, before the passes. */
  readonly outbox_dispatch: DrainReport | null;
  /** 35.1 rule 13: the daily verify run when this sweep ran it (once per calendar day at/after 06:00 ET). */
  readonly verify: VerifyReport | null;
}
export interface SweepOptions {
  /** `false`: skip the daily verify pass (a test that lets SM_PROJECTION_LAG_DAILY breach). */
  readonly verify?: boolean;
  readonly holder?: string;
}
/** The spec's schedule for the verify run: 06:00 America/New_York (35.1 "Trigger & frequency"). */
export const VERIFY_AT_ET = "06:00";
export class ToolNotFound extends Error { constructor(process: string, name: string) { super(`no tool ${name} in process ${process}`); this.name = "ToolNotFound"; } }

/** Every vendor port wired to its in-memory test double (INTEGRATIONS=fake). */
export function fakePorts(): Ports {
  const lsdu = new FakeFnmaLsdu();
  return { lockbox: new FakeLockbox(), custodialBank: new FakeCustodialBank(), nacha: new FakeOdfi(), metro2: new FakeMetro2(), eoscar: new FakeEoscar(), custodian: new FakeCustodian(), evault: new FakeEvault(),
    printMail: new FakePrintMail(), edelivery: new FakeEdelivery(), telephony: new FakeTelephony(), lsdu, servicingEvents: new FakeFnmaServicingEvents(), smdu: new FakeFnmaSmdu(), p360: new FakeFnmaP360(),
    connect: new FakeFnmaConnect(), pacer: new FakePacer(), dmdc: new FakeDmdc(), erecording: new FakeErecording(), mers: new FakeMers(), lpi: new FakeLpiTracking(), flood: new FakeFlood(), taxService: new FakeTaxService(), mi: new FakeMi(), oidc: new FakeGoogleOidc() };
}

/** The unit of work's store with the scope's loan stamped on every appended event that carries neither a loan nor an application key. */
function withDefaultLoan(inner: MemoryEventStore, loanId: string): MemoryEventStore {
  const append: MemoryEventStore["append"] = (input) => inner.append(input.loanId === undefined && input.applicationId === undefined ? { ...input, loanId } : input);
  // `rawStore`: the undefaulted store beneath (35.1: a servicing adapter's state delta is the platform's, not the loan's)
  return new Proxy(inner, { get: (target, prop, receiver) => (prop === "append" ? append : prop === "rawStore" ? inner : Reflect.get(target, prop, receiver)) });
}

export class Runtime {
  readonly db: Db;
  readonly registry: TimerRegistry;
  readonly agents: AgentRegistry;
  readonly ports: Partial<Ports>;
  readonly noticeRegistry: NoticeRegistry;
  readonly clock: Clock;
  readonly rateFeed: RateFeedPort | null;
  readonly reviewers: FakeReviewers | null;
  readonly analystLlm: AnalystLlm | null;
  readonly logger: Logger | undefined;
  readonly outboxAdapters: ReadonlyMap<string, OutboundAdapter> | undefined;
  readonly instanceId: string;
  readonly outboxCompletions: ReadonlyMap<string, OutboxCompletion> | undefined;
  /** 35.10's ports with their in-repo defaults (the FAKE partner statement channel, the fund-bridge hand-off, the FAKE partner-book.notify adapter). */
  readonly closeoutPorts: CloseoutPorts;
  readonly databaseUrl: string | null;
  /** The running sweep's `sweep_runs` id while `sweep` holds the lease (35.3's `cycle_runs.planned_by` reads `sweep:<id>`); null outside a run. */
  sweepRunId: string | null = null;
  readonly uow: PgUnitOfWork;
  readonly entities: PgEntityRepository;
  readonly escalationRepo: PgEscalationRepository;
  readonly applications: PgApplicationRepository;
  /** The origination section services and vendor ports, one set for the life of the runtime (see origination.ts). */
  readonly originationServices: OriginationServiceSet;
  private readonly bus: CommandBus;
  private readonly tools = new Map<string, ToolDef>();
  /** The runtime behind a command view (itself for the real runtime): its `db` is the pool — the rare write that must outlive a refusal (34.4's fourth-requeue escalation, an expired kill-switch request) goes through `rt.root.db`. */
  readonly root: Runtime;
  /** 32.12 backend delta: the Notice Registry's rendered notices for the life of the runtime (NoticeServiceDeps.notices) — a notice rendered by one command is readable by the next (17.2 runContentChecklist, the borrower flows' plain-language block). In-memory beside the `notices` table; the event log stays the record. */
  readonly noticeMemory = new Map<string, Notice>();

  constructor(deps: RuntimeDeps) {
    this.db = deps.db; this.registry = deps.registry; this.agents = deps.agents ?? new AgentRegistry(); this.ports = deps.ports ?? fakePorts(); this.clock = deps.clock ?? systemClock;
    this.rateFeed = deps.rateFeed ?? null; this.reviewers = deps.reviewers ?? null; this.analystLlm = deps.analystLlm ?? null; this.logger = deps.logger;
    this.closeoutPorts = closeoutPortsOf(deps.closeoutPorts);
    this.outboxAdapters = withCloseoutAdapters(deps.outboxAdapters, this.closeoutPorts); this.instanceId = deps.instanceId ?? defaultHolder(); this.outboxCompletions = deps.outboxCompletions; this.databaseUrl = deps.databaseUrl ?? null;
    this.noticeRegistry = deps.notices ?? (() => { const r = buildRegistry(); publishAuthored(r); publishSection02(r); registerPreapprovalLetter(r); return r; })();   // 32.8: 2.x's own authored pieces (AUTODRAFT-*, LC-*, SUSP-*) beside the catalog   // DELTA-01: the preapproval letter beside the catalog
    this.root = this;
    this.uow = new PgUnitOfWork(this.db, this.registry); this.entities = new PgEntityRepository(this.db); this.escalationRepo = new PgEscalationRepository(this.db); this.applications = new PgApplicationRepository(this.db);
    this.bus = new CommandBus(this.agents);
    this.originationServices = originationServices(this.clock);
    for (const t of ALL_TOOLS) { this.tools.set(toolKey(t.process, t.name), t); this.agents.registerTool(t.agent, t.name); }
  }

  listTools(): { process: string; name: string; agent: string; kind: string; humanOnly: boolean }[] {
    return [...this.tools.values()].map((t) => ({ process: t.process, name: t.name, agent: t.agent, kind: t.kind, humanOnly: t.humanOnly === true }));
  }
  tool(process: string, name: string): ToolDef | undefined { return this.tools.get(toolKey(process, name)); }
  /** Post-commit hook: every event a unit of work persisted (tools, createApplication, the origination bridges, the sweep) — the borrower SSE stream's feed. */
  onCommitted(fn: CommittedListener): () => void { return this.uow.onCommitted(fn); }

  /**
   * This runtime as a command sees it (35.1 rule 7): the same registry, ports, agents and services, but every repository —
   * `db`, `uow`, `entities`, `escalationRepo`, `applications` — on the command's own transaction, so a tool that reads a
   * table or runs a unit of work of its own (a pass-shaped tool, 34.4's controls) works inside the command's transaction on
   * the connection that holds its lock, never on a second pool connection (four commands holding four connections and each
   * waiting for a fifth is the deadlock the pool of four otherwise allows). Events the nested units of work persist are
   * published to the runtime's listeners when the command commits.
   */
  commandView(q: Queryable, nested: DomainEvent[]): Runtime {
    const db = transactionDb(q, this.db);
    const uow = new PgUnitOfWork(db, this.registry);
    uow.onCommitted((events) => { nested.push(...events); });
    const view: Runtime = Object.create(this) as Runtime;
    Object.defineProperties(view, { db: { value: db }, uow: { value: uow }, entities: { value: new PgEntityRepository(db) }, escalationRepo: { value: new PgEscalationRepository(db) }, applications: { value: new PgApplicationRepository(db) }, root: { value: this.root } });
    return view;
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResponse> {
    const def = this.tool(req.process, req.name);
    if (!def) throw new ToolNotFound(req.process, req.name);
    return this.executeDef(def, req);
  }
  /**
   * Execute a command that is not one of the registry's tool strings — the section case commands the spec's Agents
   * paragraphs describe but do not list as tools (src/app/tools/section04.ts SECTION_04_CASE_COMMANDS: `case.noe.open`,
   * `sii.open`, `complaint.open`, …) — on the same bus, in the same unit of work, with the same allowlists, guardrails,
   * decision record and commit (32.9 backend delta: the borrower flows open the 4.x cases the Intake Router classifies).
   */
  async executeDef(def: ToolDef, req: Omit<ExecuteRequest, "process" | "name">): Promise<ExecuteResponse> {
    const scope: EntityScope = { ...(req.loanId ? { loanId: req.loanId } : {}), ...(req.applicationId ? { applicationId: req.applicationId } : {}) };
    const store = new EntityStore();
    let mark = 0; let globalKeys: ReadonlySet<string> = new Set();
    let escalations: EscalationService | undefined;
    // writes a tool defers to the command's transaction (the borrower surface's UI-owned rows: card_instances, messages, deep_links — src/app/tools/section32-1.ts)
    const deferred: ((q: Queryable) => Promise<void>)[] = [];
    // 35.1 rule 2 / rule 10: writes that must precede the command's events (1.1 boardLoan's boarding set — the rows the events reference)
    const deferredBefore: ((q: Queryable) => Promise<void>)[] = [];
    const expected = expectedVersionsOf(req.input);
    // events persisted by units of work a tool runs inside this command (through the command view) — published once this command commits
    const nested: DomainEvent[] = [];
    const r: UowResult<ExecuteResult<unknown>> = await this.uow.run(scope, async (uow) => {
      const view = this.commandView(uow.q!, nested);
      // a loan-scoped command's events that name neither key are the loan's (the kernel store defaults the application key from the scope; the loan key is defaulted here)
      const ctx = uow.loanId ? { ...uow, events: withDefaultLoan(uow.events, uow.loanId) } : uow;
      // the scope's open escalations an earlier command persisted, so this one can complete them (21.6's reviewer decides the escalation `recommendDisposition` opened — 32.6 backend delta)
      escalations = new EscalationService(ctx.events, ctx.clock); escalations.seed(await this.escalationRepo.openFor(scope, uow.q));
      const notices = this.ports.printMail && this.ports.edelivery ? new NoticeService({ registry: this.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: this.ports.printMail, edelivery: this.ports.edelivery, notices: this.noticeMemory }) : undefined;
      // `agents` (the live registry, so a tool that delegates to another agent's tool keeps the allowlists and AI-off state), `db` (read-only lookups a borrower-surface tool needs) and `deferWrite` (a row committed with the command) ride on the services map
      // `runtime` (this) lets a pass-shaped tool (33.2 review.run / offer.deliver / offer.expire) run the runtime pass it wraps — its own units of work, sequential to this command's
      // 35.1 rule 9: every stateful section service is a fresh instance hydrated from the record for this command (origination.ts forCommand); its delta is recorded after the command ran
      const rt: ToolRuntime = { store, escalations, services: { ...await this.originationServices.forCommand(ctx, store, escalations), agents: this.agents, db: view.db, runtime: view, deferWrite: (fn: (q: Queryable) => Promise<void>) => { deferred.push(fn); }, deferBefore: (fn: (q: Queryable) => Promise<void>) => { deferredBefore.push(fn); } }, ports: this.ports, ...(notices ? { notices } : {}) };
      const cmd = bindTools(rt, this.agents, [def]).get(toolKey(def.process, def.name))!;
      const out = await this.bus.execute(cmd, req.actor, req.input, ctx, { ...(req.run ? { run: req.run } : {}), ...(req.approvedBy ? { approvedBy: req.approvedBy } : {}) });
      this.originationServices.recordState(ctx);
      return out;
    }, { clock: this.clock, globalLock: expected.length > 0,
      // 35.1 rule 6 / rule 8: the bounded entity load on the command's connection after the lock, then the expected-version guard before the domain code runs
      hydrated: async (uow) => { const loaded = await loadBoundedScoped(uow.q!, scope); store.seed(loaded.records); globalKeys = loaded.globalKeys; mark = store.versionCount(); checkExpectedVersions(store, expected); },
      // 35.1 rule 2: the row projectors (a kind an event references by foreign key) run before events.append, from the versions this command wrote
      before: async (q, info) => {
        for (const fn of deferredBefore) await fn(q);
        const { global, scoped } = splitByScope(store.versionsSince(mark), globalKeys);
        // a global command that wrote a global row takes the platform lock before it persists (seam/lock.ts note); a declared read-then-bump took it before it read
        if (!scope.loanId && !scope.applicationId && global.length && !expected.length) await takeGlobalLock(q);
        await projectVersions(q, { phase: "before", versions: global, scope: {}, now: this.clock.now(), commandEventId: info.firstEventId });
        await projectVersions(q, { phase: "before", versions: scoped, scope, now: this.clock.now(), commandEventId: info.firstEventId });
      },
      commit: async (q, info) => {
        // a bumped global row stays global (rule 8: the guard and every other loan see one row); the rest is the command's scope
        const { global, scoped } = splitByScope(store.versionsSince(mark), globalKeys);
        await this.entities.save(global, null, q);
        await this.entities.save(scoped, scope, q);
        // 35.1 rule 2: the fact projectors after events, ledger sets, timers and decisions — one entity_projections row per typed version, in this transaction (lag 0)
        await projectVersions(q, { phase: "commit", versions: global, scope: {}, now: this.clock.now(), commandEventId: info.firstEventId });
        await projectVersions(q, { phase: "commit", versions: scoped, scope, now: this.clock.now(), commandEventId: info.firstEventId });
        for (const e of escalations?.list() ?? []) await this.escalationRepo.save(e, q);
        for (const fn of deferred) await fn(q);
      } });
    if (nested.length) this.uow.notifyCommitted(nested);
    return { output: r.result.output, ...(r.result.decisionId ? { decisionId: r.result.decisionId } : {}), event: r.result.event, events: r.events, timers: r.timers,
      decisions: r.decisions.map((d) => ({ id: d.id })), escalations: (escalations?.list() ?? []).map((e) => ({ id: e.id, kind: e.kind, ownerRole: e.ownerRole })) };
  }

  /**
   * Open an application (21.1's aggregate) — the origination side's first write. The row and its borrowers/property are
   * inserted and `application.started` is appended keyed by the application id, in one transaction; every origination
   * timer that triggers on `application.started` arms in the same pass.
   */
  async createApplication(input: ApplicationInput, actor: Actor): Promise<{ application: ApplicationRecord; event: DomainEvent; timers: readonly TimerInstance[] }> {
    const id = input.id ?? randomUUID();
    let app: ApplicationRecord | undefined;
    const r = await this.uow.run({ applicationId: id }, (ctx) => ctx.events.append({ type: "application.started", applicationId: id, aggregate: { kind: "application", id }, actor,
      payload: { application_id: id, channel: input.channel, transaction_type: input.transaction_type, occupancy: input.occupancy, partner_party_id: input.partner_party_id, prior_loan_id: input.prior_loan_id ?? null, borrowers: input.borrowers.length, intake_channel: input.intake_channel ?? null } }),
      { clock: this.clock, before: async (q) => { app = await this.applications.create({ ...input, id }, q); } });
    return { application: app!, event: r.result, timers: r.timers };
  }

  /**
   * The application's record: the row, its events, open timers and decisions — and, once funded, the loan it became.
   * `du` is the DU hand-off's own facts beside the events (the deploy walk's twelfth outcome reads them here through
   * GET /v1/applications/{id}): the `du_documents` rows 23.6 emitted (the hash and the counts, never the bytes) and the
   * 23.7 preflight results; `application.du_casefile_id` is DU's own identifier from the first ack (migration 0133).
   */
  async applicationRecord(id: string): Promise<{ application: ApplicationRecord; events: readonly DomainEvent[]; timers: readonly TimerInstance[]; decisions: readonly { id: string; action: string; agent: string }[]; du: { documents: readonly DuDocumentSummary[]; preflight: readonly PreflightResultRow[] } } | undefined> {
    const application = await this.applications.get(id);
    if (!application) return undefined;
    // `preflight`: the application's `du_preflight_results` rows, oldest first (23.7 runDuPreflight on every emission → du.preflight.passed / du.preflight.refused{code, xpath, rule}; migration 0136) — every run, passing or not, with its checks; never a fabricated pass
    const [events, timers, decisions, documents, preflight] = await Promise.all([this.uow.events.byApplication(id), this.uow.timers.forApplication(id), this.uow.decisions.byApplication(id), listDuDocuments(this.db, id), listDuPreflight(this.db, id)]);
    return { application, events, timers, decisions: decisions.map((d) => ({ id: d.id, action: d.action, agent: d.agent })), du: { documents, preflight } };
  }

  /**
   * The scheduled pass (35.1 rules 11–13): the lease first — `pg_try_advisory_lock(35_001)` on a dedicated session; a firing that
   * finds it held writes `sweep_runs{skipped, lease_held}` and `sweep.run_skipped{holder}` and returns — then the holder writes
   * `sweep_runs{running}`, drains the outbox, runs the passes (the daily refinance check when a rate feed is wired, 33.2's review,
   * 33.3's readiness, 34.3's daily reports, 34.4's controls, the FAKE reviewers when on, the daily verify run at/after 06:00 ET —
   * each timed, each heartbeated), breaches every armed timer past due at `nowIso` (claimed FOR UPDATE SKIP LOCKED, one
   * escalation per breach to the registry's first escalation role, one transaction), and finishes with `completed` and
   * `sweep.run_completed{run_id, as_of_date, holder, duration_ms, passes}` in its own final transaction (SM_SWEEP_HEARTBEAT_DAILY
   * is satisfied and re-armed by the run that completes). No daily pass can fail the sweep: a failure is logged and reported;
   * the lease and the drain are the sweep's own, so their failure is the run's (`failed`, exit 1).
   */
  async sweep(nowIso: string = this.clock.now(), opts: SweepOptions = {}): Promise<SweepReport> {
    const holder = opts.holder ?? this.instanceId;
    const asOfDate = wallClock(Date.parse(nowIso), "America/New_York").date;
    const startedMs = Date.now();
    const notRun = (reason: string) => ({ refi: null as RefiDailyReport | null, reviewers: null as FakeReviewerReport | null,
      partner_book_review: { at: nowIso, as_of_date: asOfDate as ReviewRunReport["as_of_date"], ran: false, reason, monitored_loans: 0, programs: [], line: `partner book review: not run (${reason})` } as ReviewRunReport,
      partner_book_readiness: { checked: 0, ready: 0, not_ready: 0, skipped: reason, as_of_date: asOfDate, ran: false, loans_skipped: [], line: `partner book readiness: not run (${reason})` } as ReadinessRunReport,
      partner_book_reminders: 0, partner_book_tape_late: 0, partner_book_daily_reports: null, refinance_closeout: null, refinance_board: null, refinance_breaches: 0, controls: { kill_requests_expired: 0, long_trips_escalated: 0 } });
    const leased = await acquireSweepLease(this.db, nowIso, holder);
    if (!leased.ok) {
      // rule 12: a firing that finds the lease held writes skipped{lease_held} and sweep.run_skipped, and exits 0; a lease that cannot be taken at all is failed{lease_unavailable}
      const outcome = leased.reason === "lease_held" ? "skipped" : "failed";
      await this.db.query(`INSERT INTO sweep_runs (id, holder, started_at, heartbeat_at, finished_at, as_of_date, outcome, skipped_reason) VALUES ($1, $2, $3, $3, $3, $4, $5, $6)`, [leased.runId, holder, nowIso, asOfDate, outcome, leased.reason]);
      if (outcome === "skipped") await this.uow.run({}, (ctx) => ctx.events.append({ type: "sweep.run_skipped", aggregate: { kind: "sweep_run", id: leased.runId }, actor: { kind: "system", id: "sweep" }, payload: { run_id: leased.runId, holder, as_of_date: asOfDate, reason: leased.reason, lease_key: 35_001 } }), { clock: this.clock });
      this.logger?.[outcome === "skipped" ? "info" : "error"](`sweep ${outcome}`, { run_id: leased.runId, holder, reason: leased.reason, error: leased.error ?? null });
      return { at: nowIso, due: 0, breaches: [], outbox: [], ...notRun(leased.reason), run_id: leased.runId, holder, outcome, skipped_reason: leased.reason, passes: [], outbox_dispatch: null, verify: null };
    }
    const lease = leased.lease; const runId = lease.runId; this.sweepRunId = runId;
    await this.db.query(`INSERT INTO sweep_runs (id, holder, started_at, heartbeat_at, as_of_date, outcome) VALUES ($1, $2, $3, $3, $4, 'running')`, [runId, holder, nowIso, asOfDate]);
    const passes: SweepPass[] = [];
    const pass = async <T>(name: string, fn: () => Promise<T>, counts: (t: T) => Record<string, unknown>): Promise<T> => {
      const t0 = Date.now(); const out = await fn();
      passes.push({ name, duration_ms: Date.now() - t0, counts: counts(out) });
      await lease.heartbeat(this.db, this.clock.now(), passes).catch(() => undefined);
      return out;
    };
    const logged = async <T>(name: string, fn: () => Promise<T>, fallback: (msg: string) => T, counts: (t: T) => Record<string, unknown>): Promise<T> =>
      pass(name, async () => { try { return await fn(); } catch (e) { const msg = e instanceof Error ? e.message : String(e); this.logger?.error(`${name} failed`, { at: nowIso, error: e }); return fallback(msg); } }, counts);
    try {
      // rule 11: the outbox, drained by every sweep — after the lease, before the passes (the drain's failure is the run's)
      const outboxDispatch = await pass("outbox.dispatch", () => drainOutbox({ db: this.db, registry: this.registry, clock: this.clock, ports: this.ports, ...(this.outboxAdapters ? { adapters: this.outboxAdapters } : {}), ...(this.outboxCompletions ? { completions: this.outboxCompletions } : {}), notify: (ev) => this.uow.notifyCommitted(ev) }, nowIso, { runId }), (d) => ({ claimed: d.claimed, sent: d.sent, retried: d.retried, dead: d.dead, rejected: d.rejected, fallback: d.fallback }));
      const refi = this.rateFeed ? await logged("refi.daily", () => refiDailyRun(this, nowIso, { feed: this.rateFeed!, logger: this.logger }), (msg) => ({ at: nowIso, as_of_date: asOfDate as RefiDailyReport["as_of_date"], ran: false, reason: `failed: ${msg}`, rate_sheet: null, universe: { view_rows: 0, loaded: 0, unchanged: 0, skipped: [], monitored: { rows: 0, skipped: 0, open_offer: 0 } }, programs: [], line: `refi daily: failed (${msg})` } as RefiDailyReport), (r) => ({ ran: r.ran, programs: r.programs.length })) : null;
      // 33.2: the daily review of the partner book after the refinance check (it reads the day's run) — errors logged, never thrown
      const partnerBookReview = await logged("partner_book.review", () => partnerBookReviewRun(this, nowIso, { logger: this.logger, llm: this.analystLlm }), (msg) => ({ at: nowIso, as_of_date: asOfDate as ReviewRunReport["as_of_date"], ran: false, reason: `failed: ${msg}`, monitored_loans: 0, programs: [], line: `partner book review: failed (${msg})` } as ReviewRunReport), (r) => ({ ran: r.ran, monitored_loans: r.monitored_loans }));
      // 33.3: the daily readiness pass after the review (it reads the day's verdicts) — errors logged, never thrown
      const partnerBookReadiness = await logged("partner_book.readiness", () => readinessRun(this, nowIso, { logger: this.logger }), (msg) => ({ checked: 0, ready: 0, not_ready: 0, skipped: `failed: ${msg}`, as_of_date: asOfDate, ran: false, loans_skipped: [], line: `partner book readiness: failed (${msg})` } as ReadinessRunReport), (r) => ({ ran: r.ran, checked: r.checked }));
      // 34.3 rule 6: after the readiness pass, the daily report per partner-day (idempotent) and, from 07:45 ET, the ops_analyst escalation for a day without its receipts — errors logged, never thrown
      const partnerBookDailyReports = await logged("partner_book.daily_reports", () => sweepDailyReports(this, nowIso), () => null as SweepDailyReportsResult | null, (r) => ({ ran: r !== null }));
      // 34.4 rule 4: an unconfirmed kill-switch request expires at 10 minutes (logged, nothing trips); a switch tripped more than 24 hours opens one compliance escalation — errors logged, never thrown
      const controls = await logged("controls", async () => ({ kill_requests_expired: await expireKillSwitchRequests(this, nowIso), long_trips_escalated: (await escalateLongTrips(this, nowIso)).length }), () => ({ kill_requests_expired: 0, long_trips_escalated: 0 }), (c) => ({ ...c }));
      // 35.10 rule 10: the refinance closeout pass after 35.6's orchestration (when it lands) and before the breach pass — every open closeout re-evaluated, the owners' tools run from the record; then the daily board once at/after 06:45 ET — errors logged, never thrown
      const refinanceCloseout = await logged("refinance.closeout", () => closeoutPass(this, nowIso, { logger: this.logger }), () => null as CloseoutPassReport | null, (r) => (r ? { opened: r.opened, examined: r.examined, commands: r.commands, failed: r.failed } : { failed: true }));
      const refinanceBoard = await logged("refinance.board", () => closeoutBoardRun(this, nowIso), () => null as BoardRunReport | null, (r) => ({ ran: r?.ran ?? false }));
      const reviewers = this.reviewers ? await logged("fake_reviewers", () => this.reviewers!.tick(this, nowIso), () => null as FakeReviewerReport | null, (r) => ({ ran: r !== null })) : null;
      // rule 13: the daily verify run once per calendar day at/after 06:00 ET — its own global unit of work (the gaps, the mismatches and their escalations, one projection_runs row, `projection.run_completed`); a failed run inserts `failed` and no event
      let verify: VerifyReport | null = null;
      const wc = wallClock(Date.parse(nowIso), "America/New_York");
      if (opts.verify !== false && `${String(wc.hour).padStart(2, "0")}:${String(wc.minute).padStart(2, "0")}` >= VERIFY_AT_ET && !(await verifiedToday(this.db, asOfDate))) {
        verify = await pass("record.verify", async () => {
          let escalations: EscalationService | undefined;
          try {
            const r = await this.uow.run({}, async (ctx) => { escalations = new EscalationService(ctx.events, ctx.clock); return verifyRun({ q: ctx.q!, events: ctx.events, escalations, actor: { kind: "agent", id: "security-records" }, now: ctx.clock.now() }, { as_of_date: asOfDate }); },
              { clock: this.clock, commit: async (q) => { for (const e of escalations?.list() ?? []) await this.escalationRepo.save(e, q); } });
            return r.result;
          } catch (e) { this.logger?.error("verify run failed", { at: nowIso, error: e }); await recordFailedRun(this.db, { as_of_date: asOfDate, started_at: nowIso, now: this.clock.now(), actor: { kind: "agent", id: "security-records" }, error: e instanceof Error ? e.message : String(e) }).catch(() => undefined); return null; }
        }, (v) => (v ? { run_id: v.run_id, gaps: v.gaps, mismatches: v.mismatches, rows_verified: v.rows_verified } : { failed: true }));
      }
      // the breach pass: the due instances (any loan, or global) claimed FOR UPDATE SKIP LOCKED and restored into a fresh engine; evaluate breaches them and appends timer.breached under each timer's own loan — one transaction
      const breaches: SweepReport["breaches"][number][] = [];
      const due = await pass("timers.breach", () => this.db.tx(async (q) => {
        const timerRepo = new PgTimerRepository(q);
        // SM_SWEEP_HEARTBEAT_DAILY breaches only inside a sweep (35.1 edge case 7): a run in progress on the clock's due day is the day's sweep and satisfies it minutes later; the clock breaches when its due day passed with no run at all (a demo advance that sweeps once a day at noon is not an outage)
        const claimed = (await timerRepo.dueForUpdate(nowIso)).filter((t) => t.code !== "SM_SWEEP_HEARTBEAT_DAILY" || (t.dueDate ?? wallClock(t.dueAt ?? Date.parse(nowIso), "America/New_York").date) < asOfDate);
        if (!claimed.length) return claimed;
        const events = new MemoryEventStore(this.clock);
        const engine = new TimerEngine(this.registry, events);
        engine.restore(claimed);
        const escalations = new EscalationService(events, this.clock);
        for (const b of engine.evaluate(nowIso)) {
          const sev = b.severity ?? 4;
          const owner = b.escalateTo[0] ?? "ops_analyst";
          // a §35.10 closeout clock names its closeout: the arming event's application_id, prior_loan_id, step and waiting_on ride on the escalation (T13)
          const arming = b.instance.code.startsWith("SM_REFI_") ? (await q.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM loan_events WHERE id = $1`, [b.instance.armedByEventId]))[0]?.payload ?? null : null;
          escalations.open({ kind: `sev${sev}`, ownerRole: owner, ...(b.instance.loanId ? { loanId: b.instance.loanId } : {}), ...(b.instance.applicationId ? { applicationId: b.instance.applicationId } : {}), severity: String(sev), slaTimerId: b.instance.id,
            payload: { timer_code: b.instance.code, timer_id: b.instance.id, due_at: b.instance.dueAt !== undefined ? new Date(b.instance.dueAt).toISOString() : null, breach: b.breachText, ...breachPayloadOf(arming) } }, { kind: "system", id: "sweep" });
          breaches.push({ loan_id: b.instance.loanId ?? null, code: b.instance.code, severity: b.severity, escalate_to: [...b.escalateTo], timer_id: b.instance.id });
        }
        const persisted = await this.uow.events.append(events.since(0), q);
        await timerRepo.save(engine.all().filter((t) => t.status === "breached"), q);
        for (const e of escalations.list()) await this.escalationRepo.save(e, q);
        this.uow.notifyCommitted(persisted);
        return claimed;
      }), (d) => ({ due: d.length, breaches: breaches.length }));
      // 33.1 T10: the breach action of SM_PARTNER_BOOK_INVITATION_REMINDER_14 — one reminder on the same channel while the party has no session, then nothing more; never fails the sweep
      const partnerBookReminders = await logged("partner_book.reminders", async () => (await sendPartnerBookReminders(this, nowIso)).sent, () => 0, (n) => ({ sent: n }));
      // 33.1 T12 / rule 8: the breach action of SM_PARTNER_BOOK_TAPE_EXPECTED_7 — once per breached clock `partner_book.tape.late` beside the ops_analyst escalation the breach pass opened; a second sweep adds nothing
      const partnerBookTapeLate = await logged("partner_book.tape_late", async () => (await notifyPartnerBookTapeLate(this, nowIso)).late, () => 0, (n) => ({ late: n }));
      // 35.10: each breached closeout clock journaled once on its closeout beside the sweep's escalation — never fails the sweep
      const refinanceBreaches = await logged("refinance.breach_actions", async () => (await closeoutBreachActions(this, nowIso)).journaled, () => 0, (n) => ({ journaled: n }));
      const outbox = await this.db.query<{ adapter: string; status: string; count: string }>(`SELECT adapter, status, count(*)::text AS count FROM integration_messages WHERE status IN ('queued', 'failed') GROUP BY adapter, status ORDER BY adapter, status`).catch(() => []);
      // rule 12: the receipt in its own final transaction — SM_SWEEP_HEARTBEAT_DAILY is satisfied and re-armed by the run that completes; the row is `completed`
      const durationMs = Date.now() - startedMs;
      const outboxCounts = { claimed: outboxDispatch.claimed, sent: outboxDispatch.sent, retried: outboxDispatch.retried, dead: outboxDispatch.dead };
      await this.uow.run({}, (ctx) => ctx.events.append({ type: "sweep.run_completed", aggregate: { kind: "sweep_run", id: runId }, actor: { kind: "system", id: "sweep" }, payload: { run_id: runId, as_of_date: asOfDate, holder, duration_ms: durationMs, passes: passes.map((p) => p.name), due: due.length, breaches: breaches.length, outbox: outboxCounts } }),
        { clock: this.clock, commit: async (q) => { await q.query(`UPDATE sweep_runs SET outcome = 'completed', finished_at = $2, heartbeat_at = $2, passes = $3::jsonb, outbox = $4::jsonb WHERE id = $1`, [runId, this.clock.now(), JSON.stringify(passes), JSON.stringify(outboxCounts)]); } });
      return { at: nowIso, due: due.length, breaches, outbox: outbox.map((o) => ({ adapter: o.adapter, status: o.status, count: Number(o.count) })), refi, reviewers, partner_book_review: partnerBookReview, partner_book_readiness: partnerBookReadiness, partner_book_reminders: partnerBookReminders, partner_book_tape_late: partnerBookTapeLate, partner_book_daily_reports: partnerBookDailyReports, refinance_closeout: refinanceCloseout, refinance_board: refinanceBoard, refinance_breaches: refinanceBreaches, controls,
        run_id: runId, holder, outcome: "completed", skipped_reason: null, passes, outbox_dispatch: outboxDispatch, verify };
    } catch (e) {
      await this.db.query(`UPDATE sweep_runs SET outcome = 'failed', finished_at = $2, heartbeat_at = $2, passes = $3::jsonb, skipped_reason = $4 WHERE id = $1`, [runId, this.clock.now(), JSON.stringify(passes), (e instanceof Error ? e.message : String(e)).slice(0, 500)]).catch(() => undefined);
      throw e;
    } finally { this.sweepRunId = null; await lease.release(); }
  }

  async ready(): Promise<boolean> { try { await this.db.query("SELECT 1"); return true; } catch { return false; } }
}
