/**
 * Ops console tests over the in-memory store: role-gated API, read-only
 * roles, queues per role, loan record, dashboard, and the human actions
 * (complete an escalation, a portal task, requeue a dead letter, AI-off).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConsoleServer, listen } from "./server.ts";
import { MemoryConsoleStore } from "./memory-store.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../kernel/events/index.ts";
import { MemoryLedger } from "../kernel/ledger/ledger.ts";
import { TimerEngine } from "../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { EscalationService } from "../app/escalations.ts";
import { AgentRegistry } from "../app/agents.ts";
import { MemoryOutbox, MemoryPortalTasks, Dispatcher } from "../infra/integrations/outbox.ts";
import { FakeFnmaLsdu, LsduOutboundAdapter } from "../infra/integrations/fnma.ts";
import { FakePrintMail, FakeEdelivery } from "../infra/integrations/delivery.ts";
import { NoticeService } from "../notices/service.ts";
import { buildRegistry, publishAuthored } from "../notices/catalog.ts";
import { plainDate as D } from "../kernel/calendar/date.ts";

const LOAN = "11111111-1111-4111-8111-111111111111";
const CASHIERING: Actor = { kind: "agent", id: "cashiering" };

async function scenario() {
  const clock = new FixedClock("2026-10-17T05:00:00.000Z");
  const events = new MemoryEventStore(clock);
  const ledger = new MemoryLedger();
  const registry = loadOverriddenRegistry();
  const timers = new TimerEngine(registry, events, { processes: ["2.1", "7.1"] });
  const escalations = new EscalationService(events, clock);
  const agents = new AgentRegistry();
  const outbox = new MemoryOutbox(); const portalTasks = new MemoryPortalTasks();
  const noticeReg = buildRegistry(); publishAuthored(noticeReg);
  const notices = new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  // ledger + a payment event that arms 2.1 timers
  ledger.post({ effectiveDate: D("2026-09-03"), description: "allocation", lines: [{ account: { scope: "custodial", custodialAccountId: "C-PI", account: "custodial_pi_cash" }, amountCents: 158_017n, ruleRef: "t" }, { account: { scope: "loan", loanId: LOAN, account: "interest_due" }, amountCents: -135_294n, ruleRef: "t" }, { account: { scope: "loan", loanId: LOAN, account: "principal" }, amountCents: -22_723n, ruleRef: "t" }] });
  events.append({ type: "payment.received", loanId: LOAN, actor: CASHIERING, payload: { amount_cents: "219257", channel: "lockbox" } });
  // a breached timer: arm a 7.1 statement timer in the past and evaluate
  clock.set("2026-08-01T05:00:00.000Z");
  events.append({ type: "statement.cycle.opened", loanId: LOAN, actor: SYSTEM, payload: { due_date: "2026-09-01" } });
  clock.set("2026-10-17T05:00:00.000Z");
  timers.evaluate("2026-10-17T05:00:00.000Z");
  // escalation for an officer, portal task for the operator, dead letter, held notice
  escalations.open({ kind: "officer", loanId: LOAN, severity: "sev-2", payload: { command: "cashiering.writeOff", amount_cents: "1200" } }, CASHIERING);
  escalations.open({ kind: "attorney", loanId: LOAN, payload: { command: "foreclosure.referral" } }, { kind: "agent", id: "foreclosure-ops" });
  const lsdu = new FakeFnmaLsdu(); lsdu.controls.setOutage(true);
  const { message } = await outbox.enqueue({ adapter: "fnma-lsdu", idempotencyKey: "k1", payload: [], loanId: LOAN }, clock.now());
  await new Dispatcher(outbox, portalTasks).deliver(new LsduOutboundAdapter(lsdu), message, clock.now());
  const v = noticeReg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))!;
  const held = notices.render({ templateCode: "NTC_REGZ_41_STMT_DELQ", loanId: LOAN, recipients: [{ partyId: "A", name: "A", mailingAddress: "1 Test St" }], payload: { ...v.samplePayload, delinquency: null }, asOf: D("2026-10-17") });
  const store = new MemoryConsoleStore({ events, ledger, timers, registry, escalations, portalTasks, outbox, notices, agents, decisions: [{ id: "d1", agent: "cashiering", action: "payment.post", ruleSetVersion: "2.1@1", rationale: "applied", loanId: LOAN, createdAt: clock.now(), confidence: 0.99 }], loans: [{ id: LOAN, fnmaLoanNumber: "1234567890", servicerLoanNumber: "SM-1", status: "active" }] });
  const server = createConsoleServer({ store, clock, uiHtml: "<!doctype html><title>test ui</title>" });
  const port = await listen(server);
  const call = async (path: string, role: string | null, init: RequestInit = {}) => { const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { "content-type": "application/json", ...(role ? { "x-actor-id": `u-${role}`, "x-actor-role": role } : {}), ...(init.headers ?? {}) } }); // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any }; };
  return { store, server, port, call, held, escalations, portalTasks, agents, timers, events };
}

test("console: no actor → 401; roles listed; read-only roles see everything and change nothing; every request is access-logged", async () => {
  const s = await scenario();
  try {
    assert.equal((await s.call("/api/dashboard", null)).status, 401);
    assert.equal((await s.call("/api/dashboard", "janitor")).status, 401);
    const roles = await s.call("/api/roles", null); assert.ok((roles.body["roles"] as string[]).includes("examiner"));
    const q = await s.call("/api/queue", "examiner"); assert.equal(q.status, 200); assert.ok((q.body as unknown[]).length >= 4);
    const post = await s.call("/api/escalations/complete", "auditor", { method: "POST", body: JSON.stringify({ id: "x" }) });
    assert.equal(post.status, 403);
    assert.equal(s.store.accessLog.length, 2, "only authenticated requests are logged"); assert.equal(s.store.accessLog[0]!.actor.role, "examiner"); assert.equal(s.store.accessLog[1]!.method, "POST");
    const html = await fetch(`http://127.0.0.1:${s.port}/`).then((r) => r.text()); assert.match(html, /test ui/);
  } finally { s.server.close(); }
});

test("console: queues per role — the officer sees the officer escalation and breached timers, the operator sees the portal task and dead letter, ops sees the held notice; loan filter works", async () => {
  const s = await scenario();
  try {
    const officer = (await s.call("/api/queue", "officer")).body as { kind: string; ownerRole: string }[];
    assert.ok(officer.some((i) => i.kind === "escalation" && i.ownerRole === "officer")); assert.ok(!officer.some((i) => i.ownerRole === "attorney")); assert.ok(officer.some((i) => i.kind === "breached_timer"));
    const attorney = (await s.call("/api/queue", "attorney")).body as { kind: string; ownerRole: string }[];
    assert.ok(attorney.some((i) => i.kind === "escalation" && i.ownerRole === "attorney")); assert.ok(!attorney.some((i) => i.ownerRole === "officer"));
    const op = (await s.call("/api/queue", "fnma_portal_operator")).body as { kind: string }[];
    assert.deepEqual([...new Set(op.map((i) => i.kind))].sort(), ["dead_letter", "portal_task"]);
    const ops = (await s.call("/api/queue", "ops_analyst")).body as { kind: string; title: string }[];
    assert.ok(ops.some((i) => i.kind === "held_notice" && i.title.includes("NTC_REGZ_41_STMT_DELQ")));
    const byKind = (await s.call("/api/queue?kind=breached_timer", "compliance")).body as { severity: string; detail: { process: string } }[];
    assert.ok(byKind.length >= 1); assert.equal(byKind[0]!.detail.process, "7.1");
    const forLoan = (await s.call(`/api/queue?kind=&loanId=${LOAN}`, "examiner")).body as unknown[];
    assert.ok(forLoan.length >= 5);
  } finally { s.server.close(); }
});

test("console: loan search and record — events, ledger balances in cents, timers, decisions, notices; dashboard tiles", async () => {
  const s = await scenario();
  try {
    const found = (await s.call("/api/loans?q=12345", "human_agent")).body as { id: string }[];
    assert.equal(found[0]!.id, LOAN);
    assert.equal((await s.call("/api/loans/nope", "human_agent")).status, 404);
    const l = (await s.call(`/api/loans/${LOAN}`, "human_agent")).body as { events: { type: string }[]; balances: { account: string; cents: string }[]; timers: { status: string }[]; decisions: { agent: string }[]; notices: { status: string }[] };
    assert.ok(l.events.some((e) => e.type === "payment.received"));
    assert.deepEqual(l.balances, [{ account: "principal", cents: "-22723" }, { account: "interest_due", cents: "-135294" }]);
    assert.ok(l.timers.some((t) => t.status === "breached")); assert.equal(l.decisions[0]!.agent, "cashiering"); assert.equal(l.notices[0]!.status, "held");
    const d = (await s.call("/api/dashboard", "compliance")).body as { timers: { breached: number; breachedBySection: Record<string, number> }; queues: Record<string, number>; notices: { held: number }; agents: { agent: string; off: boolean }[] };
    assert.ok(d.timers.breached >= 1); assert.ok(d.timers.breachedBySection["7"]! >= 1); assert.equal(d.queues.escalation, 2); assert.equal(d.queues.dead_letter, 1); assert.equal(d.notices.held, 1); assert.ok(d.agents.length >= 20);
  } finally { s.server.close(); }
});

test("console: human actions are role-checked and leave events — officer completes their escalation, attorney cannot; operator completes the portal task and requeues the dead letter; only officer/compliance/ciso switch the AI path", async () => {
  const s = await scenario();
  try {
    const [officerEsc, attorneyEsc] = s.escalations.opened;
    let r = await s.call("/api/escalations/complete", "attorney", { method: "POST", body: JSON.stringify({ id: officerEsc!.id, evidenceDocumentId: "doc-1" }) });
    assert.equal(r.status, 409); assert.match(String(r.body["reason"]), /completed by role officer/);
    r = await s.call("/api/escalations/complete", "officer", { method: "POST", body: JSON.stringify({ id: officerEsc!.id, evidenceDocumentId: "doc-1" }) });
    assert.equal(r.status, 200); assert.equal(officerEsc!.status, "completed"); assert.equal(attorneyEsc!.status, "open");
    const task = s.portalTasks.tasks[0]!;
    assert.equal((await s.call("/api/portal-tasks/complete", "officer", { method: "POST", body: JSON.stringify({ id: task.id }) })).status, 409);
    assert.equal((await s.call("/api/portal-tasks/complete", "fnma_portal_operator", { method: "POST", body: JSON.stringify({ id: task.id, evidenceDocumentId: "lsdu-confirm-1" }) })).status, 200);
    assert.equal(task.status, "completed"); assert.equal(task.completedBy, "u-fnma_portal_operator");
    const dead = (await s.call("/api/queue?kind=dead_letter", "fnma_portal_operator")).body as { id: string }[];
    assert.equal((await s.call("/api/outbox/requeue", "fnma_portal_operator", { method: "POST", body: JSON.stringify({ id: dead[0]!.id }) })).status, 200);
    assert.equal(((await s.call("/api/queue?kind=dead_letter", "fnma_portal_operator")).body as unknown[]).length, 0);
    assert.ok(s.events.ofType("integration.message.requeued").length === 1);
    assert.equal((await s.call("/api/agents/ai-off", "human_agent", { method: "POST", body: JSON.stringify({ agent: "cashiering", why: "x" }) })).status, 409);
    assert.equal((await s.call("/api/agents/ai-off", "officer", { method: "POST", body: JSON.stringify({ agent: "cashiering", why: "month-end freeze" }) })).status, 200);
    assert.equal(s.agents.aiState("cashiering").why, "month-end freeze");
    assert.equal((await s.call("/api/agents/ai-off", "compliance", { method: "POST", body: JSON.stringify({ agent: "cashiering", why: null }) })).status, 200);
    assert.equal(s.agents.aiState("cashiering").off, false);
    assert.equal((await s.call("/api/agents/ai-off", "officer", { method: "POST", body: JSON.stringify({ agent: "nope", why: "x" }) })).status, 409);
    r = await s.call("/api/notices/supersede", "ops_analyst", { method: "POST", body: JSON.stringify({ id: s.held.id, replacementId: "nope" }) });
    assert.equal(r.status, 409);
  } finally { s.server.close(); }
});
