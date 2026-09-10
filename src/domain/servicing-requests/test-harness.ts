/**
 * Test harness for the §4 acceptance tests: a loan-scoped unit of work with the timer engine on the overridden registry
 * (4.1–4.5 rows), the entity store, escalations, and the §4 commands bound on the command bus — the spec tool strings
 * (SECTION_04_TOOLS: `callback.schedule`, `human.transfer`, `contact.log`, …) and the case commands
 * (SECTION_04_CASE_COMMANDS) for the `case` / `borrower-comms` agents — the same bus the ops console uses, so every T-id
 * runs through the real guardrails. Not a test file itself.
 */
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import type { CommandSpec, ExecuteResult } from "../../app/commands.ts";
import { SECTION_04_CASE_COMMANDS, SECTION_04_TOOLS } from "../../app/tools/section04.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, type TimerInstance } from "../../kernel/timers/index.ts";
import type { CalendarSet } from "../../kernel/calendar/business.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

export const CASE_AGENT: Actor = { kind: "agent", id: "case" };
export const COMMS_AGENT: Actor = { kind: "agent", id: "borrower-comms" };
export const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
export const ATTORNEY: Actor = { kind: "human", id: "u-attorney", role: "attorney" };
export const ANALYST: Actor = { kind: "human", id: "u-analyst", role: "ops_analyst" };
export const SECTION_04_PROCESSES = ["4.1", "4.2", "4.3", "4.4", "4.5"] as const;

export interface Harness {
  readonly clock: FixedClock; readonly events: MemoryEventStore; readonly ctx: UowContext & { decisions: DecisionInput[] }; readonly rt: ToolRuntime; readonly agents: AgentRegistry; readonly bus: CommandBus;
  readonly cmds: Map<string, CommandSpec<ToolInput, unknown>>; readonly decisions: DecisionInput[];
  /** Execute a §4 command on the bus; `at` moves the clock first. */
  run(process: string, name: string, actor: Actor, input: ToolInput, at?: string): Promise<ExecuteResult<unknown>>;
  /** Timer instances armed for the code (any status). */
  timer(code: string): readonly TimerInstance[];
  /** The officer (or attorney) records the approval an agent's approval-gated command then cites — `case.approval.record` on the bus. */
  approve(actor: Actor, f: { approval_id: string; case_id: string; scope: string; amount_cents?: bigint; rationale?: string }): Promise<ExecuteResult<unknown>>;
}
export function harness(nowIso = "2026-09-04T14:00:00.000Z", loanId = "L-1", calendars?: CalendarSet): Harness {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: [...SECTION_04_PROCESSES], ...(calendars ? { calendars } : {}) });
  const ctx: UowContext & { decisions: DecisionInput[] } = { loanId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push({ loanId, ...d }); }, decisions };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry();
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of [...SECTION_04_TOOLS, ...SECTION_04_CASE_COMMANDS]) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(`${d.process} ${d.name}`, cmd); }
  const bus = new CommandBus(agents);
  const run: Harness["run"] = (process, name, actor, input, at) => { if (at) clock.set(at); const cmd = cmds.get(`${process} ${name}`); if (!cmd) throw new RangeError(`no §4 command ${process} ${name}`); return bus.execute(cmd, actor, input, ctx); };
  return {
    clock, events, ctx, rt, agents, bus, cmds, decisions, run,
    timer: (code) => timers.byCode(code),
    approve: (actor, f) => run("4.1", "case.approval.record", actor, { approval_id: f.approval_id, case_id: f.case_id, scope: f.scope, ...(f.amount_cents !== undefined ? { amount_cents: f.amount_cents } : {}), rationale: f.rationale ?? "approved on review of the package" }),
  };
}
/** assert.rejects matcher: a CommandRefused with the given guardrail code. */
export const refusedWith = (code: string) => (e: unknown): boolean => e instanceof CommandRefused && e.code === code;
