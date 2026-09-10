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
 *     breach every armed timer whose due instant has passed (timer.breached
 *     events, an escalation per breach to the registry's escalation role) and
 *     report the integration outbox backlog. Cloud Scheduler runs it every
 *     minute as the `sweep` job; the API also exposes it on POST /v1/sweep.
 *
 * Section domain services (BoardingService, CashieringService, …) are not
 * wired yet: a tool that calls `service(rt, …)` answers 501 until its section's
 * service is given a persistence adapter.
 */
import type { Db } from "../infra/db/client.ts";
import { PgUnitOfWork, type UowResult } from "../infra/db/unit-of-work.ts";
import { PgEntityRepository } from "../infra/db/entities.ts";
import { AgentRegistry } from "../app/agents.ts";
import { CommandBus, type AgentRunInfo, type ExecuteResult } from "../app/commands.ts";
import { EntityStore, type Ports, type ToolDef, type ToolInput, type ToolRuntime } from "../app/tools.ts";
import { ALL_TOOLS, bindTools, toolKey } from "../app/tools/index.ts";
import { EscalationService, PgEscalationRepository } from "../app/escalations.ts";
import { NoticeService } from "../notices/service.ts";
import { buildRegistry, publishAuthored } from "../notices/catalog.ts";
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

export interface RuntimeDeps {
  readonly db: Db;
  readonly registry: TimerRegistry;
  readonly agents?: AgentRegistry;
  readonly ports?: Partial<Ports>;
  readonly notices?: NoticeRegistry;
  readonly clock?: Clock;
}
export interface ExecuteRequest { readonly process: string; readonly name: string; readonly loanId: string; readonly actor: Actor; readonly input: ToolInput; readonly run?: AgentRunInfo; readonly approvedBy?: Actor; }
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
}
export class ToolNotFound extends Error { constructor(process: string, name: string) { super(`no tool ${name} in process ${process}`); this.name = "ToolNotFound"; } }

/** Every vendor port wired to its in-memory test double (INTEGRATIONS=fake). */
export function fakePorts(): Ports {
  const lsdu = new FakeFnmaLsdu();
  return { lockbox: new FakeLockbox(), custodialBank: new FakeCustodialBank(), nacha: new FakeOdfi(), metro2: new FakeMetro2(), eoscar: new FakeEoscar(), custodian: new FakeCustodian(), evault: new FakeEvault(),
    printMail: new FakePrintMail(), edelivery: new FakeEdelivery(), telephony: new FakeTelephony(), lsdu, servicingEvents: new FakeFnmaServicingEvents(), smdu: new FakeFnmaSmdu(), p360: new FakeFnmaP360(),
    connect: new FakeFnmaConnect(), pacer: new FakePacer(), dmdc: new FakeDmdc(), erecording: new FakeErecording(), mers: new FakeMers(), lpi: new FakeLpiTracking(), flood: new FakeFlood(), taxService: new FakeTaxService(), mi: new FakeMi() };
}

export class Runtime {
  readonly db: Db;
  readonly registry: TimerRegistry;
  readonly agents: AgentRegistry;
  readonly ports: Partial<Ports>;
  readonly noticeRegistry: NoticeRegistry;
  readonly clock: Clock;
  readonly uow: PgUnitOfWork;
  readonly entities: PgEntityRepository;
  readonly escalationRepo: PgEscalationRepository;
  private readonly bus: CommandBus;
  private readonly tools = new Map<string, ToolDef>();

  constructor(deps: RuntimeDeps) {
    this.db = deps.db; this.registry = deps.registry; this.agents = deps.agents ?? new AgentRegistry(); this.ports = deps.ports ?? fakePorts(); this.clock = deps.clock ?? systemClock;
    this.noticeRegistry = deps.notices ?? (() => { const r = buildRegistry(); publishAuthored(r); return r; })();
    this.uow = new PgUnitOfWork(this.db, this.registry); this.entities = new PgEntityRepository(this.db); this.escalationRepo = new PgEscalationRepository(this.db);
    this.bus = new CommandBus(this.agents);
    for (const t of ALL_TOOLS) { this.tools.set(toolKey(t.process, t.name), t); this.agents.registerTool(t.agent, t.name); }
  }

  listTools(): { process: string; name: string; agent: string; kind: string; humanOnly: boolean }[] {
    return [...this.tools.values()].map((t) => ({ process: t.process, name: t.name, agent: t.agent, kind: t.kind, humanOnly: t.humanOnly === true }));
  }
  tool(process: string, name: string): ToolDef | undefined { return this.tools.get(toolKey(process, name)); }

  async execute(req: ExecuteRequest): Promise<ExecuteResponse> {
    const def = this.tool(req.process, req.name);
    if (!def) throw new ToolNotFound(req.process, req.name);
    const store = new EntityStore();
    store.seed(await this.entities.load(req.loanId));
    const mark = store.versionCount();
    let escalations: EscalationService | undefined;
    const r: UowResult<ExecuteResult<unknown>> = await this.uow.run(req.loanId, async (ctx) => {
      escalations = new EscalationService(ctx.events, ctx.clock);
      const notices = this.ports.printMail && this.ports.edelivery ? new NoticeService({ registry: this.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: this.ports.printMail, edelivery: this.ports.edelivery }) : undefined;
      const rt: ToolRuntime = { store, escalations, services: {}, ports: this.ports, ...(notices ? { notices } : {}) };
      const cmd = bindTools(rt, this.agents, [def]).get(toolKey(def.process, def.name))!;
      return this.bus.execute(cmd, req.actor, req.input, ctx, { ...(req.run ? { run: req.run } : {}), ...(req.approvedBy ? { approvedBy: req.approvedBy } : {}) });
    }, { clock: this.clock, commit: async (q) => {
      await this.entities.save(store.versionsSince(mark), req.loanId || null, q);
      for (const e of escalations?.list() ?? []) await this.escalationRepo.save(e, q);
    } });
    return { output: r.result.output, ...(r.result.decisionId ? { decisionId: r.result.decisionId } : {}), event: r.result.event, events: r.events, timers: r.timers,
      decisions: r.decisions.map((d) => ({ id: d.id })), escalations: (escalations?.list() ?? []).map((e) => ({ id: e.id, kind: e.kind, ownerRole: e.ownerRole })) };
  }

  /** Breach every armed timer past due at `nowIso`; one escalation per breach to the registry's first escalation role. One transaction for the pass. */
  async sweep(nowIso: string = this.clock.now()): Promise<SweepReport> {
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
        await this.uow.events.append(events.since(0), q);
        await this.uow.timers.save(engine.all().filter((t) => t.status === "breached"), q);
        for (const e of escalations.list()) await this.escalationRepo.save(e, q);
      });
    }
    const outbox = await this.db.query<{ adapter: string; status: string; count: string }>(`SELECT adapter, status, count(*)::text AS count FROM integration_messages WHERE status IN ('queued', 'failed') GROUP BY adapter, status ORDER BY adapter, status`).catch(() => []);
    return { at: nowIso, due: due.length, breaches, outbox: outbox.map((o) => ({ adapter: o.adapter, status: o.status, count: Number(o.count) })) };
  }

  async ready(): Promise<boolean> { try { await this.db.query("SELECT 1"); return true; } catch { return false; } }
}
