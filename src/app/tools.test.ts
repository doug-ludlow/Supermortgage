/**
 * Agent tools on the bus: every registered tool is one the spec names for
 * its process, is allowlisted to its agent, runs through the bus with the
 * process's guardrails, and read tools leave no decision row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandBus, CommandRefused } from "./commands.ts";
import { AgentRegistry, loadAgentsFile } from "./agents.ts";
import { EscalationService } from "./escalations.ts";
import { EntityStore, type ToolRuntime } from "./tools.ts";
import { ALL_TOOLS, bindTools, toolKey } from "./tools/index.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../kernel/events/index.ts";
import { MemoryLedger } from "../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../kernel/timers/index.ts";
import type { UowContext } from "../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../infra/db/decisions.ts";
import { FakeLockbox, FakeOdfi, FakeCustodialBank } from "../infra/integrations/banking.ts";
import { FakeMers } from "../infra/integrations/mers.ts";
import { FakeFnmaLsdu, FakeFnmaSmdu } from "../infra/integrations/fnma.ts";
import { FakeCustodian } from "../infra/integrations/custody.ts";
import { FakePrintMail } from "../infra/integrations/delivery.ts";

const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const ANALYST: Actor = { kind: "human", id: "u-analyst", role: "ops_analyst" };

function uow(loanId = "L-1"): UowContext & { decisions: DecisionInput[] } {
  const clock = new FixedClock("2026-09-03T09:00:00.000Z");
  const events = new MemoryEventStore(clock);
  const decisions: DecisionInput[] = [];
  return { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: (d) => { decisions.push({ loanId, ...d }); }, decisions };
}
function runtime(ctx: UowContext): ToolRuntime {
  return { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {},
    ports: { lockbox: new FakeLockbox(), nacha: new FakeOdfi(), custodialBank: new FakeCustodialBank(), mers: new FakeMers(), lsdu: new FakeFnmaLsdu(), smdu: new FakeFnmaSmdu(), custodian: new FakeCustodian(), printMail: new FakePrintMail() } };
}

test("every tool on the bus is one the spec names for its process, and each is allowlisted to its agent", () => {
  const spec = new Map(loadAgentsFile().processes.map((p) => [p.process, new Set(p.tools)] as const));
  const seen = new Set<string>();
  for (const t of ALL_TOOLS) {
    assert.ok(spec.get(t.process)?.has(t.name), `${t.process} ${t.name} is not a tool the spec names for ${t.process}`);
    assert.ok(!seen.has(toolKey(t.process, t.name)), `duplicate ${t.process} ${t.name}`); seen.add(toolKey(t.process, t.name));
  }
  const agents = new AgentRegistry(); const ctx = uow(); bindTools(runtime(ctx), agents);
  for (const t of ALL_TOOLS) assert.ok(agents.allows(t.agent, t.name), `${t.agent} may not call ${t.name}`);
});

test("read tools run without a decision row; write tools record one; a refused guardrail writes nothing but the refusal event", async () => {
  const agents = new AgentRegistry(); const ctx = uow(); const rt = runtime(ctx); const cmds = bindTools(rt, agents); const bus = new CommandBus(agents);
  const cashiering: Actor = { kind: "agent", id: "cashiering" };
  // write then read the same payment through the 2.1 tool
  await bus.execute(cmds.get(toolKey("2.1", "payments.read/write"))!, cashiering, { op: "write", id: "P-1", data: { amount_cents: 219_257n, status: "identified", loan_id: "L-1" } }, ctx);
  assert.equal(ctx.decisions.length, 1); assert.equal(ctx.decisions[0]!.action, "payments.read/write:write");
  const r = await bus.execute(cmds.get(toolKey("2.1", "payments.read/write"))!, cashiering, { id: "P-1" }, ctx);
  assert.equal((r.output as { amount_cents: bigint }).amount_cents, 219_257n);
  assert.equal(ctx.decisions.length, 1, "a read leaves no decision row");
  assert.equal(rt.store.history("payments", "P-1").length, 1);
  // 2.1 guardrail: posting below 0.97 confidence without confirmation is refused before anything runs
  const before = ctx.events.all().length;
  await assert.rejects(bus.execute(cmds.get(toolKey("2.1", "payments.read/write"))!, cashiering, { op: "write", id: "P-2", data: { status: "posted", identification_confidence: 0.9 } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "IDENTIFICATION_CONFIDENCE");
  assert.equal(rt.store.get("payments", "P-2"), undefined);
  assert.deepEqual(ctx.events.all().slice(before).map((e) => e.type), ["command.refused"]);
  // the agent cannot change received_on (money-field protection); the officer can
  await assert.rejects(bus.execute(cmds.get(toolKey("2.1", "payments.read/write"))!, cashiering, { op: "write", id: "P-1", changes: { received_on: "2026-09-01" } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "MONEY_FIELD");
  await bus.execute(cmds.get(toolKey("2.1", "payments.read/write"))!, OFFICER, { op: "write", id: "P-1", changes: { received_on: "2026-09-01" } }, ctx);
  assert.equal(rt.store.get("payments", "P-1")!.data.received_on, "2026-09-01");
});

test("officer thresholds: a manual ledger adjustment over $10,000 needs the officer; under it the analyst posts", async () => {
  const agents = new AgentRegistry(); const ctx = uow(); const cmds = bindTools(runtime(ctx), agents); const bus = new CommandBus(agents);
  const set = (amt: bigint) => ({ effectiveDate: "2026-09-03", description: "manual adjustment", lines: [{ account: { scope: "custodial", custodialAccountId: "C-PI", account: "pi_custodial" }, amountCents: amt, ruleRef: "2.1 manual" }, { account: { scope: "custodial", custodialAccountId: "C-CL", account: "clearing" }, amountCents: -amt, ruleRef: "2.1 manual" }] });
  await assert.rejects(bus.execute(cmds.get(toolKey("2.1", "ledger.post"))!, ANALYST, { manual: true, entry_set: set(1_500_000n) }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "MANUAL_ADJUSTMENT_10K");
  const r = await bus.execute(cmds.get(toolKey("2.1", "ledger.post"))!, ANALYST, { manual: true, entry_set: set(900_000n) }, ctx);
  assert.equal(ctx.ledger.sets().length, 1); assert.ok(r.decisionId);
});

test("2.3 nacha.build_entry refuses a debit without an active, validated enrollment and a third NSF retry", async () => {
  const agents = new AgentRegistry(); const ctx = uow(); const cmds = bindTools(runtime(ctx), agents); const bus = new CommandBus(agents);
  const cashiering: Actor = { kind: "agent", id: "cashiering" };
  const cmd = cmds.get(toolKey("2.3", "nacha.build_entry"))!;
  await assert.rejects(bus.execute(cmd, cashiering, { enrollment_id: "E-1", enrollment_status: "pending", facts: { validation_status: "validated_prenote" }, amount_cents: 219_257n, settlement_date: "2026-10-01" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "ENROLLMENT_ACTIVE");
  await assert.rejects(bus.execute(cmd, cashiering, { enrollment_id: "E-1", enrollment_status: "active", facts: { validation_status: "unvalidated" }, amount_cents: 219_257n, settlement_date: "2026-10-01" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "2.3.accountValidated");
  await assert.rejects(bus.execute(cmd, cashiering, { enrollment_id: "E-1", enrollment_status: "active", facts: { validation_status: "validated_prenote" }, nsf_reinitiations: 2, amount_cents: 219_257n, settlement_date: "2026-10-01" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NSF_RETRY_MAX2");
  const r = await bus.execute(cmd, cashiering, { enrollment_id: "E-1", enrollment_status: "active", facts: { validation_status: "validated_prenote" }, amount_cents: 219_257n, settlement_date: "2026-10-01" }, ctx);
  assert.equal((r.output as { trace: string }).trace, "E-1:2026-10-01");
});

test("1.6 postOpeningEntries: absorbing a $30/loan variance needs the officer; $20 with bank evidence posts", async () => {
  const agents = new AgentRegistry(); const ctx = uow(); const cmds = bindTools(runtime(ctx), agents); const bus = new CommandBus(agents);
  const recon: Actor = { kind: "agent", id: "custodial-recon" };
  const set = (amt: bigint) => ({ effectiveDate: "2026-10-01", description: "opening variance", lines: [{ account: { scope: "custodial", custodialAccountId: "C-TI", account: "ti_custodial" }, amountCents: amt, ruleRef: "1.6 rule 6" }, { account: { scope: "corporate", account: "variance_absorbed" }, amountCents: -amt, ruleRef: "1.6 rule 6" }] });
  await assert.rejects(bus.execute(cmds.get(toolKey("1.6", "postOpeningEntries"))!, recon, { absorb: true, variance_cents: 3_000n, scope: "loan", evidence: "bank", entry_set: set(3_000n) }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "ABSORB_NEEDS_OFFICER");
  await bus.execute(cmds.get(toolKey("1.6", "postOpeningEntries"))!, recon, { absorb: true, variance_cents: 2_000n, scope: "loan", evidence: "bank", entry_set: set(2_000n) }, ctx);
  assert.equal(ctx.ledger.sets().length, 1);
  await assert.rejects(bus.execute(cmds.get(toolKey("1.6", "postOpeningEntries"))!, recon, { adjustment: true, evidence: "agent_judgment", entry_set: set(100n) }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "EVIDENCE_REQUIRED");
});

test("every tool executes through the bus for its agent with an empty input, or refuses with a typed reason (no TypeErrors)", async () => {
  const agents = new AgentRegistry(); const ctx = uow(); const cmds = bindTools(runtime(ctx), agents); const bus = new CommandBus(agents);
  for (const t of ALL_TOOLS) {
    const actor: Actor = { kind: "agent", id: t.agent };
    try { await bus.execute(cmds.get(toolKey(t.process, t.name))!, actor, {}, ctx); }
    catch (e) { assert.ok(!/Cannot read|is not a function|is not iterable/.test((e as Error).message), `${t.process} ${t.name}: ${(e as Error).stack}`); }
  }
});
