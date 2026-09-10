/**
 * Bus harness for the §10 acceptance tests: the §10 tools bound to an
 * in-memory runtime (entity store, Fake MI/SMDU/print-mail/e-delivery ports,
 * escalations, the Notice Registry with the authored §10 versions) over a
 * unit-of-work whose TimerEngine runs the overridden registry for processes
 * 10.1–10.6 — so a test can raise the spec's trigger events, execute the
 * agent's commands and read the armed/satisfied/breached timers back.
 */
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { SECTION_10_TOOLS } from "../../app/tools/section10.ts";
import { attachDisclosureHooks_10_4 } from "./ops-10-4.ts";
import { attachDenialHooks_10_6 } from "./ops-10-6.ts";
import { TOOLS_10_5 } from "../../app/tools/section10-5.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, type TimerInstance } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry } from "../../notices/catalog.ts";
import { publishCheck } from "../../notices/checklist.ts";
import { SECTION_10_VERSIONS } from "../../notices/authored/section10.ts";
import type { NoticeRegistry } from "../../notices/registry.ts";
import type { Recipient } from "../../notices/channel.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { FakeMi } from "../../infra/integrations/property.ts";
import { FakeFnmaSmdu } from "../../infra/integrations/fnma.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

export const PMI_AGENT: Actor = { kind: "agent", id: "pmi" };
export const HUMAN_AGENT: Actor = { kind: "human", id: "u-agent", role: "human_agent" };
export const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
export const BORROWER: readonly Recipient[] = [{ partyId: "B1", name: "Test Borrower", mailingAddress: "1 Test St, Testville TX 75001" }];
export const PROCESSES_10 = ["10.1", "10.2", "10.3", "10.4", "10.5", "10.6"] as const;

export interface Harness {
  readonly loanId: string;
  readonly clock: FixedClock;
  readonly events: MemoryEventStore;
  readonly timers: TimerEngine;
  readonly ctx: UowContext & { decisions: DecisionInput[] };
  readonly rt: ToolRuntime;
  readonly bus: CommandBus;
  readonly escalations: EscalationService;
  readonly mi: FakeMi;
  readonly smdu: FakeFnmaSmdu;
  readonly notices: NoticeService;
  readonly registry: NoticeRegistry;
  /** Execute a §10 tool through the bus. */
  run(process: string, tool: string, input: ToolInput, actor?: Actor): Promise<unknown>;
  /** Execute and expect a guardrail refusal; returns the refusal. */
  refused(process: string, tool: string, input: ToolInput, actor?: Actor): Promise<CommandRefused>;
  /** Raise a spec trigger event on the loan (what the portal, cashiering, boarding or Fannie Mae would emit). */
  raise(type: string, payload: Record<string, unknown>, actor?: Actor): DomainEvent;
  /** Timer instances of a code on the loan, oldest first. */
  timer(code: string): readonly TimerInstance[];
  /** The newest instance of a code on the loan. */
  latest(code: string): TimerInstance;
  /** Sample payload of the active authored version (the section's worked example). */
  sample(templateCode: string): Record<string, unknown>;
  /** Event types appended after `sequence`. */
  since(sequence: number): readonly DomainEvent[];
  seq(): number;
}

/** Counsel approval of the §10 authored versions only (each must pass its own checklist), so these tests do not depend on other sections' templates. */
export function publishSection10(reg: NoticeRegistry): NoticeRegistry {
  for (const v of SECTION_10_VERSIONS) reg.publish(v.templateCode, v.version, "counsel", "2026-09-01T00:00:00.000Z", publishCheck);
  return reg;
}

export function harness(nowIso: string, loanId = "L-10", processes: readonly string[] = PROCESSES_10): Harness {
  const clock = new FixedClock(nowIso);
  const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: [...processes] });
  const decisions: DecisionInput[] = [];
  const ctx = { loanId, events, ledger: new MemoryLedger(), timers, clock, decide: (d: Omit<DecisionInput, "loanId">) => { decisions.push({ loanId, ...d }); }, decisions } as UowContext & { decisions: DecisionInput[] };
  const registry = publishSection10(buildRegistry());
  const notices = new NoticeService({ registry, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const escalations = new EscalationService(events, clock);
  const mi = new FakeMi(); mi.certificates.add("CERT-1");
  const smdu = new FakeFnmaSmdu();
  const rt: ToolRuntime = { store: new EntityStore(), ports: { mi, smdu, printMail: new FakePrintMail() }, escalations, notices, services: {} };
  attachDisclosureHooks_10_4({ events, timers, store: rt.store, clock, notices, escalations });   // 10.4 ingestion: MI policy activation from `loan.boarded`, the CA per-statement gate, MI-ended cycle cancel
  attachDenialHooks_10_6({ events, timers, store: rt.store, clock, escalations });                // 10.6 ingestion: the borrower's response (`mi.denial.disputed`) routed to NoE / appeal / human review; `notice.sent` stamps `mi_denials`
  // Bind only the §10 tools (the same binding src/app/tools/index.ts performs for every section), allowlisted to the `pmi` agent.
  const agents = new AgentRegistry();
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map([...SECTION_10_TOOLS, ...TOOLS_10_5].map((d) => { const c = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, c.name); return [`${d.process} ${d.name}`, c] as const; }));
  const bus = new CommandBus(agents);
  const cmd = (process: string, tool: string) => { const c = cmds.get(`${process} ${tool}`); if (!c) throw new RangeError(`no §10 tool ${process} ${tool}`); return c; };
  const forLoan = (code: string) => timers.byCode(code).filter((t) => t.loanId === loanId);
  return {
    loanId, clock, events, timers, ctx, rt, bus, escalations, mi, smdu, notices, registry,
    run: async (process, tool, input, actor = PMI_AGENT) => (await bus.execute(cmd(process, tool), actor, input, ctx)).output,
    refused: async (process, tool, input, actor = PMI_AGENT) => { try { await bus.execute(cmd(process, tool), actor, input, ctx); } catch (e) { if (e instanceof CommandRefused) return e; throw e; } throw new Error(`${process} ${tool} was not refused`); },
    raise: (type, payload, actor = SYSTEM) => events.append({ type, loanId, actor, payload }),
    timer: forLoan,
    latest: (code) => { const l = forLoan(code); if (!l.length) throw new RangeError(`no ${code} instance on ${loanId}`); return l[l.length - 1]!; },
    sample: (code) => ({ ...registry.activeVersion(code, D(clock.now().slice(0, 10)))!.samplePayload }),
    since: (sequence) => events.since(sequence),
    seq: () => events.lastSequence(),
  };
}
