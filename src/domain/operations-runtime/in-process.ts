/**
 * §35.5 — the in-process command bus a cashiering unit runs the owning engines' commands on (build plan v2 D1): one unit of work per
 * loan-day, the 2.1 / 2.7 / 2.3 commands executed inside it as bus commands (allowlists, guardrails, `command.executed`, the decision
 * record) — never a nested `Runtime.execute`, so a unit is one transaction and 35.1's per-loan lock has one holder.
 *
 *   openUnit(rt, scope)               before the unit of work: the scope, the empty store and the deferred writes — what src/runtime/app.ts
 *                                     executeDef prepares for a hosted command (the rows are read inside the transaction, below).
 *   bindUnit(rt, opened, uow)         inside the unit of work, after its lock: the scope's records by the loan / application index (one query — see
 *                                     the note in the body on why not 35.1's `entity_latest_scoped` load), the scope's
 *                                     open escalations, and the ToolRuntime the commands see (store, escalations, notices, `services`: agents,
 *                                     db, runtime, deferWrite) over the unit's context — no stateful section service (35.1 rule 9's
 *                                     `forCommand` is the hosted command's; the 2.1 / 2.7 / 2.3 / 6.5 commands a unit runs read none).
 *   executeInUnit(rt, bound, req)     one bus command on that runtime: `toolCommand(def, …)` (src/app/tools.ts) + `CommandBus.execute`.
 *   commitUnit(q, rt, bound)          the commit hook, what executeDef's commit persists for a hosted command: the entity versions split by
 *                                     scope (rule 8: a bumped global row stays global), 35.1 rule 2's projectors — the row phase, then the
 *                                     fact phase — in the unit's transaction (a typed `payments` row 0151's FK on
 *                                     `loan_installments.satisfied_by_payment_id` needs exists before the deferred write that names it),
 *                                     the escalations, the deferred writes.
 *
 * Shared by the daily unit (cashiering-cycle.ts) and the lockbox and ACH runners (lockbox.ts, ach.ts). A unit run INSIDE `cycles.run_unit`'s
 * command (the `cashiering_daily` cycle) needs none of this: the command's own store, hooks and projectors are the unit's (cashieringUnitIn).
 */
import type { Queryable } from "../../infra/db/client.ts";
import type { EntityScope } from "../../infra/db/entities.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { CommandBus, type CommandContext, type ExecuteResult } from "../../app/commands.ts";
import { loadAgentsFile } from "../../app/agents.ts";
import { EscalationService, type Escalation } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolInput, type ToolRuntime } from "../../app/tools.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { noticeServiceFor } from "../../runtime/documents/notice-sink.ts";
import { MemoryEventStore } from "../../kernel/events/index.ts";
import type { Runtime } from "../../runtime/app.ts";
import { splitByScope } from "./seam/hydration.ts";
import { projectVersions } from "./seam/project.ts";

export interface OpenedUnit { readonly scope: EntityScope; readonly store: EntityStore; mark: number; openEscalations: readonly Escalation[]; globalKeys: ReadonlySet<string>; readonly deferred: ((q: Queryable) => Promise<void>)[]; readonly deferredLate: ((q: Queryable) => Promise<void>)[]; }
export interface BoundUnit extends OpenedUnit { readonly ctx: UowContext; readonly escalations: EscalationService; readonly toolRt: ToolRuntime; readonly deferWrite: (fn: (q: Queryable) => Promise<void>) => void; }

/** The unit of work's store with the scope's loan stamped on every appended event that carries neither a loan nor an application key (app.ts withDefaultLoan). */
export function withDefaultLoan(inner: MemoryEventStore, loanId: string): MemoryEventStore {
  const append: MemoryEventStore["append"] = (input) => inner.append(input.loanId === undefined && input.applicationId === undefined ? { ...input, loanId } : input);
  return new Proxy(inner, { get: (target, prop, receiver) => (prop === "append" ? append : Reflect.get(target, prop, receiver)) });
}

/** The unit before its transaction: nothing is read here — the rows are hydrated inside the transaction, after the lock (35.1 rules 6 and 7). */
export async function openUnit(_rt: Runtime, scope: EntityScope): Promise<OpenedUnit> {
  return { scope, store: new EntityStore(), mark: 0, openEscalations: [], globalKeys: new Set(), deferred: [], deferredLate: [] };
}

/** The actor 35.2's document events name for a notice a unit renders (the unit's commands run as the cashiering agent). */
const UNIT_ACTOR: Actor = { kind: "agent", id: "cashiering" };
export async function bindUnit(rt: Runtime, opened: OpenedUnit, uow: UowContext, actor: Actor = UNIT_ACTOR): Promise<BoundUnit> {
  const ctx: UowContext = uow.loanId ? { ...uow, events: withDefaultLoan(uow.events, uow.loanId) } : uow;
  // the unit's rows, read after its lock: the scope's records (and the global ones) by the loan / application index — one query on entity_records.
  // (35.1 rule 6's `entity_latest_scoped` load is the hosted command's: its DISTINCT ON re-sorts every record for each read, which a whole-book
  // pass of 94 loan-days a day cannot afford — the demo advance's 45 days have a 240 s budget; a unit's scope is one loan, its history small)
  const q = uow.q;
  opened.store.seed(await rt.entities.load(opened.scope));
  opened.mark = opened.store.versionCount();
  opened.openEscalations = await rt.escalationRepo.openFor(opened.scope, q);
  const escalations = new EscalationService(ctx.events, ctx.clock); escalations.seed(opened.openEscalations);
  const deferWrite = (fn: (q: Queryable) => Promise<void>): void => { opened.deferred.push(fn); };
  // 35.2: the Notice Registry with the artifact layer, as executeDef wires it — a notice a unit's command renders (2.3's variable-amount and return notices) becomes a stored PDF; the document row rides the unit's deferred writes in push order, the notice rows after every tool's (commitUnit)
  const { notices, sink } = noticeServiceFor(rt, ctx, actor, (fn) => { opened.deferredLate.push(fn); }, deferWrite);
  // no stateful section service rides here (35.1 rule 9's `forCommand` is the hosted command's): a 35.5 unit runs 2.1 / 2.7 / 2.3 / 6.5 commands, none of which reads one, and rebuilding eleven services per loan-day would cost the demo advance its budget
  const toolRt: ToolRuntime = { store: opened.store, escalations, services: { agents: rt.agents, db: rt.db, runtime: rt, blobs: rt.blobs, ...(sink ? { artifacts: sink } : {}), deferWrite }, ports: rt.ports, ...(notices ? { notices } : {}) };
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

/** The unit's commit hook: what executeDef's commit persists for a hosted command (the entity versions by scope, 35.1's projectors in both phases, the escalations, the deferred writes). */
export async function commitUnit(q: Queryable, rt: Runtime, bound: BoundUnit, info: { readonly firstEventId?: string | null } = {}): Promise<void> {
  const { global, scoped } = splitByScope(bound.store.versionsSince(bound.mark), bound.globalKeys);
  const now = rt.clock.now(); const commandEventId = info.firstEventId ?? null;
  // 35.1 rule 2: the row projectors (a kind a typed table references by foreign key), then the entity records, then the fact projectors — one transaction
  await projectVersions(q, { phase: "before", versions: global, scope: {}, now, commandEventId });
  await projectVersions(q, { phase: "before", versions: scoped, scope: bound.scope, now, commandEventId });
  await rt.entities.save(global, null, q);
  await rt.entities.save(scoped, bound.scope, q);
  await projectVersions(q, { phase: "commit", versions: global, scope: {}, now, commandEventId });
  await projectVersions(q, { phase: "commit", versions: scoped, scope: bound.scope, now, commandEventId });
  for (const e of bound.escalations.list()) await rt.escalationRepo.save(e, q);
  for (const fn of bound.deferred) await fn(q);
  for (const fn of bound.deferredLate) await fn(q);   // 35.2: the sink's notice rows after every tool's deferred writes (executeDef's order)
}

export type { CommandContext };
