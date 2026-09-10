/** ConsoleStore over the in-memory kernel stores and services — what tests and the demo run on. */
import type { Actor, EventStore, DomainEvent } from "../kernel/events/index.ts";
import type { MemoryLedger } from "../kernel/ledger/ledger.ts";
import type { TimerEngine, TimerRegistry } from "../kernel/timers/index.ts";
import type { EscalationService } from "../app/escalations.ts";
import type { AgentRegistry } from "../app/agents.ts";
import type { MemoryPortalTasks, MemoryOutbox } from "../infra/integrations/outbox.ts";
import type { NoticeService } from "../notices/service.ts";
import type { DecisionInput } from "../infra/db/decisions.ts";
import type { ConsoleStore, QueueItem, LoanSummary, LoanDetail, Dashboard, AccessEntry } from "./store.ts";
import { queueKindsFor } from "./store.ts";

export interface MemoryConsoleDeps {
  readonly events: EventStore;
  readonly ledger: MemoryLedger;
  readonly timers: TimerEngine;
  readonly registry: TimerRegistry;
  readonly escalations: EscalationService;
  readonly portalTasks: MemoryPortalTasks;
  readonly outbox: MemoryOutbox;
  readonly notices: NoticeService;
  readonly agents: AgentRegistry;
  readonly decisions: readonly (DecisionInput & { id: string; createdAt: string })[];
  readonly loans: readonly LoanSummary[];
}

export class MemoryConsoleStore implements ConsoleStore {
  private readonly d: MemoryConsoleDeps;
  readonly accessLog: AccessEntry[] = [];
  constructor(d: MemoryConsoleDeps) { this.d = d; }

  private items(now: string): QueueItem[] {
    const out: QueueItem[] = [];
    for (const e of this.d.escalations.opened) if (e.status === "open") out.push({ id: e.id, kind: "escalation", title: `${e.kind} escalation${e.payload["command"] ? ` — ${String(e.payload["command"])}` : ""}`, ownerRole: e.ownerRole, openedAt: e.openedAt, detail: e.payload, ...(e.loanId ? { loanId: e.loanId } : {}), ...(e.severity ? { severity: e.severity } : {}) });
    for (const t of this.d.portalTasks.tasks) if (t.status === "open" || t.status === "in_progress") out.push({ id: t.id, kind: "portal_task", title: `${t.kind} (${t.adapter})`, ownerRole: t.ownerRole, openedAt: t.openedAt, detail: t.package, ...(t.loanId ? { loanId: t.loanId } : {}), ...(t.dueAt ? { dueAt: t.dueAt } : {}) });
    for (const n of this.d.notices.all()) if (n.status === "held") out.push({ id: n.id, kind: "held_notice", title: `${n.templateCode} held`, ownerRole: "ops_analyst", openedAt: n.producedAt, detail: { reason: n.heldReason, blocking: n.checklist.blocking.map((b) => `${b.rule_id} (${b.citation})`) }, ...(n.loanId ? { loanId: n.loanId } : {}) });
    for (const m of this.d.outbox.all()) if (m.status === "dead") out.push({ id: m.id, kind: "dead_letter", title: `${m.adapter} dead letter`, ownerRole: "fnma_portal_operator", openedAt: m.lastAttemptAt ?? m.createdAt, detail: { idempotency_key: m.idempotencyKey, error: m.error, attempts: m.attempts }, ...(m.loanId ? { loanId: m.loanId } : {}) });
    for (const t of this.d.timers.all()) if (t.status === "breached") {
      const def = this.d.registry.get(t.code);
      out.push({ id: t.id, kind: "breached_timer", title: `${t.code} breached`, ownerRole: def?.severity.escalateTo.find((r) => /officer|attorney|human_agent|operator|reviewer/.test(r)) ?? "compliance", openedAt: t.breachedAt ?? now, severity: def?.severity.level ? `sev-${def.severity.level}` : "unrated", detail: { process: def?.process, breach: def?.breach, due_date: t.dueDate }, ...(t.loanId ? { loanId: t.loanId } : {}), ...(t.dueAt !== undefined ? { dueAt: new Date(t.dueAt).toISOString() } : {}) });
    }
    return out.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }
  async queue(o: { role?: string; kind?: QueueItem["kind"]; loanId?: string; now: string }): Promise<QueueItem[]> {
    let items = this.items(o.now);
    if (o.kind) items = items.filter((i) => i.kind === o.kind);
    else if (o.role) { const kinds = queueKindsFor(o.role); items = items.filter((i) => kinds.includes(i.kind) && (i.kind !== "escalation" && i.kind !== "portal_task" || i.ownerRole === o.role || o.role === "auditor" || o.role === "examiner")); }
    if (o.loanId) items = items.filter((i) => i.loanId === o.loanId);
    return items;
  }
  async searchLoans(q: string, limit = 20): Promise<LoanSummary[]> { const s = q.trim().toLowerCase(); return this.d.loans.filter((l) => !s || l.id.toLowerCase().includes(s) || l.fnmaLoanNumber.includes(s) || l.servicerLoanNumber.toLowerCase().includes(s)).slice(0, limit); }
  async loan(id: string, _now: string): Promise<LoanDetail | undefined> {
    const l = this.d.loans.find((x) => x.id === id); if (!l) return undefined;
    const ev = (e: DomainEvent) => ({ id: e.id, sequence: e.sequence, type: e.type, occurredAt: e.occurredAt, actor: `${e.actor.kind}:${e.actor.id}`, payload: e.payload });
    const balances: { account: string; cents: string }[] = [];
    for (const acct of ["principal", "interest_due", "escrow", "suspense_unapplied", "late_charges", "nsf_fees", "other_fees", "deferred_principal", "forborne_principal", "corporate_advance", "escrow_advance"] as const) { const c = this.d.ledger.balance({ scope: "loan", loanId: id, account: acct }); if (c !== 0n) balances.push({ account: acct, cents: c.toString() }); }
    return { ...l, events: this.d.events.byLoan(id).map(ev), balances,
      timers: this.d.timers.all().filter((t) => t.loanId === id).map((t) => ({ id: t.id, code: t.code, status: t.status, dueAt: t.dueAt !== undefined ? new Date(t.dueAt).toISOString() : undefined, dueDate: t.dueDate, note: t.note })),
      decisions: this.d.decisions.filter((x) => x.loanId === id).map((x) => ({ id: x.id, agent: x.agent, action: x.action, ruleCode: x.ruleCode, rationale: x.rationale, confidence: x.confidence ?? null, approvedBy: x.approvedBy, approvedRole: x.approvedRole, createdAt: x.createdAt })),
      notices: this.d.notices.all().filter((n) => n.loanId === id).map((n) => ({ id: n.id, template: n.templateCode, version: n.templateVersion, status: n.status, heldReason: n.heldReason, producedAt: n.producedAt, sentAt: n.sentAt })) };
  }
  async dashboard(now: string): Promise<Dashboard> {
    const nowMs = Date.parse(now), week = nowMs - 7 * 86_400_000;
    const all = this.d.timers.all();
    const bySev: Record<string, number> = {}, bySec: Record<string, number> = {};
    for (const t of all) if (t.status === "breached") { const def = this.d.registry.get(t.code); const sev = def?.severity.level ? `sev-${def.severity.level}` : "unrated"; bySev[sev] = (bySev[sev] ?? 0) + 1; const sec = def?.process.split(".")[0] ?? "?"; bySec[sec] = (bySec[sec] ?? 0) + 1; }
    const items = this.items(now);
    const queues = { escalation: 0, portal_task: 0, held_notice: 0, dead_letter: 0, breached_timer: 0 } as Record<QueueItem["kind"], number>;
    for (const i of items) queues[i.kind]++;
    const notices = this.d.notices.all();
    return { asOf: now,
      timers: { armed: all.filter((t) => t.status === "armed").length, breached: all.filter((t) => t.status === "breached").length, dueNext24h: all.filter((t) => t.status === "armed" && t.dueAt !== undefined && t.dueAt > nowMs && t.dueAt <= nowMs + 86_400_000).length, breachedBySeverity: bySev, breachedBySection: bySec },
      queues, notices: { held: notices.filter((n) => n.status === "held").length, sentLast7d: notices.filter((n) => n.sentAt && Date.parse(n.sentAt) >= week).length, returnedLast7d: notices.filter((n) => n.status === "returned").length },
      agents: this.d.agents.agents().map((a) => { const s = this.d.agents.aiState(a.agent); return { agent: a.agent, off: s.off, why: s.why, tier: s.tier, decisionsLast7d: this.d.decisions.filter((d) => d.agent === a.agent && Date.parse(d.createdAt) >= week).length }; }) };
  }
  async completeEscalation(id: string, actor: Actor, evidence: string | null, _now: string): Promise<{ ok: true } | { ok: false; reason: string }> { try { this.d.escalations.complete(id, actor, evidence ?? undefined); return { ok: true }; } catch (e) { return { ok: false, reason: (e as Error).message }; } }
  async completePortalTask(id: string, actor: Actor, evidence: string | null, now: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const t = this.d.portalTasks.tasks.find((x) => x.id === id); if (!t) return { ok: false, reason: `no task ${id}` };
    if (actor.kind !== "human" || actor.role !== t.ownerRole) return { ok: false, reason: `task is worked by ${t.ownerRole}` };
    this.d.portalTasks.complete(id, actor.id, evidence ?? "", now); return { ok: true };
  }
  async releaseHeldNotice(id: string, actor: Actor, replacementId: string, _now: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (actor.kind !== "human") return { ok: false, reason: "superseding a held notice is a human act" };
    try { this.d.notices.supersede(id, replacementId); return { ok: true }; } catch (e) { return { ok: false, reason: (e as Error).message }; }
  }
  async requeueDeadLetter(id: string, actor: Actor, now: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (actor.kind !== "human") return { ok: false, reason: "requeue is a human act" };
    const m = await this.d.outbox.get(id); if (!m || m.status !== "dead") return { ok: false, reason: `message ${id} is not dead-lettered` };
    m.status = "queued"; m.attempts = 0; m.nextAttemptAt = now; delete m.error; await this.d.outbox.update(m);
    this.d.events.append({ type: "integration.message.requeued", ...(m.loanId ? { loanId: m.loanId } : {}), actor, payload: { message_id: m.id, adapter: m.adapter } });
    return { ok: true };
  }
  async setAiOff(agent: string, why: string | null, actor: Actor, _now: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (actor.kind !== "human" || !["officer", "compliance", "ciso"].includes(actor.role ?? "")) return { ok: false, reason: "AI-off toggles are set by officer, compliance or ciso" };
    try { this.d.agents.get(agent); } catch { return { ok: false, reason: `unknown agent ${agent}` }; }
    this.d.agents.setAiOff(agent, why);
    this.d.events.append({ type: why === null ? "agent.ai_path.enabled" : "agent.ai_path.disabled", actor, payload: { agent, why } });
    return { ok: true };
  }
  async logAccess(e: AccessEntry): Promise<void> { this.accessLog.push(e); }
}
