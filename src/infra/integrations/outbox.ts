/**
 * Idempotent outbox. Every outbound message to a counterparty is enqueued
 * under (adapter, direction, idempotency_key); a second enqueue with the same
 * key is a `duplicate`, never a second send (5.1 IT-7 "re-run every batch
 * builder twice; zero duplicates in files and outbox"). The dispatcher drains
 * queued messages through the adapter, applies the retry policy, and on an
 * outage or exhausted retries opens the adapter's human fallback task.
 */
import { randomUUID } from "node:crypto";
import { classify, type FailureKind } from "./failures.ts";

export type Direction = "in" | "out";
export type OutboxStatus = "queued" | "sent" | "acked" | "rejected" | "failed" | "dead" | "duplicate" | "received";

export interface OutboxMessage {
  readonly id: string;
  readonly adapter: string;
  readonly direction: Direction;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly payloadSummary: Record<string, unknown>;
  readonly loanId?: string;
  readonly sourceEventId?: string;
  readonly createdAt: string;
  status: OutboxStatus;
  attempts: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  sentAt?: string;
  ackedAt?: string;
  error?: string;
  response?: unknown;
}

export interface EnqueueInput {
  readonly adapter: string;
  readonly direction?: Direction;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly payloadSummary?: Record<string, unknown>;
  readonly loanId?: string;
  readonly sourceEventId?: string;
}

export interface Outbox {
  enqueue(input: EnqueueInput, now: string): Promise<{ message: OutboxMessage; duplicate: boolean }>;
  due(adapter: string, now: string, limit?: number): Promise<OutboxMessage[]>;
  update(m: OutboxMessage): Promise<void>;
  get(id: string): Promise<OutboxMessage | undefined>;
  byKey(adapter: string, direction: Direction, key: string): Promise<OutboxMessage | undefined>;
}

export class MemoryOutbox implements Outbox {
  private readonly messages = new Map<string, OutboxMessage>();
  private readonly keys = new Map<string, string>();
  private static k(adapter: string, direction: Direction, key: string): string { return `${adapter}|${direction}|${key}`; }
  async enqueue(input: EnqueueInput, now: string): Promise<{ message: OutboxMessage; duplicate: boolean }> {
    const direction = input.direction ?? "out";
    const k = MemoryOutbox.k(input.adapter, direction, input.idempotencyKey);
    const existingId = this.keys.get(k);
    if (existingId) return { message: this.messages.get(existingId)!, duplicate: true };
    const m: OutboxMessage = { id: randomUUID(), adapter: input.adapter, direction, idempotencyKey: input.idempotencyKey, payload: input.payload, payloadSummary: input.payloadSummary ?? {},
      ...(input.loanId ? { loanId: input.loanId } : {}), ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}), createdAt: now, status: direction === "out" ? "queued" : "received", attempts: 0, nextAttemptAt: now };
    this.messages.set(m.id, m); this.keys.set(k, m.id);
    return { message: m, duplicate: false };
  }
  async due(adapter: string, now: string, limit = 100): Promise<OutboxMessage[]> {
    return [...this.messages.values()].filter((m) => m.adapter === adapter && m.status === "queued" && (m.nextAttemptAt ?? m.createdAt) <= now).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
  }
  async update(m: OutboxMessage): Promise<void> { this.messages.set(m.id, m); }
  async get(id: string): Promise<OutboxMessage | undefined> { return this.messages.get(id); }
  async byKey(adapter: string, direction: Direction, key: string): Promise<OutboxMessage | undefined> { const id = this.keys.get(MemoryOutbox.k(adapter, direction, key)); return id ? this.messages.get(id) : undefined; }
  all(): readonly OutboxMessage[] { return [...this.messages.values()]; }
}

export interface RetryPolicy { readonly maxAttempts: number; readonly baseDelayMs: number; readonly maxDelayMs: number; }
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 60_000, maxDelayMs: 30 * 60_000 };
export function backoffMs(attempt: number, p: RetryPolicy = DEFAULT_RETRY): number { return Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** Math.max(0, attempt - 1)); }

/** A human fallback the adapter opens when it cannot deliver (LSDU upload, CRS upload, DMDC batch, e-OSCAR web app, bank portal download). */
export interface HumanPortalTask {
  readonly id: string;
  readonly kind: string;
  readonly adapter: string;
  readonly ownerRole: string;
  readonly loanId?: string;
  readonly integrationMessageId?: string;
  readonly package: Record<string, unknown>;
  readonly dueAt?: string;
  readonly openedAt: string;
  status: "open" | "in_progress" | "completed" | "cancelled";
  completedAt?: string;
  completedBy?: string;
  evidenceDocumentId?: string;
}
export interface PortalTaskInput { readonly kind: string; readonly adapter: string; readonly ownerRole?: string; readonly loanId?: string; readonly integrationMessageId?: string; readonly package?: Record<string, unknown>; readonly dueAt?: string; }
export interface PortalTaskSink { open(t: PortalTaskInput, now: string): Promise<HumanPortalTask>; }

export class MemoryPortalTasks implements PortalTaskSink {
  readonly tasks: HumanPortalTask[] = [];
  async open(t: PortalTaskInput, now: string): Promise<HumanPortalTask> {
    const task: HumanPortalTask = { id: randomUUID(), kind: t.kind, adapter: t.adapter, ownerRole: t.ownerRole ?? "fnma_portal_operator", package: t.package ?? {}, openedAt: now, status: "open",
      ...(t.loanId ? { loanId: t.loanId } : {}), ...(t.integrationMessageId ? { integrationMessageId: t.integrationMessageId } : {}), ...(t.dueAt ? { dueAt: t.dueAt } : {}) };
    this.tasks.push(task);
    return task;
  }
  complete(id: string, by: string, evidenceDocumentId: string, now: string): void {
    const t = this.tasks.find((x) => x.id === id); if (!t) throw new RangeError(`no task ${id}`);
    t.status = "completed"; t.completedAt = now; t.completedBy = by; t.evidenceDocumentId = evidenceDocumentId;
  }
}

/** What an adapter must expose to be driven by the dispatcher. */
export interface OutboundAdapter<P = unknown, R = unknown> {
  readonly name: string;
  /** Deliver one message; resolve with the counterparty's response, or throw a failure from ./failures.ts. */
  send(payload: P, message: OutboxMessage): Promise<R>;
  /** The human fallback kind opened on outage / exhausted retries (e.g. `lsdu_file_upload`). */
  readonly fallbackKind: string;
  readonly fallbackRole?: string;
}

export interface DispatchOutcome { readonly message: OutboxMessage; readonly outcome: "acked" | "retry" | "dead" | "rejected" | "fallback"; readonly failure?: FailureKind; readonly task?: HumanPortalTask; }

export class Dispatcher {
  private readonly outbox: Outbox;
  private readonly tasks: PortalTaskSink;
  private readonly policy: RetryPolicy;
  constructor(outbox: Outbox, tasks: PortalTaskSink, policy: RetryPolicy = DEFAULT_RETRY) { this.outbox = outbox; this.tasks = tasks; this.policy = policy; }

  /** Drain everything due for `adapter` at `now`. */
  async drain<P, R>(adapter: OutboundAdapter<P, R>, now: string, limit = 100): Promise<DispatchOutcome[]> {
    const out: DispatchOutcome[] = [];
    for (const m of await this.outbox.due(adapter.name, now, limit)) out.push(await this.deliver(adapter, m, now));
    return out;
  }

  async deliver<P, R>(adapter: OutboundAdapter<P, R>, m: OutboxMessage, now: string): Promise<DispatchOutcome> {
    m.attempts += 1; m.lastAttemptAt = now;
    try {
      const response = await adapter.send(m.payload as P, m);
      m.status = "acked"; m.sentAt = m.sentAt ?? now; m.ackedAt = now; m.response = response; delete m.error; delete m.nextAttemptAt;
      await this.outbox.update(m);
      return { message: m, outcome: "acked" };
    } catch (e) {
      const kind = classify(e);
      m.error = e instanceof Error ? e.message : String(e);
      if (kind === "rejected") { m.status = "rejected"; m.sentAt = m.sentAt ?? now; m.response = { code: (e as { code: string }).code, details: (e as { details: readonly string[] }).details }; delete m.nextAttemptAt; await this.outbox.update(m); return { message: m, outcome: "rejected", failure: kind }; }
      if (kind === "unavailable" || m.attempts >= this.policy.maxAttempts) {
        m.status = "dead"; delete m.nextAttemptAt; await this.outbox.update(m);
        const task = await this.tasks.open({ kind: kind === "unavailable" ? (e as { fallbackKind: string }).fallbackKind : adapter.fallbackKind, adapter: adapter.name, ...(adapter.fallbackRole ? { ownerRole: adapter.fallbackRole } : {}),
          ...(m.loanId ? { loanId: m.loanId } : {}), integrationMessageId: m.id, package: { idempotency_key: m.idempotencyKey, summary: m.payloadSummary, error: m.error, attempts: m.attempts } }, now);
        return { message: m, outcome: kind === "unavailable" ? "fallback" : "dead", failure: kind, task };
      }
      m.status = "queued"; m.nextAttemptAt = new Date(Date.parse(now) + backoffMs(m.attempts, this.policy)).toISOString();
      await this.outbox.update(m);
      return { message: m, outcome: "retry", failure: kind };
    }
  }
}
