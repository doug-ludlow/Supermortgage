/**
 * §35.5 — the in-process command bus a cashiering unit runs the owning engines' commands on (build plan v2 D1): one unit of work per
 * loan-day, the 2.1 / 2.7 / 2.3 commands executed inside it as bus commands (allowlists, guardrails, `command.executed`, the decision
 * record) — never a nested `Runtime.execute`, so a unit is one transaction and 35.1's per-loan lock has one holder.
 *
 *   openUnit(rt, scope)               before the unit of work: the entity store seeded from the scope's rows, the mark, the scope's open
 *                                     escalations, the deferred writes — what src/runtime/app.ts executeDef prepares for a hosted command.
 *   bindUnit(rt, opened, uow)         inside the unit of work: the ToolRuntime the commands see (store, escalations, notices, `services`:
 *                                     the origination services, agents, db, runtime, deferWrite) over the unit's context.
 *   executeInUnit(rt, bound, req)     one bus command on that runtime: `toolCommand(def, …)` (src/app/tools.ts) + `CommandBus.execute`.
 *   commitUnit(q, rt, bound, scope)   the commit hook: entity versions, escalations, the deferred writes — in the unit's transaction.
 *
 * Shared by the daily unit (cashiering-cycle.ts) and, in the later groups, the lockbox and ACH runners.
 */
import type { Queryable } from "../../infra/db/client.ts";
import type { EntityScope } from "../../infra/db/entities.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { CommandBus, type CommandContext, type ExecuteResult } from "../../app/commands.ts";
import { loadAgentsFile } from "../../app/agents.ts";
import { EscalationService, type Escalation } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolInput, type ToolRuntime } from "../../app/tools.ts";
import { NoticeService } from "../../notices/service.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { MemoryEventStore } from "../../kernel/events/index.ts";
import type { Runtime } from "../../runtime/app.ts";

export interface OpenedUnit { readonly scope: EntityScope; readonly store: EntityStore; readonly mark: number; readonly openEscalations: readonly Escalation[]; readonly deferred: ((q: Queryable) => Promise<void>)[]; }
export interface BoundUnit extends OpenedUnit { readonly ctx: UowContext; readonly escalations: EscalationService; readonly toolRt: ToolRuntime; readonly deferWrite: (fn: (q: Queryable) => Promise<void>) => void; }

/** The unit of work's store with the scope's loan stamped on every appended event that carries neither a loan nor an application key (app.ts withDefaultLoan). */
export function withDefaultLoan(inner: MemoryEventStore, loanId: string): MemoryEventStore {
  const append: MemoryEventStore["append"] = (input) => inner.append(input.loanId === undefined && input.applicationId === undefined ? { ...input, loanId } : input);
  return new Proxy(inner, { get: (target, prop, receiver) => (prop === "append" ? append : Reflect.get(target, prop, receiver)) });
}

export async function openUnit(rt: Runtime, scope: EntityScope): Promise<OpenedUnit> {
  const store = new EntityStore(); store.seed(await rt.entities.load(scope));
  return { scope, store, mark: store.versionCount(), openEscalations: await rt.escalationRepo.openFor(scope), deferred: [] };
}

export function bindUnit(rt: Runtime, opened: OpenedUnit, uow: UowContext): BoundUnit {
  const ctx: UowContext = uow.loanId ? { ...uow, events: withDefaultLoan(uow.events, uow.loanId) } : uow;
  const escalations = new EscalationService(ctx.events, ctx.clock); escalations.seed(opened.openEscalations);
  const notices = rt.ports.printMail && rt.ports.edelivery ? new NoticeService({ registry: rt.noticeRegistry, events: ctx.events, clock: ctx.clock, printMail: rt.ports.printMail, edelivery: rt.ports.edelivery, notices: rt.noticeMemory }) : undefined;
  const deferWrite = (fn: (q: Queryable) => Promise<void>): void => { opened.deferred.push(fn); };
  const toolRt: ToolRuntime = { store: opened.store, escalations, services: { ...rt.originationServices.forCommand(ctx, opened.store, escalations), agents: rt.agents, db: rt.db, runtime: rt, deferWrite }, ports: rt.ports, ...(notices ? { notices } : {}) };
  return { ...opened, ctx, escalations, toolRt, deferWrite };
}

let escalatesCache: Map<string, readonly string[]> | null = null;
const escalatesFor = (process: string): readonly string[] => { escalatesCache ??= new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const)); return escalatesCache.get(process) ?? []; };

export interface InUnitRequest { readonly process: string; readonly name: string; readonly input: ToolInput; readonly actor: Actor; }
/** One registry tool executed on the unit's context through the command bus — the same shape as src/app/tools.test.ts's unit harness and app.ts executeDef. */
export async function executeInUnit(rt: Runtime, bound: BoundUnit, req: InUnitRequest): Promise<ExecuteResult<unknown>> {
  const def = rt.tool(req.process, req.name);
  if (!def) throw new RangeError(`no tool ${req.name} in process ${req.process}`);
  const cmd = toolCommand(def, bound.toolRt, escalatesFor(def.process));
  rt.agents.registerTool(def.agent, cmd.name);
  return new CommandBus(rt.agents).execute(cmd, req.actor, req.input, bound.ctx);
}

/** The unit's commit hook: what executeDef's commit persists for a hosted command (entities, escalations, the deferred writes). */
export async function commitUnit(q: Queryable, rt: Runtime, bound: BoundUnit): Promise<void> {
  await rt.entities.save(bound.store.versionsSince(bound.mark), bound.scope, q);
  for (const e of bound.escalations.list()) await rt.escalationRepo.save(e, q);
  for (const fn of bound.deferred) await fn(q);
}

export type { CommandContext };
