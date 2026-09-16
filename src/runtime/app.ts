/**
 * The hosted runtime: every agent tool on the command bus, executed against
 * Postgres through the loan-scoped unit of work.
 *
 *   execute(tool, loan, actor, input)
 *     hydrate entity rows (loan + global) → run the tool through CommandBus
 *     (allowlists, roles, money fields, guardrails, decision record) inside
 *     PgUnitOfWork.run → one transaction commits events, ledger sets, timers,
 *     decisions, entity versions and escalations — or nothing.
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
 * Origination services (sections 20–31): `originationServices` (src/runtime/origination.ts) constructs ONE instance of
 * every stateful section service (25.2's ClosingDisclosureService, 29.1's CommitmentService, 29.3/29.4's delivery
 * services, 21.5's ToleranceService, 21.3's companion service) over forwarding stores that land in the executing
 * command's unit of work, plus the vendor fakes the ops files export (credit reseller, DU, identity/OFAC/fraud, AMC,
 * UCDP, EarlyCheck, PE–WL, warehouse bank, eRegistry, RON, title) and a 21.4 pricing port over 20.4's published sheets —
 * the same `services` keys the section tool files look up, so the HTTP path and the unit harnesses behave identically.
 * Servicing-side section services (BoardingService, CashieringService, …) are not wired yet: a tool that calls
 * `service(rt, …)` for one of those answers 501 until its section's service is given a persistence adapter.
 */
import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "../infra/db/client.ts";
import { PgFakeBlobStore, type ObjectStorePort } from "../infra/blobs/pg-fake-blob-store.ts";
import { noticeServiceFor } from "./documents/notice-sink.ts";
import { documentsSweepPass, type DocumentsSweepReport } from "./documents/sweep.ts";
import { listDuDocuments, type DuDocumentSummary } from "../domain/underwriting/du/persist.ts";
import { listDuPreflight, type PreflightResultRow } from "../domain/underwriting/du/preflight.ts";
import { PgUnitOfWork, type UowResult, type CommittedListener } from "../infra/db/unit-of-work.ts";
import { PgEntityRepository, type EntityScope } from "../infra/db/entities.ts";
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
import { refiDailyRun, type RefiDailyReport } from "./refi-daily.ts";
import { partnerBookReviewRun, type ReviewRunReport } from "./partner-book-review.ts";
import { readinessRun, type ReadinessRunReport } from "./partner-book-readiness.ts";
import type { AnalystLlm } from "./partner-book-analyst.ts";
import { notifyPartnerBookTapeLate, sendPartnerBookReminders } from "./partner-book.ts";
import { sweepDailyReports, type SweepDailyReportsResult } from "./book-ops/routes.ts";
import { escalateLongTrips, expireKillSwitchRequests } from "./controls/ai.ts";
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
  /** 35.2: the object store every artifact's bytes live in — PgFakeBlobStore over `document_blobs` in every nonprod stage (two instances see one bucket); a Cloud Storage port in production (35.12). */
  readonly blobs?: ObjectStorePort;
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
  /** 34.4 rule 4: kill-switch requests no admin confirmed within 10 minutes expired on this pass, and the compliance escalations opened for switches tripped more than 24 hours (src/runtime/controls/ai.ts). */
  readonly controls: { readonly kill_requests_expired: number; readonly long_trips_escalated: number };
  /** 35.2 rule 4: the staged-blob drain every sweep (and, with the e-sign and mail groups, the envelope expiry and the print vendor probe — src/runtime/documents/sweep.ts documentsSweepPass); null when the hook failed. */
  readonly documents: DocumentsSweepReport | null;
}
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
  return new Proxy(inner, { get: (target, prop, receiver) => (prop === "append" ? append : Reflect.get(target, prop, receiver)) });
}

export class Runtime {
  readonly db: Db;
  readonly registry: TimerRegistry;
  readonly agents: AgentRegistry;
  readonly ports: Partial<Ports>;
  readonly noticeRegistry: NoticeRegistry;
  readonly blobs: ObjectStorePort;
  readonly clock: Clock;
  readonly rateFeed: RateFeedPort | null;
  readonly reviewers: FakeReviewers | null;
  readonly analystLlm: AnalystLlm | null;
  readonly logger: Logger | undefined;
  readonly uow: PgUnitOfWork;
  readonly entities: PgEntityRepository;
  readonly escalationRepo: PgEscalationRepository;
  readonly applications: PgApplicationRepository;
  /** The origination section services and vendor ports, one set for the life of the runtime (see origination.ts). */
  readonly originationServices: OriginationServiceSet;
  private readonly bus: CommandBus;
  private readonly tools = new Map<string, ToolDef>();
  /** 32.12 backend delta: the Notice Registry's rendered notices for the life of the runtime (NoticeServiceDeps.notices) — a notice rendered by one command is readable by the next (17.2 runContentChecklist, the borrower flows' plain-language block). In-memory beside the `notices` table; the event log stays the record. */
  readonly noticeMemory = new Map<string, Notice>();

  constructor(deps: RuntimeDeps) {
    this.db = deps.db; this.registry = deps.registry; this.agents = deps.agents ?? new AgentRegistry(); this.ports = deps.ports ?? fakePorts(); this.clock = deps.clock ?? systemClock;
    this.rateFeed = deps.rateFeed ?? null; this.reviewers = deps.reviewers ?? null; this.analystLlm = deps.analystLlm ?? null; this.logger = deps.logger;
    this.blobs = deps.blobs ?? new PgFakeBlobStore(this.db);
    this.noticeRegistry = deps.notices ?? (() => { const r = buildRegistry(); publishAuthored(r); publishSection02(r); registerPreapprovalLetter(r); return r; })();   // 32.8: 2.x's own authored pieces (AUTODRAFT-*, LC-*, SUSP-*) beside the catalog   // DELTA-01: the preapproval letter beside the catalog
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
    store.seed(await this.entities.load(scope));
    const mark = store.versionCount();
    let escalations: EscalationService | undefined;
    // the scope's open escalations an earlier command persisted, so this one can complete them (21.6's reviewer decides the escalation `recommendDisposition` opened — 32.6 backend delta)
    const openEscalations = await this.escalationRepo.openFor(scope);
    // writes a tool defers to the command's transaction (the borrower surface's UI-owned rows: card_instances, messages, deep_links — src/app/tools/section32-1.ts)
    const deferred: ((q: Queryable) => Promise<void>)[] = [];
    const deferredLate: ((q: Queryable) => Promise<void>)[] = [];
    const r: UowResult<ExecuteResult<unknown>> = await this.uow.run(scope, async (uow) => {
      // a loan-scoped command's events that name neither key are the loan's (the kernel store defaults the application key from the scope; the loan key is defaulted here)
      const ctx = uow.loanId ? { ...uow, events: withDefaultLoan(uow.events, uow.loanId) } : uow;
      escalations = new EscalationService(ctx.events, ctx.clock); escalations.seed(openEscalations);
      // 35.2: the Notice Registry with the artifact layer — every render becomes a stored PDF (PgArtifactSink); its rows are written after the command's other deferred writes (the card rows a borrower-surface tool defers)
      const { notices, sink } = noticeServiceFor(this, ctx, req.actor, (fn) => { deferredLate.push(fn); }, (fn) => { deferred.push(fn); });
      // `agents` (the live registry, so a tool that delegates to another agent's tool keeps the allowlists and AI-off state), `db` (read-only lookups a borrower-surface tool needs) and `deferWrite` (a row committed with the command) ride on the services map
      // `runtime` (this) lets a pass-shaped tool (33.2 review.run / offer.deliver / offer.expire) run the runtime pass it wraps — its own units of work, sequential to this command's
      const rt: ToolRuntime = { store, escalations, services: { ...this.originationServices.forCommand(ctx, store, escalations), agents: this.agents, db: this.db, runtime: this, blobs: this.blobs, ...(sink ? { artifacts: sink } : {}), deferWrite: (fn: (q: Queryable) => Promise<void>) => { deferred.push(fn); } }, ports: this.ports, ...(notices ? { notices } : {}) };
      const cmd = bindTools(rt, this.agents, [def]).get(toolKey(def.process, def.name))!;
      return this.bus.execute(cmd, req.actor, req.input, ctx, { ...(req.run ? { run: req.run } : {}), ...(req.approvedBy ? { approvedBy: req.approvedBy } : {}) });
    }, { clock: this.clock, commit: async (q) => {
      await this.entities.save(store.versionsSince(mark), scope, q);
      for (const e of escalations?.list() ?? []) await this.escalationRepo.save(e, q);
      for (const fn of deferred) await fn(q);
      for (const fn of deferredLate) await fn(q);
    } });
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
   * The scheduled pass: the daily refinance check (when a rate feed is wired) and the FAKE reviewers (when on) first — both
   * commit through the command bus, so what they satisfy is never breached below — then breach every armed timer past due
   * at `nowIso`; one escalation per breach to the registry's first escalation role. One transaction for the breach pass.
   * Neither daily pass can fail the sweep: a failure is logged and reported, the breach pass still runs.
   */
  async sweep(nowIso: string = this.clock.now()): Promise<SweepReport> {
    let refi: RefiDailyReport | null = null;
    if (this.rateFeed) {
      try { refi = await refiDailyRun(this, nowIso, { feed: this.rateFeed, logger: this.logger }); }
      catch (e) { const msg = e instanceof Error ? e.message : String(e); this.logger?.error("refi daily run failed", { at: nowIso, error: e }); refi = { at: nowIso, as_of_date: nowIso.slice(0, 10) as RefiDailyReport["as_of_date"], ran: false, reason: `failed: ${msg}`, rate_sheet: null, universe: { view_rows: 0, loaded: 0, unchanged: 0, skipped: [], monitored: { rows: 0, skipped: 0, open_offer: 0 } }, programs: [], line: `refi daily: failed (${msg})` }; }
    }
    // 33.2: the daily review of the partner book after the refinance check (it reads the day's run) — errors logged, never thrown
    let partnerBookReview: ReviewRunReport;
    try { partnerBookReview = await partnerBookReviewRun(this, nowIso, { logger: this.logger, llm: this.analystLlm }); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); this.logger?.error("partner book review run failed", { at: nowIso, error: e }); partnerBookReview = { at: nowIso, as_of_date: nowIso.slice(0, 10) as ReviewRunReport["as_of_date"], ran: false, reason: `failed: ${msg}`, monitored_loans: 0, programs: [], line: `partner book review: failed (${msg})` }; }
    // 33.3: the daily readiness pass after the review (it reads the day's verdicts) — errors logged, never thrown
    let partnerBookReadiness: ReadinessRunReport;
    try { partnerBookReadiness = await readinessRun(this, nowIso, { logger: this.logger }); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); this.logger?.error("partner book readiness run failed", { at: nowIso, error: e }); partnerBookReadiness = { checked: 0, ready: 0, not_ready: 0, skipped: `failed: ${msg}`, as_of_date: nowIso.slice(0, 10), ran: false, loans_skipped: [], line: `partner book readiness: failed (${msg})` }; }
    // 34.3 rule 6: after the readiness pass, the daily report per partner-day (idempotent — appended only when something changed) and, from 07:45 ET, the ops_analyst escalation for a day without its receipts — errors logged, never thrown
    let partnerBookDailyReports: SweepDailyReportsResult | null = null;
    try { partnerBookDailyReports = await sweepDailyReports(this, nowIso); }
    catch (e) { this.logger?.error("partner book daily reports failed", { at: nowIso, error: e }); }
    // 34.4 rule 4: an unconfirmed kill-switch request expires at 10 minutes (logged, nothing trips); a switch tripped more than 24 hours opens one compliance escalation — errors logged, never thrown
    let controls: SweepReport["controls"] = { kill_requests_expired: 0, long_trips_escalated: 0 };
    try { controls = { kill_requests_expired: await expireKillSwitchRequests(this, nowIso), long_trips_escalated: (await escalateLongTrips(this, nowIso)).length }; }
    catch (e) { this.logger?.error("controls sweep failed", { at: nowIso, error: e }); }
    let reviewers: FakeReviewerReport | null = null;
    if (this.reviewers) { try { reviewers = await this.reviewers.tick(this, nowIso); } catch (e) { this.logger?.error("fake reviewers failed", { at: nowIso, error: e }); } }
    const due = await this.uow.timers.due(nowIso);
    const breaches: SweepReport["breaches"][number][] = [];
    if (due.length) {
      // the due instances (any loan, or global) restored into a fresh engine: evaluate breaches them and appends timer.breached under each timer's own loan
      await this.db.tx(async (q) => {
        const events = new MemoryEventStore(this.clock);
        const engine = new TimerEngine(this.registry, events);
        engine.restore(due);
        const escalations = new EscalationService(events, this.clock);
        for (const b of engine.evaluate(nowIso)) {
          const sev = b.severity ?? 4;
          const owner = b.escalateTo[0] ?? "ops_analyst";
          escalations.open({ kind: `sev${sev}`, ownerRole: owner, ...(b.instance.loanId ? { loanId: b.instance.loanId } : {}), severity: String(sev), slaTimerId: b.instance.id,
            payload: { timer_code: b.instance.code, timer_id: b.instance.id, due_at: b.instance.dueAt !== undefined ? new Date(b.instance.dueAt).toISOString() : null, breach: b.breachText } }, { kind: "system", id: "sweep" });
          breaches.push({ loan_id: b.instance.loanId ?? null, code: b.instance.code, severity: b.severity, escalate_to: [...b.escalateTo], timer_id: b.instance.id });
        }
        const persisted = await this.uow.events.append(events.since(0), q);
        await this.uow.timers.save(engine.all().filter((t) => t.status === "breached"), q);
        for (const e of escalations.list()) await this.escalationRepo.save(e, q);
        return persisted;
      }).then((persisted) => this.uow.notifyCommitted(persisted));
    }
    // 33.1 T10: the breach action of SM_PARTNER_BOOK_INVITATION_REMINDER_14 — one reminder on the same channel while the party has no session, then nothing more; never fails the sweep
    let partnerBookReminders = 0;
    try { partnerBookReminders = (await sendPartnerBookReminders(this, nowIso)).sent; } catch (e) { this.logger?.error("partner book reminders failed", { at: nowIso, error: e }); }
    // 33.1 T12 / rule 8: the breach action of SM_PARTNER_BOOK_TAPE_EXPECTED_7 — once per breached clock `partner_book.tape.late` beside the ops_analyst escalation the breach pass opened; a second sweep adds nothing
    let partnerBookTapeLate = 0;
    try { partnerBookTapeLate = (await notifyPartnerBookTapeLate(this, nowIso)).late; } catch (e) { this.logger?.error("partner book tape-late notice failed", { at: nowIso, error: e }); }
    // 35.2 rule 4: the staged-blob drain every sweep, one command per subject so each document.stored satisfies its own SM_DOC_WORM_DRAIN_1D — errors logged, never thrown
    let documents: DocumentsSweepReport | null = null;
    try { documents = await documentsSweepPass(this, nowIso); } catch (e) { this.logger?.error("documents sweep failed", { at: nowIso, error: e }); }
    const outbox = await this.db.query<{ adapter: string; status: string; count: string }>(`SELECT adapter, status, count(*)::text AS count FROM integration_messages WHERE status IN ('queued', 'failed') GROUP BY adapter, status ORDER BY adapter, status`).catch(() => []);
    return { at: nowIso, due: due.length, breaches, outbox: outbox.map((o) => ({ adapter: o.adapter, status: o.status, count: Number(o.count) })), refi, reviewers, partner_book_review: partnerBookReview, partner_book_readiness: partnerBookReadiness, partner_book_reminders: partnerBookReminders, partner_book_tape_late: partnerBookTapeLate, partner_book_daily_reports: partnerBookDailyReports, controls, documents };
  }

  async ready(): Promise<boolean> { try { await this.db.query("SELECT 1"); return true; } catch { return false; } }
}
